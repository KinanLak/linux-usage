#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cargo run --manifest-path "$ROOT/helper/Cargo.toml" -- snapshot --pretty
