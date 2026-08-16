# Task 1 Report — Scaffold rank-aware MCP server (checkRank/buildWhere)

**Status:** ✅ Done  
**Branch:** `dev`  
**Base:** `1a73431` → **Head:** `e9069d4`  
**Plan:** `docs/superpowers/plans/2026-08-15-tui-advanced-opencode.md` Task 1

## Summary
Scaffolded `tui/src/mcp-athena.js` with `checkRank`/`buildWhere` rank gate and MCP SDK shell plus failing-then-passing `node:test` coverage. Kept `tui/src/index.js` untouched per global constraint; installed `@modelcontextprotocol/sdk@1.30.0` for SDK shell.

## Files
- **Created:** `tui/src/mcp-athena.js` — exports `checkRank(token,instance,_scope)` (fetch `POST /api/auth/me` via `Authorization: Bearer`), `buildWhere(scope,me,communityId)` with `personal is GOD only` 403 gate, plus rank-aware MCP server shell (`Server` `athena@1.0.0`, `tools/list` with `athena_search`/`athena_get_chunk`, `StdioServerTransport` guarded to run only when `import.meta.url === file://process.argv[1]` and fallback to `ListToolsRequestSchema` for SDK 1.30 compatibility).
- **Created:** `tui/src/mcp-athena.test.js` — `node:test` mock `global.fetch` returning `{user:{is_god:false,id:'u1'}}`, asserts `checkRank(..., 'personal').isGod === false`.
- **Modified:** `package.json` + `package-lock.json` — added `@modelcontextprotocol/sdk ^1.30.0` (required for SDK imports to resolve).
- **Untouched:** `tui/src/index.js` (541L menu loop), `tui/package.json` engines `>=22.5`, `worker/schema.sql`.

## 6 Steps (TDD, verbatim values)

### Step 1: Write failing test for GOD gate
Wrote `tui/src/mcp-athena.test.js` verbatim from brief:
```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRank } from './mcp-athena.js';
global.fetch = async (_url) => ({ ok: true, json: async () => ({ user: { is_god: false, id: 'u1' } }) });
describe('checkRank', () => { it('blocks personal for non-GOD', async () => { const r=await checkRank('tok','https://ex.com','personal'); assert.equal(r.isGod,false); }); });
```
Note: `_url` prefix to satisfy `eslint` `argsIgnorePattern: ^_` (otherwise 1 lint error). Logic identical.

### Step 2: Run test to verify it fails
```
$ node --test tui/src/mcp-athena.test.js
ERR_MODULE_NOT_FOUND: Cannot find module '/root/Athena-Search/tui/src/mcp-athena.js'
tests 1, pass 0, fail 1
```
✅ Expected FAIL confirmed.

### Step 3: Implement minimal checkRank + buildWhere stubs
Wrote `tui/src/mcp-athena.js` verbatim from brief:
```js
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
Install SDK before Step 5: `npm install @modelcontextprotocol/sdk` (86 packages).

### Step 4: Run test to verify it passes
```
$ node --test tui/src/mcp-athena.test.js
# Subtest: blocks personal for non-GOD
ok 1 - blocks personal for non-GOD
tests 1, pass 1, fail 0
```
✅ PASS.

### Step 5: Add MCP server shell with SDK
Appended verbatim SDK shell (with SDK 1.30 compatibility guard):
```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new Server({ name: 'athena', version: '1.0.0' }, { capabilities: { tools: {} } });
const _athenaTools = [
  { name:'athena_search', inputSchema:{type:'object', properties:{query:{type:'string'}, scope:{type:'string'}, limit:{type:'number'}}}},
  { name:'athena_get_chunk', inputSchema:{type:'object', properties:{doc_id:{type:'string'}, para_idx:{type:'number'}}}},
];
try { server.setRequestHandler('tools/list', async () => ({ tools: _athenaTools })); }
catch { const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: _athenaTools })); }
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) { await server.connect(new StdioServerTransport()); }
export { server };
```
Guard prevents `connect()` during `node:test` import. Fallback handles SDK API change (`'tools/list'` string → `ListToolsRequestSchema` Zod) that otherwise throws `Schema is missing a method literal` on SDK 1.30.

Verification:
```
$ node --test tui/src/mcp-athena.test.js -> pass 1 fail 0
$ npm run lint -> 0 errors (fixed `_url` lint, SDK guard lint-clean)
```

### Step 6: Commit
```bash
git add tui/src/mcp-athena.js tui/src/mcp-athena.test.js package.json package-lock.json
git commit -m "feat(tui): scaffold rank-aware athena MCP (checkRank/buildWhere)"
# [dev e9069d4] feat(tui): scaffold rank-aware athena MCP (checkRank/buildWhere)
# 4 files changed, 1140 insertions(+)
```

## Verification
- `node --test tui/src/mcp-athena.test.js` — PASS (1/1) before and after SDK shell with guard.
- `npm run lint` — 0 errors (eslint .).
- `node --check tui/src/mcp-athena.js` / `node --check tui/src/mcp-athena.test.js` — syntax OK.
- `tui/src/index.js` diff — none (constraint satisfied).
- `engines.node >=22.5` — preserved (`tui/package.json:7`), runtime `v22.17.0`.
- `git log --oneline dev` — `e9069d4` on top of `1a73431`.

## Interfaces Implemented
- `checkRank(token, instance, scope) → {isGod, isMember, isBanned, me}` — consumes `ATHENA_INSTANCE/ATHENA_TOKEN/ATHENA_COMMUNITY_ID` env via caller + `POST /api/auth/me` via global `fetch`, caches not yet (Task 3 will add 60s cache).
- `buildWhere(scope, me, communityId) → {clause, params}` — GOD gate for `personal`, placeholder `user_id=$1` / `community_id=$1`.
- MCP `Server` `athena@1.0.0` with `tools/list` exposing `athena_search` + `athena_get_chunk` (no DB yet, handler wiring in Task 3).

## Concerns / Follow-ups
- **SDK API drift:** Brief’s `setRequestHandler('tools/list', …)` fails on SDK ≥1.10 (requires Zod schema). Added try/catch fallback to `ListToolsRequestSchema`; if plan expects strict verbatim without fallback, either pin SDK to 1.0.x or update brief to schema form. Current guard preserves verbatim string while keeping tests green.
- **Lint nuance:** Brief’s `global.fetch = async (url) =>` triggers `no-unused-vars` on `url`; fixed via `_url` (allowed by `argsIgnorePattern: ^_`). No functional change.
- **Dependency location:** Installed SDK in root `package.json`; if `athena-tui` is published separately, also add to `tui/package.json` dependencies.
- **No 60s rank cache yet:** Task 1 stub calls `fetch` per `checkRank`; caching deferred to Task 3 per plan.
- **No `pg` usage yet:** Pool wiring deferred to Tasks 2–3; current `buildWhere` uses `me.is_god` (API returns `is_god`), need to confirm `me` shape from worker `/api/auth/me` (seen `user.is_god` in smoke).
