// veil: Hub loading veil — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-veil.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only veil]
import http from 'node:http';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
import { run as runCore } from './e2e-core.mjs';
import { run as runUiProperty } from './e2e-ui-property.mjs';
export const deps = [runCore, runUiProperty];
export async function run(H, S) {
  let r;
  {
    r = await H.req('POST', '/api/properties', { address: '321 Loading Test Lane, Victoria, BC', purchase_date: '2024-06-01', mortgage_balance: 400000 });
    const loadPid = r.data.id;
    await H.req('POST', `/api/properties/${loadPid}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 });
    await H.req('POST', `/api/properties/${loadPid}/value-history`, { year: 2026, value: 900000 });

    const http = await import('node:http');
    const forwardD = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: H.PORT, path: rq.url, method: rq.method, headers: rq.headers },
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
    const waitD = (ms) => new Promise((res) => setTimeout(res, ms));
    let pfGate = null; // null | 'hold'
    const held = [];
    const adminCookieD = await H.loginAs('admin', 'admin');
    const browserD = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserD.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          if (u.pathname === '/api/properties/portfolio' && pfGate === 'hold') { held.push(e); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardD({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      const releaseHeld = async (asError = false) => {
        const items = held.splice(0);
        for (const e of items) {
          if (asError) {
            await client.send('Fetch.fulfillRequest', {
              requestId: e.requestId, responseCode: 500,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
              body: Buffer.from(JSON.stringify({ error: 'portfolio stub failure' })).toString('base64'),
            });
          } else {
            const u = new URL(e.request.url);
            const headers = {};
            for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
            const resp = await forwardD({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
            const respHeaders = Object.entries(resp.headers)
              .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
              .map(([name, value]) => ({ name, value: String(value) }));
            await client.send('Fetch.fulfillRequest', {
              requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
              body: resp.body.toString('base64'),
            });
          }
        }
      };
      const [nameD, valueD] = adminCookieD.split('=');
      await client.send('Network.setCookie', { name: nameD, value: valueD, domain: 'ff.local', path: '/', httpOnly: true });
      await page.evaluateOnNewDocument(() => {
        window.__veilSeen = false;
        document.addEventListener('DOMContentLoaded', () => {
          const el = document.getElementById('globalLoading');
          if (!el) return;
          const check = () => { if (!el.classList.contains('hidden')) window.__veilSeen = true; };
          new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ['class'] });
          setInterval(check, 25);
        });
      });
      const loadState = () => page.evaluate(() => window.__fmLoading.state());
      const pollState = async (pred, tries = 40) => {
        for (let i = 0; i < tries; i++) {
          try { const s = await loadState(); if (pred(s)) return s; } catch {}
          await waitD(200);
        }
        return null;
      };

      // Fast path: a hub refetch that completes inside the 200ms
      // delay never shows the veil. (A full navigation of this
      // suite's 20+-property fixture legitimately takes longer —
      // the veil showing there is correct — so the fast case is
      // measured on a single gated refetch through the pf range
      // button's real loadPortfolio path, released after ~60ms.)
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      const navSettled = await pollState((s) => s.count === 0 && s.visible === false, 40);
      const navChart = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        return c ? c.data.datasets.map((d) => d.key) : null;
      });
      H.check('the properties view settles with the counter at 0 and the chart drawn',
        !!navSettled && !!navChart && navChart.includes('equity'),
        JSON.stringify({ navSettled, navChart }));
      pfGate = 'hold';
      await page.evaluate(() => { window.__veilSeen = false; });
      await page.evaluate(() => document.querySelector('#pfRangeBtns button[data-months="12"]').click());
      await waitD(60);
      const heldN = held.length;
      await releaseHeld(false);
      pfGate = null;
      const fastSettled = await pollState((s) => s.count === 0, 40);
      const fastSeen = await page.evaluate(() => window.__veilSeen);
      H.check('a refetch completing inside the delay never shows the veil (anti-flash)',
        heldN >= 1 && !!fastSettled && fastSeen === false,
        JSON.stringify({ heldN, fastSettled, fastSeen }));

      // Slow path: hold the portfolio response — the veil
      // appears, the redraw completes once it is released, and
      // the veil lifts.
      pfGate = 'hold';
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      const slowShown = await pollState((s) => s.visible === true, 25);
      H.check('a slow refetch shows the global loading veil while the request is held',
        !!slowShown && slowShown.count >= 1, JSON.stringify(slowShown));
      await releaseHeld(false);
      pfGate = null;
      const slowDone = await pollState((s) => s.count === 0 && s.visible === false, 40);
      const slowChart = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        return c ? c.data.datasets.map((d) => d.key) : null;
      });
      H.check('releasing the response completes the redraw under the veil, then the veil lifts',
        !!slowDone && !!slowChart && slowChart.includes('equity'),
        JSON.stringify({ slowDone, slowChart }));

      // Error path: hold, let the veil show, then fail the
      // response — the veil lifts and the error is visible.
      pfGate = 'hold';
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      const errShown = await pollState((s) => s.visible === true, 25);
      H.check('the veil is up before the failing response lands', !!errShown, JSON.stringify(errShown));
      await releaseHeld(true);
      pfGate = null;
      const errState = await pollState((s) => s.count === 0 && s.visible === false, 40);
      let errBanner = null;
      for (let i = 0; i < 30 && !errBanner; i++) {
        errBanner = await page.evaluate(() => {
          const b = document.getElementById('globalError');
          return b && !b.classList.contains('hidden') && b.textContent.includes('portfolio stub failure')
            ? b.textContent : null;
        });
        if (!errBanner) await waitD(200);
      }
      H.check('a failed refetch lifts the veil and leaves the error visible in the global banner',
        !!errState && !!errBanner, JSON.stringify({ errState, errBanner }));
    } catch (err) {
      H.check('global loading veil browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserD.close();
    }
    await H.req('DELETE', `/api/properties/${loadPid}`);
  }

  // ================================================================
}

runModuleMain(import.meta.url, { name: 'veil', deps, depNames: ['core', 'ui-property'], run });
