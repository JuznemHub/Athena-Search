// Raw-mode key reader: yields normalized key objects from stdin.

const ESC = '\x1b';
const SEQS = {
  [ESC + '[A']: 'up', [ESC + '[B']: 'down', [ESC + '[C']: 'right', [ESC + '[D']: 'left',
  [ESC + 'OA']: 'up', [ESC + 'OB']: 'down', [ESC + 'OC']: 'right', [ESC + 'OD']: 'left',
  [ESC + '[H']: 'home', [ESC + '[F']: 'end',
};
const ESC_WAIT_MS = 50;

export function keyStream(stdin = process.stdin) {
  return new Promise((resolve) => {
    const queue = [];
    let waiting;
    let pending = '';
    let escTimer = null;
    const push = (key) => {
      if (waiting) { waiting(key); waiting = null; } else queue.push(key);
    };
    const finish = (key) => push(key);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      // Terminals may split escape sequences across chunks (\x1b then [A), so
      // buffer until a sequence resolves instead of treating every \x1b as ESC.
      pending += chunk;
      while (pending.length > 0) {
        const c = pending[0];
        if (c === ESC) {
          if (escTimer) { clearTimeout(escTimer); escTimer = null; }
          if (pending.length >= 3) {
            let matched = false;
            for (const [seq, name] of Object.entries(SEQS)) {
              if (pending.startsWith(seq)) {
                pending = pending.slice(seq.length);
                finish({ name });
                matched = true;
                break;
              }
            }
            if (matched) continue;
            // Incomplete CSI/SS3 (ESC [ or ESC O without a final byte) — wait.
            if (pending.startsWith(ESC + '[') || pending.startsWith(ESC + 'O')) break;
            pending = pending.slice(1);
            finish({ name: 'escape' });
            continue;
          }
          if (pending.length === 2) {
            if (pending[1] === '[' || pending[1] === 'O') break; // could be CSI start
            pending = pending.slice(1); // lone ESC followed by a plain char
            finish({ name: 'escape' });
            continue;
          }
          // Only ESC so far — a real ESC keypress is a lone byte, so delay the
          // verdict briefly to see if a sequence follows in the next chunk.
          escTimer = setTimeout(() => {
            pending = pending.slice(1);
            finish({ name: 'escape' });
          }, ESC_WAIT_MS);
          break;
        }
        if (c === '\x03') { pending = pending.slice(1); finish({ name: 'ctrl-c' }); continue; }
        if (c === '\r' || c === '\n') { pending = pending.slice(1); finish({ name: 'enter' }); continue; }
        if (c === '\x7f' || c === '\x08') { pending = pending.slice(1); finish({ name: 'backspace' }); continue; }
        if (/[0-9]/.test(c)) { pending = pending.slice(1); finish({ name: 'digit', value: Number(c) }); continue; }
        if (/[a-zA-Z]/.test(c)) { pending = pending.slice(1); finish({ name: 'char', value: c.toLowerCase() }); continue; }
        pending = pending.slice(1);
        finish({ name: 'other', value: c });
      }
    });
    const onError = () => finish({ name: 'error' });
    stdin.on('data', onData);
    stdin.on('error', onError);
    resolve({
      next() {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((r) => { waiting = r; });
      },
      close() {
        if (escTimer) clearTimeout(escTimer);
        stdin.removeListener('data', onData);
        stdin.removeListener('error', onError);
        try { stdin.setRawMode(false); } catch { /* already closed */ }
        stdin.pause();
      },
    });
  });
}

/** One keypress or null if the user doesn't press anything in `ms`. */
export async function readTimeout(stream, ms) {
  return Promise.race([
    stream.next(),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
}
