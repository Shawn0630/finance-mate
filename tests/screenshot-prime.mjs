// Screenshot for prime-based variable pricing: the Rate segments
// panel on a property whose variable segment is priced Prime - 1,
// with the Bank of Canada prime banner (value + as-of date +
// assumption line + recent changes) and the add-segment form set to
// Prime + spread so the live preview shows. The app server must be
// running with PRIME_API_URL pointing at tests/prime-stub.mjs.
// Same CDP Fetch bridge as tests/screenshot.mjs.
//   node tests/screenshot-prime.mjs     (server on :9200)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch { puppeteer = require('/tmp/pptr/node_modules/puppeteer-core'); }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.FF_PORT || 9200);
const OUT = path.resolve(import.meta.dirname, '.work-shot');
fs.mkdirSync(OUT, { recursive: true });

function forward(req) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      }
    );
    r.on('error', reject);
    if (req.postData) r.write(Buffer.from(req.postData, 'base64'));
    r.end();
  });
}

async function attachBridge(page) {
  const client = await page.target().createCDPSession();
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  client.on('Fetch.requestPaused', async (e) => {
    try {
      const u = new URL(e.request.url);
      if (u.hostname !== 'ff.local') {
        await client.send('Fetch.continueRequest', { requestId: e.requestId });
        return;
      }
      const headers = {};
      for (const [k, v] of Object.entries(e.request.headers)) {
        if (k.toLowerCase() !== 'host') headers[k] = v;
      }
      const resp = await forward({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
      const respHeaders = Object.entries(resp.headers)
        .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
        .map(([name, value]) => ({ name, value: String(value) }));
      await client.send('Fetch.fulfillRequest', {
        requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
        body: resp.body.toString('base64'),
      });
    } catch (err) {
      try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
    }
  });
  return client;
}

const apiHeaders = { 'Content-Type': 'application/json' };
const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
  method: 'POST', headers: apiHeaders,
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
apiHeaders.Cookie = `ff_session=${cookieValue}`;

// One property on a prime-priced variable plan (Prime - 1).
const propRes = await fetch(`http://127.0.0.1:${PORT}/api/properties`, {
  method: 'POST', headers: apiHeaders,
  body: JSON.stringify({
    address: '88 Prime Crescent, Victoria, BC',
    mortgage_balance: 640000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2022-05-01', owners: ['Shawn', 'Jiaying'],
  }),
});
const prop = await propRes.json();
await fetch(`http://127.0.0.1:${PORT}/api/properties/${prop.id}/rates`, {
  method: 'POST', headers: apiHeaders,
  body: JSON.stringify({ start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }),
});

const browser = await puppeteer.launch({
  executablePath: '/opt/meta-chromium/chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1360,1150'],
  defaultViewport: { width: 1360, height: 1150 },
});
const page = await browser.newPage();
const client = await attachBridge(page);
await client.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`http://ff.local/#property/${prop.id}`, { waitUntil: 'networkidle0', timeout: 30000 });
await wait(1200);
// Set the add-segment form to Variable / Prime + spread / -1 so the
// live preview line renders for the screenshot.
await page.evaluate(() => {
  const form = document.querySelector('#addSegmentForm');
  form.rate_type.value = 'variable';
  form.rate_type.dispatchEvent(new Event('change', { bubbles: true }));
  form.rate_mode.value = 'prime_spread';
  form.rate_mode.dispatchEvent(new Event('change', { bubbles: true }));
  form.spread.value = '-1';
  form.spread.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#primeBanner').closest('.panel').scrollIntoView({ block: 'start' });
});
await wait(400);
const state = await page.evaluate(() => ({
  banner: document.querySelector('#primeBanner').textContent,
  changes: document.querySelector('#primeChanges').textContent,
  segRow: document.querySelector('#segmentRows').textContent.replace(/\s+/g, ' ').trim(),
  preview: document.querySelector('#segSpreadPreview').textContent,
}));
console.log('prime state:', JSON.stringify(state));
const panel = await page.evaluateHandle(() => document.querySelector('#primeBanner').closest('.panel'));
await panel.asElement().screenshot({ path: path.join(OUT, 'prime-plan.png') });
console.log('prime-plan.png', fs.statSync(path.join(OUT, 'prime-plan.png')).size);

// Warning toggle: stub /api/prime to a stale response and confirm
// the amber warning appears with the fallback copy; restore and
// confirm it disappears when the value is fresh again.
const warnState = await page.evaluate(async () => {
  const origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (String(url).includes('/api/prime') && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(new Response(JSON.stringify({
        current: { date: '2026-10-21', rate: 4.45 }, fresh: false, asOf: '2026-10-23',
        changes: [], lastFetchedAt: null,
        source: { name: 'Bank of Canada Valet', series: 'V80691311', label: 'Bank of Canada prime rate' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return origFetch(url, opts);
  };
  await loadPrime();
  const w = document.querySelector('#primeWarning');
  const shown = { hidden: w.classList.contains('hidden'), text: w.textContent };
  window.fetch = origFetch;
  await loadPrime();
  return { shown, hiddenAfterFresh: document.querySelector('#primeWarning').classList.contains('hidden') };
});
console.log('warning state:', JSON.stringify(warnState));
await browser.close();
