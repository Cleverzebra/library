import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.mjs';
import { startServer, DOCS_DIR } from './server.mjs';

test.use({ serviceWorkers: 'allow' });

// Resolves once this page is controlled by a fully activated service worker.
async function waitForOfflineReady(page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    const worker = registration.active;
    if (worker.state !== 'activated') {
      await new Promise((resolve) => worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()));
    }
  });
}

test('works offline from the saved copy, and leaves other sites’ data alone', async ({ page, context, server, library }) => {
  // Another Cleverzebra site on the same origin has its own cache and storage.
  await page.goto(`${server.origin}/sofia-somerville-guide/`);
  await page.evaluate(async () => {
    const cache = await caches.open('sb-somerville-v3');
    await cache.put('/sofia-somerville-guide/', new Response('Sofia'));
    localStorage.setItem('gw_zone', '"6b"');
  });

  await library.open();
  await waitForOfflineReady(page);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
  expect(scope).toBe(`${server.origin}/cleverzebra-library/`);
  const caches1 = await page.evaluate(() => caches.keys());
  expect(caches1).toContain('sb-somerville-v3');
  expect(caches1.filter((n) => n !== 'sb-somerville-v3').every((n) => n.startsWith('cleverzebra-library-'))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('gw_zone'))).toBe('"6b"');
  const ownKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'gw_zone'));
  expect(ownKeys.every((k) => k.startsWith('cleverzebra-library:v1:'))).toBe(true);

  // Offline: the page and its saved catalog load from this device.
  await context.setOffline(true);
  await page.reload();
  await expect(library.cards).toHaveCount(13);
  await expect(page.locator('#offline-banner')).toBeVisible();
  await expect(page.locator('#offline-banner')).toContainText('The sites themselves may need an internet connection');
  await expect(library.status).toHaveText(/^Last checked for new sites today at/);
  await library.screenshot('offline');

  // Checking while offline explains itself instead of failing silently.
  await page.getByRole('button', { name: 'Check for new sites' }).click();
  await expect(page.locator('#toast')).toContainText("You’re offline");
});

test('still opens offline after another site on this origin deletes every cache', async ({ page, context, library }) => {
  await library.open();
  await waitForOfflineReady(page);

  // What the Sofia & Bandit site's service worker does when it updates.
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
  });
  expect(await page.evaluate(() => caches.keys())).toEqual([]);

  await context.setOffline(true);
  await page.reload();
  await expect(library.cards).toHaveCount(13);
  await expect(page.locator('.brand-mark')).toHaveJSProperty('complete', true);
  expect(await page.locator('.brand-mark').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

  // The library rebuilds its own cache from its backup copy.
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((n) => n.startsWith('cleverzebra-library-shell-')))).toBe(true);
});

test('a new version shows a Reload prompt and takes over when chosen', async ({ page, library, server }) => {
  const root = mkdtempSync(join(tmpdir(), 'library-'));
  cpSync(DOCS_DIR, root, { recursive: true });
  server.setRoot('/cleverzebra-library/', root);
  try {
    await library.open();
    await waitForOfflineReady(page);
    const version = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (e) => resolve(e.data.version);
            navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
          }),
      );
    const before = await version();

    // Publish a new version: same files, new service worker version.
    const swPath = join(root, 'sw.js');
    writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/const VERSION = '[0-9a-f]+';/, "const VERSION = 'abcdef123456';"));
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    const banner = page.locator('#update-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('A new version of the library is ready.');
    await library.screenshot('update');

    await Promise.all([page.waitForEvent('load'), banner.getByRole('button', { name: 'Reload' }).click()]);
    await waitForOfflineReady(page);
    expect(before).not.toBe('abcdef123456');
    expect(await version()).toBe('abcdef123456');
    await expect(page.locator('#update-banner')).toBeHidden();
    // Old caches from this library are cleaned up; nothing else is.
    const names = await page.evaluate(() => caches.keys());
    expect(names.filter((n) => n.startsWith('cleverzebra-library-shell-'))).toEqual(['cleverzebra-library-shell-abcdef123456']);
  } finally {
    server.setRoot('/cleverzebra-library/', DOCS_DIR);
  }
});

test('runs under the current repository name (/library/) as well', async ({ browser, github }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one run is enough');
  const server = await startServer({ mounts: { '/library/': DOCS_DIR } });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    await context.route(/^https:\/\/(api\.github\.com|cleverzebra\.github\.io)\//, (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`${server.origin}/library`);
    expect(page.url()).toBe(`${server.origin}/library/`);
    await expect(page.locator('#content .card')).toHaveCount(13);
    await page.evaluate(() => navigator.serviceWorker.ready);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope)).toBe(`${server.origin}/library/`);
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      const res = await fetch(link.href);
      const json = await res.json();
      return { start: new URL(json.start_url, link.href).href, scope: new URL(json.scope, link.href).href };
    });
    expect(manifest).toEqual({ start: `${server.origin}/library/`, scope: `${server.origin}/library/` });
  } finally {
    await context.close();
    await server.close();
  }
});
