/**
 * Athena pluggable link storage.
 *
 * The link corpus is plain Markdown, so the backing store does not have to be a
 * database. Two providers ship today:
 *
 *   d1      — Cloudflare D1 tables (default, unchanged behaviour)
 *   github  — Markdown files in a Git repo, which are the SOURCE OF TRUTH.
 *             D1 becomes a rebuildable cache used only to keep search fast.
 *
 * Layout in the repo:
 *   brain/links-0001.md                    personal links
 *   communities/<communityId>/links-0001.md  community links
 *
 * Files roll over at MAX_FILE_BYTES so no single file becomes unwieldy, and a
 * read stitches every file in the folder back together.
 */

export const MAX_FILE_BYTES = 60_000;
/** Seconds a directory listing may be reused before we re-check GitHub. */
export const LISTING_TTL_MS = 15_000;
const GH_API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Markdown (de)serialisation — pure, unit-testable
// ---------------------------------------------------------------------------

const ENTRY_RE = /<!--athena\r?\n([\s\S]*?)\r?\n-->\r?\n([\s\S]*?)\r?\n<!--\/athena-->/g;
const NOTES_MARKER = '### Notes';

function esc(v) {
  // Metadata values are single-line `key: value`; kill anything that would break that.
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

/** One link -> a Markdown block that is both human-readable and re-parseable. */
export function renderLinkEntry(link) {
  const tags = Array.isArray(link.tags) ? link.tags : parseTags(link.tags);
  const meta = [
    `id: ${esc(link.id)}`,
    `url: ${esc(link.url)}`,
    `hash: ${esc(link.url_hash)}`,
    `added: ${new Date(Number(link.created_at) || Date.now()).toISOString()}`,
  ];
  if (tags.length) meta.push(`tags: ${tags.map(esc).join(', ')}`);
  if (link.added_by_name) meta.push(`by: ${esc(link.added_by_name)}`);
  if (link.added_by_user_id) meta.push(`by_id: ${esc(link.added_by_user_id)}`);
  if (link.image_url) meta.push(`image: ${esc(link.image_url)}`);
  if (link.site_name) meta.push(`site: ${esc(link.site_name)}`);

  const title = esc(link.title) || esc(link.url) || 'Untitled';
  const notes = String(link.notes || '').trim();

  return [
    '<!--athena',
    meta.join('\n'),
    '-->',
    `## ${title}`,
    `<${esc(link.url)}>`,
    ...(notes ? ['', NOTES_MARKER, notes] : []),
    '<!--/athena-->',
  ].join('\n');
}

/** Full file body for a set of links. */
export function renderLinksMarkdown(links, { heading = 'Athena links', fileIndex = 1 } = {}) {
  const header = [
    `<!-- athena-store v1 · generated file · edits here are read back in -->`,
    `# ${heading} (file ${fileIndex})`,
    '',
    `_${links.length} link(s). Append-only; Athena rolls over to a new file near ${Math.round(MAX_FILE_BYTES / 1000)}KB._`,
    '',
  ].join('\n');
  return `${header}\n${links.map(renderLinkEntry).join('\n\n')}\n`;
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const j = JSON.parse(s);
      return Array.isArray(j) ? j.filter(Boolean) : [];
    } catch (_) { /* fall through */ }
  }
  return s.split(',').map(t => t.trim()).filter(Boolean);
}

/**
 * Parse a Markdown file back into link records.
 * Title comes from the `## ` heading and notes from the `### Notes` section, so
 * editing either directly on github.com flows back into Athena.
 */
export function parseLinksMarkdown(text, sourceFile = null) {
  const out = [];
  if (!text) return out;
  ENTRY_RE.lastIndex = 0;
  let m;
  while ((m = ENTRY_RE.exec(text)) !== null) {
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      if (k) meta[k] = v;
    }
    if (!meta.url) continue;

    const body = m[2];
    const headingMatch = body.match(/^##\s+(.+)$/m);
    const notesIdx = body.indexOf(NOTES_MARKER);
    const notes = notesIdx === -1 ? '' : body.slice(notesIdx + NOTES_MARKER.length).trim();

    const createdAt = Date.parse(meta.added || '');
    out.push({
      id: meta.id || `gh_${hashString(meta.url)}`,
      url: meta.url,
      url_hash: meta.hash || '',
      title: headingMatch ? headingMatch[1].trim() : (meta.url || ''),
      notes,
      tags: parseTags(meta.tags),
      created_at: Number.isFinite(createdAt) ? createdAt : Date.now(),
      added_by_name: meta.by || null,
      added_by_user_id: meta.by_id || null,
      image_url: meta.image || null,
      site_name: meta.site || null,
      _file: sourceFile,
    });
  }
  return out;
}

/** Small non-crypto hash, only used to synthesise an id for hand-written entries. */
function hashString(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// ---------------------------------------------------------------------------
// base64 that survives non-ASCII (btoa alone does not)
// ---------------------------------------------------------------------------

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// GitHub Contents API client
// ---------------------------------------------------------------------------

export class GitHubStore {
  constructor({ repo, branch = 'main', token, fetchImpl = fetch }) {
    const [owner, name] = String(repo || '').split('/');
    this.owner = owner;
    this.repo = name;
    this.branch = branch || 'main';
    this.token = token;
    // fetch must stay bound to the global scope. Assigning it to an instance
    // property and calling this.fetch(...) rebinds `this` to the store, which
    // Workers rejects with "Illegal invocation".
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : fetch.bind(globalThis);
  }

  get valid() { return !!(this.owner && this.repo && this.token); }

  async api(path, init = {}) {
    const res = await this.fetch(`${GH_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'athena-worker',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { ok: res.ok, status: res.status, body };
  }

  /** Verify credentials + repo access. Returns {ok, error}. */
  async verify() {
    if (!this.valid) return { ok: false, error: 'repo and token are required' };
    const r = await this.api(`/repos/${this.owner}/${this.repo}`);
    if (!r.ok) {
      const msg = r.status === 404
        ? 'Repository not found, or the token cannot see it'
        : r.status === 401
          ? 'Token rejected by GitHub (401)'
          : (r.body?.message || `HTTP ${r.status}`);
      return { ok: false, error: msg };
    }
    if (r.body?.permissions && r.body.permissions.push === false) {
      return { ok: false, error: 'Token has read-only access; Contents write permission is required' };
    }
    return { ok: true, repo: r.body?.full_name, private: !!r.body?.private };
  }

  /**
   * List the .md files in a folder. Missing folder => [].
   *
   * Uses the Git Trees API rather than Contents, because Contents silently
   * caps a directory at 1000 entries — a brain that rolled over past 1000
   * files would just stop being fully visible. Trees returns up to 100k and
   * reports `truncated` if it ever does hit its own ceiling.
   */
  async listFolder(folder) {
    const prefix = `${folder.replace(/\/+$/, '')}/`;
    const t = await this.api(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`
    );
    if (t.ok && Array.isArray(t.body?.tree)) {
      const files = t.body.tree
        .filter(n => n.type === 'blob' && n.path.startsWith(prefix) && n.path.endsWith('.md'))
        .map(n => ({ name: n.path.slice(prefix.length), path: n.path, sha: n.sha, size: n.size || 0 }))
        // only files directly in the folder, not deeper nesting
        .filter(f => !f.name.includes('/'))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!t.body.truncated) return files;
      // Extremely large repo: fall through to Contents for this folder.
    }
    // 404 = empty repo / no commits yet, or branch missing.
    if (t.status === 404) {
      const c404 = await this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(folder)}?ref=${encodeURIComponent(this.branch)}`);
      if (c404.status === 404) return [];
    }
    const r = await this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(folder)}?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(r.body?.message || `GitHub list failed (${r.status})`);
    if (!Array.isArray(r.body)) return [];
    return r.body
      .filter(f => f.type === 'file' && f.name.endsWith('.md'))
      .map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** List every file directly in a folder without changing Markdown link discovery. */
  async listDirectFiles(folder) {
    const prefix = `${folder.replace(/\/+$/, '')}/`;
    const t = await this.api(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`
    );
    if (t.ok && Array.isArray(t.body?.tree) && !t.body.truncated) {
      return t.body.tree
        .filter(n => n.type === 'blob' && n.path.startsWith(prefix))
        .map(n => ({ name: n.path.slice(prefix.length), path: n.path, sha: n.sha, size: n.size || 0 }))
        .filter(f => !f.name.includes('/'))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const r = await this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(folder)}?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(r.body?.message || `GitHub list failed (${r.status})`);
    if (!Array.isArray(r.body)) return [];
    return r.body
      .filter(f => f.type === 'file')
      .map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(path) {
    const r = await this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.body?.message || `GitHub read failed (${r.status})`);
    return { content: r.body?.content ? b64decode(r.body.content) : '', sha: r.body?.sha };
  }

  async writeFile(path, content, { sha = null, message } = {}) {
    const payload = {
      message: message || `athena: update ${path}`,
      content: b64encode(content),
      branch: this.branch,
    };
    if (sha) payload.sha = sha;
    const r = await this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return r;
  }

  async deleteFile(path, sha, message) {
    return this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: message || `athena: delete ${path}`, sha, branch: this.branch }),
    });
  }
}

// ---------------------------------------------------------------------------
// Folder helpers
// ---------------------------------------------------------------------------

export function folderFor(scope, key) {
  return scope === 'personal' ? 'brain' : `communities/${key}`;
}

export function fileName(index) {
  return `links-${String(index).padStart(4, '0')}.md`;
}

export function indexOfFile(name) {
  const m = String(name || '').match(/links-(\d+)\.md$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Read / write across the whole folder
// ---------------------------------------------------------------------------

/**
 * Read every link in a folder. Returns {links, files, sig}.
 *
 * `cache` (optional) lets the caller skip files it has already parsed:
 *   get(name, sha) -> links[] | null      put(name, sha, links)
 * A file's sha only changes when its content does, so a refresh after one
 * write re-reads one file instead of all of them. Without that, a brain
 * spanning 200 Markdown files would cost 200 API calls on every refresh.
 */
export async function readAll(store, folder, cache = null) {
  const files = await store.listFolder(folder);
  const sig = files.map(f => `${f.name}:${f.sha}`).join('|');
  const links = [];
  let fetched = 0;
  for (const f of files) {
    const hit = cache ? await cache.get(f.name, f.sha) : null;
    if (hit) { links.push(...hit); continue; }
    const got = await store.readFile(f.path);
    if (!got) continue;
    const parsed = parseLinksMarkdown(got.content, f.name);
    if (cache) await cache.put(f.name, f.sha, parsed);
    fetched++;
    links.push(...parsed);
  }
  links.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return { links, files, sig, fetched };
}

/**
 * Append a link, rolling to a new file when the current one is full.
 *
 * GitHub's Contents API is read-modify-write against a file sha, so two
 * concurrent Telegram dumps into the same community WILL collide. A 409/422
 * means someone else committed first: re-read and retry rather than drop the
 * link. Community writes are the whole reason this loop exists.
 */
export async function appendLink(store, folder, link, { heading, maxRetries = 5 } = {}) {
  const entry = renderLinkEntry(link);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const files = await store.listFolder(folder);
    const last = files.length ? files[files.length - 1] : null;
    const lastIndex = last ? indexOfFile(last.name) : 0;

    // Fresh folder, or the current file has no room left -> start a new file.
    if (!last || (last.size || 0) + entry.length + 2 > MAX_FILE_BYTES) {
      const nextIndex = lastIndex + 1;
      const path = `${folder}/${fileName(nextIndex)}`;

      // GitHub's directory listing lags commits by up to ~1s while a direct file
      // read is fresh. So an "empty" folder may already hold this file, and two
      // concurrent dumps can both decide to create it — with the second create
      // silently replacing the first. Probe the exact path before creating.
      const preexisting = await store.readFile(path);
      if (preexisting) {
        const merged = `${preexisting.content.replace(/\s*$/, '')}\n\n${entry}\n`;
        const res = await store.writeFile(path, merged, {
          sha: preexisting.sha,
          message: `athena: add ${link.url}`,
        });
        if (res.ok) return { ok: true, path, created: false };
        if (res.status === 409 || res.status === 422) {
          await sleep(150 * (attempt + 1));
          continue;
        }
        return { ok: false, error: res.body?.message || `HTTP ${res.status}` };
      }

      const body = renderLinksMarkdown([link], { heading, fileIndex: nextIndex });
      const res = await store.writeFile(path, body, { message: `athena: add ${link.url}` });
      if (res.ok) return { ok: true, path, created: true };
      if (res.status === 409 || res.status === 422) {
        await sleep(150 * (attempt + 1));
        continue; // someone created it first; next pass appends instead
      }
      return { ok: false, error: res.body?.message || `HTTP ${res.status}` };
    }

    const current = await store.readFile(last.path);
    if (!current) continue;
    const body = `${current.content.replace(/\s*$/, '')}\n\n${entry}\n`;
    const res = await store.writeFile(last.path, body, {
      sha: current.sha,
      message: `athena: add ${link.url}`,
    });
    if (res.ok) return { ok: true, path: last.path, created: false };
    if (res.status === 409 || res.status === 422) {
      // Someone committed between our read and write. Back off a little and retry.
      await sleep(120 * (attempt + 1));
      continue;
    }
    return { ok: false, error: res.body?.message || `HTTP ${res.status}` };
  }
  return { ok: false, error: 'Could not commit after repeated conflicts — try again' };
}

/**
 * Rewrite the folder so it contains exactly `links` (used for edit, delete and
 * the initial migration). Splits across files at MAX_FILE_BYTES.
 */
export async function rewriteAll(store, folder, links, { heading, message } = {}) {
  const existing = await store.listFolder(folder);

  // Pack entries into files without exceeding the size cap.
  const chunks = [];
  let current = [];
  let size = 0;
  for (const l of links) {
    const len = renderLinkEntry(l).length + 2;
    if (current.length && size + len > MAX_FILE_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(l);
    size += len;
  }
  if (current.length || !chunks.length) chunks.push(current);

  const written = [];
  for (let i = 0; i < chunks.length; i++) {
    const idx = i + 1;
    const path = `${folder}/${fileName(idx)}`;
    const prev = existing.find(f => f.name === fileName(idx));
    const body = renderLinksMarkdown(chunks[i], { heading, fileIndex: idx });
    const res = await store.writeFile(path, body, {
      sha: prev?.sha || null,
      message: message || `athena: rewrite ${path}`,
    });
    if (!res.ok) return { ok: false, error: res.body?.message || `HTTP ${res.status}` };
    written.push(path);
  }

  // Drop files that are no longer needed after compaction.
  for (const f of existing) {
    if (indexOfFile(f.name) > chunks.length) {
      await store.deleteFile(f.path, f.sha, `athena: compact ${f.name}`);
    }
  }
  return { ok: true, files: written.length };
}

/**
 * Edit or remove a single link by rewriting ONLY the file that contains it.
 *
 * rewriteAll re-commits every file in the folder, which is both slow and
 * expensive against GitHub's secondary limit of 500 content-generating requests
 * per hour — a brain split across 5 files burned 5 of those for one delete.
 * This burns exactly one.
 *
 * `transform` receives the parsed links for the matching file and returns the
 * replacement array. Return the array minus the entry to delete, or with the
 * entry swapped to edit.
 */
export async function rewriteFileContaining(store, folder, linkId, transform, { heading, maxRetries = 4 } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const files = await store.listFolder(folder);
    let found = false;
    let conflicted = false;

    for (const f of files) {
      const got = await store.readFile(f.path);
      if (!got) continue;
      const links = parseLinksMarkdown(got.content, f.name);
      if (!links.some(l => l.id === linkId)) continue;
      found = true;

      const next = transform(links);
      const idx = indexOfFile(f.name) || 1;
      const body = renderLinksMarkdown(next, { heading, fileIndex: idx });
      const res = await store.writeFile(f.path, body, {
        sha: got.sha,
        message: `athena: update ${linkId}`,
      });
      if (res.ok) return { ok: true, path: f.path, remaining: next.length };
      if (res.status === 409 || res.status === 422) { conflicted = true; break; }
      return { ok: false, error: res.body?.message || `HTTP ${res.status}` };
    }

    // "Not found" is NOT trustworthy on the first pass: the directory listing
    // lags a commit by up to ~1s, so deleting a link that was just added would
    // silently no-op and the entry would survive in the Markdown. Retry before
    // believing it is genuinely absent.
    if (!found && !conflicted) {
      if (attempt < maxRetries - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { ok: true, notFound: true };
    }
    if (conflicted) await sleep(150 * (attempt + 1));
  }
  return { ok: false, error: 'Could not commit after repeated conflicts — try again' };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
