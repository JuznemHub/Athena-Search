import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseFeed, parseOpml, generateOpml } from '../worker/rss-parser.js';
import { PRIMARY_KEYS } from '../worker/pgcompat.js';
import {
  ensureFeedTables,
  autoIngestRssArticle,
  handleGetFeedSources,
  handleGetFeedStreams,
  handleUpdateFeed,
  handlePatchFeedArticle,
  handleMarkAllArticlesRead,
  handleDeleteFeed,
} from '../worker/index.js';

// 1. Verify PRIMARY_KEYS for Postgres compatibility
assert(Array.isArray(PRIMARY_KEYS.rss_feeds), 'PRIMARY_KEYS must have rss_feeds');
assert(Array.isArray(PRIMARY_KEYS.rss_articles), 'PRIMARY_KEYS must have rss_articles');
assert(Array.isArray(PRIMARY_KEYS.rss_article_states), 'PRIMARY_KEYS must have rss_article_states');
assert.deepEqual(PRIMARY_KEYS.rss_feeds, ['id']);
assert.deepEqual(PRIMARY_KEYS.rss_articles, ['id']);
assert.deepEqual(PRIMARY_KEYS.rss_article_states, ['article_id', 'user_id']);

// 2. Test RSS 2.0 parsing
const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Hacker News</title>
    <link>https://news.ycombinator.com/</link>
    <description>Links for the intellectually curious</description>
    <item>
      <title><![CDATA[Show HN: Athena RSS Reader & Brain]]></title>
      <link>https://news.ycombinator.com/item?id=12345</link>
      <pubDate>Wed, 12 Nov 2026 12:00:00 GMT</pubDate>
      <dc:creator>juznem</dc:creator>
      <guid isPermaLink="false">item-12345</guid>
      <description>Discussion of RSS feeds and second brain search</description>
      <content:encoded><![CDATA[<p>Full article content with a <img src="https://example.com/banner.png" /> lead image.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const parsedRss = parseFeed(sampleRss);
assert.equal(parsedRss.type, 'rss');
assert.equal(parsedRss.title, 'Hacker News');
assert.equal(parsedRss.siteUrl, 'https://news.ycombinator.com/');
assert.equal(parsedRss.articles.length, 1);
assert.equal(parsedRss.articles[0].title, 'Show HN: Athena RSS Reader & Brain');
assert.equal(parsedRss.articles[0].guid, 'item-12345');
assert.equal(parsedRss.articles[0].author, 'juznem');
assert.equal(parsedRss.articles[0].imageUrl, 'https://example.com/banner.png');
assert(parsedRss.articles[0].publishedAt > 0);

// 3. Test Atom 1.0 parsing
const sampleAtom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>GitHub Blog</title>
  <subtitle>Updates from GitHub</subtitle>
  <link href="https://github.blog" rel="alternate"/>
  <entry>
    <title>Git 2.45 Release Notes</title>
    <link href="https://github.blog/2026-git-release"/>
    <id>tag:github.blog,2026:git-245</id>
    <updated>2026-11-12T10:00:00Z</updated>
    <summary>Highlights of Git 2.45</summary>
    <content type="html">&lt;p&gt;Full announcement text here.&lt;/p&gt;</content>
    <author><name>Octocat</name></author>
  </entry>
</feed>`;

const parsedAtom = parseFeed(sampleAtom);
assert.equal(parsedAtom.type, 'atom');
assert.equal(parsedAtom.title, 'GitHub Blog');
assert.equal(parsedAtom.siteUrl, 'https://github.blog');
assert.equal(parsedAtom.articles.length, 1);
assert.equal(parsedAtom.articles[0].title, 'Git 2.45 Release Notes');
assert.equal(parsedAtom.articles[0].guid, 'tag:github.blog,2026:git-245');
assert.equal(parsedAtom.articles[0].url, 'https://github.blog/2026-git-release');
assert.equal(parsedAtom.articles[0].author, 'Octocat');
assert.equal(parsedAtom.articles[0].summary, 'Highlights of Git 2.45');

// 4. Test JSON Feed parsing
const sampleJsonFeed = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Daring Fireball',
  home_page_url: 'https://daringfireball.net/',
  items: [
    {
      id: 'df-post-1',
      url: 'https://daringfireball.net/2026/11/post',
      title: 'A New Era of RSS',
      content_html: '<p>John Gruber writes about feeds.</p>',
      date_published: '2026-11-12T09:00:00Z'
    }
  ]
});

const parsedJson = parseFeed(sampleJsonFeed);
assert.equal(parsedJson.type, 'jsonfeed');
assert.equal(parsedJson.title, 'Daring Fireball');
assert.equal(parsedJson.articles.length, 1);
assert.equal(parsedJson.articles[0].title, 'A New Era of RSS');
assert.equal(parsedJson.articles[0].url, 'https://daringfireball.net/2026/11/post');

// 5. Test OPML import & export
const sampleOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Technology">
      <outline type="rss" text="Hacker News" xmlUrl="https://news.ycombinator.com/rss" htmlUrl="https://news.ycombinator.com"/>
      <outline type="rss" text="Ars Technica" xmlUrl="https://arstechnica.com/feed/" htmlUrl="https://arstechnica.com"/>
    </outline>
    <outline type="rss" text="XKCD" xmlUrl="https://xkcd.com/rss.xml" category="Comics"/>
  </body>
</opml>`;

const parsedOutlines = parseOpml(sampleOpml);
assert.equal(parsedOutlines.length, 3);
assert.equal(parsedOutlines[0].title, 'Hacker News');
assert.equal(parsedOutlines[0].category, 'Technology');
assert.equal(parsedOutlines[1].title, 'Ars Technica');
assert.equal(parsedOutlines[1].category, 'Technology');
assert.equal(parsedOutlines[2].title, 'XKCD');
assert.equal(parsedOutlines[2].category, 'Comics');

const generatedOpml = generateOpml([
  { title: 'Test Feed 1', url: 'https://test.com/rss', category: 'Tech' },
  { title: 'Test Feed 2', url: 'https://test2.com/atom', category: 'News' }
]);
assert(generatedOpml.includes('xmlUrl="https://test.com/rss"'));
assert(generatedOpml.includes('outline text="Tech"'));
assert(generatedOpml.includes('outline text="News"'));

// 6. Test Mock Database, Schema, and Ingestion
function createMockDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      tags TEXT,
      added_by TEXT NOT NULL,
      added_by_user_id TEXT,
      added_by_provider TEXT,
      added_by_name TEXT,
      upvotes INTEGER NOT NULL DEFAULT 0,
      downvotes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      image_url TEXT,
      site_name TEXT
    );
    CREATE TABLE IF NOT EXISTS personal_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      image_url TEXT,
      site_name TEXT
    );
  `);

  return {
    exec(sql) { db.exec(sql); },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              const stmt = db.prepare(sql);
              return stmt.get(...args) || null;
            },
            async all() {
              const stmt = db.prepare(sql);
              return { results: stmt.all(...args) };
            },
            async run() {
              const stmt = db.prepare(sql);
              const info = stmt.run(...args);
              return { changes: info.changes };
            }
          };
        }
      };
    }
  };
}

const mockDb = createMockDb();
const env = { DB: mockDb };
const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
const testUser = { id: 'usr_1', display_name: 'Tester', provider: 'telegram' };

await ensureFeedTables(env);

// Test autoIngestRssArticle into links table
const testFeed = {
  id: 'feed_1',
  community_id: 'comm_1',
  user_id: 'usr_1',
  title: 'TechCrunch',
  category: 'Tech'
};

const testArticle = {
  guid: 'tc_101',
  url: 'https://techcrunch.com/2026/11/ai-news',
  title: 'The Future of AI Feeds',
  summary: 'Exciting news about RSS and AI synthesis.',
  publishedAt: Date.now() - 5000,
  imageUrl: 'https://techcrunch.com/img.jpg'
};

const linkId = await autoIngestRssArticle(env, testArticle, testFeed, testUser);
assert(linkId, 'Auto-ingest should return generated linkId');

// Verify link exists in links table
const savedLink = await mockDb.prepare('SELECT * FROM links WHERE id = ?').bind(linkId).first();
assert.equal(savedLink.title, 'The Future of AI Feeds');
assert.equal(savedLink.community_id, 'comm_1');
assert.equal(savedLink.site_name, 'TechCrunch');
assert(savedLink.tags.includes('rss'));

// Test feed subscription & article insertion
await env.DB.prepare(
  `INSERT INTO rss_feeds (id, community_id, user_id, url, url_hash, title, category, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
).bind('feed_1', 'comm_1', 'usr_1', 'https://techcrunch.com/feed', 'tc_hash', 'TechCrunch', 'Tech', Date.now()).run();

await env.DB.prepare(
  `INSERT INTO rss_articles (id, feed_id, community_id, guid, url, url_hash, title, author, summary, published_at, created_at, link_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind('art_1', 'feed_1', 'comm_1', testArticle.guid, testArticle.url, 'art_hash', testArticle.title, 'Author', testArticle.summary, Date.now(), Date.now(), linkId).run();

// Test combined stream=feed_1&state=unread (regression test for clicking a feed in Unread tab)
const feedUnreadUrl = new URL('https://athena.test/api/feed/streams?community_id=comm_1&stream=feed_1&state=unread');
const feedUnreadRes = await handleGetFeedStreams(feedUnreadUrl, testUser, env, corsHeaders);
const feedUnreadData = await feedUnreadRes.json();
assert(feedUnreadData.success);
assert.equal(feedUnreadData.articles.length, 1, 'Clicking a feed while on Unread tab must return its unread articles');

// Test pinning feed as Important via handleUpdateFeed
const pinReq = new Request('https://athena.test/api/feed', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feed_id: 'feed_1', is_important: true })
});
const pinRes = await handleUpdateFeed(pinReq, testUser, env, corsHeaders);
const pinData = await pinRes.json();
assert(pinData.success);

// Test handleGetFeedSources includes total_important_unread
const sourcesUrl = new URL('https://athena.test/api/feed/sources?community_id=comm_1');
const sourcesRes = await handleGetFeedSources(sourcesUrl, testUser, env, corsHeaders);
const sourcesData = await sourcesRes.json();
assert(sourcesData.success);
assert.equal(sourcesData.categories.length, 1);
assert.equal(sourcesData.categories[0].name, 'Tech');
assert.equal(sourcesData.total_unread, 1);
assert.equal(sourcesData.total_important_unread, 1);
assert.equal(sourcesData.categories[0].feeds[0].is_important, true);

// Test stream=important
const impStreamUrl = new URL('https://athena.test/api/feed/streams?community_id=comm_1&stream=important&state=all');
const impStreamRes = await handleGetFeedStreams(impStreamUrl, testUser, env, corsHeaders);
const impStreamData = await impStreamRes.json();
assert(impStreamData.success);
assert.equal(impStreamData.articles.length, 1);
assert.equal(impStreamData.articles[0].feed_is_important, true);

// Test handlePatchFeedArticle (marking read, starred, custom labels, and saving copy to Personal DB)
const patchReq = new Request('https://athena.test/api/feed/article', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    article_id: 'art_1',
    is_read: true,
    is_starred: true,
    labels: ['read-later', 'ai-digest'],
    save_to_personal: true
  })
});
const patchRes = await handlePatchFeedArticle(patchReq, testUser, env, corsHeaders);
const patchData = await patchRes.json();
assert(patchData.success);
assert.equal(patchData.is_read, true);
assert.equal(patchData.is_starred, true);
assert.deepEqual(patchData.labels, ['read-later', 'ai-digest']);
assert(patchData.personal_link_id, 'Saving community article to Personal DB must return personal_link_id');

// Verify label filter and search operators on handleGetFeedStreams
const labelFilterUrl = new URL('https://athena.test/api/feed/streams?community_id=comm_1&stream=all&state=all&label=read-later');
const labelFilterRes = await handleGetFeedStreams(labelFilterUrl, testUser, env, corsHeaders);
const labelFilterData = await labelFilterRes.json();
assert.equal(labelFilterData.articles.length, 1);
assert.deepEqual(labelFilterData.articles[0].labels, ['read-later', 'ai-digest']);

const searchOpUrl = new URL('https://athena.test/api/feed/streams?community_id=comm_1&stream=all&state=all&search=author:Author%20intitle:Future');
const searchOpRes = await handleGetFeedStreams(searchOpUrl, testUser, env, corsHeaders);
const searchOpData = await searchOpRes.json();
assert.equal(searchOpData.articles.length, 1);

// Verify unread count becomes 0
const sourcesRes2 = await handleGetFeedSources(sourcesUrl, testUser, env, corsHeaders);
const sourcesData2 = await sourcesRes2.json();
assert.equal(sourcesData2.total_unread, 0);
assert.equal(sourcesData2.total_starred, 1);

// Test handleMarkAllArticlesRead
const markReq = new Request('https://athena.test/api/feed/mark-all-read', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ community_id: 'comm_1' })
});
const markRes = await handleMarkAllArticlesRead(markReq, testUser, env, corsHeaders);
const markData = await markRes.json();
assert(markData.success);

// Test handleDeleteFeed
const delReq = new Request('https://athena.test/api/feed', {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feed_id: 'feed_1' })
});
const delRes = await handleDeleteFeed(delReq, testUser, env, corsHeaders);
const delData = await delRes.json();
assert(delData.success);

const checkFeed = await mockDb.prepare('SELECT * FROM rss_feeds WHERE id = ?').bind('feed_1').first();
assert.equal(checkFeed, null, 'Feed should be deleted');

// --- 7. Personal Feeds & Ingestion to personal_links ---
const personalFeed = {
  id: 'feed_pers_1',
  community_id: 'personal',
  user_id: 'usr_1',
  title: 'My Private Research RSS',
  category: 'AI Research'
};

const personalArticle = {
  guid: 'pers_art_202',
  url: 'https://arxiv.org/abs/2611.12345',
  title: 'Autonomous Multi-Agent Orchestration in Practice',
  summary: 'Breakthroughs in distributed agent collaboration.',
  publishedAt: Date.now() - 3600000,
  imageUrl: 'https://arxiv.org/img.png'
};

const personalLinkId = await autoIngestRssArticle(env, personalArticle, personalFeed, testUser);
assert(personalLinkId, 'Auto-ingest should return linkId for personal article');

// Verify it exists in personal_links, NOT links
const savedPersonalLink = await mockDb.prepare('SELECT * FROM personal_links WHERE id = ?').bind(personalLinkId).first();
assert(savedPersonalLink, 'Article must be in personal_links');
assert.equal(savedPersonalLink.user_id, 'usr_1');
assert.equal(savedPersonalLink.title, 'Autonomous Multi-Agent Orchestration in Practice');
assert(savedPersonalLink.tags.includes('rss'));

const notInLinks = await mockDb.prepare('SELECT * FROM links WHERE id = ?').bind(personalLinkId).first();
assert.equal(notInLinks, null, 'Personal feed article must NOT be stored in community links');

// Insert personal feed & article in DB
await env.DB.prepare(
  `INSERT INTO rss_feeds (id, community_id, user_id, url, url_hash, title, category, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
).bind('feed_pers_1', 'personal', 'usr_1', 'https://arxiv.org/rss/cs.AI', 'arxiv_hash', 'My Private Research RSS', 'AI Research', Date.now()).run();

await env.DB.prepare(
  `INSERT INTO rss_articles (id, feed_id, community_id, guid, url, url_hash, title, author, summary, published_at, created_at, link_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind('art_pers_1', 'feed_pers_1', 'personal', personalArticle.guid, personalArticle.url, 'arxiv_art_hash', personalArticle.title, 'Researchers', personalArticle.summary, Date.now(), Date.now(), personalLinkId).run();

// Verify user 1 sees personal feed
const user1SourcesUrl = new URL('https://athena.test/api/feed/sources?community_id=personal');
const user1SourcesRes = await handleGetFeedSources(user1SourcesUrl, testUser, env, corsHeaders);
const user1SourcesData = await user1SourcesRes.json();
assert(user1SourcesData.success);
assert.equal(user1SourcesData.categories.length, 1);
assert.equal(user1SourcesData.categories[0].name, 'AI Research');
assert.equal(user1SourcesData.total_unread, 1);

// Verify user 2 (different user) sees 0 feeds in personal scope
const otherUser = { id: 'usr_2', display_name: 'Other User' };
const user2SourcesRes = await handleGetFeedSources(user1SourcesUrl, otherUser, env, corsHeaders);
const user2SourcesData = await user2SourcesRes.json();
assert(user2SourcesData.success);
assert.equal(user2SourcesData.categories.length, 0, 'User 2 must not see User 1 personal feeds');
assert.equal(user2SourcesData.total_unread, 0);

// Verify user 2 cannot delete user 1's personal feed
const unauthorizedDelReq = new Request('https://athena.test/api/feed', {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feed_id: 'feed_pers_1' })
});
const unauthorizedDelRes = await handleDeleteFeed(unauthorizedDelReq, otherUser, env, corsHeaders);
assert.equal(unauthorizedDelRes.status, 403, 'Unauthorized user must receive 403 when deleting another user personal feed');

// Verify user 1 CAN delete own personal feed
const authorizedDelReq = new Request('https://athena.test/api/feed', {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feed_id: 'feed_pers_1' })
});
const authorizedDelRes = await handleDeleteFeed(authorizedDelReq, testUser, env, corsHeaders);
const authorizedDelData = await authorizedDelRes.json();
assert(authorizedDelData.success);

const checkPersonalFeed = await mockDb.prepare('SELECT * FROM rss_feeds WHERE id = ?').bind('feed_pers_1').first();
assert.equal(checkPersonalFeed, null, 'Personal feed should be deleted');

console.log('All RSS Feed and FreshRSS integration tests passed successfully.');

