import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeCleanUrl,
  normalizeLinkRecord,
} from '../worker/db-cleaner.js';
import {
  addBlacklistEntry,
  getBlacklistRules,
  checkUrlBlacklisted,
  filterBlacklistedTags,
  removeBlacklistEntry,
} from '../worker/blacklist.js';
import {
  ensureBookmarksTable,
  toggleUserBookmark,
  listUserBookmarks,
} from '../worker/bookmarks.js';
import { parseFeed } from '../worker/rss-parser.js';
import { classifyLink } from '../worker/wiki-taxonomy.js';
import { classifyTags } from '../worker/tag-taxonomy.js';
import { detectBookmarks } from '../tui/src/browsers.js';
import { REDDIT_GUIDE_STEPS, X_GUIDE_STEPS } from '../tui/src/social-import.js';
import {
  shouldAllowTopicLockedMessage,
  filterDirectTelegramUserIds,
  saveBackfillLink,
  notifyWebsiteLogin,
} from '../worker/index_legacy.js';

function makeEnvDb() {
  const db = new DatabaseSync(':memory:');
  const wrapStmt = (sql) => {
    const runWith = (args) => db.prepare(sql).run(...args);
    const firstWith = (args) => db.prepare(sql).get(...args) || null;
    const allWith = (args) => ({ results: db.prepare(sql).all(...args) });
    return {
      run: async () => runWith([]),
      first: async () => firstWith([]),
      all: async () => allWith([]),
      bind: (...args) => ({
        run: async () => runWith(args),
        first: async () => firstWith(args),
        all: async () => allWith(args),
      }),
    };
  };
  return {
    DB: {
      prepare: (sql) => wrapStmt(sql),
      exec: (sql) => db.exec(sql),
    },
  };
}

// 1. db-cleaner.js normalization & zero-deletion rules
{
  const cleanedUrl = normalizeCleanUrl('https://github.com/vercel/next.js?utm_source=tg&fbclid=123&tab=readme');
  assert.equal(cleanedUrl, 'https://github.com/vercel/next.js?tab=readme');

  const row = {
    id: 'lnk_1',
    url: 'https://github.com/godotengine/godot?utm_campaign=share',
    title: 'Link from Telegram',
    notes: 'Forwarded from @gamedev_chan\nOpen source 2D and 3D cross-platform game engine\nJoin @gamedev_chan',
    tags: JSON.stringify(['backfill', 'opensource', 'game', 'randomnoise']),
  };
  const out = normalizeLinkRecord(row, {
    blacklistedTags: new Set(['blockedtag']),
  });
  assert.equal(out.id, 'lnk_1');
  assert.equal(out.url, 'https://github.com/godotengine/godot');
  assert.notEqual(out.title.toLowerCase(), 'link from telegram');
  assert.ok(!/forwarded from/i.test(out.notes));
  assert.ok(!out.tags.includes('opensource'));
  assert.ok(out.tags.includes('game'));
  assert.equal(out.changed, true);

  // Ported athena-db-cleaner.zip rules: Google Drive folder title, bot-ingestion prefixes, referral codes, rssfdv/handles
  const gdriveOut = normalizeLinkRecord({
    id: 'lnk_gd',
    url: 'https://drive.google.com/drive/folders/abc123',
    title: '@someuser BooksPack – Google Drive',
    notes: 'Already in community: Curated reading pack Use this Referral Code: REF99\nrssfdv\n@someuser',
    tags: JSON.stringify(['backfill', 'rssfdv', 'someuser', 'telegram']),
  });
  assert.equal(gdriveOut.title, 'BooksPack – public');
  assert.ok(!/already in community/i.test(gdriveOut.notes));
  assert.ok(!/referral code/i.test(gdriveOut.notes));
  assert.ok(!gdriveOut.tags.includes('rssfdv'));
  assert.ok(!gdriveOut.tags.includes('someuser'));
  assert.ok(!gdriveOut.tags.includes('telegram'));
  assert.ok(gdriveOut.tags.includes('storage'));
}

// 2. blacklist.js add, match, filter, remove
{
  const env = makeEnvDb();
  await addBlacklistEntry(env, {
    scope: 'community',
    scopeKey: 'comm_1',
    kind: 'url',
    pattern: 'https://spam.example.org/bad',
    createdBy: 'u1',
  });
  const globalEntry = await addBlacklistEntry(env, {
    scope: 'global',
    scopeKey: '',
    kind: 'tag',
    pattern: '#bannedtag',
    createdBy: 'god',
  });

  const rules = await getBlacklistRules(env, 'community', 'comm_1');
  assert.ok(checkUrlBlacklisted('https://spam.example.org/bad/page', rules));
  assert.equal(checkUrlBlacklisted('https://good.example.org/', rules), null);
  assert.deepEqual(filterBlacklistedTags(['ai', 'bannedtag', 'python'], rules), ['ai', 'python']);

  // Deleting by id with a mismatched scope/scopeKey must not remove global or other-community rules.
  const crossScopeBlocked = await removeBlacklistEntry(env, {
    id: globalEntry.id,
    scope: 'community',
    scopeKey: 'comm_1',
  });
  assert.equal(crossScopeBlocked, false);
  assert.equal(await removeBlacklistEntry(env, { id: globalEntry.id, scope: 'global', scopeKey: '' }), true);

  const removed = await removeBlacklistEntry(env, {
    scope: 'community',
    scopeKey: 'comm_1',
    pattern: 'spam.example.org/bad',
  });
  assert.equal(removed, true);
}

// 3. bookmarks.js add (camelCase & snake_case), list, toggle off
{
  const env = makeEnvDb();
  await ensureBookmarksTable(env);
  const first = await toggleUserBookmark(env, 'u_42', {
    scope: 'community',
    scopeKey: 'c_1',
    linkId: 'l_1',
    url: 'https://sqlite.org/index.html',
    title: 'SQLite Home Page',
    tags: ['database'],
  });
  assert.equal(first.bookmarked, true);

  const list = await listUserBookmarks(env, 'u_42');
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://sqlite.org/index.html');
  assert.equal(list[0].scope_key, 'c_1');
  assert.equal(list[0].link_id, 'l_1');

  const second = await toggleUserBookmark(env, 'u_42', {
    url: 'https://sqlite.org/index.html',
  });
  assert.equal(second.bookmarked, false);
}

// 4. rss-parser.js link/guid precedence, reversed Atom attrs, relative URL resolution
{
  const rssXml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        <link>https://blog.example.net</link>
        <item>
          <title>Post One</title>
          <guid isPermaLink="false">post-guid-1</guid>
          <link>/articles/one</link>
        </item>
      </channel>
    </rss>`;
  const rss = parseFeed(rssXml, 'https://blog.example.net/feed.xml');
  assert.equal(rss.articles.length, 1);
  assert.equal(rss.articles[0].url, 'https://blog.example.net/articles/one');

  const atomXml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Feed</title>
      <entry>
        <title>Atom Entry</title>
        <id>urn:uuid:1234</id>
        <link href="/entries/atom-1" rel="alternate" />
      </entry>
    </feed>`;
  const atom = parseFeed(atomXml, 'https://atom.example.net/feed.xml');
  assert.equal(atom.articles.length, 1);
  assert.equal(atom.articles[0].url, 'https://atom.example.net/entries/atom-1');
}

// 5. wiki-taxonomy.js context beats noisy backfill/opensource tags
{
  const cat = classifyLink({
    title: 'qBittorrent open source BitTorrent client',
    url: 'https://www.qbittorrent.org/',
    notes: 'Magnet downloads and torrent tracker client',
    tags: ['backfill', 'opensource'],
  });
  assert.equal(cat.categoryId, 'downloads');
}

// 6. tag-taxonomy.js game detection and opensource exclusion
{
  const res = classifyTags('https://store.steampowered.com/app/620/Portal_2/', {
    title: 'Portal 2 on Steam',
    notes: 'Puzzle platformer PC game indie adventure opensource',
  });
  assert.ok(res.tags.includes('game'));
  assert.ok(!res.tags.includes('opensource'));
}

// 7. TUI Opera root Bookmarks detection + social guide steps
{
  assert.ok(Array.isArray(REDDIT_GUIDE_STEPS) && REDDIT_GUIDE_STEPS.length >= 3);
  assert.ok(Array.isArray(X_GUIDE_STEPS) && X_GUIDE_STEPS.length >= 3);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-tui-test-'));
  const origHome = process.env.HOME;
  try {
    const operaDir = path.join(tmpHome, '.config', 'opera');
    fs.mkdirSync(operaDir, { recursive: true });
    fs.writeFileSync(
      path.join(operaDir, 'Bookmarks'),
      JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [] } } })
    );
    process.env.HOME = tmpHome;
    const sources = detectBookmarks();
    assert.ok(sources.some((s) => s.name === 'Opera' && s.file.endsWith(path.join('.config', 'opera', 'Bookmarks'))));
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

// 8. Web UI, GUI DB Cleaner contract, PWA, CSS z-index, and Tauri v2 files check
{
  const root = path.resolve('.');
  const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="mobileBottomNav"'));
  assert.ok(indexHtml.includes('id="dbCleanerModal"'));
  assert.ok(indexHtml.includes('id="blacklistModal"'));
  assert.ok(indexHtml.includes('id="bookmarksModal"'));
  assert.ok(indexHtml.includes('manifest.json'));
  assert.ok(indexHtml.includes('value="unedited"'));

  const mainJs = fs.readFileSync(path.join(root, 'public/src/main.js'), 'utf8');
  assert.ok(mainJs.includes('data.links'));
  assert.ok(mainJs.includes('dryData?.items'));
  assert.ok(mainJs.includes('batchData.items'));
  assert.ok(mainJs.includes('batchData.fixed'));
  assert.ok(mainJs.includes("pauseBtn.classList.toggle('hidden'"));
  assert.ok(mainJs.includes("resumeBtn.classList.toggle('hidden'"));

  const workerLegacy = fs.readFileSync(path.join(root, 'worker/index_legacy.js'), 'utf8');
  assert.ok(workerLegacy.includes('scraped: Boolean(fullText)'));

  const styleCss = fs.readFileSync(path.join(root, 'public/src/style.css'), 'utf8');
  assert.ok(/\.notif-panel\s*\{[\s\S]*?z-index:\s*1200/i.test(styleCss));
  assert.ok(styleCss.includes('.mobile-bottom-nav'));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.json'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.share_target?.action);

  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  assert.ok(sw.includes('/api/'));

  const tauriConf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(tauriConf.identifier, 'com.athena.search');
  assert.equal(tauriConf.build?.frontendDist, '../public');
}

// 9. Topic lock gate + /cmd@botusername override in other topics
{
  // DM / private chat always allowed
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: false,
    lockedTopicId: '42',
    messageThreadId: null,
    cmd: '',
  }), true);

  // Unlocked group allows everything
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: null,
    messageThreadId: 99,
    cmd: '',
  }), true);

  // Locked topic allows plain text, URL dumps, and bare commands inside the locked topic
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 42,
    cmd: '',
  }), true);
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 42,
    cmd: '/search',
  }), true);

  // Outside locked topic (another topic or General): ignores plain text, URL dumps, and bare commands
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 99,
    cmd: '',
  }), false);
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: null,
    cmd: '',
  }), false);
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 99,
    cmd: '/search',
    targetBotMention: '',
    selfBotUsername: 'athenabot',
  }), false);

  // /topic itself is allowed anywhere so staff can inspect or unlock
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 99,
    cmd: '/topic',
    targetBotMention: '',
    selfBotUsername: 'athenabot',
  }), true);

  // Explicit /cmd@athenabotusername is allowed in any topic (case-insensitive)
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 99,
    cmd: '/search',
    targetBotMention: 'AthenaBot',
    selfBotUsername: '@athenabot',
  }), true);

  // Different bot mention stays ignored (multi-bot isolation)
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 99,
    cmd: '/search',
    targetBotMention: 'OtherBot',
    selfBotUsername: 'athenabot',
  }), false);

  // Fail-closed when bot username is unknown
  assert.equal(shouldAllowTopicLockedMessage({
    isGroup: true,
    lockedTopicId: '42',
    messageThreadId: 99,
    cmd: '/search',
    targetBotMention: 'AthenaBot',
    selfBotUsername: '',
  }), false);
}

// 10. Context-aware wiki classification (game launchers never hijack into storage/cloud via stray tags)
{
  const gld = classifyLink({
    title: 'Project GLD - Open-source Game Library and Download Manager',
    url: 'https://github.com/YusefD/Project-GLD',
    notes: 'Launch, download, and manage your PC games from multiple sources.',
    tags: ['cloud', 'windows', 'opensource'],
  });
  assert.equal(gld.categoryId, 'gaming');
  assert.equal(gld.subheadingId, 'gaming-pc');
}

// 11. Report DM targets strictly reject negative group/channel IDs
{
  const filtered = filterDirectTelegramUserIds([
    '-1001987654321',
    '-55443322',
    '0',
    '',
    null,
    'not-an-id',
    '123456789',
    '987654321',
    '123456789',
  ]);
  assert.deepEqual(filtered, ['123456789', '987654321']);
}

// 12. Backfill / channel clone enforces URL and tag blacklist
{
  const env = makeEnvDb();
  env.DB.exec(`
    CREATE TABLE personal_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      tags TEXT,
      created_at INTEGER,
      image_url TEXT,
      site_name TEXT,
      source_chat_id TEXT,
      source_message_id TEXT,
      transfer_id TEXT,
      metadata_version INTEGER DEFAULT 0,
      search_blob TEXT
    );
  `);
  await addBlacklistEntry(env, {
    scope: 'personal',
    scopeKey: 'u_bl',
    kind: 'url',
    pattern: 'evil.example.org',
    createdBy: 'u_bl',
  });
  await addBlacklistEntry(env, {
    scope: 'personal',
    scopeKey: 'u_bl',
    kind: 'tag',
    pattern: '#spamtag',
    createdBy: 'u_bl',
  });

  const job = { id: 'job_bl', user_id: 'u_bl', chat_id: '-100500' };
  const blocked = await saveBackfillLink(
    env,
    job,
    'personal',
    { message: 'Check this out #cool', id: 10 },
    'https://evil.example.org/drop'
  );
  assert.equal(blocked.blacklisted, true);
  assert.equal(blocked.reason, 'BLACKLISTED_URL');

  const allowed = await saveBackfillLink(
    env,
    job,
    'personal',
    { message: 'Useful utility #mytool #spamtag', id: 11 },
    'https://example.com/safe-tool'
  );
  assert.ok(allowed.saved);
  const row = await env.DB.prepare('SELECT tags FROM personal_links WHERE id = ?').bind(allowed.saved).first();
  const savedTags = JSON.parse(row.tags);
  assert.ok(savedTags.includes('mytool'));
  assert.ok(!savedTags.includes('spamtag'));
}

// 13. Website login GOD notification helper records login notification
{
  const env = makeEnvDb();
  env.TG_OWNER_IDS = '999000111';
  env.DB.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      telegram_api_id TEXT
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      community_id TEXT,
      type TEXT,
      title TEXT,
      body TEXT,
      payload TEXT,
      read INTEGER DEFAULT 0,
      created_at INTEGER
    );
  `);
  await env.DB.prepare('INSERT INTO users (id, username, display_name, telegram_api_id) VALUES (?, ?, ?, ?)')
    .bind('u_god', 'owner', 'Owner', '999000111').run();
  await notifyWebsiteLogin(env, {
    id: 'u_alice',
    username: 'alice',
    display_name: 'Alice',
    telegram_api_id: '555666777',
  });
  const notif = await env.DB.prepare('SELECT type, title, body FROM notifications WHERE user_id = ?').bind('u_god').first();
  assert.equal(notif?.type, 'login');
  assert.equal(notif?.title, 'Website Login');
  assert.ok(String(notif?.body || '').includes('@alice'));
}

// 14. Mobile layout & long-link reflow rules (antislop-layoutmobile)
{
  const root = path.resolve('.');
  const styleCss = fs.readFileSync(path.join(root, 'public/src/style.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.ok(styleCss.includes('100dvh'));
  assert.ok(!/\.top-bar \.icon-btn\s*\{[^}]*min-height:\s*34px/i.test(styleCss));
  assert.ok(styleCss.includes('bottom: calc(76px + env(safe-area-inset-bottom, 0px))'));
  assert.ok(styleCss.includes('-webkit-line-clamp: 2'));
  assert.ok(styleCss.includes('@media (hover: hover)'));
  assert.ok(!indexHtml.includes('style="flex:2"'));
}

// 15. Unfiltered DB home render, edit-save / admin-load concurrency, and tab-focus resilience
{
  const vm = await import('node:vm');
  const root = path.resolve('.');
  const mainJs = fs.readFileSync(path.join(root, 'public/src/main.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const styleCss = fs.readFileSync(path.join(root, 'public/src/style.css'), 'utf8');
  const tourCss = fs.readFileSync(path.join(root, 'public/src/tour.css'), 'utf8');

  const sliceBetween = (start, end) => {
    const a = mainJs.indexOf(start);
    const b = mainJs.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `Expected section: ${start}`);
    return mainJs.slice(a, b);
  };

  // Bug 1 + Bug 3 behavior in VM
  let renderedItems = null;
  let searchCalls = 0;
  let editingOpen = false;
  const linksInMemory = [{ id: 'l1', title: 'Alpha', url: 'https://alpha.test', tags: [] }];

  const ctx = vm.createContext({
    searchSeq: 0,
    isGod: () => false,
    api: async (url) => {
      if (url.startsWith('/api/links?')) throw new Error('Tab background offline');
      return { res: { ok: true }, data: { links: [], documents: [], notifications: [] } };
    },
    normalizeLink: (x) => x,
    normalizeDocument: (x) => x,
    state: {
      mode: 'search',
      scope: 'community',
      activeCommunity: 'c1',
      communities: [{ id: 'c1', name: 'Comm 1' }],
      currentUser: { id: 'u1' },
      personalLinks: [],
      communityLinks: [...linksInMemory],
      personalDocuments: [],
      communityDocuments: [],
      filterTag: '',
      filterStatus: 'all',
      filterSort: 'created_desc',
      tagStats: { total: 1 }
    },
    corpus: () => ctx.state.communityLinks,
    filterLinks: (items) => items,
    escapeHtml: (s) => String(s || ''),
    compactHero() {},
    renderGoogleResults(items) {
      renderedItems = items;
    },
    renderNotifications() {},
    loadNotifications: async () => {},
    resultsList: {
      children: [{ id: 'card-1' }],
      innerHTML: '',
      querySelector: (sel) => (editingOpen && sel.includes('edit-panel')) ? {} : null
    },
    resultsMeta: { classList: { add() {}, remove() {} } },
    aiAnswerCard: { classList: { add() {}, remove() {} } },
    emptyState: { classList: { add() {}, remove() {} } },
    emptyStateText: { innerHTML: '' },
    searchInput: { value: '' },
    document: { visibilityState: 'visible', querySelector: () => null },
    $: () => ({ classList: { contains: () => true }, querySelector: () => null }),
    runSearch() { searchCalls++; },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Date,
    console
  });

  vm.runInContext(`
    ${sliceBetween('  // Poll D1 so Telegram dumps appear on the site without manual refresh', '  async function loadNotifications()')}
    ${sliceBetween('  async function loadPersonalLinks()', '  const DOCUMENT_MAX_BYTES =')}
    ${sliceBetween('  let homeFallbackSeq = 0;', '  function filterLinks(links, query)')}
    const origRenderHome = renderHome;
    renderHome = function() {
      homeCalls++;
      return origRenderHome();
    };
  `, ctx);
  ctx.homeCalls = 0;

  // Bug 1: renderHome() renders all corpus links even with no tag selected
  ctx.renderHome();
  assert.equal(renderedItems?.length, 1);
  assert.equal(renderedItems[0].id, 'l1');

  // Bug 3: transient focus error must not wipe communityLinks or clear rendered results
  ctx.lastSyncFingerprint = ctx.corpusFingerprint();
  await ctx.refreshLiveData({ forceUi: true, fromFocus: true });
  assert.equal(ctx.state.communityLinks.length, 1);
  assert.equal(searchCalls, 0);

  // Even when a background change arrives while editing inline, do not wipe active edit panel
  editingOpen = true;
  ctx.state.communityLinks.push({ id: 'l2', title: 'Beta', url: 'https://beta.test', tags: [] });
  await ctx.refreshLiveData({ forceUi: false });
  assert.equal(searchCalls, 0);

  // Bug 2: loadAdminDbLinks aborts stale request instead of staying stuck on adminDbState.loading
  let firstAborted = false;
  let secondResolved = false;
  let callIndex = 0;
  const adminCtx = vm.createContext({
    adminDbState: {
      scope: 'community', communityId: 'c1', status: 'all', sort: 'created_desc',
      tag: '', q: '', page: 1, limit: 25, totalPages: 1, total: 0,
      links: [{ id: 'existing' }], tags: [], communities: [{ id: 'c1', name: 'Comm' }], loading: false
    },
    $: () => ({ textContent: '', innerHTML: '', value: '' }),
    escapeHtml: (s) => String(s || ''),
    renderAdminDbTags() {},
    renderAdminDbLinks() { secondResolved = true; },
    renderAdminDbSummary() {},
    renderAdminDbPagination() {},
    renderAdminDbLockedView() {},
    showToast() {},
    URLSearchParams,
    AbortController,
    api: async (_url, opts) => {
      callIndex++;
      if (callIndex === 1) {
        return await new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            firstAborted = true;
            const e = new Error('Aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      return {
        res: { ok: true, status: 200 },
        data: { success: true, links: [{ id: 'fresh-after-save' }], total: 1, page: 1, totalPages: 1, tags: [], communities: [{ id: 'c1', name: 'Comm' }] }
      };
    }
  });
  vm.runInContext(sliceBetween('  async function loadAdminDbLinks()', '  function renderAdminDbSummary()'), adminCtx);
  const firstLoad = adminCtx.loadAdminDbLinks();
  await adminCtx.loadAdminDbLinks();
  await firstLoad;
  assert.equal(firstAborted, true);
  assert.equal(secondResolved, true);
  assert.equal(adminCtx.adminDbState.loading, false);
  assert.equal(adminCtx.adminDbState.links[0].id, 'fresh-after-save');

  // Modern Web Guidance & Anti-Slop HTML/CSS checks
  assert.equal((indexHtml.match(/<main\b/gi) || []).length, 1);
  assert.ok(styleCss.includes('content-visibility: auto'));
  assert.ok(styleCss.includes('overscroll-behavior: contain'));
  assert.ok(tourCss.includes('overscroll-behavior: contain'));
}

console.log('test-todayy-features.mjs passed');
