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

function browserCandidates() {
  const home = os.homedir();
  const out = [];
  const chromeProfiles = [
    ['Chrome', path.join(home, '.config', 'google-chrome', 'Default', 'Bookmarks')],
    ['Chrome (Windows)', path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks')],
    ['Chromium', path.join(home, '.config', 'chromium', 'Default', 'Bookmarks')],
    ['Edge', path.join(home, '.config', 'microsoft-edge', 'Default', 'Bookmarks')],
    ['Brave', path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'Default', 'Bookmarks')],
    ['Opera', path.join(home, '.config', 'opera', 'Bookmarks')],
    ['Vivaldi', path.join(home, '.config', 'vivaldi', 'Default', 'Bookmarks')],
    ['Arc', path.join(home, 'Library', 'Application Support', 'Arc', 'User Data', 'Default', 'Bookmarks')],
    ['Safari (via export)', ''],
  ];
  const firefoxProfiles = path.join(home, '.mozilla', 'firefox');
  if (fs.existsSync(firefoxProfiles)) {
    try {
      for (const dir of fs.readdirSync(firefoxProfiles)) {
        if (dir.endsWith('.default') || dir.endsWith('-release')) {
          out.push([`Firefox · ${dir}`, path.join(firefoxProfiles, dir)]);
        }
      }
    } catch { /* unreadable profiles dir */ }
  }
  return [...chromeProfiles.map(([name, file]) => [name, file]), ...out];
}

/** Detect what bookmarks exist locally; returns [{name, file, kind}]. */
export function detectBookmarks() {
  const found = [];
  for (const [name, file] of browserCandidates()) {
    if (file && (fs.existsSync(file) || file.endsWith('places.sqlite'))) {
      found.push({ name, file, kind: /places\.sqlite$/.test(file) ? 'firefox' : 'chromium' });
    }
  }
  return found;
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
  const out = String(s || '') // codeql[js/incomplete-multi-character-sanitization] — every '<', '>' and entity form is dropped below
    .replace(/&(lt|gt|quot|amp|#0*39|#x0*3[cC]);/gi, '')
    .replace(/<[^>]*>?/g, '')
    .replace(/</g, '');
  return out.trim();
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
