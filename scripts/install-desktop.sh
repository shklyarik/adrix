#!/usr/bin/env sh
# Registers Adrix in the desktop menu (rofi -show drun, GNOME/KDE launchers, ...)
# by writing a .desktop entry and an icon into ~/.local/share.
#
# Usage: scripts/install-desktop.sh [path/to/Adrix.AppImage]
# Default: the local release build, so every rebuild is picked up automatically.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APPIMAGE=${1:-"$ROOT/src-tauri/target/release/bundle/appimage/Adrix_0.1.0_amd64.AppImage"}
APPIMAGE=$(realpath "$APPIMAGE")
DATA=${XDG_DATA_HOME:-"$HOME/.local/share"}

[ -f "$APPIMAGE" ] || { echo "AppImage not found: $APPIMAGE (run: pnpm tauri build --bundles appimage)" >&2; exit 1; }
chmod +x "$APPIMAGE"

install -Dm644 "$ROOT/src-tauri/icons/128x128@2x.png" "$DATA/icons/hicolor/256x256/apps/adrix.png"
install -Dm644 "$ROOT/src-tauri/icons/128x128.png" "$DATA/icons/hicolor/128x128/apps/adrix.png"

mkdir -p "$DATA/applications"
cat > "$DATA/applications/adrix.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Adrix
GenericName=Database manager
Comment=Adminer desktop client with SSH tunnels
Exec="$APPIMAGE" %U
TryExec=$APPIMAGE
Icon=adrix
Terminal=false
Categories=Development;Database;
Keywords=adminer;mysql;mariadb;postgresql;sqlite;ssh;database;
StartupNotify=true
DESKTOP

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA/applications" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true

echo "Installed $DATA/applications/adrix.desktop -> $APPIMAGE"
