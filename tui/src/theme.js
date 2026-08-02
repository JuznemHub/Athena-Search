// Athena theme — violet on dark, with graceful degradation for dumb terminals.

const ESC = '\x1b';
export const NONE = `${ESC}[0m`;

const SUPPORT = (() => {
  if (process.env.NO_COLOR !== undefined) return 0;
  if (process.env.TERM === 'dumb' || !process.stdout.isTTY) return 0;
  if (process.env.FORCE_COLOR !== undefined) return 3;
  const t = (process.env.TERM || '');
  return /(^|-)truecolor$/.test(t) || /256color/.test(t) || t.startsWith('xterm') ? 3 : 1;
})();

const wrap = (code) => (s) => `${ESC}[${code}m${s}${NONE}`;

export function makeTheme() {
  if (SUPPORT === 0) {
    return { accent: (s) => s, bold: (s) => s, dim: (s) => s, danger: (s) => s, ok: (s) => s, rgb: () => null, level: 0 };
  }
  const accent = wrap(SUPPORT >= 3 ? '38;2;178;132;255' : '38;5;141');
  const bold = wrap('1');
  const dim = wrap('2');
  const danger = wrap(SUPPORT >= 3 ? '38;2;255;110;130' : '38;5;204');
  const ok = wrap(SUPPORT >= 3 ? '38;2;110;220;170' : '38;5;114');
  const rgb = (r, g, b) => (SUPPORT >= 3 ? wrap(`38;2;${r};${g};${b}`) : accent);
  return { accent, bold, dim, danger, ok, rgb, level: SUPPORT };
}
