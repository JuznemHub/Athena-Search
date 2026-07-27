#!/usr/bin/env node
/**
 * Copy a live Cloudflare D1 database into the self-hosted PostgreSQL database.
 *
 * Switching to self-hosted mode is a redeploy, not a setting — the two run on
 * different machines with different databases. Without this you would start
 * empty. Run it once, before pointing the Telegram webhook at the new host.
 *
 *   CLOUDFLARE_API_TOKEN=... CF_ACCOUNT_ID=... CF_DATABASE_ID=... \
 *   node server/migrate-from-cloudflare.js
 *
 * Safe to re-run: rows are upserted by primary key, so nothing is duplicated.
 * Existing local rows that are absent upstream are left alone.
 */
import { PostgresD1, translateSchema } from './pgdb.js';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DATABASE = process.env.CF_DATABASE_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !ACCOUNT || !DATABASE || !DATABASE_URL) {
  console.error('Need CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, CF_DATABASE_ID and DATABASE_URL.');
  process.exit(1);
}

// Ordered so parents land before children (foreign keys).
const TABLES = [
  'users', 'communities', 'community_members', 'community_admins',
  'community_bots', 'links', 'link_votes', 'link_reports', 'notifications',
  'personal_links', 'uploaded_documents', 'sessions', 'community_bans', 'user_ai_config',
  'instance_storage_config', 'parked_links', 'parked_personal_links',
];

async function remoteQuery(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(60000),
    }
  );
  const j = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result?.[0]?.results ?? [];
}

const local = new PostgresD1(DATABASE_URL);
try {
  const schema = await readFile(join(ROOT, 'worker', 'schema.sql'), 'utf8');
  await local.exec(translateSchema(schema));
} catch (err) {
  console.error('schema failed:', err.message);
  process.exit(1);
}
// The Worker creates several tables at runtime; make them here so a migration
// run before first boot does not silently skip their data.
await local.exec(translateSchema(`
  CREATE TABLE IF NOT EXISTS community_bans (community_id TEXT NOT NULL, platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, user_id TEXT, reason TEXT, created_at INTEGER, PRIMARY KEY (community_id, platform, platform_user_id));
  CREATE TABLE IF NOT EXISTS user_ai_config (user_id TEXT PRIMARY KEY, base_url TEXT, api_key TEXT, model TEXT, mode TEXT, updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS instance_storage_config (id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'd1', repo TEXT, branch TEXT, token TEXT, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS storage_sync (scope_key TEXT PRIMARY KEY, sig TEXT, checked_at INTEGER NOT NULL);
`));

// TABLES is ordered parents-first, which is enough: deferring FK checks would
// need superuser (SET session_replication_role), which a self-host role lacks.

/**
 * schema.sql is not the whole truth — the Worker adds columns at runtime
 * (users.telegram_api_id, search_blob, link metadata...). Without this the
 * users insert fails and every dependent table fails with it, leaving a
 * near-empty database that looks like a successful migration.
 */
async function ensureColumns(table, cols) {
  let existing;
  try {
    const r = await local.prepare(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $public$ AND table_name = ?'
    ).bind(table).all();
    existing = new Set((r.results || []).map(c => c.column_name));
  } catch (_) { return; }
  if (!existing.size) return;
  for (const c of cols) {
    if (existing.has(c)) continue;
    try {
      await local.exec(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${c}" TEXT`);
      console.log(`    + ${table}.${c}`);
    } catch (_) { /* the insert will report it if this mattered */ }
  }
}

let grand = 0;
for (const table of TABLES) {
  let rows;
  try {
    rows = await remoteQuery(`SELECT * FROM ${table}`);
  } catch (err) {
    console.log(`  ${table.padEnd(26)} skipped (${String(err.message).slice(0, 60)})`);
    continue;
  }
  if (!rows.length) { console.log(`  ${table.padEnd(26)} 0`); continue; }

  const cols = Object.keys(rows[0]);
  await ensureColumns(table, cols);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  let n = 0;
  for (const r of rows) {
    try {
      await local.prepare(sql).bind(...cols.map(c => r[c])).run();
      n++;
    } catch (err) {
      console.log(`    row failed in ${table}: ${String(err.message).slice(0, 80)}`);
    }
  }
  grand += n;
  console.log(`  ${table.padEnd(26)} ${n}`);
}


console.log(`\nmigrated ${grand} row(s) into postgres`);
console.log('Next: point the Telegram webhook at the new host, then verify /api/health.');
await local.close();
