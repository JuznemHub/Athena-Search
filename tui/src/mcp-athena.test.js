import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRank } from './mcp-athena.js';

// mock fetch for /api/auth/me
global.fetch = async (_url) => ({
  ok: true, json: async () => ({ user: { is_god: false, id: 'u1' } })
});

describe('checkRank', () => {
  it('blocks personal for non-GOD', async () => {
    const r = await checkRank('tok', 'https://ex.com', 'personal');
    assert.equal(r.isGod, false);
  });
});
