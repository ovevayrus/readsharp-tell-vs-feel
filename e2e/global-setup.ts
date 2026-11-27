import { execFileSync } from 'node:child_process';
import { assertNoChildProcessDebug } from '../scripts/setup-flagsmith.mjs';

// Refuses to run the e2e suite unless FS_DEV_CLIENT_KEY is the client key of the Development
// environment in Flagsmith project 56718, so a Production key can never be used here.
// Keys are compared in memory and never printed.
const PROJECT = '56718';

export default async function globalSetup() {
	// The CLI below inherits the environment, which holds keys; Node would log it under NODE_DEBUG.
	assertNoChildProcessDebug();
	const key = process.env.FS_DEV_CLIENT_KEY;
	const notDev = 'FS_DEV_CLIENT_KEY is not the Development key';
	if (!key) throw new Error(notDev);
	let environments: any;
	try {
		environments = JSON.parse(
			execFileSync('flagsmith', ['environment', 'list', '--project', PROJECT, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32e6 }),
		);
	} catch {
		throw new Error('Could not list Flagsmith environments to verify FS_DEV_CLIENT_KEY');
	}
	const list: any[] = Array.isArray(environments) ? environments : environments?.results ?? [];
	const development = list.find((e) => e?.name === 'Development');
	if (!development || typeof development.api_key !== 'string' || development.api_key !== key) throw new Error(notDev);
}
