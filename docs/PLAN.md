# Adrix — plan

A desktop wrapper around [Adminer](https://www.adminer.org) with SSH tunnels and saved connections.

## Stack

| Layer | Technology | Why |
|---|---|---|
| Shell | Tauri v2 (WebKitGTK on Linux, WebView2 on Windows) | small binary, system webview |
| Core | Rust (tokio, russh, keyring, chacha20poly1305) | connections, SSH tunnels, encrypted secrets, PHP process |
| PHP | static `php-cli` (static-php-cli) as a Tauri sidecar | `php -S 127.0.0.1:<port>` serves Adminer and the UI |
| Adminer | 6.3.0, English-only build + `adrix-plugin.php` | auto-login, framing, theme sync, no external requests |
| UI | vanilla TypeScript + Vite, no framework | ~22 KB JS, easy to optimise |

Databases: MySQL / MariaDB, PostgreSQL, SQLite.
UI languages: English, Russian. Themes: light, dark. Adminer itself is always English.

## Architecture

```
Tauri window ──► http://127.0.0.1:<port>/          (UI: dist/, served by php -S)
   └─ iframe ──► http://127.0.0.1:<port>/adminer/  (Adminer, same origin)

Rust: open_session(id)
   ├─ direct:  server = host:port
   └─ ssh:     russh → local 127.0.0.1:<rnd> ⇄ direct-tcpip ⇄ db_host:db_port
UI: POSTs auth[...] into the iframe → Adminer is logged in
```

**Why one origin.** A cross-origin iframe counts as third party, and WebKitGTK
blocks its cookies, which breaks Adminer sessions. With one origin the cookies
work, and the parent page can reach into the iframe document. Ctrl+F search
relies on that.

**Settings live in Rust** (`settings.json`). The release origin uses a random
port, so `localStorage` would not survive a restart.

**Login without CSRF token.** Instead of Adminer's CSRF token, the plugin
checks a per-process secret (`ADRIX_TOKEN`). Only the Rust core and the app
window know it.

### SSH

Supported authentication:
- user + password;
- private key (OpenSSH / PEM);
- private key + passphrase.

Host keys use TOFU: the fingerprint is stored on first connect, and a
mismatch is an error. The stored key can be reset from the connection dialog.

### Secrets

All secrets (DB password, SSH password, key passphrase) are stored in one
encrypted file, `secrets.vault`, using ChaCha20-Poly1305.

The 256-bit vault key is kept in the OS keyring: Secret Service on Linux,
Credential Manager on Windows. Without a keyring, the key goes to `vault.key`
(mode 0600) and the UI shows a warning. Secrets are still never stored as
plain text.

If the vault cannot be decrypted (wrong key, keyring locked), it is locked
and never overwritten.

## Milestones

1. **Skeleton:** Tauri v2 + Vite/TS, PHP sidecar, Adminer, plugin. ✅
2. **Connections:** CRUD, encrypted vault, dialog for direct and SSH connections. ✅
3. **SSH tunnels:** russh with password / key / key+passphrase, TOFU. ✅
4. **Tabs + search:**
   - one iframe per tab, auto-login;
   - Ctrl+F (CSS Highlight API, Selection fallback);
   - Ctrl+W, Ctrl+Tab, Ctrl+1…9, F5 (safe GET reload). ✅
5. **i18n + themes:** en/ru, light/dark (synced into Adminer). ✅
6. **CI/CD:**
   - static PHP build for Windows (cached);
   - AppImage/deb/rpm + msi/nsis;
   - release on `v*` tags. ✅
7. **Later:**
   - jump host / ssh-agent;
   - remote SQLite over SFTP;
   - Tauri updater;
   - import from `~/.ssh/config`;
   - search inside `<input>`/`<textarea>`;
   - colour labels (prod/stage).

## Known limitations

- **Windows:** `php -S` is single-threaded, so a long query in one tab blocks the others. Linux uses `PHP_CLI_SERVER_WORKERS=4`.
- **AppImage:** some distros need `libfuse2`; otherwise run it with `--appimage-extract-and-run`.
- **Same origin:** Adminer pages share the origin with the app window. This is required for cookies and search, so Adminer runs with a strict CSP and no external requests.
