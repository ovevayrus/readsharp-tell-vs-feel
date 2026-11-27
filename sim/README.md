# Flagsmith scripted traffic

Generate experiment exposures and conversion events for `aa_check` or `effect_check` in Development.
Set `SIM_ENV=development` and provide `FS_DEV_SERVER_KEY` with the `ser.` prefix.
`DEV_ENV_ID` (the numeric Development environment ID) is required: the simulator fetches the environment document with the server key and refuses to run unless its ID matches.

```sh
SIM_ENV=development node sim/run.mjs --flag aa_check --n 1000 --seed 1
```
Results are for validation only. The summary counts events queued by the SDK. Exit code is 1 when no exposures were queued or any error was counted.
