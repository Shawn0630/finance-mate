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

const PORT = 19200 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-'));
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

  // Seeded household users (idempotent seeds in db.js).
  r = await req('GET', '/api/users');
  check('users list has admin, Shawn, Jiaying',
    ['admin', 'Shawn', 'Jiaying'].every((u) => (r.data || []).includes(u)), JSON.stringify(r.data));
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
  r = await req('POST', '/api/properties', { address: '1200 Government St, Victoria', bca_id: 'QkxPQy0xMjAw', mortgage_balance: 500000 });
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

  // Owner rules: properties may be Joint or any user; other assets may
  // be a user but never Joint.
  r = await req('POST', '/api/properties', { address: '1 Owner Way', owner: 'Joint', mortgage_balance: 100000 });
  check('property can have Joint owner', r.status === 201 && r.data.owner === 'Joint');
  const pidOwn = r.data.id;
  r = await req('PUT', `/api/properties/${pidOwn}`, { owner: 'Shawn' });
  check('property owner can be a user', r.status === 200 && r.data.owner === 'Shawn');
  r = await req('POST', '/api/properties', { address: '2 Owner Way', owner: 'Nobody', mortgage_balance: 100000 });
  check('property with unknown owner rejected', r.status === 400);
  r = await req('POST', '/api/assets', { category: 'other', name: 'Joint test', owner: 'Joint' });
  check('other asset with Joint owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await req('POST', '/api/assets', { category: 'other', name: 'Owned thing', owner: 'Jiaying' });
  check('other asset can have a user owner', r.status === 201 && r.data.owner === 'Jiaying');
  const aidOwn = r.data.id;
  r = await req('PUT', `/api/assets/${aidOwn}`, { owner: 'Joint' });
  check('other asset owner cannot be changed to Joint', r.status === 400);
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

  // Slim add: only address + owner + outstanding balance. The balance
  // date defaults to today (current-balance semantics); payment and
  // amortization stay empty for the detail page to fill in, and with no
  // rate plan yet the projection is the NO_RATE_PLAN prompt state.
  r = await req('POST', '/api/properties', { address: '7 Slim Lane, Victoria, BC', owner: 'Shawn' });
  check('add without balance rejected', r.status === 400 && String(r.data.error || '').includes('balance'), JSON.stringify(r.data));
  r = await req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owner: 'Shawn', mortgage_balance: 123456,
  });
  const today = new Date().toISOString().slice(0, 10);
  check('slim add (3 fields) creates the property', r.status === 201 && r.data.mortgage_balance === 123456, JSON.stringify(r.data).slice(0, 160));
  check('balance date defaults to today', r.data.mortgage_balance_date === today, String(r.data.mortgage_balance_date));
  check('payment/amortization left empty at add', (r.data.mortgage_payment ?? null) === null && (r.data.amortization_years ?? null) === null);
  const pidSlim = r.data.id;
  r = await req('GET', `/api/properties/${pidSlim}/amortization`);
  check('slim-added property sits in NO_RATE_PLAN state', r.data.ok === false && r.data.code === 'NO_RATE_PLAN');
  r = await req('DELETE', `/api/properties/${pidSlim}`);
  check('delete slim property', r.status === 200);

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
