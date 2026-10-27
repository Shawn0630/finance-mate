// Engine unit tests with hand-computed fixtures.
//
// Hand calculations (Canadian semi-annual compounding):
//   annual 5% -> monthly i = (1 + 0.05/2)^(1/6) - 1 = 1.025^(1/6) - 1
//            = 0.0041239150 (approx)
//   Balance $100,000 -> month 1 interest = 100000 * 0.0041239150 = $412.39
//   Payment $600 -> principal = 600 - 412.39 = $187.61
//                -> balance after month 1 = $99,812.39
//   Month 2 interest = 99812.39 * 0.0041239150 = $411.62
//                -> principal $188.38 -> balance $99,624.01
//   derivePayment($300,000, 5%, 25y): i as above, n = 300
//     P = 300000 * i / (1 - (1+i)^-300) = $1,744.81 (matches published
//     Canadian mortgage tables for $300k / 5% / 25 years)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyRate, derivePayment, simulate, buildSchedule, segmentForMonth, segmentAnnualRate, periodicRate, periodPaymentFor, primeHistoryResolver, primeAtDateResolver, primeDailyResolver, primeStepMonths, remainingBalanceAt } from '../src/engine.js';

const close = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

test('monthlyRate: 5% nominal semi-annual -> 0.4123915% monthly', () => {
  assert.ok(close(monthlyRate(5) * 100, 0.4123915, 0.00005), monthlyRate(5));
  assert.equal(monthlyRate(0), 0);
});

test('simulate: first two months match hand calculation', () => {
  const { series } = simulate({
    balance: 100000,
    balanceDate: '2026-10-01',
    payment: 600,
    segments: [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }],
  });
  assert.equal(series[0].month, '2026-11');
  assert.ok(close(series[0].interest, 412.39), series[0].interest);
  assert.ok(close(series[0].principal, 187.61), series[0].principal);
  assert.ok(close(series[0].balance, 99812.39), series[0].balance);
  assert.ok(close(series[1].interest, 411.62), series[1].interest);
  assert.ok(close(series[1].balance, 99624.01), series[1].balance);
});

test('derivePayment: $300k at 5% over 25 years = $1,744.81', () => {
  assert.ok(close(derivePayment(300000, 5, 25), 1744.81, 0.5), derivePayment(300000, 5, 25));
  assert.ok(close(derivePayment(120000, 0, 10), 1000, 0.001));
});

test('derivePayment: $1.35M at prime-1 (3.95%) over 30 years = $6,381.36', () => {
  // The user's shape: a 30-year remaining amortization turns the
  // balance + rate plan into the payment the projection then uses.
  assert.ok(close(derivePayment(1350000, 3.95, 30), 6381.36, 0.5), derivePayment(1350000, 3.95, 30));
});

test('simulate: pays off and stops at zero with an exact final payment', () => {
  const r = simulate({
    balance: 1000,
    balanceDate: '2026-01-15',
    payment: 600,
    segments: [{ start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 }],
  });
  assert.equal(r.series[r.series.length - 1].balance, 0);
  assert.equal(r.payoffMonth, r.series[r.series.length - 1].month);
  assert.ok(r.series.length <= 3);
});

test('simulate: payment below interest flags negative amortization', () => {
  const r = simulate({
    balance: 100000,
    balanceDate: '2026-01-01',
    payment: 100, // first month interest is ~412
    segments: [{ start_date: '2025-06-01', rate_type: 'variable', annual_rate: 5 }],
    maxMonths: 12,
  });
  assert.equal(r.negativeAmortization, true);
  assert.ok(r.series[11].balance > 100000);
  assert.equal(r.payoffMonth, null);
});

test('simulate: node dates anchor to the payment day, interest unchanged', () => {
  const base = {
    balance: 100000,
    balanceDate: '2026-10-24',
    payment: 600,
    segments: [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }],
  };
  const plain = simulate(base);
  // No payment day: monthly anniversaries of the balance date.
  assert.equal(plain.series[0].date, '2026-11-24');
  assert.equal(plain.series[0].interest, 412.39);

  const anchored = simulate({ ...base, paymentDay: 1 });
  assert.equal(anchored.series[0].date, '2026-11-01');
  assert.equal(anchored.series[1].date, '2026-12-01');
  // Anchoring moves dates only — amounts are identical.
  assert.equal(anchored.series[0].interest, plain.series[0].interest);
  assert.equal(anchored.series[0].balance, plain.series[0].balance);
  assert.equal(anchored.totalInterest, plain.totalInterest);

  const thirtyFirst = simulate({ ...base, paymentDay: 31 });
  assert.equal(thirtyFirst.series[0].date, '2026-11-30'); // November has 30 days
  assert.equal(thirtyFirst.series[3].month, '2027-02');
  assert.equal(thirtyFirst.series[3].date, '2027-02-28'); // clamped to month end
});

test('periodicRate: bi-weekly anchor (1.025)^(2/26)-1 = 0.19012368%', () => {
  assert.ok(close(periodicRate(5, 26) * 100, 0.19012368, 0.00001), periodicRate(5, 26));
  // First bi-weekly period on $100,000 at 5%: $190.12.
  assert.ok(close(100000 * periodicRate(5, 26), 190.12), 100000 * periodicRate(5, 26));
  // N = 12 must reproduce the monthly rate exactly (no regression).
  assert.ok(close(periodicRate(5, 12), monthlyRate(5), 1e-12));
  assert.equal(periodicRate(0, 26), 0);
});

test('periodPaymentFor: Canadian conversion of a $600 monthly payment', () => {
  assert.equal(periodPaymentFor(600, 'monthly'), 600);
  assert.equal(periodPaymentFor(600, 'semi_monthly'), 300); // 600 * 12/24
  assert.equal(periodPaymentFor(600, 'bi_weekly'), 276.92); // 600 * 12/26
  assert.equal(periodPaymentFor(600, 'weekly'), 138.46); // 600 * 12/52
  // Accelerated: half / quarter of the monthly amount (13 monthly
  // payments a year — that is the whole point of accelerating).
  assert.equal(periodPaymentFor(600, 'accelerated_bi_weekly'), 300);
  assert.equal(periodPaymentFor(600, 'accelerated_weekly'), 150);
});

// Frequency anchors for one loan: $100,000 at 5%, $600 monthly payment,
// balance date 2026-10-01. The monthly totals are the pre-frequency
// engine's own output (regression baseline); the accelerated bi-weekly
// totals were cross-checked against an independent day-stepped
// calculation (period rate (1.025)^(1/13)-1, $300 every 14 days).
const FREQ_CFG = {
  balance: 100000,
  balanceDate: '2026-10-01',
  payment: 600,
  segments: [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }],
};

test('simulate frequency: monthly reproduces the pre-frequency engine', () => {
  const r = simulate(FREQ_CFG);
  assert.ok(close(r.totalInterest, 69494.74), r.totalInterest);
  assert.equal(r.payoffMonth, '2050-05');
  assert.equal(r.series.length, 283);
});

test('simulate frequency: accelerated bi-weekly pays off earlier, less interest', () => {
  const monthly = simulate(FREQ_CFG);
  const accel = simulate({ ...FREQ_CFG, frequency: 'accelerated_bi_weekly' });
  assert.ok(close(accel.totalInterest, 58641.44), accel.totalInterest);
  assert.equal(accel.payoffMonth, '2047-01');
  assert.ok(accel.totalInterest < monthly.totalInterest);
  assert.ok(accel.payoffMonth < monthly.payoffMonth);
  // October 2026 holds two periods (15th, 29th): the month's payment
  // totals $600 and its interest is the two periods' interest summed
  // ($190.12 + $189.91).
  assert.equal(accel.series[0].month, '2026-10');
  assert.ok(close(accel.series[0].payment, 600), accel.series[0].payment);
  assert.ok(close(accel.series[0].interest, 380.03), accel.series[0].interest);
});

test('simulate frequency: regular bi-weekly and semi-monthly stay near monthly', () => {
  const monthly = simulate(FREQ_CFG);
  const bw = simulate({ ...FREQ_CFG, frequency: 'bi_weekly' });
  // Same yearly total, principal lands slightly earlier: a little
  // less interest, payoff a couple of months sooner.
  assert.ok(close(bw.totalInterest, 69141.28), bw.totalInterest);
  assert.ok(bw.totalInterest < monthly.totalInterest);
  const sm = simulate({ ...FREQ_CFG, frequency: 'semi_monthly' });
  assert.ok(close(sm.totalInterest, 69165.26), sm.totalInterest);
  // Two $300 periods in November 2026 aggregate to one monthly row.
  assert.equal(sm.series[0].month, '2026-11');
  assert.ok(close(sm.series[0].payment, 600), sm.series[0].payment);
  assert.ok(close(sm.series[0].interest, 411.77), sm.series[0].interest);
});

test('segmentForMonth: before first / gap / after last', () => {
  const segs = [
    { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 },
    { start_date: '2026-06-01', rate_type: 'variable', annual_rate: 4 },
  ];
  assert.equal(segmentForMonth(segs, '2024-12').annual_rate, 5); // before first -> first
  assert.equal(segmentForMonth(segs, '2026-03').annual_rate, 5); // gap -> previous
  assert.equal(segmentForMonth(segs, '2026-06').annual_rate, 4);
  assert.equal(segmentForMonth(segs, '2030-01').annual_rate, 4); // after last -> last
  assert.equal(segmentForMonth([], '2026-01'), null);
});

test('simulate: a later segment changes the rate mid-stream', () => {
  const r = simulate({
    balance: 50000,
    balanceDate: '2026-01-01',
    payment: 500,
    segments: [
      { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 6 },
      { start_date: '2026-04-01', rate_type: 'variable', annual_rate: 3 },
    ],
    maxMonths: 6,
  });
  assert.equal(r.series[0].rate, 6); // 2026-02
  assert.equal(r.series[2].rate, 3); // 2026-04
  assert.equal(r.series[2].rateType, 'variable');
});

// ------------------------------------------------------------ buildSchedule --
// The term-driven schedule: payment auto-computed at the anchor and
// recomputed at every event (term start, segment start, lump sum).

test('buildSchedule: single term reproduces the old derive + simulate path exactly', () => {
  // The migration-equivalence shape (the user's real mortgage):
  // balance $1,350,000 at 2024-12-17, one Prime - 1 segment from the
  // same day, 30-year amortization, prime 4.95 -> 3.95%.
  const segments = [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }];
  const terms = [{ id: 1, start_date: '2024-12-17', amortization_years: 30 }];
  const sched = buildSchedule({ balance: 1350000, balanceDate: '2024-12-17', terms, segments, primeRate: 4.95 });
  const legacy = simulate({
    balance: 1350000, balanceDate: '2024-12-17',
    payment: derivePayment(1350000, 3.95, 30), segments, primeRate: 4.95,
  });
  assert.equal(sched.state, 'projected');
  // The payment is always the calculated one: there is no
  // entered/derived distinction left to report.
  assert.equal('paymentSource' in sched, false);
  assert.ok(close(sched.paymentUsed, 6381.36, 0.5), sched.paymentUsed);
  assert.deepEqual(sched.series, legacy.series);
  assert.equal(sched.totalInterest, legacy.totalInterest);
  assert.equal(sched.payoffMonth, legacy.payoffMonth);
});

test('buildSchedule: two terms — payment recomputed at the renewal on the new amortization', () => {
  // Term 1: 5 years at fixed 5%, 25-year amortization. Term 2 from
  // 2031-01-01: fixed 4%, amortization reset to 30 years.
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 },
    { start_date: '2031-01-01', rate_type: 'fixed', annual_rate: 4 },
  ];
  const terms = [
    { id: 1, start_date: '2026-01-01', amortization_years: 25 },
    { id: 2, start_date: '2031-01-01', amortization_years: 30 },
  ];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments });
  assert.equal(r.state, 'projected');
  // Term 1 payment: derivePayment(100000, 5%, 25y) = $581.60 (the
  // $300k anchor $1,744.81 scaled by 1/3).
  assert.ok(close(r.paymentUsed, 581.60, 0.5), r.paymentUsed);
  assert.ok(close(r.paymentUsed, derivePayment(100000, 5, 25), 0.02));
  // Month 1 by hand: interest $412.39, principal $169.21.
  assert.equal(r.series[0].month, '2026-02');
  assert.ok(close(r.series[0].interest, 412.39), r.series[0].interest);
  assert.ok(close(r.series[0].principal, 169.21), r.series[0].principal);
  assert.ok(close(r.series[0].balance, 99830.79), r.series[0].balance);
  // Every term-1 month pays the term-1 payment at 5%.
  const t1 = r.series.filter((row) => row.month < '2031-01');
  assert.equal(t1.length, 59); // 2026-02 .. 2030-12
  assert.ok(t1.every((row) => close(row.payment, r.paymentUsed, 0.02) && row.rate === 5));
  // The boundary month: balance is continuous (the term-2 opening is
  // term 1's closing balance, no jump), interest is charged at the
  // new 4% on that balance, and the payment is re-derived from that
  // balance over the NEW 30-year amortization.
  const b59 = t1[t1.length - 1].balance;
  const first2 = r.series.find((row) => row.month === '2031-01');
  assert.ok(first2, 'term 2 opens at 2031-01');
  assert.equal(first2.rate, 4);
  assert.ok(close(first2.interest, b59 * monthlyRate(4)), first2.interest);
  assert.ok(close(first2.payment, derivePayment(b59, 4, 30), 0.02), first2.payment);
  assert.ok(first2.payment < r.paymentUsed, 'longer amortization + lower rate -> smaller payment');
  assert.ok(close(first2.balance, b59 + first2.interest - first2.payment), first2.balance);
});

test('buildSchedule: a lump sum deducts first and the payment stays the same (bank standard)', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }];
  const base = { balance: 100000, balanceDate: '2026-01-01', terms, segments };
  const plain = buildSchedule(base);
  const withLump = buildSchedule({ ...base, lumpSums: [{ date: '2027-01-15', amount: 10000 }] });
  // Before the lump the two schedules are identical (11 payments).
  assert.deepEqual(withLump.series.slice(0, 11), plain.series.slice(0, 11));
  const b11 = plain.series[10].balance; // end of 2026-12
  // January 2027: interest is charged on the REDUCED balance
  // (b11 - 10,000) — the lump comes off before that month's
  // interest — but the payment is NOT recomputed: it stays at
  // $581.60, the plain schedule's payment, every single month.
  const jan = withLump.series[11];
  assert.equal(jan.month, '2027-01');
  assert.ok(close(jan.interest, (b11 - 10000) * monthlyRate(5)), jan.interest);
  assert.equal(jan.payment, plain.paymentUsed);
  assert.ok(withLump.series.slice(0, -1).every((row) => row.payment === plain.paymentUsed),
    'every payment before the final one equals the no-lump payment');
  assert.ok(withLump.series.every((row, i) => i === withLump.series.length - 1
    || row.payment === plain.series[i].payment), 'payments match the plain schedule month by month');
  // The unchanged payment on a smaller balance pays the loan off
  // sooner for less interest: payoff 2051-02 -> 2046-11 (51 months
  // earlier), total interest $74,482.97 -> $54,891.20.
  assert.equal(plain.payoffMonth, '2051-02');
  assert.equal(withLump.payoffMonth, '2046-11');
  assert.ok(close(plain.totalInterest, 74482.97), plain.totalInterest);
  assert.ok(close(withLump.totalInterest, 54891.20), withLump.totalInterest);
});

test('buildSchedule: a $100k lump sum on the $1.35M shape keeps $6,381.36 and pulls the payoff in', () => {
  // The user's real shape; the lump lands in projected month 13
  // (January 2026). Payments must be identical to the no-lump run
  // month by month; only the payoff and the interest move.
  const segments = [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }];
  const terms = [{ id: 1, start_date: '2024-12-17', amortization_years: 30 }];
  const base = { balance: 1350000, balanceDate: '2024-12-17', terms, segments, primeRate: 4.95 };
  const plain = buildSchedule(base);
  const withLump = buildSchedule({ ...base, lumpSums: [{ date: '2026-01-15', amount: 100000 }] });
  assert.equal(plain.paymentUsed, 6381.36);
  assert.equal(withLump.paymentUsed, 6381.36);
  // The first 12 months predate the lump: identical rows.
  assert.deepEqual(withLump.series.slice(0, 12), plain.series.slice(0, 12));
  // Month 13 charges interest on the balance less the $100k, and
  // still pays exactly $6,381.36.
  const b12 = plain.series[11].balance;
  const m13 = withLump.series[12];
  assert.equal(m13.month, '2026-01');
  assert.ok(close(m13.interest, (b12 - 100000) * monthlyRate(3.95)), m13.interest);
  assert.equal(m13.payment, 6381.36);
  assert.ok(withLump.series.every((row, i) => i === withLump.series.length - 1
    || row.payment === plain.series[i].payment), 'payments match the plain schedule month by month');
  // Payoff 2054-12 -> 2051-03 (45 months earlier); total interest
  // $947,288.76 -> $758,293.51.
  assert.equal(plain.payoffMonth, '2054-12');
  assert.ok(close(plain.totalInterest, 947288.76), plain.totalInterest);
  assert.equal(withLump.payoffMonth, '2051-03');
  assert.ok(close(withLump.totalInterest, 758293.51), withLump.totalInterest);
});

test('buildSchedule: a rate change after a lump sum recasts against the post-lump trajectory endpoint', () => {
  // 6% for the first stretch, a $20,000 lump sum in September 2026,
  // then the rate drops to 3% in March 2027. The lump keeps the
  // $639.81 payment and pulls the trajectory's payoff in to
  // 2042-07; the March 2027 recast must target THAT endpoint (185
  // months out), not the term's remaining amortization (287
  // months), which is what the pre-change rule derived.
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 },
    { start_date: '2027-03-01', rate_type: 'fixed', annual_rate: 3 },
  ];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }];
  const base = { balance: 100000, balanceDate: '2026-01-01', terms, segments };
  const r = buildSchedule({ ...base, lumpSums: [{ date: '2026-09-10', amount: 20000 }] });
  assert.ok(close(r.paymentUsed, derivePayment(100000, 6, 25), 0.02), r.paymentUsed);
  // The payment is untouched from the first month through the lump
  // and up to the rate change.
  const throughFeb = r.series.filter((row) => row.month <= '2027-02');
  assert.ok(throughFeb.every((row) => row.payment === r.paymentUsed), 'payment constant until the rate change');
  // The pre-change trajectory endpoint, extrapolated independently:
  // the February 2027 balance at the old payment and old rate.
  const feb = r.series.find((row) => row.month === '2027-02');
  const hypo = simulate({
    balance: feb.balance, balanceDate: feb.date, payment: r.paymentUsed,
    segments: [{ start_date: '0001-01-01', rate_type: 'fixed', annual_rate: 6 }],
  });
  assert.equal(hypo.payoffMonth, '2042-07');
  const monthsLeft = 185; // 2027-02 -> 2042-07
  const mar = r.series.find((row) => row.month === '2027-03');
  assert.equal(mar.rate, 3);
  assert.ok(close(mar.payment, derivePayment(feb.balance, 3, monthsLeft / 12), 0.02), mar.payment);
  assert.ok(close(mar.payment, 522.69), mar.payment);
  // The old remaining-amortization derivation would have given a
  // materially smaller payment ($377.71) and re-extended the loan.
  assert.ok(Math.abs(mar.payment - derivePayment(feb.balance, 3, 287 / 12)) > 100);
  // And the loan indeed ends at the preserved endpoint.
  assert.equal(r.payoffMonth, '2042-07');
});

test('buildSchedule: a mid-term rate change recasts the payment against the trajectory endpoint', () => {
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 },
    { start_date: '2026-07-01', rate_type: 'fixed', annual_rate: 3 },
  ];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments });
  // Month 1 at 6%: interest $493.86 (hand anchor).
  assert.ok(close(r.series[0].interest, 493.86), r.series[0].interest);
  assert.ok(close(r.paymentUsed, derivePayment(100000, 6, 25), 0.02), r.paymentUsed);
  // Five payments at 6% (2026-02..2026-06), then the July payment is
  // recast so the loan still ends at the trajectory's payoff month.
  // With no lump sum that endpoint is the amortization end, 295
  // months out — the same figure the remaining-amortization
  // derivation gives, so the two rules coincide here.
  const b5 = r.series[4].balance;
  const jul = r.series[5];
  assert.equal(jul.month, '2026-07');
  assert.equal(jul.rate, 3);
  assert.ok(close(jul.payment, derivePayment(b5, 3, 295 / 12), 0.02), jul.payment);
  assert.ok(jul.payment < r.paymentUsed);
});

test('buildSchedule: a stray top-level paymentOverride argument is not consulted (the override lives on the term)', () => {
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 },
    { start_date: '2031-01-01', rate_type: 'fixed', annual_rate: 4 },
  ];
  const terms = [
    { id: 1, start_date: '2026-01-01', amortization_years: 25 },
    { id: 2, start_date: '2031-01-01', amortization_years: 30 },
  ];
  const plain = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments });
  // A caller still passing the retired argument changes nothing:
  // the payment derives from the amortization in every span, to
  // the row.
  const stray = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments, paymentOverride: 700, terms,
  });
  assert.deepEqual(stray.series, plain.series);
  assert.equal(stray.paymentUsed, plain.paymentUsed);
  assert.ok(close(stray.paymentUsed, 581.60, 0.02), stray.paymentUsed);
  // At the renewal the payment is computed from term 2's closing
  // balance over its 30-year amortization, as always.
  const t1 = stray.series.filter((row) => row.month < '2031-01');
  const bLast = t1[t1.length - 1].balance;
  const first2 = stray.series.find((row) => row.month === '2031-01');
  assert.ok(close(first2.payment, derivePayment(bLast, 4, 30), 0.02), first2.payment);
});

test('buildSchedule: a term payment_override rules its span — the schedule is the fixed-payment one', () => {
  // The derived payment is computed first (the baseline); a term
  // carrying a positive payment_override then runs on that fixed
  // payment for its whole span. Anchor figures, hand- and
  // kernel-checked: $100,000 at 5% over 25y derives $581.60;
  // paying $700 flat instead, the schedule is simulate()'s own
  // $700 run to the row, clearing 2044-02 with $51,293.17 of
  // interest (vs 2051-02 / $74,482.97 derived).
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const plain = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }],
  });
  assert.equal(plain.paymentUsed, 581.60);
  assert.equal(plain.paymentDerived, 581.60);
  assert.equal(plain.paymentOverridden, false);
  assert.equal(plain.payoffMonth, '2051-02');
  assert.equal(plain.totalInterest, 74482.97);
  const over = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25, payment_override: 700 }],
  });
  assert.equal(over.paymentUsed, 700);
  assert.equal(over.paymentDerived, 581.60);
  assert.equal(over.paymentOverridden, true);
  const kernel = simulate({ balance: 100000, balanceDate: '2026-01-01', payment: 700, segments });
  assert.deepEqual(over.series, kernel.series);
  assert.equal(over.payoffMonth, '2044-02');
  assert.equal(over.totalInterest, 51293.17);
  // Month 1 at the override: interest $412.39, principal $287.61.
  assert.equal(over.series[0].interest, 412.39);
  assert.equal(over.series[0].principal, 287.61);
  assert.equal(over.series[0].balance, 99712.39);
  // The per-term triple rides along, keyed by term id.
  assert.deepEqual(over.termPayments[1], { paymentUsed: 700, paymentDerived: 581.60, paymentOverridden: true });
  assert.deepEqual(plain.termPayments[1], { paymentUsed: 581.60, paymentDerived: 581.60, paymentOverridden: false });
});

test('buildSchedule: clearing the override reproduces the pure-derived schedule to the cent', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const plain = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }],
  });
  for (const cleared of [null, undefined, 0, -50]) {
    const r = buildSchedule({
      balance: 100000, balanceDate: '2026-01-01', segments,
      terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25, payment_override: cleared }],
    });
    assert.deepEqual(r.series, plain.series, `override ${cleared}`);
    assert.equal(r.totalInterest, plain.totalInterest);
    assert.equal(r.payoffMonth, plain.payoffMonth);
    assert.equal(r.paymentUsed, 581.60);
    assert.equal(r.paymentOverridden, false);
  }
});

test('buildSchedule: an override does not move when a rate segment changes mid-term', () => {
  // Same shape as the recast test: 6% then 3% from 2026-07. The
  // derived plan recasts at the change; the overridden plan keeps
  // paying the override through it, at both rates.
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 },
    { start_date: '2026-07-01', rate_type: 'fixed', annual_rate: 3 },
  ];
  const r = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25, payment_override: 700 }],
  });
  assert.equal(r.paymentUsed, 700);
  assert.ok(r.series.length > 6);
  for (const row of r.series.slice(0, -1)) assert.equal(row.payment, 700, row.month);
  assert.equal(r.series[5].month, '2026-07');
  assert.equal(r.series[5].rate, 3);
  assert.equal(r.series[5].payment, 700);
  // Sanity: without the override the July payment DOES recast.
  const derived = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }],
  });
  assert.notEqual(derived.series[5].payment, derived.paymentUsed);
});

test('buildSchedule: an override beats the equal-principal method (the term runs on the fixed payment)', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const r = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25, repayment_method: 'equal_principal', payment_override: 700 }],
  });
  assert.equal(r.paymentUsed, 700);
  assert.equal(r.paymentOverridden, true);
  // The derived figure beside it is the equal-principal plan's
  // first month: principal $100,000 / 300 = $333.33 plus month-1
  // interest $412.39 = $745.72.
  assert.equal(r.paymentDerived, 745.72);
  // The rows pay the flat override, not the declining
  // principal-plus-interest shape.
  for (const row of r.series.slice(0, -1)) assert.equal(row.payment, 700, row.month);
  const kernel = simulate({ balance: 100000, balanceDate: '2026-01-01', payment: 700, segments });
  assert.deepEqual(r.series, kernel.series);
});

test('periodicRate: monthly compounding converts at the payment frequency', () => {
  // (1 + r/12)^(12/N) - 1; for N = 12 exactly r/12.
  assert.ok(close(periodicRate(5, 12, 'CA', 'monthly') * 100, 5 / 12, 1e-9), periodicRate(5, 12, 'CA', 'monthly'));
  assert.ok(close(periodicRate(5, 26, 'CA', 'monthly'), Math.pow(1 + 0.05 / 12, 12 / 26) - 1, 1e-12));
  // The default (and an explicit 'semi_annual') stays the
  // long-standing convention, to the last digit.
  assert.equal(periodicRate(5, 12, 'CA'), periodicRate(5, 12, 'CA', 'semi_annual'));
  assert.equal(periodicRate(5, 26, 'CA'), periodicRate(5, 26, 'CA', 'semi_annual'));
  assert.ok(close(monthlyRate(5, 'monthly') * 100, 5 / 12, 1e-9), monthlyRate(5, 'monthly'));
});

test('derivePayment: monthly compounding anchor — $1.35M at 4.95% over 360 months = $7,205.89', () => {
  // The commitment-letter arithmetic: letter-date rate 4.95%,
  // monthly compounding, 360 months.
  assert.equal(derivePayment(1350000, 4.95, 30, 'monthly'), 7205.89);
  // The semi-annual default derives a different figure ($7,164.57).
  assert.equal(derivePayment(1350000, 4.95, 30), 7164.57);
  assert.equal(derivePayment(1350000, 4.95, 30, 'semi_annual'), 7164.57);
});

test('buildSchedule compounding: the real RBC shape — monthly vs semi-annual balances to the cent', () => {
  // His real mortgage: $1,350,000 from 2024-12-17, Prime - 1
  // (BoC V80691311, month-end pricing; the weekly series lags
  // each cut by days, so January and October 2025 still price at
  // the pre-cut prime), payment override $7,207.10. The rate
  // ladder is therefore 4.45 / 4.20 / 3.95 (Mar-Aug) / 3.70
  // (Sep-Oct) / 3.45 (Nov on).
  const primeHistory = [
    { date: '2024-12-18', rate: 5.45 }, { date: '2025-02-05', rate: 5.20 },
    { date: '2025-03-19', rate: 4.95 }, { date: '2025-09-24', rate: 4.70 },
    { date: '2025-11-05', rate: 4.45 },
  ];
  const mk = (compounding) => buildSchedule({
    balance: 1350000, balanceDate: '2024-12-17', primeHistory,
    terms: [{ id: 1, start_date: '2024-12-17', amortization_years: 30, payment_override: 7207.10 }],
    segments: [{ id: 1, start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, ...(compounding ? { compounding } : {}) }],
  });
  const bal = (r, m) => r.series.find((x) => x.month === m).balance;
  // Semi-annual — the long-standing default. Omitting the field
  // and naming it agree to the cent (zero migration regression).
  assert.equal(bal(mk(), '2026-05'), 1297655.44);
  assert.equal(bal(mk(), '2026-09'), 1283583.82);
  assert.equal(bal(mk('semi_annual'), '2026-05'), 1297655.44);
  assert.equal(bal(mk('semi_annual'), '2026-09'), 1283583.82);
  // Monthly compounding — his contract's convention ("calculated
  // not in advance, at the same frequency as your payments"):
  // the externally verified balances.
  assert.equal(bal(mk('monthly'), '2026-05'), 1298221.75);
  assert.equal(bal(mk('monthly'), '2026-09'), 1284262.85);
});

test('primeAtDateResolver: the prime in effect on a date is the last observation on or before it', () => {
  const resolve = primeAtDateResolver([
    { date: '2024-12-04', rate: 5.95 },
    { date: '2024-12-18', rate: 5.45 },
  ], null);
  // Before the first observation: the earliest stored one.
  assert.equal(resolve('2024-12-01'), 5.95);
  // Between observations: the one already in effect.
  assert.equal(resolve('2024-12-10'), 5.95);
  assert.equal(resolve('2024-12-17'), 5.95);
  // On / after an observation date: that observation.
  assert.equal(resolve('2024-12-18'), 5.45);
  assert.equal(resolve('2025-06-30'), 5.45);
  // Scalar fallback and the empty case mirror the month resolver.
  assert.equal(primeAtDateResolver(null, 4.95)('2024-12-10'), 4.95);
  assert.equal(primeAtDateResolver([], null), null);
});

test('buildSchedule: a segment locked_on anchors the derivations it governs to that date’s prime — accrual untouched', () => {
  // The user's real history, completed: RBC priced the payment
  // on the commitment letter (prime 5.95, before the Dec 11 cut)
  // and funded on Dec 17, after prime had already fallen to 5.45.
  // The rate was LOCKED on the letter date, so the lock is a
  // property of the segment: a segment locked on 2024-12-10
  // derives at 5.95 - 1 = 4.95% — the letter's $7,205.89 — while
  // the same segment with no lock derives at the start month's
  // prime (5.45 - 1 = 4.45%) — $6,800.20. Fixture: $1,450,000
  // opening with the $100,000 month-1 lump folding it to
  // $1,350,000, Prime - 1 monthly-compounded, 360 months.
  const primeHistory = [
    { date: '2024-12-04', rate: 5.95 }, { date: '2024-12-18', rate: 5.45 },
    { date: '2025-02-05', rate: 5.20 }, { date: '2025-03-19', rate: 4.95 },
    { date: '2025-09-24', rate: 4.70 }, { date: '2025-11-05', rate: 4.45 },
  ];
  const seg = (extra) => [{
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread',
    spread: -1, compounding: 'monthly', ...extra,
  }];
  const base = {
    balance: 1450000, balanceDate: '2024-12-17', primeHistory,
    lumpSums: [{ date: '2024-12-20', amount: 100000 }],
    terms: [{ id: 1, start_date: '2024-12-17', amortization_years: 30 }],
  };
  const priced = buildSchedule({ ...base, segments: seg({ locked_on: '2024-12-10' }) });
  assert.equal(priced.paymentDerived, 7205.89);
  assert.equal(priced.paymentUsed, 7205.89);
  assert.equal(priced.termPayments[1].paymentDerived, 7205.89);
  const blank = buildSchedule({ ...base, segments: seg({}) });
  assert.equal(blank.paymentDerived, 6800.2);
  assert.equal(blank.paymentUsed, 6800.2);
  // A lock date AFTER the cut prices at the post-cut prime —
  // the resolution is genuinely by date, not "any lock = 5.95".
  const after = buildSchedule({ ...base, segments: seg({ locked_on: '2024-12-20' }) });
  assert.equal(after.paymentDerived, 6800.2);
  // Orthogonal with the override: the override still runs the
  // term, the locked figure stands as the derived beside it,
  // and the trajectory is the externally verified one — every
  // month's interest priced at that month's OWN prime (January
  // 2025 charges 4.45%, not the letter's 4.95%), so the lock
  // demonstrably never reaches accrual.
  const withOv = buildSchedule({
    ...base, segments: seg({ locked_on: '2024-12-10' }),
    terms: [{ id: 1, start_date: '2024-12-17', amortization_years: 30, payment_override: 7207.10 }],
  });
  assert.equal(withOv.paymentUsed, 7207.1);
  assert.equal(withOv.paymentDerived, 7205.89);
  assert.equal(withOv.paymentOverridden, true);
  assert.equal(withOv.series[0].rate, 4.45);
  const bal = (r, m) => r.series.find((x) => x.month === m).balance;
  assert.equal(bal(withOv, '2026-05'), 1298221.75);
  assert.equal(bal(withOv, '2026-09'), 1284262.85);
  // A fixed segment's rate is written down, so a lock on it is
  // meaningless and ignored: a run whose FIXED opening segment
  // carries a locked_on equals the blank run to the row — which
  // also proves the mid-term prime segment's recast, priced at
  // the change point, reads only its OWN lock (it has none).
  const fixedBase = {
    balance: 100000, balanceDate: '2026-01-01',
    segments: [
      { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6, locked_on: '2024-12-10' },
      { start_date: '2026-07-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 },
    ],
    primeHistory: [{ date: '2025-12-03', rate: 4.95 }, { date: '2026-08-05', rate: 4.45 }],
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }],
  };
  const fixedLocked = buildSchedule({ ...fixedBase });
  const fixedBlank = buildSchedule({
    ...fixedBase,
    segments: fixedBase.segments.map(({ locked_on, ...s }) => s),
  });
  assert.equal(JSON.stringify(fixedLocked.series), JSON.stringify(fixedBlank.series));
  assert.equal(fixedLocked.paymentDerived, fixedBlank.paymentDerived);
});

test('buildSchedule: a mid-term segment change recasts at the incoming segment’s locked_on', () => {
  // Fixed 6% for six months, then Prime - 1 from 2026-07-01.
  // Prime steps down inside July (4.95 -> 4.45 on the 29th), so
  // the recast month's own pricing is 4.45 - 1 = 3.45%; the
  // incoming segment locked on 2026-07-15 — when prime was still
  // 4.95 — so its recast derives at 3.95% instead. Accrual of the
  // July row charges July's own prime (3.45%) either way.
  const primeHistory = [{ date: '2026-06-03', rate: 4.95 }, { date: '2026-07-29', rate: 4.45 }];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }];
  const segs = (lock) => [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 },
    { start_date: '2026-07-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, ...(lock ? { locked_on: '2026-07-15' } : {}) },
  ];
  const mk = (lock) => buildSchedule({ balance: 120000, balanceDate: '2026-01-01', terms, segments: segs(lock), primeHistory });
  const locked = mk(true);
  const plain = mk(false);
  const row = (r, m) => r.series.find((x) => x.month === m);
  // The pre-change trajectory is identical in both runs.
  assert.equal(
    JSON.stringify(locked.series.filter((x) => x.month <= '2026-06')),
    JSON.stringify(plain.series.filter((x) => x.month <= '2026-06')));
  // The recast targets the pre-change trajectory's payoff month
  // (the plain run's own payoff: its derivation rate and accrual
  // rate agree at 3.45%, so it lands exactly on the target). The
  // July payment derives the June balance over the months left
  // to that target at the segment's pricing rate.
  const idx = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
  const monthsLeft = idx(plain.payoffMonth) - idx('2026-06');
  const jun = row(locked, '2026-06');
  assert.equal(row(locked, '2026-07').payment, derivePayment(jun.balance, 3.95, monthsLeft / 12, 'semi_annual'));
  assert.equal(row(plain, '2026-07').payment, derivePayment(jun.balance, 3.45, monthsLeft / 12, 'semi_annual'));
  assert.notEqual(row(locked, '2026-07').payment, row(plain, '2026-07').payment);
  // Accrual untouched by the lock: July charges its own prime.
  assert.equal(row(locked, '2026-07').rate, 3.45);
  assert.equal(row(locked, '2026-07').interest, row(plain, '2026-07').interest);
});

test('buildSchedule compounding: each month prices under its own segment’s convention', () => {
  // 6% fixed semi-annual, then the same 6% as a monthly-compounded
  // segment from 2026-03: February charges the semi-annual monthly
  // rate, March charges exactly 6%/12 — and the March recast
  // derives under the NEW segment's convention.
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 },
    { start_date: '2026-03-01', rate_type: 'fixed', annual_rate: 6, compounding: 'monthly' },
  ];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments });
  const feb = r.series[0];
  const mar = r.series[1];
  assert.equal(feb.interest, 493.86); // hand anchor: 6% semi-annual monthly rate
  assert.equal(mar.interest, 499.27); // round2(99,854.05 x 6% / 12)
  assert.equal(mar.interest, Math.round(feb.balance * 0.005 * 100) / 100);
  // The recast payment is the monthly-compounding derivation
  // against the extrapolated payoff (299 months out), not the
  // semi-annual one ($639.81).
  assert.equal(mar.payment, derivePayment(feb.balance, 6, 299 / 12, 'monthly'));
  assert.equal(mar.payment, 644.29);
  assert.notEqual(mar.payment, derivePayment(feb.balance, 6, 299 / 12, 'semi_annual'));
});

test('buildSchedule: no amortization is a named no_payment state', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: null }];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments });
  assert.equal(r.state, 'no_payment');
  assert.equal(r.series.length, 0);
  assert.equal(r.paymentUsed, null);
  // No segment at all is the same story at this layer (the API
  // names it NO_RATE_PLAN before the engine is ever called).
  const noSegs = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments: [] });
  assert.equal(noSegs.state, 'no_payment');
  // The $600-payment anchor survives at the simulate() level,
  // whose payment input is the simulator kernel's own: $100,000 at
  // 5% paying $600/month costs $69,494.74 of interest in total.
  const sim = simulate({ balance: 100000, balanceDate: '2026-01-01', payment: 600, segments });
  assert.ok(close(sim.totalInterest, 69494.74), sim.totalInterest);
  // A prime-spread segment without a prime rate is a named state too.
  const primeSegs = [{ start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }];
  const noPrime = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments: primeSegs });
  assert.equal(noPrime.state, 'no_prime');
});

test('prime-spread segments resolve against the current prime', () => {
  const seg = { rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 };
  // The reporting anchor: prime 4.95 with a -1 spread is a 3.95% rate.
  assert.equal(segmentAnnualRate(seg, 4.95), 3.95);
  // Floored at zero, and null when no prime is known.
  assert.equal(segmentAnnualRate({ ...seg, spread: -1 }, 0.5), 0);
  assert.equal(segmentAnnualRate(seg, null), null);
  // Absolute segments (and rows that predate rate_mode) ignore prime.
  assert.equal(segmentAnnualRate({ rate_type: 'variable', annual_rate: 6.1 }, 4.95), 6.1);
  assert.equal(segmentAnnualRate({ rate_type: 'fixed', annual_rate: 5 }, 4.95), 5);
  // First month's interest at the resolved rates, hand-checked:
  // $100,000 x monthlyRate(3.95%) = $326.49; at 4.45% = $367.44.
  const segRow = { start_date: '2026-01-01', ...seg };
  const at495 = simulate({ balance: 100000, balanceDate: '2026-10-01', payment: 600, segments: [segRow], primeRate: 4.95 });
  assert.equal(at495.series[0].interest, 326.49);
  // When prime moves, the same segment projects differently.
  const at545 = simulate({ balance: 100000, balanceDate: '2026-10-01', payment: 600, segments: [segRow], primeRate: 5.45 });
  assert.equal(at545.series[0].interest, 367.44);
  assert.ok(at545.totalInterest > at495.totalInterest);
});

test('prime history: each month prices at that month\u2019s prime (month-end rule)', () => {
  // Fake Valet history: 6.00% through 2024, 5.00% from the mid-January
  // 2025 observation on. A month prices at the last observation dated
  // on or before its end: Dec 2024 = 6.00 (the November observation),
  // Jan 2025 = 5.00 (the January one), later months hold at 5.00.
  const resolve = primeHistoryResolver([
    { date: '2024-11-13', rate: 6.00 },
    { date: '2025-01-15', rate: 5.00 },
  ], null);
  assert.equal(resolve('2024-12'), 6.00);
  assert.equal(resolve('2025-01'), 5.00);
  assert.equal(resolve('2025-06'), 5.00);
  assert.deepEqual(primeStepMonths([
    { date: '2024-11-13', rate: 6.00 },
    { date: '2025-01-15', rate: 5.00 },
  ]), ['2025-01']);
  // Months before the first observation fall back to the earliest.
  assert.equal(resolve('2024-06'), 6.00);
  // No history and no scalar: no resolver (the no_prime state).
  assert.equal(primeHistoryResolver([], null), null);
  assert.equal(primeHistoryResolver(null, 4.95)('2030-01'), 4.95);
});

test('prime history: a Prime - 1 segment charges December at 5% and January at 4%', () => {
  // Same fake history as above. Balance dated mid-November 2024, so
  // December is a projected month: its interest is 100000 x
  // monthlyRate(6.00 - 1) = the familiar $412.39 at 5%; January's is
  // the December-end balance x monthlyRate(5.00 - 1).
  const primeHistory = [
    { date: '2024-11-13', rate: 6.00 },
    { date: '2025-01-15', rate: 5.00 },
  ];
  const { series } = simulate({
    balance: 100000, balanceDate: '2024-11-15', payment: 600,
    segments: [{ start_date: '2024-11-15', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }],
    primeHistory,
  });
  assert.equal(series[0].month, '2024-12');
  assert.equal(series[0].rate, 5);
  assert.ok(close(series[0].interest, 412.39), series[0].interest);
  assert.equal(series[1].month, '2025-01');
  assert.equal(series[1].rate, 4);
  assert.ok(close(series[1].interest, series[0].balance * monthlyRate(4), 0.011), series[1].interest);
  // A fixed segment ignores the history entirely.
  const fixed = simulate({
    balance: 100000, balanceDate: '2024-11-15', payment: 600,
    segments: [{ start_date: '2024-11-15', rate_type: 'fixed', annual_rate: 5 }],
    primeHistory,
  });
  assert.ok(fixed.series.every((row) => row.rate === 5));
  assert.ok(close(fixed.series[1].interest, 411.62), fixed.series[1].interest);
});

test('buildSchedule: a prime step reprices interest but never recasts the payment (fixed-payment variable)', () => {
  // Fake history in the real series' shape: prime 5.45 when the term
  // starts (Dec 2024), stepping to 4.95 in March 2025. The payment is
  // derived ONCE, at the START month's prime (5.45 - 1 = 4.45%, 25
  // years), and prime moving afterwards does NOT touch it — the
  // user's variable product is fixed-payment: only the
  // interest/principal split moves, because each month's interest is
  // priced at that month's own prime.
  const primeHistory = [
    { date: '2024-12-11', rate: 5.95 },
    { date: '2024-12-18', rate: 5.45 },
    { date: '2025-01-29', rate: 5.45 },
    { date: '2025-03-12', rate: 4.95 },
  ];
  const segments = [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }];
  const terms = [{ id: 1, start_date: '2024-12-17', amortization_years: 25 }];
  const r = buildSchedule({ balance: 100000, balanceDate: '2024-12-17', terms, segments, primeHistory });
  assert.equal(r.state, 'projected');
  const first = derivePayment(100000, 4.45, 25);
  assert.ok(close(r.paymentUsed, first, 0.001), r.paymentUsed);
  const jan = r.series.find((row) => row.month === '2025-01');
  const feb = r.series.find((row) => row.month === '2025-02');
  const mar = r.series.find((row) => row.month === '2025-03');
  // The monthly RATE steps with prime (Jan 4.45%, Mar 3.95%)...
  assert.equal(jan.rate, 4.45);
  assert.equal(mar.rate, 3.95);
  // ...but the payment is the derived payment in EVERY month (bar
  // the smaller final one), before and after the step alike.
  assert.ok(r.series.slice(0, -1).every((row) => row.payment === r.paymentUsed),
    'payment constant across the prime step');
  // What changes at the step is the split: January's interest is the
  // opening balance at 4.45%; March's is the February-end balance at
  // 3.95% — each hand-checkable at its own month's prime.
  assert.ok(close(jan.interest, 100000 * monthlyRate(4.45), 0.02), jan.interest);
  assert.ok(close(mar.interest, feb.balance * monthlyRate(3.95), 0.02), mar.interest);
  assert.ok(mar.principal > jan.principal, 'a bigger share of the same payment reaches principal after the step');
});

// ------------------------------------------------------- equal principal --
// 等额本金: the monthly principal is fixed (balance at the plan's
// start / amortization months remaining there) and each month pays
// it plus that month's interest, so payments decline steadily and
// the balance clears exactly at the amortization end.
// Hand fixture: $120,000 at 6% fixed, 10-year amortization.
//   monthly principal = 120000 / 120 = $1,000
//   month 1 interest = 120000 x monthlyRate(6%) = 120000 x 0.00493862
//                    = $592.63  -> payment $1,592.63, balance $119,000
//   month 2 interest = 119000 x 0.00493862 = $587.70 -> payment $1,587.70

test('buildSchedule equal principal: fixed principal, declining payments, clears at the amortization end', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 }];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 10, repayment_method: 'equal_principal' }];
  const r = buildSchedule({ balance: 120000, balanceDate: '2026-01-01', terms, segments });
  assert.equal(r.state, 'projected');
  assert.equal(r.series.length, 120); // exactly the amortization, no drift
  assert.equal(r.payoffMonth, '2036-01');
  assert.ok(r.series.every((row) => row.principal === 1000), 'every month pays exactly $1,000 of principal');
  assert.ok(close(r.series[0].interest, 592.63), r.series[0].interest);
  assert.ok(close(r.series[0].payment, 1592.63), r.series[0].payment);
  assert.ok(close(r.series[0].balance, 119000), r.series[0].balance);
  assert.ok(close(r.series[1].interest, 587.70), r.series[1].interest);
  assert.ok(close(r.series[1].payment, 1587.70), r.series[1].payment);
  // Payments decline monotonically; the last is principal + one
  // month's interest on the final $1,000.
  assert.ok(r.series.every((row, i) => i === 0 || row.payment < r.series[i - 1].payment), 'payments decline every month');
  assert.ok(close(r.series[119].payment, 1000 + 1000 * monthlyRate(6), 0.02), r.series[119].payment);
  assert.equal(r.series[119].balance, 0);
  // paymentUsed reports the first (highest) payment.
  assert.ok(close(r.paymentUsed, 1592.63), r.paymentUsed);
  // Equal principal costs less interest than the level payment on
  // the same loan (principal comes off faster from month one).
  const level = buildSchedule({
    balance: 120000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 10 }],
  });
  assert.ok(close(level.paymentUsed, derivePayment(120000, 6, 10), 0.02), level.paymentUsed);
  assert.ok(r.totalInterest < level.totalInterest, `${r.totalInterest} < ${level.totalInterest}`);
});

test('buildSchedule equal principal: a lump sum keeps the monthly principal and pulls the payoff in', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 }];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: 10, repayment_method: 'equal_principal' }];
  const base = { balance: 120000, balanceDate: '2026-01-01', terms, segments };
  const plain = buildSchedule(base);
  // $12,000 lands in projected month 13 (January 2027): exactly 12
  // monthly principals' worth, so the payoff pulls in 12 months.
  const withLump = buildSchedule({ ...base, lumpSums: [{ date: '2027-01-15', amount: 12000 }] });
  assert.deepEqual(withLump.series.slice(0, 11), plain.series.slice(0, 11));
  // January 2027: interest on the reduced balance (109,000 - 12,000
  // = 97,000), principal still exactly $1,000.
  const jan = withLump.series[11];
  assert.equal(jan.month, '2027-01');
  assert.ok(close(jan.interest, 97000 * monthlyRate(6), 0.02), jan.interest);
  assert.equal(jan.principal, 1000);
  assert.ok(withLump.series.every((row) => row.principal === 1000), 'the monthly principal never changes');
  assert.equal(withLump.payoffMonth, '2035-01'); // 12 months earlier than 2036-01
  assert.ok(withLump.totalInterest < plain.totalInterest);
});

test('buildSchedule equal principal: prime steps move only the interest, the principal is constant', () => {
  // Same fake prime history shape as the fixed-payment test, on an
  // equal-principal term: principal is 100000 / 300 = $333.33 every
  // month; January's interest prices at 4.45%, March's at 3.95%, so
  // the payment steps at the prime step by the interest difference
  // alone.
  const primeHistory = [
    { date: '2024-12-18', rate: 5.45 },
    { date: '2025-03-12', rate: 4.95 },
  ];
  const segments = [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }];
  const terms = [{ id: 1, start_date: '2024-12-17', amortization_years: 25, repayment_method: 'equal_principal' }];
  const r = buildSchedule({ balance: 100000, balanceDate: '2024-12-17', terms, segments, primeHistory });
  assert.equal(r.state, 'projected');
  assert.ok(r.series.every((row) => Math.abs(row.principal - 333.33) < 0.005 || row.balance === 0),
    'principal fixed at balance / amortization months');
  const feb = r.series.find((row) => row.month === '2025-02');
  const mar = r.series.find((row) => row.month === '2025-03');
  assert.equal(mar.rate, 3.95);
  assert.ok(close(mar.interest, feb.balance * monthlyRate(3.95), 0.02), mar.interest);
  assert.ok(close(mar.payment - mar.principal, mar.interest, 0.001), 'payment = principal + that month\u2019s interest');
});

test('buildSchedule per-term frequency: the second term runs on its own schedule and its own derived payment', () => {
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 },
    { start_date: '2031-01-01', rate_type: 'fixed', annual_rate: 4 },
  ];
  const terms = [
    { id: 1, start_date: '2026-01-01', amortization_years: 25 },
    { id: 2, start_date: '2031-01-01', amortization_years: 30, payment_frequency: 'bi_weekly' },
  ];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-15', terms, segments });
  assert.equal(r.state, 'projected');
  // Term 1 derives its payment (100k, 5%, 25y) and pays monthly on
  // the 15th (the balance-date day — no payment day set anywhere).
  assert.equal(r.paymentUsed, 581.60);
  const t1 = r.series.filter((row) => row.month < '2030-12');
  assert.ok(t1.length > 50 && t1.every((row) => row.payment === 581.60), 'term 1 rows all pay the derived 581.60');
  assert.ok(t1.every((row) => row.date.endsWith('-15')), 'term 1 nodes on the 15th');
  // Term 2 derives its OWN payment at its start — from the balance
  // term 1 hands over, at term 2's 4% segment, over its fresh
  // 30-year amortization — and pays it bi-weekly: the monthly
  // figure converts to a per-period amount (monthly x 12 / 26), so
  // each month totals 2 or 3 periods' worth, and ONLY term 2 pays
  // that way (the boundary month 2030-12, which both spans touch,
  // is left out of both assertions).
  // (The handover balance is read off a term-1-only run: in the
  // combined series the boundary month also carries a stray
  // term-2 period row, so the last 2030-12 row there is not it.)
  const t1Only = buildSchedule({ balance: 100000, balanceDate: '2026-01-15', terms: [terms[0]], segments: [segments[0]] });
  const handed = t1Only.series.find((row) => row.month === '2030-12').balance;
  const perPeriod = periodPaymentFor(derivePayment(handed, 4, 30), 'bi_weekly');
  const t2 = r.series.filter((row) => row.month > '2030-12');
  assert.ok(t2.length > 6, 'term 2 has rows');
  assert.ok(t2.slice(0, -1).every((row) => close(row.payment, 2 * perPeriod, 0.02) || close(row.payment, 3 * perPeriod, 0.02)),
    `term 2 months total 2-3 bi-weekly periods of ${perPeriod}: ${t2.slice(0, 6).map((x) => x.payment)}`);
  assert.ok(t2.some((row) => close(row.payment, 3 * perPeriod, 0.02)), 'a 3-period month appears');
});

test('buildSchedule per-term payment day: the deduction day switches at the term boundary', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const terms = [
    { id: 1, start_date: '2026-01-01', amortization_years: 25 },
    { id: 2, start_date: '2031-01-01', amortization_years: 25, payment_day: 1 },
  ];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-15', terms, segments });
  const before = r.series.filter((row) => row.month <= '2030-12');
  const after = r.series.filter((row) => row.month >= '2031-01');
  assert.ok(before.length > 50 && before.every((row) => row.date.endsWith('-15')), 'term 1 nodes on the 15th');
  assert.ok(after.length > 12 && after.every((row) => row.date.endsWith('-01')), 'term 2 nodes on the 1st');
});

test('buildSchedule in-term anchor: the balance resets at the anchor month, the plan does not recompute', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const plain = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25 }],
  });
  const anchored = buildSchedule({
    balance: 100000, balanceDate: '2026-01-01', segments,
    terms: [{ id: 1, start_date: '2026-01-01', amortization_years: 25, anchor_balance: 90000, anchor_date: '2027-01-01' }],
  });
  // Everything before the anchor month is identical, and the
  // payment in effect at the anchor is untouched.
  assert.deepEqual(
    anchored.series.filter((row) => row.month < '2027-01'),
    plain.series.filter((row) => row.month < '2027-01'));
  assert.equal(anchored.paymentUsed, plain.paymentUsed);
  // January 2027 prices off the reset balance: interest =
  // 90000 x monthlyRate(5%) = 371.15; the payment is unchanged, so
  // the balance after is 90000 + 371.15 - 581.60 = 89789.55.
  const jan = anchored.series.find((row) => row.month === '2027-01');
  assert.ok(close(jan.interest, 90000 * monthlyRate(5), 0.02), jan.interest);
  assert.equal(jan.payment, plain.paymentUsed);
  assert.ok(close(jan.balance, 89789.55, 0.02), jan.balance);
  assert.ok(anchored.payoffMonth < plain.payoffMonth, 'the smaller balance pays off sooner');
  assert.ok(anchored.totalInterest < plain.totalInterest);
});

test('remainingBalanceAt: mid-plan reads the last row at or before the current month', () => {
  const series = [
    { month: '2025-01', balance: 990000 },
    { month: '2025-02', balance: 980000 },
    { month: '2025-03', balance: 970000 },
  ];
  assert.deepEqual(remainingBalanceAt(series, '2025-02', 1000000), { balance: 980000, month: '2025-02' });
  // Past the last row without a payoff (horizon cap): the final
  // projected balance holds flat.
  assert.deepEqual(remainingBalanceAt(series, '2026-01', 1000000), { balance: 970000, month: '2025-03' });
});

test('remainingBalanceAt: a plan that has not started falls back to the anchor', () => {
  const series = [{ month: '2027-01', balance: 999000 }];
  assert.deepEqual(remainingBalanceAt(series, '2026-10', 1000000), { balance: 1000000, month: null });
});

test('remainingBalanceAt: no plan (empty or missing series) falls back to the anchor', () => {
  assert.deepEqual(remainingBalanceAt([], '2026-10', 1000000), { balance: 1000000, month: null });
  assert.deepEqual(remainingBalanceAt(null, '2026-10', 1000000), { balance: 1000000, month: null });
});

test('remainingBalanceAt: a paid-off loan reads 0 at and after the payoff month', () => {
  const series = [
    { month: '2025-01', balance: 5000 },
    { month: '2025-02', balance: 0 },
  ];
  assert.deepEqual(remainingBalanceAt(series, '2025-02', 1000000, '2025-02'), { balance: 0, month: '2025-02' });
  assert.deepEqual(remainingBalanceAt(series, '2025-09', 1000000, '2025-02'), { balance: 0, month: '2025-02' });
  // The payoff recorded with no final row still clears the balance.
  assert.deepEqual(remainingBalanceAt([], '2025-09', 1000000, '2025-02'), { balance: 0, month: '2025-02' });
  // A payoff still in the future changes nothing.
  assert.deepEqual(remainingBalanceAt(series, '2025-01', 1000000, '2025-02'), { balance: 5000, month: '2025-01' });
});

test('remainingBalanceAt: the user shape reproduces his Oct 2026 remaining balance', () => {
  // His real mortgage, priced off the actual BoC prime change
  // points: $1,350,000 at 2024-12-17, Prime - 1.00, 25-year
  // amortization, the payment derived once at signing (prime
  // 5.45 -> 4.45% -> $7,434.41) and never recast. His app's Total
  // row for Jan 2025 - Oct 2026 (22 months) shows $75,116 of
  // principal paid, i.e. $1,274,884 still owed at Oct 2026 — the
  // figure Current Principal must show, not $1,350,000.
  const primeHistory = [
    { date: '2024-06-12', rate: 6.95 }, { date: '2024-07-31', rate: 6.70 },
    { date: '2024-09-11', rate: 6.45 }, { date: '2024-10-30', rate: 5.95 },
    { date: '2024-12-18', rate: 5.45 }, { date: '2025-02-05', rate: 5.20 },
    { date: '2025-03-19', rate: 4.95 }, { date: '2025-09-24', rate: 4.70 },
    { date: '2025-11-05', rate: 4.45 },
  ];
  const r = buildSchedule({
    balance: 1350000, balanceDate: '2024-12-17',
    terms: [{ id: 1, start_date: '2024-12-17', amortization_years: 25 }],
    segments: [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }],
    primeRate: 4.45, primeHistory,
  });
  assert.equal(r.state, 'projected');
  assert.ok(close(r.paymentUsed, 7434.41, 0.02), r.paymentUsed);
  const rem = remainingBalanceAt(r.series, '2026-10', 1350000, r.payoffMonth);
  assert.equal(rem.month, '2026-10');
  assert.ok(close(rem.balance, 1274884, 0.5), rem.balance); // 1,274,883.56 before display rounding
  // One month earlier exactly one more payment of principal is owed.
  const sep = remainingBalanceAt(r.series, '2026-09', 1350000, r.payoffMonth);
  const octRow = r.series.find((x) => x.month === '2026-10');
  assert.ok(close(sep.balance - rem.balance, octRow.principal, 0.02));
});

test('primeDailyResolver: steps land on effective dates (first observation minus 6 days), not observation dates', () => {
  const primeHistory = [
    { date: '2024-12-04', rate: 5.95 }, { date: '2024-12-18', rate: 5.45 },
    { date: '2025-02-05', rate: 5.20 }, { date: '2025-03-19', rate: 4.95 },
    { date: '2025-09-24', rate: 4.70 }, { date: '2025-11-05', rate: 4.45 },
  ];
  const resolve = primeDailyResolver(primeHistory, null);
  assert.equal(resolve('2024-12-11'), 5.95); // the Dec 11 cut is not effective yet
  assert.equal(resolve('2024-12-12'), 5.45); // prime moves the day after the announcement
  assert.equal(resolve('2025-01-29'), 5.45);
  assert.equal(resolve('2025-01-30'), 5.20);
  assert.equal(resolve('2025-03-12'), 5.20);
  assert.equal(resolve('2025-03-13'), 4.95);
  assert.equal(resolve('2025-09-17'), 4.95);
  assert.equal(resolve('2025-09-18'), 4.70);
  assert.equal(resolve('2025-10-29'), 4.70);
  assert.equal(resolve('2025-10-30'), 4.45);
  // Before the first step the earliest rate holds; scalar fallback
  // and the empty case mirror the other resolvers.
  assert.equal(resolve('2024-01-01'), 5.95);
  assert.equal(primeDailyResolver(null, 4.95)('2030-01-01'), 4.95);
  assert.equal(primeDailyResolver([], null), null);
});

test('daily accrual: the real RBC loan tracks the bank statement balances within $35', () => {
  // The user's real parameters: $1,350,000 from 2024-12-17,
  // Prime - 1 monthly-compounded, payment override $7,207.10.
  // Bank statement balances after the May / September / October
  // 2026 payments: $1,298,865.69 / $1,285,077.63 / $1,281,514.52.
  // Monthly accrual misses them by -643.94 / -814.78 / -766.51;
  // daily accrual (period interest = period-start balance x the
  // sum of each day's annual rate / 365 over (prevPayDate,
  // payDate], prime stepping on its effective dates) lands
  // within $35 on all three — a one-time ~$31 level difference
  // (settlement-day boundaries around the origination
  // prepayment), NOT something to chase to zero.
  const primeHistory = [
    { date: '2024-12-04', rate: 5.95 }, { date: '2024-12-18', rate: 5.45 },
    { date: '2025-02-05', rate: 5.20 }, { date: '2025-03-19', rate: 4.95 },
    { date: '2025-09-24', rate: 4.70 }, { date: '2025-11-05', rate: 4.45 },
  ];
  const mk = (accrual) => buildSchedule({
    balance: 1350000, balanceDate: '2024-12-17', primeHistory,
    terms: [{ id: 1, start_date: '2024-12-17', amortization_years: 30, payment_override: 7207.10 }],
    segments: [{ id: 1, start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'monthly', ...(accrual ? { accrual } : {}) }],
  });
  const bal = (r, m) => r.series.find((x) => x.month === m).balance;
  const BANK = { '2026-05': 1298865.69, '2026-09': 1285077.63, '2026-10': 1281514.52 };
  const daily = mk('daily');
  for (const m of Object.keys(BANK)) {
    const residual = bal(daily, m) - BANK[m];
    assert.ok(Math.abs(residual) <= 35, `${m}: daily residual ${residual} within $35 of the bank`);
  }
  assert.equal(bal(daily, '2026-05'), 1298835.02); // -30.67
  assert.equal(bal(daily, '2026-09'), 1285046.59); // -31.04
  assert.equal(bal(daily, '2026-10'), 1281483.39); // -31.13
  // The default (monthly) accrual is untouched to the cent.
  const monthly = mk('monthly');
  assert.equal(bal(monthly, '2026-05'), 1298221.75); // -643.94
  assert.equal(bal(monthly, '2026-09'), 1284262.85); // -814.78
  assert.equal(bal(monthly, '2026-10'), 1280748.01); // -766.51
  assert.equal(bal(mk(), '2026-10'), 1280748.01); // omitted field = monthly
  // Payment derivation never reads the accrual choice: the
  // locked-on anchors stand with a daily segment too.
  const locked = buildSchedule({
    balance: 1450000, balanceDate: '2024-12-17', primeHistory,
    terms: [{ id: 1, start_date: '2024-12-17', amortization_years: 30 }],
    segments: [{ id: 1, start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'monthly', accrual: 'daily', locked_on: '2024-12-10' }],
    lumpSums: [{ id: 1, date: '2024-12-20', amount: 100000 }],
  });
  assert.equal(locked.paymentDerived, 7205.89);
});

test('daily accrual on a fixed segment: the nominal rate over the actual days, no compounding conversion', () => {
  // $100,000 at 3.65% fixed: a 31-day period accrues exactly
  // $10/day = $310.00 daily; monthly accrual converts instead
  // (3.65/12 -> $304.17).
  const mk = (accrual) => simulate({
    balance: 100000, balanceDate: '2026-01-15', payment: 2000,
    segments: [{ start_date: '2026-01-15', rate_type: 'fixed', annual_rate: 3.65, compounding: 'monthly', accrual }],
  });
  assert.equal(mk('daily').series[0].interest, 310.00);
  assert.equal(mk('monthly').series[0].interest, 304.17);
});
