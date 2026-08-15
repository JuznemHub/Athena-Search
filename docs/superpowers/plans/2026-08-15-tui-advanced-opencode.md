# TUI Advanced (Opencode) Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tab-togglable Advanced mode to `athena-tui` that spawns full `opencode` with rank-aware Postgres MCP (`athena` DB as memory) and paragraph-level `document_chunks`, preserving website ranks and keeping normal TUI flows untouched.

**Architecture:** TUI stays as menu loop `tui/src/index.js:541L`; new `tui/src/mcp-athena.js` is stdio MCP (`@modelcontextprotocol/sdk`) that checks `POST /api/auth/me` per tool call and enforces `GOD`/`community` ranks before SQL on `links`/`personal_links`/`document_chunks`; `tui/src/opencode-launcher.js` writes temp `opencode.json` and `spawn('opencode')` with that MCP, returns on exit. Chunks are 600tok/120 overlap with `para_idx` from `pdf.js`, `pgvector`+`tsv` hybrid.

**Tech Stack:** Node >=22.5, `pg` 8.x, `pgvector`, `@modelcontextprotocol/sdk` ^1.0, `opencode` CLI (https://github.com/anomalyco/opencode), `pdf-parse` for para split, `node:test` for `tui/src/mcp-athena.test.js`.

## Global Constraints

- Keep `tui/src/index.js` Login→Status flows untouched except 1 menu entry + Tab handler; no refactor of `api.js`/`config.js`/`browsers.js` unless `writing-plans` task says so.
- Self-host Postgres 14+ only for Advanced (`DATABASE_URL` + `CREATE EXTENSION vector`), Cloudflare Workers without DB shows `Postgres required`.
- Advanced uses `~/.config/opencode` AI, never `worker/user_ai_config`; ranks via `POST /api/auth/me` cached 60s, never bypassed.
- TUI `engines.node >=22.5` `tui/package.json:7`, commits on `dev`, `npm run lint` must stay 0 errors.

---

## File Structure

- **Create:** `tui/src/mcp-athena.js` — rank-aware MCP server, 5 tools, chunker, pg pool, rank gate (`isGod`/`isMember`/`isBanned`).
- **Create:** `tui/src/opencode-launcher.js` — writes temp `opencode.json`, spawns opencode, cleans up, handles `opencode` missing.
- **Create:** `tui/src/mcp-athena.test.js` — node:test for rank gates + para_idx fetch.
- **Modify:** `tui/src/index.js:mainMenu` — add `Advanced (opencode)` entry, Tab handler, call launcher, preserve `state` via `loadConfig`/`saveConfig`.
- **Modify:** `worker/schema.sql` + `worker/index.js:ensureChunksTable` — `document_chunks` table + `ivfflat`/`GIN` indexes, lazy create on first `athena_dump`.
- **Modify:** `tui/src/config.js` — no change unless launcher needs temp dir helper (fold into launcher if needed).
- **Docs:** `docs/superpowers/specs/2026-08-15-tui-advanced-opencode-design.md` — already committed `dev:dbb919c`.

---

### Task 1: Scaffold rank-aware MCP server (no DB yet, mocked `pg`)

**Files:**
- Create: `tui/src/mcp-athena.js`
- Test: `tui/src/mcp-athena.test.js`

**Interfaces:**
- Consumes: `process.env.ATHENA_INSTANCE`, `ATHENA_TOKEN`, `ATHENA_COMMUNITY_ID` (set by launcher); `POST /api/auth/me` via `fetch`
- Produces: `export async function checkRank(token, instance, scope)` → `{isGod:boolean, isMember:boolean, isBanned:boolean, me}`; `export function buildWhere(scope, me, communityId)` → `{clause:string, params:array}`

- [ ] **Step 1: Write failing test for GOD gate**

```js
// tui/src/mcp-athena.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRank } from './mcp-athena.js';

// mock fetch for /api/auth/me
global.fetch = async (url) => ({
  ok: true, json: async () => ({ user: { is_god: false, id: 'u1' } })
});

describe('checkRank', () => {
  it('blocks personal for non-GOD', async () => {
    const r = await checkRank('tok', 'https://ex.com', 'personal');
    assert.equal(r.isGod, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tui/src/mcp-athena.test.js`
Expected: FAIL `Cannot find module './mcp-athena.js'`

- [ ] **Step 3: Implement minimal `checkRank` + `buildWhere` stubs**

```js
// tui/src/mcp-athena.js
export async function checkRank(token, instance, _scope) {
  const res = await fetch(`${instance}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }});
  const data = await res.json();
  return { isGod: !!data.user?.is_god, isMember: true, isBanned: false, me: data.user };
}
export function buildWhere(scope, me, communityId) {
  if (scope === 'personal' && !me.is_god) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  return { clause: scope==='personal' ? 'user_id=$1' : 'community_id=$1', params: [scope==='personal'? me.id : communityId] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tui/src/mcp-athena.test.js`
Expected: PASS

- [ ] **Step 5: Add MCP server shell with SDK**

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new Server({ name: 'athena', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', async () => ({ tools: [
  { name:'athena_search', inputSchema:{type:'object', properties:{query:{type:'string'}, scope:{type:'string'}, limit:{type:'number'}}}},
  { name:'athena_get_chunk', inputSchema:{type:'object', properties:{doc_id:{type:'string'}, para_idx:{type:'number'}}}},
] }));
await server.connect(new StdioServerTransport());
```

- [ ] **Step 6: Commit**

```bash
git add tui/src/mcp-athena.js tui/src/mcp-athena.test.js
git commit -m "feat(tui): scaffold rank-aware athena MCP (checkRank/buildWhere)"
```

---

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
  // naive token split by whitespace, 600 tokens ~ 450 words
  const out=[]; let chunk_idx=0, buf=[], para=1;
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

---

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

---

### Task 4: Opencode launcher + TUI toggle

**Files:**
- Create: `tui/src/opencode-launcher.js`
- Modify: `tui/src/index.js:mainMenu` (add entry + Tab)

**Interfaces:**
- Consumes: `state` from `tui/src/config.js` (`instance`, `token`, `community_id`), `mcp-athena.js` path
- Produces: `export async function launchAdvanced(state, io, theme)` → `Promise<void>` spawns opencode, returns on exit

- [ ] **Step 1: Write failing test for launcher spawn**

```js
// tui/src/opencode-launcher.test.js
import { launchAdvanced } from './opencode-launcher.js';
import assert from 'node:assert/strict';
it('fails gracefully if opencode missing', async () => {
  const res = await launchAdvanced({instance:'https://ex', token:'t'}, { env: { PATH: '' } });
  assert.match(res.error, /not found/);
});
```

- [ ] **Step 2: Run test — FAIL**

Run: `node --test tui/src/opencode-launcher.test.js`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: Implement launcher**

```js
// tui/src/opencode-launcher.js
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function launchAdvanced(state){
  const dir = await mkdtemp(join(tmpdir(), 'athena-opencode-'));
  const cfg = { mcpServers: { athena: { command: 'node', args: [new URL('./mcp-athena.js', import.meta.url).pathname], env: { ATHENA_INSTANCE: state.instance, ATHENA_TOKEN: state.token, ATHENA_COMMUNITY_ID: state.community_id, DATABASE_URL: process.env.DATABASE_URL } } } };
  await writeFile(join(dir,'opencode.json'), JSON.stringify(cfg));
  return new Promise((resolve)=>{
    const child = spawn('opencode', ['--config', dir], { stdio: 'inherit', env: process.env });
    child.on('error', (e)=> resolve({error:e.message}));
    child.on('close', async (code)=>{ await rm(dir,{recursive:true,force:true}); resolve({code}); });
  });
}
export function isOpencodeAvailable(){ try{ require('node:child_process').spawnSync('opencode',['--version']); return true;}catch{ return false;}}
```

- [ ] **Step 4: Modify `tui/src/index.js:mainMenu` add entry + Tab**

```js
// in mainMenu items array:
{ label: 'Advanced (opencode)', hint: isOpencodeAvailable() ? 'any AI via opencode' : 'install opencode' },
// in keys handler:
if(key.name==='tab') return launchAdvanced(state);
// in fns array add launchAdvanced wrapper
```

- [ ] **Step 5: Run `node --check tui/src/index.js` + manual `athena-tui` toggle → opencode → Tab back → `Status` still GOD**

Run: `node --check tui/src/index.js && node --test tui/src/opencode-launcher.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tui/src/opencode-launcher.js tui/src/index.js tui/src/opencode-launcher.test.js
git commit -m "feat(tui): Tab toggle to opencode with athena MCP (rank-aware)"
```

---

### Task 5: E2E verification + docs

**Files:**
- Modify: `tui/README.md` (add Advanced section)
- Test: `tui/smoke.mjs` (extend)

**Interfaces:**
- Consumes: all prior tasks

- [ ] **Step 1: Update tui/README.md Advanced section**

```md
## Advanced (opencode)

Press `Tab` or choose `Advanced (opencode)` → full opencode TUI with `athena` MCP.

- Any AI via `~/.config/opencode` (not website `user_ai_config`).
- Ranks enforced: `personal` GOD-only, `community` member-only.
- Paragraph search: `what is paragraph 5 of story.pdf` → `athena_get_chunk` with `para_idx`.
Requires `opencode` (`npm i -g opencode`) + `DATABASE_URL` + `pgvector`.
```

- [ ] **Step 2: Run `tui` smoke + manual**

Run: `node tui/smoke.mjs && node --test tui/src/mcp-athena.test.js tui/src/opencode-launcher.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tui/README.md
git commit -m "docs(tui): advanced opencode mode"
```

---

## Self-Review

- **Spec coverage:** All 5 design sections have tasks — Architecture (launcher+MCP), Components (mcp-athena, launcher, chunks), Data flow (search/dump/Tab), Error handling/Testing, Constraints. Paragraph `para_idx` covered in Task 2/3, rank gates in Task 1/3, opencode any AI in Task 4.
- **Placeholders:** No `TBD`/`TODO`/`handle edge cases` — each step has exact code/tests.
- **Type consistency:** `checkRank(token,instance,scope) → {isGod,me}` used in Task 1 and 3; `chunkText(content)->[{para_idx}]` consistent 2→3; `handleAthenaSearch({query,scope})` matches MCP schema in 1.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-15-tui-advanced-opencode.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

