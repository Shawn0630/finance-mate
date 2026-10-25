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

// 'YYYY-MM-DD' -> { y, m } with m 1..12
function parseYM(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  return { y, m };
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

// Project the mortgage month by month.
//   balance:      current remaining balance (at balanceDate)
//   balanceDate:  'YYYY-MM-DD' the balance refers to; the first projected
//                 month is the month after it
//   payment:      monthly payment actually used
//   segments:     [{ start_date, rate_type, annual_rate }] sorted by start
//   maxMonths:    hard cap so a non-amortizing loan cannot loop forever
// Returns { series: [{ month, rate, rateType, interest, principal, payment,
// balance }], totalInterest, payoffMonth, negativeAmortization }
export function simulate({ balance, balanceDate, payment, segments, maxMonths = 600 }) {
  const series = [];
  let bal = round2(Number(balance));
  let cursor = parseYM(balanceDate);
  let totalInterest = 0;
  let negativeAmortization = false;

  for (let k = 0; k < maxMonths && bal > 0; k++) {
    cursor = nextMonth(cursor);
    const month = ymKey(cursor);
    const seg = segmentForMonth(segments, month);
    const annualRate = seg ? Number(seg.annual_rate) : 0;
    const i = monthlyRate(annualRate);
    const interest = round2(bal * i);
    let principal = round2(payment - interest);
    let paid = round2(payment);
    if (principal >= bal) {
      // Final payment: clear the balance exactly.
      principal = bal;
      paid = round2(bal + interest);
    }
    if (principal < 0) negativeAmortization = true;
    bal = round2(bal - principal);
    totalInterest = round2(totalInterest + interest);
    series.push({
      month,
      rate: annualRate,
      rateType: seg ? seg.rate_type : null,
      interest,
      principal,
      payment: paid,
      balance: bal,
    });
  }
  return {
    series,
    totalInterest,
    payoffMonth: series.length && bal <= 0 ? series[series.length - 1].month : null,
    negativeAmortization,
  };
}
