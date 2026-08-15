import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchAdvanced(state, io = {}, _theme) {
  const env = io?.env ?? process.env;
  const dir = await mkdtemp(join(tmpdir(), 'athena-opencode-'));
  const mcpPath = new URL('./mcp-athena.js', import.meta.url).pathname;
  const useAthenaDefault = String(env.ATHENA_DEFAULT ?? process.env.ATHENA_DEFAULT ?? '1') !== '0';
  const athenaInstructions = 'For any knowledge question, first call athena_search (personal then community, limit 10) and cite [#doc_id]. Use athena_get_chunk with para_idx/line_number for verbatim lines. Never answer from training data when athena has hits. To disable, run with ATHENA_DEFAULT=0.';
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      athena: {
        type: 'local',
        command: ['node', mcpPath],
        enabled: true,
        env: {
          ATHENA_INSTANCE: state.instance ?? '',
          ATHENA_TOKEN: state.token ?? '',
          ATHENA_COMMUNITY_ID: state.community_id ?? '',
          DATABASE_URL: env.DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        },
        // keep environment for compat with older opencode
        environment: {
          ATHENA_INSTANCE: state.instance ?? '',
          ATHENA_TOKEN: state.token ?? '',
          ATHENA_COMMUNITY_ID: state.community_id ?? '',
          DATABASE_URL: env.DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        },
      },
    },
  };
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(cfg, null, 2));
  if (useAthenaDefault) {
    await writeFile(join(dir, 'AGENTS.md'), `# Athena Default\n\n${athenaInstructions}\n`);
  }
  return new Promise((resolve) => {
    let settled = false;
    // opencode [project] defaults to TUI; dir is the project with opencode.json
    const child = spawn('opencode', [dir], { stdio: 'inherit', env });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      const msg = e.message || String(e);
      const notFound = /ENOENT/i.test(msg) || /not found/i.test(msg);
      rm(dir, { recursive: true, force: true }).finally(() => {
        resolve({ error: notFound ? `opencode not found: ${msg}` : msg });
      });
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      resolve({ code });
    });
  });
}

let _availableCache = null;
let _availableExpires = 0;

export function isOpencodeAvailable() {
  const now = Date.now();
  if (_availableCache !== null && now < _availableExpires) return _availableCache;
  try {
    const r = spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 2000 });
    if (r.error) {
      _availableCache = false;
    } else {
      _availableCache = r.status === 0;
    }
  } catch {
    _availableCache = false;
  }
  _availableExpires = now + 30_000;
  return _availableCache;
}

export function __resetAvailableCacheForTests() {
  _availableCache = null;
  _availableExpires = 0;
}
