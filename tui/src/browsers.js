// Browser bookmark extraction — Chromium-family JSON plus Firefox SQLite
// (node:sqlite, Node >= 22.5). Falls back to a hand-picked export file.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ApiError } from './api.js';

const isHttp = (url) => /^https?:\/\//i.test(url || '');

// Reserved test/demo domains (RFC 2606) and loopback hosts: fixtures from
// browser/e2e test suites that must never pollute a brain AI search can read.
const SYNTHETIC_RE = [
  /^https?:\/\/(?:[a-z0-9-]+\.)*example\.(?:com|org|net|edu|gov|mil)(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:test|invalid|localhost)(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/(?:\[::1\]|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/|$)/,
];

/** True when a link is an obvious test/demo fixture, not a real bookmark. */
export function isSyntheticLink(link) {
  return SYNTHETIC_RE.some((re) => re.test(link?.url || ''));
}

/** Drop test/demo fixtures; returns the clean list. */
export function filterSynthetic(links) {
  return links.filter((l) => !isSyntheticLink(l));
}

function walkChromium(node, out = []) {
  if (!node) return out;
  if (node.type === 'url' && isHttp(node.url)) {
    out.push({ url: node.url, title: node.name || '', tags: node.parents || [] });
  }
  if (node.children) {
    const folder = node.name;
    for (const child of node.children) {
      child.parents = [...(node.parents || []), ...(folder && node.type === 'folder' ? [folder] : [])];
      walkChromium(child, out);
    }
  }
  return out;
}

function readChromium(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.roots ? walkChromium(raw.roots.bookmark_bar, [])
    .concat(walkChromium(raw.roots.other, []))
    .concat(walkChromium(raw.roots.synced, [])) : [];
}

async function readFirefox(profileDir) {
  const db = path.join(profileDir, 'places.sqlite');
  if (!fs.existsSync(db)) return [];
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return null; }
  // A running Firefox holds an exclusive lock on places.sqlite (SQLITE_BUSY).
  // Copy it (+ WAL/SHM) to a temp file and read the copy — the same trick
  // gosuki uses for its VFS-locked DBs.
  const tmp = path.join(os.tmpdir(), `athena-places-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  fs.copyFileSync(db, tmp);
  for (const ext of ['-wal', '-shm']) {
    const f = db + ext;
    try { if (fs.existsSync(f)) fs.copyFileSync(f, tmp + ext); } catch { /* optional */ }
  }
  const conn = new DatabaseSync(tmp, { readOnly: true });
  try {
    // Modern Firefox: moz_bookmarks has no url column — type=1 rows point at
    // moz_places via fk. The URL and canonical title live there.
    const rows = conn.prepare(`
      SELECT p.url AS url,
             COALESCE(NULLIF(b.title, ''), p.title) AS title,
             b.parent AS parent
      FROM moz_bookmarks b
      JOIN moz_places p ON p.id = b.fk
      WHERE b.type = 1 AND p.url IS NOT NULL
      GROUP BY p.url
    `).all();
    // Build full folder paths ("Other Bookmarks/Misc/pmwiki", not just the
    // immediate parent) by walking the parent chain; root ids get their
    // user-facing names and id 1 (PlacesRoot) ends the walk.
    const folders = conn.prepare('SELECT id, parent, title FROM moz_bookmarks WHERE type = 2').all();
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    const pathFor = (parentId) => {
      const parts = [];
      let id = parentId;
      for (let i = 0; i < 6 && id != null; i++) {
        const rootName = FIREFOX_ROOT_NAMES[id];
        if (rootName === null || rootName === undefined) {
          const f = folderMap.get(id);
          if (!f) break;
          parts.unshift(f.title || '');
          id = f.parent;
        } else {
          if (rootName) parts.unshift(rootName);
          break;
        }
      }
      return parts;
    };
    return rows
      .filter((r) => isHttp(r.url))
      .map((r) => ({ url: r.url, title: r.title || '', tags: pathFor(r.parent) }));
  } finally {
    conn.close();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + '-wal', { force: true });
    fs.rmSync(tmp + '-shm', { force: true });
  }
}

// Chromium-family profile roots (native + sandboxed). The actual profile
// directory can be "Default", "Profile 1", a custom name, etc.
const CHROME_ROOTS = [
  ['Chrome', ['.config', 'google-chrome']],
  ['Chrome (Flatpak)', ['.var', 'app', 'com.google.Chrome', 'config', 'google-chrome']],
  ['Chromium', ['.config', 'chromium']],
  ['Chromium (Flatpak)', ['.var', 'app', 'org.chromium.Chromium', 'config', 'chromium']],
  ['Edge', ['.config', 'microsoft-edge']],
  ['Edge (Flatpak)', ['.var', 'app', 'com.microsoft.Edge', 'config', 'microsoft-edge']],
  ['Brave', ['.config', 'BraveSoftware', 'Brave-Browser']],
  ['Brave (Flatpak)', ['.var', 'app', 'com.brave.Browser', 'config', 'BraveSoftware', 'Brave-Browser']],
  ['Opera', ['.config', 'opera']],
  ['Opera (Flatpak)', ['.var', 'app', 'com.opera.Opera', 'config', 'opera']],
  ['Vivaldi', ['.config', 'vivaldi']],
  ['Arc', ['Library', 'Application Support', 'Arc', 'User Data']],
];

const FIREFOX_ROOTS = [
  ['.mozilla', 'firefox'],
  // XDG config home — where Arch/Fedora place Firefox profiles now
  ['.config', 'mozilla', 'firefox'],
  ['.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'],
  ['snap', 'firefox', 'common', '.mozilla', 'firefox'],
];

// moz_bookmarks special roots (internal titles) → user-facing names.
const FIREFOX_ROOT_NAMES = { 1: null, 2: 'Bookmarks Menu', 3: 'Bookmarks Toolbar', 4: 'Tags', 5: 'Other Bookmarks', 6: 'Mobile Bookmarks' };

function chromeCandidateFiles(home) {
  const out = [];
  for (const [name, dirs] of CHROME_ROOTS) {
    const base = path.join(home, ...dirs);
    if (!fs.existsSync(base)) continue;
    try {
      for (const dir of fs.readdirSync(base)) {
        const file = path.join(base, dir, 'Bookmarks');
        // Opera keeps Bookmarks at the profile root (no profile subdir).
        if (fs.existsSync(file) || fs.existsSync(path.join(base, 'Bookmarks'))) {
          out.push([dir === 'Bookmarks' ? name : `${name} · ${dir}`, file]);
        }
      }
    } catch { /* unreadable root */ }
  }
  return out;
}

function firefoxProfileDirs(home) {
  const out = [];
  for (const dirs of FIREFOX_ROOTS) {
    const root = path.join(home, ...dirs);
    if (!fs.existsSync(root)) continue;
    try {
      for (const dir of fs.readdirSync(root)) {
        // Any profile dir that actually contains places.sqlite: .default,
        // -release, -esr, -dev-edition, or a custom name.
        if (fs.existsSync(path.join(root, dir, 'places.sqlite'))) {
          out.push([`Firefox · ${dir}`, path.join(root, dir)]);
        }
      }
    } catch { /* unreadable profiles dir */ }
  }
  return out;
}

// Portable/custom browser data dirs (e.g. Comet in Documents): colon-separated
// in ATHENA_BOOKMARK_ROOTS, each scanned one level deep for <dir>/Bookmarks
// (chromium-style) or <dir>/places.sqlite (firefox-style).
function extraCandidateFiles(home) {
  const roots = String(process.env.ATHENA_BOOKMARK_ROOTS || '')
    .split(':').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const root of roots) {
    const base = path.resolve(root.startsWith('~/') ? path.join(home, root.slice(2)) : root);
    if (!fs.existsSync(base)) continue;
    const label = path.basename(base);
    if (fs.existsSync(path.join(base, 'places.sqlite'))) {
      out.push([`Custom · ${label}`, base]);
      continue;
    }
    try {
      for (const dir of fs.readdirSync(base)) {
        const p = path.join(base, dir);
        if (fs.existsSync(path.join(p, 'Bookmarks'))) {
          out.push([`Custom · ${label}/${dir}`, path.join(p, 'Bookmarks')]);
        } else if (fs.existsSync(path.join(p, 'places.sqlite'))) {
          out.push([`Custom · ${label}/${dir}`, p]);
        }
      }
    } catch { /* unreadable root */ }
  }
  return out;
}

function browserCandidates() {
  const home = os.homedir();
  return [...chromeCandidateFiles(home), ...firefoxProfileDirs(home), ...extraCandidateFiles(home)];
}

/** Detect what bookmarks exist locally; returns [{name, file, kind}]. */
export function detectBookmarks() {
  const found = [];
  for (const [name, file] of browserCandidates()) {
    if (!file) continue;
    // Firefox candidates are profile directories containing places.sqlite;
    // Chromium candidates are the Bookmarks JSON files themselves.
    const isFirefox = file.endsWith('places.sqlite') || fs.existsSync(path.join(file, 'places.sqlite'));
    if (isFirefox || fs.existsSync(file)) {
      found.push({ name, file, kind: isFirefox ? 'firefox' : 'chromium' });
    }
  }
  return found;
}

/** Human-readable scan report for `athena-tui --diagnose`. */
export function scanDiagnose() {
  const home = os.homedir();
  const out = [
    `os.homedir() = ${home}`,
    `HOME env     = ${process.env.HOME || '(unset)'}`,
    `uid          = ${process.getuid?.() ?? 'n/a'}`,
    `ATHENA_BOOKMARK_ROOTS = ${process.env.ATHENA_BOOKMARK_ROOTS || '(unset)'}`,
    '',
  ];
  for (const [name, dirs] of [...CHROME_ROOTS, ...FIREFOX_ROOTS.map((d) => ['Firefox', d])]) {
    const base = path.join(home, ...dirs);
    out.push(`${fs.existsSync(base) ? 'YES' : 'NO '} ${name} root: ${base}`);
    if (!fs.existsSync(base)) continue;
    try {
      for (const dir of fs.readdirSync(base)) {
        const p = path.join(base, dir);
        const has = fs.existsSync(path.join(p, 'places.sqlite')) ? 'PLACES' : fs.existsSync(path.join(p, 'Bookmarks')) ? 'bookmarks' : '';
        out.push(`   ${has.padEnd(9)} ${dir}`);
      }
    } catch (e) { out.push(`   (unreadable: ${e.message})`); }
  }
  const extra = String(process.env.ATHENA_BOOKMARK_ROOTS || '').split(':').filter(Boolean);
  for (const root of extra) {
    const base = path.resolve(root.startsWith('~/') ? path.join(home, root.slice(2)) : root);
    out.push(`${fs.existsSync(base) ? 'YES' : 'NO '} custom root: ${base}`);
  }
  const found = detectBookmarks();
  out.push('', `detected: ${found.length ? found.map((f) => f.name).join(', ') : 'NOTHING'}`);
  return out;
}

/** Load bookmarks from a detected source or a user-supplied path. */
export async function loadBookmarks(source) {
  if (source.kind === 'firefox') {
    const res = await readFirefox(source.file);
    if (res === null) throw new ApiError('Firefox needs Node >= 22.5 (node:sqlite). Use the export file fallback.', 'SQLITE_UNSUPPORTED');
    return res;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(source.file)?.[1]?.toLowerCase();
  if (ext === 'html') return parseHtmlExport(fs.readFileSync(source.file, 'utf8'));
  if (ext === 'json') return readChromium(source.file);
  const head = fs.readFileSync(source.file, 'utf8').slice(0, 1024).trimStart();
  if (head.startsWith('{')) return readChromium(source.file);
  if (/<DL|<DT|<H3|<A /i.test(head)) return parseHtmlExport(fs.readFileSync(source.file, 'utf8'));
  throw new ApiError('Unrecognized bookmark file (expected .json, .html, or places.sqlite).', 'BAD_FILE');
}

/** Strip markup from bookmark titles/folder names (incl. unterminated tags). */
function sanitizeText(s) {
  // Entity forms are dropped whole, then only single characters '<' and '>'
  // are removed (the shape js/incomplete-multi-character-sanitization
  // recognizes as complete) — no multi-character form can survive or recur.
  return String(s || '')
    .replace(/&(lt|gt|quot|amp|#\d+|#x[0-9a-f]+);/gi, '')
    .replace(/<|>/g, '')
    .trim();
}

/** Minimal Netscape bookmarks.html parser (export fallback). Folders via <DL>. */
export function parseHtmlExport(html) {
  const out = [];
  const stack = [];
  const re = /<(DT|H3)\b[^>]*>|<\/DL\s*>|<A\b([^>]*)>([\s\S]*?)<\/A\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const full = m[0];
    if (/^<A\b/i.test(full)) {
      const attrs = m[2];
      const href = /HREF="([^"]*)"/i.exec(attrs)?.[1] || /HREF='([^']*)'/i.exec(attrs)?.[1];
      const text = sanitizeText(m[3]);
      if (href && isHttp(href)) out.push({ url: href, title: text, tags: stack.slice() });
    } else if (/^<\/DL/i.test(full)) {
      stack.pop();
    } else if (full.toLowerCase().startsWith('<h3')) {
      const rest = html.slice(re.lastIndex);
      const end = rest.search(/<\/H3>/i);
      const name = sanitizeText(end === -1 ? rest : rest.slice(0, end));
      stack.push(name);
    }
  }
  return out;
}

/** Dedupe by normalized URL, tagging folders. */
export function dedupe(links) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    const key = l.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}
