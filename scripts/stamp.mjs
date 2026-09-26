// Sets the service worker's VERSION from the contents of the files it caches,
// so every change to the library reaches installed copies through the
// "new version" prompt. Run after editing anything under docs/ except data/:
//
//   node scripts/stamp.mjs
//
// The unit tests fail if VERSION is out of date.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
export const SW_PATH = join(DOCS_DIR, 'sw.js');

export function readShellFiles(swSource) {
  const block = swSource.match(/\/\/ BEGIN SHELL FILES\n([\s\S]*?)\/\/ END SHELL FILES/);
  if (!block) throw new Error('The SHELL FILES block is missing from sw.js');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export function readVersion(swSource) {
  return swSource.match(/^const VERSION = '([0-9a-f]+)';$/m)?.[1] ?? null;
}

// Hashes the cached files plus the service worker itself (without its VERSION line).
export function computeVersion(swSource, docsDir = DOCS_DIR) {
  const hash = createHash('sha256');
  for (const file of readShellFiles(swSource)) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(docsDir, file)));
    hash.update('\0');
  }
  hash.update(swSource.replace(/^const VERSION = '[0-9a-f]+';$/m, ''));
  return hash.digest('hex').slice(0, 12);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = readFileSync(SW_PATH, 'utf8');
  const version = computeVersion(source);
  if (readVersion(source) === version) {
    console.log(`sw.js VERSION is current (${version})`);
  } else {
    writeFileSync(SW_PATH, source.replace(/^const VERSION = '[0-9a-f]+';$/m, `const VERSION = '${version}';`));
    console.log(`sw.js VERSION set to ${version}`);
  }
}
