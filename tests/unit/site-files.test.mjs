import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, readShellFiles, readVersion, SW_PATH, DOCS_DIR } from '../../scripts/stamp.mjs';
import { normalizeOverrides, reviveSnapshot } from '../../docs/js/catalog.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sw = readFileSync(SW_PATH, 'utf8');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('the service worker version matches the files it caches (run npm run stamp if this fails)', () => {
  assert.equal(readVersion(sw), computeVersion(sw));
});

test('every file the page needs offline is cached, and every cached file exists', () => {
  const shell = new Set(readShellFiles(sw));
  for (const file of shell) assert.ok(existsSync(join(DOCS_DIR, file)), `${file} is listed but missing`);
  const needed = walk(DOCS_DIR)
    .map((p) => relative(DOCS_DIR, p).split('\\').join('/'))
    .filter((p) => !p.startsWith('data/') && p !== 'sw.js' && !p.startsWith('.'));
  for (const file of needed) assert.ok(shell.has(file), `${file} is not in SHELL_FILES, so it would be missing offline`);
});

test('the service worker only ever deletes caches with the library prefix', () => {
  assert.match(sw, /const PREFIX = 'cleverzebra-library-';/);
  const deletes = [...sw.matchAll(/caches\.delete\(/g)];
  assert.equal(deletes.length, 1);
  assert.match(sw, /name\.startsWith\(PREFIX\) && name !== SHELL_CACHE && name !== DATA_CACHE/);
  assert.doesNotMatch(sw, /getRegistrations|unregister|localStorage|deleteDatabase/);
});

test('paths are relative, so the library works under any repository name', () => {
  const html = readFileSync(join(DOCS_DIR, 'index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(DOCS_DIR, 'manifest.webmanifest'), 'utf8'));
  for (const [, attr] of html.matchAll(/\s(?:href|src)="([^"#][^"]*)"/g)) {
    assert.ok(!attr.startsWith('/') && !/^https?:/.test(attr), `absolute path in index.html: ${attr}`);
  }
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) assert.ok(existsSync(join(DOCS_DIR, icon.src)), icon.src);
});

test('storage keys and cache names carry the library prefix', () => {
  const config = readFileSync(join(DOCS_DIR, 'js/config.js'), 'utf8');
  assert.match(config, /storagePrefix: 'cleverzebra-library:v1:'/);
  const store = readFileSync(join(DOCS_DIR, 'js/store.js'), 'utf8');
  assert.doesNotMatch(store, /localStorage\.clear|removeItem\((?!probe)/);
});

test('the starter catalog and overrides describe the same 13 sites', () => {
  const catalog = reviveSnapshot(JSON.parse(readFileSync(join(DOCS_DIR, 'data/catalog.json'), 'utf8')));
  const raw = JSON.parse(readFileSync(join(DOCS_DIR, 'data/overrides.json'), 'utf8'));
  const overrides = normalizeOverrides(raw);
  assert.equal(catalog.sites.length, 13);
  assert.deepEqual(catalog.sites.map((s) => s.name).sort(), Object.keys(raw.sites).sort());
  for (const [name, o] of overrides.byName) {
    assert.ok(o.title && o.description, `${name} needs a title and description`);
    assert.ok(overrides.categories.includes(o.category), `${name} has an unknown category`);
    assert.ok(o.description.length <= 150, `${name}: description is ${o.description.length} characters`);
  }
  for (const site of catalog.sites) assert.equal(site.url, `https://cleverzebra.github.io/${site.name}/`);
});

test('user-facing text uses no em dashes', () => {
  const files = [...walk(DOCS_DIR).filter((p) => /\.(html|js|json|css|webmanifest)$/.test(p)), join(ROOT, 'README.md')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    assert.ok(!readFileSync(file, 'utf8').includes('\u2014'), `${relative(ROOT, file)} contains an em dash`);
  }
});
