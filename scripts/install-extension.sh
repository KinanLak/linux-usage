#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="linux-usage@kinanl"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -r "$ROOT/extension/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

echo "Installed extension to $DEST"
echo "Reload GNOME Shell or restart the session to test it."
