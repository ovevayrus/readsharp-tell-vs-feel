import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLACEHOLDER_KEY, candidates, headersFor, injectKey, matches, parseHeaders } from './serve-dist.mjs';

const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; connect-src https://edge.api.flagsmith.com
  X-Content-Type-Options: nosniff

/download.html
  Cache-Control: no-cache
`;

test('parses _headers rules and applies every matching rule in order', () => {
	const rules = parseHeaders(HEADERS);
	assert.equal(rules.length, 2);
	const all = headersFor(rules, '/reading-speed-test');
	assert.match(all.get('Content-Security-Policy'), /connect-src https:\/\/edge\.api\.flagsmith\.com/);
	assert.equal(all.get('X-Content-Type-Options'), 'nosniff');
	assert.equal(headersFor(rules, '/download.html').get('Cache-Control'), 'no-cache');
	assert.equal(headersFor(rules, '/index.html').get('Cache-Control'), undefined);
});

test('splat patterns match like Cloudflare Pages', () => {
	assert.ok(matches('/*', '/a/b.html'));
	assert.ok(matches('/guides/*', '/guides/x'));
	assert.ok(!matches('/guides/*', '/help.html'));
});

test('pretty URLs resolve to .html files', () => {
	assert.deepEqual(candidates('/reading-speed-test'), ['/reading-speed-test.html', '/reading-speed-test/index.html', '/reading-speed-test']);
	assert.deepEqual(candidates('/'), ['/index.html']);
	assert.deepEqual(candidates('/site.css?v=1'), ['/site.css']);
});

test('the key is injected only into empty data-flagsmith-env attributes, and sanitised', () => {
	assert.equal(injectKey('<div data-flagsmith-env=""></div>', 'abcDEF123'), '<div data-flagsmith-env="abcDEF123"></div>');
	assert.equal(injectKey('<div data-flagsmith-env=""></div>', 'a"><script>'), '<div data-flagsmith-env="ascript"></div>');
	assert.equal(injectKey('<div data-flagsmith-env=""></div>', ''), '<div data-flagsmith-env=""></div>');
	assert.equal(injectKey(`<div data-flagsmith-env="${PLACEHOLDER_KEY}"></div>`, 'realKey1'), '<div data-flagsmith-env="realKey1"></div>');
});
