// tax: Tax module — projects per person-year (many per
// person-year), NO Generate anywhere (projects start empty; the
// user adds items via Add, picking from the region's candidate
// list), TurboTax-style sections, the T776 rental flow with the
// derived deduction row, the RRSP window, the RRSP contribution
// tool, the T1 refund headline + popup (pinned against the
// user's 2025 return), the home person switcher + room charts,
// the History Tax filter, export round-trip, and UI.
// Run standalone: node tests/e2e-tax.mjs
// Run via the suite runner: node tests/e2e-run.mjs --only tax
import http from 'node:http';
import fs from 'node:fs';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  const ensureAdmin = async () => {
    const l = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
    if (l.status !== 200) throw new Error('re-login failed after import wiped sessions');
  };

  // ---- years endpoint ----
  r = await H.req('GET', '/api/tax/years');
  H.check('tax: years endpoint lists the current year',
    r.status === 200 && Array.isArray(r.data.years) && r.data.years.includes(2026) && r.data.current === 2026,
    JSON.stringify(r.data));

  // ---- seed: a Shawn job (Meta-like), an ownerless job, a 2025
  // Shawn job for the refund fixture, an RRSP plan for the
  // windowed annual, and a TFSA buy for the charts ----
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Tax Meta', owner: 'Shawn', currency: 'CAD', province: 'BC',
    frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period', tax_year: 2026,
  });
  H.check('tax: Shawn job created (annual gross 190,704.02)',
    r.status === 201 && r.data.calc && r.data.calc.annualGross === 190704.02,
    JSON.stringify(r.data && r.data.calc));
  const metaJobId = r.data.id;
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Tax Gig', currency: 'CAD', province: 'BC',
    frequency: 'biweekly', gross_amount: 1000, gross_basis: 'period', tax_year: 2026,
  });
  H.check('tax: ownerless job created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const gigJobId = r.data.id;
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Tax Meta', owner: 'Shawn', currency: 'CAD', province: 'BC',
    frequency: 'biweekly', gross_amount: 29406.07, gross_basis: 'period', tax_year: 2025,
  });
  H.check('tax: 2025 Shawn job created for the refund fixture',
    r.status === 201 && !!r.data.id, JSON.stringify(r.data));

  r = await H.req('POST', '/api/investments/accounts', { name: 'Tax RRSP', type: 'RRSP', owners: ['Shawn'] });
  H.check('tax: RRSP account created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const rrspAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${rrspAcctId}/holdings`, { label: 'Tax Fund', kind: 'fund', currency: 'CAD' });
  const rrspFundId = r.data.id;
  // A manual buy first: plan generation needs a price on or
  // before each due date, and a priceless fund skips every
  // period ("no price on or before this date").
  r = await H.req('POST', `/api/investments/holdings/${rrspFundId}/events`, { date: '2025-12-31', type: 'buy', units: 100, price: 10 });
  H.check('tax: RRSP fund seeded with a price ($10)', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/${rrspAcctId}/plans`, {
    job_id: metaJobId, target_holding_id: rrspFundId, start_date: '2026-01-01', own_amount: 220.05, employer_amount: 0,
  });
  H.check('tax: RRSP contribution plan created (generated buys exist)',
    r.status === 201 && r.data.generation && Array.isArray(r.data.generation.created) && r.data.generation.created.length > 0,
    JSON.stringify(r.data && r.data.generation));

  r = await H.req('POST', '/api/investments/accounts', { name: 'Tax TFSA', type: 'TFSA', owners: ['Shawn'] });
  H.check('tax: TFSA account created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const tfsaAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${tfsaAcctId}/holdings`, { label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', currency: 'CAD' });
  const xqqId = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${xqqId}/events`, { date: '2026-01-05', type: 'buy', units: 10, price: 145 });
  H.check('tax: TFSA buy recorded (10 × $145 = $1,450 contributed)',
    r.status === 201 && !!r.data.id, JSON.stringify(r.data));

  // NonRegistered account: a dividend and a sell feed the
  // investment-income and capital-gain candidates.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Tax Margin', type: 'NonRegistered', owners: ['Shawn'] });
  const marginAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${marginAcctId}/holdings`, { label: 'SHOP', kind: 'exchange', symbol: 'SHOP.TO', currency: 'CAD' });
  const shopId = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${shopId}/events`, { date: '2026-01-06', type: 'buy', units: 10, price: 100 });
  H.check('tax: margin buy recorded', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${shopId}/events`, { date: '2026-03-10', type: 'dividend', amount: 123.45 });
  H.check('tax: dividend recorded', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${shopId}/events`, { date: '2026-04-01', type: 'sell', units: 10, price: 150.5 });
  H.check('tax: sell recorded (10 × $150.50 = $1,505 proceeds)',
    r.status === 201 && !!r.data.id, JSON.stringify(r.data));

  // Rental (no linked property → the candidate is unlinked):
  // $2,000/mo rent, $6,000 mortgage interest, $12,000 property
  // tax shared 50%, $500 advertising direct → gross $24,000,
  // deductible $12,500, net $11,500.
  r = await H.req('POST', '/api/earnings/rentals', {
    label: 'Basement suite', rental_type: 'long_term', services_level: 'basic',
  });
  H.check('tax: rental created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const rentalId = r.data.id;
  r = await H.req('POST', `/api/earnings/rentals/${rentalId}/years`, {
    tax_year: 2026, other_income: 0, area_share_pct: 50,
    mortgage_interest: 6000, mortgage_principal: 9000,
    expenses: [{ line: '9180', amount: 12000, direct: false }, { line: '8521', amount: 500, direct: true }],
  });
  H.check('tax: rental year created', r.status === 201 && r.data.tax_year === 2026, JSON.stringify(r.data));
  r = await H.req('POST', `/api/earnings/rentals/${rentalId}/entries`, {
    start_ym: '2025-01', end_ym: '2026-12', monthly_rent: 2000, pay_day: 1, cash_amount: 500, tenant_name: 'Test Tenant',
  });
  H.check('tax: rent entry created', r.status === 201 && r.data.entries.length === 1, JSON.stringify(r.data.entries));

  // ---- filers: Shawn + Jiaying, admin excluded ----
  r = await H.req('GET', '/api/tax/filings?year=2026');
  H.check('tax: filings list has Shawn + Jiaying and no admin',
    r.status === 200 && Array.isArray(r.data.filers)
      && r.data.filers.map((f) => f.person.username).sort().join(',') === 'Jiaying,Shawn',
    JSON.stringify((r.data.filers || []).map((f) => f.person.username)));
  const shawnId = r.data.filers.find((f) => f.person.username === 'Shawn').person.id;
  const jiayingId = r.data.filers.find((f) => f.person.username === 'Jiaying').person.id;

  // ---- two projects for the same person + year ----
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'Tax return 2026' });
  H.check('tax: project A created', r.status === 201 && !!r.data.id && r.data.name === 'Tax return 2026', JSON.stringify(r.data));
  const projA = r.data.id;
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'Rental only' });
  H.check('tax: project B created for the same person + year (distinct id)',
    r.status === 201 && !!r.data.id && r.data.id !== projA, JSON.stringify(r.data));
  const projB = r.data.id;
  r = await H.req('POST', '/api/tax/filings', { personId: 9999, year: 2026, name: 'Ghost' });
  H.check('tax: unknown person is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'US one', region: 'US' });
  H.check('tax: unknown region is a 400', r.status === 400, JSON.stringify(r.status));

  // ---- no pre-generation: both projects list 0 items ----
  r = await H.req('GET', '/api/tax/filings?year=2026');
  const shawn = r.data.filers.find((f) => f.person.username === 'Shawn');
  H.check('tax: no pre-generation — both projects list 0 items and no card balance',
    shawn.projects.length === 2 && shawn.projects.every((p) => p.itemCount === 0 && p.refund === null),
    JSON.stringify(shawn.projects.map((p) => ({ name: p.name, itemCount: p.itemCount, refund: p.refund }))));

  // ---- detail before adding: the four guided sections, no
  // items, the windowed RRSP annual and the RRSP window ----
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: detail renders the four guided sections with no items yet',
    r.status === 200 && r.data.sections && Object.keys(r.data.sections).sort().join(',') === 'deductions,income,provincial,registered'
      && r.data.items.length === 0 && r.data.rrspPlanAnnual === 3960.9
      && r.data.rrspWindow && r.data.rrspWindow.start === '2026-03-01' && r.data.rrspWindow.end === '2027-03-01',
    JSON.stringify({ sections: Object.keys(r.data.sections || {}), items: (r.data.items || []).length, rrspPlanAnnual: r.data.rrspPlanAnnual, rrspWindow: r.data.rrspWindow }));

  // ---- candidates: the region derivation, minus nothing yet ----
  r = await H.req('GET', `/api/tax/filings/${projA}/candidates`);
  const cands = r.data.candidates || [];
  const candBy = (kind, sourceType) => cands.find((c) => c.kind === kind && (!sourceType || c.sourceType === sourceType));
  // Two jobs exist (the gig sorts first alphabetically), so the
  // Meta employment is matched by its source id, not by find.
  const empCand = cands.find((c) => c.sourceType === 'job' && Number(c.sourceId) === Number(metaJobId));
  H.check('tax: candidates list employment, RRSP, dividend, sell and the unlinked rental',
    r.status === 200
      && empCand && empCand.amount === 190704.02
      && candBy('employment', 'job') && candBy('employment', 'job').amount === 26000
      && candBy('rrsp', 'plan') && candBy('rrsp', 'plan').amount === 3960.9
      && candBy('investment_income', 'dividend') && candBy('investment_income', 'dividend').amount === 123.45
      && candBy('capital_gain', 'sell') && candBy('capital_gain', 'sell').amount === 1505
      && candBy('rental', 'rental') && candBy('rental', 'rental').amount === 11500,
    JSON.stringify(cands.map((c) => ({ kind: c.kind, sourceType: c.sourceType, amount: c.amount }))));

  // ---- add the candidates to A, one explicit Add each ----
  const addCand = async (sourceType, sourceId) => H.req('POST', `/api/tax/filings/${projA}/items/from-candidate`, { sourceType, sourceId });
  r = await addCand('job', metaJobId);
  H.check('tax: employment candidate added as linked ($190,704.02)',
    r.status === 201 && r.data.kind === 'employment' && r.data.amount === 190704.02 && r.data.status === 'linked',
    JSON.stringify(r.data));
  r = await addCand('job', metaJobId);
  H.check('tax: adding the same candidate twice is a 400', r.status === 400, JSON.stringify(r.status));
  r = await addCand('plan', (await H.req('GET', `/api/tax/filings/${projA}/candidates`)).data.candidates.find((c) => c.kind === 'rrsp').sourceId);
  H.check('tax: RRSP candidate added ($3,960.90 — the windowed annual)',
    r.status === 201 && r.data.kind === 'rrsp' && r.data.amount === 3960.9, JSON.stringify(r.data));
  r = await addCand('dividend', candBy('investment_income', 'dividend').sourceId);
  H.check('tax: dividend candidate added ($123.45)',
    r.status === 201 && r.data.kind === 'investment_income' && r.data.amount === 123.45, JSON.stringify(r.data));
  r = await addCand('sell', candBy('capital_gain', 'sell').sourceId);
  H.check('tax: sell candidate added ($1,505 proceeds)',
    r.status === 201 && r.data.kind === 'capital_gain' && r.data.amount === 1505, JSON.stringify(r.data));

  // ---- manual T776 on A: the server re-derives the net and
  // syncs the derived rental-deduction row ----
  const t776Lines = { gross_rents: 22800, other_income: 200, 8710: 12000, 8521: 6903.37 };
  r = await H.req('POST', `/api/tax/filings/${projA}/items`, {
    kind: 'rental', label: 'Manual rental (T776)', amount: 4096.63, share_pct: 100,
    detail: { form: 'T776', lines: t776Lines },
  });
  H.check('tax: manual T776 rental added — server derives gross $23,000 / deductible $18,903.37 / net $4,096.63',
    r.status === 201 && r.data.kind === 'rental' && r.data.amount === 4096.63
      && r.data.detail && r.data.detail.gross === 23000 && r.data.detail.deductible === 18903.37 && r.data.detail.net === 4096.63,
    JSON.stringify(r.data));
  const manualRentalId = r.data.id;
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  const derivedA = (r.data.items || []).find((i) => i.detail && i.detail.derived);
  H.check('tax: the derived rental-deduction row appears ($18,903.37, linked, in Income)',
    !!derivedA && derivedA.kind === 'deduction' && derivedA.amount === 18903.37 && derivedA.status === 'linked'
      && derivedA.source_type === 'rental-deduction',
    JSON.stringify((r.data.items || []).map((i) => ({ kind: i.kind, amount: i.amount, derived: !!(i.detail && i.detail.derived) }))));
  H.check('tax: Income totals the net rental, not the gross — and the derived row adds $0',
    r.data.sections && r.data.sections.income && r.data.sections.income.amount === 196429.1
      && r.data.sections.deductions && r.data.sections.deductions.amount === 0,
    JSON.stringify(r.data.sections));
  r = await H.req('PUT', `/api/tax/items/${derivedA.id}`, { amount: 1 });
  H.check('tax: editing the derived row directly is a 400', r.status === 400, JSON.stringify(r.status));
  // Edit the T776 (mortgage interest $12,000 → $11,000): the
  // item re-derives and the derived row follows in the same write.
  r = await H.req('PUT', `/api/tax/items/${manualRentalId}`, {
    detail: { form: 'T776', lines: { ...t776Lines, 8710: 11000 } },
  });
  H.check('tax: editing the T776 re-derives the rental net ($5,096.63)',
    r.status === 200 && r.data.amount === 5096.63 && r.data.detail && r.data.detail.deductible === 17903.37,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  const derivedA2 = (r.data.items || []).find((i) => i.detail && i.detail.derived);
  H.check('tax: the derived row follows the T776 edit ($17,903.37)',
    !!derivedA2 && derivedA2.amount === 17903.37, JSON.stringify(derivedA2));

  // ---- RESP: tracked, non-deductible, $0 in every total ----
  r = await H.req('POST', `/api/tax/filings/${projA}/items`, {
    kind: 'resp', label: 'RESP — Baby', amount: 5000, share_pct: 100,
  });
  H.check('tax: RESP item added as a manual tracked item',
    r.status === 201 && r.data.kind === 'resp' && r.data.amount === 5000, JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: Registered totals the RRSP only — RESP contributes $0',
    r.data.sections && r.data.sections.registered && r.data.sections.registered.amount === 3960.9
      && (r.data.items || []).length === 7,
    JSON.stringify({ registered: r.data.sections.registered, items: (r.data.items || []).length }));

  // ---- Slip on A creates a linked item ----
  r = await H.req('POST', `/api/tax/filings/${projA}/slips`, {
    kind: 'T4', tax_year: 2026, fields: { box14: 190704.02, employer_name: 'Tax Meta' }, source: 'manual',
  });
  H.check('tax: T4 slip created with its linked employment item',
    r.status === 201 && r.data.slip && r.data.slip.kind === 'T4' && r.data.item && r.data.item.amount === 190704.02 && r.data.item.status === 'linked',
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/tax/filings/${projA}/slips`, { kind: 'T9', tax_year: 2026, fields: {} });
  H.check('tax: unknown slip kind is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('POST', `/api/tax/filings/${projA}/slips`, { kind: 'T4', tax_year: 2025, fields: { box14: 1 } });
  H.check('tax: slip year must match the filing year', r.status === 400, JSON.stringify(r.status));

  // ---- B takes the ownerless gig and the unlinked rental ----
  r = await H.req('GET', `/api/tax/filings/${projB}/candidates`);
  const candsB = r.data.candidates || [];
  H.check('tax: B still sees the unlinked gig and rental candidates',
    candsB.some((c) => c.kind === 'employment' && c.sourceId === gigJobId && c.amount === 26000)
      && candsB.some((c) => c.kind === 'rental' && c.amount === 11500),
    JSON.stringify(candsB.map((c) => ({ kind: c.kind, sourceId: c.sourceId, amount: c.amount }))));
  r = await H.req('POST', `/api/tax/filings/${projB}/items/from-candidate`, { sourceType: 'job', sourceId: gigJobId });
  H.check('tax: gig candidate added to B as linked ($26,000)',
    r.status === 201 && r.data.amount === 26000 && r.data.status === 'linked', JSON.stringify(r.data));
  r = await H.req('POST', `/api/tax/filings/${projB}/items/from-candidate`, { sourceType: 'rental', sourceId: rentalId });
  H.check('tax: rental candidate added to B ($11,500 net)',
    r.status === 201 && r.data.kind === 'rental' && r.data.amount === 11500, JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projB}`);
  const derivedB = (r.data.items || []).find((i) => i.detail && i.detail.derived);
  H.check('tax: B has the gig, the rental and its derived deduction row ($12,500)',
    (r.data.items || []).length === 3 && !!derivedB && derivedB.amount === 12500,
    JSON.stringify((r.data.items || []).map((i) => ({ kind: i.kind, amount: i.amount, derived: !!(i.detail && i.detail.derived) }))));

  // ---- 2025 fixture filing: the T4 slip places the employment
  // item, the rest are added manually — the refund must
  // reproduce his real 2025 return ($16,615.42) ----
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2025, name: 'Tax return 2025' });
  H.check('tax: 2025 fixture filing created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const proj2025 = r.data.id;
  r = await H.req('POST', `/api/tax/filings/${proj2025}/slips`, {
    kind: 'T4', tax_year: 2025, fields: { box14: 764557.72, box22: 354009.41, employer_name: 'Tax Meta' }, source: 'manual',
  });
  H.check('tax: 2025 T4 slip places the $764,557.72 employment item',
    r.status === 201 && r.data.item && r.data.item.amount === 764557.72, JSON.stringify(r.data));
  for (const [kind, label, amount] of [
    ['investment_income', 'Interest', 528.20],
    ['rental', 'Rental', -3610.98],
    ['other_income', 'RRSP income', 677.00],
    ['rrsp', 'RRSP contributions', 33251.00],
  ]) {
    r = await H.req('POST', `/api/tax/filings/${proj2025}/items`, { kind, label, amount, share_pct: 100 });
    H.check(`tax: 2025 fixture item ${kind} $${amount} added`,
      r.status === 201 && r.data.amount === amount, JSON.stringify(r.data));
  }
  r = await H.req('GET', `/api/tax/filings/${proj2025}/refund`);
  H.check('tax: the 2025 refund reproduces his return — $16,615.42',
    r.status === 200 && r.data.refund === 16615.42 && r.data.isRefund === true && r.data.label === 'Refund'
      && Array.isArray(r.data.lines) && r.data.lines.find((l) => l.line === '48400') && r.data.lines.find((l) => l.line === '48400').amount === 16615.42
      && r.data.lines.find((l) => l.line === '15000').amount === 762151.94
      && r.data.lines.find((l) => l.line === '43500').amount === 337393.99,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}/refund`);
  H.check('tax: the 2026 refund endpoint answers for A too',
    r.status === 200 && typeof r.data.refund === 'number' && r.data.province === 'BC',
    JSON.stringify({ refund: r.data.refund, province: r.data.province }));
  // ---- the list endpoint carries the card balance ----
  const refundA = r.data;
  H.check('tax: refund endpoint returns a balance-owing figure for A (no tax withheld)',
    refundA && refundA.isRefund === false && refundA.label === 'Balance owing'
      && typeof refundA.displayAmount === 'number' && refundA.displayAmount > 0
      && refundA.refund === -refundA.displayAmount,
    JSON.stringify({ isRefund: refundA && refundA.isRefund, label: refundA && refundA.label, displayAmount: refundA && refundA.displayAmount, refund: refundA && refundA.refund }));
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'Empty draft' });
  H.check('tax: empty draft project created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const projEmpty = r.data.id;
  r = await H.req('GET', '/api/tax/filings?year=2026');
  const shawnAfter = r.data.filers.find((f) => f.person.username === 'Shawn');
  const listA = shawnAfter.projects.find((p) => p.id === projA);
  const listB = shawnAfter.projects.find((p) => p.id === projB);
  const listEmpty = shawnAfter.projects.find((p) => p.id === projEmpty);
  H.check('tax: list endpoint carries the same refund figure on A and B, and null on the empty draft',
    listA && listA.refund && listA.refund.displayAmount === refundA.displayAmount
      && listA.refund.label === refundA.label && listA.refund.isRefund === refundA.isRefund
      && listB && listB.refund && listB.refund.label === 'Balance owing' && listB.refund.displayAmount > 0
      && listEmpty && listEmpty.refund === null,
    JSON.stringify(shawnAfter.projects.map((p) => ({ name: p.name, refund: p.refund }))));

  // ---- Tax Profile: user-entered room, validated ----
  r = await H.req('PUT', `/api/tax/profiles/${shawnId}`, {
    rrsp_room: 20000, tfsa_room: 5000, resp_beneficiary: 'Baby', resp_subscriber: 'Shawn',
    resp_room: 45000, cesg_room: 7000, as_of_date: '2026-10-31',
  });
  H.check('tax: profile saved', r.status === 200 && r.data.profile && r.data.profile.rrsp_room === 20000, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/tax/profiles/${shawnId}`, { resp_room: 50001 });
  H.check('tax: RESP room above the $50,000 lifetime limit is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('GET', `/api/tax/profiles/${shawnId}`);
  H.check('tax: profile reads back with all rooms',
    r.status === 200 && r.data.profile && r.data.profile.rrsp_room === 20000 && r.data.profile.tfsa_room === 5000
      && r.data.profile.resp_room === 45000 && r.data.profile.cesg_room === 7000 && r.data.profile.resp_beneficiary === 'Baby',
    JSON.stringify(r.data.profile));

  // ---- RRSP benefit slider endpoint (reuses the Earnings engine) ----
  r = await H.req('GET', `/api/tax/filings/${projA}/rrsp-benefit?amount=11442.60`);
  H.check('tax: $11,442.60 saves $4,925.25 (his paystub figure, to the cent of the engine)',
    r.status === 200 && r.data.benefit === 4925.25 && r.data.capped === false && r.data.effectiveAmount === 11442.6,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}/rrsp-benefit?amount=25000`);
  H.check('tax: amount above the recorded room is capped at $20,000',
    r.status === 200 && r.data.capped === true && r.data.effectiveAmount === 20000 && r.data.room === 20000,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}/rrsp-benefit?amount=-1`);
  H.check('tax: negative amount is a 400', r.status === 400, JSON.stringify(r.status));

  // ---- Charts: contributed vs remaining — the home (profile)
  // charts are keyed to the requested year Y and read year Y−1
  // (the last completed year); the filing charts read this
  // project's items when it has any (basis tells which), with
  // no cutoff. RESP/CESG come from the profile split (limit
  // minus recorded remaining room) in both views — the app
  // holds no dated RESP history. ----
  r = await H.req('GET', `/api/tax/profiles/${shawnId}/charts?year=2026`);
  H.check('tax: home charts for 2026 read 2025 records (RRSP plan buys + TFSA buy are 2026, so $0; RESP $5,000 of $50,000, CESG $200 of $7,200)',
    r.status === 200 && r.data.asOfYear === 2025
      && r.data.rrsp && r.data.rrsp.contributed === 0 && r.data.rrsp.room === 20000 && r.data.rrsp.basis === 'plans'
      && r.data.tfsa && r.data.tfsa.contributed === 0 && r.data.tfsa.room === 5000
      && r.data.resp && r.data.resp.split && r.data.resp.split.contributed === 5000 && r.data.resp.split.remaining === 45000
      && r.data.resp.cesg && r.data.resp.cesg.earned === 200 && r.data.resp.cesg.remaining === 7000,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/profiles/${shawnId}/charts?year=2027`);
  H.check('tax: home charts for 2027 read 2026 records (RRSP plan buys $5,061.15, TFSA $1,450)',
    r.status === 200 && r.data.asOfYear === 2026
      && r.data.rrsp && r.data.rrsp.contributed === 5061.15 && r.data.rrsp.basis === 'plans'
      && r.data.tfsa && r.data.tfsa.contributed === 1450,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/profiles/${shawnId}/charts`);
  H.check('tax: home charts with no year default to the current year minus one (2025)',
    r.status === 200 && r.data.asOfYear === 2025 && r.data.rrsp.contributed === 0 && r.data.tfsa.contributed === 0,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/profiles/${shawnId}/charts?year=1800`);
  H.check('tax: home charts with an out-of-range year is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('GET', `/api/tax/filings/${projA}/charts`);
  H.check('tax: filing charts use this project\'s RRSP items ($3,960.90, basis project)',
    r.status === 200 && r.data.rrsp && r.data.rrsp.contributed === 3960.9 && r.data.rrsp.basis === 'project' && r.data.rrsp.room === 20000,
    JSON.stringify(r.data.rrsp));

  // ---- History: the Tax filter covers tax + tax-profile ----
  r = await H.req('GET', '/api/history/commits?limit=200');
  const allCommits = r.data.commits || [];
  const taxCount = allCommits.filter((c) => c.module === 'tax' || c.module === 'tax-profile').length;
  H.check('tax: the run produced tax + tax-profile commits',
    r.status === 200 && taxCount > 0 && allCommits.some((c) => c.module === 'tax-profile'),
    JSON.stringify({ total: r.data.total, taxCount }));
  r = await H.req('GET', '/api/history/commits?module=tax&limit=200');
  H.check('tax: History filter by tax shows only tax + tax-profile commits',
    r.status === 200 && r.data.total === taxCount
      && (r.data.commits || []).every((c) => c.module === 'tax' || c.module === 'tax-profile')
      && (r.data.commits || []).some((c) => c.module === 'tax-profile'),
    JSON.stringify({ total: r.data.total, taxCount, modules: [...new Set((r.data.commits || []).map((c) => c.module))] }));

  // ---- Export round-trip: tax tables travel, delete, import, back ----
  // A: 8 items (4 candidates + manual T776 + derived row + RESP +
  // T4-slip employment) · B: 3 (gig + rental + derived row) ·
  // 2025: 5 (T4-slip employment + 4 manual) · slips: 2.
  r = await H.req('GET', '/api/admin/data/export');
  const taxExport = r.data;
  H.check('tax: export carries all four Tax tables with rows (16 items, 2 slips)',
    r.status === 200 && Array.isArray(taxExport.tables.tax_filings) && taxExport.tables.tax_filings.some((f) => f.id === projA)
      && Array.isArray(taxExport.tables.tax_profiles) && taxExport.tables.tax_profiles.some((p) => p.rrsp_room === 20000)
      && Array.isArray(taxExport.tables.tax_items) && taxExport.tables.tax_items.length === 16
      && Array.isArray(taxExport.tables.tax_slips) && taxExport.tables.tax_slips.length === 2,
    JSON.stringify({ filings: (taxExport.tables.tax_filings || []).length, profiles: (taxExport.tables.tax_profiles || []).length, items: (taxExport.tables.tax_items || []).length, slips: (taxExport.tables.tax_slips || []).length }));
  r = await H.req('DELETE', `/api/tax/filings/${projA}`);
  H.check('tax: project A deleted', r.status === 200, JSON.stringify(r.status));
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: project A is gone before import', r.status === 404, JSON.stringify(r.status));
  r = await H.req('POST', '/api/admin/data/import', { data: taxExport, confirm: true });
  H.check('tax: import restores the export', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  await ensureAdmin();
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: project A is back after import',
    r.status === 200 && r.data.name === 'Tax return 2026' && (r.data.items || []).length === 8 && (r.data.slips || []).length === 1,
    JSON.stringify({ name: r.data && r.data.name, items: (r.data.items || []).length, slips: (r.data.slips || []).length }));

  // ---- UI: switcher, card click, detail, refund popup, RRSP
  // tool, AI fill preview, profile Edit ----
  if (!H.chromeAvailable) {
    H.check('tax UI: skipped (no Chrome)', true, 'no chrome');
    return;
  }
  const forwardH = (rq) => new Promise((resolve, reject) => {
    const rr = http.request(
      { host: '127.0.0.1', port: H.PORT, path: rq.url, method: rq.method, headers: rq.headers },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      },
    );
    rr.on('error', reject);
    if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
    rr.end();
  });
  const loginRes = await fetch(`${H.BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
  const browser = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--unsafely-treat-insecure-origin-as-secure=http://ff.local',
      ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
  });
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const page = await browser.newPage();
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
  const until = async (fn, tries = 48) => {
    for (let i = 0; i < tries; i++) {
      try { const v = await page.evaluate(fn); if (v) return v; } catch {}
      await wait(250);
    }
    return null;
  };
  try {
    await page.goto('http://ff.local/#tax', { waitUntil: 'networkidle0', timeout: 30000 });
    H.check('tax UI: switcher shows Shawn + Jiaying, Shawn selected',
      await until(() => {
        const tabs = document.querySelectorAll('#taxPersonTabs button');
        const active = document.querySelector('#taxPersonTabs button.active');
        return tabs.length === 2 && active && active.textContent.trim() === 'Shawn' ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxPersonTabs').textContent));
    H.check('tax UI: home lists only Shawn\'s projects (both 2026 projects, no Open button, no Generate button)',
      await until(() => {
        const body = document.querySelector('#taxPersonBody');
        if (!body || !body.textContent.includes('Tax return 2026') || !body.textContent.includes('Rental only')) return null;
        if (document.querySelector('#taxGenerateBtn')) return null;
        // Scoped to the Tax home: other (hidden) views carry
        // their own Generate buttons — only #taxHome counts here.
        if ([...document.querySelector('#taxHome').querySelectorAll('button')].some((b) => /Generate/.test(b.textContent))) return null;
        if ([...body.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Open')) return null;
        return true;
      }),
      await page.evaluate(() => document.querySelector('#taxPersonBody').textContent.slice(0, 300)));
    H.check('tax UI: open project cards carry no Open element at all (no status text)',
      await until(() => {
        const cards = [...document.querySelectorAll('#taxPersonBody [data-tax-open]')];
        if (cards.length < 2) return null;
        return cards.every((c) => !/Open/.test(c.textContent) && !/Filed/.test(c.textContent)) ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxPersonBody').textContent.slice(0, 300)));
    // Filed: only a filed project carries a Filed tag — on its
    // card and in its detail header. A throwaway probe project
    // is created, filed, checked, then deleted.
    r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'Filed probe' });
    H.check('tax: filed-probe project created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
    const probeId = r.data.id;
    r = await H.req('PUT', `/api/tax/filings/${probeId}`, { status: 'filed' });
    H.check('tax: probe project marked filed', r.status === 200 && r.data.status === 'filed', JSON.stringify(r.data));
    await page.evaluate((id) => { location.hash = `#tax/filing/${id}`; }, probeId);
    H.check('tax UI: the filed detail header shows Filed',
      await until(() => {
        const el = document.querySelector('#taxDetailStatus');
        return el && el.textContent.trim() === 'Filed' ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxDetailStatus') || { textContent: 'missing' }).textContent));
    await page.evaluate(() => { location.hash = '#tax'; });
    H.check('tax UI: a filed project card shows Filed (and still no Open)',
      await until(() => {
        // No closure variables inside page.evaluate: find the
        // probe card by its heading, then check its tag span.
        const card = [...document.querySelectorAll('[data-tax-open]')]
          .find((c) => c.querySelector('h3') && c.querySelector('h3').textContent.trim() === 'Filed probe');
        if (!card) return null;
        const tag = card.querySelector('.section-head span');
        return tag && tag.textContent.trim() === 'Filed' && !/Open/.test(card.textContent) ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxPersonBody').textContent.slice(0, 300)));
    r = await H.req('DELETE', `/api/tax/filings/${probeId}`);
    H.check('tax: filed-probe project deleted', r.status === 200, JSON.stringify(r.status));
    H.check('tax UI: room line shows the recorded RRSP room ($20,000.00)',
      await until(() => {
        const el = document.querySelector('#taxRoomLine');
        return el && el.textContent.includes('20,000.00') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxRoomLine').textContent));
    H.check('tax UI: home room charts render (RRSP / TFSA / RESP / CESG, 4 doughnuts)',
      await until(() => {
        const el = document.querySelector('#taxHomeCharts');
        return el && ['RRSP', 'TFSA', 'RESP', 'CESG grant'].every((s) => el.textContent.includes(s))
          && el.querySelectorAll('canvas').length >= 4 ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxHomeCharts').textContent.slice(0, 300)));
    H.check('tax UI: home room cards sit side by side in a grid (first two share a row)',
      await until(() => {
        const grid = document.querySelector('#taxHomeCharts .tax-room-grid');
        if (!grid || grid.children.length < 4) return null;
        const a = grid.children[0].getBoundingClientRect();
        const b = grid.children[1].getBoundingClientRect();
        return Math.abs(a.top - b.top) < 4 && b.left > a.left + 50 ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxHomeCharts .tax-room-grid') || { textContent: 'missing' }).textContent.slice(0, 200)));
    // Tax home layout: Contribution room (left) and the project
    // list (right) sit side by side at desktop width, stacked on
    // a narrow viewport (room first, projects below). Viewport set
    // explicitly — the default 800px run is below the 900px stack
    // point.
    await page.setViewport({ width: 1280, height: 800 });
    H.check('tax UI: home Contribution room (left) and projects (right) sit side by side at desktop width',
      await until(() => {
        const body = document.querySelector('#taxPersonBody');
        const room = document.querySelector('#taxRoomPanel');
        if (!body || !room) return null;
        const a = body.getBoundingClientRect();
        const b = room.getBoundingClientRect();
        return Math.abs(a.top - b.top) < 4 && a.left > b.left + 100 && a.top < b.bottom ? true : null;
      }),
      await page.evaluate(() => {
        const a = document.querySelector('#taxPersonBody').getBoundingClientRect();
        const b = document.querySelector('#taxRoomPanel').getBoundingClientRect();
        return `room ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)} body ${Math.round(a.left)},${Math.round(a.top)} ${Math.round(a.width)}x${Math.round(a.height)}`;
      }));
    // Layout polish: the two columns are parallel panels whose
    // tops are equal and whose headers share one baseline
    // (h3 tops within 2px), the right heading reads "Tax profile
    // for <person> · <year>", the 2x2 room grid rows are
    // even-height, the selector row holds the person switcher
    // left and the year selector right at fitting width, and
    // each project card shows title + highlighted balance only
    // (no meta line).
    H.check('tax UI: home column panels start at the same height and their headers share one baseline ("Tax profile for Shawn · 2026")',
      await until(() => {
        const lp = document.querySelector('#taxRoomPanel');
        const rp = document.querySelector('#taxPersonPanel');
        const lh = document.querySelector('#taxRoomPanel > .section-head h3');
        const rh = document.querySelector('#taxPersonPanel > .section-head h3');
        if (!lp || !rp || !lh || !rh) return null;
        return Math.abs(lp.getBoundingClientRect().top - rp.getBoundingClientRect().top) <= 2
          && Math.abs(lh.getBoundingClientRect().top - rh.getBoundingClientRect().top) <= 2
          && rh.textContent.trim() === 'Tax profile for Shawn · 2026' ? true : null;
      }),
      await page.evaluate(() => {
        const lp = document.querySelector('#taxRoomPanel');
        const rp = document.querySelector('#taxPersonPanel');
        const lh = document.querySelector('#taxRoomPanel > .section-head h3');
        const rh = document.querySelector('#taxPersonPanel > .section-head h3');
        return `room panel top ${lp ? Math.round(lp.getBoundingClientRect().top) : '?'} person panel top ${rp ? Math.round(rp.getBoundingClientRect().top) : '?'} left h3 top ${lh ? Math.round(lh.getBoundingClientRect().top) : '?'} right h3 top ${rh ? Math.round(rh.getBoundingClientRect().top) : '?'} heading "${rh ? rh.textContent.trim() : '?'}"`;
      }));
    H.check('tax UI: home room grid rows are even-height (all four cards the same height)',
      await until(() => {
        const grid = document.querySelector('#taxHomeCharts .tax-room-grid');
        if (!grid || grid.children.length < 4) return null;
        const hs = [...grid.children].map((c) => Math.round(c.getBoundingClientRect().height));
        return Math.max(...hs) - Math.min(...hs) <= 2 ? true : null;
      }),
      await page.evaluate(() => [...document.querySelectorAll('#taxHomeCharts .tax-room-grid > *')].map((c) => Math.round(c.getBoundingClientRect().height)).join(',')));
    H.check('tax UI: selector row holds the person switcher left and the year selector right at fitting width',
      await until(() => {
        const row = document.querySelector('.tax-selector-row');
        const tabs = document.querySelector('#taxPersonTabs');
        const sel = document.querySelector('#taxYearSel');
        if (!row || !tabs || !sel) return null;
        const rr = row.getBoundingClientRect();
        const tr = tabs.getBoundingClientRect();
        const sr = sel.getBoundingClientRect();
        return Math.abs(tr.top - sr.top) <= 6 && tr.left < sr.left
          && sr.right <= rr.right + 1 && sr.width < rr.width / 2 ? true : null;
      }),
      await page.evaluate(() => {
        const row = document.querySelector('.tax-selector-row');
        const tabs = document.querySelector('#taxPersonTabs');
        const sel = document.querySelector('#taxYearSel');
        const r = (el) => { const b = el.getBoundingClientRect(); return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`; };
        return `row ${r(row)} tabs ${r(tabs)} year ${r(sel)}`;
      }));
    // Project A has items — its card shows title + the highlighted
    // balance from the list endpoint, matching the /refund figure
    // exactly (label + amount + sign class). Project B has items
    // too; the empty draft has none — its card shows the title
    // only, no figure, no meta line.
    const expectedCardFigure = Number(refundA.displayAmount).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const expectedCardClass = refundA.isRefund ? 'positive' : 'negative';
    H.check('tax UI: project card shows title + highlighted balance only, matching the refund endpoint',
      await page.evaluate((id, label, amount, cls) => {
        const card = document.querySelector(`[data-tax-open="${id}"]`);
        if (!card) return false;
        const k = card.querySelector('.k');
        const v = card.querySelector('.v');
        return !!k && !!v && k.textContent.trim() === label && v.textContent.trim() === amount
          && v.classList.contains(cls) && !/item/.test(card.textContent);
      }, projA, refundA.label, expectedCardFigure, expectedCardClass),
      await page.evaluate((id) => {
        const card = document.querySelector(`[data-tax-open="${id}"]`);
        return card ? card.textContent.replace(/\s+/g, ' ').trim() : 'no card';
      }, projA));
    H.check('tax UI: empty project card shows the title only (no balance, no meta line)',
      await page.evaluate((id) => {
        const card = document.querySelector(`[data-tax-open="${id}"]`);
        return !!card && !card.querySelector('.v') && !/item/.test(card.textContent);
      }, projEmpty),
      await page.evaluate((id) => {
        const card = document.querySelector(`[data-tax-open="${id}"]`);
        return card ? card.textContent.replace(/\s+/g, ' ').trim() : 'no card';
      }, projEmpty));
    H.check('tax UI: no stray element floats at the room panel bottom-left corner',
      await until(() => {
        const rp = document.querySelector('#taxRoomPanel');
        if (!rp) return null;
        const r = rp.getBoundingClientRect();
        const y = Math.min(r.bottom - 8, window.innerHeight - 10);
        const top = document.elementsFromPoint(r.left + 16, y)[0];
        return top && (top === rp || rp.contains(top)) ? true : null;
      }),
      await page.evaluate(() => {
        const rp = document.querySelector('#taxRoomPanel');
        const r = rp.getBoundingClientRect();
        const y = Math.min(r.bottom - 8, window.innerHeight - 10);
        const top = document.elementsFromPoint(r.left + 16, y)[0];
        return top ? `${top.tagName}#${top.id || ''}.${top.className || ''}` : 'none';
      }));
    await page.setViewport({ width: 700, height: 900 });
    H.check('tax UI: home Contribution room and projects stack vertically on a narrow viewport (room first)',
      await until(() => {
        const body = document.querySelector('#taxPersonBody');
        const room = document.querySelector('#taxRoomPanel');
        if (!body || !room) return null;
        const a = body.getBoundingClientRect();
        const b = room.getBoundingClientRect();
        return a.top >= b.bottom - 2 && Math.abs(a.left - b.left) < 4 ? true : null;
      }),
      await page.evaluate(() => {
        const a = document.querySelector('#taxPersonBody').getBoundingClientRect();
        const b = document.querySelector('#taxRoomPanel').getBoundingClientRect();
        return `room bottom ${Math.round(b.bottom)} body top ${Math.round(a.top)} lefts ${Math.round(b.left)}/${Math.round(a.left)}`;
      }));
    await page.setViewport({ width: 800, height: 600 });
    H.check('tax UI: home room charts label the through-last-year basis (Through Dec 31, 2025)',
      await until(() => {
        const el = document.querySelector('#taxHomeCharts');
        return el && el.textContent.includes('Through Dec 31, 2025') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxHomeCharts').textContent.slice(0, 200)));
    // Switch to Jiaying: no projects, no recorded room — then back.
    await page.evaluate((id) => { document.querySelector(`[data-tax-person="${id}"]`).click(); }, jiayingId);
    H.check('tax UI: switching to Jiaying shows her (empty) projects and rooms',
      await until(() => {
        const body = document.querySelector('#taxPersonBody');
        const line = document.querySelector('#taxRoomLine');
        return body && !body.querySelector('[data-tax-open]')
          && line && line.textContent.includes('No contribution room recorded.') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxPersonBody').textContent.slice(0, 200)));
    await page.evaluate((id) => { document.querySelector(`[data-tax-person="${id}"]`).click(); }, shawnId);
    await until(() => {
      const body = document.querySelector('#taxPersonBody');
      return body && body.querySelector('[data-tax-open]') ? true : null;
    });
    // The whole card opens the detail on click.
    await page.evaluate((id) => { document.querySelector(`[data-tax-open="${id}"]`).click(); }, projA);
    H.check('tax UI: clicking the project card opens the detail',
      await until(() => {
        const el = document.querySelector('#taxDetailTitle');
        return el && el.textContent.includes('Tax return 2026') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxDetailTitle').textContent));
    H.check('tax UI: detail title is name-first-then-year ("Tax return 2026 — Shawn · 2026")',
      await until(() => {
        const el = document.querySelector('#taxDetailTitle');
        return el && el.textContent.trim() === 'Tax return 2026 — Shawn · 2026' ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxDetailTitle').textContent));
    H.check('tax UI: an open project detail shows no status element (no Open, no Filed)',
      await until(() => {
        const st = document.querySelector('#taxDetailStatus');
        if (!st || st.textContent.trim() !== '') return null;
        if ([...document.querySelectorAll('#taxSections span')].some((s) => s.textContent.trim() === 'Open')) return null;
        return true;
      }),
      await page.evaluate(() => (document.querySelector('#taxDetailStatus') || { textContent: 'missing' }).textContent));
    H.check('tax UI: detail has the four sections + Review + Finish and file, a plain Back link, and a danger Delete',
      await until(() => {
        const el = document.querySelector('#taxSections');
        if (!el || !['Income', 'Registered savings plans', 'Deductions', 'Provincial', 'Review', 'Finish and file'].every((s) => el.textContent.includes(s))) return null;
        const back = document.querySelector('#taxBackLink');
        if (!back || back.tagName !== 'A' || back.getAttribute('href') !== '#tax') return null;
        const del = document.querySelector('#taxDeleteBtn');
        if (!del || !del.classList.contains('danger')) return null;
        if (document.querySelector('#taxGenerateBtn')) return null;
        if ([...document.querySelectorAll('#taxDetail button')].some((b) => /Generate/.test(b.textContent))) return null;
        return true;
      }),
      await page.evaluate(() => document.querySelector('#taxSections').textContent.slice(0, 300)));
    H.check('tax UI: detail charts render in the Tax Profile block',
      await until(() => {
        const el = document.querySelector('#taxDetailCharts');
        return el && ['RRSP', 'TFSA', 'RESP', 'CESG grant'].every((s) => el.textContent.includes(s))
          && el.querySelectorAll('canvas').length >= 4 ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxDetailCharts').textContent.slice(0, 300)));
    // Refund headline on the 2025 filing: the figure, then the popup.
    await page.evaluate((id) => { location.hash = `#tax/filing/${id}`; }, proj2025);
    H.check('tax UI: the 2025 refund headline shows $16,615.42 as a Refund',
      await until(() => {
        const el = document.querySelector('#taxRefundCard');
        return el && el.textContent.includes('16,615.42') && el.textContent.includes('Refund') ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxRefundCard') || { textContent: 'missing' }).textContent));
    await page.evaluate(() => { document.querySelector('#taxRefundCard').click(); });
    H.check('tax UI: clicking the headline opens the line-by-line T1 popup (line 48400, $16,615.42)',
      await until(() => {
        const el = document.querySelector('#taxModalBody');
        return el && el.textContent.includes('48400') && el.textContent.includes('16,615.42') ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxModalBody') || { textContent: 'missing' }).textContent.slice(0, 400)));
    await page.evaluate(() => { document.querySelector('#taxModal [data-close-modal]').click(); });
    // RRSP contribution tool: the button opens the modal with the
    // slider, the highlighted tax-saved figure and the doughnut.
    await page.evaluate((id) => { location.hash = `#tax/filing/${id}`; }, projA);
    await until(() => document.querySelector('[data-tax-rrsp-tool]') ? true : null);
    await page.evaluate(() => { document.querySelector('[data-tax-rrsp-tool]').click(); });
    H.check('tax UI: RRSP tool opens with slider + highlighted tax-saved figure + doughnut',
      await until(() => {
        const s = document.querySelector('#taxRrspSlider');
        const res = document.querySelector('#taxRrspResult');
        const chart = document.querySelector('#taxRrspEstimatorChart');
        return s && res && res.textContent.includes('Estimated tax saved')
          && chart && chart.querySelector('canvas') ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxRrspResult') || { textContent: 'missing' }).textContent));
    const savedBefore = await page.evaluate(() => (document.querySelector('#taxRrspResult .v') || { textContent: '' }).textContent);
    await page.evaluate((v) => { window.__savedBefore = v; }, savedBefore);
    await page.evaluate(() => {
      const s = document.querySelector('#taxRrspSlider');
      s.value = '5000';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    H.check('tax UI: moving the slider updates the amount ($5,000) and the tax-saved figure live',
      await until(() => {
        const amt = document.querySelector('#taxRrspAmount');
        const res = document.querySelector('#taxRrspResult .v');
        return amt && amt.value === '5,000' && res && res.textContent !== '' && res.textContent !== window.__savedBefore ? true : null;
      }),
      await page.evaluate(() => `${document.querySelector('#taxRrspAmount').value} / ${(document.querySelector('#taxRrspResult .v') || {}).textContent}`));
    await page.evaluate(() => { document.querySelector('#taxModal [data-close-modal]').click(); });
    // Fill with AI in the Add item modal: stubbed extraction
    // previews, Apply fills the form, Save adds the item.
    await page.evaluate(() => { document.querySelector('[data-tax-add-item="income"]').click(); });
    await until(() => document.querySelector('#taxAddAiBtn') ? true : null);
    await page.evaluate(() => { document.querySelector('#taxAddAiBtn').click(); });
    await until(() => document.querySelector('#taxAiItemExtract') ? true : null);
    fs.writeFileSync(H.aiStubFile, JSON.stringify({ kind: 'other_income', label: 'AI test income', amount: 777.77 }));
    await page.evaluate(() => {
      document.querySelector('#taxAiItemText').value = 'Other income $777.77 for 2026';
      document.querySelector('#taxAiItemExtract').click();
    });
    H.check('tax UI: Fill with AI previews the stubbed extraction and Apply fills the form',
      await until(() => {
        const msg = document.querySelector('#taxAddAiMsg');
        const form = document.querySelector('#taxAddManualForm');
        if (!msg || !msg.textContent.includes('Extracted — review the fields, then Save.')) return null;
        if (!form) return null;
        const amt = form.querySelector('input[name="amount"]');
        const label = form.querySelector('input[name="label"]');
        return amt && amt.value === '777.77' && label && label.value === 'AI test income' ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxAddAiMsg') || { textContent: 'missing' }).textContent));
    await page.evaluate(() => { document.querySelector('#taxAddManualForm button[type="submit"]').click(); });
    H.check('tax UI: saving the AI-filled item adds it to Income',
      await until(() => {
        const el = document.querySelector('#taxSections');
        return el && el.textContent.includes('AI test income') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxSections').textContent.slice(0, 400)));
    // The in-project Tax Profile follows the person's CURRENT
    // profile record — one source of truth, no per-project copy.
    // Editing it from inside the detail updates the in-project
    // block (rooms + charts) with no navigation.
    await until(() => document.querySelector('#taxDetailProfileEditBtn') ? true : null);
    await page.evaluate(() => { document.querySelector('#taxDetailProfileEditBtn').click(); });
    H.check('tax UI: profile Edit inside the detail opens with the saved rooms ($20,000 RRSP)',
      await until(() => {
        const f = document.querySelector('#taxProfileForm');
        return f && f.querySelector('input[name="rrsp_room"]').value === '20,000' ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxProfileForm') || { textContent: 'missing' }).textContent.slice(0, 200)));
    await page.evaluate(() => {
      const f = document.querySelector('#taxProfileForm');
      f.querySelector('input[name="rrsp_room"]').value = '21,000';
      f.querySelector('button[type="submit"]').click();
    });
    H.check('tax UI: saving the profile inside the detail updates the in-project Tax Profile block ($21,000.00)',
      await until(() => {
        const body = document.querySelector('#taxDetailProfileBody');
        const detail = document.querySelector('#taxDetail');
        return body && body.textContent.includes('21,000.00') && detail && !detail.classList.contains('hidden') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxDetailProfileBody').textContent));
    // Restore the $20,000 room via API so the later home pin
    // reads it back; the detail re-render is not needed for that.
    await H.req('PUT', `/api/tax/profiles/${shawnId}`, {
      rrsp_room: 20000, tfsa_room: 5000, resp_beneficiary: 'Baby', resp_subscriber: 'Shawn',
      resp_room: 45000, cesg_room: 7000, as_of_date: '2026-10-31',
    });
    // Profile Edit from home saves a room change and stays on home.
    await page.evaluate(() => { location.hash = '#tax'; });
    await until(() => document.querySelector('#taxRoomEditBtn') ? true : null);
    await page.evaluate(() => { document.querySelector('#taxRoomEditBtn').click(); });
    H.check('tax UI: profile Edit opens with the saved rooms ($20,000 RRSP)',
      await until(() => {
        const f = document.querySelector('#taxProfileForm');
        return f && f.querySelector('input[name="rrsp_room"]').value === '20,000' ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxProfileForm') || { textContent: 'missing' }).textContent.slice(0, 200)));
    await page.evaluate(() => {
      const f = document.querySelector('#taxProfileForm');
      f.querySelector('input[name="rrsp_room"]').value = '21,000';
      f.querySelector('button[type="submit"]').click();
    });
    H.check('tax UI: saving the profile updates the room line ($21,000.00) and stays on Tax home',
      await until(() => {
        const line = document.querySelector('#taxRoomLine');
        const home = document.querySelector('#taxHome');
        return line && line.textContent.includes('21,000.00') && home && !home.classList.contains('hidden') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxRoomLine').textContent));
  } finally {
    await browser.close();
  }
}
runModuleMain(import.meta.url, { name: 'tax', deps, depNames: [], run });
