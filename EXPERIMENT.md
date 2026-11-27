# Tell vs Feel: pre-registration

**Status: DRAFT**

This file becomes **REGISTERED** in a commit pushed before the Production experiment exists. The time of that commit is the evidence that the hypothesis, metrics and decision rule were fixed before any real data arrived. Until then it may change.

- **Product:** [readsharp.app](https://readsharp.app), a paid speed reader for Windows. The experiment runs on its free reading speed test.
- **Flagsmith flag:** `speed_test_next_step` (multivariate). Control value `tell`. Variation value `feel`, key `feel`, weight 0 outside the experiment.
- **Experiment:** 100% of eligible result page views, split 50/50.

## Question

When someone finishes ReadSharp's free reading speed test, does letting them feel their suggested practice pace, by reading the rest of the passage in ReadSharp's reader, get more of them to ask for ReadSharp than telling them that pace?

## Hypothesis

ReadSharp has no free trial, so the speed-test result is when a curious visitor decides whether the product is for them. Continuing the very passage they just read, in the real reader at their own practice pace, will convince more people than a number would. So `feel` will raise `get_readsharp` over `tell`, without lowering `result_shared`.

## Why this test

- The variant isn't copy. It's the product, personalised to the visitor's measured speed and to the text they're already reading, at their most curious moment.
- Nothing like it appears in the published idea lists.
- It answers a real question for a paid product with no trial.

## Design

| Item | Definition |
|---|---|
| Unit | One eligible result page view, identified by a random UUID held in memory. The first eligible result fixes the arm. "Try another passage" keeps it. A reload starts a new view, so the same person can appear more than once. That's a stated limitation. |
| Eligible | A visitor can take part when GPC is off, there's no `?optout`, and the browser time zone is neither on the European list nor UTC, `Etc/*` or unknown. A result page view counts only when, in addition, `practiceMessage()` returns something. Pressing Start as an eligible visitor sends the one request that fetches the flags for the random ID; a result without a practice message then records no exposure and no events. The European list is `Europe/*`, `Atlantic/Reykjavik`, `Atlantic/Canary`, `Atlantic/Madeira`, `Atlantic/Azores`, `Atlantic/Faroe`, `Arctic/Longyearbyen`, `Asia/Nicosia`, `Asia/Famagusta`, `Africa/Ceuta`, `Indian/Reunion`, `Indian/Mayotte`, `America/Cayenne`, `America/Guadeloupe`, `America/Martinique` and `America/Marigot`. Ineligible visitors get `tell`, and **nothing is set up or sent**. |
| Assignment | Flagsmith decides deterministically from the identity: 100% rollout, 50/50 split, fixed for the page view. Outside the experiment the variation weight is 0, so everyone gets `tell` before launch. |
| `tell` (control) | Today's result, the practice-pace sentence, and a shared result card. The card has **Get ReadSharp**, which opens an inline panel: the installer link on Windows, Send to my PC elsewhere. It also has **Share my result**. |
| `feel` (variant) | Everything in `tell`, plus a mini-reader under the sentence and above the card. It plays **the ~50-word continuation of the passage just read** once, at `practicePace(speed, score, total)`, when at least 60% of it is in view. With reduced motion it shows a Play button instead. It ends with "That was N words per minute, X% faster than you just read" (or "at your pace"). |
| Exposure | `getExperimentFlag('speed_test_next_step')` at the render moment, followed by an immediate flush. No events are sent for views that were never exposed. |
| Primary | `get_readsharp`, Occurrence, increase. A click on the **Get ReadSharp** button, which is identical in both arms. |
| Guardrail | `result_shared`, Occurrence, should not decrease. Counts successful shares or copies only. It counts as **harmed** if P(share rate is at least 1 point lower in `feel`) ≥ 90%. Fewer than 5 shares per arm counts as **inconclusive**. |
| Informational | `installer_download` (metric), `send_to_pc` and `feel_read_finished` (events). None of these can decide the result. |
| Effect worth detecting | +5 points (8% → 13%). |
| Honest power (exact Beta(1,1) computation, 8% baseline) | At 300 per arm, **an observed +4.3 points** is needed to reach 95%. Power is **80% only when the true gain is +6.4 points**, and about 55% at 150 per arm. **Only very large effects are detectable.** |
| Validation (Development, labelled as validation, never as results) | An A/A run on `aa_check`. A planted-effect run on `effect_check`, which also demonstrates a rollout change. The browser end-to-end sessions double as the proof that transient identities reach the results. |
| Final snapshot | First results refresh at or after Sat 28 Nov 2026 23:00 EST plus the measured ingestion lag (2 h by default), never later than Sun 29 Nov 01:00 EST. Raw JSON saved. Before then, look only at counts, for health. |

## Decision rule

Binding. It can change only before the Production experiment exists.

1. **Validity gates.** All of these must hold:
   - no sample ratio mismatch (SRM) warning
   - every arm has at least 50 exposures and at least 5 `get_readsharp` conversions
   - the wiring checks pass
   - the canary was seen end to end

   If any gate fails, there is **no decision**. Report why and keep running.
2. If P(`feel` beats `tell`) ≥ 95% and the guardrail isn't harmed: **ship `feel`.** End the experiment and set the flag value to `feel` for everyone.
3. If P ≥ 95% and the guardrail is harmed: **don't ship.** Report the trade-off.
4. If P ≤ 5%: **keep `tell`.** End the experiment, set `tell`, and plan to remove the `feel` code.
5. Otherwise, **keep running.** Report, in this order: the interval, P, the expected loss of each choice (context only), and the visitors still needed per arm.

## Limitations

- The metric is a proxy; paying happens later, in the app.
- The traffic is promoted and includes hackathon participants.
- It runs over a holiday weekend.
- Repeat visitors can appear more than once through reloads.
- Autoplay draws attention (a confound).
- Only large effects are detectable.
- European visitors are excluded.
