import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleAdminGetLinks, handleGetTags, syncUserCommunityAdminRoles, isCommunityAdminUser } from '../worker/index.js';

function makeMockDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE communities (
      id TEXT PRIMARY KEY,
      name TEXT,
      creator_id TEXT,
      created_at INTEGER
    );
    CREATE TABLE community_members (
      community_id TEXT,
      user_id TEXT,
      role TEXT,
      joined_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      provider TEXT,
      provider_id TEXT,
      telegram_api_id TEXT,
      created_at INTEGER
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
    CREATE TABLE links (
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
    CREATE TABLE personal_links (
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
      return {
        bind(...args) {
          return {
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
          };
        }
      };
    }
  };
}

async function runTests() {
  const mockDb = makeMockDb();
  const env = {
    DB: mockDb,
    TG_OWNER_IDS: 'god_user_123'
  };
  const corsHeaders = { 'access-control-allow-origin': '*' };

  // Setup sample data
  const db = mockDb;
  await db.prepare('INSERT INTO communities (id, name, creator_id, created_at) VALUES (?, ?, ?, ?)').bind('comm_1', 'Alpha Community', 'admin_user_456', 1000).run();
  await db.prepare('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind('comm_1', 'admin_user_456', 'owner', 1000).run();
  await db.prepare('INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind('comm_1', 'regular_user_789', 'member', 1000).run();

  await db.prepare(`
    INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, added_by_name, created_at, manual_edited_at, last_edited_by, last_edited_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind('link_1', 'comm_1', 'https://example.com/one', 'h1', 'Alpha Tool', 'Useful for coding', JSON.stringify(['ai', 'tool']), 'admin_user_456', 'Alice', 1000, null, null, null).run();

  await db.prepare(`
    INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, added_by_name, created_at, manual_edited_at, last_edited_by, last_edited_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind('link_2', 'comm_1', 'https://example.com/two', 'h2', 'Beta Docs', 'Documentation site', JSON.stringify(['docs', 'tool']), 'admin_user_456', 'Alice', 2000, 2500, 'admin_user_456', 'Alice Admin').run();

  await db.prepare(`
    INSERT INTO links (id, community_id, url, url_hash, title, notes, tags, added_by, added_by_name, created_at, manual_edited_at, last_edited_by, last_edited_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind('link_3', 'comm_1', 'https://example.com/three', 'h3', 'Gamma Untagged', 'No tags link', null, 'admin_user_456', 'Alice', 3000, null, null, null).run();

  // Test 1: Non-admin rejected
  const regUser = { id: 'regular_user_789', username: 'regular' };
  const resNonAdmin = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1'), regUser, env, corsHeaders);
  const dataNonAdmin = await resNonAdmin.json();
  assert.equal(resNonAdmin.status, 403, 'Regular member must receive 403');
  assert.equal(dataNonAdmin.code, 'ADMIN_ONLY');

  // Test 2: Admin allowed
  const adminUser = { id: 'admin_user_456', username: 'alice' };
  const resAdmin = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1'), adminUser, env, corsHeaders);
  const dataAdmin = await resAdmin.json();
  assert.equal(resAdmin.status, 200, 'Admin must receive 200');
  assert.equal(dataAdmin.success, true);
  assert.equal(dataAdmin.total, 3);
  assert.equal(dataAdmin.links.length, 3);
  const notagsEntry = dataAdmin.tags.find(t => t.name === 'notags');
  assert.ok(notagsEntry, 'notags tag should exist in top tags');
  assert.equal(notagsEntry.count, 1, 'notags count should be 1');

  // Test 3: Filter by tag
  const resTag = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1&tag=ai'), adminUser, env, corsHeaders);
  const dataTag = await resTag.json();
  assert.equal(dataTag.total, 1);
  assert.equal(dataTag.links[0].id, 'link_1');

  // Test 3b: Filter by notags
  const resNoTags = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1&tag=notags'), adminUser, env, corsHeaders);
  const dataNoTags = await resNoTags.json();
  assert.equal(dataNoTags.total, 1);
  assert.equal(dataNoTags.links[0].id, 'link_3');

  // Test 4: Filter by edited status
  const resEdited = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1&edited=edited'), adminUser, env, corsHeaders);
  const dataEdited = await resEdited.json();
  assert.equal(dataEdited.total, 1);
  assert.equal(dataEdited.links[0].id, 'link_2');
  assert.equal(dataEdited.links[0].last_edited_by_name, 'Alice Admin');
  assert.equal(dataEdited.links[0].manual_edited_at, 2500);

  // Test 5: Filter by search query
  const resQuery = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1&q=beta'), adminUser, env, corsHeaders);
  const dataQuery = await resQuery.json();
  assert.equal(dataQuery.total, 1);
  assert.equal(dataQuery.links[0].id, 'link_2');

  // Test 6: handleGetTags
  const resTags = await handleGetTags(new URL('https://athena.test/api/tags?community_id=comm_1'), adminUser, env, corsHeaders);
  const dataTags = await resTags.json();
  assert.equal(resTags.status, 200);
  assert.equal(dataTags.success, true);
  assert.ok(dataTags.tags.some(t => t.name === 'notags'));
  assert.ok(dataTags.tags.some(t => t.name === 'tool'));

  // Test 7: User promoted via Telegram bot /admin (community_admins record)
  // Simulate bot /admin command inserting into community_admins
  await db.prepare(`
    INSERT INTO community_admins (id, community_id, platform, platform_user_id, label, created_by, created_at)
    VALUES (?, ?, 'telegram', ?, ?, ?, ?)
  `).bind('adm_bot_1', 'comm_1', '55512345', 'Bob promoted', 'admin_user_456', Date.now()).run();

  const botAdminUser = {
    id: 'telegram_55512345',
    username: 'bob',
    provider: 'telegram',
    provider_id: '55512345',
    telegram_api_id: '55512345'
  };

  // Explicitly test syncUserCommunityAdminRoles
  await syncUserCommunityAdminRoles(env, botAdminUser);

  // Verify isCommunityAdminUser recognizes bot admin
  const isAdm = await isCommunityAdminUser(botAdminUser, env);
  assert.equal(isAdm, true, 'Bot promoted admin in community_admins must be recognized');

  // Verify handleAdminGetLinks loads database links for promoted bot admin
  const resBotAdmin = await handleAdminGetLinks(new URL('https://athena.test/api/admin/links?community_id=comm_1'), botAdminUser, env, corsHeaders);
  const dataBotAdmin = await resBotAdmin.json();
  assert.equal(resBotAdmin.status, 200, 'Promoted admin must receive 200');
  assert.equal(dataBotAdmin.success, true);
  assert.equal(dataBotAdmin.total, 3);
  assert.equal(dataBotAdmin.links.length, 3);
  assert.ok(dataBotAdmin.communities.some(c => c.id === 'comm_1'), 'Admin communities list must include comm_1');

  // Verify community_members sync
  const memRow = await db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').bind('comm_1', botAdminUser.id).first();
  assert.equal(memRow?.role, 'admin', 'community_members must be synced with admin role');

  console.log('admin database explorer tests passed');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
