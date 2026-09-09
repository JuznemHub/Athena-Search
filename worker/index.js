import legacy from './index_legacy.js';
export * from './index_legacy.js';
const _WORKER_VERSION = "version: '1.0.54'";

const TARGETS = new Set(['community', 'personal', 'both']);
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
async function legacyFetch(update,env){
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET||'').trim() || await legacy.webhookSecret?.(env).catch(()=>null) || '';
  const headers = {'content-type':'application/json'};
  if(secret) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return legacy.fetch(new Request('https://athena.internal/api/telegram-webhook',{method:'POST',headers,body:JSON.stringify(update)}),env,{});
}
function cloneUpdate(update,text){ const u=structuredClone(update); u.message.text=text; u.message.caption=undefined; u.message.entities=[{type:'bot_command',offset:0,length:parts(text)[0].length}]; return u; }
async function userbotConnect(update,env){ const msg=update.message,args=parts(msg.text); if(!isGod(msg.from?.id,env)) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'GOD rank only.'); if(String(msg.chat.id).startsWith('-')) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Session strings are secrets — DM Athena only.'); if(args.length<5) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /userbotconnect <api_id> <api_hash> <session_string> <community_id>'); const communityId=args.at(-1),session=args.slice(3,-1).join(' '); const response=await legacyFetch(cloneUpdate(update,`/userbot_add main ${args[1]} ${args[2]} ${session}`),env); await ensureTables(env.DB); await env.DB.prepare(`INSERT INTO userbot_clone_defaults(label,community_id,updated_at) VALUES ('main',?,?) ON CONFLICT(label) DO UPDATE SET community_id=excluded.community_id,updated_at=excluded.updated_at`).bind(communityId,Date.now()).run().catch(()=>{}); return response; }
async function unifiedClone(update,env,ctx){
  const msg=update.message,args=parts(msg.text).slice(1),token=env.TELEGRAM_BOT_TOKEN; const remote=args.find(x=>/^-?\d{5,}$/.test(x)) || (String(msg.chat.id).startsWith('-')?String(msg.chat.id):''); if(!remote) return reply(token,msg.chat.id,'Usage: /clone <chat_id> <community|personal|both> [topic_id]');
  const target=targetOf(args); if((target==='personal'||target==='both')&&!isGod(msg.from?.id,env)) return reply(token,msg.chat.id,'personal and both targets are GOD-only.'); await ensureTables(env.DB);
  const def=await env.DB.prepare(`SELECT community_id FROM userbot_clone_defaults WHERE label='main'`).first().catch(()=>null); const b=await binding(env.DB,normalizeChatId(remote)); const community=def?.community_id||b?.community_id||'';
  const numeric=args.filter(x=>/^\d{1,9}$/.test(x)&&x!==remote); const topic=numeric.length?numeric[0]:''; if(!community&&target==='community') return reply(token,msg.chat.id,'No community is configured for this clone. Connect the userbot with /userbotconnect ... <community_id>, or provide the community_id in the clone command.');
  const normRemote=normalizeChatId(remote);
  const richOk=(r)=>!!(r&&r.ok&&r.result);
  const toClassic=(h)=>String(h||'').replace(/<\/?(?:h[1-6]|p|ul|ol|li|details|summary|table|tr|td|th|blockquote|footer|aside|pre|figure|figcaption)[^>]*>/gi,'\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').replace(/\n{3,}/g,'\n\n').trim();
  const classicSend=(text)=>tg(token,'sendMessage',{chat_id:msg.chat.id,text,parse_mode:'HTML'}).catch(()=>{});
  const richSend=(html)=>tg(token,'sendRichMessage',{chat_id:msg.chat.id,rich_message:{html}}).then(r=>richOk(r)?r:classicSend(toClassic(html))).catch(()=>classicSend(toClassic(html)));
  const editRich=(mid,html)=>{ if(!mid) return Promise.resolve(); return tg(token,'editMessageText',{chat_id:msg.chat.id,message_id:mid,rich_message:{html}}).then(r=>richOk(r)?r:tg(token,'editMessageText',{chat_id:msg.chat.id,message_id:mid,text:toClassic(html),parse_mode:'HTML'})).catch(()=>{}); };
  const running=await env.DB.prepare(`SELECT id FROM index_jobs WHERE chat_id=? AND status IN ('queued','running')`).bind(normRemote).first().catch(()=>null);
  if(running){ await richSend(`<h3>⏳ Already running</h3><p>Clone for <code>${remote}</code> is already running — progress via /userbot_status.</p>`); return new Response('OK'); }
  const pend=await env.DB.prepare(`SELECT id FROM pending_clones WHERE chat_id=? AND expires_at>?`).bind(normRemote,Date.now()).first().catch(()=>null);
  if(pend){ await richSend(`<h3>⏳ Clone preview ready</h3><p>Preview for <code>${remote}</code> is ready — resuming auto-confirm now, hold on.</p>`);
    const resume=(async()=>{ const y=structuredClone(update); y.message.text='yes'; y.message.caption=undefined; y.message.entities=[]; try{ await legacyFetch(y,env); }catch(_){ await richSend(`<h3>❌ Clone failed</h3><p>Clone confirm step failed — check /userbot_status or retry.</p>`); } })();
    if(ctx&&typeof ctx.waitUntil==='function') ctx.waitUntil(resume.catch(()=>{})); else await resume.catch(()=>{});
    return new Response('OK'); }
  // Forum auto-all: a topic-enabled group clones topic-wise with no extra
  // arg — Bot API getChat exposes is_forum for visible chats; unknown chats
  // keep the classic single-chat flow and legacy decides.
  const wantAll=args.some(x=>String(x).toLowerCase()==='all');
  let forumAll=false;
  if(!topic&&!wantAll){ try{ const gc=await tg(token,'getChat',{chat_id:normRemote}); if(gc&&gc.ok&&gc.result&&gc.result.is_forum) forumAll=true; }catch(_){} }
  // Ack BEFORE the blocking preview scan: primeEntity (45s) + history preview
  // run with zero user feedback, and a killed/timed-out webhook otherwise
  // leaves total silence.
  const scopeLabel=target==='personal'?'personal brain':target==='both'?'personal + community':(community||'community');
  const ackHtml=`<h3>🔄 Clone started</h3><p>for <code>${remote}</code> → <b>${scopeLabel}</b>${topic?` (topic ${topic})`:''}${forumAll?' (forum — cloning topic-wise)':''}.</p><p><i>Preview + history scan run in the background — progress via /userbot_status.</i></p>`;
  const ackRes=await richSend(ackHtml);
  const ackId=ackRes&&ackRes.result?ackRes.result.message_id:0;
  const task=(async()=>{
    const extra=[remote]; if(topic) extra.push(topic); else if(forumAll||wantAll) extra.push('all'); extra.push(target); if(community) extra.push(community); const first=cloneUpdate(update,`/clone ${extra.join(' ')}`);
    const originalFetch=globalThis.fetch; const dmChat=String(msg.chat.id);
    globalThis.fetch=async(input,init={})=>{ try{ const url=typeof input==='string'?input:input?.url; if(url&&/api\.telegram\.org\/bot/.test(url)&&init?.body){ const payload=typeof init.body==='string'?JSON.parse(init.body):null; if(payload?.chat_id!=null&&String(payload.chat_id)===dmChat&&payload?.text!=null){ const text=String(payload.text||''); if(text.includes('Clone preview')||text.trim()==='Confirm clone?'){ return new Response(JSON.stringify({ok:true,result:{message_id:0,chat:{id:payload.chat_id}}}),{status:200,headers:{'content-type':'application/json'}}); } } } }catch(_){} return originalFetch(input,init); };
    // The ack doubles as a live stage card: heartbeat while the preview
    // scans, stage edits after, 8-minute timeout instead of infinite silence.
    const t0=Date.now();
    const beat=setInterval(()=>{ editRich(ackId, ackHtml+`<p><i>Still scanning preview… ${Math.round((Date.now()-t0)/1000)}s elapsed.</i></p>`); },60000);
    let previewErr=null;
    try{ await Promise.race([legacyFetch(first,env), new Promise((_,rej)=>setTimeout(()=>rej(new Error('preview-timeout')),8*60*1000))]); }
    catch(e){ previewErr=e; }
    finally{ clearInterval(beat); globalThis.fetch=originalFetch; }
    if(previewErr){
      const timedOut=previewErr&&previewErr.message==='preview-timeout';
      const failHtml=timedOut
        ? `<h3>❌ Clone timed out</h3><p>Preview for <code>${remote}</code> took over 8 minutes — the chat may be huge or unreachable. Retry, or narrow with a topic id.</p>`
        : `<h3>❌ Clone failed</h3><p>Preview failed (${String(previewErr?.message||previewErr).slice(0,120)}). Check /userbot_status or retry.</p>`;
      if(ackId) await editRich(ackId,failHtml); else await richSend(failHtml);
      return;
    }
    if(ackId) await editRich(ackId, ackHtml+`<p><i>Preview ready — confirming…</i></p>`);
    const yes=structuredClone(update); yes.message.text='yes'; yes.message.caption=undefined; yes.message.entities=[]; await new Promise(r=>setTimeout(r,50));
    try{ await legacyFetch(yes,env); if(ackId) await editRich(ackId, ackHtml+`<p>✅ Confirmed — cloning, per-topic progress below and via /userbot_status.</p>`); }
    catch(_){ const failHtml=`<h3>❌ Clone failed</h3><p>Confirm step failed — check /userbot_status or retry.</p>`; if(ackId) await editRich(ackId,failHtml); else await richSend(failHtml); }
  })();
  if(ctx&&typeof ctx.waitUntil==='function') ctx.waitUntil(task.catch(()=>{})); else await task.catch(()=>{});
  return new Response('OK');
}
async function uclone(update,env,ctx){ return unifiedClone(update,env,ctx); }
async function cloneStop(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x))||(String(msg.chat.id).startsWith('-')?String(msg.chat.id):''); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /clone_stop <chat_id>'); return legacyFetch(cloneUpdate(update,`/index_stop ${normalizeChatId(chat)}`),env); }
async function stats(update,env){ return legacyFetch(cloneUpdate(update,'/stats'),env); }
async function ucloneDel(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x)); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /uclone_del <chat_id> [topic_id]'); const topic=args.find(x=>/^\d{1,9}$/.test(x)&&x!==chat); return legacyFetch(cloneUpdate(update,`/delete ${chat}${topic?` ${topic}`:''} files`),env); }
async function intercept(update,env,ctx){ const msg=update.message; if(!msg?.text||!env.TELEGRAM_BOT_TOKEN) return null; switch(command(msg.text)){ case '/clone':return unifiedClone(update,env,ctx); case '/uclone':return uclone(update,env,ctx); case '/ubclone':return uclone(update,env,ctx); case '/userbotconnect':return userbotConnect(update,env); case '/uclone_del':return ucloneDel(update,env); case '/clone_stop':return cloneStop(update,env); case '/stats':return stats(update,env); default:return null; } }
export default {async fetch(request,env,ctx){ const url=new URL(request.url); if(request.method==='POST'&&/telegram-webhook$/.test(url.pathname)){ try{const update=await request.clone().json(); const handled=await intercept(update,env,ctx); if(handled)return handled;}catch(_){} } return legacy.fetch(request,env,ctx); }};
