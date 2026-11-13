import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseRedditFetchJson,
  parseRedditFetchHtml,
  parseYtdJs,
  tweetToLinks,
  parseXArchiveDir,
  parseTweetNookJson,
  loadSocialLinks,
  detectSocialSources,
  socialSourceFor,
  findRedditCheckout,
  writeRedditEnv,
  savedPostsPath,
  runTool,
  extractZip,
  toolStatus,
} from './src/social-import.js';

// Reddit-Fetch JSON: posts + comments
const reddit = parseRedditFetchJson([
  { title: 'Cool tool', url: 'https://example.org/tool', subreddit: 'selfhosted', type: 'post', author: 'u1', score: 5 },
  { title: 'Comment in: Cool tool', url: '', permalink: '/r/selfhosted/comments/abc/x/', subreddit: 'selfhosted', type: 'comment', body: 'nice' },
  { title: '', url: 'not-a-url', subreddit: 'x' },
]);
assert.equal(reddit.length, 2);
assert.deepEqual(reddit[0].tags, ['reddit', 'r-selfhosted']);
assert.match(reddit[1].url, /reddit\.com\/r\/selfhosted/);
assert.ok(reddit[1].tags.includes('comment'));

// {content} envelope (library return shape)
assert.equal(parseRedditFetchJson({ content: reddit, count: 2 }).length, 2);

// HTML fallback
const html = parseRedditFetchHtml('<A HREF="https://www.reddit.com/r/selfhosted/comments/1/x/">Cool tool</A>');
assert.equal(html.length, 1);
assert.ok(html[0].tags.includes('reddit'));

// X archive: tweets.js with external link + text-only tweet, account.js name
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-social-'));
try {
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'account.js'),
    'window.YTD.account.part0 = [{"account": {"username": "alice"}}]');
  fs.writeFileSync(path.join(dir, 'data', 'tweets.js'),
    'window.YTD.tweets.part0 = ['
    + '{"tweet": {"id_str": "1", "full_text": "Look at this https://example.org/tool", "entities": {"urls": [{"expanded_url": "https://example.org/tool"}]}}},'
    + '{"tweet": {"id_str": "2", "full_text": "Just thinking out loud", "entities": {"urls": []}}}'
    + ']');
  fs.writeFileSync(path.join(dir, 'data', 'like.js'),
    'window.YTD.like.part0 = [{"like": {"tweetId": "99", "fullText": "liked thought", "expandedUrl": ""}}]');
  const links = parseXArchiveDir(dir);
  assert.equal(links.length, 3);
  const byUrl = new Map(links.map((l) => [l.url, l]));
  assert.ok(byUrl.has('https://example.org/tool'));
  assert.ok(byUrl.get('https://example.org/tool').tags.includes('x'));
  assert.equal(byUrl.get('https://x.com/alice/status/2').title, 'Just thinking out loud');
  assert.ok(byUrl.has('https://x.com/i/status/99'));

  // tweetToLinks: x.com links inside text are not kept as entries — the
  // tweet itself is archived instead; mixed tweets keep only externals.
  assert.deepEqual(
    tweetToLinks({ id_str: '5', full_text: 'rt https://x.com/bob/status/6', entities: { urls: [{ expanded_url: 'https://x.com/bob/status/6' }] } }, { screenName: 'alice' }).map((l) => l.url),
    ['https://x.com/alice/status/5'],
  );
  assert.deepEqual(
    tweetToLinks({ id_str: '6', full_text: 'read https://example.org/a https://x.com/bob/status/1', entities: { urls: [{ expanded_url: 'https://example.org/a' }, { expanded_url: 'https://x.com/bob/status/1' }] } }, {}).map((l) => l.url),
    ['https://example.org/a'],
  );

  // loadSocialLinks dispatch
  const rf = path.join(dir, 'saved_posts.json');
  fs.writeFileSync(rf, JSON.stringify([{ title: 'T', url: 'https://example.org/t', subreddit: 's' }]));
  assert.equal((await loadSocialLinks({ kind: 'reddit-json', file: rf })).length, 1);
  assert.equal((await loadSocialLinks({ kind: 'x-archive', file: dir })).length, 3);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// TweetNook export shape
const tn = parseTweetNookJson([{ post_url: 'https://x.com/bob/status/7', text: 'hello', author: 'bob', collection: 'bookmarks' }]);
assert.equal(tn.length, 1);
assert.ok(tn[0].tags.includes('x') && tn[0].tags.includes('from-bob'));

const currentTweetNookPost = {
  tweet_id: '7',
  text: '  Saved thought\nwith context  ',
  author: { id: '42', username: 'bob', display_name: 'Bob' },
  created_at: '2026-11-12T12:00:00Z',
  collection: { type: 'bookmarks', folder_id: null, sort_index: null, added_at: null, synced_at: null },
  media: [],
  urls: [],
  article: null,
  media_tags: [],
  qt_media_tags: [],
  raw_json: {},
};
assert.deepEqual(parseTweetNookJson([currentTweetNookPost]), [{
  url: 'https://x.com/bob/status/7',
  title: 'Saved thought with context',
  tags: ['x', 'bookmark', 'from-bob'],
}]);
assert.deepEqual(parseTweetNookJson([{
  ...currentTweetNookPost, author: null, text: '', collection: { type: 'likes' },
}]), [{
  url: 'https://x.com/i/status/7', title: 'https://x.com/i/status/7', tags: ['x', 'like'],
}]);
assert.deepEqual(parseTweetNookJson([{
  ...currentTweetNookPost,
  tags: ['Tools', 'tools'],
  urls: [
    { position: 0, url_hash: 'a', short_url: 'https://t.co/a', expanded_url: 'https://example.org/redirect', display_url: 'example.org/a', canonical_url: 'https://example.org/a', resolved: null },
    { position: 1, url_hash: 'b', short_url: 'https://t.co/b', expanded_url: 'https://example.org/a', display_url: 'example.org/a', canonical_url: null, resolved: null },
    { position: 2, url_hash: 'c', short_url: 'https://t.co/c', expanded_url: 'https://x.com/alice/status/8', display_url: 'x.com/alice/status/8', canonical_url: null, resolved: null },
  ],
}]), [{
  url: 'https://example.org/a', title: 'Saved thought with context', tags: ['x', 'bookmark', 'from-bob', 'tools'],
}]);
assert.deepEqual(parseTweetNookJson({ posts: [{
  id_str: '9', screen_name: 'alice', full_text: 'Legacy post', collection: 'bookmarks',
}] }), [{
  url: 'https://x.com/alice/status/9', title: 'Legacy post', tags: ['x', 'bookmarks'],
}]);

// parseYtdJs rejects non-arrays
assert.equal(parseYtdJs('window.YTD.x.part0 = {"a":1}'), null);
assert.equal(parseYtdJs('no brackets'), null);

// detection honors env paths
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-social-env-'));
try {
  const f = path.join(tmp, 'saved_posts.json');
  fs.writeFileSync(f, '[]');
  process.env.REDDIT_EXPORT_PATH = f;
  assert.ok(detectSocialSources().some((s) => s.file === f && s.kind === 'reddit-json'));
  const tweetNookFile = path.join(tmp, 'posts.json');
  fs.writeFileSync(tweetNookFile, JSON.stringify([currentTweetNookPost]));
  process.env.TWEETNOOK_EXPORT_PATH = tweetNookFile;
  const source = detectSocialSources().find((s) => s.file === tweetNookFile);
  assert.equal(source.kind, 'tweetnook-json');
  assert.deepEqual(await loadSocialLinks(source), [{
    url: 'https://x.com/bob/status/7',
    title: 'Saved thought with context',
    tags: ['x', 'bookmark', 'from-bob'],
  }]);
} finally {
  delete process.env.REDDIT_EXPORT_PATH;
  delete process.env.TWEETNOOK_EXPORT_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// guided setup helpers
const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-social-setup-'));
try {
  const co = path.join(fix, 'Reddit-Fetch');
  fs.mkdirSync(path.join(co, 'reddit_fetch'), { recursive: true });
  fs.writeFileSync(path.join(co, 'reddit_fetch', 'api.py'), '# stub');
  assert.equal(findRedditCheckout(['/nope', co]), co);
  assert.equal(findRedditCheckout(['/nope']), null);
  const envFile = writeRedditEnv(co, { clientId: 'id 1', clientSecret: 's3cr3t', username: 'bob' });
  const envText = fs.readFileSync(envFile, 'utf8');
  assert.match(envText, /^CLIENT_ID=id 1$/m);
  assert.match(envText, /^REDDIT_USERNAME=bob$/m);
  assert.match(envText, /by \/u\/bob/);
  const st = fs.statSync(envFile);
  assert.ok((st.mode & 0o777) === 0o600);
  fs.writeFileSync(path.join(co, 'saved_posts.json'), '[]');
  assert.equal(savedPostsPath(co), path.join(co, 'saved_posts.json'));
  assert.equal(savedPostsPath(fix), null);
  assert.deepEqual(socialSourceFor(path.join(co, 'saved_posts.json')).kind, 'reddit-json');
  assert.deepEqual(socialSourceFor(co, 'X').kind, 'x-archive');
  const echo = await runTool(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(echo.status, 0);
  assert.equal(echo.output, 'hi');
  const fail = await runTool(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(fail.status, 3);
  const tools = toolStatus();
  assert.equal(typeof tools.python, 'boolean');
  assert.equal(typeof tools.redditFetcher, 'boolean');
} finally {
  fs.rmSync(fix, { recursive: true, force: true });
}

// extractZip round-trip (needs python3 or unzip)
try {
  const zd = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-social-zip-'));
  try {
    const srcDir = path.join(zd, 'src');
    fs.mkdirSync(path.join(srcDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'data', 't.js'), 'window.YTD.t.part0 = []');
    const zipFile = path.join(zd, 'a.zip');
    const mk = spawnSync('python3', ['-c', 'import sys,zipfile,os; z=zipfile.ZipFile(sys.argv[1],"w"); z.write(sys.argv[2], "data/t.js"); z.close()', zipFile, path.join(srcDir, 'data', 't.js')]).status;
    if (mk === 0 && fs.existsSync(zipFile)) {
      const dest = path.join(zd, 'out');
      const r = extractZip(zipFile, dest);
      assert.equal(r.ok, true);
      assert.ok(fs.existsSync(path.join(dest, 'data', 't.js')));
    } else {
      console.log('INFO zip round-trip skipped (no python3 zip support)');
    }
  } finally {
    fs.rmSync(zd, { recursive: true, force: true });
  }
} catch (e) {
  throw e;
}

console.log('PASS social imports (reddit + x/tweetnook)');
