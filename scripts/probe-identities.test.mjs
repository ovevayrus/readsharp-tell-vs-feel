import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, newSummary, parseArgs, tally } from './probe-identities.mjs';

const response = (value, variant, experiment, reason = 'TARGETING_MATCH') => ({
	flags: [
		{ feature: { name: 'other' }, feature_state_value: 'x', variant: null, reason: 'DEFAULT' },
		{ feature: { name: 'speed_test_next_step' }, feature_state_value: value, variant, reason, ...(experiment ? { metadata: { experiment } } : {}) },
	],
});

test('parseArgs applies defaults and validates', () => {
	assert.deepEqual(parseArgs(['--env', 'development', '--flag', 'f']), { env: 'development', flag: 'f', n: 40, transient: false });
	assert.equal(parseArgs(['--env', 'production', '--flag', 'f', '--transient', '--n', '5']).n, 5);
	assert.throws(() => parseArgs(['--flag', 'f']), /--env must be/);
	assert.throws(() => parseArgs(['--env', 'development']), /--flag is required/);
	assert.throws(() => parseArgs(['--env', 'development', '--flag', 'f', '--n', '0']), /--n must be/);
	assert.throws(() => parseArgs(['--env', 'development', '--flag', 'f', '--n', '501']), /--n must be/);
});

test('production without --transient is refused; with it, accepted', () => {
	assert.throws(() => parseArgs(['--env', 'production', '--flag', 'f']), /requires --transient/);
	assert.equal(parseArgs(['--env', 'production', '--flag', 'f', '--transient']).transient, true);
});

test('validation messages never echo raw argument values', () => {
	assert.throws(() => parseArgs(['--env', 'SECRET-xyz', '--flag', 'f']), (e) => !e.message.includes('SECRET-xyz'));
	assert.throws(() => parseArgs(['--SECRET-xyz']), (e) => !e.message.includes('SECRET-xyz') && /Unknown argument/.test(e.message));
	assert.throws(() => parseArgs(['--env', 'development', '--flag', 'f', '--n', 'SECRET-xyz']), (e) => !e.message.includes('SECRET-xyz'));
});

test('tally counts values, variants, reasons and experiment membership from the real response shape', () => {
	const summary = newSummary({ env: 'development', flag: 'speed_test_next_step', transient: true, n: 3 });
	const experiment = { id: 958, in_experiment: true, name: 'Tell vs Feel' };
	tally(summary, response('feel', 'feel', experiment, 'SPLIT'), 'speed_test_next_step');
	tally(summary, response('tell', 'control', { ...experiment, in_experiment: false }, 'SPLIT'), 'speed_test_next_step');
	tally(summary, response('tell', null, undefined, 'DEFAULT'), 'speed_test_next_step');
	tally(summary, { flags: [] }, 'speed_test_next_step');
	assert.deepEqual(summary.values, { feel: 1, tell: 2, '(missing)': 1 });
	assert.deepEqual(summary.variants, { feel: 1, control: 1, '(none)': 2 });
	assert.deepEqual(summary.reasons, { SPLIT: 2, DEFAULT: 1, '(none)': 1 });
	assert.equal(summary.inExperiment, 1);
	assert.equal(summary.experimentPresent, 2);
	assert.deepEqual(summary.experiments, [{ id: 958, label: 'Tell vs Feel' }]);
});

test('main prints only counts and the experiment id/label, with no raw flag shape', async () => {
	const keyName = 'FS_DEV_CLIENT_KEY';
	const fixture = ['client', 'probe-fixture'].join('.');
	const before = process.env[keyName];
	process.env[keyName] = fixture;
	const logged = [];
	const original = console.log;
	console.log = (line) => logged.push(line);
	const urls = [];
	try {
		const fetchImpl = async (url) => {
			urls.push(String(url));
			return { status: 200, json: async () => response('feel', 'feel', { id: 958, in_experiment: true, name: 'Tell vs Feel' }, 'SPLIT') };
		};
		const summary = await main(['--env', 'development', '--flag', 'speed_test_next_step', '--n', '3', '--transient'], fetchImpl);
		assert.equal(summary.inExperiment, 3);
	} finally {
		console.log = original;
		if (before === undefined) delete process.env[keyName]; else process.env[keyName] = before;
	}
	assert.ok(urls.every((u) => u.includes('transient=true')));
	const printed = JSON.parse(logged[0]);
	assert.ok(!('sampleFlagShape' in printed));
	assert.ok(!logged[0].includes(fixture));
	assert.equal(printed.http['200'], 3);
});
