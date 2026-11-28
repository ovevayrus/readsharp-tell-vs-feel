import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  probBeats, mcSummary, analyze, buildJson, fetchSnapshot, PRODUCTION_CUTOFF,
  srmPValue, visitorsNeeded, buildReport,
} from '../lib.mjs';
import { run } from '../results.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const fx = (name) => JSON.parse(readFileSync(join(here, '..', 'fixtures', `${name}.json`), 'utf8'));
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

async function cli(args, io = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, env: {}, ...io });
  return { code, stdout, stderr };
}

test('exact P matches known values and is symmetric', () => {
  near(probBeats({ c: 24, n: 300 }, { c: 35, n: 300 }), 0.933, 0.002);
  near(probBeats({ c: 24, n: 300 }, { c: 37, n: 300 }), 0.96, 0.002);
  const a = { c: 24, n: 300 };
  const b = { c: 35, n: 310 };
  near(probBeats(a, b) + probBeats(b, a), 1, 1e-9);
});

test('exact P agrees with Monte Carlo and survives large counts', () => {
  const mc = mcSummary({ c: 52, n: 500 }, { c: 45, n: 500 });
  near(probBeats({ c: 52, n: 500 }, { c: 45, n: 500 }), mc.p_mc, 0.005);
  const big = probBeats({ c: 2000, n: 20000 }, { c: 2100, n: 20000 });
  near(big, mcSummary({ c: 2000, n: 20000 }, { c: 2100, n: 20000 }).p_mc, 0.005);
});

test('A/A-like case keeps running', () => {
  const r = analyze(fx('aa-like'));
  assert.ok(r.p > 0.05 && r.p < 0.95);
  assert.equal(r.decision.branch, 5);
});

test('24/300 vs 35/300 is branch 5', () => {
  const r = analyze(fx('p933'));
  near(r.p, 0.933, 0.002);
  assert.equal(r.decision.branch, 5);
  assert.equal(r.visitors.status, 'needed');
  assert.ok(r.visitors.extra_per_arm > 0);
});

test('24/300 vs 37/300 ships, guardrail not harmed', () => {
  const r = analyze(fx('p960'));
  near(r.p, 0.96, 0.002);
  assert.equal(r.guardrail.verdict, 'not harmed');
  assert.equal(r.decision.branch, 2);
  assert.equal(r.visitors.status, 'none_needed');
});

test('clear loser keeps control', () => {
  const r = analyze(fx('loser'));
  assert.ok(r.p <= 0.05);
  assert.equal(r.decision.branch, 4);
});

test('harmed guardrail blocks shipping', () => {
  const r = analyze(fx('guardrail-harmed'));
  assert.ok(r.p >= 0.95);
  assert.equal(r.guardrail.verdict, 'harmed');
  assert.equal(r.decision.branch, 3);
});

test('sparse guardrail is inconclusive and does not block', () => {
  const r = analyze(fx('guardrail-sparse'));
  assert.equal(r.guardrail.verdict, 'inconclusive (sparse)');
  assert.equal(r.decision.branch, 2);
});

test('under-50 exposures and SRM fail the gates', () => {
  const low = analyze(fx('low-exposure'));
  assert.equal(low.decision.branch, 1);
  assert.match(low.decision.text, /exposures/);
  const srm = analyze(fx('srm'));
  assert.equal(srm.decision.branch, 1);
  assert.match(srm.decision.text, /SRM/);
});

test('srmPValue: a 1-df chi-square against 50/50', () => {
  near(srmPValue(500, 500), 1, 1e-6);
  near(srmPValue(498, 502), 0.8994, 0.001); // chi2 = 0.016
  assert.ok(srmPValue(9120, 6400) < 1e-6);
  near(srmPValue(450, 550), 0.001565, 0.00005); // chi2 = 10
  assert.equal(srmPValue(0, 0), null);
});

test('a null Flagsmith SRM value is checked here from the exposures, not passed blindly', () => {
  const imbalanced = fx('p960');
  imbalanced.results.payload.srm_p_value = null;
  imbalanced.results.payload.exposures_timeseries = { points: [{ bucket: 'x', new_identities: { control: 300, b: 200 } }] };
  const r = analyze(imbalanced);
  assert.equal(r.gates[0].pass, false);
  assert.match(r.gates[0].detail, /chi-square on exposures here/);
  assert.equal(r.decision.branch, 1);
  const balanced = analyze(fx('aa-like'));
  assert.equal(balanced.gates[0].pass, true);
});

test('gate hints name the accepted values', () => {
  const r = analyze(fx('production'));
  assert.match(r.gates.find((g) => g.name === 'Wiring').detail, /--wiring pass\|fail/);
  assert.match(r.gates.find((g) => g.name === 'Canary').detail, /--canary seen\|missing/);
});

test('visitors needed for 24/300 vs 35/300 lands in the independently checked range', () => {
  // A separate exact-binomial simulation put 80% power between about 1,200 and 1,320 per arm.
  const v = visitorsNeeded({ c: 24, n: 300 }, { c: 35, n: 300 });
  assert.equal(v.status, 'needed');
  assert.ok(v.per_arm_total >= 1000 && v.per_arm_total <= 1700, `per arm ${v.per_arm_total}`);
});

test('with the canary subtracted, the Flagsmith comparison is labelled as unlike data', () => {
  const r = analyze(fx('production'), { wiring: 'pass', canary: 'seen', subtractCanary: 'control' });
  assert.match(buildReport(r), /ours \(canary subtracted\) minus theirs \(unadjusted\)/);
  assert.match(buildJson(r).primary.p_minus_flagsmith_basis, /canary subtracted/);
});

test('Production snapshot needs --wiring and --canary', () => {
  const missing = analyze(fx('production'));
  assert.equal(missing.decision.branch, 1);
  assert.match(missing.decision.text, /Wiring/);
  assert.match(missing.decision.text, /Canary/);
  assert.equal(analyze(fx('production'), { wiring: 'na', canary: 'na' }).decision.branch, 1);
  assert.equal(analyze(fx('production'), { wiring: 'pass', canary: 'seen' }).decision.branch, 2);
  assert.equal(analyze(fx('production'), { wiring: 'pass', canary: 'missing' }).decision.branch, 1);
});

test('--subtract-canary removes one visitor and one conversion', () => {
  const r = analyze(fx('production'), { wiring: 'pass', canary: 'seen', subtractCanary: 'b' });
  assert.deepEqual(r.snap.primary.variant, { c: 36, n: 299 });
  assert.deepEqual(r.snap.guardrail.variant, { c: 30, n: 299 });
  assert.equal(r.snap.exposures.variant, 299);
  assert.equal(r.snap.exposures.control, 300);
});

test('seeded Monte Carlo is reproducible and draws are bounded', () => {
  const a = mcSummary({ c: 24, n: 300 }, { c: 35, n: 300 }, { seed: 7 });
  const b = mcSummary({ c: 24, n: 300 }, { c: 35, n: 300 }, { seed: 7 });
  assert.deepEqual(a, b);
  assert.throws(() => mcSummary({ c: 24, n: 300 }, { c: 35, n: 300 }, { draws: 199999 }), /200000/);
});

test('BOM-prefixed raw file is read, with metric ids and env', async () => {
  const wrapped = fx('p960');
  const dir = mkdtempSync(join(tmpdir(), 'analysis-'));
  const file = join(dir, 'raw.json');
  writeFileSync(file, `﻿${JSON.stringify({ results: wrapped.results })}`, 'utf8');
  const missing = await cli(['--file', file]);
  assert.equal(missing.code, 1);
  const r = await cli(['--file', file, '--primary', '10', '--guardrail', '11', '--env', 'production', '--wiring', 'pass', '--canary', 'seen']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Branch 2: Ship the variant/);
  assert.match(r.stdout, /RESULT \(Production/);
});

test('CLI end to end on docs/aa/results.json', () => {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [join(root, 'analysis', 'results.mjs'), '--file', join(root, 'docs', 'aa', 'results.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Date.now() - t0 < 15000);
  assert.match(res.stdout, /^\*\*VALIDATION \(Development, experiment 965/);
  assert.equal((res.stdout.match(/```json/g) || []).length, 1);
  const json = JSON.parse(res.stdout.split('```json')[1].split('```')[0]);
  near(json.primary.p_variant_beats_control, 0.211, 0.02);
});

// ---- fetch mode, offline ----

const FAKE_KEY = 'fake-admin-key-1234567890';
const ENV_KEY = 'fake-env-key-abcdef';

function fakeFetch({ asOf, post = 202, calls = [] } = {}) {
  const wrapped = fx('p960');
  const results = { ...wrapped.results, as_of: asOf };
  let refreshed = false;
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization });
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/projects/')) return json([{ id: 5, name: 'P' }]);
    if (url.includes('/environments/?project=5')) {
      return json([{ id: 1, name: 'Development', api_key: 'dev-key-xxxx' }, { id: 2, name: 'Production', api_key: ENV_KEY }]);
    }
    if (url.endsWith('/results/refresh/')) {
      refreshed = true;
      return json({}, post);
    }
    if (url.endsWith('/results/')) {
      return json({ results: refreshed && post < 400 ? { ...results, as_of: '2099-01-01T00:00:00Z' } : results });
    }
    if (/\/experiments\/\d+\/$/.test(url)) {
      return json({
        id: 7, name: 'Exp', status: 'running', started_at: 'x',
        feature: { name: 'flag', multivariate_options: [{ id: 2, key: 'b', string_value: 'b' }] },
        metrics: wrapped.experiment.metrics,
        experiment_rollout: { feature_state_value: { value: 'a' } },
      });
    }
    return json({}, 404);
  };
}

const AFTER = () => new Date(Date.parse(PRODUCTION_CUTOFF) + 1000);
const BEFORE = () => new Date(Date.parse(PRODUCTION_CUTOFF) - 1000);

test('fetch mode: Authorization header, environment by name, wrapped snapshot', async () => {
  const calls = [];
  const snap = await fetchSnapshot({
    env: 'development', experimentId: 7, apiKey: FAKE_KEY,
    fetchImpl: fakeFetch({ asOf: '2026-11-28T00:00:00Z', calls }), now: () => new Date('2026-11-28T00:03:00Z'),
  });
  assert.ok(calls.every((c) => c.auth === `Api-Key ${FAKE_KEY}`));
  assert.ok(calls.some((c) => c.url.includes('/environments/dev-key-xxxx/experiments/7/results/')));
  assert.equal(snap.environment.name, 'Development');
  assert.equal(snap.experiment.flag, 'flag');
  assert.deepEqual(snap.experiment.variants, [{ id: 2, key: 'b', value: 'b' }]);
});

test('fetch mode: refresh skipped when as_of is fresh, and at most one refresh', async () => {
  const calls = [];
  const msgs = [];
  const fresh = await fetchSnapshot({
    env: 'development', experimentId: 7, apiKey: FAKE_KEY, refresh: true,
    fetchImpl: fakeFetch({ asOf: '2026-11-28T00:00:00Z', calls }), now: () => new Date('2026-11-28T00:02:00Z'), log: (m) => msgs.push(m),
  });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(msgs.join(' '), /skipped/);
  assert.equal(fresh.results.as_of, '2026-11-28T00:00:00Z');

  const calls2 = [];
  const stale = await fetchSnapshot({
    env: 'development', experimentId: 7, apiKey: FAKE_KEY, refresh: true,
    fetchImpl: fakeFetch({ asOf: '2026-11-28T00:00:00Z', calls: calls2 }), now: () => new Date('2026-11-28T00:10:00Z'), sleep: async () => {},
  });
  assert.equal(calls2.filter((c) => c.method === 'POST').length, 1);
  assert.equal(stale.results.as_of, '2099-01-01T00:00:00Z');
});

test('fetch mode: 429 on refresh uses existing results', async () => {
  const msgs = [];
  const snap = await fetchSnapshot({
    env: 'development', experimentId: 7, apiKey: FAKE_KEY, refresh: true, log: (m) => msgs.push(m),
    fetchImpl: fakeFetch({ asOf: '2026-11-28T00:00:00Z', post: 429 }), now: () => new Date('2026-11-28T01:00:00Z'), sleep: async () => {},
  });
  assert.equal(snap.results.as_of, '2026-11-28T00:00:00Z');
  assert.match(msgs.join(' '), /429/);
});

test('fetch mode: Production refused before the cutoff, allowed after', async () => {
  const calls = [];
  await assert.rejects(
    fetchSnapshot({ env: 'production', experimentId: 7, apiKey: FAKE_KEY, fetchImpl: fakeFetch({ asOf: 'x', calls }), now: BEFORE }),
    /Refusing to read Production/,
  );
  assert.equal(calls.length, 0);
  const snap = await fetchSnapshot({ env: 'production', experimentId: 7, apiKey: FAKE_KEY, fetchImpl: fakeFetch({ asOf: '2026-11-29T05:00:00Z', calls }), now: AFTER });
  assert.equal(snap.environment.name, 'Production');
  assert.ok(calls.some((c) => c.url.includes(`/environments/${ENV_KEY}/`)));
});

test('keys never appear in stdout, stderr or thrown messages', async () => {
  const leaky = async (url) => { throw new Error(`socket failed for ${url} with ${FAKE_KEY}`); };
  const r = await cli(['--env', 'development', '--experiment', '7'], { env: { FLAGSMITH_API_KEY: FAKE_KEY }, fetch: leaky, now: AFTER });
  assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes(FAKE_KEY));
  assert.match(r.stderr, /<key>/);

  const badEnvKey = async (url) => {
    if (url.endsWith('/projects/')) return { ok: true, status: 200, json: async () => [{ id: 5 }] };
    if (url.includes('/environments/?project=')) return { ok: true, status: 200, json: async () => [{ id: 1, name: 'Development', api_key: ENV_KEY }] };
    throw new Error(`boom at ${url}`);
  };
  await assert.rejects(
    fetchSnapshot({ env: 'development', experimentId: 7, apiKey: FAKE_KEY, fetchImpl: badEnvKey, now: AFTER }),
    (e) => !e.message.includes(ENV_KEY) && !e.message.includes(FAKE_KEY),
  );

  const save = join(mkdtempSync(join(tmpdir(), 'analysis-')), 's.json');
  const ok = await cli(['--env', 'development', '--experiment', '7', '--save', save],
    { env: { FLAGSMITH_API_KEY: FAKE_KEY }, fetch: fakeFetch({ asOf: '2026-11-28T00:00:00Z' }), now: AFTER });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(!ok.stdout.includes(FAKE_KEY) && !ok.stdout.includes(ENV_KEY));
  assert.ok(!ok.stderr.includes(FAKE_KEY));
  const saved = readFileSync(save, 'utf8');
  assert.ok(!saved.includes(FAKE_KEY) && !saved.includes(ENV_KEY));
});

test('CLI refuses Production fetch before the cutoff', async () => {
  const r = await cli(['--env', 'production', '--experiment', '7'], { env: { FLAGSMITH_API_KEY: FAKE_KEY }, fetch: fakeFetch({ asOf: 'x' }), now: BEFORE });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Production/);
  assert.equal(r.stdout, '');
});

test('JSON output is serialisable', () => {
  assert.doesNotThrow(() => JSON.stringify(buildJson(analyze(fx('p933')))));
});
