// One real visit to the live reading speed test (readsharp.app), for the two allowed Production
// checks of the launch. Exactly one attempt per run; it never retries.
//
//   node scripts/live-check.mjs smoke    before the Production experiment exists: the result must be
//                                        tell, no $flag_exposure or any other event is sent, the flags
//                                        API serves tell, no CSP errors, every Flagsmith response 2xx.
//   node scripts/live-check.mjs canary   after G4: opens ?canary (identity canary-<uuid>), clicks Get
//                                        ReadSharp, and requires the $flag_exposure and get_readsharp
//                                        POSTs to return 2xx.
//
// The visitor is eligible: America/New_York time zone, no GPC, no ?optout. Output is one JSON line,
// also saved to docs/proof/<mode>.json. No keys are read or printed (the page carries its own).
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const mode = process.argv[2];
if (mode !== 'smoke' && mode !== 'canary') {
	console.error('usage: node scripts/live-check.mjs smoke|canary');
	process.exit(2);
}
// LIVE_CHECK_BASE (e.g. the Development preview) only rehearses the script; its output goes to
// docs/proof/rehearsal-<mode>.json.
const BASE = process.env.LIVE_CHECK_BASE ?? 'https://readsharp.app';
const PAGE = `${BASE}/reading-speed-test${mode === 'canary' ? '?canary' : ''}`;
const OUT = `docs/proof/${process.env.LIVE_CHECK_BASE ? 'rehearsal-' : ''}${mode}.json`;
const EDGE = 'https://edge.api.flagsmith.com';
const EVENTS = 'https://events.api.flagsmith.com';
const FLAG = 'speed_test_next_step';

const wait = async (predicate, ms) => {
	const end = Date.now() + ms;
	while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	return predicate();
};

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'chrome' });
const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
await context.addInitScript(() => {
	window.__csp = [];
	document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const reqs = [];
const byRequest = new Map();
context.on('request', (request) => {
	const url = request.url();
	const origin = new URL(url).origin;
	if (origin !== EDGE && origin !== EVENTS) return;
	let events = [];
	if (origin === EVENTS && request.method() === 'POST') {
		try { events = JSON.parse(request.postData() ?? '{}').events ?? []; } catch { events = []; }
	}
	const entry = { method: request.method(), path: new URL(url).pathname, identifier: new URL(url).searchParams.get('identifier'), transient: new URL(url).searchParams.get('transient'), sentAt: new Date().toISOString(), events };
	reqs.push(entry);
	byRequest.set(request, entry);
});
context.on('response', async (response) => {
	const entry = byRequest.get(response.request());
	if (!entry) return;
	entry.status = response.status();
	entry.answeredAt = new Date().toISOString();
	if (entry.path === '/api/v1/identities/' && entry.method === 'GET') {
		try {
			const flag = (await response.json()).flags?.find((f) => f.feature?.name === FLAG);
			entry.served = { value: flag?.feature_state_value ?? null, enabled: flag?.enabled ?? null, experiment: flag?.metadata?.experiment ?? null };
		} catch { entry.served = { error: 'unreadable flags response' }; }
	}
});
context.on('requestfailed', (request) => {
	const entry = byRequest.get(request);
	if (entry) entry.failed = request.failure()?.errorText ?? 'failed';
});
const page = await context.newPage();
const consoleCsp = [];
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text()); });
await page.clock.install();

const settled = () => reqs.every((r) => r.status !== undefined || r.failed !== undefined);
const identities = () => reqs.filter((r) => r.path === '/api/v1/identities/' && r.method === 'GET');
const sent = () => reqs.flatMap((r) => r.events.map((e) => ({ event: e.event, identifier: e.identifier, value: e.value ?? null, experiment: e.metadata?.experiment_id ?? null, status: r.status ?? null, sentAt: r.sentAt })));

const started = new Date().toISOString();
await page.goto(PAGE);
await page.locator('[data-test-start]').click();
await wait(() => identities().length > 0, 5000);
await page.clock.fastForward(60_000); // ~300 words in 60 s, past the 10 s minimum
await page.locator('[data-test-done]').click();
const fields = page.locator('[data-test-fields] fieldset');
await fields.first().waitFor();
for (let i = 0; i < (await fields.count()); i++) await fields.nth(i).locator('input').first().check();
await wait(settled, 8000);
await page.locator('[data-test-questions] button[type="submit"]').click();
await page.locator('[data-test-result]').waitFor();
const arm = (await page.locator('[data-feel-reader]').isVisible()) ? 'feel' : 'tell';
// The canary waits for its events to be answered; the smoke test watches 3 s for any stray event.
const answered = (name) => () => sent().some((e) => e.event === name && e.status);
const settleOn = (name) => (mode === 'canary' ? wait(answered(name), 8000) : new Promise((r) => setTimeout(r, 3000)));
await settleOn('$flag_exposure');
await page.locator('[data-get-readsharp]').click();
await settleOn('get_readsharp');
await wait(settled, 12000);

const flagsmith = reqs.map(({ events, ...r }) => ({ ...r, events: events.map((e) => e.event) }));
const csp = [...(await page.evaluate(() => window.__csp)), ...consoleCsp];
await browser.close();

const events = sent();
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const served = identities()[0]?.served ?? null;
const checks = {};
if (mode === 'smoke') {
	checks.resultIsTell = arm === 'tell';
	checks.noExposureSent = !events.some((e) => e.event === '$flag_exposure');
	checks.noEventsSent = events.length === 0;
	checks.apiServesTell = served?.value === 'tell';
	checks.noExperimentInFlags = !served?.experiment;
} else {
	const exposure = events.find((e) => e.event === '$flag_exposure');
	const conversion = events.find((e) => e.event === 'get_readsharp');
	checks.canaryIdentity = /^canary-[0-9a-f-]{36}$/.test(identities()[0]?.identifier ?? '');
	checks.exposure2xx = !!exposure && ok2xx(exposure) && exposure.identifier === identities()[0]?.identifier;
	checks.getReadsharp2xx = !!conversion && ok2xx(conversion) && conversion.identifier === identities()[0]?.identifier;
	checks.inExperiment = !!served?.experiment?.in_experiment;
}
checks.oneFlagsRequest = identities().length === 1;
checks.noCspErrors = csp.length === 0;
checks.allFlagsmith2xx = reqs.length > 0 && reqs.every(ok2xx);
const pass = Object.values(checks).every(Boolean);
const report = { mode, page: PAGE, started, arm, served, identifier: identities()[0]?.identifier ?? null, events, flagsmith, csp, checks, pass };
writeFileSync(OUT,`${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ mode, arm, served, checks, pass }));
process.exit(pass ? 0 : 1);
