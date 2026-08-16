import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRank, chunkText, clampLimit, clearRankCache, buildWhere, invalidateRankCache, requireCommunityTarget, __resetChunksEnsuredForTests } from './mcp-athena.js';

let mockUser = { is_god: false, id: 'u1' };
let mockCommunities = [];
let fetchCalls = [];
let mockStatus = null; // when set, every fetch responds with this status
let mockSearchLinks = [];
let mockDocuments = [];

global.fetch = async (url, _opts) => {
  fetchCalls.push(String(url));
  const u = String(url);
  if (mockStatus !== null) {
    return { ok: false, status: mockStatus, json: async () => ({}), text: async () => '' };
  }
  if (u.includes('/api/auth/me')) {
    return { ok: true, json: async () => ({ user: mockUser }), text: async () => JSON.stringify({ user: mockUser }) };
  }
  if (u.includes('/api/communities')) {
    return { ok: true, json: async () => ({ communities: mockCommunities }), text: async () => JSON.stringify({ communities: mockCommunities }) };
  }
  if (u.includes('/api/links/search')) {
    return { ok: true, json: async () => ({ links: mockSearchLinks }), text: async () => '' };
  }
  if (u.includes('/api/documents')) {
    return { ok: true, json: async () => ({ documents: mockDocuments }), text: async () => '' };
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

describe('rank cache invalidation on server 401/403', () => {
  beforeEach(() => {
    clearRankCache();
    mockStatus = null;
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [{ id: 'c1', rank: 'member' }];
    fetchCalls = [];
  });
  it('a 403 from any API call drops the cached rank for that token', async () => {
    const handler = await import('./mcp-athena.js');
    mockUser = { is_god: true, id: 'god1' };
    await checkRank('tok-inv', 'https://ex.com', 'community', 'c1'); // primes cache
    fetchCalls = [];
    mockStatus = 403;
    // community scope without community_id via proxy path would hit the guard
    // first, so use a community call whose underlying /api/links/search 403s
    await assert.rejects(() => handler.handleAthenaSearch({ query: 'x', scope: 'community' }, null, 'tok-inv', 'https://ex.com', 'c1'), /403/);
    mockStatus = null;
    // cache was invalidated: the next rank check must re-fetch auth/me
    fetchCalls = [];
    await checkRank('tok-inv', 'https://ex.com', 'community', 'c1');
    assert.equal(fetchCalls.filter((u) => u.includes('/api/auth/me')).length, 1);
  });
  it('invalidateRankCache is a no-op for empty inputs', () => {
    assert.doesNotThrow(() => invalidateRankCache('', ''));
    assert.doesNotThrow(() => invalidateRankCache(null, null));
  });
});

describe('requireCommunityTarget (proxy-mode membership gap)', () => {
  beforeEach(() => { clearRankCache(); mockStatus = null; });
  it('rejects community scope without communityId before any request', async () => {
    assert.throws(() => requireCommunityTarget('community', ''), /community_id required/);
    assert.throws(() => requireCommunityTarget('community', null), /community_id required/);
    assert.doesNotThrow(() => requireCommunityTarget('personal', ''));
    assert.doesNotThrow(() => requireCommunityTarget('community', 'c1'));
  });
  it('proxy-mode handlers reject community scope with no ATHENA_COMMUNITY_ID', async () => {
    const handler = await import('./mcp-athena.js');
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [{ id: 'c1', rank: 'member' }];
    fetchCalls = [];
    await assert.rejects(
      () => handler.handleAthenaSearch({ query: 'x', scope: 'community' }, null, 'tok-g1', 'https://ex.com', undefined),
      /ATHENA_COMMUNITY_ID/
    );
    await assert.rejects(
      () => handler.handleAthenaDump({ content: 'x', filename: 'f.md', scope: 'community' }, null, 'tok-g1', 'https://ex.com', undefined),
      /ATHENA_COMMUNITY_ID/
    );
    // no request fired past checkRank's own auth/me + communities calls
    assert.ok(!fetchCalls.some((u) => u.includes('/api/links') || u.includes('/api/documents')));
  });
});

describe('proxy fallback exact doc_id matching', () => {
  beforeEach(() => {
    clearRankCache();
    mockStatus = null;
    mockUser = { is_god: false, id: 'u1' };
    mockCommunities = [{ id: 'c1', rank: 'member' }];
    mockSearchLinks = [];
    mockDocuments = [];
    fetchCalls = [];
  });
  it('prefers exact id over url-substring and labels substring hits approximate', async () => {
    const handler = await import('./mcp-athena.js');
    mockSearchLinks = [
      { id: 'link_9', url: 'https://example.com/docs/guide', title: 'Guide', notes: '' },
      { id: 'link_1', url: 'https://example.com/docs/guide-part-2', title: 'Guide 2', notes: '' },
    ];
    const exact = await handler.handleAthenaGetChunk({ doc_id: 'link_1', para_idx: 1, scope: 'community' }, null, 'tok-e1', 'https://ex.com', 'c1');
    assert.equal(exact.approximate, undefined);
    const approx = await handler.handleAthenaGetChunk({ doc_id: 'example.com/docs/guide', para_idx: 1, scope: 'community' }, null, 'tok-e1', 'https://ex.com', 'c1');
    assert.equal(approx.approximate, true);
    assert.equal(approx.doc_id, 'example.com/docs/guide');
  });
  it('matches dumped documents by filename as doc_id', async () => {
    const handler = await import('./mcp-athena.js');
    mockSearchLinks = [];
    mockDocuments = [{ id: 'doc_abc', filename: 'notes.md', content: 'body text' }];
    const hit = await handler.handleAthenaGetDoc({ doc_id: 'notes.md', scope: 'community' }, null, 'tok-e2', 'https://ex.com', 'c1');
    assert.equal(hit.doc_id, 'notes.md');
    assert.ok(hit.chunks[0].content.includes('body text'));
  });
});
