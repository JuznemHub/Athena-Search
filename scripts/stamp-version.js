// Stamp the single source of truth (root package.json "version") into the three
// hand-edited copies: public/index.html ?v=, worker/index.js version:, README badge.
// `--check` exits 1 on any mismatch (CI use); otherwise rewrites all copies in place.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version) {
  console.error('package.json has no "version" — add one before stamping.');
  process.exit(1);
}

const targets = [
  {
    file: resolve(root, 'public/index.html'),
    pattern: /\?v=[0-9]+\.[0-9]+\.[0-9]+/g,
    render: () => `?v=${version}`,
  },
  {
    file: resolve(root, 'worker/index.js'),
    pattern: /version: '[0-9]+\.[0-9]+\.[0-9]+'/,
    render: () => `version: '${version}'`,
  },
  {
    file: resolve(root, 'README.md'),
    pattern: /badge\/version-[0-9]+\.[0-9]+\.[0-9]+-blueviolet/,
    render: () => `badge/version-${version}-blueviolet`,
  },
];

let dirty = false;
let missing = false;
for (const t of targets) {
  const content = readFileSync(t.file, 'utf8');
  // No match means the stamp site moved or was deleted — never a silent pass.
  if (!t.pattern.test(content)) {
    console.error(`No version pattern in ${t.file} — stamp target moved or removed.`);
    missing = true;
    continue;
  }
  t.pattern.lastIndex = 0;
  const next = content.replace(t.pattern, t.render());
  if (next === content) continue;
  dirty = true;
  if (check) {
    console.error(`Version drift in ${t.file} (wanted ${version})`);
    continue;
  }
  writeFileSync(t.file, next);
  console.log(`stamped ${t.file} → ${version}`);
}

if (missing || (check && dirty)) process.exit(1);
