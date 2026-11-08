// Home page insights: standard cards + highlight rollover rule.
// Pure computation (src/home.js) — no DB, no LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStandardInsights, homeHighlightRows, resolveHomeMetric, buildHomeMetricLibrary,
  displayedSalaryMonths, homeOrderKey, applyHomeInsightOrder, mortgageMonthPaymentDates,
  jobTakehomePeriods, homeCalendarDates, rentalMonthOccurrence, homeCalendarFocusTarget,
  homeCalDayIsActionable, homeLongPressMoved, homeDropBefore,
  trailing12, lastCompletedMonth, monthLabel,
} from '../src/home.js';
import { calcSalary } from '../src/earnings.js';
import { payroll } from '../src/regions/ca.js';

const months = (start, values, field) => {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  for (const v of values) {
    out.push({ month: `${y}-${String(m).padStart(2, '0')}`, [field]: v });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
};

test('home: month helpers', () => {
  assert.equal(lastCompletedMonth('2026-11'), '2026-10');
  assert.equal(lastCompletedMonth('2026-01'), '2025-12');
  assert.deepEqual(trailing12('2026-11').slice(0, 1), ['2025-12']);
  assert.equal(trailing12('2026-11').length, 12);
  assert.equal(trailing12('2026-11')[11], '2026-11');
  assert.equal(monthLabel('2026-11'), 'Nov 2026');
});

test('home: property cards use current month-end with MoM + YoY deltas', () => {
  // Equity: Nov 2025 100,000 → Oct 2026 118,000 → Nov 2026 120,000.
  const equity = months('2025-11', [100000, 101000, 102000, 103000, 104000, 105000, 106000, 107000, 108000, 109000, 110000, 118000, 120000], 'equity')
    .map((r, i) => ({ ...r, assessed: 200000 + i * 1000, outstanding: 100000 - i * 500 }));
  const cards = buildStandardInsights({ currentYm: '2026-11', property: equity, stocks: { months: [] }, earnings: [], spending: [] });
  const eq = cards.find((c) => c.metric === 'property_equity');
  assert.equal(eq.value, 120000);
  assert.equal(eq.period, '2026-11');
  assert.equal(eq.periodLabel, 'Nov 2026');
  assert.deepEqual(eq.mom, { delta: 2000, pct: 1.69 });
  assert.deepEqual(eq.yoy, { delta: 20000, pct: 20 });
  assert.equal(eq.spark.length, 12);
  assert.equal(eq.spark[11], 120000);
  assert.equal(eq.spark[0], 101000); // Dec 2025, trailing 12 ends Nov 2026
  const out = cards.find((c) => c.metric === 'property_outstanding');
  assert.equal(out.downIsGood, true);
  assert.deepEqual(out.mom, { delta: -500, pct: -0.53 });
});

test('home: flow cards use the last completed month', () => {
  const earnings = months('2025-10', [4000, 4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200, 5300], 'total')
    .map((r) => ({ ...r, salary: r.total - 1000, rental: 1000 }));
  const cards = buildStandardInsights({ currentYm: '2026-11', property: [], stocks: { months: [] }, earnings, spending: [] });
  const total = cards.find((c) => c.metric === 'earning_total');
  assert.equal(total.period, '2026-10');
  assert.equal(total.value, 5200);
  assert.deepEqual(total.mom, { delta: 100, pct: 1.96 });
  assert.deepEqual(total.yoy, { delta: 1200, pct: 30 });
  const salary = cards.find((c) => c.metric === 'earning_salary');
  assert.equal(salary.value, 4200);
  const rental = cards.find((c) => c.metric === 'earning_rental');
  assert.equal(rental.value, 1000);
  assert.deepEqual(rental.mom, { delta: 0, pct: 0 });
});

test('home: displayedSalaryMonths subtracts the month tax benefit (displayed cash, not engine net)', () => {
  // October: no plan yet, benefit $0 — unchanged. November: plan
  // active, benefit $180 for the month — the displayed cash is
  // net − benefit. This is the fallback path (no per-payday rows):
  // the series the cards are built from is the same jobMonthlySeries
  // the monthly-chart endpoint returns (pinned in e2e).
  assert.deepEqual(displayedSalaryMonths({
    months: ['2026-10', '2026-11'],
    net: [6000, 6000],
    taxBenefit: [0, 180],
  }), [
    { month: '2026-10', salary: 6000 },
    { month: '2026-11', salary: 5820 },
  ]);
  // A series without a taxBenefit array (bare jobMonthlySeries call
  // without job/payroll) keeps net as-is.
  assert.deepEqual(displayedSalaryMonths({ months: ['2026-10'], net: [6000], taxBenefit: null }),
    [{ month: '2026-10', salary: 6000 }]);
  assert.deepEqual(displayedSalaryMonths(null), []);
  assert.deepEqual(displayedSalaryMonths({ months: [], net: [], taxBenefit: [] }), []);
});

test('home: displayedSalaryMonths prices the benefit like the job page (annual-first per-period benefit)', () => {
  // Fixture rounding case: the per-payday benefit is $62.06 but the
  // job page's annual-first per-period benefit is $62.05 — the
  // displayed cash must match the job page (2 × $2,257.78 =
  // $4,515.56), not the per-payday sum (2 × $2,257.77 = $4,515.54).
  assert.deepEqual(displayedSalaryMonths({
    months: ['2026-10', '2026-11'],
    net: [4955.64, 4639.66],
    taxBenefit: [0, 124.12],
    taxBenefitPays: [
      { date: '2026-11-06', benefit: 62.06 },
      { date: '2026-11-20', benefit: 62.06 },
    ],
  }, 62.05), [
    { month: '2026-10', salary: 4955.64 },
    { month: '2026-11', salary: 4515.56 },
  ]);
});

test('home: spending top category + biggest mover', () => {
  const mk = (month, total, byCategory) => ({ month, total, byCategory });
  const spending = [
    mk('2025-10', 1000, { Groceries: 400, Dining: 600 }),
    mk('2026-09', 2000, { Groceries: 800, Dining: 700, Travel: 500 }),
    mk('2026-10', 2600, { Groceries: 1500, Dining: 600, Travel: 500 }),
  ];
  const cards = buildStandardInsights({ currentYm: '2026-11', property: [], stocks: { months: [] }, earnings: [], spending });
  const top = cards.find((c) => c.metric === 'spending_top_category');
  assert.equal(top.value, 1500);
  assert.equal(top.sublabel, 'Groceries · 57.69% of spend');
  assert.deepEqual(top.mom, { delta: 700, pct: 87.5 });
  const mover = cards.find((c) => c.metric === 'spending_biggest_mover');
  // Groceries +700 is the largest absolute MoM move.
  assert.equal(mover.value, 700);
  assert.match(mover.sublabel, /Groceries/);
  assert.equal(mover.mom, null);
});

test('home: stock cards — value, cumulative gain, top gainer', () => {
  const stockMonths = months('2025-12', [10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000, 21000], 'value')
    .map((r, i) => ({ ...r, gain: 1000 + i * 1000 }));
  const cards = buildStandardInsights({
    currentYm: '2026-11', property: [], earnings: [], spending: [],
    stocks: {
      months: stockMonths,
      topGainer: {
        label: 'XQQ.TO', returnPct: 12.33,
        points: [{ date: '2025-10-31', price: 100 }, { date: '2026-10-31', price: 110 }, { date: '2026-11-30', price: 112.33 }],
        valueSeries: stockMonths,
      },
    },
  });
  const value = cards.find((c) => c.metric === 'stock_value');
  assert.equal(value.value, 21000);
  assert.deepEqual(value.mom, { delta: 1000, pct: 5 });
  const gain = cards.find((c) => c.metric === 'stock_gain');
  assert.equal(gain.value, 12000);
  const tg = cards.find((c) => c.metric === 'stock_top_gainer');
  assert.equal(tg.value, 12.33);
  assert.equal(tg.valueKind, 'pct');
  assert.equal(tg.sublabel, 'XQQ.TO');
  // Prior month's 12mo return: 110/100 − 1 = 10% → MoM +2.33 pts.
  assert.deepEqual(tg.mom, { delta: 2.33, pct: null });
});

test('home: empty sections render No data yet, never invented numbers', () => {
  const cards = buildStandardInsights({ currentYm: '2026-11', property: [], stocks: { months: [] }, earnings: [], spending: [] });
  assert.equal(cards.length, 12);
  for (const c of cards) {
    assert.equal(c.hasData, false, c.metric);
    assert.equal(c.value, null, c.metric);
  }
});

test('home: highlight — window is the current + previous month only', () => {
  // Bi-weekly job, recent payday 2026-10-23 → paydays … Oct 9, Oct 23, Nov 6, Nov 20.
  // Today is 2026-11-07: window is Oct + Nov 2026.
  const jobs = [{ id: 1, label: 'Acme', frequency: 'biweekly', startDate: '2026-01-02', recentDate: '2026-10-23', cashNet: 2000 }];
  const marks = new Map();
  const rows = homeHighlightRows({ jobs, rentals: [], marks, today: '2026-11-07' });
  // No marks: only the window's occurrences show — not the whole history back to Jan.
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-06', '2026-10-23', '2026-10-09']);
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows[0].amount, 2000);
  assert.equal(rows[0].received, null);
  // Mark every old occurrence as received: they roll off, only the current one stays.
  for (const r of rows) {
    if (r.date !== '2026-11-06') marks.set(`salary:1:${r.date}`, 1);
  }
  const rows2 = homeHighlightRows({ jobs, rentals: [], marks, today: '2026-11-07' });
  assert.deepEqual(rows2.map((r) => r.date), ['2026-11-06']);
  // When the next occurrence arrives (Nov 20), the marked Nov 6 row is
  // replaced by Nov 20 — but an unmarked Oct row in the window still shows.
  marks.set('salary:1:2026-11-06', 1);
  marks.delete('salary:1:2026-10-23');
  const rows3 = homeHighlightRows({ jobs, rentals: [], marks, today: '2026-11-21' });
  assert.deepEqual(rows3.map((r) => r.date), ['2026-11-20', '2026-10-23']);
  assert.ok(!rows3.some((r) => r.date === '2026-11-06'), 'marked Nov 6 rolled off');
  // An unmarked row older than the window drops off even unmarked.
  const rows4 = homeHighlightRows({ jobs, rentals: [], marks: new Map(), today: '2026-11-07' });
  assert.ok(!rows4.some((r) => r.date < '2026-10-01'), 'no September rows in the window');
});

test('home: highlight — a job without dates is skipped, never a guessed row', () => {
  const rows = homeHighlightRows({
    jobs: [{ id: 1, label: 'Legacy', frequency: 'biweekly', startDate: null, recentDate: null, cashNet: 1000 }],
    rentals: [], marks: new Map(), today: '2026-11-07',
  });
  assert.deepEqual(rows, []);
  const rows2 = homeHighlightRows({
    jobs: [{ id: 1, label: 'Bad freq', frequency: 'fortnightly', startDate: '2026-01-02', recentDate: '2026-10-23', cashNet: 1000 }],
    rentals: [], marks: new Map(), today: '2026-11-07',
  });
  assert.deepEqual(rows2, []);
});

test('home: highlight — payday on a holiday advances one day', () => {
  // Weekly Wednesdays from 2026-06-03 → a payday lands on 2026-07-01
  // (Canada Day) and must advance to 2026-06-30.
  const jobs = [{ id: 1, label: 'Acme', frequency: 'weekly', startDate: '2026-06-03', recentDate: '2026-06-24', cashNet: 1000 }];
  const marks = new Map([['salary:1:2026-06-03', 1], ['salary:1:2026-06-10', 1], ['salary:1:2026-06-17', 1], ['salary:1:2026-06-24', 1]]);
  const rows = homeHighlightRows({ jobs, rentals: [], marks, today: '2026-07-02' });
  assert.ok(rows.some((r) => r.date === '2026-06-30'), JSON.stringify(rows.map((r) => r.date)));
  assert.ok(!rows.some((r) => r.date === '2026-07-01'));
});

test('home: highlight — rental due day clamps to month length, most recent first', () => {
  const rentals = [{
    id: 7, label: 'Basement',
    entries: [{ id: 1, start_ym: '2026-01', end_ym: null, monthly_rent: 2000, pay_day: 31 }],
  }];
  // Today 2026-03-07, window Feb + Mar 2026: Mar 31 is still in the
  // future, so the current occurrence is Feb 28 (pay day 31 clamps).
  // Jan 31 is outside the window and never shows.
  const rows = homeHighlightRows({ jobs: [], rentals, marks: new Map(), today: '2026-03-07' });
  assert.deepEqual(rows.map((r) => r.date), ['2026-02-28']);
  assert.equal(rows[0].amount, 2000);
  assert.ok(!rows.some((r) => r.date === '2026-02-31'));
  // Most recent first, window-bounded: pay day 15, today Nov 20.
  const rows2 = homeHighlightRows({
    jobs: [],
    rentals: [{ id: 7, label: 'Basement', entries: [{ id: 1, start_ym: '2026-01', end_ym: null, monthly_rent: 2000, pay_day: 15 }] }],
    marks: new Map(), today: '2026-11-20',
  });
  assert.deepEqual(rows2.map((r) => r.date), ['2026-11-15', '2026-10-15']);
});

test('home: resolveHomeMetric — per-entity variants + unknown metric', () => {
  const data = {
    currentYm: '2026-11',
    property: months('2026-10', [500000, 510000], 'equity').map((r) => ({ ...r, assessed: 900000, outstanding: 390000 })),
    propertyById: {
      5: months('2026-10', [300000, 310000], 'equity').map((r) => ({ ...r, assessed: 500000, outstanding: 190000 })),
    },
    propertyLabels: { 5: '77 Riverbend' },
    stocks: { months: [], topGainer: null },
    holdingById: { 9: { label: 'XQQ.TO', months: months('2026-10', [10000, 11000], 'value').map((r) => ({ ...r, gain: 1000 })) } },
    earnings: [], spending: [],
    categorySeries: { Groceries: months('2026-09', [400, 500], 'total') },
  };
  const one = resolveHomeMetric('property_equity:5', data);
  assert.equal(one.value, 310000);
  assert.equal(one.title, '77 Riverbend equity');
  const h = resolveHomeMetric('holding_value:9', data);
  assert.equal(h.value, 11000);
  const cat = resolveHomeMetric('category_spend:Groceries', data);
  assert.equal(cat.value, 500);
  assert.equal(cat.period, '2026-10');
  assert.deepEqual(resolveHomeMetric('nope:1', data), { error: 'unknown_metric', message: 'That metric is not computable.' });
  const lib = buildHomeMetricLibrary({ properties: [{ id: 5, label: '77 Riverbend' }], holdings: [{ id: 9, label: 'XQQ.TO' }], categories: ['Groceries'] });
  assert.ok(lib.some((m) => m.metric === 'property_equity:5'));
  assert.ok(lib.some((m) => m.metric === 'holding_gain:9'));
  assert.ok(lib.some((m) => m.metric === 'category_spend:Groceries'));
  assert.equal(lib.filter((m) => m.metric === 'property_equity').length, 1);
});

test('home: resolveHomeMetric — per-entity cards carry the entity ref; standard cards do not', () => {
  const data = {
    currentYm: '2026-11',
    property: months('2026-10', [500000, 510000], 'equity').map((r) => ({ ...r, assessed: 900000, outstanding: 390000 })),
    propertyById: { 5: months('2026-10', [300000, 310000], 'equity').map((r) => ({ ...r, assessed: 500000, outstanding: 190000 })) },
    propertyLabels: { 5: '77 Riverbend' },
    stocks: { months: [], topGainer: null },
    holdingById: { 9: { label: 'XQQ.TO', months: months('2026-10', [10000, 11000], 'value').map((r) => ({ ...r, gain: 1000 })) } },
    earnings: [], spending: [],
    categorySeries: { Groceries: months('2026-09', [400, 500], 'total') },
    jobById: { 3: { label: 'Acme', months: months('2026-09', [2000, 2100], 'salary') } },
    rentalById: { 7: { label: 'Basement', months: months('2026-09', [2000, 2000], 'rental') } },
  };
  const prop = resolveHomeMetric('property_equity:5', data);
  assert.equal(prop.value, 310000);
  assert.deepEqual(prop.entity, { kind: 'property', id: 5 });
  const hold = resolveHomeMetric('holding_value:9', data);
  assert.equal(hold.value, 11000);
  assert.deepEqual(hold.entity, { kind: 'holding', id: 9 });
  const cat = resolveHomeMetric('category_spend:Groceries', data);
  assert.equal(cat.value, 500);
  assert.deepEqual(cat.entity, { kind: 'category', id: 'Groceries' });
  const job = resolveHomeMetric('job_takehome:3', data);
  assert.equal(job.value, 2100);
  assert.equal(job.period, '2026-10');
  assert.deepEqual(job.entity, { kind: 'job', id: 3 });
  const rent = resolveHomeMetric('rental_income:7', data);
  assert.equal(rent.value, 2000);
  assert.equal(rent.period, '2026-10');
  assert.deepEqual(rent.entity, { kind: 'rental', id: 7 });
  // A standard card carries no entity ref — the client falls back
  // to the section summary link.
  assert.equal(resolveHomeMetric('property_equity', data).entity, undefined);
  const lib = buildHomeMetricLibrary({
    properties: [{ id: 5, label: '77 Riverbend' }], holdings: [{ id: 9, label: 'XQQ.TO' }],
    categories: ['Groceries'], jobs: [{ id: 3, label: 'Acme' }], rentals: [{ id: 7, label: 'Basement' }],
  });
  assert.ok(lib.some((m) => m.metric === 'job_takehome:3' && m.section === 'earning'));
  assert.ok(lib.some((m) => m.metric === 'rental_income:7' && m.section === 'earning'));
  // Per-entity metrics never leak into the plain standard set.
  assert.equal(lib.filter((m) => m.metric === 'job_takehome').length, 0);
});

test('home: drag order — stored order re-applies, unlisted cards append at the end', () => {
  const cards = [
    { section: 'property', metric: 'property_equity', title: 'Total equity' },
    { section: 'property', metric: 'property_assessed', title: 'Assessed total' },
    { section: 'property', metric: 'property_outstanding', title: 'Outstanding principal' },
    { section: 'stock', metric: 'stock_value', title: 'Portfolio value' },
  ];
  assert.equal(homeOrderKey(cards[0]), 'property|property_equity|Total equity');
  // A drag that moved Assessed total first: the stored order wins.
  const ordered = applyHomeInsightOrder(cards, {
    property: ['property|property_assessed|Assessed total', 'property|property_equity|Total equity'],
  });
  assert.deepEqual(ordered.map((c) => c.metric),
    ['property_assessed', 'property_equity', 'property_outstanding', 'stock_value']);
  // A newly AI-appended card (not in the stored order) appends at the
  // end of its section; a regeneration (same metric + title, new row
  // id) keeps the order because the key never mentions the id.
  const withNew = [...cards, { section: 'property', metric: 'property_equity:9', title: 'Test home equity' }];
  const ordered2 = applyHomeInsightOrder(withNew, {
    property: ['property|property_assessed|Assessed total', 'property|property_equity|Total equity'],
  });
  assert.deepEqual(ordered2.map((c) => c.metric),
    ['property_assessed', 'property_equity', 'property_outstanding', 'property_equity:9', 'stock_value']);
  // No stored order at all: natural order, untouched.
  assert.deepEqual(applyHomeInsightOrder(cards, {}).map((c) => c.metric),
    ['property_equity', 'property_assessed', 'property_outstanding', 'stock_value']);
});

test('home: mortgageMonthPaymentDates — monthly / semi-monthly / weekly grids on the projection grid', () => {
  // Monthly, day 15: Oct 15 shows; the Nov 15 payment is still in
  // the future on Nov 7 and stays out of the window.
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'monthly', anchorDay: 15, rowDate: '2026-10-15', month: '2026-10', from: '2026-10-01', to: '2026-11-07', earliest: '2025-01-15' }),
    ['2026-10-15']);
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'monthly', anchorDay: 15, rowDate: '2026-11-15', month: '2026-11', from: '2026-10-01', to: '2026-11-07', earliest: '2025-01-15' }),
    []);
  // Monthly day 31 clamps into short months; a payment in the
  // balance month itself never happens (first payment is next month).
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'monthly', anchorDay: 31, rowDate: '2026-02-28', month: '2026-02', from: '2026-02-01', to: '2026-02-28', earliest: '2026-01-15' }),
    ['2026-02-28']);
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'monthly', anchorDay: 20, rowDate: '2026-01-20', month: '2026-01', from: '2026-01-01', to: '2026-01-31', earliest: '2026-01-15' }),
    []);
  // Semi-monthly anchor 15: the 15th and the 30th.
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'semi_monthly', anchorDay: 15, rowDate: '2026-10-30', month: '2026-10', from: '2026-10-01', to: '2026-10-31', earliest: '2025-01-15' }),
    ['2026-10-15', '2026-10-30']);
  // Weekly: step back from the month's last payment date; only dates
  // on or before today show (Nov 2026: Nov 6 only, on Nov 7).
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'weekly', anchorDay: null, rowDate: '2026-11-27', month: '2026-11', from: '2026-10-01', to: '2026-11-07', earliest: '2024-04-16' }),
    ['2026-11-06']);
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'weekly', anchorDay: null, rowDate: '2026-10-30', month: '2026-10', from: '2026-10-01', to: '2026-11-07', earliest: '2024-04-16' }),
    ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
  // Bi-weekly steps 14 days from the same anchor.
  assert.deepEqual(
    mortgageMonthPaymentDates({ frequency: 'bi_weekly', anchorDay: null, rowDate: '2026-10-30', month: '2026-10', from: '2026-10-01', to: '2026-11-07', earliest: '2024-04-16' }),
    ['2026-10-02', '2026-10-16', '2026-10-30']);
});

test('home: highlight — mortgage rows use the same window + rollover rule, paid not received', () => {
  const mortgages = [{
    id: 5, label: '2 Home Test Way',
    occurrences: [{ date: '2026-10-15', amount: 1744.81 }, { date: '2026-11-15', amount: 1744.81 }],
  }];
  const jobs = [{ id: 1, label: 'Acme', frequency: 'biweekly', startDate: '2026-01-02', recentDate: '2026-10-23', cashNet: 2000 }];
  const rentals = [{ id: 7, label: 'Basement', entries: [{ id: 1, start_ym: '2026-01', end_ym: null, monthly_rent: 2000, pay_day: 15 }] }];
  // Today Nov 7: only the Oct 15 mortgage payment has arrived.
  const rows = homeHighlightRows({ jobs, rentals, mortgages, marks: new Map(), today: '2026-11-07' });
  const mort = rows.filter((r) => r.kind === 'mortgage');
  assert.deepEqual(mort.map((r) => r.date), ['2026-10-15']);
  assert.equal(mort[0].amount, 1744.81);
  assert.equal(mort[0].isCurrent, true);
  assert.equal(mort[0].received, null);
  // Same-date ties: salary before rental before mortgage (Oct 15 has both rent and mortgage).
  assert.ok(rows.findIndex((r) => r.kind === 'rental' && r.date === '2026-10-15')
    < rows.findIndex((r) => r.kind === 'mortgage' && r.date === '2026-10-15'),
    JSON.stringify(rows.map((r) => `${r.kind} ${r.date}`)));
  // Mark the Oct 15 mortgage paid: it stays (it is the current one).
  const marks = new Map([['mortgage:5:2026-10-15', 1]]);
  const rows2 = homeHighlightRows({ jobs, rentals: [], mortgages, marks, today: '2026-11-07' });
  assert.ok(rows2.some((r) => r.kind === 'mortgage' && r.date === '2026-10-15' && r.received === 1));
  // When the Nov 15 payment arrives, the marked Oct 15 row rolls off.
  const rows3 = homeHighlightRows({ jobs, rentals: [], mortgages, marks, today: '2026-11-16' });
  assert.deepEqual(rows3.filter((r) => r.kind === 'mortgage').map((r) => r.date), ['2026-11-15']);
  // An unmarked Oct row in the window keeps showing after Nov 15 arrives.
  const rows4 = homeHighlightRows({ jobs, rentals: [], mortgages, marks: new Map(), today: '2026-11-16' });
  assert.deepEqual(rows4.filter((r) => r.kind === 'mortgage').map((r) => r.date), ['2026-11-15', '2026-10-15']);
  // A mortgage with no occurrences in the window contributes nothing.
  assert.deepEqual(
    homeHighlightRows({ jobs: [], rentals: [], mortgages: [{ id: 9, label: 'Future', occurrences: [{ date: '2026-12-15', amount: 100 }] }], marks: new Map(), today: '2026-11-07' }),
    []);
});

test('home: jobTakehomePeriods — latest payday matches the job page to the cent; pay changes + plan starts move later paydays only', () => {
  const job = {
    frequency: 'biweekly', start_date: '2026-01-02', recent_pay_date: '2026-10-23',
    gross_amount: 3000, gross_basis: 'period', opening_value: 3000, province: 'BC',
    tax_year: 2026, td1_federal: null, td1_provincial: null,
    ytd_cpp: 0, ytd_cpp2: 0, ytd_ei: 0, cpp_exempt: false, ei_exempt: false,
    bonus_total: 0, pay_changes: [],
  };
  const plans = [{ start_date: '2026-11-06', own_amount: 220.05, employer_amount: 0 }];
  const periods = jobTakehomePeriods({ job, plans, payroll, today: '2026-11-07' });
  assert.equal(periods.length, 12);
  assert.equal(periods[periods.length - 1].date, '2026-11-06');
  // The job page's own figure for the same payday: cashNet with the
  // deduction in force, minus the annual-first per-period benefit.
  const calc0 = calcSalary({ ...job, rrspDeduction: 0 }, payroll);
  const calcD = calcSalary({ ...job, rrspDeduction: 220.05 }, payroll);
  const benefit = Math.round(((calc0.totalTax - calcD.totalTax) / 26) * 100) / 100;
  const displayed = Math.round((calcD.perPeriod.cashNet - benefit) * 100) / 100;
  assert.equal(periods[periods.length - 1].value, displayed);
  // Before the plan starts there is no benefit to subtract: the Oct
  // 23 payday is the plain no-deduction cashNet.
  assert.equal(periods[periods.length - 2].date, '2026-10-23');
  assert.equal(periods[periods.length - 2].value, calc0.perPeriod.cashNet);
  // A pay change effective Oct 23 moves Oct 23 + Nov 6, never Oct 9.
  const job2 = { ...job, pay_changes: [{ effective_date: '2026-10-23', value: 3500, amount: 3500, basis: 'gross', scope: 'period' }] };
  const p2 = jobTakehomePeriods({ job: job2, plans, payroll, today: '2026-11-07' });
  assert.equal(p2[p2.length - 3].date, '2026-10-09');
  assert.equal(p2[p2.length - 3].value, periods[periods.length - 3].value);
  assert.ok(p2[p2.length - 2].value > periods[periods.length - 2].value);
  assert.ok(p2[p2.length - 1].value > periods[periods.length - 1].value);
  // No dates, no rows — never a guessed payday.
  assert.deepEqual(jobTakehomePeriods({ job: { ...job, start_date: null }, plans, payroll, today: '2026-11-07' }), []);
});

test('home: resolveHomeMetric — account + account-type + per-period take-home cards', () => {
  const data = {
    currentYm: '2026-11',
    property: [], propertyById: {}, propertyLabels: {},
    stocks: { months: [], topGainer: null },
    holdingById: {},
    accountById: {
      2: { label: 'TFSA', months: months('2026-10', [5000, 6000], 'value').map((r) => ({ ...r, gain: r.value - 5000 })) },
      3: { label: 'RRSP', months: [{ month: '2026-11', value: 0, gain: 0 }] },
    },
    accountTypeById: {
      TFSA: { label: 'TFSA accounts', months: months('2026-10', [5000, 6000], 'value').map((r) => ({ ...r, gain: r.value - 5000 })) },
      RRSP: { label: 'RRSP accounts', months: [{ month: '2026-11', value: 0, gain: 0 }] },
    },
    earnings: [], spending: [],
    categorySeries: {},
    jobById: { 4: { label: 'Acme', months: months('2026-09', [2000, 2100], 'salary') } },
    jobPeriodById: {
      4: {
        label: 'Acme',
        periods: [
          { date: '2026-10-09', value: 2299.17 }, { date: '2026-10-23', value: 2299.17 },
          { date: '2026-11-06', value: 2079.12 },
        ],
      },
    },
    rentalById: {},
  };
  const acct = resolveHomeMetric('account_value:2', data);
  assert.equal(acct.value, 6000);
  assert.deepEqual(acct.entity, { kind: 'account', id: 2 });
  const gain = resolveHomeMetric('account_gain:2', data);
  assert.equal(gain.value, 1000);
  assert.deepEqual(gain.entity, { kind: 'account', id: 2 });
  // An existing account with nothing valued resolves to $0, not "no data".
  assert.equal(resolveHomeMetric('account_value:3', data).value, 0);
  const type = resolveHomeMetric('account_type_value:TFSA', data);
  assert.equal(type.value, 6000);
  assert.deepEqual(type.entity, { kind: 'account_type', id: 'TFSA' });
  assert.equal(resolveHomeMetric('account_type_value:RRSP', data).value, 0);
  assert.deepEqual(resolveHomeMetric('account_value:999', data), { error: 'no_data', message: 'That account has no data yet.' });
  assert.deepEqual(resolveHomeMetric('account_type_value:RSU', data), { error: 'no_data', message: 'No accounts of that type yet.' });
  const period = resolveHomeMetric('job_takehome_period:4', data);
  assert.equal(period.value, 2079.12);
  assert.equal(period.period, '2026-11');
  assert.equal(period.periodLabel, 'Nov 6, 2026');
  assert.deepEqual(period.mom, { delta: -220.05, pct: -9.57 });
  assert.equal(period.momVs, 'Oct 23, 2026');
  assert.deepEqual(period.spark, [2299.17, 2299.17, 2079.12]);
  assert.deepEqual(period.entity, { kind: 'job', id: 4 });
  assert.deepEqual(resolveHomeMetric('job_takehome_period:999', data), { error: 'no_data', message: 'That job has no pay history yet.' });
  const lib = buildHomeMetricLibrary({
    properties: [], holdings: [],
    accounts: [{ id: 2, label: 'TFSA', type: 'TFSA' }, { id: 3, label: 'RRSP', type: 'RRSP' }],
    accountTypes: ['TFSA', 'RRSP'],
    categories: [], jobs: [{ id: 4, label: 'Acme' }], rentals: [],
  });
  assert.ok(lib.some((m) => m.metric === 'account_value:2' && m.section === 'stock'));
  assert.ok(lib.some((m) => m.metric === 'account_gain:2' && m.section === 'stock'));
  assert.ok(lib.some((m) => m.metric === 'account_type_value:TFSA' && m.section === 'stock'));
  assert.ok(lib.some((m) => m.metric === 'account_type_gain:RRSP' && m.section === 'stock'));
  assert.ok(lib.some((m) => m.metric === 'job_takehome_period:4' && m.section === 'earning'));
  assert.equal(lib.filter((m) => m.metric === 'account_value').length, 0);
});

test('home: rentalMonthOccurrence sums covering entries, due day from the latest-starting entry', () => {
  const rental = {
    id: 1, label: 'Basement suite',
    entries: [
      { id: 1, start_ym: '2026-01', end_ym: '2026-06', monthly_rent: 2000, pay_day: 15 },
      { id: 2, start_ym: '2026-04', end_ym: '', monthly_rent: 1800, pay_day: 20 },
    ],
  };
  // May: both entries cover it — $3,800, due day 20 (latest start).
  assert.deepEqual(rentalMonthOccurrence(rental, '2026-05'), { date: '2026-05-20', amount: 3800 });
  // February: only the first entry — $2,000 on the 15th.
  assert.deepEqual(rentalMonthOccurrence(rental, '2026-02'), { date: '2026-02-15', amount: 2000 });
  // December: only the ongoing entry — $1,800 on the 20th.
  assert.deepEqual(rentalMonthOccurrence(rental, '2026-12'), { date: '2026-12-20', amount: 1800 });
  // Before any entry starts: nothing.
  assert.equal(rentalMonthOccurrence(rental, '2025-12'), null);
  // A pay day past the month's end clamps (31 in February 2026 → 28).
  const clamp = { id: 2, label: 'Suite', entries: [{ id: 3, start_ym: '2026-01', end_ym: '', monthly_rent: 1000, pay_day: 31 }] };
  assert.deepEqual(rentalMonthOccurrence(clamp, '2026-02'), { date: '2026-02-28', amount: 1000 });
  assert.deepEqual(rentalMonthOccurrence({ id: 3, label: 'Empty', entries: [] }, '2026-10'), null);
});

test('home: homeCalendarDates uses the highlight date sources for one month, past and future', () => {
  const jobs = [
    { id: 1, label: 'Acme Corp', frequency: 'biweekly', startDate: '2026-01-02', recentDate: '2026-10-23' },
    { id: 2, label: 'Side gig', frequency: 'monthly', startDate: '2026-03-15', recentDate: '2026-10-15' },
    { id: 3, label: 'Annual bonus job', frequency: 'annual', startDate: '2024-06-06', recentDate: '2026-06-06' },
    { id: 4, label: 'No dates', frequency: 'biweekly', startDate: '', recentDate: '' },
  ];
  const rentals = [
    { id: 1, label: 'Basement suite', entries: [{ id: 1, start_ym: '2026-01', end_ym: '', monthly_rent: 2000, pay_day: 15 }] },
  ];
  const mortgageOccurrences = [
    { date: '2026-10-15', sourceId: 2, label: '2 Home Test Way' },
    { date: '2026-11-15', sourceId: 2, label: '2 Home Test Way' },
  ];
  const nov = homeCalendarDates({ jobs, rentals, mortgageOccurrences, month: '2026-11' });
  // Biweekly from the Oct 23 anchor: Nov 6 + Nov 20. Monthly on the
  // 15th. Rent + mortgage share the 15th. No annual date in November.
  assert.deepEqual(Object.keys(nov).sort(), ['2026-11-06', '2026-11-15', '2026-11-20']);
  assert.deepEqual(nov['2026-11-06'], [{ kind: 'salary', sourceId: 1, label: 'Acme Corp' }]);
  assert.deepEqual(nov['2026-11-15'], [
    { kind: 'salary', sourceId: 2, label: 'Side gig' },
    { kind: 'rental', sourceId: 1, label: 'Basement suite' },
    { kind: 'mortgage', sourceId: 2, label: '2 Home Test Way' },
  ]);
  assert.deepEqual(nov['2026-11-20'], [{ kind: 'salary', sourceId: 1, label: 'Acme Corp' }]);
  // October: biweekly Oct 9 + Oct 23, monthly Oct 15, rent Oct 15, mortgage Oct 15.
  const oct = homeCalendarDates({ jobs, rentals, mortgageOccurrences, month: '2026-10' });
  assert.deepEqual(Object.keys(oct).sort(), ['2026-10-09', '2026-10-15', '2026-10-23']);
  assert.deepEqual(oct['2026-10-09'], [{ kind: 'salary', sourceId: 1, label: 'Acme Corp' }]);
  // June: the annual anniversary lands Jun 6.
  const jun = homeCalendarDates({ jobs, rentals, mortgageOccurrences, month: '2026-06' });
  assert.ok(jun['2026-06-06'].some((x) => x.kind === 'salary' && x.sourceId === 3), JSON.stringify(jun['2026-06-06']));
  // A month before anything started is empty — no invented dates.
  assert.deepEqual(homeCalendarDates({ jobs, rentals, mortgageOccurrences, month: '2025-12' }), {});
});

test('home: homeCalendarFocusTarget maps a calendar day to the first matching highlight row', () => {
  const highlights = [
    { kind: 'salary', sourceId: 1, date: '2026-11-06' },
    { kind: 'salary', sourceId: 1, date: '2026-10-23' },
    { kind: 'rental', sourceId: 1, date: '2026-10-15' },
    { kind: 'mortgage', sourceId: 2, date: '2026-10-15' },
    { kind: 'salary', sourceId: 1, date: '2026-10-09' },
  ];
  // Exact date + kind + source.
  assert.deepEqual(
    homeCalendarFocusTarget('2026-11-06', [{ kind: 'salary', sourceId: 1 }], highlights), highlights[0]);
  // Several payments one day: the first in highlight order wins (rental before mortgage).
  assert.deepEqual(
    homeCalendarFocusTarget('2026-10-15', [{ kind: 'rental', sourceId: 1 }, { kind: 'mortgage', sourceId: 2 }], highlights),
    highlights[2]);
  // Same date, wrong kind or wrong source: no row.
  assert.equal(homeCalendarFocusTarget('2026-10-15', [{ kind: 'salary', sourceId: 1 }], highlights), null);
  assert.equal(homeCalendarFocusTarget('2026-10-15', [{ kind: 'rental', sourceId: 9 }], highlights), null);
  // No payments that day: nothing to focus.
  assert.equal(homeCalendarFocusTarget('2026-11-10', [], highlights), null);
  // Outside the highlight window the entry has no row, even with payments on the day.
  assert.equal(homeCalendarFocusTarget('2026-12-04', [{ kind: 'salary', sourceId: 1 }], highlights), null);
});

test('home: homeCalDayIsActionable — a day is clickable only when a highlight card matches one of its entries', () => {
  const highlights = [
    { kind: 'salary', sourceId: 1, date: '2026-11-06' },
    { kind: 'salary', sourceId: 1, date: '2026-10-23' },
    { kind: 'rental', sourceId: 1, date: '2026-10-15' },
    { kind: 'mortgage', sourceId: 2, date: '2026-10-15' },
    { kind: 'salary', sourceId: 1, date: '2026-10-09' },
  ];
  assert.equal(homeCalDayIsActionable('2026-11-06', [{ kind: 'salary', sourceId: 1 }], highlights), true);
  assert.equal(homeCalDayIsActionable('2026-10-15', [{ kind: 'rental', sourceId: 1 }, { kind: 'mortgage', sourceId: 2 }], highlights), true);
  // No payments: not actionable.
  assert.equal(homeCalDayIsActionable('2026-11-10', [], highlights), false);
  // Payments but no row (marked-and-rolled-off, or outside the window): not actionable.
  assert.equal(homeCalDayIsActionable('2026-12-04', [{ kind: 'salary', sourceId: 1 }], highlights), false);
  assert.equal(homeCalDayIsActionable('2026-10-15', [{ kind: 'salary', sourceId: 1 }], highlights), false);
});

test('home: homeCalendarDates carries the mark state per entry (received only when a mark row exists)', () => {
  const jobs = [
    { id: 1, label: 'Acme Corp', frequency: 'biweekly', startDate: '2026-01-02', recentDate: '2026-10-23' },
  ];
  const rentals = [
    { id: 1, label: 'Basement suite', entries: [{ id: 1, start_ym: '2026-01', end_ym: '', monthly_rent: 2000, pay_day: 15 }] },
  ];
  const mortgageOccurrences = [{ date: '2026-10-15', sourceId: 2, label: '2 Home Test Way' }];
  const marks = new Map([
    ['salary:1:2026-10-09', 1], // marked received
    ['rental:1:2026-10-15', 0], // explicitly not received
  ]);
  const oct = homeCalendarDates({ jobs, rentals, mortgageOccurrences, month: '2026-10', marks });
  assert.deepEqual(oct['2026-10-09'], [{ kind: 'salary', sourceId: 1, label: 'Acme Corp', received: 1 }]);
  assert.deepEqual(oct['2026-10-15'], [
    { kind: 'rental', sourceId: 1, label: 'Basement suite', received: 0 },
    { kind: 'mortgage', sourceId: 2, label: '2 Home Test Way' },
  ]);
  // Without marks, no entry carries a received key (shape unchanged).
  const plain = homeCalendarDates({ jobs, rentals, mortgageOccurrences, month: '2026-10' });
  assert.deepEqual(plain['2026-10-09'], [{ kind: 'salary', sourceId: 1, label: 'Acme Corp' }]);
});

test('home: long-press + drop rules — drift cancels the press, the midpoint decides before/after', () => {
  assert.equal(homeLongPressMoved(100, 100, 100, 100), false);
  assert.equal(homeLongPressMoved(100, 100, 105, 100), false); // 5px, still a press
  assert.equal(homeLongPressMoved(100, 100, 111, 100), true); // 11px, the press is cancelled
  assert.equal(homeLongPressMoved(100, 100, 100, 108), false);
  assert.equal(homeLongPressMoved(100, 100, 107, 108), true); // ~10.6px diagonal
  assert.equal(homeDropBefore(100, 0, 200), true); // at the midpoint → insert before
  assert.equal(homeDropBefore(99, 0, 200), true); // left half → insert before
  assert.equal(homeDropBefore(101, 0, 200), false); // right half → insert after
  assert.equal(homeDropBefore(0, 0, 200), true);
});

test('home: homeCalendarDates keeps a payday that holiday-adjusts into the month', () => {
  // Monthly on the 1st: the Jan 1, 2026 payday is a holiday, so it
  // lands Dec 31, 2025 — December shows it, January does not.
  const jobs = [{ id: 1, label: 'First of month', frequency: 'monthly', startDate: '2025-01-01', recentDate: '2025-12-01' }];
  const dec = homeCalendarDates({ jobs, rentals: [], mortgageOccurrences: [], month: '2025-12' });
  assert.deepEqual(Object.keys(dec).sort(), ['2025-12-01', '2025-12-31']);
  assert.deepEqual(dec['2025-12-31'], [{ kind: 'salary', sourceId: 1, label: 'First of month' }]);
  assert.deepEqual(homeCalendarDates({ jobs, rentals: [], mortgageOccurrences: [], month: '2026-01' }), {});
});
