import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { classifyCloneMessage, countCloneMessage, documentCounter, emptyCloneCounters, scanCloneHistory, sourceClonePost } from '../worker/clone-content.js';

// Exercise the actual authenticated webhook, with SQL executed by SQLite and
// only the external Bot API replaced. No saved Telegram account is contacted.
const sqlite = new DatabaseSync(':memory:');
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
sqlite.exec(schema.replace(/^CREATE EXTENSION[^;]*;/gm, '').replace(/^CREATE INDEX[^;]*USING gin[^;]*;/gm, ''));
sqlite.prepare('INSERT INTO users (id, username, provider, provider_id, telegram_api_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run('u_fixture', 'fixture', 'telegram', '123456789', '123456789', Date.now());
const DB = {
  prepare(sql) {
    const statement = (params = []) => ({
      bind(...values) { return statement(values.map(v => v ?? null)); },
      async run() { const r = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
      async first(column) { const r = sqlite.prepare(sql).get(...params); return r ? (column ? r[column] : r) : null; },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; }
    });
    return statement();
  }
};
const sent = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  assert.equal(url.hostname, 'api.telegram.org', 'fixture must not access other external services');
  const method = url.pathname.split('/').at(-1);
  const body = JSON.parse(init.body || '{}');
  sent.push({ method, body });
  return Response.json({ ok: true, result: { message_id: sent.length, id: 42, is_bot: true, username: 'FixtureBot' } });
};
const env = { DB, ATHENA_RUNTIME: 'selfhost', TELEGRAM_BOT_TOKEN: '123:fixture', TELEGRAM_WEBHOOK_SECRET: 'fixture-secret', TG_OWNER_IDS: '123456789' };
const update = { update_id: 74001, message: { message_id: 74001, chat: { id: 123456789, type: 'private' }, from: { id: 123456789, first_name: 'Fixture' }, text: '/uclone -1001234567890' } };
function request(secret) {
  return new Request('https://fixture.invalid/api/telegram-webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body: JSON.stringify(update) });
}
try {
  const rejected = await worker.fetch(request(), env, { waitUntil() {} });
  assert.equal(rejected.status, 403, 'unsigned /uclone must not bypass webhook verification');
  assert.equal(sent.length, 0, 'unsigned request cannot send Telegram replies');
  const accepted = await worker.fetch(request('fixture-secret'), env, { waitUntil() {} });
  assert.equal(accepted.status, 200);
  const replies = sent.filter(x => /sendMessage|sendRichMessage/.test(x.method)).map(x => x.body.text || x.body.rich_message?.html || '').join('\n');
  assert.match(replies, /userbot.*(?:account|add)|account.*(?:connect|saved)/i, 'authenticated /uclone reaches account prerequisite instead of the shim community requirement');
  assert.doesNotMatch(replies, /Unknown command|No community is configured/i);
  const before = sent.length;
  await worker.fetch(request('fixture-secret'), env, { waitUntil() {} });
  assert.equal(sent.length, before, 'redelivery does not send another clone reply');
  console.log('clone webhook routing tests passed');
} finally {
  globalThis.fetch = originalFetch;
  sqlite.close();
}

const attr = (className, fields = {}) => ({ className, ...fields });
const documentMessage = (id, filename, mimeType, attributes = [], text = '') => ({
  className: 'Message', id, message: text,
  media: { className: 'MessageMediaDocument', document: {
    className: 'Document', size: 1024n, mimeType,
    attributes: [attr('DocumentAttributeFilename', { fileName: filename }), ...attributes]
  } }
});
const photoMessage = (id) => ({ className: 'Message', id, groupedId: 500n, media: {
  className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ size: 20 }, { sizes: [100, 200] }] }
} });

const linked = documentMessage(10, 'report.pdf', 'application/pdf', [], '😀 docs.example/path and https://example.org/a_(b).');
linked.entities = [
  attr('MessageEntityUrl', { offset: 3, length: 'docs.example/path'.length }),
  attr('MessageEntityTextUrl', { offset: 3, length: 4, url: 'https://hidden.example/' })
];
linked.caption = 'Another https://caption.example/ and https://hidden.example/';
linked.replyMarkup = { rows: [{ buttons: [
  attr('KeyboardButtonUrl', { url: 'https://hidden.example/' }),
  attr('KeyboardButtonUrl', { url: 'https://button.example/' })
] }] };
assert.deepEqual(new Set(classifyCloneMessage(linked).urls), new Set([
  'docs.example/path', 'https://example.org/a_(b)', 'https://hidden.example/',
  'https://caption.example/', 'https://button.example/'
]));
const typedUrl = 'https://example.org/exact.';
assert.deepEqual(classifyCloneMessage({ message: typedUrl, entities: [attr('MessageEntityUrl', { offset: 0, length: typedUrl.length })] }).urls, [typedUrl]);

// Bot API MessageEntity offsets and lengths are UTF-16 code units, as are TL
// MessageEntityTextUrl offsets. Neither hidden labels nor captions are snippets.
const hiddenText = '😀 First Second Third Fourth';
const hiddenEntities = ['First', 'Second', 'Third', 'Fourth'].map((label, index) => ({
  type: 'text_link', offset: hiddenText.indexOf(label), length: label.length, url: `https://hidden.example/${index}`
}));
const fourHidden = { message_id: 31, text: hiddenText, entities: hiddenEntities };
const sixRawUrls = Array.from({ length: 6 }, (_, index) => `https://raw.example/${index}`);
const sixRaw = { message_id: 32, text: sixRawUrls.join('\n') };
const mixedText = `${hiddenText}\n${sixRaw.text}`;
const mixed = { message_id: 33, text: mixedText, entities: hiddenEntities };
assert.deepEqual(classifyCloneMessage(fourHidden).urls, hiddenEntities.map(entity => entity.url));
assert.deepEqual(classifyCloneMessage(sixRaw).urls, sixRawUrls);
assert.deepEqual(new Set(classifyCloneMessage(mixed).urls), new Set([...hiddenEntities.map(entity => entity.url), ...sixRawUrls]));
assert.deepEqual(classifyCloneMessage(fourHidden).occurrences[0], {
  url: hiddenEntities[0].url, type: 'text_link', label: 'First', offset: 3, length: 5, field: 'text'
});
const captionPost = { message_id: 34, message_thread_id: 30, caption: `  ${hiddenText}\n`,
  caption_entities: hiddenEntities.map(entity => ({ ...entity, offset: entity.offset + 2 })),
  document: { file_id: 'caption-file', file_unique_id: 'caption-unique', file_name: 'paper.pdf', mime_type: 'application/pdf', file_size: 2048 },
  reply_to_message: { message_id: 29, text: 'The full original reply' }
};
assert.equal(classifyCloneMessage(captionPost).topicId, '30');
assert.deepEqual(classifyCloneMessage(captionPost).occurrences[0], {
  url: hiddenEntities[0].url, type: 'text_link', label: 'First', offset: 5, length: 5, field: 'caption'
});
assert.deepEqual(sourceClonePost(captionPost), { text: captionPost.caption, message: captionPost });
const repeatedUrl = 'https://repeated.example/';
const repeated = { text: `${repeatedUrl} then ${repeatedUrl}`, entities: [{ type: 'url', offset: 0, length: repeatedUrl.length }],
  reply_markup: { inline_keyboard: [[{ text: 'Open again', url: repeatedUrl }, { text: 'Other place', url: repeatedUrl }]] }
};
const repeatClass = classifyCloneMessage(repeated);
assert.deepEqual(repeatClass.urls, [repeatedUrl]);
assert.deepEqual(repeatClass.occurrences.map(({ type, offset, field }) => ({ type, offset, field })), [
  { type: 'url', offset: 0, field: 'text' },
  { type: 'raw', offset: repeatedUrl.length + 6, field: 'text' },
  { type: 'url', offset: null, field: 'reply_markup.inline_keyboard[0][0]' },
  { type: 'url', offset: null, field: 'reply_markup.inline_keyboard[0][1]' }
]);
const postCounters = emptyCloneCounters();
for (const post of [fourHidden, sixRaw, mixed, repeated, { text: 'No link' }]) countCloneMessage(postCounters, post);
assert.equal(postCounters.linkPosts, 4);
assert.equal(postCounters.links, 21);

const tlSource = new Api.Message({ id: 35, date: 1_800_000_000, message: `  ${hiddenText}\n${'Full original body. '.repeat(1000)}\n`,
  peerId: new Api.PeerChannel({ channelId: bigInt('9007199254740993') }),
  groupedId: 9007199254740995n,
  entities: hiddenEntities.map(({ offset, length, url }) => new Api.MessageEntityTextUrl({ offset: offset + 2, length, url })),
  replyTo: new Api.MessageReplyHeader({ replyToMsgId: 29, forumTopic: true, replyToTopId: 30 }),
  media: new Api.MessageMediaDocument({ document: new Api.Document({
    id: bigInt('9007199254740997'), accessHash: 9007199254740999n, fileReference: Buffer.from([1, 2, 3]),
    date: 1_800_000_000, mimeType: 'application/pdf', size: 1024n, dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName: 'paper.pdf' })]
  }) })
});
const tlPost = sourceClonePost(tlSource);
assert.equal(tlPost.text, tlSource.message);
assert.equal(tlPost.message.message, tlSource.message);
assert.equal(tlPost.message.peerId.channelId, '9007199254740993');
assert.equal(tlPost.message.groupedId, '9007199254740995');
assert.equal(tlPost.message.media.document.accessHash, '9007199254740999');
assert.equal(tlPost.message.media.document.attributes[0].fileName, 'paper.pdf');
assert.equal(tlPost.message.replyTo.replyToTopId, 30);
assert.equal(tlPost.message.entities[0].url, hiddenEntities[0].url);
assert.deepEqual(classifyCloneMessage(tlSource), classifyCloneMessage(tlPost.message));

class DocumentAttributeVideo {}
class DocumentAttributeAudio {}
const disguisedVideo = documentMessage(11, 'report.pdf', 'application/pdf', [new DocumentAttributeVideo()]);
assert.equal(classifyCloneMessage(disguisedVideo).media.kind, 'video');
assert.equal(classifyCloneMessage(documentMessage(12, 'notes.md', 'video/mp4')).media.kind, 'video');
assert.equal(classifyCloneMessage(documentMessage(13, 'notes.pdf', 'application/pdf', [new DocumentAttributeAudio()])).media.kind, 'audio');
assert.equal(classifyCloneMessage(documentMessage(14, 'movie.MKV', 'application/octet-stream')).media.kind, 'video');
assert.equal(classifyCloneMessage(documentMessage(15, 'notes.pdf', 'image/png')).media.kind, 'photo');
assert.deepEqual(classifyCloneMessage(documentMessage(16, 'bundle.tar.gz', 'application/gzip')).media,
  { kind: 'document', filename: 'bundle.tar.gz', ext: 'gz', mime: 'application/gzip', size: 1024 });
assert.equal(classifyCloneMessage(photoMessage(17)).media.size, 200);
assert.equal(classifyCloneMessage({ id: 18, media: { className: 'MessageMediaWebPage', webpage: { document: disguisedVideo.media.document } } }).media, null);

const botFile = (fields = {}) => ({ file_id: 'file', file_unique_id: 'unique-file', file_size: 1024, ...fields });
for (const [message, kind] of [
  [{ document: botFile({ file_name: 'misleading.mp4', mime_type: 'application/pdf' }) }, 'document'],
  [{ document: botFile({ file_name: 'notes.pdf', mime_type: 'video/mp4' }) }, 'video'],
  [{ video: botFile({ file_name: 'notes.pdf', mime_type: 'application/pdf', width: 10, height: 10, duration: 1 }) }, 'video'],
  [{ video_note: botFile({ length: 10, duration: 1 }) }, 'video'],
  [{ audio: botFile({ file_name: 'notes.pdf', mime_type: 'application/pdf', duration: 1 }) }, 'audio'],
  [{ voice: botFile({ mime_type: 'audio/ogg', duration: 1 }) }, 'audio'],
  [{ animation: botFile({ mime_type: 'video/mp4', width: 10, height: 10, duration: 1 }), document: botFile({ mime_type: 'video/mp4' }) }, 'video'],
  [{ animation: botFile({ mime_type: 'image/gif', width: 10, height: 10, duration: 1 }), document: botFile({ mime_type: 'image/gif' }) }, 'photo'],
  [{ sticker: botFile({ type: 'regular', width: 10, height: 10, is_video: true, is_animated: false }) }, 'video'],
  [{ sticker: botFile({ type: 'regular', width: 10, height: 10, is_video: false, is_animated: true }) }, 'document'],
  [{ sticker: botFile({ type: 'regular', width: 10, height: 10, is_video: false, is_animated: false }) }, 'photo'],
  [{ document: botFile({ mime_type: 'application/pdf', thumbnail: botFile({ width: 10, height: 10 }) }) }, 'document']
]) {
  assert.equal(classifyCloneMessage(message).media.kind, kind);
  const counters = emptyCloneCounters();
  countCloneMessage(counters, message);
  assert.equal(counters.files, kind === 'video' ? 0 : 1);
  assert.equal(counters.skippedVideos, kind === 'video' ? 1 : 0);
}
assert.equal(classifyCloneMessage({ photo: [botFile({ width: 10, height: 10, file_size: 100 }), botFile({ width: 20, height: 20, file_size: 500 })] }).media.size, 500);
assert.equal(documentCounter(classifyCloneMessage(captionPost).media), 'pdfs');
assert.equal(classifyCloneMessage(documentMessage(36, 'animation.gif', 'image/gif', [attr('DocumentAttributeAnimated')])).media.kind, 'photo');
assert.equal(classifyCloneMessage(documentMessage(37, 'sticker.tgs', 'application/x-tgsticker', [attr('DocumentAttributeSticker')])).media.kind, 'document');
assert.equal(classifyCloneMessage(documentMessage(38, 'circle.pdf', 'application/pdf', [attr('DocumentAttributeVideo', { roundMessage: true })])).media.kind, 'video');

const counted = emptyCloneCounters();
for (const message of [
  linked, disguisedVideo, photoMessage(19), documentMessage(20, 'voice.ogg', 'audio/ogg'),
  documentMessage(21, 'notes.markdown', 'text/plain'), documentMessage(22, 'data.bin', 'application/json'),
  documentMessage(23, 'page.bin', 'text/html'), documentMessage(24, 'archive.zip', 'application/zip'),
  { className: 'MessageService', id: 25, action: attr('MessageActionPinMessage'), replyTo: { replyToMsgId: 10 } },
  { className: 'MessageEmpty', id: 26 },
]) countCloneMessage(counted, message);
assert.deepEqual(counted, { messages: 8, links: 5, linkPosts: 1, files: 7, pdfs: 1, markdown: 1, json: 1, html: 1, other: 1, images: 1, audio: 1, skippedVideos: 1 });
assert.equal(classifyCloneMessage({ replyTo: { replyToMsgId: 99 } }).topicId, null, 'ordinary replies are not forum topics');
assert.equal(classifyCloneMessage({ replyTo: { forumTopic: true, replyToTopId: 30, replyToMsgId: 99 } }).topicId, '30');
assert.equal(classifyCloneMessage({ replyTo: { forumTopic: true, replyToMsgId: 30 } }).topicId, '30');
assert.equal(classifyCloneMessage({ replyTo: { forumTopic: true, replyToMsgId: 1 } }).topicId, '1');
assert.equal(classifyCloneMessage({ id: 30, action: attr('MessageActionTopicCreate') }).topicId, '30');

// Generate each page on demand rather than materializing history or retaining
// progress frames. A hard 100k scan cap or an ever-growing page request fails.
let streamRequests = 0;
let streamProgress = 0;
let lastMeasured = 0;
const streamed = await scanCloneHistory({ async getMessages(_chat, options) {
  assert.ok(options.limit <= 100);
  streamRequests++;
  const high = options.offsetId ? options.offsetId - 1 : 100_123;
  return Array.from({ length: Math.min(options.limit, high) }, (_, index) => ({ id: high - index, message: '' }));
} }, '-100fixture', { onProgress(frame) {
  assert.ok(frame.counters.messages >= lastMeasured);
  if (frame.complete) assert.equal(frame.counters.messages, 100_123);
  lastMeasured = frame.counters.messages;
  streamProgress++;
} });
assert.equal(streamed.counters.messages, 100_123);
assert.equal(streamed.maxId, 100_123);
assert.equal(streamed.measurement, 'accessible-history');
assert.equal(streamed.complete, true);
assert.ok(streamRequests > 1000);
assert.ok(streamProgress > streamRequests);

let pageIndex = 0;
const offsets = [];
const progressCopies = [];
const paged = await scanCloneHistory({ async getMessages(_chat, options) {
  offsets.push(options.offsetId);
  return [
    [photoMessage(9), photoMessage(8), photoMessage(8)],
    [photoMessage(8), { className: 'MessageService', id: 7, action: attr('MessageActionPinMessage'), replyTo: { replyToMsgId: 9 } }, photoMessage(6)],
    [{ className: 'MessageEmpty', id: 5 }], []
  ][pageIndex++];
} }, '-100fixture', { maxId: 9, onProgress(frame) { progressCopies.push(frame); } });
assert.deepEqual(offsets, [10, 8, 6, 5]);
assert.equal(paged.counters.messages, 3);
assert.equal(paged.counters.images, 3, 'album members are distinct files, repeated page members are not');
assert.equal(progressCopies[0].counters.messages, 0, 'progress snapshots are not mutated later');
assert.equal(progressCopies.filter(x => x.complete).length, 1);
assert.equal(progressCopies.at(-1).complete, true);

const forumHistory = [
  { id: 60, message: 'general top-level' },
  { id: 59, message: 'general reply', replyTo: { replyToMsgId: 60 } },
  { id: 58, message: 'topic root reply', replyTo: { forumTopic: true, replyToMsgId: 30 } },
  { id: 57, message: 'nested topic reply', replyTo: { forumTopic: true, replyToTopId: 30, replyToMsgId: 58 } },
  { id: 56, message: 'explicit general', replyTo: { forumTopic: true, replyToTopId: 1, replyToMsgId: 59 } },
  { id: 55, message: 'another topic', replyTo: { forumTopic: true, replyToMsgId: 40 } },
];
for (const [threadId, expected] of [[1, 3], [30, 2]]) {
  const result = await scanCloneHistory({ async getMessages(_chat, options) {
    if (threadId === 1) assert.equal(options.replyTo, undefined, 'General is not GetReplies(1)');
    else assert.equal(options.replyTo, 30);
    // Intentionally return off-topic records: strict filtering remains local.
    return forumHistory.filter(x => !options.offsetId || x.id < options.offsetId);
  } }, '-100fixture', { threadId });
  assert.equal(result.counters.messages, expected);
}

let attempts = 0;
let gates = 0;
let floodReported = false;
const flooded = await scanCloneHistory({ async getMessages(_chat, options) {
  attempts++;
  if (attempts === 1) throw Object.assign(new Error('FLOOD_WAIT_0'), { seconds: 0 });
  assert.ok(floodReported, 'FloodWait callback is awaited before retrying the same page');
  if (attempts === 2) { assert.equal(options.offsetId, 0); return [{ id: 4, message: 'available' }]; }
  assert.equal(options.offsetId, 4);
  return [];
} }, '-100fixture', {
  beforeRequest() { gates++; },
  async onFlood(seconds) { assert.equal(seconds, 0); await Promise.resolve(); floodReported = true; }
});
assert.equal(flooded.counters.messages, 1);
assert.equal(gates, 3);

for (const [upstream, expected] of [
  ['CHANNEL_PRIVATE session-secret', 'CLONE_HISTORY_UNAVAILABLE'],
  ['AUTH_KEY_UNREGISTERED session-secret', 'CLONE_SESSION_UNAVAILABLE'],
  ['OTHER session-secret', 'CLONE_HISTORY_FAILED']
]) {
  let complete = false;
  await assert.rejects(scanCloneHistory({ async getMessages() { throw new Error(upstream); } }, '-100fixture', {
    onProgress(frame) { complete ||= frame.complete; }
  }), error => error.code === expected && !error.message.includes('session-secret'));
  assert.equal(complete, false);
}
let networkAttempts = 0;
await assert.rejects(scanCloneHistory({ async getMessages() {
  networkAttempts++;
  throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
} }, '-100fixture'), { code: 'CLONE_HISTORY_FAILED' });
assert.equal(networkAttempts, 4, 'network failures have a bounded retry budget');
await assert.rejects(scanCloneHistory({ async getMessages() { return [{ id: 5 }]; } }, '-100fixture'), { code: 'CLONE_PAGINATION_STALLED' });
await assert.rejects(scanCloneHistory({ async getMessages() { return undefined; } }, '-100fixture'), { code: 'CLONE_HISTORY_FAILED' });
const controller = new AbortController();
let abortedComplete = false;
await assert.rejects(scanCloneHistory({ async getMessages() { controller.abort(); return [{ id: 5 }]; } }, '-100fixture', {
  signal: controller.signal, onProgress(frame) { abortedComplete ||= frame.complete; }
}), { name: 'AbortError', code: 'CLONE_ABORTED' });
assert.equal(abortedComplete, false);
console.log('clone classification and accessible-history scanner tests passed');
