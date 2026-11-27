#!/usr/bin/env node
// The Development proof gate (plan A2, US-12): do the browser end-to-end sessions show up in the
// Flagsmith experiment results, per arm?
//
//   node scripts/proof-gate.mjs snapshot docs/proof/before.json      (before running e2e)
//   node scripts/proof-gate.mjs check docs/proof/before.json test-results/e2e-counts.json
//
// A snapshot refreshes the results of the Development experiment on speed_test_next_step and
// saves, per arm, the identities exposed and the get_readsharp conversions. `check` takes a new
// snapshot and passes only if, in EACH arm, exposures grew by at least the e2e sessions counted in
// that arm and get_readsharp by at least the e2e clicks in that arm. It uses the Flagsmith CLI's
// credentials; the environment key is looked up in memory and never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNoChildProcessDebug } from './setup-flagsmith.mjs';

export const PROJECT = '56718';
export const FLAG = 'speed_test_next_step';
export const PRIMARY_EVENT = 'get_readsharp';
/** The e2e tally names the control arm "tell"; Flagsmith results call it "control". */
export const RESULT_ARM = { tell: 'control', feel: 'feel' };

/** Per-arm exposures and primary conversions from a results payload. Pure. */
export function summarize(payload, primaryMetricId) {
	const exposures = {};
	for (const point of payload?.exposures_timeseries?.points ?? []) {
		for (const [arm, n] of Object.entries(point.new_identities ?? {})) exposures[arm] = (exposures[arm] ?? 0) + Number(n);
	}
	const metric = (payload?.metrics ?? []).find((m) => m.metric_id === primaryMetricId);
	const conversions = Object.fromEntries(Object.entries(metric?.variants ?? {}).map(([arm, v]) => [arm, Number(v.sum ?? 0)]));
	return { exposures, conversions };
}

/** Why a snapshot cannot serve as the "before" baseline (null when it can). Pure. */
export function staleSnapshot(snap, maxAgeMs = 120_000) {
	if (!snap.asOf || !snap.takenAt) return 'the results have no timestamp';
	if (!snap.refreshed || Date.parse(snap.takenAt) - Date.parse(snap.asOf) > maxAgeMs) {
		return `the results are cached (as of ${snap.asOf.slice(11, 19)} UTC; Flagsmith recomputes at most every 5 minutes). Take the snapshot again after ${new Date(Date.parse(snap.asOf) + 5 * 60_000 + 15_000).toISOString().slice(11, 19)} UTC`;
	}
	return null;
}

/** Why an e2e tally cannot be used as proof (empty when it can). Pure. */
export function tallyProblems(before, counts) {
	const problems = [];
	if (counts.complete !== true) problems.push('the e2e run did not pass in full (or predates the completeness flag); rerun it');
	if (counts.experiment !== before.experiment) problems.push('the e2e run exercised a different experiment than the snapshot');
	if (!before.takenAt || !counts.at || Date.parse(counts.at) <= Date.parse(before.takenAt)) problems.push('the e2e run is not newer than the before snapshot; take the snapshot first, then run the suite once');
	for (const arm of Object.keys(RESULT_ARM)) if (!((counts.clicksByArm?.[arm] ?? 0) > 0)) problems.push(`the e2e run has no Get ReadSharp clicks in the ${arm} arm`);
	return problems;
}

/** Compares two snapshots with the e2e tally, arm by arm. Pure. */
export function compare(before, after, counts) {
	const rows = [];
	for (const [tallyArm, resultArm] of Object.entries(RESULT_ARM)) {
		const exposed = (after.exposures[resultArm] ?? 0) - (before.exposures[resultArm] ?? 0);
		const converted = (after.conversions[resultArm] ?? 0) - (before.conversions[resultArm] ?? 0);
		const needExposed = counts.arms?.[tallyArm] ?? 0;
		const needConverted = counts.clicksByArm?.[tallyArm] ?? 0;
		rows.push({
			arm: resultArm,
			exposuresGrew: exposed, exposuresNeeded: needExposed,
			conversionsGrew: converted, conversionsNeeded: needConverted,
			pass: needExposed > 0 && exposed >= needExposed && converted >= needConverted,
		});
	}
	return { pass: rows.every((r) => r.pass), rows };
}

function cli(args, what) {
	try {
		return execFileSync('flagsmith', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32e6 });
	} catch {
		// Fixed message: the CLI's own error would include the request path, which holds the key.
		throw new Error(`Flagsmith CLI call failed: ${what}`);
	}
}

function snapshot() {
	const environments = JSON.parse(cli(['environment', 'list', '--project', PROJECT, '--json'], 'list environments'));
	const development = (Array.isArray(environments) ? environments : environments.results ?? []).find((e) => e.name === 'Development');
	if (!development?.api_key) throw new Error('Could not find the Development environment');
	const base = `api/v1/environments/${development.api_key}`;
	const list = (value) => (Array.isArray(value) ? value : value?.results ?? []);
	const experiment = list(JSON.parse(cli(['api', `${base}/experiments/`], 'list experiments')))
		.find((x) => (x.feature?.name ?? '') === FLAG && !['ended', 'completed'].includes(String(x.status)));
	if (!experiment) throw new Error(`No active Development experiment on ${FLAG}`);
	const metric = list(JSON.parse(cli(['api', `${base}/experiment-metrics/`], 'list metrics'))).find((m) => m.name === PRIMARY_EVENT);
	let refreshed = true;
	try { cli(['api', `${base}/experiments/${experiment.id}/results/refresh/`, '-X', 'POST'], 'refresh results'); } catch { refreshed = false; /* at most once per 5 minutes */ }
	const results = JSON.parse(cli(['api', `${base}/experiments/${experiment.id}/results/`], 'read results')).results;
	return { experiment: experiment.id, takenAt: new Date().toISOString(), refreshed, asOf: results?.as_of ?? null, ...summarize(results?.payload, metric?.id) };
}

function save(file, data) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
	assertNoChildProcessDebug();
	const [command, first, second] = argv;
	if (command === 'snapshot' && first) {
		const snap = snapshot();
		const problem = staleSnapshot(snap);
		if (problem) {
			console.error(`PROOF GATE: no snapshot saved: ${problem}`);
			return 1;
		}
		save(first, snap);
		console.log(JSON.stringify(snap));
		return 0;
	}
	if (command === 'check' && first && second) {
		const before = JSON.parse(readFileSync(first, 'utf8'));
		const counts = JSON.parse(readFileSync(second, 'utf8'));
		const problems = tallyProblems(before, counts);
		if (problems.length) {
			console.error(`PROOF GATE: cannot judge: ${problems.join('; ')}`);
			return 1;
		}
		const after = snapshot();
		// Flagsmith recomputes results at most every 5 minutes; until then the numbers are the snapshot's.
		if (!after.asOf || !before.asOf || Date.parse(after.asOf) <= Date.parse(before.asOf)) {
			const next = new Date(Date.parse(before.asOf ?? after.takenAt) + 5 * 60_000 + 15_000).toISOString().slice(11, 19);
			console.error(`PROOF GATE: cannot judge yet: Flagsmith has not recomputed the results since the snapshot. Run the check again after ${next} UTC.`);
			return 1;
		}
		const verdict = { before: before.asOf, after: after.asOf, ...compare(before, after, counts) };
		save(`${first.replace(/\.json$/, '')}.after.json`, { ...after, verdict });
		console.log(JSON.stringify(verdict, null, 2));
		console.log(verdict.pass ? 'PROOF GATE: PASS' : 'PROOF GATE: FAIL (refresh again in 5 minutes; after 30 minutes without a pass, use the G2 item 3 fallback)');
		return verdict.pass ? 0 : 1;
	}
	console.error('Usage: node scripts/proof-gate.mjs snapshot <before.json> | check <before.json> <e2e-counts.json>');
	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
