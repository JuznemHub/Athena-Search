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
// requesterTgId -> { chatId, at } while a forum clone is waiting on a topic
// choice (the shim showed the topic list and asked the user to pick).
const FORUM_PENDING = new Map();
// Same policy as legacy's telegramApiBaseFor: an explicit TELEGRAM_API_BASE is
// honored ONLY for loopback/private hosts; bot tokens never leave for a
// random host. Keeps shim rich/ack calls on the SAME Bot API server legacy
// uses (a local server is the only one that serves sendRichMessage).
const SHIM_CLOUD_BASE = 'https://api.telegram.org';
let shimApiBase = SHIM_CLOUD_BASE;
function shimBaseFor(env) {
  const raw = String(env?.TELEGRAM_API_BASE || '').trim().replace(/\/+$/, '');
  if (!raw) return SHIM_CLOUD_BASE;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const private_ = host === 'localhost' || host === '::1' ||
      /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return (u.protocol === 'http:' || u.protocol === 'https:') && private_ ? u.origin : SHIM_CLOUD_BASE;
  } catch (_) { return SHIM_CLOUD_BASE; }
}
async function tg(token,method,body){ const r=await fetch(`${shimApiBase}/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); return r.json().catch(()=>({ok:false,description:'Invalid Telegram response'})); }
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
  // Per chat+thread, matching startBackfillJob's dedupe: cloning topic #42
  // must not be blocked just because topic #7 (or the whole chat) already has
  // an active job; whole-chat clones still see whole-chat jobs.
  const threadKey = topic || null;
  const running=await env.DB.prepare(`SELECT id FROM index_jobs WHERE chat_id=? AND status IN ('queued','running') AND COALESCE(thread_id, '') = COALESCE(?, '')`).bind(normRemote,threadKey).first().catch(()=>null);
  if(running){ await richSend(`<h3>⏳ Already running</h3><p>Clone for <code>${remote}</code>${topic?` topic <code>#${topic}</code>`:''} is already running — progress via /userbot_status.</p>`); return new Response('OK'); }
  const pend=await env.DB.prepare(`SELECT id FROM pending_clones WHERE chat_id=? AND expires_at>? AND COALESCE(thread_id, '') = COALESCE(?, '')`).bind(normRemote,Date.now(),threadKey).first().catch(()=>null);
  if(pend){ await richSend(`<h3>⏳ Clone preview ready</h3><p>Preview for <code>${remote}</code> is ready — resuming auto-confirm now, hold on.</p>`);
    const resume=(async()=>{ const y=structuredClone(update); y.message.text='yes'; y.message.caption=undefined; y.message.entities=[]; if(y.message&&y.message.message_id!=null) y.message.message_id=y.message.message_id+1000000; if(y.update_id!=null) y.update_id=y.update_id+1; try{ await legacyFetch(y,env); }catch(_){ await richSend(`<h3>❌ Clone failed</h3><p>Clone confirm step failed — check /userbot_status or retry.</p>`); } })();
    if(ctx&&typeof ctx.waitUntil==='function') ctx.waitUntil(resume.catch(()=>{})); else await resume.catch(()=>{});
    return new Response('OK'); }
  // Only an explicit 'all' clones every topic. Never auto-detect is_forum and
  // inject 'all' — that bypassed the preview/confirm gate and cloned every
  // topic on a bare /clone with no ask. Legacy detects the forum itself, shows
  // the topic list, and the user picks a topic id or 'all' (gated below).
  const wantAll=args.some(x=>String(x).toLowerCase()==='all');
  const forumAll=false;
  // Ack BEFORE the blocking preview scan: primeEntity (45s) + history preview
  // run with zero user feedback, and a killed/timed-out webhook otherwise
  // leaves total silence.
  const scopeLabel=target==='personal'?'personal brain':target==='both'?'personal + community':(community||'community');
  const userCmd=String(parts(msg.text)[0]||'/clone').split('@')[0];
  const ackHtml=`<h3>🔄 Clone requested</h3><p>for <code>${remote}</code> → <b>${scopeLabel}</b>${topic?` (topic ${topic})`:forumAll||wantAll?' (forum — cloning topic-wise)':''}.</p><p><i>Checking the chat and starting the clone… progress via /userbot_status.</i></p>`;
  const ackRes=await richSend(ackHtml);
  const ackId=ackRes&&ackRes.result?ackRes.result.message_id:0;
  const task=(async()=>{
    const extra=[remote]; if(topic) extra.push(topic); else if(forumAll||wantAll) extra.push('all'); extra.push(target); if(community) extra.push(community); const first=cloneUpdate(update,`/clone ${extra.join(' ')}`); console.log(`[uclone] dispatch: ${`/clone ${extra.join(' ')}`}`);
    const originalFetch=globalThis.fetch; const dmChat=String(msg.chat.id);
    let forumDetected=false; let previewShown=false;
    globalThis.fetch=async(input,init={})=>{
      try{
        const url=typeof input==='string'?input:input?.url;
        // Match the Bot API base the shim actually talks to (a private
        // TELEGRAM_API_BASE is honored for loopback/private hosts), not just
        // api.telegram.org — otherwise the preview/confirm swallow and forum
        // relabel never fire on a self-host bot.
        let shimHost='api.telegram.org'; try{ shimHost=new URL(shimApiBase).hostname; }catch(_){}
        const isBotApi=(()=>{ try{ return !!url&&new URL(url).hostname===shimHost; }catch(_){ return false; } })();
        if(isBotApi&&init?.body){
          const payload=typeof init.body==='string'?JSON.parse(init.body):null;
          if(payload?.chat_id!=null&&String(payload.chat_id)===dmChat){
            // Detect the preview so the task asks for approval, but pass it
            // through so the user sees the stats + inline Yes/No instead of an
            // automatic confirm (the old flow swallowed it and cloned silently).
            if(payload?.text!=null){
              const text=String(payload.text||'');
              if(text.includes('Clone preview')||text.trim()==='Confirm clone?'){ previewShown=true; }
            }
            // forum topic list: relabel /clone as the command the user invoked
            const html=payload?.rich_message?.html ?? payload?.text ?? '';
            if(typeof html==='string'&&html.includes('📋 Forum detected')){
              forumDetected=true;
              const relabeled=html.split('/clone ').join(userCmd+' ');
              if(payload?.rich_message) payload.rich_message.html=relabeled; else payload.text=relabeled;
              init.body=JSON.stringify(payload);
            }
          }
        }
      }catch(_){}
      return originalFetch(input,init);
    };
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
    // Forum with no explicit topic: legacy replied with the topic list (relabeled
    // to the invoked command). Auto-run the all-topics clone now — the user asked
    // for the chat, not for a second command.
    if(forumDetected&&!topic&&!wantAll){
      // Ask permission — never auto-clone every topic. The relabeled topic
      // list above is the ask: the user picks a topic id or 'all'. Record the
      // waiting state so a later bare topic-id reply is routed to a real clone
      // instead of being silently dropped.
      FORUM_PENDING.set(String(msg.from?.id||''), { chatId: normRemote, at: Date.now() });
      console.log(`[uclone] forum detected for ${normRemote} — waiting for the user to pick a topic or 'all'`);
      if(ackId) await editRich(ackId, ackHtml+`<p><i>📋 Forum with multiple topics detected — the topic list above is ready. Reply <b>a topic id</b> (or <b>'all'</b> to clone every topic, per-topic progress bars below), or rerun <code>/uclone ${remote} &lt;topic_id&gt;</code>.</i></p>`);
      return;
    }
    if(previewShown){
      // Interactive gate: the preview (stats + inline Yes/No) reached the user.
      // Reply 'yes' or tap Yes to start; the legacy confirm handler runs the
      // clone. The ack card just points at it — no silent auto-confirm.
      if(ackId) await editRich(ackId, ackHtml+'<p><i>Preview ready — review the stats above, then reply <b>yes</b> or tap the <b>✅ Yes, clone</b> button.</i></p>');
      return;
    }
    // No preview was detected: legacy may have shown a forum topic list (handled
    // above) or the preview silently died. Do not fabricate a confirm.
    if(ackId) await editRich(ackId, ackHtml+'<p>⚠️ No clone preview was shown. If a forum topic list arrived above, run <code>/uclone '+remote+' all</code> or pick one topic id; otherwise retry.</p>');
    return;
  })();
  if(ctx&&typeof ctx.waitUntil==='function') ctx.waitUntil(task.catch(()=>{})); else await task.catch(()=>{});
  return new Response('OK');
}
async function uclone(update,env,ctx){ return unifiedClone(update,env,ctx); }
async function cloneStop(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x))||(String(msg.chat.id).startsWith('-')?String(msg.chat.id):''); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /clone_stop <chat_id>'); return legacyFetch(cloneUpdate(update,`/index_stop ${normalizeChatId(chat)}`),env); }
async function stats(update,env){ return legacyFetch(cloneUpdate(update,'/stats'),env); }
async function ucloneDel(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x)); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /uclone_del <chat_id> [topic_id]'); const topic=args.find(x=>/^\d{1,9}$/.test(x)&&x!==chat); return legacyFetch(cloneUpdate(update,`/delete ${chat}${topic?` ${topic}`:''} files`),env); }
async function intercept(update,env,ctx){ const msg=update.message; if(!msg?.text||!env.TELEGRAM_BOT_TOKEN) return null;
  // A bare topic-id or 'all' reply while the shim is waiting on a forum choice:
  // route it to a real clone. Without this the reply matched no command and the
  // clone silently never started.
  const pendText=(msg.text||'').trim(); const fromId=String(msg.from?.id||'');
  const pend=FORUM_PENDING.get(fromId);
  if(pend&&(Date.now()-pend.at)<10*60*1000){
    const lower=pendText.toLowerCase();
    if(/^-?\d{1,9}$/.test(pendText)||lower==='all'){
      FORUM_PENDING.delete(fromId);
      const u=structuredClone(update); u.message.text=`/uclone ${pend.chatId} ${/^-?\d{1,9}$/.test(pendText)?pendText:'all'}`; u.message.caption=undefined; u.message.entities=[{type:'bot_command',offset:0,length:7}]; return uclone(u,env,ctx);
    }
  }
  switch(command(msg.text)){ case '/clone':return unifiedClone(update,env,ctx); case '/uclone':return uclone(update,env,ctx); case '/ubclone':return uclone(update,env,ctx); case '/userbotconnect':return userbotConnect(update,env); case '/uclone_del':return ucloneDel(update,env); case '/clone_stop':return cloneStop(update,env); case '/stats':return stats(update,env); default:return null; } }
export default {async fetch(request,env,ctx){ shimApiBase = shimBaseFor(env); const url=new URL(request.url); if(request.method==='POST'&&/telegram-webhook$/.test(url.pathname)){ try{const update=await request.clone().json(); const handled=await intercept(update,env,ctx); if(handled)return handled;}catch(_){} } return legacy.fetch(request,env,ctx); }};
