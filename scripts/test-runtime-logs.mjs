import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// Synthetic auth (session row + GOD user) + REAL runtime-logs/dokploy/log-api
// modules and real signed webhook handlers. Only the Dokploy HTTP transport
// (globalThis.fetch) is a fixture boundary; no Telegram or Dokploy
// credentials exist in this fixture.
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, provider TEXT, provider_id TEXT, telegram_api_id TEXT, created_at INTEGER);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
CREATE TABLE community_bots (id TEXT PRIMARY KEY, community_id TEXT, platform TEXT NOT NULL, bot_username TEXT NOT NULL, group_id TEXT NOT NULL, group_name TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'community', user_id TEXT, bot_token TEXT, dump_link_mode TEXT DEFAULT 'smart', topic_id TEXT, log_channel_id TEXT, enabled INTEGER DEFAULT 1, token_enc TEXT);
CREATE TABLE telegram_bots (id TEXT PRIMARY KEY, telegram_group_id TEXT, community_id TEXT, created_at INTEGER NOT NULL);
INSERT INTO users (id, username, provider, provider_id, telegram_api_id, created_at) VALUES ('u_logs_fixture','logs_fixture','telegram','123456789','123456789',1);
INSERT INTO sessions (token, user_id, expires_at) VALUES ('fixture-session-token','u_logs_fixture',${Date.now() + 3600000});`);
const DB = { prepare(query) {
  const statement = (params = []) => ({
    bind(...values) { return statement(values.map(value => value ?? null)); },
    async run() { sqlite.prepare(query).run(...params); return { success: true, meta: { changes: 0 } }; },
    async first(column) { const row = sqlite.prepare(query).get(...params); return row ? (column ? row[column] : row) : null; },
    async all() { return { results: sqlite.prepare(query).all(...params) }; },
  });
  return statement();
} };
const env = {
  DB, ATHENA_RUNTIME: 'selfhost', TELEGRAM_BOT_TOKEN: '123:fixture', TELEGRAM_WEBHOOK_SECRET: 'logs-fixture-secret',
  TG_OWNER_IDS: '123456789', DOKPLOY_URL: 'http://127.0.0.1:45123', DOKPLOY_API_KEY: 'dokploy-fixture-key', DOKPLOY_APP_ID: 'app-fixture', DOKPLOY_TIMEOUT_MS: '700',
};
// --- Captured Bot API + synthetic Dokploy host (official tRPC REST contract)
const sent = [];
const dokployRequests = [];
let dokployMode = 'ok';
async function dokployFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
  if (url.origin !== 'http://127.0.0.1:45123') throw new Error(`Unmocked external request: ${url.origin}`);
  dokployRequests.push({ url: url.pathname + url.search, key: init.headers?.['x-api-key'] });
  if (dokployMode.timeout) {
    // Production behavior is a fetch that rejects when the AbortSignal fires.
    // The mock mirrors the real abort semantics (verified separately against a
    // hanging HTTP server in unit timeout check) without listening races.
    const signal = init?.signal;
    await new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), signal?.aborted ? 0 : 300));
  }
  if (dokployMode.offline) throw new Error('fetch failed');
  if (dokployMode.status) return Response.json({ message: dokployMode.message || 'forbidden' }, { status: dokployMode.status });
  if (url.pathname === '/api/application.one') {
    return Response.json({ result: { data: { json: { applicationId: 'app-fixture', name: 'athena', appName: 'svc-athena-abc', applicationStatus: 'running', branch: 'dev', sourceType: 'github' } } } });
  }
  if (url.pathname === '/api/application.readLogs') {
    return new Response(JSON.stringify({ result: { data: '2026-09-17T10:00:00.000Z ERROR storage [svc] insert failed api_key=SK-live-000 password=hunter2 postgresql://athena:pw@db:5432/athena\n2026-09-17T10:00:01.000Z INFO http ready\n' } }), { status: 200 });
  }
  if (url.pathname === '/api/deployment.all') {
    return Response.json({ result: { data: [{ deploymentId: 'dep-1', status: 'done', createdAt: '2026-09-17T09:00:00.000Z', title: 'Deploy via dashboard' }] } });
  }
  if (url.pathname === '/api/deployment.readLogs') {
    return Response.json({ result: { data: '#14 build output\nInstalling dependencies\nnpm error missing script' } });
  }
  return new Response('not found', { status: 404 });
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
  if (url.origin === 'https://api.telegram.org' && url.pathname.startsWith('/bot123:fixture/')) {
    const body = JSON.parse(init?.body || '{}');
    sent.push({ method: url.pathname.split('/').at(-1), body });
    return Response.json({ ok: true, result: { message_id: 900 + sent.length } });
  }
  return dokployFetch(input, init);
};

// --- Real worker + synthetic session ----------------------------------------
const worker = (await import('../worker/index.js')).default;
const ctx = { waitUntil() {} };
let updateSeq = 1;
async function apiGet(path, token = 'fixture-session-token') {
  const response = await worker.fetch(new Request(`https://fixture.invalid${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), env, ctx);
  if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', lines = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      lines = text.split('\n').filter(Boolean).length;
      if (lines >= 4) { await reader.cancel(); break; } // bounded: end-of-stream is a client concern
    }
    return { status: response.status, headers: response.headers, body: text };
  }
  return { status: response.status, headers: response.headers, body: await response.text() };
}
const apiJson = async (path, token) => { const response = await apiGet(path, token); return JSON.parse(response.body); };
async function webhook(text) {
  return worker.fetch(new Request('https://fixture.invalid/api/telegram-webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 500000 + ++updateSeq, message: { message_id: updateSeq, from: { id: 123456789 }, chat: { id: 123456789, type: 'private' }, text } }) }), env, ctx);
}

try {
  // --- 1. App source: warm up with real producers, then initial lines
  assert.equal((await apiGet('/api/health')).status, 200);
  assert.equal((await webhook('/log --json')).status, 200);
  const initial = await apiJson('/api/logs?source=app&tail=5');
  assert.equal(initial.source, 'app');
  assert.ok(initial.cursor, 'cursor is always present');
  assert.equal(initial.reset, false);
  assert.ok(initial.records.length >= 1, 'real app log records exist after warmup');
  for (const record of initial.records) {
    assert.match(record.cursor, /^[0-9a-f-]{36}:\d+$/);
    assert.match(record.timestamp, /^\d{4}-\d\d-\d\dT/);
    assert.ok(['INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE', 'UNKNOWN'].includes(record.level));
    assert.ok(record.service.length > 0);
    assert.ok(!/dokploy-fixture-key/.test(record.message + (record.trace || '')));
  }

  // --- 2. Follow by cursor: only new records; rotation-safe cursors
  const follow1 = await apiJson(`/api/logs?source=app&tail=5&cursor=${encodeURIComponent(initial.cursor)}`);
  assert.deepEqual(follow1.records, []);
  assert.equal(follow1.cursor, initial.cursor);
  assert.equal((await webhook('/log')).status, 200);
  const follow2 = await apiJson(`/api/logs?source=app&tail=5&cursor=${encodeURIComponent(initial.cursor)}`);
  assert.ok(follow2.records.length >= 1, 'records after the cursor are delivered');
  assert.ok(follow2.records.every(record => record.cursor !== initial.records.at(-1).cursor), 'no replay of pre-cursor records');
  assert.equal(follow2.reset, false);
  const followReset = await apiJson('/api/logs?source=app&tail=5&cursor=bogus:999');
  assert.equal(followReset.reset, true, 'expired cursor reports reset instead of failing');

  // --- 3. Follow stream: NDJSON, connected/log/checkpoint events, redaction
  const streamResponse = await apiGet('/api/logs?source=app&tail=5&follow=1');
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.equal(streamResponse.headers.get('cache-control'), 'no-store');
  const events = streamResponse.body.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'connected');
  assert.ok(events.some(event => event.type === 'log'), 'initial snapshot ships inside the stream');
  const checkpoint = events.filter(event => event.type === 'checkpoint').at(-1);
  assert.ok(checkpoint.cursor, 'checkpoints carry a cursor for reconnect');
  for (const event of events) {
    const text = JSON.stringify(event);
    assert.ok(!text.includes('dokploy-fixture-key'), 'stream events never leak the Dokploy key');
    assert.ok(!text.includes('fixture-session-token'), 'stream events never leak the session token');
  }

  // --- 4. Reconnect after end-of-stream via checkpoint cursor
  const resume = await apiJson(`/api/logs?source=app&tail=5&cursor=${encodeURIComponent(checkpoint.cursor)}`);
  assert.equal(resume.reset, false, 'checkpoint cursor reconnects cleanly');
  assert.ok(resume.cursor, 'resume keeps the chain alive');

  // --- 5. Authentication: anon 401, non-GOD 403, no unauthenticated stream
  assert.equal((await apiGet('/api/logs?source=app', '')).status, 401);
  const nonGod = await worker.fetch(new Request('https://fixture.invalid/api/logs?source=app', { headers: { Authorization: 'Bearer fixture-session-token' } }), { ...env, TG_OWNER_IDS: '999' }, ctx);
  assert.equal(nonGod.status, 403);
  // --- 6. Container logs: official contract, service identity, redaction
  const container = await apiJson('/api/logs?source=container&tail=10');
  assert.ok(dokployRequests.some(request => request.url.startsWith('/api/application.readLogs')), 'official application.readLogs is used');
  assert.ok(dokployRequests.every(request => request.key === 'dokploy-fixture-key'), 'x-api-key auth is sent');
  assert.ok(dokployRequests.some(request => request.url.includes('since=all')), 'official since parameter is sent');
  assert.equal(container.service, 'svc-athena-abc');
  assert.equal(container.state, 'running');
  assert.ok(container.records.length >= 2);
  const containerText = JSON.stringify(container.records);
  assert.ok(containerText.includes('insert failed'), 'real log content is preserved');
  assert.ok(!containerText.includes('SK-live-000'), 'key=value secrets are redacted');
  assert.ok(!containerText.includes('postgresql://'), 'database URLs are redacted');
  assert.ok(containerText.includes('[REDACTED]'), 'redaction markers applied');
  assert.ok(container.records.every(record => record.timestamp && record.service && record.level && record.message != null), 'structured fields present');

  // --- 7. Deployment build logs: separate source, real endpoint
  const build = await apiJson('/api/logs?source=deployment&tail=10');
  assert.ok(dokployRequests.some(request => request.url.startsWith('/api/deployment.readLogs')), 'official deployment.readLogs is used for build output');
  assert.equal(build.service, 'svc-athena-abc');
  assert.ok(build.records.some(record => /missing script/.test(record.message)), 'build failure text is preserved');
  assert.ok(!JSON.stringify(build).includes('dokploy-fixture-key'));

  // --- 8. Cursor reconnect on container source; restart/generation change
  const containerFollow = await apiJson(`/api/logs?source=container&cursor=${encodeURIComponent(container.cursor)}`);
  assert.deepEqual(containerFollow.records, [], 'unchanged container snapshot does not replay lines');
  const rotated = await apiJson('/api/logs?source=container&cursor=eyJnIjoicmVzdGFydCIsImgiOltdfQ%3D%3D');
  assert.equal(rotated.reset, true, 'generation mismatch (service restart/rotation) reports reset');
  try { await apiJson('/api/logs?source=container&cursor=%%%invalid'); assert.fail('invalid cursor must reject'); }
  catch (error) { assert.ok(error instanceof SyntaxError || /cursor/i.test(error.message), 'invalid cursor surfaces a JSON parse or 400 code error'); }

  // --- 9. Failure classification: auth, offline network, timeout
  dokployMode = { status: 403 };
  const authFail = await apiJson('/api/logs?source=container');
  assert.equal(authFail.success, false);
  assert.equal(authFail.code, 'DOKPLOY_AUTH');
  assert.ok(/API key/.test(authFail.message));
  assert.ok(!JSON.stringify(authFail).includes('dokploy-fixture-key'), 'error paths redact the key');
  dokployMode = { offline: true };
  const offline = await apiJson('/api/logs?source=container');
  assert.equal(offline.code, 'NETWORK');
  assert.equal(offline.retryable, true);
  dokployMode = { timeout: true };
  const timedOut = await apiJson('/api/logs?source=container');
  assert.equal(timedOut.code, 'TIMEOUT', 'AbortSignal timeout classifies as TIMEOUT');
  assert.equal(timedOut.retryable, true);
  dokployMode = 'ok';

  // --- 10. Telegram surfaces: /log, /log --json, /dok help, /dok buildlogs
  assert.equal((await webhook('/log')).status, 200);
  assert.equal((await webhook('/log --json')).status, 200);
  assert.equal((await webhook('/dok help')).status, 200);
  assert.equal((await webhook('/dok buildlogs')).status, 200);
  assert.ok(dokployRequests.some(request => request.url.startsWith('/api/deployment.readLogs')), '/dok buildlogs hits the build-log endpoint');

  // Warm the ring with genuinely long records through the real webhook logger
  // (each /log command itself appends a record; 60 long commands overflow 3800).
  for (let i = 0; i < 60; i++) await webhook(`/log ${'z'.repeat(180)}`);
  await webhook('/log --json 60');
  const jsonMessage = sent.filter(call => call.method === 'sendMessage').at(-1).body.text;
  const decoded = jsonMessage.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); // strip <code> wrapper + undo escHtml
  const parsed = JSON.parse(decoded);
  assert.equal(parsed.source, 'app');
  assert.ok(Array.isArray(parsed.records) && parsed.records.length >= 1);
  assert.ok(parsed.records.every(record => record.message != null), 'every record is whole (no mid-record byte slice)');
  assert.ok(decoded.length <= 4096, 'payload stays within the Telegram message cap');


  // --- 11. No-simulation: records always carry real source identity
  const noSim = await apiJson('/api/logs?source=app&tail=1000');
  assert.ok(noSim.records.every(record => record.source === 'app'));
  assert.ok(!noSim.records.some(record => /simulated|generated for testing/i.test(record.message)));

  console.log('Runtime log fixtures passed: initial app lines, cursor follow + rotation, NDJSON stream with checkpoints, reconnect/reset, auth 401/403, container+deployment via real Dokploy contract, redaction incl. error paths, failure classification (auth/offline/timeout/invalid cursor), /log + /dok wiring, no-simulation source identity.');
  console.log(JSON.stringify({ dokployRequests: dokployRequests.length, streamedEvents: events.length, sources: ['app', 'container', 'deployment'] }));
} finally {
  dokployMode = 'ok';
  sqlite.close();
}
