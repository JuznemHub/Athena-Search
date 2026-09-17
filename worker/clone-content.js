const PAGE_SIZE = 100;
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'mpeg', 'mpg', '3gp', 'ts', 'wmv', 'flv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aiff', 'wma']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'bmp', 'tif', 'tiff', 'svg']);

function className(value) {
  return value?.className || value?.constructor?.name || '';
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function topicOf(message) {
  const thread = positiveId(message?.message_thread_id);
  if (thread) return String(thread);
  const reply = message?.replyTo;
  const top = positiveId(reply?.replyToTopId);
  if (top) return String(top);
  if (reply?.forumTopic || message?.forumTopic) {
    return String(positiveId(reply?.replyToMsgId) || 1);
  }
  if (className(message?.action) === 'MessageActionTopicCreate') {
    const id = positiveId(message?.id);
    return id ? String(id) : null;
  }
  // General messages often have no reply header. Only a caller that already
  // knows this is a forum can interpret null as General, rather than a chat.
  return null;
}

function isContentMessage(message) {
  return !!message && !['MessageEmpty', 'MessageService'].includes(className(message)) && !message.action;
}

function textUrls(text, entities, urls, occurrences, field) {
  const covered = [];
  for (const entity of entities || []) {
    const type = entity.type || className(entity);
    const start = Number(entity.offset);
    const length = Number(entity.length);
    const end = start + length;
    const valid = Number.isInteger(start) && Number.isInteger(length) && start >= 0 && end > start && end <= text.length;
    const hidden = type === 'MessageEntityTextUrl' || type === 'text_link';
    const visible = type === 'MessageEntityUrl' || type === 'url';
    const url = hidden && entity.url ? String(entity.url) : visible && valid ? text.slice(start, end) : '';
    if (url) {
      urls.add(url);
      occurrences.push({ url, type, label: valid ? text.slice(start, end) : '', offset: valid ? start : null, length: valid ? length : null, field });
      if (visible && valid) covered.push([start, end]);
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"\u0000-\u001f]+/gi)) {
    if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    let url = match[0].replace(/[.,!?;:'”’]+$/, '');
    // Keep balanced parentheses inside a URL, but not prose wrappers.
    for (;;) {
      const closing = url.at(-1);
      const opening = { ')': '(', ']': '[', '}': '{' }[closing];
      if (!opening || url.split(closing).length <= url.split(opening).length) break;
      url = url.slice(0, -1).replace(/[.,!?;:'”’]+$/, '');
    }
    if (url) {
      urls.add(url);
      occurrences.push({ url, type: 'raw', label: url, offset: match.index, length: url.length, field });
    }
  }
}

/** GramJS toJSON exposes protocol args rather than its client/session caches.
 * Native BigInt and GramJS big-integer values remain exact decimal strings. */
export function sourceClonePost(message) {
  const text = String(message?.message || message?.text || message?.caption || '');
  const original = JSON.parse(JSON.stringify(message ?? null, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  return { text, message: original };
}

function classifyDocument(document, forcedKind = '', fallbackMime = '') {
  const attributes = document.attributes || [];
  const filename = String(document.file_name || attributes.find((a) => className(a) === 'DocumentAttributeFilename')?.fileName || '');
  const ext = /\.([^.\\/]+)$/.exec(filename)?.[1]?.toLowerCase() || '';
  const mime = String(document.mimeType || document.mime_type || fallbackMime).split(';', 1)[0].trim().toLowerCase();
  const generic = GENERIC_MIMES.has(mime);
  const video = forcedKind === 'video' || attributes.some((a) => className(a) === 'DocumentAttributeVideo') || mime.startsWith('video/');
  const audio = forcedKind === 'audio' || attributes.some((a) => className(a) === 'DocumentAttributeAudio') || mime.startsWith('audio/');
  const kind = video ? 'video' : audio ? 'audio' : forcedKind === 'photo' || mime.startsWith('image/') ? 'photo'
    : generic && VIDEO_EXTENSIONS.has(ext) ? 'video'
      : generic && AUDIO_EXTENSIONS.has(ext) ? 'audio'
        : generic && IMAGE_EXTENSIONS.has(ext) ? 'photo' : 'document';
  return { kind, filename, ext, mime, size: Math.max(0, Number(document.size ?? document.file_size) || 0) };
}

/** Classify original media only: web previews, thumbnails and pinned references
 * are not additional files. Attributes and MIME beat a misleading filename. */
export function classifyCloneMessage(message) {
  const topicId = topicOf(message);
  if (!isContentMessage(message)) return { urls: [], occurrences: [], media: null, topicId };
  const urls = new Set();
  const occurrences = [];
  const field = message.message ? 'message' : 'text';
  textUrls(String(message.message || message.text || ''), message.entities, urls, occurrences, field);
  if (message.caption != null) {
    textUrls(String(message.caption), message.captionEntities || message.caption_entities, urls, occurrences, 'caption');
  }
  const gramRows = message.replyMarkup?.rows;
  const rows = gramRows || message.reply_markup?.inline_keyboard || [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const [buttonIndex, button] of (gramRows ? row.buttons || [] : row).entries()) {
      if (!button.url) continue;
      const url = String(button.url);
      urls.add(url);
      occurrences.push({ url, type: gramRows ? className(button) : 'url', label: String(button.text || ''), offset: null, length: null,
        field: gramRows ? `replyMarkup.rows[${rowIndex}].buttons[${buttonIndex}]` : `reply_markup.inline_keyboard[${rowIndex}][${buttonIndex}]` });
    }
  }
  let media = null;
  const original = message.media;
  if (className(original) === 'MessageMediaPhoto' && original.photo && className(original.photo) !== 'PhotoEmpty') {
    // Photo sizes are variants of one photo, not separate files.
    let size = 0;
    for (const variant of original.photo.sizes || []) {
      size = Math.max(size, Number(variant.size) || variant.bytes?.length || 0);
      for (const progressiveSize of variant.sizes || []) size = Math.max(size, Number(progressiveSize) || 0);
    }
    media = { kind: 'photo', filename: '', ext: 'jpg', mime: 'image/jpeg', size };
  } else if (className(original) === 'MessageMediaDocument' && original.document && className(original.document) !== 'DocumentEmpty') {
    media = classifyDocument(original.document, original.video || original.round ? 'video' : original.voice ? 'audio' : '');
  } else if (message.video || message.video_note) {
    media = classifyDocument(message.video || message.video_note, 'video');
  } else if (message.audio || message.voice) {
    media = classifyDocument(message.audio || message.voice, 'audio');
  } else if (message.animation) {
    // Bot API also includes document for an animation; count the original once.
    media = classifyDocument(message.animation);
  } else if (message.sticker) {
    const sticker = message.sticker;
    media = classifyDocument(sticker, sticker.is_video ? 'video' : sticker.is_animated ? '' : 'photo',
      sticker.is_video ? 'video/webm' : sticker.is_animated ? 'application/x-tgsticker' : 'image/webp');
  } else if (message.document) {
    media = classifyDocument(message.document);
  } else if (message.photo?.length) {
    let size = 0;
    for (const variant of message.photo) size = Math.max(size, Number(variant.file_size) || 0);
    media = { kind: 'photo', filename: '', ext: 'jpg', mime: 'image/jpeg', size };
  }
  return { urls: [...urls], occurrences, media, topicId };
}

export function emptyCloneCounters() {
  return { messages: 0, links: 0, linkPosts: 0, files: 0, pdfs: 0, markdown: 0, json: 0, html: 0, other: 0, images: 0, audio: 0, skippedVideos: 0 };
}

export function documentCounter({ mime, ext }) {
  if (mime === 'application/pdf') return 'pdfs';
  if (['text/markdown', 'text/x-markdown'].includes(mime)) return 'markdown';
  if (mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')) return 'json';
  if (['text/html', 'application/xhtml+xml'].includes(mime)) return 'html';
  if (!GENERIC_MIMES.has(mime) && mime !== 'text/plain') return 'other';
  if (ext === 'pdf') return 'pdfs';
  if (['md', 'markdown', 'mdown'].includes(ext)) return 'markdown';
  if (['json', 'jsonl', 'ndjson'].includes(ext)) return 'json';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  return 'other';
}

/** Messages are actual non-service history items; links are distinct URLs per
 * message. Files includes images/audio/documents, never videos. Album members
 * retain their own message/file identity; their groupedId is not a second item. */
export function countCloneMessage(counters, message) {
  if (!isContentMessage(message)) return;
  const { urls, media } = classifyCloneMessage(message);
  counters.messages++;
  counters.links += urls.length;
  if (urls.length) counters.linkPosts = (counters.linkPosts || 0) + 1;
  if (!media) return;
  if (media.kind === 'video') { counters.skippedVideos++; return; }
  counters.files++;
  if (media.kind === 'photo') counters.images++;
  else if (media.kind === 'audio') counters.audio++;
  else counters[documentCounter(media)]++;
}

function scanError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = scanError('CLONE_ABORTED', 'History scan cancelled.');
  error.name = 'AbortError';
  throw error;
}

async function abortable(operation, signal) {
  checkAbort(signal);
  if (!signal) return await operation();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => {
      try { checkAbort(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function delay(milliseconds, signal) {
  let timer;
  try { await abortable(() => new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }), signal); }
  finally { clearTimeout(timer); }
}

/** Exact accessible-history scan, O(page size) memory. maxId is an INCLUSIVE
 * snapshot boundary, returned even when it was inferred from the first page.
 * General (#1) must use GetHistory and local filtering, NOT GetReplies(1).
 * GramJS 2.26 combines maxId with offsetId using Math.max, so passing maxId on
 * every descending page would rewind the cursor. Only offsetId is sent.
 * onProgress receives { counters, maxId, complete, measurement, offsetId }.
 * onFlood may coordinate shared waits; any unelapsed server wait is slept here.
 * No completion is reported for aborted, inaccessible or broken pagination. */
export async function scanCloneHistory(client, chatId, {
  threadId = null, onProgress = async () => {}, beforeRequest = async () => {},
  onFlood = async () => {}, signal, maxId = null,
} = {}) {
  const thread = threadId == null ? null : positiveId(threadId);
  if (threadId != null && !thread) throw scanError('CLONE_INVALID_TOPIC', 'Invalid forum topic identifier.');
  if (maxId != null && (!Number.isSafeInteger(Number(maxId)) || Number(maxId) < 0 || Number(maxId) >= Number.MAX_SAFE_INTEGER)) {
    throw scanError('CLONE_INVALID_SNAPSHOT', 'Invalid history snapshot identifier.');
  }
  let snapshot = maxId == null ? null : Number(maxId);
  let offsetId = snapshot == null ? 0 : snapshot + 1;
  const counters = emptyCloneCounters();
  const progress = async (complete) => {
    checkAbort(signal);
    await abortable(() => onProgress({ counters: { ...counters }, maxId: snapshot, complete, measurement: 'accessible-history', offsetId }), signal);
  };
  const request = async () => {
    let retries = 0;
    for (;;) {
      await abortable(() => beforeRequest(), signal);
      checkAbort(signal);
      try {
        return await abortable(() => client.getMessages(chatId, {
          limit: PAGE_SIZE, offsetId, ...(thread && thread !== 1 ? { replyTo: thread } : {}),
        }), signal);
      } catch (error) {
        checkAbort(signal);
        const description = `${error?.errorMessage || ''} ${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`;
        const seconds = Number(error?.seconds);
        if (Number.isFinite(seconds) && seconds >= 0 && /FLOOD|SLOWMODE/i.test(description)) {
          const until = Date.now() + seconds * 1000;
          await abortable(() => onFlood(seconds), signal);
          if (Date.now() < until) await delay(until - Date.now(), signal);
          continue;
        }
        if (/AUTH_KEY|SESSION_|USER_DEACTIVATED|401|406/.test(description)) {
          throw scanError('CLONE_SESSION_UNAVAILABLE', 'Telegram session is unavailable; reconnect the selected account.');
        }
        if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL|CHANNEL_INVALID|CHAT_ID_INVALID|PEER_ID_INVALID|MSG_ID_INVALID|TOPIC_DELETED|403|input entity/i.test(description)) {
          throw scanError('CLONE_HISTORY_UNAVAILABLE', 'Selected account cannot access this chat or topic history.');
        }
        if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|TIMEOUT|TIMED OUT|RPC_CALL_FAIL|INTERNAL|DISCONNECT|CONNECTION|500|502|503/i.test(description) && retries < 3) {
          await delay(250 * 2 ** retries++, signal);
          continue;
        }
        throw scanError('CLONE_HISTORY_FAILED', 'Telegram history request failed; the scan is incomplete.');
      }
    }
  };
  await progress(false);
  while (snapshot !== 0) {
    const page = await request();
    if (!Array.isArray(page)) throw scanError('CLONE_HISTORY_FAILED', 'Telegram returned no history page; the scan is incomplete.');
    if (!page.length) break;
    // Keep at most one page of IDs, and reject entries above the exclusive
    // cursor so overlapping pages cannot count pinned items or albums twice.
    const seen = new Set();
    let nextOffset = offsetId || Infinity;
    let newest = 0;
    for (const message of page) {
      const id = positiveId(message?.id);
      if (!id) throw scanError('CLONE_PAGINATION_INVALID', 'History page contains an invalid message identifier.');
      newest = Math.max(newest, id);
      if (offsetId && id >= offsetId) continue;
      nextOffset = Math.min(nextOffset, id);
      if (seen.has(id)) continue;
      seen.add(id);
      const topicId = topicOf(message);
      if (thread && (thread === 1 ? topicId != null && topicId !== '1' : topicId !== String(thread))) continue;
      countCloneMessage(counters, message);
    }
    if (!Number.isFinite(nextOffset) || (offsetId && nextOffset >= offsetId)) {
      throw scanError('CLONE_PAGINATION_STALLED', 'History pagination did not advance; the scan is incomplete.');
    }
    if (snapshot == null) snapshot = newest;
    offsetId = nextOffset;
    await progress(false);
    // Do not infer exhaustion from a short page: Telegram can return fewer
    // records than requested. Only the next empty page establishes completion.
  }
  if (snapshot == null) snapshot = 0;
  await progress(true);
  return { counters, maxId: snapshot, complete: true, measurement: 'accessible-history' };
}
