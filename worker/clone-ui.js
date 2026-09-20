const TELEGRAM_LIMIT = 4096;
const TERMINAL_STATUSES = new Set(['done', 'complete', 'completed', 'error', 'failed', 'stopped', 'cancelled', 'canceled']);
const COUNTER_ROWS = [
  ['messages', 'Encountered messages'], ['linkPosts', 'Encountered link posts'], ['links', 'Encountered URLs'],
  ['files', 'Encountered files'], ['pdfs', 'PDF'], ['markdown', 'MD'], ['json', 'JSON'], ['html', 'HTML'],
  ['other', 'Other files'], ['images', 'Images'], ['audio', 'Audio'], ['skippedVideos', 'Videos excluded'],
];
const SAVED_ROWS = [
  ['copiedMessages', 'Copied messages'], ['savedLinkPosts', 'Saved link posts'], ['savedLinks', 'Saved URLs'],
  ['savedFiles', 'Saved files'], ['savedDocs', 'Saved documents'], ['savedPdfs', 'Saved PDF'], ['savedMarkdown', 'Saved MD'],
  ['savedJson', 'Saved JSON'], ['savedHtml', 'Saved HTML'], ['savedOther', 'Saved other files'],
  ['savedImages', 'Saved images'], ['savedAudio', 'Saved audio'], ['duplicates', 'Duplicates'], ['failed', 'Failed'], ['retries', 'Retries'],
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

function counterTable(counters = {}, includeDelivery = true) {
  const rows = includeDelivery ? [...SAVED_ROWS, ...COUNTER_ROWS.slice(0, 4), COUNTER_ROWS.at(-1)] : COUNTER_ROWS;
  return '<table>' + rows.map(([key, label]) => `<tr><td>${label}</td><td>${countText(counters?.[key])}</td></tr>`).join('') + '</table>';
}

function sourceLine(sourceName, chatId) {
  const name = boundedText(sourceName, 160);
  const id = boundedText(chatId, 64);
  const url = /^-100\d+$/.test(id) ? `https://t.me/c/${id.slice(4)}/1` : /^@\w+$/.test(id) ? `https://t.me/${id.slice(1)}` : null;
  const title = escHtml(name || id);
  return 'Source:' + (title ? ` ${url ? `<a href="${url}">${title}</a>` : `<b>${title}</b>`}` : '') + (id ? ` <code>${escHtml(id)}</code>` : '');
}

function topicLine(topic, label = 'Topic') {
  const id = boundedText(topic?.id, 64);
  const name = boundedText(topic?.name ?? topic?.title, 120);
  return `${label}:` + (id ? ` <code>#${escHtml(id)}</code>` : '') + (name ? ` ${escHtml(name)}` : '');
}

function progressLine(processed, total, unit = 'messages') {
  const done = count(processed);
  const available = count(total);
  if (available === null) return `${countText(processed, 'unknown')} ${unit} processed; total unknown`;
  const progress = `${countText(processed, 'unknown')} / ${countText(total)} ${unit}`;
  if (available === 0) return done === 0 ? `${progress} (empty history)` : progress;
  if (done === null || done > available) return progress;
  const percent = Math.floor(done / available * 100);
  const blocks = Math.floor(percent / 10);
  return `${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${percent}%<br>${progress}`;
}

export function renderCloneProgress({ sourceName, chatId, destination, target, status, topicsTotal = 0, topicsDone = 0, currentTopic = null, processed, total, counters = {}, overallCounters, error }) {
  const state = boundedText(status, 80);
  const terminal = TERMINAL_STATUSES.has(state.toLowerCase());
  const completed = ['done', 'complete', 'completed'].includes(state.toLowerCase());
  const hasTopics = (count(topicsTotal) ?? 0) > 0;
  const lines = [`<h3>Clone ${terminal ? 'summary' : 'progress'}</h3>`, `<p>${sourceLine(sourceName, chatId)}<br>Destination: ${escHtml(boundedText(destination, 160))}<br>Status: ${escHtml(state || 'unknown')}</p>`];
  if (target === 'both') lines.push('<p>Saved URLs/files, duplicates and failures: per destination (two sinks). Copied messages and saved link posts: once per source message.</p>');
  if (!terminal) {
    if (currentTopic) lines.push(`<h4>${topicLine(currentTopic, 'Current topic')}</h4>`);
    lines.push(`<p>${hasTopics && !currentTopic ? 'No topic running.' : progressLine(processed, total)}</p>`, counterTable(counters));
  }
  if (terminal || hasTopics || overallCounters) {
    lines.push(`<h4>${terminal ? 'Final aggregate' : 'Overall progress'}</h4>`);
    if (hasTopics) lines.push(`<p>Topics completed: ${countText(topicsDone)} / ${countText(topicsTotal)}<br>${progressLine(topicsDone, topicsTotal, 'topics')}</p>`);
    else if (completed) lines.push('<p>██████████ 100%</p>');
    lines.push(counterTable(overallCounters ?? counters));
  }
  const failures = (overallCounters ?? counters)?.errorCategories;
  if (failures && Object.keys(failures).length) lines.push(`<p>Error categories: ${Object.entries(failures).map(([category, n]) => `${escHtml(boundedText(category, 40))}: ${countText(n)}`).join(' · ')}</p>`);
  if (error) lines.push(`<p><b>Error:</b> ${escHtml(boundedText(error?.message ?? error, 480))}</p>`);
  return lines.join('\n');
}

export function renderCloneStatistics({ sourceName, chatId, username, members, topic, counters, measurement, complete }) {
  const accessible = measurement === 'accessible-history';
  const lines = ['<h3>Clone statistics</h3>', `<p>${sourceLine(sourceName, chatId)}</p>`];
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
