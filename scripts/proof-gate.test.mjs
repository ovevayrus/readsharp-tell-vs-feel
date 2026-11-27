import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, summarize } from './proof-gate.mjs';

// Shape of GET .../experiments/<id>/results/ -> results.payload, as Flagsmith returned it overnight.
const payload = (feel, control, feelSum, controlSum) => ({
	exposures_timeseries: { points: [{ new_identities: { feel: feel - 1, control } }, { new_identities: { feel: 1 } }] },
	metrics: [
		{ metric_id: 1012, variants: { feel: { n: feel, sum: feelSum }, control: { n: control, sum: controlSum } } },
		{ metric_id: 1013, variants: { feel: { n: feel, sum: 99 }, control: { n: control, sum: 99 } } },
	],
});

test('summarize adds exposures across time buckets and reads the primary metric only', () => {
	assert.deepEqual(summarize(payload(38, 46, 20, 22), 1012), { exposures: { feel: 38, control: 46 }, conversions: { feel: 20, control: 22 } });
	assert.deepEqual(summarize(undefined, 1012), { exposures: {}, conversions: {} });
});

const counts = { arms: { tell: 12, feel: 14 }, clicksByArm: { tell: 7, feel: 6 } };

test('the gate passes only when each arm grew by its own e2e counts', () => {
	const before = summarize(payload(38, 46, 20, 22), 1012);
	const after = summarize(payload(38 + 14, 46 + 12, 20 + 6, 22 + 7), 1012);
	assert.equal(compare(before, after, counts).pass, true);
});

test('growth in one arm cannot cover a shortfall in the other', () => {
	const before = summarize(payload(38, 46, 20, 22), 1012);
	const allFeel = summarize(payload(38 + 26, 46, 20 + 13, 22), 1012);
	const verdict = compare(before, allFeel, counts);
	assert.equal(verdict.pass, false);
	assert.equal(verdict.rows.find((r) => r.arm === 'control').pass, false);
});

test('missing conversions fail the gate even when exposures arrived', () => {
	const before = summarize(payload(38, 46, 20, 22), 1012);
	const noClicks = summarize(payload(38 + 14, 46 + 12, 20, 22), 1012);
	assert.equal(compare(before, noClicks, counts).pass, false);
});

test('an arm with no e2e sessions cannot pass vacuously', () => {
	const before = summarize(payload(38, 46, 20, 22), 1012);
	assert.equal(compare(before, before, { arms: { tell: 0, feel: 0 }, clicksByArm: {} }).pass, false);
});
