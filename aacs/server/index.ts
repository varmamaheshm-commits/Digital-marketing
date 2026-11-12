// AI Agent Creator Suite - server entry point. Serves the REST API under /api and the built web portal.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, purgeExpired } from './api.ts';
import { startScheduler } from './engine.ts';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const SECURITY = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) file = path.join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }).end('The web portal has not been built yet. Run: npm run build'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(readFileSync(file));
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +(process.env.PORT ?? 8787);
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`AACS listening on http://${process.env.HOST ?? '127.0.0.1'}:${port}`));
  startScheduler();
  purgeExpired();
  setInterval(purgeExpired, 6 * 3600 * 1000).unref();
}
