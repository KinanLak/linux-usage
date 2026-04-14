# Claude provider

- Reads `~/.claude/.credentials.json` or `~/.config/claude/.credentials.json`.
- Accepts legacy top-level tokens and current `claudeAiOauth.accessToken`.
- Calls `https://api.anthropic.com/api/oauth/usage`.
- Maps `five_hour`, `seven_day`, and optional `extra_usage`.

Refresh the local session with `claude auth login` when the token is stale. No browser-cookie or CLI PTY fallback yet.
