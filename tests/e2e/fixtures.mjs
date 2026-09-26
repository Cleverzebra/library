import { test as base, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './server.mjs';
import { routeGitHub } from './github-routes.mjs';
import { starterRepos, publishedSites } from '../helpers/mock-github.mjs';

export { expect };

export const STATE_KEY = 'cleverzebra-library:v1:catalog';
export const FAVORITES_KEY = 'cleverzebra-library:v1:favorites';

export function defaultGitHub() {
  const repos = starterRepos();
  return { repos, sites: publishedSites(repos) };
}

export const test = base.extend({
  // Most tests don't need offline support; those that do opt back in.
  serviceWorkers: 'block',

  server: [
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  githubSpec: [defaultGitHub(), { option: true }],

  github: async ({ context, githubSpec }, use) => {
    await use(await routeGitHub(context, githubSpec));
  },

  library: async ({ page, server, github }, use, testInfo) => {
    const url = `${server.origin}/cleverzebra-library/`;
    const library = {
      url,
      github,
      cards: page.locator('#content .card'),
      status: page.locator('#status-text'),
      async open({ waitForCheck = true } = {}) {
        await page.goto(url);
        await expect(page.locator('#content .card').first()).toBeVisible();
        if (waitForCheck) await library.checkSettled();
      },
      async checkSettled() {
        await expect(page.locator('#status-text')).not.toHaveText(/^(Checking|Loading)/);
      },
      section(title) {
        return page.locator('section.shelf', { has: page.getByRole('heading', { name: title, exact: true }) });
      },
      card(title) {
        return page.locator('#content .card', { has: page.getByRole('heading', { name: title, exact: true }) });
      },
      async savedState() {
        return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STATE_KEY);
      },
      async screenshot(name, options = {}) {
        const dir = process.env.SCREENSHOT_DIR;
        if (!dir) return;
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, `${testInfo.project.name}-${name}.png`), ...options });
      },
    };
    await use(library);
  },
});
