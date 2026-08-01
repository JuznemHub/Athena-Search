# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                          # node server/index.js — self-hosted, needs DATABASE_URL
./start.sh                         # production: sources .env, then starts

cd worker && npx wrangler deploy
npx wrangler tail                                # live logs
npx wrangler secret put TELEGRAM_CLIENT_SECRET   # also TELEGRAM_BOT_TOKEN, DISCORD_CLIENT_SECRET, STORAGE_KEY

npm run backup                     # one-off dump → Telegram/Drive (self-host only)
node server/restore.js <parts...>  # rejoin split backup parts
node server/migrate-from-cloudflare.js
node server/merge-telegram-identities.js   # merge one person's OIDC + Bot API identities
```

No tests. `npm run check` runs lint, version-drift check, and `node --check` — run before committing.

## Architecture

### One codebase, two runtimes

`worker/index.js` (~8.3k lines) is the whole app: router, auth, API handlers, storage, AI proxy, Telegram bot. Written for Cloudflare Workers.

`server/index.js` runs that same file under Node, supplying the missing bindings: `env.DB` (D1-shaped Postgres adapter) and `env.ASSETS` (disk). Streams response bodies through, so AI token streaming survives.

So: gate any Cloudflare-only or Node-only code in `worker/index.js` behind `isSelfHosted(env)` (`ATHENA_RUNTIME === 'selfhost'`, else detects the Postgres adapter). Existing exception — `/restart` dynamic-imports `node:child_process` for `systemctl restart athena`; throws harmlessly on Workers.

### D1 → Postgres

All SQL is SQLite/D1 dialect. `server/pgdb.js` gives `pg` the D1 `prepare().bind().run()/.first()/.all()` contract; `worker/pgcompat.js` rewrites statements in flight:

- `?` → `$1, $2, …`, quote-aware
- `INSERT OR REPLACE` → `ON CONFLICT (pk) DO UPDATE`
- DDL `INTEGER` → `BIGINT` — ms timestamps (~1.8e12) overflow `int4`

New table using `INSERT OR REPLACE` → add it to `PRIMARY_KEYS` in `worker/pgcompat.js`. Missing entry degrades the upsert to `DO NOTHING`: writes vanish while reporting success.

### Schema

`worker/schema.sql` applies at startup; roughly half the tables are instead created lazily by `ensure*Table(env)` at the top of each handler (~98 call sites). New columns arrive the same way, inline `ALTER TABLE … ADD COLUMN` (pgcompat makes it idempotent). No migration runner, no version table.

### Storage: parking, not scoping

D1 / GitHub Markdown / Postgres. Live `links` and `personal_links` always hold the *active* store; switching provider parks current rows into `parked_links` / `parked_personal_links` tagged by store name and restores the other set (`parkActiveStore` / `restoreStore`). Read paths stay provider-unaware.

GitHub active → Markdown is source of truth, D1 is cache:

- `ensureFresh(env, scope, key)` revalidates before reads — one listing, skipped inside `LISTING_TTL_MS` (15s), per-file parse cache keyed by git sha in `storage_file_cache`
- Writes hit GitHub first, then cache
- GitHub unreachable → serve stale cache, never wipe

GitHub PAT is AES-GCM encrypted at rest (`enc:v1:` prefix) under `env.STORAGE_KEY`; unset → plaintext fallback.

### Auth and ranks

Session token (cookie or bearer), 30-day TTL. All `/api/` needs a session except the `PUBLIC_API` set at the top of `worker/index.js`. Rank checks are async — they hit the DB and Telegram API.

- `isInstanceOwnerUserAsync` — GOD, from `TG_OWNER_IDS` / `DISCORD_OWNER_IDS`. Empty lists mean every logged-in user is GOD (self-host default).
- `isElevatedUser` / `isCommunityAdminUser` — per-community admin/owner
- `resolveUserRank` — full ladder, used by bot commands

Bans are per-community, driven by live Telegram presence: `syncLivePresenceForUser` / `enforceGroupPresenceOrBan` auto-ban on leave, auto-unban on rejoin (`PRESENCE_BAN_REASONS`). One person can hold both a Telegram OIDC identity and a Bot API numeric ID — hence `resolveTgApiIdForUser` and `merge-telegram-identities.js`.

### Telegram bot

`handleTelegramWebhook` (worker/index.js:5690), a single ~2000-line dispatcher. Every delivery is secret-verified (`webhookSecret`: `TELEGRAM_WEBHOOK_SECRET`, else derived from the bot token) — unverified, the endpoint is unauthenticated RPC where `from.id` can be forged to act as GOD. `WEBHOOK_ALLOW_UNSIGNED=1` disables it; migration only.

Output is Telegram HTML via `escHtml` / `boldHtml` / `codeHtml` / `linkHtml` — escape every interpolated value or a `<` in a title breaks the message. `chunkTelegramText` splits at the 4096-char cap.

Multiple bots bind per community (`community_bots`): `findTelegramBinding` resolves chat → bot → community, `tokenForBinding` picks the token.

### Link enrichment

`scrapeLinkMetadata` / `scrapeForgeMetadata` pull title, description, image by regex over fetched HTML — plain `fetch`, no headless browser, since it runs in a Worker. `isWeakTitle` / `isUiNoiseText` / `scoreDescriptionCandidate` / `parseReadmeIntro` reject site chrome and GitHub UI boilerplate.

One message can carry a main link plus references; `scoreUrlAsPrimary` / `selectPrimaryLinks` decide which becomes its own entry.

### Frontend

`public/` — no bundler, no framework, no ES modules. Plain `<script>` tags sharing window globals: `window.AthenaSearch` (fuzzy search + RAG retrieval), `window.AthenaAI`, `window.Dedupe` (URL normalize + duplicate check). `main.js` is one large IIFE.

Cache-busting is stamped: `npm run build` rewrites `?v=` in `public/index.html` (every asset), `version:` in `worker/index.js:47`, and the README badge from the single source of truth — `version` in root `package.json`. `npm run check:version` (part of `npm run check`) fails CI on drift. Bump via `npm version patch` then `npm run build`.

Themes are CSS custom properties in `themes.css` (dark/light/material/glass). The accent picker converts hex → HSL at runtime (`hexToHsl` / `applyAccentColor`) and writes the derived vars — consume `--accent-*`, never hardcode a color.

`API_BASE` is dynamic: a Cloudflare-served frontend may talk to a self-hosted backend, resolved via `/api/instance/config` and `adoptInstanceBackend()`.

## Conventions

- ES modules in `server/` and `worker/`, Node >= 22, no TypeScript. `public/**/*.js` stays plain scripts
- Responses: `{ success, ... }` / `{ success: false, error, code }`; `deny()` builds the 403 shape
- Unmatched `/api/*` returns JSON 404 — falling through to the SPA handler serves `index.html` with HTTP 200

## Git

- Branches `feature/description`; Conventional Commit prefixes; one logical change per commit
- Never `git add .` — stage only what the task needs. `.env`, `.dev.vars`, `worker/.env.deploy` live in this tree; `.gitleaks.toml` guards the repo
- Show `git diff --cached` before committing. Secret in the diff → stop and report, don't quietly unstage
- Never push without explicit confirmation
