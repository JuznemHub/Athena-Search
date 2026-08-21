#!/usr/bin/env node
/**
 * Athena self-hosted mode — runs worker/index.js under Node.
 *
 * Supplies the two bindings the Workers runtime provided: env.DB (D1-shaped
 * Postgres) and env.ASSETS (public/ from disk). Config comes from the
 * environment; see server/.env.example.
 */
import http from 'node:http';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker, { getInstanceAiConfig, getSteroidMode, syncAiConfigToPeer, syncSteroidToPeer, startUserbotDaemon } from '../worker/index.js';
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
  'DATABASE_URL', 'ATHENA_RUNTIME', 'ATHENA_FRONTEND_URL', 'ATHENA_AI_PEER_URL', 'ATHENA_ALLOWED_ORIGINS',
  'TG_OWNER_IDS', 'DISCORD_OWNER_IDS',
  'TELEGRAM_CLIENT_ID', 'TELEGRAM_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'AI_CONFIG_SYNC_SECRET',
  'TELEGRAM_API_BASE',
  'TELEGRAM_OAUTH_REDIRECT_BASE', 'STORAGE_KEY',
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET',
  'BACKUP_TELEGRAM_TOKEN', 'BACKUP_TELEGRAM_CHAT_ID', 'GDRIVE_CLIENT_ID',
  'OAUTH_RELAY_BACKEND',
  // Optional headless-Chrome scraper (kage) for JS-rendered pages
  'KAGE_BIN', 'KAGE_CHROME',
  // Optional derived search index; PostgreSQL remains the source of truth.
  'MEILI_URL', 'MEILISEARCH_URL', 'MEILI_MASTER_KEY', 'MEILI_INDEX',
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
  restartService: () => exec('systemctl restart athena', () => {}),
};

// Keep the Cloudflare Worker mirror aligned with the self-hosted instance row
// after restarts, including configurations saved before peer sync existed.
try {
  const aiConfig = await getInstanceAiConfig(env);
  if (aiConfig?.base_url && aiConfig.api_key) {
    await syncAiConfigToPeer(env, {
      baseUrl: aiConfig.base_url,
      apiKey: aiConfig.api_key,
      model: aiConfig.model,
      mode: aiConfig.mode,
      updatedAt: aiConfig.updated_at || Date.now()
    });
  }
} catch (err) {
  console.error('[athena] AI config peer sync failed:', err.message);
}
try {
  const steroid = await getSteroidMode(env);
  await syncSteroidToPeer(env, steroid);
} catch (err) {
  console.error('[athena] Steroid peer sync failed:', err.message);
}

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };

// Forwarded client-IP headers are only trustworthy coming from our own reverse
// proxy; a direct caller could otherwise spoof one per request and get a fresh
// rate-limit bucket. Defaults to loopback (nginx/caddy on this box).
const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXY_IPS || '127.0.0.1,::1')
    .split(',').map(s => s.trim()).filter(Boolean).map(normalizeIp)
);
function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

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
  // Behind a trusted proxy the forwarded headers are authoritative. From anyone
  // else they are attacker input: replace them with the real peer address so
  // clientIp() in the Worker cannot be steered.
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!TRUSTED_PROXIES.has(peer)) {
    headers.delete('cf-connecting-ip');
    if (peer) headers.set('x-forwarded-for', peer);
    else headers.delete('x-forwarded-for');
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
        // No buffered retry: bytes are already on the wire, and the body is
        // consumed. Kill the connection so the client sees a truncated stream
        // instead of JSON appended to half an SSE response.
        console.error('[athena] stream relay failed:', e.message);
        res.destroy();
        return;
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

  // Userbot live-clone daemon: connects the stored session (if configured)
  // and mirrors new messages from followed chats. No-op when not set up.
  startUserbotDaemon(env).catch((err) => console.error('[userbot] daemon failed:', err.message));

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
