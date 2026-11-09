// Tax module: the region interface (CA slips, slip → item
// mapping, expected-items derivation), the RRSP contribution
// window, the T776 form math, the split math, the per-item
// share, plan annual contributions, the guided-return sections,
// and the T1 computation behind the refund headline + popup
// (federal + BC modules, pinned against the user's 2025 return).
// Nothing generates automatically — the derivation is a
// CANDIDATE list for the Add picker, never an auto-apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getRegion } from '../src/regions/index.js';
import * as caTax from '../src/regions/ca/tax.js';
import { payroll, rental } from '../src/regions/ca.js';
import { federalTable } from '../src/regions/ca/federal.js';
import { bcTable } from '../src/regions/ca/bc.js';
import { computeT1, countedItems } from '../src/regions/ca/t1.js';
import { listCommits } from '../src/history.js';
import {
  TAX_ITEM_KINDS, TAX_ITEM_STATUSES, TAX_SECTIONS, sectionForKind, sectionSummary,
  RESP_LIFETIME_LIMIT, CESG_LIFETIME_MAX, respRoomSplit, cesgRoomSplit,
  tfsaNetContributed, rrspContributed, rrspBenefit,
  taxRoomCutoff, throughDate,
  effectiveAmount, filingTotals, rentalDeductible, rentalNet,
  validSharePct, validTaxItemInput, validTaxSlipInput, validTaxProfileInput,
  buildExpectedContext, planOwnAnnual,
  normalizeSourceName, itemSourceName, findSlipLinkMatches,
} from '../src/tax.js';

const jobRow = (over = {}) => ({
  id: 1, tax_year: 2026, employer: 'Meta', owner: 'Shawn', currency: 'CAD',
  frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period',
  province: 'BC', ytd_cpp: 0, ytd_cpp2: 0, ytd_ei: 0,
  cpp_exempt: false, ei_exempt: false, td1_federal: null, td1_provincial: null,
  bonus_total: 0, ...over,
});

// ------------------------------------------------------- region interface --
test('region registry: CA exposes a tax surface; unknown regions return null', () => {
  const ca = getRegion('ca');
  assert.ok(ca);
  assert.equal(ca.tax.code, 'CA');
  assert.equal(ca.tax.label, 'Canada');
  assert.equal(getRegion('US'), null);
  assert.equal(getRegion('xx'), null);
});

test('CA slip kinds: the seven slips, each with box fields — T4A, never T5A', () => {
  const kinds = caTax.slipKinds.map((s) => s.kind);
  assert.deepEqual(kinds, ['T4', 'T4A', 'T5', 'T3', 'T4RSP', 'T4RIF', 'T5008']);
  assert.ok(kinds.includes('T4A'), 'T4A (pension/retirement/other income) is covered');
  assert.ok(!kinds.includes('T5A'), 'there is no T5A slip in CRA\'s set — never invent one');
  for (const s of caTax.slipKinds) {
    assert.ok(s.label && s.form);
    assert.ok(Array.isArray(s.fields) && s.fields.length > 0);
    for (const f of s.fields) assert.ok(f.key && f.label);
  }
  assert.equal(caTax.slipKindDef('T4').fields.find((f) => f.key === 'box14').money, true);
  assert.equal(caTax.slipKindDef('NOPE'), null);
});

test('slipToItemKind: every slip maps to an item kind; unknown maps to null', () => {
  assert.deepEqual({
    T4: caTax.slipToItemKind('T4'), T4A: caTax.slipToItemKind('T4A'),
    T5: caTax.slipToItemKind('T5'), T3: caTax.slipToItemKind('T3'),
    T4RSP: caTax.slipToItemKind('T4RSP'), T4RIF: caTax.slipToItemKind('T4RIF'),
    T5008: caTax.slipToItemKind('T5008'), NOPE: caTax.slipToItemKind('NOPE'),
  }, {
    T4: 'employment', T4A: 'other_income', T5: 'investment_income',
    T3: 'investment_income', T4RSP: 'other_income', T4RIF: 'other_income',
    T5008: 'capital_gain', NOPE: null,
  });
});

test('slipAmount: only the income boxes count — tax deducted and cost base never do', () => {
  assert.equal(caTax.slipAmount('T4', { box14: 190704.02, box22: 40000, box16: 4230.45 }), 190704.02);
  assert.equal(caTax.slipAmount('T5', { box11: 100.5, box13: 25.25, box25: 10 }), 125.75);
  assert.equal(caTax.slipAmount('T3', { box21: 500, box23: 40, box26: 10, box30: 5 }), 550);
  assert.equal(caTax.slipAmount('T5008', { box20: 1505, box21: 1200 }), 1505);
  assert.equal(caTax.slipAmount('T4A', { box016: 0, box020: 0 }), 0);
  assert.equal(caTax.slipAmount('T4', {}), null);
  assert.equal(caTax.slipAmount('T4', { box22: 40000 }), null);
  assert.equal(caTax.slipAmount('NOPE', { box14: 1 }), null);
});

test('slipPayerName: the name field per kind — employer_name on a T4, payer_name elsewhere; blank is null', () => {
  assert.equal(caTax.slipPayerName('T4', { employer_name: 'Tax Meta', box14: 1 }), 'Tax Meta');
  assert.equal(caTax.slipPayerName('T5', { payer_name: 'Big Bank', box13: 5 }), 'Big Bank');
  assert.equal(caTax.slipPayerName('T4A', { payer_name: 'Pension Co' }), 'Pension Co');
  assert.equal(caTax.slipPayerName('T4', { box14: 1 }), null);
  assert.equal(caTax.slipPayerName('T4', { employer_name: '  ' }), null);
  assert.equal(caTax.slipPayerName('NOPE', { payer_name: 'X' }), null);
});

// -------------------------------------------- slip → item linking --
// The matching rule (user 2026-11-08; the slip governs, 19:28):
// kind + source name only — the amount is NOT part of the
// identity, so a candidate whose amount differs from the slip
// still matches and the link updates it to the slip's figures.
test('findSlipLinkMatches: kind + source name, case/whitespace-insensitive; the amount is not the identity', () => {
  const jobItem = { id: 1, kind: 'employment', amount: 190704.02, status: 'linked', slip_id: null, detail: { employer: 'Tax Meta', taxYear: 2026 } };
  assert.deepEqual(findSlipLinkMatches([jobItem], 'employment', 'Tax Meta').map((i) => i.id), [1]);
  assert.deepEqual(findSlipLinkMatches([jobItem], 'employment', '  tax   META ').map((i) => i.id), [1]);
  // The candidate's amount differs from the slip's by rounding —
  // it still matches; the T4 governs the figure on link.
  const rounded = { ...jobItem, amount: 190704.00 };
  assert.deepEqual(findSlipLinkMatches([rounded], 'employment', 'Tax Meta').map((i) => i.id), [1]);
  // A bigger disagreement is still a match: the app's record of
  // the source may differ from the slip, and the slip wins.
  const off = { ...jobItem, amount: 50000.60 };
  assert.deepEqual(findSlipLinkMatches([off], 'employment', 'Tax Meta').map((i) => i.id), [1]);
  assert.equal(normalizeSourceName('  Tax   Meta '), 'tax meta');
  assert.equal(normalizeSourceName(''), null);
  assert.equal(normalizeSourceName(null), null);
  assert.equal(itemSourceName(jobItem), 'Tax Meta');
  assert.equal(itemSourceName({ detail: { payer: 'Big Bank' } }), 'Big Bank');
  assert.equal(itemSourceName({ detail: {} }), null);
  assert.equal(itemSourceName({ detail: '{"employer":"Tax Meta"}' }), 'Tax Meta');
});

test('findSlipLinkMatches: no name, wrong kind, slip-backed, derived and excluded items never match', () => {
  const base = { kind: 'employment', amount: 100, status: 'linked', slip_id: null, detail: { employer: 'Tax Meta' } };
  assert.deepEqual(findSlipLinkMatches([base], 'employment', null), []);
  assert.deepEqual(findSlipLinkMatches([base], 'employment', ''), []);
  assert.deepEqual(findSlipLinkMatches([base], 'investment_income', 'Tax Meta'), []);
  assert.deepEqual(findSlipLinkMatches([{ ...base, slip_id: 9 }], 'employment', 'Tax Meta'), []);
  assert.deepEqual(findSlipLinkMatches([{ ...base, status: 'excluded' }], 'employment', 'Tax Meta'), []);
  assert.deepEqual(findSlipLinkMatches([{ ...base, detail: { employer: 'Tax Meta', derived: true } }], 'employment', 'Tax Meta'), []);
  // A T5 never matches a dividend candidate: the candidate
  // carries a holding/account, not the slip's payer name.
  const div = { id: 7, kind: 'investment_income', amount: 123.45, status: 'linked', slip_id: null, detail: { holding: 'SHOP', account: 'Tax Margin' } };
  assert.deepEqual(findSlipLinkMatches([div], 'investment_income', 'SHOP'), []);
  assert.deepEqual(findSlipLinkMatches([div], 'investment_income', 'Tax Margin'), []);
  // Two items for the same employer both match — the server
  // answers 409 and the UI asks; it never guesses.
  const two = [
    { id: 1, ...base },
    { id: 2, ...base, amount: 26000 },
  ];
  assert.deepEqual(findSlipLinkMatches(two, 'employment', 'Tax Meta').map((i) => i.id), [1, 2]);
});

// --------------------------------------------------------- expected items --
// The derivation is the Add picker's CANDIDATE list (jobs,
// rentals, RRSP plans, dividends, sells that exist in the app).
// Candidates are shown for the user to choose, never auto-applied.
test('expectedItems: a job with an owner links; without one it is UNLINKED; zero gross is skipped', () => {
  const items = caTax.expectedItems({
    taxYear: 2026,
    jobs: [
      { id: 1, employer: 'Meta', owner: 'Shawn', annualGross: 190704.02, currency: 'CAD' },
      { id: 2, employer: 'Side gig', owner: null, annualGross: 5000, currency: 'CAD' },
      { id: 3, employer: 'Zero', owner: 'Shawn', annualGross: 0, currency: 'CAD' },
    ],
    rentals: [], plans: [], dividends: [], sells: [],
  });
  assert.equal(items.length, 2);
  const [meta, gig] = items;
  assert.equal(meta.kind, 'employment');
  assert.equal(meta.personKey, 'Shawn');
  assert.equal(meta.amount, 190704.02);
  assert.equal(meta.sourceType, 'job');
  assert.equal(meta.sourceId, 1);
  assert.equal(gig.personKey, null);
  assert.equal(gig.sharePct, 100);
});

test('expectedItems: a rental splits equally per owner; the last owner absorbs rounding', () => {
  const two = caTax.expectedItems({
    taxYear: 2026, jobs: [], plans: [], dividends: [], sells: [],
    rentals: [{ id: 5, label: '2985 Basement', gross: 22800, deductible: 18903.37, net: 3896.63, ownerUsernames: ['Shawn', 'Jiaying'] }],
  });
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((i) => [i.personKey, i.sharePct, i.amount]), [
    ['Shawn', 50, 3896.63], ['Jiaying', 50, 3896.63],
  ]);
  assert.equal(two[0].detail.gross, 22800);
  assert.equal(two[0].detail.deductible, 18903.37);
  // No T776 line set on the raw input: the gross is the gross
  // rents, there is no other income, and lines/expenseRows stay null.
  assert.equal(two[0].detail.grossRents, 22800);
  assert.equal(two[0].detail.otherIncome, 0);
  assert.equal(two[0].detail.lines, null);
  assert.equal(two[0].detail.expenseRows, null);

  const three = caTax.expectedItems({
    taxYear: 2026, jobs: [], plans: [], dividends: [], sells: [],
    rentals: [{ id: 6, label: 'Shared', gross: 12000, deductible: 0, net: 12000, ownerUsernames: ['A', 'B', 'C'] }],
  });
  assert.deepEqual(three.map((i) => i.sharePct), [33.33, 33.33, 33.34]);
  assert.equal(three.reduce((s, i) => s + i.sharePct, 0), 100);

  const none = caTax.expectedItems({
    taxYear: 2026, jobs: [], plans: [], dividends: [], sells: [],
    rentals: [{ id: 7, label: 'Orphan', gross: 1000, deductible: 0, net: 1000, ownerUsernames: [] }],
  });
  assert.equal(none.length, 1);
  assert.equal(none[0].personKey, null);
  assert.equal(none[0].sharePct, 100);
});

test('expectedItems: RRSP plans link to the job owner; dividends and sells split per account owner', () => {
  const items = caTax.expectedItems({
    taxYear: 2026, jobs: [], rentals: [],
    plans: [
      { id: 7, label: 'Manulife RRSP — ML Mercer 2030', owner: 'Shawn', ownAnnual: 880.2, basis: 'projected', currency: 'CAD' },
      { id: 8, label: 'No owner plan', owner: null, ownAnnual: 100, basis: 'actual', currency: 'CAD' },
      { id: 9, label: 'Zero plan', owner: 'Shawn', ownAnnual: 0, basis: 'actual', currency: 'CAD' },
    ],
    dividends: [{ id: 11, holdingLabel: 'XQQ.TO', accountName: 'WealthSimple', amount: 123.45, currency: 'CAD', ownerUsernames: ['Shawn', 'Jiaying'] }],
    sells: [{ id: 12, holdingLabel: 'SHOP.TO', accountName: 'WealthSimple', proceeds: 1505, units: 10, price: 150.5, currency: 'CAD', ownerUsernames: ['Shawn'] }],
  });
  const rrsp = items.filter((i) => i.kind === 'rrsp');
  assert.equal(rrsp.length, 2);
  assert.equal(rrsp[0].personKey, 'Shawn');
  assert.equal(rrsp[0].amount, 880.2);
  assert.equal(rrsp[1].personKey, null);
  const div = items.filter((i) => i.kind === 'investment_income');
  assert.deepEqual(div.map((i) => [i.personKey, i.sharePct]), [['Shawn', 50], ['Jiaying', 50]]);
  const sell = items.filter((i) => i.kind === 'capital_gain');
  assert.equal(sell.length, 1);
  assert.equal(sell[0].amount, 1505);
  assert.match(sell[0].detail.note, /cost base/);
});

// ------------------------------------------------------ context derivation --
test('buildExpectedContext: job annual gross, rental split + T776 lines, RRSP-only plans, NonRegistered-only events', () => {
  const ctx = buildExpectedContext({
    taxYear: 2026,
    jobRows: [jobRow(), jobRow({ id: 2, employer: 'Other year', tax_year: 2025, owner: 'Jiaying' })],
    rentalRows: [{
      id: 5, label: '2985 Basement', propertyOwners: '["Shawn","Jiaying"]',
      years: [{ tax_year: 2026, calc: {
        grossWhole: 22800, otherIncome: 200, deductibleExpenses: 18903.37, netWhole9946: 3896.63,
        expensesByLine: { 8710: 12000, 8521: 6903.37 },
        expenseTable: { rows: [{ label: 'Mortgage interest', total: 12000, pct: 100, deductible: 12000 }] },
      } }],
    }],
    planRows: [
      { id: 7, accountType: 'RRSP', accountName: 'Manulife RRSP', holdingLabel: 'ML Mercer 2030', jobOwner: 'Shawn', currency: 'CAD', taxYear: 2026, own_amount: 220.05, employer_amount: 220.05, jobFrequency: 'biweekly', job: { frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period' }, start_date: '2026-11-06', events: [] },
      { id: 8, accountType: 'TFSA', accountName: 'WealthSimple TFSA', holdingLabel: 'XQQ.TO', jobOwner: 'Shawn', currency: 'CAD', taxYear: 2026, own_amount: 500, employer_amount: null, jobFrequency: 'biweekly', job: { frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period' }, start_date: '2026-01-01', events: [] },
    ],
    dividendRows: [
      { id: 11, holdingLabel: 'XQQ.TO', accountName: 'WealthSimple', amount: 123.45, currency: 'CAD', accountType: 'NonRegistered', accountOwners: '["Shawn"]' },
      { id: 12, holdingLabel: 'TFSA div', accountName: 'TFSA', amount: 999, currency: 'CAD', accountType: 'TFSA', accountOwners: '["Shawn"]' },
    ],
    sellRows: [
      { id: 13, holdingLabel: 'SHOP.TO', accountName: 'WealthSimple', units: 10, price: 150.5, currency: 'CAD', accountType: 'NonRegistered', accountOwners: '["Shawn","Jiaying"]' },
      { id: 14, holdingLabel: 'RRSP sell', accountName: 'RRSP', units: 5, price: 100, currency: 'CAD', accountType: 'RRSP', accountOwners: '["Shawn"]' },
    ],
    payroll,
    rrspWindow: caTax.rrspWindow(2026),
    t776Lines: rental.t776Lines,
  });
  assert.equal(ctx.jobs.length, 1); // the 2025 job is another year's
  assert.equal(ctx.jobs[0].annualGross, 190704.02);
  assert.equal(ctx.rentals.length, 1);
  assert.equal(ctx.rentals[0].net, 3896.63);
  assert.equal(ctx.rentals[0].grossRents, 22600); // 22800 gross − 200 other income
  assert.equal(ctx.rentals[0].otherIncome, 200);
  assert.equal(ctx.rentals[0].lines.find((l) => l.line === '8710').amount, 12000);
  assert.equal(ctx.rentals[0].lines.find((l) => l.line === '8521').amount, 6903.37);
  assert.equal(ctx.rentals[0].expenseRows.length, 1);
  assert.equal(ctx.plans.length, 1); // TFSA plan is not a deduction
  // The RRSP window (Mar 1, 2026 – Mar 1, 2027), not the calendar
  // year: a Nov 6 start has 9 due dates in the window (Nov 6 →
  // Feb 26) × $220.05, projected.
  assert.equal(ctx.plans[0].ownAnnual, 1980.45);
  assert.equal(ctx.plans[0].basis, 'projected');
  assert.equal(ctx.dividends.length, 1); // TFSA dividend is not taxed in-year
  assert.equal(ctx.sells.length, 1); // RRSP sell is not a capital gain
  assert.equal(ctx.sells[0].proceeds, 1505);

  const items = caTax.expectedItems(ctx);
  assert.equal(items.filter((i) => i.kind === 'employment').length, 1);
  assert.equal(items.filter((i) => i.kind === 'rental').length, 2);
  assert.equal(items.find((i) => i.kind === 'rental').detail.grossRents, 22600);
  assert.equal(items.filter((i) => i.kind === 'rrsp').length, 1);
  assert.equal(items.find((i) => i.kind === 'rrsp').amount, 1980.45);
  assert.equal(items.filter((i) => i.kind === 'investment_income').length, 1);
  assert.equal(items.filter((i) => i.kind === 'capital_gain').length, 2);
});

// ---------------------------------------------------------- RRSP window --
// The CRA first-60-days rule (verified 2026-11-08): for a tax
// year, eligible contributions run March 1 of that year through
// the 60th day of the next year — March 1 in a common year,
// February 29 in a leap year, extended to Monday when the 60th
// day falls on a weekend (2025's deadline was Monday, March 2,
// 2026, because March 1 was a Sunday).
test('rrspWindow: Mar 1 of the tax year through the first 60 days of the next year', () => {
  assert.deepEqual(
    (({ start, end }) => ({ start, end }))(caTax.rrspWindow(2025)),
    { start: '2025-03-01', end: '2026-03-02' });
  assert.match(caTax.rrspWindow(2025).label, /Mar 1, 2025.*Mar 2, 2026/);
  assert.deepEqual(
    (({ start, end }) => ({ start, end }))(caTax.rrspWindow(2026)),
    { start: '2026-03-01', end: '2027-03-01' });
  assert.match(caTax.rrspWindow(2026).label, /Mar 1, 2026.*Mar 1, 2027/);
  assert.deepEqual(
    (({ start, end }) => ({ start, end }))(caTax.rrspWindow(2027)),
    { start: '2027-03-01', end: '2028-02-29' }); // 2028 is a leap year
  assert.match(caTax.rrspWindow(2027).label, /Mar 1, 2027.*Feb 29, 2028/);
});

// --------------------------------------------------------------- T776 --
// Rental income is reported on CRA Form T776 (Statement of Real
// Estate Rentals): gross rents line 8141, other income 8230,
// total gross 8299, net 9946 (gross − expenses).
test('t776Totals / validT776Lines: gross, expenses and net from the form lines', () => {
  const lines = { gross_rents: 22800, other_income: 200, 8710: 12000, 8521: 6903.37 };
  assert.deepEqual(caTax.t776Totals(lines), { gross: 23000, expenses: 18903.37, net: 4096.63 });
  assert.deepEqual(caTax.t776Totals({}), { gross: 0, expenses: 0, net: 0 });
  assert.equal(caTax.validT776Lines(lines, rental.t776Lines), null);
  assert.equal(caTax.validT776Lines({ gross_rents: 1 }, rental.t776Lines), null);
  assert.match(caTax.validT776Lines({ gross_rents: 1, 9999: 5 }, rental.t776Lines), /unknown T776 line "9999"/);
  assert.match(caTax.validT776Lines({ gross_rents: -1 }, rental.t776Lines), /must not be negative/);
  assert.match(caTax.validT776Lines({ gross_rents: 'abc' }, rental.t776Lines), /must be a number/);
  assert.match(caTax.validT776Lines(null, rental.t776Lines), /must be an object/);
  assert.match(caTax.validT776Lines([], rental.t776Lines), /must be an object/);
  // The form definition carries the income lines and the
  // region's expense lines by T776 line number.
  const def = caTax.t776FormDef(rental.t776Lines);
  assert.equal(def.form, 'T776');
  assert.deepEqual(def.income.map((l) => l.line), ['8141', '8230']);
  assert.equal(def.expenses.find((l) => l.line === '8710').label, 'Line 8710 — Interest and bank charges');
  assert.equal(def.netLine.line, '9946');
});

test('rentalDeductible / rentalNet: stored deductible + net win; otherwise the T776 lines', () => {
  assert.equal(rentalDeductible({ detail: { deductible: 18903.37, net: 3896.63 } }), 18903.37);
  assert.equal(rentalNet({ detail: { deductible: 18903.37, net: 3896.63 } }), 3896.63);
  const fromLines = { detail: { gross: 22800, lines: { gross_rents: 22800, 8710: 12000, 8521: 6903.37 } } };
  assert.equal(rentalDeductible(fromLines), 18903.37); // income lines never count as expenses
  assert.equal(rentalNet(fromLines), 3896.63); // gross − deductible
  assert.equal(rentalDeductible({}), 0);
  assert.equal(rentalNet({}), 0);
  assert.equal(rentalDeductible(null), 0);
});

// ---------------------------------------------------------- plan own annual --
// The year is the RRSP contribution WINDOW, not the calendar
// year: with no window the calendar year is used (the old
// behaviour, kept for callers without a region).
test('planOwnAnnual: generated buys are the ground truth (actual); otherwise due periods × per-period own (projected)', () => {
  const window = caTax.rrspWindow(2026);
  const base = {
    taxYear: 2026, own_amount: 100, employer_amount: 100,
    jobFrequency: 'biweekly', job: { frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period' },
    start_date: '2026-01-01', events: [], deletedDueDates: [],
  };
  const actual = planOwnAnnual({
    ...base,
    events: [
      { type: 'buy', date: '2026-03-15', own_amount: 220.05 },
      { type: 'buy', date: '2026-03-29', own_amount: 220.05 },
      { type: 'buy', date: '2025-12-31', own_amount: 999 },
      { type: 'sell', date: '2026-04-01', own_amount: 500 },
    ],
  }, window);
  assert.equal(actual, 440.1);
  const planA = { ...base, events: [{ type: 'buy', date: '2026-03-15', own_amount: 220.05 }] };
  planOwnAnnual(planA, window);
  assert.equal(planA._basis, 'actual');

  // 26 bi-weekly due dates inside the window (Mar 12, 2026 →
  // Feb 25, 2027) × $100 — the calendar year has 27.
  const projected = planOwnAnnual({ ...base }, window);
  assert.equal(projected, 2600);
  assert.equal(planOwnAnnual({ ...base }), 2700);
  const planP = { ...base };
  planOwnAnnual(planP, window);
  assert.equal(planP._basis, 'projected');

  // A plan starting in 2027 has no due dates in calendar 2026,
  // but 5 inside the window (Jan 1 → Feb 26, 2027).
  assert.equal(planOwnAnnual({ ...base, start_date: '2027-01-01' }), 0);
  assert.equal(planOwnAnnual({ ...base, start_date: '2027-01-01' }, window), 500);
  assert.equal(planOwnAnnual({ ...base, own_amount: 0 }, window), 0);
});

test('planOwnAnnual: percent plans derive from the current per-period gross', () => {
  const window = caTax.rrspWindow(2026);
  const plan = {
    taxYear: 2026, own_pct: 3, employer_pct: 3,
    jobFrequency: 'biweekly', job: { frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period' },
    start_date: '2026-01-01', events: [], deletedDueDates: [],
  };
  // 3% × 7334.77 = 220.04 per period × 26 window due dates
  // (27 in the calendar year).
  assert.equal(planOwnAnnual(plan, window), 5721.04);
  assert.equal(planOwnAnnual(plan), 5941.08);
  assert.equal(plan._basis, 'projected');
});

// ------------------------------------------------------------- share math --
test('effectiveAmount and filingTotals: share × amount, excluded items never count — and neither do RESP or derived rows', () => {
  assert.equal(effectiveAmount({ amount: 2000, share_pct: 50 }), 1000);
  assert.equal(effectiveAmount({ amount: 100, share_pct: 33.33 }), 33.33);
  assert.equal(effectiveAmount({ amount: 100, share_pct: null }), 100);
  const totals = filingTotals([
    { kind: 'employment', amount: 190704.02, share_pct: 100, status: 'confirmed' },
    { kind: 'rental', amount: 3896.63, share_pct: 50, status: 'linked' },
    { kind: 'rrsp', amount: 880.2, share_pct: 100, status: 'excluded' },
    // RESP is tracked, never deductible: $0 in every total.
    { kind: 'resp', amount: 5000, share_pct: 100, status: 'linked' },
    // A derived rental-deduction row displays numbers already
    // netted in its rental item: $0 in every total.
    { kind: 'deduction', amount: 18903.37, share_pct: 50, status: 'linked', detail: { derived: true } },
  ]);
  assert.equal(totals.byKind.employment, 190704.02);
  assert.equal(totals.byKind.rental, 1948.32);
  assert.equal(totals.byKind.rrsp, undefined);
  assert.equal(totals.byKind.resp, undefined);
  assert.equal(totals.byKind.deduction, undefined);
  assert.equal(totals.total, 192652.34);
});

test('validSharePct and validTaxItemInput — incl. the manual-only kinds', () => {
  assert.equal(validSharePct(100), true);
  assert.equal(validSharePct(0.01), true);
  assert.equal(validSharePct(0), false);
  assert.equal(validSharePct(100.01), false);
  assert.equal(validSharePct('x'), false);
  assert.equal(validTaxItemInput({ kind: 'employment', label: 'Meta', amount: 1 }), null);
  for (const kind of ['resp', 'prpp', 'rpp', 'hbp', 'disability', 'student']) {
    assert.equal(validTaxItemInput({ kind, label: 'Manual', amount: 1 }), null, `${kind} must be a valid item kind`);
  }
  assert.match(validTaxItemInput({ kind: 'nope', label: 'x', amount: 1 }), /kind/);
  assert.match(validTaxItemInput({ kind: 'employment', label: ' ', amount: 1 }), /label/);
  assert.match(validTaxItemInput({ kind: 'employment', label: 'x', amount: 'a' }), /amount/);
  assert.match(validTaxItemInput({ kind: 'employment', label: 'x', amount: 1, share_pct: 0 }), /share/);
  assert.match(validTaxItemInput({ kind: 'employment', label: 'x', amount: 1, share_pct: 101 }), /share/);
});

test('validTaxSlipInput: unknown kind, unknown box, bad year', () => {
  const good = { kind: 'T4', tax_year: 2026, fields: { box14: 100, employer_name: 'Meta' } };
  assert.equal(validTaxSlipInput(good, caTax), null);
  assert.match(validTaxSlipInput({ ...good, kind: 'T9' }, caTax), /kind/);
  assert.match(validTaxSlipInput({ ...good, fields: { box99: 1 } }, caTax), /unknown field/);
  assert.match(validTaxSlipInput({ ...good, tax_year: 1999 }, caTax), /tax_year/);
  assert.match(validTaxSlipInput({ ...good, fields: [] }, caTax), /fields/);
});

// ------------------------------------------------- sections / credits --
// The guided-return checklist (TurboTax-style, user 2026-11-08
// 16:19 — supersedes the Income / Deductions / Credits split):
// Income, Registered savings plans, Deductions, Provincial, then
// Review (a summary, not a kind bucket) and Finish and file.
// 'credit' is a first-class item kind and renders under
// Provincial (BC) — there is no federal-credits section. The
// disability amount is technically a non-refundable credit; it
// sits under Deductions because the user placed it there.
test("'credit' is a valid item kind; sectionSummary counts expected/linked/confirmed/excluded per section", () => {
  assert.ok(TAX_ITEM_KINDS.includes('credit'));
  assert.equal(validTaxItemInput({ kind: 'credit', label: 'Canada workers benefit', amount: 100 }), null);
  assert.equal(sectionForKind('employment'), 'income');
  assert.equal(sectionForKind('rental'), 'income');
  assert.equal(sectionForKind('investment_income'), 'income');
  assert.equal(sectionForKind('capital_gain'), 'income');
  assert.equal(sectionForKind('other_income'), 'income');
  assert.equal(sectionForKind('rrsp'), 'registered');
  assert.equal(sectionForKind('resp'), 'registered');
  assert.equal(sectionForKind('prpp'), 'registered');
  assert.equal(sectionForKind('rpp'), 'registered');
  assert.equal(sectionForKind('hbp'), 'registered');
  assert.equal(sectionForKind('deduction'), 'deductions');
  assert.equal(sectionForKind('disability'), 'deductions');
  assert.equal(sectionForKind('student'), 'deductions');
  assert.equal(sectionForKind('credit'), 'provincial');
  assert.equal(sectionForKind('nope'), 'income');
  const items = [
    { kind: 'employment', amount: 100, share_pct: 100, status: 'confirmed' },
    { kind: 'rental', amount: 200, share_pct: 50, status: 'linked' },
    { kind: 'rrsp', amount: 300, share_pct: 100, status: 'expected' },
    { kind: 'resp', amount: 5000, share_pct: 100, status: 'linked' },
    { kind: 'prpp', amount: 1000, share_pct: 100, status: 'confirmed' },
    { kind: 'disability', amount: 10138, share_pct: 100, status: 'linked' },
    { kind: 'credit', amount: 400, share_pct: 100, status: 'confirmed' },
    { kind: 'credit', amount: 999, share_pct: 100, status: 'excluded' },
    // The derived rental-deduction row renders in Income, under
    // its rental item: it counts in Income's row counts but $0
    // in every amount.
    { kind: 'deduction', amount: 18903.37, share_pct: 50, status: 'linked', detail: { derived: true } },
  ];
  const s = sectionSummary(items);
  assert.deepEqual(Object.keys(s), ['income', 'registered', 'deductions', 'provincial']);
  assert.equal(s.income.total, 3);
  assert.equal(s.income.confirmed, 1);
  assert.equal(s.income.linked, 2);
  assert.equal(s.income.amount, 200); // 100 + 200×50% + 0 for the derived row
  assert.equal(s.registered.total, 3);
  assert.equal(s.registered.expected, 1);
  assert.equal(s.registered.linked, 1);
  assert.equal(s.registered.confirmed, 1);
  assert.equal(s.registered.amount, 1300); // 300 + 1000; RESP contributes $0
  assert.equal(s.deductions.total, 1);
  assert.equal(s.deductions.linked, 1);
  assert.equal(s.deductions.amount, 10138);
  assert.equal(s.provincial.total, 2);
  assert.equal(s.provincial.excluded, 1);
  assert.equal(s.provincial.amount, 400); // the excluded credit never counts
  assert.deepEqual(sectionSummary([]).income, {
    key: 'income', label: 'Income', total: 0, expected: 0, linked: 0, confirmed: 0, excluded: 0, amount: 0,
  });
});

// ------------------------------------------------------- room splits --
test('respRoomSplit / cesgRoomSplit: null in → null out; room splits the verified lifetime limits', () => {
  assert.equal(respRoomSplit(null), null);
  assert.equal(respRoomSplit(undefined), null);
  assert.equal(cesgRoomSplit(null), null);
  assert.equal(RESP_LIFETIME_LIMIT, 50000);
  assert.equal(CESG_LIFETIME_MAX, 7200);
  // No contributions yet: the whole lifetime limit is remaining.
  assert.deepEqual(respRoomSplit(50000), { contributed: 0, remaining: 50000, limit: 50000 });
  // $5,000 contributed leaves $45,000 of room.
  assert.deepEqual(respRoomSplit(45000), { contributed: 5000, remaining: 45000, limit: 50000 });
  assert.deepEqual(cesgRoomSplit(7200), { earned: 0, remaining: 7200, limit: 7200 });
  assert.deepEqual(cesgRoomSplit(7000), { earned: 200, remaining: 7000, limit: 7200 });
});

test('tfsaNetContributed / rrspContributed: only real records count — buys minus sells, generated buys only', () => {
  assert.equal(tfsaNetContributed([
    { type: 'buy', units: 10, price: 50 },
    { type: 'buy', units: 5, price: 100 },
    { type: 'sell', units: 4, price: 60 },
  ]), 760); // 500 + 500 − 240
  assert.equal(tfsaNetContributed([{ type: 'sell', units: 10, price: 50 }]), 0); // floored at zero
  assert.equal(tfsaNetContributed([{ type: 'buy', units: 10, price: null }]), 0); // no price, no contribution
  assert.equal(tfsaNetContributed([]), 0);
  assert.equal(rrspContributed([
    { type: 'buy', own_amount: 220.05 },
    { type: 'buy', own_amount: 220.05 },
    { type: 'sell', own_amount: 999 }, // a sell is not a contribution
    { type: 'buy', own_amount: null },
  ]), 440.1);
  assert.equal(rrspContributed([]), 0);
});

test('taxRoomCutoff / throughDate: the home charts for year Y read year Y−1 records (through Dec 31)', () => {
  assert.equal(taxRoomCutoff(2025), '2025-12-31');
  assert.equal(taxRoomCutoff(2024), '2024-12-31');
  const events = [
    { type: 'buy', date: '2025-12-31', units: 10, price: 100 },
    { type: 'buy', date: '2026-01-05', units: 10, price: 145 },
    { type: 'sell', date: '2026-03-10', units: 5, price: 100 },
  ];
  assert.equal(tfsaNetContributed(throughDate(events, '2025-12-31')), 1000); // only the 2025 buy
  assert.equal(tfsaNetContributed(throughDate(events, '2026-12-31')), 1950); // 1000 + 1450 − 500
  assert.equal(throughDate(events, null).length, 3); // no cutoff: everything (project view)
  assert.equal(throughDate([], '2025-12-31').length, 0);
  assert.equal(rrspContributed(throughDate([
    { type: 'buy', date: '2025-12-20', own_amount: 220.05 },
    { type: 'buy', date: '2026-01-03', own_amount: 220.05 },
  ], '2025-12-31')), 220.05);
});

// --------------------------------------------------- RRSP benefit estimate --
// The estimate reuses the Earnings T4127 engine (calcSalary):
// tax without the contribution minus tax with it. His Meta job
// (biweekly $7,334.77, BC) with a $11,442.60 contribution
// ($440.10/period) saves $4,925.25 by the engine — within $0.21
// of his paystub-derived $4,925.04/yr ($189.42/period); the gap
// is per-period rounding in the paystub figure, not a second
// calculator.
test('rrspBenefit: $0 saves $0; the Meta-like job saves $4,925.25 on $11,442.60', () => {
  const meta = jobRow();
  const zero = rrspBenefit({ jobRows: [meta], payroll, amount: 0 });
  assert.equal(zero.income, 190704.02);
  assert.equal(zero.province, 'BC');
  assert.equal(zero.provinceVerified, true);
  assert.equal(zero.benefit, 0);
  assert.equal(zero.benefitRatePct, 0);
  assert.equal(zero.estimateNote, 'Estimate — actual tax is settled on the T1.');

  const full = rrspBenefit({ jobRows: [meta], payroll, amount: 11442.6 });
  assert.equal(full.taxWithout, 53688.57);
  assert.equal(full.taxWith, 48763.32);
  assert.equal(full.benefit, 4925.25);
  assert.equal(full.benefitRatePct, 43);
  assert.deepEqual(full.jobs, [{ employer: 'Meta', gross: 190704.02, allocated: 11442.6 }]);
});

test('rrspBenefit: no jobs → no income, no benefit; unverified province → federal-only', () => {
  const none = rrspBenefit({ jobRows: [], payroll, amount: 1000 });
  assert.equal(none.income, 0);
  assert.equal(none.province, null);
  assert.equal(none.taxWithout, 0);
  assert.equal(none.benefit, 0);
  assert.deepEqual(none.jobs, []);

  const qc = rrspBenefit({ jobRows: [jobRow({ province: 'QC' })], payroll, amount: 11442.6 });
  assert.equal(qc.provinceVerified, false);
  assert.equal(qc.benefit, 3243.18); // federal only — Quebec has its own return
  assert.ok(qc.warnings.some((w) => /Quebec/.test(w)));
});

test('rrspBenefit: a contribution above total income spills to the next job, highest-gross first', () => {
  const side = jobRow({ id: 2, employer: 'Side', gross_amount: 1000, gross_basis: 'period' });
  const r = rrspBenefit({ jobRows: [jobRow(), side], payroll, amount: 200000 });
  assert.equal(r.income, 216704.02);
  assert.deepEqual(r.jobs.map((j) => j.allocated), [190704.02, 9295.98]);
  assert.equal(r.benefit, 55088.96);
  // A contribution above total income cannot save more than the
  // tax on that income: the leftover saves nothing.
  assert.ok(r.taxWith >= 0 && r.taxWith < 200);
});

// ---------------------------------------------------------- tax profile --
test('validTaxProfileInput: nulls are fine (not recorded); negatives, over-limit rooms and bad dates are not', () => {
  assert.equal(validTaxProfileInput({}), null);
  assert.equal(validTaxProfileInput({ rrsp_room: 20000, tfsa_room: 5000, resp_room: 45000, cesg_room: 7000, as_of_date: '2026-10-31' }), null);
  assert.match(validTaxProfileInput({ rrsp_room: -1 }), /rrsp_room/);
  assert.match(validTaxProfileInput({ tfsa_room: 'x' }), /tfsa_room/);
  assert.match(validTaxProfileInput({ resp_room: 50001 }), /resp_room/);
  assert.match(validTaxProfileInput({ cesg_room: 7201 }), /cesg_room/);
  assert.match(validTaxProfileInput({ as_of_date: '31/10/2026' }), /as_of_date/);
  assert.match(validTaxProfileInput({ resp_beneficiary: 'x'.repeat(101) }), /resp_beneficiary/);
  assert.match(validTaxProfileInput({ notes: 'x'.repeat(1001) }), /notes/);
});

// ------------------------------------------------------------ T1 tables --
// The 2026 federal + BC tables behind the refund headline must
// not drift from the Earnings payroll module — the two table
// sets feed the same calcSalary. 2025's blended 14.5% lowest
// rate is pinned here too (never 15%).
test('federal.js / bc.js 2026 tables match the Earnings payroll module', () => {
  const f26 = federalTable(2026);
  assert.deepEqual(f26.brackets, payroll.federal.brackets);
  assert.equal(f26.bpaMax, payroll.federal.bpaMax);
  assert.equal(f26.bpaBase, payroll.federal.bpaBase);
  assert.equal(f26.phaseOutStart, payroll.federal.phaseOutStart);
  assert.equal(f26.phaseOutEnd, payroll.federal.phaseOutEnd);
  assert.equal(f26.lowestRate, payroll.federal.lowestRate);
  assert.equal(f26.employmentAmountMax, payroll.federal.employmentAmountMax);
  assert.deepEqual(f26.cpp, payroll.cpp);
  assert.deepEqual(f26.ei, payroll.ei);
  const b26 = bcTable(2026);
  assert.deepEqual(b26.brackets, payroll.provinces.BC.brackets);
  assert.equal(b26.bpa, payroll.provinces.BC.bpa);
  assert.equal(b26.lowestRate, payroll.provinces.BC.lowestRate);
  // 2025: the July 1 cut from 15% to 14% blends to 14.5% for
  // the full year; the T4032 flag on payroll's $1,501 is
  // confirmed by the 2026 employment-amount maximum.
  assert.equal(federalTable(2025).lowestRate, 0.145);
  assert.equal(federalTable(2025).employmentAmountMax, 1471);
  assert.equal(federalTable(2026).employmentAmountMax, 1501);
  assert.equal(federalTable(2024), null);
  assert.equal(bcTable(2024), null);
});

// ------------------------------------------------------- T1 computation --
// The user's real 2025 T1 (Shaofeng, pasted 2026-11-08): the
// engine must reproduce it line-for-line from equivalent 2025
// items, a T4 slip carrying the tax deducted, and his Meta-like
// job for the CPP/EI split (capped at these income levels, so
// the exact gross is immaterial — only that it clears YMPE/MIE).
const t1Line = (lines, line) => lines.find((l) => l.line === line)?.amount;
test('computeT1 reproduces his 2025 return: refund $16,615.42', () => {
  const job2025 = jobRow({ tax_year: 2025, gross_amount: 29406.07 });
  const items = [
    { kind: 'employment', label: 'Meta — employment income', amount: 764557.72, share_pct: 100, status: 'linked', detail: {} },
    { kind: 'investment_income', label: 'Interest', amount: 528.20, share_pct: 100, status: 'linked', detail: {} },
    { kind: 'rental', label: '2985 Basement — rental income (T776)', amount: -3610.98, share_pct: 100, status: 'linked', detail: {} },
    { kind: 'other_income', label: 'RRSP income', amount: 677.00, share_pct: 100, status: 'linked', detail: {} },
    { kind: 'rrsp', label: 'RRSP contributions', amount: 33251.00, share_pct: 100, status: 'linked', detail: {} },
  ];
  const slips = [{ kind: 'T4', fields: { box22: 354009.41 } }];
  const r = computeT1({ taxYear: 2025, province: 'BC', items, slips, jobs: [job2025] });
  assert.equal(r.refund, 16615.42);
  assert.equal(r.isRefund, true);
  assert.equal(r.label, 'Refund');
  assert.equal(r.displayAmount, 16615.42);
  assert.equal(t1Line(r.lines, '10100'), 764557.72);
  assert.equal(t1Line(r.lines, '12100'), 528.20);
  assert.equal(t1Line(r.lines, '12600'), -3610.98);
  assert.equal(t1Line(r.lines, '12900'), 677.00);
  assert.equal(t1Line(r.lines, '15000'), 762151.94);
  assert.equal(t1Line(r.lines, '20800'), 33251.00);
  assert.equal(t1Line(r.lines, '22215'), 1074.00); // CPP enhancement: 1% × 67,800 + 4% × 9,900
  assert.equal(t1Line(r.lines, '23600'), 727826.94);
  assert.equal(t1Line(r.lines, '26000'), 727826.94);
  assert.equal(t1Line(r.lines, '30000'), 14538); // phased-out BPA at this income
  assert.equal(t1Line(r.lines, '30800'), 3356.10); // CPP base: 4.95% × (71,300 − 3,500)
  assert.equal(t1Line(r.lines, '31200'), 1077.48); // EI: 1.64% × 65,700
  assert.equal(t1Line(r.lines, '31260'), 1471);
  assert.equal(t1Line(r.lines, '33500'), 20442.58);
  assert.equal(t1Line(r.lines, '33800'), 2964.17); // 20,442.58 × 14.5%
  assert.equal(t1Line(r.lines, '35000'), 2964.17);
  assert.equal(t1Line(r.lines, '40600'), 211991.95);
  assert.equal(t1Line(r.lines, '42000'), 211991.95);
  assert.equal(t1Line(r.lines, '42800'), 125402.04);
  assert.equal(t1Line(r.lines, '43500'), 337393.99);
  assert.equal(t1Line(r.lines, '43700'), 354009.41);
  assert.equal(t1Line(r.lines, '48200'), 354009.41);
  assert.equal(t1Line(r.lines, '48400'), 16615.42);
  // The gross-tax sub-lines (line null) carry the pre-credit figures.
  const fedGross = r.lines.find((l) => l.line == null && /Federal tax on taxable income/.test(l.label));
  assert.equal(fedGross.amount, 214956.12);
  const bcGross = r.lines.find((l) => l.line == null && /British Columbia tax on taxable income/.test(l.label));
  assert.equal(bcGross.amount, 126280.74);
});

test('computeT1: T4A pension income goes to 11500, other RRSP income to 12900', () => {
  const r = computeT1({
    taxYear: 2026, province: 'BC',
    items: [
      { kind: 'other_income', label: 'Pension', amount: 5000, share_pct: 100, status: 'linked', detail: {}, slipKind: 'T4A' },
      { kind: 'other_income', label: 'RRSP income', amount: 677, share_pct: 100, status: 'linked', detail: {} },
    ],
    slips: [], jobs: [],
  });
  assert.equal(t1Line(r.lines, '11500'), 5000);
  assert.equal(t1Line(r.lines, '12900'), 677);
  assert.equal(t1Line(r.lines, '15000'), 5677);
  assert.equal(r.refund, 0);
});

test('computeT1: unsupported province / year returns a flag, never a guessed number; empty filing refunds $0', () => {
  const base = { taxYear: 2025, province: 'BC', items: [], slips: [], jobs: [] };
  const on = computeT1({ ...base, province: 'ON' });
  assert.equal(on.unsupportedProvince, true);
  assert.equal(on.refund, undefined);
  const y24 = computeT1({ ...base, taxYear: 2024 });
  assert.equal(y24.unsupportedYear, true);
  assert.equal(y24.refund, undefined);
  const empty = computeT1({ taxYear: 2026, province: 'BC', items: [], slips: [], jobs: [] });
  assert.equal(empty.refund, 0);
  assert.equal(empty.isRefund, true);
  assert.equal(t1Line(empty.lines, '15000'), 0);
  assert.ok(empty.notes.some((n) => /No job or T4/.test(n)));
});

// The home card's show/hide rule — the same rule the T1 math
// uses: only counted items make a balance showable. The engine
// computes refund $0 for an empty filing (see above), so the card
// must NOT show that $0; and a filing whose only item is a
// derived rental-deduction row (already netted in its source
// item) must not show one either.
test('countedItems: only non-excluded, non-derived items count toward a showable card balance', () => {
  assert.deepEqual(countedItems([]), []);
  assert.equal(countedItems([{ kind: 'employment', amount: 100, status: 'linked' }]).length, 1);
  assert.equal(countedItems([{ kind: 'deduction', amount: 17903.37, status: 'linked', detail: { derived: true } }]).length, 0);
  assert.equal(countedItems([{ kind: 'rrsp', amount: 100, status: 'excluded' }]).length, 0);
  assert.equal(countedItems([
    { kind: 'employment', amount: 100, status: 'linked' },
    { kind: 'deduction', amount: 17903.37, status: 'linked', detail: { derived: true } },
    { kind: 'rrsp', amount: 50, status: 'excluded' },
  ]).length, 1);
});

// ---------------------------------------------------------- history tax --
// The History module filter's Tax option covers both tax write
// streams — 'tax' (filings, items, slips) and 'tax-profile'
// (the contribution-room profile) — as one module.
test('listCommits: module=tax matches tax + tax-profile commits, nothing else', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE app_commits (
    id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, module TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id INTEGER, entity_label TEXT, project_id INTEGER,
    strategy_id INTEGER, merge_record_id INTEGER, kind TEXT NOT NULL DEFAULT 'commit',
    summary TEXT NOT NULL, event TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO app_commits (module, entity_type, summary, event, snapshot, created_at) VALUES (?, ?, ?, '[]', '{}', ?)");
  ins.run('tax', 'tax_filing', 'Created tax project', now);
  ins.run('tax', 'tax_item', 'Added item', now);
  ins.run('tax-profile', 'tax_profile', 'Saved contribution room', now);
  ins.run('planning', 'project', 'Created project', now);
  const tax = listCommits(db, { module: 'tax', limit: 10, offset: 0 });
  assert.equal(tax.total, 3);
  assert.deepEqual(tax.commits.map((c) => c.module).sort(), ['tax', 'tax', 'tax-profile']);
  const planning = listCommits(db, { module: 'planning', limit: 10, offset: 0 });
  assert.equal(planning.total, 1);
  const all = listCommits(db, { module: null, limit: 10, offset: 0 });
  assert.equal(all.total, 4);
  db.close();
});

// --------------------------------------------- export + multi-project --
// Tax is mainline user data (like earnings/spending), not
// planning: all four tables ride the export payload. The list
// itself is asserted against the real export module here by
// source (this file never imports the DB); the row-level
// round-trip is proven in tests/dataExport.test.mjs, which runs
// against a temp DATA_DIR.
test('export: all four Tax tables are mainline (in src/dataExport.js MAINLINE_TABLES)', () => {
  const src = fs.readFileSync(new URL('../src/dataExport.js', import.meta.url), 'utf8');
  const list = src.match(/export const MAINLINE_TABLES = \[([\s\S]*?)\];/)[1];
  for (const t of ['tax_filings', 'tax_slips', 'tax_items', 'tax_profiles']) {
    assert.ok(list.includes(`'${t}'`), `${t} missing from MAINLINE_TABLES`);
  }
  assert.ok(!src.match(/export const PLANNING_TABLES = \[([\s\S]*?)\];/)[1].includes('tax_'), 'no Tax table in PLANNING_TABLES');
});

test('multiple projects per person-year: the real tax_filings DDL has no unique constraint on (person_id, tax_year)', () => {
  const dbSrc = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  const ddl = dbSrc.match(/CREATE TABLE IF NOT EXISTS tax_filings \([\s\S]*?\);/)[0];
  assert.ok(!/UNIQUE/i.test(ddl), 'tax_filings must not carry a UNIQUE constraint');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  db.exec(ddl);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'Shawn')").run();
  const ins = db.prepare("INSERT INTO tax_filings (person_id, name, tax_year, region, status, created_at, updated_at) VALUES (?, ?, ?, 'CA', 'open', ?, ?)");
  ins.run(2, 'Tax return 2026', 2026, now, now);
  ins.run(2, 'Rental only', 2026, now, now);
  const rows = db.prepare('SELECT id, name FROM tax_filings WHERE person_id = 2 AND tax_year = 2026 ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.name), ['Tax return 2026', 'Rental only']);
  assert.notEqual(rows[0].id, rows[1].id);
  db.close();
});

// Regression guard for the 2026-11-08 e2e catch: deriveTaxContext
// in src/server.js once aliased the joined columns snake_case
// (account_type, holding_label, …) while buildExpectedContext
// reads camelCase (accountType, holdingLabel, …) — every plan,
// dividend and sell silently vanished from Generate, and the
// employment item alone made it look half-working. The query
// must alias the joined columns to the contract names.
test('deriveTaxContext SQL aliases the joined columns to the buildExpectedContext contract names', () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  for (const alias of ['AS accountType', 'AS accountName', 'AS holdingLabel', 'AS jobOwner', 'AS accountOwners']) {
    assert.ok(src.includes(alias), `deriveTaxContext must alias ${alias}`);
  }
  assert.ok(!/a\.currency AS/.test(src), 'invest_accounts has no currency column (use default_currency)');
});
