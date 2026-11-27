const environmentDocumentUrl = 'https://edge.api.flagsmith.com/api/v1/environment-document/';
const batchSize = 250;
const optionNames = new Set([
  '--flag', '--n', '--p-control', '--p-variant', '--p-share', '--seed', '--concurrency',
]);

export class SimError extends Error {}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!optionNames.has(name)) {
      throw new SimError('Unknown simulator option. Use --flag, --n, --p-control, --p-variant, --p-share, --seed, or --concurrency.');
    }

    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || !value.trim() || value.startsWith('--')) {
      throw new SimError(`${name} requires a value.`);
    }
    values.set(name, value);
  }

  const flag = values.get('--flag');
  if (flag !== 'aa_check' && flag !== 'effect_check') {
    throw new SimError('--flag must be aa_check or effect_check.');
  }

  function numberOption(name, fallback, min, max, integer = false) {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      const type = integer ? 'an integer' : 'a number';
      throw new SimError(`${name} must be ${type} between ${min} and ${max}.`);
    }
    return value;
  }

  const pControl = numberOption('--p-control', 0.1, 0, 1);
  return {
    flag,
    n: numberOption('--n', 1000, 1, 20000, true),
    pControl,
    pVariant: numberOption('--p-variant', pControl, 0, 1),
    pShare: numberOption('--p-share', 0.05, 0, 1),
    seed: numberOption('--seed', 1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true),
    concurrency: numberOption('--concurrency', 5, 1, 20, true),
  };
}

export function createRng(seed, index = 0) {
  // Mix both halves of the seed and give each identity its own Mulberry32 state.
  const high = Math.floor(seed / 0x100000000);
  let state = (seed ^ Math.imul(high, 0x9e3779b9)) + Math.imul(index, 0x9e3779b9);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

export function decideConversions(arm, { pControl, pVariant, pShare }, random) {
  return {
    get_readsharp: random() < (arm === 'control' ? pControl : pVariant),
    result_shared: random() < pShare,
  };
}

export async function assertDevelopment(env, fetchImpl) {
  if (env.SIM_ENV !== 'development') {
    throw new SimError('Set SIM_ENV=development to run the simulator.');
  }
  const environmentKey = env.FS_DEV_SERVER_KEY;
  if (!environmentKey) {
    throw new SimError('FS_DEV_SERVER_KEY is required.');
  }
  if (typeof environmentKey !== 'string' || !environmentKey.startsWith('ser.')) {
    throw new SimError('FS_DEV_SERVER_KEY must be a server-side key starting with ser.');
  }

  if (env.FLAGSMITH_API_KEY && env.DEV_ENV_ID) {
    const expectedId = Number(env.DEV_ENV_ID);
    if (!Number.isFinite(expectedId)) {
      throw new SimError('DEV_ENV_ID must be numeric.');
    }

    let document;
    try {
      const response = await fetchImpl(environmentDocumentUrl, {
        method: 'GET',
        headers: { 'X-Environment-Key': environmentKey },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        document = await response.json();
      }
    } catch {
      throw new SimError('Could not verify the Development environment ID.');
    }
    if (!document || typeof document.id !== 'number') {
      throw new SimError('Could not verify the Development environment ID.');
    }
    if (document.id !== expectedId) {
      throw new SimError('FS_DEV_SERVER_KEY does not match DEV_ENV_ID.');
    }
  }

  return environmentKey;
}

export async function runSim(options, { env, fetchImpl, createClient }) {
  const { flag, n, seed, pControl, pVariant, pShare, concurrency } = options;
  const startedAt = new Date().toISOString();
  const environmentKey = await assertDevelopment(env, fetchImpl);
  const credentials = [environmentKey, env.FLAGSMITH_API_KEY].filter(Boolean);
  const arms = new Map();
  let errors = 0;
  const countError = () => { errors++; };

  let client;
  try {
    client = await createClient({
      environmentKey,
      enableEvents: true,
      enableLocalEvaluation: true,
      eventProcessorConfig: { flushInterval: 0 },
      // SDK failures can contain request details. Count them without logging their contents.
      logger: { debug() {}, warn: countError, error: countError },
    });
  } catch {
    throw new SimError('Could not start the Flagsmith client.');
  }

  async function simulateIdentity(index) {
    const identifier = `sim-${flag}-${seed}-${index}`;
    try {
      const result = await client.getExperimentFlag(flag, identifier);
      if (!result || result.isDefault || result.enabled === false) {
        errors++;
        return;
      }

      if (result.experiment?.inExperiment === false) {
        return;
      }
      // Actual SDK Flags have a feature ID and only queue an exposure with experiment metadata and a variant.
      if (Object.hasOwn(result, 'featureId') && (!result.experiment?.inExperiment || result.variant == null)) {
        errors++;
        return;
      }

      const arm = result.variant == null || result.variant === 'control' ? 'control' : 'variant';
      const label = String(result.variant ?? result.value ?? arm);
      const armName = credentials.some((key) => label.includes(key)) ? arm : label;
      if (!arms.has(armName)) {
        arms.set(armName, { exposures: 0, get_readsharp: 0, result_shared: 0 });
      }
      const counts = arms.get(armName);
      counts.exposures++;

      const random = createRng(seed, index);
      for (const [event, converted] of Object.entries(decideConversions(arm, options, random))) {
        if (converted) {
          try {
            await client.trackEvent(event, { identifier });
            counts[event]++;
          } catch {
            errors++;
          }
        }
      }
    } catch {
      errors++;
    }
  }

  try {
    // At most three events per identity fit comfortably in the SDK's 1000-event buffer.
    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(start + batchSize, n);
      let next = start;
      async function work() {
        while (next < end) {
          await simulateIdentity(next++);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, end - start) }, work));
      try {
        await client.flushEvents?.();
      } catch {
        errors++;
      }
    }
  } finally {
    try {
      await client.close();
    } catch {
      errors++;
    }
  }

  return {
    flag, n, seed, pControl, pVariant, pShare,
    evaluation: 'local',
    arms: Object.fromEntries(arms),
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
