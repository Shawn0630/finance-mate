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
import { monthlyRate, derivePayment, simulate, buildSchedule, segmentForMonth, segmentAnnualRate, periodicRate, periodPaymentFor, primeHistoryResolver, primeStepMonths } from '../src/engine.js';

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
  assert.equal(sched.paymentSource, 'derived');
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
  assert.equal(r.paymentSource, 'derived');
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

test('buildSchedule: the entered payment is an override inside the anchor term only', () => {
  const segments = [
    { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 },
    { start_date: '2031-01-01', rate_type: 'fixed', annual_rate: 4 },
  ];
  const terms = [
    { id: 1, start_date: '2026-01-01', amortization_years: 25 },
    { id: 2, start_date: '2031-01-01', amortization_years: 30 },
  ];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments, paymentOverride: 700 });
  assert.equal(r.paymentSource, 'entered');
  assert.equal(r.paymentUsed, 700);
  const t1 = r.series.filter((row) => row.month < '2031-01');
  assert.ok(t1.every((row) => row.payment === 700 || row.balance === 0));
  // At the renewal the override lapses: the payment is auto-computed
  // from term 2's closing balance over its 30-year amortization.
  const bLast = t1[t1.length - 1].balance;
  const first2 = r.series.find((row) => row.month === '2031-01');
  assert.ok(close(first2.payment, derivePayment(bLast, 4, 30), 0.02), first2.payment);
  assert.ok(first2.payment !== 700);
});

test('buildSchedule: no amortization and no override is a named no_payment state', () => {
  const segments = [{ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }];
  const terms = [{ id: 1, start_date: '2026-01-01', amortization_years: null }];
  const r = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments });
  assert.equal(r.state, 'no_payment');
  assert.equal(r.series.length, 0);
  // The same term WITH an entered payment projects on the override.
  const withOverride = buildSchedule({ balance: 100000, balanceDate: '2026-01-01', terms, segments, paymentOverride: 600 });
  assert.equal(withOverride.state, 'projected');
  assert.equal(withOverride.paymentUsed, 600);
  assert.ok(close(withOverride.totalInterest, 69494.74), withOverride.totalInterest);
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

test('buildSchedule: a prime step recasts the payment from the step month (adjustable-rate replay)', () => {
  // Fake history in the real series' shape: prime 5.45 when the term
  // starts (Dec 2024), stepping to 4.95 in March 2025. The payment is
  // derived at the START month's prime (5.45 - 1 = 4.45%, 25 years);
  // from March it is recast at 3.95% against the payoff the loan was
  // already heading to — hand-checkable below via a fixed-rate
  // extrapolation of the February state.
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
  assert.equal(jan.rate, 4.45);
  assert.equal(jan.payment, r.paymentUsed);
  assert.equal(feb.payment, r.paymentUsed);
  assert.equal(mar.rate, 3.95);
  // Hand-check the recast: extrapolate the February state at the old
  // rate/payment to its payoff, then derive at 3.95% over the months
  // left to that same payoff.
  const hypo = simulate({
    balance: feb.balance, balanceDate: feb.date, payment: r.paymentUsed,
    segments: [{ start_date: '2025-02-01', rate_type: 'fixed', annual_rate: 4.45 }],
  });
  const [py, pm] = hypo.payoffMonth.split('-').map(Number);
  const [fy, fm] = feb.month.split('-').map(Number);
  const monthsLeft = (py * 12 + pm) - (fy * 12 + fm);
  const expected = derivePayment(feb.balance, 3.95, monthsLeft / 12);
  assert.ok(close(mar.payment, expected, 0.02), `${mar.payment} vs ${expected}`);
  assert.ok(mar.payment < r.paymentUsed, 'the payment steps DOWN with prime');
  // And it then holds at the recast value (no further steps).
  const apr = r.series.find((row) => row.month === '2025-04');
  assert.equal(apr.payment, mar.payment);
});
