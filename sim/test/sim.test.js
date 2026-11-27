import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDevelopment, createRng, decideConversions, parseArgs, runSim } from '../lib.mjs';

const serverKey = ['ser', 'sim-test-fixture'].join('.');
const apiKey = ['admin', 'sim-test-fixture'].join('.');
const developmentEnv = { SIM_ENV: 'development', FS_DEV_SERVER_KEY: serverKey };

function rejectsWithoutSecrets(promise, message, secrets = [serverKey, apiKey]) {
  return assert.rejects(promise, (error) => {
    assert.ok(secrets.every((secret) => !error.message.includes(secret)), 'Error exposed a fixture key');
    assert.match(error.message, message);
    return true;
  });
}

function fakeClient(arm) {
  const lookups = [];
  const events = [];
  const flushes = [];
  const closes = [];
  const configurations = [];

  return {
    lookups,
    events,
    flushes,
    closes,
    configurations,
    createClient(config) {
      configurations.push(config);
      return {
        async getExperimentFlag(flag, identifier) {
          lookups.push([flag, identifier]);
          return { enabled: true, variant: arm, value: 'control', experiment: { inExperiment: true } };
        },
        async trackEvent(name, { identifier }) {
          await new Promise((resolve) => setImmediate(resolve));
          events.push([name, identifier]);
        },
        async flushEvents() {
          await new Promise((resolve) => setImmediate(resolve));
          flushes.push(events.length);
        },
        async close() {
          closes.push(flushes.length);
        },
      };
    },
  };
}

test('argument parsing applies the requested defaults', () => {
  assert.deepEqual(parseArgs(['--flag', 'aa_check']), {
    flag: 'aa_check', n: 1000, pControl: 0.1, pVariant: 0.1, pShare: 0.05, seed: 1, concurrency: 5,
  });
});

test('p-variant defaults to the parsed p-control but accepts an explicit override', () => {
  assert.equal(parseArgs(['--flag', 'effect_check', '--p-control', '0']).pVariant, 0);
  const options = parseArgs([
    '--flag', 'effect_check', '--p-variant', '0.25', '--p-control', '1', '--p-share', '0',
    '--n', '20000', '--seed', '53', '--concurrency', '20',
  ]);
  assert.deepEqual(options, {
    flag: 'effect_check', n: 20000, pControl: 1, pVariant: 0.25, pShare: 0, seed: 53, concurrency: 20,
  });
});

test('argument parsing rejects missing flags, unsupported options, and invalid ranges', () => {
  for (const argv of [[], ['--flag'], ['--flag', 'unknown']]) {
    assert.throws(() => parseArgs(argv));
  }
  for (const [option, values] of [
    ['--unknown', ['1']],
    ['--n', ['0', '20001', '2.5', '']],
    ['--concurrency', ['0', '21', '2.5']],
    ['--p-control', ['-0.01', '1.01', 'NaN', '']],
    ['--p-variant', ['-0.01', '1.01', 'Infinity']],
    ['--p-share', ['-0.01', '1.01', 'text']],
  ]) {
    for (const value of values) {
      assert.throws(() => parseArgs(['--flag', 'aa_check', option, value]), `${option}=${value}`);
    }
  }
});

test('the RNG reproduces sequences by seed and index and stays in [0, 1)', () => {
  function sequence(seed, index) {
    const random = createRng(seed, index);
    return Array.from({ length: 32 }, () => random());
  }

  const baseline = sequence(7, 18);
  assert.deepEqual(baseline, sequence(7, 18));
  assert.notDeepEqual(baseline, sequence(8, 18));
  assert.notDeepEqual(baseline, sequence(7, 19));
  assert.ok(baseline.every((value) => value >= 0 && value < 1));
});

test('a conversion probability of 0.1 produces the expected rate across 5000 identities', () => {
  const options = { pControl: 0.1, pVariant: 0, pShare: 0.1 };
  let conversions = 0;
  let shares = 0;

  for (let index = 0; index < 5000; index++) {
    const result = decideConversions('control', options, createRng(17, index));
    conversions += Number(result.get_readsharp);
    shares += Number(result.result_shared);
  }

  assert.ok(conversions >= 400 && conversions <= 600, `Conversions: ${conversions}`);
  assert.ok(shares >= 400 && shares <= 600, `Shares: ${shares}`);
});

test('the safety check requires Development and a server-side key', async () => {
  const wrongPrefix = ['client', 'sim-test-fixture'].join('.');
  let requests = 0;
  const fetchImpl = async () => { requests++; };

  await rejectsWithoutSecrets(assertDevelopment({ FS_DEV_SERVER_KEY: serverKey }, fetchImpl), /SIM_ENV/i);
  await rejectsWithoutSecrets(assertDevelopment({ ...developmentEnv, SIM_ENV: 'production' }, fetchImpl), /development/i);
  await rejectsWithoutSecrets(assertDevelopment({ SIM_ENV: 'development' }, fetchImpl), /FS_DEV_SERVER_KEY/i);
  await rejectsWithoutSecrets(
    assertDevelopment({ ...developmentEnv, FS_DEV_SERVER_KEY: wrongPrefix }, fetchImpl),
    /server|ser\./i,
    [wrongPrefix],
  );
  assert.equal(requests, 0);
});

test('the edge API check uses the server key and requires the numeric Development environment ID', async () => {
  const environment = { ...developmentEnv, FLAGSMITH_API_KEY: apiKey, DEV_ENV_ID: '42' };
  const requests = [];
  function respond(id) {
    return async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, json: async () => ({ id }) };
    };
  }

  await rejectsWithoutSecrets(assertDevelopment(environment, respond(41)), /environment|DEV_ENV_ID/i);
  await rejectsWithoutSecrets(assertDevelopment(environment, respond('42')), /environment|DEV_ENV_ID/i);
  assert.ok(await assertDevelopment(environment, respond(42)) === serverKey, 'Expected the validated server key');
  assert.equal(requests.length, 3);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://edge.api.flagsmith.com/api/v1/environment-document/');
    assert.equal(init.method ?? 'GET', 'GET');
    const headers = new Headers(init.headers);
    assert.ok(headers.get('X-Environment-Key') === serverKey, 'Expected the server key in the request header');
    assert.ok([...headers.values()].every((value) => !value.includes(apiKey)), 'Admin key reached the edge API');
  }
});

test('the edge API check is optional unless both variables are set and sanitizes fetch failures', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    throw new Error(`${serverKey} ${apiKey}`);
  };

  await assertDevelopment({ ...developmentEnv, FLAGSMITH_API_KEY: apiKey }, fetchImpl);
  await assertDevelopment({ ...developmentEnv, DEV_ENV_ID: '42' }, fetchImpl);
  assert.equal(requests, 0);
  await rejectsWithoutSecrets(assertDevelopment({
    ...developmentEnv, FLAGSMITH_API_KEY: apiKey, DEV_ENV_ID: '42',
  }, fetchImpl), /environment|verify/i);
  assert.equal(requests, 1);
});

test('runSim applies each arm probability and closes once after flushing its events', async () => {
  const options = parseArgs([
    '--flag', 'aa_check', '--n', '3', '--p-control', '1', '--p-variant', '0', '--p-share', '1',
  ]);

  for (const [arm, conversions] of [['control', 3], ['treatment', 0]]) {
    const { lookups, events, flushes, closes, configurations, createClient } = fakeClient(arm);
    const summary = await runSim(options, { env: developmentEnv, createClient });

    assert.equal(configurations.length, 1);
    assert.ok(configurations[0].environmentKey === serverKey, 'Expected the validated server key');
    assert.equal(configurations[0].enableEvents, true);
    assert.equal(configurations[0].enableLocalEvaluation, true);
    assert.deepEqual(lookups, [0, 1, 2].map((index) => ['aa_check', `sim-aa_check-1-${index}`]));
    assert.deepEqual(summary.arms, {
      [arm]: { exposures: 3, get_readsharp: conversions, result_shared: 3 },
    });
    assert.equal(summary.errors, 0);
    assert.equal(summary.flag, 'aa_check');
    assert.equal(summary.n, 3);
    assert.equal(summary.seed, 1);
    assert.equal(summary.pControl, 1);
    assert.equal(summary.pVariant, 0);
    assert.equal(summary.pShare, 1);
    assert.equal(summary.evaluation, 'local');
    assert.ok(Date.parse(summary.startedAt) <= Date.parse(summary.finishedAt));
    assert.deepEqual(flushes, [3 + conversions]);
    assert.deepEqual(closes, [1]);
    assert.ok(!JSON.stringify(summary).includes(serverKey), 'Summary exposed the server key');

    for (const [, identifier] of lookups) {
      assert.ok(events.some(([name, id]) => name === 'result_shared' && id === identifier));
      assert.equal(events.some(([name, id]) => name === 'get_readsharp' && id === identifier), conversions > 0);
    }
  }
});

test('changing concurrency leaves each identity’s events unchanged', async () => {
  const options = parseArgs([
    '--flag', 'effect_check', '--n', '50', '--seed', '5', '--p-variant', '0.4', '--p-share', '0.3',
  ]);
  const serial = fakeClient('treatment');
  const concurrent = fakeClient('treatment');
  await runSim({ ...options, concurrency: 1 }, { env: developmentEnv, createClient: serial.createClient });
  await runSim({ ...options, concurrency: 7 }, { env: developmentEnv, createClient: concurrent.createClient });
  assert.deepEqual(serial.events.sort(), concurrent.events.sort());
});

test('runSim refuses unsafe input before constructing a client', async () => {
  const { configurations, createClient } = fakeClient('control');
  await rejectsWithoutSecrets(runSim(parseArgs(['--flag', 'aa_check']), {
    env: { ...developmentEnv, SIM_ENV: 'production' },
    createClient,
  }), /development/i);
  assert.equal(configurations.length, 0);
});

test('unenrolled identities send no conversions and a control can use its own flag value', async () => {
  const results = [
    { featureId: 1, enabled: true, variant: 'control', experiment: { inExperiment: false } },
    { featureId: 1, enabled: true, value: 'baseline', experiment: undefined },
    { enabled: true, value: 'baseline', experiment: { inExperiment: true } },
    { featureId: 1, enabled: true, variant: 'treatment', experiment: { inExperiment: true } },
  ];
  const events = [];
  const options = parseArgs([
    '--flag', 'effect_check', '--n', '4', '--p-control', '1', '--p-variant', '0', '--p-share', '0',
  ]);
  const summary = await runSim(options, {
    env: developmentEnv,
    createClient: () => ({
      getExperimentFlag: () => results.shift(),
      trackEvent: (name, { identifier }) => events.push([name, identifier]),
      close() {},
    }),
  });

  assert.deepEqual(events, [['get_readsharp', 'sim-effect_check-1-2']]);
  assert.deepEqual(summary.arms, {
    baseline: { exposures: 1, get_readsharp: 1, result_shared: 0 },
    treatment: { exposures: 1, get_readsharp: 0, result_shared: 0 },
  });
  assert.equal(summary.errors, 1);
});

test('SDK failures and arm labels cannot expose credentials in the summary', async () => {
  const options = parseArgs([
    '--flag', 'effect_check', '--n', '1', '--p-variant', '1', '--p-share', '1',
  ]);
  const summary = await runSim(options, {
    env: { ...developmentEnv, FLAGSMITH_API_KEY: apiKey },
    createClient: ({ logger }) => ({
      getExperimentFlag() {
        logger.warn(new Error(serverKey));
        return { variant: `${serverKey} ${apiKey}` };
      },
      trackEvent(name) {
        if (name === 'get_readsharp') {
          throw new Error(apiKey);
        }
      },
      close() {},
    }),
  });

  assert.ok([serverKey, apiKey].every((key) => !JSON.stringify(summary).includes(key)));
  assert.deepEqual(summary.arms, { variant: { exposures: 1, get_readsharp: 0, result_shared: 1 } });
  assert.equal(summary.errors, 2);
});

test('large runs flush before the SDK buffer can fill', async () => {
  const { createClient, flushes, closes } = fakeClient('treatment');
  const options = parseArgs([
    '--flag', 'aa_check', '--n', '501', '--p-variant', '1', '--p-share', '1', '--concurrency', '20',
  ]);
  const summary = await runSim(options, { env: developmentEnv, createClient });

  assert.deepEqual(summary.arms, { treatment: { exposures: 501, get_readsharp: 501, result_shared: 501 } });
  assert.deepEqual(flushes, [500, 1000, 1002]);
  assert.deepEqual(closes, [3]);
});
