# Athena — Second Brain Search

One bar: search, dump, and AI answers from your markdown brain.

<p align="center">
  <img src="https://img.shields.io/badge/version-6.18-blueviolet?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/license_CC_BY--NC_4.0-blue?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/telegram-bot-blue?style=flat-square&logo=telegram" alt="telegram">
  <img src="https://img.shields.io/badge/discord-bot-5865F2?style=flat-square&logo=discord" alt="discord">
</p>

---

## Table of contents

- [Features](#features)
- [UI themes and accent colors](#ui-themes-and-accent-colors)
- [Ranks and access control](#ranks-and-access-control)
- [Personal mode vs community mode](#personal-mode-vs-community-mode)
- [Communities](#communities)
- [Install path A — Cloudflare](#install-path-a--cloudflare)
- [Install path B — self-hosted PostgreSQL](#install-path-b--self-hosted-postgresql)
- [Storage backends](#storage-backends)
- [GitHub storage setup](#github-storage-setup)
- [Backend URL configuration](#backend-url-configuration)
- [Document upload](#document-upload)
- [AI configuration](#ai-configuration)
- [Telegram bot setup](#telegram-bot-setup)
- [Bot commands](#bot-commands)
- [API endpoints](#api-endpoints)
- [Architecture](#architecture)
- [A note](#a-note)
- [License](#license)

---

## Features

**Links and documents**
- Save links via the web UI, Telegram bot, or Discord bot
- Upload text files (.md, .py, .js, .json, .yaml, .sql, .go, .rs, and 30+ more)
- Personal mode (GOD rank only) and community mode (shared with members)
- Upvote, downvote, and report links in community mode
- Inline editing of titles, URLs, and descriptions

**Search**
- Fuzzy search across titles, URLs, notes, and tags
- Documents included in search results alongside links
- Server-side search for large brains (whole corpus, not just loaded slice)
- Supports typos, partial matches, and synonym expansion (yt-dlp ↔ youtube-dl)

**AI**
- RAG over your saved links and uploaded documents
- Multiple providers: OpenAI, Anthropic, Groq, OpenRouter, OpenCode Zen
- Streaming responses with collapsible thinking blocks
- Conversation history with follow-up questions
- Configurable per-instance (GOD sets credentials, all ranks use them)

**Telegram bot**
- Rich HTML formatting on all outputs (bold, code, links, italic)
- `/search`, `/ai`, `/rank`, `/db`, `/sync`, `/backup` commands
- File uploads: send .md/.txt/.json etc → saved to active scope
- Community verification and management
- Inline keyboards for backup destination selection
- Topic locking for forum groups

**Storage backends**
- Cloudflare D1 (default, zero config)
- GitHub Markdown (your data as files in your repo)
- PostgreSQL (self-hosted, recommended for production)
- Sync between D1 and GitHub via `/sync` command or website

**Authentication**
- Telegram OAuth + Mini App login
- Discord OAuth
- Session-based auth with 30-day expiry
- Telegram CloudStorage for Mini App session persistence

---

## UI themes and accent colors

Athena ships with 4 distinct UI themes:

| Theme | Description |
|-------|-------------|
| **Dark** | Rich dark background with vibrant accent glows |
| **Light** | Clean white with subtle shadows |
| **Material** | Material Design 3 surface tones, elevation, no blur |
| **Glass** | iOS/macOS vibrancy with strong blur effects |

**Accent color picker** — Settings → Accent Color. Pick any color — buttons, glows, backgrounds, borders, and highlights all update instantly. 12 preset swatches + free-form color input. Persists in localStorage.

<p>
<img src="screenshots/dark-purple.svg" width="24%" alt="Dark Purple">
<img src="screenshots/dark-blue.svg" width="24%" alt="Dark Blue">
<img src="screenshots/dark-green.svg" width="24%" alt="Dark Green">
<img src="screenshots/dark-pink.svg" width="24%" alt="Dark Pink">
</p>
<p>
<img src="screenshots/glass-purple.svg" width="24%" alt="Glass Purple">
<img src="screenshots/material-blue.svg" width="24%" alt="Material Blue">
<img src="screenshots/light-green.svg" width="24%" alt="Light Green">
<img src="screenshots/material-pink.svg" width="24%" alt="Material Pink">
</p>

---

## Ranks and access control

| Rank | Who | Personal brain | AI | Bot settings | Delete links | Upload docs |
|------|-----|---------------|-----|--------------|--------------|-------------|
| **GOD** | Instance host (`TG_OWNER_IDS`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Owner** | Community creator (`/community_verify`) | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Admin** | Promoted with `/admin` | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Member** | After login + join TG group + `/community_join` | ❌ | ✅ | ❌ | ❌ | ✅ |
| **Banned** | Left/kicked from TG group | ❌ | ❌ | ❌ | ❌ | ❌ |

- GOD is determined by `TG_OWNER_IDS` and `DISCORD_OWNER_IDS` environment variables
- Empty owner lists → every logged-in user is GOD (self-host convenience)
- Bans are per-community: banned from one community does not affect others
- Live Telegram presence sync: leaving the group auto-bans, rejoining auto-unbans

---

## Personal mode vs community mode

**Personal mode** (GOD rank only)
- Your private brain — only you can see, search, and ask AI about it
- Links and documents stored under your user ID
- Switch with `/personal` in bot or toggle on website

**Community mode** (all ranks)
- Shared brain for a Telegram group / community
- All members can dump, search, and use AI
- Links and documents stored under the community ID
- Switch with `/community` in bot or toggle on website

**Dual mode in DMs**: After linking a bot, `/personal` and `/community` switch where links go when you paste URLs in the bot DM. In groups, everything goes to the community brain.

---

## Communities

**Creating a community**
1. Add your bot to a Telegram group
2. Bot owner runs `/community_verify` in the group
3. A community is created with the group title as its name
4. Bot owner becomes the owner; they can promote admins with `/admin`

**Joining a community**
1. Login on the website with Telegram
2. Join the Telegram group
3. DM the bot: `/community_join <community_id>`
4. Get the community ID from `/community_list` or the website

**Community management**
- `/admin` — reply to a user to promote them to admin
- `/demote` — demote an admin back to member
- `/clear @user` — remove a member (they can rejoin)
- `/community_delete <id>` — wipe community + all data (owner/GOD only)
- `/clear_db <id>` — wipe links only, keep community and members

---

## Install path A — Cloudflare

Best for: quick start, zero infrastructure, free tier.

```bash
# Clone
git clone https://github.com/JuznemHub/Athena-Search.git
cd Athena-Search/worker

# Configure
cp ENV.example .env
# Edit .env with your Cloudflare account_id, Telegram/Discord secrets

# Deploy
npx wrangler deploy
```

**Wrangler.toml** configures:
- D1 database binding
- Static assets from `public/`
- Environment variables (Telegram/Discord client IDs, owner IDs)
- Secrets (set via `wrangler secret put`): `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`

**Webhook setup** (for Telegram bot):
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/api/telegram-webhook&secret_token=<WEBHOOK_SECRET>"
```

---

## Install path B — self-hosted PostgreSQL

Best for: production, full control, own database.

```bash
# Prerequisites: Node.js 22+, PostgreSQL 14+

# Clone
git clone https://github.com/JuznemHub/Athena-Search.git
cd Athena-Search

# Install
npm install

# Configure
cp server/.env.example .env
# Edit .env: DATABASE_URL, TELEGRAM_*, TG_OWNER_IDS, etc.

# Run
node server/index.js
```

**Environment variables** (`.env`):
```bash
DATABASE_URL=postgresql://athena:password@localhost:5432/athena
PORT=8787
TG_OWNER_IDS=your_telegram_user_id
TELEGRAM_CLIENT_ID=your_telegram_app_id
TELEGRAM_CLIENT_SECRET=your_telegram_app_secret
TELEGRAM_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_discord_app_id
DISCORD_CLIENT_SECRET=your_discord_app_secret

# Optional: backups
BACKUP_INTERVAL_HOURS=6
GDRIVE_CLIENT_ID=your_google_client_id
GDRIVE_CLIENT_SECRET=your_google_secret
GDRIVE_REFRESH_TOKEN=your_refresh_token
GDRIVE_FOLDER_ID=your_drive_folder_id
```

**Reverse proxy** (Caddy example in `server/Caddyfile.example`):
```
athena.yourdomain.com {
    reverse_proxy localhost:8787
}
```

**Systemd service** (example in `server/athena.service.example`)

---

## Storage backends

| Backend | How it works | When to use |
|---------|-------------|-------------|
| **Cloudflare D1** | Links stored in D1 (SQLite). Reads/writes go directly to D1. | Quick start, free, zero config |
| **GitHub Markdown** | Links stored as .md files in your repo. D1 acts as read cache (auto-synced). | Data ownership, version history |
| **PostgreSQL** | Links stored in your own Postgres database. | Production, self-hosted |

**GitHub storage (optional)**

When GitHub is the active provider:
- All reads go to GitHub (synced to D1 cache for speed)
- All writes go to GitHub AND D1 (keeps cache fresh)
- D1 is a transparent cache — you never interact with it directly
- GitHub is the source of truth

When D1 is the active provider:
- All reads/writes go to D1
- GitHub is not used at all
- You can manually sync D1 → GitHub with `/sync` or website "Push to GitHub"

**Setting up GitHub storage**:
1. Create a GitHub repo (e.g., `yourname/athena-brain`)
2. Generate a personal access token with `repo` scope
3. Website → Settings → Storage → GitHub
4. Enter repo (`owner/repo`), branch (`main`), token
5. Click Save → verify connection

**Sync** (D1 ↔ GitHub, bidirectional):
- Website: Settings → Storage → "Push existing links to GitHub"
- Bot: `/sync` (GOD only)
- Merges both stores: links from D1 go to GitHub, links from GitHub go to D1
- After sync, both stores are identical
- Works regardless of which is the active provider

---

## GitHub storage setup

1. Create a GitHub repo (e.g., `yourname/athena-brain`)
2. Generate a personal access token with `repo` scope
3. Website → Settings → Storage → GitHub
4. Enter repo (`owner/repo`), branch (`main`), token
5. Click Save → verify connection
6. Existing D1 data can be pushed with "Sync" button

Data layout in GitHub:
```
brain/
  personal/
    user123/
      link1.md
      link2.md
  communities/
    c_abc123/
      link3.md
      link4.md
documents/
  personal/
    user123/
      doc-id--filename.md
  communities/
    c_abc123/
      doc-id--filename.md
```

---

## Backend URL configuration

For self-hosted backends with Cloudflare frontend:

1. Set `ATHENA_FRONTEND_URL` on the self-hosted server (e.g., `https://athena.pages.dev`)
2. Website → Settings → Backend → enter your self-hosted URL
3. GOD clicks "Set backend for everyone"
4. All browsers now use the self-hosted API

The backend URL is stored per-instance (on the Cloudflare origin), so every visitor uses the same backend.

---

## Document upload

**Supported formats**: .md, .txt, .py, .js, .ts, .jsx, .tsx, .sh, .bash, .css, .html, .json, .yaml, .yml, .toml, .xml, .csv, .sql, .go, .rs, .java, .c, .h, .cpp, .rb, .php, .swift, .kt, .lua, .r, .dart, .vue, .svelte, .ini, .cfg, .conf, .env, .log

**Limits**: 512 KB per file, must be text (not binary)

**Website**: Dump mode → Upload text button → select files

**Bot**: Send/forward a file to the bot
- In groups: saved to community brain
- In DMs: saved to active scope (personal or community)
- Also writes to GitHub if GitHub storage is configured

---

## AI configuration

**Setting up AI** (GOD rank):
1. Website → Settings → AI assistant
2. Select provider (OpenAI, Anthropic, Groq, OpenRouter, OpenCode Zen, or Custom)
3. Enter API base URL, model, and API key
4. Click Save AI config
5. This syncs to the server so both website and bot `/ai` use the same credentials

**Supported providers**:
| Provider | Base URL | Model example |
|----------|----------|---------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-20250514` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| OpenCode Zen Go | `https://opencode.ai/zen/go/v1` | `deepseek-v4-flash` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `deepseek-v4-flash` |

**How AI works**:
1. Your question is matched against saved links and documents using fuzzy search
2. Top matches are injected as context into the system prompt
3. LLM generates an answer grounded in your brain data
4. Sources are listed below the answer

---

## Telegram bot setup

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → get token
2. Website → Settings → Bot → paste token + your DM `/id`
3. Click "Verify & save bot"
4. For groups: add bot to group → `/community_verify`

**Getting your DM /id**: DM the bot → send `/id` → it replies with your user ID

**Forum topic support**: Run `/id` in a topic to get the topic ID, then `/topic <id>` to lock the bot to that topic only.

---

## Bot commands

### Global (all ranks)
| Command | Description |
|---------|-------------|
| `/start` | Welcome message and status |
| `/help` | Command menu with categories |
| `/id` | Chat ID, your user ID, topic ID |
| `/rank` | Your ranks across all communities |
| `/db` | Show storage backend info |

### Search and AI (all ranks)
| Command | Description |
|---------|-------------|
| `/search <query>` | Search active brain |
| `/ai <question>` | AI over brain context |

### Personal (GOD only)
| Command | Description |
|---------|-------------|
| `/personal` | Switch dump mode to personal |
| `/community` | Switch dump mode to community |
| `/mode` | Show current dump mode |
| `/clear_personal_db` | Wipe personal links |

### Community (members+)
| Command | Description |
|---------|-------------|
| `/community_join <id>` | Join a community |
| `/community_list` | List your communities |
| `/community_list <id>` | Community details |

### Staff (admin/owner/GOD)
| Command | Description |
|---------|-------------|
| `/delete <url>` | Delete a link (or reply `/delete`) |
| `/edit <url> \| notes: ...` | Edit link description |
| `/admin` | Reply to user → promote admin |
| `/demote` | Demote admin to member |
| `/clear @user` | Remove member (can rejoin) |
| `/topic <id>` | Lock bot to forum topic |
| `/topic off` | Remove topic lock |
| `/dumpall on/off` | Multi-link mode |

### Owner/GOD only
| Command | Description |
|---------|-------------|
| `/community_verify` | Link group to community |
| `/community_delete <id>` | Wipe community + data |
| `/clear_db <id>` | Wipe links only |
| `/sync` | Sync D1 ↔ GitHub |
| `/backup` | Trigger backup (self-hosted) |

### File uploads
Send or forward any supported text file → saved to active scope.

---

## API endpoints

### Public (no auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check, version, features |
| GET | `/api/auth/config` | OAuth provider status |
| GET | `/api/auth/telegram` | Start Telegram OAuth |
| GET | `/api/auth/telegram/callback` | Telegram OAuth callback |
| POST | `/api/auth/telegram/webapp` | Telegram Mini App auth |
| GET | `/api/auth/discord` | Start Discord OAuth |
| GET | `/api/auth/discord/callback` | Discord OAuth callback |
| POST | `/api/telegram-webhook` | Telegram bot webhook |
| GET | `/api/instance/config` | Instance default backend |

### Authenticated
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/communities` | List communities |
| POST | `/api/communities/join` | Join community |
| GET | `/api/links` | Get community links |
| POST | `/api/links` | Create community link |
| PATCH | `/api/links` | Edit link |
| DELETE | `/api/links` | Delete link |
| GET | `/api/links/search` | Server-side search |
| POST | `/api/links/vote` | Vote on link |
| POST | `/api/links/report` | Report link |
| GET | `/api/documents` | Get documents |
| POST | `/api/documents` | Upload document |
| DELETE | `/api/documents` | Delete document |
| GET | `/api/personal-links` | Get personal links (GOD) |
| POST | `/api/personal-links` | Create personal link (GOD) |
| GET | `/api/notifications` | List notifications |
| POST | `/api/ai/chat` | AI chat proxy (streaming) |
| GET | `/api/ai/config` | AI config status |
| POST | `/api/ai/config` | Save AI config (GOD) |
| GET | `/api/storage/config` | Storage backend info |
| POST | `/api/storage/config` | Save storage config (GOD) |
| POST | `/api/storage/sync` | Sync D1 ↔ GitHub (GOD) |

---

## Architecture

```
athena/
├── public/                    # Frontend (static assets served by Worker/server)
│   ├── index.html             # SPA entry point
│   └── src/
│       ├── main.js            # App logic (auth, search, AI, themes, dice)
│       ├── style.css          # Base styles
│       ├── themes.css         # Theme tokens (dark/light/material/glass)
│       └── lib/
│           ├── ai.js          # AI proxy + RAG retrieval
│           ├── search.js      # Fuzzy search engine
│           └── dedupe.js      # URL normalization + dedup
│
├── worker/                    # Cloudflare Worker (API + bot + static)
│   ├── index.js               # All API routes, auth, Telegram webhook
│   ├── storage.js             # GitHub store (read/write/list)
│   ├── pgcompat.js            # SQLite → Postgres SQL translator
│   ├── schema.sql             # Database schema
│   └── wrangler.toml          # Cloudflare config
│
├── server/                    # Self-hosted wrapper
│   ├── index.js               # Node HTTP → Worker adapter
│   ├── pgdb.js                # D1-compatible Postgres driver
│   ├── assets.js              # Static file server
│   ├── backup.js              # Telegram + Drive backup
│   ├── restore.js             # Backup restore tool
│   └── setup-selfhost.sh      # Setup script
│
├── screenshots/               # README images (SVG mockups)
└── README.md
```

**Data flow**:

When D1 is active (default):
```
Browser/Telegram → Worker/Server → D1 (source of truth)
                         ↓
                   AI Proxy → OpenAI/Anthropic/etc
```

When GitHub is active:
```
Browser/Telegram → Worker/Server → GitHub (source of truth)
                         ↓              ↓
                   D1 (read cache)   AI Proxy → OpenAI/Anthropic/etc
```

When self-hosted (PostgreSQL):
```
Browser/Telegram → Node Server → PostgreSQL (source of truth)
                         ↓
                   AI Proxy → OpenAI/Anthropic/etc
```

---

## A Note

> **1.** Yes, this is a vibe-coded project — no need to remind me. I built it for personal use and open-sourced it in case it helps someone. I plan to ask friends with more experience to help improve it. If your only intention is to tell me this is "vibe-coded slop," you're welcome to not use it. But if you genuinely want to help, PRs are always welcome.
>
> **2.** Thanks to [OpenCode](https://opencode.ai), ChatGPT, and Claude. I'm a student on a tight budget. OpenCode's affordable subscription, ChatGPT's generous free tier, and Anthropic's support made it possible for me to build this.
>
> **3.** If you find this useful, consider giving it a star or sharing it — only if you genuinely like it.
>
> **4.** Aaron Swartz's thoughts and ideas have deeply shaped who I am. Long live.

---

## License

[CC BY-NC 4.0](LICENSE) — Attribution-NonCommercial

You may use, modify, and share this code for non-commercial purposes with proper attribution.
Commercial use requires a separate license.
