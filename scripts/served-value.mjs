#!/usr/bin/env node
// Asks the Flagsmith Node SDK which value a flag serves in Development: the environment default and
// the value for N fresh identities (remote evaluation, so nothing is cached). It records no
// exposures and sends no events. Used to show a rollout took effect, e.g. after
// scripts/complete-experiment.mjs.
//
//   SIM_ENV=development DEV_ENV_ID=<id> node scripts/served-value.mjs --flag effect_check [--n 20]
//
// The server-side key comes from FS_DEV_SERVER_KEY and is checked against DEV_ENV_ID (the sim's
// check) before anything else. Keys are never printed.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Flagsmith } from '@flagsmith/nodejs';
import { assertDevelopment } from '../sim/lib.mjs';

export function parseArgs(argv) {
	const opts = { flag: null, n: 20 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--flag') opts.flag = argv[++i];
		else if (arg === '--n') opts.n = Number(argv[++i]);
		else throw new Error('Unknown argument. Allowed: --flag, --n.');
	}
	if (!opts.flag || opts.flag.startsWith('--')) throw new Error('--flag is required');
	if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 200) throw new Error('--n must be an integer from 1 to 200');
	return opts;
}

/** Counts per served value. Pure. */
export function tally(values) {
	const counts = {};
	for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
	return counts;
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, createClient = (config) => new Flagsmith(config), uuid = randomUUID } = {}) {
	const opts = parseArgs(argv);
	await assertDevelopment(env, fetchImpl);
	const client = createClient({ environmentKey: env.FS_DEV_SERVER_KEY, enableLocalEvaluation: false, logger: { error() {}, warn() {}, info() {}, debug() {} } });
	try {
		const environmentValue = (await client.getEnvironmentFlags()).getFeatureValue(opts.flag);
		const values = [];
		for (let i = 0; i < opts.n; i++) {
			values.push((await client.getIdentityFlags(`rollout-check-${uuid()}`)).getFeatureValue(opts.flag));
		}
		return { flag: opts.flag, environment: 'Development', checkedAt: new Date().toISOString(), environmentDefault: environmentValue, freshIdentities: opts.n, values: tally(values) };
	} finally {
		await client.close?.();
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main()
		.then((summary) => console.log(JSON.stringify(summary)))
		.catch((error) => {
			// sim errors are fixed messages; anything else gets a generic one so no key can leak.
			console.error(error?.name === 'Error' && /^(Unknown argument|--flag|--n)/.test(error.message) ? error.message : error?.constructor?.name === 'SimError' ? error.message : 'served-value failed.');
			process.exitCode = 1;
		});
}
