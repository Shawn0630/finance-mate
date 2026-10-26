// Visual self-check for the prime modal: the Mortgage Terms &
// Rates modal carries NO prime banner (no title line, no
// "Recent: …", no standing chart); a prime-spread segment's rate
// text is a link, and clicking it opens the prime modal with the
// stepped Bank of Canada prime history chart, windowed on the
// clicked segment. Self-contained like screenshot-terms.mjs:
// throwaway DATA_DIR, the standalone prime stub as PRIME_API_URL,
// API seeding, CDP Fetch bridge, element screenshot into
// tests/.work-shot/.
//   node tests/screenshot-prime-modal.mjs
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

const PORT = 20100 + (process.pid % 300);
const STUB_PORT = 19400 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(import.meta.dirname, '.work-shot');
fs.mkdirSync(OUT, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-prime-modal-'));

const stub = spawn('node', ['tests/prime-stub.mjs', String(STUB_PORT)], {
  cwd: path.resolve(import.meta.dirname, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
stub.stderr.on('data', (d) => process.stderr.write('[stub] ' + d));
const server = spawn('node', ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env, DATA_DIR: dataDir, PORT: String(PORT),
    PRIME_API_URL: `http://127.0.0.1:${STUB_PORT}/valet`,
  },
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
  await req('PUT', `/api/properties/${pid}`, { amortization_years: 25, lender: 'RBC' });
  await req('POST', `/api/properties/${pid}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  // Warm the prime cache through the API so the page's loadPrime
  // has the stub history on first paint.
  const prime = (await req('GET', '/api/prime')).data;
  console.log('prime from stub:', JSON.stringify({ current: prime.current, history: prime.history }));

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

  const before = await page.evaluate(() => {
    const link = document.querySelector('#termsWrap [data-prime-link]');
    return {
      bannerGone: !document.querySelector('#primeBanner') && !document.querySelector('#primeChanges')
        && !document.querySelector('#primeChartWrap'),
      staleHidden: document.querySelector('#primeStaleNote').classList.contains('hidden'),
      modalPrimeText: document.querySelector('#mortgageModal').textContent.includes('Bank of Canada prime:'),
      link: link ? { text: link.textContent, start: link.dataset.segStart } : null,
      primeModalOpen: !document.querySelector('#primeModal').classList.contains('hidden'),
    };
  });
  console.log('mortgage modal before click:', JSON.stringify(before));

  await page.evaluate(() => document.querySelector('#termsWrap [data-prime-link]').click());
  await wait(900);
  const after = await page.evaluate(() => {
    const canvas = document.querySelector('#primeChart');
    const rect = canvas ? canvas.getBoundingClientRect() : null;
    const c = window.__fmCharts.prime;
    const ds = c ? c.data.datasets[0] : null;
    return {
      primeModalOpen: !document.querySelector('#primeModal').classList.contains('hidden'),
      mortgageStillOpen: !document.querySelector('#mortgageModal').classList.contains('hidden'),
      hasChart: !!c,
      stepped: ds ? ds.stepped : null,
      ys: ds ? [...new Set(ds.data.map((pt) => pt.y))].sort((a, b) => a - b) : [],
      w: rect ? Math.round(rect.width) : 0,
      h: rect ? Math.round(rect.height) : 0,
      head: document.querySelector('#primeModalCurrent').textContent,
      title: document.querySelector('#primeModal h3').textContent,
    };
  });
  console.log('prime modal after click:', JSON.stringify(after));

  const card = await page.evaluateHandle(() => document.querySelector('#primeModal .modal-card'));
  await card.asElement().screenshot({ path: path.join(OUT, 'prime-modal.png') });
  console.log('prime-modal.png', fs.statSync(path.join(OUT, 'prime-modal.png')).size);

  const ok = before.bannerGone && before.staleHidden && !before.modalPrimeText
    && !!before.link && before.link.start === '2024-12-17' && !before.primeModalOpen
    && after.primeModalOpen && after.mortgageStillOpen && after.hasChart
    && after.stepped === 'after' && after.w > 200 && after.h > 100
    && after.head.includes('4.45%') && after.title === 'Bank of Canada prime history';
  console.log('prime modal facts OK:', ok);
  if (!ok) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  stub.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
