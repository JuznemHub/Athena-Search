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

function harness(scope = 'personal') {
  const toasts = [];
  const input = { value: 'https://example.com' };
  const context = vm.createContext({
    window: {}, URL,
    state: {
      scope, activeCommunity: 'community-one', personalLinks: [], communityLinks: [],
      filterTag: '', filterStatus: 'all', filterSort: 'created_desc'
    },
    isGod: () => true,
    isCommunityStaff: () => true,
    corpus() { return scope === 'personal' ? context.state.personalLinks : context.state.communityLinks; },
    showToast: (message, warning) => toasts.push({ message, warning }),
    searchInput: input,
    clearSearchBtn: { classList: { add() {} } },
    setMode() {}, renderHome() {},
    api: async () => ({ res: { ok: false, status: 500 }, data: { success: false, error: 'Database failed' } })
  });
  vm.runInContext(searchSource, context);
  vm.runInContext(`
    ${section('  function parseDumpInput(raw)', '  // ---- Modes / UI ----')}
    ${section('  function filterLinks(links, query)', '  function highlight(text, query)')}
  `, context);
  return { context, toasts, input };
}

test('a failed personal save keeps the input and does not add an unsaved item', async () => {
  const { context, toasts, input } = harness();
  await context.saveDump(input.value);
  assert.equal(context.state.personalLinks.length, 0);
  assert.equal(input.value, 'https://example.com');
  assert.deepEqual(toasts[0], { message: 'Database failed', warning: true });
});

test('a network failure during personal save keeps the input and reports the error', async () => {
  const { context, toasts, input } = harness();
  context.api = async () => { throw new Error('Offline'); };
  await context.saveDump(input.value);
  assert.equal(context.state.personalLinks.length, 0);
  assert.equal(input.value, 'https://example.com');
  assert.deepEqual(toasts[0], { message: 'Offline', warning: true });
});

test('a successful personal save adds the server item and clears the input', async () => {
  const { context, input } = harness();
  context.api = async () => ({ res: { ok: true, status: 200 }, data: { success: true, id: 'saved' } });
  await context.saveDump(input.value);
  assert.equal(context.state.personalLinks[0].id, 'saved');
  assert.equal(input.value, '');
});

for (const scope of ['personal', 'community']) {
  test(`a failed ${scope} deletion keeps the item and input`, async () => {
    const { context, toasts, input } = harness(scope);
    const list = scope === 'personal' ? context.state.personalLinks : context.state.communityLinks;
    list.push({ id: 'one', url: input.value });
    await context.runDelete(input.value);
    assert.equal((scope === 'personal' ? context.state.personalLinks : context.state.communityLinks).length, 1);
    assert.equal(input.value, 'https://example.com');
    assert.deepEqual(toasts[0], { message: 'Database failed', warning: true });
  });

  test(`a successful ${scope} deletion removes the item`, async () => {
    const { context, input } = harness(scope);
    const list = scope === 'personal' ? context.state.personalLinks : context.state.communityLinks;
    list.push({ id: 'one', url: input.value });
    context.api = async () => ({ res: { ok: true }, data: { success: true } });
    await context.runDelete(input.value);
    assert.equal((scope === 'personal' ? context.state.personalLinks : context.state.communityLinks).length, 0);
    assert.equal(input.value, '');
  });
}

test('the tag filter applies before the local search result limit', () => {
  const { context } = harness();
  context.state.filterTag = 'wanted';
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), title: 'matching query', tags: [i === 99 ? 'wanted' : 'other']
  }));
  const matches = context.filterLinks(rows, 'matching query');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, '99');
});

test('the status filter applies before the local search result limit', () => {
  const { context } = harness();
  context.state.filterStatus = 'edited';
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), title: 'matching query', manualEditedAt: i === 99 ? 1 : 0
  }));
  const matches = context.filterLinks(rows, 'matching query');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, '99');
});
