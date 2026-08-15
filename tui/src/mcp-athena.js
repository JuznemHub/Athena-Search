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

const server = new Server({ name: 'athena', version: '1.0.0' }, { capabilities: { tools: {} } });
const _athenaTools = [
  { name:'athena_search', inputSchema:{type:'object', properties:{query:{type:'string'}, scope:{type:'string'}, limit:{type:'number'}}}},
  { name:'athena_get_chunk', inputSchema:{type:'object', properties:{doc_id:{type:'string'}, para_idx:{type:'number'}}}},
];
try {
  server.setRequestHandler('tools/list', async () => ({ tools: _athenaTools }));
} catch {
  const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: _athenaTools }));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await server.connect(new StdioServerTransport());
}
export { server };
