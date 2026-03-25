# Claude provider

Current implementation:

- reads `~/.claude/.credentials.json` or `~/.config/claude/.credentials.json`
- calls `https://api.anthropic.com/api/oauth/usage`
- maps `five_hour`, `seven_day`, and optional `extra_usage`

Current limits:

- requires a local Claude OAuth access token
- no browser-cookie fallback yet
- no CLI PTY fallback yet
