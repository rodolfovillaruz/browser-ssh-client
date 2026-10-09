// Static dev server for installing the app as an Isolated Web App in dev-mode proxy.
// Uses only Node built-ins. Serves the project root on http://localhost:8787.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Only these top-level paths are part of the app; everything else (tests, dev tooling) is hidden.
const PUBLIC = ['index.html', 'styles.css', 'src/', 'icons/', '.well-known/'];

// IWAs must be cross-origin isolated; these mirror what a signed bundle gets.
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const file = path.resolve(ROOT, rel);
  // Check the allow-list against the resolved path so "src/..%2f" style tricks cannot escape it.
  const resolved = path.relative(ROOT, file).split(path.sep).join('/');

  const allowed = !resolved.startsWith('..') && PUBLIC.some((p) => resolved === p || resolved.startsWith(p));
  try {
    if (!allowed || !(await stat(file)).isFile()) throw new Error('not found');
    const body = await readFile(file);
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' });
    res.end('not found');
  }
  console.log(`${res.statusCode} ${req.method} ${url.pathname}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT} on http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log('Install: chrome://web-app-internals → "Install IWA via Dev Mode Proxy"');
});
