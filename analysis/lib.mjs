// Bayesian analysis for the Tell vs Feel experiment. Pure functions, Node built-ins only.
// Decision rule: EXPERIMENT.md ("Decision rule"). Applied literally.

export const PRIOR = { alpha: 1, beta: 1 };
// The registered final snapshot is the first refresh at or after Sat 28 Nov 2026 23:00 EST plus the
// measured 6-minute ingestion lag (docs/RUNBOOK.md): 23:06 EST. Nothing reads Production results before it.
export const PRODUCTION_CUTOFF = '2026-11-29T04:06:00Z'; // Sat 28 Nov 2026 23:06 EST
export const MIN_DRAWS = 200000;
export const DEFAULT_SEED = 20261128;
export const API_BASE = 'https://api.flagsmith.com/api/v1/';
const REFRESH_MIN_AGE_MS = 5 * 60 * 1000;
const POLL_CAP_MS = 90 * 1000;
const POLL_EVERY_MS = 3000;

// ---------- special functions ----------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export function lnBeta(a, b) {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

// ---------- exact P(variant > control) ----------

// Posterior of an arm with c conversions in n visitors is Beta(1 + c, 1 + n - c).
// Evan Miller closed form: P = sum_{i=0}^{a2-1} exp(lnB(a1+i,b1+b2) - ln(b2+i) - lnB(1+i,b2) - lnB(a1,b1)).
// Terms are computed by the ratio t(i+1)/t(i) = (a1+i)(b2+i) / ((a1+i+b1+b2)(1+i)),
// rescaled on the fly so that very small first terms cannot underflow.
export function probBeats(control, variant) {
  const a1 = PRIOR.alpha + control.c;
  const b1 = PRIOR.beta + control.n - control.c;
  const a2 = PRIOR.alpha + variant.c;
  const b2 = PRIOR.beta + variant.n - variant.c;
  const B = b1 + b2;
  let offset = lnBeta(a1, B) - Math.log(b2) - lnBeta(1, b2) - lnBeta(a1, b1); // ln t0
  let t = 1;
  let sum = 0;
  for (let i = 0; i < a2; i++) {
    sum += t;
    t *= ((a1 + i) * (b2 + i)) / ((a1 + i + B) * (1 + i));
    if (t > 1e100) { t /= 1e100; sum /= 1e100; offset += 100 * Math.LN10; }
  }
  const p = sum * Math.exp(offset);
  return Math.min(1, Math.max(0, p));
}

// ---------- seeded sampling ----------

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNormal(rng) {
  let spare = null;
  return function normal() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = rng();
    while (u === 0) u = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * rng();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

// Marsaglia-Tsang; shape >= 1 here (posterior shapes are 1 + integer).
export function gammaSample(shape, rng, normal) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a, b, rng, normal) {
  const x = gammaSample(a, rng, normal);
  const y = gammaSample(b, rng, normal);
  return x / (x + y);
}

function posterior(arm) {
  return [PRIOR.alpha + arm.c, PRIOR.beta + arm.n - arm.c];
}

export function checkDraws(draws) {
  if (!Number.isInteger(draws) || draws < MIN_DRAWS) {
    throw new Error(`--draws must be an integer of at least ${MIN_DRAWS}`);
  }
}

function drawPair(control, variant, draws, seed) {
  checkDraws(draws);
  const rng = mulberry32(seed);
  const normal = makeNormal(rng);
  const [ca, cb] = posterior(control);
  const [va, vb] = posterior(variant);
  const pc = new Float64Array(draws);
  const pv = new Float64Array(draws);
  for (let i = 0; i < draws; i++) {
    pc[i] = betaSample(ca, cb, rng, normal);
    pv[i] = betaSample(va, vb, rng, normal);
  }
  return { pc, pv };
}

export function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function mcSummary(control, variant, { seed = DEFAULT_SEED, draws = MIN_DRAWS } = {}) {
  const { pc, pv } = drawPair(control, variant, draws, seed);
  const rel = new Float64Array(draws);
  const diff = new Float64Array(draws);
  let lossVariant = 0;
  let lossControl = 0;
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    rel[i] = pv[i] / pc[i] - 1;
    diff[i] = (pv[i] - pc[i]) * 100;
    if (pv[i] > pc[i]) { lossControl += pv[i] - pc[i]; wins++; } else lossVariant += pc[i] - pv[i];
  }
  rel.sort();
  diff.sort();
  const sum = (arr) => ({
    median: quantile(arr, 0.5),
    low: quantile(arr, 0.025),
    high: quantile(arr, 0.975),
  });
  return {
    draws,
    seed,
    relative_lift: sum(rel),
    absolute_diff_points: sum(diff),
    expected_loss_points: {
      choose_variant: (lossVariant / draws) * 100,
      choose_control: (lossControl / draws) * 100,
    },
    p_mc: wins / draws,
  };
}

// ---------- guardrail ----------

export function guardrailVerdict(control, variant, { seed = DEFAULT_SEED, draws = MIN_DRAWS } = {}) {
  if (control.c < 5 || variant.c < 5) {
    return { verdict: 'inconclusive (sparse)', p_harm: null, harmed: false, sparse: true };
  }
  const { pc, pv } = drawPair(control, variant, draws, seed);
  let hits = 0;
  for (let i = 0; i < draws; i++) if (pv[i] <= pc[i] - 0.01) hits++;
  const pHarm = hits / draws;
  const harmed = pHarm >= 0.9;
  return { verdict: harmed ? 'harmed' : 'not harmed', p_harm: pHarm, harmed, sparse: false };
}

// ---------- visitors needed ----------

function binomialDraw(m, p, z, u) {
  if (m <= 0 || p <= 0) return 0;
  if (p >= 1) return m;
  const v = m * p * (1 - p);
  if (v > 10) {
    const x = Math.round(m * p + Math.sqrt(v) * z);
    return x < 0 ? 0 : x > m ? m : x;
  }
  if (p > 0.5) return m - binomialDraw(m, 1 - p, -z, 1 - u);
  const odds = p / (1 - p);
  let pmf = Math.pow(1 - p, m);
  let cum = pmf;
  let k = 0;
  while (cum < u && k < m) {
    pmf *= ((m - k) / (k + 1)) * odds;
    k++;
    cum += pmf;
  }
  return k;
}

export function visitorsNeeded(control, variant, opts = {}) {
  const { seed = DEFAULT_SEED, sims = 2000, cap = 20000, target = 0.95, power = 0.8 } = opts;
  const current = probBeats(control, variant);
  const nNow = Math.max(control.n, variant.n);
  if (current >= target) return { status: 'none_needed', per_arm_total: nNow, extra_per_arm: 0 };
  if (nNow >= cap) return { status: 'cap_hit', cap, power_at_cap: null };

  const rng = mulberry32(seed);
  const normal = makeNormal(rng);
  const [ca, cb] = posterior(control);
  const [va, vb] = posterior(variant);
  const draws = [];
  for (let i = 0; i < sims; i++) {
    draws.push({
      pc: betaSample(ca, cb, rng, normal),
      pv: betaSample(va, vb, rng, normal),
      zc: normal(), zv: normal(), uc: rng(), uv: rng(),
    });
  }
  const successRate = (N) => {
    let ok = 0;
    for (const d of draws) {
      const xc = binomialDraw(Math.max(0, N - control.n), d.pc, d.zc, d.uc);
      const xv = binomialDraw(Math.max(0, N - variant.n), d.pv, d.zv, d.uv);
      const p = probBeats(
        { c: control.c + xc, n: Math.max(N, control.n) },
        { c: variant.c + xv, n: Math.max(N, variant.n) },
      );
      if (p >= target) ok++;
    }
    return ok / sims;
  };
  const atCap = successRate(cap);
  if (atCap < power) return { status: 'cap_hit', cap, power_at_cap: atCap };
  let lo = nNow;
  let hi = cap;
  while (hi - lo > Math.max(25, 0.02 * hi)) {
    const mid = Math.ceil((lo + hi) / 2);
    if (successRate(mid) >= power) hi = mid; else lo = mid;
  }
  return { status: 'needed', per_arm_total: hi, extra_per_arm: hi - nNow, sims, power, target };
}

// ---------- snapshot normalisation ----------

function fail(msg) { throw new Error(msg); }

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pickArms(variants) {
  const keys = Object.keys(variants || {});
  if (!keys.includes('control')) fail('results have no arm keyed "control"');
  const others = keys.filter((k) => k !== 'control');
  if (others.length !== 1) fail(`expected exactly one variant besides control, found ${others.length}`);
  return others[0];
}

// Returns a wrapped snapshot for both input shapes.
export function toWrapped(input, { env, primary, guardrail } = {}) {
  if (input && input.results && input.environment && input.experiment) {
    const out = structuredClone(input);
    out._overrides = { primary, guardrail };
    return out;
  }
  if (input && input.results && input.results.payload) {
    if (primary == null || guardrail == null) fail('a raw API response needs --primary and --guardrail metric ids');
    if (env !== 'development' && env !== 'production') fail('a raw API response needs --env development|production');
    return {
      source: 'raw API response',
      environment: { name: env === 'production' ? 'Production' : 'Development' },
      experiment: { metrics: [] },
      results: input.results,
      _overrides: { primary, guardrail },
    };
  }
  fail('unrecognised input: expected a wrapped snapshot or a raw { results } response');
}

function armCounts(metric, key) {
  const a = metric.variants[key];
  if (!a) fail(`metric ${metric.metric_id} has no arm "${key}"`);
  return { n: a.n, sum: a.sum };
}

export function normalize(wrapped, { subtractCanary } = {}) {
  const exp = wrapped.experiment || {};
  const results = wrapped.results;
  const payload = results && results.payload;
  if (!payload || !Array.isArray(payload.metrics)) fail('results.payload.metrics is missing');
  const ov = wrapped._overrides || {};
  const metricsMeta = exp.metrics || [];
  const idOf = (m) => m.metric;
  let primaryId = ov.primary != null ? Number(ov.primary) : undefined;
  let guardId = ov.guardrail != null ? Number(ov.guardrail) : undefined;
  if (primaryId === undefined) {
    const m = metricsMeta.find((x) => x.expected_direction === 'increase');
    if (!m) fail('no metric with expected_direction "increase"; pass --primary <metric id>');
    primaryId = idOf(m);
  }
  if (guardId === undefined) {
    const m = metricsMeta.find((x) => x.expected_direction === 'not_decrease');
    guardId = m ? idOf(m) : null;
  }
  const nameOf = (id) => (metricsMeta.find((x) => idOf(x) === id) || {}).metric_name || `metric ${id}`;
  const find = (id) => {
    const m = payload.metrics.find((x) => Number(x.metric_id) === Number(id));
    if (!m) fail(`metric ${id} not found in results`);
    return m;
  };
  const pm = find(primaryId);
  const variantKey = pickArms(pm.variants);
  const sub = subtractCanary || null;
  if (sub && sub !== 'control' && sub !== variantKey) fail(`--subtract-canary must be "control" or "${variantKey}"`);

  const arm = (metric, key, isPrimary) => {
    let { n, sum } = armCounts(metric, key);
    if (sub === key) {
      n -= 1;
      if (isPrimary && sum >= 1) sum -= 1;
    }
    return { c: sum, n };
  };
  const buildMetric = (metric, id, isPrimary) => {
    if (pickArms(metric.variants) !== variantKey) fail(`metric ${id} has a different variant key`);
    const inf = metric.inference && metric.inference[variantKey];
    return {
      id,
      name: nameOf(id),
      control: arm(metric, 'control', isPrimary),
      variant: arm(metric, variantKey, isPrimary),
      flagsmith: inf
        ? { chance_to_win: inf.chance_to_win, lift: inf.lift, ci_low: inf.ci_low, ci_high: inf.ci_high }
        : null,
    };
  };
  const primary = buildMetric(pm, primaryId, true);
  const guardrail = guardId == null ? null : buildMetric(find(guardId), guardId, false);

  // exposures
  const points = (payload.exposures_timeseries && payload.exposures_timeseries.points) || [];
  const exp_ = { control: 0, variant: 0 };
  let sawExposure = false;
  for (const p of points) {
    const ni = p.new_identities || {};
    if (ni.control != null) { exp_.control += ni.control; sawExposure = true; }
    if (ni[variantKey] != null) { exp_.variant += ni[variantKey]; sawExposure = true; }
  }
  let exposureSource = 'exposures_timeseries';
  if (!sawExposure) {
    exp_.control = primary.control.n;
    exp_.variant = primary.variant.n;
    exposureSource = 'primary metric n';
  } else if (sub) {
    if (sub === 'control') exp_.control -= 1; else exp_.variant -= 1;
  }

  const envName = wrapped.environment && wrapped.environment.name;
  if (envName !== 'Development' && envName !== 'Production') fail('environment name must be Development or Production');
  return {
    environment: envName,
    experiment_id: exp.id ?? null,
    experiment_name: exp.name ?? null,
    label: wrapped.label ?? null,
    as_of: results.as_of ?? null,
    is_final: !!results.is_final,
    srm_p_value: payload.srm_p_value ?? null,
    variant_key: variantKey,
    exposures: exp_,
    exposure_source: exposureSource,
    canary_subtracted: sub,
    primary,
    guardrail,
  };
}

// ---------- gates and decision ----------

// Complementary error function (Numerical Recipes erfcc, fractional error < 1.2e-7).
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Chi-square test (1 df) of the two arms' exposures against the configured 50/50 split. */
export function srmPValue(control, variant) {
  const total = control + variant;
  if (total <= 0) return null;
  const expected = total / 2;
  const chi2 = ((control - expected) ** 2 + (variant - expected) ** 2) / expected;
  return erfc(Math.sqrt(chi2 / 2));
}

export function evaluateGates(snap, { wiring, canary }) {
  const isDev = snap.environment === 'Development';
  const gates = [];
  const srm = snap.srm_p_value;
  // Flagsmith warns at p < 0.001. It returned null even at 1,000 identities in Development, so a
  // null is not taken as a pass: the same test is computed here from the exposures per arm.
  if (srm != null) {
    gates.push({ name: 'SRM', pass: !(srm < 0.001), detail: `Flagsmith srm_p_value ${srm}${srm < 0.001 ? ' (< 0.001)' : ''}` });
  } else {
    const local = srmPValue(snap.exposures.control, snap.exposures.variant);
    gates.push(local == null
      ? { name: 'SRM', pass: false, detail: 'no exposures to check' }
      : { name: 'SRM', pass: !(local < 0.001), detail: `Flagsmith returned null; chi-square on exposures here p = ${local.toPrecision(3)}${local < 0.001 ? ' (< 0.001)' : ''}` });
  }

  const e = snap.exposures;
  const pc = snap.primary.control.c;
  const pv = snap.primary.variant.c;
  const problems = [];
  if (e.control < 50) problems.push(`control has ${e.control} exposures (< 50)`);
  if (e.variant < 50) problems.push(`${snap.variant_key} has ${e.variant} exposures (< 50)`);
  if (pc < 5) problems.push(`control has ${pc} ${snap.primary.name} conversions (< 5)`);
  if (pv < 5) problems.push(`${snap.variant_key} has ${pv} ${snap.primary.name} conversions (< 5)`);
  gates.push({
    name: 'Sample',
    pass: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `exposures ${e.control}/${e.variant}, conversions ${pc}/${pv}`,
  });

  const check = (name, val, good, bad) => {
    if (isDev && (val == null || val === 'na')) return { name, pass: true, detail: 'n/a (validation run)' };
    if (val == null || val === 'na') return { name, pass: false, detail: `not given for a Production snapshot (--${name.toLowerCase()} ${good}|${bad})` };
    return { name, pass: val === good, detail: val };
  };
  gates.push(check('Wiring', wiring, 'pass', 'fail'));
  gates.push(check('Canary', canary, 'seen', 'missing'));
  return gates;
}

export function decide(p, guardrail, gates) {
  const failed = gates.filter((g) => !g.pass);
  if (failed.length) {
    return { branch: 1, text: `No decision: ${failed.map((g) => `${g.name}: ${g.detail}`).join('; ')}. Keep running.` };
  }
  const harmed = !!(guardrail && guardrail.harmed);
  if (p >= 0.95 && !harmed) return { branch: 2, text: 'Ship the variant.' };
  if (p >= 0.95 && harmed) return { branch: 3, text: "Don't ship: report the trade-off." };
  if (p <= 0.05) return { branch: 4, text: 'Keep control.' };
  return { branch: 5, text: 'Keep running.' };
}

export function analyze(input, opts = {}) {
  const {
    env, primary, guardrail, wiring, canary, subtractCanary,
    seed = DEFAULT_SEED, draws = MIN_DRAWS, sims = 2000,
  } = opts;
  checkDraws(draws);
  for (const [k, v, ok] of [['wiring', wiring, ['pass', 'fail', 'na']], ['canary', canary, ['seen', 'missing', 'na']]]) {
    if (v != null && !ok.includes(v)) fail(`--${k} must be one of ${ok.join('|')}`);
  }
  const wrapped = toWrapped(input, { env, primary, guardrail });
  const snap = normalize(wrapped, { subtractCanary });
  const pr = snap.primary;
  const p = probBeats(pr.control, pr.variant);
  const mc = mcSummary(pr.control, pr.variant, { seed, draws });
  const gr = snap.guardrail ? guardrailVerdict(snap.guardrail.control, snap.guardrail.variant, { seed: seed + 1, draws }) : null;
  const visitors = visitorsNeeded(pr.control, pr.variant, { seed: seed + 2, sims });
  const gates = evaluateGates(snap, { wiring, canary });
  const decision = decide(p, gr, gates);
  const diffFs = pr.flagsmith ? (p - pr.flagsmith.chance_to_win) * 100 : null;
  return { snap, p, mc, guardrail: gr, visitors, gates, decision, diffFs };
}

// ---------- report ----------

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const sgn = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

function visitorsText(v) {
  if (v.status === 'none_needed') return 'none more needed (P is already at least 95%)';
  if (v.status === 'cap_hit') return 'more than 20,000 per arm (cap hit)';
  return `about ${v.per_arm_total} per arm in total, ${v.extra_per_arm} more per arm (80% chance of reaching P >= 95%, ${v.sims} simulations)`;
}

export function buildReport(r) {
  const { snap, p, mc, guardrail: gr, visitors, gates, decision, diffFs } = r;
  const pr = snap.primary;
  const vk = snap.variant_key;
  const exp = snap.experiment_id != null ? `experiment ${snap.experiment_id}${snap.experiment_name ? ` "${snap.experiment_name}"` : ''}` : 'experiment (raw file)';
  const head = snap.environment === 'Development' ? 'VALIDATION' : 'RESULT';
  const lines = [];
  lines.push(`**${head} (${snap.environment}, ${exp}, as of ${snap.as_of})**${snap.canary_subtracted ? ' with the launch canary subtracted' : ''}`);
  lines.push('');
  lines.push(`Primary ${pr.name}: control ${pr.control.c}/${pr.control.n} (${pct(pr.control.c / pr.control.n)}), ${vk} ${pr.variant.c}/${pr.variant.n} (${pct(pr.variant.c / pr.variant.n)}). Prior Beta(1,1) uniform.`);
  lines.push(`- Interval (95%): relative lift ${sgn(mc.relative_lift.median * 100)}% (${sgn(mc.relative_lift.low * 100)}% to ${sgn(mc.relative_lift.high * 100)}%); difference ${sgn(mc.absolute_diff_points.median, 2)} points (${sgn(mc.absolute_diff_points.low, 2)} to ${sgn(mc.absolute_diff_points.high, 2)})`);
  lines.push(`- P(${vk} beats control) = ${p.toFixed(4)} (exact)`);
  if (gr) {
    lines.push(`- Guardrail ${snap.guardrail.name}: control ${snap.guardrail.control.c}/${snap.guardrail.control.n}, ${vk} ${snap.guardrail.variant.c}/${snap.guardrail.variant.n}: ${gr.verdict}${gr.p_harm != null ? ` (P(at least 1 point lower) = ${gr.p_harm.toFixed(3)})` : ''}`);
    if (gr.sparse) lines.push('  Note: the guardrail is inconclusive; per EXPERIMENT.md only "harmed" blocks shipping.');
  } else {
    lines.push('- Guardrail: none found');
  }
  lines.push(`- Expected loss (context only): choose ${vk} ${mc.expected_loss_points.choose_variant.toFixed(3)} points, choose control ${mc.expected_loss_points.choose_control.toFixed(3)} points`);
  lines.push(`- Visitors needed: ${visitorsText(visitors)}`);
  const fl = pr.flagsmith;
  lines.push(fl
    ? `- Flagsmith: chance_to_win ${fl.chance_to_win.toFixed(4)}, lift ${sgn(fl.lift * 100)}% (${sgn(fl.ci_low * 100)}% to ${sgn(fl.ci_high * 100)}%); ours${snap.canary_subtracted ? ' (canary subtracted)' : ''} minus theirs${snap.canary_subtracted ? ' (unadjusted)' : ''} ${sgn(diffFs, 2)} points`
    : '- Flagsmith: no inference for the primary metric');
  if (snap.guardrail && snap.guardrail.flagsmith) {
    const g = snap.guardrail.flagsmith;
    lines.push(`  Flagsmith ${snap.guardrail.name}: chance_to_win ${g.chance_to_win.toFixed(4)}, lift ${sgn(g.lift * 100)}%`);
  }
  lines.push('');
  lines.push('Gates:');
  gates.forEach((g, i) => lines.push(`${i + 1}. ${g.name}: ${g.pass ? 'pass' : 'FAIL'} (${g.detail})`));
  lines.push('');
  lines.push(`Branch ${decision.branch}: ${decision.text}`);
  return lines.join('\n');
}

export function buildJson(r) {
  const { snap, p, mc, guardrail: gr, visitors, gates, decision, diffFs } = r;
  const rnd = (x, d = 5) => (x == null ? x : Number(x.toFixed(d)));
  return {
    environment: snap.environment,
    experiment_id: snap.experiment_id,
    as_of: snap.as_of,
    is_final: snap.is_final,
    canary_subtracted: snap.canary_subtracted,
    prior: 'Beta(1,1)',
    variant_key: snap.variant_key,
    primary: {
      metric: snap.primary.name,
      control: snap.primary.control,
      variant: snap.primary.variant,
      p_variant_beats_control: rnd(p),
      relative_lift: { median: rnd(mc.relative_lift.median), low: rnd(mc.relative_lift.low), high: rnd(mc.relative_lift.high) },
      absolute_diff_points: { median: rnd(mc.absolute_diff_points.median, 3), low: rnd(mc.absolute_diff_points.low, 3), high: rnd(mc.absolute_diff_points.high, 3) },
      expected_loss_points: { choose_variant: rnd(mc.expected_loss_points.choose_variant, 4), choose_control: rnd(mc.expected_loss_points.choose_control, 4) },
      p_monte_carlo: rnd(mc.p_mc),
      seed: mc.seed,
      draws: mc.draws,
      flagsmith: snap.primary.flagsmith,
      p_minus_flagsmith_points: rnd(diffFs, 3),
      p_minus_flagsmith_basis: snap.canary_subtracted ? 'ours with the canary subtracted vs Flagsmith unadjusted' : 'same counts',
    },
    guardrail: snap.guardrail
      ? { metric: snap.guardrail.name, control: snap.guardrail.control, variant: snap.guardrail.variant, verdict: gr.verdict, p_harm: rnd(gr.p_harm), flagsmith: snap.guardrail.flagsmith }
      : null,
    visitors_needed: visitors,
    exposures: snap.exposures,
    gates: gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail })),
    branch: decision.branch,
    decision: decision.text,
  };
}

// ---------- Flagsmith Admin API fetch ----------

export function makeRedactor(secrets) {
  const list = secrets.filter((s) => s && s.length >= 4);
  return (text) => {
    let out = String(text);
    for (const s of list) out = out.split(s).join('<key>');
    return out;
  };
}

function guardProduction(env, now) {
  if (env === 'production' && now().getTime() < Date.parse(PRODUCTION_CUTOFF)) {
    fail(`Refusing to read Production before ${PRODUCTION_CUTOFF} (Sat 28 Nov 2026 23:06 EST, the registered final snapshot). The win probability must not be read earlier.`);
  }
}

const asList = (x) => (Array.isArray(x) ? x : (x && x.results) || []);

export async function fetchSnapshot({
  env, experimentId, project, refresh = false, apiKey,
  fetchImpl = globalThis.fetch, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  if (env !== 'development' && env !== 'production') fail('--env must be development or production');
  guardProduction(env, now);
  if (!apiKey) fail('FLAGSMITH_API_KEY is not set');
  let redact = makeRedactor([apiKey]);

  const call = async (method, path, label) => {
    let res;
    try {
      res = await fetchImpl(API_BASE + path, { method, headers: { Authorization: `Api-Key ${apiKey}`, Accept: 'application/json' } });
    } catch (e) {
      fail(redact(`${method} ${label} failed: ${e && e.message}`));
    }
    return res;
  };
  const getJson = async (path, label) => {
    const res = await call('GET', path, label);
    if (!res.ok) fail(redact(`GET ${label} returned HTTP ${res.status}`));
    return res.json();
  };

  let projectId = project;
  if (projectId == null) {
    const projects = asList(await getJson('projects/', 'projects/'));
    if (projects.length !== 1) fail(`found ${projects.length} projects; pass --project <id>`);
    projectId = projects[0].id;
  }
  const envs = asList(await getJson(`environments/?project=${encodeURIComponent(projectId)}`, 'environments/'));
  const wanted = env === 'production' ? 'Production' : 'Development';
  const envObj = envs.find((e) => e.name === wanted);
  if (!envObj) fail(`no environment named ${wanted} in project ${projectId}`);
  const envKey = envObj.api_key;
  redact = makeRedactor([apiKey, envKey]);

  const base = `environments/${envKey}/experiments/${encodeURIComponent(experimentId)}/`;
  const lbl = `environments/<key>/experiments/${experimentId}/`;
  const detail = await getJson(base, lbl);
  const getResults = async () => { const r = await getJson(`${base}results/`, `${lbl}results/`); return r.results || r; };
  let results = await getResults();

  if (refresh) {
    const asOf = Date.parse(results.as_of);
    const age = now().getTime() - asOf;
    if (Number.isFinite(asOf) && age < REFRESH_MIN_AGE_MS) {
      log(`Refresh skipped: results are only ${Math.round(age / 1000)} s old (limit: one refresh per 5 minutes).`);
    } else {
      const res = await call('POST', `${base}results/refresh/`, `${lbl}results/refresh/`);
      if (res.status === 429) {
        log('Refresh rate-limited (HTTP 429): using the existing results.');
      } else if (!res.ok) {
        fail(`POST ${lbl}results/refresh/ returned HTTP ${res.status}`);
      } else {
        log('Refresh requested; waiting for new results.');
        const before = results.as_of;
        let waited = 0;
        while (waited < POLL_CAP_MS) {
          await sleep(POLL_EVERY_MS);
          waited += POLL_EVERY_MS;
          results = await getResults();
          if (results.as_of !== before) break;
        }
        if (results.as_of === before) log('Results did not update within about 90 s; using the latest available.');
      }
    }
  }

  const options = (detail.feature && detail.feature.multivariate_options) || [];
  const rollout = detail.experiment_rollout && detail.experiment_rollout.feature_state_value;
  return {
    source: `Flagsmith Admin API, ${lbl}results/`,
    environment: { id: envObj.id, name: envObj.name },
    experiment: {
      id: detail.id,
      name: detail.name,
      flag: detail.feature && detail.feature.name,
      status: detail.status,
      started_at: detail.started_at,
      control_value: rollout ? rollout.value : null,
      variants: options.map((o) => ({
        id: o.id,
        key: o.key ?? o.string_value,
        value: o.string_value ?? o.integer_value ?? o.boolean_value,
      })),
      metrics: (detail.metrics || []).map((m) => ({
        metric: m.metric,
        metric_name: m.metric_name,
        expected_direction: m.expected_direction,
        aggregation: m.aggregation,
      })),
    },
    fetched_at: now().toISOString(),
    results,
  };
}
