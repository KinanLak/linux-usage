# Architecture

Linux Usage is a self-contained GNOME Shell extension:

- `src/extension/`: GNOME extension source (TypeScript + static assets).
- `src/helper/`: GJS helper source (bundled in the extension zip).
- `dist/`: generated extension bundle consumed by GJS at runtime.

## Data flow

1. The extension opens or auto-refreshes.
2. `dist/src/services/helper_client.js` tries D-Bus first, then falls back to the bundled GJS helper CLI.
3. The helper fetches every registered provider sequentially.
4. The helper returns a normalized snapshot matching `contracts/snapshot.schema.json`.
5. The extension renders either the Overview tab or a provider detail card.

## Provider catalog

- `src/extension/providers.json` is the shared provider metadata source.
- The helper uses it for stable IDs, titles, and icons.
- The preferences UI uses it to build provider toggles dynamically.

## Current v1 choices

- GNOME Shell target: `40`
- Helper transport: D-Bus service plus CLI fallback
- Auth strategy: local sessions first
- Copilot fallback: GitHub token via env or `gh auth token`

## Planned follow-ups

- stronger Copilot login flow
- richer Claude fallback paths
- trend history and notifications
- user service packaging for the helper
