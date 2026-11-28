# Result step demo

A stand-alone demo of the Tell vs Feel result step. It uses the repo's `eligibility.js`, `experiment.js` and `feel-reader.js` with a STAND-IN reading engine, not ReadSharp's.

1. `npm ci`
2. Set a Flagsmith **Development** client-side key (never a `ser.` key, never Production). PowerShell: `$env:FS_DEV_CLIENT_KEY = "<your key>"`
3. `npm run demo`, then open the printed URL (port 4321, or set `DEMO_PORT`).
4. Press Start, then Show my result. Reload for a new page view with a new random identity.

Both arms appear across reloads while the Development experiment runs. The key is injected into the page in memory and never written to disk.
