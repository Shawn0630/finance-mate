// Visual self-check for the finalized detail-page layout.
// Self-contained like screenshot-charts.mjs: spawns the server on a
// throwaway DATA_DIR, seeds one property through the API (assessed
// history 2022-2026, a fixed segment, amortization-derived payment,
// two photos), then drives headless Chrome through the CDP Fetch
// bridge and captures: the full detail page (one merged Property
// Details + photo carousel panel -> Value & Mortgage Projection),
// the merged overview panel in its empty-photo and with-photos
// states, the Mortgage Terms & Rates modal, and the Assessment
// History modal. Also prints the live layout facts it asserts on
// (merged structure, axis maxima, schedule page + Total row).
//   node tests/screenshot-layout.mjs
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

const PORT = 19600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(import.meta.dirname, '.work-shot');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-layout-'));

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
    if (r0.postData) r.write(Buffer.from(r0.postData, 'utf8'));
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
    } catch {
      try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
    }
  });
  return client;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TINY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let browser;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(BASE + '/api/summary'); up = r.status === 401; } catch { await wait(200); }
  }
  if (!up) throw new Error('server did not come up');
  let r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  if (r.status !== 200) throw new Error('login failed');

  r = await req('POST', '/api/properties', {
    address: '2985 Christina Pl, Coquitlam, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
  });
  const pid = r.data.id;
  await req('PUT', `/api/properties/${pid}`, { amortization_years: 30, lender: 'Scotiabank' });
  await req('POST', `/api/properties/${pid}/rates`, { start_date: '2024-12-17', rate_type: 'fixed', annual_rate: 3.95 });
  for (const [year, value] of [[2022, 1730000], [2023, 1903000], [2024, 1955000], [2025, 2002000], [2026, 1931000]]) {
    await req('POST', `/api/properties/${pid}/value-history`, { year, value });
  }
  browser = await puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1360,1150'],
    defaultViewport: { width: 1360, height: 1150 },
  });
  const page = await browser.newPage();
  const client = await attachBridge(page);
  await client.send('Network.setCookie', {
    name: 'ff_session', value: cookie.split('=')[1], domain: 'ff.local', path: '/', httpOnly: true,
  });
  await page.goto(`http://ff.local/#property/${pid}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await wait(2500);
  // The merged overview panel before any photos: empty-photo state.
  const ovEmpty = await page.evaluateHandle(() => document.querySelector('#propertyOverview'));
  await ovEmpty.asElement().screenshot({ path: path.join(OUT, 'layout-overview-empty.png') });
  console.log('layout-overview-empty.png', fs.statSync(path.join(OUT, 'layout-overview-empty.png')).size);

  await req('POST', `/api/properties/${pid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
  await req('POST', `/api/properties/${pid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
  await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await wait(2500);
  // All: the full projection (yearly bars) + the schedule's whole span.
  await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
  await wait(800);

  const facts = await page.evaluate(() => {
    const c = window.__fmCharts.a;
    const ov = document.getElementById('propertyOverview');
    const heads = [
      ov ? ov.querySelector('h3').textContent.trim() : '',
      document.getElementById('projectionPanel').querySelector('h3').textContent.trim(),
    ];
    const total = document.querySelector('#scheduleTotalRow');
    const det = ov ? ov.querySelector('.overview-details') : null;
    const pho = ov ? ov.querySelector('.overview-photos') : null;
    const dr = det ? det.getBoundingClientRect() : null;
    const pr = pho ? pho.getBoundingClientRect() : null;
    const tag = ov ? ov.querySelector('.region-tag') : null;
    return {
      headings: heads,
      merged: !!ov && !document.getElementById('galleryPanel') && !document.getElementById('propertyDetailsPanel'),
      leftRight: !!(dr && pr && dr.left < pr.left && Math.abs(dr.top - pr.top) < 4),
      detailLabels: [...document.querySelectorAll('#propViewBody tr td:first-child')].map((td) => td.textContent.trim()),
      detailAssessed: document.getElementById('detailAssessedValue').textContent,
      detailRemaining: document.getElementById('detailRemainingBalance').textContent,
      regionTag: tag ? { text: tag.textContent, title: tag.getAttribute('title') } : null,
      equity: document.getElementById('equitySummary').textContent,
      yMax: c ? c.scales.y.max : null,
      y1Max: c ? c.scales.y1.max : null,
      barAxis: c ? c.data.datasets.filter((d) => d.type === 'bar').map((d) => d.yAxisID) : [],
      scheduleYear: document.querySelector('#scheduleYearSelect').value,
      scheduleRows: document.querySelectorAll('#scheduleRows tr').length,
      totalLabel: total ? total.children[0].textContent : '',
      thumbs: document.querySelectorAll('#photoArea .photo-thumbs .thumb').length,
    };
  });
  console.log('layout facts:', JSON.stringify(facts, null, 1));
  const factsOk = facts.headings.join('|') === 'Property Details|Value & Mortgage Projection'
    && facts.merged && facts.leftRight
    && facts.detailLabels.join('|') === 'Address|Owners|Purchase date'
    && facts.detailAssessed === '$1,931,000' && /^\$[\d,]+$/.test(facts.detailRemaining)
    && !!facts.regionTag && facts.regionTag.title === 'Canada (CA)'
    && /^Current equity: \$[\d,]+$/.test(facts.equity.trim())
    && facts.y1Max > 0 && facts.y1Max < 100000 && facts.yMax > 1900000
    && facts.barAxis.every((a) => a === 'y1') && facts.scheduleRows > 0 && facts.thumbs === 2;
  console.log('layout facts OK:', factsOk);
  if (!factsOk) process.exitCode = 1;

  const ovFull = await page.evaluateHandle(() => document.querySelector('#propertyOverview'));
  await ovFull.asElement().screenshot({ path: path.join(OUT, 'layout-overview-photos.png') });
  console.log('layout-overview-photos.png', fs.statSync(path.join(OUT, 'layout-overview-photos.png')).size);

  await page.evaluate(() => {
    const c = window.__fmCharts.a;
    if (c) { c.options.animation = false; c.update('none'); }
  });
  await wait(500);
  await page.screenshot({ path: path.join(OUT, 'layout-detail.png'), fullPage: true });
  console.log('layout-detail.png', fs.statSync(path.join(OUT, 'layout-detail.png')).size);

  await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
  await wait(900);
  const mCard = await page.evaluateHandle(() => document.querySelector('#mortgageModal .modal-card'));
  await mCard.asElement().screenshot({ path: path.join(OUT, 'layout-mortgage-modal.png') });
  console.log('layout-mortgage-modal.png', fs.statSync(path.join(OUT, 'layout-mortgage-modal.png')).size);
  await page.evaluate(() => document.querySelector('#mortgageModal [data-close-modal]').click());
  await wait(400);

  await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
  await wait(900);
  const hCard = await page.evaluateHandle(() => document.querySelector('#historyModal .modal-card'));
  await hCard.asElement().screenshot({ path: path.join(OUT, 'layout-history-modal.png') });
  console.log('layout-history-modal.png', fs.statSync(path.join(OUT, 'layout-history-modal.png')).size);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
