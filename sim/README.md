# Flagsmith scripted traffic

Generate experiment exposures and conversion events for `aa_check` or `effect_check` in Development.
Set `SIM_ENV=development` and provide `FS_DEV_SERVER_KEY` with the `ser.` prefix.
Set both `FLAGSMITH_API_KEY` and `DEV_ENV_ID` to verify the server key's environment ID before sending events.

```sh
SIM_ENV=development node sim/run.mjs --flag aa_check --n 1000 --seed 1
```
Results are for validation only. The summary counts events queued by the SDK.
