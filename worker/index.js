import legacy from './index_legacy.js';
export * from './index_legacy.js';
const _WORKER_VERSION = "version: '1.0.54'";

function parts(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }
function command(text) { return parts(text)[0]?.split('@')[0]?.toLowerCase() || ''; }
function normalizeChatId(id) { const s=String(id||'').trim(); if(/^-100\d+$/.test(s)) return s; if(/^\d+$/.test(s)&&s.length>=9) return `-100${s}`; return s; }
function ownerIds(env) { const raw=String(env.TG_OWNER_IDS||'').trim(); return raw ? new Set(raw.split(',').map(x=>x.trim()).filter(Boolean)) : null; }
function isGod(id,env) { const ids=ownerIds(env); return !ids || ids.has(String(id||'')); }
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
async function legacyFetch(update,env){
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET||'').trim() || await legacy.webhookSecret?.(env).catch(()=>null) || '';
  const headers = {'content-type':'application/json'};
  if(secret) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return legacy.fetch(new Request('https://athena.internal/api/telegram-webhook',{method:'POST',headers,body:JSON.stringify(update)}),env,{});
}
function cloneUpdate(update,text){ const u=structuredClone(update); u.message.text=text; u.message.caption=undefined; u.message.entities=[{type:'bot_command',offset:0,length:parts(text)[0].length}]; return u; }
// legacy's /userbotconnect alias reads a label from the first argument; the
// documented form starts with api_id, so translate to /userbot_add first.
async function userbotConnect(update,env){ const msg=update.message,args=parts(msg.text); if(!isGod(msg.from?.id,env)) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'GOD rank only.'); if(String(msg.chat.id).startsWith('-')) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Session strings are secrets — DM Athena only.'); if(args.length<4) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /userbotconnect <api_id> <api_hash> <session_string>'); return legacyFetch(cloneUpdate(update,`/userbot_add main ${args[1]} ${args[2]} ${args.slice(3).join(' ')}`),env); }
// No chat id stops every running clone for the caller — that is what the
// optional [chat_id] in /help means; in a group the current chat is the default.
async function cloneStop(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x))||(String(msg.chat.id).startsWith('-')?String(msg.chat.id):''); return legacyFetch(cloneUpdate(update,`/index_stop${chat?` ${normalizeChatId(chat)}`:''}`),env); }
async function ucloneDel(update,env){ const msg=update.message,args=parts(msg.text).slice(1),chat=args.find(x=>/^-?\d{5,}$/.test(x)); if(!chat) return reply(env.TELEGRAM_BOT_TOKEN,msg.chat.id,'Usage: /uclone_del <chat_id> [topic_id]'); const topic=args.find(x=>/^\d{1,9}$/.test(x)&&x!==chat); return legacyFetch(cloneUpdate(update,`/delete ${chat}${topic?` ${topic}`:''} files`),env); }
// Only commands the legacy webhook cannot serve itself are rewritten here.
// /clone, /uclone, /ubclone and /stats already reach the legacy dispatcher with
// their original text, so forwarding them adds a JSON round-trip and no behavior.
async function intercept(update,env,_ctx){ const msg=update.message; if(!msg?.text||!env.TELEGRAM_BOT_TOKEN) return null;
  switch(command(msg.text)){ case '/userbotconnect':return userbotConnect(update,env); case '/uclone_del':return ucloneDel(update,env); case '/clone_stop':return cloneStop(update,env); default:return null; } }
export default {async fetch(request,env,ctx){ shimApiBase = shimBaseFor(env); const url=new URL(request.url); if(request.method==='POST'&&/telegram-webhook$/.test(url.pathname)){ try{const update=await request.clone().json(); const handled=await intercept(update,env,ctx); if(handled)return handled;}catch(_){} } return legacy.fetch(request,env,ctx); }};
