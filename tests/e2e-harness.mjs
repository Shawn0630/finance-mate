// Shared e2e harness (Phase 1 split): throwaway server + stubbed externals.
// Extracted verbatim from the old tests/e2e.mjs setup (lines 1-399) with
// only these structural changes: stub-mode flags live on `flags`, the
// check() counter is bucketed (own vs setup) with infra detection, the
// server readiness wait moved here, and puppeteer/loginAs are provided.
// App code is untouched; every module boots its own harness (own server,
// own stubs, own temp DATA_DIR).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { simulate as engineSimulate, derivePayment as engineDerive, monthlyRate as engineMonthlyRate, buildSchedule as engineSchedule } from '../src/engine.js';
export async function startHarness() {
const PORT = 19200 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));

// Pre-seed a LEGACY database (single-value `owner` columns — the shape
// from before the multi-owner change) so the startup migration in db.js
// is exercised below: 'Shawn' must become ['Shawn'], the literal 'Joint'
// must become an empty set (it named no concrete people), NULL stays
// empty. All money values are 0 so these rows cannot disturb the summary
// assertions further down.
{
  const legacy = new Database(path.join(dataDir, 'finance.db'));
  legacy.exec(`
    CREATE TABLE properties (
      id INTEGER PRIMARY KEY, address TEXT NOT NULL, photo_url TEXT, photo_file TEXT,
      assessed_value REAL, assessed_year INTEGER, land_value REAL, building_value REAL,
      assessed_source TEXT, assessed_fetched_at TEXT, bca_matched_address TEXT,
      bca_extract_date TEXT, mortgage_balance REAL, mortgage_balance_date TEXT,
      mortgage_payment REAL, amortization_years REAL, notes TEXT, owner TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE other_assets (
      id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'CAD',
      notes TEXT, owner TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE rate_segments (
      id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL,
      start_date TEXT NOT NULL, rate_type TEXT NOT NULL,
      annual_rate REAL NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const ts = new Date().toISOString();
  const insP = legacy.prepare('INSERT INTO properties (address, mortgage_balance, owner, created_at, updated_at) VALUES (?, 0, ?, ?, ?)');
  insP.run('1 Legacy Lane', 'Shawn', ts, ts);
  // A pre-gallery single uploaded photo: the boot migration must fold
  // it into property_photos as this property's first gallery photo.
  legacy.prepare("UPDATE properties SET photo_file = 'legacy-photo.jpg' WHERE address = '1 Legacy Lane'").run();
  insP.run('2 Legacy Lane', 'Joint', ts, ts);
  insP.run('3 Legacy Lane', null, ts, ts);
  legacy.prepare('INSERT INTO other_assets (category, name, value, currency, owner, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run('other', 'Legacy thing', 'CAD', 'Jiaying', ts, ts);
  // An old-shape variable segment (annual_rate NOT NULL, no
  // rate_mode/spread columns): the boot migration must rebuild the
  // table and read this row as an absolute segment, value intact.
  legacy.prepare('INSERT INTO rate_segments (property_id, start_date, rate_type, annual_rate, created_at) VALUES (1, ?, ?, ?, ?)')
    .run('2025-01-01', 'variable', 5, ts);
  legacy.close();
}
const counts = { own: { pass: 0, fail: 0 }, setup: { pass: 0, fail: 0 } };
  let bucket = 'own';
  let infra = false;
  const INFRA_RE = /EPERM|SQLITE_IOERR|IOERR|Navigating frame was detached|Failed to launch the browser|HistoryService|Operation not permitted|Target closed|browser has been closed|Protocol error/;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
    const b = counts[bucket];
    if (cond) b.pass++;
    else {
      b.fail++;
      if (INFRA_RE.test(String(extra)) || INFRA_RE.test(name)) infra = true;
    }
  };
  const noteInfra = (err) => { if (err && INFRA_RE.test(String((err && err.message) || err))) infra = true; };

// Stub BC Assessment site (BCA_BASE_URL points the app at it): serves the
// address-suggestion JSON in the real site's shape, a property page with
// an embedded token + map URL, and the GIS value query. Hit counters let
// the test prove the picked-id path skips the address search.
const stubHits = { search: 0, info: [], xhr: false };
const flags = { bcaDown: false, infoDown: false, prime: 4.95, primeDown: false, hsMode: 'ok', hsLastDetailParams: null };
// Failure mode replicating BC Assessment's live behaviour (Oct 2026):
// its search backend throws — XHR-shaped calls get HTTP 500 with the
// site's JSON error payload, plain requests 302 to an HTML error page.
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>ok</html>'); return;
  }
  if (u.pathname === '/Property/Error/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><title>BC Assessment</title> An error has occured while processing the details of the property.</html>');
    return;
  }
  if (u.pathname === '/Property/Search/GetByAddress') {
    stubHits.search++;
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') stubHits.xhr = true;
    if (flags.bcaDown) {
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'stub-error-id', IsScheduledOutage: false }));
      } else {
        res.writeHead(302, { Location: '/Property/Error/?id=stub-error-id' });
        res.end('<html><head><title>Object moved</title></head></html>');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { label: '1200 GOVERNMENT ST VICTORIA', value: 'QkxPQy0xMjAw', gid: 101 },
      { label: 'No results found', value: 0, gid: 0 }, // junk entry: must be filtered out
    ]));
    return;
  }
  if (u.pathname.startsWith('/Property/Info/')) {
    stubHits.info.push(u.pathname);
    if (flags.infoDown) { res.writeHead(500); res.end('info down'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><script>var gistoken = 'test-token'; var mapserverUrl = 'http://127.0.0.1:${stub.address().port}/gis';</script></html>`);
    return;
  }
  if (u.pathname === '/gis/0/query') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ features: [{ attributes: {
      ADDRESS: '1200 GOVERNMENT ST VICTORIA', TOTAL_ASSESSED: 6532000,
      TOTAL_LAND: 4666000, TOTAL_BUILDING: 1866000, EXTRACT_DATE: '20260323',
      JUR: '01', ROLL: '42',
    } }] }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

// Stub Bank of Canada Valet endpoint (PRIME_API_URL points the app
// at it): serves the real API's shape with a prime value the test
// can move, so the refresh flow is exercised end to end. The served
// history mirrors the real series' change points (5.45 in Dec 2024,
// stepping down through 2025 to 4.45, then the current level the
// refresh tests move), because projections now price every month
// at that month's own prime — the list below is shared with the
// in-test engine comparisons, so both sides price identically.
const stubPrimeHistory = [
  { date: '2024-12-11', rate: 5.95 },
  { date: '2024-12-18', rate: 5.45 },
  { date: '2025-02-05', rate: 5.20 },
  { date: '2025-03-19', rate: 4.95 },
  { date: '2025-09-24', rate: 4.70 },
  { date: '2025-11-05', rate: 4.45 },
  { date: '2026-10-14', rate: 4.70 },
];
const primeStub = http.createServer((req, res) => {
  if (flags.primeDown) { res.writeHead(500); res.end('down'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    seriesDetail: { V80691311: { label: 'Prime rate' } },
    observations: [
      { d: '2026-10-21', V80691311: { v: String(flags.prime) } },
      ...[...stubPrimeHistory].reverse()
        .map((o) => ({ d: o.date, V80691311: { v: String(o.rate) } })),
    ],
  }));
});
await new Promise((r) => primeStub.listen(0, '127.0.0.1', r));
const primeStubBase = `http://127.0.0.1:${primeStub.address().port}/valet`;

// Stub HouseSigma site + API (HOUSESIGMA_BASE_URL points the app at
// it): serves a home page naming a JS bundle, the bundle with an RSA
// public key embedded the way the real bundle stores it (spaces
// instead of newlines), the guest-token endpoint, the address
// suggest endpoint, and the detail endpoint with the REAL encrypted
// request/response form (RSA-OAEP-SHA1 counter + AES-128-CTR +
// gzip), so the app's whole pull chain runs offline and exact.
const hsKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const hsPubSpaced = hsKeys.publicKey.export({ type: 'spki', format: 'pem' }).replace(/\n/g, ' ').trim();
const HS_SECRET = 'e2etestsecret160'; // 16 chars, as the real secret_key
const hsHistoryChristina = [
  { year: 2026, total_int: 1931000, land_int: 1503000, building_int: 428000 },
  { year: 2025, total_int: 2002000, land_int: 1557000, building_int: 445000 },
  { year: 2024, total_int: 1955000, land_int: 1504000, building_int: 451000 },
  { year: 2023, total_int: 1903000, land_int: 1456000, building_int: 447000 },
  { year: 2022, total_int: 1730000, land_int: 1306000, building_int: 424000 },
];
const hsHistoryGovernment = [
  { year: 2026, total_int: 6000000, land_int: 4000000, building_int: 2000000 },
  { year: 2025, total_int: 6100000, land_int: 4050000, building_int: 2050000 },
];
const hsStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://hsstub');
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (flags.hsMode === 'down') { res.writeHead(500); res.end('housesigma down'); return; }
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><script src="/assets/index.test1234.js"></script></head></html>');
    return;
  }
  if (u.pathname === '/assets/index.test1234.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`var cfg={"HS-Client-Version":"7.22.54"};var pem="${hsPubSpaced}";`);
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* leave empty */ }
    if (u.pathname === '/bkv2/api/init/accesstoken/new') {
      sendJson(200, { status: true, data: { access_token: 'e2e-token', secret: { secret_key: HS_SECRET, is_encrypted: 1, created_at: 1, expired_at: 9999999999 } } });
      return;
    }
    if (req.headers.authorization !== 'Bearer e2e-token') {
      sendJson(200, { status: false, error: { code: 920, message: 'access token invalid' } });
      return;
    }
    if (u.pathname === '/bkv2/api/search/address_v2/suggest') {
      const term = String(body.search_term || '');
      // The Douglas fixture belongs to the pull section below; the
      // older sections' Government-Street property must NOT locate
      // here, so its history stays exactly the points they put there.
      const house = term.includes('Christina')
        ? { id_listing: 'HS-LIST-1', id_listing_history_v2: 'HS-ADDR-1', seo_address: '2985-christina-place' }
        : term.includes('Douglas')
          ? { id_listing: 'HS-LIST-2', id_listing_history_v2: 'HS-ADDR-2', seo_address: '1200-douglas-street' }
          : null;
      sendJson(200, { status: true, data: { house_list: house ? [house] : [] }, error: { code: 0, message: '' } });
      return;
    }
    if (u.pathname === '/bkv2/api/listing/info/detail_v2') {
      try {
        const counter = crypto.privateDecrypt(
          { key: hsKeys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
          Buffer.from(body.ctr, 'base64')
        );
        const keyBytes = Buffer.from(HS_SECRET.padEnd(16, '*').slice(0, 16), 'utf8');
        const dec = crypto.createDecipheriv('aes-128-ctr', keyBytes, counter);
        const plain = Buffer.concat([dec.update(Buffer.from(body.et_payload, 'base64')), dec.final()]).toString('utf8');
        flags.hsLastDetailParams = JSON.parse(plain);
        const history = flags.hsLastDetailParams.id_address === 'HS-ADDR-2' ? hsHistoryGovernment : hsHistoryChristina;
        const payload = JSON.stringify({ assessment: { history }, house: { id_listing: flags.hsLastDetailParams.id_listing } });
        const enc = crypto.createCipheriv('aes-128-ctr', keyBytes, counter);
        const encrypted = Buffer.concat([enc.update(zlib.gzipSync(payload)), enc.final()]);
        sendJson(200, { status: true, data: encrypted.toString('base64'), error: { code: 0, message: '' } });
      } catch (e) {
        sendJson(200, { status: false, error: { code: 940, message: 'secret key invalid' } });
      }
      return;
    }
    res.writeHead(404); res.end('not found');
  });
});
await new Promise((r) => hsStub.listen(0, '127.0.0.1', r));
const hsStubBase = `http://127.0.0.1:${hsStub.address().port}`;

// Investments price sources, stubbed the same way: Stooq daily
// CSVs keyed by the s= parameter, and the Bank of Canada Valet
// FXUSDCAD series. Deterministic closes make the three-level
// return math assertable to the cent.
const stooqCsvBySymbol = {
  'xqq.to': [
    'Date,Open,High,Low,Close,Volume',
    '2026-01-02,137,139,136,138,1000',
    '2026-01-30,139,141,138,140,1000',
    '2026-02-02,148,150,147,149,1000',
    '2026-02-27,149,151,148,150,1000',
    '2026-03-02,159,161,158,160,1000',
    '2026-03-20,164,166,163,165,1000',
  ].join('\n'),
  'aapl.us': [
    'Date,Open,High,Low,Close,Volume',
    '2026-01-02,197,199,196,198,1000',
    '2026-01-30,199,201,198,200,1000',
    '2026-02-02,207,209,206,208,1000',
    '2026-02-27,209,211,208,210,1000',
    '2026-03-02,219,221,218,220,1000',
  ].join('\n'),
  // New-symbol sink pin: AMZN has no holding in the fixture, so its
  // current price comes from the tiers — the stub makes it 266.03.
  // The 2025-11 point is what gives the buy target a usable 1y
  // history rate (2025-11 $200 → 2026-10 $266.03 = 33.02%/yr after
  // the engine's round4): without a point a year back, the 1y
  // window has no start and the buy stays flat.
  'amzn.us': [
    'Date,Open,High,Low,Close,Volume',
    '2025-11-28,199,201,198,200,1000',
    '2026-01-02,197,199,196,198,1000',
    '2026-01-30,199,201,198,200,1000',
    '2026-10-30,264,267,263,266.03,1000',
  ].join('\n'),
  // Second non-held symbol (user 2026-11-07): the buy-target pull
  // is generic, so the fixture pins a second symbol too — MSFT at
  // a 50% 1y rate (2025-11 $100 → 2026-10 $150).
  'msft.us': [
    'Date,Open,High,Low,Close,Volume',
    '2025-11-28,99,101,98,100,1000',
    '2026-01-02,104,106,103,105,1000',
    '2026-01-30,104,106,103,105,1000',
    '2026-10-30,149,151,148,150,1000',
  ].join('\n'),
};
const stooqStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const sym = String(u.searchParams.get('s') || '').toLowerCase();
  res.writeHead(200, { 'Content-Type': 'text/csv' });
  res.end(stooqCsvBySymbol[sym] || 'No data');
});
await new Promise((r) => stooqStub.listen(0, '127.0.0.1', r));
const stooqStubBase = `http://127.0.0.1:${stooqStub.address().port}/q/d/l/`;
const fxStub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    observations: [
      { d: '2026-01-01', FXUSDCAD: { v: '1.3000' } },
      { d: '2026-02-01', FXUSDCAD: { v: '1.4000' } },
    ],
  }));
});
await new Promise((r) => fxStub.listen(0, '127.0.0.1', r));
const fxStubBase = `http://127.0.0.1:${fxStub.address().port}/valet/observations`;
// Yahoo Finance chart API stub — the fallback tier. Only
// HXQ.TO has data here (Stooq returns "No data" for it), which
// is exactly the TSX-gap scenario the fallback exists for;
// every other symbol 404s like Yahoo does for unknown tickers.
const yahooDay = (y, m, d) => Date.UTC(y, m, d) / 1000;
const yahooStub = http.createServer((req, res) => {
  // The v1/finance/search endpoint behind the Add Holding
  // autocomplete (the app derives its URL from YAHOO_BASE_URL's
  // origin, so it lands on this same stub): "XQQ" returns a TSX
  // and a NASDAQ candidate; "FAIL" simulates an upstream outage;
  // anything else finds nothing.
  const su = new URL(req.url, 'http://x');
  if (su.pathname === '/v1/finance/search') {
    const q = (su.searchParams.get('q') || '').toUpperCase();
    if (q.includes('FAIL')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('search unavailable');
      return;
    }
    const quotes = (q.includes('XQQ') || q.includes('ISHARES')) ? [
      { symbol: 'XQQ.TO', shortname: 'ISHARES NASDAQ 100 INDEX ETF', longname: 'iShares NASDAQ 100 Index ETF', exchange: 'TOR', exchDisp: 'Toronto', quoteType: 'ETF' },
      { symbol: 'QQQ', shortname: 'Invesco QQQ Trust', exchange: 'NMS', exchDisp: 'NASDAQ', quoteType: 'ETF' },
    ] : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ quotes }));
    return;
  }
  if (decodeURIComponent(req.url).includes('HXQ.TO')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      chart: {
        result: [{
          timestamp: [yahooDay(2026, 0, 2), yahooDay(2026, 0, 30), yahooDay(2026, 1, 27), yahooDay(2026, 2, 2)],
          indicators: { quote: [{ close: [59, 61, 62, 63] }] },
        }],
        error: null,
      },
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }));
});
await new Promise((r) => yahooStub.listen(0, '127.0.0.1', r));
const yahooStubBase = `http://127.0.0.1:${yahooStub.address().port}/v8/finance/chart/`;

// Nasdaq historical-data stub — the third price tier. Only
// NTEST has rows here (Stooq returns "No data" for it and the
// Yahoo stub 404s it), which is exactly the both-tiers-empty
// scenario the tier exists for; every other symbol 404s.
const nasdaqStub = http.createServer((req, res) => {
  const su = new URL(req.url, 'http://x');
  const parts = su.pathname.split('/').filter(Boolean);
  const sym = (parts[parts.length - 2] || '').toUpperCase();
  if (sym === 'NTEST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        symbol: 'NTEST',
        totalRecords: 2,
        tradesTable: {
          rows: [
            { date: '02/02/2026', close: '$55.00', volume: '1,000', open: '$54.00', high: '$56.00', low: '$53.00' },
            { date: '01/02/2026', close: '$50.00', volume: '2,000', open: '$49.00', high: '$51.00', low: '$48.00' },
          ],
        },
      },
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: null, message: 'No data found' }));
});
await new Promise((r) => nasdaqStub.listen(0, '127.0.0.1', r));
const nasdaqStubBase = `http://127.0.0.1:${nasdaqStub.address().port}/api/quote/`;

// AI Fill test seam: the app reads LLM_STUB_RESPONSE_FILE on
// every extraction, so the suite points it at a file it rewrites
// per case — no real key, no network.
const aiStubFile = path.join(dataDir, 'ai-stub.json');
fs.writeFileSync(aiStubFile, JSON.stringify({ fields: {} }));

const server = spawn('node', ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), BCA_BASE_URL: stubBase, PRIME_API_URL: primeStubBase, HOUSESIGMA_BASE_URL: hsStubBase, STOOQ_BASE_URL: stooqStubBase, FX_API_URL: fxStubBase, YAHOO_BASE_URL: yahooStubBase, NASDAQ_BASE_URL: nasdaqStubBase, LLM_STUB_RESPONSE_FILE: aiStubFile, LLM_MODELS: 'stub-a,stub-b', LLM_MODEL: 'stub-a' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

let cookie = '';
async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

  // Puppeteer for the browser blocks (same probe-Chrome dance as the old suite).
  let puppeteer = null;
  try {
    const { createRequire } = await import('node:module');
    const reqmod = createRequire(import.meta.url);
    try { puppeteer = reqmod('puppeteer-core'); } catch { puppeteer = reqmod('/tmp/pptr/node_modules/puppeteer-core'); }
  } catch { puppeteer = null; }
  const chromeAvailable = !!puppeteer && fs.existsSync('/opt/meta-chromium/chrome');
  const loginAs = async (username, password) => {
    const res = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.headers.get('set-cookie').split(';')[0];
  };
  // Modules other than core assume a logged-in admin session (in the old
  // suite core logged in first and the cookie carried over). Core itself
  // must NOT pre-login: its opening checks assert unauthenticated 401s.
  const ensureLogin = async () => {
    const r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
    if (r.status !== 200 || !r.data.ok) throw new Error(`ensureLogin failed: ${r.status} ${JSON.stringify(r.data)}`);
  };
  // Wait for the main server (modules assume it is up; core still records
  // its own 'server starts' check).
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/summary'); if (r.status === 401) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const close = async () => {
    try { server.kill('SIGTERM'); } catch {}
    for (const s of [stub, primeStub, hsStub, stooqStub, fxStub, yahooStub, nasdaqStub]) {
      try { s.close(); } catch {}
    }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };
  return {
    BASE, PORT, dataDir, aiStubFile, server,
    stubs: { bca: stub, prime: primeStub, hs: hsStub, stooq: stooqStub, fx: fxStub, yahoo: yahooStub, nasdaq: nasdaqStub },
    stubHits, stubPrimeHistory, hsHistoryChristina, hsHistoryGovernment,
    stubBases: { bca: stubBase, prime: primeStubBase, hs: hsStubBase, stooq: stooqStubBase, fx: fxStubBase, yahoo: yahooStubBase, nasdaq: nasdaqStubBase },
    flags, req, check, loginAs, ensureLogin, puppeteer, chromeAvailable, spawn,
    getCookie: () => cookie,
    clearCookie: () => { cookie = ''; },
    setBucket: (b) => { bucket = b; },
    counts: () => ({ own: { ...counts.own }, setup: { ...counts.setup } }),
    infraDetected: () => infra,
    noteInfra,
    close,
  };
}
