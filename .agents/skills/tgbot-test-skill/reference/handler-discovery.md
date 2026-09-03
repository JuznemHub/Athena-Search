# Discovering command handlers in a Telegram bot codebase

Goal: enumerate every command the bot under test responds to, plus its expected
reply, so a test spec can be generated. Work in two steps: (1) identify the
framework, (2) grep with that framework's registration patterns. For large
codebases, fan out parallel search agents per directory or per pattern group —
but NEVER run parallel Telethon clients on the same session string.

## Step 1 — identify the framework

Check dependency manifests first (`requirements.txt`, `pyproject.toml`,
`package.json`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `mix.exs`):

| Dependency | Framework |
|---|---|
| `python-telegram-bot` | PTB |
| `aiogram` | aiogram v2/v3 |
| `pyrogram` / `kurigram` / `pyrofork` | Pyrogram family |
| `telethon` | Telethon |
| `pyTelegramBotAPI` | telebot |
| `grammy` | grammY |
| `telegraf` | Telegraf |
| `node-telegram-bot-api` | node-telegram-bot-api |
| `@mtcute/*` | mtcute |
| `telegram` (gram.js) | GramJS |
| `nestjs-telegraf` | NestJS |
| `gopkg.in/telebot` | telebot (Go) |
| `github.com/go-telegram/bot` | go-telegram/bot |
| `github.com/PaulSonOfLars/gotgbot` | gotgbot |
| `github.com/go-telegram-bot-api` | manual dispatch (Go) |
| `teloxide` | teloxide (Rust) |
| `nutgram` / `irazasyed/telegram-bot-sdk` / `longman/telegram-bot` | PHP |

No manifest match → grep for `sendMessage|send_message|bot_command` and read
around the hits; it is likely raw Bot API with manual dispatch (mechanism 10).

## Step 2 — grep patterns per framework

Run these with Grep (regex). Each hit is a handler registration; read the
handler body to learn the expected reply text/buttons.

### Python

| Framework | Grep pattern |
|---|---|
| PTB | `CommandHandler\(|PrefixHandler\(|filters\.COMMAND|filters\.Regex\(|ConversationHandler\(` |
| aiogram v3 | `Command\(|CommandStart\(|\.message\(|message\.register\(` |
| aiogram v2 | `message_handler\(.*commands` |
| Pyrogram family | `filters\.command\(|on_message\(` — also scan a `plugins/` dir (smart plugins auto-discover `@Client.on_message`) |
| Telethon | `events\.NewMessage\(|add_event_handler\(` — commands are regex `pattern=` args; also `events.CallbackQuery` for buttons |
| telebot | `message_handler\(|register_message_handler\(` |
| raw | dispatch dicts/ifs: `\"/[a-z_]+\"|'/[a-z_]+'` near the update loop |

### JavaScript / TypeScript

| Framework | Grep pattern |
|---|---|
| grammY | `\.command\(|\.hears\(|CommandGroup|commandNotFound|\.callbackQuery\(` |
| Telegraf | `\.command\(|\.start\(|\.help\(|\.hears\(|\.action\(|WizardScene` |
| node-telegram-bot-api | `\.onText\(` |
| mtcute | `filters\.command\(` |
| GramJS | `addEventHandler\(.*NewMessage` |
| NestJS | `@Start\(|@Help\(|@Command\(|@Hears\(|@Action\(` |

### Other languages

| Framework | Grep pattern |
|---|---|
| telebot (Go) | `\.Handle\("/` |
| go-telegram/bot | `RegisterHandler\(|RegisterHandlerRegexp\(|RegisterHandlerMatchFunc\(` |
| gotgbot | `handlers\.NewCommand\(|handlers\.Command\{|NewConversation\(` |
| go-telegram-bot-api | `\.IsCommand\(\)|\.Command\(\)` then read the switch |
| teloxide | `#\[derive\(BotCommands` then read the enum variants; also `case!\[Command::` |
| kotlin-telegram-bot | `command\("` |
| tgbotapi (Kotlin) | `onCommand\(` |
| Java AbilityBot | `Ability\.builder\(\)\.name\(` |
| nutgram | `onCommand\(` |
| telegram-bot-sdk | `addCommand\(|\$name\s*=` in Command classes |
| Longman | files under `Commands/**/​*Command.php` |
| Rails telegram-bot | `def \w+!` in the UpdatesController |
| ExGram | `command\("` macros |
| teledart | `onCommand\(` |
| tgbot-cpp | `onCommand\(` |
| Any | `setMyCommands|set_my_commands|SetMyCommands` — the menu registration often lists every public command with its description in one place; check this FIRST, it's the cheapest complete inventory |

## Step 3 — record per command

For each handler note:
- **Command** (and aliases, custom prefixes `! . #`)
- **Args** — required/optional, format (test both with and without)
- **Filters** — private-only? admin/owner-only (SUDO/OWNER_ID env)? group-only?
  Owner-only commands will only respond if the *userbot account* is the owner.
- **Expected reply** — literal strings from the handler body; note i18n lookups
  (resolve the key in the locale files), inline buttons (`expect_buttons`), and
  multi-step flows (send → click → expect).
- **Side effects** — DB writes, membership checks (`JOIN_CHECK`), force-sub.

## Gotchas that skew test results

- **`/cmd@BotName`** — appended in groups; regex-routed bots (Telethon, onText)
  miss it unless anchored `^/cmd(?:@\w+)?(?:\s|$)`. Testing in the bot's PM
  avoids this; test in a group too if the bot targets groups.
- **Group privacy mode** — bots in groups only see commands addressed to them
  unless privacy is off or the bot is admin. A "broken" group command may just
  be privacy mode.
- **Handler order** — a catch-all registered before the command handlers
  swallows them; if every command returns the same fallback text, check
  registration order.
- **Case sensitivity** — `/START` often doesn't match; not a bug unless the dev
  wants `ignore_case`.
- **FSM/conversation state** — a command may only respond in a given state;
  test the entry command first, in order.
- **Deep links** — `/start payload` may behave differently from bare `/start`;
  test both when the code reads `start` args.
