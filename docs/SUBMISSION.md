# Submission map: Toggle Wars (WeMakeDevs x Flagsmith)

The field list below is the real form at https://www.wemakedevs.org/hackathons/flagsmith/submit, pasted by the owner on Fri 27 Nov 2026 (about 23:30 EST). Every field has a source or an owner. The draft answers further down were written by Claude (Codex was out of usage); the owner edits them into their own voice and fills the Phase D brackets.

Deadline: Sun 29 Nov 2026, 09:30 EST (8:00 PM IST). Our target: Sun 08:00 EST. Submitting is gate G7: the owner clicks Submit and saves the confirmation. The form can be edited until the deadline.

## Fields

| # | Field (form wording) | Required | Source | Owner | Ready? |
|---|---|---|---|---|---|
| 1 | Project title | yes | README.md title | owner confirms | yes |
| 2 | Which tracks are you entering? | yes | Track 1, Test Something Real, only. The form allows several, but the hackathon rules (plan section 1, checked 2026-11-26) say one track per team. | owner | yes |
| 3 | Demo video (under 3 minutes, YouTube or Loom, public or unlisted; "Show the problem, what you built, and how Flagsmith fits in") | yes | docs/VIDEO_SCRIPT.md, recorded on the Development preview. Must be under 3:00 and open logged out. | owner records and uploads | Phase D |
| 4 | GitHub repository (public, README with setup steps and how you used Flagsmith) | yes | https://github.com/ovevayrus/readsharp-tell-vs-feel (MIT) | owner pushes the final state (gate G6) | yes, Results filled in Phase D |
| 5 | Live demo or deployment | no | https://readsharp.app/reading-speed-test (the live page under test) | owner | yes |
| 6 | What did you build, and what problem does it solve? ("Who would use it, and how does it work?") | yes | Draft A below; README summary, The problem, The hypothesis | owner edits | draft ready |
| 7 | Which parts of Flagsmith did you use? | yes | Draft B below; README "How Flagsmith is used" | owner edits | draft ready |
| 8 | [Track 1] Walk us through your experiment (hypothesis, variants, split, metric and events, what the results showed) | optional, answer it | Draft C below; EXPERIMENT.md; results from docs/results/analysis.md | owner edits; Phase D fills results | Phase D |
| 9 | [Track 1] Experiment results: screenshots of results in Flagsmith (JPG/PNG/WebP/GIF/AVIF, 5 MB each, up to 3) | optional, answer it | 1. Production "Tell vs Feel" (1512) results page at the final snapshot (Phase D, after 23:06 EST Sat). 2. The A/A check (965) page, already taken (results as of 00:20 UTC Sat). 3. The Planted effect check (1514) page, completed with b. | owner takes them | 2 done; 1 and 3 to take |
| 10 | [Track 2] How does your agent work with Flagsmith? | no | not entered | n/a | skip |
| 11 | [Track 3] How did you build on self-hosted Flagsmith? | no | not entered | n/a | skip |
| 12 | [Track 4] What does your skill do? | no | not entered | n/a | skip |
| 13 | [Track 4] Token count for your demo run | no | not entered | n/a | skip |
| 14 | What did you like about Flagsmith, and what would you improve? | yes | Draft D below; .omc/progress.txt (A1, A2, C logs) | owner edits (it is their feedback) | draft ready |

The form counts 7 required answers: fields 1, 2, 3, 4, 6, 7 and 14.

## Draft A: What did you build, and what problem does it solve?

ReadSharp is a paid speed reader for Windows with no free trial. Its free reading speed test is where a curious visitor decides whether the app is for them, and before this test the result only told them a practice pace as a number. I ran a real, pre-registered A/B test on that page with Flagsmith. In `tell` (control) the visitor gets the number. In `feel` they also read the rest of the passage they just finished, one word at a time, at that pace. The question is whether feeling the pace gets more people to click Get ReadSharp, without fewer of them sharing their result.

Visitors who take the test see one of the two versions, decided by one multivariate flag; the same flag ships the winner when the experiment ends. The repo is a kit other teams can reuse: setup as code for the flag, metrics and experiment, a privacy-gated browser module, scripted A/A and planted-effect validation runs, and an analysis script that applies the registered decision rule.

## Draft B: Which parts of Flagsmith did you use?

- A multivariate flag (`speed_test_next_step`: control `tell`, variation `feel` at weight 0 outside the experiment) in a Development and a Production environment, with v2 feature versioning.
- Experimentation: an experiment at 100% rollout and 50/50, a primary metric (`get_readsharp`, occurrence, increase), a guardrail (`result_shared`, should not decrease) and an informational metric, all on the managed warehouse.
- The JavaScript SDK in the browser: transient identities, `getExperimentFlag` at the moment the result renders (the exposure), `trackEvent` for conversions, and an immediate flush.
- The Node SDK for scripted validation traffic and for checking which value a flag serves.
- Flagsmith CLI v2 (`flagsmith init`, `feature`, `api`) to create everything idempotently, start the experiment only after the pre-registration was pushed, and read counts while it runs.
- The results API and dashboard: Bayesian chance to win, credible intervals and the sample-ratio check, read by our own analysis script too.
- Ending an experiment with a rollout decision, so the flag that ran the test serves the winner with no redeploy (shown on the planted-effect run in Development).

## Draft C: [Track 1] Walk us through your experiment

Hypothesis: letting visitors feel their practice pace on the passage they just read, in the real reader, will get more of them to click Get ReadSharp than telling them the pace, without lowering successful shares.

Variants and split: `tell` (control) and `feel` behind `speed_test_next_step`, 100% of eligible result page views, 50/50, with a random per-view identity held in memory. Visitors with GPC on, `?optout`, or a European, UTC or unknown time zone are excluded and send nothing.

Metric and events: the primary metric is `get_readsharp`, a click on a button that is identical in both arms. The guardrail is `result_shared` (successful shares only). `installer_download` is informational. The exposure is recorded with `getExperimentFlag` at the render moment and flushed at once, and events are sent only after an exposure. EXPERIMENT.md was pushed as REGISTERED (with the decision rule) before the Production experiment existed.

Power, stated up front: at 300 per arm an observed +4.3 points is needed to reach 95%, so only very large effects are detectable.

Validation (Development, scripted, never results): an A/A run gave 45/500 against 52/500, P 0.23, interval −5.1 to +2.3 points, so keep running. A planted +5-point run gave 78/502 against 43/498, P 0.9996, interval +2.9 to +10.9 points, so ship, and ending that experiment rolled the winner out with no redeploy.

Results (Phase D): [interval first, then P, guardrail, validity gates, the branch of the rule that fired, and the visitors still needed per arm, from docs/results/analysis.md].

## Draft D: What did you like about Flagsmith, and what would you improve?

Liked:
- The CLI and the API covered everything, so the whole setup is a script that a second run leaves unchanged.
- Ending an experiment with a rollout decision means the flag that ran the test also ships the winner.
- Transient identities fit a privacy-first test, and results in Development showed up within minutes.
- Bayesian results with a credible interval and a sample-ratio check are the right defaults.

Would improve:
- A created but not started experiment already serves the split without recording exposures. Our Production experiment had a 26-second gap between creation and start. Create should not serve until start, or create-and-start should be one call.
- `srm_p_value` came back null even at 1,000 identities in Development, so we added our own check.
- On two identical arms, the dashboard said "Control is the winner" at 79% and suggested rolling it out. The docs say the banner appears at 95% ("When a variation reaches a 95% chance of beating control, a recommendation banner suggests rolling it out", docs.flagsmith.com/experimentation/analyse-an-experiment, read 28 Nov 2026).
- The browser SDK uses localStorage by default and flushes events every 10 seconds. A privacy-first site needs an in-memory adapter and an immediate flush; documented defaults for that case would help.
- Results are aggregate only, so a single launch check (our canary) can't be looked up by identity.
- The CLI prints the request path, which holds the environment key, when a call fails (for example a 429 on an early refresh).
- No stated retention period for transient identities and experiment events.
