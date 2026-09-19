import { emptyCloneCounters, scanCloneHistory } from './clone-content.js';
import { paginateCloneTopics, renderCloneProgress, renderCloneStatistics } from './clone-ui.js';

const activeRuns = new Map();
const accountQueues = new Map();
const terminal = new Set(['done', 'stopped', 'error']);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Pause before re-running a topic that could not finish, so a transient write
// or flood failure has a chance to clear before the single retry.
const TOPIC_RETRY_PAUSE_MS = 60000;
const uuid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

export function cloneFailure(error) {
  const text = String(error?.errorMessage || error?.message || error || '');
  if (/AUTH_KEY|SESSION_|USER_DEACTIVATED|UNAUTHORIZED|decrypt/i.test(text)) return { category: 'session', message: 'Selected account needs reauthentication. In a DM, use /userbot_add with the same label, then retry this clone.' };
  if (/CHANNEL_PRIVATE|CHAT_FORBIDDEN|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED|permission|cannot see/i.test(text)) return { category: 'permission', message: 'The selected account cannot read this source. Restore its access, then retry.' };
  if (/FLOOD|429/i.test(text) || Number(error?.seconds) > 0) return { category: 'flood', message: 'Telegram requested a pause. This clone will wait before retrying.' };
  if (/timeout|ECONN|network|disconnect/i.test(text)) return { category: 'network', message: 'Telegram connection failed after bounded retries. Retry the clone when the connection is restored.' };
  if (/CONVERSION|convert/i.test(text)) return { category: 'conversion', message: 'The original file could not be converted. Its failure is recorded; other items continue.' };
  if (/SIZE_LIMIT|exceeds/i.test(text)) return { category: 'size', message: 'The file exceeds the configured storage or converter limit.' };
  if (/VAULT|ENOSPC|EACCES|storage/i.test(text)) return { category: 'storage', message: 'Original-file storage is unavailable. Configure ATHENA_MEDIA_DIR and retry failed files.' };
  if (/constraint|SQL|database|column|relation/i.test(text)) return { category: 'database', message: 'A database write failed. The item was not reported as saved.' };
  return { category: 'operation', message: 'Clone operation failed. No account was substituted. Check server diagnostics and retry.' };
}

export async function withCloneAccount(label, operation) {
  const previous = accountQueues.get(label) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  accountQueues.set(label, next);
  try { return await next; } finally { if (accountQueues.get(label) === next) accountQueues.delete(label); }
}

export async function ensureUcloneTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pending_clones (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, thread_id TEXT, community_id TEXT, target TEXT,
    requester_tg_id TEXT NOT NULL, requester_user_id TEXT NOT NULL, stats_json TEXT NOT NULL,
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS userbot_selections (
    requester_tg_id TEXT PRIMARY KEY, label TEXT NOT NULL, updated_at BIGINT NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pending_clones_expiry ON pending_clones(expires_at)').run();
}

function parseRow(row) {
  if (!row) return null;
  const state = JSON.parse(row.stats_json);
  return state.manager === 'uclone' ? { ...row, state } : null;
}

export function createUcloneManager(env, deps) {
  const clock = deps.now || Date.now;
  const sleep = deps.sleep || pause;
  const db = env.DB;
  const background = (task) => deps.background(task.catch((error) => deps.log?.(cloneFailure(error).category)));
  const load = async (id) => parseRow(await db.prepare('SELECT * FROM pending_clones WHERE id=?').bind(id).first());
  const persist = async (run) => {
    for (;;) {
      const current = await db.prepare('SELECT stats_json FROM pending_clones WHERE id=?').bind(run.id).first();
      if (!current) throw new Error('CLONE_STATE_MISSING');
      const latest = JSON.parse(current.stats_json);
      if (latest.cancelled) { run.state.cancelled = true; run.state.stage = 'stopped'; run.state.revision = Math.max(run.state.revision, latest.revision); }
      const result = await db.prepare('UPDATE pending_clones SET stats_json=?,target=?,community_id=?,expires_at=? WHERE id=? AND stats_json=?')
        .bind(JSON.stringify(run.state), run.target || null, run.community_id || null, run.expires_at, run.id, current.stats_json).run();
      if (Number(result?.meta?.changes ?? result?.changes ?? 0) === 1) return;
    }
  };
  async function account(label) {
    const row = await db.prepare('SELECT label, enabled FROM userbot_accounts WHERE label=?').bind(label).first();
    if (!row?.enabled) throw new Error('SESSION_NOT_CONFIGURED');
    const result = await deps.startAccount(label);
    if (!result?.ok && result?.reason !== 'starting') throw new Error('SESSION_UNAVAILABLE');
    for (let attempt = 0; attempt < 30; attempt++) {
      const client = deps.getClient(label);
      if (client?.connected !== false && client) return client;
      if (result?.reason !== 'starting') break;
      await sleep(1000);
    }
    throw new Error('SESSION_UNAVAILABLE');
  }
  async function authorized(run, context) {
    if (!context.isGod || !context.user || String(context.user.id) !== run.requester_user_id ||
        String(context.tgUserId) !== run.requester_tg_id || String(context.chatId) !== run.state.progressChatId ||
        Number(context.messageId) !== Number(run.state.progressMessageId) || run.expires_at <= clock()) return false;
    return !run.community_id || await deps.authorizeCommunity(context.user, run.community_id);
  }
  const richBody = (text, rows = []) => text + rows.map(row => '<tg-button-row>' + row.map(control => `<tg-button type="callback_data" data="${esc(control.callback_data)}">${esc(control.text)}</tg-button>`).join('') + '</tg-button-row>').join('');
  async function deliver(token, method, address, text, rows = []) {
    const response = await deps.telegram(token, method, { ...address, rich_message: { html: richBody(text, rows) } });
    if (response?.ok || response?.parameters?.retry_after || /message is not modified/i.test(response?.description || '')) return response;
    console.error('[uclone] rich message rejected:', response?.description || 'Unknown Telegram error');
    const fallback = await deps.telegram(token, method === 'sendRichMessage' ? 'sendMessage' : method, {
      ...address, text: deps.classicText(text), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows },
    });
    if (!fallback?.ok && !fallback?.parameters?.retry_after && !/message is not modified/i.test(fallback?.description || '')) {
      console.error('[uclone] classic message rejected:', fallback?.description || 'Unknown Telegram error');
      throw new Error('TELEGRAM_PROGRESS_UPDATE_FAILED');
    }
    return fallback;
  }
  async function send(context, text, keyboard = []) {
    const response = await deliver(context.token, 'sendRichMessage', {
      chat_id: context.chatId,
      ...(context.threadId ? { message_thread_id: context.threadId } : {}),
    }, text, keyboard);
    if (!response?.ok || !response.result?.message_id) throw new Error('PROGRESS_MESSAGE_FAILED');
    return response.result.message_id;
  }
  const button = (run, text, action, index = '') => ({ text: String(text).slice(0, 48), callback_data: `uc:${run.id}:${run.state.revision}:${action}${index === '' ? '' : ':' + index}` });
  async function edit(run, token, text, rows = [], force = false) {
    if (!force && clock() < Number(run.state.nextEditAt || 0)) { await persist(run); return; }
    const response = await deliver(token, 'editMessageText', {
      chat_id: run.state.progressChatId, message_id: run.state.progressMessageId,
    }, text, rows);
    const retry = Number(response?.parameters?.retry_after || 0);
    run.state.nextEditAt = clock() + Math.max(8000, retry * 1000);
    await persist(run);
    if (retry && force) {
      await sleep(retry * 1000);
      return edit(run, token, text, rows, true);
    }
  }
  async function create(context, source, state) {
    const now = clock();
    const run = {
      id: uuid(), chat_id: source, thread_id: null, community_id: null, target: null,
      requester_tg_id: String(context.tgUserId), requester_user_id: String(context.user.id),
      created_at: now, expires_at: now + 24 * 60 * 60 * 1000,
      state: { manager: 'uclone', revision: 0, progressChatId: String(context.chatId), progressThreadId: context.threadId || null, ...state },
    };
    run.state.progressMessageId = await send(context, state.stage === 'accounts' ? '<b>Saved userbot accounts</b>' : '<b>Clone requested</b>\nChecking the selected account and measuring accessible history…');
    await db.prepare('INSERT INTO pending_clones (id,chat_id,thread_id,community_id,target,requester_tg_id,requester_user_id,stats_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(run.id, source, null, null, null, run.requester_tg_id, run.requester_user_id, JSON.stringify(run.state), now, run.expires_at).run();
    return run;
  }
  async function accounts(run, token) {
    const { results } = await db.prepare('SELECT label, enabled, last_error, telegram_id, telegram_username, display_name, phone_masked, verified_at FROM userbot_accounts ORDER BY label').all();
    const selection = await db.prepare('SELECT label FROM userbot_selections WHERE requester_tg_id=?').bind(run.requester_tg_id).first();
    run.state.accounts = results.map((a) => a.label);
    run.state.stage = 'accounts';
    run.state.revision++;
    const page = Math.max(0, Math.min(Number(run.state.page || 0), Math.max(0, Math.ceil(results.length / 8) - 1)));
    run.state.page = page;
    const shown = results.slice(page * 8, page * 8 + 8);
    const rows = shown.flatMap((a, index) => [
      [button(run, `${selection?.label === a.label ? 'Selected: ' : 'Select: '}${a.label}`, 'select', page * 8 + index)],
      [button(run, 'Status', 'status', page * 8 + index), button(run, 'Reauthenticate', 'reauth', page * 8 + index), button(run, 'Remove', 'remove', page * 8 + index)],
    ]);
    rows.push([button(run, 'Add Account', 'add')]);
    if (page > 0) rows.push([button(run, 'Previous', 'accounts', page - 1)]);
    if ((page + 1) * 8 < results.length) rows.push([button(run, 'Next', 'accounts', page + 1)]);
    await edit(run, token, `<b>Saved userbot accounts</b>\nSelected: <code>${esc(selection?.label || 'none')}</code>\n${shown.map((a) => `<b>${esc(a.label)}</b> — ${a.enabled ? (a.last_error ? 'needs attention' : a.verified_at ? 'verified' : 'enabled') : 'disabled'}\nUsername: ${a.telegram_username ? '@' + esc(a.telegram_username) : 'not set'}\nName: ${esc(a.display_name || 'not available')}\nAccount ID: <code>${esc(a.telegram_id || 'not available')}</code>\nPhone: ${esc(a.phone_masked || 'not shared')}\nSession: ********`).join('\n\n')}`, rows, true);
  }
  async function listTopics(client, source, label, onProgress) {
    if (deps.listTopics) return deps.listTopics(client, source, label, onProgress);
    const { Api } = await import('telegram');
    const topics = new Map();
    let offsetDate = 0, offsetId = 0, offsetTopic = 0;
    for (;;) {
      await onProgress?.(topics.size);
      await deps.beforeRequest(label);
      let page;
      try {
        page = await client.invoke(new Api.channels.GetForumTopics({ channel: source, offsetDate, offsetId, offsetTopic, limit: 100 }));
      } catch (error) {
        if (Number(error?.seconds) > 0) { await deps.onFlood(label, Number(error.seconds)); continue; }
        throw error;
      }
      const items = (page?.topics || []).filter((t) => t.id != null && !/Deleted/.test(t.className || ''));
      if (!items.length) break;
      const previousSize = topics.size;
      for (const topic of items) topics.set(String(topic.id), { id: String(topic.id), name: String(topic.title || `Topic ${topic.id}`) });
      const last = items.at(-1);
      const lastMessage = page.messages?.find((message) => Number(message.id) === Number(last.topMessage));
      const date = page.orderByCreateDate ? last.date : lastMessage?.date;
      if (date == null) throw new Error('TOPIC_PAGINATION_DATE_MISSING');
      const next = [Number(date), Number(last.topMessage || 0), Number(last.id)];
      if (next[0] === offsetDate && next[1] === offsetId && next[2] === offsetTopic) throw new Error('TOPIC_PAGINATION_STALLED');
      [offsetDate, offsetId, offsetTopic] = next;
      if (topics.size === previousSize) throw new Error('TOPIC_PAGINATION_STALLED');
      if (Number.isInteger(page.count) && topics.size >= page.count) break;
    }
    if (!topics.has('1')) topics.set('1', { id: '1', name: 'General' });
    return [...topics.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }
  async function preview(run, token) {
    const checkCancelled = async () => {
      if ((await load(run.id))?.state.cancelled) { const error = new Error('CANCELLED'); error.name = 'AbortError'; throw error; }
    };
    const scanning = async (counters = {}, topic = null, status = 'Measuring accessible history') => {
      await checkCancelled();
      await edit(run, token, renderCloneProgress({ sourceName: run.state.sourceName, chatId: run.chat_id, destination: 'Not selected', status, currentTopic: topic, processed: counters.messages || 0, total: null, counters }), [[button(run, 'Cancel scan', 'stop')]]);
    };
    return withCloneAccount(run.state.label, async () => {
      try {
        const client = await account(run.state.label);
        await deps.beforeRequest(run.state.label);
        const entity = await client.getEntity(run.chat_id);
        if (!entity || !['Channel', 'Chat'].includes(entity.className) || entity.left || entity.kicked || entity.deactivated) throw new Error('CHAT_FORBIDDEN');
        run.state.sourceName = entity.title || run.chat_id;
        run.state.username = entity.username || null;
        run.state.members = entity.participantsCount ?? null;
        run.state.sourceType = entity.className === 'Channel' && entity.broadcast ? 'channel' : 'group';
        if (run.state.members == null) {
          try {
            const { Api } = await import('telegram');
            await deps.beforeRequest(run.state.label);
            const full = await client.invoke(entity.className === 'Channel' ? new Api.channels.GetFullChannel({ channel: run.chat_id }) : new Api.messages.GetFullChat({ chatId: entity.id }));
            run.state.members = full.fullChat?.participantsCount ?? full.fullChat?.participants?.participants?.length ?? null;
          } catch (error) { deps.log?.(`member-count: ${cloneFailure(error).category}`); }
        }
        run.state.isForum = !!entity.forum;
        await edit(run, token, '<b>Measuring accessible history</b>\nYou can cancel during discovery or scanning.', [[button(run, 'Cancel scan', 'stop')]], true);
        run.state.topics = entity.forum ? await listTopics(client, run.chat_id, run.state.label, (n) => scanning({}, null, `Discovering topics: ${n}`)) : [];
        run.state.measurement = 'accessible-history';
        const result = await scanCloneHistory(client, run.chat_id, {
          beforeRequest: async () => { await checkCancelled(); await deps.beforeRequest(run.state.label); }, onFlood: (seconds) => deps.onFlood(run.state.label, seconds),
          onProgress: (progress) => scanning(progress.counters || progress),
        });
        run.state.snapshot = result.maxId;
        run.state.counters = result.counters;
        if (run.state.isForum) {
          for (const topic of run.state.topics) {
            const current = await load(run.id);
            if (current?.state.cancelled) throw new Error('CANCELLED');
            const scan = await scanCloneHistory(client, run.chat_id, {
              threadId: topic.id, maxId: result.maxId,
              beforeRequest: async () => { await checkCancelled(); await deps.beforeRequest(run.state.label); }, onFlood: (seconds) => deps.onFlood(run.state.label, seconds),
              onProgress: (progress) => scanning(progress.counters || progress, topic, `Measuring topic ${topic.name}`),
            });
            topic.counters = scan.counters;
          }
          run.state.stage = 'topics';
          run.state.page = 0;
          await topicMenu(run, token);
        } else {
          run.state.chosen = [{ id: null, name: run.state.sourceName, counters: result.counters }];
          await destinations(run, token);
        }
      } catch (error) {
        const cancelled = (await load(run.id))?.state.cancelled;
        run.state.stage = cancelled ? 'stopped' : 'error';
        run.state.error = cancelled ? null : cloneFailure(error).message;
        await edit(run, token, cancelled ? '<b>Clone stopped</b>' : `<b>Clone could not start</b>\n${esc(run.state.error)}`, [[button(run, 'Retry clone', 'retry')]], true);
      }
    });
  }
  async function topicMenu(run, token) {
    run.state.stage = 'topics';
    run.state.revision++;
    const page = paginateCloneTopics(run.state.topics, run.state.page || 0);
    run.state.page = page.page;
    // Ten choice rows per view leave room for statistics and navigation.
    const first = Number(run.state.topicOffset || 0);
    const shown = page.topics.slice(first, first + 10);
    const rows = shown.map((t) => {
      const index = run.state.topics.findIndex((item) => String(item.id) === String(t.id));
      return [button(run, `${t.id}: ${t.name || t.title}`, 'topic', index), button(run, 'Statistics', 'stats', index)];
    });
    if (first > 0) rows.push([button(run, 'Previous choices', 'offset', Math.max(0, first - 10))]);
    if (first + 10 < page.topics.length) rows.push([button(run, 'More choices', 'offset', first + 10)]);
    if (page.page > 0) rows.push([button(run, 'Previous page', 'page', page.page - 1)]);
    if (page.page + 1 < page.pages) rows.push([button(run, 'Next page', 'page', page.page + 1)]);
    rows.push([button(run, 'All topics, sequentially', 'all'), button(run, 'Cancel', 'stop')]);
    await edit(run, token, `<b>${esc(String(run.state.sourceName).slice(0, 120))}</b>\n${page.text}\nChoose one topic or all topics.`, rows, true);
  }
  async function destinations(run, token) {
    run.state.stage = 'destination';
    run.state.revision++;
    run.state.communities = await deps.listCommunities({ id: run.requester_user_id });
    const page = Math.max(0, Number(run.state.destinationPage || 0));
    const rows = [[button(run, 'Personal', 'personal')]];
    for (const [index, community] of run.state.communities.entries()) {
      if (index < page * 8 || index >= (page + 1) * 8) continue;
      const name = community.name || community.id;
      rows.push([button(run, `${name} — community DB`, 'community', index), button(run, `${name} — Personal + community`, 'both', index)]);
    }
    if (page > 0) rows.push([button(run, 'Previous communities', 'destpage', page - 1)]);
    if ((page + 1) * 8 < run.state.communities.length) rows.push([button(run, 'More communities', 'destpage', page + 1)]);
    rows.push([button(run, 'Back to topic statistics', 'topics'), button(run, 'Cancel', 'stop')]);
    const counters = run.state.chosen.reduce((sum, topic) => { for (const key of Object.keys(sum)) sum[key] += Number(topic.counters?.[key] || 0); return sum; }, emptyCloneCounters());
    run.state.total = counters.messages;
    await edit(run, token, renderCloneStatistics({ sourceName: run.state.sourceName, chatId: run.chat_id, username: run.state.username, members: run.state.members, topic: run.state.chosen.length === 1 && run.state.isForum ? run.state.chosen[0] : null, counters, complete: true, measurement: 'accessible-history' }) + '\n\nChoose a destination. Personal is your private brain; community DB is the selected community. Nothing has been copied yet.', rows, true);
  }
  async function returnToTopics(run, token) {
    run.state.cancelled = false;
    run.state.childId = null;
    run.state.cursor = 0;
    run.state.failedTopics = [];
    run.state.retriedChildId = null;
    run.state.transition = null;
    run.state.cloneAttempt = Number(run.state.cloneAttempt || 0) + 1;
    await topicMenu(run, token);
  }
  async function progress(run, token, child = null, force = false) {
    const { results } = await db.prepare('SELECT * FROM index_jobs WHERE parent_id=? AND userbot_label=? AND target=? AND community_id=? AND user_id=? ORDER BY created_at').bind(run.id, run.state.label, run.target, run.community_id || '', run.requester_user_id).all();
    const overall = { ...emptyCloneCounters(), copiedMessages: 0, duplicates: 0, failed: 0, retries: 0 };
    for (const job of results) {
      let counts = {};
      try { counts = JSON.parse(job.counters_json || '{}'); } catch { /* Old jobs expose scalar counters. */ }
      const fallback = { messages: job.processed, savedLinks: job.saved_links, savedFiles: job.saved_files, savedPdfs: job.saved_pdfs, duplicates: job.dupes_skipped, failed: job.errors, retries: job.retries };
      for (const key of new Set([...Object.keys(overall), ...Object.keys(counts), ...Object.keys(fallback)])) {
        const value = counts[key] ?? fallback[key] ?? 0;
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        overall[key] = (overall[key] || 0) + value;
      }
    }
    overall.errorCategories = {};
    for (const job of results) {
      let categories;
      try { categories = JSON.parse(job.counters_json || '{}').errorCategories; } catch { categories = null; }
      for (const [category, n] of Object.entries(categories || {})) overall.errorCategories[category] = (overall.errorCategories[category] || 0) + Number(n || 0);
    }
    let counts = {};
    try { counts = JSON.parse(child?.counters_json || '{}'); } catch { /* Scalar fallback below. */ }
    const topic = run.state.chosen?.[run.state.transition ? Math.max(0, (run.state.cursor || 0) - 1) : run.state.cursor || 0];
    const text = renderCloneProgress({ sourceName: run.state.sourceName, chatId: run.chat_id, destination: run.state.destinationName || run.target, target: run.target,
      status: terminal.has(run.state.stage) ? run.state.stage : run.state.transition || run.state.stage, topicsTotal: run.state.isForum ? run.state.chosen.length : 0, topicsDone: run.state.cursor || 0,
      currentTopic: run.state.isForum && topic ? { id: topic.id, name: topic.name } : null,
      processed: Number(child?.processed || 0), total: topic?.counters?.messages ?? run.state.total,
      counters: counts, overallCounters: { ...overall, total: run.state.total }, error: run.state.error,
    });
    await edit(run, token, text, terminal.has(run.state.stage) ? [[button(run, 'Back to topic statistics', 'topics'), button(run, 'Retry clone (new run)', 'retry')]] : [[button(run, 'Stop entire clone', 'stop'), button(run, 'Refresh', 'refresh')]], force);
  }
  async function sequence(id, token) {
    if (activeRuns.has(id)) return activeRuns.get(id);
    const operation = (async () => {
      let run = await load(id);
      if (!run || terminal.has(run.state.stage)) return;
      try {
        await account(run.state.label);
        for (;;) {
          run = await load(id);
          if (run.state.cancelled) {
            if (run.state.childId) await db.prepare("UPDATE index_jobs SET status='stopping', updated_at=? WHERE id=? AND status IN ('queued','running')").bind(clock(), run.state.childId).run();
            run.state.stage = 'stopped';
            await progress(run, token, null, true);
            return;
          }
          if (run.community_id && !await deps.authorizeCommunity({ id: run.requester_user_id }, run.community_id)) throw new Error('permission revoked');
          const topic = run.state.chosen[run.state.cursor || 0];
          if (!topic) {
            const failed = run.state.failedTopics || [];
            run.state.transition = null;
            if (failed.length) {
              const names = failed.slice(0, 4).map((f) => f.name || f.id).join(', ');
              run.state.stage = 'error';
              run.state.error = `${failed.length}/${run.state.chosen.length} topic(s) failed: ${names}${failed.length > 4 ? `, +${failed.length - 4} more` : ''}. Retry the clone to redo them — completed topics are skipped.`;
            } else run.state.stage = 'done';
            await progress(run, token, null, true);
            return;
          }
          const attempt = Number(run.state.cloneAttempt || 0);
          const jobId = run.state.childId || `ij_${run.id}_${attempt ? attempt + '_' : ''}${run.state.cursor || 0}`;
          run.state.childId = jobId;
          run.state.stage = 'running';
          run.state.transition = null;
          run.expires_at = clock() + 30 * 24 * 60 * 60 * 1000;
          await persist(run);
          if (run.state.cancelled) continue;
          let child = await db.prepare('SELECT * FROM index_jobs WHERE id=?').bind(jobId).first();
          if (!child) {
            const started = await deps.startJob({ jobId, parentId: run.id, token, chatId: run.state.progressChatId, forumThreadId: run.state.progressThreadId,
              athenaUser: { id: run.requester_user_id }, communityIdArg: run.community_id || '', chatIdArg: run.chat_id, threadArg: topic.id || '',
              communityName: run.state.destinationName, userbotLabel: run.state.label, target: run.target, silentProgress: true,
              knownTotal: topic.counters.messages, maxId: run.state.snapshot, progressMsgId: run.state.progressMessageId, topicName: topic.name,
            });
            if (!started?.ok && started?.jobId !== jobId) throw new Error('CHILD_START_FAILED');
          } else if (!terminal.has(child.status)) {
            if (child.status === 'stopping') { run.state.cancelled = true; await persist(run); continue; }
            background(deps.runJob(child, token));
          }
          for (;;) {
            child = await db.prepare('SELECT * FROM index_jobs WHERE id=?').bind(jobId).first();
            if (!child) throw new Error('CHILD_JOB_MISSING');
            const latest = await load(id);
            if (latest.state.cancelled && !terminal.has(child.status)) await db.prepare("UPDATE index_jobs SET status='stopping', updated_at=? WHERE id=? AND status IN ('queued','running')").bind(clock(), jobId).run();
            run.state.cancelled = latest.state.cancelled;
            await progress(run, token, child);
            if (terminal.has(child.status)) break;
            await sleep(2000);
          }
          if (run.state.cancelled || child.status === 'stopped') { run.state.stage = 'stopped'; await progress(run, token, child, true); return; }
          if (child.status !== 'done') {
            // One topic must not kill a multi-topic run. A topic that could not
            // finish (an association write failed, so its cursor never advanced)
            // is retried once from its own checkpoint; if it still fails the run
            // records it and moves on, ending in error with a summary instead of
            // abandoning every remaining topic.
            if (run.state.retriedChildId !== jobId) {
              run.state.retriedChildId = jobId;
              run.state.transition = `Topic failed, retrying: ${topic.name || 'source'}`;
              await persist(run);
              await db.prepare("UPDATE index_jobs SET status='queued', error=NULL, updated_at=? WHERE id=? AND status='error'").bind(clock(), jobId).run();
              await progress(run, token, child, true);
              await sleep(TOPIC_RETRY_PAUSE_MS);
              continue;
            }
            const reason = child.error || cloneFailure(new Error('CHILD_JOB_FAILED')).message;
            run.state.failedTopics = [...(run.state.failedTopics || []), { id: topic.id, name: topic.name || '', reason }];
            run.state.cursor = (run.state.cursor || 0) + 1;
            run.state.childId = null;
            run.state.retriedChildId = null;
            run.state.transition = `Topic failed: ${topic.name || 'source'}`;
            await progress(run, token, child, true);
            if (run.state.isForum) await sleep(8000);
            continue;
          }
          run.state.cursor = (run.state.cursor || 0) + 1;
          run.state.childId = null;
          run.state.retriedChildId = null;
          run.state.transition = `Topic completed: ${topic.name || 'source'}`;
          await progress(run, token, child, true);
          if (run.state.isForum) await sleep(8000);
        }
      } catch (error) {
        run = await load(id);
        if (run) { run.state.stage = 'error'; run.state.error = cloneFailure(error).message; await progress(run, token, null, true); }
      }
    })();
    activeRuns.set(id, operation);
    try { await operation; } finally { activeRuns.delete(id); }
  }
  async function command(context) {
    const [raw, source] = String(context.text || '').trim().split(/\s+/);
    const cmd = raw?.split('@')[0].toLowerCase();
    if (!['/uclone', '/ubclone', '/userbot_accounts', '/userbot_select'].includes(cmd)) return false;
    if (!context.isGod || !context.user) { await send(context, 'GOD rank and an Athena login are required.'); return true; }
    await deps.ensureTables();
    await ensureUcloneTables(env);
    if (cmd.startsWith('/userbot_')) {
      if (String(context.chatId).startsWith('-')) { await send(context, 'Manage saved accounts in a DM only.'); return true; }
      const run = await create(context, 'accounts', { stage: 'accounts' });
      await accounts(run, context.token);
      return true;
    }
    if (!/^-?\d+$/.test(source || '')) { await send(context, 'Usage: <code>/uclone &lt;channel_or_group_id&gt;</code>\nChoose a saved account with /userbot_accounts first.'); return true; }
    const selected = await db.prepare('SELECT label FROM userbot_selections WHERE requester_tg_id=?').bind(String(context.tgUserId)).first();
    if (!selected) { await send(context, 'No account selected. In a DM, open /userbot_accounts and select an account.'); return true; }
    const chat = /^\d{9,}$/.test(source) ? `-100${source}` : source;
    const run = await create(context, chat, { label: selected.label, stage: 'scanning', cursor: 0, cancelled: false });
    background(preview(run, context.token));
    return true;
  }
  async function callback(context) {
    if (!String(context.data).startsWith('uc:')) return false;
    await ensureUcloneTables(env);
    const [, id, revision, action, arg] = context.data.split(':');
    const run = await load(id);
    if (!run || !await authorized(run, context) || Number(revision) !== run.state.revision) {
      await deps.telegram(context.token, 'answerCallbackQuery', { callback_query_id: context.callbackId, text: 'This control expired, changed, or is not yours.', show_alert: true });
      return true;
    }
    await deps.telegram(context.token, 'answerCallbackQuery', { callback_query_id: context.callbackId });
    const index = /^\d+$/.test(arg || '') ? Number(arg) : -1;
    if (action === 'topics' && terminal.has(run.state.stage) && run.state.isForum) {
      await returnToTopics(run, context.token);
      return true;
    }
    if (action === 'retry' && terminal.has(run.state.stage)) {
      run.state.revision++;
      await persist(run);
      const next = await create(context, run.chat_id, { label: run.state.label, stage: 'scanning', cursor: 0, cancelled: false });
      background(preview(next, context.token));
      return true;
    }
    if (action === 'stop') {
      run.state.cancelled = true;
      if (run.state.childId) await db.prepare("UPDATE index_jobs SET status='stopping',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(clock(), run.state.childId).run();
      run.state.stage = 'stopped';
      run.state.revision++;
      await edit(run, context.token, '<b>Clone stopped</b>\nNo further topic will start.', [[button(run, 'Retry clone', 'retry')]], true);
    } else if (run.state.stage === 'accounts') {
      if (String(context.chatId).startsWith('-')) return true;
      if (action === 'accounts') { run.state.page = index; await accounts(run, context.token); return true; }
      if (action === 'add') {
        await edit(run, context.token, 'In this DM, add a named account:\n<code>/userbot_add &lt;label&gt; &lt;api_id&gt; &lt;api_hash&gt; &lt;session_string&gt;</code>\nThe credential message is deleted after processing. Never send credentials to a group.', [[button(run, 'Back', 'accounts', run.state.page)]], true);
        return true;
      }
      const label = run.state.accounts[index];
      if (!label) return true;
      if (action === 'select') {
        await account(label);
        await db.prepare('INSERT INTO userbot_selections (requester_tg_id,label,updated_at) VALUES (?,?,?) ON CONFLICT(requester_tg_id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at').bind(run.requester_tg_id, label, clock()).run();
        await accounts(run, context.token);
      } else if (action === 'remove') {
        run.state.revision++;
        await edit(run, context.token, `Remove account <code>${esc(label)}</code>? Active clones using it will stop.`, [[button(run, 'Confirm removal', 'removeok', index), button(run, 'Keep account', 'accounts', run.state.page)]], true);
      } else if (action === 'removeok') {
        await db.prepare("UPDATE index_jobs SET status='stopping',updated_at=? WHERE userbot_label=? AND status IN ('queued','running')").bind(clock(), label).run();
        await deps.stopAccount(label);
        await db.prepare('DELETE FROM userbot_selections WHERE label=?').bind(label).run();
        await accounts(run, context.token);
      } else if (action === 'reauth') {
        await edit(run, context.token, `In this DM, replace the credentials for the same label:\n<code>/userbot_add ${esc(label)} &lt;api_id&gt; &lt;api_hash&gt; &lt;session_string&gt;</code>\nNo different account will be selected automatically.`, [[button(run, 'Back', 'accounts', run.state.page)]], true);
      } else if (action === 'status') {
        let text;
        try {
          const client = await account(label);
          await deps.beforeRequest(label);
          const me = await client.getMe();
          const phone = String(me.phone || '');
          text = `<code>${esc(label)}</code> — verified\nUsername: ${me.username ? '@' + esc(me.username) : 'not set'}\nName: ${esc(me.firstName || '')} ${esc(me.lastName || '')}\nAccount ID: <code>${esc(me.id)}</code>\nPhone: ${phone ? '••••' + esc(phone.slice(-4)) : 'not shared'}\nSession: ********`;
          await db.prepare('UPDATE userbot_accounts SET telegram_id=?, telegram_username=?, display_name=?, phone_masked=?, verified_at=? WHERE label=?').bind(String(me.id), me.username || '', [me.firstName, me.lastName].filter(Boolean).join(' '), phone ? '••••' + phone.slice(-4) : '', clock(), label).run();
        } catch (error) { text = cloneFailure(error).message; }
        await edit(run, context.token, text, [[button(run, 'Back', 'accounts', run.state.page)]], true);
      }
    } else if (run.state.stage === 'topics') {
      if (action === 'page') { run.state.page = index; run.state.topicOffset = 0; await topicMenu(run, context.token); }
      else if (action === 'offset') { run.state.topicOffset = index; await topicMenu(run, context.token); }
      else if (action === 'stats' && run.state.topics[index]) {
        const topic = run.state.topics[index];
        await edit(run, context.token, renderCloneStatistics({ sourceName: run.state.sourceName, chatId: run.chat_id, username: run.state.username, members: run.state.members, topic, counters: topic.counters, complete: true, measurement: 'accessible-history' }), [[button(run, 'Choose this topic', 'topic', index), button(run, 'Back', 'page', run.state.page)]], true);
      } else if (action === 'all' || (action === 'topic' && run.state.topics[index])) {
        run.state.chosen = action === 'all' ? run.state.topics : [run.state.topics[index]];
        await destinations(run, context.token);
      }
    } else if (run.state.stage === 'destination') {
      if (action === 'topics') { await returnToTopics(run, context.token); return true; }
      if (action === 'destpage') { run.state.destinationPage = index; await destinations(run, context.token); return true; }
      if (action === 'personal') { run.target = 'personal'; run.community_id = ''; run.state.destinationName = 'Personal'; }
      else if (action === 'community' || action === 'both') {
        const community = run.state.communities[index];
        if (!community || !await deps.authorizeCommunity(context.user, community.id)) return true;
        run.target = action; run.community_id = community.id;
        run.state.destinationName = (community.name || community.id) + (action === 'both' ? ' + Personal' : ' (community DB)');
      } else return true;
      // Compare-and-swap prevents two repeated callbacks launching different destinations.
      const stored = await load(run.id);
      if (stored.state.stage !== 'destination' || stored.state.revision !== run.state.revision) return true;
      const previous = JSON.stringify(stored.state);
      const selectedTopic = run.state.isForum && run.state.chosen.length === 1 ? String(run.state.chosen[0].id || '') : '';
      await deps.ensureFollow?.({ chatId: run.chat_id, threadId: selectedTopic, label: run.state.label, communityId: run.community_id || '', target: run.target, createdBy: run.requester_user_id });
      run.state.stage = 'queued'; run.state.revision++;
      const result = await db.prepare('UPDATE pending_clones SET stats_json=?,target=?,community_id=? WHERE id=? AND stats_json=?').bind(JSON.stringify(run.state), run.target, run.community_id || null, run.id, previous).run();
      if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) return true;
      background(sequence(run.id, context.token));
    } else if (action === 'refresh') await progress(run, context.token, run.state.childId ? await db.prepare('SELECT * FROM index_jobs WHERE id=?').bind(run.state.childId).first() : null, true);
    return true;
  }
  async function resume(token) {
    await deps.ensureTables();
    await ensureUcloneTables(env);
    const { results } = await db.prepare('SELECT * FROM pending_clones ORDER BY created_at').all();
    for (const row of results) {
      const run = parseRow(row);
      if (!run || terminal.has(run.state.stage)) continue;
      if (run.state.stage === 'scanning') background(preview(run, token));
      else if (['queued', 'running'].includes(run.state.stage)) background(sequence(run.id, token));
    }
  }
  return { command, callback, resume, sequence };
}
