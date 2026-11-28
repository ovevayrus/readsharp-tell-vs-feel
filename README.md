# Tell vs Feel: a Flagsmith A/B test on a reading speed test

This repository holds a real experiment on a real product. [ReadSharp](https://readsharp.app) is a paid speed reader for Windows, and its free reading speed test at readsharp.app/reading-speed-test is the page under test. The experiment runs on Flagsmith Experimentation, for the Toggle Wars hackathon, Track 01 (Test Something Real). It was pre-registered, it has a guardrail, and it is running now. Until the final snapshot only its counts are checked, for health; its win probability and interval have not been read.

**Read this first: only very large effects are detectable.** The hoped-for lift is +5 points (8% to 13% of visitors clicking Get ReadSharp). With roughly 300 visitors per arm, an observed gain of +4.3 points is needed to reach 95% probability that the variant wins. Power is 80% only if the true gain is +6.4 points, and about 55% at 150 per arm. A small real effect will most likely end as "keep running". The numbers come from an exact Beta(1,1) computation at an 8% baseline ([EXPERIMENT.md](EXPERIMENT.md)).

## The problem

ReadSharp has no free trial, so the speed test result is the moment a curious visitor decides whether the product is for them. Today that result gives them a practice pace as a number in a sentence. The homepage already plays the reader, but the test result still only tells.

## The hypothesis

Continuing the very passage they just read, in the real reader at their own practice pace, will convince more people than a number would. So `feel` will raise `get_readsharp` over `tell`, without lowering `result_shared`.

The full pre-registration is [EXPERIMENT.md](EXPERIMENT.md): question, design table, decision rule and limitations. It was committed as REGISTERED (`cd7ede6`) and pushed at 22:08:43Z on 27 Nov 2026. The Production experiment was created at 22:12:00Z, so the push came first.

## How Flagsmith is used

**The flag.** `speed_test_next_step` is a multivariate flag. The control value is `tell`. The variation has the value and key `feel`, with weight 0 outside the experiment, so everyone gets `tell` until the experiment starts. The experiment covers 100% of eligible result page views, split 50/50.

**Exposure at render.** The arm is read at the moment the result renders, and the exposure is flushed at once. This is the real code from `decide()` in [web/experiment.js](web/experiment.js):

```js
if (loaded) {
	const flag = client.getExperimentFlag(FLAG);
	arm = flag?.value === ARMS.FEEL ? ARMS.FEEL : ARMS.TELL;
	exposed = flag?.enabled !== false && flag?.experiment?.inExperiment === true;
}
fixed = Object.freeze({ arm, exposed });
onArm?.(arm);
if (exposed) await flush();
```

`getExperimentFlag` records the exposure. The first shown result fixes the arm for the page view. Events are sent only after an exposure, so a view that was never exposed sends nothing. Every event carries the same random identifier as the exposure.

**Events.** All are sent from the browser through the Flagsmith JS SDK, each flushed immediately.

| Event | Fires when |
|---|---|
| `$flag_exposure` | The result renders and the flag is read |
| `get_readsharp` | The visitor clicks Get ReadSharp, a button identical in both arms |
| `result_shared` | A share or copy of the result succeeds. A cancelled share sends nothing |
| `installer_download` | The Windows installer link is followed. A click that leaves the page waits up to 800 ms for its event |
| `send_to_pc` | A Send to my PC request succeeds (the option for visitors who are not on their Windows PC) |
| `feel_read_finished` | The mini-reader in the `feel` arm reaches its end |

**Metrics.** `get_readsharp` is primary (Occurrence, increase). `result_shared` is the guardrail (Occurrence, should not decrease). It counts as harmed if P(share rate at least 1 point lower in `feel`) is 90% or more, and fewer than 5 shares per arm is inconclusive. `installer_download` is informational, as are the `send_to_pc` and `feel_read_finished` events. None of those can decide the result.

**Results.** Flagsmith computes Bayesian results and refreshes them at most every 5 minutes. [analysis/results.mjs](analysis/results.mjs) reads the same numbers from the same API and adds the interval, the guardrail verdict, expected loss, visitors still needed, the validity gates and the decision branch. It prints Flagsmith's own P next to ours. In both validation runs they agree within 2 points.

**Shipping the winner.** The flag that runs the experiment also ships the result. Ending an experiment with [scripts/complete-experiment.mjs](scripts/complete-experiment.mjs) sets what the flag serves next, with no redeploy. That was shown on `effect_check` in Development and is described under Validation.

**Setup as code.** [scripts/setup-flagsmith.mjs](scripts/setup-flagsmith.mjs) drives the Flagsmith CLI v2. It is idempotent: a second run creates nothing. It ensures the flags, their weight-0 variations and the metrics exist, and `--create-experiment` with `--start` creates and starts an experiment. The Production launch needs `--registered <commit>`, and the script refuses unless that commit is on origin/main, its EXPERIMENT.md says REGISTERED, and no later commit changed the file. It creates and starts the experiment back to back, because a created experiment already serves the split without recording exposures. Production experiment 1512 started 26 seconds after creation, and visitors in that gap are missing from the results. [docs/RUNBOOK.md](docs/RUNBOOK.md) has the monitoring commands, the kill switch and the launch canary. The canary showed a measured ingestion lag of 6 minutes.

## Privacy design

Nothing here is legal advice. The claims below are the ones the end-to-end suite in [e2e/experiment.spec.ts](e2e/experiment.spec.ts) checks:

- Nothing is sent to Flagsmith before the visitor presses Start, and the SDK is not even loaded.
- Visitors with Global Privacy Control on, `?optout` in the URL, or a European or UTC time zone are excluded. They get `tell` and send nothing.
- Only the page origin and the two Flagsmith origins (`edge.api.flagsmith.com` and `events.api.flagsmith.com`) are contacted.
- No cookies are set, and the page touches no Storage or IndexedDB. The SDK runs on an in-memory adapter.
- Each eligible view sends exactly one exposure, and every later event uses the same random identifier. The identity is transient: a random UUID held in memory for one page view.
- Every response from Flagsmith is 2xx, and there are no Content Security Policy violations.

The wording on readsharp.app was approved by the owner and is recorded in [docs/G2.md](docs/G2.md). The page tells visitors that, once they press Start and if they are eligible, their browser sends Flagsmith a random ID for that view, the version shown, event names and timestamps. It says plainly that **Flagsmith receives the visitor's IP address**, because the browser calls Flagsmith directly and there is no first-party proxy. Reading speed and answers are never sent. The copy says Flagsmith keeps the data as its privacy policy describes; Flagsmith publishes no fixed retention period. Opting out stops future collection but does not delete events already sent, and because the ID is random and lasts one view, the owner cannot link it to a visitor or find those events to delete them. GPC is the lasting opt-out. `?optout` covers one page view only. This is a disclosed opt-out, not opt-in. Opt-in would be stricter and would have cost most of an already small sample.

## Setup

Prerequisites: Node 20 or later, a Flagsmith account with Experimentation, and the Flagsmith CLI v2. No key is stored in this repository. Scripts read these environment variables, by name only:

| Name | Used for |
|---|---|
| `FLAGSMITH_API_KEY` | The Flagsmith CLI and the analysis script (admin access to your project) |
| `FS_DEV_CLIENT_KEY` | The Development client-side key, for the demo and the end-to-end suite |
| `FS_PROD_CLIENT_KEY` | The Production client-side key, for the runbook commands and the kill switch |
| `FS_DEV_SERVER_KEY` | The Development server-side key (`ser.` prefix), for the simulator and `served-value.mjs` |
| `DEV_ENV_ID` | The numeric Development environment ID, which the simulator checks before sending anything |
| `SIM_ENV` | Set to `development` to allow the simulator to run |

In PowerShell set one with `$env:FS_DEV_CLIENT_KEY = "<your key>"`. In bash use `export FS_DEV_CLIENT_KEY="<your key>"`.

```sh
git clone https://github.com/ovevayrus/readsharp-tell-vs-feel.git
cd readsharp-tell-vs-feel
npm ci
npm test
```

`npm test` runs the offline unit tests. All of them should pass.

**Read an analysis with no account.** This prints the A/A readout from the saved file. Its summary ends with "Branch 5: Keep running.", followed by the same numbers as a JSON block:

```sh
node analysis/results.mjs --file docs/aa/results.json
```

**Try the demo.** It uses the repo's own modules with a stand-in reading engine, not ReadSharp's. Use a Development key only.

```sh
npm run demo
```

Open http://127.0.0.1:4321/demo/, press Start, then Show my result. Reload for a new page view with a new random identity. See [web/demo/README.md](web/demo/README.md).

**Create the Flagsmith objects.** First bind the repo to your project, so `flagsmith.json` names it (the file is git-ignored). `flagsmith init` on its own asks interactively. Then:

```sh
flagsmith init --project <your project name> --no-input
node scripts/setup-flagsmith.mjs --env development --dry-run
```

It prints the planned actions, or "Development: nothing to create" once everything exists. Drop `--dry-run` to apply them.

**Run the validation traffic.** Development only. The simulator fetches the environment document and refuses to run if its ID does not match `DEV_ENV_ID`. Each run needs its experiment running first (`node scripts/setup-flagsmith.mjs --env development --create-experiment aa_check --start`, or `effect_check`). With no running experiment the simulator records no exposures, sends nothing and exits 1.

```sh
SIM_ENV=development DEV_ENV_ID=<id> node sim/run.mjs --flag aa_check --n 1000 --seed 20261127
SIM_ENV=development DEV_ENV_ID=<id> node sim/run.mjs --flag effect_check --p-control 0.10 --p-variant 0.15 --n 1000 --seed 20261128
```

On PowerShell set `$env:SIM_ENV` and `$env:DEV_ENV_ID` first, then run the `node` line alone.

**Read a live analysis.**

```sh
node analysis/results.mjs --env development --experiment <id> --refresh
```

`--save out.json` keeps the snapshot (the experiment's details plus the raw results). Production snapshots also need `--wiring` and `--canary` flags, and the script refuses to fetch Production before Sat 28 Nov 2026 23:06 EST (the registered final snapshot), so its results cannot be read early. See [analysis/README.md](analysis/README.md).

The browser end-to-end suite is not part of setup. It runs against the private ReadSharp site build, so it is described here and not reproducible from this repository alone.

## Validation

These runs used scripted traffic in the Development environment. They are validation, never results. The two readouts come from the same analysis script on about 500 visitors per arm (1,000 scripted identities per run).

| | A/A ([docs/aa/analysis.md](docs/aa/analysis.md)) | Planted effect ([docs/effect/analysis.md](docs/effect/analysis.md)) |
|---|---|---|
| Setup | Flag `aa_check`, both arms convert at 10% | Flag `effect_check`, control 10%, variant 15% |
| `get_readsharp` | control 52/500, b 45/500 | control 43/498, b 78/502 |
| Difference (95% interval) | -1.39 points (-5.09 to +2.29) | +6.87 points (+2.87 to +10.94) |
| P(b beats control), ours | 0.2284 | 0.9996 |
| P, Flagsmith | 0.2110 | 0.9934 |
| Guardrail `result_shared` | 29 vs 30, not harmed | 18 vs 18, not harmed |
| Decision branch | 5, keep running | 2, ship b |

Two identical arms landed 1.4 points apart, which is what noise looks like at this size. The planted effect read +6.9 points against 5 planted, and its interval stays clear of zero.

**Round 4 rollout.** After branch 2 fired on `effect_check`, the experiment was ended with `b` as the winner ([docs/effect/rollout.md](docs/effect/rollout.md)). Before it ended, the Flagsmith Node SDK served 9 `a` and 11 `b` across 20 fresh identities. Straight after, it served `b` to 20 of 20. No code was redeployed.

**Identity proof.** The Development proof gate checks that the end-to-end browser sessions, which use transient identities, show up in Flagsmith's results per arm. The suite's own tally was 17 control and 12 feel sessions, with 13 and 10 Get ReadSharp clicks. After the run the experiment's exposures grew by exactly those numbers: control +17 exposures and +13 `get_readsharp`, feel +12 and +10 ([docs/proof/before.json](docs/proof/before.json), [docs/proof/before.after.json](docs/proof/before.after.json), [docs/proof/e2e-counts.json](docs/proof/e2e-counts.json)).

## Results (Phase D)

Final snapshot: first refresh at/after Sat 28 Nov 2026 23:00 EST + measured lag, by Sun 01:00 EST; filled in Phase D.

The readout will lead with the interval, then P, the guardrail, the validity gates and the decision branch. Production experiment 1512 started at 22:12:27Z on 27 Nov 2026. Until the snapshot only counts are checked, for health. The launch canary, one owner visit, stays in the data and will be reported with and without it.

## Limitations

- The metric is a proxy; paying happens later, in the app.
- The traffic is promoted and includes hackathon participants.
- It runs over a holiday weekend.
- Repeat visitors can appear more than once through reloads.
- Autoplay draws attention (a confound).
- Only large effects are detectable.
- European visitors are excluded.

## What's next

A first-party proxy is the main gap. Today the browser calls Flagsmith directly, so Flagsmith sees visitor IP addresses. A proxy would stop that, and would let events survive page navigation better. It was dropped for time.

## Repo map

- [EXPERIMENT.md](EXPERIMENT.md): the registered pre-registration.
- [web/](web/): the browser side. `experiment.js` wraps the Flagsmith SDK, `eligibility.js` holds the exclusion rules, `feel-reader.js` is the mini-reader. `demo/` is a stand-alone demo.
- [scripts/](scripts/): `setup-flagsmith.mjs`, `complete-experiment.mjs`, `served-value.mjs`, `kill-switch.mjs`, `probe-identities.mjs` and `proof-gate.mjs`.
- [sim/](sim/): scripted traffic for the Development validation flags.
- [analysis/](analysis/): the Bayesian analysis script.
- [e2e/](e2e/) and [playwright.config.ts](playwright.config.ts): the privacy and wiring checks.
- [docs/](docs/): the runbook, the privacy copy approval, validation readouts (`aa/`, `effect/`) and proof files (`proof/`).

## Video (Phase D)

Phase D: the link will be added here.

## License

MIT. See [LICENSE](LICENSE).
