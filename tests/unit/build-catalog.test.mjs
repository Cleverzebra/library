import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalog, catalogSignature } from '../../scripts/build-catalog.mjs';
import { mockGitHub, jsonResponse, starterRepos, publishedSites, repo, rateLimitedResponse } from '../helpers/mock-github.mjs';

const committed = JSON.parse(readFileSync(new URL('../../docs/data/catalog.json', import.meta.url)));
const PAGES_URL = 'https://cleverzebra.github.io/library/';
const NOW = Date.parse('2026-10-01T12:00:00Z');

// The fake GitHub plus this repository's Pages settings and published catalog.
function world({ buildType = 'workflow', live = null, ...spec } = {}) {
  const gh = mockGitHub(spec);
  const calls = [];
  async function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, headers: init.headers ?? {} });
    if (url === 'https://api.github.com/repos/Cleverzebra/library/pages') {
      return buildType ? jsonResponse({ build_type: buildType, html_url: PAGES_URL, status: 'built' }) : jsonResponse({ message: 'Not Found' }, 404);
    }
    if (url === `${PAGES_URL}data/catalog.json`) return live ? jsonResponse(live) : new Response('Not found', { status: 404 });
    return gh.fetch(input, init);
  }
  return { fetch, calls };
}

const env = (event) => ({ GITHUB_TOKEN: 'built-in-token', GITHUB_REPOSITORY: 'Cleverzebra/library', LIBRARY_REPO_ID: '1388362103', EVENT_NAME: event });
const run = (w, event = 'schedule') => buildCatalog({ fetch: w.fetch, env: env(event), now: () => NOW, readCommittedCatalog: () => committed });

test('does nothing when Pages deploys from a branch or is off', async () => {
  const branch = await run(world({ buildType: 'legacy' }));
  assert.equal(branch.deploy, false);
  assert.match(branch.reason, /from a branch/);
  const off = await run(world({ buildType: null }));
  assert.equal(off.deploy, false);
  assert.match(off.reason, /not turned on/);
});

test('the first run starts from the starter list and publishes', async () => {
  const repos = [...starterRepos(), repo(1388362103, 'library')];
  const outcome = await run(world({ repos, sites: publishedSites(repos) }));
  assert.equal(outcome.outcome, 'complete');
  assert.equal(outcome.deploy, true);
  assert.equal(outcome.snapshot.generatedBy, 'workflow');
  assert.equal(outcome.snapshot.sites.length, 13, 'the library itself is excluded');
  assert.ok(outcome.snapshot.sites.every((s) => Number.isInteger(s.repoId) && s.baseline));
});

test('a scheduled run publishes only when the catalog changes', async () => {
  const repos = starterRepos();
  const first = await run(world({ repos, sites: publishedSites(repos) }));
  const same = await run(world({ repos, sites: publishedSites(repos), live: first.snapshot }));
  assert.equal(same.changed, false);
  assert.equal(same.deploy, false);

  const more = [...repos, repo(9001, 'garden-planner')];
  const changed = await run(world({ repos: more, sites: publishedSites(more), live: first.snapshot }));
  assert.equal(changed.changed, true);
  assert.equal(changed.deploy, true);
  const planner = changed.snapshot.sites.find((s) => s.name === 'garden-planner');
  assert.equal(planner.firstSeen, new Date(NOW).toISOString());
  assert.equal(planner.baseline, false);
});

test('a push always publishes, keeping the saved catalog if GitHub is unavailable', async () => {
  const repos = starterRepos();
  const first = await run(world({ repos, sites: publishedSites(repos) }));
  const limited = world({ onList: () => rateLimitedResponse(Math.floor(NOW / 1000) + 600), live: first.snapshot });
  const scheduled = await run(limited, 'schedule');
  assert.equal(scheduled.outcome, 'failed');
  assert.equal(scheduled.deploy, false);
  const pushed = await run(limited, 'push');
  assert.equal(pushed.deploy, true);
  assert.equal(pushed.snapshot.sites.length, 13);
});

test('a missed site is carried between runs and removed on the second miss', async () => {
  const repos = starterRepos();
  const first = await run(world({ repos, sites: publishedSites(repos) }));
  const fewer = repos.filter((r) => r.name !== 'watercalculator');
  const second = await run(world({ repos: fewer, sites: publishedSites(fewer), live: first.snapshot }));
  assert.equal(second.deploy, true, 'a new miss count must be published so the next run sees it');
  assert.equal(second.snapshot.sites.find((s) => s.name === 'watercalculator').misses, 1);
  const third = await run(world({ repos: fewer, sites: publishedSites(fewer), live: second.snapshot }));
  assert.ok(!third.snapshot.sites.some((s) => s.name === 'watercalculator'));
  // The starter list must not bring it back on later runs.
  const fourth = await run(world({ repos: fewer, sites: publishedSites(fewer), live: third.snapshot }));
  assert.ok(!fourth.snapshot.sites.some((s) => s.name === 'watercalculator'));
  assert.equal(fourth.changed, false);
});

test('the token goes only to api.github.com', async () => {
  const repos = starterRepos();
  const w = world({ repos, sites: publishedSites(repos) });
  await run(w);
  for (const call of w.calls) {
    const host = new URL(call.url).hostname;
    const sent = Boolean(call.headers.Authorization);
    assert.equal(sent, host === 'api.github.com', `${call.url} ${sent ? 'got' : 'did not get'} the token`);
  }
});

test('the catalog signature ignores check times', () => {
  const a = { sites: [{ repoId: 1, name: 'a', url: 'https://x/', lastConfirmed: '2026-01-01T00:00:00Z' }] };
  const b = { sites: [{ repoId: 1, name: 'a', url: 'https://x/', lastConfirmed: '2026-02-01T00:00:00Z' }] };
  assert.equal(catalogSignature(a), catalogSignature(b));
});
