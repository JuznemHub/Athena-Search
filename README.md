# Athena Search

Your second brain for links, documents, Telegram messages, and grounded AI answers.

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.69-blueviolet?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/license-CC_BY--NC_4.0-blue?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/PostgreSQL-14%2B-336791?style=flat-square&logo=postgresql" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/Telegram-bot_%2B_userbot-26A5E4?style=flat-square&logo=telegram" alt="Telegram">
  <img src="https://img.shields.io/badge/MCP-standard_stdio-black?style=flat-square" alt="MCP">
</p>

<p align="center">
  <a href="#juznems-favourite-features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#web-directory-and-database-explorer">Wiki & Explorer</a> •
  <a href="#telegram-bot">Telegram Bot</a> •
  <a href="#terminal-ui">Terminal UI</a> •
  <a href="#model-context-protocol-mcp">MCP Guide</a> •
  <a href="#api-surface">API Reference</a>
</p>

Athena is a self-hostable bookmark and document archive. Save from the web UI, Telegram, the terminal, or a linked channel; search the whole database; and ask an AI model to answer with sources from your own collection.

<p align="center">
  <img src="screenshots/web-dark.png" width="70%" alt="Athena web — search, dump, and AI in one bar">
</p>
<p align="center">
  <img src="screenshots/tui-menu.png" width="55%" alt="athena-tui terminal client">
</p>
<p align="center">
  <em>Live captures — public pages only; no accounts, tokens, or private brains shown.</em>
</p>

> ⭐ **Like Athena?** [Star the repo](https://github.com/JuznemHub/Athena-Search/stargazers) and test it out extensively — real usage is what makes it better.
>
> 🐛 **Found a bug?** [Open an issue](https://github.com/JuznemHub/Athena-Search/issues/new?template=bug_report.md) with: what you did, what you expected vs what happened, exact steps to reproduce, relevant logs (`journalctl -u athena -n 100` on self-host, or browser console output), a screenshot/photo if it's visual, and your setup (self-host/Cloudflare, OS, Node version). Reports missing these take far longer to fix.
>
> 💬 **Need help?** Join the community chat → [@Juznem discussion group on Telegram](https://t.me/Juznem)

## Juznem's favourite features

- **📚 Dump all your browser bookmarks straight into Athena via the TUI** — Chrome, Chromium, Edge, Brave, Opera, Vivaldi, Arc and Firefox are detected automatically; scan, pick folders, and dump everything into your personal or community brain from the terminal. No export-file gymnastics.
- **🐦 Reddit & X (x.com) bookmark imports** — Import saved posts, bookmarks, and likes from Reddit (via [Reddit-Fetch](https://github.com/akashpandey/Reddit-Fetch)) and X (x.com / Twitter official archive or [TweetNook](https://github.com/GezerWezer/TweetNook) export) directly into your brain. Outside links in posts become distinct bookmarks, and the TUI setup remembers your paths for future syncs.
- **🧠 Model Context Protocol (MCP) server for any agent** — Wire your second brain into Claude Code, Hermes, Codex, Cursor, or any MCP host: grounded semantic search, paragraph-level chunk lookups (`para_idx`), citations with `[#n]`, and rank-scoped access. Press `Tab` in the TUI or run `node tui/src/mcp-athena.js --config`.
- **🗂️ Wiki directory & database explorer** — Browse your collection as an interactive catalog with auto-grouped categories, global tag clouds, and public shareable wiki links. Administer the database directly with inline editing, `#notags` filtering, and audit history.
- **🏠 Self-host it for yourself — or run your own Telegram community** — full control end-to-end: PostgreSQL storage, your own bot, rank hierarchy (GOD / owner / admin / member), approve whom to add, kick/ban with automatic sync to Telegram group presence, per-community brains, backups to Telegram, and GOD-only switches like AI credentials and channel targets.
- **📡 Live cloning of any Telegram channel, group — even a single forum topic** — powered by a userbot session or a linked bot: links, documents (pdf/epub/docx/…), button links, and text posts land in your brain automatically, with GOD-rank targets (community / personal / both), one-command history backfill by id range or topic, a VPS media vault, per-session rollback, and honest live progress bars.
- *…and much more:* pgvector paragraph search, multi-agent MCP memory, streaming AI answers grounded in your own sources, themes, accent colors, and a zero-build frontend.

## What it does

- Saves URLs, notes, code, text files, and self-hosted binary documents as searchable Markdown.
- Searches titles, URLs, notes, tags, and document content across PostgreSQL with full-text indexing and pgvector embeddings.
- Answers questions with retrieval-augmented context and source links.
- Supports OpenAI-compatible gateways, Anthropic, OpenRouter, Groq, and local routers such as [OmniRoute](https://github.com/df4p/omniroute).
- Exposes a native Model Context Protocol (MCP) server so AI agents (Claude Code, Hermes, Codex, Cursor) can query your saved collection.
- Imports bookmarks from 8+ desktop browsers, Reddit saved posts, and X (x.com) archives via a terminal UI.
- Interactive wiki directory layout with live database synchronization and public shareable links.
- Database explorer view with inline editing, tag aggregation, and `#notags` filtering.
- Provides personal and community brains with rank-aware permissions, voting, reports, and Telegram group membership gates.
- In community scope, startup restores your saved community or selects the first available one. Tag searches use that selection; missing access or failed searches show an error instead of leaving loading cards on screen.
- Clones Telegram channels, groups, and individual forum topics into your brain — links, documents (pdf/epub/docx/…), and text posts — with GOD-rank targets (community / personal / both) and one-time history backfill.
- Grounds every AI answer in retrieved sources and rejects responses containing URLs outside your saved set.

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
| JS scraping | `CHROME_BIN` | Optional headless Chromium fallback for JavaScript-rendered pages. |
| Local Bot API | `TELEGRAM_API_BASE` | Optional self-hosted telegram-bot-api; lifts file cap 20 MB → 2 GB. |
| AI | `OPENROUTER_API_KEY` or settings UI | Credentials are stored server-side and never returned to normal users. |

## Search and AI

PostgreSQL is the single source of truth for all search operations. Queries run directly against PostgreSQL full-text search indexes (`tsvector`), combined with `pgvector` embeddings for paragraph-level document lookup (`athena_get_chunk`).

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

## Web directory and database explorer

Athena includes an interactive frontend that serves as both a curated knowledge directory and an administrative database manager:

- **Wiki directory**: an interactive directory catalog that dynamically groups your links by category (Dev, Media, Tools, Reading) and ecosystem based on the taxonomy classifier, updating as new links land. Public shareable links can be generated for community brains.
- **Database explorer**: an administrative interface to search, filter, and inspect links across the entire database. Features include global tag frequency clouds, `#notags` filtering to locate unclassified items, inline title/description/tag editing, and a manual tag lock (`manual_edited_at`) to preserve custom changes from automated scrapers.

## Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. DM it `/id` to obtain your Telegram user ID.
3. In Athena, open **Settings → Bot**, enter the token and owner ID, and verify it.
4. Add the bot to a group and run `/community_verify` to create or bind a community.

### Bot mode and session mode

Bot API mode is the default and safest mode:

- no user session string is required for live indexing;
- links, captions, documents (pdf/docx/epub/md/…), and text-only announcements are captured;
- video is excluded; full-copy channel/topic/group capture also stores photos, audio and other non-video files;
- every insert is deduplicated — canonical URL hash per brain (community or personal), plus `chat_id + message_id` identity for channel documents, so replays and cross-posts never create duplicates.

Userbot mode is optional and self-host-only. It uses a saved Telegram user session (see `/userbot_add`) to backfill older history and keep indexing new posts. Treat a session string like a password: it can grant access to the Telegram account that created it.

Athena accepts compatible Telethon/Pyrogram-style StringSession values for this bridge. It does not vendor or execute an external userbot framework; any standard session generator works.

### Channels: full-copy indexing with rank-aware targets

Link any public or private channel; from then on every post is cloned into a brain automatically. One command does it all — it links when the bot is an admin there, otherwise it backfills history with your userbot account:

```text
/clone <community_id> <channel_id> [thread_id] [bot|userbot] [community|personal|both]
/clone <channel_id>     # inspect: where it saves (bot link, userbot follow, or nothing)
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
/topic_link [community_id] [community|personal|both]   # run inside the topic
/topic link                                            # same command, the spelling people reach for
/topic_list                                            # linked topics in this group
/topic_unlink [thread_id]
# (re-running /topic_link inside the topic with a new target re-routes it)
```

New posts in a linked topic are indexed in real time; existing topic history is pulled in by the backfill below (pass the thread id as the last argument).

For the guided Bot API flow, run `/clone` inside the linked group. Confirming `/clone` enables live copying without a userbot: omit the topic id to cover the group and all topics, or pass a topic id (or run it inside that topic) to bind one forum topic. The Bot API still cannot read earlier history; use `/clone <community_id> <chat_id>` (userbot path, same command) or `/uclone` for history.

### History backfill (one-time, self-hosted)

Bots cannot read old messages. To clone everything already in a channel/group/topic, first connect a userbot account once (`/userbot_add`), then run one command from anywhere:

```text
/clone <community_id> <chat_id> [thread_id] [bot|userbot] [community|personal|both]
```

- pass `thread_id` to clone a single forum topic instead of the whole chat;
- starting the backfill subscribes the chat (or the single topic) for live indexing under the same account — history and live follow-up come from one command;
- pacing honors Telegram flood-waits; progress every 300 messages (`/status`, or `/status all` for every user's jobs);
- stop anytime from the ⏹ button beside the source on `/stats`; jobs resume from their cursor;
- no per-command session strings: the account lives encrypted on the server.

### Managed userbot mode: persistent accounts and the clone wizard

Self-hosted Athena keeps a persistent account store and an interactive wizard in the bot DM:

```text
/userbot_add <label> <api_id> <api_hash> <session_string>  # save an encrypted account
/userbot_accounts                                          # list, select, re-authenticate, remove
/userbot_select                                            # pick the account future clones use
/uclone <chat_id>          # scan a channel/group, preview exact statistics, pick a destination
/ubclone <chat_id>         # alias for the same managed wizard
/userbot_status            # accounts, follows, backfill progress
```

The destination picker is intentionally explicit: `Personal` is the private brain; each authorized community is shown as `<community name> — community DB`, with a separate `Personal + community` option. Topic statistics and clone completion both include Back so another topic can be selected without rescanning the source.

`/stats` provides a paginated dashboard across every cloned source (5 sources per page with navigation and quick refresh). A source displays `🟢 LIVE CLONING: ON` while an active capture path exists (linked channel, whole-group copy, or active userbot follow). Drilling into any source shows isolated latest links, topic-scoped metrics, encountered preview counts vs saved database rows, and a stop button (`⏹`) for live jobs. Every finished clone automatically subscribes for live indexing under the account that ran it; switching active accounts in `/userbot_accounts` migrates your follows. `/userbot_status` is a userbot health dashboard that summarizes account state and collapses duplicate session errors.

- every saved session is AES-GCM encrypted at rest (`STORAGE_KEY`); credentials typed into a command are never logged;
- `/uclone` scans the accessible history first (it never guesses totals it cannot measure), shows per-topic statistics, then asks where to copy: your personal brain, one of your communities, or both (combined destinations copy to both brains);
- forum groups list their topics with pagination (more than 100 topics work); choosing "All topics, sequentially" clones topic by topic, one live progress card;
- videos are excluded by design; links, documents (pdf/epub/md/…), images and audio are cloned with per-message provenance, so re-cloning the same source never duplicates rows;
- a failed item is recorded and cloning continues; Telegram flood-waits are honored; interrupted jobs resume from their cursor after restart;
- `/status [all]` lists backfill jobs with their ids; `/delete` opens a picker (one link, one cloned chat, one backfill session — each with confirm).
- `/stats` reads persisted run and per-message checkpoints and shows dashboard totals before the per-run detail. Preview counts describe encountered content; saved counters describe successful writes.
- URL search returns the original source post, including the other URLs in that message. Source bodies, entity offsets and reply metadata are preserved separately from canonical URL rows.

### Dokploy control and runtime logs

GOD users can manage Dokploy applications and inspect logs directly from Telegram:

```text
/dok apps                # list Dokploy applications (project.all)
/dok status [app]        # container state and last deployment status
/dok logs [app] [n]      # live container runtime logs
/dok buildlogs [app] [n] # last deployment build output
/dok deploy [app]        # queue fresh deployment of latest commit
/dok redeploy [app]      # rebuild and redeploy
/dok restart [app]       # restart container without rebuilding
/dok stop [app]          # stop container
/dok start [app]         # start container
/log [n]                 # process buffer log tail
/log --json [n]          # structured JSON records
```

Configure `DOKPLOY_URL`, `DOKPLOY_API_KEY` and optionally `DOKPLOY_APP_ID` in `.env`. Deploy and redeploy requests confirm acceptance; follow `/dok buildlogs` and verify `/dok status` to confirm completion.

For continuous agent consumption, use an authenticated GOD session with `GET /api/logs?source=app&tail=100&follow=1`. For Dokploy, select `source=container` or `source=deployment` and `app=<application_id>`.

### Local Bot API server (2 GB files)

The cloud Bot API caps downloads at 20 MB. Run the bundled local server to lift it to 2 GB for live indexing and backups:

```bash
docker compose -f server/docker-compose.bot-api.yml up -d
# .env:
TELEGRAM_API_BASE=http://127.0.0.1:8081
```

Then move the webhook once: call `logOut` on the cloud API, restart Athena, and `setWebhook` against the local base (Athena's `telegramApi` calls follow `TELEGRAM_API_BASE` automatically; loopback/private addresses only).

### Exporting into the bot

Use `/export` for the complete setup guide. A Telegram export is normally imported in bot format through the TUI or `/clone` workflow; it does not require changing the bot into a userbot. The bot’s normal link/document dump path remains available in both personal and community scopes.

Useful commands:

| Command | Purpose |
| --- | --- |
| `/help` | Detailed command menu and setup guidance. Long panels are paginated and every page carries section buttons. |
| `/search <query>` | Search only matching links/documents with page buttons. |
| `/ai <question>` | Ask the configured model over the active brain. |
| `/export` | Explain bot-mode export and optional session-history import. |
| `/clone <community_id> <channel_id> [thread_id] [bot|userbot] [target]` | Clone a channel or chat: bot link when the bot is admin there, else userbot history + live follow-up (re-run to re-route). |
| `/clone <chat_id>` | Inspect where a chat saves (bot link, userbot follow, or nothing). |
| `/group_copy on|off` | Owner: full-copy text posts for this group. |
| `/topic_link [community_id] [target]` | Clone the forum topic you are in (re-run to re-route). The community id defaults to this group's; `/topic link` is the same command. |
| `/topic_list` / `/topic_unlink` | List or remove topic bindings. |
| `/status [all]` | What is indexing right now plus running and recent backfill jobs; `all` lists every user's jobs (GOD). Stopping happens from the ⏹ button on `/stats`. |
| `/community_join <id>` | Join a community after joining its Telegram group. |
| `/clone [topic_id] [community|personal|both]` | Owner/GOD: inside a linked group, preview and confirm Bot API live indexing for the whole group or one forum topic; no userbot and no old-history access. |
| `/stats` | Dashboard totals across every cloned source with a ⏹ stop button per live row, per-source drill-downs, live state and a refresh control. |
| `/userbot_status` | GOD, DM only: show account identity, actual connection state, saved userbot follows, backfill/topic progress and recent normalized errors. |
| `/uclone <chat_id>` | GOD: clone a channel/group via the account wizard (personal/community/both); confirming the destination subscribes the live follow, and switching accounts later moves it along. |
| `/personal` / `/community` | Switch the GOD user’s dump target. |
| `/delete` | Picker (one link, one cloned chat, one backfill session — each with confirm); `/delete <url>` removes a link, `/delete <chat_id> [thread_id]` a whole clone. |
| `/dok <command> [app]` | GOD: Dokploy control (`apps`, `status`, `logs`, `buildlogs`, `deploy`, `redeploy`, `restart`, `stop`, `start`). |
| `/log [n]` | GOD: inspect runtime process buffer logs; add `dokploy` or `buildlogs` for container logs. |

`/search` is deliberately scoped: every page contains only results matching the query, and **Next page** loads the next matching slice before the close button. Unrelated recent bookmarks are never appended to the result list.

## Duplicate protection

Every save path — website, bot DM, group, channel, topic, TUI batch — shares one identity rule: URLs are canonicalized (host lowercased, `www.` stripped, trailing slashes and fragments dropped) and hashed per brain. The database enforces uniqueness; the app reports friendly "already added" replies instead of errors. Channel documents additionally dedupe on `chat_id + message_id`, so Telegram redeliveries never double-store.

## Scraping

Every saved URL is first handled by Athena’s normal safe fetch and extractor. GitHub, GitLab, Reddit, and common forge pages have dedicated metadata paths. If a page is JavaScript-rendered and the static result is too thin, self-hosted Athena can render it with a real headless Chromium and read the DOM:

```bash
chromium --headless=new --no-sandbox --disable-gpu --dump-dom https://example.com
```

Configure the binary explicitly when needed (otherwise Athena tries `chromium`, `chromium-browser`, `google-chrome`, then `google-chrome-stable`):

```dotenv
CHROME_BIN=/usr/bin/chromium
```

Chromium is optional. If it is missing, disabled, or fails, Athena keeps the safe static metadata fallback. The `railpack.json` in the repository installs `chromium` for Railpack deployments.

## Terminal UI

[`athena-tui`](tui/README.md) is a CLI client for scanning and importing your bookmarks and archives directly into Athena. npm installs its MCP SDK and PostgreSQL client dependencies.

```bash
npm install -g athena-tui
athena-tui
```

```text
                                    ✦
                   █▀█ ▀█▀ █ █ █▀▀ █▄ █ █▀█  ▄▀▀ █▀▀ █▀█ █▀▄ ▄▀▀ █ █
                   █▄█  █  █▀█ █▀  █ ▀█ █▄█  █▄▄ █▀  █▄█ █▀▄ █   █▀█
                   ▀ ▀  ▀  ▀ ▀ ▀▀▀ ▀  ▀ ▀ ▀  ▀▀▀ ▀▀▀ ▀ ▀ ▀▀  ▀▀▀ ▀ ▀
              search your second brain · dump your bookmarks · ai answers
                                 server  not connected

              ╭─ actions ────────────────────────────────────────────────╮
              │ ❯ 1 Login with Telegram         not logged in            │
              │   2 Connect instance            not connected            │
              │   3 Join community              not joined               │
              │   4 Scan bookmarks              not scanned              │
              │   5 Import social (Reddit/X)    not imported             │
              │   6 Dump bookmarks                                       │
              │   7 Advanced (MCP)              MCP config for any agent │
              │   8 Status                                               │
              │   9 Quit                                                 │
              ╰──────────────────────────────────────────────────────────╯
               ╭───────────────────────────────────────────────────────╮
               │ ↑↓ move · ↵ select · 1-9 jump · Tab advanced · q quit │
               ╰───────────────────────────────────────────────────────╯
```

### Browser and social imports

- **Browser bookmarks**: auto-detects profiles across Chrome, Chromium, Edge, Brave, Opera, Vivaldi, Arc, and Firefox (`places.sqlite` read via `node:sqlite`), including Flatpak and Snap installations. Custom roots can be supplied via `ATHENA_BOOKMARK_ROOTS`.
- **Reddit saved posts**: guided setup integrates with [Reddit-Fetch](https://github.com/akashpandey/Reddit-Fetch), handling OAuth and parsing `saved_posts.json` or `.html`. Posts are automatically tagged `#reddit` and `#r-<subreddit>`.
- **X (x.com / Twitter) archives**: reads official Twitter archive directories (`data/tweets.js`, `data/like.js`) or [TweetNook](https://github.com/GezerWezer/TweetNook) JSON exports. External links in tweets are saved as distinct entries, while text-only posts and likes save as links to the tweet tagged `#x`.
- **Path persistence**: verified paths are saved in `~/.config/athena-tui/config.json` so subsequent syncs run without re-prompting. Headless or scripted environments can set `REDDIT_EXPORT_PATH`, `X_ARCHIVE_PATH`, or `TWEETNOOK_EXPORT_PATH`.

## Model Context Protocol (MCP)

Athena runs a native Model Context Protocol (MCP) stdio server, connecting your brain directly to AI agent hosts like Claude Code, Hermes, Codex, Cursor, and Antigravity.

### Capabilities and tools

- `athena_search` — search personal and community collections using hybrid full-text and semantic matching, with domain and tag filters.
- `athena_get_chunk` — paragraph-level retrieval (`para_idx`) to pull exact context blocks from long-form documents and PDFs.
- `athena_list_sources` — inspect indexed channels, groups, and collections.

### Agent configuration

Run `node tui/src/mcp-athena.js --config` or select **Advanced (MCP)** (or press `Tab`) in the TUI to print your configuration snippet.

Example configuration for Claude Code or desktop MCP clients:

```json
{
  "mcpServers": {
    "athena": {
      "command": "node",
      "args": ["/path/to/Athena-Search/tui/src/mcp-athena.js"],
      "env": {
        "ATHENA_INSTANCE": "https://athena.example.org",
        "ATHENA_TOKEN": "your_session_token"
      }
    }
  }
}
```

Ranks apply: `personal` collection access requires GOD rank, while community collections are accessible to active members.

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
| GET | `/api/links/search` | Whole-corpus scoped PostgreSQL search. |
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

## Roadmap

- [ ] **RSS support** — live indexing of RSS/Atom feeds with change tracking: new items land automatically, and edits/removals on the source site are reflected (content updated or removed from the DB) instead of leaving stale copies.
- [ ] **Android app**: fully based on `athena-tui`, with the same menu-driven flows (login, connect instance, scan/dump bookmarks, search, AI) wrapped in a native mobile shell, sharing the TUI's logic.
- [ ] **Frontend polish** — further beautification of the web UI: richer result cards, smoother transitions, better mobile ergonomics, and more theme refinement.
- [ ] **Extensions (as needed)** — browser Web Clipper for one-click saves, and other integrations where they earn their place.

## Credits

Athena stands on the shoulders of these projects — their code and ideas are part of this codebase:

- [modelcontextprotocol](https://modelcontextprotocol.io/) — open specification for AI agent context and memory.
- [@firecrawl/anydoc](https://github.com/firecrawl/anydoc) — Rust document converter (pdf/docx/pptx/xlsx/odt/rtf/epub → Markdown).
- [binthere](https://github.com/nxfu/binthere) — the TUI app whose wordmark, box menus, cursor, and spinner `athena-tui` is based on.
- [Reddit-Fetch](https://github.com/akashpandey/Reddit-Fetch) — Reddit saved post extraction for terminal imports.
- [TweetNook](https://github.com/GezerWezer/TweetNook) — X archive export format and parsing.
- [gramjs](https://github.com/gram-js/gramjs) — Telegram user-session client for history backfill.
- [pgvector](https://github.com/pgvector/pgvector) — embedding similarity for paragraph-level document search.
- [aiogram/telegram-bot-api](https://github.com/aiogram/telegram-bot-api) — local Bot API server for 2 GB file support.

**Inspiration:** [Aaron Swartz](https://en.wikipedia.org/wiki/Aaron_Swartz) — his fight for open access to knowledge and his belief that information wants to be free are the reason this project exists. Long live.

## License

[CC BY-NC 4.0](LICENSE) — attribution required; commercial use requires separate permission.
