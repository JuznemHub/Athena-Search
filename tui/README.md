# athena-tui

<p>
  <a href="https://www.npmjs.com/package/athena-tui"><img src="https://img.shields.io/npm/v/athena-tui?style=flat-square&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/license_CC_BY--NC_4.0-blue?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="zero dependencies">
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-339933?style=flat-square&logo=node.js" alt="node >= 22.5">
</p>

Terminal UI for [Athena Search](https://github.com/JuznemHub/Athena-Search) —
dump your browser bookmarks into your Athena brain from the command line.

Zero dependencies (Node >= 22 built-ins only). The wordmark, box menus, `❯`
cursor, and spinner take after [nxfu/binthere](https://github.com/nxfu/binthere);
bookmark extraction covers Chromium-family browsers and Firefox.

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

## Requirements

- **Node.js >= 22.5** (uses `node:sqlite` for Firefox bookmarks; anything
  >= 22 works otherwise)
- An Athena Search instance URL (ask your GOD)
- A Telegram account linked to the instance

## Install

The package is on [npm](https://www.npmjs.com/package/athena-tui), so you can
grab it on any machine without cloning the repo — handy when the website and
database live on a VPS but you run the TUI locally to collect your bookmarks:

```sh
npm install -g athena-tui
athena-tui
```

Prefer a longer name? `athenasearch-tui` is an alias package that installs
the same CLI (`athenasearch-tui` and `athena-tui` commands both work):

```sh
npm install -g athenasearch-tui
```

### Setup

> First-time? Just press **1–5** in order — the menu is the whole app.
> Every step can be re-run anytime; `q` quits.

1. **1 Connect instance** — paste your instance URL (`https://athena.example.org`) — or skip the prompt with `ATHENA_INSTANCE` env.
2. **2 Login with Telegram** — your browser opens the site's login page;
   log in, then paste the address-bar URL (or the `session=` token) back
   into the terminal.
3. **3 Join community** — paste the community id from your GOD (skip this if
   you only use your personal brain as GOD).
4. **4 Scan bookmarks** — scans every browser profile found locally at once
   (Chrome/Chromium/Edge/Brave/Opera/Vivaldi/Arc/Firefox); if none are found it
   asks for an HTML/JSON export file.
5. **5 Import social (Reddit/X)** — guided setup that drives the tools for
   you and remembers the paths, so the next import just works: pick Reddit
   (finds/writes Reddit-Fetch `.env`, runs the OAuth login once, fetches
   `saved_posts.json`) or X (takes your archive ZIP, extracts it, remembers
   the folder). Afterwards step 5 reuses the stored paths with no prompts.
6. **6 Dump bookmarks** — GODs pick *personal* or *community* brain; others
   dump to their community. Server-side dedupe is handled (skips reported),
   folder paths become tags.

From the repo checkout (instead of npm):

```sh
cd tui
npm install       # no-op — zero deps, just links the `athena-tui` bin
npm start
```

Or run it directly: `node tui/src/index.js`

## Features

- Athena purple theme, truecolor → 16-color → plain fallback (`NO_COLOR`,
  `TERM=dumb`)
- Wordmark intro animation and braille spinner
  (disable with `ATHENA_TUI_NO_ANIMATION=1`)
- Session + instance persisted at `~/.config/athena-tui/config.json`
- Bookmarks detected from Chrome, Chromium, Edge, Brave, Opera, Vivaldi, Arc,
  and Firefox (`places.sqlite` via `node:sqlite`), including Flatpak/Snap
  sandboxes and the XDG profile dir (`~/.config/mozilla/firefox`)
- Portable/custom browser data dirs: `ATHENA_BOOKMARK_ROOTS=/path/to/User\ Data`
  (colon-separated) — scanned one level deep for `Bookmarks`/`places.sqlite`;
  `athena-tui --diagnose` shows every root it checks
- Non-HTTP(S) bookmarks are skipped; local duplicates collapse before upload
- Social imports: [Reddit-Fetch](https://github.com/akashpandey/Reddit-Fetch)
  `saved_posts.json`/`.html` (run `reddit-fetcher` once to create it) and X
  archives — an extracted official archive (`data/tweets.js`, …) or
  [TweetNook](https://github.com/GezerWezer/TweetNook)
  (`tweetnook import x-archive <zip>`, `tweetnook export json --collection all`).
  Tweets with outside links dump one entry per link; text-only tweets/likes
  dump as a link to the tweet itself, tagged `x` (+ `r-<sub>` for Reddit)

## Env

| Variable | Purpose |
| --- | --- |
| `ATHENA_INSTANCE` | Skip the instance prompt |
| `ATHENA_TOKEN` | Skip Telegram login (scripted use) |
| `REDDIT_EXPORT_PATH` | Skip the Reddit setup (Reddit-Fetch JSON/HTML) |
| `X_ARCHIVE_PATH` | Skip the X setup (extracted X archive dir) |
| `TWEETNOOK_EXPORT_PATH` | Skip the social-import prompt (TweetNook JSON export) |
| `ATHENA_TUI_NO_ANIMATION` | Disable intro/spinner |

## Test

```sh
npm test   # smoke tests (mock API + fixture bookmarks) then full TTY e2e
```

The e2e runs the real TUI in a pseudo-TTY (`script`) against a mock Athena
API with a fake Chrome profile and asserts the full join → scan → dump → quit
journey.

## Advanced (MCP)

Press `Tab` or choose `Advanced (MCP)` → prints a minimal MCP config that any
agent (Hermes, Claude Code, Codex) can use. No vendor CLI required.

- Works with `ATHENA_INSTANCE` + `ATHENA_TOKEN` only; `DATABASE_URL` optional.
- Ranks enforced: `personal` GOD-only, `community` member-only.
- Paragraph search: `what is paragraph 5 of story.pdf` → `athena_get_chunk` with `para_idx`.

Use `node src/mcp-athena.js --config` to print the JSON snippet, or
`node src/mcp-athena.js --help` for Hermes setup.

Rank gates apply to every tool call; a server 401/403 drops the cached rank
immediately, and community scope without a joined community is rejected before
any request leaves your machine.
