// home: Home page — highlight carousel + insight carousels + AI append.
// Run standalone: node tests/e2e-home.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only home]
import http from 'node:http';
import fs from 'node:fs';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // ---- fixture: properties ----
  r = await H.req('POST', '/api/properties', {
    address: '1 Home Test Way, Coquitlam, BC', purchase_date: '2024-01-15',
    assessed_value: 1000000, assessed_year: 2026,
  });
  H.check('home fixture: assessed-only property created', r.status === 201, JSON.stringify(r.data));
  const pidA = r.data.id;
  r = await H.req('POST', '/api/properties', {
    address: '2 Home Test Way, Coquitlam, BC', purchase_date: '2020-01-15',
    mortgage_balance: 300000, assessed_value: 500000, assessed_year: 2026,
  });
  const pidB = r.data.id;
  // A 2025 assessment point for each property, so YoY deltas compute:
  // A was assessed higher in 2025 ($1.3M) than 2026 ($1.0M), so Total
  // equity's YoY is negative (a down move on a normal metric). The
  // 2026 points restate the create values (the create writes no
  // history rows), so the Nov 2026 totals are unchanged.
  for (const [pid, year, value] of [
    [pidA, 2025, 1300000], [pidA, 2026, 1000000],
    [pidB, 2025, 500000], [pidB, 2026, 500000],
  ]) {
    r = await H.req('POST', `/api/properties/${pid}/value-history`, { year, value });
    if (r.status !== 201) H.check(`home fixture: assessment ${year} $${value} for property ${pid}`, false, JSON.stringify(r.data));
  }
  await H.req('PUT', `/api/properties/${pidB}`, { mortgage_balance_date: '2025-01-15', amortization_years: 25 });
  r = await H.req('GET', `/api/properties/${pidB}`);
  await H.req('PUT', `/api/properties/${pidB}/terms/${r.data.terms[0].id}`, { term_months: 60, amortization_years: 25 });
  r = await H.req('POST', `/api/properties/${pidB}/rates`, {
    term_id: r.data.terms[0].id, start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  H.check('home fixture: mortgaged property has a fixed 5% segment', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${pidB}`);
  const outstandingB = r.data.remainingBalance;
  H.check('home fixture: mortgaged property projects a remaining balance',
    typeof outstandingB === 'number' && outstandingB > 0 && outstandingB < 300000, JSON.stringify(outstandingB));

  // ---- fixture: stocks (XQQ.TO, 100 units, $48 → $60 over 12 months) ----
  r = await H.req('POST', '/api/investments/accounts', { name: 'TFSA', type: 'TFSA' });
  const acctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${acctId}/holdings`, { label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', currency: 'CAD' });
  const hid = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${hid}/events`, { date: '2026-01-15', type: 'buy', units: 100, price: 50 });
  H.check('home fixture: XQQ buy recorded', r.status === 201, JSON.stringify(r.data));
  const navPoints = [
    ['2025-11-30', 48], ['2025-12-31', 49], ['2026-01-31', 50], ['2026-02-28', 51],
    ['2026-03-31', 52], ['2026-04-30', 53], ['2026-05-31', 54], ['2026-06-30', 55],
    ['2026-07-31', 56], ['2026-08-31', 57], ['2026-09-30', 58], ['2026-10-31', 59],
    // Nov 28, not Nov 30: the 1y return window prices the month at the
    // 28th (see returnSuggestionsFromPoints), so a Nov 30 point would
    // be excluded from the end price while still pricing the month-end
    // value at $60.
    ['2026-11-28', 60],
  ];
  for (const [date, price] of navPoints) {
    r = await H.req('POST', `/api/investments/holdings/${hid}/nav`, { date, price });
    if (r.status !== 201) { H.check(`home fixture: NAV ${date} @ ${price}`, false, JSON.stringify(r.data)); }
  }

  // ---- fixture: salary job + rental ----
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Acme Corp', currency: 'CAD', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-02', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
  });
  H.check('home fixture: biweekly job created', r.status === 201, JSON.stringify(r.data && r.data.calc && r.data.calc.perPeriod));
  const jobId = r.data.id;
  const cashNet = r.data.calc.perPeriod.cashNet;
  r = await H.req('POST', '/api/earnings/rentals', { label: 'Basement suite', rental_type: 'long_term', services_level: 'basic' });
  const rentalId = r.data.id;
  r = await H.req('POST', `/api/earnings/rentals/${rentalId}/entries`, { start_ym: '2026-01', monthly_rent: 2000, pay_day: 15 });
  // The entry-create response carries the rental row; the entry id
  // lives in its entries list (r.data.id is the rental id).
  const rentalEntryId = r.data.entries[0].id; // rental marks key by ENTRY id (user 2026-11-08), not the rental id
  H.check('home fixture: rental entry created', r.status === 201, JSON.stringify(r.data));

  // ---- fixture: RRSP plan on the same job (Fix 4) ----
  // A plan starting 2026-11-06 (the next payday) gives the job a tax
  // benefit, so the highlight must show the DISPLAYED take-home
  // (cashNet − benefit), not the benefit-inclusive cashNet. The
  // target holding has no price points, so plan generation skips
  // every due period — no buys, no stock impact. October is
  // untouched (the plan starts in November), so the Oct pins below
  // still use the creation-time cashNet.
  r = await H.req('POST', '/api/investments/accounts', { name: 'RRSP', type: 'RRSP' });
  const rrspId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${rrspId}/holdings`, { label: 'RRSP Fund', kind: 'fund', symbol: 'RRSPFUND', currency: 'CAD' });
  const fundId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${rrspId}/plans`, { job_id: jobId, target_holding_id: fundId, start_date: '2026-11-06', own_amount: 220.05, employer_amount: 0 });
  H.check('home fixture: RRSP plan created', r.status === 201, JSON.stringify(r.data));
  // (There is no GET /api/earnings/jobs/:id — the list endpoint
  // returns the same earnJobRow shape, calc + taxBenefit included.)
  r = await H.req('GET', '/api/earnings');
  const jobNow = (r.data.jobs || []).find((j) => j.id === jobId);
  const cashNetNew = jobNow.calc.perPeriod.cashNet;
  const benefitPerPeriod = jobNow.taxBenefit ? jobNow.taxBenefit.perPeriod : 0;
  const displayedCash = Math.round((cashNetNew - benefitPerPeriod) * 100) / 100;
  H.check('home fixture: plan gives the job a real tax benefit',
    benefitPerPeriod > 0 && displayedCash < cashNetNew, JSON.stringify({ cashNetNew, benefitPerPeriod, displayedCash }));

  // ---- fixture: spending ----
  r = await H.req('POST', '/api/spending/cards', { name: 'Visa', issuer: 'RBC', last4: '1234' });
  const cardId = r.data.id;
  const txs = [
    { date: '2026-10-05', merchant: 'SAVE ON', type: 'charge', amount: 400, category: 'Groceries' },
    { date: '2026-10-10', merchant: 'RESTAURANT', type: 'charge', amount: 300, category: 'Dining' },
    { date: '2026-09-05', merchant: 'SAVE ON', type: 'charge', amount: 200, category: 'Groceries' },
    { date: '2026-09-10', merchant: 'RESTAURANT', type: 'charge', amount: 100, category: 'Dining' },
  ];
  for (const t of txs) {
    r = await H.req('POST', `/api/spending/cards/${cardId}/transactions`, t);
    if (r.status !== 201) H.check(`home fixture: spending tx ${t.date} ${t.category}`, false, JSON.stringify(r.data));
  }

  // ---- API: GET /api/home generates the standard set ----
  r = await H.req('GET', '/api/home');
  H.check('home API: GET /api/home returns highlights + 12 system cards',
    r.status === 200 && r.data.insights.filter((c) => c.kind === 'system').length === 12 && r.data.highlights.length > 0,
    JSON.stringify({ insights: r.data.insights && r.data.insights.length, highlights: r.data.highlights && r.data.highlights.length }));
  const home = r.data;
  const card = (metric) => home.insights.find((c) => c.metric === metric);

  // Highlight: most recent first — Nov 6 salary (current), then Oct 23 salary, Oct 15 rent, Oct 9 salary,
  // plus the mortgaged property's monthly payment (Oct 15, and Nov 15 once it arrives).
  // "Today" is the real run date, so whether the Nov 15 row exists is read off the data itself.
  const hl = home.highlights;
  const nov15Arrived = hl.some((x) => x.kind === 'mortgage' && x.date === '2026-11-15');
  const salaryNov6 = hl.find((x) => x.kind === 'salary' && x.date === '2026-11-06');
  H.check('home API: current salary payday Nov 6 at the DISPLAYED take-home (cashNet − benefit)',
    salaryNov6 && salaryNov6.amount === displayedCash && salaryNov6.isCurrent === true,
    JSON.stringify(hl.slice(0, 3)));
  const rentCur = hl.find((x) => x.kind === 'rental' && x.isCurrent);
  H.check('home API: current rental occurrence is Oct 15 at $2,000',
    rentCur && rentCur.date === '2026-10-15' && rentCur.amount === 2000, JSON.stringify(rentCur));
  H.check('home API: highlight window is Oct + Nov only — 4 income rows + mortgage rows, no September rows',
    hl.length === 4 + (nov15Arrived ? 2 : 1)
    && hl.some((x) => x.kind === 'salary' && x.date === '2026-10-23' && x.received == null)
    && !hl.some((x) => x.date < '2026-10-01'),
    JSON.stringify(hl.map((x) => `${x.kind} ${x.date}`)));
  // The mortgaged property pays monthly on the 15th: $1,744.81 =
  // derivePayment(300000 @ 5% fixed, 25y, semi-annual).
  const mortOct = hl.find((x) => x.kind === 'mortgage' && x.date === '2026-10-15');
  H.check('home API: mortgage row Oct 15 at the per-period payment $1,744.81 (monthly)',
    mortOct && mortOct.amount === 1744.81 && mortOct.sourceId === pidB && mortOct.isCurrent === !nov15Arrived,
    JSON.stringify(mortOct));
  if (nov15Arrived) {
    const mortNov = hl.find((x) => x.kind === 'mortgage' && x.date === '2026-11-15');
    H.check('home API: mortgage row Nov 15 once it arrives',
      mortNov && mortNov.amount === 1744.81 && mortNov.isCurrent === true, JSON.stringify(mortNov));
  }

  // ---- API: GET /api/home/calendar ----
  // Same date sources as the highlight, but the month is not capped
  // at today: future dates inside the month show too.
  r = await H.req('GET', '/api/home/calendar?month=2026-10');
  const calOct = r.data.days || {};
  H.check('home API: calendar Oct 2026 marks salary Oct 9 + Oct 23, rent + mortgage Oct 15',
    r.status === 200 && r.data.month === '2026-10'
    && (calOct['2026-10-09'] || []).some((x) => x.kind === 'salary')
    && (calOct['2026-10-23'] || []).some((x) => x.kind === 'salary')
    && (calOct['2026-10-15'] || []).map((x) => x.kind).sort().join(',') === 'mortgage,rental',
    JSON.stringify(calOct));
  r = await H.req('GET', '/api/home/calendar?month=2026-11');
  const calNov = r.data.days || {};
  H.check('home API: calendar Nov 2026 marks salary Nov 6 + Nov 20 and the future Nov 15 rent + mortgage',
    r.status === 200 && r.data.month === '2026-11'
    && (calNov['2026-11-06'] || []).some((x) => x.kind === 'salary')
    && (calNov['2026-11-20'] || []).some((x) => x.kind === 'salary')
    && (calNov['2026-11-15'] || []).map((x) => x.kind).sort().join(',') === 'mortgage,rental',
    JSON.stringify(calNov));
  r = await H.req('GET', '/api/home/calendar?month=2025-01');
  H.check('home API: calendar Jan 2025 (before the job, rental, and mortgage) is empty',
    r.status === 200 && Object.keys(r.data.days || {}).length === 0, JSON.stringify(r.data.days));
  r = await H.req('GET', '/api/home/calendar');
  H.check('home API: calendar with no month defaults to the current month',
    r.status === 200 && r.data.month === '2026-11' && typeof r.data.today === 'string',
    JSON.stringify({ month: r.data.month, today: r.data.today }));
  r = await H.req('GET', '/api/home/calendar?month=2026-13');
  H.check('home API: calendar rejects a bad month', r.status === 400, JSON.stringify(r.data));

  // Standard cards: hand-computed from the fixture.
  H.check('home API: assessed total is $1,500,000 (Nov 2026)',
    card('property_assessed') && card('property_assessed').value === 1500000 && card('property_assessed').period === '2026-11',
    JSON.stringify(card('property_assessed')));
  H.check('home API: outstanding equals the property detail remaining balance',
    card('property_outstanding') && card('property_outstanding').value === outstandingB,
    JSON.stringify({ card: card('property_outstanding'), outstandingB }));
  H.check('home API: equity = assessed − outstanding',
    card('property_equity') && card('property_equity').value === 1500000 - outstandingB,
    JSON.stringify(card('property_equity')));
  H.check('home API: portfolio value $6,000 (100 × $60)',
    card('stock_value') && card('stock_value').value === 6000, JSON.stringify(card('stock_value')));
  H.check('home API: total gain $1,000 ($6,000 − $5,000 contributed)',
    card('stock_gain') && card('stock_gain').value === 1000, JSON.stringify(card('stock_gain')));
  H.check('home API: top gainer XQQ.TO +25% (60/48 − 1)',
    card('stock_top_gainer') && card('stock_top_gainer').value === 25 && card('stock_top_gainer').sublabel === 'XQQ.TO',
    JSON.stringify(card('stock_top_gainer')));
  const octSalary = 2 * cashNet;
  H.check('home API: salary take-home Oct 2026 = 2 paydays × cash take-home',
    card('earning_salary') && card('earning_salary').value === octSalary && card('earning_salary').period === '2026-10',
    JSON.stringify({ card: card('earning_salary'), octSalary, cashNet }));
  // November is pinned at unit level (displayedSalaryMonths, with
  // the fixture's own figures: Nov = $4,515.56 = 2 × displayedCash),
  // not here: the flow cards show the last completed month
  // (October), so no card exposes November today, and the
  // monthly-chart endpoint intentionally returns the raw engine
  // series — its net − taxBenefit is the per-payday figure
  // ($4,515.54), which sits 2¢ off the job page's annual-first
  // figure the cards use. Asserting equality there would fail
  // forever and test the wrong thing.
  H.check('home API: rental income Oct 2026 = $2,000; total income = salary + rent',
    card('earning_rental') && card('earning_rental').value === 2000
    && card('earning_total') && card('earning_total').value === octSalary + 2000,
    JSON.stringify({ rental: card('earning_rental'), total: card('earning_total') }));
  H.check('home API: total spend Oct 2026 = $700',
    card('spending_total') && card('spending_total').value === 700, JSON.stringify(card('spending_total')));
  H.check('home API: top category Groceries $400 (57.14% of Oct spend)',
    card('spending_top_category') && card('spending_top_category').value === 400
    && card('spending_top_category').sublabel === 'Groceries · 57.14% of spend',
    JSON.stringify(card('spending_top_category')));
  H.check('home API: biggest mover Groceries +$200 MoM',
    card('spending_biggest_mover') && card('spending_biggest_mover').value === 200
    && /Groceries/.test(card('spending_biggest_mover').sublabel),
    JSON.stringify(card('spending_biggest_mover')));

  // Equity MoM delta matches the overview chart's own series.
  r = await H.req('GET', '/api/overview/chart');
  const eqNov = r.data.propertyByMonth.find((x) => x.month === '2026-11');
  const eqOct = r.data.propertyByMonth.find((x) => x.month === '2026-10');
  H.check('home API: equity MoM delta equals the overview chart month change',
    eqNov && eqOct && card('property_equity').mom && card('property_equity').mom.delta === Math.round((eqNov.value - eqOct.value) * 100) / 100,
    JSON.stringify({ mom: card('property_equity').mom, eqNov, eqOct }));

  // ---- marks: rollover rule inside the window ----
  r = await H.req('POST', '/api/home/marks', { kind: 'salary', source_id: jobId, date: '2026-10-09', received: 1 });
  H.check('home marks: marking a past salary row succeeds', r.status === 200 && r.data.received === 1, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home marks: marked Oct 9 salary rolled off; Oct 23 + Oct 15 rent still shown',
    !r.data.highlights.some((x) => x.kind === 'salary' && x.date === '2026-10-09')
    && r.data.highlights.some((x) => x.kind === 'salary' && x.date === '2026-10-23')
    && r.data.highlights.some((x) => x.kind === 'rental' && x.date === '2026-10-15'),
    JSON.stringify(r.data.highlights.map((x) => x.date)));
  r = await H.req('POST', '/api/home/marks', { kind: 'rental', source_id: rentalEntryId, date: '2026-10-15', received: 1 });
  r = await H.req('GET', '/api/home');
  H.check('home marks: marking the CURRENT row keeps it, marked received',
    r.data.highlights.some((x) => x.kind === 'rental' && x.date === '2026-10-15' && x.received === 1),
    JSON.stringify(r.data.highlights.filter((x) => x.kind === 'rental')));
  // Mortgage marks: "Mark paid", same window + rollover rule. The Oct 15
  // mortgage payment is the current one until Nov 15 arrives, so marking
  // it keeps it (paid); once Nov 15 arrives it rolls off instead.
  r = await H.req('POST', '/api/home/marks', { kind: 'mortgage', source_id: pidB, date: '2026-10-15', received: 1 });
  H.check('home marks: marking a mortgage payment paid succeeds', r.status === 200 && r.data.received === 1, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  if (nov15Arrived) {
    H.check('home marks: marked Oct 15 mortgage rolled off once Nov 15 arrived',
      !r.data.highlights.some((x) => x.kind === 'mortgage' && x.date === '2026-10-15')
      && r.data.highlights.some((x) => x.kind === 'mortgage' && x.date === '2026-11-15'),
      JSON.stringify(r.data.highlights.filter((x) => x.kind === 'mortgage')));
  } else {
    H.check('home marks: marking the CURRENT mortgage row keeps it, marked paid',
      r.data.highlights.some((x) => x.kind === 'mortgage' && x.date === '2026-10-15' && x.received === 1),
      JSON.stringify(r.data.highlights.filter((x) => x.kind === 'mortgage')));
  }
  r = await H.req('POST', '/api/home/marks', { kind: 'mortgage', source_id: 999999, date: '2026-10-15', received: 1 });
  H.check('home marks: mortgage mark on an unknown property is a 404', r.status === 404, JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/marks', { kind: 'salary', source_id: jobId, date: '2026-11-06' });
  H.check('home marks: missing received is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/marks', { kind: 'salary', source_id: 999999, date: '2026-11-06', received: 1 });
  H.check('home marks: unknown source is a 404', r.status === 404, JSON.stringify(r.data));
  // Marks never change Earnings figures.
  r = await H.req('GET', `/api/earnings/jobs/${jobId}/monthly-chart`);
  const octIdx = r.data.months.indexOf('2026-10');
  H.check('home marks: earnings monthly chart unchanged by marks (Oct net = 2 × cash take-home)',
    octIdx >= 0 && r.data.net[octIdx] === octSalary, JSON.stringify({ months: r.data.months, net: r.data.net }));

  // ---- re-generate keeps AI cards out (none yet) and refreshes the set ----
  r = await H.req('POST', '/api/home/insights/generate', {});
  H.check('home generate: re-generate returns the 12 system cards',
    r.status === 200 && r.data.insights.filter((c) => c.kind === 'system').length === 12,
    JSON.stringify(r.data.insights && r.data.insights.length));

  // ---- reorder: drag order persists across reload + re-generate ----
  const orderKey = (c) => `${c.section}|${c.metric}|${c.title}`;
  r = await H.req('GET', '/api/home');
  const propOrder0 = r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric);
  H.check('home reorder: property section starts in natural order',
    JSON.stringify(propOrder0) === JSON.stringify(['property_equity', 'property_assessed', 'property_outstanding']),
    JSON.stringify(propOrder0));
  const propCards = r.data.insights.filter((c) => c.section === 'property');
  const draggedOrder = [propCards[1], propCards[0], propCards[2]].map(orderKey);
  r = await H.req('POST', '/api/home/insights/reorder', { section: 'property', order: draggedOrder });
  H.check('home reorder: posting a new order succeeds and echoes it',
    r.status === 200 && JSON.stringify(r.data.order) === JSON.stringify(draggedOrder), JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home reorder: the dragged order persists across reload',
    JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric))
    === JSON.stringify(['property_assessed', 'property_equity', 'property_outstanding']),
    JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric)));
  r = await H.req('POST', '/api/home/insights/generate', {});
  r = await H.req('GET', '/api/home');
  H.check('home reorder: re-generate refreshes values but keeps the custom order',
    JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric))
    === JSON.stringify(['property_assessed', 'property_equity', 'property_outstanding']),
    JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric)));
  r = await H.req('POST', '/api/home/insights/reorder', { section: 'property', order: ['bogus|key', ...draggedOrder] });
  H.check('home reorder: unknown keys are filtered out, known order kept',
    r.status === 200 && JSON.stringify(r.data.order) === JSON.stringify(draggedOrder), JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/insights/reorder', { section: 'nope', order: draggedOrder });
  H.check('home reorder: unknown section is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/insights/reorder', { section: 'property', order: 'not-an-array' });
  H.check('home reorder: non-array order is a 400', r.status === 400, JSON.stringify(r.data));
  // Restore the natural order so the browser pins below start from it.
  r = await H.req('POST', '/api/home/insights/reorder', { section: 'property', order: propCards.map(orderKey) });
  H.check('home reorder: restoring the natural order succeeds', r.status === 200, JSON.stringify(r.data));

  // ---- AI-append: propose → Apply → exactly one → Delete; system cards protected ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'property', title: 'Test home equity', metric: `property_equity:${pidA}` } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me the first property equity', history: [] });
  H.check('home AI: append proposes the per-property equity card',
    r.status === 200 && r.data.proposal && r.data.proposal.metric === `property_equity:${pidA}` && r.data.proposal.title === 'Test home equity',
    JSON.stringify(r.data));
  const proposal = r.data.proposal;
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: proposal });
  H.check('home AI: Apply appends exactly one AI card with the computed value',
    r.status === 201 && r.data.insight && r.data.insight.kind === 'ai' && r.data.insight.value === 1000000,
    JSON.stringify(r.data));
  H.check('home AI: appended card stores its entity ref (property + id)',
    r.data.insight && JSON.stringify(r.data.insight.entity) === JSON.stringify({ kind: 'property', id: pidA }),
    JSON.stringify(r.data.insight && r.data.insight.entity));
  const aiId = r.data.insight.id;
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: proposal });
  H.check('home AI: second Apply on the same turn does not double-append',
    r.status === 200 && r.data.duplicate === true, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home AI: exactly one AI card on the page after double Apply',
    r.data.insights.filter((c) => c.kind === 'ai').length === 1, JSON.stringify(r.data.insights.filter((c) => c.kind === 'ai')));
  const sysId = r.data.insights.find((c) => c.kind === 'system').id;
  r = await H.req('DELETE', `/api/home/insights/${sysId}`);
  H.check('home AI: system cards cannot be deleted', r.status === 400, JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/home/insights/${aiId}`);
  H.check('home AI: AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home AI: AI card gone after delete', r.data.insights.filter((c) => c.kind === 'ai').length === 0, JSON.stringify(r.data.insights.length));

  // ---- AI-append: per-job take-home card stores its entity ref ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'earning', title: 'Acme take-home', metric: `job_takehome:${jobId}` } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me the Meta take-home', history: [] });
  H.check('home AI: append proposes the per-job take-home card',
    r.status === 200 && r.data.proposal && r.data.proposal.metric === `job_takehome:${jobId}`,
    JSON.stringify(r.data));
  const jobProposal = r.data.proposal;
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: jobProposal });
  H.check('home AI: per-job card stores its entity ref and the October take-home',
    r.status === 201 && r.data.insight && r.data.insight.kind === 'ai'
      && JSON.stringify(r.data.insight.entity) === JSON.stringify({ kind: 'job', id: jobId })
      && r.data.insight.value === octSalary && r.data.insight.period === '2026-10',
    JSON.stringify(r.data));
  const jobAiId = r.data.insight.id;
  r = await H.req('DELETE', `/api/home/insights/${jobAiId}`);
  H.check('home AI: per-job AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home API: standard cards carry no entity ref (they fall back to the section link)',
    r.data.insights.filter((c) => c.kind === 'system').every((c) => c.entity === undefined),
    JSON.stringify(r.data.insights.filter((c) => c.kind === 'system').map((c) => c.entity)));

  // ---- AI-append: account-level stock metrics (the Wealthsimple / RRSP / TFSA gap) ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'stock', title: 'TFSA value', metric: `account_value:${acctId}` } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me the Wealthsimple account value', history: [] });
  H.check('home AI: append proposes the per-account value card',
    r.status === 200 && r.data.proposal && r.data.proposal.metric === `account_value:${acctId}`,
    JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: r.data.proposal });
  H.check('home AI: per-account card carries the account ref and its real value ($6,000)',
    r.status === 201 && r.data.insight && r.data.insight.value === 6000
      && JSON.stringify(r.data.insight.entity) === JSON.stringify({ kind: 'account', id: acctId }),
    JSON.stringify(r.data));
  const acctAiId = r.data.insight.id;
  r = await H.req('DELETE', `/api/home/insights/${acctAiId}`);
  H.check('home AI: per-account AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'stock', title: 'TFSA gain', metric: `account_gain:${acctId}` } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me the TFSA gain', history: [] });
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: r.data.proposal });
  H.check('home AI: per-account gain card is $1,000 ($6,000 − $5,000 contributed)',
    r.status === 201 && r.data.insight && r.data.insight.value === 1000, JSON.stringify(r.data));
  const gainAiId = r.data.insight.id;
  r = await H.req('DELETE', `/api/home/insights/${gainAiId}`);
  H.check('home AI: per-account gain card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'stock', title: 'TFSA accounts value', metric: 'account_type_value:TFSA' } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me all TFSA value', history: [] });
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: r.data.proposal });
  H.check('home AI: all-TFSA card sums the TFSA accounts ($6,000) and links to the Stocks page',
    r.status === 201 && r.data.insight && r.data.insight.value === 6000
      && JSON.stringify(r.data.insight.entity) === JSON.stringify({ kind: 'account_type', id: 'TFSA' }),
    JSON.stringify(r.data));
  const typeAiId = r.data.insight.id;
  r = await H.req('DELETE', `/api/home/insights/${typeAiId}`);
  H.check('home AI: all-TFSA AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  // The RRSP account holds only the unpriced plan-target fund: the
  // summed RRSP value is honestly $0, not "no data".
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'stock', title: 'RRSP accounts value', metric: 'account_type_value:RRSP' } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me all RRSP value', history: [] });
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: r.data.proposal });
  H.check('home AI: all-RRSP card is $0 (the RRSP account holds only the unpriced fund)',
    r.status === 201 && r.data.insight && r.data.insight.value === 0, JSON.stringify(r.data));
  const rrspAiId = r.data.insight.id;
  r = await H.req('DELETE', `/api/home/insights/${rrspAiId}`);
  H.check('home AI: all-RRSP AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

  // ---- AI-append: per-period take-home ("meta bi-weekly pay") ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'earning', title: 'Acme per-period take-home', metric: `job_takehome_period:${jobId}` } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me the meta bi-weekly pay', history: [] });
  H.check('home AI: append proposes the per-period take-home card',
    r.status === 200 && r.data.proposal && r.data.proposal.metric === `job_takehome_period:${jobId}`,
    JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: r.data.proposal });
  H.check('home AI: per-period card shows the latest payday (Nov 6) at the DISPLAYED per-period cash',
    r.status === 201 && r.data.insight && r.data.insight.value === displayedCash && r.data.insight.period === '2026-11'
      && JSON.stringify(r.data.insight.entity) === JSON.stringify({ kind: 'job', id: jobId }),
    JSON.stringify(r.data));
  H.check('home AI: per-period card deltas vs the previous payday (Oct 23, no plan yet)',
    r.data.insight && r.data.insight.mom && r.data.insight.mom.delta === Math.round((displayedCash - cashNet) * 100) / 100
      && r.data.insight.momVs === 'Oct 23, 2026' && r.data.insight.periodLabel === 'Nov 6, 2026',
    JSON.stringify(r.data.insight && { mom: r.data.insight.mom, momVs: r.data.insight.momVs, periodLabel: r.data.insight.periodLabel }));
  const periodAiId = r.data.insight.id;
  r = await H.req('DELETE', `/api/home/insights/${periodAiId}`);
  H.check('home AI: per-period AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

  // ---- AI-append: the decline path still works for uncomputable requests ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ decline: 'I cannot forecast next year.' }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Forecast next year', history: [] });
  H.check('home AI: a genuinely uncomputable request still declines',
    r.status === 200 && r.data.decline === 'I cannot forecast next year.', JSON.stringify(r.data));

  // ---- browser: default landing, carousels with peek, toggle persists ----
  if (!H.chromeAvailable) {
    H.check('home UI: skipped (no Chrome)', true, 'no chrome');
    return;
  }
  const forwardH = (rq) => new Promise((resolve, reject) => {
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
  const loginRes = await fetch(H.BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
  const browser = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
  });
  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept()); // confirm() on AI-card Delete
    const client = await page.target().createCDPSession();
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    // Veil pin gate (2026-11-08): holding POST /api/home/insights/generate
    // while Re-generate runs, so the global loading veil's 200ms
    // delay elapses before the generate completes.
    let genGate = null; // null | 'hold'
    const genHeld = [];
    const releaseGenHeld = async () => {
      const items = genHeld.splice(0);
      for (const e of items) {
        const u = new URL(e.request.url);
        const headers = {};
        for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
        const resp = await forwardH({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
        const respHeaders = Object.entries(resp.headers)
          .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) }));
        await client.send('Fetch.fulfillRequest', {
          requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
          body: resp.body.toString('base64'),
        });
      }
    };
    client.on('Fetch.requestPaused', async (e) => {
      try {
        const u = new URL(e.request.url);
        if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
        if (genGate === 'hold' && u.pathname === '/api/home/insights/generate' && e.request.method === 'POST') { genHeld.push(e); return; }
        const headers = {};
        for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
        const resp = await forwardH({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
        const respHeaders = Object.entries(resp.headers)
          .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) }));
        await client.send('Fetch.fulfillRequest', {
          requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders, body: resp.body.toString('base64'),
        });
      } catch {
        try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
      }
    });
    await client.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const until = async (fn, tries = 48) => {
      for (let i = 0; i < tries; i++) {
        try { const v = await page.evaluate(fn); if (v) return v; } catch {}
        await wait(250);
      }
      return null;
    };
    // Fresh #home entries land in report mode; every pin below that
    // needs the insight carousels calls this after its goto/reload.
    // It waits for the Home DOM, flips the toggle if report mode is
    // showing, then waits for the insight carousels to be visible.
    const toInsight = async () => {
      await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0
        || document.querySelectorAll('.report-section').length > 0);
      await page.evaluate(() => {
        if (document.querySelector('#view-home').classList.contains('home-report')) document.querySelector('#homeModeBtn').click();
      });
      await until(() => !document.querySelector('#view-home').classList.contains('home-report')
        && document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    };

    // Default landing: no hash → Home.
    await page.goto('http://ff.local/', { waitUntil: 'networkidle0', timeout: 30000 });
    const landedHome = await until(() => {
      const v = document.querySelector('#view-home');
      return v && !v.classList.contains('hidden') && document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0;
    });
    H.check('home UI: opening the app lands on Home with highlight cards', !!landedHome,
      await page.evaluate(() => document.querySelector('#view-home') ? document.querySelector('#view-home').className : 'no view-home'));
    const navLinks = await page.evaluate(() => [...document.querySelectorAll('#mainNav a')].filter((a) => !a.classList.contains('hidden')).map((a) => a.textContent).join(','));
    H.check('home UI: there is no Home tab in the top nav — Home is entered only via the brand',
      await page.evaluate(() => document.querySelector('#mainNav a[data-nav="home"]') === null)
      // Admin is a pre-existing seventh link, shown only to admin users.
      && (navLinks === 'Assets,Earnings,Spending,Planning,History,Tax' || navLinks === 'Assets,Earnings,Spending,Planning,History,Tax,Admin'),
      navLinks);

    // ---- report mode: the default landing ----
    // Every fresh #home entry lands in report mode: 5 sections in
    // order (Upcoming payments, Property, Stocks, Earning, Spending),
    // one big vertical card per page in a 3D carousel on a gradient,
    // with a toggle to insight mode. The calendar stays in insight
    // mode, so it is pinned in the toInsight() section below.
    H.check('home UI: report mode is the default landing on a fresh entry',
      await page.evaluate(() => {
        const v = document.querySelector('#view-home');
        return v && v.classList.contains('home-report') && getComputedStyle(document.querySelector('#homeReport')).display !== 'none';
      }), await page.evaluate(() => document.querySelector('#view-home') ? document.querySelector('#view-home').className : 'no view-home'));
    const reportSections = await page.evaluate(() => [...document.querySelectorAll('.report-section')].map((s) => ({
      title: s.querySelector('.report-section-title').textContent,
      slots: s.querySelectorAll('.report-slot').length, active: s.classList.contains('is-active'),
    })));
    H.check('home UI: report mode shows the 5 sections in order, Upcoming payments first and active',
      reportSections.length === 5
      && reportSections.map((s) => s.title.replace(/\d+ \/ 5$/, '')).join('|') === 'Upcoming payments|Property|Stocks|Earning|Spending'
      && reportSections[0].active && reportSections[0].slots > 0,
      JSON.stringify(reportSections));
    // The section name is a big title in report mode (not the old
    // small gray label) and sits clear of the viewport's top edge.
    const reportTitle = await page.evaluate(() => {
      const t = document.querySelector('.report-section.is-active .report-section-title');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        px: parseFloat(cs.fontSize), weight: cs.fontWeight, top: r.top, left: r.left,
        bottom: r.bottom, inView: r.top >= 0 && r.bottom <= window.innerHeight,
        pos: t.querySelector('.report-section-pos') ? t.querySelector('.report-section-pos').textContent : null,
      };
    });
    H.check('home UI: report-mode section title is a large title, fully inside the viewport with room at the top',
      reportTitle && reportTitle.px >= 26 && reportTitle.top >= 16 && reportTitle.inView
      && reportTitle.pos && reportTitle.pos.includes('1 / 5'),
      JSON.stringify(reportTitle));
    const reportStyle = await page.evaluate(() => {
      const v = document.querySelector('#view-home');
      const slot = document.querySelector('.report-section.is-active .report-slot.is-active');
      const cs = slot ? getComputedStyle(slot) : null;
      return {
        gradient: getComputedStyle(v).backgroundImage,
        reflect: cs ? cs.webkitBoxReflect : null,
        shadow: cs ? cs.boxShadow : null,
        sectionTransition: getComputedStyle(document.querySelector('.report-section')).transitionDuration,
      };
    });
    H.check('home UI: report mode has the gradient background, the active card carries the ground reflection + shadow, and sections transition visibly',
      reportStyle.gradient.includes('linear-gradient')
      && reportStyle.reflect && reportStyle.reflect.startsWith('below')
      && reportStyle.shadow && reportStyle.shadow !== 'none'
      && reportStyle.sectionTransition.includes('0.55s'),
      JSON.stringify(reportStyle));
    // A long press in report mode does NOT enter edit mode (reorder
    // stays in insight mode). The active card is the Nov 6 salary
    // row, which has no link, so the trailing click navigates
    // nowhere.
    const reportStage = await page.evaluate(() => {
      const el = document.querySelector('#homeReport');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(reportStage.x, reportStage.y);
    await page.mouse.down();
    await wait(700);
    await page.mouse.up();
    H.check('home UI: long-press in report mode does not enter edit mode and does not navigate',
      await page.evaluate(() => !document.querySelector('#view-home').classList.contains('home-edit-mode')
        && ['', '#home'].includes(location.hash)),
      await page.evaluate(() => `${document.querySelector('#view-home').className} ${location.hash}`));
    // Wheel down moves to the next section (Property); the section
    // slides, it never jumps.
    await page.mouse.wheel({ deltaY: 120 });
    await wait(700); // the 600ms navigation lock
    const afterDown = await until(() => {
      const s = document.querySelector('.report-section.is-active');
      return s && s.dataset.reportSection === 'property' ? s.querySelector('.report-section-pos').textContent : null;
    });
    H.check('home UI: scrolling down in report mode moves to the Property section', !!afterDown && afterDown.includes('2 / 5'), String(afterDown));
    // Wheel right moves to the next card in the section (Total equity
    // → Assessed total); wheel left comes back.
    await page.mouse.wheel({ deltaX: 120 });
    await wait(700); // the 600ms navigation lock
    const afterRight = await until(() => {
      const s = document.querySelector('.report-section.is-active .report-slot.is-active');
      return s && s.querySelector('.insight-label').textContent === 'Assessed total' ? 'Assessed total' : null;
    });
    H.check('home UI: scrolling right in report mode moves to the next card', !!afterRight, String(afterRight));
    await page.mouse.wheel({ deltaX: -120 });
    await wait(700); // the 600ms navigation lock
    const afterLeft = await until(() => {
      const s = document.querySelector('.report-section.is-active .report-slot.is-active');
      return s && s.querySelector('.insight-label').textContent === 'Total equity' ? 'Total equity' : null;
    });
    H.check('home UI: scrolling left in report mode moves back to the previous card', !!afterLeft, String(afterLeft));
    // Entering a section resets its carousel to the first card: step
    // to Property's second card, move down to Stocks, and Stocks must
    // open on its first card (Portfolio value) with the first dot
    // active — not on the card index carried over from Property.
    // Moving back up resets Property to its first card too.
    await page.mouse.wheel({ deltaX: 120 });
    await wait(700); // the 600ms navigation lock
    const resetCard = await until(() => {
      const s = document.querySelector('.report-section.is-active .report-slot.is-active');
      return s && s.querySelector('.insight-label').textContent === 'Assessed total' ? 'Assessed total' : null;
    });
    H.check('home UI: scrolling right again reaches the second Property card (setup for the reset pin)', !!resetCard, String(resetCard));
    await page.keyboard.press('ArrowDown');
    await wait(700); // the 600ms navigation lock
    const resetDown = await until(() => {
      const sec = document.querySelector('.report-section.is-active');
      if (!sec || sec.dataset.reportSection !== 'stock') return null;
      const slot = sec.querySelector('.report-slot.is-active');
      const dot = sec.querySelector('.report-dot.is-active');
      return slot && slot.querySelector('.insight-label').textContent === 'Portfolio value'
        && dot && dot.dataset.reportDot === '0' ? 'Portfolio value · dot 0' : null;
    });
    H.check('home UI: moving down to a new section resets its carousel to the first card with the first dot active', !!resetDown, String(resetDown));
    await page.keyboard.press('ArrowUp');
    await wait(700); // the 600ms navigation lock
    const resetUp = await until(() => {
      const sec = document.querySelector('.report-section.is-active');
      if (!sec || sec.dataset.reportSection !== 'property') return null;
      const slot = sec.querySelector('.report-slot.is-active');
      const dot = sec.querySelector('.report-dot.is-active');
      return slot && slot.querySelector('.insight-label').textContent === 'Total equity'
        && dot && dot.dataset.reportDot === '0' ? 'Total equity · dot 0' : null;
    });
    H.check('home UI: moving back up resets the previous section to its first card too', !!resetUp, String(resetUp));
    // Arrow keys navigate too.
    await page.keyboard.press('ArrowDown');
    await wait(700); // the 600ms navigation lock
    const afterKeyDown = await until(() => {
      const s = document.querySelector('.report-section.is-active');
      return s && s.dataset.reportSection === 'stock' ? s.dataset.reportSection : null;
    });
    H.check('home UI: ArrowDown in report mode moves to the next section', !!afterKeyDown, String(afterKeyDown));
    await page.keyboard.press('ArrowUp');
    await wait(700); // the 600ms navigation lock
    const afterKeyUp = await until(() => {
      const s = document.querySelector('.report-section.is-active');
      return s && s.dataset.reportSection === 'property' ? s.dataset.reportSection : null;
    });
    H.check('home UI: ArrowUp in report mode moves to the previous section', !!afterKeyUp, String(afterKeyUp));
    // Wheel up returns to Upcoming payments; the Received toggle
    // works on the report-mode highlight card (Nov 6 salary, first
    // card, unmarked at this point). Toggling it back off restores
    // the state the insight-mode pins below expect.
    await page.mouse.wheel({ deltaY: -120 });
    await wait(700); // the 600ms navigation lock
    const backToHl = await until(() => {
      const s = document.querySelector('.report-section.is-active');
      return s && s.dataset.reportSection === 'highlight' ? 'highlight' : null;
    });
    H.check('home UI: scrolling up in report mode returns to Upcoming payments', !!backToHl, String(backToHl));
    await page.evaluate(() => { document.querySelector('.report-section.is-active .report-slot.is-active [data-mark-kind]').click(); });
    const reportToggled = await until(() => {
      const b = document.querySelector('.report-section.is-active .report-slot.is-active [data-mark-kind]');
      return b && b.textContent.includes('Received') ? b.textContent : null;
    });
    H.check('home UI: the Received toggle works on a report-mode highlight card', !!reportToggled, String(reportToggled));
    await page.evaluate(() => { document.querySelector('.report-section.is-active .report-slot.is-active [data-mark-kind]').click(); });
    const reportUntoggled = await until(() => {
      const b = document.querySelector('.report-section.is-active .report-slot.is-active [data-mark-kind]');
      return b && b.textContent.includes('Mark received') ? b.textContent : null;
    });
    H.check('home UI: toggling the report-mode card back off restores its Mark received state', !!reportUntoggled, String(reportUntoggled));
    // The toggle switches to insight mode and back; a fresh entry
    // always lands in report mode again.
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    const inInsight = await until(() => !document.querySelector('#view-home').classList.contains('home-report')
      && getComputedStyle(document.querySelector('#homeReport')).display === 'none'
      && document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    H.check('home UI: the toggle switches to insight mode (report stage hides, carousels show)', !!inInsight,
      await page.evaluate(() => document.querySelector('#view-home').className));
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    const backInReport = await until(() => document.querySelector('#view-home').classList.contains('home-report')
      && document.querySelectorAll('.report-section').length === 5);
    H.check('home UI: the toggle switches back to report mode', !!backInReport,
      await page.evaluate(() => document.querySelector('#view-home').className));
    // A fresh entry (page reload) always lands in report mode, even
    // when the visit before it ended in insight mode.
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    await until(() => !document.querySelector('#view-home').classList.contains('home-report'));
    await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
    const freshReport = await until(() => document.querySelector('#view-home').classList.contains('home-report')
      && document.querySelectorAll('.report-section').length === 5);
    H.check('home UI: a fresh #home entry always lands in report mode', !!freshReport,
      await page.evaluate(() => document.querySelector('#view-home').className));
    // Report-mode charts: on a FRESH load every insight card's canvas
    // has a drawn chart. The report draw used to run before the
    // report DOM was built and #homeReport was visible, so the fresh
    // load showed blank cards — only toggling away and back fixed it.
    const freshCharts = await until(() => {
      const cs = [...document.querySelectorAll('#homeReport canvas[data-spark]')];
      if (!cs.length) return null;
      const withChart = cs.filter((c) => !!Chart.getChart(c)).length;
      return withChart === cs.length ? { total: cs.length, withChart } : null;
    });
    H.check('home UI: report-mode cards draw their charts on a fresh load (no blank canvases)',
      !!freshCharts, JSON.stringify(freshCharts));
    // The big report cards carry a DETAILED chart: month labels on
    // the x-axis, value gridlines/labels on the y-axis, the same blue
    // curve as the insight mini sparkline. A flat series (assessed
    // total) repeats one y label — only moving series must show
    // distinct labels.
    const reportDetail = await until(() => {
      const cs = [...document.querySelectorAll('#homeReport canvas[data-spark]')];
      if (!cs.length) return null;
      const out = [];
      for (const canvas of cs) {
        const ch = Chart.getChart(canvas);
        if (!ch) return null;
        const ctx = canvas.getContext('2d');
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let blue = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - 22) < 45 && Math.abs(d[i + 1] - 104) < 45 && Math.abs(d[i + 2] - 196) < 45 && d[i + 3] > 100) blue++;
        }
        const vals = JSON.parse(canvas.dataset.spark || '[]').filter((v) => v != null);
        out.push({
          xShown: ch.options.scales.x.display, yShown: ch.options.scales.y.display,
          yGrid: ch.options.scales.y.grid.display !== false,
          xLabels: ch.scales.x.ticks.map((t) => t.label),
          yLabels: ch.scales.y.ticks.map((t) => t.label),
          blue, range: vals.length ? Math.max(...vals) - Math.min(...vals) : 0,
        });
      }
      return out;
    });
    H.check('home UI: the report-mode chart is detailed — month labels on the x-axis, value gridlines/labels on the y-axis, blue curve drawn',
      reportDetail && reportDetail.every((c) => c.xShown && c.yShown && c.yGrid && c.blue > 50
        && c.xLabels.some((l) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}$/.test(l))
        && (c.range === 0 || new Set(c.yLabels).size > 1)),
      JSON.stringify(reportDetail && reportDetail.map((c) => ({ x: c.xLabels.slice(0, 2), y: c.yLabels.slice(0, 2), blue: c.blue, range: c.range }))));
    // Report-mode payment cards carry a calendar for the card's own
    // month, with that payment's day filled in its kind colour. The
    // calendar needs room, so these pins run at 1280x800 (restored
    // to 800x600 right after).
    await page.setViewport({ width: 1280, height: 800 });
    await wait(300);
    const reportCal = await until(() => {
      const slot = document.querySelector('.report-section.is-active .report-slot.is-active .home-pay-card');
      const cal = slot && slot.querySelector('.report-cal .home-cal-grid');
      if (!cal || !cal.children.length) return null;
      const day = slot.querySelector('.home-cal-day.is-focus');
      if (!day) return null;
      return {
        payDate: slot.dataset.payDate, kind: slot.dataset.payKind,
        title: slot.querySelector('.home-cal-title').textContent,
        focusDate: day.dataset.calDate, focusClass: day.className,
        nav: !!slot.querySelector('[data-cal-nav]'),
        tabbable: !!slot.querySelector('.home-cal-day[tabindex]'),
      };
    });
    const calMonth = reportCal && reportCal.payDate
      ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(reportCal.payDate.split('-')[1]) - 1]} ${reportCal.payDate.split('-')[0]}` : null;
    H.check('home UI: report-mode payment card contains a calendar for the payment month, no nav, days not focusable',
      !!reportCal && reportCal.title === calMonth && !reportCal.nav && !reportCal.tabbable,
      JSON.stringify({ reportCal, calMonth }));
    H.check('home UI: report-mode payment card highlights its own payment day in its kind colour',
      !!reportCal && reportCal.focusDate === reportCal.payDate
      && reportCal.focusClass.includes('is-focus') && reportCal.focusClass.includes(`kind-${reportCal.kind}`),
      JSON.stringify(reportCal));
    // The calendar fits inside its card (no overflow past the card edge).
    const calFit = await page.evaluate(() => {
      const card = document.querySelector('.report-section.is-active .report-slot.is-active .home-pay-card');
      const cal = card && card.querySelector('.report-cal');
      if (!card || !cal) return null;
      const cr = card.getBoundingClientRect();
      const r = cal.getBoundingClientRect();
      return { cardTop: cr.top, cardBottom: cr.bottom, calTop: r.top, calBottom: r.bottom };
    });
    H.check('home UI: report-mode payment calendar fits inside its card',
      !!calFit && calFit.calTop >= calFit.cardTop - 1 && calFit.calBottom <= calFit.cardBottom + 1,
      JSON.stringify(calFit));
    // Moving to the next payment card follows it: the new card's
    // calendar shows ITS month with ITS day focused.
    await page.keyboard.press('ArrowRight');
    await wait(700); // the 600ms navigation lock
    const reportCalNext = await until(() => {
      const slot = document.querySelector('.report-section.is-active .report-slot.is-active .home-pay-card');
      const cal = slot && slot.querySelector('.report-cal .home-cal-grid');
      if (!cal || !cal.children.length) return null;
      const day = slot.querySelector('.home-cal-day.is-focus');
      if (!day) return null;
      return {
        payDate: slot.dataset.payDate, kind: slot.dataset.payKind,
        title: slot.querySelector('.home-cal-title').textContent,
        focusDate: day.dataset.calDate, focusClass: day.className,
      };
    });
    const calMonthNext = reportCalNext && reportCalNext.payDate
      ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(reportCalNext.payDate.split('-')[1]) - 1]} ${reportCalNext.payDate.split('-')[0]}` : null;
    H.check('home UI: moving to the next payment card moves its calendar to that payment month + day',
      !!reportCalNext && reportCalNext.payDate !== (reportCal && reportCal.payDate)
      && reportCalNext.title === calMonthNext && reportCalNext.focusDate === reportCalNext.payDate
      && reportCalNext.focusClass.includes('is-focus'),
      JSON.stringify({ reportCalNext, calMonthNext }));
    await page.setViewport({ width: 800, height: 600 });
    await wait(300);
    // Fullscreen report mode: the top bar hides and the gradient
    // view covers the whole viewport, no page margins.
    const full = await page.evaluate(() => {
      const v = document.querySelector('#view-home');
      const r = v.getBoundingClientRect();
      return { topbar: getComputedStyle(document.querySelector('.topbar')).display,
        bodyFull: document.body.classList.contains('report-full'),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight } };
    });
    H.check('home UI: report mode is fullscreen — top bar hidden, gradient view covers the viewport',
      full.topbar === 'none' && full.bodyFull
      && full.rect.x === 0 && full.rect.y === 0 && full.rect.w === full.rect.vw && full.rect.h === full.rect.vh,
      JSON.stringify(full));
    // The Report / Insight toggle switch works both ways (knob +
    // active label follow the mode); the floating toggle stays
    // reachable in fullscreen.
    const toggleToInsight = await page.evaluate(() => {
      document.querySelector('#homeModeBtn').click();
      return null;
    });
    const inInsightByToggle = await until(() => !document.querySelector('#view-home').classList.contains('home-report')
      && document.querySelector('#homeModeBtn').getAttribute('aria-checked') === 'false'
      && document.querySelector('.home-mode-label[data-mode-label="insight"]').classList.contains('is-active')
      && getComputedStyle(document.querySelector('.topbar')).display !== 'none');
    H.check('home UI: the toggle switch flips report mode to insight mode (top bar back, Insight label active)',
      !!inInsightByToggle, JSON.stringify(inInsightByToggle));
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    const backInReportByToggle = await until(() => document.querySelector('#view-home').classList.contains('home-report')
      && document.querySelector('#homeModeBtn').getAttribute('aria-checked') === 'true'
      && document.querySelector('.home-mode-label[data-mode-label="report"]').classList.contains('is-active'));
    H.check('home UI: the toggle switch flips back to report mode (Report label active)',
      !!backInReportByToggle, JSON.stringify(backInReportByToggle));
    // Every report chart stays inside its own card — the curve and
    // its axis labels never spill below the card's bottom edge.
    const chartBounds = await page.evaluate(() => {
      const bad = [];
      for (const canvas of document.querySelectorAll('#homeReport canvas[data-spark]')) {
        const card = canvas.closest('.insight-card');
        const cr = canvas.getBoundingClientRect();
        const kr = card.getBoundingClientRect();
        if (cr.top < kr.top - 1 || cr.bottom > kr.bottom + 1 || cr.left < kr.left - 1 || cr.right > kr.right + 1) {
          bad.push({ card: card.querySelector('.insight-label').textContent, canvas: cr.bottom, cardBottom: kr.bottom });
        }
      }
      return bad;
    });
    H.check('home UI: every report-mode chart stays inside its card bounds', chartBounds.length === 0, JSON.stringify(chartBounds));
    // Report-mode deltas read at a glance: MoM/YoY text renders
    // larger than the small insight-mode chips (measured again below
    // in insight mode). The Total equity YoY is negative here, so its
    // YoY line is the down color.
    const reportDeltaPx = await page.evaluate(() => {
      const el = document.querySelector('#homeReport .insight-card .delta');
      const yoy = [...document.querySelectorAll('.report-section[data-report-section="property"] .insight-card')]
        .find((c) => c.querySelector('.insight-label').textContent.includes('Total equity'))
        .querySelector('.delta-yoy');
      return { deltaPx: parseFloat(getComputedStyle(el).fontSize),
        yoyColor: getComputedStyle(yoy).color, yoyClass: yoy.className };
    });
    H.check('home UI: report-mode YoY on Total equity (negative YoY) renders in the down color',
      reportDeltaPx.yoyColor === 'rgb(179, 38, 30)' && reportDeltaPx.yoyClass.includes('bad'),
      JSON.stringify(reportDeltaPx));
    // Esc exits fullscreen report mode back to insight mode.
    await page.keyboard.press('Escape');
    const escOut = await until(() => !document.querySelector('#view-home').classList.contains('home-report')
      && !document.body.classList.contains('report-full')
      && getComputedStyle(document.querySelector('.topbar')).display !== 'none'
      && document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    H.check('home UI: Esc exits fullscreen report mode to insight mode (top bar back)', !!escOut,
      await page.evaluate(() => document.querySelector('#view-home').className));
    // Insight mode from here on: every pin below needs the insight
    // carousels.
    await toInsight();
    const insightCharts = await until(() => {
      const cs = [...document.querySelectorAll('#homeSections canvas[data-spark]')];
      if (!cs.length) return null;
      const withChart = cs.filter((c) => !!Chart.getChart(c)).length;
      if (withChart !== cs.length) return null;
      return { total: cs.length, withChart,
        bare: cs.every((c) => { const ch = Chart.getChart(c); return ch.options.scales.x.display === false && ch.options.scales.y.display === false; }) };
    });
    H.check('home UI: switching back to insight mode still shows the bare mini sparklines (axes hidden)',
      !!insightCharts && insightCharts.bare, JSON.stringify(insightCharts));
    // Deltas: the insight chips stay small (12px) while the report
    // cards render them larger (17px, measured above) — and the YoY
    // line is color-coded in insight mode too, not plain gray.
    const insightDelta = await page.evaluate(() => {
      const el = document.querySelector('#homeSections .insight-card .delta');
      const yoy = [...document.querySelectorAll('[data-home-section="property"] .insight-card')]
        .find((c) => c.querySelector('.insight-label').textContent.includes('Total equity'))
        .querySelector('.delta-yoy');
      return { deltaPx: parseFloat(getComputedStyle(el).fontSize),
        yoyColor: getComputedStyle(yoy).color, yoyClass: yoy.className };
    });
    H.check('home UI: report-mode delta text is larger than the insight-mode chip (17px vs 12px)',
      reportDeltaPx.deltaPx === 17 && insightDelta.deltaPx === 12, JSON.stringify({ report: reportDeltaPx, insight: insightDelta }));
    H.check('home UI: insight-mode YoY on Total equity (negative YoY) renders in the down color too',
      insightDelta.yoyColor === 'rgb(179, 38, 30)' && insightDelta.yoyClass.includes('bad'),
      JSON.stringify(insightDelta));

    // Home calendar: renders with the current month, marking the
    // fixture's payment dates per kind, today highlighted. The
    // calendar loads on its own fetch, so wait for its day cells.
    const calReady = await until(() => {
      const el = document.querySelector('#homeCalendar');
      return el && el.querySelectorAll('.home-cal-day:not(.is-blank)').length > 0 ? el.textContent : null;
    });
    H.check('home UI: calendar renders with the Nov 2026 title + a Salary / Rent / Mortgage legend',
      !!calReady && calReady.includes('Nov 2026')
      && ['Salary', 'Rent', 'Mortgage'].every((k) => calReady.includes(k)),
      String(calReady && calReady.slice(0, 200)));
    const calDots = await page.evaluate(() => {
      const dots = (date) => {
        const c = document.querySelector(`[data-cal-date="${date}"]`);
        return c ? [...c.querySelectorAll('.home-cal-dot')].map((d) => d.className) : null;
      };
      return { nov6: dots('2026-11-06'), nov15: dots('2026-11-15'), nov20: dots('2026-11-20'), nov10: dots('2026-11-10') };
    });
    H.check('home UI: calendar marks Nov 6 + Nov 20 salary, Nov 15 rent + mortgage, nothing on Nov 10',
      calDots.nov6 && calDots.nov6.some((c) => c.includes('kind-salary'))
      && calDots.nov20 && calDots.nov20.some((c) => c.includes('kind-salary'))
      && calDots.nov15 && calDots.nov15.some((c) => c.includes('kind-rental'))
      && calDots.nov15.some((c) => c.includes('kind-mortgage'))
      && calDots.nov10 && calDots.nov10.length === 0,
      JSON.stringify(calDots));
    // Non-actionable days are dimmed; actionable days keep the
    // interactive style. Nov 10 has no payments (dimmed); Nov 6
    // focuses the Nov 6 salary card (actionable).
    const calDim = await page.evaluate(() => {
      const cls = (date) => {
        const c = document.querySelector(`[data-cal-date="${date}"]`);
        return c ? { className: c.className, tab: c.getAttribute('tabindex') } : null;
      };
      return { nov10: cls('2026-11-10'), nov6: cls('2026-11-06') };
    });
    H.check('home UI: a day with no payments is dimmed and not focusable; an actionable day keeps the interactive style',
      calDim.nov10 && calDim.nov10.className.includes('is-dim') && !calDim.nov10.className.includes('has-pay') && calDim.nov10.tab == null
      && calDim.nov6 && calDim.nov6.className.includes('has-pay') && !calDim.nov6.className.includes('is-dim') && calDim.nov6.tab === '0',
      JSON.stringify(calDim));
    // Today is the real run date (runner TZ is America/Vancouver,
    // same as the server's Vancouver day).
    const nowD = new Date();
    const todayStr = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
    const todayHi = await page.evaluate((t) => {
      const c = document.querySelector(`[data-cal-date="${t}"]`);
      return c ? c.className : null;
    }, todayStr);
    H.check('home UI: calendar highlights today', todayHi && todayHi.includes('is-today'), JSON.stringify({ todayStr, todayHi }));
    // At the default 800px viewport the calendar stacks ABOVE the
    // carousel (the side-by-side row only applies past 1000px, so
    // the folded deck keeps two big cards + a peek).
    const stacked = await page.evaluate(() => {
      const cal = document.querySelector('#homeCalendar').getBoundingClientRect();
      const car = document.querySelector('#homeHighlightCarousel').getBoundingClientRect();
      return { calBottom: cal.bottom, carTop: car.top, calW: cal.width };
    });
    H.check('home UI: at 800px the calendar stacks above the highlight carousel',
      stacked.calBottom <= stacked.carTop + 1, JSON.stringify(stacked));
    // At a wide viewport it sits LEFT of the carousel in the same row.
    await page.setViewport({ width: 1280, height: 800 });
    await wait(300);
    const sideBySide = await page.evaluate(() => {
      const cal = document.querySelector('#homeCalendar').getBoundingClientRect();
      const car = document.querySelector('#homeHighlightCarousel').getBoundingClientRect();
      return { calRight: cal.right, carLeft: car.left, calTop: cal.top, carTop: car.top };
    });
    H.check('home UI: at 1280px the calendar sits left of the highlight carousel',
      sideBySide.calRight <= sideBySide.carLeft + 1 && Math.abs(sideBySide.calTop - sideBySide.carTop) < 60,
      JSON.stringify(sideBySide));
    await page.setViewport({ width: 800, height: 600 });
    await wait(300);
    // Prev/next navigation: Dec 2026 shows the Dec 4 payday, then back to Nov.
    await page.evaluate(() => document.querySelector('[data-cal-nav="1"]').click());
    const decTitle = await until(() => {
      const t = document.querySelector('.home-cal-title');
      return t && t.textContent === 'Dec 2026' ? t.textContent : null;
    });
    const decDots = await page.evaluate(() => {
      const c = document.querySelector('[data-cal-date="2026-12-04"]');
      return c ? [...c.querySelectorAll('.home-cal-dot')].map((d) => d.className) : null;
    });
    H.check('home UI: calendar next shows Dec 2026 with the Dec 4 salary payday',
      decTitle === 'Dec 2026' && decDots && decDots.some((c) => c.includes('kind-salary')),
      JSON.stringify({ decTitle, decDots }));
    // Dec 4 has a payday but no highlight card (outside the window):
    // dimmed, not clickable.
    const dec4Dim = await page.evaluate(() => {
      const c = document.querySelector('[data-cal-date="2026-12-04"]');
      return c ? c.className : null;
    });
    H.check('home UI: Dec 4 (payments, no highlight card) is dimmed, not clickable',
      dec4Dim && dec4Dim.includes('is-dim') && !dec4Dim.includes('has-pay'), JSON.stringify(dec4Dim));
    await page.evaluate(() => document.querySelector('[data-cal-nav="-1"]').click());
    const backTitle = await until(() => {
      const t = document.querySelector('.home-cal-title');
      return t && t.textContent === 'Nov 2026' ? t.textContent : null;
    });
    H.check('home UI: calendar prev returns to Nov 2026', backTitle === 'Nov 2026', String(backTitle));
    // The focus fill is report-mode only: the insight calendar never
    // carries an is-focus day.
    const insightFocus = await page.evaluate(() => document.querySelector('#homeCalendar .home-cal-day.is-focus'));
    H.check('home UI: insight-mode calendar has no focused day (focus lives in report-mode cards only)',
      insightFocus === null, String(insightFocus));

    // Calendar → highlight link: clicking a day focuses its payment
    // card in the highlight carousel. At 1280px the carousel sits
    // beside the calendar, so the scroll is visible.
    await page.setViewport({ width: 1280, height: 800 });
    await wait(300);
    const calFocusState = () => page.evaluate(() => {
      const car = document.querySelector('#homeHighlightCarousel');
      const f = car.querySelector('.home-pay-card.is-cal-focus');
      return {
        scrollLeft: car.scrollLeft,
        focused: f ? { kind: f.dataset.payKind, source: f.dataset.paySource, date: f.dataset.payDate } : null,
      };
    });
    // Nov 6 salary is the first card, already in view — clicking
    // its day focuses it without moving the carousel.
    await page.evaluate(() => document.querySelector('[data-cal-date="2026-11-06"]').click());
    const focusNov6 = await until(() => {
      const car = document.querySelector('#homeHighlightCarousel');
      const f = car.querySelector('.home-pay-card.is-cal-focus');
      return f ? { kind: f.dataset.payKind, date: f.dataset.payDate, scrollLeft: car.scrollLeft } : null;
    });
    H.check('home UI: clicking Nov 6 focuses the Nov 6 salary card',
      focusNov6 && focusNov6.kind === 'salary' && focusNov6.date === '2026-11-06',
      JSON.stringify(focusNov6));
    // Nov 10 has no payments: the focus clears and nothing new is
    // focused, and the carousel does not move. Wait for the 2s
    // focus to clear first so the old focus cannot stand in for a new one.
    await until(() => !document.querySelector('#homeHighlightCarousel .home-pay-card.is-cal-focus'));
    const scrollBeforeEmpty = (await calFocusState()).scrollLeft;
    await page.evaluate(() => document.querySelector('[data-cal-date="2026-11-10"]').click());
    await wait(300);
    const focusEmpty = await calFocusState();
    H.check('home UI: clicking a date with no payments focuses nothing and does not scroll',
      focusEmpty.focused === null && focusEmpty.scrollLeft === scrollBeforeEmpty, JSON.stringify(focusEmpty));
    // Oct 15 has two payments (rent + mortgage): the first in
    // highlight order — rent — is focused, and the carousel scrolls to it.
    await page.evaluate(() => document.querySelector('[data-cal-nav="-1"]').click());
    await until(() => {
      const t = document.querySelector('.home-cal-title');
      return t && t.textContent === 'Oct 2026' ? t.textContent : null;
    });
    await page.evaluate(() => document.querySelector('[data-cal-date="2026-10-15"]').click());
    const focusOct15 = await until(() => {
      const car = document.querySelector('#homeHighlightCarousel');
      const f = car.querySelector('.home-pay-card.is-cal-focus');
      if (!f || car.scrollLeft < 100) return null;
      return { kind: f.dataset.payKind, date: f.dataset.payDate, scrollLeft: car.scrollLeft };
    });
    H.check('home UI: clicking Oct 15 focuses the first of its two payments (rent) and scrolls the carousel',
      focusOct15 && focusOct15.kind === 'rental' && focusOct15.date === '2026-10-15',
      JSON.stringify(focusOct15));
    // Oct 15: both payments were marked in the API phase (rent +
    // mortgage), so both dots render done.
    const oct15Dots = await page.evaluate(() => {
      const c = document.querySelector('[data-cal-date="2026-10-15"]');
      return c ? [...c.querySelectorAll('.home-cal-dot')].map((d) => d.className) : null;
    });
    H.check('home UI: a marked payment renders its calendar dot done (Oct 15 rent + mortgage both done)',
      oct15Dots && oct15Dots.length === 2 && oct15Dots.every((c) => c.includes('is-done')), JSON.stringify(oct15Dots));
    // Dec 4 has a salary payday on the calendar but no highlight
    // card (outside the current + previous month window): nothing focuses.
    // Wait for each month to land before the next click: homeCalShift
    // reads the displayed month, so a second click before the fetch
    // resolves would re-request the same month.
    await page.evaluate(() => document.querySelector('[data-cal-nav="1"]').click());
    await until(() => {
      const t = document.querySelector('.home-cal-title');
      return t && t.textContent === 'Nov 2026' ? t.textContent : null;
    });
    await page.evaluate(() => document.querySelector('[data-cal-nav="1"]').click());
    await until(() => {
      const t = document.querySelector('.home-cal-title');
      return t && t.textContent === 'Dec 2026' ? t.textContent : null;
    });
    await until(() => !document.querySelector('#homeHighlightCarousel .home-pay-card.is-cal-focus'));
    const scrollBeforeDec4 = (await calFocusState()).scrollLeft;
    await page.evaluate(() => document.querySelector('[data-cal-date="2026-12-04"]').click());
    await wait(300);
    const focusDec4 = await calFocusState();
    H.check('home UI: clicking a date outside the highlight window focuses nothing and does not scroll',
      focusDec4.focused === null && focusDec4.scrollLeft === scrollBeforeDec4, JSON.stringify(focusDec4));
    // Leave the page as found: back to Nov 2026, 800px viewport,
    // carousel at its start, no focus.
    await page.evaluate(() => document.querySelector('[data-cal-nav="-1"]').click());
    await until(() => {
      const t = document.querySelector('.home-cal-title');
      return t && t.textContent === 'Nov 2026' ? t.textContent : null;
    });
    await page.evaluate(() => {
      const car = document.querySelector('#homeHighlightCarousel');
      car.scrollTo({ left: 0, behavior: 'instant' });
      car.querySelectorAll('.home-pay-card.is-cal-focus').forEach((el) => el.classList.remove('is-cal-focus'));
    });
    await page.setViewport({ width: 800, height: 600 });
    await wait(300);

    // Brand link: Finance Mate in the top bar goes to Home.
    await page.goto('http://ff.local/#assets/overview', { waitUntil: 'networkidle0', timeout: 30000 });
    await until(() => {
      const s = document.querySelector('#section-overview');
      return s && !s.classList.contains('hidden');
    });
    await page.evaluate(() => document.querySelector('header.topbar .brand').click());
    const brandHome = await until(() => {
      const v = document.querySelector('#view-home');
      return v && !v.classList.contains('hidden') && location.hash === '#home';
    });
    H.check('home UI: clicking the Finance Mate brand navigates to Home', !!brandHome,
      await page.evaluate(() => location.hash));

    // Highlight carousel: the Nov 6 payday card shows the displayed
    // take-home; the FIRST card is the most recent occurrence (a
    // mortgage payment once Nov 15 has arrived, else the Nov 6 salary).
    const cashFmt = displayedCash.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const nov6Pay = await page.evaluate(() => {
      const c = [...document.querySelectorAll('#homeHighlightCarousel .insight-card')].find((el) => el.textContent.includes('Nov 6'));
      return c ? c.textContent : '';
    });
    H.check('home UI: the Nov 6 highlight card shows the displayed take-home',
      nov6Pay.includes('Nov 6') && nov6Pay.includes(`$${cashFmt}`), nov6Pay.slice(0, 200));
    r = await H.req('GET', '/api/home');
    const firstHl = r.data.highlights[0];
    const firstCard = await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel .insight-card');
      return c ? { kind: c.dataset.payKind, date: c.dataset.payDate } : null;
    });
    H.check('home UI: the first highlight card is the most recent occurrence',
      firstCard && firstCard.kind === firstHl.kind && firstCard.date === firstHl.date,
      JSON.stringify({ firstCard, firstHl }));
    // Header summary shows both counts: received (salary + rental)
    // and paid (mortgage).
    const incomeHl = r.data.highlights.filter((h) => h.kind !== 'mortgage');
    const mortHl = r.data.highlights.filter((h) => h.kind === 'mortgage');
    const recvCount = incomeHl.filter((h) => h.received === 1).length;
    const paidCount = mortHl.filter((h) => h.received === 1).length;
    const summaryText = await page.evaluate(() => document.querySelector('#homeSummary').textContent);
    H.check('home UI: header summary shows received and paid counts',
      summaryText === `${recvCount} of ${incomeHl.length} received · ${paidCount} of ${mortHl.length} paid`,
      JSON.stringify(summaryText));

    // Big cards, folded deck: about two full cards in the viewport
    // with a peek of the next card; the snapped card sits on top.
    const cardShape = await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel');
      const cards = [...c.querySelectorAll('.insight-card')];
      const cr = c.getBoundingClientRect();
      return {
        scrollW: c.scrollWidth, clientW: c.clientWidth,
        cardW: cards[0].getBoundingClientRect().width,
        secondLeft: cards[1].getBoundingClientRect().left,
        thirdLeft: cards[2] ? cards[2].getBoundingClientRect().left : null,
        carRight: cr.right, carLeft: cr.left,
      };
    });
    H.check('home UI: highlight cards are big cards, not full-width strips (two visible + next peeking)',
      cardShape.cardW < cardShape.clientW * 0.6 && cardShape.cardW > cardShape.clientW * 0.35
      && cardShape.secondLeft < cardShape.carRight && cardShape.thirdLeft != null && cardShape.thirdLeft < cardShape.carRight,
      JSON.stringify(cardShape));
    // Scroll to the second card: a sliver of the previous card stays
    // visible on the left, the next card peeks on the right, and the
    // snapped card sits on top of the fold at full size.
    await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel');
      const cards = [...c.querySelectorAll('.insight-card')];
      c.scrollTo({ left: cards[1].offsetLeft, behavior: 'instant' });
    });
    await wait(700);
    const folded = await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel');
      const cards = [...c.querySelectorAll('.insight-card')];
      const cr = c.getBoundingClientRect();
      const cs = cards.map((el) => getComputedStyle(el));
      return {
        firstRight: cards[0].getBoundingClientRect().right,
        thirdLeft: cards[2] ? cards[2].getBoundingClientRect().left : null,
        carLeft: cr.left, carRight: cr.right,
        active: cards[1].classList.contains('is-active'),
        z1: cs[1].zIndex, z0: cs[0].zIndex,
        t1: cs[1].transform, t0: cs[0].transform,
      };
    });
    H.check('home UI: scrolled carousel peeks the previous card on the left and the next on the right',
      folded.firstRight > folded.carLeft + 5 && folded.thirdLeft != null && folded.thirdLeft < folded.carRight,
      JSON.stringify(folded));
    // The folded deck lives on the insight sections now (the
    // highlight sits flat with a gap): scroll the Property carousel
    // to its second card and check the fold there.
    await page.evaluate(() => {
      const sec = document.querySelector('[data-home-section="property"]');
      window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - 80, behavior: 'instant' });
      sec.scrollTo({ left: sec.querySelectorAll('.insight-card')[1].offsetLeft, behavior: 'instant' });
    });
    await wait(700);
    const foldedSec = await page.evaluate(() => {
      const c = document.querySelector('[data-home-section="property"]');
      const cards = [...c.querySelectorAll('.insight-card')];
      const cs = cards.map((el) => getComputedStyle(el));
      return {
        active: cards[1].classList.contains('is-active'),
        z1: cs[1].zIndex, z0: cs[0].zIndex,
        t1: cs[1].transform, t0: cs[0].transform,
      };
    });
    H.check('home UI: folded deck — the snapped card is active, on top, full size; the neighbour tucks under',
      foldedSec.active && Number(foldedSec.z1) > Number(foldedSec.z0) && !foldedSec.t1.includes('0.97') && foldedSec.t0.includes('0.97'),
      JSON.stringify(foldedSec));

    // Sections: 4 carousels, strip cards with big number + delta + sparkline.
    const sections = await page.evaluate(() => [...document.querySelectorAll('#homeSections [data-home-section]')].map((el) => ({
      section: el.dataset.homeSection, cards: el.querySelectorAll('.insight-card').length,
      canvases: el.querySelectorAll('canvas').length,
      text: el.textContent,
    })));
    H.check('home UI: four sections render 3 big cards each with sparklines',
      sections.length === 4 && sections.every((s) => s.cards === 3 && s.canvases === 3),
      JSON.stringify(sections.map((s) => ({ section: s.section, cards: s.cards, canvases: s.canvases }))));

    // Section headings link to their summary pages.
    const sectionLinks = await page.evaluate(() => [...document.querySelectorAll('#homeSections .home-section-head')].map((h) => ({
      title: h.querySelector('.home-section-link').textContent,
      href: h.querySelector('.home-section-link').getAttribute('href'),
      allHref: h.querySelector('.home-section-all').getAttribute('href'),
    })));
    H.check('home UI: section headings link to their summary pages',
      JSON.stringify(sectionLinks.map((s) => s.href)) === JSON.stringify(['#assets/properties', '#assets/investments', '#earnings', '#spending'])
      && sectionLinks.every((s) => s.href === s.allHref),
      JSON.stringify(sectionLinks));
    await page.evaluate(() => document.querySelector('[data-home-section="property"]').previousElementSibling.querySelector('.home-section-link').click());
    const propLanded = await until(() => {
      const s = document.querySelector('#section-properties');
      return s && !s.classList.contains('hidden') && location.hash === '#assets/properties';
    });
    H.check('home UI: Property heading navigates to the Properties list', !!propLanded, await page.evaluate(() => location.hash));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    await page.evaluate(() => document.querySelector('[data-home-section="spending"]').previousElementSibling.querySelector('.home-section-all').click());
    const spendLanded = await until(() => {
      const v = document.querySelector('#view-spending');
      return v && !v.classList.contains('hidden') && location.hash === '#spending';
    });
    H.check('home UI: Spending View all navigates to the Spending page', !!spendLanded, await page.evaluate(() => location.hash));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    const assessedText = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      const assessed = cards.find((c) => c.textContent.includes('Assessed total'));
      const equity = cards.find((c) => c.textContent.includes('Total equity'));
      return { assessed: assessed ? assessed.textContent : '', equity: equity ? equity.textContent : '' };
    });
    H.check('home UI: assessed card shows the $1,500,000 big number; equity card shows a MoM delta vs Oct 2026',
      assessedText.assessed.includes('$1,500,000') && /vs Oct 2026/.test(assessedText.equity),
      JSON.stringify(assessedText));

    // Toggle persists across reload (scoped to the salary card: the
    // first highlight card may be a mortgage payment).
    await page.evaluate(() => { document.querySelector('#homeHighlightCarousel .insight-card[data-pay-kind="salary"] [data-mark-kind]').click(); });
    const toggled = await until(() => {
      const b = document.querySelector('#homeHighlightCarousel .insight-card[data-pay-kind="salary"] [data-mark-kind]');
      return b && b.textContent.includes('Received') ? b.textContent : null;
    });
    H.check('home UI: marking the Nov 6 payday shows Received', !!toggled, String(toggled));
    H.check('home UI: marking does not navigate away from Home',
      await page.evaluate(() => ['', '#home'].includes(location.hash)), await page.evaluate(() => location.hash));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    const persisted = await until(() => {
      const b = document.querySelector('#homeHighlightCarousel .insight-card[data-pay-kind="salary"] [data-mark-kind]');
      return b && b.textContent.includes('Received') ? b.textContent : null;
    });
    H.check('home UI: Received toggle persists across reload', !!persisted, String(persisted));
    // The marked Nov 6 payday renders its calendar dot done; the
    // unmarked Nov 20 payday does not.
    await until(() => document.querySelectorAll('#homeCalendar .home-cal-day:not(.is-blank)').length > 0);
    const nov6Done = await page.evaluate(() => {
      const dots = (date) => {
        const c = document.querySelector(`[data-cal-date="${date}"]`);
        return c ? [...c.querySelectorAll('.home-cal-dot')].map((d) => d.className) : null;
      };
      return { nov6: dots('2026-11-06'), nov20: dots('2026-11-20') };
    });
    H.check('home UI: a marked payment renders its calendar dot done; an unmarked one does not',
      nov6Done.nov6 && nov6Done.nov6.some((c) => c.includes('is-done'))
      && nov6Done.nov20 && nov6Done.nov20.every((c) => !c.includes('is-done')),
      JSON.stringify(nov6Done));

    // Mortgage highlight card: "Mark paid" / "Paid", and a link to the property.
    const mortCard = await page.evaluate(() => {
      const c = [...document.querySelectorAll('#homeHighlightCarousel .insight-card')].find((el) => el.dataset.payKind === 'mortgage');
      if (!c) return null;
      return { text: c.textContent, link: c.dataset.homeLink || null, toggle: c.querySelector('[data-mark-kind]').textContent };
    });
    H.check('home UI: mortgage highlight card shows Mortgage + the $1,744.81 payment + a Paid toggle',
      mortCard && mortCard.text.includes('Mortgage') && mortCard.text.includes('$1,744.81') && mortCard.toggle.includes('Paid'),
      JSON.stringify(mortCard));
    H.check('home UI: mortgage highlight card links to its property page',
      mortCard && mortCard.link === `#property/${pidB}`, JSON.stringify(mortCard));
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('#homeHighlightCarousel .insight-card')].find((el) => el.dataset.payKind === 'mortgage');
      c.querySelector('.insight-value').click();
    });
    const mortDetail = await until(() => {
      const v = document.querySelector('#view-property');
      return location.hash.startsWith('#property/') && v && !v.classList.contains('hidden') && v.textContent.includes('2 Home Test Way') ? v.textContent : null;
    });
    H.check('home UI: clicking the mortgage card opens that property detail page',
      !!mortDetail, String(mortDetail && mortDetail.slice(0, 200)));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);

    // Highlight gap: payment cards sit side by side — adjacent rects
    // never intersect (no folded overlap in the highlight carousel).
    const hlGap = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#homeHighlightCarousel .insight-card')];
      const rects = cards.map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      return { n: cards.length, ok: rects.every((r, i) => i === 0 || r.left >= rects[i - 1].right), rects };
    });
    H.check('home UI: highlight cards have a gap — adjacent rects do not intersect',
      hlGap.n >= 2 && hlGap.ok, JSON.stringify(hlGap));

    // No drag handles anywhere: reorder is long-press to edit mode.
    H.check('home UI: no drag handles remain on any card',
      await page.evaluate(() => document.querySelectorAll('[data-drag-handle]').length) === 0, '');

    // Short tap still navigates: clicking the first property card
    // goes to the Properties list.
    await page.evaluate(() => { document.querySelector('[data-home-section="property"] .insight-card').click(); });
    const shortTapNav = await until(() => (location.hash === '#assets/properties' ? location.hash : null));
    H.check('home UI: a short tap on a card still navigates (no long-press)', !!shortTapNav, await page.evaluate(() => location.hash));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    // Wait for the home DOM to settle before touching the
    // carousel: goto(#home) re-fetches /api/home and renderHome
    // replaces the section nodes, but the until() above can pass on
    // the STALE DOM (the old cards are still there, hidden). If we
    // scroll the stale carousel, the fresh render replaces it and
    // the scroll is lost — that was the intermittent drag failure.
    // The node surviving 800ms unchanged means no render is
    // pending.
    const homeSettled = await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const car = document.querySelector('[data-home-section="property"]');
        if (!car) { await new Promise((r) => setTimeout(r, 250)); continue; }
        await new Promise((r) => setTimeout(r, 800));
        if (document.querySelector('[data-home-section="property"]') === car) return 'settled';
      }
      return null;
    });
    H.check('home UI: home DOM settled after navigating back (no pending re-render)',
      !!homeSettled, String(homeSettled));
    // The property section sits near the bottom of the 600px
    // viewport, so scroll the PAGE down first (the carousel's own
    // horizontal scroll does not move it vertically), then scroll
    // the carousel to the second card's start (a snap point) so the
    // third card sits in view and the second card is droppable.
    await page.evaluate(() => {
      const sec = document.querySelector('[data-home-section="property"]');
      window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - 80, behavior: 'instant' });
      const car = sec;
      car.scrollTo({ left: car.querySelectorAll('.insight-card')[1].offsetLeft, behavior: 'instant' });
    });
    // Wait for the third card's centre to be hittable inside the
    // viewport before starting the long-press.
    const lpReady = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      if (cards.length !== 3) return null;
      const r = cards[2].getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx <= 0 || cx >= innerWidth || cy <= 0 || cy >= innerHeight) return null;
      const at = document.elementFromPoint(cx, cy);
      return at && cards[2].contains(at) ? 'ready' : null;
    });
    H.check('home UI: long-press precondition — third card centre is hittable after scrolling',
      !!lpReady, String(lpReady));
    // Long-press the property section's third card (Outstanding
    // principal) for ~650ms: edit mode starts, the section jiggles,
    // the overlap is removed, and the trailing click does not navigate.
    const lpPts = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      const r = cards[2].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(lpPts.x, lpPts.y);
    await page.mouse.down();
    await wait(650);
    await page.mouse.up();
    const editState = await page.evaluate(() => {
      const car = document.querySelector('[data-home-section="property"]');
      const cards = [...car.querySelectorAll('.insight-card')];
      return {
        editing: car.classList.contains('is-editing'),
        jiggle: cards.every((c) => getComputedStyle(c).animationName.includes('homeJiggle')),
        gap: getComputedStyle(car).gap,
        noOverlap: cards[1].getBoundingClientRect().left >= cards[0].getBoundingClientRect().right,
        hash: location.hash,
      };
    });
    H.check('home UI: long-press enters edit mode — jiggle on, overlap off, no navigation',
      editState.editing && editState.jiggle && editState.noOverlap && ['', '#home'].includes(editState.hash),
      JSON.stringify(editState));
    // Clicking a card in edit mode does not navigate and stays in edit mode.
    await page.evaluate(() => { document.querySelector('[data-home-section="property"] .insight-card').click(); });
    await wait(200);
    const stillEditing = await page.evaluate(() => ({
      editing: document.querySelector('[data-home-section="property"]').classList.contains('is-editing'),
      hash: location.hash,
    }));
    H.check('home UI: tapping a card in edit mode does not navigate and stays in edit mode',
      stillEditing.editing && ['', '#home'].includes(stillEditing.hash), JSON.stringify(stillEditing));
    // Edit mode removes the -20px overlap, which pushes the third
    // card's centre right — at this 800px viewport it can slide just
    // past the viewport edge, where a pointerdown hits nothing. Nudge
    // the carousel left until the centre is hittable again, then drag.
    await page.evaluate(() => {
      const sec = document.querySelector('[data-home-section="property"]');
      const cards = [...sec.querySelectorAll('.insight-card')];
      const r = cards[2].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      if (cx >= innerWidth - 20) sec.scrollLeft += cx - (innerWidth - 60);
    });
    await wait(300);
    const dragReady = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      if (cards.length !== 3) return null;
      const r = cards[2].getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx <= 0 || cx >= innerWidth || cy <= 0 || cy >= innerHeight) return null;
      const at = document.elementFromPoint(cx, cy);
      return at && cards[2].contains(at) ? 'ready' : null;
    });
    H.check('home UI: drag precondition — third card centre is hittable in edit mode',
      !!dragReady, String(dragReady));
    // Drag the third card onto the second: the order becomes Total
    // equity, Outstanding principal, Assessed total. The drag starts
    // from anywhere on the card (no handle) and the card follows the
    // pointer.
    const dragPts = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      const from = cards[2].getBoundingClientRect();
      const second = cards[1].getBoundingClientRect();
      return {
        from: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
        to: { x: second.left + 30, y: second.top + second.height / 2 },
      };
    });
    await page.mouse.move(dragPts.from.x, dragPts.from.y);
    await page.mouse.down();
    await page.mouse.move(dragPts.to.x, dragPts.to.y, { steps: 12 });
    await page.mouse.up();
    const propOrderAfterDrag = await page.evaluate(() => [...document.querySelectorAll('[data-home-section="property"] .insight-card .insight-label')].map((el) => el.textContent));
    H.check('home UI: dragging a card in edit mode reorders the section',
      JSON.stringify(propOrderAfterDrag) === JSON.stringify(['Total equity', 'Outstanding principal', 'Assessed total']),
      JSON.stringify(propOrderAfterDrag));
    H.check('home UI: dragging a card does not navigate away from Home',
      await page.evaluate(() => ['', '#home'].includes(location.hash)), await page.evaluate(() => location.hash));
    r = await H.req('GET', '/api/home');
    H.check('home UI: the dragged order reached the server',
      JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric))
      === JSON.stringify(['property_equity', 'property_outstanding', 'property_assessed']),
      JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric)));
    // Tapping blank space exits edit mode; a subsequent tap navigates.
    await page.evaluate(() => document.querySelector('#homeSections').click());
    const exited = await page.evaluate(() => ({
      editing: document.querySelector('[data-home-section="property"]').classList.contains('is-editing'),
      hash: location.hash,
    }));
    H.check('home UI: tapping blank space exits edit mode',
      !exited.editing && ['', '#home'].includes(exited.hash), JSON.stringify(exited));
    await page.evaluate(() => { document.querySelector('[data-home-section="property"] .insight-card').click(); });
    const afterExitNav = await until(() => (location.hash === '#assets/properties' ? location.hash : null));
    H.check('home UI: after exiting edit mode, tapping a card navigates again',
      !!afterExitNav, await page.evaluate(() => location.hash));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    const propOrderReload = await until(() => {
      const labels = [...document.querySelectorAll('[data-home-section="property"] .insight-card .insight-label')].map((el) => el.textContent);
      return labels.length === 3 && JSON.stringify(labels) === JSON.stringify(['Total equity', 'Outstanding principal', 'Assessed total']) ? labels : null;
    });
    H.check('home UI: the dragged order persists across reload', !!propOrderReload, JSON.stringify(propOrderReload));
    await page.evaluate(() => document.querySelector('#homeRegenBtn').click());
    const propOrderRegen = await until(() => {
      const labels = [...document.querySelectorAll('[data-home-section="property"] .insight-card .insight-label')].map((el) => el.textContent);
      return labels.length === 3 && JSON.stringify(labels) === JSON.stringify(['Total equity', 'Outstanding principal', 'Assessed total']) ? labels : null;
    });
    H.check('home UI: Re-generate keeps the dragged order', !!propOrderRegen, JSON.stringify(propOrderRegen));

    // Home Re-generate shows the global loading veil while it runs
    // (2026-11-08: Re-generate / AI-append / AI-Apply run inside
    // withLoading, the same veil the detail pages use). The
    // generate POST is held via CDP Fetch so the veil's 200ms
    // delay elapses before it completes — same pattern as the
    // veil module's slow path.
    await toInsight();
    await page.evaluate(() => {
      window.__veilSeen = false;
      const el = document.getElementById('globalLoading');
      const check = () => { if (el && !el.classList.contains('hidden')) window.__veilSeen = true; };
      new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ['class'] });
      setInterval(check, 25);
    });
    const pollState = async (pred, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        try { const s = await page.evaluate(() => window.__fmLoading.state()); if (pred(s)) return s; } catch {}
        await wait(200);
      }
      return null;
    };
    genGate = 'hold';
    await page.evaluate(() => { window.__veilSeen = false; });
    // The previous Re-generate's labels can render a poll before
    // its handler re-enables the button — a click on a disabled
    // button is a no-op, so wait for it to be enabled first.
    await until(() => { const b = document.querySelector('#homeRegenBtn'); return b && !b.disabled ? true : null; });
    await page.evaluate(() => document.querySelector('#homeRegenBtn').click());
    const veilShown = await pollState((s) => s.visible === true, 25);
    const veilSeen = await page.evaluate(() => window.__veilSeen);
    H.check('home UI: Re-generate shows the global loading veil while it runs',
      !!veilShown && veilShown.count >= 1 && veilSeen === true,
      JSON.stringify({ veilShown, veilSeen, held: genHeld.length }));
    await releaseGenHeld();
    genGate = null;
    const veilSettled = await pollState((s) => s.count === 0 && s.visible === false, 40);
    H.check('home UI: the veil lifts once Re-generate finishes',
      !!veilSettled, JSON.stringify(veilSettled));
    const propOrderRegenVeil = await until(() => {
      const labels = [...document.querySelectorAll('[data-home-section="property"] .insight-card .insight-label')].map((el) => el.textContent);
      return labels.length === 3 && JSON.stringify(labels) === JSON.stringify(['Total equity', 'Outstanding principal', 'Assessed total']) ? labels : null;
    });
    H.check('home UI: the held Re-generate still completes and keeps the dragged order',
      !!propOrderRegenVeil, JSON.stringify(propOrderRegenVeil));

    // Nov 15 has two payments (rent + mortgage): marking only the
    // rent leaves one done dot + one pending dot. The mark goes in
    // via the API, so the page needs a real reload (same-URL goto
    // is a no-op) for the calendar to re-fetch with the mark.
    r = await H.req('POST', '/api/home/marks', { kind: 'rental', source_id: rentalEntryId, date: '2026-11-15', received: 1 });
    H.check('home UI: marking the Nov 15 rent succeeds', r.status === 200 && r.data.received === 1, JSON.stringify(r.data));
    await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeCalendar .home-cal-day:not(.is-blank)').length > 0);
    const nov15Dots = await page.evaluate(() => {
      const c = document.querySelector('[data-cal-date="2026-11-15"]');
      return c ? [...c.querySelectorAll('.home-cal-dot')].map((d) => d.className) : null;
    });
    H.check('home UI: a day with two payments where only one is marked shows one done + one pending dot',
      nov15Dots && nov15Dots.length === 2
      && nov15Dots.filter((c) => c.includes('is-done')).length === 1
      && nov15Dots.find((c) => c.includes('is-done')).includes('kind-rental'),
      JSON.stringify(nov15Dots));

    // Rent entries stay separate (user 2026-11-08): a rental with
    // two overlapping entries gets ONE highlight card per entry,
    // never one summed card — in insight mode, in report mode, and
    // on the calendar. Mirrors the live 2881 case ($960 + $1,600,
    // both due day 1).
    r = await H.req('POST', '/api/earnings/rentals', { label: 'Split suite', rental_type: 'long_term', services_level: 'basic' });
    const splitRentalId = r.data.id;
    r = await H.req('POST', `/api/earnings/rentals/${splitRentalId}/entries`, { start_ym: '2026-05', end_ym: '2027-02', monthly_rent: 960, pay_day: 1 });
    const splitEntryA = r.data.entries.find((e) => e.monthly_rent === 960).id;
    r = await H.req('POST', `/api/earnings/rentals/${splitRentalId}/entries`, { start_ym: '2026-07', end_ym: '2027-07', monthly_rent: 1600, pay_day: 1 });
    const splitEntryB = r.data.entries.find((e) => e.monthly_rent === 1600).id;
    // API: two Nov 1 cards for the rental, $960 and $1,600, each
    // keyed by its entry id; Oct 1 likewise, never a $2,560 sum.
    r = await H.req('GET', '/api/home');
    const splitRows = r.data.highlights.filter((x) => x.kind === 'rental' && x.sourceLabel === 'Split suite');
    H.check('home split: two overlapping entries give two highlight cards per month, never one summed card',
      splitRows.filter((x) => x.date === '2026-11-01').length === 2
      && splitRows.filter((x) => x.date === '2026-10-01').length === 2
      && splitRows.some((x) => x.date === '2026-11-01' && x.amount === 960 && x.sourceId === splitEntryA)
      && splitRows.some((x) => x.date === '2026-11-01' && x.amount === 1600 && x.sourceId === splitEntryB)
      && !splitRows.some((x) => x.amount === 2560),
      JSON.stringify(splitRows));
    // Marking one entry's Nov 1 received marks only that entry.
    r = await H.req('POST', '/api/home/marks', { kind: 'rental', source_id: splitEntryA, date: '2026-11-01', received: 1 });
    H.check('home split: marking one entry succeeds', r.status === 200 && r.data.received === 1, JSON.stringify(r.data));
    r = await H.req('GET', '/api/home');
    const splitAfter = r.data.highlights.filter((x) => x.kind === 'rental' && x.sourceLabel === 'Split suite' && x.date === '2026-11-01');
    H.check('home split: marking one entry leaves its sibling unmarked',
      splitAfter.length === 2
      && splitAfter.find((x) => x.sourceId === splitEntryA).received === 1
      && splitAfter.find((x) => x.sourceId === splitEntryB).received == null,
      JSON.stringify(splitAfter));
    // UI (insight mode): reload so the calendar re-fetches, then the
    // two Split suite cards show with independent toggles, and Nov 1
    // carries two rent dots — one done (entry A), one pending (B).
    await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    const splitUi = await page.evaluate((a, b) => {
      const cards = [...document.querySelectorAll('#homeHighlightCarousel .home-pay-card')]
        .filter((c) => c.textContent.includes('Split suite') && c.dataset.payDate === '2026-11-01');
      const one = (id) => cards.find((c) => Number(c.dataset.paySource) === id) || null;
      const ca = one(a); const cb = one(b);
      return {
        count: cards.length,
        a: ca ? { amount: ca.querySelector('.insight-value').textContent, on: !!ca.querySelector('.recv-toggle.on') } : null,
        b: cb ? { amount: cb.querySelector('.insight-value').textContent, on: !!cb.querySelector('.recv-toggle.on') } : null,
      };
    }, splitEntryA, splitEntryB);
    H.check('home split UI: insight shows two Split suite cards, $960 marked and $1,600 unmarked',
      splitUi.count === 2 && splitUi.a && splitUi.a.amount.includes('960') && splitUi.a.on === true
      && splitUi.b && splitUi.b.amount.includes('1,600') && splitUi.b.on === false,
      JSON.stringify(splitUi));
    const nov1Dots = await page.evaluate(() => {
      const c = document.querySelector('[data-cal-date="2026-11-01"]');
      return c ? [...c.querySelectorAll('.home-cal-dot')].map((d) => d.className) : null;
    });
    H.check('home split UI: Nov 1 carries two rent dots, one done and one pending',
      nov1Dots && nov1Dots.length === 2
      && nov1Dots.every((c) => c.includes('kind-rental'))
      && nov1Dots.filter((c) => c.includes('is-done')).length === 1,
      JSON.stringify(nov1Dots));
    // Clicking the $1,600 card's toggle marks only that card.
    await page.evaluate((b) => {
      document.querySelector(`#homeHighlightCarousel .home-pay-card[data-pay-source="${b}"][data-pay-date="2026-11-01"] .recv-toggle`).click();
    }, splitEntryB);
    const splitToggled = await until(() => {
      const cards = [...document.querySelectorAll('#homeHighlightCarousel .home-pay-card')]
        .filter((c) => c.textContent.includes('Split suite') && c.dataset.payDate === '2026-11-01');
      return cards.length === 2 && cards.every((c) => c.querySelector('.recv-toggle.on'))
        ? cards.map((c) => c.querySelector('.insight-value').textContent) : null;
    });
    H.check('home split UI: toggling the $1,600 card marks only it — both Nov 1 cards now received',
      !!splitToggled && splitToggled.some((t) => t.includes('960')) && splitToggled.some((t) => t.includes('1,600')),
      JSON.stringify(splitToggled));
    // Report mode: the same two cards appear in Upcoming payments
    // (all sections stay in the DOM, so no active-section wait).
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    const splitReport = await until(() => {
      const sec = document.querySelector('.report-section[data-report-section="highlight"]');
      if (!sec) return null;
      const cards = [...sec.querySelectorAll('.home-pay-card')]
        .filter((c) => c.textContent.includes('Split suite') && c.dataset.payDate === '2026-11-01');
      return cards.length === 2 ? cards.map((c) => c.querySelector('.insight-value').textContent) : null;
    });
    H.check('home split UI: report mode also shows two Split suite cards, $960 and $1,600',
      !!splitReport && splitReport.some((t) => t.includes('960')) && splitReport.some((t) => t.includes('1,600')),
      JSON.stringify(splitReport));
    // Back to insight mode for the AI-append block below, then
    // delete the rental so later pins see the fixture state only.
    await toInsight();
    r = await H.req('DELETE', `/api/earnings/rentals/${splitRentalId}`);
    H.check('home split: cleanup deletes the Split suite rental', r.status === 200, JSON.stringify(r.data));

    // AI-append in the browser: propose → Apply appends one → Delete removes it.
    fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'spending', title: 'Groceries spend', metric: 'category_spend:Groceries' } }));
    await page.evaluate(() => {
      const input = document.querySelector('#homeAiText');
      input.value = 'Show me groceries spending';
      document.querySelector('#homeAiSend').click();
    });
    const proposed = await until(() => {
      const b = document.querySelector('#homeAiApplyBtn');
      return b ? document.querySelector('#homeAiThread').textContent : null;
    });
    H.check('home UI: AI-append proposes the groceries card', !!proposed && proposed.includes('Groceries spend'), String(proposed && proposed.slice(0, 200)));
    await page.evaluate(() => document.querySelector('#homeAiApplyBtn').click());
    const appended = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="spending"] .insight-card')];
      return cards.length === 4 ? cards.map((c) => c.textContent).join(' | ') : null;
    });
    H.check('home UI: Apply appends exactly one AI card to Spending', !!appended && appended.includes('Groceries spend'),
      String(appended && appended.slice(0, 300)));
    const aiTags = await page.evaluate(() => [...document.querySelectorAll('.home-ai-tag')].map((el) => el.closest('.insight-card').textContent));
    H.check('home UI: the AI card carries a visible AI tag; system cards have none',
      aiTags.length === 1 && aiTags[0].includes('Groceries spend'), JSON.stringify(aiTags));
    // Clicking the per-entity AI card lands on its detail view: the
    // Groceries card goes to Spending with Groceries filtered.
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="spending"] .insight-card')];
      cards.find((c) => c.textContent.includes('Groceries spend')).click();
    });
    const catView = await until(() => {
      const btn = document.querySelector('#spendCatBtn');
      return location.hash === '#spending' && btn && btn.textContent.includes('Groceries') ? btn.textContent : null;
    });
    H.check('home UI: clicking the Groceries card opens Spending with Groceries filtered',
      !!catView, String(catView));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    const delCount = await page.evaluate(() => document.querySelectorAll('.home-card-del').length);
    H.check('home UI: only the AI card has a Delete button (system cards have none)',
      delCount === 1, String(delCount));
    await page.evaluate(() => document.querySelector('.home-card-del').click());
    const afterDel = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="spending"] .insight-card')];
      return cards.length === 3 ? 'back to 3' : null;
    });
    H.check('home UI: Delete removes the AI card', !!afterDel, String(afterDel));
    const aiTagsAfter = await page.evaluate(() => document.querySelectorAll('.home-ai-tag').length);
    H.check('home UI: AI tag is gone with the deleted AI card', aiTagsAfter === 0, String(aiTagsAfter));
    H.check('home UI: deleting the AI card does not navigate away from Home',
      await page.evaluate(() => ['', '#home'].includes(location.hash)), await page.evaluate(() => location.hash));

    // Clear session: the thread empties, cards are untouched, and a
    // new message starts a fresh thread (no trace of the old one).
    const clearBtn = await page.evaluate(() => {
      const b = document.querySelector('#homeAiClear');
      return b ? b.textContent : null;
    });
    H.check('home UI: the AI panel has a Clear session control', clearBtn === 'Clear session', String(clearBtn));
    await page.evaluate(() => document.querySelector('#homeAiClear').click());
    const cleared = await until(() => {
      const msgs = document.querySelectorAll('#homeAiThread .home-ai-msg').length;
      return msgs === 0 && !document.querySelector('#homeAiApplyBtn') ? 'empty' : null;
    });
    H.check('home UI: Clear session empties the thread and drops the pending proposal', !!cleared, String(cleared));
    const spendAfterClear = await page.evaluate(() => document.querySelectorAll('[data-home-section="spending"] .insight-card').length);
    H.check('home UI: Clear session deletes no insight cards', spendAfterClear === 3, String(spendAfterClear));
    H.check('home UI: Clear session does not navigate away from Home',
      await page.evaluate(() => ['', '#home'].includes(location.hash)), await page.evaluate(() => location.hash));
    // A new message after clearing starts a fresh thread: the old
    // "Added" line is gone, only the new exchange shows.
    fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'spending', title: 'Groceries spend', metric: 'category_spend:Groceries' } }));
    await page.evaluate(() => {
      const input = document.querySelector('#homeAiText');
      input.value = 'Show me groceries spending';
      document.querySelector('#homeAiSend').click();
    });
    const fresh = await until(() => {
      const b = document.querySelector('#homeAiApplyBtn');
      return b ? document.querySelector('#homeAiThread').textContent : null;
    });
    H.check('home UI: a message after Clear session proposes again from a fresh thread',
      !!fresh && fresh.includes('Groceries spend') && !fresh.includes('Added'), String(fresh && fresh.slice(0, 200)));

    // A per-entity card with a numeric id links to that entity's
    // detail page: append the property equity card, click it, land
    // on the property detail page, then delete it from Home.
    fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'property', title: 'Test home equity', metric: `property_equity:${pidA}` } }));
    await page.evaluate(() => {
      const input = document.querySelector('#homeAiText');
      input.value = 'Show me the first property equity';
      document.querySelector('#homeAiSend').click();
    });
    const propProposed = await until(() => {
      const b = document.querySelector('#homeAiApplyBtn');
      return b ? document.querySelector('#homeAiThread').textContent : null;
    });
    H.check('home UI: AI-append proposes the property equity card', !!propProposed && propProposed.includes('Test home equity'), String(propProposed && propProposed.slice(0, 200)));
    await page.evaluate(() => document.querySelector('#homeAiApplyBtn').click());
    const propAppended = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      return cards.length === 4 ? cards.map((c) => c.textContent).join(' | ') : null;
    });
    H.check('home UI: Apply appends the property AI card', !!propAppended && propAppended.includes('Test home equity'),
      String(propAppended && propAppended.slice(0, 300)));
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      cards.find((c) => c.textContent.includes('Test home equity')).click();
    });
    const propDetail = await until(() => {
      const v = document.querySelector('#view-property');
      // No Node-side variables in here: page.evaluate cannot see
      // closures (pidA is not serializable into the page). The
      // address text pins it to property A ('2 Home Test Way' is B).
      return location.hash.startsWith('#property/') && v && !v.classList.contains('hidden') && v.textContent.includes('1 Home Test Way') ? v.textContent : null;
    });
    H.check('home UI: clicking the property card opens that property detail page',
      !!propDetail, String(propDetail && propDetail.slice(0, 200)));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    await page.evaluate(() => document.querySelector('.home-card-del').click());
    const propDel = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      return cards.length === 3 ? 'back to 3' : null;
    });
    H.check('home UI: deleting the property AI card removes it and stays on Home',
      !!propDel && await page.evaluate(() => ['', '#home'].includes(location.hash)),
      JSON.stringify({ propDel, hash: await page.evaluate(() => location.hash) }));

    // Report mode: a property card shows the house photo only when
    // the property has one — no photo, no projection at all. The
    // photo is a tiny data-URI image so the pin needs no network.
    const photoUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = await H.req('PUT', `/api/properties/${pidA}`, { photo_url: photoUri });
    H.check('home report photo: setting a photo on property A succeeds', r.status === 200, JSON.stringify(r.data));
    // Append the per-property AI card again via the panel (it was
    // deleted above), then check the API attaches the photo to it.
    fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'property', title: 'Test home equity', metric: `property_equity:${pidA}` } }));
    await page.evaluate(() => {
      const input = document.querySelector('#homeAiText');
      input.value = 'Show me the first property equity';
      document.querySelector('#homeAiSend').click();
    });
    const photoProposed = await until(() => {
      const b = document.querySelector('#homeAiApplyBtn');
      return b ? document.querySelector('#homeAiThread').textContent : null;
    });
    H.check('home report photo: AI-append proposes the property equity card again', !!photoProposed && photoProposed.includes('Test home equity'), String(photoProposed && photoProposed.slice(0, 200)));
    await page.evaluate(() => document.querySelector('#homeAiApplyBtn').click());
    const photoAppended = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      return cards.length === 4 ? 'appended' : null;
    });
    H.check('home report photo: Apply appends the property AI card again', !!photoAppended, String(photoAppended));
    r = await H.req('GET', '/api/home');
    const aiPhoto = (r.data.insights.find((c) => c.kind === 'ai' && c.metric === `property_equity:${pidA}`) || {}).photo;
    const sysPhotos = r.data.insights.filter((c) => c.kind === 'system' && c.section === 'property').map((c) => c.photo);
    H.check('home report photo: the API attaches the photo to the property-entity AI card only',
      aiPhoto === photoUri && sysPhotos.every((p) => p == null), JSON.stringify({ aiPhoto, sysPhotos }));
    // In report mode, on the Property section (wheel down once from
    // Upcoming payments). The active card is index 0, Assessed total.
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    await until(() => document.querySelector('#view-home').classList.contains('home-report'));
    const repStage = await page.evaluate(() => {
      const el = document.querySelector('#homeReport');
      const rr = el.getBoundingClientRect();
      return { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
    });
    await page.mouse.move(repStage.x, repStage.y);
    await page.mouse.wheel({ deltaY: 120 });
    await wait(700); // the 600ms navigation lock
    // No photo inside any report card: the house photo lives on the
    // view backdrop instead (see below).
    const reportPhotos = await page.evaluate(() => [...document.querySelectorAll('#homeReport .insight-card')].map((c) => ({
      img: !!c.querySelector('img'), photoBlock: !!c.querySelector('.report-photo'),
    })));
    H.check('home report photo: no photo element inside any report card',
      reportPhotos.every((p) => !p.img && !p.photoBlock), JSON.stringify(reportPhotos));
    // Backdrop: the aggregate card (index 0, Assessed total) gets the
    // gradient only — no projection. The per-property AI card (index
    // 3) projects its house photo large and dimmed behind the cards.
    const backdropOff = await page.evaluate(() => [...document.querySelectorAll('#homeReportBackdrop .report-backdrop-layer')].map((l) => l.classList.contains('is-on')));
    H.check('home report photo: aggregate card active — no photo backdrop, gradient only',
      JSON.stringify(backdropOff) === JSON.stringify([false, false]), JSON.stringify(backdropOff));
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await wait(700); }
    const backdropOn = await page.evaluate((uri) => {
      const on = [...document.querySelectorAll('#homeReportBackdrop .report-backdrop-layer')]
        .filter((l) => l.classList.contains('is-on'));
      return { count: on.length, showsPhoto: on.length === 1 && on[0].style.backgroundImage.includes(uri) };
    }, photoUri);
    H.check('home report photo: per-property card active — its photo projects on the backdrop',
      backdropOn.count === 1 && backdropOn.showsPhoto, JSON.stringify(backdropOn));
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowLeft'); await wait(700); }
    const backdropOffAgain = await page.evaluate(() => [...document.querySelectorAll('#homeReportBackdrop .report-backdrop-layer')].map((l) => l.classList.contains('is-on')));
    H.check('home report photo: back on the aggregate card — the projection fades away',
      JSON.stringify(backdropOffAgain) === JSON.stringify([false, false]), JSON.stringify(backdropOffAgain));
    // Clean up: back to insight mode, delete the AI card, clear the photo.
    await page.evaluate(() => document.querySelector('#homeModeBtn').click());
    await toInsight();
    await page.evaluate(() => document.querySelector('.home-card-del').click());
    const photoDel = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      return cards.length === 3 ? 'back to 3' : null;
    });
    H.check('home report photo: deleting the AI card cleans up', !!photoDel, String(photoDel));
    r = await H.req('PUT', `/api/properties/${pidA}`, { photo_url: null });
    H.check('home report photo: clearing the photo succeeds', r.status === 200, JSON.stringify(r.data));

    // A standard card falls back to its section summary page.
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      cards.find((c) => c.textContent.includes('Assessed total')).click();
    });
    const stdNav = await until(() => {
      const s = document.querySelector('#section-properties');
      return location.hash === '#assets/properties' && s && !s.classList.contains('hidden') ? 'properties list' : null;
    });
    H.check('home UI: clicking a standard card opens its section summary page',
      !!stdNav, String(stdNav));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    await toInsight();
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);

    // Overview is untouched: its route still renders.
    await page.goto('http://ff.local/#assets/overview', { waitUntil: 'networkidle0', timeout: 30000 });
    const overviewOk = await until(() => {
      const s = document.querySelector('#section-overview');
      return s && !s.classList.contains('hidden') ? s.textContent : null;
    });
    H.check('home UI: Overview route still renders unchanged', !!overviewOk && overviewOk.includes('Assets over time'),
      String(overviewOk && overviewOk.slice(0, 200)));
  } finally {
    await browser.close();
  }
}
runModuleMain(import.meta.url, { name: 'home', deps, run });
