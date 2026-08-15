import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const _rankCache = new Map();

export function clearRankCache() {
  _rankCache.clear();
}

export function clampLimit(limit) {
  let n = Number(limit);
  if (!Number.isFinite(n) || !Number.isInteger(n)) n = 8;
  if (n < 1) n = 1;
  if (n > 50) n = 50;
  return n;
}

export async function checkRank(token, instance, scope, communityId) {
  if (!token || !instance) {
    const e = new Error('Missing ATHENA_TOKEN or ATHENA_INSTANCE');
    e.code = 401;
    throw e;
  }
  const normInstance = String(instance).replace(/\/+$/, '');
  const cacheKey = `${normInstance}::${token}`;
  const now = Date.now();
  let entry = _rankCache.get(cacheKey);
  if (!entry || entry.expires < now) {
    const meRes = await fetch(`${normInstance}/api/auth/me`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) {
      const txt = await meRes.text().catch(() => '');
      const e = new Error(`auth/me failed: ${meRes.status} ${txt}`.trim());
      e.code = meRes.status;
      throw e;
    }
    const meData = await meRes.json().catch(() => ({}));
    const me = meData.user || meData.me || meData.data || meData;
    const isGod = !!(me?.is_god || me?.isGod || me?.god);
    let communities = [];
    try {
      const cRes = await fetch(`${normInstance}/api/communities`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (cRes.ok) {
        const cData = await cRes.json().catch(() => ({}));
        communities = cData.communities || cData.data || cData.rows || [];
        if (!Array.isArray(communities)) communities = [];
      }
    } catch {
      communities = [];
    }
    entry = { isGod, me, communities, expires: now + 60_000 };
    _rankCache.set(cacheKey, entry);
  }
  let isMember = true;
  let isBanned = false;
  if (scope === 'community' && communityId) {
    const cid = String(communityId);
    const found = entry.communities.find((c) => String(c.id) === cid);
    if (!found) {
      isMember = false;
    } else {
      isMember = true;
      if (found.rank === 'banned' || found.banned === true) isBanned = true;
    }
  } else if (scope === 'community' && !communityId) {
    isMember = entry.communities.length > 0;
  }
  return { isGod: entry.isGod, isMember, isBanned, me: entry.me, communities: entry.communities };
}

export function buildWhere(scope, me, communityId, offset = 0) {
  const isGod = !!(me?.is_god || me?.isGod || me?.god);
  if (scope === 'personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  if (scope === 'community' && !communityId) throw Object.assign(new Error('community_id required'), { code: 400 });
  const a = offset + 1;
  const b = offset + 2;
  const params = scope === 'personal' ? ['personal', String(me.id)] : ['community', String(communityId)];
  return { clause: `scope=$${a} AND scope_key=$${b}`, params };
}

export function chunkText(content, { chunkTokens = 600, overlap = 120 } = {}) {
  const paras = String(content).split(/\n\s*\n/).map((p, i) => ({ text: p, para_idx: i + 1 }));
  const out = [];
  let chunk_idx = 0;
  for (const paraObj of paras) {
    const tokens = paraObj.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    for (let i = 0; i < tokens.length;) {
      const slice = tokens.slice(i, i + chunkTokens);
      out.push({ chunk_idx: chunk_idx++, para_idx: paraObj.para_idx, page: 1, content: slice.join(' '), token_count: slice.length });
      const step = chunkTokens - overlap;
      i += step > 0 ? step : chunkTokens;
    }
  }
  return out;
}

export async function ensureChunksTable(pool) {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch {}
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      page INTEGER,
      para_idx INTEGER,
      content TEXT NOT NULL,
      token_count INTEGER,
      embedding VECTOR(1536),
      tsv TSVECTOR,
      created_at BIGINT NOT NULL
    )`);
  } catch (e) {
    const msg = String(e.message || '');
    if (/vector/i.test(msg) || /type "vector" does not exist/i.test(msg)) {
      await pool.query(`CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        page INTEGER,
        para_idx INTEGER,
        content TEXT NOT NULL,
        token_count INTEGER,
        created_at BIGINT NOT NULL
      )`);
      try { await pool.query('ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tsv TSVECTOR'); } catch {}
      try { await pool.query('ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding TEXT'); } catch {}
    } else {
      throw e;
    }
  }
  try { await pool.query('ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tsv TSVECTOR'); } catch {}
  await pool.query('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx)');
  try { await pool.query('CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING gin(tsv)'); } catch {}
  try { await pool.query('CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks USING ivfflat (embedding vector_l2_ops)'); } catch {}
}

let _chunksEnsured = false;
async function ensureOnce(pool) {
  if (_chunksEnsured) return;
  await ensureChunksTable(pool);
  _chunksEnsured = true;
}
export function __resetChunksEnsuredForTests() {
  _chunksEnsured = false;
}

let _pool = null;
let _poolConnStr = null;
export async function getPool() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    const e = new Error('DATABASE_URL not configured - Postgres required');
    e.code = 503;
    throw e;
  }
  if (_pool && _poolConnStr === connStr) return _pool;
  if (_pool) {
    try { await _pool.end(); } catch {}
    _pool = null;
  }
  const { Pool } = await import('pg');
  _pool = new Pool({ connectionString: connStr });
  _poolConnStr = connStr;
  _pool.on('error', () => {});
  return _pool;
}
export async function __closePoolForTests() {
  if (_pool) {
    try { await _pool.end(); } catch {}
    _pool = null;
    _poolConnStr = null;
  }
  _chunksEnsured = false;
}

export async function handleAthenaSearch({ query, scope = 'community', limit = 8 }, pool, token, instance, communityId) {
  if (!query || typeof query !== 'string' || !query.trim()) throw Object.assign(new Error('query required'), { code: 400 });
  const lim = clampLimit(limit);
  const { isGod, isMember, isBanned, me } = await checkRank(token, instance, scope, communityId);
  if (scope === 'personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  if (scope === 'community' && communityId) {
    if (isBanned) throw Object.assign(new Error('banned from community'), { code: 403 });
    if (!isMember) throw Object.assign(new Error('not a member of community'), { code: 403 });
  }
  const where = buildWhere(scope, me, communityId);
  await ensureOnce(pool);
  const { rows } = await pool.query(
    `SELECT doc_id, chunk_idx, para_idx, content FROM document_chunks WHERE ${where.clause} AND tsv @@ plainto_tsquery('english',$3) ORDER BY ts_rank(tsv, plainto_tsquery('english',$3)) DESC LIMIT $4`,
    [...where.params, String(query), lim]
  );
  return rows.map((r) => ({ ...r, cite: `[#${r.doc_id}:chunk${r.chunk_idx} p${r.para_idx}]` }));
}

export async function handleAthenaDump({ content, filename, scope = 'community' }, pool, token, instance, communityId) {
  if (!content || !filename) throw Object.assign(new Error('content and filename required'), { code: 400 });
  const s = scope === 'personal' ? 'personal' : 'community';
  const { isGod, isMember, isBanned, me } = await checkRank(token, instance, s, communityId);
  if (s === 'personal' && !isGod) throw Object.assign(new Error('GOD only'), { code: 403 });
  if (s === 'community' && communityId) {
    if (isBanned) throw Object.assign(new Error('banned from community'), { code: 403 });
    if (!isMember) throw Object.assign(new Error('not a member of community'), { code: 403 });
  }
  const where = buildWhere(s, me, communityId);
  await ensureOnce(pool);
  const chunks = chunkText(content);
  for (const c of chunks) {
    const id = `${filename}_${c.chunk_idx}`;
    await pool.query(
      `INSERT INTO document_chunks (id, doc_id, scope, scope_key, chunk_idx, para_idx, page, content, token_count, tsv, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_tsvector('english',$8), $10) ON CONFLICT (id) DO UPDATE SET content=$8, token_count=$9, tsv=to_tsvector('english',$8)`,
      [id, filename, where.params[0], where.params[1], c.chunk_idx, c.para_idx, c.page, c.content, c.token_count, Date.now()]
    );
  }
  return { id: filename, chunks: chunks.length };
}

export async function handleAthenaGetChunk({ doc_id, para_idx, scope = 'community' }, pool, token, instance, communityId) {
  if (!doc_id) throw Object.assign(new Error('doc_id required'), { code: 400 });
  const s = scope === 'personal' ? 'personal' : 'community';
  const { isGod, isMember, isBanned, me } = await checkRank(token, instance, s, communityId);
  if (s === 'personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  if (s === 'community' && communityId) {
    if (isBanned) throw Object.assign(new Error('banned from community'), { code: 403 });
    if (!isMember) throw Object.assign(new Error('not a member of community'), { code: 403 });
  }
  const where = buildWhere(s, me, communityId, 2);
  await ensureOnce(pool);
  const { rows } = await pool.query(
    `SELECT content, para_idx, page, chunk_idx, doc_id FROM document_chunks WHERE doc_id=$1 AND para_idx=$2 AND ${where.clause} LIMIT 1`,
    [String(doc_id), Number(para_idx), ...where.params]
  );
  return rows[0] || null;
}

export async function handleAthenaGetDoc({ doc_id, scope = 'community' }, pool, token, instance, communityId) {
  if (!doc_id) throw Object.assign(new Error('doc_id required'), { code: 400 });
  const s = scope === 'personal' ? 'personal' : 'community';
  const { isGod, isMember, isBanned, me } = await checkRank(token, instance, s, communityId);
  if (s === 'personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  if (s === 'community' && communityId) {
    if (isBanned) throw Object.assign(new Error('banned from community'), { code: 403 });
    if (!isMember) throw Object.assign(new Error('not a member of community'), { code: 403 });
  }
  const where = buildWhere(s, me, communityId, 1);
  await ensureOnce(pool);
  const { rows } = await pool.query(
    `SELECT doc_id, chunk_idx, para_idx, page, content, token_count FROM document_chunks WHERE doc_id=$1 AND ${where.clause} ORDER BY chunk_idx ASC`,
    [String(doc_id), ...where.params]
  );
  if (!rows.length) return null;
  return { doc_id: String(doc_id), chunks: rows, total: rows.length };
}

export async function handleAthenaList({ scope = 'community', limit = 20 } = {}, pool, token, instance, communityId) {
  const s = scope === 'personal' ? 'personal' : 'community';
  const lim = clampLimit(limit);
  const { isGod, isMember, isBanned, me } = await checkRank(token, instance, s, communityId);
  if (s === 'personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  if (s === 'community' && communityId) {
    if (isBanned) throw Object.assign(new Error('banned from community'), { code: 403 });
    if (!isMember) throw Object.assign(new Error('not a member of community'), { code: 403 });
  }
  const where = buildWhere(s, me, communityId);
  await ensureOnce(pool);
  const { rows } = await pool.query(
    `SELECT doc_id, MIN(created_at) as created_at, COUNT(*) as chunks FROM document_chunks WHERE ${where.clause} GROUP BY doc_id ORDER BY MIN(created_at) DESC LIMIT $3`,
    [...where.params, lim]
  );
  return rows;
}

const server = new Server({ name: 'athena', version: '1.0.0' }, { capabilities: { tools: {} } });
const _athenaTools = [
  { name: 'athena_search', description: 'Rank-aware hybrid search over document_chunks', inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string', enum: ['personal', 'community'] }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'athena_dump', description: 'Chunk and store document with rank gate', inputSchema: { type: 'object', properties: { content: { type: 'string' }, filename: { type: 'string' }, scope: { type: 'string', enum: ['personal', 'community'] } }, required: ['content', 'filename'] } },
  { name: 'athena_get_chunk', description: 'Fetch chunk by doc_id and para_idx with rank gate', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, para_idx: { type: 'number' }, scope: { type: 'string', enum: ['personal', 'community'] } }, required: ['doc_id', 'para_idx'] } },
  { name: 'athena_get_doc', description: 'Fetch full document chunks by doc_id with rank gate', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, scope: { type: 'string', enum: ['personal', 'community'] } }, required: ['doc_id'] } },
  { name: 'athena_list', description: 'List documents for scope with rank gate', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['personal', 'community'] }, limit: { type: 'number' } } } },
];

async function _handleToolsCall(req) {
  const args = req.params.arguments || {};
  const token = process.env.ATHENA_TOKEN;
  const instance = process.env.ATHENA_INSTANCE;
  const communityId = process.env.ATHENA_COMMUNITY_ID;
  const pool = await getPool();
  await ensureOnce(pool);
  switch (req.params.name) {
    case 'athena_search': {
      const result = await handleAthenaSearch(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'athena_dump': {
      const result = await handleAthenaDump(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'athena_get_chunk': {
      const result = await handleAthenaGetChunk(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'athena_get_doc': {
      const result = await handleAthenaGetDoc(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'athena_list': {
      const result = await handleAthenaList(args, pool, token, instance, communityId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
}

try {
  server.setRequestHandler('tools/list', async () => ({ tools: _athenaTools }));
} catch {
  const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: _athenaTools }));
}
try {
  server.setRequestHandler('tools/call', _handleToolsCall);
} catch {
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  server.setRequestHandler(CallToolRequestSchema, _handleToolsCall);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await server.connect(new StdioServerTransport());
}
export { server };
