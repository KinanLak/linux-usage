# Codex provider

- Reads `~/.codex/auth.json`.
- Decodes JWT claims for email/plan hints.
- Calls `https://chatgpt.com/backend-api/wham/usage`.
- Normalizes primary/secondary windows when possible.

The payload parser is heuristic (shape varies). No CLI or browser-cookie fallback yet.
