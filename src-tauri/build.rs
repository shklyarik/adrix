fn main() {
    // Explicit command manifest: tauri-build generates allow-<command> permissions,
    // granted to the window (local in dev, remote http://127.0.0.1:PORT in release).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "app_info",
            "list_connections",
            "save_connection",
            "delete_connection",
            "reorder_connections",
            "test_connection",
            "open_session",
            "close_session",
            "forget_host_key",
            "save_settings",
            "pick_file",
        ])),
    )
    .expect("failed to run tauri-build");
}
