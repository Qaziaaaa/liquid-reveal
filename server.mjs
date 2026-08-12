// Minimal static file server so the WebGL demo can run.
// The effect breaks over file:// (Chrome taints local images and WebGL
// texture upload throws), so it must be served over HTTP:
//   node server.mjs   ->  http://localhost:4000
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = import.meta.dirname;
const port = Number(process.env.PORT) || 4000;
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) throw new Error('bad path');
    const data = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const isHtml = type.startsWith('text/html');
    res.writeHead(200, {
      'content-type': type,
      ...SECURITY_HEADERS,
      /* HTML and the service worker must always revalidate; everything else
         is content-addressed by filename and safe to cache for a week */
      'cache-control': (isHtml || p.endsWith('sw.js'))
        ? 'no-cache'
        : 'public, max-age=604800',
    });
    res.end(data);
  } catch {
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      ...SECURITY_HEADERS,
    });
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`ripple demo: http://localhost:${port}`);
});
