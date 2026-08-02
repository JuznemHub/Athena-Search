// Screen primitives — escape sequences, centering, boxes, and the wordmark.
// Vocabulary follows nxfu/binthere's cli TUI.

const ESC = '\x1b';
export const CLEAR = `${ESC}[2J${ESC}[H`;
export const HOME = `${ESC}[H`;
export const ERASE_EOL = `${ESC}[K`;
export const ERASE_DOWN = `${ESC}[0J`;
export const ERASE_LINE = `\r${ESC}[2K`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
export const moveTo = (row, col) => `${ESC}[${row};${col}H`;

/** Below this many columns the logo/boxes collapse to plain lines. */
export const MIN_WIDTH = 60;

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
export const stripAnsi = (s) => s.replace(ANSI_RE, '');

export function center(line, width) {
  const pad = Math.max(0, Math.floor((width - stripAnsi(line).length) / 2));
  return ' '.repeat(pad) + line;
}

// Three-row half-block wordmark: A T H E N A · S E A R C H
export const LOGO = [
  '█▀█ ▀█▀ █ █ █▀▀ █▄ █ █▀█  ▄▀▀ █▀▀ █▀█ █▀▄ ▄▀▀ █ █',
  '█▄█  █  █▀█ █▀  █ ▀█ █▄█  █▄▄ █▀  █▄█ █▀▄ █   █▀█',
  '▀ ▀  ▀  ▀ ▀ ▀▀▀ ▀  ▀ ▀ ▀  ▀▀▀ ▀▀▀ ▀ ▀ ▀▀  ▀▀▀ ▀ ▀',
];

/** The spark above the wordmark, padded to the logo width. */
export function logoSpark(theme, glow = true) {
  const star = theme.rgb(255, 240, 190)('✦');
  const off = theme.dim('·');
  return center(`${glow ? star : off}${' '.repeat(26)}`, 44);
}

/** Violet gradient wash across the logo, light crown → deep base. */
const GRADIENT_FROM = [214, 170, 255];
const GRADIENT_TO = [96, 60, 200];

export function paintLogo(theme) {
  if (theme.level === 0) return LOGO;
  const rows = LOGO.map((line) => {
    const chars = [...line];
    const len = chars.length;
    return chars.map((ch, i) => {
      if (ch === ' ') return ' ';
      const f = len > 1 ? i / (len - 1) : 0;
      const r = Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * f);
      const g = Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * f);
      const b = Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * f);
      return theme.rgb(r, g, b)(ch);
    }).join('');
  });
  return rows;
}

/** Full-width dim horizontal rule. */
export function rule(width, theme) {
  return theme.dim('─'.repeat(Math.max(0, width)));
}

/**
 * Rounded hairline box, dim border, one space of padding, optional accent
 * label sitting on the top edge.
 */
export function box(lines, theme, { label = '' } = {}) {
  const inner = Math.max(...lines.map((l) => stripAnsi(l).length));
  const side = theme.dim('│');
  const room = inner + 2;
  const labelled = label !== '' && label.length + 4 <= room;
  const top = labelled
    ? theme.dim('╭─ ') + theme.accent(label) + theme.dim(` ${'─'.repeat(room - label.length - 3)}╮`)
    : theme.dim('╭' + '─'.repeat(room) + '╮');
  return [
    top,
    ...lines.map((l) => `${side} ${l}${' '.repeat(inner - stripAnsi(l).length)} ${side}`),
    theme.dim('╰' + '─'.repeat(inner + 2) + '╯'),
  ];
}

/** Render the whole title block centered for a given width. */
export function titleBlock(theme, width, glow = true) {
  const pad = Math.floor(Math.max(0, width - 44) / 2);
  const padLine = (l) => ' '.repeat(pad) + l;
  return [
    padLine(logoSpark(theme, glow)),
    ...paintLogo(theme).map(padLine),
    '',
  ];
}
