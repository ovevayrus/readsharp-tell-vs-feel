#!/usr/bin/env node
// CLI for the Tell vs Feel Bayesian analysis. See analysis/README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  analyze, buildReport, buildJson, fetchSnapshot, makeRedactor, stripBom, DEFAULT_SEED, MIN_DRAWS,
} from './lib.mjs';

const OPTIONS = {
  file: { type: 'string' },
  env: { type: 'string' },
  experiment: { type: 'string' },
  project: { type: 'string' },
  refresh: { type: 'boolean', default: false },
  save: { type: 'string' },
  primary: { type: 'string' },
  guardrail: { type: 'string' },
  wiring: { type: 'string' },
  canary: { type: 'string' },
  'subtract-canary': { type: 'string' },
  seed: { type: 'string' },
  draws: { type: 'string' },
  sims: { type: 'string' },
};

function intOpt(name, value, dflt) {
  if (value == null) return dflt;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number`);
  return Number(value);
}

export async function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const envVars = io.env || process.env;
  const apiKey = envVars.FLAGSMITH_API_KEY;
  let redact = makeRedactor([apiKey]);
  try {
    const { values: v } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
    const opts = {
      env: v.env,
      primary: v.primary,
      guardrail: v.guardrail,
      wiring: v.wiring,
      canary: v.canary,
      subtractCanary: v['subtract-canary'],
      seed: intOpt('seed', v.seed, DEFAULT_SEED),
      draws: intOpt('draws', v.draws, MIN_DRAWS),
      sims: intOpt('sims', v.sims, 2000),
    };
    if (v.env != null && v.env !== 'development' && v.env !== 'production') {
      throw new Error('--env must be development or production');
    }
    let input;
    if (v.file) {
      input = JSON.parse(stripBom(readFileSync(resolve(v.file), 'utf8')));
    } else {
      if (!v.env || !v.experiment) throw new Error('give either --file <path> or --env <development|production> --experiment <id>');
      input = await fetchSnapshot({
        env: v.env,
        experimentId: v.experiment,
        project: v.project,
        refresh: v.refresh,
        apiKey,
        fetchImpl: io.fetch,
        now: io.now,
        sleep: io.sleep,
        log: (m) => err(`${m}\n`),
      });
      if (v.save) writeFileSync(resolve(v.save), `${JSON.stringify(input, null, 2)}\n`);
    }
    const result = analyze(input, opts);
    out(`${buildReport(result)}\n\n\`\`\`json\n${JSON.stringify(buildJson(result), null, 2)}\n\`\`\`\n`);
    return 0;
  } catch (e) {
    err(`${redact(e && e.message ? e.message : String(e))}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2));
}
