// The library page: loads the saved catalog, checks GitHub for new sites when
// due, and renders the cards. All text from GitHub or the data files is
// inserted with textContent, never as HTML.

import { CONFIG } from './config.js';
import { discover } from './discovery.js';
import {
  emptyState,
  reviveState,
  reviveSnapshot,
  mergeSnapshot,
  mergeDiscovery,
  findEntry,
  normalizeOverrides,
  viewSites,
  searchViews,
  orderedCategories,
  isCheckDue,
  slugify,
} from './catalog.js';
import {
  MAX_IMPORT_BYTES,
  reviveKeyList,
  reviveRecents,
  recordRecent,
  migrateKeys,
  migrateRecents,
  buildFavoritesExport,
  parseFavoritesImport,
  resolveImport,
  combineFavorites,
} from './favorites.js';
import * as store from './store.js';
import { describeStatus, formatUntil, plural } from './format.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  status: $('#status'),
  statusText: $('#status-text'),
  checkBtn: $('#check-btn'),
  finder: $('#finder'),
  search: $('#search'),
  filters: $('#filters'),
  reset: $('#reset'),
  resultsCount: $('#results-count'),
  content: $('#content'),
  offline: $('#offline-banner'),
  update: $('#update-banner'),
  updateBtn: $('#update-btn'),
  moreBtn: $('#more-btn'),
  moreDialog: $('#more-dialog'),
  exportBtn: $('#export-btn'),
  importBtn: $('#import-btn'),
  importInput: $('#import-input'),
  importDialog: $('#import-dialog'),
  importTitle: $('#import-title'),
  importSummary: $('#import-summary'),
  toast: $('#toast'),
  version: $('#app-version'),
};

const app = {
  state: emptyState(),
  favorites: [],
  recents: [],
  overrides: normalizeOverrides(null),
  query: '',
  filter: 'all',
  checking: false,
  ready: false,
  pendingImport: null,
  filterSignature: '',
};

const TONES = { gardens: 1, 'local-guides': 2, monhegan: 3, family: 4, other: 0 };

function toneFor(category) {
  const slug = slugify(category);
  if (slug in TONES) return TONES[slug];
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return 5 + (hash % 3);
}

// --- storage -----------------------------------------------------------------

function loadLocal() {
  app.state = reviveState(store.read(store.KEYS.state));
  app.favorites = reviveKeyList(store.read(store.KEYS.favorites));
  app.recents = reviveRecents(store.read(store.KEYS.recents));
  app.overrides = normalizeOverrides(store.read(store.KEYS.overrides));
}

function freshState() {
  return reviveState(store.read(store.KEYS.state));
}

function saveState() {
  store.write(store.KEYS.state, app.state);
}

function saveFavorites() {
  store.write(store.KEYS.favorites, app.favorites);
}

function saveRecents() {
  store.write(store.KEYS.recents, app.recents);
}

function applyAdopted(adopted) {
  if (!adopted.length) return;
  app.favorites = migrateKeys(app.favorites, adopted);
  app.recents = migrateRecents(app.recents, adopted);
  saveFavorites();
  saveRecents();
}

async function fetchJson(path) {
  const res = await fetch(new URL(path, document.baseURI), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// The bundled files: the starter/snapshot catalog and the optional overrides.
async function loadBundled() {
  const [catalog, overrides] = await Promise.allSettled([fetchJson('data/catalog.json'), fetchJson('data/overrides.json')]);
  if (overrides.status === 'fulfilled') {
    app.overrides = normalizeOverrides(overrides.value);
    store.write(store.KEYS.overrides, overrides.value);
  }
  if (catalog.status === 'fulfilled') {
    const snapshot = reviveSnapshot(catalog.value);
    if (snapshot) {
      const merged = mergeSnapshot(freshState(), snapshot);
      app.state = merged.state;
      saveState();
      applyAdopted(merged.adopted);
    }
  }
}

// --- checking GitHub ----------------------------------------------------------

function ownPathName() {
  // On GitHub Pages the first path segment is this repository's name.
  if (!location.hostname.endsWith('.github.io')) return [];
  const first = location.pathname.split('/').filter(Boolean)[0];
  return first ? [first] : [];
}

async function withCheckLock(task) {
  if (navigator.locks?.request) {
    return navigator.locks.request(`${CONFIG.storagePrefix}check`, { ifAvailable: true }, async (lock) => {
      if (lock) await task();
    });
  }
  return task();
}

const dueOptions = { intervalMs: CONFIG.checkIntervalMs, backoffMs: CONFIG.retryBackoffMs };

async function runCheck(trigger) {
  if (app.checking) return;
  const manual = trigger === 'manual';
  if (!manual && !isCheckDue(app.state, Date.now(), dueOptions)) return;
  if (navigator.onLine === false) {
    if (manual) showToast("You’re offline. The library will check for new sites when you’re back online.");
    renderStatus();
    return;
  }
  const retryAt = app.state.checks.retryAt;
  if (manual && retryAt && Date.parse(retryAt) > Date.now()) {
    showToast(`GitHub asked the library to wait until ${formatUntil(retryAt)}. It will check again after that.`);
    return;
  }

  app.checking = true;
  els.checkBtn.disabled = true;
  renderStatus();
  try {
    await withCheckLock(async () => {
      // Another window may have checked a moment ago.
      const base = freshState();
      if (!manual && !isCheckDue(base, Date.now(), dueOptions)) {
        app.state = base;
        return;
      }
      const result = await discover({
        owner: CONFIG.owner,
        fetch: (url, init) => fetch(url, init),
        apiBase: CONFIG.apiBase,
        excludeRepoIds: [CONFIG.libraryRepoId],
        excludeRepoNames: [...CONFIG.libraryRepoNames, ...ownPathName()],
        isKnown: (repo) => Boolean(findEntry(base, { id: repo.id, name: repo.name })),
        verifyInit: { cache: 'no-store', credentials: 'omit' },
        probeRedirects: true,
      });
      if (result.outcome === 'failed' && result.reason === 'network' && navigator.onLine === false) {
        result.reason = 'offline';
      }
      const merged = mergeDiscovery(freshState(), result, {
        now: new Date().toISOString(),
        missesToRemove: CONFIG.missesToRemove,
      });
      app.state = merged.state;
      saveState();
      applyAdopted(merged.adopted);
    });
  } catch (err) {
    console.error('Checking for new sites failed', err);
    const merged = mergeDiscovery(app.state, { outcome: 'failed', reason: 'unexpected' }, { now: new Date().toISOString() });
    app.state = merged.state;
    saveState();
  } finally {
    app.checking = false;
    els.checkBtn.disabled = false;
    render();
  }
}

// --- rendering ----------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function currentViews() {
  return viewSites(app.state, app.overrides, { now: Date.now(), recentDays: CONFIG.recentDays });
}

function card(view, sectionId) {
  const favorite = app.favorites.includes(view.key);
  const titleId = `${sectionId}-${view.key.replace(/[^a-z0-9]/gi, '-')}`;
  const top = el(
    'div',
    { className: 'card-top' },
    el('span', { className: 'cat-chip', text: view.category }),
    view.isNew ? el('span', { className: 'new-badge', text: 'Recently added' }) : null,
    el(
      'button',
      {
        type: 'button',
        className: 'fav-btn',
        'aria-pressed': favorite ? 'true' : 'false',
        'aria-label': `Favorite ${view.title}`,
        dataset: { fav: view.key, focusId: `${sectionId}|fav|${view.key}` },
      },
      icon('star'),
    ),
  );
  const link = el(
    'a',
    {
      className: 'open-link',
      href: view.url,
      target: '_blank',
      rel: 'noopener',
      dataset: { open: view.key, focusId: `${sectionId}|open|${view.key}` },
    },
    el('span', { text: 'Open' }),
    el('span', { className: 'visually-hidden', text: ` ${view.title} (opens in a new window)` }),
    icon('arrow'),
  );
  return el(
    'li',
    { className: 'card', dataset: { tone: String(toneFor(view.category)), key: view.key } },
    el(
      'article',
      { className: 'card-body', 'aria-labelledby': titleId },
      top,
      el('h3', { className: 'card-title', id: titleId, text: view.title }),
      el('p', { className: view.isFallbackDescription ? 'card-desc is-fallback' : 'card-desc', text: view.description }),
      el('div', { className: 'card-foot' }, link),
    ),
  );
}

function section(id, title, views, { note, level = 2 } = {}) {
  const headingId = `${id}-title`;
  return el(
    'section',
    { className: 'shelf', 'aria-labelledby': headingId, dataset: { section: id } },
    el(
      'div',
      { className: 'shelf-head' },
      el(`h${level}`, { id: headingId, text: title }),
      el('span', { className: 'count', text: note ?? plural(views.length, 'site') }),
    ),
    el('ul', { className: 'grid', role: 'list' }, views.map((v) => card(v, id))),
  );
}

function recentRow(byKey) {
  const items = app.recents.map((r) => byKey.get(r.key)).filter(Boolean).slice(0, 6);
  if (!items.length) return null;
  return el(
    'section',
    { className: 'recent', 'aria-labelledby': 'recent-title' },
    el('h2', { className: 'recent-label', id: 'recent-title' }, icon('clock', 'icon icon-small'), 'Recently opened'),
    el(
      'ul',
      { className: 'recent-list', role: 'list' },
      items.map((v) =>
        el(
          'li',
          {},
          el('a', {
            className: 'recent-link',
            href: v.url,
            target: '_blank',
            rel: 'noopener',
            text: v.title,
            dataset: { open: v.key, focusId: `recent|open|${v.key}` },
          }),
        ),
      ),
    ),
    el('button', { type: 'button', className: 'btn btn-link', dataset: { clearRecents: '1', focusId: 'recent|clear' }, text: 'Clear' }),
  );
}

function emptyMessage(title, body, withReset) {
  return el(
    'div',
    { className: 'empty' },
    el('h2', { text: title }),
    el('p', { text: body }),
    withReset
      ? el('button', { type: 'button', className: 'btn btn-quiet', dataset: { reset: '1', focusId: 'empty|reset' }, text: 'Reset search and filters' })
      : null,
  );
}

function filteredViews(views) {
  if (app.filter === 'favorites') {
    const byKey = new Map(views.map((v) => [v.key, v]));
    return app.favorites.map((k) => byKey.get(k)).filter(Boolean);
  }
  if (app.filter !== 'all') return views.filter((v) => slugify(v.category) === app.filter);
  return views;
}

function renderFilters(views) {
  const categories = orderedCategories(views, app.overrides.categories);
  const options = [
    { value: 'all', label: 'All' },
    { value: 'favorites', label: 'Favorites' },
    ...categories.map((c) => ({ value: slugify(c), label: c, tone: toneFor(c) })),
  ];
  if (app.filter !== 'all' && !options.some((o) => o.value === app.filter)) app.filter = 'all';
  const signature = options.map((o) => `${o.value}:${o.label}`).join('|');
  if (signature !== app.filterSignature) {
    app.filterSignature = signature;
    const legend = els.filters.querySelector('legend');
    els.filters.replaceChildren(
      legend,
      ...options.map((o) =>
        el(
          'label',
          { className: 'chip', dataset: o.tone === undefined ? {} : { tone: String(o.tone) } },
          el('input', { type: 'radio', name: 'filter', value: o.value }),
          el('span', { className: 'chip-face' }, o.tone === undefined ? null : el('span', { className: 'chip-dot', 'aria-hidden': 'true' }), o.label),
        ),
      ),
    );
  }
  for (const input of els.filters.querySelectorAll('input')) input.checked = input.value === app.filter;
  els.reset.hidden = !(app.query.trim() || app.filter !== 'all');
}

let announceTimer;
function announce(text) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    els.resultsCount.textContent = text;
  }, 400);
}

function renderContent(views) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  const query = app.query.trim();
  const shown = filteredViews(views);
  const nodes = [];

  if (!app.ready && !views.length) {
    nodes.push(el('p', { className: 'loading', text: 'Loading your library' }));
  } else if (query) {
    const results = searchViews(shown, query);
    const scope = app.filter === 'favorites' ? ' in your favorites' : app.filter !== 'all' ? ' in this category' : '';
    announce(results.length ? `${plural(results.length, 'site')} match${results.length === 1 ? 'es' : ''}.` : 'No sites match.');
    if (results.length) {
      nodes.push(section('results', 'Search results', results, { note: `${plural(results.length, 'site')} match “${query}”${scope}` }));
    } else {
      nodes.push(
        emptyMessage(
          `No sites match “${query}”${scope}.`,
          'Search looks at the titles, descriptions, and tags in this library, not at the pages inside each site. Try a different word.',
          true,
        ),
      );
    }
  } else if (app.filter === 'favorites') {
    announce(`${plural(shown.length, 'favorite')}.`);
    nodes.push(
      shown.length
        ? section('favorites', 'Favorites', shown)
        : emptyMessage('No favorites yet.', 'Tap the star on any site to keep it here. Favorites are saved on this device.', false),
    );
  } else if (app.filter !== 'all') {
    announce(`${plural(shown.length, 'site')}.`);
    if (shown.length) nodes.push(section(`cat-${app.filter}`, shown[0].category, shown));
  } else if (!views.length) {
    nodes.push(
      emptyMessage(
        'No sites yet.',
        'The library lists the GitHub Pages sites on the Cleverzebra account. It will fill in once it can check GitHub.',
        false,
      ),
    );
  } else {
    announce('');
    nodes.push(recentRow(byKey));
    const favorites = app.favorites.map((k) => byKey.get(k)).filter(Boolean);
    if (favorites.length) nodes.push(section('favorites', 'Favorites', favorites));
    for (const category of orderedCategories(views, app.overrides.categories)) {
      nodes.push(section(`cat-${slugify(category)}`, category, views.filter((v) => v.category === category)));
    }
  }

  const focusId = document.activeElement?.dataset?.focusId;
  els.content.replaceChildren(...nodes.filter(Boolean));
  if (focusId) {
    const candidates = [...els.content.querySelectorAll('[data-focus-id]')];
    const suffix = focusId.slice(focusId.indexOf('|'));
    const target =
      candidates.find((n) => n.dataset.focusId === focusId) ?? candidates.find((n) => n.dataset.focusId.endsWith(suffix));
    (target ?? els.content).focus({ preventScroll: true });
  }
}

function titleFor(key) {
  const entry = app.state.sites[key];
  if (!entry) return key;
  return currentViews().find((v) => v.key === key)?.title ?? entry.name;
}

function renderStatus() {
  const online = navigator.onLine !== false;
  const status = describeStatus({ checks: app.state.checks, online, checking: app.checking, titleFor });
  els.statusText.textContent = !app.ready && !app.checking && !app.state.checks.last ? 'Loading your library' : status.text;
  els.status.dataset.tone = status.tone;
  els.status.setAttribute('aria-busy', app.checking ? 'true' : 'false');
  els.offline.hidden = online;
}

function render() {
  const views = currentViews();
  renderFilters(views);
  renderContent(views);
  renderStatus();
}

// --- toast --------------------------------------------------------------------

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

// --- favorites, recents, import/export ------------------------------------------

function toggleFavorite(key) {
  const view = currentViews().find((v) => v.key === key);
  const title = view?.title ?? 'This site';
  if (app.favorites.includes(key)) {
    app.favorites = app.favorites.filter((k) => k !== key);
    showToast(`Removed ${title} from favorites.`);
  } else {
    app.favorites = [...app.favorites, key];
    showToast(`Added ${title} to favorites.`);
  }
  saveFavorites();
  render();
}

let recentsDirty = false;
function noteOpened(key) {
  app.recents = recordRecent(app.recents, key, new Date().toISOString());
  saveRecents();
  // Re-render when the person comes back, so cards don't shift under the pointer.
  recentsDirty = true;
}

function localDateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function exportFavorites() {
  if (!app.favorites.length) {
    showToast('There are no favorites to export yet. Tap the star on a site first.');
    return;
  }
  const data = buildFavoritesExport(app.favorites, currentViews(), app.state, new Date().toISOString());
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const filename = `cleverzebra-library-favorites-${localDateStamp()}.json`;
  const file = new File([text], filename, { type: 'application/json' });

  // On a phone the share sheet can save the file to Files; elsewhere, download it.
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Cleverzebra Library favorites' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = el('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  showToast(`Saved ${plural(app.favorites.length, 'favorite')} to ${filename}.`);
}

function showImportMessage(title, message) {
  app.pendingImport = null;
  els.importTitle.textContent = title;
  els.importSummary.textContent = message;
  for (const button of els.importDialog.querySelectorAll('[data-import-choice]')) button.hidden = true;
  els.importDialog.querySelector('button[value="cancel"]').textContent = 'OK';
  els.importDialog.returnValue = '';
  els.importDialog.showModal();
}

async function handleImportFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    showImportMessage("Couldn’t import favorites", parseFavoritesImport('x'.repeat(MAX_IMPORT_BYTES + 1)).message);
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    showImportMessage("Couldn’t import favorites", "That file couldn’t be read.");
    return;
  }
  const parsed = parseFavoritesImport(text);
  if (!parsed.ok) {
    showImportMessage("Couldn’t import favorites", parsed.message);
    return;
  }
  const resolved = resolveImport(parsed.items, app.state);
  app.pendingImport = resolved;
  const parts = [`This file has ${plural(resolved.keys.length, 'favorite')}.`];
  if (resolved.unmatched) {
    parts.push(
      resolved.matched
        ? `${resolved.matched} match sites in this library. The other ${resolved.unmatched} will apply if those sites appear later.`
        : 'None of them match sites in this library yet. They will apply if those sites appear later.',
    );
  }
  if (parsed.skipped) parts.push(`${plural(parsed.skipped, 'entry', 'entries')} could not be read and will be skipped.`);
  els.importTitle.textContent = 'Import favorites';
  els.importSummary.textContent = parts.join(' ');
  for (const button of els.importDialog.querySelectorAll('[data-import-choice]')) button.hidden = false;
  els.importDialog.querySelector('button[value="cancel"]').textContent = 'Cancel';
  els.importDialog.returnValue = '';
  els.importDialog.showModal();
}

function finishImport(choice) {
  const pending = app.pendingImport;
  app.pendingImport = null;
  if (!pending || (choice !== 'add' && choice !== 'replace')) return;
  const before = new Set(app.favorites);
  app.favorites = combineFavorites(app.favorites, pending.keys, choice);
  saveFavorites();
  render();
  if (choice === 'replace') {
    showToast(`Your favorites now match the file (${plural(app.favorites.length, 'site')}).`);
  } else {
    const added = app.favorites.filter((k) => !before.has(k)).length;
    showToast(added ? `Added ${plural(added, 'favorite')}.` : 'Those favorites were already here.');
  }
}

// --- service worker and updates ---------------------------------------------------

let updateRequested = false;

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let registration;
  try {
    registration = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
  } catch (err) {
    console.warn('Offline support is unavailable', err);
    return;
  }
  const offerUpdate = () => {
    if (registration.waiting && navigator.serviceWorker.controller) els.update.hidden = false;
  };
  offerUpdate();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') offerUpdate();
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });
  els.updateBtn.addEventListener('click', () => {
    updateRequested = true;
    els.updateBtn.disabled = true;
    if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    // If the new version took over some other way, reload anyway.
    setTimeout(() => location.reload(), 3000);
  });

  let lastUpdateCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > 30 * 60 * 1000) {
      lastUpdateCheck = Date.now();
      registration.update().catch(() => {});
    }
  });

  const ready = await navigator.serviceWorker.ready;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    if (typeof event.data?.version === 'string') els.version.textContent = `Version ${event.data.version.slice(0, 12)}`;
  };
  ready.active?.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}

// --- events ---------------------------------------------------------------------

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function resetFinder({ focusSearch = true } = {}) {
  app.query = '';
  app.filter = 'all';
  els.search.value = '';
  render();
  if (focusSearch) els.search.focus();
}

function openMore(sectionId) {
  if (!els.moreDialog.open) els.moreDialog.showModal();
  if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ block: 'start' });
}

function bindEvents() {
  els.finder.addEventListener('submit', (event) => event.preventDefault());

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      app.query = els.search.value;
      render();
    }, 80);
  });
  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.search.value) {
      event.preventDefault();
      els.search.value = '';
      app.query = '';
      render();
    }
  });

  els.filters.addEventListener('change', (event) => {
    if (event.target?.name !== 'filter') return;
    app.filter = event.target.value;
    render();
  });

  els.reset.addEventListener('click', () => resetFinder());
  els.checkBtn.addEventListener('click', () => runCheck('manual'));

  els.content.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const fav = target?.closest('[data-fav]');
    if (fav) {
      toggleFavorite(fav.dataset.fav);
      return;
    }
    const open = target?.closest('[data-open]');
    if (open) {
      noteOpened(open.dataset.open);
      return;
    }
    if (target?.closest('[data-reset]')) {
      resetFinder();
      return;
    }
    if (target?.closest('[data-clear-recents]')) {
      app.recents = [];
      saveRecents();
      render();
      els.search.focus();
    }
  });
  // Middle-click opens a site in a new tab without a click event.
  els.content.addEventListener('auxclick', (event) => {
    const open = event.target instanceof Element ? event.target.closest('[data-open]') : null;
    if (open && event.button === 1) noteOpened(open.dataset.open);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target) || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    els.search.focus();
  });

  els.moreBtn.addEventListener('click', () => openMore());
  for (const button of document.querySelectorAll('[data-open-more]')) {
    button.addEventListener('click', () => openMore(button.dataset.openMore));
  }
  els.moreDialog.addEventListener('click', (event) => {
    // Clicking the dimmed backdrop closes the sheet.
    if (event.target === els.moreDialog) els.moreDialog.close();
    if (event.target instanceof Element && event.target.closest('[data-close]')) els.moreDialog.close();
  });
  els.exportBtn.addEventListener('click', () => exportFavorites());
  els.importBtn.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    els.importInput.value = '';
    if (!file) return;
    els.moreDialog.close();
    await handleImportFile(file);
  });
  els.importDialog.addEventListener('close', () => finishImport(els.importDialog.returnValue));

  window.addEventListener('storage', (event) => {
    if (event.key === store.KEYS.state) app.state = reviveState(store.read(store.KEYS.state));
    else if (event.key === store.KEYS.favorites) app.favorites = reviveKeyList(store.read(store.KEYS.favorites));
    else if (event.key === store.KEYS.recents) app.recents = reviveRecents(store.read(store.KEYS.recents));
    else return;
    render();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (recentsDirty) {
      recentsDirty = false;
      render();
    } else {
      renderStatus();
    }
    runCheck('resume');
  });
  window.addEventListener('online', () => {
    renderStatus();
    runCheck('online');
  });
  window.addEventListener('offline', renderStatus);

  // Keeps "today at ..." accurate and checks hourly while the window stays open.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    renderStatus();
    runCheck('timer');
  }, 60 * 1000);
}

async function start() {
  loadLocal();
  bindEvents();
  render();
  await loadBundled();
  app.ready = true;
  render();
  setupServiceWorker();
  runCheck('open');
}

start();
