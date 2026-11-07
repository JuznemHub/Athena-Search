import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createUcloneManager, ensureUcloneTables } from '../worker/uclone-manager.js';

// Cancellable scans: a Cancel-scan click during accessible-history preview must
// stop discovery/scanning before any destination is chosen or child job starts.
const sql = new DatabaseSync(':memory:');
sql.exec(`CREATE TABLE userbot_accounts (label TEXT PRIMARY KEY, enabled INTEGER, last_error TEXT, telegram_id TEXT, telegram_username TEXT, display_name TEXT, phone_masked TEXT, verified_at INTEGER);
  INSERT INTO userbot_accounts VALUES ('beta',1,NULL,'102','beta_fixture','Beta','••••1002',1);
  CREATE TABLE index_jobs (id TEXT PRIMARY KEY, parent_id TEXT, userbot_label TEXT, target TEXT, community_id TEXT, user_id TEXT, thread_id TEXT, status TEXT, processed INTEGER, total_messages INTEGER, counters_json TEXT, saved_links INTEGER, saved_files INTEGER, saved_pdfs INTEGER, dupes_skipped INTEGER, errors INTEGER, retries INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
`);
const DB = { prepare(query) {
  const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
    async first() { return sql.prepare(query).get(...values) || null; },
    async all() { return { results: sql.prepare(query).all(...values) }; },
    async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
  }); return bind();
} };
const env = { DB };
await ensureUcloneTables(env);
const f = { sent: [], tasks: [], starts: [], now: 1000000, messageId: 100, polls: 0, beforeRequestCount: 0 };
const client = {
  async getEntity() { return { className: 'Channel', broadcast: true, title: 'Cancel fixture', forum: true, participantsCount: 4 }; },
  async invoke() {
    return { count: 60, topics: Array.from({ length: 40 }, (_, i) => ({ id: i + 2, title: `Topic ${i + 2}`, date: 1700000000 + i, topMessage: (i + 2) * 10 })),
      messages: Array.from({ length: 40 }, (_, i) => ({ id: (i + 2) * 10, date: 1800000000 + i })) };
  },
  async getMessages() { return []; }
};
const deps = {
  classicText: t => t,
  now: () => f.now,
  sleep: async ms => { f.now += ms; f.polls++; },
  ensureTables: async () => {},
  startAccount: async () => ({ ok: true }),
  getClient: () => client,
  beforeRequest: async () => {
    // The Telegram client pauses between requests; the click lands inside that pause.
    if (f.beforeRequestCount++ > 0 && !run().state.cancelled) {
      const cancel = buttons().find(b => b.text === 'Cancel scan');
      assert.ok(cancel, 'scanning card exposes a Cancel-scan control');
      await manager.callback({ tgUserId: '9', user: { id: 'u_cancel' }, chatId: '9', token: 'fixture', isGod: true, messageId: run().state.progressMessageId, callbackId: `cb${f.now++}`, data: cancel.callback_data });
    }
  },
  onFlood: async () => {},
  listCommunities: async () => [{ id: 'c_a', name: 'Community A' }],
  authorizeCommunity: async () => true,
  telegram: async (_token, method, body) => { f.sent.push({ method, body }); return { ok: true, result: { message_id: ['sendMessage', 'sendRichMessage'].includes(method) ? f.messageId++ : body.message_id } }; },
  background: task => f.tasks.push(task),
  startJob: async opts => { f.starts.push(opts); return { ok: true, jobId: opts.jobId }; },
  runJob: async () => {}
};
const manager = createUcloneManager(env, deps);
const run = () => { const row = sql.prepare('SELECT * FROM pending_clones ORDER BY rowid DESC LIMIT 1').get(); return row ? { ...row, state: JSON.parse(row.stats_json) } : null; };
const buttons = () => {
  const body = f.sent.filter(s => s.method === 'editMessageText').at(-1)?.body;
  return [...(body?.rich_message?.html || '').matchAll(/<tg-button type="callback_data" data="([^"]+)">([^<]+)<\/tg-button>/g)].map(m => ({ callback_data: m[1], text: m[2] }));
};
await manager.command({ tgUserId: '9', user: { id: 'u_cancel' }, chatId: '9', token: 'fixture', isGod: true, text: '/userbot_accounts' });
const select = buttons().find(b => b.text === 'Select: beta');
await manager.callback({ tgUserId: '9', user: { id: 'u_cancel' }, chatId: '9', token: 'fixture', isGod: true, messageId: run().state.progressMessageId, callbackId: 'cb1', data: select.callback_data });
await manager.command({ tgUserId: '9', user: { id: 'u_cancel' }, chatId: '9', token: 'fixture', isGod: true, text: '/uclone -1001234567890' });

while (f.tasks.length) await f.tasks.shift();
assert.equal(run().state.stage, 'stopped', 'cancelled scan stops the preview');
assert.equal(f.starts.length, 0, 'cancelled scan never copies');
assert.ok(f.sent.filter(s => /Cancel scan/.test(s.body.rich_message?.html || '')).length, 'scan progress shows the cancel control');
sql.close();
console.log('scan cancellation fixture passed');
