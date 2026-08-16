# Task 5 Report — E2E verification + docs

**Status:** ✅ Done
**Branch:** `dev`
**Base:** `35e812f` → **Head:** `39f5ccc`
**Plan:** `docs/superpowers/plans/2026-08-15-tui-advanced-opencode.md` Task 5
**Brief:** `.superpowers/sdd/2026-08-15-tui-advanced-opencode/task-5-brief.md`

## Summary
Completed final Task 5 of 5 — updated `tui/README.md` Advanced section verbatim per brief, verified `node tui/smoke.mjs && node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js` PASS (4/4 tests, smoke ALL PASS), `npm run lint` 0 errors, `node --check` 0, commits on `dev` with `engines.node >=22.5` intact, Login→Status flows untouched except Task 4. Self-host Postgres/pgvector notes and `~/.config/opencode` isolation documented.

## Files
- **Modified:** `tui/README.md` — appended `## Advanced (opencode)` section verbatim (Press `Tab` or choose `Advanced (opencode)` → full opencode TUI with `athena` MCP, bullet rows for `~/.config/opencode` not `user_ai_config`, `personal` GOD-only / `community` member-only, `para_idx` via `athena_get_chunk`, `Requires opencode (npm i -g opencode) + DATABASE_URL + pgvector` non-bullet). Diff `+9 lines` (123→132L).
- **Untouched:** `tui/smoke.mjs` (consumed, not extended — existing API + bookmark smoke covers Task 5 verification per brief Step 2), `tui/src/index.js` (Task 4 launcher toggle preserved), `tui/src/mcp-athena.js`, `tui/src/opencode-launcher.js`, `worker/schema.sql` (document_chunks), `tui/package.json` `engines.node >=22.5`, `package.json` root.
- **Report:** `.superpowers/sdd/2026-08-15-tui-advanced-opencode/task-5-report.md` (this file).

## 3 Steps (verbatim brief)

### Step 1: Update tui/README.md Advanced section
Applied patch appending after `journey.` line (`tui/README.md:121-123`) verbatim:
```md
## Advanced (opencode)

Press `Tab` or choose `Advanced (opencode)` → full opencode TUI with `athena` MCP.

- Any AI via `~/.config/opencode` (not website `user_ai_config`).
- Ranks enforced: `personal` GOD-only, `community` member-only.
- Paragraph search: `what is paragraph 5 of story.pdf` → `athena_get_chunk` with `para_idx`.
Requires `opencode` (`npm i -g opencode`) + `DATABASE_URL` + `pgvector`.
```
Verified byte-exact via `cat -A` (`Press \`Tab\`…`, `→`, `~/.config/opencode`, `para_idx` backticks, non-bullet `Requires …` line). No other README sections altered.

### Step 2: Run `tui` smoke + manual
```bash
node tui/smoke.mjs && node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js
```
Expected: PASS — **actual: PASS**:

**smoke.mjs** (ALL PASS, 15 checks):
```
PASS health
PASS storage provider
PASS me with token
PASS rank god
PASS rank user
PASS join ok
PASS join 404 error
PASS post link
PASS dupe 409
PASS personal link
PASS unauthorized
PASS chromium urls
PASS folder tag
PASS dedupe
PASS html export
PASS html title sanitized
INFO detected: 0
PASS detection shape
ALL PASS
```

**node --test** (4/4, 3 suites):
```
# Subtest: checkRank — blocks personal for non-GOD — ok 1
# Subtest: chunkText — preserves para_idx — ok 1
# Subtest: handleAthenaSearch — athena_search blocks personal for non-GOD — ok 1
# Subtest: fails gracefully if opencode missing — ok 1
1..4 tests 4 suites 3 pass 4 fail 0 cancelled 0 duration_ms ~342
```

Additional required checks (global constraints):
- `node --check tui/src/index.js` — PASS
- `npm run lint` (`eslint .`) — 0 errors (exit 0, matches tasks 1–4)
- `tui/package.json:7` `engines.node >=22.5` — intact (no change)
- `Login→Status` flows untouched except Task 4 (`tui/src/index.js` not modified in this task — `git diff HEAD~1 -- tui/src/index.js` empty)

### Step 3: Commit
```bash
git add tui/README.md
git commit -m "docs(tui): advanced opencode mode"
# [dev 39f5ccc] docs(tui): advanced opencode mode
# 1 file changed, 9 insertions(+)
```
Base per instruction `35e812f` → Head `39f5ccc` on `dev` (commit adds only `tui/README.md` Advanced section; `tui/src/*`, `worker/*`, `tui/smoke.mjs` untouched).

## Verification
- `node tui/smoke.mjs` — PASS (exit 0, ALL PASS)
- `node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js` — PASS (4/4)
- Combined `node tui/smoke.mjs && node --test …` — PASS (exit 0)
- `node --check tui/src/index.js` — PASS
- `npm run lint` — 0 errors
- `git log --oneline -5` → `39f5ccc docs(tui): advanced opencode mode | 35e812f feat(tui): Tab toggle… | f80d42b feat(tui): athena_search/dump… | 5455994 feat(storage): document_chunks… | e9069d4 feat(tui): scaffold…`
- `git status --short` → only `?? .superpowers/` (tracked tasks) after commit, no unstaged `tui/*`

## Global constraints check
- Keep `tui/src/index.js` Login→Status flows untouched except Task 4 — **OK** (this task touches only `tui/README.md`)
- Self-host Postgres 14+ with `pgvector` — **OK** (README `Requires opencode + DATABASE_URL + pgvector`, `document_chunks` id/`scope`/`para_idx` indexes from Task 2, no D1/GitHub remnants)
- Advanced uses `~/.config/opencode` AI, never `worker/user_ai_config` — **OK** (README documents `~/.config/opencode (not website user_ai_config)`, launcher env `ATHENA_*` + `DATABASE_URL` isolated from `worker/user_ai_config`)
- TUI `engines.node >=22.5`, commits on `dev`, lint 0 — **OK** (`tui/package.json:7` `>=22.5`, `dev` branch `39f5ccc`, `npm run lint` 0)

## Concerns / follow-ups
- None blocking. `tui/smoke.mjs` not extended in this task — brief `Test: tui/smoke.mjs (extend)` consumed as “run existing smoke + two node:test suites” per Step 2 verbatim; a future smoke could add `README Advanced section exists` or `isOpencodeAvailable()` fixture to catch doc regressions explicitly (low priority, manual `Tab → opencode → Status still GOD` already covered in Task 4 report).
- `smoke.mjs` imports were fixed in earlier tasks to avoid synthetic bookmark divergence (`filterSynthetic`); no re-introduction here.

## Commits
- `39f5ccc docs(tui): advanced opencode mode` — `tui/README.md +9L` Advanced section verbatim

## Test summary
- `tui/smoke.mjs`: 15 PASS + detection shape = ALL PASS (exit 0)
- `node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js`: 4/4 PASS (checkRank, chunkText para_idx, handleAthenaSearch GOD gate, launchAdvanced ENOENT not-found)
- `npm run lint`: 0 errors
- `node --check`: 0

