# Athena — Second Brain Search

One bar: search, dump, and AI answers from your markdown brain.

<p align="center">
  <img src="https://img.shields.io/badge/version-6.18.4-blueviolet?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/license_CC_BY--NC_4.0-blue?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/telegram-bot-blue?style=flat-square&logo=telegram" alt="telegram">
  <img src="https://img.shields.io/badge/discord-bot-5865F2?style=flat-square&logo=discord" alt="discord">
</p>

---

## Features

- **Save** links from the web UI, Telegram bot, or Discord bot. Upload text files (.md, .py, .json, .sql, and 30+ more, 512 KB each).
- **Search** with fuzzy matching across titles, URLs, notes, and tags — tolerant of typos and partial matches, with server-side search for large brains.
- **Ask** questions with RAG over your links and documents. Supports OpenAI, Anthropic, Groq, OpenRouter, and OpenCode Zen, with streaming answers and cited sources.
- **Share** a brain with a Telegram group in community mode, with voting, reporting, and rank-based permissions — or keep it private in personal mode.
- **Store** your data wherever you like: Cloudflare D1, Markdown files in your own GitHub repo, or self-hosted PostgreSQL.
- **Log in** with Telegram (OAuth or Mini App) or Discord. Sessions last 30 days.

---

## Themes

Four themes — **Dark**, **Light**, **Material** (MD3 surfaces, no blur), and **Glass** (iOS-style vibrancy) — each with a free-form accent color picker in Settings. Buttons, glows, borders, and highlights update instantly and persist locally.

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

## Install

### A. Cloudflare — quick start, free tier, zero infrastructure

```bash
git clone https://github.com/JuznemHub/Athena-Search.git
cd Athena-Search/worker

cp ENV.example .env      # Cloudflare account_id, Telegram/Discord secrets
npx wrangler deploy
```

Secrets go in with `wrangler secret put`: `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`. Everything else — the D1 binding, static assets from `public/`, client and owner IDs — lives in `wrangler.toml`.

### B. Self-hosted PostgreSQL — production, full control

Requires Node.js 22+ and PostgreSQL 14+.

```bash
git clone https://github.com/JuznemHub/Athena-Search.git
cd Athena-Search

npm install
cp .env.example .env     # see server/.env.example for the annotated reference
node server/index.js
```

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

Examples for Caddy (`server/Caddyfile.example`), systemd (`server/athena.service.example`), and Cloudflare Tunnel (`server/cloudflared-athena.service.example`) ship with the repo.

<details>
<summary>Nginx reverse proxy</summary>

Behind Cloudflare, set SSL/TLS to **Flexible** — the origin is HTTP.

```nginx
# /etc/nginx/conf.d/athena.conf
server {
    listen 80;
    server_name athena.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Remove the default server block in `/etc/nginx/nginx.conf` if it catches requests first.
</details>

### Cloudflare frontend, self-hosted backend

Set `ATHENA_FRONTEND_URL` on your server to wherever OAuth should send the browser after login — it has to be a URL your users can actually reach, serving this same UI. Then in Settings → Backend, enter your server URL and click "Set backend for everyone". The choice is stored per-instance, so every visitor uses the same backend.

Storage backend comes from `ATHENA_RUNTIME`, not the frontend URL. A self-hosted server always uses PostgreSQL.

---

## Ranks

| Rank | Who | Personal brain | AI | Bot settings | Delete links | Upload docs |
|------|-----|---------------|-----|--------------|--------------|-------------|
| **GOD** | Instance host (`TG_OWNER_IDS`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Owner** | Community creator (`/community_verify`) | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Admin** | Promoted with `/admin` | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Member** | Login + join TG group + `/community_join` | ❌ | ✅ | ❌ | ❌ | ✅ |
| **Banned** | Left or kicked from the TG group | ❌ | ❌ | ❌ | ❌ | ❌ |

Empty owner lists mean every logged-in user is GOD — convenient for a personal self-host. Bans are per-community, and Telegram presence stays in sync: leaving the group auto-bans, rejoining auto-unbans.

---

## Personal and community brains

**Personal** (GOD only) is private — stored under your user ID, visible only to you. **Community** is shared with a Telegram group, where every member can dump, search, and ask. Switch with `/personal` and `/community` in the bot, or the toggle on the website.

In a group, everything goes to the community brain. In DMs, the mode decides where pasted links land.

**Creating a community**: add your bot to a Telegram group and run `/community_verify`. The group title becomes the community name and you become its owner, free to promote admins with `/admin`.

**Joining one**: log in on the website, join the Telegram group, then DM the bot `/community_join <community_id>` — the ID comes from `/community_list` or the website.

---

## Storage

| Backend | How it works | When to use |
|---------|-------------|-------------|
| **Cloudflare D1** | Reads and writes go straight to D1 (SQLite). | Quick start, free, zero config |
| **GitHub Markdown** | Links live as .md files in your repo; D1 is a transparent read cache. | Data ownership, version history |
| **PostgreSQL** | Your own database. | Production, self-hosted |

With GitHub active, it is the source of truth: reads come from GitHub (cached to D1), writes go to both. With D1 active, GitHub is untouched until you sync.

**Setting up GitHub storage**: create a repo (say `yourname/athena-brain`), generate a PAT with `repo` scope, then Settings → Storage → GitHub and enter the repo, branch, and token. Save to verify the connection.

**Syncing** merges both stores in either direction, whichever backend is active — via Settings → Storage → "Push existing links to GitHub", or `/sync` in the bot (GOD only).

```
brain/
  personal/user123/link1.md
  communities/c_abc123/link3.md
documents/
  personal/user123/doc-id--filename.md
  communities/c_abc123/doc-id--filename.md
```

---

## AI

As GOD, go to Settings → AI assistant, pick a provider, and enter the base URL, model, and API key. Saving syncs the config to the server, so the website and the bot's `/ai` share one set of credentials.

| Provider | Base URL | Model example |
|----------|----------|---------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-20250514` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| OpenCode Zen Go | `https://opencode.ai/zen/go/v1` | `deepseek-v4-flash` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `deepseek-v4-flash` |

Questions are fuzzy-matched against your links and documents, the top matches are injected into the system prompt, and the answer comes back grounded in your brain with its sources listed underneath.

---

## Telegram bot

1. Get a token from [@BotFather](https://t.me/BotFather) with `/newbot`
2. DM your bot `/id` to find your user ID
3. Website → Settings → Bot → paste the token and your ID → "Verify & save bot"
4. For groups: add the bot, then run `/community_verify`

In forum groups, `/id` inside a topic gives you the topic ID, and `/topic <id>` locks the bot to it.

**Webhook (self-hosted)** — the endpoint is `/api/telegram-webhook`:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://yourdomain.com/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

If you set `TELEGRAM_WEBHOOK_SECRET`, pass the same value as `secret_token`. If you don't, Athena derives one from the bot token — in which case re-register the webhook whenever the token changes. `WEBHOOK_ALLOW_UNSIGNED=1` disables the check entirely; it's insecure and only meant for migration.

**Log channel** — send login and community-join notices to a channel instead of GOD's DMs. Add the bot as a channel admin, get the channel ID (forward a message to @userinfobot, then prefix it with `-100`), and DM `/setlogchannel -1001234567890`. Turn it off with `/setlogchannel off`.

<details>
<summary><b>Bot commands</b></summary>

**Everyone**

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and status |
| `/help` | Command menu with categories |
| `/id` | Chat ID, your user ID, topic ID |
| `/rank` | Your ranks across all communities |
| `/db` | Show storage backend info |
| `/search <query>` | Search active brain |
| `/ai <question>` | AI over brain context |
| `/community_join <id>` | Join a community |
| `/community_list [id]` | List your communities, or one community's details |

Sending or forwarding any supported text file saves it to the active scope.

**Staff** (admin, owner, GOD)

| Command | Description |
|---------|-------------|
| `/delete <url>` | Delete a link (or reply `/delete`) |
| `/edit <url> \| notes: ...` | Edit link description |
| `/admin` | Reply to a user → promote to admin |
| `/demote` | Demote admin to member |
| `/clear @user` | Remove member (can rejoin) |
| `/topic <id>` / `/topic off` | Lock bot to a forum topic |
| `/dumpall on/off` | Multi-link mode |

**Owner and GOD**

| Command | Description |
|---------|-------------|
| `/community_verify` | Link group to community |
| `/community_delete <id>` | Wipe community + all data |
| `/clear_db <id>` | Wipe links only, keep members |
| `/sync` | Sync D1 ↔ GitHub |
| `/backup` | Trigger backup (self-hosted) |
| `/setlogchannel <id\|off>` | Set log channel for notifications |

**GOD only**

| Command | Description |
|---------|-------------|
| `/personal` / `/community` | Switch dump mode |
| `/mode` | Show current dump mode |
| `/clear_personal_db` | Wipe personal links |

</details>

---

## API

<details>
<summary><b>Endpoints</b></summary>

**Public**

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

**Authenticated**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/communities` | List communities |
| POST | `/api/communities/join` | Join community |
| GET, POST, PATCH, DELETE | `/api/links` | Read, create, edit, delete links |
| GET | `/api/links/search` | Server-side search |
| POST | `/api/links/vote` | Vote on link |
| POST | `/api/links/report` | Report link |
| GET, POST, DELETE | `/api/documents` | Read, upload, delete documents |
| GET, POST | `/api/personal-links` | Personal links (GOD) |
| GET | `/api/notifications` | List notifications |
| POST | `/api/ai/chat` | AI chat proxy (streaming) |
| GET, POST | `/api/ai/config` | Read config status, save config (GOD) |
| GET, POST | `/api/storage/config` | Read backend info, save config (GOD) |
| POST | `/api/storage/sync` | Sync D1 ↔ GitHub (GOD) |

</details>

---

## Architecture

```
athena/
├── public/              # Frontend (static assets served by Worker/server)
│   ├── index.html       # SPA entry point
│   └── src/
│       ├── main.js      # App logic (auth, search, AI, themes)
│       ├── style.css    # Base styles
│       ├── themes.css   # Theme tokens (dark/light/material/glass)
│       └── lib/         # ai.js (RAG), search.js (fuzzy), dedupe.js (URLs)
│
├── worker/              # Cloudflare Worker — API + bot + static
│   ├── index.js         # All API routes, auth, Telegram webhook
│   ├── storage.js       # GitHub store (read/write/list)
│   ├── pgcompat.js      # SQLite → Postgres SQL translator
│   ├── schema.sql       # Database schema
│   └── wrangler.toml    # Cloudflare config
│
└── server/              # Self-hosted wrapper
    ├── index.js         # Node HTTP → Worker adapter
    ├── pgdb.js          # D1-compatible Postgres driver
    ├── assets.js        # Static file server
    ├── backup.js        # Telegram + Drive backup
    └── restore.js       # Backup restore tool
```

Requests always land on the Worker or the Node server, which reads and writes the active store and proxies AI calls out to your provider:

```
Browser/Telegram → Worker or Node server → D1 | GitHub (+D1 cache) | PostgreSQL
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

You may use, modify, and share this code for non-commercial purposes with proper attribution. Commercial use requires a separate license.
</content>
</invoke>
