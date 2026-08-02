# athena-tui

Terminal UI for [Athena Search](https://github.com/JuznemHub/Athena-Search) —
dump your browser bookmarks into your Athena brain from the command line.

Zero dependencies (Node >= 22 built-ins only). The wordmark, box menus, `❯`
cursor, and spinner take after [nxfu/binthere](https://github.com/nxfu/binthere);
bookmark extraction covers Chromium-family browsers and Firefox.

## Install

```sh
cd tui
npm install   # no-op, zero deps — just for the bin link
npm start
```

Or run directly: `node tui/src/index.js`

## Flow

1. **Connect instance** — paste your GOD's instance URL (or set `ATHENA_INSTANCE`).
2. **Login with Telegram** — the TUI opens the site's login page; paste the
   address-bar URL (or the `session=` token) back into the terminal.
3. **Join community** — paste the community id from your GOD.
4. **Scan bookmarks** — pick a source: all detected browsers, one browser,
   or a `bookmarks.html`/JSON export file.
5. **Dump bookmarks** — GODs choose the *personal brain* or the *community
   brain*; everyone else dumps to their community. Server-side dedupe is
   handled (skips are reported), folder paths become tags.

## Features

- Athena purple theme, truecolor → 16-color → plain fallback (`NO_COLOR`,
  `TERM=dumb`)
- Wordmark intro animation and braille spinner
  (disable with `ATHENA_TUI_NO_ANIMATION=1`)
- Session + instance persisted at `~/.config/athena-tui/config.json`
- Bookmarks detected from Chrome, Chromium, Edge, Brave, Opera, Vivaldi, Arc,
  and Firefox (`places.sqlite` via `node:sqlite`)
- Non-HTTP(S) bookmarks are skipped; local duplicates collapse before upload

## Env

| Variable | Purpose |
| --- | --- |
| `ATHENA_INSTANCE` | Skip the instance prompt |
| `ATHENA_TOKEN` | Skip Telegram login (scripted use) |
| `ATHENA_TUI_NO_ANIMATION` | Disable intro/spinner |

## Test

```sh
npm test   # smoke tests (mock API + fixture bookmarks) then full TTY e2e
```

The e2e runs the real TUI in a pseudo-TTY (`script`) against a mock Athena
API with a fake Chrome profile and asserts the full join → scan → dump → quit
journey.
