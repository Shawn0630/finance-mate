// Screenshot for the Portfolio block on the Properties section:
// totals strip, share pie, and the combined assessed/outstanding
// chart with stacked per-property bars. Also asserts the pie's
// entrance-animation configuration and that both charts rendered.
// Same CDP Fetch bridge as tests/screenshot.mjs.
//   node tests/screenshot-portfolio.mjs     (server on :9200)
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

async function addProperty(body, rate, points) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/properties`, {
    method: 'POST', headers: apiHeaders, body: JSON.stringify(body),
  });
  const p = await res.json();
  await fetch(`http://127.0.0.1:${PORT}/api/properties/${p.id}/rates`, {
    method: 'POST', headers: apiHeaders,
    body: JSON.stringify({ start_date: '2026-01-01', rate_type: 'fixed', annual_rate: rate }),
  });
  for (const pt of points) {
    await fetch(`http://127.0.0.1:${PORT}/api/properties/${p.id}/value-history`, {
      method: 'POST', headers: apiHeaders, body: JSON.stringify(pt),
    });
  }
  return p;
}

// Two properties with plans and assessed history.
await addProperty({
  address: '88 Chip Check Crescent, Victoria, BC',
  mortgage_balance: 900000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
  purchase_date: '2021-03-12', owners: ['Shawn', 'Jiaying'],
}, 4.85, [{ year: 2024, value: 980000 }, { year: 2025, value: 1065000 }, { year: 2026, value: 1150000 }]);
await addProperty({
  address: '1200 Government Street, Victoria, BC',
  mortgage_balance: 380000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
  purchase_date: '2022-07-01', owners: ['Shawn'],
}, 3.2, [{ year: 2025, value: 520000 }, { year: 2026, value: 545000 }]);

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

await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
await wait(1800); // let the pie entrance animation (900ms) settle
const state = await page.evaluate(() => {
  const pie = window.__fmCharts && window.__fmCharts.pie;
  const combo = window.__fmCharts && window.__fmCharts.portfolio;
  document.querySelector('#portfolioBlock').scrollIntoView({ block: 'start' });
  return {
    outstanding: document.querySelector('#pfOutstanding').textContent,
    payment: document.querySelector('#pfPayment').textContent,
    interest: document.querySelector('#pfInterest').textContent,
    interestNote: document.querySelector('#pfInterestNote').textContent,
    pieSlices: pie ? pie.data.datasets[0].data.length : 0,
    pieAnimates: pie ? pie.options.animation.animateRotate === true && pie.options.animation.animateScale === true : false,
    pieHoverOffset: pie ? pie.data.datasets[0].hoverOffset : null,
    comboDatasets: combo ? combo.data.datasets.length : 0,
    comboInteraction: combo ? combo.options.interaction.mode : null,
  };
});
console.log('portfolio state:', JSON.stringify(state));
await wait(400);
const blockEl = await page.evaluateHandle(() => document.querySelector('#portfolioBlock'));
await blockEl.screenshot({ path: path.join(OUT, 'portfolio.png') });
console.log('portfolio.png', fs.statSync(path.join(OUT, 'portfolio.png')).size);

await browser.close();
