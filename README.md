# Adrix

Desktop [Adminer](https://www.adminer.org) for Linux and Windows. It connects to
MySQL / MariaDB, PostgreSQL and SQLite, either directly or through an SSH tunnel.

- Saved connections, one click opens a tab that is already logged in
- SSH: password, private key, or key + passphrase; TOFU host key check
- Passwords are encrypted (ChaCha20-Poly1305); the key is kept in the OS keyring
- Several tabs at once, and Ctrl+F search works like in a browser
- UI in English and Russian, light and dark theme (Adminer itself is always English)
- Everything runs locally: Rust core + a static PHP binary, nothing to install

See [docs/PLAN.md](docs/PLAN.md) for the architecture.

## Keyboard

| Keys | Action |
|---|---|
| Ctrl+N | new connection |
| Ctrl+F, F3 / Shift+F3 | find in page, next / previous match |
| Ctrl+W | close tab |
| Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1…9 | switch tabs |
| F5 / Ctrl+R | reload tab (GET, never re-sends a form) |
| Ctrl+B | toggle sidebar |
| Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+wheel | zoom in / out / reset (remembered) |
| Ctrl+click / middle click | another tab for the same connection |

## Development

Requirements:
- Rust (stable)
- Node 22+ and pnpm
- Linux: WebKitGTK 4.1 dev packages (`libwebkit2gtk-4.1-dev` on Debian/Ubuntu, `webkit2gtk-4.1` on Arch)

```sh
pnpm install
pnpm deps                  # Adminer + prebuilt static PHP for this platform
# or: node scripts/fetch-deps.mjs --php=system   # copy php from PATH (needs mysqli/pgsql/sqlite3)
pnpm tauri dev
```

In dev, PHP listens on `127.0.0.1:18765`, and Vite proxies `/adminer` to it.
`ADRIX_PHP_BIN=/usr/bin/php` runs an external PHP instead of the sidecar.

Release build:

```sh
pnpm tauri build                       # all bundles for this OS
pnpm tauri build --bundles appimage    # only the AppImage
scripts/install-desktop.sh             # add Adrix to the desktop menu (rofi drun, GNOME, KDE…)
```

## Nightly builds

Every push to `main` (`.github/workflows/nightly.yml`) builds a Linux AppImage and publishes
it to the rolling **nightly** pre-release. The latest build always has the same URL:

```
https://github.com/shklyarik/adrix/releases/download/nightly/Adrix-nightly-x86_64.AppImage
```

## Releases

`.github/workflows/release.yml` builds:
- **Linux** (Ubuntu 22.04 runner, old glibc for compatibility): `.AppImage`, `.deb`, `.rpm`
- **Windows**: `.msi`, NSIS `-setup.exe`

To publish, push a tag. This creates a **draft** GitHub Release with all the files:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

A manual run (*Actions → Release → Run workflow*) uploads the bundles as
workflow artifacts instead.

On Windows, PHP is compiled with static-php-cli, because the prebuilt binary
has no `pgsql`. The result is cached, so only the first run is slow.

## Data location

| File | Contents |
|---|---|
| `connections.json` | connections (no passwords) |
| `secrets.vault` | encrypted passwords / passphrases |
| `vault.key` | vault key, **only** when no OS keyring is available |
| `known_hosts.json` | SSH host key fingerprints |
| `settings.json` | language, theme |

The directory is `~/.config/dev.adrix.app/` on Linux and
`%APPDATA%\dev.adrix.app\` on Windows.

## License

Adrix is [MIT](LICENSE). Bundled third-party software — Adminer (Apache-2.0, © Jakub Vrána),
static PHP (PHP License 3.01) and its libraries — is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md);
the license texts ship with every package.
