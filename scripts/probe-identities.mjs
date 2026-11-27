#!/usr/bin/env node
// Asks the Flagsmith edge API which value a flag serves to N fresh identities, the same way the
// browser SDK does (GET /api/v1/identities/?identifier=…[&transient=true]). Prints one small JSON
// summary: counts per value, per variant key, and how many identities were inExperiment.
//
//   node scripts/probe-identities.mjs --env development --flag speed_test_next_step [--n 40] [--transient]
//
// The client-side key comes from FS_DEV_CLIENT_KEY (development) or FS_PROD_CLIENT_KEY
// (production) and is never printed. It sends no events, so it records no exposures.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const KEY_VARS = { development: 'FS_DEV_CLIENT_KEY', production: 'FS_PROD_CLIENT_KEY' };
export const EDGE = 'https://edge.api.flagsmith.com/api/v1/';

export function parseArgs(argv) {
	const opts = { env: null, flag: null, n: 40, transient: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--env') opts.env = argv[++i];
		else if (arg === '--flag') opts.flag = argv[++i];
		else if (arg === '--n') opts.n = Number(argv[++i]);
		else if (arg === '--transient') opts.transient = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!KEY_VARS[opts.env]) throw new Error('--env must be development or production');
	if (!opts.flag) throw new Error('--flag is required');
	if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 500) throw new Error('--n must be an integer from 1 to 500');
	return opts;
}

/** Folds one identities/ response into the running summary. */
export function tally(summary, body, flag) {
	const state = (body?.flags ?? []).find((f) => f.feature?.name === flag);
	const value = state ? String(state.feature_state_value) : '(missing)';
	summary.values[value] = (summary.values[value] ?? 0) + 1;
	const variant = state?.variant ?? '(none)';
	summary.variants[variant] = (summary.variants[variant] ?? 0) + 1;
	// The edge API reports experiment membership under metadata.experiment ({ id, in_experiment, name }).
	const experiment = state?.metadata?.experiment;
	if (experiment?.in_experiment === true) summary.inExperiment++;
	if (experiment && !summary.experimentIds.includes(experiment.id)) summary.experimentIds.push(experiment.id);
	return summary;
}

export async function main(argv = process.argv.slice(2), fetchImpl = fetch) {
	const opts = parseArgs(argv);
	const key = process.env[KEY_VARS[opts.env]];
	if (!key) throw new Error(`${KEY_VARS[opts.env]} is not set`);
	const summary = { env: opts.env, flag: opts.flag, transient: opts.transient, n: opts.n, http: {}, values: {}, variants: {}, inExperiment: 0, experimentIds: [], sampleFlagShape: null };
	for (let i = 0; i < opts.n; i++) {
		const url = `${EDGE}identities/?identifier=${encodeURIComponent(`probe-${randomUUID()}`)}${opts.transient ? '&transient=true' : ''}`;
		const res = await fetchImpl(url, { headers: { 'X-Environment-Key': key, Accept: 'application/json' } });
		summary.http[res.status] = (summary.http[res.status] ?? 0) + 1;
		const body = await res.json().catch(() => null);
		tally(summary, body, opts.flag);
		if (!summary.sampleFlagShape) {
			const state = (body?.flags ?? []).find((f) => f.feature?.name === opts.flag);
			if (state) summary.sampleFlagShape = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, k === 'feature' ? { name: v?.name } : v]));
		}
	}
	console.log(JSON.stringify(summary));
	return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
