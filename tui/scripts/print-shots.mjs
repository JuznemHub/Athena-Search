import { menu } from '../src/menu.js';
import { makeTheme } from '../src/theme.js';
import { titleBlock, logoBlock, center } from '../src/screen.js';

process.env.NO_COLOR = '1';
const theme = makeTheme();
const WIDTH = 88;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s) => s.replace(ANSI_RE, '');
const print = (label, lines) => console.log(`=== ${label} ===\n` + lines.join('\n').replace(/[ \t]+$/gm, ''));

let out = '';
const io = {
  stderr: (s) => (out += s),
  columns: () => WIDTH,
  rows: () => 24,
  keys: async () => ({ [Symbol.asyncIterator]() { return this; }, next: async () => ({ name: 'enter' }), close: async () => {} }),
};
const head = [
  ...logoBlock(theme, WIDTH),
  center(theme.dim('search your second brain · dump your bookmarks · ai answers'), WIDTH),
  center(theme.dim('server  not connected'), WIDTH),
  '',
];
const items = [
  { label: 'Login with Telegram', hint: 'not logged in' },
  { label: 'Connect instance', hint: 'not connected' },
  { label: 'Join community', hint: 'not joined' },
  { label: 'Scan bookmarks', hint: 'not scanned' },
  { label: 'Dump bookmarks', hint: '' },
  { label: 'Status', hint: '' },
  { label: 'Quit', hint: '' },
];
await menu(io, theme, { title: 'ATHENA SEARCH', items, width: WIDTH, header: head, label: 'actions' });
print('MENU', clean(out).trimEnd().split('\n'));
print('WORDMARK', clean(titleBlock(theme, WIDTH, true).join('\n')).split('\n'));
