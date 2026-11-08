// What-if backtest + buy-target history (user 2026-11-07): the
// history pull and the backtest are SYMBOL-GENERIC — any buy target
// the user does not hold yet gets its history pulled and its own
// rate. AMZN is only an example. Every pin here runs on TWO
// different non-held symbols (AMZN and MSFT) so the general case is
// covered, not one symbol's special case.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureSymbolHistory, listSymbolPricePoints } from '../src/prices.js';
import { computeProjection, whatIfBacktest, currentReturnRateFromPoints } from '../src/planning.js';

// 13 monthly labels, 2025-11 → 2026-11.
const MONTHS13 = [];
for (let i = 0; i < 13; i++) {
  const y = 2025 + Math.floor((10 + i) / 12);
  const m = ((10 + i) % 12) + 1;
  MONTHS13.push(`${y}-${String(m).padStart(2, '0')}`);
}
// Geometric monthly points from startPrice to endPrice over the 13
// months, so the 1y CAGR is exactly end/start − 1.
const geoPoints = (startPrice, endPrice) => MONTHS13.map((m, i) => ({
  date: `${m}-15`,
  price: Number((startPrice * Math.pow(endPrice / startPrice, i / 12)).toFixed(6)),
}));
const approx = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;

// ---- ensureSymbolHistory: pull + store + gate + backoff ----

test('ensureSymbolHistory: pulls history for ANY symbol-only buy target, stores points, yields its own rate', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invest_symbol_prices (symbol TEXT, date TEXT, price REAL, currency TEXT, source TEXT, created_at TEXT, PRIMARY KEY (symbol, date));
  `);
  const calls = [];
  const fetchSymbol = async ({ symbol }) => {
    calls.push(symbol);
    const [s, e] = symbol === 'AMZN' ? [200, 266.03] : [100, 150];
    return { rows: geoPoints(s, e), source: 'stooq' };
  };
  // Lowercase input is fine — symbols store uppercase.
  const out = await ensureSymbolHistory(db, [
    { symbol: 'amzn', currency: 'USD' },
    { symbol: 'msft', currency: 'USD' },
  ], { currentMonth: '2026-11', fetchSymbol });
  assert.deepEqual(calls, ['AMZN', 'MSFT']);
  assert.equal(out.notes.length, 0);
  assert.equal(out.results.length, 2);
  const amzn = out.results.find((r) => r.symbol === 'AMZN');
  const msft = out.results.find((r) => r.symbol === 'MSFT');
  assert.equal(amzn.ok, true);
  assert.equal(msft.ok, true);
  assert.ok(approx(amzn.ratePct, 33.015, 0.01), `AMZN rate ${amzn.ratePct}`);
  assert.ok(approx(msft.ratePct, 50, 0.01), `MSFT rate ${msft.ratePct}`);
  assert.equal(listSymbolPricePoints(db, 'amzn').length, 13);
  assert.equal(listSymbolPricePoints(db, 'MSFT').length, 13);
  assert.equal(listSymbolPricePoints(db, 'AMZN')[0].currency, 'USD');
  // Second call: both symbols now have a usable rate — no pull.
  calls.length = 0;
  const out2 = await ensureSymbolHistory(db, [
    { symbol: 'AMZN', currency: 'USD' },
    { symbol: 'MSFT', currency: 'USD' },
  ], { currentMonth: '2026-11', fetchSymbol });
  assert.deepEqual(calls, []);
  assert.deepEqual(out2.results, []);
  db.close();
});

test('ensureSymbolHistory: a failed fetch never throws, notes it, and backs off', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE invest_symbol_prices (symbol TEXT, date TEXT, price REAL, currency TEXT, source TEXT, created_at TEXT, PRIMARY KEY (symbol, date));
  `);
  db.prepare('INSERT INTO invest_symbol_prices (symbol, date, price, currency, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('MSFT', '2026-10-30', 150, 'USD', 'nasdaq', '2026-10-30T00:00:00Z');
  const failing = async () => { throw new Error('network down'); };
  const out = await ensureSymbolHistory(db, [{ symbol: 'MSFT', currency: 'USD' }], { currentMonth: '2026-11', fetchSymbol: failing });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].symbol, 'MSFT');
  assert.ok(/network down/.test(out.notes[0].error));
  assert.deepEqual(listSymbolPricePoints(db, 'MSFT').map((q) => q.price), [150], 'stored points untouched');
  let tries = 0;
  const counting = async () => { tries += 1; throw new Error('still down'); };
  await ensureSymbolHistory(db, [{ symbol: 'MSFT', currency: 'USD' }], { currentMonth: '2026-11', fetchSymbol: counting });
  assert.equal(tries, 0, 'backed off — no re-attempt inside the window');
  db.close();
});

// ---- computeProjection: a symbol-only buy grows at its own rate ----

const MAINLINE = (over = {}) => ({
  properties: [], holdings: [], fxRateLatest: null, declaredAssets: [], assessed: {},
  ...over,
});
const ARGS = (over = {}) => ({
  mainline: MAINLINE(), ops: [], legs: [], assumptions: {},
  scenario: null, primeHistory: [], currentPrime: 4.70, currentMonth: '2026-11',
  ...over,
});
const symbolBuy = (seq, symbol, amount, price) => ({
  seq, op_type: 'buy',
  params: { accountId: 1, symbol, currency: 'CAD', date: '2026-11-01', amount, price },
});

test('computeProjection: a symbol-only buy grows at its history rate (AMZN 33.015%/yr)', () => {
  const pts = geoPoints(200, 266.03);
  assert.ok(approx(currentReturnRateFromPoints(pts, '2026-11').ratePct, 33.015, 0.01));
  const r = computeProjection(ARGS({
    ops: [symbolBuy(1, 'AMZN', 2000, 200)],
    legs: [{ op_seq: 1, source_ref: 'external', amount: 'all' }],
    symbolPricePoints: { AMZN: pts },
  }));
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  const s = r.stocks.series;
  assert.equal(s[0].month, '2026-11');
  assert.equal(s[12].month, '2027-11');
  assert.ok(s[0].value > 0, `buy month ${s[0].value}`);
  // 10 units × $266.03 at the buy month; 12 months later the same
  // 10 units at the 1y CAGR — the series must grow, not stay flat.
  assert.ok(approx(s[0].value, 2660.30, 0.01), `buy month ${s[0].value}`);
  assert.ok(approx(s[12].value / s[0].value, 1.33015, 0.001), `12mo ratio ${s[12].value / s[0].value}`);
});

test('computeProjection: a second symbol grows at ITS OWN rate (MSFT 50%/yr), not the first symbol\'s', () => {
  const pts = geoPoints(100, 150);
  assert.ok(approx(currentReturnRateFromPoints(pts, '2026-11').ratePct, 50, 0.01));
  const r = computeProjection(ARGS({
    ops: [symbolBuy(1, 'MSFT', 1500, 100)],
    legs: [{ op_seq: 1, source_ref: 'external', amount: 'all' }],
    symbolPricePoints: { MSFT: pts },
  }));
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  const s = r.stocks.series;
  assert.ok(approx(s[0].value, 2250, 0.01), `buy month ${s[0].value}`);
  assert.ok(approx(s[12].value / s[0].value, 1.50, 0.001), `12mo ratio ${s[12].value / s[0].value}`);
});

test('computeProjection: a symbol-only buy with no history stays flat — never an invented return', () => {
  const r = computeProjection(ARGS({
    ops: [symbolBuy(1, 'NOHIST', 1000, 100)],
    legs: [{ op_seq: 1, source_ref: 'external', amount: 'all' }],
    symbolPricePoints: {},
  }));
  assert.equal(r.errors.length, 0, r.errors.join('; '));
  const s = r.stocks.series;
  assert.equal(s[0].value, 1000);
  assert.equal(s[12].value, 1000);
  assert.equal(s[120].value, 1000);
});

// ---- whatIfBacktest: one continuous chart, real past + forecast ----

const leg = (symbol, startPrice, monthly, ratePct) => {
  const points = [];
  for (let i = 0; i < 13; i++) points.push({ date: `${MONTHS13[i]}-15`, price: Number((startPrice * Math.pow(monthly, i)).toFixed(6)) });
  return { symbol, currency: 'CAD', points, ratePct };
};

test('whatIfBacktest: past uses real prices, future compounds at each leg\'s own rate, cutoff at the current month', () => {
  const out = whatIfBacktest({
    actual: leg('AAA', 100, 1.02, 26.8242),
    alt: leg('BBB', 50, 1.03, 42.5761),
    amountCad: 10000, startMonth: '2025-11', currentMonth: '2026-11', horizonMonth: '2027-11',
  });
  assert.equal(out.months[0], '2025-11');
  assert.equal(out.months[out.months.length - 1], '2027-11');
  assert.equal(out.cutoffMonth, '2026-11');
  assert.equal(out.cutoffIndex, 12);
  assert.equal(out.startMonth, '2025-11');
  // Backtest leg: amount × price[m] / price[start].
  assert.ok(approx(out.actualValues[6], 10000 * Math.pow(1.02, 6), 0.01), `actual May ${out.actualValues[6]}`);
  assert.ok(approx(out.altValues[6], 10000 * Math.pow(1.03, 6), 0.01), `alt May ${out.altValues[6]}`);
  assert.ok(approx(out.actualCutValue, 10000 * Math.pow(1.02, 12), 0.01), `actual cut ${out.actualCutValue}`);
  assert.ok(approx(out.altCutValue, 10000 * Math.pow(1.03, 12), 0.01), `alt cut ${out.altCutValue}`);
  // Forecast leg: cutoff value × (1 + rate)^(t/12), each leg at its
  // OWN rate — the alt outgrows the actual after the cutoff.
  assert.ok(approx(out.actualEndValue, out.actualCutValue * 1.268242, 0.5), `actual end ${out.actualEndValue}`);
  assert.ok(approx(out.altEndValue, out.altCutValue * 1.425761, 0.5), `alt end ${out.altEndValue}`);
  assert.ok(out.altEndValue > out.actualEndValue, 'alt ends ahead');
  // Prices are CAD per unit, carried forward, never invented back.
  assert.ok(approx(out.actualPrices[0], 100, 0.01));
  assert.ok(approx(out.altPrices[12], 50 * Math.pow(1.03, 12), 0.01));
});

test('whatIfBacktest: a start month before either history clamps to the first month both have prices', () => {
  const out = whatIfBacktest({
    actual: leg('AAA', 100, 1.02, 26.8242),
    alt: leg('BBB', 50, 1.03, 42.5761),
    amountCad: 10000, startMonth: '2025-06', currentMonth: '2026-11', horizonMonth: '2027-11',
  });
  assert.equal(out.startMonth, '2025-11');
  assert.equal(out.months[0], '2025-11');
  assert.equal(out.actualValues[0], 10000);
  assert.equal(out.altValues[0], 10000);
});

test('whatIfBacktest: the series carries the full history even when the default start is later', () => {
  // The buy-op month (default start) is 2026-06, but both legs have
  // prices back to 2025-11: months start at the history, values
  // are normalized to the default start (so the value AT the
  // default start is the amount), and the client re-normalizes to
  // any picked start from these values.
  const out = whatIfBacktest({
    actual: leg('AAA', 100, 1.02, 26.8242),
    alt: leg('BBB', 50, 1.03, 42.5761),
    amountCad: 10000, startMonth: '2026-06', currentMonth: '2026-11', horizonMonth: '2027-11',
  });
  assert.equal(out.startMonth, '2026-06');
  assert.equal(out.historyStartMonth, '2025-11');
  assert.equal(out.months[0], '2025-11');
  assert.equal(out.cutoffIndex, 12);
  assert.equal(out.actualValues[7], 10000, 'value at the default start is the amount');
  assert.equal(out.altValues[7], 10000);
  assert.ok(approx(out.actualValues[0], 10000 / Math.pow(1.02, 7), 0.01), `value at history start ${out.actualValues[0]}`);
  assert.ok(approx(out.altValues[0], 10000 / Math.pow(1.03, 7), 0.01), `alt at history start ${out.altValues[0]}`);
});

test('whatIfBacktest: a leg with no usable rate forecasts flat at its cutoff value', () => {
  const out = whatIfBacktest({
    actual: leg('AAA', 100, 1.02, 26.8242),
    alt: { symbol: 'BBB', currency: 'CAD', points: [{ date: '2026-10-15', price: 50 }], ratePct: null },
    amountCad: 10000, startMonth: '2026-10', currentMonth: '2026-11', horizonMonth: '2027-11',
  });
  assert.equal(out.startMonth, '2026-10');
  assert.equal(out.altCutValue, 10000);
  assert.equal(out.altEndValue, 10000, 'flat forecast, never invented');
  assert.ok(out.actualEndValue > out.actualCutValue, 'the rated leg still grows');
});

test('whatIfBacktest: no price history on either leg returns null', () => {
  const out = whatIfBacktest({
    actual: { symbol: 'AAA', currency: 'CAD', points: [], ratePct: null },
    alt: { symbol: 'BBB', currency: 'CAD', points: [], ratePct: null },
    amountCad: 10000, startMonth: '2025-11', currentMonth: '2026-11', horizonMonth: '2027-11',
  });
  assert.equal(out, null);
});
