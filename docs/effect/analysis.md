# Planted-effect readout (VALIDATION, Development)

**Validation only, never a result.** Experiment 1514 "Planted effect check" on the flag `effect_check`, Development environment, 1,000 scripted identities: `node sim/run.mjs --flag effect_check --p-control 0.10 --p-variant 0.15 --n 1000 --seed 20261128` (docs/effect/run-20261128T003315Z.json: control 498, b 502, 0 errors). Snapshot: docs/effect/results.json, one results refresh as of 2026-11-28 00:33:57Z.

## What a real effect looks like

Here the arms were different on purpose: scripted visitors in `b` converted with a 15% chance and those in control with 10%, a planted +5-point effect. Flagsmith counted 78/502 (15.5%) against 43/498 (8.6%), a difference of +6.9 points; noise added about 2 points on top of the planted 5. P(b beats control) is 99.96%, and the 95% interval for the difference, +2.9 to +10.9 points, sits clear of zero. The guardrail `result_shared` was planted equal (5% in both) and came out 18 against 18: not harmed. Branch 2 of the rule fires: ship `b`. Set next to the A/A readout (docs/aa/analysis.md), this is the contrast between noise and a real effect at 500 visitors per arm.

## Our P and Flagsmith's

Our P is 0.9996; Flagsmith's chance to win is 0.9934, 0.62 points apart. Flagsmith's lift interval (+16.7% to +143.2%) is symmetric around the observed +79.9%, a normal approximation; ours (+26.9% to +155.4%) comes from the Beta(1+c, 1+n−c) posteriors with a uniform prior.

## Round 4 rollout

The experiment was then ended through the API with `b` as the winner (docs/effect/rollout.md, evidence in docs/effect/rollout-evidence.json).

## Script output

`node analysis/results.mjs --file docs/effect/results.json`

**VALIDATION (Development, experiment 1514 "Planted effect check", as of 2026-11-28T00:33:57.485778Z)**

Primary get_readsharp: control 43/498 (8.6%), b 78/502 (15.5%). Prior Beta(1,1) uniform.
- Interval (95%): relative lift +78.7% (+26.9% to +155.4%); difference +6.87 points (+2.87 to +10.94)
- P(b beats control) = 0.9996 (exact)
- Guardrail result_shared: control 18/498, b 18/502: not harmed (P(at least 1 point lower) = 0.207)
- Expected loss (context only): choose b 0.000 points, choose control 6.876 points
- Visitors needed: none more needed (P is already at least 95%)
- Flagsmith: chance_to_win 0.9934, lift +79.9% (+16.7% to +143.2%); ours minus theirs +0.62 points
  Flagsmith result_shared: chance_to_win 0.4902, lift -0.8%

Gates:
1. SRM: pass (Flagsmith returned null; chi-square on exposures here p = 0.899)
2. Sample: pass (exposures 498/502, conversions 43/78)
3. Wiring: pass (n/a (validation run))
4. Canary: pass (n/a (validation run))

Branch 2: Ship the variant.

```json
{
  "environment": "Development",
  "experiment_id": 1514,
  "as_of": "2026-11-28T00:33:57.485778Z",
  "is_final": false,
  "canary_subtracted": null,
  "prior": "Beta(1,1)",
  "variant_key": "b",
  "primary": {
    "metric": "get_readsharp",
    "control": {
      "c": 43,
      "n": 498
    },
    "variant": {
      "c": 78,
      "n": 502
    },
    "p_variant_beats_control": 0.9996,
    "relative_lift": {
      "median": 0.78725,
      "low": 0.26885,
      "high": 1.55355
    },
    "absolute_diff_points": {
      "median": 6.872,
      "low": 2.865,
      "high": 10.941
    },
    "expected_loss_points": {
      "choose_variant": 0.0002,
      "choose_control": 6.8762
    },
    "p_monte_carlo": 0.99953,
    "seed": 20261128,
    "draws": 200000,
    "flagsmith": {
      "chance_to_win": 0.9933979598424881,
      "lift": 0.7994996757157415,
      "ci_low": 0.16719404854418618,
      "ci_high": 1.4318053028872968
    },
    "p_minus_flagsmith_points": 0.62,
    "p_minus_flagsmith_basis": "same counts"
  },
  "guardrail": {
    "metric": "result_shared",
    "control": {
      "c": 18,
      "n": 498
    },
    "variant": {
      "c": 18,
      "n": 502
    },
    "verdict": "not harmed",
    "p_harm": 0.20697,
    "flagsmith": {
      "chance_to_win": 0.4902198540145956,
      "lift": -0.007968127490039719,
      "ci_low": -0.6449478175586321,
      "ci_high": 0.6290115625785526
    }
  },
  "visitors_needed": {
    "status": "none_needed",
    "per_arm_total": 502,
    "extra_per_arm": 0
  },
  "exposures": {
    "control": 498,
    "variant": 502
  },
  "gates": [
    {
      "name": "SRM",
      "pass": true,
      "detail": "Flagsmith returned null; chi-square on exposures here p = 0.899"
    },
    {
      "name": "Sample",
      "pass": true,
      "detail": "exposures 498/502, conversions 43/78"
    },
    {
      "name": "Wiring",
      "pass": true,
      "detail": "n/a (validation run)"
    },
    {
      "name": "Canary",
      "pass": true,
      "detail": "n/a (validation run)"
    }
  ],
  "branch": 2,
  "decision": "Ship the variant."
}
```
