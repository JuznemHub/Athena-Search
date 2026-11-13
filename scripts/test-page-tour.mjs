import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('  function setupPageTour()');
const end = source.indexOf('  // ---- Events ----', start);
assert.ok(start >= 0 && end > start, 'Missing page tour setup');

function tour({ owner = false, publicWiki = false, community = 'group' } = {}) {
  const elements = new Map();
  const modes = [];
  let focused;

  function get(id) {
    if (!elements.has(id)) {
      const el = new EventTarget();
      el.focus = () => { focused = id; };
      el.click = () => el.dispatchEvent(new Event('click'));
      el.classList = { remove() {} };
      elements.set(id, el);
    }
    return elements.get(id);
  }

  const dialog = get('athenaTour');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => {
    dialog.open = false;
    dialog.dispatchEvent(new Event('close'));
  };

  vm.runInNewContext(`${source.slice(start, end)}\nsetupPageTour();`, {
    $: get,
    state: { scope: owner ? 'personal' : 'community', activeCommunity: community, publicWikiMode: publicWiki },
    isGod: () => owner,
    setMode: mode => modes.push(mode),
    searchInput: get('searchInput'),
    openWiki() {}
  });

  return { get, dialog, modes, focused: () => focused };
}

test('search tour opens on Search, supports back, and resets on replay', () => {
  const { get, dialog, focused } = tour();
  get('searchTourBtn').click();
  assert.equal(dialog.open, true);
  assert.equal(get('athenaTourProgress').textContent, 'Search tour · Step 1 of 5');
  assert.equal(get('athenaTourBack').disabled, true);
  assert.equal(focused(), 'athenaTourTitle');
  get('athenaTourNext').click();
  assert.equal(get('athenaTourProgress').textContent, 'Search tour · Step 2 of 5');
  get('athenaTourBack').click();
  assert.equal(get('athenaTourBack').disabled, true);
  get('athenaTourClose').click();
  assert.equal(dialog.open, false);
  assert.equal(focused(), 'searchTourBtn');
  get('searchTourBtn').click();
  assert.equal(get('athenaTourProgress').textContent, 'Search tour · Step 1 of 5');
});

test('community members without a selected community get setup guidance before saving', () => {
  const { get } = tour({ community: '' });
  get('searchTourBtn').click();
  get('athenaTourNext').click();
  get('athenaTourNext').click();
  assert.match(get('athenaTourDescription').textContent, /join .*community before saving/i);
  assert.equal(get('athenaTourAction').hidden, true);
});

test('trying Dump closes the tour and moves focus into the app', () => {
  const { get, dialog, modes, focused } = tour({ owner: true });
  get('searchTourBtn').click();
  get('athenaTourNext').click();
  get('athenaTourNext').click();
  get('athenaTourAction').click();
  assert.equal(dialog.open, false);
  assert.deepEqual(modes, ['dump']);
  assert.equal(focused(), 'searchInput');
});

test('public Wiki visitors get read-only help instead of owner actions', () => {
  const { get, dialog, focused } = tour({ owner: true, publicWiki: true });
  get('wikiTourBtn').click();
  get('athenaTourNext').click();
  get('athenaTourNext').click();
  assert.match(get('athenaTourDescription').textContent, /read-only/);
  assert.equal(get('athenaTourAction').hidden, true);
  assert.equal(get('athenaTourNext').textContent, 'Done');
  get('athenaTourNext').click();
  assert.equal(dialog.open, false);
  assert.equal(focused(), 'wikiTourBtn');
});

test('Feed and Database pages expose replayable page tours', () => {
  const { get, dialog, focused } = tour({ owner: true });
  get('feedTourBtn').click();
  assert.equal(dialog.open, true);
  assert.equal(get('athenaTourProgress').textContent, 'Feed tour · Step 1 of 3');
  assert.match(get('athenaTourDescription').textContent, /Personal Feeds/);
  get('athenaTourClose').click();
  assert.equal(dialog.open, false);
  assert.equal(focused(), 'feedTourBtn');

  get('adminDbTourBtn').click();
  assert.equal(dialog.open, true);
  assert.equal(get('athenaTourProgress').textContent, 'Database tour · Step 1 of 3');
  get('athenaTourClose').click();
  assert.equal(dialog.open, false);
  assert.equal(focused(), 'adminDbTourBtn');
});
