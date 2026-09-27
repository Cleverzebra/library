// Routes the browser's requests to GitHub (API and Pages addresses) to the
// fake GitHub in tests/helpers, so browser tests never reach the real account.

import { mockGitHub } from '../helpers/mock-github.mjs';

const EXPOSED = 'ETag, Link, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Used';

export async function routeGitHub(context, spec = {}) {
  let gh = mockGitHub(spec);
  const handler = async (route) => {
    const request = route.request();
    let res;
    try {
      res = await gh.fetch(request.url(), { method: request.method(), headers: request.headers() });
    } catch {
      await route.abort('failed');
      return;
    }
    const headers = Object.fromEntries(res.headers.entries());
    headers['access-control-allow-origin'] = '*';
    headers['access-control-expose-headers'] = EXPOSED;
    const body = request.method() === 'HEAD' ? '' : Buffer.from(await res.arrayBuffer());
    await route.fulfill({ status: res.status, headers, body });
  };
  await context.route(/^https:\/\/(api\.github\.com|cleverzebra\.github\.io)\//, handler);
  return {
    get calls() {
      return gh.calls;
    },
    // Swap in a different fake GitHub, for example after publishing a new site.
    set(nextSpec) {
      gh = mockGitHub(nextSpec);
    },
  };
}
