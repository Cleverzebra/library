import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, STATE_KEY, FAVORITES_KEY, defaultGitHub } from './fixtures.mjs';
import { repo, pagesUrl, starterRepos, publishedSites, rateLimitedResponse, jsonResponse } from '../helpers/mock-github.mjs';

const TITLES = {
  Gardens: ['Groundwork', 'Julia’s Garden Year'],
  'Local Guides': [
    'Boston',
    'Sofia & Bandit’s Somerville',
    'Asheville & Highlands',
    'Carl & Stuart’s Asheville',
    'Torquay & the Surf Coast',
    'Natick & MetroWest',
  ],
  Monhegan: ['Monhegan Island Resource Library', 'Magnolia House Guest Guide', 'Water Conservation Calculator'],
  Family: ['Gwyn’s College HQ', 'Gwyn’s Babysitting & Tutoring'],
};

test.describe('layout and links', () => {
  test('shows the 13 starter sites by category, each linking to its own site', async ({ page, library }) => {
    await library.open();
    await expect(library.cards).toHaveCount(13);
    for (const [category, titles] of Object.entries(TITLES)) {
      const section = library.section(category);
      await expect(section.getByRole('heading', { level: 3 })).toHaveText(titles);
    }
    const links = page.locator('#content a.open-link');
    await expect(links).toHaveCount(13);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute('href', /^https:\/\/cleverzebra\.github\.io\/[a-z0-9-]+\/$/);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener');
    }
    await expect(library.card('Boston').locator('a.open-link')).toHaveAttribute('href', 'https://cleverzebra.github.io/boston-local-guide/');
    // No iframes: the library links to the sites and never embeds them.
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(library.status).toHaveText(/^Last checked for new sites today at .+\. No new sites\.$/);
    await library.screenshot('home', { fullPage: true });
  });

  test('fits the screen with no sideways scrolling and roomy touch targets', async ({ page, library }) => {
    await library.open();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button:not([hidden]), a.open-link, .chip-face, input#search')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ label: el.textContent.trim() || el.getAttribute('aria-label'), h: el.getBoundingClientRect().height }))
        .filter((t) => t.h < 44),
    );
    expect(small).toEqual([]);
  });

  test('opening a site records it under Recently opened', async ({ page, library, context }) => {
    await library.open();
    const [popup] = await Promise.all([context.waitForEvent('page'), library.card('Groundwork').locator('a.open-link').click()]);
    await popup.close();
    await page.bringToFront();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.recent-link')).toHaveText(['Groundwork']);
    await page.reload();
    await expect(page.locator('.recent-link')).toHaveText(['Groundwork']);
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('.recent')).toHaveCount(0);
  });
});

test.describe('search and filters', () => {
  test('search covers titles, descriptions, and tags, with a clear empty state', async ({ page, library }) => {
    await library.open();
    const search = page.getByRole('searchbox', { name: 'Search the library' });
    await search.fill('aquifer');
    await expect(library.cards).toHaveCount(1);
    await expect(library.cards.getByRole('heading')).toHaveText('Water Conservation Calculator');

    await search.fill('pickleball');
    await expect(library.cards.getByRole('heading')).toHaveText(['Boston']);

    await search.fill('julia’s garden');
    await expect(library.cards.getByRole('heading')).toHaveText(['Julia’s Garden Year']);

    await search.fill('monhegan');
    await expect(library.cards.first().getByRole('heading')).toHaveText('Monhegan Island Resource Library');

    await search.fill('zzqx');
    await expect(library.cards).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No sites match “zzqx”.' })).toBeVisible();
    await expect(page.getByText('not at the pages inside each site')).toBeVisible();
    await library.screenshot('search-empty');
    await page.locator('#content').getByRole('button', { name: 'Reset search and filters' }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(library.cards).toHaveCount(13);
  });

  test('category filters narrow the list and reset brings everything back', async ({ page, library }) => {
    await library.open();
    const reset = page.locator('#reset');
    await expect(reset).toBeHidden();
    await page.locator('.chip', { hasText: 'Monhegan' }).click();
    await expect(library.cards).toHaveCount(3);
    await expect(page.locator('#content h2')).toHaveText(['Monhegan']);
    await expect(reset).toBeVisible();

    await page.getByRole('searchbox').fill('water');
    await expect(library.cards.getByRole('heading')).toHaveText(['Magnolia House Guest Guide', 'Water Conservation Calculator'].reverse());

    await reset.click();
    await expect(library.cards).toHaveCount(13);
    await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
    await expect(reset).toBeHidden();
  });

  test('keyboard: slash focuses search, Escape clears it, arrows move between filters', async ({ page, library }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'keyboard shortcuts are for desktop');
    await library.open();
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.type('boston');
    await expect(library.cards).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await expect(library.cards).toHaveCount(13);

    await page.getByRole('radio', { name: 'All' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Favorites' })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Gardens' })).toBeChecked();
    await expect(library.cards).toHaveCount(2);

    // The skip link is the first stop and lands on the list.
    await page.keyboard.press('Escape');
    await page.goto(library.url);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to the sites' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#content')).toBeFocused();
  });
});

test.describe('favorites', () => {
  test('favorites persist across reloads and catalog refreshes', async ({ page, library }) => {
    await library.open();
    const star = library.section('Gardens').getByRole('button', { name: 'Favorite Groundwork' });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Added Groundwork to favorites.' })).toBeVisible();
    await expect(library.section('Favorites').locator('.card')).toHaveCount(1);
    await expect(library.section('Favorites').getByRole('button', { name: 'Favorite Groundwork' })).toHaveAttribute('aria-pressed', 'true');

    // Stored under the library's own key, by permanent repository id.
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), FAVORITES_KEY);
    expect(saved).toEqual(['repo:5000']);

    await page.reload();
    await library.checkSettled();
    await expect(library.section('Favorites').locator('.card')).toHaveCount(1);

    // A refresh that finds a new site leaves favorites alone.
    const repos = [...starterRepos(), repo(9001, 'garden-planner')];
    library.github.set({ repos, sites: publishedSites(repos) });
    await page.getByRole('button', { name: 'Check for new sites' }).click();
    await expect(library.status).toHaveText(/Found 1 new site: Garden Planner\./);
    await expect(library.section('Favorites').locator('.card')).toHaveCount(1);
    await expect(library.section('Favorites').locator('.card-title')).toHaveText('Groundwork');

    await page.getByRole('radio', { name: 'Favorites' }).check();
    await expect(library.cards).toHaveCount(1);
  });

  test('a favorite chosen before the first check survives the switch to permanent ids', async ({ page, library, context }) => {
    // Start with GitHub unreachable, so the library shows only its starter list.
    library.github.set({ onList: () => jsonResponse({ message: 'down' }, 503) });
    await library.open();
    await expect(library.status).toHaveText(/^Couldn’t check for new sites/);
    await library.card('Boston').getByRole('button', { name: 'Favorite Boston' }).click();
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), FAVORITES_KEY)).toEqual(['name:boston-local-guide']);

    library.github.set(defaultGitHub());
    await page.getByRole('button', { name: 'Check for new sites' }).click();
    await expect(library.status).toHaveText(/^Last checked for new sites/);
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), FAVORITES_KEY)).toEqual(['repo:5002']);
    await expect(library.section('Favorites').locator('.card-title')).toHaveText('Boston');
  });

  test('export and import favorites, with validation', async ({ page, library }) => {
    await library.open();
    await library.card('Groundwork').getByRole('button', { name: /^Favorite / }).click();
    await library.card('Boston').getByRole('button', { name: /^Favorite / }).click();

    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('dialog', { name: 'Library options' })).toBeVisible();
    await library.screenshot('options');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export favorites' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^cleverzebra-library-favorites-\d{4}-\d{2}-\d{2}\.json$/);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect(exported.format).toBe('cleverzebra-library-favorites');
    expect(exported.favorites).toEqual([
      { key: 'repo:5000', name: 'groundwork', title: 'Groundwork' },
      { key: 'repo:5002', name: 'boston-local-guide', title: 'Boston' },
    ]);
    await page.keyboard.press('Escape');

    // Clear favorites, then import the file with a site this device hasn't seen yet.
    await page.evaluate((key) => localStorage.setItem(key, '[]'), FAVORITES_KEY);
    await page.reload();
    await library.checkSettled();
    await expect(library.section('Favorites')).toHaveCount(0);
    const file = { ...exported, favorites: [...exported.favorites, { key: 'repo:777', name: 'future-site' }] };
    await page.locator('#import-input').setInputFiles({ name: 'favs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    const dialog = page.getByRole('dialog', { name: 'Import favorites' });
    await expect(dialog).toContainText('This file has 3 favorites. 2 match sites in this library. The other 1 will apply if those sites appear later.');
    await library.screenshot('import');
    await dialog.getByRole('button', { name: 'Add to my favorites' }).click();
    await expect(library.section('Favorites').locator('.card-title')).toHaveText(['Groundwork', 'Boston']);

    // Pressing Escape later must not repeat the last choice.
    await page.locator('#import-input').setInputFiles({ name: 'favs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Files that aren't favorites exports are refused with a reason.
    for (const [content, message] of [
      ['{not json', "That file isn’t a favorites file. It isn’t valid JSON."],
      [JSON.stringify({ hello: 'world' }), "That file isn’t a Cleverzebra Library favorites file."],
    ]) {
      await page.locator('#import-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(content) });
      const error = page.getByRole('dialog', { name: "Couldn’t import favorites" });
      await expect(error).toContainText(message);
      await error.getByRole('button', { name: 'OK' }).click();
    }
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), FAVORITES_KEY)).toEqual(['repo:5000', 'repo:5002', 'repo:777']);
  });
});

test.describe('discovery', () => {
  test('a newly published repository appears on its own, marked Recently added, in Other', async ({ page, library }) => {
    await library.open();
    await expect(library.cards).toHaveCount(13);
    const calls = () => library.github.calls.filter((c) => c.url.includes('/users/Cleverzebra/repos')).length;
    expect(calls()).toBe(1);

    // Reopening within the hour doesn’t ask GitHub again.
    await page.reload();
    await expect(library.cards).toHaveCount(13);
    await page.waitForTimeout(500);
    expect(calls()).toBe(1);

    // A new site is published; an hour passes; the library is opened again.
    const repos = [...starterRepos(), repo(9001, 'garden-planner', { description: 'Plan the vegetable beds by week.' })];
    library.github.set({ repos, sites: publishedSites(repos) });
    await page.evaluate((key) => {
      const state = JSON.parse(localStorage.getItem(key));
      state.checks.lastSuccessAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      localStorage.setItem(key, JSON.stringify(state));
    }, STATE_KEY);
    await page.reload();
    await expect(library.status).toHaveText(/Found 1 new site: Garden Planner\./);
    const card = library.section('Other').locator('.card');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading')).toHaveText('Garden Planner');
    await expect(card.locator('.new-badge')).toHaveText('Recently added');
    await expect(card.locator('.card-desc')).toHaveText('Plan the vegetable beds by week.');
    await expect(card.locator('a.open-link')).toHaveAttribute('href', pagesUrl('garden-planner'));
    await expect(page.locator('.new-badge')).toHaveCount(1);
    await library.screenshot('new-site', { fullPage: true });
  });

  test('a repository without a description gets a neutral one', async ({ library, githubSpec }) => {
    const repos = [...githubSpec.repos, repo(9002, 'recipe-box')];
    library.github.set({ repos, sites: publishedSites(repos) });
    await library.open();
    await expect(library.card('Recipe Box').locator('.card-desc')).toHaveText('No description yet.');
  });

  test('unpublished repositories and the library itself are left out', async ({ library }) => {
    const repos = [
      ...starterRepos(),
      repo(9101, 'draft-site'), // Pages turned on, but nothing published: 404
      repo(9102, 'notes', { has_pages: false }),
      repo(9103, 'old-homepage', { has_pages: false, homepage: 'https://cleverzebra.github.io/old-homepage/' }),
      repo(1388362103, 'library'),
    ];
    const sites = { ...publishedSites(starterRepos()), [pagesUrl('library')]: 200, [pagesUrl('old-homepage')]: 200 };
    library.github.set({ repos, sites });
    await library.open();
    await expect(library.cards).toHaveCount(13);
    await expect(library.status).toHaveText(/No new sites\./);
    const titles = await library.cards.getByRole('heading').allTextContents();
    expect(titles).not.toContain('Draft Site');
    expect(titles).not.toContain('Notes');
    expect(titles).not.toContain('Library');
  });

  test('finds sites on later pages of the repository list', async ({ library }) => {
    const filler = Array.from({ length: 140 }, (_, i) => repo(20000 + i, `archive-${i}`, { has_pages: false }));
    const late = repo(30000, 'zz-late-site', { description: 'Listed on page two.' });
    const repos = [...starterRepos(), ...filler, late];
    library.github.set({ repos, sites: publishedSites(repos) });
    await library.open();
    await expect(library.card('Zz Late Site')).toBeVisible();
    expect(library.github.calls.filter((c) => c.url.includes('/users/Cleverzebra/repos')).length).toBe(2);
  });

  test('when GitHub is rate limited, the saved library stays and the page says when it will retry', async ({ page, library }) => {
    await library.open();
    await expect(library.cards).toHaveCount(13);
    const reset = Math.floor(Date.now() / 1000) + 45 * 60;
    library.github.set({ onList: () => rateLimitedResponse(reset) });
    await page.getByRole('button', { name: 'Check for new sites' }).click();
    await expect(library.status).toHaveText(/^Couldn’t check for new sites \(GitHub asked the library to wait until .+\)\. Showing your saved library, last checked today at .+\.$/);
    await expect(library.cards).toHaveCount(13);
    await library.screenshot('rate-limited');

    // Asking again before the reset time doesn’t call GitHub.
    const before = library.github.calls.length;
    await page.getByRole('button', { name: 'Check for new sites' }).click();
    await expect(page.locator('#toast')).toContainText('GitHub asked the library to wait until');
    expect(library.github.calls.length).toBe(before);

    await page.reload();
    await expect(library.cards).toHaveCount(13);
    await expect(library.status).toHaveText(/^Couldn’t check for new sites/);
  });

  test('a GitHub outage or a broken answer never removes saved sites', async ({ page, library }) => {
    await library.open();
    for (const onList of [
      () => jsonResponse({ message: 'Server Error' }, 500),
      () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => jsonResponse([], 200),
    ]) {
      library.github.set({ onList });
      await page.getByRole('button', { name: 'Check for new sites' }).click();
      await library.checkSettled();
      await expect(library.cards).toHaveCount(13);
    }
    await expect(library.status).toHaveText(/didn’t finish|Couldn’t check/);
  });

  test('a site is removed only after two complete checks confirm it is gone', async ({ page, library }) => {
    await library.open();
    const repos = starterRepos().filter((r) => r.name !== 'watercalculator');
    library.github.set({ repos, sites: publishedSites(repos) });
    await page.getByRole('button', { name: 'Check for new sites' }).click();
    await library.checkSettled();
    await expect(library.card('Water Conservation Calculator')).toBeVisible();
    await page.getByRole('button', { name: 'Check for new sites' }).click();
    await library.checkSettled();
    await expect(library.card('Water Conservation Calculator')).toHaveCount(0);
    await expect(library.cards).toHaveCount(12);
  });
});

test.describe('app behavior', () => {
  test('the footer link opens the Dock and Home Screen instructions', async ({ page, library }) => {
    await library.open();
    await page.getByRole('button', { name: 'Add to your Dock or Home Screen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Library options' });
    await expect(dialog.getByRole('heading', { name: 'Add to your Dock or Home Screen' })).toBeInViewport();
    await expect(dialog).toContainText('File > Add to Dock');
    await expect(dialog).toContainText('Add to Home Screen');
    await expect(dialog).toContainText('keep their own favorites, separate from Safari');
    await library.screenshot('install-help');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a second open window picks up favorites changed in the first', async ({ page, context, library }) => {
    await library.open();
    const second = await context.newPage();
    await second.goto(library.url);
    await expect(second.locator('#content .card').first()).toBeVisible();
    await library.card('Natick & MetroWest').getByRole('button', { name: /^Favorite / }).click();
    await expect(second.locator('section.shelf').first().locator('.card-title')).toHaveText(['Natick & MetroWest']);
  });

  test('the manifest and icons are in place for installing', async ({ page, library }) => {
    await library.open();
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
    expect(manifest).toMatchObject({ name: 'Cleverzebra Library', short_name: 'Library', display: 'standalone', start_url: './', scope: './' });
    for (const href of await page.locator('link[rel~=icon], link[rel=apple-touch-icon]').evaluateAll((links) => links.map((l) => l.href))) {
      const status = await page.evaluate(async (url) => (await fetch(url)).status, href);
      expect(status, href).toBe(200);
    }
  });
});

test.describe('accessibility', () => {
  test('no automated accessibility violations on the main view and dialogs', async ({ page, library }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one run is enough');
    await library.open();
    await library.card('Groundwork').getByRole('button', { name: /^Favorite / }).click();
    const scan = async () =>
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      );
    expect(await scan()).toEqual([]);
    await page.getByRole('button', { name: 'More' }).click();
    expect(await scan()).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('searchbox').fill('nothing-matches-this');
    expect(await scan()).toEqual([]);
  });
});
