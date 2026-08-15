import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function checkRank(token, instance, _scope) {
  const res = await fetch(`${instance}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }});
  const data = await res.json();
  return { isGod: !!data.user?.is_god, isMember: true, isBanned: false, me: data.user };
}
export function buildWhere(scope, me, communityId) {
  if (scope === 'personal' && !me.is_god) throw Object.assign(new Error('personal brain is GOD only'), { code: 403 });
  return { clause: scope==='personal' ? 'user_id=$1' : 'community_id=$1', params: [scope==='personal'? me.id : communityId] };
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
  await pool.query(`CREATE TABLE IF NOT EXISTS document_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, chunk_idx INTEGER NOT NULL, page INTEGER, para_idx INTEGER, content TEXT NOT NULL, token_count INTEGER, created_at BIGINT NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(doc_id, chunk_idx)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(scope, scope_key, para_idx)`);
}

export async function handleAthenaSearch({query, scope='community', limit=8}, pool, token, instance, communityId){
  const { isGod, me } = await checkRank(token, instance, scope);
  if(scope==='personal' && !isGod) throw Object.assign(new Error('personal brain is GOD only'), {code:403});
  const where = scope==='personal' ? 'scope=$1 AND scope_key=$2' : 'scope=$1 AND scope_key=$2';
  const params = scope==='personal' ? ['personal', me.id] : ['community', communityId];
  const { rows } = await pool.query(`SELECT doc_id, chunk_idx, para_idx, content FROM document_chunks WHERE ${where} AND tsv @@ plainto_tsquery('english',$3) ORDER BY ts_rank(tsv, plainto_tsquery($3)) DESC LIMIT ${limit}`, [...params, query]);
  return rows.map(r => ({...r, cite:`[#${r.doc_id}:chunk${r.chunk_idx} p${r.para_idx}]`}));
}
export async function handleAthenaDump({content, filename, scope}, pool, token, instance, communityId){
  const { isGod, me } = await checkRank(token, instance, scope);
  if(scope==='personal' && !isGod) throw Object.assign(new Error('GOD only'), {code:403});
  const chunks = chunkText(content);
  for(const c of chunks) await pool.query(`INSERT INTO document_chunks (id, doc_id, scope, scope_key, chunk_idx, para_idx, content, token_count, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [`${filename}_${c.chunk_idx}`, filename, scope, scope==='personal'?me.id:communityId, c.chunk_idx, c.para_idx, c.content, c.token_count, Date.now()]);
  return { id: filename, chunks: chunks.length };
}

const server = new Server({ name: 'athena', version: '1.0.0' }, { capabilities: { tools: {} } });
const _athenaTools = [
  { name:'athena_search', description: 'Rank-aware hybrid search over document_chunks', inputSchema:{type:'object', properties:{query:{type:'string'}, scope:{type:'string', enum:['personal','community']}, limit:{type:'number'}}, required:['query']}},
  { name:'athena_dump', description: 'Chunk and store document with rank gate', inputSchema:{type:'object', properties:{content:{type:'string'}, filename:{type:'string'}, scope:{type:'string', enum:['personal','community']}}, required:['content','filename']}},
  { name:'athena_get_chunk', description: 'Fetch chunk by doc_id and para_idx', inputSchema:{type:'object', properties:{doc_id:{type:'string'}, para_idx:{type:'number'}}}},
];

async function _handleToolsCall(req) {
  const args = req.params.arguments || {};
  const token = process.env.ATHENA_TOKEN;
  const instance = process.env.ATHENA_INSTANCE;
  const communityId = process.env.ATHENA_COMMUNITY_ID;
  let pool;
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    pool = { query: async () => ({ rows: [] }) };
  }
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
      const q = args.doc_id ? `SELECT content, para_idx FROM document_chunks WHERE doc_id=$1 AND para_idx=$2 LIMIT 1` : `SELECT 1`;
      const r = await pool.query(q, args.doc_id ? [args.doc_id, args.para_idx] : []);
      return { content: [{ type: 'text', text: JSON.stringify(r.rows[0] || null) }] };
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
