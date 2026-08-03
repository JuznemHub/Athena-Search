// Session/config persistence at ~/.config/athena-tui/config.json.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = () => path.join(os.homedir(), '.config', 'athena-tui');
const file = () => path.join(dir(), 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file(), 0o600); } catch (_) {}
  return cfg;
}

export function clearConfig() {
  try { fs.rmSync(file(), { force: true }); } catch { /* nothing */ }
}
