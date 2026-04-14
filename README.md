# Linux Usage

GNOME top-bar quota monitor for Codex, Claude, and GitHub Copilot.

## Build & install

```bash
bun install
bun run check        # typecheck + lint + build both bundles
make install-esm     # GNOME 45+
make install-legacy  # GNOME 40-44
```

## Layout

- `src/extension/` — extension source (TypeScript)
- `src/helper/` — GJS helper, bundled in the zip
- `dist/`, `dist-pre45/` — generated bundles (ESM and legacy GJS)
- `contracts/snapshot.schema.json` — normalized snapshot schema

## Adding a provider

1. Add metadata to `src/extension/providers.json`
2. Implement the module in `src/helper/src/providers/`
3. Register it in `src/helper/src/registry.ts`

See `AGENTS.md` for the dual-package build pipeline and `docs/` for architecture and provider notes.
