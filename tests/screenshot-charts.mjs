// Screenshot + DOM verification for the reorganized detail-page charts.
// Self-contained: spawns the server on a throwaway DATA_DIR, seeds one
// property through the API (assessed history 2024-2026 ending at
// 1,150,000; outstanding principal 900,000 -> equity must read $250,000),
// then drives headless Chrome through the CDP Fetch bridge (this Chrome
// build refuses direct loopback navigation) and reports the live chart
// configs + equity text before taking the screenshots.
//   node tests/screenshot-charts.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch { puppeteer = require('/tmp/pptr/node_modules/puppeteer-core'); }
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 19400 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(import.meta.dirname, '.work-shot');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-'));

const server = spawn('node', ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) },
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
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function forward(r0) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: r0.url, method: r0.method, headers: r0.headers },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      }
    );
    r.on('error', reject);
    if (r0.postData) r.write(Buffer.from(r0.postData, 'base64'));
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  // Wait for the server, then seed the fixture.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(BASE + '/api/summary'); up = r.status === 401; } catch { await wait(200); }
  }
  if (!up) throw new Error('server did not come up');
  let r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  if (r.status !== 200) throw new Error('login failed');

  r = await req('POST', '/api/properties', {
    address: '88 Chart Crescent, Victoria, BC',
    mortgage_balance: 900000, mortgage_balance_date: '2026-10-01', mortgage_payment: 4981,
    purchase_date: '2021-04-09',
  });
  const pid = r.data.id;
  await req('POST', `/api/properties/${pid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 4.5 });
  await req('POST', `/api/properties/${pid}/rates`, { start_date: '2027-06-01', rate_type: 'variable', annual_rate: 3.9 });
  for (const [year, value] of [[2024, 980000], [2025, 1065000], [2026, 1150000]]) {
    await req('POST', `/api/properties/${pid}/value-history`, { year, value });
  }
  const eq = await req('GET', `/api/properties/${pid}/equity`);
  console.log('API equity:', JSON.stringify(eq.data));

  browser = await puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1360,1100'],
    defaultViewport: { width: 1360, height: 1100 },
  });
  const page = await browser.newPage();
  const client = await attachBridge(page);
  await client.send('Network.setCookie', {
    name: 'ff_session', value: cookie.split('=')[1], domain: 'ff.local', path: '/', httpOnly: true,
  });
  await page.goto(`http://ff.local/#property/${pid}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await wait(2500);

  const info = await page.evaluate(() => {
    const describe = (c) => (c ? c.data.datasets.map((d) => ({
      label: d.label, color: d.borderColor, points: d.data.length,
    })) : null);
    return {
      canvases: [...document.querySelectorAll('canvas')].map((c) => c.id),
      equityText: document.getElementById('equitySummary').textContent,
      monthlySummary: document.getElementById('monthlySummary').textContent,
      chartA: describe(window.__fmCharts.a),
      chartB: describe(window.__fmCharts.b),
    };
  });
  console.log('DOM check:', JSON.stringify(info, null, 1));
  const equityOk = info.equityText.includes('$250,000');
  const aOk = info.chartA && info.chartA.length === 2
    && info.chartA[0].label === 'Assessed value' && info.chartA[1].label === 'Outstanding principal'
    && info.chartA[0].color !== info.chartA[1].color;
  const bOk = info.chartB && info.chartB.length === 2
    && info.chartB[0].label === 'Monthly interest' && info.chartB[1].label.startsWith('Monthly payment')
    && info.chartB[0].color !== info.chartB[1].color;
  console.log(`equity $250,000 shown: ${equityOk} | chart A two-tone: ${aOk} | chart B two-tone: ${bOk}`);

  // Full-page screenshots resize the viewport, which restarts Chart.js
  // animations and can catch the lines mid-draw; settle them first.
  await page.evaluate(() => {
    for (const c of [window.__fmCharts.a, window.__fmCharts.b]) {
      if (c) { c.options.animation = false; c.update('none'); }
    }
  });
  await wait(600);
  await page.screenshot({ path: path.join(OUT, 'property-detail.png'), fullPage: true });
  console.log('property-detail.png', fs.statSync(path.join(OUT, 'property-detail.png')).size);
  const panel = await page.evaluateHandle(() => {
    const c = document.getElementById('combinedChart');
    let el = c;
    while (el && !el.classList.contains('panel')) el = el.parentElement;
    return el;
  });
  await panel.asElement().screenshot({ path: path.join(OUT, 'combined-chart.png') });
  console.log('combined-chart.png', fs.statSync(path.join(OUT, 'combined-chart.png')).size);
  if (!equityOk || !aOk || !bOk) process.exitCode = 1;

  // The Add property modal (fields change as the form evolves; this
  // captures whatever the current slim form looks like).
  await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
  await wait(800);
  await page.click('#addPropertyBtn');
  await wait(600);
  const modalFields = await page.evaluate(() =>
    [...document.querySelectorAll('#addPropForm label')].map((l) => l.textContent.trim()));
  console.log('add-modal fields:', JSON.stringify(modalFields));
  const modal = await page.evaluateHandle(() => document.querySelector('#propertyModal .modal-card'));
  await modal.asElement().screenshot({ path: path.join(OUT, 'add-property-modal.png') });
  console.log('add-property-modal.png', fs.statSync(path.join(OUT, 'add-property-modal.png')).size);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
