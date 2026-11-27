// Tell vs Feel: the browser side of the Flagsmith experiment on the reading speed test.
//
// Privacy rules this module enforces (see EXPERIMENT.md):
//   • Nothing is set up or sent unless the visitor is eligible AND presses Start.
//   • One SDK instance, initialised once, with an in-memory storage adapter, so the SDK never
//     reads or writes localStorage. No cookies.
//   • A transient identity: a random UUID held in memory for this page view only.
//   • The arm is fixed at the first result of the view. An exposure is recorded only then, and
//     events are sent only after an exposure.
//
// The SDK instance is passed in (the site passes the default export of @flagsmith/flagsmith),
// so this file has no imports and is unit-testable with a fake SDK.

export const FLAG = 'speed_test_next_step';
export const ARMS = Object.freeze({ TELL: 'tell', FEEL: 'feel' });
export const EVENTS = Object.freeze({
	GET_READSHARP: 'get_readsharp',
	RESULT_SHARED: 'result_shared',
	INSTALLER_DOWNLOAD: 'installer_download',
	SEND_TO_PC: 'send_to_pc',
	FEEL_READ_FINISHED: 'feel_read_finished',
});
/** How long after a result to wait for flags before defaulting to "tell" with no exposure. */
export const FLAGS_TIMEOUT_MS = 1500;
/** How long to wait for an event flush before following a link. */
export const LINK_FLUSH_MS = 800;

const EVENT_NAMES = new Set(Object.values(EVENTS));
/** What result() resolves to for a result the visitor left before the flags arrived. */
const ABANDONED = Object.freeze({ arm: ARMS.TELL, exposed: false, abandoned: true });

/** A promise-returning in-memory AsyncStorage for the SDK (its default adapter uses localStorage). */
export function createMemoryStorage() {
	const items = new Map();
	return {
		getItemSync: (key) => (items.has(key) ? items.get(key) : null),
		getItem(key, callback) {
			const value = items.has(key) ? items.get(key) : null;
			callback?.(null, value);
			return Promise.resolve(value);
		},
		setItem(key, value, callback) {
			items.set(key, String(value));
			callback?.(null, String(value));
			return Promise.resolve(String(value));
		},
	};
}

/**
 * The SDK's fetch, with keepalive: an event sent just before the visitor follows a link (the
 * installer) would otherwise be cancelled by the navigation when the events API is slow. A browser
 * that refuses keepalive for a request gets the same request once more without it.
 */
export function keepaliveFetch(win) {
	return async (url, init = {}) => {
		try {
			return await win.fetch(url, { ...init, keepalive: true });
		} catch (error) {
			if (init.signal?.aborted) throw error;
			return win.fetch(url, init);
		}
	};
}

// A second SDK init on the page would reset the SDK's module-level storage adapter, so the
// guard is module-wide, not per experiment object.
let pageInitialised = false;

/** For tests only: forget that this page already initialised the SDK. */
export function resetPageForTests() {
	pageInitialised = false;
}

/**
 * @param {object} options
 * @param {object | (() => Promise<object>)} options.sdk the Flagsmith JS SDK instance (default export
 *   of @flagsmith/flagsmith), or a loader resolving to it. With a loader the SDK module is evaluated
 *   only at an eligible Start, so nothing (not even the SDK object) exists before then.
 * @param {string} options.environmentID the client-side environment key
 * @param {() => boolean} options.isEligible eligibility check, called at Start
 * @param {() => string} [options.randomUUID]
 * @param {object} [options.win] the window (timers and pagehide)
 * @param {boolean} [options.transient] true (default): Flagsmith does not store the random identity.
 *   false is the pre-approved fallback (G2 item 3): the same random per-view ID, stored by Flagsmith.
 */
export function createExperiment({ sdk, environmentID, isEligible, randomUUID, win = globalThis, transient = true }) {
	const uuid = randomUUID ?? (() => win.crypto.randomUUID());
	let client = null; // the SDK instance, once loaded at Start
	let ready = null; // Promise<boolean>: flags loaded for our identity
	let identifier = null;
	let fixed = null; // the { arm, exposed } fixed for this page view
	let pending = null; // a result() still deciding
	let exposed = false;

	const wait = (ms) => new Promise((resolve) => win.setTimeout(() => resolve(false), ms));
	const flush = (ms) => {
		const flushed = Promise.resolve().then(() => client.flushEvents()).then(() => true, () => false);
		return ms === undefined ? flushed : Promise.race([flushed, wait(ms)]);
	};

	/** Readingtest "start": sets up the SDK once, and only for eligible visitors. */
	function start() {
		if (ready || pageInitialised) return false;
		let eligible = false;
		try {
			eligible = isEligible() === true;
		} catch {
			eligible = false;
		}
		if (!eligible || !environmentID) return false;
		pageInitialised = true;
		identifier = uuid();
		// identify() before init() only sets the context, so init's single request is the
		// transient identity call (identities/?identifier=…&transient=true).
		ready = Promise.resolve()
			.then(() => (typeof sdk === 'function' ? sdk() : sdk))
			.then((instance) => {
				client = instance;
				return client.identify(identifier, undefined, transient === true);
			})
			.then(() => client.init({ environmentID, enableEvents: true, cacheFlags: false, AsyncStorage: createMemoryStorage(), fetch: keepaliveFetch(win) }))
			.then(() => true, () => false);
		win.addEventListener?.('pagehide', () => {
			if (exposed) flush();
		});
		return true;
	}

	async function decide(onArm, isActive) {
		const loaded = ready ? await Promise.race([ready, wait(FLAGS_TIMEOUT_MS)]) : false;
		// The visitor left this result while flags were on their way (e.g. "Try another
		// passage"): record nothing and fix nothing; the next shown result decides.
		if (!isActive()) return ABANDONED;
		let arm = ARMS.TELL;
		if (loaded) {
			const flag = client.getExperimentFlag(FLAG);
			arm = flag?.value === ARMS.FEEL ? ARMS.FEEL : ARMS.TELL;
			exposed = flag?.enabled !== false && flag?.experiment?.inExperiment === true;
		}
		fixed = Object.freeze({ arm, exposed });
		onArm?.(arm);
		if (exposed) await flush();
		return fixed;
	}

	/**
	 * Readingtest "result": fixes the arm for the rest of the page view. The first shown result
	 * records the exposure (via getExperimentFlag) and calls onArm(arm) at that moment, before
	 * awaiting the flush; later results get the same arm and record nothing. isActive() is checked
	 * right before the flag is read: a result the visitor already left is abandoned (no exposure,
	 * no onArm, arm not fixed), and a result() called meanwhile waits for it, then decides itself.
	 */
	async function result(onArm, { isActive = () => true } = {}) {
		// Once the arm is fixed, later results render at once, without waiting for the
		// exposure's flush to finish.
		while (pending && !fixed) await pending;
		if (fixed) {
			if (isActive()) onArm?.(fixed.arm);
			return fixed;
		}
		pending = decide(onArm, isActive);
		try {
			return await pending;
		} finally {
			pending = null;
		}
	}

	/**
	 * Records a conversion event, only after an exposure, then flushes. With { link: true } the
	 * flush wait is capped at LINK_FLUSH_MS so a link can be followed promptly. Resolves to
	 * whether an event was recorded.
	 */
	async function track(name, { link = false } = {}) {
		if (!EVENT_NAMES.has(name)) throw new Error(`Unknown experiment event: ${name}`);
		if (!exposed) return false;
		client.trackEvent(name);
		await flush(link ? LINK_FLUSH_MS : undefined);
		return true;
	}

	return {
		start,
		result,
		track,
		get identifier() {
			return identifier;
		},
		get exposed() {
			return exposed;
		},
	};
}
