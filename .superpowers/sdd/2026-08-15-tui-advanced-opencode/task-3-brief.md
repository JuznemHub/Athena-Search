### Task 3: Implement MCP tools (search/dump) with rank gate + pg

**Files:**
- Modify: `tui/src/mcp-athena.js`
- Test: `tui/src/mcp-athena.test.js`

**Interfaces:**
- Consumes: `checkRank`, `chunkText`, `pg` Pool
- Produces: MCP tool handlers `athena_search`/`athena_dump` that call `pg.query` with rank-filtered where clauses

- [ ] **Step 1: Write failing test for athena_search rank filter**

```js
it('athena_search blocks personal for non-GOD', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const handler = await import('./mcp-athena.js');
  // mock checkRank to return non-GOD, then call tool
  await assert.rejects(() => handler.handleAthenaSearch({query:'hi', scope:'personal'}, fakePool, 'tok', 'https://ex'), /GOD only/);
});
```

- [ ] **Step 2: Run test — FAIL**

Run: `node --test tui/src/mcp-athena.test.js`
Expected: FAIL `handleAthenaSearch is not a function`

- [ ] **Step 3: Implement handlers**

```js
export async function handleAthenaSearch({query, scope='community', limit=8}, pool, token, instance, communityId){
  const { isGod, me } = await checkRank(token, instance, scope);
  if(scope==='personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), {code:403});
  const where = scope==='personal' ? 'scope=$1 AND scope_key=$2' : 'scope=$1 AND scope_key=$2';
  const params = scope==='personal' ? ['personal', me.id] : ['community', communityId];
  // hybrid placeholder: tsv + embedding (embedding stubbed to 0 vector until Workers AI wired)
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

- [ ] **Step 4: Run test — PASS**

Run: `node --test tui/src/mcp-athena.test.js`
Expected: PASS

- [ ] **Step 5: Wire SDK requestHandler for tools/call**

Add inside server `setRequestHandler('tools/call', async (req)=>{ switch(req.params.name){ case 'athena_search': return handleAthenaSearch(...) }})`

- [ ] **Step 6: Commit**

```bash
git add tui/src/mcp-athena.js tui/src/mcp-athena.test.js
git commit -m "feat(tui): athena_search/dump MCP tools with rank gate + pg"
```

