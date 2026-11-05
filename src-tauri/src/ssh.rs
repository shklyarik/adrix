//! SSH local port forwarding with russh: 127.0.0.1:<random> ⇄ direct-tcpip ⇄ target_host:target_port.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::error::{Error, Result};
use crate::store::{Secrets, SshAuth, SshConfig};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

struct HostKeyCheck {
    /// expected fingerprint (TOFU); None = first connection
    expected: Option<String>,
    /// actual server fingerprint
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().fingerprint(HashAlg::Sha256),
        }
        .to_string();
        let ok = self.expected.as_ref().is_none_or(|e| *e == fp);
        *self.seen.lock().unwrap() = Some(fp);
        Ok(ok)
    }
}

/// An open tunnel. Dropping it stops the listener and closes the SSH session.
pub struct Tunnel {
    pub local_port: u16,
    stop: watch::Sender<bool>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

pub struct Opened {
    pub tunnel: Tunnel,
    /// server host key fingerprint — the caller stores it on first connection
    pub fingerprint: String,
}

pub async fn open(
    cfg: &SshConfig,
    secrets: &Secrets,
    expected_fp: Option<String>,
    target_host: &str,
    target_port: u16,
) -> Result<Opened> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });

    let seen = Arc::new(Mutex::new(None));
    let handler = HostKeyCheck {
        expected: expected_fp.clone(),
        seen: seen.clone(),
    };
    let addr = (cfg.host.trim().to_string(), cfg.port);

    let connected = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, addr, handler)).await;
    let mut session = match connected {
        Err(_) => {
            return Err(Error::msg(tr!(
                "SSH: таймаут подключения к {}:{}",
                "SSH: connection to {}:{} timed out",
                cfg.host,
                cfg.port
            )))
        }
        Ok(Err(e)) => {
            let seen = seen.lock().unwrap().clone();
            if let (Some(exp), Some(got)) = (&expected_fp, &seen) {
                if exp != got {
                    return Err(Error::msg(tr!(
                        "SSH: ключ сервера {}:{} изменился!\nожидался {exp}\nполучен  {got}\n\
                         Если это ожидаемо (переустановка сервера) — сбросьте ключ в настройках соединения.",
                        "SSH: host key of {}:{} has changed!\nexpected {exp}\ngot      {got}\n\
                         If this is expected (server reinstalled), reset the host key in the connection settings.",
                        cfg.host,
                        cfg.port
                    )));
                }
            }
            return Err(e.into());
        }
        Ok(Ok(s)) => s,
    };
    let fingerprint = seen.lock().unwrap().clone().unwrap_or_default();

    let auth = match cfg.auth {
        SshAuth::Password => {
            session
                .authenticate_password(&cfg.username, &secrets.ssh_password)
                .await?
        }
        SshAuth::Key => {
            let path = resolve_key_path(&cfg.key_path)?;
            let pass = Some(secrets.key_passphrase.as_str()).filter(|p| !p.is_empty());
            let key = load_secret_key(&path, pass).map_err(|e| match e {
                russh::keys::Error::KeyIsEncrypted => Error::msg(tr!(
                    "SSH-ключ зашифрован — укажите passphrase",
                    "SSH key is encrypted — enter the passphrase"
                )),
                e => Error::msg(tr!("SSH-ключ {}: {e}", "SSH key {}: {e}", path.display())),
            })?;
            let hash = session.best_supported_rsa_hash().await?.flatten();
            session
                .authenticate_publickey(&cfg.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
        }
    };
    if !auth.success() {
        return Err(Error::msg(match cfg.auth {
            SshAuth::Password => tr!("SSH: неверный логин или пароль", "SSH: wrong user or password"),
            SshAuth::Key => tr!("SSH: сервер отклонил ключ", "SSH: the server rejected the key"),
        }));
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let (stop, mut stopped) = watch::channel(false);
    let session = Arc::new(session);
    let target_host = target_host.trim().to_string();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                accepted = listener.accept() => {
                    let Ok((mut sock, peer)) = accepted else { continue };
                    let _ = sock.set_nodelay(true);
                    let session = session.clone();
                    let host = target_host.clone();
                    tokio::spawn(async move {
                        match session
                            .channel_open_direct_tcpip(host, target_port as u32, "127.0.0.1", peer.port() as u32)
                            .await
                        {
                            Ok(channel) => {
                                let mut stream = channel.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                            }
                            Err(e) => log::warn!("direct-tcpip failed: {e}"),
                        }
                    });
                }
            }
        }
        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    });

    Ok(Opened {
        tunnel: Tunnel { local_port, stop },
        fingerprint,
    })
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn resolve_key_path(raw: &str) -> Result<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        let ssh = home_dir()
            .map(|h| h.join(".ssh"))
            .ok_or_else(|| Error::msg(tr!("не найден домашний каталог", "home directory not found")))?;
        return ["id_ed25519", "id_ecdsa", "id_rsa"]
            .iter()
            .map(|n| ssh.join(n))
            .find(|p| p.is_file())
            .ok_or_else(|| {
                Error::msg(tr!(
                    "SSH-ключ не указан и не найден в ~/.ssh (id_ed25519, id_ecdsa, id_rsa)",
                    "SSH key not set and none found in ~/.ssh (id_ed25519, id_ecdsa, id_rsa)"
                ))
            });
    }
    let path =
        expand_home(raw).ok_or_else(|| Error::msg(tr!("не найден домашний каталог", "home directory not found")))?;
    if !path.is_file() {
        return Err(Error::msg(tr!(
            "SSH-ключ не найден: {}",
            "SSH key not found: {}",
            path.display()
        )));
    }
    Ok(path)
}

/// Expands a leading `~/` (or `~\\`). None only when `~` is used and there is no home dir.
pub fn expand_home(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() {
        return None;
    }
    match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => home_dir().map(|h| h.join(rest)),
        None => Some(PathBuf::from(raw)),
    }
}
