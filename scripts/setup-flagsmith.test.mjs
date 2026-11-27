import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, plan, featureId, FLAGS, METRICS, EXPERIMENTS } from './setup-flagsmith.mjs';

const types = (actions) => actions.map((a) => a.type);

test('parseArgs accepts development and production, and rejects anything else', () => {
	assert.equal(parseArgs(['--env', 'development']).env, 'development');
	assert.equal(parseArgs(['--env', 'production']).env, 'production');
	assert.throws(() => parseArgs([]), /--env must be/);
	assert.throws(() => parseArgs(['--env', 'staging']), /--env must be/);
	assert.throws(() => parseArgs(['--env', 'development', '--bogus']), /Unknown argument/);
});

test('--create-experiment is refused outside Development', () => {
	assert.throws(() => parseArgs(['--env', 'production', '--create-experiment', 'speed_test_next_step']), /only with --env development/);
	assert.equal(parseArgs(['--env', 'development', '--create-experiment', 'aa_check']).createExperiment, 'aa_check');
	assert.throws(() => parseArgs(['--env', 'development', '--create-experiment', 'nope']), /No experiment is defined/);
	assert.throws(() => parseArgs(['--env', 'development', '--start']), /--start needs --create-experiment/);
});

test('the flag spec keeps every variation keyed and the metrics match the plan', () => {
	const flag = FLAGS.find((f) => f.name === 'speed_test_next_step');
	assert.equal(flag.control, 'tell');
	assert.deepEqual(flag.variants, [{ value: 'feel', key: 'feel' }]);
	assert.deepEqual(METRICS.map((m) => [m.name, m.event, m.aggregation, m.direction]), [
		['get_readsharp', 'get_readsharp', 'occurrence', 'up'],
		['result_shared', 'result_shared', 'occurrence', 'up'],
		['installer_download', 'installer_download', 'occurrence', 'informational'],
	]);
	assert.deepEqual(EXPERIMENTS.speed_test_next_step.metrics, [
		{ metric: 'get_readsharp', expected_direction: 'increase' },
		{ metric: 'result_shared', expected_direction: 'not_decrease' },
		{ metric: 'installer_download', expected_direction: 'increase' },
	]);
	assert.ok(!FLAGS.find((f) => f.name === 'aa_check').environments.includes('production'));
});

const empty = { features: [], featureStates: {}, metrics: [], experiments: [] };

test('an empty Development environment gets flags, states and metrics, and no experiment unless asked', () => {
	assert.deepEqual(types(plan({ env: 'development' }, empty)), [
		'create-feature', 'add-variant', 'set-feature-state',
		'create-feature', 'add-variant', 'set-feature-state',
		'create-metric', 'create-metric', 'create-metric',
	]);
	assert.ok(types(plan({ env: 'development', createExperiment: 'speed_test_next_step', start: true }, empty)).includes('create-experiment'));
});

test('Production setup never touches aa_check and never plans an experiment', () => {
	const actions = plan({ env: 'production' }, empty);
	assert.ok(actions.every((a) => a.flag?.name !== 'aa_check'));
	assert.ok(!types(actions).some((t) => t.includes('experiment')));
});

const done = {
	features: [
		{ id: 1, name: 'speed_test_next_step', variants: [{ id: 11, key: 'feel' }] },
		{ id: 2, name: 'aa_check', variants: [{ id: 21, key: 'b' }] },
	],
	featureStates: {
		speed_test_next_step: { enabled: true, value: 'tell', allocations: [{ percentage_allocation: 0 }] },
		aa_check: { enabled: true, value: 'a', allocations: [{ percentage_allocation: 0 }] },
	},
	metrics: METRICS.map((m, i) => ({ id: 100 + i, name: m.name })),
	// The experiments list nests the feature as an object.
	experiments: [
		{ id: 958, feature: { id: 1, name: 'speed_test_next_step' }, status: 'running' },
		{ id: 965, feature: { id: 2, name: 'aa_check' }, status: 'running' },
	],
};

test('a second run creates nothing (idempotent), including with --create-experiment --start', () => {
	assert.deepEqual(plan({ env: 'development' }, done), []);
	assert.deepEqual(plan({ env: 'development', createExperiment: 'speed_test_next_step', start: true }, done), []);
	assert.deepEqual(plan({ env: 'development', createExperiment: 'aa_check', start: true }, done), []);
});

test('a created but unstarted experiment is started, not duplicated', () => {
	const state = { ...done, experiments: [{ id: 958, feature: { id: 1 }, status: 'created' }] };
	assert.deepEqual(types(plan({ env: 'development', createExperiment: 'speed_test_next_step', start: true }, state)), ['start-experiment']);
});

test('an ended experiment does not block a new one, and a running one locks the flag state', () => {
	const ended = { ...done, experiments: [{ id: 1, feature: 1, status: 'ended' }] };
	assert.deepEqual(types(plan({ env: 'development', createExperiment: 'speed_test_next_step' }, ended)), ['create-experiment']);
	const drifted = { ...done, featureStates: { ...done.featureStates, speed_test_next_step: { enabled: true, value: 'tell', allocations: [{ percentage_allocation: 50 }] } } };
	assert.deepEqual(plan({ env: 'development' }, drifted), [], 'flag is locked while its experiment runs');
	const unlocked = { ...drifted, experiments: [] };
	assert.deepEqual(types(plan({ env: 'development' }, unlocked)), ['set-feature-state']);
});

test('featureId reads nested and bare feature references', () => {
	assert.equal(featureId({ feature: { id: 7 } }), 7);
	assert.equal(featureId({ feature: 7 }), 7);
});
