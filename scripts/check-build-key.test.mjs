import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyProblems } from './check-build-key.mjs';

const page = (...keys) => keys.map((k) => `<div data-experiment data-flagsmith-env="${k}"></div>`).join('');

test('a build carrying exactly the expected key passes', () => {
	assert.deepEqual(keyProblems(page('devKey123'), 'devKey123'), []);
});

test('a different, missing or empty key fails, without echoing any key', () => {
	const wrong = keyProblems(page('prodKey456'), 'devKey123');
	assert.match(wrong.join(), /different Flagsmith key/);
	assert.ok(!wrong.join().includes('prodKey456') && !wrong.join().includes('devKey123'));
	assert.match(keyProblems('<p>no experiment</p>', 'devKey123').join(), /no Flagsmith key/);
	assert.match(keyProblems(page(''), 'devKey123').join(), /different/);
	assert.match(keyProblems(page('devKey123'), '').join(), /expected key is empty/);
	assert.match(keyProblems(page('devKey123', 'other'), 'devKey123').join(), /different/);
});
