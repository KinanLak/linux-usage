# Linux Usage

GNOME top-bar quota monitor for Codex, Claude, and GitHub Copilot on Rocky Linux 9.7.

## Layout

- `src/extension/`: GNOME extension source (TypeScript + static assets)
- `src/helper/`: GJS helper source (bundled in the extension zip)
- `dist/`: generated extension bundle consumed by GJS at runtime
- `contracts/`: normalized snapshot schema
- `docs/`: architecture and provider notes
- `scripts/`: build and typecheck scripts

## Local development

```bash
npm install
make check
make install
```

Then restart GNOME Shell or log out/in before enabling the extension.

## Tooling

- `npm run typecheck`: run per-file TypeScript checks
- `npm run lint`: run `oxlint` on the source and build scripts
- `npm run format`: format the source and build scripts with `oxfmt`
- `npm run build`: assemble `dist/` from `src/`
- `npm run clean`: remove the generated `dist/` bundle
- `make`: build the runtime bundle in `dist/`
- `make check`: run typecheck, lint, and build
- `make pack`: compile schemas and create `linux-usage.zip`
- `make install`: install the zipped extension with `gnome-extensions install --force`
- `make clean`: remove `dist/`, `linux-usage.zip`, `node_modules/`, and the compiled schema artifact

## Adding a provider

- Add the provider metadata once in `src/extension/providers.json`
- Implement the provider module in `src/helper/src/providers/`
- Register the provider in `src/helper/src/registry.ts`

## Notes

- The extension prefers D-Bus, then falls back to calling the bundled GJS helper directly.
- Copilot is the most complete provider path right now because a GitHub token is available locally.
- Codex and Claude still depend on the exact local auth state on this machine.
