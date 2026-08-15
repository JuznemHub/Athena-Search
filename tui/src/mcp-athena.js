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
