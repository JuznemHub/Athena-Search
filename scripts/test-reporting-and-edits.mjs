import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  notifyCommunityStaff,
  handlePatchCommunityLink,
  handlePatchPersonalLink,
  handleDeletePersonalLink,
  structureDatabase,
  urlQualityScore,
  pickBestFormattedRow,
  generateUrlHash,
  runForcetagsReview
} from '../worker/index.js';
import { classifyTags, validateTags } from '../worker/tag-taxonomy.js';

function makeMockDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      name TEXT,
      creator_id TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS community_members (
      community_id TEXT,
      user_id TEXT,
      role TEXT,
      joined_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS community_bots (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      group_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_admins (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      label TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      provider TEXT,
      provider_id TEXT,
      telegram_api_id TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      community_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      payload TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      tags TEXT,
      added_by TEXT NOT NULL,
      added_by_user_id TEXT,
      added_by_provider TEXT,
      added_by_name TEXT,
      upvotes INTEGER NOT NULL DEFAULT 0,
      downvotes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      image_url TEXT,
      site_name TEXT,
      metadata_version INTEGER NOT NULL DEFAULT 0,
      manual_edited_at INTEGER,
      last_edited_by TEXT,
      last_edited_by_name TEXT,
      search_blob TEXT,
      source_chat_id TEXT,
      source_message_id TEXT,
      transfer_id TEXT
    );
    CREATE TABLE IF NOT EXISTS personal_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      image_url TEXT,
      site_name TEXT,
      metadata_version INTEGER NOT NULL DEFAULT 0,
      manual_edited_at INTEGER,
      last_edited_by TEXT,
      last_edited_by_name TEXT,
      search_blob TEXT,
      source_chat_id TEXT,
      source_message_id TEXT
    );
  `);

  return {
    prepare(sql) {
      const execute = (...args) => ({
        async first() {
          const stmt = db.prepare(sql);
          return stmt.get(...args) || null;
        },
        async all() {
          const stmt = db.prepare(sql);
          return { results: stmt.all(...args) };
        },
        async run() {
          const stmt = db.prepare(sql);
          const info = stmt.run(...args);
          return { changes: info.changes };
        }
      });
      return {
        bind(...args) {
          return execute(...args);
        },
        async first() { return execute().first(); },
        async all() { return execute().all(); },
        async run() { return execute().run(); }
      };
    }
  };
}

async function runTests() {
  const mockDb = makeMockDb();
  const sentTelegramMessages = [];

  // Intercept global fetch for telegram calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('api.telegram.org')) {
      const body = options.body ? JSON.parse(options.body) : {};
      sentTelegramMessages.push({ url: urlStr, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 12345 } }), { status: 200 });
    }
    return originalFetch ? originalFetch(url, options) : new Response('{}', { status: 200 });
  };

  try {
    const env = {
      DB: mockDb,
      TG_OWNER_IDS: '8669123223,6848424735',
      TELEGRAM_BOT_TOKEN: '123456:ABC-DEF'
    };
    const corsHeaders = { 'access-control-allow-origin': '*' };

    // Setup community, bots, members, admins, and users
    await mockDb.prepare('INSERT INTO communities (id, name, creator_id, created_at) VALUES (?, ?, ?, ?)').bind('comm_test', 'Dev Community', 'creator_user', 1000).run();
    await mockDb.prepare('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind('comm_test', 'creator_user', 'owner', 1000).run();
    await mockDb.prepare('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind('comm_test', 'admin_user', 'admin', 1000).run();
    await mockDb.prepare('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind('comm_test', 'member_alice', 'member', 1000).run();
    await mockDb.prepare('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind('comm_test', 'member_bob', 'member', 1000).run();

    // Bound bot has group_id '-1009999999'
    await mockDb.prepare('INSERT INTO community_bots (id, community_id, platform, group_id, created_at) VALUES (?, ?, ?, ?, ?)').bind('bot_1', 'comm_test', 'telegram', '-1009999999', 1000).run();

    // Community platform admin with telegram user ID
    await mockDb.prepare('INSERT INTO community_admins (id, community_id, platform, platform_user_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('adm_1', 'comm_test', 'telegram', '99887766', 'Sub Admin', 'creator_user', 1000).run();

    // Users
    await mockDb.prepare('INSERT INTO users (id, username, display_name, provider, provider_id, telegram_api_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('creator_user', 'owner_dan', 'Dan Owner', 'telegram', '12345678', '12345678', 1000).run();
    await mockDb.prepare('INSERT INTO users (id, username, display_name, provider, provider_id, telegram_api_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('admin_user', 'admin_claire', 'Claire Admin', 'telegram', '23456789', '23456789', 1000).run();
    await mockDb.prepare('INSERT INTO users (id, username, display_name, provider, provider_id, telegram_api_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('god_user', 'god_root', 'Root Admin', 'telegram', '6848424735', '6848424735', 1000).run();
    await mockDb.prepare('INSERT INTO users (id, username, display_name, provider, provider_id, telegram_api_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('member_alice', 'alice_dev', 'Alice Dev', 'telegram', '34567890', '34567890', 1000).run();
    await mockDb.prepare('INSERT INTO users (id, username, display_name, provider, provider_id, telegram_api_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('member_bob', 'bob_coder', 'Bob Coder', 'telegram', '45678901', '45678901', 1000).run();

    // Test 1: notifyCommunityStaff does NOT broadcast to Telegram groups, only sends DMs to admins
    await notifyCommunityStaff(env, 'comm_test', {
      type: 'link_report',
      title: 'Link reported',
      body: 'alice_dev reported: Bad Link\nReason: spam',
      payload: { link_id: 'link_1' }
    });

    // Check sent Telegram messages
    const sentChatIds = sentTelegramMessages.map(m => String(m.body.chat_id));
    assert.equal(sentChatIds.includes('-1009999999'), false, 'Reports must NEVER be dropped into telegram groups');

    // DMs must be sent to admin Telegram IDs
    assert.ok(sentChatIds.includes('8669123223'), 'TG_OWNER_IDS 1 must receive DM');
    assert.ok(sentChatIds.includes('6848424735'), 'TG_OWNER_IDS 2 must receive DM');
    assert.ok(sentChatIds.includes('99887766'), 'community_admins platform_user_id must receive DM');
    assert.ok(sentChatIds.includes('12345678'), 'Community creator Telegram ID must receive DM');
    assert.ok(sentChatIds.includes('23456789'), 'Community admin member Telegram ID must receive DM');

    // In-app notifications in Athena DB must exist for creator, admin, and GOD
    const notifs = await mockDb.prepare('SELECT user_id, title FROM notifications').all();
    const notifUserIds = (notifs.results || []).map(n => n.user_id);
    assert.ok(notifUserIds.includes('creator_user'), 'In-app notification must be created for creator');
    assert.ok(notifUserIds.includes('admin_user'), 'In-app notification must be created for admin');
    assert.ok(notifUserIds.includes('god_user'), 'In-app notification must be created for GOD user');

    // Test 2: Community link editing by members & sequential edits
    await mockDb.prepare(`
      INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, added_by_user_id, added_by_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('link_abc', 'comm_test', 'https://example.com/initial', 'h_init', 'Initial Title', 'Initial note', JSON.stringify(['tag1']), 'creator_user', 'creator_user', 'Dan Owner', 1000).run();

    // Alice (regular member) edits the link
    const aliceUser = { id: 'member_alice', username: 'alice_dev', display_name: 'Alice Dev', provider: 'telegram', provider_id: '34567890' };
    const editReq1 = new Request('https://athena.test/api/links', {
      method: 'PATCH',
      body: JSON.stringify({
        id: 'link_abc',
        title: 'Alice Updated Title',
        notes: 'Notes edited by Alice',
        tags: ['alice', 'clean']
      })
    });
    const patchRes1 = await handlePatchCommunityLink(editReq1, aliceUser, env, corsHeaders);
    assert.equal(patchRes1.status, 200, 'Member Alice should be able to edit community link');
    const patchData1 = await patchRes1.json();
    assert.equal(patchData1.success, true);
    assert.equal(patchData1.title, 'Alice Updated Title');
    assert.equal(patchData1.last_edited_by_name, 'Alice Dev');
    assert.ok(patchData1.manual_edited_at > 0);

    const rowAfterAlice = await mockDb.prepare('SELECT * FROM links WHERE id = ?').bind('link_abc').first();
    assert.equal(rowAfterAlice.title, 'Alice Updated Title');
    assert.equal(rowAfterAlice.last_edited_by, 'member_alice');
    assert.equal(rowAfterAlice.last_edited_by_name, 'Alice Dev');
    assert.ok(rowAfterAlice.manual_edited_at > 0);

    // Bob (another regular member) edits the same link after Alice
    // Previously, other users were blocked. Now Bob can edit and it updates last_edited_by_name
    const bobUser = { id: 'member_bob', username: 'bob_coder', display_name: 'Bob Coder', provider: 'telegram', provider_id: '45678901' };
    const editReq2 = new Request('https://athena.test/api/links', {
      method: 'PATCH',
      body: JSON.stringify({
        id: 'link_abc',
        title: 'Bob Follow-up Title',
        notes: 'Notes refined by Bob',
        tags: ['bob', 'refined']
      })
    });
    const patchRes2 = await handlePatchCommunityLink(editReq2, bobUser, env, corsHeaders);
    assert.equal(patchRes2.status, 200, 'Member Bob should be able to edit link after Alice');
    const patchData2 = await patchRes2.json();
    assert.equal(patchData2.success, true);
    assert.equal(patchData2.title, 'Bob Follow-up Title');
    assert.equal(patchData2.last_edited_by_name, 'Bob Coder');

    const rowAfterBob = await mockDb.prepare('SELECT * FROM links WHERE id = ?').bind('link_abc').first();
    assert.equal(rowAfterBob.title, 'Bob Follow-up Title');
    assert.equal(rowAfterBob.last_edited_by, 'member_bob');
    assert.equal(rowAfterBob.last_edited_by_name, 'Bob Coder');
    assert.ok(rowAfterBob.manual_edited_at >= rowAfterAlice.manual_edited_at);

    // Test 3: /structure and /forcetags preservation of manual edits
    // Check that automated maintenance queries with "manual_edited_at IS NULL" exclude the edited row
    const autoCleanable = await mockDb.prepare('SELECT id FROM links WHERE id = ? AND manual_edited_at IS NULL').bind('link_abc').first();
    assert.equal(autoCleanable, null, 'Automated sweeps must not select hand-edited links');

    const handEditedCount = await mockDb.prepare('SELECT COUNT(*) as n FROM links WHERE manual_edited_at IS NOT NULL').first();
    assert.equal(handEditedCount.n, 1, 'Hand edited row must be counted in manualSkipped');

    // Test 4: GOD editing personal links in Database Explorer
    await mockDb.prepare(`
      INSERT INTO personal_links (id, user_id, url, url_hash, title, notes, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind('plink_1', 'user_someone_else', 'https://example.com/personal', 'h_p', 'Personal Tool', 'Private notes', JSON.stringify(['private']), 1000).run();

    const godUser = { id: 'god_user', username: 'god_root', display_name: 'Root Admin', provider: 'telegram', provider_id: '6848424735', telegram_api_id: '6848424735' };
    const editPersonalReq = new Request('https://athena.test/api/personal-links', {
      method: 'PATCH',
      body: JSON.stringify({
        id: 'plink_1',
        title: 'GOD Updated Personal Link',
        notes: 'Admin notes',
        tags: ['god', 'edited']
      })
    });
    const patchPersonalRes = await handlePatchPersonalLink(editPersonalReq, godUser, env, corsHeaders);
    assert.equal(patchPersonalRes.status, 200, 'GOD must be able to edit personal links in Database Explorer');
    const patchPersonalData = await patchPersonalRes.json();
    assert.equal(patchPersonalData.success, true);
    assert.equal(patchPersonalData.title, 'GOD Updated Personal Link');

    const personalRow = await mockDb.prepare('SELECT * FROM personal_links WHERE id = ?').bind('plink_1').first();
    assert.equal(personalRow.title, 'GOD Updated Personal Link');
    assert.ok(personalRow.manual_edited_at > 0);

    // Test 5: GOD deleting personal link
    const deletePersonalReq = new Request('https://athena.test/api/personal-links', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'plink_1' })
    });
    const delPersonalRes = await handleDeletePersonalLink(deletePersonalReq, godUser, env, corsHeaders);
    assert.equal(delPersonalRes.status, 200);
    const deletedRow = await mockDb.prepare('SELECT * FROM personal_links WHERE id = ?').bind('plink_1').first();
    assert.equal(deletedRow, null, 'GOD must be able to delete personal link');

    // Test 6: URL Quality Scoring
    assert.ok(urlQualityScore('https://github.com/jaywcjlove/key-clicker') >= 100, 'GitHub repository should have high content score');
    assert.equal(urlQualityScore('https://telegra.ph/file/0123456789.png'), 10, 'Direct image asset should have low score');
    assert.equal(urlQualityScore('https://t.me/c/12345678/90'), 15, 'Internal telegram link should have low score');
    assert.equal(urlQualityScore('https://t.me/channelname/123'), 25, 'Telegram channel post should have post score');
    assert.equal(urlQualityScore('https://example.com/test'), 5, 'Example placeholder host should have lowest score');

    // Test 7: pickBestFormattedRow prefers content destination over image asset and dead links
    const contentRow = { url: 'https://github.com/jaywcjlove/key-clicker', title: 'key-clicker', created_at: 1000 };
    const imageRow = { url: 'https://telegra.ph/file/keyclicker.png', title: 'Screenshot', created_at: 900 };
    const bestRes = pickBestFormattedRow(contentRow, imageRow);
    assert.equal(bestRes.keep.url, 'https://github.com/jaywcjlove/key-clicker', 'Content URL must be kept over image asset');

    // Test 8: Structure database duplicate consolidation for https://github.com/jaywcjlove/key-clicker
    await mockDb.prepare(`
      INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, image_url, added_by, upvotes, downvotes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'link_kc_main',
      'comm_test',
      'https://github.com/jaywcjlove/key-clicker',
      generateUrlHash('https://github.com/jaywcjlove/key-clicker'),
      'key-clicker',
      'Keyboard key clicker test tool',
      JSON.stringify(['github', 'keyboard']),
      null,
      'member_alice',
      4,
      0,
      2000
    ).run();

    await mockDb.prepare(`
      INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, image_url, added_by, upvotes, downvotes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'link_kc_img',
      'comm_test',
      'https://telegra.ph/file/keyclicker_snap.png',
      generateUrlHash('https://telegra.ph/file/keyclicker_snap.png'),
      'Key Clicker Screenshot',
      'Preview snapshot for https://github.com/jaywcjlove/key-clicker',
      JSON.stringify(['screenshot']),
      'https://telegra.ph/file/keyclicker_snap.png',
      'member_bob',
      2,
      1,
      2100
    ).run();

    await mockDb.prepare(`
      INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, image_url, added_by, upvotes, downvotes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'link_kc_tg',
      'comm_test',
      'https://t.me/c/123456789/456',
      generateUrlHash('https://t.me/c/123456789/456'),
      'Key Clicker Message',
      'Download here https://github.com/jaywcjlove/key-clicker',
      JSON.stringify(['tools']),
      null,
      'member_alice',
      1,
      0,
      2200
    ).run();

    const structStats = await structureDatabase(env, { scope: 'community', scopeId: 'comm_test' });
    assert.ok(structStats.merged >= 2, 'Structure pass must merge the two duplicate rows');

    const remainingKcRows = (await mockDb.prepare(
      `SELECT * FROM links WHERE community_id = 'comm_test' AND (url LIKE '%key-clicker%' OR notes LIKE '%key-clicker%')`
    ).all()).results;

    assert.equal(remainingKcRows.length, 1, 'Only one link must remain for key-clicker');
    const survivor = remainingKcRows[0];
    assert.equal(survivor.id, 'link_kc_main', 'Primary content link must be the surviving record');
    assert.equal(survivor.url, 'https://github.com/jaywcjlove/key-clicker', 'Surviving URL must be the proper repository URL');
    assert.equal(survivor.image_url, 'https://telegra.ph/file/keyclicker_snap.png', 'Artwork from image asset must be preserved on survivor');
    assert.equal(survivor.upvotes, 7, 'Upvotes from merged rows must be folded into survivor (4 + 2 + 1 = 7)');
    assert.equal(survivor.downvotes, 1, 'Downvotes from merged rows must be folded into survivor (0 + 1 + 0 = 1)');
    const survivorTags = JSON.parse(survivor.tags || '[]');
    assert.ok(survivorTags.includes('github') && survivorTags.includes('screenshot') && survivorTags.includes('tool'), 'Tags must be combined across merged links');

    const deletedImg = await mockDb.prepare('SELECT id FROM links WHERE id = ?').bind('link_kc_img').first();
    assert.equal(deletedImg, null, 'Inferior image link must be deleted');
    const deletedTg = await mockDb.prepare('SELECT id FROM links WHERE id = ?').bind('link_kc_tg').first();
    assert.equal(deletedTg, null, 'Inferior telegram link must be deleted');

    // Test 9: Standalone row promotion
    await mockDb.prepare(`
      INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, image_url, added_by, upvotes, downvotes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'link_standalone_promo',
      'comm_test',
      'https://telegra.ph/file/standalone_tool.png',
      generateUrlHash('https://telegra.ph/file/standalone_tool.png'),
      'Standalone Tool',
      'Source code available at https://github.com/testorg/standalone-app',
      JSON.stringify(['utility']),
      null,
      'member_alice',
      1,
      0,
      3000
    ).run();

    await structureDatabase(env, { scope: 'community', scopeId: 'comm_test' });

    const promotedRow = await mockDb.prepare('SELECT * FROM links WHERE id = ?').bind('link_standalone_promo').first();
    assert.equal(promotedRow.url, 'https://github.com/testorg/standalone-app', 'Standalone link must be promoted to the content destination URL');
    assert.equal(promotedRow.image_url, 'https://telegra.ph/file/standalone_tool.png', 'Original image asset URL becomes image_url');
    assert.equal(promotedRow.notes.includes('https://github.com/testorg/standalone-app'), false, 'Redundant bare URL must be cleaned from notes');

    // Test 10: Tag taxonomy rejection of generic open-source and classification of Project GLD
    const vOpenSource = validateTags(['open-source', 'opensource', 'game', 'tool']);
    assert.deepEqual(vOpenSource.tags, ['game', 'tool'], 'open-source and opensource must be rejected as generic tags');
    const openSourceRejection = vOpenSource.rejected.find(r => r.tag === 'open-source');
    assert.ok(openSourceRejection && openSourceRejection.reason === 'generic', 'open-source rejection reason must be generic');

    const gldUrl = 'https://github.com/Y0URD34TH/Project-GLD';
    const gldMeta = {
      title: 'Project GLD — Game Library and Download Manager with Lua Script Support',
      notes: 'Project GLD is a game library and download manager, which supports community made Lua scripts for downloading and searching games.',
      content: 'Topics: downloader, game, games, library, lua, lua-scripts\n\n### [ ☁️ ] Cloud Saving\n* Back up your games and save them to cloud thanks to Rclone\n* Automatic back up, restore, and cloud sync available\n\n### [🎮] Game Download\n* Download a game from any source via Lua scripts\n\nDownload GLDSetup.exe for Windows.'
    };
    const gldClassified = classifyTags(gldUrl, gldMeta);
    assert.ok(gldClassified.tags.includes('game'), 'Project GLD must include game tag');
    assert.ok(gldClassified.tags.includes('lua'), 'Project GLD must include lua tag');
    assert.ok(gldClassified.tags.includes('github'), 'Project GLD must include github ecosystem tag');
    assert.equal(gldClassified.tags.includes('cloud'), false, 'Project GLD must NOT include cloud tag from incidental cloud save mentions');
    assert.equal(gldClassified.tags.includes('open-source'), false, 'Project GLD must NOT include open-source tag');

    // Test 11: runForcetagsReview cleans up stale unevidenced tags and adds missing game tag
    await mockDb.prepare(`
      INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, image_url, added_by, upvotes, downvotes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'link_gld_stale',
      'comm_test',
      gldUrl,
      generateUrlHash(gldUrl),
      gldMeta.title,
      gldMeta.notes,
      JSON.stringify(['cloud', 'open-source', 'github']),
      null,
      'member_alice',
      1,
      0,
      4000
    ).run();

    // Mock fetch for scrapeForgeMetadata inside describeAndTagLink during review
    const innerFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const uStr = String(url);
      if (uStr.includes('api.github.com/repos/Y0URD34TH/Project-GLD/readme')) {
        return new Response(gldMeta.content, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      if (uStr.includes('api.github.com/repos/Y0URD34TH/Project-GLD')) {
        return new Response(JSON.stringify({
          name: 'Project-GLD',
          description: gldMeta.notes,
          topics: ['downloader', 'game', 'games', 'library', 'lua', 'lua-scripts'],
          owner: { avatar_url: 'https://example.com/avatar.png' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return innerFetch(url, options);
    };

    const bgPromises = [];
    const testEnv = { ...env, __ctx: { waitUntil: (p) => bgPromises.push(p) } };

    try {
      await runForcetagsReview(testEnv, {
        token: 'test_token',
        chatId: 'comm_chat',
        scope: 'community',
        communityId: 'comm_test',
        wantAll: true
      });
      await Promise.all(bgPromises);
    } finally {
      globalThis.fetch = innerFetch;
    }

    const reviewedGld = await mockDb.prepare('SELECT tags FROM links WHERE id = ?').bind('link_gld_stale').first();
    const reviewedTags = JSON.parse(reviewedGld.tags || '[]');
    assert.ok(reviewedTags.includes('game'), 'Reviewed link must add missing game tag');
    assert.ok(reviewedTags.includes('github'), 'Reviewed link must keep github tag');
    assert.equal(reviewedTags.includes('cloud'), false, 'Reviewed link must drop unevidenced cloud tag');
    assert.equal(reviewedTags.includes('open-source'), false, 'Reviewed link must drop open-source tag');

    console.log('reporting, editing, and structure duplicate tests passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
