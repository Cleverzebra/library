// Favorites and recently opened sites: validation, key migration, and the
// export/import file format. Favorites are stored as stable site keys
// (GitHub repository ids), so they survive catalog refreshes and renames.

import { findEntry, isValidKey } from './catalog.js';

export const FAVORITES_FORMAT = 'cleverzebra-library-favorites';
export const MAX_IMPORT_BYTES = 100 * 1024;
export const MAX_FAVORITES = 500;
export const MAX_RECENTS = 6;

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function reviveKeyList(raw, max = MAX_FAVORITES) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isValidKey))].slice(0, max);
}

export function reviveRecents(raw, max = MAX_RECENTS) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  for (const item of raw.slice(0, 50)) {
    if (!item || !isValidKey(item.key) || seen.has(item.key)) continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at)) continue;
    seen.add(item.key);
    list.push({ key: item.key, at: new Date(at).toISOString() });
  }
  return list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}

export function recordRecent(recents, key, nowIso, max = MAX_RECENTS) {
  return [{ key, at: nowIso }, ...recents.filter((r) => r.key !== key)].slice(0, max);
}

// When a starter site (keyed by name) gets its permanent id, move its key.
export function migrateKeys(keys, adopted) {
  if (!adopted.length) return keys;
  const map = new Map(adopted.map((a) => [a.from, a.to]));
  return [...new Set(keys.map((k) => map.get(k) ?? k))];
}

export function migrateRecents(recents, adopted) {
  if (!adopted.length) return recents;
  const map = new Map(adopted.map((a) => [a.from, a.to]));
  return reviveRecents(recents.map((r) => ({ key: map.get(r.key) ?? r.key, at: r.at })));
}

export function buildFavoritesExport(keys, views, state, nowIso) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  return {
    format: FAVORITES_FORMAT,
    version: 1,
    exportedAt: nowIso,
    favorites: keys.map((key) => {
      const view = byKey.get(key);
      const name = view?.name ?? state.sites[key]?.name ?? (key.startsWith('name:') ? key.slice(5) : null);
      const item = { key };
      if (name) item.name = name;
      if (view?.title) item.title = view.title;
      return item;
    }),
  };
}

const MESSAGES = {
  unreadable: "That file couldn’t be read.",
  'too-large': 'That file is too large to be a favorites file.',
  'not-json': "That file isn’t a favorites file. It isn’t valid JSON.",
  'wrong-format': "That file isn’t a Cleverzebra Library favorites file.",
  'unsupported-version': 'That favorites file comes from a newer version of the library.',
  'too-many': `That file lists more than ${MAX_FAVORITES} favorites.`,
  empty: "That file doesn’t contain any favorites.",
  'no-valid': 'None of the favorites in that file could be read.',
};

function failure(code) {
  return { ok: false, code, message: MESSAGES[code] };
}

export function parseFavoritesImport(text) {
  if (typeof text !== 'string') return failure('unreadable');
  if (text.length > MAX_IMPORT_BYTES) return failure('too-large');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return failure('not-json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== FAVORITES_FORMAT) {
    return failure('wrong-format');
  }
  if (typeof data.version !== 'number' || data.version > 1) return failure('unsupported-version');
  if (data.version !== 1 || !Array.isArray(data.favorites)) return failure('wrong-format');
  if (data.favorites.length > MAX_FAVORITES) return failure('too-many');
  const items = [];
  const seen = new Set();
  let skipped = 0;
  for (const favorite of data.favorites) {
    if (!favorite || typeof favorite !== 'object' || !isValidKey(favorite.key)) {
      skipped += 1;
      continue;
    }
    if (seen.has(favorite.key)) continue;
    seen.add(favorite.key);
    const name = typeof favorite.name === 'string' && REPO_NAME.test(favorite.name) ? favorite.name : null;
    items.push({ key: favorite.key, name });
  }
  if (!items.length) return failure(skipped ? 'no-valid' : 'empty');
  return { ok: true, items, skipped };
}

// Maps imported favorites onto this device's keys for the same sites. A
// favorite for a site this device hasn't found yet is kept and starts
// applying once the site appears.
export function resolveImport(items, state) {
  const keys = [];
  let matched = 0;
  for (const item of items) {
    const id = item.key.startsWith('repo:') ? Number(item.key.slice(5)) : null;
    const name = item.name ?? (item.key.startsWith('name:') ? item.key.slice(5) : null);
    const entry = findEntry(state, { id, name });
    const key = entry && entry.status === 'active' ? entry.key : item.key;
    if (keys.includes(key)) continue;
    if (entry && entry.status === 'active') matched += 1;
    keys.push(key);
  }
  return { keys, matched, unmatched: keys.length - matched };
}

export function combineFavorites(current, incoming, mode) {
  const list = mode === 'replace' ? incoming : [...current, ...incoming];
  return [...new Set(list)].slice(0, MAX_FAVORITES);
}
