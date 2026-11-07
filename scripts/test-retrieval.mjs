import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

import {
  buildSearchBlob,
  cleanApiBase,
  compactAiContext,
  dedupeLinkRows,
  detectBackupCommunityId,
  followLiveness,
  formatBackfillDone,
  formatBackfillProgress,
  generateUrlHash,
  handleSearchLinks,
  hydrateMeiliRows,
  hydrateSourcePosts,
  importBackupSql,
  loadLinkNamePattern,
  notesForUrl,
  progressBar,
  repairContaminatedNotes,
  fuzzyMatchLinks,
  formatStatsRichReport,
  helpTextForSection,
  hideSourceFromStats,
  restartLiveMode,
  dedupeEligibleCommunities,
  stopLiveCapture,
  pickVerifyTarget,
  linkGroupToCommunity,
  isGroundedAiAnswer,
  normalizeModelId,
  parseAiDescribeResponse,
  parseTelegramEditPayload,
  rankLinks,
  resolveChatEndpoint,
  resultLimitClause,
  searchAllLinks,
  smartFallbackTags,
  parseStoredTags,
  normalizeTagList,
  telegramEntityMarkdown,
  telegramRichMarkdown,
  telegramRichNotesForSave,
  telegramSearchRowHtml
} from '../worker/index.js';

assert.equal(resultLimitClause(null), '');
assert.equal(resultLimitClause(20), ' LIMIT 20');
assert.equal(normalizeModelId('Big Pickle', 'https://opencode.ai/zen/v1'), 'big-pickle');
assert.equal(normalizeModelId('DeepSeek V4 Flash', 'https://opencode.ai/zen/v1'), 'deepseek-v4-flash');
assert.equal(normalizeModelId('opencode/big-pickle', 'https://opencode.ai/zen/v1'), 'big-pickle');
assert.equal(normalizeModelId('openai/gpt-4o-mini', 'https://openrouter.ai/api/v1'), 'openai/gpt-4o-mini');
assert.equal(cleanApiBase('https://opencode.ai/zen/v1/chat/completions'), 'https://opencode.ai/zen/v1');
assert.equal(cleanApiBase('https://openrouter.ai/api/v1/models'), 'https://openrouter.ai/api/v1');
assert.equal(resolveChatEndpoint('https://opencode.ai/zen/v1', 'openai', 'big-pickle'), 'https://opencode.ai/zen/v1/chat/completions');
assert.equal(resolveChatEndpoint('https://opencode.ai/zen/v1', 'openai', 'gpt-5.6-sol'), 'https://opencode.ai/zen/v1/responses');
assert.equal(resolveChatEndpoint('https://opencode.ai/zen/go/v1', 'openai', 'minimax-m3'), 'https://opencode.ai/zen/go/v1/messages');
assert.equal(resolveChatEndpoint('https://api.openai.com/v1', 'openai', 'gpt-4o-mini'), 'https://api.openai.com/v1/chat/completions');
assert.equal(resolveChatEndpoint('https://api.anthropic.com', 'anthropic', 'claude-sonnet-4-20250514'), 'https://api.anthropic.com/v1/messages');
assert.match(helpTextForSection('personal'), /<code>\/search<\/code>\s*<code>&lt;query&gt;<\/code>/);
assert.match(helpTextForSection('community'), /<code>\/clear_db &lt;id&gt;<\/code>/);
// Docs hygiene: same-purpose commands share one entry instead of two cryptic ones.
assert.match(helpTextForSection('personal'), /dumpsmart[\s\S]*?dumpall on/);
assert.match(helpTextForSection('community'), /<p><b>9\.[\s\S]*?\/kick[\s\S]*?<\/p>/);
assert.doesNotMatch(helpTextForSection('community'), /<code>\/clear<\/code>/, 'removed /clear dupe stays out of help');
assert.doesNotMatch(helpTextForSection('channels'), /<code>\/follow<\/code>|<code>\/backfill<\/code>/, 'removed legacy spellings stay out of help');
assert.doesNotMatch(helpTextForSection('god', true), /<code>\/restore<\/code>/, 'removed /restore dupe stays out of help');
assert.match(helpTextForSection('channels'), /<p><b>8\.[\s\S]*?\/status[\s\S]*?<\/p>/);
assert.match(helpTextForSection('channels'), /<code>\/clone<\/code>\s*<code>&lt;chat_id&gt; &lt;community_id&gt;<\/code>/);
assert.match(helpTextForSection('channels'), /<code>\/clone<\/code>\s*<code>&lt;chat_id&gt; &lt;topic_id&gt; &lt;community_id&gt;<\/code>/);
assert.match(helpTextForSection('channels'), /<code>\/clone<\/code>\s*<code>&lt;channel_id&gt; &lt;community_id&gt;<\/code>/);
assert.match(helpTextForSection('channels'), /<code>\/uclone<\/code>\s*<code>&lt;chat_id&gt; &lt;community_id&gt;<\/code>/);
assert.doesNotMatch(helpTextForSection('channels'), /<code>\/clone<\/code>\s*<code>&lt;community_id&gt;<\/code>/, 'removed /clone <community_id> dupe stays out of help');
assert.doesNotMatch(helpTextForSection('channels'), /<code>\/clone<\/code>\s*<code>&lt;topic_id&gt;/, 'removed /clone <topic_id> dupe stays out of help');
assert.doesNotMatch(helpTextForSection('channels'), /<code>\/clone<\/code>\s*<code>\[topic_id\]/, 'removed /clone [topic_id] dupe stays out of help');
assert.doesNotMatch(helpTextForSection('channels'), /<b>\d+\. <code>\/clone<\/code><\/b>/, 'bare /clone stays out of help');
assert.doesNotMatch(helpTextForSection('god', true), /<code>\/clone<\/code>/, 'channel clone form lives in 📡 Channels, not GOD');
assert.doesNotMatch(helpTextForSection('channels'), /<code>\/index_start<\/code>|<code>\/index_status<\/code>|<code>\/index_stop<\/code>|<code>\/clone_stop<\/code>|<code>\/channel_link<\/code>|<code>\/channel_unlink<\/code>|<code>\/clone_del<\/code>|<code>\/userbot_follow<\/code>/, 'removed commands stay out of the channels panel');
assert.match(helpTextForSection('god', true), /forcetags[\s\S]*?retag review/);
assert.doesNotMatch(helpTextForSection('god', true), /tag_untagged|taguntagged|tag_missing/, 'removed /tag_untagged stays out of help');
// /stats: forum groups show Group[topic], and the drill-down page offers Remove live.
{
  const fakeReport = { sources: [{ chat_id: '-100123', name: 'MyGroup', type: 'forum', isForum: true, live: true, target: 'community', community: 'c1', owner: 'c1', destinationName: 'Test community', overall: {}, fresh: {}, recent: [], topics: [{ threadId: '2', title: 'General', total: { links: 1, files: 0, other: 0 }, percent: 100, done: true, stateMark: '✅ COMPLETE' }], auth: { tgIds: [], userIds: [] } }] };
  const dash = formatStatsRichReport(fakeReport);
  assert.match(dash.html, /MyGroup\[General\]/, 'dashboard row shows Group[topic]');
  const drill = formatStatsRichReport(fakeReport, { src: 0, topicPage: 0 });
  assert.match(drill.html, /MyGroup\[General\]/, 'drill-down heading shows Group[topic]');
  assert.match(drill.buttons, /stats:del:0:0/, 'drill-down page has a delete-from-stats button');
  assert.match(dash.buttons, /stats:stop:0/, 'live row keeps the ⏹ beside button');
  const idleDash = formatStatsRichReport({ sources: [{ ...fakeReport.sources[0], live: false }] });
  assert.match(idleDash.buttons, /stats:start:0/, 'idle row shows the ▶️ restart button');
  assert.doesNotMatch(idleDash.buttons, /stats:stop/, 'idle row has no stop button');
}
// pickVerifyTarget: no arg + one owned -> link it; multi -> ask; explicit id -> link; new/empty -> create.
assert.deepEqual(pickVerifyTarget([{ id: 'c1' }], ''), { action: 'link', id: 'c1' });
assert.deepEqual(pickVerifyTarget([{ id: 'c1' }, { id: 'c2' }], '').action, 'ask');
assert.deepEqual(pickVerifyTarget([{ id: 'c1' }, { id: 'c2' }], 'c2'), { action: 'link', id: 'c2' });
assert.deepEqual(pickVerifyTarget([{ id: 'c1' }], 'new'), { action: 'create' });
assert.deepEqual(pickVerifyTarget([], ''), { action: 'create' });
// linkGroupToCommunity: repairs the binding in place, never duplicates.
{
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE community_bots (id TEXT PRIMARY KEY, community_id TEXT, platform TEXT, bot_username TEXT, group_id TEXT, group_name TEXT, created_by TEXT, created_at BIGINT, scope TEXT, user_id TEXT, bot_token TEXT);`);
  const DB = { prepare(query) {
    const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
    }); return bind();
  } };
  const env = { DB };
  const b1 = await linkGroupToCommunity(env, { chatId: '-1009', chatTitle: 'G', communityId: 'c1', ownerId: 'u1', personal: null });
  assert.ok(b1?.id);
  const b2 = await linkGroupToCommunity(env, { chatId: '-1009', chatTitle: 'G', communityId: 'c1', ownerId: 'u1', personal: null });
  assert.equal(b2.id, b1.id, 'relink updates the same row');
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM community_bots`).get().n, 1);
}
// stopLiveCapture: stops follows + bot-mode live but keeps the binding row
// (group link, topic lock, token) — deleting it unlinked the group and
// forced duplicate communities on re-verify.
{
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE community_bots (id TEXT PRIMARY KEY, platform TEXT, group_id TEXT, community_id TEXT, channel_target TEXT, copy_text INTEGER, topic_id TEXT, scope TEXT);
  CREATE TABLE userbot_follows (chat_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'main', community_id TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT 'community', created_by TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (chat_id, community_id));`);
  const DB = { prepare(query) {
    const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
    }); return bind();
  } };
  const env = { DB };
  sql.prepare(`INSERT INTO community_bots VALUES ('b1','telegram','-1001','c1','community',1,'7','community')`).run();
  sql.prepare(`INSERT INTO userbot_follows (chat_id, label, community_id, target, created_at) VALUES ('-1001','alpha','c1','community',1)`).run();
  sql.prepare(`INSERT INTO userbot_follows (chat_id, label, community_id, target, created_at) VALUES ('-1002','alpha','c1','community',1)`).run();
  const out = await stopLiveCapture(env, '-1001', 'c1');
  assert.deepEqual(out, { chatId: '-1001', followsRemoved: 1, linksRemoved: 1 });
  const kept = sql.prepare(`SELECT * FROM community_bots WHERE id = 'b1'`).get();
  assert.ok(kept, 'binding row survives the stop');
  assert.equal(kept.channel_target, null);
  assert.equal(kept.copy_text, 0);
  assert.equal(kept.topic_id, '7', 'topic lock survives the stop');
  assert.equal(kept.community_id, 'c1', 'group link survives the stop');
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM userbot_follows`).get().n, 1);
}
// dedupeEligibleCommunities: same-named rows show once — most links wins, tie oldest.
{
  const rows = [
    { id: 'c_new', name: 'PIRATEZPARTY', links: 0, created_at: 200 },
    { id: 'c_old', name: 'PIRATEZPARTY', links: 16703, created_at: 100 },
    { id: 'c_other', name: 'Other', links: 5, created_at: 150 },
  ];
  const out = dedupeEligibleCommunities(rows);
  assert.equal(out.map((c) => c.id).join(','), 'c_old,c_other');
  const tied = dedupeEligibleCommunities([
    { id: 'n2', name: 'X', links: 0, created_at: 200 },
    { id: 'n1', name: 'x ', links: 0, created_at: 100 },
  ]);
  assert.equal(tied.map((c) => c.id).join(','), 'n1');
  assert.equal(dedupeEligibleCommunities([]).length, 0);
}
// restartLiveMode: userbot required, bot optional (userbot mode fallback).
assert.deepEqual(restartLiveMode({ userbotSeen: false, botStatus: 'member' }), { ok: false, reason: 'userbot' });
assert.deepEqual(restartLiveMode({ userbotSeen: true, botStatus: 'member' }), { ok: true, userbotMode: false });
assert.deepEqual(restartLiveMode({ userbotSeen: true, botStatus: 'administrator' }), { ok: true, userbotMode: false });
assert.deepEqual(restartLiveMode({ userbotSeen: true, botStatus: 'left' }), { ok: true, userbotMode: true });
assert.deepEqual(restartLiveMode({ userbotSeen: true, botStatus: '' }), { ok: true, userbotMode: true });
// hideSourceFromStats: display-only delete removes run records, keeps imports.
{
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE pending_clones (id TEXT PRIMARY KEY, chat_id TEXT, thread_id TEXT, community_id TEXT, target TEXT, requester_tg_id TEXT, requester_user_id TEXT, stats_json TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE index_jobs (id TEXT PRIMARY KEY, community_id TEXT, chat_id TEXT, user_id TEXT, status TEXT, parent_id TEXT, target TEXT, thread_id TEXT, userbot_label TEXT);
    CREATE TABLE telegram_index_sessions (id TEXT PRIMARY KEY, user_id TEXT, community_id TEXT, chat_id TEXT);
    CREATE TABLE clone_job_items (job_id TEXT, message_id TEXT, counters_json TEXT);`);
  const DB = { prepare(query) {
    const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
    }); return bind();
  } };
  const env = { DB };
  sql.prepare(`INSERT INTO pending_clones (id, chat_id, community_id, target, requester_user_id) VALUES ('p1','-1001','c1','community','u1'),('p2','-1002','c1','community','u1'),('p3','-1001','','personal','u9')`).run();
  sql.prepare(`INSERT INTO index_jobs (id, community_id, chat_id, user_id, status, target, parent_id) VALUES ('j1','c1','-1001','u1','done','community','p1'),('j2','c1','-1001:7','u1','done','community','p1'),('j3','c1','-1002','u1','done','community',NULL),('j4','','-1001','u9','done','personal',NULL)`).run();
  sql.prepare(`INSERT INTO telegram_index_sessions (id, user_id, community_id, chat_id) VALUES ('j1','u1','c1','-1001'),('j3','u1','c1','-1002')`).run();
  sql.prepare(`INSERT INTO clone_job_items (job_id, message_id) VALUES ('j1','m1'),('j3','m3')`).run();
  const out = await hideSourceFromStats(env, { chat_id: '-1001', target: 'community', owner: 'c1' });
  assert.deepEqual(out, { parents: 1, jobs: 2, sessions: 1, items: 1 });
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM pending_clones`).get().n, 2);
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM index_jobs`).get().n, 2);
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM telegram_index_sessions`).get().n, 1);
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM clone_job_items`).get().n, 1);
  assert.equal(sql.prepare(`SELECT id FROM pending_clones ORDER BY id`).all().map((r) => r.id).join(','), 'p2,p3');
  assert.equal(sql.prepare(`SELECT id FROM index_jobs ORDER BY id`).all().map((r) => r.id).join(','), 'j3,j4');
}
// ids path: exact run ids from the report — precise for target-less error
// shells that group under a normalized destination.
{
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE pending_clones (id TEXT PRIMARY KEY, chat_id TEXT, thread_id TEXT, community_id TEXT, target TEXT, requester_tg_id TEXT, requester_user_id TEXT, stats_json TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE index_jobs (id TEXT PRIMARY KEY, community_id TEXT, chat_id TEXT, user_id TEXT, status TEXT, parent_id TEXT, target TEXT, thread_id TEXT, userbot_label TEXT);
    CREATE TABLE telegram_index_sessions (id TEXT PRIMARY KEY, user_id TEXT, community_id TEXT, chat_id TEXT);
    CREATE TABLE clone_job_items (job_id TEXT, message_id TEXT, counters_json TEXT);`);
  const DB = { prepare(query) {
    const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
    }); return bind();
  } };
  const env = { DB };
  sql.prepare(`INSERT INTO pending_clones (id, chat_id, community_id, target, requester_user_id) VALUES ('e1','869708',NULL,NULL,'telegram_u1'),('e2','869708',NULL,NULL,'telegram_u1'),('k1','-1001','c1','community','telegram_u1')`).run();
  sql.prepare(`INSERT INTO index_jobs (id, community_id, chat_id, user_id, status, target, parent_id) VALUES ('j9','c1','-1001','u1','done','community','k1')`).run();
  const out = await hideSourceFromStats(env, { chat_id: '869708', target: 'community', owner: '', ids: { parents: ['e1', 'e2'], jobs: [] } });
  assert.deepEqual(out, { parents: 2, jobs: 0, sessions: 0, items: 0 });
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM pending_clones`).get().n, 1);
  assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM index_jobs`).get().n, 1);
}
// Sibling sweep: the report's newest-wins dedupe hides older same-key
// parents from ids — the sweep still removes them, and only them.
{
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE pending_clones (id TEXT PRIMARY KEY, chat_id TEXT, thread_id TEXT, community_id TEXT, target TEXT, requester_tg_id TEXT, requester_user_id TEXT, stats_json TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE index_jobs (id TEXT PRIMARY KEY, community_id TEXT, chat_id TEXT, user_id TEXT, status TEXT, parent_id TEXT, target TEXT, thread_id TEXT, userbot_label TEXT);
    CREATE TABLE telegram_index_sessions (id TEXT PRIMARY KEY, user_id TEXT, community_id TEXT, chat_id TEXT);
    CREATE TABLE clone_job_items (job_id TEXT, message_id TEXT, counters_json TEXT);`);
  const DB = { prepare(query) {
    const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: Number(r.changes) } }; }
    }); return bind();
  } };
  const env = { DB };
  sql.prepare(`INSERT INTO pending_clones (id, chat_id, community_id, target, requester_user_id) VALUES ('n1','869708',NULL,NULL,'telegram_u1'),('n2','869708',NULL,NULL,'telegram_u2'),('n3','-1001','c1','community','telegram_u1')`).run();
  // Only the newest parent survived the dedupe into ids — the sweep gets the rest.
  const out = await hideSourceFromStats(env, { chat_id: '869708', target: 'community', owner: '', ids: { parents: ['n1'], jobs: [] } });
  assert.deepEqual(out, { parents: 2, jobs: 0, sessions: 0, items: 0 });
  assert.equal(sql.prepare(`SELECT id FROM pending_clones ORDER BY id`).all().map((r) => r.id).join(','), 'n3');
}

const replyEdit = parseTelegramEditPayload('| title: Correct title | notes: Correct notes', {
  text: 'Saved link https://example.com/item'
});
assert.deepEqual(replyEdit, {
  queryPart: 'https://example.com/item',
  newTitle: 'Correct title',
  newNotes: 'Correct notes'
});
const shorthandEdit = parseTelegramEditPayload('https://example.com/item | notes only');
assert.deepEqual(shorthandEdit, {
  queryPart: 'https://example.com/item',
  newTitle: null,
  newNotes: 'notes only'
});

assert.deepEqual(parseAiDescribeResponse('```json\n{"title":"English title","description":"Context summary","tags":["#tools","AI tools"]}\n```'), {
  title: 'English title',
  description: 'Context summary',
  tags: ['tools', 'ai-tools']
});

const document = {
  filename: 'README.md',
  content: 'Use yt-dlp to download a video from the archive.',
};
assert.match(buildSearchBlob(document), /ytdlp/);
assert.match(buildSearchBlob(document), /download/);

const rankedMovieRows = rankLinks([
  { id: 'law', title: 'Public International Law (John H Currie) (Z-Library).pdf', filename: 'law.pdf', content: 'Public international law reference.' },
  { id: 'movie', title: 'Movies4u.VIP - Bollywood and Hollywood Movies Download', url: 'https://movies4u.example/', notes: 'Movie website.' },
], 'list some movie websites');
assert.equal(rankedMovieRows.some(row => row.id === 'law'), false);
assert.equal(rankedMovieRows[0].id, 'movie');
assert.equal(dedupeLinkRows([
  { id: 'doc-1', type: 'document', title: 'First', url: null },
  { id: 'doc-2', type: 'document', title: 'Second', url: null },
]).length, 2);
assert.ok(compactAiContext(['x'.repeat(900), 'y'.repeat(900)], 1000).length <= 1000);
assert.equal(isGroundedAiAnswer('Saved item [#1] https://movies4u.example/', [
  { url: 'https://movies4u.example/' }
]), true);
assert.equal(isGroundedAiAnswer('General answer https://other.example/', [
  { url: 'https://movies4u.example/' }
]), false);

const rows = Array.from({ length: 20 }, (_, i) => ({
  id: `doc-${i}`,
  title: `Document ${i}`,
  filename: `notes-${i}.md`,
  content: 'The provider context contains yt-dlp retrieval notes.',
}));
assert.equal(fuzzyMatchLinks(rows, 'ytdlp').length, rows.length);

const searchWindow = { __athenaSteroid: true };
vm.runInNewContext(
  fs.readFileSync(new URL('../public/src/lib/search.js', import.meta.url), 'utf8'),
  { window: searchWindow }
);
const retrieved = searchWindow.AthenaSearch.retrieveForQuestion('ytdlp', rows);
assert.equal(retrieved.length, rows.length);
searchWindow.__athenaSteroid = false;
const hermesRetrieved = searchWindow.AthenaSearch.retrieveForQuestion('ytdlp', rows, 8);
assert.equal(hermesRetrieved.length, 8);

const movieRows = [
  { id: 'law', title: 'Public International Law (John H Currie) (Z-Library).pdf', filename: 'law.pdf', content: 'Public international law reference.' },
  { id: 'filmygod', title: 'FilmyGod - The Original FilmyGod.UK Website', url: 'https://filmygod.buzz/', notes: 'Movies and web series website.' },
  { id: 'mkv', title: 'mkvCinemas Movies of Bollywood Hollywood and TV Shows', url: 'https://mkvcinemas.nexus/', notes: 'Movies website.' },
];
const movieRetrieved = searchWindow.AthenaSearch.retrieveForQuestion('list some movie websites', movieRows, 8, { minScore: 18, strict: true });
assert.ok(movieRetrieved.some(row => row.id === 'filmygod'));
assert.ok(movieRetrieved.some(row => row.id === 'mkv'));
assert.equal(movieRetrieved.some(row => row.id === 'law'), false);
const hugeDocument = {
  id: 'huge-law',
  title: 'Public International Law reference.pdf',
  filename: 'law.pdf',
  content: 'public international law '.repeat(100000),
};
const hugeRetrieved = searchWindow.AthenaSearch.retrieveForQuestion(
  'list some movie websites', [hugeDocument, ...movieRows], 8, { minScore: 18, strict: true }
);
assert.equal(hugeRetrieved.some(row => row.id === 'huge-law'), false);

const aiWindow = {
  AthenaSearch: searchWindow.AthenaSearch,
  localStorage: { getItem: () => null, setItem: () => {} },
  __athenaSteroid: true
};
vm.runInNewContext(
  fs.readFileSync(new URL('../public/src/lib/ai.js', import.meta.url), 'utf8'),
  { window: aiWindow, localStorage: aiWindow.localStorage }
);
const local = aiWindow.AthenaAI.answerLocal('ytdlp', rows);
assert.equal(local.sources.length, 8);
assert.equal(local.results.length, rows.length);
aiWindow.__athenaSteroid = false;
const hermesLocal = aiWindow.AthenaAI.answerLocal('ytdlp', rows);
assert.equal(hermesLocal.sources.length, 8);
assert.equal(hermesLocal.results.length, 8);
const movieLocal = aiWindow.AthenaAI.answerLocal('list some movie websites', movieRows);
assert.match(movieLocal.answer, /FilmyGod/);
assert.doesNotMatch(movieLocal.answer, /Public International Law/);
assert.equal(
  aiWindow.AthenaAI.formatAiFallbackMessage({ details: { status: 502 } }),
  'AI provider is temporarily unavailable; showing relevant saved matches.'
);
assert.equal(aiWindow.AthenaAI.isGroundedAiAnswer(
  'Saved movie site [#1] https://filmygod.buzz/',
  [{ url: 'https://filmygod.buzz/' }]
), true);
assert.equal(aiWindow.AthenaAI.isGroundedAiAnswer(
  'Here is a general answer: https://untrusted.example/',
  [{ url: 'https://filmygod.buzz/' }]
), false);

// detectBackupCommunityId: backup dumps carry the source community per links row.
const mockEnvWith = (existingIds) => ({
  DB: {
    prepare: () => ({
      bind: (id) => ({
        first: async () => (existingIds.includes(id) ? { id } : null),
      }),
    }),
  },
});
const linkInsert = (cid, url) =>
  `INSERT INTO "links" ("community_id","id","url","url_hash") VALUES ('${cid}','x_${url}','https://${url}','h_${url}');`;
const backupSingle = [
  linkInsert('c_aaa', 'a.com'),
  linkInsert('c_aaa', 'b.com'),
  `INSERT INTO "personal_links" ("user_id","id","url") VALUES ('u1','p1','https://c.com');`,
].join('\n');
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_aaa']), backupSingle), 'c_aaa');
// Two distinct communities -> ambiguous -> ''.
const backupMulti = [linkInsert('c_aaa', 'a.com'), linkInsert('c_bbb', 'b.com')].join('\n');
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_aaa', 'c_bbb']), backupMulti), '');
// Single community unknown locally -> ''.
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_zzz']), backupSingle), '');
// No links rows at all -> ''.
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_aaa']), `INSERT INTO "users" ("id") VALUES ('u1');`), '');

// importBackupSql stamps search_blob at import time so rows are findable
// without waiting for the lazy backfill (regression: bulk imports were
// invisible to /search, e.g. a trailing-slash URL query missing its row).
{
  const inserts = [];
  const fakeDb = {
    prepare: (sql) => ({
      bind: (...args) => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => { inserts.push({ sql, args }); return {}; },
      }),
    }),
  };
  const dump = `INSERT INTO "links" ("community_id","id","url","url_hash","title","notes","tags") VALUES ('c_old','l1','https://enhancv.com/','h1','Enhancv resume builder','make a resume','["jobs"]');`;
  const rep = await importBackupSql({ DB: fakeDb }, dump, { targetCommunityId: 'c_new', targetUserId: 'u_new' });
  assert.equal(rep.linksInserted, 1);
  const linkInsert = inserts.find(i => /INSERT INTO links/.test(i.sql));
  assert.ok(linkInsert, 'links INSERT captured');
  const blobIdx = linkInsert.sql.indexOf('"search_blob"') >= 0
    ? linkInsert.sql.split(',').findIndex(c => c.includes('search_blob'))
    : -1;
  assert.ok(blobIdx >= 0, 'search_blob column present');
  // Values vector layout: (scope,target,id,url,hash,...cols) — find blob by column order.
  const colNames = linkInsert.sql.slice(linkInsert.sql.indexOf('(') + 1, linkInsert.sql.indexOf(')')).split(',').map(c => c.replace(/"/g, '').trim());
  const blob = linkInsert.args[colNames.indexOf('search_blob')];
  assert.ok(String(blob).includes('httpsenhancvcom'), `blob matches stripped URL form, got: ${blob}`);
  assert.ok(!String(blob).includes('://'), 'blob is normalized (no URL punctuation)');
}

// notesForUrl: one message, many links -> each link keeps only its section.
// Regression: backfill stamped the whole listicle message as every link's
// notes (enhancv.com and beautiful.ai shared identical "ChatGPT
// alternatives…" notes).
{
  const listMsg = [
    'ChatGPT alternatives, the best AI tools list:',
    'For writing:',
    'Chatsonic - https://chatsonic.com the conversational writer',
    'For design:',
    'Enhancv resume builder - https://enhancv.com/ make a standout resume',
    'Beautiful presentations - https://www.beautiful.ai/ slides in minutes',
  ].join('\n');
  const urls = ['https://chatsonic.com', 'https://enhancv.com/', 'https://www.beautiful.ai/'];
  // Single URL keeps the full text (legacy behavior).
  assert.equal(notesForUrl(listMsg, 'https://enhancv.com/', 1), listMsg);
  // Multi URL: enhancv keeps its own line, not the whole list.
  const enh = notesForUrl(listMsg, 'https://enhancv.com/', urls.length);
  assert.ok(enh.includes('enhancv'), `enhancv section kept, got: ${enh}`);
  assert.ok(!enh.includes('chatsonic.com'), 'other link section cut (before)');
  assert.ok(!enh.includes('beautiful.ai'), 'other link section cut (after)');
  assert.ok(!enh.includes('ChatGPT alternatives'), 'list header cut');
  const beau = notesForUrl(listMsg, 'https://www.beautiful.ai/', urls.length);
  assert.ok(beau.includes('Beautiful presentations'), `beautiful section kept, got: ${beau}`);
  assert.ok(!beau.includes('enhancv'), 'neighbour section cut');
  // Bare URL with no descriptive text -> '' (scraper fills it instead).
  assert.equal(notesForUrl('https://a.com https://b.com', 'https://a.com', 2), '');
  // Unknown URL -> ''.
  assert.equal(notesForUrl(listMsg, 'https://missing.example/', 3), '');
}

// repairContaminatedNotes: URL-stripped listicles (cleanNotesText removes
// every URL, leaving "Name -" dangling lines) shrink to the row's own
// section. Real shape pasted from the website detail page.
{
  const strippedList = [
    'ChatGPT alternatives',
    'For writing',
    'Chatsonic** - **',
    'ChatABC -',
    'JasperAI -',
    'Quillbot -',
    'For coding',
    'CodeWhisperer -',
    'Copilot -',
    'For research',
    'Paperpal -',
    'Perplexity -',
    'YouChat -',
    'For design',
    'Beautiful presentations -',
    'Slides in minutes -',
  ].join('\n');
  const fixed = repairContaminatedNotes(strippedList, 'https://www.beautiful.ai', 'beautiful.ai');
  assert.ok(fixed.includes('Beautiful presentations'), `own section kept, got: ${fixed}`);
  assert.ok(!fixed.includes('ChatGPT alternatives'), 'list header cut');
  assert.ok(!fixed.includes('Chatsonic'), 'foreign section cut');
  assert.ok(fixed.length < strippedList.length, 'notes actually shrunk');
  // No self-mention anywhere -> cleared (pure foreign text).
  assert.equal(repairContaminatedNotes(strippedList, 'https://unknown.example/', 'Unknown tool'), '');
  // Legit prose untouched (no dangling-dash fingerprint).
  const prose = 'A thoughtful review of this resume builder. It handles modern templates well and exports clean PDFs for hiring managers.';
  assert.equal(repairContaminatedNotes(prose, 'https://www.beautiful.ai', 'beautiful.ai'), prose);
  // Short notes untouched.
  assert.equal(repairContaminatedNotes('nice tool', 'https://www.beautiful.ai', 'beautiful.ai'), 'nice tool');
}

// repairContaminatedNotes v3: enumerated listicles with no URLs and no
// dangling dashes ("1. Gigapixel AI - …"). Long notes naming 3+ OTHER saved
// links keep lines naming this row; foreign-only lines drop.
{
  const fakeEnv = {
    DB: {
      prepare: (sql) => {
        const rows = /personal_links/.test(sql) ? [] : [
          { url: 'https://www.hitpaw.com/photo-enhancer.html' },
          { url: 'https://gigapixel.ai/upscale' },
          { url: 'https://upscale.media/tools' },
          { url: 'https://youcam.com/enhance' },
        ];
        return {
          all: async () => ({ results: rows }),
          bind: () => ({
            all: async () => ({ results: rows }),
          }),
        };
      },
    },
  };
  const nameRe = await loadLinkNamePattern(fakeEnv);
  assert.ok(nameRe, 'name pattern builds');
  const enumNotes = [
    'Top AI image scalers ranked this week after testing every option twice daily:',
    '1. Gigapixel AI - Upscales photos up to 600 percent without quality loss, works with vectors and compressed images, face enhancement included free',
    '2. Upscale.media - Supports PNG JPG and WEBP formats everywhere, removes JPEG artifacts completely, generates high resolution images up to four times daily',
    '3. YouCam Enhance - One click restoration for old family portraits with automatic retouching and background cleanup tools for everyone using it',
    '4. HitPaw photo enhancer - Simple enhancement for portraits and landscapes with automatic retouching modes for beginners learning every single day',
  ].join('\n');
  const fixed = repairContaminatedNotes(enumNotes, 'https://www.hitpaw.com/photo-enhancer.html', 'hitpaw.com/photo-enhancer.html', nameRe);
  assert.ok(fixed.includes('HitPaw'), `own section kept, got: ${fixed}`);
  assert.ok(!fixed.includes('Gigapixel'), 'foreign section dropped');
  assert.ok(!fixed.includes('Upscale'), 'foreign section dropped');
  assert.ok(fixed.length < enumNotes.length, 'notes actually shrunk');
  // Only 2 foreign names -> untouched (legit comparisons name a couple tools).
  const pairNotes = 'A long comparison of two upscalers after weeks of testing every photo twice daily. Gigapixel AI gives sharper faces overall, while Upscale.media is faster for batch jobs and cheaper monthly plans for everyone involved here today! ' + 'x'.repeat(120);
  assert.equal(repairContaminatedNotes(pairNotes, 'https://www.hitpaw.com/photo-enhancer.html', 'hitpaw', nameRe), pairNotes);
  // Short notes never trigger, however many names.
  assert.equal(repairContaminatedNotes('Gigapixel Upscale YouCam HitPaw tools', 'https://www.hitpaw.com/x', 'hitpaw', nameRe), 'Gigapixel Upscale YouCam HitPaw tools');
}

// Clone progress/completion/liveness formatters (pure — safe to unit test).
{
  const b1 = progressBar(50, 100);
  assert.equal(b1.pct, 50);
  const b2 = progressBar(150, 100);
  assert.equal(b2.pct, 100, 'done>total clamps instead of overflowing');

  const prog = formatBackfillProgress({ name: 'Pirate Movies', chatId: '-100123', threadId: '', done: 500, total: 1000, links: 120, dupes: 2159, docs: 30, pdfs: 7, files: 4, urls: 200, skipped: 11 });
  assert.ok(prog.includes('Pirate Movies'), 'chat name shown');
  assert.ok(prog.includes('-100123'), 'chat id shown');
  assert.ok(prog.includes('7 pdfs'), 'pdf counter shown');
  assert.ok(prog.includes('2159 dupes'), 'dupe counter shown');
  assert.ok(prog.includes('50%'), 'percent shown');
  const progBare = formatBackfillProgress({ chatId: '-100123', done: 5, total: 0 });
  assert.ok(progBare.includes('-100123'), 'works with no name and no total');
  assert.ok(!/\d+%/.test(progBare), 'unknown history size must not display a fabricated percentage');
  assert.ok(!progBare.includes('pdfs'), 'zero counters omitted');

  const done = formatBackfillDone({ status: 'done', name: 'Pirate Movies', chatId: '-100123', processed: 1000, links: 120, dupes: 2159, docs: 30, pdfs: 7, files: 0, live: { emoji: '🟢', label: 'Live indexing ON' } });
  assert.ok(done.includes('✅'), 'done icon');
  assert.ok(done.includes('Pirate Movies'), 'name in completion');
  assert.ok(done.includes('7 pdfs'), 'pdfs in completion');
  assert.ok(done.includes('2159 dupes already saved'), 'dupes explained in completion');
  assert.ok(done.includes('🟢'), 'live indicator in completion');

  const now = Date.now();
  assert.equal(followLiveness(true, 0, now).emoji, '🟢', 'connected account is live');
  assert.equal(followLiveness(false, now - 3600_000, now).emoji, '🟢', 'recently seen follow is live');
  assert.equal(followLiveness(false, now - 48 * 3600_000, now).emoji, '⚪', 'stale follow is idle');
  assert.equal(followLiveness(false, 0, now).emoji, '⚪', 'never-seen follow is idle');
}

// Canonical rows are enrichment; source occurrences must remain complete and scoped.
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
    .replace(/^CREATE EXTENSION[^;]*;/gm, '').replace(/^CREATE INDEX[^;]*USING gin[^;]*;/gm, ''));
  const DB = {
    prepare(sql) {
      const statement = (params = []) => ({
        bind(...values) { return statement(values.map(value => value ?? null)); },
        async run() { const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
        async first(column) { const row = sqlite.prepare(sql).get(...params); return row ? (column ? row[column] : row) : null; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; }
      });
      return statement();
    }
  };
  const env = { DB };
  const user = { id: 'source_reader', provider: 'fixture' };
  const url = 'https://hidden.example/tool';
  const rawUrl = 'https://raw.example/reference';
  const hash = generateUrlHash(url);
  const body = `  Tool label\n${'Original paragraph with spacing.  '.repeat(180)}\n${rawUrl}\nsourceonlyneedle\nLast line <keep>  `;
  const message = { message: body, entities: [{ className: 'MessageEntityTextUrl', offset: 2, length: 10, url }], media: { document: { id: '9007199254740993' } }, replyTo: { replyToMsgId: 7 } };
  try {
    sqlite.prepare('INSERT INTO users (id,username,created_at) VALUES (?,?,?)').run(user.id, user.id, 1);
    for (const community of ['source_community', 'other_community']) {
      sqlite.prepare('INSERT INTO communities (id,name,creator_id,created_at) VALUES (?,?,?,?)').run(community, community, user.id, 1);
      sqlite.prepare('INSERT INTO community_members (community_id,user_id,joined_at) VALUES (?,?,?)').run(community, user.id, 1);
    }
    sqlite.prepare('INSERT INTO users (id,username,created_at) VALUES (?,?,?)').run('other_reader', 'other_reader', 1);
    for (const [table, column, key, id] of [
      ['personal_links', 'user_id', user.id, 'personal_hit'],
      ['personal_links', 'user_id', 'other_reader', 'other_hit'],
      ['links', 'community_id', 'source_community', 'community_hit'],
      ['links', 'community_id', 'other_community', 'foreign_hit']
    ]) {
      const columns = table === 'links' ? ',added_by' : '';
      const values = table === 'links' ? [user.id] : [];
      sqlite.prepare(`INSERT INTO ${table} (id,${column},url,url_hash,title,notes,tags,created_at,metadata_version${columns}) VALUES (?,?,?,?,?,?,?,?,?${values.length ? ',?' : ''})`)
        .run(id, key, url, hash, 'Enriched tool title', 'Independent canonical summary', '[]', 1, 3, ...values);
    }
    sqlite.prepare('INSERT INTO personal_links (id,user_id,url,url_hash,title,notes,created_at,metadata_version) VALUES (?,?,?,?,?,?,?,?)')
      .run('raw_hit', user.id, rawUrl, generateUrlHash(rawUrl), 'Reference', 'Reference enrichment', 1, 3);
    await hydrateSourcePosts(env, 'personal', user.id, [{ id: 'personal_hit', url }]);
    const postInsert = sqlite.prepare('INSERT INTO clone_posts (destination,chat_id,topic_id,message_id,message_text,message_json,urls_json,topic_name,message_date,source_url,transfer_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const sourceInsert = sqlite.prepare('INSERT INTO clone_sources (destination,chat_id,topic_id,message_id,content_key,content_id,status,transfer_id) VALUES (?,?,?,?,?,?,?,?)');
    const addPost = (destination, mid, text, contentId, status = 'saved') => {
      postInsert.run(destination, '-1001234567', '7', mid, text, JSON.stringify({ ...message, message: text, entities: text === body ? message.entities : [] }), JSON.stringify([{ url, label: 'Tool label' }]), 'Research', Number(mid), `https://t.me/c/1234567/${mid}`, 'source_fixture');
      sourceInsert.run(destination, '-1001234567', '7', mid, `url:${hash}`, contentId, status, 'source_fixture');
    };
    addPost(`personal:${user.id}`, '10', body, 'personal_hit');
    sourceInsert.run(`personal:${user.id}`, '-1001234567', '7', '10', `url:${generateUrlHash(rawUrl)}`, 'raw_hit', 'saved', 'source_fixture');
    // Source-only association: URL dedupe can have no content_id but still maps to the canonical URL.
    addPost(`personal:${user.id}`, '11', '  Repeated post, separate original body  ', null, 'duplicate');
    addPost(`personal:${user.id}`, '12', 'failed-source-must-not-appear', null, 'failed');
    addPost('personal:other_reader', '10', 'private-foreign-source', 'other_hit');
    addPost('community:source_community', '10', '  Community original body  ', 'community_hit');
    addPost('community:other_community', '10', 'foreign-community-source', 'foreign_hit');
    const assertPersonalSources = rows => {
      const row = rows.find(item => item.id === 'personal_hit');
      assert.ok(row, 'canonical hidden URL is found');
      assert.deepEqual(row.source_posts.map(post => post.message_id).sort(), ['10', '11'], 'all repeated source posts, including URL-only association');
      const full = row.source_posts.find(post => post.message_id === '10');
      assert.equal(full.message_text, body, 'original body is untrimmed and not clipped');
      assert.deepEqual(full.message, message, 'entities, media and reply metadata survive');
      assert.equal(full.topic_name, 'Research');
      assert.equal(full.source_url, 'https://t.me/c/1234567/10');
      assert.ok(row.source_posts.every(post => post.destination === `personal:${user.id}`));
      assert.equal(row.notes, 'Independent canonical summary');
      return row;
    };
    assertPersonalSources(await hydrateSourcePosts(env, 'personal', user.id, [{ id: 'personal_hit', url, notes: 'Independent canonical summary' }]));
    for (const query of [url, url + '/', 'sourceonlyneedle']) {
      const rows = await searchAllLinks(env, 'personal', user.id, query);
      assertPersonalSources(rankLinks(rows, query));
    }
    const rawRows = await searchAllLinks(env, 'personal', user.id, rawUrl);
    const rawPost = rawRows.find(row => row.id === 'raw_hit').source_posts;
    assert.equal(rawPost.length, 1);
    assert.equal(rawPost[0].message_text, body, 'a raw URL in a multi-link post retrieves the same whole original as its hidden URL');
    const meiliRows = await hydrateMeiliRows(env, 'personal', user.id, [
      { id: 'personal_hit', url, notes: 'index snippet' },
      { id: 'other_hit', url, notes: 'foreign index hit' },
      { id: 'deleted_hit', url, notes: 'stale index hit' }
    ]);
    assert.deepEqual(meiliRows.map(row => row.id), ['personal_hit'], 'foreign and deleted index hits are not returned');
    const hydrated = assertPersonalSources(meiliRows);
    const html = telegramSearchRowHtml(hydrated);
    assert.ok(html.includes('Original paragraph with spacing.  '.repeat(180)), 'Telegram keeps body beyond its old 360-character snippet');
    assert.ok(html.includes('Last line &lt;keep&gt;  '), 'Telegram retains and escapes the body ending');
    assert.ok(html.includes(`<a href="${url}">Tool label</a>`), 'hidden URL retains its visible entity label');
    assert.ok(html.includes('Repeated post, separate original body'));
    assert.doesNotMatch(html, /private-foreign-source|foreign-community-source|failed-source/);
    for (const [scope, key, expected] of [['personal', user.id, body], ['community', 'source_community', '  Community original body  ']]) {
      const api = new URL(`https://fixture.invalid/api/links/search?scope=${scope}&community_id=${key}&q=${encodeURIComponent(url)}`);
      const response = await handleSearchLinks(api, user, env, {});
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(payload.links.some(row => row.source_posts.some(post => post.message_text === expected)));
      assert.ok(payload.links.every(row => row.source_posts.every(post => post.destination === `${scope}:${key}`)), 'API cannot cross source destinations');
    }
  } finally {
    sqlite.close();
  }
}
// Faithful Telegram copy: hyperlinks and formatting stay in place, images dropped.
assert.equal(
  telegramEntityMarkdown('Get App here', [{ type: 'text_link', offset: 4, length: 3, url: 'https://example.com/app' }]),
  'Get [App](https://example.com/app) here',
);
assert.equal(
  telegramRichMarkdown({
    text: 'Bold and link',
    entities: [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'text_link', offset: 9, length: 4, url: 'https://example.com/x' },
    ],
    reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.com/btn' }]] },
  }).includes('[link](https://example.com/x)'),
  true,
);
assert.equal(
  telegramRichNotesForSave({ caption: 'Photo caption with https://example.com/cap', photo: [{ file_id: 'abc' }] }).includes('https://example.com/cap'),
  true,
);

// /forcetags rule fallback: junk dropped, platform + topic added.
assert.deepEqual(parseStoredTags('["backfill", "Telegram"]'), ['backfill', 'telegram']);
assert.deepEqual(parseStoredTags(''), []);
assert.deepEqual(normalizeTagList(['Music', 'music', '#Pop']), ['music', 'pop']);
{
  const r = smartFallbackTags('https://example.com/super-music.apk', { title: 'Super Music Player', notes: 'Best android music app, free apk download', content: '' }, ['backfill', 'telegram', 'music']);
  assert.ok(r.removed.includes('backfill') && r.removed.includes('telegram'), 'junk drops when content is not about it');
  assert.ok(r.kept.includes('music'), 'fitting tag kept');
  assert.ok(r.tags.includes('android'), 'platform detected');
  assert.ok(r.tags.includes('app'), 'app type detected');
}
{
  const r = smartFallbackTags('https://t.me/mybot', { title: 'Telegram bot client', notes: '', content: '' }, ['backfill', 'telegram']);
  assert.ok(!r.removed.includes('telegram'), 'telegram kept for Telegram content');
  assert.ok(r.removed.includes('backfill'), 'backfill always junk');
  assert.ok(r.tags.includes('bot'), 'bot topic detected');
}
{
  const r = smartFallbackTags('https://example.com/x', { title: '', notes: '', content: '' }, ['backfill', 'dump']);
  assert.equal(r.removed.length, 2, 'content-free rows lose all junk');
}

console.log('retrieval tests passed');
