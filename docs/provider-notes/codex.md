# Codex provider

Current implementation:

- reads `~/.codex/auth.json`
- decodes JWT claims for email/plan hints
- calls `https://chatgpt.com/backend-api/wham/usage`
- normalizes primary/secondary windows when possible

Current limits:

- parser is heuristic because the exact payload can vary
- no CLI fallback yet
- no browser-cookie extras yet
