// End-to-end TUI test: mock Athena API + fake Chrome profile + pseudo-TTY.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const server = http.createServer((req, res) => {
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(body).toString();
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/health') return send(200, { ok: true, version: '1.0.5' });
    if (req.url === '/api/storage/config') return send(200, { provider: 'postgres' });
    if (req.url === '/api/auth/me') return send(200, { user: { username: 'neo', is_god: true } });
    if (req.url === '/api/communities' && req.method === 'GET') {
      return send(200, { communities: [{ id: 7, name: 'Neo Circle', role: 'owner' }] });
    }
    if (req.url === '/api/communities/join' && req.method === 'POST') {
      return send(200, { community: { id: JSON.parse(raw).community_id, name: 'Neo Circle', role: 'owner' } });
    }
    if (req.url === '/api/personal-links' && req.method === 'GET') return send(200, { links: [] });
    if (req.url === '/api/personal-links' && req.method === 'POST') return send(200, { link: { id: 1 } });
    if (req.url === '/api/personal-links/batch' && req.method === 'POST') {
      const links = JSON.parse(raw).links || [];
      return send(200, { total: links.length, added: links.length, dupes: 0, failed: [] });
    }
    if (req.url === '/api/links/batch' && req.method === 'POST') {
      const links = JSON.parse(raw).links || [];
      return send(200, { total: links.length, added: links.length, dupes: 0, failed: [] });
    }
    send(404, { error: { type: 'NOT_FOUND' } });
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-tui-e2e-'));
const chromeDir = path.join(testHome, '.config', 'google-chrome', 'Default');
fs.mkdirSync(chromeDir, { recursive: true });
const fixtureBookmarks = Array.from({ length: 221 }, (_, i) => ({
  type: 'url',
  name: `Bookmark ${i + 1}`,
  url: `https://bookmark-site-${i + 1}.com/item/${i + 1}`,
}));
fs.writeFileSync(path.join(chromeDir, 'Bookmarks'), JSON.stringify({
  roots: { bookmark_bar: { type: 'folder', name: 'bar', children: [
    ...fixtureBookmarks,
  ] }, other: { type: 'folder', children: [] }, synced: { type: 'folder', children: [] } },
}));

const env = {
  ...process.env,
  HOME: testHome,
  USERPROFILE: testHome,
  ATHENA_INSTANCE: `http://127.0.0.1:${port}`,
  ATHENA_TOKEN: 'test-token',
  ATHENA_TUI_NO_ANIMATION: '1',
};
fs.rmSync(path.join(testHome, '.config', 'athena-tui', 'config.json'), { force: true });

const cmd = `script -qec "node src/index.js" /dev/null`;
const proc = spawn('bash', ['-c', cmd], { cwd: process.cwd(), env, detached: true });

let out = '';
proc.stdout.on('data', (d) => { out += d; });
proc.stderr.on('data', (d) => { out += d; });

const keys = (k) => proc.stdin.write(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let observedOutput = 0;
const waitFor = async (pattern, timeout = 10_000) => {
  const started = Date.now();
  for (;;) {
    const match = out.slice(observedOutput).match(pattern);
    if (match) {
      observedOutput += match.index + match[0].length;
      return;
    }
    if (Date.now() - started >= timeout) throw new Error(`Timed out waiting for ${pattern}\n${out.slice(-2000)}`);
    await sleep(50);
  }
};

await waitFor(/Login with Telegram/);
keys('3');                     // Join community
console.log('> join');
await waitFor(/Community id/);
keys('7\n');                   // community id 7
console.log('> id');
await waitFor(/Scan bookmarks/);
keys('4');                     // Scan bookmarks (auto-detects all browsers)
console.log('> scan');
await waitFor(/Press .*to continue/);
keys('\n');                    // continue
console.log('> continue');
await waitFor(/Dump bookmarks/);
keys('5');                     // Dump bookmarks
console.log('> dump');
await waitFor(/Dump where\?/);
keys('2');                     // Personal brain
console.log('> personal');
await waitFor(/Send them now\?/);
keys('y');                     // confirm
console.log('> confirm y');
await waitFor(/221 bookmarks stored in personal brain/);
await waitFor(/Dump bookmarks/);
keys('q');                     // quit
console.log('> quit');
proc.stdin.end();              // EOF → script unwinds the pty

const killer = setTimeout(() => {
  console.log('=== STUCK — last TUI output ===');
  console.log(out.slice(-1200));
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
}, 20_000);
await new Promise((r) => proc.on('close', r));
clearTimeout(killer);

fs.rmSync(testHome, { recursive: true, force: true });
server.closeAllConnections();
server.close();

const checks = [
  ['join ok', /Neo Circle/],
  ['scan ok', /unique bookmarks/],
  ['god personal target', /personal brain/],
  ['dump summary', /stored in personal brain/],
  ['added count', /221 bookmarks stored/],
];
let fail = 0;
for (const [name, re] of checks) {
  const hit = re.test(out);
  console.log(`${hit ? 'PASS' : 'FAIL'} ${name}`);
  if (!hit) fail += 1;
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
