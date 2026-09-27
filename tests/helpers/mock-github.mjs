// A fake GitHub (API + Pages addresses) for discovery tests. Nothing here
// touches the network or creates anything in a real account.

export const OWNER = 'Cleverzebra';

export function repo(id, name, extra = {}) {
  return {
    id,
    name,
    full_name: `${OWNER}/${name}`,
    private: false,
    html_url: `https://github.com/${OWNER}/${name}`,
    description: null,
    homepage: null,
    topics: [],
    has_pages: true,
    fork: false,
    archived: false,
    ...extra,
  };
}

export function pagesUrl(name) {
  return `https://cleverzebra.github.io/${name}/`;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function siteResponse(status, finalUrl) {
  const res = new Response(null, { status });
  if (finalUrl) Object.defineProperty(res, 'url', { value: finalUrl });
  return res;
}

export function rateLimitedResponse(resetEpochSeconds) {
  return jsonResponse({ message: 'API rate limit exceeded' }, 403, {
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(resetEpochSeconds),
  });
}

export function networkError() {
  return new TypeError('fetch failed');
}

export function hangUntilAborted(init) {
  return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
}

/**
 * sites: { [url]: status number | Response | (init) => Response|Promise }
 *   Unlisted addresses answer 404, like GitHub Pages for an unpublished site.
 * pages: { [repoName]: Pages API body | status number | () => Response }
 *   Unlisted repositories answer 404.
 * onList(page, url): optional; return a Response, throw, or return undefined
 *   to serve the page normally.
 */
export function mockGitHub({
  repos = [],
  sites = {},
  pages = {},
  linkHeaders = true,
  onList,
  rate = { limit: 60, remaining: 58, reset: 1790000000 },
} = {}) {
  const calls = [];
  const rateHeaders = () => ({
    'x-ratelimit-limit': String(rate.limit),
    'x-ratelimit-remaining': String(rate.remaining),
    'x-ratelimit-reset': String(rate.reset),
  });

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: url.href, method, headers: init.headers ?? {} });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (url.hostname === 'api.github.com') {
      const list = url.pathname.match(/^\/users\/([^/]+)\/repos$/);
      if (list) {
        const page = Number(url.searchParams.get('page') || '1');
        const custom = await onList?.(page, url, init);
        if (custom) return custom;
        const perPage = Number(url.searchParams.get('per_page') || '30');
        const lastPage = Math.max(1, Math.ceil(repos.length / perPage));
        const headers = rateHeaders();
        if (linkHeaders && page < lastPage) {
          const next = new URL(url);
          next.searchParams.set('page', String(page + 1));
          const last = new URL(url);
          last.searchParams.set('page', String(lastPage));
          headers.link = `<${next.href}>; rel="next", <${last.href}>; rel="last"`;
        }
        return jsonResponse(repos.slice((page - 1) * perPage, page * perPage), 200, headers);
      }
      const pagesMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pages$/);
      if (pagesMatch) {
        const answer = pages[decodeURIComponent(pagesMatch[2])];
        if (typeof answer === 'function') return answer(init);
        if (typeof answer === 'number') return jsonResponse({ message: 'error' }, answer, rateHeaders());
        if (answer) return jsonResponse(answer, 200, rateHeaders());
        return jsonResponse({ message: 'Not Found' }, 404, rateHeaders());
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    }

    const answer = sites[url.href];
    if (answer === undefined) return siteResponse(404);
    if (typeof answer === 'function') return answer(init, method);
    if (typeof answer === 'number') return siteResponse(answer);
    return answer;
  }

  return { fetch, calls };
}

// The 13 starter sites as GitHub would list them, with made-up ids.
export const STARTER_NAMES = [
  'groundwork',
  'julias-garden-year',
  'boston-local-guide',
  'sofia-somerville-guide',
  'asheville-highlands-guide',
  'asheville-locals-guide',
  'torquay-local-guide',
  'natick-local-guide',
  'monhegan-island-guide',
  'magnolia-house-guide',
  'watercalculator',
  'gwyn-college-hq',
  'gwyn-babysitting-tutoring',
];

export function starterRepos(startId = 5000) {
  return STARTER_NAMES.map((name, i) => repo(startId + i, name));
}

export function publishedSites(repos) {
  return Object.fromEntries(repos.filter((r) => r.has_pages).map((r) => [pagesUrl(r.name), 200]));
}
