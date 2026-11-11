import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const mainSource = fs.readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8');
const searchSource = fs.readFileSync(new URL('../public/src/lib/search.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing frontend section: ${start}`);
  return mainSource.slice(from, to);
}

function selectElement() {
  return {
    options: [],
    value: '',
    set innerHTML(html) {
      this.options = [];
      this.value = '';
      if (html.includes('<option')) this.options.push({ value: '' });
    },
    appendChild(option) {
      this.options.push(option);
      if (this.options.length === 1 || option.selected) this.value = option.value;
    }
  };
}

function harness({ activeCommunity = '', scope = 'community', communities = [], localRows = [] } = {}) {
  const storage = new Map(activeCommunity ? [['athena_active_community', activeCommunity]] : []);
  const mainSelect = selectElement();
  const sidebarSelect = selectElement();
  const timers = new Map();
  const requests = [];
  const toasts = [];
  const view = { rows: [], skeleton: false, home: false };
  const resultsList = {
    get children() { return view.rows; },
    querySelector() { return view.skeleton ? {} : null; },
    set innerHTML(html) { view.skeleton = html.includes('g-result-skeleton'); }
  };
  const context = vm.createContext({
    window: {},
    URLSearchParams,
    state: { activeCommunity, scope, communities, filterTag: 'backfill', filterSort: 'created_desc', filterStatus: 'all' },
    localStorage: {
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: { createElement: () => ({}) },
    $: id => id === 'mainCommunitySelect' ? mainSelect : null,
    communitySelect: sidebarSelect,
    renderCommunityDetails() {},
    updateDeleteModeVisibility() {},
    searchInput: { value: '' },
    aiAnswerCard: { classList: { add() {} } },
    emptyState: { classList: { add() {} } },
    resultsMeta: { classList: { add() {} } },
    emptyStateText: { textContent: '' },
    resultsList,
    corpus: () => localRows,
    filterLinks: rows => rows,
    normalizeLink: row => row,
    renderGoogleResults(rows) {
      view.rows = rows;
      view.skeleton = false;
      view.home = false;
    },
    renderHome() {
      view.rows = [];
      view.skeleton = false;
      view.home = true;
    },
    showToast: (message, warning) => toasts.push({ message, warning }),
    setTimeout(fn) {
      const id = {};
      timers.set(id, fn);
      return id;
    },
    clearTimeout: id => timers.delete(id),
    api: async url => {
      requests.push(url);
      if (url === '/api/communities') return { data: { communities } };
      return { res: { ok: true, status: 200 }, data: { success: true, links: [{ id: 'server-result' }], total: 1 } };
    }
  });
  vm.runInContext(searchSource, context);
  vm.runInContext(`
    let searchSeq = 0;
    let enrichmentRefreshKey = '';
    ${section('  async function loadCommunities()', '  async function loadCommunityBots()')}
    ${section('  async function runSearch()', '  async function loadMainTags()')}
  `, context);
  return {
    context, storage, mainSelect, sidebarSelect, requests, toasts, view, timers,
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(fn => fn());
    }
  };
}

test('startup selects the displayed community and tag search returns results', async () => {
  const h = harness({ communities: [{ id: 'community-one', name: 'First' }] });
  await h.context.loadCommunities();
  assert.equal(h.context.state.activeCommunity, 'community-one');
  assert.equal(h.mainSelect.value, 'community-one');
  assert.equal(h.sidebarSelect.value, 'community-one');
  assert.equal(h.storage.get('athena_active_community'), 'community-one');
  await h.context.runSearch();
  assert.equal(h.requests[1], '/api/links/search?scope=community&tag=backfill&sort=created_desc&community_id=community-one');
  h.flushTimers();
  assert.equal(h.view.rows[0].id, 'server-result');
  assert.equal(h.view.skeleton, false);
});

test('startup preserves a valid saved community', async () => {
  const h = harness({
    activeCommunity: 'community-two',
    communities: [{ id: 'community-one', name: 'First' }, { id: 'community-two', name: 'Second' }]
  });
  await h.context.loadCommunities();
  assert.equal(h.context.state.activeCommunity, 'community-two');
  assert.equal(h.mainSelect.value, 'community-two');
  assert.equal(h.sidebarSelect.value, 'community-two');
});

test('a removed saved community is replaced in both selectors', async () => {
  const h = harness({ activeCommunity: 'removed', communities: [{ id: 'community-one', name: 'First' }] });
  await h.context.loadCommunities();
  assert.equal(h.context.state.activeCommunity, 'community-one');
  assert.equal(h.mainSelect.value, 'community-one');
  assert.equal(h.sidebarSelect.value, 'community-one');
  assert.equal(h.storage.get('athena_active_community'), 'community-one');
});

test('personal scope does not automatically select a community', async () => {
  const h = harness({ scope: 'personal', communities: [{ id: 'community-one', name: 'First' }] });
  await h.context.loadCommunities();
  assert.equal(h.context.state.activeCommunity, '');
  assert.equal(h.storage.has('athena_active_community'), false);
});

test('search without a community shows guidance instead of endless skeletons', async () => {
  const h = harness();
  await h.context.runSearch();
  h.flushTimers();
  assert.equal(h.requests.length, 0);
  assert.equal(h.view.skeleton, false);
  assert.match(h.context.emptyStateText.textContent, /select a community/i);
});

test('clearing a filter invalidates an outstanding search and its loading timer', async () => {
  const h = harness({ activeCommunity: 'community-one' });
  let resolve;
  h.context.api = () => new Promise(done => { resolve = done; });
  const pending = h.context.runSearch();
  h.context.state.filterTag = '';
  await h.context.runSearch();
  h.flushTimers();
  assert.equal(h.view.home, true);
  assert.equal(h.view.skeleton, false);
  resolve({ res: { ok: true }, data: { success: true, links: [{ id: 'old-result' }] } });
  await pending;
  assert.equal(h.view.home, true);
  assert.equal(h.view.rows.length, 0);
});

test('an old failed search cannot replace newer results or show a stale warning', async () => {
  const h = harness({ activeCommunity: 'community-one' });
  let reject;
  h.context.api = () => new Promise((_, fail) => { reject = fail; });
  const pending = h.context.runSearch();
  h.context.state.filterTag = 'website';
  h.context.api = async () => ({ res: { ok: true }, data: { success: true, links: [{ id: 'new-result' }] } });
  await h.context.runSearch();
  reject(new Error('Offline'));
  await pending;
  assert.equal(h.view.rows[0].id, 'new-result');
  assert.equal(h.toasts.length, 0);
});

test('network failures warn while preserving available local results', async () => {
  const h = harness({ activeCommunity: 'community-one', localRows: [{ id: 'local-result' }] });
  h.context.api = async () => { throw new Error('Offline'); };
  await h.context.runSearch();
  assert.equal(h.view.rows[0].id, 'local-result');
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /connection|try again/i);
});

test('a denied search clears loading and explains how to regain access', async () => {
  const h = harness({ activeCommunity: 'community-one' });
  let resolve;
  h.context.api = () => new Promise(done => { resolve = done; });
  const pending = h.context.runSearch();
  h.flushTimers();
  assert.equal(h.view.skeleton, true);
  resolve({ res: { ok: false, status: 403 }, data: { success: false, error: 'Forbidden' } });
  await pending;
  assert.equal(h.view.skeleton, false);
  assert.match(h.context.emptyStateText.textContent, /community.*access|join.*community/i);
  assert.equal(h.toasts.length, 1);
});
