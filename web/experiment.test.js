import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
	ARMS, EVENTS, FLAG, FLAGS_TIMEOUT_MS, LINK_FLUSH_MS,
	createExperiment, createMemoryStorage, keepaliveFetch, resetPageForTests,
} from './experiment.js';

const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** A fake window with a manual clock, so timeouts are exact and instant. */
function fakeWindow() {
	let now = 0;
	let id = 0;
	const timers = new Map();
	const listeners = {};
	return {
		crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
		setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
		clearTimeout: (t) => timers.delete(t),
		addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
		dispatch: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
		async advance(ms) {
			const target = now + ms;
			for (;;) {
				const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].fn();
				await settle();
			}
			now = target;
			await settle();
		},
	};
}

/** Mimics the parts of @flagsmith/flagsmith 12.6.0 this module uses, and records every call. */
function fakeSdk({ flag = { enabled: true, value: 'feel', variant: 'feel', experiment: { id: 958, inExperiment: true } }, initGate } = {}) {
	const calls = [];
	const sent = [];
	let buffer = [];
	let identity = null;
	let loaded = false;
	let flushGate = null;
	const sdk = {
		calls,
		sent,
		holdFlush() { flushGate = deferred(); return flushGate; },
		identify(id, traits, transient) {
			calls.push(['identify', id, traits, transient]);
			identity = id;
			return Promise.resolve();
		},
		async init(config) {
			calls.push(['init', config]);
			// Like the real core (flagsmith-core.ts:437): reads its event cache via AsyncStorage.
			await config.AsyncStorage.getItem(`FLAGSMITH_EVENT_${config.environmentID}`).then(() => {});
			await config.AsyncStorage.setItem('probe', 'x');
			if (initGate) await initGate;
			loaded = true;
		},
		getExperimentFlag(name) {
			calls.push(['getExperimentFlag', name]);
			if (loaded && identity && flag?.enabled && flag.experiment?.inExperiment) {
				buffer.push({ event: '$flag_exposure', identifier: identity, value: flag.variant, metadata: { experiment_id: flag.experiment.id } });
			}
			return loaded ? flag : null;
		},
		trackEvent(name) {
			calls.push(['trackEvent', name]);
			buffer.push({ event: name, identifier: identity });
		},
		async flushEvents() {
			calls.push(['flushEvents']);
			if (flushGate) await flushGate.promise;
			sent.push(...buffer);
			buffer = [];
		},
	};
	return sdk;
}

const names = (sdk) => sdk.calls.map((c) => c[0]);
let win;
beforeEach(() => {
	resetPageForTests();
	win = fakeWindow();
});

function setup({ eligible = true, sdk = fakeSdk() } = {}) {
	const exp = createExperiment({ sdk, environmentID: 'env-client-key', isEligible: () => eligible, win });
	return { exp, sdk };
}

test('ineligible: Start sets nothing up and sends nothing, and the arm is tell', async () => {
	const { exp, sdk } = setup({ eligible: false });
	assert.equal(exp.start(), false);
	const { arm, exposed } = await exp.result();
	assert.deepEqual({ arm, exposed }, { arm: ARMS.TELL, exposed: false });
	assert.equal(await exp.track(EVENTS.GET_READSHARP), false);
	assert.deepEqual(sdk.calls, [], 'no identify, no init, no flag read, no events, no flush (no network)');
});

test('an eligibility check that throws counts as ineligible (fail closed)', () => {
	const sdk = fakeSdk();
	const exp = createExperiment({ sdk, environmentID: 'k', isEligible: () => { throw new Error('boom'); }, win });
	assert.equal(exp.start(), false);
	assert.deepEqual(sdk.calls, []);
});

test('nothing is set up before Start, even for eligible visitors', async () => {
	const { exp, sdk } = setup();
	const { arm } = await exp.result();
	assert.equal(arm, ARMS.TELL);
	assert.deepEqual(sdk.calls, []);
});

test('Start identifies a transient in-memory UUID, then calls init once with the exact config', async () => {
	const { exp, sdk } = setup();
	assert.equal(exp.start(), true);
	assert.equal(exp.start(), false, 'a second Start does nothing');
	await settle();
	assert.deepEqual(names(sdk), ['identify', 'init']);
	assert.deepEqual(sdk.calls[0], ['identify', '11111111-2222-4333-8444-555555555555', undefined, true]);
	const config = sdk.calls[1][1];
	assert.deepEqual(Object.keys(config).sort(), ['AsyncStorage', 'cacheFlags', 'enableEvents', 'environmentID', 'fetch']);
	assert.equal(config.environmentID, 'env-client-key');
	assert.equal(config.enableEvents, true);
	assert.equal(config.cacheFlags, false);
	assert.equal(exp.identifier, '11111111-2222-4333-8444-555555555555');
});

test('the persistent-ID fallback sends the same random ID without transient', async () => {
	const sdk = fakeSdk();
	const exp = createExperiment({ sdk, environmentID: 'k', isEligible: () => true, win, transient: false });
	exp.start();
	await settle();
	assert.deepEqual(sdk.calls[0], ['identify', '11111111-2222-4333-8444-555555555555', undefined, false]);
});

test('only one SDK init per page: a second experiment object cannot init again', async () => {
	const { exp, sdk } = setup();
	exp.start();
	const other = createExperiment({ sdk, environmentID: 'env-client-key', isEligible: () => true, win });
	assert.equal(other.start(), false);
	await settle();
	assert.equal(sdk.calls.filter((c) => c[0] === 'init').length, 1);
});

test('the result records exactly one exposure, with the variant and experiment id, and fixes the arm', async () => {
	const { exp, sdk } = setup();
	exp.start();
	const seen = [];
	const first = await exp.result((arm) => seen.push(arm));
	assert.deepEqual({ ...first }, { arm: ARMS.FEEL, exposed: true });
	assert.deepEqual(sdk.sent, [{ event: '$flag_exposure', identifier: exp.identifier, value: 'feel', metadata: { experiment_id: 958 } }]);
	assert.deepEqual(sdk.calls.find((c) => c[0] === 'getExperimentFlag'), ['getExperimentFlag', FLAG]);
	assert.deepEqual(seen, ['feel']);
});

test('exactly one exposure per view across "Try another passage" (same arm, no second flag read)', async () => {
	const { exp, sdk } = setup();
	exp.start();
	await exp.result();
	exp.start(); // the second passage's Start
	const again = await exp.result();
	const third = await exp.result();
	assert.equal(again.arm, ARMS.FEEL);
	assert.equal(third.arm, ARMS.FEEL);
	assert.equal(sdk.calls.filter((c) => c[0] === 'getExperimentFlag').length, 1);
	assert.equal(sdk.sent.filter((e) => e.event === '$flag_exposure').length, 1);
});

test('control value maps to tell; anything other than "feel" is tell', async () => {
	for (const value of ['tell', null, 'FEEL', '']) {
		resetPageForTests();
		const { exp } = setup({ sdk: fakeSdk({ flag: { enabled: true, value, variant: 'control', experiment: { id: 958, inExperiment: true } } }) });
		exp.start();
		assert.equal((await exp.result()).arm, ARMS.TELL, String(value));
	}
});

test('no exposure when the practice message is null (no result is dispatched)', async () => {
	const { exp, sdk } = setup();
	exp.start();
	await settle();
	// reading-test.js dispatches "readingtest:result" only when practiceMessage() is non-null,
	// so a null message means result() is never called: no flag read, no exposure, no events.
	assert.equal(await exp.track(EVENTS.GET_READSHARP), false);
	assert.ok(!names(sdk).includes('getExperimentFlag'));
	assert.deepEqual(sdk.sent, []);
});

test('flags missing 1500 ms after the result: tell, no exposure, and no flag read later', async () => {
	const gate = deferred();
	const { exp, sdk } = setup({ sdk: fakeSdk({ initGate: gate.promise }) });
	exp.start();
	let fixed = null;
	exp.result().then((r) => { fixed = r; });
	await win.advance(FLAGS_TIMEOUT_MS - 1);
	assert.equal(fixed, null, 'still waiting at 1499 ms');
	await win.advance(1);
	assert.deepEqual({ ...fixed }, { arm: ARMS.TELL, exposed: false });
	gate.resolve();
	await settle();
	assert.equal((await exp.result()).arm, ARMS.TELL, 'arm stays tell for the view');
	assert.ok(!names(sdk).includes('getExperimentFlag'));
	assert.equal(await exp.track(EVENTS.GET_READSHARP), false);
	assert.deepEqual(sdk.sent, []);
});

test('an identity outside the experiment is not exposed and sends no events', async () => {
	const { exp, sdk } = setup({ sdk: fakeSdk({ flag: { enabled: true, value: 'tell', variant: 'control', experiment: { id: 958, inExperiment: false } } }) });
	exp.start();
	assert.deepEqual({ ...(await exp.result()) }, { arm: ARMS.TELL, exposed: false });
	assert.equal(await exp.track(EVENTS.GET_READSHARP), false);
	assert.deepEqual(sdk.sent, []);
	assert.ok(!names(sdk).includes('flushEvents'));
});

test('no events before the exposure', async () => {
	const { exp, sdk } = setup();
	exp.start();
	await settle();
	assert.equal(await exp.track(EVENTS.RESULT_SHARED), false);
	assert.ok(!names(sdk).includes('trackEvent'));
	await exp.result();
	assert.equal(await exp.track(EVENTS.RESULT_SHARED), true);
	assert.deepEqual(sdk.sent.map((e) => e.event), ['$flag_exposure', 'result_shared']);
	assert.ok(sdk.sent.every((e) => e.identifier === exp.identifier), 'same identifier as the exposure');
});

test('exact event names, and unknown names are refused', async () => {
	assert.deepEqual(Object.values(EVENTS), ['get_readsharp', 'result_shared', 'installer_download', 'send_to_pc', 'feel_read_finished']);
	assert.equal(FLAG, 'speed_test_next_step');
	const { exp } = setup();
	await assert.rejects(exp.track('Get_ReadSharp'), /Unknown experiment event/);
	await assert.rejects(exp.track('$flag_exposure'), /Unknown experiment event/);
});

test('the flush is awaited after the exposure, and the arm is rendered before it', async () => {
	const { exp, sdk } = setup();
	exp.start();
	const gate = sdk.holdFlush();
	const rendered = [];
	let done = false;
	const pending = exp.result((arm) => rendered.push(arm)).then(() => { done = true; });
	await settle(30);
	assert.deepEqual(rendered, ['feel'], 'arm handed over at the exposure moment');
	assert.equal(done, false, 'result() waits for the flush');
	assert.deepEqual(sdk.sent, []);
	gate.resolve();
	await pending;
	assert.equal(done, true);
	assert.equal(sdk.sent[0].event, '$flag_exposure');
});

test('each tracked event is flushed; for links the wait is capped at 800 ms', async () => {
	const { exp, sdk } = setup();
	exp.start();
	await exp.result();
	sdk.holdFlush(); // a flush that never finishes
	let followed = false;
	exp.track(EVENTS.INSTALLER_DOWNLOAD, { link: true }).then(() => { followed = true; });
	await win.advance(LINK_FLUSH_MS - 1);
	assert.equal(followed, false);
	await win.advance(1);
	assert.equal(followed, true);
	assert.deepEqual(sdk.calls.filter((c) => c[0] === 'trackEvent'), [['trackEvent', 'installer_download']]);
});

test('pagehide flushes best-effort after an exposure only', async () => {
	const { exp, sdk } = setup();
	exp.start();
	win.dispatch('pagehide');
	await settle();
	assert.ok(!names(sdk).includes('flushEvents'), 'no flush before exposure');
	await exp.result();
	const before = sdk.calls.filter((c) => c[0] === 'flushEvents').length;
	win.dispatch('pagehide');
	await settle();
	assert.equal(sdk.calls.filter((c) => c[0] === 'flushEvents').length, before + 1);
});

test('Storage, cookie and IndexedDB APIs are never touched (spies)', async (t) => {
	const touched = [];
	const spy = (name) => ({ get() { touched.push(name); throw new Error(`${name} touched`); }, configurable: true });
	const saved = {};
	for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'document']) {
		saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
	}
	Object.defineProperty(globalThis, 'localStorage', spy('localStorage'));
	Object.defineProperty(globalThis, 'sessionStorage', spy('sessionStorage'));
	Object.defineProperty(globalThis, 'indexedDB', spy('indexedDB'));
	Object.defineProperty(globalThis, 'document', { value: Object.defineProperty({}, 'cookie', spy('document.cookie')), configurable: true });
	t.after(() => {
		for (const [name, desc] of Object.entries(saved)) {
			if (desc) Object.defineProperty(globalThis, name, desc);
			else delete globalThis[name];
		}
	});
	const { exp } = setup();
	exp.start();
	await exp.result();
	await exp.track(EVENTS.GET_READSHARP);
	await exp.track(EVENTS.FEEL_READ_FINISHED);
	win.dispatch('pagehide');
	await settle();
	assert.deepEqual(touched, []);
});

test('the memory adapter matches the SDK AsyncStorage contract (promises, optional callback, sync read)', async () => {
	const storage = createMemoryStorage();
	const missing = storage.getItem('k');
	assert.ok(missing instanceof Promise);
	assert.equal(await missing, null);
	assert.equal(storage.getItemSync('k'), null);
	const set = storage.setItem('k', 'v');
	assert.ok(set instanceof Promise);
	assert.equal(await set, 'v');
	let viaCallback;
	assert.equal(await storage.getItem('k', (err, value) => { viaCallback = [err, value]; }), 'v');
	assert.deepEqual(viaCallback, [null, 'v']);
	assert.equal(storage.getItemSync('k'), 'v');
	assert.notStrictEqual(createMemoryStorage().getItemSync('k'), 'v', 'each adapter is separate');
});

afterEach(() => resetPageForTests());

test('with a loader, the SDK module is loaded only at an eligible Start', async () => {
	let loads = 0;
	const sdk = fakeSdk();
	const loader = () => { loads++; return Promise.resolve(sdk); };
	const ineligible = createExperiment({ sdk: loader, environmentID: 'k', isEligible: () => false, win });
	ineligible.start();
	await ineligible.result();
	assert.equal(loads, 0, 'ineligible: never loaded');
	const exp = createExperiment({ sdk: loader, environmentID: 'k', isEligible: () => true, win });
	await settle();
	assert.equal(loads, 0, 'not before Start');
	exp.start();
	const fixed = await exp.result();
	assert.equal(loads, 1);
	assert.deepEqual({ ...fixed }, { arm: ARMS.FEEL, exposed: true });
	assert.deepEqual(names(sdk).slice(0, 2), ['identify', 'init']);
	assert.equal(await exp.track(EVENTS.GET_READSHARP), true);
});

test('a result the visitor left before the flags arrived records nothing; the next result decides', async () => {
	const gate = deferred();
	const { exp, sdk } = setup({ sdk: fakeSdk({ initGate: gate.promise }) });
	exp.start();
	let active = true;
	const rendered = [];
	const first = exp.result((arm) => rendered.push(['first', arm]), { isActive: () => active });
	await settle();
	active = false; // "Try another passage" while flags are pending
	const second = exp.result((arm) => rendered.push(['second', arm]));
	gate.resolve();
	assert.deepEqual({ ...(await first) }, { arm: ARMS.TELL, exposed: false, abandoned: true });
	assert.deepEqual({ ...(await second) }, { arm: ARMS.FEEL, exposed: true });
	assert.deepEqual(rendered, [['second', 'feel']], 'only the shown result renders');
	assert.equal(sdk.calls.filter((c) => c[0] === 'getExperimentFlag').length, 1);
	assert.equal(sdk.sent.filter((e) => e.event === '$flag_exposure').length, 1);
});

test('a fixed arm is not re-rendered into a result that is no longer shown', async () => {
	const { exp } = setup();
	exp.start();
	await exp.result();
	const rendered = [];
	const again = await exp.result((arm) => rendered.push(arm), { isActive: () => false });
	assert.equal(again.arm, ARMS.FEEL);
	assert.deepEqual(rendered, []);
});

test('a later result renders the fixed arm without waiting for the first exposure flush', async () => {
	const { exp, sdk } = setup();
	exp.start();
	const gate = sdk.holdFlush();
	const first = exp.result();
	await settle(30);
	const rendered = [];
	await exp.result((arm) => rendered.push(arm));
	assert.deepEqual(rendered, ['feel'], 'second result rendered while the first flush is still pending');
	gate.resolve();
	await first;
	assert.equal(sdk.calls.filter((c) => c[0] === 'getExperimentFlag').length, 1);
});

test('the SDK fetch adds keepalive, and retries once without it if the browser refuses', async () => {
	const calls = [];
	const ok = { fetch: (url, init) => { calls.push(init); return Promise.resolve('response'); } };
	assert.equal(await keepaliveFetch(ok)('https://events.example/v1/events', { method: 'POST', body: '{}' }), 'response');
	assert.deepEqual(calls, [{ method: 'POST', body: '{}', keepalive: true }]);

	const seen = [];
	const refusing = { fetch: (url, init) => { seen.push(init.keepalive === true); return init.keepalive ? Promise.reject(new TypeError('keepalive not supported')) : Promise.resolve('plain'); } };
	assert.equal(await keepaliveFetch(refusing)('https://events.example/v1/events', { method: 'POST' }), 'plain');
	assert.deepEqual(seen, [true, false]);

	const controller = new AbortController();
	controller.abort();
	const aborted = { fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')) };
	await assert.rejects(keepaliveFetch(aborted)('https://x', { signal: controller.signal }), /aborted/, 'an aborted request is not retried');
});
