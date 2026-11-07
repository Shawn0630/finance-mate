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
  r = await H.req('POST', '/api/home/marks', { kind: 'rental', source_id: rentalId, date: '2026-10-15', received: 1 });
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
    client.on('Fetch.requestPaused', async (e) => {
      try {
        const u = new URL(e.request.url);
        if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
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
    H.check('home UI: folded deck — the snapped card is active, on top, full size; the neighbour tucks under',
      folded.active && Number(folded.z1) > Number(folded.z0) && !folded.t1.includes('0.97') && folded.t0.includes('0.97'),
      JSON.stringify(folded));

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
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    await page.evaluate(() => document.querySelector('[data-home-section="spending"]').previousElementSibling.querySelector('.home-section-all').click());
    const spendLanded = await until(() => {
      const v = document.querySelector('#view-spending');
      return v && !v.classList.contains('hidden') && location.hash === '#spending';
    });
    H.check('home UI: Spending View all navigates to the Spending page', !!spendLanded, await page.evaluate(() => location.hash));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
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
    const persisted = await until(() => {
      const b = document.querySelector('#homeHighlightCarousel .insight-card[data-pay-kind="salary"] [data-mark-kind]');
      return b && b.textContent.includes('Received') ? b.textContent : null;
    });
    H.check('home UI: Received toggle persists across reload', !!persisted, String(persisted));

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
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);

    // Drag-and-drop: every insight card has a handle; the highlight carousel has none.
    const handles = await page.evaluate(() => ({
      insight: document.querySelectorAll('#homeSections [data-drag-handle]').length,
      highlight: document.querySelectorAll('#homeHighlightCarousel [data-drag-handle]').length,
      cards: document.querySelectorAll('#homeSections .insight-card').length,
    }));
    H.check('home UI: every insight card has a drag handle; the highlight carousel has none',
      handles.insight === handles.cards && handles.cards === 12 && handles.highlight === 0, JSON.stringify(handles));
    // Drag the property section's third card (Outstanding principal)
    // onto the second (Assessed total): the order becomes Total
    // equity, Outstanding principal, Assessed total — and the drag
    // does not navigate. The viewport is only 800px wide, so the
    // third card starts off-screen: scroll the carousel to the second
    // card's start (a snap point) so the third card's handle sits in
    // view and the second card is droppable.
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
    // third card's handle sits in view and the second card is
    // droppable.
    await page.evaluate(() => {
      const sec = document.querySelector('[data-home-section="property"]');
      window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - 80, behavior: 'instant' });
      const car = sec;
      car.scrollTo({ left: car.querySelectorAll('.insight-card')[1].offsetLeft, behavior: 'instant' });
    });
    // Wait for the third card's handle to be hittable inside the
    // viewport before starting the drag.
    const handleReady = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      if (cards.length !== 3) return null;
      const h = cards[2].querySelector('[data-drag-handle]').getBoundingClientRect();
      const cx = h.left + h.width / 2, cy = h.top + h.height / 2;
      if (cx <= 0 || cx >= innerWidth || cy <= 0 || cy >= innerHeight) return null;
      const at = document.elementFromPoint(cx, cy);
      return at === cards[2].querySelector('[data-drag-handle]') ? 'ready' : null;
    });
    H.check('home UI: drag precondition — third card handle is hittable after scrolling',
      !!handleReady, String(handleReady));
    const dragPts = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      const h = cards[2].querySelector('[data-drag-handle]').getBoundingClientRect();
      const second = cards[1].getBoundingClientRect();
      return {
        from: { x: h.left + h.width / 2, y: h.top + h.height / 2 },
        to: { x: second.left + 30, y: second.top + second.height / 2 },
      };
    });
    await page.mouse.move(dragPts.from.x, dragPts.from.y);
    await page.mouse.down();
    await page.mouse.move(dragPts.to.x, dragPts.to.y, { steps: 12 });
    await page.mouse.up();
    const propOrderAfterDrag = await page.evaluate(() => [...document.querySelectorAll('[data-home-section="property"] .insight-card .insight-label')].map((el) => el.textContent));
    H.check('home UI: dragging a card by its handle reorders the section',
      JSON.stringify(propOrderAfterDrag) === JSON.stringify(['Total equity', 'Outstanding principal', 'Assessed total']),
      JSON.stringify(propOrderAfterDrag));
    H.check('home UI: dragging a card does not navigate away from Home',
      await page.evaluate(() => ['', '#home'].includes(location.hash)), await page.evaluate(() => location.hash));
    r = await H.req('GET', '/api/home');
    H.check('home UI: the dragged order reached the server',
      JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric))
      === JSON.stringify(['property_equity', 'property_outstanding', 'property_assessed']),
      JSON.stringify(r.data.insights.filter((c) => c.section === 'property').map((c) => c.metric)));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
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
    await until(() => document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0);
    await page.evaluate(() => document.querySelector('.home-card-del').click());
    const propDel = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      return cards.length === 3 ? 'back to 3' : null;
    });
    H.check('home UI: deleting the property AI card removes it and stays on Home',
      !!propDel && await page.evaluate(() => ['', '#home'].includes(location.hash)),
      JSON.stringify({ propDel, hash: await page.evaluate(() => location.hash) }));

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
