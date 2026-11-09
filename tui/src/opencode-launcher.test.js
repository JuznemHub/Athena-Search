import { it } from 'node:test';
import assert from 'node:assert/strict';
import { launchAdvanced, mcpConfigFor, isOpencodeAvailable } from './opencode-launcher.js';

it('prints generic MCP config without spawning a vendor CLI', async () => {
  let out = '';
  const res = await launchAdvanced(
    { instance: 'https://ex', token: 't', community_id: 'c1' },
    { env: {}, stderr: { write: (s) => { out += s; } } },
  );
  assert.equal(res.printed, true);
  assert.equal(res.config.mcpServers.athena.command, 'node');
  assert.match(out, /Hermes/);
});

it('mcpConfigFor carries instance, token and community', async () => {
  const cfg = mcpConfigFor({ instance: 'https://ex/', token: 'tok', community_id: 'c9' }, {});
  assert.equal(cfg.mcpServers.athena.env.ATHENA_TOKEN, 'tok');
  assert.equal(cfg.mcpServers.athena.env.ATHENA_COMMUNITY_ID, 'c9');
});

it('opencode availability stays false (deprecated alias)', async () => {
  assert.equal(isOpencodeAvailable(), false);
});
