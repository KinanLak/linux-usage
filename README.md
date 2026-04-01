# Linux Usage

GNOME top-bar quota monitor for Codex, Claude, and GitHub Copilot on Rocky Linux 9.7.

## Layout

- `src/extension/`: GNOME extension source (TypeScript + static assets)
- `src/helper/`: GJS helper source (bundled in the extension zip)
- `dist/`: generated GNOME 45+ ESM bundle
- `dist-pre45/`: generated GNOME 40-44 legacy bundle
- `contracts/`: normalized snapshot schema
- `docs/`: architecture and provider notes

## Local development

```bash
npm install
make check
make install-legacy  # GNOME 40-44
make install-esm     # GNOME 45+
```

Then restart GNOME Shell or log out/in before enabling the extension.

## Tooling

- `npm run typecheck`: run per-file TypeScript checks
- `npm run lint`: run `oxlint` on the source tree
- `npm run format`: format the source tree with `oxfmt`
- `npm run build`: build the GNOME 45+ ESM bundle in `dist/`
- `npm run build:legacy`: build the GNOME 40-44 legacy bundle in `dist-pre45/`
- `npm run build:all`: build both bundles
- `npm run clean`: remove the generated build directory
- `make`: build both bundles
- `make build-esm`: build only the GNOME 45+ ESM bundle
- `make build-legacy`: build only the GNOME 40-44 legacy bundle
- `make check`: run typecheck, lint, and build
- `make pack`: create both `linux-usage.zip` and `linux-usage-pre45.zip`
- `make pack-esm`: create `linux-usage.zip`
- `make pack-legacy`: create `linux-usage-pre45.zip`
- `make install-esm`: install the GNOME 45+ package
- `make install-legacy`: install the GNOME 40-44 package
- `make clean`: remove generated bundles, zip artifacts, `node_modules/`, and the compiled schema artifact

## Adding a provider

- Add the provider metadata once in `src/extension/providers.json`
- Implement the provider module in `src/helper/src/providers/`
- Register the provider in `src/helper/src/registry.ts`

## Notes

- The extension prefers D-Bus, then falls back to calling the bundled GJS helper directly.
- Copilot is the most complete provider path right now because a GitHub token is available locally.
- Codex and Claude still depend on the exact local auth state on this machine.
