#!/usr/bin/env node
// Idempotent Flagsmith setup for the Tell vs Feel experiment.
//
//   node scripts/setup-flagsmith.mjs --env development [--create-experiment <flag>] [--start] [--dry-run]
//   node scripts/setup-flagsmith.mjs --env production [--dry-run]
//
// It drives the Flagsmith CLI v2 (`flagsmith feature …` and `flagsmith api …`), so the CLI's own
// credentials are used (FLAGSMITH_API_KEY or `flagsmith login`) and this script never handles
// an admin key. Environment keys are looked up by environment name, kept in memory, and redacted
// from anything printed. Run `flagsmith init` first so flagsmith.json names the project.
//
// Per run it makes sure that:
//   • each flag exists with its control value and keyed variations at weight 0 (so, outside an
//     experiment, everyone is served the control value);
//   • in the chosen environment, each flag that belongs there is enabled with the control value
//     and 0% on every variation;
//   • the metrics exist in that environment;
//   • with --create-experiment (Development only), that flag has one experiment with the
//     planned hypothesis, metrics, 100% rollout and an even split; --start starts it.
// A second run creates nothing. Features are project-wide in Flagsmith, so creating a flag also
// gives other environments a feature state; those stay disabled until this script runs for them.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FLAGS = [
	{
		name: 'speed_test_next_step',
		description: 'Tell vs Feel: the next step shown after a reading speed test result.',
		control: 'tell',
		variants: [{ value: 'feel', key: 'feel' }],
		environments: ['development', 'production'],
	},
	{
		name: 'aa_check',
		description: 'A/A validation flag. Development only; both arms behave the same.',
		control: 'a',
		variants: [{ value: 'b', key: 'b' }],
		environments: ['development'],
	},
];

export const METRICS = [
	{ name: 'get_readsharp', event: 'get_readsharp', aggregation: 'occurrence', direction: 'up', description: 'Primary: a click on Get ReadSharp.' },
	{ name: 'result_shared', event: 'result_shared', aggregation: 'occurrence', direction: 'up', description: 'Guardrail: a successful share or copy of the result.' },
	{ name: 'installer_download', event: 'installer_download', aggregation: 'occurrence', direction: 'informational', description: 'Informational: the Windows installer link was followed.' },
];

export const HYPOTHESIS = 'ReadSharp has no free trial, so the speed-test result is when a curious visitor decides whether the product is for them. Continuing the very passage they just read, in the real reader at their own practice pace, will convince more people than a number would. So feel will raise get_readsharp over tell, without lowering result_shared.';

// Metric order matters: the first one is the primary metric.
export const EXPERIMENTS = {
	speed_test_next_step: {
		name: 'Tell vs Feel',
		hypothesis: HYPOTHESIS,
		metrics: [
			{ metric: 'get_readsharp', expected_direction: 'increase' },
			{ metric: 'result_shared', expected_direction: 'not_decrease' },
			{ metric: 'installer_download', expected_direction: 'increase' },
		],
	},
	aa_check: {
		name: 'A/A check',
		hypothesis: 'A/A validation: both arms are identical, so no difference in get_readsharp or result_shared is expected. Validation only, never a result.',
		metrics: [
			{ metric: 'get_readsharp', expected_direction: 'increase' },
			{ metric: 'result_shared', expected_direction: 'not_decrease' },
		],
	},
};

const ENV_NAMES = { development: 'Development', production: 'Production' };
// The experiments list nests the feature as an object; accept a bare id too.
export const featureId = (experiment) => experiment.feature?.id ?? experiment.feature;
const ACTIVE = (experiment) => !['ended', 'completed', 'cancelled', 'archived'].includes(String(experiment.status ?? '').toLowerCase());

export function parseArgs(argv) {
	const opts = { env: null, createExperiment: null, start: false, dryRun: false, project: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === '--env') opts.env = value();
		else if (arg === '--create-experiment') opts.createExperiment = value();
		else if (arg === '--start') opts.start = true;
		else if (arg === '--dry-run') opts.dryRun = true;
		else if (arg === '--project') opts.project = value();
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!ENV_NAMES[opts.env]) throw new Error('--env must be development or production');
	if (opts.createExperiment !== null) {
		if (opts.env !== 'development') throw new Error('--create-experiment is allowed only with --env development');
		if (!EXPERIMENTS[opts.createExperiment]) throw new Error(`No experiment is defined for ${opts.createExperiment}`);
	}
	if (opts.start && opts.createExperiment === null) throw new Error('--start needs --create-experiment');
	return opts;
}

/** Works out what a run must do, from what already exists. Pure, so idempotency is testable. */
export function plan({ env, createExperiment, start }, state) {
	const actions = [];
	const wanted = FLAGS.filter((flag) => flag.environments.includes(env) || flag.name === createExperiment);
	for (const flag of wanted) {
		const feature = state.features.find((f) => f.name === flag.name);
		if (!feature) actions.push({ type: 'create-feature', flag });
		for (const variant of flag.variants) {
			if (!feature?.variants?.some((v) => v.key === variant.key)) actions.push({ type: 'add-variant', flag, variant });
		}
		const locked = state.experiments.some((x) => featureId(x) === feature?.id && ACTIVE(x));
		const fs = state.featureStates[flag.name];
		const needsState = !fs || fs.enabled !== true || String(fs.value) !== flag.control
			|| (fs.allocations ?? []).some((a) => Number(a.percentage_allocation) !== 0);
		if (needsState && !locked) actions.push({ type: 'set-feature-state', flag });
	}
	for (const metric of METRICS) {
		if (!state.metrics.some((m) => m.name === metric.name)) actions.push({ type: 'create-metric', metric });
	}
	if (createExperiment) {
		const feature = state.features.find((f) => f.name === createExperiment);
		const existing = state.experiments.find((x) => feature && featureId(x) === feature.id && ACTIVE(x));
		if (!existing) actions.push({ type: 'create-experiment', flag: createExperiment });
		if (start && String(existing?.status ?? '').toLowerCase() !== 'running') actions.push({ type: 'start-experiment', flag: createExperiment });
	}
	return actions;
}

// ---- Flagsmith CLI access (everything below talks to the network) ----

function makeClient(projectArg) {
	const secrets = [];
	const redact = (text) => secrets.reduce((out, s) => out.split(s).join('<env-key>'), String(text));
	const cli = (args, input) => {
		try {
			return execFileSync('flagsmith', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32e6 });
		} catch (error) {
			throw new Error(`flagsmith ${redact(args.join(' '))} failed: ${redact(`${error.stdout ?? ''}${error.stderr ?? ''}`).trim()}`);
		}
	};
	const project = projectArg ? ['--project', projectArg] : [];
	const json = (args, input) => JSON.parse(cli([...args, '--json'], input) || 'null');
	const api = (path, method = 'GET', body) =>
		JSON.parse(cli(['api', path, '-X', method, ...(body ? ['--input', '-'] : [])], body ? JSON.stringify(body) : undefined) || 'null');
	const list = (value) => (Array.isArray(value) ? value : value?.results ?? []);
	return { secrets, redact, cli, json, api, list, project };
}

function readState(client, envName) {
	const { json, api, list, project, secrets } = client;
	const environments = list(json(['environment', 'list', ...project]));
	for (const e of environments) if (e.api_key) secrets.push(e.api_key);
	const environment = environments.find((e) => e.name === ENV_NAMES[envName]);
	if (!environment) throw new Error(`No environment named ${ENV_NAMES[envName]} in this project`);
	const key = environment.api_key;
	const features = list(json(['feature', 'list', ...project])).filter((f) => FLAGS.some((flag) => flag.name === f.name));
	for (const feature of features) {
		feature.variants = list(json(['feature', 'variant', 'list', feature.name, ...project]));
	}
	const featureStates = {};
	for (const feature of features) {
		const fs = list(api(`api/v1/environments/${key}/featurestates/?feature=${feature.id}`))[0];
		if (fs) {
			featureStates[feature.name] = {
				id: fs.id,
				enabled: fs.enabled,
				value: fs.feature_state_value?.string_value ?? fs.feature_state_value,
				allocations: fs.multivariate_feature_state_values ?? [],
			};
		}
	}
	const metrics = list(api(`api/v1/environments/${key}/experiment-metrics/`));
	const experiments = list(api(`api/v1/environments/${key}/experiments/`));
	return { environment, key, features, featureStates, metrics, experiments };
}

function apply(client, action, state, log) {
	const { cli, json, api, project } = client;
	const key = state.key;
	switch (action.type) {
		case 'create-feature':
			cli(['feature', 'create', action.flag.name, '--value', action.flag.control, '--description', action.flag.description, ...project]);
			return log(`created flag ${action.flag.name} (control "${action.flag.control}")`);
		case 'add-variant':
			cli(['feature', 'variant', 'add', action.flag.name, '--value', action.variant.value, '--key', action.variant.key, '--weight', '0', '--type', 'string', ...project]);
			return log(`added variation ${action.variant.key} to ${action.flag.name} at weight 0`);
		case 'set-feature-state': {
			const feature = list(json(['feature', 'list', ...project])).find((f) => f.name === action.flag.name);
			const fs = client.list(api(`api/v1/environments/${key}/featurestates/?feature=${feature.id}`))[0];
			const allocations = (fs.multivariate_feature_state_values ?? []).map((v) => ({
				multivariate_feature_option: v.multivariate_feature_option,
				percentage_allocation: 0,
			}));
			if (state.environment.use_v2_feature_versioning) {
				// v2 versioning: changes are published as a new environment feature version.
				api(`api/v1/environments/${state.environment.id}/features/${feature.id}/versions/`, 'POST', {
					publish_immediately: true,
					description: 'setup-flagsmith: enabled with the control value, 0% on every variation',
					feature_states_to_update: [{
						feature_segment: null,
						enabled: true,
						feature_state_value: { type: 'unicode', string_value: action.flag.control },
						multivariate_feature_state_values: allocations,
					}],
				});
			} else {
				api(`api/v1/environments/${key}/featurestates/${fs.id}/`, 'PATCH', {
					enabled: true,
					feature_state_value: action.flag.control,
					multivariate_feature_state_values: allocations.map((a, i) => ({ id: fs.multivariate_feature_state_values[i].id, ...a })),
				});
			}
			return log(`enabled ${action.flag.name} in ${state.environment.name} with "${action.flag.control}" and 0% on every variation`);
		}
		case 'create-metric': {
			const { name, description, aggregation, direction, event } = action.metric;
			api(`api/v1/environments/${key}/experiment-metrics/`, 'POST', { name, description, aggregation, direction, definition: { version: 1, event } });
			return log(`created metric ${name} (${aggregation}, ${direction})`);
		}
		case 'create-experiment': {
			const spec = EXPERIMENTS[action.flag];
			const feature = list(json(['feature', 'list', ...project])).find((f) => f.name === action.flag);
			const variants = list(json(['feature', 'variant', 'list', action.flag, ...project]));
			const metrics = list(api(`api/v1/environments/${key}/experiment-metrics/`));
			const share = 100 / (variants.length + 1);
			const created = api(`api/v1/environments/${key}/experiments/`, 'POST', {
				feature: feature.id,
				name: spec.name,
				hypothesis: spec.hypothesis,
				metrics: spec.metrics.map((m) => ({ metric: metrics.find((x) => x.name === m.metric).id, expected_direction: m.expected_direction })),
				experiment_rollout: {
					enabled: true,
					rollout_percentage: 100,
					feature_state_value: { type: 'string', value: FLAGS.find((f) => f.name === action.flag).control },
					multivariate_feature_state_values: variants.map((v) => ({ multivariate_feature_option: v.id, percentage_allocation: share })),
				},
			});
			return log(`created experiment "${spec.name}" (id ${created?.id}, status ${created?.status}) on ${action.flag}`);
		}
		case 'start-experiment': {
			const feature = list(json(['feature', 'list', ...project])).find((f) => f.name === action.flag);
			const experiment = list(api(`api/v1/environments/${key}/experiments/`)).find((x) => featureId(x) === feature.id && ACTIVE(x));
			const started = api(`api/v1/environments/${key}/experiments/${experiment.id}/start/`, 'POST');
			return log(`started experiment ${experiment.id}: status ${started?.status ?? '(see verify)'}`);
		}
		default:
			throw new Error(`Unknown action ${action.type}`);
	}
	function list(value) {
		return client.list(value);
	}
}

/** Small JSON summary of what exists now, for the run log. No keys. */
function summarize(state) {
	return {
		environment: { id: state.environment.id, name: state.environment.name },
		flags: state.features.map((f) => ({
			name: f.name,
			id: f.id,
			variants: f.variants.map((v) => ({ id: v.id, key: v.key, value: v.value ?? v.string_value, weight: v.weight ?? v.default_percentage_allocation })),
			state: state.featureStates[f.name] && {
				enabled: state.featureStates[f.name].enabled,
				value: state.featureStates[f.name].value,
				allocations: state.featureStates[f.name].allocations.map((a) => a.percentage_allocation),
			},
		})),
		metrics: state.metrics.filter((m) => METRICS.some((x) => x.name === m.name)).map((m) => ({ id: m.id, name: m.name, aggregation: m.aggregation, direction: m.direction, event: m.definition?.event })),
		experiments: state.experiments.map((x) => ({
			id: x.id,
			name: x.name,
			feature: featureId(x),
			status: x.status,
			rollout: x.experiment_rollout?.rollout_percentage,
			split: x.experiment_rollout?.multivariate_feature_state_values?.map((v) => v.percentage_allocation),
			metrics: x.metrics?.map((m) => ({ metric: m.metric?.name ?? m.metric, expected_direction: m.expected_direction })),
		})),
	};
}

export async function main(argv = process.argv.slice(2)) {
	const opts = parseArgs(argv);
	const client = makeClient(opts.project);
	const log = (line) => console.log(client.redact(line));
	let state = readState(client, opts.env);
	const actions = plan(opts, state);
	log(`${state.environment.name}: ${actions.length ? actions.map((a) => a.type).join(', ') : 'nothing to create'}`);
	if (opts.dryRun) return { actions, summary: summarize(state) };
	for (const action of actions) {
		apply(client, action, state, log);
		if (action.type !== 'create-metric') state = readState(client, opts.env);
	}
	state = readState(client, opts.env);
	const summary = summarize(state);
	log(JSON.stringify(summary));
	return { actions, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
