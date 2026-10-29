import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the exact file the browser ships (a classic script with
// no top-level side effects) and exercise its pure helper.
const src = fs.readFileSync(new URL('../public/invest-visible.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { investVisibleAggregate } = sandbox;
// Arrays built inside the vm context carry that realm's
// Array.prototype, which deepStrictEqual rejects against host
// arrays — normalize through JSON before asserting.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Monthly rows in the server aggregate's shape (round2'd).
// A: Jan 1000 in, Feb +100 contrib +10 div +90 gain.
// B: Feb only, 400 in +100 gain, cost-unknown (position units).
const accts = [
  { account: { id: 1, name: 'A' },
    monthly: [
      { month: '2026-01', startValue: 0, endValue: 1000, contributions: 1000, dividends: 0, gain: 0, returnAmount: 0 },
      { month: '2026-02', startValue: 1000, endValue: 1190, contributions: 100, dividends: 10, gain: 90, returnAmount: 100 },
    ],
    summary: { value: 1190, contributions: 1100, dividends: 10, totalReturn: 100, costUnknown: false } },
  { account: { id: 2, name: 'B' },
    monthly: [
      { month: '2026-02', startValue: 0, endValue: 500, contributions: 400, dividends: 0, gain: 100, returnAmount: 100 },
    ],
    summary: { value: 500, contributions: 400, dividends: 0, totalReturn: 100, costUnknown: true } },
];

test('investVisibleAggregate: all visible sums monthly rows and recomputes return %', () => {
  const r = investVisibleAggregate(accts, new Set());
  assert.deepEqual(plain(r.monthly), [
    { month: '2026-01', startValue: 0, endValue: 1000, contributions: 1000, dividends: 0, gain: 0, returnAmount: 0, returnPct: 0 },
    { month: '2026-02', startValue: 1000, endValue: 1690, contributions: 500, dividends: 10, gain: 190, returnAmount: 200, returnPct: 13.33 },
  ]);
  assert.deepEqual(plain(r.series), [
    { month: '2026-01', value: 1000, contributions: 1000, returnAmount: 0 },
    { month: '2026-02', value: 1690, contributions: 1500, returnAmount: 200 },
  ]);
  assert.equal(r.summary.value, 1690);
  assert.equal(r.summary.contributions, 1500);
  assert.equal(r.summary.dividends, 10);
  assert.equal(r.summary.totalReturn, 200);
  assert.equal(r.summary.totalReturnPct, 13.33);
  assert.equal(r.summary.costUnknown, true);
  // Monthly identity holds on every recomputed row.
  for (const row of r.monthly) {
    assert.equal(row.endValue, row.startValue + row.contributions + row.gain);
  }
});

test('investVisibleAggregate: hiding the cost-unknown account un-suppresses gain', () => {
  const r = investVisibleAggregate(accts, new Set([2]));
  assert.deepEqual(plain(r.monthly), [
    { month: '2026-01', startValue: 0, endValue: 1000, contributions: 1000, dividends: 0, gain: 0, returnAmount: 0, returnPct: 0 },
    { month: '2026-02', startValue: 1000, endValue: 1190, contributions: 100, dividends: 10, gain: 90, returnAmount: 100, returnPct: 9.09 },
  ]);
  assert.equal(r.summary.value, 1190);
  assert.equal(r.summary.totalReturn, 100);
  assert.equal(r.summary.totalReturnPct, 9.09);
  assert.equal(r.summary.costUnknown, false);
});

test('investVisibleAggregate: hiding the earliest account zero-fills the span, axis stable', () => {
  const r = investVisibleAggregate(accts, new Set([1]), ['2026-01', '2026-02']);
  assert.deepEqual(plain(r.monthly), [
    { month: '2026-02', startValue: 0, endValue: 500, contributions: 400, dividends: 0, gain: 100, returnAmount: 100, returnPct: 25 },
  ]);
  assert.deepEqual(plain(r.series), [
    { month: '2026-01', value: 0, contributions: 0, returnAmount: 0 },
    { month: '2026-02', value: 500, contributions: 400, returnAmount: 100 },
  ]);
  assert.equal(r.summary.value, 500);
});

test('investVisibleAggregate: hiding everything yields empty months and a zero summary', () => {
  const r = investVisibleAggregate(accts, new Set([1, 2]));
  assert.deepEqual(plain(r.monthly), []);
  assert.deepEqual(plain(r.series), []);
  assert.deepEqual(plain(r.summary), {
    value: 0, contributions: 0, dividends: 0, totalReturn: 0, totalReturnPct: null, costUnknown: false,
  });
});
