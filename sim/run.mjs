import { Flagsmith } from '@flagsmith/nodejs';
import { parseArgs, runSim, SimError } from './lib.mjs';

try {
  const summary = await runSim(parseArgs(process.argv.slice(2)), {
    env: process.env,
    fetchImpl: fetch,
    createClient: (config) => new Flagsmith(config),
  });
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error instanceof SimError ? error.message : 'Simulation failed.');
  process.exitCode = 1;
}
