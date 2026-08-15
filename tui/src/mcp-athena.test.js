import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRank, chunkText } from './mcp-athena.js';

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

describe('chunkText', () => {
  it('preserves para_idx', () => {
    const out = chunkText('para1\n\npara2\n\npara3', { chunkTokens: 10, overlap: 0 });
    assert.equal(out[0].para_idx, 1);
    assert.equal(out[1].para_idx, 2);
  });
});
