#!/usr/bin/env node
// Kill switch for the running Production experiment: sets its rollout to 0% (everyone then gets
// tell and nothing is recorded). It is the only setting ever changed mid-run, and only the owner
// triggers it. It copies the live experiment exactly and changes nothing but rollout_percentage.
//
//   node scripts/kill-switch.mjs            dry run: prints what would be sent, sends nothing
//   node scripts/kill-switch.mjs --yes      sends it, then reads the experiment back
//
// The Production client-side key comes from FS_PROD_CLIENT_KEY and is never printed. The CLI's own
// credentials (FLAGSMITH_API_KEY) authorise the change. Dashboard alternative: Experiments ->
// Tell vs Feel -> rollout -> 0%.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXPERIMENT_ID = 1512;

/** The PUT body: the experiment as it is, with rollout 0. Pure, so it is testable. */
export function killBody(experiment) {
	const rollout = experiment.experiment_rollout;
	if (!rollout) throw new Error('The experiment has no rollout to change.');
	return {
		feature: experiment.feature?.id ?? experiment.feature,
		name: experiment.name,
		hypothesis: experiment.hypothesis,
		metrics: experiment.metrics.map((m) => ({ metric: m.metric?.id ?? m.metric, expected_direction: m.expected_direction })),
		experiment_rollout: { ...rollout, rollout_percentage: 0 },
	};
}

function api(path, method = 'GET', body) {
	const key = process.env.FS_PROD_CLIENT_KEY;
	if (!key) throw new Error('FS_PROD_CLIENT_KEY is not set.');
	try {
		const out = execFileSync('flagsmith', ['api', `api/v1/environments/${key}/${path}`, '-X', method, ...(body ? ['--input', '-'] : [])], {
			encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, stdio: [body ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		});
		return JSON.parse(out || 'null');
	} catch {
		// Fixed message: the CLI's own error would include the request path, which holds the key.
		throw new Error(`Flagsmith CLI call failed: ${method} experiments/${EXPERIMENT_ID}`);
	}
}

export function main(argv = process.argv.slice(2)) {
	const send = argv.includes('--yes');
	if (argv.some((a) => a !== '--yes')) throw new Error('Allowed: --yes');
	const experiment = api(`experiments/${EXPERIMENT_ID}/`);
	if (String(experiment.status).toLowerCase() !== 'running') throw new Error(`Experiment ${EXPERIMENT_ID} is ${experiment.status}, not running.`);
	const body = killBody(experiment);
	const summary = { experiment: EXPERIMENT_ID, name: body.name, rollout: `${experiment.experiment_rollout.rollout_percentage}% -> 0%`, split: body.experiment_rollout.multivariate_feature_state_values, metrics: body.metrics };
	if (!send) {
		console.log(`DRY RUN (nothing sent): ${JSON.stringify(summary)}`);
		return 0;
	}
	api(`experiments/${EXPERIMENT_ID}/`, 'PUT', body);
	const after = api(`experiments/${EXPERIMENT_ID}/`);
	console.log(`KILL SWITCH: experiment ${EXPERIMENT_ID} rollout is now ${after.experiment_rollout?.rollout_percentage}% (status ${after.status})`);
	return after.experiment_rollout?.rollout_percentage === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
