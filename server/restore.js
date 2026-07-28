#!/usr/bin/env node
/**
 * Rebuild a PostgreSQL database from backup parts downloaded out of Telegram.
 *
 *   node server/restore.js ./downloads
 *   node server/restore.js ./downloads "postgresql://user:pass@host/db"
 *
 * Parts are plain byte ranges of the gzip, so this is `cat` in order then
 * gunzip — it just sorts them correctly and refuses an incomplete set, which is
 * the easy thing to get wrong by hand.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import pg from 'pg';

const input = resolve(process.argv[2] || '.');
const url = process.argv[3] || process.env.DATABASE_URL;
if (!url) {
  console.error('Need a connection string: argv[3] or DATABASE_URL');
  process.exit(1);
}

const PART_RE = /\.part(\d+)of(\d+)$/;

async function collect() {
  const s = await stat(input);
  if (s.isFile()) return [input];

  const names = (await readdir(input)).filter(n => n.includes('.sql.gz'));
  const parts = names.filter(n => PART_RE.test(n));
  if (!parts.length) {
    const whole = names.filter(n => n.endsWith('.sql.gz')).sort();
    if (!whole.length) throw new Error(`No backup files found in ${input}`);
    return [join(input, whole[whole.length - 1])];
  }

  const groups = new Map();
  for (const n of parts) {
    const base = n.replace(PART_RE, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(n);
  }
  const base = [...groups.keys()].sort().pop();
  const chosen = groups.get(base);
  const total = parseInt(chosen[0].match(PART_RE)[2], 10);
  chosen.sort((a, b) => parseInt(a.match(PART_RE)[1], 10) - parseInt(b.match(PART_RE)[1], 10));

  const seen = chosen.map(n => parseInt(n.match(PART_RE)[1], 10));
  const missing = [];
  for (let i = 1; i <= total; i++) if (!seen.includes(i)) missing.push(i);
  if (missing.length) {
    throw new Error(`Missing part(s) ${missing.join(', ')} of ${total} for ${base} — download them all first`);
  }
  console.log(`${base}: ${total} parts, all present`);
  return chosen.map(n => join(input, n));
}

const files = await collect();
const chunks = [];
for (const f of files) chunks.push(await readFile(f));
const sql = gunzipSync(Buffer.concat(chunks)).toString('utf8');
console.log(`decompressed ${(sql.length / 1e6).toFixed(2)} MB of SQL`);

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  const t = await client.query("SELECT COUNT(*) n FROM pg_tables WHERE schemaname='public'");
  let users = 0, links = 0;
  try { users = (await client.query('SELECT COUNT(*) n FROM users')).rows[0].n; } catch (_) {}
  try { links = (await client.query('SELECT COUNT(*) n FROM links')).rows[0].n; } catch (_) {}
  console.log(`restored: ${t.rows[0].n} tables, ${users} users, ${links} community links`);
} finally {
  await client.end();
}
