import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const mainSource = fs.readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing frontend section: ${start}`);
  return mainSource.slice(from, to);
}

function element(...initialClasses) {
  const classes = new Set(initialClasses);
  return {
    style: {}, textContent: '',
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        const present = force === undefined ? !classes.has(name) : force;
        if (present) classes.add(name);
        else classes.delete(name);
        return present;
      }
    },
    querySelector: () => null
  };
}

function harness() {
  const elements = {
    adminDbView: element('hidden'), searchWrapper: element(), resultsContainer: element(),
    wikiView: element('hidden'), wikiSidebar: element(), wikiSidebarBackdrop: element('hidden'),
    feedView: element('hidden'), aside_feed: element(), freshrssSidebarBackdrop: element('hidden'),
    modeBadgeText: element()
  };
  const scopeSwitch = element();
  const body = element();
  const location = { hash: '', pathname: '/', search: '' };
  const history = { pushState(_state, _title, url) { location.hash = url.startsWith('#') ? url : ''; } };
  const context = vm.createContext({
    $: id => elements[id] || null,
    document: { body, title: 'Athena', querySelector: selector => selector === '.scope-switch-container' ? scopeSwitch : null },
    window: { location, history }, history,
    modeBadgeText: elements.modeBadgeText,
    state: { mode: 'search', scope: 'community', activeCommunity: 'community-one', communities: [] },
    adminDbState: { scope: 'community', communityId: '' },
    wikiState: { categories: ['loaded'], dirty: false },
    feedState: { communityId: 'personal', viewMode: 'normal', compactDensity: false },
    isGod: () => true, isStaffRank: () => true,
    loadAdminDbLinks() {}, loadWikiData() {}, renderAdminDbLockedView() {},
    syncFeedScopeUI() {}, setFeedViewMode() {}, loadFeedSources() {}, loadFeedArticles() {}
  });
  vm.runInContext(`
    ${section('  function openAdminDb()', '  async function loadAdminDbLinks()')}
    ${section('  function openWiki()', '  async function loadWikiData()')}
    ${section('  function openFeed()', '  function setFeedViewMode(')}
  `, context);
  return { context, elements, scopeSwitch, body, location };
}

function hidden(el) { return el.classList.contains('hidden'); }

test('Wiki to Database to Search restores the search results and closes the Wiki sidebar', () => {
  const h = harness();
  h.context.openWiki();
  assert.equal(hidden(h.elements.wikiView), false);
  assert.equal(hidden(h.elements.searchWrapper), true);
  assert.equal(hidden(h.scopeSwitch), true);
  assert.equal(h.elements.modeBadgeText.textContent, 'Wiki');
  assert.equal(h.body.classList.contains('wiki-active'), true);
  h.elements.wikiSidebar.classList.add('mobile-open');
  h.elements.wikiSidebarBackdrop.classList.remove('hidden');
  h.body.style.overflow = 'hidden';
  h.context.openAdminDb();
  assert.equal(hidden(h.elements.wikiView), true);
  assert.equal(hidden(h.elements.adminDbView), false);
  assert.equal(h.body.classList.contains('wiki-active'), false);
  assert.equal(h.elements.wikiSidebar.classList.contains('mobile-open'), false);
  assert.equal(hidden(h.elements.wikiSidebarBackdrop), true);
  assert.equal(h.body.style.overflow, '');
  assert.equal(h.elements.modeBadgeText.textContent, 'Database');
  h.context.closeAdminDb();
  assert.equal(hidden(h.elements.adminDbView), true);
  assert.equal(hidden(h.elements.searchWrapper), false);
  assert.equal(hidden(h.elements.resultsContainer), false);
  assert.equal(hidden(h.scopeSwitch), false);
  assert.equal(h.elements.modeBadgeText.textContent, 'Search');
  assert.equal(h.location.hash, '');
});

test('Database to Wiki to Search restores the active mode and controls', () => {
  const h = harness();
  h.context.state.mode = 'dump';
  h.context.openAdminDb();
  h.context.openWiki();
  assert.equal(hidden(h.elements.adminDbView), true);
  assert.equal(hidden(h.elements.wikiView), false);
  assert.equal(hidden(h.scopeSwitch), true);
  assert.equal(h.elements.modeBadgeText.textContent, 'Wiki');
  h.context.closeWiki();
  assert.equal(hidden(h.elements.wikiView), true);
  assert.equal(hidden(h.elements.searchWrapper), false);
  assert.equal(hidden(h.elements.resultsContainer), false);
  assert.equal(hidden(h.scopeSwitch), false);
  assert.equal(h.body.classList.contains('wiki-active'), false);
  assert.equal(h.elements.modeBadgeText.textContent, 'Dump');
  assert.equal(h.location.hash, '');
});

test('Feed to Wiki and Database cleans up Feed active classes and mobile sidebar', () => {
  const h = harness();
  h.context.openFeed();
  assert.equal(hidden(h.elements.feedView), false);
  assert.equal(h.body.classList.contains('feed-active'), true);
  assert.equal(h.elements.modeBadgeText.textContent, 'Feed');
  h.elements.aside_feed.classList.add('mobile-open');
  h.elements.freshrssSidebarBackdrop.classList.remove('hidden');
  h.body.style.overflow = 'hidden';

  h.context.openWiki();
  assert.equal(hidden(h.elements.feedView), true);
  assert.equal(h.body.classList.contains('feed-active'), false);
  assert.equal(h.elements.aside_feed.classList.contains('mobile-open'), false);
  assert.equal(hidden(h.elements.freshrssSidebarBackdrop), true);
  assert.equal(h.body.style.overflow, '');

  h.context.openFeed();
  h.context.closeFeed();
  assert.equal(hidden(h.elements.feedView), true);
  assert.equal(hidden(h.elements.searchWrapper), false);
  assert.equal(hidden(h.elements.resultsContainer), false);
  assert.equal(hidden(h.scopeSwitch), false);
  assert.equal(h.body.classList.contains('feed-active'), false);
});
