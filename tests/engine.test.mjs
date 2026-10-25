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
import { monthlyRate, derivePayment, simulate, segmentForMonth, segmentAnnualRate, periodicRate, periodPaymentFor } from '../src/engine.js';

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
