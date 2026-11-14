/**
 * Website & Telegram user bookmarking for search results and AI answers (Item 7).
 */
export async function ensureBookmarksTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS user_bookmarks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      link_id TEXT,
      url TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      tags TEXT,
      site_name TEXT,
      created_at INTEGER NOT NULL
    )`
  ).run();
}

export async function listUserBookmarks(env, userId) {
  await ensureBookmarksTable(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM user_bookmarks WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`
  ).bind(String(userId)).all();
  return (results || []).map((row) => ({
    ...row,
    tags: (() => {
      try { return JSON.parse(row.tags || '[]'); } catch { return []; }
    })(),
  }));
}

export async function toggleUserBookmark(env, userId, item) {
  await ensureBookmarksTable(env);
  const url = String(item?.url || '').trim();
  const rawLinkId = item?.link_id ?? item?.linkId ?? item?.id ?? null;
  const linkId = rawLinkId ? String(rawLinkId) : null;
  const scope = String(item?.scope || 'community');
  const scopeKey = String(item?.scope_key ?? item?.scopeKey ?? '');
  const siteName = String(item?.site_name ?? item?.siteName ?? '').slice(0, 120);
  if (!url && !linkId) throw new Error('url or link_id required');

  const existing = await env.DB.prepare(
    `SELECT id FROM user_bookmarks
     WHERE user_id = ? AND ((url != '' AND url = ?) OR (link_id IS NOT NULL AND link_id = ?))
     LIMIT 1`
  ).bind(String(userId), url, linkId || '__none__').first();

  if (existing && item?.forceAdd !== true) {
    await env.DB.prepare('DELETE FROM user_bookmarks WHERE id = ? AND user_id = ?').bind(existing.id, String(userId)).run();
    return { bookmarked: false, id: existing.id };
  }
  if (existing && item?.forceAdd === true) {
    return { bookmarked: true, id: existing.id };
  }

  const id = 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const tagsJson = JSON.stringify(Array.isArray(item?.tags) ? item.tags.slice(0, 10) : []);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_bookmarks (id, user_id, scope, scope_key, link_id, url, title, notes, tags, site_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    String(userId),
    scope,
    scopeKey,
    linkId,
    url,
    String(item?.title || '').slice(0, 300),
    String(item?.notes || '').slice(0, 1200),
    tagsJson,
    siteName,
    now
  ).run();

  return {
    bookmarked: true,
    id,
    bookmark: {
      id,
      user_id: String(userId),
      scope,
      scope_key: scopeKey,
      link_id: linkId,
      url,
      title: String(item?.title || '').slice(0, 300),
      notes: String(item?.notes || '').slice(0, 1200),
      tags: Array.isArray(item?.tags) ? item.tags.slice(0, 10) : [],
      site_name: siteName,
      created_at: now,
    },
  };
}

export async function removeUserBookmark(env, userId, { id = '', url = '' }) {
  await ensureBookmarksTable(env);
  if (id) {
    const res = await env.DB.prepare('DELETE FROM user_bookmarks WHERE id = ? AND user_id = ?').bind(String(id), String(userId)).run();
    return Number(res?.meta?.changes ?? res?.changes ?? 0) > 0;
  }
  if (url) {
    const res = await env.DB.prepare('DELETE FROM user_bookmarks WHERE url = ? AND user_id = ?').bind(String(url), String(userId)).run();
    return Number(res?.meta?.changes ?? res?.changes ?? 0) > 0;
  }
  return false;
}
