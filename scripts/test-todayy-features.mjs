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
  await addBlacklistEntry(env, {
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

console.log('test-todayy-features.mjs passed');
