// Raw-mode key reader: yields normalized key objects from stdin.

const ESC = '\x1b';

export function keyStream(stdin = process.stdin) {
  return new Promise((resolve) => {
    const queue = [];
    let waiting;
    const push = (key) => {
      if (waiting) { waiting(key); waiting = null; } else queue.push(key);
    };
    const finish = (key) => push(key);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      let i = 0;
      const seq = chunk;
      while (i < seq.length) {
        const c = seq[i];
        if (c === ESC) {
          const next = seq.slice(i);
          if (next.startsWith(ESC + '[A')) { finish({ name: 'up' }); i += 3; continue; }
          if (next.startsWith(ESC + '[B')) { finish({ name: 'down' }); i += 3; continue; }
          if (next.startsWith(ESC + '[C')) { finish({ name: 'right' }); i += 3; continue; }
          if (next.startsWith(ESC + '[D')) { finish({ name: 'left' }); i += 3; continue; }
          finish({ name: 'escape' }); i += 1; continue;
        }
        if (c === '\x03') { finish({ name: 'ctrl-c' }); i += 1; continue; }
        if (c === '\r' || c === '\n') { finish({ name: 'enter' }); i += 1; continue; }
        if (c === '\x7f' || c === '\x08') { finish({ name: 'backspace' }); i += 1; continue; }
        if (/[0-9]/.test(c)) { finish({ name: 'digit', value: Number(c) }); i += 1; continue; }
        if (/[a-zA-Z]/.test(c)) { finish({ name: 'char', value: c.toLowerCase() }); i += 1; continue; }
        finish({ name: 'other', value: c }); i += 1;
      }
    });
    stdin.on('error', () => finish({ name: 'error' }));
    resolve({
      next() {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((r) => { waiting = r; });
      },
      close() {
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
