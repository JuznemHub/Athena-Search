#!/usr/bin/env node
/**
 * Athena self-hosted mode — no Cloudflare.
 *
 * Runs the exact same worker/index.js under Node by supplying the two things
 * the Workers runtime provided: a D1-compatible database (SQLite on local disk)
 * and an ASSETS binding (public/ from disk). Everything else the Worker uses —
 * fetch, Request/Response, crypto.subtle, TextEncoder, btoa — is standard in
 * Node 18+.
 *
 *   node server/index.js
 *
 * Config comes from the environment; see server/.env.example.
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
// Postgres only. SQLite was removed once Postgres was verified end to end.
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
const env = {
  ...process.env,
  DB,
  ASSETS: createAssets(ASSETS_DIR),
  // Tells the Worker it is not on Cloudflare: local SQLite only, no GitHub store.
  ATHENA_RUNTIME: 'selfhost',
  // This box is a BACKEND. The user is looking at the Cloudflare-hosted site, so
  // OAuth must hand the browser back there rather than to this origin. It still
  // serves the UI as a fallback for running fully standalone.
  ATHENA_FRONTEND_URL: process.env.ATHENA_FRONTEND_URL || '',
  // Self-host default matches the Worker's: empty owner lists mean the first
  // logged-in user is GOD. Set TG_OWNER_IDS to lock that down.
  TG_OWNER_IDS: process.env.TG_OWNER_IDS || '',
  DISCORD_OWNER_IDS: process.env.DISCORD_OWNER_IDS || '',
  // Expose backup function for the Worker's /backup command
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

    // Stream the worker's body through (required for live AI token streaming /
    // SSE). Buffering the whole body first would defeat token-by-token output.
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
        // fall through to buffered path below
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

  // Auto-purge Cloudflare cache on startup
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
