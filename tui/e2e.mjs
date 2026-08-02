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
    if (req.url === '/api/health') return send(200, { ok: true, version: '6.18.8' });
    if (req.url === '/api/storage/config') return send(200, { provider: 'postgres' });
    if (req.url === '/api/auth/me') return send(200, { user: { username: 'neo', is_god: true } });
    if (req.url === '/api/communities/join' && req.method === 'POST') {
      return send(200, { community: { id: JSON.parse(raw).community_id, name: 'Neo Circle', role: 'owner' } });
    }
    if (req.url === '/api/personal-links' && req.method === 'POST') return send(200, { link: { id: 1 } });
    send(404, { error: { type: 'NOT_FOUND' } });
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const chromeDir = path.join(os.homedir(), '.config', 'google-chrome', 'Default');
fs.mkdirSync(chromeDir, { recursive: true });
fs.writeFileSync(path.join(chromeDir, 'Bookmarks'), JSON.stringify({
  roots: { bookmark_bar: { type: 'folder', name: 'bar', children: [
    { type: 'url', name: 'Cf', url: 'https://cloudflare.com/' },
    { type: 'url', name: 'Gh', url: 'https://github.com/' },
  ] }, other: { type: 'folder', children: [] }, synced: { type: 'folder', children: [] } },
}));

const env = {
  ...process.env,
  ATHENA_INSTANCE: `http://127.0.0.1:${port}`,
  ATHENA_TOKEN: 'test-token',
  ATHENA_TUI_NO_ANIMATION: '1',
};
fs.rmSync(path.join(os.homedir(), '.config', 'athena-tui', 'config.json'), { force: true });

const cmd = `script -qec "node src/index.js" /dev/null`;
const proc = spawn('bash', ['-c', cmd], { cwd: process.cwd(), env, detached: true });

let out = '';
proc.stdout.on('data', (d) => { out += d; });
proc.stderr.on('data', (d) => { out += d; });

const keys = (k) => proc.stdin.write(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(1200);
keys('3');                     // Join community
console.log('> join');
await sleep(600);
keys('7\n');                   // community id 7
console.log('> id');
await sleep(800);
keys('4');                     // Scan bookmarks
console.log('> scan');
await sleep(600);
keys('\n');                    // All detected browsers
console.log('> source');
await sleep(1500);
keys('\n');                    // continue
console.log('> continue');
await sleep(600);
keys('5');                     // Dump bookmarks
console.log('> dump');
await sleep(800);
keys('2');                     // Personal brain
console.log('> personal');
await sleep(600);
keys('y');                     // confirm
console.log('> confirm y');
await sleep(2000);
keys('q');                     // quit
console.log('> quit');
proc.stdin.end();              // EOF → script unwinds the pty

const killer = setTimeout(() => {
  console.log('=== STUCK — last TUI output ===');
  console.log(out.slice(-1200));
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
}, 20000);
await new Promise((r) => proc.on('close', r));
clearTimeout(killer);

fs.rmSync(path.dirname(chromeDir), { recursive: true, force: true });
server.closeAllConnections();
server.close();

const checks = [
  ['join ok', /Neo Circle/],
  ['scan ok', /unique bookmarks/],
  ['god personal target', /personal brain/],
  ['dump summary', /stored in personal brain/],
  ['added count', /2 bookmarks stored/],
];
let fail = 0;
for (const [name, re] of checks) {
  const hit = re.test(out);
  console.log(`${hit ? 'PASS' : 'FAIL'} ${name}`);
  if (!hit) fail += 1;
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
