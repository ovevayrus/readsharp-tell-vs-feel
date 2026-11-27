import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, plan, featureId, findDrift, assertNoChildProcessDebug, FLAGS, METRICS, EXPERIMENTS } from './setup-flagsmith.mjs';

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
	assert.throws(() => parseArgs(['--env', 'development', '--create-experiment', 'nope']), /No experiment is defined for that flag\. Allowed flags: speed_test_next_step, aa_check/);
	assert.throws(() => parseArgs(['--env', 'development', '--create-experiment', 'SECRET-xyz']), (e) => !e.message.includes('SECRET-xyz'));
	assert.throws(() => parseArgs(['--env', 'development', '--SECRET-xyz']), (e) => !e.message.includes('SECRET-xyz'));
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

// ---- drift validation ----

const spec = { flags: FLAGS, metrics: METRICS, experiments: EXPERIMENTS };
const goodMetrics = METRICS.map((m, i) => ({ id: 100 + i, name: m.name, aggregation: m.aggregation, direction: m.direction, definition: { event: m.event } }));
const goodDetail = {
	id: 958,
	experiment_rollout: { rollout_percentage: 100, multivariate_feature_state_values: [{ percentage_allocation: 50 }] },
	metrics: EXPERIMENTS.speed_test_next_step.metrics.map((m) => ({ metric: { id: 100 + METRICS.findIndex((x) => x.name === m.metric) }, expected_direction: m.expected_direction })),
};
const goodState = () => ({
	features: [{ id: 1, name: 'speed_test_next_step', variants: [{ key: 'feel' }] }, { id: 2, name: 'aa_check', variants: [{ key: 'b' }] }],
	metrics: structuredClone(goodMetrics),
	experiments: [{ id: 958, feature: { id: 1 }, status: 'running' }],
	experimentDetails: { 958: structuredClone(goodDetail) },
});

test('findDrift: a matching setup has no problems', () => {
	assert.deepEqual(findDrift(spec, goodState(), { complete: true }), []);
});

test('findDrift: a metric with the wrong event, aggregation or direction is drift naming the metric', () => {
	const state = goodState();
	state.metrics[0].definition.event = 'something_else';
	const problems = findDrift(spec, state);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /metric get_readsharp drift: event/);
	const other = goodState();
	other.metrics[1].aggregation = 'sum';
	other.metrics[2].direction = 'up';
	assert.equal(findDrift(spec, other).length, 2);
});

test('findDrift: an extra or stale variant is drift; a missing one only when complete', () => {
	const extra = goodState();
	extra.features[0].variants.push({ key: 'stale' });
	assert.match(findDrift(spec, extra)[0], /speed_test_next_step drift: it has variants/);
	const missing = goodState();
	missing.features[1].variants = [];
	assert.deepEqual(findDrift(spec, missing), []);
	assert.match(findDrift(spec, missing, { complete: true })[0], /aa_check drift/);
});

test('findDrift: an active experiment with the wrong rollout or split is drift', () => {
	const rollout = goodState();
	rollout.experimentDetails[958].experiment_rollout.rollout_percentage = 50;
	assert.match(findDrift(spec, rollout)[0], /rollout is not 100%/);
	const split = goodState();
	split.experimentDetails[958].experiment_rollout.multivariate_feature_state_values = [{ percentage_allocation: 30 }];
	assert.match(findDrift(spec, split)[0], /split is not an even 50%/);
});

test('findDrift: an active experiment with the wrong metrics, or no readable detail, is drift', () => {
	const metrics = goodState();
	metrics.experimentDetails[958].metrics.pop();
	assert.match(findDrift(spec, metrics)[0], /metrics differ/);
	const direction = goodState();
	direction.experimentDetails[958].metrics[0].expected_direction = 'decrease';
	assert.match(findDrift(spec, direction)[0], /metrics differ/);
	const unread = goodState();
	unread.experimentDetails = {};
	assert.match(findDrift(spec, unread)[0], /detail could not be read/);
	const ended = goodState();
	ended.experiments[0].status = 'ended';
	ended.experimentDetails = {};
	assert.deepEqual(findDrift(spec, ended), []);
});

test('setup refuses to run when NODE_DEBUG mentions child_process', () => {
	assert.throws(() => assertNoChildProcessDebug({ NODE_DEBUG: 'http,child_process' }), /NODE_DEBUG/);
	assert.doesNotThrow(() => assertNoChildProcessDebug({ NODE_DEBUG: 'http' }));
	assert.doesNotThrow(() => assertNoChildProcessDebug({}));
});
