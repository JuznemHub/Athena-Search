#!/usr/bin/env node
// One-off backup, for cron or a manual run.
import { runBackupOnce } from './backup.js';
import { PostgresD1 } from './pgdb.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required, e.g. postgresql://athena:pass@localhost:5432/athena');
  process.exit(1);
}

// The db handle is what lets the backup find the already-linked bot and the
// owner's DM. Without it the destination can only come from BACKUP_TELEGRAM_*,
// so a cron run would silently skip Telegram.
const db = new PostgresD1(connectionString);
try {
  const r = await runBackupOnce({ connectionString, env: process.env, db });
  process.exit(r.ok ? 0 : 1);
} finally {
  await db.close();
}
