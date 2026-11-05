//! Persistent state: connections (connections.json), UI settings (settings.json),
//! SSH host keys (known_hosts.json) and an encrypted secrets vault (secrets.vault).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::vault::Vault;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Mysql,
    Pgsql,
    Sqlite,
}

impl Driver {
    /// Driver name used in Adminer URLs and the login form.
    pub fn adminer_name(self) -> &'static str {
        match self {
            Driver::Mysql => "server",
            Driver::Pgsql => "pgsql",
            Driver::Sqlite => "sqlite",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    /// user + password
    Password,
    /// private key, optionally protected by a passphrase
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// private key path; empty means ~/.ssh/id_ed25519, id_ecdsa, id_rsa
    #[serde(default)]
    pub key_path: String,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub driver: Driver,
    /// DB host (relative to the SSH server when tunnelled); file path for SQLite
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// default database (optional)
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// which secrets are stored — for the UI only, values are never sent back
    #[serde(default, skip_deserializing)]
    pub saved: SavedFlags,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFlags {
    pub db_password: bool,
    pub ssh_password: bool,
    pub key_passphrase: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum SecretKind {
    DbPassword,
    SshPassword,
    KeyPassphrase,
}

impl SecretKind {
    const ALL: [SecretKind; 3] = [
        SecretKind::DbPassword,
        SecretKind::SshPassword,
        SecretKind::KeyPassphrase,
    ];

    fn key(self, id: &str) -> String {
        let suffix = match self {
            SecretKind::DbPassword => "db",
            SecretKind::SshPassword => "ssh",
            SecretKind::KeyPassphrase => "passphrase",
        };
        format!("{id}:{suffix}")
    }
}

/// Secrets coming from the form: `None` = keep stored value, `Some("")` = delete it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsInput {
    pub db_password: Option<String>,
    pub ssh_password: Option<String>,
    pub key_passphrase: Option<String>,
}

impl SecretsInput {
    fn get(&self, kind: SecretKind) -> Option<&String> {
        match kind {
            SecretKind::DbPassword => self.db_password.as_ref(),
            SecretKind::SshPassword => self.ssh_password.as_ref(),
            SecretKind::KeyPassphrase => self.key_passphrase.as_ref(),
        }
    }
}

/// Resolved secrets used to connect.
#[derive(Debug, Clone, Default)]
pub struct Secrets {
    pub db_password: String,
    pub ssh_password: String,
    pub key_passphrase: String,
}

/// UI settings. Kept on the Rust side because in release builds the window origin
/// (http://127.0.0.1:<random port>) changes on every launch, so localStorage is lost.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// "en" | "ru"; empty = follow the system language
    #[serde(default)]
    pub lang: String,
    /// "light" | "dark"; empty = follow the system theme
    #[serde(default)]
    pub theme: String,
    /// webview zoom factor; 0 = not set (1.0)
    #[serde(default)]
    pub zoom: f64,
}

#[derive(Default, Serialize, Deserialize)]
struct ConnectionsFile {
    #[serde(default)]
    connections: Vec<Connection>,
}

pub struct Store {
    dir: PathBuf,
    connections: Vec<Connection>,
    /// "host:port" -> SHA256 fingerprint
    known_hosts: BTreeMap<String, String>,
    settings: Settings,
    vault: Vault,
}

impl Store {
    pub fn load(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)?;
        let connections = read_json::<ConnectionsFile>(&dir.join("connections.json"))?.connections;
        let known_hosts = read_json(&dir.join("known_hosts.json"))?;
        let settings: Settings = read_json(&dir.join("settings.json")).unwrap_or_default();
        crate::i18n::set(&settings.lang);
        let vault = Vault::open(&dir)?;
        let mut store = Store {
            dir,
            connections,
            known_hosts,
            settings,
            vault,
        };
        store.refresh_flags();
        Ok(store)
    }

    /// true when the vault key lives in the OS keyring (false = key file fallback).
    pub fn keyring_ok(&self) -> bool {
        self.vault.key_in_keyring()
    }

    pub fn settings(&self) -> Settings {
        self.settings.clone()
    }

    pub fn save_settings(&mut self, settings: Settings) -> Result<()> {
        crate::i18n::set(&settings.lang);
        self.settings = settings;
        write_json(&self.dir.join("settings.json"), &self.settings)
    }

    pub fn list(&self) -> Vec<Connection> {
        self.connections.clone()
    }

    pub fn get(&self, id: &str) -> Result<Connection> {
        self.connections
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| Error::msg(tr!("соединение {id} не найдено", "connection {id} not found")))
    }

    pub fn save(&mut self, mut conn: Connection, secrets: &SecretsInput) -> Result<Connection> {
        validate(&conn)?;
        if conn.id.is_empty() {
            conn.id = uuid::Uuid::new_v4().to_string();
        }
        for kind in SecretKind::ALL {
            if let Some(value) = secrets.get(kind) {
                self.vault.set(kind.key(&conn.id), value);
            }
        }
        self.vault.persist()?;
        match self.connections.iter_mut().find(|c| c.id == conn.id) {
            Some(existing) => *existing = conn.clone(),
            None => self.connections.push(conn.clone()),
        }
        self.refresh_flags();
        self.persist_connections()?;
        self.get(&conn.id)
    }

    /// Reorders connections by the given ids (drag & drop in the sidebar).
    /// Unknown ids are ignored; connections missing from `ids` keep their relative order at the end.
    pub fn reorder(&mut self, ids: &[String]) -> Result<()> {
        let pos = |c: &Connection| ids.iter().position(|id| *id == c.id).unwrap_or(usize::MAX);
        self.connections.sort_by_key(pos); // stable sort
        self.persist_connections()
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        for kind in SecretKind::ALL {
            self.vault.set(kind.key(id), "");
        }
        self.vault.persist()?;
        self.connections.retain(|c| c.id != id);
        self.persist_connections()
    }

    /// Secrets for connecting: values from the form (if given) override stored ones.
    pub fn secrets(&self, id: &str, overrides: Option<&SecretsInput>) -> Secrets {
        let pick = |kind: SecretKind| {
            overrides
                .and_then(|o| o.get(kind).cloned())
                .or_else(|| self.vault.get(&kind.key(id)).map(str::to_owned))
                .unwrap_or_default()
        };
        Secrets {
            db_password: pick(SecretKind::DbPassword),
            ssh_password: pick(SecretKind::SshPassword),
            key_passphrase: pick(SecretKind::KeyPassphrase),
        }
    }

    pub fn known_host(&self, host_port: &str) -> Option<String> {
        self.known_hosts.get(host_port).cloned()
    }

    pub fn remember_host(&mut self, host_port: &str, fingerprint: &str) -> Result<()> {
        self.known_hosts.insert(host_port.to_string(), fingerprint.to_string());
        write_json(&self.dir.join("known_hosts.json"), &self.known_hosts)
    }

    pub fn forget_host(&mut self, host_port: &str) -> Result<()> {
        self.known_hosts.remove(host_port);
        write_json(&self.dir.join("known_hosts.json"), &self.known_hosts)
    }

    fn refresh_flags(&mut self) {
        let vault = &self.vault;
        for c in &mut self.connections {
            c.saved = SavedFlags {
                db_password: vault.get(&SecretKind::DbPassword.key(&c.id)).is_some(),
                ssh_password: vault.get(&SecretKind::SshPassword.key(&c.id)).is_some(),
                key_passphrase: vault.get(&SecretKind::KeyPassphrase.key(&c.id)).is_some(),
            };
        }
    }

    fn persist_connections(&self) -> Result<()> {
        let file = ConnectionsFile {
            connections: self.connections.clone(),
        };
        write_json(&self.dir.join("connections.json"), &file)
    }
}

fn validate(c: &Connection) -> Result<()> {
    if c.name.trim().is_empty() {
        return Err(Error::msg(tr!("укажите название", "name is required")));
    }
    if c.host.trim().is_empty() {
        return Err(Error::msg(if c.driver == Driver::Sqlite {
            tr!("укажите путь к файлу", "file path is required")
        } else {
            tr!("укажите хост", "host is required")
        }));
    }
    if let Some(ssh) = &c.ssh {
        if c.driver == Driver::Sqlite {
            return Err(Error::msg(tr!(
                "SQLite через SSH пока не поддерживается",
                "SQLite over SSH is not supported yet"
            )));
        }
        if ssh.host.trim().is_empty() || ssh.username.trim().is_empty() {
            return Err(Error::msg(tr!(
                "укажите SSH-хост и пользователя",
                "SSH host and user are required"
            )));
        }
    }
    Ok(())
}

pub(crate) fn read_json<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    write_private(path, &serde_json::to_vec_pretty(value)?)
}

/// Atomic write (tmp + rename), readable only by the owner on Unix.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}
