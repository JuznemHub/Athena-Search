# TUI Advanced (Opencode) Mode — Design

**Date:** 2026-08-15
**Author:** Muse Spark (with JuznemHub)
**Status:** Draft — awaiting user review
**Branch:** `dev` → PR

## Summary

Add an **Advanced toggle** to `athena-tui` that launches the full `opencode` TUI (https://github.com/anomalyco/opencode) with the Athena Postgres DB as a rank-aware MCP. Normal mode stays exactly as today (`Login` → `Quit`); advanced mode gives any AI (via opencode) full skills/agents over Athena memory, with paragraph-level chunk search, while preserving website ranks (GOD personal-only, community member/banned). No website `user_ai_config` is used in advanced mode.

## Goals — Constraints — Non-Goals

**Goals:**
- One binary `athena-tui` with mode switch (`Advanced (opencode)` menu + `Tab`) that toggles between Athena menu and real `opencode`.
- `athena` MCP exposing `links`/`personal_links`/`uploaded_documents`/`document_chunks` with rank gates and `para_idx` exact fetch (`paragraph 5`).
- Any AI via opencode (skills/agents) can `search`/`dump` Athena brain; no coupling to website AI.

**Constraints (per user):**
- Keep `tui/src/index.js:541L` flows untouched except 1 menu entry + `Tab` handler; no refactor of `Login`→`Status`/`api.js`/`config.js`.
- `DATABASE_URL` + `pgvector` required (Postgres 14+, self-host). Cloudflare Workers without direct DB shows `Postgres required` in advanced mode (API-proxy fallback is v2).
- Minimal new code unless necessary.

**Non-Goals (YAGNI):**
- Chunk re-embedding, MCP over HTTP, Cloudflare API-proxy MCP, auto-install of skills, `pgvector` upgrade handling — all v2.

## Architecture

```
athena-tui (node src/index.js)
 ├─ Normal mode:  Login→Status menu (existing, untouched)
 └─ Advanced mode (Tab toggle):  spawn opencode --mcp athena
       └─ tui/src/mcp-athena.js (stdio MCP, rank-aware)
            ├─ auth: state.token → POST /api/auth/me → rankOf + community_members (GOD / member / banned), 60s cache
            ├─ DB: pg Pool DATABASE_URL (from health or .env, scoped by wrapper, never exposed to agent)
            └─ tools: athena_search / athena_get_chunk / athena_get_doc / athena_dump / athena_list
                 → SQL on links / personal_links / uploaded_documents / document_chunks with rank where-clauses
```

`opencode` uses its own `~/.config/opencode` model (any provider). Skills/agents see `athena` MCP as memory. TUI keeps `loadConfig`/`saveConfig` state (`instance`/`token`/`community_id`/`provider`) preserved across toggles.

## Components

**`tui/src/mcp-athena.js`** — stdio MCP server (`@modelcontextprotocol/sdk`).
- *Does:* `Server({name:'athena', version:'1.0.0'})` 5 tools:
  - `athena_search{query, scope, limit}` → hybrid `tsv @@` + `embedding <=> ` → RRF, rank-filtered, returns `[{doc_id, chunk_idx, page, para_idx, snippet, cite:'[#2:chunk5 p5]'}]`
  - `athena_get_chunk{doc_id, chunk_idx|para_idx}` → verbatim paragraph
  - `athena_get_doc{id}` → doc metadata + content
  - `athena_dump{url|content, filename, scope}` → chunk+embed+INSERT
  - `athena_list{scope, limit}` → scoped list
- *Interface:* spawned by TUI with `ATHENA_INSTANCE`/`ATHENA_TOKEN`/`ATHENA_COMMUNITY_ID` env, checks `POST /api/auth/me` per call (cached 60s) → `rankOf` `tui/src/api.js:105`, builds `WHERE scope_key=...` + `personal_links.user_id=me.id` only if `is_god`.
- *Depends:* `pg` `DATABASE_URL`, `makeClient` `tui/src/api.js`.

**`tui/src/opencode-launcher.js`** — toggle helper.
- *Does:* `launchAdvanced(state)` writes temp dir `opencode.json` `{mcpServers:{athena:{command:'node',args:[mcpPath]}}}`, `spawn('opencode',{stdio:'inherit', env:{...}})` with `tmpDir`, `await spawn` close, cleans tmp, returns to `mainMenu`.
- *Depends:* `opencode` binary in `PATH`, `state` from `tui/src/config.js`.

**`document_chunks` migration** (`worker/schema.sql:1` `ensureChunksTable`).
- *Does:* `CREATE TABLE document_chunks (id TEXT PK, doc_id TEXT, scope TEXT, scope_key TEXT, chunk_idx INT, page INT, para_idx INT, content TEXT, embedding VECTOR, tsv tsvector, created_at BIGINT)` + `GIN(tsv)` + `ivfflat(embedding)`. Created lazily on first `athena_dump` via `ensureChunksTable(env)`.
- *Depends:* `pgvector` extension, chunker in `mcp-athena.js` ingest path (600tok/120 overlap, `para_idx` from `pdf.js` paragraph split).

**TUI toggle** (`tui/src/index.js:541L`).
- *Does:* add `Advanced (opencode)` menu entry + `Tab` key handler in `mainMenu`, calls `launchAdvanced(state)`, preserves `state` via `loadConfig`/`saveConfig` — no other flows touched.

## Data Flow

**Toggle:** `mainMenu` `Advanced` → `launchAdvanced(state)` saves `state` (`instance`/`token`/`community_id`), spawns `mcp-athena.js` (stdio) + `opencode --config tmp/opencode.json`, `await spawn` → on `close` returns to normal menu, `state` untouched.

**Ingest (advanced):** `opencode agent → athena_dump{content, filename, scope}` → `mcp-athena` → `GET /api/auth/me` (cached) → `if scope==='personal' && !is_god → 403` → chunker 600tok/120 overlap, `para_idx` from `pdf.js`, embed via `pgvector`, `INSERT document_chunks` + `uploaded_documents` in one `pg` txn → `{id, chunks: n}`.

**Recall (advanced):** `athena_search{query:'paragraph 5 story', scope:'community'}` → rank gate (`community_members` check + not banned via `POST /api/communities` membership) → `embed(query)` → `SELECT ... WHERE scope_key=$1 AND (tsv @@ plainto_tsquery OR embedding <=> $2) ORDER BY RRF` → top 8 → `[{doc_id, chunk_idx, page, para_idx, snippet, cite:'[#2:chunk5 p5]'}]`. `athena_get_chunk{doc_id, para_idx:5}` → `SELECT content WHERE doc_id=$1 AND para_idx=5 AND scope_key=$1`.

**Normal mode:** unchanged `makeClient.postLinksBatch` → Postgres `links`/`personal_links`, no MCP, same rank gates server-side `worker/index.js:538`.

## Error Handling

- `401 token expired` → MCP returns `{error:'Login required', code:'AUTH_REQUIRED'}` agent shows `Re-login in normal mode` (no raw DB leak).
- `403 personal` / `COMMUNITY_LOCKED` / `BANNED` → rank gate returns `403` with `is_god`/`member` reason, never touches `personal_links`/`links`.
- `DATABASE_URL` missing / `pgvector` not installed → MCP `athena_search` returns `503 Install pgvector: CREATE EXTENSION vector` (TUI pre-checks `SELECT * FROM pg_extension` on launch).
- `opencode` not in `PATH` → TUI shows `Install: npm i -g opencode` + `https://github.com/anomalyco/opencode`, toggle disabled.
- MCP crash → `spawn` `close` code non-zero → TUI catches, shows `Advanced mode exited: ${err.message}`, returns to menu, no state loss.

## Testing

- `tui/src/mcp-athena.test.js` (node:test): rank stubs (`is_god` true/false), `personal` 403, `community` scoped to `community_id`, `para_idx` exact fetch, `banned` blocked.
- `tui/smoke.mjs` + `tui/test-api.mjs` extended: `athena_search` with 3 chunks → cites `[#n:chunk p]`, `athena_dump` → `document_chunks` row + `tsv`.
- Manual: `athena-tui` → `Advanced` → `opencode` chat `what is paragraph 5 of story.pdf` → cites, `Tab` back → `Status` still shows `GOD`/`PostgreSQL`.

## Dependencies

- `opencode` binary (`https://github.com/anomalyco/opencode`, `npm i -g opencode` or `cargo install`)
- `DATABASE_URL` `postgresql://...` reachable from TUI host, `pgvector` extension
- `@modelcontextprotocol/sdk` (stdio), `pg` (already via `pgdb.js` shim, but `mcp-athena.js` uses direct `pg`)
- Node `>=22.5` (existing TUI `tui/package.json:7`)

## Security Invariants

- MCP never exposes `DATABASE_URL` to agent (only wrapper holds it); agent sees only rank-filtered rows.
- Every tool re-checks `POST /api/auth/me` (cached 60s) — no `is_god` bypass via cached `state.rank` alone.
- `personal_links` query always adds `AND user_id = $meId` when `scope==='personal'`; `links` always `AND community_id = $communityId`.

## Open Questions (deferred to plans)

- None for v1 — paragraph chunk `para_idx` extraction for scanned PDFs (OCR) deferred to v2.

## Verification Steps

- `npx eslint tui/src/mcp-athena.js tui/src/opencode-launcher.js`
- `node --test tui/src/mcp-athena.test.js`
- `athena-tui` → `Advanced` → `opencode --version` → search/para5 → back → `Status`
