// Mortgage projection engine (pure functions, no I/O).
//
// The interest convention itself is region-specific and comes from
// the region implementation (src/regions/): for Canada a quoted
// annual rate is nominal with semi-annual compounding, so the
// equivalent monthly rate is
//   i = (1 + r/2)^(1/6) - 1        (r = annual rate as a fraction)
// Fixed and variable segments use the same formula. A variable
// segment priced off prime resolves MONTH BY MONTH against the
// tracked prime history (src/prime.js): each projected month pays
// the prime in effect in that month, and only months beyond the
// last stored observation hold at the latest known prime.
import { getRegion } from './regions/index.js';

export function monthlyRate(annualRatePct) {
  return getRegion('CA').periodRate(annualRatePct, 12);
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// --------------------------------------------------------- payment frequency --
// The six Canadian mortgage payment frequencies. The rate per
// payment period comes from the region implementation (Canada:
//   i = (1 + r/2)^(2/N) - 1        (N = periods per year)
// — nominal with semi-annual compounding. For monthly (N = 12)
// that is exactly monthlyRate() above.
// stepDays > 0 marks the day-stepped schedules (weekly / bi-weekly);
// monthly and semi-monthly step by calendar months instead.
export const FREQUENCIES = {
  monthly: { label: 'Monthly', periodsPerYear: 12, stepDays: 0 },
  semi_monthly: { label: 'Semi-monthly', periodsPerYear: 24, stepDays: 0 },
  bi_weekly: { label: 'Bi-weekly', periodsPerYear: 26, stepDays: 14 },
  accelerated_bi_weekly: { label: 'Accelerated bi-weekly', periodsPerYear: 26, stepDays: 14, accelerated: true },
  weekly: { label: 'Weekly', periodsPerYear: 52, stepDays: 7 },
  accelerated_weekly: { label: 'Accelerated weekly', periodsPerYear: 52, stepDays: 7, accelerated: true },
};
export const FREQUENCY_KEYS = Object.keys(FREQUENCIES);

export function periodicRate(annualRatePct, periodsPerYear, regionCode = 'CA') {
  return getRegion(regionCode).periodRate(annualRatePct, periodsPerYear);
}

// The stored payment is a MONTHLY amount; the per-period amount follows
// the Canadian convention. Regular schedules keep the same yearly total
// (monthly * 12 / N). Accelerated schedules pay monthly/2 every two
// weeks (monthly/4 weekly) — 13 monthly payments per year instead of
// 12, which is exactly what makes them "accelerated".
export function periodPaymentFor(monthlyPayment, frequencyKey) {
  const m = Number(monthlyPayment);
  if (frequencyKey === 'accelerated_bi_weekly') return round2(m / 2);
  if (frequencyKey === 'accelerated_weekly') return round2(m / 4);
  const f = FREQUENCIES[frequencyKey] || FREQUENCIES.monthly;
  return round2((m * 12) / f.periodsPerYear);
}

// 'YYYY-MM-DD' -> { y, m } with m 1..12
function parseYM(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  return { y, m };
}

// Last day of month m (1..12) of year y.
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The calendar date a projected month's node falls on. With a payment
// day (the day the payment is deducted) the node is that day of the
// month; without one it is the balance date's day-of-month (the monthly
// anniversary). Either way it clamps to the month's last day.
function nodeDate({ y, m }, dayOfMonth) {
  const d = Math.min(dayOfMonth, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nextMonth({ y, m }) {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

function ymKey({ y, m }) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

// The annual rate a segment effectively carries, in %.
//   - fixed segments, and variable segments priced as an absolute
//     number (rate_mode 'absolute' or unset — the pre-prime shape):
//     their stored annual_rate.
//   - variable segments priced off prime (rate_mode 'prime_spread'):
//     max(0, prime + spread), e.g. spread -1 is "Prime - 1". With no
//     prime known the rate is null — callers surface that state
//     instead of projecting at an invented rate.
export function segmentAnnualRate(seg, primeRate) {
  if (!seg) return 0;
  if (seg.rate_type === 'variable' && seg.rate_mode === 'prime_spread') {
    if (primeRate === null || primeRate === undefined || !isFinite(Number(primeRate))) return null;
    return Math.max(0, round2(Number(primeRate) + Number(seg.spread || 0)));
  }
  return Number(seg.annual_rate) || 0;
}

// Which segment covers a given month ('YYYY-MM')?
// Segments are sorted by start_date. A month uses the latest segment whose
// start month is <= the month; months before the first segment use the
// first segment; gaps between segments keep the previous segment.
export function segmentForMonth(segments, monthKey) {
  if (!segments || segments.length === 0) return null;
  let chosen = segments[0];
  for (const seg of segments) {
    if (String(seg.start_date).slice(0, 7) <= monthKey) chosen = seg;
    else break;
  }
  return chosen;
}

// ------------------------------------------------------------ prime history --
// A resolver for the prime rate in effect in a month ('YYYY-MM').
// primeHistory is the stored observation list [{ date, rate }]
// (Bank of Canada Valet, weekly) in any order. A month prices at
// the last observation dated on or before the month's END — the
// weekly series posts each Wednesday, so the month-end reading is
// the closest monthly truth. Months before the first observation
// use the earliest stored one; months after the last use the
// latest known rate (the one assumption a projection must make,
// and the UI states it). Without a history, a scalar primeRate is
// a constant resolver (the pre-history behaviour, kept for tests
// and single-value callers). Null when neither is available.
export function primeHistoryResolver(primeHistory, primeRate) {
  if (Array.isArray(primeHistory)) {
    const obs = primeHistory
      .map((o) => ({ date: String(o && o.date), rate: Number(o && o.rate) }))
      .filter((o) => /^\d{4}-\d{2}-\d{2}/.test(o.date) && isFinite(o.rate))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (obs.length) {
      const cache = new Map();
      return (monthKey) => {
        if (cache.has(monthKey)) return cache.get(monthKey);
        const cutoff = `${monthKey}-31`;
        let lo = 0;
        let hi = obs.length - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (obs[mid].date <= cutoff) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        const v = found >= 0 ? obs[found].rate : obs[0].rate;
        cache.set(monthKey, v);
        return v;
      };
    }
  }
  if (primeRate !== null && primeRate !== undefined && isFinite(Number(primeRate))) {
    const v = Number(primeRate);
    return () => v;
  }
  return null;
}

// Month keys whose priced prime differs from the previous month's —
// the prime-CHANGE months. A step's first priced month is the month
// of the observation that posts the new rate (see the resolver's
// month-end rule).
export function primeStepMonths(primeHistory) {
  if (!Array.isArray(primeHistory) || primeHistory.length < 2) return [];
  const obs = primeHistory
    .map((o) => ({ date: String(o && o.date), rate: Number(o && o.rate) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}/.test(o.date) && isFinite(o.rate))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const steps = [];
  for (let i = 1; i < obs.length; i++) {
    if (obs[i].rate !== obs[i - 1].rate) steps.push(String(obs[i].date).slice(0, 7));
  }
  return [...new Set(steps)];
}

// The annual rate a segment carries in a given month, in %: like
// segmentAnnualRate, but a prime-spread segment resolves against
// the prime in effect in THAT month (via the resolver), not one
// current snapshot. Null when a prime-spread segment has no prime
// to resolve against.
export function segmentRateForMonth(seg, monthKey, primeForMonth) {
  if (!seg) return 0;
  if (seg.rate_type === 'variable' && seg.rate_mode === 'prime_spread') {
    if (!primeForMonth) return null;
    const prime = primeForMonth(monthKey);
    if (prime === null || prime === undefined || !isFinite(Number(prime))) return null;
    return Math.max(0, round2(Number(prime) + Number(seg.spread || 0)));
  }
  return Number(seg.annual_rate) || 0;
}

// Derive a monthly payment from a balance, an annual rate and a remaining
// amortization in years:  P = B * i / (1 - (1 + i)^-n)
export function derivePayment(balance, annualRatePct, years) {
  const n = Math.round(Number(years) * 12);
  if (!(n > 0) || !(balance > 0)) return 0;
  const i = monthlyRate(annualRatePct);
  if (i <= 0) return round2(balance / n);
  return round2((balance * i) / (1 - Math.pow(1 + i, -n)));
}

// Project the mortgage period by period, sampled back into monthly
// rows (the shape the charts have always consumed).
//   balance:      current remaining balance (at balanceDate)
//   balanceDate:  'YYYY-MM-DD' the balance refers to
//   payment:      MONTHLY payment actually used; the per-period amount
//                 is derived from it by frequency (periodPaymentFor).
//                 Ignored when principalPerMonth is given.
//   principalPerMonth: equal-principal mode — the fixed MONTHLY
//                 principal (converted per period exactly like a
//                 payment). Each period then pays that principal
//                 plus the interest on the balance at that period's
//                 own rate, so the total payment declines month by
//                 month as the balance falls.
//   segments:     [{ start_date, rate_type, annual_rate }] sorted by start
//   paymentDay:   optional 1..31, the day of the month the payment is
//                 deducted. For monthly / semi-monthly it ANCHORS each
//                 node's `date`; the interest math never depends on it.
//                 It does not apply to the day-stepped frequencies
//                 (weekly / bi-weekly), whose periods step by whole
//                 days from the balance date.
//   frequency:    one of FREQUENCY_KEYS; default 'monthly'. Monthly
//                 steps reproduce the pre-frequency engine exactly:
//                 the first projected month is the month after the
//                 balance date, one period per month.
//   primeRate:    a single prime rate in %; prime-spread segments
//                 resolve against it in every month (constant —
//                 the legacy path, kept for single-value callers).
//   primeHistory: [{ date, rate }] prime observations; when given,
//                 prime-spread segments resolve against the prime
//                 in effect in each projected month instead (see
//                 primeHistoryResolver), falling back to primeRate
//                 only when the history is empty.
//   region:       region code whose interest convention applies
//                 (default 'CA', the only implementation).
//   maxMonths:    hard cap (in months of projection) so a
//                 non-amortizing loan cannot loop forever
// Returns { series: [{ month, date, rate, rateType, interest, principal,
// payment, balance }], totalInterest, payoffMonth, negativeAmortization }
// where a row aggregates every period that fell in that month: interest
// and payment are the month's totals, balance is the balance after the
// month's last period, and date is that last period's date.
export function simulate({ balance, balanceDate, payment, segments, paymentDay = null, frequency = 'monthly', maxMonths = 600, primeRate = null, primeHistory = null, region = 'CA', principalPerMonth = null }) {
  const primeForMonth = primeHistoryResolver(primeHistory, primeRate);
  const f = FREQUENCIES[frequency] || FREQUENCIES.monthly;
  const freqKey = FREQUENCIES[frequency] ? frequency : 'monthly';
  const perPeriod = periodPaymentFor(payment, freqKey);
  const principalMode = principalPerMonth !== null && principalPerMonth !== undefined
    && isFinite(Number(principalPerMonth));
  const perPeriodPrincipal = principalMode ? periodPaymentFor(Number(principalPerMonth), freqKey) : null;
  const series = [];
  let bal = round2(Number(balance));
  const start = parseYM(balanceDate);
  const startIdx = start.y * 12 + (start.m - 1);
  const anchorDay = Number.isInteger(paymentDay) && paymentDay >= 1 && paymentDay <= 31
    ? paymentDay
    : Number(String(balanceDate).split('-')[2]) || 1;
  let totalInterest = 0;
  let negativeAmortization = false;
  let row = null;

  // Apply one payment period in month `monthKey` ('YYYY-MM') whose
  // display date is `dateStr`, folding it into the monthly output rows.
  function applyPeriod(monthKey, dateStr) {
    const seg = segmentForMonth(segments, monthKey);
    const annualRate = segmentRateForMonth(seg, monthKey, primeForMonth);
    if (annualRate === null) throw new Error('a prime-based segment cannot be projected without a prime rate');
    const i = periodicRate(annualRate, f.periodsPerYear, region);
    const interest = round2(bal * i);
    let principal;
    let paid;
    if (principalMode) {
      // Equal principal: the period pays its fixed principal slice
      // (capped at the balance) plus this period's interest.
      principal = Math.min(perPeriodPrincipal, bal);
      paid = round2(principal + interest);
    } else {
      principal = round2(perPeriod - interest);
      paid = round2(perPeriod);
      if (principal >= bal) {
        // Final payment: clear the balance exactly.
        principal = bal;
        paid = round2(bal + interest);
      }
    }
    if (principal < 0) negativeAmortization = true;
    bal = round2(bal - principal);
    totalInterest = round2(totalInterest + interest);
    if (!row || row.month !== monthKey) {
      row = {
        month: monthKey, date: dateStr, rate: annualRate,
        rateType: seg ? seg.rate_type : null,
        interest: 0, principal: 0, payment: 0, balance: bal,
      };
      series.push(row);
    }
    row.interest = round2(row.interest + interest);
    row.principal = round2(row.principal + principal);
    row.payment = round2(row.payment + paid);
    row.balance = bal;
    if (dateStr > row.date) row.date = dateStr;
  }

  if (f.stepDays === 0) {
    // Calendar-stepped: monthly = one period per month from the month
    // after the balance date; semi-monthly = two, on the anchor day
    // and half a month away from it (both clamped into the month).
    let cursor = start;
    for (let k = 0; k < maxMonths && bal > 0; k++) {
      cursor = nextMonth(cursor);
      const key = ymKey(cursor);
      if (f.periodsPerYear === 24) {
        const dim = daysInMonth(cursor.y, cursor.m);
        const a = Math.min(anchorDay, dim);
        const b = anchorDay <= 15 ? Math.min(anchorDay + 15, dim) : Math.max(anchorDay - 15, 1);
        applyPeriod(key, nodeDate(cursor, Math.min(a, b)));
        if (bal > 0) applyPeriod(key, nodeDate(cursor, Math.max(a, b)));
      } else {
        applyPeriod(key, nodeDate(cursor, anchorDay));
      }
    }
  } else {
    // Day-stepped (weekly / bi-weekly): periods land every stepDays
    // days from the balance date; a month's row samples the periods
    // that fell in it.
    const stepMs = f.stepDays * 86400000;
    let t = Date.parse(`${balanceDate}T00:00:00Z`);
    for (let guard = 0; guard < maxMonths * 60 && bal > 0; guard++) {
      t += stepMs;
      const d = new Date(t);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + 1;
      if (y * 12 + (m - 1) - startIdx > maxMonths) break;
      const key = `${y}-${String(m).padStart(2, '0')}`;
      applyPeriod(key, `${key}-${String(d.getUTCDate()).padStart(2, '0')}`);
    }
  }
  return {
    series,
    totalInterest,
    payoffMonth: series.length && bal <= 0 ? series[series.length - 1].month : null,
    negativeAmortization,
  };
}

// ------------------------------------------------------------ term schedule --
// 'YYYY-MM' key for an absolute month index (year * 12 + month - 1).
function ymKeyOfIdx(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthIdxOf(dateStr) {
  const { y, m } = parseYM(dateStr);
  return y * 12 + (m - 1);
}

// Build a projection on top of simulate(), driven by mortgage TERMS
// and the events inside them — the way a Canadian mortgage actually
// runs. A term is a contract period with its own lender, amortization
// and opening balance; inside a term the rate can change (a new rate
// segment starts) and lump sums can land. Each term also picks a
// REPAYMENT METHOD (term.repayment_method):
//   - 'equal_payment' (default): a level monthly payment — interest
//     shrinks and principal grows inside it (the 等额本息 shape);
//   - 'equal_principal': a fixed monthly PRINCIPAL — the balance at
//     the plan's start divided by the amortization months remaining
//     at that point — plus each month's interest at that month's own
//     rate, so the payment starts higher and declines month by
//     month (the 等额本金 shape), clearing the balance exactly at
//     the amortization end.
// The plan (payment, or principal) is recomputed at SOME events,
// the bank-standard way:
//   - a TERM starting: derived from the balance at that point, the
//     rate then in effect and the new term's amortization (equal
//     payment: derivePayment over the amortization; equal
//     principal: balance / amortization months);
//   - a RATE CHANGE (a segment starting): equal payment re-derives
//     against the payoff the loan was already heading to — the
//     pre-change trajectory (previous payment, previous rate, held
//     constant) is extrapolated to its projected payoff month and
//     the new payment amortizes the balance to that same month at
//     the new rate, so a rate change moves the payment only through
//     the rate itself and never re-sets the payoff. If the
//     pre-change trajectory never pays off (negative amortization),
//     the fallback is the active term's REMAINING amortization (its
//     amortization minus the months already elapsed in the term,
//     counted from the balance anchor for the anchor's term and
//     from the term's start for later terms). Equal principal
//     re-anchors instead: balance at the segment's start / the
//     amortization months remaining at that point;
//   - a LUMP SUM landing: the plan does NOT change. The lump sum
//     deducts from the balance FIRST (in its month, before that
//     month's interest) and the unchanged payment (or unchanged
//     monthly principal) then pays the loan off sooner, for less
//     total interest — how Canadian lenders treat a prepayment;
//   - a PRIME CHANGE (a step in the tracked prime history) while a
//     prime-spread segment governs: NOT an event. A variable plan's
//     payment is set when the plan starts — priced off that month's
//     prime — and does not move when prime moves; only the
//     interest/principal split changes, because simulate() prices
//     every month at that month's own prime (months beyond the
//     last stored observation hold at the latest known prime).
// Between events the plan is constant, so the projection is a
// chain of simulate() runs, one per inter-event span, carrying the
// balance across. The entered monthly payment
// (paymentOverride) is an override that rules only inside the term
// containing the balance anchor; at a renewal the payment returns
// to automatic.
//
//   balance / balanceDate: the current-balance anchor (as simulate)
//   terms:      [{ id, start_date, amortization_years,
//               repayment_method }] any order
//   lumpSums:   [{ date, amount }] any order; a lump sum dated on or
//               before the balance date is already reflected in the
//               anchor balance and is ignored
// Returns simulate()'s shape plus { state, paymentUsed,
// paymentSource }: state is 'projected', or 'no_payment' when the
// anchor term carries no amortization and no override is entered
// (the payment cannot be computed), or 'no_prime' when a prime-
// spread segment exists but no prime rate is known. paymentUsed is
// the monthly payment in effect at the anchor (for an
// equal-principal plan, its FIRST month's payment — the payments
// decline from there); paymentSource is 'entered' (the override)
// or 'derived' (auto-computed).
export function buildSchedule({ balance, balanceDate, paymentOverride = null, terms = [], segments = [], lumpSums = [], paymentDay = null, frequency = 'monthly', maxMonths = 600, primeRate = null, primeHistory = null, region = 'CA' }) {
  const blocked = { series: [], totalInterest: 0, payoffMonth: null, negativeAmortization: false, paymentUsed: null, paymentSource: null };
  const primeForMonth = primeHistoryResolver(primeHistory, primeRate);
  if (segments.some((s) => s.rate_type === 'variable' && s.rate_mode === 'prime_spread')
    && !primeForMonth) {
    return { ...blocked, state: 'no_prime' };
  }
  const A = monthIdxOf(balanceDate);
  const anchorDay = Number.isInteger(paymentDay) && paymentDay >= 1 && paymentDay <= 31
    ? paymentDay
    : Number(String(balanceDate).split('-')[2]) || 1;
  const sortedTerms = [...terms].sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id));
  // The term the balance anchor sits in (the latest that has started
  // by the balance date; the earliest term if none has).
  let anchorTerm = null;
  for (const t of sortedTerms) if (t.start_date <= balanceDate) anchorTerm = t;
  if (!anchorTerm) anchorTerm = sortedTerms[0] || null;
  // The term governing payments from month `mi` on: the latest term
  // that has started by then (fallback: the earliest term).
  const termAtMonth = (mi) => {
    let t = null;
    for (const term of sortedTerms) {
      if (monthIdxOf(term.start_date) <= mi) t = term;
      else break;
    }
    return t || sortedTerms[0] || null;
  };
  // The state-point from which a term's amortization counts down:
  // the anchor term counts from the balance anchor; a later term
  // counts from the state point just before its first payment month.
  const epochOf = (term) => (term === anchorTerm ? A : monthIdxOf(term.start_date) - 1);

  // Does the entered payment rule for months after state point S?
  // 'entered' only inside the anchor's term; automatic elsewhere.
  const overrideAt = (S) => {
    if (!(paymentOverride > 0)) return false;
    const term = termAtMonth(S + 1);
    return !anchorTerm || !term || term.id === anchorTerm.id;
  };

  // The monthly payment in effect for months after state point S,
  // computed from the balance at S against the active term's
  // REMAINING amortization — the anchor / term-start derivation.
  // The rate is the segment's rate in the month the derivation is
  // priced at: for a term starting in the anchor month that is the
  // term's START month (a contract prices its first payment off the
  // rate in effect when it starts); otherwise the first month the
  // payment applies to (S + 1). For a prime-spread segment the prime
  // is THAT month's prime from the tracked history, never today's.
  const computePayment = (S, balNow) => {
    const term = termAtMonth(S + 1);
    if (overrideAt(S)) {
      return { payment: round2(paymentOverride), source: 'entered' };
    }
    const rateMonth = S === A && term && monthIdxOf(term.start_date) === A
      ? ymKeyOfIdx(A)
      : ymKeyOfIdx(S + 1);
    const rate = segmentRateForMonth(segmentForMonth(segments, ymKeyOfIdx(S + 1)), rateMonth, primeForMonth);
    if (rate === null) return { error: 'no_prime' };
    if (!term || !(Number(term.amortization_years) > 0)) return { error: 'no_payment' };
    const remaining = Math.round(Number(term.amortization_years) * 12) - (S - epochOf(term));
    if (remaining <= 0) return { payment: round2(balNow), source: 'derived' }; // past the amortization: clear it (simulate caps at balance + interest)
    return { payment: derivePayment(balNow, rate, remaining / 12), source: 'derived' };
  };

  // The repayment method governing months after state point S is
  // the active term's: 'equal_principal' only when the term says
  // so; anything else (including a term row from before the
  // column existed) is the level-payment default.
  const methodAt = (S) => {
    const term = termAtMonth(S + 1);
    return term && term.repayment_method === 'equal_principal' ? 'equal_principal' : 'equal_payment';
  };

  // The equal-principal plan at state point S: a fixed monthly
  // principal = the balance at this point divided by the months of
  // amortization the active term has left here (counted from the
  // term's own epoch, exactly like computePayment's remaining).
  // Each month then pays that principal plus its own interest, so
  // the balance clears exactly at the amortization end.
  const computePrincipal = (S, balNow) => {
    const term = termAtMonth(S + 1);
    if (!term || !(Number(term.amortization_years) > 0)) return { error: 'no_payment' };
    const remaining = Math.round(Number(term.amortization_years) * 12) - (S - epochOf(term));
    if (remaining <= 0) return { principalPerMonth: round2(balNow), source: 'derived' }; // past the amortization: clear it in one month
    return { principalPerMonth: round2(balNow / remaining), source: 'derived' };
  };

  // The payment after a RATE CHANGE at state point S (a new segment
  // governs months from S + 1 on). Bank-standard recast: find the
  // payoff month the loan was already heading to — extrapolate the
  // pre-change trajectory (the previous payment at the previous
  // rate, held constant) — and derive the new payment so the
  // balance still amortizes to that same month at the new rate.
  // A lump sum that landed earlier therefore keeps its earlier
  // payoff through a rate change; only the rate moves the payment.
  // `lastPayment` / `balanceDateAtS` describe the pre-change state.
  // If the pre-change trajectory never pays off (negative
  // amortization, or beyond the projection cap), fall back to the
  // term's remaining amortization (computePayment).
  const computeRateChangePayment = (S, balNow, lastPayment, balanceDateAtS) => {
    if (overrideAt(S)) {
      return { payment: round2(paymentOverride), source: 'entered' };
    }
    const newRate = segmentRateForMonth(segmentForMonth(segments, ymKeyOfIdx(S + 1)), ymKeyOfIdx(S + 1), primeForMonth);
    if (newRate === null) return { error: 'no_prime' };
    const prevSeg = segmentForMonth(segments, ymKeyOfIdx(S));
    const prevRate = segmentRateForMonth(prevSeg, ymKeyOfIdx(S), primeForMonth);
    if (prevRate !== null && lastPayment > 0) {
      const hypo = simulate({
        balance: balNow, balanceDate: balanceDateAtS, payment: lastPayment,
        segments: [{ start_date: '0001-01-01', rate_type: 'fixed', annual_rate: prevRate }],
        paymentDay: anchorDay, frequency, maxMonths: A + maxMonths - S, primeRate, region,
      });
      if (hypo.payoffMonth) {
        const monthsLeft = monthIdxOf(hypo.payoffMonth) - S;
        if (monthsLeft > 0) return { payment: derivePayment(balNow, newRate, monthsLeft / 12), source: 'derived' };
      }
    }
    return computePayment(S, balNow);
  };

  // Lump sums grouped by the state point they land on (the point
  // just before their month's payment). One dated in the anchor
  // month but after the balance date folds into the opening balance.
  const lumpByState = new Map(); // stateIdx -> { total, firstDate }
  let initialLump = null;
  for (const ls of lumpSums || []) {
    const amount = Number(ls.amount) || 0;
    if (!(amount > 0) || String(ls.date) <= balanceDate) continue;
    const L = monthIdxOf(ls.date);
    if (L <= A) {
      if (!initialLump) initialLump = { total: 0, month: ymKeyOfIdx(L) };
      initialLump.total = round2(initialLump.total + amount);
    } else {
      const S = L - 1;
      const cur = lumpByState.get(S) || { total: 0, firstDate: String(ls.date) };
      cur.total = round2(cur.total + amount);
      if (String(ls.date) < cur.firstDate) cur.firstDate = String(ls.date);
      lumpByState.set(S, cur);
    }
  }
  // Event state points after the anchor: term starts, segment
  // starts and lump-sum landings. (Anything at or before the anchor
  // is already reflected in the opening state.) The kinds are
  // tracked separately because they treat the plan differently:
  // a term start re-derives it on the new amortization, a rate
  // change recasts it (equal payment) or re-anchors it (equal
  // principal), and a lump sum leaves it unchanged. Prime steps in
  // the tracked history are NOT events: simulate() prices each
  // month inside a span at that month's own prime, and the plan a
  // variable segment started with stands until a real event above.
  const termStates = new Set();
  const segStates = new Set();
  const eventStates = new Set();
  for (const t of sortedTerms) { const s = monthIdxOf(t.start_date) - 1; if (s > A) { termStates.add(s); eventStates.add(s); } }
  for (const sg of segments) { const s = monthIdxOf(sg.start_date) - 1; if (s > A) { segStates.add(s); eventStates.add(s); } }
  for (const s of lumpByState.keys()) eventStates.add(s);
  const boundaries = [...eventStates].sort((a, b) => a - b);
  boundaries.push(A + maxMonths);

  let bal = round2(Number(balance));
  const series = [];
  let totalInterest = 0;
  let negativeAmortization = false;
  let payoffMonth = null;
  let paymentUsed = null;
  let paymentSource = null;
  let lastPayment = null;

  if (initialLump) {
    bal = round2(bal - initialLump.total);
    if (bal <= 0) {
      const cp = computePayment(A, round2(Number(balance)));
      return {
        ...blocked, state: cp.error === 'no_prime' ? 'no_prime' : 'projected',
        payoffMonth: initialLump.month,
        paymentUsed: cp.error ? null : cp.payment, paymentSource: cp.error ? null : cp.source,
      };
    }
  }

  let S = A;
  let chunkBalanceDate = balanceDate;
  let lastPlan = null; // the running plan: { payment } or { principalPerMonth }
  let anchorPlan = null;
  for (const nextS of boundaries) {
    if (bal <= 0 || S >= A + maxMonths) break;
    // The plan for the span after S, per the governing term's
    // repayment method — unless the entered payment overrides it
    // (the override is a level payment whatever the method).
    let cp;
    const principalPlan = methodAt(S) === 'equal_principal' && !overrideAt(S);
    if (S === A || termStates.has(S)) {
      // The anchor, or a new term starting: derive the plan on the
      // (new) term's amortization. A segment that starts with the
      // term is the term's opening rate plan, not a mid-stream
      // rate change.
      cp = principalPlan ? computePrincipal(S, bal) : computePayment(S, bal);
    } else if (segStates.has(S)) {
      // A rate change inside the running schedule: equal payment
      // recasts against the trajectory's payoff; equal principal
      // re-anchors the monthly principal on the balance and the
      // amortization months left.
      cp = principalPlan ? computePrincipal(S, bal) : computeRateChangePayment(S, bal, lastPayment, chunkBalanceDate);
    } else {
      // A lump-sum-only boundary: the balance was already reduced
      // below; the plan carries over unchanged (same payment, or
      // same monthly principal) and the loan simply pays off sooner.
      cp = lastPlan;
    }
    if (cp.error) {
      if (S === A) return { ...blocked, state: cp.error };
      // A later term without an amortization cannot recompute the
      // plan: the previous plan carries over unchanged.
      cp = lastPlan;
    }
    if (S === A) {
      anchorPlan = cp;
      paymentSource = cp.source;
      paymentUsed = cp.payment !== undefined ? cp.payment : null; // principal plan: filled from the first row below
    }
    lastPlan = cp;
    if (cp.payment !== undefined) lastPayment = cp.payment;
    const span = Math.min(nextS, A + maxMonths) - S;
    if (span > 0) {
      const r = simulate({
        balance: bal, balanceDate: chunkBalanceDate,
        payment: cp.payment !== undefined ? cp.payment : 0,
        principalPerMonth: cp.principalPerMonth !== undefined ? cp.principalPerMonth : null,
        segments, paymentDay: anchorDay, frequency, maxMonths: span, primeRate, primeHistory, region,
      });
      series.push(...r.series);
      totalInterest = round2(totalInterest + r.totalInterest);
      negativeAmortization = negativeAmortization || r.negativeAmortization;
      if (r.series.length) {
        bal = r.series[r.series.length - 1].balance;
        chunkBalanceDate = r.series[r.series.length - 1].date;
        // For a later recast that needs "the previous payment", an
        // equal-principal span's most recent actual payment is the
        // closest stand-in (its payments decline month by month).
        if (cp.principalPerMonth !== undefined) lastPayment = r.series[r.series.length - 1].payment;
      }
      if (r.payoffMonth) { payoffMonth = r.payoffMonth; break; }
    }
    S = nextS;
    if (S >= A + maxMonths) break;
    // A lump sum landing at this state point deducts FIRST; the
    // payment itself is NOT recomputed for it (see the boundary
    // handling above) — the smaller balance just pays off sooner.
    const lump = lumpByState.get(S);
    if (lump && bal > 0) {
      const before = bal;
      bal = round2(bal - lump.total);
      if (bal <= 0) {
        const seg = segmentForMonth(segments, ymKeyOfIdx(S + 1));
        series.push({
          month: ymKeyOfIdx(S + 1), date: lump.firstDate,
          rate: segmentRateForMonth(seg, ymKeyOfIdx(S + 1), primeForMonth) ?? 0, rateType: seg ? seg.rate_type : null,
          interest: 0, principal: before, payment: before, balance: 0,
        });
        payoffMonth = ymKeyOfIdx(S + 1);
        bal = 0;
        break;
      }
    }
  }
  // An equal-principal anchor plan has no single payment to report:
  // its first month's payment (the highest — they decline from
  // there) stands in as the payment in effect at the anchor.
  if (paymentUsed === null && anchorPlan && anchorPlan.principalPerMonth !== undefined && series.length) {
    paymentUsed = series[0].payment;
  }
  return {
    state: 'projected', series, totalInterest,
    payoffMonth: payoffMonth || (series.length && bal <= 0 ? series[series.length - 1].month : null),
    negativeAmortization, paymentUsed, paymentSource,
  };
}
