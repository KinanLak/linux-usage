# Copilot provider

- Reads `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.
- Calls `https://api.github.com/copilot_internal/user`.
- Maps `premiumInteractions` and `chat` quota snapshots.

Without a token the provider reports `auth_required`. No in-extension device-flow UX and no editor-session reuse yet.
