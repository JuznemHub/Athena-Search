#!/usr/bin/env python3
"""
tg_tester.py — drive a Telegram bot under test from a real userbot account (Telethon).

Subcommands:
  setup                     Interactive login, saves API ID/hash + session string.
  check                     Verify saved session still works; prints the account.
  send <bot> <text>         Send one message to the bot, capture replies.
  click <bot> <button>      Click an inline button on the bot's latest message.
  run <bot> <spec.json>     Run a batch test spec, print a results table.

Exit codes: 0 ok/all-pass, 1 test failures, 2 no credentials saved,
            3 missing dependency, 4 session expired/revoked, 5 usage/spec error.

Credentials live in ~/.tg-bot-tester/credentials.json (override dir with
TG_TESTER_HOME). They grant FULL access to the Telegram account — keep private.
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

EXIT_OK, EXIT_FAIL, EXIT_NO_CREDS, EXIT_DEPS, EXIT_EXPIRED, EXIT_USAGE = (
    0,
    1,
    2,
    3,
    4,
    5,
)

try:
    from telethon import TelegramClient, errors
    from telethon.sessions import StringSession
except ImportError:
    print(
        "ERROR: telethon is not installed. Run: pip install -U telethon",
        file=sys.stderr,
    )
    sys.exit(EXIT_DEPS)

CONFIG_DIR = Path(os.environ.get("TG_TESTER_HOME") or Path.home() / ".tg-bot-tester")
CONFIG_FILE = CONFIG_DIR / "credentials.json"
LOCK_FILE = CONFIG_DIR / "client.lock"
LOCK_STALE_SECS = 600


# ---------------------------------------------------------------- config


def load_config():
    if not CONFIG_FILE.exists():
        return None
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR: cannot read {CONFIG_FILE}: {e}", file=sys.stderr)
        sys.exit(EXIT_USAGE)


def save_config(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    if os.name == "posix":
        os.chmod(CONFIG_FILE, 0o600)


def require_config():
    cfg = load_config()
    if not cfg or not cfg.get("session"):
        print(
            "No saved credentials. Run interactive setup first:\n"
            f"  python {Path(__file__).name} setup\n"
            f"(credentials are stored in {CONFIG_FILE})",
            file=sys.stderr,
        )
        sys.exit(EXIT_NO_CREDS)
    if cfg.get("session_valid") is False:
        print(
            "Saved session is marked EXPIRED/REVOKED. Re-run setup to log in again:\n"
            f"  python {Path(__file__).name} setup",
            file=sys.stderr,
        )
        sys.exit(EXIT_EXPIRED)
    return cfg


# ------------------------------------------------------- session lock
# Two clients using the same StringSession concurrently can invalidate the
# session. A simple lockfile prevents accidental parallel runs.


def acquire_lock():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if LOCK_FILE.exists():
        try:
            age = time.time() - LOCK_FILE.stat().st_mtime
        except OSError:
            age = LOCK_STALE_SECS + 1
        if age < LOCK_STALE_SECS:
            print(
                f"ERROR: another tg_tester process appears to be running "
                f"(lock {LOCK_FILE}, {int(age)}s old).\n"
                "Running two clients on the same session string can INVALIDATE the "
                "session. Wait for it to finish, or delete the lock file if it is stale.",
                file=sys.stderr,
            )
            sys.exit(EXIT_USAGE)
        LOCK_FILE.unlink(missing_ok=True)
    LOCK_FILE.write_text(str(os.getpid()), encoding="utf-8")


def release_lock():
    LOCK_FILE.unlink(missing_ok=True)


# ------------------------------------------------------- telethon helpers

SESSION_DEAD_ERRORS = (
    errors.AuthKeyUnregisteredError,
    errors.AuthKeyInvalidError,
    errors.SessionRevokedError,
    errors.SessionExpiredError,
    errors.UserDeactivatedError,
    errors.UserDeactivatedBanError,
)


def mark_session_dead(cfg, exc):
    cfg["session_valid"] = False
    save_config(cfg)
    print(
        f"SESSION EXPIRED/REVOKED ({type(exc).__name__}). The saved session no "
        "longer works — it has been marked invalid.\n"
        f"Re-run setup to log in again:  python {Path(__file__).name} setup",
        file=sys.stderr,
    )
    sys.exit(EXIT_EXPIRED)


async def connect(cfg):
    client = TelegramClient(
        StringSession(cfg["session"]), int(cfg["api_id"]), cfg["api_hash"]
    )
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise errors.AuthKeyUnregisteredError(request=None)
    except SESSION_DEAD_ERRORS as e:
        await client.disconnect()
        mark_session_dead(cfg, e)
    return client


def extract_buttons(msg):
    rows = []
    rm = getattr(msg, "reply_markup", None)
    if rm is not None and hasattr(rm, "rows"):
        for row in rm.rows:
            rows.append([getattr(b, "text", "") for b in row.buttons])
    return rows


def serialize(msg, edited=False):
    return {
        "id": msg.id,
        "text": msg.raw_text or "",
        "buttons": extract_buttons(msg),
        "has_media": msg.media is not None,
        "edited": edited or (msg.edit_date is not None),
    }


async def collect_replies(client, entity, after_id, timeout, settle, watch_ids=None):
    """Poll for bot messages newer than after_id (and edits to watch_ids)
    until nothing changes for `settle` seconds or `timeout` elapses.
    Catches multi-message replies and 'processing…' messages edited in place."""
    deadline = time.monotonic() + timeout
    snapshot = {}
    baseline = {}
    if watch_ids:
        for m in await client.get_messages(entity, ids=list(watch_ids)):
            if m is not None:
                baseline[m.id] = (m.raw_text, extract_buttons(m))
    last_change = None
    while time.monotonic() < deadline:
        current = {}
        for m in await client.get_messages(entity, min_id=after_id, limit=25):
            if not m.out:
                current[m.id] = serialize(m)
        if watch_ids:
            for m in await client.get_messages(entity, ids=list(watch_ids)):
                if m is None:
                    continue
                state = (m.raw_text, extract_buttons(m))
                if state != baseline.get(m.id):
                    current[m.id] = serialize(m, edited=True)
        if current != snapshot:
            snapshot = current
            last_change = time.monotonic()
        if snapshot and last_change and time.monotonic() - last_change >= settle:
            break
        await asyncio.sleep(0.5)
    return [snapshot[k] for k in sorted(snapshot)]


async def with_flood_retry(coro_factory):
    try:
        return await coro_factory()
    except errors.FloodWaitError as e:
        if e.seconds <= 60:
            print(f"FloodWait {e.seconds}s — waiting once…", file=sys.stderr)
            await asyncio.sleep(e.seconds + 1)
            return await coro_factory()
        print(
            f"ERROR: FloodWaitError {e.seconds}s — Telegram is rate limiting this "
            "account. Stop testing and retry later; increase --delay between tests.",
            file=sys.stderr,
        )
        raise


async def do_send(client, entity, text, timeout, settle):
    last = await client.get_messages(entity, limit=1)
    after_id = last[0].id if last else 0
    sent = await with_flood_retry(lambda: client.send_message(entity, text))
    after_id = max(after_id, sent.id)
    return await collect_replies(client, entity, after_id, timeout, settle)


async def do_click(client, entity, button_text, timeout, settle):
    msgs = await client.get_messages(entity, limit=10)
    target = next((m for m in msgs if not m.out and extract_buttons(m)), None)
    if target is None:
        raise RuntimeError("no recent bot message with inline buttons to click")
    after_id = msgs[0].id if msgs else target.id
    await with_flood_retry(lambda: target.click(text=button_text))
    return await collect_replies(
        client, entity, after_id, timeout, settle, watch_ids={target.id}
    )


# ------------------------------------------------------------ commands


async def cmd_setup(args):
    cfg = load_config() or {}
    print(f"Credentials will be stored in: {CONFIG_FILE}")
    print(
        "SECURITY: the session string grants FULL access to this Telegram account.\n"
        "Never share or commit this file. Prefer a spare/test account.\n"
    )
    try:
        if cfg.get("api_id") and cfg.get("api_hash") and not args.reset:
            print(f"Reusing saved API ID {cfg['api_id']} (use --reset to change).")
            api_id, api_hash = int(cfg["api_id"]), cfg["api_hash"]
        else:
            print("Get API credentials from https://my.telegram.org/apps")
            api_id = int(input("Enter API ID: ").strip())
            api_hash = input("Enter API HASH: ").strip()
        client = TelegramClient(StringSession(), api_id, api_hash)
        await client.start()  # prompts for phone / code / 2FA password
    except (EOFError, KeyboardInterrupt):
        print(
            "\nERROR: setup needs an interactive terminal (it prompts for the login "
            "code Telegram sends you). Run it directly in your own terminal.",
            file=sys.stderr,
        )
        return EXIT_USAGE
    me = await client.get_me()
    cfg.update(
        api_id=api_id,
        api_hash=api_hash,
        session=client.session.save(),
        session_valid=True,
        account=f"{me.first_name or ''} (@{me.username})" if me else "?",
    )
    await client.disconnect()
    save_config(cfg)
    print(f"\nLogged in as {cfg['account']}. Session saved to {CONFIG_FILE}.")
    return EXIT_OK


async def cmd_check(args):
    cfg = require_config()
    client = await connect(cfg)
    try:
        me = await client.get_me()
        print(
            f"Session OK — logged in as {me.first_name or ''} (@{me.username}), id={me.id}"
        )
    finally:
        await client.disconnect()
    return EXIT_OK


async def _one_shot(args, action):
    cfg = require_config()
    client = await connect(cfg)
    try:
        entity = await client.get_entity(args.bot)
        replies = await action(client, entity)
    except SESSION_DEAD_ERRORS as e:
        mark_session_dead(cfg, e)
    finally:
        await client.disconnect()
    if args.json:
        print(json.dumps(replies, indent=2, ensure_ascii=False))
    else:
        if not replies:
            print("(no reply within timeout)")
        for r in replies:
            tag = " [edited]" if r["edited"] else ""
            print(f"--- reply {r['id']}{tag} ---\n{r['text']}")
            if r["buttons"]:
                print("buttons:", " | ".join(" / ".join(row) for row in r["buttons"]))
    if args.expect:
        joined = "\n".join(r["text"] for r in replies)
        ok = re.search(args.expect, joined, re.DOTALL) is not None
        print(f"expect {args.expect!r}: {'PASS' if ok else 'FAIL'}")
        return EXIT_OK if ok else EXIT_FAIL
    return EXIT_OK if replies else EXIT_FAIL


async def cmd_send(args):
    return await _one_shot(
        args,
        lambda c, e: do_send(c, e, args.text, args.timeout, args.settle),
    )


async def cmd_click(args):
    return await _one_shot(
        args,
        lambda c, e: do_click(c, e, args.button, args.timeout, args.settle),
    )


def check_test(test, replies):
    joined = "\n".join(r["text"] for r in replies)
    if not replies:
        return "NO_REPLY"
    if "expect" in test and re.search(test["expect"], joined, re.DOTALL) is None:
        return "FAIL"
    if "expect_buttons" in test:
        flat = [b for r in replies for row in r["buttons"] for b in row]
        if not all(
            any(want in have for have in flat) for want in test["expect_buttons"]
        ):
            return "FAIL"
    return "PASS"


async def cmd_run(args):
    try:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: cannot read spec {args.spec}: {e}", file=sys.stderr)
        return EXIT_USAGE
    tests = spec.get("tests", [])
    bot = args.bot or spec.get("bot")
    if not bot or not tests:
        print(
            "ERROR: spec needs a 'bot' (or pass --bot) and a non-empty 'tests' list.",
            file=sys.stderr,
        )
        return EXIT_USAGE
    for i, t in enumerate(tests):
        if "send" not in t and "click" not in t:
            print(f"ERROR: test #{i} needs 'send' or 'click'.", file=sys.stderr)
            return EXIT_USAGE

    if args.dry_run:
        print(f"Spec OK — bot: {bot}, {len(tests)} test(s):")
        for i, t in enumerate(tests, 1):
            action = f"send {t['send']!r}" if "send" in t else f"click {t['click']!r}"
            print(
                f"  {i}. {t.get('name', action)}: {action}"
                + (f"  expect={t['expect']!r}" if "expect" in t else "")
            )
        return EXIT_OK

    delay = args.delay if args.delay is not None else spec.get("delay", 2)
    timeout = args.timeout if args.timeout is not None else spec.get("timeout", 15)
    cfg = require_config()
    client = await connect(cfg)
    results = []
    try:
        entity = await client.get_entity(bot)
        for i, t in enumerate(tests, 1):
            name = t.get("name") or t.get("send") or f"click:{t.get('click')}"
            t0 = time.monotonic()
            try:
                if "send" in t:
                    replies = await do_send(
                        client,
                        entity,
                        t["send"],
                        t.get("timeout", timeout),
                        args.settle,
                    )
                    inp = t["send"]
                else:
                    replies = await do_click(
                        client,
                        entity,
                        t["click"],
                        t.get("timeout", timeout),
                        args.settle,
                    )
                    inp = f"[click] {t['click']}"
                status = check_test(t, replies)
            except SESSION_DEAD_ERRORS as e:
                mark_session_dead(cfg, e)
            except Exception as e:  # noqa: BLE001 — record and continue the suite
                replies, status, inp = (
                    [],
                    f"ERROR: {type(e).__name__}: {e}",
                    t.get("send") or f"[click] {t.get('click')}",
                )
            results.append(
                {
                    "n": i,
                    "name": name,
                    "input": inp,
                    "status": status,
                    "elapsed": round(time.monotonic() - t0, 1),
                    "replies": replies,
                }
            )
            print(
                f"[{i}/{len(tests)}] {name}: {results[-1]['status']}", file=sys.stderr
            )
            if i < len(tests):
                await asyncio.sleep(delay)
    finally:
        await client.disconnect()

    # markdown table on stdout
    print(f"\n## Test results — {bot}\n")
    print("| # | Test | Input | Status | First reply | s |")
    print("|---|------|-------|--------|-------------|---|")
    for r in results:
        first = r["replies"][0]["text"].replace("\n", " ")[:60] if r["replies"] else "—"
        first = first.replace("|", "\\|")
        status = r["status"] if len(str(r["status"])) < 40 else str(r["status"])[:40]
        print(
            f"| {r['n']} | {r['name']} | `{r['input']}` | {status} | {first} | {r['elapsed']} |"
        )
    passed = sum(1 for r in results if r["status"] == "PASS")
    print(f"\n{passed}/{len(results)} passed")
    if args.json:
        Path(args.json).write_text(
            json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"Full replies written to {args.json}")
    return EXIT_OK if passed == len(results) else EXIT_FAIL


# ---------------------------------------------------------------- main


def build_parser():
    p = argparse.ArgumentParser(
        prog="tg_tester.py",
        description="Test a Telegram bot by driving a real userbot account (Telethon).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="interactive login; saves credentials + session")
    s.add_argument("--reset", action="store_true", help="re-enter API ID/hash")
    s.set_defaults(fn=cmd_setup, needs_lock=True)

    s = sub.add_parser("check", help="verify the saved session still works")
    s.set_defaults(fn=cmd_check, needs_lock=True)

    def common(sp):
        sp.add_argument(
            "--timeout",
            type=float,
            default=15,
            help="max seconds to wait for replies (default 15)",
        )
        sp.add_argument(
            "--settle",
            type=float,
            default=2,
            help="stop once replies are quiet this long (default 2)",
        )
        sp.add_argument("--expect", help="regex the reply text must match")
        sp.add_argument("--json", action="store_true", help="print replies as JSON")

    s = sub.add_parser("send", help="send one message and capture replies")
    s.add_argument("bot", help="bot username, e.g. @MyDevBot")
    s.add_argument("text", help="message to send, e.g. /start")
    common(s)
    s.set_defaults(fn=cmd_send, needs_lock=True)

    s = sub.add_parser(
        "click", help="click an inline button on the bot's latest message"
    )
    s.add_argument("bot")
    s.add_argument(
        "button", help="visible button text (substring not supported; exact)"
    )
    common(s)
    s.set_defaults(fn=cmd_click, needs_lock=True)

    s = sub.add_parser("run", help="run a JSON test spec")
    s.add_argument("spec", help="path to spec JSON")
    s.add_argument("--bot", help="override/omit bot from spec")
    s.add_argument(
        "--delay",
        type=float,
        default=None,
        help="seconds between tests (default: spec.delay or 2)",
    )
    s.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="per-test reply timeout (default: spec.timeout or 15)",
    )
    s.add_argument("--settle", type=float, default=2)
    s.add_argument("--json", metavar="OUT.json", help="write full replies to a file")
    s.add_argument(
        "--dry-run",
        action="store_true",
        help="validate the spec and list tests without connecting",
    )
    s.set_defaults(fn=cmd_run, needs_lock=True)
    return p


def main():
    args = build_parser().parse_args()
    needs_lock = getattr(args, "needs_lock", False) and not getattr(
        args, "dry_run", False
    )
    if needs_lock:
        acquire_lock()
    try:
        code = asyncio.run(args.fn(args))
    finally:
        if needs_lock:
            release_lock()
    sys.exit(code)


if __name__ == "__main__":
    main()
