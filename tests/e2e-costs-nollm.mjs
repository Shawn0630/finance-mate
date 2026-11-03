// costs-nollm: Property costs with no LLM (third server + browser) — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-costs-nollm.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only costs-nollm]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {

  // ---------------------------------------------------------------
  // Property costs with NO LLM configured: the panel still works
  // (table renders, entries save) and the AI chat shows the setup
  // guidance with Send disabled. A third server, no LLM env.
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('costs no-LLM browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-costs-nollm-'));
    const port3 = H.PORT + 702;
    const server3 = H.spawn('node', ['src/server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, DATA_DIR: dir3, PORT: String(port3) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const browser3 = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      let cookie3 = '';
      for (let i = 0; i < 50 && !cookie3; i++) {
        try {
          const login = await fetch(`http://127.0.0.1:${port3}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' }),
          });
          if (login.ok) cookie3 = (login.headers.get('set-cookie') || '').split(';')[0];
        } catch { /* not up yet */ }
        if (!cookie3) await new Promise((res3) => setTimeout(res3, 200));
      }
      const req3 = async (method, urlPath, body) => {
        const resp = await fetch(`http://127.0.0.1:${port3}${urlPath}`, {
          method,
          headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: resp.status, data: await resp.json().catch(() => null) };
      };
      const prop3 = await req3('POST', '/api/properties', { address: '5 No LLM Lane, Victoria, BC', purchase_date: '2024-01-01' });
      const pid3 = prop3.data.id;
      await req3('POST', `/api/properties/${pid3}/costs`, { year: 2026, category: 'Property tax', amount: 4200 });
      const chat503b = await req3('POST', '/api/ai/fill-chat', { propertyId: pid3, text: 'x' });
      H.check('fill-chat 503 names the missing LLM setup',
        chat503b.status === 503 && String(chat503b.data.error || '').includes('LLM_BASE_URL'),
        JSON.stringify(chat503b).slice(0, 200));
      const forward3 = (rq) => new Promise((resolve, reject) => {
        const rr = http.request(
          { host: '127.0.0.1', port: port3, path: rq.url, method: rq.method, headers: rq.headers },
          (resp) => {
            const chunks = [];
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
          }
        );
        rr.on('error', reject);
        if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
        rr.end();
      });
      const page3 = await browser3.newPage();
      const client3 = await page3.target().createCDPSession();
      await client3.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client3.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client3.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forward3({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client3.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client3.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client3.send('Network.setCookie', {
        name: 'ff_session', value: cookie3.split('=')[1], domain: 'ff.local', path: '/', httpOnly: true,
      });
      const wait3 = (ms) => new Promise((res3) => setTimeout(res3, ms));
      const until3 = async (fn, tries = 40) => {
        for (let i = 0; i < tries; i++) {
          try { const v = await page3.evaluate(fn); if (v) return v; } catch {}
          await wait3(250);
        }
        return null;
      };
      await page3.goto(`http://ff.local/#property/${pid3}`, { waitUntil: 'networkidle0', timeout: 30000 });
      H.check('without an LLM the costs panel still renders its entries',
        !!(await until3(() => {
          const rows = document.querySelectorAll('#costsYears tr[data-cost-row]');
          return rows.length === 1 && document.querySelector('#costsYears').textContent.includes('4,200');
        })));
      await page3.evaluate(() => document.querySelector('[data-costs-ai-toggle]').click());
      await wait3(500);
      const guidance3 = await page3.evaluate(() => {
        const g = document.querySelector('[data-costs-ai-guidance]');
        const send = document.querySelector('[data-costs-chat-send]');
        return { hidden: g.classList.contains('hidden'), text: g.textContent, sendDisabled: send.disabled };
      });
      H.check('the AI chat shows the setup guidance and Send stays disabled',
        guidance3.hidden === false && guidance3.text.includes('LLM_BASE_URL') && guidance3.sendDisabled === true,
        JSON.stringify(guidance3));
      // The rest of the panel is unaffected: an entry still saves
      // (through the seeded 2026 table's own Add row, in edit mode).
      await page3.evaluate(() => document.querySelector('#costsEditToggleBtn').click());
      await wait3(300);
      await page3.evaluate(() => document.querySelector('[data-cost-year-block="2026"] [data-cost-add-row]').click());
      await wait3(300);
      await page3.evaluate(() => {
        const row = document.querySelector('#costsYears tr.cost-editing');
        row.querySelector('[name=category]').value = 'Water';
        const amt = row.querySelector('[name=amount]');
        amt.value = '480';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
        row.querySelector('[data-cost-save]').click();
      });
      H.check('entries still save with no LLM configured',
        !!(await until3(() => document.querySelector('#costsYears').textContent.includes('Water'))));
    } catch (err) {
      H.check('costs no-LLM browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browser3.close();
      server3.kill();
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------
}

runModuleMain(import.meta.url, { name: 'costs-nollm', deps, depNames: [], run });
