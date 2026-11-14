/**
 * Zero-deletion database normalizer rules (Items 1, 2, 11, 14, 16).
 * Distilled from athena-db-cleaner so both the website GUI cleaner and
 * Telegram /structure + /forcetags share one deterministic pipeline.
 */
import {
  tagsFromFacts,
  validateTags,
  extractFacts,
  properNounBans,
  normalizeTag,
  JUNK_TAGS,
  GENERIC_REJECTS,
  TYPE_SET,
  CATEGORY_SET,
} from './tag-taxonomy.js';

const TRACKING_PARAM_RE = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|si|s|t|ref_src|ref_url|spm|mkt_tok|_hsenc|_hsmi)$/i;

const BOILERPLATE_TITLE_RE = [
  /^link from telegram$/i,
  /^telegram$/i,
  /^forwarded message$/i,
  /^shared link$/i,
  /^untitled$/i,
];

const BOILERPLATE_LINE_RE = [
  /^forwarded from\b[:\s]*/i,
  /^channel link\b[:\s]*/i,
  /^shared via telegram\b.*$/i,
  /^join\s+@[\w_]+\b.*$/i,
  /^follow\s+@[\w_]+\b.*$/i,
  /^source\s*:\s*https?:\/\/t\.me\/\S+\s*$/i,
];

const TELEGRAM_SUBJECT_RE = /(?:^|\.)(?:t\.me|telegram\.(?:me|org|dog))$|\btelegram\s+(?:bot|client|channel|group|sticker|theme|mini\s*app)\b|@[a-z0-9_]{4,}bot\b/i;

/**
 * Strip tracking query parameters and normalize the URL string without
 * losing path/query identity needed for the destination page.
 */
export function normalizeCleanUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/[),.;]+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const toDelete = [];
    for (const key of parsed.searchParams.keys()) {
      if (TRACKING_PARAM_RE.test(key)) toDelete.push(key);
    }
    for (const key of toDelete) parsed.searchParams.delete(key);
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Extract `#hashtags` from text while filtering numeric anchors (`#12`).
 */
export function extractInlineHashtags(text) {
  const out = [];
  const src = String(text || '');
  const re = /(?:^|[\s(])#([a-zA-Z][a-zA-Z0-9_-]{1,39})\b/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const norm = normalizeTag(match[1]);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * Remove forwarding boilerplate, standalone handle footers, and excess blank
 * lines from notes/descriptions while keeping real factual content.
 */
export function cleanBoilerplateText(text, url = '') {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';
  const urlNorm = String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => {
    if (!line) return false;
    if (BOILERPLATE_LINE_RE.some((re) => re.test(line))) return false;
    if (/^@[a-z0-9_]{3,}$/i.test(line)) return false;
    if (urlNorm && line.replace(/\/+$/, '').toLowerCase() === urlNorm) return false;
    return true;
  });
  let cleaned = lines.join(' ').replace(/\s+/g, ' ').trim();
  // Strip leading forwarding prefix inline too
  cleaned = cleaned.replace(/^(?:forwarded from|via|source)\s*:\s*@?[\w.\-\s]{1,40}(?:\s*[-–|:]\s*)?/i, '').trim();
  // Drop leftover trailing inline hashtags only if the remainder still carries text
  const withoutTags = cleaned.replace(/(?:\s+#[a-zA-Z0-9][\w-]{1,39})+\s*$/, '').trim();
  if (withoutTags.length >= 20) cleaned = withoutTags;
  return cleaned.slice(0, 600);
}

/**
 * Clean boilerplate from a link title or indicate when title needs derivation.
 */
export function cleanCleanerTitle(rawTitle, url = '') {
  let t = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (BOILERPLATE_TITLE_RE.some((re) => re.test(t))) return '';
  const urlTrim = String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  if (urlTrim && t.replace(/\/+$/, '').toLowerCase() === urlTrim) return '';
  if (/^https?:\/\/\S+$/i.test(t)) return '';
  t = t.replace(/^(?:forwarded from|telegram)\s*[:\-–|]\s*/i, '').trim();
  return t.slice(0, 200);
}

/**
 * Derive a readable fallback title from notes or URL hostname/path.
 */
export function fallbackTitleFromContext(url, notes = '') {
  const firstSentence = String(notes || '').split(/[.!?\n]/)[0]?.trim() || '';
  if (firstSentence.length >= 6 && firstSentence.length <= 100 && !/^https?:\/\//i.test(firstSentence)) {
    return firstSentence;
  }
  try {
    const u = new URL(String(url || ''));
    const seg = u.pathname.split('/').filter(Boolean).slice(0, 2).join(' / ');
    return seg ? `${u.hostname.replace(/^www\./, '')} — ${seg}` : u.hostname.replace(/^www\./, '');
  } catch {
    return String(url || 'Untitled').slice(0, 120);
  }
}

/**
 * Filter and rebuild tags using DB cleaner rules + taxonomy facts + optional
 * AI suggestions, enforcing blacklist exclusions.
 */
export function cleanTagsDeterministic(rawTags, {
  url = '',
  title = '',
  notes = '',
  content = '',
  aiTags = [],
  blacklistedTags = new Set(),
  max = 8,
} = {}) {
  const banned = new Set([...properNounBans(title)]);
  for (const bt of blacklistedTags || []) banned.add(normalizeTag(bt));
  // Strip backfill/dump/handle noise and conditional telegram before validation
  const allowTelegram = TELEGRAM_SUBJECT_RE.test(`${url} ${title} ${notes}`);
  const parsedRaw = [];
  for (const t of [...(aiTags || []), ...(rawTags || []), ...extractInlineHashtags(`${title} ${notes}`)]) {
    const rawStr = String(t || '').trim().replace(/^#+/, '');
    if (!rawStr) continue;
    if (/^(?:u|r)\/|^@/i.test(rawStr)) continue;
    const norm = normalizeTag(rawStr);
    if (!norm) continue;
    if (JUNK_TAGS.has(norm) || GENERIC_REJECTS.has(norm) || banned.has(norm)) continue;
    if (norm === 'telegram' && !allowTelegram) continue;
    parsedRaw.push(norm);
  }

  const facts = extractFacts(url, { title, notes, content });
  const ruleTags = tagsFromFacts(facts);
  // AI-first order when aiTags supplied, backed by grounded facts & cleaned existing tags
  const candidates = aiTags?.length
    ? [...aiTags.map(normalizeTag), ...parsedRaw, ...ruleTags]
    : [...ruleTags, ...parsedRaw];

  const filteredCandidates = candidates.filter((t) => t && !banned.has(normalizeTag(t)) && (t !== 'telegram' || allowTelegram));
  const verdict = validateTags(filteredCandidates, {
    vocabulary: facts.contextualTerms || [],
    banned: [...banned],
    allowedBrands: facts.brands || [],
    max: Math.max(1, Math.min(Number(max) || 8, 10)),
  });

  const deduped = [];
  let typeTaken = false;
  for (const tag of verdict.tags) {
    if (tag === 'multiplatform') continue;
    if (banned.has(tag)) continue;
    if (TYPE_SET.has(tag)) {
      if (typeTaken) {
        if (CATEGORY_SET.has(tag)) deduped.push(tag);
        continue;
      }
      typeTaken = true;
    }
    deduped.push(tag);
  }
  const platforms = facts.software ? (facts.platforms || []) : [];
  if (platforms.length >= 2 && !deduped.includes('multiplatform') && !banned.has('multiplatform')) {
    deduped.push('multiplatform');
  }
  const finalTags = [...new Set(deduped)].slice(0, max);
  if (!finalTags.length && !banned.has('website')) finalTags.push('website');
  return { tags: finalTags, facts, rejected: verdict.rejected };
}

/**
 * Produce a normalized copy of one row without deleting it.
 * Never invents URLs that break uniqueness; reports which fields changed.
 */
export function normalizeLinkRecord(row, {
  aiResult = null,
  scrapedMeta = null,
  blacklistedTags = new Set(),
  maxTags = 8,
} = {}) {
  const origUrl = String(row.url || '').trim();
  const cleanUrl = normalizeCleanUrl(origUrl) || origUrl;

  let origTags;
  try {
    origTags = Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || '[]');
  } catch {
    origTags = [];
  }

  const origTitle = String(row.title || '').trim();
  const origNotes = String(row.notes || '').trim();

  let title = cleanCleanerTitle(aiResult?.title || scrapedMeta?.title || origTitle, cleanUrl);
  let notes = cleanBoilerplateText(aiResult?.description || origNotes || scrapedMeta?.description || '', cleanUrl);
  if (!notes && scrapedMeta?.description) {
    notes = cleanBoilerplateText(scrapedMeta.description, cleanUrl);
  }
  if (!title) {
    title = cleanCleanerTitle(origTitle, cleanUrl) || fallbackTitleFromContext(cleanUrl, notes);
  }

  const { tags, facts, rejected } = cleanTagsDeterministic(origTags, {
    url: cleanUrl,
    title,
    notes,
    content: scrapedMeta?.content || '',
    aiTags: aiResult?.tags || [],
    blacklistedTags,
    max: maxTags,
  });

  const changedFields = [];
  if (cleanUrl !== origUrl) changedFields.push('url');
  if (title !== origTitle) changedFields.push('title');
  if (notes !== origNotes) changedFields.push('notes');
  if (JSON.stringify(tags) !== JSON.stringify(origTags.map((t) => String(t)))) changedFields.push('tags');

  return {
    id: row.id,
    url: cleanUrl,
    title,
    notes,
    tags,
    facts,
    rejected,
    changedFields,
    changed: changedFields.length > 0,
  };
}
