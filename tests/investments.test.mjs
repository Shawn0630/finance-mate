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
  validAccountInput, validHoldingInput, validEventInput, validNavInput,
  unitsOn, unitsAvailableForSell, priceOn, fxOn,
  computeHoldingSeries, aggregateComputed, rebuildEventPricePoints, listPricePoints,
} from '../src/investments.js';
import { parseStooqCsv, stooqSymbolFor, parseYahooChart, ensureHoldingPrices } from '../src/prices.js';
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
    { date: '2026-01-05', type: 'buy', units: 10, price: 100, amount: null, note: null });
  assert.equal(validEventInput({ date: '2026-01-05', type: 'grant', units: 5 }).price, null);
  assert.deepEqual(validEventInput({ date: '2026-01-05', type: 'dividend', amount: 42.5 }),
    { date: '2026-01-05', type: 'dividend', units: null, price: null, amount: 42.5, note: null });
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
    units: 20, price: 31.5, amount: null, note: null, conflict: null,
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
