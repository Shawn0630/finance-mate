// Screenshots for the Assets information architecture (secondary menu,
// Overview, per-section listings, Add modals, detail views).
// Same CDP Fetch bridge as tests/screenshot.mjs.
//   node tests/screenshot-ia.mjs     (server on :9200 with demo data)
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

const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];

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
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log(name, fs.statSync(path.join(OUT, name)).size);
};

// 1. Overview (totals + breakdown cards).
await page.goto('http://ff.local/#assets/overview', { waitUntil: 'networkidle0', timeout: 30000 });
await wait(1200);
await shot('overview.png');

// 2. Properties section listing.
await page.evaluate(() => { location.hash = '#assets/properties'; });
await wait(900);
await shot('section-properties.png');

// 3. Add-property modal open.
await page.click('#addPropertyBtn');
await wait(600);
await shot('property-modal.png');
await page.keyboard.press('Escape');
await wait(300);

// 4. Other section listing (the retired registry Stocks section's
// entries live here now, tagged by category).
await page.evaluate(() => { location.hash = '#assets/other'; });
await wait(900);
await shot('section-other.png');

// 5. Add-asset modal open (category locked to Other).
await page.evaluate(() => {
  [...document.querySelectorAll('#section-other button')].find((b) => b.textContent.includes('Add asset')).click();
});
await wait(700);
await shot('asset-modal.png');
await page.keyboard.press('Escape');
await wait(300);

// 6. Asset detail view (click the first row).
await page.click('#section-other tbody tr');
await wait(900);
await shot('asset-detail.png');

await browser.close();
