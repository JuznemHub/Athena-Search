/*
 * Unified clone command layer.
 *
 * Bot mode is deliberately limited to live indexing: Telegram's Bot API does
 * not expose arbitrary chat history. Historical backfill is therefore handled
 * by /uclone (GramJS user session).
 *
 * The command layer keeps the public UX small while reusing Athena's existing
 * backfill/live pipelines underneath.
 */

function targetOf(parts) {
  for (const raw of parts.slice(1)) {
    const t = String(raw || '').trim().toLowerCase();
    if (t === 'community' || t === 'personal' || t === 'both') return t;
  }
  return 'community';
}

function chatArgFrom(parts, currentChatId) {
  const candidate = parts.slice(1).find((x) => /^-?\d{5,}$/.test(String(x || '').trim()));
  if (candidate) return candidate;
  return String(currentChatId || '').startsWith('-') ? String(currentChatId) : '';
}

function topicArgFrom(parts, currentMessage) {
  if (currentMessage?.is_topic_message && currentMessage?.message_thread_id != null) {
    return String(currentMessage.message_thread_id);
  }
  const nums = parts.slice(1).filter((x) => /^\d{1,9}$/.test(String(x || '').trim()));
  return nums.length >= 2 ? String(nums[nums.length - 1]) : '';
}

async function ensureTables(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_clone_targets (
      chat_id TEXT PRIMARY KEY,
      community_id TEXT,
      target TEXT NOT NULL DEFAULT 'community',
      status TEXT NOT NULL DEFAULT 'live',
      forum INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at BIGINT,
      updated_at BIGINT
    )
  `).run().catch(() => {});
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS userbot_clone_defaults (
      label TEXT PRIMARY KEY,
      community_id TEXT,
      updated_at BIGINT
    )
  `).run().catch(() => {});
}

async function botIsAdmin(telegramApi, token, chatId) {
  const me = await telegramApi(token, 'getMe');
  if (!me?.ok || !me.result?.id) return { ok: false, error: 'Could not resolve the bot identity.' };
  const member = await telegramApi(token, 'getChatMember', { chat_id: chatId, user_id: me.result.id });
  const status = member?.result?.status;
  if (status !== 'administrator' && status !== 'creator') {
    return { ok: false, error: 'Athena must be an administrator in that chat.' };
  }
  return { ok: true };
}

async function resolveBotBinding(DB, chatId) {
  return DB.prepare(
    `SELECT * FROM community_bots WHERE platform = 'telegram' AND group_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(chatId).first().catch(() => null);
}

async function handleBotClone(ctx) {
  const { DB, telegramApi, token, chatId, parts, athenaUser, isGod, send, escHtml } = ctx;
  const remoteChatId = chatArgFrom(parts, chatId);
  if (!remoteChatId) {
    return send('Usage: /clone <chat_id> <community|personal|both>\nRun it inside a group to use the current chat automatically.');
  }
  const chat = await telegramApi(token, 'getChat', { chat_id: remoteChatId });
  if (!chat?.ok) return send(`Cannot access ${remoteChatId}: ${chat?.description || 'Telegram rejected the chat.'}`);
  if (chat.result?.type === 'private') return send('Bot cloning is for channels and groups. Use /uclone for historical cloning with a user account.');
  const admin = await botIsAdmin(telegramApi, token, remoteChatId);
  if (!admin.ok) return send(admin.error);
  const binding = await resolveBotBinding(DB, remoteChatId);
  if (!binding?.community_id) {
    if (chat.result?.type === 'channel') return send(`Channel is ready, but it is not linked to a community.\nRun /channel_link <community_id> ${remoteChatId} first.`);
    return send(`This chat is not linked to a community yet.\nLink/verify the group first, then run /clone ${remoteChatId} community.`);
  }
  const target = targetOf(parts);
  if ((target === 'personal' || target === 'both') && !isGod) return send('personal and both targets are GOD-only.');
  await ensureTables(DB);
  const now = Date.now();
  const isChannel = chat.result?.type === 'channel';
  const forum = chat.result?.is_forum ? 1 : 0;
  if (isChannel) {
    await DB.prepare('UPDATE community_bots SET channel_target = ? WHERE id = ?').bind(target, binding.id).run().catch(() => {});
  } else if (target !== 'both') {
    await DB.prepare('UPDATE community_bots SET scope = ? WHERE id = ?').bind(target, binding.id).run().catch(() => {});
  }
  await DB.prepare(`
    INSERT INTO bot_clone_targets (chat_id, community_id, target, status, forum, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'live', ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET community_id=excluded.community_id,
      target=excluded.target, status='live', forum=excluded.forum, updated_at=excluded.updated_at
  `).bind(remoteChatId, binding.community_id, target, forum, athenaUser?.id || String(ctx.tgUserId || ''), now, now).run();
  const targetText = target === 'both' ? 'community + GOD personal' : target;
  return send(
    `✅ Live indexing enabled\n\n` +
    `${escHtml(chat.result.title || remoteChatId)}\n` +
    `ID: ${remoteChatId}\n` +
    `Target: ${targetText}\n` +
    `Forum: ${forum ? 'yes — messages are tracked by topic' : 'no'}\n\n` +
    `⚠️ Bot mode indexes new posts only. Telegram does not expose arbitrary historical chat history to Bot API clients. Use /uclone for the full history backfill.`
  );
}

async function startUserbotClone(ctx) {
  const { DB, token, chatId, parts, athenaUser, isGod, send, userbotAccounts, ensureUserbotTables,
    startUserbotAccount, primeEntity, startBackfillJob, getForumTopicsViaUserbot, isForumEnabled,
    normalizeTgChatId } = ctx;
  if (!ctx.isSelfHosted) return send('Userbot cloning is available only on the self-hosted server.');
  if (!athenaUser) return send('Login with Telegram first.');
  const target = targetOf(parts);
  if ((target === 'personal' || target === 'both') && !isGod) return send('personal and both targets are GOD-only.');
  const remoteChatId = chatArgFrom(parts, chatId);
  if (!remoteChatId) return send('Usage: /uclone <chat_id> <community|personal|both> [topic_id]');
  const normalizedChat = normalizeTgChatId(remoteChatId);
  await ensureUserbotTables(DB);
  const accountRows = await DB.prepare('SELECT label FROM userbot_accounts WHERE enabled = 1 ORDER BY label').all();
  const accounts = accountRows?.results || [];
  if (!accounts.length) return send('No userbot account connected. GOD: /userbotconnect <api_id> <api_hash> <session_string> <community_id>');
  let communityId = '';
  const explicitCommunity = parts.find((x) => /^c_/.test(String(x || '')));
  if (explicitCommunity) communityId = explicitCommunity;
  if (!communityId) {
    const def = await DB.prepare('SELECT community_id FROM userbot_clone_defaults WHERE label = ?').bind(accounts[0].label).first().catch(() => null);
    communityId = def?.community_id || '';
  }
  if (!communityId) {
    const binding = await resolveBotBinding(DB, normalizedChat);
    communityId = binding?.community_id || '';
  }
  if (!communityId && target === 'community') return send('No community is configured for this userbot. Connect it with /userbotconnect ... <community_id>.');
  if (communityId && !(await ctx.ensureOwnerOrAdmin(communityId, athenaUser.id)) && !isGod) return send('Community owner/GOD only.');
  let label = accounts[0].label;
  let acc = userbotAccounts.get(label);
  if (!acc) {
    const started = await startUserbotAccount(ctx.env, label);
    if (!started?.ok) return send(`Userbot ${label} is disconnected: ${started?.reason || 'unknown error'}`);
    acc = userbotAccounts.get(label);
  }
  if (!acc) return send('Userbot account is not available.');
  const visible = await primeEntity(acc.client, normalizedChat, 45_000);
  if (!visible) return send(`The userbot account cannot see ${normalizedChat}. Join that chat with the account and retry.`);
  const topicArg = topicArgFrom(parts, ctx.msg);
  const isForum = !topicArg && await isForumEnabled(token, normalizedChat, ctx.env).catch(() => false);
  let topics = [];
  if (isForum) topics = await getForumTopicsViaUserbot(ctx.env, normalizedChat).catch(() => []);
  const jobs = topics.length
    ? topics.map((t) => ({ threadArg: String(t.id), title: t.title || `#${t.id}` }))
    : [{ threadArg: topicArg, title: topicArg ? `#${topicArg}` : 'whole chat' }];
  for (const job of jobs) {
    const followChatId = job.threadArg ? `${normalizedChat}:${job.threadArg}` : normalizedChat;
    await DB.prepare(`
      INSERT INTO userbot_follows (chat_id, label, community_id, target, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET label=excluded.label, community_id=excluded.community_id,
        target=excluded.target, created_by=excluded.created_by
    `).bind(followChatId, label, communityId || null, target, athenaUser.id, Date.now()).run();
    await startBackfillJob(ctx.env, {
      token, chatId, forumThreadId: ctx.forumThreadId, athenaUser,
      communityIdArg: communityId, chatIdArg: normalizedChat, threadArg: job.threadArg,
      communityName: communityId || 'personal', userbotLabel: label
    });
  }
  return send(
    `🧬 Userbot clone started\n${normalizedChat}\nTarget: ${target}\n` +
    (jobs.length > 1 ? `Topics: ${jobs.length} — each topic has its own live follow + backfill.` : `Scope: ${jobs[0].title}`)
  );
}

async function userbotConnect(ctx) {
  const { DB, parts, send, isGod, chatId, isSelfHosted, ensureUserbotTables, encryptSecret, startUserbotAccount, env } = ctx;
  if (!isSelfHosted) return send('Userbot mode runs on the self-hosted server only.');
  if (!isGod) return send('GOD rank only.');
  if (String(chatId).startsWith('-')) return send('Session strings are secrets — DM only.');
  const apiId = parts[1] || '';
  const apiHash = parts[2] || '';
  const session = parts.slice(3, -1).join(' ');
  const communityId = parts[parts.length - 1] || '';
  if (!apiId || !apiHash || !session || !/^c_/.test(communityId)) return send('Usage: /userbotconnect <api_id> <api_hash> <session_string> <community_id>');
  const community = await DB.prepare('SELECT id, name FROM communities WHERE id = ?').bind(communityId).first().catch(() => null);
  if (!community) return send(`Community ${communityId} does not exist.`);
  await ensureUserbotTables(DB);
  const sessionEnc = await encryptSecret(env, session.trim());
  const apiHashEnc = await encryptSecret(env, apiHash.trim());
  if (!String(sessionEnc).startsWith('enc:v1:') || !String(apiHashEnc).startsWith('enc:v1:')) return send('STORAGE_KEY is required; refusing to store a user session unencrypted.');
  await DB.prepare(`
    INSERT INTO userbot_accounts (label, api_id, api_hash_enc, session_enc, enabled, updated_at)
    VALUES ('main', ?, ?, ?, 1, ?)
    ON CONFLICT(label) DO UPDATE SET api_id=excluded.api_id, api_hash_enc=excluded.api_hash_enc,
      session_enc=excluded.session_enc, enabled=1, last_error=NULL, updated_at=excluded.updated_at
  `).bind(apiId.trim(), apiHashEnc, sessionEnc, Date.now()).run();
  await DB.prepare(`
    INSERT INTO userbot_clone_defaults (label, community_id, updated_at) VALUES ('main', ?, ?)
    ON CONFLICT(label) DO UPDATE SET community_id=excluded.community_id, updated_at=excluded.updated_at
  `).bind(communityId, Date.now()).run();
  const started = await startUserbotAccount(env, 'main');
  return send(started?.ok
    ? `✅ Userbot connected. Default community: ${community.name || communityId}\nUse /uclone <chat_id> <community|personal|both>.`
    : `❌ Userbot connection failed: ${started?.reason || 'unknown error'}`);
}

async function deleteUserbotClone(ctx) {
  const { DB, parts, send, isGod, ensureTransferColumns, normalizeTgChatId, MEDIA_VAULT_DIR } = ctx;
  if (!isGod) return send('GOD rank only.');
  const chat = chatArgFrom(parts, '');
  if (!chat) return send('Usage: /uclone_del <chat_id> [topic_id]');
  const normalized = normalizeTgChatId(chat);
  const topic = topicArgFrom(parts, null);
  await ensureTransferColumns(DB);
  const jobRows = topic
    ? await DB.prepare('SELECT id FROM index_jobs WHERE chat_id = ? AND thread_id = ?').bind(normalized, topic).all().catch(() => ({ results: [] }))
    : await DB.prepare('SELECT id FROM index_jobs WHERE chat_id = ?').bind(normalized).all().catch(() => ({ results: [] }));
  const ids = (jobRows.results || []).map((r) => r.id);
  const transfers = [...ids, `live:${normalized}`];
  if (topic) transfers.push(`live:${normalized}:${topic}`);
  const ph = transfers.map(() => '?').join(',');
  for (const table of ['links', 'personal_links', 'uploaded_documents']) {
    await DB.prepare(`DELETE FROM ${table} WHERE transfer_id IN (${ph})`).bind(...transfers).run().catch(() => {});
  }
  if (ids.length) await DB.prepare(`DELETE FROM index_jobs WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run().catch(() => {});
  if (topic) {
    await DB.prepare('DELETE FROM userbot_follows WHERE chat_id IN (?, ?)').bind(normalized, `${normalized}:${topic}`).run().catch(() => {});
    await DB.prepare('DELETE FROM telegram_topic_bindings WHERE chat_id = ? AND thread_id = ?').bind(normalized, topic).run().catch(() => {});
  } else {
    await DB.prepare('DELETE FROM userbot_follows WHERE chat_id = ? OR chat_id LIKE ?').bind(normalized, `${normalized}:%`).run().catch(() => {});
    await DB.prepare('DELETE FROM telegram_topic_bindings WHERE chat_id = ?').bind(normalized).run().catch(() => {});
  }
  if (MEDIA_VAULT_DIR) {
    try {
      const { rm } = await import('node:fs/promises');
      await rm(`${MEDIA_VAULT_DIR}/${normalized.replace(/[^\w-]+/g, '_')}`, { recursive: true, force: true });
    } catch (_) {}
  }
  return send(`🗑 Userbot clone deleted: ${normalized}${topic ? ` topic ${topic}` : ''}`);
}

async function cloneStop(ctx) {
  const { DB, chatId, parts, send, normalizeTgChatId } = ctx;
  const chat = chatArgFrom(parts, chatId);
  if (!chat) return send('Usage: /clone_stop [chat_id]');
  const normalized = normalizeTgChatId(chat);
  await ensureTables(DB);
  await DB.prepare("UPDATE bot_clone_targets SET status='stopped', updated_at=? WHERE chat_id=?").bind(Date.now(), normalized).run().catch(() => {});
  await DB.prepare('DELETE FROM userbot_follows WHERE chat_id = ? OR chat_id LIKE ?').bind(normalized, `${normalized}:%`).run().catch(() => {});
  await DB.prepare("UPDATE index_jobs SET status='stopping', updated_at=? WHERE chat_id=? AND status IN ('queued','running','processing')").bind(Date.now(), normalized).run().catch(() => {});
  return send(`⏹ Clone stopped for ${normalized}.`);
}

async function stats(ctx) {
  const { DB, send } = ctx;
  await ensureTables(DB);
  const lines = ['📊 ATHENA CLONING STATUS', '', 'BOT MODE'];
  const botRows = await DB.prepare(`SELECT chat_id, community_id, target, status, forum, updated_at FROM bot_clone_targets ORDER BY updated_at DESC`).all().catch(() => ({ results: [] }));
  for (const r of botRows.results || []) {
    const link = await DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE transfer_id = ?`).bind(`live:${r.chat_id}`).first().catch(() => ({ n: 0 }));
    const doc = await DB.prepare(`SELECT COUNT(*) AS n FROM uploaded_documents WHERE transfer_id = ?`).bind(`live:${r.chat_id}`).first().catch(() => ({ n: 0 }));
    const topics = await DB.prepare(`SELECT thread_id FROM telegram_topic_bindings WHERE chat_id = ? ORDER BY thread_id`).bind(r.chat_id).all().catch(() => ({ results: [] }));
    lines.push(`• ${r.chat_id} · ${r.status} · target=${r.target} · links=${link?.n || 0} · files=${doc?.n || 0}`);
    if (r.forum) lines.push(`  topics tracked: ${(topics.results || []).map((t) => t.thread_id).join(', ') || 'waiting for posts'}`);
  }
  lines.push('', 'USERBOT MODE');
  const follows = await DB.prepare(`SELECT chat_id, label, community_id, target FROM userbot_follows ORDER BY created_at DESC`).all().catch(() => ({ results: [] }));
  for (const f of follows.results || []) {
    const base = String(f.chat_id).split(':')[0];
    const link = await DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE transfer_id LIKE ?`).bind(`live:${base}%`).first().catch(() => ({ n: 0 }));
    const doc = await DB.prepare(`SELECT COUNT(*) AS n FROM uploaded_documents WHERE transfer_id LIKE ?`).bind(`live:${base}%`).first().catch(() => ({ n: 0 }));
    lines.push(`• ${f.chat_id} · ${f.label} · target=${f.target || 'community'} · links=${link?.n || 0} · files=${doc?.n || 0}`);
  }
  if (!botRows.results?.length && !follows.results?.length) lines.push('• No active clones.');
  return send(lines.join('\n'));
}

export async function handleCloneModeCommand(ctx) {
  const cmd = String(ctx.cmd || '').toLowerCase();
  if (cmd === '/clone') return handleBotClone(ctx);
  if (cmd === '/uclone') return startUserbotClone(ctx);
  if (cmd === '/userbotconnect') return userbotConnect(ctx);
  if (cmd === '/uclone_del') return deleteUserbotClone(ctx);
  if (cmd === '/clone_stop') return cloneStop(ctx);
  if (cmd === '/stats') return stats(ctx);
  return null;
}
