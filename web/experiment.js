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

// A second SDK init on the page would reset the SDK's module-level storage adapter, so the
// guard is module-wide, not per experiment object.
let pageInitialised = false;

/** For tests only: forget that this page already initialised the SDK. */
export function resetPageForTests() {
	pageInitialised = false;
}

/**
 * @param {object} options
 * @param {object} options.sdk the Flagsmith JS SDK instance (default export of @flagsmith/flagsmith)
 * @param {string} options.environmentID the client-side environment key
 * @param {() => boolean} options.isEligible eligibility check, called at Start
 * @param {() => string} [options.randomUUID]
 * @param {object} [options.win] the window (timers and pagehide)
 */
export function createExperiment({ sdk, environmentID, isEligible, randomUUID, win = globalThis }) {
	const uuid = randomUUID ?? (() => win.crypto.randomUUID());
	let ready = null; // Promise<boolean>: flags loaded for our identity
	let identifier = null;
	let decision = null; // Promise of the fixed { arm, exposed } for this page view
	let exposed = false;

	const wait = (ms) => new Promise((resolve) => win.setTimeout(() => resolve(false), ms));
	const flush = (ms) => {
		const flushed = Promise.resolve().then(() => sdk.flushEvents()).then(() => true, () => false);
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
			.then(() => sdk.identify(identifier, undefined, true))
			.then(() => sdk.init({ environmentID, enableEvents: true, cacheFlags: false, AsyncStorage: createMemoryStorage() }))
			.then(() => true, () => false);
		win.addEventListener?.('pagehide', () => {
			if (exposed) flush();
		});
		return true;
	}

	/**
	 * Readingtest "result": fixes the arm for the rest of the page view. The first call records
	 * the exposure (via getExperimentFlag) and calls onArm(arm) at that moment, before awaiting
	 * the flush; later calls return the same arm and record nothing.
	 */
	function result(onArm) {
		if (decision) {
			return decision.then((fixed) => {
				onArm?.(fixed.arm);
				return fixed;
			});
		}
		decision = (async () => {
			const loaded = ready ? await Promise.race([ready, wait(FLAGS_TIMEOUT_MS)]) : false;
			let arm = ARMS.TELL;
			if (loaded) {
				const flag = sdk.getExperimentFlag(FLAG);
				arm = flag?.value === ARMS.FEEL ? ARMS.FEEL : ARMS.TELL;
				exposed = flag?.enabled !== false && flag?.experiment?.inExperiment === true;
			}
			const fixed = Object.freeze({ arm, exposed });
			onArm?.(arm);
			if (exposed) await flush();
			return fixed;
		})();
		return decision;
	}

	/**
	 * Records a conversion event, only after an exposure, then flushes. With { link: true } the
	 * flush wait is capped at LINK_FLUSH_MS so a link can be followed promptly. Resolves to
	 * whether an event was recorded.
	 */
	async function track(name, { link = false } = {}) {
		if (!EVENT_NAMES.has(name)) throw new Error(`Unknown experiment event: ${name}`);
		if (!exposed) return false;
		sdk.trackEvent(name);
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
