// Mortgage projection engine (pure functions, no I/O).
//
// Canadian convention: a quoted annual rate is nominal with semi-annual
// compounding, so the equivalent monthly rate is
//   i = (1 + r/2)^(1/6) - 1        (r = annual rate as a fraction)
// Fixed and variable segments use the same formula; a variable rate is
// simply projected at the value entered (in reality it will change).

export function monthlyRate(annualRatePct) {
  const r = Number(annualRatePct) / 100;
  if (!isFinite(r) || r <= 0) return 0;
  return Math.pow(1 + r / 2, 1 / 6) - 1;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// --------------------------------------------------------- payment frequency --
// The six Canadian mortgage payment frequencies. The quoted rate stays
// nominal with semi-annual compounding; the rate per payment period is
//   i = (1 + r/2)^(2/N) - 1        (N = periods per year)
// For monthly (N = 12) that is exactly monthlyRate() above.
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

export function periodicRate(annualRatePct, periodsPerYear) {
  const r = Number(annualRatePct) / 100;
  if (!isFinite(r) || r <= 0) return 0;
  return Math.pow(1 + r / 2, 2 / periodsPerYear) - 1;
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
//                 is derived from it by frequency (periodPaymentFor)
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
//   maxMonths:    hard cap (in months of projection) so a
//                 non-amortizing loan cannot loop forever
// Returns { series: [{ month, date, rate, rateType, interest, principal,
// payment, balance }], totalInterest, payoffMonth, negativeAmortization }
// where a row aggregates every period that fell in that month: interest
// and payment are the month's totals, balance is the balance after the
// month's last period, and date is that last period's date.
export function simulate({ balance, balanceDate, payment, segments, paymentDay = null, frequency = 'monthly', maxMonths = 600 }) {
  const f = FREQUENCIES[frequency] || FREQUENCIES.monthly;
  const perPeriod = periodPaymentFor(payment, FREQUENCIES[frequency] ? frequency : 'monthly');
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
    const annualRate = seg ? Number(seg.annual_rate) : 0;
    const i = periodicRate(annualRate, f.periodsPerYear);
    const interest = round2(bal * i);
    let principal = round2(perPeriod - interest);
    let paid = round2(perPeriod);
    if (principal >= bal) {
      // Final payment: clear the balance exactly.
      principal = bal;
      paid = round2(bal + interest);
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
