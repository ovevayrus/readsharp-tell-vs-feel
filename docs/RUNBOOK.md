# Runbook: Tell vs Feel, live on readsharp.app

The Production experiment is **1512, "Tell vs Feel"**, on the flag `speed_test_next_step`. It was created at 2026-11-27 22:12:00Z and started at 22:12:27Z, with 100% rollout, tell 50 / feel 50, and the metrics `get_readsharp` (1571, primary), `result_shared` (1572, guardrail) and `installer_download` (1573, informational). EXPERIMENT.md was REGISTERED in commit `cd7ede6`, pushed at 22:08:43Z. The start came 26 s after the creation, because the setup script reads the state back in between. For those 26 s the edge served the split without recording exposures. Visitors in that window are simply missing from the results.

Until the final snapshot, **look only at counts, for health** (EXPERIMENT.md). None of the commands below show the probability or the interval.

## Before any command

Run these in PowerShell from `C:\Users\oveva\flagsmith`. The Flagsmith CLI uses its own credentials (`FLAGSMITH_API_KEY`). The request path holds the Production client-side key from `FS_PROD_CLIENT_KEY`. That key is public by design (it is in the page's HTML), but the CLI prints the full path when a call fails (for example a 429 on a refresh within 5 minutes). `Invoke-Flagsmith` runs the CLI and replaces the key with `<key>` in everything it prints, so use it for every command below.

```powershell
Remove-Item Env:NODE_DEBUG -ErrorAction SilentlyContinue
$E = "api/v1/environments/$env:FS_PROD_CLIENT_KEY"
function Invoke-Flagsmith { flagsmith @args 2>&1 | ForEach-Object { "$_".Replace($env:FS_PROD_CLIENT_KEY, '<key>') } }
```

## Monitoring

Flagsmith recomputes results on request, at most once every 5 minutes (an earlier refresh answers 429 "Try again later"). Each command shows `as_of`, the time of the last recompute.

**Refresh the results:**

```powershell
Invoke-Flagsmith api "$E/experiments/1512/results/refresh/" -X POST
```

**Experiment status** (it should stay `running`, 100%, 50/50):

```powershell
Invoke-Flagsmith api "$E/experiments/1512/" --jq '{status, created_at, started_at, rollout: .experiment_rollout.rollout_percentage, split: .experiment_rollout.multivariate_feature_state_values}'
```

**Exposures per arm** (new identities, summed over the time series):

```powershell
Invoke-Flagsmith api "$E/experiments/1512/results/" --jq '{as_of: .results.as_of, exposures: ([.results.payload.exposures_timeseries.points[]?.new_identities | to_entries[]] | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | from_entries)}'
```

**`get_readsharp` per arm** (conversions, and the identities counted for the metric):

```powershell
Invoke-Flagsmith api "$E/experiments/1512/results/" --jq '.results.payload.metrics[] | select(.metric_id == 1571) | {get_readsharp: (.variants | map_values(.sum)), identities: (.variants | map_values(.n))}'
```

**`result_shared` per arm** (the guardrail):

```powershell
Invoke-Flagsmith api "$E/experiments/1512/results/" --jq '.results.payload.metrics[] | select(.metric_id == 1572) | {result_shared: (.variants | map_values(.sum))}'
```

**SRM flag.** Flagsmith warns when the split is a one-in-a-thousand imbalance or rarer, and only checks from 100 identities ([statistics glossary](https://docs.flagsmith.com/experimentation/statistics)). `srm_p_value` stays `null` until then, and it was also `null` at 1,000 identities in both Development validation runs (docs/aa/results.json, docs/effect/results.json), so a `null` does not prove the split is fine: compare the exposures per arm, which should be roughly 50/50. The analysis script (`analysis/results.mjs`) runs the same one-in-a-thousand test itself, on the exposures, whenever Flagsmith's value is `null`. An SRM warning means stop: the results are invalid, so investigate.

```powershell
Invoke-Flagsmith api "$E/experiments/1512/results/" --jq '{as_of: .results.as_of, srm_p_value: .results.payload.srm_p_value, srm_warning: (.results.payload.srm_p_value != null and .results.payload.srm_p_value < 0.001), is_final: .results.is_final, last_error_at: .results.last_error_at}'
```

**Warehouse status** (it should be `connected`, with `total_events_received` growing as visitors arrive):

```powershell
Invoke-Flagsmith api "$E/warehouse-connections/" --jq '.[] | {status, total_events_received, last_event_received_at}'
```

A variation shows "collecting data" in the dashboard until it has 50 identities and 5 conversions.

## Launch canary

The canary was one owner visit to `readsharp.app/reading-speed-test?canary`, made at 22:13:09Z with identity `canary-0c928a42-eaef-4225-abb8-bd4be1fcbd86`. It landed in arm **feel**. Its `$flag_exposure` POST returned 202 at 22:13:12.5Z, and its `get_readsharp` POST returned 202 at 22:13:13.2Z ([docs/proof/canary.json](proof/canary.json)). The Production warehouse went from 1 to 3 events received by 22:14:13Z.

**Ingestion lag: 6 minutes, measured.** The recompute as of 22:13:48.9Z was empty. The next one, as of 22:19:09.9Z, showed feel with 1 exposure and 1 `get_readsharp`. Flagsmith recomputes at most every 5 minutes, so 6 minutes is an upper bound.

Results are aggregate, with no per-identity lookup, so the canary counts as seen at the first recompute that shows at least 1 exposure and 1 `get_readsharp` in feel. At that point the warehouse held 3 events in total: the pre-flight event plus the canary's exposure and `get_readsharp`. So those counts can only be the canary. The polls are logged in [docs/proof/canary-polls.jsonl](proof/canary-polls.jsonl). **The canary was seen end to end** (validity gate 4 in EXPERIMENT.md).

**The canary stays in the data.** Results are aggregate, so it can't be removed per identity: it is 1 feel exposure plus 1 feel `get_readsharp`. The final readout (Prompt D) must say so, and must also show the result with the canary subtracted (feel exposures −1, feel `get_readsharp` −1). At about 300 per arm, that's roughly 0.3 points against the 4.3 points needed to decide.

**`?canary` is a public URL parameter.** Anyone who opens the page with it gets a `canary-` identity, and those identities can't be told apart in aggregate results. Only the owner's one visit at 22:13:09Z was the launch canary. Don't share links containing `?canary`.

## Kill switch (owner only)

This sets the experiment's rollout to 0%: everyone then gets `tell` and nothing more is recorded. It is the only setting ever changed while the experiment runs, and only the owner triggers it.

```powershell
node scripts/kill-switch.mjs
node scripts/kill-switch.mjs --yes
```

The first command is a dry run that shows what would be sent. The second sends it, reads the experiment back, and exits 1 unless the rollout is now 0. The script copies the live experiment and changes only `rollout_percentage`. It was checked only as a dry run, never sent, so after `--yes` run the status command above and compare its output with the dry-run summary. In the dashboard, the same change is Experiments → Tell vs Feel → rollout → 0%.

## Rollback (owner only)

This puts back the site exactly as it was before the launch. It doesn't stop the experiment, so use the kill switch first.

From `C:\Users\oveva\readfast-worktrees\flagsmith-tell-vs-feel`:

```powershell
npx wrangler@4.45.0 pages deploy C:\Users\oveva\ReadSharpBackups\site-2026-11-27_1702-EST --project-name readfast-site --branch main
```

The backup holds 31 files, byte-identical to the pre-launch deployment `61a81834` (source `b11ea70`), and was checked against it. Alternatively, in the Cloudflare dashboard go to Workers & Pages → `readfast-site` → Deployments, open deployment `61a81834` and choose Rollback.

## Final snapshot

Take the first results refresh at or after **Sat 28 Nov 2026 23:00 EST plus the ingestion lag**. With the measured 6-minute lag, that is **the first refresh at or after Sat 28 Nov 23:06 EST (Sun 04:06Z)**. It must be **never later than Sun 29 Nov 01:00 EST**. The 6 minutes comes from a single measurement and is an upper bound, so ingestion could have a tail. The rule stays as registered. Before saving, run the warehouse command: if `last_event_received_at` falls inside the 6 minutes before the refresh's `as_of`, the readout should say that the latest events may be missing. Save the raw JSON, then run the analysis (Prompt D):

```powershell
Invoke-Flagsmith api "$E/experiments/1512/results/refresh/" -X POST
New-Item -ItemType Directory -Force docs/results | Out-Null
Invoke-Flagsmith api "$E/experiments/1512/results/" --json | Out-File -Encoding utf8 docs/results/final-results.json
Get-Content docs/results/final-results.json -Raw | ConvertFrom-Json | Out-Null
```

`Invoke-Flagsmith` merges the CLI's stderr into its output, so the last line checks the saved file is valid JSON; if it throws, save again. The analysis script can instead refresh, save and analyse in one step. It refreshes only when the last recompute is more than 5 minutes old, writes the experiment's details plus the raw results with no BOM, and refuses to read Production before 23:06 EST. Phase D sets `--wiring` and `--canary` from the evidence:

```powershell
New-Item -ItemType Directory -Force docs/results | Out-Null
node analysis/results.mjs --env production --experiment 1512 --refresh --save docs/results/final-snapshot.json --wiring <pass|fail> --canary <seen|missing>
```

Add `--subtract-canary feel` for the run with the launch canary removed. EXPERIMENT.md doesn't say which of the two runs the decision uses.

**Decided by the owner on Sat 28 Nov 2026 at 02:09 EST, before the final snapshot and without seeing any win probability or interval:** the **unadjusted** run decides, because it uses Flagsmith's own numbers, the registered source. The run with the canary subtracted is reported next to it. If the two runs land on different branches of the rule, the README and DECISION.md must say so plainly.

## Help

[Flagsmith Discord](https://discord.gg/hFhxNtXzgm)
