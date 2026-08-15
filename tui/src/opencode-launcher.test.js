import { it } from 'node:test';
import assert from 'node:assert/strict';
import { launchAdvanced } from './opencode-launcher.js';
it('fails gracefully if opencode missing', async () => {
  const res = await launchAdvanced({ instance: 'https://ex', token: 't' }, { env: { PATH: '' } });
  assert.match(res.error, /not found/);
});
