// epilogue: Logout + post-logout 401 — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-epilogue.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only epilogue]
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  r = await H.req('POST', '/api/logout');
  H.check('logout', r.status === 200);
  H.clearCookie(); // cookie cleared server-side via Max-Age=0 header captured above
  r = await H.req('GET', '/api/summary');
  H.check('after logout /api/summary is 401', r.status === 401);
}

runModuleMain(import.meta.url, { name: 'epilogue', deps, depNames: [], run });
