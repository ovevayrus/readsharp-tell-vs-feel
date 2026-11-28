import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, CSP } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const FAKE_KEY = 'FAKEKEY1234567890abcdef';
const PLACEHOLDER = '__FS_DEV_CLIENT_KEY__';

function runServer(env) {
  const base = { ...process.env, DEMO_PORT: '0' };
  delete base.FS_DEV_CLIENT_KEY;
  return spawnSync(process.execPath, [SERVER], { env: { ...base, ...env }, encoding: 'utf8', timeout: 10000 });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    // http.request with a raw path so encoded and dot segments reach the server unchanged.
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const server = createServer({ key: FAKE_KEY });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('refuses to start without FS_DEV_CLIENT_KEY', () => {
  const result = runServer({});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FS_DEV_CLIENT_KEY/);
});

test('refuses a server-side key without echoing it', () => {
  const serverKey = 'ser.SECRETVALUE123';
  const result = runServer({ FS_DEV_CLIENT_KEY: serverKey });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FS_DEV_CLIENT_KEY/);
  assert.ok(!result.stderr.includes('SECRETVALUE123'));
  assert.ok(!result.stdout.includes('SECRETVALUE123'));
});

test('serves /demo/ with the key injected in memory, file on disk keeps the placeholder', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/demo/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.body.includes(FAKE_KEY));
    assert.ok(!res.body.includes(PLACEHOLDER));
  });
  const onDisk = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
  assert.ok(onDisk.includes(PLACEHOLDER));
  assert.ok(!onDisk.includes(FAKE_KEY));
});

test('serves module files with JavaScript content types', async () => {
  await withServer(async (port) => {
    const vendor = await get(port, '/vendor/flagsmith.mjs');
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers['content-type'], /text\/javascript/);
    const eligibility = await get(port, '/eligibility.js');
    assert.equal(eligibility.status, 200);
    assert.match(eligibility.headers['content-type'], /text\/javascript/);
    const demo = await get(port, '/demo/demo.js');
    assert.equal(demo.status, 200);
    assert.ok(!demo.body.includes(FAKE_KEY));
  });
});

test('blocks traversal and anything outside web/ and the vendor file', async () => {
  await withServer(async (port) => {
    const paths = [
      '/../package.json',
      '/demo/../../package.json',
      '/%2e%2e/package.json',
      '/%2E%2E%2Fpackage.json',
      '/demo/%2e%2e/%2e%2e/package.json',
      '/..%5Cpackage.json',
      '/%252e%252e/package.json',
      '/demo/..%2f..%2fpackage.json',
      '/vendor/../package.json',
      '/vendor/flagsmith.mjs.map',
      '/vendor/other.mjs',
      '/node_modules/@flagsmith/flagsmith/index.mjs',
      '/package.json',
      '/%00',
      '/demo/%00.js',
      '/nope.js',
    ];
    for (const p of paths) {
      const res = await get(port, p);
      assert.equal(res.status, 404, `expected 404 for ${p}`);
      assert.ok(!res.body.includes('readsharp-tell-vs-feel'), `leaked package.json via ${p}`);
    }
  });
});

test('CSP allows only self and the two Flagsmith origins for connections', async () => {
  await withServer(async (port) => {
    const res = await get(port, '/demo/');
    const csp = res.headers['content-security-policy'];
    assert.equal(csp, CSP);
    assert.match(csp, /connect-src 'self' https:\/\/edge\.api\.flagsmith\.com https:\/\/events\.api\.flagsmith\.com/);
  });
});

test('the real process prints only the URL and never the key', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FS_DEV_CLIENT_KEY: FAKE_KEY, DEMO_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
      child.stdout.on('data', (c) => {
        out += c;
        if (out.includes('\n')) {
          clearTimeout(timer);
          resolve(out.trim());
        }
      });
      child.on('exit', () => reject(new Error('server exited')));
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/demo\/$/);
    const res = await get(Number(new URL(url).port), '/demo/');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(FAKE_KEY));
  } finally {
    child.kill();
  }
  assert.ok(!out.includes(FAKE_KEY));
  assert.ok(!err.includes(FAKE_KEY));
});
