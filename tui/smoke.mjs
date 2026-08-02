import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeClient, rankOf } from './src/api.js';
import { detectBookmarks, loadBookmarks, dedupe } from './src/browsers.js';

let failures = 0;
const ok = (name, cond) => {
  if (cond) console.log(`PASS ${name}`);
  else { console.log(`FAIL ${name}`); failures += 1; }
};

const server = http.createServer((req, res) => {
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(body).toString();
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const auth = req.headers.authorization === 'Bearer test-token';
    if (req.url === '/api/health') return send(200, { ok: true, version: '6.18.8' });
    if (req.url === '/api/storage/config') return send(200, { provider: 'postgres' });
    if (req.url === '/api/auth/me') return send(auth ? 200 : 401, auth ? { user: { username: 'neo', is_god: true } } : { error: { type: 'UNAUTHORIZED' } });
    if (req.url === '/api/communities/join' && req.method === 'POST') {
      const { community_id } = JSON.parse(raw);
      if (community_id === '999') return send(404, { error: { type: 'NOT_FOUND', message: 'no such community' } });
      return send(200, { community: { id: community_id, name: 'Neo Circle', role: 'owner' } });
    }
    if (req.url === '/api/links' && req.method === 'POST') {
      const p = JSON.parse(raw);
      if (new URL(p.url).hostname === 'dupe.example') return send(409, { error: { type: 'ALREADY_EXISTS', message: 'already known' } });
      return send(200, { link: { id: 1 } });
    }
    if (req.url === '/api/personal-links' && req.method === 'POST') {
      return send(200, { link: { id: 2 } });
    }
    send(404, { error: { type: 'NOT_FOUND' } });
  });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const client = makeClient(base, 'test-token');
ok('health', (await client.health()).ok === true);
ok('storage provider', (await client.storageConfig()).provider === 'postgres');
ok('me with token', (await client.me()).user.is_god === true);
ok('rank god', rankOf({ is_god: true }).label === 'GOD');
ok('rank user', rankOf({}).label === 'USER');
ok('join ok', (await client.joinCommunity('7')).community.name === 'Neo Circle');
let caught = null;
try { await client.joinCommunity('999'); } catch (e) { caught = e; }
ok('join 404 error', caught?.type === 'NOT_FOUND' && caught?.status === 404);
ok('post link', (await client.postLink({ community_id: 7, url: 'https://a.com' })).link.id === 1);
caught = null;
try { await client.postLink({ community_id: 7, url: 'https://dupe.example/' }); } catch (e) { caught = e; }
ok('dupe 409', caught?.type === 'ALREADY_EXISTS' && caught?.status === 409);
ok('personal link', (await client.postPersonalLink({ url: 'https://p.com' })).link.id === 2);
caught = null;
try { await makeClient(base, 'bad').me(); } catch (e) { caught = e; }
ok('unauthorized', caught?.status === 401);

const dir = mkdtempSync(path.join(tmpdir(), 'athena-tui-'));
try {
  const chrome = path.join(dir, 'Bookmarks');
  writeFileSync(chrome, JSON.stringify({
    roots: {
      bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
        { type: 'url', name: 'Cloudflare', url: 'https://cloudflare.com/' },
        { type: 'url', name: 'local file', url: 'file:///etc/passwd' },
        { type: 'folder', name: 'Dev', children: [
          { type: 'url', name: 'GitHub', url: 'https://github.com' },
          { type: 'url', name: 'GitHub again', url: 'https://github.com/' },
        ] },
      ] },
      other: { type: 'folder', name: 'Other', children: [] },
      synced: { type: 'folder', name: 'Synced', children: [] },
    },
  }, null, 2));
  const links = await loadBookmarks({ kind: 'chromium', file: chrome });
  ok('chromium urls', links.length === 3);
  ok('folder tag', links.find((l) => l.url === 'https://github.com')?.tags?.includes('Dev'));
  ok('dedupe', dedupe(links).length === 2 && dedupe(links.concat(links)).length === 2);

  const html = path.join(dir, 'export.html');
  writeFileSync(html, `<DL><p><DT><H3>Dev</H3><DL><p><DT><A HREF="https://ex.org">Ex</A></DL><p><DT><A HREF="https://plain.org">Plain</A></DL><p><DT><A HREF="https://xss.org"><script>alert(1)</script>Evil<img src=x>&amp;lt;script&amp;gt;</A>`);
  const htmlLinks = await loadBookmarks({ kind: 'export', file: html });
  ok('html export', htmlLinks.length === 3 && htmlLinks.find((l) => l.url === 'https://ex.org')?.tags?.[0] === 'Dev');
  const xss = htmlLinks.find((l) => l.url === 'https://xss.org');
  ok('html title sanitized', xss?.title === 'alert(1)Evil' && !xss.title.includes('<') && !xss.title.includes('&'));

  const detected = detectBookmarks();
  console.log(`INFO detected: ${detected.length}`);
  ok('detection shape', detected.every((d) => d.name && d.file));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

server.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
