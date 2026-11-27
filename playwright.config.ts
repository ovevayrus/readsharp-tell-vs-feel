import { defineConfig } from '@playwright/test';

// End-to-end privacy and wiring tests for the speed-test experiment, against a local build of
// the ReadSharp site and the Flagsmith DEVELOPMENT environment.
//
//   READSHARP_DIST=<path to the built dist-site> npx playwright test
//
// The client-side Development key is read from FS_DEV_CLIENT_KEY by the local server and put
// into the page in memory only (scripts/serve-dist.mjs); it is never written to disk.
const dist = process.env.READSHARP_DIST ?? 'C:/Users/oveva/readfast-worktrees/flagsmith-tell-vs-feel/dist-site';
const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
	testDir: 'e2e',
	timeout: 120_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		browserName: 'chromium',
		// The installed stable Chrome (E2E_CHANNEL=msedge for Edge, or "" for Playwright's own build).
		channel: process.env.E2E_CHANNEL ?? 'chrome',
		timezoneId: 'America/New_York',
		locale: 'en-US',
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		command: `node scripts/serve-dist.mjs --dir "${dist}" --port ${port} --inject-key-from FS_DEV_CLIENT_KEY`,
		url: `http://127.0.0.1:${port}/reading-speed-test`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
