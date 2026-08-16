# Final Fix Report — 2026-08-15 TUI Advanced Opencode

**Base:** 39f5ccc  
**Branch:** dev  
**Fix commit:** (pending) `fix(review): address final review CRITICAL/HIGH — rank gates, pg pool, limit, missing tools, chunks`

## Scope
Single fix wave for all 7 CRITICAL + 7 HIGH from final review. Minimal edits, preserve Global Constraints (POST /api/auth/me cached 60s, postgres only, lint 0).

## CRITICAL fixes

### C1 — checkRank ignores _scope, hard-codes isMember/isBanned
- **File:** `tui/src/mcp-athena.js:9-45`
- **Fix:** `checkRank(token, instance, scope, communityId)` now:
  - Validates token/instance (401)
  - `POST /api/auth/me` with `Authorization: Bearer` (not GET), checks `res.ok`, parses `user|me|data`
  - `GET /api/communities` with same token to build `communities` list
  - Caches `Map(normInstance::token -> {isGod, me, communities, expires})` 60s
  - Computes `isMember`/`isBanned` for `scope==='community' && communityId` via `communities.find(id===communityId)` and `rank==='banned'` (or `banned===true`)
  - For `community` without id, `isMember = communities.length>0`
- **Verified:** `tui/src/mcp-athena.test.js` — `detects banned community`, `detects non-member`, `uses POST for auth/me and caches 60s` (fetch count 1 then 0)

### C2 — POST cached 60s never implemented, uses GET no cache no TTL
- Same as C1. Cache key `normInstance::token`, 60s TTL, `replace(/\/+$/,'')` normalization, POST method.

### C3 — document_chunks never created, TUI vs Worker diverge, search always empty (tsv null, no ensureChunksTable call)
- **File:** `tui/src/mcp-athena.js:ensureChunksTable:55-105`
- **Fix:**
  - `CREATE EXTENSION IF NOT EXISTS vector` try/catch
  - Full `CREATE TABLE` with `embedding VECTOR(1536), tsv TSVECTOR` + fallback to no-vector table if vector error, then `ALTER TABLE ADD COLUMN IF NOT EXISTS tsv/embedding`
  - `ALTER TABLE ADD COLUMN IF NOT EXISTS tsv`
  - Indexes: `idx_chunks_doc`, `idx_chunks_scope`, `idx_chunks_tsv gin(tsv)`, `idx_chunks_embedding ivfflat` (try/catch)
  - Lazy `ensureOnce(pool)` called at start of every handler and in `_handleToolsCall`; flag `_chunksEnsured`
  - Inserts use `to_tsvector('english',$8)` and `ON CONFLICT DO UPDATE` to populate `tsv`; search uses `tsv @@ plainto_tsquery` ordered by `ts_rank`
  - Aligns with `worker/schema.sql` (same DDL, same indexes)

### C4 — PG Pool leak per tool call, never end
- **File:** `tui/src/mcp-athena.js:107-135`
- **Fix:** Singleton `getPool()`:
  - Requires `DATABASE_URL`, reuse `_pool` if `connStr` unchanged, else `await _pool.end()` and recreate
  - `import('pg')` lazily, `on('error',()=>{})`
  - Exports `__closePoolForTests` for tests
  - `_handleToolsCall` uses `await getPool(); await ensureOnce(pool)` once per call, not per handler re-creating

### C5 — LIMIT interpolation SQLi
- **File:** `tui/src/mcp-athena.js:clampLimit:11-17`
- **Fix:** `clampLimit(limit)` validates `Number.isInteger` and clamps 1..50, defaults 8; all handlers `lim = clampLimit(limit)` and use parameterized `LIMIT $3/$4` (`... LIMIT $4` with params [...where.params, query, lim]) never interpolation.
- **Test:** `clampLimit` suite asserts `999→50, 0→1, -5→1, '10; DROP'→8, 3.5→8`; capture test asserts `LIMIT $4` and `params[-1]===50` and no `999` in SQL.

### C6 — MCP toolset incomplete (missing athena_get_doc / athena_list)
- **File:** `tui/src/mcp-athena.js:_athenaTools:220-226`, `_handleToolsCall:252-275`
- **Fix:** Added:
  - `athena_get_chunk` now with `scope` input and rank gate (see H2)
  - `athena_get_doc` `{doc_id, scope}` → rank gate + `buildWhere(s,me,communityId,1)` → `SELECT ... WHERE doc_id=$1 AND scope=$2 AND scope_key=$3 ORDER BY chunk_idx`
  - `athena_list` `{scope, limit}` → rank gate + `clampLimit` + `SELECT doc_id, MIN(created_at), COUNT(*) GROUP BY doc_id ORDER BY MIN(created_at) DESC LIMIT $3`
  - Exported `handleAthenaGetDoc`, `handleAthenaList` with same gates as search/dump

### C7 — DATABASE_URL / pgvector silent empty fallback instead of 503
- **File:** `tui/src/mcp-athena.js:getPool:115-132`
- **Fix:** `if (!process.env.DATABASE_URL) throw Object.assign(Error('DATABASE_URL not configured - Postgres required'), {code:503})`; removed fallback `pool = {query:()=>...}` that returned empty rows. `_handleToolsCall` now throws 503 which surfaces as MCP error.

## HIGH fixes

### H1 dead buildWhere
- **Fix:** `buildWhere(scope, me, communityId, offset=0)` now returns `scope=$a AND scope_key=$b` (not `user_id/community_id`), validates GOD for personal and `community_id required` for community, supports offset for queries with preceding params. All handlers call `buildWhere` (search/dump/get_chunk/get_doc/list) — no longer dead.

### H2 athena_get_chunk bypasses rank
- **Fix:** `handleAthenaGetChunk` enforces `checkRank` + `isGod/isMember/isBanned` gates identical to search, uses `buildWhere(s,me,communityId,2)` so `WHERE doc_id=$1 AND para_idx=$2 AND scope=$3 AND scope_key=$4`. Tool inputSchema now includes `scope`. `_handleToolsCall` routes through handler instead of raw `SELECT`.

### H3 chunkText not pdf.js, page hardcoded
- **Fix:** Keep text para split as fallback (pdf.js not available in zero-deps TUI). Ensure `page:1` is explicit fallback and overlap logic correct (`step = chunkTokens-overlap`). Test `handles overlap and page default` asserts `page===1` and overlap produces multiple chunks. Documented as text-only fallback; pdf.js would require adding `pdf-parse` dep, out of scope for minimal wave.

### H4 schema mismatch swallow
- **Fix:** `ensureChunksTable` catches vector errors, falls back to table without vector but still adds `tsv` column, then `ALTER ... ADD COLUMN IF NOT EXISTS tsv`, creates both `gin(tsv)` and `ivfflat(embedding...)` in try/catch so missing extension never crashes. TUI and worker schemas now both have `embedding VECTOR(1536)` + `tsv TSVECTOR` + same indexes.

### H5 isOpencodeAvailable sync blocks UI
- **File:** `tui/src/opencode-launcher.js:27-48`
- **Fix:** Memoized `_availableCache` + `_availableExpires` (30s), `spawnSync` with `timeout:2000` to bound block, helper `__resetAvailableCacheForTests` exported. First call still sync but subsequent calls within 30s return cached without spawning.

### H6 test coverage minimal
- **Fix:** `tui/src/mcp-athena.test.js` extended from 3 to 13 tests:
  - checkRank: POST + cache, banned, non-member
  - chunkText: overlap/page
  - clampLimit: C5 SQLi + extremes
  - buildWhere: GOD gate and scope_key
  - handleAthenaSearch: personal GOD, banned community, parameterized LIMIT clamp
  - handleAthenaGetChunk: membership rank gate
  - All existing 3 tests preserved

### H7 Tab toggle over-scoped
- **File:** `tui/src/menu.js:11`, `tui/src/index.js:278,528`
- **Fix:** `menu()` now accepts `allowTab=false` (default), shows Tab hint only when true and only handles `key.name==='tab' && allowTab`. `mainMenu` passes `allowTab:true`; `pickDumpTarget` (and any future submenu) omits it so Tab is ignored. Added guard `if (pick===null || pick==='tab') return null` in `pickDumpTarget`.

## Verification

```
$ node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js
# tests 13, suites 6, pass 13, fail 0

$ npx eslint tui/src/mcp-athena.js tui/src/opencode-launcher.js tui/src/index.js
(no output — 0 errors)

$ node tui/smoke.mjs
ALL PASS

$ npx eslint .
(no output)
```

## Remaining notes
- `worker/schema.sql` already contains `CREATE EXTENSION vector` + `document_chunks` with vector/tsv — no change needed (TUI now matches it).
- Postgres-only invariant kept (`getPool` 503, no D1/GitHub fallbacks).
- `ranks via POST /api/auth/me cached 60s` implemented exactly as minimal spec (Map instance+token, 60s, Bearer).
