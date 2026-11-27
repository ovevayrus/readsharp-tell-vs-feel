import { defineConfig } from '@playwright/test';
import { assertNoChildProcessDebug } from './scripts/setup-flagsmith.mjs';

// End-to-end privacy and wiring tests for the speed-test experiment, against the Flagsmith
// DEVELOPMENT environment.
//
//   Local build:       READSHARP_DIST=<built site dir> node node_modules/@playwright/test/cli.js test
//   Deployed preview:  E2E_BASE_URL=https://flagsmith-dev-preview.readfast-site.pages.dev node node_modules/@playwright/test/cli.js test
//   (Run Playwright through node directly: npx would spawn a child with this environment before
//   the NODE_DEBUG guard below can run.)
//
// Locally, the client-side Development key is read from FS_DEV_CLIENT_KEY by the test server and
// put into the page in memory only (scripts/serve-dist.mjs); it is never written to disk.

// Playwright starts the web server, with this process's environment (which holds keys), before
// global setup runs, so refuse here, at config load, if Node would log subprocess environments.
assertNoChildProcessDebug();

const remote = process.env.E2E_BASE_URL?.replace(/\/$/, '');
const dist = process.env.READSHARP_DIST ?? 'C:/Users/oveva/readfast-worktrees/flagsmith-tell-vs-feel/dist-site';
const port = Number(process.env.E2E_PORT ?? 4173);
const local = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: 'e2e',
	globalSetup: './e2e/global-setup.ts',
	timeout: 120_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: remote ?? local,
		browserName: 'chromium',
		// The installed stable Chrome (E2E_CHANNEL=msedge for Edge, or "" for Playwright's own build).
		channel: process.env.E2E_CHANNEL ?? 'chrome',
		timezoneId: 'America/New_York',
		locale: 'en-US',
		viewport: { width: 1280, height: 900 },
	},
	webServer: remote
		? undefined
		: {
			command: `node scripts/serve-dist.mjs --dir "${dist}" --port ${port} --inject-key-from FS_DEV_CLIENT_KEY`,
			url: `${local}/reading-speed-test`,
			reuseExistingServer: false,
			timeout: 30_000,
		},
});
