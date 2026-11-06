// Planning: penalty math, prime scenarios, op/leg validation, the
// projection's cost/gain/net accounting (measured against the baseline
// trajectory, never against today's value), historical return
// suggestions with honest windows, and merge/revert write building.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcPenalty, scenarioPrimeHistory,
  validateOp, validateLegs, computeProjection, compareProjections,
  returnSuggestionsFromPoints, buildMergeWrites, buildRevertInverse,
  resolveBuyLegs, reportMonthlySeries, reportCostBreakdown,
  planProjectTemplate, planProjectSections, planStrategyTemplateLabel,
  buildPlanAiSnapshot, normalizeAiAsk,
  expandScenarioPrimePreset, planProjectAiSummaries, aiRepairPrompt,
  validateAiReportChartSeries, aiReportPrompt, validateAiReportBaselineKind,
  aiSuggestNamePrompt, cleanAiSuggestedName,
  sanitizeAiThread, appendAiThread, renderAiThreadText,
  equityDeltaPeak, principalDeltaVsBaseline,
  principalGainSeries, validateAiBaseline, validateAiCreateProposal, paymentScopeFor,
  scopeMainlineToProperty, validatePoolItemShapes, poolExternalCash,
  primeFactorPresetPoints, validateStrategyFactors, primeFactorToScenario,
  validateScenarioFactors, droppedScenarioPrimeSteps, primeStepDroppedMessage,
  factorsToAssumptions, applyStoredCustomSinkRate,
} from '../src/planning.js';
import { derivePayment, primeHistoryResolver } from '../src/engine.js';

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

// ---------------------------------------------------------------- penalty
test('calcPenalty: fixed closed takes the greater of 3 months vs IRD', () => {
  // 3 months on $400,000 at 5% = $5,000. IRD at (5 − 3)% × $400,000 × 4y = $32,000.
  const r = calcPenalty({ balanceAtBreak: 400000, contractRatePct: 5, comparableRatePct: 3, remainingMonths: 48, kind: 'fixed_closed' });
  assert.equal(r.penalty, 32000);
  assert.equal(r.method, 'ird');
  assert.equal(r.estimate, true);
  // Comparable above contract: IRD floors at 0, 3 months wins.
  const r2 = calcPenalty({ balanceAtBreak: 400000, contractRatePct: 5, comparableRatePct: 6, remainingMonths: 48, kind: 'fixed_closed' });
  assert.equal(r2.penalty, 5000);
  assert.equal(r2.method, 'three_months_interest');
  // No comparable rate: IRD is not computed, 3 months stands.
  const r3 = calcPenalty({ balanceAtBreak: 400000, contractRatePct: 5, comparableRatePct: null, remainingMonths: 48, kind: 'fixed_closed' });
  assert.equal(r3.penalty, 5000);
  assert.equal(r3.ird, null);
});
test('calcPenalty: variable closed is 3 months interest, open is 0', () => {
  const v = calcPenalty({ balanceAtBreak: 400000, contractRatePct: 5, comparableRatePct: 3, remainingMonths: 48, kind: 'variable_closed' });
  assert.equal(v.penalty, 5000);
  const o = calcPenalty({ balanceAtBreak: 400000, contractRatePct: 5, comparableRatePct: 3, remainingMonths: 48, kind: 'open' });
  assert.equal(o.penalty, 0);
});

// ------------------------------------------------------------- prime factors
test('primeFactorPresetPoints: pessimistic rises 2.0 over 2 years, flat is empty', () => {
  const steps = primeFactorPresetPoints('pessimistic', 4.70, '2026-11');
  assert.equal(steps.length, 4);
  assert.equal(steps[steps.length - 1].month, '2028-11');
  assert.equal(steps[steps.length - 1].rate, 6.70);
  assert.deepEqual(primeFactorPresetPoints('flat', 4.70, '2026-11'), []);
  assert.deepEqual(primeFactorPresetPoints('optimistic', null, '2026-11'), []);
});
test('scenarioPrimeHistory: only steps after the last actual observation survive', () => {
  const actual = [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-04', rate: 4.70 }];
  const out = scenarioPrimeHistory(actual, { steps: [{ date: '2026-10-01', rate: 4.00 }, { date: '2027-06-01', rate: 6.00 }] });
  assert.ok(out.every((o) => o.date >= '2026-10-28'));
  assert.equal(out[out.length - 1].rate, 6.00);
  assert.equal(out.filter((o) => o.date === '2026-10-01').length, 0);
});
test('scenarioPrimeHistory: a current-month step applies even when a later-in-month actual observation exists (user repro)', () => {
  // Prime rise: step 2026-11-01 @ 5.45%, latest Valet observation
  // 2026-11-04 @ 4.70%. The exact-date drop rule silently discarded
  // the step, so projections priced everything at prime 4.70% flat.
  const actual = [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-04', rate: 4.70 }];
  const scenario = { steps: [{ date: '2026-11-01', rate: 5.45 }] };
  const out = scenarioPrimeHistory(actual, scenario, '2026-11');
  assert.deepEqual(out, [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-01', rate: 5.45 }]);
  // The step supersedes the same-month actual observation: the
  // month-end rule and daily accrual would otherwise let the later
  // actual win the month back.
  const primeForMonth = primeHistoryResolver(out, null);
  assert.equal(primeForMonth('2026-10'), 4.45);
  assert.equal(primeForMonth('2026-11'), 5.45);
  assert.equal(primeForMonth('2027-01'), 5.45);
  // No clock passed: falls back to the last actual observation's month.
  assert.deepEqual(scenarioPrimeHistory(actual, scenario), out);
});
test('droppedScenarioPrimeSteps: a past-month step is dropped and named, a current-month step is not', () => {
  const actual = [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-04', rate: 4.70 }];
  const dropped = droppedScenarioPrimeSteps(actual, { steps: [{ date: '2026-09-01', rate: 5.00 }, { date: '2026-11-01', rate: 5.45 }] }, '2026-11');
  assert.deepEqual(dropped.map((d) => d.date), ['2026-09-01']);
  assert.equal(dropped[0].rate, 5.00);
  assert.equal(dropped[0].lastActual, '2026-11-04');
  assert.equal(primeStepDroppedMessage(dropped[0]), 'Prime step 2026-09-01 → 5% ignored: dated in a past month (last actual prime observation 2026-11-04).');
  assert.deepEqual(droppedScenarioPrimeSteps(actual, { steps: [{ date: '2026-11-01', rate: 5.45 }] }, '2026-11'), []);
  assert.deepEqual(droppedScenarioPrimeSteps(actual, null, '2026-11'), []);
});
test('validateStrategyFactors: shape errors for points and percents; a sink is rejected outright', () => {
  assert.deepEqual(validateStrategyFactors(null), []);
  assert.deepEqual(validateStrategyFactors({ prime: { points: [{ month: '2027-06', rate: 5.5 }] } }, '2026-11'), []);
  assert.ok(validateStrategyFactors({ prime: { points: [{ month: '2026-10', rate: 5.5 }] } }, '2026-11').some((e) => /past/.test(e)));
  assert.ok(validateStrategyFactors({ prime: { points: [{ month: '2027-06', rate: 5.5 }, { month: '2027-06', rate: 6 }] } }, '2026-11').some((e) => /increasing/.test(e)));
  assert.ok(validateStrategyFactors({ nope: 1 }).some((e) => /unknown factor/.test(e)));
  assert.ok(validateStrategyFactors({ stock: { valuePct: 'x' } }).length > 0);
  // The sink is gone (user 2026-11-05): any factors object carrying
  // one is rejected outright — a stale client or proposal must not
  // silently store it. The buy list IS the sink now.
  assert.ok(validateStrategyFactors({ sink: { kind: 'stock', holdingId: 1, trendPct: 10 } }).some((e) => /no longer supported/.test(e)));
  assert.ok(validateStrategyFactors({ sink: { kind: 'custom', name: 'GIC', expectedReturnPct: 4 } }).some((e) => /no longer supported/.test(e)));
  assert.ok(validateStrategyFactors({ sink: { kind: 'stock', symbol: 'AMZN', trendPct: 12 } }).some((e) => /no longer supported/.test(e)));
  assert.deepEqual(primeFactorToScenario({ prime: { points: [{ month: '2027-06', rate: 5.5 }] } }), { name: 'Strategy prime', steps: [{ date: '2027-06-01', rate: 5.5 }] });
  assert.equal(primeFactorToScenario({}), null);
  assert.deepEqual(factorsToAssumptions({ stock: { valuePct: 6 } }, { stockReturnPct: 3, comparableRate: 4 }), { stockReturnPct: 6, comparableRate: 4 });
  assert.deepEqual(factorsToAssumptions({}, { stockReturnPct: 3 }), { stockReturnPct: 3 });
  // Disabled factors (enabled === false — unchecked in the editor,
  // values kept in data) contribute nothing: the dimension follows
  // the default world exactly as if the factor were absent. Missing
  // `enabled` still means enabled (migration: stored factors start
  // checked).
  assert.equal(primeFactorToScenario({ prime: { points: [{ month: '2027-06', rate: 5.5 }], enabled: false } }), null);
  assert.deepEqual(primeFactorToScenario({ prime: { points: [{ month: '2027-06', rate: 5.5 }], enabled: true } }), { name: 'Strategy prime', steps: [{ date: '2027-06-01', rate: 5.5 }] });
  assert.deepEqual(factorsToAssumptions({ stock: { valuePct: 6, byHolding: { 7: { valuePct: 9 } }, enabled: false }, propertyGrowth: { valuePct: 2, enabled: false } }, { stockReturnPct: 3 }), { stockReturnPct: 3 });
  assert.deepEqual(factorsToAssumptions({ stock: { valuePct: 6, byHolding: { 7: { valuePct: 9 } }, enabled: true }, propertyGrowth: { valuePct: 2 } }, { stockReturnPct: 3 }), { stockReturnPct: 6, stockReturnByHolding: { 7: 9 }, propertyGrowthPct: 2 });
  assert.deepEqual(validateScenarioFactors({ prime: { points: [{ month: '2027-06', rate: 5.5 }], enabled: false } }), []);
});

// ------------------------------------------------------------- validation
test('validateOp: rate_switch amortization override is fixed-only, 1..35 years', () => {
  const ctx = { currentMonth: '2026-11' };
  assert.deepEqual(validateOp({ op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'fixed', annualRate: 4.5 } }, ctx), []);
  assert.deepEqual(validateOp({ op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'fixed', annualRate: 4.5, amortizationYears: 10 } }, ctx), []);
  assert.ok(validateOp({ op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'fixed', annualRate: 4.5, amortizationYears: 0 } }, ctx).some((e) => /amortization/.test(e)));
  assert.ok(validateOp({ op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'fixed', annualRate: 4.5, amortizationYears: 36 } }, ctx).some((e) => /amortization/.test(e)));
  assert.ok(validateOp({ op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'variable', spread: -1, amortizationYears: 10 } }, ctx).some((e) => /fixed switches only/.test(e)));
});

// ------------------------------------------------------- switch-to-fixed
// Fixture: term start 2026-01, 25y amortization, fixed 5%, $500,000
// anchor at the term start, current month 2026-11.
const switchRow = (proj, month) => proj.mortgage.perProperty[1].strategy.series.find((r) => r.month === month);
const baseRow = (proj, month) => proj.mortgage.perProperty[1].baseline.series.find((r) => r.month === month);
test('computeProjection: fixed switch (default) re-derives over the term remaining amortization', () => {
  const base = computeProjection(ARGS());
  const strat = computeProjection(ARGS({
    ops: [{ seq: 1, op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'fixed', annualRate: 4.0, openClosed: 'open' } }],
  }));
  assert.deepEqual(strat.errors, []);
  // Switch state point 2026-11, term start 2026-01: 300 - 10 = 290
  // months of amortization remain; the December payment amortizes
  // the November balance over exactly that.
  const nov = baseRow(base, '2026-11');
  const dec = switchRow(strat, '2026-12');
  assert.equal(dec.rate, 4.0);
  assert.ok(Math.abs(dec.payment - derivePayment(nov.balance, 4.0, 290 / 12, 'semi_annual')) < 0.02, dec.payment);
  assert.equal(strat.mortgage.perProperty[1].strategy.paymentAtEffect, dec.payment);
  // A pure switch does not move the payoff date.
  assert.equal(strat.mortgage.perProperty[1].strategy.payoffMonth, base.mortgage.perProperty[1].baseline.payoffMonth);
});
test('computeProjection: fixed switch with an amortization override re-amortizes over X years', () => {
  const strat = computeProjection(ARGS({
    ops: [{ seq: 1, op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'fixed', annualRate: 4.0, amortizationYears: 10, openClosed: 'open' } }],
  }));
  assert.deepEqual(strat.errors, []);
  const base = computeProjection(ARGS());
  const nov = baseRow(base, '2026-11');
  const dec = switchRow(strat, '2026-12');
  assert.ok(Math.abs(dec.payment - derivePayment(nov.balance, 4.0, 10, 'semi_annual')) < 0.02, dec.payment);
  // Payoff moves to the switch + X years (plus the engine's usual
  // final-payment rounding month).
  const pay = strat.mortgage.perProperty[1].strategy.payoffMonth;
  assert.ok(pay === '2036-12' || pay === '2037-01', pay);
});
test('computeProjection: variable switch keeps the payment', () => {
  const base = computeProjection(ARGS());
  const strat = computeProjection(ARGS({
    ops: [{ seq: 1, op_type: 'rate_switch', params: { propertyId: 1, date: '2026-12-01', rateType: 'variable', spread: -1.0, openClosed: 'open' } }],
  }));
  assert.deepEqual(strat.errors, []);
  const dec = switchRow(strat, '2026-12');
  assert.equal(dec.rate, 3.7);
  assert.equal(dec.payment, baseRow(base, '2026-12').payment);
  assert.equal(strat.mortgage.perProperty[1].strategy.paymentAtEffect, base.mortgage.perProperty[1].baseline.paymentAtEffect);
});
test('computeProjection: current-month prime step prices the baseline variable rate (user repro)', () => {
  // Prime rise: step 2026-11-01 @ 5.45% against a latest actual
  // observation of 2026-11-04 @ 4.70%. Before the fix the step was
  // dropped and the Jan 2027 baseline priced at prime 4.70% − 1.00 =
  // 3.70%; after it, at 5.45% − 1.00 = 4.45%. The interest figure is
  // what the user sees, so assert it from the December balance the
  // engine itself produced (daily accrual: 31 December days).
  const varProp = () => ({
    ...PROP(),
    segments: [{ id: 1, property_id: 1, start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', annual_rate: null, spread: -1.0, compounding: 'monthly', accrual: 'daily' }],
  });
  const proj = computeProjection(ARGS({
    mainline: MAINLINE({ properties: [varProp()] }),
    primeHistory: [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-04', rate: 4.70 }],
    scenario: { steps: [{ date: '2026-11-01', rate: 5.45 }] },
    currentPrime: 4.70, currentMonth: '2026-11',
  }));
  assert.deepEqual(proj.errors, []);
  assert.deepEqual(proj.warnings, []);
  const rows = proj.mortgage.perProperty[1].baseline.series;
  const dec = rows.find((r) => r.month === '2026-12');
  const jan = rows.find((r) => r.month === '2027-01');
  assert.equal(jan.rate, 4.45);
  const expected = Math.round(dec.balance * 0.0445 * 31 / 365 * 100) / 100;
  assert.ok(Math.abs(jan.interest - expected) < 0.05, `Jan interest ${jan.interest} vs ${expected} on Dec balance ${dec.balance}`);
  // The dropped-step warning rides the projection when a step IS past.
  const past = computeProjection(ARGS({
    mainline: MAINLINE({ properties: [varProp()] }),
    primeHistory: [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-04', rate: 4.70 }],
    scenario: { steps: [{ date: '2026-09-01', rate: 5.00 }] },
    currentPrime: 4.70, currentMonth: '2026-11',
  }));
  assert.deepEqual(past.errors, []);
  assert.equal(past.warnings.length, 1);
  assert.equal(past.warnings[0], 'Prime step 2026-09-01 → 5% ignored: dated in a past month (last actual prime observation 2026-11-04).');
});
test('computeProjection: refinance amortizationYears drives the payment derivation', () => {
  const refi = (years) => computeProjection(ARGS({
    ops: [{ seq: 1, op_type: 'refinance', params: { propertyId: 1, date: '2026-12-01', termMonths: 60, amortizationYears: years, rateType: 'fixed', annualRate: 4.0, openClosed: 'open' } }],
  }));
  const r20 = refi(20);
  const r25 = refi(25);
  assert.deepEqual(r20.errors, []);
  assert.deepEqual(r25.errors, []);
  const base = computeProjection(ARGS());
  const nov = baseRow(base, '2026-11');
  // The new term's start derivation prices the November balance
  // over the refinance amortization.
  assert.ok(Math.abs(switchRow(r20, '2026-12').payment - derivePayment(nov.balance, 4.0, 20, 'semi_annual')) < 0.02, switchRow(r20, '2026-12').payment);
  assert.ok(Math.abs(switchRow(r25, '2026-12').payment - derivePayment(nov.balance, 4.0, 25, 'semi_annual')) < 0.02, switchRow(r25, '2026-12').payment);
  assert.ok(switchRow(r20, '2026-12').payment > switchRow(r25, '2026-12').payment);
});
test('buildMergeWrites: fixed switch with an amortization override inserts a split term', () => {
  const snapshot = {
    properties: [{ id: 1 }], mortgage_terms: [{ id: 1, property_id: 1, start_date: '2026-01-01', term_months: 60, amortization_years: 25, repayment_method: 'equal_payment' }],
    rate_segments: [{ id: 1, property_id: 1, start_date: '2026-01-01', rate_type: 'fixed' }],
    lump_sums: [], invest_accounts: [], invest_holdings: [], invest_events: [],
  };
  const current = JSON.parse(JSON.stringify(snapshot));
  const ops = [
    { seq: 1, op_type: 'rate_switch', params: { propertyId: 1, date: '2027-01-01', rateType: 'fixed', annualRate: 4.0, amortizationYears: 10 } },
  ];
  const { writes, conflicts } = buildMergeWrites({ ops, legs: [], snapshot, current, projection: { switchBalance: { 1: 480000 } } });
  const term = writes.find((w) => w.kind === 'insert' && w.table === 'mortgage_terms');
  assert.ok(term, 'split term inserted');
  assert.equal(term.values.start_date, '2027-01-01');
  assert.equal(term.values.amortization_years, 10);
  assert.equal(term.values.opening_balance, 480000);
  // Contract term continues: governing term ends 2026-01 + 60 =
  // 2031-01, so the split term carries 48 months.
  assert.equal(term.values.term_months, 48);
  assert.equal(term.values.payment_override, null);
  assert.ok(writes.some((w) => w.kind === 'insert' && w.table === 'rate_segments'));
  assert.deepEqual(conflicts, []);
  // Without an override no term is split: segment-only merge.
  const plain = buildMergeWrites({ ops: [{ seq: 1, op_type: 'rate_switch', params: { propertyId: 1, date: '2027-01-01', rateType: 'fixed', annualRate: 4.0 } }], legs: [], snapshot, current, projection: {} });
  assert.ok(!plain.writes.some((w) => w.table === 'mortgage_terms'));
});
test('validateOp: shape errors, past dates, sell guards, position price ban', () => {
  assert.ok(validateOp({ op_type: 'buy', params: { accountId: 1, date: '2026-12-01' } }, { currentMonth: '2026-11' }).length > 0);
  assert.ok(validateOp({ op_type: 'prepay', params: { propertyId: 1, date: '2026-10-01', amount: 1000 } }, { currentMonth: '2026-11' }).some((e) => /before the current month/.test(e)));
  assert.ok(validateOp({ op_type: 'sell', params: { holdingId: 1, date: '2026-12-01', units: 50 } }, { currentMonth: '2026-11', unitsAvailable: 40 }).some((e) => /only 40 held/.test(e)));
  assert.ok(validateOp({ op_type: 'position', params: { accountId: 1, date: '2026-12-01', units: 10, price: 5 } }, { currentMonth: '2026-11' }).some((e) => /no price/.test(e)));
  assert.deepEqual(validateOp({ op_type: 'prepay', params: { propertyId: 1, date: '2026-12-01', amount: 1000 } }, { currentMonth: '2026-11' }), []);
});
test('validateLegs: funding cycles are rejected', () => {
  const ops = [
    { seq: 1, op_type: 'sell', params: {} },
    { seq: 2, op_type: 'buy', params: {} },
  ];
  const legs = [
    { op_seq: 2, source_ref: 'op:1', amount: 'all' },
    { op_seq: 1, source_ref: 'op:2', amount: 'all' },
  ];
  assert.ok(validateLegs(ops, legs).some((e) => /cycle/.test(e)));
  assert.deepEqual(validateLegs(ops, [{ op_seq: 2, source_ref: 'op:1', amount: 'all' }]), []);
});

// ------------------------------------------------------------- projection
test('computeProjection: open-plan prepay costs exactly the prepay and saves interest', () => {
  const base = computeProjection(ARGS());
  const strat = computeProjection(ARGS({
    ops: [{ seq: 1, op_type: 'prepay', params: { propertyId: 1, date: '2026-12-01', amount: 100000, openClosed: 'open' } }],
  }));
  assert.deepEqual(strat.errors, []);
  assert.equal(strat.cost, 100000);
  assert.equal(strat.penaltyTotal, 0);
  assert.ok(strat.mortgage.interestSaved > 0);
  assert.ok(strat.payoffShiftMonths > 0);
  const cmp = compareProjections(base, strat);
  assert.equal(cmp.cost, 100000);
  assert.equal(cmp.gain, cmp.interestSaved);
  assert.equal(cmp.net, cmp.gain - cmp.cost);
});
test('computeProjection: a do-nothing strategy books no gain, even with growth', () => {
  const holding = {
    id: 1, accountId: 1, symbol: 'XQQ.TO', currency: 'CAD',
    events: [{ date: '2025-01-15', type: 'buy', units: 100, price: 50 }],
    pricePoints: [{ date: '2026-10-31', price: 60 }],
  };
  const args = ARGS({ mainline: MAINLINE({ holdings: [holding] }), assumptions: { stockReturnPct: '10' } });
  const base = computeProjection(args);
  const strat = computeProjection({ ...args, ops: [] });
  const cmp = compareProjections(base, strat);
  assert.equal(cmp.net, 0);
  assert.equal(cmp.gain, 0);
  assert.equal(cmp.cost, 0);
});
test('computeProjection: buy with a cash leg books buy cash; sell repay cuts interest', () => {
  const holding = {
    id: 1, accountId: 1, symbol: 'XQQ.TO', currency: 'CAD',
    events: [{ date: '2025-01-15', type: 'buy', units: 100, price: 50 }],
    pricePoints: [{ date: '2026-10-31', price: 60 }],
  };
  const ml = MAINLINE({ holdings: [holding] });
  const buy = computeProjection(ARGS({
    mainline: ml,
    ops: [{ seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'XQQ.TO', date: '2026-12-01', units: 10, price: 60 } }],
    legs: [{ op_seq: 1, source_ref: 'cash', amount: 'remainder' }],
  }));
  assert.deepEqual(buy.errors, []);
  assert.equal(buy.stocks.buyCash, 600);
  assert.equal(buy.cost, 600);
  const sell = computeProjection(ARGS({
    mainline: MAINLINE({ holdings: [holding] }),
    ops: [{ seq: 1, op_type: 'sell', params: { holdingId: 1, date: '2026-12-01', units: 10, price: 60 } }],
    legs: [{ op_seq: 1, source_ref: 'repay:1', amount: 'all' }],
  }));
  assert.deepEqual(sell.errors, []);
  assert.ok(sell.mortgage.interestSaved > 0);
});
test('computeProjection: closed-plan prepay above privilege pays a penalty', () => {
  const strat = computeProjection(ARGS({
    ops: [{ seq: 1, op_type: 'prepay', params: { propertyId: 1, date: '2026-12-01', amount: 100000, openClosed: 'closed' } }],
    assumptions: { privilegePct: '10', comparableRate: '4' },
  }));
  assert.deepEqual(strat.errors, []);
  // Privilege 10% of the $500,000 opening = $50,000; $50,000 penalized.
  assert.ok(strat.penaltyTotal > 0);
  assert.equal(strat.penalties.length, 1);
  assert.equal(strat.penalties[0].estimate, true);
});

// ------------------------------------------------------- return suggestions
test('returnSuggestionsFromPoints: windows label their actual coverage', () => {
  const pts = [
    { date: '2021-10-15', price: 40 },
    { date: '2023-10-15', price: 50 },
    { date: '2025-10-15', price: 55 },
    { date: '2026-10-15', price: 60 },
  ];
  const out = returnSuggestionsFromPoints(pts, '2026-11');
  const byLabel = Object.fromEntries(out.map((x) => [x.label, x]));
  assert.equal(byLabel['1y'].window, '2025-10 → 2026-10');
  assert.equal(byLabel['3y'].window, '2023-10 → 2026-10');
  assert.equal(byLabel['5y'].window, '2021-10 → 2026-10');
  assert.ok(byLabel['1y'].annualizedReturn > 0);
  // A short history never claims a 3y/5y window.
  const short = returnSuggestionsFromPoints([{ date: '2026-03-01', price: 50 }, { date: '2026-10-15', price: 60 }], '2026-11');
  assert.ok(!short.some((x) => x.label === '3y' || x.label === '5y' || x.label === '1y'));
  assert.ok(short.some((x) => /since first price/.test(x.label)));
  assert.equal(short.find((x) => /since first price/.test(x.label)).annualizedReturn, null);
});

// ------------------------------------------------------------- leg solving
test('resolveBuyLegs: pot caps, declared maturity gates, remainder fills', () => {
  const base = { pot: 1000, opOutputs: new Map(), declaredAssets: [{ id: 1, name: 'GIC', amount: 5000, maturity_date: '2027-06-01' }], opDate: '2026-12-01', holdingCurrency: 'CAD', fxRate: 1 };
  const over = resolveBuyLegs([{ source_ref: 'pot', amount: 2000 }], 2000, base);
  assert.ok(/only 1000/.test(over.error));
  const immature = resolveBuyLegs([{ source_ref: 'declared:1', amount: 'all' }], 5000, base);
  assert.ok(/matures/.test(immature.error));
  const ok = resolveBuyLegs([{ source_ref: 'pot', amount: 400 }, { source_ref: 'cash', amount: 'remainder' }], 1500, base);
  assert.equal(ok.pot, 600);
  assert.equal(ok.fromCashNative, 1100);
  // 'external' is genuinely new money, not pool money: it never
  // reports as a cash take.
  const ext = resolveBuyLegs([{ source_ref: 'external', amount: 'remainder' }], 1500, base);
  assert.equal(ext.fromCashNative, 0);
  assert.equal(ext.pot, 1000);
});

// ---------------------------------------------- pool-funded buys (user bug)
// A buy on a cash-pool project is funded BY the pool: a 'cash' leg
// sells pool holdings (pro-rata by value at the buy month), so the
// strategy does not keep both the pool and the purchase. Before the
// fix the 'cash' leg was unlimited external money: XQQ.TO was never
// sold and Value Δ sat flat at +$49,672 (Buy SPY).
const poolXqq = () => ({
  id: 1, accountId: 1, symbol: 'XQQ.TO', label: 'XQQ', currency: 'CAD',
  events: [{ date: '2025-01-15', type: 'buy', units: 100, price: 10 }],
  pricePoints: [{ date: '2026-10-15', price: 10 }],
});
const poolBuyArgs = (over = {}) => ARGS({
  mainline: MAINLINE({ holdings: [poolXqq()] }),
  holdingGrowth: { 1: 12 },
  ops: [{ seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'AMZN', date: '2026-11-01', amount: 500, price: 100 } }],
  legs: [{ op_seq: 1, source_ref: 'cash', amount: 'remainder' }],
  poolHoldingIds: [1],
  ...over,
});
const poolSeriesAt = (proj, month) => proj.stocks.series.find((r) => r.month === month).value;
test('computeProjection: pool-funded buy sells the pool — swap nets to zero at the buy month, then Value Δ declines', () => {
  const baseline = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [poolXqq()] }), holdingGrowth: { 1: 12 } }));
  const strat = computeProjection(poolBuyArgs());
  // The buy month: sold $500 of XQQ (growing) for $500 of AMZN (flat)
  // — the totals agree to the cent.
  assert.ok(Math.abs(poolSeriesAt(strat, '2026-11') - poolSeriesAt(baseline, '2026-11')) < 1);
  // A year on, the sold XQQ would have grown 12% and AMZN stayed
  // flat, so the strategy trails the baseline by ~$60 and falling.
  const d0 = poolSeriesAt(strat, '2026-11') - poolSeriesAt(baseline, '2026-11');
  const d12 = poolSeriesAt(strat, '2027-11') - poolSeriesAt(baseline, '2027-11');
  assert.ok(d12 < d0 && d12 < -50 && d12 > -70, `Δ went ${d0} → ${d12}`);
  // The take is sell-funded (a swap): no new cash out, no
  // opportunity cost on it.
  assert.equal(strat.stocks.buyCash, 500);
  assert.equal(strat.stocks.buyCashFromSells, 500);
  assert.deepEqual(strat.errors, []);
});
test('computeProjection: pool-funded buy of the whole flat pool leaves AMZN only — no double count', () => {
  const baseline = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [poolXqq()] }) }));
  const strat = computeProjection(poolBuyArgs({
    holdingGrowth: null,
    ops: [{ seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'AMZN', date: '2026-11-01', amount: 1000, price: 100 } }],
  }));
  assert.equal(poolSeriesAt(strat, '2026-11'), 1000);
  assert.equal(poolSeriesAt(strat, '2029-11'), 1000);
  assert.equal(poolSeriesAt(strat, '2026-11'), poolSeriesAt(baseline, '2026-11'));
});
test('computeProjection: without a pool, a cash leg stays external cash (double count preserved)', () => {
  const strat = computeProjection(poolBuyArgs({ poolHoldingIds: null }));
  assert.ok(Math.abs(poolSeriesAt(strat, '2026-11') - 1509.49) < 1);
  assert.equal(strat.stocks.buyCashFromSells, 0);
});
test('computeProjection: pool-funded buy the pool cannot cover errors and is skipped', () => {
  const strat = computeProjection(poolBuyArgs({
    holdingGrowth: null,
    ops: [{ seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'AMZN', date: '2026-11-01', amount: 2000, price: 100 } }],
  }));
  assert.ok(strat.errors.some((e) => /pool holds only \$1000\.00/.test(e)), JSON.stringify(strat.errors));
  const baseline = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [poolXqq()] }) }));
  assert.equal(poolSeriesAt(strat, '2026-11'), poolSeriesAt(baseline, '2026-11'));
});
test('computeProjection: a buy with no stored legs defaults to the implicit cash leg (GIC report bug)', () => {
  // The GIC buy was created by a path that stores no legs (AI / old
  // sink): the projection flagged the whole purchase unfunded and
  // skipped it, even though the buy row reads "Sell from pool". A
  // legless buy now takes the same implicit {cash, remainder} leg
  // the op form attaches at save — it executes, funded by the pool.
  const strat = computeProjection(poolBuyArgs({ legs: [] }));
  assert.deepEqual(strat.errors, []);
  assert.equal(strat.stocks.buyCash, 500);
  assert.equal(strat.stocks.buyCashFromSells, 500);
  const baseline = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [poolXqq()] }), holdingGrowth: { 1: 12 } }));
  const d12 = poolSeriesAt(strat, '2027-11') - poolSeriesAt(baseline, '2027-11');
  assert.ok(d12 < -50 && d12 > -70, `Δ went to ${d12}`);
});
test('computeProjection: a legless custom-product (GIC-style) buy executes from the pool', () => {
  // accountId null + a rate on the op (a GIC): no stored legs, no
  // price history — the buy still executes, pool-funded, growing at
  // its own rate from the buy price.
  const strat = computeProjection(poolBuyArgs({
    legs: [],
    ops: [{ seq: 1, op_type: 'buy', params: { accountId: null, symbol: 'GIC 4.6%', date: '2026-11-01', amount: 500, price: 100, expectedReturnPct: 4.6 } }],
  }));
  assert.deepEqual(strat.errors, []);
  assert.equal(strat.stocks.buyCash, 500);
  assert.equal(strat.stocks.buyCashFromSells, 500);
  // A year on the GIC (4.6%) trails the sold XQQ (12%) — the swap
  // is visible in the trajectory, not silently flat.
  const baseline = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [poolXqq()] }), holdingGrowth: { 1: 12 } }));
  assert.ok(poolSeriesAt(strat, '2027-11') < poolSeriesAt(baseline, '2027-11'));
});
test('computeProjection: without a pool, a legless buy still funds from external cash', () => {
  const strat = computeProjection(poolBuyArgs({ poolHoldingIds: null, legs: [] }));
  assert.deepEqual(strat.errors, []);
  assert.ok(Math.abs(poolSeriesAt(strat, '2026-11') - 1509.49) < 1);
  assert.equal(strat.stocks.buyCashFromSells, 0);
});

// ------------------------------------------------------- merge-write build
test('buildMergeWrites: prepay inserts, switch replaces later segments, conflicts surface', () => {
  const snapshot = {
    properties: [{ id: 1 }], mortgage_terms: [{ id: 1, property_id: 1, start_date: '2026-01-01', payment_override: null }],
    rate_segments: [{ id: 1, property_id: 1, start_date: '2026-01-01', rate_type: 'fixed' }],
    lump_sums: [], invest_accounts: [], invest_holdings: [], invest_events: [],
  };
  const current = JSON.parse(JSON.stringify(snapshot));
  current.rate_segments.push({ id: 2, property_id: 1, start_date: '2027-06-01', rate_type: 'fixed' });
  const ops = [
    { seq: 1, op_type: 'prepay', params: { propertyId: 1, date: '2026-12-01', amount: 5000 } },
    { seq: 2, op_type: 'rate_switch', params: { propertyId: 1, date: '2027-01-01', rateType: 'fixed', annualRate: 4.0 } },
  ];
  const { writes, conflicts } = buildMergeWrites({ ops, legs: [], snapshot, current, projection: {} });
  assert.ok(writes.some((w) => w.kind === 'insert' && w.table === 'lump_sums'));
  assert.ok(writes.some((w) => w.kind === 'delete' && w.table === 'rate_segments' && w.rowId === 2));
  assert.ok(writes.some((w) => w.kind === 'insert' && w.table === 'rate_segments'));
  assert.deepEqual(conflicts, []);
  // Mainline changed the term's override since the snapshot: conflict.
  const changed = JSON.parse(JSON.stringify(current));
  changed.mortgage_terms[0].payment_override = 3000;
  const ops2 = [{ seq: 1, op_type: 'payment_change', params: { propertyId: 1, date: '2026-12-01', payment: 2500 } }];
  const r2 = buildMergeWrites({ ops: ops2, legs: [], snapshot, current: changed, projection: {} });
  assert.ok(r2.conflicts.some((c) => c.table === 'mortgage_terms' && c.field === 'payment_override' && c.base === null && c.current === 3000 && c.incoming === 2500));
});
test('buildRevertInverse: inserts delete, updates restore, deleted segments clash', () => {
  const entries = [
    { kind: 'insert', table: 'lump_sums', rowId: 9, after: { amount: 5000 }, values: { amount: 5000 } },
    { kind: 'update', table: 'mortgage_terms', rowId: 1, before: { payment_override: null }, after: { payment_override: 2500 } },
    { kind: 'delete', table: 'rate_segments', rowId: 2, before: { id: 2, property_id: 1, start_date: '2027-06-01' } },
  ];
  const cur = { lump_sums: [{ id: 9, amount: 5000 }], mortgage_terms: [{ id: 1, payment_override: 2500 }], rate_segments: [] };
  const { inverse, conflicts } = buildRevertInverse({ entries, current: cur });
  assert.deepEqual(conflicts, []);
  assert.ok(inverse.some((x) => x.kind === 'delete' && x.table === 'lump_sums' && x.rowId === 9));
  assert.ok(inverse.some((x) => x.kind === 'update' && x.table === 'mortgage_terms' && x.values.payment_override === null));
  assert.ok(inverse.some((x) => x.kind === 'insert' && x.table === 'rate_segments'));
  // A newer segment on the same day blocks the restore.
  const clash = buildRevertInverse({ entries, current: { ...cur, rate_segments: [{ id: 5, property_id: 1, start_date: '2027-06-01' }] } });
  assert.ok(clash.conflicts.some((c) => c.table === 'rate_segments' && c.field === 'start_date'));
  // A modified insert blocks with a conflict instead of deleting.
  const mod = buildRevertInverse({ entries, current: { ...cur, lump_sums: [{ id: 9, amount: 6000 }] } });
  assert.ok(mod.conflicts.some((c) => c.table === 'lump_sums'));
});

test('reportMonthlySeries: balances sum across properties, total = assessed - balance + stock', () => {
  const perProperty = {
    1: { baseline: { series: [{ month: '2026-11', balance: 100000, interest: 400 }, { month: '2026-12', balance: 99000, interest: 395 }] } },
    2: { baseline: { series: [{ month: '2026-11', balance: 50000, interest: 200 }, { month: '2026-12', balance: 49500, interest: 198 }] } },
  };
  const stock = [{ month: '2026-11', value: 10000 }, { month: '2026-12', value: 11000 }];
  const rows = reportMonthlySeries(perProperty, 'baseline', stock, 500000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mortgage_balance, 150000);
  assert.equal(rows[0].stock_value, 10000);
  assert.equal(rows[0].total_value, 360000);
  assert.equal(rows[0].interest, 600);
  assert.equal(rows[1].total_value, 362500);
  // Missing side yields zero balances, stock months still present.
  const empty = reportMonthlySeries(perProperty, 'strategy', stock, 500000);
  assert.equal(empty[0].mortgage_balance, 0);
  assert.equal(empty[0].total_value, 510000);
});

test('reportMonthlySeries: scheduled principal sums across properties, 0 on stock-only months', () => {
  const perProperty = {
    1: { baseline: { series: [{ month: '2026-11', balance: 100000, interest: 400, principal: 600 }, { month: '2026-12', balance: 99000, interest: 395, principal: 605 }] } },
    2: { baseline: { series: [{ month: '2026-11', balance: 50000, interest: 200, principal: 300 }] } },
  };
  const stock = [{ month: '2026-11', value: 10000 }, { month: '2026-12', value: 11000 }, { month: '2027-01', value: 12000 }];
  const rows = reportMonthlySeries(perProperty, 'baseline', stock, 500000);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].principal, 900);
  assert.equal(rows[1].principal, 605);
  assert.equal(rows[2].principal, 0);
});

test('computeProjection: pot series tracks sells in and pot-funded buys out', () => {
  const holding = {
    id: 1, accountId: 1, symbol: 'XQQ.TO', label: 'XQQ', currency: 'CAD',
    events: [{ date: '2025-01-15', type: 'buy', units: 100 }],
    pricePoints: [{ date: '2025-01-01', price: 100 }],
  };
  const mainline = { properties: [], holdings: [holding], assessed: {}, declaredAssets: [], fxRateLatest: 1 };
  const run = (ops, legs) => computeProjection({
    mainline: JSON.parse(JSON.stringify(mainline)), ops, legs,
    assumptions: {}, scenario: null, primeHistory: [], currentPrime: null,
    currentMonth: '2026-11', horizonMonths: 12, holdingGrowth: null,
  });
  const strat = run(
    [{ id: 1, seq: 1, op_type: 'sell', params: { holdingId: 1, date: '2026-12-15', units: 24, price: 100 } },
     { id: 2, seq: 2, op_type: 'buy', params: { accountId: 1, symbol: 'NEW.TO', date: '2027-01-15', units: 12, price: 100, currency: 'CAD' } }],
    [{ op_seq: 2, source_ref: 'pot', amount: 'all' }]);
  assert.deepEqual(strat.errors, []);
  const potAt = (m) => (strat.stocks.potSeries.find((r) => r.month === m) || {}).value;
  const valAt = (m) => (strat.stocks.series.find((r) => r.month === m) || {}).value;
  assert.equal(potAt('2026-11'), 0);
  assert.equal(potAt('2026-12'), 2400);
  assert.equal(potAt('2027-01'), 1200);
  assert.equal(strat.stocks.potAtHorizon, 1200);
  assert.equal(valAt('2026-12'), 7600);
  assert.equal(valAt('2027-01'), 8800);
  // An empty-pot pot-funded buy is dropped with an error and the
  // series stays identical to baseline — the mechanism behind the
  // user's identical-series report (not conservation: conservation
  // moves pool down and stock up by the buy amount, as above).
  const dropped = run(
    [{ id: 1, seq: 1, op_type: 'buy', params: { holdingId: 1, date: '2027-01-15', units: 10, price: 100 } }],
    [{ op_seq: 1, source_ref: 'pot', amount: 'all' }]);
  assert.equal(dropped.errors.length, 1);
  assert.match(dropped.errors[0], /unfunded/);
  assert.equal(dropped.stocks.buyCash, 0);
  assert.equal((dropped.stocks.series.find((r) => r.month === '2027-01') || {}).value, 10000);
});

test('reportMonthlySeries: pool balance series and investment-scope total (pool + stocks only)', () => {
  const perProperty = { 1: { baseline: { series: [{ month: '2026-11', balance: 100000, interest: 400 }] } } };
  const stock = [{ month: '2026-11', value: 10000 }];
  const pool = [{ month: '2026-11', value: 1200 }];
  const scoped = reportMonthlySeries(perProperty, 'baseline', stock, 500000, null, null, { poolSeries: pool, investmentScope: true });
  assert.equal(scoped[0].pool_balance, 1200);
  assert.equal(scoped[0].total_value, 11200);
  const plain = reportMonthlySeries(perProperty, 'baseline', stock, 500000, null, null, { poolSeries: pool });
  assert.equal(plain[0].pool_balance, 1200);
  assert.equal(plain[0].total_value, 410000);
});

test('validateAiReportChartSeries: pool_balance allowed on trajectory templates only', () => {
  assert.deepEqual(validateAiReportChartSeries([{ template: 'time_line', title: 'Pool', series: ['pool_balance'] }]), []);
  assert.deepEqual(validateAiReportChartSeries([{ template: 'yearly_bars', title: 'Pool', series: ['pool_balance'] }]), []);
  const errs = validateAiReportChartSeries([{ template: 'stacked_bar', title: 'Pool', series: ['pool_balance'] }]);
  assert.equal(errs.length, 1);
});

test('validatePoolItemShapes: external funding is amount-only and sourceless', () => {
  assert.equal(validatePoolItemShapes([{ source: 'external', amount: 5000 }]), null);
  assert.match(validatePoolItemShapes([{ source: 'external', percent: 50 }]), /not a percent/);
  assert.match(validatePoolItemShapes([{ source: 'external', amount: 0 }]), /above 0/);
  assert.match(validatePoolItemShapes([{ source: 'external', holdingId: 1, amount: 500 }]), /no account or holding/);
  assert.equal(validatePoolItemShapes([{ source: 'external', amount: 500 }, { source: 'external', amount: 700 }]), null);
});

test('poolExternalCash: sums external legs only', () => {
  assert.equal(poolExternalCash({ type: 'pool', items: [{ holdingId: 1, percent: 50 }, { source: 'external', amount: 5000 }, { source: 'external', amount: 700 }] }), 5700);
  assert.equal(poolExternalCash({ type: 'pool', items: [{ holdingId: 1, percent: 50 }] }), 0);
  assert.equal(poolExternalCash(null), 0);
});

test('computeProjection: potInitial seeds the pot series for both runs', () => {
  const holding = {
    id: 1, accountId: 1, symbol: 'XQQ.TO', label: 'XQQ', currency: 'CAD',
    events: [{ date: '2025-01-15', type: 'buy', units: 100 }],
    pricePoints: [{ date: '2025-01-01', price: 100 }],
  };
  const mainline = { properties: [], holdings: [holding], assessed: {}, declaredAssets: [], fxRateLatest: 1 };
  const run = (ops, legs, potInitial) => computeProjection({
    mainline: JSON.parse(JSON.stringify(mainline)), ops, legs,
    assumptions: {}, scenario: null, primeHistory: [], currentPrime: null,
    currentMonth: '2026-11', horizonMonths: 12, holdingGrowth: null, potInitial,
  });
  const base = run([], [], 5000);
  assert.equal(base.stocks.potSeries[0].value, 5000);
  assert.equal(base.stocks.potAtHorizon, 5000);
  const strat = run(
    [{ id: 1, seq: 1, op_type: 'buy', params: { accountId: 1, symbol: 'NEW.TO', date: '2027-01-15', units: 12, price: 100, currency: 'CAD' } }],
    [{ op_seq: 1, source_ref: 'pot', amount: 'all' }], 5000);
  assert.deepEqual(strat.errors, []);
  assert.equal((strat.stocks.potSeries.find((r) => r.month === '2027-01') || {}).value, 3800);
});

test('reportCostBreakdown: cash out is the remainder after fees and penalty', () => {
  const bd = reportCostBreakdown({ cost: 12000, fees: 500, penaltyTotal: 1500 });
  assert.deepEqual(bd, { fees: 500, penalty: 1500, cashOut: 10000, total: 12000 });
  assert.equal(reportCostBreakdown(null), null);
  assert.deepEqual(reportCostBreakdown({ cost: 0, fees: 0, penaltyTotal: 0 }), { fees: 0, penalty: 0, cashOut: 0, total: 0 });
});

// ------------------------------------------------------- template metadata
test('planProjectTemplate: mortgage/refinance show prime scenarios only; buy shows neither; sell shows declared assets; blank/unknown are legacy', () => {
  assert.deepEqual(planProjectSections('mortgage'), { declaredAssets: false });
  assert.deepEqual(planProjectSections('refinance'), { declaredAssets: false });
  assert.deepEqual(planProjectSections('buy'), { declaredAssets: false });
  assert.deepEqual(planProjectSections('sell'), { declaredAssets: true });
  assert.equal(planProjectTemplate('blank'), null);
  assert.equal(planProjectTemplate('nope'), null);
  assert.equal(planProjectTemplate(null), null);
  assert.equal(planProjectTemplate('mortgage').fields[0].key, 'property_id');
  assert.equal(planProjectTemplate('buy').fields[0].key, 'account_type');
  assert.equal(planStrategyTemplateLabel('prepay'), 'Prepay');
  assert.equal(planStrategyTemplateLabel('ai-template'), 'AI template');
});

test('buildPlanAiSnapshot: carries balances, terms, segments, prime and capped history', () => {
  const snap = buildPlanAiSnapshot({
    properties: [{ id: 1, address: '1 Test Way', mortgage_balance: 500000, mortgage_balance_date: '2026-10-01', assessed_value: 900000 }],
    terms: [{ id: 1, property_id: 1, start_date: '2024-12-17', term_months: 60, amortization_years: 30, opening_balance: 1350000, payment_override: null }],
    segments: [{ id: 1, property_id: 1, term_id: 1, start_date: '2024-12-17', rate_type: 'variable', annual_rate: null, spread: -1, locked_on: '2024-12-17', compounding: 'semi_annual', accrual: 'daily' }],
    accounts: [{ id: 1, name: 'TFSA', type: 'TFSA' }],
    holdings: [{ id: 1, account_id: 1, symbol: 'XQQ.TO', label: 'XQQ', currency: 'CAD' }],
    prime: 4.70,
    primeHistory: Array.from({ length: 20 }, (_, i) => ({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, rate: 4.45 })),
  });
  assert.equal(snap.properties[0].mortgage_balance, 500000);
  assert.equal(snap.terms[0].term_months, 60);
  assert.equal(snap.segments[0].spread, -1);
  assert.equal(snap.prime, 4.70);
  assert.equal(snap.primeHistory.length, 12);
  assert.equal(snap.accounts[0].type, 'TFSA');
  assert.equal(snap.holdings[0].symbol, 'XQQ.TO');
});

test('buildPlanAiSnapshot: carries jobs and rentals alongside properties and holdings', () => {
  const snap = buildPlanAiSnapshot({
    jobs: [{ id: 1, employer: 'Meta', province: 'BC', frequency: 'bi-weekly', gross_amount: 7300, gross_basis: 'period' }],
    rentals: [{ id: 2, label: '2985 Basement', address: '2985 Christina Pl', rental_type: 'long_term', ownership_pct: 66.67 }],
  });
  assert.equal(snap.jobs[0].employer, 'Meta');
  assert.equal(snap.jobs[0].province, 'BC');
  assert.equal(snap.rentals[0].label, '2985 Basement');
  assert.equal(snap.rentals[0].ownership_pct, 66.67);
});

test('expandScenarioPrimePreset: preset-only prime gains points, flat gains none, present points untouched', () => {
  const up = expandScenarioPrimePreset({ prime: { preset: 'up' }, stock: { valuePct: 5 } }, 4.70, '2026-11');
  assert.equal(up.prime.preset, 'up');
  assert.ok(Array.isArray(up.prime.points) && up.prime.points.length > 0);
  assert.ok(up.prime.points.every((pt, i) => (i === 0 || pt.month > up.prime.points[i - 1].month) && pt.rate >= 0 && pt.rate <= 30));
  assert.equal(up.prime.points[up.prime.points.length - 1].rate, 5.70);
  assert.deepEqual(expandScenarioPrimePreset({ prime: { preset: 'flat' } }, 4.70, '2026-11').prime.points, []);
  const kept = { prime: { preset: 'up', points: [{ month: '2027-01', rate: 5.0 }] } };
  assert.equal(expandScenarioPrimePreset(kept, 4.70, '2026-11').prime.points[0].rate, 5.0);
  assert.equal(expandScenarioPrimePreset({ prime: { preset: 'sideways' } }, 4.70, '2026-11').prime.points, undefined);
  assert.equal(expandScenarioPrimePreset({ stock: { valuePct: 5 } }, 4.70, '2026-11').stock.valuePct, 5);
});

test('expandScenarioPrimePreset: expanded preset passes scenario validation (the old 502)', () => {
  const expanded = expandScenarioPrimePreset({ prime: { preset: 'up' } }, 4.70, '2026-11');
  assert.deepEqual(validateScenarioFactors(expanded, '2026-11'), []);
  assert.deepEqual(validateScenarioFactors({ prime: { preset: 'up' } }, '2026-11'), ['prime points must be an array']);
});

test('planProjectAiSummaries: compact names + factors + definitions + op summaries, no full dumps', () => {
  const out = planProjectAiSummaries({
    scenarios: [{ name: 'Prime up', is_base: 1, factors: { prime: { preset: 'up', points: [] } } }],
    baselines: [{ name: 'Current path', source: 'ai', definition: { description: 'Do nothing', assumptions: [{ key: 'x', value: 1 }] } }],
    strategies: [{ id: 7, name: 'Prepay', letter: 'A', source: 'manual' }],
    opsByStrategy: { 7: [{ seq: 1, op_type: 'prepay', params: JSON.stringify({ date: '2027-01-01', amount: 50000 }) }] },
  });
  assert.equal(out.scenarios[0].name, 'Prime up');
  assert.equal(out.scenarios[0].is_base, true);
  assert.equal(out.baselines[0].description, 'Do nothing');
  assert.equal(out.baselines[0].assumptions[0].key, 'x');
  assert.equal(out.strategies[0].ops[0].op_type, 'prepay');
  assert.equal(out.strategies[0].ops[0].date, '2027-01-01');
  assert.equal(out.strategies[0].ops[0].params.amount, 50000);
  assert.equal(out.strategies[0].sink, undefined);
});

test('aiRepairPrompt: names the exact failing rules and demands a complete corrected spec', () => {
  const p = aiRepairPrompt('Base prompt.', ['model spec is missing charts', 'unknown chart template']);
  assert.ok(p.startsWith('Base prompt.'));
  assert.ok(p.includes('model spec is missing charts; unknown chart template'));
  assert.ok(p.includes('do not return an ask list'));
});

test('normalizeAiAsk: structured questions pass through; a legacy string becomes one question; junk is rejected', () => {
  assert.deepEqual(normalizeAiAsk([{ field: 'target', label: 'Target amount?', type: 'number' }]),
    [{ field: 'target', label: 'Target amount?', type: 'number' }]);
  assert.deepEqual(normalizeAiAsk('What balance?'), [{ field: 'answer', label: 'What balance?', type: 'text' }]);
  assert.equal(normalizeAiAsk([{ field: '', label: 'x' }]), null);
  assert.equal(normalizeAiAsk([{ label: 'no field' }]), null);
  assert.equal(normalizeAiAsk([]), null);
  assert.equal(normalizeAiAsk(null), null);
  assert.equal(normalizeAiAsk('  '), null);
});

test('ai thread: sanitize drops malformed turns and caps at 50; append grows the thread; render prints both roles', () => {
  const raw = [
    { role: 'ai', questions: [{ field: 'target', label: 'Target amount?', type: 'number' }] },
    { role: 'user', answers: { target: 50000 } },
    { role: 'ai' },
    { role: 'user', answers: 'not an object' },
    'junk',
    null,
  ];
  const clean = sanitizeAiThread(raw);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].role, 'ai');
  assert.equal(clean[1].answers.target, 50000);
  const grown = appendAiThread(clean, { role: 'ai', questions: [{ field: 'rate', label: 'Rate?', type: 'number' }] });
  assert.equal(grown.length, 3);
  assert.equal(clean.length, 2); // append does not mutate
  const text = renderAiThreadText(grown);
  assert.ok(text.includes('AI asked: Target amount?'));
  assert.ok(text.includes('User answered "Target amount?": 50000'));
  assert.ok(!text.includes('target = 50000'));
  assert.ok(text.includes('AI asked: Rate?'));
  const capped = sanitizeAiThread(Array.from({ length: 60 }, (_, i) => ({ role: 'user', answers: { n: i } })));
  assert.equal(capped.length, 50);
  assert.equal(capped[0].answers.n, 10); // oldest turns dropped, newest kept
  assert.deepEqual(sanitizeAiThread('nope'), []);
  assert.deepEqual(sanitizeAiThread(null), []);
});

test('equityDeltaPeak: peak month-by-month balance advantage, last row carried forward past a series end', () => {
  const proj = {
    mortgage: {
      perProperty: {
        1: {
          baseline: { series: [
            { month: '2026-11', balance: 100000 }, { month: '2026-12', balance: 99000 }, { month: '2027-01', balance: 98000 },
          ] },
          strategy: { series: [
            { month: '2026-11', balance: 95000 }, { month: '2026-12', balance: 94000 },
          ] },
        },
      },
    },
  };
  // Nov: 5000, Dec: 5000, Jan: 98000 − 94000 (carried) = 4000 → peak 5000.
  assert.equal(equityDeltaPeak(proj), 5000);
  // Payoff case: the strategy series ends at 0, so later months count
  // the full remaining baseline balance.
  const payoff = {
    mortgage: {
      perProperty: {
        1: {
          baseline: { series: [{ month: '2026-11', balance: 10000 }, { month: '2026-12', balance: 9000 }] },
          strategy: { series: [{ month: '2026-11', balance: 0 }] },
        },
      },
    },
  };
  assert.equal(equityDeltaPeak(payoff), 10000);
  assert.equal(equityDeltaPeak({ mortgage: { perProperty: {} } }), 0);
  assert.equal(equityDeltaPeak(null), null);
});

test('principalDeltaVsBaseline: buyCash difference; starting value cancels', () => {
  const base = { stocks: { startingValue: 40000, buyCash: 0 } };
  const strat = { stocks: { startingValue: 40000, buyCash: 600 } };
  assert.equal(principalDeltaVsBaseline(base, strat), 600);
  assert.equal(principalDeltaVsBaseline(base, base), 0);
  assert.equal(principalDeltaVsBaseline(null, strat), null);
});

// ------------------------------------------------- current-plan baseline
test('compareProjections: stock gain is the excess over the same principal in the current plan', () => {
  // Existing holdings: $6,000 at start growing to $6,600 at horizon
  // (ratio 1.1). A $600 buy at flat prices books $0 stock gain: the
  // principal would have grown to $660 in the current plan too.
  const base = { mortgage: { interestSaved: 0 }, stocks: { startingValue: 6000, valueAtHorizon: 6600, buyCash: 0, sellExternalOut: 0 }, cost: 0 };
  const flatBuy = { mortgage: { interestSaved: 0 }, stocks: { startingValue: 6000, valueAtHorizon: 7260, buyCash: 600, sellExternalOut: 0 }, cost: 600 };
  const cmpFlat = compareProjections(base, flatBuy);
  assert.equal(cmpFlat.stockGain, 0);
  assert.equal(cmpFlat.gain, 0);
  // The same buy, but the bought holding grows to $720 while the
  // current plan grows 10%: excess = 720 − 600×1.1 = 60.
  const growthBuy = { mortgage: { interestSaved: 0 }, stocks: { startingValue: 6000, valueAtHorizon: 7320, buyCash: 600, sellExternalOut: 0 }, cost: 600 };
  assert.equal(compareProjections(base, growthBuy).stockGain, 60);
  // No starting value → cash baseline (ratio 1): gain = proceeds − principal.
  const noStart = { mortgage: { interestSaved: 0 }, stocks: { startingValue: 0, valueAtHorizon: 0, buyCash: 0, sellExternalOut: 0 }, cost: 0 };
  const cashBuy = { mortgage: { interestSaved: 0 }, stocks: { startingValue: 0, valueAtHorizon: 660, buyCash: 600, sellExternalOut: 0 }, cost: 600 };
  assert.equal(compareProjections(noStart, cashBuy).stockGain, 60);
  // Do-nothing still books $0.
  assert.equal(compareProjections(base, { ...base, cost: 0 }).stockGain, 0);
});
test('compareProjections: excludeStockGain drops stock gain from gain and net but keeps it reported', () => {
  // Mixed mortgage + stock strategy: $1,000 interest saved, $1,550
  // stock gain, $10,000 prepay cost. Property rule: gain counts the
  // interest only; net = gain − cost still holds to the cent.
  const base = { mortgage: { interestSaved: 0 }, stocks: { startingValue: 3100, valueAtHorizon: 3100, buyCash: 0, sellExternalOut: 0 }, cost: 0 };
  const strat = { mortgage: { interestSaved: 1000 }, stocks: { startingValue: 3100, valueAtHorizon: 4650, buyCash: 0, sellExternalOut: 0 }, cost: 10000 };
  const cmp = compareProjections(base, strat, { excludeStockGain: true });
  assert.equal(cmp.stockGain, 1550);
  assert.equal(cmp.gain, 1000);
  assert.equal(cmp.net, -9000);
  assert.equal(cmp.net, cmp.gain - cmp.cost);
  // Same figures without the flag: stock gain stays inside gain/net.
  const incl = compareProjections(base, strat);
  assert.equal(incl.stockGain, 1550);
  assert.equal(incl.gain, 2550);
  assert.equal(incl.net, -7450);
  // Negative stock gain is excluded the same way (never added back).
  const neg = { mortgage: { interestSaved: 1000 }, stocks: { startingValue: 3100, valueAtHorizon: 2500, buyCash: 0, sellExternalOut: 0 }, cost: 10000 };
  const cmpNeg = compareProjections(base, neg, { excludeStockGain: true });
  assert.equal(cmpNeg.stockGain, -600);
  assert.equal(cmpNeg.gain, 1000);
  assert.equal(cmpNeg.net, -9000);
});
test('principalGainSeries: month-by-month excess over the current-plan baseline', () => {
  const base = { stocks: { series: [{ month: '2026-11', value: 6000 }, { month: '2026-12', value: 6600 }] } };
  const strat = { stocks: { series: [{ month: '2026-11', value: 6600 }, { month: '2026-12', value: 7320 }], buyCash: 600 } };
  const series = principalGainSeries(base, strat);
  assert.equal(series[0].value, 0);
  assert.equal(series[1].value, 60);
  assert.deepEqual(principalGainSeries(base, base), [{ month: '2026-11', value: 0 }, { month: '2026-12', value: 0 }]);
  assert.deepEqual(principalGainSeries(null, strat), []);
});
test('validateAiBaseline: prime scenario enums and step shapes, stock reference coerced by the caller', () => {
  assert.deepEqual(validateAiBaseline({ description: 'x', primeScenario: null, stockReference: 'current-plan', assumptions: [] }), []);
  assert.ok(validateAiBaseline({ primeScenario: { name: 'Up', direction: 'sideways' } }).length > 0);
  assert.ok(validateAiBaseline({ primeScenario: { name: 'Up', direction: 'up', steps: [{ date: 'not-a-date', rate: 5 }] } }).length > 0);
  assert.deepEqual(validateAiBaseline({ primeScenario: { name: 'Up', direction: 'up', stance: 'neutral', magnitude: 1, steps: [{ date: '2027-01-01', rate: 5.5 }] } }), []);
  assert.ok(validateAiBaseline(null).length > 0);
});
test('paymentScopeFor: legacy table stock-only row renders —, never a summed +$0.00', () => {
  // The legacy comparison table shows only a delta. Summing
  // per-property payment diffs for a stock-only strategy yields 0
  // (every mortgage payment is unchanged), which the old table
  // rendered as a spurious '+$0.00'. The scoped delta is null, so
  // the legacy row renders '—' like Master/Apple.
  const base = { mortgage: { perProperty: {
    1: { baseline: { paymentAtEffect: 1000 }, strategy: { paymentAtEffect: 1000 } },
    2: { baseline: { paymentAtEffect: 500 }, strategy: { paymentAtEffect: 500 } },
  } } };
  const summed = Object.values(base.mortgage.perProperty)
    .reduce((s, per) => s + (per.strategy.paymentAtEffect - per.baseline.paymentAtEffect), 0);
  assert.equal(summed, 0);
  assert.deepEqual(paymentScopeFor(base, base, [{ op_type: 'position', params: { accountId: 9, holdingId: 1, units: 50 } }]),
    { propertyIds: [], baseline: null, strategy: null, delta: null });
});
test('paymentScopeFor: payment covers only mortgage-op properties, never the project total', () => {
  const base = { mortgage: { perProperty: {
    1: { baseline: { paymentAtEffect: 1000 }, strategy: { paymentAtEffect: 1200 } },
    2: { baseline: { paymentAtEffect: 500 }, strategy: { paymentAtEffect: 500 } },
    3: { baseline: { paymentAtEffect: 700 }, strategy: { paymentAtEffect: 700 } },
  } } };
  const strat = base;
  assert.deepEqual(paymentScopeFor(base, strat, [{ op_type: 'rate_switch', params: { propertyId: 1 } }]),
    { propertyIds: [1], baseline: 1000, strategy: 1200, delta: 200 });
  assert.deepEqual(paymentScopeFor(base, strat, [
    { op_type: 'rate_switch', params: { propertyId: 1 } },
    { op_type: 'prepay', params: { propertyId: 2 } },
  ]), { propertyIds: [1, 2], baseline: 1500, strategy: 1700, delta: 200 });
  // Stock ops, funding legs (not ops), and non-integer property refs never count.
  assert.deepEqual(paymentScopeFor(base, strat, [{ op_type: 'buy', params: { accountId: 9, units: 10 } }]),
    { propertyIds: [], baseline: null, strategy: null, delta: null });
  assert.deepEqual(paymentScopeFor(base, strat, [{ op_type: 'rate_switch', params: {} }]),
    { propertyIds: [], baseline: null, strategy: null, delta: null });
  assert.deepEqual(paymentScopeFor(base, strat, []),
    { propertyIds: [], baseline: null, strategy: null, delta: null });
});

// Entity scope (user rule 2026-11-04): for property projects the
// payment follows the entity property, subsuming op-touched scope.
test('paymentScopeFor: entity override beats op-touched scope', () => {
  const base = { mortgage: { perProperty: {
    1: { baseline: { paymentAtEffect: 1000 }, strategy: { paymentAtEffect: 1200 } },
    2: { baseline: { paymentAtEffect: 500 }, strategy: { paymentAtEffect: 900 } },
  } } };
  // Ops touch property 2, but the entity is property 1: scope is [1].
  assert.deepEqual(paymentScopeFor(base, base,
    [{ op_type: 'rate_switch', params: { propertyId: 2 } }], [1]),
    { propertyIds: [1], baseline: 1000, strategy: 1200, delta: 200 });
  // An entity with no perProperty entry contributes nothing (nulls),
  // never the op-touched property's figures.
  assert.deepEqual(paymentScopeFor(base, base,
    [{ op_type: 'rate_switch', params: { propertyId: 2 } }], [9]),
    { propertyIds: [9], baseline: null, strategy: null, delta: null });
});

test('scopeMainlineToProperty: keeps only the entity property', () => {
  const ml = MAINLINE({ properties: [PROP(), { ...PROP(), id: 2 }, { ...PROP(), id: 3 }], holdings: [{ id: 7 }] });
  const scoped = scopeMainlineToProperty(ml, 2);
  assert.deepEqual(scoped.properties.map((p) => p.id), [2]);
  assert.deepEqual(scoped.holdings, [{ id: 7 }]);
  assert.equal(scoped.assessed[1], 1000000);
  // Null/invalid ids leave the mainline unchanged (legacy + non-property).
  assert.equal(scopeMainlineToProperty(ml, null), ml);
  assert.equal(scopeMainlineToProperty(ml, 'x'), ml);
  assert.equal(scopeMainlineToProperty(ml, 9).properties.length, 0);
});

// AI-report empty chart (user bug 2026-11-03): a series its template
// cannot render used to come out as an all-zero stacked_bar Total.
test('ai-report series validation rejects unrenderable template/series pairs', () => {
  // The reported case: cost on stacked_bar.
  assert.equal(validateAiReportChartSeries([{ template: 'stacked_bar', title: 'Cost Comparison', series: ['cost'] }]).length, 1);
  assert.match(validateAiReportChartSeries([{ template: 'stacked_bar', title: 'Cost Comparison', series: ['cost'] }])[0], /cannot render series "cost"/);
  // Same series on a template that renders it passes.
  assert.deepEqual(validateAiReportChartSeries([{ template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }]), []);
  // Renderable pairs pass on every series-bearing template.
  assert.deepEqual(validateAiReportChartSeries([
    { template: 'time_line', title: 'T', series: ['mortgage_balance', 'stock_value', 'total_value'] },
    { template: 'yearly_bars', title: 'Y', series: ['mortgage_balance'] },
    { template: 'stacked_bar', title: 'S', series: ['mortgage_balance', 'stock_value'] },
    { template: 'metric_cards', title: 'M', series: ['cost', 'gain', 'net', 'stock_gain', 'payoff_month', 'monthly_payment'] },
    { template: 'share_doughnut', title: 'D', series: ['cost'] },
    { template: 'share_doughnut', title: 'E', series: ['total_value'] },
  ]), []);
  // Other mismatches are rejected too.
  assert.equal(validateAiReportChartSeries([{ template: 'time_line', title: 'T', series: ['cost'] }]).length, 1);
  assert.equal(validateAiReportChartSeries([{ template: 'metric_cards', title: 'M', series: ['mortgage_balance'] }]).length, 1);
  assert.equal(validateAiReportChartSeries([{ template: 'share_doughnut', title: 'D', series: ['gain'] }]).length, 1);
  // Absent or empty series is not an error: the renderer falls back
  // to its default series for that template.
  assert.deepEqual(validateAiReportChartSeries([{ template: 'stacked_bar', title: 'S' }]), []);
  assert.deepEqual(validateAiReportChartSeries([{ template: 'stacked_bar', title: 'S', series: [] }]), []);
  // fan_band / funds_flow ignore series, so they are not validated.
  assert.deepEqual(validateAiReportChartSeries([
    { template: 'fan_band', title: 'F', series: ['cost'] },
    { template: 'funds_flow', title: 'W', series: ['cost'] },
  ]), []);
  assert.deepEqual(validateAiReportChartSeries('nope'), ['charts must be an array']);
});

test('ai-report prompt grounds the model in template/series support and snapshot availability', () => {
  const prompt = aiReportPrompt({ strategies: [{ id: 1, name: 'A', letter: 'A' }], mortgagedCount: 2, holdingCount: 0, text: 'Compare costs' });
  assert.match(prompt, /stacked_bar renders only mortgage_balance \(stacked by property\) and stock_value/);
  assert.match(prompt, /metric_cards renders only cost, gain, net, stock_gain, payoff_month, monthly_payment/);
  assert.match(prompt, /2 properties carry a mortgage, 0 stock holdings exist/);
  assert.match(prompt, /do not use stock_value when no stock holding exists/);
  assert.match(prompt, /"id":1,"name":"A"/);
  assert.match(prompt, /User request: Compare costs/);
  const singular = aiReportPrompt({ strategies: [], mortgagedCount: 1, holdingCount: 1, text: 'x' });
  assert.match(singular, /1 property carries a mortgage, 1 stock holding exists/);
});

// Pure-AI project creation: trio shape validation (user spec
// 2026-11-02). Semantic checks run server-side on top of this.
test('validateAiCreateProposal accepts a well-formed trio, trimming names', () => {
  const { proposal, errors } = validateAiCreateProposal({
    project: { name: '  AI plan  ', question: 'q' },
    scenario: { name: 'Up world', factors: { prime: { preset: 'up' } } },
    baseline: { name: 'Do nothing', description: 'd', assumptions: [{ key: 'k', value: 1 }] },
    strategy: { name: 'Fix it', ops: [{ op_type: 'prepay', params: { date: '2027-01-01', amount: 10000 } }] },
  });
  assert.deepEqual(errors, []);
  assert.equal(proposal.project.name, 'AI plan');
  assert.equal(proposal.strategy.ops.length, 1);
});

test('validateAiCreateProposal flags missing names, bad ops, and non-array assumptions', () => {
  const { proposal, errors } = validateAiCreateProposal({
    project: {},
    scenario: { factors: 'nope' },
    baseline: { assumptions: 'nope' },
    strategy: { name: 'S', ops: [{ op_type: 'teleport', params: {} }, { op_type: 'prepay' }, 'junk'] },
  });
  assert.ok(proposal !== null); // shape errors flag, but the proposal still returns for preview flagging
  assert.ok(errors.includes('project name is required'));
  assert.ok(errors.includes('scenario name is required'));
  assert.ok(errors.includes('scenario factors must be an object'));
  assert.ok(errors.includes('baseline needs a name or a description'));
  assert.ok(errors.includes('baseline assumptions must be an array'));
  assert.ok(errors.some((e) => /unknown type teleport/.test(e)));
  assert.ok(errors.some((e) => /needs params/.test(e)));
  assert.ok(errors.some((e) => /must be an object/.test(e)));
});

test('validateAiCreateProposal falls back to the baseline description for its name', () => {
  const { proposal, errors } = validateAiCreateProposal({
    project: { name: 'P' },
    scenario: { name: 'S', factors: {} },
    baseline: { description: 'Do nothing at all' },
    strategy: { name: 'T', ops: [] },
  });
  assert.deepEqual(errors, []);
  assert.equal(proposal.baseline.name, 'Do nothing at all');
});

test('validateAiCreateProposal rejects a non-object reply', () => {
  const { proposal, errors } = validateAiCreateProposal('nope');
  assert.equal(proposal, null);
  assert.deepEqual(errors, ['proposal must be an object']);
});

test('validateAiCreateProposal drops a carried sink (GIC shape: the rate rides on the buy op)', () => {
  const gic = {
    project: { name: 'GIC Investment' },
    scenario: { name: 'Base Scenario', factors: {} },
    baseline: { name: 'Do Nothing', description: 'Hold the pool as-is' },
    strategy: { name: 'GIC Purchase Strategy', ops: [{ op_type: 'buy', params: { accountId: null, symbol: 'GIC 4.12% 180d', currency: 'CAD', date: '2027-01-01', amount: 10000, price: 100, expectedReturnPct: 4.12 } }] },
  };
  const { proposal, errors } = validateAiCreateProposal(gic);
  assert.deepEqual(errors, []);
  assert.equal(proposal.strategy.sink, undefined);
  assert.equal(proposal.strategy.ops[0].params.expectedReturnPct, 4.12);
  // A stale proposal still carrying a sink is normalized, not
  // rejected: the sink is dropped and the ops carry the shape.
  const stale = validateAiCreateProposal({ ...gic, strategy: { ...gic.strategy, sink: { kind: 'custom', name: 'GIC 4.12% 180d', expectedReturnPct: 4.12 } } });
  assert.deepEqual(stale.errors, []);
  assert.equal(stale.proposal.strategy.sink, undefined);
  const noSink = validateAiCreateProposal({ ...gic, strategy: { name: 'GIC Purchase Strategy', ops: [] } });
  assert.deepEqual(noSink.errors, []);
  assert.equal(noSink.proposal.strategy.sink, undefined);
});

test('sink-simplify: a stored custom sink rate is inherited by a rateless account-less buy (pre-simplification GIC shim); a stock sink trend is dropped', () => {
  const ops = [
    { op_type: 'buy', params: { accountId: null, symbol: 'GIC 4.12% 180d', date: '2027-01-01', amount: 1000, price: 100 } },
    { op_type: 'buy', params: { accountId: 1, symbol: 'XQQ.TO', date: '2027-01-01', amount: 500, price: 50 } },
    { op_type: 'buy', params: { accountId: null, symbol: 'GIC 5% 90d', date: '2027-01-01', amount: 500, price: 100, expectedReturnPct: 5 } },
  ];
  applyStoredCustomSinkRate(ops, { kind: 'custom', name: 'GIC 4.12% 180d', expectedReturnPct: 4.12 });
  assert.equal(ops[0].params.expectedReturnPct, 4.12); // rateless + account-less → inherits the stored rate
  assert.equal(ops[1].params.expectedReturnPct, undefined); // has an account → untouched
  assert.equal(ops[2].params.expectedReturnPct, 5); // has its own rate → untouched
  // A stock sink's trend is dropped, never inherited.
  const stockOps = [{ op_type: 'buy', params: { accountId: 1, holdingId: 9, date: '2027-01-01', amount: 600, price: 20 } }];
  applyStoredCustomSinkRate(stockOps, { kind: 'stock', holdingId: 9, trendPct: 12 });
  assert.equal(stockOps[0].params.expectedReturnPct, undefined);
  // A custom sink with no usable rate inherits nothing (no NaN).
  const noRate = [{ op_type: 'buy', params: { accountId: null, symbol: 'GIC', date: '2027-01-01', amount: 100, price: 100 } }];
  applyStoredCustomSinkRate(noRate, { kind: 'custom', name: 'GIC' });
  assert.equal(noRate[0].params.expectedReturnPct, undefined);
});

test('validateAiReportBaselineKind: pool baseline rejects every mortgage-family chart', () => {
  const pool = (charts) => validateAiReportBaselineKind(charts, 'pool');
  assert.equal(pool([{ template: 'fan_band', title: 'Fan', series: [] }]).length, 1);
  assert.ok(pool([{ template: 'time_line', title: 'Mort', series: ['mortgage_balance'] }])[0].includes('mortgage_balance'));
  assert.equal(pool([{ template: 'time_line', title: 'Default', series: [] }]).length, 1);
  assert.equal(pool([{ template: 'yearly_bars', title: 'Y', series: ['mortgage_balance'] }]).length, 1);
  assert.equal(pool([{ template: 'stacked_bar', title: 'S', series: ['mortgage_balance'] }]).length, 1);
  assert.equal(pool([{ template: 'share_doughnut', title: 'D', series: ['mortgage_balance'] }]).length, 1);
  assert.equal(pool([{ template: 'share_doughnut', title: 'D', series: ['total_value'] }]).length, 1);
  assert.equal(pool([{ template: 'metric_cards', title: 'H', series: ['monthly_payment'] }]).length, 1);
  assert.equal(pool([{ template: 'metric_cards', title: 'H', series: ['payoff_month'] }]).length, 1);
  assert.deepEqual(pool([{ template: 'time_line', title: 'Pool', series: ['pool_balance', 'stock_value'] }]), []);
  assert.deepEqual(pool([{ template: 'metric_cards', title: 'H', series: ['cost', 'gain', 'net', 'stock_gain'] }]), []);
  assert.deepEqual(pool([{ template: 'share_doughnut', title: 'D', series: ['cost'] }]), []);
  assert.deepEqual(validateAiReportBaselineKind([{ template: 'fan_band', title: 'Fan', series: [] }], 'property'), []);
  assert.deepEqual(validateAiReportBaselineKind([{ template: 'time_line', title: 'Mort', series: ['mortgage_balance'] }], 'other'), []);
});

test('aiReportPrompt carries the baseline kind and its chart restriction', () => {
  const pool = aiReportPrompt({ strategies: [], mortgagedCount: 0, holdingCount: 1, text: 'x', baselineKind: 'pool' });
  assert.match(pool, /Baseline kind: cash pool/);
  assert.match(pool, /FORBIDDEN/);
  // Pool method language: the AI must not describe interest saved,
  // mortgage, payoff or penalty on a cash-pool report.
  assert.match(pool, /never mention interest saved, mortgage, payoff, or penalty/);
  assert.match(aiReportPrompt({ strategies: [], mortgagedCount: 1, holdingCount: 0, text: 'x', baselineKind: 'property' }), /Baseline kind: property/);
  assert.doesNotMatch(aiReportPrompt({ strategies: [], mortgagedCount: 0, holdingCount: 0, text: 'x' }), /Baseline kind/);
  // funds_flow is not offered anywhere: the app cannot render it,
  // so the AI is told so explicitly and never asked to produce it.
  assert.match(aiReportPrompt({ strategies: [], mortgagedCount: 0, holdingCount: 1, text: 'x', baselineKind: 'pool' }), /funds_flow is not offered/);
});

test('aiSuggestNamePrompt: strategy names come from ops, entity is context only', () => {
  const p = aiSuggestNamePrompt('strategy', { ops: [{ op_type: 'rate_switch', params: { date: '2027-01-15', rateType: 'fixed', annualRate: 4.5 } }], entityLabel: '2985 Christina Place' });
  assert.match(p, /Jan to Fix|rate_switch/);
  assert.match(p, /NOT the naming basis/);
  assert.match(p, /name ONLY/);
  const empty = aiSuggestNamePrompt('strategy', { ops: [], category: 'property' });
  assert.match(empty, /context alone/);
  const scen = aiSuggestNamePrompt('scenario', { factors: { stock: { valuePct: 12 } }, category: 'investment' });
  assert.match(scen, /12/);
  assert.match(scen, /name ONLY/);
});

test('cleanAiSuggestedName strips objects, quotes and extra lines', () => {
  assert.equal(cleanAiSuggestedName({ name: 'Jan to Fix' }), 'Jan to Fix');
  assert.equal(cleanAiSuggestedName('"pre pay 50000"\nSome explanation'), 'pre pay 50000');
  assert.equal(cleanAiSuggestedName('  Prime rises  '), 'Prime rises');
  assert.equal(cleanAiSuggestedName(''), '');
  assert.equal(cleanAiSuggestedName(null), '');
});

test('factorsToAssumptions maps per-holding stock overrides', () => {
  assert.deepEqual(
    factorsToAssumptions({ stock: { valuePct: 6, byHolding: { 7: { valuePct: 12, basis: 'Price CAGR', window: '2025-11 → 2026-10' } } } }, {}),
    { stockReturnPct: 6, stockReturnByHolding: { 7: 12 } });
  assert.deepEqual(factorsToAssumptions({ stock: { byHolding: { 7: { valuePct: 12 } } } }, {}), { stockReturnByHolding: { 7: 12 } });
});

test('validateScenarioFactors accepts and rejects per-holding stock overrides', () => {
  assert.deepEqual(validateScenarioFactors({ stock: { byHolding: { 7: { valuePct: 12 } } } }), []);
  assert.equal(validateScenarioFactors({ stock: { byHolding: { 7: { valuePct: 600 } } } }).length, 1);
  assert.equal(validateScenarioFactors({ stock: { byHolding: { 7: 'nope' } } }).length, 1);
  assert.equal(validateScenarioFactors({ stock: { byHolding: [] } }).length, 1);
});

test('computeProjection: per-holding scenario override wins over global and history rates', () => {
  const holding = { id: 7, symbol: 'T', label: 'T', currency: 'CAD', events: [{ date: '2026-01-01', type: 'position', units: 100 }], pricePoints: [{ date: '2026-10-01', price: 10 }] };
  const over = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [holding] }), holdingGrowth: { 7: 5 }, assumptions: { stockReturnByHolding: { 7: 20 } } }));
  // 100 units × $10 grown one month at 20%/yr: 1000 × 1.20^(1/12) ≈ 1015.31.
  assert.ok(Math.abs(over.stocks.series[0].value - 1015.31) < 0.5, `got ${over.stocks.series[0].value}`);
  const global = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [holding] }), holdingGrowth: { 7: 5 }, assumptions: { stockReturnPct: 30, stockReturnByHolding: { 7: 20 } } }));
  assert.ok(Math.abs(global.stocks.series[0].value - 1015.31) < 0.5, `got ${global.stocks.series[0].value}`);
  const hist = computeProjection(ARGS({ mainline: MAINLINE({ holdings: [holding] }), holdingGrowth: { 7: 5 }, assumptions: {} }));
  assert.ok(Math.abs(hist.stocks.series[0].value - 1004.07) < 0.5, `got ${hist.stocks.series[0].value}`);
});

test('computeProjection: a buy carrying expectedReturnPct grows at that rate (GIC shape)', () => {
  const gicBuy = { seq: 1, op_type: 'buy', params: { accountId: null, symbol: 'GIC 4.12% 180d', currency: 'CAD', date: '2026-11-01', amount: 10000, price: 100, expectedReturnPct: 4.12 } };
  const legs = [{ op_seq: 1, source_ref: 'cash', amount: 'remainder' }];
  const gic = computeProjection(ARGS({ ops: [gicBuy], legs }));
  assert.deepEqual(gic.errors, []);
  assert.equal(gic.stocks.series[0].value, 10000);
  // 100 units × $100 grown 12 months at 4.12%/yr: 10000 × 1.0412 = 10412.
  assert.ok(Math.abs(gic.stocks.series[12].value - 10412) < 0.5, `got ${gic.stocks.series[12].value}`);
  // Same buy with no rate: flat at the buy price (no history, no
  // scenario return) — the rate must ride on the buy, not be assumed.
  const flat = computeProjection(ARGS({ ops: [{ ...gicBuy, params: { ...gicBuy.params, expectedReturnPct: undefined } }], legs }));
  assert.deepEqual(flat.errors, []);
  assert.equal(flat.stocks.series[12].value, 10000);
  // The buy-carried rate wins over the scenario's global stock return
  // (the product's own rate governs its holding), but a per-holding
  // scenario override still wins over the buy.
  const vsGlobal = computeProjection(ARGS({ ops: [gicBuy], legs, assumptions: { stockReturnPct: 30 } }));
  assert.ok(Math.abs(vsGlobal.stocks.series[12].value - 10412) < 0.5, `got ${vsGlobal.stocks.series[12].value}`);
  const vsOverride = computeProjection(ARGS({ ops: [gicBuy], legs, assumptions: { stockReturnByHolding: { 'new:1': 20 } } }));
  assert.ok(Math.abs(vsOverride.stocks.series[12].value - 12000) < 0.5, `got ${vsOverride.stocks.series[12].value}`);
});

test('validateOp: a custom-product buy needs an expected return (-90..500); a stock buy does not', () => {
  const customBuy = (ret) => ({ op_type: 'buy', params: { accountId: null, symbol: 'GIC 4.12%', currency: 'CAD', date: '2027-01-01', amount: 1000, price: 100, expectedReturnPct: ret } });
  assert.deepEqual(validateOp(customBuy(4.12)), []);
  // A rateless custom buy has no history to fall back on — it would
  // project flat — so the rate is required, not merely bounded.
  assert.ok(validateOp(customBuy(undefined)).some((e) => /expected return/.test(e)));
  assert.ok(validateOp(customBuy(600)).some((e) => /expected return/.test(e)));
  assert.ok(validateOp(customBuy(-100)).some((e) => /expected return/.test(e)));
  // A stock buy grows at its own history / the scenario return, so no
  // rate is required — but a rate, when carried, is still bounded.
  const stockBuy = (ret) => ({ op_type: 'buy', params: { accountId: 1, symbol: 'XQQ.TO', currency: 'CAD', date: '2027-01-01', amount: 1000, price: 100, expectedReturnPct: ret } });
  assert.deepEqual(validateOp(stockBuy(undefined)), []);
  assert.ok(validateOp(stockBuy(600)).some((e) => /expected return/.test(e)));
});
