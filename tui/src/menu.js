// Arrow-key menu with number jumps, binthere-style: `❯` cursor, hint footer.

import { HOME, ERASE_EOL, ERASE_DOWN, box, center } from './screen.js';

/**
 * Show a vertical menu. `items` = [{ label, hint?, disabled? }].
 * Returns the chosen index, or null when aborted (escape/ctrl-c/q).
 */
export async function menu(io, theme, { title = '', items, width }) {
  const stream = await io.keys();
  let cursor = 0;
  let done = false;

  const draw = (msg = '') => {
    io.stderr(HOME + ERASE_EOL + ERASE_DOWN);
    if (title) io.stderr(center(theme.bold(title), width) + '\n');
    const lines = items.map((it, i) => {
      if (it.disabled) return theme.dim(`${' '.repeat(2)}${it.label}`);
      const mark = i === cursor ? theme.accent('❯') : ' ';
      const pad = ' '.repeat(Math.max(0, 28 - it.label.length));
      const hint = it.hint ? theme.dim(pad + it.hint) : '';
      return `${mark} ${i + 1} ${theme.bold(it.label)}${hint}`;
    });
    const maxH = Math.max(1, Math.min(io.rows ? io.rows() - 6 : 24, lines.length));
    const first = Math.max(0, Math.min(cursor - maxH + 1, items.length - maxH));
    for (const l of lines.slice(first, first + maxH)) io.stderr(l + '\n');
    io.stderr(box([msg === '' ? '↑↓ move · ↵ select · 1-9 jump · q quit' : msg], theme).join('\n') + '\n');
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
