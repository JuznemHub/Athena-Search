import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('  function initGlassBlur() {');
const end = source.indexOf('\n  // ---- Accent color system ----', start);
assert.ok(start >= 0 && end > start, 'Glass blur initializer exists');
const initializer = source.slice(start, end);

function setup(saved) {
  const storage = new Map(saved === undefined ? [] : [['athena_glass_blur', saved]]);
  const properties = new Map();
  const attributes = new Map();
  const handlers = new Map();
  const input = {
    value: '',
    setAttribute: (key, value) => attributes.set(key, value),
    addEventListener: (event, handler) => handlers.set(event, handler),
  };
  const output = { textContent: '' };
  const context = {
    $: id => id === 'glassBlurInput' ? input : id === 'glassBlurValue' ? output : null,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } },
  };
  vm.runInNewContext(`${initializer}\ninitGlassBlur();`, context);
  return { input, output, properties, attributes, storage, handlers };
}

for (const [saved, expected] of [[undefined, 24], ['35', 35], ['80', 40], ['-5', 0], ['bad', 24]]) {
  const { input, output, properties, attributes } = setup(saved);
  assert.equal(input.value, String(expected));
  assert.equal(output.textContent, `${expected} px`);
  assert.equal(properties.get('--glass-blur'), `${expected}px`);
  assert.equal(attributes.get('aria-valuetext'), `${expected} pixels`);
}
const ui = setup();
ui.input.value = '12';
ui.handlers.get('input')();
assert.equal(ui.output.textContent, '12 px');
assert.equal(ui.properties.get('--glass-blur'), '12px');
assert.equal(ui.storage.get('athena_glass_blur'), '12');
assert.equal(setup(ui.storage.get('athena_glass_blur')).input.value, '12');
console.log('Glass blur settings passed');
