// ui-property: Money fields HTML + the property-page browser session — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-ui-property.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only ui-property]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { simulate as engineSimulate, derivePayment as engineDerive, monthlyRate as engineMonthlyRate, buildSchedule as engineSchedule, primeAtDateResolver as enginePrimeAtDate, remainingBalanceAt as engineRemainingBalance } from '../src/engine.js';
import { runModuleMain } from './e2e-child.mjs';
import { run as runCore } from './e2e-core.mjs';
export const deps = [runCore];
export async function run(H, S) {
  let r;
  // Every money field is a text input marked data-money; the shared
  // format/parse pair in app.js groups what the user sees and parses it
  // back before anything is sent, so the API still receives numbers.
  // The principal money fields live in the term cards
  // (client-rendered in the terms accordion): count the static page
  // and the rendered templates together. The principal pair's input
  // name switches between opening_balance and anchor_balance (the
  // term carrying the balance anchor edits the anchor values).
  // The term's payment override is edited through the Monthly
  // payment row's inline editor, whose input is a money field
  // like the others — there is no standalone override input (and
  // no "Monthly payment override" label) and still no
  // PROPERTY-level payment field anywhere.
  const appJsRes2 = await fetch(H.BASE + '/app.js', { headers: { Cookie: H.getCookie() } });
  const appJsText2 = await appJsRes2.text();
  H.check('money inputs are marked data-money in the page (the payment-row editor is one of them; no standalone override field)',
    (S.pageHtml.match(/data-money/g) || []).length >= 4
      && (appJsText2.match(/name="payment_override"[^>]*data-money/g) || []).length === 1
      && !appJsText2.includes('Monthly payment override')
      && !appJsText2.includes('name="mortgage_payment"')
      && (appJsText2.match(/name="\$\{principalName\}"[^>]*data-money/g) || []).length === 1
      && appJsText2.includes("anchored ? 'anchor_balance' : 'opening_balance'"),
    String((S.pageHtml.match(/data-money/g) || []).length));
  H.check('frontend wires the shared money format/parse helpers',
    S.jsText.includes('formatMoneyInput') && S.jsText.includes('parseMoneyInput') && S.jsText.includes('input[data-money]'));

  // Real-browser pass over the money fields (same puppeteer + CDP Fetch
  // bridge as tests/screenshot.mjs). Skipped, with a note, when no probe
  // browser is at hand — the HTTP assertions above still hold the line.
  await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
  
  try {
    const { createRequire } = await import('node:module');
    const reqmod = createRequire(import.meta.url);
    try { H.puppeteer = reqmod('puppeteer-core'); } catch { H.puppeteer = reqmod('/tmp/pptr/node_modules/puppeteer-core'); }
  } catch { H.puppeteer = null; }
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('money UI browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forward = (rq) => new Promise((resolve, reject) => {
      const rr = http.request(
        { host: '127.0.0.1', port: H.PORT, path: rq.url, method: rq.method, headers: rq.headers },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
        }
      );
      rr.on('error', reject);
      // CDP hands the request body over as a plain string (NOT base64 —
      // decoding it as such garbles every POST the page makes).
      if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
      rr.end();
    });
    const loginRes = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browser = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      // Extra flags come from the environment (e.g. the Hatch WebGL
      // domain policy file + hash) so a plain local run stays plain.
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
    try {
      const page = await browser.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const fieldVal = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.value : null; }, sel);
      const focusField = (sel) => page.evaluate((s) => { const el = document.querySelector(s); el.focus(); if (el.select) el.select(); }, sel);

      // Add a property through the form: it carries NO principal
      // field anymore (the mortgage is filled in later), so the
      // property lands with no balance. The principal is then
      // typed into the term card's principal field — a bare number
      // must group live there — and the server must store the
      // plain number, as the term's opening and as the anchor
      // seeded from it.
      const addSrc = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
      H.check('the Add Property intro paragraph is gone from the page source', !addSrc.includes('Just the essentials'));
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      // Portfolio pie modes: three buttons side by side, and the
      // Equity share mode draws the API's equity slices.
      const portNow = (await H.req('GET', '/api/properties/portfolio')).data;
      const pieData = () => page.evaluate(() => {
        const c = window.__fmCharts.pie;
        return c ? { labels: c.data.labels.slice(), data: c.data.datasets[0].data.slice() } : null;
      });
      H.check('the portfolio pie carries three mode buttons (Outstanding / Assessed / Equity)',
        await page.evaluate(() => ['pfPieOutstandingBtn', 'pfPieAssessedBtn', 'pfPieEquityBtn'].every((id) => !!document.getElementById(id))));
      await page.click('#pfPieEquityBtn');
      await wait(400);
      const eqPie = await pieData();
      const eqApiSlices = portNow.pie.equity || [];
      H.check('the Equity share mode draws one slice per positive-equity property, values matching the API slices',
        eqApiSlices.length
          ? (!!eqPie && eqPie.data.length === eqApiSlices.length
            && eqPie.data.every((v, i) => Math.abs(v - eqApiSlices[i].value) <= 0.02)
            && eqPie.labels.every((l, i) => l === eqApiSlices[i].shortLabel))
          : eqPie === null,
        JSON.stringify({ ui: eqPie && eqPie.data, api: eqApiSlices.map((s) => s.value) }));
      await page.click('#pfPieOutstandingBtn');
      await wait(400);
      const outPie = await pieData();
      const outApiSlices = portNow.pie.outstanding || [];
      H.check('switching back to Outstanding share restores the balance slices',
        !!outPie && outPie.data.length === outApiSlices.length
          && outPie.data.every((v, i) => Math.abs(v - outApiSlices[i].value) <= 0.02),
        JSON.stringify({ ui: outPie && outPie.data, api: outApiSlices.map((s) => s.value) }));
      await page.evaluate(() => document.querySelector('#addPropertyBtn').click());
      await wait(500);
      const addModalText = await page.evaluate(() => document.querySelector('#propertyModal').textContent);
      H.check('the rendered Add Property modal carries no intro paragraph', !addModalText.includes('Just the essentials'));
      const addHasBalance = await page.evaluate(() => !!document.querySelector('#addPropForm [name=mortgage_balance]'));
      H.check('the Add Property form has no Outstanding principal field', addHasBalance === false);
      await focusField('#addPropForm .address-input');
      await page.keyboard.type('999 Money Test Terrace, Victoria, BC');
      await page.evaluate(() => {
        const d = document.querySelector('#addPropForm [name=purchase_date]');
        d.value = '2024-12-17';
        d.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('#addPropForm [type=submit]').click());
      await wait(2500);
      r = await H.req('GET', '/api/properties');
      const moneyProp = (r.data || []).find((p) => p.address.includes('Money Test Terrace'));
      H.check('added without a principal: the property exists with no balance anchor',
        !!moneyProp && moneyProp.mortgage_balance === null, JSON.stringify(moneyProp && moneyProp.mortgage_balance));
      const moneyPid = moneyProp.id;

      // Fill the mortgage in from the Mortgage modal: typing a
      // bare number into Term 1's principal field groups it live.
      await page.goto(`http://ff.local/#property/${moneyPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('1350000');
      const typedBalance = await fieldVal('[data-term-form] [name=opening_balance]');
      H.check('term-card principal groups while typing (1350000 -> 1,350,000)', typedBalance === '1,350,000', String(typedBalance));
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(1400);
      r = await H.req('GET', `/api/properties/${moneyPid}`);
      H.check('typed grouped principal stored plain: Term 1 opening 1350000 and the anchor seeded from it',
        r.data.terms[0].opening_balance === 1350000 && r.data.mortgage_balance === 1350000,
        JSON.stringify({ open: r.data.terms[0].opening_balance, anchor: r.data.mortgage_balance }));

      // The modal's read-only metadata shows the grouped current
      // principal, and the current term's card (which carries the
      // principal pair) opens grouped too.
      const metaPrincipal = await page.evaluate(() => document.querySelector('#metaCurrentPrincipal').textContent);
      H.check('modal metadata shows the grouped current principal', metaPrincipal.includes('1,350,000'), String(metaPrincipal));
      const editBalance = await fieldVal('[data-term-form] [name=opening_balance]');
      H.check('the term card opens with the grouped balance', editBalance === '1,350,000', String(editBalance));

      // Paste a pre-grouped figure into the term's principal field
      // and save the term: it must reach the server as the plain
      // number 2500. (This paste used to target the monthly-payment
      // field; that field is gone — the payment is calculated.)
      await focusField('[data-term-form] [name=opening_balance]');
      await client.send('Input.insertText', { text: '2,500' });
      const pastedPrincipal = await fieldVal('[data-term-form] [name=opening_balance]');
      H.check('pasted grouped principal displays grouped', pastedPrincipal === '2,500', String(pastedPrincipal));
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(1400);
      r = await H.req('GET', `/api/properties/${moneyPid}`);
      H.check('pasted principal stored as the plain number 2500',
        r.data.terms[0].opening_balance === 2500, JSON.stringify(r.data.terms[0].opening_balance));

      // The manual assessed value on the same page opens grouped too,
      // and so does a value-history point opened for editing. Both are
      // written through the API, then the page is RELOADED (a goto to
      // the same hash would be a no-op) so the forms prefill afresh.
      await H.req('PUT', `/api/properties/${moneyPid}`, { assessed_value: 2100000, assessed_year: 2026 });
      await H.req('POST', `/api/properties/${moneyPid}/value-history`, { year: 2025, value: 1950000 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const editAssessed = await fieldVal('#propForm [name=assessed_value]');
      H.check('assessed value opens grouped on the detail form', editAssessed === '2,100,000', String(editAssessed));
      r = await H.req('GET', `/api/properties/${moneyPid}/value-history`);
      const pt2025 = (r.data.points || []).find((pt) => pt.year === 2025);
      await page.evaluate((id) => window.editTrendPoint(id), pt2025.id);
      await wait(300);
      const editTrend = await fieldVal('#trendForm [name=value]');
      H.check('trend point edit opens grouped', editTrend === '1,950,000', String(editTrend));

      // Other assets get the same treatment: type bare, see grouped,
      // stored plain; reopen the editor and it is grouped again. The
      // entry is created with category 'stocks' — the registry's old
      // standalone Stocks section is retired, so it lists under
      // Other; the modal still takes an explicit category.
      await page.goto('http://ff.local/#assets/other', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate(() => window.openAssetModal(null, 'stocks'));
      await wait(500);
      await page.evaluate(() => { document.querySelector('#assetForm [name=name]').value = 'Money Test Stock'; });
      await focusField('#assetForm [name=value]');
      await page.keyboard.type('750000');
      const typedAsset = await fieldVal('#assetForm [name=value]');
      H.check('asset value groups while typing (750000 -> 750,000)', typedAsset === '750,000', String(typedAsset));
      await page.evaluate(() => document.querySelector('#assetForm [type=submit]').click());
      await wait(1400);
      r = await H.req('GET', '/api/assets');
      const moneyAsset = (r.data || []).find((a) => a.name === 'Money Test Stock');
      H.check('asset value stored as the plain number 750000',
        !!moneyAsset && moneyAsset.value === 750000, JSON.stringify(moneyAsset && moneyAsset.value));
      await page.evaluate((id) => window.openAssetModal(id), moneyAsset.id);
      await wait(800);
      const editAsset = await fieldVal('#assetForm [name=value]');
      H.check('asset edit opens with the grouped value', editAsset === '750,000', String(editAsset));

      // Retired registry Stocks section: the sub-nav carries exactly
      // one "Stocks" (the accounts module at #assets/investments),
      // the old section element is gone, and the stocks-category
      // entry just created lists under Other with its category tag.
      await page.keyboard.press('Escape');
      await page.evaluate(() => { location.hash = '#assets/other'; });
      await wait(1200);
      const retireView = await page.evaluate(() => {
        const navLinks = [...document.querySelectorAll('#assetsNav a')];
        const rows = [...document.querySelectorAll('#section-other tbody tr')];
        const mts = rows.find((tr) => tr.textContent.includes('Money Test Stock'));
        return {
          stocksHrefs: navLinks.filter((a) => a.textContent.trim() === 'Stocks')
            .map((a) => a.getAttribute('href')),
          hasOldSection: !!document.querySelector('#section-stocks'),
          otherVisible: !document.querySelector('#section-other').classList.contains('hidden'),
          mtsListed: !!mts,
          mtsTagged: !!mts && mts.textContent.includes('Stocks'),
          subtotalText: document.querySelector('#section-other .section-head .note').textContent,
        };
      });
      H.check('sub-nav has exactly one Stocks link — the Stocks module',
        retireView.stocksHrefs.length === 1 && retireView.stocksHrefs[0] === '#assets/investments',
        JSON.stringify(retireView.stocksHrefs));
      H.check('the old registry stocks section is gone', !retireView.hasOldSection);
      H.check('stocks-category entry lists under Other with its category tag',
        retireView.otherVisible && retireView.mtsListed && retireView.mtsTagged, JSON.stringify(retireView));
      r = await H.req('GET', '/api/assets');
      const allAssets = r.data || [];
      const merged = allAssets.filter((a) => a.category === 'other' || a.category === 'stocks');
      const mergedTotal = merged.reduce((sum, a) => sum + Number(a.value || 0), 0);
      const subtotalShown = Number(String(retireView.subtotalText).replace(/[^0-9.\-]/g, ''));
      H.check('Other subtotal includes stocks-category entries',
        Math.abs(subtotalShown - mergedTotal) <= merged.length,
        `${retireView.subtotalText} vs ${mergedTotal}`);
      r = await H.req('GET', '/api/summary');
      const allTotal = allAssets.reduce((sum, a) => sum + Number(a.value || 0), 0);
      H.check('summary other-assets total still counts every category',
        Math.abs(r.data.otherAssets - allTotal) < 0.005, `${r.data.otherAssets} vs ${allTotal}`);
      // The retired hash lands on Other instead of a blank screen.
      await page.goto('http://ff.local/#assets/stocks', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      const landed = await page.evaluate(() => ({
        hash: location.hash,
        otherVisible: !document.querySelector('#section-other').classList.contains('hidden'),
        assetsVisible: !document.querySelector('#view-assets').classList.contains('hidden'),
        hasMts: document.querySelector('#section-other').textContent.includes('Money Test Stock'),
      }));
      H.check('old #assets/stocks hash redirects to Other (no blank screen)',
        landed.hash === '#assets/other' && landed.otherVisible && landed.assetsVisible && landed.hasMts,
        JSON.stringify(landed));

      // A property added without a principal (the API section's
      // pidNoBal): its detail page renders the empty states, and
      // the mortgage filled in from the Mortgage modal makes the
      // projection run.
      await page.goto(`http://ff.local/#property/${S.pidNoBal}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const nbView = await page.evaluate(() => {
        const stats = document.querySelector('#propView').textContent;
        return {
          remaining: document.querySelector('#detailRemainingBalance').textContent,
          hasNaN: stats.includes('NaN') || stats.includes('undefined'),
        };
      });
      H.check('balance-less detail renders the empty remaining balance (—, no NaN/undefined)',
        nbView.remaining === '—' && !nbView.hasNaN, JSON.stringify(nbView));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(600);
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('900000');
      await page.evaluate(() => {
        const a = document.querySelector('[data-term-form] [name=amortization_years]');
        a.value = '25';
        a.dispatchEvent(new Event('input', { bubbles: true }));
        a.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(1400);
      r = await H.req('GET', `/api/properties/${S.pidNoBal}`);
      H.check('the modal save seeds the anchor from Term 1’s opening (900000)',
        r.data.mortgage_balance === 900000 && r.data.terms[0].opening_balance === 900000,
        JSON.stringify({ b: r.data.mortgage_balance, open: r.data.terms[0].opening_balance }));
      await H.req('POST', `/api/properties/${S.pidNoBal}/rates`, { start_date: r.data.terms[0].start_date, rate_type: 'fixed', annual_rate: 5 });
      r = await H.req('GET', `/api/properties/${S.pidNoBal}/amortization`);
      const nbDerived = engineDerive(900000, 5, 25);
      H.check('with a rate segment added, the filled-in mortgage projects (payment derived from 900,000 at 5% over 25y)',
        r.data.ok === true && r.data.paymentDerived === nbDerived,
        JSON.stringify({ ok: r.data.ok, d: r.data.paymentDerived, want: nbDerived }));
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const nbGrouped = nbDerived.toLocaleString('en-CA', { maximumFractionDigits: 0 });
      let nbStatOk = false;
      for (let i = 0; i < 24 && !nbStatOk; i++) {
        nbStatOk = await page.evaluate((g) => document.querySelector('#estPaymentValue').textContent.includes(g), nbGrouped);
        if (!nbStatOk) await wait(250);
      }
      H.check('the detail payment stat shows the derived figure after the fill-in', nbStatOk);
      await H.req('DELETE', `/api/properties/${S.pidNoBal}`);

      // Equity displays: the detail page's third headline stat
      // and the overview's Total equity card. The anchor property
      // (created in the API section above): assessed 1,931,000,
      // remaining 1,280,775 -> Current equity $650,225.
      await page.goto(`http://ff.local/#property/${S.eqPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1800);
      const eqStats = await page.evaluate(() => ({
        assessed: document.querySelector('#detailAssessedValue').textContent,
        remaining: document.querySelector('#detailRemainingBalance').textContent,
        equity: document.querySelector('#detailCurrentEquity').textContent,
      }));
      H.check('detail headline stats: Assessed $1,931,000, Remaining $1,280,775.00, Current equity $650,225.00 (balances render to the cent, assessed stays whole)',
        eqStats.assessed === '$1,931,000' && eqStats.remaining === '$1,280,775.00' && eqStats.equity === '$650,225.00',
        JSON.stringify(eqStats));
      await page.goto(`http://ff.local/#property/${S.eqBarePid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1800);
      const eqBare = await page.evaluate(() => ({
        assessed: document.querySelector('#detailAssessedValue').textContent,
        equity: document.querySelector('#detailCurrentEquity').textContent,
      }));
      H.check('a property without an assessed value shows — for Current equity',
        eqBare.assessed === '—' && eqBare.equity === '—', JSON.stringify(eqBare));
      // The overview card: left of Total outstanding principal,
      // showing the portfolio total equity from the API.
      const pfNow = (await H.req('GET', '/api/properties/portfolio')).data;
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(2500);
      const eqCard = await page.evaluate(() => {
        const eq = document.querySelector('#pfEquity');
        const out = document.querySelector('#pfOutstanding');
        const er = eq ? eq.getBoundingClientRect() : null;
        const orr = out ? out.getBoundingClientRect() : null;
        return {
          text: eq ? eq.textContent : null,
          leftOf: !!(er && orr && er.left < orr.left),
          notes: document.querySelector('#pfNotes').textContent,
        };
      });
      const fmtTotal = Number(pfNow.totals.equity).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      H.check('overview: the Total equity card sits left of Total outstanding principal and shows the portfolio total',
        eqCard.leftOf && eqCard.text === fmtTotal,
        JSON.stringify({ card: eqCard.text, want: fmtTotal, leftOf: eqCard.leftOf }));
      H.check('overview footnote notes the properties Total equity excludes (no assessed value)',
        eqCard.notes.includes('Total equity excludes'), eqCard.notes.slice(0, 200));
      // Properties head row: the title and the + Add property
      // button align with the Portfolio panel's content edges
      // (panel border 1px + padding 16px = a 17px inset), the
      // button gets the head's set 16px padding of air above it
      // instead of sitting squeezed against the subnav, and the
      // row leaves the same 16px below it before the Portfolio
      // panel instead of sitting flush on the panel.
      const measureHeadGeom = () => page.evaluate(() => {
        const head = document.querySelector('#section-properties .section-head');
        const title = head.querySelector('h2');
        const btn = document.querySelector('#addPropertyBtn');
        const panel = document.querySelector('#portfolioBlock');
        const hr = head.getBoundingClientRect();
        const tr = title.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        return {
          titleLeftDelta: Math.abs(tr.left - (pr.left + 17)),
          btnRightDelta: Math.abs(br.right - (pr.right - 17)),
          btnTopGap: br.top - hr.top,
          btnPanelGap: pr.top - br.bottom,
        };
      });
      const headGeom = await measureHeadGeom();
      H.check('properties head: title left edge aligns with the Portfolio panel content left edge',
        headGeom.titleLeftDelta <= 3, JSON.stringify(headGeom));
      H.check('properties head: Add property button right edge aligns with the panel content right edge',
        headGeom.btnRightDelta <= 3, JSON.stringify(headGeom));
      H.check('properties head: the button has the set 16px padding of space above it',
        headGeom.btnTopGap > 0 && Math.abs(headGeom.btnTopGap - 16) <= 3, JSON.stringify(headGeom));
      H.check('properties head: the button leaves the set 16px gap above the Portfolio panel (not flush)',
        Math.abs(headGeom.btnPanelGap - 16) <= 3, JSON.stringify(headGeom));
      // Same geometry at ~975 CSS px wide (close to the user's
      // window): the insets and gaps are padding-driven, so they
      // must hold at desktop width too, not just the test viewport.
      await page.setViewport({ width: 975, height: 800 });
      await wait(200);
      const headGeomWide = await measureHeadGeom();
      await page.setViewport({ width: 800, height: 600 });
      await wait(200);
      H.check('properties head @975px: title/button still align with the panel content edges',
        headGeomWide.titleLeftDelta <= 3 && headGeomWide.btnRightDelta <= 3, JSON.stringify(headGeomWide));
      H.check('properties head @975px: 16px above the button and 16px between the button and the panel',
        Math.abs(headGeomWide.btnTopGap - 16) <= 3 && Math.abs(headGeomWide.btnPanelGap - 16) <= 3,
        JSON.stringify(headGeomWide));

      // ------------------------------------------------- save sweep --
      // The general rule: ANY field, once saved, must re-derive
      // every figure it governs — nothing may be "stored while the
      // plan still runs on the old value". Regression target (the
      // user's Nash Drive report): Term 1 saved with an opening of
      // 500,000 derived $2,666.87; editing the opening to 600,000
      // updated OPENING PRINCIPAL in the modal head but CURRENT
      // MONTHLY PAYMENT stayed $2,666.87 and CURRENT PRINCIPAL
      // stayed on the 500k trajectory, because the term save wrote
      // the term row only while the projection runs off the
      // property balance anchor the pair is folded into. The sweep
      // walks one property through every save path and asserts the
      // governed figures follow — in both directions (what must
      // change changes; what must not change, e.g. the payment
      // across a lump sum, does not).
      const sweepDialog = (d) => d.accept();
      page.on('dialog', sweepDialog);
      const sweepSet = (sel, val) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [sel, val]);
      const sweepMeta = () => page.evaluate(() => ({
        opening: document.querySelector('#metaOpeningPrincipal').textContent,
        payment: document.querySelector('#metaCurrentPayment').textContent,
        principal: document.querySelector('#metaCurrentPrincipal').textContent,
        lender: document.querySelector('#metaCurrentLender').textContent,
      }));
      const sweepNum = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };
      const sweepFmt = (n) => Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      let sweepPid = null;
      const sweepApi = async () => {
        const p = (await H.req('GET', `/api/properties/${sweepPid}`)).data;
        const a = (await H.req('GET', `/api/properties/${sweepPid}/amortization`)).data;
        return { p, a };
      };
      const sweepUntilMeta = async (fn) => {
        let m = null;
        for (let i = 0; i < 32; i++) { m = await sweepMeta(); if (fn(m)) break; await wait(250); }
        return m;
      };
      const sweepSaveTerm = async () => {
        await page.evaluate(() => document.querySelector('[data-save-term]').click());
        await wait(1700);
      };
      // Setup, the Nash shape: no principal at creation; Term 1
      // filled in from the modal (CIBC, 2025-05-20, 60 months,
      // 25y amortization, monthly on the 20th, opening 500,000),
      // then its segment via the API (variable Prime − 0.85,
      // monthly compounding, monthly accrual, locked 2025-05-20 —
      // the stub history prices that lock at prime 4.95 → 4.10%).
      r = await H.req('POST', '/api/properties', { address: '1 Save Sweep Close, Victoria, BC', purchase_date: '2025-05-20' });
      sweepPid = r.data.id;
      await page.goto(`http://ff.local/#property/${sweepPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await sweepSet('[data-term-form] [name=lender]', 'CIBC');
      await sweepSet('[data-term-form] [name=start_date]', '2025-05-20');
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('500000');
      await sweepSet('[data-term-form] [name=term_months]', '60');
      await sweepSet('[data-term-form] [name=amortization_years]', '25');
      await sweepSet('[data-term-form] [name=payment_day]', '20');
      await sweepSaveTerm();
      {
        const { p } = await sweepApi();
        await H.req('POST', `/api/properties/${sweepPid}/rates`, {
          term_id: p.terms[0].id, start_date: '2025-05-20', rate_type: 'variable', rate_mode: 'prime_spread',
          spread: -0.85, compounding: 'monthly', accrual: 'monthly', locked_on: '2025-05-20',
        });
      }
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      const exp500 = engineDerive(500000, 4.10, 25, 'monthly');
      const exp600 = engineDerive(600000, 4.10, 25, 'monthly');
      H.check('sweep fixture prices as the user reported (500k @ 4.10% monthly / 25y = 2,666.87; 600k = 3,200.24)',
        exp500 === 2666.87 && exp600 === 3200.24, JSON.stringify({ exp500, exp600 }));
      let sweepState = await sweepApi();
      let sweepM = await sweepMeta();
      H.check('sweep: the 500k save derives the modal head (opening 500,000.00, payment 2,666.87, current principal on the 500k trajectory)',
        sweepM.opening === '$500,000.00' && sweepNum(sweepM.payment) === exp500
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ m: sweepM, remaining: sweepState.p.remainingBalance }));
      const heroSync = await page.evaluate(() => ({
        remaining: document.querySelector('#detailRemainingBalance').textContent,
        est: document.querySelector('#estPaymentValue').textContent,
      }));
      H.check('sweep: the detail hero agrees with the modal head after the 500k save',
        heroSync.remaining === sweepM.principal && heroSync.est.includes('2,666.87'), JSON.stringify(heroSync));
      const remaining500 = sweepState.p.remainingBalance;

      // THE reported edit: opening 500,000 -> 600,000.
      await focusField('[data-term-form] [name=opening_balance]');
      await page.keyboard.type('600000');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      H.check('sweep: editing the opening to 600,000 re-derives the payment (3,200.24, exact)',
        sweepNum(sweepM.payment) === exp600 && sweepM.opening === '$600,000.00',
        JSON.stringify({ payment: sweepM.payment, opening: sweepM.opening }));
      H.check('sweep: the anchor itself moved to the edited pair (600,000 @ 2025-05-20) and Current Principal rides the new trajectory',
        sweepState.p.mortgage_balance === 600000 && sweepState.p.mortgage_balance_date === '2025-05-20'
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005
          && sweepState.p.remainingBalance !== remaining500,
        JSON.stringify({ anchor: sweepState.p.mortgage_balance, remaining: sweepState.p.remainingBalance, was: remaining500 }));
      const remaining600 = sweepState.p.remainingBalance;

      // Lender: a display fact — it changes where it shows and
      // moves nothing derived.
      await sweepSet('[data-term-form] [name=lender]', 'TD');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: a lender edit renames the current lender and leaves the derived figures untouched',
        sweepM.lender === 'TD' && sweepState.p.terms[0].lender === 'TD'
          && sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ lender: sweepM.lender, payment: sweepM.payment }));

      // Principal as of (the term's start): a contract fact —
      // the head line follows it, but the balance anchor is its
      // own fact and does NOT move with the term start (it
      // re-seats, and the projection is unchanged by the move).
      await sweepSet('[data-term-form] [name=start_date]', '2025-06-20');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      const headMoved = await page.evaluate(() => document.querySelector('.term-head').textContent);
      H.check('sweep: moving the term start moves the head line and leaves the anchor and the plan exactly as they were',
        headMoved.includes('2025-06-20 → 2030-06-19')
          && sweepState.p.mortgage_balance === 600000 && sweepState.p.mortgage_balance_date === '2025-05-20'
          && sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ head: headMoved.replace(/\s+/g, ' ').slice(0, 120), bd: sweepState.p.mortgage_balance_date, remaining: sweepState.p.remainingBalance }));
      await sweepSet('[data-term-form] [name=start_date]', '2025-05-20');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      const headBack = await page.evaluate(() => document.querySelector('.term-head').textContent);
      H.check('sweep: moving the term start back restores the head line, the plan never having moved',
        headBack.includes('2025-05-20 → 2030-05-19')
          && sweepState.p.mortgage_balance_date === '2025-05-20' && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ bd: sweepState.p.mortgage_balance_date, remaining: sweepState.p.remainingBalance }));
      // A partial API save that never submits the pair must not
      // move the anchor (the write-through is pair-scoped).
      {
        const termId = sweepState.p.terms[0].id;
        await H.req('PUT', `/api/properties/${sweepPid}/terms/${termId}`, { lender: 'CIBC' });
        const after = (await H.req('GET', `/api/properties/${sweepPid}`)).data;
        H.check('sweep: a pair-less term save (lender only) leaves the anchor exactly where it was',
          after.mortgage_balance === 600000 && after.mortgage_balance_date === '2025-05-20',
          JSON.stringify({ b: after.mortgage_balance, bd: after.mortgage_balance_date }));
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
        await wait(1500);
        await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
        await wait(500);
      }

      // Term length: governs the term's end date (its display
      // surface), not the payment (the amortization does that).
      await sweepSet('[data-term-form] [name=term_months]', '36');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      const head36 = await page.evaluate(() => document.querySelector('.term-head').textContent);
      H.check('sweep: term length moves the term end date and leaves the payment alone',
        head36.includes('2028-05-19') && sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ head: head36.replace(/\s+/g, ' ').slice(0, 120), payment: sweepM.payment }));
      await sweepSet('[data-term-form] [name=term_months]', '60');
      await sweepSaveTerm();
      const head60 = await page.evaluate(() => document.querySelector('.term-head').textContent);
      H.check('sweep: restoring the term length restores the end date',
        head60.includes('2030-05-19'), head60.replace(/\s+/g, ' ').slice(0, 120));

      // Amortization: the payment's own input — down-payment
      // figure must follow it out and back.
      const expAmort30 = engineDerive(600000, 4.10, 30, 'monthly');
      await sweepSet('[data-term-form] [name=amortization_years]', '30');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expAmort30);
      H.check('sweep: lengthening the amortization re-derives the payment (and the current principal follows the slower trajectory)',
        sweepNum(sweepM.payment) === expAmort30 && expAmort30 !== exp600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expAmort30 }));
      const remainingAmort30 = sweepState.p.remainingBalance;
      await sweepSet('[data-term-form] [name=amortization_years]', '25');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      H.check('sweep: restoring the amortization restores the payment and the trajectory',
        sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance }));

      // Repayment method: equal principal re-anchors the plan —
      // the first (highest) payment and a faster paydown.
      await sweepSet('[data-term-form] [name=repayment_method]', 'equal_principal');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => Math.abs(sweepNum(m.payment) - sweepState.p.paymentUsed) < 0.005);
      H.check('sweep: equal principal re-derives the payment (the term’s first month) and pays down faster',
        Math.abs(sweepNum(sweepM.payment) - sweepState.p.paymentUsed) < 0.005
          && sweepNum(sweepM.payment) !== exp600
          && sweepState.p.remainingBalance < remaining600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, used: sweepState.p.paymentUsed, remaining: sweepState.p.remainingBalance }));
      await sweepSet('[data-term-form] [name=repayment_method]', 'equal_payment');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      H.check('sweep: restoring equal payment restores the payment and the trajectory',
        sweepState.p.remainingBalance === remaining600 && sweepState.p.paymentUsed === exp600,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, used: sweepState.p.paymentUsed }));

      // Payment day: under a monthly frequency with monthly
      // accrual it governs no figure (it anchors the day-stepped
      // frequencies and daily-accrual period boundaries) — the
      // save must persist it and disturb nothing.
      await sweepSet('[data-term-form] [name=payment_day]', '15');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: a payment-day edit persists and leaves the monthly plan untouched',
        sweepState.p.terms[0].payment_day === 15 && sweepNum(sweepM.payment) === exp600
          && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ day: sweepState.p.terms[0].payment_day, payment: sweepM.payment }));

      // Payment frequency: the cadence itself. The engine derives
      // the monthly figure and splits it into per-period amounts,
      // so the monthly-equivalent headline genuinely stands —
      // what re-derives is the trajectory (weekly payments land
      // sooner, so the balance runs lower), and returning to
      // monthly must restore it exactly.
      await sweepSet('[data-term-form] [name=payment_frequency]', 'weekly');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => Math.abs(sweepNum(m.payment) - sweepState.p.paymentUsed) < 0.005);
      H.check('sweep: switching to weekly re-derives the trajectory (the monthly-equivalent figure stands, the balance runs lower)',
        sweepState.p.terms[0].payment_frequency === 'weekly'
          && Math.abs(sweepNum(sweepM.payment) - sweepState.p.paymentUsed) < 0.005
          && sweepState.p.remainingBalance !== remaining600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, used: sweepState.p.paymentUsed, remaining: sweepState.p.remainingBalance }));
      await sweepSet('[data-term-form] [name=payment_frequency]', 'monthly');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      H.check('sweep: switching back to monthly restores the payment and the trajectory',
        sweepNum(sweepM.payment) === exp600 && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance }));

      // Payment override: a term-form fact entered through the
      // payment row — set it and every surface runs on it, with
      // the derived figure struck through beside it; clearing it
      // (Reset puts the derived figure back in the box) restores
      // the derived plan.
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(300);
      await focusField('[data-pay-edit-input]');
      await page.keyboard.type('3500');
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: a payment override runs the plan (used 3,500.00, derived 3,200.24 struck through)',
        sweepState.p.paymentOverridden === true && sweepState.p.paymentUsed === 3500
          && sweepM.payment.includes('$3,500.00') && sweepM.payment.includes('$3,200.24'),
        JSON.stringify({ m: sweepM.payment, used: sweepState.p.paymentUsed }));
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(300);
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-reset]').click());
      await wait(200);
      await sweepSaveTerm();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === exp600);
      H.check('sweep: clearing the override restores the derived payment everywhere',
        sweepState.p.paymentOverridden === false && sweepNum(sweepM.payment) === exp600
          && sweepState.p.remainingBalance === remaining600,
        JSON.stringify({ m: sweepM.payment, overridden: sweepState.p.paymentOverridden }));

      // Segments, edited through the segment form. The term's one
      // segment is the sweep's pricing engine: spread, then
      // compounding, then the pricing lock, then accrual.
      const sweepSegId = sweepState.p.segments[0].id;
      const sweepEditSeg = async () => {
        await page.evaluate((id) => document.querySelector(`button[data-edit-seg="${id}"]`).click(), sweepSegId);
        await wait(500);
      };
      const sweepSaveSeg = async () => {
        await page.evaluate(() => document.querySelector('[data-seg-form] [data-seg-submit]').click());
        await wait(1700);
      };
      const expSpread = engineDerive(600000, 4.20, 25, 'monthly');
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=spread]', '-0.75');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expSpread);
      H.check('sweep: a spread edit re-prices the derivation (Prime − 0.75 locked at 4.95 → 4.20%)',
        sweepNum(sweepM.payment) === expSpread && expSpread !== exp600
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expSpread }));
      const expSemi = engineDerive(600000, 4.20, 25, 'semi_annual');
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=compounding]', 'semi_annual');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expSemi);
      H.check('sweep: a compounding edit re-derives the payment in the new convention',
        sweepNum(sweepM.payment) === expSemi && expSemi !== expSpread
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expSemi }));
      const expLock2 = engineDerive(600000, 3.70, 25, 'monthly');
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=compounding]', 'monthly');
      await sweepSet('[data-seg-form] [name=locked_on]', '2025-12-01');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepUntilMeta((m) => sweepNum(m.payment) === expLock2);
      H.check('sweep: moving the pricing lock re-derives at the locked date’s prime (2025-12-01 → 4.45 − 0.75 = 3.70%)',
        sweepNum(sweepM.payment) === expLock2
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, want: expLock2 }));
      const remainingSegBase = sweepState.p.remainingBalance;
      await sweepEditSeg();
      await sweepSet('[data-seg-form] [name=accrual]', 'daily');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: an accrual edit leaves the derived payment alone and moves the trajectory (daily interest)',
        sweepNum(sweepM.payment) === expLock2 && sweepState.p.remainingBalance !== remainingSegBase
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance, was: remainingSegBase }));
      const remainingDaily = sweepState.p.remainingBalance;
      // A second segment landing mid-term recasts the plan from
      // its start: the current principal moves and the schedule
      // reprices from that month, while the anchor-time payment
      // (before the segment starts) is genuinely not its to move.
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(500);
      // The add form reopens with the last edit's values still in
      // it (drafts ride across the reload by design), so EVERY
      // field of the new segment is set explicitly — otherwise
      // the "new" fixed segment would silently inherit the
      // variable prime-spread values from the edit before it.
      await sweepSet('[data-seg-form] [name=start_date]', '2026-01-01');
      await sweepSet('[data-seg-form] [name=rate_type]', 'fixed');
      await sweepSet('[data-seg-form] [name=annual_rate]', '5');
      await sweepSet('[data-seg-form] [name=compounding]', 'monthly');
      await sweepSet('[data-seg-form] [name=accrual]', 'monthly');
      await sweepSaveSeg();
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      const rowJun25 = sweepState.a.series.find((x) => x.month === '2025-06');
      const rowJun26 = sweepState.a.series.find((x) => x.month === '2026-06');
      H.check('sweep: a mid-term segment recasts the schedule from its start and moves the current principal',
        sweepState.p.remainingBalance !== remainingDaily
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005
          && sweepNum(sweepM.payment) === expLock2
          && rowJun25 && rowJun26 && rowJun26.payment !== rowJun25.payment,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, p25: rowJun25 && rowJun25.payment, p26: rowJun26 && rowJun26.payment }));
      const sweepSeg2 = sweepState.p.segments.find((s) => s.id !== sweepSegId);
      await page.evaluate((id) => document.querySelector(`button[data-del-seg="${id}"]`).click(), sweepSeg2.id);
      await wait(1700);
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: deleting the segment restores the single-segment trajectory exactly',
        sweepState.p.remainingBalance === remainingDaily && sweepNum(sweepM.payment) === expLock2,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, was: remainingDaily }));

      // Lump sums: the payment must NOT move (the user's settled
      // rule) — the balance and the payoff do.
      const lumpBefore = await sweepApi();
      await page.evaluate(() => document.querySelector('[data-toggle-lump]').click());
      await wait(400);
      await sweepSet('[data-lump-form] [name=date]', '2026-01-20');
      await focusField('[data-lump-form] [name=amount]');
      await page.keyboard.type('10000');
      await page.evaluate(() => document.querySelector('[data-lump-form] [type=submit]').click());
      await wait(1700);
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: a lump sum leaves the payment unchanged and pulls the balance and payoff in',
        sweepNum(sweepM.payment) === expLock2
          && sweepState.p.remainingBalance < lumpBefore.p.remainingBalance - 9000
          && Math.abs(sweepNum(sweepM.principal) - sweepState.p.remainingBalance) < 0.005
          && sweepState.a.payoffMonth <= lumpBefore.a.payoffMonth,
        JSON.stringify({ payment: sweepM.payment, remaining: sweepState.p.remainingBalance, was: lumpBefore.p.remainingBalance, payoff: sweepState.a.payoffMonth, wasPayoff: lumpBefore.a.payoffMonth }));
      const sweepLumpId = sweepState.p.lumpSums[0].id;
      await page.evaluate((id) => document.querySelector(`[data-del-lump="${id}"]`).click(), sweepLumpId);
      await wait(1700);
      sweepState = await sweepApi();
      sweepM = await sweepMeta();
      H.check('sweep: deleting the lump sum restores the balance exactly, payment still unchanged',
        sweepState.p.remainingBalance === lumpBefore.p.remainingBalance && sweepNum(sweepM.payment) === expLock2,
        JSON.stringify({ remaining: sweepState.p.remainingBalance, was: lumpBefore.p.remainingBalance }));
      page.off('dialog', sweepDialog);

      // The overview follows the same saves (the list reloads
      // dirty after any of them): the sweep property's card shows
      // the final remaining balance and payment.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(2500);
      const sweepCard = await page.evaluate((addr) => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes(addr));
        return card ? card.textContent.replace(/\s+/g, ' ') : null;
      }, 'Save Sweep Close');
      H.check('sweep: the overview card shows the final derived figures for the swept property',
        !!sweepCard && sweepCard.includes(sweepFmt(sweepState.p.remainingBalance))
          && sweepCard.includes(sweepFmt(sweepState.p.paymentUsed)),
        JSON.stringify({ card: sweepCard && sweepCard.slice(0, 200), remaining: sweepFmt(sweepState.p.remainingBalance), payment: sweepFmt(sweepState.p.paymentUsed) }));

      // Assessed-history window: the range is a start/end month
      // pair (the default 1-year preset fills Dec 2025-Nov 2026).
      // A property with 8 years on record (2019-2026) draws the 1
      // whose January falls in the pair (2026); All widens it
      // to every year, and the trend summary is calculated over
      // the same range the chart shows.
      r = await H.req('POST', '/api/properties', { address: '977 Window Test Way, Victoria, BC', purchase_date: '2020-01-15', mortgage_balance: 500000 });
      const winPid = r.data.id;
      for (let y = 2019; y <= 2026; y++) {
        await H.req('POST', `/api/properties/${winPid}/value-history`, { year: y, value: 1000000 + (y - 2019) * 50000 });
      }
      await page.goto(`http://ff.local/#property/${winPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const assessedYears = () => page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Assessed value');
        return ds ? ds.data.map((p) => p.x) : null;
      });
      const winDefault = await assessedYears();
      H.check('detail chart A defaults to the most recent 1 assessment year (2026)',
        JSON.stringify(winDefault) === JSON.stringify([2026]), JSON.stringify(winDefault));
      const sumDefault = await page.evaluate(() => document.querySelector('#trendSummary').textContent);
      H.check('trend summary with a single-year default window shows the single-point guidance, not a Change figure',
        sumDefault.includes('Only the 2026 point falls in the selected chart range') && !sumDefault.includes('Change 2022'), sumDefault);
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      const winAll = await assessedYears();
      H.check('range All widens the assessed line to all 8 years (2019-2026)',
        JSON.stringify(winAll) === JSON.stringify([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]), JSON.stringify(winAll));
      const sumAll = await page.evaluate(() => document.querySelector('#trendSummary').textContent);
      H.check('trend summary follows the widened window', sumAll.includes('Change 2019 → 2026'), sumAll);
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="60"]').click());
      await wait(600);
      const winBack = await assessedYears();
      H.check('switching back to 5 years restores the 2022-2026 window',
        JSON.stringify(winBack) === JSON.stringify([2022, 2023, 2024, 2025, 2026]), JSON.stringify(winBack));

      // Axis bounds: the x axis IS the picked start/end month pair
      // — from the first day of the start month to the end of the
      // end month — never the chart library's auto-fit (which
      // unioned the history with the projection and rounded outward
      // into decades of empty span). The presets only FILL the
      // pair: a look-back preset fills end = the current month.
      const rangePair = () => page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
      }));
      const ymDecA = (s) => { const [y, m] = s.split('-').map(Number); return y + (m - 1) / 12; };
      const curMonthStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
      const addMonthsStr = (ym, n) => {
        const [y, m] = ym.split('-').map(Number);
        const t = y * 12 + (m - 1) + n;
        return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
      };
      const axisA = () => page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        const xs = c.data.datasets.flatMap((d) => d.data.map((p) => p.x));
        return {
          min: c.scales.x.min, max: c.scales.x.max,
          ticks: c.scales.x.ticks.map((t) => t.label),
          dataMin: Math.min(...xs), dataMax: Math.max(...xs),
        };
      });
      // "Today" on the axis scale, computed in the page (same clock
      // the app uses): year + month/12 + day fraction within the month.
      const todayDec = () => page.evaluate(() => {
        const d = new Date();
        const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        return d.getFullYear() + d.getMonth() / 12 + (d.getDate() - 1) / (dim * 12);
      });
      let ax = await axisA();
      let rp = await rangePair();
      H.check('chart A axis with history only is the picked month pair (5-year preset fills it, ending at the current month)',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -59)
          && Math.abs(ax.min - ymDecA(rp.start)) < 0.001
          && Math.abs(ax.max - (ymDecA(rp.end) + 1 / 12)) < 0.001,
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max } }));

      // Give the fixture a rate plan + amortization on a known
      // balance date, reload, and the axis must follow each selected
      // range: every preset fills its month pair and the projection
      // clips to it; All -> the exact data extent, no padded
      // decades either side.
      await H.req('PUT', `/api/properties/${winPid}`, { mortgage_balance_date: '2025-01-15', amortization_years: 25 });
      await H.req('POST', `/api/properties/${winPid}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      // Reload resets the active preset to the 1-year default; the
      // 5-year axis pins below need the 60-month preset re-picked.
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="60"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      H.check('chart A 5-year axis is the filled month pair, with month ticks',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -59)
          && Math.abs(ax.min - ymDecA(rp.start)) < 0.001
          && Math.abs(ax.max - (ymDecA(rp.end) + 1 / 12)) < 0.001
          && ax.ticks.some((t) => /[A-Z][a-z]{2} \d{4}/.test(t)),
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max, ticks: ax.ticks } }));
      const outXs = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Outstanding principal');
        return ds ? ds.data.map((p) => p.x) : null;
      });
      H.check('chart A projection is clipped to the picked pair (in-range months drawn, the current month last)',
        Array.isArray(outXs) && outXs.length > 12
          && outXs.every((x) => x >= ymDecA(rp.start) - 0.001 && x < ymDecA(rp.end) + 1 / 12 + 0.001)
          && Math.abs(outXs[outXs.length - 1] - ymDecA(rp.end)) < 0.001,
        JSON.stringify(outXs && { n: outXs.length, last: outXs[outXs.length - 1] }));
      // Current equity line: at every outstanding point it equals
      // the assessed line's own interpolated value (this fixture's
      // history is known exactly: 2019-2026, +$50k a year) minus
      // the outstanding balance, and at the latest point it equals
      // the panel's Current equity figure to the cent.
      const eqHero = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const get = (k) => c.data.datasets.find((d) => d.key === k);
        const eq = get('equity'); const out = get('outstanding');
        return {
          has: !!eq, label: eq ? eq.label : null,
          eqPts: eq ? eq.data : null, outPts: out ? out.data : null,
          panel: document.querySelector('#detailCurrentEquity').textContent,
        };
      });
      const assessedAtH = (x) => {
        const ap = [];
        for (let y = 2019; y <= 2026; y++) ap.push({ x: y, y: 1000000 + (y - 2019) * 50000 });
        if (x < ap[0].x) return null;
        for (let i = 0; i < ap.length; i++) {
          if (x <= ap[i].x) {
            if (i === 0) return ap[0].y;
            const a = ap[i - 1]; const b = ap[i];
            return a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
          }
        }
        return ap[ap.length - 1].y;
      };
      let eqHeroOk = !!eqHero.has && eqHero.label === 'Current equity'
        && Array.isArray(eqHero.eqPts) && eqHero.eqPts.length > 0
        && eqHero.eqPts.length === eqHero.outPts.length;
      if (eqHeroOk) {
        for (let i = 0; i < eqHero.eqPts.length; i++) {
          const p = eqHero.eqPts[i]; const o = eqHero.outPts[i];
          const a = assessedAtH(p.x);
          if (Math.abs(p.x - o.x) > 1e-9 || a === null || Math.abs(p.y - (a - o.y)) > 0.011) { eqHeroOk = false; break; }
        }
      }
      const eqHeroLast = eqHero.eqPts ? eqHero.eqPts[eqHero.eqPts.length - 1] : null;
      const panelEqVal = Number(String(eqHero.panel).replace(/[^0-9.\-]/g, ''));
      H.check('hero chart carries a Current equity line (assessed line minus outstanding at every point; latest point equals the panel figure)',
        eqHeroOk && !!eqHeroLast && Math.abs(eqHeroLast.y - panelEqVal) < 0.011,
        JSON.stringify({ ok: eqHeroOk, last: eqHeroLast, panel: eqHero.panel }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      H.check('chart A 2-year axis spans exactly the filled 24 months, with monthly ticks',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -23)
          && Math.abs(ax.max - ax.min - 2) < 0.02 && ax.ticks.length >= 20,
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max, nTicks: ax.ticks.length } }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      const yrs1 = await assessedYears();
      H.check('chart A 1-year axis spans the filled 12 months and shows only the 2026 point',
        !!ax && rp.end === curMonthStr() && rp.start === addMonthsStr(rp.end, -11)
          && Math.abs(ax.max - ax.min - 1) < 0.02
          && JSON.stringify(yrs1) === JSON.stringify([2026]),
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max }, yrs1 }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      ax = await axisA();
      rp = await rangePair();
      H.check('chart A All axis is the exact data extent (2019 to the end of the last projected month)',
        !!ax && ax.min === 2019 && rp.start === '2019-01'
          && Math.abs(ax.max - (ax.dataMax + 1 / 12)) < 0.001 && ax.max < 2060,
        JSON.stringify({ rp, ax: ax && { min: ax.min, max: ax.max, dataMax: ax.dataMax } }));

      // ---- Merged chart: the payment-split bars live in chart A now ----
      // One canvas on the detail page, its own range controls inside
      // the chart's panel, the y axis anchored at 0, and the bars
      // governed by the same month pair as the lines: monthly
      // inside a range, summed into yearly bars on the All span.
      const winAmort = (await H.req('GET', `/api/properties/${winPid}/amortization`)).data;
      const ymDec = (s) => { const [y, m] = s.split('-').map(Number); return y + (m - 1) / 12; };
      const barInfo = () => page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        const ints = c.data.datasets.find((d) => d.label === 'Interest portion');
        const prins = c.data.datasets.find((d) => d.label === 'Principal portion');
        return {
          // Scoped to the projection panel: the costs panel
          // further down the page has charts of its own.
          canvasCount: document.querySelectorAll('#projectionPanel canvas').length,
          hasMonthlyCanvas: !!document.querySelector('#monthlyChart'),
          labels: c.data.datasets.map((d) => d.label),
          yMin: c.scales.y.min, yMax: c.scales.y.max,
          dataMaxY: Math.max(...c.data.datasets.flatMap((d) => d.data.map((p) => p.y))),
          bars: ints && prins ? {
            stack: [ints.stack, prins.stack], types: [ints.type, prins.type],
            xs: ints.data.map((p) => p.x),
            sums: ints.data.map((p, i) => p.y + prins.data[i].y),
          } : null,
          axisOf: Object.fromEntries(c.data.datasets.map((d) => [d.label, d.yAxisID || 'y'])),
          y1Min: c.scales.y1 ? c.scales.y1.min : null,
          y1Max: c.scales.y1 ? c.scales.y1.max : null,
          lineMaxY: Math.max(...c.data.datasets.filter((d) => d.type === 'line').flatMap((d) => d.data.map((p) => p.y))),
        };
      });
      const samePanel = await page.evaluate(() => {
        const rb = document.querySelector('#rangeBtns');
        const cc = document.querySelector('#combinedChart');
        return !!rb && !!cc && rb.closest('.panel') === cc.closest('.panel');
      });
      H.check('the merged chart panel carries its own range controls', samePanel === true);
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="60"]').click());
      await wait(600);
      const rowsIn = async () => {
        const pair = await rangePair();
        return winAmort.series.filter((r) => r.month >= pair.start && r.month <= pair.end);
      };
      const exp60 = await rowsIn();
      let bi = await barInfo();
      H.check('the projection is exactly one chart canvas (the merged chart)',
        !!bi && bi.canvasCount === 1 && bi.hasMonthlyCanvas === false,
        JSON.stringify(bi && { n: bi.canvasCount, monthly: bi.hasMonthlyCanvas }));
      H.check('merged chart draws all four datasets (2 lines + 2 bar portions)',
        !!bi && ['Assessed value', 'Outstanding principal', 'Interest portion', 'Principal portion']
          .every((l) => bi.labels.includes(l)), JSON.stringify(bi && bi.labels));
      H.check('merged chart y axis starts at 0 with modest headroom above the data',
        !!bi && bi.yMin === 0 && bi.yMax > bi.dataMaxY && bi.yMax < bi.dataMaxY * 1.2,
        JSON.stringify(bi && { yMin: bi.yMin, yMax: bi.yMax, dataMaxY: bi.dataMaxY }));
      H.check('merged chart bars are monthly in the 5-year window and match the API series',
        !!bi && !!bi.bars && bi.bars.types[0] === 'bar' && bi.bars.stack[0] === 'payment'
          && bi.bars.xs.length === exp60.length && exp60.length > 12
          && bi.bars.sums.slice(0, 6).every((s, k) => Math.abs(s - exp60[k].payment) < 0.02),
        JSON.stringify(bi && bi.bars && { n: bi.bars.xs.length, exp: exp60.length }));
      const maxPay60 = Math.max(...exp60.map((r) => r.payment));
      H.check('dual axis: lines ride the left axis, payment bars the right axis — right max covers the largest payment, left max the largest balance',
        !!bi && bi.axisOf['Assessed value'] === 'y' && bi.axisOf['Outstanding principal'] === 'y'
          && bi.axisOf['Interest portion'] === 'y1' && bi.axisOf['Principal portion'] === 'y1'
          && bi.y1Min === 0 && bi.y1Max >= maxPay60 && bi.yMax >= bi.lineMaxY,
        JSON.stringify(bi && { axisOf: bi.axisOf, y1Max: bi.y1Max, maxPay60, yMax: bi.yMax, lineMaxY: bi.lineMaxY }));
      const stackGeo = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        c.update('none');
        const mi = c.data.datasets.findIndex((d) => d.label === 'Interest portion');
        const mp = c.data.datasets.findIndex((d) => d.label === 'Principal portion');
        const ei = c.getDatasetMeta(mi).data[3];
        const ep = c.getDatasetMeta(mp).data[3];
        if (!ei || !ep) return null;
        return { intBase: ei.base, intTop: ei.y, prinBase: ep.base, zeroPix: c.scales.y1.getPixelForValue(0) };
      });
      H.check('merged chart bars really stack (principal sits on interest, interest on zero)',
        !!stackGeo && Math.abs(stackGeo.intBase - stackGeo.zeroPix) < 2
          && Math.abs(stackGeo.prinBase - stackGeo.intTop) < 2,
        JSON.stringify(stackGeo));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(600);
      bi = await barInfo();
      ax = await axisA();
      const exp24 = await rowsIn();
      H.check('clicking 2 years in the chart panel rescales the axis and redraws the bars to the window',
        !!ax && Math.abs(ax.max - ax.min - 2) < 0.02
          && !!bi && !!bi.bars && bi.bars.xs.length === exp24.length
          && bi.bars.xs.every((x) => x >= ax.min - 0.001 && x <= ax.max + 0.001),
        JSON.stringify({ ax: ax && { min: ax.min, max: ax.max }, bars: bi && bi.bars && bi.bars.xs.length, exp: exp24.length }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(600);
      bi = await barInfo();
      const exp12 = await rowsIn();
      H.check('clicking 1 year shrinks the bars to just that year of payments',
        !!bi && !!bi.bars && bi.bars.xs.length === exp12.length && exp12.length < exp60.length,
        JSON.stringify(bi && bi.bars && { n: bi.bars.xs.length, exp: exp12.length }));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      bi = await barInfo();
      const yearsAll = [...new Set(winAmort.series.map((r) => r.month.slice(0, 4)))];
      const totBars = bi && bi.bars ? bi.bars.sums.reduce((s, v) => s + v, 0) : 0;
      const totApi = winAmort.series.reduce((s, r) => s + r.payment, 0);
      const schedNoteGone = await page.evaluate(() => !document.querySelector('#scheduleNote'));
      H.check('All view aggregates the bars by year (one bar per projection year)',
        !!bi && !!bi.bars && bi.bars.xs.length === yearsAll.length
          && bi.bars.xs.every((x) => Number.isInteger(x))
          && Math.abs(totBars - totApi) < 1,
        JSON.stringify(bi && bi.bars && { n: bi.bars.xs.length, years: yearsAll.length, totBars, totApi }));
      H.check('no schedule-basis note remains under the chart (explanation prose removed)',
        schedNoteGone === true);

      // ---- Monthly schedule: monthly rows, year pages, one Total row ----
      // The table under the chart lists the endpoint's series months
      // inside the chart window (All here = the whole series), one
      // calendar year per page. At load it opens on today's year;
      // the All preset click above is a range change, so the page
      // has since reset to the window's first year. Its Total
      // row sums the ENTIRE range to the cent and must not move when
      // the page turns.
      const schedInfo = () => page.evaluate(() => {
        const total = document.querySelector('#scheduleTotalRow');
        return {
          months: [...document.querySelectorAll('#scheduleRows tr')].map((tr) => tr.children[0].textContent),
          year: document.querySelector('#scheduleYearSelect').value,
          totalLabel: total ? total.children[0].textContent : '',
          totalPayment: total ? Number(total.querySelector('.sum-payment').dataset.value) : null,
          totalPrincipal: total ? Number(total.querySelector('.sum-principal').dataset.value) : null,
          totalInterest: total ? Number(total.querySelector('.sum-interest').dataset.value) : null,
        };
      });
      const apiTotals = {
        payment: winAmort.series.reduce((s, r) => s + r.payment, 0),
        principal: winAmort.series.reduce((s, r) => s + r.principal, 0),
        interest: winAmort.series.reduce((s, r) => s + r.interest, 0),
      };
      const rowsOfYear = (y) => winAmort.series.filter((r) => r.month.startsWith(y));
      const allYears = [...new Set(winAmort.series.map((r) => r.month.slice(0, 4)))];
      const thisYear = String(new Date().getFullYear());
      let sc = await schedInfo();
      H.check('after the All range change the schedule sits on the window\u2019s first year page, listing exactly that year\u2019s months',
        sc.year === allYears[0] && sc.months.length === rowsOfYear(allYears[0]).length
          && sc.months.length > 0 && sc.months.every((m) => m.endsWith(allYears[0])),
        JSON.stringify({ year: sc.year, n: sc.months.length, exp: rowsOfYear(allYears[0]).length }));
      H.check('schedule Total row sums the whole range exactly (payment / principal / interest)',
        sc.totalPayment !== null
          && Math.abs(sc.totalPayment - apiTotals.payment) < 0.005
          && Math.abs(sc.totalPrincipal - apiTotals.principal) < 0.005
          && Math.abs(sc.totalInterest - apiTotals.interest) < 0.005,
        JSON.stringify({ got: [sc.totalPayment, sc.totalPrincipal, sc.totalInterest], api: apiTotals }));
      H.check('schedule Total row labels its range and the payoff month inside it',
        sc.totalLabel.includes('Total') && !!winAmort.payoffMonth
          && sc.totalLabel.includes(`Paid off ${winAmort.payoffMonth}`),
        sc.totalLabel);
      await page.evaluate((y) => {
        const s = document.querySelector('#scheduleYearSelect');
        s.value = y;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, allYears[0]);
      await wait(300);
      const scFirst = await schedInfo();
      H.check('jumping the schedule to the first year lists only that year\u2019s months',
        scFirst.year === allYears[0] && scFirst.months.length === rowsOfYear(allYears[0]).length
          && scFirst.months.every((m) => m.endsWith(allYears[0])),
        JSON.stringify({ year: scFirst.year, n: scFirst.months.length, exp: rowsOfYear(allYears[0]).length }));
      await page.evaluate(() => document.querySelector('#scheduleNextYear').click());
      await wait(300);
      const scNext = await schedInfo();
      H.check('the next-year pager steps to the following year\u2019s months',
        scNext.year === allYears[1] && scNext.months.length === rowsOfYear(allYears[1]).length
          && scNext.months.every((m) => m.endsWith(allYears[1])),
        JSON.stringify({ year: scNext.year, n: scNext.months.length, exp: rowsOfYear(allYears[1]).length }));
      H.check('the Total row does not change when the schedule page turns',
        scNext.totalPayment === sc.totalPayment && scNext.totalPrincipal === sc.totalPrincipal
          && scNext.totalInterest === sc.totalInterest && scNext.totalLabel === sc.totalLabel,
        JSON.stringify({ before: sc.totalLabel, after: scNext.totalLabel }));

      // ---- Range switch re-fetches the projection (no stale clip) ----
      // A prime-spread fixture backdated to Dec 2024. Switching the
      // range must re-request the projection from the server (which
      // re-prices at the latest prime history) rather than re-clip
      // the payload already on the page — and the recomputation must
      // not drift: March 2025's interest in the monthly table equals
      // the hand-computed value at that month's own prime (stub
      // history: Mar 2025 prime 4.95 -> rate 3.95), before and after
      // the switch alike.
      r = await H.req('POST', '/api/properties', {
        address: '321 Refetch Crescent, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
      });
      const refetchPid = r.data.id;
      await H.req('POST', `/api/properties/${refetchPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await H.req('PUT', `/api/properties/${refetchPid}`, { amortization_years: 25 });
      await page.goto(`http://ff.local/#property/${refetchPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const schedRow = (label) => page.evaluate((lbl) => {
        const tr = [...document.querySelectorAll('#scheduleRows tr')]
          .find((x) => x.children[0].textContent === lbl);
        if (!tr) return null;
        const num = (i) => Number(tr.children[i].textContent.replace(/[$,]/g, ''));
        return { payment: num(1), principal: num(2), interest: num(3), remaining: num(4) };
      }, label);
      const pickYear = (y) => page.evaluate((yy) => {
        const s = document.querySelector('#scheduleYearSelect');
        s.value = yy;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, y);
      await pickYear('2025');
      await wait(300);
      const febBefore = await schedRow('Feb 2025');
      const marBefore = await schedRow('Mar 2025');
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="24"]').click());
      await wait(1200);
      await pickYear('2025');
      await wait(300);
      const febAfter = await schedRow('Feb 2025');
      const marAfter = await schedRow('Mar 2025');
      // The table displays whole dollars, so the hand-check rounds
      // the same way (February's displayed remaining x the monthly
      // rate at March's own prime, 4.95 - 1 = 3.95%).
      const marHand = febBefore ? Math.round(febBefore.remaining * engineMonthlyRate(3.95)) : null;
      H.check('range switch re-fetches: March 2025 interest equals its own month\u2019s prime hand-check, unchanged by the switch',
        !!marBefore && !!marAfter && !!febBefore
          && Math.abs(marBefore.interest - marHand) <= 1
          && marAfter.interest === marBefore.interest
          && febAfter.remaining === febBefore.remaining,
        JSON.stringify({ marBefore, marAfter, marHand }));
      await H.req('DELETE', `/api/properties/${refetchPid}`);

      // ---- Detail range: picked start/end months drive everything ----
      // The user's real shape (his Christina Pl mortgage): $1.35M
      // at 2024-12-17, Prime - 1.00, 25-year amortization. He reads
      // the schedule Total for a span he picks BY MONTH — Jan 2025
      // to Oct 2026 in his message ("Total — Jan 2025 to Oct 2026
      // (22 months)") — and every figure in the row must come from
      // exactly those months of the series.
      r = await H.req('POST', '/api/properties', {
        address: '555 Range Picker Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
      });
      const rangePid = r.data.id;
      await H.req('POST', `/api/properties/${rangePid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await H.req('PUT', `/api/properties/${rangePid}`, { amortization_years: 25 });
      const rangeAmort = (await H.req('GET', `/api/properties/${rangePid}/amortization`)).data;
      // rangePid reuses the just-deleted refetchPid's id (SQLite
      // recycles the max rowid), so a direct hash goto to it is a
      // no-op navigation and the page would keep showing the
      // deleted property's view — detour via the root hash so
      // the hash really changes and the property loads.
      await page.goto('http://ff.local/#', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(400);
      await page.goto(`http://ff.local/#property/${rangePid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      // A fresh property load (no range change yet) still opens
      // the schedule on today's year page — the first-page reset
      // belongs to range changes only. Wait for THIS property's
      // schedule to settle first (the table can still show the
      // previous property's rows while the refetch is in flight).
      const openYear = String(new Date().getFullYear());
      const openRows = rangeAmort.series.filter((x) => x.month.startsWith(openYear) && x.month <= curMonthStr());
      await page.waitForFunction((y, n) => {
        const sel = document.querySelector('#scheduleYearSelect');
        return !!sel && sel.value === y
          && document.querySelectorAll('#scheduleRows tr').length === n;
      }, { timeout: 20000 }, openYear, openRows.length).catch(() => {});
      const scOpen = await page.evaluate(() => ({
        year: document.querySelector('#scheduleYearSelect').value,
        months: [...document.querySelectorAll('#scheduleRows tr')].map((tr) => tr.children[0].textContent),
      }));
      H.check('a freshly opened property schedule sits on today’s year page (the first-page reset is for range changes only)',
        scOpen.year === openYear && scOpen.months.length === openRows.length
          && scOpen.months.length > 0 && scOpen.months.every((m) => m.endsWith(openYear)),
        JSON.stringify({ got: scOpen, exp: openRows.length }));
      // Drive the custom month picker like a user: open the
      // field's popover, step its year to the target year, click
      // the month cell (which applies the pair and refetches).
      const pickMonthUI = (fieldSel, ym) => page.evaluate(([sel, target]) => {
        document.querySelector(sel).click();
        const ty = Number(target.slice(0, 4));
        const yearEl = document.querySelector('#monthPopYear');
        let guard = 0;
        while (Number(yearEl.textContent) !== ty && guard++ < 80) {
          const btn = ty < Number(yearEl.textContent)
            ? document.querySelector('#monthPopPrev') : document.querySelector('#monthPopNext');
          if (!btn || btn.disabled) break;
          btn.click();
        }
        const cell = document.querySelector(`#monthPopGrid button[data-ym="${target}"]`);
        if (!cell || cell.disabled) throw new Error(`month cell ${target} not pickable`);
        cell.click();
      }, [fieldSel, ym]);
      const setRange = async (start, end) => {
        await pickMonthUI('#rangeStart', start);
        await wait(1400); // the start pick applies + refetches before the end pick
        await pickMonthUI('#rangeEnd', end);
      };
      const totalInfo = () => page.evaluate(() => {
        const total = document.querySelector('#scheduleTotalRow');
        if (!total) return null;
        return {
          label: total.children[0].textContent,
          payment: Number(total.querySelector('.sum-payment').dataset.value),
          principal: Number(total.querySelector('.sum-principal').dataset.value),
          interest: Number(total.querySelector('.sum-interest').dataset.value),
          remaining: Number(total.children[4].textContent.replace(/[$,]/g, '')),
        };
      });
      const spanSums = (rows) => ({
        payment: rows.reduce((s, x) => s + x.payment, 0),
        principal: rows.reduce((s, x) => s + x.principal, 0),
        interest: rows.reduce((s, x) => s + x.interest, 0),
      });
      await setRange('2025-01', '2026-10');
      await wait(1200);
      const janOct = rangeAmort.series.filter((x) => x.month >= '2025-01' && x.month <= '2026-10');
      const janOctSums = spanSums(janOct);
      const tot1 = await totalInfo();
      H.check('picked range Jan 2025-Oct 2026: the Total row covers exactly those 22 months',
        janOct.length === 22 && !!tot1 && tot1.label.includes('Total — Jan 2025 to Oct 2026 (22 months)'),
        JSON.stringify({ n: janOct.length, label: tot1 && tot1.label }));
      H.check('picked range: Total sums and the ending balance equal the series rows inside it',
        !!tot1
          && Math.abs(tot1.payment - janOctSums.payment) < 0.005
          && Math.abs(tot1.principal - janOctSums.principal) < 0.005
          && Math.abs(tot1.interest - janOctSums.interest) < 0.005
          && Math.abs(tot1.remaining - janOct[janOct.length - 1].balance) < 0.51,
        JSON.stringify({ tot: tot1, sums: janOctSums, lastBal: janOct[janOct.length - 1].balance }));
      const barsPicked = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const ints = c ? c.data.datasets.find((d) => d.label === 'Interest portion') : null;
        return ints ? ints.data.map((p) => p.x) : null;
      });
      H.check('picked range: the chart bars are exactly the 22 picked months',
        Array.isArray(barsPicked) && barsPicked.length === 22
          && Math.abs(barsPicked[0] - ymDec('2025-01')) < 0.001
          && Math.abs(barsPicked[barsPicked.length - 1] - ymDec('2026-10')) < 0.001,
        JSON.stringify(barsPicked && { n: barsPicked.length, first: barsPicked[0], last: barsPicked[barsPicked.length - 1] }));
      const schedYearsPicked = await page.evaluate(() => [...document.querySelectorAll('#scheduleYearSelect option')].map((o) => o.value));
      H.check('picked range: the schedule pages are the years inside the range',
        JSON.stringify(schedYearsPicked) === JSON.stringify(['2025', '2026']), JSON.stringify(schedYearsPicked));
      // The VISIBLE rows follow the pick too: a range change
      // reopens the schedule on the range's first year page (the
      // old auto-page pinned today's year, so a pick that kept
      // 2026 in range left the visible rows byte-identical and
      // the table looked unresponsive — the user's report).
      const visibleRows = () => page.evaluate(() => {
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const toYM = (label) => {
          const [mon, yr] = label.trim().split(' ');
          return `${yr}-${String(MON.indexOf(mon) + 1).padStart(2, '0')}`;
        };
        return {
          months: [...document.querySelectorAll('#scheduleRows tr')].map((tr) => toYM(tr.children[0].textContent)),
          page: document.querySelector('#scheduleYearSelect').value,
          pageCount: document.querySelectorAll('#scheduleYearSelect option').length,
          prevDisabled: document.querySelector('#schedulePrevYear').disabled,
          nextDisabled: document.querySelector('#scheduleNextYear').disabled,
        };
      });
      const vis1 = await visibleRows();
      H.check('picked range: the visible schedule rows are the range first page (Jan-Dec 2025), all inside the range',
        vis1.page === '2025' && vis1.pageCount === 2 && vis1.months.length === 12
          && vis1.months[0] === '2025-01' && vis1.months[vis1.months.length - 1] === '2025-12'
          && vis1.months.every((m) => m >= '2025-01' && m <= '2026-10')
          && vis1.prevDisabled === true && vis1.nextDisabled === false,
        JSON.stringify(vis1));
      await page.evaluate(() => document.querySelector('#scheduleNextYear').click());
      await wait(300);
      const vis2 = await visibleRows();
      H.check('picked range: the second page holds the remaining rows (Jan-Oct 2026), so the pages match the row count',
        vis2.page === '2026' && vis2.months.length === 10
          && vis2.months[0] === '2026-01' && vis2.months[vis2.months.length - 1] === '2026-10'
          && vis2.nextDisabled === true,
        JSON.stringify(vis2));
      const pagerText = await page.evaluate(() => document.querySelector('#schedulePager').textContent);
      H.check('the schedule pager note (explanation prose) is gone',
        !pagerText.includes('one year per page') && !pagerText.includes('Total row covers'),
        pagerText.trim());

      // A second, narrower pick moves everything again.
      await setRange('2025-06', '2025-12');
      await wait(1200);
      const junDec = rangeAmort.series.filter((x) => x.month >= '2025-06' && x.month <= '2025-12');
      const junDecSums = spanSums(junDec);
      const tot2 = await totalInfo();
      H.check('re-picked range Jun-Dec 2025: Total label, sums and ending balance follow the new pair',
        junDec.length === 7 && !!tot2 && tot2.label.includes('Total — Jun 2025 to Dec 2025 (7 months)')
          && Math.abs(tot2.payment - junDecSums.payment) < 0.005
          && Math.abs(tot2.principal - junDecSums.principal) < 0.005
          && Math.abs(tot2.interest - junDecSums.interest) < 0.005
          && Math.abs(tot2.remaining - junDec[junDec.length - 1].balance) < 0.51,
        JSON.stringify({ tot: tot2, sums: junDecSums }));
      const vis3 = await visibleRows();
      H.check('re-picked range: the visible rows are exactly Jun-Dec 2025 on a single first page',
        vis3.page === '2025' && vis3.pageCount === 1 && vis3.months.length === 7
          && vis3.months[0] === '2025-06' && vis3.months[vis3.months.length - 1] === '2025-12',
        JSON.stringify(vis3));

      // Presets refill the pair: All = the whole data span; a
      // look-back preset ends at the current month.
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(1200);
      const rpAll = await page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
        active: (document.querySelector('#rangeBtns button.active') || {}).dataset?.months,
      }));
      H.check('All refills the pair with the whole data span',
        rpAll.start === '2024-12' && rpAll.end === rangeAmort.series[rangeAmort.series.length - 1].month
          && rpAll.active === '0',
        JSON.stringify(rpAll));
      const visAll = await visibleRows();
      const allSeriesYears = [...new Set(rangeAmort.series.map((x) => x.month.slice(0, 4)))];
      const firstYearRows = rangeAmort.series.filter((x) => x.month.startsWith(allSeriesYears[0]));
      H.check('All preset: the schedule reopens on the first page of the widened span',
        visAll.page === allSeriesYears[0] && visAll.pageCount === allSeriesYears.length
          && visAll.months.length === firstYearRows.length
          && visAll.months[0] === firstYearRows[0].month
          && visAll.months[visAll.months.length - 1] === firstYearRows[firstYearRows.length - 1].month
          && visAll.prevDisabled === true,
        JSON.stringify(visAll));
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="12"]').click());
      await wait(1200);
      const rp1y = await page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
        active: (document.querySelector('#rangeBtns button.active') || {}).dataset?.months,
      }));
      H.check('the 1-year preset refills the pair ending at the current month (12 months inclusive)',
        rp1y.end === curMonthStr() && rp1y.start === addMonthsStr(rp1y.end, -11) && rp1y.active === '12',
        JSON.stringify(rp1y));

      // A start past the end clamps the end up to the start.
      await setRange('2026-05', '2026-03');
      await wait(1200);
      const rpClamp = await page.evaluate(() => ({
        start: document.querySelector('#rangeStart').dataset.value,
        end: document.querySelector('#rangeEnd').dataset.value,
        anyActive: !!document.querySelector('#rangeBtns button.active'),
      }));
      H.check('start past end clamps the end up to the start (and picking clears the preset)',
        rpClamp.start === '2026-05' && rpClamp.end === '2026-05' && rpClamp.anyActive === false,
        JSON.stringify(rpClamp));
      const mayRow = rangeAmort.series.find((x) => x.month === '2026-05');
      const totClamp = await totalInfo();
      H.check('the clamped single-month range totals exactly that month',
        !!totClamp && !!mayRow && totClamp.label.includes('Total — May 2026 to May 2026 (1 month)')
          && Math.abs(totClamp.payment - mayRow.payment) < 0.005,
        JSON.stringify(totClamp));

      // ---- The From/To month picker UI ----
      // Button fields showing "Mon YYYY" (machine value on
      // data-value) and one shared popover: year stepper + a
      // 12-month grid, out-of-span months disabled.
      const fieldState = () => page.evaluate(() => ({
        startText: document.querySelector('#rangeStart').textContent,
        startVal: document.querySelector('#rangeStart').dataset.value,
        endText: document.querySelector('#rangeEnd').textContent,
        endVal: document.querySelector('#rangeEnd').dataset.value,
        popHidden: document.querySelector('#monthPop').classList.contains('hidden'),
        startExpanded: document.querySelector('#rangeStart').getAttribute('aria-expanded'),
        endExpanded: document.querySelector('#rangeEnd').getAttribute('aria-expanded'),
      }));
      const fs0 = await fieldState();
      H.check('From/To are button fields showing "Mon YYYY" with the month on data-value, picker closed',
        fs0.startText === 'May 2026' && fs0.startVal === '2026-05'
          && fs0.endText === 'May 2026' && fs0.endVal === '2026-05' && fs0.popHidden,
        JSON.stringify(fs0));
      await page.evaluate(() => document.querySelector('#rangeStart').click());
      await wait(250);
      const pop1 = await page.evaluate(() => ({
        hidden: document.querySelector('#monthPop').classList.contains('hidden'),
        year: document.querySelector('#monthPopYear').textContent,
        selYm: (document.querySelector('#monthPopGrid button.sel') || {}).dataset?.ym,
        expanded: document.querySelector('#rangeStart').getAttribute('aria-expanded'),
      }));
      H.check('clicking From opens the picker on the field year with its month selected',
        !pop1.hidden && pop1.year === '2026' && pop1.selYm === '2026-05' && pop1.expanded === 'true',
        JSON.stringify(pop1));
      await page.evaluate(() => document.querySelector('#monthPopNext').click());
      const yrNext = await page.evaluate(() => document.querySelector('#monthPopYear').textContent);
      await page.evaluate(() => document.querySelector('#monthPopPrev').click());
      await page.evaluate(() => document.querySelector('#monthPopPrev').click());
      await page.evaluate(() => document.querySelector('#monthPopPrev').click());
      const popMin = await page.evaluate(() => ({
        year: document.querySelector('#monthPopYear').textContent,
        prevDisabled: document.querySelector('#monthPopPrev').disabled,
        janDisabled: document.querySelector('#monthPopGrid button[data-ym="2024-01"]').disabled,
        decDisabled: document.querySelector('#monthPopGrid button[data-ym="2024-12"]').disabled,
      }));
      H.check('the year stepper steps one year at a time and stops at the span start (2024: Jan-Nov disabled, Dec pickable)',
        yrNext === '2027' && popMin.year === '2024' && popMin.prevDisabled && popMin.janDisabled && !popMin.decDisabled,
        JSON.stringify({ yrNext, popMin }));
      await page.keyboard.press('Escape');
      await wait(150);
      const escClosed = await page.evaluate(() => document.querySelector('#monthPop').classList.contains('hidden'));
      H.check('Esc closes the month picker', escClosed);
      await page.evaluate(() => document.querySelector('#rangeStart').click());
      await wait(200);
      await page.evaluate(() => document.querySelector('#rangeEnd').click());
      await wait(200);
      const retarget = await fieldState();
      H.check('one picker only: clicking To while From is open retargets the same popover',
        !retarget.popHidden && retarget.startExpanded === 'false' && retarget.endExpanded === 'true',
        JSON.stringify(retarget));
      await page.evaluate(() => document.querySelector('#projectionPanel h3').click());
      await wait(200);
      const outsideClosed = await page.evaluate(() => document.querySelector('#monthPop').classList.contains('hidden'));
      H.check('clicking outside closes the month picker', outsideClosed);
      // Scroll re-anchoring: a fixed popover must follow its field,
      // not strand over other content once the page moves.
      await page.evaluate(() => document.querySelector('#rangeStart').scrollIntoView({ block: 'center' }));
      await wait(200);
      await page.evaluate(() => document.querySelector('#rangeStart').click());
      await wait(200);
      const popRect = () => page.evaluate(() => {
        const f = document.querySelector('#rangeStart').getBoundingClientRect();
        const p = document.querySelector('#monthPop');
        const pr = p.getBoundingClientRect();
        return {
          hidden: p.classList.contains('hidden'),
          fTop: f.top, fBottom: f.bottom, fLeft: f.left,
          pTop: pr.top, pLeft: pr.left, pWidth: p.offsetWidth, vw: window.innerWidth,
        };
      });
      const popBefore = await popRect();
      await page.evaluate(() => window.scrollBy(0, 200));
      await wait(300);
      const popAfter = await popRect();
      const wantLeft = Math.max(4, Math.min(popAfter.fLeft, popAfter.vw - popAfter.pWidth - 4));
      H.check('scrolling re-anchors the open month picker to its field instead of stranding it',
        !popAfter.hidden && popBefore.fTop - popAfter.fTop > 0
        && Math.abs(popAfter.pTop - (popAfter.fBottom + 6)) <= 2
        && Math.abs(popAfter.pLeft - wantLeft) <= 2,
        JSON.stringify({ before: popBefore, after: popAfter, wantLeft }));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await wait(300);
      const popOut = await page.evaluate(() => document.querySelector('#monthPop').classList.contains('hidden'));
      H.check('scrolling the field out of view closes the month picker', popOut);
      await page.evaluate(() => window.scrollTo(0, 0));
      await wait(200);
      // A full pick through the popover moves the field value, its
      // display text, the chart bars and the Total together.
      await pickMonthUI('#rangeStart', '2025-01');
      await wait(1400);
      const fsPick = await fieldState();
      const totPick = await totalInfo();
      const barsPick = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const ints = c ? c.data.datasets.find((d) => d.label === 'Interest portion') : null;
        return ints ? ints.data.length : null;
      });
      H.check('picking a month moves data-value, display text, chart bars and the Total together',
        fsPick.startVal === '2025-01' && fsPick.startText === 'Jan 2025' && fsPick.popHidden
          && barsPick === 17
          && !!totPick && totPick.label.includes('Total — Jan 2025 to May 2026 (17 months)'),
        JSON.stringify({ fsPick, barsPick, label: totPick && totPick.label }));
      await H.req('DELETE', `/api/properties/${rangePid}`);

      // Portfolio combined chart: the same look-back window applies
      // to its assessed line (years are the union across properties;
      // this fixture's 2019 is the earliest year on record). Being a
      // carry-forward total, the line also carries the pre-window
      // total in at the left edge and the last total forward to
      // today, so it spans the whole window.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      // A hash jump reuses the section's cached load (assetsLoaded), so
      // reload once to make the portfolio read the fixture just created.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const pfYears = () => page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.label === 'Assessed value (all properties)') : null;
        return ds ? ds.data.map((p) => p.x) : null;
      });
      const pfPts = () => page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.label === 'Assessed value (all properties)') : null;
        return ds ? ds.data : null;
      });
      const pfApi = await H.req('GET', '/api/properties/portfolio');
      const rowOf = (y) => (pfApi.data.assessedByYear || []).find((rw) => rw.year === y) || {};
      const axisPf = () => page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        if (!c) return null;
        const xs = c.data.datasets.flatMap((d) => d.data.map((p) => p.x));
        return { min: c.scales.x.min, max: c.scales.x.max, dataMax: Math.max(...xs) };
      });
      const pfDefPts = await pfPts();
      const tdP = await todayDec();
      const pfIntYears = (pfDefPts || []).map((p) => p.x).filter((x) => Number.isInteger(x));
      H.check('portfolio assessed line defaults to the recent 1 year, carried in at the left edge',
        JSON.stringify(pfIntYears) === JSON.stringify([2026])
          && !!pfDefPts && Math.abs(pfDefPts[0].x - (tdP - 1)) < 0.05 && pfDefPts[0].y === rowOf(2025).total
          && Math.abs(pfDefPts[pfDefPts.length - 1].x - tdP) < 0.02,
        JSON.stringify(pfDefPts));
      let pax = await axisPf();
      H.check('portfolio axis is the 1-year look-back ending today',
        !!pax && Math.abs(pax.max - tdP) < 0.02 && Math.abs(pax.min - (tdP - 1)) < 0.05,
        JSON.stringify(pax && { min: pax.min, max: pax.max }));
      const pfY = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        return c ? { min: c.scales.y.min, max: c.scales.y.max } : null;
      });
      H.check('portfolio y axis starts at 0', !!pfY && pfY.min === 0, JSON.stringify(pfY));
      // Total equity line: the endpoint's equityByMonth is the
      // carry-forward assessed total in force minus the total
      // outstanding on the same month grid, and the chart plots
      // exactly those values as its 'equity' dataset.
      const eqApi = pfApi.data.equityByMonth || [];
      const assessedInForce = (y) => { let v = null; for (const rw of pfApi.data.assessedByYear) { if (rw.year <= y) v = rw.total; else break; } return v; };
      const eqIdentityOk = eqApi.length > 0 && eqApi.every((e) => {
        const a = assessedInForce(Number(e.month.slice(0, 4)));
        const out = (pfApi.data.outstandingByMonth.find((m) => m.month === e.month) || {}).total;
        return a === null ? e.value === null : Math.abs(e.value - (Math.round((a - out) * 100) / 100)) < 0.005;
      });
      const eqDs = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.key === 'equity') : null;
        return ds ? { label: ds.label, pts: ds.data } : null;
      });
      const eqLastPt = eqDs && eqDs.pts.length ? eqDs.pts[eqDs.pts.length - 1] : null;
      const eqLastMonth = eqLastPt ? `${Math.floor(eqLastPt.x)}-${String(Math.round((eqLastPt.x - Math.floor(eqLastPt.x)) * 12) + 1).padStart(2, '0')}` : null;
      const eqApiAtLast = eqLastMonth ? (eqApi.find((e) => e.month === eqLastMonth) || {}).value : null;
      H.check('portfolio chart carries a Total equity line equal to assessed (carry-forward) minus outstanding at every month',
        !!eqDs && eqDs.label === 'Total equity' && eqIdentityOk
          && !!eqLastPt && eqApiAtLast != null && Math.abs(eqLastPt.y - eqApiAtLast) < 0.005,
        JSON.stringify({ identityOk: eqIdentityOk, chartLast: eqLastPt, apiAtLast: eqApiAtLast, lastMonth: eqLastMonth }));
      await page.evaluate(() => document.querySelector('#pfRangeBtns button[data-months="12"]').click());
      await wait(600);
      const pf1Pts = await pfPts();
      const tdP1 = await todayDec();
      pax = await axisPf();
      H.check('portfolio 1-year view: axis is the year ending today and the assessed line spans it',
        !!pax && Math.abs(pax.max - tdP1) < 0.02 && Math.abs(pax.max - pax.min - 1) < 0.02
          && Array.isArray(pf1Pts) && pf1Pts.length >= 3
          && Math.abs(pf1Pts[0].x - pax.min) < 0.001 && pf1Pts[0].y === rowOf(2025).total
          && pf1Pts.some((p) => p.x === 2026)
          && Math.abs(pf1Pts[pf1Pts.length - 1].x - tdP1) < 0.02,
        JSON.stringify({ pax: pax && { min: pax.min, max: pax.max }, pf1Pts }));
      await page.evaluate(() => document.querySelector('#pfRangeBtns button[data-months="0"]').click());
      await wait(600);
      const pfAll = await pfYears();
      H.check('portfolio All range widens the assessed line to every recorded year',
        Array.isArray(pfAll) && pfAll.length === 8 && pfAll[0] === 2019 && pfAll[pfAll.length - 1] === 2026, JSON.stringify(pfAll));
      pax = await axisPf();
      H.check('portfolio All axis is the exact data extent (2019 to the last projected month)',
        !!pax && pax.min === 2019 && pax.max === pax.dataMax,
        JSON.stringify(pax && { min: pax.min, max: pax.max, dataMax: pax.dataMax }));

      // The user's real shape: five assessed years (2022-2026) and
      // one variable prime-spread segment, but NO monthly payment and
      // NO amortization. The assessed values must render as yearly
      // points joined by straight line segments (no smoothing curve,
      // no step), the missing projection must be announced beside
      // the chart, and after an edit on this page the portfolio must
      // show fresh numbers without a reload.
      r = await H.req('POST', '/api/properties', {
        address: '966 Step Test Place, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const stepPid = r.data.id;
      const stepVals = { 2022: 1730000, 2023: 1903000, 2024: 1955000, 2025: 2002000, 2026: 1931000 };
      for (const [y, v] of Object.entries(stepVals)) {
        await H.req('POST', `/api/properties/${stepPid}/value-history`, { year: Number(y), value: v });
      }
      await H.req('POST', `/api/properties/${stepPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await page.goto(`http://ff.local/#property/${stepPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      // The 5-year point/pixel pins below need the 60-month preset;
      // the page loads on the 1-year default now. The pixel scans
      // read the drawn line, so wait out the preset-change
      // re-fetch + chart animation (a 600ms wait caught the chart
      // mid-animation and misread the columns).
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="60"]').click());
      await wait(2000);
      const pfDetailSet = await page.evaluate(() => {
        const bar = document.querySelector('#rangeBtns');
        const q = (s) => !!bar.querySelector(s);
        return { one: q('button[data-months="12"]'), two: q('button[data-months="24"]'), five: q('button[data-months="60"]'), ten: q('button[data-months="120"]'), all: q('button[data-months="0"]') };
      });
      H.check('date range: property detail presets keep 1/2/5/10y/All',
        pfDetailSet.one && pfDetailSet.two && pfDetailSet.five && pfDetailSet.ten && pfDetailSet.all, JSON.stringify(pfDetailSet));
      const stepCfg = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.label === 'Assessed value');
        return ds ? { showLine: ds.showLine, tension: ds.tension, stepped: ds.stepped, pts: ds.data } : null;
      });
      H.check('detail assessed values are joined by straight lines (no curve, no step)',
        !!stepCfg && stepCfg.showLine !== false && stepCfg.tension === 0 && !stepCfg.stepped,
        JSON.stringify(stepCfg && { showLine: stepCfg.showLine, tension: stepCfg.tension, stepped: stepCfg.stepped }));
      H.check('detail assessed points are the five recorded years at their values',
        !!stepCfg && stepCfg.pts.length === 5
          && stepCfg.pts.every((p) => stepVals[p.x] === p.y),
        JSON.stringify(stepCfg && stepCfg.pts));
      const combMsg = await page.evaluate(() => document.querySelector('#combinedMsg').textContent);
      H.check('detail chart A announces the missing payment beside the chart (NO_PAYMENT)',
        combMsg.includes('set the remaining amortization'), combMsg);
      const stepLabels = await page.evaluate(() => window.__fmCharts.a.data.datasets.map((d) => d.label));
      H.check('with no payment there are no payment bars (projection absent, note shown)',
        !stepLabels.includes('Interest portion') && !stepLabels.includes('Principal portion'),
        JSON.stringify(stepLabels));
      // Pixel-level proof of the straight-line rendering: the canvas
      // column at x = 2025 (inside the chart area only, so the legend
      // swatch cannot interfere) must carry the 2025 marker at the
      // 2025 value, and the column at mid-2025 (x = 2025.5) must carry
      // the assessed green at the straight-line midpoint of the two
      // years, (2,002,000 + 1,931,000) / 2 = 1,966,500 — a smoothed
      // curve would bow away from it and a step would sit on one of
      // the two year values instead.
      const scanAt = (xVal) => page.evaluate((xv) => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        c.update('none');
        const canvas = c.canvas;
        const dpr = canvas.width / c.width;
        const xPix = Math.min(canvas.width - 1, Math.max(0, Math.round(c.scales.x.getPixelForValue(xv) * dpr)));
        const top = Math.floor(c.chartArea.top * dpr);
        const bottom = Math.min(canvas.height, Math.ceil(c.chartArea.bottom * dpr));
        const img = canvas.getContext('2d').getImageData(xPix, top, 1, bottom - top).data;
        const ys = [];
        for (let y = top; y < bottom; y++) {
          const o = (y - top) * 4;
          if (img[o + 3] > 200 && Math.abs(img[o] - 46) < 30 && Math.abs(img[o + 1] - 125) < 30 && Math.abs(img[o + 2] - 79) < 30) ys.push(y);
        }
        return { hits: ys.length, value: ys.length ? c.scales.y.getValueForPixel(ys[Math.floor(ys.length / 2)] / dpr) : null };
      }, xVal);
      const scanPt = await scanAt(2025);
      H.check('detail assessed marker sits at the 2025 value (2,002,000)',
        !!scanPt && scanPt.hits > 0 && Math.abs(scanPt.value - 2002000) < 10000, JSON.stringify(scanPt));
      const scanMid = await scanAt(2025.5);
      H.check('a straight line joins the points (mid-2025 reads the two years\u2019 average, 1,966,500)',
        !!scanMid && scanMid.hits > 0 && Math.abs(scanMid.value - 1966500) < 10000, JSON.stringify(scanMid));

      // Edit a value point through this page's own history editor
      // (the Assessment History modal — its form used to leave the
      // assets cache untouched), then go back to Properties by hash
      // only — no reload. The dirty mark must make the section
      // refetch: the new property (created after the section's last
      // load) and the portfolio notes must be current.
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(500);
      await focusField('#trendForm [name=year]');
      await page.keyboard.type('2021');
      await focusField('#trendForm [name=value]');
      await page.keyboard.type('1600000');
      await page.evaluate(() => document.querySelector('#trendSubmitBtn').click());
      await wait(1400);
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(300);
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(1800);
      const cardsText = await page.evaluate(() => document.querySelector('#propertyCards').textContent);
      H.check('after a detail-page edit, returning to Properties refetches (no stale cache)',
        cardsText.includes('966 Step Test Place'), cardsText.slice(0, 120));
      const pfNotesText = await page.evaluate(() => document.querySelector('#pfNotes').textContent);
      H.check('portfolio notes name the missing payment for a planned-but-unprojected property',
        pfNotesText.includes('set the remaining amortization on its term to project'), pfNotesText);
      const pfIntNote = await page.evaluate(() => document.querySelector('#pfInterestNote').textContent);
      H.check('portfolio interest note no longer hides the gap behind "with a rate plan"',
        !pfIntNote.includes('with a rate plan') && pfIntNote.includes('based on'), pfIntNote);
      const pfPtsCfg = await page.evaluate(() => {
        const c = window.__fmCharts.portfolio;
        const ds = c ? c.data.datasets.find((d) => d.label === 'Assessed value (all properties)') : null;
        return ds ? { showLine: ds.showLine, tension: ds.tension, stepped: ds.stepped, n: ds.data.length } : null;
      });
      H.check('portfolio assessed values are joined by straight lines (no curve, no step)',
        !!pfPtsCfg && pfPtsCfg.showLine !== false && pfPtsCfg.tension === 0 && !pfPtsCfg.stepped && pfPtsCfg.n >= 5,
        JSON.stringify(pfPtsCfg));

      // ---- Amortization years in Mortgage Terms & Rates derive the payment ----
      // The user's exact shape again (balance + one prime-spread
      // segment, nothing else), driven through the UI this time:
      // typing ONLY the remaining amortization (30) and a lender into
      // Term 1's own form must flip the page from NO_PAYMENT to a
      // full projection — the projection head's Estimated monthly
      // payment stat names the derived payment, the merged chart
      // splits every payment into interest + principal portions
      // that sum to it, and the summary totals agree with the
      // amortization endpoint.
      r = await H.req('POST', '/api/properties', {
        address: '123 Amort Test Way, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const amortPid = r.data.id;
      await H.req('POST', `/api/properties/${amortPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await page.goto(`http://ff.local/#property/${amortPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      const beforeMsg = await page.evaluate(() => document.querySelector('#combinedMsg').textContent);
      H.check('amortization UI fixture starts unprojected (NO_PAYMENT)',
        beforeMsg.includes('set the remaining amortization'), beforeMsg);
      const beforeStat = await page.evaluate(() => document.querySelector('#estPaymentValue').textContent);
      H.check('with no projection yet the Estimated monthly payment stat shows —',
        beforeStat === '—', String(beforeStat));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await focusField('[data-term-form] [name=amortization_years]');
      await page.keyboard.type('30');
      await focusField('[data-term-form] [name=lender]');
      await page.keyboard.type('Scotiabank');
      await page.evaluate(() => document.querySelector('[data-save-term]').click());
      await wait(2000);
      const amortApi = (await H.req('GET', `/api/properties/${amortPid}/amortization`)).data;
      H.check('endpoint calculates the payment from the UI-entered amortization (3.95%, 30y)',
        amortApi.ok === true && Math.abs(amortApi.paymentUsed - 6381.36) < 0.5,
        JSON.stringify({ ok: amortApi.ok, used: amortApi.paymentUsed }));
      const estStat = await page.evaluate(() => {
        const stat = document.querySelector('#estPaymentStat');
        const head = document.querySelector('#projectionPanel .panel-head');
        const v = document.querySelector('#estPaymentValue');
        return {
          inHead: !!stat && !!head && head.contains(stat),
          text: v ? v.textContent : '',
          weight: v ? Number(getComputedStyle(v).fontWeight) : 0,
          tagGone: !document.querySelector('#estPaymentTag'),
        };
      });
      H.check('the projection head carries an Estimated monthly payment stat, bold, equal to the endpoint payment (no entered/auto tag)',
        estStat.inHead && Math.abs(parseFloat(estStat.text.replace(/[^0-9.]/g, '')) - amortApi.paymentUsed) < 0.5
          && estStat.weight >= 600 && estStat.tagGone,
        JSON.stringify(estStat));
      const metaGrid = await page.evaluate(() => {
        const meta = document.querySelector('#mortgageMeta');
        const pay = document.querySelector('#metaCurrentPayment');
        return {
          labels: [...meta.querySelectorAll('.meta-k')].map((e) => e.textContent.trim()),
          inputs: meta.querySelectorAll('input, select, textarea').length,
          opening: document.querySelector('#metaOpeningPrincipal').textContent,
          current: document.querySelector('#metaCurrentPrincipal').textContent,
          payment: pay.textContent,
          paymentTagGone: !document.querySelector('#metaPaymentTag'),
          paymentWeight: Number(getComputedStyle(pay).fontWeight),
          remaining: document.querySelector('#metaRemainingAmort').textContent,
          lender: document.querySelector('#metaCurrentLender').textContent,
          formGone: !document.querySelector('#mortgageForm'),
          stray: [...document.querySelectorAll('#mortgageModal [name=lender], #mortgageModal [name=amortization_years]')]
            .filter((el) => !el.closest('[data-term-form]')).length,
          prose: document.querySelector('#mortgageModal').textContent,
        };
      });
      H.check('modal metadata: exactly the five derived figures, no inputs among them',
        JSON.stringify(metaGrid.labels) === JSON.stringify(['Opening principal ($)', 'Current Principal', 'Current Monthly Payment', 'Remaining amortization (years)', 'Current Lender'])
          && metaGrid.inputs === 0,
        JSON.stringify(metaGrid.labels));
      H.check('modal metadata values derive from the terms and the projection (payment bold, no source tag)',
        metaGrid.opening.includes('1,350,000') && Math.abs(parseFloat(metaGrid.current.replace(/[^0-9.]/g, '')) - amortApi.remainingBalance) <= 0.02
          && metaGrid.payment.includes('6,381') && metaGrid.paymentTagGone && metaGrid.paymentWeight >= 600
          && metaGrid.remaining === '30.0' && metaGrid.lender === 'Scotiabank',
        JSON.stringify(metaGrid));
      H.check('the property-level mortgage form is gone; lender/amortization live only in term forms',
        metaGrid.formGone && metaGrid.stray === 0,
        JSON.stringify({ formGone: metaGrid.formGone, stray: metaGrid.stray }));
      H.check('the tutorial prose is gone from the modal',
        !metaGrid.prose.includes('Canadian lenders: insured mortgages are usually capped')
          && !metaGrid.prose.includes('A mortgage runs as a chain of terms')
          && !metaGrid.prose.includes('Monthly payment derived from the remaining amortization'),
        metaGrid.prose.slice(0, 200));
      // Prime history: no banner lives in this modal — no title
      // line, no "Recent: …" string, no standing chart. The
      // prime-spread segment's rate text is a LINK; clicking it
      // opens the prime modal with the stepped history chart.
      // Its steps are the stored history's change points (read
      // back from the API, so both sides walk the same series)
      // and its last value is the current prime.
      const primeNow = (await H.req('GET', '/api/prime')).data;
      const noBanner = await page.evaluate(() => {
        const link = document.querySelector('#segmentRows [data-prime-link]');
        return {
          bannerGone: !document.querySelector('#primeBanner') && !document.querySelector('#primeChanges')
            && !document.querySelector('#primeChartWrap'),
          modalText: document.querySelector('#mortgageModal').textContent,
          staleHidden: document.querySelector('#primeStaleNote').classList.contains('hidden'),
          link: link ? { text: link.textContent, start: link.dataset.segStart } : null,
        };
      });
      H.check('the Mortgage modal carries no prime banner and no standing chart (stale line hidden while fresh)',
        noBanner.bannerGone && !noBanner.modalText.includes('Bank of Canada prime:') && noBanner.staleHidden,
        JSON.stringify({ bannerGone: noBanner.bannerGone, staleHidden: noBanner.staleHidden }));
      H.check('the prime-spread segment rate renders as a link carrying the segment start date',
        !!noBanner.link && noBanner.link.text.includes('Prime') && noBanner.link.start === '2024-12-17',
        JSON.stringify(noBanner.link));
      let primeUi = null;
      for (let i = 0; i < 20; i++) {
        primeUi = await page.evaluate(() => {
          const canvas = document.querySelector('#primeChart');
          const rect = canvas ? canvas.getBoundingClientRect() : null;
          const c = window.__fmCharts.prime;
          const ds = c ? c.data.datasets[0] : null;
          return {
            open: !document.querySelector('#primeModal').classList.contains('hidden'),
            hasChart: !!c,
            stepped: ds ? ds.stepped : null,
            ys: ds ? [...new Set(ds.data.map((pt) => pt.y))].sort((a, b) => a - b) : [],
            lastY: ds ? ds.data[ds.data.length - 1].y : null,
            w: rect ? rect.width : 0,
            h: rect ? rect.height : 0,
            head: document.querySelector('#primeModalCurrent').textContent,
          };
        });
        if (primeUi.hasChart) break;
        // (Re)click the link: a first click can land before
        // loadPrime has cached the history; opening is idempotent.
        await page.evaluate(() => {
          const a = document.querySelector('#segmentRows [data-prime-link]');
          if (a) a.click();
        });
        await wait(300);
      }
      const histRates = [...new Set((primeNow.history || []).map((h) => h.rate))].sort((a, b) => a - b);
      H.check('clicking the rate link opens the prime modal with the stepped prime history chart',
        primeUi.open && primeUi.hasChart && primeUi.stepped === 'after'
          && JSON.stringify(primeUi.ys) === JSON.stringify(histRates)
          && primeUi.ys.includes(5.45) && primeUi.ys.includes(4.45)
          && primeUi.lastY === primeNow.current.rate
          && primeUi.head.startsWith('Bank of Canada prime:'),
        JSON.stringify(primeUi));
      H.check('the prime chart renders at a real size inside the prime modal',
        primeUi.w > 200 && primeUi.h > 100, JSON.stringify({ w: primeUi.w, h: primeUi.h }));
      await page.evaluate(() => document.querySelector('#primeModal [data-close-modal]').click());
      await wait(300);
      const primeGone = await page.evaluate(() => window.__fmCharts.prime);
      H.check('closing the prime modal destroys the chart instance',
        primeGone === null, JSON.stringify(primeGone));
      // Stale prime: when /api/prime reports the tracked value is
      // stale (fresh: false), the Mortgage modal shows its one
      // small amber line; fresh again, the line is gone. (Stubbed
      // at the fetch layer, as in screenshot-prime — server-side
      // freshness is date-based and covered by the API checks.)
      const staleUi = await page.evaluate(async () => {
        const origFetch = window.fetch.bind(window);
        window.fetch = (url, opts) => {
          if (String(url).includes('/api/prime') && (!opts || !opts.method || opts.method === 'GET')) {
            return Promise.resolve(new Response(JSON.stringify({
              current: { date: '2026-10-21', rate: 4.45 }, fresh: false, asOf: '2026-10-23',
              changes: [], history: [], lastFetchedAt: null,
              source: { name: 'Bank of Canada Valet', series: 'V80691311', label: 'Bank of Canada prime rate' },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return origFetch(url, opts);
        };
        await loadPrime();
        const el = document.querySelector('#primeStaleNote');
        const shown = { hidden: el.classList.contains('hidden'), text: el.textContent };
        window.fetch = origFetch;
        await loadPrime();
        return { shown, hiddenAfterFresh: document.querySelector('#primeStaleNote').classList.contains('hidden') };
      });
      H.check('stale prime shows one small amber line in the Mortgage modal; fresh hides it',
        !staleUi.shown.hidden && staleUi.shown.text.includes('last known prime of 4.45%')
          && staleUi.hiddenAfterFresh === true,
        JSON.stringify(staleUi));
      const afterMsg = await page.evaluate(() => document.querySelector('#combinedMsg').textContent);
      H.check('the NO_PAYMENT note beside chart A clears once amortization is in',
        !afterMsg.includes('set the remaining amortization'), afterMsg);
      // The split bars live in the merged chart now (the former
      // Chart B). This fixture's balance date is today, so inside
      // the default look-back window the projection is still in the
      // future — switch to All, where the bars are yearly sums, and
      // compare year by year against the endpoint's series.
      await page.evaluate(() => document.querySelector('#rangeBtns button[data-months="0"]').click());
      await wait(600);
      const chartBInfo = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        if (!c) return null;
        const ints = c.data.datasets.find((d) => d.label === 'Interest portion');
        const prins = c.data.datasets.find((d) => d.label === 'Principal portion');
        if (!ints || !prins) return null;
        return {
          types: [ints.type, prins.type],
          labels: [ints.label, prins.label],
          stacks: [ints.stack, prins.stack],
          sums: ints.data.map((p, i) => p.y + prins.data[i].y),
        };
      });
      H.check('the merged chart carries the stacked Interest portion + Principal portion bars',
        !!chartBInfo && chartBInfo.types[0] === 'bar'
          && chartBInfo.labels[0] === 'Interest portion' && chartBInfo.labels[1] === 'Principal portion'
          && chartBInfo.stacks[0] === 'payment' && chartBInfo.stacks[1] === 'payment',
        JSON.stringify(chartBInfo && { types: chartBInfo.types, labels: chartBInfo.labels, stacks: chartBInfo.stacks }));
      const yearSums = [];
      if (amortApi.series) {
        const byY = new Map();
        for (const r of amortApi.series) {
          const y = r.month.slice(0, 4);
          byY.set(y, (byY.get(y) || 0) + r.payment);
        }
        yearSums.push(...[...byY.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v));
      }
      let splitOk = !!chartBInfo && chartBInfo.sums.length === yearSums.length && yearSums.length > 6;
      if (splitOk) {
        for (let k = 0; k < 6; k++) {
          if (Math.abs(chartBInfo.sums[k] - yearSums[k]) > 1) { splitOk = false; break; }
        }
      }
      H.check('merged chart bar portions sum to each year\u2019s payments (first 6 years)',
        splitOk, JSON.stringify(chartBInfo && chartBInfo.sums.slice(0, 6)));
      // The old text summary over the chart is gone; the figures
      // live in the schedule's Total row (range = All here, so the
      // row sums the endpoint's whole series) with the payoff month
      // in its label.
      const schedTotal = await page.evaluate(() => {
        const total = document.querySelector('#scheduleTotalRow');
        if (!total) return null;
        return {
          label: total.children[0].textContent,
          payment: Number(total.querySelector('.sum-payment').dataset.value),
          principal: Number(total.querySelector('.sum-principal').dataset.value),
          interest: Number(total.querySelector('.sum-interest').dataset.value),
        };
      });
      const amortTotals = {
        payment: amortApi.series.reduce((s, r) => s + r.payment, 0),
        principal: amortApi.series.reduce((s, r) => s + r.principal, 0),
        interest: amortApi.series.reduce((s, r) => s + r.interest, 0),
      };
      H.check('schedule Total row carries the projected totals (payment, principal, interest) and the payoff month',
        !!schedTotal
          && Math.abs(schedTotal.payment - amortTotals.payment) < 0.005
          && Math.abs(schedTotal.principal - amortTotals.principal) < 0.005
          && Math.abs(schedTotal.interest - amortTotals.interest) < 0.005
          && Math.abs(schedTotal.interest - amortApi.totalInterest) < 0.02
          && !!amortApi.payoffMonth && schedTotal.label.includes(`Paid off ${amortApi.payoffMonth}`),
        JSON.stringify(schedTotal));
      H.check('no text summary block remains over the chart',
        await page.evaluate(() => !document.querySelector('#monthlySummary')));
      const lenderBits = await page.evaluate(() => ({
        view: document.querySelector('#propViewBody').textContent,
        meta: document.querySelector('#metaCurrentLender').textContent,
        input: document.querySelector('[data-term-form] [name=lender]').value,
      }));
      H.check('lender shows in the modal metadata and the term form — and NOT in the slimmed details panel',
        !lenderBits.view.includes('Lender')
          && lenderBits.meta === 'Scotiabank' && lenderBits.input === 'Scotiabank',
        JSON.stringify(lenderBits));
      const inModal = await page.evaluate(() => {
        const modal = document.querySelector('#mortgageModal');
        const inside = (sel) => { const el = document.querySelector(sel); return !!el && modal.contains(el); };
        return {
          all: inside('#mortgageMeta') && inside('#segmentRows') && inside('[data-term-form] [name=payment_frequency]') && inside('#termsWrap'),
          heading: modal.querySelector('h3').textContent.trim(),
          onPage: !!document.querySelector('#view-property #mortgageMeta'),
        };
      });
      H.check('mortgage terms and rate segments live in the Mortgage Terms & Rates modal, not on the page',
        inModal.all && inModal.heading.startsWith('Mortgage Terms & Rates') && !inModal.onPage,
        JSON.stringify(inModal));
      const portUi = (await H.req('GET', '/api/properties/portfolio')).data;
      const rowUi = portUi.properties.find((x) => x.id === amortPid);
      H.check('the UI-entered amortization flips the portfolio state to projected',
        !!rowUi && rowUi.projState === 'projected', JSON.stringify(rowUi && rowUi.projState));
      // There is no PROPERTY-level payment field to type into, and
      // no entered/auto tag: with no override set on this fixture,
      // the stat, the metadata and the term card all show the
      // calculated figure, plain (no strikethrough). The override
      // has NO standalone input: the term form's Monthly payment
      // row shows the figure with an Edit button, its editor
      // input hidden in the same row, empty.
      const noEntry = await page.evaluate(() => {
        const payInput = document.querySelector('[data-pay-block] [name=payment_override]');
        const editBtn = document.querySelector('[data-pay-block] [data-pay-edit]');
        return {
          propertyPaymentInputs: document.querySelectorAll('#mortgageModal [name=mortgage_payment]').length,
          overrideInputs: document.querySelectorAll('#mortgageModal [name=payment_override]').length,
          overrideLabels: [...document.querySelectorAll('#mortgageModal label')].filter((l) => l.textContent.includes('Monthly payment override')).length,
          payInputHidden: !!payInput && payInput.classList.contains('hidden'),
          payInputValue: payInput ? payInput.value : null,
          editBtnShown: !!editBtn && !editBtn.classList.contains('hidden'),
          struck: document.querySelectorAll('#mortgageModal [data-term-payment] s, #metaCurrentPayment s, #estPaymentValue s').length,
          estTag: !!document.querySelector('#estPaymentTag'),
          metaTag: !!document.querySelector('#metaPaymentTag'),
          termFigure: document.querySelector('[data-pay-block] [data-term-payment]').textContent,
          stat: document.querySelector('#estPaymentValue').textContent,
          meta: document.querySelector('#metaCurrentPayment').textContent,
        };
      });
      H.check('no property payment input and no entered/auto tag — the calculated figure shows plain in the stat, the metadata and the term card (payment editor at rest: figure + Edit, input hidden and empty, no standalone override input)',
        noEntry.propertyPaymentInputs === 0 && noEntry.overrideInputs >= 1 && noEntry.overrideLabels === 0
          && noEntry.payInputHidden && noEntry.payInputValue === '' && noEntry.editBtnShown
          && noEntry.struck === 0 && !noEntry.estTag && !noEntry.metaTag
          && noEntry.termFigure.includes('6,381') && noEntry.stat.includes('6,381') && noEntry.meta.includes('6,381'),
        JSON.stringify(noEntry));
      await H.req('DELETE', `/api/properties/${amortPid}`);

      // ---- Current Principal is TODAY's remaining balance ----
      // His exact shape (1,350,000 at 2024-12-17, Prime - 1, 25y):
      // the anchor is nearly two years stale, so the detail
      // payload, the modal's Current Principal and the equity
      // readout must all show the projection's balance at the
      // CURRENT month instead. The expected figure is taken
      // dynamically from the returned series (the last row at or
      // before this month, on the Vancouver calendar) — no
      // hard-coded date or dollar value.
      r = await H.req('POST', '/api/properties', {
        address: '77 Remaining Balance Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
      });
      const remPid = r.data.id;
      await H.req('PUT', `/api/properties/${remPid}`, { amortization_years: 25 });
      await H.req('POST', `/api/properties/${remPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      for (const [year, value] of [[2022, 1730000], [2023, 1903000], [2024, 1955000], [2025, 2002000], [2026, 1931000]]) {
        await H.req('POST', `/api/properties/${remPid}/value-history`, { year, value });
      }
      const remAmort = (await H.req('GET', `/api/properties/${remPid}/amortization`)).data;
      const vanToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const curMonth = vanToday.slice(0, 7);
      const rowsToNow = (remAmort.series || []).filter((x) => x.month <= curMonth);
      const lastRow = rowsToNow[rowsToNow.length - 1];
      H.check('remaining-balance fixture projects with rows up to the current month',
        remAmort.ok === true && !!lastRow && rowsToNow.length >= 12,
        JSON.stringify({ ok: remAmort.ok, curMonth, rows: rowsToNow.length }));
      H.check('projection payload: remainingBalance is the series balance at the current month (below the stale anchor)',
        remAmort.remainingBalance === (lastRow && lastRow.balance)
          && remAmort.remainingBalanceMonth === (lastRow && lastRow.month)
          && remAmort.remainingBalance < 1350000 && remAmort.remainingBalance > 0,
        JSON.stringify({ rem: remAmort.remainingBalance, row: lastRow && lastRow.balance, month: remAmort.remainingBalanceMonth }));
      const remDetail = (await H.req('GET', `/api/properties/${remPid}`)).data;
      H.check('detail payload carries the same remainingBalance',
        remDetail.remainingBalance === remAmort.remainingBalance
          && remDetail.remainingBalanceMonth === remAmort.remainingBalanceMonth,
        JSON.stringify({ rem: remDetail.remainingBalance, month: remDetail.remainingBalanceMonth }));
      const remEquity = (await H.req('GET', `/api/properties/${remPid}/equity`)).data;
      H.check('equity subtracts the remaining balance, not the anchor (1,931,000 - remaining)',
        remEquity.balance === remAmort.remainingBalance
          && Math.abs(remEquity.equity - (1931000 - remAmort.remainingBalance)) < 0.02,
        JSON.stringify(remEquity));
      const remPort = (await H.req('GET', '/api/properties/portfolio')).data;
      const remRow = remPort.properties.find((x) => x.id === remPid);
      H.check('portfolio outstanding for the property is the same remaining balance',
        !!remRow && Math.abs(remRow.outstanding - remAmort.remainingBalance) < 0.02,
        JSON.stringify(remRow && remRow.outstanding));
      // Browser: the modal cell and the equity line show that figure.
      // (Detour via the properties section first: the deleted
      // amortPid's id is reused by this fixture, so the hash may
      // already read #property/<same id> and a direct jump would
      // fire no hashchange at all.)
      const groupNum = (n) => Number(n).toLocaleString('en-CA', { maximumFractionDigits: 0 });
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(800);
      await page.goto(`http://ff.local/#property/${remPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      const remMeta = await page.evaluate(() => document.querySelector('#metaCurrentPrincipal').textContent);
      H.check('modal Current Principal shows today\u2019s remaining balance, not the 1,350,000 anchor',
        Math.abs(parseFloat(remMeta.replace(/[^0-9.]/g, '')) - remAmort.remainingBalance) <= 0.02 && !remMeta.includes('1,350,000'),
        String(remMeta));
      const remEqText = await page.evaluate(() => document.querySelector('#equitySummary').textContent);
      H.check('detail equity line is the bare figure (assessed minus remaining, no derivation tail)',
        remEqText.trim() === `Current equity: $${Number(1931000 - remAmort.remainingBalance).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        remEqText);
      await page.evaluate(() => document.querySelector('#mortgageModal [data-close-modal]').click());
      await wait(300);
      await H.req('DELETE', `/api/properties/${remPid}`);

      // A fixed plan has no prime door at all: its segment rate is
      // plain text (no link), and the prime modal stays shut.
      r = await H.req('POST', '/api/properties', {
        address: '456 Fixed Test Court, Victoria, BC',
        mortgage_balance: 500000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const fixedPid = r.data.id;
      await H.req('POST', `/api/properties/${fixedPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'fixed', annual_rate: 5,
      });
      await H.req('PUT', `/api/properties/${fixedPid}`, { amortization_years: 25 });
      await page.goto(`http://ff.local/#property/${fixedPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      const fixedPrimeUi = await page.evaluate(() => ({
        links: document.querySelectorAll('#termsWrap [data-prime-link]').length,
        bannerGone: !document.querySelector('#primeBanner') && !document.querySelector('#primeChartWrap'),
        modalOpen: !document.querySelector('#primeModal').classList.contains('hidden'),
        hasChart: !!window.__fmCharts.prime,
        modalText: document.querySelector('#mortgageModal').textContent,
      }));
      H.check('fixed plan: no prime link on the segment, no prime banner, the prime modal stays shut',
        fixedPrimeUi.links === 0 && fixedPrimeUi.bannerGone && !fixedPrimeUi.modalOpen
          && !fixedPrimeUi.hasChart && !fixedPrimeUi.modalText.includes('Bank of Canada prime:'),
        JSON.stringify({ links: fixedPrimeUi.links, bannerGone: fixedPrimeUi.bannerGone, modalOpen: fixedPrimeUi.modalOpen }));
      await H.req('DELETE', `/api/properties/${fixedPid}`);

      // ---- Terms UI: build a renewal through the accordion ----
      // Same shape once more, driven entirely through the page this
      // time: the modal metadata names the current lender, "+ Add term /
      // renewal" creates Term 2 prefilled and expanded, its form
      // takes the new lender + amortization, and the projection then
      // runs continuously across the boundary with the payment
      // re-derived on Term 2's amortization. A lump sum added in
      // Term 1 through its own form leaves the payment unchanged
      // and pulls the payoff earlier.
      r = await H.req('POST', '/api/properties', {
        address: '888 Term UI Way, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25', purchase_date: '2024-12-17',
      });
      const termUiPid = r.data.id;
      await H.req('POST', `/api/properties/${termUiPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
      });
      await H.req('PUT', `/api/properties/${termUiPid}`, { amortization_years: 30, lender: 'RBC' });
      await page.goto(`http://ff.local/#property/${termUiPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      // A property->property hash jump can leave the previous
      // fixture's render in place (in-flight loads race); a reload
      // pins the page to this property, as in earlier sections.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      // Poll for this property's metadata.
      let sumBefore = '';
      for (let i = 0; i < 40; i++) {
        sumBefore = await page.evaluate(() => document.querySelector('#mortgageMeta').textContent);
        if (sumBefore.includes('RBC')) break;
        await wait(300);
      }
      H.check('modal metadata names the current lender and the calculated payment (no auto/entered tag)',
        sumBefore.includes('RBC') && sumBefore.includes('6,381')
          && !sumBefore.includes('auto') && !sumBefore.includes('entered'),
        sumBefore);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(500);
      await page.evaluate(() => document.querySelector('#addTermBtn').click());
      await wait(2000);
      const termBlocks = await page.evaluate(() => document.querySelectorAll('#termsWrap .term-block').length);
      H.check('"+ Add term / renewal" adds a second term block', termBlocks === 2, String(termBlocks));
      await page.evaluate(() => {
        const blocks = document.querySelectorAll('#termsWrap .term-block');
        const form = blocks[blocks.length - 1].querySelector('[data-term-form]');
        form.lender.value = 'TD';
        form.amortization_years.value = '25';
        form.requestSubmit();
      });
      await wait(2200);
      r = await H.req('GET', `/api/properties/${termUiPid}`);
      H.check('the UI-saved renewal carries the new lender + amortization',
        r.data.terms.length === 2 && r.data.terms[1].lender === 'TD' && r.data.terms[1].amortization_years === 25,
        JSON.stringify(r.data.terms));
      let sumAfter = '';
      for (let i = 0; i < 40; i++) {
        sumAfter = await page.evaluate(() => document.querySelector('#termsWrap').textContent);
        if (sumAfter.includes('Term 2') && sumAfter.includes('TD')) break;
        await wait(300);
      }
      H.check('the terms list now shows the renewal with its lender',
        sumAfter.includes('Term 2') && sumAfter.includes('TD'), sumAfter.slice(0, 200));
      const amortUi = (await H.req('GET', `/api/properties/${termUiPid}/amortization`)).data;
      const t2Month = r.data.terms[1].start_date.slice(0, 7);
      const idxB = amortUi.series.findIndex((x) => x.month === t2Month);
      H.check('UI-built Term 2: projection continuous, payment re-derived at the boundary',
        idxB > 0
          && Math.abs(amortUi.series[idxB].payment - engineDerive(amortUi.series[idxB - 1].balance, 3.95, 25)) < 0.02
          && Math.abs(amortUi.series[idxB].balance
            - (amortUi.series[idxB - 1].balance + amortUi.series[idxB].interest - amortUi.series[idxB].payment)) < 0.02,
        JSON.stringify(amortUi.series[idxB]));
      // Every term card carries the full field set — principal
      // pair, frequency, day, and the calculated monthly payment
      // as a read-only figure whose own row holds the override
      // editor (Edit button + the payment_override input, in the
      // payment row — never a standalone field, never a
      // property-level payment input). The payment row closes
      // the card (below the segments and the lump sums), so its
      // editor lives in the card's pay block, associated with
      // the term form rather than nested inside it — and the old
      // standalone anchor form is gone from the page entirely.
      const fieldSets = await page.evaluate(() => ({
        forms: [...document.querySelectorAll('#termsWrap .term-block [data-term-form]')].map((f) => {
          const pb = f.closest('.term-block').querySelector('[data-pay-block]');
          return {
            overrideInput: !!pb && !!pb.querySelector('[name=payment_override]'),
            overrideInPaymentRow: !!pb && !!pb.querySelector('.term-pay-row [name=payment_override]'),
            payEditBtn: !!pb && !!pb.querySelector('.term-pay-row [data-pay-edit]'),
            propertyPaymentInput: !!f.querySelector('[name=mortgage_payment]'),
            paymentFigure: !!pb && !!pb.querySelector('[data-term-payment]'),
            freq: !!f.querySelector('[name=payment_frequency]'),
            day: !!f.querySelector('[name=payment_day]'),
            principal: !!f.querySelector('[name=opening_balance], [name=anchor_balance]'),
            principalDate: !!f.querySelector('[name=start_date], [name=anchor_date]'),
          };
        }),
        anchorForms: document.querySelectorAll('[data-anchor-form]').length,
      }));
      H.check('every term card carries the principal/frequency/day field set, a read-only payment figure with its inline Edit in the payment row closing the card — no property payment input (no separate anchor form)',
        fieldSets.forms.length === 2
          && fieldSets.forms.every((s) => s.overrideInput && s.overrideInPaymentRow && s.payEditBtn && !s.propertyPaymentInput && s.paymentFigure && s.freq && s.day && s.principal && s.principalDate)
          && fieldSets.anchorForms === 0,
        JSON.stringify(fieldSets));
      // The payment figure is the RESULT of the rate plan: its
      // row comes after the segments table and the lump sums in
      // the card's document order — and the card's Save button
      // closes the card below the payment row (the segments
      // block sits above the Save, never below it).
      const payOrder = await page.evaluate(() => {
        const block = document.querySelector('#termsWrap .term-block');
        const pay = block.querySelector('[data-pay-block]');
        const segTable = block.querySelector('.seg-table');
        const segForm = block.querySelector('[data-seg-form]');
        const lumpForm = block.querySelector('[data-lump-form]');
        const saveBtn = block.querySelector('[data-save-term]');
        const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;
        const follows = (a, b) => !!a && !!b && (a.compareDocumentPosition(b) & FOLLOWS) !== 0;
        return {
          pay: !!pay,
          afterSeg: follows(segTable, pay),
          afterLump: follows(lumpForm, pay),
          segBeforeSave: follows(segTable, saveBtn) && follows(segForm, saveBtn),
          saveAfterPay: follows(pay, saveBtn),
        };
      });
      H.check('the Monthly payment row sits below the rate segments and the lump sums, and the Save button closes the card below it',
        payOrder.pay && payOrder.afterSeg && payOrder.afterLump && payOrder.segBeforeSave && payOrder.saveAfterPay,
        JSON.stringify(payOrder));
      const termPayFig = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-term-payment]').textContent);
      H.check('the current term card shows its calculated monthly payment read-only',
        termPayFig.includes('6,381'), String(termPayFig));
      // One form, one Save per term card: the term's contract
      // fields and its payment schedule (frequency /
      // day, and its anchor when it carries one) save together in
      // a single submit — there is no second Save button anywhere
      // in the card (the Add segment / Add lump sum buttons belong
      // to their own hidden creation forms, not to the term). The
      // Save button itself lives below the payment row, outside
      // the <form>, bound back to it by the HTML form attribute,
      // and its label names the payment in the term's frequency.
      const saveCounts = await page.evaluate(() => [...document.querySelectorAll('#termsWrap .term-block')].map((block) => {
        const forms = block.querySelectorAll('[data-term-form]');
        const form = forms[0];
        const saveBtn = block.querySelector('[data-save-term]');
        return {
          termForms: forms.length,
          submitsInForm: form ? form.querySelectorAll('button[type=submit]').length : -1,
          saveButtonsInCard: [...block.querySelectorAll('button[type=submit]')]
            .filter((b) => b.textContent.trim().startsWith('Save')).length,
          saveLabel: saveBtn ? saveBtn.textContent.trim() : null,
          saveFormAttr: saveBtn ? saveBtn.getAttribute('form') : null,
          formId: form ? form.id : null,
        };
      }));
      H.check('each term card is one form with exactly one Save button — below the payment row, outside the form, bound by its form attribute, labelled by frequency',
        saveCounts.length === 2
          && saveCounts.every((s) => s.termForms === 1 && s.submitsInForm === 0 && s.saveButtonsInCard === 1
            && s.saveLabel === 'Save & calculate monthly payment' && s.saveFormAttr === s.formId),
        JSON.stringify(saveCounts));
      // The label follows the frequency select live.
      await page.evaluate(() => {
        const sel = document.querySelector('#termsWrap .term-block [data-term-form] [name=payment_frequency]');
        sel.value = 'bi_weekly';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const saveLabelBw = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-save-term]').textContent.trim());
      H.check('changing the frequency select re-labels the Save button (Save & calculate bi-weekly payment)',
        saveLabelBw === 'Save & calculate bi-weekly payment', saveLabelBw);
      await page.evaluate(() => {
        const sel = document.querySelector('#termsWrap .term-block [data-term-form] [name=payment_frequency]');
        sel.value = 'monthly';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Lump sum through Term 1's own form (amount typed bare, it
      // groups live like every money field).
      await page.evaluate(() => {
        document.querySelector('#termsWrap .term-block [data-toggle-lump]').click();
        document.querySelector('#termsWrap .term-block [data-lump-form] [name=date]').value = '2026-12-01';
        document.querySelector('#termsWrap .term-block [data-lump-form] [name=amount]').focus();
      });
      await page.keyboard.type('50000');
      const lumpTyped = await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-lump-form] [name=amount]').value);
      H.check('lump sum amount groups while typing (50000 -> 50,000)', lumpTyped === '50,000', String(lumpTyped));
      await page.evaluate(() => document.querySelector('#termsWrap .term-block [data-lump-form]').requestSubmit());
      await wait(2200);
      const amortLump = (await H.req('GET', `/api/properties/${termUiPid}/amortization`)).data;
      const novRowL = amortLump.series.find((x) => x.month === '2026-11');
      const decRowL = amortLump.series.find((x) => x.month === '2026-12');
      // The lump leaves the Term 1 payment untouched; the payoff
      // it pulls in is then absorbed by the renewal, whose payment
      // is re-derived on Term 2's amortization from the smaller
      // balance — so the visible wins are the lower renewal
      // payment and the lower total interest, not an earlier
      // final payoff (that needs a single-term loan; see the
      // engine unit tests).
      const t2Before = amortUi.series.find((x) => x.month === t2Month);
      const t2After = amortLump.series.find((x) => x.month === t2Month);
      H.check('UI lump sum: the lump month charges interest on the reduced balance, the payment is unchanged, the renewal payment drops',
        !!decRowL && !!novRowL
          && Math.abs(decRowL.interest - Math.round((novRowL.balance - 50000) * engineMonthlyRate(3.95) * 100) / 100) < 0.02
          && Math.abs(decRowL.payment - amortUi.paymentUsed) < 0.02
          && !!t2Before && !!t2After && t2After.payment < t2Before.payment - 100
          && amortLump.totalInterest < amortUi.totalInterest - 10000,
        JSON.stringify({ dec: decRowL, t2Before: t2Before && t2Before.payment, t2After: t2After && t2After.payment }));
      r = await H.req('GET', `/api/properties/${termUiPid}`);
      H.check('the lump sum is recorded under Term 1',
        r.data.terms[0].lumpSums.length === 1 && r.data.terms[0].lumpSums[0].amount === 50000,
        JSON.stringify(r.data.terms[0].lumpSums));

      // ---- Plan preview in the add-segment form ----
      // The term form carries the repayment-method select; the
      // add-segment form previews the drafted plan's first month
      // live (server-computed) and re-prices as the spread is
      // edited — nothing is saved by previewing.
      const methodSel = await page.evaluate(() => {
        const sel = document.querySelector('#termsWrap .term-block [data-term-form] [name=repayment_method]');
        return sel ? sel.value : null;
      });
      H.check('the term form offers the repayment method (equal payment by default)',
        methodSel === 'equal_payment', String(methodSel));
      await page.evaluate(() => {
        document.querySelector('#termsWrap .term-block [data-toggle-seg]').click();
        const form = document.querySelector('#termsWrap .term-block [data-seg-form]');
        const set = (name, value, evt) => {
          const el = form.querySelector(`[name=${name}]`);
          el.value = value;
          el.dispatchEvent(new Event(evt, { bubbles: true }));
        };
        set('rate_type', 'variable', 'change');
        set('rate_mode', 'prime_spread', 'change');
        set('spread', '-1', 'input');
      });
      await wait(1100);
      const previewText1 = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-seg-form] [data-plan-preview]').textContent);
      H.check('the add-segment form previews the plan\u2019s first month (payment — interest, principal, at rate)',
        previewText1.includes('Next month (') && previewText1.includes('payment $')
          && previewText1.includes('interest $') && previewText1.includes('principal $')
          && previewText1.includes('at 3.95%'),
        previewText1);
      await page.evaluate(() => {
        const el = document.querySelector('#termsWrap .term-block [data-seg-form] [name=spread]');
        el.value = '-2';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(1100);
      const previewText2 = await page.evaluate(() =>
        document.querySelector('#termsWrap .term-block [data-seg-form] [data-plan-preview]').textContent);
      H.check('editing the spread re-prices the preview live (Prime - 2 -> 2.95%, a different payment)',
        previewText2.includes('at 2.95%') && previewText2 !== previewText1,
        previewText2);
      r = await H.req('GET', `/api/properties/${termUiPid}`);
      H.check('previewing saved nothing (still the one original segment)',
        r.data.segments.length === 1 && r.data.segments[0].spread === -1,
        JSON.stringify(r.data.segments));
      await H.req('DELETE', `/api/properties/${termUiPid}`);

      // ---- Property panel: read-only metadata until Edit; photo carousel ----
      page.on('dialog', (d) => d.accept()); // photo removal asks confirm()
      const until = async (fn, tries = 40) => {
        for (let i = 0; i < tries; i++) { if (await page.evaluate(fn)) return true; await wait(300); }
        return false;
      };
      await page.goto(`http://ff.local/#property/${moneyPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      H.check('detail opens on the read-only property view',
        await until(() => {
          const body = document.querySelector('#propViewBody');
          return body && body.textContent.includes('999 Money Test Terrace')
            && !document.querySelector('#propView').classList.contains('hidden');
        }));
      const panelState = await page.evaluate(() => ({
        formHidden: document.querySelector('#propForm').classList.contains('hidden'),
        viewInputs: document.querySelectorAll('#propView input').length,
        hasPhotoUrlField: !!document.querySelector('#propForm [name=photo_url]'),
        viewText: document.querySelector('#propViewBody').textContent,
        emptyGallery: document.querySelector('#photoArea').textContent.includes('No photos yet'),
      }));
      H.check('the edit form stays hidden until Edit', panelState.formHidden === true);
      H.check('the read-only view has no inputs (pure metadata)', panelState.viewInputs === 0);
      H.check('the Photo URL field is gone from the edit form', panelState.hasPhotoUrlField === false);
      H.check('read-only view shows purchase date 2024-12-17', panelState.viewText.includes('2024-12-17'), panelState.viewText.slice(0, 160));
      H.check('a property without photos shows the click-to-add placeholder', panelState.emptyGallery === true);
      // Layout: ONE merged overview panel (details left, photo
      // carousel right) above Value & Mortgage Projection; the old
      // separate Gallery / Property Details panels are gone. Edit
      // sits in the merged panel's head; the mortgage setup, the
      // history editor and the fetch/pull buttons live in their
      // modals, not on the page body. The BCA source line moved
      // with them into Assessment History.
      const layout = await page.evaluate(() => {
        const ov = document.getElementById('propertyOverview');
        const vp = document.getElementById('projectionPanel');
        const follows = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
        const det = ov ? ov.querySelector('.overview-details') : null;
        const pho = ov ? ov.querySelector('.overview-photos') : null;
        const dr = det ? det.getBoundingClientRect() : null;
        const pr = pho ? pho.getBoundingClientRect() : null;
        return {
          merged: !!ov && !document.getElementById('galleryPanel') && !document.getElementById('propertyDetailsPanel'),
          order: follows(ov, vp),
          headings: [ov, vp].map((el) => ((el.querySelector('h3') || {}).textContent || '').trim()),
          editInHead: !!document.querySelector('#propertyOverview .panel-head #editPropBtn'),
          columns: !!(det && pho && det.contains(document.getElementById('propView'))
            && pho.contains(document.getElementById('photoArea'))),
          leftRight: !!(dr && pr && dr.left < pr.left && Math.abs(dr.top - pr.top) < 4),
          mortgageOnPage: !!document.querySelector('#view-property #termsWrap'),
          historyOnPage: !!document.querySelector('#view-property #trendForm'),
          fetchOnPage: !!document.querySelector('#view-property #fetchBcaBtn'),
        };
      });
      H.check('detail layout is one merged overview panel above Value & Mortgage Projection',
        layout.merged && layout.order && layout.headings[0] === 'Property Details'
          && layout.headings[1] === 'Value & Mortgage Projection',
        JSON.stringify(layout));
      H.check('overview columns: details on the left, photo carousel on the right',
        layout.columns && layout.leftRight, JSON.stringify(layout));
      H.check('Property Details Edit sits in the merged panel head (top right)', layout.editInHead === true);
      H.check('the page body carries neither the mortgage setup nor the assessment history (modals only)',
        !layout.mortgageOnPage && !layout.historyOnPage && !layout.fetchOnPage,
        JSON.stringify(layout));
      // Details content, exactly as ruled: two headline figures
      // (assessed value, remaining balance) over Address / Owners /
      // Purchase date — no Notes, Assessment year or Lender rows,
      // no payment-frequency or region prose lines, and the region
      // rides beside the address as a flag tag.
      const detailsBits = await page.evaluate(() => {
        const tag = document.querySelector('#propViewBody .region-tag');
        return {
          labels: [...document.querySelectorAll('#propViewBody tr td:first-child')].map((td) => td.textContent.trim()),
          assessed: document.querySelector('#detailAssessedValue').textContent,
          remaining: document.querySelector('#detailRemainingBalance').textContent,
          viewText: document.querySelector('#propView').textContent,
          tagText: tag ? tag.textContent : null,
          tagTitle: tag ? tag.getAttribute('title') : null,
          proseGone: !document.querySelector('#paymentDayDisplay') && !document.querySelector('#regionDisplay'),
          bigParaGone: ![...document.querySelectorAll('#projectionPanel .note')]
            .some((n) => n.textContent.includes('plotted as one point per assessment year')),
        };
      });
      const vhNow = (await H.req('GET', `/api/properties/${moneyPid}/value-history`)).data;
      const propNow = (await H.req('GET', `/api/properties/${moneyPid}`)).data;
      const latestPt = vhNow.points && vhNow.points.length ? vhNow.points[vhNow.points.length - 1] : null;
      const fmt$ = (n) => '$' + Number(n).toLocaleString('en-CA', { maximumFractionDigits: 0 });
      const fmt$2 = (n) => '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const expAssessed = latestPt ? latestPt.value : propNow.assessed_value;
      const expRemaining = propNow.remainingBalance != null ? propNow.remainingBalance : propNow.mortgage_balance;
      H.check('details carry exactly the two headline figures over Address / Owners / Purchase date',
        detailsBits.labels.join('|') === 'Address|Owners|Purchase date'
          && detailsBits.assessed === fmt$(expAssessed)
          && detailsBits.remaining === fmt$2(expRemaining),
        JSON.stringify({ detailsBits, expAssessed, expRemaining }));
      H.check('details carry no Notes / Assessment year / Lender rows and no prose lines',
        !detailsBits.viewText.includes('Notes') && !detailsBits.viewText.includes('Assessment year')
          && !detailsBits.viewText.includes('Lender') && !detailsBits.viewText.includes('Payment frequency')
          && !detailsBits.viewText.includes('Region:') && detailsBits.proseGone && detailsBits.bigParaGone,
        JSON.stringify(detailsBits));
      H.check('region shows as a flag tag beside the address (details panel)',
        detailsBits.tagText === '🇨🇦' && detailsBits.tagTitle === 'Canada (CA)',
        JSON.stringify(detailsBits));
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(400);
      // The modal opens on the assessed-history bar chart; the old
      // BCA source line and HouseSigma status line are gone (the
      // elements themselves no longer exist).
      const histBits = await page.evaluate(() => {
        const modal = document.querySelector('#historyModal');
        const c = window.__fmCharts.history;
        const canvas = modal.querySelector('#historyChart');
        const rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
        return {
          text: modal.textContent,
          metaGone: !document.querySelector('#assessmentMetaView') && !document.querySelector('#hsPullNote')
            && !document.querySelector('#assessmentMeta'),
          labels: c ? c.data.labels : null,
          // A year's bar total is the sum over the stacked
          // datasets (Land + Building for a split year, the Total
          // dataset for a total-only one).
          values: c ? c.data.labels.map((_, i) => c.data.datasets.reduce((sum, ds) => sum + (ds.data[i] || 0), 0)) : null,
          sources: c ? c.data.datasets[0].pointMeta.map((p) => p.source) : null,
          canvasW: rect.width, canvasH: rect.height,
        };
      });
      H.check('the Assessment History modal carries no BCA source line and no HouseSigma status line',
        !histBits.text.includes('Source: BC Assessment') && !histBits.text.includes('HouseSigma history:')
          && histBits.metaGone,
        histBits.text.slice(0, 200));
      H.check('the Assessment History modal tops out with the history bar chart (one stack per point, ascending years)',
        !!histBits.values && histBits.values.length === vhNow.points.length
          && histBits.values.every((v, i) => v === vhNow.points[i].value)
          && histBits.labels.every((l, i) => l === String(vhNow.points[i].year))
          && histBits.sources.every((s, i) => s === vhNow.points[i].source)
          && histBits.canvasW > 0 && histBits.canvasH >= 150,
        JSON.stringify(histBits));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(300);
      // Edit -> change purchase date -> Save: back to read-only with
      // the new value, and the change is really persisted.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(300);
      H.check('Edit reveals the form', await page.evaluate(() => !document.querySelector('#propForm').classList.contains('hidden')));
      await page.evaluate(() => { document.querySelector('#propForm [name=purchase_date]').value = '2019-03-04'; });
      await page.evaluate(() => document.querySelector('#propForm [type=submit]').click());
      H.check('Save returns to the read-only view showing the new purchase date',
        await until(() => !document.querySelector('#propView').classList.contains('hidden')
          && document.querySelector('#propViewBody').textContent.includes('2019-03-04')));
      r = await H.req('GET', `/api/properties/${moneyPid}`);
      H.check('the saved purchase date persisted', r.data.purchase_date === '2019-03-04', JSON.stringify(r.data.purchase_date));
      // Edit -> change -> Cancel: nothing is written.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(300);
      await page.evaluate(() => { document.querySelector('#propForm [name=purchase_date]').value = '2000-01-01'; });
      await page.evaluate(() => document.querySelector('#cancelPropEditBtn').click());
      await wait(300);
      const afterCancel = await page.evaluate(() => document.querySelector('#propViewBody').textContent);
      H.check('Cancel discards the edit (view keeps the saved date)',
        afterCancel.includes('2019-03-04') && !afterCancel.includes('2000-01-01'), afterCancel.slice(0, 160));
      r = await H.req('GET', `/api/properties/${moneyPid}`);
      H.check('Cancel wrote nothing to the server', r.data.purchase_date === '2019-03-04', JSON.stringify(r.data.purchase_date));
      // Carousel: two uploads (via the API). The VIEW shows the
      // carousel alone (main photo + arrows + count — no thumbnail
      // strip, no Add/Remove buttons); photo management lives in
      // the Edit form. Autoplay is frozen for the deterministic
      // steps via a long test delay, then exercised on its own
      // below with a short one.
      const TINY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await H.req('POST', `/api/properties/${moneyPid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
      r = await H.req('POST', `/api/properties/${moneyPid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
      H.check('two photos uploaded for the carousel checks', r.data.photos.length === 2, JSON.stringify(r.data.photos));
      const [ph1, ph2] = r.data.photos;
      await page.evaluateOnNewDocument(() => { window.__fmPhotoDelay = 60000; });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1200);
      const viewBits = await page.evaluate(() => ({
        thumbs: document.querySelectorAll('#photoArea .photo-thumbs').length,
        dots: document.querySelectorAll('#photoArea [data-photo-dot]').length,
        addBtn: !!document.querySelector('#photoArea [data-photo-add-btn]'),
        removeBtn: !!document.querySelector('#photoArea [data-photo-remove]'),
        hasNav: !!document.querySelector('#photoArea [data-photo-nav="1"]'),
        count: (document.querySelector('#photoArea .carousel-count') || {}).textContent || '',
      }));
      H.check('view state: the carousel stands alone — arrows and count, no thumbnail strip, no Add/Remove buttons',
        viewBits.thumbs === 0 && viewBits.dots === 0 && !viewBits.addBtn && !viewBits.removeBtn
          && viewBits.hasNav && viewBits.count.trim() === '1 / 2',
        JSON.stringify(viewBits));
      const carSrc1 = await page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      H.check('gallery starts on the first photo', carSrc1 === ph1.src, String(carSrc1));
      await page.evaluate(() => document.querySelector('#photoArea [data-photo-nav="1"]').click());
      await wait(300);
      const carSrc2 = await page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      H.check('next arrow switches to the second photo', carSrc2 === ph2.src && carSrc2 !== carSrc1, String(carSrc2));
      // Open Edit: the management area is there — the thumbnail
      // strip, Add photos and Remove this photo.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(400);
      const mgmtBits = await page.evaluate(() => ({
        thumbs: document.querySelectorAll('#photoManage .photo-thumbs .thumb').length,
        addBtn: !!document.querySelector('#photoManage [data-photo-add-btn]'),
        removeBtn: !!document.querySelector('#photoManage [data-photo-remove]'),
        formVisible: !document.querySelector('#propForm').classList.contains('hidden'),
      }));
      H.check('Edit state: the photo management area shows the thumbnail strip plus Add/Remove',
        mgmtBits.formVisible && mgmtBits.thumbs === 2 && mgmtBits.addBtn && mgmtBits.removeBtn,
        JSON.stringify(mgmtBits));
      // A thumbnail click selects that photo in the carousel (the
      // carousel currently shows the second photo already; pick
      // the first thumbnail to see it switch back).
      await page.evaluate(() => document.querySelectorAll('#photoManage .photo-thumbs .thumb')[0].click());
      await wait(300);
      const carSrcBack = await page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      H.check('clicking the first thumbnail shows the first photo again', carSrcBack === ph1.src, String(carSrcBack));
      await page.evaluate(() => document.querySelectorAll('#photoManage .photo-thumbs .thumb')[1].click());
      await wait(300);
      // Remove the currently shown photo (the second) from Edit:
      // it applies at once, without the form's Save.
      await page.evaluate(() => document.querySelector('#photoManage [data-photo-remove]').click());
      H.check('removing from Edit leaves a one-photo gallery',
        await until(() => {
          const c = document.querySelector('#photoArea .carousel-count');
          return c && c.textContent.trim() === '1 / 1' && !document.querySelector('#photoArea .photo-thumbs');
        }));
      r = await H.req('GET', `/api/properties/${moneyPid}`);
      H.check('the removal persisted (one photo left, the first one)',
        r.data.photos.length === 1 && r.data.photos[0].id === ph1.id, JSON.stringify(r.data.photos));
      // Upload one more from the Edit form's Add photos (through
      // the file input; it too applies at once).
      const tmpPng = path.join(os.tmpdir(), `ff-e2e-photo-${Date.now()}.png`);
      fs.writeFileSync(tmpPng, Buffer.from(TINY, 'base64'));
      const fileInput = await page.$('#photoFiles');
      await fileInput.uploadFile(tmpPng);
      H.check('uploading from Edit adds the photo at once',
        await until(() => document.querySelectorAll('#photoManage .photo-thumbs .thumb').length === 2));
      r = await H.req('GET', `/api/properties/${moneyPid}`);
      H.check('the Edit upload persisted (two photos again)', r.data.photos.length === 2, JSON.stringify(r.data.photos.length));
      await page.evaluate(() => document.querySelector('#cancelPropEditBtn').click());
      await wait(300);
      // No-flash switch (regression for the old innerHTML
      // rebuild, which destroyed the old <img> and inserted a
      // fresh one that painted blank and collapsed the box until
      // it loaded): every slide is resident and preloaded before
      // any switch, the stage box never changes height across a
      // switch, and the node that becomes visible is the SAME
      // node that was preloaded — no destroy/rebuild.
      const flashBits = await page.evaluate(async () => {
        const stage = document.querySelector('#photoArea .photo-stage');
        const slides = [...document.querySelectorAll('#photoArea img.slide')];
        const h0 = stage.getBoundingClientRect().height;
        const target = slides[1];
        document.querySelector('#photoArea [data-photo-nav="1"]').click();
        await new Promise((r) => setTimeout(r, 350));
        const active = document.querySelector('#photoArea img.slide.active');
        return {
          nSlides: slides.length,
          allPreloaded: slides.every((i) => i.complete && i.naturalWidth > 0),
          h0, h1: stage.getBoundingClientRect().height,
          sameNode: active === target,
          activeComplete: !!active && active.complete && active.naturalWidth > 0,
        };
      });
      H.check('carousel switch never flashes: slides resident + preloaded, stage height constant, the visible slide is the preloaded node itself',
        flashBits.nSlides === 2 && flashBits.allPreloaded && flashBits.h0 === flashBits.h1 && flashBits.sameNode && flashBits.activeComplete,
        JSON.stringify(flashBits));
      // Layout: the photo fills the overview panel's full height
      // (no dead white space under it), the n / N counter rides on
      // the photo as an overlay chip, and the detail column spreads
      // its meta rows over the same height.
      const fillBits = await page.evaluate(() => {
        const R = (el) => (el ? el.getBoundingClientRect() : null);
        const stage = document.querySelector('#photoArea .photo-stage');
        const area = document.getElementById('photoArea');
        const det = document.querySelector('#propertyOverview .overview-details');
        const view = document.getElementById('propView');
        const bar = document.querySelector('#photoArea .carousel-bar');
        const chip = document.querySelector('#photoArea .carousel-count');
        const stats = document.querySelector('#propView .detail-stats');
        const rows = [...document.querySelectorAll('#propViewBody tr')];
        const sr = R(stage); const ar = R(area); const dr = R(det); const vr = R(view);
        const cr = R(chip); const str = R(stats);
        const rr = rows.map(R);
        return {
          stageH: sr && sr.height, areaH: ar && ar.height, detH: dr && dr.height,
          stageBottom: sr && sr.bottom, areaBottom: ar && ar.bottom,
          barPos: bar ? getComputedStyle(bar).position : null,
          chipInStage: !!(sr && cr && cr.top >= sr.top - 1 && cr.bottom <= sr.bottom + 1
            && Math.abs((cr.left + cr.right) / 2 - (sr.left + sr.right) / 2) < 4),
          statsBottom: str && str.bottom,
          firstRowTop: rr.length ? rr[0].top : null,
          lastRowBottom: rr.length ? rr[rr.length - 1].bottom : null,
          viewBottom: vr && vr.bottom,
          rowsSpread: rr.length > 1 && rr.every((r, i) => i === 0 || r.top >= rr[i - 1].bottom - 1),
        };
      });
      H.check('detail layout: the photo stage fills the panel height (no dead space under the photo)',
        fillBits.stageH >= 260 && Math.abs(fillBits.stageH - fillBits.areaH) < 3
          && Math.abs(fillBits.stageBottom - fillBits.areaBottom) < 2
          && Math.abs(fillBits.detH - fillBits.areaH) < 3,
        JSON.stringify(fillBits));
      H.check('detail layout: the n / N counter is a chip overlaid on the photo, not a line under it',
        fillBits.barPos === 'absolute' && fillBits.chipInStage,
        JSON.stringify(fillBits));
      H.check('detail layout: the meta rows spread over the full detail-column height',
        fillBits.rowsSpread && Math.abs(fillBits.lastRowBottom - fillBits.viewBottom) < 3
          && fillBits.firstRowTop >= fillBits.statsBottom - 2,
        JSON.stringify(fillBits));
      // Edit mode: the form is the taller column — the photo
      // stretches to match it too.
      await page.evaluate(() => document.querySelector('#editPropBtn').click());
      await wait(400);
      const editFill = await page.evaluate(() => {
        const stage = document.querySelector('#photoArea .photo-stage');
        const det = document.querySelector('#propertyOverview .overview-details');
        return {
          stageH: stage ? stage.getBoundingClientRect().height : 0,
          detH: det ? det.getBoundingClientRect().height : 0,
        };
      });
      H.check('detail layout: in Edit mode the photo stretches to the taller form column',
        editFill.stageH > fillBits.stageH + 40 && Math.abs(editFill.stageH - editFill.detH) < 4,
        JSON.stringify(editFill));
      await page.evaluate(() => document.querySelector('#cancelPropEditBtn').click());
      await wait(300);
      // Autoplay: a short test delay and a fresh load — the
      // carousel advances on its own, wraps at the end, yields
      // to a manual click (its timer resets), and pauses on
      // hover and on a hidden tab.
      await page.evaluateOnNewDocument(() => { window.__fmPhotoDelay = 400; });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(500);
      const autoSrc = () => page.evaluate(() => document.querySelector('#photoArea img.detail-photo').getAttribute('src'));
      const pollSrc = async (want, tries = 18) => {
        for (let i = 0; i < tries; i++) {
          if (want(await autoSrc())) return true;
          await wait(200);
        }
        return false;
      };
      const auto0 = await autoSrc();
      H.check('autoplay advances to the next photo on its own', await pollSrc((s) => s !== auto0));
      H.check('autoplay wraps back to the first photo', await pollSrc((s) => s === auto0));
      const beforeManual = await autoSrc();
      await page.evaluate(() => document.querySelector('#photoArea [data-photo-nav="1"]').click());
      await wait(120);
      const manualSrc = await autoSrc();
      H.check('a manual arrow click switches the photo', manualSrc !== beforeManual);
      await wait(250); // still inside the reset delay window (400ms)
      H.check('the manual choice is not immediately overridden by autoplay', (await autoSrc()) === manualSrc);
      const box = await page.evaluate(() => {
        const r = document.querySelector('#photoArea .photo-carousel').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 40 };
      });
      await page.mouse.move(box.x, box.y);
      const hoverSrc = await autoSrc();
      await wait(1000);
      H.check('hovering the carousel pauses autoplay', (await autoSrc()) === hoverSrc);
      await page.mouse.move(5, 5);
      H.check('moving the mouse away resumes autoplay', await pollSrc((s) => s !== hoverSrc));
      try {
        if (typeof page.emulateVisibilityState === 'function') {
          await page.emulateVisibilityState('hidden');
          const hidSrc = await autoSrc();
          await wait(1000);
          H.check('a hidden tab pauses autoplay', (await autoSrc()) === hidSrc);
          await page.emulateVisibilityState('visible');
        }
      } catch { /* visibility emulation unavailable in this browser build */ }
      try {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
        await wait(500);
        const rmSrc = await autoSrc();
        await wait(1100);
        H.check('prefers-reduced-motion disables autoplay', (await autoSrc()) === rmSrc);
        await page.emulateMediaFeatures([]);
      } catch { /* media emulation unavailable in this browser build */ }
      await page.evaluate(() => { window.__fmPhotoDelay = 60000; }); // freeze card covers for the checks below
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(2000);
      const cover = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        const img = card && card.querySelector('.photo img');
        return img ? img.getAttribute('src') : null;
      });
      H.check('the Properties card cover is the first gallery photo', cover === ph1.src, String(cover));
      const cardTag = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        const tag = card && card.querySelector('.addr .region-tag');
        return tag ? { text: tag.textContent, title: tag.getAttribute('title') } : null;
      });
      H.check('the Properties card carries the region flag tag beside its address',
        !!cardTag && cardTag.text === '🇨🇦' && cardTag.title === 'Canada (CA)',
        JSON.stringify(cardTag));
      // Card-cover carousel (the same PhotoCarousel as the
      // detail page): the 999 card holds two photos. Bring it
      // into view, re-arm its timer at the short test delay via
      // a manual click — the arrows work without navigating —
      // and it then auto-advances on its own.
      const cardSrc = () => page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        const img = card && card.querySelector('.photo img');
        return img ? img.getAttribute('src') : null;
      });
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        if (card) card.scrollIntoView({ block: 'center' });
      });
      await wait(600);
      await page.evaluate(() => { window.__fmPhotoDelay = 400; });
      const cs0 = await cardSrc();
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('999 Money Test Terrace'));
        card.querySelector('[data-photo-nav="1"]').click();
      });
      await wait(300);
      const cs1 = await cardSrc();
      const stillList = await page.evaluate(() => location.hash === '#assets/properties'
        && !document.querySelector('#view-assets').classList.contains('hidden'));
      H.check('card cover arrow switches the photo without navigating away',
        !!cs0 && !!cs1 && cs1 !== cs0 && stillList, JSON.stringify({ cs0, cs1, stillList }));
      const pollCard = async (want, tries = 18) => {
        for (let i = 0; i < tries; i++) { if (want(await cardSrc())) return true; await wait(200); }
        return false;
      };
      H.check('the card cover auto-advances on its own', await pollCard((s) => s !== cs1));
      // A single-photo card: no arrows, static. A fresh
      // property with exactly one photo, then re-render the list.
      r = await H.req('POST', '/api/properties', { address: '997 Single Photo Close', purchase_date: '2024-01-01' });
      const singlePid = r.data.id;
      await H.req('POST', `/api/properties/${singlePid}/photos`, { dataBase64: TINY, contentType: 'image/png' });
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(2500);
      const singleBits = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('997 Single Photo Close'));
        if (card) card.scrollIntoView({ block: 'center' });
        const img = card && card.querySelector('.photo img');
        return {
          src: img ? img.getAttribute('src') : null,
          navs: card ? card.querySelectorAll('[data-photo-nav]').length : -1,
        };
      });
      await wait(900);
      const singleSrc2 = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('997 Single Photo Close'));
        const img = card && card.querySelector('.photo img');
        return img ? img.getAttribute('src') : null;
      });
      H.check('a single-photo card shows no arrows and stays static',
        !!singleBits.src && singleBits.navs === 0 && singleSrc2 === singleBits.src,
        JSON.stringify({ singleBits, singleSrc2 }));

      // ---- Payment override, driven through the UI ----
      // $1,350,000 at 3.95% fixed over 30y derives $6,381.36.
      // The override is set by clicking Edit on the Monthly
      // payment figure itself (there is no standalone override
      // input): the figure becomes an input prefilled with the
      // used payment; typing $6,000 and saving must re-render
      // every payment surface the same way: the used amount bold,
      // the derived amount struck through beside it — term card
      // figure, modal metadata, detail stat and the Properties
      // card — and the projection must follow the override
      // trajectory. Clearing the editor restores the plain
      // derived figure everywhere, and so does Reset + Save.
      r = await H.req('POST', '/api/properties', {
        address: '777 Override UI Avenue, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2026-01-01', purchase_date: '2025-06-01', amortization_years: 30,
      });
      const ovUiPid = r.data.id;
      const ovUiTermId = r.data.terms[0].id;
      await H.req('POST', `/api/properties/${ovUiPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 3.95 });
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, ovUiPid);
      H.check('override UI fixture: the detail stat shows the derived payment plain',
        await until(() => document.querySelector('#estPaymentValue').textContent.includes('6,381')
          && !document.querySelector('#estPaymentValue s')));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const payRowState = () => page.evaluate(() => {
        const row = document.querySelector('[data-pay-block]');
        const input = row.querySelector('[name=payment_override]');
        const view = row.querySelector('[data-term-payment]');
        const ref = row.querySelector('[data-pay-derived-ref]');
        const struck = ref ? ref.querySelector('s') : null;
        return {
          inputHidden: input.classList.contains('hidden'),
          inputValue: input.value,
          viewHidden: view.classList.contains('hidden'),
          editHidden: row.querySelector('[data-pay-edit]').classList.contains('hidden'),
          resetHidden: row.querySelector('[data-pay-reset]').classList.contains('hidden'),
          refText: ref ? ref.textContent : null,
          refStruck: struck ? struck.textContent : null,
        };
      });
      const atRest = await payRowState();
      H.check('the payment row rests as figure + Edit (editor input hidden, no override → no Reset)',
        atRest.inputHidden && !atRest.viewHidden && !atRest.editHidden && atRest.resetHidden && atRest.inputValue === '',
        JSON.stringify(atRest));
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      const editing = await payRowState();
      H.check('Edit opens the inline editor in place: input prefilled with the used payment, the calculated figure muted beside it, still no Reset',
        !editing.inputHidden && editing.viewHidden && editing.editHidden && editing.resetHidden
          && editing.inputValue === '6,381.36' && editing.refText.includes('6,381') && editing.refStruck === null,
        JSON.stringify(editing));
      await page.keyboard.type('6000');
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      const tripleOf = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const struck = el.querySelector('s');
        return {
          text: el.textContent,
          used: (el.querySelector('.pay-used') || {}).textContent || null,
          struckText: struck ? struck.textContent : null,
          struckStyle: struck ? getComputedStyle(struck).textDecorationLine : null,
        };
      }, sel);
      const untilNode = async (fn, tries = 40) => {
        for (let i = 0; i < tries; i++) { if (await fn()) return true; await wait(300); }
        return false;
      };
      H.check('override saved in the term form: the term card figure shows $6,000.00 bold with $6,381.36 struck through',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          return !!t && t.used === '$6,000.00' && t.struckText === '$6,381.36' && String(t.struckStyle).includes('line-through');
        }));
      const metaTriple = await tripleOf('#metaCurrentPayment');
      H.check('the modal metadata Current Monthly Payment shows the same override rendering',
        !!metaTriple && metaTriple.used === '$6,000.00' && metaTriple.struckText === '$6,381.36'
          && String(metaTriple.struckStyle).includes('line-through'),
        JSON.stringify(metaTriple));
      const statTriple = await tripleOf('#estPaymentValue');
      H.check('the detail stat Estimated monthly payment shows the same override rendering',
        !!statTriple && statTriple.used === '$6,000.00' && statTriple.struckText === '$6,381.36'
          && String(statTriple.struckStyle).includes('line-through'),
        JSON.stringify(statTriple));
      const ovUiProj = (await H.req('GET', `/api/properties/${ovUiPid}/amortization`)).data;
      const ovUiEngine = engineSchedule({
        balance: 1350000, balanceDate: '2026-01-01',
        terms: [{ id: ovUiTermId, start_date: '2026-01-01', amortization_years: 30, payment_override: 6000 }],
        segments: [{ id: 1, start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 3.95 }],
      });
      H.check('the UI-saved override drives the projection (API payoff/interest match the engine override run)',
        ovUiProj.paymentUsed === 6000 && ovUiProj.paymentDerived === 6381.36 && ovUiProj.paymentOverridden === true
          && ovUiProj.payoffMonth === ovUiEngine.payoffMonth && ovUiProj.totalInterest === ovUiEngine.totalInterest,
        JSON.stringify({ p: ovUiProj.payoffMonth, i: ovUiProj.totalInterest, ep: ovUiEngine.payoffMonth, ei: ovUiEngine.totalInterest }));
      // The segment editor's live preview inside the overridden
      // term: the previewed payment is the override, derived
      // struck through beside it.
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(400);
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        form.start_date.value = '2027-01-01';
        form.start_date.dispatchEvent(new Event('input', { bubbles: true }));
        const rate = form.querySelector('[name=annual_rate]');
        rate.value = '4.5';
        rate.dispatchEvent(new Event('input', { bubbles: true }));
      });
      H.check('the live plan preview inside the overridden term shows the override with the derived struck through',
        await until(() => {
          const out = document.querySelector('[data-plan-preview]');
          return !!out && out.textContent.includes('payment') && out.textContent.includes('6,000')
            && !!out.querySelector('s');
        }));
      await page.evaluate(() => document.querySelector('#mortgageModal [data-close-modal]').click());
      await wait(300);
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(2000);
      const cardPay = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#propertyCards .card')]
          .find((c) => c.textContent.includes('777 Override UI Avenue'));
        if (!card) return null;
        const kv = [...card.querySelectorAll('.kv')].find((x) => x.querySelector('.k') && x.querySelector('.k').textContent === 'Monthly payment');
        const struck = kv ? kv.querySelector('s') : null;
        return { text: kv ? kv.textContent : null, struckText: struck ? struck.textContent : null };
      });
      H.check('the Properties card shows the override payment with the derived struck through',
        !!cardPay && cardPay.text.includes('6,000') && cardPay.struckText === '$6,381.36',
        JSON.stringify(cardPay));
      // Clear the override through the same editor: figures
      // return to the plain derived payment, strikethrough gone.
      // Opening the editor on the overridden term first: the
      // input is prefilled with the used $6,000, the calculated
      // figure stands struck through beside it and Reset shows.
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, ovUiPid);
      await wait(1500);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      const editingOv = await payRowState();
      H.check('on an overridden term the editor prefills the used payment, the calculated figure is struck through beside it, and Reset is offered',
        !editingOv.inputHidden && editingOv.inputValue === '6,000' && editingOv.refStruck === '$6,381.36' && !editingOv.resetHidden,
        JSON.stringify(editingOv));
      await page.keyboard.press('Backspace');
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      H.check('clearing the override restores the plain derived figure (no strikethrough anywhere)',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          const m = await tripleOf('#metaCurrentPayment');
          const s = await tripleOf('#estPaymentValue');
          return !!t && !!m && !!s
            && t.text.includes('6,381') && t.struckText === null
            && m.text.includes('6,381') && m.struckText === null
            && s.text.includes('6,381') && s.struckText === null;
        }));
      const ovUiCleared = (await H.req('GET', `/api/properties/${ovUiPid}/amortization`)).data;
      H.check('after the UI clear, the API projection is the derived one again',
        ovUiCleared.paymentUsed === 6381.36 && ovUiCleared.paymentOverridden === false,
        JSON.stringify({ u: ovUiCleared.paymentUsed, o: ovUiCleared.paymentOverridden }));
      // Reset path: set the override once more, then in the
      // editor click Reset — the box returns to the calculated
      // figure and saving clears the override (a figure equal to
      // the calculated one IS the calculated one).
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      await page.keyboard.type('6000');
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      H.check('the override is set again for the Reset path',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          return !!t && t.used === '$6,000.00' && t.struckText === '$6,381.36';
        }));
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-edit]').click());
      await wait(200);
      await page.evaluate(() => document.querySelector('[data-pay-block] [data-pay-reset]').click());
      await wait(200);
      const afterReset = await payRowState();
      H.check('Reset puts the calculated figure back in the editor box',
        afterReset.inputValue === '6,381.36' && !afterReset.inputHidden,
        JSON.stringify(afterReset));
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      H.check('saving after Reset clears the override (figure plain again, editor back at rest)',
        await untilNode(async () => {
          const t = await tripleOf('[data-pay-block] [data-term-payment]');
          const st = await payRowState();
          return !!t && t.text.includes('6,381') && t.struckText === null && st.inputHidden && st.inputValue === '';
        }));
      const ovUiReset = (await H.req('GET', `/api/properties/${ovUiPid}/amortization`)).data;
      H.check('after Reset + Save the API projection is the derived one',
        ovUiReset.paymentUsed === 6381.36 && ovUiReset.paymentOverridden === false,
        JSON.stringify({ u: ovUiReset.paymentUsed, o: ovUiReset.paymentOverridden }));
      await H.req('DELETE', `/api/properties/${ovUiPid}`);

      // ---- Payment override on a WEEKLY term: per-period input ----
      // The Riverbend case: $477,885.10 at 3.90% fixed over 22y
      // derives $2,691.22/month = $621.05/week. The override
      // editor on a weekly term takes the WEEKLY amount: typing
      // 592.68 must store the monthly equivalent 2,568.28 (never
      // 592.68 as a monthly override), the row shows the weekly
      // figures with the monthly equivalent beside them, and the
      // monthly surfaces (modal metadata, detail stat) keep
      // showing the monthly figures. Typing the weekly equivalent
      // of the derived payment (621.05) clears the override.
      // Fixture dates sit at 2025-06-01 and selectors are scoped
      // to this term's id. The new property reuses the deleted
      // 777 fixture's id (no AUTOINCREMENT), so the first hash
      // assignment below may be a no-op — the navigation guard
      // after it steps away and back so the route always runs
      // for this property instead of showing the deleted
      // fixture's stale state.
      r = await H.req('POST', '/api/properties', {
        address: '999 Weekly Override Lane, Victoria, BC',
        mortgage_balance: 477885.10, mortgage_balance_date: '2025-06-01', purchase_date: '2025-06-01', amortization_years: 22,
      });
      const wkPid = r.data.id;
      const wkTermId = r.data.terms[0].id;
      await H.req('POST', `/api/properties/${wkPid}/rates`, { start_date: '2025-06-01', rate_type: 'fixed', annual_rate: 3.90 });
      r = await H.req('PUT', `/api/properties/${wkPid}/terms/${wkTermId}`, { payment_frequency: 'weekly' });
      H.check('weekly override fixture: the term takes the weekly frequency',
        r.status === 200 && r.data.payment_frequency === 'weekly',
        JSON.stringify({ s: r.status, f: r.data && r.data.payment_frequency }));
      const wkAmort = (await H.req('GET', `/api/properties/${wkPid}/amortization`)).data;
      H.check('weekly override fixture: the API derives $2,691.22/month ($621.05/week)',
        wkAmort.paymentDerived === 2691.22 && wkAmort.periodPayment === 621.05,
        JSON.stringify({ d: wkAmort.paymentDerived, p: wkAmort.periodPayment }));
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, wkPid);
      await wait(1500);
      // The new property reuses the deleted 777 fixture's id
      // (no AUTOINCREMENT), so the hash above may already have
      // been this property's — a no-op assignment fires no
      // hashchange and the page keeps showing the deleted
      // fixture's stale state. Step away and back so the route
      // always runs for this property.
      const wkOnPage = await page.evaluate(() => {
        const v = document.querySelector('[data-term-payment]');
        return !!v && v.textContent.includes('621.05');
      });
      if (!wkOnPage) {
        await page.evaluate(() => { location.hash = '#assets/properties'; });
        await wait(800);
        await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, wkPid);
        await wait(1500);
      }
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const wkPaySel = `[data-pay-block="${wkTermId}"]`;
      const wkTermSel = `[data-term-form="${wkTermId}"]`;
      const wkPayRowState = () => page.evaluate((sel) => {
        const row = document.querySelector(sel);
        const input = row.querySelector('[name=payment_override]');
        const view = row.querySelector('[data-term-payment]');
        const ref = row.querySelector('[data-pay-derived-ref]');
        const struck = ref ? ref.querySelector('s') : null;
        return {
          inputHidden: input.classList.contains('hidden'),
          inputValue: input.value,
          viewHidden: view.classList.contains('hidden'),
          editHidden: row.querySelector('[data-pay-edit]').classList.contains('hidden'),
          resetHidden: row.querySelector('[data-pay-reset]').classList.contains('hidden'),
          refText: ref ? ref.textContent : null,
          refStruck: struck ? struck.textContent : null,
        };
      }, wkPaySel);
      const payLabel = () => page.evaluate((sel) => {
        const l = document.querySelector(`${sel} [data-pay-label]`);
        return l ? l.textContent : null;
      }, wkPaySel);
      H.check('the weekly term\'s pay row is labeled "Weekly payment ($)"',
        (await payLabel()) === 'Weekly payment ($)',
        await payLabel());
      H.check('the weekly term\'s pay row shows the weekly derived figure with the monthly equivalent, no strikethrough',
        await untilNode(async () => {
          const t = await tripleOf(`${wkPaySel} [data-term-payment]`);
          return !!t && t.text.includes('621.05') && t.text.includes('2,691.22') && t.struckText === null;
        }));
      await page.evaluate((sel) => document.querySelector(`${sel} [data-pay-edit]`).click(), wkPaySel);
      await wait(200);
      const editingWk = await wkPayRowState();
      H.check('Edit on a weekly term prefills the WEEKLY used payment with the weekly derived figure as reference',
        !editingWk.inputHidden && editingWk.inputValue === '621.05' && editingWk.refText.includes('621.05') && editingWk.refStruck === null,
        JSON.stringify(editingWk));
      await page.keyboard.type('592.68');
      await page.evaluate((sel) => document.querySelector(sel).requestSubmit(), wkTermSel);
      // The row poll below is the readiness signal — the submit
      // handler is async, so a GET read straight after it can
      // still see the pre-save state.
      H.check('the weekly pay row shows $592.68/week used with $621.05/week struck through and the monthly equivalent',
        await untilNode(async () => {
          const t = await tripleOf(`${wkPaySel} [data-term-payment]`);
          return !!t && t.used === '$592.68' && t.struckText === '$621.05' && t.text.includes('2,568.28');
        }));
      const wkTerm = (await H.req('GET', `/api/properties/${wkPid}`)).data.terms.find((t) => t.id === wkTermId);
      H.check('entering 592.68 on the weekly term stores the monthly equivalent 2,568.28 as the override',
        wkTerm.payment_override === 2568.28,
        JSON.stringify({ o: wkTerm.payment_override }));
      const wkMeta = await tripleOf('#metaCurrentPayment');
      H.check('the modal metadata still shows the MONTHLY override figures',
        !!wkMeta && wkMeta.used === '$2,568.28' && wkMeta.struckText === '$2,691.22',
        JSON.stringify(wkMeta));
      const wkStat = await tripleOf('#estPaymentValue');
      H.check('the detail stat still shows the MONTHLY override figures',
        !!wkStat && wkStat.used === '$2,568.28' && wkStat.struckText === '$2,691.22',
        JSON.stringify(wkStat));
      // The live plan preview inside the weekly term: the
      // previewed payment is the override — as the MONTH's total
      // of weekly payments, not the $592.68 typed in the box. The
      // draft is a variable Prime − 1 switch on 2027-01-01 (a
      // variable switch never recasts the payment, so the override
      // survives it); January 2027 holds five weekly paydays, so
      // the month totals 5 × $592.68 = $2,963.40, with the derived
      // 5 × $621.05 = $3,105.25 struck through.
      await page.evaluate((id) => document.querySelector(`[data-term-block="${id}"] [data-toggle-seg]`).click(), wkTermId);
      await wait(400);
      await page.evaluate((id) => {
        const form = document.querySelector(`[data-term-block="${id}"] [data-seg-form]`);
        const set = (name, value, evt) => {
          const el = form.querySelector(`[name=${name}]`);
          el.value = value;
          el.dispatchEvent(new Event(evt, { bubbles: true }));
        };
        set('rate_type', 'variable', 'change');
        set('rate_mode', 'prime_spread', 'change');
        set('spread', '-1', 'input');
        form.start_date.value = '2027-01-01';
        form.start_date.dispatchEvent(new Event('input', { bubbles: true }));
      }, wkTermId);
      H.check('the live plan preview inside the weekly term shows the override month total with the derived struck through',
        await untilNode(() => page.evaluate((id) => {
          const out = document.querySelector(`[data-term-block="${id}"] [data-plan-preview]`);
          const struck = out && out.querySelector('s');
          return !!out && out.textContent.includes('2,963.40')
            && !!struck && struck.textContent.includes('3,105.25');
        }, wkTermId)));
      // Edit on the overridden weekly term: prefill is the
      // weekly used figure, the reference is the weekly derived
      // figure struck through, and Reset puts the weekly derived
      // figure back in the box — saving then clears the override.
      await page.evaluate((sel) => document.querySelector(`${sel} [data-pay-edit]`).click(), wkPaySel);
      await wait(200);
      const editingWkOv = await wkPayRowState();
      H.check('on the overridden weekly term the editor prefills the weekly used payment with the weekly derived struck through',
        !editingWkOv.inputHidden && editingWkOv.inputValue === '592.68' && editingWkOv.refStruck === '$621.05' && !editingWkOv.resetHidden,
        JSON.stringify(editingWkOv));
      await page.evaluate((sel) => document.querySelector(`${sel} [data-pay-reset]`).click(), wkPaySel);
      await wait(200);
      const afterWkReset = await wkPayRowState();
      H.check('Reset on a weekly term puts the WEEKLY calculated figure back in the editor box',
        afterWkReset.inputValue === '621.05' && !afterWkReset.inputHidden,
        JSON.stringify(afterWkReset));
      await page.evaluate((sel) => document.querySelector(sel).requestSubmit(), wkTermSel);
      H.check('saving the weekly derived figure clears the override (row plain again, editor back at rest)',
        await untilNode(async () => {
          const t = await tripleOf(`${wkPaySel} [data-term-payment]`);
          const st = await wkPayRowState();
          return !!t && t.text.includes('621.05') && t.struckText === null && st.inputHidden && st.inputValue === '';
        }));
      const wkCleared = (await H.req('GET', `/api/properties/${wkPid}/amortization`)).data;
      H.check('after the weekly clear, the API projection is the derived one again',
        wkCleared.paymentUsed === 2691.22 && wkCleared.paymentOverridden === false,
        JSON.stringify({ u: wkCleared.paymentUsed, o: wkCleared.paymentOverridden }));
      // Changing the frequency mid-edit re-expresses the box:
      // with the editor open on 621.05/week, switching to
      // monthly turns the box into 2,691.22 (the same money) —
      // saving then clears the override instead of mis-saving
      // 621.05 as a monthly override.
      await page.evaluate((sel) => document.querySelector(`${sel} [data-pay-edit]`).click(), wkPaySel);
      await wait(200);
      await page.evaluate((sel) => {
        const form = document.querySelector(sel);
        const s = form.querySelector('[name=payment_frequency]');
        s.value = 'monthly';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, wkTermSel);
      await wait(200);
      const afterFreqChange = await wkPayRowState();
      H.check('switching frequency mid-edit re-expresses the editor box in the new frequency and renames its label',
        afterFreqChange.inputValue === '2,691.22' && (await payLabel()) === 'Monthly payment ($)',
        JSON.stringify(afterFreqChange));
      await page.evaluate((sel) => document.querySelector(sel).requestSubmit(), wkTermSel);
      // Poll the row to the post-save plain monthly state first —
      // the submit handler is async, so a GET read straight
      // after it can still see the pre-save frequency.
      await untilNode(async () => {
        const t = await tripleOf(`${wkPaySel} [data-term-payment]`);
        const st = await wkPayRowState();
        return !!t && t.text.includes('2,691.22') && t.struckText === null && st.inputHidden;
      });
      const wkMonthly = (await H.req('GET', `/api/properties/${wkPid}`)).data.terms.find((t) => t.id === wkTermId);
      H.check('saving after the mid-edit frequency switch keeps the term monthly with no override',
        wkMonthly.payment_frequency === 'monthly' && wkMonthly.payment_override === null,
        JSON.stringify({ f: wkMonthly.payment_frequency, o: wkMonthly.payment_override }));
      await H.req('DELETE', `/api/properties/${wkPid}`);

      // ---- Segment compounding, driven through the UI ----
      // A Prime - 1 segment on $1,350,000 (balance dated
      // 2025-12-01, so the first projected months price at the
      // stub history's pinned 4.45 → 3.45%): added as Semi-annual,
      // deleted and re-added as Monthly — the segment row chip,
      // the first month's interest and the derived payment all
      // follow the convention; switching back restores the semi
      // figures.
      r = await H.req('POST', '/api/properties', {
        address: '888 Compounding UI Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2025-12-01', purchase_date: '2025-06-01', amortization_years: 30,
      });
      const cmpUiPid = r.data.id;
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, cmpUiPid);
      await wait(1500);
      const ensureMortgageModal = async () => {
        const open = await page.evaluate(() => !document.querySelector('#mortgageModal').classList.contains('hidden'));
        if (!open) { await page.evaluate(() => document.querySelector('#openMortgageBtn').click()); await wait(800); }
      };
      const chipText = () => page.evaluate(() => {
        const chip = document.querySelector('.seg-table .badge.cmp');
        return chip ? chip.textContent : null;
      });
      const fillSegForm = async (compounding) => {
        await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
        await wait(400);
        await page.evaluate((cmp) => {
          const form = document.querySelector('[data-seg-form]');
          form.start_date.value = '2025-12-01';
          const type = form.querySelector('[name=rate_type]');
          type.value = 'variable';
          type.dispatchEvent(new Event('change', { bubbles: true }));
          const mode = form.querySelector('[name=rate_mode]');
          mode.value = 'prime_spread';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          const spread = form.querySelector('[name=spread]');
          spread.value = '-1';
          spread.dispatchEvent(new Event('input', { bubbles: true }));
          const sel = form.querySelector('[name=compounding]');
          sel.value = cmp;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, compounding);
      };
      await ensureMortgageModal();
      await fillSegForm('semi_annual');
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      H.check('segment added via the UI carries the Semi-annual chip',
        await untilNode(async () => (await chipText()) === 'Semi-annual'));
      const cmpSemiProj = (await H.req('GET', `/api/properties/${cmpUiPid}/amortization`)).data;
      H.check('the semi-annual projection prices the first month at the semi-annual monthly rate',
        Math.abs(cmpSemiProj.series[0].interest - Math.round(1350000 * engineMonthlyRate(3.45) * 100) / 100) < 0.02
          && cmpSemiProj.paymentUsed === engineDerive(1350000, 3.45, 30),
        JSON.stringify({ i: cmpSemiProj.series[0].interest, p: cmpSemiProj.paymentUsed }));
      // Switch to Monthly: delete the segment and re-add it with
      // the Monthly compounding selected.
      await page.evaluate(() => document.querySelector('[data-del-seg]').click());
      H.check('the segment deletes through the UI',
        await untilNode(async () => (await chipText()) === null));
      await ensureMortgageModal();
      await fillSegForm('monthly');
      H.check('the live preview follows the compounding select (monthly interest shows before saving)',
        await until(() => {
          const out = document.querySelector('[data-plan-preview]');
          return !!out && out.textContent.includes('3,881');
        }));
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      H.check('the re-added segment carries the Monthly chip',
        await untilNode(async () => (await chipText()) === 'Monthly'));
      const cmpMonthlyProj = (await H.req('GET', `/api/properties/${cmpUiPid}/amortization`)).data;
      H.check('the monthly projection: first interest is exactly 1,350,000 x 3.45%/12 = 3,881.25 and the derived payment follows',
        cmpMonthlyProj.series[0].interest === 3881.25
          && cmpMonthlyProj.paymentUsed === engineDerive(1350000, 3.45, 30, 'monthly')
          && cmpMonthlyProj.paymentUsed !== cmpSemiProj.paymentUsed,
        JSON.stringify({ i: cmpMonthlyProj.series[0].interest, p: cmpMonthlyProj.paymentUsed }));
      // Switch back to Semi-annual: figures restore.
      await page.evaluate(() => document.querySelector('[data-del-seg]').click());
      await untilNode(async () => (await chipText()) === null);
      await ensureMortgageModal();
      await fillSegForm('semi_annual');
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      H.check('the segment switched back carries the Semi-annual chip',
        await untilNode(async () => (await chipText()) === 'Semi-annual'));
      const cmpBackProj = (await H.req('GET', `/api/properties/${cmpUiPid}/amortization`)).data;
      H.check('switching back restores the semi-annual projection to the row',
        JSON.stringify(cmpBackProj.series) === JSON.stringify(cmpSemiProj.series)
          && cmpBackProj.paymentUsed === cmpSemiProj.paymentUsed,
        JSON.stringify({ p: cmpBackProj.paymentUsed }));
      await H.req('DELETE', `/api/properties/${cmpUiPid}`);

      // ---- Segment Locked on, driven through the UI ----
      // His real shape (the API section's fixture): the segment
      // starts with no lock and the figure is the funding-day
      // derivation $6,800; the pay block no longer carries any
      // pricing-date input — the lock lives on the segment.
      // Setting Locked on to the letter date (2024-12-10) in the
      // segment's edit form and saving re-derives the figure to
      // $7,206; clearing restores $6,800. The saved value echoes
      // in the edit form after the save reload.
      r = await H.req('POST', '/api/properties', {
        address: '14 Pricing Date UI Road, Victoria, BC',
        mortgage_balance: 1450000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17', amortization_years: 30,
      });
      const pdUiPid = r.data.id;
      await H.req('POST', `/api/properties/${pdUiPid}/rates`, {
        start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'monthly',
      });
      await H.req('POST', `/api/properties/${pdUiPid}/lump-sums`, { date: '2024-12-20', amount: 100000 });
      // Detour + full goto (the deleted compounding fixture's id
      // is reused by this property, so a bare hash jump may name
      // the page already showing and navigate nowhere — the same
      // trap the remaining-balance section documents).
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(800);
      await page.goto(`http://ff.local/#property/${pdUiPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      H.check('locked-on UI fixture: the detail stat shows the blank derivation $6,800',
        await until(() => document.querySelector('#estPaymentValue').textContent.includes('6,800')));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const pdBlock = await page.evaluate(() => {
        const block = document.querySelector('[data-pay-block]');
        return {
          hasPricingInput: !!block.querySelector('[name=payment_pricing_date]'),
          figure: block.querySelector('[data-term-payment]').textContent,
        };
      });
      H.check('the pay block carries no pricing-date input anymore (the lock moved to the segment)',
        pdBlock.hasPricingInput === false && pdBlock.figure.includes('6,800'),
        JSON.stringify(pdBlock));
      const pdSegState = () => page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const input = form.querySelector('[name=locked_on]');
        const cell = form.querySelector('[data-seg-spread]');
        const label = input ? [...form.querySelectorAll('label')].find((l) => l.textContent === 'Locked on') : null;
        return {
          value: input ? input.value : null,
          cellHidden: cell ? cell.classList.contains('hidden') : null,
          hasLabel: !!label,
          editSeg: form.dataset.editSeg || null,
        };
      });
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(500);
      const pdSegRest = await pdSegState();
      H.check('editing the prime-spread segment shows a blank Locked on date input in the (visible) spread cell',
        pdSegRest.value === '' && pdSegRest.cellHidden === false && pdSegRest.hasLabel && !!pdSegRest.editSeg,
        JSON.stringify(pdSegRest));
      await page.evaluate(() => {
        const input = document.querySelector('[data-seg-form] [name=locked_on]');
        input.value = '2024-12-10';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      H.check('setting Locked on to the letter date re-derives the figure to $7,205.89 after Save',
        await untilNode(async () => {
          const s = await page.evaluate(() => document.querySelector('[data-term-payment]').textContent);
          return s.includes('7,205.89');
        }));
      const pdUiProj = (await H.req('GET', `/api/properties/${pdUiPid}/amortization`)).data;
      H.check('the UI-saved lock drives the API derivation (7,205.89)',
        pdUiProj.paymentDerived === 7205.89, JSON.stringify({ d: pdUiProj.paymentDerived }));
      const pdUiProp = (await H.req('GET', `/api/properties/${pdUiPid}`)).data;
      H.check('the lock is stored on the segment (echoed in the payload, with its row badge)',
        pdUiProp.segments[0].locked_on === '2024-12-10', JSON.stringify(pdUiProp.segments[0]));
      const pdBadge = await page.evaluate(() => {
        const row = document.querySelector('#segmentRows tr');
        return row ? row.textContent : '';
      });
      H.check('the segment row shows the Locked badge with the date',
        pdBadge.includes('Locked 2024-12-10'), String(pdBadge));
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(500);
      const pdSegSaved = await pdSegState();
      H.check('reopening the segment edit shows the saved Locked on date',
        pdSegSaved.value === '2024-12-10', JSON.stringify(pdSegSaved));
      await page.evaluate(() => {
        const input = document.querySelector('[data-seg-form] [name=locked_on]');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      H.check('clearing Locked on restores the $6,800 figure after Save',
        await untilNode(async () => {
          const s = await page.evaluate(() => document.querySelector('[data-term-payment]').textContent);
          return s.includes('6,800');
        }));
      await H.req('DELETE', `/api/properties/${pdUiPid}`);

      // ---- Segment editing, driven through the UI ----
      // One Prime - 1 semi-annual segment on $1,350,000 (balance
      // dated 2025-12-01; the stub prime pins 4.45, so the segment
      // runs at 3.45%). Its row's Edit button loads it into the
      // segment form prefilled and in edit mode; changing the
      // spread to -2 and the compounding to Monthly and saving
      // updates the SAME segment (count and id unchanged) and the
      // projection follows; Cancel drops back to add mode without
      // touching the segment; delete + add still work afterwards.
      r = await H.req('POST', '/api/properties', {
        address: '21 Segment Edit Road, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2025-12-01', purchase_date: '2025-06-01', amortization_years: 30,
      });
      const segEditPid = r.data.id;
      await H.req('POST', `/api/properties/${segEditPid}/rates`, {
        start_date: '2025-12-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'semi_annual',
      });
      const segEditBefore = (await H.req('GET', `/api/properties/${segEditPid}`)).data;
      const segEditId = segEditBefore.segments[0].id;
      const segBaseProj = (await H.req('GET', `/api/properties/${segEditPid}/amortization`)).data;
      H.check('segment-edit fixture: one semi-annual Prime - 1 segment, derived payment at 3.45%',
        segEditBefore.segments.length === 1 && segBaseProj.paymentUsed === engineDerive(1350000, 3.45, 30),
        JSON.stringify({ n: segEditBefore.segments.length, p: segBaseProj.paymentUsed }));
      // Same-term start_date uniqueness, API level: a second
      // segment on the same start in the same term is a 400, on
      // add and on edit alike (an edit excludes itself).
      r = await H.req('POST', `/api/properties/${segEditPid}/rates`, {
        start_date: '2025-12-01', rate_type: 'fixed', annual_rate: 5,
      });
      H.check('adding a second segment on the same start date in the same term is rejected (400)',
        r.status === 400, JSON.stringify(r.data));
      r = await H.req('POST', `/api/properties/${segEditPid}/rates`, {
        start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 5,
      });
      H.check('a segment on a different start date adds fine', r.status === 201, JSON.stringify(r.data));
      const segEditOther = r.data.id;
      r = await H.req('PUT', `/api/properties/${segEditPid}/rates/${segEditOther}`, { start_date: '2025-12-01' });
      H.check('editing a segment onto a taken start date is rejected (400)',
        r.status === 400, JSON.stringify(r.data));
      r = await H.req('PUT', `/api/properties/${segEditPid}/rates/${segEditOther}`, { annual_rate: 5.5 });
      H.check('editing a segment while keeping its own start date passes (itself excluded)',
        r.status === 200 && r.data.annual_rate === 5.5, JSON.stringify(r.data));
      await H.req('DELETE', `/api/properties/${segEditPid}/rates/${segEditOther}`);
      // Detour + full goto, as in the pricing-date section (id
      // reuse makes bare hash jumps unreliable).
      await page.evaluate(() => { location.hash = '#assets/properties'; });
      await wait(800);
      await page.goto(`http://ff.local/#property/${segEditPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const segFormState = () => page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const submit = form.querySelector('[data-seg-submit]');
        const cancel = form.querySelector('[data-seg-cancel-edit]');
        return {
          hidden: form.classList.contains('hidden'),
          editSeg: form.dataset.editSeg || null,
          submitLabel: submit ? submit.textContent.trim() : null,
          cancelHidden: cancel ? cancel.classList.contains('hidden') : null,
          start: form.start_date.value, type: form.rate_type.value, mode: form.rate_mode.value,
          spread: form.spread.value, compounding: form.compounding.value,
        };
      });
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(400);
      const segEditState = await segFormState();
      H.check('Edit opens the segment form prefilled, in edit mode (Save segment + Cancel edit)',
        segEditState.hidden === false && segEditState.editSeg === String(segEditId)
          && segEditState.submitLabel === 'Save segment' && segEditState.cancelHidden === false
          && segEditState.start === '2025-12-01' && segEditState.type === 'variable'
          && segEditState.mode === 'prime_spread' && segEditState.spread === '-1'
          && segEditState.compounding === 'semi_annual',
        JSON.stringify(segEditState));
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const spread = form.querySelector('[name=spread]');
        spread.value = '-2';
        spread.dispatchEvent(new Event('input', { bubbles: true }));
        const cmp = form.querySelector('[name=compounding]');
        cmp.value = 'monthly';
        cmp.dispatchEvent(new Event('change', { bubbles: true }));
        form.requestSubmit();
      });
      // The row's rate text shows the segment formula and what
      // it resolves to at the CURRENT prime (stub latest 4.95,
      // so Prime - 2 reads 2.95) — the projection figure, priced
      // at the start month's prime, is asserted separately.
      H.check('the edited segment re-renders in place (Monthly chip, Prime - 2.00% (now 2.95%))',
        await untilNode(async () => page.evaluate(() => {
          const chip = document.querySelector('.seg-table .badge.cmp');
          const row = document.querySelector('.seg-table tbody tr');
          return !!chip && chip.textContent === 'Monthly' && !!row && row.textContent.includes('Prime − 2.00%') && row.textContent.includes('2.95');
        })));
      const segEditAfter = (await H.req('GET', `/api/properties/${segEditPid}`)).data;
      H.check('the save updated the same segment (count and id unchanged, new spread + compounding)',
        segEditAfter.segments.length === 1 && segEditAfter.segments[0].id === segEditId
          && segEditAfter.segments[0].spread === -2 && segEditAfter.segments[0].compounding === 'monthly',
        JSON.stringify(segEditAfter.segments));
      const segEditProj = (await H.req('GET', `/api/properties/${segEditPid}/amortization`)).data;
      H.check('the projection follows the edited segment (Prime - 2 at monthly compounding)',
        segEditProj.paymentUsed === engineDerive(1350000, 2.45, 30, 'monthly')
          && segEditProj.paymentUsed !== segBaseProj.paymentUsed,
        JSON.stringify({ p: segEditProj.paymentUsed, base: segBaseProj.paymentUsed }));
      // Cancel: an edit abandoned mid-way changes nothing and
      // the form returns to add mode.
      await page.evaluate(() => document.querySelector('[data-edit-seg]').click());
      await wait(400);
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        const spread = form.querySelector('[name=spread]');
        spread.value = '-0.5';
        spread.dispatchEvent(new Event('input', { bubbles: true }));
        // A click INSIDE the form (into another field) must not
        // reset the in-progress edit — regression: the form
        // itself carries data-edit-seg in edit mode, and a bare
        // attribute match in the click delegate once re-entered
        // edit mode (re-prefilling) on any form-internal click.
        form.querySelector('[name=start_date]').click();
      });
      await wait(200);
      const segMidState = await segFormState();
      H.check('clicking inside the edit form keeps the in-progress edit (spread still -0.5, still editing)',
        segMidState.editSeg === String(segEditId) && segMidState.spread === '-0.5',
        JSON.stringify(segMidState));
      await page.evaluate(() => {
        document.querySelector('[data-seg-form]').querySelector('[data-seg-cancel-edit]').click();
      });
      await wait(300);
      const segCancelState = await segFormState();
      H.check('Cancel edit hides the form and returns it to add mode',
        segCancelState.hidden === true && segCancelState.editSeg === null
          && segCancelState.submitLabel === 'Add segment' && segCancelState.cancelHidden === true,
        JSON.stringify(segCancelState));
      const segAfterCancel = (await H.req('GET', `/api/properties/${segEditPid}`)).data;
      H.check('the cancelled edit saved nothing (spread still -2)',
        segAfterCancel.segments.length === 1 && segAfterCancel.segments[0].spread === -2,
        JSON.stringify(segAfterCancel.segments));
      // Delete + add regression through the UI.
      await page.evaluate(() => document.querySelector('[data-del-seg]').click());
      H.check('the edited segment deletes through the UI',
        await untilNode(async () => page.evaluate(() => !document.querySelector('.seg-table .badge.cmp'))));
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(400);
      await page.evaluate(() => {
        const form = document.querySelector('[data-seg-form]');
        form.start_date.value = '2025-12-01';
        const type = form.querySelector('[name=rate_type]');
        type.value = 'fixed';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        const rate = form.querySelector('[name=annual_rate]');
        rate.value = '5';
        rate.dispatchEvent(new Event('input', { bubbles: true }));
        form.requestSubmit();
      });
      // (No id-novelty assertion: SQLite may hand the deleted
      // row's id to the next insert. The fresh segment is the
      // fixed 5% one, in place of the deleted prime-spread.)
      H.check('a fresh segment adds through the UI after the delete (add mode)',
        await untilNode(async () => {
          const d = (await H.req('GET', `/api/properties/${segEditPid}`)).data;
          return d.segments.length === 1 && d.segments[0].rate_type === 'fixed' && d.segments[0].annual_rate === 5;
        }));
      await H.req('DELETE', `/api/properties/${segEditPid}`);

      // ---- AI Fill, driven through the UI ----
      // The stubbed model returns the RBC commitment-letter
      // fields. The lender is hand-filled first (extraction must
      // keep it); the other term inputs are blanked so the fill
      // has somewhere to land. Expectations: the panel summarizes
      // "Filled 10 fields · 1 kept", flags sit only on the filled
      // fields, a hand edit clears its flag, and after saving the
      // term AND the segment, a full page reload re-renders the
      // surviving flags (term form + segment row).
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        fields: {
          lender: 'RBC', start_date: '2024-12-17', term_months: 60, amortization_years: 30,
          opening_balance: 1350000, payment_override: 7207.10,
          segment_rate_type: 'variable', segment_rate_mode: 'prime_spread', segment_spread: -1,
          segment_compounding: 'monthly', segment_start_date: '2024-12-17',
        },
      }));
      r = await H.req('POST', '/api/properties', {
        address: '12 AI Fill Avenue, Victoria, BC',
        mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-01', amortization_years: 25,
      });
      const aiPid = r.data.id;
      // Navigate by hash + a forced reload (a hash assignment or
      // a fragment-only goto can leave a stale page up when the
      // id was recycled from a just-deleted property), then wait
      // until THIS property's term form is rendered.
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, aiPid);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      H.check('the AI property detail renders its own term form',
        await untilNode(async () => page.evaluate(() => {
          const i = document.querySelector('[data-term-form] [name=start_date]');
          return !!i && i.value === '2024-12-17';
        })));
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      const aiFlagOf = (formSel, name) => page.evaluate((sel, n) => {
        const form = document.querySelector(sel);
        if (!form) return null;
        // The payment editor's input lives in the card's pay
        // block (below the form), not inside the form element.
        const input = form.querySelector(`[name="${n}"]`)
          || (form.closest('.term-block') || document).querySelector(`[data-pay-block] [name="${n}"]`);
        if (!input) return null;
        let host = input.parentElement;
        while (host) {
          const l = [...host.children].find((c) => c.tagName === 'LABEL');
          if (l) return l.querySelector('.ai-flag') != null;
          host = host.parentElement;
        }
        return null;
      }, formSel, name);
      await page.evaluate(() => {
        const form = document.querySelector('[data-term-form]');
        const seg = document.querySelector('[data-seg-form]');
        const set = (f, name, value) => {
          const input = f.querySelector(`[name="${name}"]`);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(form, 'lender', 'TD Bank'); // hand-filled: extraction must keep it
        set(form, 'start_date', '');
        set(form, 'term_months', '');
        set(form, 'amortization_years', '');
        set(form, 'opening_balance', '');
        // The segment form blanked too (its selects and defaulted
        // start date otherwise count as already-filled and are
        // kept, per the write rule).
        set(seg, 'start_date', '');
        set(seg, 'rate_type', '');
        set(seg, 'rate_mode', '');
        set(seg, 'compounding', '');
      });
      await page.evaluate(() => document.querySelector('[data-term-form] [data-ai-toggle]').click());
      await wait(300);
      await page.evaluate(() => {
        document.querySelector('[data-term-form] [data-ai-text]').value = 'RBC commitment letter';
        document.querySelector('[data-term-form] [data-ai-extract]').click();
      });
      H.check('the panel summarizes the fill: 10 filled, the hand-filled lender kept',
        await until(() => {
          const s = document.querySelector('[data-term-form] [data-ai-summary]');
          return !!s && s.textContent.includes('Filled 10 fields') && s.textContent.includes('1 kept');
        }));
      const aiValues = await page.evaluate(() => {
        const form = document.querySelector('[data-term-form]');
        const seg = document.querySelector('[data-seg-form]');
        const v = (f, n) => (f.querySelector(`[name="${n}"]`)
          || f.closest('.term-block').querySelector(`[data-pay-block] [name="${n}"]`)).value;
        return {
          lender: v(form, 'lender'), start: v(form, 'start_date'), months: v(form, 'term_months'),
          amort: v(form, 'amortization_years'), opening: v(form, 'opening_balance'), override: v(form, 'payment_override'),
          segType: v(seg, 'rate_type'), segMode: v(seg, 'rate_mode'), segSpread: v(seg, 'spread'),
          segCmp: v(seg, 'compounding'), segStart: v(seg, 'start_date'),
        };
      });
      H.check('the inputs hold the extracted values (money grouped), the kept lender untouched',
        aiValues.lender === 'TD Bank' && aiValues.start === '2024-12-17' && aiValues.months === '60'
          && aiValues.amort === '30' && aiValues.opening === '1,350,000' && aiValues.override === '7,207.1'
          && aiValues.segType === 'variable' && aiValues.segMode === 'prime_spread' && aiValues.segSpread === '-1'
          && aiValues.segCmp === 'monthly' && aiValues.segStart === '2024-12-17',
        JSON.stringify(aiValues));
      // The extracted override lands in the Monthly payment
      // row's inline editor: the row is in EDIT state (the input
      // shown in place of the figure) without anyone clicking
      // Edit.
      const aiPayEdit = await page.evaluate(() => {
        const row = document.querySelector('[data-pay-block]');
        return {
          inputHidden: row.querySelector('[name=payment_override]').classList.contains('hidden'),
          viewHidden: row.querySelector('[data-term-payment]').classList.contains('hidden'),
        };
      });
      H.check('the extracted override opens the payment row’s inline editor (input shown in place of the figure)',
        aiPayEdit.inputHidden === false && aiPayEdit.viewHidden === true,
        JSON.stringify(aiPayEdit));
      H.check('flags sit on the filled term fields — and not on the kept lender',
        (await aiFlagOf('[data-term-form]', 'start_date')) === true
          && (await aiFlagOf('[data-term-form]', 'term_months')) === true
          && (await aiFlagOf('[data-term-form]', 'amortization_years')) === true
          && (await aiFlagOf('[data-term-form]', 'opening_balance')) === true
          && (await aiFlagOf('[data-term-form]', 'payment_override')) === true
          && (await aiFlagOf('[data-term-form]', 'lender')) === false);
      H.check('flags sit on the filled segment fields',
        (await aiFlagOf('[data-seg-form]', 'start_date')) === true
          && (await aiFlagOf('[data-seg-form]', 'rate_type')) === true
          && (await aiFlagOf('[data-seg-form]', 'compounding')) === true
          && (await aiFlagOf('[data-seg-form]', 'spread')) === true);
      // A hand edit clears that field's flag at once.
      await page.evaluate(() => {
        const input = document.querySelector('[data-term-form] [name=term_months]');
        input.value = '72';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      H.check('a hand edit clears the edited field’s flag (the rest stay)',
        (await aiFlagOf('[data-term-form]', 'term_months')) === false
          && (await aiFlagOf('[data-term-form]', 'start_date')) === true);
      // Save the term, then the segment (the segment draft rides
      // across the term save's reload), then verify persistence.
      await page.evaluate(() => document.querySelector('[data-term-form]').requestSubmit());
      await wait(1500);
      await page.evaluate(() => document.querySelector('[data-toggle-seg]').click());
      await wait(400);
      await page.evaluate(() => document.querySelector('[data-seg-form]').requestSubmit());
      H.check('the segment saves with its Monthly chip',
        await untilNode(async () => (await chipText()) === 'Monthly'));
      const aiSaved = (await H.req('GET', `/api/properties/${aiPid}`)).data;
      H.check('the persisted flags: term fields minus the hand-edited one; all segment fields (and the AI override itself saved)',
        JSON.stringify([...aiSaved.terms[0].ai_fields].sort()) === JSON.stringify(['amortization_years', 'opening_balance', 'payment_override', 'start_date'])
          && JSON.stringify([...aiSaved.segments[0].ai_fields].sort()) === JSON.stringify(['compounding', 'rate_mode', 'rate_type', 'spread', 'start_date'])
          && aiSaved.terms[0].payment_override === 7207.1,
        JSON.stringify({ t: aiSaved.terms[0].ai_fields, s: aiSaved.segments[0].ai_fields, po: aiSaved.terms[0].payment_override }));
      await page.reload({ waitUntil: 'load' });
      await wait(1800);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      H.check('after a full reload the surviving term flags re-render (edited + kept fields unflagged)',
        (await aiFlagOf('[data-term-form]', 'start_date')) === true
          && (await aiFlagOf('[data-term-form]', 'amortization_years')) === true
          && (await aiFlagOf('[data-term-form]', 'opening_balance')) === true
          && (await aiFlagOf('[data-term-form]', 'payment_override')) === true
          && (await aiFlagOf('[data-term-form]', 'term_months')) === false
          && (await aiFlagOf('[data-term-form]', 'lender')) === false);
      const aiRowFlags = await page.evaluate(() => {
        const row = document.querySelector('.seg-table tbody tr');
        return row ? row.querySelectorAll('.ai-flag').length : 0;
      });
      H.check('after the reload the segment row carries its AI flags',
        aiRowFlags >= 3, JSON.stringify({ flags: aiRowFlags }));
      // Model picker: the stub answers per model name, so the
      // filled lender proves which model ran; the choice persists
      // server-side and the reloaded panel still shows it.
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        models: { 'stub-a': { fields: { lender: 'Bank A' } }, 'stub-b': { fields: { lender: 'Bank B' } } },
      }));
      const runModelFill = async (model) => {
        await page.evaluate((m) => {
          const form = document.querySelector('[data-term-form]');
          const lender = form.querySelector('[name=lender]');
          lender.value = '';
          lender.dispatchEvent(new Event('input', { bubbles: true }));
          const panel = form.querySelector('[data-ai-panel]');
          if (panel.classList.contains('hidden')) form.querySelector('[data-ai-toggle]').click();
          form.querySelector('[data-ai-model]').value = m;
          form.querySelector('[data-ai-text]').value = 'letter';
          form.querySelector('[data-ai-extract]').click();
        }, model);
        return until(() => {
          const input = document.querySelector('[data-term-form] [name=lender]');
          return !!input && input.value.startsWith('Bank ');
        });
      };
      H.check('the panel’s model dropdown lists the configured models',
        await until(() => {
          const sel = document.querySelector('[data-term-form] [data-ai-model]');
          return !!sel && sel.options.length === 2;
        }));
      const fillA = await runModelFill('stub-a');
      const lenderA = await page.evaluate(() => document.querySelector('[data-term-form] [name=lender]').value);
      const fillB = await runModelFill('stub-b');
      const lenderB = await page.evaluate(() => document.querySelector('[data-term-form] [name=lender]').value);
      H.check('switching the dropdown switches the model a fill runs with',
        fillA && lenderA === 'Bank A' && fillB && lenderB === 'Bank B',
        JSON.stringify({ lenderA, lenderB }));
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1500);
      await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
      await wait(800);
      H.check('after a reload the model dropdown still shows the persisted choice',
        await until(() => {
          const sel = document.querySelector('[data-term-form] [data-ai-model]');
          return !!sel && sel.value === 'stub-b';
        }));
      await H.req('DELETE', `/api/properties/${aiPid}`);

      // ---- Property costs: ONE table for the year the panel
      // selector is on, both charts and the AI chat, driven
      // through the UI ----
      // Seeded: 2026 tax 5,400; 2025 tax 5,100 + water 480.
      r = await H.req('POST', '/api/properties', { address: '88 Costs UI Road, Victoria, BC', purchase_date: '2024-01-01' });
      const costUiPid = r.data.id;
      await H.req('POST', `/api/properties/${costUiPid}/costs`, { year: 2026, category: 'Property tax', amount: 5400 });
      await H.req('POST', `/api/properties/${costUiPid}/costs`, { year: 2025, category: 'Property tax', amount: 5100 });
      await H.req('POST', `/api/properties/${costUiPid}/costs`, { year: 2025, category: 'Water', amount: 480 });
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, costUiPid);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      // Helpers for the flows below: put the panel selector on
      // a year (the table, pie and By month view all follow).
      const selectCostYear = async (y) => {
        await page.evaluate((yy) => {
          const s = document.querySelector('#costsYearSel');
          s.value = String(yy);
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }, y);
        await wait(350);
      };
      H.check('the costs panel renders ONE table — the selected year (latest by default) with its footer total',
        await until(() => {
          const blocks = [...document.querySelectorAll('#costsYears [data-cost-year-block]')];
          const sel = document.querySelector('#costsYearSel');
          const b = blocks[0];
          return blocks.length === 1 && !!sel && sel.value === '2026' && !!b
            && b.dataset.costYearBlock === '2026'
            && b.querySelectorAll('tr[data-cost-row]').length === 1
            && b.querySelector('tfoot').textContent.includes('2026 total')
            && b.querySelector('tfoot').textContent.includes('5,400');
        }));
      H.check('view mode is a clean read-only table: no row buttons, no "+ Add row", no "+ Add year"',
        await page.evaluate(() => {
          return document.querySelector('#addCostYearBtn').classList.contains('hidden')
            && document.querySelector('#costsEditToggleBtn').textContent === 'Edit'
            && !document.querySelector('#costsYears [data-cost-add-row]')
            && !document.querySelector('#costsYears [data-cost-edit]')
            && !document.querySelector('#costsYears [data-cost-del]');
        }));
      await page.evaluate(() => document.querySelector('#costsEditToggleBtn').click());
      await wait(300);
      const topbarState = await page.evaluate(() => {
        // Centers, not tops: the <select> is a few px taller
        // than the buttons, so centered row-mates differ in top.
        const centers = ['#costsYearSel', '#addCostYearBtn', '[data-costs-ai-toggle]', '#costsEditToggleBtn']
          .map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top + r.height / 2; });
        return {
          sameRow: Math.max(...centers) - Math.min(...centers) < 3,
          editLabel: document.querySelector('#costsEditToggleBtn').textContent,
          addYearShown: !document.querySelector('#addCostYearBtn').classList.contains('hidden'),
          hasAddRow: !!document.querySelector('#costsYears [data-cost-add-row]'),
          hasRowBtns: !!document.querySelector('#costsYears [data-cost-edit]'),
        };
      });
      H.check('edit mode: the selector, "+ Add year", "✨ Fill with AI" and Done share ONE row; Add row and row buttons appear',
        topbarState.sameRow === true && topbarState.editLabel === 'Done'
          && topbarState.addYearShown && topbarState.hasAddRow && topbarState.hasRowBtns,
        JSON.stringify(topbarState));
      const costsHead = await page.evaluate(() => document.querySelector('#costsLatestTotal').textContent);
      H.check('the panel head shows the latest year total', costsHead.includes('2026') && costsHead.includes('5,400'), costsHead);
      const pieState = await page.evaluate(() => {
        const c = window.__fmCharts.costsPie;
        return c ? { labels: c.data.labels, data: c.data.datasets[0].data } : null;
      });
      H.check('the pie defaults to the latest year, slices = that year’s category totals',
        !!pieState && JSON.stringify(pieState.labels) === JSON.stringify(['Property tax']) && pieState.data[0] === 5400,
        JSON.stringify(pieState));
      await selectCostYear(2025);
      const pie2025 = await page.evaluate(() => {
        const c = window.__fmCharts.costsPie;
        return c ? { labels: c.data.labels, data: c.data.datasets[0].data } : null;
      });
      H.check('switching the year selector re-slices the pie to that year (5,100 tax + 480 water)',
        !!pie2025 && pie2025.labels.includes('Water')
          && Math.abs(pie2025.data.reduce((a, b) => a + b, 0) - 5580) < 0.001,
        JSON.stringify(pie2025));
      H.check('the same switch swaps the entries table to 2025 only (2 rows, footer 5,580)',
        await page.evaluate(() => {
          const blocks = [...document.querySelectorAll('#costsYears [data-cost-year-block]')];
          const b = blocks[0];
          return blocks.length === 1 && !!b && b.dataset.costYearBlock === '2025'
            && b.querySelectorAll('tr[data-cost-row]').length === 2
            && b.querySelector('tfoot').textContent.includes('2025 total')
            && b.querySelector('tfoot').textContent.includes('5,580');
        }));
      const colorMatch = await page.evaluate(() => {
        const pie = window.__fmCharts.costsPie;
        const combo = window.__fmCharts.costsCombo;
        const pieMap = {};
        pie.data.labels.forEach((l, i) => { pieMap[l] = pie.data.datasets[0].backgroundColor[i]; });
        const comboMap = {};
        combo.data.datasets.filter((d) => d.type === 'bar').forEach((d) => { comboMap[d.label] = d.backgroundColor; });
        return Object.keys(pieMap).length > 0 && Object.keys(pieMap).every((k) => comboMap[k] === pieMap[k]);
      });
      H.check('a category keeps the same color in the pie and in the combo bars', colorMatch === true);
      const comboYear = await page.evaluate(() => {
        const c = window.__fmCharts.costsCombo;
        if (!c) return null;
        const totals = c.data.datasets.find((d) => d.label === 'Total');
        const bars = c.data.datasets.filter((d) => d.type === 'bar');
        return {
          labels: c.data.labels, totals: totals && totals.data,
          barSums: c.data.labels.map((_, i) => bars.reduce((s, d) => s + d.data[i], 0)),
        };
      });
      H.check('the combo By year: each stacked bar sums to the year total the line carries',
        !!comboYear && JSON.stringify(comboYear.labels) === JSON.stringify(['2025', '2026'])
          && comboYear.barSums[0] === 5580 && comboYear.barSums[1] === 5400
          && comboYear.totals[0] === 5580 && comboYear.totals[1] === 5400,
        JSON.stringify(comboYear));
      // Granularity switching re-renders from the loaded view —
      // count /costs requests to prove nothing is refetched.
      await page.evaluate(() => {
        window.__costsFetches = 0;
        const orig = window.fetch;
        window.fetch = (...args) => {
          if (String(args[0]).includes('/costs')) window.__costsFetches++;
          return orig(...args);
        };
      });
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="month"]').click());
      await wait(600);
      const comboMonth = await page.evaluate(() => {
        const c = window.__fmCharts.costsCombo;
        const totals = c.data.datasets.find((d) => d.label === 'Total');
        return { n: c.data.labels.length, first: c.data.labels[0], totals: totals.data, fetches: window.__costsFetches };
      });
      H.check('By month follows the selected year (2025): its 12 run-rate months sum back to the year total, with no refetch',
        !!comboMonth && comboMonth.n === 12 && comboMonth.first === '2025-01'
          && Math.abs(comboMonth.totals.reduce((a, b) => a + b, 0) - 5580) < 0.05
          && comboMonth.fetches === 0,
        JSON.stringify(comboMonth));
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="year"]').click());
      await wait(400);

      // "+ Add year" opens a fresh year block (2027 — the
      // current year is taken, so the nearest unused one
      // follows) with a blank edit row; the year is still an
      // input there — retitle it 2024 and land its first row.
      await page.evaluate(() => document.querySelector('#addCostYearBtn').click());
      await wait(300);
      const addYearState = await page.evaluate(() => {
        const block = document.querySelector('[data-cost-year-block="2027"]');
        return block ? {
          hasYearInput: !!block.querySelector('[data-cost-year-input]'),
          hasEditRow: !!block.querySelector('tr.cost-editing'),
          selValue: document.querySelector('#costsYearSel').value,
          blocks: document.querySelectorAll('#costsYears [data-cost-year-block]').length,
        } : null;
      });
      H.check('"+ Add year" opens a new year (2027), selects it, with its year editable and a blank row',
        !!addYearState && addYearState.hasYearInput && addYearState.hasEditRow
          && addYearState.selValue === '2027' && addYearState.blocks === 1,
        JSON.stringify(addYearState));
      await page.evaluate(() => {
        const inp = document.querySelector('[data-cost-year-block="2027"] [data-cost-year-input]');
        inp.value = '2024';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2024"] tr.cost-editing');
        row.querySelector('[name=category]').value = 'Property tax';
        const amt = row.querySelector('[name=amount]');
        amt.value = '4900';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
        row.querySelector('[data-cost-save]').click();
      });
      H.check('the retitled 2024 block lands its first row and shows its own total (4,900)',
        await untilNode(async () => {
          const v = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data;
          return v.entries.some((e) => e.year === 2024 && e.category === 'Property tax' && e.amount === 4900);
        }) && await until(() => {
          const b = document.querySelector('[data-cost-year-block="2024"]');
          return !!b && !!b.querySelector('tfoot') && b.querySelector('tfoot').textContent.includes('4,900');
        }));

      // A monthly row through the 2026 table's OWN Add row:
      // basis Monthly opens the 12-month grid — fill Jan/Feb/
      // Mar only; the avg is computed, never typed.
      await selectCostYear(2026);
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] [data-cost-add-row]').click());
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2026"] tr.cost-editing');
        row.querySelector('[name=category]').value = 'Electricity';
        const basis = row.querySelector('[name=basis]');
        basis.value = 'monthly';
        basis.dispatchEvent(new Event('change', { bubbles: true }));
        const set = (m, v) => {
          const inp = row.querySelector(`[data-month="${m}"]`);
          inp.value = v;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(1, '80'); set(2, '90'); set(3, '85');
      });
      const monthNote = await page.evaluate(() =>
        document.querySelector('[data-cost-year-block="2026"] tr.cost-editing .cost-amount-note').textContent);
      H.check('the month grid previews the computed avg + year figure (avg $85.00/mo · = $1,020.00/yr · 3 months)',
        monthNote.includes('avg $85.00/mo') && monthNote.includes('1,020') && monthNote.includes('3 months'),
        monthNote);
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] tr.cost-editing [data-cost-save]').click());
      H.check('the monthly row saves: year figure + "avg $85.00/mo (3 months)"; the 2026 footer follows (6,420)',
        await until(() => {
          const b = document.querySelector('[data-cost-year-block="2026"]');
          return !!b && b.textContent.includes('avg $85.00/mo (3 months)')
            && b.querySelector('tfoot').textContent.includes('6,420');
        }));
      H.check('the API stored the recorded months and the server-computed average',
        await untilNode(async () => {
          const v = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data;
          const e = v.entries.find((x) => x.category === 'Electricity');
          return !!e && e.amount === 85
            && JSON.stringify(e.monthlyAmounts) === JSON.stringify({ '1': 80, '2': 90, '3': 85 });
        }));
      // View mode shows every month of a monthly row: leave
      // edit mode and read the always-on detail row under the
      // Electricity entry — Jan/Feb/Mar at their recorded
      // amounts, Apr–Dec filled with the 85 average and marked
      // as fills; the twelve sum to the 1,020 year figure. The
      // annual Property tax row carries no detail row, and
      // switching the year swaps the detail rows with the table.
      const elecRowId = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Electricity').id;
      const taxRowId = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Property tax' && e.year === 2026).id;
      const grabMonthRow = (id) => page.evaluate((rowId) => {
        const row = document.querySelector(`#costsYears tr[data-cost-months-for="${rowId}"]`);
        if (!row) return null;
        return [...row.querySelectorAll('[data-mv-month]')].map((c) => ({
          fill: c.classList.contains('is-fill'),
          val: parseFloat(c.querySelector('.cost-mv-val').textContent.replace(/[$,]/g, '')),
        }));
      }, id);
      await page.evaluate(() => document.querySelector('#costsEditToggleBtn').click());
      await wait(300);
      const mvElec = await grabMonthRow(elecRowId);
      H.check('view mode: a monthly row shows all 12 months — recorded ones at their amounts, the rest avg fills (weakened) — summing to the year figure',
        !!mvElec && mvElec.length === 12
          && mvElec[0].val === 80 && !mvElec[0].fill
          && mvElec[1].val === 90 && !mvElec[1].fill
          && mvElec[2].val === 85 && !mvElec[2].fill
          && mvElec.slice(3).every((c) => c.fill && c.val === 85)
          && Math.abs(mvElec.reduce((a, c) => a + c.val, 0) - 1020) < 0.001,
        JSON.stringify(mvElec));
      H.check('an annual row carries no month detail row (the monthly one is the table’s only detail row)',
        (await grabMonthRow(taxRowId)) === null
          && (await page.evaluate(() => document.querySelectorAll('#costsYears tr[data-cost-months-for]').length)) === 1);
      await selectCostYear(2025);
      H.check('switching the year swaps the month detail rows with the table (2025 here is annual-only: none)',
        (await page.evaluate(() => document.querySelectorAll('#costsYears tr[data-cost-months-for]').length)) === 0);
      await selectCostYear(2026);
      H.check('switching back to 2026 brings the Electricity month detail row back',
        (await grabMonthRow(elecRowId)) !== null);
      await page.evaluate(() => document.querySelector('#costsEditToggleBtn').click());
      await wait(300);
      // By month with detail on record: actual months land at
      // their amounts, the rest fill with the average.
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="month"]').click());
      await wait(600);
      const comboDetail = await page.evaluate(() => {
        const c = window.__fmCharts.costsCombo;
        const elec = c.data.datasets.find((d) => d.label === 'Electricity');
        const totals = c.data.datasets.find((d) => d.label === 'Total');
        const at = c.data.labels.indexOf('2026-01');
        return {
          jan: elec.data[at], feb: elec.data[at + 1], mar: elec.data[at + 2], apr: elec.data[at + 3],
          elecSum: elec.data.slice(at, at + 12).reduce((a, b) => a + b, 0),
          totalSum: totals.data.slice(at, at + 12).reduce((a, b) => a + b, 0),
        };
      });
      H.check('By month: Electricity 2026 shows Jan 80 / Feb 90 / Mar 85 actuals and Apr filled at the 85 avg',
        !!comboDetail && comboDetail.jan === 80 && comboDetail.feb === 90
          && comboDetail.mar === 85 && comboDetail.apr === 85
          && Math.abs(comboDetail.elecSum - 1020) < 0.05 && Math.abs(comboDetail.totalSum - 6420) < 0.05,
        JSON.stringify(comboDetail));
      await page.evaluate(() => document.querySelector('#costsGranularity button[data-gran="year"]').click());
      await wait(400);
      // A custom category through the Other… option, added from
      // the 2026 table's own Add row.
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] [data-cost-add-row]').click());
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2026"] tr.cost-editing');
        const sel = row.querySelector('[name=category]');
        sel.value = '__custom__';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        row.querySelector('[name=category_custom]').value = 'Gardening';
        const amt = row.querySelector('[name=amount]');
        amt.value = '300';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] tr.cost-editing [data-cost-save]').click());
      H.check('Other… turns the type into a free-form name, stored as its own category',
        await untilNode(async () => {
          const v = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data;
          return v.entries.some((e) => e.category === 'Gardening' && e.amount === 300);
        }));
      // Edit the water row in place: 480 -> 500.
      const waterEntry = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Water');
      await selectCostYear(2025);
      await page.evaluate((id) => document.querySelector(`[data-cost-edit="${id}"]`).click(), waterEntry.id);
      await wait(300);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2025"] tr.cost-editing');
        const amt = row.querySelector('[name=amount]');
        amt.value = '500';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
        row.querySelector('[data-cost-save]').click();
      });
      H.check('editing a row in place updates the figure and its year footer (2025 -> 5,600)',
        await until(() => {
          const b = document.querySelector('[data-cost-year-block="2025"]');
          return !!b && b.querySelector('tfoot').textContent.includes('5,600');
        }));
      // Delete the gardening row (the page-wide dialog handler
      // registered earlier accepts the confirm).
      const gardenEntry = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Gardening');
      await selectCostYear(2026);
      await page.evaluate((id) => document.querySelector(`[data-cost-del="${id}"]`).click(), gardenEntry.id);
      H.check('deleting a row removes it and the totals drop back',
        await untilNode(async () => {
          const v = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data;
          return !v.entries.some((e) => e.category === 'Gardening') && v.latest.total === 6420;
        }));

      // The save race: while a save's reload is still in
      // flight, an edit opened on ANOTHER row must survive the
      // reload landing — the row AND what was typed into it.
      // Costs writes are delayed 700ms; the Electricity row is
      // saved untouched, and mid-flight the Water row is opened
      // and typed into.
      const elecIdForRace = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data.entries
        .find((e) => e.category === 'Electricity').id;
      await page.evaluate(() => {
        window.__origFetch = window.fetch;
        window.fetch = async (...args) => {
          const method = (args[1] && args[1].method) || 'GET';
          if (String(args[0]).includes('/costs') && method !== 'GET') {
            await new Promise((r) => setTimeout(r, 700));
          }
          return window.__origFetch(...args);
        };
      });
      await page.evaluate((id) => document.querySelector(`[data-cost-edit="${id}"]`).click(), elecIdForRace);
      await wait(300);
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2026"] tr.cost-editing [data-cost-save]').click());
      await wait(150); // the save is in flight now
      // Mid-flight the user switches the year selector to 2025
      // and opens the Water row there — the switch renders the
      // 2025 table (snapshotting the in-flight row's session),
      // and the Water edit must still survive the reload.
      await page.evaluate(() => {
        const s = document.querySelector('#costsYearSel');
        s.value = '2025';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(100);
      await page.evaluate((id) => document.querySelector(`[data-cost-edit="${id}"]`).click(), waterEntry.id);
      await wait(150);
      await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2025"] tr.cost-editing');
        const amt = row.querySelector('[name=amount]');
        amt.value = '555';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(1800); // the delayed save + its reload land here
      const raceState = await page.evaluate(() => {
        const row = document.querySelector('[data-cost-year-block="2025"] tr.cost-editing');
        return row ? { editing: row.dataset.costEditrow, amount: row.querySelector('[name=amount]').value } : null;
      });
      await page.evaluate(() => { window.fetch = window.__origFetch; delete window.__origFetch; });
      H.check('an edit opened while a save reload is in flight survives it — row and typed value alike',
        !!raceState && raceState.editing === `id:${waterEntry.id}` && raceState.amount.includes('555'),
        JSON.stringify(raceState));
      await page.evaluate(() => document.querySelector('[data-cost-year-block="2025"] tr.cost-editing [data-cost-save]').click());
      H.check('the surviving edit then saves normally (Water 555, 2025 total 5,655)',
        await untilNode(async () => {
          const v = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data;
          const w = v.entries.find((e) => e.category === 'Water');
          return !!w && w.amount === 555 && v.years.find((y) => y.year === 2025).total === 5655;
        }));

      // ---- The AI costs chat through the UI: two rounds, then
      // Apply. Round 1 asks about the year with a partial
      // monthly proposal; round 2 completes it — including a
      // Property tax entry that conflicts with the recorded one
      // and must start unchecked.
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'Which year is the strata bill for? Jan–Mar show $312/mo each.',
        proposed: [{ year: 2026, category: 'Strata fee', basis: 'monthly', monthlyAmounts: { 1: 312, 2: 312, 3: 312 } }],
        ready: false,
      }));
      await page.evaluate(() => document.querySelector('[data-costs-ai-toggle]').click());
      await wait(400);
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = 'strata bill attached';
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('chat round 1: the question lands in the log and the proposal renders month by month',
        await until(() => {
          const log = document.querySelector('[data-costs-chat-log]');
          const rows = document.querySelectorAll('[data-proposed-row]');
          return log.textContent.includes('Which year is the strata bill for')
            && rows.length === 1 && rows[0].querySelector('[data-p-basis]').value === 'monthly'
            && (rows[0].querySelector('[data-p-month="1"]') || {}).value === '312'
            && rows[0].querySelector('.p-annual').textContent.includes('3,744')
            && rows[0].querySelector('.p-annual').textContent.includes('3 months');
        }));
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'All set for 2026.',
        proposed: [
          { year: 2026, category: 'Strata fee', basis: 'monthly', monthlyAmounts: { 1: 312, 2: 312, 3: 312 } },
          { year: 2026, category: 'Property tax', amount: 5600, basis: 'annual' },
        ],
        ready: true,
      }));
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = '2026';
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('chat round 2: the conflict starts unchecked and shows old → new ($5,400.00 → $5,600.00)',
        await until(() => {
          const rows = document.querySelectorAll('[data-proposed-row]');
          if (rows.length !== 2) return false;
          const conflict = [...rows].find((x) => x.classList.contains('conflict'));
          const clean = [...rows].find((x) => !x.classList.contains('conflict'));
          const diff = conflict ? conflict.querySelector('.conflict-diff') : null;
          return !!conflict && !!clean && !!diff
            && conflict.querySelector('[data-p-category]').value === 'Property tax'
            && conflict.querySelector('[data-p-check]').checked === false
            && diff.textContent.includes('5,400') && diff.textContent.includes('→') && diff.textContent.includes('5,600')
            && clean.querySelector('[data-p-check]').checked === true;
        }));
      await page.evaluate(() => document.querySelector('[data-costs-apply]').click());
      H.check('Apply lands only the checked entries — months included, source ai; the conflict stays manual',
        await untilNode(async () => {
          const v = (await H.req('GET', `/api/properties/${costUiPid}/costs`)).data;
          const strata = v.entries.find((e) => e.category === 'Strata fee');
          const tax = v.entries.find((e) => e.category === 'Property tax' && e.year === 2026);
          return !!strata && strata.source === 'ai' && strata.basis === 'monthly' && strata.amount === 312
            && JSON.stringify(strata.monthlyAmounts) === JSON.stringify({ '1': 312, '2': 312, '3': 312 })
            && !!tax && tax.source === 'manual' && tax.amount === 5400;
        }));
      await selectCostYear(2026);
      H.check('after Apply the 2026 table shows the AI row and its footer total is 10,164',
        await until(() => {
          const b = document.querySelector('[data-cost-year-block="2026"]');
          return !!b && b.textContent.includes('Strata fee')
            && b.querySelector('tfoot').textContent.includes('10,164');
        }));

      // Clear session: the conversation empties (turns and any
      // unapplied proposals), recorded entries are untouched,
      // the button hides while the session is empty, and a
      // fresh conversation starts right away.
      H.check('Clear session is offered while the chat holds content',
        await page.evaluate(() => !document.querySelector('[data-costs-chat-clear]').classList.contains('hidden')));
      await page.evaluate(() => document.querySelector('[data-costs-chat-clear]').click());
      await wait(300);
      H.check('Clear session empties the log and hides itself; the recorded entries stay',
        await page.evaluate(() => {
          const log = document.querySelector('[data-costs-chat-log]');
          const b = document.querySelector('[data-cost-year-block="2026"]');
          return log.classList.contains('hidden') && log.textContent.trim() === ''
            && document.querySelectorAll('[data-proposed-row]').length === 0
            && document.querySelector('[data-costs-chat-clear]').classList.contains('hidden')
            && !!b && b.textContent.includes('Strata fee');
        }));
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'Fresh start — what shall I record?',
        proposed: [],
        ready: false,
      }));
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = 'hello again';
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('a new conversation starts immediately after clearing',
        await until(() => document.querySelector('[data-costs-chat-log]').textContent.includes('Fresh start')));

      // The error line reports the LAST action only: an
      // oversized attachment errors, a later successful round
      // clears it, and Clear session clears it too. Picked and
      // pasted files share one chip queue above the textarea.
      const queueViaInput = (name, type, parts) => page.evaluate((n, t, p) => {
        const dt = new DataTransfer();
        dt.items.add(new File(p, n, { type: t }));
        const input = document.querySelector('[data-costs-chat-files]');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, name, type, parts);
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ reply: 'Got it.', proposed: [], ready: false }));
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }));
        const input = document.querySelector('[data-costs-chat-files]');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(200);
      H.check('a picked file lands in the chip queue', await page.evaluate(() => {
        const q = document.querySelector('[data-costs-chat-queue]');
        return !q.classList.contains('hidden') && q.textContent.includes('big.pdf');
      }));
      await page.evaluate(() => document.querySelector('[data-costs-chat-send]').click());
      H.check('an oversized attachment shows the size error',
        await until(() => document.querySelector('[data-costs-chat-msg]').textContent.includes('too large')));
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-queue-remove]').click();
        document.querySelector('[data-costs-chat-text]').value = 'hello';
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('a successful round clears the earlier error',
        await until(() => document.querySelector('[data-costs-chat-log]').textContent.includes('Got it.')
          && document.querySelector('[data-costs-chat-msg]').textContent.trim() === ''));
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }));
        const input = document.querySelector('[data-costs-chat-files]');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('the size error returns on a new oversized send',
        await until(() => document.querySelector('[data-costs-chat-msg]').textContent.includes('too large')));
      await page.evaluate(() => document.querySelector('[data-costs-chat-clear]').click());
      await wait(300);
      H.check('Clear session clears the error and the queued file too', await page.evaluate(() => {
        const q = document.querySelector('[data-costs-chat-queue]');
        return document.querySelector('[data-costs-chat-msg]').textContent.trim() === ''
          && q.classList.contains('hidden') && q.textContent.trim() === '';
      }));

      // CSV: queued like any attachment; the model reads it as
      // text (receipt is asserted in the unit tests) and its
      // proposal renders. An over-long text file truncates
      // server-side and still rounds fine.
      await queueViaInput('bills.csv', 'text/csv', ['month,amount\n2025-01,80\n2025-02,90\n2025-03,85\n']);
      await wait(200);
      H.check('a CSV lands in the same chip queue', await page.evaluate(() =>
        document.querySelector('[data-costs-chat-queue]').textContent.includes('bills.csv')));
      fs.writeFileSync(H.aiStubFile, JSON.stringify({
        reply: 'Got the water bills.',
        proposed: [{ year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } }],
        ready: true,
      }));
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = 'water bills attached';
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('the CSV round returns its proposal and empties the queue',
        await until(() => {
          const row = document.querySelector('[data-proposed-row] [data-p-category]');
          const q = document.querySelector('[data-costs-chat-queue]');
          return !!row && row.value === 'Water' && q.classList.contains('hidden');
        }));
      await page.evaluate(() => document.querySelector('[data-costs-discard]').click());
      await wait(200);
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ reply: 'Got it.', proposed: [], ready: false }));
      await queueViaInput('long.txt', 'text/plain', ['x'.repeat(60000)]);
      await page.evaluate(() => document.querySelector('[data-costs-chat-send]').click());
      H.check('an over-long text file truncates without an error',
        await until(() => document.querySelector('[data-costs-chat-log]').textContent.includes('Got it.')
          && document.querySelector('[data-costs-chat-msg]').textContent.trim() === ''
          && document.querySelector('[data-costs-chat-queue]').classList.contains('hidden')));

      // Paste: an image on the clipboard queues as a chip and
      // sends with the round; a text-only paste is untouched.
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ reply: 'Paste received.', proposed: [], ready: false }));
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
        document.querySelector('[data-costs-chat-text]')
          .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await wait(200);
      H.check('pasting an image queues it as a chip', await page.evaluate(() =>
        document.querySelector('[data-costs-chat-queue]').textContent.includes('shot.png')));
      await page.evaluate(() => {
        document.querySelector('[data-costs-chat-text]').value = 'see attached';
        document.querySelector('[data-costs-chat-send]').click();
      });
      H.check('the pasted image sends with the round and the queue empties',
        await until(() => document.querySelector('[data-costs-chat-log]').textContent.includes('Paste received.')
          && document.querySelector('[data-costs-chat-queue]').classList.contains('hidden')));
      H.check('a text-only paste is not intercepted and queues nothing', await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'plain words');
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = document.querySelector('[data-costs-chat-text]').dispatchEvent(ev);
        return notPrevented && document.querySelector('[data-costs-chat-queue]').classList.contains('hidden');
      }));

      // Done: the table returns to its clean read-only view.
      await page.evaluate(() => document.querySelector('#costsEditToggleBtn').click());
      await wait(300);
      H.check('Done returns the table to a clean read-only view (no row buttons, no Add row, no Add year)',
        await page.evaluate(() => {
          return document.querySelector('#costsEditToggleBtn').textContent === 'Edit'
            && document.querySelector('#addCostYearBtn').classList.contains('hidden')
            && !document.querySelector('#costsYears [data-cost-add-row]')
            && !document.querySelector('#costsYears [data-cost-edit]')
            && !document.querySelector('#costsYears [data-cost-del]')
            && !!document.querySelector('#costsYears [data-cost-year-block]');
        }));

      // ---- Property outline: the floating Docs-style section
      // index. It must overlay the page (position fixed), leave
      // the content column exactly as wide as without it, list
      // the rendered sections in order, jump + highlight on
      // click, follow the scroll (scrollspy), and collapse to a
      // round toggle on narrow viewports. Auto-hide: it starts
      // hidden, fades in while the page scrolls, and back out a
      // few seconds after scrolling stops — hovering it (or the
      // open narrow card) holds it. The hide delay is shortened
      // via window.__fmOutline so the suite never waits out the
      // real 2.5s. ----
      await page.setViewport({ width: 1500, height: 900 });
      await wait(600);
      const outlineEntries = await page.evaluate(() =>
        [...document.querySelectorAll('#propOutlineList a')].map((a) => a.textContent.trim()));
      H.check('the outline lists the page’s sections in order (history rides with the projection)',
        JSON.stringify(outlineEntries) === JSON.stringify(
          ['Property Details', 'Value & Mortgage Projection', 'Assessment History', 'Property Costs']),
        JSON.stringify(outlineEntries));
      // The flows above scrolled this page plenty, so the outline
      // may be awake right now. Shorten the hide delay, then judge
      // the resting state once the countdown has run out. (No
      // reload here: it would collapse the AI chat panel above,
      // shorten the page, and the costs panel could no longer
      // physically scroll into the band the jump checks assert.)
      await page.evaluate(() => window.__fmOutline.setHideDelay(700));
      H.check('the outline settles back to hidden at rest',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      await wait(400); // let any fade-out transition settle
      const hiddenFacts = await page.evaluate(() => {
        const nav = document.querySelector('#propOutline');
        const cs = getComputedStyle(nav);
        const r = nav.getBoundingClientRect();
        const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          awake: nav.classList.contains('awake'), visibility: cs.visibility,
          opacity: cs.opacity, pointerEvents: cs.pointerEvents,
          underInNav: !!under && nav.contains(under),
        };
      });
      H.check('at rest the outline is fully hidden and lets clicks pass through',
        !hiddenFacts.awake && hiddenFacts.visibility === 'hidden' && hiddenFacts.opacity === '0'
          && hiddenFacts.pointerEvents === 'none' && !hiddenFacts.underInNav,
        JSON.stringify(hiddenFacts));
      const navFacts = await page.evaluate(() => {
        const nav = document.querySelector('#propOutline');
        const main = document.querySelector('main');
        const withNav = main.getBoundingClientRect().width;
        nav.style.display = 'none';
        const withoutNav = main.getBoundingClientRect().width;
        nav.style.display = '';
        return {
          position: getComputedStyle(nav).position,
          toggleDisplay: getComputedStyle(document.querySelector('#propOutlineToggle')).display,
          withNav, withoutNav,
        };
      });
      H.check('the outline is a fixed floating card, toggle hidden on a wide viewport',
        navFacts.position === 'fixed' && navFacts.toggleDisplay === 'none',
        JSON.stringify(navFacts));
      H.check('the floating outline takes no layout width (content column identical with/without it)',
        Math.abs(navFacts.withNav - navFacts.withoutNav) < 0.6,
        JSON.stringify(navFacts));
      await page.evaluate(() => window.scrollTo(0, 200));
      H.check('scrolling fades the outline in',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          return nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'visible';
        })));
      H.check('awake and unhovered, the outline rests translucent (about 85%) so the page shows through softly',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          if (!nav.classList.contains('awake')) return false;
          const o = parseFloat(getComputedStyle(nav).opacity);
          return o > 0.8 && o < 0.9;
        }, 8)));
      H.check('the outline fades back out once scrolling has stopped',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          return !nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'hidden';
        })));
      // Hover holds it open past the hide delay; leaving releases it.
      await page.evaluate(() => window.scrollBy(0, 40));
      await until(() => document.querySelector('#propOutline').classList.contains('awake'));
      const navBox = await page.evaluate(() => {
        const r = document.querySelector('#propOutline').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(navBox.x, navBox.y);
      await wait(1600); // > 2x the shortened 700ms hide delay
      H.check('hovering the outline holds it open past the hide delay',
        await page.evaluate(() => {
          const nav = document.querySelector('#propOutline');
          return nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'visible';
        }));
      H.check('hovered, the outline is fully opaque (solid when it is being read)',
        await page.evaluate(() => getComputedStyle(document.querySelector('#propOutline')).opacity === '1'));
      await page.mouse.move(navBox.x + 420, navBox.y);
      H.check('moving the pointer away lets it hide again',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      const wakeNav = async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        await until(() => document.querySelector('#propOutline').classList.contains('awake'));
      };
      await wakeNav();
      await page.evaluate(() => {
        [...document.querySelectorAll('#propOutlineList a')]
          .find((a) => a.textContent.includes('Property Costs')).click();
      });
      H.check('clicking the Property Costs entry scrolls the costs panel under the topbar',
        !!(await until(() => {
          const r = document.querySelector('#costsPanel').getBoundingClientRect();
          return r.top >= 40 && r.top <= 110;
        })));
      H.check('the clicked entry carries the active highlight',
        await page.evaluate(() => {
          const a = document.querySelector('#propOutlineList a.active');
          return !!a && a.textContent.includes('Property Costs');
        }));
      await page.evaluate(() => window.scrollTo(0, 0));
      H.check('scrolling back to the top moves the highlight to Property Details (scrollspy)',
        !!(await until(() => {
          const a = document.querySelector('#propOutlineList a.active');
          return !!a && a.textContent.includes('Property Details')
            && document.querySelector('#propertyOverview').getBoundingClientRect().top >= 40;
        })));
      await wakeNav();
      await page.evaluate(() => {
        [...document.querySelectorAll('#propOutlineList a')]
          .find((a) => a.textContent.includes('Assessment History')).click();
      });
      H.check('the Assessment History entry opens the history modal',
        !!(await until(() => !document.querySelector('#historyModal').classList.contains('hidden'))));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);
      await page.setViewport({ width: 700, height: 900 });
      await wait(500);
      H.check('the outline is hidden at rest on a narrow viewport too',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      const narrowFacts = await page.evaluate(() => ({
        toggle: getComputedStyle(document.querySelector('#propOutlineToggle')).display,
        card: getComputedStyle(document.querySelector('.prop-outline-card')).display,
      }));
      H.check('on a narrow viewport the outline collapses to just the round toggle button',
        narrowFacts.toggle === 'flex' && narrowFacts.card === 'none', JSON.stringify(narrowFacts));
      await page.evaluate(() => window.scrollTo(0, 300));
      H.check('on a narrow viewport a scroll wakes the floating toggle',
        !!(await until(() => {
          const nav = document.querySelector('#propOutline');
          return nav.classList.contains('awake') && getComputedStyle(nav).visibility === 'visible';
        })));
      await page.evaluate(() => document.querySelector('#propOutlineToggle').click());
      H.check('tapping the toggle opens the entry card',
        !!(await until(() => getComputedStyle(document.querySelector('.prop-outline-card')).display !== 'none')));
      await wait(1600); // > 2x the shortened hide delay
      H.check('the opened card holds the outline open past the hide delay',
        await page.evaluate(() => document.querySelector('#propOutline').classList.contains('awake')
          && getComputedStyle(document.querySelector('.prop-outline-card')).display !== 'none'));
      await page.evaluate(() => {
        [...document.querySelectorAll('#propOutlineList a')]
          .find((a) => a.textContent.includes('Property Costs')).click();
      });
      H.check('from the opened card an entry still jumps — and the card closes behind it',
        !!(await until(() => {
          const r = document.querySelector('#costsPanel').getBoundingClientRect();
          return r.top >= 40 && r.top <= 110
            && !document.querySelector('#propOutline').classList.contains('open');
        })));
      H.check('after the jump the outline auto-hides again on the narrow viewport',
        !!(await until(() => !document.querySelector('#propOutline').classList.contains('awake'))));
      await page.evaluate(() => window.__fmOutline.setHideDelay(2500));
      await page.setViewport({ width: 800, height: 600 });
      // A monthly row recorded before per-month detail existed
      // (monthlyAmounts null) still shows its twelve months in
      // view mode — every cell the stored average, every cell a
      // fill. Driven last, on a scratch property: the reloads
      // it takes would change this page's geometry (the AI
      // chat collapses), which the outline jump checks above
      // are sensitive to — and the totals asserted in the
      // costs section stay untouched this way.
      r = await H.req('POST', '/api/properties', { address: '9 Legacy Months Lane, Victoria, BC', purchase_date: '2024-01-01' });
      const legacyPid = r.data.id;
      await H.req('POST', `/api/properties/${legacyPid}/costs`, { year: 2026, category: 'Gas', amount: 60, basis: 'monthly' });
      await H.req('POST', `/api/properties/${legacyPid}/costs`, { year: 2026, category: 'Property tax', amount: 1200 });
      await page.evaluate((pid) => { location.hash = `#property/${pid}`; }, legacyPid);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      H.check('view mode: a monthly row with no detail on record renders all 12 months as avg fills summing to its year figure',
        await until(() => {
          const rows = document.querySelectorAll('#costsYears tr[data-cost-months-for]');
          if (rows.length !== 1) return false;
          const cells = [...rows[0].querySelectorAll('[data-mv-month]')];
          if (cells.length !== 12) return false;
          const sum = cells.reduce((a, c) => a
            + parseFloat(c.querySelector('.cost-mv-val').textContent.replace(/[$,]/g, '')), 0);
          return cells.every((c) => c.classList.contains('is-fill')) && Math.abs(sum - 720) < 0.001;
        }));
      await H.req('DELETE', `/api/properties/${legacyPid}`);
      await H.req('DELETE', `/api/properties/${costUiPid}`);

      // ---- Simplified Add job: modal, key fields only, derived rest ----
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.click('#addEarnJobBtn');
      await wait(300);
      H.check('Add job opens as a modal, not an inline panel',
        await page.evaluate(() => {
          const m = document.querySelector('#earnJobModal');
          return !!m && !m.classList.contains('hidden') && !document.querySelector('#earnJobFormPanel');
        }));
      H.check('the job modal asks only simplified fields (no gross/basis/year/TD1/YTD inputs)',
        await page.evaluate(() => ['gross_amount', 'gross_basis', 'tax_year', 'td1_federal', 'td1_provincial', 'ytd_cpp', 'ytd_cpp2', 'ytd_ei']
          .every((n) => !document.querySelector(`#earnJobForm [name=${n}]`))));
      H.check('the job form carries no Pay changes or Bonuses sections',
        await page.evaluate(() => !document.querySelector('#earnJobPayChangeRows')
          && !document.querySelector('#earnJobBonusRows')
          && !document.querySelector('#earnJobPayChangeAddBtn')
          && !document.querySelector('#earnJobBonusAddBtn')));
      H.check('the job modal carries the ✨ Fill with AI panel',
        await page.evaluate(() => !!document.querySelector('#earnJobForm [data-ai-toggle]')));
      await until(() => document.querySelectorAll('#earnJobProvince option').length > 1);
      await page.type('#earnJobForm [name=employer]', 'Derived Corp');
      await page.select('#earnJobProvince', 'BC');
      await page.select('#earnJobFrequency', 'biweekly');
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobForm');
        f.start_date.value = '2026-01-05';
        f.recent_pay_date.value = '2026-10-23';
      });
      await page.type('#earnJobForm [name=recent_pay_value]', '3000');
      await page.click('#earnJobModal button[type=submit]');
      H.check('saving the simplified job shows annual $78,000.00 on its card',
        await until(() => {
          const m = document.querySelector('#earnJobModal');
          return m && m.classList.contains('hidden')
            && document.querySelector('#earnJobList').textContent.includes('Derived Corp')
            && document.querySelector('#earnJobList').textContent.includes('$78,000.00');
        }));
      const modalJob = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.employer === 'Derived Corp');
      H.check('the saved job carries tax year 2026 from the recent date',
        !!modalJob && modalJob.tax_year === 2026 && modalJob.gross_basis === 'period', JSON.stringify(modalJob));
      // Edit: the modal pre-fills the simplified fields; rows live
      // on the detail page only now, so the raise + bonus go through
      // the detail panels (same PUT shape, same re-derivation).
      // (Cards carry no buttons now: click into the detail page and
      // use its header Edit button, same shared modal.)
      await page.evaluate(() => {
        const card = document.querySelector('.earn-job-card');
        if (card) card.click();
      });
      await wait(900);
      await until(() => {
        const d = document.querySelector('#earnJobDetail');
        return d && !d.classList.contains('hidden') && !!document.querySelector('#earnJobDetailEditBtn');
      });
      await page.click('#earnJobDetailEditBtn');
      await wait(300);
      H.check('editing pre-fills the simplified fields (grouped recent value)',
        await page.evaluate(() => {
          const f = document.querySelector('#earnJobForm');
          return f.employer.value === 'Derived Corp' && f.start_date.value === '2026-01-05'
            && f.recent_pay_value.value === '3,000';
        }));
      await page.evaluate(() => {
        [...document.querySelectorAll('#earnJobModal button')].find((b) => b.textContent.trim() === 'Cancel').click();
      });
      await wait(300);
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-01-05';
        f.row_value.value = '2500';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      await wait(900);
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-06-01';
        f.row_value.value = '3000';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      await wait(900);
      await page.click('#earnJobDetailAddBonus');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-06-30';
        f.row_value.value = '5000';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      await wait(900);
      const modalJob2 = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.employer === 'Derived Corp');
      H.check('raise + bonus from detail: YTD re-derives, annual includes the bonus, per-period rate does not',
        !!modalJob2 && modalJob2.ytd_cpp === 3175.24 && modalJob2.calc.annualGross === 83000
        && modalJob2.calc.perPeriod.gross === 3000 && modalJob2.bonus_total === 5000, JSON.stringify(modalJob2));
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('the card now shows annual $83,000.00',
        await until(() => document.querySelector('#earnJobList').textContent.includes('$83,000.00')));
      // A simplified-form edit must NOT touch the child rows: the
      // form carries no row sections, so its PUT carries neither
      // side and the server leaves them alone.
      await page.evaluate(() => {
        const card = document.querySelector('.earn-job-card');
        if (card) card.click();
      });
      await wait(900);
      await until(() => {
        const d = document.querySelector('#earnJobDetail');
        return d && !d.classList.contains('hidden') && !!document.querySelector('#earnJobDetailEditBtn');
      });
      await page.click('#earnJobDetailEditBtn');
      await wait(300);
      await page.click('#earnJobModal button[type=submit]');
      await wait(900);
      const modalJob3 = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.employer === 'Derived Corp');
      H.check('editing through the simplified form preserves pay changes and bonuses',
        !!modalJob3 && modalJob3.pay_changes.length === 2 && modalJob3.bonuses.length === 1
        && modalJob3.bonus_total === 5000 && modalJob3.calc.annualGross === 83000, JSON.stringify(modalJob3));
      // An old-form job still renders and computes.
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Legacy Corp', province: 'BC', frequency: 'annual',
        gross_amount: 60000, gross_basis: 'annual', tax_year: 2026,
      });
      const legacyJobId = r.data.id;
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      H.check('an old-form job still renders with its annual figure',
        await until(() => {
          const list = document.querySelector('#earnJobList');
          return list && list.textContent.includes('Legacy Corp') && list.textContent.includes('$60,000.00');
        }));
      await H.req('DELETE', `/api/earnings/jobs/${modalJob.id}`);
      await H.req('DELETE', `/api/earnings/jobs/${legacyJobId}`);

      // ---- Job form take-home toggle: Gross default, label follows ----
      // (The raise+bonus edit above ran from the detail page, so step back
      // to the salary list first: the + Add job button lives there.)
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.click('#addEarnJobBtn');
      await wait(300);
      H.check('job form payment toggle defaults to Gross',
        await page.evaluate(() => {
          const f = document.querySelector('#earnJobForm');
          return f.querySelector('[name=pay_value_basis]:checked')?.value === 'gross'
            && document.querySelector('#earnJobPayValueLabel').textContent.includes('gross');
        }));
      await page.click('#earnJobForm [name=pay_value_basis][value=takehome]');
      H.check('switching to Take-home relabels the payment field',
        await page.evaluate(() => document.querySelector('#earnJobPayValueLabel').textContent.includes('take-home')));
      await page.evaluate(() => {
        [...document.querySelectorAll('#earnJobModal button')].find((b) => b.textContent.trim() === 'Cancel').click();
      });
      await wait(300);

      // ---- Job detail page: click in, manage pay changes/bonuses inside ----
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Detail Corp', province: 'BC', frequency: 'biweekly',
        start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
      });
      const detailJobId = r.data.id;
      // The page may already sit on the Salary hash (same-hash goto
      // would not fire the router), so step away first to force a
      // fresh list render that includes the new job.
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, detailJobId);
      H.check('clicking a job card lands on its detail page',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return location.hash.startsWith('#earnings/job/')
            && d && !d.classList.contains('hidden')
            && d.textContent.includes('Detail Corp')
            && d.textContent.includes('$78,000.00');
        }));
      // Add a raise from the detail page: it applies to the recent pay
      // period, so it becomes the current rate and the annual gross moves.
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-06-01';
        f.row_value.value = '3500';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      H.check('adding a pay change from the detail page updates the annual gross',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && d.textContent.includes('$91,000.00');
        }));
      const detailJob2 = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === detailJobId);
      H.check('raise from detail: per-period rate is the new value',
        !!detailJob2 && detailJob2.calc.annualGross === 91000 && detailJob2.calc.perPeriod.gross === 3500
        && detailJob2.pay_changes.length === 1, JSON.stringify(detailJob2));
      // Add a bonus from the detail page: gross moves, per-period rate does not.
      await page.click('#earnJobDetailAddBonus');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-06-30';
        f.row_value.value = '5000';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      H.check('adding a bonus from the detail page updates the gross, not the per-period rate',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && d.textContent.includes('$96,000.00');
        }));
      const detailJob3 = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === detailJobId);
      H.check('bonus from detail: bonus total 5000, per-period rate still 3500',
        !!detailJob3 && detailJob3.calc.annualGross === 96000 && detailJob3.calc.perPeriod.gross === 3500
        && detailJob3.bonus_total === 5000, JSON.stringify(detailJob3));
      // Next pay date: the card and the API agree on one date; the
      // detail page folds it into a combined NEXT NET PAY DATE card
      // (date + per-period net) with no standalone line. The detail
      // header carries no Edit/Delete buttons, while the card still
      // offers both and the detail body bottom row offers both too.
      // (until() predicates run in the browser, so values cross over
      // as evaluate args, never as closed-over Node variables.)
      const untilEval = async (fn, arg, tries = 40) => {
        for (let i = 0; i < tries; i++) {
          if (await page.evaluate(fn, arg)) return true;
          await wait(300);
        }
        return false;
      };
      const apiDetailJob = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === detailJobId);
      // earnJobDateLabel uses abbreviated month names (Nov 6, 2026).
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul',
        'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const [ny, nm, nd] = (apiDetailJob.next_pay_date || '').split('-').map(Number);
      const nextLabel = `Next pay date · ${MONTHS[nm - 1]} ${nd}, ${ny}`;
      const nextNet = Number(apiDetailJob.calc.perPeriod.net).toLocaleString('en-CA',
        { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const nextDateLabel = `${MONTHS[nm - 1]} ${nd}, ${ny}`;
      const detailCombo = await page.evaluate(() => {
        const d = document.querySelector('#earnJobDetail');
        if (!d) return null;
        const cards = [...d.querySelectorAll('.summary-card')];
        const combo = cards.find((c) => (c.querySelector('.k')?.textContent.trim()) === 'Next net pay date');
        return {
          hasStandalone: !!d.querySelector('.earn-next-pay'),
          comboK: combo ? combo.querySelector('.k').textContent.trim() : null,
          comboV: combo ? combo.querySelector('.v').textContent.trim() : null,
          comboN: combo ? combo.querySelector('.n')?.textContent.trim() : null,
          plainNetCard: cards.some((c) => (c.querySelector('.k')?.textContent.trim()) === 'Net per pay period'),
        };
      });
      H.check('detail page folds next pay into one NEXT NET PAY DATE card (date + net), no standalone line',
        !!apiDetailJob.next_pay_date && !detailCombo.hasStandalone
          && detailCombo.comboK === 'Next net pay date' && detailCombo.comboV === nextDateLabel
          && detailCombo.comboN === nextNet && !detailCombo.plainNetCard,
        JSON.stringify(detailCombo));
      H.check('detail header has Edit/Delete buttons',
        await page.evaluate(() => !!document.querySelector('#earnJobDetailEditBtn')
          && !!document.querySelector('#earnJobDetailDeleteBtn')));
      // Rendered header, not just missing ids: the header row above
      // the card is a toolbar with one plain link and zero buttons,
      // while the pay-change/bonus row buttons below stay in place.
      const jobHead = await page.evaluate(() => {
        const d = document.querySelector('#earnJobDetail');
        const head = d ? d.firstElementChild : null;
        const back = document.querySelector('#earnJobBackLink');
        const rowBtns = [...document.querySelectorAll('#earnJobDetail button')]
          .filter((b) => (b.getAttribute('onclick') || '').includes('earnJobDetail'));
        return {
          backTag: back ? back.tagName : null,
          backText: back ? back.textContent.trim() : null,
          backHref: back ? back.getAttribute('href') : null,
          backClass: back ? back.className : null,
          headButtons: head ? head.querySelectorAll('button').length : null,
          headIsToolbar: !!head && head.classList.contains('toolbar'),
          rowBtns: rowBtns.length,
        };
      });
      H.check('detail header back is a plain link above the card with no buttons, row buttons stay',
        jobHead.backTag === 'A' && jobHead.backText === '← Back to Salary' && jobHead.backHref === '#earnings/salary'
          && jobHead.backClass === '' && jobHead.headButtons === 0 && jobHead.headIsToolbar && jobHead.rowBtns > 0,
        JSON.stringify(jobHead));
      const detailActions = await page.evaluate(() => {
        const d = document.querySelector('#earnJobDetail');
        const head = d ? d.querySelector('.panel .section-head') : null;
        return {
          rowExists: !!document.querySelector('#earnJobDetailActions'),
          headerEdit: !!document.querySelector('#earnJobDetailEditBtn'),
          headerDelete: !!document.querySelector('#earnJobDetailDeleteBtn'),
          headerEditInHead: !!head && !!head.querySelector('#earnJobDetailEditBtn'),
          headerDeleteInHead: !!head && !!head.querySelector('#earnJobDetailDeleteBtn'),
          editClass: document.querySelector('#earnJobDetailEditBtn')?.className || null,
          deleteClass: document.querySelector('#earnJobDetailDeleteBtn')?.className || null,
        };
      });
      H.check('detail header has Edit + Delete by the title, bottom row gone',
        !detailActions.rowExists && detailActions.headerEdit && detailActions.headerDelete
          && detailActions.headerEditInHead && detailActions.headerDeleteInHead
          && detailActions.editClass.includes('small') && !detailActions.editClass.includes('danger')
          && detailActions.deleteClass.includes('small') && detailActions.deleteClass.includes('danger'),
        JSON.stringify(detailActions));
      // Edit from the detail header opens the shared modal prefilled.
      await page.click('#earnJobDetailEditBtn');
      await wait(300);
      H.check('detail header Edit opens the prefilled job modal',
        await page.evaluate((employer) => {
          const m = document.querySelector('#earnJobModal');
          const f = document.querySelector('#earnJobForm');
          return m && !m.classList.contains('hidden') && f && f.employer.value === employer;
        }, apiDetailJob.employer));
      await page.evaluate(() => {
        [...document.querySelectorAll('#earnJobModal button')].find((b) => b.textContent.trim() === 'Cancel').click();
      });
      await wait(300);
      await page.keyboard.press('Escape');
      await wait(300);
      await page.click('#earnJobBackLink');
      try { await page.waitForFunction(() => location.hash === '#earnings/salary', { timeout: 5000 }); } catch {}
      const jobBackNav = await page.evaluate(() => ({
        hash: location.hash,
        detailHidden: document.querySelector('#earnJobDetail').classList.contains('hidden'),
      }));
      H.check('clicking the job detail back link returns to the Salary list',
        jobBackNav.hash === '#earnings/salary' && jobBackNav.detailHidden === true, JSON.stringify(jobBackNav));
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('card shows the same next pay date as the detail page',
        await untilEval((args) => {
          const card = document.querySelector(`.earn-job-card[data-job-id="${args.id}"]`);
          return card && card.textContent.includes(args.label);
        }, { id: detailJobId, label: nextLabel }));
      // Next pay date fix (user rule 2026-11-01): the list card pairs
      // the date with the take-home figure, and the API date anchors
      // on the RECENT payment date, not the start date. The cadence
      // pin is run-date-proof: the next date stays on the 14-day
      // Friday run from the recent payment (or one day early off a
      // holiday), never on the old start-date Monday run.
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Meta Anchor Corp', province: 'BC', frequency: 'biweekly',
        start_date: '2022-06-06', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
      });
      H.check('meta-like job creates for the anchor pin', r.status === 201, JSON.stringify(r.data));
      const anchorJobId = r.data.id;
      const anchorJob = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === anchorJobId);
      const anchorDiff = anchorJob && anchorJob.next_pay_date
        ? Math.round((new Date(`${anchorJob.next_pay_date}T00:00:00Z`) - new Date('2026-10-23T00:00:00Z')) / 86400000)
        : null;
      H.check('recent-anchored next pay date stays on the 14-day cadence (or one day early off a holiday)',
        !!anchorJob && !!anchorJob.next_pay_date && anchorDiff > 0 && (anchorDiff % 14 === 0 || anchorDiff % 14 === 13),
        JSON.stringify(anchorJob && anchorJob.next_pay_date));
      // (page.reload, not goto: the page is already on #earnings/salary
      // and a same-URL goto fires no hashchange, so the list would
      // never re-fetch the API-created job.)
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      const anchorNet = anchorJob ? Number(anchorJob.calc.perPeriod.net).toLocaleString('en-CA',
        { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
      H.check('list card pairs next pay date with take-home on one line',
        await untilEval((args) => {
          const card = document.querySelector(`.earn-job-card[data-job-id="${args.id}"]`);
          return !!card && card.textContent.includes('Next pay date') && card.textContent.includes(`Take-home ${args.net}`);
        }, { id: anchorJobId, net: anchorNet }));
      r = await H.req('DELETE', `/api/earnings/jobs/${anchorJobId}`);
      H.check('anchor pin job cleaned up', r.status === 200);
      H.check('card offers no Edit/Delete buttons (click navigates instead)',
        await page.evaluate((id) => {
          const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
          return !!card && card.querySelectorAll('button').length === 0;
        }, detailJobId));
      // Edit from the detail header: the detail page refreshes with the new name.
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, detailJobId);
      await wait(900);
      await until(() => {
        const d = document.querySelector('#earnJobDetail');
        return d && !d.classList.contains('hidden') && !!document.querySelector('#earnJobDetailEditBtn');
      });
      await page.click('#earnJobDetailEditBtn');
      await wait(300);
      await page.evaluate(() => {
        document.querySelector('#earnJobForm [name=employer]').value = 'Detail Corp II';
      });
      await page.click('#earnJobModal button[type=submit]');
      await wait(900);
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, detailJobId);
      H.check('editing job fields from the detail header persists on the detail page',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && d.textContent.includes('Detail Corp II') && d.textContent.includes('$96,000.00');
        }));
      // The header edit uses the same shared form: it shows the gross
      // field with the toggle back at Gross, never a take-home value.
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, detailJobId);
      await wait(900);
      await until(() => {
        const d = document.querySelector('#earnJobDetail');
        return d && !d.classList.contains('hidden') && !!document.querySelector('#earnJobDetailEditBtn');
      });
      await page.click('#earnJobDetailEditBtn');
      await wait(300);
      H.check('header edit shows the gross field (toggle back at Gross)',
        await page.evaluate(() => {
          const f = document.querySelector('#earnJobForm');
          return f.querySelector('[name=pay_value_basis]:checked')?.value === 'gross'
            && parseFloat(f.recent_pay_value.value.replace(/,/g, '')) === 3500;
        }));
      await page.evaluate(() => {
        [...document.querySelectorAll('#earnJobModal button')].find((b) => b.textContent.trim() === 'Cancel').click();
      });
      await wait(300);
      // Delete from the detail header returns to a list without the job.
      // (The page-wide dialog handler registered earlier accepts the confirm.)
      await page.click('#earnJobDetailDeleteBtn');
      H.check('deleting from the detail header removes the job from the salary list',
        await until(() => {
          const list = document.querySelector('#earnJobList');
          return location.hash === '#earnings/salary'
            && list && !list.textContent.includes('Detail Corp II');
        }));
      const detailGone = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === detailJobId);
      H.check('the deleted job is gone server-side', !detailGone);
      // Delete from the detail body returns to the list without the job.
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Detail Delete Corp', province: 'BC', frequency: 'biweekly',
        start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
      });
      const detailDeleteJobId = r.data.id;
      // Already on the salary hash: goto to the same URL is a no-op,
      // so reload to pick up the server-side fixture (legacy pattern).
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, detailDeleteJobId);
      H.check('detail-delete fixture card lands on its detail page',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return location.hash.startsWith('#earnings/job/')
            && d && !d.classList.contains('hidden') && d.textContent.includes('Detail Delete Corp');
        }));
      await page.click('#earnJobDetailDeleteBtn');
      H.check('deleting from the detail header returns to the salary list without the job',
        await until(() => {
          const list = document.querySelector('#earnJobList');
          return location.hash === '#earnings/salary'
            && list && !list.textContent.includes('Detail Delete Corp');
        }));
      const detailDeleteGone = (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === detailDeleteJobId);
      H.check('the detail-deleted job is gone server-side', !detailDeleteGone);
      // A dateless legacy job shows no next-pay-date highlight anywhere.
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Legacy Corp', province: 'BC', frequency: 'biweekly',
        gross_amount: 3000, gross_basis: 'period', tax_year: 2026,
      });
      const datelessJobId = r.data.id;
      H.check('legacy job carries no next pay date from the API', !r.data.next_pay_date);
      // Already on the salary hash: goto to the same URL is a no-op,
      // so reload to pick up the server-side fixture.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('legacy job card shows no next pay date highlight',
        await untilEval((id) => {
          const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
          return card && !card.querySelector('.earn-next-pay');
        }, datelessJobId));
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, datelessJobId);
      H.check('legacy job detail shows no next pay date highlight',
        await untilEval(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && !d.classList.contains('hidden') && !d.querySelector('.earn-next-pay');
        }, null));
      H.check('legacy job detail falls back to the plain Net per pay period card',
        await untilEval(() => {
          const d = document.querySelector('#earnJobDetail');
          if (!d || d.classList.contains('hidden') || !d.textContent.includes('Legacy Corp')) return false;
          const cards = [...d.querySelectorAll('.summary-card')];
          return cards.some((c) => (c.querySelector('.k')?.textContent.trim()) === 'Net per pay period')
            && !cards.some((c) => (c.querySelector('.k')?.textContent.trim()) === 'Next net pay date');
        }, null));
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (card) card.click();
      }, datelessJobId);
      await wait(900);
      await until(() => {
        const d = document.querySelector('#earnJobDetail');
        return d && !d.classList.contains('hidden') && !!document.querySelector('#earnJobDetailDeleteBtn');
      });
      await page.click('#earnJobDetailDeleteBtn');
      // The delete is async (confirm -> API -> reload): poll the API
      // instead of racing a single read right after the click.
      // The API row vanishes BEFORE the app's delete flow finishes:
      // earnDeleteJob only navigates back to the salary list AFTER
      // its post-delete reload, so also wait for that hash — a later
      // detail goto must not race the trailing navigation, which
      // would yank it back to the salary list.
      let legacyGone = false;
      for (let i = 0; i < 40 && !legacyGone; i++) {
        const jobs = (await H.req('GET', '/api/earnings')).data.jobs;
        legacyGone = !jobs.find((j) => j.id === datelessJobId)
          && await page.evaluate(() => location.hash === '#earnings/salary');
        if (!legacyGone) await wait(300);
      }
      H.check('the legacy fixture job is gone server-side', legacyGone);

      // ---- Salary position model: pay as a position, changes as history ----
      // Create → opening position; gross/period, take-home and annual
      // changes move the position by derivation; history shows the chain
      // end-to-end with the latest entry marked as the current position;
      // delete of the latest falls back; a backfilled older entry never
      // moves the position; a plan-linked job still cannot be deleted.
      let posJobId = null;
      let posTakeJobId = null;
      let posPlanJobId = null;
      let posPlanId = null;
      let posRrspId = null;
      const posGetJob = async (id) => (await H.req('GET', '/api/earnings')).data.jobs.find((x) => x.id === id);
      const posUntilJob = async (id, pred, tries = 40) => {
        for (let i = 0; i < tries; i++) {
          const j = await posGetJob(id);
          if (j && pred(j)) return j;
          await wait(300);
        }
        return null;
      };
      try {
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Position Corp', province: 'BC', frequency: 'biweekly',
        start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
      });
      posJobId = r.data.id;
      H.check('position: create sets the opening position',
        r.status === 201 && !!posJobId && r.data.opening_value === 3000 && r.data.calc.perPeriod.gross === 3000,
        JSON.stringify(r.data));
      await page.goto(`http://ff.local/#earnings/job/${posJobId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('position: detail history shows the opening row as the current position',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && d.textContent.includes('Opening position') && d.textContent.includes('Current position');
        }));
      // Gross per-period change via the detail row modal.
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-06-01';
        f.row_value.value = '3500';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      const posAfterGross = await posUntilJob(posJobId, (j) => j.calc.perPeriod.gross === 3500 && j.calc.annualGross === 91000);
      H.check('position: gross per-period change moves the position',
        !!posAfterGross && posAfterGross.pay_changes.length === 1, JSON.stringify(posAfterGross));
      // Annual gross change: 104000 / 26 periods = 4000 per period.
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-12-01';
        f.row_value.value = '104000';
        f.row_scope.value = 'annual';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      const posAfterAnnual = await posUntilJob(posJobId, (j) => j.calc.perPeriod.gross === 4000 && j.calc.annualGross === 104000);
      H.check('position: annual gross change annualises to the per-period position',
        !!posAfterAnnual && posAfterAnnual.pay_changes.some((c) => c.scope === 'annual' && c.amount === 104000 && c.value === 4000),
        JSON.stringify(posAfterAnnual));
      H.check('position: history shows the annual entry with its derivation',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && d.textContent.includes('/ year') && d.textContent.includes('Current position');
        }));
      // Backfilled older entry must not move the position.
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate(() => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-02-01';
        f.row_value.value = '2800';
      });
      await page.click('#earnJobRowForm button[type=submit]');
      await wait(900);
      const posAfterBackfill = await posGetJob(posJobId);
      H.check('position: backfilled older entry leaves the position alone',
        !!posAfterBackfill && posAfterBackfill.calc.perPeriod.gross === 4000 && posAfterBackfill.pay_changes.length === 3,
        JSON.stringify(posAfterBackfill));
      // Delete the latest (annual) entry from the detail page: the
      // position falls back to the previous entry. (The page-wide
      // dialog handler registered earlier accepts the confirm.)
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#earnJobDetail .note')];
        const row = rows.find((el) => el.textContent.includes('Dec 1, 2026'));
        const btn = row && row.querySelector('button.danger');
        if (btn) btn.click();
      });
      const posAfterDelete = await posUntilJob(posJobId, (j) => j.calc.perPeriod.gross === 3500);
      H.check('position: deleting the latest change falls back to the previous entry',
        !!posAfterDelete && posAfterDelete.pay_changes.length === 2, JSON.stringify(posAfterDelete));
      // Take-home change on a fresh job: the net at 3000 back-solves
      // to exactly 3000 (same profile, no other segments).
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Takehome Corp', province: 'BC', frequency: 'biweekly',
        start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
      });
      posTakeJobId = r.data.id;
      const takeNet = (await posGetJob(posTakeJobId)).calc.perPeriod.net;
      await page.goto(`http://ff.local/#earnings/job/${posTakeJobId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      await page.click('#earnJobDetailAddPayChange');
      await wait(300);
      await page.evaluate((net) => {
        const f = document.querySelector('#earnJobRowForm');
        f.row_date.value = '2026-11-02';
        f.row_value.value = String(net);
        f.querySelector('[name=row_basis][value=takehome]').checked = true;
      }, takeNet);
      await page.click('#earnJobRowForm button[type=submit]');
      const posTake = await posUntilJob(posTakeJobId, (j) => j.pay_changes.length === 1);
      H.check('position: take-home change back-solves to the per-period position',
        !!posTake && posTake.calc.perPeriod.gross === 3000
          && posTake.pay_changes[0].basis === 'takehome' && posTake.pay_changes[0].value === 3000
          && posTake.pay_changes[0].amount === takeNet,
        JSON.stringify(posTake));
      H.check('position: history shows the take-home entry with its derivation',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && d.textContent.includes('take-home') && d.textContent.includes('Current position');
        }));
      // Plan-linked job still cannot be deleted.
      r = await H.req('POST', '/api/earnings/jobs', { employer: 'Pos Plan Corp', province: 'BC', frequency: 'biweekly', gross_amount: 2000, gross_basis: 'period', tax_year: 2026 });
      posPlanJobId = r.data.id;
      r = await H.req('POST', '/api/investments/accounts', { name: 'Pos RRSP', type: 'RRSP' });
      posRrspId = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${posRrspId}/holdings`, { label: 'Pos Fund', kind: 'fund', currency: 'CAD' });
      const posFundId = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${posRrspId}/plans`, { job_id: posPlanJobId, target_holding_id: posFundId, start_date: '2026-01-05', own_amount: 100 });
      posPlanId = r.data.id;
      r = await H.req('DELETE', `/api/earnings/jobs/${posPlanJobId}`);
      H.check('position: deleting a plan-linked job is still a 400',
        r.status === 400 && /contribution plan/.test(r.data.error || ''), JSON.stringify(r.data));
      } finally {
        if (posPlanId) await H.req('DELETE', `/api/investments/plans/${posPlanId}`);
        if (posRrspId) await H.req('DELETE', `/api/investments/accounts/${posRrspId}`);
        if (posPlanJobId) await H.req('DELETE', `/api/earnings/jobs/${posPlanJobId}`);
        if (posJobId) await H.req('DELETE', `/api/earnings/jobs/${posJobId}`);
        if (posTakeJobId) await H.req('DELETE', `/api/earnings/jobs/${posTakeJobId}`);
      }

      // ---- Job detail monthly chart: stacked gross composition ----
      // Fixture ids live outside the nested try so the finally below
      // always cleans up — a mid-block failure must not pollute the
      // later investments/portfolio assertions.
      let monthlyJobId = null;
      let monthlyPlanId = null;
      let monthlyRrspId = null;
      let annualJobId = null;
      let datelessChartJobId = null;
      try {
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Monthly Corp', province: 'BC', frequency: 'biweekly',
        start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
      });
      monthlyJobId = r.data.id;
      // List cards unchanged: the card still shows its next-pay line.
      // The page may already sit on the Salary hash (same-hash goto
      // would not fire the router), so step away first to force a
      // fresh list render that includes the new job.
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(500);
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('salary list card keeps its next-pay line',
        await untilEval((id) => {
          const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
          return card && card.textContent.includes('Monthly Corp') && card.textContent.includes('Next pay date');
        }, monthlyJobId));
      await page.goto(`http://ff.local/#earnings/job/${monthlyJobId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('detail monthly chart draws',
        await until(() => {
          const c = window.__fmCharts.earnJobMonthly;
          return !!c && c.data.labels.length > 0;
        }));
      const monthlyChart = await page.evaluate(() => {
        const c = window.__fmCharts.earnJobMonthly;
        if (!c) return null;
        const byKey = {};
        c.data.datasets.forEach((d) => { byKey[d.key] = d.data; });
        return { labels: c.data.labels, keys: c.data.datasets.map((d) => d.key), byKey };
      });
      // Months run Jan 2026 through the current Vancouver month.
      const vTodayM = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const curYmM = vTodayM.slice(0, 7);
      const expMonthsM = (Number(curYmM.slice(0, 4)) - 2026) * 12 + Number(curYmM.slice(5, 7));
      H.check('detail monthly chart renders Jan 2026 through the current month, no RRSP without a plan',
        monthlyChart && monthlyChart.labels.length === expMonthsM && monthlyChart.labels[0] === 'Jan 2026'
        && !monthlyChart.keys.includes('rrsp')
        && monthlyChart.keys.join(',') === 'tax,cppEi,net',
        JSON.stringify(monthlyChart && { n: monthlyChart.labels.length, first: monthlyChart.labels[0], keys: monthlyChart.keys }));
      const monthlySeries = (await H.req('GET', `/api/earnings/jobs/${monthlyJobId}/monthly-chart`)).data;
      H.check('detail chart stacks to the monthly gross to the cent, every month',
        monthlyChart && monthlySeries.months.every((_, i) =>
          Math.round((monthlyChart.byKey.tax[i] + monthlyChart.byKey.cppEi[i] + monthlyChart.byKey.net[i]) * 100) / 100
          === monthlySeries.gross[i]),
        JSON.stringify(monthlySeries && monthlySeries.gross));
      H.check('detail chart shape: a 3-payday month stacks 1.5x a 2-payday month',
        monthlyChart
        && Math.round((monthlyChart.byKey.tax[2] + monthlyChart.byKey.cppEi[2] + monthlyChart.byKey.net[2]) * 100)
        === Math.round((monthlyChart.byKey.tax[1] + monthlyChart.byKey.cppEi[1] + monthlyChart.byKey.net[1]) * 100 * 1.5),
        JSON.stringify(monthlyChart && { feb: monthlyChart.byKey.tax[1] + monthlyChart.byKey.cppEi[1] + monthlyChart.byKey.net[1], mar: monthlyChart.byKey.tax[2] + monthlyChart.byKey.cppEi[2] + monthlyChart.byKey.net[2] }));
      // RRSP plan: own enters the stack, the employer match does not.
      r = await H.req('POST', '/api/investments/accounts', { name: 'Monthly RRSP', type: 'RRSP' });
      monthlyRrspId = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${monthlyRrspId}/holdings`, { label: 'Monthly Fund', kind: 'fund', currency: 'CAD' });
      const monthlyFundId = r.data.id;
      await H.req('POST', `/api/investments/holdings/${monthlyFundId}/nav`, { date: '2025-12-31', price: 10 });
      r = await H.req('POST', `/api/investments/accounts/${monthlyRrspId}/plans`, { job_id: monthlyJobId, target_holding_id: monthlyFundId, start_date: '2026-01-05', own_amount: 100, employer_amount: 50 });
      monthlyPlanId = r.data.id;
      // The page is already on this job's detail hash, so a goto to
      // the same hash would not fire the router: step away to the
      // Salary list first, then back, to force a redraw.
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(500);
      await page.goto(`http://ff.local/#earnings/job/${monthlyJobId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('detail monthly chart redraws with an RRSP dataset after the plan links',
        await until(() => {
          const c = window.__fmCharts.earnJobMonthly;
          return !!c && c.data.datasets.some((d) => d.key === 'rrsp');
        }));
      const monthlyChartRrsp = await page.evaluate(() => {
        const c = window.__fmCharts.earnJobMonthly;
        if (!c) return null;
        const byKey = {};
        c.data.datasets.forEach((d) => { byKey[d.key] = d.data; });
        return { keys: c.data.datasets.map((d) => d.key), byKey };
      });
      const monthlySeriesRrsp = (await H.req('GET', `/api/earnings/jobs/${monthlyJobId}/monthly-chart`)).data;
      H.check('detail chart RRSP segment is own only: Mar 2026 is 100 x 3 paydays, not 150 x 3',
        monthlyChartRrsp && monthlyChartRrsp.byKey.rrsp[2] === 300 && monthlyChartRrsp.byKey.rrsp[0] === 200,
        JSON.stringify(monthlyChartRrsp && monthlyChartRrsp.byKey.rrsp));
      H.check('detail chart with RRSP still stacks to the monthly gross to the cent',
        monthlyChartRrsp && monthlySeriesRrsp.months.every((_, i) =>
          Math.round((monthlyChartRrsp.byKey.tax[i] + monthlyChartRrsp.byKey.cppEi[i] + monthlyChartRrsp.byKey.rrsp[i] + monthlyChartRrsp.byKey.net[i]) * 100) / 100
          === monthlySeriesRrsp.gross[i]),
        JSON.stringify(monthlySeriesRrsp && monthlySeriesRrsp.gross));
      // Annual job: only the anniversary month bars; other months show no bar.
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Annual Corp', province: 'BC', frequency: 'annual',
        start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 60000,
      });
      annualJobId = r.data.id;
      await page.goto(`http://ff.local/#earnings/job/${annualJobId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('annual detail chart draws',
        await until(() => {
          const c = window.__fmCharts.earnJobMonthly;
          return !!c && c.data.labels.length > 0;
        }));
      const annualChart = await page.evaluate(() => {
        const c = window.__fmCharts.earnJobMonthly;
        if (!c) return null;
        const byKey = {};
        c.data.datasets.forEach((d) => { byKey[d.key] = d.data; });
        return { labels: c.data.labels, byKey };
      });
      H.check('annual detail chart bars only the anniversary month',
        annualChart && annualChart.labels.length === expMonthsM
        && annualChart.byKey.tax.slice(0, 9).every((v, i) => v === 0 && annualChart.byKey.cppEi[i] === 0 && annualChart.byKey.net[i] === 0)
        && annualChart.byKey.tax[9] + annualChart.byKey.cppEi[9] + annualChart.byKey.net[9] > 0,
        JSON.stringify(annualChart && annualChart.byKey));
      // Dateless job: no chart panel at all, never a guessed date.
      r = await H.req('POST', '/api/earnings/jobs', {
        employer: 'Dateless Corp', province: 'BC', frequency: 'annual',
        gross_amount: 60000, gross_basis: 'annual', tax_year: 2026,
      });
      datelessChartJobId = r.data.id;
      await page.goto(`http://ff.local/#earnings/job/${datelessChartJobId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      H.check('dateless job detail shows no monthly chart panel',
        await until(() => {
          const d = document.querySelector('#earnJobDetail');
          return d && !d.classList.contains('hidden') && d.textContent.includes('Dateless Corp')
            && !document.querySelector('#earnJobMonthlyPanel');
        }));
      } finally {
        // Cleanup: plan, then account, then jobs — always, even when
        // a check above failed, so later sections see a clean state.
        if (monthlyPlanId) await H.req('DELETE', `/api/investments/plans/${monthlyPlanId}`);
        if (monthlyRrspId) await H.req('DELETE', `/api/investments/accounts/${monthlyRrspId}`);
        if (monthlyJobId) await H.req('DELETE', `/api/earnings/jobs/${monthlyJobId}`);
        if (annualJobId) await H.req('DELETE', `/api/earnings/jobs/${annualJobId}`);
        if (datelessChartJobId) await H.req('DELETE', `/api/earnings/jobs/${datelessChartJobId}`);
      }
      // ---------------------------------------------------------------
      // Pre-tax RRSP: a linked plan's OWN per-period amount reduces
      // the job's taxable income (federal AND provincial) everywhere
      // the job calc appears — list, detail, monthly chart — while
      // CPP/CPP2/EI stay on the full gross. The employer match never
      // enters: the taxable drop is own x periods, never
      // (own + employer) x periods. A mid-year plan leaves earlier
      // months at full-gross tax. (An employer-ONLY plan cannot be
      // built through the API — validPlanInput requires own > 0 —
      // so that edge is pinned at the unit level, not here.)
      let pretaxJobId = null;
      let pretaxRrspId = null;
      let pretaxPlanId = null;
      try {
        r = await H.req('POST', '/api/earnings/jobs', {
          employer: 'PreTax Corp', province: 'BC', frequency: 'biweekly',
          start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
        });
        pretaxJobId = r.data.id;
        const calcOf = async () => (await H.req('GET', '/api/earnings')).data.jobs.find((j) => j.id === pretaxJobId).calc;
        const before = await calcOf();
        const seriesBefore = (await H.req('GET', `/api/earnings/jobs/${pretaxJobId}/monthly-chart`)).data;
        r = await H.req('POST', '/api/investments/accounts', { name: 'PreTax RRSP', type: 'RRSP' });
        pretaxRrspId = r.data.id;
        r = await H.req('POST', `/api/investments/accounts/${pretaxRrspId}/holdings`, { label: 'PreTax Fund', kind: 'fund', currency: 'CAD' });
        const pretaxFundId = r.data.id;
        await H.req('POST', `/api/investments/holdings/${pretaxFundId}/nav`, { date: '2025-12-31', price: 10 });
        r = await H.req('POST', `/api/investments/accounts/${pretaxRrspId}/plans`, { job_id: pretaxJobId, target_holding_id: pretaxFundId, start_date: '2026-07-06', own_amount: 220.05, employer_amount: 220.05 });
        pretaxPlanId = r.data.id;
        H.check('pre-tax RRSP: plan links with own + employer amounts',
          !!pretaxPlanId, JSON.stringify(r.data));
        const after = await calcOf();
        const seriesAfter = (await H.req('GET', `/api/earnings/jobs/${pretaxJobId}/monthly-chart`)).data;
        const c2 = (n) => Math.round(n * 100) / 100;
        H.check('pre-tax RRSP: taxable income falls by own x 26 exactly, both taxes fall, CPP/EI and gross unchanged',
          after && before
          && c2(before.taxableIncome - after.taxableIncome) === 5721.30
          && after.federalTax < before.federalTax && after.provincialTax < before.provincialTax
          && after.cpp === before.cpp && after.cpp2 === before.cpp2 && after.ei === before.ei
          && after.annualGross === before.annualGross,
          JSON.stringify({ before, after }));
        H.check('pre-tax RRSP: net rises by exactly the tax saved',
          after && before && c2(after.netAnnual - before.netAnnual) === c2(before.totalTax - after.totalTax),
          JSON.stringify({ beforeNet: before && before.netAnnual, afterNet: after && after.netAnnual }));
        const julIdx = seriesBefore.months.indexOf('2026-07');
        H.check('pre-tax RRSP: monthly chart keeps pre-plan months at full-gross tax, cuts post-plan months, RRSP only from July',
          seriesBefore && seriesAfter && julIdx > 0
          && seriesBefore.months.slice(0, julIdx).every((_, i) => seriesAfter.tax[i] === seriesBefore.tax[i])
          && seriesAfter.tax.slice(julIdx).every((t, i) => t < seriesBefore.tax[julIdx + i])
          && seriesAfter.rrsp.slice(0, julIdx).every((v) => v === 0)
          && seriesAfter.rrsp.slice(julIdx).every((v) => v > 0),
          JSON.stringify({ beforeTax: seriesBefore && seriesBefore.tax, afterTax: seriesAfter && seriesAfter.tax, rrsp: seriesAfter && seriesAfter.rrsp }));
        H.check('pre-tax RRSP: monthly chart still stacks to the gross to the cent with the RRSP segment',
          seriesAfter && seriesAfter.months.every((_, i) =>
            Math.round((seriesAfter.tax[i] + seriesAfter.cppEi[i] + seriesAfter.rrsp[i] + seriesAfter.net[i]) * 100) / 100
            === seriesAfter.gross[i]),
          JSON.stringify(seriesAfter && seriesAfter.gross));
      } finally {
        // Cleanup: plan, then account, then job — always, even when
        // a check above failed, so later sections see a clean state.
        if (pretaxPlanId) await H.req('DELETE', `/api/investments/plans/${pretaxPlanId}`);
        if (pretaxRrspId) await H.req('DELETE', `/api/investments/accounts/${pretaxRrspId}`);
        if (pretaxJobId) await H.req('DELETE', `/api/earnings/jobs/${pretaxJobId}`);
      }
      // ---- Term AI Fill: rate fields land in the segment form ----
      // A term with no rate segment yet: Extract must open the
      // segment form with the returned rate filled in (before this
      // fix the form stayed hidden, and its render defaults —
      // Fixed, the term's start date, Semi-annual — counted as
      // hand-filled, so a variable segment could never be set up
      // by the fill at all). A hand-edited field is still kept,
      // and the summary counts the segment fields filled.
      let aiFillPid = null;
      try {
        const aiSetStub = (fields) => fs.writeFileSync(H.aiStubFile, JSON.stringify({ fields }));
        const aiSegState = () => page.evaluate(() => {
          const seg = document.querySelector('[data-seg-form]');
          if (!seg) return null;
          return {
            visible: !seg.classList.contains('hidden'),
            start_date: seg.start_date.value,
            rate_type: seg.rate_type.value,
            rate_mode: seg.rate_mode.value,
            annual_rate: seg.annual_rate.value,
            spread: seg.spread.value,
            compounding: seg.compounding.value,
            accrual: seg.accrual.value,
            locked_on: seg.locked_on.value,
            modeVisible: !seg.querySelector('[data-seg-mode]').classList.contains('hidden'),
            spreadVisible: !seg.querySelector('[data-seg-spread]').classList.contains('hidden'),
            rateVisible: !seg.querySelector('[data-seg-rate]').classList.contains('hidden'),
            flags: seg.querySelectorAll('.ai-flag').length,
          };
        });
        const aiSummary = () => page.evaluate(() => {
          const s = document.querySelector('[data-term-form] [data-ai-summary]');
          return s ? s.textContent : null;
        });
        const aiExtract = async (text) => {
          await page.evaluate(() => {
            const panel = document.querySelector('[data-term-form] [data-ai-panel]');
            if (panel && panel.classList.contains('hidden')) document.querySelector('[data-term-form] [data-ai-toggle]').click();
            const s = document.querySelector('[data-term-form] [data-ai-summary]');
            if (s) { s.textContent = ''; s.classList.add('hidden'); }
          });
          await wait(200);
          await page.evaluate((t) => { document.querySelector('[data-term-form] [data-ai-text]').value = t; }, text);
          await page.evaluate(() => document.querySelector('[data-term-form] [data-ai-extract]').click());
          await until(() => {
            const s = document.querySelector('[data-term-form] [data-ai-summary]');
            return s && !s.classList.contains('hidden') && s.textContent.includes('Filled');
          });
        };
        r = await H.req('POST', '/api/properties', { address: '9 AI Fill Segment Close, Victoria, BC', purchase_date: '2026-01-15' });
        aiFillPid = r.data && r.data.id;
        H.check('ai-fill segment: fixture property created', aiFillPid != null, JSON.stringify(r.data));
        r = await H.req('POST', `/api/properties/${aiFillPid}/terms`, {
          lender: 'RBC', start_date: '2026-01-15', term_months: 60, amortization_years: 25,
          opening_balance: 500000, payment_frequency: 'monthly', repayment_method: 'equal_payment',
        });
        H.check('ai-fill segment: term with no segments created', !!(r.data && r.data.id), JSON.stringify(r.data));
        await page.goto(`http://ff.local/#property/${aiFillPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
        await wait(1600);
        await page.evaluate(() => document.querySelector('#openMortgageBtn').click());
        await wait(500);
        await page.evaluate(() => {
          const body = document.querySelector('.term-body');
          if (body && body.classList.contains('hidden')) document.querySelector('[data-term-toggle]').click();
        });
        await wait(300);
        H.check('ai-fill segment: the term carries an AI Fill panel and its segment form starts hidden',
          await page.evaluate(() => !!document.querySelector('[data-term-form] [data-ai-toggle]')
            && !!document.querySelector('[data-seg-form]')
            && document.querySelector('[data-seg-form]').classList.contains('hidden')));
        // Order 1: Extract with the segment form still closed — the
        // fill opens it with the variable prime-spread rate filled.
        aiSetStub({
          segment_start_date: '2026-04-27', segment_rate_type: 'variable',
          segment_rate_mode: 'prime_spread', segment_spread: -0.8, segment_compounding: 'monthly',
        });
        await aiExtract('RBC variable Prime minus 0.80 from April 2026, monthly compounding');
        const seg1 = await aiSegState();
        H.check('ai-fill segment: Extract opens the segment form with the variable rate filled (type/mode/spread/start/compounding)',
          !!seg1 && seg1.visible && seg1.rate_type === 'variable' && seg1.rate_mode === 'prime_spread'
            && seg1.spread === '-0.8' && seg1.start_date === '2026-04-27' && seg1.compounding === 'monthly'
            && seg1.modeVisible && seg1.spreadVisible && !seg1.rateVisible,
          JSON.stringify(seg1));
        H.check('ai-fill segment: the filled rate fields carry ✨ flags',
          !!seg1 && seg1.flags >= 4, JSON.stringify(seg1));
        H.check('ai-fill segment: the summary counts all five segment fields filled',
          (await aiSummary()) === 'Filled 5 fields', JSON.stringify(await aiSummary()));
        // Order 2: the form is already open — a hand-edited spread
        // is kept, the AI-flagged fields still re-fill.
        await page.evaluate(() => {
          const seg = document.querySelector('[data-seg-form]');
          seg.spread.value = '-1.25';
          seg.spread.dispatchEvent(new Event('input', { bubbles: true }));
          seg.spread.dispatchEvent(new Event('change', { bubbles: true }));
        });
        aiSetStub({
          segment_spread: -0.5, segment_start_date: '2026-05-01', segment_compounding: 'semi_annual',
        });
        await aiExtract('RBC variable Prime minus 0.50 from May 2026, semi-annual compounding');
        const seg2 = await aiSegState();
        H.check('ai-fill segment: a hand-edited spread is kept while the flagged fields re-fill',
          !!seg2 && seg2.spread === '-1.25' && seg2.start_date === '2026-05-01' && seg2.compounding === 'semi_annual',
          JSON.stringify(seg2));
        H.check('ai-fill segment: the second summary counts the kept field (2 filled · 1 kept)',
          (await aiSummary()) === 'Filled 2 fields · 1 kept', JSON.stringify(await aiSummary()));
        // Nothing was saved by either Extract: the property still
        // has no rate segments until the segment form is submitted.
        r = await H.req('GET', `/api/properties/${aiFillPid}`);
        H.check('ai-fill segment: Extract wrote nothing (no segments until Save)',
          Array.isArray(r.data.segments) && r.data.segments.length === 0, JSON.stringify(r.data.segments));
        // Order 3: a fixed segment's lock is dropped server-side —
        // the form never shows it, and the saved segment has none.
        // (Before the first save here, so the form holds no
        // carried-over draft lock from an earlier segment.)
        aiSetStub({
          segment_start_date: '2026-01-15', segment_rate_type: 'fixed',
          segment_rate_mode: 'absolute', segment_annual_rate: 4.79,
          segment_accrual: 'daily', segment_locked_on: '2026-04-01',
        });
        await aiExtract('RBC fixed 4.79% from Jan 2026, interest accrues daily, locked Apr 1 2026');
        const seg3 = await aiSegState();
        H.check('ai-fill segment: a fixed fill takes accrual daily but leaves Locked on blank (lock dropped)',
          !!seg3 && seg3.visible && seg3.rate_type === 'fixed' && seg3.rate_mode === 'absolute'
            && seg3.annual_rate === '4.79' && seg3.accrual === 'daily' && seg3.locked_on === ''
            && seg3.spread === '-1.25' && seg3.rateVisible && !seg3.spreadVisible && seg3.flags === 6,
          JSON.stringify(seg3));
        H.check('ai-fill segment: the fixed summary counts the five placed fields, no lock',
          (await aiSummary()) === 'Filled 5 fields', JSON.stringify(await aiSummary()));
        await page.evaluate(() => document.querySelector('[data-seg-form] [data-seg-submit]').click());
        await wait(1700);
        r = await H.req('GET', `/api/properties/${aiFillPid}`);
        const fixedSeg = (r.data.segments || []).find((s) => s.rate_mode === 'absolute') || {};
        H.check('ai-fill segment: the saved fixed segment has accrual daily and no lock',
          fixedSeg.accrual === 'daily' && fixedSeg.locked_on == null && fixedSeg.annual_rate === 4.79
            && (fixedSeg.ai_fields || []).includes('accrual'),
          JSON.stringify(fixedSeg));
        // Order 4: a prime_spread fill now carries accrual + the
        // pricing lock — both land in the open form, and Save
        // persists them on the segment.
        aiSetStub({
          segment_start_date: '2026-04-27', segment_rate_type: 'variable',
          segment_rate_mode: 'prime_spread', segment_spread: -0.8,
          segment_compounding: 'monthly', segment_accrual: 'daily', segment_locked_on: '2026-04-01',
        });
        await aiExtract('RBC variable Prime minus 0.80, locked Apr 1 2026, interest accrues daily');
        const seg4 = await aiSegState();
        H.check('ai-fill segment: Extract fills accrual daily + Locked on 2026-04-01 on a prime_spread segment',
          !!seg4 && seg4.visible && seg4.rate_type === 'variable' && seg4.rate_mode === 'prime_spread'
            && seg4.spread === '-1.25' && seg4.accrual === 'daily' && seg4.locked_on === '2026-04-01'
            && seg4.spreadVisible && seg4.flags === 7,
          JSON.stringify(seg4));
        H.check('ai-fill segment: the lock + accrual summary counts 6 filled · 1 kept (hand-edited spread)',
          (await aiSummary()) === 'Filled 6 fields · 1 kept', JSON.stringify(await aiSummary()));
        await page.evaluate(() => document.querySelector('[data-seg-form] [data-seg-submit]').click());
        await wait(1700);
        r = await H.req('GET', `/api/properties/${aiFillPid}`);
        const savedSeg = (r.data.segments || []).find((s) => s.rate_mode === 'prime_spread') || {};
        H.check('ai-fill segment: Save persists accrual daily + locked_on on the segment',
          savedSeg.accrual === 'daily' && savedSeg.locked_on === '2026-04-01'
            && savedSeg.rate_mode === 'prime_spread' && savedSeg.spread === -1.25
            && (savedSeg.ai_fields || []).includes('accrual') && (savedSeg.ai_fields || []).includes('locked_on'),
          JSON.stringify(savedSeg));
        H.check('ai-fill segment: the saved row shows the Locked badge with a ✨ flag',
          await page.evaluate(() => {
            const row = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('Locked 2026-04-01'));
            return !!row && !!row.querySelector('.badge.lock + .ai-flag');
          }));
      } finally {
        fs.writeFileSync(H.aiStubFile, JSON.stringify({ fields: {} }));
        if (aiFillPid != null) await H.req('DELETE', `/api/properties/${aiFillPid}`);
      }
      // Riverbend pre-anchor history on the chart itself (browser
      // scope — the API-only Riverbend block below has no `page`):
      // the same two-term fixture, the default 1-year range
      // (Dec 2025–Nov 2026). The Outstanding principal line draws
      // the pre-anchor months in month order from Dec 2025, and the
      // anchor point plots the anchor-state balance — the raw
      // $489,429.67 appears nowhere.
      {
        let rbChartId = null;
        try {
          let r = await H.req('POST', '/api/properties', { address: '77-3010 Riverbend Dr, Coquitlam, BC', purchase_date: '2024-04-16' });
          rbChartId = r.data && r.data.id;
          const t1 = await H.req('POST', `/api/properties/${rbChartId}/terms`, { lender: 'Royal Bank of Canada', start_date: '2024-04-16', term_months: 25, amortization_years: 24, opening_balance: 489429.67, payment_frequency: 'weekly', repayment_method: 'equal_payment' });
          const t1Id = t1.data && t1.data.id;
          await H.req('POST', `/api/properties/${rbChartId}/rates`, { term_id: t1Id, start_date: '2024-04-16', rate_type: 'fixed', annual_rate: 4.79, compounding: 'semi_annual', accrual: 'monthly' });
          const t2 = await H.req('POST', `/api/properties/${rbChartId}/terms`, { lender: 'Royal Bank of Canada', start_date: '2026-04-27', term_months: 60, amortization_years: 22, opening_balance: 465439.31, payment_frequency: 'weekly', repayment_method: 'equal_payment' });
          const t2Id = t2.data && t2.data.id;
          await H.req('POST', `/api/properties/${rbChartId}/rates`, { term_id: t2Id, start_date: '2026-04-16', rate_type: 'variable', rate_mode: 'prime_spread', spread: -0.8, compounding: 'semi_annual', accrual: 'monthly', locked_on: '2026-04-01' });
          await H.req('PUT', `/api/properties/${rbChartId}`, { mortgage_balance: 489429.67, mortgage_balance_date: '2026-04-27' });
          const rbAmort = await H.req('GET', `/api/properties/${rbChartId}/amortization`);
          // The page sits on another property's detail hash — a
          // same-route goto would not fire the router — so step away
          // first to force a fresh render of this property.
          await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
          await wait(500);
          await page.goto(`http://ff.local/#property/${rbChartId}`, { waitUntil: 'networkidle0', timeout: 30000 });
          await wait(1600);
          const ymDec = (s) => { const [y, m] = s.split('-').map(Number); return y + (m - 1) / 12; };
          const outDs = await page.evaluate(() => {
            const c = window.__fmCharts.a;
            if (!c) return null;
            const ds = c.data.datasets.find((d) => d.label === 'Outstanding principal');
            return ds ? ds.data.map((p) => ({ x: p.x, y: p.y })) : null;
          });
          const xs = outDs ? outDs.map((p) => p.x) : [];
          const sorted = xs.every((x, i) => i === 0 || x >= xs[i - 1]);
          const anchorPt = outDs ? outDs.find((p) => Math.abs(p.x - ymDec('2026-04')) < 1e-9) : null;
          H.check('Riverbend pre-anchor: the hero chart draws Term 1 history in the 1-year range — points in month order from Dec 2025, anchor point at the anchor-state balance',
            !!outDs && sorted && Math.abs(xs[0] - ymDec('2025-12')) < 1e-9
              && !!anchorPt && Math.abs(anchorPt.y - 465439.31) < 0.01
              && !outDs.some((p) => Math.abs(p.y - 489429.67) < 0.01),
            JSON.stringify({ n: outDs && outDs.length, firstX: xs[0], anchorPt }));
          // The monthly table pages back to 2025: in the 1-year window
          // the 2025 page holds exactly the Dec 2025 pre-anchor row,
          // with the API's balance.
          const schedYears = await page.evaluate(() => [...document.querySelectorAll('#scheduleYearSelect option')].map((o) => o.value));
          H.check('Riverbend pre-anchor: the monthly table pages back to 2025 (pre-anchor months listed)',
            schedYears.includes('2025') && schedYears.includes('2026'),
            JSON.stringify(schedYears));
          await page.evaluate(() => {
            const s = document.querySelector('#scheduleYearSelect');
            s.value = '2025';
            s.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await wait(300);
          const dec25Api = rbAmort.data.series.find((row) => row.month === '2025-12');
          const dec25Row = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('#scheduleRows tr')];
            const tr = rows.find((r) => r.children[0].textContent.trim().startsWith('Dec'));
            if (!tr) return null;
            const nums = [...tr.children].map((td) => Number(td.textContent.replace(/[^0-9.\-]/g, '')));
            return { label: tr.children[0].textContent.trim(), n: rows.length, nums };
          });
          H.check('Riverbend pre-anchor: the 2025 table page holds exactly the Dec 2025 pre-anchor row, with the API balance',
            !!dec25Api && !!dec25Row && dec25Row.label === 'Dec 2025' && dec25Row.n === 1
              && dec25Row.nums.some((n) => Math.abs(n - dec25Api.balance) < 0.01),
            JSON.stringify({ dec25Row, api: dec25Api && dec25Api.balance }));
        } finally {
          if (rbChartId != null) await H.req('DELETE', `/api/properties/${rbChartId}`);
        }
      }

    } catch (err) {
      // A UI hiccup must surface as failed checks, not crash the suite.
      H.check('money UI browser flow runs to completion', false, String((err && err.message) || err));
    }
    } finally {
      await browser.close();
    }
  }

  // ---------------------------------------------------------- multi-term
  // mortgage chaining (Riverbend): a property with two terms whose
  // anchor is the FIRST term's opening balance dated at the SECOND
  // term's start must chain — the second term's opening reconciles
  // the balance, the first term's payment still derives from its
  // own opening, and the current principal reflects the chained
  // repayments instead of the anchor balance. The hero chart +
  // monthly table ALSO show Term 1's history (a display-only replay
  // anchored at Term 1's opening, prepended before the anchor
  // month) while every figure still comes from the anchor-based
  // main run — the anchor itself never moves.
  {
    let riverbendId = null;
    try {
      // The live prime history (stub) prices the locked variable
      // rate: prime on 2026-04-01 (4.45%) − 0.80 = 3.65%.
      const prime = await H.req('GET', '/api/prime');
      const history = Array.isArray(prime.data.history) ? prime.data.history : [];
      const fallbackRate = prime.data.current ? prime.data.current.rate : null;
      const primeOn = enginePrimeAtDate(history, fallbackRate);
      const lockedRate = primeOn ? primeOn('2026-04-01') - 0.8 : null;
      H.check('Riverbend pin: live prime history resolves the locked rate',
        lockedRate != null && Math.abs(lockedRate - 3.65) < 0.01,
        JSON.stringify({ lockedRate, history }));

      let r = await H.req('POST', '/api/properties', { address: '77-3010 Riverbend Dr, Coquitlam, BC', purchase_date: '2024-04-16' });
      riverbendId = r.data && r.data.id;
      H.check('Riverbend pin: property created', riverbendId != null, JSON.stringify(r.data));
      const t1 = await H.req('POST', `/api/properties/${riverbendId}/terms`, { lender: 'Royal Bank of Canada', start_date: '2024-04-16', term_months: 25, amortization_years: 24, opening_balance: 489429.67, payment_frequency: 'weekly', repayment_method: 'equal_payment' });
      const t1Id = t1.data && t1.data.id;
      H.check('Riverbend pin: Term 1 created', t1Id != null, JSON.stringify(t1.data));
      await H.req('POST', `/api/properties/${riverbendId}/rates`, { term_id: t1Id, start_date: '2024-04-16', rate_type: 'fixed', annual_rate: 4.79, compounding: 'semi_annual', accrual: 'monthly' });
      // Opening passed explicitly: the renewal prefill must not
      // overwrite the term's own opening balance.
      const t2 = await H.req('POST', `/api/properties/${riverbendId}/terms`, { lender: 'Royal Bank of Canada', start_date: '2026-04-27', term_months: 60, amortization_years: 22, opening_balance: 465439.31, payment_frequency: 'weekly', repayment_method: 'equal_payment' });
      const t2Id = t2.data && t2.data.id;
      H.check('Riverbend pin: Term 2 created with its own opening', t2Id != null && Number(t2.data.opening_balance) === 465439.31, JSON.stringify(t2.data));
      // The variable segment starts 2026-04-16 (before Term 2's
      // start), so it must be tied to Term 2 explicitly — the
      // span lookup would otherwise assign it to Term 1.
      await H.req('POST', `/api/properties/${riverbendId}/rates`, { term_id: t2Id, start_date: '2026-04-16', rate_type: 'variable', rate_mode: 'prime_spread', spread: -0.8, compounding: 'semi_annual', accrual: 'monthly', locked_on: '2026-04-01' });
      // Reproduce the user's anchor state: Term 1's opening
      // balance carried to Term 2's start date.
      await H.req('PUT', `/api/properties/${riverbendId}`, { mortgage_balance: 489429.67, mortgage_balance_date: '2026-04-27' });

      const detail = await H.req('GET', `/api/properties/${riverbendId}`);
      const terms = (detail.data && detail.data.terms) || [];
      const term1 = terms.find((t) => t.id === t1Id) || {};
      const term2 = terms.find((t) => t.id === t2Id) || {};
      // Term 1's triple derives from its own opening — the
      // projection never reaches it, so the server fills it in.
      H.check('Riverbend pin: Term 1 payment derives from its own opening (≈ $2,849.29/mo)',
        Math.abs(term1.paymentDerived - engineDerive(489429.67, 4.79, 24)) < 0.5 && term1.paymentUsed === term1.paymentDerived,
        JSON.stringify({ derived: term1.paymentDerived, used: term1.paymentUsed }));
      // Term 2's payment derives from ITS opening at the locked
      // rate — not from the anchor balance.
      const term2Derived = lockedRate != null ? engineDerive(465439.31, lockedRate, 22) : null;
      H.check('Riverbend pin: Term 2 payment derives from its opening at the locked rate (≈ $2,560.43/mo)',
        term2Derived != null && Math.abs(term2.paymentDerived - term2Derived) < 0.5,
        JSON.stringify({ derived: term2.paymentDerived, expected: term2Derived, lockedRate }));
      H.check('Riverbend pin: property payment follows the current term',
        term2Derived != null && Math.abs(detail.data.paymentUsed - term2Derived) < 0.5,
        JSON.stringify({ used: detail.data.paymentUsed }));

      // The current principal must agree with an independent
      // engine run on the same inputs and live prime history, and
      // must sit far from the buggy anchor-derived $480,756.
      const engineProj = engineSchedule({
        balance: 489429.67, balanceDate: '2026-04-27',
        terms: [
          { id: t1Id, start_date: '2024-04-16', term_months: 25, amortization_years: 24, opening_balance: 489429.67, repayment_method: 'equal_payment' },
          { id: t2Id, start_date: '2026-04-27', term_months: 60, amortization_years: 22, opening_balance: 465439.31, repayment_method: 'equal_payment' },
        ],
        segments: [
          { start_date: '2024-04-16', rate_type: 'fixed', annual_rate: 4.79, compounding: 'semi_annual', accrual: 'monthly' },
          { start_date: '2026-04-16', rate_type: 'variable', rate_mode: 'prime_spread', spread: -0.8, compounding: 'semi_annual', accrual: 'monthly', locked_on: '2026-04-01' },
        ],
        lumpSums: [], paymentDay: null, frequency: 'weekly',
        primeRate: fallbackRate, primeHistory: history, region: 'CA',
      });
      const expectedBalance = engineRemainingBalance(engineProj.series, detail.data.remainingBalanceMonth, 489429.67, engineProj.payoffMonth).balance;
      H.check('Riverbend pin: current principal agrees with the engine (chained, not anchor)',
        Math.abs(detail.data.remainingBalance - expectedBalance) <= 1,
        JSON.stringify({ api: detail.data.remainingBalance, engine: expectedBalance, month: detail.data.remainingBalanceMonth }));
      H.check('Riverbend pin: current principal is far from the buggy $480,756',
        Math.abs(detail.data.remainingBalance - 480756) > 10000 && detail.data.remainingBalance > 440000 && detail.data.remainingBalance < 470000,
        JSON.stringify({ api: detail.data.remainingBalance }));

      // ---- Pre-anchor history: the hero chart + monthly table show
      // Term 1's months from its start (2024-04), while every figure
      // still comes from the anchor-based main run. ----
      const amort = await H.req('GET', `/api/properties/${riverbendId}/amortization`);
      H.check('Riverbend pre-anchor: amortization series starts at the earliest term\'s start month (2024-04)',
        amort.data && Array.isArray(amort.data.series) && amort.data.series[0] && amort.data.series[0].month === '2024-04',
        JSON.stringify(amort.data && amort.data.series && amort.data.series.slice(0, 2)));
      // The prepended months are exactly the display-only replay:
      // an independent engine run anchored at Term 1's opening.
      const engineReplay = engineSchedule({
        balance: 489429.67, balanceDate: '2024-04-16',
        terms: [
          { id: t1Id, start_date: '2024-04-16', term_months: 25, amortization_years: 24, opening_balance: 489429.67, repayment_method: 'equal_payment' },
          { id: t2Id, start_date: '2026-04-27', term_months: 60, amortization_years: 22, opening_balance: 465439.31, repayment_method: 'equal_payment' },
        ],
        segments: [
          { start_date: '2024-04-16', rate_type: 'fixed', annual_rate: 4.79, compounding: 'semi_annual', accrual: 'monthly' },
          { start_date: '2026-04-16', rate_type: 'variable', rate_mode: 'prime_spread', spread: -0.8, compounding: 'semi_annual', accrual: 'monthly', locked_on: '2026-04-01' },
        ],
        lumpSums: [], paymentDay: null, frequency: 'weekly',
        primeRate: fallbackRate, primeHistory: history, region: 'CA',
      });
      const preAnchor = amort.data.series.filter((row) => row.month < '2026-04');
      const replayPre = engineReplay.series.filter((row) => row.month < '2026-04');
      H.check('Riverbend pre-anchor: prepended months match the independent replay anchored at Term 1\'s opening',
        preAnchor.length === replayPre.length && preAnchor.length > 0
          && preAnchor.every((row, i) => row.month === replayPre[i].month
            && Math.abs(row.balance - replayPre[i].balance) < 0.01
            && Math.abs(row.payment - replayPre[i].payment) < 0.01),
        JSON.stringify({ pre: preAnchor.length, replay: replayPre.length, first: preAnchor[0], last: preAnchor[preAnchor.length - 1] }));
      const dec24 = amort.data.series.find((row) => row.month === '2024-12');
      H.check('Riverbend pre-anchor: Dec 2024 row balance ≈ $481,463 (Term 1 fixed-rate replay)',
        !!dec24 && Math.abs(dec24.balance - 481463.18) < 1,
        JSON.stringify(dec24));
      // The anchor month has no series row (no payment falls in
      // it): the table jumps Mar -> May, and the chart's anchor
      // point bridges the gap.
      const months = amort.data.series.map((row) => row.month);
      H.check('Riverbend pre-anchor: no Apr 2026 row — the series jumps Mar 2026 -> May 2026',
        !months.includes('2026-04') && months.indexOf('2026-05') === months.indexOf('2026-03') + 1,
        JSON.stringify(months.filter((m) => m >= '2026-01' && m <= '2026-07')));
      // The anchor point plots the anchor-state balance, not the
      // raw recorded anchor — and the recorded anchor is preserved.
      H.check('Riverbend pre-anchor: anchorBalance is Term 2\'s opening ($465,439.31), balance stays the recorded anchor ($489,429.67)',
        amort.data.anchorBalance === 465439.31 && amort.data.balance === 489429.67,
        JSON.stringify({ anchorBalance: amort.data.anchorBalance, balance: amort.data.balance }));
      // Figures unchanged vs the anchor-only run: remaining balance
      // and payments agree with the detail API + the main engine run.
      H.check('Riverbend pre-anchor: figures unchanged — remaining balance, payment, payoff and total interest still come from the main run',
        Math.abs(amort.data.remainingBalance - detail.data.remainingBalance) < 0.01
          && Math.abs(amort.data.paymentUsed - term2Derived) < 0.5
          && amort.data.payoffMonth === engineProj.payoffMonth
          && Math.abs(amort.data.totalInterest - engineProj.totalInterest) < 0.01,
        JSON.stringify({ amortRem: amort.data.remainingBalance, detailRem: detail.data.remainingBalance, pay: amort.data.paymentUsed, payoff: amort.data.payoffMonth, interest: amort.data.totalInterest }));

      // A property with no pre-anchor terms is unchanged: no
      // replay, no rows before the anchor, and the anchor point is
      // the recorded anchor itself.
      let singleId = null;
      try {
        const s = await H.req('POST', '/api/properties', { address: '1 Single Term Way, Coquitlam, BC', purchase_date: '2026-04-27' });
        singleId = s.data && s.data.id;
        const st = await H.req('POST', `/api/properties/${singleId}/terms`, { lender: 'Royal Bank of Canada', start_date: '2026-04-27', term_months: 60, amortization_years: 25, opening_balance: 100000, payment_frequency: 'monthly', repayment_method: 'equal_payment' });
        const stId = st.data && st.data.id;
        await H.req('POST', `/api/properties/${singleId}/rates`, { term_id: stId, start_date: '2026-04-27', rate_type: 'fixed', annual_rate: 5, compounding: 'semi_annual', accrual: 'monthly' });
        await H.req('PUT', `/api/properties/${singleId}`, { mortgage_balance: 100000, mortgage_balance_date: '2026-04-27' });
        const single = await H.req('GET', `/api/properties/${singleId}/amortization`);
        H.check('Riverbend pre-anchor: a property with no pre-anchor terms is unchanged (no rows before the anchor; anchorBalance is the anchor)',
          single.data && Array.isArray(single.data.series) && single.data.series.length > 0
            && single.data.series.every((row) => row.month >= '2026-04')
            && single.data.anchorBalance === 100000 && single.data.balance === 100000,
          JSON.stringify({ first: single.data.series && single.data.series[0], anchorBalance: single.data && single.data.anchorBalance }));
      } finally {
        if (singleId != null) await H.req('DELETE', `/api/properties/${singleId}`);
      }

    } finally {
      if (riverbendId != null) await H.req('DELETE', `/api/properties/${riverbendId}`);
    }
  }
}

runModuleMain(import.meta.url, { name: 'ui-property', deps, depNames: ['core'], run });
