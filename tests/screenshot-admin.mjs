// Screenshot for the Admin page: the user list with avatars — letter
// defaults for admin and Shawn, and an uploaded photo for Jiaying
// (a tiny solid-red PNG uploaded through the admin API first).
// Same CDP Fetch bridge as tests/screenshot.mjs.
//   node tests/screenshot-admin.mjs     (server on :9200)
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

const apiBase = `http://127.0.0.1:${PORT}`;
const loginRes = await fetch(`${apiBase}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
const cookieHeader = loginRes.headers.get('set-cookie').split(';')[0];
const cookieValue = cookieHeader.split('=')[1];

// Give Jiaying a photo avatar so the shot shows both kinds side by side.
const usersRes = await fetch(`${apiBase}/api/admin/users`, { headers: { Cookie: cookieHeader } });
const users = await usersRes.json();
const jiaying = users.find((u) => u.username === 'Jiaying');
const TINY_RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await fetch(`${apiBase}/api/admin/users/${jiaying.id}/avatar`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
  body: JSON.stringify({ dataBase64: TINY_RED_PNG, contentType: 'image/png' }),
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

await page.goto('http://ff.local/#admin', { waitUntil: 'networkidle0', timeout: 30000 });
await wait(1200);
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('#adminUserRows tr')].map((tr) => tr.cells[0].textContent.trim()));
console.log('admin rows:', JSON.stringify(rows));
await page.screenshot({ path: path.join(OUT, 'admin-page.png') });
console.log('admin-page.png', fs.statSync(path.join(OUT, 'admin-page.png')).size);

await browser.close();
