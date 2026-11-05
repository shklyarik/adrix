#[macro_use]
mod i18n;
mod commands;
mod error;
mod php;
mod ssh;
mod store;
mod vault;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use commands::AppState;

const APP_PERMISSIONS: &[&str] = &[
    "core:default",
    "allow-app-info",
    "allow-list-connections",
    "allow-save-connection",
    "allow-delete-connection",
    "allow-reorder-connections",
    "allow-test-connection",
    "allow-open-session",
    "allow-close-session",
    "allow-forget-host-key",
    "allow-save-settings",
    "allow-pick-file",
    "core:window:allow-set-theme",
    "core:webview:allow-set-webview-zoom",
];

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("getrandom");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let token = random_token();
    let php = php::start(&handle, &token)?;
    let store = store::Store::load(handle.path().app_config_dir()?)?;

    // In release the window loads the UI from the same origin as Adminer (http://127.0.0.1:PORT),
    // so IPC is granted to exactly that origin. In dev capabilities/default.json (devUrl) applies.
    let url = if cfg!(debug_assertions) {
        WebviewUrl::App("index.html".into())
    } else {
        let mut cap = CapabilityBuilder::new("php-origin")
            .remote(format!("{}/*", php.base_url()))
            .window("main");
        for p in APP_PERMISSIONS {
            cap = cap.permission(*p);
        }
        app.add_capability(cap)?;
        WebviewUrl::External(format!("{}/", php.base_url()).parse()?)
    };

    app.manage(AppState {
        php,
        store: Mutex::new(store),
        sessions: Mutex::new(HashMap::new()),
        token,
    });

    WebviewWindowBuilder::new(app, "main", url)
        .title("Adrix")
        .inner_size(1360.0, 860.0)
        .min_inner_size(820.0, 520.0)
        // start maximized; inner_size above is the size used after un-maximizing
        .maximized(true)
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::reorder_connections,
            commands::test_connection,
            commands::open_session,
            commands::close_session,
            commands::forget_host_key,
            commands::save_settings,
            commands::pick_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Adrix");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<AppState>() {
                state.sessions.lock().unwrap().clear();
                state.php.kill();
            }
        }
    });
}
