import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  buildSearchBlob,
  cleanApiBase,
  compactAiContext,
  dedupeLinkRows,
  detectBackupCommunityId,
  importBackupSql,
  notesForUrl,
  fuzzyMatchLinks,
  helpTextForSection,
  isGroundedAiAnswer,
  normalizeModelId,
  parseAiDescribeResponse,
  parseTelegramEditPayload,
  rankLinks,
  resolveChatEndpoint,
  resultLimitClause
} from '../worker/index.js';

assert.equal(resultLimitClause(null), '');
assert.equal(resultLimitClause(20), ' LIMIT 20');
assert.equal(normalizeModelId('Big Pickle', 'https://opencode.ai/zen/v1'), 'big-pickle');
assert.equal(normalizeModelId('DeepSeek V4 Flash', 'https://opencode.ai/zen/v1'), 'deepseek-v4-flash');
assert.equal(normalizeModelId('opencode/big-pickle', 'https://opencode.ai/zen/v1'), 'big-pickle');
assert.equal(normalizeModelId('openai/gpt-4o-mini', 'https://openrouter.ai/api/v1'), 'openai/gpt-4o-mini');
assert.equal(cleanApiBase('https://opencode.ai/zen/v1/chat/completions'), 'https://opencode.ai/zen/v1');
assert.equal(cleanApiBase('https://openrouter.ai/api/v1/models'), 'https://openrouter.ai/api/v1');
assert.equal(resolveChatEndpoint('https://opencode.ai/zen/v1', 'openai', 'big-pickle'), 'https://opencode.ai/zen/v1/chat/completions');
assert.equal(resolveChatEndpoint('https://opencode.ai/zen/v1', 'openai', 'gpt-5.6-sol'), 'https://opencode.ai/zen/v1/responses');
assert.equal(resolveChatEndpoint('https://opencode.ai/zen/go/v1', 'openai', 'minimax-m3'), 'https://opencode.ai/zen/go/v1/messages');
assert.equal(resolveChatEndpoint('https://api.openai.com/v1', 'openai', 'gpt-4o-mini'), 'https://api.openai.com/v1/chat/completions');
assert.equal(resolveChatEndpoint('https://api.anthropic.com', 'anthropic', 'claude-sonnet-4-20250514'), 'https://api.anthropic.com/v1/messages');
assert.match(helpTextForSection('personal'), /<code>\/search<\/code>\s*<code>&lt;query&gt;<\/code>/);
assert.match(helpTextForSection('community'), /<code>\/clear_db &lt;id&gt;<\/code>/);

const replyEdit = parseTelegramEditPayload('| title: Correct title | notes: Correct notes', {
  text: 'Saved link https://example.com/item'
});
assert.deepEqual(replyEdit, {
  queryPart: 'https://example.com/item',
  newTitle: 'Correct title',
  newNotes: 'Correct notes'
});
const shorthandEdit = parseTelegramEditPayload('https://example.com/item | notes only');
assert.deepEqual(shorthandEdit, {
  queryPart: 'https://example.com/item',
  newTitle: null,
  newNotes: 'notes only'
});

assert.deepEqual(parseAiDescribeResponse('```json\n{"title":"English title","description":"Context summary","tags":["#tools","AI tools"]}\n```'), {
  title: 'English title',
  description: 'Context summary',
  tags: ['tools', 'ai-tools']
});

const document = {
  filename: 'README.md',
  content: 'Use yt-dlp to download a video from the archive.',
};
assert.match(buildSearchBlob(document), /ytdlp/);
assert.match(buildSearchBlob(document), /download/);

const rankedMovieRows = rankLinks([
  { id: 'law', title: 'Public International Law (John H Currie) (Z-Library).pdf', filename: 'law.pdf', content: 'Public international law reference.' },
  { id: 'movie', title: 'Movies4u.VIP - Bollywood and Hollywood Movies Download', url: 'https://movies4u.example/', notes: 'Movie website.' },
], 'list some movie websites');
assert.equal(rankedMovieRows.some(row => row.id === 'law'), false);
assert.equal(rankedMovieRows[0].id, 'movie');
assert.equal(dedupeLinkRows([
  { id: 'doc-1', type: 'document', title: 'First', url: null },
  { id: 'doc-2', type: 'document', title: 'Second', url: null },
]).length, 2);
assert.ok(compactAiContext(['x'.repeat(900), 'y'.repeat(900)], 1000).length <= 1000);
assert.equal(isGroundedAiAnswer('Saved item [#1] https://movies4u.example/', [
  { url: 'https://movies4u.example/' }
]), true);
assert.equal(isGroundedAiAnswer('General answer https://other.example/', [
  { url: 'https://movies4u.example/' }
]), false);

const rows = Array.from({ length: 20 }, (_, i) => ({
  id: `doc-${i}`,
  title: `Document ${i}`,
  filename: `notes-${i}.md`,
  content: 'The provider context contains yt-dlp retrieval notes.',
}));
assert.equal(fuzzyMatchLinks(rows, 'ytdlp').length, rows.length);

const searchWindow = { __athenaSteroid: true };
vm.runInNewContext(
  fs.readFileSync(new URL('../public/src/lib/search.js', import.meta.url), 'utf8'),
  { window: searchWindow }
);
const retrieved = searchWindow.AthenaSearch.retrieveForQuestion('ytdlp', rows);
assert.equal(retrieved.length, rows.length);
searchWindow.__athenaSteroid = false;
const hermesRetrieved = searchWindow.AthenaSearch.retrieveForQuestion('ytdlp', rows, 8);
assert.equal(hermesRetrieved.length, 8);

const movieRows = [
  { id: 'law', title: 'Public International Law (John H Currie) (Z-Library).pdf', filename: 'law.pdf', content: 'Public international law reference.' },
  { id: 'filmygod', title: 'FilmyGod - The Original FilmyGod.UK Website', url: 'https://filmygod.buzz/', notes: 'Movies and web series website.' },
  { id: 'mkv', title: 'mkvCinemas Movies of Bollywood Hollywood and TV Shows', url: 'https://mkvcinemas.nexus/', notes: 'Movies website.' },
];
const movieRetrieved = searchWindow.AthenaSearch.retrieveForQuestion('list some movie websites', movieRows, 8, { minScore: 18, strict: true });
assert.ok(movieRetrieved.some(row => row.id === 'filmygod'));
assert.ok(movieRetrieved.some(row => row.id === 'mkv'));
assert.equal(movieRetrieved.some(row => row.id === 'law'), false);
const hugeDocument = {
  id: 'huge-law',
  title: 'Public International Law reference.pdf',
  filename: 'law.pdf',
  content: 'public international law '.repeat(100000),
};
const hugeRetrieved = searchWindow.AthenaSearch.retrieveForQuestion(
  'list some movie websites', [hugeDocument, ...movieRows], 8, { minScore: 18, strict: true }
);
assert.equal(hugeRetrieved.some(row => row.id === 'huge-law'), false);

const aiWindow = {
  AthenaSearch: searchWindow.AthenaSearch,
  localStorage: { getItem: () => null, setItem: () => {} },
  __athenaSteroid: true
};
vm.runInNewContext(
  fs.readFileSync(new URL('../public/src/lib/ai.js', import.meta.url), 'utf8'),
  { window: aiWindow, localStorage: aiWindow.localStorage }
);
const local = aiWindow.AthenaAI.answerLocal('ytdlp', rows);
assert.equal(local.sources.length, 8);
assert.equal(local.results.length, rows.length);
aiWindow.__athenaSteroid = false;
const hermesLocal = aiWindow.AthenaAI.answerLocal('ytdlp', rows);
assert.equal(hermesLocal.sources.length, 8);
assert.equal(hermesLocal.results.length, 8);
const movieLocal = aiWindow.AthenaAI.answerLocal('list some movie websites', movieRows);
assert.match(movieLocal.answer, /FilmyGod/);
assert.doesNotMatch(movieLocal.answer, /Public International Law/);
assert.equal(
  aiWindow.AthenaAI.formatAiFallbackMessage({ details: { status: 502 } }),
  'AI provider is temporarily unavailable; showing relevant saved matches.'
);
assert.equal(aiWindow.AthenaAI.isGroundedAiAnswer(
  'Saved movie site [#1] https://filmygod.buzz/',
  [{ url: 'https://filmygod.buzz/' }]
), true);
assert.equal(aiWindow.AthenaAI.isGroundedAiAnswer(
  'Here is a general answer: https://untrusted.example/',
  [{ url: 'https://filmygod.buzz/' }]
), false);

// detectBackupCommunityId: backup dumps carry the source community per links row.
const mockEnvWith = (existingIds) => ({
  DB: {
    prepare: () => ({
      bind: (id) => ({
        first: async () => (existingIds.includes(id) ? { id } : null),
      }),
    }),
  },
});
const linkInsert = (cid, url) =>
  `INSERT INTO "links" ("community_id","id","url","url_hash") VALUES ('${cid}','x_${url}','https://${url}','h_${url}');`;
const backupSingle = [
  linkInsert('c_aaa', 'a.com'),
  linkInsert('c_aaa', 'b.com'),
  `INSERT INTO "personal_links" ("user_id","id","url") VALUES ('u1','p1','https://c.com');`,
].join('\n');
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_aaa']), backupSingle), 'c_aaa');
// Two distinct communities -> ambiguous -> ''.
const backupMulti = [linkInsert('c_aaa', 'a.com'), linkInsert('c_bbb', 'b.com')].join('\n');
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_aaa', 'c_bbb']), backupMulti), '');
// Single community unknown locally -> ''.
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_zzz']), backupSingle), '');
// No links rows at all -> ''.
assert.equal(await detectBackupCommunityId(mockEnvWith(['c_aaa']), `INSERT INTO "users" ("id") VALUES ('u1');`), '');

// importBackupSql stamps search_blob at import time so rows are findable
// without waiting for the lazy backfill (regression: bulk imports were
// invisible to /search, e.g. a trailing-slash URL query missing its row).
{
  const inserts = [];
  const fakeDb = {
    prepare: (sql) => ({
      bind: (...args) => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => { inserts.push({ sql, args }); return {}; },
      }),
    }),
  };
  const dump = `INSERT INTO "links" ("community_id","id","url","url_hash","title","notes","tags") VALUES ('c_old','l1','https://enhancv.com/','h1','Enhancv resume builder','make a resume','["jobs"]');`;
  const rep = await importBackupSql({ DB: fakeDb }, dump, { targetCommunityId: 'c_new', targetUserId: 'u_new' });
  assert.equal(rep.linksInserted, 1);
  const linkInsert = inserts.find(i => /INSERT INTO links/.test(i.sql));
  assert.ok(linkInsert, 'links INSERT captured');
  const blobIdx = linkInsert.sql.indexOf('"search_blob"') >= 0
    ? linkInsert.sql.split(',').findIndex(c => c.includes('search_blob'))
    : -1;
  assert.ok(blobIdx >= 0, 'search_blob column present');
  // Values vector layout: (scope,target,id,url,hash,...cols) — find blob by column order.
  const colNames = linkInsert.sql.slice(linkInsert.sql.indexOf('(') + 1, linkInsert.sql.indexOf(')')).split(',').map(c => c.replace(/"/g, '').trim());
  const blob = linkInsert.args[colNames.indexOf('search_blob')];
  assert.ok(String(blob).includes('httpsenhancvcom'), `blob matches stripped URL form, got: ${blob}`);
  assert.ok(!String(blob).includes('://'), 'blob is normalized (no URL punctuation)');
}

// notesForUrl: one message, many links -> each link keeps only its section.
// Regression: backfill stamped the whole listicle message as every link's
// notes (enhancv.com and beautiful.ai shared identical "ChatGPT
// alternatives…" notes).
{
  const listMsg = [
    'ChatGPT alternatives, the best AI tools list:',
    'For writing:',
    'Chatsonic - https://chatsonic.com the conversational writer',
    'For design:',
    'Enhancv resume builder - https://enhancv.com/ make a standout resume',
    'Beautiful presentations - https://www.beautiful.ai/ slides in minutes',
  ].join('\n');
  const urls = ['https://chatsonic.com', 'https://enhancv.com/', 'https://www.beautiful.ai/'];
  // Single URL keeps the full text (legacy behavior).
  assert.equal(notesForUrl(listMsg, 'https://enhancv.com/', 1), listMsg);
  // Multi URL: enhancv keeps its own line, not the whole list.
  const enh = notesForUrl(listMsg, 'https://enhancv.com/', urls.length);
  assert.ok(enh.includes('enhancv'), `enhancv section kept, got: ${enh}`);
  assert.ok(!enh.includes('chatsonic.com'), 'other link section cut (before)');
  assert.ok(!enh.includes('beautiful.ai'), 'other link section cut (after)');
  assert.ok(!enh.includes('ChatGPT alternatives'), 'list header cut');
  const beau = notesForUrl(listMsg, 'https://www.beautiful.ai/', urls.length);
  assert.ok(beau.includes('Beautiful presentations'), `beautiful section kept, got: ${beau}`);
  assert.ok(!beau.includes('enhancv'), 'neighbour section cut');
  // Bare URL with no descriptive text -> '' (scraper fills it instead).
  assert.equal(notesForUrl('https://a.com https://b.com', 'https://a.com', 2), '');
  // Unknown URL -> ''.
  assert.equal(notesForUrl(listMsg, 'https://missing.example/', 3), '');
}

console.log('retrieval tests passed');
