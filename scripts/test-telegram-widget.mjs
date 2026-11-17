import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSearchWidgetHtml } from '../worker/index.js';

test('Bot API 10.4 search & AI widget HTML satisfies QuickJS profile and zlib 4KB limit', () => {
  const html = buildSearchWidgetHtml({
    sessionId: 'ts_abcdef123456',
    mode: 'ai',
    scope: 'community',
    query: 'selfhosted video transcoders </script><script>alert(1)</script>',
    page: 0,
    total: 9,
    totalPages: 3,
    items: [
      { id: '1', t: 'HandBrake Transcoder', u: 'https://handbrake.fr', h: 'handbrake.fr', n: 'Open source video transcoder.', g: ['video', 'tools'], e: 'Alice', ce: 1, cd: 1, ca: 1 },
      { id: '2', t: 'FFmpeg Guide', u: 'https://ffmpeg.org', h: 'ffmpeg.org', n: 'CLI multimedia framework.', g: ['cli'], e: '', ce: 1, cd: 0, ca: 0 },
      { id: '3', t: 'Local Doc', u: '', h: 'notes.md', n: 'Internal note.', g: ['docs'], e: '', ce: 0, cd: 0, ca: 0 }
    ],
    aiAnswer: 'Grounded recommendation highlighting HandBrake and FFmpeg.',
    webUrl: 'https://athena.juznem.eu.org'
  });

  const rawBytes = Buffer.byteLength(html, 'utf8');
  const compressedBytes = zlib.deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).length;

  assert.ok(rawBytes <= 32768, `Expected <= 32768 raw bytes, got ${rawBytes}`);
  assert.ok(compressedBytes <= 4096, `Expected <= 4096 zlib bytes, got ${compressedBytes}`);

  // No stripped QuickJS profile controls or height-relative CSS units
  assert.doesNotMatch(html, /<(input|select|textarea)\b/i);
  assert.doesNotMatch(html, /\d+(vh|dvh|svh)\b/);
  assert.doesNotMatch(html, /<\/script><script>alert/i);
  assert.match(html, /TelegramWidget/);
  assert.match(html, /data-op="e"/);
  assert.match(html, /data-op="a"/);
  assert.match(html, /data-op="d"/);
  assert.match(html, /table class="wt"/);
});

test('Telegram webhook routes widget_query and advertises widget updates in setWebhook', () => {
  const src = readFileSync(new URL('../worker/index_legacy.js', import.meta.url), 'utf8');
  assert.match(src, /'widget_query'/);
  assert.match(src, /'shared_widget_query'/);
  assert.match(src, /update\.widget_query\s*\|\|\s*update\.shared_widget_query/);
  assert.match(src, /handleTelegramWidgetQuery/);
  assert.match(src, /answerWidgetQuery/);
  assert.match(src, /editMessageWidgetData/);
  assert.match(src, /sendWidget/);
});
