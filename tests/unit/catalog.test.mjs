import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discover } from '../../docs/js/discovery.js';
import {
  emptyState,
  reviveState,
  reviveSnapshot,
  mergeSnapshot,
  mergeDiscovery,
  isCheckDue,
  stateToSnapshot,
  normalizeOverrides,
  viewSites,
  titleFromName,
  searchViews,
  findEntry,
  FALLBACK_DESCRIPTION,
} from '../../docs/js/catalog.js';
import { OWNER, repo, pagesUrl, mockGitHub, starterRepos, publishedSites, rateLimitedResponse, jsonResponse } from '../helpers/mock-github.mjs';

const seed = reviveSnapshot(JSON.parse(readFileSync(new URL('../../docs/data/catalog.json', import.meta.url))));
const overrides = normalizeOverrides(JSON.parse(readFileSync(new URL('../../docs/data/overrides.json', import.meta.url))));

const T0 = '2026-09-26T15:00:00.000Z';
const hours = (n, from = T0) => new Date(Date.parse(from) + n * 3600e3).toISOString();
const days = (n, from = T0) => hours(24 * n, from);

async function check(state, gh, at = T0) {
  const result = await discover({
    owner: OWNER,
    fetch: gh.fetch,
    now: () => Date.parse(at),
    isKnown: (r) => !!findEntry(state, { id: r.id, name: r.name }),
  });
  return { result, ...mergeDiscovery(state, result, { now: at, missesToRemove: 2 }) };
}

function seededState() {
  return mergeSnapshot(emptyState(), seed).state;
}

const active = (state) => Object.values(state.sites).filter((e) => e.status === 'active');

test('the starter catalog loads 13 baseline sites keyed by name', () => {
  const state = seededState();
  assert.equal(active(state).length, 13);
  for (const entry of active(state)) {
    assert.equal(entry.key, `name:${entry.name}`);
    assert.equal(entry.baseline, true);
    assert.equal(entry.repoId, null);
  }
});

test('the first live check gives starter sites their permanent ids and keeps them baseline', async () => {
  const repos = starterRepos();
  const { state, adopted, added } = await check(seededState(), mockGitHub({ repos, sites: publishedSites(repos) }));
  assert.equal(adopted.length, 13);
  assert.equal(added.length, 0);
  const groundwork = findEntry(state, { id: 5000 });
  assert.equal(groundwork.key, 'repo:5000');
  assert.equal(groundwork.baseline, true);
  assert.equal(groundwork.firstSeen, seed.generatedAt);
  assert.equal(state.checks.last.outcome, 'complete');
  assert.equal(state.checks.lastSuccessAt, T0);
});

test('a newly published site appears in Other with a Recently added badge that fades after 14 days', async () => {
  const repos = [...starterRepos(), repo(9001, 'garden-planner'), repo(9002, 'recipes', { description: 'Family recipes.' })];
  const { state, added } = await check(seededState(), mockGitHub({ repos, sites: publishedSites(repos) }));
  assert.deepEqual(added.sort(), ['repo:9001', 'repo:9002']);

  const views = viewSites(state, overrides, { now: Date.parse(T0), recentDays: 14 });
  const planner = views.find((v) => v.key === 'repo:9001');
  assert.equal(planner.title, 'Garden Planner');
  assert.equal(planner.category, 'Other');
  assert.equal(planner.description, FALLBACK_DESCRIPTION);
  assert.equal(planner.isFallbackDescription, true);
  assert.equal(planner.isNew, true);
  assert.equal(views.find((v) => v.key === 'repo:9002').description, 'Family recipes.');
  // Starter sites are never "Recently added".
  assert.equal(views.filter((v) => v.isNew).length, 2);

  const later = viewSites(state, overrides, { now: Date.parse(days(15)), recentDays: 14 });
  assert.equal(later.find((v) => v.key === 'repo:9001').isNew, false);
  // New sites go last, in Other.
  assert.equal(views.at(-1).category, 'Other');
});

test('a failed check changes nothing but the check record', async () => {
  const before = seededState();
  const reset = Math.floor(Date.parse(T0) / 1000) + 900;
  const { state, removed, added } = await check(before, mockGitHub({ onList: () => rateLimitedResponse(reset) }));
  assert.deepEqual(state.sites, before.sites);
  assert.deepEqual(removed, []);
  assert.deepEqual(added, []);
  assert.equal(state.checks.last.outcome, 'failed');
  assert.equal(state.checks.last.reason, 'rate-limited');
  assert.equal(state.checks.retryAt, new Date(reset * 1000).toISOString());
  assert.equal(state.checks.lastSuccessAt, null);
});

test('a partial check can add verified sites but never removes any', async () => {
  let state = seededState();
  const repos = starterRepos();
  state = (await check(state, mockGitHub({ repos, sites: publishedSites(repos) }))).state;

  // Page 2 fails; page 1 (made small here) holds only a new site.
  const gh = mockGitHub({
    onList: (page) =>
      page === 1
        ? jsonResponse([repo(9001, 'fresh')], 200, { link: '<https://api.github.com/users/Cleverzebra/repos?page=2>; rel="next"' })
        : jsonResponse({ message: 'boom' }, 500),
    sites: { [pagesUrl('fresh')]: 200 },
  });
  const next = await check(state, gh, hours(2));
  assert.equal(next.state.checks.last.outcome, 'partial');
  assert.deepEqual(next.added, ['repo:9001']);
  assert.equal(active(next.state).length, 14);
  assert.ok(active(next.state).every((e) => e.misses === 0));
  assert.equal(next.state.checks.lastSuccessAt, T0, 'a partial check is not a successful check');
});

test('a site is removed only after two complete checks confirm it is gone', async () => {
  const repos = starterRepos();
  let state = (await check(seededState(), mockGitHub({ repos, sites: publishedSites(repos) }))).state;

  const withoutWater = repos.map((r) => (r.name === 'watercalculator' ? { ...r, has_pages: false } : r));
  const gh = mockGitHub({ repos: withoutWater, sites: publishedSites(withoutWater) });

  const first = await check(state, gh, hours(2));
  const water = findEntry(first.state, { name: 'watercalculator' });
  assert.equal(water.status, 'active');
  assert.equal(water.misses, 1);
  assert.deepEqual(first.removed, []);

  const second = await check(first.state, gh, hours(4));
  assert.deepEqual(second.removed, [water.key]);
  assert.equal(findEntry(second.state, { name: 'watercalculator' }).status, 'retired');
  assert.equal(viewSites(second.state, overrides).length, 12);
});

test('a site found again resets its missed count', async () => {
  const repos = starterRepos();
  let state = (await check(seededState(), mockGitHub({ repos, sites: publishedSites(repos) }))).state;
  const gone = repos.filter((r) => r.name !== 'groundwork');
  state = (await check(state, mockGitHub({ repos: gone, sites: publishedSites(gone) }), hours(2))).state;
  assert.equal(findEntry(state, { id: 5000 }).misses, 1);
  state = (await check(state, mockGitHub({ repos, sites: publishedSites(repos) }), hours(4))).state;
  assert.equal(findEntry(state, { id: 5000 }).misses, 0);
});

test('an existing site whose address cannot be reached is left alone', async () => {
  const repos = starterRepos();
  let state = (await check(seededState(), mockGitHub({ repos, sites: publishedSites(repos) }))).state;
  const sites = { ...publishedSites(repos), [pagesUrl('groundwork')]: 503 };
  for (const at of [hours(2), hours(4), hours(6)]) {
    state = (await check(state, mockGitHub({ repos, sites }), at)).state;
  }
  assert.equal(findEntry(state, { id: 5000 }).status, 'active');
  assert.equal(findEntry(state, { id: 5000 }).misses, 0);
});

test('a listing that confirms none of the known sites is not trusted for removals', async () => {
  const repos = starterRepos();
  let state = (await check(seededState(), mockGitHub({ repos, sites: publishedSites(repos) }))).state;
  const strangers = [repo(1, 'unrelated', { has_pages: false })];
  for (const at of [hours(2), hours(4)]) {
    const next = await check(state, mockGitHub({ repos: strangers }), at);
    assert.equal(next.state.checks.last.outcome, 'partial');
    assert.equal(next.state.checks.last.reason, 'unexpected-listing');
    state = next.state;
  }
  assert.equal(active(state).length, 13);
});

test('starter sites that are not on GitHub are removed after two complete checks', async () => {
  const repos = starterRepos().filter((r) => r.name !== 'natick-local-guide');
  let state = seededState();
  state = (await check(state, mockGitHub({ repos, sites: publishedSites(repos) }))).state;
  assert.equal(findEntry(state, { name: 'natick-local-guide' }).misses, 1);
  state = (await check(state, mockGitHub({ repos, sites: publishedSites(repos) }), hours(2))).state;
  assert.equal(findEntry(state, { name: 'natick-local-guide' }).status, 'retired');
});

test('the snapshot never removes sites and keeps the earliest first-seen date', () => {
  let state = emptyState();
  state = mergeDiscovery(state, {
    outcome: 'complete',
    published: [{ repo: { id: 9001, name: 'x', topics: [] }, url: pagesUrl('x') }],
    unpublished: [],
    unconfirmed: [],
    listedRepoIds: [9001],
    listedRepoNames: ['x'],
  }, { now: days(3) }).state;
  const snapshot = reviveSnapshot({
    format: 'cleverzebra-library-catalog',
    version: 1,
    generatedAt: days(1),
    generatedBy: 'workflow',
    sites: [{ repoId: 9001, name: 'x', url: pagesUrl('x'), firstSeen: days(1), lastConfirmed: days(1) }],
  });
  const merged = mergeSnapshot(state, snapshot).state;
  assert.equal(merged.sites['repo:9001'].firstSeen, days(1));
  assert.equal(active(merged).length, 1);
  const empty = mergeSnapshot(merged, { generatedAt: days(4), sites: [] }).state;
  assert.equal(active(empty).length, 1);
});

test('the snapshot brings back a site only if it was confirmed after this device removed it', () => {
  const state = emptyState();
  state.sites['repo:1'] = {
    key: 'repo:1', repoId: 1, name: 'a', url: pagesUrl('a'), repoUrl: null, description: null, topics: [],
    firstSeen: days(-10), baseline: false, lastConfirmed: days(-3), misses: 2, status: 'retired', retiredAt: days(-1), source: 'discovered',
  };
  const older = { generatedAt: days(-2), sites: [reviveSnapshot({ format: 'cleverzebra-library-catalog', version: 1, generatedAt: days(-2), generatedBy: 'workflow', sites: [{ repoId: 1, name: 'a', url: pagesUrl('a'), lastConfirmed: days(-2) }] }).sites[0]] };
  assert.equal(mergeSnapshot(state, older).state.sites['repo:1'].status, 'retired');
  const newer = reviveSnapshot({ format: 'cleverzebra-library-catalog', version: 1, generatedAt: days(0), generatedBy: 'workflow', sites: [{ repoId: 1, name: 'a', url: pagesUrl('a'), lastConfirmed: days(0) }] });
  assert.equal(mergeSnapshot(state, newer).state.sites['repo:1'].status, 'active');
});

test('a snapshot with ids upgrades starter entries and does not duplicate them', () => {
  const state = seededState();
  const snapshot = reviveSnapshot({
    format: 'cleverzebra-library-catalog', version: 1, generatedAt: days(1), generatedBy: 'workflow',
    sites: [{ repoId: 5000, name: 'groundwork', url: pagesUrl('groundwork'), firstSeen: T0, baseline: true, lastConfirmed: days(1) }],
  });
  const { state: merged, adopted } = mergeSnapshot(state, snapshot);
  assert.deepEqual(adopted, [{ from: 'name:groundwork', to: 'repo:5000' }]);
  assert.equal(active(merged).length, 13);
  // And the reverse: the starter list after a live check adds nothing twice.
  assert.equal(active(mergeSnapshot(merged, seed).state).length, 13);
});

test('when a check is due', () => {
  const opts = { intervalMs: 3600e3, backoffMs: 300e3 };
  const s = emptyState();
  assert.equal(isCheckDue(s, Date.parse(T0), opts), true, 'never checked');
  s.checks.lastSuccessAt = T0;
  s.checks.lastAttemptAt = T0;
  s.checks.last = { outcome: 'complete', at: T0, added: [], removed: [], unconfirmed: 0 };
  assert.equal(isCheckDue(s, Date.parse(hours(0.5)), opts), false, 'checked 30 minutes ago');
  assert.equal(isCheckDue(s, Date.parse(hours(1)), opts), true, 'an hour later');
  s.checks.lastAttemptAt = hours(1);
  s.checks.last = { outcome: 'failed', at: hours(1), added: [], removed: [], unconfirmed: 0 };
  assert.equal(isCheckDue(s, Date.parse(hours(1.05)), opts), false, 'backs off after a failure');
  assert.equal(isCheckDue(s, Date.parse(hours(1.1)), opts), true, 'retries after the backoff');
  s.checks.retryAt = hours(2);
  assert.equal(isCheckDue(s, Date.parse(hours(1.5)), opts), false, 'waits for the rate limit to reset');
  assert.equal(isCheckDue(s, Date.parse(hours(2)), opts), true);
});

test('corrupt saved data is ignored safely', () => {
  assert.deepEqual(reviveState(null), emptyState());
  assert.deepEqual(reviveState({ version: 99 }), emptyState());
  const state = reviveState({
    version: 1,
    sites: {
      a: { name: 'ok', url: 'https://cleverzebra.github.io/ok/', repoId: 3 },
      b: { name: 'bad url', url: 'https://x/' },
      c: { name: 'evil', url: 'javascript:alert(1)' },
      d: 'nonsense',
    },
    checks: { lastSuccessAt: 'not a date', last: { outcome: 'weird' } },
  });
  assert.deepEqual(Object.keys(state.sites), ['repo:3']);
  assert.equal(state.checks.lastSuccessAt, null);
  assert.equal(state.checks.last, null);
});

test('overrides change titles, descriptions, categories, order, and exclusions', () => {
  const state = seededState();
  const views = viewSites(state, overrides);
  assert.deepEqual(
    [...new Set(views.map((v) => v.category))],
    ['Gardens', 'Local Guides', 'Monhegan', 'Family'],
  );
  assert.deepEqual(views.slice(0, 3).map((v) => v.title), ['Groundwork', 'Julia’s Garden Year', 'Boston']);
  assert.ok(views.every((v) => !v.isFallbackDescription));

  const custom = normalizeOverrides({
    categories: ['Gardens'],
    sites: { groundwork: { exclude: true }, 'julias-garden-year': { title: 'Garden Year', category: 'Seasonal' } },
  });
  const customViews = viewSites(state, custom);
  assert.ok(!customViews.some((v) => v.name === 'groundwork'));
  assert.equal(customViews.find((v) => v.name === 'julias-garden-year').category, 'Seasonal');
  assert.equal(customViews.find((v) => v.name === 'julias-garden-year').title, 'Garden Year');
  assert.equal(customViews.find((v) => v.name === 'boston-local-guide').title, 'Boston Local Guide');
});

test('a GitHub topic that matches a category files a new site there', () => {
  const state = emptyState();
  state.sites['repo:1'] = {
    key: 'repo:1', repoId: 1, name: 'lenox-guide', url: pagesUrl('lenox-guide'), repoUrl: null, description: null,
    topics: ['local-guides'], firstSeen: T0, baseline: false, lastConfirmed: T0, misses: 0, status: 'active', retiredAt: null, source: 'discovered',
  };
  assert.equal(viewSites(state, overrides)[0].category, 'Local Guides');
});

test('titles derived from repository names', () => {
  assert.equal(titleFromName('boston-local-guide'), 'Boston Local Guide');
  assert.equal(titleFromName('gwyn-college-hq'), 'Gwyn College HQ');
  assert.equal(titleFromName('torquay_and_the_coast'), 'Torquay and the Coast');
  assert.equal(titleFromName('waterCalculator'), 'Water Calculator');
  assert.equal(titleFromName('cleverzebra.github.io'), 'Cleverzebra');
  assert.equal(titleFromName('the-atlas'), 'The Atlas');
});

test('search covers titles, descriptions, and tags, forgiving apostrophes, accents, and ampersands', () => {
  const views = viewSites(seededState(), overrides);
  const titles = (q) => searchViews(views, q).map((v) => v.title);
  assert.deepEqual(titles('julias'), ['Julia’s Garden Year']);
  assert.deepEqual(titles("julia's garden"), ['Julia’s Garden Year']);
  assert.deepEqual(titles('cafes'), ['Sofia & Bandit’s Somerville']);
  assert.deepEqual(titles('sofia and bandit'), ['Sofia & Bandit’s Somerville']);
  assert.ok(titles('pickleball').includes('Boston'));
  assert.deepEqual(titles('aquifer'), ['Water Conservation Calculator']);
  assert.equal(titles('monhegan')[0], 'Monhegan Island Resource Library', 'title matches rank first');
  assert.deepEqual(titles('zzzz'), []);
  assert.equal(titles('   ').length, 13);
});

test('the workflow snapshot round-trips', () => {
  const state = seededState();
  const snapshot = stateToSnapshot(state, { generatedAt: T0, owner: OWNER });
  const revived = reviveSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(revived.sites.length, 13);
  assert.equal(revived.generatedBy, 'workflow');
  assert.ok(revived.sites.every((s) => s.baseline));
});
