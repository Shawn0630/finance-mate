// Split e2e suite runner (Phase 1): runs each tests/e2e-<module>.mjs file
// as its own child process (own server, own stubs, own temp DB), so one
// module's failure never takes down the rest.
//   node tests/e2e-run.mjs               full suite, in file order
//   node tests/e2e-run.mjs --only <name> one module (deps run in setup mode)
//   node tests/e2e-run.mjs --list        list modules
//   node tests/e2e-run.mjs --no-probe    skip the pre-flight probe
// Logs: E2E_LOG_DIR (default: os.tmpdir()/ff-e2e-split-logs) gets
// e2e-split.log (combined, with per-module summaries) plus one
// e2e-split-<module>.log per module (full child output).
// Per-module landing (user decision 2026-11-03): changing a module
// means running ONLY that module (+ its direct dependency setup) to
// verify — a full split run is for measurement, not a landing
// requirement. So `--only <module>` IS the landing run for that
// module's change; run it with the same env as the suite
// (TZ=America/Vancouver, CHROME_EXTRA_FLAGS carrying the WebGL policy).
// Dependency setup each module still replays (its `deps` array runs in
// the setup bucket before its own checks; setup failures BLOCK the
// module with exit 3, they never count toward own totals):
//   no deps: core, costs, nollm, photos, costs-nollm, assessments,
//     chart-colors, investments, spending, epilogue
//   terms <- core; ui-property <- core
//   veil <- core + ui-property
//   csv-wizard <- investments; earnings <- investments + csv-wizard
//   planning <- all 14 preceding modules, OR (E2E_PLAN_SLIM=1) the slim
//     fixture in tests/e2e-plan-fixture.mjs, which rebuilds only the
//     dep-survivor mortgage properties planning projections observe —
//     same own-check coverage, no 1413-check replay (see that file).
// Exit codes: 0 all modules green; 2 pre-flight probe failed, or a module
// exhausted its infra retries; 1 assertion failures or blocked modules.
// Infra policy: a module exiting 2 (EPERM/IOERR/launch crash/frame-detach)
// is retried up to MAX_ATTEMPTS (3) total attempts; assertion failures
// (exit 1) fail immediately with no retry; a retry never manufactures a
// pass — the verdict always comes from a completed run's own assertions,
// and retried passes are flagged PASS* with their attempt count.
// Honest caveat: this makes block-era failures faster and clearer; it
// does NOT prevent them.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const MODULES = ['core', 'costs', 'nollm', 'terms', 'photos', 'ui-property', 'costs-nollm',
  'assessments', 'chart-colors', 'veil', 'investments', 'csv-wizard', 'earnings',
  'spending', 'planning', 'epilogue'];
const MAX_ATTEMPTS = 3;

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(MODULES.join('\n')); process.exit(0); }
let only = null;
const onlyIdx = args.indexOf('--only');
if (onlyIdx >= 0) {
  only = args[onlyIdx + 1] ? args[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  for (const m of only) if (!MODULES.includes(m)) { console.log(`unknown module: ${m}`); process.exit(1); }
}
const runModules = only && only.length ? MODULES.filter((m) => only.includes(m)) : MODULES;
const logDir = process.env.E2E_LOG_DIR || path.join(os.tmpdir(), 'ff-e2e-split-logs');
fs.mkdirSync(logDir, { recursive: true });
const combinedLog = path.join(logDir, 'e2e-split.log');
fs.writeFileSync(combinedLog, '');

const log = (s) => { console.log(s); fs.appendFileSync(combinedLog, s + '\n'); };
const runOne = (mod) => new Promise((resolve) => {
  const modLog = path.join(logDir, `e2e-split-${mod}.log`);
  const out = fs.createWriteStream(modLog);
  const child = spawn(process.execPath, [path.join(TESTS, `e2e-${mod}.mjs`)], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'America/Vancouver' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { out.write(d); buf += d; });
  child.stderr.on('data', (d) => { out.write(d); buf += d; });
  child.on('close', (code) => {
    out.end();
    const m = buf.match(/MODULE \S+ OWN pass=(\d+) fail=(\d+) SETUP pass=(\d+) fail=(\d+) INFRA=(\d)/);
    resolve({ code: code ?? 1, own: m ? { pass: +m[1], fail: +m[2] } : null, setup: m ? { pass: +m[3], fail: +m[4] } : null, infra: m ? m[5] === '1' : false });
  });
});

if (!args.includes('--no-probe')) {
  log('--- pre-flight probe ---');
  const probe = spawnSync(process.execPath, [path.join(TESTS, 'e2e-probe.mjs')], {
    cwd: ROOT, env: { ...process.env, TZ: 'America/Vancouver' }, encoding: 'utf8',
  });
  log((probe.stdout || '').trim());
  if (probe.status !== 0) {
    log(`E2E ABORTED: pre-flight probe failed (exit ${probe.status}) — environment not ready (see the PROBE BLOCK step above); fix it, then re-run.`);
    process.exit(2);
  }
}

const results = [];
for (const mod of runModules) {
  let attempt = 0, res = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    res = await runOne(mod);
    if (res.code !== 2) break;
    log(`module ${mod}: infra failure on attempt ${attempt}/${MAX_ATTEMPTS}, retrying...`);
  }
  const verdict = res.code === 0 ? (attempt > 1 ? `PASS* (after ${attempt} attempts)` : 'PASS')
    : res.code === 2 ? `FAIL (infra, ${attempt} attempts)`
    : res.code === 3 ? 'BLOCKED (dep failed in setup)'
    : 'FAIL (assertions)';
  results.push({ mod, ...res, attempts: attempt, verdict });
  log(`module ${mod}: ${verdict} (own ${res.own ? `${res.own.pass}/${res.own.fail}` : '?'}, setup ${res.setup ? `${res.setup.pass}/${res.setup.fail}` : '?'})`);
}
const totalPass = results.reduce((a, r) => a + (r.own ? r.own.pass : 0), 0);
const totalFail = results.reduce((a, r) => a + (r.own ? r.own.fail : 0), 0);
const bad = results.filter((r) => r.code !== 0);
log('---');
log(`E2E SPLIT: ${results.length} module(s), own ${totalPass} pass / ${totalFail} fail`);
if (bad.length === 0) log('E2E SPLIT: ALL PASS');
else log(`E2E SPLIT: ${bad.length} MODULE(S) NOT GREEN: ${bad.map((r) => `${r.mod} (${r.verdict})`).join(', ')}`);
process.exit(bad.length === 0 ? 0 : (bad.some((r) => r.code === 2) ? 2 : 1));
