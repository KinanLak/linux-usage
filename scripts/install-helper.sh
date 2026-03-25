#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$BIN_DIR"
cargo build --release --manifest-path "$ROOT/helper/Cargo.toml"
install -m 0755 "$ROOT/helper/target/release/linux-usage-helper" "$BIN_DIR/linux-usage-helper"

echo "Installed helper to $BIN_DIR/linux-usage-helper"
echo "Ensure $BIN_DIR is in PATH before launching the extension."
