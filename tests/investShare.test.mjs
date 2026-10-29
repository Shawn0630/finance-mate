import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load the exact file the browser ships (a classic script with
// no top-level side effects) and exercise its pure helper.
const src = fs.readFileSync(new URL('../public/invest-share.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { investShareAtMonth } = sandbox;
// Arrays built inside the vm context carry that realm's
// Array.prototype, which deepStrictEqual rejects against host
// arrays — normalize through JSON before asserting.
const plain = (v) => JSON.parse(JSON.stringify(v));

const accts = [
  { account: { id: 1, name: 'A' }, series: [
    { month: '2026-01', value: 100 }, { month: '2026-02', value: 150 }, { month: '2026-03', value: 200 } ] },
  { account: { id: 2, name: 'B' }, series: [
    { month: '2026-02', value: 50 } ] },
  { account: { id: 3, name: 'Empty' }, series: [] },
];

test('investShareAtMonth: shares at a past end month use the last point at or before it', () => {
  const r = investShareAtMonth(accts, '2026-02');
  assert.deepEqual(plain(r.rows.map((x) => [x.account.name, x.value])), [['A', 150], ['B', 50]]);
  assert.equal(r.total, 200);
});

test('investShareAtMonth: values carry forward past the last point', () => {
  const r = investShareAtMonth(accts, '2026-05');
  assert.deepEqual(plain(r.rows.map((x) => [x.account.name, x.value])), [['A', 200], ['B', 50]]);
  assert.equal(r.total, 250);
});

test('investShareAtMonth: before the first point, and null end month, yield no shares', () => {
  assert.deepEqual(plain(investShareAtMonth(accts, '2025-12')), { rows: [], total: 0 });
  assert.deepEqual(plain(investShareAtMonth(accts, null)), { rows: [], total: 0 });
});

test('investShareAtMonth: zero-value and point-less accounts are excluded', () => {
  const r = investShareAtMonth([
    { account: { id: 1, name: 'Zero' }, series: [{ month: '2026-01', value: 0 }] },
    { account: { id: 2, name: 'None' }, series: [] },
    { account: { id: 3, name: 'Live' }, series: [{ month: '2026-01', value: 75 }] },
  ], '2026-01');
  assert.deepEqual(plain(r.rows.map((x) => x.account.name)), ['Live']);
  assert.equal(r.total, 75);
});

test('investShareAtMonth: unsorted points still resolve to the latest month at or before the end', () => {
  const r = investShareAtMonth([
    { account: { id: 1, name: 'A' }, series: [
      { month: '2026-03', value: 300 }, { month: '2026-01', value: 100 }, { month: '2026-02', value: 200 } ] },
  ], '2026-02');
  assert.deepEqual(plain(r.rows.map((x) => x.value)), [200]);
});

test('investShareAtMonth: the last month gives the current values', () => {
  const r = investShareAtMonth(accts, '2026-03');
  assert.deepEqual(plain(r.rows.map((x) => [x.account.name, x.value])), [['A', 200], ['B', 50]]);
  assert.equal(r.total, 250);
});
