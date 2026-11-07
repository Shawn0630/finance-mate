// Engine round (user 2026-11-04): two peer engines (preset +
// AI-written definition), report penalty variables, and the flat
// VALUE AT HORIZON headline figure. The grown 30-year projection
// value stays on the projection itself and never surfaces as a
// headline balance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProjection, compareProjections,
  validateReportVariables, reportPenaltyFor, applyReportVariables,
  validateAiEngine, evaluateAiEngine, aiReportDefinitionDiff,
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

// ---- VALUE AT HORIZON: flat-price headline, grown projection ----

test('computeProjection flatValueAtHorizon is equity + flat stock + pot (no growth)', () => {
  const buy = { seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'GIC', currency: 'CAD', date: '2026-11-01', amount: 10000, price: 100 } };
  const r = computeProjection(ARGS({
    mainline: MAINLINE({ properties: [] }),
    ops: [buy],
    legs: [{ op_seq: 1, source_ref: 'external', amount: 'all' }],
    assumptions: { stockReturnPct: 6 },
  }));
  assert.equal(r.errors.length, 0);
  // 100 units × $100 flat = $10,000; the grown figure compounds 6%/yr
  // over 30 years (~$57,435) and must NOT be the headline.
  assert.ok(Math.abs(r.flatValueAtHorizon - 10000) < 1, `flat ${r.flatValueAtHorizon}`);
  assert.ok(r.valueAtHorizon > 50000, `grown ${r.valueAtHorizon}`);
  assert.ok(Math.abs(r.stocks.flatValueAtHorizon - 10000) < 1);
});

test('compareProjections valueAtHorizon is the flat figure, with a grown fallback for hand-built projections', () => {
  const base = { stocks: { startingValue: 10000, valueAtHorizon: 57000, flatValueAtHorizon: 10000 }, mortgage: { interestSaved: 0 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: null, paymentDelta: null, flatValueAtHorizon: 1010000, valueAtHorizon: 1057435, errors: [], warnings: [] };
  const strat = { stocks: { startingValue: 10000, valueAtHorizon: 57000, flatValueAtHorizon: 10000, buyCash: 0, buyCashFromSells: 0, sellExternalOut: 0 }, mortgage: { interestSaved: 1000 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: 12, paymentDelta: -100, cost: 0, flatValueAtHorizon: 1010000, valueAtHorizon: 1057435, errors: [], warnings: [] };
  const c = compareProjections(base, strat);
  assert.equal(c.valueAtHorizon, 1010000);
  assert.equal(c.baselineValueAtHorizon, 1010000);
  const noFlat = compareProjections(
    { ...base, flatValueAtHorizon: undefined, valueAtHorizon: 1057435 },
    { ...strat, flatValueAtHorizon: undefined, valueAtHorizon: 1057435 },
  );
  assert.equal(noFlat.valueAtHorizon, 1057435);
});

test('compareProjections investmentScope valueAtHorizon excludes property equity (pool + flat stock only)', () => {
  const base = { stocks: { startingValue: 10000, valueAtHorizon: 57000, flatValueAtHorizon: 10000 }, mortgage: { interestSaved: 0 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: null, paymentDelta: null, flatValueAtHorizon: 1010000, valueAtHorizon: 1057435, errors: [], warnings: [] };
  const strat = { stocks: { startingValue: 10000, valueAtHorizon: 57000, flatValueAtHorizon: 10000, buyCash: 0, buyCashFromSells: 0, sellExternalOut: 0 }, mortgage: { interestSaved: 1000 }, fees: 0, penaltyTotal: 0, payoffShiftMonths: 12, paymentDelta: -100, cost: 0, flatValueAtHorizon: 1010000, valueAtHorizon: 1057435, errors: [], warnings: [] };
  const c = compareProjections(base, strat, { investmentScope: true });
  assert.equal(c.valueAtHorizon, 10000);
  assert.equal(c.baselineValueAtHorizon, 10000);
  // Default (no opt) keeps the property-inclusive flat figure.
  assert.equal(compareProjections(base, strat).valueAtHorizon, 1010000);
});

// ---- Report variables: penalty, default $0 ----

test('validateReportVariables accepts empty/null, rejects negative and non-numeric penalties', () => {
  assert.deepEqual(validateReportVariables(null), []);
  assert.deepEqual(validateReportVariables({}), []);
  assert.deepEqual(validateReportVariables({ penalty: { 7: 500 } }), []);
  assert.deepEqual(validateReportVariables({ penalty: { 7: 0 } }), []);
  assert.equal(validateReportVariables({ penalty: { 7: -5 } }).length, 1);
  assert.equal(validateReportVariables({ penalty: { 7: 'x' } }).length, 1);
  assert.equal(validateReportVariables({ penalty: [] }).length, 1);
  assert.equal(validateReportVariables([]).length, 1);
});

test('reportPenaltyFor defaults to 0 and ignores other strategies', () => {
  assert.equal(reportPenaltyFor(null, 7), 0);
  assert.equal(reportPenaltyFor({}, 7), 0);
  assert.equal(reportPenaltyFor({ penalty: { 7: 250 } }, 7), 250);
  assert.equal(reportPenaltyFor({ penalty: { 8: 250 } }, 7), 0);
  assert.equal(reportPenaltyFor({ penalty: { 7: -5 } }, 7), 0);
});

test('applyReportVariables: cost = engine cost − engine penalty + variable; net = gain − cost; gain untouched', () => {
  const comparison = { cost: 15000, gain: 20000, penaltyTotal: 14170.41 };
  const withVar = applyReportVariables(comparison, { penalty: { 7: 500 } }, 7);
  assert.equal(withVar.cost, 1329.59);
  assert.equal(withVar.net, 18670.41);
  assert.equal(withVar.gain, 20000);
  assert.equal(withVar.penalty, 500);
  // Default: penalty excluded entirely — cost drops by the estimate.
  const def = applyReportVariables(comparison, null, 7);
  assert.equal(def.cost, 829.59);
  assert.equal(def.net, 19170.41);
  assert.equal(def.penalty, 0);
  assert.equal(applyReportVariables(null, null, 7), null);
});

// ---- AI engine: definition validation + safe execution ----

test('validateAiEngine accepts empty/null, rejects unknown ids and identifiers', () => {
  assert.deepEqual(validateAiEngine(null), []);
  assert.deepEqual(validateAiEngine({}), []);
  assert.deepEqual(validateAiEngine({ series: { stock_value: 'stock_value * 1.1' }, scalars: { cost: 'cost + 100' } }), []);
  assert.equal(validateAiEngine({ series: { nope: '1' } }).length, 1);
  assert.equal(validateAiEngine({ scalars: { nope: '1' } }).length, 1);
  assert.equal(validateAiEngine({ series: { stock_value: 'stock_value + mystery' } }).length, 1);
  // A scalar formula may not reference a monthly series.
  assert.equal(validateAiEngine({ scalars: { cost: 'stock_value' } }).length, 1);
  // Inputs are valid identifiers for both maps.
  assert.deepEqual(validateAiEngine({ inputs: [{ key: 'bonus', label: 'Bonus', default: 50 }], scalars: { gain: 'gain + bonus' } }), []);
  assert.equal(validateAiEngine({ inputs: [{ key: 'bonus', label: 'Bonus', default: 50 }, { key: 'bonus', label: 'Dup', default: 1 }] }).length, 1);
  // monthly_net_cashflow is a base series (user 2026-11-06): an
  // engine formula may reference the preset series, and may override
  // it with a monthly formula of its own.
  assert.deepEqual(validateAiEngine({ series: { monthly_net_cashflow: 'monthly_net_cashflow' } }), []);
  assert.deepEqual(validateAiEngine({ series: { stock_value: 'stock_value + monthly_net_cashflow' } }), []);
});

test('evaluateAiEngine executes series element-wise and scalars, empty engine = preset figures', () => {
  const base = {
    monthly: [
      { mortgage_balance: 100000, stock_value: 10000, total_value: 110000, pool_balance: 0, interest: 400, principal: 600 },
      { mortgage_balance: 99000, stock_value: 11000, total_value: 110000, pool_balance: 0, interest: 390, principal: 610 },
    ],
    scalars: { cost: 1000, gain: 2000, net: 1000, interestSaved: 500, stockGain: 1500, valueAtHorizon: 110000, payoffShiftMonths: 12, paymentDelta: -50, fees: 0, penaltyTotal: 0 },
  };
  const empty = evaluateAiEngine({}, base);
  assert.deepEqual(empty.series, {});
  assert.deepEqual(empty.scalars, {});
  assert.deepEqual(empty.errors, []);
  const ev = evaluateAiEngine({ series: { stock_value: 'stock_value * 1.1' }, scalars: { cost: 'cost + 100', gain: 'max(gain, 0)' } }, base);
  assert.deepEqual(ev.errors, []);
  assert.deepEqual(ev.series.stock_value, [11000, 12100]);
  assert.equal(ev.scalars.cost, 1100);
  assert.equal(ev.scalars.gain, 2000);
  const withInput = evaluateAiEngine({ inputs: [{ key: 'bonus', label: 'Bonus', default: 50 }], scalars: { gain: 'gain + bonus' } }, base);
  assert.equal(withInput.scalars.gain, 2050);
  assert.equal(withInput.inputs.bonus, 50);
});

test('evaluateAiEngine rejects the whole engine on unknown identifier or division by zero', () => {
  const base = { monthly: [{ stock_value: 10000 }], scalars: { cost: 1000, gain: 2000 } };
  const badId = evaluateAiEngine({ scalars: { cost: 'cost + mystery' } }, base);
  assert.ok(badId.errors.length > 0);
  assert.deepEqual(badId.series, {});
  assert.deepEqual(badId.scalars, {});
  const divZero = evaluateAiEngine({ scalars: { cost: 'cost / 0' } }, base);
  assert.ok(divZero.errors.length > 0);
  assert.deepEqual(divZero.scalars, {});
});

// ---- AI refine diff ----

test('aiReportDefinitionDiff lists chart and engine changes by map', () => {
  const oldDef = {
    charts: [{ template: 'time_line', title: 'A', series: ['mortgage_balance'] }],
    engine: { series: { stock_value: 'stock_value' }, scalars: {}, inputs: [] },
  };
  const newDef = {
    charts: [
      { template: 'time_line', title: 'A', series: ['mortgage_balance', 'stock_value'] },
      { template: 'metric_cards', title: 'B', series: ['cost'] },
    ],
    engine: {
      series: { stock_value: 'stock_value * 1.1', mortgage_balance: 'mortgage_balance' },
      scalars: { cost: 'cost + 100' },
      inputs: [{ key: 'bonus', label: 'Bonus', default: 50 }],
    },
  };
  const d = aiReportDefinitionDiff(oldDef, newDef);
  assert.deepEqual(d.charts.added, ['B']);
  assert.deepEqual(d.charts.removed, []);
  assert.deepEqual(d.charts.changed, ['A']);
  assert.deepEqual(d.engine.series.added, ['mortgage_balance']);
  assert.deepEqual(d.engine.series.changed, ['stock_value']);
  assert.deepEqual(d.engine.scalars.added, ['cost']);
  assert.deepEqual(d.engine.inputs.added, ['bonus']);
  assert.equal(d.engine.changed, true);
  const same = aiReportDefinitionDiff(oldDef, oldDef);
  assert.equal(same.engine.changed, false);
  assert.deepEqual(same.charts.added, []);
});
