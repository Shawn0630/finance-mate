import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the exact file the browser ships (a classic script with
// no top-level side effects) and exercise its pure helpers.
const src = fs.readFileSync(new URL('../public/rent-income.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { rentMonthlySeries, rentRangeShare, rentHistoryData, rentEntryMonths } = sandbox;
// Arrays built inside the vm context carry that realm's
// Array.prototype, which deepStrictEqual rejects against host
// arrays — normalize through JSON before asserting.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Two rentals: A rents 1000/mo all of 2025; B rents 3000/mo Jan–Jun
// 2025. C has two overlapping tenancies in Mar 2025 (1000 + 500).
const rentals = [
  { id: 1, label: 'A', entries: [{ start_ym: '2025-01', end_ym: '2025-12', monthly_rent: 1000 }] },
  { id: 2, label: 'B', entries: [{ start_ym: '2025-01', end_ym: '2025-06', monthly_rent: 3000 }] },
  { id: 3, label: 'C', entries: [
    { start_ym: '2025-03', end_ym: '2025-03', monthly_rent: 1000 },
    { start_ym: '2025-03', end_ym: '2025-03', monthly_rent: 500 },
  ] },
];

test('rentEntryMonths: ongoing entries run through the current month', () => {
  assert.deepEqual(plain(rentEntryMonths({ start_ym: '2026-08', end_ym: '', monthly_rent: 100 }, '2026-10')),
    ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(plain(rentEntryMonths({ start_ym: 'bogus', monthly_rent: 100 }, '2026-10')), []);
  assert.deepEqual(plain(rentEntryMonths({ start_ym: '2026-05', end_ym: '2026-03', monthly_rent: 100 }, '2026-10')), []);
});

test('rentMonthlySeries: overlapping tenancies sum rent in the shared month', () => {
  const s = rentMonthlySeries(rentals, '2026-10');
  const c = s.find((x) => x.rental.id === 3);
  assert.deepEqual(plain(c.months), [{ month: '2025-03', value: 1500 }]);
  const a = s.find((x) => x.rental.id === 1);
  assert.equal(a.months.length, 12);
  assert.equal(a.months[0].value, 1000);
  const b = s.find((x) => x.rental.id === 2);
  assert.equal(b.months.length, 6);
});

test('rentMonthlySeries: ongoing entries extend through now', () => {
  const s = rentMonthlySeries(
    [{ id: 9, label: 'O', entries: [{ start_ym: '2026-08', end_ym: null, monthly_rent: 700 }] }],
    '2026-10');
  assert.deepEqual(plain(s[0].months.map((m) => m.month)), ['2026-08', '2026-09', '2026-10']);
});

test('rentRangeShare: share is over the range (a flow), not the end month value', () => {
  const s = rentMonthlySeries(rentals, '2026-10');
  // Full 2025: A 12000, B 18000, C 1500.
  const full = rentRangeShare(s, { start: '2025-01', end: '2025-12' }, new Set());
  assert.deepEqual(plain(full.rows.map((r) => [r.rental.label, r.value])), [['A', 12000], ['B', 18000], ['C', 1500]]);
  assert.equal(full.total, 31500);
  assert.equal(full.visibleTotal, 31500);
  // H1 2025 only: A 6000, B 18000, C 1500 — B's share is NOT its
  // June value (3000) but its half-year total.
  const h1 = rentRangeShare(s, { start: '2025-01', end: '2025-06' }, new Set());
  assert.deepEqual(plain(h1.rows.map((r) => [r.rental.label, r.value])), [['A', 6000], ['B', 18000], ['C', 1500]]);
  // A range with no income at all yields no rows.
  assert.deepEqual(plain(rentRangeShare(s, { start: '2024-01', end: '2024-12' }, new Set()).rows), []);
});

test('rentRangeShare: hidden rentals stay in rows but leave the visible total', () => {
  const s = rentMonthlySeries(rentals, '2026-10');
  const r = rentRangeShare(s, { start: '2025-01', end: '2025-12' }, new Set([2]));
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.find((x) => x.rental.id === 2).hidden, true);
  assert.equal(r.total, 31500);
  assert.equal(r.visibleTotal, 13500);
});

test('rentRangeShare: zero-income rentals get no slice', () => {
  const s = rentMonthlySeries(
    [{ id: 5, label: 'Zero', entries: [{ start_ym: '2025-01', end_ym: '2025-12', monthly_rent: 0 }] }],
    '2026-10');
  assert.deepEqual(plain(rentRangeShare(s, { start: '2025-01', end: '2025-12' }, new Set()).rows), []);
});

test('rentHistoryData: months zero-filled, totals visible-only', () => {
  const s = rentMonthlySeries(rentals, '2026-10');
  const h = rentHistoryData(s, { start: '2025-01', end: '2025-03' }, new Set([2]));
  assert.deepEqual(plain(h.months), ['2025-01', '2025-02', '2025-03']);
  const b = h.perRental.find((p) => p.rental.id === 2);
  assert.deepEqual(plain(b.values), [3000, 3000, 3000]);
  assert.equal(b.hidden, true);
  // Totals exclude hidden B: Jan 1000 (A only), Mar 1000 + 1500 (A + C).
  assert.deepEqual(plain(h.totals), [1000, 1000, 2500]);
});

test('rentRangeShare ignores non-entry fields: year-record other income never enters', () => {
  const s = rentMonthlySeries(
    [{ id: 7, label: 'D', entries: [{ start_ym: '2025-01', end_ym: '2025-12', monthly_rent: 1000 }],
       years: [{ tax_year: 2025, other_income: 5000 }] }],
    '2026-10');
  const r = rentRangeShare(s, { start: '2025-01', end: '2025-12' }, new Set());
  assert.deepEqual(plain(r.rows.map((x) => [x.rental.label, x.value])), [['D', 12000]]);
  assert.equal(r.total, 12000);
});
