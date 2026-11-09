// Athena advanced mode — generic MCP, no vendor lock-in.
//
// Formerly opencode-launcher.js. The advanced terminal no longer spawns
// opencode. It prints a minimal MCP stdio config that any MCP-capable agent
// (Hermes, Claude Code, Codex, generic MCP hosts) can consume.

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function mcpConfigFor(state, env = process.env) {
  const mcpPath = new URL('./mcp-athena.js', import.meta.url).pathname;
  return {
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
}

export async function launchAdvanced(state, io = {}, _theme) {
  const err = io?.stderr ?? process.stderr;
  const cfg = mcpConfigFor(state, io?.env ?? process.env);
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'athena-mcp-')));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(cfg, null, 2));
  const text = [
    'Athena MCP ready — connect any agent.',
    '',
    `Config written to ${join(dir, 'mcp.json')}`,
    'Hermes: add mcpServers.athena to your MCP config and restart the gateway.',
    'Claude Code: `claude mcp add athena -- node ' + cfg.mcpServers.athena.args[0] + '`',
    'Codex: add the same command/args/env under mcp_servers.',
    '',
    'Tools: athena_search, athena_get_doc, athena_get_chunk, athena_list, athena_dump.',
    'Env: ATHENA_INSTANCE, ATHENA_TOKEN, ATHENA_COMMUNITY_ID (community scope).',
  ].join('\n');
  try { err.write(text + '\n'); } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return { printed: true, config: cfg };
}

// Deprecated alias — advanced mode no longer needs opencode.
export function isOpencodeAvailable() {
  return false;
}

export function isAdvancedAvailable() {
  return true;
}

export function __resetAvailableCacheForTests() {}
