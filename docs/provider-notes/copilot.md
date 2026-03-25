# Copilot provider

Current implementation:

- checks `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`
- calls `https://api.github.com/copilot_internal/user`
- maps `premiumInteractions` and `chat` quota snapshots

Current limits:

- no interactive device-flow UX in the extension yet
- Linux editor session reuse is not implemented yet
- if no GitHub token is available, Copilot reports `auth_required`
