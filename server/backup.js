/**
 * Periodic backups for self-hosted mode (PostgreSQL).
 *
 * The self-hosted database is the source of truth, so it has to leave the box.
 *
 *   Telegram  — always, when a bot token + chat id resolve. Effectively
 *               unlimited retention; the Bot API caps one upload at 50 MB so
 *               larger dumps are split into parts (rejoin with server/restore.js).
 *   Drive     — optional, only when GDRIVE_* are configured.
 *
 * The dump is produced in pure JS rather than by shelling out to pg_dump, so it
 * works wherever Node runs without depending on client tools being installed or
 * matching the server version. It is plain SQL: restorable with psql, or with
 * server/restore.js.
 */
import { createGzip, gunzipSync } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const PUBLIC_API = 'https://api.telegram.org';
/** Cloud Bot API caps an upload at 50MB. A self-hosted Bot API server allows 2GB. */
const CLOUD_MAX_BYTES = 49 * 1024 * 1024;
const LOCAL_MAX_BYTES = 1900 * 1024 * 1024;

export function apiBase(env) {
  return String(env.TELEGRAM_API_BASE || PUBLIC_API).replace(/\/+$/, '');
}
function isLocalApi(env) {
  return apiBase(env) !== PUBLIC_API;
}
/** Bytes per uploaded part. BACKUP_PART_BYTES overrides (useful on slow links). */
export function partSize(env) {
  const override = parseInt(env.BACKUP_PART_BYTES || '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return isLocalApi(env) ? LOCAL_MAX_BYTES : CLOUD_MAX_BYTES;
}

/**
 * Use whatever bot the instance was already set up with, rather than making the
 * operator configure a second token.
 */
async function resolveBotAndChat(db, env) {
  let token = env.BACKUP_TELEGRAM_TOKEN || '';
  let chatId = env.BACKUP_TELEGRAM_CHAT_ID || '';

  if (db) {
    try {
      if (!token) {
        const row = await db.prepare(
          `SELECT bot_token FROM community_bots
           WHERE platform = 'telegram' AND bot_token IS NOT NULL AND bot_token != ''
           ORDER BY created_at DESC LIMIT 1`
        ).first();
        if (row?.bot_token) token = row.bot_token;
      }
      if (!chatId) {
        // A personal-scope binding's group_id IS the owner's Telegram user id.
        const dm = await db.prepare(
          `SELECT group_id FROM community_bots
           WHERE platform = 'telegram' AND COALESCE(scope,'personal') = 'personal'
             AND group_id IS NOT NULL AND CAST(group_id AS TEXT) NOT LIKE '-%'
           ORDER BY created_at DESC LIMIT 1`
        ).first();
        if (dm?.group_id) chatId = String(dm.group_id);
      }
    } catch (_) { /* fall back to env */ }
  }

  if (!token) token = env.TELEGRAM_BOT_TOKEN || '';
  if (!chatId) {
    const owners = String(env.TG_OWNER_IDS || '').split(/[,;\s]+/).filter(Boolean);
    if (owners.length) chatId = owners[0];
  }
  return { token, chatId };
}

/**
 * Logical dump of every table in the public schema, as portable SQL.
 *
 * Runs inside a REPEATABLE READ read-only transaction so the snapshot is
 * consistent even while a Telegram group is actively dumping links — reading
 * table by table without one can capture a half-applied write.
 */
export async function dumpDatabase(connectionString) {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const lines = [
    '-- Athena logical backup',
    `-- taken ${new Date().toISOString()}`,
    'BEGIN;',
  ];
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Order tables parents-first so a restore satisfies foreign keys naturally.
    // Deferring them instead would need SET session_replication_role, which is
    // superuser-only and a self-hosted app role will not have.
    const tables = await orderedTables(client);

    // Emit the schema too. A data-only dump cannot be restored into a fresh
    // database, because schema.sql is not the whole truth — the Worker adds
    // columns and whole tables at runtime (users.telegram_api_id, search_blob,
    // community_bans...). Reconstructing DDL from the live catalog makes the
    // backup self-contained.
    for (const t of tables) lines.push(await tableDdl(client, t));
    for (const t of tables) {
      const idx = await indexDdl(client, t);
      if (idx) lines.push(idx);
    }

    // Wipe children before parents.
    for (const t of [...tables].reverse()) lines.push(`DELETE FROM "${t}";`);
    for (const tablename of tables) {
      const { rows } = await client.query(`SELECT * FROM "${tablename}"`);
      lines.push(`\n-- ${tablename}: ${rows.length} row(s)`);
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return String(v);
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          if (v instanceof Date) return client.escapeLiteral(v.toISOString());
          if (typeof v === 'object') return client.escapeLiteral(JSON.stringify(v));
          return client.escapeLiteral(String(v));
        });
        lines.push(`INSERT INTO "${tablename}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${vals.join(', ')});`);
      }
    }
    await client.query('COMMIT');
  } finally {
    await client.end().catch(() => {});
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

/** CREATE TABLE reconstructed from the live catalog, including the primary key. */
async function tableDdl(client, table) {
  const { rows: cols } = await client.query(`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);

  const { rows: pk } = await client.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass AND i.indisprimary
  `, [`"${table}"`]);

  const defs = cols.map(c => {
    let type = c.data_type;
    if (type === 'character varying' && c.character_maximum_length) type = `varchar(${c.character_maximum_length})`;
    let s = `  "${c.column_name}" ${type}`;
    if (c.column_default) s += ` DEFAULT ${c.column_default}`;
    if (c.is_nullable === 'NO') s += ' NOT NULL';
    return s;
  });
  if (pk.length) defs.push(`  PRIMARY KEY (${pk.map(p => `"${p.attname}"`).join(', ')})`);

  return `\nCREATE TABLE IF NOT EXISTS "${table}" (\n${defs.join(',\n')}\n);`;
}

/** Unique indexes matter: link de-duplication depends on them. */
async function indexDdl(client, table) {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table]
  );
  const out = rows
    .map(r => r.indexdef)
    // Primary keys come with the table; only separate indexes are needed here.
    .filter(d => !/_pkey\b/.test(d))
    .map(d => d.replace(/^CREATE (UNIQUE )?INDEX /i, 'CREATE $1INDEX IF NOT EXISTS ') + ';');
  return out.join('\n');
}

/**
 * Table names sorted so every table comes after the ones it references.
 * A plain alphabetical dump restores children before parents and trips the
 * foreign keys.
 */
async function orderedTables(client) {
  const { rows: all } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const names = all.map(r => r.tablename);
  const { rows: deps } = await client.query(`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
  `);

  const parents = new Map(names.map(n => [n, new Set()]));
  for (const d of deps) {
    const child = d.child.replace(/^public\./, '').replace(/"/g, '');
    const parent = d.parent.replace(/^public\./, '').replace(/"/g, '');
    if (child !== parent && parents.has(child)) parents.get(child).add(parent);
  }

  const out = [];
  const seen = new Set();
  const visit = (n, stack = new Set()) => {
    if (seen.has(n) || stack.has(n)) return; // cycles: emit in whatever order
    stack.add(n);
    for (const p of (parents.get(n) || [])) visit(p, stack);
    stack.delete(n);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  };
  for (const n of names.sort()) visit(n);
  return out;
}

async function snapshot(connectionString) {
  const dir = await mkdtemp(join(tmpdir(), 'athena-backup-'));
  const raw = join(dir, 'athena.sql');
  const gz = `${raw}.gz`;
  await writeFile(raw, await dumpDatabase(connectionString), 'utf8');
  await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(gz));
  await unlink(raw).catch(() => {});
  return gz;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export async function sendToTelegram(token, chatId, filePath, name, env) {
  const buf = await readFile(filePath);
  const max = partSize(env);
  const parts = [];
  if (buf.length <= max) {
    parts.push({ data: buf, name });
  } else {
    // Parts are plain byte ranges of the .gz, so `cat` in order rebuilds it.
    const total = Math.ceil(buf.length / max);
    for (let i = 0; i < total; i++) {
      parts.push({
        data: buf.subarray(i * max, (i + 1) * max),
        name: `${name}.part${String(i + 1).padStart(3, '0')}of${String(total).padStart(3, '0')}`,
      });
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const caption = parts.length === 1
      ? `Athena backup · ${part.name}\nRestore: gunzip -c ${name} | psql "$DATABASE_URL"`
      : `Athena backup · part ${i + 1}/${parts.length} · ${part.name}\n`
        + `Download all ${parts.length} parts into one folder, then:\n`
        + `cat ${name}.part*of${String(parts.length).padStart(3, '0')} > ${name}\n`
        + `gunzip -c ${name} | psql "$DATABASE_URL"`;

    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption.slice(0, 1024));
    form.set('document', new Blob([part.data], { type: 'application/gzip' }), part.name);
    const res = await fetch(`${apiBase(env)}/bot${token}/sendDocument`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(600000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `Telegram upload failed (${res.status})`);
  }
  return parts.length;
}

/** Exchange a long-lived refresh token for an access token. */
async function driveAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(j.error_description || j.error || 'Drive token exchange failed');
  return j.access_token;
}

async function sendToDrive(cfg, filePath, name) {
  const token = await driveAccessToken(cfg);
  const body = await readFile(filePath);
  const metadata = { name, ...(cfg.folderId ? { parents: [cfg.folderId] } : {}) };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set('file', new Blob([body], { type: 'application/gzip' }), name);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(300000) }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Drive upload failed (${res.status})`);
  return j.id;
}

/**
 * Per-scope export as Markdown, matching the GitHub layout.
 *
 * The full SQL dump is what you restore from, but it is one opaque blob. These
 * give personal and each community their own readable file, so a community can
 * be inspected or recovered on its own without unpacking the whole database.
 */
export async function scopeExports(connectionString) {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const out = [];
  try {
    const render = (rows, heading) => {
      const lines = [`# ${heading}`, '', `_${rows.length} link(s) · exported ${new Date().toISOString()}_`, ''];
      for (const r of rows) {
        let tags = r.tags;
        if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (_) { tags = []; } }
        lines.push(`## ${r.title || r.url}`);
        lines.push(`<${r.url}>`);
        if (Array.isArray(tags) && tags.length) lines.push(`Tags: ${tags.join(', ')}`);
        if (r.added_by_name) lines.push(`Added by: ${r.added_by_name}`);
        lines.push(`Added: ${new Date(Number(r.created_at) || 0).toISOString()}`);
        if (r.notes) lines.push('', String(r.notes).trim());
        lines.push('');
      }
      return lines.join('\n');
    };

    // personal_links spans every user, so carry the owner through — otherwise the
    // export is unattributable and useless for a partial restore.
    const personal = (await client.query(
      `SELECT p.*, COALESCE(u.display_name, u.username, p.user_id) AS added_by_name
         FROM personal_links p LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.user_id, p.created_at DESC`,
    )).rows;
    if (personal.length) out.push({ scope: 'personal', name: `athena-personal-${stamp()}.md`, body: render(personal, 'Athena — personal brain') });

    const comms = (await client.query('SELECT id, name FROM communities ORDER BY id')).rows;
    for (const c of comms) {
      const rows = (await client.query('SELECT * FROM links WHERE community_id = $1 ORDER BY created_at DESC', [c.id])).rows;
      if (!rows.length) continue;
      const safe = String(c.name || c.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40);
      out.push({ scope: `community:${c.id}`, name: `athena-community-${safe}-${stamp()}.md`, body: render(rows, `Athena — ${c.name || c.id}`) });
    }
  } finally {
    await client.end().catch(() => {});
  }
  return out;
}

async function gzipToTemp(text, filename) {
  const dir = await mkdtemp(join(tmpdir(), 'athena-scope-'));
  const raw = join(dir, filename);
  const gz = `${raw}.gz`;
  await writeFile(raw, text, 'utf8');
  await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(gz));
  await unlink(raw).catch(() => {});
  return gz;
}

export async function runBackupOnce({ connectionString, env, db = null }) {
  const name = `athena-${stamp()}.sql.gz`;
  const temps = [];
  try {
    const gz = await snapshot(connectionString);
    temps.push(gz);
    const size = (await stat(gz)).size;
    console.log(`[backup] dump ${name} (${(size / 1e6).toFixed(2)} MB gzipped)`);

    // Personal and each community also go out as their own file, so the two
    // are recoverable and reviewable independently of one another.
    const files = [{ name, path: gz, label: 'full database' }];
    if (String(env.BACKUP_SPLIT_SCOPES ?? '1') === '1') {
      try {
        for (const s of await scopeExports(connectionString)) {
          const p = await gzipToTemp(s.body, s.name);
          temps.push(p);
          files.push({ name: `${s.name}.gz`, path: p, label: s.scope });
        }
      } catch (err) {
        console.error('[backup] scope export failed (full dump still sent):', err.message);
      }
    }

    const { token: tgToken, chatId: tgChat } = await resolveBotAndChat(db, env);
    for (const f of files) {
      if (tgToken && tgChat) {
        const parts = await sendToTelegram(tgToken, tgChat, f.path, f.name, env);
        console.log(`[backup] telegram ok · ${f.label} (${parts} part${parts > 1 ? 's' : ''}${isLocalApi(env) ? ', local Bot API' : ''})`);
      }
      if (env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET && env.GDRIVE_REFRESH_TOKEN) {
        const id = await sendToDrive({
          clientId: env.GDRIVE_CLIENT_ID,
          clientSecret: env.GDRIVE_CLIENT_SECRET,
          refreshToken: env.GDRIVE_REFRESH_TOKEN,
          folderId: env.GDRIVE_FOLDER_ID || null,
        }, f.path, f.name);
        console.log(`[backup] drive ok · ${f.label} (file ${id})`);
      }
    }
    if (!tgToken || !tgChat) console.log('[backup] telegram skipped — no bot linked and no BACKUP_TELEGRAM_* set');

    return { ok: true, name, size, files: files.length };
  } catch (err) {
    console.error('[backup] FAILED:', err.message);
    return { ok: false, error: err.message };
  } finally {
    for (const t of temps) await unlink(t).catch(() => {});
  }
}

export function startBackups({ connectionString, env, db = null }) {
  const hours = parseFloat(env.BACKUP_INTERVAL_HOURS || '6');
  if (!(hours > 0)) {
    console.log('[backup] disabled (BACKUP_INTERVAL_HOURS=0)');
    return null;
  }
  const ms = Math.round(hours * 3600 * 1000);
  console.log(`[backup] every ${hours}h`);
  const timer = setInterval(() => { runBackupOnce({ connectionString, env, db }); }, ms);
  timer.unref();
  return timer;
}
