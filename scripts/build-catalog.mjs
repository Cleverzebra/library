// Used by the optional "Publish library" workflow. It runs the same discovery
// as the page, but on GitHub's servers with the workflow's built-in token
// (a higher hourly limit, and no browser restrictions), then publishes the
// result with the site as data/catalog.json. Pages that can't reach GitHub's
// API themselves start from this catalog.
//
// Environment (set by the workflow):
//   GITHUB_TOKEN        the workflow's built-in token; sent only to api.github.com
//   GITHUB_REPOSITORY   owner/name of this library repository
//   LIBRARY_REPO_ID     this repository's numeric id
//   EVENT_NAME          push, schedule, or workflow_dispatch
//   OUT_DIR             where to write the site to deploy (default: _site)
// Writes deploy=true|false to $GITHUB_OUTPUT.

import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../docs/js/config.js';
import { discover, safeHttpsUrl } from '../docs/js/discovery.js';
import { emptyState, findEntry, mergeDiscovery, mergeSnapshot, reviveSnapshot, stateToSnapshot } from '../docs/js/catalog.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function apiHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function pagesSettings({ fetch, apiBase, repository, token }) {
  const res = await fetch(`${apiBase}/repos/${repository}/pages`, { headers: apiHeaders(token) });
  if (res.status === 404) return { ok: false, reason: 'GitHub Pages is not turned on for this repository' };
  if (!res.ok) return { ok: false, reason: `could not read the Pages settings (HTTP ${res.status})` };
  const data = await res.json();
  return { ok: true, buildType: data.build_type, url: safeHttpsUrl(data.html_url) };
}

async function fetchLiveCatalog(fetch, pagesUrl) {
  if (!pagesUrl) return null;
  try {
    const res = await fetch(new URL('data/catalog.json', pagesUrl).href, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    return reviveSnapshot(await res.json());
  } catch {
    return null;
  }
}

// What a deployment would change for visitors, plus the missed-check counts
// that the two-check removal rule needs to carry between runs.
export function catalogSignature(snapshot) {
  return JSON.stringify(
    [...(snapshot?.sites ?? [])]
      .map((s) => [s.repoId, s.name, s.url, s.description, s.topics, s.firstSeen, s.baseline, s.misses])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
}

export async function buildCatalog({ fetch, env, now = () => Date.now(), readCommittedCatalog }) {
  const apiBase = CONFIG.apiBase;
  const token = env.GITHUB_TOKEN || null;
  const repository = env.GITHUB_REPOSITORY || `${CONFIG.owner}/${CONFIG.libraryRepoNames[0]}`;
  const repoName = repository.split('/')[1];
  const libraryRepoId = Number(env.LIBRARY_REPO_ID) || CONFIG.libraryRepoId;
  const event = env.EVENT_NAME || 'workflow_dispatch';
  const nowIso = new Date(now()).toISOString();

  const pages = await pagesSettings({ fetch, apiBase, repository, token });
  if (!pages.ok) return { deploy: false, reason: pages.reason };
  if (pages.buildType !== 'workflow') {
    return { deploy: false, reason: 'Pages deploys from a branch, so this workflow has nothing to publish' };
  }

  // The published catalog carries this workflow's history (first-seen dates,
  // missed checks). The committed starter list only seeds the first run;
  // merging it every time would bring back sites the workflow removed.
  const live = await fetchLiveCatalog(fetch, pages.url);
  const base = live?.generatedBy === 'workflow' ? live : reviveSnapshot(readCommittedCatalog());
  const state = mergeSnapshot(emptyState(), base).state;

  const result = await discover({
    owner: CONFIG.owner,
    fetch,
    apiBase,
    token,
    excludeRepoIds: [libraryRepoId],
    excludeRepoNames: [...CONFIG.libraryRepoNames, repoName],
    isKnown: (repo) => Boolean(findEntry(state, { id: repo.id, name: repo.name })),
    now,
  });
  const merged = mergeDiscovery(state, result, { now: nowIso, missesToRemove: CONFIG.missesToRemove });
  const snapshot = stateToSnapshot(merged.state, { generatedAt: nowIso, owner: CONFIG.owner });
  const changed = !live || catalogSignature(snapshot) !== catalogSignature(live);

  // A push or a manual run always publishes (the site itself may have changed).
  // A scheduled run publishes only when the catalog changed and the check worked.
  const deploy = event !== 'schedule' || (changed && result.outcome !== 'failed');
  return { deploy, changed, outcome: result.outcome, reason: result.reason, added: merged.added, removed: merged.removed, snapshot, pagesUrl: pages.url };
}

function summary(outcome) {
  const lines = ['## Library catalog', ''];
  if (!outcome.snapshot) {
    lines.push(`Nothing to publish: ${outcome.reason}.`);
    return lines.join('\n');
  }
  lines.push(`Check: **${outcome.outcome}**${outcome.reason ? ` (${outcome.reason})` : ''}`);
  lines.push(`Sites listed: ${outcome.snapshot.sites.length}`);
  if (outcome.added.length) lines.push(`New: ${outcome.added.join(', ')}`);
  if (outcome.removed.length) lines.push(`Removed after two confirmed checks: ${outcome.removed.join(', ')}`);
  lines.push(`Publishing: ${outcome.deploy ? 'yes' : 'no'}${outcome.changed ? '' : ' (catalog unchanged)'}`);
  return lines.join('\n');
}

async function main() {
  const env = process.env;
  const outcome = await buildCatalog({
    fetch: globalThis.fetch,
    env,
    readCommittedCatalog: () => JSON.parse(readFileSync(join(ROOT, 'docs/data/catalog.json'), 'utf8')),
  });
  if (outcome.snapshot && outcome.deploy) {
    const outDir = join(ROOT, env.OUT_DIR || '_site');
    rmSync(outDir, { recursive: true, force: true });
    cpSync(join(ROOT, 'docs'), outDir, { recursive: true });
    mkdirSync(join(outDir, 'data'), { recursive: true });
    writeFileSync(join(outDir, 'data/catalog.json'), `${JSON.stringify(outcome.snapshot, null, 2)}\n`);
  }
  const text = summary(outcome);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `deploy=${outcome.deploy ? 'true' : 'false'}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
