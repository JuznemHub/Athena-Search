import assert from 'node:assert/strict';
import {
  DEFAULT_FMHY_CATEGORIES,
  classifyLink
} from '../worker/wiki-taxonomy.js';

// 1. Verify taxonomy schema
assert(Array.isArray(DEFAULT_FMHY_CATEGORIES), 'Taxonomy must be an array');
assert(DEFAULT_FMHY_CATEGORIES.length >= 10, 'Must have at least 10 categories');
for (const cat of DEFAULT_FMHY_CATEGORIES) {
  assert(typeof cat.id === 'string' && cat.id.length > 0, 'Category must have an id');
  assert(typeof cat.title === 'string' && cat.title.length > 0, 'Category must have a title');
  assert(typeof cat.icon === 'string' && cat.icon.length > 0, 'Category must have an icon');
  assert(Array.isArray(cat.subheadings), 'Category must have subheadings array');
  assert(cat.subheadings.length >= 1, `Category ${cat.id} must have at least one subheading`);
  for (const sub of cat.subheadings) {
    assert(typeof sub.id === 'string', 'Subheading must have an id');
    assert(typeof sub.title === 'string', 'Subheading must have a title');
  }
}

// 2. Verify classifyLink for different domains and tags
const testCases = [
  {
    link: { title: 'Fmovies - Free Stream Movies Online', url: 'https://fmovies.to', tags: ['streaming', 'movie'] },
    expectedCat: 'video'
  },
  {
    link: { title: 'uBlock Origin - Best Adblocker', url: 'https://ublockorigin.com', tags: ['adblock', 'privacy'] },
    expectedCat: 'privacy'
  },
  {
    link: { title: 'Spotify Downloader', url: 'https://spotdl.net', tags: ['music', 'flac'] },
    expectedCat: 'audio'
  },
  {
    link: { title: 'RetroArch Multi-System Emulator', url: 'https://retroarch.com', tags: ['emulator', 'retro'] },
    expectedCat: 'gaming'
  },
  {
    link: { title: 'Z-Library Books Mirror', url: 'https://z-lib.id', tags: ['book', 'epub'] },
    expectedCat: 'reading'
  },
  {
    link: { title: 'DeepSeek WebUI & Ollama Client', url: 'https://ollama.com', tags: ['ai', 'llm'] },
    expectedCat: 'ai'
  },
  {
    link: { title: 'VSCode Neovim Extension', url: 'https://github.com/vscode-neovim', tags: ['coding', 'github', 'tool'] },
    expectedCat: 'development'
  },
  {
    link: { title: '7-Zip File Archiver', url: 'https://7-zip.org', tags: ['software', 'archive'] },
    expectedCat: 'tools'
  },
  {
    link: { title: 'qBittorrent Official Site', url: 'https://qbittorrent.org', tags: ['torrent'] },
    expectedCat: 'downloads'
  },
  {
    link: { title: 'F-Droid Free Software Catalog', url: 'https://f-droid.org', tags: ['android', 'apk'] },
    expectedCat: 'android'
  },
  {
    link: { title: 'Untagged random discovery', url: 'https://example.com', tags: [] },
    expectedCat: 'misc'
  }
];

for (const tc of testCases) {
  const result = classifyLink(tc.link, DEFAULT_FMHY_CATEGORIES);
  assert.equal(result.categoryId, tc.expectedCat, `Expected ${tc.link.title} to be in ${tc.expectedCat}, got ${result.categoryId}`);
  assert(result.subheadingId, 'Must have a subheading');
}

console.log('FMHY wiki taxonomy and classification tests passed.');
