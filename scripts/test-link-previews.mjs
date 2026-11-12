import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(`  function ${start}(`);
  const to = source.search(new RegExp(`^  (?:async )?function ${end}\\(`, 'm'));
  assert.ok(from >= 0 && to > from, `Missing frontend section: ${start}`);
  return source.slice(from, to);
}

function renderFixture(link) {
  const cards = [];
  const preview = {
    complete: false,
    naturalWidth: 0,
    removed: false,
    addEventListener(event, callback) {
      if (event === 'error') this.fail = callback;
    },
    remove() { this.removed = true; },
  };
  const list = {
    innerHTML: '',
    appendChild(card) { cards.push(card); },
    querySelectorAll(selector) {
      return selector === '.link-preview' ? [preview] : [];
    },
  };
  const element = () => ({ classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    $: id => id === 'wikiBlocks' ? list : null,
    wikiState: { categories: [], links: [link], activeCategory: 'all' },
    state: { scope: 'personal' },
    document: { createElement: element },
    URL,
    compactHero() {},
    resultsList: list,
    emptyState: element(),
    resultsMeta: element(),
    highlight: text => text,
    providerLabel: () => '',
    formatDateTime: () => 'Today',
  });
  vm.runInContext(`
    ${section('escapeHtml', 'normalizeLink')}
    ${section('renderGoogleResults', 'runSearch')}
    ${section('renderWikiContent', 'setupWikiShareModal')}
  `, context);
  return { context, cards, list, preview };
}

const appIconUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/app-icon.png/434x0w.webp';

test('Wiki renders direct image links without relying on stored metadata', () => {
  const { context, list } = renderFixture({ id: '1', url: appIconUrl, title: 'Notes for Pencil' });
  context.renderWikiContent();
  assert.match(list.innerHTML, /<img\b[^>]*class="link-preview"/);
  assert.ok(list.innerHTML.includes(`src="${appIconUrl}"`));
  assert.ok(list.innerHTML.includes(`href="${appIconUrl}"`));
  assert.match(list.innerHTML, /referrerpolicy="no-referrer"/);
  assert.match(list.innerHTML, /loading="lazy"/);
});

test('search gives saved page artwork a preview and keeps its destination', () => {
  const link = { id: '2', url: 'https://example.org/app', title: 'A saved app', imageUrl: 'https://cdn.example.org/art?id=1&size=2' };
  const { context, cards } = renderFixture(link);
  context.renderGoogleResults([link], 'app');
  assert.match(cards[0].innerHTML, /class="link-preview"[^>]*src="https:\/\/cdn\.example\.org\/art\?id=1&amp;size=2"/);
  assert.ok(cards[0].innerHTML.includes(`href="${link.url}"`));
  assert.doesNotMatch(cards[0].innerHTML, /class="g-favicon-img"/);
});

test('Wiki retains the destination when its preview fails and ignores unsupported preview schemes', () => {
  const url = 'https://example.org/guide';
  const { context, list, preview } = renderFixture({ id: '3', url, image_url: 'https://example.org/missing.png' });
  context.renderWikiContent();
  assert.ok(list.innerHTML.includes('src="https://example.org/missing.png"'));
  preview.fail();
  assert.equal(preview.removed, true);
  assert.ok(list.innerHTML.includes(`href="${url}"`));
  context.wikiState.links[0].image_url = 'javascript:alert(1)';
  context.renderWikiContent();
  assert.doesNotMatch(list.innerHTML, /<img\b/);
});
