// Screenshot for the payment-frequency picker: the Rate segments
// panel of a property detail page with an accelerated bi-weekly
// schedule picked — the payment-day input is disabled and the
// explanation note shows, since day-stepped schedules ignore it.
// Same CDP Fetch bridge as tests/screenshot.mjs.
//   node tests/screenshot-frequency.mjs     (server on :9200)
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

// Fixture: a property with a rate plan, a payment day, and the
// accelerated bi-weekly frequency stored.
const propRes = await fetch(`http://127.0.0.1:${PORT}/api/properties`, {
  method: 'POST', headers: apiHeaders,
  body: JSON.stringify({
    address: '88 Frequency Crescent, Victoria, BC',
    mortgage_balance: 640000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2021-03-12', owners: ['Shawn', 'Jiaying'],
  }),
});
const prop = await propRes.json();
await fetch(`http://127.0.0.1:${PORT}/api/properties/${prop.id}/rates`, {
  method: 'POST', headers: apiHeaders,
  body: JSON.stringify({ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 4.85 }),
});
await fetch(`http://127.0.0.1:${PORT}/api/properties/${prop.id}`, {
  method: 'PUT', headers: apiHeaders,
  body: JSON.stringify({ payment_day: 15, payment_frequency: 'accelerated_bi_weekly' }),
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
const state = await page.evaluate(() => {
  const sel = document.querySelector('#paymentFrequencySelect');
  const day = document.querySelector('#paymentDayInput');
  const panel = document.querySelector('#paymentDayForm').closest('.panel');
  panel.scrollIntoView({ block: 'center' });
  return {
    frequency: sel.value,
    dayValue: day.value,
    dayDisabled: day.disabled,
    note: document.querySelector('#paymentFreqNote').textContent,
  };
});
console.log('frequency UI state:', JSON.stringify(state));
await wait(500);
const panelEl = await page.evaluateHandle(() => document.querySelector('#paymentDayForm').closest('.panel'));
await panelEl.screenshot({ path: path.join(OUT, 'payment-frequency.png') });
console.log('payment-frequency.png', fs.statSync(path.join(OUT, 'payment-frequency.png')).size);

await browser.close();
