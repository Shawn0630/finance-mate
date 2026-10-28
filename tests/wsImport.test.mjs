// Wealthsimple activities CSV import: the mechanical mapping rules
// (no model involved) — symbol suffixing, negative sells, dividend
// amounts, split-ratio derivation, cash skips, dedup, and the sell
// guard — each pinned against a synthetic fixture. The user's real
// export never appears here; only its column contract does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWealthsimpleCsv, validateImportApply, mapWsSymbol, WS_COLUMNS } from '../src/wsImport.js';

const H = WS_COLUMNS.join(',');
const row = (o) => WS_COLUMNS.map((c) => o[c] ?? '').join(',');
const csv = (...rows) => [H, ...rows.map(row)].join('\n');
const trade = (date, sub, symbol, name, qty, price, currency = 'CAD') =>
  ({ effective_date: date, activity_type: 'Trade', activity_sub_type: sub, symbol, name, currency, quantity: String(qty), unit_price: String(price), net_cash_amount: String(Math.abs(qty) * price * (sub === 'SELL' ? 1 : -1)) });
const div = (date, symbol, name, quantity, amount) =>
  ({ effective_date: date, activity_type: 'Dividend', activity_sub_type: '-', symbol, name, currency: 'CAD', quantity: String(quantity), net_cash_amount: String(amount) });
const splitRow = (date, symbol, name, added) =>
  ({ effective_date: date, activity_type: 'CorporateAction', activity_sub_type: 'SUBDIVISION', symbol, name, currency: '', quantity: String(added) });
const cash = (date, type, sub = 'EFT') =>
  ({ effective_date: date, activity_type: type, activity_sub_type: sub, currency: 'CAD', net_cash_amount: '1000' });
const empty = { holdings: [], eventsByHolding: {} };

test('rejects a file that is not a Wealthsimple activities export', () => {
  assert.throws(() => parseWealthsimpleCsv('date,symbol,amount\n2026-01-01,XQQ,5'), /not a Wealthsimple/);
  assert.throws(() => parseWealthsimpleCsv(''), /empty/);
});

test('bare CAD tickers gain .TO, suffixed and non-CAD tickers are untouched', () => {
  assert.equal(mapWsSymbol('XQQ', 'CAD'), 'XQQ.TO');
  assert.equal(mapWsSymbol('SHOP.TO', 'CAD'), 'SHOP.TO');
  assert.equal(mapWsSymbol('AAPL', 'USD'), 'AAPL');
});

test('BUY and negative SELL map to positive-unit events', () => {
  const r = parseWealthsimpleCsv(csv(
    trade('2026-01-05', 'BUY', 'XQQ', 'XQQ fund', 100, 50),
    trade('2026-01-06', 'SELL', 'XQQ', 'XQQ fund', -40, 60),
  ), empty);
  assert.equal(r.holdings.length, 1);
  assert.equal(r.holdings[0].symbol, 'XQQ.TO');
  assert.deepEqual(r.events.map((e) => [e.type, e.units, e.price]), [['buy', 100, 50], ['sell', 40, 60]]);
  assert.equal(r.failed.length, 0);
});

test('dividend amount comes from net_cash_amount, never the quantity column', () => {
  const r = parseWealthsimpleCsv(csv(div('2026-01-07', 'XQQ', 'XQQ fund', 99, 12.5)), empty);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'dividend');
  assert.equal(r.events[0].amount, 12.5);
  assert.equal(r.events[0].units, null);
});

test('split ratio derives from the running position (204 + 408 = 3:1)', () => {
  const r = parseWealthsimpleCsv(csv(
    trade('2024-01-05', 'BUY', 'XQQ', 'XQQ fund', 204, 50),
    splitRow('2024-08-08', 'XQQ', 'XQQ fund', 408),
    trade('2024-09-05', 'BUY', 'XQQ', 'XQQ fund', 87.7002, 60),
  ), empty);
  const split = r.events.find((e) => e.type === 'split');
  assert.equal(split.splitNew, 612);
  assert.equal(split.splitOld, 204);
});

test('split with no position held fails with a reason instead of guessing', () => {
  // Currency given so the row reaches the position check (a real
  // split row inherits it from the holding's earlier rows).
  const r = parseWealthsimpleCsv(csv({ ...splitRow('2024-08-08', 'XQQ', 'XQQ fund', 408), currency: 'CAD' }), empty);
  assert.equal(r.events.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /no position/);
});

test('split row inherits the holding currency, and a split after a recorded position counts it', () => {
  const existing = {
    holdings: [{ id: 7, label: 'XQQ fund', symbol: 'XQQ.TO', currency: 'CAD' }],
    eventsByHolding: { 7: [{ date: '2021-01-15', type: 'buy', units: 78, price: 100.3, amount: null }] },
  };
  const r = parseWealthsimpleCsv(csv(splitRow('2024-08-08', 'XQQ', 'XQQ fund', 156)), existing);
  const split = r.events.find((e) => e.type === 'split');
  assert.equal(split.splitNew, 234);
  assert.equal(split.splitOld, 78);
  assert.equal(split.holdingId, 7);
});

test('cash rows are counted as skipped, not lost and not proposed', () => {
  const r = parseWealthsimpleCsv(csv(
    cash('2026-01-10', 'MoneyMovement'),
    cash('2026-01-11', 'Interest', '-'),
    cash('2026-01-12', 'Tax', 'NRT'),
    cash('2026-01-13', 'BonusPayment', 'REFER'),
    trade('2026-01-14', 'BUY', 'XQQ', 'XQQ fund', 5, 50),
  ), empty);
  assert.equal(r.skipped.total, 4);
  assert.deepEqual(r.skipped.byType, { MoneyMovement: 1, Interest: 1, Tax: 1, BonusPayment: 1 });
  assert.equal(r.events.length, 1);
});

test('an event already recorded is a duplicate, not a second proposal', () => {
  const existing = {
    holdings: [{ id: 7, label: 'XQQ fund', symbol: 'XQQ.TO', currency: 'CAD' }],
    eventsByHolding: { 7: [{ date: '2026-01-05', type: 'buy', units: 100, price: 50, amount: null }] },
  };
  const r = parseWealthsimpleCsv(csv(trade('2026-01-05', 'BUY', 'XQQ', 'XQQ fund', 100, 50)), existing);
  assert.equal(r.duplicates, 1);
  assert.equal(r.events.length, 0);
  assert.equal(r.holdings.length, 0); // a holding with no surviving events drops out
});

test('a sell past the holding is a failed item with its reason', () => {
  const r = parseWealthsimpleCsv(csv(
    trade('2026-01-05', 'BUY', 'XQQ', 'XQQ fund', 10, 50),
    trade('2026-01-06', 'SELL', 'XQQ', 'XQQ fund', -999, 55),
  ), empty);
  assert.equal(r.events.length, 1); // only the buy survives
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /cannot sell 999 units/);
  assert.match(r.failed[0].reason, /only 10 held/);
});

test('the sell guard restates by later splits: a pre-split sell is judged in current terms', () => {
  const r = parseWealthsimpleCsv(csv(
    trade('2024-01-05', 'BUY', 'XQQ', 'XQQ fund', 60, 50),
    splitRow('2024-08-08', 'XQQ', 'XQQ fund', 120),
    trade('2024-09-05', 'SELL', 'XQQ', 'XQQ fund', -190, 55),
  ), empty);
  // 60 x 3 = 180 current units; selling 190 fails.
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /only 180 held/);
});

test('unknown activity types fail loudly', () => {
  const r = parseWealthsimpleCsv(csv(
    { effective_date: '2026-01-05', activity_type: 'Mystery', activity_sub_type: '-', symbol: 'XQQ', name: 'XQQ fund', currency: 'CAD' },
  ), empty);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /unrecognized activity/);
});

test('validateImportApply: duplicates skip, oversells error, happy path shapes hold', () => {
  const existing = {
    holdings: [{ id: 7, label: 'XQQ fund', symbol: 'XQQ.TO', currency: 'CAD' }],
    eventsByHolding: { 7: [{ date: '2026-01-05', type: 'buy', units: 100, price: 50, amount: null }] },
  };
  const dup = validateImportApply({
    holdings: [],
    events: [{ holdingId: 7, date: '2026-01-05', type: 'buy', units: 100, price: 50 }],
  }, existing);
  assert.equal(dup.events.length, 0);
  assert.equal(dup.skippedDuplicates.length, 1);
  const over = validateImportApply({
    holdings: [{ ref: 'h1', label: 'VFV fund', kind: 'exchange', symbol: 'VFV.TO', fundCode: null, currency: 'CAD' }],
    events: [
      { holdingRef: 'h1', date: '2026-01-05', type: 'buy', units: 10, price: 50 },
      { holdingRef: 'h1', date: '2026-01-06', type: 'sell', units: 999, price: 55 },
    ],
  }, empty);
  assert.match(over.error, /cannot sell 999 units/);
  const ok = validateImportApply({
    holdings: [{ ref: 'h1', label: 'VFV fund', kind: 'exchange', symbol: 'VFV.TO', fundCode: null, currency: 'CAD' }],
    events: [{ holdingRef: 'h1', date: '2026-01-05', type: 'buy', units: 10, price: 50 }],
  }, empty);
  assert.equal(ok.error, undefined);
  assert.equal(ok.holdings[0].symbol, 'VFV.TO');
});
