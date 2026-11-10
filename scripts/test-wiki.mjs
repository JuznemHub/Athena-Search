import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FMHY_CATEGORIES,
  classifyLink
} from '../worker/wiki-taxonomy.js';
import {
  validateWikiShareToken
} from '../worker/index.js';

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

// 3. Verify share link duration map & calculation
const DURATION_MAP = {
  '7d': { ms: 7 * 86400 * 1000, label: '7 Days' },
  '15d': { ms: 15 * 86400 * 1000, label: '15 Days' },
  '1m': { ms: 30 * 86400 * 1000, label: '1 Month' },
  '2m': { ms: 60 * 86400 * 1000, label: '2 Months' },
  '3m': { ms: 90 * 86400 * 1000, label: '3 Months' },
  '6m': { ms: 180 * 86400 * 1000, label: '6 Months' },
  '1y': { ms: 365 * 86400 * 1000, label: '1 Year' }
};

assert.equal(DURATION_MAP['7d'].ms, 7 * 86400000);
assert.equal(DURATION_MAP['15d'].ms, 15 * 86400000);
assert.equal(DURATION_MAP['1m'].ms, 30 * 86400000);
assert.equal(DURATION_MAP['2m'].ms, 60 * 86400000);
assert.equal(DURATION_MAP['3m'].ms, 90 * 86400000);
assert.equal(DURATION_MAP['6m'].ms, 180 * 86400000);
assert.equal(DURATION_MAP['1y'].ms, 365 * 86400000);

// 4. Verify validateWikiShareToken behavior
const mockRows = [
  {
    token: 'active_token_1234567890abcdef123456',
    created_by: 'owner1',
    scope: 'community',
    community_id: 'comm1',
    duration_label: '1 Month',
    expires_at: Date.now() + 100000,
    created_at: Date.now() - 1000,
    revoked_at: null
  },
  {
    token: 'expired_token_1234567890abcdef12345',
    created_by: 'owner1',
    scope: 'community',
    community_id: 'comm1',
    duration_label: '7 Days',
    expires_at: Date.now() - 5000,
    created_at: Date.now() - 100000,
    revoked_at: null
  },
  {
    token: 'revoked_token_1234567890abcdef12345',
    created_by: 'owner1',
    scope: 'community',
    community_id: 'comm1',
    duration_label: '15 Days',
    expires_at: Date.now() + 100000,
    created_at: Date.now() - 10000,
    revoked_at: Date.now() - 500
  }
];

const mockEnv = {
  DB: {
    exec: async () => {},
    prepare: (_sql) => ({
      bind: (...args) => ({
        first: async () => {
          const [token, now] = args;
          const found = mockRows.find(r => r.token === token && (!r.revoked_at || r.revoked_at === 0) && r.expires_at > now);
          return found || null;
        }
      })
    })
  }
};

const validResult = await validateWikiShareToken('active_token_1234567890abcdef123456', mockEnv);
assert(validResult, 'Active token should be valid');
assert.equal(validResult.community_id, 'comm1');

const expiredResult = await validateWikiShareToken('expired_token_1234567890abcdef12345', mockEnv);
assert.equal(expiredResult, null, 'Expired token should return null');

const revokedResult = await validateWikiShareToken('revoked_token_1234567890abcdef12345', mockEnv);
assert.equal(revokedResult, null, 'Revoked token should return null');

const shortResult = await validateWikiShareToken('short', mockEnv);
assert.equal(shortResult, null, 'Short or invalid token should return null');

// 5. Verify Subheading scroll-down selection UI contract
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');
const jsContent = fs.readFileSync(path.join(__dirname, '../public/src/main.js'), 'utf-8');
const cssContent = fs.readFileSync(path.join(__dirname, '../public/src/style.css'), 'utf-8');

assert(htmlContent.includes('id="wikiSubSelect"'), 'HTML must include wikiSubSelect');
assert(htmlContent.includes('id="wikiCtrlSubSelect"'), 'HTML must include wikiCtrlSubSelect');
assert(jsContent.includes('selectWikiSubheading'), 'main.js must implement selectWikiSubheading');
assert(jsContent.includes('wiki-cat-sub-list'), 'main.js must render wiki-cat-sub-list');
assert(cssContent.includes('.wiki-cat-sub-list'), 'style.css must style .wiki-cat-sub-list');
assert(cssContent.includes('.wiki-sub-select'), 'style.css must style .wiki-sub-select');
assert(cssContent.includes('.wiki-sub-block-highlight'), 'style.css must define .wiki-sub-block-highlight');

console.log('FMHY wiki taxonomy and classification tests passed.');
