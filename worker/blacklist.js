/**
 * Global and per-scope URL & tag blacklist enforcement + API (Item 14).
 */
import { normalizeTag } from './tag-taxonomy.js';

export async function ensureBlacklistTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS blacklist_entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      pattern TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    )`
  ).run();
}

/**
 * Normalize a blacklist pattern for matching:
 * - tag: lowercase trimmed tag without `#`
 * - url: canonical hostname or full lowercased url without trailing slash
 */
export function normalizeBlacklistPattern(kind, rawPattern) {
  const k = String(kind || '').toLowerCase();
  const s = String(rawPattern || '').trim();
  if (k === 'tag') {
    return normalizeTag(s);
  }
  const stripped = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  return stripped.slice(0, 300);
}

/**
 * Load blacklist rules matching either the active scope or `global`.
 */
export async function getBlacklistRules(env, scope = 'community', scopeKey = '') {
  try {
    await ensureBlacklistTable(env);
    const { results } = await env.DB.prepare(
      `SELECT * FROM blacklist_entries
       WHERE (scope = 'global')
          OR (scope = ? AND scope_key = ?)
       ORDER BY created_at DESC`
    ).bind(String(scope || 'community'), String(scopeKey || '')).all();
    const urlPatterns = [];
    const tagSet = new Set();
    const entries = results || [];
    for (const row of entries) {
      if (row.kind === 'tag') {
        const norm = normalizeTag(row.pattern);
        if (norm) tagSet.add(norm);
      } else if (row.kind === 'url') {
        const pat = normalizeBlacklistPattern('url', row.pattern);
        if (pat) urlPatterns.push({ pattern: pat, id: row.id, reason: row.reason || '' });
      }
    }
    return { entries, urlPatterns, tagSet };
  } catch {
    return { entries: [], urlPatterns: [], tagSet: new Set() };
  }
}

/**
 * Check if an external URL matches any blacklisted domain, prefix, or exact URL.
 */
export function checkUrlBlacklisted(rawUrl, rules) {
  const patterns = rules?.urlPatterns || [];
  if (!patterns.length || !rawUrl) return null;
  let host = '';
  let hostPath;
  try {
    const u = new URL(String(rawUrl).trim());
    host = u.hostname.replace(/^www\./i, '').toLowerCase();
    hostPath = `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    hostPath = String(rawUrl).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  }
  for (const item of patterns) {
    const p = item.pattern;
    if (!p) continue;
    if (p.includes('/')) {
      if (hostPath === p || hostPath.startsWith(p + '/') || hostPath.startsWith(p + '?')) return item;
    } else if (host === p || host.endsWith('.' + p)) {
      return item;
    }
  }
  return null;
}

/**
 * Remove any blacklisted tags from an array cleanly.
 */
export function filterBlacklistedTags(tags, rules) {
  const tagSet = rules?.tagSet;
  if (!tagSet || !tagSet.size || !Array.isArray(tags)) return Array.isArray(tags) ? tags : [];
  return tags.filter((t) => {
    const norm = normalizeTag(t);
    return norm && !tagSet.has(norm);
  });
}

/**
 * Add a URL/domain or tag pattern to the blacklist and optionally purge matching
 * blacklisted tags from existing rows in scope.
 */
export async function addBlacklistEntry(env, { scope = 'community', scopeKey = '', kind = 'url', pattern, reason = '', createdBy = '' }) {
  await ensureBlacklistTable(env);
  const cleanKind = String(kind).toLowerCase() === 'tag' ? 'tag' : 'url';
  const cleanPattern = normalizeBlacklistPattern(cleanKind, pattern);
  if (!cleanPattern) throw new Error('Invalid blacklist pattern');

  const existing = await env.DB.prepare(
    `SELECT * FROM blacklist_entries WHERE scope = ? AND scope_key = ? AND kind = ? AND pattern = ? LIMIT 1`
  ).bind(scope, String(scopeKey || ''), cleanKind, cleanPattern).first();
  if (existing) return existing;

  const id = 'bl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO blacklist_entries (id, scope, scope_key, kind, pattern, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, scope, String(scopeKey || ''), cleanKind, cleanPattern, String(reason || '').slice(0, 200), String(createdBy || ''), now).run();

  return { id, scope, scope_key: String(scopeKey || ''), kind: cleanKind, pattern: cleanPattern, reason, created_by: createdBy, created_at: now };
}

export async function removeBlacklistEntry(env, { id = '', pattern = '', scope = '', scopeKey = '' }) {
  await ensureBlacklistTable(env);
  if (id) {
    const res = await env.DB.prepare('DELETE FROM blacklist_entries WHERE id = ?').bind(id).run();
    return Number(res?.meta?.changes ?? res?.changes ?? 1) > 0;
  }
  const normUrl = normalizeBlacklistPattern('url', pattern);
  const normTag = normalizeBlacklistPattern('tag', pattern);
  const whereScope = scope ? 'AND scope = ? AND scope_key = ?' : '';
  const binds = scope ? [normUrl, normTag, scope, String(scopeKey || '')] : [normUrl, normTag];
  const res = await env.DB.prepare(
    `DELETE FROM blacklist_entries WHERE (pattern = ? OR pattern = ?) ${whereScope}`
  ).bind(...binds).run();
  return Number(res?.meta?.changes ?? res?.changes ?? 0) > 0;
}
