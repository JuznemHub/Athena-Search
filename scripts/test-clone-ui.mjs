import assert from 'node:assert/strict';
import { paginateCloneTopics, renderCloneProgress, renderCloneStatistics } from '../worker/clone-ui.js';

function telegramText(html) {
  const stack = [];
  const plain = html.replace(/<([^>]+)>/g, (_, tag) => {
    assert.match(tag, /^\/?(?:b|i|code|pre)$/, 'Only classic Telegram HTML tags are allowed');
    if (tag.startsWith('/')) assert.equal(stack.pop(), tag.slice(1), 'HTML tags must remain balanced');
    else stack.push(tag);
    return '';
  });
  assert.deepEqual(stack, [], 'No unclosed formatting tags');
  assert.doesNotMatch(plain, /[<>]/, 'External angle brackets must be escaped');
  assert.doesNotMatch(plain, /&(?!(?:amp|lt|gt|quot);)/, 'External ampersands must be escaped');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"' };
  const decoded = plain.replace(/&(amp|lt|gt|quot);/g, (_, name) => entities[name]);
  assert.ok(decoded.length <= 4096, `Telegram message length: ${decoded.length}`);
  assert.doesNotMatch(decoded, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u, 'No split Unicode surrogate pairs');
  return decoded;
}

const source = { sourceName: 'Reading room', chatId: '-1001234567890', destination: 'Community archive' };
const current = {
  messages: 10, copiedMessages: 5, links: 11, files: 6, pdfs: 1, markdown: 2,
  json: 3, html: 4, other: 5, images: 6, audio: 7, skippedVideos: 8,
  duplicates: 9, failed: 2, retries: 3
};
const aggregate = { ...current, messages: 250, copiedMessages: 200, links: 77, files: 44 };
const active = telegramText(renderCloneProgress({
  ...source, status: 'running', topicsTotal: 237, topicsDone: 12,
  currentTopic: { id: '1000000000003', name: 'Current discussion' }, processed: 5, total: 10,
  counters: current, overallCounters: aggregate
}));
assert.match(active, /Current topic: #1000000000003 Current discussion/);
assert.match(active, /5 \/ 10 messages \(50%\)/);
assert.equal((active.match(/\d+%/g) || []).length, 1, 'Only the current topic gets a message percentage');
assert.match(active, /Topics completed: 12 \/ 237/);
const [currentSection, overallSection] = active.split('Overall progress');
assert.match(currentSection, /^Links\s+11$/m);
assert.doesNotMatch(currentSection, /^Links\s+77$/m);
assert.match(overallSection, /^Links\s+77$/m);
assert.doesNotMatch(overallSection, /50%/);
assert.match(active, /Source: Reading room -1001234567890/);
assert.match(active, /Destination: Community archive/);

const unknown = telegramText(renderCloneProgress({
  ...source, status: 'scanning', processed: 13, total: null, counters: { messages: 13 }
}));
assert.match(unknown, /13 messages processed; total unknown/);
assert.doesNotMatch(unknown, /%|13 \/ 0/);
const empty = telegramText(renderCloneProgress({
  ...source, status: 'running', processed: 0, total: 0, counters: {}
}));
assert.match(empty, /0 \/ 0 messages \(empty history\)/);
assert.doesNotMatch(empty, /NaN|Infinity|%/);
for (const label of ['Messages', 'Copied messages', 'Links', 'Files', 'PDF', 'MD', 'JSON', 'HTML', 'Other files', 'Photos', 'Audio', 'Skipped videos', 'Duplicates', 'Failed', 'Retries']) {
  assert.match(empty, new RegExp(`^${label}\\s+0$`, 'm'), `Zero ${label} remains visible`);
}

const finalTopic = telegramText(renderCloneProgress({
  ...source, status: 'done', topicsTotal: 237, topicsDone: 237,
  currentTopic: { id: '1', name: 'General' }, processed: 12345, total: 67890,
  counters: { messages: 999, links: 888 }, overallCounters: aggregate
}));
assert.match(finalTopic, /Topic: #1 General/);
assert.match(finalTopic, /Topics completed: 237 \/ 237/);
assert.match(finalTopic, /^Messages\s+250$/m);
assert.match(finalTopic, /^Copied messages\s+200$/m);
assert.match(finalTopic, /^Links\s+77$/m);
assert.doesNotMatch(finalTopic, /999|888|12,345|67,890|%|Current topic counters/, 'Finished cards cannot leak last-topic or historical totals');

const finalGroup = telegramText(renderCloneProgress({
  ...source, status: 'completed', processed: 3, total: 3,
  counters: { messages: 3, copiedMessages: 2, duplicates: 1, failed: 0 }
}));
assert.match(finalGroup, /^Copied messages\s+2$/m);
assert.match(finalGroup, /^Duplicates\s+1$/m);
assert.match(finalGroup, /^Failed\s+0$/m);
assert.doesNotMatch(finalGroup, /Topics completed|Current topic|total unknown/);

const failed = telegramText(renderCloneProgress({
  ...source, status: 'failed', counters: { failed: 999 },
  overallCounters: { messages: 2, copiedMessages: 0, failed: 2, retries: 4 },
  error: 'Cannot open <private> & retry'
}));
assert.match(failed, /^Failed\s+2$/m);
assert.match(failed, /^Retries\s+4$/m);
assert.match(failed, /^Copied messages\s+0$/m);
assert.match(failed, /Error: Cannot open <private> & retry/);
assert.doesNotMatch(failed, /999/);

const hostile = '<b>Untrusted</b> & "title" <script>bad</script>';
const hostileHtml = renderCloneProgress({
  sourceName: hostile, chatId: '<chat>', destination: hostile, status: '<running>',
  currentTopic: { id: '<topic>', name: hostile }, counters: current,
  processed: 2, total: null, error: hostile
});
const hostileOutput = telegramText(hostileHtml);
assert.match(hostileHtml, /&lt;script&gt;bad&lt;\/script&gt;/);
assert.ok(hostileOutput.includes(hostile), 'Escaping must not remove or double-escape the supplied name');
assert.match(hostileOutput, /<chat>/);
assert.match(hostileOutput, /#<topic>/);
const longName = 'A𐐀<&"'.repeat(10000);
telegramText(renderCloneProgress({
  sourceName: longName, chatId: longName, destination: longName, status: longName,
  topicsTotal: 237, topicsDone: 100, currentTopic: { id: longName, name: longName },
  counters: Object.fromEntries(Object.keys(current).map(key => [key, Number.MAX_SAFE_INTEGER])),
  overallCounters: Object.fromEntries(Object.keys(current).map(key => [key, Number.MAX_SAFE_INTEGER])),
  processed: Number.MAX_SAFE_INTEGER, total: null, error: longName
}));

const stats = telegramText(renderCloneStatistics({
  ...source, username: '@reading', members: 451, counters: current,
  topic: { id: '1', name: 'General' }, measurement: 'accessible-history', complete: true
}));
assert.match(stats, /Members \(Telegram-reported\): 451/);
assert.match(stats, /Measurement: accessible-history/);
assert.match(stats, /Scan complete: exact counts from accessible history/);
assert.match(stats, /^Messages\s+10$/m);
assert.match(stats, /^Links\s+11$/m);
assert.match(stats, /Topic: #1 General/);
assert.doesNotMatch(stats, /Copied messages|Duplicates/, 'History measurements are not copy outcomes');
const incomplete = telegramText(renderCloneStatistics({
  ...source, members: null, counters: { messages: 3, links: 2 },
  measurement: 'accessible-history', complete: false
}));
assert.match(incomplete, /Members \(Telegram-reported\): unknown/);
assert.match(incomplete, /Scan incomplete: counts observed so far, not history totals/);
assert.doesNotMatch(incomplete, /Scan complete:|exact counts/);
const unverified = telegramText(renderCloneStatistics({
  sourceName: longName, chatId: '<chat>', username: hostile, members: 0,
  topic: { id: '1', name: longName }, counters: {}, measurement: '<sample>', complete: true
}));
assert.match(unverified, /Members \(Telegram-reported\): 0/);
assert.match(unverified, /History totals unverified/);
assert.doesNotMatch(unverified, /exact counts/);

const shortTopics = Array.from({ length: 237 }, (_, i) => ({ id: String(i + 1), name: `Topic ${i + 1}` }));
const first = paginateCloneTopics(shortTopics);
assert.equal(first.topics.length, 100, 'Short topic names use the allowed page capacity');
assert.equal(first.pages, 3);
const shortCoverage = [];
for (let page = 0; page < first.pages; page++) {
  const result = paginateCloneTopics(shortTopics, page);
  telegramText(result.text);
  assert.equal(result.page, page);
  assert.equal(result.pages, first.pages);
  shortCoverage.push(...result.topics);
}
assert.deepEqual(shortCoverage, shortTopics, 'Forward navigation must cover all 237 topics exactly once, in order');
const longTopics = shortTopics.map((topic, i) => ({ ...topic, id: `100000000000000000${i}`, name: longName }));
const longFirst = paginateCloneTopics(longTopics);
assert.ok(longFirst.topics.length < 100, 'Long names must dynamically reduce page size');
const all = [];
for (let page = 0; page < longFirst.pages; page++) {
  const result = paginateCloneTopics(longTopics, page);
  const decoded = telegramText(result.text);
  assert.ok(result.topics.length <= 100);
  assert.ok(result.text.length <= 4096, 'Raw HTML also fits senders that chunk before parsing');
  assert.equal(result.pages, longFirst.pages);
  assert.deepEqual(result, paginateCloneTopics(longTopics, page), 'Page boundaries are stable');
  for (const topic of result.topics) assert.ok(decoded.includes(topic.id), 'Every full topic ID is displayed');
  all.push(...result.topics);
}
assert.deepEqual(all, longTopics, 'Dynamic pagination must never lose, duplicate, truncate or reorder topic IDs');
const back = [];
for (let page = longFirst.pages - 1; page >= 0; page--) back.unshift(...paginateCloneTopics(longTopics, page).topics);
assert.deepEqual(back, longTopics, 'Backward navigation uses the same boundaries');
assert.equal(paginateCloneTopics(longTopics, -1).page, 0);
assert.equal(paginateCloneTopics(longTopics, 9999).page, longFirst.pages - 1);
const hostileTopicPage = paginateCloneTopics([{ id: '<id>', name: hostile }]);
assert.ok(telegramText(hostileTopicPage.text).includes(`<id> ${hostile}`));
const emptyTopics = paginateCloneTopics([], 7);
assert.equal(emptyTopics.page, 0);
assert.equal(emptyTopics.pages, 1);
assert.deepEqual(emptyTopics.topics, []);
assert.match(telegramText(emptyTopics.text), /No accessible topics/);

console.log('Clone UI consumer-output fixtures passed.');
