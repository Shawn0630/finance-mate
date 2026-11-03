// Child-process entry for one split e2e module. Each module file ends with
//   runModuleMain(import.meta.url, { name, deps, run });
// which is a no-op when the module is imported (as a dep) and runs the
// module only when it is the entry point: deps first (setup bucket),
// then the module's own section (own bucket).
// Exit codes: 0 own green; 1 own assertion failures; 2 infra failure
// (EPERM/IOERR/launch crash/frame-detach — the runner retries these, up
// to 3 attempts); 3 blocked because a dep failed in setup mode.
// A retry never manufactures a pass: the verdict always comes from a
// completed run's own assertions, and attempts are reported.
import { pathToFileURL } from 'node:url';

export async function runModuleMain(entryUrl, { name, deps, depNames = [], run }) {
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
  if (entryUrl !== entry) return;
  let H = null;
  let code = 0;
  try {
    const { startHarness } = await import('./e2e-harness.mjs');
    H = await startHarness();
    const S = {};
    // Deps that are not core assume a logged-in admin session (in the old
    // suite the cookie carried over from core); core itself must run its
    // auth flow unauthenticated, so it never gets a pre-deps login.
    if (name !== 'core' && !depNames.includes('core')) await H.ensureLogin();
    H.setBucket('setup');
    for (const dep of deps) await dep(H, S);
    const sc = H.counts().setup;
    if (sc.fail > 0) {
      console.log(`MODULE ${name} BLOCKED: setup failed (${sc.fail} failure(s))`);
      code = 3;
    } else {
      if (name !== 'core') await H.ensureLogin();
      H.setBucket('own');
      await run(H, S);
    }
  } catch (err) {
    if (H) H.noteInfra(err);
    console.log(`MODULE ${name} ERROR: ${String((err && err.stack) || err)}`);
    code = !H ? 2 : (H.infraDetected() ? 2 : 1);
  } finally {
    if (H) await H.close();
  }
  if (H && code === 0) {
    const c = H.counts();
    if (H.infraDetected()) code = 2;
    else if (c.own.fail > 0) code = 1;
  }
  if (H) {
    const c = H.counts();
    console.log(`MODULE ${name} OWN pass=${c.own.pass} fail=${c.own.fail} SETUP pass=${c.setup.pass} fail=${c.setup.fail} INFRA=${H.infraDetected() ? 1 : 0}`);
  }
  process.exit(code);
}
