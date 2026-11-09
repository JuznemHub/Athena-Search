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

// ---- Guided setup: drive the tools, remember the paths ----------------------
// After one guided run the TUI stores the export/archive paths in its config,
// so the next import just works with no prompts.

import { spawn } from 'node:child_process';

export function which(cmd) {
  try {
    const args = process.platform === 'win32' ? ['where', cmd] : ['which', cmd];
    const exe = process.platform === 'win32' ? args.shift() : args.shift();
    const r = spawnSync(exe, args, { timeout: 10_000, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function toolStatus() {
  return {
    python: which('python3') || which('python'),
    git: which('git'),
    unzip: which('unzip'),
    redditFetcher: which('reddit-fetcher'),
    tweetnook: which('tweetnook'),
  };
}

/** Run a tool with live stderr (user watches progress); resolves {status}. */
export function runTool(cmd, args, { cwd, timeout = 900_000, stdin = 'ignore' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: [stdin, 'pipe', 'inherit'] });
    } catch (e) {
      resolve({ status: 1, error: e.message });
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    child.on('error', (e) => { clearTimeout(kill); resolve({ status: 1, output: out, error: e.message }); });
    child.on('close', (code) => { clearTimeout(kill); resolve({ status: code ?? 1, output: out }); });
  });
}

export function redditCheckoutCandidates() {
  const home = os.homedir();
  const cwd = process.cwd();
  return [
    process.env.REDDIT_FETCH_DIR || '',
    path.join(cwd, 'Reddit-Fetch'),
    path.join(home, 'Reddit-Fetch'),
    path.join(home, 'src', 'Reddit-Fetch'),
  ].filter(Boolean);
}

/** A Reddit-Fetch checkout holds reddit_fetch/api.py. */
export function findRedditCheckout(dirs) {
  for (const d of dirs || []) {
    if (exists(path.join(d, 'reddit_fetch', 'api.py'))) return d;
  }
  return null;
}

export function writeRedditEnv(dir, { clientId, clientSecret, username }) {
  const lines = [
    `CLIENT_ID=${String(clientId).trim()}`,
    `CLIENT_SECRET=${String(clientSecret).trim()}`,
    'REDIRECT_URI=http://localhost:8080',
    `USER_AGENT=linux:athena-tui-reddit:v1.0 (by /u/${String(username).trim()})`,
    `REDDIT_USERNAME=${String(username).trim()}`,
  ];
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

export function savedPostsPath(dir) {
  for (const f of ['saved_posts.json', 'data/saved_posts.json']) {
    if (exists(path.join(dir, f))) return path.join(dir, f);
  }
  for (const f of ['saved_posts.html', 'data/saved_posts.html']) {
    if (exists(path.join(dir, f))) return path.join(dir, f);
  }
  return null;
}

/** Name a file/dir as a social source the loader understands. */
export function socialSourceFor(file, name = 'Social import') {
  const isDir = (() => { try { return fs.statSync(file).isDirectory(); } catch { return false; } })();
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (isDir) return { name, file, kind: 'x-archive' };
  if (ext === 'html') return { name, file, kind: 'reddit-html' };
  // TweetNook's own export is posts.json (or has tweetnook in the name);
  // Reddit-Fetch's saved_posts.json stays reddit-json.
  if (ext === 'json' && (/tweetnook/i.test(file) || /(^|\/)posts\.json$/i.test(file))) {
    return { name, file, kind: 'tweetnook-json' };
  }
  return { name, file, kind: 'reddit-json' };
}

export function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const py = spawnSync('python3',
    ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dest],
    { timeout: 300_000, stdio: 'ignore' });
  if (py.status === 0 && fs.existsSync(dest)) return { ok: true };
  const uz = spawnSync('unzip', ['-q', zip, '-d', dest], { timeout: 300_000, stdio: 'ignore' });
  if (uz.status === 0) return { ok: true };
  return { ok: false, error: 'need python3 or unzip to extract the archive' };
}

/**
 * Guided Reddit setup. Reuses the stored path when it still exists, otherwise
 * walks: checkout → .env → OAuth tokens → fetch. Returns a source or null.
 * `ctx` = { prompt, say, state } from the TUI.
 */
export async function ensureRedditExport({ prompt, say, state }) {
  if (state.redditExportPath && exists(state.redditExportPath)) {
    return socialSourceFor(state.redditExportPath, 'Reddit saved posts');
  }
  const tools = toolStatus();
  say('Reddit setup — your saves are fetched with Reddit-Fetch (OAuth, stays on your machine).');
  let checkout = state.redditCheckout && exists(state.redditCheckout)
    ? state.redditCheckout
    : findRedditCheckout(redditCheckoutCandidates());
  if (!checkout) {
    say(`Clone it first: git clone https://github.com/akashpandey/Reddit-Fetch "${path.join(os.homedir(), 'Reddit-Fetch')}"`);
    if (!tools.git) say('git is not installed — install it, or download the ZIP from GitHub.');
    const given = await prompt('Path to Reddit-Fetch checkout', { hint: '~/Reddit-Fetch' });
    if (!given) return null;
    const resolved = given.startsWith('~/') ? path.join(os.homedir(), given.slice(2)) : path.resolve(given);
    if (!exists(path.join(resolved, 'reddit_fetch', 'api.py'))) {
      say('That folder has no reddit_fetch/api.py — cancelled.');
      return null;
    }
    checkout = resolved;
    state.redditCheckout = checkout;
  }
  const envFile = path.join(checkout, '.env');
  if (!exists(envFile)) {
    say('Create a Reddit app (https://www.reddit.com/prefs/apps, type script, redirect http://localhost:8080), then:');
    const clientId = await prompt('Reddit CLIENT_ID', {});
    const clientSecret = await prompt('Reddit CLIENT_SECRET', {});
    const username = await prompt('Reddit username', { hint: 'without u/' });
    if (!clientId || !clientSecret || !username) { say('Cancelled — need all three.'); return null; }
    writeRedditEnv(checkout, { clientId, clientSecret, username });
    say(`Wrote ${envFile} (mode 600).`);
  }
  const tokensFile = path.join(checkout, 'tokens.json');
  if (!exists(tokensFile)) {
    say('One-time login: a URL prints below — open it, approve, done.');
    const py = tools.python ? (which('python3') ? 'python3' : 'python') : null;
    if (!py) { say('python3 is not installed — cannot run the login.'); return null; }
    const res = await runTool(py, ['-m', 'reddit_fetch.generate_tokens'], { cwd: checkout, stdin: 'inherit' });
    if (res.status !== 0 || !exists(tokensFile)) {
      say('Login did not finish — run Import social again when ready.');
      return null;
    }
  }
  const runCmd = tools.redditFetcher ? ['reddit-fetcher'] : null;
  if (!runCmd) {
    say(`Install the fetcher once: cd "${checkout}" && pip install -e .`);
    return null;
  }
  say('Fetching your saves (can take a while on big accounts)…');
  const res = await runTool(runCmd[0], [], { cwd: checkout });
  if (res.status !== 0) {
    say('Fetch failed — re-run Import social to retry.');
    return null;
  }
  const out = savedPostsPath(checkout);
  if (!out) { say('Fetch finished but no saved_posts file found.'); return null; }
  state.redditExportPath = out;
  return socialSourceFor(out, 'Reddit saved posts');
}

/**
 * Guided X setup. Reuses the stored archive dir, otherwise takes a ZIP (or
 * folder), extracts it, and remembers it. Returns a source or null.
 */
export async function ensureXArchive({ prompt, say, state }) {
  if (state.xArchivePath && exists(state.xArchivePath)) {
    return socialSourceFor(state.xArchivePath, 'X archive');
  }
  const tools = toolStatus();
  say('X setup — request your archive in X → Settings → Your account → Download an archive of your data.');
  if (tools.tweetnook) say('tweetnook CLI found: you can also run `tweetnook import x-archive <zip>` yourself any time.');
  const given = await prompt('Path to X archive (.zip or extracted folder)', { hint: '~/Downloads/twitter-archive.zip' });
  if (!given) return null;
  const resolved = given.startsWith('~/') ? path.join(os.homedir(), given.slice(2)) : path.resolve(given);
  if (!exists(resolved)) { say('Cannot read that path.'); return null; }
  let dir = resolved;
  try {
    if (fs.statSync(resolved).isFile()) {
      if (!/\.zip$/i.test(resolved)) { say('Only .zip files or extracted folders, please.'); return null; }
      dir = resolved.replace(/\.zip$/i, '');
      if (!exists(path.join(dir, 'data'))) {
        say(`Extracting to ${dir}…`);
        const r = extractZip(resolved, dir);
        if (!r.ok) { say(r.error); return null; }
      }
    }
  } catch {
    say('Cannot read that path.');
    return null;
  }
  const hasData = (() => {
    try { return fs.readdirSync(path.join(dir, 'data')).some((f) => f.endsWith('.js')); } catch { return false; }
  })();
  if (!hasData) say('Warning: no data/*.js in there — continuing anyway, may find nothing.');
  state.xArchivePath = dir;
  return socialSourceFor(dir, 'X archive');
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
