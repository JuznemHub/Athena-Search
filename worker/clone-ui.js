const TELEGRAM_LIMIT = 4096;
const TERMINAL_STATUSES = new Set(['done', 'complete', 'completed', 'error', 'failed', 'stopped', 'cancelled', 'canceled']);
const COUNTER_ROWS = [
  ['messages', 'Messages'],
  ['copiedMessages', 'Copied messages'],
  ['links', 'Links'],
  ['files', 'Files'],
  ['pdfs', 'PDF'],
  ['markdown', 'MD'],
  ['json', 'JSON'],
  ['html', 'HTML'],
  ['other', 'Other files'],
  ['images', 'Photos'],
  ['audio', 'Audio'],
  ['skippedVideos', 'Skipped videos'],
  ['duplicates', 'Duplicates'],
  ['failed', 'Failed'],
  ['retries', 'Retries']
];

function escHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function boundedText(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  let end = limit - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end) + '…';
}

function count(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function countText(value, absent = '0') {
  if (value === null || value === undefined) return absent;
  const n = count(value);
  return n === null ? 'unknown' : n.toLocaleString('en-US');
}

// Aligned values make the content and failure counts readable in Telegram's
// native monospace block without unsupported table or rich-body tags.
function counterTable(counters = {}, includeDelivery = true) {
  const rows = includeDelivery ? COUNTER_ROWS : COUNTER_ROWS.filter(([key]) => !['copiedMessages', 'duplicates', 'failed', 'retries'].includes(key));
  return '<pre>' + rows.map(([key, label]) => `${label.padEnd(16)} ${countText(counters?.[key])}`).join('\n') + '</pre>';
}

function sourceLine(sourceName, chatId) {
  const name = boundedText(sourceName, 160);
  const id = boundedText(chatId, 64);
  return 'Source:' + (name ? ` <b>${escHtml(name)}</b>` : '') + (id ? ` <code>${escHtml(id)}</code>` : '');
}

function topicLine(topic, label = 'Topic') {
  const id = boundedText(topic?.id, 64);
  const name = boundedText(topic?.name ?? topic?.title, 120);
  return `${label}:` + (id ? ` <code>#${escHtml(id)}</code>` : '') + (name ? ` ${escHtml(name)}` : '');
}

function progressLine(processed, total) {
  const done = count(processed);
  const available = count(total);
  if (available === null) return `${countText(processed, 'unknown')} messages processed; total unknown`;
  const progress = `${countText(processed, 'unknown')} / ${countText(total)} messages`;
  if (available === 0) return done === 0 ? `${progress} (empty history)` : progress;
  if (done === null || done > available) return progress;
  return `${progress} (${Math.floor(done / available * 100)}%)`;
}

export function renderCloneProgress({ sourceName, chatId, destination, status, topicsTotal = 0, topicsDone = 0, currentTopic = null, processed, total, counters, overallCounters, error }) {
  const state = boundedText(status, 40);
  const terminal = TERMINAL_STATUSES.has(state.toLowerCase());
  const hasTopics = (count(topicsTotal) ?? 0) > 0;
  const lines = [
    `<b>Clone ${terminal ? 'summary' : 'progress'}</b>`,
    sourceLine(sourceName, chatId),
    `Destination: ${escHtml(boundedText(destination, 160))}`,
    `Status: ${escHtml(state || 'unknown')}`
  ];
  if (currentTopic) lines.push(topicLine(currentTopic, terminal ? 'Topic' : 'Current topic'));
  if (!terminal) {
    if (hasTopics && !currentTopic) lines.push('No topic running.');
    else lines.push(progressLine(processed, total));
    lines.push('', `<b>${currentTopic ? 'Current topic' : 'This run'} counters</b>`, counterTable(counters));
  }
  lines.push('', `<b>${terminal ? 'Final aggregate' : 'Overall progress'}</b>`);
  if (hasTopics) lines.push(`Topics completed: ${countText(topicsDone)} / ${countText(topicsTotal)}`);
  if (terminal || hasTopics || overallCounters) lines.push(counterTable(overallCounters ?? counters));
  else lines.push(progressLine(processed, total));
  if (error) lines.push('', `<b>Error:</b> ${escHtml(boundedText(error?.message ?? error, 480))}`);
  return lines.join('\n');
}

export function renderCloneStatistics({ sourceName, chatId, username, members, topic, counters, measurement, complete }) {
  const accessible = measurement === 'accessible-history';
  const lines = ['<b>Clone statistics</b>', sourceLine(sourceName, chatId)];
  if (username) lines.push(`Username: ${escHtml(boundedText(username, 64))}`);
  if (topic) lines.push(topicLine(topic));
  lines.push(`Members (Telegram-reported): ${countText(members, 'unknown')}`);
  if (accessible) {
    lines.push('Measurement: accessible-history');
    lines.push(complete === true
      ? 'Scan complete: exact counts from accessible history.'
      : '<b>Scan incomplete:</b> counts observed so far, not history totals.');
  } else {
    lines.push(`Measurement: ${escHtml(boundedText(measurement, 80) || 'unknown')}`);
    lines.push('<b>History totals unverified.</b> Accessible-history scan not confirmed.');
    if (complete !== true) lines.push('<b>Scan incomplete.</b>');
  }
  lines.push('', counterTable(counters, false));
  return lines.join('\n');
}

export function paginateCloneTopics(topics, page = 0) {
  // Reserve enough header space for any JS array's count/page numbers. Use
  // encoded length here too, so senders that chunk raw HTML cannot split tags.
  const bodyLimit = TELEGRAM_LIMIT - 96;
  const pages = [];
  let items = [];
  let lines = [];
  let length = 0;
  for (const topic of topics) {
    const id = escHtml(topic.id);
    const name = escHtml(boundedText(topic.name ?? topic.title, 96));
    const line = `<code>${id}</code>${name ? ` ${name}` : ''}`;
    if (line.length > bodyLimit) throw new RangeError('Topic ID exceeds Telegram message capacity');
    if (items.length === 100 || length + line.length + 1 > bodyLimit) {
      pages.push({ topics: items, lines });
      items = [];
      lines = [];
      length = 0;
    }
    items.push(topic);
    lines.push(line);
    length += line.length + 1;
  }
  if (items.length || !pages.length) pages.push({ topics: items, lines });
  const requested = Number(page);
  const selected = Math.max(0, Math.min(pages.length - 1, Number.isFinite(requested) ? Math.trunc(requested) : 0));
  const result = pages[selected];
  return {
    page: selected,
    pages: pages.length,
    topics: result.topics,
    text: `<b>Topics</b> (${countText(topics.length)})\nPage ${selected + 1} / ${pages.length}\n` + (result.lines.join('\n') || 'No accessible topics.')
  };
}
