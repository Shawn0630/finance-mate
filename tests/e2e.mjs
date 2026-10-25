// HTTP end-to-end test against a throwaway database.
//   node tests/e2e.mjs
// Spawns the server with a temp DATA_DIR, then checks: unauthenticated 401,
// admin/admin login, property CRUD, rate segment CRUD, amortization numbers
// (same hand-computed fixture as the engine tests), other-asset CRUD, the
// summary arithmetic, and 401 again after logout.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

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
// can move, so the refresh flow is exercised end to end.
let stubPrime = 4.95;
let stubDown = false;
const primeStub = http.createServer((req, res) => {
  if (stubDown) { res.writeHead(500); res.end('down'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    seriesDetail: { V80691311: { label: 'Prime rate' } },
    observations: [
      { d: '2026-10-21', V80691311: { v: String(stubPrime) } },
      { d: '2026-10-14', V80691311: { v: '4.70' } },
    ],
  }));
});
await new Promise((r) => primeStub.listen(0, '127.0.0.1', r));
const primeStubBase = `http://127.0.0.1:${primeStub.address().port}/valet`;

const server = spawn('node', ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), BCA_BASE_URL: stubBase, PRIME_API_URL: primeStubBase },
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
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', mortgage_payment: 600,
    purchase_date: '2020-03-15',
  });
  check('create property', r.status === 201 && r.data.id > 0);
  const pid = r.data.id;

  r = await req('POST', `/api/properties/${pid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  check('add rate segment', r.status === 201);
  const segId = r.data.id;
  r = await req('PUT', `/api/properties/${pid}/rates/${segId}`, { annual_rate: 5.0 });
  check('edit rate segment', r.status === 200 && r.data.annual_rate === 5);

  // Amortization must match the engine / hand calculation:
  // month 1 interest $412.39, balance $99,812.39 (see tests/engine.test.mjs).
  r = await req('GET', `/api/properties/${pid}/amortization`);
  const s0 = r.data.series && r.data.series[0];
  check('amortization ok', r.data.ok === true && !!s0);
  check('month 1 interest = 412.39', s0 && Math.abs(s0.interest - 412.39) <= 0.02, s0 && String(s0.interest));
  check('month 1 balance = 99812.39', s0 && Math.abs(s0.balance - 99812.39) <= 0.02, s0 && String(s0.balance));
  check('payment source is entered', r.data.paymentSource === 'entered' && r.data.paymentUsed === 600);

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

  // Rate-plan chain: a property with balance + payment but NO rate
  // segments gets no projection at all (never a hidden default rate);
  // adding a segment produces numbers that follow that segment, and
  // editing the segment's rate changes the numbers.
  r = await req('POST', '/api/properties', {
    address: '9 Rateplan Road, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', mortgage_payment: 600,
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
  r = await req('POST', '/api/properties', { address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'] });
  check('add without balance rejected', r.status === 400 && String(r.data.error || '').includes('principal'), JSON.stringify(r.data));
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
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-24', mortgage_payment: 600,
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
  // drives the projection. Same loan as the engine anchors ($100,000
  // at 5%, $600 monthly payment from 2026-10-01): monthly totals are
  // the baseline; accelerated bi-weekly must pay off in 2047-01 with
  // total interest 58641.44 (cross-checked in the engine tests).
  r = await req('POST', '/api/properties', {
    address: '3 Frequency Court, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', mortgage_payment: 600,
    purchase_date: '2019-06-15',
  });
  const pidFreq = r.data.id;
  await req('POST', `/api/properties/${pidFreq}/rates`, {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  r = await req('GET', `/api/properties/${pidFreq}/amortization`);
  check('default frequency is monthly with the baseline totals',
    r.data.frequency === 'monthly' && Math.abs(r.data.totalInterest - 69494.74) <= 0.02,
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
  check('accelerated bi-weekly: $300 per period, less interest, earlier payoff',
    r.data.frequency === 'accelerated_bi_weekly' && r.data.periodPayment === 300
      && Math.abs(r.data.totalInterest - 58641.44) <= 0.02
      && r.data.totalInterest < monthlyTotal && r.data.payoffMonth === '2047-01'
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
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', mortgage_payment: 600,
    purchase_date: '2019-11-05',
  });
  const pidPA = r.data.id;
  await req('POST', `/api/properties/${pidPA}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  r = await req('POST', '/api/properties', {
    address: '22 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 50000, mortgage_balance_date: '2026-10-01', mortgage_payment: 500,
    purchase_date: '2020-05-20',
  });
  const pidPB = r.data.id;
  await req('POST', `/api/properties/${pidPB}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 3 });
  const amortA = (await req('GET', `/api/properties/${pidPA}/amortization`)).data;
  const amortB = (await req('GET', `/api/properties/${pidPB}/amortization`)).data;
  check('portfolio fixtures project individually (A matches the 69494.74 anchor)',
    amortA.ok && amortB.ok && Math.abs(amortA.totalInterest - 69494.74) <= 0.02,
    JSON.stringify({ a: amortA.totalInterest, b: amortB.totalInterest }));
  const port = (await req('GET', '/api/properties/portfolio')).data;
  check('portfolio totals = baseline + both properties',
    Math.abs(port.totals.outstanding - (portBefore.totals.outstanding + 150000)) <= 0.02
      && Math.abs(port.totals.monthlyPayment - (portBefore.totals.monthlyPayment + 1100)) <= 0.02
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
    mortgage_balance: 20000, mortgage_balance_date: '2027-03-15', mortgage_payment: 300,
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

  // ------------------------------------------------------------ prime ---
  r = await req('GET', '/api/prime');
  check('fetch-on-read stored the stub prime with its as-of date',
    r.data.current && r.data.current.rate === 4.95 && r.data.current.date === '2026-10-21'
      && r.data.source && r.data.source.series === 'V80691311', JSON.stringify(r.data.current));
  check('prime change points include the previous level',
    Array.isArray(r.data.changes) && r.data.changes.length === 2 && r.data.changes[1].rate === 4.7,
    JSON.stringify(r.data.changes));

  r = await req('GET', '/api/properties/1');
  check('legacy variable segment migrated as absolute, value intact',
    r.data.segments.length === 1 && r.data.segments[0].rate_mode === 'absolute'
      && r.data.segments[0].effective_rate === 5, JSON.stringify(r.data.segments));

  r = await req('POST', '/api/properties', {
    address: '7 Prime Place, Victoria, BC', mortgage_balance: 100000,
    mortgage_balance_date: '2026-10-01', mortgage_payment: 600, purchase_date: '2020-01-01',
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

  r = await req('POST', '/api/properties', { address: '1 Region Road', mortgage_balance: 1000, purchase_date: '2020-01-01', region: 'US' });
  check('a non-CA region is refused (Canada only for now)', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', '/api/properties', { address: '2 Region Road', mortgage_balance: 1000, purchase_date: '2020-01-01', region: 'CA' });
  check('region CA is accepted and stored', r.status === 201 && r.data.region === 'CA', JSON.stringify(r.data.region));
  await req('DELETE', `/api/properties/${r.data.id}`);
  await req('DELETE', `/api/properties/${pidPrime}`);

  // ---- Money inputs: grouped on screen, plain numbers on the wire ----
  // Every money field is a text input marked data-money; the shared
  // format/parse pair in app.js groups what the user sees and parses it
  // back before anything is sent, so the API still receives numbers.
  check('money inputs are marked data-money in the page',
    (pageHtml.match(/data-money/g) || []).length >= 6,
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

      // Add a property typing a bare number: it must group live, and
      // the server must store the plain number.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate(() => document.querySelector('#addPropertyBtn').click());
      await wait(500);
      await focusField('#addPropForm .address-input');
      await page.keyboard.type('999 Money Test Terrace, Victoria, BC');
      await focusField('#addPropForm [name=mortgage_balance]');
      await page.keyboard.type('1350000');
      const typedBalance = await fieldVal('#addPropForm [name=mortgage_balance]');
      check('add-property balance groups while typing (1350000 -> 1,350,000)', typedBalance === '1,350,000', String(typedBalance));
      await page.evaluate(() => {
        const d = document.querySelector('#addPropForm [name=purchase_date]');
        d.value = '2024-12-17';
        d.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('#addPropForm [type=submit]').click());
      await wait(2500);
      r = await req('GET', '/api/properties');
      const moneyProp = (r.data || []).find((p) => p.address.includes('Money Test Terrace'));
      check('typed grouped balance stored as the plain number 1350000',
        !!moneyProp && moneyProp.mortgage_balance === 1350000, JSON.stringify(moneyProp && moneyProp.mortgage_balance));
      const moneyPid = moneyProp.id;

      // Reopening the record: the mortgage form shows the grouped figure.
      await page.goto(`http://ff.local/#property/${moneyPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const editBalance = await fieldVal('#mortgageForm [name=mortgage_balance]');
      check('edit form opens with the grouped balance', editBalance === '1,350,000', String(editBalance));

      // Paste a pre-grouped figure into monthly payment and save: it
      // must reach the server as the plain number 2500.
      await focusField('#mortgageForm [name=mortgage_payment]');
      await client.send('Input.insertText', { text: '2,500' });
      const pastedPayment = await fieldVal('#mortgageForm [name=mortgage_payment]');
      check('pasted grouped payment displays grouped', pastedPayment === '2,500', String(pastedPayment));
      await page.evaluate(() => document.querySelector('#mortgageForm [type=submit]').click());
      await wait(1400);
      r = await req('GET', `/api/properties/${moneyPid}`);
      check('pasted payment stored as the plain number 2500', r.data.mortgage_payment === 2500, JSON.stringify(r.data.mortgage_payment));

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

      // And a pasted pre-grouped balance on the add-property form is
      // stored as the plain number.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate(() => document.querySelector('#addPropertyBtn').click());
      await wait(500);
      await focusField('#addPropForm .address-input');
      await page.keyboard.type('998 Money Test Terrace, Victoria, BC');
      await focusField('#addPropForm [name=mortgage_balance]');
      await client.send('Input.insertText', { text: '1,350,000' });
      await page.evaluate(() => {
        const d = document.querySelector('#addPropForm [name=purchase_date]');
        d.value = '2024-12-17';
        d.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('#addPropForm [type=submit]').click());
      await wait(2500);
      r = await req('GET', '/api/properties');
      const pastedProp = (r.data || []).find((p) => p.address.includes('998 Money Test Terrace'));
      check('pasted grouped balance stored as the plain number 1350000',
        !!pastedProp && pastedProp.mortgage_balance === 1350000, JSON.stringify(pastedProp && pastedProp.mortgage_balance));

      // Assessed-history window: the range is a LOOK-BACK window
      // ending today. A property with 8 years on record (2019-2026)
      // draws the 5 that fall in the default 5-year look-back
      // (2022-2026); All widens it to every year, and the trend
      // summary is calculated over the same window the chart shows.
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
      check('trend summary is calculated over the displayed 5-year window',
        sumDefault.includes('Change 2022 → 2026') && sumDefault.includes('fall in the selected chart range'), sumDefault);
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

      // Axis bounds: for a month range the x axis IS the look-back
      // window — exactly the selected span, ending today — never the
      // chart library's auto-fit (which unioned the history with the
      // projection and rounded outward into decades of empty span)
      // and never the old forward-from-the-data anchor either.
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
      const td0 = await todayDec();
      check('chart A axis with history only is the 5-year look-back ending today',
        !!ax && Math.abs(ax.max - td0) < 0.02 && Math.abs(ax.min - (td0 - 5)) < 0.05,
        JSON.stringify(ax && { min: ax.min, max: ax.max }));

      // Give the fixture a rate plan + payment on a known balance
      // date, reload, and the axis must follow each selected range:
      // every month range is that look-back ending today (projection
      // clipped at today); All -> the exact data extent, no padded
      // decades either side.
      await req('PUT', `/api/properties/${winPid}`, { mortgage_balance_date: '2025-01-15', mortgage_payment: 3000 });
      await req('POST', `/api/properties/${winPid}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      ax = await axisA();
      const td1 = await todayDec();
      check('chart A 5-year axis is the look-back ending today, with month ticks',
        !!ax && Math.abs(ax.max - td1) < 0.02 && Math.abs(ax.min - (td1 - 5)) < 0.05
          && ax.ticks.some((t) => /[A-Z][a-z]{2} \d{4}/.test(t)),
        JSON.stringify(ax && { min: ax.min, max: ax.max, ticks: ax.ticks }));
      const outXs = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Outstanding principal');
        return ds ? ds.data.map((p) => p.x) : null;
      });
      check('chart A projection is clipped to the window (in-window months drawn, nothing past today)',
        Array.isArray(outXs) && outXs.length > 12
          && outXs.every((x) => x <= td1 + 0.001) && outXs.some((x) => x > td1 - 0.1),
        JSON.stringify(outXs && { n: outXs.length, last: outXs[outXs.length - 1] }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(600);
      ax = await axisA();
      const td2 = await todayDec();
      check('chart A 2-year axis spans exactly the 2 years ending today, with monthly ticks',
        !!ax && Math.abs(ax.max - td2) < 0.02 && Math.abs(ax.max - ax.min - 2) < 0.02 && ax.ticks.length >= 20,
        JSON.stringify(ax && { min: ax.min, max: ax.max, nTicks: ax.ticks.length }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(600);
      ax = await axisA();
      const td3 = await todayDec();
      const yrs1 = await assessedYears();
      check('chart A 1-year axis spans the year ending today and shows only the 2026 point',
        !!ax && Math.abs(ax.max - td3) < 0.02 && Math.abs(ax.max - ax.min - 1) < 0.02
          && JSON.stringify(yrs1) === JSON.stringify([2026]),
        JSON.stringify({ ax: ax && { min: ax.min, max: ax.max }, yrs1 }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      ax = await axisA();
      check('chart A All axis is the exact data extent (2019 to the last projected month)',
        !!ax && ax.min === 2019 && ax.max === ax.dataMax && ax.max < 2060,
        JSON.stringify(ax && { min: ax.min, max: ax.max, dataMax: ax.dataMax }));

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
    } catch (err) {
      // A UI hiccup must surface as failed checks, not crash the suite.
      check('money UI browser flow runs to completion', false, String((err && err.message) || err));
    }
    } finally {
      await browser.close();
    }
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
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'E2E: ALL PASS' : `E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
