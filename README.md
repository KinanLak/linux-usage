# Linux Usage

GNOME top-bar quota monitor for Codex, Claude, and GitHub Copilot on Rocky Linux 9.7.

## Layout

- `extension/`: GNOME Shell extension
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

## Notes

- Copilot is the most complete provider path right now because a GitHub token is available locally.
- Codex and Claude still depend on the exact local auth state on this machine.
- The extension prefers D-Bus, then falls back to calling `linux-usage-helper snapshot` directly.
