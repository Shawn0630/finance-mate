// HTTP end-to-end test against a throwaway database.
//   node tests/e2e.mjs
// Spawns the server with a temp DATA_DIR, then checks: unauthenticated 401,
// admin/admin login, property CRUD, rate segment CRUD, amortization numbers
// (same hand-computed fixture as the engine tests), other-asset CRUD, the
// summary arithmetic, and 401 again after logout.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { simulate as engineSimulate, derivePayment as engineDerive, monthlyRate as engineMonthlyRate, buildSchedule as engineSchedule } from '../src/engine.js';

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
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// Stub BC Assessment site (BCA_BASE_URL points the app at it): serves the
// address-suggestion JSON in the real site's shape, a property page with
// an embedded token + map URL, and the GIS value query. Hit counters let
// the test prove the picked-id path skips the address search.
const stubHits = { search: 0, info: [], xhr: false };
// Failure mode replicating BC Assessment's live behaviour (Oct 2026):
// its search backend throws — XHR-shaped calls get HTTP 500 with the
// site's JSON error payload, plain requests 302 to an HTML error page.
let stubBcaDown = false;
let stubInfoDown = false;
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
    if (stubBcaDown) {
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
    if (stubInfoDown) { res.writeHead(500); res.end('info down'); return; }
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
let stubPrime = 4.95;
let stubDown = false;
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
  if (stubDown) { res.writeHead(500); res.end('down'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    seriesDetail: { V80691311: { label: 'Prime rate' } },
    observations: [
      { d: '2026-10-21', V80691311: { v: String(stubPrime) } },
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
let hsMode = 'ok'; // 'ok' | 'down'
let hsLastDetailParams = null;
const hsStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://hsstub');
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (hsMode === 'down') { res.writeHead(500); res.end('housesigma down'); return; }
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
        hsLastDetailParams = JSON.parse(plain);
        const history = hsLastDetailParams.id_address === 'HS-ADDR-2' ? hsHistoryGovernment : hsHistoryChristina;
        const payload = JSON.stringify({ assessment: { history }, house: { id_listing: hsLastDetailParams.id_listing } });
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

// AI Fill test seam: the app reads LLM_STUB_RESPONSE_FILE on
// every extraction, so the suite points it at a file it rewrites
// per case — no real key, no network.
const aiStubFile = path.join(dataDir, 'ai-stub.json');
fs.writeFileSync(aiStubFile, JSON.stringify({ fields: {} }));

const server = spawn('node', ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), BCA_BASE_URL: stubBase, PRIME_API_URL: primeStubBase, HOUSESIGMA_BASE_URL: hsStubBase, LLM_STUB_RESPONSE_FILE: aiStubFile, LLM_MODELS: 'stub-a,stub-b', LLM_MODEL: 'stub-a' },
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

try {
  // Wait for the server to come up.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(BASE + '/api/summary'); up = r.status === 401; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server starts, unauthenticated /api/summary is 401', up);

  let r = await req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government'));
  check('unauthenticated /api/address/suggest is 401', r.status === 401);

  r = await req('POST', '/api/login', { username: 'admin', password: 'wrong' });
  check('wrong password rejected', r.status === 401);
  r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  check('admin/admin login succeeds', r.status === 200 && r.data.ok === true);

  // Seeded household users (idempotent seeds in db.js). /api/users
  // lists the owner candidates with their avatars: every user EXCEPT
  // admin.
  r = await req('GET', '/api/users');
  const candidateNames = (r.data || []).map((u) => u.username);
  check('owner candidates are Shawn + Jiaying (admin not offered)',
    candidateNames.includes('Shawn') && candidateNames.includes('Jiaying') && !candidateNames.includes('admin'),
    JSON.stringify(r.data));

  // Legacy-owner migration (the pre-seeded DB above): a single stored
  // owner became a one-element set; the literal 'Joint' became an empty
  // set; NULL stayed empty.
  r = await req('GET', '/api/properties');
  const legacyProps = Object.fromEntries((r.data || []).map((p) => [p.address, p.owners]));
  check('legacy single owner migrated to a one-element set',
    JSON.stringify(legacyProps['1 Legacy Lane']) === '["Shawn"]', JSON.stringify(legacyProps));
  check('legacy Joint owner migrated to an empty set',
    JSON.stringify(legacyProps['2 Legacy Lane']) === '[]');
  check('legacy NULL owner migrated to an empty set',
    JSON.stringify(legacyProps['3 Legacy Lane']) === '[]');
  r = await req('GET', '/api/assets');
  const legacyAsset = (r.data || []).find((a) => a.name === 'Legacy thing');
  check('legacy asset owner migrated to a one-element set',
    !!legacyAsset && JSON.stringify(legacyAsset.owners) === '["Jiaying"]');
  r = await req('POST', '/api/login', { username: 'Shawn', password: 'wrong' });
  check('Shawn wrong password rejected', r.status === 401);
  r = await req('POST', '/api/login', { username: 'Shawn', password: 'Shawn' });
  check('Shawn/Shawn login succeeds', r.status === 200 && r.data.username === 'Shawn');
  r = await req('POST', '/api/login', { username: 'Jiaying', password: 'Jiaying' });
  check('Jiaying/Jiaying login succeeds', r.status === 200 && r.data.username === 'Jiaying');

  // Address suggestions come from the (stubbed) BC Assessment search:
  // the junk "No results" entry must be filtered out.
  r = await req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government Street, Victoria, BC'));
  const sug = r.data.suggestions || [];
  check('suggest returns one real suggestion', r.status === 200 && sug.length === 1, JSON.stringify(sug));
  check('suggest maps id + label', sug.length === 1 && sug[0].id === 'QkxPQy0xMjAw' && sug[0].label === '1200 GOVERNMENT ST VICTORIA');
  const searchBeforeShort = stubHits.search;
  r = await req('GET', '/api/address/suggest?q=ab');
  check('short query returns no suggestions', Array.isArray(r.data.suggestions) && r.data.suggestions.length === 0);
  check('short query does not hit BC Assessment', stubHits.search === searchBeforeShort);

  // Outage shape (the live Oct 2026 failure): BC Assessment's search
  // backend 500s. The endpoint must surface sourceError with a readable
  // note — never a raw JSON parse error — and the app must ask the way
  // the site's own JS does (X-Requested-With), which the stub records.
  stubBcaDown = true;
  r = await req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government'));
  check('suggest outage -> sourceError flagged', r.status === 200 && r.data.sourceError === true, JSON.stringify(r.data).slice(0, 200));
  check('suggest outage -> empty suggestions', Array.isArray(r.data.suggestions) && r.data.suggestions.length === 0);
  check('suggest outage -> clean note, no parse noise',
    typeof r.data.note === 'string' && /HTTP 500/.test(r.data.note) && !/Unexpected token|not valid JSON/.test(r.data.note),
    String(r.data.note));
  check('app asks like the site own JS (X-Requested-With)', stubHits.xhr === true);
  stubBcaDown = false;
  r = await req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government'));
  check('suggest recovers when BC Assessment is back', (r.data.suggestions || []).length === 1 && !r.data.sourceError);

  // The outage note element exists in BOTH address forms and the
  // frontend shows it when the endpoint reports sourceError.
  const pageRes = await fetch(BASE + '/', { headers: { Cookie: cookie } });
  const pageHtml = await pageRes.text();
  check('both address forms carry the suggest-unavailable note', (pageHtml.match(/suggest-note/g) || []).length >= 2);
  const jsRes = await fetch(BASE + '/app.js', { headers: { Cookie: cookie } });
  const jsText = await jsRes.text();
  check('address suggest UI reacts to sourceError', jsText.includes('sourceError') && jsText.includes('suggest-note'));

  // Property CRUD (fictional address and numbers only).
  r = await req('POST', '/api/properties', {
    address: '1234 Example Street, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  check('create property', r.status === 201 && r.data.id > 0);
  const pid = r.data.id;

  r = await req('POST', `/api/properties/${pid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  check('add rate segment', r.status === 201);
  const segId = r.data.id;
  r = await req('PUT', `/api/properties/${pid}/rates/${segId}`, { annual_rate: 5.0 });
  check('edit rate segment', r.status === 200 && r.data.annual_rate === 5);

  // Amortization must match the engine / hand calculation: the
  // payment is the calculated one — derivePayment($100,000, 5%,
  // 25y) = $581.60 — so month 1 interest is $412.39 and the
  // balance $99,830.79 (see tests/engine.test.mjs).
  r = await req('GET', `/api/properties/${pid}/amortization`);
  const s0 = r.data.series && r.data.series[0];
  check('amortization ok', r.data.ok === true && !!s0);
  check('month 1 interest = 412.39', s0 && Math.abs(s0.interest - 412.39) <= 0.02, s0 && String(s0.interest));
  check('month 1 balance = 99830.79', s0 && Math.abs(s0.balance - 99830.79) <= 0.02, s0 && String(s0.balance));
  check('the payment is calculated (581.60) and carries no source field',
    r.data.paymentUsed === 581.60 && !('paymentSource' in r.data),
    JSON.stringify({ used: r.data.paymentUsed, src: r.data.paymentSource }));

  // Manual assessed value, then the summary arithmetic.
  r = await req('PUT', `/api/properties/${pid}`, { assessed_value: 800000 });
  check('set manual assessed value', r.status === 200 && r.data.assessed_source === 'manual');
  r = await req('POST', '/api/assets', { category: 'stocks', name: 'Test ETF', value: 5000, currency: 'CAD' });
  check('add other asset', r.status === 201);
  const aid = r.data.id;
  r = await req('GET', `/api/assets/${aid}`);
  check('get single asset (detail view source)', r.status === 200 && r.data.name === 'Test ETF' && r.data.category === 'stocks');
  r = await req('GET', '/api/assets/999999');
  check('get missing asset is 404', r.status === 404);
  r = await req('GET', '/api/summary');
  check('summary property value = 800000', r.data.propertyValue === 800000, JSON.stringify(r.data));
  check('summary mortgage = 100000', r.data.mortgageBalance === 100000);
  check('summary other assets = 5000', r.data.otherAssets === 5000);
  check('summary net worth = 705000', r.data.netWorth === 705000, String(r.data.netWorth));
  r = await req('DELETE', `/api/assets/${aid}`);
  check('delete other asset', r.status === 200);
  r = await req('GET', '/api/summary');
  check('summary other assets back to 0', r.data.otherAssets === 0);

  // Equity endpoint: no history points on pid, so the stored manual
  // assessed value is the latest value: 800000 - 100000 = 700000.
  r = await req('GET', `/api/properties/${pid}/equity`);
  check('equity uses stored assessed value when no history',
    r.data.assessedValue === 800000 && r.data.balance === 100000 && r.data.equity === 700000,
    JSON.stringify(r.data));

  // A property created from a picked suggestion stores the BC Assessment
  // property id; fetching its value then goes straight to the property
  // page (no new address search) and returns the stubbed GIS values.
  r = await req('POST', '/api/properties', { address: '1200 Government St, Victoria', bca_id: 'QkxPQy0xMjAw', mortgage_balance: 500000, purchase_date: '2018-07-01' });
  check('create property with picked bca_id', r.status === 201 && r.data.bca_id === 'QkxPQy0xMjAw');
  const pid2 = r.data.id;
  const searchBeforeFetch = stubHits.search;
  r = await req('POST', `/api/properties/${pid2}/fetch-bca`);
  check('fetch-bca via picked id succeeds', r.data.ok === true && r.data.result && r.data.result.assessedValue === 6532000, JSON.stringify(r.data).slice(0, 200));
  check('fetch-bca via picked id skipped the address search', stubHits.search === searchBeforeFetch);
  check('fetch-bca via picked id opened the picked property page', stubHits.info.includes('/Property/Info/QkxPQy0xMjAw'));
  // Editing the address back to free text clears the stored id.
  r = await req('PUT', `/api/properties/${pid2}`, { address: '999 Somewhere Else', bca_id: null });
  check('editing address to free text clears bca_id', r.status === 200 && r.data.bca_id === null);

  // The fuzzy assessment fetch shares the address search: with BC
  // Assessment's backend down it must fail at the "address search"
  // stage with the same readable error, not a JSON parse error, and
  // leave the stored values untouched.
  stubBcaDown = true;
  r = await req('POST', `/api/properties/${pid2}/fetch-bca`);
  check('fetch-bca outage -> ok:false at address search stage',
    r.data.ok === false && r.data.stage === 'address search', JSON.stringify(r.data).slice(0, 200));
  check('fetch-bca outage -> clean error, no parse noise',
    typeof r.data.error === 'string' && /HTTP 500/.test(r.data.error) && !/Unexpected token|not valid JSON/.test(r.data.error),
    String(r.data.error));
  stubBcaDown = false;

  // Owners are a SET of people: joint ownership is picking several
  // names. admin is never a candidate; unknown names and the literal
  // 'Joint' are rejected; an empty selection is allowed.
  r = await req('POST', '/api/properties', { address: '1 Owner Way', owners: ['Shawn', 'Jiaying'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  check('property can have two owners (co-ownership)', r.status === 201 && JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]', JSON.stringify(r.data.owners));
  const pidOwn = r.data.id;
  r = await req('GET', `/api/properties/${pidOwn}`);
  check('two owners persisted', JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]');
  r = await req('PUT', `/api/properties/${pidOwn}`, { owners: ['Jiaying'] });
  check('property owners can be reduced to one', r.status === 200 && JSON.stringify(r.data.owners) === '["Jiaying"]');
  r = await req('PUT', `/api/properties/${pidOwn}`, { owners: [] });
  check('property owners can be cleared', r.status === 200 && JSON.stringify(r.data.owners) === '[]');
  r = await req('POST', '/api/properties', { address: '2 Owner Way', owners: ['Nobody'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  check('property with unknown owner rejected', r.status === 400);
  r = await req('POST', '/api/properties', { address: '2 Owner Way', owners: ['Shawn', 'Nobody'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  check('one bad name poisons the whole owners list', r.status === 400);
  r = await req('POST', '/api/properties', { address: '2 Owner Way', owners: ['admin'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  check('admin as property owner rejected', r.status === 400 && String(r.data.error || '').includes('admin'), JSON.stringify(r.data));
  r = await req('POST', '/api/properties', { address: '2 Owner Way', owners: ['Joint'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  check('literal Joint as property owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await req('POST', '/api/assets', { category: 'other', name: 'Co-owned thing', owners: ['Shawn', 'Jiaying'] });
  check('other asset can have two owners', r.status === 201 && JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]', JSON.stringify(r.data.owners));
  const aidOwn = r.data.id;
  r = await req('POST', '/api/assets', { category: 'other', name: 'Joint test', owners: ['Joint'] });
  check('other asset with Joint owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await req('POST', '/api/assets', { category: 'other', name: 'Admin test', owners: ['admin'] });
  check('other asset with admin owner rejected', r.status === 400);
  r = await req('PUT', `/api/assets/${aidOwn}`, { owners: ['Shawn'] });
  check('asset owners updated via PUT', r.status === 200 && JSON.stringify(r.data.owners) === '["Shawn"]');
  r = await req('DELETE', `/api/properties/${pidOwn}`);
  r = await req('DELETE', `/api/assets/${aidOwn}`);
  check('owner fixtures cleaned up', r.status === 200);

  // Value history: the stub fetch above already recorded the 2026 auto
  // point for pid2; manual points fill the earlier years.
  r = await req('GET', `/api/properties/${pid2}/value-history`);
  check('fetch recorded one auto history point (2026)',
    r.data.points && r.data.points.length === 1 && r.data.points[0].year === 2026
      && r.data.points[0].source === 'auto' && r.data.points[0].value === 6532000,
    JSON.stringify(r.data.points || []));
  r = await req('POST', `/api/properties/${pid2}/value-history`, { year: 2024, value: 5900000 });
  check('manual history point 2024 added', r.status === 201 && r.data.points.length === 2);
  r = await req('POST', `/api/properties/${pid2}/value-history`, { year: 2025, value: 6100000 });
  const ch = r.data.change || {};
  check('three history points sorted by year', r.data.points.length === 3 && r.data.points.map((p) => p.year).join(',') === '2024,2025,2026');
  check('trend change abs = +632000 (2024 -> 2026)', ch.abs === 632000, JSON.stringify(ch));
  check('trend change pct ~ +10.71%', typeof ch.pct === 'number' && Math.abs(ch.pct - 10.7119) < 0.01, String(ch.pct));
  const pt2025 = r.data.points.find((p) => p.year === 2025);
  r = await req('PUT', `/api/properties/${pid2}/value-history/${pt2025.id}`, { value: 6150000 });
  check('history point edited', r.status === 200 && r.data.points.find((p) => p.year === 2025).value === 6150000);
  r = await req('POST', `/api/properties/${pid2}/fetch-bca`);
  check('re-fetch does not duplicate the 2026 point', r.data.ok === true);
  r = await req('GET', `/api/properties/${pid2}/value-history`);
  check('still three points after re-fetch', r.data.points.length === 3, JSON.stringify(r.data.points.map((p) => p.year)));
  const pt2024 = r.data.points.find((p) => p.year === 2024);
  r = await req('DELETE', `/api/properties/${pid2}/value-history/${pt2024.id}`);
  check('history point deleted, change now starts 2025', r.data.points.length === 2 && r.data.change && r.data.change.fromYear === 2025);

  // Equity with history: the newest history point (2026, 6532000) is the
  // latest assessed value; 6532000 - 900000 = 5632000.
  r = await req('PUT', `/api/properties/${pid2}`, { mortgage_balance: 900000 });
  check('set balance on pid2 for equity', r.status === 200);
  r = await req('GET', `/api/properties/${pid2}/equity`);
  check('equity uses newest history point',
    r.data.assessedValue === 6532000 && r.data.assessedYear === 2026 && r.data.balance === 900000 && r.data.equity === 5632000,
    JSON.stringify(r.data));

  // Rate-plan chain: a property with a balance but NO rate
  // segments gets no projection at all (never a hidden default rate);
  // adding a segment produces numbers that follow that segment, and
  // editing the segment's rate changes the numbers.
  r = await req('POST', '/api/properties', {
    address: '9 Rateplan Road, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2019-11-05',
  });
  check('create rate-plan chain property', r.status === 201);
  const pid3 = r.data.id;
  r = await req('GET', `/api/properties/${pid3}/amortization`);
  check('no rate plan -> NO_RATE_PLAN and no series',
    r.data.ok === false && r.data.code === 'NO_RATE_PLAN' && !r.data.series,
    JSON.stringify(r.data).slice(0, 160));
  r = await req('POST', `/api/properties/${pid3}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  check('add first rate segment', r.status === 201);
  const seg3 = r.data.id;
  r = await req('GET', `/api/properties/${pid3}/amortization`);
  check('projection appears with the segment',
    r.data.ok === true && Math.abs(r.data.series[0].interest - 412.39) <= 0.02,
    r.data.series && String(r.data.series[0].interest));
  check('amortization carries balance + balanceDate for chart A',
    r.data.balance === 100000 && r.data.balanceDate === '2026-10-01');
  r = await req('PUT', `/api/properties/${pid3}/rates/${seg3}`, { annual_rate: 6 });
  check('edit segment rate', r.status === 200 && r.data.annual_rate === 6);
  r = await req('GET', `/api/properties/${pid3}/amortization`);
  check('projection follows the edited rate (6% -> 493.86)',
    r.data.ok === true && Math.abs(r.data.series[0].interest - 493.86) <= 0.02,
    r.data.series && String(r.data.series[0].interest));
  r = await req('DELETE', `/api/properties/${pid3}`);
  check('delete rate-plan chain property', r.status === 200);

  // Slim add: only address + owner + outstanding principal + purchase
  // date. The balance date defaults to today (current-balance
  // semantics); payment and amortization stay empty for the detail page
  // to fill in, and with no rate plan yet the projection is the
  // NO_RATE_PLAN prompt state. Purchase date is required at add time
  // (the column itself stays nullable for older rows).
  // The outstanding principal itself is OPTIONAL: a request with
  // no balance at all is rejected only for the still-missing
  // purchase date, never for the principal.
  r = await req('POST', '/api/properties', { address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'] });
  check('add without balance is not rejected for the principal (the missing purchase date is what blocks it)',
    r.status === 400 && String(r.data.error || '') === 'purchase date is required', JSON.stringify(r.data));
  r = await req('POST', '/api/properties', {
    address: '8 No Principal Lane, Victoria, BC', owners: ['Shawn'], purchase_date: '2021-05-14',
  });
  check('add without balance succeeds: no anchor, no balance date, Term 1 opens empty',
    r.status === 201 && r.data.mortgage_balance === null && r.data.mortgage_balance_date === null
      && r.data.terms[0].opening_balance === null,
    JSON.stringify({ b: r.data.mortgage_balance, bd: r.data.mortgage_balance_date, open: r.data.terms[0] && r.data.terms[0].opening_balance }));
  const pidNoBal = r.data.id;
  r = await req('POST', '/api/properties', {
    address: '9 Date Only Lane, Victoria, BC', purchase_date: '2021-05-14', mortgage_balance_date: '2020-01-01',
  });
  check('a balance date on its own seeds no anchor (balance and date both stay null)',
    r.status === 201 && r.data.mortgage_balance === null && r.data.mortgage_balance_date === null,
    JSON.stringify({ b: r.data.mortgage_balance, bd: r.data.mortgage_balance_date }));
  const pidDateOnly = r.data.id;
  r = await req('POST', '/api/properties', {
    address: '10 Negative Lane, Victoria, BC', purchase_date: '2021-05-14', mortgage_balance: -5,
  });
  check('a negative principal is still rejected', r.status === 400 && String(r.data.error || '').includes('principal'), JSON.stringify(r.data));
  r = await req('GET', `/api/properties/${pidNoBal}/amortization`);
  check('a balance-less property reports no outstanding principal (a named state, not a crash)',
    r.data.ok === false && String(r.data.error || '').includes('no outstanding principal'), JSON.stringify(r.data).slice(0, 160));
  await req('DELETE', `/api/properties/${pidDateOnly}`);
  r = await req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'], mortgage_balance: 123456,
  });
  check('add without purchase date rejected', r.status === 400 && String(r.data.error || '') === 'purchase date is required', JSON.stringify(r.data));
  r = await req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'], mortgage_balance: 123456, purchase_date: '2021-13-40',
  });
  check('add with impossible purchase date rejected', r.status === 400 && String(r.data.error || '').includes('valid date'), JSON.stringify(r.data));
  r = await req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'], mortgage_balance: 123456, purchase_date: '2021-05-14',
  });
  const today = new Date().toISOString().slice(0, 10);
  check('slim add (4 fields) creates the property', r.status === 201 && r.data.mortgage_balance === 123456, JSON.stringify(r.data).slice(0, 160));
  check('purchase date stored', r.data.purchase_date === '2021-05-14', String(r.data.purchase_date));
  check('balance date defaults to today (not the purchase date)', r.data.mortgage_balance_date === today, String(r.data.mortgage_balance_date));
  check('payment/amortization left empty at add', (r.data.mortgage_payment ?? null) === null && (r.data.amortization_years ?? null) === null);
  const pidSlim = r.data.id;
  r = await req('PUT', `/api/properties/${pidSlim}`, { purchase_date: '2022-08-30' });
  check('purchase date changed on the detail side', r.status === 200 && r.data.purchase_date === '2022-08-30');
  r = await req('GET', `/api/properties/${pidSlim}`);
  check('purchase date change persisted', r.data.purchase_date === '2022-08-30');
  r = await req('GET', `/api/properties/${pidSlim}/amortization`);
  check('slim-added property sits in NO_RATE_PLAN state', r.data.ok === false && r.data.code === 'NO_RATE_PLAN');
  r = await req('DELETE', `/api/properties/${pidSlim}`);
  check('delete slim property', r.status === 200);

  // Payment day (deduction day): anchors the projection's monthly node
  // dates only — the interest amounts must not move when it changes.
  r = await req('POST', '/api/properties', {
    address: '24 Payday Place, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-24', amortization_years: 25,
    purchase_date: '2020-01-01',
  });
  const pidPay = r.data.id;
  await req('POST', `/api/properties/${pidPay}/rates`, {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  r = await req('GET', `/api/properties/${pidPay}/amortization`);
  check('no payment day: nodes on the balance-date anniversary',
    r.data.series[0].date === '2026-11-24' && r.data.series[0].interest === 412.39,
    JSON.stringify(r.data.series[0]));
  const interestBefore = r.data.series[0].interest;
  r = await req('PUT', `/api/properties/${pidPay}`, { payment_day: 1 });
  check('payment day stored', r.status === 200 && r.data.payment_day === 1, JSON.stringify(r.data.payment_day));
  r = await req('GET', `/api/properties/${pidPay}/amortization`);
  check('payment day 1: nodes land on the 1st',
    r.data.series[0].date === '2026-11-01' && r.data.series[1].date === '2026-12-01',
    JSON.stringify([r.data.series[0].date, r.data.series[1].date]));
  check('payment day does not change the interest math', r.data.series[0].interest === interestBefore);
  r = await req('PUT', `/api/properties/${pidPay}`, { payment_day: 15 });
  check('payment day update stored', r.status === 200 && r.data.payment_day === 15);
  r = await req('GET', `/api/properties/${pidPay}/amortization`);
  check('nodes follow the new payment day', r.data.series[0].date === '2026-11-15', String(r.data.series[0].date));
  await req('PUT', `/api/properties/${pidPay}`, { payment_day: 31 });
  r = await req('GET', `/api/properties/${pidPay}/amortization`);
  check('payment day 31 clamps to month end', r.data.series[0].date === '2026-11-30'
    && r.data.series.find((s) => s.month === '2027-02')?.date === '2027-02-28');
  r = await req('PUT', `/api/properties/${pidPay}`, { payment_day: 0 });
  check('payment day 0 rejected', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${pidPay}`, { payment_day: 32 });
  check('payment day 32 rejected', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${pidPay}`, { payment_day: null });
  check('payment day cleared', r.status === 200 && (r.data.payment_day ?? null) === null);
  r = await req('GET', `/api/properties/${pidPay}/amortization`);
  check('cleared payment day restores anniversary nodes', r.data.series[0].date === '2026-11-24');
  r = await req('DELETE', `/api/properties/${pidPay}`);
  check('delete payday property', r.status === 200);

  // Payment frequency: stored on the property, validated, and it
  // drives the projection. Same loan family as the engine anchors
  // ($100,000 at 5% from 2026-10-01) with the payment CALCULATED
  // from a 25-year amortization ($581.60): monthly totals are the
  // baseline (total interest 74482.97); accelerated bi-weekly pays
  // $290.80 per period, pays off in 2048-03 and costs 62395.46
  // (both totals cross-checked against the engine directly).
  r = await req('POST', '/api/properties', {
    address: '3 Frequency Court, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2019-06-15',
  });
  const pidFreq = r.data.id;
  await req('POST', `/api/properties/${pidFreq}/rates`, {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  r = await req('GET', `/api/properties/${pidFreq}/amortization`);
  check('default frequency is monthly with the baseline totals',
    r.data.frequency === 'monthly' && Math.abs(r.data.totalInterest - 74482.97) <= 0.02,
    JSON.stringify({ f: r.data.frequency, t: r.data.totalInterest }));
  const monthlyTotal = r.data.totalInterest;
  const monthlyPayoff = r.data.payoffMonth;
  r = await req('PUT', `/api/properties/${pidFreq}`, { payment_frequency: 'daily' });
  check('unknown payment frequency rejected', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${pidFreq}`, { payment_frequency: 'accelerated_bi_weekly' });
  check('payment frequency stored', r.status === 200 && r.data.payment_frequency === 'accelerated_bi_weekly',
    JSON.stringify(r.data.payment_frequency));
  r = await req('GET', `/api/properties/${pidFreq}`);
  check('payment frequency persisted', r.data.payment_frequency === 'accelerated_bi_weekly');
  r = await req('GET', `/api/properties/${pidFreq}/amortization`);
  check('accelerated bi-weekly: $290.80 per period, less interest, earlier payoff',
    r.data.frequency === 'accelerated_bi_weekly' && r.data.periodPayment === 290.80
      && Math.abs(r.data.totalInterest - 62395.46) <= 0.02
      && r.data.totalInterest < monthlyTotal && r.data.payoffMonth === '2048-03'
      && r.data.payoffMonth < monthlyPayoff && r.data.series[0].month === '2026-10',
    JSON.stringify({ p: r.data.periodPayment, t: r.data.totalInterest, po: r.data.payoffMonth }).slice(0, 160));
  r = await req('PUT', `/api/properties/${pidFreq}`, { payment_frequency: 'monthly' });
  check('frequency reset to monthly', r.status === 200 && r.data.payment_frequency === 'monthly');
  r = await req('GET', `/api/properties/${pidFreq}/amortization`);
  check('monthly totals restored after reset', Math.abs(r.data.totalInterest - monthlyTotal) <= 0.02);
  r = await req('DELETE', `/api/properties/${pidFreq}`);
  check('delete frequency property', r.status === 200);

  // ------------------------------------------------------------ admin ---
  // User management is admin-only. The live session at this point is
  // Jiaying's (from the login checks near the top), i.e. NOT admin.
  r = await req('GET', '/api/admin/users');
  check('non-admin gets 403 on the admin user list', r.status === 403, JSON.stringify(r.data));
  r = await req('POST', '/api/admin/users', { username: 'Nope', password: 'nope' });
  check('non-admin cannot create users', r.status === 403);
  r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  check('admin signs back in for the admin checks', r.status === 200);
  r = await req('GET', '/api/me');
  check('/api/me flags admin and carries avatar data',
    r.data.isAdmin === true && typeof r.data.avatarColor === 'string' && r.data.avatarFile === null,
    JSON.stringify(r.data));

  r = await req('GET', '/api/admin/users');
  check('admin can list all users', r.status === 200 && r.data.length === 3, JSON.stringify(r.data).slice(0, 200));
  const byName = Object.fromEntries((r.data || []).map((u) => [u.username, u]));
  check('default avatar colors are stored and Shawn != Jiaying',
    !!byName.Shawn.avatarColor && !!byName.Jiaying.avatarColor && byName.Shawn.avatarColor !== byName.Jiaying.avatarColor,
    JSON.stringify({ Shawn: byName.Shawn && byName.Shawn.avatarColor, Jiaying: byName.Jiaying && byName.Jiaying.avatarColor }));
  check('seeded users start on letter avatars (no photo file)',
    byName.Shawn.avatarFile === null && byName.Jiaying.avatarFile === null && byName.admin.avatarFile === null);
  const jiayingId = byName.Jiaying.id;
  const adminId = byName.admin.id;

  // Avatar upload for Jiaying (a tiny PNG): afterwards the file is
  // served back, and the owner-candidate directory — which the owner
  // chips on cards and detail pages render from — carries it.
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await req('POST', `/api/admin/users/${jiayingId}/avatar`, { dataBase64: TINY_PNG, contentType: 'image/png' });
  check('avatar upload accepted', r.status === 200 && !!r.data.avatarFile, JSON.stringify(r.data).slice(0, 160));
  const jiayingAvatar = r.data.avatarFile;
  const avRes = await fetch(`${BASE}/avatars/${jiayingAvatar}`, { headers: { Cookie: cookie } });
  check('uploaded avatar is served back as an image',
    avRes.status === 200 && String(avRes.headers.get('content-type')).includes('image/png'),
    `${avRes.status} ${avRes.headers.get('content-type')}`);
  r = await req('GET', '/api/users');
  const jiaDir = (r.data || []).find((u) => u.username === 'Jiaying');
  check('owner directory carries Jiaying\'s uploaded avatar (chips render from this)',
    !!jiaDir && jiaDir.avatarFile === jiayingAvatar, JSON.stringify(jiaDir));
  r = await req('POST', `/api/admin/users/${jiayingId}/avatar`, { dataBase64: TINY_PNG, contentType: 'text/plain' });
  check('non-image avatar upload rejected', r.status === 400);

  // A property owned by Jiaying: its owners name her, and her chip
  // everywhere (card, detail) renders the avatar from the directory.
  r = await req('POST', '/api/properties', { address: '5 Avatar Avenue', owners: ['Jiaying'], mortgage_balance: 200000, purchase_date: '2023-06-01' });
  check('property owned by Jiaying created', r.status === 201 && JSON.stringify(r.data.owners) === '["Jiaying"]');
  const pidAvatar = r.data.id;
  r = await req('GET', `/api/properties/${pidAvatar}`);
  check('property detail data names Jiaying as owner', JSON.stringify(r.data.owners) === '["Jiaying"]');

  // Restore default: photo cleared, stored color kept, file gone.
  r = await req('DELETE', `/api/admin/users/${jiayingId}/avatar`);
  check('restore-default clears the photo and keeps the color',
    r.status === 200 && r.data.avatarFile === null && r.data.avatarColor === byName.Jiaying.avatarColor,
    JSON.stringify(r.data).slice(0, 160));
  const avGone = await fetch(`${BASE}/avatars/${jiayingAvatar}`, { headers: { Cookie: cookie } });
  check('removed avatar file no longer served', avGone.status === 404);
  r = await req('DELETE', `/api/properties/${pidAvatar}`);
  check('avatar property cleaned up', r.status === 200);

  // Create / reset-password / delete lifecycle for a throwaway user.
  r = await req('POST', '/api/admin/users', { username: 'TestUser', password: 'firstpass' });
  check('admin creates a user (with a stored avatar color)',
    r.status === 201 && r.data.username === 'TestUser' && !!r.data.avatarColor, JSON.stringify(r.data).slice(0, 160));
  const testUserId = r.data.id;
  r = await req('POST', '/api/admin/users', { username: 'TestUser', password: 'whatever' });
  check('duplicate username rejected', r.status === 400);
  r = await req('POST', '/api/login', { username: 'TestUser', password: 'firstpass' });
  check('new user can sign in', r.status === 200);
  r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  r = await req('POST', `/api/admin/users/${testUserId}/password`, { password: 'secondpass' });
  check('admin resets a password', r.status === 200);
  r = await req('POST', '/api/login', { username: 'TestUser', password: 'firstpass' });
  check('old password fails after reset', r.status === 401);
  r = await req('POST', '/api/login', { username: 'TestUser', password: 'secondpass' });
  check('new password works after reset', r.status === 200);

  // Deleting a user scrubs their name from owners lists and ends their
  // sign-in; the admin user itself cannot be deleted.
  r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  r = await req('POST', '/api/properties', { address: '6 Scrub Street', owners: ['TestUser'], mortgage_balance: 1000, purchase_date: '2024-01-01' });
  const pidScrub = r.data.id;
  check('property owned by TestUser created', r.status === 201 && JSON.stringify(r.data.owners) === '["TestUser"]');
  r = await req('DELETE', `/api/admin/users/${testUserId}`);
  check('admin deletes a user', r.status === 200);
  r = await req('GET', `/api/properties/${pidScrub}`);
  check('deleted user scrubbed from owners', JSON.stringify(r.data.owners) === '[]', JSON.stringify(r.data.owners));
  r = await req('POST', '/api/login', { username: 'TestUser', password: 'secondpass' });
  check('deleted user can no longer sign in', r.status === 401);
  r = await req('DELETE', `/api/admin/users/${adminId}`);
  check('deleting the admin user is refused', r.status === 400, JSON.stringify(r.data));
  r = await req('DELETE', `/api/properties/${pidScrub}`);
  check('scrub property cleaned up', r.status === 200);

  // Segment delete + property delete paths.
  r = await req('DELETE', `/api/properties/${pid}/rates/${segId}`);
  check('delete rate segment', r.status === 200);
  r = await req('DELETE', `/api/properties/${pid}`);
  check('delete property', r.status === 200);

  // ------------------------------------------------------------ portfolio --
  // Cross-property aggregates from GET /api/properties/portfolio.
  // Assertions are delta-based against the portfolio as it was before
  // the fixtures, with per-property expectations taken from the
  // single-property endpoints (independent of the aggregation code).
  const portBefore = (await req('GET', '/api/properties/portfolio')).data;
  check('portfolio endpoint responds', portBefore && portBefore.totals && Array.isArray(portBefore.outstandingByMonth));
  r = await req('POST', '/api/properties', {
    address: '11 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2019-11-05',
  });
  const pidPA = r.data.id;
  await req('POST', `/api/properties/${pidPA}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  r = await req('POST', '/api/properties', {
    address: '22 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 50000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-05-20',
  });
  const pidPB = r.data.id;
  await req('POST', `/api/properties/${pidPB}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 3 });
  const amortA = (await req('GET', `/api/properties/${pidPA}/amortization`)).data;
  const amortB = (await req('GET', `/api/properties/${pidPB}/amortization`)).data;
  check('portfolio fixtures project individually (A matches the 74482.97 anchor: $100k at 5%, payment calculated over 25y)',
    amortA.ok && amortB.ok && Math.abs(amortA.totalInterest - 74482.97) <= 0.02,
    JSON.stringify({ a: amortA.totalInterest, b: amortB.totalInterest }));
  const port = (await req('GET', '/api/properties/portfolio')).data;
  check('portfolio totals = baseline + both properties',
    Math.abs(port.totals.outstanding - (portBefore.totals.outstanding + 150000)) <= 0.02
      && Math.abs(port.totals.monthlyPayment - (portBefore.totals.monthlyPayment + 818.22)) <= 0.02
      && Math.abs(port.totals.totalInterest - (portBefore.totals.totalInterest + amortA.totalInterest + amortB.totalInterest)) <= 0.05,
    JSON.stringify(port.totals));
  const sliceA = port.pie.outstanding.find((s) => s.id === pidPA);
  const sliceB = port.pie.outstanding.find((s) => s.id === pidPB);
  const pctSum = port.pie.outstanding.reduce((s, x) => s + x.pct, 0);
  check('pie shares match the balances and sum to 100',
    !!sliceA && !!sliceB
      && Math.abs(sliceA.pct - (100000 / port.totals.outstanding) * 100) <= 0.11
      && Math.abs(sliceB.pct - (50000 / port.totals.outstanding) * 100) <= 0.11
      && Math.abs(pctSum - 100) <= 0.5,
    JSON.stringify(port.pie.outstanding).slice(0, 200));
  const rowJun27 = port.outstandingByMonth.find((m) => m.month === '2027-06');
  const balA27 = amortA.series.find((s) => s.month === '2027-06').balance;
  const balB27 = amortB.series.find((s) => s.month === '2027-06').balance;
  const stackSum = rowJun27 ? Object.values(rowJun27.byProperty).reduce((s, v) => s + (v || 0), 0) : -1;
  check('stacked bars top out at the total line (2027-06)',
    !!rowJun27 && Math.abs(rowJun27.byProperty[pidPA] - balA27) <= 0.02
      && Math.abs(rowJun27.byProperty[pidPB] - balB27) <= 0.02
      && Math.abs(stackSum - rowJun27.total) <= 0.02,
    JSON.stringify(rowJun27).slice(0, 200));
  // Assessed-by-year, carry rule: A's 2024 point carries into 2025;
  // B counts only from its first point (2025).
  await req('POST', `/api/properties/${pidPA}/value-history`, { year: 2024, value: 980000 });
  await req('POST', `/api/properties/${pidPA}/value-history`, { year: 2026, value: 1150000 });
  await req('POST', `/api/properties/${pidPB}/value-history`, { year: 2025, value: 500000 });
  const port2 = (await req('GET', '/api/properties/portfolio')).data;
  const assessedAt = (resp, y) => { const row = resp.assessedByYear.find((a) => a.year === y); return row ? row.total : 0; };
  check('assessed-by-year deltas follow the carry rule',
    Math.abs(assessedAt(port2, 2024) - assessedAt(port, 2024) - 980000) <= 0.02
      && Math.abs(assessedAt(port2, 2025) - assessedAt(port, 2025) - 1480000) <= 0.02
      && Math.abs(assessedAt(port2, 2026) - assessedAt(port, 2026) - 1650000) <= 0.02,
    JSON.stringify(port2.assessedByYear).slice(0, 200));
  // A property with a later balance date joins the projection only
  // from its own start — never back-filled into earlier months.
  r = await req('POST', '/api/properties', {
    address: '33 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 20000, mortgage_balance_date: '2027-03-15', amortization_years: 25,
    purchase_date: '2027-03-15',
  });
  const pidPC = r.data.id;
  await req('POST', `/api/properties/${pidPC}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 4 });
  const port3 = (await req('GET', '/api/properties/portfolio')).data;
  const rowNov26 = port3.outstandingByMonth.find((m) => m.month === '2026-11');
  const cMonths = port3.outstandingByMonth.filter((m) => m.byProperty[pidPC] != null);
  check('a property joins the projection only from its own balance date',
    !!rowNov26 && rowNov26.byProperty[pidPC] === null
      && cMonths.length > 0 && cMonths[0].month === '2027-04'
      && Math.abs(port3.totals.outstanding - (port.totals.outstanding + 20000)) <= 0.02,
    JSON.stringify({ first: cMonths[0] && cMonths[0].month, nov: rowNov26 && rowNov26.byProperty[pidPC] }));
  r = await req('DELETE', `/api/properties/${pidPA}`);
  check('delete portfolio property A', r.status === 200);
  await req('DELETE', `/api/properties/${pidPB}`);
  await req('DELETE', `/api/properties/${pidPC}`);

  // ------------------------------------------- projection states --
  // The portfolio must say WHY a property is missing from the
  // projected interest, in three distinct states. The fixture mirrors
  // a real first run: a balance and one variable prime-spread segment
  // (2024-12-17, prime - 1), but NO amortization — a rate plan alone
  // cannot project (NO_PAYMENT), because the payment is calculated
  // from the amortization and there is nothing to calculate it from.
  const portStates0 = (await req('GET', '/api/properties/portfolio')).data;
  r = await req('POST', '/api/properties', {
    address: '44 State Test Crescent, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
    purchase_date: '2024-12-17',
  });
  const pidState = r.data.id;
  let portS = (await req('GET', '/api/properties/portfolio')).data;
  let rowS = portS.properties.find((x) => x.id === pidState);
  check('portfolio state: balance with no rate segments is no_plan',
    !!rowS && rowS.projState === 'no_plan'
      && portS.totals.noPlanCount === (portStates0.totals.noPlanCount || 0) + 1,
    JSON.stringify(rowS && rowS.projState));
  await req('POST', `/api/properties/${pidState}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  const amortState = (await req('GET', `/api/properties/${pidState}/amortization`)).data;
  check('a plan with no amortization reports NO_PAYMENT',
    !amortState.ok && amortState.code === 'NO_PAYMENT', JSON.stringify(amortState.code));
  portS = (await req('GET', '/api/properties/portfolio')).data;
  rowS = portS.properties.find((x) => x.id === pidState);
  check('portfolio state: plan but no amortization is no_payment, contributing no interest',
    !!rowS && rowS.projState === 'no_payment'
      && portS.totals.planNoPaymentCount === (portStates0.totals.planNoPaymentCount || 0) + 1
      && portS.totals.interestFrom === portStates0.totals.interestFrom
      && Math.abs(portS.totals.totalInterest - portStates0.totals.totalInterest) <= 0.02,
    JSON.stringify({ state: rowS && rowS.projState, totals: portS.totals }));
  await req('PUT', `/api/properties/${pidState}`, { amortization_years: 25 });
  const amortState2 = (await req('GET', `/api/properties/${pidState}/amortization`)).data;
  portS = (await req('GET', '/api/properties/portfolio')).data;
  rowS = portS.properties.find((x) => x.id === pidState);
  check('portfolio state: setting the amortization flips it to projected and its interest joins the total',
    !!rowS && rowS.projState === 'projected' && amortState2.ok === true
      && portS.totals.interestFrom === portStates0.totals.interestFrom + 1
      && Math.abs(portS.totals.totalInterest - (portStates0.totals.totalInterest + amortState2.totalInterest)) <= 0.05,
    JSON.stringify({ state: rowS && rowS.projState, interest: amortState2.totalInterest }));
  await req('DELETE', `/api/properties/${pidState}`);

  // -------------------------------- lender + amortization-year range --
  // The lender is a plain mortgage fact: it round-trips through the
  // property PUT/GET and stays null until the user names their bank —
  // the app never invents one.
  r = await req('POST', '/api/properties', {
    address: '77 Lender Test Road, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
    purchase_date: '2024-12-17',
  });
  const pidLender = r.data.id;
  check('lender starts unset (never invented)', (r.data.lender ?? null) === null, JSON.stringify(r.data.lender));
  r = await req('PUT', `/api/properties/${pidLender}`, { lender: '  Scotiabank  ' });
  check('lender saves trimmed', r.status === 200 && r.data.lender === 'Scotiabank', JSON.stringify(r.data.lender));
  r = await req('GET', `/api/properties/${pidLender}`);
  check('lender round-trips on the property', r.data.lender === 'Scotiabank', JSON.stringify(r.data.lender));
  r = await req('PUT', `/api/properties/${pidLender}`, { amortization_years: 36 });
  check('amortization above 35 years is rejected',
    r.status === 400 && String(r.data.error || '').includes('between 1 and 35'), JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${pidLender}`, { amortization_years: 0.5 });
  check('amortization below 1 year is rejected', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${pidLender}`, { amortization_years: 35 });
  check('amortization of 35 years is accepted (the range edge)',
    r.status === 200 && r.data.amortization_years === 35, JSON.stringify(r.data.amortization_years));
  await req('DELETE', `/api/properties/${pidLender}`);

  // Amortization ALONE (no monthly payment) must project: the states
  // fixture above proved a payment flips no_payment -> projected;
  // here the remaining years do it, the payment being derived from
  // the balance, the segment rate (stub prime 4.95 - 1 = 3.95%) and
  // the 30 years — the same hand-computed anchor as the unit tests.
  r = await req('POST', '/api/properties', {
    address: '78 Amort Only Road, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
    purchase_date: '2024-12-17',
  });
  const pidAmortOnly = r.data.id;
  await req('POST', `/api/properties/${pidAmortOnly}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  await req('PUT', `/api/properties/${pidAmortOnly}`, { amortization_years: 30 });
  const amortOnly = (await req('GET', `/api/properties/${pidAmortOnly}/amortization`)).data;
  check('amortization alone projects with a calculated payment of $6,381.36',
    amortOnly.ok === true && Math.abs(amortOnly.paymentUsed - 6381.36) < 0.5,
    JSON.stringify({ ok: amortOnly.ok, used: amortOnly.paymentUsed }));
  const portAmort = (await req('GET', '/api/properties/portfolio')).data;
  const rowAmort = portAmort.properties.find((x) => x.id === pidAmortOnly);
  check('amortization alone flips the portfolio state to projected',
    !!rowAmort && rowAmort.projState === 'projected', JSON.stringify(rowAmort && rowAmort.projState));
  await req('DELETE', `/api/properties/${pidAmortOnly}`);

  // ------------------------------------------------------------ prime ---
  r = await req('GET', '/api/prime');
  check('fetch-on-read stored the stub prime with its as-of date',
    r.data.current && r.data.current.rate === 4.95 && r.data.current.date === '2026-10-21'
      && r.data.source && r.data.source.series === 'V80691311', JSON.stringify(r.data.current));
  check('prime change points walk back through the stored history (4.95, 4.70, 4.45, ...)',
    Array.isArray(r.data.changes) && r.data.changes.length === 5
      && r.data.changes[0].rate === 4.95 && r.data.changes[1].rate === 4.7 && r.data.changes[2].rate === 4.45,
    JSON.stringify(r.data.changes));
  check('prime info carries the full step history for the chart (first observation, every change point, newest observation)',
    Array.isArray(r.data.history) && r.data.history.length === 8
      && r.data.history[0].date === '2024-12-11' && r.data.history[0].rate === 5.95
      && r.data.history.some((h) => h.date === '2024-12-18' && h.rate === 5.45)
      && r.data.history.some((h) => h.date === '2025-11-05' && h.rate === 4.45)
      && r.data.history[r.data.history.length - 1].date === '2026-10-21'
      && r.data.history[r.data.history.length - 1].rate === 4.95,
    JSON.stringify(r.data.history));

  r = await req('GET', '/api/properties/1');
  check('legacy variable segment migrated as absolute, value intact',
    r.data.segments.length === 1 && r.data.segments[0].rate_mode === 'absolute'
      && r.data.segments[0].effective_rate === 5, JSON.stringify(r.data.segments));

  r = await req('POST', '/api/properties', {
    address: '7 Prime Place, Victoria, BC', mortgage_balance: 100000,
    mortgage_balance_date: '2026-10-01', amortization_years: 25, purchase_date: '2020-01-01',
  });
  const pidPrime = r.data.id;
  r = await req('POST', `/api/properties/${pidPrime}/rates`, { start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread' });
  check('a prime segment without a spread is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${pidPrime}/rates`, { start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: 99 });
  check('an out-of-range spread is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${pidPrime}/rates`, { start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 });
  check('Prime - 1 at prime 4.95 resolves to 3.95 and stores no absolute rate',
    r.status === 201 && r.data.rate_mode === 'prime_spread' && r.data.annual_rate === null && r.data.effective_rate === 3.95,
    JSON.stringify(r.data));
  r = await req('GET', `/api/properties/${pidPrime}/amortization`);
  check('projection uses the resolved rate (first interest 326.49 at 3.95%)',
    r.data.ok === true && r.data.primeRate === 4.95 && r.data.series[0].interest === 326.49,
    JSON.stringify({ primeRate: r.data.primeRate, first: r.data.series && r.data.series[0] }));

  const vanToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  check('the projection response carries a fresh prime status dated today',
    r.data.prime && r.data.prime.fresh === true && r.data.prime.rate === 4.95 && r.data.prime.asOf === vanToday,
    JSON.stringify(r.data.prime));

  // Fetch-on-read policy: within the same Vancouver day the moved
  // stub prime is NOT picked up — the value fetched today is fresh.
  stubPrime = 5.45;
  r = await req('GET', `/api/properties/${pidPrime}/amortization`);
  check('same-day reads do not refetch (still projecting at prime 4.95)',
    r.data.ok === true && r.data.primeRate === 4.95 && r.data.prime.fresh === true,
    JSON.stringify({ primeRate: r.data.primeRate, prime: r.data.prime }));

  // Simulate the next day by backdating the fetch bookkeeping in the
  // app's own database: the very next projection must pull the moved
  // prime inline — no manual refresh, no restart.
  const backdatePrimeMeta = () => {
    const dbFile = new Database(path.join(dataDir, 'finance.db'));
    dbFile.pragma('busy_timeout = 5000');
    const old = String(Date.now() - 25 * 3600 * 1000);
    dbFile.prepare("UPDATE app_meta SET value = ? WHERE key IN ('prime_last_success', 'prime_last_attempt')").run(old);
    dbFile.close();
  };
  backdatePrimeMeta();
  r = await req('GET', `/api/properties/${pidPrime}/amortization`);
  check('the next-day projection fetches inline and uses the moved prime (367.44 at 4.45%)',
    r.data.ok === true && r.data.primeRate === 5.45 && r.data.series[0].interest === 367.44
      && r.data.prime && r.data.prime.fresh === true && r.data.prime.rate === 5.45 && r.data.prime.asOf === vanToday,
    JSON.stringify({ primeRate: r.data.primeRate, prime: r.data.prime, first: r.data.series && r.data.series[0] }));
  r = await req('GET', `/api/properties/${pidPrime}`);
  check('the same segment now resolves to 4.45', r.data.segments[0].effective_rate === 4.45, JSON.stringify(r.data.segments[0]));

  // BoC down: the request still succeeds on the last known value,
  // and the response flags it stale (fresh: false) for the warning.
  stubDown = true;
  backdatePrimeMeta();
  r = await req('GET', `/api/properties/${pidPrime}/amortization`);
  check('with BoC down the projection falls back to the last known prime, flagged stale',
    r.data.ok === true && r.data.primeRate === 5.45 && r.data.prime && r.data.prime.fresh === false && r.data.prime.rate === 5.45,
    JSON.stringify({ primeRate: r.data.primeRate, prime: r.data.prime }));
  r = await req('GET', '/api/prime');
  check('prime info stays available and stale while BoC is down (observation as-of unchanged)',
    r.data.current && r.data.current.rate === 5.45 && r.data.current.date === '2026-10-21' && r.data.fresh === false,
    JSON.stringify({ current: r.data.current, fresh: r.data.fresh }));
  stubDown = false;
  backdatePrimeMeta();
  r = await req('GET', `/api/properties/${pidPrime}/amortization`);
  check('when BoC recovers, the next read is fresh again',
    r.data.ok === true && r.data.prime && r.data.prime.fresh === true && r.data.prime.rate === 5.45,
    JSON.stringify(r.data.prime));

  // The manual refresh endpoint still forces a fetch at any time.
  stubPrime = 4.95;
  r = await req('POST', '/api/prime/refresh');
  check('manual refresh forces a fetch of the current value',
    r.data.current && r.data.current.rate === 4.95 && r.data.fresh === true, JSON.stringify(r.data.current));

  // The user's real shape, replayed on the stub history: $1,350,000
  // dated 2024-12-17, Prime - 1, 25-year amortization, and NO
  // entered payment — the payment must come out of the model. It is
  // derived ONCE at the start month's prime (Dec 2024: 5.45 ->
  // 4.45%) and then NEVER moves: his variable product is
  // fixed-payment, so each month prices its interest at its own
  // prime (Feb 5.20 -> 4.20%, Mar 4.95 -> 3.95%, Sep 4.70 -> 3.70%,
  // Nov 4.45 -> 3.45%) and only the interest/principal split walks
  // — prime is not priced at today's value for the whole loan, and
  // it does not recast the payment either.
  r = await req('POST', '/api/properties', {
    address: '9 Replay Road, Victoria, BC', mortgage_balance: 1350000,
    mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
  });
  const pidReplay = r.data.id;
  await req('POST', `/api/properties/${pidReplay}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  await req('PUT', `/api/properties/${pidReplay}`, { amortization_years: 25 });
  const replay = (await req('GET', `/api/properties/${pidReplay}/amortization`)).data;
  const replayRow = (m) => replay.series.find((x) => x.month === m) || {};
  check('replay: the payment is calculated at the start month\u2019s prime (4.45%), nothing entered',
    replay.ok === true
      && Math.abs(replay.paymentUsed - engineDerive(1350000, 4.45, 25)) < 0.02
      && replayRow('2025-01').rate === 4.45
      && replayRow('2025-01').interest === Math.round(1350000 * engineMonthlyRate(4.45) * 100) / 100,
    JSON.stringify({ used: replay.paymentUsed, first: replay.series && replay.series[0] }));
  check('replay: every month prices at its own prime but the payment never steps (fixed-payment variable)',
    replayRow('2025-02').rate === 4.2 && replayRow('2025-03').rate === 3.95
      && replayRow('2025-09').rate === 3.7 && replayRow('2025-11').rate === 3.45
      && replay.series.slice(0, -1).every((row) => row.payment === replay.paymentUsed)
      && replayRow('2025-03').interest === Math.round(replayRow('2025-02').balance * engineMonthlyRate(3.95) * 100) / 100,
    JSON.stringify(['2025-01', '2025-02', '2025-03', '2025-09', '2025-11']
      .map((m) => [m, replayRow(m).rate, replayRow(m).payment, replayRow(m).interest])));
  check('replay: the response states the pricing assumption (history for the past, latest known for the future, fixed payment)',
    typeof replay.primeAssumption === 'string'
      && replay.primeAssumption.includes('actual Bank of Canada prime history')
      && replay.primeAssumption.includes('4.95%')
      && replay.primeAssumption.includes('does not change when prime moves'),
    JSON.stringify(replay.primeAssumption));
  await req('DELETE', `/api/properties/${pidReplay}`);

  r = await req('POST', '/api/properties', { address: '1 Region Road', mortgage_balance: 1000, purchase_date: '2020-01-01', region: 'US' });
  check('a non-CA region is refused (Canada only for now)', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', '/api/properties', { address: '2 Region Road', mortgage_balance: 1000, purchase_date: '2020-01-01', region: 'CA' });
  check('region CA is accepted and stored', r.status === 201 && r.data.region === 'CA', JSON.stringify(r.data.region));
  await req('DELETE', `/api/properties/${r.data.id}`);
  await req('DELETE', `/api/properties/${pidPrime}`);

  // ---- Mortgage terms: migration, renewal, lump sums ----
  // The legacy pre-seed (property '1 Legacy Lane': one old-shape
  // segment from 2025-01-01, no amortization, no lender) must have
  // been migrated into a Term 1 that mirrors the old model exactly.
  r = await req('GET', '/api/properties');
  const legacy1 = (r.data || []).find((p) => p.address === '1 Legacy Lane');
  check('legacy property migrated to a single Term 1',
    !!legacy1 && Array.isArray(legacy1.terms) && legacy1.terms.length === 1,
    JSON.stringify(legacy1 && legacy1.terms));
  check('Term 1 starts at the earliest segment, runs 60 months, opens with the balance',
    !!legacy1 && legacy1.terms[0].start_date === '2025-01-01' && legacy1.terms[0].term_months === 60
      && legacy1.terms[0].opening_balance === 0,
    JSON.stringify(legacy1 && legacy1.terms[0]));
  check('a missing amortization migrates to the flagged 25-year default',
    !!legacy1 && legacy1.terms[0].amortization_years === 25 && legacy1.terms[0].amortization_defaulted === 1,
    JSON.stringify(legacy1 && legacy1.terms[0]));
  check('legacy segments were assigned to Term 1',
    !!legacy1 && legacy1.segments.length === 1 && legacy1.segments[0].term_id === legacy1.terms[0].id,
    JSON.stringify(legacy1 && legacy1.segments));

  // His real shape, end to end over the terms model (stub prime is
  // 4.95 here): balance 1,350,000 dated 2024-12-17, one Prime - 1
  // segment, amortization 30 arriving later via the Mortgage form.
  r = await req('POST', '/api/properties', {
    address: '55 Term Test Terrace, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
  });
  const termPid = r.data.id;
  check('a new property starts with exactly one term',
    Array.isArray(r.data.terms) && r.data.terms.length === 1, JSON.stringify(r.data.terms));
  check('Term 1 opens on the balance date with the balance, 60 months, amortization unset',
    r.data.terms[0].start_date === '2024-12-17' && r.data.terms[0].term_months === 60
      && r.data.terms[0].amortization_years === null && r.data.terms[0].opening_balance === 1350000,
    JSON.stringify(r.data.terms[0]));
  const term1Id = r.data.terms[0].id;
  r = await req('POST', `/api/properties/${termPid}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  check('a segment added without a term lands in Term 1',
    r.status === 201 && r.data.term_id === term1Id, JSON.stringify(r.data));
  r = await req('GET', `/api/properties/${termPid}/amortization`);
  check('a term with no amortization is NO_PAYMENT',
    r.data.ok === false && r.data.code === 'NO_PAYMENT', JSON.stringify(r.data.code));
  r = await req('PUT', `/api/properties/${termPid}`, { amortization_years: 30, lender: 'RBC' });
  check('property-level amortization + lender write through to the current term',
    r.data.amortization_years === 30 && r.data.lender === 'RBC'
      && r.data.terms[0].amortization_years === 30 && r.data.terms[0].lender === 'RBC',
    JSON.stringify({ lender: r.data.lender, term: r.data.terms && r.data.terms[0] }));
  const projT1 = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  check('the term projection calculates its payment at the start month\u2019s prime (5.45 - 1 = 4.45%, 30y)',
    projT1.ok === true
      && Math.abs(projT1.paymentUsed - engineDerive(1350000, 4.45, 30)) < 0.5,
    JSON.stringify({ used: projT1.paymentUsed }));
  // Projection equivalence, locked: the series equals the engine's
  // term schedule for the same inputs (same stub prime history), to
  // the row — pricing every month at its own prime, payment fixed.
  const engineRun = engineSchedule({
    balance: 1350000, balanceDate: '2024-12-17',
    terms: [{ id: term1Id, start_date: '2024-12-17', amortization_years: 30 }],
    segments: [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }],
    primeHistory: [...stubPrimeHistory, { date: '2026-10-21', rate: stubPrime }],
  });
  check('single-term projection is month-by-month identical to the engine schedule',
    JSON.stringify(projT1.series) === JSON.stringify(engineRun.series)
      && projT1.totalInterest === engineRun.totalInterest && projT1.payoffMonth === engineRun.payoffMonth,
    JSON.stringify({ rows: projT1.series && projT1.series.length, ti: projT1.totalInterest }));

  // Renewal: prefilled from Term 1 (start = day after it ends,
  // opening = its projected end balance, amortization left unset).
  r = await req('POST', `/api/properties/${termPid}/terms`, {});
  check('renewal prefill: starts 2029-12-17 (day after Term 1 ends), amortization unset',
    r.status === 201 && r.data.start_date === '2029-12-17' && r.data.amortization_years === null
      && r.data.term_months === 60,
    JSON.stringify(r.data));
  const term2Id = r.data.id;
  const projCarry = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  const novRow = projCarry.series.find((x) => x.month === '2029-11');
  check('renewal opening balance is Term 1\u2019s projected end balance',
    !!novRow && Math.abs(r.data.opening_balance - novRow.balance) < 0.02,
    JSON.stringify({ opening: r.data.opening_balance, nov: novRow && novRow.balance }));
  const decCarry = projCarry.series.find((x) => x.month === '2029-12');
  check('with no amortization on Term 2 the running payment carries over the boundary unchanged',
    !!decCarry && !!novRow && Math.abs(decCarry.payment - novRow.payment) < 0.02,
    JSON.stringify({ dec: decCarry && decCarry.payment, nov: novRow && novRow.payment }));
  r = await req('PUT', `/api/properties/${termPid}/terms/${term2Id}`, { amortization_years: 25, lender: 'TD' });
  check('Term 2 updated in place (new lender, fresh amortization)',
    r.status === 200 && r.data.lender === 'TD' && r.data.amortization_years === 25,
    JSON.stringify(r.data));
  const projT2 = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  const nov2 = projT2.series.find((x) => x.month === '2029-11');
  const dec2 = projT2.series.find((x) => x.month === '2029-12');
  check('the projection is continuous across the term boundary (no balance jump)',
    !!nov2 && !!dec2 && Math.abs(dec2.balance - (nov2.balance + dec2.interest - dec2.payment)) < 0.02
      && Math.abs(dec2.interest - Math.round(nov2.balance * engineMonthlyRate(3.95) * 100) / 100) < 0.02,
    JSON.stringify({ nov: nov2 && nov2.balance, dec: dec2 }));
  check('the payment jumps at the boundary to the new term\u2019s amortization (25y)',
    !!dec2 && Math.abs(dec2.payment - engineDerive(nov2.balance, 3.95, 25)) < 0.02
      && Math.abs(dec2.payment - projT2.paymentUsed) > 1,
    JSON.stringify({ decPay: dec2 && dec2.payment, t1Pay: projT2.paymentUsed }));

  // Lump sum: deducts first; the payment does NOT change (bank
  // standard) — the smaller balance just pays off sooner inside
  // the running term, and at the renewal the benefit reappears as
  // a lower re-derived Term 2 payment.
  const projPreLump = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  // The lump lands in May 2025, priced at March's prime step
  // (4.95 - 1 = 3.95%) — the interest check below is hand-computed
  // at that rate, and the payment around it must be exactly the
  // running payment (prime moves never recast it either).
  r = await req('POST', `/api/properties/${termPid}/lump-sums`, { date: '2025-05-10', amount: 50000, note: 'Bonus' });
  check('lump sum created in the term active on its date',
    r.status === 201 && r.data.term_id === term1Id && r.data.amount === 50000, JSON.stringify(r.data));
  const lumpId = r.data.id;
  const projLump = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  const aprPre = projPreLump.series.find((x) => x.month === '2025-04');
  const aprPost = projLump.series.find((x) => x.month === '2025-04');
  const mayPost = projLump.series.find((x) => x.month === '2025-05');
  check('months before the lump sum are unchanged',
    JSON.stringify(aprPost) === JSON.stringify(aprPre), JSON.stringify(aprPost));
  check('the lump month charges interest on the reduced balance (May prices at prime 4.95) and the payment is unchanged',
    !!mayPost && Math.abs(mayPost.interest - Math.round((aprPost.balance - 50000) * engineMonthlyRate(3.95) * 100) / 100) < 0.02
      && Math.abs(mayPost.payment - aprPre.payment) < 0.02,
    JSON.stringify(mayPost));
  // The payoff inside Term 1 pulls in, but the renewal re-derives
  // Term 2's payment on its own fresh amortization — so end to end
  // the lump's certain effects are materially less total interest
  // and a lower payment from the renewal on, not a changed Term 1
  // payment or an earlier final payoff.
  const decPreLump = projPreLump.series.find((x) => x.month === '2029-12');
  const decPostLump = projLump.series.find((x) => x.month === '2029-12');
  check('the lump sum cuts the total interest and lowers the payment re-derived at the renewal',
    projLump.totalInterest < projPreLump.totalInterest - 10000
      && !!decPreLump && !!decPostLump && decPostLump.payment < decPreLump.payment - 100,
    JSON.stringify({
      interestBefore: projPreLump.totalInterest, interestAfter: projLump.totalInterest,
      decBefore: decPreLump && decPreLump.payment, decAfter: decPostLump && decPostLump.payment,
    }));
  r = await req('DELETE', `/api/properties/${termPid}/lump-sums/${lumpId}`);
  const projLumpGone = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  check('deleting the lump sum restores the previous projection',
    r.status === 200 && JSON.stringify(projLumpGone.series) === JSON.stringify(projPreLump.series));

  // The monthly payment is always calculated first; it cannot be
  // entered at the PROPERTY level at all (the property write paths
  // refuse it with a 400 — a contract error, never silently
  // swallowed), and a term-level override must be a positive
  // number (an invalid one is a 400 too). The dedicated override
  // section below exercises the valid writes; here the projection
  // stays the calculated one throughout.
  r = await req('PUT', `/api/properties/${termPid}`, { mortgage_payment: 7000 });
  check('entering a monthly payment on the property is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('calculated automatically'),
    JSON.stringify(r.data));
  r = await req('POST', '/api/properties', {
    address: '1 No Payment Entry Road', mortgage_balance: 1000, purchase_date: '2020-01-01', mortgage_payment: 100,
  });
  check('creating a property with a monthly payment is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('calculated automatically'),
    JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${termPid}/terms`, { payment_override: -100 });
  check('creating a term with a non-positive payment override is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('greater than 0'),
    JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${termPid}/terms/${term2Id}`, { payment_override: 0 });
  check('editing a term with a zero payment override is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('greater than 0'),
    JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${termPid}/terms/${term2Id}`, { payment_override: 'abc' });
  check('editing a term with a non-numeric payment override is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('greater than 0'),
    JSON.stringify(r.data));
  const projCalc = (await req('GET', `/api/properties/${termPid}/amortization`)).data;
  const novCalc = projCalc.series.find((x) => x.month === '2029-11');
  const decCalc = projCalc.series.find((x) => x.month === '2029-12');
  check('the projection stays the calculated one in both terms (Term 2 re-derived at the renewal)',
    Math.abs(projCalc.paymentUsed - engineDerive(1350000, 4.45, 30)) < 0.5
      && !!decCalc && !!novCalc && Math.abs(decCalc.payment - engineDerive(novCalc.balance, 3.95, 25)) < 0.02,
    JSON.stringify({ used: projCalc.paymentUsed, dec: decCalc && decCalc.payment }));

  // ---- Term payment override (API) ----
  // The engine derives the payment first (the baseline); a term
  // may then carry an override that runs the term on that fixed
  // payment instead. Fixture: $100,000 at 5% fixed over 25y —
  // derived $581.60 (payoff 2051-02, interest $74,482.97);
  // override $700 (payoff 2044-02, interest $51,293.17) — the
  // engine unit tests anchor both trajectories.
  r = await req('POST', '/api/properties', {
    address: '9 Override Court, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-01', purchase_date: '2025-06-01', amortization_years: 25,
  });
  const ovPid = r.data.id;
  const ovTermId = r.data.terms[0].id;
  await req('POST', `/api/properties/${ovPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  const ovBase = (await req('GET', `/api/properties/${ovPid}/amortization`)).data;
  check('override fixture: the baseline triple is the derived payment, not overridden',
    ovBase.paymentUsed === 581.6 && ovBase.paymentDerived === 581.6 && ovBase.paymentOverridden === false
      && ovBase.payoffMonth === '2051-02' && ovBase.totalInterest === 74482.97,
    JSON.stringify({ u: ovBase.paymentUsed, d: ovBase.paymentDerived, o: ovBase.paymentOverridden }));
  r = await req('PUT', `/api/properties/${ovPid}/terms/${ovTermId}`, { payment_override: 700 });
  check('a term payment_override write succeeds (200), stores the value and serves the term triple',
    r.status === 200 && r.data.payment_override === 700
      && r.data.paymentUsed === 700 && r.data.paymentDerived === 581.6 && r.data.paymentOverridden === true,
    JSON.stringify(r.data));
  const ovProj = (await req('GET', `/api/properties/${ovPid}/amortization`)).data;
  check('the projection runs on the override (used 700, derived 581.60 beside it, payoff 2044-02, interest 51,293.17)',
    ovProj.paymentUsed === 700 && ovProj.paymentDerived === 581.6 && ovProj.paymentOverridden === true
      && ovProj.payoffMonth === '2044-02' && ovProj.totalInterest === 51293.17
      && ovProj.series[0].payment === 700 && ovProj.series[0].principal === 287.61,
    JSON.stringify({ u: ovProj.paymentUsed, d: ovProj.paymentDerived, p: ovProj.payoffMonth, i: ovProj.totalInterest }));
  const ovEngine = engineSchedule({
    balance: 100000, balanceDate: '2026-01-01',
    terms: [{ id: ovTermId, start_date: '2026-01-01', amortization_years: 25, payment_override: 700 }],
    segments: [{ id: 1, start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }],
  });
  check('the override trajectory matches the engine run to the row',
    JSON.stringify(ovProj.series) === JSON.stringify(ovEngine.series));
  const ovProp = (await req('GET', `/api/properties/${ovPid}`)).data;
  check('the property payload serves the triple at property level and term level',
    ovProp.paymentUsed === 700 && ovProp.paymentDerived === 581.6 && ovProp.paymentOverridden === true
      && ovProp.terms[0].paymentUsed === 700 && ovProp.terms[0].paymentDerived === 581.6 && ovProp.terms[0].paymentOverridden === true,
    JSON.stringify({ u: ovProp.paymentUsed, d: ovProp.paymentDerived, o: ovProp.paymentOverridden }));
  const ovPort = (await req('GET', '/api/properties/portfolio')).data;
  const ovRow = ovPort.properties.find((x) => x.id === ovPid);
  check('the portfolio row serves the used payment with its derived beside it (the total sums used values)',
    !!ovRow && ovRow.monthlyPayment === 700 && ovRow.paymentDerived === 581.6 && ovRow.paymentOverridden === true,
    JSON.stringify(ovRow));
  r = await req('POST', `/api/properties/${ovPid}/preview`, { start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 4.5, term_id: ovTermId });
  check('the plan preview inside an overridden term previews the override payment with the derived beside it',
    r.data.ok === true && r.data.payment === 700 && r.data.paymentOverridden === true
      && r.data.paymentDerived !== 700 && r.data.paymentDerived > 0,
    JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${ovPid}/terms/${ovTermId}`, { payment_override: null });
  const ovCleared = (await req('GET', `/api/properties/${ovPid}/amortization`)).data;
  check('clearing the override restores the pure-derived schedule to the cent',
    r.status === 200 && r.data.payment_override === null
      && ovCleared.paymentUsed === 581.6 && ovCleared.paymentDerived === 581.6 && ovCleared.paymentOverridden === false
      && JSON.stringify(ovCleared.series) === JSON.stringify(ovBase.series)
      && ovCleared.totalInterest === ovBase.totalInterest,
    JSON.stringify({ u: ovCleared.paymentUsed, o: ovCleared.paymentOverridden }));
  await req('DELETE', `/api/properties/${ovPid}`);

  // ---- Segment compounding (API) ----
  // Each segment carries its own compounding convention:
  // 'semi_annual' (the default — every pre-existing segment) or
  // 'monthly'. Interest and payment derivation both price under
  // the segment's own convention.
  r = await req('POST', '/api/properties', {
    address: '11 Compounding Crescent, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-01', purchase_date: '2025-06-01', amortization_years: 25,
  });
  const cmpPid = r.data.id;
  r = await req('POST', `/api/properties/${cmpPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5, compounding: 'weekly' });
  check('an invalid compounding value is a 400',
    r.status === 400 && String(r.data.error || '').includes('compounding'), JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${cmpPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  check('a segment created without compounding defaults to semi_annual (the serializer carries it)',
    r.status === 201 && r.data.compounding === 'semi_annual', JSON.stringify(r.data));
  const cmpSegId = r.data.id;
  const cmpBase = (await req('GET', `/api/properties/${cmpPid}/amortization`)).data;
  check('compounding fixture baseline: semi-annual interest 412.39 and derived payment 581.60',
    cmpBase.series[0].interest === 412.39 && cmpBase.paymentUsed === 581.6,
    JSON.stringify({ i: cmpBase.series[0].interest, p: cmpBase.paymentUsed }));
  r = await req('PUT', `/api/properties/${cmpPid}/rates/${cmpSegId}`, { compounding: 'monthly' });
  check('a segment compounding write succeeds (200) and the serializer carries monthly',
    r.status === 200 && r.data.compounding === 'monthly', JSON.stringify(r.data));
  const cmpMonthly = (await req('GET', `/api/properties/${cmpPid}/amortization`)).data;
  check('the projection reprices monthly: first interest 416.67 (100,000 x 5%/12), derived payment follows the convention',
    cmpMonthly.series[0].interest === 416.67
      && cmpMonthly.paymentUsed === engineDerive(100000, 5, 25, 'monthly')
      && cmpMonthly.paymentUsed !== cmpBase.paymentUsed,
    JSON.stringify({ i: cmpMonthly.series[0].interest, p: cmpMonthly.paymentUsed }));
  const cmpProp = (await req('GET', `/api/properties/${cmpPid}`)).data;
  check('the property payload segment carries the compounding',
    cmpProp.segments[0].compounding === 'monthly', JSON.stringify(cmpProp.segments[0]));
  r = await req('PUT', `/api/properties/${cmpPid}/rates/${cmpSegId}`, { compounding: 'semi_annual' });
  const cmpBack = (await req('GET', `/api/properties/${cmpPid}/amortization`)).data;
  check('flipping back to semi_annual restores the baseline projection to the row',
    r.status === 200 && JSON.stringify(cmpBack.series) === JSON.stringify(cmpBase.series)
      && cmpBack.paymentUsed === cmpBase.paymentUsed,
    JSON.stringify({ p: cmpBack.paymentUsed }));
  r = await req('POST', `/api/properties/${cmpPid}/preview`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5, compounding: 'monthly' });
  check('a preview draft prices under its own compounding (monthly interest 416.67) while the saved segment stays semi-annual',
    r.data.ok === true && r.data.interest === 416.67, JSON.stringify(r.data));
  const cmpAfterPreview = (await req('GET', `/api/properties/${cmpPid}`)).data;
  check('the preview wrote nothing (saved segment still semi_annual)',
    cmpAfterPreview.segments[0].compounding === 'semi_annual', JSON.stringify(cmpAfterPreview.segments[0]));
  await req('DELETE', `/api/properties/${cmpPid}`);

  // ---- Segment Locked on (API) ----
  // The pricing anchor is a property of the RATE: a prime-spread
  // segment may carry locked_on, the date its rate was locked,
  // and derivations the segment governs price prime as of that
  // date. His real shape: $1,450,000 opening with the $100,000
  // month-1 lump folding it to $1,350,000, Prime - 1
  // monthly-compounded, 30y. Blank derives at the start month's
  // prime (Dec 2024 month-end 5.45 -> 4.45%) = $6,800.20; a
  // segment locked on 2024-12-10 (prime still 5.95 -> 4.95%) =
  // the commitment letter's $7,205.89. Accrual never reads the
  // lock: the override trajectory stays the verified one
  // (2026-05 $1,298,221.75 / 2026-09 $1,284,262.85). The retired
  // term-level pricing date is gone from term payloads entirely
  // and ignored on write.
  r = await req('POST', '/api/properties', {
    address: '12 Pricing Date Place, Victoria, BC',
    mortgage_balance: 1450000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17', amortization_years: 30,
  });
  const pdPid = r.data.id;
  const pdTermId = r.data.terms[0].id;
  const pdSeg = await req('POST', `/api/properties/${pdPid}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'monthly',
  });
  const pdSegId = pdSeg.data.id;
  await req('POST', `/api/properties/${pdPid}/lump-sums`, { date: '2024-12-20', amount: 100000 });
  const pdBlank = (await req('GET', `/api/properties/${pdPid}/amortization`)).data;
  check('locked on blank: the payment derives at the start month’s prime (4.45%, monthly) = 6,800.20, the segment carries no lock and the term payload has no pricing-date field',
    pdBlank.paymentDerived === 6800.2 && pdBlank.paymentUsed === 6800.2
      && (pdSeg.data.locked_on ?? null) === null
      && !('payment_pricing_date' in r.data.terms[0]),
    JSON.stringify({ d: pdBlank.paymentDerived, stored: pdSeg.data.locked_on }));
  r = await req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: '2024-13-40' });
  check('an invalid locked on date is a 400', r.status === 400 && String(r.data.error || '').includes('locked on'),
    JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${pdPid}/rates`, { start_date: '2025-06-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, locked_on: '2024-02-30' });
  check('creating a segment with an invalid locked on date is a 400 too',
    r.status === 400 && String(r.data.error || '').includes('locked on'), JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: '2024-12-10' });
  const pdLockedProj = (await req('GET', `/api/properties/${pdPid}/amortization`)).data;
  check('setting locked_on succeeds (200), echoes on the segment and re-derives the payment at that date’s prime (4.95%) = 7,205.89',
    r.status === 200 && r.data.locked_on === '2024-12-10'
      && pdLockedProj.paymentDerived === 7205.89 && pdLockedProj.paymentUsed === 7205.89 && pdLockedProj.paymentOverridden === false,
    JSON.stringify({ stored: r.data.locked_on, d: pdLockedProj.paymentDerived, u: pdLockedProj.paymentUsed }));
  check('the projection derives 7,205.89 with the lock set (and the first month still charges at the real 4.45%)',
    pdLockedProj.paymentDerived === 7205.89 && pdLockedProj.series[0].rate === 4.45,
    JSON.stringify({ d: pdLockedProj.paymentDerived, rate: pdLockedProj.series[0] && pdLockedProj.series[0].rate }));
  r = await req('PUT', `/api/properties/${pdPid}/terms/${pdTermId}`, { payment_override: 7207.10 });
  const pdOv = (await req('GET', `/api/properties/${pdPid}/amortization`)).data;
  const pdBal = (m) => (pdOv.series.find((x) => x.month === m) || {}).balance;
  check('lock + override: used 7,207.10, locked derived 7,205.89 beside it, trajectory the verified one',
    r.status === 200 && pdOv.paymentUsed === 7207.1 && pdOv.paymentDerived === 7205.89 && pdOv.paymentOverridden === true
      && pdBal('2026-05') === 1298221.75 && pdBal('2026-09') === 1284262.85,
    JSON.stringify({ u: pdOv.paymentUsed, d: pdOv.paymentDerived, may: pdBal('2026-05'), sep: pdBal('2026-09') }));
  r = await req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: '2024-12-20' });
  const pdAfterProj = (await req('GET', `/api/properties/${pdPid}/amortization`)).data;
  check('a lock date after the cut prices at the post-cut prime (derived back to 6,800.20) — resolution is by date',
    r.status === 200 && pdAfterProj.paymentDerived === 6800.2 && pdAfterProj.paymentUsed === 7207.1,
    JSON.stringify({ d: pdAfterProj.paymentDerived, u: pdAfterProj.paymentUsed }));
  r = await req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: null });
  await req('PUT', `/api/properties/${pdPid}/terms/${pdTermId}`, { payment_override: null });
  const pdCleared = (await req('GET', `/api/properties/${pdPid}/amortization`)).data;
  check('clearing the lock restores the blank derivation to the cent',
    r.status === 200 && r.data.locked_on === null
      && pdCleared.paymentDerived === 6800.2 && JSON.stringify(pdCleared.series) === JSON.stringify(pdBlank.series),
    JSON.stringify({ d: pdCleared.paymentDerived }));
  const pdProp = (await req('GET', `/api/properties/${pdPid}`)).data;
  check('the property payload echoes the (cleared) lock on the segment and no pricing-date field on the term',
    (pdProp.segments[0].locked_on ?? null) === null && !('payment_pricing_date' in pdProp.terms[0]),
    JSON.stringify({ seg: pdProp.segments[0].locked_on }));
  r = await req('PUT', `/api/properties/${pdPid}/terms/${pdTermId}`, { payment_pricing_date: '2024-12-10' });
  const pdIgnored = (await req('GET', `/api/properties/${pdPid}/amortization`)).data;
  check('the retired term-level pricing date is ignored on write (200, never echoed, derivation unchanged)',
    r.status === 200 && !('payment_pricing_date' in r.data) && pdIgnored.paymentDerived === 6800.2,
    JSON.stringify({ d: pdIgnored.paymentDerived }));
  await req('DELETE', `/api/properties/${pdPid}`);

  // ---- Segment accrual (API) ----
  // accrual: 'monthly' (the default — the period's converted
  // rate; every existing segment) or 'daily' (the nominal annual
  // rate summed over the period's actual days). Validation and
  // echo mirror compounding. $100,000 at 3.65% fixed from
  // 2026-01-15: the first period (Jan 15, Feb 15] is 31 days —
  // $310.00 daily vs $304.17 monthly-compounded.
  r = await req('POST', '/api/properties', {
    address: '14 Accrual Avenue, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-15', purchase_date: '2026-01-15', amortization_years: 25,
  });
  const acPid = r.data.id;
  r = await req('POST', `/api/properties/${acPid}/rates`, { start_date: '2026-01-15', rate_type: 'fixed', annual_rate: 3.65, compounding: 'monthly' });
  check('a segment created without accrual reads monthly', r.status === 201 && r.data.accrual === 'monthly',
    JSON.stringify(r.data.accrual));
  const acSegId = r.data.id;
  r = await req('POST', `/api/properties/${acPid}/rates`, { start_date: '2026-06-15', rate_type: 'fixed', annual_rate: 3.65, accrual: 'weekly' });
  check('an invalid accrual is a 400', r.status === 400 && String(r.data.error || '').includes('accrual'),
    JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${acPid}/rates/${acSegId}`, { accrual: 'daily' });
  check('setting accrual=daily succeeds (200) and echoes on the segment',
    r.status === 200 && r.data.accrual === 'daily', JSON.stringify(r.data.accrual));
  const acDaily = (await req('GET', `/api/properties/${acPid}/amortization`)).data;
  check('daily accrual charges the first period at the nominal rate over its 31 days ($310.00)',
    acDaily.series.length > 0 && acDaily.series[0].interest === 310,
    JSON.stringify(acDaily.series[0] && acDaily.series[0].interest));
  r = await req('PUT', `/api/properties/${acPid}/rates/${acSegId}`, { accrual: 'monthly' });
  const acMonthly = (await req('GET', `/api/properties/${acPid}/amortization`)).data;
  check('back to monthly accrual the first period converts as before ($304.17), derivation unchanged',
    r.status === 200 && acMonthly.series[0].interest === 304.17
      && acMonthly.paymentDerived === acDaily.paymentDerived,
    JSON.stringify({ i: acMonthly.series[0] && acMonthly.series[0].interest, d: acMonthly.paymentDerived, dd: acDaily.paymentDerived }));
  await req('DELETE', `/api/properties/${acPid}`);

  // ---- Equity (API) ----
  // One definition app-wide: equity = latest assessed value -
  // current remaining balance; a property with no mortgage
  // counts a balance of 0. The anchor fixture mirrors the
  // user's real figures: assessed 1,931,000 with a remaining
  // balance of 1,280,775 (an unprojected anchor — no rate plan —
  // so the remaining balance IS the anchor) -> equity 650,225.
  r = await req('POST', '/api/properties', {
    address: '2985 Equity Anchor Way, Coquitlam, BC',
    mortgage_balance: 1280775, mortgage_balance_date: '2026-10-01', purchase_date: '2024-12-17',
    assessed_value: 1931000, assessed_year: 2026,
  });
  const eqPid = r.data.id;
  r = await req('GET', `/api/properties/${eqPid}/equity`);
  check('equity endpoint: 1,931,000 - 1,280,775 = 650,225',
    r.data.equity === 650225 && r.data.balance === 1280775 && r.data.assessedValue === 1931000,
    JSON.stringify(r.data));
  r = await req('POST', '/api/properties', { address: '1 No Assessed Lane, Victoria, BC', purchase_date: '2024-01-01' });
  const eqBarePid = r.data.id;
  const pfEq = (await req('GET', '/api/properties/portfolio')).data;
  const pfEqRow = pfEq.properties.find((x) => x.id === eqPid);
  const pfBareRow = pfEq.properties.find((x) => x.id === eqBarePid);
  check('portfolio per-property equity carries the same figure; a property without an assessed value has null equity',
    !!pfEqRow && pfEqRow.equity === 650225 && !!pfBareRow && pfBareRow.equity === null,
    JSON.stringify({ eq: pfEqRow && pfEqRow.equity, bare: pfBareRow && pfBareRow.equity }));
  check('portfolio totals: equity is the sum over assessed properties only, exclusions counted',
    Math.abs(pfEq.totals.equity - pfEq.properties.reduce((s, x) => s + (x.equity || 0), 0)) < 0.005
      && pfEq.totals.equityExcluded === pfEq.properties.filter((x) => x.equity === null).length
      && pfEq.totals.equityCount + pfEq.totals.equityExcluded === pfEq.totals.propertyCount
      && pfEq.totals.equity >= 650225,
    JSON.stringify(pfEq.totals));

  // ---- Property costs (API) ----
  // Yearly running costs: one row per (year, category), stored
  // in its recorded basis — a 'monthly' entry holds the monthly
  // average and counts ×12 in every annual figure the pivot
  // returns (cells, year totals, latest).
  r = await req('POST', '/api/properties', { address: '77 Costs Court, Victoria, BC', purchase_date: '2024-01-01' });
  const costPid = r.data.id;
  r = await req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Property tax', amount: 5400 });
  const costEntry = (view, cat, year) => (view.entries || []).find((e) => e.category === cat && e.year === year);
  check('create an annual cost entry (201, source manual by default)',
    r.status === 201 && !!costEntry(r.data, 'Property tax', 2026)
      && costEntry(r.data, 'Property tax', 2026).basis === 'annual'
      && costEntry(r.data, 'Property tax', 2026).source === 'manual',
    JSON.stringify(r.data).slice(0, 300));
  r = await req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Electricity', amount: 85, basis: 'monthly' });
  check('create a monthly-basis entry (the stored amount is the monthly average)',
    r.status === 201 && !!costEntry(r.data, 'Electricity', 2026)
      && costEntry(r.data, 'Electricity', 2026).amount === 85,
    JSON.stringify(r.data).slice(0, 300));
  const costElecId = costEntry(r.data, 'Electricity', 2026).id;
  r = await req('POST', `/api/properties/${costPid}/costs`, { year: 2025, category: 'Property tax', amount: 5100 });
  r = await req('GET', `/api/properties/${costPid}/costs`);
  check('the pivot annualizes monthly entries (85 × 12) in cells, totals and latest',
    r.status === 200 && r.data.entries.length === 3
      && r.data.latest.year === 2026 && r.data.latest.total === 6420
      && r.data.years.find((y) => y.year === 2026).cells.Electricity.annual === 1020
      && r.data.years.find((y) => y.year === 2025).total === 5100,
    JSON.stringify(r.data).slice(0, 400));
  r = await req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Electricity', amount: 90, basis: 'monthly' });
  check('POST on an existing (year, category) upserts instead of duplicating',
    r.status === 201 && r.data.entries.length === 3
      && costEntry(r.data, 'Electricity', 2026).amount === 90
      && r.data.latest.total === 6480,
    JSON.stringify(r.data).slice(0, 300));
  r = await req('PUT', `/api/properties/${costPid}/costs/${costElecId}`, { category: 'Property tax' });
  check('PUT onto a colliding (year, category) is a 400 naming the clash',
    r.status === 400 && String(r.data.error || '').includes('already exists'), JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${costPid}/costs/${costElecId}`, { amount: 95 });
  check('PUT edits the amount (basis kept), the year total follows',
    r.status === 200 && costEntry(r.data, 'Electricity', 2026).amount === 95
      && costEntry(r.data, 'Electricity', 2026).basis === 'monthly'
      && r.data.latest.total === 6540,
    JSON.stringify(r.data).slice(0, 300));
  r = await req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Water', amount: -5 });
  check('a negative amount is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Water', amount: 5, basis: 'weekly' });
  check('an unknown basis is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('DELETE', `/api/properties/${costPid}/costs/${costElecId}`);
  check('DELETE removes the entry and the total drops back',
    r.status === 200 && r.data.entries.length === 2 && r.data.latest.total === 5400,
    JSON.stringify(r.data).slice(0, 300));
  r = await req('DELETE', `/api/properties/${costPid}/costs/${costElecId}`);
  check('deleting a missing entry is a 404', r.status === 404, JSON.stringify(r.data));
  r = await req('GET', '/api/properties/999999/costs');
  check('costs of a missing property are a 404', r.status === 404, JSON.stringify(r.data));

  // ---- Property costs: monthly detail (API) ----
  // A monthly entry may carry the months actually recorded; the
  // stored amount is the average the SERVER computes from them —
  // a client-sent amount alongside the months is not trusted.
  r = await req('POST', '/api/properties', { address: '78 Monthly Detail Drive, Victoria, BC', purchase_date: '2024-01-01' });
  const mdPid = r.data.id;
  r = await req('POST', `/api/properties/${mdPid}/costs`, {
    year: 2026, category: 'Electricity', basis: 'monthly', amount: 999, monthlyAmounts: { 1: 80, 2: 90, 3: 85 },
  });
  check('POST monthly with monthlyAmounts: stored amount is the computed average (85), months ride along',
    r.status === 201 && !!costEntry(r.data, 'Electricity', 2026)
      && costEntry(r.data, 'Electricity', 2026).amount === 85
      && JSON.stringify(costEntry(r.data, 'Electricity', 2026).monthlyAmounts) === JSON.stringify({ '1': 80, '2': 90, '3': 85 })
      && r.data.years.find((y) => y.year === 2026).cells.Electricity.annual === 1020
      && JSON.stringify(r.data.years.find((y) => y.year === 2026).cells.Electricity.months.slice(0, 4)) === JSON.stringify([80, 90, 85, 85]),
    JSON.stringify(r.data).slice(0, 400));
  r = await req('POST', `/api/properties/${mdPid}/costs`, { year: 2026, category: 'Water', basis: 'monthly', monthlyAmounts: {} });
  check('an empty monthlyAmounts map is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${mdPid}/costs`, { year: 2026, category: 'Water', basis: 'monthly', monthlyAmounts: { 13: 5 } });
  check('an out-of-range month in monthlyAmounts is a 400', r.status === 400, JSON.stringify(r.data));
  const mdElecId = costEntry(
    (await req('GET', `/api/properties/${mdPid}/costs`)).data, 'Electricity', 2026).id;
  r = await req('PUT', `/api/properties/${mdPid}/costs/${mdElecId}`, { monthlyAmounts: { 5: 130 } });
  check('PUT with fresh monthlyAmounts replaces the months and recomputes the average (130)',
    r.status === 200 && costEntry(r.data, 'Electricity', 2026).amount === 130
      && JSON.stringify(costEntry(r.data, 'Electricity', 2026).monthlyAmounts) === JSON.stringify({ '5': 130 })
      && r.data.latest.total === 1560,
    JSON.stringify(r.data).slice(0, 300));
  r = await req('PUT', `/api/properties/${mdPid}/costs/${mdElecId}`, { notes: 'hydro' });
  check('PUT naming no figure keeps the stored months and average',
    r.status === 200 && costEntry(r.data, 'Electricity', 2026).amount === 130
      && JSON.stringify(costEntry(r.data, 'Electricity', 2026).monthlyAmounts) === JSON.stringify({ '5': 130 }),
    JSON.stringify(r.data).slice(0, 300));
  r = await req('POST', `/api/properties/${mdPid}/costs`, { year: 2025, category: 'Gas', amount: 60, basis: 'monthly' });
  check('POST monthly with a bare amount keeps the legacy form (monthlyAmounts null, no detail)',
    r.status === 201 && costEntry(r.data, 'Gas', 2025).amount === 60
      && costEntry(r.data, 'Gas', 2025).monthlyAmounts === null,
    JSON.stringify(r.data).slice(0, 300));
  await req('DELETE', `/api/properties/${mdPid}`);

  // ---- AI fill chat (API): the multi-turn flow ----
  // Round 1: the model asks about the year and proposes the one
  // entry it is sure of — a monthly-basis electricity figure.
  // Round 2: with the answer and the draft in the history, it
  // completes the proposal. The chat itself writes nothing.
  fs.writeFileSync(aiStubFile, JSON.stringify({
    reply: 'Which year are these electricity bills for? The 3 bills (Jan $80, Feb $90, Mar $85) average $85/mo.',
    proposed: [{ year: 2026, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } }],
    ready: false,
  }));
  const chat1 = await req('POST', '/api/ai/fill-chat', {
    propertyId: costPid, history: [], text: 'electricity bills', proposed: [],
  });
  check('fill-chat round 1: asks a question and proposes the monthly entry month by month',
    chat1.status === 200 && chat1.data.ready === false
      && chat1.data.proposed.length === 1 && chat1.data.proposed[0].basis === 'monthly'
      && chat1.data.proposed[0].amount === 85
      && JSON.stringify(chat1.data.proposed[0].monthlyAmounts) === JSON.stringify({ '1': 80, '2': 90, '3': 85 }),
    JSON.stringify(chat1.data).slice(0, 300));
  fs.writeFileSync(aiStubFile, JSON.stringify({
    reply: 'Recorded as 2026 figures.',
    proposed: [
      { year: 2026, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } },
      { year: 2026, category: 'Property tax', amount: 5400, basis: 'annual' },
    ],
    ready: true,
  }));
  const chat2 = await req('POST', '/api/ai/fill-chat', {
    propertyId: costPid,
    history: [
      { role: 'user', content: 'electricity bills' },
      { role: 'assistant', content: chat1.data.reply },
    ],
    text: '2026', proposed: chat1.data.proposed,
  });
  check('fill-chat round 2: the completed proposal comes back ready',
    chat2.status === 200 && chat2.data.ready === true && chat2.data.proposed.length === 2,
    JSON.stringify(chat2.data).slice(0, 300));
  r = await req('GET', `/api/properties/${costPid}/costs`);
  check('the chat wrote nothing by itself (only Apply lands entries)',
    r.data.entries.length === 2 && !costEntry(r.data, 'Electricity', 2026),
    JSON.stringify(r.data.entries.map((e) => e.category)));
  r = await req('POST', '/api/ai/fill-chat', { propertyId: 999999, text: 'x' });
  check('fill-chat for a missing property is a 404', r.status === 404, JSON.stringify(r.data));
  r = await req('POST', '/api/ai/fill-chat', { propertyId: costPid });
  check('fill-chat with no message and no files is a 400', r.status === 400, JSON.stringify(r.data));

  // ---- AI Fill (API) ----
  // The stubbed model answers with the RBC commitment-letter
  // fields in raw document shapes; the endpoint must normalize
  // them, expand the segment "kind" vocabulary into the segment
  // form's fields, and drop unknown keys. Extraction writes
  // nothing by itself.
  fs.writeFileSync(aiStubFile, JSON.stringify({
    fields: {
      lender: 'RBC', start_date: 'Dec 17, 2024', term_months: 60, amortization_years: 30,
      opening_balance: '$1,350,000', payment_override: 7207.10,
      segment_kind: 'prime_spread', spread: -1, segment_compounding: 'monthly',
      segment_start_date: '2024-12-17', not_a_field: 'drop me',
    },
  }));
  r = await req('POST', '/api/ai/fill', { context: 'term', text: 'RBC commitment letter' });
  check('AI fill returns the commitment fields normalized (kind expanded, unknown keys dropped)',
    r.status === 200 && r.data.fields.lender === 'RBC' && r.data.fields.start_date === '2024-12-17'
      && r.data.fields.term_months === 60 && r.data.fields.amortization_years === 30
      && r.data.fields.opening_balance === 1350000 && r.data.fields.payment_override === 7207.1
      && r.data.fields.segment_rate_type === 'variable' && r.data.fields.segment_rate_mode === 'prime_spread'
      && r.data.fields.segment_spread === -1 && r.data.fields.segment_compounding === 'monthly'
      && r.data.fields.segment_start_date === '2024-12-17' && !('not_a_field' in r.data.fields),
    JSON.stringify(r.data));
  r = await req('POST', '/api/ai/fill', { context: 'bogus', text: 'x' });
  check('AI fill rejects an unknown context (400)', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', '/api/ai/fill', { context: 'term' });
  check('AI fill requires text or a file (400)', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', '/api/ai/fill', { context: 'term', file: { name: 'a.txt', type: 'text/plain', data: 'aGk=' } });
  check('AI fill rejects a non-image/PDF attachment (400)', r.status === 400, JSON.stringify(r.data));
  fs.writeFileSync(aiStubFile, JSON.stringify({ fields: { lender: 'RBC' } }));
  r = await req('POST', '/api/ai/fill', { context: 'term', text: 'letter' });
  check('the stub file is re-read per call (the next extraction sees the new response)',
    r.status === 200 && JSON.stringify(r.data.fields) === JSON.stringify({ lender: 'RBC' }), JSON.stringify(r.data));
  // ---- AI Fill model selection (API) ----
  // The server runs with LLM_MODELS=stub-a,stub-b and
  // LLM_MODEL=stub-a. The stub answers per model name, so the
  // response proves which model a fill ran with; the choice
  // persists server-side (app setting) as the next default.
  r = await req('GET', '/api/ai/config');
  check('AI config lists the env models with LLM_MODEL as the default',
    r.status === 200 && r.data.configured === true
      && JSON.stringify(r.data.models) === JSON.stringify(['stub-a', 'stub-b'])
      && r.data.model === 'stub-a', JSON.stringify(r.data));
  fs.writeFileSync(aiStubFile, JSON.stringify({
    models: { 'stub-a': { fields: { lender: 'Bank A' } }, 'stub-b': { fields: { lender: 'Bank B' } } },
  }));
  r = await req('POST', '/api/ai/fill', { context: 'term', text: 'letter', model: 'stub-c' });
  check('a model outside the configured list is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', '/api/ai/fill', { context: 'term', text: 'letter', model: 'stub-b' });
  check('a fill with model stub-b runs with stub-b (per-model stub response)',
    r.status === 200 && r.data.fields.lender === 'Bank B' && r.data.model === 'stub-b', JSON.stringify(r.data));
  r = await req('GET', '/api/ai/config');
  check('the chosen model persisted server-side as the new default',
    r.status === 200 && r.data.model === 'stub-b', JSON.stringify(r.data));
  r = await req('POST', '/api/ai/fill', { context: 'term', text: 'letter' });
  check('a fill without a model uses the persisted choice',
    r.status === 200 && r.data.fields.lender === 'Bank B' && r.data.model === 'stub-b', JSON.stringify(r.data));
  fs.writeFileSync(aiStubFile, JSON.stringify({ fields: {} }));
  // Unconfigured: a second server with no LLM env at all answers
  // 503 with the configuration guidance.
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-nollm-'));
    const port2 = PORT + 700;
    const server2 = spawn('node', ['src/server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, DATA_DIR: dir2, PORT: String(port2) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let cookie2 = '';
      for (let i = 0; i < 50 && !cookie2; i++) {
        try {
          const login = await fetch(`http://127.0.0.1:${port2}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' }),
          });
          if (login.ok) cookie2 = (login.headers.get('set-cookie') || '').split(';')[0];
        } catch { /* not up yet */ }
        if (!cookie2) await new Promise((res2) => setTimeout(res2, 200));
      }
      const resp = await fetch(`http://127.0.0.1:${port2}/api/ai/fill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
        body: JSON.stringify({ context: 'term', text: 'x' }),
      });
      const body2 = await resp.json();
      check('without LLM configuration the endpoint is a 503 naming the missing setup',
        resp.status === 503 && String(body2.error || '').includes('LLM_API_KEY'),
        JSON.stringify({ status: resp.status, body: body2 }));
    } finally {
      server2.kill();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }

  // ---- Per-term payment schedule + balance anchors ----
  // The frequency and payment day live on each term now.
  r = await req('PUT', `/api/properties/${termPid}/terms/${term2Id}`, { payment_frequency: 'daily' });
  check('an unknown term payment frequency is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${termPid}/terms/${term2Id}`, { anchor_balance: 100 });
  check('an anchor balance without its date is a 400', r.status === 400, JSON.stringify(r.data));

  // A term's own frequency + day drive its span; the property PUT
  // still writes the schedule through to every term, so a
  // property-level edit keeps its whole-mortgage meaning.
  r = await req('POST', '/api/properties', {
    address: '8 Term Schedule Way, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-15', purchase_date: '2020-01-01',
  });
  const pidTs = r.data.id;
  const tsTermId = r.data.terms[0].id;
  await req('POST', `/api/properties/${pidTs}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  await req('PUT', `/api/properties/${pidTs}`, { amortization_years: 25 });
  r = await req('PUT', `/api/properties/${pidTs}/terms/${tsTermId}`, { payment_day: 1, payment_frequency: 'semi_monthly' });
  check('a term accepts its own frequency + payment day',
    r.status === 200 && r.data.payment_frequency === 'semi_monthly' && r.data.payment_day === 1,
    JSON.stringify(r.data).slice(0, 160));
  r = await req('GET', `/api/properties/${pidTs}/amortization`);
  check('the term schedule drives the projection (semi-monthly on the term\u2019s day: periods on the 1st and 16th)',
    r.data.frequency === 'semi_monthly' && r.data.series[0].date === '2026-02-16',
    JSON.stringify({ f: r.data.frequency, d: r.data.series && r.data.series[0] && r.data.series[0].date }));
  r = await req('PUT', `/api/properties/${pidTs}`, { payment_frequency: 'monthly', payment_day: null });
  check('property schedule PUT stored', r.status === 200 && r.data.payment_frequency === 'monthly');
  r = await req('GET', `/api/properties/${pidTs}/amortization`);
  check('the property-level schedule PUT writes through to the terms',
    r.data.frequency === 'monthly' && r.data.series[0].date === '2026-02-15',
    JSON.stringify({ f: r.data.frequency, d: r.data.series && r.data.series[0] && r.data.series[0].date }));
  await req('DELETE', `/api/properties/${pidTs}`);

  // In-term anchor: once the term starts before the balance date,
  // the anchor rides on that term; editing it there writes the
  // property anchor back, and the projection follows it. Merely
  // placing it changes nothing (same balance, same plan).
  r = await req('POST', '/api/properties', {
    address: '9 Anchor Court, Victoria, BC',
    mortgage_balance: 200000, mortgage_balance_date: '2026-06-15', purchase_date: '2020-01-01',
  });
  const pidAnchor = r.data.id;
  const anchorTermId = r.data.terms[0].id;
  await req('POST', `/api/properties/${pidAnchor}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  await req('PUT', `/api/properties/${pidAnchor}/terms/${anchorTermId}`, { amortization_years: 25 });
  const anchorBefore = (await req('GET', `/api/properties/${pidAnchor}/amortization`)).data;
  r = await req('PUT', `/api/properties/${pidAnchor}/terms/${anchorTermId}`, { start_date: '2026-01-01' });
  check('moving the term start earlier puts the balance anchor on the term',
    r.status === 200 && r.data.anchor_date === '2026-06-15' && r.data.anchor_balance === 200000,
    JSON.stringify(r.data).slice(0, 200));
  const anchorAfter = (await req('GET', `/api/properties/${pidAnchor}/amortization`)).data;
  check('the projection is unchanged by the anchor placement (same balance, same plan)',
    JSON.stringify(anchorAfter.series) === JSON.stringify(anchorBefore.series)
      && anchorAfter.paymentUsed === anchorBefore.paymentUsed,
    JSON.stringify({ rows: anchorAfter.series && anchorAfter.series.length }));
  r = await req('PUT', `/api/properties/${pidAnchor}/terms/${anchorTermId}`, { anchor_balance: 195000, anchor_date: '2026-06-15' });
  check('editing the anchor on the term is accepted', r.status === 200 && r.data.anchor_balance === 195000,
    JSON.stringify(r.data).slice(0, 200));
  r = await req('GET', `/api/properties/${pidAnchor}`);
  check('the property anchor follows the term edit',
    r.data.mortgage_balance === 195000 && r.data.mortgage_balance_date === '2026-06-15',
    JSON.stringify({ b: r.data.mortgage_balance, d: r.data.mortgage_balance_date }));
  r = await req('GET', `/api/properties/${pidAnchor}/amortization`);
  check('the projection re-derives from the corrected anchor balance',
    Math.abs(r.data.paymentUsed - engineDerive(195000, 5, 25)) < 0.02, String(r.data.paymentUsed));
  await req('DELETE', `/api/properties/${pidAnchor}`);

  // Validation + term deletion rules.
  r = await req('POST', `/api/properties/${termPid}/terms`, { term_months: 121 });
  check('a term longer than 120 months is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${termPid}/terms`, { term_months: 0 });
  check('a zero-length term is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${termPid}/terms`, { amortization_years: 40 });
  check('a term amortization outside 1-35 is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${termPid}/lump-sums`, { date: '2025-01-01', amount: -5 });
  check('a negative lump sum is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${termPid}/lump-sums`, { date: '2025-01-01', amount: 100, term_id: 99999 });
  check('a lump sum naming a foreign term is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('DELETE', `/api/properties/${termPid}/terms/${term2Id}`);
  check('deleting Term 2 leaves Term 1 standing',
    r.status === 200 && Array.isArray(r.data.terms) && r.data.terms.length === 1, JSON.stringify(r.data.terms));
  r = await req('DELETE', `/api/properties/${termPid}/terms/${term1Id}`);
  check('the last remaining term cannot be deleted', r.status === 400, JSON.stringify(r.data));
  await req('DELETE', `/api/properties/${termPid}`);

  // ---- Repayment method (equal principal) + plan preview ----
  // The hand-computed fixture from the engine tests, end to end:
  // $120,000 at 6% fixed, 10-year amortization. Equal principal:
  // $1,000 of principal every month, first interest $592.63, first
  // payment $1,592.63, payoff exactly 120 months out (2036-01).
  r = await req('POST', '/api/properties', {
    address: '77 Equal Principal Parade, Victoria, BC',
    mortgage_balance: 120000, mortgage_balance_date: '2026-01-01', purchase_date: '2026-01-01',
  });
  const epPid = r.data.id;
  const epTermId = r.data.terms[0].id;
  check('a new term defaults to equal payment',
    r.data.terms[0].repayment_method === 'equal_payment', JSON.stringify(r.data.terms[0]));
  await req('PUT', `/api/properties/${epPid}`, { amortization_years: 10 });
  await req('POST', `/api/properties/${epPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 });
  r = await req('PUT', `/api/properties/${epPid}/terms/${epTermId}`, { repayment_method: 'bogus' });
  check('an unknown repayment method is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', `/api/properties/${epPid}/terms/${epTermId}`, { repayment_method: 'equal_principal' });
  check('the term takes the equal-principal method',
    r.status === 200 && r.data.repayment_method === 'equal_principal', JSON.stringify(r.data.repayment_method));
  const epProj = (await req('GET', `/api/properties/${epPid}/amortization`)).data;
  check('equal principal end to end: $1,000 principal a month, declining payments, payoff at the amortization end',
    epProj.ok === true && epProj.series.length === 120 && epProj.payoffMonth === '2036-01'
      && epProj.series.every((row) => row.principal === 1000)
      && epProj.series[0].interest === 592.63 && epProj.series[0].payment === 1592.63
      && epProj.paymentUsed === 1592.63
      && epProj.series.slice(0, 12).every((row, i, a) => i === 0 || row.payment < a[i - 1].payment),
    JSON.stringify({ used: epProj.paymentUsed, payoff: epProj.payoffMonth, first: epProj.series && epProj.series[0] }));
  r = await req('PUT', `/api/properties/${epPid}/terms/${epTermId}`, { repayment_method: 'equal_payment' });
  const epBack = (await req('GET', `/api/properties/${epPid}/amortization`)).data;
  check('switching back to equal payment restores one level payment',
    r.status === 200 && epBack.ok === true
      && Math.abs(epBack.paymentUsed - engineDerive(120000, 6, 10)) < 0.02
      && epBack.series.slice(0, -1).every((row) => row.payment === epBack.paymentUsed),
    JSON.stringify({ used: epBack.paymentUsed }));
  await req('DELETE', `/api/properties/${epPid}`);

  // Plan preview: a draft segment + the term's draft plan fields go
  // in, the plan's first month in effect comes out — computed by
  // the same engine, so it must equal the saved projection's row
  // for that month to the cent.
  r = await req('POST', '/api/properties', {
    address: '78 Preview Place, Victoria, BC',
    mortgage_balance: 120000, mortgage_balance_date: '2026-01-01', purchase_date: '2026-01-01',
  });
  const pvPid = r.data.id;
  const pvTermId = r.data.terms[0].id;
  await req('PUT', `/api/properties/${pvPid}`, { amortization_years: 10 });
  const pvDraft = {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6,
    term_id: pvTermId, repayment_method: 'equal_principal',
  };
  r = await req('POST', `/api/properties/${pvPid}/preview`, pvDraft);
  check('preview: an equal-principal draft prices its first month (2026-02) before anything is saved',
    r.status === 200 && r.data.ok === true && r.data.month === '2026-02' && r.data.rate === 6
      && r.data.principal === 1000 && r.data.interest === 592.63 && r.data.payment === 1592.63
      && r.data.balance === 119000,
    JSON.stringify(r.data));
  r = await req('GET', `/api/properties/${pvPid}`);
  check('the preview wrote nothing (no segment, method untouched)',
    r.data.segments.length === 0 && r.data.terms[0].repayment_method === 'equal_payment',
    JSON.stringify({ segs: r.data.segments.length, method: r.data.terms[0].repayment_method }));
  // Save exactly what was previewed: the projection's 2026-02 row
  // must be the previewed month, field for field.
  await req('POST', `/api/properties/${pvPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 });
  await req('PUT', `/api/properties/${pvPid}/terms/${pvTermId}`, { repayment_method: 'equal_principal' });
  const pvProj = (await req('GET', `/api/properties/${pvPid}/amortization`)).data;
  const pvRow = pvProj.series.find((x) => x.month === '2026-02') || {};
  check('the saved projection\u2019s first month equals the preview to the cent',
    pvRow.payment === 1592.63 && pvRow.interest === 592.63 && pvRow.principal === 1000
      && pvRow.balance === 119000 && pvRow.rate === 6,
    JSON.stringify(pvRow));
  // A changed draft re-prices live: same plan at 3% instead of 6%.
  r = await req('POST', `/api/properties/${pvPid}/preview`, { ...pvDraft, annual_rate: 3 });
  check('preview: editing the draft rate re-prices the first month (interest at 3%)',
    r.data.ok === true && r.data.rate === 3
      && r.data.interest === Math.round(120000 * engineMonthlyRate(3) * 100) / 100
      && r.data.payment === Math.round((1000 + 120000 * engineMonthlyRate(3)) * 100) / 100,
    JSON.stringify(r.data));
  // A mid-stream draft (a rate change next year) previews ITS first
  // month, not the projection's first month.
  r = await req('POST', `/api/properties/${pvPid}/preview`, {
    start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 3,
    term_id: pvTermId, repayment_method: 'equal_principal',
  });
  const pvProjNow = (await req('GET', `/api/properties/${pvPid}/amortization`)).data;
  const decRow = pvProjNow.series.find((x) => x.month === '2026-12') || {};
  check('preview: a future-dated draft previews its own first month at its own rate',
    r.data.ok === true && r.data.month === '2027-01' && r.data.rate === 3 && r.data.principal === 1000
      && r.data.interest === Math.round(decRow.balance * engineMonthlyRate(3) * 100) / 100,
    JSON.stringify(r.data));
  await req('DELETE', `/api/properties/${pvPid}`);

  // ---- Property photo gallery ----
  // Uploads land in property_photos (files under data/photos); the
  // detail response carries the ordered gallery; a legacy external
  // photo_url rides along as one extra entry until removed.
  const GALLERY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  r = await req('GET', '/api/properties');
  const legacyProp = (r.data || []).find((p) => p.address === '1 Legacy Lane');
  check('legacy single photo_file migrated into the gallery',
    !!legacyProp && Array.isArray(legacyProp.photos) && legacyProp.photos.length === 1
      && legacyProp.photos[0].kind === 'upload' && legacyProp.photos[0].src === '/photos/legacy-photo.jpg'
      && legacyProp.photo_file === null,
    JSON.stringify(legacyProp && legacyProp.photos));
  r = await req('POST', '/api/properties', {
    address: '77 Gallery Grove, Victoria, BC', mortgage_balance: 100000, purchase_date: '2021-05-01',
  });
  check('gallery fixture property created', r.status === 201, JSON.stringify(r.status));
  const galId = r.data.id;
  r = await req('GET', `/api/properties/${galId}`);
  check('a new property starts with an empty gallery',
    Array.isArray(r.data.photos) && r.data.photos.length === 0, JSON.stringify(r.data.photos));
  r = await req('POST', `/api/properties/${galId}/photos`, {
    images: [
      { dataBase64: GALLERY_PNG, contentType: 'image/png' },
      { dataBase64: GALLERY_PNG, contentType: 'image/png' },
    ],
  });
  check('batch upload appends two photos in order',
    r.status === 200 && r.data.photos.length === 2
      && r.data.photos.every((x) => x.kind === 'upload' && x.src.startsWith('/photos/'))
      && r.data.photos[0].id !== r.data.photos[1].id,
    JSON.stringify(r.data.photos));
  const firstPhoto = r.data.photos[0];
  const served = await fetch(BASE + firstPhoto.src, { headers: { Cookie: cookie } });
  check('an uploaded photo file is served back', served.status === 200, String(served.status));
  r = await req('POST', `/api/properties/${galId}/photos`, { dataBase64: GALLERY_PNG, contentType: 'image/png' });
  check('single-image upload shape also works', r.status === 200 && r.data.photos.length === 3,
    JSON.stringify(r.data.photos && r.data.photos.length));
  const badBatch = await req('POST', `/api/properties/${galId}/photos`, {
    images: [
      { dataBase64: GALLERY_PNG, contentType: 'image/png' },
      { dataBase64: 'aGVsbG8=', contentType: 'text/plain' },
    ],
  });
  check('a batch with a non-image is rejected whole', badBatch.status === 400, JSON.stringify(badBatch.data));
  r = await req('GET', `/api/properties/${galId}`);
  check('the rejected batch wrote nothing', r.data.photos.length === 3, JSON.stringify(r.data.photos.length));
  // Legacy external URL: set like the old form used to, shows as an
  // extra gallery entry, and removing it clears the field for good.
  r = await req('PUT', `/api/properties/${galId}`, { photo_url: 'https://example.com/house.jpg' });
  check('legacy photo_url joins the gallery as a url entry',
    r.status === 200 && r.data.photos.length === 4
      && r.data.photos[3].kind === 'url' && r.data.photos[3].id === 'url'
      && r.data.photos[3].src === 'https://example.com/house.jpg',
    JSON.stringify(r.data.photos));
  r = await req('DELETE', `/api/properties/${galId}/photos/url`);
  check('removing the url entry clears photo_url',
    r.status === 200 && r.data.photo_url === null && r.data.photos.length === 3,
    JSON.stringify(r.data.photos && r.data.photos.length));
  r = await req('DELETE', `/api/properties/${galId}/photos/${firstPhoto.id}`);
  check('deleting one upload leaves the rest in order',
    r.status === 200 && r.data.photos.length === 2 && !r.data.photos.some((x) => x.id === firstPhoto.id),
    JSON.stringify(r.data.photos));
  const gone = await fetch(BASE + firstPhoto.src, { headers: { Cookie: cookie } });
  check('the deleted photo file is gone', gone.status === 404, String(gone.status));
  r = await req('DELETE', `/api/properties/${galId}/photos/99999`);
  check('deleting a missing photo is 404', r.status === 404);

  // ---- Money inputs: grouped on screen, plain numbers on the wire ----
  // Every money field is a text input marked data-money; the shared
  // format/parse pair in app.js groups what the user sees and parses it
  // back before anything is sent, so the API still receives numbers.
  // The principal money fields live in the term cards
  // (client-rendered in the terms accordion): count the static page
  // and the rendered templates together. The principal pair's input
  // name switches between opening_balance and anchor_balance (the
  // term carrying the balance anchor edits the anchor values).
  // The term's payment override is edited through the Monthly
  // payment row's inline editor, whose input is a money field
  // like the others — there is no standalone override input (and
  // no "Monthly payment override" label) and still no
  // PROPERTY-level payment field anywhere.
  const appJsRes2 = await fetch(BASE + '/app.js', { headers: { Cookie: cookie } });
  const appJsText2 = await appJsRes2.text();
  check('money inputs are marked data-money in the page (the payment-row editor is one of them; no standalone override field)',
    (pageHtml.match(/data-money/g) || []).length >= 4
      && (appJsText2.match(/name="payment_override"[^>]*data-money/g) || []).length === 1
      && !appJsText2.includes('Monthly payment override')
      && !appJsText2.includes('name="mortgage_payment"')
      && (appJsText2.match(/name="\$\{principalName\}"[^>]*data-money/g) || []).length === 1
      && appJsText2.includes("anchored ? 'anchor_balance' : 'opening_balance'"),
    String((pageHtml.match(/data-money/g) || []).length));
  check('frontend wires the shared money format/parse helpers',
    jsText.includes('formatMoneyInput') && jsText.includes('parseMoneyInput') && jsText.includes('input[data-money]'));

  // Real-browser pass over the money fields (same puppeteer + CDP Fetch
  // bridge as tests/screenshot.mjs). Skipped, with a note, when no probe
  // browser is at hand — the HTTP assertions above still hold the line.
  await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  let puppeteer = null;
  try {
    const { createRequire } = await import('node:module');
    const reqmod = createRequire(import.meta.url);
    try { puppeteer = reqmod('puppeteer-core'); } catch { puppeteer = reqmod('/tmp/pptr/node_modules/puppeteer-core'); }
  } catch { puppeteer = null; }
  if (!puppeteer || !fs.existsSync('/opt/meta-chromium/chrome')) {
    console.log('money UI browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forward = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: PORT, path: rq.url, method: rq.method, headers: rq.headers },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        }
      );
      rr.on('error', reject);
      // CDP hands the request body over as a plain string (NOT base64 —
      // decoding it as such garbles every POST the page makes).
      if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
      rr.end();
    });
    const loginRes = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browser = await puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
    try {
      const page = await browser.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forward({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const fieldVal = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.value : null; }, sel);
      const focusField = (sel) => page.evaluate((s) => { const el = document.querySelector(s); el.focus(); if (el.select) el.select(); }, sel);

      // Add a property through the form: it carries NO principal
      // field anymore (the mortgage is filled in later), so the
      // property lands with no balance. The principal is then
      // typed into the term card's principal field — a bare number
      // must group live there — and the server must store the
      // plain number, as the term's opening and as the anchor
      // seeded from it.
      const addSrc = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
      check('the Add Property intro paragraph is gone from the page source', !addSrc.includes('Just the essentials'));
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate(() => document.querySelector('#addPropertyBtn').click());
      await wait(500);
      const addModalText = await page.evaluate(() => document.querySelector('#propertyModal').textContent);
      check('the rendered Add Property modal carries no intro paragraph', !addModalText.includes('Just the essentials'));
      const addHasBalance = await page.evaluate(() => !!document.querySelector('#addPropForm [name=mortgage_balance]'));
      check('the Add Property form has no Outstanding principal field', addHasBalance === false);
      await focusField('#addPropForm .address-input');
      await page.keyboard.type('999 Money Test Terrace, Victoria, BC');
      await page.evaluate(() => {
        const d = document.querySelector('#addPropForm [name=purchase_date]');
        d.value = '2024-12-17';
        d.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('#addPropForm [type=submit]').click());
      await wait(2500);
      r = await req('GET', '/api/properties');
      const moneyProp = (r.data || []).find((p) => p.address.includes('Money Test Terrace'));
      check('added without a principal: the property exists with no balance anchor',
        !!moneyProp && moneyProp.mortgage_balance === null, JSON.stringify(moneyProp && moneyProp.mortgage_balance));
      const moneyPid = moneyProp.id;

      // Fill the mortgage in from the Mortgage modal: typing a
      // bare number into Term 1's principal field groups it live.
      await page.goto(`http://ff.local/#property/${moneyPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('1350000');
      const typedBalance = await fieldVal('[data-term-form] [name=opening_balance]');
      check('term-card principal groups while typing (1350000 -> 1,350,000)', typedBalance === '1,350,000', String(typedBalance));
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(1400);
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('typed grouped principal stored plain: Term 1 opening 1350000 and the anchor seeded from it',
        r.data.terms[0].opening_balance === 1350000 && r.data.mortgage_balance === 1350000,
        JSON.stringify({ open: r.data.terms[0].opening_balance, anchor: r.data.mortgage_balance }));

      // The modal's read-only metadata shows the grouped current
      // principal, and the current term's card (which carries the
      // principal pair) opens grouped too.
      const metaPrincipal = await page.evaluate(() => document.querySelector('#metaCurrentPrincipal').textContent);
      check('modal metadata shows the grouped current principal', metaPrincipal.includes('1,350,000'), String(metaPrincipal));
      const editBalance = await fieldVal('[data-term-form] [name=opening_balance]');
      check('the term card opens with the grouped balance', editBalance === '1,350,000', String(editBalance));

      // Paste a pre-grouped figure into the term's principal field
      // and save the term: it must reach the server as the plain
      // number 2500. (This paste used to target the monthly-payment
      // field; that field is gone — the payment is calculated.)
      await focusField('[data-term-form] [name=opening_balance]');
      await client.send('Input.insertText', { text: '2,500' });
      const pastedPrincipal = await fieldVal('[data-term-form] [name=opening_balance]');
      check('pasted grouped principal displays grouped', pastedPrincipal === '2,500', String(pastedPrincipal));
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(1400);
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('pasted principal stored as the plain number 2500',
        r.data.terms[0].opening_balance === 2500, JSON.stringify(r.data.terms[0].opening_balance));

      // The manual assessed value on the same page opens grouped too,
      // and so does a value-history point opened for editing. Both are
      // written through the API, then the page is RELOADED (a goto to
      // the same hash would be a no-op) so the forms prefill afresh.
      await req('PUT', `/api/properties/${moneyPid}`, { assessed_value: 2100000, assessed_year: 2026 });
      await req('POST', `/api/properties/${moneyPid}/value-history`, { year: 2025, value: 1950000 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const editAssessed = await fieldVal('#propForm [name=assessed_value]');
      check('assessed value opens grouped on the detail form', editAssessed === '2,100,000', String(editAssessed));
      r = await req('GET', `/api/properties/${moneyPid}/value-history`);
      const pt2025 = (r.data.points || []).find((pt) => pt.year === 2025);
      await page.evaluate((id) => window.editTrendPoint(id), pt2025.id);
      await wait(300);
      const editTrend = await fieldVal('#trendForm [name=value]');
      check('trend point edit opens grouped', editTrend === '1,950,000', String(editTrend));

      // Other assets get the same treatment: type bare, see grouped,
      // stored plain; reopen the editor and it is grouped again.
      await page.goto('http://ff.local/#assets/stocks', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate(() => window.openAssetModal(null, 'stocks'));
      await wait(500);
      await page.evaluate(() => { document.querySelector('#assetForm [name=name]').value = 'Money Test Stock'; });
      await focusField('#assetForm [name=value]');
      await page.keyboard.type('750000');
      const typedAsset = await fieldVal('#assetForm [name=value]');
      check('asset value groups while typing (750000 -> 750,000)', typedAsset === '750,000', String(typedAsset));
      await page.evaluate(() => document.querySelector('#assetForm [type=submit]').click());
      await wait(1400);
      r = await req('GET', '/api/assets');
      const moneyAsset = (r.data || []).find((a) => a.name === 'Money Test Stock');
      check('asset value stored as the plain number 750000',
        !!moneyAsset && moneyAsset.value === 750000, JSON.stringify(moneyAsset && moneyAsset.value));
      await page.evaluate((id) => window.openAssetModal(id), moneyAsset.id);
      await wait(800);
      const editAsset = await fieldVal('#assetForm [name=value]');
      check('asset edit opens with the grouped value', editAsset === '750,000', String(editAsset));

      // A property added without a principal (the API section's
      // pidNoBal): its detail page renders the empty states, and
      // the mortgage filled in from the Mortgage modal makes the
      // projection run.
      await page.goto(`http://ff.local/#property/${pidNoBal}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const nbView = await page.evaluate(() => {
        const stats = document.querySelector('#propView').textContent;
        return {
          remaining: document.querySelector('#detailRemainingBalance').textContent,
          hasNaN: stats.includes('NaN') || stats.includes('undefined'),
        };
      });
      check('balance-less detail renders the empty remaining balance (—, no NaN/undefined)',
        nbView.remaining === '—' && !nbView.hasNaN, JSON.stringify(nbView));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(600);
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('900000');
      await page.evaluate(() => {
        const a = document.querySelector('[data-term-form] [name=amortization_years]');
        a.value = '25';
        a.dispatchEvent(new Event('input', { bubbles: true }));
        a.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(1400);
      r = await req('GET', `/api/properties/${pidNoBal}`);
      check('the modal save seeds the anchor from Term 1’s opening (900000)',
        r.data.mortgage_balance === 900000 && r.data.terms[0].opening_balance === 900000,
        JSON.stringify({ b: r.data.mortgage_balance, open: r.data.terms[0].opening_balance }));
      await req('POST', `/api/properties/${pidNoBal}/rates`, { start_date: r.data.terms[0].start_date, rate_type: 'fixed', annual_rate: 5 });
      r = await req('GET', `/api/properties/${pidNoBal}/amortization`);
      const nbDerived = engineDerive(900000, 5, 25);
      check('with a rate segment added, the filled-in mortgage projects (payment derived from 900,000 at 5% over 25y)',
        r.data.ok === true && r.data.paymentDerived === nbDerived,
        JSON.stringify({ ok: r.data.ok, d: r.data.paymentDerived, want: nbDerived }));
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const nbGrouped = nbDerived.toLocaleString('en-CA', { maximumFractionDigits: 0 });
      let nbStatOk = false;
      for (let i = 0; i < 24 && !nbStatOk; i++) {
        nbStatOk = await page.evaluate((g) => document.querySelector('#estPaymentValue').textContent.includes(g), nbGrouped);
        if (!nbStatOk) await wait(250);
      }
      check('the detail payment stat shows the derived figure after the fill-in', nbStatOk);
      await req('DELETE', `/api/properties/${pidNoBal}`);

      // Equity displays: the detail page's third headline stat
      // and the overview's Total equity card. The anchor property
      // (created in the API section above): assessed 1,931,000,
      // remaining 1,280,775 -> Current equity $650,225.
      await page.goto(`http://ff.local/#property/${eqPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1800);
      const eqStats = await page.evaluate(() => ({
        assessed: document.querySelector('#detailAssessedValue').textContent,
        remaining: document.querySelector('#detailRemainingBalance').textContent,
        equity: document.querySelector('#detailCurrentEquity').textContent,
      }));
      check('detail headline stats: Assessed $1,931,000, Remaining $1,280,775.00, Current equity $650,225.00 (balances render to the cent, assessed stays whole)',
        eqStats.assessed === '$1,931,000' && eqStats.remaining === '$1,280,775.00' && eqStats.equity === '$650,225.00',
        JSON.stringify(eqStats));
      await page.goto(`http://ff.local/#property/${eqBarePid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1800);
      const eqBare = await page.evaluate(() => ({
        assessed: document.querySelector('#detailAssessedValue').textContent,
        equity: document.querySelector('#detailCurrentEquity').textContent,
      }));
      check('a property without an assessed value shows — for Current equity',
        eqBare.assessed === '—' && eqBare.equity === '—', JSON.stringify(eqBare));
      // The overview card: left of Total outstanding principal,
      // showing the portfolio total equity from the API.
      const pfNow = (await req('GET', '/api/properties/portfolio')).data;
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(2500);
      const eqCard = await page.evaluate(() => {
        const eq = document.querySelector('#pfEquity');
        const out = document.querySelector('#pfOutstanding');
        const er = eq ? eq.getBoundingClientRect() : null;
        const orr = out ? out.getBoundingClientRect() : null;
        return {
          text: eq ? eq.textContent : null,
          leftOf: !!(er && orr && er.left < orr.left),
          notes: document.querySelector('#pfNotes').textContent,
        };
      });
      const fmtTotal = Number(pfNow.totals.equity).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      check('overview: the Total equity card sits left of Total outstanding principal and shows the portfolio total',
        eqCard.leftOf && eqCard.text === fmtTotal,
        JSON.stringify({ card: eqCard.text, want: fmtTotal, leftOf: eqCard.leftOf }));
      check('overview footnote notes the properties Total equity excludes (no assessed value)',
        eqCard.notes.includes('Total equity excludes'), eqCard.notes.slice(0, 200));
      // Properties head row: the title and the + Add property
      // button align with the Portfolio panel's content edges
      // (panel border 1px + padding 16px = a 17px inset), the
      // button gets the head's set 16px padding of air above it
      // instead of sitting squeezed against the subnav, and the
      // row leaves the same 16px below it before the Portfolio
      // panel instead of sitting flush on the panel.
      const measureHeadGeom = () => page.evaluate(() => {
        const head = document.querySelector('#section-properties .section-head');
        const title = head.querySelector('h2');
        const btn = document.querySelector('#addPropertyBtn');
        const panel = document.querySelector('#portfolioBlock');
        const hr = head.getBoundingClientRect();
        const tr = title.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        return {
          titleLeftDelta: Math.abs(tr.left - (pr.left + 17)),
          btnRightDelta: Math.abs(br.right - (pr.right - 17)),
          btnTopGap: br.top - hr.top,
          btnPanelGap: pr.top - br.bottom,
        };
      });
      const headGeom = await measureHeadGeom();
      check('properties head: title left edge aligns with the Portfolio panel content left edge',
        headGeom.titleLeftDelta <= 3, JSON.stringify(headGeom));
      check('properties head: Add property button right edge aligns with the panel content right edge',
        headGeom.btnRightDelta <= 3, JSON.stringify(headGeom));
      check('properties head: the button has the set 16px padding of space above it',
        headGeom.btnTopGap > 0 && Math.abs(headGeom.btnTopGap - 16) <= 3, JSON.stringify(headGeom));
      check('properties head: the button leaves the set 16px gap above the Portfolio panel (not flush)',
        Math.abs(headGeom.btnPanelGap - 16) <= 3, JSON.stringify(headGeom));
      // Same geometry at ~975 CSS px wide (close to the user's
      // window): the insets and gaps are padding-driven, so they
      // must hold at desktop width too, not just the test viewport.
      await page.setViewport({ width: 975, height: 800 });
      await wait(200);
      const headGeomWide = await measureHeadGeom();
      await page.setViewport({ width: 800, height: 600 });
      await wait(200);
      check('properties head @975px: title/button still align with the panel content edges',
        headGeomWide.titleLeftDelta <= 3 && headGeomWide.btnRightDelta <= 3, JSON.stringify(headGeomWide));
      check('properties head @975px: 16px above the button and 16px between the button and the panel',
        Math.abs(headGeomWide.btnTopGap - 16) <= 3 && Math.abs(headGeomWide.btnPanelGap - 16) <= 3,
        JSON.stringify(headGeomWide));

      // ------------------------------------------------- save sweep --
      // The general rule: ANY field, once saved, must re-derive
      // every figure it governs — nothing may be "stored while the
      // plan still runs on the old value". Regression target (the
      // user's Nash Drive report): Term 1 saved with an opening of
      // 500,000 derived $2,666.87; editing the opening to 600,000
      // updated OPENING PRINCIPAL in the modal head but CURRENT
      // MONTHLY PAYMENT stayed $2,666.87 and CURRENT PRINCIPAL
      // stayed on the 500k trajectory, because the term save wrote
      // the term row only while the projection runs off the
      // property balance anchor the pair is folded into. The sweep
      // walks one property through every save path and asserts the
      // governed figures follow — in both directions (what must
      // change changes; what must not change, e.g. the payment
      // across a lump sum, does not).
      const sweepDialog = (d) => d.accept();
      page.on('dialog', sweepDialog);
      const sweepSet = (sel, val) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [sel, val]);
      const sweepMeta = () => page.evaluate(() => ({
        opening: document.querySelector('#metaOpeningPrincipal').textContent,
        payment: document.querySelector('#metaCurrentPayment').textContent,
        principal: document.querySelector('#metaCurrentPrincipal').textContent,
        lender: document.querySelector('#metaCurrentLender').textContent,
      }));
      const sweepNum = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };
      const sweepFmt = (n) => Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      let sweepPid = null;
      const sweepApi = async () => {
        const p = (await req('GET', `/api/properties/${sweepPid}`)).data;
        const a = (await req('GET', `/api/properties/${sweepPid}/amortization`)).data;
        return { p, a };
      };
      const sweepUntilMeta = async (fn) => {
        let m = null;
        for (let i = 0; i < 32; i++) { m = await sweepMeta(); if (fn(m)) break; await wait(250); }
        return m;
      };
      const sweepSaveTerm = async () => {
        await page.evaluate(() => document.querySelector('[data-save-term]').click());
        await wait(1700);
      };
      // Setup, the Nash shape: no principal at creation; Term 1
      // filled in from the modal (CIBC, 2025-05-20, 60 months,
      // 25y amortization, monthly on the 20th, opening 500,000),
      // then its segment via the API (variable Prime − 0.85,
      // monthly compounding, monthly accrual, locked 2025-05-20 —
      // the stub history prices that lock at prime 4.95 → 4.10%).
      r = await req('POST', '/api/properties', { address: '1 Save Sweep Close, Victoria, BC', purchase_date: '2025-05-20' });
      sweepPid = r.data.id;
      await page.goto(`http://ff.local/#property/${sweepPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await sweepSet('[data-term-form] [name=lender]', 'CIBC');
      await sweepSet('[data-term-form] [name=start_date]', '2025-05-20');
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('500000');
      await sweepSet('[data-term-form] [name=term_months]', '60');
      await sweepSet('[data-term-form] [name=amortization_years]', '25');
      await sweepSet('[data-term-form] [name=payment_day]', '20');
      await sweepSaveTerm();
      {
        const { p } = await sweepApi();
        await req('POST', `/api/properties/${sweepPid}/rates`, {
          term_id: p.terms[0].id, start_date: '2025-05-20', rate_type: 'variable', rate_mode: 'prime_spread',
          spread: -0.85, compounding: 'monthly', accrual: 'monthly', locked_on: '2025-05-20',
        });
      }
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      const exp500 = engineDerive(500000, 4.10, 25, 'monthly');
      const exp600 = engineDerive(600000, 4.10, 25, 'monthly');
      check('sweep fixture prices as the user reported (500k @ 4.10% monthly / 25y = 2,666.87; 600k = 3,200.24)',
        exp500 === 2666.87 && exp600 === 3200.24, JSON.stringify({ exp500, exp600 }));
      let sweepState = await sweepApi();
      let sweepM = await sweepMeta();
      check('sweep: the 500k save derives the modal head (opening 500,000.00, payment 2,666.87, current principal on the 500k trajectory)',
        sweepM.opening === '$500,000.00' && sweepNum(sweepM.payment) === exp500
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ m: sweepM, remaining: sweepState.p.remainingBalance }));
      const heroSync = await page.evaluate(() => ({
        remaining: document.querySelector('#detailRemainingBalance').textContent,
        est: document.querySelector('#estPaymentValue').textContent,
      }));
      check('sweep: the detail hero agrees with the modal head after the 500k save',
        heroSync.remaining === sweepM.principal && heroSync.est.includes('2,666.87'), JSON.stringify(heroSync));
      const remaining500 = sweepState.p.remainingBalance;

      // THE reported edit: opening 500,000 -> 600,000.
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('600000');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      check('sweep: editing the opening to 600,000 re-derives the payment (3,200.24, exact)',
        sweepNum(sweepM.payment) === exp600 && sweepM.opening === '$600,000.00',
        JSON.stringify({ payment: sweepM.payment, opening: sweepM.opening }));
      check('sweep: the anchor itself moved to the edited pair (600,000 @ 2025-05-20) and Current Principal rides the new trajectory',
        sweepState.p.mortgage_balance === 600000 && sweepState.p.mortgage_balance_date === '2025-05-20'
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005
          && sweepState.p.remainingBalance !== remaining500,
        JSON.stringify({ anchor: sweepState.p.mortgage_balance, remaining: sweepState.p.remainingBalance, was: remaining500 }));
      const remaining600 = sweepState.p.remainingBalance;

      // Lender: a display fact — it changes where it shows and
      // moves nothing derived.
      await sweepSet('[data-term-form] [name=lender]', 'TD');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: a lender edit renames the current lender and leaves the derived figures untouched',
        sweepM.lender === 'TD' && sweepState.p.terms[0].lender === 'TD'
          && sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ lender: sweepM.lender, payment: sweepM.payment }));

      // Principal as of (the term's start): a contract fact —
      // the head line follows it, but the balance anchor is its
      // own fact and does NOT move with the term start (it
      // re-seats, and the projection is unchanged by the move).
      await sweepSet('[data-term-form] [name=start_date]', '2025-06-20');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      const headMoved = await page.evaluate(() => document.querySelector('.term-head').textContent);
      check('sweep: moving the term start moves the head line and leaves the anchor and the plan exactly as they were',
        headMoved.includes('2025-06-20 → 2030-06-19')
          && sweepState.p.mortgage_balance === 600000 && sweepState.p.mortgage_balance_date === '2025-05-20'
          && sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ head: headMoved.replace(/\s+/g, ' ').slice(0, 120), bd: sweepState.p.mortgage_balance_date, remaining: sweepState.p.remainingBalance }));
      await sweepSet('[data-term-form] [name=start_date]', '2025-05-20');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      const headBack = await page.evaluate(() => document.querySelector('.term-head').textContent);
      check('sweep: moving the term start back restores the head line, the plan never having moved',
        headBack.includes('2025-05-20 → 2030-05-19')
          && sweepState.p.mortgage_balance_date === '2025-05-20' && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ bd: sweepState.p.mortgage_balance_date, remaining: sweepState.p.remainingBalance }));
      // A partial API save that never submits the pair must not
      // move the anchor (the write-through is pair-scoped).
      {
        const termId = sweepState.p.terms[0].id;
        await req('PUT', `/api/properties/${sweepPid}/terms/${termId}`, { lender: 'CIBC' });
        const after = (await req('GET', `/api/properties/${sweepPid}`)).data;
        check('sweep: a pair-less term save (lender only) leaves the anchor exactly where it was',
          after.mortgage_balance === 600000 && after.mortgage_balance_date === '2025-05-20',
          JSON.stringify({ b: after.mortgage_balance, bd: after.mortgage_balance_date }));
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
        await wait(1500);
        await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
        await wait(500);
      }

      // Term length: governs the term's end date (its display
      // surface), not the payment (the amortization does that).
      await sweepSet('[data-term-form] [name=term_months]', '36');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      const head36 = await page.evaluate(() => document.querySelector('.term-head').textContent);
      check('sweep: term length moves the term end date and leaves the payment alone',
        head36.includes('2028-05-19') && sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ head: head36.replace(/\s+/g, ' ').slice(0, 120), payment: sweepM.payment }));
      await sweepSet('[data-term-form] [name=term_months]', '60');
      await sweepSaveTerm();
      const head60 = await page.evaluate(() => document.querySelector('.term-head').textContent);
      check('sweep: restoring the term length restores the end date',
        head60.includes('2030-05-19'), head60.replace(/\s+/g, ' ').slice(0, 120));

      // Amortization: the payment's own input — down-payment
      // figure must follow it out and back.
      const expAmort30 = engineDerive(600000, 4.10, 30, 'monthly');
      await sweepSet('[data-term-form] [name=amortization_years]', '30');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expAmort30);
      check('sweep: lengthening the amortization re-derives the payment (and the current principal follows the slower trajectory)',
        sweepNum(sweepM.payment) === expAmort30 && expAmort30 !== exp600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expAmort30 }));
      const remainingAmort30 = sweepState.p.remainingBalance;
      await sweepSet('[data-term-form] [name=amortization_years]', '25');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      check('sweep: restoring the amortization restores the payment and the trajectory',
        sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance }));

      // Repayment method: equal principal re-anchors the plan —
      // the first (highest) payment and a faster paydown.
      await sweepSet('[data-term-form] [name=repayment_method]', 'equal_principal');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => Math.abs(sweepNum(m.payment) - sweepState.p.paymentUsed) < 0.005);
      check('sweep: equal principal re-derives the payment (the term’s first month) and pays down faster',
        Math.abs(sweepNum(sweepM.payment) - sweepState.p.paymentUsed) < 0.005
          && sweepNum(sweepM.payment) !== exp600
          && sweepState.p.remainingBalance < remaining600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, used: sweepState.p.paymentUsed, remaining: sweepState.p.remainingBalance }));
      await sweepSet('[data-term-form] [name=repayment_method]', 'equal_payment');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      check('sweep: restoring equal payment restores the payment and the trajectory',
        sweepState.p.remainingBalance === remaining600 && sweepState.p.paymentUsed === exp600,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, used: sweepState.p.paymentUsed }));

      // Payment day: under a monthly frequency with monthly
      // accrual it governs no figure (it anchors the day-stepped
      // frequencies and daily-accrual period boundaries) — the
      // save must persist it and disturb nothing.
      await sweepSet('[data-term-form] [name=payment_day]', '15');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: a payment-day edit persists and leaves the monthly plan untouched',
        sweepState.p.terms[0].payment_day === 15 && sweepNum(sweepM.payment) === exp600
          && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ day: sweepState.p.terms[0].payment_day, payment: sweepM.payment }));

      // Payment frequency: the cadence itself. The engine derives
      // the monthly figure and splits it into per-period amounts,
      // so the monthly-equivalent headline genuinely stands —
      // what re-derives is the trajectory (weekly payments land
      // sooner, so the balance runs lower), and returning to
      // monthly must restore it exactly.
      await sweepSet('[data-term-form] [name=payment_frequency]', 'weekly');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => Math.abs(sweepNum(m.payment) - sweepState.p.paymentUsed) < 0.005);
      check('sweep: switching to weekly re-derives the trajectory (the monthly-equivalent figure stands, the balance runs lower)',
        sweepState.p.terms[0].payment_frequency === 'weekly'
          && Math.abs(sweepNum(sweepM.payment) - sweepState.p.paymentUsed) < 0.005
          && sweepState.p.remainingBalance !== remaining600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, used: sweepState.p.paymentUsed, remaining: sweepState.p.remainingBalance }));
      await sweepSet('[data-term-form] [name=payment_frequency]', 'monthly');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      check('sweep: switching back to monthly restores the payment and the trajectory',
        sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance }));

      // Payment override: a term-form fact entered through the
      // payment row — set it and every surface runs on it, with
      // the derived figure struck through beside it; clearing it
      // (Reset puts the derived figure back in the box) restores
      // the derived plan.
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(300);
      await focusField('[data-pay-edit-input]');
      await page.keyboard.type('3500');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: a payment override runs the plan (used 3,500.00, derived 3,200.24 struck through)',
        sweepState.p.paymentOverridden === true && sweepState.p.paymentUsed === 3500
          && sweepM.payment.includes('$3,500.00') && sweepM.payment.includes('$3,200.24'),
        JSON.stringify({ m: sweepM.payment, used: sweepState.p.paymentUsed }));
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(300);
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-reset]').click());
      await wait(200);
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      check('sweep: clearing the override restores the derived payment everywhere',
        sweepState.p.paymentOverridden === false && sweepNum(sweepM.payment) === exp600
          && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ m: sweepM.payment, overridden: sweepState.p.paymentOverridden }));

      // Segments, edited through the segment form. The term's one
      // segment is the sweep's pricing engine: spread, then
      // compounding, then the pricing lock, then accrual.
      const sweepSegId = sweepState.p.segments[0].id;
      const sweepEditSeg = async () => {
        await page.evaluate((id) => document.querySelector(`button[data-edit-seg="${id}"]`).click(), sweepSegId);
        await wait(500);
      };
      const sweepSaveSeg = async () => {
        await page.evaluate(() => document.querySelector('[data-seg-form] [data-seg-submit]').click());
        await wait(1700);
      };
      const expSpread = engineDerive(600000, 4.20, 25, 'monthly');
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=spread]', '-0.75');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expSpread);
      check('sweep: a spread edit re-prices the derivation (Prime − 0.75 locked at 4.95 → 4.20%)',
        sweepNum(sweepM.payment) === expSpread && expSpread !== exp600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expSpread }));
      const expSemi = engineDerive(600000, 4.20, 25, 'semi_annual');
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=compounding]', 'semi_annual');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expSemi);
      check('sweep: a compounding edit re-derives the payment in the new convention',
        sweepNum(sweepM.payment) === expSemi && expSemi !== expSpread
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expSemi }));
      const expLock2 = engineDerive(600000, 3.70, 25, 'monthly');
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=compounding]', 'monthly');
      await sweepSet('[data-seg-form] [name=locked_on]', '2025-12-01');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expLock2);
      check('sweep: moving the pricing lock re-derives at the locked date’s prime (2025-12-01 → 4.45 − 0.75 = 3.70%)',
        sweepNum(sweepM.payment) === expLock2
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expLock2 }));
      const remainingSegBase = sweepState.p.remainingBalance;
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=accrual]', 'daily');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: an accrual edit leaves the derived payment alone and moves the trajectory (daily interest)',
        sweepNum(sweepM.payment) === expLock2 && sweepState.p.remainingBalance !== remainingSegBase
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance, was: remainingSegBase }));
      const remainingDaily = sweepState.p.remainingBalance;
      // A second segment landing mid-term recasts the plan from
      // its start: the current principal moves and the schedule
      // reprices from that month, while the anchor-time payment
      // (before the segment starts) is genuinely not its to move.
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(500);
      // The add form reopens with the last edit's values still in
      // it (drafts ride across the reload by design), so EVERY
      // field of the new segment is set explicitly — otherwise
      // the "new" fixed segment would silently inherit the
      // variable prime-spread values from the edit before it.
      await sweepSet('[data-seg-form] [name=start_date]', '2026-01-01');
      await sweepSet('[data-seg-form] [name=rate_type]', 'fixed');
      await sweepSet('[data-seg-form] [name=annual_rate]', '5');
      await sweepSet('[data-seg-form] [name=compounding]', 'monthly');
      await sweepSet('[data-seg-form] [name=accrual]', 'monthly');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      const rowJun25 = sweepState.a.series.find((x) => x.month === '2025-06');
      const rowJun26 = sweepState.a.series.find((x) => x.month === '2026-06');
      check('sweep: a mid-term segment recasts the schedule from its start and moves the current principal',
        sweepState.p.remainingBalance !== remainingDaily
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005
          && sweepNum(sweepM.payment) === expLock2
          && rowJun25 && rowJun26 && rowJun26.payment !== rowJun25.payment,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, p25: rowJun25 && rowJun25.payment, p26: rowJun26 && rowJun26.payment }));
      const sweepSeg2 = sweepState.p.segments.find((s) => s.id !== sweepSegId);
      await page.evaluate((id) => document.querySelector(`button[data-del-seg="${id}"]`).click(), sweepSeg2.id);
      await wait(1700);
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: deleting the segment restores the single-segment trajectory exactly',
        sweepState.p.remainingBalance === remainingDaily && sweepNum(sweepM.payment) === expLock2,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, was: remainingDaily }));

      // Lump sums: the payment must NOT move (the user's settled
      // rule) — the balance and the payoff do.
      const lumpBefore = await sweepApi();
      await page.evaluate(() => document.querySelector('[data-toggle-lump]').click());
      await wait(400);
      await sweepSet('[data-lump-form] [name=date]', '2026-01-20');
      await focusField('[data-lump-form] [name=amount]');
      await page.keyboard.type('10000');
      await page.evaluate(() => document.querySelector('[data-lump-form] [type=submit]').click());
      await wait(1700);
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: a lump sum leaves the payment unchanged and pulls the balance and payoff in',
        sweepNum(sweepM.payment) === expLock2
          && sweepState.p.remainingBalance < lumpBefore.p.remainingBalance - 9000
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005
          && sweepState.a.payoffMonth <= lumpBefore.a.payoffMonth,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance, was: lumpBefore.p.remainingBalance, payoff: sweepState.a.payoffMonth, wasPayoff: lumpBefore.a.payoffMonth }));
      const sweepLumpId = sweepState.p.lumpSums[0].id;
      await page.evaluate((id) => document.querySelector(`[data-del-lump="${id}"]`).click(), sweepLumpId);
      await wait(1700);
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      check('sweep: deleting the lump sum restores the balance exactly, payment still unchanged',
        sweepState.p.remainingBalance === lumpBefore.p.remainingBalance && sweepNum(sweepM.payment) === expLock2,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, was: lumpBefore.p.remainingBalance }));
      page.off('dialog', sweepDialog);

      // The overview follows the same saves (the list reloads
      // dirty after any of them): the sweep property's card shows
      // the final remaining balance and payment.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(2500);
      const sweepCard = await page.evaluate((addr) => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes(addr));
        return card ? card.textContent.replace(/\s+/g, ' ') : null;
      }, 'Save Sweep Close');
      check('sweep: the overview card shows the final derived figures for the swept property',
        !!sweepCard && sweepCard.includes(sweepFmt(sweepState.p.remainingBalance))
          && sweepCard.includes(sweepFmt(sweepState.p.paymentUsed)),
        JSON.stringify({ card: sweepCard && sweepCard.slice(0, 200), remaining: sweepFmt(sweepState.p.remainingBalance), payment: sweepFmt(sweepState.p.paymentUsed) }));

      // Assessed-history window: the range is a start/end month
      // pair (the default 5-year preset fills Nov 2021-Oct 2026).
      // A property with 8 years on record (2019-2026) draws the 5
      // whose January falls in the pair (2022-2026); All widens it
      // to every year, and the trend summary is calculated over
      // the same range the chart shows.
      r = await req('POST', '/api/properties', { address: '977 Window Test Way, Victoria, BC', purchase_date: '2020-01-15', mortgage_balance: 500000 });
      const winPid = r.data.id;
      for (let y = 2019; y <= 2026; y++) {
        await req('POST', `/api/properties/${winPid}/value-history`, { year: y, value: 1000000 + (y - 2019) * 50000 });
      }
      await page.goto(`http://ff.local/#property/${winPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const assessedYears = () => page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Assessed value');
        return ds ? ds.data.map((p) => p.x) : null;
      });
      const winDefault = await assessedYears();
      check('detail chart A defaults to the most recent 5 assessment years (2022-2026)',
        JSON.stringify(winDefault) === JSON.stringify([2022, 2023, 2024, 2025, 2026]), JSON.stringify(winDefault));
      const sumDefault = await page.evaluate(() => document.querySelector('#trendSummary').textContent);
      check('trend summary is calculated over the displayed 5-year window (figure only, no range-guidance tail)',
        sumDefault.includes('Change 2022 → 2026') && !sumDefault.includes('fall in the selected chart range'), sumDefault);
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      const winAll = await assessedYears();
      check('range All widens the assessed line to all 8 years (2019-2026)',
        JSON.stringify(winAll) === JSON.stringify([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]), JSON.stringify(winAll));
      const sumAll = await page.evaluate(() => document.querySelector('#trendSummary').textContent);
      check('trend summary follows the widened window', sumAll.includes('Change 2019 → 2026'), sumAll);
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="60"]').click());
      await wait(600);
      const winBack = await assessedYears();
      check('switching back to 5 years restores the 2022-2026 window',
        JSON.stringify(winBack) === JSON.stringify([2022, 2023, 2024, 2025, 2026]), JSON.stringify(winBack));

      // Axis bounds: the x axis IS the picked start/end month pair
      // — from the first day of the start month to the end of the
      // end month — never the chart library's auto-fit (which
      // unioned the history with the projection and rounded outward
      // into decades of empty span). The presets only FILL the
      // pair: a look-back preset fills end = the current month.
      const rangePair = () => page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
      }));
      const ymDecA = (s) => { const [y, m] = s.split('-').map(Number); return y + (m - 1) / 12; };
      const curMonthStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
      const addMonthsStr = (ym, n) => {
        const [y, m] = ym.split('-').map(Number);
        const t = y * 12 + (m - 1) + n;
        return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
      };
      const axisA = () => page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        const xs = c.data.datasets.flatMap((d) => d.data.map((p) => p.x));
        return {
          min: c.scales.x.min, max: c.scales.x.max,
          ticks: c.scales.x.ticks.map((t) => t.label),
          dataMin: Math.min(...xs), dataMax: Math.max(...xs),
        };
      });
      // "Today" on the axis scale, computed in the page (same clock
      // the app uses): year + month/12 + day fraction within the month.
      const todayDec = () => page.evaluate(() => {
        const d = new Date();
        const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        return d.getFullYear() + d.getMonth() / 12 + (d.getDate() - 1) / (dim * 12);
      });
      let ax = await axisA();
      let rp = await rangePair();
      check('chart A axis with history only is the picked month pair (5-year preset fills it, ending at the current month)',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -59)
          && Math.abs(ax.min - ymDecA(rp.start)) < 0.001
          && Math.abs(ax.max - (ymDecA(rp.end) + 1 / 12)) < 0.001,
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max } }));

      // Give the fixture a rate plan + amortization on a known
      // balance date, reload, and the axis must follow each selected
      // range: every preset fills its month pair and the projection
      // clips to it; All -> the exact data extent, no padded
      // decades either side.
      await req('PUT', `/api/properties/${winPid}`, { mortgage_balance_date: '2025-01-15', amortization_years: 25 });
      await req('POST', `/api/properties/${winPid}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      ax = await axisA();
      rp = await rangePair();
      check('chart A 5-year axis is the filled month pair, with month ticks',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -59)
          && Math.abs(ax.min - ymDecA(rp.start)) < 0.001
          && Math.abs(ax.max - (ymDecA(rp.end) + 1 / 12)) < 0.001
          && ax.ticks.some((t) => /[A-Z][a-z]{2} \d{4}/.test(t)),
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max, ticks: ax.ticks } }));
      const outXs = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Outstanding principal');
        return ds ? ds.data.map((p) => p.x) : null;
      });
      check('chart A projection is clipped to the picked pair (in-range months drawn, the current month last)',
        Array.isArray(outXs) && outXs.length > 12
          && outXs.every((x) => x >= ymDecA(rp.start) - 0.001 && x < ymDecA(rp.end) + 1 / 12 + 0.001)
          && Math.abs(outXs[outXs.length - 1] - ymDecA(rp.end)) < 0.001,
        JSON.stringify(outXs && { n: outXs.length, last: outXs[outXs.length - 1] }));
      // Current equity line: at every outstanding point it equals
      // the assessed line's own interpolated value (this fixture's
      // history is known exactly: 2019-2026, +$50k a year) minus
      // the outstanding balance, and at the latest point it equals
      // the panel's Current equity figure to the cent.
      const eqHero = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const get = (k) => c.data.datasets.find((d) => d.key === k);
        const eq = get('equity'); const out = get('outstanding');
        return {
          has: !!eq, label: eq ? eq.label : null,
          eqPts: eq ? eq.data : null, outPts: out ? out.data : null,
          panel: document.querySelector('#detailCurrentEquity').textContent,
        };
      });
      const assessedAtH = (x) => {
        const ap = [];
        for (let y = 2019; y <= 2026; y++) ap.push({ x: y, y: 1000000 + (y - 2019) * 50000 });
        if (x < ap[0].x) return null;
        for (let i = 0; i < ap.length; i++) {
          if (x <= ap[i].x) {
            if (i === 0) return ap[0].y;
            const a = ap[i - 1]; const b = ap[i];
            return a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
          }
        }
        return ap[ap.length - 1].y;
      };
      let eqHeroOk = !!eqHero.has && eqHero.label === 'Current equity'
        && Array.isArray(eqHero.eqPts) && eqHero.eqPts.length > 0
        && eqHero.eqPts.length === eqHero.outPts.length;
      if (eqHeroOk) {
        for (let i = 0; i < eqHero.eqPts.length; i++) {
          const p = eqHero.eqPts[i]; const o = eqHero.outPts[i];
          const a = assessedAtH(p.x);
          if (Math.abs(p.x - o.x) > 1e-9 || a === null || Math.abs(p.y - (a - o.y)) > 0.011) { eqHeroOk = false; break; }
        }
      }
      const eqHeroLast = eqHero.eqPts ? eqHero.eqPts[eqHero.eqPts.length - 1] : null;
      const panelEqVal = Number(String(eqHero.panel).replace(/[^0-9.\-]/g, ''));
      check('hero chart carries a Current equity line (assessed line minus outstanding at every point; latest point equals the panel figure)',
        eqHeroOk && !!eqHeroLast && Math.abs(eqHeroLast.y - panelEqVal) < 0.011,
        JSON.stringify({ ok: eqHeroOk, last: eqHeroLast, panel: eqHero.panel }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      check('chart A 2-year axis spans exactly the filled 24 months, with monthly ticks',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -23)
          && Math.abs(ax.max - ax.min - 2) < 0.02 && ax.ticks.length >= 20,
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max, nTicks: ax.ticks.length } }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      const yrs1 = await assessedYears();
      check('chart A 1-year axis spans the filled 12 months and shows only the 2026 point',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -11)
          && Math.abs(ax.max - ax.min - 1) < 0.02
          && JSON.stringify(yrs1) === JSON.stringify([2026]),
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max }, yrs1 }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      check('chart A All axis is the exact data extent (2019 to the end of the last projected month)',
        !!ax && ax.min === 2019 && rp.start === '2019-01'
          && Math.abs(ax.max - (ax.dataMax + 1 / 12)) < 0.001 && ax.max < 2060,
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max, dataMax: ax.dataMax } }));

      // ---- Merged chart: the payment-split bars live in chart A now ----
      // One canvas on the detail page, its own range controls inside
      // the chart's panel, the y axis anchored at 0, and the bars
      // governed by the same month pair as the lines: monthly
      // inside a range, summed into yearly bars on the All span.
      const winAmort = (await req('GET', `/api/properties/${winPid}/amortization`)).data;
      const ymDec = (s) => { const [y, m] = s.split('-').map(Number); return y + (m - 1) / 12; };
      const barInfo = () => page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        const ints = c.data.datasets.find((d) => d.label === 'Interest portion');
        const prins = c.data.datasets.find((d) => d.label === 'Principal portion');
        return {
          // Scoped to the projection panel: the costs panel
          // further down the page has charts of its own.
          canvasCount: document.querySelectorAll('#projectionPanel canvas').length,
          hasMonthlyCanvas: !!document.querySelector('#monthlyChart'),
          labels: c.data.datasets.map((d) => d.label),
          yMin: c.scales.y.min, yMax: c.scales.y.max,
          dataMaxY: Math.max(...c.data.datasets.flatMap((d) => d.data.map((p) => p.y))),
          bars: ints && prins ? {
            stack: [ints.stack, prins.stack], types: [ints.type, prins.type],
            xs: ints.data.map((p) => p.x),
            sums: ints.data.map((p, i) => p.y + prins.data[i].y),
          } : null,
          axisOf: Object.fromEntries(c.data.datasets.map((d) => [d.label, d.yAxisID || 'y'])),
          y1Min: c.scales.y1 ? c.scales.y1.min : null,
          y1Max: c.scales.y1 ? c.scales.y1.max : null,
          lineMaxY: Math.max(...c.data.datasets.filter((d) => d.type === 'line').flatMap((d) => d.data.map((p) => p.y))),
        };
      });
      const samePanel = await page.evaluate(() => {
        const rb = document.querySelector('#rangeBtns');
        const cc = document.querySelector('#combinedChart');
        return !!rb && !!cc && rb.closest('.panel') === cc.closest('.panel');
      });
      check('the merged chart panel carries its own range controls', samePanel === true);
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="60"]').click());
      await wait(600);
      const rowsIn = async () => {
        const pair = await rangePair();
        return winAmort.series.filter((r) => r.month >= pair.start && r.month <= pair.end);
      };
      const exp60 = await rowsIn();
      let bi = await barInfo();
      check('the projection is exactly one chart canvas (the merged chart)',
        !!bi && bi.canvasCount === 1 && bi.hasMonthlyCanvas === false,
        JSON.stringify(bi && { n: bi.canvasCount, monthly: bi.hasMonthlyCanvas }));
      check('merged chart draws all four datasets (2 lines + 2 bar portions)',
        !!bi && ['Assessed value', 'Outstanding principal', 'Interest portion', 'Principal portion']
          .every((l) => bi.labels.includes(l)), JSON.stringify(bi && bi.labels));
      check('merged chart y axis starts at 0 with modest headroom above the data',
        !!bi && bi.yMin === 0 && bi.yMax > bi.dataMaxY && bi.yMax < bi.dataMaxY * 1.2,
        JSON.stringify(bi && { yMin: bi.yMin, yMax: bi.yMax, dataMaxY: bi.dataMaxY }));
      check('merged chart bars are monthly in the 5-year window and match the API series',
        !!bi && !!bi.bars && bi.bars.types[0] === 'bar' && bi.bars.stack[0] === 'payment'
          && bi.bars.xs.length === exp60.length && exp60.length > 12
          && bi.bars.sums.slice(0, 6).every((s, k) => Math.abs(s - exp60[k].payment) < 0.02),
        JSON.stringify(bi && bi.bars && { n: bi.bars.xs.length, exp: exp60.length }));
      const maxPay60 = Math.max(...exp60.map((r) => r.payment));
      check('dual axis: lines ride the left axis, payment bars the right axis — right max covers the largest payment, left max the largest balance',
        !!bi && bi.axisOf['Assessed value'] === 'y' && bi.axisOf['Outstanding principal'] === 'y'
          && bi.axisOf['Interest portion'] === 'y1' && bi.axisOf['Principal portion'] === 'y1'
          && bi.y1Min === 0 && bi.y1Max >= maxPay60 && bi.yMax >= bi.lineMaxY,
        JSON.stringify(bi && { axisOf: bi.axisOf, y1Max: bi.y1Max, maxPay60, yMax: bi.yMax, lineMaxY: bi.lineMaxY }));
      const stackGeo = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        c.update('none');
        const mi = c.data.datasets.findIndex((d) => d.label === 'Interest portion');
        const mp = c.data.datasets.findIndex((d) => d.label === 'Principal portion');
        const ei = c.getDatasetMeta(mi).data[3];
        const ep = c.getDatasetMeta(mp).data[3];
        if (!ei || !ep) return null;
        return { intBase: ei.base, intTop: ei.y, prinBase: ep.base, zeroPix: c.scales.y1.getPixelForValue(0) };
      });
      check('merged chart bars really stack (principal sits on interest, interest on zero)',
        !!stackGeo && Math.abs(stackGeo.intBase - stackGeo.zeroPix) < 2
          && Math.abs(stackGeo.prinBase - stackGeo.intTop) < 2,
        JSON.stringify(stackGeo));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(600);
      bi = await barInfo();
      ax = await axisA();
      const exp24 = await rowsIn();
      check('clicking 2 years in the chart panel rescales the axis and redraws the bars to the window',
        !!ax && Math.abs(ax.max - ax.min - 2) < 0.02
          && !!bi && !!bi.bars && bi.bars.xs.length === exp24.length
          && bi.bars.xs.every((x) => x >= ax.min - 0.001 && x <= ax.max + 0.001),
        JSON.stringify({ ax: ax && { min: ax.min, max: ax.max }, bars: bi && bi.bars && bi.bars.xs.length, exp: exp24.length }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(600);
      bi = await barInfo();
      const exp12 = await rowsIn();
      check('clicking 1 year shrinks the bars to just that year of payments',
        !!bi && !!bi.bars && bi.bars.xs.length === exp12.length && exp12.length < exp60.length,
        JSON.stringify(bi && bi.bars && { n: bi.bars.xs.length, exp: exp12.length }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      bi = await barInfo();
      const yearsAll = [...new Set(winAmort.series.map((r) => r.month.slice(0, 4)))];
      const totBars = bi && bi.bars ? bi.bars.sums.reduce((s, v) => s + v, 0) : 0;
      const totApi = winAmort.series.reduce((s, r) => s + r.payment, 0);
      const schedNoteGone = await page.evaluate(() => !document.querySelector('#scheduleNote'));
      check('All view aggregates the bars by year (one bar per projection year)',
        !!bi && !!bi.bars && bi.bars.xs.length === yearsAll.length
          && bi.bars.xs.every((x) => Number.isInteger(x))
          && Math.abs(totBars - totApi) < 1,
        JSON.stringify(bi && bi.bars && { n: bi.bars.xs.length, years: yearsAll.length, totBars, totApi }));
      check('no schedule-basis note remains under the chart (explanation prose removed)',
        schedNoteGone === true);

      // ---- Monthly schedule: monthly rows, year pages, one Total row ----
      // The table under the chart lists the endpoint's series months
      // inside the chart window (All here = the whole series), one
      // calendar year per page. At load it opens on today's year;
      // the All preset click above is a range change, so the page
      // has since reset to the window's first year. Its Total
      // row sums the ENTIRE range to the cent and must not move when
      // the page turns.
      const schedInfo = () => page.evaluate(() => {
        const total = document.querySelector('#scheduleTotalRow');
        return {
          months: [...document.querySelectorAll('#scheduleRows tr')].map((tr) => tr.children[0].textContent),
          year: document.querySelector('#scheduleYearSelect').value,
          totalLabel: total ? total.children[0].textContent : '',
          totalPayment: total ? Number(total.querySelector('.sum-payment').dataset.value) : null,
          totalPrincipal: total ? Number(total.querySelector('.sum-principal').dataset.value) : null,
          totalInterest: total ? Number(total.querySelector('.sum-interest').dataset.value) : null,
        };
      });
      const apiTotals = {
        payment: winAmort.series.reduce((s, r) => s + r.payment, 0),
        principal: winAmort.series.reduce((s, r) => s + r.principal, 0),
        interest: winAmort.series.reduce((s, r) => s + r.interest, 0),
      };
      const rowsOfYear = (y) => winAmort.series.filter((r) => r.month.startsWith(y));
      const allYears = [...new Set(winAmort.series.map((r) => r.month.slice(0, 4)))];
      const thisYear = String(new Date().getFullYear());
      let sc = await schedInfo();
      check('after the All range change the schedule sits on the window\u2019s first year page, listing exactly that year\u2019s months',
        sc.year === allYears[0] && sc.months.length === rowsOfYear(allYears[0]).length
          && sc.months.length > 0 && sc.months.every((m) => m.endsWith(allYears[0])),
        JSON.stringify({ year: sc.year, n: sc.months.length, exp: rowsOfYear(allYears[0]).length }));
      check('schedule Total row sums the whole range exactly (payment / principal / interest)',
        sc.totalPayment !== null
          && Math.abs(sc.totalPayment - apiTotals.payment) < 0.005
          && Math.abs(sc.totalPrincipal - apiTotals.principal) < 0.005
          && Math.abs(sc.totalInterest - apiTotals.interest) < 0.005,
        JSON.stringify({ got: [sc.totalPayment, sc.totalPrincipal, sc.totalInterest], api: apiTotals }));
      check('schedule Total row labels its range and the payoff month inside it',
        sc.totalLabel.includes('Total') && !!winAmort.payoffMonth
          && sc.totalLabel.includes(`Paid off ${winAmort.payoffMonth}`),
        sc.totalLabel);
      await page.evaluate((y) => {
        const s = document.querySelector('#scheduleYearSelect');
        s.value = y;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, allYears[0]);
      await wait(300);
      const scFirst = await schedInfo();
      check('jumping the schedule to the first year lists only that year\u2019s months',
        scFirst.year === allYears[0] && scFirst.months.length === rowsOfYear(allYears[0]).length
          && scFirst.months.every((m) => m.endsWith(allYears[0])),
        JSON.stringify({ year: scFirst.year, n: scFirst.months.length, exp: rowsOfYear(allYears[0]).length }));
      await page.evaluate(() => document.querySelector('#scheduleNextYear').click());
      await wait(300);
      const scNext = await schedInfo();
      check('the next-year pager steps to the following year\u2019s months',
        scNext.year === allYears[1] && scNext.months.length === rowsOfYear(allYears[1]).length
          && scNext.months.every((m) => m.endsWith(allYears[1])),
        JSON.stringify({ year: scNext.year, n: scNext.months.length, exp: rowsOfYear(allYears[1]).length }));
      check('the Total row does not change when the schedule page turns',
        scNext.totalPayment === sc.totalPayment && scNext.totalPrincipal === sc.totalPrincipal
          && scNext.totalInterest === sc.totalInterest && scNext.totalLabel === sc.totalLabel,
        JSON.stringify({ before: sc.totalLabel, after: scNext.totalLabel }));

      // ---- Range switch re-fetches the projection (no stale clip) ----
      // A prime-spread fixture backdated to Dec 2024. Switching the
      // range must re-request the projection from the server (which
      // re-prices at the latest prime history) rather than re-clip
      // the payload already on the page — and the recomputation must
      // not drift: March 2025's interest in the monthly table equals
      // the hand-computed value at that month's own prime (stub
      // history: Mar 2025 prime 4.95 -> rate 3.95), before and after
      // the switch alike.
      r = await req('POST', '/api/properties', {
        address: '321 Refetch Crescent, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
      });
      const refetchPid = r.data.id;
      await req('POST', `/api/properties/${refetchPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await req('PUT', `/api/properties/${refetchPid}`, { amortization_years: 25 });
      await page.goto(`http://ff.local/#property/${refetchPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const schedRow = (label) => page.evaluate((lbl) => {
        const tr = [...document.querySelectorAll('#scheduleRows tr')]
          .find((x) => x.children[0].textContent === lbl);
        if (!tr) return null;
        const num = (i) => Number(tr.children[i].textContent.replace(/[$,]/g, ''));
        return { payment: num(1), principal: num(2), interest: num(3), remaining: num(4) };
      }, label);
      const pickYear = (y) => page.evaluate((yy) => {
        const s = document.querySelector('#scheduleYearSelect');
        s.value = yy;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, y);
      await pickYear('2025');
      await wait(300);
      const febBefore = await schedRow('Feb 2025');
      const marBefore = await schedRow('Mar 2025');
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(1200);
      await pickYear('2025');
      await wait(300);
      const febAfter = await schedRow('Feb 2025');
      const marAfter = await schedRow('Mar 2025');
      // The table displays whole dollars, so the hand-check rounds
      // the same way (February's displayed remaining x the monthly
      // rate at March's own prime, 4.95 - 1 = 3.95%).
      const marHand = febBefore ? Math.round(febBefore.remaining * engineMonthlyRate(3.95)) : null;
      check('range switch re-fetches: March 2025 interest equals its own month\u2019s prime hand-check, unchanged by the switch',
        !!marBefore && !!marAfter && !!febBefore
          && Math.abs(marBefore.interest - marHand) <= 1
          && marAfter.interest === marBefore.interest
          && febAfter.remaining === febBefore.remaining,
        JSON.stringify({ marBefore, marAfter, marHand }));
      await req('DELETE', `/api/properties/${refetchPid}`);

      // ---- Detail range: picked start/end months drive everything ----
      // The user's real shape (his Christina Pl mortgage): $1.35M
      // at 2024-12-17, Prime - 1.00, 25-year amortization. He reads
      // the schedule Total for a span he picks BY MONTH — Jan 2025
      // to Oct 2026 in his message ("Total — Jan 2025 to Oct 2026
      // (22 months)") — and every figure in the row must come from
      // exactly those months of the series.
      r = await req('POST', '/api/properties', {
        address: '555 Range Picker Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
      });
      const rangePid = r.data.id;
      await req('POST', `/api/properties/${rangePid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await req('PUT', `/api/properties/${rangePid}`, { amortization_years: 25 });
      const rangeAmort = (await req('GET', `/api/properties/${rangePid}/amortization`)).data;
      // rangePid reuses the just-deleted refetchPid's id (SQLite
      // recycles the max rowid), so a direct hash goto to it is a
      // no-op navigation and the page would keep showing the
      // deleted property's view — detour via the root hash so
      // the hash really changes and the property loads.
      await page.goto('http://ff.local/#', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(400);
      await page.goto(`http://ff.local/#property/${rangePid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      // A fresh property load (no range change yet) still opens
      // the schedule on today's year page — the first-page reset
      // belongs to range changes only. Wait for THIS property's
      // schedule to settle first (the table can still show the
      // previous property's rows while the refetch is in flight).
      const openYear = String(new Date().getFullYear());
      const openRows = rangeAmort.series.filter((x) => x.month.startsWith(openYear) && x.month <= curMonthStr());
      await page.waitForFunction((y, n) => {
        const sel = document.querySelector('#scheduleYearSelect');
        return !!sel && sel.value === y
          && document.querySelectorAll('#scheduleRows tr').length === n;
      }, { timeout: 20000 }, openYear, openRows.length).catch(() => {});
      const scOpen = await page.evaluate(() => ({
        year: document.querySelector('#scheduleYearSelect').value,
        months: [...document.querySelectorAll('#scheduleRows tr')].map((tr) => tr.children[0].textContent),
      }));
      check('a freshly opened property schedule sits on today’s year page (the first-page reset is for range changes only)',
        scOpen.year === openYear && scOpen.months.length === openRows.length
          && scOpen.months.length > 0 && scOpen.months.every((m) => m.endsWith(openYear)),
        JSON.stringify({ got: scOpen, exp: openRows.length }));
      // Drive the custom month picker like a user: open the
      // field's popover, step its year to the target year, click
      // the month cell (which applies the pair and refetches).
      const pickMonthUI = (fieldSel, ym) => page.evaluate(([sel, target]) => {
        document.querySelector(sel).click();
        const ty = Number(target.slice(0, 4));
        const yearEl = document.querySelector('#monthPopYear');
        let guard = 0;
        while (Number(yearEl.textContent) !== ty && guard++ < 80) {
          const btn = ty < Number(yearEl.textContent)
            ? document.querySelector('#monthPopPrev') : document.querySelector('#monthPopNext');
          if (!btn || btn.disabled) break;
          btn.click();
        }
        const cell = document.querySelector(`#monthPopGrid button[data-ym="${target}"]`);
        if (!cell || cell.disabled) throw new Error(`month cell ${target} not pickable`);
        cell.click();
      }, [fieldSel, ym]);
      const setRange = async (start, end) => {
        await pickMonthUI('#rangeStart', start);
        await wait(1400); // the start pick applies + refetches before the end pick
        await pickMonthUI('#rangeEnd', end);
      };
      const totalInfo = () => page.evaluate(() => {
        const total = document.querySelector('#scheduleTotalRow');
        if (!total) return null;
        return {
          label: total.children[0].textContent,
          payment: Number(total.querySelector('.sum-payment').dataset.value),
          principal: Number(total.querySelector('.sum-principal').dataset.value),
          interest: Number(total.querySelector('.sum-interest').dataset.value),
          remaining: Number(total.children[4].textContent.replace(/[$,]/g, '')),
        };
      });
      const spanSums = (rows) => ({
        payment: rows.reduce((s, x) => s + x.payment, 0),
        principal: rows.reduce((s, x) => s + x.principal, 0),
        interest: rows.reduce((s, x) => s + x.interest, 0),
      });
      await setRange('2025-01', '2026-10');
      await wait(1200);
      const janOct = rangeAmort.series.filter((x) => x.month >= '2025-01' && x.month <= '2026-10');
      const janOctSums = spanSums(janOct);
      const tot1 = await totalInfo();
      check('picked range Jan 2025-Oct 2026: the Total row covers exactly those 22 months',
        janOct.length === 22 && !!tot1 && tot1.label.includes('Total — Jan 2025 to Oct 2026 (22 months)'),
        JSON.stringify({ n: janOct.length, label: tot1 && tot1.label }));
      check('picked range: Total sums and the ending balance equal the series rows inside it',
        !!tot1
          && Math.abs(tot1.payment - janOctSums.payment) < 0.005
          && Math.abs(tot1.principal - janOctSums.principal) < 0.005
          && Math.abs(tot1.interest - janOctSums.interest) < 0.005
          && Math.abs(tot1.remaining - janOct[janOct.length - 1].balance) < 0.51,
        JSON.stringify({ tot: tot1, sums: janOctSums, lastBal: janOct[janOct.length - 1].balance }));
      const barsPicked = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const ints = c ? c.data.datasets.find((d) => d.label === 'Interest portion') : null;
        return ints ? ints.data.map((p) => p.x) : null;
      });
      check('picked range: the chart bars are exactly the 22 picked months',
        Array.isArray(barsPicked) && barsPicked.length === 22
          && Math.abs(barsPicked[0] - ymDec('2025-01')) < 0.001
          && Math.abs(barsPicked[barsPicked.length - 1] - ymDec('2026-10')) < 0.001,
        JSON.stringify(barsPicked && { n: barsPicked.length, first: barsPicked[0], last: barsPicked[barsPicked.length - 1] }));
      const schedYearsPicked = await page.evaluate(() => [...document.querySelectorAll('#scheduleYearSelect option')].map((o) => o.value));
      check('picked range: the schedule pages are the years inside the range',
        JSON.stringify(schedYearsPicked) === JSON.stringify(['2025', '2026']), JSON.stringify(schedYearsPicked));
      // The VISIBLE rows follow the pick too: a range change
      // reopens the schedule on the range's first year page (the
      // old auto-page pinned today's year, so a pick that kept
      // 2026 in range left the visible rows byte-identical and
      // the table looked unresponsive — the user's report).
      const visibleRows = () => page.evaluate(() => {
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const toYM = (label) => {
          const [mon, yr] = label.trim().split(' ');
          return `${yr}-${String(MON.indexOf(mon) + 1).padStart(2, '0')}`;
        };
        return {
          months: [...document.querySelectorAll('#scheduleRows tr')].map((tr) => toYM(tr.children[0].textContent)),
          page: document.querySelector('#scheduleYearSelect').value,
          pageCount: document.querySelectorAll('#scheduleYearSelect option').length,
          prevDisabled: document.querySelector('#schedulePrevYear').disabled,
          nextDisabled: document.querySelector('#scheduleNextYear').disabled,
        };
      });
      const vis1 = await visibleRows();
      check('picked range: the visible schedule rows are the range first page (Jan-Dec 2025), all inside the range',
        vis1.page === '2025' && vis1.pageCount === 2 && vis1.months.length === 12
          && vis1.months[0] === '2025-01' && vis1.months[vis1.months.length - 1] === '2025-12'
          && vis1.months.every((m) => m >= '2025-01' && m <= '2026-10')
          && vis1.prevDisabled === true && vis1.nextDisabled === false,
        JSON.stringify(vis1));
      await page.evaluate(() => document.querySelector('#scheduleNextYear').click());
      await wait(300);
      const vis2 = await visibleRows();
      check('picked range: the second page holds the remaining rows (Jan-Oct 2026), so the pages match the row count',
        vis2.page === '2026' && vis2.months.length === 10
          && vis2.months[0] === '2026-01' && vis2.months[vis2.months.length - 1] === '2026-10'
          && vis2.nextDisabled === true,
        JSON.stringify(vis2));
      const pagerText = await page.evaluate(() => document.querySelector('#schedulePager').textContent);
      check('the schedule pager note (explanation prose) is gone',
        !pagerText.includes('one year per page') && !pagerText.includes('Total row covers'),
        pagerText.trim());

      // A second, narrower pick moves everything again.
      await setRange('2025-06', '2025-12');
      await wait(1200);
      const junDec = rangeAmort.series.filter((x) => x.month >= '2025-06' && x.month <= '2025-12');
      const junDecSums = spanSums(junDec);
      const tot2 = await totalInfo();
      check('re-picked range Jun-Dec 2025: Total label, sums and ending balance follow the new pair',
        junDec.length === 7 && !!tot2 && tot2.label.includes('Total — Jun 2025 to Dec 2025 (7 months)')
          && Math.abs(tot2.payment - junDecSums.payment) < 0.005
          && Math.abs(tot2.principal - junDecSums.principal) < 0.005
          && Math.abs(tot2.interest - junDecSums.interest) < 0.005
          && Math.abs(tot2.remaining - junDec[junDec.length - 1].balance) < 0.51,
        JSON.stringify({ tot: tot2, sums: junDecSums }));
      const vis3 = await visibleRows();
      check('re-picked range: the visible rows are exactly Jun-Dec 2025 on a single first page',
        vis3.page === '2025' && vis3.pageCount === 1 && vis3.months.length === 7
          && vis3.months[0] === '2025-06' && vis3.months[vis3.months.length - 1] === '2025-12',
        JSON.stringify(vis3));

      // Presets refill the pair: All = the whole data span; a
      // look-back preset ends at the current month.
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(1200);
      const rpAll = await page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
        active: (document.querySelector('#rangeBtns button.active') || {}).dataset?.months,
      }));
      check('All refills the pair with the whole data span',
        rpAll.start === '2024-12' && rpAll.end === rangeAmort.series[rangeAmort.series.length - 1].month
          && rpAll.active === '0',
        JSON.stringify(rpAll));
      const visAll = await visibleRows();
      const allSeriesYears = [...new Set(rangeAmort.series.map((x) => x.month.slice(0, 4)))];
      const firstYearRows = rangeAmort.series.filter((x) => x.month.startsWith(allSeriesYears[0]));
      check('All preset: the schedule reopens on the first page of the widened span',
        visAll.page === allSeriesYears[0] && visAll.pageCount === allSeriesYears.length
          && visAll.months.length === firstYearRows.length
          && visAll.months[0] === firstYearRows[0].month
          && visAll.months[visAll.months.length - 1] === firstYearRows[firstYearRows.length - 1].month
          && visAll.prevDisabled === true,
        JSON.stringify(visAll));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(1200);
      const rp1y = await page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
        active: (document.querySelector('#rangeBtns button.active') || {}).dataset?.months,
      }));
      check('the 1-year preset refills the pair ending at the current month (12 months inclusive)',
        rp1y.end === curMonthStr() && rp1y.start === addMonthsStr(rp1y.end, -11) && rp1y.active === '12',
        JSON.stringify(rp1y));

      // A start past the end clamps the end up to the start.
      await setRange('2026-05', '2026-03');
      await wait(1200);
      const rpClamp = await page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
        anyActive: !!document.querySelector('#rangeBtns button.active'),
      }));
      check('start past end clamps the end up to the start (and picking clears the preset)',
        rpClamp.start === '2026-05' && rpClamp.end === '2026-05' && rpClamp.anyActive === false,
        JSON.stringify(rpClamp));
      const mayRow = rangeAmort.series.find((x) => x.month === '2026-05');
      const totClamp = await totalInfo();
      check('the clamped single-month range totals exactly that month',
        !!totClamp && !!mayRow && totClamp.label.includes('Total — May 2026 to May 2026 (1 month)')
          && Math.abs(totClamp.payment - mayRow.payment) < 0.005,
        JSON.stringify(totClamp));

      // ---- The From/To month picker UI ----
      // Button fields showing "Mon YYYY" (machine value on
      // data-value) and one shared popover: year stepper + a
      // 12-month grid, out-of-span months disabled.
      const fieldState = () => page.evaluate(() => ({
        startText: document.querySelector('#rangeStart').textContent,
        startVal: document.querySelector('#rangeStart').dataset.value,
        endText: document.querySelector('#rangeEnd').textContent,
        endVal: document.querySelector('#rangeEnd').dataset.value,
        popHidden: document.querySelector('#monthPop').classList.contains('hidden'),
        startExpanded: document.querySelector('#rangeStart').getAttribute('aria-expanded'),
        endExpanded: document.querySelector('#rangeEnd').getAttribute('aria-expanded'),
      }));
      const fs0 = await fieldState();
      check('From/To are button fields showing "Mon YYYY" with the month on data-value, picker closed',
        fs0.startText === 'May 2026' && fs0.startVal === '2026-05'
          && fs0.endText === 'May 2026' && fs0.endVal === '2026-05' && fs0.popHidden,
        JSON.stringify(fs0));
      await page.evaluate(() => document.querySelector('#rangeStart').click());
      await wait(250);
      const pop1 = await page.evaluate(() => ({
        hidden: document.querySelector('#monthPop').classList.contains('hidden'),
        year: document.querySelector('#monthPopYear').textContent,
        selYm: (document.querySelector('#monthPopGrid button.sel') || {}).dataset?.ym,
        expanded: document.querySelector('#rangeStart').getAttribute('aria-expanded'),
      }));
      check('clicking From opens the picker on the field year with its month selected',
        !pop1.hidden && pop1.year === '2026' && pop1.selYm === '2026-05' && pop1.expanded === 'true',
        JSON.stringify(pop1));
      await page.evaluate(() => document.querySelector('#monthPopNext').click());
      const yrNext = await page.evaluate(() => document.querySelector('#monthPopYear').textContent);
      await page.evaluate(() => document.querySelector('#monthPopPrev').click());
      await page.evaluate(() => document.querySelector('#monthPopPrev').click());
      await page.evaluate(() => document.querySelector('#monthPopPrev').click());
      const popMin = await page.evaluate(() => ({
        year: document.querySelector('#monthPopYear').textContent,
        prevDisabled: document.querySelector('#monthPopPrev').disabled,
        janDisabled: document.querySelector('#monthPopGrid button[data-ym="2024-01"]').disabled,
        decDisabled: document.querySelector('#monthPopGrid button[data-ym="2024-12"]').disabled,
      }));
      check('the year stepper steps one year at a time and stops at the span start (2024: Jan-Nov disabled, Dec pickable)',
        yrNext === '2027' && popMin.year === '2024' && popMin.prevDisabled && popMin.janDisabled && !popMin.decDisabled,
        JSON.stringify({ yrNext, popMin }));
      await page.keyboard.press('Escape');
      await wait(150);
      const escClosed = await page.evaluate(() => document.querySelector('#monthPop').classList.contains('hidden'));
      check('Esc closes the month picker', escClosed);
      await page.evaluate(() => document.querySelector('#rangeStart').click());
      await wait(200);
      await page.evaluate(() => document.querySelector('#rangeEnd').click());
      await wait(200);
      const retarget = await fieldState();
      check('one picker only: clicking To while From is open retargets the same popover',
        !retarget.popHidden && retarget.startExpanded === 'false' && retarget.endExpanded === 'true',
        JSON.stringify(retarget));
      await page.evaluate(() => document.querySelector('#projectionPanel h3').click());
      await wait(200);
      const outsideClosed = await page.evaluate(() => document.querySelector('#monthPop').classList.contains('hidden'));
      check('clicking outside closes the month picker', outsideClosed);
      // A full pick through the popover moves the field value, its
      // display text, the chart bars and the Total together.
      await pickMonthUI('#rangeStart', '2025-01');
      await wait(1400);
      const fsPick = await fieldState();
      const totPick = await totalInfo();
      const barsPick = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const ints = c ? c.data.datasets.find((d) => d.label === 'Interest portion') : null;
        return ints ? ints.data.length : null;
      });
      check('picking a month moves data-value, display text, chart bars and the Total together',
        fsPick.startVal === '2025-01' && fsPick.startText === 'Jan 2025' && fsPick.popHidden
          && barsPick === 17
          && !!totPick && totPick.label.includes('Total — Jan 2025 to May 2026 (17 months)'),
        JSON.stringify({ fsPick, barsPick, label: totPick && totPick.label }));
      await req('DELETE', `/api/properties/${rangePid}`);

      // Portfolio combined chart: the same look-back window applies
      // to its assessed line (years are the union across properties;
      // this fixture's 2019 is the earliest year on record). Being a
      // carry-forward total, the line also carries the pre-window
      // total in at the left edge and the last total forward to
      // today, so it spans the whole window.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      // A hash jump reuses the section's cached load (assetsLoaded), so
      // reload once to make the portfolio read the fixture just created.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const pfYears = () => page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.label === 'Assessed value (all properties)') : null;
        return ds ? ds.data.map((p) => p.x) : null;
      });
      const pfPts = () => page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.label === 'Assessed value (all properties)') : null;
        return ds ? ds.data : null;
      });
      const pfApi = await req('GET', '/api/properties/portfolio');
      const rowOf = (y) => (pfApi.data.assessedByYear || []).find((rw) => rw.year === y) || {};
      const axisPf = () => page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        if (!c) return null;
        const xs = c.data.datasets.flatMap((d) => d.data.map((p) => p.x));
        return { min: c.scales.x.min, max: c.scales.x.max, dataMax: Math.max(...xs) };
      });
      const pfDefPts = await pfPts();
      const tdP = await todayDec();
      const pfIntYears = (pfDefPts || []).map((p) => p.x).filter((x) => Number.isInteger(x));
      check('portfolio assessed line defaults to the recent 5 years, carried in at the left edge',
        JSON.stringify(pfIntYears) === JSON.stringify([2022, 2023, 2024, 2025, 2026])
          && !!pfDefPts && Math.abs(pfDefPts[0].x - (tdP - 5)) < 0.05 && pfDefPts[0].y === rowOf(2021).total
          && Math.abs(pfDefPts[pfDefPts.length - 1].x - tdP) < 0.02,
        JSON.stringify(pfDefPts));
      let pax = await axisPf();
      check('portfolio axis is the 5-year look-back ending today',
        !!pax && Math.abs(pax.max - tdP) < 0.02 && Math.abs(pax.min - (tdP - 5)) < 0.05,
        JSON.stringify(pax && { min: pax.min, max: pax.max }));
      const pfY = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        return c ? { min: c.scales.y.min, max: c.scales.y.max } : null;
      });
      check('portfolio y axis starts at 0', !!pfY && pfY.min === 0, JSON.stringify(pfY));
      // Total equity line: the endpoint's equityByMonth is the
      // carry-forward assessed total in force minus the total
      // outstanding on the same month grid, and the chart plots
      // exactly those values as its 'equity' dataset.
      const eqApi = pfApi.data.equityByMonth || [];
      const assessedInForce = (y) => { let v = null; for (const rw of pfApi.data.assessedByYear) { if (rw.year <= y) v = rw.total; else break; } return v; };
      const eqIdentityOk = eqApi.length > 0 && eqApi.every((e) => {
        const a = assessedInForce(Number(e.month.slice(0, 4)));
        const out = (pfApi.data.outstandingByMonth.find((m) => m.month === e.month) || {}).total;
        return a === null ? e.value === null : Math.abs(e.value - (Math.round((a - out) * 100) / 100)) < 0.005;
      });
      const eqDs = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.key === 'equity') : null;
        return ds ? { label: ds.label, pts: ds.data } : null;
      });
      const eqLastPt = eqDs && eqDs.pts.length ? eqDs.pts[eqDs.pts.length - 1] : null;
      const eqLastMonth = eqLastPt ? `${Math.floor(eqLastPt.x)}-${String(Math.round((eqLastPt.x - Math.floor(eqLastPt.x)) * 12) + 1).padStart(2, '0')}` : null;
      const eqApiAtLast = eqLastMonth ? (eqApi.find((e) => e.month === eqLastMonth) || {}).value : null;
      check('portfolio chart carries a Total equity line equal to assessed (carry-forward) minus outstanding at every month',
        !!eqDs && eqDs.label === 'Total equity' && eqIdentityOk
          && !!eqLastPt && eqApiAtLast != null && Math.abs(eqLastPt.y - eqApiAtLast) < 0.005,
        JSON.stringify({ identityOk: eqIdentityOk, chartLast: eqLastPt, apiAtLast: eqApiAtLast, lastMonth: eqLastMonth }));
      await page.evaluate(() => document.querySelector('#pfRangeBtns button[data-months="12"]').click());
      await wait(600);
      const pf1Pts = await pfPts();
      const tdP1 = await todayDec();
      pax = await axisPf();
      check('portfolio 1-year view: axis is the year ending today and the assessed line spans it',
        !!pax && Math.abs(pax.max - tdP1) < 0.02 && Math.abs(pax.max - pax.min - 1) < 0.02
          && Array.isArray(pf1Pts) && pf1Pts.length >= 3
          && Math.abs(pf1Pts[0].x - pax.min) < 0.001 && pf1Pts[0].y === rowOf(2025).total
          && pf1Pts.some((p) => p.x === 2026)
          && Math.abs(pf1Pts[pf1Pts.length - 1].x - tdP1) < 0.02,
        JSON.stringify({ pax: pax && { min: pax.min, max: pax.max }, pf1Pts }));
      await page.evaluate(() => document.querySelector('#pfRangeBtns button[data-months="0"]').click());
      await wait(600);
      const pfAll = await pfYears();
      check('portfolio All range widens the assessed line to every recorded year',
        Array.isArray(pfAll) && pfAll.length === 8 && pfAll[0] === 2019 && pfAll[pfAll.length - 1] === 2026, JSON.stringify(pfAll));
      pax = await axisPf();
      check('portfolio All axis is the exact data extent (2019 to the last projected month)',
        !!pax && pax.min === 2019 && pax.max === pax.dataMax,
        JSON.stringify(pax && { min: pax.min, max: pax.max, dataMax: pax.dataMax }));

      // The user's real shape: five assessed years (2022-2026) and
      // one variable prime-spread segment, but NO monthly payment and
      // NO amortization. The assessed values must render as yearly
      // points joined by straight line segments (no smoothing curve,
      // no step), the missing projection must be announced beside
      // the chart, and after an edit on this page the portfolio must
      // show fresh numbers without a reload.
      r = await req('POST', '/api/properties', {
        address: '966 Step Test Place, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const stepPid = r.data.id;
      const stepVals = { 2022: 1730000, 2023: 1903000, 2024: 1955000, 2025: 2002000, 2026: 1931000 };
      for (const [y, v] of Object.entries(stepVals)) {
        await req('POST', `/api/properties/${stepPid}/value-history`, { year: Number(y), value: v });
      }
      await req('POST', `/api/properties/${stepPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await page.goto(`http://ff.local/#property/${stepPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const stepCfg = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Assessed value');
        return ds ? { showLine: ds.showLine, tension: ds.tension, stepped: ds.stepped, pts: ds.data } : null;
      });
      check('detail assessed values are joined by straight lines (no curve, no step)',
        !!stepCfg && stepCfg.showLine !== false && stepCfg.tension === 0 && !stepCfg.stepped,
        JSON.stringify(stepCfg && { showLine: stepCfg.showLine, tension: stepCfg.tension, stepped: stepCfg.stepped }));
      check('detail assessed points are the five recorded years at their values',
        !!stepCfg && stepCfg.pts.length === 5
          && stepCfg.pts.every((p) => stepVals[p.x] === p.y),
        JSON.stringify(stepCfg && stepCfg.pts));
      const combMsg = await page.evaluate(() => document.querySelector('#combinedMsg').textContent);
      check('detail chart A announces the missing payment beside the chart (NO_PAYMENT)',
        combMsg.includes('set the remaining amortization'), combMsg);
      const stepLabels = await page.evaluate(() => window.__fmCharts.a.data.datasets.map((d) => d.label));
      check('with no payment there are no payment bars (projection absent, note shown)',
        !stepLabels.includes('Interest portion') && !stepLabels.includes('Principal portion'),
        JSON.stringify(stepLabels));
      // Pixel-level proof of the straight-line rendering: the canvas
      // column at x = 2025 (inside the chart area only, so the legend
      // swatch cannot interfere) must carry the 2025 marker at the
      // 2025 value, and the column at mid-2025 (x = 2025.5) must carry
      // the assessed green at the straight-line midpoint of the two
      // years, (2,002,000 + 1,931,000) / 2 = 1,966,500 — a smoothed
      // curve would bow away from it and a step would sit on one of
      // the two year values instead.
      const scanAt = (xVal) => page.evaluate((xv) => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        c.update('none');
        const canvas = c.canvas;
        const dpr = canvas.width / c.width;
        const xPix = Math.min(canvas.width - 1, Math.max(0, Math.round(c.scales.x.getPixelForValue(xv) * dpr)));
        const top = Math.floor(c.chartArea.top * dpr);
        const bottom = Math.min(canvas.height, Math.ceil(c.chartArea.bottom * dpr));
        const img = canvas.getContext('2d').getImageData(xPix, top, 1, bottom - top).data;
        const ys = [];
        for (let y = top; y < bottom; y++) {
          const o = (y - top) * 4;
          if (img[o + 3] > 200 && Math.abs(img[o] - 46) < 30 && Math.abs(img[o + 1] - 125) < 30 && Math.abs(img[o + 2] - 79) < 30) ys.push(y);
        }
        return { hits: ys.length, value: ys.length ? c.scales.y.getValueForPixel(ys[Math.floor(ys.length / 2)] / dpr) : null };
      }, xVal);
      const scanPt = await scanAt(2025);
      check('detail assessed marker sits at the 2025 value (2,002,000)',
        !!scanPt && scanPt.hits > 0 && Math.abs(scanPt.value - 2002000) < 10000, JSON.stringify(scanPt));
      const scanMid = await scanAt(2025.5);
      check('a straight line joins the points (mid-2025 reads the two years\u2019 average, 1,966,500)',
        !!scanMid && scanMid.hits > 0 && Math.abs(scanMid.value - 1966500) < 10000, JSON.stringify(scanMid));

      // Edit a value point through this page's own history editor
      // (the Assessment History modal — its form used to leave the
      // assets cache untouched), then go back to Properties by hash
      // only — no reload. The dirty mark must make the section
      // refetch: the new property (created after the section's last
      // load) and the portfolio notes must be current.
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(500);
      await focusField('#trendForm [name=year]');
      await page.keyboard.type('2021');
      await focusField('#trendForm [name=value]');
      await page.keyboard.type('1600000');
      await page.evaluate(() => document.querySelector('#trendSubmitBtn').click());
      await wait(1400);
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(300);
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(1800);
      const cardsText = await page.evaluate(() => document.querySelector('#propertyCards').textContent);
      check('after a detail-page edit, returning to Properties refetches (no stale cache)',
        cardsText.includes('966 Step Test Place'), cardsText.slice(0, 120));
      const pfNotesText = await page.evaluate(() => document.querySelector('#pfNotes').textContent);
      check('portfolio notes name the missing payment for a planned-but-unprojected property',
        pfNotesText.includes('set the remaining amortization on its term to project'), pfNotesText);
      const pfIntNote = await page.evaluate(() => document.querySelector('#pfInterestNote').textContent);
      check('portfolio interest note no longer hides the gap behind "with a rate plan"',
        !pfIntNote.includes('with a rate plan') && pfIntNote.includes('based on'), pfIntNote);
      const pfPtsCfg = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.label === 'Assessed value (all properties)') : null;
        return ds ? { showLine: ds.showLine, tension: ds.tension, stepped: ds.stepped, n: ds.data.length } : null;
      });
      check('portfolio assessed values are joined by straight lines (no curve, no step)',
        !!pfPtsCfg && pfPtsCfg.showLine !== false && pfPtsCfg.tension === 0 && !pfPtsCfg.stepped && pfPtsCfg.n >= 5,
        JSON.stringify(pfPtsCfg));

      // ---- Amortization years in Mortgage Terms & Rates derive the payment ----
      // The user's exact shape again (balance + one prime-spread
      // segment, nothing else), driven through the UI this time:
      // typing ONLY the remaining amortization (30) and a lender into
      // Term 1's own form must flip the page from NO_PAYMENT to a
      // full projection — the projection head's Estimated monthly
      // payment stat names the derived payment, the merged chart
      // splits every payment into interest + principal portions
      // that sum to it, and the summary totals agree with the
      // amortization endpoint.
      r = await req('POST', '/api/properties', {
        address: '123 Amort Test Way, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const amortPid = r.data.id;
      await req('POST', `/api/properties/${amortPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await page.goto(`http://ff.local/#property/${amortPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const beforeMsg = await page.evaluate(() => document.querySelector('#combinedMsg').textContent);
      check('amortization UI fixture starts unprojected (NO_PAYMENT)',
        beforeMsg.includes('set the remaining amortization'), beforeMsg);
      const beforeStat = await page.evaluate(() => document.querySelector('#estPaymentValue').textContent);
      check('with no projection yet the Estimated monthly payment stat shows —',
        beforeStat === '—', String(beforeStat));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await focusField('[data-term-form] [name=amortization_years]');
      await page.keyboard.type('30');
      await focusField('[data-term-form] [name=lender]');
      await page.keyboard.type('Scotiabank');
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(2000);
      const amortApi = (await req('GET', `/api/properties/${amortPid}/amortization`)).data;
      check('endpoint calculates the payment from the UI-entered amortization (3.95%, 30y)',
        amortApi.ok === true && Math.abs(amortApi.paymentUsed - 6381.36) < 0.5,
        JSON.stringify({ ok: amortApi.ok, used: amortApi.paymentUsed }));
      const estStat = await page.evaluate(() => {
        const stat = document.querySelector('#estPaymentStat');
        const head = document.querySelector('#projectionPanel .panel-head');
        const v = document.querySelector('#estPaymentValue');
        return {
          inHead: !!stat && !!head && head.contains(stat),
          text: v ? v.textContent : '',
          weight: v ? Number(getComputedStyle(v).fontWeight) : 0,
          tagGone: !document.querySelector('#estPaymentTag'),
        };
      });
      check('the projection head carries an Estimated monthly payment stat, bold, equal to the endpoint payment (no entered/auto tag)',
        estStat.inHead && Math.abs(parseFloat(estStat.text.replace(/[^0-9.]/g, '')) - amortApi.paymentUsed) < 0.5
          && estStat.weight >= 600 && estStat.tagGone,
        JSON.stringify(estStat));
      const metaGrid = await page.evaluate(() => {
        const meta = document.querySelector('#mortgageMeta');
        const pay = document.querySelector('#metaCurrentPayment');
        return {
          labels: [...meta.querySelectorAll('.meta-k')].map((e) => e.textContent.trim()),
          inputs: meta.querySelectorAll('input, select, textarea').length,
          opening: document.querySelector('#metaOpeningPrincipal').textContent,
          current: document.querySelector('#metaCurrentPrincipal').textContent,
          payment: pay.textContent,
          paymentTagGone: !document.querySelector('#metaPaymentTag'),
          paymentWeight: Number(getComputedStyle(pay).fontWeight),
          remaining: document.querySelector('#metaRemainingAmort').textContent,
          lender: document.querySelector('#metaCurrentLender').textContent,
          formGone: !document.querySelector('#mortgageForm'),
          stray: [...document.querySelectorAll('#mortgageModal [name=lender], #mortgageModal [name=amortization_years]')]
            .filter((el) => !el.closest('[data-term-form]')).length,
          prose: document.querySelector('#mortgageModal').textContent,
        };
      });
      check('modal metadata: exactly the five derived figures, no inputs among them',
        JSON.stringify(metaGrid.labels) === JSON.stringify(['Opening principal ($)', 'Current Principal', 'Current Monthly Payment', 'Remaining amortization (years)', 'Current Lender'])
          && metaGrid.inputs === 0,
        JSON.stringify(metaGrid.labels));
      check('modal metadata values derive from the terms and the projection (payment bold, no source tag)',
        metaGrid.opening.includes('1,350,000') && metaGrid.current.includes('1,350,000')
          && metaGrid.payment.includes('6,381') && metaGrid.paymentTagGone && metaGrid.paymentWeight >= 600
          && metaGrid.remaining === '30.0' && metaGrid.lender === 'Scotiabank',
        JSON.stringify(metaGrid));
      check('the property-level mortgage form is gone; lender/amortization live only in term forms',
        metaGrid.formGone && metaGrid.stray === 0,
        JSON.stringify({ formGone: metaGrid.formGone, stray: metaGrid.stray }));
      check('the tutorial prose is gone from the modal',
        !metaGrid.prose.includes('Canadian lenders: insured mortgages are usually capped')
          && !metaGrid.prose.includes('A mortgage runs as a chain of terms')
          && !metaGrid.prose.includes('Monthly payment derived from the remaining amortization'),
        metaGrid.prose.slice(0, 200));
      // Prime history: no banner lives in this modal — no title
      // line, no "Recent: …" string, no standing chart. The
      // prime-spread segment's rate text is a LINK; clicking it
      // opens the prime modal with the stepped history chart.
      // Its steps are the stored history's change points (read
      // back from the API, so both sides walk the same series)
      // and its last value is the current prime.
      const primeNow = (await req('GET', '/api/prime')).data;
      const noBanner = await page.evaluate(() => {
        const link = document.querySelector('#segmentRows [data-prime-link]');
        return {
          bannerGone: !document.querySelector('#primeBanner') && !document.querySelector('#primeChanges')
            && !document.querySelector('#primeChartWrap'),
          modalText: document.querySelector('#mortgageModal').textContent,
          staleHidden: document.querySelector('#primeStaleNote').classList.contains('hidden'),
          link: link ? { text: link.textContent, start: link.dataset.segStart } : null,
        };
      });
      check('the Mortgage modal carries no prime banner and no standing chart (stale line hidden while fresh)',
        noBanner.bannerGone && !noBanner.modalText.includes('Bank of Canada prime:') && noBanner.staleHidden,
        JSON.stringify({ bannerGone: noBanner.bannerGone, staleHidden: noBanner.staleHidden }));
      check('the prime-spread segment rate renders as a link carrying the segment start date',
        !!noBanner.link && noBanner.link.text.includes('Prime') && noBanner.link.start === '2024-12-17',
        JSON.stringify(noBanner.link));
      let primeUi = null;
      for (let i = 0; i < 20; i++) {
        primeUi = await page.evaluate(() => {
          const canvas = document.querySelector('#primeChart');
          const rect = canvas ? canvas.getBoundingClientRect() : null;
          const c = window.__fmCharts.prime;
          const ds = c ? c.data.datasets[0] : null;
          return {
            open: !document.querySelector('#primeModal').classList.contains('hidden'),
            hasChart: !!c,
            stepped: ds ? ds.stepped : null,
            ys: ds ? [...new Set(ds.data.map((pt) => pt.y))].sort((a, b) => a - b) : [],
            lastY: ds ? ds.data[ds.data.length - 1].y : null,
            w: rect ? rect.width : 0,
            h: rect ? rect.height : 0,
            head: document.querySelector('#primeModalCurrent').textContent,
          };
        });
        if (primeUi.hasChart) break;
        // (Re)click the link: a first click can land before
        // loadPrime has cached the history; opening is idempotent.
        await page.evaluate(() => {
          const a = document.querySelector('#segmentRows [data-prime-link]');
          if (a) a.click();
        });
        await wait(300);
      }
      const histRates = [...new Set((primeNow.history || []).map((h) => h.rate))].sort((a, b) => a - b);
      check('clicking the rate link opens the prime modal with the stepped prime history chart',
        primeUi.open && primeUi.hasChart && primeUi.stepped === 'after'
          && JSON.stringify(primeUi.ys) === JSON.stringify(histRates)
          && primeUi.ys.includes(5.45) && primeUi.ys.includes(4.45)
          && primeUi.lastY === primeNow.current.rate
          && primeUi.head.startsWith('Bank of Canada prime:'),
        JSON.stringify(primeUi));
      check('the prime chart renders at a real size inside the prime modal',
        primeUi.w > 200 && primeUi.h > 100, JSON.stringify({ w: primeUi.w, h: primeUi.h }));
      await page.evaluate(() => document.querySelector('#primeModal [data-close-modal]').click());
      await wait(300);
      const primeGone = await page.evaluate(() => window.__fmCharts.prime);
      check('closing the prime modal destroys the chart instance',
        primeGone === null, JSON.stringify(primeGone));
      // Stale prime: when /api/prime reports the tracked value is
      // stale (fresh: false), the Mortgage modal shows its one
      // small amber line; fresh again, the line is gone. (Stubbed
      // at the fetch layer, as in screenshot-prime — server-side
      // freshness is date-based and covered by the API checks.)
      const staleUi = await page.evaluate(async () => {
        const origFetch = window.fetch.bind(window);
        window.fetch = (url, opts) => {
          if (String(url).includes('/api/prime') && (!opts || !opts.method || opts.method === 'GET')) {
            return Promise.resolve(new Response(JSON.stringify({
              current: { date: '2026-10-21', rate: 4.45 }, fresh: false, asOf: '2026-10-23',
              changes: [], history: [], lastFetchedAt: null,
              source: { name: 'Bank of Canada Valet', series: 'V80691311', label: 'Bank of Canada prime rate' },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return origFetch(url, opts);
        };
        await loadPrime();
        const el = document.querySelector('#primeStaleNote');
        const shown = { hidden: el.classList.contains('hidden'), text: el.textContent };
        window.fetch = origFetch;
        await loadPrime();
        return { shown, hiddenAfterFresh: document.querySelector('#primeStaleNote').classList.contains('hidden') };
      });
      check('stale prime shows one small amber line in the Mortgage modal; fresh hides it',
        !staleUi.shown.hidden && staleUi.shown.text.includes('last known prime of 4.45%')
          && staleUi.hiddenAfterFresh === true,
        JSON.stringify(staleUi));
      const afterMsg = await page.evaluate(() => document.querySelector('#combinedMsg').textContent);
      check('the NO_PAYMENT note beside chart A clears once amortization is in',
        !afterMsg.includes('set the remaining amortization'), afterMsg);
      // The split bars live in the merged chart now (the former
      // Chart B). This fixture's balance date is today, so inside
      // the default look-back window the projection is still in the
      // future — switch to All, where the bars are yearly sums, and
      // compare year by year against the endpoint's series.
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      const chartBInfo = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        const ints = c.data.datasets.find((d) => d.label === 'Interest portion');
        const prins = c.data.datasets.find((d) => d.label === 'Principal portion');
        if (!ints || !prins) return null;
        return {
          types: [ints.type, prins.type],
          labels: [ints.label, prins.label],
          stacks: [ints.stack, prins.stack],
          sums: ints.data.map((p, i) => p.y + prins.data[i].y),
        };
      });
      check('the merged chart carries the stacked Interest portion + Principal portion bars',
        !!chartBInfo && chartBInfo.types[0] === 'bar'
          && chartBInfo.labels[0] === 'Interest portion' && chartBInfo.labels[1] === 'Principal portion'
          && chartBInfo.stacks[0] === 'payment' && chartBInfo.stacks[1] === 'payment',
        JSON.stringify(chartBInfo && { types: chartBInfo.types, labels: chartBInfo.labels, stacks: chartBInfo.stacks }));
      const yearSums = [];
      if (amortApi.series) {
        const byY = new Map();
        for (const r of amortApi.series) {
          const y = r.month.slice(0, 4);
          byY.set(y, (byY.get(y) || 0) + r.payment);
        }
        yearSums.push(...[...byY.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v));
      }
      let splitOk = !!chartBInfo && chartBInfo.sums.length === yearSums.length && yearSums.length > 6;
      if (splitOk) {
        for (let k = 0; k < 6; k++) {
          if (Math.abs(chartBInfo.sums[k] - yearSums[k]) > 1) { splitOk = false; break; }
        }
      }
      check('merged chart bar portions sum to each year\u2019s payments (first 6 years)',
        splitOk, JSON.stringify(chartBInfo && chartBInfo.sums.slice(0, 6)));
      // The old text summary over the chart is gone; the figures
      // live in the schedule's Total row (range = All here, so the
      // row sums the endpoint's whole series) with the payoff month
      // in its label.
      const schedTotal = await page.evaluate(() => {
        const total = document.querySelector('#scheduleTotalRow');
        if (!total) return null;
        return {
          label: total.children[0].textContent,
          payment: Number(total.querySelector('.sum-payment').dataset.value),
          principal: Number(total.querySelector('.sum-principal').dataset.value),
          interest: Number(total.querySelector('.sum-interest').dataset.value),
        };
      });
      const amortTotals = {
        payment: amortApi.series.reduce((s, r) => s + r.payment, 0),
        principal: amortApi.series.reduce((s, r) => s + r.principal, 0),
        interest: amortApi.series.reduce((s, r) => s + r.interest, 0),
      };
      check('schedule Total row carries the projected totals (payment, principal, interest) and the payoff month',
        !!schedTotal
          && Math.abs(schedTotal.payment - amortTotals.payment) < 0.005
          && Math.abs(schedTotal.principal - amortTotals.principal) < 0.005
          && Math.abs(schedTotal.interest - amortTotals.interest) < 0.005
          && Math.abs(schedTotal.interest - amortApi.totalInterest) < 0.02
          && !!amortApi.payoffMonth && schedTotal.label.includes(`Paid off ${amortApi.payoffMonth}`),
        JSON.stringify(schedTotal));
      check('no text summary block remains over the chart',
        await page.evaluate(() => !document.querySelector('#monthlySummary')));
      const lenderBits = await page.evaluate(() => ({
        view: document.querySelector('#propViewBody').textContent,
        meta: document.querySelector('#metaCurrentLender').textContent,
        input: document.querySelector('[data-term-form] [name=lender]').value,
      }));
      check('lender shows in the modal metadata and the term form — and NOT in the slimmed details panel',
        !lenderBits.view.includes('Lender')
          && lenderBits.meta === 'Scotiabank' && lenderBits.input === 'Scotiabank',
        JSON.stringify(lenderBits));
      const inModal = await page.evaluate(() => {
        const modal = document.querySelector('#mortgageModal');
        const inside = (sel) => { const el = document.querySelector(sel); return !!el && modal.contains(el); };
        return {
          all: inside('#mortgageMeta') && inside('#segmentRows') && inside('[data-term-form] [name=payment_frequency]') && inside('#termsWrap'),
          heading: modal.querySelector('h3').textContent.trim(),
          onPage: !!document.querySelector('#view-property #mortgageMeta'),
        };
      });
      check('mortgage terms and rate segments live in the Mortgage Terms & Rates modal, not on the page',
        inModal.all && inModal.heading.startsWith('Mortgage Terms & Rates') && !inModal.onPage,
        JSON.stringify(inModal));
      const portUi = (await req('GET', '/api/properties/portfolio')).data;
      const rowUi = portUi.properties.find((x) => x.id === amortPid);
      check('the UI-entered amortization flips the portfolio state to projected',
        !!rowUi && rowUi.projState === 'projected', JSON.stringify(rowUi && rowUi.projState));
      // There is no PROPERTY-level payment field to type into, and
      // no entered/auto tag: with no override set on this fixture,
      // the stat, the metadata and the term card all show the
      // calculated figure, plain (no strikethrough). The override
      // has NO standalone input: the term form's Monthly payment
      // row shows the figure with an Edit button, its editor
      // input hidden in the same row, empty.
      const noEntry = await page.evaluate(() => {
        const payInput = document.querySelector('[data-pay-block] [name=payment_override]');
        const editBtn = document.querySelector('[data-pay-block] [data-pay-edit]');
        return {
          propertyPaymentInputs: document.querySelectorAll('#mortgageModal [name=mortgage_payment]').length,
          overrideInputs: document.querySelectorAll('#mortgageModal [name=payment_override]').length,
          overrideLabels: [...document.querySelectorAll('#mortgageModal label')].filter((l) => l.textContent.includes('Monthly payment override')).length,
          payInputHidden: !!payInput && payInput.classList.contains('hidden'),
          payInputValue: payInput ? payInput.value : null,
          editBtnShown: !!editBtn && !editBtn.classList.contains('hidden'),
          struck: document.querySelectorAll('#mortgageModal [data-term-payment] s, #metaCurrentPayment s, #estPaymentValue s').length,
          estTag: !!document.querySelector('#estPaymentTag'),
          metaTag: !!document.querySelector('#metaPaymentTag'),
          termFigure: document.querySelector('[data-pay-block] [data-term-payment]').textContent,
          stat: document.querySelector('#estPaymentValue').textContent,
          meta: document.querySelector('#metaCurrentPayment').textContent,
        };
      });
      check('no property payment input and no entered/auto tag — the calculated figure shows plain in the stat, the metadata and the term card (payment editor at rest: figure + Edit, input hidden and empty, no standalone override input)',
        noEntry.propertyPaymentInputs === 0 && noEntry.overrideInputs >= 1 && noEntry.overrideLabels === 0
          && noEntry.payInputHidden && noEntry.payInputValue === '' && noEntry.editBtnShown
          && noEntry.struck === 0 && !noEntry.estTag && !noEntry.metaTag
          && noEntry.termFigure.includes('6,381') && noEntry.stat.includes('6,381') && noEntry.meta.includes('6,381'),
        JSON.stringify(noEntry));
      await req('DELETE', `/api/properties/${amortPid}`);

      // ---- Current Principal is TODAY's remaining balance ----
      // His exact shape (1,350,000 at 2024-12-17, Prime - 1, 25y):
      // the anchor is nearly two years stale, so the detail
      // payload, the modal's Current Principal and the equity
      // readout must all show the projection's balance at the
      // CURRENT month instead. The expected figure is taken
      // dynamically from the returned series (the last row at or
      // before this month, on the Vancouver calendar) — no
      // hard-coded date or dollar value.
      r = await req('POST', '/api/properties', {
        address: '77 Remaining Balance Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
      });
      const remPid = r.data.id;
      await req('PUT', `/api/properties/${remPid}`, { amortization_years: 25 });
      await req('POST', `/api/properties/${remPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      for (const [year, value] of [[2022, 1730000], [2023, 1903000], [2024, 1955000], [2025, 2002000], [2026, 1931000]]) {
        await req('POST', `/api/properties/${remPid}/value-history`, { year, value });
      }
      const remAmort = (await req('GET', `/api/properties/${remPid}/amortization`)).data;
      const vanToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const curMonth = vanToday.slice(0, 7);
      const rowsToNow = (remAmort.series || []).filter((x) => x.month <= curMonth);
      const lastRow = rowsToNow[rowsToNow.length - 1];
      check('remaining-balance fixture projects with rows up to the current month',
        remAmort.ok === true && !!lastRow && rowsToNow.length >= 12,
        JSON.stringify({ ok: remAmort.ok, curMonth, rows: rowsToNow.length }));
      check('projection payload: remainingBalance is the series balance at the current month (below the stale anchor)',
        remAmort.remainingBalance === (lastRow && lastRow.balance)
          && remAmort.remainingBalanceMonth === (lastRow && lastRow.month)
          && remAmort.remainingBalance < 1350000 && remAmort.remainingBalance > 0,
        JSON.stringify({ rem: remAmort.remainingBalance, row: lastRow && lastRow.balance, month: remAmort.remainingBalanceMonth }));
      const remDetail = (await req('GET', `/api/properties/${remPid}`)).data;
      check('detail payload carries the same remainingBalance',
        remDetail.remainingBalance === remAmort.remainingBalance
          && remDetail.remainingBalanceMonth === remAmort.remainingBalanceMonth,
        JSON.stringify({ rem: remDetail.remainingBalance, month: remDetail.remainingBalanceMonth }));
      const remEquity = (await req('GET', `/api/properties/${remPid}/equity`)).data;
      check('equity subtracts the remaining balance, not the anchor (1,931,000 - remaining)',
        remEquity.balance === remAmort.remainingBalance
          && Math.abs(remEquity.equity - (1931000 - remAmort.remainingBalance)) < 0.02,
        JSON.stringify(remEquity));
      const remPort = (await req('GET', '/api/properties/portfolio')).data;
      const remRow = remPort.properties.find((x) => x.id === remPid);
      check('portfolio outstanding for the property is the same remaining balance',
        !!remRow && Math.abs(remRow.outstanding - remAmort.remainingBalance) < 0.02,
        JSON.stringify(remRow && remRow.outstanding));
      // Browser: the modal cell and the equity line show that figure.
      // (Detour via the properties section first: the deleted
      // amortPid's id is reused by this fixture, so the hash may
      // already read #property/<same id> and a direct jump would
      // fire no hashchange at all.)
      const groupNum = (n) => Number(n).toLocaleString('en-CA', { maximumFractionDigits: 0 });
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(800);
      await page.goto(`http://ff.local/#property/${remPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      const remMeta = await page.evaluate(() => document.querySelector('#metaCurrentPrincipal').textContent);
      check('modal Current Principal shows today\u2019s remaining balance, not the 1,350,000 anchor',
        remMeta.includes(groupNum(remAmort.remainingBalance)) && !remMeta.includes('1,350,000'),
        String(remMeta));
      const remEqText = await page.evaluate(() => document.querySelector('#equitySummary').textContent);
      check('detail equity line is the bare figure (assessed minus remaining, no derivation tail)',
        remEqText.trim() === `Current equity: $${Number(1931000 - remAmort.remainingBalance).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        remEqText);
      await page.evaluate(() => document.querySelector('#mortgageModal [data-close-modal]').click());
      await wait(300);
      await req('DELETE', `/api/properties/${remPid}`);

      // A fixed plan has no prime door at all: its segment rate is
      // plain text (no link), and the prime modal stays shut.
      r = await req('POST', '/api/properties', {
        address: '456 Fixed Test Court, Victoria, BC',
        mortgage_balance: 500000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const fixedPid = r.data.id;
      await req('POST', `/api/properties/${fixedPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'fixed', annual_rate: 5,
      });
      await req('PUT', `/api/properties/${fixedPid}`, { amortization_years: 25 });
      await page.goto(`http://ff.local/#property/${fixedPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      const fixedPrimeUi = await page.evaluate(() => ({
        links: document.querySelectorAll('#termsWrap [data-prime-link]').length,
        bannerGone: !document.querySelector('#primeBanner') && !document.querySelector('#primeChartWrap'),
        modalOpen: !document.querySelector('#primeModal').classList.contains('hidden'),
        hasChart: !!window.__fmCharts.prime,
        modalText: document.querySelector('#mortgageModal').textContent,
      }));
      check('fixed plan: no prime link on the segment, no prime banner, the prime modal stays shut',
        fixedPrimeUi.links === 0 && fixedPrimeUi.bannerGone && !fixedPrimeUi.modalOpen
          && !fixedPrimeUi.hasChart && !fixedPrimeUi.modalText.includes('Bank of Canada prime:'),
        JSON.stringify({ links: fixedPrimeUi.links, bannerGone: fixedPrimeUi.bannerGone, modalOpen: fixedPrimeUi.modalOpen }));
      await req('DELETE', `/api/properties/${fixedPid}`);

      // ---- Terms UI: build a renewal through the accordion ----
      // Same shape once more, driven entirely through the page this
      // time: the modal metadata names the current lender, "+ Add term /
      // renewal" creates Term 2 prefilled and expanded, its form
      // takes the new lender + amortization, and the projection then
      // runs continuously across the boundary with the payment
      // re-derived on Term 2's amortization. A lump sum added in
      // Term 1 through its own form leaves the payment unchanged
      // and pulls the payoff earlier.
      r = await req('POST', '/api/properties', {
        address: '888 Term UI Way, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const termUiPid = r.data.id;
      await req('POST', `/api/properties/${termUiPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await req('PUT', `/api/properties/${termUiPid}`, { amortization_years: 30, lender: 'RBC' });
      await page.goto(`http://ff.local/#property/${termUiPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      // A property->property hash jump can leave the previous
      // fixture's render in place (in-flight loads race); a reload
      // pins the page to this property, as in earlier sections.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      // Poll for this property's metadata.
      let sumBefore = '';
      for (let i = 0; i < 40; i++) {
        sumBefore = await page.evaluate(() => document.querySelector('#mortgageMeta').textContent);
        if (sumBefore.includes('RBC')) break;
        await wait(300);
      }
      check('modal metadata names the current lender and the calculated payment (no auto/entered tag)',
        sumBefore.includes('RBC') && sumBefore.includes('6,381')
          && !sumBefore.includes('auto') && !sumBefore.includes('entered'),
        sumBefore);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await page.evaluate(() => document.querySelector('#addTermBtn').click());
      await wait(2000);
      const termBlocks = await page.evaluate(() => document.querySelectorAll('#termsWrap .term-block').length);
      check('"+ Add term / renewal" adds a second term block', termBlocks === 2, String(termBlocks));
      await page.evaluate(() => {
        const blocks = document.querySelectorAll('#termsWrap .term-block');
        const form = blocks[blocks.length - 1].querySelector('[data-term-form]');
        form.lender.value = 'TD';
        form.amortization_years.value = '25';
        form.requestSubmit();
      });
      await wait(2200);
      r = await req('GET', `/api/properties/${termUiPid}`);
      check('the UI-saved renewal carries the new lender + amortization',
        r.data.terms.length === 2 && r.data.terms[1].lender === 'TD' && r.data.terms[1].amortization_years === 25,
        JSON.stringify(r.data.terms));
      let sumAfter = '';
      for (let i = 0; i < 40; i++) {
        sumAfter = await page.evaluate(() => document.querySelector('#termsWrap').textContent);
        if (sumAfter.includes('Term 2') && sumAfter.includes('TD')) break;
        await wait(300);
      }
      check('the terms list now shows the renewal with its lender',
        sumAfter.includes('Term 2') && sumAfter.includes('TD'), sumAfter.slice(0, 200));
      const amortUi = (await req('GET', `/api/properties/${termUiPid}/amortization`)).data;
      const t2Month = r.data.terms[1].start_date.slice(0, 7);
      const idxB = amortUi.series.findIndex((x) => x.month === t2Month);
      check('UI-built Term 2: projection continuous, payment re-derived at the boundary',
        idxB > 0
          && Math.abs(amortUi.series[idxB].payment - engineDerive(amortUi.series[idxB - 1].balance, 3.95, 25)) < 0.02
          && Math.abs(amortUi.series[idxB].balance
            - (amortUi.series[idxB - 1].balance + amortUi.series[idxB].interest - amortUi.series[idxB].payment)) < 0.02,
        JSON.stringify(amortUi.series[idxB]));
      // Every term card carries the full field set — principal
      // pair, frequency, day, and the calculated monthly payment
      // as a read-only figure whose own row holds the override
      // editor (Edit button + the payment_override input, in the
      // payment row — never a standalone field, never a
      // property-level payment input). The payment row closes
      // the card (below the segments and the lump sums), so its
      // editor lives in the card's pay block, associated with
      // the term form rather than nested inside it — and the old
      // standalone anchor form is gone from the page entirely.
      const fieldSets = await page.evaluate(() => ({
        forms: [...document.querySelectorAll('#termsWrap .term-block [data-term-form]')].map((f) => {
          const pb = f.closest('.term-block').querySelector('[data-pay-block]');
          return {
            overrideInput: !!pb && !!pb.querySelector('[name=payment_override]'),
            overrideInPaymentRow: !!pb && !!pb.querySelector('.term-pay-row [name=payment_override]'),
            payEditBtn: !!pb && !!pb.querySelector('.term-pay-row [data-pay-edit]'),
            propertyPaymentInput: !!f.querySelector('[name=mortgage_payment]'),
            paymentFigure: !!pb && !!pb.querySelector('[data-term-payment]'),
            freq: !!f.querySelector('[name=payment_frequency]'),
            day: !!f.querySelector('[name=payment_day]'),
            principal: !!f.querySelector('[name=opening_balance], [name=anchor_balance]'),
            principalDate: !!f.querySelector('[name=start_date], [name=anchor_date]'),
          };
        }),
        anchorForms: document.querySelectorAll('[data-anchor-form]').length,
      }));
      check('every term card carries the principal/frequency/day field set, a read-only payment figure with its inline Edit in the payment row closing the card — no property payment input (no separate anchor form)',
        fieldSets.forms.length === 2
          && fieldSets.forms.every((s) => s.overrideInput && s.overrideInPaymentRow && s.payEditBtn && !s.propertyPaymentInput && s.paymentFigure && s.freq && s.day && s.principal && s.principalDate)
          && fieldSets.anchorForms === 0,
        JSON.stringify(fieldSets));
      // The payment figure is the RESULT of the rate plan: its
      // row comes after the segments table and the lump sums in
      // the card's document order — and the card's Save button
      // closes the card below the payment row (the segments
      // block sits above the Save, never below it).
      const payOrder = await page.evaluate(() => {
        const block = document.querySelector('#termsWrap .term-block');
        const pay = block.querySelector('[data-pay-block]');
        const segTable = block.querySelector('.seg-table');
        const segForm = block.querySelector('[data-seg-form]');
        const lumpForm = block.querySelector('[data-lump-form]');
        const saveBtn = block.querySelector('[data-save-term]');
        const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;
        const follows = (a, b) => !!a && !!b && (a.compareDocumentPosition(b) & FOLLOWS) !== 0;
        return {
          pay: !!pay,
          afterSeg: follows(segTable, pay),
          afterLump: follows(lumpForm, pay),
          segBeforeSave: follows(segTable, saveBtn) && follows(segForm, saveBtn),
          saveAfterPay: follows(pay, saveBtn),
        };
      });
      check('the Monthly payment row sits below the rate segments and the lump sums, and the Save button closes the card below it',
        payOrder.pay && payOrder.afterSeg && payOrder.afterLump && payOrder.segBeforeSave && payOrder.saveAfterPay,
        JSON.stringify(payOrder));
      const termPayFig = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-term-payment]').textContent);
      check('the current term card shows its calculated monthly payment read-only',
        termPayFig.includes('6,381'), String(termPayFig));
      // One form, one Save per term card: the term's contract
      // fields and its payment schedule (frequency /
      // day, and its anchor when it carries one) save together in
      // a single submit — there is no second Save button anywhere
      // in the card (the Add segment / Add lump sum buttons belong
      // to their own hidden creation forms, not to the term). The
      // Save button itself lives below the payment row, outside
      // the <form>, bound back to it by the HTML form attribute,
      // and its label names the payment in the term's frequency.
      const saveCounts = await page.evaluate(() => [...document.querySelectorAll('#termsWrap .term-block')].map((block) => {
        const forms = block.querySelectorAll('[data-term-form]');
        const form = forms[0];
        const saveBtn = block.querySelector('[data-save-term]');
        return {
          termForms: forms.length,
          submitsInForm: form ? form.querySelectorAll('button[type=submit]').length : -1,
          saveButtonsInCard: [...block.querySelectorAll('button[type=submit]')]
            .filter((b) => b.textContent.trim().startsWith('Save')).length,
          saveLabel: saveBtn ? saveBtn.textContent.trim() : null,
          saveFormAttr: saveBtn ? saveBtn.getAttribute('form') : null,
          formId: form ? form.id : null,
        };
      }));
      check('each term card is one form with exactly one Save button — below the payment row, outside the form, bound by its form attribute, labelled by frequency',
        saveCounts.length === 2
          && saveCounts.every((s) => s.termForms === 1 && s.submitsInForm === 0 && s.saveButtonsInCard === 1
            && s.saveLabel === 'Save & calculate monthly payment' && s.saveFormAttr === s.formId),
        JSON.stringify(saveCounts));
      // The label follows the frequency select live.
      await page.evaluate(() => {
        const sel = document.querySelector('#termsWrap .term-block [data-term-form] [name=payment_frequency]');
        sel.value = 'bi_weekly';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const saveLabelBw = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-save-term]').textContent.trim());
      check('changing the frequency select re-labels the Save button (Save & calculate bi-weekly payment)',
        saveLabelBw === 'Save & calculate bi-weekly payment', saveLabelBw);
      await page.evaluate(() => {
        const sel = document.querySelector('#termsWrap .term-block [data-term-form] [name=payment_frequency]');
        sel.value = 'monthly';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Lump sum through Term 1's own form (amount typed bare, it
      // groups live like every money field).
      await page.evaluate(() => {
        document.querySelector('#termsWrap .term-block [data-toggle-lump]').click();
        document.querySelector('#termsWrap .term-block [data-lump-form] [name=date]').value = '2026-12-01';
        document.querySelector('#termsWrap .term-block [data-lump-form] [name=amount]').focus();
      });
      await page.keyboard.type('50000');
      const lumpTyped = await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-lump-form] [name=amount]').value);
      check('lump sum amount groups while typing (50000 -> 50,000)', lumpTyped === '50,000', String(lumpTyped));
      await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-lump-form]').requestSubmit());
      await wait(2200);
      const amortLump = (await req('GET', `/api/properties/${termUiPid}/amortization`)).data;
      const novRowL = amortLump.series.find((x) => x.month === '2026-11');
      const decRowL = amortLump.series.find((x) => x.month === '2026-12');
      // The lump leaves the Term 1 payment untouched; the payoff
      // it pulls in is then absorbed by the renewal, whose payment
      // is re-derived on Term 2's amortization from the smaller
      // balance — so the visible wins are the lower renewal
      // payment and the lower total interest, not an earlier
      // final payoff (that needs a single-term loan; see the
      // engine unit tests).
      const t2Before = amortUi.series.find((x) => x.month === t2Month);
      const t2After = amortLump.series.find((x) => x.month === t2Month);
      check('UI lump sum: the lump month charges interest on the reduced balance, the payment is unchanged, the renewal payment drops',
        !!decRowL && !!novRowL
          && Math.abs(decRowL.interest - Math.round((novRowL.balance - 50000) * engineMonthlyRate(3.95) * 100) / 100) < 0.02
          && Math.abs(decRowL.payment - amortUi.paymentUsed) < 0.02
          && !!t2Before && !!t2After && t2After.payment < t2Before.payment - 100
          && amortLump.totalInterest < amortUi.totalInterest - 10000,
        JSON.stringify({ dec: decRowL, t2Before: t2Before && t2Before.payment, t2After: t2After && t2After.payment }));
      r = await req('GET', `/api/properties/${termUiPid}`);
      check('the lump sum is recorded under Term 1',
        r.data.terms[0].lumpSums.length === 1 && r.data.terms[0].lumpSums[0].amount === 50000,
        JSON.stringify(r.data.terms[0].lumpSums));

      // ---- Plan preview in the add-segment form ----
      // The term form carries the repayment-method select; the
      // add-segment form previews the drafted plan's first month
      // live (server-computed) and re-prices as the spread is
      // edited — nothing is saved by previewing.
      const methodSel = await page.evaluate(() => {
        const sel = document.querySelector('#termsWrap .term-block [data-term-form] [name=repayment_method]');
        return sel ? sel.value : null;
      });
      check('the term form offers the repayment method (equal payment by default)',
        methodSel === 'equal_payment', String(methodSel));
      await page.evaluate(() => {
        document.querySelector('#termsWrap .term-block [data-toggle-seg]').click();
        const form = document.querySelector('#termsWrap .term-block [data-seg-form]');
        const set = (name, value, evt) => {
          const el = form.querySelector(`[name=${name}]`);
          el.value = value;
          el.dispatchEvent(new Event(evt, { bubbles: true }));
        };
        set('rate_type', 'variable', 'change');
        set('rate_mode', 'prime_spread', 'change');
        set('spread', '-1', 'input');
      });
      await wait(1100);
      const previewText1 = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-seg-form] [data-plan-preview]').textContent);
      check('the add-segment form previews the plan\u2019s first month (payment — interest, principal, at rate)',
        previewText1.includes('Next month (') && previewText1.includes('payment $')
          && previewText1.includes('interest $') && previewText1.includes('principal $')
          && previewText1.includes('at 3.95%'),
        previewText1);
      await page.evaluate(() => {
        const el = document.querySelector('#termsWrap .term-block [data-seg-form] [name=spread]');
        el.value = '-2';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(1100);
      const previewText2 = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-seg-form] [data-plan-preview]').textContent);
      check('editing the spread re-prices the preview live (Prime - 2 -> 2.95%, a different payment)',
        previewText2.includes('at 2.95%') && previewText2 !== previewText1,
        previewText2);
      r = await req('GET', `/api/properties/${termUiPid}`);
      check('previewing saved nothing (still the one original segment)',
        r.data.segments.length === 1 && r.data.segments[0].spread === -1,
        JSON.stringify(r.data.segments));
      await req('DELETE', `/api/properties/${termUiPid}`);

      // ---- Property panel: read-only metadata until Edit; photo carousel ----
      page.on('dialog', (d) => d.accept()); // photo removal asks confirm()
      const until = async (fn, tries = 40) => {
        for (let i = 0; i < tries; i++) { if (await page.evaluate(fn)) return true; await wait(300); }
        return false;
      };
      await page.goto(`http://ff.local/#property/${moneyPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      check('detail opens on the read-only property view',
        await until(() => {
          const body = document.querySelector('#propViewBody');
          return body && body.textContent.includes('999 Money Test Terrace')
            && !document.querySelector('#propView').classList.contains('hidden');
        }));
      const panelState = await page.evaluate(() => ({
        formHidden: document.querySelector('#propForm').classList.contains('hidden'),
        viewInputs: document.querySelectorAll('#propView input').length,
        hasPhotoUrlField: !!document.querySelector('#propForm [name=photo_url]'),
        viewText: document.querySelector('#propViewBody').textContent,
        emptyGallery: document.querySelector('#photoArea').textContent.includes('No photos yet'),
      }));
      check('the edit form stays hidden until Edit', panelState.formHidden === true);
      check('the read-only view has no inputs (pure metadata)', panelState.viewInputs === 0);
      check('the Photo URL field is gone from the edit form', panelState.hasPhotoUrlField === false);
      check('read-only view shows purchase date 2024-12-17', panelState.viewText.includes('2024-12-17'), panelState.viewText.slice(0, 160));
      check('a property without photos shows the click-to-add placeholder', panelState.emptyGallery === true);
      // Layout: ONE merged overview panel (details left, photo
      // carousel right) above Value & Mortgage Projection; the old
      // separate Gallery / Property Details panels are gone. Edit
      // sits in the merged panel's head; the mortgage setup, the
      // history editor and the fetch/pull buttons live in their
      // modals, not on the page body. The BCA source line moved
      // with them into Assessment History.
      const layout = await page.evaluate(() => {
        const ov = document.getElementById('propertyOverview');
        const vp = document.getElementById('projectionPanel');
        const follows = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
        const det = ov ? ov.querySelector('.overview-details') : null;
        const pho = ov ? ov.querySelector('.overview-photos') : null;
        const dr = det ? det.getBoundingClientRect() : null;
        const pr = pho ? pho.getBoundingClientRect() : null;
        return {
          merged: !!ov && !document.getElementById('galleryPanel') && !document.getElementById('propertyDetailsPanel'),
          order: follows(ov, vp),
          headings: [ov, vp].map((el) => ((el.querySelector('h3') || {}).textContent || '').trim()),
          editInHead: !!document.querySelector('#propertyOverview .panel-head #editPropBtn'),
          columns: !!(det && pho && det.contains(document.getElementById('propView'))
            && pho.contains(document.getElementById('photoArea'))),
          leftRight: !!(dr && pr && dr.left < pr.left && Math.abs(dr.top - pr.top) < 4),
          mortgageOnPage: !!document.querySelector('#view-property #termsWrap'),
          historyOnPage: !!document.querySelector('#view-property #trendForm'),
          fetchOnPage: !!document.querySelector('#view-property #fetchBcaBtn'),
        };
      });
      check('detail layout is one merged overview panel above Value & Mortgage Projection',
        layout.merged && layout.order && layout.headings[0] === 'Property Details'
          && layout.headings[1] === 'Value & Mortgage Projection',
        JSON.stringify(layout));
      check('overview columns: details on the left, photo carousel on the right',
        layout.columns && layout.leftRight, JSON.stringify(layout));
      check('Property Details Edit sits in the merged panel head (top right)', layout.editInHead === true);
      check('the page body carries neither the mortgage setup nor the assessment history (modals only)',
        !layout.mortgageOnPage && !layout.historyOnPage && !layout.fetchOnPage,
        JSON.stringify(layout));
      // Details content, exactly as ruled: two headline figures
      // (assessed value, remaining balance) over Address / Owners /
      // Purchase date — no Notes, Assessment year or Lender rows,
      // no payment-frequency or region prose lines, and the region
      // rides beside the address as a flag tag.
      const detailsBits = await page.evaluate(() => {
        const tag = document.querySelector('#propViewBody .region-tag');
        return {
          labels: [...document.querySelectorAll('#propViewBody tr td:first-child')].map((td) => td.textContent.trim()),
          assessed: document.querySelector('#detailAssessedValue').textContent,
          remaining: document.querySelector('#detailRemainingBalance').textContent,
          viewText: document.querySelector('#propView').textContent,
          tagText: tag ? tag.textContent : null,
          tagTitle: tag ? tag.getAttribute('title') : null,
          proseGone: !document.querySelector('#paymentDayDisplay') && !document.querySelector('#regionDisplay'),
          bigParaGone: ![...document.querySelectorAll('#projectionPanel .note')]
            .some((n) => n.textContent.includes('plotted as one point per assessment year')),
        };
      });
      const vhNow = (await req('GET', `/api/properties/${moneyPid}/value-history`)).data;
      const propNow = (await req('GET', `/api/properties/${moneyPid}`)).data;
      const latestPt = vhNow.points && vhNow.points.length ? vhNow.points[vhNow.points.length - 1] : null;
      const fmt$ = (n) => '$' + Number(n).toLocaleString('en-CA', { maximumFractionDigits: 0 });
      const fmt$2 = (n) => '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const expAssessed = latestPt ? latestPt.value : propNow.assessed_value;
      const expRemaining = propNow.remainingBalance != null ? propNow.remainingBalance : propNow.mortgage_balance;
      check('details carry exactly the two headline figures over Address / Owners / Purchase date',
        detailsBits.labels.join('|') === 'Address|Owners|Purchase date'
          && detailsBits.assessed === fmt$(expAssessed)
          && detailsBits.remaining === fmt$2(expRemaining),
        JSON.stringify({ detailsBits, expAssessed, expRemaining }));
      check('details carry no Notes / Assessment year / Lender rows and no prose lines',
        !detailsBits.viewText.includes('Notes') && !detailsBits.viewText.includes('Assessment year')
          && !detailsBits.viewText.includes('Lender') && !detailsBits.viewText.includes('Payment frequency')
          && !detailsBits.viewText.includes('Region:') && detailsBits.proseGone && detailsBits.bigParaGone,
        JSON.stringify(detailsBits));
      check('region shows as a flag tag beside the address (details panel)',
        detailsBits.tagText === '🇨🇦' && detailsBits.tagTitle === 'Canada (CA)',
        JSON.stringify(detailsBits));
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(400);
      // The modal opens on the assessed-history bar chart; the old
      // BCA source line and HouseSigma status line are gone (the
      // elements themselves no longer exist).
      const histBits = await page.evaluate(() => {
        const modal = document.querySelector('#historyModal');
        const c = window.__fmCharts.history;
        const canvas = modal.querySelector('#historyChart');
        const rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
        return {
          text: modal.textContent,
          metaGone: !document.querySelector('#assessmentMetaView') && !document.querySelector('#hsPullNote')
            && !document.querySelector('#assessmentMeta'),
          labels: c ? c.data.labels : null,
          // A year's bar total is the sum over the stacked
          // datasets (Land + Building for a split year, the Total
          // dataset for a total-only one).
          values: c ? c.data.labels.map((_, i) => c.data.datasets.reduce((sum, ds) => sum + (ds.data[i] || 0), 0)) : null,
          sources: c ? c.data.datasets[0].pointMeta.map((p) => p.source) : null,
          canvasW: rect.width, canvasH: rect.height,
        };
      });
      check('the Assessment History modal carries no BCA source line and no HouseSigma status line',
        !histBits.text.includes('Source: BC Assessment') && !histBits.text.includes('HouseSigma history:')
          && histBits.metaGone,
        histBits.text.slice(0, 200));
      check('the Assessment History modal tops out with the history bar chart (one stack per point, ascending years)',
        !!histBits.values && histBits.values.length === vhNow.points.length
          && histBits.values.every((v, i) => v === vhNow.points[i].value)
          && histBits.labels.every((l, i) => l === String(vhNow.points[i].year))
          && histBits.sources.every((s, i) => s === vhNow.points[i].source)
          && histBits.canvasW > 0 && histBits.canvasH >= 150,
        JSON.stringify(histBits));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(300);
      // Edit -> change purchase date -> Save: back to read-only with
      // the new value, and the change is really persisted.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(300);
      check('Edit reveals the form', await page.evaluate(() => !document.querySelector('#propForm').classList.contains('hidden')));
      await page.evaluate(() => { document.querySelector('#propForm [name=purchase_date]').value = '2019-03-04'; });
      await page.evaluate(() => document.querySelector('#propForm [type=submit]').click());
      check('Save returns to the read-only view showing the new purchase date',
        await until(() => !document.querySelector('#propView').classList.contains('hidden')
          && document.querySelector('#propViewBody').textContent.includes('2019-03-04')));
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('the saved purchase date persisted', r.data.purchase_date === '2019-03-04', JSON.stringify(r.data.purchase_date));
      // Edit -> change -> Cancel: nothing is written.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(300);
      await page.evaluate(() => { document.querySelector('#propForm [name=purchase_date]').value = '2000-01-01'; });
      await page.evaluate(() => document.querySelector('#cancelPropEditBtn').click());
      await wait(300);
      const afterCancel = await page.evaluate(() => document.querySelector('#propViewBody').textContent);
      check('Cancel discards the edit (view keeps the saved date)',
        afterCancel.includes('2019-03-04') && !afterCancel.includes('2000-01-01'), afterCancel.slice(0, 160));
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('Cancel wrote nothing to the server', r.data.purchase_date === '2019-03-04', JSON.stringify(r.data.purchase_date));
      // Carousel: two uploads (via the API). The VIEW shows the
      // carousel alone (main photo + arrows + count — no thumbnail
      // strip, no Add/Remove buttons); photo management lives in
      // the Edit form. Autoplay is frozen for the deterministic
      // steps via a long test delay, then exercised on its own
      // below with a short one.
      const TINY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await req('POST', `/api/properties/${moneyPid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
      r = await req('POST', `/api/properties/${moneyPid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
      check('two photos uploaded for the carousel checks', r.data.photos.length === 2, JSON.stringify(r.data.photos));
      const [ph1, ph2] = r.data.photos;
      await page.evaluateOnNewDocument(() => { window.__fmPhotoDelay = 60000; });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1200);
      const viewBits = await page.evaluate(() => ({
        thumbs: document.querySelectorAll('#photoArea .photo-thumbs').length,
        dots: document.querySelectorAll('#photoArea [data-photo-dot]').length,
        addBtn: !!document.querySelector('#photoArea [data-photo-add-btn]'),
        removeBtn: !!document.querySelector('#photoArea [data-photo-remove]'),
        hasNav: !!document.querySelector('#photoArea [data-photo-nav="1"]'),
        count: (document.querySelector('#photoArea .carousel-count') || {}).textContent || '',
      }));
      check('view state: the carousel stands alone — arrows and count, no thumbnail strip, no Add/Remove buttons',
        viewBits.thumbs === 0 && viewBits.dots === 0 && !viewBits.addBtn && !viewBits.removeBtn
          && viewBits.hasNav && viewBits.count.trim() === '1 / 2',
        JSON.stringify(viewBits));
      const carSrc1 = await page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      check('gallery starts on the first photo', carSrc1 === ph1.src, String(carSrc1));
      await page.evaluate(() => document.querySelector('#photoArea [data-photo-nav="1"]').click());
      await wait(300);
      const carSrc2 = await page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      check('next arrow switches to the second photo', carSrc2 === ph2.src && carSrc2 !== carSrc1, String(carSrc2));
      // Open Edit: the management area is there — the thumbnail
      // strip, Add photos and Remove this photo.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(400);
      const mgmtBits = await page.evaluate(() => ({
        thumbs: document.querySelectorAll('#photoManage .photo-thumbs .thumb').length,
        addBtn: !!document.querySelector('#photoManage [data-photo-add-btn]'),
        removeBtn: !!document.querySelector('#photoManage [data-photo-remove]'),
        formVisible: !document.querySelector('#propForm').classList.contains('hidden'),
      }));
      check('Edit state: the photo management area shows the thumbnail strip plus Add/Remove',
        mgmtBits.formVisible && mgmtBits.thumbs === 2 && mgmtBits.addBtn && mgmtBits.removeBtn,
        JSON.stringify(mgmtBits));
      // A thumbnail click selects that photo in the carousel (the
      // carousel currently shows the second photo already; pick
      // the first thumbnail to see it switch back).
      await page.evaluate(() => document.querySelectorAll('#photoManage .photo-thumbs .thumb')[0].click());
      await wait(300);
      const carSrcBack = await page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      check('clicking the first thumbnail shows the first photo again', carSrcBack === ph1.src, String(carSrcBack));
      await page.evaluate(() => document.querySelectorAll('#photoManage .photo-thumbs .thumb')[1].click());
      await wait(300);
      // Remove the currently shown photo (the second) from Edit:
      // it applies at once, without the form's Save.
      await page.evaluate(() => document.querySelector('#photoManage [data-photo-remove]').click());
      check('removing from Edit leaves a one-photo gallery',
        await until(() => {
          const c = document.querySelector('#photoArea .carousel-count');
          return c && c.textContent.trim() === '1 / 1' && !document.querySelector('#photoArea .photo-thumbs');
        }));
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('the removal persisted (one photo left, the first one)',
        r.data.photos.length === 1 && r.data.photos[0].id === ph1.id, JSON.stringify(r.data.photos));
      // Upload one more from the Edit form's Add photos (through
      // the file input; it too applies at once).
      const tmpPng = path.join(os.tmpdir(), `ff-e2e-photo-${Date.now()}.png`);
      fs.writeFileSync(tmpPng, Buffer.from(TINY, 'base64'));
      const fileInput = await page.$('#photoFiles');
      await fileInput.uploadFile(tmpPng);
      check('uploading from Edit adds the photo at once',
        await until(() => document.querySelectorAll('#photoManage .photo-thumbs .thumb').length === 2));
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('the Edit upload persisted (two photos again)', r.data.photos.length === 2, JSON.stringify(r.data.photos.length));
      await page.evaluate(() => document.querySelector('#cancelPropEditBtn').click());
      await wait(300);
      // No-flash switch (regression for the old innerHTML
      // rebuild, which destroyed the old <img> and inserted a
      // fresh one that painted blank and collapsed the box until
      // it loaded): every slide is resident and preloaded before
      // any switch, the stage box never changes height across a
      // switch, and the node that becomes visible is the SAME
      // node that was preloaded — no destroy/rebuild.
      const flashBits = await page.evaluate(async () => {
        const stage = document.querySelector('#photoArea .photo-stage');
        const slides = [...document.querySelectorAll('#photoArea img.slide')];
        const h0 = stage.getBoundingClientRect().height;
        const target = slides[1];
        document.querySelector('#photoArea [data-photo-nav="1"]').click();
        await new Promise((r) => setTimeout(r, 350));
        const active = document.querySelector('#photoArea img.slide.active');
        return {
          nSlides: slides.length,
          allPreloaded: slides.every((i) => i.complete && i.naturalWidth > 0),
          h0, h1: stage.getBoundingClientRect().height,
          sameNode: active === target,
          activeComplete: !!active && active.complete && active.naturalWidth > 0,
        };
      });
      check('carousel switch never flashes: slides resident + preloaded, stage height constant, the visible slide is the preloaded node itself',
        flashBits.nSlides === 2 && flashBits.allPreloaded && flashBits.h0 === flashBits.h1 && flashBits.sameNode && flashBits.activeComplete,
        JSON.stringify(flashBits));
      // Layout: the photo fills the overview panel's full height
      // (no dead white space under it), the n / N counter rides on
      // the photo as an overlay chip, and the detail column spreads
      // its meta rows over the same height.
      const fillBits = await page.evaluate(() => {
        const R = (el) => (el ? el.getBoundingClientRect() : null);
        const stage = document.querySelector('#photoArea .photo-stage');
        const area = document.getElementById('photoArea');
        const det = document.querySelector('#propertyOverview .overview-details');
        const view = document.getElementById('propView');
        const bar = document.querySelector('#photoArea .carousel-bar');
        const chip = document.querySelector('#photoArea .carousel-count');
        const stats = document.querySelector('#propView .detail-stats');
        const rows = [...document.querySelectorAll('#propViewBody tr')];
        const sr = R(stage); const ar = R(area); const dr = R(det); const vr = R(view);
        const cr = R(chip); const str = R(stats);
        const rr = rows.map(R);
        return {
          stageH: sr && sr.height, areaH: ar && ar.height, detH: dr && dr.height,
          stageBottom: sr && sr.bottom, areaBottom: ar && ar.bottom,
          barPos: bar ? getComputedStyle(bar).position : null,
          chipInStage: !!(sr && cr && cr.top >= sr.top - 1 && cr.bottom <= sr.bottom + 1
            && Math.abs((cr.left + cr.right) / 2 - (sr.left + sr.right) / 2) < 4),
          statsBottom: str && str.bottom,
          firstRowTop: rr.length ? rr[0].top : null,
          lastRowBottom: rr.length ? rr[rr.length - 1].bottom : null,
          viewBottom: vr && vr.bottom,
          rowsSpread: rr.length > 1 && rr.every((r, i) => i === 0 || r.top >= rr[i - 1].bottom - 1),
        };
      });
      check('detail layout: the photo stage fills the panel height (no dead space under the photo)',
        fillBits.stageH >= 260 && Math.abs(fillBits.stageH - fillBits.areaH) < 3
          && Math.abs(fillBits.stageBottom - fillBits.areaBottom) < 2
          && Math.abs(fillBits.detH - fillBits.areaH) < 3,
        JSON.stringify(fillBits));
      check('detail layout: the n / N counter is a chip overlaid on the photo, not a line under it',
        fillBits.barPos === 'absolute' && fillBits.chipInStage,
        JSON.stringify(fillBits));
      check('detail layout: the meta rows spread over the full detail-column height',
        fillBits.rowsSpread && Math.abs(fillBits.lastRowBottom - fillBits.viewBottom) < 3
          && fillBits.firstRowTop >= fillBits.statsBottom - 2,
        JSON.stringify(fillBits));
      // Edit mode: the form is the taller column — the photo
      // stretches to match it too.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(400);
      const editFill = await page.evaluate(() => {
        const stage = document.querySelector('#photoArea .photo-stage');
        const det = document.querySelector('#propertyOverview .overview-details');
        return {
          stageH: stage ? stage.getBoundingClientRect().height : 0,
          detH: det ? det.getBoundingClientRect().height : 0,
        };
      });
      check('detail layout: in Edit mode the photo stretches to the taller form column',
        editFill.stageH > fillBits.stageH + 40 && Math.abs(editFill.stageH - editFill.detH) < 4,
        JSON.stringify(editFill));
      await page.evaluate(() => document.querySelector('#cancelPropEditBtn').click());
      await wait(300);
      // Autoplay: a short test delay and a fresh load — the
      // carousel advances on its own, wraps at the end, yields
      // to a manual click (its timer resets), and pauses on
      // hover and on a hidden tab.
      await page.evaluateOnNewDocument(() => { window.__fmPhotoDelay = 400; });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(500);
      const autoSrc = () => page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      const pollSrc = async (want, tries = 18) => {
        for (let i = 0; i < tries; i++) {
          if (want(await autoSrc())) return true;
          await wait(200);
        }
        return false;
      };
      const auto0 = await autoSrc();
      check('autoplay advances to the next photo on its own', await pollSrc((s) => s !== auto0));
      check('autoplay wraps back to the first photo', await pollSrc((s) => s === auto0));
      const beforeManual = await autoSrc();
      await page.evaluate(() => document.querySelector('#photoArea [data-photo-nav="1"]').click());
      await wait(120);
      const manualSrc = await autoSrc();
      check('a manual arrow click switches the photo', manualSrc !== beforeManual);
      await wait(250); // still inside the reset delay window (400ms)
      check('the manual choice is not immediately overridden by autoplay', (await autoSrc()) === manualSrc);
      const box = await page.evaluate(() => {
        const r = document.querySelector('#photoArea .photo-carousel').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 40 };
      });
      await page.mouse.move(box.x, box.y);
      const hoverSrc = await autoSrc();
      await wait(1000);
      check('hovering the carousel pauses autoplay', (await autoSrc()) === hoverSrc);
      await page.mouse.move(5, 5);
      check('moving the mouse away resumes autoplay', await pollSrc((s) => s !== hoverSrc));
      try {
        if (typeof page.emulateVisibilityState === 'function') {
          await page.emulateVisibilityState('hidden');
          const hidSrc = await autoSrc();
          await wait(1000);
          check('a hidden tab pauses autoplay', (await autoSrc()) === hidSrc);
          await page.emulateVisibilityState('visible');
        }
      } catch { /* visibility emulation unavailable in this browser build */ }
      try {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
        await wait(500);
        const rmSrc = await autoSrc();
        await wait(1100);
        check('prefers-reduced-motion disables autoplay', (await autoSrc()) === rmSrc);
        await page.emulateMediaFeatures([]);
      } catch { /* media emulation unavailable in this browser build */ }
      await page.evaluate(() => { window.__fmPhotoDelay = 60000; }); // freeze card covers for the checks below
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(2000);
      const cover = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        const img = card && card.querySelector('.photo img');
        return img ? img.getAttribute('src') : null;
      });
      check('the Properties card cover is the first gallery photo', cover === ph1.src, String(cover));
      const cardTag = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        const tag = card && card.querySelector('.addr .region-tag');
        return tag ? { text: tag.textContent, title: tag.getAttribute('title') } : null;
      });
      check('the Properties card carries the region flag tag beside its address',
        !!cardTag && cardTag.text === '🇨🇦' && cardTag.title === 'Canada (CA)',
        JSON.stringify(cardTag));
      // Card-cover carousel (the same PhotoCarousel as the
      // detail page): the 999 card holds two photos. Bring it
      // into view, re-arm its timer at the short test delay via
      // a manual click — the arrows work without navigating —
      // and it then auto-advances on its own.
      const cardSrc = () => page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        const img = card && card.querySelector('.photo img');
        return img ? img.getAttribute('src') : null;
      });
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        if (card) card.scrollIntoView({ block: 'center' });
      });
      await wait(600);
      await page.evaluate(() => { window.__fmPhotoDelay = 400; });
      const cs0 = await cardSrc();
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        card.querySelector('[data-photo-nav="1"]').click();
      });
      await wait(300);
      const cs1 = await cardSrc();
      const stillList = await page.evaluate(() => location.hash === '#assets/properties'
        && !document.querySelector('#view-assets').classList.contains('hidden'));
      check('card cover arrow switches the photo without navigating away',
        !!cs0 && !!cs1 && cs1 !== cs0 && stillList, JSON.stringify({ cs0, cs1, stillList }));
      const pollCard = async (want, tries = 18) => {
        for (let i = 0; i < tries; i++) { if (want(await cardSrc())) return true; await wait(200); }
        return false;
      };
      check('the card cover auto-advances on its own', await pollCard((s) => s !== cs1));
      // A single-photo card: no arrows, static. A fresh
      // property with exactly one photo, then re-render the list.
      r = await req('POST', '/api/properties', { address: '997 Single Photo Close', purchase_date: '2024-01-01' });
      const singlePid = r.data.id;
      await req('POST', `/api/properties/${singlePid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(2500);
      const singleBits = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('997 Single Photo Close'));
        if (card) card.scrollIntoView({ block: 'center' });
        const img = card && card.querySelector('.photo img');
        return {
          src: img ? img.getAttribute('src') : null,
          navs: card ? card.querySelectorAll('[data-photo-nav]').length : -1,
        };
      });
      await wait(900);
      const singleSrc2 = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('997 Single Photo Close'));
        const img = card && card.querySelector('.photo img');
        return img ? img.getAttribute('src') : null;
      });
      check('a single-photo card shows no arrows and stays static',
        !!singleBits.src && singleBits.navs === 0 && singleSrc2 === singleBits.src,
        JSON.stringify({ singleBits, singleSrc2 }));

      // ---- Payment override, driven through the UI ----
      // $1,350,000 at 3.95% fixed over 30y derives $6,381.36.
      // The override is set by clicking Edit on the Monthly
      // payment figure itself (there is no standalone override
      // input): the figure becomes an input prefilled with the
      // used payment; typing $6,000 and saving must re-render
      // every payment surface the same way: the used amount bold,
      // the derived amount struck through beside it — term card
      // figure, modal metadata, detail stat and the Properties
      // card — and the projection must follow the override
      // trajectory. Clearing the editor restores the plain
      // derived figure everywhere, and so does Reset + Save.
      r = await req('POST', '/api/properties', {
        address: '777 Override UI Avenue, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-01-01', purchase_date: '2025-06-01', amortization_years: 30,
      });
      const ovUiPid = r.data.id;
      const ovUiTermId = r.data.terms[0].id;
      await req('POST', `/api/properties/${ovUiPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 3.95 });
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, ovUiPid);
      check('override UI fixture: the detail stat shows the derived payment plain',
        await until(() => document.querySelector('#estPaymentValue').textContent.includes('6,381')
          && !document.querySelector('#estPaymentValue s')));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const payRowState = () => page.evaluate(() => {
        const row = document.querySelector('[data-pay-block]');
        const input = row.querySelector('[name=payment_override]');
        const view = row.querySelector('[data-term-payment]');
        const ref = row.querySelector('[data-pay-derived-ref]');
        const struck = ref ? ref.querySelector('s') : null;
        return {
          inputHidden: input.classList.contains('hidden'),
          inputValue: input.value,
          viewHidden: view.classList.contains('hidden'),
          editHidden: row.querySelector('[data-pay-edit]').classList.contains('hidden'),
          resetHidden: row.querySelector('[data-pay-reset]').classList.contains('hidden'),
          refText: ref ? ref.textContent : null,
          refStruck: struck ? struck.textContent : null,
        };
      });
      const atRest = await payRowState();
      check('the payment row rests as figure + Edit (editor input hidden, no override → no Reset)',
        atRest.inputHidden && !atRest.viewHidden && !atRest.editHidden && atRest.resetHidden && atRest.inputValue === '',
        JSON.stringify(atRest));
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      const editing = await payRowState();
      check('Edit opens the inline editor in place: input prefilled with the used payment, the calculated figure muted beside it, still no Reset',
        !editing.inputHidden && editing.viewHidden && editing.editHidden && editing.resetHidden
          && editing.inputValue === '6,381.36' && editing.refText.includes('6,381') && editing.refStruck === null,
        JSON.stringify(editing));
      await page.keyboard.type('6000');
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      const tripleOf = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const struck = el.querySelector('s');
        return {
          text: el.textContent,
          used: (el.querySelector('.pay-used') || {}).textContent || null,
          struckText: struck ? struck.textContent : null,
          struckStyle: struck ? getComputedStyle(struck).textDecorationLine : null,
        };
      }, sel);
      const untilNode = async (fn, tries = 40) => {
        for (let i = 0; i < tries; i++) { if (await fn()) return true; await wait(300); }
        return false;
      };
      check('override saved in the term form: the term card figure shows $6,000.00 bold with $6,381.36 struck through',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          return !!t && t.used === '$6,000.00' && t.struckText === '$6,381.36' && String(t.struckStyle).includes('line-through');
        }));
      const metaTriple = await tripleOf('#metaCurrentPayment');
      check('the modal metadata Current Monthly Payment shows the same override rendering',
        !!metaTriple && metaTriple.used === '$6,000.00' && metaTriple.struckText === '$6,381.36'
          && String(metaTriple.struckStyle).includes('line-through'),
        JSON.stringify(metaTriple));
      const statTriple = await tripleOf('#estPaymentValue');
      check('the detail stat Estimated monthly payment shows the same override rendering',
        !!statTriple && statTriple.used === '$6,000.00' && statTriple.struckText === '$6,381.36'
          && String(statTriple.struckStyle).includes('line-through'),
        JSON.stringify(statTriple));
      const ovUiProj = (await req('GET', `/api/properties/${ovUiPid}/amortization`)).data;
      const ovUiEngine = engineSchedule({
        balance: 1350000, balanceDate: '2026-01-01',
        terms: [{ id: ovUiTermId, start_date: '2026-01-01', amortization_years: 30, payment_override: 6000 }],
        segments: [{ id: 1, start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 3.95 }],
      });
      check('the UI-saved override drives the projection (API payoff/interest match the engine override run)',
        ovUiProj.paymentUsed === 6000 && ovUiProj.paymentDerived === 6381.36 && ovUiProj.paymentOverridden === true
          && ovUiProj.payoffMonth === ovUiEngine.payoffMonth && ovUiProj.totalInterest === ovUiEngine.totalInterest,
        JSON.stringify({ p: ovUiProj.payoffMonth, i: ovUiProj.totalInterest, ep: ovUiEngine.payoffMonth, ei: ovUiEngine.totalInterest }));
      // The segment editor's live preview inside the overridden
      // term: the previewed payment is the override, derived
      // struck through beside it.
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(400);
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        form.start_date.value = '2027-01-01';
        form.start_date.dispatchEvent(new Event('input', { bubbles: true }));
        const rate = form.querySelector('[name=annual_rate]');
        rate.value = '4.5';
        rate.dispatchEvent(new Event('input', { bubbles: true }));
      });
      check('the live plan preview inside the overridden term shows the override with the derived struck through',
        await until(() => {
          const out = document.querySelector('[data-plan-preview]');
          return !!out && out.textContent.includes('payment') && out.textContent.includes('6,000')
            && !!out.querySelector('s');
        }));
      await page.evaluate(() => document.querySelector('#mortgageModal [data-close-modal]').click());
      await wait(300);
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(2000);
      const cardPay = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('777 Override UI Avenue'));
        if (!card) return null;
        const kv = [...card.querySelectorAll('.kv')].find((x) => x.querySelector('.k') && x.querySelector('.k').textContent === 'Monthly payment');
        const struck = kv ? kv.querySelector('s') : null;
        return { text: kv ? kv.textContent : null, struckText: struck ? struck.textContent : null };
      });
      check('the Properties card shows the override payment with the derived struck through',
        !!cardPay && cardPay.text.includes('6,000') && cardPay.struckText === '$6,381.36',
        JSON.stringify(cardPay));
      // Clear the override through the same editor: figures
      // return to the plain derived payment, strikethrough gone.
      // Opening the editor on the overridden term first: the
      // input is prefilled with the used $6,000, the calculated
      // figure stands struck through beside it and Reset shows.
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, ovUiPid);
      await wait(1500);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      const editingOv = await payRowState();
      check('on an overridden term the editor prefills the used payment, the calculated figure is struck through beside it, and Reset is offered',
        !editingOv.inputHidden && editingOv.inputValue === '6,000' && editingOv.refStruck === '$6,381.36' && !editingOv.resetHidden,
        JSON.stringify(editingOv));
      await page.keyboard.press('Backspace');
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      check('clearing the override restores the plain derived figure (no strikethrough anywhere)',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          const m = await tripleOf('#metaCurrentPayment');
          const s = await tripleOf('#estPaymentValue');
          return !!t && !!m && !!s
            && t.text.includes('6,381') && t.struckText === null
            && m.text.includes('6,381') && m.struckText === null
            && s.text.includes('6,381') && s.struckText === null;
        }));
      const ovUiCleared = (await req('GET', `/api/properties/${ovUiPid}/amortization`)).data;
      check('after the UI clear, the API projection is the derived one again',
        ovUiCleared.paymentUsed === 6381.36 && ovUiCleared.paymentOverridden === false,
        JSON.stringify({ u: ovUiCleared.paymentUsed, o: ovUiCleared.paymentOverridden }));
      // Reset path: set the override once more, then in the
      // editor click Reset — the box returns to the calculated
      // figure and saving clears the override (a figure equal to
      // the calculated one IS the calculated one).
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      await page.keyboard.type('6000');
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      check('the override is set again for the Reset path',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          return !!t && t.used === '$6,000.00' && t.struckText === '$6,381.36';
        }));
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-reset]').click());
      await wait(200);
      const afterReset = await payRowState();
      check('Reset puts the calculated figure back in the editor box',
        afterReset.inputValue === '6,381.36' && !afterReset.inputHidden,
        JSON.stringify(afterReset));
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      check('saving after Reset clears the override (figure plain again, editor back at rest)',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          const st = await payRowState();
          return !!t && t.text.includes('6,381') && t.struckText === null && st.inputHidden && st.inputValue === '';
        }));
      const ovUiReset = (await req('GET', `/api/properties/${ovUiPid}/amortization`)).data;
      check('after Reset + Save the API projection is the derived one',
        ovUiReset.paymentUsed === 6381.36 && ovUiReset.paymentOverridden === false,
        JSON.stringify({ u: ovUiReset.paymentUsed, o: ovUiReset.paymentOverridden }));
      await req('DELETE', `/api/properties/${ovUiPid}`);

      // ---- Segment compounding, driven through the UI ----
      // A Prime - 1 segment on $1,350,000 (balance dated
      // 2025-12-01, so the first projected months price at the
      // stub history's pinned 4.45 → 3.45%): added as Semi-annual,
      // deleted and re-added as Monthly — the segment row chip,
      // the first month's interest and the derived payment all
      // follow the convention; switching back restores the semi
      // figures.
      r = await req('POST', '/api/properties', {
        address: '888 Compounding UI Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2025-12-01', purchase_date: '2025-06-01', amortization_years: 30,
      });
      const cmpUiPid = r.data.id;
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, cmpUiPid);
      await wait(1500);
      const ensureMortgageModal = async () => {
        const open = await page.evaluate(() => !document.querySelector('#mortgageModal').classList.contains('hidden'));
        if (!open) { await page.evaluate(() => document.querySelector('#openMortgageBtn').click()); await wait(800); }
      };
      const chipText = () => page.evaluate(() => {
        const chip = document.querySelector('.seg-table .badge.cmp');
        return chip ? chip.textContent : null;
      });
      const fillSegForm = async (compounding) => {
        await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
        await wait(400);
        await page.evaluate((cmp) => {
          const form = document.querySelector('[data-seg-form]');
          form.start_date.value = '2025-12-01';
          const type = form.querySelector('[name=rate_type]');
          type.value = 'variable';
          type.dispatchEvent(new Event('change', { bubbles: true }));
          const mode = form.querySelector('[name=rate_mode]');
          mode.value = 'prime_spread';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          const spread = form.querySelector('[name=spread]');
          spread.value = '-1';
          spread.dispatchEvent(new Event('input', { bubbles: true }));
          const sel = form.querySelector('[name=compounding]');
          sel.value = cmp;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, compounding);
      };
      await ensureMortgageModal();
      await fillSegForm('semi_annual');
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      check('segment added via the UI carries the Semi-annual chip',
        await untilNode(async () => (await chipText()) === 'Semi-annual'));
      const cmpSemiProj = (await req('GET', `/api/properties/${cmpUiPid}/amortization`)).data;
      check('the semi-annual projection prices the first month at the semi-annual monthly rate',
        Math.abs(cmpSemiProj.series[0].interest - Math.round(1350000 * engineMonthlyRate(3.45) * 100) / 100) < 0.02
          && cmpSemiProj.paymentUsed === engineDerive(1350000, 3.45, 30),
        JSON.stringify({ i: cmpSemiProj.series[0].interest, p: cmpSemiProj.paymentUsed }));
      // Switch to Monthly: delete the segment and re-add it with
      // the Monthly compounding selected.
      await page.evaluate(() => document.querySelector('[data-del-seg]').click());
      check('the segment deletes through the UI',
        await untilNode(async () => (await chipText()) === null));
      await ensureMortgageModal();
      await fillSegForm('monthly');
      check('the live preview follows the compounding select (monthly interest shows before saving)',
        await until(() => {
          const out = document.querySelector('[data-plan-preview]');
          return !!out && out.textContent.includes('3,881');
        }));
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      check('the re-added segment carries the Monthly chip',
        await untilNode(async () => (await chipText()) === 'Monthly'));
      const cmpMonthlyProj = (await req('GET', `/api/properties/${cmpUiPid}/amortization`)).data;
      check('the monthly projection: first interest is exactly 1,350,000 x 3.45%/12 = 3,881.25 and the derived payment follows',
        cmpMonthlyProj.series[0].interest === 3881.25
          && cmpMonthlyProj.paymentUsed === engineDerive(1350000, 3.45, 30, 'monthly')
          && cmpMonthlyProj.paymentUsed !== cmpSemiProj.paymentUsed,
        JSON.stringify({ i: cmpMonthlyProj.series[0].interest, p: cmpMonthlyProj.paymentUsed }));
      // Switch back to Semi-annual: figures restore.
      await page.evaluate(() => document.querySelector('[data-del-seg]').click());
      await untilNode(async () => (await chipText()) === null);
      await ensureMortgageModal();
      await fillSegForm('semi_annual');
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      check('the segment switched back carries the Semi-annual chip',
        await untilNode(async () => (await chipText()) === 'Semi-annual'));
      const cmpBackProj = (await req('GET', `/api/properties/${cmpUiPid}/amortization`)).data;
      check('switching back restores the semi-annual projection to the row',
        JSON.stringify(cmpBackProj.series) === JSON.stringify(cmpSemiProj.series)
          && cmpBackProj.paymentUsed === cmpSemiProj.paymentUsed,
        JSON.stringify({ p: cmpBackProj.paymentUsed }));
      await req('DELETE', `/api/properties/${cmpUiPid}`);

      // ---- Segment Locked on, driven through the UI ----
      // His real shape (the API section's fixture): the segment
      // starts with no lock and the figure is the funding-day
      // derivation $6,800; the pay block no longer carries any
      // pricing-date input — the lock lives on the segment.
      // Setting Locked on to the letter date (2024-12-10) in the
      // segment's edit form and saving re-derives the figure to
      // $7,206; clearing restores $6,800. The saved value echoes
      // in the edit form after the save reload.
      r = await req('POST', '/api/properties', {
        address: '14 Pricing Date UI Road, Victoria, BC',
        mortgage_balance: 1450000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17', amortization_years: 30,
      });
      const pdUiPid = r.data.id;
      await req('POST', `/api/properties/${pdUiPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'monthly',
      });
      await req('POST', `/api/properties/${pdUiPid}/lump-sums`, { date: '2024-12-20', amount: 100000 });
      // Detour + full goto (the deleted compounding fixture's id
      // is reused by this property, so a bare hash jump may name
      // the page already showing and navigate nowhere — the same
      // trap the remaining-balance section documents).
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(800);
      await page.goto(`http://ff.local/#property/${pdUiPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      check('locked-on UI fixture: the detail stat shows the blank derivation $6,800',
        await until(() => document.querySelector('#estPaymentValue').textContent.includes('6,800')));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const pdBlock = await page.evaluate(() => {
        const block = document.querySelector('[data-pay-block]');
        return {
          hasPricingInput: !!block.querySelector('[name=payment_pricing_date]'),
          figure: block.querySelector('[data-term-payment]').textContent,
        };
      });
      check('the pay block carries no pricing-date input anymore (the lock moved to the segment)',
        pdBlock.hasPricingInput === false && pdBlock.figure.includes('6,800'),
        JSON.stringify(pdBlock));
      const pdSegState = () => page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const input = form.querySelector('[name=locked_on]');
        const cell = form.querySelector('[data-seg-spread]');
        const label = input ? [...form.querySelectorAll('label')].find((l) => l.textContent === 'Locked on') : null;
        return {
          value: input ? input.value : null,
          cellHidden: cell ? cell.classList.contains('hidden') : null,
          hasLabel: !!label,
          editSeg: form.dataset.editSeg || null,
        };
      });
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(500);
      const pdSegRest = await pdSegState();
      check('editing the prime-spread segment shows a blank Locked on date input in the (visible) spread cell',
        pdSegRest.value === '' && pdSegRest.cellHidden === false && pdSegRest.hasLabel && !!pdSegRest.editSeg,
        JSON.stringify(pdSegRest));
      await page.evaluate(() => {
        const input = document.querySelector('[data-seg-form] [name=locked_on]');
        input.value = '2024-12-10';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      check('setting Locked on to the letter date re-derives the figure to $7,205.89 after Save',
        await untilNode(async () => {
          const s = await page.evaluate(() => document.querySelector('[data-term-payment]').textContent);
          return s.includes('7,205.89');
        }));
      const pdUiProj = (await req('GET', `/api/properties/${pdUiPid}/amortization`)).data;
      check('the UI-saved lock drives the API derivation (7,205.89)',
        pdUiProj.paymentDerived === 7205.89, JSON.stringify({ d: pdUiProj.paymentDerived }));
      const pdUiProp = (await req('GET', `/api/properties/${pdUiPid}`)).data;
      check('the lock is stored on the segment (echoed in the payload, with its row badge)',
        pdUiProp.segments[0].locked_on === '2024-12-10', JSON.stringify(pdUiProp.segments[0]));
      const pdBadge = await page.evaluate(() => {
        const row = document.querySelector('#segmentRows tr');
        return row ? row.textContent : '';
      });
      check('the segment row shows the Locked badge with the date',
        pdBadge.includes('Locked 2024-12-10'), String(pdBadge));
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(500);
      const pdSegSaved = await pdSegState();
      check('reopening the segment edit shows the saved Locked on date',
        pdSegSaved.value === '2024-12-10', JSON.stringify(pdSegSaved));
      await page.evaluate(() => {
        const input = document.querySelector('[data-seg-form] [name=locked_on]');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      check('clearing Locked on restores the $6,800 figure after Save',
        await untilNode(async () => {
          const s = await page.evaluate(() => document.querySelector('[data-term-payment]').textContent);
          return s.includes('6,800');
        }));
      await req('DELETE', `/api/properties/${pdUiPid}`);

      // ---- Segment editing, driven through the UI ----
      // One Prime - 1 semi-annual segment on $1,350,000 (balance
      // dated 2025-12-01; the stub prime pins 4.45, so the segment
      // runs at 3.45%). Its row's Edit button loads it into the
      // segment form prefilled and in edit mode; changing the
      // spread to -2 and the compounding to Monthly and saving
      // updates the SAME segment (count and id unchanged) and the
      // projection follows; Cancel drops back to add mode without
      // touching the segment; delete + add still work afterwards.
      r = await req('POST', '/api/properties', {
        address: '21 Segment Edit Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2025-12-01', purchase_date: '2025-06-01', amortization_years: 30,
      });
      const segEditPid = r.data.id;
      await req('POST', `/api/properties/${segEditPid}/rates`, {
        start_date: '2025-12-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'semi_annual',
      });
      const segEditBefore = (await req('GET', `/api/properties/${segEditPid}`)).data;
      const segEditId = segEditBefore.segments[0].id;
      const segBaseProj = (await req('GET', `/api/properties/${segEditPid}/amortization`)).data;
      check('segment-edit fixture: one semi-annual Prime - 1 segment, derived payment at 3.45%',
        segEditBefore.segments.length === 1 && segBaseProj.paymentUsed === engineDerive(1350000, 3.45, 30),
        JSON.stringify({ n: segEditBefore.segments.length, p: segBaseProj.paymentUsed }));
      // Same-term start_date uniqueness, API level: a second
      // segment on the same start in the same term is a 400, on
      // add and on edit alike (an edit excludes itself).
      r = await req('POST', `/api/properties/${segEditPid}/rates`, {
        start_date: '2025-12-01', rate_type: 'fixed', annual_rate: 5,
      });
      check('adding a second segment on the same start date in the same term is rejected (400)',
        r.status === 400, JSON.stringify(r.data));
      r = await req('POST', `/api/properties/${segEditPid}/rates`, {
        start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 5,
      });
      check('a segment on a different start date adds fine', r.status === 201, JSON.stringify(r.data));
      const segEditOther = r.data.id;
      r = await req('PUT', `/api/properties/${segEditPid}/rates/${segEditOther}`, { start_date: '2025-12-01' });
      check('editing a segment onto a taken start date is rejected (400)',
        r.status === 400, JSON.stringify(r.data));
      r = await req('PUT', `/api/properties/${segEditPid}/rates/${segEditOther}`, { annual_rate: 5.5 });
      check('editing a segment while keeping its own start date passes (itself excluded)',
        r.status === 200 && r.data.annual_rate === 5.5, JSON.stringify(r.data));
      await req('DELETE', `/api/properties/${segEditPid}/rates/${segEditOther}`);
      // Detour + full goto, as in the pricing-date section (id
      // reuse makes bare hash jumps unreliable).
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(800);
      await page.goto(`http://ff.local/#property/${segEditPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const segFormState = () => page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const submit = form.querySelector('[data-seg-submit]');
        const cancel = form.querySelector('[data-seg-cancel-edit]');
        return {
          hidden: form.classList.contains('hidden'),
          editSeg: form.dataset.editSeg || null,
          submitLabel: submit ? submit.textContent.trim() : null,
          cancelHidden: cancel ? cancel.classList.contains('hidden') : null,
          start: form.start_date.value, type: form.rate_type.value, mode: form.rate_mode.value,
          spread: form.spread.value, compounding: form.compounding.value,
        };
      });
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(400);
      const segEditState = await segFormState();
      check('Edit opens the segment form prefilled, in edit mode (Save segment + Cancel edit)',
        segEditState.hidden === false && segEditState.editSeg === String(segEditId)
          && segEditState.submitLabel === 'Save segment' && segEditState.cancelHidden === false
          && segEditState.start === '2025-12-01' && segEditState.type === 'variable'
          && segEditState.mode === 'prime_spread' && segEditState.spread === '-1'
          && segEditState.compounding === 'semi_annual',
        JSON.stringify(segEditState));
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const spread = form.querySelector('[name=spread]');
        spread.value = '-2';
        spread.dispatchEvent(new Event('input', { bubbles: true }));
        const cmp = form.querySelector('[name=compounding]');
        cmp.value = 'monthly';
        cmp.dispatchEvent(new Event('change', { bubbles: true }));
        form.requestSubmit();
      });
      // The row's rate text shows the segment formula and what
      // it resolves to at the CURRENT prime (stub latest 4.95,
      // so Prime - 2 reads 2.95) — the projection figure, priced
      // at the start month's prime, is asserted separately.
      check('the edited segment re-renders in place (Monthly chip, Prime - 2.00% (now 2.95%))',
        await untilNode(async () => page.evaluate(() => {
          const chip = document.querySelector('.seg-table .badge.cmp');
          const row = document.querySelector('.seg-table tbody tr');
          return !!chip && chip.textContent === 'Monthly' && !!row && row.textContent.includes('Prime − 2.00%') && row.textContent.includes('2.95');
        })));
      const segEditAfter = (await req('GET', `/api/properties/${segEditPid}`)).data;
      check('the save updated the same segment (count and id unchanged, new spread + compounding)',
        segEditAfter.segments.length === 1 && segEditAfter.segments[0].id === segEditId
          && segEditAfter.segments[0].spread === -2 && segEditAfter.segments[0].compounding === 'monthly',
        JSON.stringify(segEditAfter.segments));
      const segEditProj = (await req('GET', `/api/properties/${segEditPid}/amortization`)).data;
      check('the projection follows the edited segment (Prime - 2 at monthly compounding)',
        segEditProj.paymentUsed === engineDerive(1350000, 2.45, 30, 'monthly')
          && segEditProj.paymentUsed !== segBaseProj.paymentUsed,
        JSON.stringify({ p: segEditProj.paymentUsed, base: segBaseProj.paymentUsed }));
      // Cancel: an edit abandoned mid-way changes nothing and
      // the form returns to add mode.
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(400);
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const spread = form.querySelector('[name=spread]');
        spread.value = '-0.5';
        spread.dispatchEvent(new Event('input', { bubbles: true }));
        // A click INSIDE the form (into another field) must not
        // reset the in-progress edit — regression: the form
        // itself carries data-edit-seg in edit mode, and a bare
        // attribute match in the click delegate once re-entered
        // edit mode (re-prefilling) on any form-internal click.
        form.querySelector('[name=start_date]').click();
      });
      await wait(200);
      const segMidState = await segFormState();
      check('clicking inside the edit form keeps the in-progress edit (spread still -0.5, still editing)',
        segMidState.editSeg === String(segEditId) && segMidState.spread === '-0.5',
        JSON.stringify(segMidState));
      await page.evaluate(() => {
        document.querySelector('[data-seg-form]').querySelector('[data-seg-cancel-edit]').click();
      });
      await wait(300);
      const segCancelState = await segFormState();
      check('Cancel edit hides the form and returns it to add mode',
        segCancelState.hidden === true && segCancelState.editSeg === null
          && segCancelState.submitLabel === 'Add segment' && segCancelState.cancelHidden === true,
        JSON.stringify(segCancelState));
      const segAfterCancel = (await req('GET', `/api/properties/${segEditPid}`)).data;
      check('the cancelled edit saved nothing (spread still -2)',
        segAfterCancel.segments.length === 1 && segAfterCancel.segments[0].spread === -2,
        JSON.stringify(segAfterCancel.segments));
      // Delete + add regression through the UI.
      await page.evaluate(() => document.querySelector('[data-del-seg]').click());
      check('the edited segment deletes through the UI',
        await untilNode(async () => page.evaluate(() => !document.querySelector('.seg-table .badge.cmp'))));
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(400);
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        form.start_date.value = '2025-12-01';
        const type = form.querySelector('[name=rate_type]');
        type.value = 'fixed';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        const rate = form.querySelector('[name=annual_rate]');
        rate.value = '5';
        rate.dispatchEvent(new Event('input', { bubbles: true }));
        form.requestSubmit();
      });
      // (No id-novelty assertion: SQLite may hand the deleted
      // row's id to the next insert. The fresh segment is the
      // fixed 5% one, in place of the deleted prime-spread.)
      check('a fresh segment adds through the UI after the delete (add mode)',
        await untilNode(async () => {
          const d = (await req('GET', `/api/properties/${segEditPid}`)).data;
          return d.segments.length === 1 && d.segments[0].rate_type === 'fixed' && d.segments[0].annual_rate === 5;
        }));
      await req('DELETE', `/api/properties/${segEditPid}`);

      // ---- AI Fill, driven through the UI ----
      // The stubbed model returns the RBC commitment-letter
      // fields. The lender is hand-filled first (extraction must
      // keep it); the other term inputs are blanked so the fill
      // has somewhere to land. Expectations: the panel summarizes
      // "Filled 10 fields · 1 kept", flags sit only on the filled
      // fields, a hand edit clears its flag, and after saving the
      // term AND the segment, a full page reload re-renders the
      // surviving flags (term form + segment row).
      fs.writeFileSync(aiStubFile, JSON.stringify({
        fields: {
          lender: 'RBC', start_date: '2024-12-17', term_months: 60, amortization_years: 30,
          opening_balance: 1350000, payment_override: 7207.10,
          segment_rate_type: 'variable', segment_rate_mode: 'prime_spread', segment_spread: -1,
          segment_compounding: 'monthly', segment_start_date: '2024-12-17',
        },
      }));
      r = await req('POST', '/api/properties', {
        address: '12 AI Fill Avenue, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-01', amortization_years: 25,
      });
      const aiPid = r.data.id;
      // Navigate by hash + a forced reload (a hash assignment or
      // a fragment-only goto can leave a stale page up when the
      // id was recycled from a just-deleted property), then wait
      // until THIS property's term form is rendered.
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, aiPid);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      check('the AI property detail renders its own term form',
        await untilNode(async () => page.evaluate(() => {
          const i = document.querySelector('[data-term-form] [name=start_date]');
          return !!i && i.value === '2024-12-17';
        })));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const aiFlagOf = (formSel, name) => page.evaluate((sel, n) => {
        const form = document.querySelector(sel);
        if (!form) return null;
        // The payment editor's input lives in the card's pay
        // block (below the form), not inside the form element.
        const input = form.querySelector(`[name="${n}"]`)
          || (form.closest('.term-block') || document).querySelector(`[data-pay-block] [name="${n}"]`);
        if (!input) return null;
        let host = input.parentElement;
        while (host) {
          const l = [...host.children].find((c) => c.tagName === 'LABEL');
          if (l) return l.querySelector('.ai-flag') != null;
          host = host.parentElement;
        }
        return null;
      }, formSel, name);
      await page.evaluate(() => {
        const form = document.querySelector('[data-term-form]');
        const seg = document.querySelector('[data-seg-form]');
        const set = (f, name, value) => {
          const input = f.querySelector(`[name="${name}"]`);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(form, 'lender', 'TD Bank'); // hand-filled: extraction must keep it
        set(form, 'start_date', '');
        set(form, 'term_months', '');
        set(form, 'amortization_years', '');
        set(form, 'opening_balance', '');
        // The segment form blanked too (its selects and defaulted
        // start date otherwise count as already-filled and are
        // kept, per the write rule).
        set(seg, 'start_date', '');
        set(seg, 'rate_type', '');
        set(seg, 'rate_mode', '');
        set(seg, 'compounding', '');
      });
      await page.evaluate(() => document.querySelector('[data-term-form] [data-ai-toggle]').click());
      await wait(300);
      await page.evaluate(() => {
        document.querySelector('[data-term-form] [data-ai-text]').value = 'RBC commitment letter';
        document.querySelector('[data-term-form] [data-ai-extract]').click();
      });
      check('the panel summarizes the fill: 10 filled, the hand-filled lender kept',
        await until(() => {
          const s = document.querySelector('[data-term-form] [data-ai-summary]');
          return !!s && s.textContent.includes('Filled 10 fields') && s.textContent.includes('1 kept');
        }));
      const aiValues = await page.evaluate(() => {
        const form = document.querySelector('[data-term-form]');
        const seg = document.querySelector('[data-seg-form]');
        const v = (f, n) => (f.querySelector(`[name="${n}"]`)
          || f.closest('.term-block').querySelector(`[data-pay-block] [name="${n}"]`)).value;
        return {
          lender: v(form, 'lender'), start: v(form, 'start_date'), months: v(form, 'term_months'),
          amort: v(form, 'amortization_years'), opening: v(form, 'opening_balance'), override: v(form, 'payment_override'),
          segType: v(seg, 'rate_type'), segMode: v(seg, 'rate_mode'), segSpread: v(seg, 'spread'),
          segCmp: v(seg, 'compounding'), segStart: v(seg, 'start_date'),
        };
      });
      check('the inputs hold the extracted values (money grouped), the kept lender untouched',
        aiValues.lender === 'TD Bank' && aiValues.start === '2024-12-17' && aiValues.months === '60'
          && aiValues.amort === '30' && aiValues.opening === '1,350,000' && aiValues.override === '7,207.1'
          && aiValues.segType === 'variable' && aiValues.segMode === 'prime_spread' && aiValues.segSpread === '-1'
          && aiValues.segCmp === 'monthly' && aiValues.segStart === '2024-12-17',
        JSON.stringify(aiValues));
      // The extracted override lands in the Monthly payment
      // row's inline editor: the row is in EDIT state (the input
      // shown in place of the figure) without anyone clicking
      // Edit.
      const aiPayEdit = await page.evaluate(() => {
        const row = document.querySelector('[data-pay-block]');
        return {
          inputHidden: row.querySelector('[name=payment_override]').classList.contains('hidden'),
          viewHidden: row.querySelector('[data-term-payment]').classList.contains('hidden'),
        };
      });
      check('the extracted override opens the payment row’s inline editor (input shown in place of the figure)',
        aiPayEdit.inputHidden === false && aiPayEdit.viewHidden === true,
        JSON.stringify(aiPayEdit));
      check('flags sit on the filled term fields — and not on the kept lender',
        (await aiFlagOf('[data-term-form]', 'start_date')) === true
          && (await aiFlagOf('[data-term-form]', 'term_months')) === true
          && (await aiFlagOf('[data-term-form]', 'amortization_years')) === true
          && (await aiFlagOf('[data-term-form]', 'opening_balance')) === true
          && (await aiFlagOf('[data-term-form]', 'payment_override')) === true
          && (await aiFlagOf('[data-term-form]', 'lender')) === false);
      check('flags sit on the filled segment fields',
        (await aiFlagOf('[data-seg-form]', 'start_date')) === true
          && (await aiFlagOf('[data-seg-form]', 'rate_type')) === true
          && (await aiFlagOf('[data-seg-form]', 'compounding')) === true
          && (await aiFlagOf('[data-seg-form]', 'spread')) === true);
      // A hand edit clears that field's flag at once.
      await page.evaluate(() => {
        const input = document.querySelector('[data-term-form] [name=term_months]');
        input.value = '72';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      check('a hand edit clears the edited field’s flag (the rest stay)',
        (await aiFlagOf('[data-term-form]', 'term_months')) === false
          && (await aiFlagOf('[data-term-form]', 'start_date')) === true);
      // Save the term, then the segment (the segment draft rides
      // across the term save's reload), then verify persistence.
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      await wait(1500);
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(400);
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      check('the segment saves with its Monthly chip',
        await untilNode(async () => (await chipText()) === 'Monthly'));
      const aiSaved = (await req('GET', `/api/properties/${aiPid}`)).data;
      check('the persisted flags: term fields minus the hand-edited one; all segment fields (and the AI override itself saved)',
        JSON.stringify([...aiSaved.terms[0].ai_fields].sort()) === JSON.stringify(['amortization_years', 'opening_balance', 'payment_override', 'start_date'])
          && JSON.stringify([...aiSaved.segments[0].ai_fields].sort()) === JSON.stringify(['compounding', 'rate_mode', 'rate_type', 'spread', 'start_date'])
          && aiSaved.terms[0].payment_override === 7207.1,
        JSON.stringify({ t: aiSaved.terms[0].ai_fields, s: aiSaved.segments[0].ai_fields, po: aiSaved.terms[0].payment_override }));
      await page.reload({ waitUntil: 'load' });
      await wait(1800);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      check('after a full reload the surviving term flags re-render (edited + kept fields unflagged)',
        (await aiFlagOf('[data-term-form]', 'start_date')) === true
          && (await aiFlagOf('[data-term-form]', 'amortization_years')) === true
          && (await aiFlagOf('[data-term-form]', 'opening_balance')) === true
          && (await aiFlagOf('[data-term-form]', 'payment_override')) === true
          && (await aiFlagOf('[data-term-form]', 'term_months')) === false
          && (await aiFlagOf('[data-term-form]', 'lender')) === false);
      const aiRowFlags = await page.evaluate(() => {
        const row = document.querySelector('.seg-table tbody tr');
        return row ? row.querySelectorAll('.ai-flag').length : 0;
      });
      check('after the reload the segment row carries its AI flags',
        aiRowFlags >= 3, JSON.stringify({ flags: aiRowFlags }));
      // Model picker: the stub answers per model name, so the
      // filled lender proves which model ran; the choice persists
      // server-side and the reloaded panel still shows it.
      fs.writeFileSync(aiStubFile, JSON.stringify({
        models: { 'stub-a': { fields: { lender: 'Bank A' } }, 'stub-b': { fields: { lender: 'Bank B' } } },
      }));
      const runModelFill = async (model) => {
        await page.evaluate((m) => {
          const form = document.querySelector('[data-term-form]');
          const lender = form.querySelector('[name=lender]');
          lender.value = '';
          lender.dispatchEvent(new Event('input', { bubbles: true }));
          const panel = form.querySelector('[data-ai-panel]');
          if (panel.classList.contains('hidden')) form.querySelector('[data-ai-toggle]').click();
          form.querySelector('[data-ai-model]').value = m;
          form.querySelector('[data-ai-text]').value = 'letter';
          form.querySelector('[data-ai-extract]').click();
        }, model);
        return until(() => {
          const input = document.querySelector('[data-term-form] [name=lender]');
          return !!input && input.value.startsWith('Bank ');
        });
      };
      check('the panel’s model dropdown lists the configured models',
        await until(() => {
          const sel = document.querySelector('[data-term-form] [data-ai-model]');
          return !!sel && sel.options.length === 2;
        }));
      const fillA = await runModelFill('stub-a');
      const lenderA = await page.evaluate(() => document.querySelector('[data-term-form] [name=lender]').value);
      const fillB = await runModelFill('stub-b');
      const lenderB = await page.evaluate(() => document.querySelector('[data-term-form] [name=lender]').value);
      check('switching the dropdown switches the model a fill runs with',
        fillA && lenderA === 'Bank A' && fillB && lenderB === 'Bank B',
        JSON.stringify({ lenderA, lenderB }));
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1500);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      check('after a reload the model dropdown still shows the persisted choice',
        await until(() => {
          const sel = document.querySelector('[data-term-form] [data-ai-model]');
          return !!sel && sel.value === 'stub-b';
        }));
      await req('DELETE', `/api/properties/${aiPid}`);

      // ---- Property costs: one editable table per year, both
      // charts and the AI chat, driven through the UI ----
      // Seeded: 2026 tax 5,400; 2025 tax 5,100 + water 480.
      r = await req('POST', '/api/properties', { address: '88 Costs UI Road, Victoria, BC', purchase_date: '2024-01-01' });
      const costUiPid = r.data.id;
      await req('POST', `/api/properties/${costUiPid}/costs`, { year: 2026, category: 'Property tax', amount: 5400 });
      await req('POST', `/api/properties/${costUiPid}/costs`, { year: 2025, category: 'Property tax', amount: 5100 });
      await req('POST', `/api/properties/${costUiPid}/costs`, { year: 2025, category: 'Water', amount: 480 });
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, costUiPid);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      check('the costs panel renders ONE table per year, each with its own footer total',
        await until(() => {
          const blocks = [...document.querySelectorAll('#costsYears [data-cost-year-block]')];
          const foot = (y) => {
            const b = blocks.find((x) => x.dataset.costYearBlock === String(y));
            return b && b.querySelector('tfoot') ? b.querySelector('tfoot').textContent : '';
          };
          return JSON.stringify(blocks.map((b) => b.dataset.costYearBlock)) === JSON.stringify(['2026', '2025'])
            && document.querySelectorAll('#costsYears tr[data-cost-row]').length === 3
            && foot(2026).includes('2026 total') && foot(2026).includes('5,400')
            && foot(2025).includes('2025 total') && foot(2025).includes('5,580');
        }));
      const topbarState = await page.evaluate(() => {
        const a = document.querySelector('#addCostYearBtn').getBoundingClientRect();
        const b = document.querySelector('[data-costs-ai-toggle]').getBoundingClientRect();
        return { sameRow: Math.abs(a.top - b.top) < 2, aTop: a.top, bTop: b.top };
      });
      check('"+ Add year" and "✨ Fill with AI" share ONE row at the panel top',
        topbarState.sameRow === true, JSON.stringify(topbarState));
      const costsHead = await page.evaluate(() => document.querySelector('#costsLatestTotal').textContent);
      check('the panel head shows the latest year total', costsHead.includes('2026') && costsHead.includes('5,400'), costsHead);
      const pieState = await page.evaluate(() => {
        const c = window.__fmCharts.costsPie;
        return c ? { labels: c.data.labels, data: c.data.datasets[0].data } : null;
      });
      check('the pie defaults to the latest year, slices = that year’s category totals',
        !!pieState && JSON.stringify(pieState.labels) === JSON.stringify(['Property tax']) && pieState.data[0] === 5400,
        JSON.stringify(pieState));
      await page.evaluate(() => {
        const s = document.querySelector('#costsPieYear');
        s.value = '2025';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(500);
      const pie2025 = await page.evaluate(() => {
        const c = window.__fmCharts.costsPie;
        return c ? { labels: c.data.labels, data: c.data.datasets[0].data } : null;
      });
      check('switching the pie year re-slices to that year (5,100 tax + 480 water)',
        !!pie2025 && pie2025.labels.includes('Water')
          && Math.abs(pie2025.data.reduce((a, b) => a + b, 0) - 5580) < 0.001,
        JSON.stringify(pie2025));
      const colorMatch = await page.evaluate(() => {
        const pie = window.__fmCharts.costsPie;
        const combo = window.__fmCharts.costsCombo;
        const pieMap = {};
        pie.data.labels.forEach((l, i) => { pieMap[l] = pie.data.datasets[0].backgroundColor[i]; });
        const comboMap = {};
        combo.data.datasets.filter((d) => d.type === 'bar').forEach((d) => { comboMap[d.label] = d.backgroundColor; });
        return Object.keys(pieMap).length > 0 && Object.keys(pieMap).every((k) => comboMap[k] === pieMap[k]);
      });
      check('a category keeps the same color in the pie and in the combo bars', colorMatch === true);
      const comboYear = await page.evaluate(() => {
        const c = window.__fmCharts.costsCombo;
        if (!c) return null;
        const totals = c.data.datasets.find((d) => d.label === 'Total');
        const bars = c.data.datasets.filter((d) => d.type === 'bar');
        return {
          labels: c.data.labels, totals: totals && totals.data,
          barSums: c.data.labels.map((_, i) => bars.reduce((s, d) => s + d.data[i], 0)),
        };
      });
      check('the combo By year: each stacked bar sums to the year total the line carries',
        !!comboYear && JSON.stringify(comboYear.labels) === JSON.stringify(['2025', '2026'])
          && comboYear.barSums[0] === 5580 && comboYear.barSums[1] === 5400
          && comboYear.totals[0] === 5580 && comboYear.totals[1] === 5400,
        JSON.stringify(comboYear));
      // Granularity switching re-renders from the loaded view —
      // count /costs requests to prove nothing is refetched.
      await page.evaluate(() => {
        window.__costsFetches = 0;
        const orig = window.fetch;
        window.fetch = (...args) => {
          if (String(args[0]).includes('/costs')) window.__costsFetches++;
          return orig(...args);
        };
      });
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="month"]').click());
      await wait(600);
      const comboMonth = await page.evaluate(() => {
        const c = window.__fmCharts.costsCombo;
        const totals = c.data.datasets.find((d) => d.label === 'Total');
        return { n: c.data.labels.length, first: c.data.labels[0], totals: totals.data, fetches: window.__costsFetches };
      });
      check('By month: 24 run-rate months whose 2025 twelve sum back to the year total, with no refetch',
        !!comboMonth && comboMonth.n === 24 && comboMonth.first === '2025-01'
          && Math.abs(comboMonth.totals.slice(0, 12).reduce((a, b) => a + b, 0) - 5580) < 0.05
          && comboMonth.fetches === 0,
        JSON.stringify(comboMonth));
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="year"]').click());
      await wait(400);

      // "+ Add year" opens a fresh year block (2027 — the
      // current year is taken, so the nearest unused one
      // follows) with a blank edit row; the year is still an
      // input there — retitle it 2024 and land its first row.
      await page.evaluate(() => document.querySelector('#addCostYearBtn').click());
      await wait(300);
      const addYearState = await page.evaluate(() => {
        const block = document.querySelector('[data-cost-year-block="2027"]');
        return block ? {
          hasYearInput: !!block.querySelector('[data-cost-year-input]'),
          hasEditRow: !!block.querySelector('tr.cost-editing'),
        } : null;
      });
      check('"+ Add year" opens a new year block (2027) with its year editable and a blank row',
        !!addYearState && addYearState.hasYearInput && addYearState.hasEditRow,
        JSON.stringify(addYearState));
      await page.evaluate(() => {
        const inp = document.querySelector('[data-cost-year-block="2027"] [data-cost-year-input]');
        inp.value = '2024';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2024"] tr.cost-editing');
        row.querySelector('[name=category]').value = 'Property tax';
        const amt = row.querySelector('[name=amount]');
        amt.value = '4900';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
        row.querySelector('[data-cost-save]').click();
      });
      check('the retitled 2024 block lands its first row and shows its own total (4,900)',
        await untilNode(async () => {
          const v = (await req('GET', `/api/properties/${costUiPid}/costs`)).data;
          return v.entries.some((e) => e.year === 2024 && e.category === 'Property tax' && e.amount === 4900);
        }) && await until(() => {
          const b = document.querySelector('[data-cost-year-block="2024"]');
          return !!b && !!b.querySelector('tfoot') && b.querySelector('tfoot').textContent.includes('4,900');
        }));

      // A monthly row through the 2026 table's OWN Add row:
      // basis Monthly opens the 12-month grid — fill Jan/Feb/
      // Mar only; the avg is computed, never typed.
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] [data-cost-add-row]').click());
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2026"] tr.cost-editing');
        row.querySelector('[name=category]').value = 'Electricity';
        const basis = row.querySelector('[name=basis]');
        basis.value = 'monthly';
        basis.dispatchEvent(new Event('change', { bubbles: true }));
        const set = (m, v) => {
          const inp = row.querySelector(`[data-month="${m}"]`);
          inp.value = v;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(1, '80'); set(2, '90'); set(3, '85');
      });
      const monthNote = await page.evaluate(() =>
        document.querySelector('[data-cost-year-block="2026"] tr.cost-editing .cost-amount-note').textContent);
      check('the month grid previews the computed avg + year figure (avg $85.00/mo · = $1,020.00/yr · 3 months)',
        monthNote.includes('avg $85.00/mo') && monthNote.includes('1,020') && monthNote.includes('3 months'),
        monthNote);
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] tr.cost-editing [data-cost-save]').click());
      check('the monthly row saves: year figure + "avg $85.00/mo (3 months)"; the 2026 footer follows (6,420)',
        await until(() => {
          const b = document.querySelector('[data-cost-year-block="2026"]');
          return !!b && b.textContent.includes('avg $85.00/mo (3 months)')
            && b.querySelector('tfoot').textContent.includes('6,420');
        }));
      check('the API stored the recorded months and the server-computed average',
        await untilNode(async () => {
          const v = (await req('GET', `/api/properties/${costUiPid}/costs`)).data;
          const e = v.entries.find((x) => x.category === 'Electricity');
          return !!e && e.amount === 85
            && JSON.stringify(e.monthlyAmounts) === JSON.stringify({ '1': 80, '2': 90, '3': 85 });
        }));
      // By month with detail on record: actual months land at
      // their amounts, the rest fill with the average.
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="month"]').click());
      await wait(600);
      const comboDetail = await page.evaluate(() => {
        const c = window.__fmCharts.costsCombo;
        const elec = c.data.datasets.find((d) => d.label === 'Electricity');
        const totals = c.data.datasets.find((d) => d.label === 'Total');
        const at = c.data.labels.indexOf('2026-01');
        return {
          jan: elec.data[at], feb: elec.data[at + 1], mar: elec.data[at + 2], apr: elec.data[at + 3],
          elecSum: elec.data.slice(at, at + 12).reduce((a, b) => a + b, 0),
          totalSum: totals.data.slice(at, at + 12).reduce((a, b) => a + b, 0),
        };
      });
      check('By month: Electricity 2026 shows Jan 80 / Feb 90 / Mar 85 actuals and Apr filled at the 85 avg',
        !!comboDetail && comboDetail.jan === 80 && comboDetail.feb === 90
          && comboDetail.mar === 85 && comboDetail.apr === 85
          && Math.abs(comboDetail.elecSum - 1020) < 0.05 && Math.abs(comboDetail.totalSum - 6420) < 0.05,
        JSON.stringify(comboDetail));
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="year"]').click());
      await wait(400);
      // A custom category through the Other… option, added from
      // the 2026 table's own Add row.
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] [data-cost-add-row]').click());
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2026"] tr.cost-editing');
        const sel = row.querySelector('[name=category]');
        sel.value = '__custom__';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        row.querySelector('[name=category_custom]').value = 'Gardening';
        const amt = row.querySelector('[name=amount]');
        amt.value = '300';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] tr.cost-editing [data-cost-save]').click());
      check('Other… turns the type into a free-form name, stored as its own category',
        await untilNode(async () => {
          const v = (await req('GET', `/api/properties/${costUiPid}/costs`)).data;
          return v.entries.some((e) => e.category === 'Gardening' && e.amount === 300);
        }));
      // Edit the water row in place: 480 -> 500.
      const waterEntry = (await req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Water');
      await page.evaluate((id) => document.querySelector(`[data-cost-edit="${id}"]`).click(), waterEntry.id);
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2025"] tr.cost-editing');
        const amt = row.querySelector('[name=amount]');
        amt.value = '500';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
        row.querySelector('[data-cost-save]').click();
      });
      check('editing a row in place updates the figure and its year footer (2025 -> 5,600)',
        await until(() => {
          const b = document.querySelector('[data-cost-year-block="2025"]');
          return !!b && b.querySelector('tfoot').textContent.includes('5,600');
        }));
      // Delete the gardening row (the page-wide dialog handler
      // registered earlier accepts the confirm).
      const gardenEntry = (await req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Gardening');
      await page.evaluate((id) => document.querySelector(`[data-cost-del="${id}"]`).click(), gardenEntry.id);
      check('deleting a row removes it and the totals drop back',
        await untilNode(async () => {
          const v = (await req('GET', `/api/properties/${costUiPid}/costs`)).data;
          return !v.entries.some((e) => e.category === 'Gardening') && v.latest.total === 6420;
        }));

      // The save race: while a save's reload is still in
      // flight, an edit opened on ANOTHER row must survive the
      // reload landing — the row AND what was typed into it.
      // Costs writes are delayed 700ms; the Electricity row is
      // saved untouched, and mid-flight the Water row is opened
      // and typed into.
      const elecIdForRace = (await req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Electricity').id;
      await page.evaluate(() => {
        window.__origFetch = window.fetch;
        window.fetch = async (...args) => {
          const method = (args[1] && args[1].method) || 'GET';
          if (String(args[0]).includes('/costs') && method !== 'GET') {
            await new Promise((r) => setTimeout(r, 700));
          }
          return window.__origFetch(...args);
        };
      });
      await page.evaluate((id) => document.querySelector(`[data-cost-edit="${id}"]`).click(), elecIdForRace);
      await wait(300);
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] tr.cost-editing [data-cost-save]').click());
      await wait(150); // the save is in flight now
      await page.evaluate((id) => document.querySelector(`[data-cost-edit="${id}"]`).click(), waterEntry.id);
      await wait(150);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2025"] tr.cost-editing');
        const amt = row.querySelector('[name=amount]');
        amt.value = '555';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(1800); // the delayed save + its reload land here
      const raceState = await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2025"] tr.cost-editing');
        return row ? { editing: row.dataset.costEditrow, amount: row.querySelector('[name=amount]').value } : null;
      });
      await page.evaluate(() => { window.fetch = window.__origFetch; delete window.__origFetch; });
      check('an edit opened while a save reload is in flight survives it — row and typed value alike',
        !!raceState && raceState.editing === `id:${waterEntry.id}` && raceState.amount.includes('555'),
        JSON.stringify(raceState));
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2025"] tr.cost-editing [data-cost-save]').click());
      check('the surviving edit then saves normally (Water 555, 2025 total 5,655)',
        await untilNode(async () => {
          const v = (await req('GET', `/api/properties/${costUiPid}/costs`)).data;
          const w = v.entries.find((e) => e.category === 'Water');
          return !!w && w.amount === 555 && v.years.find((y) => y.year === 2025).total === 5655;
        }));

      // ---- The AI costs chat through the UI: two rounds, then
      // Apply. Round 1 asks about the year with a partial
      // monthly proposal; round 2 completes it — including a
      // Property tax entry that conflicts with the recorded one
      // and must start unchecked.
      fs.writeFileSync(aiStubFile, JSON.stringify({
        reply: 'Which year is the strata bill for? Jan–Mar show $312/mo each.',
        proposed: [{ year: 2026, category: 'Strata fee', basis: 'monthly', monthlyAmounts: { 1: 312, 2: 312, 3: 312 } }],
        ready: false,
      }));
      await page.evaluate(() => document.querySelector('[data-costs-ai-toggle]').click());
      await wait(400);
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = 'strata bill attached';
        document.querySelector('[data-costs-chat-send]').click();
      });
      check('chat round 1: the question lands in the log and the proposal renders month by month',
        await until(() => {
          const log = document.querySelector('[data-costs-chat-log]');
          const rows = document.querySelectorAll('[data-proposed-row]');
          return log.textContent.includes('Which year is the strata bill for')
            && rows.length === 1 && rows[0].querySelector('[data-p-basis]').value === 'monthly'
            && (rows[0].querySelector('[data-p-month="1"]') || {}).value === '312'
            && rows[0].querySelector('.p-annual').textContent.includes('3,744')
            && rows[0].querySelector('.p-annual').textContent.includes('3 months');
        }));
      fs.writeFileSync(aiStubFile, JSON.stringify({
        reply: 'All set for 2026.',
        proposed: [
          { year: 2026, category: 'Strata fee', basis: 'monthly', monthlyAmounts: { 1: 312, 2: 312, 3: 312 } },
          { year: 2026, category: 'Property tax', amount: 5600, basis: 'annual' },
        ],
        ready: true,
      }));
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = '2026';
        document.querySelector('[data-costs-chat-send]').click();
      });
      check('chat round 2: the conflict starts unchecked and shows old → new ($5,400.00 → $5,600.00)',
        await until(() => {
          const rows = document.querySelectorAll('[data-proposed-row]');
          if (rows.length !== 2) return false;
          const conflict = [...rows].find((x) => x.classList.contains('conflict'));
          const clean = [...rows].find((x) => !x.classList.contains('conflict'));
          const diff = conflict ? conflict.querySelector('.conflict-diff') : null;
          return !!conflict && !!clean && !!diff
            && conflict.querySelector('[data-p-category]').value === 'Property tax'
            && conflict.querySelector('[data-p-check]').checked === false
            && diff.textContent.includes('5,400') && diff.textContent.includes('→') && diff.textContent.includes('5,600')
            && clean.querySelector('[data-p-check]').checked === true;
        }));
      await page.evaluate(() => document.querySelector('[data-costs-apply]').click());
      check('Apply lands only the checked entries — months included, source ai; the conflict stays manual',
        await untilNode(async () => {
          const v = (await req('GET', `/api/properties/${costUiPid}/costs`)).data;
          const strata = v.entries.find((e) => e.category === 'Strata fee');
          const tax = v.entries.find((e) => e.category === 'Property tax' && e.year === 2026);
          return !!strata && strata.source === 'ai' && strata.basis === 'monthly' && strata.amount === 312
            && JSON.stringify(strata.monthlyAmounts) === JSON.stringify({ '1': 312, '2': 312, '3': 312 })
            && !!tax && tax.source === 'manual' && tax.amount === 5400;
        }));
      check('after Apply the 2026 table shows the AI row and its footer total is 10,164',
        await until(() => {
          const b = document.querySelector('[data-cost-year-block="2026"]');
          return !!b && b.textContent.includes('Strata fee')
            && b.querySelector('tfoot').textContent.includes('10,164');
        }));

      // ---- Property outline: the floating Docs-style section
      // index. It must overlay the page (position fixed), leave
      // the content column exactly as wide as without it, list
      // the rendered sections in order, jump + highlight on
      // click, follow the scroll (scrollspy), and collapse to a
      // round toggle on narrow viewports. Auto-hide: it starts
      // hidden, fades in while the page scrolls, and back out a
      // few seconds after scrolling stops — hovering it (or the
      // open narrow card) holds it. The hide delay is shortened
      // via window.__fmOutline so the suite never waits out the
      // real 2.5s. ----
      await page.setViewport({ width: 1500, height: 900 });
      await wait(600);
      const outlineEntries = await page.evaluate(() =>
        [...document.querySelectorAll('#propOutlineList a')].map((a) => a.textContent.trim()));
      check('the outline lists the page’s sections in order (history rides with the projection)',
        JSON.stringify(outlineEntries) === JSON.stringify(
          ['Property Details', 'Value & Mortgage Projection', 'Assessment History', 'Property Costs']),
        JSON.stringify(outlineEntries));
      // The flows above scrolled this page plenty, so the outline
      // may be awake right now. Shorten the hide delay, then judge
      // the resting state once the countdown has run out. (No
      // reload here: it would collapse the AI chat panel above,
      // shorten the page, and the costs panel could no longer
      // physically scroll into the band the jump checks assert.)
      await page.evaluate(() => window.__fmOutline.setHideDelay(700));
      check('the outline settles back to hidden at rest',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      await wait(400); // let any fade-out transition settle
      const hiddenFacts = await page.evaluate(() => {
        const nav = document.querySelector('#propOutline');
        const cs = getComputedStyle(nav);
        const r = nav.getBoundingClientRect();
        const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          awake: nav.classList.contains('awake'), visibility: cs.visibility,
          opacity: cs.opacity, pointerEvents: cs.pointerEvents,
          underInNav: !!under && nav.contains(under),
        };
      });
      check('at rest the outline is fully hidden and lets clicks pass through',
        !hiddenFacts.awake && hiddenFacts.visibility === 'hidden' && hiddenFacts.opacity === '0'
          && hiddenFacts.pointerEvents === 'none' && !hiddenFacts.underInNav,
        JSON.stringify(hiddenFacts));
      const navFacts = await page.evaluate(() => {
        const nav = document.querySelector('#propOutline');
        const main = document.querySelector('main');
        const withNav = main.getBoundingClientRect().width;
        nav.style.display = 'none';
        const withoutNav = main.getBoundingClientRect().width;
        nav.style.display = '';
        return {
          position: getComputedStyle(nav).position,
          toggleDisplay: getComputedStyle(document.querySelector('#propOutlineToggle')).display,
          withNav, withoutNav,
        };
      });
      check('the outline is a fixed floating card, toggle hidden on a wide viewport',
        navFacts.position === 'fixed' && navFacts.toggleDisplay === 'none',
        JSON.stringify(navFacts));
      check('the floating outline takes no layout width (content column identical with/without it)',
        Math.abs(navFacts.withNav - navFacts.withoutNav) < 0.6,
        JSON.stringify(navFacts));
      await page.evaluate(() => window.scrollTo(0, 200));
      check('scrolling fades the outline in',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          return nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'visible';
        })));
      check('the outline fades back out once scrolling has stopped',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          return !nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'hidden';
        })));
      // Hover holds it open past the hide delay; leaving releases it.
      await page.evaluate(() => window.scrollBy(0, 40));
      await until(() => document.querySelector('#propOutline').classList.contains('awake'));
      const navBox = await page.evaluate(() => {
        const r = document.querySelector('#propOutline').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(navBox.x, navBox.y);
      await wait(1600); // > 2x the shortened 700ms hide delay
      check('hovering the outline holds it open past the hide delay',
        await page.evaluate(() => {
          const nav = document.querySelector('#propOutline');
          return nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'visible';
        }));
      await page.mouse.move(navBox.x + 420, navBox.y);
      check('moving the pointer away lets it hide again',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      const wakeNav = async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        await until(() => document.querySelector('#propOutline').classList.contains('awake'));
      };
      await wakeNav();
      await page.evaluate(() => {
        [...document.querySelectorAll('#propOutlineList a')]
          .find((a) => a.textContent.includes('Property Costs')).click();
      });
      check('clicking the Property Costs entry scrolls the costs panel under the topbar',
        !!(await until(() => {
          const r = document.querySelector('#costsPanel').getBoundingClientRect();
          return r.top >= 40 && r.top <= 110;
        })));
      check('the clicked entry carries the active highlight',
        await page.evaluate(() => {
          const a = document.querySelector('#propOutlineList a.active');
          return !!a && a.textContent.includes('Property Costs');
        }));
      await page.evaluate(() => window.scrollTo(0, 0));
      check('scrolling back to the top moves the highlight to Property Details (scrollspy)',
        !!(await until(() => {
          const a = document.querySelector('#propOutlineList a.active');
          return !!a && a.textContent.includes('Property Details')
            && document.querySelector('#propertyOverview').getBoundingClientRect().top >= 40;
        })));
      await wakeNav();
      await page.evaluate(() => {
        [...document.querySelectorAll('#propOutlineList a')]
          .find((a) => a.textContent.includes('Assessment History')).click();
      });
      check('the Assessment History entry opens the history modal',
        !!(await until(() => !document.querySelector('#historyModal').classList.contains('hidden'))));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);
      await page.setViewport({ width: 700, height: 900 });
      await wait(500);
      check('the outline is hidden at rest on a narrow viewport too',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      const narrowFacts = await page.evaluate(() => ({
        toggle: getComputedStyle(document.querySelector('#propOutlineToggle')).display,
        card: getComputedStyle(document.querySelector('.prop-outline-card')).display,
      }));
      check('on a narrow viewport the outline collapses to just the round toggle button',
        narrowFacts.toggle === 'flex' && narrowFacts.card === 'none', JSON.stringify(narrowFacts));
      await page.evaluate(() => window.scrollTo(0, 300));
      check('on a narrow viewport a scroll wakes the floating toggle',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          return nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'visible';
        })));
      await page.evaluate(() => document.querySelector('#propOutlineToggle').click());
      check('tapping the toggle opens the entry card',
        !!(await until(() => getComputedStyle(document.querySelector('.prop-outline-card')).display !== 'none')));
      await wait(1600); // > 2x the shortened hide delay
      check('the opened card holds the outline open past the hide delay',
        await page.evaluate(() => document.querySelector('#propOutline').classList.contains('awake')
          && getComputedStyle(document.querySelector('.prop-outline-card')).display !== 'none'));
      await page.evaluate(() => {
        [...document.querySelectorAll('#propOutlineList a')]
          .find((a) => a.textContent.includes('Property Costs')).click();
      });
      check('from the opened card an entry still jumps — and the card closes behind it',
        !!(await until(() => {
          const r = document.querySelector('#costsPanel').getBoundingClientRect();
          return r.top >= 40 && r.top <= 110
            && !document.querySelector('#propOutline').classList.contains('open');
        })));
      check('after the jump the outline auto-hides again on the narrow viewport',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      await page.evaluate(() => window.__fmOutline.setHideDelay(2500));
      await page.setViewport({ width: 800, height: 600 });
      await req('DELETE', `/api/properties/${costUiPid}`);
    } catch (err) {
      // A UI hiccup must surface as failed checks, not crash the suite.
      check('money UI browser flow runs to completion', false, String((err && err.message) || err));
    }
    } finally {
      await browser.close();
    }
  }

  // ---------------------------------------------------------------
  // Property costs with NO LLM configured: the panel still works
  // (table renders, entries save) and the AI chat shows the setup
  // guidance with Send disabled. A third server, no LLM env.
  if (!puppeteer || !fs.existsSync('/opt/meta-chromium/chrome')) {
    console.log('costs no-LLM browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-costs-nollm-'));
    const port3 = PORT + 702;
    const server3 = spawn('node', ['src/server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, DATA_DIR: dir3, PORT: String(port3) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const browser3 = await puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      let cookie3 = '';
      for (let i = 0; i < 50 && !cookie3; i++) {
        try {
          const login = await fetch(`http://127.0.0.1:${port3}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' }),
          });
          if (login.ok) cookie3 = (login.headers.get('set-cookie') || '').split(';')[0];
        } catch { /* not up yet */ }
        if (!cookie3) await new Promise((res3) => setTimeout(res3, 200));
      }
      const req3 = async (method, urlPath, body) => {
        const resp = await fetch(`http://127.0.0.1:${port3}${urlPath}`, {
          method,
          headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: resp.status, data: await resp.json().catch(() => null) };
      };
      const prop3 = await req3('POST', '/api/properties', { address: '5 No LLM Lane, Victoria, BC', purchase_date: '2024-01-01' });
      const pid3 = prop3.data.id;
      await req3('POST', `/api/properties/${pid3}/costs`, { year: 2026, category: 'Property tax', amount: 4200 });
      const chat503b = await req3('POST', '/api/ai/fill-chat', { propertyId: pid3, text: 'x' });
      check('fill-chat 503 names the missing LLM setup',
        chat503b.status === 503 && String(chat503b.data.error || '').includes('LLM_BASE_URL'),
        JSON.stringify(chat503b).slice(0, 200));
      const forward3 = (rq) => new Promise((resolve, reject) => {
        const rr = http.request(
          { host: '127.0.0.1', port: port3, path: rq.url, method: rq.method, headers: rq.headers },
          (resp) => {
            const chunks = [];
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
          }
        );
        rr.on('error', reject);
        if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
        rr.end();
      });
      const page3 = await browser3.newPage();
      const client3 = await page3.target().createCDPSession();
      await client3.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client3.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client3.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forward3({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client3.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client3.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client3.send('Network.setCookie', {
        name: 'ff_session', value: cookie3.split('=')[1], domain: 'ff.local', path: '/', httpOnly: true,
      });
      const wait3 = (ms) => new Promise((res3) => setTimeout(res3, ms));
      const until3 = async (fn, tries = 40) => {
        for (let i = 0; i < tries; i++) {
          try { const v = await page3.evaluate(fn); if (v) return v; } catch {}
          await wait3(250);
        }
        return null;
      };
      await page3.goto(`http://ff.local/#property/${pid3}`, { waitUntil: 'networkidle0', timeout: 30000 });
      check('without an LLM the costs panel still renders its entries',
        !!(await until3(() => {
          const rows = document.querySelectorAll('#costsYears tr[data-cost-row]');
          return rows.length === 1 && document.querySelector('#costsYears').textContent.includes('4,200');
        })));
      await page3.evaluate(() => document.querySelector('[data-costs-ai-toggle]').click());
      await wait3(500);
      const guidance3 = await page3.evaluate(() => {
        const g = document.querySelector('[data-costs-ai-guidance]');
        const send = document.querySelector('[data-costs-chat-send]');
        return { hidden: g.classList.contains('hidden'), text: g.textContent, sendDisabled: send.disabled };
      });
      check('the AI chat shows the setup guidance and Send stays disabled',
        guidance3.hidden === false && guidance3.text.includes('LLM_BASE_URL') && guidance3.sendDisabled === true,
        JSON.stringify(guidance3));
      // The rest of the panel is unaffected: an entry still saves
      // (through the seeded 2026 table's own Add row).
      await page3.evaluate(() => document.querySelector('[data-cost-year-block="2026"] [data-cost-add-row]').click());
      await wait3(300);
      await page3.evaluate(() => {
        const row = document.querySelector('#costsYears tr.cost-editing');
        row.querySelector('[name=category]').value = 'Water';
        const amt = row.querySelector('[name=amount]');
        amt.value = '480';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
        row.querySelector('[data-cost-save]').click();
      });
      check('entries still save with no LLM configured',
        !!(await until3(() => document.querySelector('#costsYears').textContent.includes('Water'))));
    } catch (err) {
      check('costs no-LLM browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browser3.close();
      server3.kill();
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------
  // HouseSigma history pull + BC Assessment fetch-on-read. The HS
  // stub's Christina payload mirrors the real sample property's
  // assessed values.
  const ptOf = (hist, year) => (hist.points || []).find((p) => p.year === year);

  // Adding a property fires a best-effort background pull: the
  // HouseSigma years appear by themselves, marked housesigma.
  r = await req('POST', '/api/properties', {
    address: '2985 Christina Pl, Coquitlam, BC', mortgage_balance: 1350000, purchase_date: '2024-12-17',
  });
  check('HS fixture property added', r.status === 201, JSON.stringify(r.data));
  const pidHs = r.data.id;
  let hsHist = null;
  for (let i = 0; i < 40; i++) {
    const h = await req('GET', `/api/properties/${pidHs}/value-history`);
    if (h.data.points && h.data.points.length === 5) { hsHist = h.data; break; }
    await new Promise((s) => setTimeout(s, 300));
  }
  check('background pull imported all 5 HouseSigma years after add', !!hsHist,
    JSON.stringify(hsHist ? hsHist.points : []));
  check('pulled points carry the housesigma source',
    !!hsHist && hsHist.points.every((p) => p.source === 'housesigma'));
  check('pulled values match the HouseSigma payload (2022 = 1,730,000, 2026 = 1,931,000)',
    !!hsHist && ptOf(hsHist, 2022).value === 1730000 && ptOf(hsHist, 2026).value === 1931000);
  check('pulled points carry the payload\u2019s land / building split (2022 = 1,306,000 / 424,000; 2026 = 1,503,000 / 428,000)',
    !!hsHist && ptOf(hsHist, 2022).land_value === 1306000 && ptOf(hsHist, 2022).building_value === 424000
      && ptOf(hsHist, 2026).land_value === 1503000 && ptOf(hsHist, 2026).building_value === 428000,
    JSON.stringify(hsHist ? hsHist.points : []));
  check('the detail call carried the located ids',
    !!hsLastDetailParams && hsLastDetailParams.id_address === 'HS-ADDR-1' && hsLastDetailParams.id_listing === 'HS-LIST-1',
    JSON.stringify(hsLastDetailParams));
  r = await req('GET', `/api/properties/${pidHs}`);
  check('property stored the HouseSigma ids for the next pull',
    r.data.hs_id_address === 'HS-ADDR-1' && r.data.hs_id_listing === 'HS-LIST-1', JSON.stringify(r.data.hs_id_address));

  // A manual point is never overwritten by a re-pull; HouseSigma's
  // own points refresh in place (no duplicates).
  r = await req('POST', `/api/properties/${pidHs}/value-history`, { year: 2024, value: 1900000 });
  check('manual 2024 point set over the pulled one', r.status === 201 && ptOf(r.data, 2024).source === 'manual');
  r = await req('POST', `/api/properties/${pidHs}/pull-history`);
  check('re-pull succeeds', r.data.ok === true, JSON.stringify(r.data));
  check('re-pull kept the manual 2024 point (value and source)',
    ptOf(r.data.history, 2024).value === 1900000 && ptOf(r.data.history, 2024).source === 'manual');
  check('re-pull reports the manual year as skipped',
    (r.data.skipped || []).some((s) => s.year === 2024 && s.kept === 'manual'), JSON.stringify(r.data.skipped));
  check('re-pull added no duplicate points', r.data.history.points.length === 5);
  check('the manual 2024 point carries no split (its entry had none)',
    ptOf(r.data.history, 2024).land_value == null && ptOf(r.data.history, 2024).building_value == null,
    JSON.stringify(ptOf(r.data.history, 2024)));
  // A re-pull refreshes HouseSigma's own splits in place: shift
  // the stub's 2023 land figure and the stored point follows.
  hsHistoryChristina.find((h) => h.year === 2023).land_int = 1400000;
  r = await req('POST', `/api/properties/${pidHs}/pull-history`);
  check('re-pull refreshes a HouseSigma point\u2019s split (2023 land 1,456,000 -> 1,400,000)',
    r.data.ok === true && ptOf(r.data.history, 2023).land_value === 1400000
      && ptOf(r.data.history, 2023).building_value === 447000,
    JSON.stringify(ptOf(r.data.history, 2023)));
  hsHistoryChristina.find((h) => h.year === 2023).land_int = 1456000;
  r = await req('POST', `/api/properties/${pidHs}/pull-history`);
  check('stub restored and re-pulled (2023 land back to 1,456,000)',
    r.data.ok === true && ptOf(r.data.history, 2023).land_value === 1456000,
    JSON.stringify(ptOf(r.data.history, 2023)));

  // BC Assessment ('auto') beats HouseSigma for the same year; a
  // year HouseSigma has and BCA does not is filled in.
  r = await req('POST', '/api/properties', {
    address: '1200 Douglas St, Victoria, BC', mortgage_balance: 500000, purchase_date: '2020-06-01', bca_id: 'QkxPQy0xMjAw',
  });
  const pidGov = r.data.id;
  for (let i = 0; i < 40; i++) { // let its background pull settle first
    const h = await req('GET', `/api/properties/${pidGov}/value-history`);
    if (h.data.points && h.data.points.some((p) => p.year === 2025)) break;
    await new Promise((s) => setTimeout(s, 300));
  }
  r = await req('POST', `/api/properties/${pidGov}/fetch-bca`);
  check('gov property manual BCA fetch ok', r.data.ok === true, JSON.stringify(r.data));
  r = await req('POST', `/api/properties/${pidGov}/pull-history`);
  check('gov pull ok', r.data.ok === true, JSON.stringify(r.data));
  check('BCA 2026 point kept over HouseSigma (6,532,000, auto)',
    ptOf(r.data.history, 2026).value === 6532000 && ptOf(r.data.history, 2026).source === 'auto');
  check('HouseSigma 2025 point stands (6,100,000, housesigma)',
    ptOf(r.data.history, 2025).value === 6100000 && ptOf(r.data.history, 2025).source === 'housesigma');
  check('the BCA fetch stored the current year\u2019s split on its point (2026 = 4,666,000 / 1,866,000)',
    ptOf(r.data.history, 2026).land_value === 4666000 && ptOf(r.data.history, 2026).building_value === 1866000,
    JSON.stringify(ptOf(r.data.history, 2026)));
  check('the HouseSigma 2025 point carries its split (4,050,000 / 2,050,000)',
    ptOf(r.data.history, 2025).land_value === 4050000 && ptOf(r.data.history, 2025).building_value === 2050000,
    JSON.stringify(ptOf(r.data.history, 2025)));

  // Manual points: Land + Building both given -> the year's total
  // is their sum and the split is stored; a total-only entry
  // leaves the split empty; a one-sided split is a 400; a PUT
  // with both figures re-sums the value.
  r = await req('POST', '/api/properties', {
    address: '555 Split Lane, Coquitlam, BC', mortgage_balance: 100000, purchase_date: '2024-01-01',
  });
  const pidSplit = r.data.id;
  r = await req('POST', `/api/properties/${pidSplit}/value-history`, { year: 2021, land_value: 1200000, building_value: 400000 });
  check('manual point with Land + Building: value is their sum (1,600,000), split stored',
    r.status === 201 && ptOf(r.data, 2021).value === 1600000
      && ptOf(r.data, 2021).land_value === 1200000 && ptOf(r.data, 2021).building_value === 400000
      && ptOf(r.data, 2021).source === 'manual',
    JSON.stringify(ptOf(r.data, 2021)));
  r = await req('POST', `/api/properties/${pidSplit}/value-history`, { year: 2020, value: 900000 });
  check('manual total-only point: split stays empty',
    r.status === 201 && ptOf(r.data, 2020).value === 900000
      && ptOf(r.data, 2020).land_value == null && ptOf(r.data, 2020).building_value == null,
    JSON.stringify(ptOf(r.data, 2020)));
  r = await req('POST', `/api/properties/${pidSplit}/value-history`, { year: 2019, value: 500000, land_value: 500000 });
  check('a one-sided split is rejected (400)',
    r.status === 400 && /given together/.test(r.data.error || ''), JSON.stringify(r.data));
  const pt2020 = ptOf(r.data, 2020) || (await req('GET', `/api/properties/${pidSplit}/value-history`)).data.points.find((p) => p.year === 2020);
  r = await req('PUT', `/api/properties/${pidSplit}/value-history/${pt2020.id}`, { land_value: 700000, building_value: 250000 });
  check('PUT with both split figures re-sums the value (900,000 -> 950,000)',
    r.status === 200 && ptOf(r.data, 2020).value === 950000
      && ptOf(r.data, 2020).land_value === 700000 && ptOf(r.data, 2020).building_value === 250000,
    JSON.stringify(ptOf(r.data, 2020)));
  await req('DELETE', `/api/properties/${pidSplit}`);

  // Fetch-on-read: a never-fetched property with a BCA id refreshes
  // itself when its detail is loaded — through the by-id channel —
  // and does not refetch on the next load.
  r = await req('POST', '/api/properties', {
    address: '1200 Douglas St, Victoria, BC', mortgage_balance: 400000, purchase_date: '2019-01-01', bca_id: 'QkxPQy0xMjAw',
  });
  const pidAuto = r.data.id;
  const infoBefore = stubHits.info.length;
  r = await req('GET', `/api/properties/${pidAuto}`);
  check('detail load auto-fetched the BCA value (6,532,000 / 2026)',
    r.data.assessed_value === 6532000 && r.data.assessed_year === 2026, JSON.stringify(r.data.assessed_value));
  check('auto-refresh went through the by-id property page', stubHits.info.length > infoBefore);
  const infoAfterFirst = stubHits.info.length;
  r = await req('GET', `/api/properties/${pidAuto}`);
  check('second load does not refetch (attempt gate)', stubHits.info.length === infoAfterFirst);

  // A failed auto-refresh keeps the stored state and flags stale
  // with the failing stage named.
  stubInfoDown = true;
  r = await req('POST', '/api/properties', {
    address: '1200 Douglas St, Victoria, BC', mortgage_balance: 300000, purchase_date: '2018-01-01', bca_id: 'QkxPQy0xMjAw',
  });
  const pidFail = r.data.id;
  r = await req('GET', `/api/properties/${pidFail}`);
  check('failed auto-refresh leaves the value unset', r.data.assessed_value == null, JSON.stringify(r.data.assessed_value));
  check('failed auto-refresh is flagged stale, stage named',
    !!r.data.assessmentRefresh && r.data.assessmentRefresh.stale === true
      && /property page/.test(r.data.assessmentRefresh.error || ''),
    JSON.stringify(r.data.assessmentRefresh));
  stubInfoDown = false;

  // HouseSigma failures surface explicitly: a site outage fails the
  // pull with a named stage; an address it does not know fails too.
  hsMode = 'down';
  r = await req('POST', '/api/properties', {
    address: '2985 Christina Pl, Coquitlam, BC', mortgage_balance: 100000, purchase_date: '2024-01-01',
  });
  const pidDown = r.data.id;
  r = await req('POST', `/api/properties/${pidDown}/pull-history`);
  check('HouseSigma outage returns ok:false with an explicit stage',
    r.data.ok === false && typeof r.data.stage === 'string' && r.data.stage.length > 0
      && /HouseSigma lookup failed/.test(r.data.error || ''),
    JSON.stringify(r.data));
  hsMode = 'ok';
  r = await req('POST', '/api/properties', {
    address: '999 Nowhere Rd, Coquitlam, BC', mortgage_balance: 100000, purchase_date: '2024-01-01',
  });
  const pidNone = r.data.id;
  r = await req('POST', `/api/properties/${pidNone}/pull-history`);
  check('unknown address fails at the locate stage',
    r.data.ok === false && r.data.stage === 'locate', JSON.stringify(r.data));

  // ---------------------------------------------------------------
  // Assessment History modal in the browser: it opens on the
  // assessed-history bar chart (no source/status prose anywhere),
  // an in-modal HouseSigma pull grows the chart in place, and a BC
  // Assessment outage still surfaces as a short error line.
  if (!puppeteer || !fs.existsSync('/opt/meta-chromium/chrome')) {
    console.log('history modal browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    // A Christina property: the background pull imports all five
    // HouseSigma years; drop the 2023 point so the in-modal pull
    // has a year to add back.
    r = await req('POST', '/api/properties', {
      address: '2985 Christina Pl, Coquitlam, BC', mortgage_balance: 1350000, purchase_date: '2024-12-17',
    });
    const pidHist = r.data.id;
    let hist0 = null;
    for (let i = 0; i < 40; i++) {
      const h = await req('GET', `/api/properties/${pidHist}/value-history`);
      if (h.data.points && h.data.points.length === 5) { hist0 = h.data; break; }
      await new Promise((s) => setTimeout(s, 300));
    }
    check('history-modal fixture: background pull imported the 5 years', !!hist0,
      JSON.stringify(hist0 ? hist0.points : []));
    const pt2023 = hist0 && hist0.points.find((p) => p.year === 2023);
    r = await req('DELETE', `/api/properties/${pidHist}/value-history/${pt2023.id}`);
    check('history-modal fixture: 2023 point removed (4 points left)',
      !!r.data.points && r.data.points.length === 4, JSON.stringify(r.data.points && r.data.points.length));
    // A manual total-only year joins the split HouseSigma years:
    // the chart must stack the split years and draw 2021 as one
    // Total bar, the table shows its Land / Building as —.
    r = await req('POST', `/api/properties/${pidHist}/value-history`, { year: 2021, value: 1600000 });
    check('history-modal fixture: total-only 2021 point added (5 points)',
      r.status === 201 && r.data.points.length === 5, JSON.stringify(r.data.points && r.data.points.length));

    const forwardH = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: PORT, path: rq.url, method: rq.method, headers: rq.headers },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        }
      );
      rr.on('error', reject);
      if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
      rr.end();
    });
    const loginResH = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueH = loginResH.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserH = await puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserH.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardH({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueH, domain: 'ff.local', path: '/', httpOnly: true });
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const until = async (fn, tries = 48) => {
        for (let i = 0; i < tries; i++) {
          try { const v = await page.evaluate(fn); if (v) return v; } catch {}
          await wait(250);
        }
        return null;
      };

      await page.goto(`http://ff.local/#property/${pidHist}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(600);
      const before = await page.evaluate(() => {
        const modal = document.querySelector('#historyModal');
        const c = window.__fmCharts.history;
        const canvas = modal.querySelector('#historyChart');
        const rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
        const byKey = {};
        if (c) for (const ds of c.data.datasets) byKey[ds.key] = ds;
        const tipFor = (key, year) => {
          const ds = byKey[key];
          const i = c.data.labels.indexOf(year);
          const out = c.options.plugins.tooltip.callbacks.label({
            dataIndex: i, datasetIndex: c.data.datasets.indexOf(ds), dataset: ds,
            parsed: { y: ds.data[i] },
          });
          return Array.isArray(out) ? out.join(' | ') : String(out);
        };
        const legendTexts = c && c.legend ? c.legend.legendItems.map((it) => it.text) : [];
        const headCells = [...modal.querySelectorAll('#trendHead th')].map((th) => th.textContent.trim());
        const row2021 = [...modal.querySelectorAll('#trendRows tr')]
          .find((tr) => tr.cells[0] && tr.cells[0].textContent.trim() === '2021');
        return {
          text: modal.textContent,
          metaGone: !modal.querySelector('#assessmentMetaView') && !modal.querySelector('#hsPullNote'),
          bars: c ? c.data.datasets[0].data.length : null,
          labels: c ? c.data.labels : null,
          canvasW: rect.width, canvasH: rect.height,
          chartAboveButtons: canvas.getBoundingClientRect().top
            < document.querySelector('#fetchBcaBtn').getBoundingClientRect().top,
          stacks: c ? c.data.datasets.map((ds) => ds.stack) : null,
          land: byKey.land ? byKey.land.data : null,
          building: byKey.building ? byKey.building.data : null,
          total: byKey.total ? byKey.total.data : null,
          legendTexts,
          tipSplit: c ? tipFor('land', '2022') : null,
          tipTotalOnly: c ? tipFor('total', '2021') : null,
          headCells,
          row2021: row2021 ? row2021.textContent : null,
        };
      });
      check('history modal opens on the bar chart (5 bars, chart above the buttons, real size)',
        before.bars === 5 && before.labels.join(',') === '2021,2022,2024,2025,2026'
          && before.chartAboveButtons && before.canvasW > 0 && before.canvasH >= 150,
        JSON.stringify(before));
      check('the chart stacks Land + Building for split years and a single Total bar for the total-only year, all in one stack',
        JSON.stringify(before.land) === JSON.stringify([0, 1306000, 1504000, 1557000, 1503000])
          && JSON.stringify(before.building) === JSON.stringify([0, 424000, 451000, 445000, 428000])
          && JSON.stringify(before.total) === JSON.stringify([1600000, 0, 0, 0, 0])
          && before.stacks.every((s) => s === 'assessed'),
        JSON.stringify({ land: before.land, building: before.building, total: before.total, stacks: before.stacks }));
      check('the legend names Land / Building / Total while both kinds of years exist',
        before.legendTexts.includes('Land') && before.legendTexts.includes('Building')
          && before.legendTexts.includes('Total'),
        JSON.stringify(before.legendTexts));
      check('tooltips: a split year breaks down Land / Building / Total; a total-only year shows Total only',
        before.tipSplit.includes('Land') && before.tipSplit.includes('1,306,000')
          && before.tipSplit.includes('Building') && before.tipSplit.includes('424,000')
          && before.tipSplit.includes('Total') && before.tipSplit.includes('1,730,000')
          && before.tipTotalOnly.includes('Total') && before.tipTotalOnly.includes('1,600,000')
          && !before.tipTotalOnly.includes('Land'),
        JSON.stringify({ split: before.tipSplit, totalOnly: before.tipTotalOnly }));
      check('the history table gains Land / Building columns (the total-only year shows —)',
        before.headCells.includes('Land') && before.headCells.includes('Building')
          && !!before.row2021 && before.row2021.includes('—'),
        JSON.stringify({ head: before.headCells, row2021: before.row2021 }));
      check('history modal carries no BCA source line and no HouseSigma status line',
        !before.text.includes('Source: BC Assessment') && !before.text.includes('HouseSigma history:')
          && before.metaGone,
        before.text.slice(0, 200));

      // Pull: the missing year comes back and the chart grows.
      await page.evaluate(() => document.querySelector('#pullHistoryBtn').click());
      const grown = await until(() => {
        const c = window.__fmCharts.history;
        return c && c.data.datasets[0].data.length === 6 ? true : null;
      });
      check('in-modal HouseSigma pull grows the chart to 6 bars', !!grown);
      const after = await page.evaluate(() => {
        const c = window.__fmCharts.history;
        const i = c.data.labels.indexOf('2023');
        const land = c.data.datasets.find((ds) => ds.key === 'land');
        const building = c.data.datasets.find((ds) => ds.key === 'building');
        const cb = c.options.plugins.tooltip.callbacks.label;
        const tip = cb({
          dataIndex: i, datasetIndex: c.data.datasets.indexOf(land), dataset: land,
          parsed: { y: land.data[i] },
        });
        return {
          land2023: land.data[i],
          building2023: building.data[i],
          src2023: land.pointMeta[i].source,
          tip: Array.isArray(tip) ? tip.join(' | ') : String(tip),
          msg: document.querySelector('#historyMsg').textContent,
        };
      });
      check('the pulled 2023 year stacks as a HouseSigma split (Land 1,456,000 + Building 447,000 = 1,903,000 in its tooltip)',
        after.land2023 === 1456000 && after.building2023 === 447000 && after.src2023 === 'housesigma'
          && after.tip.includes('HouseSigma') && after.tip.includes('1,903,000')
          && after.tip.includes('Land') && after.tip.includes('Building'),
        JSON.stringify(after));
      check('a successful pull writes no status sentence (the chart is the report)',
        !after.msg.includes('Pulled from HouseSigma') && !after.msg.includes('up to date'),
        after.msg);

      // BCA outage: the Fetch button still reports a short error.
      stubBcaDown = true;
      await page.evaluate(() => document.querySelector('#fetchBcaBtn').click());
      const errShown = await until(() =>
        document.querySelector('#historyMsg').textContent.includes('BC Assessment fetch failed') ? true : null);
      stubBcaDown = false;
      check('BCA outage in the modal shows the short fetch error (functional status kept)', !!errShown);
    } catch (err) {
      check('history modal browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserH.close();
    }
  }

  // ---------------------------------------------------------------
  // Chart colors: per-user preferences in the DB. API level first:
  // validation, round-trip, and isolation between users.
  r = await req('GET', '/api/preferences');
  check('preferences start empty for the admin user',
    r.status === 200 && !('chart_colors' in (r.data.preferences || {})), JSON.stringify(r.data));
  r = await req('PUT', '/api/preferences/chart_colors', { value: { hero: { assessed: '#123456' } } });
  check('storing a chart color succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await req('GET', '/api/preferences');
  check('the stored color reads back',
    !!r.data.preferences && !!r.data.preferences.chart_colors
      && r.data.preferences.chart_colors.hero.assessed === '#123456',
    JSON.stringify(r.data.preferences));
  for (const bad of ['#12345', 'red', '#1234567', 42]) {
    r = await req('PUT', '/api/preferences/chart_colors', { value: { hero: { assessed: bad } } });
    check(`an invalid color is a 400 (${JSON.stringify(bad)})`, r.status === 400, JSON.stringify(r.data));
  }
  r = await req('PUT', '/api/preferences/chart_colors', { value: ['#123456'] });
  check('a non-object chart_colors value is a 400', r.status === 400, JSON.stringify(r.data));
  r = await req('PUT', '/api/preferences/bogus_key', { value: {} });
  check('an unknown preference key is a 400', r.status === 400, JSON.stringify(r.data));
  const loginAs = async (username, password) => {
    const res = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const shawnCookie = await loginAs('Shawn', 'Shawn');
  const prefsOf = async (ck) => (await (await fetch(BASE + '/api/preferences', { headers: { Cookie: ck } })).json()).preferences || {};
  check('another user sees none of the admin\u2019s chart colors (isolation)',
    !('chart_colors' in (await prefsOf(shawnCookie))), JSON.stringify(await prefsOf(shawnCookie)));
  await fetch(BASE + '/api/preferences/chart_colors', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: shawnCookie },
    body: JSON.stringify({ value: { hero: { assessed: '#abcdef' } } }),
  });
  check('the second user stores his own color without touching the admin\u2019s',
    (await prefsOf(shawnCookie)).chart_colors.hero.assessed === '#abcdef'
      && (await req('GET', '/api/preferences')).data.preferences.chart_colors.hero.assessed === '#123456');
  // Clear both users' colors: the browser flow below starts from
  // defaults on both accounts.
  await req('PUT', '/api/preferences/chart_colors', { value: {} });
  await fetch(BASE + '/api/preferences/chart_colors', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: shawnCookie },
    body: JSON.stringify({ value: {} }),
  });

  // Chart colors in the browser: recolor the hero chart and the
  // history chart live, see the colors survive a reload (DB), and
  // Reset returns to the defaults; the second user sees defaults.
  if (!puppeteer || !fs.existsSync('/opt/meta-chromium/chrome')) {
    console.log('chart colors browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    r = await req('POST', '/api/properties', {
      address: '31 Colors Crescent, Victoria, BC',
      mortgage_balance: 1350000, mortgage_balance_date: '2025-12-01', purchase_date: '2025-06-01', amortization_years: 30,
    });
    const colorPid = r.data.id;
    await req('POST', `/api/properties/${colorPid}/rates`, {
      start_date: '2025-12-01', rate_type: 'fixed', annual_rate: 5,
    });
    await req('POST', `/api/properties/${colorPid}/value-history`, { year: 2025, land_value: 900000, building_value: 300000 });
    await req('POST', `/api/properties/${colorPid}/value-history`, { year: 2024, value: 1100000 });

    const forwardC = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: PORT, path: rq.url, method: rq.method, headers: rq.headers },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        }
      );
      rr.on('error', reject);
      if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
      rr.end();
    });
    const adminCookieC = await loginAs('admin', 'admin');
    const browserC = await puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserC.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardC({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      const setSession = async (ck) => {
        const [name, value] = ck.split('=');
        await client.send('Network.setCookie', { name, value, domain: 'ff.local', path: '/', httpOnly: true });
      };
      await setSession(adminCookieC);
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const pollEq = async (get, want, tries = 48) => {
        for (let i = 0; i < tries; i++) {
          try { if ((await get()) === want) return true; } catch {}
          await wait(250);
        }
        return false;
      };
      const heroColor = (key) => page.evaluate((k) => {
        const c = window.__fmCharts.a;
        const ds = c && c.data.datasets.find((d) => d.key === k);
        return ds ? ds.borderColor : null;
      }, key);
      const setColor = (panelId, key, hex) => page.evaluate((p, k, h) => {
        const input = document.querySelector(`[data-colors-panel="${p}"] [data-color-input="${k}"]`);
        input.value = h;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, panelId, key, hex);

      await page.goto(`http://ff.local/#property/${colorPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      check('hero chart starts on the default assessed color',
        await pollEq(() => heroColor('assessed'), '#2e7d4f'));
      await page.evaluate(() => document.querySelector('[data-colors-toggle="hero"]').click());
      await wait(300);
      const heroPanel = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="hero"]');
        return {
          shown: !panel.classList.contains('hidden'),
          rows: [...panel.querySelectorAll('[data-color-input]')].map((i) => i.dataset.colorInput),
          hasReset: !!panel.querySelector('[data-colors-reset]'),
        };
      });
      check('the hero Colors panel lists one picker per series plus a Reset',
        heroPanel.shown && heroPanel.hasReset
          && ['assessed', 'outstanding', 'interest', 'principal'].every((k) => heroPanel.rows.includes(k)),
        JSON.stringify(heroPanel));
      await setColor('hero', 'assessed', '#123456');
      check('recoloring applies to the live chart at once',
        (await heroColor('assessed')) === '#123456', await heroColor('assessed'));
      let stored = null;
      for (let i = 0; i < 30; i++) {
        const p = (await req('GET', '/api/preferences')).data.preferences;
        if (p && p.chart_colors && p.chart_colors.hero && p.chart_colors.hero.assessed === '#123456') { stored = p; break; }
        await wait(300);
      }
      check('the new color is stored in the user\u2019s preferences', !!stored, JSON.stringify(stored));
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      check('after a reload the hero chart still uses the stored color',
        await pollEq(() => heroColor('assessed'), '#123456'));

      // History chart: Land takes the custom hex (border whole,
      // fill at the series alpha), and it survives a modal
      // close / reopen (the chart rebuilds from the preference).
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(600);
      await page.evaluate(() => document.querySelector('[data-colors-toggle="history"]').click());
      await wait(300);
      await setColor('history', 'land', '#654321');
      const histLand = await page.evaluate(() => {
        const c = window.__fmCharts.history;
        const ds = c && c.data.datasets.find((d) => d.key === 'land');
        return ds ? { border: ds.borderColor, bg: ds.backgroundColor } : null;
      });
      check('the history Land series recolors live (border #654321, fill at its alpha)',
        !!histLand && histLand.border === '#654321' && histLand.bg === 'rgba(101, 67, 33, 0.8)',
        JSON.stringify(histLand));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(600);
      const histLand2 = await page.evaluate(() => {
        const c = window.__fmCharts.history;
        const ds = c && c.data.datasets.find((d) => d.key === 'land');
        return ds ? ds.borderColor : null;
      });
      check('reopening the history modal keeps the stored Land color', histLand2 === '#654321', String(histLand2));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);

      // Reset: the hero chart returns to defaults and the stored
      // hero entry is gone.
      await page.evaluate(() => document.querySelector('[data-colors-toggle="hero"]').click());
      await wait(300);
      await page.evaluate(() => document.querySelector('[data-colors-panel="hero"] [data-colors-reset]').click());
      await wait(600);
      check('Reset restores the default hero color on the live chart',
        (await heroColor('assessed')) === '#2e7d4f', await heroColor('assessed'));
      const prefsAfterReset = (await req('GET', '/api/preferences')).data.preferences;
      check('Reset removes the chart\u2019s stored colors',
        !!prefsAfterReset && !!prefsAfterReset.chart_colors && !('hero' in prefsAfterReset.chart_colors),
        JSON.stringify(prefsAfterReset));

      // Isolation in the browser: the second user (whose stored
      // colors were cleared above) sees the defaults even though
      // the admin has a stored history color.
      await setSession(shawnCookie);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      check('the second user sees the default hero color (per-user isolation)',
        await pollEq(() => heroColor('assessed'), '#2e7d4f'));

      // ---- Legend gestures ----
      // Left click toggles a series (Chart.js' default legend
      // behavior: the dataset hides and the item takes the hidden
      // style); right click opens that chart's Colors panel with
      // the clicked series' row highlighted and the browser
      // context menu suppressed. Visibility is view state only.
      const legendCenter = (chartKey, seriesKey) => page.evaluate((ck, sk) => {
        const c = window.__fmCharts[ck];
        if (!c || !c.legend) return null;
        const i = c.legend.legendItems.findIndex((it) => {
          const ds = c.data.datasets[it.datasetIndex];
          return ds && ds.key === sk;
        });
        if (i < 0) return null;
        // The portfolio chart sits below the fold of the list
        // page: bring the canvas into the viewport before
        // measuring, or the click lands outside it.
        c.canvas.scrollIntoView({ block: 'center' });
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 };
      }, chartKey, seriesKey);
      const legendPoint = async (chartKey, seriesKey) => {
        for (let i = 0; i < 25; i++) {
          const p = await legendCenter(chartKey, seriesKey);
          if (p) return p;
          await wait(250);
        }
        return null;
      };
      const legendState = (chartKey, seriesKey) => page.evaluate((ck, sk) => {
        const c = window.__fmCharts[ck];
        if (!c || !c.legend) return null;
        const it = c.legend.legendItems.find((x) => {
          const ds = c.data.datasets[x.datasetIndex];
          return ds && ds.key === sk;
        });
        if (!it) return null;
        return { visible: c.isDatasetVisible(it.datasetIndex), hidden: !!it.hidden };
      }, chartKey, seriesKey);
      const waitLegend = async (chartKey, seriesKey, want) => {
        for (let i = 0; i < 30; i++) {
          const s = await legendState(chartKey, seriesKey);
          if (s && s.visible === want.visible && s.hidden === want.hidden) return true;
          await wait(200);
        }
        return false;
      };
      // Hero: left-click Interest off and back on.
      const heroInterest = await legendPoint('a', 'interest');
      check('the hero legend exposes an Interest item to click', !!heroInterest, JSON.stringify(heroInterest));
      await page.mouse.click(heroInterest.x, heroInterest.y);
      check('left-clicking the Interest legend item hides the series (dataset hidden + legend item in the hidden style)',
        await waitLegend('a', 'interest', { visible: false, hidden: true }));
      const heroInterest2 = await legendPoint('a', 'interest');
      await page.mouse.click(heroInterest2.x, heroInterest2.y);
      check('clicking it again restores the series',
        await waitLegend('a', 'interest', { visible: true, hidden: false }));
      // Hero: right-click Principal opens the Colors panel on its row.
      const heroPrincipal = await legendPoint('a', 'principal');
      await page.mouse.click(heroPrincipal.x, heroPrincipal.y, { button: 'right' });
      await wait(400);
      const heroRc = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="hero"]');
        const input = panel.querySelector('[data-color-input="principal"]');
        const row = input ? input.closest('.cc-row') : null;
        return { shown: !panel.classList.contains('hidden'), highlighted: !!row && row.classList.contains('cc-highlight') };
      });
      check('right-clicking the Principal legend item opens the hero Colors panel with the Principal row highlighted',
        heroRc.shown && heroRc.highlighted, JSON.stringify(heroRc));
      const ctxPrevented = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const i = c.legend.legendItems.findIndex((it) => c.data.datasets[it.datasetIndex].key === 'assessed');
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + b.left + 2, clientY: r.top + b.top + 2 });
        c.canvas.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      check('a right click on a legend item suppresses the browser context menu', ctxPrevented === true);
      // Hero: Current equity toggles from the legend and recolors
      // from the panel like every other hero series.
      const heroEqPt = await legendPoint('a', 'equity');
      check('the hero legend exposes a Current equity item to click', !!heroEqPt, JSON.stringify(heroEqPt));
      await page.mouse.click(heroEqPt.x, heroEqPt.y);
      check('left-clicking the Current equity legend item hides the series',
        await waitLegend('a', 'equity', { visible: false, hidden: true }));
      const heroEqPt2 = await legendPoint('a', 'equity');
      await page.mouse.click(heroEqPt2.x, heroEqPt2.y);
      check('clicking Current equity again restores it',
        await waitLegend('a', 'equity', { visible: true, hidden: false }));
      await setColor('hero', 'equity', '#5b21b6');
      const heroEqColor = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.key === 'equity');
        return ds ? ds.borderColor : null;
      });
      check('recoloring Current equity applies live', heroEqColor === '#5b21b6', String(heroEqColor));
      // History: left-click Land off and back on; right-click
      // Building opens its panel on the Building row.
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(700);
      const lgHistLand = await legendPoint('history', 'land');
      await page.mouse.click(lgHistLand.x, lgHistLand.y);
      check('left-clicking the history Land legend item hides the Land series',
        await waitLegend('history', 'land', { visible: false, hidden: true }));
      const lgHistLand2 = await legendPoint('history', 'land');
      await page.mouse.click(lgHistLand2.x, lgHistLand2.y);
      check('clicking Land again restores it',
        await waitLegend('history', 'land', { visible: true, hidden: false }));
      const histBuilding = await legendPoint('history', 'building');
      await page.mouse.click(histBuilding.x, histBuilding.y, { button: 'right' });
      await wait(400);
      const histRc = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="history"]');
        const input = panel.querySelector('[data-color-input="building"]');
        const row = input ? input.closest('.cc-row') : null;
        return { shown: !panel.classList.contains('hidden'), highlighted: !!row && row.classList.contains('cc-highlight') };
      });
      check('right-clicking the history Building item opens the history Colors panel with Building highlighted',
        histRc.shown && histRc.highlighted, JSON.stringify(histRc));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);
      // Portfolio (properties list): left-click Outstanding off,
      // right-click Assessed opens the portfolio Colors panel.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      const pfOut = await legendPoint('portfolio', 'outstanding');
      check('the portfolio legend exposes an Outstanding item to click', !!pfOut, JSON.stringify(pfOut));
      await page.mouse.click(pfOut.x, pfOut.y);
      check('left-clicking the portfolio Outstanding item hides the series',
        await waitLegend('portfolio', 'outstanding', { visible: false, hidden: true }));
      const pfAssessed = await legendPoint('portfolio', 'assessed');
      await page.mouse.click(pfAssessed.x, pfAssessed.y, { button: 'right' });
      await wait(400);
      const pfRc = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="portfolio"]');
        const input = panel.querySelector('[data-color-input="assessed"]');
        const row = input ? input.closest('.cc-row') : null;
        return { shown: !panel.classList.contains('hidden'), highlighted: !!row && row.classList.contains('cc-highlight') };
      });
      check('right-clicking the portfolio Assessed item opens the portfolio Colors panel with Assessed highlighted',
        pfRc.shown && pfRc.highlighted, JSON.stringify(pfRc));
      // Recolor regression beside the gestures: the panel the
      // right click opened still recolors the live chart.
      await setColor('portfolio', 'assessed', '#0a5c2e');
      const pfRecolored = await page.evaluate(() => {
        const ds = window.__fmCharts.portfolio.data.datasets.find((d) => d.key === 'assessed');
        return ds ? ds.borderColor : null;
      });
      check('recoloring from the right-click-opened panel applies live', pfRecolored === '#0a5c2e', String(pfRecolored));
      // Total equity takes part like every other series: the
      // legend toggles it and the Colors panel recolors it.
      const pfEqPt = await legendPoint('portfolio', 'equity');
      check('the portfolio legend exposes a Total equity item to click', !!pfEqPt, JSON.stringify(pfEqPt));
      await page.mouse.click(pfEqPt.x, pfEqPt.y);
      check('left-clicking the portfolio Total equity item hides the series',
        await waitLegend('portfolio', 'equity', { visible: false, hidden: true }));
      const pfEqPt2 = await legendPoint('portfolio', 'equity');
      await page.mouse.click(pfEqPt2.x, pfEqPt2.y);
      check('clicking Total equity again restores it',
        await waitLegend('portfolio', 'equity', { visible: true, hidden: false }));
      await setColor('portfolio', 'equity', '#5b21b6');
      const pfEqColor = await page.evaluate(() => {
        const ds = window.__fmCharts.portfolio.data.datasets.find((d) => d.key === 'equity');
        return ds ? ds.borderColor : null;
      });
      check('recoloring Total equity applies live', pfEqColor === '#5b21b6', String(pfEqColor));
      await req('DELETE', `/api/properties/${colorPid}`);
    } catch (err) {
      check('chart colors browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserC.close();
    }
  }

  // ============ global loading veil ============
  // Hub loads run under a counting, delayed-show veil: a slow
  // refetch shows it and the redraw completes underneath; a fast
  // one never shows it at all; a failed one lifts it and leaves
  // the error visible in the global banner.
  {
    r = await req('POST', '/api/properties', { address: '321 Loading Test Lane, Victoria, BC', purchase_date: '2024-06-01', mortgage_balance: 400000 });
    const loadPid = r.data.id;
    await req('POST', `/api/properties/${loadPid}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 });
    await req('POST', `/api/properties/${loadPid}/value-history`, { year: 2026, value: 900000 });

    const http = await import('node:http');
    const forwardD = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: PORT, path: rq.url, method: rq.method, headers: rq.headers },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        }
      );
      rr.on('error', reject);
      if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
      rr.end();
    });
    const waitD = (ms) => new Promise((res) => setTimeout(res, ms));
    let pfGate = null; // null | 'hold'
    const held = [];
    const adminCookieD = await loginAs('admin', 'admin');
    const browserD = await puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserD.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          if (u.pathname === '/api/properties/portfolio' && pfGate === 'hold') { held.push(e); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardD({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      const releaseHeld = async (asError = false) => {
        const items = held.splice(0);
        for (const e of items) {
          if (asError) {
            await client.send('Fetch.fulfillRequest', {
              requestId: e.requestId, responseCode: 500,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
              body: Buffer.from(JSON.stringify({ error: 'portfolio stub failure' })).toString('base64'),
            });
          } else {
            const u = new URL(e.request.url);
            const headers = {};
            for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
            const resp = await forwardD({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
            const respHeaders = Object.entries(resp.headers)
              .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
              .map(([name, value]) => ({ name, value: String(value) }));
            await client.send('Fetch.fulfillRequest', {
              requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
              body: resp.body.toString('base64'),
            });
          }
        }
      };
      const [nameD, valueD] = adminCookieD.split('=');
      await client.send('Network.setCookie', { name: nameD, value: valueD, domain: 'ff.local', path: '/', httpOnly: true });
      await page.evaluateOnNewDocument(() => {
        window.__veilSeen = false;
        document.addEventListener('DOMContentLoaded', () => {
          const el = document.getElementById('globalLoading');
          if (!el) return;
          const check = () => { if (!el.classList.contains('hidden')) window.__veilSeen = true; };
          new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ['class'] });
          setInterval(check, 25);
        });
      });
      const loadState = () => page.evaluate(() => window.__fmLoading.state());
      const pollState = async (pred, tries = 40) => {
        for (let i = 0; i < tries; i++) {
          try { const s = await loadState(); if (pred(s)) return s; } catch {}
          await waitD(200);
        }
        return null;
      };

      // Fast path: a hub refetch that completes inside the 200ms
      // delay never shows the veil. (A full navigation of this
      // suite's 20+-property fixture legitimately takes longer —
      // the veil showing there is correct — so the fast case is
      // measured on a single gated refetch through the pf range
      // button's real loadPortfolio path, released after ~60ms.)
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      const navSettled = await pollState((s) => s.count === 0 && s.visible === false, 40);
      const navChart = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        return c ? c.data.datasets.map((d) => d.key) : null;
      });
      check('the properties view settles with the counter at 0 and the chart drawn',
        !!navSettled && !!navChart && navChart.includes('equity'),
        JSON.stringify({ navSettled, navChart }));
      pfGate = 'hold';
      await page.evaluate(() => { window.__veilSeen = false; });
      await page.evaluate(() => document.querySelector('#pfRangeBtns button[data-months="12"]').click());
      await waitD(60);
      const heldN = held.length;
      await releaseHeld(false);
      pfGate = null;
      const fastSettled = await pollState((s) => s.count === 0, 40);
      const fastSeen = await page.evaluate(() => window.__veilSeen);
      check('a refetch completing inside the delay never shows the veil (anti-flash)',
        heldN >= 1 && !!fastSettled && fastSeen === false,
        JSON.stringify({ heldN, fastSettled, fastSeen }));

      // Slow path: hold the portfolio response — the veil
      // appears, the redraw completes once it is released, and
      // the veil lifts.
      pfGate = 'hold';
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      const slowShown = await pollState((s) => s.visible === true, 25);
      check('a slow refetch shows the global loading veil while the request is held',
        !!slowShown && slowShown.count >= 1, JSON.stringify(slowShown));
      await releaseHeld(false);
      pfGate = null;
      const slowDone = await pollState((s) => s.count === 0 && s.visible === false, 40);
      const slowChart = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        return c ? c.data.datasets.map((d) => d.key) : null;
      });
      check('releasing the response completes the redraw under the veil, then the veil lifts',
        !!slowDone && !!slowChart && slowChart.includes('equity'),
        JSON.stringify({ slowDone, slowChart }));

      // Error path: hold, let the veil show, then fail the
      // response — the veil lifts and the error is visible.
      pfGate = 'hold';
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      const errShown = await pollState((s) => s.visible === true, 25);
      check('the veil is up before the failing response lands', !!errShown, JSON.stringify(errShown));
      await releaseHeld(true);
      pfGate = null;
      const errState = await pollState((s) => s.count === 0 && s.visible === false, 40);
      let errBanner = null;
      for (let i = 0; i < 30 && !errBanner; i++) {
        errBanner = await page.evaluate(() => {
          const b = document.getElementById('globalError');
          return b && !b.classList.contains('hidden') && b.textContent.includes('portfolio stub failure')
            ? b.textContent : null;
        });
        if (!errBanner) await waitD(200);
      }
      check('a failed refetch lifts the veil and leaves the error visible in the global banner',
        !!errState && !!errBanner, JSON.stringify({ errState, errBanner }));
    } catch (err) {
      check('global loading veil browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserD.close();
    }
    await req('DELETE', `/api/properties/${loadPid}`);
  }

  r = await req('POST', '/api/logout');
  check('logout', r.status === 200);
  cookie = cookie; // cookie cleared server-side via Max-Age=0 header captured above
  r = await req('GET', '/api/summary');
  check('after logout /api/summary is 401', r.status === 401);
} finally {
  server.kill('SIGTERM');
  stub.close();
  primeStub.close();
  hsStub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'E2E: ALL PASS' : `E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
