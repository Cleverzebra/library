import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, derivePagesUrl, parseNextLink, safeHttpsUrl } from '../../docs/js/discovery.js';
import {
  OWNER,
  repo,
  pagesUrl,
  mockGitHub,
  siteResponse,
  rateLimitedResponse,
  networkError,
  hangUntilAborted,
  jsonResponse,
  starterRepos,
  publishedSites,
} from '../helpers/mock-github.mjs';

const NOW = Date.parse('2026-09-26T15:00:00Z');
const run = (gh, extra = {}) => discover({ owner: OWNER, fetch: gh.fetch, now: () => NOW, ...extra });
const ids = (list) => list.map((p) => p.repo?.id ?? p.repoId).sort((a, b) => a - b);

test('lists every page by following Link headers', async () => {
  const repos = Array.from({ length: 230 }, (_, i) => repo(i + 1, `site-${i + 1}`, { has_pages: i % 10 === 0 }));
  const gh = mockGitHub({ repos, sites: publishedSites(repos) });
  const result = await run(gh);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.listedRepoIds.length, 230);
  assert.equal(result.published.length, 23);
  const listCalls = gh.calls.filter((c) => c.url.includes('/users/'));
  assert.equal(listCalls.length, 3);
  assert.match(listCalls[0].url, /per_page=100/);
});

test('keeps paging when the Link header is not readable', async () => {
  const repos = Array.from({ length: 150 }, (_, i) => repo(i + 1, `site-${i + 1}`, { has_pages: false }));
  repos[140].has_pages = true;
  const gh = mockGitHub({ repos, linkHeaders: false, sites: publishedSites(repos) });
  const result = await run(gh);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.listedRepoIds.length, 150);
  assert.deepEqual(ids(result.published), [141]);
});

test('an exact multiple of the page size ends on an empty page without Link headers', async () => {
  const repos = Array.from({ length: 100 }, (_, i) => repo(i + 1, `site-${i + 1}`, { has_pages: false }));
  const gh = mockGitHub({ repos, linkHeaders: false });
  const result = await run(gh);
  assert.equal(result.outcome, 'complete');
  assert.equal(gh.calls.filter((c) => c.url.includes('/users/')).length, 2);
});

test('a newly published repository is found with no list to edit', async () => {
  const repos = [...starterRepos(), repo(9001, 'garden-planner', { description: 'Plan the beds.' })];
  const gh = mockGitHub({ repos, sites: publishedSites(repos) });
  const result = await run(gh);
  assert.equal(result.outcome, 'complete');
  const found = result.published.find((p) => p.repo.id === 9001);
  assert.ok(found, 'new repository should be published');
  assert.equal(found.url, pagesUrl('garden-planner'));
  assert.equal(found.repo.description, 'Plan the beds.');
});

test('repositories without a published site are excluded', async () => {
  const repos = [
    repo(1, 'published'),
    repo(2, 'no-pages', { has_pages: false }),
    repo(3, 'pages-but-404'),
    repo(4, 'private-one', { private: true }),
  ];
  const gh = mockGitHub({ repos, sites: { [pagesUrl('published')]: 200 } });
  const result = await run(gh);
  assert.deepEqual(ids(result.published), [1]);
  assert.deepEqual(
    result.unpublished.map((u) => [u.repoId, u.why]).sort(),
    [
      [2, 'no-pages'],
      [3, 'not-found'],
    ],
  );
  assert.ok(!result.listedRepoIds.includes(4), 'private repositories are ignored');
  // Repositories without Pages are never requested.
  assert.ok(!gh.calls.some((c) => c.url === pagesUrl('no-pages')));
});

test('the library excludes itself by repository id and by name', async () => {
  const repos = [repo(1388362103, 'library'), repo(2, 'cleverzebra-library'), repo(3, 'groundwork')];
  const gh = mockGitHub({ repos, sites: publishedSites(repos) });
  const result = await run(gh, { excludeRepoIds: [1388362103], excludeRepoNames: ['cleverzebra-library'] });
  assert.deepEqual(ids(result.published), [3]);
  assert.deepEqual(result.listedRepoIds, [3]);
});

test('uses the published address from Pages settings, including a custom domain', async () => {
  const repos = [repo(7, 'fancy')];
  const gh = mockGitHub({
    repos,
    pages: { fancy: { html_url: 'https://fancy.example.org/', cname: 'fancy.example.org', status: 'built' } },
    sites: { 'https://fancy.example.org/': 200 },
  });
  const result = await run(gh);
  assert.equal(result.published[0].url, 'https://fancy.example.org/');
  assert.equal(result.published[0].via, 'pages-settings');
});

test('follows a redirect from the github.io address to the real address', async () => {
  const repos = [repo(8, 'moved')];
  const gh = mockGitHub({
    repos,
    sites: { [pagesUrl('moved')]: () => siteResponse(200, 'https://moved.example.net/') },
  });
  const result = await run(gh);
  assert.equal(result.published[0].url, 'https://moved.example.net/');
});

test('a repository homepage is only a candidate, never proof', async () => {
  const repos = [
    repo(1, 'elsewhere', { homepage: 'https://example.com/' }),
    repo(2, 'own-path', { homepage: 'https://cleverzebra.github.io/own-path/start.html' }),
    repo(3, 'other-path', { homepage: 'https://cleverzebra.github.io/somebody-else/' }),
  ];
  const gh = mockGitHub({
    repos,
    sites: {
      'https://example.com/': 200,
      'https://cleverzebra.github.io/own-path/start.html': 200,
      'https://cleverzebra.github.io/somebody-else/': 200,
    },
  });
  const result = await run(gh);
  // Only the homepage on this repository's own Pages path counts, and only after it answers.
  assert.deepEqual(ids(result.published), [2]);
  assert.equal(result.published[0].via, 'homepage');
  assert.deepEqual(ids(result.unpublished), [1, 3]);
});

test('Pages settings are looked up only for sites the library has not seen', async () => {
  const repos = [repo(1, 'known'), repo(2, 'new-one')];
  const gh = mockGitHub({ repos, sites: publishedSites(repos) });
  await run(gh, { isKnown: (r) => r.id === 1 });
  const lookups = gh.calls.filter((c) => c.url.endsWith('/pages'));
  assert.deepEqual(
    lookups.map((c) => c.url),
    ['https://api.github.com/repos/Cleverzebra/new-one/pages'],
  );
});

test('stops Pages lookups once GitHub refuses them, and still verifies the sites', async () => {
  const repos = [repo(1, 'a'), repo(2, 'b'), repo(3, 'c')];
  const gh = mockGitHub({ repos, sites: publishedSites(repos), pages: { a: 403, b: 403, c: 403 } });
  const result = await run(gh);
  assert.equal(gh.calls.filter((c) => c.url.endsWith('/pages')).length, 1);
  assert.deepEqual(ids(result.published), [1, 2, 3]);
});

test('skips Pages lookups when the hourly allowance is nearly used up', async () => {
  const repos = [repo(1, 'a')];
  const gh = mockGitHub({ repos, sites: publishedSites(repos), rate: { limit: 60, remaining: 2, reset: 1790000000 } });
  const result = await run(gh);
  assert.equal(gh.calls.filter((c) => c.url.endsWith('/pages')).length, 0);
  assert.equal(result.rate.remaining, 2);
});

test('browser requests stay simple: no token, only an Accept header', async () => {
  const gh = mockGitHub({ repos: [repo(1, 'a')], sites: publishedSites([repo(1, 'a')]) });
  await run(gh);
  const headers = gh.calls[0].headers;
  assert.deepEqual(Object.keys(headers), ['Accept']);
});

test('the workflow token is sent only when provided', async () => {
  const gh = mockGitHub({ repos: [repo(1, 'a')], sites: publishedSites([repo(1, 'a')]) });
  await run(gh, { token: 'test-token' });
  assert.equal(gh.calls[0].headers.Authorization, 'Bearer test-token');
});

test('a rate-limited listing fails and reports when to retry', async () => {
  const reset = Math.floor(NOW / 1000) + 1800;
  const gh = mockGitHub({ repos: starterRepos(), onList: () => rateLimitedResponse(reset) });
  const result = await run(gh);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'rate-limited');
  assert.equal(result.retryAt, new Date(reset * 1000).toISOString());
  assert.equal(result.published.length, 0);
});

test('a secondary rate limit uses Retry-After', async () => {
  const gh = mockGitHub({
    onList: () => jsonResponse({ message: 'slow down' }, 403, { 'retry-after': '120' }),
  });
  const result = await run(gh);
  assert.equal(result.reason, 'rate-limited');
  assert.equal(result.retryAt, new Date(NOW + 120000).toISOString());
});

for (const [label, onList, reason] of [
  ['a server error', () => jsonResponse({ message: 'boom' }, 502), 'server-error'],
  ['a network failure', () => { throw networkError(); }, 'network'],
  ['an unreadable answer', () => new Response('<html>', { status: 200 }), 'bad-response'],
  ['a missing account', () => jsonResponse({ message: 'Not Found' }, 404), 'owner-not-found'],
]) {
  test(`${label} makes the check fail without results`, async () => {
    const gh = mockGitHub({ repos: starterRepos(), onList });
    const result = await run(gh);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, reason);
    assert.deepEqual(result.published, []);
  });
}

test('a listing that never answers times out', async () => {
  const gh = mockGitHub({ onList: (page, url, init) => hangUntilAborted(init) });
  const result = await run(gh, { requestTimeoutMs: 50 });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'timeout');
});

test('a failure on a later page gives a partial result', async () => {
  const repos = Array.from({ length: 150 }, (_, i) => repo(i + 1, `site-${i + 1}`, { has_pages: i === 5 }));
  const gh = mockGitHub({
    repos,
    sites: publishedSites(repos),
    onList: (page) => (page === 2 ? jsonResponse({ message: 'boom' }, 500) : undefined),
  });
  const result = await run(gh);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'server-error');
  assert.equal(result.listedRepoIds.length, 100);
  assert.deepEqual(ids(result.published), [6]);
});

test('an address that cannot be reached is unconfirmed, not unpublished', async () => {
  const repos = [repo(1, 'flaky'), repo(2, 'slow')];
  const gh = mockGitHub({
    repos,
    sites: {
      [pagesUrl('flaky')]: () => { throw networkError(); },
      [pagesUrl('slow')]: (init) => hangUntilAborted(init),
    },
  });
  const result = await run(gh, { verifyTimeoutMs: 50 });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.published, []);
  assert.deepEqual(result.unpublished, []);
  assert.deepEqual(
    result.unconfirmed.map((u) => [u.repoId, u.why]),
    [
      [1, 'network'],
      [2, 'timeout'],
    ],
  );
});

test('a server error from a site is unconfirmed', async () => {
  const gh = mockGitHub({ repos: [repo(1, 'down')], sites: { [pagesUrl('down')]: 503 } });
  const result = await run(gh);
  assert.deepEqual(result.unconfirmed, [{ repoId: 1, name: 'down', why: 'server-error' }]);
});

test('falls back to GET when HEAD is not allowed', async () => {
  const gh = mockGitHub({
    repos: [repo(1, 'no-head')],
    sites: { [pagesUrl('no-head')]: (init, method) => siteResponse(method === 'HEAD' ? 405 : 200) },
  });
  const result = await run(gh);
  assert.deepEqual(ids(result.published), [1]);
});

test('in a browser, a blocked cross-origin redirect still proves the site is served', async () => {
  const gh = mockGitHub({
    repos: [repo(1, 'custom')],
    sites: {
      [pagesUrl('custom')]: (init) => {
        if (init.redirect === 'manual') {
          const res = new Response(null, { status: 200 });
          Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
          return res;
        }
        throw networkError();
      },
    },
  });
  const withoutProbe = await run(gh);
  assert.equal(withoutProbe.unconfirmed.length, 1);
  const withProbe = await run(gh, { probeRedirects: true });
  assert.deepEqual(ids(withProbe.published), [1]);
  assert.equal(withProbe.published[0].url, pagesUrl('custom'));
});

test('refuses a next-page link that points away from the API', async () => {
  const gh = mockGitHub({
    onList: () => jsonResponse([repo(1, 'a')], 200, { link: '<https://evil.example/users/x/repos?page=2>; rel="next"' }),
  });
  const result = await run(gh);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'bad-response');
});

test('the user site repository maps to the account root address', () => {
  assert.equal(derivePagesUrl('Cleverzebra', 'cleverzebra.github.io'), 'https://cleverzebra.github.io/');
  assert.equal(derivePagesUrl('Cleverzebra', 'groundwork'), 'https://cleverzebra.github.io/groundwork/');
});

test('parseNextLink and safeHttpsUrl', () => {
  assert.equal(parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'), 'https://api.github.com/x?page=2');
  assert.equal(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(parseNextLink(null), null);
  assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpsUrl('http://cleverzebra.github.io/a/'), null);
  assert.equal(safeHttpsUrl('https://user:pw@example.com/'), null);
  assert.equal(safeHttpsUrl('https://example.com/a#frag'), 'https://example.com/a');
});

test('the owner name is case-insensitive in Pages addresses', async () => {
  const gh = mockGitHub({ repos: [repo(1, 'Mixed-Case')], sites: { 'https://cleverzebra.github.io/Mixed-Case/': 200 } });
  const result = await run(gh);
  assert.equal(result.published[0].url, 'https://cleverzebra.github.io/Mixed-Case/');
});
