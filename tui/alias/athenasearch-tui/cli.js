#!/usr/bin/env node
// athenasearch-tui — alias shim that runs athena-tui.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
await import(require.resolve('athena-tui'));
