### Task 1: Scaffold rank-aware MCP server (no DB yet, mocked pg)

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

