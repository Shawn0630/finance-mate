// Planning — sandbox projections over mainline data.
//
// Design (see the prototype brief): a project holds strategies; each
// strategy is an ordered op list replayed against a snapshot of mainline.
// NOTHING here writes mainline: compute functions take plain data and
// return numbers; the server turns merge previews into real writes only
// through the atomic Merge path, with per-row before/after records.
//
// Accounting (brief §3, applied literally so every strategy compares on
// the same rule):
//   cost = fees + penalty + mortgage prepay cash + stock buy cash
//   gain = mortgage interest saved (full-life totals) + stock ending
//          value (holdings + pot + external-out proceeds − starting value)
//   net  = gain − cost
// Transfers net out by construction: sell proceeds reinvested appear in
// both the ending value and the buy cost; proceeds parked in the pot
// appear in the pot, never double-counted as sells.

import {
  buildSchedule, segmentForMonth, segmentRateForMonth,
  primeHistoryResolver, remainingBalanceAt,
} from './engine.js';

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};

// ------------------------------------------------------------ month math --
export const monthIdxOf = (ym) => {
  const [y, m] = String(ym).split('-').map(Number);
  return y * 12 + (m - 1);
};
export const ymOfIdx = (idx) => {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};
const addMonthsYm = (ym, n) => ymOfIdx(monthIdxOf(ym) + n);
const monthEndOf = (ym) => `${ym}-31`;
const isYm = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));

// ---------------------------------------------------------------- penalty --
// kind: 'fixed_closed' | 'variable_closed' | 'open'.
// breakAmount: the amount being broken early (a prepay's penalized excess
// is computed by the caller when privilege applies; a switch/refinance
// passes the full balance at break). comparableRatePct: the lender's
// current rate for the term nearest the remaining term (an assumption —
// the app has no live bank posted rates). Returns an ESTIMATE always;
// the bank quote governs.
export function calcPenalty({
  balanceAtBreak, contractRatePct, comparableRatePct = null,
  remainingMonths, kind, penalizedAmount = null,
}) {
  const bal = num(balanceAtBreak);
  const rate = num(contractRatePct);
  const rem = num(remainingMonths);
  const base = penalizedAmount == null ? bal : num(penalizedAmount);
  if (bal == null || bal <= 0 || rate == null || rate < 0 || rem == null) {
    return { penalty: null, threeMonthInterest: null, ird: null, method: null, estimate: true, note: 'penalty needs a balance, a contract rate and a remaining term' };
  }
  if (kind === 'open') {
    return { penalty: 0, threeMonthInterest: 0, ird: 0, method: 'open', estimate: true, note: 'Estimate — the bank quote governs' };
  }
  const amt = base == null || base < 0 ? 0 : base;
  const three = round2((amt * rate) / 100 * 3 / 12);
  if (kind === 'variable_closed') {
    return { penalty: three, threeMonthInterest: three, ird: null, method: 'three_months_interest', estimate: true, note: 'Estimate — the bank quote governs' };
  }
  // fixed_closed: greater of 3 months' interest vs IRD.
  const comp = num(comparableRatePct);
  let ird = null;
  if (comp != null && comp >= 0 && rem > 0) {
    ird = round2(Math.max(0, rate - comp) / 100 * amt * (rem / 12));
  }
  const penalty = ird == null ? three : Math.max(three, ird);
  return {
    penalty: round2(penalty),
    threeMonthInterest: three,
    ird,
    method: ird == null ? 'three_months_interest' : (penalty === ird && ird > three ? 'ird' : 'three_months_interest'),
    estimate: true,
    note: ird == null
      ? 'Estimate — no comparable rate given, so IRD is not computed; the bank quote governs'
      : 'Estimate — the bank quote governs',
  };
}

// ------------------------------------------------------- prime scenarios --
// A scenario is direction × stance × magnitude/pace. Steps are dated the
// first of the month they take effect (the engine's month-end rule then
// prices that month at the new rate). startMonth is 'YYYY-MM'.
// Merge actual prime history with a strategy's prime-factor steps. Steps
// dated on or before the last actual observation are dropped (future
// only). Between steps the rate holds at the last point's value until
// the next point (the engine's month-end rule).
export function scenarioPrimeHistory(actualHistory, scenario) {
  const actual = (actualHistory || []).map((o) => ({ date: String(o.date).slice(0, 10), rate: Number(o.rate) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && isFinite(o.rate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!scenario || !Array.isArray(scenario.steps)) return actual;
  const steps = scenario.steps.map((o) => ({ date: String(o.date).slice(0, 10), rate: Number(o.rate) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && isFinite(o.rate));
  const lastActual = actual.length ? actual[actual.length - 1].date : '0000-00-00';
  const future = steps.filter((o) => o.date > lastActual);
  return [...actual, ...future].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ------------------------------------------------------------ validation --
// Op shapes (params is the op's JSON params object):
//  prepay {propertyId, date(YYYY-MM-DD), amount, recurringYears?}
//  rate_switch {propertyId, date, rateType fixed|variable, annualRate?, spread?, termMonths?}
//  refinance {propertyId, date, termMonths, amortizationYears, rateType, annualRate?, spread?, fees?, cashOut?, lender?}
//  payment_change {propertyId, date, payment}
//  buy {accountId, holdingId?, symbol?, currency?, date, units?, amount?, price?}
//  sell {holdingId, date, units, price?}
//  position {accountId, symbol?, currency?, date, units} (units only, no price)
export const OP_TYPES = ['prepay', 'rate_switch', 'refinance', 'payment_change', 'buy', 'sell', 'position'];

export function validateOp(op, ctx = {}) {
  const errs = [];
  if (!op || typeof op !== 'object') return ['an operation is required'];
  if (!OP_TYPES.includes(op.op_type)) errs.push(`unknown operation type ${op.op_type}`);
  const p = op.params || {};
  const date = String(p.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errs.push('date must be YYYY-MM-DD');
  if (date && ctx.currentMonth && date.slice(0, 7) < ctx.currentMonth) errs.push('operation date must not be before the current month');
  const pos = (v, label) => { const n = num(v); if (n == null || n <= 0) errs.push(`${label} must be a number > 0`); return n; };
  if (op.op_type === 'prepay') {
    if (!Number.isInteger(Number(p.propertyId))) errs.push('prepay needs a property');
    pos(p.amount, 'prepay amount');
    if (p.recurringYears != null && !(Number(p.recurringYears) >= 1 && Number(p.recurringYears) <= 30)) errs.push('recurring years must be 1..30');
    if (p.openClosed != null && !['open', 'closed'].includes(p.openClosed)) errs.push('openClosed must be open or closed');
  }
  if (op.op_type === 'rate_switch') {
    if (!Number.isInteger(Number(p.propertyId))) errs.push('rate switch needs a property');
    if (p.openClosed != null && !['open', 'closed'].includes(p.openClosed)) errs.push('openClosed must be open or closed');
    if (p.rateType === 'fixed') pos(p.annualRate, 'fixed rate');
    else if (p.rateType === 'variable') { if (num(p.spread) == null) errs.push('spread must be a number'); }
    else errs.push('rateType must be fixed or variable');
  }
  if (op.op_type === 'refinance') {
    if (!Number.isInteger(Number(p.propertyId))) errs.push('refinance needs a property');
    if (p.openClosed != null && !['open', 'closed'].includes(p.openClosed)) errs.push('openClosed must be open or closed');
    if (!(Number(p.termMonths) >= 1 && Number(p.termMonths) <= 120)) errs.push('term length must be 1..120 months');
    if (!(Number(p.amortizationYears) >= 1 && Number(p.amortizationYears) <= 35)) errs.push('amortization must be 1..35 years');
    if (p.rateType === 'fixed') pos(p.annualRate, 'fixed rate');
    else if (p.rateType === 'variable') { if (num(p.spread) == null) errs.push('spread must be a number'); }
    else errs.push('rateType must be fixed or variable');
    if (p.fees != null && num(p.fees) < 0) errs.push('fees must be >= 0');
    if (p.cashOut != null && num(p.cashOut) < 0) errs.push('cash-out must be >= 0');
  }
  if (op.op_type === 'payment_change') {
    if (!Number.isInteger(Number(p.propertyId))) errs.push('payment change needs a property');
    pos(p.payment, 'payment');
  }
  if (op.op_type === 'buy') {
    if (!Number.isInteger(Number(p.accountId))) errs.push('buy needs an account');
    if (p.units == null && p.amount == null) errs.push('buy needs units or an amount');
    if (p.units != null) pos(p.units, 'units');
    if (p.amount != null) pos(p.amount, 'amount');
    if (p.price != null) pos(p.price, 'price');
  }
  if (op.op_type === 'sell') {
    if (!Number.isInteger(Number(p.holdingId))) errs.push('sell needs a holding');
    pos(p.units, 'units');
    if (p.price != null) pos(p.price, 'price');
    if (ctx.unitsAvailable != null && num(p.units) > ctx.unitsAvailable + 1e-9) {
      errs.push(`cannot sell ${p.units} units — only ${ctx.unitsAvailable} held`);
    }
  }
  if (op.op_type === 'position') {
    if (!Number.isInteger(Number(p.accountId))) errs.push('position needs an account');
    pos(p.units, 'units');
    if (p.price != null) errs.push('a position carries no price — use buy when a price is known');
  }
  return errs;
}

// Legs: {source, amount} where source is 'pot' | 'cash' | 'external' |
// 'declared:<assetId>' | 'op:<seq>' | 'repay:<propertyId>' (sell proceeds
// only) | 'external_out' (sell proceeds only), and amount is a number or
// 'all' | 'remainder'. Validates shape, references and cycles; money
// sufficiency is checked during projection (it needs computed proceeds).
export function validateLegs(ops, legs) {
  const errs = [];
  const bySeq = new Map((ops || []).map((o) => [o.seq, o]));
  const edges = new Map(); // op seq -> set of op seqs it funds from
  for (const leg of legs || []) {
    const op = bySeq.get(leg.op_seq);
    if (!op) { errs.push(`leg references unknown operation seq ${leg.op_seq}`); continue; }
    const src = String(leg.source_ref || '');
    if (src.startsWith('op:')) {
      const dep = Number(src.slice(3));
      if (!bySeq.has(dep)) errs.push(`leg references unknown operation seq ${dep}`);
      else {
        if (!edges.has(leg.op_seq)) edges.set(leg.op_seq, new Set());
        edges.get(leg.op_seq).add(dep);
      }
    } else if (!['pot', 'cash', 'external', 'external_out'].includes(src)
      && !src.startsWith('declared:') && !src.startsWith('repay:')) {
      errs.push(`unknown leg source ${src}`);
    }
    if (leg.amount !== 'all' && leg.amount !== 'remainder' && !(num(leg.amount) > 0)) {
      errs.push('leg amount must be > 0, "all" or "remainder"');
    }
  }
  // Cycle detection over op→op funding edges.
  const state = new Map();
  const visit = (n, stack) => {
    state.set(n, 1);
    for (const d of edges.get(n) || []) {
      if (state.get(d) === 1) errs.push(`funding cycle: operations ${[...stack, d].join(' → ')} fund each other`);
      else if (!state.has(d)) visit(d, [...stack, d]);
    }
    state.set(n, 2);
  };
  for (const n of edges.keys()) if (!state.has(n)) visit(n, [n]);
  return errs;
}

// ------------------------------------------------------------- projection --
// mainline: {properties: [{...property row, terms: [...], segments: [...],
//   lumpSums: [...]}], holdings: [{...holding row, accountId, events: [...],
//   pricePoints: [...]}], fxRateLatest (CAD per USD, for USD holdings),
//   assessed: {propertyId: latest assessed value}}
// strategy: {ops: [...], legs: [...], assumptions: {key: value}}
// scenario: prime-path scenario object (or null = actual history only)
// Returns {mortgage: {perProperty, totals}, stocks: {...}, fees, penalties,
// cost, gain, net, valueAtHorizon, errors[], warnings[]}.
export function computeProjection({ mainline, ops = [], legs = [], assumptions = {}, scenario = null, primeHistory = [], currentPrime = null, currentMonth, horizonMonths = 360, holdingGrowth = null }) {
  const errors = [];
  const warnings = [];
  const primeHist = scenarioPrimeHistory(primeHistory, scenario);
  const primeForMonth = primeHistoryResolver(primeHist, currentPrime);
  const horizonMonth = addMonthsYm(currentMonth, horizonMonths);

  // ---- mortgage plans -------------------------------------------------
  const plans = new Map(); // propertyId -> {property, terms, segments, lumpSums}
  for (const p of mainline.properties || []) {
    plans.set(p.id, {
      property: p,
      terms: (p.terms || []).map((t) => ({ ...t })),
      segments: (p.segments || []).map((s) => ({ ...s })),
      lumpSums: (p.lumpSums || []).map((l) => ({ ...l })),
    });
  }
  const runPlan = (plan) => {
    const p = plan.property;
    if (p.mortgage_balance == null || !(p.mortgage_balance > 0)) return null;
    if (!plan.segments.length) return null;
    const { frequency, paymentDay } = planScheduleOf(plan);
    return buildSchedule({
      balance: p.mortgage_balance, balanceDate: p.mortgage_balance_date || `${currentMonth}-01`,
      terms: plan.terms, segments: plan.segments, lumpSums: plan.lumpSums,
      paymentDay, frequency, primeRate: currentPrime, primeHistory: primeHist, region: p.region || 'CA',
    });
  };
  const balanceAt = (plan, monthKey) => {
    const r = runPlan(plan);
    if (!r || r.state === 'no_payment' || r.state === 'no_prime') return null;
    return remainingBalanceAt(r.series, monthKey, plan.property.mortgage_balance, r.payoffMonth).balance;
  };
  const termCovering = (plan, dateStr) => {
    let t = null;
    for (const term of plan.terms) if (term.start_date <= dateStr) t = term;
    return t || plan.terms[0] || null;
  };
  const segmentCovering = (plan, monthKey) => segmentForMonth(plan.segments, monthKey);
  const termEndMonthIdx = (term) => {
    if (!term) return -1;
    const start = monthIdxOf(String(term.start_date).slice(0, 7));
    return start + (Number(term.term_months) || 60);
  };

  const penalties = [];
  let fees = 0;
  const implicitLumpSums = []; // {propertyId, date, amount} from sell repay legs (applied below)
  const sortedOps = [...ops].sort((a, b) => (a.seq - b.seq) || (a.id - b.id));

  // Penalty helper shared by break ops. breakKind: the segment type being
  // broken out of. openClosed: 'open' mortgages pay no penalty — the
  // mainline term form does not capture open/closed yet, so v1 takes
  // it as an explicit per-op fact (default 'closed'); a future round
  // should move it onto the term. Returns the penalty record (or null
  // when no penalty).
  const breakPenalty = (plan, dateStr, breakAmount, opts = {}) => {
    const monthKey = dateStr.slice(0, 7);
    const seg = segmentCovering(plan, monthKey);
    if (!seg) return null;
    const term = termCovering(plan, dateStr);
    const endIdx = termEndMonthIdx(term);
    if (endIdx >= 0 && monthIdxOf(monthKey) >= endIdx) return null; // term already over
    if (opts.openClosed === 'open') return null; // open plans pay no penalty
    const kind = seg.rate_type === 'fixed' ? 'fixed_closed' : 'variable_closed';
    const bal = balanceAt(plan, monthKey);
    if (bal == null) return null;
    const contractRate = segmentRateForMonth(seg, monthKey, primeForMonth);
    if (contractRate == null) return null;
    const remaining = endIdx >= 0 ? endIdx - monthIdxOf(monthKey) : 60;
    const comp = opts.comparableRate ?? num(assumptions.comparableRate);
    let penalized = breakAmount;
    let privilegeNote = null;
    if (opts.applyPrivilege) {
      const pct = num(assumptions.privilegePct);
      const opening = term && num(term.opening_balance) != null ? num(term.opening_balance) : bal;
      if (pct == null) {
        privilegeNote = 'no privilege % given — penalty computed on the full amount (upper bound)';
      } else {
        penalized = Math.max(0, breakAmount - (pct / 100) * opening);
      }
    }
    const calc = calcPenalty({
      balanceAtBreak: bal, contractRatePct: contractRate, comparableRatePct: comp,
      remainingMonths: remaining, kind, penalizedAmount: penalized,
    });
    if (calc.penalty == null) return null;
    return {
      propertyId: plan.property.id, date: dateStr, kind, method: calc.method,
      balanceAtBreak: bal, contractRate, comparableRate: comp, remainingMonths: remaining,
      penalizedAmount: penalized, threeMonthInterest: calc.threeMonthInterest, ird: calc.ird,
      penalty: calc.penalty, estimate: true,
      note: privilegeNote || calc.note,
    };
  };

  // Mortgage ops apply to plans in sequence order (stock ops are handled
  // in the stock pass; their repay legs land here as implicit lump sums).
  const mortgageOps = sortedOps.filter((o) => ['prepay', 'rate_switch', 'refinance', 'payment_change'].includes(o.op_type));
  for (const op of mortgageOps) {
    const p = op.params || {};
    const plan = plans.get(Number(p.propertyId));
    if (!plan) { errors.push(`operation ${op.seq} references unknown property ${p.propertyId}`); continue; }
    if (op.op_type === 'prepay') {
      const years = Number(p.recurringYears) || 1;
      for (let y = 0; y < years; y++) {
        const d = addYearsDate(p.date, y);
        plan.lumpSums.push({ property_id: plan.property.id, date: d, amount: num(p.amount) });
      }
      // Penalty on the portion above the annual privilege (fixed/variable
      // closed only; open plans and post-term prepays pay none).
      const pen = breakPenalty(plan, p.date, num(p.amount), { applyPrivilege: true, openClosed: p.openClosed || 'closed' });
      if (pen && pen.penalty > 0) penalties.push({ ...pen, opSeq: op.seq, reason: 'prepayment above annual privilege' });
    }
    if (op.op_type === 'rate_switch') {
      const pen = breakPenalty(plan, p.date, balanceAt(plan, p.date.slice(0, 7)) ?? 0, { openClosed: p.openClosed || 'closed' });
      if (pen && pen.penalty > 0) penalties.push({ ...pen, opSeq: op.seq, reason: 'early rate switch' });
      plan.segments = plan.segments.filter((s) => s.start_date < p.date);
      plan.segments.push({
        property_id: plan.property.id, start_date: p.date,
        rate_type: p.rateType,
        rate_mode: p.rateType === 'variable' ? 'prime_spread' : 'absolute',
        annual_rate: p.rateType === 'fixed' ? num(p.annualRate) : null,
        spread: p.rateType === 'variable' ? num(p.spread) : null,
        compounding: p.compounding || 'semi_annual', accrual: p.accrual || 'monthly',
        locked_on: p.rateType === 'variable' ? p.date : null,
      });
      plan.segments.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    }
    if (op.op_type === 'refinance') {
      const bal = balanceAt(plan, p.date.slice(0, 7));
      const pen = breakPenalty(plan, p.date, bal ?? 0, { openClosed: p.openClosed || 'closed' });
      if (pen && pen.penalty > 0) penalties.push({ ...pen, opSeq: op.seq, reason: 'refinance break' });
      fees += num(p.fees) || 0;
      plan.terms.push({
        property_id: plan.property.id, start_date: p.date,
        term_months: Number(p.termMonths), amortization_years: Number(p.amortizationYears),
        opening_balance: bal, repayment_method: p.repaymentMethod || 'equal_payment',
        payment_override: num(p.paymentOverride) ?? null,
        lender: p.lender || null, payment_frequency: null, payment_day: null,
      });
      plan.terms.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
      plan.segments = plan.segments.filter((s) => s.start_date < p.date);
      plan.segments.push({
        property_id: plan.property.id, start_date: p.date,
        rate_type: p.rateType,
        rate_mode: p.rateType === 'variable' ? 'prime_spread' : 'absolute',
        annual_rate: p.rateType === 'fixed' ? num(p.annualRate) : null,
        spread: p.rateType === 'variable' ? num(p.spread) : null,
        compounding: p.compounding || 'semi_annual', accrual: p.accrual || 'monthly',
        locked_on: p.rateType === 'variable' ? p.date : null,
      });
      plan.segments.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    }
    if (op.op_type === 'payment_change') {
      const term = termCovering(plan, p.date);
      if (term) term.payment_override = num(p.payment);
    }
  }

  // ---- mortgage results ----------------------------------------------
  const mortgagePerProperty = {};
  let baselineInterest = 0;
  let strategyInterest = 0;
  let mortgagePrepayCash = 0;
  for (const op of mortgageOps) if (op.op_type === 'prepay') mortgagePrepayCash += (num(op.params.amount) || 0) * (Number(op.params.recurringYears) || 1);
  for (const [pid, plan] of plans) {
    const base = baselinePlanFor(mainline, pid);
    const baseRun = base ? runPlanShim(base, primeHist, currentPrime, currentMonth) : null;
    const stratRun = runPlan(plan);
    const bInterest = baseRun && baseRun.state !== 'no_payment' && baseRun.state !== 'no_prime' ? baseRun.totalInterest : 0;
    const sInterest = stratRun && stratRun.state !== 'no_payment' && stratRun.state !== 'no_prime' ? stratRun.totalInterest : 0;
    baselineInterest += bInterest;
    strategyInterest += sInterest;
    const lastOpMonth = mortgageOps.length
      ? mortgageOps.map((o) => String(o.params.date || '').slice(0, 7)).sort().pop()
      : currentMonth;
    const effectMonth = lastOpMonth > currentMonth ? lastOpMonth : currentMonth;
    const paymentAtEffect = (run) => {
      if (!run || !run.series.length) return null;
      const row = run.series.find((r) => r.month >= effectMonth) || run.series[run.series.length - 1];
      return row ? row.payment : null;
    };
    mortgagePerProperty[pid] = {
      propertyId: pid,
      baseline: baseRun ? { totalInterest: bInterest, payoffMonth: baseRun.payoffMonth, paymentAtEffect: paymentAtEffect(baseRun), balanceAtHorizon: remainingBalanceAt(baseRun.series, horizonMonth, plan.property.mortgage_balance, baseRun.payoffMonth).balance, series: baseRun.series.filter((r) => r.month <= horizonMonth) } : null,
      strategy: stratRun ? { totalInterest: sInterest, payoffMonth: stratRun.payoffMonth, paymentAtEffect: paymentAtEffect(stratRun), balanceAtHorizon: remainingBalanceAt(stratRun.series, horizonMonth, plan.property.mortgage_balance, stratRun.payoffMonth).balance, series: stratRun.series.filter((r) => r.month <= horizonMonth) } : null,
    };
  }
  const penaltyTotal = round2(penalties.reduce((s, x) => s + (x.penalty || 0), 0));

  // ---- stocks ----------------------------------------------------------
  const returnPct = num(assumptions.stockReturnPct);
  const rAnnual = returnPct == null ? 0 : returnPct / 100;
  // Per-holding current rates (the baseline world): when the run sets
  // no global stock return, each holding grows at its own current
  // rate from its own history; holdings without a usable window stay
  // flat. A global stockReturnPct (strategy factor or sink) wins over
  // every per-holding rate.
  const growthFor = (holding) => {
    if (returnPct != null) return rAnnual;
    if (holdingGrowth && holdingGrowth[holding.id] != null) {
      const g = num(holdingGrowth[holding.id]);
      return g == null ? 0 : g / 100;
    }
    return 0;
  };
  const holdingsById = new Map((mainline.holdings || []).map((h) => [h.id, h]));
  const stockOps = sortedOps.filter((o) => ['buy', 'sell', 'position'].includes(o.op_type));
  // Price path per holding: last stored point ≤ month, grown at the
  // assumed return. Unknown before the first point — never invented.
  const priceAt = (holding, monthKey) => {
    const pts = (holding.pricePoints || []).map((p) => ({ date: String(p.date).slice(0, 10), price: Number(p.price) }))
      .filter((p) => isFinite(p.price)).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!pts.length) return null;
    const cutoff = monthEndOf(monthKey);
    let last = null;
    for (const pt of pts) if (pt.date <= cutoff) last = pt; else break;
    if (!last) return null;
    const months = monthIdxOf(monthKey) - monthIdxOf(last.date.slice(0, 7));
    return last.price * Math.pow(1 + growthFor(holding), months / 12);
  };
  const fxRate = num(mainline.fxRateLatest) || 1;
  const toCad = (holding, v) => (holding.currency === 'USD' ? v * fxRate : v);
  // Baseline units per holding per month (events only, split-restated
  // through the recorded lots — approximated month by month from the
  // event list without splits for ops; recorded splits restate via
  // unitsOn-style accumulation below).
  const baselineUnitsAt = (holding, monthKey) => {
    let u = 0;
    for (const e of holding.events || []) {
      if (String(e.date).slice(0, 7) > monthKey) continue;
      if (e.type === 'buy' || e.type === 'grant' || e.type === 'position') u += Number(e.units) || 0;
      else if (e.type === 'sell') u -= Number(e.units) || 0;
    }
    return round4(u);
  };
  const startingValue = (mainline.holdings || []).reduce((s, h) => {
    const u = baselineUnitsAt(h, currentMonth);
    const pr = priceAt(h, currentMonth);
    return s + (pr == null ? 0 : toCad(h, u * pr));
  }, 0);

  // Op outputs (for leg resolution) + pot simulation, in sequence order.
  const opOutput = new Map(); // seq -> {amount (CAD, native? keep native+CAD), note}
  let pot = 0; // CAD
  const potEvents = [];
  let buyCash = 0;
  let buyCashFromSells = 0; // CAD — buy amount funded by sell earmarks
  let sellExternalOut = 0;
  const holdingValueSeries = {}; // holdingId -> {month: valueCad}
  const opUnitsDelta = new Map(); // holdingId -> [{month, delta}]
  const pushUnitsDelta = (hid, monthKey, delta) => {
    if (!opUnitsDelta.has(hid)) opUnitsDelta.set(hid, []);
    opUnitsDelta.get(hid).push({ month: monthKey, delta });
  };

  for (const op of stockOps) {
    const p = op.params || {};
    const monthKey = String(p.date || '').slice(0, 7);
    if (op.op_type === 'buy') {
      // Resolve target holding (existing by id, else by account+symbol).
      let holding = p.holdingId ? holdingsById.get(Number(p.holdingId)) : null;
      if (!holding && p.symbol) holding = (mainline.holdings || []).find((h) => h.accountId === Number(p.accountId) && String(h.symbol || '').toUpperCase() === String(p.symbol).toUpperCase()) || null;
      const isNew = !holding;
      if (isNew) {
        holding = { id: `new:${op.seq}`, accountId: Number(p.accountId), symbol: p.symbol || null, label: p.symbol || 'New holding', currency: p.currency || 'CAD', events: [], pricePoints: [] };
      }
      const pr = p.price != null ? num(p.price) : priceAt(holding, monthKey);
      if (pr == null) { errors.push(`buy operation ${op.seq} has no price for ${holding.symbol || holding.label} at ${monthKey}`); continue; }
      const units = p.units != null ? num(p.units) : (num(p.amount) != null ? round4(num(p.amount) / pr) : null);
      const amount = p.amount != null ? num(p.amount) : (units != null ? round2(units * pr) : null);
      if (units == null || amount == null || units <= 0 || amount <= 0) { errors.push(`buy operation ${op.seq} needs units or an amount with a price`); continue; }
      // Funding legs must cover the amount (in holding currency; pot is
      // CAD — convert pot draws at the latest FX when the holding is USD).
      const opLegs = (legs || []).filter((l) => l.op_seq === op.seq);
      const resolved = resolveBuyLegs(opLegs, amount, {
        pot, opOutputs: opOutput, declaredAssets: mainline.declaredAssets || [],
        opDate: p.date, holdingCurrency: holding.currency, fxRate, buySeq: op.seq,
      });
      if (resolved.error) { errors.push(`buy operation ${op.seq}: ${resolved.error}`); continue; }
      pot = resolved.pot;
      buyCash += toCad(holding, amount);
      // Sell-earmarked funding is a swap, not new cash: it must not
      // count as cash out nor as opportunity-costed principal.
      buyCashFromSells += toCad(holding, resolved.fromSellsNative || 0);
      pushUnitsDelta(holding.id, monthKey, units);
      opOutput.set(op.seq, { amountCad: toCad(holding, amount), note: 'buy' });
      // A bought holding's price path starts at its buy price, then
      // grows at the assumed return — this is what lets a custom sink
      // (no stored price history) project from its buy price.
      if (isNew && pr != null) holding.pricePoints = [{ date: p.date, price: pr }];
      if (isNew) {
        if (!mainline.holdings.find((h) => h.id === holding.id)) mainline.holdings.push(holding);
        holdingsById.set(holding.id, holding);
      }
    }
    if (op.op_type === 'sell') {
      const holding = holdingsById.get(Number(p.holdingId));
      if (!holding) { errors.push(`sell operation ${op.seq} references unknown holding ${p.holdingId}`); continue; }
      const units = num(p.units);
      const held = baselineUnitsAt(holding, monthKey) + (opUnitsDelta.get(holding.id) || []).filter((d) => d.month <= monthKey).reduce((s, d) => s + d.delta, 0);
      if (units > held + 1e-9) { errors.push(`sell operation ${op.seq} sells ${units} units — only ${round4(held)} held`); continue; }
      const pr = p.price != null ? num(p.price) : priceAt(holding, monthKey);
      if (pr == null) { errors.push(`sell operation ${op.seq} has no price for ${holding.symbol || holding.label} at ${monthKey}`); continue; }
      const proceeds = round2(units * pr);
      pushUnitsDelta(holding.id, monthKey, -units);
      // Proceeds legs: repay → implicit mortgage lump sum; pot/external
      // handled here; buy legs are resolved when the buy op runs.
      const opLegs = (legs || []).filter((l) => l.op_seq === op.seq);
      let remaining = proceeds;
      let toPot = 0;
      for (const leg of opLegs) {
        const src = String(leg.source_ref || '');
        let take = 0;
        if (leg.amount === 'all' || leg.amount === 'remainder') take = remaining;
        else take = Math.min(num(leg.amount) || 0, remaining);
        remaining = round2(remaining - take);
        if (src === 'pot') toPot += take;
        else if (src === 'external_out') sellExternalOut += toCad(holding, take);
        else if (src.startsWith('repay:')) {
          const pid = Number(src.slice(6));
          implicitLumpSums.push({ propertyId: pid, date: p.date, amount: take });
        } else if (src.startsWith('op:')) {
          // Proceeds earmarked for a later buy: park in the earmark
          // bucket for that specific buy op.
          const dep = Number(src.slice(3));
          const key = `sell:${op.seq}:${dep}`;
          const prev = opOutput.get(key) || { amountCad: 0 };
          opOutput.set(key, { amountCad: prev.amountCad + toCad(holding, take) });
        }
      }
      if (remaining > 0) toPot += remaining; // unallocated proceeds park in the pot
      pot = round2(pot + toCad(holding, toPot));
      if (toPot) potEvents.push({ month: monthKey, delta: toCad(holding, toPot) });
      opOutput.set(op.seq, { amountCad: toCad(holding, proceeds), note: 'sell' });
    }
    if (op.op_type === 'position') {
      let holding = p.holdingId ? holdingsById.get(Number(p.holdingId)) : null;
      if (!holding) {
        holding = { id: `new:${op.seq}`, accountId: Number(p.accountId), symbol: p.symbol || null, label: p.symbol || 'New holding', currency: p.currency || 'CAD', events: [], pricePoints: [] };
        mainline.holdings.push(holding);
        holdingsById.set(holding.id, holding);
      }
      pushUnitsDelta(holding.id, monthKey, num(p.units));
      opOutput.set(op.seq, { amountCad: 0, note: 'position' });
    }
  }
  // Implicit mortgage lump sums from sell repay legs land before the
  // final mortgage run: re-run mortgage plans with them included.
  if (implicitLumpSums.length) {
    for (const ls of implicitLumpSums) {
      const plan = plans.get(Number(ls.propertyId));
      if (plan) plan.lumpSums.push({ property_id: ls.propertyId, date: ls.date, amount: ls.amount });
    }
    // Recompute mortgage totals with the implicit sums in.
    let bi = 0; let si = 0;
    for (const [pid, plan] of plans) {
      const base = baselinePlanFor(mainline, pid);
      const baseRun = base ? runPlanShim(base, primeHist, currentPrime, currentMonth) : null;
      const stratRun = runPlan(plan);
      const bI = baseRun && baseRun.state !== 'no_payment' && baseRun.state !== 'no_prime' ? baseRun.totalInterest : 0;
      const sI = stratRun && stratRun.state !== 'no_payment' && stratRun.state !== 'no_prime' ? stratRun.totalInterest : 0;
      bi += bI; si += sI;
      if (mortgagePerProperty[pid] && stratRun) {
        mortgagePerProperty[pid].strategy = {
          totalInterest: sI, payoffMonth: stratRun.payoffMonth,
          paymentAtEffect: mortgagePerProperty[pid].strategy ? mortgagePerProperty[pid].strategy.paymentAtEffect : null,
          balanceAtHorizon: remainingBalanceAt(stratRun.series, horizonMonth, plan.property.mortgage_balance, stratRun.payoffMonth).balance,
          series: stratRun.series.filter((r) => r.month <= horizonMonth),
        };
      }
    }
    baselineInterest = bi; strategyInterest = si;
  }
  const interestSaved = round2(baselineInterest - strategyInterest);

  // Monthly stock value series (holdings + pot).
  const months = [];
  for (let i = monthIdxOf(currentMonth); i <= monthIdxOf(horizonMonth); i++) months.push(ymOfIdx(i));
  let valueAtHorizon = 0;
  const stockSeries = months.map((m) => {
    let v = 0;
    for (const h of mainline.holdings || []) {
      const u = baselineUnitsAt(h, m) + (opUnitsDelta.get(h.id) || []).filter((d) => d.month <= m).reduce((s, d) => s + d.delta, 0);
      const pr = priceAt(h, m);
      if (pr != null && u !== 0) v += toCad(h, u * pr);
    }
    // Pot at month m: pot events are CAD already; approximate the pot
    // as its final value for months after the last op (the pot only
    // moves on op dates, and all ops are dated ≤ horizon in practice).
    valueAtHorizon = v;
    return { month: m, value: round2(v) };
  });
  // Pot at horizon: final pot value (pot moves only on op dates).
  valueAtHorizon = round2((stockSeries.length ? stockSeries[stockSeries.length - 1].value : 0) + pot);
  // Stock gain vs the STARTING value is informational only. The
  // comparison gain is vs the BASELINE trajectory (same return
  // assumption, no ops) — see compareProjections below — so a
  // do-nothing strategy never books market growth as its own gain.
  const stockGainVsStart = round2(valueAtHorizon + sellExternalOut - startingValue);
  // Cost counts only NEW cash out: sell-funded buys are swaps of money
  // already counted in the baseline, not additional spending.
  const cost = round2(fees + penaltyTotal + mortgagePrepayCash + buyCash - buyCashFromSells);

  // Property equity at horizon (planning-only projected total). A
  // property-growth factor grows the assessed value from the current
  // month to the horizon; with no factor the value is held flat.
  let equityAtHorizon = 0;
  const growthPct = num(assumptions.propertyGrowthPct);
  const growthYears = growthPct == null ? 0 : (monthIdxOf(horizonMonth) - monthIdxOf(currentMonth)) / 12;
  for (const [pid, plan] of plans) {
    const assessed = (mainline.assessed || {})[pid] ?? plan.property.assessed_value ?? 0;
    const assessedGrown = growthPct == null ? (assessed || 0) : (assessed || 0) * Math.pow(1 + growthPct / 100, growthYears);
    const strat = mortgagePerProperty[pid] && mortgagePerProperty[pid].strategy;
    const bal = strat ? strat.balanceAtHorizon : (mortgagePerProperty[pid] && mortgagePerProperty[pid].baseline ? mortgagePerProperty[pid].baseline.balanceAtHorizon : plan.property.mortgage_balance || 0);
    equityAtHorizon += assessedGrown - (bal || 0);
  }
  const projectedTotalAtHorizon = round2(equityAtHorizon + valueAtHorizon);

  return {
    mortgage: { perProperty: mortgagePerProperty, baselineInterest: round2(baselineInterest), strategyInterest: round2(strategyInterest), interestSaved },
    stocks: { series: stockSeries, startingValue: round2(startingValue), valueAtHorizon, buyCash: round2(buyCash), buyCashFromSells: round2(buyCashFromSells), sellExternalOut: round2(sellExternalOut), potAtHorizon: round2(pot), gainVsStart: stockGainVsStart },
    fees: round2(fees), penalties, penaltyTotal,
    cost, valueAtHorizon: projectedTotalAtHorizon,
    payoffShiftMonths: payoffShiftOf(mortgagePerProperty),
    paymentDelta: paymentDeltaOf(mortgagePerProperty),
    errors, warnings,
  };
}

function payoffShiftOf(perProperty) {
  // Months earlier (+) / later (−) across properties with a payoff on
  // both sides; null when no property has both.
  let out = null;
  for (const v of Object.values(perProperty)) {
    if (v.baseline && v.strategy && v.baseline.payoffMonth && v.strategy.payoffMonth) {
      const d = monthIdxOf(v.baseline.payoffMonth) - monthIdxOf(v.strategy.payoffMonth);
      out = out == null ? d : out + d;
    }
  }
  return out;
}
function paymentDeltaOf(perProperty) {
  let out = null;
  for (const v of Object.values(perProperty)) {
    if (v.baseline && v.strategy && v.baseline.paymentAtEffect != null && v.strategy.paymentAtEffect != null) {
      const d = round2(v.strategy.paymentAtEffect - v.baseline.paymentAtEffect);
      out = out == null ? d : round2(out + d);
    }
  }
  return out;
}

// Baseline plan for one property, from mainline data as stored.
function baselinePlanFor(mainline, pid) {
  const p = (mainline.properties || []).find((x) => x.id === pid);
  if (!p) return null;
  return { property: p, terms: p.terms || [], segments: p.segments || [], lumpSums: p.lumpSums || [] };
}
// The plan schedule inputs (frequency/day) mirror the server's
// termScheduleOf: current term first, property columns as fallback.
function planScheduleOf(plan) {
  const p = plan.property;
  const terms = plan.terms || [];
  const anchor = p.mortgage_balance_date || '';
  let cur = null;
  for (const t of terms) if (t.start_date <= anchor) cur = t;
  cur = cur || terms[0] || null;
  const frequency = cur && cur.payment_frequency ? cur.payment_frequency
    : (p.payment_frequency || 'monthly');
  const paymentDay = cur && cur.payment_day != null ? cur.payment_day : (p.payment_day ?? null);
  return { frequency, paymentDay };
}
function runPlanShim(plan, primeHist, currentPrime, currentMonth) {
  const p = plan.property;
  if (p.mortgage_balance == null || !(p.mortgage_balance > 0)) return null;
  if (!plan.segments.length) return null;
  const { frequency, paymentDay } = planScheduleOf(plan);
  return buildSchedule({
    balance: p.mortgage_balance, balanceDate: p.mortgage_balance_date || `${currentMonth}-01`,
    terms: plan.terms, segments: plan.segments, lumpSums: plan.lumpSums,
    paymentDay, frequency, primeRate: currentPrime, primeHistory: primeHist, region: p.region || 'CA',
  });
}

// Buy-leg resolution (amount-driven). legs: the buy op's legs.
// available: {pot (CAD), opOutputs: Map seq -> amountCad, declaredAssets,
//   opDate, holdingCurrency, fxRate}. Returns {pot, error?}.
export function resolveBuyLegs(legs, buyAmountNative, { pot, opOutputs, declaredAssets, opDate, holdingCurrency, fxRate, buySeq = null }) {
  const toCadAmt = (native) => (holdingCurrency === 'USD' ? native * fxRate : native);
  const fromCadAmt = (cad) => (holdingCurrency === 'USD' ? cad / fxRate : cad);
  let remainingNative = buyAmountNative;
  let newPot = pot;
  let fromSellsNative = 0; // buy amount funded by sell earmarks (a swap, not new cash)
  // Fixed legs first, then 'all', then 'remainder'.
  const ordered = [...(legs || [])].sort((a, b) => {
    const rank = (x) => (x.amount === 'all' ? 1 : x.amount === 'remainder' ? 2 : 0);
    return rank(a) - rank(b);
  });
  for (const leg of ordered) {
    if (remainingNative <= 0) break;
    const src = String(leg.source_ref || '');
    let availNative = Infinity;
    if (src === 'pot') availNative = fromCadAmt(newPot);
    else if (src.startsWith('op:')) {
      const dep = Number(src.slice(3));
      // Earmarked bucket for this buy first, then the sell's full
      // proceeds (a sell with no earmark legs leaves everything open).
      const key = buySeq != null && opOutputs.has(`sell:${dep}:${buySeq}`) ? `sell:${dep}:${buySeq}`
        : opOutputs.has(dep) ? dep : null;
      const out = key != null ? opOutputs.get(key) : null;
      availNative = out ? fromCadAmt(out.amountCad) : 0;
      if (!out) return { error: `funding leg references operation ${dep}, which produced no spendable output` };
    } else if (src.startsWith('declared:')) {
      const asset = (declaredAssets || []).find((a) => a.id === Number(src.slice(9)));
      if (!asset) return { error: `funding leg references unknown declared asset ${src}` };
      if (asset.maturity_date && asset.maturity_date > opDate) {
        return { error: `declared asset "${asset.name}" matures ${asset.maturity_date}, after this purchase` };
      }
      availNative = Number(asset.amount) || 0;
    } else if (src === 'cash' || src === 'external') availNative = Infinity;
    else return { error: `unknown funding source ${src}` };
    let takeNative;
    if (leg.amount === 'all') takeNative = Math.min(availNative, remainingNative);
    else if (leg.amount === 'remainder') takeNative = remainingNative;
    else takeNative = Math.min(num(leg.amount) || 0, remainingNative);
    if (takeNative > availNative + 1e-9) {
      return { error: `funding leg from ${src} needs ${takeNative}, but only ${availNative} is available` };
    }
    if (src === 'pot') newPot = round2(newPot - toCadAmt(takeNative));
    if (src.startsWith('op:')) {
      fromSellsNative = round2(fromSellsNative + takeNative);
      const dep = Number(src.slice(3));
      const key = buySeq != null && opOutputs.has(`sell:${dep}:${buySeq}`) ? `sell:${dep}:${buySeq}`
        : opOutputs.has(dep) ? dep : null;
      const out = opOutputs.get(key);
      out.amountCad = round2(out.amountCad - toCadAmt(takeNative));
    }
    remainingNative = round2(remainingNative - takeNative);
  }
  if (remainingNative > 0.005) return { error: `funding covers only part of the purchase — ${remainingNative} unfunded` };
  return { pot: newPot, fromSellsNative };
}

function addYearsDate(dateStr, years) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const ny = y + years;
  const dim = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  return `${ny}-${String(m).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

// ------------------------------------------------- comparison + summaries --
// Final comparison numbers for one strategy against its do-nothing
// baseline (no ops, no factors). Baseline net is 0 by construction: it
// pays no fees, no penalty, no prepay, buys nothing, and its stock
// trajectory is the reference the strategy's stock gain is measured
// against — so net here IS the net benefit vs baseline.
export function compareProjections(baseline, strategy) {
  if (!baseline || !strategy) return null;
  // Stock gain vs the do-nothing baseline: only NEW cash deployed
  // (pot/external buys) is opportunity-costed at the baseline ratio
  // (baseline value at horizon / baseline starting value; 1 when
  // there is no starting value, i.e. a cash baseline). Sell-funded
  // buys are swaps — the sold money is already inside the baseline
  // value, so costing it again would double-count it. A flat-price
  // pot buy therefore books $0 stock gain; only the excess over
  // holding the baseline counts. A do-nothing strategy still books $0
  // (buyCash = 0 and identical trajectories).
  const bStart = (baseline.stocks && baseline.stocks.startingValue) || 0;
  const bEnd = (baseline.stocks && baseline.stocks.valueAtHorizon) || 0;
  const buyCash = (strategy.stocks && strategy.stocks.buyCash) || 0;
  const buyCashFromSells = (strategy.stocks && strategy.stocks.buyCashFromSells) || 0;
  const ratio = bStart > 0 ? bEnd / bStart : 1;
  const stockGain = round2((strategy.stocks.valueAtHorizon + strategy.stocks.sellExternalOut) - bEnd - (buyCash - buyCashFromSells) * ratio);
  const interestSaved = strategy.mortgage.interestSaved;
  const cost = strategy.cost;
  const gain = round2(interestSaved + stockGain);
  const net = round2(gain - cost);
  return {
    cost, gain, net,
    interestSaved, stockGain,
    currentPlanRatio: round2(ratio),
    fees: strategy.fees, penaltyTotal: strategy.penaltyTotal,
    payoffShiftMonths: strategy.payoffShiftMonths,
    paymentDelta: strategy.paymentDelta,
    valueAtHorizon: strategy.valueAtHorizon,
    baselineValueAtHorizon: baseline.valueAtHorizon,
    errors: strategy.errors, warnings: strategy.warnings,
  };
}
export const summarizeComparison = compareProjections;

// Principal-gain series for one strategy: month by month, the excess
// of the strategy's holdings value over the do-nothing baseline
// (baseline holdings + new principal grown at the baseline ratio;
// sell-funded buys are swaps and are not costed again). Months align
// on the baseline series; missing months carry the last known
// baseline value forward. Pure — shared by the comparison chart so
// the chart and the table use one definition.
export function principalGainSeries(baselineProj, strategyProj) {
  const base = (baselineProj && baselineProj.stocks && baselineProj.stocks.series) || [];
  const strat = (strategyProj && strategyProj.stocks && strategyProj.stocks.series) || [];
  if (!base.length || !strat.length) return [];
  const start = Number(base[0].value) || 0;
  const buyCash = (strategyProj.stocks && strategyProj.stocks.buyCash) || 0;
  const buyCashFromSells = (strategyProj.stocks && strategyProj.stocks.buyCashFromSells) || 0;
  const newCash = buyCash - buyCashFromSells;
  let lastBase = Number(base[0].value) || 0;
  let bi = 0;
  return strat.map((r) => {
    while (bi < base.length && base[bi].month <= r.month) { lastBase = Number(base[bi].value) || 0; bi++; }
    const ratio = start > 0 ? lastBase / start : 1;
    return { month: r.month, value: round2((Number(r.value) || 0) - lastBase - newCash * ratio) };
  });
}

// AI-designed baseline definition validation (pure, unit-testable).
// Shape: {description, primeScenario: {name, direction, stance,
// magnitude, steps} | null, stockReference: 'current-plan',
// assumptions: [{key, value}]}. Stock reference is always
// 'current-plan' — the comparison math does not accept any other
// reference, so anything else is coerced, never rejected, and the
// caller reports the coercion.
export function validateAiBaseline(b) {
  const errs = [];
  if (!b || typeof b !== 'object') return ['baseline must be an object'];
  if (b.primeScenario !== undefined && b.primeScenario !== null) {
    const ps = b.primeScenario;
    if (!ps.name || !String(ps.name).trim()) errs.push('prime scenario name is required');
    if (!['up', 'flat', 'down'].includes(ps.direction)) errs.push('prime scenario direction must be up, flat or down');
    if (ps.stance !== undefined && ps.stance !== null && !['pessimistic', 'optimistic', 'neutral'].includes(ps.stance)) errs.push('prime scenario stance must be pessimistic, optimistic or neutral');
    if (ps.magnitude !== undefined && ps.magnitude !== null && !isFinite(Number(ps.magnitude))) errs.push('prime scenario magnitude must be a number');
    if (ps.steps !== undefined && ps.steps !== null) {
      if (!Array.isArray(ps.steps)) errs.push('prime scenario steps must be an array of {date, rate}');
      else for (const st of ps.steps) {
        if (!st || !/^\d{4}-\d{2}-\d{2}$/.test(String(st.date || '')) || !isFinite(Number(st.rate))) { errs.push('prime scenario steps must be {date: YYYY-MM-DD, rate: number}'); break; }
      }
    }
  }
  if (b.assumptions !== undefined && b.assumptions !== null && !Array.isArray(b.assumptions)) errs.push('assumptions must be an array');
  return errs;
}

// ------------------------------------------- report-ready series --------
// Pure derivations over one projection trajectory, shared by the report
// view: monthly mortgage balance (summed across properties), monthly
// stock value, and monthly total value. Total value = property equity +
// stock value, where equity = assessed value − outstanding principal
// (the assessed value is the current roll, held flat across months —
// the same convention valueAtHorizon uses). Interest is summed too so
// yearly bars can aggregate without re-walking the engine series.
export function reportMonthlySeries(perProperty, side, stockSeries, assessedTotal, growthPct = null, currentMonth = null) {
  const byMonth = new Map();
  for (const per of Object.values(perProperty || {})) {
    const s = per[side] && per[side].series ? per[side].series : [];
    for (const row of s) {
      const cur = byMonth.get(row.month) || { balance: 0, interest: 0 };
      cur.balance += row.balance || 0;
      cur.interest += row.interest || 0;
      byMonth.set(row.month, cur);
    }
  }
  const stockByMonth = new Map((stockSeries || []).map((r) => [r.month, r.value || 0]));
  for (const m of stockByMonth.keys()) if (!byMonth.has(m)) byMonth.set(m, { balance: 0, interest: 0 });
  const g = num(growthPct);
  return [...byMonth.keys()].sort().map((m) => {
    const b = byMonth.get(m);
    const sv = stockByMonth.get(m) || 0;
    // A property-growth factor grows the assessed value month by month
    // from the current month; with no factor (or no current month) the
    // assessed value is held flat, exactly as before.
    const assessedAt = (g == null || !currentMonth) ? (assessedTotal || 0)
      : (assessedTotal || 0) * Math.pow(1 + g / 100, (monthIdxOf(m) - monthIdxOf(currentMonth)) / 12);
    return {
      month: m,
      mortgage_balance: round2(b.balance),
      stock_value: round2(sv),
      total_value: round2(assessedAt - b.balance + sv),
      interest: round2(b.interest),
    };
  });
}

// Cost breakdown for one strategy comparison: cost = fees + penalty +
// cash out, so cash out (prepay cash + buy cash) is the remainder.
// Penalty is an estimate; the bank quote governs.
export function reportCostBreakdown(comparison) {
  if (!comparison) return null;
  const fees = comparison.fees || 0;
  const penalty = comparison.penaltyTotal || 0;
  const cashOut = round2((comparison.cost || 0) - fees - penalty);
  return { fees: round2(fees), penalty: round2(penalty), cashOut, total: round2(comparison.cost || 0) };
}

// ------------------------------------------- project template metadata --
// TEMPLATE OWNS QUESTIONS: each project template declares its own
// question/metadata schema and which project-page sections it shows.
// A project with no template (created before templates, or Blank) is
// LEGACY: planProjectTemplate returns null and the page keeps the full
// generic panels. Section rule: a section renders only when the
// template's schema includes it — Declared assets is the only
// template-gated section left (sell templates); prime scenarios were
// replaced by per-strategy factors, so no template shows them.
export const PLAN_PROJECT_TEMPLATES = {
  mortgage: {
    key: 'mortgage', label: 'Mortgage payoff',
    sections: { declaredAssets: false },
    fields: [{ key: 'property_id', label: 'Property', type: 'property', required: true }],
  },
  refinance: {
    key: 'refinance', label: 'Refinance / rate switch',
    sections: { declaredAssets: false },
    fields: [{ key: 'property_id', label: 'Property', type: 'property', required: true }],
  },
  buy: {
    key: 'buy', label: 'Buy with funding',
    sections: { declaredAssets: false },
    fields: [{ key: 'account_type', label: 'Account type', type: 'account_type', required: false }],
  },
  sell: {
    key: 'sell', label: 'Sell & redeploy',
    sections: { declaredAssets: true },
    fields: [],
  },
};
// Null = legacy (no template schema): the project page keeps every panel.
export function planProjectTemplate(key) {
  return (key && PLAN_PROJECT_TEMPLATES[key]) || null;
}
// ---- Optimization categories (creation taxonomy) -----------------------
// Big category → subcategories. Each subcategory names the strategy
// shape it recommends; the recommendation itself (baseline definition +
// strategy params, bound to a picked entity's real figures) is computed
// server-side by planRecommendationFor. The taxonomy is data, not a
// closed switch: adding a subcategory is adding one entry here.
// Earning subcategories (salary, rental) mirror the Earnings module's
// two blocks; saving/tax-saving scope to the whole module's data.
export const PLAN_OPT_CATEGORIES = {
  property: {
    key: 'property', label: 'Property', entityType: 'property',
    subcategories: {
      interest_rate: { key: 'interest_rate', label: 'Interest rate', opType: 'rate_switch', strategyLabel: 'Rate switch' },
      refinance: { key: 'refinance', label: 'Refinance', opType: 'refinance', strategyLabel: 'Refinance' },
    },
  },
  investment: {
    key: 'investment', label: 'Investment', entityType: 'investment',
    subcategories: {
      gic: { key: 'gic', label: 'GIC', opType: 'buy', strategyLabel: 'Buy GIC' },
      stock: { key: 'stock', label: 'Stock', opType: 'buy', strategyLabel: 'Buy stock' },
      etf: { key: 'etf', label: 'ETF', opType: 'buy', strategyLabel: 'Buy ETF' },
    },
  },
  earning: {
    key: 'earning', label: 'Earning', entityType: 'earning',
    subcategories: {
      salary: { key: 'salary', label: 'Salary', opType: null, strategyLabel: 'Salary plan' },
      rental: { key: 'rental', label: 'Rental', opType: null, strategyLabel: 'Rental plan' },
    },
  },
  saving: {
    key: 'saving', label: 'Saving', entityType: 'scope',
    subcategories: {
      spending_analysis: { key: 'spending_analysis', label: 'Spending analysis', opType: null, strategyLabel: 'Spending analysis' },
    },
  },
  tax_saving: {
    key: 'tax_saving', label: 'Tax saving', entityType: 'scope',
    subcategories: {
      tax_analysis: { key: 'tax_analysis', label: 'Tax analysis', opType: null, strategyLabel: 'Tax analysis' },
    },
  },
};
export function planOptCategory(key) {
  return (key && PLAN_OPT_CATEGORIES[key]) || null;
}
export function planOptSubcategory(category, subcategory) {
  const c = planOptCategory(category);
  return (c && subcategory && c.subcategories[subcategory]) || null;
}
export function planProjectSections(key) {
  const t = planProjectTemplate(key);
  return t ? t.sections : null;
}
// Human labels for applied strategy templates (op types + AI template).
export const PLAN_STRATEGY_TEMPLATE_LABELS = {
  prepay: 'Prepay', rate_switch: 'Rate switch', refinance: 'Refinance',
  payment_change: 'Payment change', buy: 'Buy', sell: 'Sell', position: 'Position',
  'ai-template': 'AI template',
};
// ---- Strategy factors -------------------------------------------------
// A strategy = ops + user-picked factors. The factor library is
// extensible; every factor is optional and unset means neutral/current
// behavior. Shape (stored as JSON on the strategy row):
//   { prime: { points: [{month: 'YYYY-MM', rate}], preset: key|null },
//     stock: { valuePct, basis?, window? },
//     propertyGrowth: { valuePct }, salaryGrowth: { valuePct },
//     rentGrowth: { valuePct },
//     sink: { kind: 'stock', holdingId, trendPct, basis?, window? }
//           | { kind: 'custom', name, expectedReturnPct } }
// Salary and rent growth are stored and labeled only — the engine has
// no earnings leg, so they do not change numbers yet.
export const PLAN_FACTOR_KEYS = ['prime', 'stock', 'propertyGrowth', 'salaryGrowth', 'rentGrowth', 'sink'];
export const PLAN_PRIME_PRESETS = ['optimistic', 'pessimistic', 'up', 'down', 'flat'];
export function validateStrategyFactors(factors, currentMonth = null) {
  const errs = [];
  if (factors == null) return errs;
  if (typeof factors !== 'object' || Array.isArray(factors)) return ['factors must be an object'];
  for (const k of Object.keys(factors)) if (!PLAN_FACTOR_KEYS.includes(k)) errs.push(`unknown factor ${k}`);
  if (factors.prime != null) {
    const p = factors.prime;
    if (typeof p !== 'object' || Array.isArray(p)) errs.push('prime factor must be an object');
    else {
      if (p.preset != null && !PLAN_PRIME_PRESETS.includes(p.preset)) errs.push(`unknown prime preset ${p.preset}`);
      const pts = p.points;
      if (!Array.isArray(pts)) errs.push('prime points must be an array');
      else {
        let prev = '';
        for (const pt of pts) {
          if (!pt || !/^\d{4}-\d{2}$/.test(String(pt.month || ''))) { errs.push('prime point month must be YYYY-MM'); continue; }
          if (pt.month <= prev) errs.push('prime points must be in increasing month order');
          prev = pt.month;
          if (currentMonth && pt.month < currentMonth) errs.push(`prime point ${pt.month} is in the past`);
          const r = num(pt.rate);
          if (r == null || r < 0 || r > 30) errs.push(`prime point ${pt.month} rate must be between 0 and 30`);
        }
      }
    }
  }
  const pctField = (key, min, max) => {
    const v = factors[key];
    if (v == null) return;
    if (typeof v !== 'object' || Array.isArray(v)) { errs.push(`${key} factor must be an object`); return; }
    const x = num(v.valuePct);
    if (x == null || x < min || x > max) errs.push(`${key} valuePct must be between ${min} and ${max}`);
  };
  pctField('stock', -90, 500);
  pctField('propertyGrowth', -90, 500);
  pctField('salaryGrowth', -90, 500);
  pctField('rentGrowth', -90, 500);
  if (factors.sink != null) {
    const s = factors.sink;
    if (typeof s !== 'object' || Array.isArray(s)) errs.push('sink must be an object');
    else if (s.kind === 'stock') {
      if (!Number.isInteger(s.holdingId)) errs.push('stock sink needs a holdingId');
      const t = num(s.trendPct);
      if (t == null || t < -90 || t > 500) errs.push('stock sink needs a trendPct between -90 and 500');
    } else if (s.kind === 'custom') {
      if (!String(s.name || '').trim()) errs.push('custom sink needs a name');
      const r = num(s.expectedReturnPct);
      if (r == null || r < -90 || r > 500) errs.push('custom sink needs an expectedReturnPct between -90 and 500');
    } else errs.push(`unknown sink kind ${s.kind}`);
  }
  return errs;
}
// Scenario factors: the same world-factor keys as strategy factors,
// minus the sink — a sink is strategy equipment (where the pool goes),
// never part of a world. A scenario carrying a sink is rejected so the
// two specs can never be confused.
export function validateScenarioFactors(factors, currentMonth = null) {
  const errs = validateStrategyFactors(factors, currentMonth);
  if (factors && typeof factors === 'object' && !Array.isArray(factors) && factors.sink != null) {
    errs.push('sink belongs on the strategy, not the scenario');
  }
  return errs;
}

// Stable JSON for grouping factor sets: key order must not split one
// world into two scenarios.
function stableJson(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

// Migration grouping (pure): strategies carrying legacy factors are
// grouped by their world-factor set, sink stripped out first — the sink
// moves to the strategy's sink column, it is not a world. A strategy
// whose factors are empty, or sink-only, yields no group (nothing to
// migrate). Groups are named in order; the server dedupes names against
// scenarios the project already has.
export function groupStrategyFactorsForMigration(strategies) {
  const groups = new Map();
  for (const st of strategies || []) {
    let f = st.factors;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { continue; } }
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const { sink, ...world } = f;
    if (!Object.keys(world).length) continue;
    const key = stableJson(world);
    if (!groups.has(key)) groups.set(key, { factors: world, strategyIds: [] });
    groups.get(key).strategyIds.push(st.id);
  }
  return [...groups.values()].map((g, i) => ({
    name: i === 0 ? 'Default scenario' : `Default scenario ${i + 1}`,
    factors: g.factors,
    strategyIds: g.strategyIds,
  }));
}

// A prime factor's points as a projection scenario (steps the engine
// merges onto the actual prime history). Empty points = no scenario:
// the future holds at the last actual prime (do-nothing behavior).
export function primeFactorToScenario(factors) {
  const pts = factors && factors.prime && Array.isArray(factors.prime.points) ? factors.prime.points : [];
  if (!pts.length) return null;
  return { name: 'Strategy prime', steps: pts.map((p) => ({ date: `${p.month}-01`, rate: num(p.rate) })) };
}
// Factors overlay the confirmed assumptions: a set factor wins, an
// unset one falls back to the confirmed value (or nothing).
export function factorsToAssumptions(factors, confirmed = {}) {
  const f = factors || {};
  const a = { ...confirmed };
  if (f.stock && num(f.stock.valuePct) != null) a.stockReturnPct = num(f.stock.valuePct);
  if (f.propertyGrowth && num(f.propertyGrowth.valuePct) != null) a.propertyGrowthPct = num(f.propertyGrowth.valuePct);
  return a;
}
// View-grouped prime presets: complete paths from the current prime,
// labeled in plain words. Total moves and paces are agent-set defaults
// the user can correct; picking a preset still allows editing points.
//   Optimistic (prime down): falls 2.0 points over 2 years.
//   Pessimistic (prime up): rises 2.0 points over 2 years.
//   Up: rises 1.0 point over 1 year. Down: falls 1.0 point over 1 year.
//   Flat: stays at today's rate (no points).
export const PLAN_PRIME_PRESET_LABELS = {
  optimistic: 'Prime falls 2.0 points over 2 years',
  pessimistic: 'Prime rises 2.0 points over 2 years',
  up: 'Prime rises 1.0 point over 1 year',
  down: 'Prime falls 1.0 point over 1 year',
  flat: 'Prime stays at today\u2019s rate',
};
export function primeFactorPresetPoints(preset, currentPrime, currentMonth) {
  const base = num(currentPrime);
  if (base == null || !currentMonth) return [];
  const at = (months, delta) => ({ month: addMonthsYm(currentMonth, months), rate: round2(Math.max(0, base + delta)) });
  if (preset === 'optimistic') return [at(3, -0.5), at(6, -1.0), at(12, -1.5), at(24, -2.0)];
  if (preset === 'pessimistic') return [at(3, 0.5), at(6, 1.0), at(12, 1.5), at(24, 2.0)];
  if (preset === 'up') return [at(3, 0.25), at(6, 0.5), at(9, 0.75), at(12, 1.0)];
  if (preset === 'down') return [at(3, -0.25), at(6, -0.5), at(9, -0.75), at(12, -1.0)];
  return []; // flat or unknown: no points = hold at today's rate
}
export function planStrategyTemplateLabel(key) {
  return PLAN_STRATEGY_TEMPLATE_LABELS[key] || key || '';
}
// AI snapshot: the app data the ai-model prompt is fed, so it stops
// asking for numbers the app already holds (balances, terms, segments,
// current prime + recent history, accounts, holdings). Pure: the caller
// supplies rows; history is capped to the 12 latest points.
export function buildPlanAiSnapshot({ properties = [], terms = [], segments = [], accounts = [], holdings = [], prime = null, primeHistory = [] } = {}) {
  const props = (properties || []).map((p) => ({
    id: p.id, address: p.address, mortgage_balance: p.mortgage_balance ?? null,
    mortgage_balance_date: p.mortgage_balance_date || null, assessed_value: p.assessed_value ?? null,
  }));
  const termRows = (terms || []).map((t) => ({
    id: t.id, property_id: t.property_id, start_date: t.start_date, term_months: t.term_months,
    amortization_years: t.amortization_years ?? null, opening_balance: t.opening_balance ?? null,
    payment_override: t.payment_override ?? null,
  }));
  const segRows = (segments || []).map((s) => ({
    id: s.id, property_id: s.property_id, term_id: s.term_id ?? null, start_date: s.start_date,
    rate_type: s.rate_type || null, annual_rate: s.annual_rate ?? null, spread: s.spread ?? null,
    locked_on: s.locked_on || null, compounding: s.compounding || null, accrual: s.accrual || null,
  }));
  const hist = (primeHistory || []).slice(-12).map((h) => ({ date: h.date, rate: h.rate }));
  return {
    properties: props, terms: termRows, segments: segRows,
    accounts: (accounts || []).map((a) => ({ id: a.id, name: a.name, type: a.type })),
    holdings: (holdings || []).map((h) => ({ id: h.id, account_id: h.account_id, symbol: h.symbol, label: h.label, currency: h.currency })),
    prime: prime != null ? prime : null, primeHistory: hist,
  };
}
// Structured ask: the ai-model "ask" path returns questions naming
// metadata fields, never a free-text dead end. A legacy string ask
// becomes one text question; anything else is rejected (null).
export function normalizeAiAsk(ask) {
  if (typeof ask === 'string' && ask.trim()) return [{ field: 'answer', label: ask.trim(), type: 'text' }];
  if (Array.isArray(ask)) {
    const out = [];
    for (const q of ask) {
      if (!q || typeof q.field !== 'string' || !q.field.trim()) return null;
      if (typeof q.label !== 'string' || !q.label.trim()) return null;
      const type = ['text', 'number', 'date'].includes(q.type) ? q.type : 'text';
      out.push({ field: q.field.trim(), label: q.label.trim(), type });
    }
    return out.length ? out : null;
  }
  return null;
}
// AI-model conversation thread: turns are {role: 'ai', questions: [...]}
// or {role: 'user', answers: {...}}. The thread is the interaction
// layer — the client renders it, each Design call sends the accumulated
// turns so the model continues the same conversation, and concluded
// answers still land in the template metadata. sanitizeAiThread keeps
// only well-formed turns (cap 50); renderAiThreadText renders it for
// the prompt.
export function sanitizeAiThread(thread) {
  if (!Array.isArray(thread)) return [];
  const out = [];
  for (const t of thread) {
    if (!t || typeof t !== 'object') continue;
    if (t.role === 'ai' && Array.isArray(t.questions)) {
      const qs = t.questions
        .filter((q) => q && typeof q.field === 'string' && q.field.trim() && typeof q.label === 'string' && q.label.trim())
        .map((q) => ({ field: q.field.trim(), label: q.label.trim(), type: ['text', 'number', 'date'].includes(q.type) ? q.type : 'text' }));
      if (qs.length) out.push({ role: 'ai', questions: qs });
    } else if (t.role === 'user' && t.answers && typeof t.answers === 'object' && !Array.isArray(t.answers)) {
      out.push({ role: 'user', answers: t.answers });
    }
  }
  return out.slice(-50);
}
export function appendAiThread(thread, turn) {
  return [...sanitizeAiThread(thread), turn].slice(-50);
}
export function renderAiThreadText(thread) {
  const lines = [];
  for (const t of sanitizeAiThread(thread)) {
    if (t.role === 'ai') for (const q of t.questions) lines.push(`AI asked: ${q.label} (${q.field})`);
    else for (const [k, v] of Object.entries(t.answers)) lines.push(`User answered: ${k} = ${v}`);
  }
  return lines.join('\n');
}
// Strategy-centric comparison deltas.
// Equity Δ (peak advantage): the largest month-by-month total-balance
// advantage the strategy ever holds over baseline, summed across
// properties. Assessed cancels (both sides share the roll), so the
// delta is baseline balance − strategy balance. Series run to payoff,
// so carrying the last row forward past a series end is the payoff
// balance (≈0) — the peak never collapses to 0 just because both loans
// amortize away by the 30-year horizon. Missing runs fall back to the
// other side (delta 0).
export function equityDeltaPeak(strategyProj) {
  if (!strategyProj || !strategyProj.mortgage) return null;
  const per = strategyProj.mortgage.perProperty || {};
  const props = Object.values(per).map((p) => ({
    b: [...(p.baseline?.series || [])].sort((x, y) => (x.month < y.month ? -1 : 1)),
    s: [...(p.strategy?.series || [])].sort((x, y) => (x.month < y.month ? -1 : 1)),
  }));
  const months = new Set();
  for (const p of props) for (const r of [...p.b, ...p.s]) if (r.month != null) months.add(r.month);
  const balAt = (rows, m) => {
    let v = 0;
    for (const r of rows) {
      if (r.month <= m) v = Number(r.balance) || 0;
      else break;
    }
    return v;
  };
  let peak = null;
  for (const m of [...months].sort()) {
    let d = 0;
    for (const p of props) d += balAt(p.b, m) - balAt(p.s, m);
    peak = peak == null ? d : Math.max(peak, d);
  }
  return peak == null ? 0 : round2(peak);
}
// Principal Δ: cash deployed into holdings by buy operations, strategy
// minus baseline. Starting value cancels (both share the snapshot), so
// this is buyCash strategy − buyCash baseline.
export function principalDeltaVsBaseline(baselineProj, strategyProj) {
  if (!baselineProj || !strategyProj) return null;
  const b = (baselineProj.stocks && baselineProj.stocks.buyCash) || 0;
  const s = (strategyProj.stocks && strategyProj.stocks.buyCash) || 0;
  return round2(s - b);
}

// ------------------------------------------- historical return suggestions --
// Pure, from stored price points only. Each suggestion labels its ACTUAL
// covered window; a short window is never labeled as 1y/3y/5y. Windows
// under a year report a non-annualized period return. Returns [] when
// the points cannot support any window.
export function returnSuggestionsFromPoints(points, todayYm) {
  const pts = (points || []).map((p) => ({ date: String(p.date).slice(0, 10), price: Number(p.price) }))
    .filter((p) => isFinite(p.price)).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 2) return [];
  const priceOn = (dateStr) => {
    let last = null;
    for (const p of pts) if (p.date <= dateStr) last = p; else break;
    return last;
  };
  const today = `${todayYm}-28`; // month-end proxy: last point ≤ this date
  const end = priceOn(today) || pts[pts.length - 1];
  const out = [];
  const pushWindow = (label, monthsBack, annualized) => {
    const startYm = addMonthsYm(todayYm, -monthsBack);
    // The start price is the last point in or before the start month
    // (a mid-month point represents that month); a point more than
    // 45 days before the window start is not the window's start.
    const start = priceOn(`${startYm}-31`);
    if (!start) return;
    const startDate = new Date(`${start.date}T00:00:00Z`);
    const wantDate = new Date(`${startYm}-01T00:00:00Z`);
    if (wantDate - startDate > 45 * 86400000) return;
    const ret = end.price / start.price - 1;
    const years = monthsBack / 12;
    out.push({
      label, basis: 'price',
      window: `${start.date.slice(0, 7)} → ${end.date.slice(0, 7)}`,
      periodReturn: round4(ret),
      annualizedReturn: annualized ? round4(Math.pow(1 + ret, 1 / years) - 1) : null,
    });
  };
  pushWindow('1y', 12, true);
  pushWindow('3y', 36, true);
  pushWindow('5y', 60, true);
  // Since-first-point window (non-annualized when under a year).
  const first = pts[0];
  const monthsHeld = monthIdxOf(todayYm) - monthIdxOf(first.date.slice(0, 7));
  const ret = end.price / first.price - 1;
  out.push({
    label: monthsHeld >= 12 ? 'since first price' : 'since first price (period)',
    basis: 'price',
    window: `${first.date.slice(0, 7)} → ${end.date.slice(0, 7)}`,
    periodReturn: round4(ret),
    annualizedReturn: monthsHeld >= 12 ? round4(Math.pow(1 + ret, 12 / Math.max(1, monthsHeld)) - 1) : null,
  });
  return out;
}
// A holding's CURRENT return rate, from its own stored price history
// only — the same basis as the stock-factor trend suggestions. The
// most recent annualized window wins (1y, then 3y, then 5y); a holding
// with no usable window has no rate (flat, never invented). The
// since-first-price window is not a current rate: it spans inception,
// not a recent window.
export function currentReturnRateFromPoints(points, todayYm) {
  const sug = returnSuggestionsFromPoints(points, todayYm);
  for (const label of ['1y', '3y', '5y']) {
    const w = sug.find((x) => x.label === label && x.annualizedReturn != null);
    if (w) return { ratePct: round4(w.annualizedReturn * 100), basis: 'Price CAGR', window: w.window };
  }
  return null;
}

// Pool item SHAPES only (no database): each item names exactly one
// source (an account or a holding) and exactly one contribution (a
// percent OF THAT SOURCE, or a CAD amount from it). Source-value
// checks (amount vs value, price existence, account coverage) live in
// the server validation, which has the database.
export function validatePoolItemShapes(items) {
  if (!Array.isArray(items) || !items.length) return 'pool needs at least one source';
  const seenAccounts = new Set();
  const seenHoldings = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object') return 'pool items need a source';
    const hasAccount = it.accountId != null && it.accountId !== '';
    const hasHolding = it.holdingId != null && it.holdingId !== '';
    if (hasAccount === hasHolding) return 'pool items need exactly one source (an account or a holding)';
    const hasPct = it.percent != null && it.percent !== '';
    const hasAmt = it.amount != null && it.amount !== '';
    if (hasPct === hasAmt) return 'pool items need exactly one contribution (a percent or an amount)';
    if (hasPct) {
      const pct = Number(it.percent);
      if (!isFinite(pct) || pct <= 0 || pct > 100) return 'pool percentages must be above 0 and at most 100';
    } else {
      const amt = Number(it.amount);
      if (!isFinite(amt) || amt <= 0) return 'pool amounts must be above 0';
    }
    if (hasAccount) {
      if (!Number.isInteger(it.accountId)) return 'pool items need an account';
      if (seenAccounts.has(it.accountId)) return 'pool has a duplicate account';
      seenAccounts.add(it.accountId);
    } else {
      if (!Number.isInteger(it.holdingId)) return 'pool items need a holding';
      if (seenHoldings.has(it.holdingId)) return 'pool has a duplicate holding';
      seenHoldings.add(it.holdingId);
    }
  }
  return null;
}


// ------------------------------------------------------- merge-write build --
// Pure: given a strategy's ops (with legs) and the snapshot + current
// mainline rows, build the write list for Merge and detect conflicts.
// writes: [{kind: 'insert'|'update'|'delete', table, rowId?, values,
//   before, after, opSeq, label}]. conflicts: [{table, rowId, field,
//   base, current, incoming, opSeq, label}].
export function buildMergeWrites({ ops, legs, snapshot, current, projection }) {
  const writes = [];
  const conflicts = [];
  const snap = snapshot || {};
  const cur = current || {};
  const findRow = (rows, id) => (rows || []).find((r) => r.id === id) || null;
  const checkModified = (table, rowId, before, after, opSeq, label, fields) => {
    const curRow = findRow(cur[table], rowId);
    const baseRow = findRow(snap[table], rowId);
    if (!curRow) return; // deleted in mainline: merge recreates via insert path, no conflict
    for (const f of fields) {
      const b = baseRow ? baseRow[f] : undefined;
      const c = curRow[f];
      if (JSON.stringify(b) !== JSON.stringify(c)) {
        conflicts.push({ table, rowId, field: f, base: b ?? null, current: c ?? null, incoming: after[f] ?? null, opSeq, label });
      }
    }
  };
  for (const op of [...(ops || [])].sort((a, b) => a.seq - b.seq)) {
    const p = op.params || {};
    if (op.op_type === 'prepay') {
      const years = Number(p.recurringYears) || 1;
      for (let y = 0; y < years; y++) {
        writes.push({ kind: 'insert', table: 'lump_sums', opSeq: op.seq, label: `Prepay $${p.amount} on ${addYearsDate(p.date, y)}`, values: { property_id: Number(p.propertyId), date: addYearsDate(p.date, y), amount: num(p.amount), note: 'Planning merge' } });
      }
    }
    if (op.op_type === 'rate_switch' || op.op_type === 'refinance') {
      // Later segments from the switch date are replaced (recorded so
      // revert restores them); a same-day segment is a modification.
      const segs = (cur.rate_segments || []).filter((s) => s.property_id === Number(p.propertyId) && s.start_date >= p.date);
      for (const s of segs) {
        if (s.start_date === p.date) {
          const after = { rate_type: p.rateType, rate_mode: p.rateType === 'variable' ? 'prime_spread' : 'absolute', annual_rate: p.rateType === 'fixed' ? num(p.annualRate) : null, spread: p.rateType === 'variable' ? num(p.spread) : null };
          writes.push({ kind: 'update', table: 'rate_segments', rowId: s.id, opSeq: op.seq, label: `Rate segment from ${p.date}`, before: s, after, values: after });
          checkModified('rate_segments', s.id, s, after, op.seq, `Rate segment from ${p.date}`, ['rate_type', 'rate_mode', 'annual_rate', 'spread']);
        } else {
          writes.push({ kind: 'delete', table: 'rate_segments', rowId: s.id, opSeq: op.seq, label: `Later rate segment from ${s.start_date}`, before: s });
        }
      }
      if (op.op_type === 'refinance') {
        const bal = projection && projection.refinanceBalance && projection.refinanceBalance[op.seq];
        writes.push({ kind: 'insert', table: 'mortgage_terms', opSeq: op.seq, label: `Refinance term from ${p.date}`, values: { property_id: Number(p.propertyId), start_date: p.date, term_months: Number(p.termMonths), amortization_years: Number(p.amortizationYears), opening_balance: bal ?? null, repayment_method: p.repaymentMethod || 'equal_payment', payment_override: num(p.paymentOverride) ?? null, lender: p.lender || null } });
      }
      writes.push({ kind: 'insert', table: 'rate_segments', opSeq: op.seq, label: `Rate segment from ${p.date}`, values: { property_id: Number(p.propertyId), start_date: p.date, rate_type: p.rateType, rate_mode: p.rateType === 'variable' ? 'prime_spread' : 'absolute', annual_rate: p.rateType === 'fixed' ? num(p.annualRate) : null, spread: p.rateType === 'variable' ? num(p.spread) : null, compounding: p.compounding || 'semi_annual', accrual: p.accrual || 'monthly', locked_on: p.rateType === 'variable' ? p.date : null } });
    }
    if (op.op_type === 'payment_change') {
      const term = (cur.mortgage_terms || []).filter((t) => t.property_id === Number(p.propertyId) && t.start_date <= p.date).pop()
        || (cur.mortgage_terms || []).find((t) => t.property_id === Number(p.propertyId));
      if (term) {
        const after = { payment_override: num(p.payment) };
        writes.push({ kind: 'update', table: 'mortgage_terms', rowId: term.id, opSeq: op.seq, label: `Payment override on term from ${term.start_date}`, before: term, after, values: after });
        checkModified('mortgage_terms', term.id, term, after, op.seq, `Payment override on term from ${term.start_date}`, ['payment_override']);
      }
    }
    if (op.op_type === 'buy' || op.op_type === 'position') {
      writes.push({ kind: 'insert', table: 'invest_events', opSeq: op.seq, label: `${op.op_type === 'buy' ? 'Buy' : 'Position'} ${p.symbol || ''} on ${p.date}`, values: { accountId: Number(p.accountId), holdingId: p.holdingId ? Number(p.holdingId) : null, symbol: p.symbol || null, currency: p.currency || 'CAD', date: p.date, type: op.op_type, units: num(p.units), amount: num(p.amount), price: num(p.price) } });
    }
    if (op.op_type === 'sell') {
      writes.push({ kind: 'insert', table: 'invest_events', opSeq: op.seq, label: `Sell ${p.units} units on ${p.date}`, values: { holdingId: Number(p.holdingId), date: p.date, type: 'sell', units: num(p.units), price: num(p.price) } });
    }
  }
  return { writes, conflicts };
}

// Inverse operations for reverting a merge record. entries carry
// {kind, table, rowId, before, after, values}. Returns {inverse, conflicts}
// where conflicts use the revert three-way: base = merge's after,
// current = mainline now, incoming = merge's before (or deletion).
export function buildRevertInverse({ entries, current }) {
  const inverse = [];
  const conflicts = [];
  const findRow = (rows, id) => (rows || []).find((r) => r.id === id) || null;
  for (const e of entries || []) {
    if (e.kind === 'insert') {
      const curRow = e.rowId ? findRow(current[e.table], e.rowId) : null;
      if (!curRow) continue; // already gone: nothing to undo
      // Modified since merge? Compare stored values, not the row id.
      const afterVals = e.after || e.values || {};
      const changed = Object.keys(afterVals).some((f) => JSON.stringify(curRow[f]) !== JSON.stringify(afterVals[f]));
      if (changed) {
        conflicts.push({ table: e.table, rowId: e.rowId, field: 'record', base: afterVals, current: curRow, incoming: null, label: e.label || `${e.table} #${e.rowId}` });
      } else {
        inverse.push({ kind: 'delete', table: e.table, rowId: e.rowId, label: e.label });
      }
    }
    if (e.kind === 'update') {
      const curRow = findRow(current[e.table], e.rowId);
      if (!curRow) { inverse.push({ kind: 'insert', table: e.table, rowId: e.rowId, values: e.before, label: e.label }); continue; }
      const afterVals = e.after || {};
      const changed = Object.keys(afterVals).some((f) => JSON.stringify(curRow[f]) !== JSON.stringify(afterVals[f]));
      if (changed) {
        for (const f of Object.keys(afterVals)) {
          if (JSON.stringify(curRow[f]) !== JSON.stringify(afterVals[f])) {
            conflicts.push({ table: e.table, rowId: e.rowId, field: f, base: afterVals[f] ?? null, current: curRow[f] ?? null, incoming: (e.before || {})[f] ?? null, label: e.label });
          }
        }
      } else {
        inverse.push({ kind: 'update', table: e.table, rowId: e.rowId, values: e.before, label: e.label });
      }
    }
    if (e.kind === 'delete') {
      // Restoring a deleted segment clashes with a newer segment that
      // starts the same day (it would win the timeline).
      const clash = (current.rate_segments || []).find((s) => s.property_id === (e.before || {}).property_id && s.start_date === (e.before || {}).start_date);
      if (clash) {
        conflicts.push({ table: e.table, rowId: e.rowId, field: 'start_date', base: null, current: clash, incoming: e.before, label: e.label });
      } else {
        inverse.push({ kind: 'insert', table: e.table, values: e.before, label: e.label });
      }
    }
  }
  return { inverse, conflicts };
}
