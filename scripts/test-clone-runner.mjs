import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Ingestion proof for the REAL runHistoryIndexJob: real SQLite schema, real
// sink helpers; only the GramJS client and the clock are fixtures. Set the
// media vault before importing the worker (module-level constant).
const vaultDir = mkdtempSync(join(tmpdir(), 'athena-vault-'));
process.env.ATHENA_MEDIA_DIR = vaultDir;
// Resolve GramJS before worker import: startBackfillJob starts its runner
// immediately, so injecting a runtime client after start would race real auth.
const authenticatedClients = [];
let includeLateMessage = false;
class StringSession { constructor(value) { this.value = value; } }
class TelegramClient {
  constructor(session, apiId, apiHash) {
    assert.equal(session.value, 'runner-synthetic-session');
    assert.equal(apiId, 12345);
    assert.equal(apiHash, 'runner-synthetic-hash');
    this.connected = false;
    authenticatedClients.push(this);
  }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async getMe() { assert.equal(this.connected, true); return { id: 700000004n, firstName: 'Runner' }; }
  async getDialogs() { return []; }
  addEventHandler() {}
  async getEntity() { assert.equal(this.connected, true); return { className: 'Channel', title: 'Managed runner', forum: false }; }
  async getMessages(_chat, options) {
    assert.equal(this.connected, true);
    const messages = [
      ...(includeLateMessage ? [{ id: 13, className: 'Message', message: 'https://example.com/managed-late' }] : []),
      { id: 12, className: 'Message', message: 'https://example.com/managed-link' },
      { ...HISTORY[1], id: 11 },
    ];
    return messages.filter(m => !options.offsetId || m.id < options.offsetId).slice(0, options.limit);
  }
  async downloadMedia() { assert.equal(this.connected, true); return new TextEncoder().encode('managed markdown bytes'); }
}
const fixtureKey = Symbol.for('athena.runner.fixture.telegram');
globalThis[fixtureKey] = { TelegramClient, StringSession };
const telegramUrl = 'data:text/javascript,' + encodeURIComponent(`
const fixture = globalThis[Symbol.for('athena.runner.fixture.telegram')];
export const TelegramClient = fixture.TelegramClient;
export const sessions = { StringSession: fixture.StringSession };
`);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'telegram') return { url: telegramUrl, shortCircuit: true };
  if (specifier.startsWith('telegram/')) throw new Error('Unmocked Telegram module');
  return nextResolve(specifier, context);
} });
const { default: worker, buildStatsReport, capturePostIntoSinks, ensureIndexTables, runHistoryIndexJob, wipeCloneVaultPaths } = await import('../worker/index.js');

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
  .replace(/^CREATE EXTENSION[^;]*;/gm, '').replace(/^CREATE INDEX[^;]*USING gin[^;]*;/gm, ''));
sql.exec(`CREATE TABLE IF NOT EXISTS userbot_accounts (label TEXT PRIMARY KEY, api_id TEXT, api_hash_enc TEXT, session_enc TEXT, enabled INTEGER, last_error TEXT, updated_at INTEGER);
INSERT INTO userbot_accounts VALUES ('alpha','1','x','y',1,NULL,NULL);`);
const DB = { prepare(query) {
  const checkFault = () => { if (databaseFault?.(query)) throw new Error('synthetic persistence outage'); };
  const bind = (values = []) => ({ bind(...args) { return bind(args.map(v => v ?? null)); },
    async first(column) { const r = sql.prepare(query).get(...values); return r ? (column ? r[column] : r) : null; },
    async all() { return { results: sql.prepare(query).all(...values) }; },
    async run() { checkFault(); const r = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; } });
  return bind();
} };
let databaseFault = null;
const HISTORY = [
  { id: 4, className: 'Message', date: 1700000004, senderId: 777, message: 'see https://example.com/one and https://example.com/two',
    media: { className: 'MessageMediaDocument', document: { size: 900, mimeType: 'application/pdf', attributes: [ { className: 'DocumentAttributeFilename', fileName: 'report.pdf' }, { className: 'DocumentAttributeVideo', w: 10, h: 10 } ] } } },
  { id: 3, className: 'Message', date: 1700000003, message: 'plain doc', media: { className: 'MessageMediaDocument', document: { size: 10, mimeType: 'text/markdown', attributes: [ { className: 'DocumentAttributeFilename', fileName: 'notes.md' } ] } } },
  { id: 2, className: 'Message', date: 1700000002, message: 'audio note', media: { className: 'MessageMediaDocument', document: { size: 5, mimeType: 'audio/ogg', attributes: [ { className: 'DocumentAttributeAudio', voice: false } ] } } },
  { id: 1, className: 'Message', date: 1700000001, message: 'video skipped', media: { className: 'MessageMediaDocument', document: { size: 50, mimeType: 'video/mp4', attributes: [ { className: 'DocumentAttributeVideo' } ] } } }
];
let downloads = 0;
const client = { connected: true,
  async getEntity() { return { className: 'Channel', title: 'Runner source', forum: false, participantsCount: 5 }; },
  async getMessages(_chat, opts) { return HISTORY.filter(m => !opts.offsetId || m.id < opts.offsetId).slice(0, opts.limit); },
  async downloadMedia(message) { downloads++; return new TextEncoder().encode(`content-${message.id}`); }
};
const originalFetch = globalThis.fetch;
const sent = [];
let outgoingId = 100;
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
const background = [];
const env = { DB, ATHENA_RUNTIME: 'selfhost', TELEGRAM_BOT_TOKEN: '123:fixture', TG_OWNER_IDS: '123456789',
  TELEGRAM_WEBHOOK_SECRET: 'runner-synthetic-webhook-secret', STORAGE_KEY: 'runner-synthetic-storage-key',
  __ctx: { waitUntil: promise => background.push(promise) } };
const originalSetInterval = globalThis.setInterval;
const intervals = new Set();
globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); intervals.add(timer); return timer; };
async function drain() { while (background.length) await background.shift(); }
try {
  await ensureIndexTables(env);

  const insert = (jobId, { communityId = '', chatId = '-1001234567890', userId = 'u_fixture', threadId = null, minId = null, maxId = null, target = 'personal', total = 4, topicName = '' } = {}) => env.DB.prepare(`INSERT INTO index_jobs (id,community_id,chat_id,user_id,status,offset_id,progress_chat_id,created_at,updated_at,thread_id,min_id,max_id,chat_name,userbot_label,target,parent_id,silent_progress,total_messages,known_total,progress_msg_id,progress_thread_id,topic_name)
    VALUES (?,?,?,?,'queued',0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(jobId, communityId, chatId, userId, '123456789', Date.now(), Date.now(), threadId, minId, maxId, 'Runner source', 'alpha', target, null, 1, total, 1, null, null, topicName).run();
  await insert('ij_fixture_1');
  const job = await env.DB.prepare('SELECT * FROM index_jobs WHERE id=?').bind('ij_fixture_1').first();
  await runHistoryIndexJob(env, job, 'fixture', { client, sleep: async () => {} });
  const after = await env.DB.prepare('SELECT * FROM index_jobs WHERE id=?').bind('ij_fixture_1').first();
  assert.equal(after.status, 'done', JSON.stringify(after));
  const counters = JSON.parse(after.counters_json);
  assert.equal(counters.messages, 4);
  assert.equal(counters.savedPdfs, 0, 'video-attributed pdf excluded by attribute priority, not counted');
  assert.equal(counters.skippedVideos, 2, 'both video-classified media skipped regardless of filename');
  assert.equal(downloads, 2, 'video never downloaded');
  assert.equal(counters.linkPosts, 1);
  assert.equal(counters.savedLinkPosts, 1);
  assert.equal(counters.savedMarkdown, 1);
  assert.equal(counters.savedAudio, 1);
  const completePost = sql.prepare("SELECT * FROM clone_posts WHERE destination='personal:u_fixture' AND message_id='4'").get();
  assert.equal(completePost.message_text, HISTORY[0].message, 'complete body survives individual URL indexing');
  assert.deepEqual(JSON.parse(completePost.message_json).media, HISTORY[0].media, 'original media attributes remain attached to the source post');
  assert.equal(sql.prepare("SELECT count(*) n FROM clone_posts WHERE destination='personal:u_fixture'").get().n, 4, 'each source message has one post, including excluded media');
  assert.equal(Number(after.saved_docs), 1, 'markdown indexed as document; spoofed pdf is video');
  const personal = sql.prepare('SELECT url FROM personal_links ORDER BY url').all();
  assert.equal(personal.length, 2, 'both URLs land in the personal sink');
  const docs = sql.prepare("SELECT filename FROM uploaded_documents WHERE scope='personal' ORDER BY filename").all();
  assert.deepEqual(docs.map(d => d.filename), ['notes.md'], 'spoofed pdf is video; markdown indexed');
  const provenance = sql.prepare('SELECT message_id, content_key, status FROM clone_sources ORDER BY message_id, content_key').all();
  assert.deepEqual(provenance.map(r => `${r.message_id}:${r.content_key.split(':')[0]}`), ['2:media', '3:media', '4:url', '4:url'], 'every source component has provenance');
  assert.equal(new Set(provenance.filter(r => r.message_id === '4').map(r => r.content_key)).size, 2, 'distinct URLs retain distinct source identities');
  assert.ok(provenance.every(r => r.status === 'saved'));
  const mediaRows = sql.prepare("SELECT message_id,storage_path FROM clone_sources WHERE content_key='media' ORDER BY message_id").all();
  for (const row of mediaRows) assert.equal(readFileSync(row.storage_path, 'utf8'), `content-${row.message_id}`);

  // Idempotent resume: same job id reruns with clone_job_items checkpoints.
  await env.DB.prepare("UPDATE index_jobs SET status='queued' WHERE id=?").bind('ij_fixture_1').run();
  await runHistoryIndexJob(env, { id: 'ij_fixture_1' }, 'fixture', { client, sleep: async () => {} });
  assert.equal(sql.prepare('SELECT count(*) n FROM personal_links').get().n, 2, 'resume does not double-insert links');
  assert.equal(sql.prepare('SELECT count(*) n FROM uploaded_documents').get().n, 1, 'resume does not double-insert documents');

  // A second clone job over the same source is a duplicate, not a re-save.
  await insert('ij_fixture_2');
  await runHistoryIndexJob(env, await env.DB.prepare('SELECT * FROM index_jobs WHERE id=?').bind('ij_fixture_2').first(), 'fixture', { client, sleep: async () => {} });
  const second = await env.DB.prepare('SELECT * FROM index_jobs WHERE id=?').bind('ij_fixture_2').first();
  assert.equal(JSON.parse(second.counters_json).duplicates, 4, 'cross-run copies counted as duplicates via source identity');
  assert.equal(sql.prepare('SELECT count(*) n FROM personal_links').get().n, 2);

  // A user can remove canonical content while old provenance survives. Those
  // saved markers are not proof that a later clone still has a usable copy.
  const removedLinkIds = sql.prepare('SELECT id FROM personal_links WHERE transfer_id=?').all('ij_fixture_1').map(row => row.id);
  const removedDocumentId = sql.prepare('SELECT id FROM uploaded_documents WHERE transfer_id=?').get('ij_fixture_1').id;
  sql.prepare('DELETE FROM personal_links WHERE transfer_id=?').run('ij_fixture_1');
  sql.prepare('DELETE FROM uploaded_documents WHERE transfer_id=?').run('ij_fixture_1');
  assert.equal(sql.prepare("SELECT count(*) n FROM clone_sources WHERE transfer_id=? AND status='saved'").get('ij_fixture_1').n, 4);
  await insert('ij_reclone_deleted');
  await runHistoryIndexJob(env, { id: 'ij_reclone_deleted' }, 'fixture', { client, sleep: async () => {} });
  const recloned = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get('ij_reclone_deleted');
  assert.equal(recloned.status, 'done', JSON.stringify(recloned));
  const recloneCounters = JSON.parse(recloned.counters_json);
  assert.equal(recloneCounters.savedLinks, 2, 'deleted links reappear instead of counting stale markers as duplicates');
  assert.equal(recloneCounters.savedDocs, 1, 'deleted document is reindexed even when its original vault file survives');
  assert.equal(recloneCounters.duplicates, 1, 'only the untouched audio original remains a duplicate');
  const restoredLinks = sql.prepare('SELECT id,url FROM personal_links WHERE transfer_id=? ORDER BY url').all(recloned.id);
  assert.deepEqual(restoredLinks.map(row => row.url), ['https://example.com/one', 'https://example.com/two']);
  assert.ok(restoredLinks.every(row => !removedLinkIds.includes(row.id)), 'restored links have live canonical records');
  const restoredDocument = sql.prepare('SELECT id,content FROM uploaded_documents WHERE transfer_id=?').get(recloned.id);
  assert.notEqual(restoredDocument.id, removedDocumentId);
  assert.equal(restoredDocument.content, 'content-3');
  const restoredSource = sql.prepare("SELECT content_id,status FROM clone_sources WHERE destination='personal:u_fixture' AND message_id='3' AND content_key='media'").get();
  assert.equal(restoredSource.content_id, sql.prepare('SELECT id FROM uploaded_documents WHERE transfer_id=?').get('ij_reclone_deleted').id, 'reprovenance points at the replacement canonical record');
  assert.equal(restoredSource.status, 'saved');
  // Vault cleanup is scoped by transfer: wiping the reclone must delete its
  // stored original from disk together with the provenance that references it.
  const wipedPath = sql.prepare("SELECT storage_path FROM clone_sources WHERE transfer_id=? AND content_key='media'").get(recloned.id).storage_path;
  assert.equal(existsSync(wipedPath), true, 'the reindexed document original is stored before cleanup');
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_sources WHERE transfer_id=?').get('ij_fixture_1').n, 1, 'resave repoints resaved items; only the untouched duplicate keeps the old transfer');
  const wipe = await wipeCloneVaultPaths(env, { transferIds: [recloned.id], chatKeys: [] });
  assert.equal(wipe, 1, 'one stored original is wiped with its checkpoints');
  assert.equal(existsSync(wipedPath), false, 'the stored original disappears with its provenance');
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_sources WHERE transfer_id=?').get(recloned.id).n, 0);
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_job_items WHERE job_id=?').get(recloned.id).n, 0);

  // Wiping the original job removes its stale provenance and stored audio.
  const audioPath = sql.prepare("SELECT storage_path FROM clone_sources WHERE transfer_id='ij_fixture_1' AND message_id='2'").get().storage_path;
  assert.equal(existsSync(audioPath), true, 'the untouched duplicate original is still stored');
  await wipeCloneVaultPaths(env, { transferIds: ['ij_fixture_1'], chatKeys: [] });
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_sources WHERE transfer_id=?').get('ij_fixture_1').n, 0, 'cleanup removes the wiped provenance');
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_job_items WHERE job_id=?').get('ij_fixture_1').n, 0, 'cleanup removes its checkpoints');
  assert.equal(existsSync(audioPath), false, 'the duplicate original is removed from disk');

  // Scope isolation, topic provenance, inclusive snapshot/min boundaries, and
  // a recoverable media failure followed by successful ingestion in each sink.
  for (const target of ['community', 'both']) {
    const id = `ij_${target}`;
    const chatId = target === 'community' ? '-1002222222222' : '-1003333333333';
    const communityId = `c_${target}`, userId = `u_${target}`;
    sql.prepare('INSERT INTO users (id,username,created_at) VALUES (?,?,?)').run(userId, userId, Date.now());
    sql.prepare('INSERT INTO communities (id,name,creator_id,created_at) VALUES (?,?,?,?)').run(communityId, communityId, userId, Date.now());
    const message = (id, text, topicId = 42) => ({ id, className: 'Message', date: 1700000100 + id, senderId: 888,
      message: text, replyTo: { replyToTopId: topicId, forumTopic: true } });
    const history = [message(9, 'https://example.com/too-new'),
      { ...message(8, 'failed media'), media: HISTORY[2].media },
      message(7, 'https://example.com/wrong-topic', 43),
      { ...message(6, 'saved markdown'), media: HISTORY[1].media },
      message(5, `https://example.com/${target}-boundary`),
      message(4, 'https://example.com/too-old')];
    const offsets = [], attemptedMedia = [];
    let entityAttempts = 0, floodAt;
    const scopedClient = {
      async getEntity() {
        if (++entityAttempts === 1) {
          floodAt = Date.now();
          throw Object.assign(new Error('FLOOD_WAIT'), { seconds: 0.001 });
        }
        assert.ok(Date.now() >= floodAt + 1, 'real account flood scheduler waits before retrying');
        return { className: 'Channel', title: 'Forum source', forum: true };
      },
      async getMessages(_chat, options) {
        offsets.push(options.offsetId);
        assert.equal(options.replyTo, 42, 'topic history request remains scoped');
        return history.filter(m => !options.offsetId || m.id < options.offsetId);
      },
      async downloadMedia(m) {
        attemptedMedia.push(m.id);
        return m.id === 8 ? undefined : new TextEncoder().encode(`markdown-${target}`);
      },
    };
    await insert(id, { communityId, userId, chatId, target, threadId: '42', topicName: 'Research', minId: 5, maxId: 8, total: 3 });
    await runHistoryIndexJob(env, { id }, 'fixture', { client: scopedClient, sleep: async () => {} });
    const result = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get(id);
    assert.equal(result.status, 'done', result.error);
    const counts = JSON.parse(result.counters_json);
    const sinkCount = target === 'both' ? 2 : 1;
    assert.equal(counts.messages, 3, 'topic, snapshot and minimum boundaries exclude unrelated history');
    assert.equal(counts.retries, 1, 'FloodWait retries the actual client operation');
    assert.equal(entityAttempts, 2);
    assert.equal(counts.failed, sinkCount, JSON.stringify(sql.prepare('SELECT message_id,content_key,status,error_category FROM clone_sources WHERE transfer_id=?').all(id)));
    assert.equal(counts.savedFiles, sinkCount);
    assert.equal(counts.savedLinks, sinkCount);
    assert.equal(counts.linkPosts, 1);
    assert.equal(counts.savedLinkPosts, 1, 'saved link posts count once across both sinks');
    assert.equal(counts.savedMarkdown, sinkCount, 'successful subtypes use per-sink write units');
    assert.deepEqual(offsets, [9], 'snapshot is inclusive; minimum terminates without fetching older pages');
    assert.ok(attemptedMedia.includes(8) && attemptedMedia.includes(6), 'failed media does not end the clone');
    const destinations = target === 'both' ? [`community:${communityId}`, `personal:${userId}`] : [`community:${communityId}`];
    const sources = sql.prepare('SELECT * FROM clone_sources WHERE transfer_id=? ORDER BY destination,message_id').all(id);
    assert.equal(sources.length, 3 * sinkCount);
    assert.deepEqual([...new Set(sources.map(row => row.destination))].sort(), destinations.sort());
    for (const row of sources) {
      assert.equal(row.chat_id, chatId);
      assert.equal(row.topic_id, '42');
      assert.equal(row.topic_name, 'Research');
      assert.equal(row.sender_id, '888');
      assert.equal(row.message_date, 1700000100 + Number(row.message_id));
      assert.equal(row.source_url, `https://t.me/c/${chatId.slice(4)}/${row.message_id}`);
      assert.equal(row.status, row.message_id === '8' ? 'failed' : 'saved');
      if (row.message_id === '8') {
        assert.equal(row.error_category, 'operation');
        assert.equal(row.storage_path, null);
      } else if (row.message_id === '6') assert.equal(readFileSync(row.storage_path, 'utf8'), `markdown-${target}`);
    }
    const communityLinks = sql.prepare('SELECT url,community_id FROM links WHERE transfer_id=?').all(id);
    assert.deepEqual(communityLinks.map(row => [row.community_id, row.url]), [[communityId, `https://example.com/${target}-boundary`]]);
    const personalLinks = sql.prepare('SELECT url,user_id FROM personal_links WHERE transfer_id=?').all(id);
    assert.deepEqual(personalLinks.map(row => [row.user_id, row.url]), target === 'both' ? [[userId, `https://example.com/${target}-boundary`]] : []);
    const documents = sql.prepare('SELECT scope,community_id,user_id,content FROM uploaded_documents WHERE transfer_id=? ORDER BY scope').all(id);
    assert.deepEqual(documents.map(row => [row.scope, row.scope === 'personal' ? row.user_id : row.community_id, row.content]),
      target === 'both' ? [['community', communityId, 'markdown-both'], ['personal', userId, 'markdown-both']] : [['community', communityId, 'markdown-community']]);
  }

  // Stop after one persisted page, then restart from its real offset. A third
  // replay from the snapshot checks item checkpoints, not just end-of-history.
  const restartId = 'ij_restart';
  const restartHistory = [3, 2, 1].map(id => ({ id, className: 'Message', message: `https://example.com/restart-${id}` }));
  const restartOffsets = [];
  const restartClient = { ...client, async getMessages(_chat, options) {
    restartOffsets.push(options.offsetId);
    return restartHistory.filter(m => !options.offsetId || m.id < options.offsetId).slice(0, 1);
  } };
  await insert(restartId, { chatId: '-1004444444444', userId: 'u_restart', maxId: 3, minId: 1, total: 3 });
  await runHistoryIndexJob(env, { id: restartId }, 'fixture', { client: restartClient, sleep: async () => {
    sql.prepare("UPDATE index_jobs SET status='stopping' WHERE id=?").run(restartId);
  } });
  const stopped = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get(restartId);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.offset_id, 3);
  assert.equal(JSON.parse(stopped.counters_json).messages, 1);
  sql.prepare("UPDATE index_jobs SET status='queued' WHERE id=?").run(restartId);
  await runHistoryIndexJob(env, { id: restartId }, 'fixture', { client: restartClient, sleep: async () => {} });
  const restarted = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get(restartId);
  assert.equal(restarted.status, 'done', restarted.error);
  assert.deepEqual(restartOffsets, [4, 3, 2], 'restart begins at the committed checkpoint');
  const restartCounters = JSON.parse(restarted.counters_json);
  assert.equal(restartCounters.messages, 3);
  assert.equal(restartCounters.savedLinks, 3);
  assert.equal(restartCounters.duplicates, 0);
  sql.prepare("UPDATE index_jobs SET status='queued',offset_id=0 WHERE id=?").run(restartId);
  await runHistoryIndexJob(env, { id: restartId }, 'fixture', { client: restartClient, sleep: async () => {} });
  assert.deepEqual(JSON.parse(sql.prepare('SELECT counters_json FROM index_jobs WHERE id=?').get(restartId).counters_json), restartCounters, 'replaying committed messages preserves counters');
  assert.equal(sql.prepare('SELECT count(*) n FROM personal_links WHERE user_id=?').get('u_restart').n, 3);

  // Normal capture and history use the same original-post contract: hidden
  // labels, raw links, mixed posts and repeated canonical URLs keep every post.
  const labels = ['First', 'Second', 'Third', 'Fourth'];
  const hiddenText = '  😀 First Second Third Fourth\n';
  const hiddenEntities = labels.map((label, index) => ({ type: 'text_link', offset: hiddenText.indexOf(label), length: label.length, url: `https://example.com/source-hidden-${index}` }));
  const rawUrls = Array.from({ length: 6 }, (_, index) => `https://example.com/source-raw-${index}`);
  const posts = [
    { message_id: 1, text: hiddenText, entities: hiddenEntities },
    { message_id: 2, text: `  ${rawUrls.join('\n')}\n` },
    { message_id: 3, caption: `${hiddenText}${rawUrls.join('\n')}\n`, caption_entities: hiddenEntities,
      photo: [{ file_id: 'full-post-photo', file_unique_id: 'full-post-photo-unique', width: 10, height: 10, file_size: 3 }] },
    { message_id: 4, text: `Different original context: ${hiddenEntities[0].url}\nDo not replace this with metadata.`, reply_to_message: { message_id: 1, text: hiddenText } }
  ];
  const richChatId = '-1006666666666';
  sql.prepare('INSERT INTO users (id,username,created_at) VALUES (?,?,?)').run('u_sources', 'sources', Date.now());
  sql.prepare('INSERT INTO communities (id,name,creator_id,created_at) VALUES (?,?,?,?)').run('c_sources', 'Sources', 'u_sources', Date.now());
  for (const post of posts) {
    const msg = { ...post, chat: { id: richChatId, type: 'supergroup' }, message_thread_id: 42, date: 1700000200 + post.message_id };
    const captured = await capturePostIntoSinks(env, ['personal', 'community'], { msg, token: 'fixture', personalOwner: 'u_sources', communityId: 'c_sources', channelTitle: 'Originals', topicName: 'Full body', downloadMedia: async () => new Uint8Array([1, 2, 3]) });
    assert.equal(captured.failed, 0);
    assert.equal(captured.linkPosts, 1);
    const expected = [4, 6, 10, 1][post.message_id - 1];
    assert.equal(captured.links, expected);
    assert.equal(captured.savedLinkPosts, post.message_id <= 2 ? 1 : 0, 'one source link-post save across both destinations');
    for (const destination of ['personal:u_sources', 'community:c_sources']) {
      const saved = sql.prepare('SELECT * FROM clone_posts WHERE destination=? AND chat_id=? AND topic_id=? AND message_id=?').get(destination, richChatId, '42', String(post.message_id));
      assert.equal(saved.message_text, post.text || post.caption);
      assert.deepEqual(JSON.parse(saved.message_json), msg);
      assert.equal(JSON.parse(saved.urls_json).length, expected);
      assert.equal(saved.topic_name, 'Full body');
      assert.equal(sql.prepare("SELECT count(*) n FROM clone_sources WHERE destination=? AND chat_id=? AND message_id=? AND content_key LIKE 'url:%'").get(destination, richChatId, String(post.message_id)).n, expected);
    }
  }
  const liveReport = await buildStatsReport(env, null, { athenaUserId: 'u_sources' });
  const liveRuns = liveReport.runs.filter(run => run.chat_id === richChatId);
  assert.equal(liveRuns.length, 2, 'each live destination has its own durable ledger');
  for (const run of liveRuns) {
    assert.equal(run.state.overall.messages, 4);
    assert.equal(run.state.overall.links, 21);
    assert.equal(run.state.overall.savedLinks, 10);
    assert.equal(run.live, false, 'finished capture is not still copying');
  }
  await capturePostIntoSinks(env, ['personal', 'community'], {
    msg: { ...posts[0], chat: { id: richChatId }, message_thread_id: 42 }, token: 'fixture',
    personalOwner: 'u_sources', communityId: 'c_sources', channelTitle: 'Originals',
  });
  const replayReport = await buildStatsReport({ ...env }, null, { athenaUserId: 'u_sources' });
  assert.deepEqual(replayReport.runs.filter(run => run.chat_id === richChatId).map(run => run.state.overall),
    liveRuns.map(run => run.state.overall), 'fresh report and duplicate delivery retain durable counters');
  assert.equal(sql.prepare('SELECT count(*) n FROM personal_links WHERE user_id=?').get('u_sources').n, 10);
  assert.equal(sql.prepare('SELECT count(*) n FROM links WHERE community_id=?').get('c_sources').n, 10);
  const repeatedPosts = sql.prepare("SELECT message_id,content_id FROM clone_sources WHERE destination='personal:u_sources' AND chat_id=? AND content_id=(SELECT id FROM personal_links WHERE user_id='u_sources' AND url=?) ORDER BY message_id").all(richChatId, hiddenEntities[0].url);
  assert.deepEqual(repeatedPosts.map(row => row.message_id), ['1', '3', '4'], 'one canonical URL associates every original post');

  const historyPosts = posts.map(post => ({ ...post, id: post.message_id, className: 'Message', message: post.text || '', replyTo: { forumTopic: true, replyToTopId: 42 },
    ...(post.photo ? { media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ size: 3 }] } } } : {}) })).reverse();
  const fullHistoryClient = { ...client, async getMessages(_chat, options) { return historyPosts.filter(post => !options.offsetId || post.id < options.offsetId); }, async downloadMedia() { return new Uint8Array([1, 2, 3]); } };
  await insert('ij_full_posts', { userId: 'u_history_sources', chatId: '-1006666666667', threadId: '42', topicName: 'Full body', total: 4, minId: 1, maxId: 4 });
  await runHistoryIndexJob(env, { id: 'ij_full_posts' }, 'fixture', { client: fullHistoryClient, sleep: async () => {} });
  const fullJob = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get('ij_full_posts');
  assert.equal(fullJob.status, 'done', fullJob.error);
  const fullCounts = JSON.parse(fullJob.counters_json);
  assert.equal(fullCounts.linkPosts, 4);
  assert.equal(fullCounts.links, 21);
  assert.equal(sql.prepare('SELECT count(*) n FROM personal_links WHERE user_id=?').get('u_history_sources').n, 10);
  for (const post of posts) {
    const saved = sql.prepare("SELECT * FROM clone_posts WHERE destination='personal:u_history_sources' AND message_id=?").get(String(post.message_id));
    assert.equal(saved.message_text, post.text || post.caption);
    assert.equal(JSON.parse(saved.urls_json).length, [4, 6, 10, 1][post.message_id - 1]);
  }

  // Removing one clone source removes its full posts, not another chat's copy
  // or the independently enriched canonical records.
  await wipeCloneVaultPaths(env, { chatKeys: [richChatId] });
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_posts WHERE chat_id=?').get(richChatId).n, 0);
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_sources WHERE chat_id=?').get(richChatId).n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM clone_posts WHERE destination='personal:u_history_sources'").get().n, 4);
  assert.equal(sql.prepare('SELECT count(*) n FROM personal_links WHERE user_id=?').get('u_sources').n, 10);

  // Database failures must not advance the page past unsaved source bodies,
  // provenance or checkpoints. Restart reuses durable content exactly once.
  for (const table of ['clone_posts', 'clone_sources', 'clone_job_items']) {
    const id = `ij_db_${table}`;
    const userId = `u_db_${table}`;
    const chatId = `-100777777777${['clone_posts', 'clone_sources', 'clone_job_items'].indexOf(table)}`;
    const history = [{ id: 1, className: 'Message', message: `  https://example.com/db-${table}\nOriginal body survives recovery.\n` }];
    const failureClient = { ...client, async getMessages(_chat, options) { return history.filter(post => !options.offsetId || post.id < options.offsetId); } };
    await insert(id, { userId, chatId, total: 1, minId: 1, maxId: 1 });
    databaseFault = query => new RegExp(`INSERT INTO ${table}\\b`).test(query);
    try { await runHistoryIndexJob(env, { id }, 'fixture', { client: failureClient, sleep: async () => {} }); }
    finally { databaseFault = null; }
    const failed = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get(id);
    assert.equal(failed.status, 'error', `failed ${table} persistence cannot claim completion`);
    assert.equal(failed.offset_id, 0, `failed ${table} persistence retains safe page boundary`);
    assert.equal(sql.prepare('SELECT count(*) n FROM clone_job_items WHERE job_id=?').get(id).n, 0);
    if (table === 'clone_posts') assert.equal(sql.prepare('SELECT count(*) n FROM personal_links WHERE user_id=?').get(userId).n, 0, 'source persistence precedes canonical writes');
    sql.prepare("UPDATE index_jobs SET status='queued' WHERE id=?").run(id);
    await runHistoryIndexJob(env, { id }, 'fixture', { client: failureClient, sleep: async () => {} });
    const recovered = sql.prepare('SELECT * FROM index_jobs WHERE id=?').get(id);
    assert.equal(recovered.status, 'done', recovered.error);
    assert.equal(JSON.parse(recovered.counters_json).messages, 1, 'restart reconstructs counters without failed-attempt inflation');
    assert.equal(sql.prepare('SELECT count(*) n FROM personal_links WHERE user_id=?').get(userId).n, 1);
    assert.equal(sql.prepare('SELECT count(*) n FROM clone_sources WHERE transfer_id=?').get(id).n, 1);
    assert.equal(sql.prepare('SELECT message_text FROM clone_posts WHERE transfer_id=?').get(id).message_text, history[0].message);
    assert.equal(sql.prepare('SELECT count(*) n FROM clone_job_items WHERE job_id=?').get(id).n, 1);
    sql.prepare("UPDATE index_jobs SET status='queued',offset_id=0 WHERE id=?").run(id);
    await runHistoryIndexJob(env, { id }, 'fixture', { client: failureClient, sleep: async () => {} });
    assert.deepEqual(JSON.parse(sql.prepare('SELECT counters_json FROM index_jobs WHERE id=?').get(id).counters_json), JSON.parse(recovered.counters_json), 'checkpoint replay leaves recovered counters unchanged');
  }

  // Full signed-webhook -> manager -> startBackfillJob -> real runner path.
  // Credentials are synthetic, but their encryption and private account map
  // registration are production code; no runtime client override is involved.
  sql.prepare('INSERT INTO users (id,username,provider,provider_id,telegram_api_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('u_managed', 'managed_fixture', 'telegram', '123456789', '123456789', Date.now());
  let updateId = 91000;
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
  async function command(text) { await deliver({ message: { message_id: updateId + 1, from, chat, text } }); }
  async function click(label) {
    const card = sent.findLast(call => call.method === 'editMessageText' && call.body.rich_message);
    const html = card?.body.rich_message?.html || '';
    const controls = [...html.matchAll(/<tg-button\b[^>]*data="([^"]+)"[^>]*>(.*?)<\/tg-button>/gs)];
    const control = controls.find(([, , text]) => text === label);
    assert.ok(control, `Missing manager control: ${label}`);
    await deliver({ callback_query: { id: `runner-callback-${updateId + 1}`, from, data: control[1].replace(/&amp;/g, '&'),
      message: { message_id: card.messageId, chat } } });
  }
  await command('/userbot_add managed 12345 runner-synthetic-hash runner-synthetic-session');
  assert.equal(sql.prepare('SELECT telegram_id FROM userbot_accounts WHERE label=?').get('managed').telegram_id, '700000004');
  await command('/userbot_accounts');
  await click('Selected: managed');
  await command('/uclone -1005555555555');
  const pending = sql.prepare('SELECT * FROM pending_clones WHERE chat_id=?').get('-1005555555555');
  assert.ok(pending, 'manager persists the requested clone');
  const preview = JSON.parse(pending.stats_json);
  assert.equal(preview.stage, 'destination', preview.error);
  assert.equal(preview.snapshot, 12);
  assert.equal(preview.counters.messages, 2);
  assert.equal(sql.prepare('SELECT count(*) n FROM clone_sources WHERE chat_id=?').get(pending.chat_id).n, 0, 'preview copies nothing');
  includeLateMessage = true;
  await click('Personal brain');
  const finished = JSON.parse(sql.prepare('SELECT stats_json FROM pending_clones WHERE id=?').get(pending.id).stats_json);
  assert.equal(finished.stage, 'done', finished.error);
  const managedJob = sql.prepare('SELECT * FROM index_jobs WHERE parent_id=?').get(pending.id);
  assert.equal(managedJob.status, 'done', managedJob.error);
  assert.equal(managedJob.max_id, 12);
  assert.equal(JSON.parse(managedJob.counters_json).messages, 2);
  const managedLinks = sql.prepare('SELECT user_id,url FROM personal_links WHERE transfer_id=?').all(managedJob.id);
  assert.deepEqual(managedLinks.map(row => [row.user_id, row.url]), [['u_managed', 'https://example.com/managed-link']]);
  const managedDocument = sql.prepare('SELECT * FROM uploaded_documents WHERE transfer_id=?').get(managedJob.id);
  assert.equal(managedDocument.scope, 'personal');
  assert.equal(managedDocument.user_id, 'u_managed');
  assert.equal(managedDocument.content, 'managed markdown bytes');
  const managedMedia = sql.prepare("SELECT * FROM clone_sources WHERE transfer_id=? AND content_key='media'").get(managedJob.id);
  assert.equal(readFileSync(managedMedia.storage_path, 'utf8'), 'managed markdown bytes');
  assert.equal(sql.prepare('SELECT count(*) n FROM links WHERE transfer_id=?').get(managedJob.id).n, 0);
  assert.equal(authenticatedClients.length, 1, 'runner uses the verified selected account without starting a replacement');
  console.log('clone runner ingestion tests passed: personal/community/both scopes, topic provenance, media failure continuation, FloodWait retry, boundaries, restart counters, signed manager-to-runner ingestion');
} finally {
  await drain();
  for (const timer of intervals) clearInterval(timer);
  globalThis.setInterval = originalSetInterval;
  for (const accountClient of authenticatedClients) await accountClient.disconnect();
  hooks.deregister();
  delete globalThis[fixtureKey];
  globalThis.fetch = originalFetch;
  rmSync(vaultDir, { recursive: true, force: true });
  sql.close();
}
