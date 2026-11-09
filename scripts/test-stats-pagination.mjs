import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const {
  buildStatsReport,
  formatStatsRichReport,
  statsExtractThreadKey,
  statsRecentLinks,
  STATS_DASH_PAGE_SIZE,
  hideSourceFromStats,
  ensureUcloneTables,
  ensureCloneSources,
  ensureIndexTables,
} = await import('../worker/index.js');

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
  .replace(/^CREATE EXTENSION[^;]*;/gm, '').replace(/^CREATE INDEX[^;]*USING gin[^;]*;/gm, ''));

sql.exec(`CREATE TABLE IF NOT EXISTS userbot_accounts (
  label TEXT PRIMARY KEY, api_id TEXT, api_hash_enc TEXT, session_enc TEXT, enabled INTEGER, last_error TEXT, updated_at INTEGER
);`);
sql.exec(`CREATE TABLE IF NOT EXISTS userbot_follows (
  chat_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'main',
  community_id TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT 'community',
  created_by TEXT, created_at BIGINT NOT NULL,
  PRIMARY KEY (chat_id, community_id)
);`);

const DB = {
  prepare(query) {
    const bind = (values = []) => ({
      bind(...args) { return bind(args.map(v => v ?? null)); },
      async first(column) {
        const r = sql.prepare(query).get(...values);
        return r ? (column ? r[column] : r) : null;
      },
      async all() {
        return { results: sql.prepare(query).all(...values) };
      },
      async run() {
        const r = sql.prepare(query).run(...values);
        return { success: true, meta: { changes: Number(r.changes) } };
      }
    });
    return bind();
  }
};

const env = { DB, ATHENA_RUNTIME: 'selfhost', TELEGRAM_BOT_TOKEN: '123:fixture', TG_OWNER_IDS: '123456789' };

await ensureUcloneTables(env);
await ensureIndexTables(env);
await ensureCloneSources(env);

// 1. Test statsExtractThreadKey helper
{
  assert.equal(statsExtractThreadKey(null), '');
  assert.equal(statsExtractThreadKey({ thread_id: '554738' }), '554738');
  assert.equal(statsExtractThreadKey({ state: { prescribedThread: '634673' } }), '634673');
  assert.equal(statsExtractThreadKey({ state: { isForum: true, chosen: [{ id: '869708' }] } }), '869708');
  assert.equal(statsExtractThreadKey({ topics: [{ threadId: '100' }] }), '100');
  assert.equal(statsExtractThreadKey({ topics: [{ threadId: '100' }, { threadId: '200' }] }), '');
}

// 2. Test multi-topic clone isolation in buildStatsReport
{
  const now = Date.now();
  const insertParent = (id, chatId, threadId, tgId, userId, stats, atMs) => {
    sql.prepare('INSERT INTO pending_clones (id,chat_id,thread_id,community_id,target,requester_tg_id,requester_user_id,stats_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, chatId, threadId, 'comm_1', 'community', tgId, userId, JSON.stringify(stats), atMs, atMs + 86400000);
  };
  const insertChild = (id, parentId, chatId, threadId, status, counters, topicName = '') => {
    sql.prepare(`INSERT INTO index_jobs (id,community_id,chat_id,user_id,status,offset_id,progress_chat_id,created_at,updated_at,thread_id,chat_name,userbot_label,target,parent_id,total_messages,topic_name,counters_json)
      VALUES (?,?,?,?,?,0,'x',?,?,?,?,'alpha','community',?,?,?,?)`)
      .run(id, 'comm_1', chatId, 'user_1', status, now, now, threadId ?? '', 'PIRATEZPARTY', parentId, 10, topicName, JSON.stringify(counters));
  };

  // Group has 2 cloned topics + 1 whole chat clone
  insertParent('p_topic1', '-1001574965898', '554738', '123', 'user_1', {
    manager: 'uclone', stage: 'done', label: 'alpha', sourceName: 'PIRATEZPARTY[Link Submission]', isForum: true,
    chosen: [{ id: '554738', name: 'Link Submission', counters: { messages: 10 } }]
  }, now - 3000);
  insertChild('j_topic1', 'p_topic1', '-1001574965898', '554738', 'done', { savedLinks: 5, savedLinkPosts: 5, savedFiles: 1 }, 'Link Submission');

  insertParent('p_topic2', '-1001574965898', '634673', '123', 'user_1', {
    manager: 'uclone', stage: 'done', label: 'alpha', sourceName: 'PIRATEZPARTY[0X1 [Archive]]', isForum: true,
    chosen: [{ id: '634673', name: '0X1 [Archive]', counters: { messages: 20 } }]
  }, now - 2000);
  insertChild('j_topic2', 'p_topic2', '-1001574965898', '634673', 'done', { savedLinks: 12, savedLinkPosts: 10, savedFiles: 3 }, '0X1 [Archive]');

  insertParent('p_whole', '-1001574965898', null, '123', 'user_1', {
    manager: 'uclone', stage: 'done', label: 'alpha', sourceName: 'PIRATEZPARTY', isForum: false
  }, now - 1000);
  insertChild('j_whole', 'p_whole', '-1001574965898', null, 'done', { savedLinks: 50, savedLinkPosts: 40, savedFiles: 10 });

  // Add 4 other independent chats so total sources = 7
  for (let i = 1; i <= 4; i++) {
    const cid = `-100200000000${i}`;
    insertParent(`p_chat_${i}`, cid, null, '123', 'user_1', {
      manager: 'uclone', stage: 'done', label: 'alpha', sourceName: `Channel ${i}`, sourceType: 'channel'
    }, now - 500);
    insertChild(`j_chat_${i}`, `p_chat_${i}`, cid, null, 'done', { savedLinks: i * 2, savedLinkPosts: i * 2, savedFiles: i });
  }

  const report = await buildStatsReport(env, null, { requesterTgId: '123', athenaUserId: 'user_1' });
  assert.equal(report.sources.length, 7, 'all 7 sources preserved without collapsing or limiting to 4');

  const names = report.sources.map(s => s.name);
  assert.ok(names.some(n => /0X1/.test(n)), 'topic 634673 is present');
  assert.ok(names.some(n => /Link Submission/.test(n)), 'topic 554738 is present');
  assert.ok(names.includes('PIRATEZPARTY'), 'whole chat clone is present alongside the topic clones');

  // 3. Test Dashboard Pagination (STATS_DASH_PAGE_SIZE = 5)
  assert.equal(STATS_DASH_PAGE_SIZE, 5);

  // Page 1 (dashPage 0)
  const viewPage1 = formatStatsRichReport(report, { dashPage: 0 });
  assert.equal(viewPage1.pages, 2, '2 total pages for 7 items');
  assert.equal(viewPage1.page, 0, 'page 0 active');
  assert.match(viewPage1.html, /Page 1\/2/);
  assert.match(viewPage1.buttons, /stats:dash:1/, 'Next button points to page 1');
  assert.match(viewPage1.buttons, /stats:src:0:0:0/, 'First button points to global index 0 and dashPage 0');
  assert.match(viewPage1.buttons, /stats:src:4:0:0/, 'Fifth button points to global index 4 and dashPage 0');
  assert.doesNotMatch(viewPage1.buttons, /stats:src:5:0:0/, 'Sixth item is NOT on page 1');

  // Page 2 (dashPage 1)
  const viewPage2 = formatStatsRichReport(report, { dashPage: 1 });
  assert.equal(viewPage2.page, 1, 'page 1 active');
  assert.match(viewPage2.html, /Page 2\/2/);
  assert.match(viewPage2.buttons, /stats:dash:0/, 'Prev button points to page 0');
  assert.match(viewPage2.buttons, /stats:src:5:0:1/, 'Sixth button points to global index 5 and dashPage 1');
  assert.match(viewPage2.buttons, /stats:src:6:0:1/, 'Seventh button points to global index 6 and dashPage 1');

  // 4. Test drill-down return preserves dashPage
  const drillView = formatStatsRichReport(report, { src: 5, topicPage: 0, dashPage: 1 });
  assert.match(drillView.buttons, /stats:dash:1/, 'All sources back button returns to dashPage 1');

  // 5. Test hideSourceFromStats isolates by thread
  const topic1Source = report.sources.find(s => s.thread_id === '554738');
  assert.ok(topic1Source, 'topic1 source found');
  await hideSourceFromStats(env, topic1Source);

  const reportAfterHide = await buildStatsReport(env, null, { requesterTgId: '123', athenaUserId: 'user_1' });
  assert.equal(reportAfterHide.sources.length, 6, 'only the deleted topic source was removed');
  assert.ok(!reportAfterHide.sources.some(s => s.thread_id === '554738'), 'topic 554738 hidden');
  assert.ok(reportAfterHide.sources.some(s => s.thread_id === '634673'), 'topic 634673 still present');
  assert.ok(reportAfterHide.sources.some(s => s.name === 'PIRATEZPARTY'), 'whole chat PIRATEZPARTY still present');

  // 6. Test statsRecentLinks isolation: each source displays only its own links
  sql.prepare("INSERT OR IGNORE INTO users (id, username, provider, provider_id, created_at) VALUES ('tester', 'tester', 'system', '1', ?)").run(now);
  sql.prepare("INSERT OR IGNORE INTO communities (id, name, creator_id, created_at) VALUES ('comm_1', 'Test Comm', 'tester', ?)").run(now);

  sql.prepare(`INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, created_at, source_chat_id, source_message_id, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'l_1', 'comm_1', 'https://topic554738.example/link', 'h1', 'Topic 554738 Link', 'notes', '[]', now - 10000, '-1001574965898:554738', '101', 'tester'
  );
  sql.prepare(`INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, created_at, source_chat_id, source_message_id, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'l_2', 'comm_1', 'https://channel1.example/link', 'h2', 'Channel 1 Link', 'notes', '[]', now - 10000, '-1002000000001', '201', 'tester'
  );

  const recentTopic1 = await statsRecentLinks(env, 'community', 'comm_1', '-1001574965898', 5, '554738');
  assert.equal(recentTopic1.length, 1, 'topic 554738 has 1 recent link');
  assert.equal(recentTopic1[0].url, 'https://topic554738.example/link');

  const recentChannel1 = await statsRecentLinks(env, 'community', 'comm_1', '-1002000000001', 5);
  assert.equal(recentChannel1.length, 1, 'channel 1 has 1 recent link');
  assert.equal(recentChannel1[0].url, 'https://channel1.example/link');

  const recentChannel2 = await statsRecentLinks(env, 'community', 'comm_1', '-1002000000002', 5);
  assert.equal(recentChannel2.length, 0, 'channel 2 has no links and does not leak other channels links');
}

console.log('stats pagination and multi-topic isolation tests passed.');
