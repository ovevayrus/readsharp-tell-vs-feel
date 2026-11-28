// Static demo server. Serves web/ and the Flagsmith browser bundle; injects the Development
// client key into the page in memory only. Never logs or writes the key.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..');
const INDEX_FILE = path.join(here, 'index.html');
const VENDOR_FILE = path.resolve(here, '..', '..', 'node_modules', '@flagsmith', 'flagsmith', 'index.mjs');
const PLACEHOLDER = '__FS_DEV_CLIENT_KEY__';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://edge.api.flagsmith.com https://events.api.flagsmith.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Returns an error message (never containing the key) or null when the key may be used. */
export function checkKey(key) {
  if (!key) return 'FS_DEV_CLIENT_KEY is not set. Set it to a Flagsmith Development client-side key.';
  if (key.startsWith('ser.')) return 'FS_DEV_CLIENT_KEY looks like a server-side key. Use a client-side key; server-side keys must never reach a browser.';
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return 'FS_DEV_CLIENT_KEY has unexpected characters.';
  return null;
}

function resolveFile(urlPath) {
  if (urlPath === '/vendor/flagsmith.mjs') return VENDOR_FILE;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const segments = decoded.split('/').slice(1);
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const file = path.resolve(WEB_ROOT, ...segments);
  if (!file.startsWith(WEB_ROOT + path.sep)) return null;
  return file;
}

/** @param {{ key: string }} options */
export function createServer({ key }) {
  return http.createServer((req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
    const urlPath = (req.url || '/').split('?')[0].split('#')[0];
    if (urlPath === '/favicon.ico') return send(204, '');
    const file = resolveFile(urlPath);
    const type = file && TYPES[path.extname(file)];
    if (!file || !type) return send(404, 'Not found');
    fs.readFile(file, (error, data) => {
      if (error) return send(404, 'Not found');
      if (file === INDEX_FILE) {
        return send(200, data.toString('utf8').split(PLACEHOLDER).join(key), type);
      }
      send(200, data, type);
    });
  });
}

function main() {
  const key = process.env.FS_DEV_CLIENT_KEY;
  const problem = checkKey(key);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const port = Number(process.env.DEMO_PORT ?? 4321);
  const server = createServer({ key });
  server.on('error', (error) => {
    console.error(`Could not start the demo server (${error.code ?? 'error'}).`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${server.address().port}/demo/`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
