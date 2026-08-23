import legacy from './index_legacy.js';

const TARGETS = new Set(['community', 'personal', 'both']);

function parts(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }
function command(text) { return parts(text)[0]?.split('@')[0]?.toLowerCase() || ''; }
function targetOf(args) { return args.find((x) => TARGETS.has(String(x).toLowerCase()))?.toLowerCase() || 'community'; }
function normalizeChatId(id) {
  const s = String(id || '').trim();
  if (/^-100\d+$/.test(s)) return s;
  if (/^\d+$/.test(s) && s.length >= 5) return `-100${s.replace(/^-100/, '')}`;
  return s;
}
function ownerIdSet(env) {
  const raw = String(env.TG_OWNER_IDS || '').trim();
  return raw ? new Set(raw.split(',').map((x) => x.trim()).filter(Boolean)) : null;
}
function isGod(tgUserId, env) {
  const configured = ownerIdSet(env);
  return !configured || configured.has(String(tgUserId || ''));
}
async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
  });
  return r.json().catch(() => ({ ok: false, description: 'Invalid Telegram response' }));
}
async function reply(token, chatId, text, threadId) {
  const body = { chat_id: chatId, text };
  if (threadId != null) body.message_thread_id = threadId;
  await tg(token, 'sendMessage', body).catch(() => {});
  return new Response('OK');
}
async function ensureTables(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS bot_clone_targets (
    chat_id TEXT PRIMARY KEY, community_id TEXT, target TEXT NOT NULL DEFAULT 'community',
    status TEXT NOT NULL DEFAULT 'live', forum INTEGER NOT NULL DEFAULT 0,
    created_by TEXT, created_at BIGINT, updated_at BIGINT
  )`).run().catch(() => {});
  await DB.prepare(`CREATE TABLE IF NOT EXISTS userbot_clone_defaults (
    label TEXT PRIMARY KEY, community_id TEXT, updated_at BIGINT
  )`).run().catch(() => {});
}
async function binding(DB, chatId) {
  return DB.prepare(`SELECT * FROM community_bots WHERE platform='telegram' AND group_id=? ORDER BY created_at DESC LIMIT 1`)
    .bind(String(chatId)).first().catch(() => null);
}
async function botClone(update, env) {
  const msg = update.message || update.edited_message;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = String(msg.chat.id);
  const args = parts(msg.text).slice(1);
  let remote = args.find((x) => /^-?\d{5,}$/.test(x)) || (chatId.startsWith('-') ? chatId : '');
  if (!remote) return reply(token, chatId, 'Usage: /clone <chat_id> <community|personal|both>');
  remote = String(remote);
  const info = await tg(token, 'getChat', { chat_id: remote });
  if (!info.ok) return reply(token, chatId, `Cannot access ${remote}: ${info.description || 'Telegram rejected the chat.'}`);
  if (info.result.type === 'private') return reply(token, chatId, 'Bot cloning is for channels and groups. Use /uclone for history + live.');
  const me = await tg(token, 'getMe', {});
  const member = me.ok ? await tg(token, 'getChatMember', { chat_id: remote, user_id: me.result.id }) : null;
  if (!member?.ok || !['administrator', 'creator'].includes(member.result?.status)) return reply(token, chatId, 'Athena must be an administrator in that channel/group.');
  const b = await binding(env.DB, remote);
  if (!b?.community_id) {
    return reply(token, chatId, info.result.type === 'channel'
      ? `Link the channel first: /channel_link <community_id> ${remote}`
      : `This group is not linked to a community. Verify/link it first, then run /clone ${remote} community.`);
  }
  const target = targetOf(args);
  if ((target === 'personal' || target === 'both') && !isGod(msg.from?.id, env)) return reply(token, chatId, 'personal and both targets are GOD-only.');
  await ensureTables(env.DB);
  const now = Date.now();
  const forum = info.result.is_forum ? 1 : 0;
  if (info.result.type === 'channel') {
    await env.DB.prepare('UPDATE community_bots SET channel_target=? WHERE id=?').bind(target, b.id).run().catch(() => {});
  } else {
    // Full-copy mode is the single group switch: links/files were already live;
    // copy_text also captures text-only posts and the same sink target is reused.
    await env.DB.prepare('UPDATE community_bots SET copy_text=1, channel_target=? WHERE id=?').bind(target, b.id).run().catch(() => {});
  }
  await env.DB.prepare(`INSERT INTO bot_clone_targets
    (chat_id,community_id,target,status,forum,created_by,created_at,updated_at)
    VALUES (?,?,?,'live',?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET community_id=excluded.community_id,target=excluded.target,status='live',forum=excluded.forum,updated_at=excluded.updated_at`
  ).bind(remote, b.community_id, target, forum, String(msg.from?.id || ''), now, now).run();
  return reply(token, chatId,
    `✅ Live indexing enabled\n${info.result.title || remote}\nTarget: ${target}\nForum: ${forum ? 'yes — topic-wise live tracking' : 'no'}\n\nBot mode indexes new messages. Full history is /uclone.`, msg.message_thread_id);
}
async function userbotConnect(update, env) {
  const msg = update.message;
  const args = parts(msg.text);
  if (!isGod(msg.from?.id, env)) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'GOD rank only.');
  if (String(msg.chat.id).startsWith('-')) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'Session strings are secrets — DM only.');
  if (args.length < 5) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'Usage: /userbotconnect <api_id> <api_hash> <session_string> <community_id>');
  const communityId = args.at(-1);
  const session = args.slice(3, -1).join(' ');
  const legacyText = `/userbot_add main ${args[1]} ${args[2]} ${session}`;
  await ensureTables(env.DB);
  await env.DB.prepare(`INSERT INTO userbot_clone_defaults(label,community_id,updated_at) VALUES ('main',?,?)
    ON CONFLICT(label) DO UPDATE SET community_id=excluded.community_id,updated_at=excluded.updated_at`)
    .bind(communityId, Date.now()).run().catch(() => {});
  const cloned = structuredClone(update);
  cloned.message.text = legacyText;
  cloned.message.entities = [{ type: 'bot_command', offset: 0, length: 12 }];
  return legacy.fetch(new Request('https://athena.internal/api/telegram-webhook', {
    method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify(cloned)
  }), env, {});
}
async function uclone(update, env) {
  const msg = update.message;
  const args = parts(msg.text).slice(1);
  const chat = args.find((x) => /^-?\d{5,}$/.test(x));
  if (!chat) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'Usage: /uclone <chat_id> <community|personal|both> [topic_id]');
  const target = targetOf(args);
  if ((target === 'personal' || target === 'both') && !isGod(msg.from?.id, env)) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'personal and both targets are GOD-only.');
  await ensureTables(env.DB);
  const def = await env.DB.prepare('SELECT community_id FROM userbot_clone_defaults WHERE label=\'main\'').first().catch(() => null);
  const community = def?.community_id || (await binding(env.DB, normalizeChatId(chat)))?.community_id || '';
  const topic = args.find((x) => /^\d{1,9}$/.test(x) && x !== chat);
  const all = !topic;
  const transformed = structuredClone(update);
  transformed.message.text = `/clone ${chat}${topic ? ` ${topic}` : all ? ' all' : ''} ${target}${community ? ` ${community}` : ''}`.trim();
  transformed.message.entities = [{ type: 'bot_command', offset: 0, length: 6 }];
  return legacy.fetch(new Request('https://athena.internal/api/telegram-webhook', {
    method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify(transformed)
  }), env, {});
}
async function cloneStop(update, env) {
  const msg = update.message; const args = parts(msg.text).slice(1);
  const chat = args.find((x) => /^-?\d{5,}$/.test(x)) || (String(msg.chat.id).startsWith('-') ? String(msg.chat.id) : '');
  if (!chat) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'Usage: /clone_stop [chat_id]');
  await ensureTables(env.DB);
  const n = normalizeChatId(chat);
  await env.DB.prepare("UPDATE bot_clone_targets SET status='stopped',updated_at=? WHERE chat_id=?").bind(Date.now(), n).run().catch(() => {});
  const b = await binding(env.DB, n);
  if (b) await env.DB.prepare('UPDATE community_bots SET copy_text=0 WHERE id=?').bind(b.id).run().catch(() => {});
  await env.DB.prepare('DELETE FROM userbot_follows WHERE chat_id=? OR chat_id LIKE ?').bind(n, `${n}:%`).run().catch(() => {});
  await env.DB.prepare("UPDATE index_jobs SET status='stopping',updated_at=? WHERE chat_id=? AND status IN ('queued','running','processing')").bind(Date.now(), n).run().catch(() => {});
  return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, `⏹ Clone stopped for ${n}.`, msg.message_thread_id);
}
async function stats(update, env) {
  await ensureTables(env.DB);
  const out = ['📊 ATHENA CLONING STATUS', '', 'BOT MODE'];
  const bots = await env.DB.prepare('SELECT chat_id,community_id,target,status,forum,updated_at FROM bot_clone_targets ORDER BY updated_at DESC').all().catch(() => ({ results: [] }));
  for (const r of bots.results || []) {
    const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE transfer_id=?').bind(`live:${r.chat_id}`).first().catch(() => ({ n: 0 }));
    const files = await env.DB.prepare('SELECT COUNT(*) AS n FROM uploaded_documents WHERE source_chat_id=?').bind(r.chat_id).first().catch(() => ({ n: 0 }));
    const today = Date.now() - (Date.now() % 86400000);
    const todayLinks = await env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE transfer_id=? AND created_at>=?').bind(`live:${r.chat_id}`, today).first().catch(() => ({ n: 0 }));
    const topics = await env.DB.prepare('SELECT thread_id FROM telegram_topic_bindings WHERE chat_id=? ORDER BY thread_id').bind(r.chat_id).all().catch(() => ({ results: [] }));
    out.push(`• ${r.chat_id} · ${r.status} · ${r.target} · links ${links?.n || 0} · files ${files?.n || 0} · today ${todayLinks?.n || 0}`);
    if (r.forum) out.push(`  topics: ${(topics.results || []).map((x) => x.thread_id).join(', ') || 'waiting for topic activity'}`);
  }
  out.push('', 'USERBOT MODE');
  const follows = await env.DB.prepare('SELECT chat_id,label,community_id,target FROM userbot_follows ORDER BY created_at DESC').all().catch(() => ({ results: [] }));
  for (const f of follows.results || []) out.push(`• ${f.chat_id} · ${f.label} · ${f.target || 'community'} · live`);
  if (!bots.results?.length && !follows.results?.length) out.push('• No clones configured.');
  return reply(env.TELEGRAM_BOT_TOKEN, update.message.chat.id, out.join('\n'), update.message.message_thread_id);
}
async function ucloneDel(update, env) {
  const msg = update.message; const args = parts(msg.text).slice(1);
  const chat = args.find((x) => /^-?\d{5,}$/.test(x));
  if (!chat) return reply(env.TELEGRAM_BOT_TOKEN, msg.chat.id, 'Usage: /uclone_del <chat_id> [topic_id]');
  const topic = args.find((x) => /^\d{1,9}$/.test(x) && x !== chat);
  const cloned = structuredClone(update);
  cloned.message.text = `/delete ${chat}${topic ? ` ${topic}` : ''} files`;
  cloned.message.entities = [{ type: 'bot_command', offset: 0, length: 7 }];
  return legacy.fetch(new Request('https://athena.internal/api/telegram-webhook', {
    method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify(cloned)
  }), env, {});
}
async function intercept(update, env) {
  const msg = update.message;
  if (!msg?.text || !env.TELEGRAM_BOT_TOKEN) return null;
  switch (command(msg.text)) {
    case '/clone': return botClone(update, env);
    case '/uclone': return uclone(update, env);
    case '/userbotconnect': return userbotConnect(update, env);
    case '/uclone_del': return ucloneDel(update, env);
    case '/clone_stop': return cloneStop(update, env);
    case '/stats': return stats(update, env);
    default: return null;
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && /telegram-webhook$/.test(url.pathname)) {
      try {
        const update = await request.clone().json();
        const handled = await intercept(update, env);
        if (handled) return handled;
      } catch (_) {}
    }
    return legacy.fetch(request, env, ctx);
  }
};
