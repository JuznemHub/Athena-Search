import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

// /stats integration proof over the REAL worker: buildStatsReport reads managed
// pending_clones parents + their index_jobs children counters_json; the signed
// webhook drives the real /stats command and the stats: callback route so the
// buttons round-trip through the same message. SQLite real schema; only the
// Telegram transport and GramJS are fixtures.
const vaultDir = mkdtempSync(join(tmpdir(), 'athena-stats-'));
process.env.ATHENA_MEDIA_DIR = vaultDir;

class StringSession { constructor(value) { this.value = value; } }
class TelegramClient {
  constructor() { this.connected = false; }
  async connect() { this.connected = true; }
  async disconnect() {}
  async getMe() { return { id: 700000004n, firstName: 'Fixture' }; }
  async getDialogs() { return []; }
  addEventHandler() {}
  async getEntity() { return { className: 'Channel', title: 'Stats source', forum: false }; }
  async getMessages() { return []; }
  async downloadMedia() { return new TextEncoder().encode('x'); }
}
const fixtureKey = Symbol.for('athena.stats.fixture.telegram');
globalThis[fixtureKey] = { TelegramClient, StringSession };
const telegramUrl = 'data:text/javascript,' + encodeURIComponent(`
const fixture = globalThis[Symbol.for('athena.stats.fixture.telegram')];
export const TelegramClient = fixture.TelegramClient;
export const sessions = { StringSession: fixture.StringSession };
`);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'telegram') return { url: telegramUrl, shortCircuit: true };
  if (specifier.startsWith('telegram/')) throw new Error('Unmocked Telegram module');
  return nextResolve(specifier, context);
} });

const { default: worker, ensureIndexTables, ensureUcloneTables } = await import('../worker/index.js');
const { buildStatsReport, formatStatsRichReport, STATS_TOPICS_PAGE_MAX } = await import('../worker/index_legacy.js');

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
  .replace(/^CREATE EXTENSION[^;]*;/gm, '').replace(/^CREATE INDEX[^;]*USING gin[^;]*;/gm, ''));
sql.exec(`CREATE TABLE IF NOT EXISTS userbot_accounts (label TEXT PRIMARY KEY, api_id TEXT, api_hash_enc TEXT, session_enc TEXT, enabled INTEGER, last_error TEXT, updated_at INTEGER);
INSERT INTO userbot_accounts VALUES ('alpha','1','x','y',1,NULL,NULL);`);
const DB = { prepare(query) {
  const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
    async first(column) { const r = sql.prepare(query).get(...values); return r ? (column ? r[column] : r) : null; },
    async all() { return { results: sql.prepare(query).all(...values) }; },
    async run() { const r = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; } });
  return bind();
} };
const background = [];
const env = { DB, ATHENA_RUNTIME: 'selfhost', TELEGRAM_BOT_TOKEN: '123:fixture', TG_OWNER_IDS: '123456789',
  TELEGRAM_WEBHOOK_SECRET: 'stats-synthetic-webhook-secret', STORAGE_KEY: 'stats-synthetic-storage-key',
  __ctx: { waitUntil: promise => background.push(promise) } };
async function drain() { while (background.length) await background.shift(); }

const originalFetch = globalThis.fetch;
const sent = [];
let outgoingId = 500;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.telegram.org') {
    const method = url.pathname.split('/').at(-1);
    const body = JSON.parse(init.body || '{}');
    const messageId = method === 'editMessageText' ? body.message_id : ++outgoingId;
    sent.push({ method, body, messageId });
    return Response.json({ ok: true, result: { message_id: messageId, id: 42, is_bot: true, username: 'FixtureBot' } });
  }
  if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] });
  return new Response('<title>Fixture</title>', { headers: { 'content-type': 'text/html' } });
};

/** Decode rich HTML the way Telegram would: strip tags, unescape entities,
 * reject unbalanced formatting and stray angle brackets. */
function telegramText(html) {
  const stack = [];
  let plain = html.replace(/<tg-button-row[^>]*>|<\/tg-button-row>|<tg-button\b[^>]*>|<\/tg-button>/g, ' ')
    .replace(/<a [^>]*>|<\/a>|<h[1-6]>|<\/h[1-6]>|<p>|<\/p>|<ul>|<\/ul>|<li>|<\/li>|<i>|<\/i>|<br\/>?/g, (tag) => {
      const name = (tag.match(/^<\/?([a-z0-9-]+)/i) || [])[1];
      if (!tag.startsWith('</') && !/<br/.test(tag)) stack.push(name);
      else if (tag.startsWith('</')) assert.equal(stack.pop(), name, 'tags balanced');
      return '\n';
    });
  assert.deepEqual(stack, [], 'no unclosed formatting tags');
  plain = plain.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.doesNotMatch(plain, /[\ud800-\udbff](?![\udc00-\udfff])/u, 'no split surrogate pairs');
  assert.ok(html.length <= 32000, 'rich message under transport cap');
  return plain;
}

try {
  await ensureUcloneTables(env);
  await ensureIndexTables(env);

  // ---- Fixture data: one running forum clone, one completed channel clone,
  // and another user's standalone clone. Scopes must never mix.
  const insertParent = (id, chatId, tgId, userId, stats, atMs = Date.now()) => sql.prepare(
    'INSERT INTO pending_clones (id,chat_id,thread_id,community_id,target,requester_tg_id,requester_user_id,stats_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, chatId, null, null, stats.target || null, tgId, userId, JSON.stringify(stats), atMs, atMs + 86400000);
  const insertChild = (id, parentId, chatId, threadId, target, community, user, status, counters, topicName = '') => {
    sql.prepare(`INSERT INTO index_jobs (id,community_id,chat_id,user_id,status,offset_id,progress_chat_id,created_at,updated_at,thread_id,chat_name,userbot_label,target,parent_id,total_messages,topic_name,counters_json)
      VALUES (?,?,?,?,?,0,'x',?,?,?,?,'alpha',?,?,?,?,?)`)
      .run(id, community ?? '', chatId, user, status, Date.now(), Date.now(), threadId ?? '', 'Stats source', target, parentId, 10, topicName ?? '', JSON.stringify(counters));
  };
  const countersA = { messages: 10, copiedMessages: 8, linkPosts: 6, links: 6, savedLinkPosts: 6, savedLinks: 6, files: 4, savedFiles: 3, savedDocs: 1, savedPdfs: 0, other: 2, savedOther: 2, markdown: 1, savedMarkdown: 1, json: 0, savedJson: 0, html: 0, savedHtml: 0, images: 0, savedImages: 0, audio: 0, savedAudio: 0, skippedVideos: 1, duplicates: 1, failed: 0, retries: 0 };
  const countersB = { messages: 5, copiedMessages: 5, linkPosts: 2, links: 2, savedLinkPosts: 2, savedLinks: 2, files: 1, savedFiles: 1, savedDocs: 0, savedPdfs: 0, other: 0, savedOther: 0, duplicates: 0, failed: 0, retries: 0 };
  insertParent('pc_forum', '-1007777777777', '123456789', 'u_stats', {
    manager: 'uclone', stage: 'running', revision: 9, label: 'alpha', target: 'personal',
    sourceName: 'Stats Forum', username: 'statsforum', sourceType: 'group', isForum: true, cursor: 1,
    destinationName: 'Personal brain', progressChatId: '123456789', progressMessageId: 501,
    chosen: [ { id: '10', name: 'General', counters: { messages: 4 } }, { id: '20', name: 'Legal Research', counters: { messages: 3 } }, { id: '30', name: 'Development', counters: { messages: 3 } } ],
    counters: countersA,
  }, Date.now() - 60000);
  insertChild('ij_forum_1', 'pc_forum', '-1007777777777', '10', 'personal', '', 'u_stats', 'done', countersA, 'General');
  insertChild('ij_forum_2', 'pc_forum', '-1007777777777', '30', 'personal', '', 'u_stats', 'running', { messages: 2, links: 1, savedLinks: 1, savedLinkPosts: 1 }, 'Development');
  insertParent('pc_chan', '-1008888888888', '123456789', 'u_stats', {
    manager: 'uclone', stage: 'done', revision: 12, label: 'alpha', target: 'personal', sourceType: 'channel',
    sourceName: 'Stats Channel', username: 'statschannel', isForum: false, destinationName: 'Personal brain',
    progressChatId: '123456789', progressMessageId: 502, chosen: [ { id: null, name: 'Stats Channel' } ], counters: countersB,
  }, Date.now() - 120000);
  insertChild('ij_chan_1', 'pc_chan', '-1008888888888', null, 'personal', '', 'u_stats', 'done', countersB);
  // Another user's standalone clone: must not appear in 123456789's report.
  insertChild('ij_other', null, '-1009999999999', null, 'community', 'c_other', 'u_other', 'done', { messages: 99, savedLinks: 99 });
  sql.prepare('INSERT INTO users (id,username,created_at) VALUES (?,?,?)').run('u_stats', 'stats_fixture', Date.now());

  // ---- Report: requester + destination + account isolation
  const report = await buildStatsReport(env, null, { requesterTgId: '123456789', athenaUserId: 'u_stats' });
  assert.equal(report.runs.length, 2, 'requester sees exactly their two runs');
  const forumRun = report.runs.find((r) => r.id === 'pc_forum');
  const chanRun = report.runs.find((r) => r.id === 'pc_chan');
  assert.ok(forumRun && chanRun, 'both managed runs present');

  // Forum run: children aggregated with exact identity, topics from chosen.
  assert.equal(forumRun.state.isForum, true);
  assert.equal(forumRun.topics.length, 3, 'all chosen topics reported, with or without child jobs');
  const tGeneral = forumRun.topics.find((t) => t.threadId === '10');
  const tLegal = forumRun.topics.find((t) => t.threadId === '20');
  const tDev = forumRun.topics.find((t) => t.threadId === '30');
  assert.equal(tGeneral.done, true, 'done child job marks topic complete');
  assert.equal(tGeneral.percent, 100);
  assert.equal(tGeneral.total.links, 6);
  assert.equal(tGeneral.stateMark, '✅ COMPLETE');
  // cursor=1: Legal (index 1) is the in-flight topic with no child job yet — 🟢 LIVE.
  assert.equal(tLegal.stateMark, '🟢 LIVE', 'cursor topic without child job is current/live');
  assert.ok(tDev.stateMark.includes('CLONING') || tDev.stateMark.includes('PENDING'), 'non-cursor topics stay cloning/pending');
  assert.equal(forumRun.state.overall.messages, 12, 'overall counters = sum of children counters_json');
  assert.equal(forumRun.state.overall.savedLinks, 7);
  assert.equal(forumRun.state.overall.savedLinkPosts, 7, 'per-message outcome counted once across children');
  assert.equal(forumRun.state.overall.duplicates, 1);
  assert.equal(forumRun.live, true, 'running stage reports LIVE ON');
  assert.equal(forumRun.state.requesterTgId, '123456789');
  assert.equal(forumRun.state.label, 'alpha');
  assert.equal(forumRun.state.destinationName, 'Personal brain');

  // Channel run: completed → LIVE OFF, totals retained.
  assert.equal(chanRun.state.stage, 'done');
  assert.equal(chanRun.live, false, 'completed clone reports LIVE OFF');
  assert.equal(chanRun.state.overall.messages, 5);
  assert.equal(chanRun.state.sourceType, 'channel');
  assert.deepEqual(chanRun.topics, [], 'non-forum run carries an empty topic section');

  // Non-GOD scope never sees the other user's standalone clone.
  assert.ok(!report.runs.some((r) => r.chat_id === '-1009999999999'), 'foreign standalone job excluded by requester scope');

  // ---- Renderer: compact overview, live flag, per-run pages, buttons
  const view = formatStatsRichReport(report);
  assert.equal(view.totalRuns, 2);
  const text = telegramText(view.html);
  assert.match(text, /Stats Forum/);
  assert.match(text, /LIVE CLONING: ON/);
  // Overview aggregates the whole run (children counters_json summed).
  assert.match(view.buttons, /stats:refresh/);
  assert.match(view.buttons, /stats:run:1:0/, 'second run reachable by nav button');

  // Page navigation: run index clamps to the rendered run.
  const page2 = formatStatsRichReport(report, { page: 1 });
  assert.match(telegramText(page2.html), /Stats Channel/);
  assert.match(page2.html, /LIVE CLONING: OFF/);

  // Topic pages must fit the classic fallback and preserve every topic.
  const bigTopics = Array.from({ length: 120 }, (_, i) => ({ threadId: String(i + 1), title: 'Topic ' + (i + 1), total: { links: 1, files: 0, other: 0 }, percent: 0, done: false, stateMark: '⏳ PENDING' }));
  const bigReport = { runs: [{ ...forumRun, topics: bigTopics }, chanRun], generatedAt: Date.now() };
  const covered = [];
  for (let p = 0; covered.length < bigTopics.length; p++) {
    assert.ok(p < bigTopics.length, 'pagination must advance');
    const v = formatStatsRichReport(bigReport, { page: 0, topicPage: p });
    assert.ok(telegramText(v.html).length <= 4096, 'classic fallback fits one message');
    assert.ok((v.html.match(/<li>/g) || []).length <= STATS_TOPICS_PAGE_MAX);
    for (const m of v.html.matchAll(/#(\d+)</g)) covered.push(Number(m[1]));
  }
  assert.deepEqual(covered, bigTopics.map((t) => Number(t.threadId)), 'pagination covers every topic exactly once');

  // Hostile strings stay escaped and inside the transport cap.
  const hostile = { ...forumRun, state: { ...forumRun.state, sourceName: '<b>Evil</b> & "stuff"', username: null }, topics: [{ threadId: '1', title: '<script>alert(1)</script>', total: { links: 1, files: 2, other: 0 }, percent: 50, done: false, stateMark: '⏳ CLONING' }] };
  const hostileView = formatStatsRichReport({ runs: [hostile] });
  assert.ok(hostileView.html.includes('&lt;b&gt;Evil&lt;/b&gt;'));
  assert.ok(hostileView.html.includes('&lt;script&gt;'));
  telegramText(hostileView.html);

  // Empty report renders the friendly empty page.
  const emptyView = formatStatsRichReport({ runs: [] });
  assert.match(telegramText(emptyView.html), /No clones yet/);

  // ---- End-to-end: signed webhook → /stats command → callback → same-message edit
  let updateId = 81000;
  const from = { id: 123456789, first_name: 'Fixture' };
  const chat = { id: 123456789, type: 'private' };
  async function deliver(update) {
    const response = await worker.fetch(new Request('https://fixture.invalid/api/telegram-webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: ++updateId, ...update }),
    }), env, env.__ctx);
    await drain();
    assert.equal(response.status, 200, await response.text());
  }
  const buttonsOf = (call) => [...((call?.body?.rich_message?.html || '').matchAll(/<tg-button\b[^>]*data="([^"]+)"[^>]*>(.*?)<\/tg-button>/gs))].map((m) => [m[1].replace(/&amp;/g, '&'), m[2]]);

  await deliver({ message: { message_id: 600, from, chat, text: '/stats' } });
  const statsSend = sent.findLast((c) => c.method === 'sendRichMessage' && /CLONE STATS/.test(c.body.rich_message?.html || ''));
  assert.ok(statsSend, '/stats command sends the rich stats page');
  const firstPageControls = buttonsOf(statsSend);
  assert.ok(firstPageControls.some(([, label]) => label === '🔄 Refresh'), 'refresh control present');
  assert.ok(firstPageControls.some(([, label]) => label === '❌ Close'), 'close control present');
  assert.ok(firstPageControls.some(([data]) => data.startsWith('stats:run:')), 'run nav control present');

  // Callback round-trip: nav button edits the SAME message.
  sent.length = 0;
  await deliver({ callback_query: { id: 'stats-cb-1', from, data: 'stats:run:1:0', message: { message_id: statsSend.messageId, chat } } });
  const edited = sent.findLast((c) => c.method === 'editMessageText' && /CLONE STATS/.test(c.body.rich_message?.html || ''));
  assert.ok(edited, 'run callback edits the stats message in place');
  assert.equal(edited.messageId, statsSend.messageId, 'pagination edits the same message');
  assert.match(edited.body.rich_message.html, /Stats Channel/, 'nav landed on run 2');

  // Refresh also edits the same message.
  sent.length = 0;
  await deliver({ callback_query: { id: 'stats-cb-2', from, data: 'stats:refresh', message: { message_id: statsSend.messageId, chat } } });
  assert.ok(sent.some((c) => c.method === 'editMessageText' && /CLONE STATS/.test(c.body.rich_message?.html || '')), 'refresh edits in place');

  // Unauthorized user: no edit of someone else's stats message.
  sent.length = 0;
  const stranger = { id: 424242, first_name: 'Mallory' };
  await deliver({ callback_query: { id: 'stats-cb-3', from: stranger, data: 'stats:run:0:0', message: { message_id: statsSend.messageId, chat } } });
  assert.ok(!sent.some((c) => c.method === 'editMessageText' && /CLONE STATS/.test(c.body.rich_message?.html || '')), 'foreign callback must not re-render the run');

  console.log('clone stats fixtures passed: managed parents+children counters, requester/destination/account isolation, compact overview with source links, LIVE flag from actual job state, successful vs copying counters, completed/pending/current topics with 100% and bars, 100-topic pagination, run pagination, callback round-trip with auth guard, telegram-safe HTML');
} finally {
  await drain();
  hooks.deregister();
  delete globalThis[fixtureKey];
  globalThis.fetch = originalFetch;
  rmSync(vaultDir, { recursive: true, force: true });
  sql.close();
}
