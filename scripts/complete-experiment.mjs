#!/usr/bin/env node
// Ends a Development experiment and sets what its flag serves next: the "Round 4" rollout, where
// the flag that ran the experiment also ships the winner. Ending is final in Flagsmith: results are
// frozen, the rollout override is removed and the choice becomes the flag's environment default.
//
//   node scripts/complete-experiment.mjs --flag effect_check --rollout b          dry run
//   node scripts/complete-experiment.mjs --flag effect_check --rollout b --yes    sends it, reads back
//
// --rollout is "control", a variation key (for example b) or "disable" (the flag is turned off).
// Development only: ending the Production experiment is gate G5 in Phase D, never this script's call.
// The Development client-side key comes from FS_DEV_CLIENT_KEY and is never printed. The CLI's own
// credentials (FLAGSMITH_API_KEY) authorise the change.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
	const opts = { flag: null, rollout: null, yes: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === '--flag') opts.flag = value();
		else if (arg === '--rollout') opts.rollout = value();
		else if (arg === '--yes') opts.yes = true;
		else if (arg === '--env') {
			if (value() !== 'development') throw new Error('Development only: ending the Production experiment is gate G5 in Phase D.');
		} else throw new Error('Unknown argument. Allowed: --flag, --rollout, --yes, --env development.');
	}
	if (!opts.flag) throw new Error('--flag is required');
	if (!opts.rollout) throw new Error('--rollout is required: control, a variation key, or disable');
	return opts;
}

const featureIdOf = (experiment) => experiment.feature?.id ?? experiment.feature;

/** The running (or paused) experiment on the flag. Pure. */
export function activeExperiment(experiments, featureId) {
	const active = experiments.filter((x) => featureIdOf(x) === featureId && ['running', 'paused'].includes(String(x.status).toLowerCase()));
	if (active.length !== 1) throw new Error(`Expected one running experiment on the flag, found ${active.length}.`);
	return active[0];
}

/** The complete/ body for a rollout choice. variants: the flag's [{ id, key }]. Pure. */
export function completeBody(rollout, variants) {
	if (rollout === 'control') return { rollout_decision: 'control' };
	if (rollout === 'disable') return { rollout_decision: 'disable' };
	const variant = variants.find((v) => v.key === rollout);
	if (!variant) throw new Error(`The flag has no variation keyed ${rollout}. Keys: ${variants.map((v) => v.key).join(', ')}.`);
	return { rollout_decision: 'variant', rollout_variant: variant.id };
}

/** True when the read-back experiment carries the decision that was sent. Pure. */
export function confirmed(after, body) {
	return String(after.status).toLowerCase() === 'completed'
		&& after.rollout_decision === body.rollout_decision
		&& (body.rollout_variant === undefined || after.rollout_variant === body.rollout_variant);
}

function api(path, method = 'GET', body) {
	const key = process.env.FS_DEV_CLIENT_KEY;
	if (!key) throw new Error('FS_DEV_CLIENT_KEY is not set.');
	try {
		const out = execFileSync('flagsmith', ['api', `api/v1/environments/${key}/${path}`, '-X', method, ...(body ? ['--input', '-'] : [])], {
			encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, stdio: [body ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		});
		return JSON.parse(out || 'null');
	} catch {
		// Fixed message: the CLI's own error would include the request path, which holds the key.
		throw new Error(`Flagsmith CLI call failed: ${method} ${path.split('?')[0]}`);
	}
}

const list = (value) => (Array.isArray(value) ? value : value?.results ?? []);

export function main(argv = process.argv.slice(2)) {
	const opts = parseArgs(argv);
	const experiments = list(api('experiments/'));
	const candidates = experiments.filter((x) => (x.feature?.name ?? null) === opts.flag);
	if (!candidates.length) throw new Error(`No experiment on ${opts.flag} in Development.`);
	const experiment = activeExperiment(candidates, featureIdOf(candidates[0]));
	const detail = api(`experiments/${experiment.id}/`);
	const variants = (detail.feature?.multivariate_options ?? []).map((o) => ({ id: o.id, key: o.key }));
	const body = completeBody(opts.rollout, variants);
	const summary = { experiment: experiment.id, name: detail.name, flag: opts.flag, status: detail.status, body };
	if (!opts.yes) {
		console.log(`DRY RUN (nothing sent): ${JSON.stringify(summary)}`);
		return 0;
	}
	api(`experiments/${experiment.id}/complete/`, 'POST', body);
	const after = api(`experiments/${experiment.id}/`);
	const result = { experiment: experiment.id, status: after.status, ended_at: after.ended_at, rollout_decision: after.rollout_decision, rollout_variant: after.rollout_variant };
	console.log(`COMPLETED: ${JSON.stringify(result)}`);
	return confirmed(after, body) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
