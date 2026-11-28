import assert from 'node:assert/strict';
import test from 'node:test';
import { main, parseArgs, tally } from './served-value.mjs';

test('parseArgs needs a flag and bounds --n', () => {
	assert.deepEqual(parseArgs(['--flag', 'effect_check']), { flag: 'effect_check', n: 20 });
	assert.equal(parseArgs(['--flag', 'effect_check', '--n', '5']).n, 5);
	assert.throws(() => parseArgs([]), /--flag is required/);
	assert.throws(() => parseArgs(['--flag', 'x', '--n', '0']), /--n must be/);
	assert.throws(() => parseArgs(['--flag', 'x', '--n', '201']), /--n must be/);
	assert.throws(() => parseArgs(['--flag', 'x', '--bogus']), /Unknown argument/);
});

test('tally counts each served value', () => {
	assert.deepEqual(tally(['b', 'b', 'a', null]), { b: 2, a: 1, null: 1 });
});

test('main refuses without the Development checks, before creating a client', async () => {
	let created = false;
	await assert.rejects(
		main(['--flag', 'effect_check'], { env: {}, fetchImpl: async () => { throw new Error('no network'); }, createClient: () => { created = true; } }),
	);
	assert.equal(created, false);
});

test('main reports the environment default and fresh-identity values, with remote evaluation', async () => {
	const env = { SIM_ENV: 'development', FS_DEV_SERVER_KEY: 'ser.fake-key-value', DEV_ENV_ID: '7' };
	const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 7 }) });
	let config;
	const flags = (value) => ({ getFeatureValue: (name) => (name === 'effect_check' ? value : null) });
	const createClient = (c) => {
		config = c;
		return { getEnvironmentFlags: async () => flags('b'), getIdentityFlags: async () => flags('b'), close: async () => {} };
	};
	const summary = await main(['--flag', 'effect_check', '--n', '3'], { env, fetchImpl, createClient, uuid: () => 'u' });
	assert.equal(config.enableLocalEvaluation, false);
	assert.equal(summary.environmentDefault, 'b');
	assert.deepEqual(summary.values, { b: 3 });
	assert.ok(!JSON.stringify(summary).includes('fake-key-value'));
});
