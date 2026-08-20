# Athena Search

Your second brain for links, documents, Telegram messages, and grounded AI answers.

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.53-blueviolet?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/license_CC_BY--NC_4.0-blue?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/PostgreSQL-required-336791?style=flat-square&logo=postgresql" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Telegram-bot-26A5E4?style=flat-square&logo=telegram" alt="Telegram">
</p>

Athena is a self-hostable bookmark and document archive. Save from the web UI, Telegram, the terminal, or a linked channel; search the whole database; and ask an AI model to answer with sources from your own collection.

<p align="center">
  <img src="screenshots/dark-purple.svg" width="24%" alt="Dark theme">
  <img src="screenshots/glass-purple.svg" width="24%" alt="Glass theme">
  <img src="screenshots/material-blue.svg" width="24%" alt="Material theme">
  <img src="screenshots/light-green.svg" width="24%" alt="Light theme">
</p>

## What it does

- Saves URLs, notes, code, text files, and self-hosted binary documents as searchable Markdown.
- Searches titles, URLs, notes, tags, and document content across the complete PostgreSQL corpus.
- Uses optional [Meilisearch](https://www.meilisearch.com/) as a fast derived index; PostgreSQL remains the source of truth and the fallback.
- Answers questions with retrieval-augmented context and source links.
- Supports OpenAI-compatible gateways, Anthropic, OpenRouter, OpenCode Zen, Groq, and local routers such as [OmniRoute](https://github.com/df4p/omniroute).
- Provides personal and community brains with rank-aware permissions, voting, reports, and Telegram group membership gates.
- Includes a Telegram bot, channel indexing, optional history backfill, and a zero-build terminal UI.

## Quick start

The recommended deployment is the self-hosted Node server with PostgreSQL.

```bash
git clone https://github.com/JuznemHub/Athena-Search.git
cd Athena-Search
npm install
cp .env.example .env
node server/index.js
```

Requirements: Node.js 22+ and PostgreSQL 14+. Set at least:

```dotenv
DATABASE_URL=postgresql://athena:password@localhost:5432/athena
PORT=8787
TG_OWNER_IDS=your_telegram_user_id
TELEGRAM_BOT_TOKEN=your_bot_token
```

The server creates and migrates the PostgreSQL tables on startup. See [`server/.env.example`](server/.env.example) for the annotated configuration reference. Caddy, systemd, Cloudflare Tunnel, and Nginx examples are in [`server/`](server/).

### Cloudflare frontend

The Worker can serve the static frontend and API while PostgreSQL remains the only database. Set `DATABASE_URL` and the required OAuth/bot secrets as Wrangler secrets, then deploy:

```bash
cd worker
npx wrangler secret put DATABASE_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler deploy
```

Text uploads work in the Worker runtime. Binary conversion needs the self-hosted Node backend, either directly or behind the Cloudflare frontend.

## Configuration

| Area | Variables | Notes |
| --- | --- | --- |
| Database | `DATABASE_URL` | Required; PostgreSQL is canonical. |
| Telegram bot | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Bot API ingestion, commands, and webhooks. |
| Telegram login | `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET` | OAuth/Mini App login. |
| Session history | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `STORAGE_KEY` | Optional self-hosted GramJS backfill; never expose these to the browser. |
| Search index | `MEILI_URL`, `MEILI_MASTER_KEY`, `MEILI_INDEX` | Optional; defaults to index `athena`. |
| JS scraping | `KAGE_BIN`, `KAGE_CHROME` | Optional [Kage](https://github.com/tamnd/kage) + Chrome/Chromium fallback. |
| AI | `OPENROUTER_API_KEY` or settings UI | Credentials are stored server-side and never returned to normal users. |

## Search and AI

PostgreSQL is authoritative. When `MEILI_URL` is configured, Athena creates the `athena` index, syncs each personal/community scope in the background, and uses it for normal search and AI retrieval. Writes mark the relevant scope dirty; an unavailable or warming Meilisearch instance falls back to the complete PostgreSQL search instead of returning an incomplete corpus.

The web UI’s **Models** picker calls the configured endpoint’s live `/models` catalog and preserves provider metadata, pricing, context length, and supported model IDs. OpenRouter’s router model is available as:

```text
Base URL: https://openrouter.ai/api/v1
Model:    openrouter/free
```

`openrouter/free` is the default OpenRouter choice. For a local OpenAI-compatible router, choose **OmniRoute** or enter:

```text
Base URL: http://127.0.0.1:20128/v1
Model:    openrouter/free   # or a model exposed by the gateway
```

Local HTTP endpoints are allowed only by the self-hosted server and are restricted to loopback/private addresses. Public upstream endpoints must use HTTPS. The proxy keeps streaming responses, model fallbacks, rate limits, and upstream error history.

## Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. DM it `/id` to obtain your Telegram user ID.
3. In Athena, open **Settings → Bot**, enter the token and owner ID, and verify it.
4. Add the bot to a group and run `/community_verify` to create or bind a community.

### Bot mode and session mode

Bot API mode is the default and safest mode:

- no user session string is required;
- the bot indexes new messages, links, and supported documents it can see;
- a channel must be linked with `/channel_link <community_id> <channel_id>`;
- the bot must have the required admin/read permissions in that channel.

Session mode is optional and self-host-only. It uses a Telegram user session to backfill older history with `/index_start`; the encrypted session is kept only for the job and removed when the job finishes or is stopped. Treat a session string like a password: it can grant access to the Telegram account that created it.

Athena accepts compatible Telethon/Pyrogram-style StringSession values for this bridge. It does not vendor or execute the full [Ultroid](https://github.com/TeamUltroid/Ultroid) userbot; Ultroid can remain a separate session generator/client if you already use it.

### Exporting into the bot

Use `/export` for the complete setup guide. A Telegram export is normally imported in bot format through the TUI or `/index_start` workflow; it does not require changing the bot into a userbot. The bot’s normal link/document dump path remains available in both personal and community scopes.

Useful commands:

| Command | Purpose |
| --- | --- |
| `/help` | Detailed command menu and setup guidance. |
| `/search <query>` | Search only matching links/documents with page buttons. |
| `/ai <question>` | Ask the configured model over the active brain. |
| `/export` | Explain bot-mode export and optional session-history import. |
| `/channel_link <community_id> <channel_id>` | Index new channel posts into a community. |
| `/channel_unlink <channel_id>` | Stop channel indexing. |
| `/index` | Show indexing status and available backfill actions. |
| `/index_start ...` | Start optional self-hosted history backfill. |
| `/index_status` / `/index_stop` | Inspect or cancel a backfill. |
| `/community_join <id>` | Join a community after joining its Telegram group. |
| `/personal` / `/community` | Switch the GOD user’s dump target. |
| `/delete <url>` | Delete a link, or reply to a saved link with `/delete`. |

`/search` is deliberately scoped: every page contains only results matching the query, and **Next page** loads the next matching slice before the close button. Unrelated recent bookmarks are never appended to the result list.

## Scraping

Every saved URL is first handled by Athena’s normal safe fetch and extractor. GitHub, GitLab, Reddit, and common forge pages have dedicated metadata paths. If a page is JavaScript-rendered and the static result is too thin, self-hosted Athena can invoke Kage with a real Chrome/Chromium browser:

```bash
kage clone https://example.com --max-pages 1 --workers 1 -o /tmp/athena-kage-check
```

Configure the binary explicitly when needed:

```dotenv
KAGE_BIN=/usr/local/bin/kage
KAGE_CHROME=/usr/bin/chromium
```

Kage is optional. If it is missing, disabled, or fails, Athena keeps the safe static metadata fallback. The browser-rendered output is read from Kage’s host directory under the selected output root; scripts are not stored as page content.

## Terminal UI

[`athena-tui`](tui/README.md) imports browser bookmarks and export files without requiring a browser session on the server.

```bash
npm install -g athena-tui
athena-tui
```

It supports Chrome, Chromium, Edge, Brave, Opera, Vivaldi, Arc, Firefox, and explicit export files. `Tab` opens the advanced AI/MCP view when configured; the website and database can stay on a VPS while the TUI runs locally.

## Permissions

| Rank | Personal brain | AI | Bot settings | Community links/docs |
| --- | ---: | ---: | ---: | ---: |
| GOD / instance owner | Yes | Yes | Yes | Full |
| Community owner | No | Yes | No | Manage |
| Community admin | No | Yes | No | Manage |
| Member | No | Yes | No | Add/search |
| Banned user | No | No | No | No |

Empty `TG_OWNER_IDS` is convenient for a private instance: every authenticated user is treated as GOD. For a shared deployment, set it explicitly.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Runtime, database, version, and feature status. |
| GET | `/api/links/search` | Whole-corpus scoped search; Meilisearch-backed when configured. |
| GET/POST/PATCH/DELETE | `/api/links` | Community link CRUD. |
| GET/POST/DELETE | `/api/documents` | Document CRUD. |
| GET | `/api/ai/models` | Live model catalog for the settings picker. |
| POST | `/api/ai/chat` | Streaming AI proxy with retrieved context. |
| GET/POST | `/api/ai/config` | GOD-only AI configuration. |
| POST | `/api/telegram-webhook` | Telegram update ingress. |

## Project layout

```text
public/       zero-build frontend and themes
worker/       Worker routes, Telegram bot, schema, scraping, AI proxy
server/       Node adapter, PostgreSQL driver, backups, static server
tui/          terminal bookmark importer and MCP-aware client
scripts/      versioning and retrieval checks
```

## Development

```bash
npm install
npx eslint worker/ server/ public/ scripts/
npm run check:version
npm run test:unit
```

The repository’s CI also runs the TUI test suite and secret scanning. PostgreSQL is required for runtime integration checks; the unit retrieval test is self-contained.

## License

[CC BY-NC 4.0](LICENSE) — attribution required; commercial use requires separate permission.
