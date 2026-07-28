# AI Agent Rules — Athena-Search

## Security: Never leak secrets

- NEVER commit `.env`, `.env.*`, `.dev.vars`, `*.pem`, `*.key`, `credentials.json`, `secrets.*`
- NEVER run `git add .` — stage only the files required for the task
- ALWAYS show `git diff --cached` before committing
- NEVER push without user confirmation
- If a secret is detected in staged changes, STOP immediately and report it

## Git workflow

- Create feature branches: `git checkout -b feature/description`
- Commit messages: `feat:`, `fix:`, `docs:`, `chore:` prefix
- One logical change per commit

## Project structure

- `worker/` — Cloudflare Worker (main app logic)
- `server/` — Self-hosted Node.js server
- `public/` — Frontend assets

## Tech stack

- Node.js >= 22, ES modules
- PostgreSQL (self-hosted) / D1 (Cloudflare)
- Playwright for scraping

## Before committing

Run these checks:
1. `git status` — verify only intended files are staged
2. `git diff --cached` — review actual changes
3. Confirm no secrets, tokens, or credentials in the diff
