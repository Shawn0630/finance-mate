import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the exact file the browser ships (a classic script with
// no top-level side effects) and exercise its pure helpers.
const src = fs.readFileSync(new URL('../public/overview-chart.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { overviewPropertyAtMonth, overviewStockAtMonth, overviewMonthly, overviewShareAtMonth } = sandbox;
// Arrays built inside the vm context carry that realm's
// Array.prototype, which deepStrictEqual rejects against host
// arrays — normalize through JSON before asserting.
const plain = (v) => JSON.parse(JSON.stringify(v));

const assessed = [
  { year: 2024, total: 500000 },
  { year: 2025, total: 600000 },
];
const stocks = [
  { month: '2024-06', value: 10000 },
  { month: '2024-09', value: 15000 },
  { month: '2025-02', value: 20000 },
];

test('overviewPropertyAtMonth: carries the assessed total across its year, 0 before the first year', () => {
  assert.equal(overviewPropertyAtMonth(assessed, '2024-03'), 500000);
  assert.equal(overviewPropertyAtMonth(assessed, '2024-12'), 500000);
  assert.equal(overviewPropertyAtMonth(assessed, '2025-06'), 600000);
  assert.equal(overviewPropertyAtMonth(assessed, '2026-01'), 600000);
  assert.equal(overviewPropertyAtMonth(assessed, '2023-12'), 0);
});

test('overviewStockAtMonth: carries the last point at or before the month, 0 before the first point', () => {
  assert.equal(overviewStockAtMonth(stocks, '2024-06'), 10000);
  assert.equal(overviewStockAtMonth(stocks, '2024-08'), 10000);
  assert.equal(overviewStockAtMonth(stocks, '2024-09'), 15000);
  assert.equal(overviewStockAtMonth(stocks, '2025-12'), 20000);
  assert.equal(overviewStockAtMonth(stocks, '2024-05'), 0);
});

test('overviewMonthly: union of stock months and property months from January of the first assessed year', () => {
  const m = overviewMonthly(assessed, stocks, '2025-03');
  const byMonth = new Map(m.map((r) => [r.month, r]));
  // Property months start 2024-01 even though stocks start 2024-06.
  assert.equal(byMonth.get('2024-01').property, 500000);
  assert.equal(byMonth.get('2024-01').stock, 0);
  assert.equal(byMonth.get('2024-01').total, 500000);
  // Stock carries forward between points; property steps at the year.
  assert.equal(byMonth.get('2024-08').stock, 10000);
  assert.equal(byMonth.get('2025-01').property, 600000);
  assert.equal(byMonth.get('2025-01').stock, 15000);
  assert.equal(byMonth.get('2025-01').total, 615000);
  assert.equal(byMonth.get('2025-03').stock, 20000);
  assert.equal(byMonth.get('2025-03').total, 620000);
  // Months are sorted and end at the current month.
  assert.equal(m[0].month, '2024-01');
  assert.equal(m[m.length - 1].month, '2025-03');
});

test('overviewMonthly: stock-only history has no property months', () => {
  const m = overviewMonthly([], stocks, '2025-03');
  assert.deepEqual(plain(m.map((r) => r.month)), ['2024-06', '2024-09', '2025-02']);
  assert.ok(m.every((r) => r.property === 0));
});

test('overviewShareAtMonth: exactly Property + Stock at the end month, zero portions dropped', () => {
  const r = overviewShareAtMonth(assessed, stocks, '2025-02');
  assert.deepEqual(plain(r.rows), [
    { label: 'Property', value: 600000 },
    { label: 'Stock', value: 20000 },
  ]);
  assert.equal(r.total, 620000);
  const early = overviewShareAtMonth(assessed, stocks, '2024-03');
  assert.deepEqual(plain(early.rows), [{ label: 'Property', value: 500000 }]);
  assert.equal(early.total, 500000);
  assert.deepEqual(plain(overviewShareAtMonth(assessed, stocks, null)), { rows: [], total: 0 });
  assert.deepEqual(plain(overviewShareAtMonth([], [], '2025-02')), { rows: [], total: 0 });
});
