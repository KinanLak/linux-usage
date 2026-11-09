# Codex provider

- Reads `~/.codex/auth.json`, or a `type: "codex"` file in `~/.cli-proxy-api/` (see `credential-source` in `docs/architecture.md`).
- On a 401 with the local file, refreshes the token and writes it back. Never with CLIProxyAPI, which owns the refresh token.
- Decodes JWT claims for email/plan hints.
- Calls `https://chatgpt.com/backend-api/wham/usage`.
- Normalizes primary/secondary windows when possible.

The payload parser is heuristic (shape varies). No CLI or browser-cookie fallback yet.
