// Visual self-check for the detail projection's From/To month
// picker: button fields ("Mon YYYY") in the range toolbar and the
// shared popover open under From — year stepper over a 12-month
// grid. Self-contained like screenshot-terms.mjs: throwaway
// DATA_DIR, API seeding, CDP Fetch bridge, element screenshot of
// the projection panel into tests/.work-shot/.
//   node tests/screenshot-range.mjs
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

const PORT = 19700 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(import.meta.dirname, '.work-shot');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-range-'));

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
  await req('PUT', `/api/properties/${pid}`, { amortization_years: 30, lender: 'RBC' });
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
  await wait(2200);

  const closed = await page.evaluate(() => ({
    start: document.querySelector('#rangeStart').textContent,
    startVal: document.querySelector('#rangeStart').dataset.value,
    end: document.querySelector('#rangeEnd').textContent,
    endVal: document.querySelector('#rangeEnd').dataset.value,
    popHidden: document.querySelector('#monthPop').classList.contains('hidden'),
  }));
  console.log('fields with picker closed:', JSON.stringify(closed));

  await page.evaluate(() => document.querySelector('#rangeStart').click());
  await wait(500);
  const open = await page.evaluate(() => {
    const pop = document.querySelector('#monthPop');
    const field = document.querySelector('#rangeStart');
    const rect = pop.getBoundingClientRect();
    const frect = field.getBoundingClientRect();
    return {
      popHidden: pop.classList.contains('hidden'),
      year: document.querySelector('#monthPopYear').textContent,
      cells: document.querySelectorAll('#monthPopGrid button').length,
      sel: (document.querySelector('#monthPopGrid button.sel') || {}).dataset?.ym,
      popW: Math.round(rect.width), popH: Math.round(rect.height),
      belowField: rect.top >= frect.bottom - 1,
      withinPanel: rect.right <= document.querySelector('#projectionPanel').getBoundingClientRect().right + 1,
    };
  });
  console.log('picker open:', JSON.stringify(open));
  const ok = !open.popHidden && open.cells === 12 && open.belowField && open.withinPanel;
  console.log('picker facts OK:', ok);
  if (!ok) process.exitCode = 1;

  const panel = await page.evaluateHandle(() => document.querySelector('#projectionPanel'));
  await panel.asElement().screenshot({ path: path.join(OUT, 'range-picker-open.png') });
  console.log('range-picker-open.png', fs.statSync(path.join(OUT, 'range-picker-open.png')).size);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
