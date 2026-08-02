// Browser bookmark extraction — Chromium-family JSON plus Firefox SQLite
// (node:sqlite, Node >= 22.5). Falls back to a hand-picked export file.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ApiError } from './api.js';

const isHttp = (url) => /^https?:\/\//i.test(url || '');

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
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const rows = conn.prepare(`
      SELECT b.url, b.title, GROUP_CONCAT(p.title, ' / ') AS folder
      FROM moz_bookmarks b
      LEFT JOIN moz_bookmarks p ON p.id = b.parent
      WHERE b.type = 1 AND b.url IS NOT NULL
      GROUP BY b.url
    `).all();
    return rows
      .filter((r) => isHttp(r.url))
      .map((r) => ({ url: r.url, title: r.title || '', tags: r.folder ? [r.folder] : [] }));
  } finally { conn.close(); }
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
  ['.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'],
  ['snap', 'firefox', 'common', '.mozilla', 'firefox'],
];

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

function browserCandidates() {
  const home = os.homedir();
  return [...chromeCandidateFiles(home), ...firefoxProfileDirs(home)];
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
