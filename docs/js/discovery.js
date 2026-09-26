// Finds the owner's published GitHub Pages sites.
//
// In the browser this needs no token: it lists public repositories through
// GitHub's public API, which allows cross-origin reads, and then confirms each
// candidate by requesting its web address. The optional publishing workflow
// runs the same code in Node with the workflow's built-in token.
//
// Every network request goes through the injected `fetch`, so tests can
// replace GitHub with mocked responses.

const DEFAULTS = {
  apiBase: 'https://api.github.com',
  token: null,
  perPage: 100,
  maxPages: 10,
  requestTimeoutMs: 15000,
  verifyTimeoutMs: 10000,
  concurrency: 4,
  // Pages settings are looked up only for repositories the library has not
  // seen before, and at most this many per check, to spare the hourly limit.
  pagesApiBudget: 10,
  minRateRemaining: 5,
  // Extra options for address checks. The browser passes cache and
  // credential settings here; Node needs none.
  verifyInit: {},
  // In a browser, a redirect to a custom domain without cross-origin headers
  // fails outright; probing the redirect itself still proves the site is served.
  probeRedirects: false,
  excludeRepoIds: [],
  excludeRepoNames: [],
  isKnown: () => false,
  now: () => Date.now(),
  signal: undefined,
};

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;

export function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  url.hash = '';
  return url.href;
}

export function derivePagesUrl(owner, repoName) {
  const host = `${String(owner).toLowerCase()}.github.io`;
  if (String(repoName).toLowerCase() === host) return `https://${host}/`;
  return `https://${host}/${encodeURIComponent(repoName)}/`;
}

export function parseNextLink(header) {
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (match && match[2].split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

export function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function normalizeRepo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isSafeInteger(raw.id) || raw.id <= 0) return null;
  if (typeof raw.name !== 'string' || !REPO_NAME.test(raw.name)) return null;
  return {
    id: raw.id,
    name: raw.name,
    htmlUrl: safeHttpsUrl(raw.html_url),
    description: cleanText(raw.description, 400),
    homepage: typeof raw.homepage === 'string' ? raw.homepage : null,
    topics: Array.isArray(raw.topics)
      ? raw.topics.filter((t) => typeof t === 'string' && TOPIC.test(t)).slice(0, 20)
      : [],
    hasPages: raw.has_pages === true,
    private: raw.private === true,
  };
}

function numberHeader(headers, name) {
  const value = headers.get(name);
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readRate(headers) {
  const remaining = numberHeader(headers, 'x-ratelimit-remaining');
  const reset = numberHeader(headers, 'x-ratelimit-reset');
  if (remaining === null && reset === null) return null;
  return {
    limit: numberHeader(headers, 'x-ratelimit-limit'),
    remaining,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
}

// GitHub signals its limits with 403 or 429 plus either Retry-After or an
// exhausted X-RateLimit-Remaining. Returns when to try again, or null.
function rateLimitRetryAt(res, nowMs) {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = numberHeader(res.headers, 'retry-after');
  if (retryAfter !== null) return new Date(nowMs + retryAfter * 1000).toISOString();
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = numberHeader(res.headers, 'x-ratelimit-reset');
    return new Date(reset !== null ? reset * 1000 : nowMs + 60 * 60 * 1000).toISOString();
  }
  if (res.status === 429) return new Date(nowMs + 60 * 1000).toISOString();
  return null;
}

async function discardBody(res) {
  try {
    await res.body?.cancel?.();
  } catch {
    // Nothing to release.
  }
}

async function timedFetch(ctx, url, init, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const outer = ctx.signal;
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await ctx.fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const wrapped = new Error(`Request failed: ${url}`);
    wrapped.reason = timedOut ? 'timeout' : outer?.aborted ? 'aborted' : 'network';
    wrapped.cause = err;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function apiHeaders(token) {
  // Only Accept is sent without a token, which keeps browser requests
  // "simple" (no cross-origin preflight).
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  }
  return headers;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function withPage(url, page) {
  const next = new URL(url);
  next.searchParams.set('page', String(page));
  return next.href;
}

async function listRepos(ctx) {
  const repos = [];
  let url = `${ctx.apiBase}/users/${encodeURIComponent(ctx.owner)}/repos?type=owner&sort=full_name&per_page=${ctx.perPage}`;
  let page = 1;
  while (url) {
    if (page > ctx.maxPages) return { complete: false, repos, reason: 'too-many-pages' };
    let res;
    try {
      res = await timedFetch(ctx, url, { headers: apiHeaders(ctx.token) }, ctx.requestTimeoutMs);
    } catch (err) {
      if (err.reason === 'aborted') throw err;
      return { complete: false, repos, reason: err.reason };
    }
    ctx.rate = readRate(res.headers) ?? ctx.rate;
    if (!res.ok) {
      const retryAt = rateLimitRetryAt(res, ctx.now());
      await discardBody(res);
      if (retryAt) return { complete: false, repos, reason: 'rate-limited', retryAt };
      const reason = res.status === 404 ? 'owner-not-found' : res.status >= 500 ? 'server-error' : `http-${res.status}`;
      return { complete: false, repos, reason };
    }
    let data;
    try {
      data = await res.json();
    } catch {
      return { complete: false, repos, reason: 'bad-response' };
    }
    if (!Array.isArray(data)) return { complete: false, repos, reason: 'bad-response' };
    repos.push(...data);

    const link = res.headers.get('link');
    const next = parseNextLink(link);
    if (next) {
      if (!sameOrigin(next, ctx.apiBase)) return { complete: false, repos, reason: 'bad-response' };
      url = next;
    } else if (!link && data.length >= ctx.perPage) {
      // The Link header was not readable; keep paging until a short page.
      url = withPage(url, page + 1);
    } else {
      url = null;
    }
    page += 1;
  }
  return { complete: true, repos };
}

async function fetchPagesInfo(repo, ctx) {
  const url = `${ctx.apiBase}/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(repo.name)}/pages`;
  let res;
  try {
    res = await timedFetch(ctx, url, { headers: apiHeaders(ctx.token) }, ctx.requestTimeoutMs);
  } catch (err) {
    if (err.reason === 'aborted') throw err;
    return null;
  }
  ctx.rate = readRate(res.headers) ?? ctx.rate;
  if (!res.ok) {
    await discardBody(res);
    // Without permission (or once limited) further lookups would fail the same way.
    if (res.status === 401 || res.status === 403 || res.status === 429) ctx.pagesApiBlocked = true;
    return null;
  }
  try {
    const data = await res.json();
    return {
      htmlUrl: safeHttpsUrl(data?.html_url),
      cname: typeof data?.cname === 'string' && data.cname ? data.cname.toLowerCase() : null,
      status: typeof data?.status === 'string' ? data.status : null,
    };
  } catch {
    return null;
  }
}

// A repository homepage is only a candidate: it is used when it points at
// this repository's own Pages address (or its custom domain), and it still
// has to answer before the site is listed.
function homepageCandidate(repo, owner, cname) {
  const url = safeHttpsUrl(repo.homepage);
  if (!url) return null;
  const { hostname, pathname } = new URL(url);
  const host = hostname.toLowerCase();
  if (cname && host === cname) return url;
  const pagesHost = `${owner.toLowerCase()}.github.io`;
  if (host !== pagesHost) return null;
  if (repo.name.toLowerCase() === pagesHost) return url;
  const path = pathname.toLowerCase();
  const own = `/${repo.name.toLowerCase()}`;
  return path === own || path.startsWith(`${own}/`) ? url : null;
}

async function probeRedirect(url, ctx) {
  try {
    const res = await timedFetch(
      ctx,
      url,
      { method: 'HEAD', redirect: 'manual', ...ctx.verifyInit },
      ctx.verifyTimeoutMs,
    );
    await discardBody(res);
    if (res.type === 'opaqueredirect') return { state: 'ok', url };
  } catch (err) {
    if (err.reason === 'aborted') throw err;
  }
  return null;
}

async function checkAddress(url, ctx, method = 'HEAD') {
  let res;
  try {
    res = await timedFetch(ctx, url, { method, redirect: 'follow', ...ctx.verifyInit }, ctx.verifyTimeoutMs);
  } catch (err) {
    if (err.reason === 'aborted') throw err;
    if (ctx.probeRedirects) {
      const probe = await probeRedirect(url, ctx);
      if (probe) return probe;
    }
    return { state: 'error', why: err.reason };
  }
  await discardBody(res);
  if (res.ok) return { state: 'ok', url: safeHttpsUrl(res.url) || url };
  if (res.status === 404 || res.status === 410) return { state: 'missing' };
  if ((res.status === 405 || res.status === 501) && method === 'HEAD') return checkAddress(url, ctx, 'GET');
  return { state: 'error', why: res.status >= 500 ? 'server-error' : `http-${res.status}` };
}

async function verifyRepo(repo, info, ctx) {
  const candidates = [];
  if (info?.htmlUrl) candidates.push({ url: info.htmlUrl, via: 'pages-settings' });
  candidates.push({ url: derivePagesUrl(ctx.owner, repo.name), via: 'pages-address' });
  const homepage = homepageCandidate(repo, ctx.owner, info?.cname ?? null);
  if (homepage) candidates.push({ url: homepage, via: 'homepage' });

  const seen = new Set();
  let error = null;
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const result = await checkAddress(candidate.url, ctx);
    if (result.state === 'ok') return { state: 'published', url: result.url, via: candidate.via };
    if (result.state === 'error') error = result.why;
  }
  return error ? { state: 'unconfirmed', why: error } : { state: 'unpublished' };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Runs one discovery check.
 *
 * outcome: 'complete' (every repository was listed), 'partial' (listing
 * stopped early; nothing may be removed), or 'failed' (nothing was listed).
 */
export async function discover(options) {
  const ctx = { ...DEFAULTS, ...options };
  if (typeof ctx.fetch !== 'function') throw new TypeError('discover() needs a fetch function');
  if (!ctx.owner) throw new TypeError('discover() needs an owner');
  ctx.rate = null;
  ctx.pagesApiBlocked = false;
  const excludeIds = new Set(ctx.excludeRepoIds.filter(Number.isSafeInteger));
  const excludeNames = new Set(ctx.excludeRepoNames.map((n) => String(n).toLowerCase()));
  const checkedAt = new Date(ctx.now()).toISOString();

  const listing = await listRepos(ctx);
  const base = {
    reason: listing.complete ? null : listing.reason,
    retryAt: listing.retryAt ?? null,
    checkedAt,
  };
  if (!listing.complete && listing.repos.length === 0) {
    return {
      ...base,
      outcome: 'failed',
      rate: ctx.rate,
      listedRepoIds: [],
      listedRepoNames: [],
      published: [],
      unpublished: [],
      unconfirmed: [],
    };
  }

  const repos = listing.repos
    .map(normalizeRepo)
    .filter((r) => r && !r.private && !excludeIds.has(r.id) && !excludeNames.has(r.name.toLowerCase()));
  const candidates = repos.filter((r) => r.hasPages);
  const unpublished = repos
    .filter((r) => !r.hasPages)
    .map((r) => ({ repoId: r.id, name: r.name, why: 'no-pages' }));

  const info = new Map();
  let budget = ctx.pagesApiBudget;
  for (const repo of candidates) {
    if (budget <= 0 || ctx.pagesApiBlocked) break;
    if (ctx.rate?.remaining != null && ctx.rate.remaining < ctx.minRateRemaining) break;
    if (ctx.isKnown(repo)) continue;
    budget -= 1;
    const details = await fetchPagesInfo(repo, ctx);
    if (details) info.set(repo.id, details);
  }

  const checks = await mapLimit(candidates, ctx.concurrency, (repo) => verifyRepo(repo, info.get(repo.id), ctx));
  const published = [];
  const unconfirmed = [];
  candidates.forEach((repo, i) => {
    const check = checks[i];
    if (check.state === 'published') {
      published.push({ repo, url: check.url, via: check.via });
    } else if (check.state === 'unpublished') {
      unpublished.push({ repoId: repo.id, name: repo.name, why: 'not-found' });
    } else {
      unconfirmed.push({ repoId: repo.id, name: repo.name, why: check.why });
    }
  });

  return {
    ...base,
    outcome: listing.complete ? 'complete' : 'partial',
    rate: ctx.rate,
    listedRepoIds: repos.map((r) => r.id),
    listedRepoNames: repos.map((r) => r.name.toLowerCase()),
    published,
    unpublished,
    unconfirmed,
  };
}
