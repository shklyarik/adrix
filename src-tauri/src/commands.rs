//! IPC commands used by the UI.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

use crate::error::{Error, Result};
use crate::php::PhpServer;
use crate::ssh::{self, Tunnel};
use crate::store::{Connection, Driver, Secrets, SecretsInput, Settings, Store};

pub struct AppState {
    pub php: PhpServer,
    pub store: Mutex<Store>,
    pub sessions: Mutex<HashMap<String, Session>>,
    /// per-process secret; the UI signs Adminer login forms with it (see adrix-plugin.php)
    pub token: String,
}

pub struct Session {
    // the tunnel lives while the tab is open; drop closes SSH
    _tunnel: Option<Tunnel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    keyring_ok: bool,
    php_url: String,
    settings: Settings,
}

/// Everything the UI needs to log the iframe into Adminer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    session_id: String,
    driver: &'static str,
    server: String,
    username: String,
    password: String,
    database: String,
    token: String,
}

fn ssh_key_id(conn: &Connection) -> Option<String> {
    conn.ssh.as_ref().map(|s| format!("{}:{}", s.host.trim(), s.port))
}

/// Opens a tunnel (if needed) and returns the server address for Adminer.
async fn connect(state: &AppState, conn: &Connection, secrets: &Secrets) -> Result<(String, Option<Tunnel>)> {
    match (&conn.ssh, conn.driver) {
        (_, Driver::Sqlite) => {
            // Adminer won't open a missing file; an empty file is a valid empty SQLite database
            let path = std::path::Path::new(conn.host.trim());
            if !path.exists() {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(|e| {
                        Error::msg(tr!(
                            "не удалось создать {}: {e}",
                            "cannot create {}: {e}",
                            path.display()
                        ))
                    })?;
            }
            Ok((conn.host.trim().to_string(), None))
        }
        (None, _) => Ok((format!("{}:{}", conn.host.trim(), port_or_default(conn)), None)),
        (Some(ssh_cfg), _) => {
            let key_id = ssh_key_id(conn).unwrap();
            let expected = state.store.lock().unwrap().known_host(&key_id);
            let opened = ssh::open(ssh_cfg, secrets, expected.clone(), &conn.host, port_or_default(conn)).await?;
            if expected.is_none() && !opened.fingerprint.is_empty() {
                state
                    .store
                    .lock()
                    .unwrap()
                    .remember_host(&key_id, &opened.fingerprint)?;
            }
            Ok((format!("127.0.0.1:{}", opened.tunnel.local_port), Some(opened.tunnel)))
        }
    }
}

fn port_or_default(conn: &Connection) -> u16 {
    match (conn.port, conn.driver) {
        (0, Driver::Pgsql) => 5432,
        (0, _) => 3306,
        (p, _) => p,
    }
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    let store = state.store.lock().unwrap();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        keyring_ok: store.keyring_ok(),
        php_url: state.php.base_url(),
        settings: store.settings(),
    }
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<Connection> {
    state.store.lock().unwrap().list()
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    connection: Connection,
    secrets: SecretsInput,
) -> Result<Connection> {
    state.store.lock().unwrap().save(connection, &secrets)
}

#[tauri::command]
pub fn reorder_connections(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    state.store.lock().unwrap().reorder(&ids)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.lock().unwrap().delete(&id)
}

#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, connection: Connection) -> Result<()> {
    match ssh_key_id(&connection) {
        Some(key) => state.store.lock().unwrap().forget_host(&key),
        None => Ok(()),
    }
}

/// Test from the form (the connection may not be saved yet).
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    connection: Connection,
    secrets: SecretsInput,
) -> Result<String> {
    let resolved = state.store.lock().unwrap().secrets(&connection.id, Some(&secrets));
    if connection.driver == Driver::Sqlite {
        let path = std::path::Path::new(connection.host.trim());
        return if path.is_file() {
            Ok(tr!("файл найден", "file found"))
        } else if path.parent().is_some_and(|p| p.as_os_str().is_empty() || p.is_dir()) {
            Ok(tr!(
                "файла нет — будет создана новая база",
                "file does not exist — a new database will be created"
            ))
        } else {
            Err(Error::msg(tr!(
                "каталог не найден: {}",
                "directory not found: {}",
                path.display()
            )))
        };
    }

    let (server, tunnel) = connect(&state, &connection, &resolved).await?;
    let target = format!("{}:{}", connection.host.trim(), port_or_default(&connection));
    let mut sock = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(&server))
        .await
        .map_err(|_| {
            Error::msg(tr!(
                "таймаут подключения к {target}",
                "connection to {target} timed out"
            ))
        })?
        .map_err(|e| Error::msg(format!("{target}: {e}")))?;

    // MySQL sends a greeting right away, PostgreSQL waits for the client.
    // EOF means the SSH server could not reach the database.
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(Duration::from_millis(1500), sock.read(&mut buf)).await;
    drop(tunnel);
    match read {
        Ok(Ok(0)) | Ok(Err(_)) => Err(Error::msg(tr!(
            "{target}: соединение закрыто (порт недоступен с SSH-сервера?)",
            "{target}: connection closed (port unreachable from the SSH server?)"
        ))),
        _ => Ok(if connection.ssh.is_some() {
            tr!("SSH ок, {target} доступен", "SSH ok, {target} is reachable")
        } else {
            tr!("{target} доступен", "{target} is reachable")
        }),
    }
}

#[tauri::command]
pub async fn open_session(state: State<'_, AppState>, id: String) -> Result<SessionInfo> {
    let (conn, secrets) = {
        let store = state.store.lock().unwrap();
        let conn = store.get(&id)?;
        let secrets = store.secrets(&id, None);
        (conn, secrets)
    };
    let (server, tunnel) = connect(&state, &conn, &secrets).await?;
    // for SQLite the "database" is the file path and the server is empty
    let (server, database) = match conn.driver {
        Driver::Sqlite => (String::new(), server),
        _ => (server, conn.database),
    };
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Session { _tunnel: tunnel });
    Ok(SessionInfo {
        session_id,
        driver: conn.driver.adminer_name(),
        server,
        username: conn.username,
        password: secrets.db_password,
        database,
        token: state.token.clone(),
    })
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, session_id: String) {
    state.sessions.lock().unwrap().remove(&session_id);
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<()> {
    state.store.lock().unwrap().save_settings(settings)
}

/// Native file picker. `kind`: "sshKey" (starts in ~/.ssh) or "sqlite".
/// `current` — value already in the input; its directory is used as the start point.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle, kind: String, current: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    let mut dialog = app.dialog().file();
    let current = crate::ssh::expand_home(current.trim());
    let start = current
        .as_ref()
        .and_then(|p| {
            if p.is_dir() {
                Some(p.clone())
            } else {
                p.parent().map(|d| d.to_path_buf())
            }
        })
        .filter(|d| d.is_dir())
        .or_else(|| match kind.as_str() {
            "sshKey" => crate::ssh::home_dir().map(|h| h.join(".ssh")).filter(|d| d.is_dir()),
            _ => crate::ssh::home_dir(),
        });
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    dialog = match kind.as_str() {
        "sshKey" => dialog.set_title(tr!("Выберите приватный SSH-ключ", "Choose a private SSH key")),
        _ => dialog
            .set_title(tr!("Выберите файл SQLite", "Choose an SQLite file"))
            .add_filter("SQLite", &["sqlite", "sqlite3", "db", "db3", "s3db"])
            .add_filter(tr!("Все файлы", "All files"), &["*"]),
    };
    dialog
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}
