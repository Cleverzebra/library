/* Cleverzebra Library service worker.

   It controls only this library's folder, caches only the library's own
   files, and names every cache and database with the library's prefix. It
   never deletes or reads caches that belong to the other Cleverzebra sites,
   which share the cleverzebra.github.io origin.

   Some sites on this origin delete every cache but their own when they
   update. To stay usable offline anyway, the library also keeps a copy of
   its files in its own IndexedDB database and rebuilds the cache from it. */

const VERSION = '231522730818';
const PREFIX = 'cleverzebra-library-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const DATA_CACHE = `${PREFIX}data`;
const DB_NAME = `${PREFIX}offline`;
const DB_STORE = 'files';

// The files the page needs to open offline. scripts/stamp.mjs hashes them
// into VERSION, and a test fails if a file is missing from this list.
// BEGIN SHELL FILES
const SHELL_FILES = [
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/catalog.js',
  'js/config.js',
  'js/discovery.js',
  'js/favorites.js',
  'js/format.js',
  'js/store.js',
  'icons/icon.svg',
  'icons/zebra.svg',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];
// END SHELL FILES

// Fetched fresh whenever possible, so edits to these files show up without
// a new version; the cached copy is used offline.
const DATA_FILES = ['data/catalog.json', 'data/overrides.json'];

const SCOPE = new URL(self.registration.scope);
const toUrl = (path) => new URL(path, SCOPE).href;
const SHELL_URLS = SHELL_FILES.map(toUrl);
const SHELL_SET = new Set(SHELL_URLS);
const DATA_SET = new Set(DATA_FILES.map(toUrl));
const INDEX_URL = toUrl('index.html');

// --- IndexedDB copy of the shell -------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function mirrorPut(entries) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      for (const entry of entries) store.put({ type: entry.type, body: entry.body }, entry.key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function mirrorGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function mirrorPruneOtherVersions() {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const cursorRequest = tx.objectStore(DB_STORE).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!String(cursor.key).startsWith(`${VERSION}|`)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const mirrorKey = (url) => `${VERSION}|${url}`;

function responseFromMirror(record) {
  return new Response(record.body, { headers: record.type ? { 'Content-Type': record.type } : {} });
}

let repairing = null;

// Rebuilds a missing cache from the IndexedDB copy (same version, no network).
function repairShell() {
  repairing ??= (async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const url of SHELL_URLS) {
      if (await cache.match(url)) continue;
      const record = await mirrorGet(mirrorKey(url));
      if (record) await cache.put(url, responseFromMirror(record));
    }
  })()
    .catch(() => {})
    .finally(() => {
      repairing = null;
    });
  return repairing;
}

// --- lifecycle -----------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const entries = await Promise.all(
        SHELL_URLS.map(async (url) => {
          const res = await fetch(url, { cache: 'reload' });
          if (!res.ok) throw new Error(`Could not cache ${url}: ${res.status}`);
          await cache.put(url, res.clone());
          return { key: mirrorKey(url), type: res.headers.get('content-type') || '', body: await res.arrayBuffer() };
        }),
      );
      try {
        await mirrorPut(entries);
      } catch {
        // The copy is a safeguard; the cache alone still works.
      }
      const dataCache = await caches.open(DATA_CACHE);
      await Promise.all(
        DATA_FILES.map(async (path) => {
          try {
            const res = await fetch(toUrl(path), { cache: 'reload' });
            if (res.ok) await dataCache.put(toUrl(path), res);
          } catch {
            // Fetched again when the page asks for it.
          }
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only this library's older caches. Other sites' caches are never touched.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX) && name !== SHELL_CACHE && name !== DATA_CACHE)
          .map((name) => caches.delete(name)),
      );
      try {
        await mirrorPruneOtherVersions();
      } catch {
        // Harmless if it fails; old copies are small.
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  else if (event.data?.type === 'GET_VERSION') event.ports?.[0]?.postMessage({ version: VERSION });
});

// --- requests ------------------------------------------------------------------------

const OFFLINE_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cleverzebra Library</title><body style="margin:0;background:#f8f3e9;color:#221f1b;font:16px/1.5 -apple-system,system-ui,sans-serif"><main style="max-width:520px;margin:15vh auto;padding:0 24px"><h1 style="font-family:Georgia,serif;font-weight:600">The library isn't available offline right now</h1><p>Connect to the internet and open it again. After that it will open without a connection.</p></main></body></html>`;

async function serveShell(event, url) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(url);
  if (hit) return hit;
  // The cache is missing, perhaps cleared by another site on this origin.
  try {
    const record = await mirrorGet(mirrorKey(url));
    if (record) {
      event.waitUntil(repairShell());
      return responseFromMirror(record);
    }
  } catch {
    // Fall through to the network.
  }
  try {
    return await fetch(event.request.mode === 'navigate' ? url : event.request);
  } catch {
    if (event.request.mode === 'navigate') {
      return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return Response.error();
  }
}

async function serveData(event, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(DATA_CACHE).then((cache) => cache.put(url, copy)));
    }
    return res;
  } catch {
    const cached = await (await caches.open(DATA_CACHE)).match(url);
    return cached ?? Response.error();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Requests outside this library (other sites, GitHub) go to the network untouched.
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  url.search = '';
  url.hash = '';
  const key = url.href;

  if (request.mode === 'navigate') {
    if (url.pathname === SCOPE.pathname || key === INDEX_URL) event.respondWith(serveShell(event, INDEX_URL));
    return;
  }
  if (SHELL_SET.has(key)) event.respondWith(serveShell(event, key));
  else if (DATA_SET.has(key)) event.respondWith(serveData(event, key));
});
