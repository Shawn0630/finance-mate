// Home page insights: standard cards + highlight rollover rule.
// Pure computation (src/home.js) — no DB, no LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStandardInsights, homeHighlightRows, resolveHomeMetric, buildHomeMetricLibrary,
  trailing12, lastCompletedMonth, monthLabel,
} from '../src/home.js';

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

test('home: highlight — current occurrence per source, unmarked rows never roll off', () => {
  // Bi-weekly job, recent payday 2026-10-23 → paydays … Oct 9, Oct 23, Nov 6, Nov 20.
  // Today is 2026-11-07: current occurrence is Nov 6.
  const jobs = [{ id: 1, label: 'Acme', frequency: 'biweekly', startDate: '2026-01-02', recentDate: '2026-10-23', cashNet: 2000 }];
  const marks = new Map();
  const rows = homeHighlightRows({ jobs, rentals: [], marks, today: '2026-11-07' });
  // No marks: every occurrence from the job start shows (unmarked rows accumulate).
  assert.ok(rows.length > 10, `expected many unmarked rows, got ${rows.length}`);
  assert.equal(rows[0].date, '2026-11-06');
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
  // replaced by Nov 20 — but an unmarked Oct row would still show.
  marks.set('salary:1:2026-11-06', 1);
  marks.delete('salary:1:2026-10-23');
  const rows3 = homeHighlightRows({ jobs, rentals: [], marks, today: '2026-11-21' });
  assert.equal(rows3[0].date, '2026-11-20');
  assert.ok(rows3.some((r) => r.date === '2026-10-23'), 'unmarked Oct 23 still shows');
  assert.ok(!rows3.some((r) => r.date === '2026-11-06'), 'marked Nov 6 rolled off');
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
  const rows = homeHighlightRows({ jobs: [], rentals, marks: new Map(), today: '2026-11-07' });
  // Current occurrence: Nov 2026, pay day 31 → Nov has 30 days, but
  // today is Nov 7 so the Nov due date (Nov 30) is still in the future;
  // the current occurrence is Oct 31.
  assert.equal(rows[0].date, '2026-10-31');
  assert.equal(rows[0].amount, 2000);
  // Feb 2026 has 28 days: pay day 31 clamps to Feb 28.
  assert.ok(rows.some((r) => r.date === '2026-02-28'));
  assert.ok(!rows.some((r) => r.date === '2026-02-31'));
  // Most recent first.
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].date >= rows[i].date);
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
