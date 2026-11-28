# Bayesian analysis

Computes P(variant beats control) exactly (Beta(1,1) prior), an interval, expected loss, visitors needed, the EXPERIMENT.md validity gates and the decision branch. Node built-ins only.

- From a saved file: `node analysis/results.mjs --file docs/aa/results.json` (a raw API file also needs `--primary <id> --guardrail <id> --env production`).
- Live: `node analysis/results.mjs --env development --experiment 965 [--refresh] [--save out.json]`.
- Production snapshots need `--wiring pass|fail` and `--canary seen|missing`; Phase D may add `--subtract-canary <armKey>`.
- Keys come from `FLAGSMITH_API_KEY` and are never printed. Fetching Production is refused before 2026-11-29T04:00:00Z (Sat 28 Nov 23:00 EST).
- Tests: `npm test` (offline).
