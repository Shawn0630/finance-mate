// Screenshot self-check with the local headless Chrome.
// This Chrome build refuses direct loopback navigation, so requests to a
// fake origin (http://ff.local) are bridged via CDP Fetch to 127.0.0.1.
//   node tests/screenshot.mjs            (server must be running on :9200)
// Env: FF_PORT (default 9200), FF_COOKIE (session cookie value, optional —
// the script logs in as admin/admin itself when omitted).
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

async function getCookie() {
  if (process.env.FF_COOKIE) return process.env.FF_COOKIE;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const setCookie = res.headers.get('set-cookie');
  return setCookie.split(';')[0].split('=')[1];
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
      console.error('bridge error', err.message);
      try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
    }
  });
  return client;
}

const cookieValue = await getCookie();
const browser = await puppeteer.launch({
  executablePath: '/opt/meta-chromium/chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1360,1024'],
  defaultViewport: { width: 1360, height: 1024 },
});
const page = await browser.newPage();
const mainClient = await attachBridge(page);
await mainClient.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Login page in a separate browser context (no session cookie there).
const ctx = await browser.createBrowserContext();
const lp = await ctx.newPage();
await attachBridge(lp);
await lp.goto('http://ff.local/login.html', { waitUntil: 'networkidle0', timeout: 30000 });
await wait(800);
await lp.screenshot({ path: path.join(OUT, 'login.png') });
console.log('login.png', fs.statSync(path.join(OUT, 'login.png')).size);
await ctx.close();

// 2. Assets page.
await page.goto('http://ff.local/#assets', { waitUntil: 'networkidle0', timeout: 30000 });
await wait(1500);
await page.screenshot({ path: path.join(OUT, 'assets.png') });
console.log('assets.png', fs.statSync(path.join(OUT, 'assets.png')).size);

// 3. Property detail with the chart (first property).
const firstId = await page.evaluate(async () => {
  const rows = await (await fetch('/api/properties')).json();
  return rows[0] && rows[0].id;
});
await page.goto(`http://ff.local/#property/${firstId}`, { waitUntil: 'networkidle0', timeout: 30000 });
await wait(2500);
const chartInfo = await page.evaluate(() => {
  const c = document.getElementById('mortgageChart');
  return { summary: document.getElementById('chartSummary').textContent, canvasH: c ? c.height : 0 };
});
console.log('chart summary:', chartInfo.summary);
await page.screenshot({ path: path.join(OUT, 'property-detail.png'), fullPage: true });
console.log('property-detail.png', fs.statSync(path.join(OUT, 'property-detail.png')).size);

// 4. Chart close-up (element screenshot of the projection panel).
const panel = await page.evaluateHandle(() => {
  const c = document.getElementById('mortgageChart');
  let el = c;
  while (el && !el.classList.contains('panel')) el = el.parentElement;
  return el;
});
await panel.asElement().screenshot({ path: path.join(OUT, 'chart.png') });
console.log('chart.png', fs.statSync(path.join(OUT, 'chart.png')).size);

await browser.close();
