# Demo video script: ReadSharp "Tell vs Feel" (Toggle Wars, Track 01)

Spoken words: 421 (all blockquote lines, including the Phase D fill-in lines and the ship alternative). At 150 words per minute that is about 2:48. Target length 2:45. The "keep running" path (the likely one) uses fewer words than the total, since the ship alternative is only read if Production says ship.

How to use this: read only the lines that start with ">". Everything else is a note to you. Bracketed text is a fill-in for Phase D, once docs/results/analysis.md exists.

---

## Script, row by row

### 0:00-0:12 Test result, both arms side by side

Shot: the live result page on the Development preview, `tell` and `feel` in two windows. The product (the ReadSharp speed test) is on screen from the first second.

> Same result, two next steps: tell the reader their pace, or let them feel it on the passage they were just reading.

### 0:12-0:27 readsharp.app and the paywall line

Shot: readsharp.app, then scroll to the line that says there is no free trial.

> A paid speed reader, no free trial. The test is where curious visitors decide.

### 0:27-0:45 EXPERIMENT.md and its GitHub timestamp

Shot: EXPERIMENT.md on GitHub, then the commit time. Point at the hypothesis, the metric, the guardrail, the decision rule, then the power row.

> Before launch I wrote down the hypothesis, the metric, the guardrail and the decision rule. The commit was pushed at 22:08 UTC. The experiment was created at 22:12. Honest power: at 300 per arm, I need an observed gain of 4.3 points to reach 95 percent. Only very large effects are detectable.

### 0:45-1:15 Flagsmith flag, metrics, experiment, render snippet, DevTools

Shot: the flag `speed_test_next_step`, then the metrics and the experiment page, then `web/experiment.js` at the `getExperimentFlag` line, then DevTools on the Development preview. Take the identifier from the live page. Point at it with the cursor each time.

> One flag, two values: tell is the control, feel is the variant. The primary metric is get_readsharp. The guardrail is result_shared. At render, the page calls getExperimentFlag, then flushEvents. This ID is on the flag exposure event. And here is the same ID on the get_readsharp event. Back on the experiment page, the exposure count goes up.

### 1:15-1:25 Network panel with GPC on

Shot: DevTools Network, filter "flagsmith", GPC on, press Start. The list stays empty.

> Nothing is sent until you start, nothing is stored, and GPC is respected.

### 1:25-1:35 Noise next to planted effect

Shot: docs/aa/analysis.md and docs/effect/analysis.md side by side. Caption on screen: "A/A: 45/500 vs 52/500, P 0.23" and "Planted +5: 43/498 vs 78/502, P 0.9996".

> Here's what noise looks like, and here's what a real +5-point effect looks like, at about 500 per arm. Both are Development validation runs. Noise: P is 0.23. Real effect: P is 99.96 percent.

### 1:35-2:15 Production results and analysis.md (30 s on the interval)

Shot: docs/results/analysis.md, interval line highlighted, then the A/A interval for comparison.

Version A, keep running (the likely outcome at low traffic). **Phase D: fill in from docs/results/analysis.md.**

> A credible interval is the range where the true difference most likely sits. If it crosses zero, we can't say whether feel helps or hurts. My A/A interval ran from minus 5.1 to plus 2.3 points: it crosses zero. The planted effect ran from plus 2.9 to plus 10.9: clear of zero. In Production, with [exposures per arm] per arm, it is [low] to [high] points. It crosses zero, so the rule says keep running. P that feel beats tell is [P]. The guardrail is [not harmed / inconclusive]. To close it, we still need [visitors still needed] visitors per arm.

Version B, ship feel (use only if Production says ship). **Phase D.** Replace everything after "In Production" with:

> In Production, the interval is [low] to [high], clear of zero. P is [P], above 95 percent, and the guardrail is not harmed. The rule says ship feel.

### 2:15-2:40 The rule applied

Shot, keep running: terminal or file view of docs/effect/rollout.md, then the Flagsmith experiment 1514 page showing it completed with `b`. On the planted-effect run the rule fired ship.

Shot, ship feel: in the Flagsmith dashboard, End Experiment on Tell vs Feel and choose `feel` (gate G5, Phase D), then show it served.

Keep running:

> On the planted-effect run, the rule said ship. I ended experiment 1514 with b as the winner. Before, the SDK served 9 a and 11 b. After, it served b to 20 of 20 fresh identities. No redeploy. The flag is both the experiment and the rollout.

Ship feel (replaces the above):

> The rule says ship, so I end the experiment and set feel for everyone. No redeploy. The flag is both the experiment and the rollout.

### 2:40-2:55 Repo

Shot: the GitHub repo root, README top, then the `scripts` folder.

> The repo is a kit anyone can reuse: setup script, analysis script and the pre-registration. Next is a first-party proxy, so Flagsmith no longer sees visitors' IP addresses.

---

## Shot list

| Time | On screen | What to click |
|---|---|---|
| 0:00-0:12 | Development preview result page, two windows (tell, feel) | Take the test in each window. Reload until each arm appears. |
| 0:12-0:27 | readsharp.app home, paywall line | Scroll to the no-free-trial line. |
| 0:27-0:45 | EXPERIMENT.md on GitHub, commit time | Open the file, hover the commit time, scroll to the Design table power row. |
| 0:45-1:15 | Flagsmith flag, metrics, experiment page | Open the flag, then Experiments, then metrics. |
| 0:45-1:15 | web/experiment.js | Jump to `getExperimentFlag` and `flushEvents`. |
| 0:45-1:15 | Development preview, DevTools Network filtered "flagsmith" | Press Start reading, read, press Done reading, answer, press Check my answers. Click the `$flag_exposure` request, point at the ID. Click Get ReadSharp. Click the `get_readsharp` request, point at the same ID. Switch to the experiment page, refresh, show the exposure count up. |
| 1:15-1:25 | DevTools Network, GPC on | Reload with GPC on, press Start. Show the empty list. |
| 1:25-1:35 | docs/aa/analysis.md and docs/effect/analysis.md | Tile side by side. Highlight the two interval lines. |
| 1:35-2:15 | docs/results/analysis.md (Phase D) | Highlight the interval, then P, guardrail, visitors needed. |
| 2:15-2:40 | docs/effect/rollout.md and experiment 1514 (keep running); live flag flip (ship) | Show the completed status and rollout decision `b`; or End Experiment with `feel` in the dashboard (gate G5). |
| 2:40-2:55 | GitHub repo | Show README, scripts folder. |

## Recording checklist

- [ ] Film both arms on the Development PREVIEW (https://flagsmith-dev-preview.readfast-site.pages.dev). Production with `?optout` always shows tell, so it cannot show `feel`.
- [ ] Product on screen in the first 10 seconds (the speed test result page, then readsharp.app).
- [ ] 1080p recording.
- [ ] Browser zoom 125%.
- [ ] DevTools open, Network tab filtered to "flagsmith".
- [ ] GPC demo ready: Network panel with GPC on, press Start, nothing sent.
- [ ] Tabs open: the Flagsmith experiment page, docs/aa/analysis.md, docs/effect/analysis.md, docs/effect/rollout.md, docs/results/analysis.md (Phase D), EXPERIMENT.md on GitHub with its commit time visible.
- [ ] The identifier is generated live. Do a dry run first so you know where `$flag_exposure` and `get_readsharp` appear in the Network list.
- [ ] Phase D done: bracketed fill-ins replaced, and Version A or B chosen.
- [ ] Time the read-aloud and the final cut. Aim for 2:30 to 2:55, target 2:45: the submission form requires under 3 minutes.
- [ ] Upload to YouTube or Loom, public or unlisted (the form's options). The link must open logged out: test it in a private window before submitting.

## Changes from plan section 11

1. 1:25-1:35: "at 1,000 per arm" became "at about 500 per arm". Each validation run had 1,000 identities in total (A/A: 500 and 500; planted effect: 498 and 502).
2. 0:27-0:45: the plan has no quote, so I wrote narration from EXPERIMENT.md and docs/RUNBOOK.md: the commit pushed at 22:08:43Z, the experiment created at 22:12:00Z, and the power line (at 300 per arm, an observed 4.3 points needed; the "to reach 95 percent" tail was cut for length).
3. 0:45-1:15: the plan has no quote, so I wrote narration for the flag, metrics, the render snippet and the one-identifier walk-through.
4. 1:25-1:35: added a spoken line, "Both are Development validation runs", so the numbers are not mistaken for results, plus the two P values (0.23 and 99.96 percent). The plan quote itself is unchanged apart from the number fix.
5. 1:35-2:15: the plan has no quote, so I wrote narration with Phase D fill-ins, one version for keep running and one for ship.
6. 2:15-2:40: the plan quote "The flag is both the experiment and the rollout." is kept word for word, moved to the end of the narration. Added narration from docs/effect/rollout.md and a shorter ship alternative.
7. 2:40-2:55: the plan has no quote, so I wrote narration from the plan row and the Transport row in EXPERIMENT.md (direct to Flagsmith, so Flagsmith receives the IP; the first-party proxy is the next step).
8. 0:00-0:12 and 0:12-0:27: quotes used word for word, with the italic markers dropped.
9. 1:15-1:25: quote used word for word.
10. Fact fixes after review: the power line keeps "to reach 95 percent"; the live site's buttons are Start reading, Done reading and Check my answers (Show my result is the demo's); shipping feel in Production means ending the experiment with feel (gate G5), not flipping a flag; the proxy line says Flagsmith would no longer see visitors' IP addresses.
