#!/usr/bin/env node
// Idempotent Flagsmith setup for the Tell vs Feel experiment.
//
//   node scripts/setup-flagsmith.mjs --env development [--create-experiment <flag>] [--start] [--dry-run]
//   node scripts/setup-flagsmith.mjs --env production [--dry-run]
//   node scripts/setup-flagsmith.mjs --env production --create-experiment speed_test_next_step --start --registered <commit> [--dry-run]
//
// The last form is the launch (gate G4). It refuses unless <commit> is on origin/main, its
// EXPERIMENT.md says REGISTERED and no later commit there changed EXPERIMENT.md, so the
// pre-registration is pushed before the Production experiment exists. It always creates and
// starts back to back: an experiment that is created but not started already serves the split,
// without recording exposures.
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
//   • with --create-experiment, that flag has one experiment with the planned hypothesis,
//     metrics, 100% rollout and an even split; --start starts it.
// A second run creates nothing. Features are project-wide in Flagsmith, so creating a flag also
// gives other environments a feature state; those stay disabled until this script runs for them.
// Once an experiment is completed (scripts/complete-experiment.mjs), its rollout decision is what
// the flag serves, and this script leaves that flag's state alone.
import { execFileSync } from 'node:child_process';
import { debuglog } from 'node:util';
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
	{
		name: 'effect_check',
		description: 'Planted-effect validation flag. Development only; scripted traffic converts more in b.',
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
	effect_check: {
		name: 'Planted effect check',
		hypothesis: 'Planted-effect validation: scripted traffic converts at 10% in control and 15% in b, so b should beat control on get_readsharp, with result_shared unchanged. Validation only, never a result.',
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
	const opts = { env: null, createExperiment: null, start: false, dryRun: false, project: null, registered: null };
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
		else if (arg === '--registered') opts.registered = value();
		else throw new Error('Unknown argument. Allowed: --env, --create-experiment, --start, --dry-run, --project, --registered.');
	}
	if (!ENV_NAMES[opts.env]) throw new Error('--env must be development or production');
	if (opts.createExperiment !== null) {
		if (!EXPERIMENTS[opts.createExperiment]) throw new Error(`No experiment is defined for that flag. Allowed flags: ${Object.keys(EXPERIMENTS).join(', ')}.`);
		if (opts.env === 'production') {
			if (!FLAGS.find((f) => f.name === opts.createExperiment).environments.includes('production')) throw new Error('That flag has no Production experiment.');
			if (!opts.start) throw new Error('In Production, --create-experiment needs --start: an unstarted experiment serves the split without recording exposures.');
			if (opts.registered === null) throw new Error('In Production, --create-experiment needs --registered <commit>: the pushed commit that set EXPERIMENT.md to REGISTERED.');
		}
	}
	if (opts.registered !== null && !(opts.env === 'production' && opts.createExperiment !== null)) throw new Error('--registered is only for creating the Production experiment.');
	if (opts.registered !== null && !/^[0-9a-f]{7,40}$/.test(opts.registered)) throw new Error('--registered must be a commit id (7 to 40 hex characters).');
	if (opts.start && opts.createExperiment === null) throw new Error('--start needs --create-experiment');
	return opts;
}

const gitText = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Refuses unless the registered commit is on origin/main, its EXPERIMENT.md says REGISTERED, and
 * no later commit on origin/main changed EXPERIMENT.md. `git` is injectable for tests.
 */
export function assertRegistered(commit, git = gitText) {
	git(['fetch', '--quiet', 'origin', 'main']);
	try {
		git(['merge-base', '--is-ancestor', commit, 'origin/main']);
	} catch {
		throw new Error('The registered commit is not on origin/main: push the REGISTERED EXPERIMENT.md first.');
	}
	if (!/^\*\*Status: REGISTERED\*\*/m.test(git(['show', `${commit}:EXPERIMENT.md`]))) {
		throw new Error('EXPERIMENT.md at the registered commit is not marked REGISTERED.');
	}
	if (git(['log', '--format=%h', `${commit}..origin/main`, '--', 'EXPERIMENT.md']).trim()) {
		throw new Error('EXPERIMENT.md changed on origin/main after the registered commit.');
	}
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
		// A completed experiment's rollout decision is what the flag serves now; setup must not undo it.
		const rolledOut = !locked && state.experiments.some((x) => featureId(x) === feature?.id && x.rollout_decision != null);
		const fs = state.featureStates[flag.name];
		const needsState = !fs || fs.enabled !== true || String(fs.value) !== flag.control
			|| (fs.allocations ?? []).some((a) => Number(a.percentage_allocation) !== 0);
		if (needsState && !locked && !rolledOut) actions.push({ type: 'set-feature-state', flag });
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

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const idOf = (metric) => (metric !== null && typeof metric === 'object' ? metric.id : metric);

/**
 * Compares what exists with the spec and returns a list of drift problems (empty when fine). Pure.
 * state: { features (with .variants), metrics, experiments, experimentDetails: { [id]: detail } }.
 * Missing variants and metrics are not drift on their own (plan() creates them) unless
 * `complete` is set, which is used once the run has finished.
 */
export function findDrift(spec, state, { complete = false } = {}) {
	const problems = [];
	for (const metric of spec.metrics) {
		const found = state.metrics.find((m) => m.name === metric.name);
		if (!found) {
			if (complete) problems.push(`metric ${metric.name} is missing`);
			continue;
		}
		if (found.definition?.event !== metric.event) problems.push(`metric ${metric.name} drift: event differs from the spec`);
		if (found.aggregation !== metric.aggregation) problems.push(`metric ${metric.name} drift: aggregation differs from the spec`);
		if (found.direction !== metric.direction) problems.push(`metric ${metric.name} drift: direction differs from the spec`);
	}
	for (const flag of spec.flags) {
		const feature = state.features.find((f) => f.name === flag.name);
		if (!feature) continue;
		const wanted = flag.variants.map((v) => v.key);
		const have = (feature.variants ?? []).map((v) => v.key);
		if (have.some((key) => !wanted.includes(key))) problems.push(`flag ${flag.name} drift: it has variants that are not in the spec`);
		else if (complete && !sameSet(have, wanted)) problems.push(`flag ${flag.name} drift: its variants differ from the spec`);
		for (const variant of flag.variants) {
			const found = (feature.variants ?? []).find((v) => v.key === variant.key);
			const value = found && (found.value ?? found.string_value);
			if (found && value !== undefined && String(value) !== variant.value) problems.push(`flag ${flag.name} drift: variation ${variant.key} does not have the value ${variant.value}`);
		}
		const experimentSpec = spec.experiments[flag.name];
		const active = state.experiments.find((x) => featureId(x) === feature.id && ACTIVE(x));
		if (!active || !experimentSpec) continue;
		const label = `experiment ${active.id} on ${flag.name}`;
		const detail = state.experimentDetails?.[active.id];
		if (!detail) { problems.push(`${label} drift: its detail could not be read`); continue; }
		if (detail.hypothesis !== undefined && detail.hypothesis !== experimentSpec.hypothesis) problems.push(`${label} drift: its hypothesis differs from the spec`);
		const rollout = detail.experiment_rollout ?? {};
		if (rollout.enabled !== true) problems.push(`${label} drift: its rollout is not enabled`);
		if (Number(rollout.rollout_percentage) !== 100) problems.push(`${label} drift: rollout is not 100%`);
		// The control value decides what "not feel" renders; a wrong one would mislabel exposures.
		if (rollout.feature_state_value !== undefined && String(rollout.feature_state_value?.value ?? rollout.feature_state_value) !== flag.control) {
			problems.push(`${label} drift: its control value is not ${flag.control}`);
		}
		if ((rollout.audience?.segments ?? rollout.audience?.segment_ids ?? []).length) problems.push(`${label} drift: it is limited to an audience`);
		const allocations = rollout.multivariate_feature_state_values ?? [];
		const share = 100 / (have.length + 1);
		if (allocations.length !== have.length || allocations.some((a) => a.percentage_allocation !== share)) {
			problems.push(`${label} drift: the split is not an even ${share}% per variation`);
		}
		const variantIds = (feature.variants ?? []).map((v) => v.id).filter((id) => id !== undefined);
		const allocationIds = allocations.map((a) => a.multivariate_feature_option).filter((id) => id !== undefined);
		if (variantIds.length && allocationIds.length && !sameSet(allocationIds.map(String), variantIds.map(String))) {
			problems.push(`${label} drift: its split points at variations that are not the flag's`);
		}
		// Order matters: the first metric is the primary one.
		const expected = experimentSpec.metrics.map((m) => {
			const metric = state.metrics.find((x) => x.name === m.metric);
			return `${metric?.id}:${m.expected_direction}`;
		});
		const actual = (detail.metrics ?? []).map((m) => `${idOf(m.metric)}:${m.expected_direction}`);
		if (actual.join(' ') !== expected.join(' ')) problems.push(`${label} drift: its metrics differ from the spec (or are not in the spec's order)`);
	}
	return problems;
}

const defaultSpec = { flags: FLAGS, metrics: METRICS, experiments: EXPERIMENTS };

function assertNoDrift(state, options) {
	const problems = findDrift(defaultSpec, state, options);
	if (problems.length) throw new Error(`Flagsmith setup drift, refusing to continue: ${problems.join('; ')}`);
}

/**
 * Node logs subprocess arguments and environment (which carry keys) when NODE_DEBUG enables the
 * child_process channel, also through wildcards such as "child*" or "*". Refuse in that case.
 */
export function childProcessDebugEnabled(nodeDebug) {
	const toRegExp = (pattern) => new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
	return String(nodeDebug ?? '').split(/[\s,]+/).filter(Boolean).some((pattern) => toRegExp(pattern).test('child_process'));
}

export function assertNoChildProcessDebug(env = process.env, enabled = debuglog('child_process').enabled) {
	if (enabled || childProcessDebugEnabled(env.NODE_DEBUG)) throw new Error('Refusing to run with NODE_DEBUG enabling child_process: it would log secrets.');
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
	const experimentDetails = {};
	for (const experiment of experiments) {
		if (features.some((f) => f.id === featureId(experiment)) && ACTIVE(experiment)) {
			experimentDetails[experiment.id] = api(`api/v1/environments/${key}/experiments/${experiment.id}/`);
		}
	}
	return { environment, key, features, featureStates, metrics, experiments, experimentDetails };
}

function apply(client, action, state, log) {
	const { cli, json, api, list, project } = client;
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
			const fs = list(api(`api/v1/environments/${key}/featurestates/?feature=${feature.id}`))[0];
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
	assertNoChildProcessDebug();
	const opts = parseArgs(argv);
	if (opts.registered !== null) assertRegistered(opts.registered);
	const client = makeClient(opts.project);
	const log = (line) => console.log(client.redact(line));
	let state = readState(client, opts.env);
	assertNoDrift(state);
	const actions = plan(opts, state);
	log(`${state.environment.name}: ${actions.length ? actions.map((a) => a.type).join(', ') : 'nothing to create'}`);
	if (opts.dryRun) return { actions, summary: summarize(state) };
	for (const action of actions) {
		if (action.type === 'start-experiment') {
			state = readState(client, opts.env);
			assertNoDrift(state);
		}
		apply(client, action, state, log);
		if (action.type !== 'create-metric') state = readState(client, opts.env);
	}
	state = readState(client, opts.env);
	assertNoDrift(state, { complete: true });
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
