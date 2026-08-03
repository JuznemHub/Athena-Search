#!/usr/bin/env node
// Athena Search TUI — dump your browser bookmarks into your Athena brain.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import readline from 'node:readline';

import { makeTheme } from './theme.js';
import { CLEAR, HIDE_CURSOR, SHOW_CURSOR, ERASE_EOL, box, center, titleBlock, logoBlock } from './screen.js';
import { menu, confirm } from './menu.js';
import { playIntro, withSpinner } from './anim.js';
import { keyStream } from './keys.js';
import { makeClient, ApiError, STORAGE_LABELS, rankOf } from './api.js';
import { detectBookmarks, loadBookmarks, dedupe, scanDiagnose, filterSynthetic } from './browsers.js';
import { loadConfig, saveConfig } from './config.js';
import { parseSessionToken } from './session.js';

const theme = makeTheme();
const stderr = (s) => process.stderr.write(s);
const columns = () => process.stderr.columns || process.stdout.columns || 80;
const rows = () => process.stderr.rows || 24;

const io = {
  stderr,
  stderrIsTTY: process.stderr.isTTY === true,
  columns,
  rows,
  keys: () => keyStream(),
  env: process.env,
};

let state = { ...loadConfig() };

function prompt(question, { hint = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const suffix = hint ? theme.dim(` (${hint})`) : '';
    rl.question(theme.bold(question) + suffix + ' ', (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    stderr(theme.dim(`Open this URL in your browser:\n${theme.accent(url)}\n`));
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableBatchError(error) {
  return error instanceof ApiError && (
    error.status === 0 || error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 ||
    error.code === 'BATCH_IN_PROGRESS' ||
    (error.status >= 500 && error.status < 600)
  );
}

function retryDelay(error, attempt) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.min(Math.max(error.retryAfterMs, 500), 60_000);
  return Math.min(1_000 * (2 ** attempt), 8_000);
}

function bookmarkKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${host}${port}${path}${u.search}`;
  } catch (_) {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

function bookmarkFingerprint(rawUrl) {
  return createHash('sha256').update(bookmarkKey(rawUrl)).digest('hex').slice(0, 20);
}

function titleSimilarity(left, right) {
  const words = (value) => new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const a = words(left);
  const b = words(right);
  if (a.size < 2 || b.size < 2) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / new Set([...a, ...b]).size;
}

async function statusBox() {
  const client = makeClient(state.instance, state.token);
  const [config, me] = await Promise.all([client.storageConfig(), client.me()]);
  const provider = STORAGE_LABELS[config?.provider] || config?.provider || 'unknown';
  let communities = [];
  try { communities = (await client.communities())?.communities || []; } catch { /* not joined */ }
  const joined = communities.find((c) => String(c.id) === String(state.community_id));
  const rank = rankOf(me?.user || {});
  const name = me?.user?.username || me?.user?.first_name || 'user';
  return {
    me: me.user,
    rank,
    name,
    provider,
    joined,
    communities,
  };
}

async function renderHeader(glow = true) {
  stderr(CLEAR);
  stderr(titleBlock(theme, columns(), glow).join('\n'));
}

async function stepConnectInstance() {
  await renderHeader(false);
  stderr(center(theme.bold('Connect your Athena instance'), columns()) + '\n\n');
  stderr(center(theme.dim('Ask your GOD for the instance URL'), columns()) + '\n');
  const url = await prompt('Instance URL', { hint: 'https://athena.example.org' });
  if (!/^https?:\/\//.test(url)) { stderr(theme.danger('Invalid URL.\n')); return false; }
  const client = makeClient(url);
  try {
    await withSpinner(io, theme, 'Pinging instance…', () => client.health());
    const next = url.replace(/\/+$/, '');
    if (state.instance && state.instance !== next) {
      Object.assign(state, {
        token: undefined,
        name: undefined,
        rank: undefined,
        provider: undefined,
        community_id: undefined,
        community_name: undefined,
        scanned: undefined,
        last_dump: undefined,
      });
    }
    state.instance = next;
    saveConfig(state);
    stderr(theme.ok('Connected.\n'));
    return true;
  } catch (e) {
    stderr(theme.danger(`Could not reach instance: ${e.message}\n`));
    return false;
  }
}

async function stepLogin() {
  if (!state.instance) {
    stderr(theme.dim('No instance connected — connecting first.\n\n'));
    if (!(await stepConnectInstance())) return false;
  }
  await renderHeader(false);
  stderr(center(theme.bold('Login with Telegram'), columns()) + '\n\n');
  stderr(center(theme.dim('Log in on the website, then paste the address-bar URL'), columns()) + '\n');
  stderr(center(theme.dim('or the session token it ends with.'), columns()) + '\n\n');
  openBrowser(`${state.instance}/api/auth/telegram`);
  stderr(theme.dim('Opening the login page in your browser…\n\n'));
  const pasted = await prompt('Session URL or token');
  const token = parseSessionToken(pasted);
  if (!token) { stderr(theme.danger('No session token found in that input.\n')); return false; }
  state.token = token;
  const client = makeClient(state.instance, state.token);
  try {
    const [me, cfg] = await Promise.all([
      withSpinner(io, theme, 'Checking session…', () => client.me()),
      client.storageConfig().catch(() => null),
    ]);
    const account = me.user;
    state.name = account?.username || account?.first_name || 'user';
    state.rank = rankOf(account);
    // Backend is chosen on the website (PostgreSQL / GitHub / D1) — mirror it
    // here so the TUI always reports where a dump will actually land.
    if (cfg?.provider) state.provider = STORAGE_LABELS[cfg.provider] || cfg.provider;
    saveConfig(state);
    return true;
  } catch (e) {
    stderr(theme.danger(`Login failed: ${e.message}\n`));
    delete state.token;
    return false;
  }
}

async function stepJoinCommunity() {
  if (!state.token) { stderr(theme.danger('Login first.\n')); return false; }
  await renderHeader(false);
  stderr(center(theme.bold('Join a community'), columns()) + '\n\n');
  stderr(center(theme.dim('Paste the community id from your GOD'), columns()) + '\n');
  const id = await prompt('Community id');
  const client = makeClient(state.instance, state.token);
  try {
    const res = await withSpinner(io, theme, 'Joining community…', () => client.joinCommunity(id));
    state.community_id = id;
    state.community_name = res?.community?.name || state.community_name || id;
    saveConfig(state);
    stderr(theme.ok(`Joined ${theme.bold(state.community_name)}.\n`));
    return true;
  } catch (e) {
    stderr(theme.danger(`Join failed: ${e.message}\n`));
    return false;
  }
}

async function stepScan() {
  if (!state.token) { stderr(theme.danger('Login first.\n')); return false; }
  // gosuki-style: scan every browser profile found locally, no picking.
  let sources = detectBookmarks();
  if (sources.length === 0) {
    stderr(theme.danger('No browsers detected — give a bookmarks export file (HTML or JSON) instead.\n'));
    await renderHeader(false);
    const file = await prompt('Path to export file', { hint: '/path/to/bookmarks.html' });
    if (!file) { stderr(theme.dim('Cancelled.\n')); return false; }
    sources = [{ name: 'Export file', file, kind: 'export' }];
  }
  const all = [];
  const failed = [];
  for (const src of sources) {
    try {
      const links = await withSpinner(io, theme, `Reading ${src.name}…`, () => loadBookmarks(src));
      all.push(...links);
    } catch (e) {
      // One unreadable source (e.g. locked places.sqlite) must not abort the
      // scan of the others.
      failed.push(`${src.name}: ${e.message}`);
    }
  }
  const raw = dedupe(all);
  const unique = filterSynthetic(raw);
  const excluded = raw.length - unique.length;
  const allTags = [...new Set(unique.flatMap((l) => l.tags || []))].sort();
  const previous = Array.isArray(state.scanned?.fingerprints) ? new Set(state.scanned.fingerprints) : null;
  const fingerprints = unique.map((link) => bookmarkFingerprint(link.url));
  const fingerprintSet = new Set(fingerprints);
  const newCount = previous
    ? fingerprints.filter((fingerprint) => !previous.has(fingerprint)).length
    : null;
  const removedCount = previous
    ? [...previous].filter((fingerprint) => !fingerprintSet.has(fingerprint)).length
    : null;
  state.scanned = { count: unique.length, folders: allTags, fingerprints, time: Date.now(), sources };
  saveConfig(state);
  await renderHeader(false);
  stderr(center(theme.bold('Bookmarks found'), columns()) + '\n\n');
  const lines = [
    `${theme.accent(String(unique.length))} unique bookmarks${newCount == null ? '' : ` · ${newCount} new · ${removedCount} removed`}`,
    ...sources.map((s) => theme.dim('◦ ' + s.name)),
    ...(excluded ? [theme.dim(`${excluded} test/synthetic bookmarks excluded (example.*, *.test, localhost)`)] : []),
    ...(failed.length ? [theme.danger(`${failed.length} source(s) unreadable:`), ...failed.map((f) => theme.dim('  ' + f))] : []),
    ...(state.scanned.folders.length
      ? ['', ...state.scanned.folders.slice(0, 15).map((f) => theme.dim('📁 ' + f)),
         ...(state.scanned.folders.length > 15 ? [theme.dim(`…and ${state.scanned.folders.length - 15} more folders`)] : [])]
      : []),
  ];
  stderr(box(lines, theme).join('\n') + '\n');
  stderr(center(theme.dim('Press ↵ to continue'), columns()) + '\n');
  const keys = await keyStream();
  await keys.next();
  keys.close();
  return true;
}

async function pickDumpTarget() {
  const pick = await menu(io, theme, {
    title: 'Dump where?',
    items: [
      { label: 'Community brain', hint: state.community_name || 'join one first' },
      { label: 'Personal brain', hint: 'GOD only' },
    ],
    width: columns(),
  });
  if (pick === null) return null;
  return pick === 1 ? 'personal' : 'community';
}

async function stepDump() {
  if (!state.token) { stderr(theme.danger('Login first.\n')); return false; }
  if (!state.scanned?.count) {
    stderr(theme.danger('Scan bookmarks first.\n'));
    return false;
  }
  const client = makeClient(state.instance, state.token);
  let me;
  try { me = (await client.me()).user; } catch (e) { stderr(theme.danger(e.message) + '\n'); return false; }
  const isGod = me?.is_god === true;
  const target = isGod
    ? await pickDumpTarget()
    : 'community';
  if (target === null) return false;
  if (target === 'community' && !state.community_id) {
    stderr(theme.danger('Join a community first.\n'));
    return false;
  }

  // Dump the same sources that were scanned; fall back to a fresh detection
  // only when the scan state was lost (e.g. old config file).
  const sources = state.scanned?.sources?.length ? state.scanned.sources : detectBookmarks();
  const all = [];
  const unreadable = [];
  for (const src of sources) {
    try {
      const links = await withSpinner(io, theme, `Reading ${src.name}…`, () => loadBookmarks(src));
      all.push(...links);
    } catch (e) {
      unreadable.push(`${src.name}: ${e.message}`);
    }
  }
  const unique = dedupe(all);
  const clean = filterSynthetic(unique);
  const excluded = unique.length - clean.length;
  if (!clean.length) { stderr(theme.danger('No bookmarks found locally.\n')); return false; }
  state.scanned = { ...state.scanned, count: clean.length, time: Date.now() };
  saveConfig(state);

  await renderHeader(false);
  const providerTxt = state.provider ? theme.dim(` · ${state.provider}`) : '';
  const where = target === 'personal' ? 'personal brain' : `community "${state.community_name || state.community_id}"`;
  stderr(center(theme.bold(`Dump ${clean.length} bookmarks → ${where}`) + providerTxt, columns()) + '\n\n');
  if (excluded) stderr(theme.dim(`${excluded} test/synthetic bookmarks excluded (example.*, *.test, localhost)\n`));
  if (unreadable.length) stderr(theme.danger(`${unreadable.length} source(s) unreadable:\n`) + unreadable.map((f) => theme.dim('  ' + f + '\n')).join(''));
  const ok = await confirm(io, theme, 'Send them now? (y/n)', columns());
  if (!ok) { stderr(theme.dim('Cancelled.\n')); return false; }

  stderr(HIDE_CURSOR);
  const total = clean.length;
  let added = 0, dupes = 0, failed = 0;
  const errors = [];
  const batchKey = randomUUID();
  const payloads = clean.map((link) => ({
    url: link.url,
    ...(link.title ? { title: link.title.slice(0, 200) } : {}),
    ...(link.tags?.length ? { tags: link.tags.slice(0, 10) } : {}),
  }));
  let uploadPayloads = payloads;
  let preflightDupes = 0;
  let similarCount = 0;
  let preflightWarning = '';

  // Check the current brain first. Exact URL matches are safe to skip locally;
  // fuzzy title matches are only reported because similar titles may still be
  // different resources and must not be silently discarded.
  try {
    const remote = target === 'personal'
      ? await client.personalLinks()
      : await client.links(state.community_id);
    const remoteLinks = Array.isArray(remote?.links) ? remote.links : [];
    const remoteKeys = new Set(remoteLinks.map((link) => bookmarkKey(link.url)));
    const exact = payloads.filter((payload) => remoteKeys.has(bookmarkKey(payload.url)));
    preflightDupes = exact.length;
    dupes = preflightDupes;
    uploadPayloads = payloads.filter((payload) => !remoteKeys.has(bookmarkKey(payload.url)));
    similarCount = uploadPayloads.filter((payload) => remoteLinks.some((link) => (
      bookmarkKey(link.url) !== bookmarkKey(payload.url) && titleSimilarity(payload.title, link.title) >= 0.75
    ))).length;
    stderr(ERASE_EOL + `\r${theme.dim(`Current brain: ${dupes} exact matches · ${uploadPayloads.length} new candidates`)}`);
  } catch (e) {
    preflightWarning = `Current-brain duplicate check unavailable: ${e.code || e.type || e.message}`;
  }

  if (!uploadPayloads.length) {
    stderr('\n\n' + SHOW_CURSOR);
    state.last_dump = { added: 0, dupes, failed: 0, unconfirmed: 0, where, time: Date.now() };
    saveConfig(state);
    stderr(box([
      theme.ok('✓ No new bookmarks to upload'),
      theme.dim(`${dupes} exact matches already exist`),
      ...(preflightWarning ? [theme.danger(preflightWarning)] : []),
    ], theme).join('\n') + '\n');
    return true;
  }
  if (preflightWarning) stderr(`\n${theme.danger(preflightWarning)}\n`);
  if (similarCount) stderr(theme.dim(`${similarCount} new candidate(s) have similar existing titles; they will still be uploaded.\n`));

  // Preferred path: one request for the whole batch (worker writes D1 and the
  // GitHub folder in a single commit). Older instances without the batch
  // endpoint fall back to per-link POSTs.
  let batchSkipped = false;
  let batchError = null;
  let unconfirmed = 0;
  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = target === 'personal'
          ? await client.postPersonalLinksBatch(uploadPayloads, { idempotencyKey: batchKey })
          : await client.postLinksBatch(uploadPayloads, state.community_id, { idempotencyKey: batchKey });
        break;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) throw e;
        if (!retryableBatchError(e) || attempt >= 2) throw e;
        const delay = retryDelay(e, attempt);
        stderr(ERASE_EOL + `\r${theme.dim(`Batch request failed (${e.code || e.type}); retrying in ${Math.ceil(delay / 1000)}s…`)}`);
        await wait(delay);
      }
    }
    if (!res || typeof res.total !== 'number') throw new ApiError('batch unsupported', 'HTTP_404', 404);
    added = res.added || 0;
    dupes = preflightDupes + (res.dupes || 0);
    const rejected = Array.isArray(res.failed) ? res.failed : [];
    failed = rejected.length;
    if (failed) errors.push(...rejected.slice(0, 5).map((url) => `REJECTED: ${url}`));
    stderr(ERASE_EOL + `\r${theme.accent(added)} added · ${theme.dim(dupes)} dupes · ${theme.danger(failed)} failed — ${total}/${total}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      batchSkipped = true; // instance predates the batch endpoint
    } else {
      batchError = `${e.code || e.type || 'UPLOAD_FAILED'}: ${e.message}`;
      unconfirmed = total;
      errors.push(batchError);
    }
  }

  if (batchSkipped) {
    // Fall back to the old per-link loop — still works everywhere.
    let sent = 0;
    for (const payload of uploadPayloads) {
      try {
        if (target === 'personal') await client.postPersonalLink(payload);
        else await client.postLink({ ...payload, community_id: state.community_id });
        added += 1;
      } catch (e) {
        if (e instanceof ApiError && /EXISTS|DUPLICATE/i.test(e.type)) dupes += 1;
        else {
          failed += 1;
          if (errors.length < 5) errors.push(`${e.type || e.message}: ${payload.url}`);
          if (/NON_MEMBER|LOCKED|UNAUTHORIZED/i.test(e.type)) { break; }
        }
      }
      sent += 1;
      if (sent % 5 === 0 || sent === total) {
        stderr(ERASE_EOL + `\r${theme.accent(added)} added · ${theme.dim(dupes)} dupes · ${theme.danger(failed)} failed — ${preflightDupes + sent}/${total}`);
      }
    }
  }
  stderr('\n\n');
  stderr(SHOW_CURSOR);
  state.last_dump = { added, dupes, failed, unconfirmed, where, time: Date.now() };
  saveConfig(state);
  stderr(box([
    ...(batchError
      ? [theme.danger(`! Batch upload was not confirmed for ${unconfirmed} bookmarks`)]
      : [theme.ok(`✓ ${added} bookmarks stored in ${where}`)]),
    ...(dupes ? [theme.dim(`${dupes} already known (skipped)`)] : []),
    ...(failed ? [theme.danger(`${failed} failed`), ...errors.map((e) => theme.dim(e))] : []),
    ...(batchError ? errors.map((e) => theme.dim(e)) : []),
  ], theme).join('\n') + '\n');
  return true;
}

async function stepStatus() {
  await renderHeader(false);
  try {
    const s = await statusBox();
    const lines = [
      `instance   ${theme.accent(state.instance)}`,
      `brain      ${s.provider}`,
      `account    ${theme.bold(s.name)} · ${s.rank.style === 'danger' ? theme.danger(s.rank.label) : theme.accent(s.rank.label)}`,
      ...(s.joined ? [`community  ${s.joined.name}${s.joined.role ? ` · ${s.joined.role}` : ''}`] : []),
      ...(state.scanned ? [`bookmarks  ${state.scanned.count} scanned`] : []),
      ...(state.last_dump ? [`last dump  ${state.last_dump.added} added · ${state.last_dump.dupes} dupes · ${state.last_dump.failed} failed${state.last_dump.unconfirmed ? ` · ${state.last_dump.unconfirmed} unconfirmed` : ''}`] : []),
    ];
    stderr(box(lines, theme, { label: 'STATUS' }).join('\n') + '\n');
  } catch (e) {
    stderr(theme.danger(e.message) + '\n');
  }
  stderr(center(theme.dim('Press ↵ to continue'), columns()) + '\n');
  const keys = await keyStream();
  await keys.next();
  keys.close();
  return true;
}

async function stepLogout() {
  delete state.token;
  delete state.name;
  delete state.rank;
  saveConfig(state);
  stderr(theme.ok('Logged out.\n'));
  return true;
}

async function mainMenu() {
  let s = null;
  try { s = await statusBox(); } catch { /* offline */ }
  const name = s?.name || state.name || '—';
  const rank = s?.rank || state.rank;
  const rankTxt = rank?.label
    ? (rank.style === 'danger' ? theme.danger(rank.label) : theme.accent(rank.label))
    : theme.dim('guest');
  const items = [
    { label: 'Login with Telegram', hint: state.token ? `${name} · ${rankTxt}` : 'not logged in' },
    { label: 'Connect instance', hint: state.instance || 'not connected' },
    { label: 'Join community', hint: state.community_name || 'not joined' },
    { label: 'Scan bookmarks', hint: state.scanned ? `${state.scanned.count} found` : 'not scanned' },
    { label: 'Dump bookmarks', hint: state.last_dump ? `${state.last_dump.added} last time` : '' },
    { label: 'Status', hint: '' },
    ...(state.token ? [{ label: 'Logout', hint: '' }] : []),
    { label: 'Quit', hint: '' },
  ];
  // binthere mirror: big-block wordmark + spark → tagline → server line → actions box.
  const head = [
    ...logoBlock(theme, columns()),
    center(theme.dim('search your second brain · dump your bookmarks · ai answers'), columns()),
    center(theme.dim(`server  ${state.instance || 'not connected'}${state.provider ? ` · ${state.provider}` : ''}`), columns()),
    '',
  ];
  const pick = await menu(io, theme, { title: 'ATHENA SEARCH', items, width: columns(), header: head, label: 'actions' });
  if (pick === null) return false;
  const fns = [stepLogin, stepConnectInstance, stepJoinCommunity, stepScan, stepDump, stepStatus, ...(state.token ? [stepLogout] : []), () => false];
  return fns[pick]();
}

async function main() {
  if (process.argv.includes('--diagnose')) {
    console.log(scanDiagnose().join('\n'));
    process.exit(0);
  }
  if (!io.stderrIsTTY || !process.stdin.isTTY) {
    stderr('athena-tui needs an interactive terminal.\n');
    process.exit(1);
  }
  const inst = state.instance || process.env.ATHENA_INSTANCE;
  state.instance = inst ? String(inst).replace(/\/+$/, '') : undefined;
  if (process.env.ATHENA_TOKEN) state.token = process.env.ATHENA_TOKEN;

  await playIntro(io, theme, columns());
  while (await mainMenu()) { /* loop back to the menu after each action */ }
  stderr(SHOW_CURSOR);
  process.exit(0);
}

main().catch((e) => {
  stderr(theme.danger(`\n${e.message}\n`));
  process.exit(1);
});
