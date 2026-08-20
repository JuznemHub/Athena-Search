import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  buildSearchBlob,
  cleanApiBase,
  fuzzyMatchLinks,
  helpTextForSection,
  normalizeModelId,
  parseAiDescribeResponse,
  parseTelegramEditPayload,
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
assert.match(helpTextForSection('personal'), /\/search (?:<query>|<code>&lt;query&gt;<\/code>)/);
assert.match(helpTextForSection('community'), /\/clear_db (?:<id>|<code>&lt;id&gt;<\/code>)/);

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
assert.equal(local.sources.length, rows.length);
assert.equal(local.results.length, rows.length);
aiWindow.__athenaSteroid = false;
const hermesLocal = aiWindow.AthenaAI.answerLocal('ytdlp', rows);
assert.equal(hermesLocal.sources.length, 5);
assert.equal(hermesLocal.results.length, 8);
const movieLocal = aiWindow.AthenaAI.answerLocal('list some movie websites', movieRows);
assert.match(movieLocal.answer, /FilmyGod/);
assert.doesNotMatch(movieLocal.answer, /Public International Law/);
assert.equal(
  aiWindow.AthenaAI.formatAiFallbackMessage({ details: { status: 502 } }),
  'AI provider is temporarily unavailable; showing relevant saved matches.'
);

console.log('retrieval tests passed');
