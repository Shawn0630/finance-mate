// Tax module: the region interface (CA slips, slip → item
// mapping, expected-items derivation), the split math, the
// per-item share, plan annual contributions, and the
// upsertExpectedItems refresh/prune rules against a real
// SQLite table. No tax computation exists in v1 — nothing here
// asserts a payable or a refund.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getRegion } from '../src/regions/index.js';
import * as caTax from '../src/regions/ca/tax.js';
import { payroll } from '../src/regions/ca.js';
import {
  TAX_ITEM_KINDS, TAX_ITEM_STATUSES, TAX_SECTIONS, sectionForKind, sectionSummary,
  RESP_LIFETIME_LIMIT, CESG_LIFETIME_MAX, respRoomSplit, cesgRoomSplit,
  tfsaNetContributed, rrspContributed, rrspBenefit,
  effectiveAmount, filingTotals,
  validSharePct, validTaxItemInput, validTaxSlipInput, validTaxProfileInput,
  buildExpectedContext, planOwnAnnual, upsertExpectedItems,
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

test('CA slip kinds: the seven slips, each with box fields', () => {
  const kinds = caTax.slipKinds.map((s) => s.kind);
  assert.deepEqual(kinds, ['T4', 'T4A', 'T5', 'T3', 'T4RSP', 'T4RIF', 'T5008']);
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

// --------------------------------------------------------- expected items --
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
test('buildExpectedContext: job annual gross, rental split, RRSP-only plans, NonRegistered-only events', () => {
  const ctx = buildExpectedContext({
    taxYear: 2026,
    jobRows: [jobRow(), jobRow({ id: 2, employer: 'Other year', tax_year: 2025, owner: 'Jiaying' })],
    rentalRows: [{
      id: 5, label: '2985 Basement', propertyOwners: '["Shawn","Jiaying"]',
      years: [{ tax_year: 2026, calc: { grossWhole: 22800, deductibleExpenses: 18903.37, netWhole9946: 3896.63 } }],
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
  });
  assert.equal(ctx.jobs.length, 1); // the 2025 job is another year's
  assert.equal(ctx.jobs[0].annualGross, 190704.02);
  assert.equal(ctx.rentals.length, 1);
  assert.equal(ctx.rentals[0].net, 3896.63);
  assert.equal(ctx.plans.length, 1); // TFSA plan is not a deduction
  assert.equal(ctx.plans[0].ownAnnual, 880.2); // 4 due periods × 220.05, projected
  assert.equal(ctx.plans[0].basis, 'projected');
  assert.equal(ctx.dividends.length, 1); // TFSA dividend is not taxed in-year
  assert.equal(ctx.sells.length, 1); // RRSP sell is not a capital gain
  assert.equal(ctx.sells[0].proceeds, 1505);

  const items = caTax.expectedItems(ctx);
  assert.equal(items.filter((i) => i.kind === 'employment').length, 1);
  assert.equal(items.filter((i) => i.kind === 'rental').length, 2);
  assert.equal(items.filter((i) => i.kind === 'rrsp').length, 1);
  assert.equal(items.filter((i) => i.kind === 'investment_income').length, 1);
  assert.equal(items.filter((i) => i.kind === 'capital_gain').length, 2);
});

// ---------------------------------------------------------- plan own annual --
test('planOwnAnnual: generated buys are the ground truth (actual); otherwise due periods × per-period own (projected)', () => {
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
  });
  assert.equal(actual, 440.1);
  const planA = { ...base, events: [{ type: 'buy', date: '2026-03-15', own_amount: 220.05 }] };
  planOwnAnnual(planA);
  assert.equal(planA._basis, 'actual');

  const projected = planOwnAnnual({ ...base });
  assert.equal(projected, 2700); // 27 bi-weekly due dates in 2026 from Jan 1 × $100
  const planP = { ...base };
  planOwnAnnual(planP);
  assert.equal(planP._basis, 'projected');

  assert.equal(planOwnAnnual({ ...base, start_date: '2027-01-01' }), 0);
  assert.equal(planOwnAnnual({ ...base, own_amount: 0 }), 0);
});

test('planOwnAnnual: percent plans derive from the current per-period gross', () => {
  const plan = {
    taxYear: 2026, own_pct: 3, employer_pct: 3,
    jobFrequency: 'biweekly', job: { frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period' },
    start_date: '2026-01-01', events: [], deletedDueDates: [],
  };
  // 3% × 7334.77 = 220.04 per period × 27 due dates.
  assert.equal(planOwnAnnual(plan), 5941.08);
  assert.equal(plan._basis, 'projected');
});

// ------------------------------------------------------------- share math --
test('effectiveAmount and filingTotals: share × amount, excluded items never count', () => {
  assert.equal(effectiveAmount({ amount: 2000, share_pct: 50 }), 1000);
  assert.equal(effectiveAmount({ amount: 100, share_pct: 33.33 }), 33.33);
  assert.equal(effectiveAmount({ amount: 100, share_pct: null }), 100);
  const totals = filingTotals([
    { kind: 'employment', amount: 190704.02, share_pct: 100, status: 'confirmed' },
    { kind: 'rental', amount: 3896.63, share_pct: 50, status: 'linked' },
    { kind: 'rrsp', amount: 880.2, share_pct: 100, status: 'excluded' },
  ]);
  assert.equal(totals.byKind.employment, 190704.02);
  assert.equal(totals.byKind.rental, 1948.32);
  assert.equal(totals.byKind.rrsp, undefined);
  assert.equal(totals.total, 192652.34);
});

test('validSharePct and validTaxItemInput', () => {
  assert.equal(validSharePct(100), true);
  assert.equal(validSharePct(0.01), true);
  assert.equal(validSharePct(0), false);
  assert.equal(validSharePct(100.01), false);
  assert.equal(validSharePct('x'), false);
  assert.equal(validTaxItemInput({ kind: 'employment', label: 'Meta', amount: 1 }), null);
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

test('upsertExpectedItems: add, refresh amounts, prune stale — and never touch user-owned items', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tax_items (
    id INTEGER PRIMARY KEY, filing_id INTEGER, tax_year INTEGER NOT NULL,
    kind TEXT NOT NULL, label TEXT NOT NULL, source_type TEXT, source_id INTEGER,
    slip_id INTEGER, amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'CAD',
    share_pct REAL NOT NULL DEFAULT 100, status TEXT NOT NULL DEFAULT 'expected',
    detail TEXT NOT NULL DEFAULT '{}', notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO tax_items
    (filing_id, tax_year, kind, label, source_type, source_id, amount, currency, share_pct, status, detail, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`);
  // A linked item for a source that will disappear from the
  // derived list: the user owns it, so Generate must keep it.
  insert.run(1, 2026, 'employment', 'Old job', 'job', 99, 5000, 'CAD', 100, 'linked', now, now);
  // A manual item (no source): never touched either.
  insert.run(1, 2026, 'deduction', 'Manual', null, null, 300, 'CAD', 100, 'linked', now, now);
  // An expected item whose source will vanish: pruned.
  insert.run(1, 2026, 'rental', 'Gone', 'rental', 77, 100, 'CAD', 100, 'expected', now, now);

  const first = upsertExpectedItems(db, {
    filingId: 1, taxYear: 2026,
    derived: [
      { kind: 'employment', label: 'Meta — employment income', sourceType: 'job', sourceId: 1, amount: 190704.02, currency: 'CAD', sharePct: 100, detail: {} },
      { kind: 'rental', label: '2985 Basement — rental income (T776)', sourceType: 'rental', sourceId: 5, amount: 3896.63, currency: 'CAD', sharePct: 50, detail: {} },
    ],
  });
  assert.deepEqual(first, { added: 2, updated: 0, removed: 1 });
  const rows = db.prepare('SELECT * FROM tax_items ORDER BY id').all();
  assert.equal(rows.length, 4); // 2 kept + 2 added, 1 pruned
  assert.equal(rows.find((r) => r.source_id === 99).status, 'linked');
  assert.equal(rows.find((r) => r.source_type === null).label, 'Manual');

  // Refresh: the job amount changes, the rental is unchanged.
  const second = upsertExpectedItems(db, {
    filingId: 1, taxYear: 2026,
    derived: [
      { kind: 'employment', label: 'Meta — employment income', sourceType: 'job', sourceId: 1, amount: 195000, currency: 'CAD', sharePct: 100, detail: {} },
      { kind: 'rental', label: '2985 Basement — rental income (T776)', sourceType: 'rental', sourceId: 5, amount: 3896.63, currency: 'CAD', sharePct: 50, detail: {} },
    ],
  });
  assert.deepEqual(second, { added: 0, updated: 1, removed: 0 });
  assert.equal(db.prepare("SELECT amount FROM tax_items WHERE source_type = 'job' AND source_id = 1").get().amount, 195000);

  // A user-confirmed item for a derived source is never
  // overwritten, even when the derived amount moves.
  db.prepare("UPDATE tax_items SET status = 'confirmed', amount = 1 WHERE source_type = 'job' AND source_id = 1").run();
  const third = upsertExpectedItems(db, {
    filingId: 1, taxYear: 2026,
    derived: [
      { kind: 'employment', label: 'Meta — employment income', sourceType: 'job', sourceId: 1, amount: 200000, currency: 'CAD', sharePct: 100, detail: {} },
      { kind: 'rental', label: '2985 Basement — rental income (T776)', sourceType: 'rental', sourceId: 5, amount: 3896.63, currency: 'CAD', sharePct: 50, detail: {} },
    ],
  });
  assert.deepEqual(third, { added: 0, updated: 0, removed: 0 });
  assert.equal(db.prepare("SELECT amount FROM tax_items WHERE source_type = 'job' AND source_id = 1").get().amount, 1);

  // The unlinked bucket (filingId null) is a separate scope.
  const fourth = upsertExpectedItems(db, {
    filingId: null, taxYear: 2026,
    derived: [{ kind: 'employment', label: 'Side gig', sourceType: 'job', sourceId: 2, amount: 5000, currency: 'CAD', sharePct: 100, detail: {} }],
  });
  assert.deepEqual(fourth, { added: 1, updated: 0, removed: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tax_items WHERE filing_id IS NULL').get().c, 1);
  db.close();
});

// ------------------------------------------------- sections / credits --
// The guided-return checklist (TurboTax-style): Income,
// Deductions, Credits, then Review (a summary, not a kind
// bucket). 'credit' is a first-class item kind.
test("'credit' is a valid item kind; sectionSummary counts expected/linked/confirmed/excluded per section", () => {
  assert.ok(TAX_ITEM_KINDS.includes('credit'));
  assert.equal(validTaxItemInput({ kind: 'credit', label: 'Canada workers benefit', amount: 100 }), null);
  assert.equal(sectionForKind('employment'), 'income');
  assert.equal(sectionForKind('rental'), 'income');
  assert.equal(sectionForKind('rrsp'), 'deductions');
  assert.equal(sectionForKind('deduction'), 'deductions');
  assert.equal(sectionForKind('credit'), 'credits');
  assert.equal(sectionForKind('nope'), 'income');
  const items = [
    { kind: 'employment', amount: 100, share_pct: 100, status: 'confirmed' },
    { kind: 'rental', amount: 200, share_pct: 50, status: 'linked' },
    { kind: 'rrsp', amount: 300, share_pct: 100, status: 'expected' },
    { kind: 'credit', amount: 400, share_pct: 100, status: 'confirmed' },
    { kind: 'credit', amount: 999, share_pct: 100, status: 'excluded' },
  ];
  const s = sectionSummary(items);
  assert.deepEqual(Object.keys(s), ['income', 'deductions', 'credits']);
  assert.equal(s.income.total, 2);
  assert.equal(s.income.confirmed, 1);
  assert.equal(s.income.linked, 1);
  assert.equal(s.income.amount, 200); // 100 + 200×50%
  assert.equal(s.deductions.expected, 1);
  assert.equal(s.deductions.amount, 300);
  assert.equal(s.credits.total, 2);
  assert.equal(s.credits.excluded, 1);
  assert.equal(s.credits.amount, 400); // the excluded credit never counts
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
