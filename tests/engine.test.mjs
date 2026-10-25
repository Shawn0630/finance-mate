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
import { monthlyRate, derivePayment, simulate, segmentForMonth } from '../src/engine.js';

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
