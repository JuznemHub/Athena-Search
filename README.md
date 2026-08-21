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
  <img src="screenshots/web-dark.png" width="70%" alt="Athena web — search, dump, and AI in one bar">
</p>
<p align="center">
  <img src="screenshots/tui-menu.png" width="55%" alt="athena-tui — zero-dependency terminal client">
</p>
<p align="center">
  <em>Live captures — public pages only; no accounts, tokens, or private brains shown.</em>
</p>
<p align="center">
  <img src="screenshots/screenshot-2026-08-21_14-28-39.png" width="32%" alt="Athena app view">
  <img src="screenshots/screenshot-2026-08-21_14-28-56.png" width="32%" alt="Athena app view">
  <img src="screenshots/screenshot-2026-08-21_14-29-24.png" width="32%" alt="Athena app view">
</p>

## What it does

- Saves URLs, notes, code, text files, and self-hosted binary documents as searchable Markdown.
- Searches titles, URLs, notes, tags, and document content across the complete PostgreSQL corpus.
- Uses optional [Meilisearch](https://www.meilisearch.com/) as a fast derived index; PostgreSQL remains the source of truth and the fallback.
- Answers questions with retrieval-augmented context and source links.
- Supports OpenAI-compatible gateways, Anthropic, OpenRouter, OpenCode Zen, Groq, and local routers such as [OmniRoute](https://github.com/df4p/omniroute).
- Provides personal and community brains with rank-aware permissions, voting, reports, and Telegram group membership gates.
- Clones Telegram channels, groups, and individual forum topics into your brain — links, documents (pdf/epub/docx/…), and text posts — with GOD-rank targets (community / personal / both) and one-time history backfill.
- Grounds every AI answer in retrieved sources and rejects responses containing URLs outside your saved set.
- Includes a zero-build terminal UI for bookmark import and MCP-powered AI sessions.

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
| Search index | `MEILI_URL`, `MEILI_MASTER_KEY`, `MEILI_INDEX` | Optional Meilisearch accelerator; defaults to index `athena`. |
| JS scraping | `KAGE_BIN`, `KAGE_CHROME` | Optional [Kage](https://github.com/tamnd/kage) + Chrome/Chromium fallback. |
| Local Bot API | `TELEGRAM_API_BASE` | Optional self-hosted telegram-bot-api; lifts file cap 20 MB → 2 GB. |
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

- no user session string is required for live indexing;
- links, captions, documents (pdf/docx/epub/md/…), and text-only announcements are captured;
- video/audio/apk/archives are skipped by design;
- every insert is deduplicated — canonical URL hash per brain (community or personal), plus `chat_id + message_id` identity for channel documents, so replays and cross-posts never create duplicates.

Session mode is optional and self-host-only. It uses a Telegram user session to backfill older history with `/index_start`; the encrypted session is kept only for the job and removed when the job finishes or is stopped. Treat a session string like a password: it can grant access to the Telegram account that created it.

Athena accepts compatible Telethon/Pyrogram-style StringSession values for this bridge. It does not vendor or execute the full [Ultroid](https://github.com/TeamUltroid/Ultroid) userbot; Ultroid can remain a separate session generator/client if you already use one.

### Channels: full-copy indexing with rank-aware targets

Link any public or private channel; from then on every post is cloned into a brain automatically.

```text
/channel_link <community_id> <channel_id> [community|personal|both]
/channel_target <channel_id> <community|personal|both>   # GOD: switch later
/channel_unlink <channel_id>
```

| Target | Who can set | Where content lands |
| --- | --- | --- |
| `community` (default) | owner/GOD | the linked community brain |
| `personal` | **GOD only** | the linking GOD's personal brain |
| `both` | **GOD only** | both brains at once |

Requirements: the bot must be an **admin** of the channel. History backfill is separate (see below).

### Groups and forum topics

Groups work out of the box once bound with `/community_verify`: member links and supported files are saved to the community brain automatically (the bot must be able to read the chat — make it admin, or disable privacy mode via @BotFather).

**Full-copy mode** also captures text-only announcements:

```text
/group_copy on    # owner/GOD, inside the group
/group_copy off
```

**Forum topics** can be cloned individually — each topic gets its own binding and target:

```text
/topic_link <community_id> [community|personal|both]   # run inside the topic
/topic_list                                            # linked topics in this group
/topic_target <thread_id> <community|personal|both>    # GOD: switch target
/topic_unlink <thread_id>
```

New posts in a linked topic are indexed in real time; existing topic history is pulled in by the backfill below (pass the thread id as the last argument).

### History backfill (one-time, self-hosted)

Bots cannot read old messages. To clone everything already in a channel/group/topic, run a one-time backfill with your own session:

```bash
node scripts/gen-session.js   # on the server — prints a gramjs StringSession
```

Then in a **private bot DM**:

```text
/index_start <community_id> <chat_id> <api_id> <api_hash> <session_string> [thread_id]
```

- pass `thread_id` to clone a single forum topic instead of the whole chat;
- pacing honors Telegram flood-waits; progress every 300 messages (`/index_status`);
- `/index_stop` cancels; jobs resume from their cursor;
- the session is AES-GCM encrypted at rest (`STORAGE_KEY`) and auto-deleted when the job completes.

### Userbot mode: live cloning without adding the bot

Bot mode requires the bot to be an admin of each channel/group. **Userbot mode** removes that requirement: a Telegram *user account* (via session string) does the cloning, so any chat the account can read can be mirrored — including channels where adding bots is impossible.

```text
/userbot_connect <api_id> <api_hash> <session_string>   # GOD, bot DM, self-host
/userbot_follow <community_id> <chat_id> [community|personal|both]
/userbot_status
/userbot_unfollow <chat_id>
/userbot_disconnect    # stops the daemon and deletes the stored session
```

- generate the session with `node scripts/gen-session.js` (the account must already be a member of the chats you want to follow);
- followed chats clone **live** — links, documents (pdf/epub/…), and text posts — into the chosen target (`community` / `personal` / `both`, rank rules identical to channel targets);
- existing history: run `/index_start` for that chat once (optionally with `thread_id`);
- the session is AES-GCM encrypted at rest under `STORAGE_KEY`; `/userbot_disconnect` deletes it completely;
- self-hosted only (needs the persistent Node process; gramjs is bundled).

### Local Bot API server (2 GB files)

The cloud Bot API caps downloads at 20 MB. Run the bundled local server to lift it to 2 GB for live indexing and backups:

```bash
docker compose -f server/docker-compose.bot-api.yml up -d
# .env:
TELEGRAM_API_BASE=http://127.0.0.1:8081
```

Then move the webhook once: call `logOut` on the cloud API, restart Athena, and `setWebhook` against the local base (Athena's `telegramApi` calls follow `TELEGRAM_API_BASE` automatically; loopback/private addresses only).

### Exporting into the bot

Use `/export` for the complete setup guide. A Telegram export is normally imported in bot format through the TUI or `/index_start` workflow; it does not require changing the bot into a userbot. The bot’s normal link/document dump path remains available in both personal and community scopes.

Useful commands:

| Command | Purpose |
| --- | --- |
| `/help` | Detailed command menu and setup guidance. |
| `/search <query>` | Search only matching links/documents with page buttons. |
| `/ai <question>` | Ask the configured model over the active brain. |
| `/export` | Explain bot-mode export and optional session-history import. |
| `/channel_link <community_id> <channel_id> [target]` | Clone a channel; GOD may pick `personal`/`both`. |
| `/channel_target <channel_id> <target>` | GOD: switch where a channel lands. |
| `/channel_unlink <channel_id>` | Stop channel indexing. |
| `/group_copy on\|off` | Owner: full-copy text posts for this group. |
| `/topic_link <community_id> [target]` | Clone the forum topic you are in. |
| `/topic_list` / `/topic_target` / `/topic_unlink` | Manage topic bindings. |
| `/index` | Show indexing status and available backfill actions. |
| `/index_start ...` | Start optional self-hosted history backfill (optional `thread_id`). |
| `/index_status` / `/index_stop` | Inspect or cancel a backfill. |
| `/community_join <id>` | Join a community after joining its Telegram group. |
| `/personal` / `/community` | Switch the GOD user’s dump target. |
| `/delete <url>` | Delete a link, or reply to a saved link with `/delete`. |

`/search` is deliberately scoped: every page contains only results matching the query, and **Next page** loads the next matching slice before the close button. Unrelated recent bookmarks are never appended to the result list.

## Search index (Meilisearch, optional)

PostgreSQL is always the source of truth. For large brains, add [Meilisearch](https://www.meilisearch.com/) as a derived index — search and AI retrieval get sub-second candidate finding while PostgreSQL hydrates the authoritative rows:

```dotenv
MEILI_URL=http://127.0.0.1:7700
MEILI_MASTER_KEY=change-me-strong
MEILI_INDEX=athena
```

Writes mark scopes dirty and re-sync in the background; if Meili is slow, warming, or down, Athena silently falls back to complete PostgreSQL search. AI retrieval reports which engine served a query (`meilisearch+postgres` vs `postgres`).

## Duplicate protection

Every save path — website, bot DM, group, channel, topic, TUI batch — shares one identity rule: URLs are canonicalized (host lowercased, `www.` stripped, trailing slashes and fragments dropped) and hashed per brain. The database enforces uniqueness; the app reports friendly "already added" replies instead of errors. Channel documents additionally dedupe on `chat_id + message_id`, so Telegram redeliveries never double-store.

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

## Note on Discord

You will see a **Discord login** option in the UI. It is **not tested and not supported yet** — do not use it. Telegram login is the supported auth path.

## Roadmap

- [ ] **RSS support** — live indexing of RSS/Atom feeds with change tracking: new items land automatically, and edits/removals on the source site are reflected (content updated or removed from the DB) instead of leaving stale copies.
- [ ] **Android app** — fully based on `athena-tui`: the same menu-driven flows (login, connect instance, scan/dump bookmarks, search, AI) wrapped in a native mobile shell, sharing the TUI's zero-dependency logic.
- [ ] **Frontend polish** — further beautification of the web UI: richer result cards, smoother transitions, better mobile ergonomics, and more theme refinement.
- [ ] **Extensions (as needed)** — browser Web Clipper for one-click saves, and other integrations where they earn their place.

## Credits

Athena stands on the shoulders of these projects — their code and ideas are part of this codebase:

- [OpenCode](https://github.com/anomalyco/opencode) — the CLI agent harness; Athena's MCP integration and TUI advanced mode build on its patterns.
- [Kage](https://github.com/tamnd/kage) — headless-Chrome site cloner powering JS-rendered page scraping.
- [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) — Rust document converter (pdf/docx/pptx/xlsx/odt/rtf/epub → Markdown).
- [binthere](https://github.com/nxfu/binthere) — the TUI app whose wordmark, box menus, cursor, and spinner `athena-tui` is based on.
- [gramjs](https://github.com/gram-js/gramjs) — Telegram user-session client for history backfill.
- [Meilisearch](https://www.meilisearch.com/) — optional derived search index.
- [pgvector](https://github.com/pgvector/pgvector) — embedding similarity for paragraph-level document search.
- [aiogram/telegram-bot-api](https://github.com/aiogram/telegram-bot-api) — local Bot API server for 2 GB file support.

**Inspiration:** [Aaron Swartz](https://en.wikipedia.org/wiki/Aaron_Swartz) — his fight for open access to knowledge and his belief that information wants to be free are the reason this project exists. Long live.

## License

[CC BY-NC 4.0](LICENSE) — attribution required; commercial use requires separate permission.
