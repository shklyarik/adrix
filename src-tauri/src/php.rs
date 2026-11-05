//! Embedded PHP server: `php -S 127.0.0.1:PORT -t <ui> router.php` (Tauri sidecar).

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::error::{Error, Result};

/// PHP port in dev mode — Vite proxies /adminer to it (vite.config.ts).
const DEV_PORT: u16 = 18765;

pub struct PhpServer {
    pub port: u16,
    child: Mutex<Option<CommandChild>>,
}

impl PhpServer {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

struct Dirs {
    php: PathBuf,
    ui: PathBuf,
}

fn dirs(app: &AppHandle) -> Result<Dirs> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let php = root.join("php");
        // in dev Vite serves the UI; the docroot is a formality
        return Ok(Dirs { ui: php.clone(), php });
    }
    let res = app.path().resource_dir()?;
    Ok(Dirs {
        php: res.join("adminer"),
        ui: res.join("ui"),
    })
}

fn pick_port() -> Result<u16> {
    if cfg!(debug_assertions) {
        return Ok(std::env::var("ADRIX_DEV_PHP_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(DEV_PORT));
    }
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

pub fn start(app: &AppHandle, token: &str) -> Result<PhpServer> {
    let dirs = dirs(app)?;
    if !dirs.php.join("adminer.php").is_file() {
        let file = dirs.php.join("adminer.php");
        return Err(Error::msg(tr!(
            "не найден {} — выполните `pnpm deps`",
            "{} not found — run `pnpm deps`",
            file.display()
        )));
    }
    let port = pick_port()?;

    let cache = app.path().app_cache_dir()?;
    let sessions = cache.join("sessions");
    let tmp = cache.join("tmp");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&tmp)?;

    let path = |p: &PathBuf| p.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec![
        "-n".into(), // ignore any system php.ini
        "-d".into(),
        format!("session.save_path={}", path(&sessions)),
        "-d".into(),
        format!("upload_tmp_dir={}", path(&tmp)),
        "-d".into(),
        format!("sys_temp_dir={}", path(&tmp)),
        "-d".into(),
        "memory_limit=1G".into(),
        "-d".into(),
        "max_execution_time=0".into(),
        "-d".into(),
        "upload_max_filesize=2G".into(),
        "-d".into(),
        "post_max_size=2G".into(),
        "-d".into(),
        "max_input_vars=100000".into(),
        "-d".into(),
        "display_errors=stderr".into(),
        "-d".into(),
        "error_reporting=E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING".into(),
        "-d".into(),
        "zend.assertions=-1".into(),
        "-d".into(),
        "opcache.enable_cli=1".into(),
        "-S".into(),
        format!("127.0.0.1:{port}"),
        "-t".into(),
        path(&dirs.ui),
        path(&dirs.php.join("router.php")),
    ];
    if cfg!(debug_assertions) {
        // show PHP errors in dev
        args.retain(|a| !a.starts_with("error_reporting="));
    }

    // ADRIX_PHP_BIN = use an external php (dev). A system php loads its extensions
    // via php.ini, so `-n` is not passed in that case.
    let mut cmd = match std::env::var("ADRIX_PHP_BIN") {
        Ok(bin) if !bin.is_empty() => {
            args.remove(0);
            app.shell().command(bin)
        }
        _ => app
            .shell()
            .sidecar("php")
            .map_err(|e| Error::msg(format!("PHP sidecar: {e}")))?,
    };
    cmd = cmd.args(args).env("ADRIX_TOKEN", token).current_dir(&dirs.php);
    if cfg!(unix) {
        cmd = cmd.env("PHP_CLI_SERVER_WORKERS", "4");
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| Error::msg(tr!("не удалось запустить PHP: {e}", "failed to start PHP: {e}")))?;
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stderr(line) | CommandEvent::Stdout(line) => {
                    log::debug!("php: {}", String::from_utf8_lossy(&line).trim_end());
                    if cfg!(debug_assertions) {
                        eprintln!("php: {}", String::from_utf8_lossy(&line).trim_end());
                    }
                }
                CommandEvent::Terminated(t) => log::warn!("php terminated: {:?}", t.code),
                _ => {}
            }
        }
    });

    let server = PhpServer {
        port,
        child: Mutex::new(Some(child)),
    };
    wait_ready(port).inspect_err(|_| server.kill())?;
    Ok(server)
}

fn wait_ready(port: u16) -> Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(Error::msg(tr!(
        "PHP не запустился на 127.0.0.1:{port}",
        "PHP did not start on 127.0.0.1:{port}"
    )))
}
