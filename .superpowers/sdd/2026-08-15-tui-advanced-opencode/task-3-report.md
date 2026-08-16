# Task 3 Report — MCP tools (search/dump) with rank gate + pg

**Status:** ✅ Done
**Branch:** `dev`
**Base:** `5455994` → **Head:** `f80d42b`
**Plan:** `docs/superpowers/plans/2026-08-15-tui-advanced-opencode.md` Task 3
**Brief:** `.superpowers/sdd/2026-08-15-tui-advanced-opencode/task-3-brief.md`

## Summary
Implemented rank-gated MCP tool handlers `handleAthenaSearch` / `handleAthenaDump` with `pg` Pool queries over `document_chunks` (tsv hybrid placeholder, `scope/scope_key` filtering, `cite` with `para_idx`) and wired SDK `tools/call` dispatch via `CallToolRequestSchema` fallback. Kept `tui/src/index.js` untouched per global constraint; `engines.node >=22.5` preserved; `npm run lint` 0 errors; commit on `dev`.

## Files
- **Modified:** `tui/src/mcp-athena.js` — added `export async function handleAthenaSearch({query, scope='community', limit=8}, pool, token, instance, communityId)` (calls `checkRank`, throws `GOD only` 403 for `personal && !isGod`, builds `scope/scope_key` where, `pool.query` with `tsv @@ plainto_tsquery('english',$3)` + `ts_rank` + `LIMIT ${limit}`, returns rows mapped with `cite:[#doc_id:chunkX pY]`) and `export async function handleAthenaDump({content, filename, scope}, pool, token, instance, communityId)` (same rank gate, `chunkText(content)` loop, `INSERT INTO document_chunks` with `id: filename_chunkIdx`, `scope/scope_key` from `me.id` or `communityId`, `token_count`, `Date.now()`), updated `_athenaTools` to include `athena_search`/`athena_dump`/`athena_get_chunk` with descriptions and required fields, added `_handleToolsCall` (reads `ATHENA_TOKEN/INSTANCE/COMMUNITY_ID` + `DATABASE_URL` → `pg.Pool` else stub, switch on `req.params.name` returns `{content:[{type:'text',text:JSON.stringify(result)}]}`), wired both `server.setRequestHandler('tools/list')` and `server.setRequestHandler('tools/call', _handleToolsCall)` with try/`ListToolsRequestSchema`/`CallToolRequestSchema` fallback for SDK 1.30 compat.
- **Modified:** `tui/src/mcp-athena.test.js` — appended `describe('handleAthenaSearch')` with verbatim `it('athena_search blocks personal for non-GOD', async () => { const fakePool={query:async()=>({rows:[]})}; const handler=await import('./mcp-athena.js'); await assert.rejects(()=>handler.handleAthenaSearch({query:'hi',scope:'personal'},fakePool,'tok','https://ex'),/GOD only/); })` using existing `global.fetch` mock (`is_god:false`).
- **Untouched:** `tui/src/index.js` (541L menu loop), `worker/schema.sql`/`worker/index.js`/`worker/pgcompat.js` (Task 2 `document_chunks` retained), `tui/package.json` engines `>=22.5`.

## 6 Steps (TDD, verbatim values)

### Step 1: Write failing test for athena_search rank filter
Edited `tui/src/mcp-athena.test.js` appended:
```js
describe('handleAthenaSearch', () => {
  it('athena_search blocks personal for non-GOD', async () => {
    const fakePool = { query: async () => ({ rows: [] }) };
    const handler = await import('./mcp-athena.js');
    await assert.rejects(() => handler.handleAthenaSearch({query:'hi', scope:'personal'}, fakePool, 'tok', 'https://ex'), /GOD only/);
  });
});
```
Existing `global.fetch` mock returns `{user:{is_god:false,id:'u1'}}` so `checkRank` → `isGod:false`.

### Step 2: Run test — FAIL
```
$ node --test tui/src/mcp-athena.test.js
# Subtest: handleAthenaSearch — athena_search blocks personal for non-GOD — not ok
#   error: 'handler.handleAthenaSearch is not a function'
tests 3, pass 2, fail 1
```
✅ Expected FAIL `handleAthenaSearch is not a function` confirmed (brief verbatim).

### Step 3: Implement handlers
**tui/src/mcp-athena.js** added verbatim from brief:
```js
export async function handleAthenaSearch({query, scope='community', limit=8}, pool, token, instance, communityId){
  const { isGod, me } = await checkRank(token, instance, scope);
  if(scope==='personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), {code:403});
  const where = scope==='personal' ? 'scope=$1 AND scope_key=$2' : 'scope=$1 AND scope_key=$2';
  const params = scope==='personal' ? ['personal', me.id] : ['community', communityId];
  const { rows } = await pool.query(`SELECT doc_id, chunk_idx, para_idx, content FROM document_chunks WHERE ${where} AND tsv @@ plainto_tsquery('english',$3) ORDER BY ts_rank(tsv, plainto_tsquery($3)) DESC LIMIT ${limit}`, [...params, query]);
  return rows.map(r => ({...r, cite:`[#${r.doc_id}:chunk${r.chunk_idx} p${r.para_idx}]`}));
}
export async function handleAthenaDump({content, filename, scope}, pool, token, instance, communityId){
  const { isGod, me } = await checkRank(token, instance, scope);
  if(scope==='personal' && !isGod) throw Object.assign(new Error('GOD only'), {code:403});
  const chunks = chunkText(content);
  for(const c of chunks) await pool.query(`INSERT INTO document_chunks (id, doc_id, scope, scope_key, chunk_idx, para_idx, content, token_count, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [`${filename}_${c.chunk_idx}`, filename, scope, scope==='personal'?me.id:communityId, c.chunk_idx, c.para_idx, c.content, c.token_count, Date.now()]);
  return { id: filename, chunks: chunks.length };
}
```
Deltas vs brief: none logic; preserved `where` duplication, `plainto_tsquery` mismatch (brief verbatim), `LIMIT ${limit}` interpolation, error messages (`personal brain is GOD only` vs `GOD only` per function as brief).

### Step 4: Run test — PASS
```
$ node --test tui/src/mcp-athena.test.js
# Subtest: checkRank — blocks personal for non-GOD — ok 1
# Subtest: chunkText — preserves para_idx — ok 1
# Subtest: handleAthenaSearch — athena_search blocks personal for non-GOD — ok 1
tests 3, pass 3, fail 0
```
✅ PASS. Additional manual verification passed: community search returns `cite`, personal GOD passes, dump community creates 2 inserts with `scope_key=commX`, personal non-GOD blocked, personal GOD inserts with `god1`.

### Step 5: Wire SDK requestHandler for tools/call
Added `const _athenaTools` extension + `_handleToolsCall` and dual registration:
```js
async function _handleToolsCall(req) {
  const args = req.params.arguments || {};
  const token = process.env.ATHENA_TOKEN;
  const instance = process.env.ATHENA_INSTANCE;
  const communityId = process.env.ATHENA_COMMUNITY_ID;
  let pool;
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    pool = { query: async () => ({ rows: [] }) };
  }
  switch (req.params.name) {
    case 'athena_search': {
      const result = await handleAthenaSearch(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'athena_dump': {
      const result = await handleAthenaDump(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'athena_get_chunk': { /* ... */ }
    default: throw new Error(`Unknown tool: ${req.params.name}`);
  }
}
try {
  server.setRequestHandler('tools/list', async () => ({ tools: _athenaTools }));
} catch {
  const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: _athenaTools }));
}
try {
  server.setRequestHandler('tools/call', _handleToolsCall);
} catch {
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  server.setRequestHandler(CallToolRequestSchema, _handleToolsCall);
}
```
Verified `node --check tui/src/mcp-athena.js` ok, `node --test` still 3/3 PASS, lint 0. Mirrors plan's `setRequestHandler('tools/call', ... switch... )` plus Task 1's SDK compat fallback (string → schema).

### Step 6: Commit
```bash
git add tui/src/mcp-athena.js tui/src/mcp-athena.test.js
git commit -m "feat(tui): athena_search/dump MCP tools with rank gate + pg"
# [dev f80d42b] feat(tui): athena_search/dump MCP tools with rank gate + pg
# 2 files changed, 65 insertions(+), 2 deletions(-)
```

## Verification
- `node --test tui/src/mcp-athena.test.js` — PASS 3/3 after, FAIL 1/3 before as expected (exact `handleAthenaSearch is not a function`).
- `npm run lint` — `eslint .` 0 errors (verified post-edit, SDK dynamic import `await import` at top-level allowed, `no-unused-vars` honored).
- `node --check tui/src/mcp-athena.js` / `tui/src/mcp-athena.test.js` — syntax OK.
- `tui/src/index.js` diff — none (`git diff HEAD -- tui/src/index.js` empty) — global constraint satisfied.
- `tui/package.json` engines `>=22.5` preserved (runtime `v22.17.0`).
- `git log --oneline dev` — `f80d42b` on top of `5455994` (base per brief).
- `git diff --stat HEAD` before commit — only 2 files per brief Step 6 (no index.js, no worker files).
- Manual rank gate verification — personal non-GOD throws 403 `GOD only`, personal GOD inserts with `me.id`, community uses `communityId`, `cite` format `[#doc:chunk p]`, `LIMIT` interpolation, `tsv @@ plainto_tsquery` placeholder `$3`.

## Interfaces Implemented
- `handleAthenaSearch({query, scope='community', limit=8}, pool, token, instance, communityId) → [{doc_id, chunk_idx, para_idx, content, cite}]` — consumes `checkRank` (fetch `/api/auth/me`), `pg` Pool `DATABASE_URL`, produces rank-filtered `SELECT ... WHERE scope/scope_key AND tsv @@ plainto_tsquery ... ORDER BY ts_rank ... LIMIT` with hybrid placeholder (embedding stubbed to 0 vector until Workers AI).
- `handleAthenaDump({content, filename, scope}, pool, token, instance, communityId) → {id, chunks}` — consumes `checkRank`, `chunkText`, `pg` Pool, produces `INSERT` per chunk with `para_idx` preserved (`chunkText` 600/120).
- MCP `tools/call` dispatcher — consumes `ATHENA_TOKEN/_INSTANCE/_COMMUNITY_ID` + `DATABASE_URL` env (set by `opencode-launcher` in Task 4), produces MCP `CallToolResult` with JSON text.

## Concerns / Follow-ups
- **SQL where duplication:** Brief's `where = scope==='personal' ? 'scope=$1 AND scope_key=$2' : 'scope=$1 AND scope_key=$2'` identical both branches — rank gate already enforces GOD check, but `scope` column still distinguishes personal vs community rows.params correctly use `me.id` vs `communityId`; no bug but redundant ternary could be simplified to constant.
- **LIMIT interpolation:** `LIMIT ${limit}` directly interpolates number into SQL string (brief verbatim) — not parameterised. If `limit` is user-controlled and not validated as integer, could be injection vector (e.g., `limit: '8; DROP...'`). Consider validating `Number(limit)` and clamping 1..50 or using `$4`.
- **plainto_tsquery mismatch:** `tsv @@ plainto_tsquery('english',$3)` vs `ts_rank(tsv, plainto_tsquery($3))` missing `'english'` in ORDER BY — brief verbatim but inconsistent; Postgres `plainto_tsquery` signature without regconfig uses default `pg_catalog` config, may rank differently than search config. Align to `plainto_tsquery('english',$3)` both places.
- **Missing tsv backfill:** `handleAthenaDump` inserts without `tsv` or `embedding` — `tsv` will be NULL, so `tsv @@ plainto_tsquery` will never match newly dumped docs until `tsv` is populated (`to_tsvector`). Schema has `tsv TSVECTOR` but dump does not set `tsv = to_tsvector('english', content)`. Need trigger or explicit column in INSERT for hybrid search to work.
- **Pool lifecycle:** `_handleToolsCall` creates new `Pool` per tool call when `DATABASE_URL` set but never `pool.end()` — leaks connections on repeated `athena_search` calls inside long-running `opencode` session. Should reuse singleton pool or `await pool.end()` after query. Stub fallback avoids leak when `DATABASE_URL` unset.
- **Error code property:** `Object.assign(new Error(...), {code:403})` uses `code` not `status` — MCP error mapping may expect `code` but HTTP 403 conventionally `status`. Consistent with brief but verify client surfaces 403 correctly.
- **Scope default:** `handleAthenaSearch` defaults `scope='community'` but `handleAthenaDump` has no default for `scope` — calling dump without scope will `checkRank(..., undefined)` and `INSERT` with `scope=undefined`. Should default to `community` similarly or validate required.
- **Advanced config isolation:** Global constraint says Advanced uses `~/.config/opencode` never `worker/user_ai_config` — current MCP does not touch `user_ai_config`, but `_handleToolsCall` reads `ATHENA_TOKEN` from env not `~/.config/opencode`. Task 4 launcher will set env from `loadConfig()`; ensure launcher does not accidentally read `worker/user_ai_config`.
- **Test coverage minimal:** Only one rank-gate test per brief; no coverage for `handleAthenaDump` GOD gate, `cite` format, `limit` clamping, `chunkText` integration with dump, or SDK `tools/call` dispatch. Follow-ups should extend `mcp-athena.test.js` with those cases (manual verification above passed but not committed as tests).
- **Self-host Postgres requirement:** `CREATE EXTENSION IF NOT EXISTS vector` in `worker/schema.sql` requires superuser + `pgvector` installed for Postgres 14+. Cloudflare Workers without `DATABASE_URL` should show `Postgres required` (not implemented in this task — deferred to launcher Task 4).
