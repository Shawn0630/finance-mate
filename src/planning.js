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
//  rate_switch {propertyId, date, rateType fixed|variable, annualRate?, spread?, termMonths?, amortizationYears? (fixed only, blank = remaining amortization)}
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
    // Optional amortization override, fixed switches only: blank =
    // the term's remaining amortization; a filled value re-amortizes
    // over that many years (it also matters for refinance, whose own
    // amortizationYears is required).
    if (p.amortizationYears != null) {
      if (!(Number(p.amortizationYears) >= 1 && Number(p.amortizationYears) <= 35)) errs.push('amortization must be 1..35 years');
      else if (p.rateType === 'variable') errs.push('amortization override applies to fixed switches only');
    }
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
export function computeProjection({ mainline, ops = [], legs = [], assumptions = {}, scenario = null, primeHistory = [], currentPrime = null, currentMonth, horizonMonths = 360, holdingGrowth = null, potInitial = 0 }) {
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
      // A fixed switch with an amortization override re-amortizes
      // over X years: split the term at the switch date (the
      // contract term continues — term_months carries the
      // governing term's remaining contract months, so the break
      // horizon is unchanged — and the new term's start derivation
      // prices the payment over exactly X years). Without an
      // override no term is split: the engine's fixed-switch
      // boundary rule derives over the governing term's remaining
      // amortization counted from its start.
      if (p.rateType === 'fixed' && num(p.amortizationYears) != null) {
        const gov = termCovering(plan, p.date);
        const bal = balanceAt(plan, p.date.slice(0, 7));
        const endIdx = termEndMonthIdx(gov);
        const switchIdx = monthIdxOf(p.date.slice(0, 7));
        plan.terms.push({
          property_id: plan.property.id, start_date: p.date,
          term_months: endIdx >= 0 ? Math.max(1, endIdx - switchIdx) : 60,
          amortization_years: Number(p.amortizationYears),
          opening_balance: bal, repayment_method: (gov && gov.repayment_method) || 'equal_payment',
          payment_override: null,
          lender: (gov && gov.lender) || null, payment_frequency: null, payment_day: null,
        });
        plan.terms.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
      }
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
  const byHolding = assumptions.stockReturnByHolding && typeof assumptions.stockReturnByHolding === 'object' ? assumptions.stockReturnByHolding : null;
  // Per-holding current rates (the baseline world): when the run sets
  // no global stock return, each holding grows at its own current
  // rate from its own history; holdings without a usable window stay
  // flat. Precedence: a per-holding scenario override wins over the
  // global stockReturnPct (strategy factor or sink), which wins over
  // every per-holding history rate.
  const growthFor = (holding) => {
    if (byHolding && num(byHolding[holding.id]) != null) return num(byHolding[holding.id]) / 100;
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
  // Flat price: last stored point ≤ month, NOT grown — the price as
  // actually known today. Used only for the comparison headline
  // value at horizon, so 30 years of compounded growth never reads
  // as a present-day balance (user 2026-11-04: $94.6M on a $1.93M
  // property). The grown priceAt above stays the projection's series
  // (growth-scenario pins assert on it); only the headline is flat.
  const priceAtFlat = (holding, monthKey) => {
    const pts = (holding.pricePoints || []).map((p) => ({ date: String(p.date).slice(0, 10), price: Number(p.price) }))
      .filter((p) => isFinite(p.price)).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!pts.length) return null;
    const cutoff = monthEndOf(monthKey);
    let last = null;
    for (const pt of pts) if (pt.date <= cutoff) last = pt; else break;
    if (!last) return null;
    return last.price;
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
  // The pot starts at the pool's external cash (0 for pools without
  // any) — external funding is spendable from the first month.
  const potBase = num(potInitial) || 0;
  let pot = potBase; // CAD
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
      // A pot-funded buy draws the pot down — record it as a pot event
      // so the monthly pot series (below) moves on the buy month, not
      // just on sells. Without this the pot series would miss draws.
      if (resolved.pot !== pot) potEvents.push({ month: monthKey, delta: round2(resolved.pot - pot) });
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

  // Monthly stock value series (holdings only — the cash pot is NOT
  // folded in month by month; it has its own series below. The horizon
  // value adds the pot, so a pot deployment never reads as a loss.)
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
  // Cash-pool balance by month: the pot starts at the pool's external
  // cash and moves only on op dates — sell proceeds parked in the pot
  // raise it, pot-funded buys draw it down. Carried forward between
  // op months, so a pot-funded buy reads as pool down + stock up by
  // the same amount.
  const potSeries = months.map((m) => ({
    month: m,
    value: round2(potBase + potEvents.filter((e) => e.month <= m).reduce((s, e) => s + e.delta, 0)),
  }));
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
  // Flat-price value at horizon (comparison headline ONLY): equity
  // at horizon + units at the horizon month × today's known prices
  // + pot. The delta vs the baseline's flat value is purely the
  // strategy's doing — no common-mode 30-year compounding in it.
  let flatStockAtHorizon = 0;
  for (const h of mainline.holdings || []) {
    const u = baselineUnitsAt(h, horizonMonth) + (opUnitsDelta.get(h.id) || []).filter((d) => d.month <= horizonMonth).reduce((s, d) => s + d.delta, 0);
    const pr = priceAtFlat(h, horizonMonth);
    if (pr != null && u !== 0) flatStockAtHorizon += toCad(h, u * pr);
  }
  const flatValueAtHorizon = round2(equityAtHorizon + flatStockAtHorizon + pot);

  return {
    mortgage: { perProperty: mortgagePerProperty, baselineInterest: round2(baselineInterest), strategyInterest: round2(strategyInterest), interestSaved },
    stocks: { series: stockSeries, potSeries, startingValue: round2(startingValue), valueAtHorizon, flatValueAtHorizon: round2(flatStockAtHorizon + pot), buyCash: round2(buyCash), buyCashFromSells: round2(buyCashFromSells), sellExternalOut: round2(sellExternalOut), potAtHorizon: round2(pot), gainVsStart: stockGainVsStart },
    fees: round2(fees), penalties, penaltyTotal,
    cost, valueAtHorizon: projectedTotalAtHorizon, flatValueAtHorizon,
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

// Property-project entity scope (user rule 2026-11-04): a property
// project's projection world contains ONLY its entity property — the
// creation flow asks which property the project is about, so no other
// property's mortgage may leak into project figures. Pure: filters the
// properties list, leaves holdings/assessed/declared assets untouched.
// A null/invalid id returns the mainline unchanged (legacy and
// non-property projects stay unscoped).
export function scopeMainlineToProperty(mainline, propertyId) {
  if (!mainline || propertyId == null || !Number.isInteger(Number(propertyId))) return mainline;
  const id = Number(propertyId);
  return { ...mainline, properties: (mainline.properties || []).filter((p) => Number(p.id) === id) };
}

// Monthly-payment scope: the payment figure covers ONLY the scoped
// properties — never the project total. Default (no override) is the
// 2026-11-02 op-touched rule: rate_switch, refinance, prepay,
// payment_change, by params.propertyId. Stock ops and funding legs
// never count. No mortgage ops → all null (the client renders '—',
// never the project total). For property projects the 2026-11-04
// entity rule SUBSUMES op-touched: callers pass scopePropertyIds =
// [entityId] and the payment follows the entity property instead.
export function paymentScopeFor(baselineProj, strategyProj, ops, scopePropertyIds = null) {
  const MORTGAGE_PAYMENT_OPS = ['prepay', 'rate_switch', 'refinance', 'payment_change'];
  const propertyIds = Array.isArray(scopePropertyIds)
    ? [...new Set(scopePropertyIds.map(Number).filter(Number.isInteger))]
    : [...new Set((ops || [])
      .filter((o) => MORTGAGE_PAYMENT_OPS.includes(o.op_type))
      .map((o) => Number(o.params && o.params.propertyId))
      .filter(Number.isInteger))];
  const sumSide = (proj, side) => {
    if (!propertyIds.length) return null;
    let sum = null;
    for (const pid of propertyIds) {
      const per = proj && proj.mortgage && proj.mortgage.perProperty && proj.mortgage.perProperty[pid];
      const s = per && per[side];
      if (s && s.paymentAtEffect != null) sum = (sum == null ? 0 : sum) + s.paymentAtEffect;
    }
    return sum;
  };
  const baseline = sumSide(baselineProj, 'baseline');
  const strategy = sumSide(strategyProj, 'strategy');
  return {
    propertyIds,
    baseline,
    strategy,
    delta: (baseline != null && strategy != null) ? round2(strategy - baseline) : null,
  };
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
// opts.excludeStockGain (property-category projects): gain counts
// interest saved ONLY — stockGain is still computed and returned, but
// never summed into gain or net, so net = gain − cost keeps holding.
export function compareProjections(baseline, strategy, opts = {}) {
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
  const gain = opts.excludeStockGain ? round2(interestSaved) : round2(interestSaved + stockGain);
  const net = round2(gain - cost);
  // Value at horizon is the FLAT-price figure (equity at horizon +
  // units at horizon × today's known prices + pot) — the grown
  // 30-year projection value stays on the projection itself
  // (projection.valueAtHorizon) and never surfaces as a headline
  // balance. The flat fallback keeps hand-built projections (unit
  // fixtures without flatValueAtHorizon) behaving as before.
  // Investment scope: the flat value is the portfolio only (flat
  // stock + pot) — property equity from the mainline's summed
  // equityAtHorizon must not leak into a pool project's headline.
  const flatStrat = opts.investmentScope
    ? ((strategy.stocks && strategy.stocks.flatValueAtHorizon != null) ? strategy.stocks.flatValueAtHorizon : strategy.flatValueAtHorizon)
    : strategy.flatValueAtHorizon;
  const flatBase = opts.investmentScope
    ? ((baseline.stocks && baseline.stocks.flatValueAtHorizon != null) ? baseline.stocks.flatValueAtHorizon : baseline.flatValueAtHorizon)
    : baseline.flatValueAtHorizon;
  const valueStrat = flatStrat != null ? flatStrat : strategy.valueAtHorizon;
  const valueBase = flatBase != null ? flatBase : baseline.valueAtHorizon;
  return {
    cost, gain, net,
    interestSaved, stockGain,
    currentPlanRatio: round2(ratio),
    fees: strategy.fees, penaltyTotal: strategy.penaltyTotal,
    payoffShiftMonths: strategy.payoffShiftMonths,
    paymentDelta: strategy.paymentDelta,
    valueAtHorizon: valueStrat,
    baselineValueAtHorizon: valueBase,
    errors: strategy.errors, warnings: strategy.warnings,
  };
}
export const summarizeComparison = compareProjections;

// ------------------------------------------- report variables -------
// A report variable is an adjustable control bound to an engine
// input, saved WITH the report (never on the strategy — the same
// strategy can be read under different what-ifs in different
// reports). Shape: { penalty: { [strategyId]: amount } } — penalty
// is the only variable so far; other variables arrive by name and
// add their own key, never by inventing one here. Amounts are ≥ 0;
// the penalty variable REPLACES the engine's penalty estimate in
// cost (default $0: cost excludes penalty unless typed).
// What-if never writes: the client holds edits in memory and only
// PUTs the report on Apply.
export function validateReportVariables(vars) {
  const errs = [];
  if (vars == null) return errs;
  if (typeof vars !== 'object' || Array.isArray(vars)) return ['variables must be an object'];
  if (vars.penalty !== undefined && vars.penalty !== null) {
    if (typeof vars.penalty !== 'object' || Array.isArray(vars.penalty)) errs.push('penalty variables must be an object keyed by strategy id');
    else for (const [sid, v] of Object.entries(vars.penalty)) {
      if (v == null) continue;
      if (!isFinite(Number(v)) || Number(v) < 0) errs.push(`penalty for strategy ${sid} must be a number ≥ 0`);
    }
  }
  return errs;
}
export function reportPenaltyFor(vars, strategyId) {
  if (!vars || !vars.penalty) return 0;
  const v = vars.penalty[String(strategyId)];
  if (v == null || !isFinite(Number(v)) || Number(v) < 0) return 0;
  return round2(Number(v));
}
// Overlay the report's variables on one strategy's comparison:
// cost = engine cost − engine penalty estimate + penalty variable;
// net = gain − cost (the net = gain − cost invariant holds after
// the overlay). Gain is untouched — penalty never moves a
// trajectory, only cost. Pure — the client applies it on every
// render (live what-if + saved variables alike); the engine's own
// cost semantics never change.
export function applyReportVariables(comparison, vars, strategyId) {
  if (!comparison) return null;
  const penalty = reportPenaltyFor(vars, strategyId);
  const enginePenalty = round2(comparison.penaltyTotal || 0);
  const cost = round2((comparison.cost || 0) - enginePenalty + penalty);
  const gain = round2(comparison.gain || 0);
  return { ...comparison, penalty, cost, net: round2(gain - cost) };
}

// ------------------------------------------- AI engine ------------
// The AI engine is a calculation DEFINITION the app executes —
// never a model, never evaluated by the model. Shape:
//   { inputs: [{key, label, default}], series: {<id>: expr}, scalars: {<id>: expr} }
// Delta contract: anything the definition does NOT override is the
// preset engine's figure. Series overrides are monthly formulas
// over the base series; scalar overrides are headline formulas over
// the base scalars. Expressions are numbers, identifiers, + - * /
// ( ), unary minus, min(a, b), max(a, b) — parsed by the tiny
// recursive-descent parser below; there is no eval/Function
// anywhere in this path, so a hostile or malformed definition can
// only produce a validation error, never code execution.
// Base series ids are the reportMonthlySeries row keys; base scalar
// ids are the comparison fields. A series formula may use series +
// scalar ids (scalars broadcast across months); a scalar formula
// may use scalar ids + inputs only (a monthly series has no single
// value to reduce to).
export const AI_ENGINE_SERIES = ['mortgage_balance', 'stock_value', 'total_value', 'pool_balance', 'interest', 'principal'];
export const AI_ENGINE_SCALARS = ['cost', 'gain', 'net', 'interestSaved', 'stockGain', 'valueAtHorizon', 'payoffShiftMonths', 'paymentDelta', 'fees', 'penaltyTotal'];
function aiExprTokens(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const n = Number(src.slice(i, j));
      if (!isFinite(n)) throw new Error(`bad number '${src.slice(i, j)}'`);
      toks.push({ t: 'num', v: n }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    if ('+-*/(),'.includes(ch)) { toks.push({ t: ch }); i++; continue; }
    throw new Error(`unexpected character '${ch}'`);
  }
  return toks;
}
function aiExprParse(src) {
  const toks = aiExprTokens(String(src || ''));
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  function parseExpr() {
    let node = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = next().t;
      node = { k: 'bin', op, l: node, r: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = next().t;
      node = { k: 'bin', op, l: node, r: parseFactor() };
    }
    return node;
  }
  function parseFactor() {
    const tk = peek();
    if (!tk) throw new Error('unexpected end of expression');
    if (tk.t === '-') { next(); return { k: 'neg', x: parseFactor() }; }
    if (tk.t === 'num') { next(); return { k: 'num', v: tk.v }; }
    if (tk.t === '(') {
      next();
      const node = parseExpr();
      if (!peek() || peek().t !== ')') throw new Error('missing closing parenthesis');
      next();
      return node;
    }
    if (tk.t === 'id') {
      next();
      if (peek() && peek().t === '(') {
        if (tk.v !== 'min' && tk.v !== 'max') throw new Error(`unknown function '${tk.v}' — only min/max are allowed`);
        next();
        const a = parseExpr();
        if (!peek() || peek().t !== ',') throw new Error(`'${tk.v}' needs two arguments`);
        next();
        const b = parseExpr();
        if (!peek() || peek().t !== ')') throw new Error(`missing closing parenthesis after '${tk.v}' arguments`);
        next();
        return { k: 'fn', fn: tk.v, a, b };
      }
      return { k: 'id', v: tk.v };
    }
    throw new Error(`unexpected token '${tk.t}'`);
  }
  const ast = parseExpr();
  if (p < toks.length) throw new Error(`trailing input '${toks.slice(p).map((t) => t.v || t.t).join(' ')}'`);
  return ast;
}
function aiExprIds(ast, out = new Set()) {
  if (ast.k === 'id') out.add(ast.v);
  else if (ast.k === 'bin') { aiExprIds(ast.l, out); aiExprIds(ast.r, out); }
  else if (ast.k === 'neg') aiExprIds(ast.x, out);
  else if (ast.k === 'fn') { aiExprIds(ast.a, out); aiExprIds(ast.b, out); }
  return out;
}
function aiExprEval(ast, ctx) {
  // ctx: identifier -> number | number[] (monthly). Arrays evaluate
  // element-wise; scalars broadcast. Division by zero and
  // non-finite results are errors, never silent infinities.
  if (ast.k === 'num') return ast.v;
  if (ast.k === 'id') {
    if (!(ast.v in ctx)) throw new Error(`unknown identifier '${ast.v}'`);
    return ctx[ast.v];
  }
  if (ast.k === 'neg') {
    const v = aiExprEval(ast.x, ctx);
    return Array.isArray(v) ? v.map((x) => -x) : -v;
  }
  if (ast.k === 'fn') {
    const a = aiExprEval(ast.a, ctx);
    const b = aiExprEval(ast.b, ctx);
    const f = ast.fn === 'min' ? Math.min : Math.max;
    if (Array.isArray(a) || Array.isArray(b)) {
      const arr = Array.isArray(a) ? a : b;
      return arr.map((_, i) => f(Array.isArray(a) ? a[i] : a, Array.isArray(b) ? b[i] : b));
    }
    return f(a, b);
  }
  const l = aiExprEval(ast.l, ctx);
  const r = aiExprEval(ast.r, ctx);
  const op = (a, b) => {
    let v;
    if (ast.op === '+') v = a + b;
    else if (ast.op === '-') v = a - b;
    else if (ast.op === '*') v = a * b;
    else if (ast.op === '/') {
      if (b === 0) throw new Error('division by zero');
      v = a / b;
    }
    if (!isFinite(v)) throw new Error('non-finite result');
    return v;
  };
  if (Array.isArray(l) || Array.isArray(r)) {
    const arr = Array.isArray(l) ? l : r;
    return arr.map((_, i) => op(Array.isArray(l) ? l[i] : l, Array.isArray(r) ? r[i] : r));
  }
  return op(l, r);
}
function aiExprCheckFinite(v, what) {
  const bad = Array.isArray(v) ? v.some((x) => x == null || !isFinite(x)) : (v == null || !isFinite(v));
  if (bad) throw new Error(`${what} evaluated to a non-finite value`);
}
export function validateAiEngine(engine) {
  const errs = [];
  if (engine == null) return errs; // no engine = preset figures throughout
  if (typeof engine !== 'object' || Array.isArray(engine)) return ['engine must be an object'];
  const inputs = engine.inputs == null ? [] : engine.inputs;
  if (!Array.isArray(inputs)) errs.push('engine.inputs must be an array');
  const inputKeys = new Set();
  if (Array.isArray(inputs)) {
    for (const inp of inputs) {
      if (!inp || typeof inp !== 'object') { errs.push('engine input must be an object {key, label, default}'); continue; }
      if (!inp.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(inp.key))) errs.push('engine input key must be a valid identifier');
      else if (inputKeys.has(inp.key)) errs.push(`duplicate engine input '${inp.key}'`);
      else inputKeys.add(inp.key);
      if (inp.default != null && !isFinite(Number(inp.default))) errs.push(`engine input '${inp.key}' default must be a number`);
    }
  }
  const allowedSeries = new Set([...AI_ENGINE_SERIES, ...AI_ENGINE_SCALARS, ...inputKeys]);
  const allowedScalar = new Set([...AI_ENGINE_SCALARS, ...inputKeys]);
  for (const [where, map, allowed, kinds] of [
    ['series', engine.series, allowedSeries, AI_ENGINE_SERIES],
    ['scalars', engine.scalars, allowedScalar, AI_ENGINE_SCALARS],
  ]) {
    if (map == null) continue;
    if (typeof map !== 'object' || Array.isArray(map)) { errs.push(`engine.${where} must be an object`); continue; }
    for (const [id, expr] of Object.entries(map)) {
      if (!kinds.includes(id)) { errs.push(`engine.${where} '${id}' is not a known ${where === 'series' ? 'series' : 'scalar'} id`); continue; }
      if (typeof expr !== 'string' || !expr.trim()) { errs.push(`engine.${where} '${id}' needs a formula`); continue; }
      try {
        const ast = aiExprParse(expr);
        for (const name of aiExprIds(ast)) {
          if (!allowed.has(name)) errs.push(`engine.${where} '${id}' uses unknown identifier '${name}'`);
        }
        if (where === 'series') {
          // A series formula referencing only scalars is a flat line —
          // allowed (it is still a monthly series), so no extra rule.
        }
      } catch (e) { errs.push(`engine.${where} '${id}': ${e.message}`); }
    }
  }
  return errs;
}
// Old → new diff for an AI-refined report definition (follow-up
// preview): chart titles added/removed/changed + engine keys
// added/removed/changed per map. Pure — the refine endpoint returns
// it alongside the complete revised definition; Apply writes via
// the report PUT, never from the refine call itself.
export function aiReportDefinitionDiff(oldDef, newDef) {
  const diff = {
    charts: { added: [], removed: [], changed: [] },
    engine: { changed: false, series: { added: [], removed: [], changed: [] }, scalars: { added: [], removed: [], changed: [] }, inputs: { added: [], removed: [], changed: [] } },
  };
  const byTitle = (charts) => new Map((charts || []).map((c) => [c.title, c]));
  const oc = byTitle(oldDef && oldDef.charts);
  const nc = byTitle(newDef && newDef.charts);
  for (const [t, c] of nc) {
    if (!oc.has(t)) diff.charts.added.push(t);
    else if (JSON.stringify(oc.get(t)) !== JSON.stringify(c)) diff.charts.changed.push(t);
  }
  for (const t of oc.keys()) if (!nc.has(t)) diff.charts.removed.push(t);
  const mapDiff = (oldMap, newMap) => {
    const out = { added: [], removed: [], changed: [] };
    for (const [k, v] of Object.entries(newMap || {})) {
      if (!(k in (oldMap || {}))) out.added.push(k);
      else if (JSON.stringify(oldMap[k]) !== JSON.stringify(v)) out.changed.push(k);
    }
    for (const k of Object.keys(oldMap || {})) if (!(k in (newMap || {}))) out.removed.push(k);
    return out;
  };
  const oe = (oldDef && oldDef.engine) || {};
  const ne = (newDef && newDef.engine) || {};
  diff.engine.series = mapDiff(oe.series, ne.series);
  diff.engine.scalars = mapDiff(oe.scalars, ne.scalars);
  const oldInputs = Object.fromEntries((oe.inputs || []).map((i) => [i.key, i]));
  const newInputs = Object.fromEntries((ne.inputs || []).map((i) => [i.key, i]));
  diff.engine.inputs = mapDiff(oldInputs, newInputs);
  diff.engine.changed = [...Object.values(diff.engine.series), ...Object.values(diff.engine.scalars), ...Object.values(diff.engine.inputs)].some((a) => a.length > 0);
  return diff;
}
// Execute an AI engine definition over one strategy's preset-engine
// figures. base: { monthly: [{mortgage_balance, stock_value,
// total_value, pool_balance, interest, principal, ...}], scalars:
// {cost, gain, net, ...} }. Returns { series, scalars, inputs,
// errors } — series are monthly arrays (same length as base.monthly),
// scalars are numbers; on any evaluation error the whole engine is
// rejected (errors non-empty, figures fall back to the preset ones
// at the call site — never a half-executed definition).
export function evaluateAiEngine(engine, base) {
  const out = { series: {}, scalars: {}, inputs: {}, errors: [] };
  if (!engine) return out;
  const months = (base && base.monthly) || [];
  const n = months.length;
  const inputVals = {};
  for (const inp of engine.inputs || []) {
    if (inp && inp.key) {
      inputVals[inp.key] = inp.default != null ? Number(inp.default) : 0;
      out.inputs[inp.key] = inputVals[inp.key];
    }
  }
  const ctx = { ...inputVals };
  for (const sid of AI_ENGINE_SERIES) ctx[sid] = months.map((r) => (r[sid] == null ? 0 : Number(r[sid])));
  for (const sid of AI_ENGINE_SCALARS) ctx[sid] = base && base.scalars && base.scalars[sid] != null ? Number(base.scalars[sid]) : 0;
  try {
    for (const [id, expr] of Object.entries(engine.series || {})) {
      const v = aiExprEval(aiExprParse(expr), ctx);
      if (!Array.isArray(v) || v.length !== n) throw new Error(`series '${id}' did not evaluate to ${n} monthly values`);
      aiExprCheckFinite(v, `series '${id}'`);
      out.series[id] = v.map((x) => round2(x));
    }
    for (const [id, expr] of Object.entries(engine.scalars || {})) {
      const v = aiExprEval(aiExprParse(expr), ctx);
      if (Array.isArray(v)) throw new Error(`scalar '${id}' evaluated to a monthly series, not a number`);
      aiExprCheckFinite(v, `scalar '${id}'`);
      out.scalars[id] = round2(v);
    }
  } catch (e) {
    out.errors.push(e.message);
    out.series = {};
    out.scalars = {};
  }
  return out;
}

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

// Pure-AI project creation: structural shape of a proposed trio.
// Semantic checks (scenario factors, baseline definition, op engine
// validation, name-ref binding) run server-side on top of this; this
// helper only pins the shape so a malformed model reply surfaces as
// named errors instead of a crash or a half-shaped preview. The
// baseline name falls back to its description, mirroring the
// ai-baseline apply path; assumptions are kept raw so a non-array
// value is flagged by validateAiBaseline instead of silently coerced.
export function validateAiCreateProposal(parsed) {
  const errs = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { proposal: null, errors: ['proposal must be an object'] };
  const project = parsed.project && typeof parsed.project === 'object' && !Array.isArray(parsed.project) ? parsed.project : {};
  const scenario = parsed.scenario && typeof parsed.scenario === 'object' && !Array.isArray(parsed.scenario) ? parsed.scenario : {};
  const baseline = parsed.baseline && typeof parsed.baseline === 'object' && !Array.isArray(parsed.baseline) ? parsed.baseline : {};
  const strategy = parsed.strategy && typeof parsed.strategy === 'object' && !Array.isArray(parsed.strategy) ? parsed.strategy : {};
  if (!project.name || !String(project.name).trim()) errs.push('project name is required');
  if (!scenario.name || !String(scenario.name).trim()) errs.push('scenario name is required');
  if (scenario.factors !== undefined && (typeof scenario.factors !== 'object' || scenario.factors === null || Array.isArray(scenario.factors))) errs.push('scenario factors must be an object');
  if (!baseline.name && !baseline.description) errs.push('baseline needs a name or a description');
  if (baseline.assumptions !== undefined && baseline.assumptions !== null && !Array.isArray(baseline.assumptions)) errs.push('baseline assumptions must be an array');
  if (!strategy.name || !String(strategy.name).trim()) errs.push('strategy name is required');
  if (strategy.ops !== undefined && !Array.isArray(strategy.ops)) errs.push('strategy ops must be an array');
  const ops = Array.isArray(strategy.ops) ? strategy.ops : [];
  for (const [i, o] of ops.entries()) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push(`operation ${i + 1} must be an object`); continue; }
    if (!OP_TYPES.includes(o.op_type)) errs.push(`operation ${i + 1} has unknown type ${o.op_type}`);
    if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) errs.push(`operation ${i + 1} needs params`);
  }
  const proposal = {
    project: { name: project.name ? String(project.name).trim() : '', question: project.question ? String(project.question) : null },
    scenario: { name: scenario.name ? String(scenario.name).trim() : '', factors: scenario.factors && typeof scenario.factors === 'object' && !Array.isArray(scenario.factors) ? scenario.factors : {} },
    baseline: { name: baseline.name ? String(baseline.name).trim() : (baseline.description ? String(baseline.description).trim() : ''), description: baseline.description ? String(baseline.description) : '', assumptions: baseline.assumptions },
    strategy: { name: strategy.name ? String(strategy.name).trim() : '', ops },
  };
  return { proposal, errors: errs };
}

// ------------------------------------------- report-ready series --------
// Pure derivations over one projection trajectory, shared by the report
// view: monthly mortgage balance (summed across properties), monthly
// stock value, and monthly total value. Total value = property equity +
// stock value, where equity = assessed value − outstanding principal
// (the assessed value is the current roll, held flat across months —
// the same convention valueAtHorizon uses). Interest and scheduled
// principal are summed too so yearly bars and the payment breakdown
// can aggregate without re-walking the engine series.
export function reportMonthlySeries(perProperty, side, stockSeries, assessedTotal, growthPct = null, currentMonth = null, opts = {}) {
  const byMonth = new Map();
  // Investment scope: the trajectory months are the stock ∪ pool
  // months only. Mortgage months must not seed the table — a pool
  // report's first month is the stock series start, not the
  // mortgage series start (which 0-pads stock_value and drags the
  // table back to Feb 2025 with 0/0/0 rows).
  if (!opts.investmentScope) {
    for (const per of Object.values(perProperty || {})) {
      const s = per[side] && per[side].series ? per[side].series : [];
      for (const row of s) {
        const cur = byMonth.get(row.month) || { balance: 0, interest: 0, principal: 0 };
        cur.balance += row.balance || 0;
        cur.interest += row.interest || 0;
        cur.principal += row.principal || 0;
        byMonth.set(row.month, cur);
      }
    }
  }
  const stockByMonth = new Map((stockSeries || []).map((r) => [r.month, r.value || 0]));
  for (const m of stockByMonth.keys()) if (!byMonth.has(m)) byMonth.set(m, { balance: 0, interest: 0, principal: 0 });
  const poolByMonth = new Map(((opts.poolSeries) || []).map((r) => [r.month, r.value || 0]));
  if (opts.investmentScope) for (const m of poolByMonth.keys()) if (!byMonth.has(m)) byMonth.set(m, { balance: 0, interest: 0, principal: 0 });
  const g = num(growthPct);
  return [...byMonth.keys()].sort().map((m) => {
    const b = byMonth.get(m);
    const sv = stockByMonth.get(m) || 0;
    // A property-growth factor grows the assessed value month by month
    // from the current month; with no factor (or no current month) the
    // assessed value is held flat, exactly as before.
    const assessedAt = (g == null || !currentMonth) ? (assessedTotal || 0)
      : (assessedTotal || 0) * Math.pow(1 + g / 100, (monthIdxOf(m) - monthIdxOf(currentMonth)) / 12);
    const pool = poolByMonth.get(m) || 0;
    return {
      month: m,
      mortgage_balance: round2(b.balance),
      stock_value: round2(sv),
      pool_balance: round2(pool),
      // Investment scope: the trajectory total is the investment
      // portfolio only (cash pool + stocks) — property equity must
      // not swamp it. Every other scope keeps the old definition.
      total_value: opts.investmentScope ? round2(pool + sv) : round2(assessedAt - b.balance + sv),
      interest: round2(b.interest),
      // Scheduled principal (the payment split) — lump sums deduct
      // balance directly and never flow into this field, so the
      // breakdown caption says "scheduled".
      principal: round2(b.principal),
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

// ---- Report scenario pinning -------------------------------------------
// A report renders under PINNED scenarios only, never a silent fallback:
// ids must be an array of this project's scenario ids, and when the
// project has scenarios at least one must be pinned. An empty pin on a
// scenario-less project is the flat world (labeled "Current rates (no
// scenario)" in the view), not a fallback — it is the only world there.
// Returns an error string, or null when the pin is valid.
export function validateReportScenarioIds(ids, projectScenarioIds) {
  if (!Array.isArray(ids)) return 'scenario_ids must be an array';
  const known = new Set((projectScenarioIds || []).map(Number));
  for (const id of ids) {
    if (!Number.isFinite(Number(id)) || !known.has(Number(id))) return `scenario ${id} is not in this project`;
  }
  if (known.size > 0 && ids.length === 0) return 'pin at least one scenario';
  return null;
}

// ---- AI report calculation methods --------------------------------------
// Every chart in an AI-generated report must carry its own calculation
// method (plain language, supplied by the AI). Engine-path reports get
// their how-calculated lines from the app's own definitions instead, so
// this check applies to the ai-report path only. Returns error strings.
export function validateAiChartMethods(charts) {
  const errs = [];
  if (!Array.isArray(charts)) return ['charts must be an array'];
  for (const c of charts) {
    if (!c.method || !String(c.method).trim()) errs.push(`chart "${c.title || c.template || ''}" needs a calculation method`);
  }
  return errs;
}

// Report-viewer series support: which series ids each report chart
// template can actually render. The viewer silently drops anything
// else — stacked_bar totals over the surviving datasets, so a
// cost-only stacked_bar used to render an all-zero "Total" line
// (user bug 2026-11-03: "Cost Comparison Across Strategies" with a
// MONTH | TOTAL table of $0.00). fan_band and funds_flow ignore
// series entirely, so they are not validated here. Absent or empty
// series is NOT an error: the renderer falls back to its default
// series for that template.
export const PLAN_REPORT_SERIES_BY_TEMPLATE = {
  time_line: ['mortgage_balance', 'stock_value', 'total_value', 'pool_balance'],
  yearly_bars: ['mortgage_balance', 'stock_value', 'total_value', 'pool_balance'],
  stacked_bar: ['mortgage_balance', 'stock_value'],
  metric_cards: ['cost', 'gain', 'net', 'stock_gain', 'payoff_month', 'monthly_payment'],
  share_doughnut: ['cost', 'mortgage_balance', 'total_value'],
};
export function validateAiReportChartSeries(charts) {
  const errs = [];
  if (!Array.isArray(charts)) return ['charts must be an array'];
  for (const c of charts) {
    const allowed = PLAN_REPORT_SERIES_BY_TEMPLATE[c.template];
    if (!allowed) continue;
    if (!Array.isArray(c.series) || !c.series.length) continue;
    for (const sid of c.series) {
      if (!allowed.includes(sid)) errs.push(`chart "${c.title || c.template}" (${c.template}) cannot render series "${sid}" — allowed: ${allowed.join(', ')}`);
    }
  }
  return errs;
}

// AI-report prompt, built pure so unit tests can pin its grounding.
// The viewer renders over the whole snapshot (not the project
// entity), so availability counts are snapshot-wide. A cash-pool
// project's stock series covers only its pool — the render-time
// no-data note is the backstop for that case.
// Baseline kind (user 2026-11-04): report content follows the
// baseline, not the ops — a cash-pool baseline allows pool/stock
// charts only (mortgage charts are forbidden and rejected server-
// side), a property baseline allows property charts.
export function aiReportRefinePrompt({ strategies, mortgagedCount, holdingCount, baselineKind, definition, text }) {
  const base = aiReportPrompt({ strategies, mortgagedCount, holdingCount, text, baselineKind });
  return [
    base,
    'You are REFINING an existing report definition — return the COMPLETE revised definition (charts + engine), never a partial patch.',
    `Current definition: ${JSON.stringify(definition)}`,
    'Keep every chart and engine formula that still fits; change only what the follow-up asks for. The revised definition must satisfy every rule above (templates, series, methods, engine identifiers).',
    `Follow-up: ${text}`,
  ].join('\n');
}

export function aiReportPrompt({ strategies, mortgagedCount, holdingCount, text, baselineKind }) {
  const kindLine = baselineKind === 'pool'
    ? 'Baseline kind: cash pool. This report covers a cash pool, not a property: use ONLY pool/stock charts (time_line, yearly_bars, stacked_bar with pool_balance and/or stock_value; metric_cards with cost, gain, net, stock_gain only). Mortgage charts are FORBIDDEN here: never use fan_band, never use the mortgage_balance or total_value series, and never use the monthly_payment or payoff_month metric series — such a chart is rejected.'
    : baselineKind === 'property'
      ? 'Baseline kind: property. This report covers one property: use property charts (mortgage_balance, total_value for equity, monthly_payment, payoff_month) and the pool/stock charts only where the strategies actually touch stocks.'
      : null;
  return [
    'You compose a report definition as JSON only. No prose outside the JSON object.',
    'A report is an ordered list of charts over already-computed results: {"title": "short report title", "charts": [{"template": "...", "title": "...", "series": ["..."], "method": "..."}]}.',
    'Template is one of time_line, stacked_bar, share_doughnut, yearly_bars, fan_band, funds_flow, metric_cards.',
    'Series ids are: mortgage_balance, stock_value, total_value, pool_balance, cost, gain, net, payoff_month, monthly_payment.',
    'Each template renders only its own series: time_line and yearly_bars render trajectory series (mortgage_balance, stock_value, total_value, pool_balance); stacked_bar renders only mortgage_balance (stacked by property) and stock_value; metric_cards renders only cost, gain, net, stock_gain, payoff_month, monthly_payment; share_doughnut renders cost (a cost breakdown) or mortgage_balance/total_value (equity). Never put a series on a template that cannot render it — the chart would come out empty.',
    'Never invent a number: the app computes every series; you only order and title charts.',
    'Each chart carries "method": one plain-language sentence stating how its figures are calculated (which series, measured against what baseline). A chart without a method is rejected.',
    // The AI engine: alongside the charts you may define a
    // calculation the app EXECUTES (the preset engine cannot express
    // it — e.g. a fixed-rate GIC, a custom growth path). "engine":
    // {"inputs": [{"key": "gic_rate", "label": "GIC rate %/yr", "default": 4.12}],
    // "series": {"stock_value": "stock_value + ..."}, "scalars": {"gain": "..."}}.
    // Formulas use numbers, identifiers, + - * / ( ) and min/max only.
    // Series formulas are monthly: they may use the monthly series
    // mortgage_balance, stock_value, total_value, pool_balance,
    // interest, principal, the scalars below (broadcast), and your
    // declared inputs. Scalar formulas may use only the scalars
    // cost, gain, net, interestSaved, stockGain, valueAtHorizon,
    // payoffShiftMonths, paymentDelta, fees, penaltyTotal and your
    // inputs. Anything you do not override keeps the preset engine\'s
    // figure. An "engine" key is REQUIRED in your reply — use {} when
    // the preset engine already covers every figure (no custom
    // calculation needed). Unknown identifiers or unknown series /
    // scalar ids are rejected, as is any formula that is not a number
    // expression.',
    ...(kindLine ? [kindLine] : []),
    `Charts render over the whole snapshot: ${mortgagedCount} ${mortgagedCount === 1 ? 'property carries' : 'properties carry'} a mortgage, ${holdingCount} stock ${holdingCount === 1 ? 'holding exists' : 'holdings exist'}. Do not use mortgage_balance when no property carries a mortgage, and do not use stock_value when no stock holding exists.`,
    `Strategies: ${JSON.stringify(strategies)}`,
    `User request: ${text}`,
  ].join('\n');
}

// Baseline-kind chart validation for AI reports ONLY (the preset
// POST stays permissive — the viewer enforces at render, and legacy
// saved definitions are never rewritten). On a cash-pool baseline
// every mortgage-family chart is rejected: fan_band always; a
// trajectory/stacked chart whose effective series is mortgage_balance
// (an empty series defaults to it, matching the viewer); a doughnut
// carrying mortgage_balance/total_value; metric cards carrying
// monthly_payment/payoff_month. Other baseline kinds pass untouched.
export function validateAiReportBaselineKind(charts, baselineKind) {
  const errs = [];
  if (baselineKind !== 'pool') return errs;
  if (!Array.isArray(charts)) return errs;
  for (const c of charts) {
    if (!c || typeof c !== 'object') continue;
    const title = c.title || c.template;
    const series = Array.isArray(c.series) && c.series.length ? c.series : null;
    if (c.template === 'fan_band') { errs.push(`chart "${title}" (fan_band) is a mortgage chart and is forbidden on a cash-pool baseline`); continue; }
    if (c.template === 'time_line' || c.template === 'yearly_bars' || c.template === 'stacked_bar') {
      const eff = series || ['mortgage_balance'];
      if (eff.includes('mortgage_balance')) errs.push(`chart "${title}" (${c.template}) uses mortgage_balance, forbidden on a cash-pool baseline`);
      continue;
    }
    if (c.template === 'share_doughnut') {
      if (series && (series.includes('mortgage_balance') || series.includes('total_value'))) errs.push(`chart "${title}" (share_doughnut) uses a mortgage/equity series, forbidden on a cash-pool baseline`);
      continue;
    }
    if (c.template === 'metric_cards') {
      if (series && (series.includes('monthly_payment') || series.includes('payoff_month'))) errs.push(`chart "${title}" (metric_cards) uses a mortgage metric, forbidden on a cash-pool baseline`);
    }
  }
  return errs;
}

// AI name suggestion (pure, so unit tests can pin it): a short name
// only — never an explanation, never auto-saved (the client fills
// the Name field as an editable draft). Strategy names come from the
// OP SEQUENCE (op types + key params, e.g. "Jan to Fix", "pre pay
// 50000"); the entity is context only, never the naming basis.
// Scenario names come from the factors. With no factors/ops yet, the
// prompt says so and the model names from category/entity context.
export function aiSuggestNamePrompt(kind, context) {
  const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  if (kind === 'strategy') {
    const ops = Array.isArray(ctx.ops) ? ctx.ops : [];
    const opsLine = ops.length
      ? `Operation sequence — name the strategy from these ops (op types + key params like dates, amounts, rate targets; e.g. a January switch to fixed is "Jan to Fix", a $50,000 prepay is "pre pay 50000"): ${JSON.stringify(ops)}`
      : 'No operations entered yet — name it from the project context alone.';
    const lines = ['You propose a short name for a financial planning strategy. Reply with the name ONLY — a few words, no explanation, no quotes, no JSON.', opsLine];
    if (ctx.description) lines.push(`Description: ${ctx.description}`);
    if (ctx.entityLabel) lines.push(`Project entity (context only, NOT the naming basis): ${ctx.entityLabel}`);
    if (ctx.category) lines.push(`Project category: ${ctx.category}`);
    return lines.join('\n');
  }
  const factors = ctx.factors && typeof ctx.factors === 'object' && !Array.isArray(ctx.factors) ? ctx.factors : {};
  const lines = ['You propose a short name for a planning scenario (a future world). Reply with the name ONLY — a few words, no explanation, no quotes, no JSON.'];
  lines.push(Object.keys(factors).length
    ? `Scenario factors — name it from these: ${JSON.stringify(factors)}`
    : 'No factors entered yet — name it from the project context alone.');
  if (ctx.category) lines.push(`Project category: ${ctx.category}`);
  if (ctx.entityLabel) lines.push(`Project entity (context): ${ctx.entityLabel}`);
  return lines.join('\n');
}
// Clean a suggested name: a parsed {name} object, a bare string, or
// raw model text (first line, quotes stripped, capped at 80 chars).
// Empty in = empty out (the caller then reports "no name").
export function cleanAiSuggestedName(raw) {
  if (raw == null) return '';
  let text = '';
  if (typeof raw === 'object') text = typeof raw.name === 'string' ? raw.name : '';
  else text = String(raw);
  text = text.trim().split('\n')[0].trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return text.slice(0, 80);
}

// Report definition edit (block delete / AI append): structural only,
// deliberately looser than the POST spec check — a delete must never
// be blocked by a legacy chart the renderer already tolerates as
// "Not rendered". Each chart still needs a template and a title so
// the block list stays renderable.
export function validateReportDefinition(def) {
  if (def == null || typeof def !== 'object' || Array.isArray(def)) return ['definition must be an object'];
  const errs = [];
  if (def.charts !== undefined) {
    if (!Array.isArray(def.charts)) errs.push('definition.charts must be an array');
    else for (const c of def.charts) {
      if (!c || typeof c !== 'object' || typeof c.template !== 'string' || !c.template || typeof c.title !== 'string' || !c.title) errs.push('each chart needs a template and a title');
    }
  }
  // Report variables (saved with the report) and the AI engine
  // definition travel inside the definition too — same validation as
  // the dedicated endpoints, so a PUT can never store a bad one.
  if (def.variables !== undefined) errs.push(...validateReportVariables(def.variables));
  if (def.engine !== undefined) errs.push(...validateAiEngine(def.engine));
  return errs;
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
  // A byHolding-only stock factor (per-holding overrides, no global
  // default) is legal: the global range check applies only when a
  // global valuePct is actually set. An empty stock object (neither)
  // still fails, as before.
  const stockByHoldingOnly = factors.stock && typeof factors.stock === 'object' && !Array.isArray(factors.stock)
    && factors.stock.byHolding != null && num(factors.stock.valuePct) == null;
  if (!stockByHoldingOnly) pctField('stock', -90, 500);
  // Per-holding scenario overrides: {holdingId: {valuePct, basis?,
  // window?}} — each valuePct in the same range as the global stock
  // factor. A non-object entry or an out-of-range value is rejected.
  if (factors.stock && typeof factors.stock === 'object' && !Array.isArray(factors.stock) && factors.stock.byHolding != null) {
    const bh = factors.stock.byHolding;
    if (typeof bh !== 'object' || Array.isArray(bh)) errs.push('stock byHolding must be an object');
    else for (const [hid, v] of Object.entries(bh)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`stock byHolding ${hid} must be an object`); continue; }
      const x = num(v.valuePct);
      if (x == null || x < -90 || x > 500) errs.push(`stock byHolding ${hid} valuePct must be between -90 and 500`);
    }
  }
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
  if (f.stock && f.stock.byHolding && typeof f.stock.byHolding === 'object' && !Array.isArray(f.stock.byHolding)) {
    const m = {};
    for (const [k, v] of Object.entries(f.stock.byHolding)) {
      const x = v && typeof v === 'object' ? num(v.valuePct) : num(v);
      if (x != null) m[k] = x;
    }
    if (Object.keys(m).length) a.stockReturnByHolding = m;
  }
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
// Scenario prime preset expansion (pure): the ai-design prompt allows
// prime as {"preset": ...} with NO points, but validateScenarioFactors
// demands points be an array — a preset-only reply failed validation
// deterministically. Expanding here aligns the two: a known preset
// with missing/empty points gains its path (flat = [] = hold); a
// preset with points already present, or an unknown preset, passes
// through untouched (the validator still rejects the unknown one).
export function expandScenarioPrimePreset(factors, currentPrime, currentMonth) {
  if (!factors || typeof factors !== 'object' || Array.isArray(factors)) return factors;
  const p = factors.prime;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return factors;
  if (p.preset == null || !PLAN_PRIME_PRESETS.includes(p.preset)) return factors;
  if (Array.isArray(p.points) && p.points.length) return factors;
  return { ...factors, prime: { ...p, points: primeFactorPresetPoints(p.preset, currentPrime, currentMonth) } };
}
// Compact existing-project summaries for AI design prompts (pure):
// names + factor/definition/op summaries, never full JSON dumps — the
// model sees what the project already holds so it refines instead of
// duplicating. Callers supply parsed rows (scenario factors objects,
// baseline definitions, strategy ops with parsed params).
export function planProjectAiSummaries({ scenarios = [], baselines = [], strategies = [], opsByStrategy = {} } = {}) {
  return {
    scenarios: (scenarios || []).map((sc) => ({ name: sc.name, is_base: !!sc.is_base, factors: sc.factors || null })),
    baselines: (baselines || []).map((b) => {
      const def = b.definition || {};
      return { name: b.name, source: b.source || null, description: def.description || null, assumptions: Array.isArray(def.assumptions) ? def.assumptions : [] };
    }),
    strategies: (strategies || []).map((s) => ({
      name: s.name, letter: s.letter || null, source: s.source || null,
      ops: (opsByStrategy[s.id] || []).map((o) => {
        let params = o.params || {};
        if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
        return { seq: o.seq, op_type: o.op_type, date: params.date || null, params };
      }),
      sink: (() => { try { return s.sink ? JSON.parse(s.sink) : null; } catch { return null; } })(),
    })),
  };
}
// Self-repair prompt builder (pure): one retry feeding the exact
// validation errors back, so the model fixes the named rules instead
// of re-emitting the same invalid spec. The caller still validates
// the repair and surfaces its errors if it fails too.
export function aiRepairPrompt(basePrompt, errs) {
  return `${basePrompt}\nYour previous response failed validation: ${(errs || []).join('; ')}. Fix exactly these problems and return the complete corrected JSON now (do not return an ask list).`;
}
export function planStrategyTemplateLabel(key) {
  return PLAN_STRATEGY_TEMPLATE_LABELS[key] || key || '';
}
// AI snapshot: the app data the ai-model prompt is fed, so it stops
// asking for numbers the app already holds (balances, terms, segments,
// current prime + recent history, accounts, holdings, jobs, rentals).
// Pure: the caller supplies rows; history is capped to the 12 latest
// points.
export function buildPlanAiSnapshot({ properties = [], terms = [], segments = [], accounts = [], holdings = [], jobs = [], rentals = [], prime = null, primeHistory = [] } = {}) {
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
    jobs: (jobs || []).map((j) => ({ id: j.id, employer: j.employer, province: j.province || null, frequency: j.frequency || null, gross_amount: j.gross_amount ?? null, gross_basis: j.gross_basis || null })),
    rentals: (rentals || []).map((r) => ({ id: r.id, label: r.label, address: r.address || null, rental_type: r.rental_type || null, ownership_pct: r.ownership_pct ?? null })),
    prime: prime != null ? prime : null, primeHistory: hist,
  };
}
// Structured ask: the ai-model "ask" path returns questions naming
// metadata fields, never a free-text dead end. A legacy string ask
// becomes one text question; anything else is rejected (null).
// Duplicate fields are collapsed (first wins): the model repeating a
// question in one round must never surface twice in the form.
export function normalizeAiAsk(ask) {
  if (typeof ask === 'string' && ask.trim()) return [{ field: 'answer', label: ask.trim(), type: 'text' }];
  if (Array.isArray(ask)) {
    const out = [];
    const seen = new Set();
    for (const q of ask) {
      if (!q || typeof q.field !== 'string' || !q.field.trim()) return null;
      if (typeof q.label !== 'string' || !q.label.trim()) return null;
      const field = q.field.trim();
      if (seen.has(field)) continue;
      seen.add(field);
      const type = ['text', 'number', 'date'].includes(q.type) ? q.type : 'text';
      out.push({ field, label: q.label.trim(), type });
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
// Latest question label for a field, from the ai turns seen so far in
// the thread (a user answer pairs with the question it answered).
export function aiThreadQuestionLabel(thread, field) {
  let label = null;
  for (const t of sanitizeAiThread(thread)) {
    if (t.role !== 'ai') continue;
    for (const q of t.questions) if (q.field === field) label = q.label;
  }
  return label;
}
export function renderAiThreadText(thread) {
  const lines = [];
  const seen = [];
  for (const t of sanitizeAiThread(thread)) {
    if (t.role === 'ai') {
      for (const q of t.questions) lines.push(`AI asked: ${q.label}`);
      seen.push(t);
    } else {
      for (const [k, v] of Object.entries(t.answers)) {
        const label = aiThreadQuestionLabel(seen, k);
        lines.push(label ? `User answered "${label}": ${v}` : `User answered: ${v}`);
      }
    }
  }
  return lines.join('\n');
}
// AI-model name binding: the user picks entities by NAME, never by
// database id (they cannot know ids). Candidates come from the app
// snapshot; term labels carry their property address + start date so
// two terms on one property stay distinguishable.
export function planAiEntityCandidates(snapshot) {
  const snap = snapshot || {};
  const props = (snap.properties || []).map((p) => ({ id: p.id, label: p.address || `Property ${p.id}` }));
  const addressOf = (pid) => {
    const p = (snap.properties || []).find((x) => Number(x.id) === Number(pid));
    return p ? (p.address || `Property ${p.id}`) : `Property ${pid}`;
  };
  return {
    properties: props,
    terms: (snap.terms || []).map((t) => ({ id: t.id, label: `${addressOf(t.property_id)} · ${t.start_date || ''}`.replace(/ · $/, '') })),
    accounts: (snap.accounts || []).map((a) => ({ id: a.id, label: a.name || `Account ${a.id}` })),
    holdings: (snap.holdings || []).map((h) => ({ id: h.id, label: h.label && h.label !== h.symbol ? `${h.symbol} (${h.label})` : (h.symbol || h.label || `Holding ${h.id}`) })),
  };
}
// Which entity a question/answer field picks, if any. Only bare names
// and name/id suffixes count — value fields that merely mention an
// entity (e.g. property_tax_rate) are not picks.
export function aiAskEntityType(field) {
  if (typeof field !== 'string') return null;
  const m = field.trim().toLowerCase().match(/^(property|term|account|holding)(_(id|name|address|choice|selection))?$/);
  return m ? m[1] : null;
}
const AI_ENTITY_WORD = { property: 'property', term: 'term', account: 'account', holding: 'holding' };
const AI_ENTITY_PLURAL = { property: 'properties', term: 'terms', account: 'accounts', holding: 'holdings' };
// Hard enforcement of the never-ask-for-ids rule: a question naming a
// database id is rewritten to a name pick with the snapshot's named
// candidates in the label, so the user never sees an id question even
// when the model disobeys the prompt rule.
export function rewriteAiIdQuestions(questions, candidates) {
  const cands = candidates || {};
  return (questions || []).map((q) => {
    const entity = aiAskEntityType(q.field);
    if (!entity || !/_id$/.test(q.field.trim().toLowerCase())) return q;
    const list = (cands[AI_ENTITY_PLURAL[entity]] || []).map((c) => c.label);
    return {
      ...q,
      field: AI_ENTITY_WORD[entity],
      label: list.length ? `Which ${entity}? Choose by name: ${list.join('; ')}` : `Which ${entity}?`,
    };
  });
}
// Answered once = answered: drop questions whose field already has an
// answer in the thread or in the current answers payload.
export function dropAnsweredAiQuestions(questions, thread, answers) {
  const answered = new Set();
  for (const t of sanitizeAiThread(thread)) {
    if (t.role === 'user') for (const k of Object.keys(t.answers || {})) answered.add(k);
  }
  if (answers && typeof answers === 'object') for (const k of Object.keys(answers)) answered.add(k);
  return (questions || []).filter((q) => !answered.has(q.field));
}
// Bind name answers to snapshot entities server-side. Returns resolved
// picks (field → entity id) and mismatches: an answer matching nothing
// (or several candidates ambiguously) is a mismatch the caller must
// surface with the named candidates, never a silent re-ask. Numeric
// answers equal to a candidate id still resolve (legacy id answers).
export function bindAiNameAnswers(answers, candidates) {
  const cands = candidates || {};
  const resolved = [];
  const mismatches = [];
  if (!answers || typeof answers !== 'object') return { resolved, mismatches };
  for (const [field, raw] of Object.entries(answers)) {
    const entity = aiAskEntityType(field);
    if (!entity) continue;
    const list = cands[AI_ENTITY_PLURAL[entity]] || [];
    if (!list.length) continue;
    const value = raw == null ? '' : String(raw).trim();
    if (!value) continue;
    const num = Number(value);
    if (value !== '' && !Number.isNaN(num)) {
      const byId = list.find((c) => Number(c.id) === num);
      if (byId) { resolved.push({ field, entity, id: byId.id, label: byId.label }); continue; }
    }
    const norm = value.toLowerCase();
    const exact = list.find((c) => c.label.toLowerCase() === norm);
    if (exact) { resolved.push({ field, entity, id: exact.id, label: exact.label }); continue; }
    const sub = list.filter((c) => c.label.toLowerCase().includes(norm));
    if (sub.length === 1) { resolved.push({ field, entity, id: sub[0].id, label: sub[0].label }); continue; }
    mismatches.push({ field, value, entity, ambiguous: sub.length > 1, candidates: (sub.length > 1 ? sub : list).map((c) => c.label) });
  }
  return { resolved, mismatches };
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
    // External funding: new cash from outside the app — a sourceless
    // leg, amount only (a percent of nothing is meaningless).
    if (it.source === 'external') {
      if ((it.accountId != null && it.accountId !== '') || (it.holdingId != null && it.holdingId !== '')) return 'an external pool item has no account or holding';
      if (it.percent != null && it.percent !== '') return 'external pool funding is an amount, not a percent';
      const amt = Number(it.amount);
      if (!isFinite(amt) || amt <= 0) return 'pool amounts must be above 0';
      continue;
    }
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

// External cash in a pool entity: the sum of its sourceless legs.
// Pure — the server seeds the projection pot with this (both runs),
// so external funding is spendable cash, not a display-only number.
export function poolExternalCash(entity) {
  if (!entity || entity.type !== 'pool' || !Array.isArray(entity.items)) return 0;
  let total = 0;
  for (const it of entity.items) {
    if (it && it.source === 'external') total += Number(it.amount) || 0;
  }
  return round2(total);
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
      // A fixed switch with an amortization override splits the
      // term at the switch date, mirroring the projection: the new
      // term amortizes over X years while the contract term
      // continues (term_months = the governing term's remaining
      // contract months). Without an override the merge stays
      // segment-only — the engine's fixed-switch boundary rule
      // derives over the governing term's remaining amortization.
      if (op.op_type === 'rate_switch' && p.rateType === 'fixed' && num(p.amortizationYears) != null) {
        const gov = (cur.mortgage_terms || []).filter((t) => t.property_id === Number(p.propertyId) && t.start_date <= p.date).pop()
          || (cur.mortgage_terms || []).find((t) => t.property_id === Number(p.propertyId));
        const govEnd = gov ? monthIdxOf(String(gov.start_date).slice(0, 7)) + (Number(gov.term_months) || 60) : -1;
        const switchIdx = monthIdxOf(String(p.date).slice(0, 7));
        const bal = projection && projection.switchBalance && projection.switchBalance[op.seq];
        writes.push({ kind: 'insert', table: 'mortgage_terms', opSeq: op.seq, label: `Switch term from ${p.date}`, values: { property_id: Number(p.propertyId), start_date: p.date, term_months: govEnd >= 0 ? Math.max(1, govEnd - switchIdx) : 60, amortization_years: Number(p.amortizationYears), opening_balance: bal ?? null, repayment_method: (gov && gov.repayment_method) || 'equal_payment', payment_override: null, lender: (gov && gov.lender) || null } });
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
