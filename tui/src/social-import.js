// Social imports — Reddit (Reddit-Fetch) + X/Twitter (official archive, TweetNook).
//
// Supported inputs (zero deps, no Python needed):
//   - Reddit-Fetch output: saved_posts.json (array of {title, url, subreddit,
//     type, author, score, body}) or saved_posts.html — produced by
//     https://github.com/akashpandey/Reddit-Fetch (`reddit-fetcher`)
//   - X official archive: an extracted archive dir containing data/tweets.js,
//     data/like.js, ... (`window.YTD.*.part0 = [...]`) — the same ZIP that
//     https://github.com/GezerWezer/TweetNook imports via
//     `tweetnook import x-archive`
//   - TweetNook JSON export: `tweetnook export json --collection all --out f`
//
// When the `reddit-fetcher` / `tweetnook` CLIs are installed the TUI can run
// them to (re)generate those files; otherwise it reads whatever is on disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isHttp = (url) => /^https?:\/\//i.test(url || '');

function normTag(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function tagList(...tags) {
  const out = [];
  for (const t of tags) {
    const n = normTag(t);
    if ((n.length >= 2 || n === 'x') && !out.includes(n)) out.push(n);
  }
  return out;
}

function cleanText(s, max = 200) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---- Reddit-Fetch -----------------------------------------------------------

/** Parse Reddit-Fetch saved_posts.json: plain array, {content: []} (API
 *  return), or raw Reddit listing {data: {children: [{data}]}}. */
export function parseRedditFetchJson(raw) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else if (Array.isArray(raw?.content)) items = raw.content;
  else if (Array.isArray(raw?.data?.children)) items = raw.data.children.map((c) => c?.data || c);
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const type = it.type || (it.title && !String(it.title).startsWith('Comment in:') ? 'post' : 'comment');
    const url = it.url || (it.permalink ? `https://reddit.com${it.permalink}` : '');
    if (!isHttp(url)) continue;
    const sub = String(it.subreddit || '').replace(/^r\//i, '');
    const title = cleanText(it.title || it.link_title || url);
    const tags = tagList('reddit', sub ? `r-${sub}` : '', type === 'comment' ? 'comment' : '');
    out.push({ url, title, tags });
  }
  return out;
}

/** Fallback: Reddit-Fetch saved_posts.html — same shape as a bookmarks export. */
export function parseRedditFetchHtml(html) {
  const out = [];
  const re = /<A\b([^>]*)>([\s\S]*?)<\/A\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = /HREF="([^"]*)"/i.exec(m[1])?.[1] || /HREF='([^']*)'/i.exec(m[1])?.[1];
    if (!href || !isHttp(href)) continue;
    const title = cleanText(String(m[2]).replace(/<[^>]*>/g, '').replace(/&(lt|gt|quot|amp|#\d+|#x[0-9a-f]+);/gi, '')) || href;
    const sub = /reddit\.com\/r\/([^/?#]+)/i.exec(href)?.[1];
    out.push({ url: href, title, tags: tagList('reddit', sub ? `r-${sub}` : '') });
  }
  return out;
}

// ---- X / TweetNook ----------------------------------------------------------

/** Extract the `window.YTD.<name>.part0 = [...]` array from an archive .js file. */
export function parseYtdJs(text) {
  const start = String(text || '').indexOf('[');
  if (start === -1) return null;
  try {
    const arr = JSON.parse(String(text).slice(start));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function tweetStatusUrl(screenName, idStr) {
  if (!idStr) return '';
  return screenName
    ? `https://x.com/${screenName}/status/${idStr}`
    : `https://x.com/i/status/${idStr}`;
}

function tweetText(t) {
  return cleanText(t.full_text || t.text || '', 200);
}

/** Parse one unwrapped tweet object into Athena link entries. Tweets that link
 *  out produce one entry per external URL; text-only tweets (and likes with no
 *  links) are kept as a link to the tweet itself so the thought is archived. */
export function tweetToLinks(t, { screenName = '', collection = 'tweets' } = {}) {
  if (!t || typeof t !== 'object') return [];
  const idStr = t.id_str || t.id_str === 0 ? String(t.id_str) : (t.id ? String(t.id) : '');
  const text = tweetText(t);
  const urls = [];
  for (const u of t.entities?.urls || []) {
    const expanded = u.expanded_url || u.url;
    if (expanded && isHttp(expanded) && !/twitter\.com|x\.com/i.test(expanded)) urls.push(expanded);
  }
  for (const m of t.entities?.media || []) {
    const expanded = m.expanded_url || m.media_url_https || m.media_url;
    if (expanded && isHttp(expanded)) urls.push(expanded);
  }
  const tags = tagList('x', collection.replace(/s$/, ''), screenName ? `from-${screenName}` : '');
  if (urls.length) {
    return [...new Set(urls)].map((url) => ({
      url,
      title: text || url,
      tags,
    }));
  }
  const status = tweetStatusUrl(screenName, idStr);
  if (!status) return [];
  return [{ url: status, title: text || status, tags }];
}

/** Read an extracted X archive dir (data/*.js + optional account info). */
export function parseXArchiveDir(dir) {
  const dataDir = fs.existsSync(path.join(dir, 'data')) ? path.join(dir, 'data') : dir;
  let files;
  try {
    files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.js'));
  } catch {
    return [];
  }
  // Screen name for status URLs: account.js (username) or profile.js.
  let screenName = '';
  for (const f of ['account.js', 'profile.js']) {
    try {
      const arr = parseYtdJs(fs.readFileSync(path.join(dataDir, f), 'utf8'));
      const obj = arr?.[0]?.account || arr?.[0]?.profile || arr?.[0];
      screenName = String(obj?.username || obj?.screenName || '').replace(/^@/, '');
      if (screenName) break;
    } catch { /* optional */ }
  }
  const out = [];
  for (const f of files) {
    const m = /^(.+?)(?:\.part\d+)?\.js$/.exec(f);
    if (!m) continue;
    const collection = m[1].toLowerCase();
    if (!/tweet|like|bookmark/.test(collection)) continue;
    let arr;
    try {
      arr = parseYtdJs(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!arr) continue;
    for (const entry of arr) {
      const t = entry?.tweet || entry?.like?.tweet || entry?.tweet /* TweetNook-ish */ || entry;
      // Likes arrive as {like: {tweetId, fullText, expandedUrl}} in archives.
      if (entry?.like && !entry.like.tweet) {
        const like = entry.like;
        const idStr = String(like.tweetId || '');
        const expanded = like.expandedUrl || '';
        const text = cleanText(like.fullText || '', 200);
        const tags = tagList('x', 'like');
        if (isHttp(expanded) && !/twitter\.com|x\.com/i.test(expanded)) {
          out.push({ url: expanded, title: text || expanded, tags });
        } else if (idStr) {
          out.push({ url: tweetStatusUrl('', idStr), title: text || `liked tweet ${idStr}`, tags });
        }
        continue;
      }
      out.push(...tweetToLinks(t, { screenName, collection }));
    }
  }
  return out;
}

/** Parse `tweetnook export json` output: array of {url, text/title, author,
 *  collection, tags}. Unknown shapes degrade to URL extraction. */
export function parseTweetNookJson(raw) {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.posts) ? raw.posts : [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const url = it.url || it.post_url || it.link
      || (it.id_str || it.id ? tweetStatusUrl(String(it.screen_name || it.username || ''), String(it.id_str || it.id)) : '');
    if (!isHttp(url)) continue;
    const title = cleanText(it.title || it.text || it.full_text || it.content || url);
    const tags = tagList('x', it.collection || '', it.author || it.username ? `from-${it.author || it.username}` : '', ...(it.tags || []));
    out.push({ url, title, tags });
  }
  return out;
}

/** Load one detected social source into link entries. */
export async function loadSocialLinks(source) {
  if (source.kind === 'reddit-json') {
    const raw = JSON.parse(fs.readFileSync(source.file, 'utf8'));
    return parseRedditFetchJson(raw?.content !== undefined && !Array.isArray(raw?.content) ? raw : raw);
  }
  if (source.kind === 'reddit-html') {
    return parseRedditFetchHtml(fs.readFileSync(source.file, 'utf8'));
  }
  if (source.kind === 'x-archive') {
    return parseXArchiveDir(source.file);
  }
  if (source.kind === 'tweetnook-json') {
    return parseTweetNookJson(JSON.parse(fs.readFileSync(source.file, 'utf8')));
  }
  if (source.kind === 'tweetnook-export') {
    const tmp = path.join(os.tmpdir(), `athena-tweetnook-${Date.now()}.json`);
    const run = spawnSync('tweetnook', ['export', 'json', '--collection', 'all', '--out', tmp], { timeout: 120_000 });
    if (run.status !== 0) throw new Error(`tweetnook export failed: ${String(run.stderr || run.error || 'exit ' + run.status).slice(0, 200)}`);
    try {
      return parseTweetNookJson(JSON.parse(fs.readFileSync(tmp, 'utf8')));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error(`Unknown social source kind: ${source.kind}`);
}

// ---- detection --------------------------------------------------------------

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function hasCli(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { timeout: 10_000, stdio: 'ignore' });
    return r.status === 0 || r.status === 1; // ran (help/version may exit 1)
  } catch {
    return false;
  }
}

/** Find importable social sources: env paths, cwd/data files, Reddit-Fetch
 *  home output, extracted X archives, TweetNook CLI. */
export function detectSocialSources() {
  const home = os.homedir();
  const cwd = process.cwd();
  const found = [];
  const push = (name, file, kind) => {
    if (exists(file) && !found.some((f) => f.file === file)) found.push({ name, file, kind });
  };

  const redditEnv = process.env.REDDIT_EXPORT_PATH;
  if (redditEnv) {
    push('Reddit export (env)', redditEnv, /\.html?$/i.test(redditEnv) ? 'reddit-html' : 'reddit-json');
  }
  for (const base of [cwd, path.join(cwd, 'data'), home, path.join(home, 'Reddit-Fetch'), path.join(home, 'Reddit-Fetch', 'data')]) {
    push('Reddit-Fetch saved posts', path.join(base, 'saved_posts.json'), 'reddit-json');
    push('Reddit-Fetch saved posts', path.join(base, 'saved_posts.html'), 'reddit-html');
  }

  const xEnv = process.env.X_ARCHIVE_PATH;
  if (xEnv) push('X archive (env)', xEnv, 'x-archive');
  for (const base of [cwd, path.join(cwd, 'data'), home, path.join(home, 'Downloads')]) {
    for (const name of ['twitter-archive', 'x-archive', 'twitter_archive']) {
      push('X archive', path.join(base, name), 'x-archive');
    }
  }

  const tnEnv = process.env.TWEETNOOK_EXPORT_PATH;
  if (tnEnv) push('TweetNook export (env)', tnEnv, 'tweetnook-json');
  for (const base of [cwd, path.join(cwd, 'data')]) {
    push('TweetNook export', path.join(base, 'tweetnook.json'), 'tweetnook-json');
    push('TweetNook export', path.join(base, 'posts.json'), 'tweetnook-json');
  }
  if (hasCli('tweetnook')) found.push({ name: 'TweetNook archive (CLI)', file: 'tweetnook:export', kind: 'tweetnook-export' });

  // Keep only kinds whose file actually exists (except live CLI export).
  return found.filter((s) => s.kind === 'tweetnook-export' || exists(s.file));
}

/** One-line tool availability for the import step. */
export function socialToolStatus() {
  return {
    redditFetcher: hasCli('reddit-fetcher', ['--help']),
    tweetnook: hasCli('tweetnook'),
  };
}

/** Human-readable scan report for `--diagnose`. */
export function socialScanDiagnose() {
  const out = ['social imports:'];
  for (const s of detectSocialSources()) out.push(`  YES ${s.name}: ${s.file}`);
  const tools = socialToolStatus();
  out.push(`  reddit-fetcher CLI: ${tools.redditFetcher ? 'YES' : 'NO (pip install reddit-fetcher or use saved_posts.json)'}`);
  out.push(`  tweetnook CLI: ${tools.tweetnook ? 'YES' : 'NO (pip install tweetnook or use extracted X archive)'}`);
  if (!detectSocialSources().length) out.push('  nothing detected — set REDDIT_EXPORT_PATH / X_ARCHIVE_PATH');
  return out;
}
