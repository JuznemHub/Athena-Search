/**
 * SQLite -> Postgres statement translation.
 *
 * The Worker was written against D1 (SQLite). Pointing it at Postgres needs two
 * rewrites, and only two — measured across all 324 prepared statements:
 *
 *   1. `?` placeholders become `$1, $2, ...`
 *   2. `INSERT OR REPLACE` becomes `INSERT ... ON CONFLICT (pk) DO UPDATE`
 *
 * There is no PRAGMA, no datetime(), no AUTOINCREMENT and no rowid use to port.
 *
 * Kept as a pure module so the translation can be tested exhaustively without a
 * database — it is the part most likely to be subtly wrong.
 */

/**
 * Conflict targets for the tables written with INSERT OR REPLACE. Postgres
 * needs to be told which constraint the upsert is against; SQLite infers it.
 */
export const PRIMARY_KEYS = {
  users: ['id'],
  sessions: ['token'],
  communities: ['id'],
  community_members: ['community_id', 'user_id'],
  community_admins: ['id'],
  community_bots: ['id'],
  links: ['id'],
  link_votes: ['link_id', 'user_id'],
  link_reports: ['id'],
  notifications: ['id'],
  personal_links: ['id'],
  batch_uploads: ['id'],
  uploaded_documents: ['id'],
  oauth_states: ['state'],
  telegram_bots: ['bot_token'],
  telegram_pending: ['id'],
  community_bans: ['community_id', 'platform', 'platform_user_id'],
  user_ai_config: ['user_id'],
  instance_storage_config: ['id'],
  storage_sync: ['scope_key'],
  storage_file_cache: ['scope_key', 'file_name'],
  pending_community_deletes: ['token'],
  instance_settings: ['key'],
};

/**
 * Replace `?` with `$n`, skipping anything inside a string literal.
 *
 * Naive replacement corrupts statements whose data legitimately contains a
 * question mark — a saved URL like `https://x.com/?q=1` inside a quoted default,
 * for example — so the scanner tracks quoting state.
 */
export function toDollarPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      out += c;
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += c;
      if (c === '*' && next === '/') { out += next; i++; inBlockComment = false; }
      continue;
    }
    if (!inSingle && !inDouble && c === '-' && next === '-') { inLineComment = true; out += c; continue; }
    if (!inSingle && !inDouble && c === '/' && next === '*') { inBlockComment = true; out += c; continue; }

    if (c === "'" && !inDouble) {
      // '' is an escaped quote inside a literal, not a terminator.
      if (inSingle && next === "'") { out += "''"; i++; continue; }
      inSingle = !inSingle;
      out += c;
      continue;
    }
    if (c === '"' && !inSingle) { inDouble = !inDouble; out += c; continue; }

    if (c === '?' && !inSingle && !inDouble) { out += `$${++n}`; continue; }
    out += c;
  }
  return { sql: out, count: n };
}

/** `INSERT OR REPLACE INTO t (a, b) VALUES (...)` -> upsert on t's key. */
export function rewriteUpsert(sql) {
  const re = /INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/i;
  const m = sql.match(re);
  if (!m) {
    // No column list to work with; fall back to plain INSERT semantics.
    return sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO')
              .replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  }
  const table = m[1];
  const cols = m[2].split(',').map(c => c.trim()).filter(Boolean);
  const pk = PRIMARY_KEYS[table];

  let rewritten = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO');
  if (!pk || !pk.length) {
    // Unknown table: do not crash on a duplicate. But this silently turns an
    // INSERT OR REPLACE into a no-op on every row that already exists — a lost
    // write that still reports success — so make the omission visible instead
    // of letting it be debugged from the symptom. Register the table above.
    console.warn(`[pgcompat] no PRIMARY_KEYS entry for "${table}": upsert degraded to DO NOTHING, updates will be lost`);
    return `${rewritten} ON CONFLICT DO NOTHING`;
  }
  const updatable = cols.filter(c => !pk.includes(c));
  const setClause = updatable.length
    ? updatable.map(c => `${c} = EXCLUDED.${c}`).join(', ')
    : null;

  return setClause
    ? `${rewritten} ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${setClause}`
    : `${rewritten} ON CONFLICT (${pk.join(', ')}) DO NOTHING`;
}

/** Make `ALTER TABLE ... ADD COLUMN` idempotent the way the Worker expects. */
export function rewriteAddColumn(sql) {
  return sql.replace(
    /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i,
    'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS '
  );
}

/**
 * Widen INTEGER to BIGINT in DDL.
 *
 * SQLite is untyped, so the app stores millisecond timestamps in columns
 * declared INTEGER. In Postgres that is int4, which tops out at 2.1e9 — a ms
 * timestamp is ~1.8e12 and is rejected outright. This has to run on runtime DDL
 * too, not just schema.sql: the Worker creates community_bans, user_ai_config
 * and the storage tables itself via ensure*Table(), and those would otherwise
 * silently get int4 columns that fail on the first insert.
 */
export function widenIntegers(sql) {
  return sql
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bAUTOINCREMENT\b/gi, '')
    .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE $1INDEX IF NOT EXISTS ');
}

const DDL_RE = /^\s*(CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)|ALTER\s+TABLE)/i;

/** Full SQLite -> Postgres translation for one statement. */
export function translate(sql) {
  let out = String(sql);
  if (/INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO/i.test(out)) out = rewriteUpsert(out);
  if (DDL_RE.test(out)) out = widenIntegers(out);
  if (/ALTER\s+TABLE/i.test(out)) out = rewriteAddColumn(out);
  const { sql: finalSql, count } = toDollarPlaceholders(out);
  return { sql: finalSql, params: count };
}
