import assert from 'node:assert/strict';
import { test } from 'node:test';
import { killBody } from './kill-switch.mjs';

const live = {
	id: 1512,
	name: 'Tell vs Feel',
	status: 'running',
	hypothesis: 'h',
	feature: { id: 306526, name: 'speed_test_next_step' },
	metrics: [
		{ id: 1889, metric: 1571, metric_name: 'get_readsharp', expected_direction: 'increase' },
		{ id: 1890, metric: 1572, metric_name: 'result_shared', expected_direction: 'not_decrease' },
	],
	experiment_rollout: {
		enabled: true,
		rollout_percentage: 100,
		feature_state_value: { type: 'string', value: 'tell' },
		multivariate_feature_state_values: [{ multivariate_feature_option: 37718, percentage_allocation: 50 }],
		audience: { match: 'any', segments: [] },
	},
};

test('the kill switch changes only the rollout percentage', () => {
	const body = killBody(live);
	assert.deepEqual(body, {
		feature: 306526,
		name: 'Tell vs Feel',
		hypothesis: 'h',
		metrics: [{ metric: 1571, expected_direction: 'increase' }, { metric: 1572, expected_direction: 'not_decrease' }],
		experiment_rollout: { ...live.experiment_rollout, rollout_percentage: 0 },
	});
	assert.equal(live.experiment_rollout.rollout_percentage, 100, 'the input is not mutated');
});

test('the kill switch refuses an experiment without a rollout', () => {
	assert.throws(() => killBody({ ...live, experiment_rollout: undefined }), /no rollout/);
});
