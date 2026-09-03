# tgbot-test-skill

A [Claude Code](https://claude.com/claude-code) agent skill that tests Telegram
bots end-to-end during development — from a **real logged-in userbot account**
(Telethon), not mocks.

The agent discovers your bot's command handlers in the codebase, sends the
actual commands from a user account, captures the bot's replies (including
in-place edits and inline keyboards), clicks buttons, verifies everything
against the handler code, and reports a pass/fail table. Attach it to a live
dev session for a continuous edit → restart → re-test feedback loop.

## What's inside

| Path | Purpose |
|---|---|
| `SKILL.md` | The skill — workflow, gotchas, troubleshooting |
| `scripts/tg_tester.py` | The driver: `setup` / `check` / `send` / `click` / `run` |
| `reference/handler-discovery.md` | Handler-registration grep patterns for ~30 bot frameworks (PTB, aiogram, Pyrogram, Telethon, grammY, Telegraf, teloxide, gotgbot, …) |
| `examples/sample-spec.json` | Example batch test spec |

## Install

```bash
npx skills add xditya/tgbot-test-skill
```

Or manually: copy this repo into `~/.claude/skills/tg-bot-tester/` (global) or
`<project>/.claude/skills/tg-bot-tester/` (per project).

## Requirements

- Python 3.8+ and `pip install -U telethon`
- Telegram API credentials from https://my.telegram.org/apps
- A Telegram account for the userbot — **a spare/test account is strongly
  recommended**

## Quick start

```bash
# one-time interactive login (prompts for phone + login code)
python scripts/tg_tester.py setup

# verify
python scripts/tg_tester.py check

# probe a single command
python scripts/tg_tester.py send @MyDevBot "/start" --expect "(?i)welcome"

# run a batch spec
python scripts/tg_tester.py run examples/sample-spec.json --json results.json
```

Or just ask Claude Code: *"test my telegram bot"* — the skill auto-loads.

## Security

`setup` stores your API ID, API hash, and session string in
`~/.tg-bot-tester/credentials.json` (override the directory with
`TG_TESTER_HOME`). **That file grants full access to the Telegram account.**
Never commit it, share it, or paste it anywhere. The driver refuses to run two
clients on the same session concurrently (that can get the session
invalidated) and auto-detects expired/revoked sessions so you can re-login.

## Credits

Made by **Aditya** — https://xditya.me · [@xditya](https://github.com/xditya)
