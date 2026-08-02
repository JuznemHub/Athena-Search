import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: ['worker/.wrangler/**'],
  },

  // Node: ES modules, full Node globals
  {
    files: ['server/**/*.js', 'scripts/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // Worker: runs on Cloudflare AND under Node (server/index.js imports it),
  // so it legitimately touches both global sets
  {
    files: ['worker/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.worker, ...globals.node },
    },
  },

  // Frontend: plain <script> tags, not modules
  {
    files: ['public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser,
    },
  },

  // TUI: zero-dependency Node ESM CLI
  {
    files: ['tui/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
  },

  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-control-regex': 'off', // sanitizers deliberately match control chars (filenames, content)
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]);
