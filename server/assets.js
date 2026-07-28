/**
 * Stand-in for the Workers `env.ASSETS` binding: serves public/ from disk with
 * the same single-page-application fallback wrangler.toml configures.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function createAssets(root) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      // Refuse to escape the asset root.
      const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
      const full = join(root, rel);
      if (!full.startsWith(root)) {
        return new Response('Forbidden', { status: 403 });
      }

      try {
        const s = await stat(full);
        if (s.isFile()) {
          const body = await readFile(full);
          return new Response(body, {
            headers: {
              'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
              'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
            },
          });
        }
      } catch (_) { /* fall through to SPA */ }

      try {
        const html = await readFile(join(root, 'index.html'));
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      } catch (_) {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}
