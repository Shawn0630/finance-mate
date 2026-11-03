// investments: Investments module: accounts, holdings, events, plans, overview — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-investments.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only investments]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // Investments module: accounts → holdings → events, priced by
  // the stubbed Stooq/Yahoo/FX sources, checked at all three
  // levels (portfolio / account / holding) against hand-computed
  // numbers, then the account-page AI fill chat (stub LLM).
  // Stub closes: XQQ.TO 140/150/160/165 (Stooq), AAPL 200/210/220
  // (Stooq), HXQ.TO — Stooq "No data" — 61/62/63 via Yahoo,
  // ACME nothing anywhere (event prices only). FX: 1.30 through
  // January, 1.40 from Feb 1.
  // ================================================================
  r = await H.req('POST', '/api/investments/accounts', { name: 'Bad', type: 'LIRA' });
  H.check('investments: an unknown account type is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/accounts', { name: 'TFSA', type: 'TFSA', institution: 'CIBC' });
  const invTfsaId = r.data.id;
  H.check('investments: TFSA account created', r.status === 201 && !!invTfsaId, JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/accounts', { name: 'Employer RSU', type: 'RSU' });
  const invRsuId = r.data.id;
  r = await H.req('POST', '/api/investments/accounts', { name: 'Margin', type: 'NonRegistered', institution: 'Scotia' });
  const invMarginId = r.data.id;
  H.check('investments: RSU and non-registered accounts created', !!invRsuId && !!invMarginId, `${invRsuId}/${invMarginId}`);

  r = await H.req('POST', `/api/investments/accounts/${invTfsaId}/holdings`, { label: 'NoTicker', kind: 'exchange', currency: 'CAD' });
  H.check('investments: an exchange holding without a symbol is a 400', r.status === 400, JSON.stringify(r.data));
  const invPost = (acct, body) => H.req('POST', `/api/investments/accounts/${acct}/holdings`, body);
  r = await invPost(invTfsaId, { label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', currency: 'CAD' });
  const invXqqId = r.data.id;
  r = await invPost(invTfsaId, { label: 'CIBC U.S. Index Fund', kind: 'fund', currency: 'CAD' });
  const invFundId = r.data.id;
  r = await invPost(invTfsaId, { label: 'HXQ', kind: 'exchange', symbol: 'HXQ.TO', currency: 'CAD' });
  const invHxqId = r.data.id;
  r = await invPost(invMarginId, { label: 'Apple', kind: 'exchange', symbol: 'AAPL', currency: 'USD' });
  const invAaplId = r.data.id;
  r = await invPost(invRsuId, { label: 'Acme Corp', kind: 'exchange', symbol: 'ACME', currency: 'USD' });
  const invAcmeId = r.data.id;
  H.check('investments: five holdings created across the accounts',
    [invXqqId, invFundId, invHxqId, invAaplId, invAcmeId].every(Boolean),
    JSON.stringify({ invXqqId, invFundId, invHxqId, invAaplId, invAcmeId }));

  const invEvent = (hid, body) => H.req('POST', `/api/investments/holdings/${hid}/events`, body);
  r = await invEvent(invXqqId, { date: '2026-01-05', type: 'buy', units: 10, price: 145 });
  const invXqqBuy1 = r.data.id;
  H.check('investments: first XQQ buy recorded', r.status === 201, JSON.stringify(r.data));
  await invEvent(invXqqId, { date: '2026-02-03', type: 'buy', units: 10, price: 152 });
  await invEvent(invFundId, { date: '2026-01-12', type: 'buy', units: 100, price: 30 });
  await invEvent(invHxqId, { date: '2026-01-06', type: 'buy', units: 10, price: 60 });
  await invEvent(invAaplId, { date: '2026-01-06', type: 'buy', units: 5, price: 205 });
  await invEvent(invAcmeId, { date: '2026-01-15', type: 'grant', units: 20, price: 40 });
  r = await invEvent(invAcmeId, { date: '2026-02-15', type: 'grant', units: 10 });
  H.check('investments: an unpriced RSU grant is accepted (market price fills in)', r.status === 201, JSON.stringify(r.data));
  r = await invEvent(invXqqId, { date: '2026-03-01', type: 'sell', units: 21, price: 160 });
  H.check('investments: selling more than held is a 400', r.status === 400, JSON.stringify(r.data));

  r = await H.req('POST', `/api/investments/holdings/${invFundId}/nav`, { date: '2026-01-31', price: 31 });
  H.check('investments: first manual NAV snapshot recorded', r.status === 201, JSON.stringify(r.data));
  await H.req('POST', `/api/investments/holdings/${invFundId}/nav`, { date: '2026-02-28', price: 32 });

  // ---- holding level ----
  r = await H.req('GET', `/api/investments/holdings/${invXqqId}`);
  const xqqJan = r.data.monthly.find((m) => m.month === '2026-01');
  const xqqFeb = r.data.monthly.find((m) => m.month === '2026-02');
  H.check('investments: XQQ January — bought at 145, month-end close 140',
    xqqJan && xqqJan.startValue === 0 && xqqJan.contributions === 1450 && xqqJan.endValue === 1400
      && xqqJan.gain === -50 && xqqJan.returnPct === -3.45, JSON.stringify(xqqJan));
  H.check('investments: XQQ February — second buy, month-end close 150',
    xqqFeb && xqqFeb.startValue === 1400 && xqqFeb.contributions === 1520 && xqqFeb.endValue === 3000
      && xqqFeb.gain === 80 && xqqFeb.returnPct === 2.74, JSON.stringify(xqqFeb));
  H.check('investments: XQQ summary rides the latest Stooq close (165)',
    r.data.summary.units === 20 && r.data.summary.value === 3300 && r.data.summary.contributions === 2970
      && r.data.summary.totalReturn === 330 && r.data.summary.totalReturnPct === 11.11
      && r.data.summary.latestPrice === 165 && r.data.summary.latestPriceDate === '2026-03-20'
      && r.data.priceStatus.pricedBy === 'stooq' && r.data.events.length === 2,
    JSON.stringify(r.data.summary));

  r = await H.req('GET', `/api/investments/holdings/${invHxqId}`);
  H.check('investments: HXQ is priced by the Yahoo fallback when Stooq has nothing',
    r.data.priceStatus.pricedBy === 'yahoo' && r.data.summary.value === 630
      && r.data.summary.contributions === 600 && r.data.summary.totalReturn === 30
      && r.data.summary.latestPrice === 63 && r.data.summary.latestPriceSource === 'yahoo',
    JSON.stringify({ ps: r.data.priceStatus, sm: r.data.summary }));

  r = await H.req('GET', `/api/investments/holdings/${invAaplId}?display=CAD`);
  const aaplJan = r.data.monthly.find((m) => m.month === '2026-01');
  const aaplFeb = r.data.monthly.find((m) => m.month === '2026-02');
  H.check('investments: AAPL carries its USD currency; monthly rows are CAD at the month rates',
    r.data.holding.currency === 'USD' && aaplJan && aaplJan.contributions === 1332.5 && aaplJan.endValue === 1300
      && aaplFeb && aaplFeb.endValue === 1470, JSON.stringify({ aaplJan, aaplFeb }));
  H.check('investments: AAPL summary — native and CAD side by side',
    r.data.summary.valueNative === 1100 && r.data.summary.value === 1540
      && r.data.summary.totalReturn === 207.5 && r.data.summary.totalReturnPct === 15.57,
    JSON.stringify(r.data.summary));

  r = await H.req('GET', `/api/investments/holdings/${invAcmeId}?display=CAD`);
  H.check('investments: RSU grants accumulate units; the unpriced grant takes the known market price',
    r.data.summary.units === 30 && r.data.summary.valueNative === 1200 && r.data.summary.totalReturnNative === 0
      && r.data.summary.unpricedGrants === 0 && r.data.priceStatus.pricedBy === 'event',
    JSON.stringify(r.data.summary));
  H.check('investments: RSU in CAD — the FX move is the only gain',
    r.data.summary.value === 1680 && r.data.summary.contributions === 1600 && r.data.summary.totalReturn === 80,
    JSON.stringify(r.data.summary));

  // ---- display currency ----
  // Portfolio in USD: CAD holdings divide by the latest stub
  // rate (1.40), USD holdings stand native; the % figures do
  // not move (pinned to the CAD run).
  r = await H.req('GET', '/api/investments');
  const cadPort = r.data;
  H.check('investments: portfolio opens in CAD by default',
    r.data.display === 'CAD' && r.data.summary.value === 10350, JSON.stringify(r.data.summary));
  r = await H.req('GET', '/api/investments?display=USD');
  const usdPort = r.data;
  H.check('investments: portfolio in USD converts dollars, keeps the CAD percentages',
    r.data.display === 'USD' && r.data.summary.value === 7392.85
      && r.data.summary.totalReturnPct === cadPort.summary.totalReturnPct
      && r.data.monthly.find((m) => m.month === '2026-01').returnPct
        === cadPort.monthly.find((m) => m.month === '2026-01').returnPct,
    JSON.stringify({ usd: r.data.summary, cad: cadPort.summary }));
  H.check('investments: an invalid display falls back to CAD',
    (await H.req('GET', '/api/investments?display=EUR')).data.display === 'CAD');
  // Holding pages open in their own currency.
  r = await H.req('GET', `/api/investments/holdings/${invAaplId}`);
  H.check('investments: a USD holding page opens in USD',
    r.data.display === 'USD' && r.data.summary.value === 1100 && r.data.summary.valueNative === 1100,
    JSON.stringify(r.data.summary));
  r = await H.req('GET', `/api/investments/holdings/${invXqqId}`);
  H.check('investments: a CAD holding page opens in CAD',
    r.data.display === 'CAD' && r.data.summary.value === 3300, JSON.stringify(r.data.summary));
  // ---- overview chart endpoint ----
  // The Overview panel's data: the Property series is monthly
  // EQUITY (assessed minus outstanding principal), and the stock
  // series must match the Stocks portfolio's CAD series — one
  // endpoint, no recomputation, no net-worth involvement.
  // Portfolio first (its BCA refresh, if any, lands before
  // both reads).
  const pfForOv = (await H.req('GET', '/api/properties/portfolio')).data;
  r = await H.req('GET', '/api/overview/chart');
  const ovChart = r.data;
  const invForOv = (await H.req('GET', '/api/investments')).data;
  // Structural equity pin: months run contiguously from January
  // of the first assessed year through the current month, and no
  // month's equity exceeds that year's assessed total (every
  // outstanding balance is >= 0). The exact assessed-minus-
  // balance arithmetic is pinned by the fixture block below.
  const ovPfYears = (pfForOv.assessedByYear || []).map((a) => a.year);
  const ovAssessedInForce = (y) => {
    let v = 0;
    for (const a of pfForOv.assessedByYear || []) { if (a.year <= y) v = a.total; else break; }
    return v;
  };
  const ovNextM = (m) => {
    const y = Number(m.slice(0, 4)); const mo = Number(m.slice(5, 7));
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  };
  const ovPropMonths = (ovChart.propertyByMonth || []).map((p) => p.month);
  let ovContig = true;
  for (let i = 1; i < ovPropMonths.length; i++) if (ovNextM(ovPropMonths[i - 1]) !== ovPropMonths[i]) ovContig = false;
  H.check('overview chart: property series is monthly equity spanning first assessed year through current month, never above assessed',
    Array.isArray(ovChart.propertyByMonth) && !('assessedByYear' in ovChart)
      && (ovPfYears.length === 0 ? ovPropMonths.length === 0
        : ovPropMonths[0] === `${Math.min(...ovPfYears)}-01`
          && ovPropMonths[ovPropMonths.length - 1] === ovChart.currentMonth && ovContig)
      && (ovChart.propertyByMonth || []).every((p) => p.value <= ovAssessedInForce(Number(p.month.slice(0, 4))) + 0.011),
    JSON.stringify({ first: ovPropMonths[0], last: ovPropMonths[ovPropMonths.length - 1], cur: ovChart.currentMonth, pfYears: ovPfYears }));
  H.check('overview chart: stock series matches the Stocks portfolio CAD series',
    JSON.stringify(ovChart.stockSeries) === JSON.stringify((invForOv.series || []).map((s) => ({ month: s.month, value: s.value }))),
    JSON.stringify({ ov: (ovChart.stockSeries || []).slice(0, 3), inv: (invForOv.series || []).slice(0, 3) }));
  H.check('overview chart: current month is a YYYY-MM month',
    typeof ovChart.currentMonth === 'string' && /^\d{4}-\d{2}$/.test(ovChart.currentMonth),
    JSON.stringify({ currentMonth: ovChart.currentMonth }));
  // Equity arithmetic, exact: a dedicated mortgaged fixture with
  // known assessed points and a fixed-rate schedule. The delta
  // between two adjacent endpoint reads isolates this property
  // (nothing else writes in between), and the amortization
  // endpoint supplies the independent outstanding series.
  const ovBefore = new Map((ovChart.propertyByMonth || []).map((p) => [p.month, p.value]));
  r = await H.req('POST', '/api/properties', {
    address: 'Equity Chart Lane, Victoria, BC',
    mortgage_balance: 240000, mortgage_balance_date: '2024-01-15', purchase_date: '2024-01-15',
  });
  const ovEqPid = r.data.id;
  await H.req('POST', `/api/properties/${ovEqPid}/value-history`, { year: 2024, value: 500000 });
  await H.req('POST', `/api/properties/${ovEqPid}/value-history`, { year: 2025, value: 600000 });
  await H.req('POST', `/api/properties/${ovEqPid}/rates`, { start_date: '2024-01-15', rate_type: 'fixed', annual_rate: 5 });
  await H.req('PUT', `/api/properties/${ovEqPid}`, { amortization_years: 25 });
  const ovEqAmort = (await H.req('GET', `/api/properties/${ovEqPid}/amortization`)).data;
  const ovEqAfter = (await H.req('GET', '/api/overview/chart')).data;
  const ovEqAfterMap = new Map((ovEqAfter.propertyByMonth || []).map((p) => [p.month, p.value]));
  const ovEqRows = (ovEqAmort.series || []).filter((s) => s.month <= ovEqAfter.currentMonth);
  const ovEqM1 = ovEqRows.length > 6 ? ovEqRows[6].month : null;
  const ovEqM2 = ovEqRows.length > 18 ? ovEqRows[18].month : null;
  const ovEqBal = (m) => {
    let bal = 240000;
    for (const s of ovEqAmort.series || []) { if (s.month <= m) bal = s.balance; else break; }
    if (ovEqAmort.payoffMonth && ovEqAmort.payoffMonth <= m) bal = 0;
    return bal;
  };
  const ovEqAssessed = (m) => (Number(m.slice(0, 4)) >= 2025 ? 600000 : 500000);
  H.check('overview chart: a mortgaged property contributes assessed minus outstanding at two months where the balance moved',
    !!ovEqM1 && !!ovEqM2 && ovEqBal(ovEqM2) < ovEqBal(ovEqM1)
      && Math.abs((ovEqAfterMap.get(ovEqM1) - (ovBefore.get(ovEqM1) || 0)) - (ovEqAssessed(ovEqM1) - ovEqBal(ovEqM1))) < 0.011
      && Math.abs((ovEqAfterMap.get(ovEqM2) - (ovBefore.get(ovEqM2) || 0)) - (ovEqAssessed(ovEqM2) - ovEqBal(ovEqM2))) < 0.011,
    JSON.stringify({ m1: ovEqM1, m2: ovEqM2, bal1: ovEqM1 && ovEqBal(ovEqM1), bal2: ovEqM2 && ovEqBal(ovEqM2) }));
  r = await H.req('DELETE', `/api/properties/${ovEqPid}`);
  H.check('overview chart: equity fixture cleaned up', r.status === 200);
  // Account defaults derive from the holdings; a stored
  // setting beats the derivation; Auto restores it.
  r = await H.req('GET', `/api/investments/accounts/${invRsuId}`);
  H.check('investments: an all-USD account page opens in USD by derivation',
    r.data.display === 'USD' && r.data.defaultCurrency === 'USD', JSON.stringify({ d: r.data.display, dc: r.data.defaultCurrency }));
  r = await H.req('GET', `/api/investments/accounts/${invTfsaId}`);
  H.check('investments: an all-CAD account page opens in CAD by derivation',
    r.data.display === 'CAD' && r.data.defaultCurrency === 'CAD', JSON.stringify({ d: r.data.display, dc: r.data.defaultCurrency }));
  r = await H.req('PUT', `/api/investments/accounts/${invRsuId}`, { defaultCurrency: 'CAD' });
  H.check('investments: a stored default currency is accepted', r.status === 200 && r.data.default_currency === 'CAD', JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${invRsuId}`);
  H.check('investments: a stored CAD default beats USD holdings',
    r.data.display === 'CAD' && r.data.defaultCurrency === 'CAD', JSON.stringify({ d: r.data.display, dc: r.data.defaultCurrency }));
  r = await H.req('PUT', `/api/investments/accounts/${invRsuId}`, { defaultCurrency: 'EUR' });
  H.check('investments: an unknown default currency is a 400', r.status === 400, JSON.stringify(r.data));
  await H.req('PUT', `/api/investments/accounts/${invRsuId}`, { defaultCurrency: '' });
  r = await H.req('GET', `/api/investments/accounts/${invRsuId}`);
  H.check('investments: Auto restores the derived USD default',
    r.data.display === 'USD' && r.data.defaultCurrency === 'USD', JSON.stringify({ d: r.data.display, dc: r.data.defaultCurrency }));
  // A mixed-currency account falls back to CAD (created and
  // removed here so later portfolio totals are untouched).
  r = await H.req('POST', '/api/investments/accounts', { name: 'Mixed Display', type: 'Other' });
  const invMixedId = r.data.id;
  await H.req('POST', `/api/investments/accounts/${invMixedId}/holdings`, { label: 'Cad Bit', kind: 'fund', currency: 'CAD' });
  await H.req('POST', `/api/investments/accounts/${invMixedId}/holdings`, { label: 'Usd Bit', kind: 'fund', currency: 'USD' });
  r = await H.req('GET', `/api/investments/accounts/${invMixedId}`);
  H.check('investments: a mixed-currency account falls back to CAD',
    r.data.display === 'CAD' && r.data.defaultCurrency === 'CAD', JSON.stringify({ d: r.data.display, dc: r.data.defaultCurrency }));
  await H.req('DELETE', `/api/investments/accounts/${invMixedId}`);

  // ---------------------------------------------------------------
  // Contribution plans: salary-linked recurring buys on an RRSP
  // account — frequency from the job, employer match RRSP-only,
  // one buy per due period priced at the last NAV ≤ due date,
  // skipped periods listed, deleted periods never recreated,
  // and a linked job that cannot be deleted.
  // ---------------------------------------------------------------
  const vToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const step14 = (from, to) => {
    const out = [];
    let d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 14 * 86400000); }
    return out;
  };
  r = await H.req('POST', '/api/earnings/jobs', { employer: 'Plan Corp', province: 'BC', frequency: 'biweekly', gross_amount: 2000, gross_basis: 'period', tax_year: 2026 });
  const planJobId = r.data.id;
  H.check('plans: linked salary job created', r.status === 201 && !!planJobId, JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/accounts', { name: 'Plan RRSP', type: 'RRSP' });
  const planRrspId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${planRrspId}/holdings`, { label: 'Plan Fund', kind: 'fund', currency: 'CAD' });
  const planFundId = r.data.id;
  await H.req('POST', `/api/investments/holdings/${planFundId}/nav`, { date: '2025-12-31', price: 10 });
  const planDues = step14('2026-01-05', vToday);
  r = await H.req('POST', `/api/investments/accounts/${planRrspId}/plans`, { job_id: planJobId, target_holding_id: planFundId, start_date: '2026-01-05', own_amount: 100, employer_amount: 50 });
  const planId = r.data.id;
  H.check('plans: RRSP plan created and due periods generated at price 10',
    r.status === 201 && !!planId && r.data.frequency === 'biweekly' && r.data.employer === 'Plan Corp'
      && r.data.generated_count === planDues.length && r.data.own_total === 100 * planDues.length
      && r.data.employer_total === 50 * planDues.length && r.data.skipped.length === 0,
    JSON.stringify({ gen: r.data.generated_count, dues: planDues.length, own: r.data.own_total, emp: r.data.employer_total, skipped: r.data.skipped }));
  r = await H.req('GET', `/api/investments/holdings/${planFundId}`);
  const planEvents = r.data.events.filter((e) => e.source === 'plan');
  H.check('plans: one buy per due period, split columns on the event',
    planEvents.length === planDues.length && planEvents.every((e) => e.type === 'buy' && e.units === 15 && e.price === 10 && e.own_amount === 100 && e.employer_amount === 50),
    JSON.stringify(planEvents.slice(0, 2)));
  // TFSA rejects an employer match; a holding from another account is rejected too.
  r = await H.req('POST', `/api/investments/accounts/${invTfsaId}/plans`, { job_id: planJobId, target_holding_id: planFundId, start_date: '2026-01-05', own_amount: 100, employer_amount: 50 });
  H.check('plans: employer amount on a TFSA account is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/${planRrspId}/plans`, { job_id: planJobId, target_holding_id: invXqqId, start_date: '2026-01-05', own_amount: 100 });
  H.check('plans: a target holding from another account is a 400', r.status === 400, JSON.stringify(r.data));
  // Skipped periods: a holding with no price at all generates nothing and lists every due period.
  r = await H.req('POST', `/api/investments/accounts/${planRrspId}/holdings`, { label: 'Unpriced Fund', kind: 'fund', currency: 'CAD' });
  const planUnpricedId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${planRrspId}/plans`, { job_id: planJobId, target_holding_id: planUnpricedId, start_date: '2026-01-05', own_amount: 100 });
  const planSkipId = r.data.id;
  H.check('plans: periods with no price are skipped, never guessed',
    r.status === 201 && r.data.generated_count === 0 && r.data.skipped.length === planDues.length
      && r.data.skipped.every((s) => s.reason === 'no price on or before this date'),
    JSON.stringify({ skipped: (r.data.skipped || []).length, dues: planDues.length }));
  // Deleted period: delete one generated buy, regenerate, and it must not come back.
  const doomedPlanEvent = planEvents[0];
  await H.req('DELETE', `/api/investments/events/${doomedPlanEvent.id}`);
  r = await H.req('POST', `/api/investments/plans/${planId}/generate`, {});
  const afterDel = (await H.req('GET', `/api/investments/holdings/${planFundId}`)).data.events.filter((e) => e.source === 'plan');
  H.check('plans: a deleted generated period is never recreated',
    r.data.generation.created.length === 0 && afterDel.length === planDues.length - 1
      && !afterDel.some((e) => e.date === doomedPlanEvent.date),
    JSON.stringify({ createdThisRun: r.data.generation.created.length, left: afterDel.length }));
  // Frequency follows the job: biweekly -> monthly moves the plan's read frequency.
  await H.req('PUT', `/api/earnings/jobs/${planJobId}`, { employer: 'Plan Corp', province: 'BC', frequency: 'monthly', gross_amount: 2000, gross_basis: 'period', tax_year: 2026 });
  r = await H.req('GET', `/api/investments/accounts/${planRrspId}/plans`);
  const planAfterFreq = (r.data.plans || []).find((p) => p.id === planId);
  H.check('plans: frequency follows the linked job',
    planAfterFreq && planAfterFreq.frequency === 'monthly' && planAfterFreq.frequency_label === 'Monthly',
    JSON.stringify(planAfterFreq));
  // A job with linked plans cannot be deleted.
  r = await H.req('DELETE', `/api/earnings/jobs/${planJobId}`);
  H.check('plans: deleting a job with linked plans is a 400', r.status === 400 && /contribution plan/.test(r.data.error || ''), JSON.stringify(r.data));
  // Cleanup: plans, then the job, then the account.
  await H.req('DELETE', `/api/investments/plans/${planId}`);
  await H.req('DELETE', `/api/investments/plans/${planSkipId}`);
  r = await H.req('DELETE', `/api/earnings/jobs/${planJobId}`);
  H.check('plans: job deletes once its plans are gone', r.status === 200, JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/investments/accounts/${planRrspId}`);
  H.check('plans: RRSP fixture account cleaned up', r.status === 200, JSON.stringify(r.data));

  r = await H.req('GET', `/api/investments/holdings/${invFundId}`);
  H.check('investments: the fund rides its manual NAV snapshots',
    r.data.priceStatus.pricedBy === 'manual' && r.data.summary.value === 3200
      && r.data.summary.contributions === 3000 && r.data.summary.totalReturn === 200
      && r.data.summary.latestPrice === 32, JSON.stringify(r.data.summary));
  r = await H.req('POST', `/api/investments/holdings/${invFundId}/nav`, { date: '2026-03-31', price: 33 });
  const invNav3Id = r.data.id;
  r = await H.req('GET', `/api/investments/holdings/${invFundId}`);
  H.check('investments: a newer NAV moves the value', r.data.summary.value === 3300, JSON.stringify(r.data.summary));
  r = await H.req('DELETE', `/api/investments/prices/${invNav3Id}`);
  r = await H.req('GET', `/api/investments/holdings/${invFundId}`);
  H.check('investments: deleting the NAV snapshot restores the earlier value',
    r.status === 200 && r.data.summary.value === 3200, JSON.stringify(r.data.summary));

  // NAV inline edit + occupied-date guard. The block restores the
  // fund's snapshots exactly, so later totals are unaffected.
  r = await H.req('POST', `/api/investments/holdings/${invFundId}/nav`, { date: '2026-02-28', price: 33 });
  H.check('investments: Add on an occupied date no longer silently overwrites', r.status === 400, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/holdings/${invFundId}`);
  H.check('investments: the blocked Add left the original snapshot untouched',
    r.data.navPoints.find((p) => p.date === '2026-02-28').price === 32, JSON.stringify(r.data.navPoints));
  r = await H.req('POST', `/api/investments/holdings/${invFundId}/nav`, { date: '2026-02-28', price: 33, overwrite: true });
  H.check('investments: the AI-Apply overwrite flag still replaces (a checked conflict row)',
    r.status === 201 && r.data.price === 33, JSON.stringify(r.data));
  const invNavFebId = r.data.id;
  r = await H.req('PUT', `/api/investments/prices/${invNavFebId}`, { date: '2026-02-28', price: 32.1234 });
  H.check('investments: NAV edit changes the value at full precision', r.status === 200 && r.data.price === 32.1234, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/holdings/${invFundId}`);
  H.check('investments: the edited NAV reads back at full precision, not the 2dp display',
    r.data.navPoints.find((p) => p.date === '2026-02-28').price === 32.1234, JSON.stringify(r.data.navPoints));
  r = await H.req('PUT', `/api/investments/prices/${invNavFebId}`, { date: '2026-01-31', price: 32.1234 });
  H.check('investments: NAV edit onto an occupied date is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/investments/prices/${invNavFebId}`, { date: '2026-03-31', price: 32.1234 });
  H.check('investments: NAV edit moves the date (no stranded old row)', r.status === 200 && r.data.date === '2026-03-31', JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/holdings/${invFundId}`);
  H.check('investments: after the date move the old date is gone and the new date holds the value',
    !r.data.navPoints.find((p) => p.date === '2026-02-28') && r.data.navPoints.find((p) => p.date === '2026-03-31').price === 32.1234,
    JSON.stringify(r.data.navPoints));
  r = await H.req('PUT', '/api/investments/prices/999999', { date: '2026-03-31', price: 1 });
  H.check('investments: NAV edit of a missing point is a 404', r.status === 404, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/investments/prices/${invNavFebId}`, { date: '2026-02-28', price: 32 });
  H.check('investments: NAV snapshots restored after the edit checks', r.status === 200 && r.data.price === 32, JSON.stringify(r.data));

  // Dividend round trip: returns count it, value does not.
  r = await invEvent(invXqqId, { date: '2026-03-10', type: 'dividend', amount: 25 });
  const invDivId = r.data.id;
  r = await H.req('GET', `/api/investments/holdings/${invXqqId}`);
  H.check('investments: a dividend lands in return $ but not in value or contributions',
    r.data.summary.dividends === 25 && r.data.summary.totalReturn === 355
      && r.data.summary.value === 3300 && r.data.summary.contributions === 2970,
    JSON.stringify(r.data.summary));
  await H.req('DELETE', `/api/investments/events/${invDivId}`);
  r = await H.req('PUT', `/api/investments/events/${invXqqBuy1}`, { note: 'initial position' });
  H.check('investments: an event edit round-trips', r.status === 200 && r.data.note === 'initial position', JSON.stringify(r.data));

  // ---- account + portfolio levels ----
  r = await H.req('GET', `/api/investments/accounts/${invTfsaId}`);
  const tfsaJan = r.data.monthly.find((m) => m.month === '2026-01');
  H.check('investments: TFSA totals its three holdings (Stooq + manual NAV + Yahoo)',
    r.data.summary.value === 7130 && r.data.summary.contributions === 6570 && r.data.summary.totalReturn === 560
      && tfsaJan && tfsaJan.contributions === 5050 && tfsaJan.endValue === 5110 && tfsaJan.gain === 60,
    JSON.stringify({ sm: r.data.summary, tfsaJan }));
  H.check('investments: account holdings rows carry currency badges and price sources',
    r.data.holdings.length === 3
      && r.data.holdings.every((h) => h.holding.currency === 'CAD')
      && r.data.holdings.find((h) => h.holding.id === invHxqId).priceStatus.pricedBy === 'yahoo',
    JSON.stringify(r.data.holdings.map((h) => [h.holding.label, h.priceStatus.pricedBy])));

  r = await H.req('GET', '/api/investments');
  const pfJan = r.data.monthly.find((m) => m.month === '2026-01');
  H.check('investments: portfolio totals every account in CAD',
    r.data.summary.value === 10350 && r.data.summary.contributions === 9502.5 && r.data.summary.totalReturn === 847.5
      && r.data.summary.totalReturnPct === 8.92 && r.data.fxMissing === false && r.data.accounts.length === 3,
    JSON.stringify(r.data.summary));
  H.check('investments: portfolio January aggregates the accounts',
    pfJan && pfJan.contributions === 7422.5 && pfJan.endValue === 7450 && pfJan.gain === 27.5 && pfJan.returnPct === 0.37,
    JSON.stringify(pfJan));
  H.check('investments: portfolio series ends at the current total',
    r.data.series.length > 0 && r.data.series[r.data.series.length - 1].value === 10350,
    JSON.stringify(r.data.series.slice(-1)));

  r = await H.req('POST', '/api/investments/refresh');
  H.check('investments: manual refresh re-fetches the exchange holdings (incl. the Yahoo one)',
    r.status === 200 && [invXqqId, invAaplId, invHxqId].every((id) => r.data.refreshed.includes(id)),
    JSON.stringify(r.data));
  H.check('investments: refresh results name the source per holding',
    Array.isArray(r.data.results)
      && r.data.results.find((x) => x.id === invXqqId && x.ok === true && x.source === 'stooq')
      && r.data.results.find((x) => x.id === invHxqId && x.ok === true && x.source === 'yahoo'),
    JSON.stringify(r.data.results));

  // Refresh failures are loud: a symbol neither tier knows
  // (Stooq "No data", Yahoo 404) reports its verbatim error
  // in the refresh results and in the holding's price status.
  r = await H.req('POST', '/api/investments/accounts', { name: 'FailRefresh', type: 'Other' });
  const invFailAcctId = r.data.id;
  r = await invPost(invFailAcctId, { label: 'Zed Fail', kind: 'exchange', symbol: 'ZZFAIL.TO', currency: 'CAD' });
  const invZzId = r.data.id;
  r = await H.req('POST', '/api/investments/refresh');
  const zzRes = (r.data.results || []).find((x) => x.id === invZzId);
  H.check('investments: a refresh failure names the holding and the verbatim upstream error',
    r.status === 200 && zzRes && zzRes.ok === false && /404/.test(zzRes.error || '')
      && !r.data.refreshed.includes(invZzId),
    JSON.stringify({ zzRes, refreshed: r.data.refreshed }));
  r = await H.req('GET', `/api/investments/accounts/${invFailAcctId}`);
  const zzRow = (r.data.holdings || []).find((h) => h.holding.id === invZzId);
  H.check('investments: a failed-today fetch surfaces in the holding price status',
    zzRow && zzRow.priceStatus.fetchFailedToday === true && /404/.test(zzRow.priceStatus.lastError || '')
      && !!zzRow.priceStatus.lastAttemptAt,
    JSON.stringify(zzRow && zzRow.priceStatus));
  await H.req('DELETE', `/api/investments/accounts/${invFailAcctId}`);

  // Nasdaq third tier: a symbol neither Stooq ("No data") nor
  // Yahoo (404) knows refreshes successfully via the Nasdaq
  // stub, and the holding reports source nasdaq end to end.
  r = await H.req('POST', '/api/investments/accounts', { name: 'NasdaqTier', type: 'Other' });
  const invNtestAcctId = r.data.id;
  r = await invPost(invNtestAcctId, { label: 'Nadaq Test', kind: 'exchange', symbol: 'NTEST', currency: 'CAD' });
  const invNtestId = r.data.id;
  r = await invEvent(invNtestId, { date: '2026-01-05', type: 'buy', units: 10, price: 48 });
  H.check('investments: nasdaq tier holding + buy event created', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/refresh');
  const ntestRes = (r.data.results || []).find((x) => x.id === invNtestId);
  H.check('investments: refresh via nasdaq tier when stooq and yahoo are empty',
    r.status === 200 && ntestRes && ntestRes.ok === true && ntestRes.source === 'nasdaq',
    JSON.stringify(ntestRes));
  r = await H.req('GET', `/api/investments/holdings/${invNtestId}`);
  H.check('investments: nasdaq-priced holding values at the nasdaq close',
    r.data.summary.value === 550 && r.data.summary.contributions === 480 && r.data.summary.totalReturn === 70
      && r.data.summary.latestPrice === 55 && r.data.summary.latestPriceSource === 'nasdaq'
      && r.data.priceStatus.pricedBy === 'nasdaq',
    JSON.stringify({ sm: r.data.summary, ps: r.data.priceStatus }));
  await H.req('DELETE', `/api/investments/accounts/${invNtestAcctId}`);

  // Account edit + delete round trip on a scratch account.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Scratch', type: 'Other' });
  const invScratchId = r.data.id;
  r = await H.req('PUT', `/api/investments/accounts/${invScratchId}`, { name: 'Scratch Renamed' });
  H.check('investments: account rename round-trips', r.status === 200 && r.data.name === 'Scratch Renamed', JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/investments/accounts/${invScratchId}`);
  r = await H.req('GET', `/api/investments/accounts/${invScratchId}`);
  H.check('investments: a deleted account is a 404', r.status === 404, JSON.stringify(r.data));

  // ---- security search + atomic initial transactions ----
  r = await H.req('GET', '/api/invest/search?q=XQQ');
  H.check('invest search: XQQ returns the TSX candidate as CAD and the NASDAQ one as USD',
    r.status === 200 && Array.isArray(r.data.results)
      && r.data.results.some((c) => c.symbol === 'XQQ.TO' && c.currency === 'CAD' && /Toronto/.test(c.exchange || ''))
      && r.data.results.some((c) => c.symbol === 'QQQ' && c.currency === 'USD'),
    JSON.stringify(r.data));
  r = await H.req('GET', '/api/invest/search?q=ZZFAIL');
  H.check('invest search: an upstream failure degrades to an empty list, never a 500',
    r.status === 200 && Array.isArray(r.data.results) && r.data.results.length === 0,
    JSON.stringify({ status: r.status, data: r.data }));

  // A scratch account, removed afterwards so the portfolio
  // totals the browser flow asserts stay untouched.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Batch', type: 'Other' });
  const invBatchAcctId = r.data.id;
  r = await invPost(invBatchAcctId, { label: 'Apple batch', kind: 'exchange', symbol: 'AAPL', currency: 'USD', events: [
    { date: '2026-01-15', type: 'buy', units: 10, price: 190 },
    { date: '2026-02-10', type: 'sell', units: 4, price: 205 },
  ] });
  const invBatchId = r.data.id;
  H.check('investments: a holding is created together with its initial transactions',
    r.status === 201 && !!invBatchId, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/holdings/${invBatchId}?display=CAD`);
  const batchJan = r.data.monthly.find((m) => m.month === '2026-01');
  const batchFeb = r.data.monthly.find((m) => m.month === '2026-02');
  H.check('investments: batch events price like detail-page events (buy 10 @190, sell 4 @205; FX 1.30/1.40)',
    r.data.events.length === 2
      && batchJan && batchJan.contributions === 2470 && batchJan.endValue === 2600 && batchJan.gain === 130
      && batchFeb && batchFeb.contributions === -1148 && batchFeb.endValue === 1764 && batchFeb.gain === 312,
    JSON.stringify({ events: r.data.events.length, batchJan, batchFeb }));
  // Atomicity: one bad row (a sell the batch has not covered)
  // fails the whole creation and leaves no holding behind.
  r = await invPost(invBatchAcctId, { label: 'Bad batch', kind: 'exchange', symbol: 'AAPL', currency: 'USD', events: [
    { date: '2026-01-15', type: 'buy', units: 10, price: 190 },
    { date: '2026-01-16', type: 'sell', units: 99, price: 190 },
  ] });
  H.check('investments: a bad initial row is a 400 for the whole creation', r.status === 400, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${invBatchAcctId}`);
  H.check('investments: the failed batch left no half-created holding behind',
    r.data.holdings.length === 1 && r.data.holdings[0].holding.id === invBatchId,
    JSON.stringify(r.data.holdings.map((h) => h.holding.label)));
  await H.req('DELETE', `/api/investments/accounts/${invBatchAcctId}`);
  r = await H.req('GET', '/api/investments');
  H.check('investments: batch-account cleanup restores the portfolio total',
    r.data.summary.value === 10350, JSON.stringify(r.data.summary));

  // ---- account-page AI fill chat (stub LLM), two rounds ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'I found the VFV purchase on the statement. One question before I draft the Scotia fund: is the Scotia NASDAQ Index Fund denominated in CAD or USD?',
    proposed: {
      holdings: [{ ref: 'h1', label: 'VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD' }],
      events: [{ holdingRef: 'h1', date: '2026-03-05', type: 'buy', units: 10, price: 150 }],
    },
    ready: false,
  }));
  r = await H.req('POST', '/api/ai/invest-fill-chat', {
    accountId: invTfsaId,
    text: 'Statement: bought 10 VFV.TO on Mar 5 at 150. Also hold the Scotia NASDAQ Index Fund.',
  });
  H.check('investments AI: round 1 drafts VFV and asks the fund currency instead of guessing',
    r.status === 200 && r.data.proposed.holdings.length === 1 && r.data.proposed.holdings[0].symbol === 'VFV.TO'
      && /CAD or USD/.test(r.data.reply) && r.data.ready === false, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Added the Scotia NASDAQ Index Fund as a CAD fund with its first purchase.',
    proposed: {
      holdings: [
        { ref: 'h1', label: 'VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD' },
        { ref: 'h2', label: 'Scotia NASDAQ Index Fund', kind: 'fund', currency: 'CAD' },
      ],
      events: [
        { holdingRef: 'h1', date: '2026-03-05', type: 'buy', units: 10, price: 150 },
        { holdingRef: 'h2', date: '2026-03-05', type: 'buy', units: 50, price: 40 },
      ],
    },
    ready: true,
  }));
  const invChatRound2 = {
    accountId: invTfsaId,
    history: [
      { role: 'user', content: 'Statement: bought 10 VFV.TO…' },
      { role: 'assistant', content: '…is the Scotia NASDAQ Index Fund denominated in CAD or USD?' },
    ],
    text: 'It is CAD. First purchase was 50 units on Mar 5 at 40.',
    proposed: {
      holdings: [{ ref: 'h1', label: 'VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD' }],
      events: [{ holdingRef: 'h1', date: '2026-03-05', type: 'buy', units: 10, price: 150 }],
    },
  };
  r = await H.req('POST', '/api/ai/invest-fill-chat', invChatRound2);
  H.check('investments AI: round 2 completes the draft with both holdings and events',
    r.status === 200 && r.data.ready === true && r.data.proposed.holdings.length === 2
      && r.data.proposed.events.length === 2 && r.data.proposed.holdings[1].kind === 'fund',
    JSON.stringify(r.data));
  // Sell-heavy statement: a sale printed as negative units, a
  // sale with only a total, and one sale that matches no
  // holding — the first two must survive as sell proposals
  // (the second with a derived price and flag), the third must
  // be reported in dropped, not lost silently.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Found the sales. One sale could not be matched to a holding.',
    proposed: {
      holdings: [{ ref: 'h1', label: 'VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD' }],
      events: [
        { holdingRef: 'h1', date: '2026-03-10', type: 'sell', units: -50, price: 40 },
        { holdingRef: 'h1', date: '2026-03-11', type: 'sell', units: 20, amount: 1000 },
        { holdingId: 999999, date: '2026-03-12', type: 'sell', units: 5, price: 40 },
      ],
    },
    ready: true,
  }));
  r = await H.req('POST', '/api/ai/invest-fill-chat', { accountId: invTfsaId, text: 'Statement sales for VFV.' });
  H.check('investments AI: negative-unit and amount-only sales survive as sell proposals; an unmatched sale is reported in dropped',
    r.status === 200 && r.data.proposed.events.length === 2
      && r.data.proposed.events.every((e) => e.type === 'sell')
      && r.data.proposed.events[0].units === 50 && r.data.proposed.events[0].priceDerived === false
      && r.data.proposed.events[1].price === 50 && r.data.proposed.events[1].priceDerived === true
      && r.data.proposed.dropped.length === 1 && /matched/.test(r.data.proposed.dropped[0].reason),
    JSON.stringify(r.data.proposed));
  // Apply the way the panel does: holdings first, then their events.
  r = await H.req('POST', `/api/investments/accounts/${invTfsaId}/holdings`,
    { label: 'VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD', source: 'ai' });
  const invVfvId = r.data.id;
  H.check('investments AI: applied holding carries the ai source', r.status === 201 && r.data.source === 'ai', JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/${invTfsaId}/holdings`,
    { label: 'Scotia NASDAQ Index Fund', kind: 'fund', currency: 'CAD', source: 'ai' });
  const invScotiaFundId = r.data.id;
  await H.req('POST', `/api/investments/holdings/${invVfvId}/events`,
    { date: '2026-03-05', type: 'buy', units: 10, price: 150, source: 'ai' });
  r = await H.req('POST', `/api/investments/holdings/${invScotiaFundId}/events`,
    { date: '2026-03-05', type: 'buy', units: 50, price: 40, source: 'ai' });
  H.check('investments AI: applied event carries the ai source', r.status === 201 && r.data.source === 'ai', JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${invTfsaId}`);
  H.check('investments AI: after Apply the account totals include both new holdings',
    r.data.summary.value === 10630 && r.data.holdings.length === 5
      && r.data.holdings.find((h) => h.holding.id === invVfvId).holding.source === 'ai',
    JSON.stringify({ v: r.data.summary.value, n: r.data.holdings.length }));
  // Re-proposing what now exists flags the duplicates.
  // (The sell-heavy stub from the dropped-items round above is
  // replaced with the two-holding draft so this round sees
  // both applied holdings again.)
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Added the Scotia NASDAQ Index Fund as a CAD fund with its first purchase.',
    proposed: {
      holdings: [
        { ref: 'h1', label: 'VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD' },
        { ref: 'h2', label: 'Scotia NASDAQ Index Fund', kind: 'fund', currency: 'CAD' },
      ],
      events: [
        { holdingRef: 'h1', date: '2026-03-05', type: 'buy', units: 10, price: 150 },
        { holdingRef: 'h2', date: '2026-03-05', type: 'buy', units: 50, price: 40 },
      ],
    },
    ready: true,
  }));
  r = await H.req('POST', '/api/ai/invest-fill-chat', { accountId: invTfsaId, text: 'Add VFV again from this statement.' });
  H.check('investments AI: re-proposing an existing holding is flagged as a duplicate',
    r.status === 200 && r.data.proposed.holdings.length === 2
      && r.data.proposed.holdings.every((h) => h.conflict === 'duplicate-holding'),
    JSON.stringify(r.data.proposed && r.data.proposed.holdings));
  r = await H.req('POST', '/api/ai/invest-fill-chat', { accountId: 999999, text: 'x' });
  H.check('investments AI: an unknown account is a 404', r.status === 404, JSON.stringify(r.data));

  // ---- NAV snapshots + cost-unknown positions through Fill with AI ----
  // A fund statement's holdings section (units + NAV + market
  // value, no buy price anywhere) must propose NAV snapshots
  // and a position — never a buy at a NAV price.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Found the CIBC U.S. Index Fund on the statement: no buy prices are printed, so the units go in as a cost-unknown position with the two NAV snapshots.',
    proposed: {
      holdings: [{ ref: 'c1', label: 'CIBC U.S. Index Fund', kind: 'fund', currency: 'CAD' }],
      events: [{ holdingRef: 'c1', date: '2026-09-30', type: 'position', units: 695.5991, note: 'units derived: 65608.98 ÷ 94.3201' }],
      nav: [
        { holdingRef: 'c1', date: '2026-06-30', price: 92.0252 },
        { holdingRef: 'c1', date: '2026-09-30', price: 94.3201 },
      ],
    },
    ready: true,
  }));
  r = await H.req('POST', '/api/ai/invest-fill-chat', { accountId: invTfsaId, text: 'CIBC statement Sep 30: U.S. Index Fund 695.5991 units, NAV 94.3201, market value 65608.98; Jun 30 NAV 92.0252.' });
  H.check('investments AI: a holdings-only statement proposes NAV snapshots and a position, never a buy',
    r.status === 200 && r.data.proposed.nav.length === 2
      && r.data.proposed.events.length === 1 && r.data.proposed.events[0].type === 'position'
      && r.data.proposed.events[0].price == null && /65608.98 ÷ 94.3201/.test(r.data.proposed.events[0].note || '')
      && r.data.proposed.events.every((e) => e.type !== 'buy'),
    JSON.stringify(r.data.proposed));
  // Apply the way the panel does: holding, then its events, then its NAV snapshots.
  r = await H.req('POST', `/api/investments/accounts/${invTfsaId}/holdings`, { label: 'CIBC U.S. Index Fund', kind: 'fund', currency: 'CAD', source: 'ai' });
  const invCibcId = r.data.id;
  H.check('investments AI: applied NAV holding carries the ai source', r.status === 201 && r.data.source === 'ai', JSON.stringify(r.data));
  await H.req('POST', `/api/investments/holdings/${invCibcId}/events`, { date: '2026-09-30', type: 'position', units: 695.5991, note: 'units derived: 65608.98 ÷ 94.3201', source: 'ai' });
  await H.req('POST', `/api/investments/holdings/${invCibcId}/nav`, { date: '2026-06-30', price: 92.0252 });
  await H.req('POST', `/api/investments/holdings/${invCibcId}/nav`, { date: '2026-09-30', price: 94.3201 });
  r = await H.req('GET', `/api/investments/holdings/${invCibcId}`);
  H.check('investments AI: after Apply the holding has the position units, both NAVs, and the cost-unknown flag',
    r.data.summary.units === 695.5991 && r.data.summary.costUnknown === true
      && r.data.summary.valueNative === 65608.98 && r.data.summary.contributionsNative === 0
      && r.data.navPoints.length === 2,
    JSON.stringify({ summary: r.data.summary, nav: r.data.navPoints }));
  // Re-proposing the same NAV flags a duplicate; a corrected
  // price for the same date flags old → new. Both stay
  // unchecked in the panel (asserted in the browser pass).
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Same statement again, with a corrected June NAV.',
    proposed: {
      nav: [
        { holdingId: invCibcId, date: '2026-06-30', price: 92.0252 },
        { holdingId: invCibcId, date: '2026-06-30', price: 94.3201 },
      ],
    },
    ready: true,
  }));
  r = await H.req('POST', '/api/ai/invest-fill-chat', { accountId: invTfsaId, text: 'Same statement again, corrected Jun NAV.' });
  H.check('investments AI: a re-proposed NAV flags duplicate and corrected-price conflicts',
    r.status === 200 && r.data.proposed.nav.length === 2
      && r.data.proposed.nav[0].conflict === 'duplicate-nav'
      && r.data.proposed.nav[1].conflict === 'nav-differs' && r.data.proposed.nav[1].oldPrice === 92.0252,
    JSON.stringify(r.data.proposed.nav));

  // Package rule: a holdings-section draft pairs the position
  // with its NAVs in one round, and Apply writes both.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'CIBC NASDAQ statement: position plus two NAVs.',
    proposed: {
      holdings: [{ ref: 'h1', label: 'CIBC NASDAQ Index Fund', kind: 'fund', currency: 'CAD', fundCode: 'ATL8096' }],
      events: [{ holdingRef: 'h1', date: '2026-09-30', type: 'position', units: 462.8297, note: 'units derived: 85529.91 ÷ 184.7978' }],
      nav: [
        { holdingRef: 'h1', date: '2026-06-30', price: 183.3359 },
        { holdingRef: 'h1', date: '2026-09-30', price: 184.7978 },
      ],
    },
    ready: true,
  }));
  r = await H.req('POST', '/api/ai/invest-fill-chat', { accountId: invTfsaId, text: 'CIBC NASDAQ statement Sep 30: 462.8297 units, NAV 184.7978, market value 85529.91; Jun 30 NAV 183.3359.' });
  H.check('investments AI: a holdings-section draft pairs position with NAVs, never NAVs alone',
    r.status === 200 && r.data.proposed.events.length === 1 && r.data.proposed.events[0].type === 'position'
      && r.data.proposed.nav.length === 2 && r.data.proposed.events.every((e) => e.type !== 'buy'),
    JSON.stringify(r.data.proposed));
  r = await H.req('POST', `/api/investments/accounts/${invTfsaId}/holdings`, { label: 'CIBC NASDAQ Index Fund', kind: 'fund', currency: 'CAD', fundCode: 'ATL8096', source: 'ai' });
  const invNasdaqId = r.data.id;
  await H.req('POST', `/api/investments/holdings/${invNasdaqId}/events`, { date: '2026-09-30', type: 'position', units: 462.8297, note: 'units derived: 85529.91 ÷ 184.7978', source: 'ai' });
  await H.req('POST', `/api/investments/holdings/${invNasdaqId}/nav`, { date: '2026-06-30', price: 183.3359 });
  await H.req('POST', `/api/investments/holdings/${invNasdaqId}/nav`, { date: '2026-09-30', price: 184.7978 });
  r = await H.req('GET', `/api/investments/holdings/${invNasdaqId}`);
  H.check('investments AI: applied position + NAVs value the holding at the statement market value',
    r.data.summary.units === 462.8297 && r.data.summary.valueNative === 85529.91 && r.data.summary.costUnknown === true,
    JSON.stringify(r.data.summary));
  await H.req('DELETE', `/api/investments/holdings/${invNasdaqId}`);

  // Synthetic Wealthsimple fixture shared by the CSV import API
  // round below and the browser round inside the investments
  // browser block (the user's real export never appears here).
  const WS_H = ['effective_date', 'effective_time', 'settlement_date', 'account_id', 'account_type', 'activity_type', 'activity_sub_type', 'description', 'direction', 'symbol', 'name', 'currency', 'quantity', 'unit_price', 'commission', 'net_cash_amount'];
  const wsLine = (o) => WS_H.map((c) => o[c] ?? '').join(',');
  S.wsFixture = [WS_H.join(','), wsLine({ effective_date: '2026-01-05', activity_type: 'Trade', activity_sub_type: 'BUY', symbol: 'XQQ', name: 'XQQ fund', currency: 'CAD', quantity: '100', unit_price: '50', commission: '0', net_cash_amount: '-5000' }),
    wsLine({ effective_date: '2026-01-06', activity_type: 'Trade', activity_sub_type: 'SELL', symbol: 'XQQ', name: 'XQQ fund', currency: 'CAD', quantity: '-40', unit_price: '60', commission: '0', net_cash_amount: '2400' }),
    wsLine({ effective_date: '2026-01-07', activity_type: 'Dividend', activity_sub_type: '-', symbol: 'XQQ', name: 'XQQ fund', currency: 'CAD', quantity: '12.5', net_cash_amount: '12.5' }),
    wsLine({ effective_date: '2026-01-08', activity_type: 'CorporateAction', activity_sub_type: 'SUBDIVISION', symbol: 'XQQ', name: 'XQQ fund', currency: '', quantity: '120' }),
    wsLine({ effective_date: '2026-01-09', activity_type: 'Trade', activity_sub_type: 'BUY', symbol: 'XQQ', name: 'XQQ fund', currency: 'CAD', quantity: '10', unit_price: '55', commission: '0', net_cash_amount: '-550' }),
    wsLine({ effective_date: '2026-01-10', activity_type: 'MoneyMovement', activity_sub_type: 'EFT', currency: 'CAD', net_cash_amount: '1000' }),
    wsLine({ effective_date: '2026-01-11', activity_type: 'Trade', activity_sub_type: 'SELL', symbol: 'XQQ', name: 'XQQ fund', currency: 'CAD', quantity: '-9999', unit_price: '55', commission: '0', net_cash_amount: '549945' }),
    wsLine({ effective_date: '2026-01-12', activity_type: 'Trade', activity_sub_type: 'BUY', symbol: 'VFV', name: 'VFV fund', currency: 'CAD', quantity: '5', unit_price: '100', commission: '0', net_cash_amount: '-500' })].join('\n');

  // ---- browser pass over the three levels ----
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('investments browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardI = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: H.PORT, path: rq.url, method: rq.method, headers: rq.headers },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        }
      );
      rr.on('error', reject);
      if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
      rr.end();
    });
    const loginResI = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueI = loginResI.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserI = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserI.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardI({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueI, domain: 'ff.local', path: '/', httpOnly: true });
      const waitI = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const overviewText = await page.evaluate(() => document.querySelector('#section-investments').textContent);
      H.check('investments UI: the overview lists the accounts and the CAD portfolio total (AI-applied holdings included)',
        overviewText.includes('TFSA') && overviewText.includes('Employer RSU') && overviewText.includes('13,850'),
        overviewText.slice(0, 300));
      // Stocks rename + the list head's geometry standard (the
      // Properties par: 16px of vertical padding, content edges
      // at +17 for the panels' 1px border + 16px padding).
      const headGeom = await page.evaluate(() => {
        const R = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const head = document.querySelector('#section-investments .section-head');
        const title = head.querySelector('h2');
        const btn = document.querySelector('#addInvestAccountBtn');
        const refreshBtn = document.querySelector('#refreshInvestBtn');
        const strip = document.querySelector('#section-investments .summary-strip');
        const card = strip.querySelector('.summary-card');
        const panel = document.querySelector('#section-investments .panel');
        const cards = panel.querySelector('.cards');
        return {
          title: title.textContent.trim(),
          nav: document.querySelector('#assetsNav a[data-section="investments"]').textContent.trim(),
          titleLeftDelta: Math.abs(R(title).left - (R(card).left + 17)),
          btnRightDelta: Math.abs(R(btn).right - (R(panel).right - 17)),
          btnTopGap: R(btn).top - R(head).top,
          headStripGap: R(strip).top - R(btn).bottom,
          cardsBottomDelta: Math.abs((R(panel).bottom - 17) - R(cards).bottom),
          refreshH: R(refreshBtn).bottom - R(refreshBtn).top,
          addH: R(btn).bottom - R(btn).top,
        };
      });
      H.check('investments UI: Refresh prices matches Add account height in the Stocks head row',
        Math.abs(headGeom.refreshH - headGeom.addH) <= 1,
        JSON.stringify({ refreshH: headGeom.refreshH, addH: headGeom.addH }));
      H.check('investments UI: the module reads "Stocks" and its head band meets the 16/17 padding standard',
        headGeom.title === 'Stocks' && headGeom.nav === 'Stocks'
          && headGeom.titleLeftDelta <= 3 && headGeom.btnRightDelta <= 3
          && Math.abs(headGeom.btnTopGap - 16) <= 3 && Math.abs(headGeom.headStripGap - 16) <= 3
          && headGeom.cardsBottomDelta <= 3,
        JSON.stringify(headGeom));
      // Account page: the head toolbar lines up the same way and
      // its breadcrumb names the module "Stocks".
      await page.goto(`http://ff.local/#invest-account/${invTfsaId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const acctGeom = await page.evaluate(() => {
        const R = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
        const bar = document.querySelector('#view-invest-account > .toolbar');
        const link = bar.querySelector('a');
        const panel = document.querySelector('#view-invest-account .panel');
        const del = document.querySelector('#deleteInvestAccountBtn');
        return {
          back: link.textContent.replace(/\s+/g, ' ').trim(),
          leftDelta: Math.abs(R(link).left - (R(panel).left + 17)),
          rightDelta: Math.abs(R(del).right - (R(panel).right - 17)),
        };
      });
      H.check('investments UI: the account page head lines up with its panels and points back to Stocks',
        acctGeom.back.includes('Back to Stocks') && acctGeom.leftDelta <= 3 && acctGeom.rightDelta <= 3,
        JSON.stringify(acctGeom));
      // Account owners: the modal picker, the portfolio card, and
      // the account page header all show the same owner chips.
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('#addInvestAccountBtn');
      await page.waitForFunction(() => !document.querySelector('#investAccountModal').classList.contains('hidden'), { timeout: 10000 });
      await page.type('#investAccountForm input[name=name]', 'Owner Browser TFSA');
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('#investAccountOwnerPicker .owner-candidate')]
          .find((b) => b.textContent.includes('Shawn'));
        if (btn) btn.click();
      });
      await page.click('#investAccountForm button[type=submit]');
      await waitI(800);
      const ownerOnPage = await page.evaluate(() => document.querySelector('#investAccountTitle').textContent);
      H.check('investments UI: picking an owner in the modal shows the chip on the account page',
        ownerOnPage.includes('Shawn'), ownerOnPage.slice(0, 200));
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const ownerOnCard = await page.evaluate(() => document.querySelector('#section-investments').textContent);
      H.check('investments UI: the portfolio card shows the account owner',
        ownerOnCard.includes('Owner Browser TFSA') && ownerOnCard.includes('Shawn'), ownerOnCard.slice(0, 300));
      // Edit the account back to no owner via the picker chip's ×.
      const ownerAccId = await page.evaluate(async () => {
        const d = await (await fetch('/api/investments')).json();
        return d.accounts.find((a) => a.account.name === 'Owner Browser TFSA').account.id;
      });
      await page.goto(`http://ff.local/#invest-account/${ownerAccId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('#editInvestAccountBtn');
      await page.waitForFunction(() => !document.querySelector('#investAccountModal').classList.contains('hidden'), { timeout: 10000 });
      await page.evaluate(() => {
        const x = document.querySelector('#investAccountOwnerPicker [data-owner-remove]');
        if (x) x.click();
      });
      await page.click('#investAccountForm button[type=submit]');
      await waitI(800);
      const ownerCleared = await page.evaluate(() => document.querySelector('#investAccountTitle').textContent);
      H.check('investments UI: removing the owner in edit clears the chip',
        !ownerCleared.includes('Shawn'), ownerCleared.slice(0, 200));
      await page.evaluate(async () => {
        const d = await (await fetch('/api/investments')).json();
        const a = d.accounts.find((x) => x.account.name === 'Owner Browser TFSA');
        if (a) await fetch(`/api/investments/accounts/${a.account.id}`, { method: 'DELETE' });
      });
      // Back to the seeded account page: the holding flow below
      // assumes the page is on invTfsaId, not the deleted account.
      await page.goto(`http://ff.local/#invest-account/${invTfsaId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      // Add holding through the security autocomplete: type XQQ,
      // pick the TSX candidate, then submit a buy row and a sell
      // row as initial transactions.
      await page.click('#addHoldingBtn');
      await page.waitForFunction(() => !document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 10000 });
      await page.type('#investHoldingForm [name="symbol"]', 'XQQ');
      await page.waitForSelector('#investHoldingForm [data-symbol-suggest] li', { visible: true, timeout: 10000 });
      const firstCandidate = await page.evaluate(() =>
        document.querySelector('#investHoldingForm [data-symbol-suggest] li').textContent.replace(/\s+/g, ' ').trim());
      await page.click('#investHoldingForm [data-symbol-suggest] li');
      const filled = await page.evaluate(() => {
        const f = document.querySelector('#investHoldingForm');
        return {
          label: f.elements.label.value, symbol: f.elements.symbol.value,
          kind: f.elements.kind.value, currency: f.elements.currency.value,
        };
      });
      H.check('investments UI: picking the XQQ.TO candidate auto-fills label, symbol, kind and CAD currency',
        firstCandidate.includes('XQQ.TO') && filled.symbol === 'XQQ.TO'
          && filled.label.includes('iShares') && filled.kind === 'exchange' && filled.currency === 'CAD',
        JSON.stringify({ firstCandidate, filled }));
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#investHoldingForm [data-init-row]');
        const set = (row, f, v) => { row.querySelector(`[data-f="${f}"]`).value = v; };
        set(rows[0], 'date', '2026-01-15'); set(rows[0], 'units', '10'); set(rows[0], 'price', '150');
      });
      await page.click('#investHoldingForm [data-add-init-row]');
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#investHoldingForm [data-init-row]');
        const set = (row, f, v) => { row.querySelector(`[data-f="${f}"]`).value = v; };
        set(rows[1], 'type', 'sell'); set(rows[1], 'date', '2026-02-10'); set(rows[1], 'units', '4'); set(rows[1], 'price', '155');
      });
      await page.click('#investHoldingForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 15000 });
      r = await H.req('GET', `/api/investments/accounts/${invTfsaId}`);
      const uiRow = r.data.holdings.find((h) => h.holding.label === 'iShares NASDAQ 100 Index ETF');
      H.check('investments UI: the submitted holding exists with its two initial events',
        !!uiRow && uiRow.events.length === 2,
        JSON.stringify(r.data.holdings.map((h) => h.holding.label)));
      if (uiRow) {
        r = await H.req('GET', `/api/investments/holdings/${uiRow.holding.id}`);
        const uiJan = r.data.monthly.find((m) => m.month === '2026-01');
        const uiFeb = r.data.monthly.find((m) => m.month === '2026-02');
        const timeline = r.data.events.map((e) => `${e.date}:${e.type}`).join(' ');
        H.check('investments UI: the holding timeline and monthly figures match the two submitted rows',
          r.data.events.length === 2 && timeline.includes('2026-01-15:buy') && timeline.includes('2026-02-10:sell')
            && uiJan && uiJan.contributions === 1500 && uiJan.endValue === 1400 && uiJan.gain === -100
            && uiFeb && uiFeb.contributions === -620 && uiFeb.endValue === 900 && uiFeb.gain === 120,
          JSON.stringify({ timeline, uiJan, uiFeb }));
      }
      // The pure-manual path: a bank fund typed freehand, no
      // dropdown pick, no event rows — still creates fine.
      await page.click('#addHoldingBtn');
      await page.waitForFunction(() => !document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 10000 });
      await page.type('#investHoldingForm [name="label"]', 'CIBC Canadian Index Fund');
      await page.evaluate(() => { document.querySelector('#investHoldingForm').elements.kind.value = 'fund'; });
      await waitI(600); // let the (empty) search round-trip settle; no pick is made
      await page.click('#investHoldingForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 15000 });
      r = await H.req('GET', `/api/investments/accounts/${invTfsaId}`);
      const fundRow = r.data.holdings.find((h) => h.holding.label === 'CIBC Canadian Index Fund' && h.holding.source === 'manual');
      H.check('investments UI: a bank fund created fully manually (no pick, no rows) lands with no events',
        !!fundRow && fundRow.holding.kind === 'fund' && fundRow.events.length === 0,
        JSON.stringify(fundRow && fundRow.holding));
      await page.goto(`http://ff.local/#invest-account/${invRsuId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const rsuPage = await page.evaluate(() => ({
        text: document.querySelector('#view-invest-account').textContent,
        usdBadges: document.querySelectorAll('#view-invest-account .badge.usd').length,
        aiPanel: !!document.querySelector('#investAiFill'),
      }));
      H.check('investments UI: the RSU account page shows the holding with a USD badge and the AI panel',
        rsuPage.text.includes('Acme Corp') && rsuPage.usdBadges >= 1 && rsuPage.aiPanel,
        JSON.stringify({ usdBadges: rsuPage.usdBadges, aiPanel: rsuPage.aiPanel }));
      await page.goto(`http://ff.local/#invest-holding/${invHxqId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const hxqText = await page.evaluate(() => document.querySelector('#view-invest-holding').textContent);
      H.check('investments UI: the HXQ holding page names Yahoo Finance as its price source',
        hxqText.includes('Yahoo Finance'), hxqText.slice(0, 300));
      // The trade-price fallback banner splits by kind: an
      // exchange holding names its own ticker and must NOT get
      // the bank-fund NAV advice; a fund with no NAV snapshots
      // keeps the NAV wording.
      await page.goto(`http://ff.local/#invest-holding/${invAcmeId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const acmeNote = await page.evaluate(() => document.querySelector('#investHoldingPriceNote').textContent);
      H.check('investments UI: an exchange holding on trade prices gets a banner naming its symbol, no bank-fund advice',
        acmeNote.includes('No market feed found for ACME') && acmeNote.includes('walks flat between trades')
          && !/bank fund/i.test(acmeNote),
        acmeNote.slice(0, 300));
      const bareFundRes = await H.req('POST', `/api/investments/accounts/${invTfsaId}/holdings`, { label: 'No NAV Fund', kind: 'fund', currency: 'CAD' });
      const invBareFundId = bareFundRes.data.id;
      await H.req('POST', `/api/investments/holdings/${invBareFundId}/events`, { date: '2026-01-12', type: 'buy', units: 50, price: 25 });
      await page.goto(`http://ff.local/#invest-holding/${invBareFundId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const fundNote = await page.evaluate(() => document.querySelector('#investHoldingPriceNote').textContent);
      H.check('investments UI: a fund on trade prices keeps the record-NAV-snapshots banner',
        fundNote.includes('Priced from trade prices') && fundNote.includes('record NAV snapshots below'),
        fundNote.slice(0, 300));
      // Cost-unknown position: the holding page shows the
      // marker, suppresses the gain to —, and lists the NAV
      // snapshots applied from the chat.
      await page.goto(`http://ff.local/#invest-holding/${invCibcId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const cibcPage = await page.evaluate(() => {
        const stats = [...document.querySelectorAll('#investHoldingStats .summary-card')].map((c) => ({
          k: c.querySelector('.k').textContent, v: c.querySelector('.v').textContent,
        }));
        return {
          text: document.querySelector('#view-invest-holding').textContent,
          totalReturn: (stats.find((s) => s.k.startsWith('Total return')) || {}).v,
        };
      });
      H.check('investments UI: a cost-unknown holding shows the marker, gain —, and both NAV snapshots',
        cibcPage.text.includes('Cost unknown') && cibcPage.totalReturn === '—'
          && cibcPage.text.includes('2026-06-30') && cibcPage.text.includes('2026-09-30')
          && cibcPage.text.includes('Position'),
        JSON.stringify({ totalReturn: cibcPage.totalReturn, tail: cibcPage.text.slice(0, 400) }));
      // NAV inline edit: Edit turns the row into inputs prefilled
      // at full precision, Cancel restores, Save persists, and Add
      // on an occupied date surfaces the guard message. The Jun
      // NAV is restored via API afterwards so the conflict-panel
      // checks below still see the original 92.0252.
      const navEdit = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#investNavWrap tr[data-nav-row]')];
        const jun = rows.find((tr) => tr.cells[0].textContent.trim() === '2026-06-30');
        [...jun.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit').click();
        return {
          priceValue: jun.querySelector('[data-nav-price]').value,
          dateValue: jun.querySelector('[data-nav-date]').value,
        };
      });
      H.check('investments UI: NAV Edit prefills the stored full-precision price, not the rounded display',
        navEdit.priceValue === '92.0252' && navEdit.dateValue === '2026-06-30', JSON.stringify(navEdit));
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#investNavWrap tr[data-nav-row]')];
        const jun = rows.find((tr) => tr.querySelector('[data-nav-date]'));
        [...jun.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click();
      });
      await waitI(800);
      const navAfterCancel = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#investNavWrap tr[data-nav-row]')];
        const jun = rows.find((tr) => tr.cells[0].textContent.trim() === '2026-06-30');
        return { text: jun ? jun.textContent : null, editing: !!document.querySelector('[data-nav-price]') };
      });
      H.check('investments UI: NAV Cancel restores the row unchanged',
        navAfterCancel.text && navAfterCancel.text.includes('92.03') && !navAfterCancel.editing, JSON.stringify(navAfterCancel));
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#investNavWrap tr[data-nav-row]')];
        const jun = rows.find((tr) => tr.cells[0].textContent.trim() === '2026-06-30');
        [...jun.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit').click();
        const priceInput = jun.querySelector('[data-nav-price]');
        priceInput.value = '92.5';
        priceInput.dispatchEvent(new Event('input', { bubbles: true }));
        [...jun.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click();
      });
      await waitI(800);
      const navAfterSave = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#investNavWrap tr[data-nav-row]')];
        const jun = rows.find((tr) => tr.cells[0].textContent.trim() === '2026-06-30');
        return jun ? jun.textContent : null;
      });
      H.check('investments UI: NAV Save persists the edited value in the row',
        navAfterSave && navAfterSave.includes('92.50'), JSON.stringify(navAfterSave));
      await page.evaluate(() => {
        const form = document.querySelector('#investNavForm');
        form.elements.date.value = '2026-09-30';
        form.elements.price.value = '95';
        form.querySelector('button[type="submit"]').click();
      });
      await waitI(800);
      const navAddGuard = await page.evaluate(() => ({
        msg: document.querySelector('#investNavMsg').textContent,
        sep: [...document.querySelectorAll('#investNavWrap tr[data-nav-row]')]
          .find((tr) => tr.cells[0].textContent.trim() === '2026-09-30').textContent,
      }));
      H.check('investments UI: Add on an occupied date shows the guard message and leaves the row untouched',
        navAddGuard.msg.includes('already exists') && navAddGuard.msg.includes('edit')
          && navAddGuard.sep.includes('94.32'), JSON.stringify(navAddGuard));
      r = await H.req('GET', `/api/investments/holdings/${invCibcId}`);
      const cibcJun = r.data.navPoints.find((p) => p.date === '2026-06-30');
      r = await H.req('PUT', `/api/investments/prices/${cibcJun.id}`, { date: '2026-06-30', price: 92.0252 });
      H.check('investments UI: the edited Jun NAV is restored for the checks below',
        r.status === 200 && r.data.price === 92.0252, JSON.stringify(r.data));
      // The chat panel renders conflict NAV rows unchecked.
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'Same statement again.',
        proposed: {
          nav: [
            { holdingId: invCibcId, date: '2026-06-30', price: 92.0252 },
            { holdingId: invCibcId, date: '2026-06-30', price: 94.3201 },
          ],
        },
        ready: true,
      }));
      await page.goto(`http://ff.local/#invest-account/${invTfsaId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('[data-invest-ai-toggle]');
      await page.waitForFunction(() => !document.querySelector('[data-invest-ai-panel]').classList.contains('hidden'), { timeout: 10000 });
      await page.type('[data-invest-chat-text]', 'Same statement again.');
      await page.click('[data-invest-chat-send]');
      await page.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-in-row]').length === 2, { timeout: 20000 });
      const navPanel = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-invest-proposed] [data-in-row]')].map((row) => ({
          checked: row.querySelector('[data-in-check]').checked,
          conflict: row.textContent.includes('already recorded'),
        }));
        return { rows, text: document.querySelector('[data-invest-proposed]').textContent };
      });
      H.check('investments UI: conflict NAV rows render unchecked in the proposal panel',
        navPanel.rows.length === 2 && navPanel.rows.every((r) => r.checked === false && r.conflict === true),
        JSON.stringify(navPanel.rows));
      // The panel is static HTML: its open state survives SPA
      // navigation, so close it again — the next chat test
      // opens it with one toggle click.
      await page.click('[data-invest-ai-toggle]');
      await page.waitForFunction(() => document.querySelector('[data-invest-ai-panel]').classList.contains('hidden'), { timeout: 10000 });
      // Add holding offers Position in its initial-transactions
      // row: a cost-unknown holding can be created in one step,
      // without a price anywhere.
      r = await H.req('POST', '/api/investments/accounts', { name: 'InitPos', type: 'RRSP' });
      const initPosAcctId = r.data.id;
      await page.goto(`http://ff.local/#invest-account/${initPosAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('#addHoldingBtn');
      await page.waitForFunction(() => !document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 10000 });
      await page.evaluate(() => {
        const f = document.querySelector('#investHoldingForm');
        f.querySelector('[name="label"]').value = 'CIBC NASDAQ Index Fund';
        f.querySelector('[name="fundCode"]').value = 'ATL8096';
      });
      await page.select('#investHoldingForm [name="kind"]', 'fund');
      await page.select('#investHoldingForm [data-init-row] [data-f="type"]', 'position');
      await page.evaluate(() => {
        const row = document.querySelector('#investHoldingForm [data-init-row]');
        row.querySelector('[data-f="date"]').value = '2026-09-30';
        row.querySelector('[data-f="units"]').value = '462.8297';
      });
      const initPosRow = await page.evaluate(() => {
        const row = document.querySelector('#investHoldingForm [data-init-row]');
        return { priceHidden: row.querySelector('[data-price]').classList.contains('hidden') };
      });
      H.check('investments UI: initial Position row hides the price field',
        initPosRow.priceHidden === true, JSON.stringify(initPosRow));
      await page.click('#investHoldingForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 10000 });
      r = await H.req('GET', `/api/investments/accounts/${initPosAcctId}`);
      const initPosHolding = r.data.holdings.find((h) => h.holding.label === 'CIBC NASDAQ Index Fund');
      H.check('investments UI: Add holding with an initial Position row creates a cost-unknown holding',
        initPosHolding && initPosHolding.summary.costUnknown === true && initPosHolding.summary.units === 462.8297
          && initPosHolding.events.some((e) => e.type === 'position'),
        JSON.stringify(initPosHolding && initPosHolding.summary));
      await H.req('DELETE', `/api/investments/accounts/${initPosAcctId}`);
      // Fill-with-AI preview: value + delta per holding, live
      // on every edit, and equal to the post-Apply page value.
      r = await H.req('POST', '/api/investments/accounts', { name: 'PreviewAcct', type: 'RRSP' });
      const previewAcctId = r.data.id;
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'CIBC NASDAQ statement: position plus two NAVs.',
        proposed: {
          holdings: [{ ref: 'h1', label: 'CIBC NASDAQ Index Fund', kind: 'fund', currency: 'CAD', fundCode: 'ATL8096' }],
          events: [{ holdingRef: 'h1', date: '2026-09-30', type: 'position', units: 462.8297, note: 'units derived: 85529.91 ÷ 184.7978' }],
          nav: [
            { holdingRef: 'h1', date: '2026-06-30', price: 183.3359 },
            { holdingRef: 'h1', date: '2026-09-30', price: 184.7978 },
          ],
        },
        ready: true,
      }));
      await page.goto(`http://ff.local/#invest-account/${previewAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('[data-invest-ai-toggle]');
      await page.waitForFunction(() => !document.querySelector('[data-invest-ai-panel]').classList.contains('hidden'), { timeout: 10000 });
      await page.type('[data-invest-chat-text]', 'CIBC NASDAQ statement Sep 30.');
      await page.click('[data-invest-chat-send]');
      await page.waitForFunction(() => document.querySelector('[data-invest-preview]').textContent.includes('85,529.91'), { timeout: 20000 });
      const preview1 = await page.evaluate(() => document.querySelector('[data-invest-preview]').textContent);
      H.check('investments UI: preview shows the post-Apply value and its full delta for a new holding',
        preview1.includes('CIBC NASDAQ Index Fund') && preview1.includes('85,529.91') && preview1.includes('+$85,529.91'),
        preview1);
      // Edit the units: the preview recomputes live.
      await page.evaluate(() => {
        const input = document.querySelector('[data-invest-proposed] [data-ie-row] [data-ie-units]');
        input.value = '500';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('[data-invest-preview]').textContent.includes('92,398.90'), { timeout: 20000 });
      // Uncheck the September NAV: the June NAV prices the preview.
      // Units are still 500 from the edit above, so the preview is
      // 500 x the June NAV, not the restored-units figure.
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-invest-proposed] [data-in-row]')];
        const sep = rows.find((row) => row.querySelector('[data-in-date]').value === '2026-09-30');
        sep.querySelector('[data-in-check]').click();
      });
      await page.waitForFunction(() => document.querySelector('[data-invest-preview]').textContent.includes('91,667.95'), { timeout: 20000 });
      // Re-check it, restore the units, and Apply: the holding
      // page must show exactly the previewed value, to the cent.
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-invest-proposed] [data-in-row]')];
        const sep = rows.find((row) => row.querySelector('[data-in-date]').value === '2026-09-30');
        sep.querySelector('[data-in-check]').click();
        const units = document.querySelector('[data-invest-proposed] [data-ie-row] [data-ie-units]');
        units.value = '462.8297';
        units.dispatchEvent(new Event('input', { bubbles: true }));
        units.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('[data-invest-preview]').textContent.includes('85,529.91'), { timeout: 20000 });
      await page.click('[data-invest-proposed] [data-invest-apply]');
      await page.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 0, { timeout: 20000 });
      r = await H.req('GET', `/api/investments/accounts/${previewAcctId}`);
      const previewHolding = r.data.holdings.find((h) => h.holding.label === 'CIBC NASDAQ Index Fund');
      await page.goto(`http://ff.local/#invest-holding/${previewHolding.holding.id}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const previewHoldingPage = await page.evaluate(() => {
        const stats = [...document.querySelectorAll('#investHoldingStats .summary-card')].map((c) => ({
          k: c.querySelector('.k').textContent, v: c.querySelector('.v').textContent,
        }));
        return (stats.find((s) => s.k.startsWith('Current value')) || {}).v;
      });
      H.check('investments UI: Apply lands exactly on the previewed value',
        previewHoldingPage === '$85,529.91', previewHoldingPage);
      await page.goto(`http://ff.local/#invest-account/${previewAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('[data-invest-ai-toggle]');
      await page.waitForFunction(() => document.querySelector('[data-invest-ai-panel]').classList.contains('hidden'), { timeout: 10000 });
      await H.req('DELETE', `/api/investments/accounts/${previewAcctId}`);
      // Replaceability: delete the position, add real buys, and
      // the marker clears while history recomputes.
      r = await H.req('GET', `/api/investments/holdings/${invCibcId}`);
      const posEv = r.data.events.find((e) => e.type === 'position');
      await H.req('DELETE', `/api/investments/events/${posEv.id}`);
      await H.req('POST', `/api/investments/holdings/${invCibcId}/events`, { date: '2025-01-15', type: 'buy', units: 695.5991, price: 73.8594 });
      r = await H.req('GET', `/api/investments/holdings/${invCibcId}`);
      H.check('investments AI: deleting the position and adding buys clears cost-unknown and books the cost',
        r.data.summary.costUnknown === false && r.data.summary.contributionsNative === 51376.53
          && r.data.summary.units === 695.5991,
        JSON.stringify(r.data.summary));
      await page.goto(`http://ff.local/#invest-holding/${invCibcId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const cibcReplaced = await page.evaluate(() => document.querySelector('#view-invest-holding').textContent);
      H.check('investments UI: after replacement the cost-unknown marker is gone',
        !cibcReplaced.includes('Cost unknown'), cibcReplaced.slice(0, 300));
      // Loud price failures: a holding neither tier knows shows
      // the verbatim fetch error in the account price banner.
      r = await H.req('POST', '/api/investments/accounts', { name: 'BannerFail', type: 'Other' });
      const bannerAcctId = r.data.id;
      await invPost(bannerAcctId, { label: 'Zed Banner', kind: 'exchange', symbol: 'ZZFAIL.TO', currency: 'CAD' });
      await H.req('POST', '/api/investments/refresh');
      await page.goto(`http://ff.local/#invest-account/${bannerAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const bannerNote = await page.evaluate(() => document.querySelector('#investAccountPriceNote').textContent);
      H.check('investments UI: a failed-today fetch shows its reason in the account price banner',
        bannerNote.includes('fetch failed') && bannerNote.includes('404'),
        bannerNote.slice(0, 300));
      await H.req('DELETE', `/api/investments/accounts/${bannerAcctId}`);
      // Monthly returns paginate by year: a holding bought in
      // 2025-01 pages 2025 and 2026 separately while the chart
      // keeps the full range.
      r = await H.req('POST', '/api/investments/accounts', { name: 'PageYears', type: 'Other' });
      const pageAcctId = r.data.id;
      await invPost(pageAcctId, { label: 'Page Co', kind: 'exchange', symbol: 'PAGE.TO', currency: 'CAD', events: [
        { date: '2025-01-15', type: 'buy', units: 10, price: 100 },
      ] });
      // Hop through the portfolio first: the new account may
      // reuse the deleted banner account's id, and navigating
      // to an identical hash would not reload the page.
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(500);
      await page.goto(`http://ff.local/#invest-account/${pageAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      // The year-switch pins below need the All range; the account
      // page loads on the 1-year default now.
      await page.click('#invRangeBtns-investAccount button[data-months="0"]');
      await waitI(400);
      const pageState = await page.evaluate(() => {
        const sel = document.querySelector('#investAccountMonthly select');
        const rows = [...document.querySelectorAll('#investAccountMonthly tbody tr')].map((tr) => tr.cells[0].textContent.trim());
        const labels = window.__fmCharts.invest ? [...window.__fmCharts.invest.data.labels] : null;
        return { hasSelect: !!sel, value: sel ? sel.value : null, options: sel ? [...sel.options].map((o) => o.value) : [], rows, labels };
      });
      // The app's months are Vancouver months (its current month comes
      // from vancouverToday), so the expectation must be too: a plain
      // toISOString month is UTC and disagrees for the first seven
      // hours of every month.
      const curMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit' }).format(new Date());
      const months2026 = curMonth.startsWith('2026')
        ? (Number(curMonth.slice(5, 7))) : 0;
      H.check('investments UI: monthly returns default to the latest year with a year switcher',
        pageState.hasSelect && pageState.options.includes('2025') && pageState.options.includes('2026')
          && pageState.value === '2026' && pageState.rows.length === months2026
          && pageState.rows.every((m) => m.startsWith('2026-')),
        JSON.stringify({ ...pageState, months2026 }));
      await page.select('#investAccountMonthly select', '2025');
      await waitI(500);
      const pageState25 = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#investAccountMonthly tbody tr')].map((tr) => tr.cells[0].textContent.trim());
        const labels = window.__fmCharts.invest ? [...window.__fmCharts.invest.data.labels] : null;
        return { rows, labels };
      });
      H.check('investments UI: switching the year shows only that year while the chart keeps its range',
        pageState25.rows.length === 12 && pageState25.rows.every((m) => m.startsWith('2025-'))
          && JSON.stringify(pageState25.labels) === JSON.stringify(pageState.labels),
        JSON.stringify({ rows: pageState25.rows.length, labelsSame: JSON.stringify(pageState25.labels) === JSON.stringify(pageState.labels) }));
      await H.req('DELETE', `/api/investments/accounts/${pageAcctId}`);
      // Splits: a 2021-style buy (78 units @ 100.30) is created
      // with the holding; recording a 3:1 split on the holding
      // page restates the header to 234 units and reprices the
      // value against the adjusted stub closes (234 × 165),
      // while the events table shows the split as its own row.
      await page.goto(`http://ff.local/#invest-account/${invTfsaId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('#addHoldingBtn');
      await page.waitForFunction(() => !document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 10000 });
      // Pick the XQQ.TO candidate first (typing in the label
      // field would open ITS dropdown over the symbol input);
      // the pick fills the label, which is then renamed by
      // evaluate — no typing, no second dropdown.
      await page.type('#investHoldingForm [name="symbol"]', 'XQQ');
      await page.waitForSelector('#investHoldingForm [data-symbol-suggest] li', { visible: true, timeout: 10000 });
      await page.click('#investHoldingForm [data-symbol-suggest] li');
      await page.evaluate(() => {
        const f = document.querySelector('#investHoldingForm');
        f.elements.label.value = 'Split XQQ';
        const row = document.querySelector('#investHoldingForm [data-init-row]');
        row.querySelector('[data-f="date"]').value = '2021-01-15';
      });
      await page.type('#investHoldingForm [data-init-row] [data-f="units"]', '78');
      await page.type('#investHoldingForm [data-init-row] [data-f="price"]', '100.30');
      await page.click('#investHoldingForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 15000 });
      await waitI(600);
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('#investHoldingsWrap tr')]
          .find((tr) => tr.textContent.includes('Split XQQ'));
        if (row) row.click();
      });
      await page.waitForFunction(() => location.hash.startsWith('#invest-holding/'), { timeout: 10000 });
      await waitI(800);
      const beforeSplit = await page.evaluate(() => {
        // Card labels carry the display currency now
        // ("Current value (CAD)"), so match by prefix.
        const statCard2 = (name) => [...document.querySelectorAll('#investHoldingStats .summary-card')]
          .find((c) => c.querySelector('.k').textContent.startsWith(name)).querySelector('.v').textContent;
        return { units: statCard2('Units'), value: statCard2('Current value') };
      });
      H.check('investments UI: before the split the header shows the recorded 78 units',
        beforeSplit.units === '78' && beforeSplit.value.includes('12,870'),
        JSON.stringify(beforeSplit));
      await page.select('#investEventForm [name="type"]', 'split');
      await page.evaluate(() => { document.querySelector('#investEventForm [name="date"]').value = '2024-08-09'; });
      await page.type('#investEventForm [name="splitNew"]', '3');
      await page.type('#investEventForm [name="splitOld"]', '1');
      await page.click('#investEventSubmit');
      await page.waitForFunction(() => {
        const card = [...document.querySelectorAll('#investHoldingStats .summary-card')]
          .find((c) => c.querySelector('.k').textContent === 'Units');
        return card && card.querySelector('.v').textContent === '234';
      }, { timeout: 15000 });
      const afterSplit = await page.evaluate(() => {
        const statCard3 = (name) => [...document.querySelectorAll('#investHoldingStats .summary-card')]
          .find((c) => c.querySelector('.k').textContent.startsWith(name)).querySelector('.v').textContent;
        return {
          units: statCard3('Units'), value: statCard3('Current value'),
          events: document.querySelector('#investEventsWrap').textContent,
        };
      });
      H.check('investments UI: the 3:1 split restates the header to 234 units and the adjusted-scale value',
        afterSplit.units === '234' && afterSplit.value.includes('38,610'),
        JSON.stringify({ units: afterSplit.units, value: afterSplit.value }));
      H.check('investments UI: the split renders as its own "Split · 3:1" event row',
        afterSplit.events.includes('Split · 3:1'), afterSplit.events.slice(0, 300));
      // Form-control spec: one height for inputs and selects,
      // so a mixed row shares label baselines and control
      // edges. The event form re-renders in Buy mode after the
      // split submit (all five fields visible); force that
      // state defensively, then measure the row; then the Edit
      // holding modal's Kind / Currency / Fund code row. The
      // modal measurement needs a desktop viewport — at ≤800px
      // .grid3 stacks into one column by design.
      await page.setViewport({ width: 1280, height: 900 });
      await page.waitForFunction(() => window.innerWidth >= 1000, { timeout: 5000 }).catch(() => {});
      await waitI(300);
      await page.evaluate(() => {
        const sel = document.querySelector('#investEventForm [name="type"]');
        sel.value = 'buy';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await waitI(300);
      const evGeom = await page.evaluate(() => {
        const R = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const names = ['date', 'type', 'units', 'price', 'note'];
        const controls = names.map((n) => R(document.querySelector(`#investEventForm [name="${n}"]`)));
        const labels = names.map((n) => R(document.querySelector(`#investEventForm [name="${n}"]`).closest('div').querySelector('label')));
        const spread = (rs, k) => Math.max(...rs.map((r) => r[k])) - Math.min(...rs.map((r) => r[k]));
        return {
          top: spread(controls, 'top'), bottom: spread(controls, 'bottom'),
          labelTop: spread(labels, 'top'), labelBottom: spread(labels, 'bottom'),
        };
      });
      H.check('investments UI: the Add event row shares one control height and one label baseline',
        evGeom.top <= 1 && evGeom.bottom <= 1 && evGeom.labelTop <= 1 && evGeom.labelBottom <= 1,
        JSON.stringify(evGeom));
      await page.click('#editInvestHoldingBtn');
      await page.waitForFunction(() => !document.querySelector('#investHoldingModal').classList.contains('hidden'), { timeout: 10000 });
      await waitI(300);
      const holdGeom = await page.evaluate(() => {
        const R = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const rs = ['kind', 'currency', 'fundCode'].map((n) => R(document.querySelector(`#investHoldingForm [name="${n}"]`)));
        const spread = (k) => Math.max(...rs.map((r) => r[k])) - Math.min(...rs.map((r) => r[k]));
        const grid = document.querySelector('#investHoldingForm .grid3');
        return { top: spread('top'), bottom: spread('bottom'), iw: window.innerWidth, cols: grid ? getComputedStyle(grid).gridTemplateColumns : null };
      });
      H.check('investments UI: the Edit holding modal lines Kind / Currency / Fund code up on one height',
        holdGeom.top <= 1 && holdGeom.bottom <= 1, JSON.stringify(holdGeom));
      await page.click('#investHoldingModal [data-close-modal]');

      // Range controls (property-hero model): the chart and the
      // Monthly returns table both follow the range in force.
      // Expected windows derive from the API payload, so the
      // assertions hold whatever the calendar says.
      const addMonthsStr2 = (ym, n) => {
        const [y, m] = ym.split('-').map(Number);
        const t = y * 12 + (m - 1) + n;
        return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
      };
      const splitHid = await page.evaluate(() => Number(location.hash.split('/').pop()));
      r = await H.req('GET', `/api/investments/holdings/${splitHid}`);
      const hMonths = (r.data.monthly || []).map((x) => x.month);
      const hFull = hMonths.length;
      const hFirst = hMonths[0];
      const hLast = hMonths[hMonths.length - 1];
      const holdRangeState = () => page.evaluate(() => {
        const sel = document.querySelector('#investHoldingMonthly select');
        return {
          labels: window.__fmCharts.investHolding ? window.__fmCharts.investHolding.data.labels : [],
          rows: [...document.querySelectorAll('#investHoldingMonthly tbody tr')].map((tr) => tr.children[0].textContent),
          hasSelect: !!sel, selValue: sel ? sel.value : null,
          selOptions: sel ? [...sel.options].map((o) => o.value) : [],
        };
      });
      // The table pages by year when the range spans years
      // (the chart keeps the full range): expectations below
      // are the latest year's page, not the whole window.
      const latestYearOf = (months) => months.filter((m) => m.startsWith(months[months.length - 1].slice(0, 4)));
      let rs = await holdRangeState();
      const hLatest = latestYearOf(hMonths);
      const hWin0 = Math.min(12, hFull);
      const hWin0Latest = latestYearOf(hMonths.slice(-hWin0));
      H.check('investments UI: the holding range defaults to 1 year — chart spans the last 12 months, table pages to the latest year',
        rs.labels.length === hWin0 && rs.rows.length === hWin0Latest.length && rs.rows[0] === hWin0Latest[0] && rs.rows[rs.rows.length - 1] === hLast
          && rs.hasSelect && rs.selValue === hLast.slice(0, 4),
        JSON.stringify({ points: rs.labels.length, rows: rs.rows.length, full: hFull }));
      await page.click('#invRangeBtns-investHolding button[data-months="12"]');
      await waitI(400);
      rs = await holdRangeState();
      const hWin = Math.min(12, hFull);
      const hWinLatest = latestYearOf(hMonths.slice(-hWin));
      H.check('investments UI: the 1 year preset converges the chart to the last 12 months and pages the table to its latest year',
        rs.labels.length === hWin && rs.rows.length === hWinLatest.length
          && rs.labels[0] === addMonthsStr2(hLast, -(hWin - 1)) && rs.labels[rs.labels.length - 1] === hLast
          && rs.rows[0] === hWinLatest[0] && rs.rows[rs.rows.length - 1] === hLast,
        JSON.stringify({ points: rs.labels.length, rows: rs.rows.length, first: rs.rows[0], last: rs.rows[rs.rows.length - 1] }));
      const holdSet = await page.evaluate(() => {
        const bar = document.querySelector('#invRangeBtns-investHolding');
        const q = (s) => !!bar.querySelector(s);
        return { three: q('button[data-months="3"]'), one: q('button[data-months="12"]'), two: q('button[data-months="24"]'), five: q('button[data-months="60"]'), ten: q('button[data-months="120"]'), all: q('button[data-months="0"]') };
      });
      H.check('date range: stock holding presets keep 1/2/5/10y/All (no 3-month button)',
        !holdSet.three && holdSet.one && holdSet.two && holdSet.five && holdSet.ten && holdSet.all, JSON.stringify(holdSet));
      // Manual From/To through the month popover: a 12-month
      // window starting 30 months after the first data month.
      const mFrom = addMonthsStr2(hFirst, 30);
      const mTo = addMonthsStr2(mFrom, 11);
      const pickMonth = async (fieldSel, popSel, ym) => {
        await page.click(fieldSel);
        await page.waitForFunction((s) => !document.querySelector(s).classList.contains('hidden'), { timeout: 5000 }, popSel);
        const targetYear = Number(ym.slice(0, 4));
        for (let i = 0; i < 12; i++) {
          const y = await page.evaluate((s) => Number(document.querySelector(`${s} .month-pop-year`).textContent), popSel);
          if (y === targetYear) break;
          await page.click(`${popSel} ${y < targetYear ? '[data-pop-next]' : '[data-pop-prev]'}`);
          await waitI(120);
        }
        await page.click(`${popSel} button[data-ym="${ym}"]`);
        await waitI(300);
      };
      await pickMonth('#invRangeStart-investHolding', '#invMonthPop-investHolding', mFrom);
      await pickMonth('#invRangeEnd-investHolding', '#invMonthPop-investHolding', mTo);
      rs = await holdRangeState();
      const winMonths = [];
      for (let i = 0; i < 12; i++) winMonths.push(addMonthsStr2(mFrom, i));
      const toYearRows = winMonths.filter((m) => m.startsWith(mTo.slice(0, 4)));
      H.check('investments UI: a manual From/To pair drives the chart window and defaults the table to the latest year page',
        rs.rows.length === toYearRows.length && rs.rows[0] === toYearRows[0] && rs.rows[rs.rows.length - 1] === mTo
          && rs.labels.length === 12 && rs.labels[0] === mFrom && rs.labels[rs.labels.length - 1] === mTo,
        JSON.stringify({ rows: rs.rows.length, first: rs.rows[0], last: rs.rows[rs.rows.length - 1], want: [mFrom, mTo] }));
      await page.select('#investHoldingMonthly select', mFrom.slice(0, 4));
      await waitI(400);
      rs = await holdRangeState();
      const fromYearRows = winMonths.filter((m) => m.startsWith(mFrom.slice(0, 4)));
      H.check('investments UI: switching the year page shows only that year, chart window unchanged',
        rs.rows.length === fromYearRows.length && rs.rows[0] === mFrom && rs.rows[rs.rows.length - 1] === fromYearRows[fromYearRows.length - 1]
          && rs.labels.length === 12 && rs.labels[0] === mFrom && rs.labels[rs.labels.length - 1] === mTo,
        JSON.stringify({ rows: rs.rows.length, first: rs.rows[0], last: rs.rows[rs.rows.length - 1] }));
      await page.click('#invRangeBtns-investHolding button[data-months="0"]');
      await waitI(400);
      rs = await holdRangeState();
      H.check('investments UI: back to All restores the full chart and re-defaults the table to the latest year',
        rs.labels.length === hFull && rs.rows.length === hLatest.length && rs.rows[0] === hLatest[0],
        JSON.stringify({ points: rs.labels.length, rows: rs.rows.length, full: hFull }));

      // Same linkage on the portfolio overview.
      r = await H.req('GET', '/api/investments');
      const pMonths = (r.data.monthly || []).map((x) => x.month);
      const pFull = pMonths.length;
      const pLatest = pMonths.filter((m) => m.startsWith(pMonths[pMonths.length - 1].slice(0, 4)));
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(1200);
      const pfRangeState = () => page.evaluate(() => ({
        labels: window.__fmCharts.investments ? window.__fmCharts.investments.data.labels : [],
        rows: [...document.querySelectorAll('#investPortfolioMonthly tbody tr')].map((tr) => tr.children[0].textContent),
      }));
      let ps = await pfRangeState();
      const pWin0 = Math.min(12, pFull);
      const pWin0Latest = pMonths.slice(-pWin0).filter((m) => m.startsWith(pMonths[pMonths.length - 1].slice(0, 4)));
      H.check('investments UI: the portfolio range defaults to 1 year — chart spans the last 12 months, table pages to the latest year',
        ps.labels.length === pWin0 && ps.rows.length === pWin0Latest.length && ps.rows[0] === pWin0Latest[0],
        JSON.stringify({ points: ps.labels.length, rows: ps.rows.length, full: pFull }));
      await page.click('#invRangeBtns-investments button[data-months="12"]');
      await waitI(400);
      ps = await pfRangeState();
      const pWin = Math.min(12, pFull);
      const pWinLatest = pMonths.slice(-pWin).filter((m) => m.startsWith(pMonths[pMonths.length - 1].slice(0, 4)));
      H.check('investments UI: the portfolio 1 year preset converges its chart and pages its table to the latest year too',
        ps.labels.length === pWin && ps.rows.length === pWinLatest.length && ps.rows[0] === pWinLatest[0],
        JSON.stringify({ points: ps.labels.length, rows: ps.rows.length, want: pWin }));
      await page.click('#invRangeBtns-investments button[data-months="0"]');
      await waitI(400);
      ps = await pfRangeState();
      H.check('investments UI: the portfolio back to All restores the chart and re-defaults the table to the latest year',
        ps.labels.length === pFull && ps.rows.length === pLatest.length && ps.rows[0] === pLatest[0],
        JSON.stringify({ points: ps.labels.length, rows: ps.rows.length, full: pFull }));

      // Account share doughnut + stacked per-account bars.
      r = await H.req('GET', '/api/investments');
      const pf = r.data;
      const posAccts = (pf.accounts || []).filter((a) => a.summary.value > 0);
      const pfTotal = posAccts.reduce((s, a) => s + a.summary.value, 0);
      const lastSeriesVal = pf.series[pf.series.length - 1].value;
      const shareState = () => page.evaluate(() => {
        const c = window.__fmCharts.investShare;
        const main = window.__fmCharts.investments;
        return {
          slices: c ? c.data.datasets[0].data.slice() : [],
          sliceLabels: c ? c.data.labels.slice() : [],
          barSets: main ? main.data.datasets.filter((d) => d.accountId != null).map((d) => ({ label: d.label, len: d.data.length, last: d.data[d.data.length - 1] })) : [],
          lineSets: main ? main.data.datasets.filter((d) => d.accountId == null).map((d) => d.label) : [],
          labels: main ? main.data.labels.length : 0,
        };
      });
      let sh = await shareState();
      const sliceSum = sh.slices.reduce((a, b) => a + b, 0);
      const pctSum = sh.slices.reduce((s, v) => s + (sliceSum ? (v / sliceSum) * 100 : 0), 0);
      H.check('investments UI: the share doughnut has one slice per valued account and the percentages sum to 100',
        sh.slices.length === posAccts.length && Math.abs(sliceSum - pfTotal) <= 1 && Math.abs(pctSum - 100) <= 0.6,
        JSON.stringify({ slices: sh.slices.length, want: posAccts.length, sum: sliceSum, total: pfTotal, pct: pctSum }));
      const barSum = sh.barSets.reduce((s, d) => s + (d.last || 0), 0);
      H.check('investments UI: the stacked bar segments at the last month sum to the portfolio value, lines intact',
        sh.barSets.length === (pf.accounts || []).length
          && Math.abs(barSum - lastSeriesVal) <= Math.max(1, lastSeriesVal * 0.005)
          && sh.lineSets.length === 2,
        JSON.stringify({ bars: sh.barSets.length, accounts: (pf.accounts || []).length, barSum, value: lastSeriesVal, lines: sh.lineSets }));
      await page.click('#invRangeBtns-investments button[data-months="12"]');
      await waitI(400);
      sh = await shareState();
      H.check('investments UI: the stacked bars follow the range and the doughnut follows the range end (a preset ending at the last month still shows current shares)',
        sh.labels === 12 && sh.barSets.every((d) => d.len === 12) && sh.slices.length === posAccts.length,
        JSON.stringify({ labels: sh.labels, barLens: sh.barSets.map((d) => d.len), slices: sh.slices.length }));
      await page.click('#invRangeBtns-investments button[data-months="0"]');
      await waitI(400);
      // Legend toggle: one click on an account's legend item
      // hides it in BOTH charts; the lines stay; a second click
      // restores it.
      const toggleName = posAccts[0].account.name;
      const clickLegendItem = (name) => page.evaluate((n) => {
        const c = window.__fmCharts.investments;
        if (!c || !c.legend) return false;
        const i = c.legend.legendItems.findIndex((it) => it.text === n);
        if (i < 0) return false;
        const b = c.legend.legendHitBoxes[i];
        const rect = c.canvas.getBoundingClientRect();
        c.canvas.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true,
          clientX: rect.left + b.left + b.width / 2, clientY: rect.top + b.top + b.height / 2,
        }));
        return true;
      }, name);
      const acctVis = (name) => page.evaluate((n) => {
        const main = window.__fmCharts.investments;
        const shareC = window.__fmCharts.investShare;
        const di = main.data.datasets.findIndex((d) => d.label === n);
        const si = shareC.data.labels.indexOf(n);
        const item = main.legend.legendItems.find((it) => it.text === n);
        return {
          bar: di >= 0 ? main.isDatasetVisible(di) : null,
          slice: si >= 0 ? shareC.getDataVisibility(si) : null,
          struck: item ? !!item.hidden : null,
          valueLine: main.isDatasetVisible(main.data.datasets.findIndex((d) => d.label.startsWith('Value'))),
        };
      }, name);
      H.check('investments UI: legend click lands on the account item', await clickLegendItem(toggleName) === true);
      await waitI(300);
      let vis = await acctVis(toggleName);
      H.check('investments UI: hiding an account from the legend removes its bar segment and its doughnut slice, lines untouched',
        vis.bar === false && vis.slice === false && vis.struck === true && vis.valueLine === true,
        JSON.stringify(vis));
      H.check('investments UI: legend click lands again for the restore', await clickLegendItem(toggleName) === true);
      await waitI(300);
      vis = await acctVis(toggleName);
      H.check('investments UI: a second legend click restores the account in both charts',
        vis.bar === true && vis.slice === true && vis.struck === false,
        JSON.stringify(vis));

      // Card Hide button: the same hidden set as the legend,
      // and every computed figure recomputes from the visible
      // accounts — bars, total line, doughnut center, monthly
      // table, and summary strip — then restores exactly.
      const pfH = (await H.req('GET', '/api/investments')).data;
      const hideAcct = (pfH.accounts || []).find((a) => a.summary.value > 0);
      const parseMoney = (s) => Number(String(s || '').replace(/[^0-9.\-]/g, '')) || 0;
      const stripVals = () => page.evaluate(() => [...document.querySelectorAll('#investPortfolioStrip .summary-card .v')].map((el) => el.textContent));
      const cardSt = (id) => page.evaluate((aid) => {
        const card = document.querySelector(`[data-invest-account-card="${aid}"]`);
        if (!card) return null;
        const btn = card.querySelector('.invest-hide-btn');
        if (!btn) return { grey: card.classList.contains('invest-hidden-card'), btn: null };
        const cr = card.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const svg = btn.querySelector('svg');
        const openG = svg ? svg.querySelector('.eye-open') : null;
        const closedG = svg ? svg.querySelector('.eye-closed') : null;
        return {
          grey: card.classList.contains('invest-hidden-card'),
          svg: !!svg,
          textEmpty: btn.textContent.trim() === '',
          openShown: openG ? getComputedStyle(openG).display !== 'none' : false,
          closedShown: closedG ? getComputedStyle(closedG).display !== 'none' : false,
          noSlash: svg ? !svg.querySelector('.eye-slash') : false,
          strokeWidth: svg ? svg.getAttribute('stroke-width') : null,
          pupilRing: svg ? (() => { const c = svg.querySelector('.eye-open circle'); return !!c && c.getAttribute('fill') === 'none'; })() : false,
          lashCount: svg ? svg.querySelectorAll('.eye-closed line').length : 0,
          eyeHidden: btn.classList.contains('invest-eye-hidden'),
          title: btn.title,
          topRight: Math.abs(br.right - cr.right) <= 26 && br.top - cr.top >= 0 && br.top - cr.top <= 26,
          // The open eye must be the symmetric two-curve almond
          // (the old path dropped a trailing segment, so its
          // bottom-left edge rendered as a straight line).
          openPath: openG ? openG.querySelector('path').getAttribute('d') : null,
          eyeColor: getComputedStyle(btn).color,
          eyeSym: svg ? (() => {
            const p = svg.querySelector('.eye-open path');
            if (!p) return false;
            const len = p.getTotalLength();
            const a = p.getPointAtLength(len * 0.25);
            const b = p.getPointAtLength(len * 0.75);
            return Math.abs(a.x - b.x) < 1 && Math.abs(a.y + b.y - 24) < 1;
          })() : false,
        };
      }, id);
      const hideState = () => page.evaluate(() => {
        const main = window.__fmCharts.investments;
        const shareC = window.__fmCharts.investShare;
        const valueDs = main.data.datasets.find((d) => d.label.startsWith('Value'));
        const tf = document.querySelector('#investPortfolioMonthly tfoot');
        return {
          labels: main.data.labels.length,
          valueLast: valueDs ? valueDs.data[valueDs.data.length - 1] : null,
          barVis: main.data.datasets.filter((d) => d.accountId != null).map((d) => ({ label: d.label, vis: main.isDatasetVisible(main.data.datasets.indexOf(d)) })),
          sliceVis: shareC ? shareC.data.labels.map((l, i) => ({ label: l, vis: shareC.getDataVisibility(i) })) : [],
          centerTotal: shareC ? shareC.data.datasets[0].data.reduce((s, v, i) => s + (shareC.getDataVisibility(i) ? v : 0), 0) : 0,
          foot: tf ? [...tf.querySelectorAll('.num')].map((el) => el.textContent) : null,
        };
      });
      const hideName = hideAcct.account.name;
      const hideLast = hideAcct.series[hideAcct.series.length - 1].value;
      // The table pages by year, so its footer sums the
      // DISPLAYED year page only — the expected footer is
      // recomputed for whatever year page is showing after
      // the hide, from the visible accounts' API rows.
      const tablePageYear = () => page.evaluate(() => {
        const sel = document.querySelector('#investPortfolioMonthly select');
        const first = document.querySelector('#investPortfolioMonthly tbody tr');
        return sel ? sel.value : (first ? first.cells[0].textContent.slice(0, 4) : '');
      });
      const footContribForYear = (year) => (pfH.accounts || [])
        .filter((a) => a.account.id !== hideAcct.account.id)
        .reduce((s, a) => s + a.monthly
          .filter((r) => r.month.startsWith(`${year}-`))
          .reduce((s2, r) => s2 + (r.contributions || 0), 0), 0);
      const strip0 = await stripVals();
      const st0 = await hideState();
      const cardValSum = (pfH.accounts || []).reduce((s, a) => s + a.summary.value, 0);
      const cs0 = await cardSt(hideAcct.account.id);
      H.check('investments UI: each account card carries a bold-stroke SVG eye-icon button at its top-right corner, not the emoji glyph or a Hide/Show text button',
        cs0 && cs0.svg === true && cs0.textEmpty === true && cs0.openShown === true && cs0.closedShown === false && cs0.noSlash === true && cs0.eyeHidden === false && cs0.title === 'Hide' && cs0.topRight === true && cs0.strokeWidth === '2.6' && cs0.pupilRing === true && cs0.lashCount === 5, JSON.stringify(cs0));
      H.check('investments UI: the open eye is the symmetric two-curve almond in black, not the old straight-edged path',
        cs0 && cs0.openPath === 'M2 12C6 5.5 18 5.5 22 12C18 18.5 6 18.5 2 12Z' && cs0.eyeSym === true && cs0.eyeColor === 'rgb(0, 0, 0)', JSON.stringify({ openPath: cs0 && cs0.openPath, eyeSym: cs0 && cs0.eyeSym, eyeColor: cs0 && cs0.eyeColor }));
      await page.click(`[data-invest-account-card="${hideAcct.account.id}"] .invest-hide-btn`);
      await waitI(400);
      let cs = await cardSt(hideAcct.account.id);
      let hs = await hideState();
      const strip1 = await stripVals();
      H.check('investments UI: card Hide greys the card and flips its bold eye to the closed-eye form (arc + 5 lashes, no slash)',
        cs && cs.grey === true && cs.eyeHidden === true && cs.title === 'Show' && cs.svg === true && cs.openShown === false && cs.closedShown === true && cs.noSlash === true && cs.strokeWidth === '2.6' && cs.lashCount === 5, JSON.stringify(cs));
      H.check('investments UI: hiding an account drops its bar, its doughnut slice, and the total line by its values',
        hs.barVis.find((b) => b.label === hideName).vis === false
          && hs.sliceVis.find((b) => b.label === hideName).vis === false
          && Math.abs(hs.valueLast - (st0.valueLast - hideLast)) <= Math.max(1, st0.valueLast * 0.005)
          && Math.abs(hs.centerTotal - (st0.centerTotal - hideLast)) <= Math.max(1, st0.centerTotal * 0.005)
          && hs.labels === st0.labels,
        JSON.stringify({ valueLast: hs.valueLast, want: st0.valueLast - hideLast, center: hs.centerTotal, wantCenter: st0.centerTotal - hideLast, labels: hs.labels }));
      H.check('investments UI: hiding an account recomputes the strip and the monthly table from the visible accounts',
        Math.abs(parseMoney(strip1[0]) - (cardValSum - hideAcct.summary.value)) <= 1
          && Math.abs(parseMoney(hs.foot[0]) - footContribForYear(await tablePageYear())) <= 1,
        JSON.stringify({ strip: strip1[0], wantStrip: cardValSum - hideAcct.summary.value, foot: hs.foot, wantFoot: footContribForYear(await tablePageYear()) }));
      H.check('investments UI: legend click on the hidden account restores it (sync both ways)', await clickLegendItem(hideName) === true);
      await waitI(400);
      cs = await cardSt(hideAcct.account.id);
      hs = await hideState();
      const strip2 = await stripVals();
      H.check('investments UI: after the legend restore the card, chart, table, and strip are back exactly',
        cs && cs.grey === false && cs.eyeHidden === false && cs.title === 'Hide'
          && hs.barVis.find((b) => b.label === hideName).vis === true
          && hs.sliceVis.find((b) => b.label === hideName).vis === true
          && hs.valueLast === st0.valueLast && hs.centerTotal === st0.centerTotal
          && strip2[0] === strip0[0] && JSON.stringify(hs.foot) === JSON.stringify(st0.foot),
        JSON.stringify({ card: cs, valueLast: hs.valueLast, center: hs.centerTotal, strip: strip2[0], foot: hs.foot }));
      await page.click(`[data-invest-account-card="${hideAcct.account.id}"] .invest-hide-btn`);
      await waitI(400);
      cs = await cardSt(hideAcct.account.id);
      H.check('investments UI: card Hide hides again after a legend restore', cs && cs.grey === true && cs.eyeHidden === true && cs.title === 'Show', JSON.stringify(cs));
      await page.click(`[data-invest-account-card="${hideAcct.account.id}"] .invest-hide-btn`);
      await waitI(400);
      cs = await cardSt(hideAcct.account.id);
      H.check('investments UI: card Show restores the account', cs && cs.grey === false && cs.eyeHidden === false && cs.title === 'Hide', JSON.stringify(cs));
      await page.click(`[data-invest-account-card="${hideAcct.account.id}"] .invest-hide-btn`);
      await waitI(400);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(1200);
      cs = await cardSt(hideAcct.account.id);
      const strip3 = await stripVals();
      H.check('investments UI: hiding is per-visit — a reload restores every account',
        cs && cs.grey === false && cs.eyeHidden === false && cs.title === 'Hide' && strip3[0] === strip0[0],
        JSON.stringify({ card: cs, strip: strip3[0] }));

      // Share doughnut: side by side with Total return, driven
      // by the same picker — a past range end re-renders it to
      // that month's split, and back to All restores current.
      await page.setViewport({ width: 1400, height: 900 });
      await waitI(300);
      await page.click('#invRangeBtns-investments button[data-months="0"]');
      await waitI(400);
      const shareGeom = () => page.evaluate(() => {
        const chart = document.querySelector('#investPortfolioChart').closest('.chart-wrap');
        const share = document.querySelector('#investShareWrap');
        const cr = chart.getBoundingClientRect();
        const sr = share.getBoundingClientRect();
        return {
          chart: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom },
          share: { left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom },
        };
      });
      const geom = await shareGeom();
      H.check('investments UI: the share doughnut sits LEFT of the Total return chart on a wide viewport',
        geom.share.right <= geom.chart.left + 1 && geom.share.top < geom.chart.bottom && geom.share.bottom > geom.chart.top,
        JSON.stringify(geom));
      const shareNow = () => page.evaluate(() => ({
        slices: window.__fmCharts.investShare ? window.__fmCharts.investShare.data.datasets[0].data.slice() : [],
        title: document.querySelector('#investShareTitle') ? document.querySelector('#investShareTitle').textContent : '',
      }));
      const curShares = await shareNow();
      // Pick a past end month whose split actually differs from
      // current, from the API series (the same data the page uses).
      const pfNow = (await H.req('GET', '/api/investments')).data;
      const sharesAt = (end) => {
        const rows = [];
        for (const a of pfNow.accounts || []) {
          let v = 0; let best = '';
          for (const p of a.series || []) if (p.month <= end && p.month > best) { best = p.month; v = p.value; }
          if (v > 0) rows.push(v);
        }
        return rows;
      };
      const curJson = JSON.stringify(curShares.slices);
      let pastEnd = null;
      for (const m of (pfNow.monthly || []).map((x) => x.month)) {
        if (JSON.stringify(sharesAt(m)) !== curJson) { pastEnd = m; break; }
      }
      H.check('investments UI: the fixture history has a past month whose account split differs from current',
        !!pastEnd, JSON.stringify({ pastEnd, months: (pfNow.monthly || []).length }));
      if (pastEnd) {
        const pickInvestMonth = async (fieldSel, ym) => {
          await page.click(fieldSel);
          await page.waitForFunction(() => !document.querySelector('#invMonthPop-investments').classList.contains('hidden'), { timeout: 5000 });
          const targetYear = Number(ym.slice(0, 4));
          for (let i = 0; i < 40; i++) {
            const y = await page.evaluate(() => Number(document.querySelector('#invMonthPop-investments .month-pop-year').textContent));
            if (y === targetYear) break;
            await page.click(`#invMonthPop-investments ${y < targetYear ? '[data-pop-next]' : '[data-pop-prev]'}`);
            await waitI(120);
          }
          await page.click(`#invMonthPop-investments button[data-ym="${ym}"]`);
          await waitI(300);
        };
        await pickInvestMonth('#invRangeEnd-investments', pastEnd);
        const shPast = await shareNow();
        const wantPast = sharesAt(pastEnd);
        const monNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const wantTitle = `Account share · ${monNames[Number(pastEnd.slice(5, 7)) - 1]} ${pastEnd.slice(0, 4)}`;
        H.check('investments UI: a past range end re-renders the doughnut to that month\'s account shares with its as-of label',
          JSON.stringify(shPast.slices) === JSON.stringify(wantPast) && shPast.title === wantTitle,
          JSON.stringify({ slices: shPast.slices, want: wantPast, title: shPast.title, wantTitle }));
        await page.click('#invRangeBtns-investments button[data-months="0"]');
        await waitI(400);
        const shBack = await shareNow();
        H.check('investments UI: back to All restores the current shares and the current as-of label',
          JSON.stringify(shBack.slices) === curJson && shBack.title === curShares.title,
          JSON.stringify({ slices: shBack.slices, title: shBack.title }));
      }
      // Display currency: the doughnut converts with the page.
      await page.click('#investDisplayBtn');
      await waitI(800);
      const pfUsd = (await H.req('GET', '/api/investments?display=USD')).data;
      const usdTotal = (pfUsd.accounts || []).reduce((s, a) => s + (a.summary.value > 0 ? a.summary.value : 0), 0);
      const shUsd = await page.evaluate(() => ({
        slices: window.__fmCharts.investShare ? window.__fmCharts.investShare.data.datasets[0].data.slice() : [],
        btn: document.querySelector('#investDisplayBtn').textContent.trim(),
        strip: document.querySelector('#section-investments .summary-strip').textContent,
      }));
      const usdSum = shUsd.slices.reduce((a, b) => a + b, 0);
      H.check('investments UI: switching the page to USD converts the doughnut figures with currency labels',
        shUsd.btn === 'Display: USD' && Math.abs(usdSum - usdTotal) <= 1 && shUsd.strip.includes('USD'),
        JSON.stringify({ btn: shUsd.btn, sum: usdSum, total: usdTotal }));
      await page.click('#investDisplayBtn');
      await waitI(800);
      await page.setViewport({ width: 700, height: 900 });
      await waitI(400);
      const narrowGeom = await shareGeom();
      H.check('investments UI: on a narrow viewport the row stacks with the chart on top and the doughnut below it',
        narrowGeom.share.top >= narrowGeom.chart.bottom - 1,
        JSON.stringify(narrowGeom));
      await page.setViewport({ width: 800, height: 600 });

      // Hover animation parity with the property charts: the
      // share doughnut pops its slice out on hover (hoverOffset
      // 10, the property pie's value) and every invest time chart
      // carries the vertical dashed guide line plugin.
      const hoverPins = () => page.evaluate(() => {
        const plugIds = (c) => (c && c.config && Array.isArray(c.config.plugins) ? c.config.plugins.map((p) => p.id) : []);
        const share = window.__fmCharts.investShare;
        const main = window.__fmCharts.investments;
        return {
          shareHoverOffset: share ? share.data.datasets[0].hoverOffset : null,
          sharePlugIds: plugIds(share),
          mainGuideIds: plugIds(main),
        };
      });
      let hp = await hoverPins();
      H.check('investments UI: the share doughnut carries hoverOffset 10 and the portfolio chart carries the guide line plugin',
        hp.shareHoverOffset === 10 && hp.mainGuideIds.includes('guideLine'),
        JSON.stringify(hp));
      // Real hover dispatches (not config-only): move the mouse
      // onto a doughnut slice and onto the portfolio plot area;
      // both charts must resolve active elements, which is what
      // the guide line plugin draws from.
      const hoverActive = async (canvasSel, chartKey, pointFn) => {
        const pt = await page.evaluate((sel) => {
          const cv = document.querySelector(sel);
          if (!cv) return null;
          cv.scrollIntoView();
          const r = cv.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }, canvasSel);
        if (!pt) return -1;
        for (const p of pointFn(pt)) {
          await page.mouse.move(p.x, p.y);
          await waitI(250);
          const n = await page.evaluate((key) => {
            const c = window.__fmCharts[key];
            return c ? c.getActiveElements().length : -1;
          }, chartKey);
          if (n > 0) return n;
        }
        return 0;
      };
      const doughnutPts = (pt) => {
        const cx = pt.x + pt.w / 2; const cy = pt.y + pt.h / 2;
        const rad = Math.min(pt.w, pt.h) * 0.395;
        return [-90, -45, 0, 45].map((deg) => {
          const a = (deg * Math.PI) / 180;
          return { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) };
        });
      };
      const plotPts = (pt) => [{ x: pt.x + pt.w / 2, y: pt.y + pt.h / 2 }];
      const doughnutActive = await hoverActive('#investShareChart', 'investShare', doughnutPts);
      H.check('investments UI: hovering a share doughnut slice resolves an active element',
        doughnutActive > 0, JSON.stringify({ active: doughnutActive }));
      const plotActive = await hoverActive('#investPortfolioChart', 'investments', plotPts);
      H.check('investments UI: hovering the portfolio plot area resolves active elements (the guide line\'s input)',
        plotActive > 0, JSON.stringify({ active: plotActive }));

      // Account + holding time charts carry the guide line too.
      const invApi = (await H.req('GET', '/api/investments')).data;
      const firstAcct = (invApi.accounts || [])[0];
      const levelGuide = () => page.evaluate(() => {
        const c = window.__fmCharts.invest;
        const ids = c && c.config && Array.isArray(c.config.plugins) ? c.config.plugins.map((p) => p.id) : [];
        return { canvas: c && c.canvas ? c.canvas.id : null, guide: ids.includes('guideLine'), ids };
      });
      if (firstAcct) {
        await page.evaluate((id) => { location.hash = `#invest-account/${id}`; }, firstAcct.account.id);
        await page.waitForFunction(() => {
          const c = window.__fmCharts.invest;
          return c && c.canvas && c.canvas.id === 'investAccountChart';
        }, { timeout: 10000 });
        const acctGuide = await levelGuide();
        H.check('investments UI: the account chart carries the guide line plugin',
          acctGuide.guide === true && acctGuide.canvas === 'investAccountChart',
          JSON.stringify(acctGuide));
        const firstHolding = (firstAcct.holdings || [])[0];
        const holdId = firstHolding ? (firstHolding.holding ? firstHolding.holding.id : firstHolding.id) : null;
        if (holdId) {
          await page.evaluate((id) => { location.hash = `#invest-holding/${id}`; }, holdId);
          await page.waitForFunction(() => {
            const c = window.__fmCharts.invest;
            return c && c.canvas && c.canvas.id === 'investHoldingChart';
          }, { timeout: 10000 });
          const holdGuide = await levelGuide();
          H.check('investments UI: the holding chart carries the guide line plugin',
            holdGuide.guide === true && holdGuide.canvas === 'investHoldingChart',
            JSON.stringify(holdGuide));
        }
      }

      // Overview chart panel: left share doughnut (Property +
      // Stock), right history chart (stacked bars + total line),
      // same range picker driving both; above it the breakdown
      // cards (no top summary strip since the 2026-10-29 redesign).
      await page.goto('http://ff.local/#assets/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.setViewport({ width: 1400, height: 900 });
      await waitI(600);
      await page.waitForFunction(() => {
        const t = document.querySelector('#overviewShareTitle');
        return t && t.textContent.length > 0;
      }, { timeout: 10000 });
      const ovGeom = await page.evaluate(() => {
        const chart = document.querySelector('#overviewChart').closest('.chart-wrap');
        const share = document.querySelector('#overviewShareWrap');
        const cr = chart.getBoundingClientRect();
        const sr = share.getBoundingClientRect();
        return {
          chart: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom },
          share: { left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom },
        };
      });
      H.check('overview UI: the asset share doughnut sits LEFT of the history chart on a wide viewport',
        ovGeom.share.right <= ovGeom.chart.left + 1 && ovGeom.share.top < ovGeom.chart.bottom && ovGeom.share.bottom > ovGeom.chart.top,
        JSON.stringify(ovGeom));
      // Expectations computed from the endpoint's own data with
      // the same merge rules the panel uses (Property = last
      // monthly equity point at or before the month).
      const ovApi = (await H.req('GET', '/api/overview/chart')).data;
      const ovPropAt = (m) => {
        let v = 0;
        for (const p of ovApi.propertyByMonth || []) { if (p.month <= m) v = p.value; else break; }
        return v;
      };
      const ovStockAt = (m) => {
        let v = 0; let best = '';
        for (const p of ovApi.stockSeries || []) if (p.month <= m && p.month > best) { best = p.month; v = p.value; }
        return v;
      };
      const ovMonths = (() => {
        const set = new Set((ovApi.stockSeries || []).map((p) => p.month));
        const propMonths = (ovApi.propertyByMonth || []).map((r) => r.month);
        if (propMonths.length) {
          let m = [...propMonths].sort()[0];
          while (m <= ovApi.currentMonth) {
            set.add(m);
            const y = Number(m.slice(0, 4)); const mo = Number(m.slice(5, 7));
            m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
          }
        }
        return [...set].sort();
      })();
      const ovShareNow = () => page.evaluate(() => ({
        labels: window.__fmCharts.overviewShare ? window.__fmCharts.overviewShare.data.labels.slice() : [],
        data: window.__fmCharts.overviewShare ? window.__fmCharts.overviewShare.data.datasets[0].data.slice() : [],
        title: document.querySelector('#overviewShareTitle') ? document.querySelector('#overviewShareTitle').textContent : '',
      }));
      const ovChartData = () => page.evaluate(() => {
        const c = window.__fmCharts.overview;
        if (!c) return null;
        return {
          labels: c.data.labels.slice(),
          sets: c.data.datasets.map((d) => ({ label: d.label, type: d.type || 'line', data: d.data.slice() })),
        };
      });
      const ovMonNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const ovTitle = (m) => `Asset share · ${ovMonNames[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
      const ovLastMonth = ovMonths[ovMonths.length - 1];
      const ovSh0 = await ovShareNow();
      const ovWant0 = [];
      if (ovPropAt(ovLastMonth) > 0) ovWant0.push(['Property', ovPropAt(ovLastMonth)]);
      if (ovStockAt(ovLastMonth) > 0) ovWant0.push(['Stock', ovStockAt(ovLastMonth)]);
      H.check('overview UI: the doughnut has Property + Stock portions at the range-end month with its as-of label',
        JSON.stringify(ovSh0.labels) === JSON.stringify(ovWant0.map((w) => w[0]))
          && JSON.stringify(ovSh0.data) === JSON.stringify(ovWant0.map((w) => w[1]))
          && ovSh0.title === ovTitle(ovLastMonth),
        JSON.stringify({ labels: ovSh0.labels, data: ovSh0.data, title: ovSh0.title, want: ovWant0, wantTitle: ovTitle(ovLastMonth) }));
      // The doughnut's hole draws the rows' sum, so the dataset
      // sum IS the center total: it must equal equity + stock.
      H.check('overview UI: the doughnut center total equals equity + stock at the range-end month',
        Math.abs(ovSh0.data.reduce((a, b) => a + b, 0) - (ovPropAt(ovLastMonth) + ovStockAt(ovLastMonth))) < 0.011,
        JSON.stringify({ data: ovSh0.data, prop: ovPropAt(ovLastMonth), stock: ovStockAt(ovLastMonth) }));
      const ovNoteText = await page.evaluate(() => {
        const s = document.querySelector('#section-overview');
        return s ? s.textContent : '';
      });
      H.check('overview UI: both deleted note lines are absent from the Overview',
        !ovNoteText.includes('Pick a section above') && !ovNoteText.includes('This composition view does not change net worth'),
        JSON.stringify(ovNoteText.slice(0, 300)));
      // The stack/total pins below need the full span; the overview
      // loads on the 1-year default now.
      await page.click('#invRangeBtns-overview button[data-months="0"]');
      await waitI(400);
      const ovHd0 = await ovChartData();
      const ovBarsOk = ovHd0 && ovHd0.sets.length === 3
        && ovHd0.sets[0].label === 'Property' && ovHd0.sets[1].label === 'Stock'
        && ovHd0.sets[0].type === 'bar' && ovHd0.sets[1].type === 'bar'
        && ovHd0.labels.length === ovMonths.length
        && ovHd0.sets[2].data.every((v, i) => Math.abs(v - (ovHd0.sets[0].data[i] + ovHd0.sets[1].data[i])) < 0.011)
        && ovHd0.sets[0].data.every((v, i) => Math.abs(v - ovPropAt(ovHd0.labels[i])) < 0.011)
        && ovHd0.sets[1].data.every((v, i) => Math.abs(v - ovStockAt(ovHd0.labels[i])) < 0.011);
      H.check('overview UI: history bars stack Property + Stock and the total line equals their sum',
        !!ovBarsOk, JSON.stringify(ovHd0 ? { labels: ovHd0.labels.length, sets: ovHd0.sets.map((s) => s.label) } : null));
      const ovCurShareJson = JSON.stringify(ovSh0.data);
      let ovPastEnd = null;
      for (const m of ovMonths) {
        const w = [];
        if (ovPropAt(m) > 0) w.push(ovPropAt(m));
        if (ovStockAt(m) > 0) w.push(ovStockAt(m));
        if (JSON.stringify(w) !== ovCurShareJson) { ovPastEnd = m; break; }
      }
      H.check('overview UI: the fixture history has a past month whose Property/Stock split differs from current',
        !!ovPastEnd, JSON.stringify({ ovPastEnd, months: ovMonths.length }));
      if (ovPastEnd) {
        const pickOvMonth = async (fieldSel, ym) => {
          await page.click(fieldSel);
          await page.waitForFunction(() => !document.querySelector('#invMonthPop-overview').classList.contains('hidden'), { timeout: 5000 });
          const targetYear = Number(ym.slice(0, 4));
          for (let i = 0; i < 40; i++) {
            const y = await page.evaluate(() => Number(document.querySelector('#invMonthPop-overview .month-pop-year').textContent));
            if (y === targetYear) break;
            await page.click(`#invMonthPop-overview ${y < targetYear ? '[data-pop-next]' : '[data-pop-prev]'}`);
            await waitI(120);
          }
          await page.click(`#invMonthPop-overview button[data-ym="${ym}"]`);
          await waitI(300);
        };
        // The End pick below pairs with the span start; restore All
        // first, since the overview loads on the 1-year default now.
        await page.click('#invRangeBtns-overview button[data-months="0"]');
        await waitI(400);
        await pickOvMonth('#invRangeEnd-overview', ovPastEnd);
        const shPast = await ovShareNow();
        const wantPast = [];
        if (ovPropAt(ovPastEnd) > 0) wantPast.push(ovPropAt(ovPastEnd));
        if (ovStockAt(ovPastEnd) > 0) wantPast.push(ovStockAt(ovPastEnd));
        H.check('overview UI: a past range end re-renders the doughnut to that month\'s Property/Stock split with its as-of label',
          JSON.stringify(shPast.data) === JSON.stringify(wantPast) && shPast.title === ovTitle(ovPastEnd),
          JSON.stringify({ data: shPast.data, want: wantPast, title: shPast.title, wantTitle: ovTitle(ovPastEnd) }));
        await page.click('#invRangeBtns-overview button[data-months="0"]');
        await waitI(400);
      }
      const ovSet = await page.evaluate(() => {
        const bar = document.querySelector('#invRangeBtns-overview');
        const q = (s) => !!bar.querySelector(s);
        return { three: q('button[data-months="3"]'), ytd: q('button[data-ytd]'), two: q('button[data-months="24"]'), all: q('button[data-months="0"]'), twelve: q('button[data-months="12"]'), sixty: q('button[data-months="60"]') };
      });
      H.check('date range: overview presets are This year / 2 years / All (no 3-month, 1/5-year buttons)',
        !ovSet.three && ovSet.ytd && ovSet.two && ovSet.all && !ovSet.twelve && !ovSet.sixty,
        JSON.stringify(ovSet));
      // Invest picker anchoring (2026-10-29 screenshots): the
      // invest popovers are position:fixed, so they must anchor
      // from the field's viewport rect — the old offsetTop /
      // offsetLeft math stranded them at the viewport top while
      // the field sat mid-page.
      await page.evaluate(() => document.querySelector('#invRangeStart-overview').scrollIntoView({ block: 'center' }));
      await waitI(200);
      await page.click('#invRangeStart-overview');
      await waitI(200);
      const invPopRect = () => page.evaluate(() => {
        const f = document.querySelector('#invRangeStart-overview').getBoundingClientRect();
        const p = document.querySelector('#invMonthPop-overview');
        const pr = p.getBoundingClientRect();
        return { hidden: p.classList.contains('hidden'), fTop: f.top, fBottom: f.bottom, fLeft: f.left, pTop: pr.top, pLeft: pr.left, pWidth: p.offsetWidth, vw: window.innerWidth };
      });
      const invBefore = await invPopRect();
      await page.evaluate(() => window.scrollBy(0, 200));
      await waitI(300);
      const invAfter = await invPopRect();
      const invWantLeft = Math.max(4, Math.min(invAfter.fLeft, invAfter.vw - invAfter.pWidth - 4));
      const invWantLeftBefore = Math.max(4, Math.min(invBefore.fLeft, invBefore.vw - invBefore.pWidth - 4));
      H.check('invest picker: the popover opens glued to its field (not at viewport top) and follows it on scroll',
        !invBefore.hidden && Math.abs(invBefore.pTop - (invBefore.fBottom + 6)) <= 2 && Math.abs(invBefore.pLeft - invWantLeftBefore) <= 2
        && !invAfter.hidden && invBefore.fTop - invAfter.fTop > 0
        && Math.abs(invAfter.pTop - (invAfter.fBottom + 6)) <= 2 && Math.abs(invAfter.pLeft - invWantLeft) <= 2,
        JSON.stringify({ before: invBefore, after: invAfter, wantLeft: invWantLeft }));
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitI(200);
      await page.keyboard.press('Escape');
      // Close-on-out-of-view needs scroll room the tall-enough
      // Overview page lacks at full height, so shrink the
      // viewport, drive the field out the top, then restore.
      const vpBefore = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await page.setViewport({ width: vpBefore.w, height: 400 });
      await page.evaluate(() => document.querySelector('#invRangeStart-overview').scrollIntoView({ block: 'center' }));
      await waitI(200);
      await page.click('#invRangeStart-overview');
      await waitI(200);
      const invOpenAgain = await page.evaluate(() => !document.querySelector('#invMonthPop-overview').classList.contains('hidden'));
      await page.evaluate(() => window.scrollBy(0, 1000));
      await waitI(300);
      const invOut = await page.evaluate(() => document.querySelector('#invMonthPop-overview').classList.contains('hidden'));
      H.check('invest picker: scrolling the field out of view closes the picker',
        invOpenAgain && invOut, JSON.stringify({ openAgain: invOpenAgain, closed: invOut }));
      await page.setViewport({ width: vpBefore.w, height: vpBefore.h });
      await waitI(200);
      // Overview redesign (2026-10-29): the top summary strip is
      // gone; breakdown cards incl. Stocks; the Properties card
      // shows assessed + total equity; one standard 14px gap to
      // the chart panel below.
      const ovLayout = await page.evaluate(() => {
        const txt = (el) => (el ? el.textContent.trim() : '');
        const cards = [...document.querySelectorAll('#breakdownCards .breakdown-card')].map((c) => ({
          label: txt(c.querySelector('.k')),
          value: txt(c.querySelector('.v')),
          note: txt(c.querySelector('.n')),
          figures: [...c.querySelectorAll('.breakdown-figure')].map((f) => ({ label: txt(f.querySelector('.k')), value: txt(f.querySelector('.v')) })),
          onclick: c.getAttribute('onclick') || '',
        }));
        const bc = document.querySelector('#breakdownCards').getBoundingClientRect();
        const panel = document.querySelector('#overviewChartPanel .panel');
        const pr = panel ? panel.getBoundingClientRect() : null;
        return {
          strip: !!document.querySelector('#section-overview .summary-strip'),
          sumIds: ['sumProperty', 'sumMortgage', 'sumOther', 'sumNet'].filter((id) => document.getElementById(id)),
          cards,
          gap: pr ? Math.round(pr.top - bc.bottom) : null,
          chartHead: !!document.querySelector('#overviewChartPanel h3'),
        };
      });
      const ovSumApi = (await H.req('GET', '/api/summary')).data;
      const ovInvApi = (await H.req('GET', '/api/investments?display=CAD')).data;
      const ovPropCard = ovLayout.cards.find((c) => c.label === 'Properties');
      const ovStockCard = ovLayout.cards.find((c) => c.label === 'Stocks');
      const ovEquity = ovSumApi.propertyValue - ovSumApi.mortgageBalance;
      const ovFig = (label) => (ovPropCard ? ovPropCard.figures.find((f) => f.label === label) : null);
      const ovAssessedVal = ovFig('Assessed') ? Number(ovFig('Assessed').value.replace(/[^0-9.\-]/g, '')) : NaN;
      const ovEqVal = ovFig('Equity') ? Number(ovFig('Equity').value.replace(/[^0-9.\-]/g, '')) : NaN;
      const ovCtMatch = ovStockCard ? ovStockCard.note.match(/(\d+)\s+accounts? · (\d+)\s+holdings?/) : null;
      const ovHoldings = (ovInvApi.accounts || []).reduce((n, a) => n + (a.holdings || []).length, 0);
      H.check('overview UI: the four top summary cards are gone and the breakdown cards incl. Stocks remain',
        ovLayout.strip === false && ovLayout.sumIds.length === 0
        && ovLayout.cards.map((c) => c.label).join('|') === 'Properties|Stocks|Fixed assets|Term deposits|Other',
        JSON.stringify({ strip: ovLayout.strip, sumIds: ovLayout.sumIds, labels: ovLayout.cards.map((c) => c.label) }));
      H.check('overview UI: the Properties card shows assessed and equity as parallel figures with the property count',
        !!ovPropCard && ovPropCard.figures.length === 2
        && Math.abs(ovAssessedVal - ovSumApi.propertyValue) < 0.01
        && Math.abs(ovEqVal - ovEquity) < 0.01 && ovPropCard.note.includes(String(ovSumApi.propertyCount)),
        JSON.stringify({ card: ovPropCard, apiValue: ovSumApi.propertyValue, apiEquity: ovEquity }));
      H.check('overview UI: the parallel figures share one font size and weight',
        await page.evaluate(() => {
          const figs = [...document.querySelectorAll('#breakdownCards .breakdown-card .breakdown-figure .v')];
          if (figs.length !== 2) return false;
          const s0 = getComputedStyle(figs[0]);
          const s1 = getComputedStyle(figs[1]);
          return s0.fontSize === s1.fontSize && s0.fontWeight === s1.fontWeight;
        }),
        'parallel-figure style parity');
      H.check('overview UI: the Stocks card shows the CAD portfolio total with account/holding counts',
        !!ovStockCard && Math.abs(Number(ovStockCard.value.replace(/[^0-9.\-]/g, '')) - Math.round(ovInvApi.summary.value)) < 0.01
        && !!ovCtMatch && Number(ovCtMatch[1]) === ovInvApi.accounts.length && Number(ovCtMatch[2]) === ovHoldings,
        JSON.stringify({ card: ovStockCard, apiValue: ovInvApi.summary.value, apiAccounts: ovInvApi.accounts.length, apiHoldings: ovHoldings }));
      H.check('overview UI: the cards-to-chart gap is the standard 14px spacing and the chart panel still renders below',
        ovLayout.gap === 14 && ovLayout.chartHead === true,
        JSON.stringify({ gap: ovLayout.gap, chartHead: ovLayout.chartHead }));
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#breakdownCards .breakdown-card')].find((c) => {
          const k = c.querySelector('.k');
          return k && k.textContent.trim() === 'Stocks';
        });
        if (card) card.click();
      });
      await page.waitForFunction(() => !document.querySelector('#section-investments').classList.contains('hidden'), { timeout: 10000 });
      const ovHash = await page.evaluate(() => location.hash);
      H.check('overview UI: clicking the Stocks card lands on the Stocks section',
        ovHash === '#assets/investments', JSON.stringify({ hash: ovHash }));
      await page.goto('http://ff.local/#assets/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(600);
      await page.waitForFunction(() => {
        const t = document.querySelector('#overviewShareTitle');
        return t && t.textContent.length > 0;
      }, { timeout: 10000 });
      await page.setViewport({ width: 800, height: 600 });

      // AI panel: a sell-heavy stub round must show both sell
      // proposals (one with the derived-price marker) and the
      // dropped-items warning — the sells must not vanish.
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'Found the sales. One sale could not be matched to a holding.',
        proposed: {
          holdings: [{ ref: 'h1', label: 'Panel VFV', kind: 'exchange', symbol: 'VFV.TO', currency: 'CAD' }],
          events: [
            { holdingRef: 'h1', date: '2026-03-10', type: 'sell', units: -50, price: 40 },
            { holdingRef: 'h1', date: '2026-03-11', type: 'sell', units: 20, amount: 1000 },
            { holdingId: 999999, date: '2026-03-12', type: 'sell', units: 5, price: 40 },
          ],
        },
        ready: true,
      }));
      await page.goto(`http://ff.local/#invest-account/${invTfsaId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('[data-invest-ai-toggle]');
      await page.waitForFunction(() => !document.querySelector('[data-invest-ai-panel]').classList.contains('hidden'), { timeout: 10000 });
      await page.type('[data-invest-chat-text]', 'Statement sales for VFV.');
      await page.click('[data-invest-chat-send]');
      await page.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 2, { timeout: 20000 });
      const panelSell = await page.evaluate(() => {
        const host = document.querySelector('[data-invest-proposed]');
        const rows = [...host.querySelectorAll('[data-ie-row]')].map((row) => ({
          type: row.querySelector('[data-ie-type]').value,
          units: row.querySelector('[data-ie-units]').value,
          price: row.querySelector('[data-ie-price]').value,
        }));
        return { text: host.textContent, rows };
      });
      H.check('investments UI: the AI panel shows both sell proposals (negative units normalized, amount-only price derived) and the dropped-items note',
        panelSell.rows.length === 2 && panelSell.rows.every((r) => r.type === 'sell')
          && panelSell.rows[0].units === '50'
          && panelSell.text.includes('Price derived from total amount')
          && panelSell.text.includes('Not included from the statement') && panelSell.text.includes('matched'),
        JSON.stringify(panelSell));
      // Earnings: a job created with an owner shows the earner
      // chip on its card in the salary list.
      await page.goto('http://ff.local/#earnings', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('#addEarnJobBtn');
      await page.waitForFunction(() => !document.querySelector('#earnJobModal').classList.contains('hidden'), { timeout: 10000 });
      await page.type('#earnJobForm input[name=employer]', 'Owner Browser Corp');
      await page.select('#earnJobForm select[name=province]', 'BC');
      await page.select('#earnJobForm select[name=frequency]', 'annual');
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobForm');
        f.start_date.value = '2026-01-05';
        f.recent_pay_date.value = '2026-10-23';
      });
      await page.type('#earnJobForm input[name=recent_pay_value]', '60000');
      await page.select('#earnJobForm select[name=owner]', 'Shawn');
      await page.click('#earnJobForm button[type=submit]');
      await waitI(800);
      const jobCardText = await page.evaluate(() => document.querySelector('#earnJobList').textContent);
      H.check('earnings UI: a job created with an owner shows the earner on its card',
        jobCardText.includes('Owner Browser Corp') && jobCardText.includes('Shawn'), jobCardText.slice(0, 300));
      await page.evaluate(async () => {
        const d = await (await fetch('/api/earnings')).json();
        const j = d.jobs.find((x) => x.employer === 'Owner Browser Corp');
        if (j) await fetch(`/api/earnings/jobs/${j.id}`, { method: 'DELETE' });
      });
      // Display currency: a fresh all-USD account opens in USD
      // by derivation; the form's default setting changes what
      // the next visit opens in; toggles never leak across pages.
      r = await H.req('POST', '/api/investments/accounts', { name: 'Display Default UI', type: 'RSU' });
      const dispAcctId = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${dispAcctId}/holdings`, { label: 'USD Fund', kind: 'fund', currency: 'USD' });
      const dispHoldId = r.data.id;
      await H.req('POST', `/api/investments/holdings/${dispHoldId}/events`, { date: '2026-01-05', type: 'buy', units: 10, price: 50 });
      await page.goto(`http://ff.local/#invest-account/${dispAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const dispDerived = await page.evaluate(() => ({
        btn: document.querySelector('#investAccountDisplayBtn').textContent.trim(),
        strip: document.querySelector('#investAccountStats').textContent,
      }));
      H.check('investments UI: a new all-USD account opens in USD by derivation, strip labeled USD',
        dispDerived.btn === 'Display: USD' && dispDerived.strip.includes('US$500') && dispDerived.strip.includes('Current value (USD)'),
        JSON.stringify(dispDerived));
      // Change the stored default in the form; the next visit
      // opens in the new default (here CAD: 500 USD × 1.40).
      await page.click('#editInvestAccountBtn');
      await page.waitForFunction(() => !document.querySelector('#investAccountModal').classList.contains('hidden'), { timeout: 10000 });
      await page.select('#investAccountForm select[name=defaultCurrency]', 'CAD');
      await page.click('#investAccountForm button[type=submit]');
      await page.waitForFunction(() => document.querySelector('#investAccountModal').classList.contains('hidden'), { timeout: 15000 });
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.goto(`http://ff.local/#invest-account/${dispAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const dispStored = await page.evaluate(() => ({
        btn: document.querySelector('#investAccountDisplayBtn').textContent.trim(),
        strip: document.querySelector('#investAccountStats').textContent,
      }));
      H.check('investments UI: after setting the default to CAD, re-entering opens in CAD',
        dispStored.btn === 'Display: CAD' && dispStored.strip.includes('700') && !dispStored.strip.includes('US$'),
        JSON.stringify(dispStored));
      // The overview still opens in CAD, and toggling the
      // account page does not move it.
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const overDefault = await page.evaluate(() => document.querySelector('#investDisplayBtn').textContent.trim());
      H.check('investments UI: the overview opens in CAD by default',
        overDefault === 'Display: CAD', overDefault);
      await page.goto(`http://ff.local/#invest-account/${dispAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      await page.click('#investAccountDisplayBtn');
      await waitI(800);
      const acctToggled = await page.evaluate(() => document.querySelector('#investAccountDisplayBtn').textContent.trim());
      await page.goto('http://ff.local/#assets/investments', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const overAfter = await page.evaluate(() => document.querySelector('#investDisplayBtn').textContent.trim());
      H.check('investments UI: toggling the account page to USD leaves the overview in CAD',
        acctToggled === 'Display: USD' && overAfter === 'Display: CAD',
        JSON.stringify({ acctToggled, overAfter }));
      // The overview toggle converts and labels its own page;
      // the account page then re-opens in its own stored
      // default, not the overview's display.
      await page.click('#investDisplayBtn');
      await waitI(800);
      const overToggled = await page.evaluate(() => ({
        btn: document.querySelector('#investDisplayBtn').textContent.trim(),
        strip: document.querySelector('#section-investments .summary-strip').textContent,
        monthlyHead: document.querySelector('#investPortfolioMonthly thead').textContent,
      }));
      H.check('investments UI: toggling the overview to USD labels strip and monthly headers USD',
        overToggled.btn === 'Display: USD' && overToggled.strip.includes('Current value (USD)')
          && overToggled.monthlyHead.includes('Start value (USD)'),
        JSON.stringify(overToggled));
      await page.goto(`http://ff.local/#invest-account/${dispAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitI(800);
      const acctAfter = await page.evaluate(() => document.querySelector('#investAccountDisplayBtn').textContent.trim());
      H.check('investments UI: the account page re-opens in its stored CAD default, not the overview USD',
        acctAfter === 'Display: CAD', acctAfter);
      await H.req('DELETE', `/api/investments/accounts/${dispAcctId}`);
    } catch (err) {
      H.check('investments browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserI.close();
    }

    // CSV import: the account page's Import CSV button previews
    // the same synthetic fixture and Apply lands it.
    r = await H.req('POST', '/api/investments/accounts', { name: 'CSV import UI', type: 'TFSA', institution: 'Wealthsimple' });
    const csvUiAcctId = r.data.id;
    const csvTmp = path.join(os.tmpdir(), `ff-e2e-ws-${Date.now()}.csv`);
    fs.writeFileSync(csvTmp, S.wsFixture);
    const browserCsv = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const pageCsv = await browserCsv.newPage();
      const clientCsv = await pageCsv.target().createCDPSession();
      await clientCsv.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      clientCsv.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await clientCsv.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardI({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await clientCsv.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await clientCsv.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await clientCsv.send('Network.setCookie', { name: 'ff_session', value: cookieValueI, domain: 'ff.local', path: '/', httpOnly: true });
      const waitCsv = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await pageCsv.goto(`http://ff.local/#invest-account/${csvUiAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitCsv(800);
      await pageCsv.click('[data-invest-import-csv]');
      const csvInput = await pageCsv.$('[data-invest-import-file]');
      await csvInput.uploadFile(csvTmp);
      await pageCsv.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 6, { timeout: 20000 });
      const csvPanel = await pageCsv.evaluate(() => {
        const host = document.querySelector('[data-invest-proposed]');
        return { text: host.textContent, rows: host.querySelectorAll('[data-ie-row]').length };
      });
      H.check('investments UI: Import CSV previews 6 events, the cash skip and the failed oversell',
        csvPanel.rows === 6 && csvPanel.text.includes('Skipped 1 cash rows') && csvPanel.text.includes('Already recorded: 0')
          && csvPanel.text.includes('cannot sell 9999 units'),
        JSON.stringify(csvPanel));
      await pageCsv.click('[data-invest-apply]');
      await pageCsv.waitForFunction(() => document.querySelector('#investHoldingsWrap').textContent.includes('XQQ.TO'), { timeout: 20000 });
      r = await H.req('GET', `/api/investments/accounts/${csvUiAcctId}`);
      const xqqUi = r.data.holdings.find((row) => row.holding.symbol === 'XQQ.TO');
      H.check('investments UI: applying the CSV preview stores the split-restated units',
        xqqUi && xqqUi.summary.units === 190,
        JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units])));
    } catch (err) {
      H.check('investments CSV browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserCsv.close();
    }

    // AI-mapped CSV import: a non-Wealthsimple broker shape (an
    // extra Note column keeps its fingerprint apart from the API
    // round's fixture below, so the two rounds stay independent).
    // The stubbed model proposes the mapping; the test confirms
    // it unchanged and applies the preview.
    fs.writeFileSync(H.aiStubFile, JSON.stringify({
      columns: { date: 'Date', symbol: 'Ticker', name: 'Description', activity: 'Txn', units: 'Shares', price: 'Price', amount: 'Amount', currency: 'Curr' },
      values: { Bought: 'buy', Sold: 'sell', Dividend: 'dividend', Fee: 'skip' },
      defaultCurrency: null,
      symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
      questions: [],
      reply: 'Mapped.',
    }));
    r = await H.req('POST', '/api/investments/accounts', { name: 'CSV map import UI', type: 'TFSA', institution: 'NorthTrade' });
    const mapUiAcctId = r.data.id;
    const mapTmp = path.join(os.tmpdir(), `ff-e2e-map-${Date.now()}.csv`);
    fs.writeFileSync(mapTmp, ['Date,Ticker,Description,Txn,Shares,Price,Amount,Curr,Note',
      '2026-02-02,ZWC,BMO fund,Bought,50,20,-1000,CAD,',
      '2026-02-03,ZWC,BMO fund,Sold,-10,22,220,CAD,',
      '2026-02-04,ZWC,BMO fund,Dividend,,,5.5,CAD,',
      '2026-02-05,ZWC,BMO fund,Fee,,,9.99,CAD,',
      '2026-02-06,MSFT,Microsoft,Bought,5,300,-1500,USD,'].join('\n'));
    const browserMap = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const pageMap = await browserMap.newPage();
      const clientMap = await pageMap.target().createCDPSession();
      await clientMap.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      clientMap.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await clientMap.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardI({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await clientMap.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await clientMap.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await clientMap.send('Network.setCookie', { name: 'ff_session', value: cookieValueI, domain: 'ff.local', path: '/', httpOnly: true });
      const waitMap = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await pageMap.goto(`http://ff.local/#invest-account/${mapUiAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitMap(800);
      await pageMap.click('[data-invest-import-csv-map]');
      const mapInput = await pageMap.$('[data-invest-import-map-file]');
      await mapInput.uploadFile(mapTmp);
      await pageMap.waitForFunction(() => !!document.querySelector('[data-map-confirm]'), { timeout: 20000 });
      await pageMap.click('[data-map-confirm]');
      await pageMap.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 4, { timeout: 20000 });
      const mapPanel = await pageMap.evaluate(() => {
        const host = document.querySelector('[data-invest-proposed]');
        return { text: host.textContent, rows: host.querySelectorAll('[data-ie-row]').length };
      });
      H.check('investments UI: AI-mapped CSV previews 4 events and the fee skip',
        mapPanel.rows === 4 && mapPanel.text.includes('Skipped 1 cash rows') && mapPanel.text.includes('Already recorded: 0'),
        JSON.stringify(mapPanel));
      await pageMap.click('[data-invest-apply]');
      await pageMap.waitForFunction(() => document.querySelector('#investHoldingsWrap').textContent.includes('ZWC.TO'), { timeout: 20000 });
      r = await H.req('GET', `/api/investments/accounts/${mapUiAcctId}`);
      const zwcUi = r.data.holdings.find((row) => row.holding.symbol === 'ZWC.TO');
      H.check('investments UI: applying the mapped preview stores 40 ZWC units with source csv-ai',
        zwcUi && zwcUi.summary.units === 40 && zwcUi.holding.source === 'csv-ai',
        JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units, row.holding.source])));
    } catch (err) {
      H.check('investments AI-mapped CSV browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserMap.close();
    }
  }
}

runModuleMain(import.meta.url, { name: 'investments', deps, depNames: [], run });
