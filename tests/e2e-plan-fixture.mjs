// Slim planning fixture: rebuilds ONLY the mainline snapshot state that
// planning's own checks observe, without replaying the 14 dep modules
// (1413 setup checks). Runs as planning's single dep when
// E2E_PLAN_SLIM=1 (see tests/e2e-planning.mjs); otherwise planning
// keeps its full dep chain.
//
// What planning projections actually read (src/planning.js
// computeProjection + src/server.js planAssembleMainline):
//   - every mainline property (mortgage plans + assessed column);
//   - holdings only for stock series (world-independent for the checks
//     that compare worlds, so none are needed here).
// Proof the set below is sufficient AND necessary (2026-11-03):
//   - a no-dep planning run passed 553/556; its 3 failures were the
//     property-growth check, the merged-Payoff-cell check, and the
//     uibundle header check (the last fails identically with deps —
//     a pre-existing UI-round defect, not dep state).
//   - the growth + payoff checks fail without deps because projections
//     run over ALL mainline properties: without dep survivors, assessed
//     totals are ~0 (growth world goes negative under 9% prime) and the
//     latest payoff month comes from a planning property (month+shift
//     renders consistent instead of shift-alone).
// The 8 properties below are the dep survivors that change an outcome,
// captured from a full dep-chain run
// (~/workspace/fm-verify/speedup-plan-capture.log, CAPTURE_SNAPSHOT):
//   - 5 assessed properties (no segments): their assessed column values
//     supply the growth delta that makes the growth world beat flat.
//   - 3 runnable properties (segments + balances): their payoff months
//     supply the project-wide latest payoff that makes the merged
//     Payoff cell render shift-alone.
// Deliberately OMITTED (proven irrelevant by the no-dep run): the
// harness legacy seed rows (present in every run anyway), all
// no-segment/no-assessed survivors (they contribute -balance equally
// in every world and no payoff month), and all dep holdings (no
// planning check reads dep holdings: the no-dep run passed every
// stock-related check without them).
// No H.check calls here on purpose: fixture work must not inflate the
// setup bucket, so the slim module log's PASS lines are exactly the
// own-check names (the coverage-proof input). Any unexpected status
// throws, which BLOCKS the module (exit 3) instead of silently
// shifting own-check values.
const reqOrThrow = async (H, method, url, body, want) => {
  const r = await H.req(method, url, body);
  if (!want.includes(r.status)) {
    throw new Error(`slim fixture: ${method} ${url} -> ${r.status} (want ${want.join('/')}) ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return r;
};

export async function runSlimPlanFixture(H) {
  // Assessed-only survivors: balance + assessed column, no segments.
  // Balance dates default to today (as the deps' did) except Equity
  // Anchor Way, whose 2026-10-01 date is a fixed fixture fact.
  const assessedProps = [
    { address: '999 Somewhere Else', mortgage_balance: 900000, assessed_value: 6532000, assessed_year: 2026 },
    { address: '2985 Equity Anchor Way, Coquitlam, BC', mortgage_balance: 1280775, mortgage_balance_date: '2026-10-01', assessed_value: 1931000, assessed_year: 2026 },
    { address: '999 Money Test Terrace, Victoria, BC', mortgage_balance: 2500, assessed_value: 2100000, assessed_year: 2026 },
    { address: '1200 Douglas St, Victoria, BC', mortgage_balance: 500000, assessed_value: 6532000, assessed_year: 2026 },
    { address: '1200 Douglas St, Victoria, BC', mortgage_balance: 400000, assessed_value: 6532000, assessed_year: 2026 },
  ];
  for (const p of assessedProps) {
    await reqOrThrow(H, 'POST', '/api/properties', { ...p, purchase_date: '2024-01-15' }, [201]);
  }

  // Runnable survivors: balance + term + segment, exactly as captured.
  // 1 Save Sweep Close: variable prime_spread -0.85, monthly
  // compounding, DAILY accrual (final state after the sweep section's
  // edits — the first rates POST said monthly), locked 2025-05-20.
  let r = await reqOrThrow(H, 'POST', '/api/properties', {
    address: '1 Save Sweep Close, Victoria, BC', purchase_date: '2025-05-20',
    mortgage_balance: 600000, mortgage_balance_date: '2025-05-20', amortization_years: 25,
  }, [201]);
  let pid = r.data.id;
  r = await reqOrThrow(H, 'GET', `/api/properties/${pid}`, undefined, [200]);
  await reqOrThrow(H, 'PUT', `/api/properties/${pid}/terms/${r.data.terms[0].id}`, {
    start_date: '2025-05-20', term_months: 60, amortization_years: 25, payment_day: 20,
  }, [200]);
  await reqOrThrow(H, 'POST', `/api/properties/${pid}/rates`, {
    term_id: r.data.terms[0].id, start_date: '2025-05-20', rate_type: 'variable',
    rate_mode: 'prime_spread', spread: -0.85, compounding: 'monthly', accrual: 'daily',
    locked_on: '2025-05-20',
  }, [201]);

  // 977 Window Test Way: fixed 5% from 2025-01-01; balance date and
  // amortization PUT after creation (as the dep did), leaving the
  // auto term's start at today.
  r = await reqOrThrow(H, 'POST', '/api/properties', {
    address: '977 Window Test Way, Victoria, BC', purchase_date: '2020-01-15', mortgage_balance: 500000,
  }, [201]);
  pid = r.data.id;
  await reqOrThrow(H, 'PUT', `/api/properties/${pid}`, { mortgage_balance_date: '2025-01-15', amortization_years: 25 }, [200]);
  r = await reqOrThrow(H, 'GET', `/api/properties/${pid}`, undefined, [200]);
  await reqOrThrow(H, 'PUT', `/api/properties/${pid}/terms/${r.data.terms[0].id}`, { term_months: 60, amortization_years: 25 }, [200]);
  await reqOrThrow(H, 'POST', `/api/properties/${pid}/rates`, {
    term_id: r.data.terms[0].id, start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5,
  }, [201]);

  // 966 Step Test Place: variable prime_spread -1 from 2024-12-17,
  // defaults (semi_annual, monthly), no amortization anywhere.
  r = await reqOrThrow(H, 'POST', '/api/properties', {
    address: '966 Step Test Place, Victoria, BC', purchase_date: '2024-01-15',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
  }, [201]);
  pid = r.data.id;
  r = await reqOrThrow(H, 'GET', `/api/properties/${pid}`, undefined, [200]);
  await reqOrThrow(H, 'PUT', `/api/properties/${pid}/terms/${r.data.terms[0].id}`, { start_date: '2026-10-25', term_months: 60 }, [200]);
  await reqOrThrow(H, 'POST', `/api/properties/${pid}/rates`, {
    term_id: r.data.terms[0].id, start_date: '2024-12-17', rate_type: 'variable',
    rate_mode: 'prime_spread', spread: -1,
  }, [201]);
}
