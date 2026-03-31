# Claude provider

Current implementation:

- reads `~/.claude/.credentials.json` or `~/.config/claude/.credentials.json`
- accepts both legacy top-level tokens and current `claudeAiOauth.accessToken`
- calls `https://api.anthropic.com/api/oauth/usage`
- maps `five_hour`, `seven_day`, and optional `extra_usage`

Current limits:

- requires a local Claude OAuth access token
- if needed, refresh the local session with `claude auth login`
- no browser-cookie fallback yet
- no CLI PTY fallback yet
