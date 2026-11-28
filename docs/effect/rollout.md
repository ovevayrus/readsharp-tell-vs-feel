# Round 4 rollout on the planted-effect run (VALIDATION, Development)

**Validation only, never a result.** This shows the last step of the experiment loop in Flagsmith: the flag that ran the experiment also ships the winner, with no redeploy.

1. The analysis of experiment 1514 (docs/effect/analysis.md) fired branch 2: P(b beats control) = 0.9996 and the guardrail `result_shared` not harmed, so ship `b`.
2. Before ending it, the Flagsmith Node SDK served the 50/50 split: 9 `a` and 11 `b` across 20 fresh identities (`node scripts/served-value.mjs --flag effect_check --n 20`).
3. `node scripts/complete-experiment.mjs --flag effect_check --rollout b --yes` ended it at 2026-11-28 00:34:24Z. The script calls `POST environments/<key>/experiments/1514/complete/` with `{ "rollout_decision": "variant", "rollout_variant": 38406 }` and reads the experiment back: status `completed`, rollout decision `variant`, variant 38406 (`b`). Ending is final: the results are frozen and the flag is unlocked.
4. Straight after, the SDK served `b` to 20 of 20 fresh identities. Flagsmith applies the decision as `b` at 100% of identities over the base value `a`, so a request with no identity still reads `a`; the browser SDK always identifies (with a transient random ID), so every visitor gets `b`.
5. `node scripts/setup-flagsmith.mjs --env development --dry-run` then reported "nothing to create": the setup script leaves a completed experiment's rollout alone.

Production was not touched: experiment 1512 was still running at 100%, 50/50, with control `tell`, and it is the only Production experiment. Flags are project-wide in Flagsmith, so `effect_check` also exists in Production, disabled.
