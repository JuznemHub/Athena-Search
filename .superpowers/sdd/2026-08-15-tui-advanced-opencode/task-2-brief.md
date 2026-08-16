### Task 2: Document chunks schema + chunker (para_idx)

**Files:**
- Modify: `worker/schema.sql`
- Modify: `worker/index.js:ensureChunksTable` (new function, called lazily in `mcp-athena.js` first dump)
- Test: `tui/src/mcp-athena.test.js` (extend)

**Interfaces:**
- Consumes: `pg` Pool `DATABASE_URL`
- Produces: `export function chunkText(content, {chunkTokens=600, overlap=120}) → [{chunk_idx, para_idx, page, content, token_count}]`; `ensureChunksTable(pgPool)` creates table + indexes

- [ ] **Step 1: Write failing test for para_idx chunk**

```js
import { chunkText } from './mcp-athena.js';
it('preserves para_idx', () => {
  const out = chunkText("para1\n\npara2\n\npara3", { chunkTokens: 10, overlap: 0 });
  assert.equal(out[0].para_idx, 1);
  assert.equal(out[1].para_idx, 2);
});
```

- [ ] **Step 2: Run test — FAIL**

Run: `node --test tui/src/mcp-athena.test.js`
Expected: FAIL `chunkText is not a function`

- [ ] **Step 3: Implement chunker + schema**

```sql
-- worker/schema.sql append:
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL,
  token_count INTEGER, embedding VECTOR(1536), tsv TSVECTOR, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx);
-- requires: CREATE EXTENSION IF NOT EXISTS vector;
-- CREATE INDEX ON document_chunks USING ivfflat (embedding vector_l2_ops);
-- CREATE INDEX ON document_chunks USING gin(tsv);
```

```js
// tui/src/mcp-athena.js
export function chunkText(content, { chunkTokens=600, overlap=120 }={}) {
  const paras = String(content).split(/\n\s*\n/).map((p,i)=>({text:p, para_idx:i+1}));
  const out=[]; let chunk_idx=0;
  for(const paraObj of paras){
    const tokens = paraObj.text.split(/\s+/);
    for(let i=0;i<tokens.length;){
      const slice = tokens.slice(i, i+chunkTokens);
      out.push({ chunk_idx: chunk_idx++, para_idx: paraObj.para_idx, page: 1, content: slice.join(' '), token_count: slice.length });
      i += chunkTokens - overlap;
    }
  }
  return out;
}
export async function ensureChunksTable(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL, token_count INTEGER, created_at BIGINT NOT NULL)`);
}
```

- [ ] **Step 4: Run test — PASS**

Run: `node --test tui/src/mcp-athena.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/schema.sql tui/src/mcp-athena.js tui/src/mcp-athena.test.js
git commit -m "feat(storage): document_chunks with para_idx + chunker"
```

