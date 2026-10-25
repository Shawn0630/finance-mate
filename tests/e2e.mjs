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
  `);
  const ts = new Date().toISOString();
  const insP = legacy.prepare('INSERT INTO properties (address, mortgage_balance, owner, created_at, updated_at) VALUES (?, 0, ?, ?, ?)');
  insP.run('1 Legacy Lane', 'Shawn', ts, ts);
  insP.run('2 Legacy Lane', 'Joint', ts, ts);
  insP.run('3 Legacy Lane', null, ts, ts);
  legacy.prepare('INSERT INTO other_assets (category, name, value, currency, owner, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run('other', 'Legacy thing', 'CAD', 'Jiaying', ts, ts);
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
const stubHits = { search: 0, info: [] };
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>ok</html>'); return;
  }
  if (u.pathname === '/Property/Search/GetByAddress') {
    stubHits.search++;
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

const server = spawn('node', ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), BCA_BASE_URL: stubBase },
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

  r = await req('POST', '/api/logout');
  check('logout', r.status === 200);
  cookie = cookie; // cookie cleared server-side via Max-Age=0 header captured above
  r = await req('GET', '/api/summary');
  check('after logout /api/summary is 401', r.status === 401);
} finally {
  server.kill('SIGTERM');
  stub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'E2E: ALL PASS' : `E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
