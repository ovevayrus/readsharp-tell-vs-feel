import { test, expect, type Browser, type BrowserContext, type Page, type BrowserContextOptions } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

// Privacy and wiring checks (a)–(i) for the Tell vs Feel experiment. Real requests go to the
// Flagsmith DEVELOPMENT environment, where experiment "Tell vs Feel" (id 958) is running.

const PAGE = '/reading-speed-test';
const EDGE = 'https://edge.api.flagsmith.com';
const EVENTS = 'https://events.api.flagsmith.com';
const FLAGSMITH = [EDGE, EVENTS];
const EXPERIMENT_ID = 958;
// E2E_EXPECT_TRANSIENT=0 checks the pre-approved persistent-ID fallback (G2 item 3) instead.
const EXPECT_TRANSIENT = process.env.E2E_EXPECT_TRANSIENT !== '0';
// Chromium on Windows resolves navigator.share before a target is chosen, so the site copies to the
// clipboard there instead; the native-share cases use a macOS user agent.
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

type Sent = { event: string; identifier: string | null; value: string | null; metadata: Record<string, unknown> | null; feature_name: string | null; timestamp?: number };
type Req = { url: string; origin: string; method: string; at: number; status?: number; failed?: string; events: Sent[] };

// The SDK delivers events at least once: when an events request outlives its 3 s timeout it
// sends the same batch again (same timestamps). Events are therefore counted once per
// (event, identifier, timestamp), and each must reach Flagsmith in a 2xx response at least once.
const eventKey = (e: Sent) => `${e.event}|${e.identifier}|${e.timestamp}`;

/** Records every request of a context, with parsed Flagsmith event batches and response codes. */
function record(context: BrowserContext) {
	const reqs: Req[] = [];
	const byRequest = new Map<object, Req>();
	context.on('request', (request) => {
		const url = request.url();
		let events: Sent[] = [];
		if (url.startsWith(EVENTS) && request.method() === 'POST') {
			try { events = JSON.parse(request.postData() ?? '{}').events ?? []; } catch { events = []; }
		}
		const entry = { url, origin: new URL(url).origin, method: request.method(), at: Date.now(), events };
		reqs.push(entry);
		byRequest.set(request, entry);
	});
	context.on('response', (response) => {
		const entry = byRequest.get(response.request());
		if (entry) entry.status = response.status();
	});
	context.on('requestfailed', (request) => {
		const entry = byRequest.get(request);
		if (entry) entry.failed = request.failure()?.errorText ?? 'failed';
	});
	const flagsmith = () => reqs.filter((r) => FLAGSMITH.includes(r.origin));
	/** Distinct events, each with the time it was first sent. */
	const sent = () => {
		const first = new Map<string, Sent & { at: number }>();
		for (const r of flagsmith()) for (const e of r.events) if (!first.has(eventKey(e))) first.set(eventKey(e), { ...e, at: r.at });
		return [...first.values()];
	};
	const settled = () => flagsmith().every((r) => r.status !== undefined || r.failed !== undefined);
	const delivered = (e: Sent) => flagsmith().some((r) => r.status! >= 200 && r.status! < 300 && r.events.some((x) => eventKey(x) === eventKey(e)));
	return { reqs, flagsmith, sent, settled, delivered, wrongKey: [] as string[] };
}

/** Spies installed before any page script: storage, cookies, IndexedDB, CSP violations, share. */
type ShareMode = 'resolve' | 'abort' | 'none';
type ClipboardMode = 'allow' | 'deny';

async function instrument(context: BrowserContext, { gpc = false, share = 'resolve' as ShareMode, clipboard = 'allow' as ClipboardMode } = {}) {
	await context.addInitScript(({ gpc, share, clipboard }) => {
		const w = window as any;
		w.__touched = [];
		w.__csp = [];
		const note = (what: string) => w.__touched.push(what);
		for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
			const original = Storage.prototype[name];
			Storage.prototype[name] = function (this: Storage, ...args: any[]) {
				note(`Storage.${name}`);
				return (original as any).apply(this, args);
			} as any;
		}
		const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
		Object.defineProperty(Document.prototype, 'cookie', {
			get() { note('cookie.get'); return cookie.get!.call(this); },
			set(v) { note('cookie.set'); cookie.set!.call(this, v); },
			configurable: true,
		});
		const idb = window.indexedDB;
		for (const name of ['open', 'deleteDatabase'] as const) {
			const original = idb[name].bind(idb);
			(idb as any)[name] = (...args: any[]) => { note(`indexedDB.${name}`); return (original as any)(...args); };
		}
		document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
		if (gpc) Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
		if (share !== 'none') {
			Object.defineProperty(Navigator.prototype, 'canShare', { value: () => true, configurable: true });
			Object.defineProperty(Navigator.prototype, 'share', {
				value: () => { w.__shareCalls = (w.__shareCalls ?? 0) + 1; return share === 'resolve' ? Promise.resolve() : Promise.reject(new DOMException('Share cancelled', 'AbortError')); },
				configurable: true,
			});
		}
		// The clipboard is stubbed so results don't depend on the machine's clipboard permission.
		Object.defineProperty(Navigator.prototype, 'clipboard', {
			get: () => ({ writeText: () => (clipboard === 'allow' ? Promise.resolve() : Promise.reject(new DOMException('Denied', 'NotAllowedError'))) }),
			configurable: true,
		});
	}, { gpc, share, clipboard });
}

async function newSession(browser: Browser, options: BrowserContextOptions & { gpc?: boolean; share?: ShareMode; clipboard?: ClipboardMode } = {}) {
	const { gpc, share, clipboard, ...contextOptions } = options;
	const context = await browser.newContext(contextOptions);
	await instrument(context, { gpc, share, clipboard });
	const rec = record(context);
	// Every Flagsmith request must carry the Development key. Anything else is stopped before it
	// leaves the browser, so a mis-keyed build can never send test traffic to Production.
	const devKey = process.env.FS_DEV_CLIENT_KEY;
	await context.route((url) => FLAGSMITH.includes(url.origin), (route) => {
		const request = route.request();
		if (request.method() === 'OPTIONS' || request.headers()['x-environment-key'] === devKey) return route.continue();
		rec.wrongKey.push(`${request.method()} ${new URL(request.url()).pathname}`);
		return route.abort('blockedbyclient');
	});
	const page = await context.newPage();
	const consoleCsp: string[] = [];
	page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text()); });
	await page.clock.install();
	recorders.set(page, rec);
	return { context, page, rec, consoleCsp };
}

/** Plays one passage through to its result. Returns the time the result was submitted. */
/** Each page's request recorder, so every passage waits for in-flight Flagsmith responses. */
const recorders = new WeakMap<Page, ReturnType<typeof record>>();

async function readPassage(page: Page, given?: ReturnType<typeof record>, before?: { exposuresBeforeSubmit?: number }) {
	const rec = given ?? recorders.get(page);
	// Fast-forwarding the fake clock would also fire the SDK's 3 s request timeout on a flush still
	// in flight, and the SDK would then resend that batch. Let in-flight requests finish first.
	if (rec) await waitFor(() => rec.settled(), 8000);
	await page.locator('[data-test-start]').click();
	// For an eligible visitor, Start makes the SDK request the flags for its identity; give that
	// request time to be issued (none comes for ineligible visitors) so it can settle before submit.
	if (rec) await waitFor(() => rec.flagsmith().some((r) => r.url.startsWith(`${EDGE}/api/v1/identities/`)), 3000);
	await page.clock.fastForward(60_000); // ~300 words in 60 s: about 300 wpm, past the 10 s minimum
	await page.locator('[data-test-done]').click();
	const fields = page.locator('[data-test-fields] fieldset');
	await expect(fields.first()).toBeVisible();
	const count = await fields.count();
	for (let i = 0; i < count; i++) await fields.nth(i).locator('input').first().check();
	// A real visitor reads for at least 10 s, long enough for the flags requested at Start to
	// arrive; the fake clock compresses that to a second or two, so wait for that response here.
	if (rec) await waitFor(() => rec.settled(), 8000);
	const submittedAt = Date.now();
	if (rec && before) before.exposuresBeforeSubmit = rec.sent().filter((e) => e.event === '$flag_exposure').length;
	await page.locator('[data-test-questions] button[type="submit"]').click();
	await expect(page.locator('[data-test-result]')).toBeVisible();
	return submittedAt;
}

async function toResult(page: Page, query = '', rec?: ReturnType<typeof record>) {
	await page.goto(`${PAGE}${query}`);
	return readPassage(page, rec);
}

const armOf = async (page: Page) => ((await page.locator('[data-feel-reader]').isVisible()) ? 'feel' : 'tell');

// Live Flagsmith round trips can take a few seconds, and the SDK sends one batch at a time.
async function waitFor(predicate: () => boolean, ms = 8000) {
	const end = Date.now() + ms;
	while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	return predicate();
}

async function expectClean(page: Page, rec: ReturnType<typeof record>, consoleCsp: string[], context: BrowserContext) {
	const touched = await page.evaluate(() => (window as any).__touched);
	expect(touched, 'no Storage, cookie or IndexedDB access').toEqual([]);
	expect(rec.wrongKey, 'every Flagsmith request used the Development key').toEqual([]);
	expect(await context.cookies(), 'no cookies').toEqual([]);
	expect(await page.evaluate(() => (window as any).__csp), 'no CSP violations').toEqual([]);
	expect(consoleCsp, 'no CSP console errors').toEqual([]);
	expect(await waitFor(() => rec.settled(), 12000), 'every Flagsmith request answered or abandoned by the SDK').toBe(true);
	// Every response Flagsmith sent is 2xx (a request the SDK abandoned at its timeout has none)...
	for (const r of rec.flagsmith().filter((x) => x.status !== undefined)) {
		expect(r.status, `${r.method} ${new URL(r.url).pathname} must be 2xx`).toBeGreaterThanOrEqual(200);
		expect(r.status!).toBeLessThan(300);
	}
	// ...the flags request was answered, and every distinct event reached Flagsmith with a 2xx.
	expect(rec.flagsmith().some((r) => r.url.startsWith(`${EDGE}/api/v1/identities/`)) === rec.flagsmith().some((r) => r.url.startsWith(`${EDGE}/api/v1/identities/`) && r.status !== undefined), 'the flags request was answered').toBe(true);
	for (const e of rec.sent()) expect(await waitFor(() => rec.delivered(e), 12000), `${e.event} delivered with a 2xx`).toBe(true);
}

// Eligible sessions sent to Flagsmith Development, by arm, for the proof gate (G2 item 6).
const tally = { sessions: 0, reachedResult: 0, exposed: 0, clickedGetReadSharp: 0, shared: 0, arms: { tell: 0, feel: 0 } as Record<string, number>, clicksByArm: { tell: 0, feel: 0 } as Record<string, number> };
/** Counts a session whose exposure was sent; returns its arm. */
async function countExposure(page: Page) {
	tally.sessions++; tally.reachedResult++; tally.exposed++;
	const arm = await armOf(page);
	tally.arms[arm]++;
	return arm;
}
async function countClick(page: Page) {
	tally.clickedGetReadSharp++;
	tally.clicksByArm[await armOf(page)]++;
}

test.describe.configure({ mode: 'serial' });

test('(a) ineligible visitors send nothing: GPC, ?optout, Europe/Berlin, UTC', async ({ browser }) => {
	const cases: [string, BrowserContextOptions & { gpc?: boolean }, string][] = [
		['GPC on', { gpc: true }, ''],
		['?optout', {}, '?optout'],
		['Europe/Berlin', { timezoneId: 'Europe/Berlin' }, ''],
		['UTC', { timezoneId: 'UTC' }, ''],
	];
	for (const [label, options, query] of cases) {
		const s = await newSession(browser, options);
		await s.page.goto(`${PAGE}${query}`);
		expect(await s.page.evaluate(() => typeof (window as any).flagsmith), `${label}: SDK not loaded before Start`).toBe('undefined');
		await readPassage(s.page);
		expect(await s.page.evaluate(() => typeof (window as any).flagsmith), `${label}: SDK still not loaded after the result`).toBe('undefined');
		await s.page.locator('[data-get-readsharp]').click();
		await s.page.waitForTimeout(2000);
		expect(s.rec.flagsmith(), `${label}: no Flagsmith requests at all`).toEqual([]);
		expect(await armOf(s.page), `${label}: tell`).toBe('tell');
		await expectClean(s.page, s.rec, s.consoleCsp, s.context);
		await s.context.close();
	}
});

test('(a)(b)(c)(d)(e)(i) an eligible view: nothing before Start, one exposure, events after it only', async ({ browser }) => {
	const s = await newSession(browser, { share: 'resolve', userAgent: MAC_UA });
	await s.page.goto(PAGE);
	await s.page.waitForTimeout(1500);
	expect(s.rec.flagsmith(), 'zero Flagsmith requests before Start').toEqual([]);
	expect(await s.page.evaluate(() => typeof (window as any).flagsmith), 'SDK not loaded before Start').toBe('undefined');
	const pageOrigin = new URL(s.page.url()).origin;
	const before: { exposuresBeforeSubmit?: number } = {};
	const submittedAt = await readPassage(s.page, s.rec, before);
	expect(before.exposuresBeforeSubmit, 'no $flag_exposure before the questions are submitted').toBe(0);
	tally.sessions++; tally.reachedResult++;
	expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure')), 'exposure sent').toBe(true);
	const exposures = s.rec.sent().filter((e) => e.event === '$flag_exposure');
	expect(exposures).toHaveLength(1);
	const exposure = exposures[0];
	expect(['feel', 'control']).toContain(exposure.value);
	expect(exposure.feature_name).toBe('speed_test_next_step');
	expect(exposure.metadata?.experiment_id).toBe(EXPERIMENT_ID);
	expect((exposure as any).at - submittedAt, 'exposure sent within 1 s of the render').toBeLessThanOrEqual(1000);
	const identity = s.rec.flagsmith().find((r) => r.url.startsWith(`${EDGE}/api/v1/identities/`));
	expect(identity, 'one identities request').toBeTruthy();
	const params = new URL(identity!.url).searchParams;
	expect(params.get('transient'), EXPECT_TRANSIENT ? 'transient identity' : 'persistent-ID fallback').toBe(EXPECT_TRANSIENT ? 'true' : null);
	expect(params.get('identifier')).toBe(exposure.identifier);
	tally.exposed++;
	tally.arms[await armOf(s.page)]++;
	expect(await armOf(s.page)).toBe(exposure.value === 'feel' ? 'feel' : 'tell');

	// (e) Get ReadSharp, then a successful share.
	await s.page.locator('[data-get-readsharp]').click();
	await expect(s.page.locator('[data-get-panel]')).toBeVisible();
	await countClick(s.page);
	await s.page.locator('[data-share-result]').click();
	tally.shared++;
	expect(await waitFor(() => s.rec.sent().some((e) => e.event === 'result_shared'))).toBe(true);
	const names = s.rec.sent().map((e) => e.event);
	expect(names.filter((n) => n === 'get_readsharp')).toHaveLength(1);
	expect(names.filter((n) => n === 'result_shared')).toHaveLength(1);
	expect(names.indexOf('$flag_exposure')).toBeLessThan(names.indexOf('get_readsharp'));
	expect(s.rec.sent().every((e) => e.identifier === exposure.identifier), 'one identifier for every event').toBe(true);
	expect(names.every((n) => ['$flag_exposure', 'get_readsharp', 'result_shared', 'feel_read_finished', 'installer_download', 'send_to_pc'].includes(n))).toBe(true);
	// (b) only the page origin and the two Flagsmith origins.
	expect([...new Set(s.rec.reqs.map((r) => r.origin))].sort()).toEqual([pageOrigin, ...FLAGSMITH.filter((o) => s.rec.reqs.some((r) => r.origin === o))].sort());
	expect(s.rec.reqs.every((r) => r.origin === pageOrigin || FLAGSMITH.includes(r.origin))).toBe(true);
	await expectClean(s.page, s.rec, s.consoleCsp, s.context);
	await s.context.close();
});

test('(e) a cancelled share sends nothing', async ({ browser }) => {
	const s = await newSession(browser, { share: 'abort', userAgent: MAC_UA });
	await toResult(s.page);
	tally.sessions++; tally.reachedResult++;
	expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure'))).toBe(true);
	tally.exposed++;
	tally.arms[await armOf(s.page)]++;
	await s.page.locator('[data-share-result]').click();
	await s.page.waitForTimeout(2500);
	expect(await s.page.evaluate(() => (window as any).__shareCalls), 'native share was used').toBe(1);
	expect(s.rec.sent().filter((e) => e.event === 'result_shared')).toEqual([]);
	await expectClean(s.page, s.rec, s.consoleCsp, s.context);
	await s.context.close();
});

test('(e) on Windows the share button copies instead; only a successful copy counts', async ({ browser }) => {
	for (const clipboard of ['allow', 'deny'] as const) {
		const s = await newSession(browser, { share: 'resolve', userAgent: WINDOWS_UA, clipboard });
		await toResult(s.page);
		tally.sessions++; tally.reachedResult++;
		expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure'))).toBe(true);
		tally.exposed++;
		tally.arms[await armOf(s.page)]++;
		await s.page.locator('[data-share-result]').click();
		if (clipboard === 'allow') {
			tally.shared++;
			expect(await waitFor(() => s.rec.sent().some((e) => e.event === 'result_shared')), 'a successful copy counts').toBe(true);
		} else {
			await s.page.waitForTimeout(2500);
			expect(s.rec.sent().filter((e) => e.event === 'result_shared'), 'a failed copy counts nothing').toEqual([]);
		}
		expect(await s.page.evaluate(() => (window as any).__shareCalls ?? 0), 'Windows never calls navigator.share').toBe(0);
		await expectClean(s.page, s.rec, s.consoleCsp, s.context);
		await s.context.close();
	}
});

test('(f) the installer event is delivered even though the click navigates away', async ({ browser, baseURL }) => {
	const s = await newSession(browser, { userAgent: WINDOWS_UA });
	const siteOrigin = new URL(baseURL!).origin;
	// The installer link points off-site; answer it locally so the test downloads nothing.
	await s.context.route((url) => url.origin !== siteOrigin && !FLAGSMITH.includes(url.origin), (route) =>
		route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>download</title>' }));
	await toResult(s.page);
	tally.sessions++; tally.reachedResult++;
	expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure'))).toBe(true);
	tally.exposed++;
	tally.arms[await armOf(s.page)]++;
	const before = s.page.url();
	// The navigation starts when its request is issued (before the new document commits).
	let navigationStartedAt = 0;
	s.page.on('request', (request) => {
		if (request.isNavigationRequest() && request.frame() === s.page.mainFrame() && request.url() !== before && !navigationStartedAt) navigationStartedAt = Date.now();
	});
	await s.page.locator('[data-get-readsharp]').click();
	await countClick(s.page);
	const link = s.page.locator('[data-installer-link]');
	await expect(link).toBeVisible();
	await Promise.all([s.page.waitForURL((u) => u.href !== before, { timeout: 5000 }), link.click()]);
	const delivered = s.rec.flagsmith().find((r) => r.events.some((e) => e.event === 'installer_download'));
	expect(delivered, 'installer_download was sent before leaving').toBeTruthy();
	expect(navigationStartedAt, 'the page navigated to a different URL').toBeGreaterThan(0);
	expect(delivered!.at, 'the installer_download POST was sent before the navigation started').toBeLessThanOrEqual(navigationStartedAt);
	const installerEvent = s.rec.sent().find((e) => e.event === 'installer_download')!;
	expect(await waitFor(() => s.rec.delivered(installerEvent), 12000), 'installer_download reached Flagsmith with a 2xx').toBe(true);
	await s.context.close();
});

test('(g) "Try another passage" keeps the identifier and the arm, with no second exposure', async ({ browser }) => {
	const s = await newSession(browser);
	await toResult(s.page);
	tally.sessions++; tally.reachedResult++;
	expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure'))).toBe(true);
	tally.exposed++;
	const arm = await armOf(s.page);
	tally.arms[arm]++;
	const first = s.rec.sent().find((e) => e.event === '$flag_exposure')!;
	await s.page.locator('[data-test-another]').click();
	await readPassage(s.page, s.rec);
	expect(await armOf(s.page)).toBe(arm);
	await s.page.locator('[data-get-readsharp]').click();
	await countClick(s.page);
	expect(await waitFor(() => s.rec.sent().some((e) => e.event === 'get_readsharp'))).toBe(true);
	expect(s.rec.sent().filter((e) => e.event === '$flag_exposure')).toHaveLength(1);
	expect(s.rec.sent().every((e) => e.identifier === first.identifier)).toBe(true);
	expect(s.rec.flagsmith().filter((r) => r.url.startsWith(`${EDGE}/api/v1/identities/`))).toHaveLength(1);
	await expectClean(s.page, s.rec, s.consoleCsp, s.context);
	await s.context.close();
});

test('(h) both arms appear across 20 sessions, each with exactly one exposure', async ({ browser }) => {
	const seen = { tell: 0, feel: 0 } as Record<string, number>;
	for (let i = 0; i < 20; i++) {
		const s = await newSession(browser);
		await toResult(s.page);
		tally.sessions++; tally.reachedResult++;
		expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure'))).toBe(true);
		tally.exposed++;
		const arm = await armOf(s.page);
		seen[arm]++;
		tally.arms[arm]++;
		const exposure = s.rec.sent().find((e) => e.event === '$flag_exposure')!;
		expect(arm).toBe(exposure.value === 'feel' ? 'feel' : 'tell');
		await s.page.locator('[data-get-readsharp]').click();
		await countClick(s.page);
		expect(await waitFor(() => s.rec.sent().some((e) => e.event === 'get_readsharp'))).toBe(true);
		expect(s.rec.sent().filter((e) => e.event === '$flag_exposure')).toHaveLength(1);
		await expectClean(s.page, s.rec, s.consoleCsp, s.context);
		await s.context.close();
	}
	expect(seen.tell, 'tell seen').toBeGreaterThan(0);
	expect(seen.feel, 'feel seen').toBeGreaterThan(0);
});

test('axe: no violations in the result card and the Feel reader', async ({ browser }) => {
	const found: Record<string, boolean> = { tell: false, feel: false };
	for (let i = 0; i < 12 && !(found.tell && found.feel); i++) {
		const s = await newSession(browser);
		await toResult(s.page);
		expect(await waitFor(() => s.rec.sent().some((e) => e.event === '$flag_exposure'))).toBe(true);
		const arm = await countExposure(s.page);
		if (!found[arm]) {
			found[arm] = true;
			const results = await new AxeBuilder({ page: s.page }).include('[data-test-result]').analyze();
			expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), `${arm} arm`).toEqual([]);
		}
		await s.context.close();
	}
	expect(found.tell && found.feel, 'both arms checked').toBe(true);
});

test.afterAll(() => {
	mkdirSync('test-results', { recursive: true });
	writeFileSync('test-results/e2e-counts.json', `${JSON.stringify({ ...tally, at: new Date().toISOString() }, null, 2)}\n`);
});
