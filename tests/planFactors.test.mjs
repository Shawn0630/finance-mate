// Strategy factors: prime presets, property growth in the projection,
// custom-sink buy price seeding, and the sell-funded swap accounting
// (a swap is not new cash — it must not count as cash out nor as
// opportunity-costed principal). Also: the baseline world's per-holding
// current rates, and the per-source pool contribution shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProjection, compareProjections, resolveBuyLegs,
  reportMonthlySeries, primeFactorPresetPoints,
  currentReturnRateFromPoints, validatePoolItemShapes,
} from '../src/planning.js';

const PROP = () => ({
  id: 1, mortgage_balance: 500000, mortgage_balance_date: '2026-01-01',
  region: 'CA', payment_day: 1, payment_frequency: 'monthly',
  terms: [{ id: 1, property_id: 1, start_date: '2026-01-01', term_months: 60, amortization_years: 25, repayment_method: 'equal_payment' }],
  segments: [{ id: 1, property_id: 1, start_date: '2026-01-01', rate_type: 'fixed', rate_mode: 'absolute', annual_rate: 5.0, compounding: 'semi_annual', accrual: 'monthly' }],
  lumpSums: [],
});
const MAINLINE = (over = {}) => ({
  properties: [PROP()], holdings: [], fxRateLatest: null, declaredAssets: [], assessed: { 1: 1000000 },
  ...over,
});
const ARGS = (over = {}) => ({
  mainline: MAINLINE(), ops: [], legs: [], assumptions: {},
  scenario: null, primeHistory: [], currentPrime: 4.70, currentMonth: '2026-11',
  ...over,
});

test('propertyGrowthPct grows the assessed value to the horizon, flat without it', () => {
  const flat = computeProjection(ARGS());
  const grown = computeProjection(ARGS({ assumptions: { propertyGrowthPct: 2 } }));
  assert.equal(flat.errors.length, 0);
  assert.equal(grown.errors.length, 0);
  // 25y amortization pays off before the 30y horizon, so the balance
  // term is 0 in both runs and the delta is pure assessed growth.
  assert.ok(Math.abs(flat.valueAtHorizon - 1000000) < 1);
  const expected = 1000000 * Math.pow(1.02, 30);
  assert.ok(Math.abs(grown.valueAtHorizon - expected) < 1, `grew to ${grown.valueAtHorizon}, expected ${expected}`);
});

test('a buy with an explicit price seeds its price path (custom sink)', () => {
  const buy = { seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'GIC', currency: 'CAD', date: '2026-11-01', amount: 10000, price: 100 } };
  const r = computeProjection(ARGS({
    mainline: MAINLINE({ properties: [] }),
    ops: [buy],
    legs: [{ op_seq: 1, source_ref: 'external', amount: 'all' }],
    assumptions: { stockReturnPct: 6 },
  }));
  assert.equal(r.errors.length, 0);
  assert.equal(r.stocks.buyCash, 10000);
  assert.equal(r.stocks.buyCashFromSells, 0);
  const expected = 100 * 100 * Math.pow(1.06, 30);
  assert.ok(Math.abs(r.stocks.valueAtHorizon - expected) < 100, `grew to ${r.stocks.valueAtHorizon}, expected ${expected}`);
});

test('compareProjections: a sell-funded swap is not costed again', () => {
  const base = { stocks: { startingValue: 10000, valueAtHorizon: 10000 }, mortgage: { interestSaved: 0 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: null, paymentDelta: null };
  const sink = { stocks: { valueAtHorizon: 15000, sellExternalOut: 0, buyCash: 10000, buyCashFromSells: 10000 }, mortgage: { interestSaved: 0 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: null, paymentDelta: null, cost: 0 };
  const pot = { stocks: { valueAtHorizon: 25000, sellExternalOut: 0, buyCash: 10000, buyCashFromSells: 0 }, mortgage: { interestSaved: 0 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: null, paymentDelta: null, cost: 10000 };
  // Sink: pool 10000 sold, sink grows to 15000 — gain is the 5000 excess.
  assert.equal(compareProjections(base, sink).stockGain, 5000);
  assert.equal(compareProjections(base, sink).cost, 0);
  // Pot buy: baseline holdings 10000 flat + bought 10000 grown to 15000
  // — gain is again the 5000 excess, and the 10000 is real cash out.
  assert.equal(compareProjections(base, pot).stockGain, 5000);
  assert.equal(compareProjections(base, pot).cost, 10000);
});

test('resolveBuyLegs reports the sell-earmarked share of a buy', () => {
  const out = resolveBuyLegs(
    [{ op_seq: 2, source_ref: 'op:1', amount: 'all' }],
    5000,
    { pot: 0, opOutputs: new Map([['sell:1:2', { amountCad: 5000 }]]), declaredAssets: [], opDate: '2026-11-01', holdingCurrency: 'CAD', fxRate: 1, buySeq: 2 },
  );
  assert.equal(out.error, undefined);
  assert.equal(out.fromSellsNative, 5000);
  assert.equal(out.pot, 0);
});

test('reportMonthlySeries grows assessed values month by month under a growth factor', () => {
  const per = { 1: { strategy: { series: [{ month: '2026-11', balance: 100, interest: 0 }, { month: '2026-12', balance: 90, interest: 0 }] } } };
  const flat = reportMonthlySeries(per, 'strategy', [], 1000000);
  const grown = reportMonthlySeries(per, 'strategy', [], 1000000, 12, '2026-11');
  assert.equal(flat[0].total_value, 999900);
  assert.equal(flat[1].total_value, 999910);
  assert.equal(grown[0].total_value, 999900);
  const expected = 1000000 * Math.pow(1.12, 1 / 12) - 90;
  assert.ok(Math.abs(grown[1].total_value - expected) < 1, `grew to ${grown[1].total_value}, expected ${expected}`);
});

test('primeFactorPresetPoints: all five views are complete paths', () => {
  assert.deepEqual(primeFactorPresetPoints('flat', 4.70, '2026-11'), []);
  const up = primeFactorPresetPoints('up', 4.70, '2026-11');
  assert.equal(up[up.length - 1].rate, 5.70);
  const down = primeFactorPresetPoints('down', 4.70, '2026-11');
  assert.equal(down[down.length - 1].rate, 3.70);
  const opt = primeFactorPresetPoints('optimistic', 4.70, '2026-11');
  assert.equal(opt[opt.length - 1].rate, 2.70);
  const pes = primeFactorPresetPoints('pessimistic', 4.70, '2026-11');
  assert.equal(pes[pes.length - 1].rate, 6.70);
  // Rates never go below zero, even from a low prime.
  const floor = primeFactorPresetPoints('optimistic', 0.50, '2026-11');
  assert.ok(floor.every((pt) => pt.rate >= 0));
});

const HOLD = (over = {}) => ({
  id: 7, accountId: 1, symbol: 'HOLD', label: 'Hold', currency: 'CAD',
  events: [{ date: '2026-11-01', type: 'position', units: 10 }],
  pricePoints: [{ date: '2026-11-15', price: 100 }],
  ...over,
});

test('currentReturnRateFromPoints picks the most recent annualized window', () => {
  const one = currentReturnRateFromPoints([
    { date: '2025-11-15', price: 16 }, { date: '2026-10-15', price: 20 },
  ], '2026-11');
  assert.equal(one.ratePct, 25);
  assert.equal(one.basis, 'Price CAGR');
  assert.equal(one.window, '2025-11 → 2026-10');
  const three = currentReturnRateFromPoints([
    { date: '2023-11-15', price: 10 }, { date: '2026-10-15', price: 20 },
  ], '2026-11');
  assert.ok(Math.abs(three.ratePct - 25.99) < 0.01, `3y rate ${three.ratePct}`);
  assert.equal(three.window, '2023-11 → 2026-10');
  assert.equal(currentReturnRateFromPoints([{ date: '2026-10-15', price: 20 }], '2026-11'), null);
  assert.equal(currentReturnRateFromPoints([
    { date: '2026-06-15', price: 10 }, { date: '2026-10-15', price: 11 },
  ], '2026-11'), null);
});

test('computeProjection grows a holding at its per-holding current rate, flat without one, global factor wins', () => {
  const flat = computeProjection(ARGS({ mainline: MAINLINE({ properties: [], holdings: [HOLD()] }) }));
  assert.equal(flat.errors.length, 0);
  assert.ok(Math.abs(flat.stocks.valueAtHorizon - 1000) < 1, `flat ${flat.stocks.valueAtHorizon}`);
  const grown = computeProjection(ARGS({ mainline: MAINLINE({ properties: [], holdings: [HOLD()] }), holdingGrowth: { 7: 10 } }));
  assert.equal(grown.errors.length, 0);
  const expected = 10 * 100 * Math.pow(1.10, 30);
  assert.ok(Math.abs(grown.stocks.valueAtHorizon - expected) < 1, `grew to ${grown.stocks.valueAtHorizon}, expected ${expected}`);
  const over = computeProjection(ARGS({ mainline: MAINLINE({ properties: [], holdings: [HOLD()] }), assumptions: { stockReturnPct: 5 }, holdingGrowth: { 7: 10 } }));
  const expectedOver = 10 * 100 * Math.pow(1.05, 30);
  assert.ok(Math.abs(over.stocks.valueAtHorizon - expectedOver) < 1, `global wins: ${over.stocks.valueAtHorizon}, expected ${expectedOver}`);
});

test('validatePoolItemShapes: per-source percent or amount, never both, never over 100, never duplicated', () => {
  assert.equal(validatePoolItemShapes([{ accountId: 1, percent: 30 }, { holdingId: 2, amount: 500 }]), null);
  assert.equal(validatePoolItemShapes([{ holdingId: 2, percent: 100 }]), null);
  assert.match(validatePoolItemShapes([{ holdingId: 2, percent: 50, amount: 500 }]), /exactly one contribution/);
  assert.match(validatePoolItemShapes([{ holdingId: 2, percent: 101 }]), /at most 100/);
  assert.match(validatePoolItemShapes([{ holdingId: 2, percent: 0 }]), /above 0/);
  assert.match(validatePoolItemShapes([{ holdingId: 2, amount: 0 }]), /above 0/);
  assert.match(validatePoolItemShapes([{ holdingId: 2, percent: 50 }, { holdingId: 2, percent: 50 }]), /duplicate holding/);
  assert.match(validatePoolItemShapes([{ accountId: 1, percent: 50 }, { accountId: 1, amount: 100 }]), /duplicate account/);
  assert.match(validatePoolItemShapes([{ accountId: 1, holdingId: 2, percent: 50 }]), /exactly one source/);
  assert.match(validatePoolItemShapes([]), /at least one source/);
});
