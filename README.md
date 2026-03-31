# Linux Usage

GNOME top-bar quota monitor for Codex, Claude, and GitHub Copilot on Rocky Linux 9.7.

## Layout

- `ts/extension/`: TypeScript source of truth for the GNOME extension
- `extension/`: static extension assets copied into the runtime bundle
- `dist/`: generated GNOME Shell extension bundle consumed by GJS at runtime
- `extension/providers.json`: shared provider catalog consumed by the helper and prefs UI
- `helper/`: Rust helper CLI/D-Bus service
- `contracts/`: normalized snapshot schema
- `docs/`: architecture and provider notes
- `scripts/`: local install helpers

## Current status

- Codex: local `~/.codex/auth.json` support with usage API request and token refresh attempt
- Claude: local credentials file support with OAuth usage request
- Copilot: GitHub token support via env or `gh auth token`
- GNOME popup: overview + provider detail cards + manual refresh + prefs

## Local development

```bash
npm install
npm run check:extension
./scripts/install-helper.sh
./scripts/install-extension.sh
```

Then restart GNOME Shell or log out/in before enabling the extension.

The repo also has a `Makefile` aligned with the `gjs.guide` TypeScript workflow:

```bash
make
make check
make pack
make install
```

## Extension tooling

- `npm run typecheck:extension`: run per-file TypeScript checks for the GJS sources
- `npm run lint:extension`: run `oxlint` on the TypeScript sources and build scripts
- `npm run format:extension`: format the TypeScript sources and build scripts with `oxfmt`
- `npm run build:extension`: assemble `dist/` from `extension/` assets plus transpiled `ts/extension/` code
- `npm run clean:extension`: remove the generated `dist/` bundle
- `make`: build the runtime bundle in `dist/`
- `make check`: run typecheck, lint, and build
- `make pack`: compile schemas and create `linux-usage.zip`
- `make install`: install the zipped extension with `gnome-extensions install --force`
- `make clean`: remove `dist/`, `linux-usage.zip`, `node_modules/`, and the compiled schema artifact

## Adding a provider

- Add the provider metadata once in `extension/providers.json`
- Implement the provider module in `helper/src/providers/`
- Register the provider in `helper/src/providers/mod.rs`

## Notes

- Copilot is the most complete provider path right now because a GitHub token is available locally.
- Codex and Claude still depend on the exact local auth state on this machine.
- The extension prefers D-Bus, then falls back to calling `linux-usage-helper snapshot` directly.
