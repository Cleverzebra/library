// A small static server that behaves like GitHub Pages for the library:
// the site lives under a repository subpath, a folder URL without its
// trailing slash redirects, unknown paths are 404, and files are sent with
// GitHub's ten-minute cache header.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const DOCS_DIR = fileURLToPath(new URL('../../docs/', import.meta.url));

/**
 * mounts: { '/cleverzebra-library/': '/path/to/docs' }. The root can be
 * swapped while running (server.setRoot) to simulate a new deployment.
 */
export async function startServer({ mounts = { '/cleverzebra-library/': DOCS_DIR }, port = 0 } = {}) {
  const roots = new Map(Object.entries(mounts));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    for (const [base, root] of roots) {
      if (path === base.slice(0, -1)) {
        res.writeHead(301, { Location: base + url.search });
        res.end();
        return;
      }
      if (!path.startsWith(base)) continue;
      let file = normalize(join(root, path.slice(base.length)));
      if (!file.startsWith(normalize(root).replace(/[\\/]$/, '') + sep) && file !== normalize(root)) break;
      try {
        let info = await stat(file);
        if (info.isDirectory()) {
          if (!path.endsWith('/')) {
            res.writeHead(301, { Location: `${path}/${url.search}` });
            res.end();
            return;
          }
          file = join(file, 'index.html');
          info = await stat(file);
        }
        const body = await readFile(file);
        res.writeHead(200, {
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'max-age=600',
          'Access-Control-Allow-Origin': '*',
          'Last-Modified': info.mtime.toUTCString(),
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      } catch {
        break;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(req.method === 'HEAD' ? undefined : '<h1>404</h1><p>File not found</p>');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actualPort } = server.address();
  return {
    origin: `http://localhost:${actualPort}`,
    setRoot(base, root) {
      roots.set(base, root);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = await startServer({ port });
  console.log(`Library at ${server.origin}/cleverzebra-library/`);
}
