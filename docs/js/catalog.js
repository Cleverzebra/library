// The library's saved catalog: which sites it knows about, built from the
// bundled snapshot (data/catalog.json) and from live checks, plus how each
// site is presented. Pure functions with no I/O, shared by the page, the
// tests, and the publishing workflow.

import { cleanText, safeHttpsUrl } from './discovery.js';

export const STATE_VERSION = 1;
export const SNAPSHOT_FORMAT = 'cleverzebra-library-catalog';
export const FALLBACK_DESCRIPTION = 'No description yet.';
export const DEFAULT_CATEGORY = 'Other';

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;
const KEY = /^(repo:[1-9]\d{0,15}|name:[a-z0-9._-]{1,100})$/;
const DAY = 24 * 60 * 60 * 1000;
const EPOCH = new Date(0).toISOString();

// Sites are keyed by GitHub's permanent repository id. A site known only from
// the starter list has no id yet and is keyed by name until the first check.
export const keyForRepoId = (id) => `repo:${id}`;
export const keyForName = (name) => `name:${String(name).toLowerCase()}`;
export const isValidKey = (key) => typeof key === 'string' && KEY.test(key);

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    sites: {},
    checks: { lastSuccessAt: null, lastAttemptAt: null, retryAt: null, last: null },
    snapshotAt: null,
  };
}

function reviveEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !REPO_NAME.test(raw.name)) return null;
  const url = safeHttpsUrl(raw.url);
  if (!url) return null;
  const repoId = Number.isSafeInteger(raw.repoId) && raw.repoId > 0 ? raw.repoId : null;
  return {
    key: repoId ? keyForRepoId(repoId) : keyForName(raw.name),
    repoId,
    name: raw.name,
    url,
    repoUrl: safeHttpsUrl(raw.repoUrl),
    description: cleanText(raw.description, 400),
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === 'string' && TOPIC.test(t)).slice(0, 20) : [],
    firstSeen: isoOrNull(raw.firstSeen) ?? EPOCH,
    baseline: raw.baseline === true,
    lastConfirmed: isoOrNull(raw.lastConfirmed),
    misses: Number.isSafeInteger(raw.misses) && raw.misses > 0 ? raw.misses : 0,
    status: raw.status === 'retired' ? 'retired' : 'active',
    retiredAt: isoOrNull(raw.retiredAt),
    source: ['seed', 'snapshot', 'discovered'].includes(raw.source) ? raw.source : 'discovered',
  };
}

function reviveLast(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!['complete', 'partial', 'failed'].includes(raw.outcome)) return null;
  const at = isoOrNull(raw.at);
  if (!at) return null;
  const keys = (list) => (Array.isArray(list) ? list.filter(isValidKey).slice(0, 50) : []);
  return {
    at,
    outcome: raw.outcome,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 40) : null,
    retryAt: isoOrNull(raw.retryAt),
    added: keys(raw.added),
    removed: keys(raw.removed),
    unconfirmed: Number.isSafeInteger(raw.unconfirmed) && raw.unconfirmed > 0 ? raw.unconfirmed : 0,
  };
}

// Adds an entry, combining it with any entry already stored under its key.
function putEntry(state, entry) {
  const existing = state.sites[entry.key];
  if (!existing) {
    state.sites[entry.key] = entry;
    return entry;
  }
  existing.firstSeen = earliest(existing.firstSeen, entry.firstSeen);
  existing.baseline = existing.baseline || entry.baseline;
  if (entry.lastConfirmed && (!existing.lastConfirmed || entry.lastConfirmed > existing.lastConfirmed)) {
    for (const field of ['name', 'url', 'repoUrl', 'description', 'topics', 'lastConfirmed', 'misses', 'status', 'retiredAt']) {
      existing[field] = entry[field];
    }
  }
  return existing;
}

// A starter entry known by name gets its permanent id.
function adopt(state, entry, repoId) {
  const from = entry.key;
  delete state.sites[from];
  entry.repoId = repoId;
  entry.key = keyForRepoId(repoId);
  const kept = putEntry(state, entry);
  return { adoption: { from, to: kept.key }, entry: kept };
}

export function reviveState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return state;
  const sites = raw.sites && typeof raw.sites === 'object' ? Object.values(raw.sites) : [];
  for (const value of sites.slice(0, 2000)) {
    const entry = reviveEntry(value);
    if (entry) putEntry(state, entry);
  }
  const checks = raw.checks && typeof raw.checks === 'object' ? raw.checks : {};
  state.checks.lastSuccessAt = isoOrNull(checks.lastSuccessAt);
  state.checks.lastAttemptAt = isoOrNull(checks.lastAttemptAt);
  state.checks.retryAt = isoOrNull(checks.retryAt);
  state.checks.last = reviveLast(checks.last);
  state.snapshotAt = isoOrNull(raw.snapshotAt);
  return state;
}

/**
 * Finds the stored entry for a repository. With an id, only an entry with that
 * id or a starter entry with that name matches (a new repository that reuses an
 * old name is a different site). Without an id, any entry with the name matches.
 */
export function findEntry(state, { id = null, name = null } = {}) {
  if (Number.isSafeInteger(id)) {
    const byId = state.sites[keyForRepoId(id)];
    if (byId) return byId;
    return typeof name === 'string' ? state.sites[keyForName(name)] ?? null : null;
  }
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  const byKey = state.sites[keyForName(lower)];
  if (byKey) return byKey;
  const matches = Object.values(state.sites).filter((e) => e.name.toLowerCase() === lower);
  return matches.find((e) => e.status === 'active') ?? matches[0] ?? null;
}

export function reviveSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== SNAPSHOT_FORMAT || raw.version !== 1) return null;
  const generatedAt = isoOrNull(raw.generatedAt);
  if (!generatedAt) return null;
  const source = raw.generatedBy === 'workflow' ? 'snapshot' : 'seed';
  const sites = [];
  for (const site of Array.isArray(raw.sites) ? raw.sites.slice(0, 2000) : []) {
    if (!site || typeof site !== 'object') continue;
    const entry = reviveEntry({ ...site, firstSeen: site.firstSeen ?? generatedAt, status: 'active', source });
    if (entry) sites.push(entry);
  }
  return { generatedAt, generatedBy: source === 'seed' ? 'seed' : 'workflow', sites };
}

/**
 * Folds the bundled snapshot into the saved catalog. A snapshot only adds or
 * enriches entries; it never removes anything this device knows about.
 */
export function mergeSnapshot(previous, snapshot) {
  const state = structuredClone(previous);
  const adopted = [];
  const added = [];
  if (!snapshot) return { state, adopted, added };
  for (const incoming of snapshot.sites) {
    let entry = findEntry(state, { id: incoming.repoId, name: incoming.name });
    if (!entry) {
      putEntry(state, structuredClone(incoming));
      added.push(incoming.key);
      continue;
    }
    if (entry.repoId === null && incoming.repoId !== null) {
      const result = adopt(state, entry, incoming.repoId);
      adopted.push(result.adoption);
      entry = result.entry;
    }
    entry.firstSeen = earliest(entry.firstSeen, incoming.firstSeen);
    entry.baseline = entry.baseline || incoming.baseline;
    const newer = incoming.lastConfirmed && (!entry.lastConfirmed || incoming.lastConfirmed > entry.lastConfirmed);
    if (newer) {
      for (const field of ['name', 'url', 'repoUrl', 'description', 'topics', 'lastConfirmed']) {
        entry[field] = structuredClone(incoming[field]);
      }
      // Seen published after this device retired it: bring it back.
      if (entry.status === 'retired' && (!entry.retiredAt || incoming.lastConfirmed > entry.retiredAt)) {
        entry.status = 'active';
        entry.retiredAt = null;
        entry.misses = 0;
      }
    }
  }
  state.snapshotAt = snapshot.generatedAt;
  return { state, adopted, added };
}

/**
 * Applies one discovery result. Only a complete check can count a site as
 * missing, and a site is removed only after `missesToRemove` complete checks
 * in a row confirm it is gone. Failed and partial checks never remove anything.
 */
export function mergeDiscovery(previous, result, { now = new Date().toISOString(), missesToRemove = 2 } = {}) {
  const state = structuredClone(previous);
  const nowIso = isoOrNull(typeof now === 'string' ? now : new Date(now).toISOString());
  const adopted = [];
  const added = [];
  const removed = [];
  state.checks.lastAttemptAt = nowIso;

  const record = (outcome, reason, retryAt, unconfirmed = 0) => {
    state.checks.retryAt = retryAt ?? null;
    state.checks.last = { at: nowIso, outcome, reason: reason ?? null, retryAt: retryAt ?? null, added, removed, unconfirmed };
  };

  if (result.outcome === 'failed') {
    record('failed', result.reason, result.retryAt);
    return { state, adopted, added, removed };
  }

  const confirmedIds = new Set();
  for (const item of result.published) {
    const { repo } = item;
    const url = safeHttpsUrl(item.url);
    if (!url || !Number.isSafeInteger(repo?.id)) continue;
    let entry = findEntry(state, { id: repo.id, name: repo.name });
    if (entry && entry.repoId === null) {
      const adoption = adopt(state, entry, repo.id);
      adopted.push(adoption.adoption);
      entry = adoption.entry;
    }
    if (!entry) {
      entry = putEntry(state, {
        key: keyForRepoId(repo.id),
        repoId: repo.id,
        name: repo.name,
        url,
        repoUrl: null,
        description: null,
        topics: [],
        firstSeen: nowIso,
        baseline: false,
        lastConfirmed: null,
        misses: 0,
        status: 'active',
        retiredAt: null,
        source: 'discovered',
      });
      added.push(entry.key);
    }
    Object.assign(entry, {
      name: repo.name,
      url,
      repoUrl: repo.htmlUrl ?? entry.repoUrl,
      description: repo.description ?? null,
      topics: Array.isArray(repo.topics) ? [...repo.topics] : [],
      lastConfirmed: nowIso,
      misses: 0,
      status: 'active',
      retiredAt: null,
    });
    confirmedIds.add(repo.id);
  }

  // Candidates that could not be confirmed yet, counted only when new.
  const unconfirmedNew = result.unconfirmed.filter((u) => !findEntry(state, { id: u.repoId, name: u.name })).length;

  if (result.outcome !== 'complete') {
    record('partial', result.reason, result.retryAt, unconfirmedNew);
    return { state, adopted, added, removed };
  }

  const active = Object.values(state.sites).filter((e) => e.status === 'active');
  // A complete listing that confirms none of the known sites is far more
  // likely a GitHub hiccup than every site disappearing at once.
  if (active.length > 0 && confirmedIds.size === 0) {
    record('partial', 'unexpected-listing', null, unconfirmedNew);
    return { state, adopted, added, removed };
  }

  const listedIds = new Set(result.listedRepoIds);
  const idByName = new Map(result.listedRepoNames.map((name, i) => [name, result.listedRepoIds[i]]));
  const unpublishedIds = new Set(result.unpublished.map((u) => u.repoId));
  const unconfirmedIds = new Set(result.unconfirmed.map((u) => u.repoId));
  for (const entry of active) {
    const id = entry.repoId ?? idByName.get(entry.name.toLowerCase()) ?? null;
    if (id !== null && (confirmedIds.has(id) || unconfirmedIds.has(id))) continue;
    const gone = id === null || !listedIds.has(id) || unpublishedIds.has(id);
    if (!gone) continue;
    entry.misses += 1;
    if (entry.misses >= missesToRemove) {
      entry.status = 'retired';
      entry.retiredAt = nowIso;
      removed.push(entry.key);
    }
  }
  state.checks.lastSuccessAt = nowIso;
  record('complete', null, null, unconfirmedNew);
  return { state, adopted, added, removed };
}

export function isCheckDue(state, nowMs, { intervalMs, backoffMs }) {
  const { lastSuccessAt, lastAttemptAt, retryAt, last } = state.checks;
  if (retryAt && Date.parse(retryAt) > nowMs) return false;
  if (last && last.outcome !== 'complete' && lastAttemptAt && nowMs - Date.parse(lastAttemptAt) < backoffMs) {
    return false;
  }
  if (!lastSuccessAt) return true;
  return nowMs - Date.parse(lastSuccessAt) >= intervalMs;
}

// The bundled snapshot written by the publishing workflow.
export function stateToSnapshot(state, { generatedAt, owner, generatedBy = 'workflow' }) {
  const sites = Object.values(state.sites)
    .filter((e) => e.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      repoId: e.repoId,
      name: e.name,
      url: e.url,
      repoUrl: e.repoUrl,
      description: e.description,
      topics: e.topics,
      firstSeen: e.firstSeen,
      baseline: e.baseline,
      lastConfirmed: e.lastConfirmed,
      misses: e.misses,
    }));
  return { format: SNAPSHOT_FORMAT, version: 1, owner, generatedAt, generatedBy, lastCheck: state.checks.last, sites };
}

// ---------------------------------------------------------------------------
// Presentation

export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeOverrides(raw) {
  const result = { categories: [], byName: new Map(), byId: new Map() };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const value of Array.isArray(source.categories) ? source.categories.slice(0, 30) : []) {
    const name = cleanText(value, 40);
    if (name && !result.categories.includes(name)) result.categories.push(name);
  }
  if (!result.categories.includes(DEFAULT_CATEGORY)) result.categories.push(DEFAULT_CATEGORY);
  const sites = source.sites && typeof source.sites === 'object' && !Array.isArray(source.sites) ? source.sites : {};
  for (const [name, value] of Object.entries(sites).slice(0, 1000)) {
    if (!REPO_NAME.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const override = {
      title: cleanText(value.title, 120),
      description: cleanText(value.description, 400),
      category: cleanText(value.category, 40),
      order: Number.isFinite(value.order) ? value.order : null,
      tags: Array.isArray(value.tags) ? value.tags.map((t) => cleanText(t, 40)).filter(Boolean).slice(0, 20) : [],
      exclude: value.exclude === true,
      repoId: Number.isSafeInteger(value.repoId) && value.repoId > 0 ? value.repoId : null,
    };
    result.byName.set(name.toLowerCase(), override);
    if (override.repoId) result.byId.set(override.repoId, override);
  }
  return result;
}

function overrideFor(entry, overrides) {
  return (entry.repoId && overrides.byId.get(entry.repoId)) || overrides.byName.get(entry.name.toLowerCase()) || null;
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
const UPPER_WORDS = new Set(['hq', 'faq', 'ai', 'api', 'diy', 'gps', 'nyc', 'pdf', 'tv', 'uk', 'usa']);

export function titleFromName(name) {
  let base = String(name);
  if (base.toLowerCase().endsWith('.github.io')) base = base.slice(0, -'.github.io'.length);
  const words = base.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean);
  if (!words.length) return String(name);
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (UPPER_WORDS.has(lower)) return lower.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

// A GitHub topic that matches a category name (for example "local-guides")
// files a new site under that category without an overrides entry.
function categoryFromTopics(topics, categories) {
  for (const category of categories) {
    if (category !== DEFAULT_CATEGORY && topics.includes(slugify(category))) return category;
  }
  return null;
}

export function isRecentlyAdded(entry, nowMs, recentDays) {
  if (entry.baseline) return false;
  const seen = Date.parse(entry.firstSeen);
  if (!Number.isFinite(seen)) return false;
  return nowMs - seen < recentDays * DAY && seen <= nowMs + DAY;
}

export function orderedCategories(views, categories) {
  const present = new Set(views.map((v) => v.category));
  const known = categories.filter((c) => present.has(c) && c !== DEFAULT_CATEGORY);
  const extra = [...present].filter((c) => !categories.includes(c) && c !== DEFAULT_CATEGORY).sort((a, b) => a.localeCompare(b));
  return [...known, ...extra, ...(present.has(DEFAULT_CATEGORY) ? [DEFAULT_CATEGORY] : [])];
}

export function viewSites(state, overrides, { now = Date.now(), recentDays = 14 } = {}) {
  const views = [];
  for (const entry of Object.values(state.sites)) {
    if (entry.status !== 'active') continue;
    const override = overrideFor(entry, overrides);
    if (override?.exclude) continue;
    const url = safeHttpsUrl(entry.url);
    if (!url) continue;
    const description = override?.description || entry.description || null;
    views.push({
      key: entry.key,
      name: entry.name,
      url,
      title: override?.title || titleFromName(entry.name),
      description: description || FALLBACK_DESCRIPTION,
      isFallbackDescription: !description,
      category: override?.category || categoryFromTopics(entry.topics, overrides.categories) || DEFAULT_CATEGORY,
      tags: [...new Set([...(override?.tags ?? []), ...entry.topics.map((t) => t.replace(/-/g, ' '))])],
      order: override?.order ?? null,
      isNew: isRecentlyAdded(entry, now, recentDays),
    });
  }
  const rank = new Map(orderedCategories(views, overrides.categories).map((c, i) => [c, i]));
  return views.sort(
    (a, b) =>
      rank.get(a.category) - rank.get(b.category) ||
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      a.title.localeCompare(b.title),
  );
}

export function normalizeForSearch(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Searches the library's own titles, descriptions, and tags (not the sites).
export function searchViews(views, query) {
  const terms = normalizeForSearch(query).split(' ').filter(Boolean);
  if (!terms.length) return views;
  const scored = [];
  views.forEach((view, index) => {
    const title = normalizeForSearch(view.title);
    const extra = normalizeForSearch([...view.tags, view.category, view.name.replace(/[-_.]/g, ' ')].join(' '));
    const description = view.isFallbackDescription ? '' : normalizeForSearch(view.description);
    let score = 0;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inExtra = extra.includes(term);
      const inDescription = description.includes(term);
      if (!inTitle && !inExtra && !inDescription) return;
      if (inTitle) score += title.split(' ').some((w) => w.startsWith(term)) ? 4 : 3;
      if (inExtra) score += 2;
      if (inDescription) score += 1;
    }
    scored.push({ view, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.view);
}
