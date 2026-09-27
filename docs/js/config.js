// Settings shared by the page, the service worker's companion scripts, and the
// optional publishing workflow. Nothing here is secret.

export const CONFIG = Object.freeze({
  // GitHub account whose Pages sites the library lists.
  owner: 'Cleverzebra',

  // This library's own repository, excluded from the list. The numeric id stays
  // the same if the repository is renamed; the names are a second safeguard.
  libraryRepoId: 1388362103,
  libraryRepoNames: ['cleverzebra-library'],

  apiBase: 'https://api.github.com',

  // Open the library and the last successful check is older than this: check again.
  checkIntervalMs: 60 * 60 * 1000,
  // After a failed or unfinished check, wait at least this long before an automatic retry.
  retryBackoffMs: 5 * 60 * 1000,

  // How long a newly discovered site keeps its "Recently added" badge.
  recentDays: 14,
  // A listed site is removed only after this many complete checks in a row
  // confirm it is no longer published.
  missesToRemove: 2,

  // Every localStorage key, cache name, and database used by the library starts
  // with this, so nothing collides with the other Cleverzebra sites on the same origin.
  storagePrefix: 'cleverzebra-library:v1:',
});
