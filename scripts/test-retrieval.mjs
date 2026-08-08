import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { buildSearchBlob, fuzzyMatchLinks, resultLimitClause } from '../worker/index.js';

assert.equal(resultLimitClause(null), '');
assert.equal(resultLimitClause(20), ' LIMIT 20');

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

const searchWindow = {};
vm.runInNewContext(
  fs.readFileSync(new URL('../public/src/lib/search.js', import.meta.url), 'utf8'),
  { window: searchWindow }
);
const retrieved = searchWindow.AthenaSearch.retrieveForQuestion('ytdlp', rows);
assert.equal(retrieved.length, rows.length);

const aiWindow = {
  AthenaSearch: searchWindow.AthenaSearch,
  localStorage: { getItem: () => null, setItem: () => {} },
};
vm.runInNewContext(
  fs.readFileSync(new URL('../public/src/lib/ai.js', import.meta.url), 'utf8'),
  { window: aiWindow, localStorage: aiWindow.localStorage }
);
const local = aiWindow.AthenaAI.answerLocal('ytdlp', rows);
assert.equal(local.sources.length, rows.length);
assert.equal(local.results.length, rows.length);

console.log('retrieval tests passed');
