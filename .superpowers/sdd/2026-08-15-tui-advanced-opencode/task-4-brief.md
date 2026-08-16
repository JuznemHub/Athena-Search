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

