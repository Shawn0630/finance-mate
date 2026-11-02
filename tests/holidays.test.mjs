// Holiday calendar: CA federal + BC + US federal, computed per year.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isHoliday, adjustPayday, holidaysForYear } from '../src/holidays.js';

test('holidays: fixed dates and weekday rules, 2026', () => {
  const h = holidaysForYear(2026);
  for (const d of [
    // Canadian federal statutory.
    '2026-01-01', '2026-04-03', '2026-07-01', '2026-09-07', '2026-09-30',
    '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-26',
    // BC statutory (beyond federal).
    '2026-02-16', '2026-05-18', '2026-08-03',
    // US federal.
    '2026-01-19', '2026-05-25', '2026-06-19', '2026-07-04', '2026-11-26',
  ]) assert.ok(h.has(d), d);
  // Ordinary days are not holidays.
  for (const d of ['2026-01-02', '2026-11-06', '2026-12-24', '2026-10-23']) {
    assert.ok(!h.has(d), d);
  }
});

test('holidays: Easter moves year to year (Good Friday)', () => {
  assert.ok(isHoliday('2025-04-18')); // Easter Apr 20, 2025
  assert.ok(isHoliday('2027-03-26')); // Easter Mar 28, 2027
  assert.ok(!isHoliday('2026-04-18'));
  assert.ok(!isHoliday('2026-02-30'));
  assert.ok(!isHoliday('garbage'));
  assert.ok(!isHoliday(null));
});

test('adjustPayday: one day earlier, consecutive holidays loop', () => {
  assert.equal(adjustPayday('2026-12-25'), '2026-12-24');
  assert.equal(adjustPayday('2026-12-26'), '2026-12-24'); // never Dec 25 itself
  assert.equal(adjustPayday('2026-11-06'), '2026-11-06');
  assert.equal(adjustPayday('2026-07-04'), '2026-07-03'); // literal date, even on a weekend
});
