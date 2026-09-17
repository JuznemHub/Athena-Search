import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createUcloneManager, ensureUcloneTables } from '../worker/uclone-manager.js';

// SQL is real; Telegram and the child worker are controlled dependency boundaries.
// These tests verify orchestration, not ingestion by runHistoryIndexJob.
async function fixture({ forum = false, sourceClass = 'Channel', topics = [7, 9], messages, topicPageSize = 100, orderByCreateDate = false, includeTopicCount = true } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE userbot_accounts (label TEXT PRIMARY KEY, enabled INTEGER, last_error TEXT);
    INSERT INTO userbot_accounts VALUES ('alpha',1,NULL),('beta',1,NULL);
    CREATE TABLE index_jobs (id TEXT PRIMARY KEY, parent_id TEXT, userbot_label TEXT, target TEXT, community_id TEXT, user_id TEXT, thread_id TEXT, status TEXT, processed INTEGER, total_messages INTEGER, counters_json TEXT, saved_links INTEGER, saved_files INTEGER, saved_pdfs INTEGER, dupes_skipped INTEGER, errors INTEGER, retries INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);`);
  const DB = { prepare(query) {
    const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
    }); return bind();
  } };
  const env = { DB };
  await ensureUcloneTables(env);
  const f = { sql, env, sent: [], tasks: [], starts: [], resumed: [], connections: [], clientLabels: [], requests: [], historyRequests: [], events: [],
    now: 1000000, messageId: 100, denied: new Set(), expired: false, polls: 0, finishAfter: 2, onPoll: null };
  const history = messages || [
    { id: 3, className: 'Message', message: 'https://three.example/', replyTo: { forumTopic: true, replyToTopId: 9, replyToMsgId: 9 } },
    { id: 2, className: 'Message', message: 'https://two.example/', replyTo: { forumTopic: true, replyToTopId: 7, replyToMsgId: 7 } },
    { id: 1, className: 'Message', message: 'https://one.example/', replyTo: { forumTopic: true, replyToTopId: 7, replyToMsgId: 7 } }
  ];
  const client = { connected: true,
    async getEntity() {
      if (f.expired) throw new Error('SESSION_REVOKED');
      return { className: sourceClass, title: forum ? 'Forum fixture' : 'Stream fixture', forum, participantsCount: 12 };
    },
    async invoke(request) {
      f.requests.push(request);
      const previous = topics.indexOf(Number(request.offsetTopic));
      assert.ok(!request.offsetTopic || previous >= 0, 'forum pagination must continue from a returned topic');
      if (request.offsetTopic) {
        const id = topics[previous];
        assert.deepEqual([request.offsetId, request.offsetDate], [id * 10, (orderByCreateDate ? 1700000000 : 1800000000) + id], 'Telegram cursor uses the date of the selected ordering');
      }
      const offset = request.offsetTopic ? previous + 1 : 0;
      const pageTopics = topics.slice(offset, offset + Math.min(request.limit, topicPageSize));
      return {
        ...(includeTopicCount ? { count: topics.length } : {}), orderByCreateDate,
        topics: pageTopics.map(id => ({ id, title: `Topic ${id}`, date: 1700000000 + id, topMessage: id * 10 })),
        messages: pageTopics.map(id => ({ id: id * 10, date: 1800000000 + id }))
      };
    },
    async getMessages(_chat, opts) {
      f.historyRequests.push(opts);
      return history.filter(m => (!opts.offsetId || m.id < opts.offsetId) && (!opts.replyTo || m.replyTo?.replyToTopId === Number(opts.replyTo))).slice(0, opts.limit);
    }
  };
  f.insertChild = (opts, status = 'running') => {
    sql.prepare('INSERT INTO index_jobs (id,parent_id,userbot_label,target,community_id,user_id,thread_id,status,processed,total_messages,counters_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(opts.jobId, opts.parentId, opts.userbotLabel, opts.target, opts.communityIdArg || '', opts.athenaUser.id, String(opts.threadArg || ''), status, 0, opts.knownTotal, '{}', f.now, f.now);
  };
  f.finish = (child, counters = { messages: child.total_messages, copiedMessages: child.total_messages, links: child.total_messages }) => {
    sql.prepare("UPDATE index_jobs SET status='done',processed=total_messages,counters_json=? WHERE id=?").run(JSON.stringify(counters), child.id);
    f.events.push(`done:${child.thread_id}`);
  };
  const deps = {
    now: () => f.now,
    sleep: async ms => {
      f.now += ms;
      const child = sql.prepare("SELECT * FROM index_jobs WHERE status IN ('running','queued','stopping') ORDER BY created_at LIMIT 1").get();
      if (!child) return;
      f.polls++;
      assert.ok(f.polls < 100, 'manager must terminate instead of polling forever');
      if (f.onPoll) await f.onPoll(child);
      else if (f.polls % f.finishAfter === 0) f.finish(child);
    },
    ensureTables: async () => {},
    startAccount: async label => { f.connections.push(label); return { ok: true }; },
    getClient: label => { f.clientLabels.push(label); return client; },
    beforeRequest: async () => {}, onFlood: async (_label, seconds) => { f.now += seconds * 1000; },
    listCommunities: async () => [{ id: 'c_a', name: 'Community A' }, { id: 'c_b', name: 'Community B' }],
    authorizeCommunity: async (user, id) => user.id === 'u_fixture' && !f.denied.has(id) && ['c_a', 'c_b'].includes(id),
    telegram: async (_token, method, body) => {
      f.sent.push({ method, body, at: f.now });
      return { ok: true, result: { message_id: method === 'sendMessage' ? f.messageId++ : body.message_id } };
    },
    background: task => f.tasks.push(task),
    startJob: async opts => {
      assert.equal(sql.prepare("SELECT count(*) n FROM index_jobs WHERE parent_id=? AND status IN ('running','queued','stopping')").get(opts.parentId).n, 0, 'next topic cannot start before the previous child is terminal');
      f.starts.push(opts); f.events.push(`start:${opts.threadArg}`);
      f.insertChild(opts);
      return { ok: true, jobId: opts.jobId };
    },
    runJob: async child => { f.resumed.push(child.id); sql.prepare("UPDATE index_jobs SET status='running' WHERE id=?").run(child.id); }
  };
  f.context = { tgUserId: '123456789', user: { id: 'u_fixture' }, chatId: '123456789', token: 'fixture', isGod: true };
  f.recreate = () => { f.manager = createUcloneManager(env, deps); };
  f.recreate();
  f.drain = async () => { while (f.tasks.length) await f.tasks.shift(); };
  f.run = () => { const row = sql.prepare('SELECT * FROM pending_clones ORDER BY rowid DESC LIMIT 1').get(); return row ? { ...row, state: JSON.parse(row.stats_json) } : null; };
  f.edits = () => f.sent.filter(s => s.method === 'editMessageText' && s.body.message_id === f.run()?.state.progressMessageId);
  f.buttons = () => f.edits().at(-1)?.body.reply_markup?.inline_keyboard.flat() || [];
  f.callback = async (data, overrides = {}) => f.manager.callback({ ...f.context, messageId: f.run().state.progressMessageId, callbackId: `cb${f.now++}`, data, ...overrides });
  f.click = async label => {
    const button = f.buttons().find(b => b.text.includes(label));
    assert.ok(button, `missing button ${label}`);
    await f.callback(button.callback_data);
    return button.callback_data;
  };
  f.select = async label => {
    await f.manager.command({ ...f.context, text: '/userbot_accounts' });
    await f.click(`Select: ${label}`);
  };
  f.preview = async () => { await f.manager.command({ ...f.context, text: '/uclone -1001234567890' }); await f.drain(); };
  f.children = () => sql.prepare('SELECT * FROM index_jobs WHERE parent_id=? ORDER BY created_at,rowid').all(f.run().id);
  return f;
}

const passed = [];
async function scenario(name, options, test) {
  const f = await fixture(options);
  try {
    await f.select('beta');
    await test(f);
    assert.ok(f.sent.filter(s => s.body.reply_markup).every(s => s.body.reply_markup.inline_keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64)), 'controls fit Telegram callback limits');
    passed.push(name);
  } finally { await f.drain(); f.sql.close(); }
}
function finalCounters(f) {
  const text = f.edits().at(-1).body.text;
  assert.match(text, /Status: done/);
  const table = [...text.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].at(-1)?.[1];
  assert.ok(table, 'final message contains aggregate counters');
  return Object.fromEntries(table.split('\n').map(row => { const match = row.match(/^(.*?)\s+(\d[\d,]*)$/); assert.ok(match); return [match[1], Number(match[2].replaceAll(',', ''))]; }));
}

await scenario('nonforum channel, persisted account, personal destination and stale controls', {}, async f => {
  f.recreate();
  await f.preview();
  assert.equal(f.run().state.stage, 'destination');
  assert.equal(f.run().state.counters.messages, 3);
  assert.equal(f.starts.length, 0, 'preview does not copy');
  assert.equal(f.requests.length, 0, 'nonforum history does not query forum topics');
  const control = f.buttons().find(b => b.text.includes('Personal')).callback_data;
  await f.callback(control, { tgUserId: '999' });
  assert.equal(f.starts.length, 0, 'another requester cannot start the clone');
  await f.callback(control); await f.drain();
  assert.deepEqual(f.children().map(j => [j.target, j.community_id, j.user_id, j.thread_id, j.processed]), [['personal', '', 'u_fixture', '', 3]]);
  await f.callback(control); await f.drain();
  assert.equal(f.starts.length, 1, 'stale destination callback cannot launch twice');
  assert.ok(f.connections.every(label => label === 'beta') && f.clientLabels.every(label => label === 'beta'), 'selected account survives restart without fallback');
  assert.equal(finalCounters(f).Messages, 3);
});

await scenario('ordinary group stays one stream in Community B', { sourceClass: 'Chat' }, async f => {
  await f.preview(); await f.click('Community B'); await f.drain();
  assert.deepEqual(f.children().map(j => [j.target, j.community_id, j.thread_id, j.processed]), [['community', 'c_b', '', 3]]);
  assert.equal(f.requests.length, 0);
});

await scenario('forum discovery crosses 100 topics through short pages and late topic is selectable', { forum: true, topicPageSize: 40, topics: Array.from({ length: 105 }, (_, i) => i + 2), messages: [
  { id: 1060, className: 'Message', message: 'https://late.example/', replyTo: { forumTopic: true, replyToTopId: 106, replyToMsgId: 106 } }
] }, async f => {
  await f.preview();
  assert.equal(f.run().state.stage, 'topics');
  assert.deepEqual(f.run().state.topics.map(t => Number(t.id)), Array.from({ length: 106 }, (_, i) => i + 1), 'all pages and General remain available');
  assert.equal(f.requests.length, 3, 'discovery continues short pages until all reported topics are collected');
  assert.deepEqual([f.requests[1].offsetTopic, f.requests[1].offsetId, f.requests[1].offsetDate], [41, 410, 1800000041]);
  while (f.buttons().some(b => b.text === 'Next page')) await f.click('Next page');
  while (!f.buttons().some(b => b.text.startsWith('106:'))) await f.click('More choices');
  await f.click('106:'); await f.click('Personal'); await f.drain();
  assert.deepEqual(f.children().map(j => [j.thread_id, j.processed]), [['106', 1]], 'late-page choice clones only that topic');
});

await scenario('creation-ordered topics continue until empty when total is unavailable', { forum: true, topicPageSize: 1, orderByCreateDate: true, includeTopicCount: false }, async f => {
  await f.preview();
  assert.equal(f.run().state.stage, 'topics');
  assert.deepEqual(f.run().state.topics.map(t => t.id), ['1', '7', '9']);
  assert.equal(f.requests.length, 3, 'an empty response, not a short page, ends discovery');
  assert.deepEqual([f.requests[1].offsetTopic, f.requests[1].offsetDate], [7, 1700000007]);
});

await scenario('forum children wait for completion and aggregate counters stay consistent', { forum: true }, async f => {
  await f.preview(); await f.click('All topics'); await f.click('Community A'); await f.drain();
  assert.deepEqual(f.events, ['start:1', 'done:1', 'start:7', 'done:7', 'start:9', 'done:9']);
  assert.deepEqual(f.children().map(j => [j.thread_id, j.processed]), [['1', 0], ['7', 2], ['9', 1]]);
  assert.equal(f.polls, 6, 'each running child was polled before completion');
  const counters = finalCounters(f);
  assert.deepEqual([counters.Messages, counters['Copied messages'], counters.Links], [3, 3, 3]);
  assert.match(f.edits().at(-1).body.text, /Topics completed: 3 \/ 3/);
});

await scenario('destination permission denial and revocation prevent copying', { forum: true, topics: [1, 7, 9] }, async f => {
  await f.preview(); await f.click('All topics');
  f.denied.add('c_b');
  await f.click('Community B'); await f.drain();
  assert.equal(f.run().state.stage, 'destination');
  assert.equal(f.children().length, 0, 'denied community does not receive a child');
  f.onPoll = async child => { f.finish(child); f.denied.add('c_a'); };
  await f.click('Community A'); await f.drain();
  assert.equal(f.run().state.stage, 'error');
  assert.equal(f.children().length, 1, 'revocation stops remaining topics');
  assert.equal(f.children()[0].community_id, 'c_a');
});

await scenario('restart resumes an existing child before starting the next topic', { forum: true }, async f => {
  await f.preview(); await f.click('All topics');
  const run = f.run();
  const childId = `ij_${run.id}_0`;
  // Persist the exact boundary a process can leave after allocating its first child.
  Object.assign(run.state, { stage: 'running', childId, cursor: 0, destinationName: 'Personal brain' });
  f.sql.prepare("UPDATE pending_clones SET stats_json=?,target='personal',community_id=NULL WHERE id=?").run(JSON.stringify(run.state), run.id);
  f.insertChild({ jobId: childId, parentId: run.id, userbotLabel: 'beta', target: 'personal', athenaUser: { id: 'u_fixture' }, threadArg: '1', knownTotal: 0 }, 'queued');
  f.recreate(); await f.manager.resume('fixture'); await f.drain();
  assert.deepEqual(f.resumed, [childId]);
  assert.deepEqual(f.events, ['done:1', 'start:7', 'done:7', 'start:9', 'done:9']);
  assert.equal(f.children().length, 3, 'restart reuses the interrupted child rather than duplicating it');
  assert.equal(finalCounters(f).Messages, 3);
  const before = f.starts.length;
  await f.manager.resume('fixture'); await f.drain();
  assert.equal(f.starts.length, before, 'completed parent is not replayed');
});

await scenario('cancel while running stops current child and never starts another', { forum: true }, async f => {
  await f.preview(); await f.click('All topics');
  f.now += 8001;
  f.onPoll = async child => {
    await f.click('Stop entire clone');
    assert.equal(f.sql.prepare('SELECT status FROM index_jobs WHERE id=?').get(child.id).status, 'stopping');
    f.sql.prepare("UPDATE index_jobs SET status='stopped' WHERE id=?").run(child.id);
  };
  await f.click('Personal'); await f.drain();
  assert.equal(f.run().state.stage, 'stopped');
  assert.equal(f.children().length, 1);
  f.recreate(); await f.manager.resume('fixture'); await f.drain();
  assert.equal(f.children().length, 1, 'cancelled parent never resumes');
  assert.match(f.edits().at(-1).body.text, /Status: stopped/);
});

await scenario('expired selected session reports reauthentication without substitution', {}, async f => {
  f.expired = true;
  await f.preview();
  assert.equal(f.run().state.stage, 'error');
  assert.match(f.edits().at(-1).body.text, /reauthentication/i);
  assert.equal(f.children().length, 0);
  assert.ok(f.connections.every(label => label === 'beta') && f.clientLabels.every(label => label === 'beta'));
});

await scenario('progress is throttled but final counters are exact and scope-isolated', {}, async f => {
  await f.preview();
  f.finishAfter = 12;
  f.now += 8001;
  f.onPoll = async child => {
    f.sql.prepare('UPDATE index_jobs SET processed=? WHERE id=?').run(Math.min(f.polls, 3), child.id);
    if (f.polls !== 12) return;
    f.finish(child, { messages: 3, copiedMessages: 2, links: 4, files: 2, pdfs: 1, markdown: 1, duplicates: 1, failed: 1, retries: 2 });
    for (const [index, change] of [{ userbotLabel: 'alpha' }, { target: 'community' }, { communityIdArg: 'c_b' }, { athenaUser: { id: 'other' } }].entries()) {
      f.insertChild({ ...f.starts[0], jobId: `foreign_${index}`, ...change }, 'done');
      f.sql.prepare("UPDATE index_jobs SET processed=999,counters_json='{" + '"messages":999,"links":999' + "}' WHERE id=?").run(`foreign_${index}`);
    }
  };
  await f.click('Personal'); await f.drain();
  const running = f.edits().filter(s => /Status: running/.test(s.body.text));
  assert.ok(running.length >= 2 && running.length < f.polls, 'long job has live updates without an edit on every poll');
  for (let i = 1; i < running.length; i++) assert.ok(running[i].at - running[i - 1].at >= 8000, 'automatic edits are throttled');
  assert.equal(new Set(f.edits().map(s => s.body.message_id)).size, 1, 'progress edits one message');
  const counters = finalCounters(f);
  assert.deepEqual([counters.Messages, counters['Copied messages'], counters.Links, counters.Files, counters.PDF, counters.MD, counters.Duplicates, counters.Failed, counters.Retries], [3, 2, 4, 2, 1, 1, 1, 1, 2]);
  assert.deepEqual(f.edits().at(-1).body.reply_markup.inline_keyboard, [], 'final summary removes live controls');
});

await scenario('combined destination selects Community B and personal without another community', {}, async f => {
  await f.preview();
  const row = f.edits().at(-1).body.reply_markup.inline_keyboard.find(buttons => buttons.some(b => b.text === 'Community B'));
  const both = row.find(b => b.text === 'Also personal');
  assert.ok(both, 'each community exposes its own combined destination');
  await f.callback(both.callback_data); await f.drain();
  assert.deepEqual(f.children().map(j => [j.target, j.community_id, j.user_id, j.processed]), [['both', 'c_b', 'u_fixture', 3]]);
  assert.equal(finalCounters(f).Messages, 3, 'combined destination does not double-count source messages');
});

await scenario('combined destination enforces authorization before copying and between topics', { forum: true }, async f => {
  await f.preview(); await f.click('All topics');
  const row = f.edits().at(-1).body.reply_markup.inline_keyboard.find(buttons => buttons.some(b => b.text === 'Community A'));
  const both = row.find(b => b.text === 'Also personal');
  f.denied.add('c_a');
  await f.callback(both.callback_data); await f.drain();
  assert.equal(f.run().state.stage, 'destination');
  assert.equal(f.children().length, 0, 'denied combined destination does not launch even its personal side');
  f.denied.delete('c_a');
  f.onPoll = async child => { f.finish(child); f.denied.add('c_a'); };
  await f.callback(both.callback_data); await f.drain();
  assert.equal(f.run().state.stage, 'error');
  assert.deepEqual(f.children().map(j => [j.target, j.community_id]), [['both', 'c_a']], 'revocation prevents subsequent combined-destination topics');
});

console.log(`clone manager workflow tests passed (${passed.length} cases):\n${passed.join('\n')}`);
