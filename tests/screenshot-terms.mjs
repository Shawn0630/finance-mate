// Visual self-check for the term card's styling: the merged term
// form on the site grid, the add-segment form collapsed by default
// (opening it shows NO error — an incomplete draft previews
// nothing), the add-segment form expanded on the same grid, and
// the rate-segment table's fixed columns. Self-contained like
// screenshot-layout.mjs: throwaway DATA_DIR, API seeding, CDP
// Fetch bridge, element screenshots into tests/.work-shot/.
//   node tests/screenshot-terms.mjs
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

const PORT = 19900 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(import.meta.dirname, '.work-shot');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-terms-'));

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
  await req('POST', `/api/properties/${pid}/rates`, { start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 4.25 });

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
  await wait(2000);
  await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
  await wait(900);

  const segState = () => page.evaluate(() => {
    const form = document.querySelector('#termsWrap .term-block [data-seg-form]');
    const cs = form ? getComputedStyle(form) : null;
    return {
      display: cs ? cs.display : null,
      preview: form ? form.querySelector('[data-plan-preview]').textContent : null,
    };
  });
  const closed = await segState();
  console.log('seg form by default:', JSON.stringify(closed));

  const block1 = await page.evaluateHandle(() => document.querySelector('#termsWrap .term-block'));
  await block1.asElement().screenshot({ path: path.join(OUT, 'terms-card.png') });
  console.log('terms-card.png', fs.statSync(path.join(OUT, 'terms-card.png')).size);

  // Open the add-segment form: it must appear with a BLANK preview
  // line (no validation error for an unsubmitted draft).
  await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-toggle-seg]').click());
  await wait(700);
  const opened = await segState();
  console.log('seg form on open:', JSON.stringify(opened));
  const block2 = await page.evaluateHandle(() => document.querySelector('#termsWrap .term-block'));
  await block2.asElement().screenshot({ path: path.join(OUT, 'terms-seg-open.png') });
  console.log('terms-seg-open.png', fs.statSync(path.join(OUT, 'terms-seg-open.png')).size);

  // A complete draft previews normally (the guard only blanks
  // incomplete ones).
  await page.evaluate(() => {
    const el = document.querySelector('#termsWrap .term-block [data-seg-form] [name=annual_rate]');
    el.value = '4.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(1100);
  const previewed = await segState();
  console.log('seg form with a rate typed:', JSON.stringify(previewed));

  // Close + reopen: the form collapses, and on reopen the preview
  // line starts blank (checked synchronously, before any debounce).
  await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-toggle-seg]').click());
  await wait(200);
  const closedAgain = await segState();
  await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-toggle-seg]').click());
  const reopened = await segState();
  console.log('seg form after close:', JSON.stringify(closedAgain), 'on reopen:', JSON.stringify(reopened));

  const ok = closed.display === 'none'
    && opened.display !== 'none' && opened.preview === ''
    && previewed.preview.includes('Next month')
    && closedAgain.display === 'none' && reopened.preview === '';
  console.log('terms styling facts OK:', ok);
  if (!ok) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
