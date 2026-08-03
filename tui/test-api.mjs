import assert from 'node:assert/strict';
import http from 'node:http';

import { makeClient } from './src/api.js';
import { parseSessionToken } from './src/session.js';

let seenBatchKey = '';
const server = http.createServer((req, res) => {
  if (req.url === '/api/personal-links/batch') {
    seenBatchKey = req.headers['x-athena-batch-key'] || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 1, added: 1, dupes: 0, failed: [] }));
    return;
  }
  if (req.url === '/api/health') {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ code: 'RATE_LIMITED', error: 'Too many saves — slow down' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', error: { message: 'Missing route' } }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const client = makeClient(base, 'token');

const batch = await client.postPersonalLinksBatch(
  [{ url: 'https://example.test/item', title: 'Item' }],
  { idempotencyKey: 'test-batch-key-123456' },
);
assert.equal(batch.added, 1);
assert.equal(seenBatchKey, 'test-batch-key-123456');

let caught;
try { await client.health(); } catch (error) { caught = error; }
assert.equal(caught.type, 'RATE_LIMITED');
assert.equal(caught.code, 'RATE_LIMITED');
assert.equal(caught.message, 'Too many saves — slow down');
assert.equal(caught.retryAfterMs, 2000);

caught = null;
try { await client.storageConfig(); } catch (error) { caught = error; }
assert.equal(caught.type, 'NOT_FOUND');
assert.equal(caught.message, 'Missing route');

assert.equal(parseSessionToken('0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
assert.equal(parseSessionToken('https://example.test/?session=abc%2B123'), 'abc+123');
assert.equal(parseSessionToken('not a token'), null);

server.close();
console.log('PASS api errors and raw session tokens');
