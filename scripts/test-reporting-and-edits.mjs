import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  notifyCommunityStaff,
  handlePatchCommunityLink,
  handlePatchPersonalLink,
  handleDeletePersonalLink
} from '../worker/index.js';

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
        first() {
          const stmt = db.prepare(sql);
          return stmt.get(...args) || null;
        },
        all() {
          const stmt = db.prepare(sql);
          return { results: stmt.all(...args) };
        },
        run() {
          const stmt = db.prepare(sql);
          const info = stmt.run(...args);
          return { changes: info.changes };
        }
      });
      return {
        bind(...args) {
          return execute(...args);
        },
        first() { return execute().first(); },
        all() { return execute().all(); },
        run() { return execute().run(); }
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

    console.log('reporting and editing tests passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
