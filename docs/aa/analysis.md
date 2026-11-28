# A/A readout (VALIDATION, Development)

**Validation only, never a result.** Experiment 965 "A/A check" on the flag `aa_check`, Development environment, 1,000 scripted identities (docs/aa/run-20261127T062244Z.json). Snapshot: docs/aa/results.json, one results refresh as of 2026-11-28 00:20:35Z.

## What the noise looks like

Both arms were treated the same: every scripted visitor converted on `get_readsharp` with a 10% chance and shared with a 5% chance, whichever arm it landed in. Even so, `b` came out 1.4 points lower than control (9.0% against 10.4%), and the analysis gives `b` a 23% chance of being the better arm. That gap is noise. With 500 visitors per arm, two identical arms routinely land a few points apart. The 95% interval for the difference runs from −5.1 to +2.3 points and includes zero, so the rule says keep running, and it would keep saying so for a long time: no realistic amount of traffic tells two identical arms apart (visitors needed: more than 20,000 per arm). This is what the Tell vs Feel readout would look like if `feel` made no difference.

## Our P and Flagsmith's

Our P(b beats control) is 0.2284; Flagsmith's chance to win is 0.2110, 1.74 points apart (within the 2-point check). Both use the same counts. The difference is in the model: Flagsmith's interval for the lift (−46.3% to +19.4%) is symmetric around the observed lift of −13.5%, which points to a normal approximation, while ours comes straight from the Beta(1+c, 1+n−c) posteriors with a uniform Beta(1,1) prior, whose ratio is skewed (−40.7% to +26.2%).

## Script output

`node analysis/results.mjs --file docs/aa/results.json`

**VALIDATION (Development, experiment 965 "A/A check", as of 2026-11-28T00:20:35.622168Z)**

Primary get_readsharp: control 52/500 (10.4%), b 45/500 (9.0%). Prior Beta(1,1) uniform.
- Interval (95%): relative lift -13.3% (-40.7% to +26.2%); difference -1.39 points (-5.09 to +2.29)
- P(b beats control) = 0.2284 (exact)
- Guardrail result_shared: control 29/500, b 30/500: not harmed (P(at least 1 point lower) = 0.212)
- Expected loss (context only): choose b 1.644 points, choose control 0.249 points
- Visitors needed: more than 20,000 per arm (cap hit)
- Flagsmith: chance_to_win 0.2110, lift -13.5% (-46.3% to +19.4%); ours minus theirs +1.74 points
  Flagsmith result_shared: chance_to_win 0.5524, lift +3.4%

Gates:
1. SRM: pass (not computed by Flagsmith)
2. Sample: pass (exposures 500/500, conversions 52/45)
3. Wiring: pass (n/a (validation run))
4. Canary: pass (n/a (validation run))

Branch 5: Keep running.

```json
{
  "environment": "Development",
  "experiment_id": 965,
  "as_of": "2026-11-28T00:20:35.622168Z",
  "is_final": false,
  "canary_subtracted": null,
  "prior": "Beta(1,1)",
  "variant_key": "b",
  "primary": {
    "metric": "get_readsharp",
    "control": {
      "c": 52,
      "n": 500
    },
    "variant": {
      "c": 45,
      "n": 500
    },
    "p_variant_beats_control": 0.22837,
    "relative_lift": {
      "median": -0.13275,
      "low": -0.40695,
      "high": 0.26248
    },
    "absolute_diff_points": {
      "median": -1.392,
      "low": -5.088,
      "high": 2.285
    },
    "expected_loss_points": {
      "choose_variant": 1.6441,
      "choose_control": 0.2493
    },
    "p_monte_carlo": 0.22889,
    "seed": 20261128,
    "draws": 200000,
    "flagsmith": {
      "chance_to_win": 0.21099164424824374,
      "lift": -0.1346153846153846,
      "ci_low": -0.4631909366760588,
      "ci_high": 0.19396016744528957
    },
    "p_minus_flagsmith_points": 1.738
  },
  "guardrail": {
    "metric": "result_shared",
    "control": {
      "c": 29,
      "n": 500
    },
    "variant": {
      "c": 30,
      "n": 500
    },
    "verdict": "not harmed",
    "p_harm": 0.21196,
    "flagsmith": {
      "chance_to_win": 0.5524363792024397,
      "lift": 0.034482758620689564,
      "ci_low": -0.47822652303415175,
      "ci_high": 0.5471920402755309
    }
  },
  "visitors_needed": {
    "status": "cap_hit",
    "cap": 20000,
    "power_at_cap": 0.157
  },
  "exposures": {
    "control": 500,
    "variant": 500
  },
  "gates": [
    {
      "name": "SRM",
      "pass": true,
      "detail": "not computed by Flagsmith"
    },
    {
      "name": "Sample",
      "pass": true,
      "detail": "exposures 500/500, conversions 52/45"
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
  "branch": 5,
  "decision": "Keep running."
}
```
