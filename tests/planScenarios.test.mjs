// Scenario restructure: scenario factors validate without a sink, the
// migration groups legacy strategy factors into default scenarios, and
// a scenario's factors drive a projection through the same mapping the
// old strategy factors used (factorsToAssumptions + prime steps).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProjection, validateScenarioFactors,
  groupStrategyFactorsForMigration, primeFactorToScenario, factorsToAssumptions,
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
const HOLD = (over = {}) => ({
  id: 7, accountId: 1, symbol: 'HOLD', label: 'Hold', currency: 'CAD',
  events: [{ date: '2026-11-01', type: 'position', units: 10 }],
  pricePoints: [{ date: '2026-11-15', price: 100 }],
  ...over,
});

test('validateScenarioFactors: world factors pass, a sink is rejected', () => {
  assert.deepEqual(validateScenarioFactors({
    prime: { points: [{ month: '2027-01', rate: 4.5 }] },
    stock: { valuePct: 8 },
    propertyGrowth: { valuePct: 5 },
    salaryGrowth: { valuePct: 3 },
    rentGrowth: { valuePct: 2 },
  }, '2026-11'), []);
  assert.ok(validateScenarioFactors({ sink: { kind: 'custom', name: 'GIC', expectedReturnPct: 6 } }, '2026-11')
    .some((e) => e.includes('sink belongs on the strategy')));
  assert.ok(validateScenarioFactors({ unknownKey: { valuePct: 1 } }, '2026-11')
    .some((e) => e.includes('unknown factor')));
  assert.ok(validateScenarioFactors({ prime: { points: [{ month: '2020-01', rate: 5 }] } }, '2026-11')
    .some((e) => e.includes('in the past')));
});

test('groupStrategyFactorsForMigration: one set yields exactly one Default scenario', () => {
  const groups = groupStrategyFactorsForMigration([
    { id: 1, factors: { prime: { points: [{ month: '2027-01', rate: 4.5 }] }, stock: { valuePct: 8 } } },
    // Same set, shuffled key order — must not split into two worlds.
    { id: 2, factors: { stock: { valuePct: 8 }, prime: { points: [{ month: '2027-01', rate: 4.5 }] } } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Default scenario');
  assert.deepEqual(groups[0].strategyIds, [1, 2]);
  assert.deepEqual(groups[0].factors, { prime: { points: [{ month: '2027-01', rate: 4.5 }] }, stock: { valuePct: 8 } });
});

test('groupStrategyFactorsForMigration: distinct sets yield numbered scenarios, sink-only yields none', () => {
  const groups = groupStrategyFactorsForMigration([
    { id: 1, factors: { prime: { points: [{ month: '2027-01', rate: 4.5 }] } } },
    { id: 2, factors: { stock: { valuePct: 10 } } },
    { id: 3, factors: { sink: { kind: 'custom', name: 'GIC', expectedReturnPct: 6 } } },
    { id: 4, factors: null },
    { id: 5, factors: '{}' },
    { id: 6, factors: '{not json' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, 'Default scenario');
  assert.deepEqual(groups[0].strategyIds, [1]);
  assert.equal(groups[1].name, 'Default scenario 2');
  assert.deepEqual(groups[1].strategyIds, [2]);
});

test('groupStrategyFactorsForMigration: a sink rides along but is stripped from the world', () => {
  const groups = groupStrategyFactorsForMigration([
    { id: 1, factors: { stock: { valuePct: 8 }, sink: { kind: 'stock', holdingId: 7, trendPct: 10 } } },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].factors, { stock: { valuePct: 8 } });
  assert.ok(!('sink' in groups[0].factors));
});

test('factorsToAssumptions + primeFactorToScenario map a scenario the way the engine reads it', () => {
  const factors = { prime: { points: [{ month: '2027-01', rate: 4.5 }] }, stock: { valuePct: 8 }, propertyGrowth: { valuePct: 5 } };
  assert.deepEqual(factorsToAssumptions(factors, {}), { stockReturnPct: 8, propertyGrowthPct: 5 });
  assert.deepEqual(primeFactorToScenario(factors), { name: 'Strategy prime', steps: [{ date: '2027-01-01', rate: 4.5 }] });
  assert.equal(primeFactorToScenario({}), null);
  assert.equal(primeFactorToScenario(null), null);
});

test('computeProjection: a scenario stock return drives the baseline exactly like the old factor did', () => {
  const scenarioFactors = { stock: { valuePct: 10 } };
  const args = ARGS({
    mainline: MAINLINE({ properties: [], holdings: [HOLD()] }),
    assumptions: factorsToAssumptions(scenarioFactors, {}),
    holdingGrowth: { 7: 5 },
  });
  const proj = computeProjection(args);
  assert.equal(proj.errors.length, 0);
  const expected = 10 * 100 * Math.pow(1.10, 30);
  assert.ok(Math.abs(proj.stocks.valueAtHorizon - expected) < 1, `scenario return wins: ${proj.stocks.valueAtHorizon}, expected ${expected}`);
});
