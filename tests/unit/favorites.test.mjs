import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discover } from '../../docs/js/discovery.js';
import { emptyState, reviveSnapshot, mergeSnapshot, mergeDiscovery, normalizeOverrides, viewSites, findEntry } from '../../docs/js/catalog.js';
import {
  FAVORITES_FORMAT,
  MAX_IMPORT_BYTES,
  buildFavoritesExport,
  parseFavoritesImport,
  resolveImport,
  combineFavorites,
  migrateKeys,
  migrateRecents,
  recordRecent,
  reviveKeyList,
  reviveRecents,
} from '../../docs/js/favorites.js';
import { OWNER, repo, mockGitHub, starterRepos, publishedSites } from '../helpers/mock-github.mjs';

const seed = reviveSnapshot(JSON.parse(readFileSync(new URL('../../docs/data/catalog.json', import.meta.url))));
const overrides = normalizeOverrides(JSON.parse(readFileSync(new URL('../../docs/data/overrides.json', import.meta.url))));
const T0 = '2026-09-26T15:00:00.000Z';

async function refresh(state, repos, at = T0) {
  const gh = mockGitHub({ repos, sites: publishedSites(repos) });
  const result = await discover({ owner: OWNER, fetch: gh.fetch, now: () => Date.parse(at) });
  return mergeDiscovery(state, result, { now: at });
}

test('favorites survive refreshes, including the switch to permanent ids', async () => {
  let state = mergeSnapshot(emptyState(), seed).state;
  let favorites = ['name:groundwork', 'name:watercalculator'];

  const first = await refresh(state, starterRepos());
  favorites = migrateKeys(favorites, first.adopted);
  state = first.state;
  assert.deepEqual(favorites, ['repo:5000', 'repo:5010']);

  // A later refresh that finds a new site leaves favorites untouched.
  const second = await refresh(state, [...starterRepos(), repo(9001, 'new-site')], '2026-09-26T17:00:00.000Z');
  favorites = migrateKeys(favorites, second.adopted);
  state = second.state;
  assert.deepEqual(favorites, ['repo:5000', 'repo:5010']);

  const views = viewSites(state, overrides);
  const favoriteTitles = favorites.map((k) => views.find((v) => v.key === k)?.title);
  assert.deepEqual(favoriteTitles, ['Groundwork', 'Water Conservation Calculator']);
});

test('export writes a small, documented file', () => {
  const state = mergeSnapshot(emptyState(), seed).state;
  const views = viewSites(state, overrides);
  const data = buildFavoritesExport(['name:groundwork', 'repo:77'], views, state, T0);
  assert.equal(data.format, FAVORITES_FORMAT);
  assert.equal(data.version, 1);
  assert.equal(data.exportedAt, T0);
  assert.deepEqual(data.favorites, [{ key: 'name:groundwork', name: 'groundwork', title: 'Groundwork' }, { key: 'repo:77' }]);
});

test('an exported file imports cleanly', () => {
  const state = mergeSnapshot(emptyState(), seed).state;
  const views = viewSites(state, overrides);
  const text = JSON.stringify(buildFavoritesExport(['name:groundwork'], views, state, T0));
  const parsed = parseFavoritesImport(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.items, [{ key: 'name:groundwork', name: 'groundwork' }]);
});

const bad = [
  ['not JSON', '{nope', 'not-json'],
  ['a JSON array', '[]', 'wrong-format'],
  ['another app’s file', JSON.stringify({ format: 'something-else', version: 1, favorites: [] }), 'wrong-format'],
  ['a newer version', JSON.stringify({ format: FAVORITES_FORMAT, version: 2, favorites: [] }), 'unsupported-version'],
  ['favorites that are not a list', JSON.stringify({ format: FAVORITES_FORMAT, version: 1, favorites: {} }), 'wrong-format'],
  ['no favorites', JSON.stringify({ format: FAVORITES_FORMAT, version: 1, favorites: [] }), 'empty'],
  ['only unreadable keys', JSON.stringify({ format: FAVORITES_FORMAT, version: 1, favorites: [{ key: '<script>' }, { key: 'repo:-1' }, 7] }), 'no-valid'],
  ['too many favorites', JSON.stringify({ format: FAVORITES_FORMAT, version: 1, favorites: Array.from({ length: 501 }, (_, i) => ({ key: `repo:${i + 1}` })) }), 'too-many'],
  ['a huge file', 'x'.repeat(MAX_IMPORT_BYTES + 1), 'too-large'],
];
for (const [label, text, code] of bad) {
  test(`import rejects ${label}`, () => {
    const parsed = parseFavoritesImport(text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, code);
    assert.equal(typeof parsed.message, 'string');
  });
}

test('import skips bad entries and duplicates but keeps the good ones', () => {
  const parsed = parseFavoritesImport(
    JSON.stringify({
      format: FAVORITES_FORMAT,
      version: 1,
      favorites: [{ key: 'repo:5' }, { key: 'repo:5' }, { key: 'bogus' }, { key: 'name:groundwork', name: '../../etc' }],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.items, [
    { key: 'repo:5', name: null },
    { key: 'name:groundwork', name: null },
  ]);
});

test('imported favorites map onto this device’s keys for the same sites', async () => {
  // This device has already checked GitHub, so it uses permanent ids.
  const state = (await refresh(mergeSnapshot(emptyState(), seed).state, starterRepos())).state;
  const resolved = resolveImport(
    [
      { key: 'name:groundwork', name: 'groundwork' },
      { key: 'repo:5001', name: 'julias-garden-year' },
      { key: 'repo:424242', name: 'not-here-yet' },
    ],
    state,
  );
  assert.deepEqual(resolved.keys, ['repo:5000', 'repo:5001', 'repo:424242']);
  assert.equal(resolved.matched, 2);
  assert.equal(resolved.unmatched, 1);

  // A device that has not checked yet maps ids back to its starter entries by name.
  const fresh = mergeSnapshot(emptyState(), seed).state;
  assert.deepEqual(resolveImport([{ key: 'repo:5000', name: 'groundwork' }], fresh).keys, ['name:groundwork']);
  assert.ok(findEntry(fresh, { name: 'groundwork' }));
});

test('add keeps existing favorites; replace swaps them', () => {
  assert.deepEqual(combineFavorites(['repo:1', 'repo:2'], ['repo:2', 'repo:3'], 'add'), ['repo:1', 'repo:2', 'repo:3']);
  assert.deepEqual(combineFavorites(['repo:1', 'repo:2'], ['repo:3'], 'replace'), ['repo:3']);
});

test('recently opened keeps the latest six, newest first, without repeats', () => {
  let recents = [];
  for (let i = 1; i <= 8; i++) recents = recordRecent(recents, `repo:${i}`, `2026-09-26T10:0${i}:00.000Z`);
  recents = recordRecent(recents, 'repo:5', '2026-09-26T11:00:00.000Z');
  assert.deepEqual(recents.map((r) => r.key), ['repo:5', 'repo:8', 'repo:7', 'repo:6', 'repo:4', 'repo:3']);
  assert.deepEqual(migrateRecents(recents, [{ from: 'repo:5', to: 'repo:50' }])[0].key, 'repo:50');
});

test('saved lists are cleaned when read back', () => {
  assert.deepEqual(reviveKeyList(['repo:1', 'repo:1', 'nope', 42, 'name:x']), ['repo:1', 'name:x']);
  assert.deepEqual(reviveKeyList('not a list'), []);
  assert.deepEqual(reviveRecents([{ key: 'repo:1', at: 'garbage' }, { key: 'repo:2', at: T0 }]), [{ key: 'repo:2', at: T0 }]);
});
