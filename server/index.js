#!/usr/bin/env node
/**
 * Athena self-hosted mode — runs worker/index.js under Node.
 *
 * Supplies the two bindings the Workers runtime provided: env.DB (D1-shaped
 * Postgres) and env.ASSETS (public/ from disk). Config comes from the
 * environment; see server/.env.example.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../worker/index.js';
import { createAssets } from './assets.js';
import { startBackups, runBackupOnce } from './backup.js';
import { PostgresD1, translateSchema } from './pgdb.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ASSETS_DIR = resolve(ROOT, process.env.ATHENA_ASSETS || 'public');

// --- database -------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  console.error('[athena] DATABASE_URL is required, e.g. postgresql://athena:pass@localhost:5432/athena');
  process.exit(1);
}
const DB = new PostgresD1(DATABASE_URL);
const dbLabel = `postgres (${DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')})`;
try {
  const schema = await readFile(join(ROOT, 'worker', 'schema.sql'), 'utf8');
  await DB.exec(translateSchema(schema));
  console.log('[athena] schema applied (postgres)');
} catch (err) {
  console.error('[athena] schema failed:', err.message);
  process.exit(1);
}

// --- env handed to the Worker --------------------------------------------
// Allowlist, not process.env wholesale: an introspection endpoint would
// otherwise leak every secret. A new env.FOO read in worker/index.js is
// undefined here until FOO is added.
const ALLOWED_ENV = [
  'DATABASE_URL', 'ATHENA_RUNTIME', 'ATHENA_FRONTEND_URL',
  'TG_OWNER_IDS', 'DISCORD_OWNER_IDS',
  'TELEGRAM_CLIENT_ID', 'TELEGRAM_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_OAUTH_REDIRECT_BASE', 'STORAGE_KEY',
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET',
  'BACKUP_TELEGRAM_TOKEN', 'BACKUP_TELEGRAM_CHAT_ID', 'GDRIVE_CLIENT_ID',
  'OAUTH_RELAY_BACKEND',
];
const allowedEnv = {};
for (const k of ALLOWED_ENV) {
  if (process.env[k] !== undefined) allowedEnv[k] = process.env[k];
}
const env = {
  // Empty owner lists mean every logged-in user is GOD.
  TG_OWNER_IDS: '',
  DISCORD_OWNER_IDS: '',
  // Set when this box is a backend for a Cloudflare-hosted frontend: OAuth
  // hands the browser back there instead of to this origin.
  ATHENA_FRONTEND_URL: '',
  ...allowedEnv,
  DB,
  ASSETS: createAssets(ASSETS_DIR),
  // Gates the Cloudflare-only paths in worker/index.js.
  ATHENA_RUNTIME: 'selfhost',
  runBackup: () => runBackupOnce({ connectionString: DATABASE_URL, env: process.env, db: DB }),
};

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };

// --- node http -> web Request -> Worker -> node response ------------------
function nodeToRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else if (v != null) headers.set(k, String(v));
  }
  // Without a reverse proxy nothing carries the client IP, so clientIp() in the
  // Worker returns '' and every caller shares one rate-limit bucket.
  if (!headers.has('x-forwarded-for') && req.socket?.remoteAddress) {
    headers.set('x-forwarded-for', req.socket.remoteAddress);
  }
  return { url, headers };
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = http.createServer(async (req, res) => {
  try {
    const { url, headers } = nodeToRequest(req);
    const body = await readBody(req);
    const request = new Request(url, { method: req.method, headers, body, duplex: 'half' });

    const response = await worker.fetch(request, env, ctx);

    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      // set-cookie must not be folded into one header
      if (k.toLowerCase() === 'set-cookie') res.appendHeader('set-cookie', v);
      else res.setHeader(k, v);
    });

    // Streamed, not buffered: AI token streaming / SSE depends on it.
    if (response.body && typeof response.body.getReader === 'function') {
      try {
        const reader = response.body.getReader();
        res.on('close', () => { try { reader.cancel(); } catch (_) {} });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      } catch (e) {
        console.error('[athena] stream relay failed, falling back to buffer:', e.message);
      }
    }
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('[athena] request failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
    }
    res.end(JSON.stringify({ success: false, error: 'Internal error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[athena] self-hosted on http://${HOST}:${PORT}`);
  console.log(`[athena] database : ${dbLabel}`);
  console.log(`[athena] assets   : ${ASSETS_DIR}`);
  if (!process.env.TG_OWNER_IDS) {
    console.log('[athena] WARNING: TG_OWNER_IDS is empty — every logged-in user is GOD. Set it before exposing this.');
  }
  startBackups({ connectionString: DATABASE_URL, env: process.env, db: DB });

  if (process.env.CF_PURGE_CACHE === '1' && process.env.CF_ZONE_ID && process.env.CF_API_EMAIL && process.env.CF_API_KEY) {
    fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        'X-Auth-Email': process.env.CF_API_EMAIL,
        'X-Auth-Key': process.env.CF_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ purge_everything: true })
    }).then(r => r.json()).then(data => {
      if (data.success) console.log('[athena] Cloudflare cache purged');
      else console.warn('[athena] Cloudflare cache purge failed:', data.errors?.[0]?.message || 'unknown');
    }).catch(err => {
      console.warn('[athena] Cloudflare cache purge error:', err.message);
    });
  }
});

const shutdown = () => {
  console.log('\n[athena] shutting down');
  server.close(async () => { await DB.close?.(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
