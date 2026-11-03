// Backward-compatible entry: the suite moved to the split modules
// (tests/e2e-<module>.mjs) run by tests/e2e-run.mjs (Phase 1).
// `node tests/e2e.mjs` still runs the full suite via the runner.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'e2e-run.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(r.status ?? 1);
