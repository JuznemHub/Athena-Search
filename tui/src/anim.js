// Animation: intro materialization, braille spinner, cursor-safe.

import { CLEAR, HIDE_CURSOR, SHOW_CURSOR, ERASE_LINE, titleBlock, LOGO_WIDTH } from './screen.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const reducedMotion = () => process.env.ATHENA_TUI_NO_ANIMATION === '1';

/** Play the wordmark materialization: spark fades in, letters sweep left→right. */
export async function playIntro(io, theme, width) {
  if (!io.stderrIsTTY || reducedMotion()) return;
  io.stderr(HIDE_CURSOR);
  const glowOn = Math.floor(1200 / 60);
  let glow = 0;
  let sweep = -1;
  const timer = setInterval(() => {
    glow += 1;
    sweep = Math.min(LOGO_WIDTH, sweep + 3);
    const block = titleBlock(theme, width, glow >= glowOn);
    const frame = block.map((l, i) => {
      if (i < 1 || i > 3) return l;
      return sweep < 0 ? '' : l.slice(0, sweep);
    });
    io.stderr(CLEAR + frame.join('\n') + '\n');
  }, 60);
  await new Promise((r) => setTimeout(r, 900));
  clearInterval(timer);
  io.stderr(CLEAR + titleBlock(theme, width, true).join('\n') + '\n');
  io.stderr(SHOW_CURSOR);
}

/**
 * Run `fn` while a braille spinner ticks next to `label`. Without a TTY the
 * label prints once as a plain dim line instead.
 */
export async function withSpinner(io, theme, label, fn) {
  if (!io.stderrIsTTY || reducedMotion()) {
    io.stderr(theme.dim(label) + '\n');
    return fn();
  }
  let frame = 0;
  const draw = () => {
    io.stderr(ERASE_LINE + `${theme.accent(SPINNER[frame % SPINNER.length])} ${theme.dim(label)}`);
  };
  draw();
  const timer = setInterval(() => { frame += 1; draw(); }, 80);
  try {
    const out = await fn();
    io.stderr(ERASE_LINE);
    return out;
  } finally {
    clearInterval(timer);
    io.stderr(ERASE_LINE);
  }
}
