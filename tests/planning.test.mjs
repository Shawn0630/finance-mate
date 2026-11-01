// Planning: penalty math, prime scenarios, op/leg validation, the
// projection's cost/gain/net accounting (measured against the baseline
// trajectory, never against today's value), historical return
// suggestions with honest windows, and merge/revert write building.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcPenalty, presetPrimeSteps, scenarioPrimeHistory,
  validateOp, validateLegs, computeProjection, compareProjections,
  returnSuggestionsFromPoints, buildMergeWrites, buildRevertInverse,
  resolveBuyLegs, reportMonthlySeries, reportCostBreakdown,
  planProjectTemplate, planProjectSections, planStrategyTemplateLabel,
  buildPlanAiSnapshot, normalizeAiAsk,
  sanitizeAiThread, appendAiThread, renderAiThreadText,
  equityDeltaPeak, principalDeltaVsBaseline,
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

// ------------------------------------------------------------- scenarios
test('presetPrimeSteps: up-pessimistic steps within a year, flat is empty', () => {
  const steps = presetPrimeSteps({ direction: 'up', stance: 'pessimistic', magnitude: 2.0 }, 4.70, '2026-11');
  assert.equal(steps.length, 4);
  assert.equal(steps[steps.length - 1].rate, 6.70);
  assert.equal(presetPrimeSteps({ direction: 'flat' }, 4.70, '2026-11').length, 0);
});
test('scenarioPrimeHistory: only steps after the last actual observation survive', () => {
  const actual = [{ date: '2026-10-28', rate: 4.45 }, { date: '2026-11-04', rate: 4.70 }];
  const out = scenarioPrimeHistory(actual, { direction: 'up', stance: 'pessimistic', magnitude: 2.0 }, 4.70, '2026-11');
  assert.ok(out.every((o) => o.date >= '2026-10-28'));
  assert.equal(out[out.length - 1].rate, 6.70);
});

// ------------------------------------------------------------- validation
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

test('reportCostBreakdown: cash out is the remainder after fees and penalty', () => {
  const bd = reportCostBreakdown({ cost: 12000, fees: 500, penaltyTotal: 1500 });
  assert.deepEqual(bd, { fees: 500, penalty: 1500, cashOut: 10000, total: 12000 });
  assert.equal(reportCostBreakdown(null), null);
  assert.deepEqual(reportCostBreakdown({ cost: 0, fees: 0, penaltyTotal: 0 }), { fees: 0, penalty: 0, cashOut: 0, total: 0 });
});

// ------------------------------------------------------- template metadata
test('planProjectTemplate: mortgage/refinance show prime scenarios only; buy shows neither; sell shows declared assets; blank/unknown are legacy', () => {
  assert.deepEqual(planProjectSections('mortgage'), { primeScenarios: true, declaredAssets: false });
  assert.deepEqual(planProjectSections('refinance'), { primeScenarios: true, declaredAssets: false });
  assert.deepEqual(planProjectSections('buy'), { primeScenarios: false, declaredAssets: false });
  assert.deepEqual(planProjectSections('sell'), { primeScenarios: false, declaredAssets: true });
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
  assert.ok(text.includes('AI asked: Target amount? (target)'));
  assert.ok(text.includes('User answered: target = 50000'));
  assert.ok(text.includes('AI asked: Rate? (rate)'));
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
