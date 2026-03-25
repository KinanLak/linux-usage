# Linux Usage

GNOME top-bar quota monitor for Codex, Claude, and GitHub Copilot on Rocky Linux 9.7.

## Layout

- `extension/`: GNOME Shell extension
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
./scripts/install-helper.sh
./scripts/install-extension.sh
```

Then restart GNOME Shell or log out/in before enabling the extension.

## Adding a provider

- Add the provider metadata once in `extension/providers.json`
- Implement the provider module in `helper/src/providers/`
- Register the provider in `helper/src/providers/mod.rs`

## Notes

- Copilot is the most complete provider path right now because a GitHub token is available locally.
- Codex and Claude still depend on the exact local auth state on this machine.
- The extension prefers D-Bus, then falls back to calling `linux-usage-helper snapshot` directly.
