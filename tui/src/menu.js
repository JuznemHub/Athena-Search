// Arrow-key menu with number jumps, binthere-style: `❯` cursor, hint footer.

import { HOME, ERASE_EOL, ERASE_DOWN, box, center } from './screen.js';

/**
 * Show a vertical menu. `items` = [{ label, hint?, disabled? }].
 * Returns the chosen index, or null when aborted (escape/ctrl-c/q).
 * `header` (pre-centered lines) replaces the plain title; `label` sits on
 * the box's top edge (binthere uses 'actions').
 * `allowTab` enables Tab → 'tab' return, only for main menu (H7 fix).
 */
export async function menu(io, theme, { title = '', items, width, header = null, label = '', allowTab = false }) {
  const stream = await io.keys();
  let cursor = 0;
  let done = false;

  const draw = (msg = '') => {
    io.stderr(HOME + ERASE_EOL + ERASE_DOWN);
    const head = header ?? [center(theme.bold(title), width)];
    for (const l of head) io.stderr(l + '\n');
    const lines = items.map((it, i) => {
      if (it.disabled) return theme.dim(`${' '.repeat(2)}${it.label}`);
      const mark = i === cursor ? theme.accent('❯') : ' ';
      const pad = ' '.repeat(Math.max(0, 28 - it.label.length));
      const hint = it.hint ? theme.dim(pad + it.hint) : '';
      return `${mark} ${i + 1} ${theme.bold(it.label)}${hint}`;
    });
    const maxH = Math.max(1, Math.min(io.rows ? io.rows() - 6 : 24, lines.length));
    const first = Math.max(0, Math.min(cursor - maxH + 1, items.length - maxH));
    const frame = lines.slice(first, first + maxH);
    for (const l of box(frame, theme, { label }).map((l) => center(l, width))) io.stderr(l + '\n');
    const hint = allowTab ? '↑↓ move · ↵ select · 1-9 jump · Tab advanced · q quit' : '↑↓ move · ↵ select · 1-9 jump · q quit';
    for (const l of box([msg === '' ? hint : msg], theme).map((l) => center(l, width))) io.stderr(l + '\n');
  };

  draw();
  try {
    while (!done) {
      const key = await stream.next();
      if (key.name === 'up') { cursor = (cursor - 1 + items.length) % items.length; draw(); }
      else if (key.name === 'down') { cursor = (cursor + 1) % items.length; draw(); }
      else if (key.name === 'enter') { done = true; }
      else if (key.name === 'digit' && key.value >= 1 && key.value <= items.length) {
        cursor = key.value - 1; draw(); done = true;
      }
      else if (key.name === 'tab' && allowTab) { stream.close(); return 'tab'; }
      else if (key.name === 'escape' || key.name === 'ctrl-c' || (key.name === 'char' && key.value === 'q')) {
        stream.close(); return null;
      }
    }
  } finally { stream.close(); }
  return cursor;
}

/** Yes/no confirm. Returns true when confirmed. */
export async function confirm(io, theme, question, width) {
  const stream = await io.keys();
  io.stderr(HOME + ERASE_EOL);
  io.stderr(center(theme.bold(question), width) + '\n');
  io.stderr(box([theme.dim('y yes · n no · q quit')], theme).join('\n') + '\n');
  try {
    for (;;) {
      const key = await stream.next();
      if (key.name === 'enter' || (key.name === 'char' && key.value === 'y')) return true;
      if (key.name === 'char' && key.value === 'n') return false;
      if (key.name === 'escape' || key.name === 'ctrl-c' || (key.name === 'char' && key.value === 'q')) return false;
    }
  } finally { stream.close(); }
}
