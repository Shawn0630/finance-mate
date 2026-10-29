// Investments: the return engine's conventions (units
// accumulation, the monthly P&L identity end == start +
// contributions + gain, the return-% denominator boundaries,
// grant-at-market contributions, FX conversion at event-date
// vs month-end rates), the price/fx access rules, the Stooq
// provider's CSV parsing and symbol mapping, input validation
// (including the sell guard), the event-price materialization,
// and the AI fill chat (two-round flow, duplicate flags, the
// 404/503 contract) with the LLM call injected — no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  validAccountInput, validHoldingInput, validEventInput, validNavInput, validInitialEvents,
  getAccount, listAccounts,
  unitsOn, unitsAvailableForSell, priceOn, fxOn,
  computeHoldingSeries, aggregateComputed, rebuildEventPricePoints, listPricePoints,
  splitMultiplier, splitFactorAfter, adjustedUnitsOf,
  monthlyYears, latestMonthlyYear, monthlyRowsForYear,
} from '../src/investments.js';
import {
  parseStooqCsv, stooqSymbolFor, parseYahooChart, ensureHoldingPrices, ensureHoldingPricesDetailed,
  refreshAllPrices, priceStatusFor, clearHoldingPriceMeta,
  parseYahooSearch, searchSecurities, fetchYahooHistory, fetchStooqHistory,
} from '../src/prices.js';
import { handleAiInvestFillChat, normalizeProposedInvestments } from '../src/aiFill.js';

const E = (id, date, type, units = null, price = null, amount = null) =>
  ({ id, date, type, units, price, amount });
const P = (date, price, source = 'stooq') => ({ date, price, source });

// ------------------------------------------------------------- provider
test('stooqSymbolFor: TSX keeps .TO, bare symbols are US listings', () => {
  assert.equal(stooqSymbolFor('XQQ.TO'), 'xqq.to');
  assert.equal(stooqSymbolFor('AAPL'), 'aapl.us');
  assert.equal(stooqSymbolFor(' vfv.to '), 'vfv.to');
  assert.equal(stooqSymbolFor(''), null);
});

test('parseStooqCsv: parses closes, drops junk and the no-data body', () => {
  const csv = [
    'Date,Open,High,Low,Close,Volume',
    '2026-01-02,100,101,99,100.5,12345',
    '2026-01-05,101,102,100,101.25,999',
    'bad-row,1,2,3,x,1',
    '2026-01-06,1,1,1,0,1', // non-positive close drops
    '2026-01-01,99,100,98,99.5,10', // out of order — sorted ascending
  ].join('\n');
  assert.deepEqual(parseStooqCsv(csv), [
    { date: '2026-01-01', price: 99.5 },
    { date: '2026-01-02', price: 100.5 },
    { date: '2026-01-05', price: 101.25 },
  ]);
  assert.deepEqual(parseStooqCsv('No data'), []);
  assert.deepEqual(parseStooqCsv(''), []);
  assert.deepEqual(parseStooqCsv(null), []);
});

// --------------------------------------------------------- price access
test('priceOn: last point ≤ date, ties resolve manual > stooq > event', () => {
  const points = [
    P('2026-01-01', 10, 'event'), P('2026-01-01', 11, 'stooq'), P('2026-01-01', 12, 'manual'),
    P('2026-02-01', 20, 'stooq'),
  ];
  assert.deepEqual(priceOn(points, '2026-01-01'), { price: 12, date: '2026-01-01', source: 'manual' });
  assert.deepEqual(priceOn(points, '2026-01-15'), { price: 12, date: '2026-01-01', source: 'manual' });
  assert.deepEqual(priceOn(points, '2026-02-01'), { price: 20, date: '2026-02-01', source: 'stooq' });
  assert.equal(priceOn(points, '2025-12-31'), null);
  assert.equal(priceOn([], '2026-01-01'), null);
});

test('fxOn: last rate ≤ date; before the series, the earliest rate', () => {
  const fx = [{ date: '2026-01-01', rate: 1.3 }, { date: '2026-02-01', rate: 1.4 }];
  assert.equal(fxOn(fx, '2026-01-15'), 1.3);
  assert.equal(fxOn(fx, '2026-02-01'), 1.4);
  assert.equal(fxOn(fx, '2025-06-01'), 1.3);
  assert.equal(fxOn([], '2026-01-01'), null);
});

test('unitsOn: buys and grants add, sells subtract, later events excluded', () => {
  const events = [E(1, '2026-01-01', 'buy', 10, 100), E(2, '2026-01-02', 'grant', 5), E(3, '2026-02-01', 'sell', 3, 120)];
  assert.equal(unitsOn(events, '2025-12-31'), 0);
  assert.equal(unitsOn(events, '2026-01-01'), 10);
  assert.equal(unitsOn(events, '2026-01-15'), 15);
  assert.equal(unitsOn(events, '2026-03-01'), 12);
});

// ---------------------------------------------------------------- engine
test('computeHoldingSeries: monthly identity, dividends in return not in value', () => {
  const events = [
    E(1, '2026-01-10', 'buy', 10, 100),
    E(2, '2026-02-15', 'dividend', null, null, 30),
    E(3, '2026-02-20', 'buy', 10, 120),
  ];
  const points = [P('2025-12-31', 100, 'manual'), P('2026-01-31', 110), P('2026-02-28', 120)];
  const { monthly, summary } = computeHoldingSeries({ events, points, fxRate: () => 1, today: '2026-03-15' });
  assert.deepEqual(monthly.map((r) => r.month), ['2026-01', '2026-02', '2026-03']);
  const [jan, feb, mar] = monthly;
  assert.deepEqual(
    [jan.startValueNative, jan.contributionsNative, jan.gainNative, jan.returnAmountNative, jan.endValueNative, jan.returnPctNative],
    [0, 1000, 100, 100, 1100, 10]);
  assert.deepEqual(
    [feb.startValueNative, feb.contributionsNative, feb.dividendsNative, feb.gainNative, feb.returnAmountNative, feb.endValueNative],
    [1100, 1200, 30, 100, 130, 2400]);
  assert.equal(feb.returnPctNative, 5.65); // 130 / (1100 + 1200)
  assert.deepEqual([mar.startValueNative, mar.endValueNative, mar.gainNative, mar.returnPctNative], [2400, 2400, 0, 0]);
  for (const r of monthly) {
    assert.equal(r.endValueNative, r.startValueNative + r.contributionsNative + r.gainNative, r.month);
    assert.equal(r.endValue, r.startValue + r.contributions + r.gain, r.month);
  }
  assert.equal(summary.units, 20);
  assert.equal(summary.valueNative, 2400);
  assert.equal(summary.contributionsNative, 2200);
  assert.equal(summary.dividendsNative, 30);
  assert.equal(summary.totalReturnNative, 230); // 2400 − 2200 + 30
  assert.equal(summary.totalReturnPctNative, 10.45);
  assert.equal(summary.latestPrice, 120);
  assert.equal(summary.latestPriceDate, '2026-02-28');
});

test('computeHoldingSeries: FX converts flows at event-date rates, values at month-end', () => {
  const fx = [{ date: '2026-01-01', rate: 1.3 }, { date: '2026-02-01', rate: 1.4 }];
  const events = [E(1, '2026-01-10', 'buy', 10, 100)];
  const points = [P('2026-01-31', 110), P('2026-02-28', 110)];
  const { monthly, summary } = computeHoldingSeries({
    events, points, fxRate: (d) => fxOn(fx, d), today: '2026-03-01',
  });
  const [jan, feb] = monthly;
  assert.equal(jan.contributions, 1300); // 1000 USD × 1.30 (rate on the buy date)
  assert.equal(jan.endValue, 1430);      // 1100 USD × 1.30 (Jan 31 rate)
  assert.equal(jan.gain, 130);
  assert.equal(feb.endValue, 1540);      // 1100 × 1.40 — pure FX movement lands in gain
  assert.equal(feb.gain, 110);
  assert.equal(summary.value, 1540);
  assert.equal(summary.valueNative, 1100);
});

test('computeHoldingSeries: a grant contributes at market price and books no profit', () => {
  const events = [E(1, '2026-01-05', 'grant', 5, null)];
  const points = [P('2026-01-01', 50, 'manual'), P('2026-01-31', 50, 'manual')];
  const { monthly, summary } = computeHoldingSeries({ events, points, fxRate: () => 1, today: '2026-02-10' });
  assert.equal(monthly[0].contributionsNative, 250);
  assert.equal(monthly[0].gainNative, 0);
  assert.equal(monthly[0].endValueNative, 250);
  assert.equal(summary.unpricedGrants, 0);
  // With no price anywhere, the same grant contributes 0 and is counted.
  const bare = computeHoldingSeries({ events, points: [], fxRate: () => 1, today: '2026-02-10' });
  assert.equal(bare.summary.unpricedGrants, 1);
  assert.equal(bare.monthly[0].contributionsNative, 0);
});

test('computeHoldingSeries: fund fallback — event prices walk flat between trades', () => {
  const events = [E(1, '2026-01-10', 'buy', 100, 25), E(2, '2026-03-10', 'buy', 100, 30)];
  const points = [P('2026-01-10', 25, 'event'), P('2026-03-10', 30, 'event')];
  const { monthly } = computeHoldingSeries({ events, points, fxRate: () => 1, today: '2026-03-20' });
  const [jan, feb, mar] = monthly;
  assert.equal(jan.endValueNative, 2500);
  assert.equal(feb.endValueNative, 2500); // still the January trade price
  assert.equal(feb.gainNative, 0);
  assert.equal(mar.endValueNative, 6000); // 200 units × 30
  assert.equal(mar.gainNative, 500);      // revaluation of the first 100 units
});

test('computeHoldingSeries: return % is null when nothing was held or put in', () => {
  const events = [E(1, '2026-01-10', 'dividend', null, null, 25)];
  const { monthly, summary } = computeHoldingSeries({ events, points: [], fxRate: () => 1, today: '2026-01-20' });
  assert.equal(monthly[0].returnAmountNative, 25);
  assert.equal(monthly[0].returnPctNative, null); // denominator 0 + 0
  assert.equal(summary.totalReturnPctNative, null);
  const empty = computeHoldingSeries({ events: [], points: [], fxRate: () => 1, today: '2026-01-20' });
  assert.deepEqual(empty.monthly, []);
  assert.equal(empty.summary.units, 0);
});

test('aggregateComputed: CAD sums across holdings, % from the totals', () => {
  const mk = (month, s, c, d, g, e) => ({
    monthly: [{ month, startValue: s, contributions: c, dividends: d, gain: g, returnAmount: g + d, endValue: e }],
    summary: { value: e, contributions: c, dividends: d, totalReturn: g + d },
  });
  const agg = aggregateComputed([mk('2026-01', 0, 1000, 0, 100, 1100), mk('2026-01', 0, 3000, 60, -40, 3020)]);
  assert.equal(agg.monthly.length, 1);
  assert.equal(agg.monthly[0].endValue, 4120);
  assert.equal(agg.monthly[0].returnAmount, 120);
  assert.equal(agg.monthly[0].returnPct, 3); // 120 / (0 + 4000)
  assert.equal(agg.series[0].returnAmount, 4120 - 4000 + 60);
  assert.equal(agg.summary.totalReturnPct, 3);
});

// ------------------------------------------------------------- validation
test('validAccountInput / validHoldingInput: shapes and required fields', () => {
  assert.deepEqual(validAccountInput({ name: ' My TFSA ', type: 'TFSA', institution: 'CIBC' }),
    { name: 'My TFSA', type: 'TFSA', institution: 'CIBC', note: null });
  assert.ok(validAccountInput({ name: 'X', type: 'LIRA' }).error);
  assert.ok(validAccountInput({ type: 'TFSA' }).error);
  assert.deepEqual(validHoldingInput({ label: 'XQQ', kind: 'exchange', symbol: 'xqq.to', currency: 'CAD' }),
    { label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', fundCode: null, currency: 'CAD' });
  assert.ok(validHoldingInput({ label: 'XQQ', kind: 'exchange', currency: 'CAD' }).error); // symbol required
  const fund = validHoldingInput({ label: 'CIBC U.S. Index Fund', kind: 'fund', currency: 'CAD' });
  assert.equal(fund.symbol, null);
  assert.ok(validHoldingInput({ label: 'X', kind: 'fund', currency: 'EUR' }).error);
  // PUT merge: base carries the shape, the body overrides one field.
  const base = { label: 'Old', kind: 'fund', symbol: null, fund_code: 'CIB123', currency: 'USD' };
  assert.deepEqual(validHoldingInput({ label: 'New' }, base),
    { label: 'New', kind: 'fund', symbol: null, fundCode: 'CIB123', currency: 'USD' });
});

test('validEventInput: per-type figures, grant price optional, sell guard', () => {
  assert.deepEqual(validEventInput({ date: '2026-01-05', type: 'buy', units: 10, price: 100 }),
    { date: '2026-01-05', type: 'buy', units: 10, price: 100, amount: null, splitNew: null, splitOld: null, note: null });
  assert.equal(validEventInput({ date: '2026-01-05', type: 'grant', units: 5 }).price, null);
  assert.deepEqual(validEventInput({ date: '2026-01-05', type: 'dividend', amount: 42.5 }),
    { date: '2026-01-05', type: 'dividend', units: null, price: null, amount: 42.5, splitNew: null, splitOld: null, note: null });
  for (const bad of [
    { date: '2026-13-01', type: 'buy', units: 1, price: 1 },
    { date: '2026-01-05', type: 'buy', units: 0, price: 1 },
    { date: '2026-01-05', type: 'buy', units: 1 },
    { date: '2026-01-05', type: 'dividend' },
    { date: '2026-01-05', type: 'transfer', units: 1, price: 1 },
  ]) assert.ok(validEventInput(bad).error, JSON.stringify(bad));
  const events = [E(1, '2026-01-01', 'buy', 10, 100), E(2, '2026-01-02', 'grant', 5)];
  assert.equal(unitsAvailableForSell(events, '2026-01-03'), 15);
  assert.ok(validEventInput({ date: '2026-01-03', type: 'sell', units: 16, price: 1 }, { events }).error);
  assert.ok(!validEventInput({ date: '2026-01-03', type: 'sell', units: 15, price: 1 }, { events }).error);
  // An earlier-dated sell cannot spend units granted later.
  assert.ok(validEventInput({ date: '2026-01-01', type: 'sell', units: 11, price: 1 }, { events }).error);
  assert.deepEqual(validNavInput({ date: '2026-01-31', price: 31.25 }), { date: '2026-01-31', price: 31.25 });
  assert.ok(validNavInput({ date: '2026-01-31', price: 0 }).error);
});

// ------------------------------------------------- event price rebuild
test('rebuildEventPricePoints: priced events materialize, dividends never do', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE invest_events (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, type TEXT, units REAL, price REAL, amount REAL, note TEXT, source TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT, created_at TEXT, UNIQUE (holding_id, date, source));
  `);
  const ts = new Date().toISOString();
  const ins = db.prepare('INSERT INTO invest_events (holding_id, date, type, units, price, amount, source, created_at, updated_at) VALUES (7, ?, ?, ?, ?, ?, \'manual\', ?, ?)');
  ins.run('2026-01-10', 'buy', 10, 100, null, ts, ts);
  ins.run('2026-02-01', 'dividend', null, null, 30, ts, ts);
  ins.run('2026-03-01', 'grant', 5, null, null, ts, ts); // unpriced grant: no point
  rebuildEventPricePoints(db, 7, ts);
  let points = listPricePoints(db, 7);
  assert.deepEqual(points.map((p) => [p.date, p.price, p.source]), [['2026-01-10', 100, 'event']]);
  // Editing the buy's price and rebuilding replaces the point.
  db.prepare('UPDATE invest_events SET price = 105 WHERE type = \'buy\'').run();
  rebuildEventPricePoints(db, 7, ts);
  points = listPricePoints(db, 7);
  assert.deepEqual(points.map((p) => [p.date, p.price]), [['2026-01-10', 105]]);
  db.close();
});

// ------------------------------------------------------------ splits
const SPLIT31 = { id: 90, date: '2024-08-09', type: 'split', units: null, price: null, amount: null, split_new: 3, split_old: 1 };

test('split validation: a split carries only its ratio (either field spelling)', () => {
  const v = validEventInput({ date: '2024-08-09', type: 'split', splitNew: 3, splitOld: 1 });
  assert.equal(v.error, undefined, JSON.stringify(v));
  assert.deepEqual([v.splitNew, v.splitOld, v.units, v.price, v.amount], [3, 1, null, null, null]);
  const snake = validEventInput({ date: '2024-08-09', type: 'split', split_new: 1, split_old: 2 });
  assert.deepEqual([snake.splitNew, snake.splitOld], [1, 2]);
  assert.match(validEventInput({ date: '2024-08-09', type: 'split', splitNew: 3 }).error, /ratio/);
  assert.match(validEventInput({ date: '2024-08-09', type: 'split', splitNew: 2, splitOld: 2 }).error, /change the unit count/);
  assert.equal(splitMultiplier(SPLIT31), 3);
  assert.equal(splitMultiplier({ type: 'split', splitNew: 1, splitOld: 2 }), 0.5);
  assert.equal(splitMultiplier({ type: 'buy', units: 5 }), 1);
});

test('unitsOn restates lots by the splits that followed them', () => {
  const events = [
    E(1, '2021-01-15', 'buy', 20, 100),
    E(2, '2021-06-01', 'buy', 10, 110),
    SPLIT31,
  ];
  // Restatement is unconditional: even a pre-split date reads
  // in current terms (60, not 20) — the same convention as
  // split-adjusted price series.
  assert.equal(unitsOn(events, '2021-02-01'), 60);
  assert.equal(unitsOn(events, '2026-10-28'), 90);
  assert.equal(splitFactorAfter(events, '2021-01-15'), 3);
  assert.equal(splitFactorAfter(events, '2024-08-09'), 1, 'a split does not restate itself');
  assert.equal(adjustedUnitsOf(events[0], events), 60);
  // Reverse split halves the count.
  const rev = [E(1, '2020-01-10', 'buy', 100, 10), { id: 2, date: '2022-05-02', type: 'split', split_new: 1, split_old: 2 }];
  assert.equal(unitsOn(rev, '2026-01-01'), 50);
});

test('split engine: adjusted closes meet restated units; dollars never restate', () => {
  const events = [
    E(1, '2021-01-15', 'buy', 20, 100),
    E(2, '2021-06-01', 'buy', 10, 110),
    SPLIT31,
    E(4, '2025-03-10', 'dividend', null, null, 45),
  ];
  const points = [
    P('2021-01-29', 34), P('2021-06-30', 37), P('2024-08-30', 40), P('2026-10-15', 42),
  ];
  const out = computeHoldingSeries({ events, points, fxRate: () => 1, today: '2026-10-28' });
  // Summary: 90 current units at the latest adjusted close;
  // contributions are the recorded dollars (3100), unchanged.
  assert.equal(out.summary.units, 90);
  assert.equal(out.summary.latestPrice, 42);
  assert.equal(out.summary.valueNative, 3780);
  assert.equal(out.summary.contributionsNative, 3100);
  assert.equal(out.summary.dividendsNative, 45);
  assert.equal(out.summary.totalReturnNative, 725);
  const jan21 = out.monthly.find((m) => m.month === '2021-01');
  assert.deepEqual(
    [jan21.endValueNative, jan21.contributionsNative, jan21.gainNative, jan21.returnPctNative, jan21.unitsEnd],
    [2040, 2000, 40, 2, 60], JSON.stringify(jan21));
  const jun21 = out.monthly.find((m) => m.month === '2021-06');
  assert.deepEqual(
    [jun21.startValueNative, jun21.endValueNative, jun21.contributionsNative, jun21.gainNative, jun21.returnPctNative],
    [2040, 3330, 1100, 190, 6.05], JSON.stringify(jun21));
  // The split month itself books no jump: both sides of it are
  // already in current terms, only the price move counts.
  const aug24 = out.monthly.find((m) => m.month === '2024-08');
  assert.deepEqual(
    [aug24.startValueNative, aug24.endValueNative, aug24.contributionsNative, aug24.gainNative, aug24.unitsEnd],
    [3330, 3600, 0, 270, 90], JSON.stringify(aug24));
  for (const m of out.monthly) {
    assert.ok(Math.abs(m.endValueNative - (m.startValueNative + m.contributionsNative + m.gainNative)) < 0.011,
      `identity holds in ${m.month}`);
  }
});

test('trade-price fallback: event prices divide by the splits that followed them', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE invest_events (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, type TEXT, units REAL, price REAL, amount REAL, split_new REAL, split_old REAL, note TEXT, source TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT, created_at TEXT, UNIQUE (holding_id, date, source));
  `);
  const ts = new Date().toISOString();
  const ins = db.prepare('INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, source, created_at, updated_at) VALUES (7, ?, ?, ?, ?, ?, ?, ?, \'manual\', ?, ?)');
  ins.run('2021-03-01', 'buy', 10, 90, null, null, null, ts, ts);
  ins.run('2024-01-15', 'split', null, null, null, 3, 1, ts, ts);
  rebuildEventPricePoints(db, 7, ts);
  assert.deepEqual(listPricePoints(db, 7).map((p) => [p.date, p.price, p.source]),
    [['2021-03-01', 30, 'event']], 'the $90 trade price restates to $30');
  db.close();
  // And the engine on those points: 30 restated units × $30 =
  // the $900 that actually moved — value is invariant.
  const out = computeHoldingSeries({
    events: [E(1, '2021-03-01', 'buy', 10, 90), { id: 2, date: '2024-01-15', type: 'split', split_new: 3, split_old: 1 }],
    points: [P('2021-03-01', 30, 'event')],
    fxRate: () => 1, today: '2026-10-28',
  });
  assert.equal(out.summary.units, 30);
  assert.equal(out.summary.valueNative, 900);
  assert.equal(out.summary.contributionsNative, 900);
  assert.equal(out.summary.totalReturnNative, 0);
});

test('sell guard after a split compares in current terms on both sides', () => {
  const events = [
    { id: 1, date: '2020-06-01', type: 'buy', units: 10, price: 50 },
    { id: 2, date: '2021-03-01', type: 'split', split_new: 3, split_old: 1 },
  ];
  const sell = (date, units) => validEventInput({ date, type: 'sell', units, price: 40 }, { events });
  assert.equal(sell('2022-01-10', 25).error, undefined, '25 of the 30 current units');
  assert.match(sell('2022-01-10', 31).error, /cannot sell/);
  // A pre-split sell is restated too: selling all 10 old units
  // in 2020 is fine; an 11th never existed in any terms.
  assert.equal(sell('2020-07-01', 10).error, undefined);
  assert.match(sell('2020-07-01', 11).error, /cannot sell/);
  assert.equal(unitsAvailableForSell(events, '2022-01-10'), 30);
});

test('validInitialEvents: a batch may carry a split; sells judge against restated units', () => {
  const ok = validInitialEvents([
    { date: '2021-01-15', type: 'buy', units: 10, price: 100 },
    { date: '2024-08-09', type: 'split', splitNew: 3, splitOld: 1 },
    { date: '2025-01-10', type: 'sell', units: 25, price: 40 },
  ]);
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual(ok.events.map((e) => [e.type, e.splitNew ?? null]), [['buy', null], ['split', 3], ['sell', null]]);
  assert.match(validInitialEvents([
    { date: '2021-01-15', type: 'buy', units: 10, price: 100 },
    { date: '2024-08-09', type: 'split', splitNew: 3, splitOld: 1 },
    { date: '2025-01-10', type: 'sell', units: 31, price: 40 },
  ]).error, /cannot sell/);
});

test('normalizeProposedInvestments: split proposals normalize and flag duplicates', () => {
  const out = normalizeProposedInvestments({
    events: [
      { holdingId: 12, date: '2024-08-09', type: 'split', splitNew: 3, splitOld: 1 },
      { holdingId: 12, date: '2024-09-01', type: 'split', splitNew: 2, splitOld: 2 }, // 1:1 — dropped
      { holdingId: 12, date: '2024-10-01', type: 'split', splitNew: 3 },               // one side — dropped
    ],
  }, { existingHoldings: EXISTING, existingEvents: EXISTING[0].events });
  assert.equal(out.events.length, 1, JSON.stringify(out.events));
  assert.deepEqual([out.events[0].type, out.events[0].splitNew, out.events[0].splitOld, out.events[0].conflict],
    ['split', 3, 1, null]);
  const dupe = normalizeProposedInvestments({
    events: [{ holdingId: 12, date: '2024-08-09', type: 'split', splitNew: 3, splitOld: 1 }],
  }, {
    existingHoldings: EXISTING,
    existingEvents: [{ id: 44, holding_id: 12, date: '2024-08-09', type: 'split', split_new: 3, split_old: 1 }],
  });
  assert.equal(dupe.events[0].conflict, 'duplicate-event');
});

test('normalizeProposedInvestments: negative-unit sells normalize, amount-only sells derive a price, orphans land in dropped', () => {
  const out = normalizeProposedInvestments({
    events: [
      { holdingId: 12, date: '2026-03-05', type: 'sell', units: -50, price: 40 }, // sale printed negative
      { holdingId: 12, date: '2026-03-06', type: 'sell', units: 20, amount: 1000 }, // total only
      { holdingId: 12, date: '2026-03-07', type: 'buy', units: 10, price: 150 },   // normal path, zero regression
      { holdingId: 999, date: '2026-03-08', type: 'sell', units: 5, price: 40 },   // matches nothing
      { holdingId: 12, date: '2026-03-09', type: 'sell', units: 5 },               // no price, no amount
    ],
  }, { existingHoldings: EXISTING, existingEvents: [] });
  assert.deepEqual(out.events.map((e) => [e.type, e.units, e.price, e.priceDerived]), [
    ['sell', 50, 40, false],
    ['sell', 20, 50, true],
    ['buy', 10, 150, false],
  ]);
  assert.equal(out.dropped.length, 2, JSON.stringify(out.dropped));
  assert.match(out.dropped[0].reason, /matched to a holding/);
  assert.match(out.dropped[1].reason, /price/);
});

// ------------------------------------------------------- Yahoo tier
test('parseYahooChart: zips timestamps with closes, drops nulls and error shapes', () => {
  const ts = (y, m, d) => Date.UTC(y, m, d) / 1000;
  const json = {
    chart: {
      result: [{
        timestamp: [ts(2026, 0, 2), ts(2026, 0, 5), ts(2026, 0, 6)],
        indicators: { quote: [{ close: [61.5, null, 62.25] }] },
      }],
      error: null,
    },
  };
  assert.deepEqual(parseYahooChart(json), [
    { date: '2026-01-02', price: 61.5 },
    { date: '2026-01-06', price: 62.25 },
  ]);
  assert.deepEqual(parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } }), []);
  assert.deepEqual(parseYahooChart(null), []);
  assert.deepEqual(parseYahooChart({}), []);
});

test('priceOn: a same-date tie ranks stooq above yahoo above event', () => {
  const points = [P('2026-01-01', 10, 'event'), P('2026-01-01', 11, 'yahoo'), P('2026-01-01', 12, 'stooq')];
  assert.equal(priceOn(points, '2026-01-01').price, 12);
  assert.equal(priceOn(points.filter((p) => p.source !== 'stooq'), '2026-01-01').price, 11);
});

test('ensureHoldingPrices: Stooq empty falls back to Yahoo; Stooq data never consults Yahoo', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT, created_at TEXT, UNIQUE (holding_id, date, source));
  `);
  const ts = (y, m, d) => Date.UTC(y, m, d) / 1000;
  const yahooJson = {
    chart: {
      result: [{
        timestamp: [ts(2026, 0, 2), ts(2026, 1, 2)],
        indicators: { quote: [{ close: [61, 62] }] },
      }],
      error: null,
    },
  };
  const calls = [];
  const realFetch = globalThis.fetch;
  const savedEnv = { s: process.env.STOOQ_BASE_URL, y: process.env.YAHOO_BASE_URL };
  process.env.STOOQ_BASE_URL = 'http://stub.test/stooq/';
  process.env.YAHOO_BASE_URL = 'http://stub.test/yahoo/';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/stooq/')) {
      // HXQ.TO is the TSX ticker Stooq doesn't know; XQQ.TO it has.
      const has = String(url).includes('xqq.to');
      return { ok: true, text: async () => (has
        ? 'Date,Open,High,Low,Close,Volume\n2026-01-02,1,1,1,140,1\n'
        : 'No data') };
    }
    return { ok: true, json: async () => yahooJson };
  };
  try {
    const hxq = { id: 5, kind: 'exchange', symbol: 'HXQ.TO' };
    assert.equal(await ensureHoldingPrices(db, hxq), true);
    assert.deepEqual(listPricePoints(db, 5).map((p) => [p.date, p.price, p.source]), [
      ['2026-01-02', 61, 'yahoo'],
      ['2026-02-02', 62, 'yahoo'],
    ]);
    assert.equal(calls.filter((u) => u.includes('/yahoo/')).length, 1);
    const xqq = { id: 6, kind: 'exchange', symbol: 'XQQ.TO' };
    assert.equal(await ensureHoldingPrices(db, xqq), true);
    assert.deepEqual(listPricePoints(db, 6).map((p) => [p.date, p.price, p.source]), [
      ['2026-01-02', 140, 'stooq'],
    ]);
    assert.equal(calls.filter((u) => u.includes('/yahoo/')).length, 1, 'yahoo not consulted again');
    // Both tiers empty → false, nothing cached, no throw.
    const acme = { id: 7, kind: 'exchange', symbol: 'ACME' };
    globalThis.fetch = async (url) => (String(url).includes('/stooq/')
      ? { ok: true, text: async () => 'No data' }
      : { ok: false, json: async () => ({}) });
    assert.equal(await ensureHoldingPrices(db, acme), false);
    assert.deepEqual(listPricePoints(db, 7), []);
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.s === undefined) delete process.env.STOOQ_BASE_URL; else process.env.STOOQ_BASE_URL = savedEnv.s;
    if (savedEnv.y === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedEnv.y;
    db.close();
  }
});

test('price failures are loud: detailed result carries the verbatim error and priceStatusFor reports it', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT, created_at TEXT, UNIQUE (holding_id, date, source));
  `);
  const realFetch = globalThis.fetch;
  const savedEnv = { s: process.env.STOOQ_BASE_URL, y: process.env.YAHOO_BASE_URL };
  process.env.STOOQ_BASE_URL = 'http://stub.test/stooq/';
  process.env.YAHOO_BASE_URL = 'http://stub.test/yahoo/';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/stooq/')) return { ok: true, text: async () => 'No data' };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const holding = { id: 9, kind: 'exchange', symbol: 'ZZFAIL.TO' };
    const r = await ensureHoldingPricesDetailed(db, holding);
    assert.equal(r.ok, false);
    assert.equal(r.source, null);
    assert.equal(r.error, 'yahoo fetch failed: HTTP 404');
    // The boolean wrapper keeps its old contract.
    assert.equal(await ensureHoldingPrices(db, { id: 10, kind: 'exchange', symbol: 'ZZFAIL.TO' }), false);
    const st = priceStatusFor(db, holding, null);
    assert.equal(st.fetchFailedToday, true);
    assert.equal(st.lastError, 'yahoo fetch failed: HTTP 404');
    assert.match(st.lastAttemptAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // A later success clears the recorded failure.
    globalThis.fetch = async (url) => {
      if (String(url).includes('/stooq/')) return { ok: true, text: async () => 'No data' };
      const ts = (y, m, d) => Date.UTC(y, m, d) / 1000;
      return { ok: true, json: async () => ({ chart: { result: [{ timestamp: [ts(2026, 0, 2)], indicators: { quote: [{ close: [42] }] } }], error: null } }) };
    };
    db.prepare("DELETE FROM app_meta WHERE key = 'invest_px_9_ok'").run();
    db.prepare("DELETE FROM app_meta WHERE key = 'invest_px_9_try'").run();
    assert.equal((await ensureHoldingPricesDetailed(db, holding)).ok, true);
    const st2 = priceStatusFor(db, holding, null);
    assert.equal(st2.lastError, null);
    assert.equal(st2.fetchFailedToday, false);
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.s === undefined) delete process.env.STOOQ_BASE_URL; else process.env.STOOQ_BASE_URL = savedEnv.s;
    if (savedEnv.y === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedEnv.y;
    db.close();
  }
});

test('manual refresh retries once on timeout, fetch-on-read does not', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT, created_at TEXT, UNIQUE (holding_id, date, source));
  `);
  const realFetch = globalThis.fetch;
  const savedEnv = { s: process.env.STOOQ_BASE_URL, y: process.env.YAHOO_BASE_URL, fx: process.env.FX_API_URL };
  process.env.STOOQ_BASE_URL = 'http://stub.test/stooq/';
  process.env.YAHOO_BASE_URL = 'http://stub.test/yahoo/';
  process.env.FX_API_URL = 'http://stub.test/fx/';
  const timeoutErr = () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; return e; };
  let calls = 0;
  let failFirstPass = true;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/fx/')) {
      return { ok: true, json: async () => ({ observations: [{ d: '2026-01-01', FX_USDCAD: { v: '1.3000' } }] }) };
    }
    calls++;
    if (failFirstPass && calls <= 2) throw timeoutErr();
    if (String(url).includes('/stooq/')) return { ok: true, text: async () => 'No data' };
    const ts = (y, m, d) => Date.UTC(y, m, d) / 1000;
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: [ts(2026, 0, 2)], indicators: { quote: [{ close: [42] }] } }], error: null } }) };
  };
  try {
    const holding = { id: 11, kind: 'exchange', symbol: 'RETRY.TO' };
    // Manual path (refreshAllPrices): two timeouts, then success on the retry pass.
    const results = await refreshAllPrices(db, [holding]);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].source, 'yahoo');
    assert.equal(results[0].error, null);
    assert.ok(calls >= 4, `expected a retry pass, got ${calls} calls`);
    // Fetch-on-read path: same first-pass timeouts, no retry.
    calls = 0;
    failFirstPass = true;
    db.prepare("DELETE FROM app_meta WHERE key LIKE 'invest_px_12_%'").run();
    const r = await ensureHoldingPricesDetailed(db, { id: 12, kind: 'exchange', symbol: 'RETRY.TO' });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
    assert.equal(calls, 2, 'fetch-on-read must not retry');
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.s === undefined) delete process.env.STOOQ_BASE_URL; else process.env.STOOQ_BASE_URL = savedEnv.s;
    if (savedEnv.y === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedEnv.y;
    if (savedEnv.fx === undefined) delete process.env.FX_API_URL; else process.env.FX_API_URL = savedEnv.fx;
    db.close();
  }
});

test('deleted holding stamps die with it: a reused id fetches fresh, not the old backoff', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT, created_at TEXT, UNIQUE (holding_id, date, source));
  `);
  const realFetch = globalThis.fetch;
  const savedEnv = { s: process.env.STOOQ_BASE_URL, y: process.env.YAHOO_BASE_URL };
  process.env.STOOQ_BASE_URL = 'http://stub.test/stooq/';
  process.env.YAHOO_BASE_URL = 'http://stub.test/yahoo/';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/stooq/')) return { ok: true, text: async () => 'No data' };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const holding = { id: 5, kind: 'exchange', symbol: 'GONE.TO' };
    assert.equal((await ensureHoldingPricesDetailed(db, holding)).ok, false);
    assert.equal(priceStatusFor(db, holding, null).fetchFailedToday, true);
    // The holding is deleted; SQLite may hand id 5 to the next
    // holding. Without cleanup the new holding would inherit
    // the 15-minute backoff and sit on event prices.
    clearHoldingPriceMeta(db, 5);
    assert.equal(priceStatusFor(db, holding, null).fetchFailedToday, false);
    assert.equal(priceStatusFor(db, holding, null).lastError, null);
    globalThis.fetch = async (url) => {
      if (String(url).includes('/stooq/')) return { ok: true, text: async () => 'No data' };
      const ts = (y, m, d) => Date.UTC(y, m, d) / 1000;
      return { ok: true, json: async () => ({ chart: { result: [{ timestamp: [ts(2026, 0, 2)], indicators: { quote: [{ close: [42] }] } }], error: null } }) };
    };
    const r2 = await ensureHoldingPricesDetailed(db, holding);
    assert.equal(r2.ok, true);
    assert.equal(r2.source, 'yahoo');
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.s === undefined) delete process.env.STOOQ_BASE_URL; else process.env.STOOQ_BASE_URL = savedEnv.s;
    if (savedEnv.y === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedEnv.y;
    db.close();
  }
});

test('monthly year paging: distinct years, latest default, cross-year boundary slices', () => {
  const rows = [
    { month: '2021-03' }, { month: '2025-12' }, { month: '2026-01' }, { month: '2026-10' },
  ];
  assert.deepEqual(monthlyYears(rows), ['2021', '2025', '2026']);
  assert.equal(latestMonthlyYear(rows), '2026');
  assert.deepEqual(monthlyRowsForYear(rows, '2025').map((r) => r.month), ['2025-12']);
  assert.deepEqual(monthlyRowsForYear(rows, '2026').map((r) => r.month), ['2026-01', '2026-10']);
  assert.deepEqual(monthlyRowsForYear(rows, '2024'), []);
  assert.deepEqual(monthlyYears([]), []);
  assert.equal(latestMonthlyYear([]), null);
  assert.deepEqual(monthlyRowsForYear([], '2026'), []);
});

test('fetchYahooHistory: browser UA, and query1 failing over to query2', async () => {
  // Yahoo 403s non-browser agents, so the market fetches must
  // present as a browser; and with no YAHOO_BASE_URL seam set,
  // a dead query1 must not empty the tier — query2 serves the
  // same chart path.
  const ts = (y, m, d) => Date.UTC(y, m, d) / 1000;
  const chartJson = {
    chart: {
      result: [{
        timestamp: [ts(2026, 0, 2), ts(2026, 1, 2)],
        indicators: { quote: [{ close: [71.5, 72.25] }] },
      }],
      error: null,
    },
  };
  const calls = [];
  const realFetch = globalThis.fetch;
  const savedYahoo = process.env.YAHOO_BASE_URL;
  delete process.env.YAHOO_BASE_URL;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, ua: opts && opts.headers && opts.headers['User-Agent'] });
    if (u.includes('query1.finance.yahoo.com')) return { ok: false, status: 403 };
    if (u.includes('query2.finance.yahoo.com')) return { ok: true, json: async () => chartJson };
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const rows = await fetchYahooHistory('XQQ.TO');
    assert.deepEqual(rows, [
      { date: '2026-01-02', price: 71.5 },
      { date: '2026-02-02', price: 72.25 },
    ]);
    assert.equal(calls.length, 2, 'query1 tried once, then query2');
    assert.ok(calls[0].url.includes('query1.finance.yahoo.com/v8/finance/chart/XQQ.TO'));
    assert.ok(calls[1].url.includes('query2.finance.yahoo.com/v8/finance/chart/XQQ.TO'));
    for (const c of calls) {
      assert.match(c.ua || '', /Mozilla\/5\.0.*Chrome\//, 'a browser UA is sent');
      assert.ok(!/FinanceMate/.test(c.ua || ''), 'the app UA that Yahoo blocks is gone');
    }
  } finally {
    globalThis.fetch = realFetch;
    if (savedYahoo === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedYahoo;
  }
});

test('fetchYahooHistory: an explicit YAHOO_BASE_URL stays single-host', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const savedYahoo = process.env.YAHOO_BASE_URL;
  process.env.YAHOO_BASE_URL = 'http://stub.test/yahoo/';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: false, status: 403 };
  };
  try {
    await assert.rejects(() => fetchYahooHistory('XQQ.TO'), /HTTP 403/);
    assert.equal(calls.length, 1, 'the seam base is the only host consulted');
    assert.ok(calls[0].startsWith('http://stub.test/yahoo/'));
  } finally {
    globalThis.fetch = realFetch;
    if (savedYahoo === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedYahoo;
  }
});

test('fetchStooqHistory: sends a browser UA too', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const savedStooq = process.env.STOOQ_BASE_URL;
  process.env.STOOQ_BASE_URL = 'http://stub.test/stooq/';
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), ua: opts && opts.headers && opts.headers['User-Agent'] });
    return { ok: true, text: async () => 'Date,Open,High,Low,Close,Volume\n2026-01-02,1,1,1,140,1\n' };
  };
  try {
    assert.deepEqual(await fetchStooqHistory('XQQ.TO'), [{ date: '2026-01-02', price: 140 }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].ua || '', /Mozilla\/5\.0.*Chrome\//, 'a browser UA is sent');
    assert.ok(!/FinanceMate/.test(calls[0].ua || ''), 'the app UA is gone here too');
  } finally {
    globalThis.fetch = realFetch;
    if (savedStooq === undefined) delete process.env.STOOQ_BASE_URL; else process.env.STOOQ_BASE_URL = savedStooq;
  }
});

// ------------------------------------------------------------ AI chat
const AI_ENV = { LLM_API_KEY: 'test', LLM_MODEL: 'stub-a', LLM_MODELS: 'stub-a,stub-b' };
const ACCT = { id: 3, name: 'TFSA', type: 'TFSA', institution: 'CIBC' };
const EXISTING = [{
  id: 12, label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', fund_code: null, currency: 'CAD',
  events: [{ id: 31, holding_id: 12, date: '2026-01-05', type: 'buy', units: 10, price: 150, amount: null }],
}];

test('normalizeProposedInvestments: normalization and duplicate flags', () => {
  const out = normalizeProposedInvestments({
    holdings: [
      { ref: 'h1', label: 'XQQ', kind: 'exchange', symbol: 'xqq.to', currency: 'cad' }, // duplicate of #12
      { ref: 'h2', label: 'CIBC U.S. Index Fund', kind: 'fund', currency: 'CAD' },
      { ref: 'h3', label: 'No ticker', kind: 'exchange', currency: 'CAD' }, // dropped: no symbol
      { label: '', kind: 'fund', currency: 'CAD' },                          // dropped: no label
    ],
    events: [
      { holdingId: 12, date: '2026-01-05', type: 'buy', units: 10, price: 150 },  // exact duplicate
      { holdingId: 12, date: '2026-02-01', type: 'dividend', amount: 12.5 },
      { holdingRef: 'h2', date: 'Feb 3, 2026', type: 'buy', units: '20', price: '31.5' },
      { holdingId: 999, date: '2026-02-01', type: 'buy', units: 1, price: 1 },    // unknown holding: dropped
      { holdingRef: 'h3', date: '2026-02-01', type: 'buy', units: 1, price: 1 },  // dropped holding: dropped
    ],
  }, { existingHoldings: EXISTING, existingEvents: EXISTING[0].events });
  assert.equal(out.holdings.length, 2);
  assert.equal(out.holdings[0].conflict, 'duplicate-holding');
  assert.equal(out.holdings[0].symbol, 'XQQ.TO');
  assert.equal(out.holdings[1].conflict, null);
  assert.equal(out.events.length, 3);
  assert.equal(out.events[0].conflict, 'duplicate-event');
  assert.deepEqual(out.events[2], {
    holdingId: null, holdingRef: 'h2', date: '2026-02-03', type: 'buy',
    units: 20, price: 31.5, amount: null, splitNew: null, splitOld: null, priceDerived: false, note: null, conflict: null,
  });
});

test('handleAiInvestFillChat: two rounds — question first, draft completes after the answer', async () => {
  const replies = [
    JSON.stringify({
      reply: 'I found the XQQ purchase. For the CIBC fund — is it denominated in CAD or USD?',
      proposed: { holdings: [], events: [{ holdingId: 12, date: '2026-03-02', type: 'buy', units: 5, price: 160 }] },
      ready: false,
    }),
    JSON.stringify({
      reply: 'Thanks — added the fund as CAD with its first purchase.',
      proposed: {
        holdings: [{ ref: 'h1', label: 'CIBC U.S. Index Fund', kind: 'fund', currency: 'CAD' }],
        events: [
          { holdingId: 12, date: '2026-03-02', type: 'buy', units: 5, price: 160 },
          { holdingRef: 'h1', date: '2026-03-02', type: 'buy', units: 100, price: 31.25 },
        ],
      },
      ready: true,
    }),
  ];
  let round = 0;
  const seen = [];
  const deps = {
    env: AI_ENV, account: ACCT, holdings: EXISTING,
    callLlm: async (messages) => { seen.push(messages); return replies[round++]; },
  };
  const r1 = await handleAiInvestFillChat(
    { accountId: 3, history: [], text: 'Bought 5 more XQQ on Mar 2 at 160. Also started the CIBC US index fund.' }, deps);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ready, false);
  assert.match(r1.body.reply, /CAD or USD/);
  assert.equal(r1.body.proposed.events.length, 1);
  // The account + existing holdings ride into the prompt context.
  const sys = seen[0][0].content;
  assert.match(sys, /Account: TFSA \(TFSA, CIBC\)/);
  assert.match(sys, /#12 · XQQ · exchange · XQQ\.TO · CAD/);
  const r2 = await handleAiInvestFillChat({
    accountId: 3,
    history: [
      { role: 'user', content: 'Bought 5 more XQQ…' },
      { role: 'assistant', content: r1.body.reply },
    ],
    text: 'The fund is CAD. First buy was 100 units on Mar 2 at 31.25.',
    proposed: r1.body.proposed,
  }, deps);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.ready, true);
  assert.equal(r2.body.proposed.holdings.length, 1);
  assert.equal(r2.body.proposed.holdings[0].currency, 'CAD');
  assert.equal(r2.body.proposed.events.length, 2);
  assert.equal(r2.body.proposed.events[1].holdingRef, 'h1');
});

// --------------------------------------------------- security search
test('parseYahooSearch: field mapping — TSX candidates are CAD, US venues USD', () => {
  const out = parseYahooSearch({ quotes: [
    { symbol: 'XQQ.TO', shortname: 'ISHARES NASDAQ 100 INDEX ETF', longname: 'iShares XQQ', exchange: 'TOR', exchDisp: 'Toronto', quoteType: 'ETF' },
    { symbol: 'HXQ.TO', shortname: 'ISHARES HXQ', exchange: 'TSX', quoteType: 'ETF' }, // no exchDisp, .TO suffix still CAD
    { symbol: 'QQQ', shortname: 'Invesco QQQ Trust', exchange: 'NMS', exchDisp: 'NASDAQ', quoteType: 'ETF' },
    { symbol: 'AAPL', shortname: 'Apple Inc.', exchange: 'NMS', quoteType: 'EQUITY', currency: 'USD' },
    { symbol: '^GSPC', shortname: 'S&P 500', exchange: 'SNP', quoteType: 'INDEX' }, // dropped
    { symbol: 'USD/CAD', shortname: 'US Dollar', exchange: 'CCY', quoteType: 'CURRENCY' }, // dropped
    { shortname: 'no symbol at all', quoteType: 'ETF' }, // dropped
  ] });
  assert.deepEqual(out.map((c) => [c.symbol, c.currency]), [
    ['XQQ.TO', 'CAD'], ['HXQ.TO', 'CAD'], ['QQQ', 'USD'], ['AAPL', 'USD'],
  ]);
  assert.equal(out[0].label, 'iShares XQQ'); // longname wins over shortname
  assert.equal(out[0].exchange, 'Toronto'); // exchDisp is the display label
  assert.deepEqual(parseYahooSearch(null), []);
  assert.deepEqual(parseYahooSearch({}), []);
  assert.deepEqual(parseYahooSearch({ quotes: 'nope' }), []);
});

test('searchSecurities: stub Yahoo answers through the YAHOO_BASE_URL seam; failures degrade to []', async () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { y: process.env.YAHOO_BASE_URL, s: process.env.YAHOO_SEARCH_BASE_URL };
  delete process.env.YAHOO_SEARCH_BASE_URL;
  process.env.YAHOO_BASE_URL = 'http://stub.test/v8/finance/chart/';
  const seen = [];
  try {
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return {
        ok: true, status: 200,
        json: async () => ({ quotes: [
          { symbol: 'XQQ.TO', shortname: 'ISHARES NASDAQ 100', exchange: 'TOR', exchDisp: 'Toronto', quoteType: 'ETF' },
        ] }),
      };
    };
    const hits = await searchSecurities('XQQ');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].symbol, 'XQQ.TO');
    assert.equal(hits[0].currency, 'CAD');
    assert.ok(seen[0].includes('/v1/finance/search') && seen[0].includes('q=XQQ'), seen[0]);
    // Upstream HTTP failure → empty list, never a throw.
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.deepEqual(await searchSecurities('XQQ'), []);
    // Network failure → empty list.
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    assert.deepEqual(await searchSecurities('XQQ'), []);
    // Too-short queries never leave the process.
    globalThis.fetch = async () => { throw new Error('must not be called'); };
    assert.deepEqual(await searchSecurities('X'), []);
    assert.deepEqual(await searchSecurities('  '), []);
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.y === undefined) delete process.env.YAHOO_BASE_URL; else process.env.YAHOO_BASE_URL = savedEnv.y;
    if (savedEnv.s === undefined) delete process.env.YAHOO_SEARCH_BASE_URL; else process.env.YAHOO_SEARCH_BASE_URL = savedEnv.s;
  }
});

// --------------------------------------------- initial event batches
test('validInitialEvents: absent/empty batches are fine; non-arrays are not', () => {
  assert.deepEqual(validInitialEvents(undefined), { events: [] });
  assert.deepEqual(validInitialEvents(null), { events: [] });
  assert.deepEqual(validInitialEvents([]), { events: [] });
  assert.match(validInitialEvents('buy 10').error, /array/);
});

test('validInitialEvents: a buy + later sell batch validates in date order', () => {
  // Listed sell-first on purpose: validation sorts by date, so
  // the January buy covers the February sell.
  const out = validInitialEvents([
    { date: '2026-02-10', type: 'sell', units: 4, price: 155 },
    { date: '2026-01-15', type: 'buy', units: 10, price: 150 },
    { date: '2026-03-01', type: 'dividend', amount: 12.5 },
  ]);
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(out.events.map((e) => [e.date, e.type]), [
    ['2026-01-15', 'buy'], ['2026-02-10', 'sell'], ['2026-03-01', 'dividend'],
  ]);
  assert.equal(out.events[2].amount, 12.5);
});

test('validInitialEvents: sells are checked against units acquired by their date', () => {
  // Sell exceeds the cumulative position on its date.
  assert.match(validInitialEvents([
    { date: '2026-01-05', type: 'buy', units: 10, price: 100 },
    { date: '2026-01-06', type: 'sell', units: 15, price: 100 },
  ]).error, /cannot sell/);
  // Sell dated BEFORE the buy that would cover it.
  assert.match(validInitialEvents([
    { date: '2026-01-05', type: 'buy', units: 10, price: 100 },
    { date: '2026-01-04', type: 'sell', units: 5, price: 100 },
  ]).error, /cannot sell/);
  // Same day: the batch's own order decides — buy first covers
  // the sell; sell first has nothing to draw on.
  assert.equal(validInitialEvents([
    { date: '2026-01-05', type: 'buy', units: 10, price: 100 },
    { date: '2026-01-05', type: 'sell', units: 10, price: 100 },
  ]).error, undefined);
  assert.match(validInitialEvents([
    { date: '2026-01-05', type: 'sell', units: 5, price: 100 },
    { date: '2026-01-05', type: 'buy', units: 10, price: 100 },
  ]).error, /cannot sell/);
});

test('validInitialEvents: any bad row fails the whole batch', () => {
  assert.match(validInitialEvents([
    { date: '2026-01-05', type: 'buy', units: 10, price: 100 },
    { date: '2026-01-06', type: 'buy', units: 5 }, // no price
  ]).error, /price/);
  assert.match(validInitialEvents([
    { date: '2026-01-05', type: 'buy', units: 10, price: 100 },
    { date: 'not-a-date', type: 'buy', units: 5, price: 1 },
  ]).error, /date/);
  assert.match(validInitialEvents([
    { date: '2026-01-05', type: 'dividend' }, // no amount
  ]).error, /amount/);
});

test('handleAiInvestFillChat: 404 unknown account, 400 missing input, 503 unconfigured, 502 junk reply', async () => {
  const deps = { env: AI_ENV, account: null, holdings: [], callLlm: async () => '{}' };
  assert.equal((await handleAiInvestFillChat({ accountId: 99, text: 'x' }, deps)).status, 404);
  assert.equal((await handleAiInvestFillChat({ text: 'x' }, { ...deps, account: ACCT })).status, 400);
  assert.equal((await handleAiInvestFillChat({ accountId: 3 }, { ...deps, account: ACCT })).status, 400);
  const unconf = await handleAiInvestFillChat(
    { accountId: 3, text: 'x' }, { env: {}, account: ACCT, holdings: [], callLlm: async () => '{}' });
  assert.equal(unconf.status, 503);
  assert.match(unconf.body.error, /LLM_API_KEY/);
  const junk = await handleAiInvestFillChat(
    { accountId: 3, text: 'x' }, { env: AI_ENV, account: ACCT, holdings: [], callLlm: async () => 'not json' });
  assert.equal(junk.status, 502);
});

// ------------------------------------------------------- account owners
test('account owners: stored JSON array reads back as an array; NULL reads as []', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE invest_accounts (id INTEGER PRIMARY KEY, name TEXT, type TEXT,
    institution TEXT, note TEXT, owners TEXT, created_at TEXT, updated_at TEXT)`);
  const ins = db.prepare('INSERT INTO invest_accounts (name, type, owners) VALUES (?, ?, ?)');
  ins.run('Joint TFSA', 'TFSA', '["Shawn","Jiaying"]');
  ins.run('Solo RRSP', 'RRSP', null);
  ins.run('Broken', 'Other', 'not-json');
  assert.deepEqual(getAccount(db, 1).owners, ['Shawn', 'Jiaying']);
  assert.deepEqual(getAccount(db, 2).owners, []);
  assert.deepEqual(getAccount(db, 3).owners, []);
  assert.deepEqual(listAccounts(db).map((a) => a.owners), [['Shawn', 'Jiaying'], [], []]);
  assert.equal(getAccount(db, 99), null);
});
