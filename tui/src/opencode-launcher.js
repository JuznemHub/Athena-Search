import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchAdvanced(state, io = {}, _theme) {
  const env = io?.env ?? process.env;
  const dir = await mkdtemp(join(tmpdir(), 'athena-opencode-'));
  const mcpPath = new URL('./mcp-athena.js', import.meta.url).pathname;
  const cfg = {
    mcpServers: {
      athena: {
        command: 'node',
        args: [mcpPath],
        env: {
          ATHENA_INSTANCE: state.instance ?? '',
          ATHENA_TOKEN: state.token ?? '',
          ATHENA_COMMUNITY_ID: state.community_id ?? '',
          DATABASE_URL: env.DATABASE_URL ?? process.env.DATABASE_URL ?? '',
        },
      },
    },
  };
  // also expose `mcp` key for opencode variants that use `mcp` instead of `mcpServers`
  cfg.mcp = cfg.mcpServers;
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(cfg, null, 2));
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn('opencode', ['--config', dir], { stdio: 'inherit', env });
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

export function isOpencodeAvailable() {
  try {
    const r = spawnSync('opencode', ['--version'], { stdio: 'ignore' });
    if (r.error) return false;
    return r.status === 0;
  } catch {
    return false;
  }
}
