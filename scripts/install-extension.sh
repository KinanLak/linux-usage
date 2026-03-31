#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="linux-usage@kinanl"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
BUNDLE="$ROOT/dist"

if [ -d "$ROOT/node_modules" ]; then
  npm --prefix "$ROOT" run build:extension >/dev/null
fi

if [ ! -f "$BUNDLE/metadata.json" ]; then
  printf 'Missing dist bundle. Run npm install && npm run build:extension first.\n' >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$BUNDLE/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

echo "Installed extension to $DEST"
echo "Reload GNOME Shell or restart the session to test it."
