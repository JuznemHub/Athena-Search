import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRank, chunkText, clampLimit, clearRankCache, buildWhere, __resetChunksEnsuredForTests } from './mcp-athena.js';

let mockUser = { is_god: false, id: 'u1' };
let mockCommunities = [];
let fetchCalls = [];

global.fetch = async (url, _opts) => {
  fetchCalls.push(String(url));
  const u = String(url);
  if (u.includes('/api/auth/me')) {
    return { ok: true, json: async () => ({ user: mockUser }), text: async () => JSON.stringify({ user: mockUser }) };
  }
  if (u.includes('/api/communities')) {
    return { ok: true, json: async () => ({ communities: mockCommunities }), text: async () => JSON.stringify({ communities: mockCommunities }) };
  }
  return { ok: true, json: async () => ({}), text: async () => '' };
};

describe('checkRank', () => {
  beforeEach(() => {
    clearRankCache();
    __resetChunksEnsuredForTests();
    fetchCalls = [];
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [];
  });
  it('blocks personal for non-GOD', async () => {
    const r = await checkRank('tok', 'https://ex.com', 'personal');
    assert.equal(r.isGod, false);
  });
  it('uses POST for auth/me and caches 60s', async () => {
    mockUser = { is_god: true, id: 'god1' };
    mockCommunities = [{ id: 'c1', rank: 'member' }];
    const r1 = await checkRank('tok2', 'https://ex.com', 'community', 'c1');
    assert.equal(r1.isGod, true);
    assert.equal(fetchCalls.filter((u) => u.includes('/api/auth/me')).length, 1);
    fetchCalls = [];
    const r2 = await checkRank('tok2', 'https://ex.com', 'community', 'c1');
    assert.equal(r2.isGod, true);
    assert.equal(fetchCalls.filter((u) => u.includes('/api/auth/me')).length, 0);
  });
  it('detects banned community', async () => {
    mockUser = { is_god: false, id: 'u2' };
    mockCommunities = [{ id: 'c1', rank: 'banned' }];
    const r = await checkRank('tok-banned', 'https://ex.com', 'community', 'c1');
    assert.equal(r.isBanned, true);
  });
  it('detects non-member', async () => {
    mockUser = { is_god: false, id: 'u3' };
    mockCommunities = [{ id: 'c2', rank: 'member' }];
    const r = await checkRank('tok-nonmember', 'https://ex.com', 'community', 'c1');
    assert.equal(r.isMember, false);
  });
});

describe('chunkText', () => {
  it('preserves para_idx', () => {
    const out = chunkText('para1\n\npara2\n\npara3', { chunkTokens: 10, overlap: 0 });
    assert.equal(out[0].para_idx, 1);
    assert.equal(out[1].para_idx, 2);
  });
  it('handles overlap and page default', () => {
    const out = chunkText('a b c d e f g h i j k l', { chunkTokens: 5, overlap: 2 });
    assert.ok(out.length > 1);
    assert.equal(out[0].page, 1);
  });
});

describe('clampLimit', () => {
  it('clamps SQLi and extremes (C5)', () => {
    assert.equal(clampLimit(999), 50);
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-5), 1);
    assert.equal(clampLimit('10; DROP TABLE'), 8);
    assert.equal(clampLimit(3.5), 8);
    assert.equal(clampLimit(10), 10);
  });
});

describe('buildWhere', () => {
  it('uses scope/scope_key and checks GOD', () => {
    const me = { id: 'u1', is_god: false };
    assert.throws(() => buildWhere('personal', me, 'c1'), /GOD only/);
    const god = { id: 'g1', is_god: true };
    const w = buildWhere('personal', god, 'c1');
    assert.equal(w.clause, 'scope=$1 AND scope_key=$2');
    assert.deepEqual(w.params, ['personal', 'g1']);
    const w2 = buildWhere('community', god, 'c99');
    assert.deepEqual(w2.params, ['community', 'c99']);
  });
});

describe('handleAthenaSearch', () => {
  beforeEach(() => {
    clearRankCache();
    __resetChunksEnsuredForTests();
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [];
    fetchCalls = [];
  });
  it('athena_search blocks personal for non-GOD', async () => {
    const fakePool = { query: async () => ({ rows: [] }) };
    const handler = await import('./mcp-athena.js');
    await assert.rejects(() => handler.handleAthenaSearch({ query: 'hi', scope: 'personal' }, fakePool, 'tok', 'https://ex'), /GOD only/);
  });
  it('blocks banned community', async () => {
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [{ id: 'c1', rank: 'banned' }];
    clearRankCache();
    const fakePool = { query: async () => ({ rows: [] }) };
    const handler = await import('./mcp-athena.js');
    await assert.rejects(() => handler.handleAthenaSearch({ query: 'hi', scope: 'community', limit: 5 }, fakePool, 'tok-banned2', 'https://ex', 'c1'), /banned/);
  });
  it('clamps limit to 50 and uses parameterized query', async () => {
    mockUser = { is_god: true, id: 'god1' };
    mockCommunities = [{ id: 'c1', rank: 'member' }];
    clearRankCache();
    __resetChunksEnsuredForTests();
    let capturedSql = '';
    let capturedParams = [];
    const fakePool = {
      query: async (sql, params) => {
        const s = String(sql);
        if (s.includes('CREATE') || s.includes('ALTER') || s.trim().startsWith('CREATE EXTENSION')) return { rows: [] };
        if (!s.includes('SELECT')) return { rows: [] };
        capturedSql = s;
        capturedParams = params;
        return { rows: [] };
      },
    };
    const handler = await import('./mcp-athena.js');
    await handler.handleAthenaSearch({ query: 'hello', scope: 'community', limit: 999 }, fakePool, 'tok-limit', 'https://ex', 'c1');
    assert.ok(capturedSql.includes('LIMIT $4'), 'should use parameterized LIMIT $4');
    assert.equal(capturedParams[capturedParams.length - 1], 50);
    assert.ok(!capturedSql.includes('999'));
  });
});

describe('handleAthenaGetChunk rank gate', () => {
  beforeEach(() => {
    clearRankCache();
    __resetChunksEnsuredForTests();
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [];
  });
  it('requires membership for community chunk', async () => {
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [];
    clearRankCache();
    const fakePool = { query: async () => ({ rows: [] }) };
    const handler = await import('./mcp-athena.js');
    await assert.rejects(() => handler.handleAthenaGetChunk({ doc_id: 'd1', para_idx: 1, scope: 'community' }, fakePool, 'tok-nomem', 'https://ex', 'c1'), /member/);
  });
});
