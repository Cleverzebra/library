// Device storage. Every key starts with the library's prefix because all
// Cleverzebra sites share one origin (cleverzebra.github.io) and therefore one
// localStorage. The library never clears storage it did not write.

import { CONFIG } from './config.js';

const PREFIX = CONFIG.storagePrefix;

export const KEYS = Object.freeze({
  state: `${PREFIX}catalog`,
  favorites: `${PREFIX}favorites`,
  recents: `${PREFIX}recent`,
  overrides: `${PREFIX}overrides`,
});

// Used when localStorage is unavailable (for example some private windows)
// or a write fails, so the page keeps working for the current visit.
const memory = new Map();
const unsaved = new Set();
let backend;

function local() {
  if (backend !== undefined) return backend;
  try {
    const storage = globalThis.localStorage;
    const probe = `${PREFIX}probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    backend = storage;
  } catch {
    backend = null;
  }
  return backend;
}

export function read(key) {
  let raw = null;
  if (!unsaved.has(key)) {
    try {
      raw = local()?.getItem(key) ?? null;
    } catch {
      raw = null;
    }
  }
  if (raw === null) raw = memory.get(key) ?? null;
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function write(key, value) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    const storage = local();
    if (!storage) throw new Error('No storage');
    storage.setItem(key, raw);
    unsaved.delete(key);
    return true;
  } catch {
    unsaved.add(key);
    return false;
  }
}

export function isPersistent() {
  return local() !== null && unsaved.size === 0;
}
