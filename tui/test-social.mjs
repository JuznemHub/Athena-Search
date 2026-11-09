import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRedditFetchJson,
  parseRedditFetchHtml,
  parseYtdJs,
  tweetToLinks,
  parseXArchiveDir,
  parseTweetNookJson,
  loadSocialLinks,
  detectSocialSources,
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
} finally {
  delete process.env.REDDIT_EXPORT_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('PASS social imports (reddit + x/tweetnook)');
