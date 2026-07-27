#!/usr/bin/env node
/**
 * Merge duplicate Telegram identities into one account.
 *
 * Telegram hands out two different identifiers for the same person: the OIDC
 * `sub` in the browser login flow, and the Bot API id in a Mini App. Athena
 * keyed users on provider_id, so signing in both ways produced TWO accounts —
 * with personal links on one and community memberships, bans and sessions on
 * the other. The user sees a different brain depending on how they logged in,
 * and a ban on one row does not apply to the other.
 *
 * Rows are matched on their effective Bot API id (telegram_api_id, or
 * provider_id when it looks like one). The row with the most references wins,
 * ties broken by age; everything else is re-pointed at it and removed.
 *
 *   node server/merge-telegram-identities.js            # dry run, changes nothing
 *   node server/merge-telegram-identities.js --apply
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL
  || (() => { try { return (readFileSync('/etc/athena/athena.env', 'utf8').match(/^DATABASE_URL=(.+)$/m) || [])[1]; } catch (_) { return null; } })();
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }

// Every place a user id is referenced. Conflicts are possible where a natural
// key includes user_id (both rows in one community, both voting on one link),
// so those get ON CONFLICT DO NOTHING and the leftovers are deleted after.
const REFS = [
  { table: 'personal_links', col: 'user_id' },
  { table: 'community_members', col: 'user_id', conflict: '(community_id, user_id)' },
  { table: 'link_votes', col: 'user_id', conflict: '(link_id, user_id)' },
  { table: 'link_reports', col: 'reporter_id' },
  { table: 'notifications', col: 'user_id' },
  { table: 'sessions', col: 'user_id' },
  { table: 'community_bans', col: 'user_id' },
  { table: 'links', col: 'added_by_user_id' },
  { table: 'communities', col: 'creator_id' },
  { table: 'community_bots', col: 'created_by' },
  { table: 'community_bots', col: 'user_id' },
  { table: 'community_admins', col: 'created_by' },
];

const c = new pg.Client({ connectionString: url });
await c.connect();

const isBotApiId = (v) => /^\d{5,15}$/.test(String(v || ''));

const { rows: users } = await c.query(
  `SELECT id, username, display_name, provider_id, telegram_api_id, created_at
   FROM users WHERE provider = 'telegram'`
);

// Group by effective Bot API id.
const groups = new Map();
for (const u of users) {
  const key = u.telegram_api_id || (isBotApiId(u.provider_id) ? u.provider_id : null);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(u);
}

const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1);
if (!dupes.length) {
  console.log('No duplicate Telegram identities found.');
  await c.end();
  process.exit(0);
}

const refCount = async (id) => {
  let n = 0;
  for (const r of REFS) {
    try { n += Number((await c.query(`SELECT COUNT(*) n FROM "${r.table}" WHERE "${r.col}" = $1`, [id])).rows[0].n); }
    catch (_) {}
  }
  return n;
};

console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to commit) ===');

for (const [apiId, rows] of dupes) {
  const scored = [];
  for (const r of rows) scored.push({ ...r, refs: await refCount(r.id) });
  scored.sort((a, b) => b.refs - a.refs || Number(a.created_at || 0) - Number(b.created_at || 0));
  const keep = scored[0];
  const drop = scored.slice(1);

  console.log(`\ntelegram api id ${apiId}`);
  for (const r of scored) {
    console.log(`  ${r.id === keep.id ? 'KEEP ' : 'merge'} ${r.id.padEnd(34)} ${String(r.username || '').padEnd(14)} refs=${r.refs}`);
  }

  if (!APPLY) continue;

  await c.query('BEGIN');
  try {
    for (const d of drop) {
      for (const r of REFS) {
        try {
          if (r.conflict) {
            // Move what can move, then drop what would collide.
            await c.query(
              `INSERT INTO "${r.table}" SELECT * FROM "${r.table}" WHERE "${r.col}" = $1 ON CONFLICT ${r.conflict} DO NOTHING`,
              [d.id]
            ).catch(() => {});
            await c.query(
              `UPDATE "${r.table}" SET "${r.col}" = $1 WHERE "${r.col}" = $2
                 AND NOT EXISTS (SELECT 1 FROM "${r.table}" t2 WHERE t2."${r.col}" = $1
                   AND ${r.conflict.replace(/[()]/g, '').split(',').map(k => k.trim()).filter(k => k !== r.col)
                        .map(k => `t2."${k}" = "${r.table}"."${k}"`).join(' AND ') || 'TRUE'})`,
              [keep.id, d.id]
            );
            await c.query(`DELETE FROM "${r.table}" WHERE "${r.col}" = $1`, [d.id]);
          } else {
            await c.query(`UPDATE "${r.table}" SET "${r.col}" = $1 WHERE "${r.col}" = $2`, [keep.id, d.id]);
          }
        } catch (e) {
          console.log(`    warn ${r.table}.${r.col}: ${e.message.slice(0, 70)}`);
        }
      }
      await c.query('DELETE FROM users WHERE id = $1', [d.id]);
      console.log(`  merged ${d.id} -> ${keep.id}`);
    }
    // Make sure the surviving row carries the id both login paths match on.
    await c.query('UPDATE users SET telegram_api_id = $1 WHERE id = $2', [apiId, keep.id]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('  FAILED, rolled back:', e.message);
  }
}

// Rows can also reference a user id that no longer exists — e.g. personal links
// written under `telegram_<botApiId>` when no such account was ever created, or
// after an account was replaced. The data is real; only the owner is dangling.
// Adopt those into the account carrying the same Bot API id.
console.log('\n=== orphaned references ===');
for (const r of REFS) {
  let orphans;
  try {
    orphans = (await c.query(
      `SELECT DISTINCT t."${r.col}" AS id FROM "${r.table}" t
       LEFT JOIN users u ON u.id = t."${r.col}"
       WHERE t."${r.col}" IS NOT NULL AND u.id IS NULL`
    )).rows;
  } catch (_) { continue; }

  for (const o of orphans) {
    const m = String(o.id).match(/^telegram_(\d{5,15})$/);
    if (!m) { console.log(`  ${r.table}.${r.col}: ${o.id} — no Bot API id in the name, left alone`); continue; }
    const owner = (await c.query(
      `SELECT id FROM users WHERE provider = 'telegram' AND telegram_api_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [m[1]]
    )).rows[0];
    if (!owner) { console.log(`  ${r.table}.${r.col}: ${o.id} — no account with api id ${m[1]}`); continue; }
    const n = Number((await c.query(`SELECT COUNT(*) n FROM "${r.table}" WHERE "${r.col}" = $1`, [o.id])).rows[0].n);
    console.log(`  ${r.table}.${r.col}: ${n} row(s) ${o.id} -> ${owner.id}${APPLY ? '' : '  (dry run)'}`);
    if (APPLY) {
      try { await c.query(`UPDATE "${r.table}" SET "${r.col}" = $1 WHERE "${r.col}" = $2`, [owner.id, o.id]); }
      catch (e) { console.log(`    warn: ${e.message.slice(0, 70)}`); }
    }
  }
}

if (APPLY) {
  console.log('\n--- result ---');
  const { rows } = await c.query(
    `SELECT id, username, telegram_api_id,
            (SELECT COUNT(*) FROM personal_links p WHERE p.user_id = u.id) AS personal,
            (SELECT COUNT(*) FROM community_members m WHERE m.user_id = u.id) AS memberships
     FROM users u WHERE provider = 'telegram' ORDER BY id`
  );
  for (const r of rows) console.log(' ', JSON.stringify(r));
}
await c.end();
