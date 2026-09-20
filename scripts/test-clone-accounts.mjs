import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Real signed webhook handlers, encryption, SQLite persistence and boot-time
// reconnect. Only the Telegram module and Bot API transport are fixtures.
// Requires Node >= 22.15 (registerHooks); no Telegram credentials are loaded.
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8')
  .replace(/^CREATE EXTENSION[^;]*;/gm, '').replace(/^CREATE INDEX[^;]*USING gin[^;]*;/gm, ''));
sqlite.prepare('INSERT INTO users (id,username,provider,provider_id,telegram_api_id,created_at) VALUES (?,?,?,?,?,?)')
  .run('u_accounts_fixture', 'accounts_fixture', 'telegram', '123456789', '123456789', Date.now());
const DB = { prepare(query) {
  const statement = (params = []) => ({
    bind(...values) { return statement(values.map(value => value ?? null)); },
    async run() { const result = sqlite.prepare(query).run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
    async first(column) { const row = sqlite.prepare(query).get(...params); return row ? (column ? row[column] : row) : null; },
    async all() { return { results: sqlite.prepare(query).all(...params) }; }
  });
  return statement();
} };
const env = {
  DB, ATHENA_RUNTIME: 'selfhost', TELEGRAM_BOT_TOKEN: '123:fixture',
  TELEGRAM_WEBHOOK_SECRET: 'accounts-fixture-secret', TG_OWNER_IDS: '123456789',
  STORAGE_KEY: 'account-fixture-only-not-a-production-key'
};
const identities = {
  'fixture-session-alpha': { id: 700000001n, username: 'alpha_fixture', firstName: 'Alpha <Fixture>', lastName: 'Account', phone: '15550001001' },
  'fixture-session-beta': { id: 700000002n, firstName: 'Beta', lastName: 'Account', phone: '15550002002' },
  'fixture-session-renewed': { id: 700000003n, firstName: 'Renewed', lastName: 'Account', phone: '15550003003' },
};
const clients = [];
const unexpectedCalls = [];
class StringSession {
  constructor(value) { this.value = value; }
}
class TelegramClient {
  constructor(session, apiId, apiHash) {
    assert.ok(session instanceof StringSession);
    assert.equal(apiId, 12345);
    assert.equal(apiHash, 'fixture-api-hash');
    assert.ok(identities[session.value] || session.value === 'fixture-session-expired', 'Only synthetic sessions may connect');
    this.dialogReads = 0;
    this.session = session.value;
    this.connected = false;
    this.connects = 0;
    this.disconnects = 0;
    this.identityReads = 0;
    clients.push(this);
  }
  async connect() { this.connected = true; this.connects++; }
  async disconnect() { this.connected = false; this.disconnects++; }
  async getMe() {
    assert.equal(this.connected, true, 'Identity must be verified on a connected client');
    this.identityReads++;
    if (this.session === 'fixture-session-expired') throw new Error('AUTH_KEY_UNREGISTERED');
    return identities[this.session];
  }
  async getDialogs() { this.dialogReads++; assert.equal(this.connected, true); return []; }
  addEventHandler(handler) { assert.equal(typeof handler, 'function'); }
}
const fixtureKey = Symbol.for('athena.accounts.fixture.telegram');
globalThis[fixtureKey] = { TelegramClient, StringSession };
const telegramUrl = 'data:text/javascript,' + encodeURIComponent(`
const fixture = globalThis[Symbol.for('athena.accounts.fixture.telegram')];
export const TelegramClient = fixture.TelegramClient;
export const sessions = { StringSession: fixture.StringSession };
`);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'telegram') return { url: telegramUrl, shortCircuit: true };
  if (specifier.startsWith('telegram/')) {
    unexpectedCalls.push(`Unexpected Telegram import: ${specifier}`);
    throw new Error('Unmocked Telegram module');
  }
  return nextResolve(specifier, context);
} });
const originalFetch = globalThis.fetch;
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
const logs = [];
for (const level of Object.keys(originalConsole)) console[level] = (...args) => { logs.push(args.map(String).join(' ')); };
const sent = [];
let outgoingId = 100;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = url.pathname.split('/').at(-1);
  if (url.origin !== 'https://api.telegram.org' || !url.pathname.startsWith('/bot123:fixture/') ||
      !['sendMessage', 'sendRichMessage', 'editMessageText', 'deleteMessage', 'answerCallbackQuery', 'getMe', 'sendChatAction'].includes(method)) {
    unexpectedCalls.push(`${url.origin}${url.pathname}`);
    throw new Error('Unmocked external request');
  }
  const body = JSON.parse(init.body || '{}');
  const messageId = method === 'editMessageText' ? body.message_id : ++outgoingId;
  sent.push({ method, body, messageId });
  return Response.json({ ok: true, result: { message_id: messageId, id: 42, is_bot: true, username: 'FixtureBot' } });
};
// Track worker-owned timers to simulate process exit and to leave no watchdog
// behind after replacing a session. Timer timing is not changed by this fixture.
const originalSetInterval = globalThis.setInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearInterval = globalThis.clearInterval;
const intervalCallbacks = new Map();
const intervals = new Set();
const timeouts = new Set();
globalThis.setInterval = (callback, ...args) => {
  const timer = originalSetInterval(callback, ...args);
  intervals.add(timer);
  intervalCallbacks.set(timer, callback);
  return timer;
};
globalThis.clearInterval = timer => { intervals.delete(timer); intervalCallbacks.delete(timer); originalClearInterval(timer); };
globalThis.setTimeout = (...args) => { const timer = originalSetTimeout(...args); timeouts.add(timer); return timer; };
function clearWorkerTimers() {
  for (const timer of intervals) clearInterval(timer);
  for (const timer of timeouts) clearTimeout(timer);
  intervals.clear();
  timeouts.clear();
}
const background = [];
const ctx = { waitUntil(task) { background.push(task); } };
async function drain() { while (background.length) await background.shift(); }
let worker;
let updateId = 81000;
const from = { id: 123456789, first_name: 'Fixture' };
const chat = { id: 123456789, type: 'private' };
async function deliver(update, requestEnv = env, signed = true) {
  const response = await worker.fetch(new Request('https://fixture.invalid/api/telegram-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(signed ? { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET } : {}) },
    body: JSON.stringify({ update_id: ++updateId, ...update })
  }), requestEnv, ctx);
  await drain();
  assert.equal(response.status, signed ? 200 : 403, await response.text());
}
async function command(text, requestEnv = env) {
  await deliver({ message: { message_id: updateId + 1, from, chat, text } }, requestEnv);
}
function card() {
  const result = sent.findLast(call => call.method === 'editMessageText');
  assert.ok(result, 'Account controls must render a Bot API message');
  return { ...result, body: { ...result.body, text: result.body.rich_message?.html || result.body.text } };
}
async function click(text, occurrence = 0) {
  const current = card();
  const controls = current.body.rich_message
    ? [...current.body.rich_message.html.matchAll(/<tg-button type="callback_data" data="([^"]+)">([^<]+)<\/tg-button>/g)].map((match) => ({ callback_data: match[1], text: match[2] }))
    : (current.body.reply_markup?.inline_keyboard || []).flat();
  const matches = controls.filter(button => button.text === text);
  const button = matches[occurrence];
  assert.ok(button, `Missing account control ${text} #${occurrence}`);
  await deliver({ callback_query: {
    id: `accounts-callback-${updateId + 1}`, from, data: button.callback_data,
    message: { message_id: current.messageId, chat }
  } });
}
const account = label => sqlite.prepare('SELECT * FROM userbot_accounts WHERE label=?').get(label);
const selected = () => sqlite.prepare('SELECT label FROM userbot_selections WHERE requester_tg_id=?').get(String(from.id))?.label;
async function decryptFixture(value) {
  assert.match(value, /^enc:v1:/, 'Credential must be encrypted at rest');
  const [, , iv, ciphertext] = value.split(':');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.STORAGE_KEY));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, key, Buffer.from(ciphertext, 'base64')));
}
try {
  ({ default: worker } = await import('../worker/index.js'));
  const unsignedCalls = sent.length;
  await deliver({ message: { message_id: 1, from, chat, text: '/userbot_accounts' } }, env, false);
  assert.equal(sent.length, unsignedCalls, 'Unsigned delivery cannot touch Telegram');
  for (const alias of ['/userbot_add', '/userbotadd', '/userbot_connect', '/userbotconnect', '/index_start', '/indexstart', '/backfill']) {
    await deliver({ edited_message: { message_id: updateId + 1, from, chat,
      text: `  ${alias.toUpperCase()}@FixtureBot fixture-api-hash fixture-session-expired` } });
  }

  await command('/userbot_add rejected 12345 fixture-api-hash fixture-session-alpha', { ...env, STORAGE_KEY: '' });
  assert.equal(account('rejected'), undefined, 'No storage key must refuse to persist the credentials');
  assert.equal(clients.length, 0, 'Unencrypted credentials must never reach the Telegram client');

  await command('/userbot_add alpha 12345 fixture-api-hash fixture-session-alpha');
  const alpha = account('alpha');
  assert.equal(alpha.telegram_id, '700000001', 'getMe identity persists with the saved account');
  assert.equal(alpha.display_name, 'Alpha <Fixture> Account');
  assert.equal(alpha.phone_masked, '••••1001');
  assert.equal(alpha.telegram_username, 'alpha_fixture');
  const setup = sent.findLast(call => call.method === 'sendMessage').body.text;
  assert.match(setup, /@alpha_fixture/);
  assert.match(setup, /700000001/);
  assert.match(setup, /Alpha &lt;Fixture&gt; Account/);
  assert.ok(setup.includes('••••1001'));
  assert.match(setup, /Status: Active/);
  assert.ok(alpha.verified_at > 0);
  assert.equal(alpha.last_error, null);
  assert.equal(await decryptFixture(alpha.session_enc), 'fixture-session-alpha');
  assert.equal(await decryptFixture(alpha.api_hash_enc), 'fixture-api-hash');
  assert.equal(selected(), 'alpha', 'First successful account becomes the selection');
  assert.ok(sent.some(call => call.method === 'deleteMessage'), 'Credential message is deleted');
  await command('/userbot_add alpha! 12345 fixture-api-hash fixture-session-beta');
  assert.equal(account('alpha').telegram_id, '700000001', 'Invalid labels cannot silently overwrite a sanitized account label');
  assert.equal(account('alpha!'), undefined);

  await command('/userbot_add beta 12345 fixture-api-hash fixture-session-beta');
  assert.equal(account('beta').telegram_id, '700000002');
  assert.equal(selected(), 'alpha', 'Adding another account cannot silently switch selection');
  await command('/userbot_add expired 12345 fixture-api-hash fixture-session-expired');
  assert.equal(account('expired').telegram_id, null, 'Expired session is never verified');
  assert.match(account('expired').last_error, /reauthenticat/i);
  assert.equal(selected(), 'alpha', 'Failed account addition cannot replace selection');
  assert.equal(clients.at(-1).connected, false, 'Rejected identity disconnects its client');

  // A fresh module has fresh private session maps, just as a new server process
  // does. Its only account input is the encrypted database saved above.
  await drain();
  for (const client of clients) await client.disconnect();
  clearWorkerTimers();
  const beforeBoot = clients.length;
  const fresh = await import('../worker/index_legacy.js?accounts-fixture-restart');
  worker = fresh.default;
  const boot = await fresh.startUserbotDaemon({ ...env, __ctx: ctx });
  await drain();
  assert.deepEqual(boot, { ok: true, started: 2 });
  assert.deepEqual(clients.slice(beforeBoot).filter(client => client.connected).map(client => client.session).sort(),
    ['fixture-session-alpha', 'fixture-session-beta'], 'Boot reconnects every valid saved account, not just the selected one');
  assert.ok(clients.slice(beforeBoot).every(client => client.identityReads === 1), 'Reconnect re-verifies identities');
  assert.equal(selected(), 'alpha', 'Selection survives restart');
  assert.match(account('expired').last_error, /reauthenticat/i);

  await command('/userbot_accounts');
  assert.match(card().body.text, /@alpha_fixture/, 'Saved account list includes its persisted Telegram identity');
  await click('Add Account');
  assert.match(card().body.text, /\/userbot_add/);
  await click('Back');
  await click('Status');
  assert.match(card().body.text, /700000001/);
  assert.match(card().body.text, /Alpha &lt;Fixture&gt;/, 'Identity display escapes Telegram HTML');
  assert.ok(card().body.text.includes('••••1001'));
  assert.match(card().body.text, /@alpha_fixture/);
  assert.ok(!card().body.text.includes(identities['fixture-session-alpha'].phone), 'Full phone is never displayed');
  await click('Back');
  await click('Select: beta');
  assert.equal(selected(), 'beta');
  await click('Status', 1);
  assert.match(card().body.text, /700000002/);
  await click('Back');
  await click('Status', 2);
  assert.match(card().body.text, /reauthenticat/i, 'Expired saved session gives actionable status');
  assert.equal(selected(), 'beta', 'Expired status cannot substitute an account');
  await click('Back');
  await click('Reauthenticate', 2);
  assert.match(card().body.text, /\/userbot_add expired /);
  const expiredCiphertext = account('expired').session_enc;
  await command('/userbot_add expired 12345 fixture-api-hash fixture-session-renewed');
  assert.equal(account('expired').telegram_id, '700000003');
  assert.equal(account('expired').last_error, null, 'Reauthentication clears the failed session status');
  assert.equal(account('expired').telegram_username, null, 'Accounts without a username persist no fabricated handle');
  assert.notEqual(account('expired').session_enc, expiredCiphertext);
  assert.equal(await decryptFixture(account('expired').session_enc), 'fixture-session-renewed');
  assert.equal(selected(), 'beta', 'Same-label reauthentication preserves explicit selection');
  const replacedClient = clients.at(-1);
  await command('/userbotadd@FixtureBot expired 12345 fixture-api-hash fixture-session-renewed');
  assert.equal(replacedClient.connected, false, 'Live same-label replacement disconnects the previous client');
  assert.notEqual(clients.at(-1), replacedClient, 'Reauthentication creates a fresh client');
  const previousDialogReads = replacedClient.dialogReads;
  for (const timer of [...intervals]) await intervalCallbacks.get(timer)();
  assert.equal(replacedClient.dialogReads, previousDialogReads, 'A replaced account must not receive requests from an orphaned watchdog');
  assert.equal(selected(), 'beta', 'Live same-label replacement cannot change selection');

  await command('/userbot_select');
  await click('Select: expired');
  assert.equal(selected(), 'expired');
  await click('Remove', 2);
  assert.ok(account('expired'), 'Removal requires confirmation');
  await click('Keep account');
  assert.ok(account('expired'), 'Keeping an account leaves its session saved');
  await click('Remove', 2);
  const removedClient = clients.at(-1);
  await click('Confirm removal');
  assert.equal(account('expired'), undefined, 'Confirmed removal deletes the saved session');
  assert.equal(selected(), undefined, 'Removing the selected account clears selection without fallback');
  assert.equal(removedClient.connected, false, 'Removed account disconnects');
  assert.equal(account('alpha').telegram_id, '700000001', 'Removal leaves other accounts untouched');
  assert.equal(account('beta').telegram_id, '700000002');
  await click('Select: alpha');
  assert.equal(selected(), 'alpha', 'Remaining account can be selected after removal');
  await command('/userbot_status');
  const statusMessage = sent.findLast(call => ['sendMessage', 'sendRichMessage'].includes(call.method));
  const status = statusMessage.body.rich_message?.html || statusMessage.body.text;
  assert.match(status, /@alpha_fixture/);
  assert.match(status, /700000001/);
  assert.ok(status.includes('••••1001'));
  await deliver({ message: { message_id: updateId + 1, from, chat: { id: -10012345, type: 'supergroup' }, text: '/userbot_status' } });
  assert.ok(!sent.findLast(call => call.method === 'sendMessage').body.text.includes('alpha_fixture'), 'Identity dashboard is private even for an owner');
  await command('/userbot_add alpha 12345 fixture-api-hash fixture-session-expired');
  assert.equal(account('alpha').telegram_id, null, 'Failed same-label reauthentication clears the previous verified identity');
  assert.equal(account('alpha').telegram_username, null);
  assert.equal(account('alpha').verified_at, null);
  assert.equal(selected(), 'alpha', 'A failed selected session never falls back to another account');
  await command('/userbot_add alpha 12345 fixture-api-hash fixture-session-alpha');
  assert.equal(account('alpha').telegram_username, 'alpha_fixture');

  const output = JSON.stringify(sent);
  for (const secret of ['fixture-api-hash', ...Object.keys(identities), 'fixture-session-expired', ...Object.values(identities).map(identity => identity.phone)]) {
    assert.ok(!output.includes(secret), 'Outgoing Bot API payload must not contain fixture credentials or full phone numbers');
  }
  const logOutput = logs.join('\n');
  assert.ok(!logOutput.includes('fixture-api-hash'), 'Webhook logs must never contain an API hash');
  assert.ok(!logOutput.includes('fixture-session'), 'Webhook logs must never contain even a session prefix');
  await command('/userbot_del all');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM userbot_accounts').get().n, 0);
  assert.equal(selected(), undefined, 'Command removal clears selections just like manager removal');
  assert.ok(clients.every(client => !client.connected), 'All fixture accounts disconnect');
  assert.deepEqual(unexpectedCalls, [], 'No unmocked external call may be swallowed by worker error handling');
  originalConsole.log('Clone account webhook/lifecycle fixtures passed: encrypted setup, redacted logs, identity/masking, multi-account boot reconnect, selection/removal, expired session, same-label reauthentication and watchdog cleanup.');
} finally {
  await drain();
  clearWorkerTimers();
  for (const client of clients) await client.disconnect();
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearInterval = originalClearInterval;
  Object.assign(console, originalConsole);
  hooks.deregister();
  delete globalThis[fixtureKey];
  sqlite.close();
}
