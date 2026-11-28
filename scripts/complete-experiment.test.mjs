import assert from 'node:assert/strict';
import test from 'node:test';
import { activeExperiment, completeBody, confirmed, parseArgs } from './complete-experiment.mjs';

test('parseArgs needs a flag and a rollout, is a dry run by default, and refuses Production', () => {
	assert.deepEqual(parseArgs(['--flag', 'effect_check', '--rollout', 'b']), { flag: 'effect_check', rollout: 'b', yes: false });
	assert.equal(parseArgs(['--flag', 'effect_check', '--rollout', 'b', '--yes']).yes, true);
	assert.equal(parseArgs(['--env', 'development', '--flag', 'aa_check', '--rollout', 'control']).rollout, 'control');
	assert.throws(() => parseArgs(['--flag', 'speed_test_next_step', '--rollout', 'feel']), /Only the Development validation flags/);
	assert.throws(() => parseArgs(['--env', 'production', '--flag', 'speed_test_next_step', '--rollout', 'feel']), /Development only/);
	assert.throws(() => parseArgs(['--rollout', 'b']), /--flag is required/);
	assert.throws(() => parseArgs(['--flag', 'effect_check']), /--rollout is required/);
	assert.throws(() => parseArgs(['--flag', '--rollout']), /needs a value/);
	assert.throws(() => parseArgs(['--flag', 'effect_check', '--rollout', 'b', '--force']), /Unknown argument/);
});

test('completeBody maps control, a variation key and disable to the API decision', () => {
	const variants = [{ id: 31, key: 'b' }];
	assert.deepEqual(completeBody('control', variants), { rollout_decision: 'control' });
	assert.deepEqual(completeBody('disable', variants), { rollout_decision: 'disable' });
	assert.deepEqual(completeBody('b', variants), { rollout_decision: 'variant', rollout_variant: 31 });
	assert.throws(() => completeBody('c', variants), /no variation keyed c/);
});

test('activeExperiment picks the one running or paused experiment on the flag', () => {
	const experiments = [
		{ id: 1, feature: { id: 3 }, status: 'completed' },
		{ id: 2, feature: { id: 3 }, status: 'running' },
		{ id: 3, feature: { id: 4 }, status: 'running' },
	];
	assert.equal(activeExperiment(experiments, 3).id, 2);
	assert.throws(() => activeExperiment([{ id: 1, feature: 3, status: 'completed' }], 3), /found 0/);
});

test('confirmed checks the status, the decision and the variant read back', () => {
	const body = { rollout_decision: 'variant', rollout_variant: 31 };
	assert.equal(confirmed({ status: 'completed', rollout_decision: 'variant', rollout_variant: 31 }, body), true);
	assert.equal(confirmed({ status: 'running', rollout_decision: null, rollout_variant: null }, body), false);
	assert.equal(confirmed({ status: 'completed', rollout_decision: 'variant', rollout_variant: 99 }, body), false);
	assert.equal(confirmed({ status: 'completed', rollout_decision: 'control', rollout_variant: null }, { rollout_decision: 'control' }), true);
});
