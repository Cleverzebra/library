import { defineConfig, devices } from '@playwright/test';

// Browser tests run in Chromium (the browser available in CI and in the
// Claude Code environment). Safari-specific behavior, such as Add to Dock,
// still needs a check on a Mac and an iPhone; see the README.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 2,
  reporter: [['list']],
  use: {
    trace: 'off',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
      },
    },
  ],
});
