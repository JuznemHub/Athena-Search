import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  const THEME_ORDER'), source.indexOf('  // ---- Dice animation ----'));

function harness(initial = {}) {
  const storage = new Map(Object.entries(initial));
  const styles = new Map();
  const chips = ['dark', 'light', 'material', 'glass'].map(theme => ({
    dataset: { theme }, attributes: {}, active: false,
    classList: { toggle(_name, active) { this.owner.active = active; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(_name, fn) { this.click = fn; }
  }));
  chips.forEach(chip => { chip.classList.owner = chip; });
  const root = {
    dataset: {}, style: { setProperty: (name, value) => styles.set(name, value) },
    setAttribute(name, value) { if (name === 'data-theme') this.dataset.theme = value; }
  };
  const meta = {};
  const context = vm.createContext({
    document: {
      documentElement: root,
      querySelector: () => meta,
      querySelectorAll: selector => selector === '.theme-chip' ? chips : []
    },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    $: () => null
  });
  vm.runInContext(section, context);
  return { context, root, styles, storage, chips, meta };
}

test('temporary Minimal preference migrates to Dark with synchronized controls', () => {
  const h = harness({ athena_theme: 'minimal' });
  h.context.initThemeUI();
  assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.storage.get('athena_theme'), 'dark');
  assert.equal(h.meta.content, '#0a0a0a');
  assert.deepEqual(h.chips.map(chip => chip.attributes['aria-pressed']), ['true', 'false', 'false', 'false']);
  assert.equal(h.styles.get('--accent'), '#0072f5');
});

test('switching themes preserves a chosen accent and uses readable button text', () => {
  const h = harness({ athena_accent_color: '#00ff00' });
  h.context.initThemeUI();
  h.chips[2].click();
  assert.equal(h.root.dataset.theme, 'material');
  assert.equal(h.styles.get('--accent'), '#00ff00');
  assert.equal(h.styles.get('--accent-fg'), '#000000');
  assert.equal(h.storage.get('athena_accent_color'), '#00ff00');
  h.context.applyAccentColor('#0000ff');
  assert.equal(h.styles.get('--accent-fg'), '#ffffff');
});

test('default accent follows the selected theme and invalid saved values are ignored', () => {
  const h = harness({ athena_accent_color: '#bad-value' });
  h.context.initThemeUI();
  assert.equal(h.styles.get('--accent'), '#0072f5');
  h.chips[1].click();
  assert.equal(h.styles.get('--accent'), '#8e70f6');
});
