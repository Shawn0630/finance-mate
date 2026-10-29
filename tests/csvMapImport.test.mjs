// AI-mapped CSV import: the model maps semantics, the engine
// applies them. All fixtures are synthetic broker shapes that
// deliberately differ from Wealthsimple (different column names,
// Purchase/Sale/Distribution words); no user file appears here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCsv, fingerprintFor, normalizeMapping, applyMappedCsv, proposeCsvMapping,
  wizardToMapping, mappingToWizard, translatePreviewRow, translatePreview,
} from '../src/csvMapImport.js';

const empty = { holdings: [], eventsByHolding: {} };

// Broker shape A: different names, Purchase/Sale/Distribution/Journal.
const A_COLS = ['TxnDate', 'Security', 'SecurityName', 'Action', 'Qty', 'UnitPrice', 'Total', 'Currency'];
const A_MAP = {
  columns: {
    date: 'TxnDate', symbol: 'Security', name: 'SecurityName', activity: 'Action',
    units: 'Qty', price: 'UnitPrice', amount: 'Total', currency: 'Currency',
  },
  values: { Purchase: 'buy', Sale: 'sell', Distribution: 'dividend', Journal: 'skip' },
  defaultCurrency: null,
  symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
};
const aCsv = (...rows) => [A_COLS.join(','), ...rows.map((r) => A_COLS.map((c) => r[c] ?? '').join(','))].join('\n');
const aRow = (date, symbol, name, action, qty, price, total, currency = 'CAD') =>
  ({ TxnDate: date, Security: symbol, SecurityName: name, Action: action, Qty: qty, UnitPrice: price, Total: total, Currency: currency });

test('analyzeCsv reports columns, row count, samples and distinct activity values', () => {
  const s = analyzeCsv(aCsv(aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '100', '50', '-5000')));
  assert.deepEqual(s.columns, A_COLS);
  assert.equal(s.rowCount, 1);
  assert.equal(s.fingerprint, fingerprintFor(A_COLS));
  const action = s.columnStats.find((c) => c.name === 'Action');
  assert.deepEqual(action.distinct, ['Purchase']);
  assert.equal(s.sampleRows.length, 1);
  assert.throws(() => analyzeCsv(''), /empty/);
  assert.throws(() => analyzeCsv('a,,c\n1,2,3'), /column name/);
});

test('fingerprint ignores column order but not the column set', () => {
  assert.equal(fingerprintFor(['b', 'A', 'c']), fingerprintFor(['c', 'b', 'a']));
  assert.notEqual(fingerprintFor(['a', 'b']), fingerprintFor(['a', 'c']));
});

test('normalizeMapping drops unknown columns, invalid targets and bad suffixes', () => {
  const { mapping, error } = normalizeMapping({
    columns: { date: 'TxnDate', symbol: 'Security', activity: 'Action', currency: 'Currency', units: 'Nope', bogus: 'TxnDate' },
    values: { Purchase: 'buy', Sale: 'explode', Distribution: 'dividend' },
    defaultCurrency: 'EUR',
    symbolSuffix: { suffix: 'TO', whenCurrency: 'CAD' },
  }, A_COLS);
  assert.equal(error, undefined);
  assert.equal(mapping.columns.units, undefined);
  assert.equal(mapping.columns.bogus, undefined);
  assert.equal(mapping.values.Sale, undefined);
  assert.equal(mapping.values.Purchase, 'buy');
  assert.equal(mapping.defaultCurrency, null);
  assert.equal(mapping.symbolSuffix, null);
  const noCurrency = normalizeMapping({ columns: { date: 'TxnDate', symbol: 'Security', activity: 'Action' }, values: {} }, A_COLS);
  assert.match(noCurrency.error, /currency/);
});

test('mapped import: buys, negative sells, dividends, skips, suffixing, oversell and unmapped values', () => {
  const r = applyMappedCsv(aCsv(
    aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '100', '50', '-5000'),
    aRow('2026-01-06', 'XQQ', 'XQQ fund', 'Sale', '-40', '60', '2400'),
    aRow('2026-01-07', 'XQQ', 'XQQ fund', 'Distribution', '', '', '12.5'),
    aRow('2026-01-08', 'XQQ', 'XQQ fund', 'Journal', '', '', '1000'),
    aRow('2026-01-09', 'AAPL', 'Apple Inc', 'Purchase', '10', '200', '-2000', 'USD'),
    aRow('2026-01-10', 'XQQ', 'XQQ fund', 'Sale', '9999', '60', '599940'),
    aRow('2026-01-11', 'XQQ', 'XQQ fund', 'Mystery', '5', '10', '-50'),
  ), A_MAP, empty);
  assert.equal(r.holdings.length, 2);
  assert.equal(r.holdings.find((h) => h.label === 'XQQ fund').symbol, 'XQQ.TO');
  assert.equal(r.holdings.find((h) => h.label === 'Apple Inc').symbol, 'AAPL');
  assert.deepEqual(r.events.map((e) => [e.type, e.units, e.price, e.amount]),
    [['buy', 100, 50, null], ['sell', 40, 60, null], ['dividend', null, null, 12.5], ['buy', 10, 200, null]]);
  assert.equal(r.skipped.total, 1);
  assert.equal(r.skipped.byType.Journal, 1);
  assert.equal(r.failed.length, 2);
  assert.ok(r.failed.some((f) => f.reason.includes('cannot sell 9999 units')));
  assert.ok(r.failed.some((f) => f.reason.includes('no mapping for activity value "Mystery"')));
});

test('mapped import: amount-only buy derives its price and flags it', () => {
  const r = applyMappedCsv(aCsv(
    aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '40', '', '-2000'),
  ), A_MAP, empty);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].price, 50);
  assert.equal(r.events[0].priceDerived, true);
});

test('mapped import: duplicates against recorded events are counted, not re-proposed', () => {
  const existing = {
    holdings: [{ id: 7, label: 'XQQ fund', symbol: 'XQQ.TO', currency: 'CAD' }],
    eventsByHolding: { 7: [{ date: '2026-01-05', type: 'buy', units: 100, price: 50, amount: null, split_new: null, split_old: null }] },
  };
  const r = applyMappedCsv(aCsv(
    aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '100', '50', '-5000'),
    aRow('2026-01-06', 'XQQ', 'XQQ fund', 'Purchase', '5', '51', '-255'),
  ), A_MAP, existing);
  assert.equal(r.duplicates, 1);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].holdingId, 7);
});

test('mapped import: split from ratio columns restates later buys', () => {
  const cols = ['TxnDate', 'Security', 'Action', 'Qty', 'UnitPrice', 'Total', 'NewShares', 'OldShares', 'Currency'];
  const map = {
    columns: {
      date: 'TxnDate', symbol: 'Security', activity: 'Action', units: 'Qty',
      price: 'UnitPrice', amount: 'Total', currency: 'Currency', splitNew: 'NewShares', splitOld: 'OldShares',
    },
    values: { Purchase: 'buy', Split: 'split' },
    defaultCurrency: null, symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
  };
  const row = (o) => cols.map((c) => o[c] ?? '').join(',');
  const csv = [cols.join(','), row({ TxnDate: '2026-01-05', Security: 'XQQ', Action: 'Purchase', Qty: '60', UnitPrice: '50', Total: '-3000', Currency: 'CAD' }), row({ TxnDate: '2026-02-01', Security: 'XQQ', Action: 'Split', NewShares: '180', OldShares: '60', Currency: 'CAD' }), row({ TxnDate: '2026-03-05', Security: 'XQQ', Action: 'Purchase', Qty: '10', UnitPrice: '60', Total: '-600', Currency: 'CAD' })].join('\n');
  const r = applyMappedCsv(csv, map, empty);
  const split = r.events.find((e) => e.type === 'split');
  assert.equal(split.splitNew, 180);
  assert.equal(split.splitOld, 60);
  assert.equal(r.failed.length, 0);
  // 60 x 3 + 10 = 190 units in current terms.
  const units = r.events.reduce((acc, e) => acc + (e.type === 'buy' ? e.units * (e.date < '2026-02-01' ? 3 : 1) : 0), 0);
  assert.equal(units, 190);
});

test('mapped import: split from added units derives 3:1, and recorded lots restate through it', () => {
  const map = {
    columns: {
      date: 'TxnDate', symbol: 'Security', activity: 'Action', units: 'Qty',
      price: 'UnitPrice', amount: 'Total', currency: 'Currency', splitAdded: 'Qty',
    },
    values: { Purchase: 'buy', Subdivision: 'split' },
    defaultCurrency: null, symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
  };
  const r = applyMappedCsv(aCsv(
    aRow('2024-01-05', 'XQQ', 'XQQ fund', 'Purchase', '204', '50', '-10200'),
    aRow('2024-08-08', 'XQQ', 'XQQ fund', 'Subdivision', '408', '', ''),
  ), map, empty);
  const split = r.events.find((e) => e.type === 'split');
  assert.equal(split.splitNew, 612);
  assert.equal(split.splitOld, 204);

  // Recorded lots restate: a recorded 100-unit buy plus a CSV
  // subdivision adding 200 (position 100 -> 300, ratio 3) must
  // leave the next subdivision's position at 350, not 300.
  const existing = {
    holdings: [{ id: 9, label: 'XQQ fund', symbol: 'XQQ.TO', currency: 'CAD' }],
    eventsByHolding: { 9: [{ date: '2025-01-05', type: 'buy', units: 100, price: 50, amount: null, split_new: null, split_old: null }] },
  };
  const r2 = applyMappedCsv(aCsv(
    aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Subdivision', '200', '', ''),
    aRow('2026-02-05', 'XQQ', 'XQQ fund', 'Purchase', '50', '60', '-3000'),
    aRow('2026-03-05', 'XQQ', 'XQQ fund', 'Subdivision', '350', '', ''),
  ), map, existing);
  const splits = r2.events.filter((e) => e.type === 'split');
  assert.deepEqual(splits.map((s) => [s.splitNew, s.splitOld]), [[300, 100], [700, 350]]);
  assert.equal(r2.failed.length, 0);
});

test('mapped import: a default currency covers files with no currency column', () => {
  const cols = ['Date', 'Ticker', 'Kind', 'Shares', 'Price'];
  const map = {
    columns: { date: 'Date', symbol: 'Ticker', activity: 'Kind', units: 'Shares', price: 'Price' },
    values: { Bought: 'buy' },
    defaultCurrency: 'CAD', symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
  };
  const csv = [cols.join(','), '2026-01-05,XQQ,Bought,10,50'].join('\n');
  const r = applyMappedCsv(csv, map, empty);
  assert.equal(r.holdings[0].currency, 'CAD');
  assert.equal(r.holdings[0].symbol, 'XQQ.TO');
  assert.throws(() => applyMappedCsv(csv, { ...map, defaultCurrency: null }, empty), /currency/);
});

test('mapped import: missing required columns are a clean error, not a silent partial', () => {
  const bad = { ...A_MAP, columns: { date: 'TxnDate', symbol: 'Security' }, defaultCurrency: 'CAD' };
  assert.throws(() => applyMappedCsv(aCsv(aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '100', '50', '-5000')), bad, empty), /activity/);
});

test('proposeCsvMapping normalizes the model reply and asks about what it missed', async () => {
  const structure = analyzeCsv(aCsv(aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '100', '50', '-5000')));
  const stub = async () => JSON.stringify({
    columns: {
      date: 'TxnDate', symbol: 'Security', name: 'SecurityName', activity: 'Action',
      units: 'Qty', price: 'UnitPrice', amount: 'Total', currency: 'Currency',
    },
    values: { Purchase: 'buy', Sale: 'sell' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: ['Is this a CAD account?'],
    reply: 'Mapped the trade columns.',
  });
  const r = await proposeCsvMapping(structure, { callLlm: stub });
  assert.equal(r.mapping.columns.date, 'TxnDate');
  assert.equal(r.mapping.values.Sale, 'sell');
  assert.deepEqual(r.questions, ['Is this a CAD account?']);

  // A reply that omits a required column keeps the rest and asks.
  const stubPartial = async () => JSON.stringify({
    columns: { date: 'TxnDate', symbol: 'Security' },
    values: { Purchase: 'buy' },
    questions: [],
    reply: '',
  });
  const r2 = await proposeCsvMapping(structure, { callLlm: stubPartial });
  assert.ok(r2.questions.some((q) => q.includes('activity')));
  await assert.rejects(() => proposeCsvMapping(structure, { callLlm: async () => 'not json' }), /not valid JSON/);
});

test('wizardToMapping converts step state to the engine mapping and drops empties', () => {
  const { mapping, error } = wizardToMapping({
    dateCol: 'TxnDate', symbolCol: 'Security', nameCol: '', activityCol: 'Action',
    unitsCol: 'Qty', priceCol: 'UnitPrice', amountCol: 'Total', currencyCol: 'Currency',
    splitAddedCol: '', splitNewCol: '', splitOldCol: '',
    defaultCurrency: null,
    valueTargets: { Purchase: 'buy', Sale: 'explode' },
    symbolSuffix: '.TO', suffixWhenCurrency: 'CAD',
  }, A_COLS);
  assert.equal(error, undefined);
  assert.deepEqual(mapping.columns, {
    date: 'TxnDate', symbol: 'Security', activity: 'Action', units: 'Qty',
    price: 'UnitPrice', amount: 'Total', currency: 'Currency',
  });
  assert.equal(mapping.values.Purchase, 'buy');
  assert.equal(mapping.values.Sale, undefined);
  assert.deepEqual(mapping.symbolSuffix, { suffix: '.TO', whenCurrency: 'CAD' });
  // Unknown columns and a bare suffix without a dot are dropped.
  const bad = wizardToMapping({
    dateCol: 'Nope', symbolCol: 'Security', activityCol: 'Action', unitsCol: 'Qty',
    defaultCurrency: 'CAD', valueTargets: {}, symbolSuffix: 'TO', suffixWhenCurrency: null,
  }, A_COLS);
  assert.equal(bad.mapping.columns.date, undefined);
  assert.equal(bad.mapping.symbolSuffix, null);
  // Round-trip: engine -> wizard -> engine is stable.
  const back = wizardToMapping(mappingToWizard(A_MAP), A_COLS).mapping;
  assert.deepEqual(back, A_MAP);
});

test('translatePreviewRow turns rows into plain-words sentences', () => {
  const m = A_MAP;
  const row = (o) => ({ TxnDate: '', Security: '', SecurityName: '', Action: '', Qty: '', UnitPrice: '', Total: '', Currency: 'CAD', ...o });
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-01-05', Security: 'XQQ', Action: 'Purchase', Qty: '20', UnitPrice: '100.3' }), m),
    '2026-01-05 · Buy · XQQ.TO · 20 units @ $100.30');
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-02-04', Security: 'XQQ', Action: 'Sale', Qty: '-102', UnitPrice: '22.08' }), m),
    '2026-02-04 · Sell · XQQ.TO · 102 units @ $22.08');
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-03-01', Security: 'XQQ', Action: 'Distribution', Total: '8.21' }), m),
    '2026-03-01 · Dividend · XQQ.TO · $8.21');
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-01-12', Security: 'XQQ', Action: 'Journal', Total: '1000' }), m),
    '2026-01-12 · Skipped: Journal');
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-01-05', Security: 'XQQ', Action: 'Mystery', Qty: '5' }), m),
    '2026-01-05 · Unmapped "Mystery" · XQQ.TO');
  // Amount-only buy derives the per-unit price and says so.
  const noPrice = { ...m, columns: { ...m.columns, price: undefined } };
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-01-05', Security: 'XQQ', Action: 'Purchase', Qty: '20', Total: '-2006' }), noPrice),
    '2026-01-05 · Buy · XQQ.TO · 20 units @ $100.30 (derived from total $2,006.00)');
  // Suffix applies only when the currency matches its gate.
  assert.equal(
    translatePreviewRow(row({ TxnDate: '2026-01-05', Security: 'AAPL', Action: 'Purchase', Qty: '10', UnitPrice: '200', Currency: 'USD' }), m),
    '2026-01-05 · Buy · AAPL · 10 units @ $200.00');
  // Missing pieces show as placeholders, never blanks.
  assert.equal(
    translatePreviewRow(row({ Action: 'Purchase' }), m),
    '(no date) · Buy · (no symbol) · (no units) @ (no price)');
  // Split rows: ratio columns, and added-units rows that defer the ratio.
  const ratioMap = { columns: { date: 'TxnDate', symbol: 'Security', activity: 'Action', splitNew: 'SplitNew', splitOld: 'SplitOld' }, values: { Subdivision: 'split' } };
  assert.equal(
    translatePreviewRow({ TxnDate: '2024-08-08', Security: 'XQQ', Action: 'Subdivision', SplitNew: '3', SplitOld: '1' }, ratioMap),
    '2024-08-08 · Split · XQQ · 3:1');
  const addedMap = { columns: { date: 'TxnDate', symbol: 'Security', activity: 'Action', splitAdded: 'Qty' }, values: { Subdivision: 'split' } };
  assert.equal(
    translatePreviewRow({ TxnDate: '2024-08-08', Security: 'XQQ', Action: 'Subdivision', Qty: '408' }, addedMap),
    '2024-08-08 · Split · XQQ · +408 units (ratio derived on apply)');
});

test('translatePreview returns the first five rows in file order', () => {
  const csv = aCsv(
    aRow('2026-01-01', 'XQQ', 'XQQ fund', 'Purchase', '10', '50', '-500'),
    aRow('2026-01-02', 'XQQ', 'XQQ fund', 'Purchase', '10', '50', '-500'),
    aRow('2026-01-03', 'XQQ', 'XQQ fund', 'Purchase', '10', '50', '-500'),
    aRow('2026-01-04', 'XQQ', 'XQQ fund', 'Purchase', '10', '50', '-500'),
    aRow('2026-01-05', 'XQQ', 'XQQ fund', 'Purchase', '10', '50', '-500'),
    aRow('2026-01-06', 'XQQ', 'XQQ fund', 'Sale', '5', '60', '300'),
    aRow('2026-01-07', 'XQQ', 'XQQ fund', 'Sale', '5', '60', '300'),
  );
  const sentences = translatePreview(csv, A_MAP);
  assert.equal(sentences.length, 5);
  assert.ok(sentences[0].startsWith('2026-01-01 · Buy'));
  assert.ok(sentences[4].startsWith('2026-01-05 · Buy'));
});
