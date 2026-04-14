# Architecture

- `src/extension/` — GNOME Shell extension (TypeScript ESM)
- `src/helper/` — GJS helper, bundled in the zip
- `dist/` (GNOME 45+) / `dist-pre45/` (GNOME 40–44) — generated bundles
- `src/extension/providers.json` — shared provider catalog (IDs, titles, icons)

The legacy bundle is produced by rewriting `dist/` with `scripts/build-legacy-gjs.mjs`. See `AGENTS.md` for the transformer rules.

## Data flow

1. Extension opens or auto-refreshes.
2. `services/helper_client` tries D-Bus, then falls back to spawning the bundled helper CLI.
3. The helper queries each registered provider sequentially.
4. It returns a snapshot matching `contracts/snapshot.schema.json`.
5. The extension renders the Overview tab or a per-provider card.

## Auth

- Codex and Claude: local session files on disk.
- Copilot: `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`.
