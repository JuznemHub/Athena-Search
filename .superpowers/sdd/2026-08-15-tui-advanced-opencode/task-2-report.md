# Task 2 Report — Document chunks schema + chunker (para_idx)

**Status:** ✅ Done  
**Branch:** `dev`  
**Base:** `e9069d4` → **Head:** `5455994`  
**Plan:** `docs/superpowers/plans/2026-08-15-tui-advanced-opencode.md` Task 2  
**Brief:** `.superpowers/sdd/2026-08-15-tui-advanced-opencode/task-2-brief.md`

## Summary
Implemented paragraph-level chunker `chunkText` with `para_idx` preservation and `document_chunks` Postgres schema (`pgvector` + `tsv`) plus lazy `ensureChunksTable` in both TUI MCP and Worker. Kept `tui/src/index.js` untouched per global constraint; `engines.node >=22.5` preserved; `npm run lint` 0 errors.

## Files
- **Modified:** `tui/src/mcp-athena.js` — added `export function chunkText(content, {chunkTokens=600, overlap=120}) → [{chunk_idx, para_idx, page, content, token_count}]` (split on `/\n\s*\n/` → `para_idx=i+1`, whitespace token split with `filter(Boolean)`, `step = chunkTokens-overlap` guarded `>0` else `chunkTokens` to avoid infinite loop, `chunk_idx` global) and `export async function ensureChunksTable(pool)` (3 `pool.query` calls: `CREATE TABLE IF NOT EXISTS document_chunks` + `idx_chunks_doc` + `idx_chunks_scope`).
- **Modified:** `tui/src/mcp-athena.test.js` — extended with `import { chunkText }` and `describe('chunkText')` preserving brief's `it('preserves para_idx')` verbatim (`"para1\n\npara2\n\npara3"` with `chunkTokens:10, overlap:0` asserts `out[0].para_idx===1` and `out[1].para_idx===2`).
- **Modified:** `worker/schema.sql` — appended `CREATE EXTENSION IF NOT EXISTS vector;`, `CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL, token_count INTEGER, embedding VECTOR(1536), tsv TSVECTOR, created_at BIGINT NOT NULL)`, `idx_chunks_doc`, `idx_chunks_scope`, `idx_chunks_embedding USING ivfflat (embedding vector_l2_ops)`, `idx_chunks_tsv USING gin(tsv)`.
- **Modified:** `worker/index.js` — added `export async function ensureChunksTable(env)` (mirrors TUI version for D1→pgcompat `env.DB.prepare(...).run()`: `CREATE EXTENSION`, table, 4 indexes with `.catch(()=>{})` for idempotency on missing vector extension).
- **Modified:** `worker/pgcompat.js` — added `document_chunks: ['id']` to `PRIMARY_KEYS` for upsert rewrite.
- **Untouched:** `tui/src/index.js` (541L menu loop), `tui/package.json` engines `>=22.5`.

## 5 Steps (TDD, verbatim values)

### Step 1: Write failing test for para_idx chunk
Extended `tui/src/mcp-athena.test.js` verbatim from brief:
```js
import { checkRank, chunkText } from './mcp-athena.js';
describe('chunkText', () => {
  it('preserves para_idx', () => {
    const out = chunkText("para1\n\npara2\n\npara3", { chunkTokens: 10, overlap: 0 });
    assert.equal(out[0].para_idx, 1);
    assert.equal(out[1].para_idx, 2);
  });
});
```

### Step 2: Run test — FAIL
```
$ node --test tui/src/mcp-athena.test.js
SyntaxError: The requested module './mcp-athena.js' does not provide an export named 'chunkText'
tests 1, pass 0, fail 1
```
✅ Expected FAIL confirmed (`chunkText is not a function` family).

### Step 3: Implement chunker + schema
**tui/src/mcp-athena.js:**
```js
export function chunkText(content, { chunkTokens = 600, overlap = 120 } = {}) {
  const paras = String(content).split(/\n\s*\n/).map((p, i) => ({ text: p, para_idx: i + 1 }));
  const out = [];
  let chunk_idx = 0;
  for (const paraObj of paras) {
    const tokens = paraObj.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    for (let i = 0; i < tokens.length;) {
      const slice = tokens.slice(i, i + chunkTokens);
      out.push({ chunk_idx: chunk_idx++, para_idx: paraObj.para_idx, page: 1, content: slice.join(' '), token_count: slice.length });
      const step = chunkTokens - overlap;
      i += step > 0 ? step : chunkTokens;
    }
  }
  return out;
}
export async function ensureChunksTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL, token_count INTEGER, created_at BIGINT NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx)`);
}
```
Deltas vs brief verbatim: added `filter(Boolean)` to drop empty tokens from consecutive whitespace, guard `step>0` to avoid infinite loop if `overlap>=chunkTokens`, split indexes into separate `pool.query` calls (brief's single query truncated). Logic identical for brief's test case.

**worker/schema.sql append:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL,
  token_count INTEGER, embedding VECTOR(1536), tsv TSVECTOR, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks USING ivfflat (embedding vector_l2_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING gin(tsv);
```

**worker/index.js:** `export async function ensureChunksTable(env)` with same DDL via `env.DB.prepare(...).run()` plus `.catch(()=>{})` on extension/indexes.

**worker/pgcompat.js:** `document_chunks: ['id']`.

### Step 4: Run test — PASS
```
$ node --test tui/src/mcp-athena.test.js
# Subtest: checkRank — blocks personal for non-GOD — ok 1
# Subtest: chunkText — preserves para_idx — ok 1
tests 2, pass 2, fail 0
```
✅ PASS.

Additional manual verification:
```
chunkText('para1\n\npara2 hello', {chunkTokens:10, overlap:0}) → [{para_idx:1},{para_idx:2}]
chunkText(700 tokens + '\n\n' + 700 tokens, {600,120}) → 4 chunks, para_idx preserved per split (600,220,600,220)
ensureChunksTable(fakePool) → 3 calls (table + 2 indexes)
```

### Step 5: Commit
```bash
git add tui/src/mcp-athena.js tui/src/mcp-athena.test.js worker/schema.sql worker/index.js worker/pgcompat.js
git commit -m "feat(storage): document_chunks with para_idx + chunker"
# [dev 5455994] feat(storage): document_chunks with para_idx + chunker
# 5 files changed, 71 insertions(+), 1 deletion(-)
```

## Verification
- `node --test tui/src/mcp-athena.test.js` — PASS (2/2) after, FAIL (1/1) before as expected.
- `npm run lint` — 0 errors (eslint .). Fixed worker `no-unused-vars` by `export async function ensureChunksTable` (tui version already exported, worker now exported).
- `node --check tui/src/mcp-athena.js` / `tui/src/mcp-athena.test.js` / `worker/index.js` — syntax OK.
- `tui/src/index.js` diff — none (constraint satisfied).
- `engines.node >=22.5` — preserved (`tui/package.json:7`), runtime `v22.17.0`.
- `git log --oneline dev` — `5455994` on top of `e9069d4`.
- `git diff --stat HEAD` before commit — only 5 files above, no index.js touch.
- `worker/schema.sql` contains `document_chunks`, `vector(1536)`, `tsv`, `ivfflat`, `gin`.

## Interfaces Implemented
- `chunkText(content, {chunkTokens=600, overlap=120}) → [{chunk_idx, para_idx, page, content, token_count}]` — consumes `pg` Pool `DATABASE_URL` indirectly via caller, produces chunks with `para_idx` from `/\n\s*\n/` split, `page:1` placeholder (pdf.js page wiring in Task 3).
- `ensureChunksTable(pgPool)` — consumes `pg` Pool `DATABASE_URL`, creates table + indexes idempotently; TUI version uses `pool.query`, Worker version uses `env.DB.prepare(...).run()` with pgcompat translation.

## Concerns / Follow-ups
- **SQL dialect split:** `worker/schema.sql` uses Postgres `VECTOR(1536)`/`TSVECTOR`/`ivfflat`/`gin` which requires `pgvector` extension. TUI `ensureChunksTable(pool)` creates minimal table without `embedding`/`tsv` columns (matches brief's JS snippet) — will need migration (`ALTER TABLE ADD COLUMN IF NOT EXISTS`) when vector/tsv backfilled, or unify to full DDL. Worker version already creates full columns.
- **Extension handling:** `CREATE EXTENSION IF NOT EXISTS vector` requires superuser; self-host Postgres 14+ must have `pgvector` installed. Worker catches failure via `.catch(()=>{})` to avoid crashing on restricted DBs, but then `VECTOR` column/index creation will still fail if extension missing — consider wrapping table/index creation in same catch or documenting prerequisite.
- **Overlap edge:** Guarded `step>0` else `chunkTokens` prevents infinite loop if `overlap>=chunkTokens`; brief's naive `i += chunkTokens - overlap` would hang. No test covers this, but guard is safe and does not alter brief's nominal case.
- **Empty para handling:** Added `filter(Boolean)` and `if(tokens.length===0) continue` to skip blank paragraphs from trailing `\n\n`; brief's snippet without filter would produce a chunk with `[""]` and `token_count 1` for empty input — minor behavioral delta but more correct.
- **Extra files committed:** Brief listed only 3 files; also committed `worker/index.js` and `worker/pgcompat.js` to satisfy `ensureChunksTable` contract and `PRIMARY_KEYS` and keep `npm run lint` green (otherwise worker `no-unused-vars`). If strict brief adherence required, these can be split to separate commit.
- **Chunker page stub:** `page:1` hardcoded; real `pdf.js` integration (Task 3) will need `page` from PDF parser. Current para split is `\n\s*\n` only — does not handle `\r\n` or single-newline paragraph detection.
- **Index naming:** Brief expects `idx_chunks_doc` and `idx_chunks_scope`; we also add `idx_chunks_embedding` and `idx_chunks_tsv` per SQL append comment — ensure not to collide with future migrations.
- **Not yet wired:** `ensureChunksTable` not yet called lazily on first `athena_dump` (Task 3 wiring); manual call required until then.
