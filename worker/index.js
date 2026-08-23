import legacy from './index_legacy.js';
export * from './index_legacy.js';
const _WORKER_VERSION = "version: '1.0.54'";

const TARGETS = new Set(['community', 'personal', 'both']);
const HELP = `📡 ATHENA — TELEGRAM CLONING

Athena has two cloning modes:

1) /clone — normal user-facing clone. It uses the connected userbot for history and keeps live indexing running afterwards.
2) /uclone — explicit userbot clone. Same history engine, useful when you want to make the userbot path explicit.

━━━━━━━━ CHANNELS ━━━━━━━━

STEP 1 — Add Athena to the channel
• Open Channel → Manage Channel → Administrators → Add Athena.
• Make Athena an Administrator with permission to post/read channel posts as required by Telegram.

STEP 2 — Link the channel to a community
Run this as the community GOD/owner:
/channel_link <community_id> <channel_id>

Example:
/channel_link c_abc123 -1002290798043

To find a channel ID, forward a channel post to @userinfobot. Channel IDs normally start with -100.

After linking, every NEW channel post is live-indexed automatically.

STEP 3 — Clone old history
/clone <channel_id> community

Athena will start the history backfill through the connected userbot and keep live indexing enabled. New posts continue indexing while/after the backfill.

Targets:
• community — community brain
• personal — GOD only, personal brain
• both — GOD only, both brains

━━━━━━━━ GROUPS ━━━━━━━━

Add Athena to the group and make it an Administrator.

Normal group:
/clone <group_id> community

This clones the whole group history and keeps new messages indexed live.

Forum group:
/clone <group_id> community

Athena detects forum topics automatically and backfills them topic-by-topic.

One topic only:
/clone <group_id> <topic_id> community

From inside a topic you can also simply run /clone with the target.

The same group pipeline handles links, URLs, supported files/documents and substantial text posts.

━━━━━━━━ USERBOT SETUP ━━━━━━━━

History requires a Telegram user account because the Bot API cannot retrieve arbitrary old chat history.

GOD setup — DM Athena:
/userbotconnect <api_id> <api_hash> <session_string> <community_id>

Example:
/userbotconnect 123456 abcdef... YOUR_SESSION c_abc123

The userbot account must itself be a member of every channel/group you want to clone. For channels, add that user account to the channel as well.

The session string is a live account credential. NEVER send it in a group. Revoke it from Telegram Settings → Devices if compromised.

━━━━━━━━ USERBOT COMMANDS ━━━━━━━━

/uclone <chat_id> community
/uclone <chat_id> <topic_id> community

/uclone_del <chat_id>
/uclone_del <chat_id> <topic_id>

Use /uclone when you specifically want the explicit userbot command. /clone is the recommended normal command.

━━━━━━━━ CONTROL ━━━━━━━━

/stats
Shows active channels/groups, live state, targets, topics and indexing counters.

/clone_stop [chat_id]
Stops cloning/backfill for a chat.

/delete <chat_id>
Deletes all Athena data cloned from that chat.

/delete <chat_id> <topic_id>
Deletes data for one cloned forum topic.

━━━━━━━━ CHANNEL MANAGEMENT ━━━━━━━━

/channel_link <community_id> <channel_id>
Connect a channel to a community and start live indexing.

/channel_unlink <channel_id>
Stops live indexing for that channel. It does NOT automatically delete existing indexed data; use /delete if you want that removed.

━━━━━━━━ IMPORTANT ━━━━━━━━

• /clone does NOT delete, edit or alter messages in the source Telegram chat.
• History is read through the connected userbot account.
• Live indexing continues after history backfill.
• Forum groups are handled topic-by-topic automatically.
• personal/both are GOD-only.
• If the userbot cannot see a chat, add that account to the channel/group and run /clone again.

Quick recipe:
1. Add Athena as admin.
2. /channel_link <community_id> <channel_id> for channels.
3. Connect the userbot once with /userbotconnect.
4. Make sure the userbot account can access the source chat.
5. Run /clone <chat_id> community.
6. Check /stats.
7. Use /clone_stop or /delete when needed.`;
function parts(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }
function command(text) { return parts(text)[0]?.split('@')[0]?.toLowerCase() || ''; }
function targetOf(args) { return args.find((x) => TARGETS.has(String(x).toLowerCase()))?.toLowerCase() || 'community'; }
function normalizeChatId(id) { const s=String(id||'').trim(); if(/^-100\d+$/.test(s)) return s; if(/^\d+$/.test(s)&&s.length>=9) return `-100${s}`; return s; }
function ownerIds(env) { const raw=String(env.TG_OWNER_IDS||'').trim(); return raw ? new Set(raw.split(',').map(x=>x.trim()).filter(Boolean)) : null; }
function isGod(id,env) { const ids=ownerIds(env); return !ids || ids.has(String(id||'')); }
async function tg(token,method,body){ const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return r.json().catch(()=>({ok:false,description:'Invalid Telegram response'})); }
async function reply(token,chatId,text,threadId){ const body={chat_id:chatId,text}; if(threadId!=null) body.message_thread_id=threadId; await tg(token,'sendMessage',body).catch(()=>{}); return new Response('OK'); }
async function ensureTables(DB){ await DB.prepare(`CREATE TABLE IF NOT EXISTS userbot_clone_defaults (label TEXT PRIMARY KEY, community_id TEXT, updated_at BIGINT)`).run().catch(()=>{}); }
async function binding(DB,chatId){ return DB.prepare(`SELECT * FROM community_bots WHERE platform='telegram' AND group_id=? ORDER BY created_at DESC LIMIT 1`).bind(String(chatId)).first().catch(()=>null); }
async function legacyFetch(update,env){ return legacy.fetch(new Request('https://athena.internal/api/telegram-webhook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(update)}),env,{}); }
function cloneUpdate(update,text){ const u=structuredClone(update); u.message.text=text; u.message.caption=undefined; u.message.entities=[{type:'bot_command',offset:0,length:parts(text)[0].length}]; return u; }
async function userbotConnect(update,env){ const msg=update.message,args=parts(msg.text); if(!isGod(msg.from?.id,env)) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'GOD rank only.'); if(String(msg.chat.id).startsWith('-')) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Session strings are secrets — DM Athena only.'); if(args.length<5) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /userbotconnect <api_id> <api_hash> <session_string> <community_id>'); const communityId=args.at(-1),session=args.slice(3,-1).join(' '); const response=await legacyFetch(cloneUpdate(update,`/userbot_add main ${args[1]} ${args[2]} ${session}`),env); await ensureTables(env.DB); await env.DB.prepare(`INSERT INTO userbot_clone_defaults(label,community_id,updated_at) VALUES ('main',?,?) ON CONFLICT(label) DO UPDATE SET community_id=excluded.community_id,updated_at=excluded.updated_at`).bind(communityId,Date.now()).run().catch(()=>{}); return response; }
async function unifiedClone(update,env){
  const msg=update.message,args=parts(msg.text).slice(1),token=env.TELEGRAM_BOT_TOKEN; const remote=args.find(x=>/^-?\d{5,}$/.test(x)) || (String(msg.chat.id).startsWith('-')?String(msg.chat.id):''); if(!remote) return reply(token,msg.chat.id,'Usage: /clone <chat_id> <community|personal|both> [topic_id]');
  const target=targetOf(args); if((target==='personal'||target==='both')&&!isGod(msg.from?.id,env)) return reply(token,msg.chat.id,'personal and both targets are GOD-only.'); await ensureTables(env.DB);
  const def=await env.DB.prepare(`SELECT community_id FROM userbot_clone_defaults WHERE label='main'`).first().catch(()=>null); const b=await binding(env.DB,normalizeChatId(remote)); const community=def?.community_id||b?.community_id||'';
  const numeric=args.filter(x=>/^\d{1,9}$/.test(x)&&x!==remote); const topic=numeric.length?numeric[0]:''; if(!community&&target==='community') return reply(token,msg.chat.id,'No community is configured for this clone. Connect the userbot with /userbotconnect ... <community_id>, or provide the community_id in the clone command.');
  const extra=[remote]; if(topic) extra.push(topic); extra.push(target); if(community) extra.push(community); const first=cloneUpdate(update,`/clone ${extra.join(' ')}`);
  const originalFetch=globalThis.fetch; let response;
  globalThis.fetch=async(input,init={})=>{ try{ const url=typeof input==='string'?input:input?.url; if(url&&/api\.telegram\.org\/bot/.test(url)&&init?.body){ const payload=typeof init.body==='string'?JSON.parse(init.body):null; if(payload?.chat_id!=null&&payload?.text!=null){ const text=String(payload.text||''); if(text.includes('Clone preview')||text.trim()==='Confirm clone?'){ return new Response(JSON.stringify({ok:true,result:{message_id:0,chat:{id:payload.chat_id}}}),{status:200,headers:{'content-type':'application/json'}}); } } } }catch(_){} return originalFetch(input,init); };
  try{ response=await legacyFetch(first,env); }finally{ globalThis.fetch=originalFetch; }
  const yes=structuredClone(update); yes.message.text='yes'; yes.message.caption=undefined; yes.message.entities=[]; await new Promise(r=>setTimeout(r,50)); await legacyFetch(yes,env).catch(()=>{}); return response;
}
async function uclone(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x)); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /uclone <chat_id> <community|personal|both> [topic_id]'); const target=targetOf(args); if((target==='personal'||target==='both')&&!isGod(msg.from?.id,env)) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'personal and both targets are GOD-only.'); await ensureTables(env.DB); const def=await env.DB.prepare(`SELECT community_id FROM userbot_clone_defaults WHERE label='main'`).first().catch(()=>null); const b=await binding(env.DB,normalizeChatId(chat)); const community=def?.community_id||b?.community_id||''; const topic=args.find(x=>/^\d{1,9}$/.test(x)&&x!==chat); const text=`/clone ${chat}${topic?` ${topic}`:''} ${target}${community?` ${community}`:''}`.trim(); return legacyFetch(cloneUpdate(update,text),env); }
async function cloneStop(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x))||(String(msg.chat.id).startsWith('-')?String(msg.chat.id):''); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /clone_stop <chat_id>'); return legacyFetch(cloneUpdate(update,`/index_stop ${normalizeChatId(chat)}`),env); }
async function stats(update,env){ await ensureTables(env.DB); const bots=await env.DB.prepare('SELECT chat_id,community_id,target,status,forum,updated_at FROM bot_clone_targets ORDER BY updated_at DESC').all().catch(()=>({results:[]})); const follows=await env.DB.prepare('SELECT chat_id,label,community_id,target,created_at FROM userbot_follows ORDER BY created_at DESC').all().catch(()=>({results:[]})); const lines=['📊 ATHENA CLONING STATUS','','BOT / LIVE']; for(const r of bots.results||[]){ const topics=await env.DB.prepare('SELECT thread_id FROM telegram_topic_bindings WHERE chat_id=? ORDER BY thread_id').bind(r.chat_id).all().catch(()=>({results:[]})); lines.push(`• ${r.chat_id} · ${r.status||'live'} · target ${r.target||'community'}${r.forum?' · forum':''}`); if(r.forum) lines.push(`  topics live: ${(topics.results||[]).map(x=>`#${x.thread_id}`).join(', ')||'none yet'}`); } lines.push('','USERBOT / HISTORY + LIVE'); for(const f of follows.results||[]) lines.push(`• ${f.chat_id} · ${f.target||'community'} · ${f.label||'main'} · live`); if(!(bots.results||[]).length&&!(follows.results||[]).length) lines.push('• Nothing is currently cloned.'); return reply(env.TELEGRAM_BOT_TOKEN,update.message.chat.id,lines.join('\n'),update.message.message_thread_id); }
async function ucloneDel(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x)); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /uclone_del <chat_id> [topic_id]'); const topic=args.find(x=>/^\d{1,9}$/.test(x)&&x!==chat); return legacyFetch(cloneUpdate(update,`/delete ${chat}${topic?` ${topic}`:''} files`),env); }
async function intercept(update,env){ const msg=update.message; if(!msg?.text||!env.TELEGRAM_BOT_TOKEN) return null; switch(command(msg.text)){ case '/help':case '/start':return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,HELP,msg.message_thread_id); case '/clone':return unifiedClone(update,env); case '/uclone':return uclone(update,env); case '/userbotconnect':return userbotConnect(update,env); case '/uclone_del':return ucloneDel(update,env); case '/clone_stop':return cloneStop(update,env); case '/stats':return stats(update,env); default:return null; } }
export default {async fetch(request,env,ctx){ const url=new URL(request.url); if(request.method==='POST'&&/telegram-webhook$/.test(url.pathname)){ try{const update=await request.clone().json(); const handled=await intercept(update,env); if(handled)return handled;}catch(_){} } return legacy.fetch(request,env,ctx); }};
