import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { loadBookmarks, detectBookmarks } = await import('./src/browsers.js');

function buildPlaces(dir) {
  const db = new DatabaseSync(join(dir, 'places.sqlite'));
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE moz_bookmarks (
      id INTEGER PRIMARY KEY, type INTEGER, parent INTEGER, fk INTEGER,
      position INTEGER, title TEXT, dateAdded INTEGER, lastModified INTEGER
    );
    CREATE INDEX moz_bookmarks_parent ON moz_bookmarks (parent);
    CREATE INDEX moz_bookmarks_fk ON moz_bookmarks (fk);
    INSERT INTO moz_bookmarks VALUES
      (1, 2, 0, NULL, 0, 'PlacesRoot', 0, 0),
      (2, 2, 1, NULL, 0, 'menu', 0, 0),
      (3, 2, 1, NULL, 1, 'toolbar', 0, 0),
      (5, 2, 1, NULL, 2, 'unfiled', 0, 0),
      (10, 2, 5, NULL, 0, 'Misc', 0, 0),
      (11, 2, 10, NULL, 0, 'pmwiki', 0, 0),
      (12, 2, 3, NULL, 0, 'dev', 0, 0),
      (13, 2, 11, NULL, 0, 'nested/deep', 0, 0);
    INSERT INTO moz_places VALUES
      (1, 'https://wiki.example.org/HomePage', NULL),
      (2, 'https://github.com/foo/bar', 'foo/bar'),
      (3, 'https://localhost:8080/ignored', NULL),
      (4, 'https://deep.example.com/x', NULL);
    INSERT INTO moz_bookmarks VALUES
      (100, 1, 11, 1, 0, '', 0, 0),
      (101, 1, 3, 2, 0, 'GitHub bar', 0, 0),
      (102, 1, 12, 3, 0, '', 0, 0),
      (103, 1, 13, 4, 0, '', 0, 0);
  `);
  db.close();
}

test('firefox: full folder paths become tags, roots mapped to friendly names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fftest-'));
  try {
    buildPlaces(dir);
    const links = await loadBookmarks({ kind: 'firefox', file: dir });
    const byUrl = new Map(links.map((l) => [l.url, l]));
    assert.deepEqual(byUrl.get('https://wiki.example.org/HomePage').tags,
      ['Other Bookmarks', 'Misc', 'pmwiki']);
    assert.deepEqual(byUrl.get('https://github.com/foo/bar').tags,
      ['Bookmarks Toolbar']);
    assert.deepEqual(byUrl.get('https://deep.example.com/x').tags,
      ['Other Bookmarks', 'Misc', 'pmwiki', 'nested/deep']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('firefox: detectBookmarks finds places.sqlite by content, not by dir name', () => {
  const home = mkdtempSync(join(tmpdir(), 'ffhome-'));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const dir = join(home, '.mozilla', 'firefox', 'custom-edition-profile');
    mkdirSync(dir, { recursive: true });
    buildPlaces(dir);
    const found = detectBookmarks().filter((s) => s.kind === 'firefox');
    assert.equal(found.length, 1);
    assert.equal(found[0].file, dir);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
