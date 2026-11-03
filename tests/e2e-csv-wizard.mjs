// csv-wizard: AI-mapped CSV import wizard (API + browser rounds) — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-csv-wizard.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only csv-wizard]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
import { run as runInvestments } from './e2e-investments.mjs';
export const deps = [runInvestments];
export async function run(H, S) {
  let r;

  // ---- AI-mapped CSV import: wizard round ----
  // The stubbed model proposes a DELIBERATELY WRONG mapping
  // (buy/sell swapped, units pointed at the price column). The
  // wizard must show the wrong translation live, let the user
  // correct it in operation terms, show the corrected sentences,
  // group the preview, and reuse the CORRECTED mapping for the
  // next file with the same columns.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    columns: { date: 'TradeDate', symbol: 'Ticker', name: 'Name', activity: 'Action', units: 'UnitPrice', price: 'UnitPrice', amount: 'Total', currency: 'Curr' },
    values: { Bought: 'sell', Sold: 'buy', Dividend: 'dividend', Fee: 'skip' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: [],
    reply: 'Mapped (wrong on purpose).',
  }));
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV map wizard', type: 'TFSA', institution: 'NorthTrade' });
  const wizAcctId = r.data.id;
  const wizTmp = path.join(os.tmpdir(), `ff-e2e-wiz-${Date.now()}.csv`);
  fs.writeFileSync(wizTmp, ['TradeDate,Ticker,Name,Action,Qty,UnitPrice,Total,Curr',
    '2026-03-02,XQQ,XQQ fund,Bought,20,100.30,2006,CAD',
    '2026-03-03,XQQ,XQQ fund,Sold,-10,110,1100,CAD',
    '2026-03-04,XQQ,XQQ fund,Dividend,,,8.21,CAD',
    '2026-03-05,XQQ,XQQ fund,Fee,,,9.99,CAD'].join('\n'));
  const forwardWiz = (rq) => new Promise((resolve, reject) => {
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
  const loginResWiz = await fetch(H.BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookieValueWiz = loginResWiz.headers.get('set-cookie').split(';')[0].split('=')[1];
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('investments wizard browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
  const browserWiz = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pageWiz = await browserWiz.newPage();
    const clientWiz = await pageWiz.target().createCDPSession();
    await clientWiz.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    clientWiz.on('Fetch.requestPaused', async (e) => {
      try {
        const u = new URL(e.request.url);
        if (u.hostname !== 'ff.local') { await clientWiz.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
        const headers = {};
        for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
        const resp = await forwardWiz({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
        const respHeaders = Object.entries(resp.headers)
          .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) }));
        await clientWiz.send('Fetch.fulfillRequest', {
          requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
          body: resp.body.toString('base64'),
        });
      } catch {
        try { await clientWiz.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
      }
    });
    await clientWiz.send('Network.setCookie', { name: 'ff_session', value: cookieValueWiz, domain: 'ff.local', path: '/', httpOnly: true });
    const waitWiz = (ms) => new Promise((res2) => setTimeout(res2, ms));
    await pageWiz.goto(`http://ff.local/#invest-account/${wizAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitWiz(800);
    await pageWiz.click('[data-invest-import-csv-map]');
    const wizInput = await pageWiz.$('[data-invest-import-map-file]');
    await wizInput.uploadFile(wizTmp);
    await pageWiz.waitForFunction(() => !!document.querySelector('[data-map-confirm]'), { timeout: 20000 });
    await pageWiz.waitForFunction(
      () => (document.querySelector('[data-wiz-preview]') || {}).textContent.includes('2026-03-02 · Sell · XQQ.TO · 100.3 units @ $100.30'),
      { timeout: 20000 });
    const wizWrong = await pageWiz.evaluate(() => document.querySelector('[data-wiz-preview]').textContent);
    H.check('csv-ai wizard: live preview shows the wrong AI mapping in plain words before any correction',
      wizWrong.includes('2026-03-02 · Sell · XQQ.TO · 100.3 units @ $100.30'), wizWrong);
    // Correct it in operation terms: Bought is a buy, Sold is a
    // sell, and the units live in Qty, not UnitPrice.
    await pageWiz.select('[data-wiz-value-idx="0"]', 'buy');
    await pageWiz.select('[data-wiz-value-idx="1"]', 'sell');
    await pageWiz.select('[data-wiz-col="units"]', 'Qty');
    await pageWiz.waitForFunction(
      () => (document.querySelector('[data-wiz-preview]') || {}).textContent.includes('2026-03-02 · Buy · XQQ.TO · 20 units @ $100.30'),
      { timeout: 20000 });
    const wizFixed = await pageWiz.evaluate(() => document.querySelector('[data-wiz-preview]').textContent);
    H.check('csv-ai wizard: correcting the wizard updates the live preview sentences',
      wizFixed.includes('2026-03-02 · Buy · XQQ.TO · 20 units @ $100.30')
        && wizFixed.includes('2026-03-03 · Sell · XQQ.TO · 10 units @ $110.00'),
      wizFixed);
    await pageWiz.click('[data-map-confirm]');
    await pageWiz.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 3, { timeout: 20000 });
    const wizGroups = await pageWiz.evaluate(() => {
      const host = document.querySelector('[data-invest-proposed]');
      return {
        groups: [...host.querySelectorAll('[data-ie-group]')].map((g) => g.querySelector('[data-ie-group-head]').textContent),
        rows: host.querySelectorAll('[data-ie-row]').length,
      };
    });
    H.check('csv-ai wizard: preview groups events by type with counts (fee row skipped)',
      wizGroups.rows === 3 && wizGroups.groups.length === 3
        && wizGroups.groups.some((t) => t.includes('Buy') && t.includes('1 rows'))
        && wizGroups.groups.some((t) => t.includes('Sell') && t.includes('1 rows')),
      JSON.stringify(wizGroups));
    // A collapsed group expands, and its header checkbox toggles
    // the whole group without touching the others. Centre the
    // head in the viewport first: after the map editor collapses
    // the page clamps to max scroll, which can leave the head's
    // centre under the 52px sticky topbar — a click there lands
    // on the topbar, not the head, exactly as a user would scroll
    // first before clicking a half-hidden row.
    await pageWiz.evaluate(() => document.querySelector('[data-ie-group-head="Buy"]').scrollIntoView({ block: 'center' }));
    await pageWiz.click('[data-ie-group-head="Buy"]');
    await pageWiz.click('[data-ie-group-check="Buy"]');
    const wizToggle = await pageWiz.evaluate(() => ({
      bodyDisplay: document.querySelector('[data-ie-group-body="Buy"]').style.display,
      buyChecked: document.querySelector('[data-ie-group="Buy"] [data-ie-check]').checked,
      sellChecked: document.querySelector('[data-ie-group="Sell"] [data-ie-check]').checked,
    }));
    H.check('csv-ai wizard: group expands and its header checkbox toggles only its group',
      wizToggle.bodyDisplay === '' && wizToggle.buyChecked === false && wizToggle.sellChecked === true,
      JSON.stringify(wizToggle));
    await pageWiz.click('[data-ie-group-check="Buy"]');
    await pageWiz.click('[data-invest-apply]');
    await pageWiz.waitForFunction(() => document.querySelector('#investHoldingsWrap').textContent.includes('XQQ.TO'), { timeout: 20000 });
    r = await H.req('GET', `/api/investments/accounts/${wizAcctId}`);
    const wizHolding = r.data.holdings.find((row) => row.holding.symbol === 'XQQ.TO');
    H.check('csv-ai wizard: applying the corrected preview stores 10 XQQ units with source csv-ai',
      wizHolding && wizHolding.summary.units === 10 && wizHolding.holding.source === 'csv-ai'
        && wizHolding.events.some((e) => e.type === 'buy' && e.units === 20 && e.price === 100.3)
        && wizHolding.events.some((e) => e.type === 'sell' && e.units === 10 && e.price === 110)
        && wizHolding.events.some((e) => e.type === 'dividend' && e.amount === 8.21),
      JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units, row.events.map((e) => [e.type, e.units, e.price, e.amount])])));
    // Re-uploading the same file reuses the CORRECTED mapping,
    // not the stub's wrong one.
    await pageWiz.click('[data-invest-import-csv-map]');
    const wizInput2 = await pageWiz.$('[data-invest-import-map-file]');
    await wizInput2.uploadFile(wizTmp);
    await pageWiz.waitForFunction(() => !!document.querySelector('[data-map-confirm]'), { timeout: 20000 });
    await pageWiz.waitForFunction(
      () => (document.querySelector('[data-wiz-preview]') || {}).textContent.includes('2026-03-02 · Buy · XQQ.TO · 20 units @ $100.30'),
      { timeout: 20000 });
    const wizReused = await pageWiz.evaluate(() => ({
      bought: document.querySelector('[data-wiz-value-idx="0"]').value,
      units: document.querySelector('[data-wiz-col="units"]').value,
    }));
    H.check('csv-ai wizard: a second file with the same columns reuses the corrected mapping',
      wizReused.bought === 'buy' && wizReused.units === 'Qty', JSON.stringify(wizReused));
  } catch (err) {
    H.check('investments AI-mapped CSV wizard browser flow runs to completion', false, String((err && err.message) || err));
  } finally {
    await browserWiz.close();
  }
  }
  // ---- AI-mapped CSV import: pair-mode wizard browser round ----
  // The stub proposes the correct pair mapping, so the editor must
  // render the second activity column and the pair rows
  // ("Trade / BUY", "Dividend / -", …) pre-filled, and confirming
  // must carry the pairs through preview to stored events.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    columns: { date: 'effective_date', symbol: 'symbol', activity: 'activity_type', activity2: 'activity_sub_type', units: 'quantity', price: 'unit_price', amount: 'net_cash_amount', currency: 'currency', splitAdded: 'quantity' },
    values: { 'Trade / BUY': 'buy', 'Trade / SELL': 'sell', 'Dividend / -': 'dividend', 'CorporateAction / SUBDIVISION': 'split', 'MoneyMovement / EFT': 'skip', 'Interest / -': 'skip', 'Tax / NRT': 'skip', 'BonusPayment / REFER': 'skip' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: [],
    reply: 'Mapped as type / sub-type pairs.',
  }));
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV pair wizard', type: 'TFSA', institution: 'NorthTrade' });
  const pairWizAcctId = r.data.id;
  const pairWizTmp = path.join(os.tmpdir(), `ff-e2e-pairwiz-${Date.now()}.csv`);
  fs.writeFileSync(pairWizTmp, ['effective_date,symbol,quantity,unit_price,net_cash_amount,currency,activity_type,activity_sub_type',
    '2021-01-10,,,10,10,CAD,BonusPayment,REFER',
    '2021-01-12,,,5000,5000,CAD,MoneyMovement,EFT',
    '2021-01-15,XQQ,20,100.30,-2006,CAD,Trade,BUY',
    '2021-02-01,XQQ,999,,15.80,CAD,Dividend,-',
    '2021-02-02,,,0.50,0.50,CAD,Interest,-',
    '2021-02-04,XQQ,5,110,550,CAD,Trade,SELL',
    '2021-03-01,XQQ,30,,,CAD,CorporateAction,SUBDIVISION'].join('\n'));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('investments pair wizard browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
  const browserPair = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pagePair = await browserPair.newPage();
    const clientPair = await pagePair.target().createCDPSession();
    await clientPair.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    clientPair.on('Fetch.requestPaused', async (e) => {
      try {
        const u = new URL(e.request.url);
        if (u.hostname !== 'ff.local') { await clientPair.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
        const headers = {};
        for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
        const resp = await forwardWiz({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
        const respHeaders = Object.entries(resp.headers)
          .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) }));
        await clientPair.send('Fetch.fulfillRequest', {
          requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
          body: resp.body.toString('base64'),
        });
      } catch {
        try { await clientPair.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
      }
    });
    await clientPair.send('Network.setCookie', { name: 'ff_session', value: cookieValueWiz, domain: 'ff.local', path: '/', httpOnly: true });
    const waitPair = (ms) => new Promise((res2) => setTimeout(res2, ms));
    await pagePair.goto(`http://ff.local/#invest-account/${pairWizAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitPair(800);
    await pagePair.click('[data-invest-import-csv-map]');
    const pairInput = await pagePair.$('[data-invest-import-map-file]');
    await pairInput.uploadFile(pairWizTmp);
    await pagePair.waitForFunction(() => !!document.querySelector('[data-map-confirm]'), { timeout: 20000 });
    await pagePair.waitForFunction(
      () => (document.querySelector('[data-wiz-values]') || {}).textContent.includes('Trade / BUY')
        && (document.querySelector('[data-wiz-values]') || {}).textContent.includes('Dividend / -'),
      { timeout: 20000 });
    const pairRows = await pagePair.evaluate(() => ({
      secondCol: document.querySelector('[data-wiz-col="activity2"]').value,
      valuesText: document.querySelector('[data-wiz-values]').textContent,
      tradeBuy: document.querySelector('[data-wiz-value-idx="2"]').value,
      dividend: document.querySelector('[data-wiz-value-idx="3"]').value,
    }));
    H.check('csv-ai pair wizard: editor shows the second activity column and the pair rows pre-filled from the stub',
      pairRows.secondCol === 'activity_sub_type' && pairRows.tradeBuy === 'buy' && pairRows.dividend === 'dividend',
      JSON.stringify(pairRows));
    await pagePair.waitForFunction(
      () => (document.querySelector('[data-wiz-preview]') || {}).textContent.includes('2021-02-01 · Dividend · XQQ.TO · $15.80'),
      { timeout: 20000 });
    await pagePair.click('[data-map-confirm]');
    await pagePair.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 4, { timeout: 20000 });
    await pagePair.click('[data-invest-apply]');
    await pagePair.waitForFunction(() => document.querySelector('#investHoldingsWrap').textContent.includes('XQQ.TO'), { timeout: 20000 });
    r = await H.req('GET', `/api/investments/accounts/${pairWizAcctId}`);
    const pairWizHolding = r.data.holdings.find((row) => row.holding.symbol === 'XQQ.TO');
    H.check('csv-ai pair wizard: applying stores the dividend and the split-restated 45 units with source csv-ai',
      pairWizHolding && pairWizHolding.summary.units === 45 && pairWizHolding.holding.source === 'csv-ai'
        && pairWizHolding.events.some((e) => e.type === 'dividend' && e.amount === 15.8)
        && pairWizHolding.events.some((e) => e.type === 'split' && e.split_new === 45 && e.split_old === 15),
      JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units, row.holding.source, row.events.map((e) => [e.type, e.units, e.price, e.amount, e.split_new, e.split_old])])));
  } catch (err) {
    H.check('investments AI-mapped CSV pair wizard browser flow runs to completion', false, String((err && err.message) || err));
  } finally {
    await browserPair.close();
  }
  }

  // ---- Wealthsimple CSV import: API round ----
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV import', type: 'TFSA', institution: 'Wealthsimple' });
  const csvAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${csvAcctId}/import-csv`, { csv: S.wsFixture });
  const csvParse = r.data;
  H.check('csv import: parse maps buys, a negative sell, a dividend and a 3:1 split, skips the cash row, fails the oversell',
    r.status === 200 && csvParse.holdings.length === 2 && csvParse.events.length === 6
      && csvParse.skipped.total === 1 && csvParse.failed.length === 1 && csvParse.duplicates === 0
      && csvParse.events.some((e) => e.type === 'split' && e.splitNew === 180 && e.splitOld === 60)
      && csvParse.holdings.every((h) => h.symbol.endsWith('.TO')),
    JSON.stringify(csvParse));
  r = await H.req('POST', `/api/investments/accounts/${csvAcctId}/import-csv/apply`, { holdings: csvParse.holdings, events: csvParse.events });
  H.check('csv import: apply writes 2 holdings and 6 events',
    r.status === 201 && r.data.createdHoldings === 2 && r.data.createdEvents === 6, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${csvAcctId}`);
  const csvUnits = Object.fromEntries(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units]));
  const csvSources = new Set(r.data.holdings.flatMap((row) => [row.holding.source, ...row.events.map((e) => e.source)]));
  H.check('csv import: stored units restate through the split (60 x 3 + 10 = 190) and everything carries source csv',
    csvUnits['XQQ.TO'] === 190 && csvUnits['VFV.TO'] === 5 && csvSources.size === 1 && csvSources.has('csv'),
    JSON.stringify({ units: csvUnits, sources: [...csvSources] }));
  r = await H.req('POST', `/api/investments/accounts/${csvAcctId}/import-csv`, { csv: S.wsFixture });
  H.check('csv import: re-parsing after apply is all duplicates (the failed oversell still fails)',
    r.data.events.length === 0 && r.data.duplicates === 6 && r.data.failed.length === 1,
    JSON.stringify({ events: r.data.events.length, dup: r.data.duplicates, failed: r.data.failed.length }));
  r = await H.req('POST', `/api/investments/accounts/${csvAcctId}/import-csv`, { csv: 'a,b,c\n1,2,3' });
  H.check('csv import: a non-Wealthsimple file is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/999999/import-csv`, { csv: S.wsFixture });
  H.check('csv import: an unknown account is a 404', r.status === 404, JSON.stringify(r.data));

  // ---- AI-mapped CSV import: API round ----
  // Same broker shape as the browser round minus the Note column,
  // so its fingerprint is its own. The stubbed model proposes the
  // mapping; the round confirms it, applies it, then proves the
  // fingerprint reuse and the duplicate-on-re-preview behaviour.
  const mapFixture = ['Date,Ticker,Description,Txn,Shares,Price,Amount,Curr',
    '2026-02-02,ZWC,BMO fund,Bought,50,20,-1000,CAD',
    '2026-02-03,ZWC,BMO fund,Sold,-10,22,220,CAD',
    '2026-02-04,ZWC,BMO fund,Dividend,,,5.5,CAD',
    '2026-02-05,ZWC,BMO fund,Fee,,,9.99,CAD',
    '2026-02-06,MSFT,Microsoft,Bought,5,300,-1500,USD'].join('\n');
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    columns: { date: 'Date', symbol: 'Ticker', name: 'Description', activity: 'Txn', units: 'Shares', price: 'Price', amount: 'Amount', currency: 'Curr' },
    values: { Bought: 'buy', Sold: 'sell', Dividend: 'dividend', Fee: 'skip' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: [],
    reply: 'Mapped.',
  }));
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV map import', type: 'TFSA', institution: 'NorthTrade' });
  const mapAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${mapAcctId}/import-csv-map/analyze`, { csv: mapFixture });
  H.check('csv-ai map: analyze proposes the stub mapping (not reused)',
    r.status === 200 && r.data.reused === false && r.data.mapping.columns.date === 'Date' && r.data.mapping.values.Bought === 'buy',
    JSON.stringify(r.data.mapping));
  const mapMapping = r.data.mapping;
  r = await H.req('POST', `/api/investments/accounts/${mapAcctId}/import-csv-map/preview`, { csv: mapFixture, mapping: mapMapping });
  const mapPreview = r.data;
  H.check('csv-ai map: preview maps buys, a negative sell and a dividend, skips the fee row',
    r.status === 200 && mapPreview.holdings.length === 2 && mapPreview.events.length === 4
      && mapPreview.skipped.total === 1 && mapPreview.failed.length === 0 && mapPreview.duplicates === 0
      && mapPreview.holdings.some((h) => h.symbol === 'ZWC.TO') && mapPreview.holdings.some((h) => h.symbol === 'MSFT'),
    JSON.stringify(mapPreview));
  r = await H.req('POST', `/api/investments/accounts/${mapAcctId}/import-csv/apply`, { source: 'csv-ai', holdings: mapPreview.holdings, events: mapPreview.events });
  H.check('csv-ai map: apply writes 2 holdings and 4 events',
    r.status === 201 && r.data.createdHoldings === 2 && r.data.createdEvents === 4, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${mapAcctId}`);
  const mapUnits = Object.fromEntries(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units]));
  const mapSources = new Set(r.data.holdings.flatMap((row) => [row.holding.source, ...row.events.map((e) => e.source)]));
  H.check('csv-ai map: stored units (50 - 10 = 40; MSFT 5) and everything carries source csv-ai',
    mapUnits['ZWC.TO'] === 40 && mapUnits.MSFT === 5 && mapSources.size === 1 && mapSources.has('csv-ai'),
    JSON.stringify({ units: mapUnits, sources: [...mapSources] }));
  r = await H.req('POST', `/api/investments/accounts/${mapAcctId}/import-csv-map/analyze`, { csv: mapFixture });
  H.check('csv-ai map: a second file with the same columns reuses the saved mapping',
    r.status === 200 && r.data.reused === true, JSON.stringify({ reused: r.data.reused }));
  r = await H.req('POST', `/api/investments/accounts/${mapAcctId}/import-csv-map/preview`, { csv: mapFixture, mapping: mapMapping });
  H.check('csv-ai map: re-preview after apply is all duplicates',
    r.data.events.length === 0 && r.data.duplicates === 4,
    JSON.stringify({ events: r.data.events.length, dup: r.data.duplicates }));
  r = await H.req('POST', `/api/investments/accounts/999999/import-csv-map/analyze`, { csv: mapFixture });
  H.check('csv-ai map: an unknown account is a 404', r.status === 404, JSON.stringify(r.data));

  // ---- AI-mapped CSV import: two-column (pair) round ----
  // The shape that lost dividends under a single activity column:
  // type + sub-type jointly decide the operation, '-' means a
  // dividend under Dividend but cash under Interest, and the file
  // opens with cash rows so the old first-five preview never
  // showed a dividend row.
  const pairFixture = ['effective_date,symbol,quantity,unit_price,net_cash_amount,currency,activity_type,activity_sub_type,description',
    '2021-01-10,,,10,10,CAD,BonusPayment,REFER,',
    '2021-01-12,,,5000,5000,CAD,MoneyMovement,EFT,',
    '2021-01-13,,,3.30,3.30,CAD,Tax,NRT,',
    '2021-01-14,,,0.50,0.50,CAD,Interest,-,',
    '2021-01-15,XQQ,20,100.30,-2006,CAD,Trade,BUY,',
    '2021-02-01,XQQ,999,,15.80,CAD,Dividend,-,',
    '2021-02-04,XQQ,5,110,550,CAD,Trade,SELL,',
    '2021-03-01,XQQ,30,,,CAD,CorporateAction,SUBDIVISION,'].join('\n');
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    columns: { date: 'effective_date', symbol: 'symbol', activity: 'activity_type', activity2: 'activity_sub_type', units: 'quantity', price: 'unit_price', amount: 'net_cash_amount', currency: 'currency', splitAdded: 'quantity' },
    values: { 'Trade / BUY': 'buy', 'Trade / SELL': 'sell', 'Dividend / -': 'dividend', 'CorporateAction / SUBDIVISION': 'split', 'MoneyMovement / EFT': 'skip', 'Interest / -': 'skip', 'Tax / NRT': 'skip', 'BonusPayment / REFER': 'skip' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: [],
    reply: 'Mapped as type / sub-type pairs.',
  }));
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV pair map', type: 'TFSA', institution: 'NorthTrade' });
  const pairAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${pairAcctId}/import-csv-map/analyze`, { csv: pairFixture });
  const pairMapping = r.data.mapping;
  H.check('csv-ai pair: analyze proposes the type / sub-type pair mapping (not reused)',
    r.status === 200 && r.data.reused === false && pairMapping.columns.activity2 === 'activity_sub_type'
      && pairMapping.values['Dividend / -'] === 'dividend',
    JSON.stringify(pairMapping));
  r = await H.req('POST', `/api/investments/accounts/${pairAcctId}/import-csv-map/activity-values`, { csv: pairFixture, mapping: pairMapping });
  H.check('csv-ai pair: activity-values lists the eight pairs first-seen with labels',
    r.status === 200 && r.data.values.length === 8 && r.data.values[0] === 'BonusPayment / REFER'
      && r.data.values.includes('Dividend / -') && r.data.values.includes('Interest / -') && r.data.count === 8,
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/${pairAcctId}/import-csv-map/translate`, { csv: pairFixture, mapping: pairMapping });
  const pairSentences = (r.data.sentences || []).join('\n');
  H.check('csv-ai pair: translate covers the late-file dividend and split, not just the opening cash rows',
    r.status === 200 && pairSentences.includes('2021-02-01 · Dividend · XQQ.TO · $15.80')
      && pairSentences.includes('2021-03-01 · Split · XQQ.TO · +30 units (ratio derived on apply)')
      && pairSentences.includes('2021-01-10 · Skipped: BonusPayment / REFER'),
    pairSentences);
  r = await H.req('POST', `/api/investments/accounts/${pairAcctId}/import-csv-map/preview`, { csv: pairFixture, mapping: pairMapping });
  const pairPreview = r.data;
  H.check('csv-ai pair: preview keeps the dividend (amount column, not quantity), derives the 45:15 split, skips four cash rows',
    r.status === 200 && pairPreview.holdings.length === 1 && pairPreview.events.length === 4
      && pairPreview.skipped.total === 4 && pairPreview.failed.length === 0
      && pairPreview.events.some((e) => e.type === 'dividend' && e.amount === 15.8)
      && pairPreview.events.some((e) => e.type === 'split' && e.splitNew === 45 && e.splitOld === 15),
    JSON.stringify(pairPreview));
  const pairMissing = { ...pairMapping, values: { ...pairMapping.values } };
  delete pairMissing.values['Dividend / -'];
  r = await H.req('POST', `/api/investments/accounts/${pairAcctId}/import-csv-map/preview`, { csv: pairFixture, mapping: pairMissing });
  H.check('csv-ai pair: a pair without a target fails loudly naming the pair',
    r.status === 200 && r.data.failed.some((f) => f.reason.includes('no mapping for activity value "Dividend / -"'))
      && !r.data.events.some((e) => e.type === 'dividend'),
    JSON.stringify(r.data.failed));
  r = await H.req('POST', `/api/investments/accounts/${pairAcctId}/import-csv/apply`, { source: 'csv-ai', holdings: pairPreview.holdings, events: pairPreview.events });
  H.check('csv-ai pair: apply writes 1 holding and 4 events', r.status === 201 && r.data.createdHoldings === 1 && r.data.createdEvents === 4, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${pairAcctId}`);
  const pairHolding = r.data.holdings[0];
  H.check('csv-ai pair: stored units restate through the split ((20 - 5) x 3 = 45) with source csv-ai',
    pairHolding && pairHolding.summary.units === 45 && pairHolding.holding.source === 'csv-ai'
      && pairHolding.events.some((e) => e.type === 'dividend' && e.amount === 15.8),
    JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units, row.events.map((e) => [e.type, e.units, e.price, e.amount])])));

  // ---- AI-mapped CSV import: follow-up round ----
  // The wizard's AI proposes once and then goes silent in the
  // old flow — the user could only fix a wrong preview by hand
  // in the dropdowns. The follow-up loop lets them tell the AI
  // what is wrong in one sentence and get a whole revised
  // mapping back, for as many rounds as it takes, before Apply.
  const followFixture = ['Date,Sym,Qty,Price,Amount,Curr,Type,Sub',
    '2026-01-05,,,100,100,CAD,Transfer,IN',
    '2026-01-06,AAA,10,50,-500,CAD,Trade,BUY',
    '2026-01-07,AAA,,,12.50,CAD,Dividend,-',
    '2026-01-08,AAA,5,60,300,CAD,Trade,SELL'].join('\n');
  const followV1 = {
    columns: { date: 'Date', symbol: 'Sym', activity: 'Type', activity2: 'Sub', units: 'Price', price: 'Price', amount: 'Amount', currency: 'Curr' },
    values: { 'Trade / BUY': 'buy', 'Trade / SELL': 'sell', 'Dividend / -': 'skip', 'Transfer / IN': 'skip' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: [],
    reply: 'Mapped (wrong on purpose: dividends skipped, units pointed at Price).',
  };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(followV1));
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV follow-up', type: 'TFSA', institution: 'NorthTrade' });
  const followAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/analyze`, { csv: followFixture });
  const followMappingV1 = r.data.mapping;
  H.check('csv-ai follow-up: analyze proposes the deliberately wrong mapping (not reused)',
    r.status === 200 && r.data.reused === false && followMappingV1.columns.units === 'Price'
      && followMappingV1.values['Dividend / -'] === 'skip',
    JSON.stringify(followMappingV1));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/translate`, { csv: followFixture, mapping: followMappingV1 });
  const followWrong = (r.data.sentences || []).join('\n');
  H.check('csv-ai follow-up: translate shows the wrong preview (50 units, dividend skipped) before any follow-up',
    r.status === 200 && followWrong.includes('2026-01-06 · Buy · AAA.TO · 50 units @ $50.00')
      && followWrong.includes('Skipped: Dividend / -'),
    followWrong);
  // Round 1: dividends are missing. The stub revises ONLY that
  // target; everything else must come back unchanged.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    ...followV1,
    values: { ...followV1.values, 'Dividend / -': 'dividend' },
    reply: 'Flipped Dividend / - to dividend; everything else unchanged.',
  }));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/followup`, {
    csv: followFixture, mapping: followMappingV1,
    message: 'dividends are missing — Dividend rows should be dividends, not skipped',
  });
  const followMappingV2 = r.data.mapping;
  H.check('csv-ai follow-up: round 1 flips the dividend target and keeps the rest',
    r.status === 200 && followMappingV2.values['Dividend / -'] === 'dividend'
      && followMappingV2.values['Trade / BUY'] === 'buy' && followMappingV2.columns.units === 'Price'
      && (r.data.reply || '').includes('dividend'),
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/translate`, { csv: followFixture, mapping: followMappingV2 });
  const followRound1 = (r.data.sentences || []).join('\n');
  H.check('csv-ai follow-up: translate after round 1 shows the dividend at $12.50',
    r.status === 200 && followRound1.includes('2026-01-07 · Dividend · AAA.TO · $12.50'),
    followRound1);
  // Round 2: units live in Qty, not Price. The round-1 fix must
  // survive, and the history is sent along as context.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    ...followV1,
    columns: { ...followV1.columns, units: 'Qty' },
    values: { ...followV1.values, 'Dividend / -': 'dividend' },
    reply: 'Moved the units column to Qty; dividend fix kept.',
  }));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/followup`, {
    csv: followFixture, mapping: followMappingV2,
    message: 'units are in Qty, not Price',
    history: [{ message: 'dividends are missing — Dividend rows should be dividends, not skipped', reply: 'Flipped Dividend / - to dividend; everything else unchanged.' }],
  });
  const followMappingV3 = r.data.mapping;
  H.check('csv-ai follow-up: round 2 moves the units column and preserves the round-1 dividend fix',
    r.status === 200 && followMappingV3.columns.units === 'Qty'
      && followMappingV3.values['Dividend / -'] === 'dividend',
    JSON.stringify(followMappingV3));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/translate`, { csv: followFixture, mapping: followMappingV3 });
  const followRound2 = (r.data.sentences || []).join('\n');
  H.check('csv-ai follow-up: translate after round 2 shows 10 units at $50.00',
    r.status === 200 && followRound2.includes('2026-01-06 · Buy · AAA.TO · 10 units @ $50.00'),
    followRound2);
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/preview`, { csv: followFixture, mapping: followMappingV3 });
  const followPreview = r.data;
  H.check('csv-ai follow-up: preview with the twice-revised mapping has buy, dividend and sell, one cash row skipped',
    r.status === 200 && followPreview.holdings.length === 1 && followPreview.events.length === 3
      && followPreview.skipped.total === 1 && followPreview.failed.length === 0
      && followPreview.events.some((e) => e.type === 'dividend' && e.amount === 12.5)
      && followPreview.events.some((e) => e.type === 'buy' && e.units === 10 && e.price === 50),
    JSON.stringify(followPreview));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv/apply`, { source: 'csv-ai', holdings: followPreview.holdings, events: followPreview.events });
  H.check('csv-ai follow-up: apply writes 1 holding and 3 events', r.status === 201 && r.data.createdHoldings === 1 && r.data.createdEvents === 3, JSON.stringify(r.data));
  r = await H.req('GET', `/api/investments/accounts/${followAcctId}`);
  const followHolding = r.data.holdings[0];
  H.check('csv-ai follow-up: stored AAA.TO has 5 units, the dividend and source csv-ai',
    followHolding && followHolding.summary.units === 5 && followHolding.holding.source === 'csv-ai'
      && followHolding.events.some((e) => e.type === 'dividend' && e.amount === 12.5),
    JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units, row.events.map((e) => [e.type, e.units, e.price, e.amount])])));
  r = await H.req('POST', `/api/investments/accounts/${followAcctId}/import-csv-map/followup`, { csv: followFixture, mapping: followMappingV3 });
  H.check('csv-ai follow-up: a missing message is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/accounts/999999/import-csv-map/followup', { csv: followFixture, mapping: followMappingV3, message: 'fix it' });
  H.check('csv-ai follow-up: an unknown account is a 404', r.status === 404, JSON.stringify(r.data));

  // ---- AI-mapped CSV import: follow-up wizard browser round ----
  // Same wrong-then-fixed story through the UI: the wizard shows
  // the wrong preview, two follow-up sentences revise it in
  // place, and only then does the user confirm and apply.
  // NOTE: the browser fixture renames every column from the API
  // fixture above — mappings are remembered by column
  // fingerprint, and the API round's preview already saved the
  // revised mapping for those columns, so reusing them here
  // would return the fixed mapping (reused) instead of the
  // deliberately wrong stub.
  const followWizFixture = ['Day,Tick,Units,UnitPrice,Total,Cur,Kind,Detail',
    '2026-01-05,,,100,100,CAD,Transfer,IN',
    '2026-01-06,AAA,10,50,-500,CAD,Trade,BUY',
    '2026-01-07,AAA,,,12.50,CAD,Dividend,-',
    '2026-01-08,AAA,5,60,300,CAD,Trade,SELL'].join('\n');
  const followWizV1 = {
    columns: { date: 'Day', symbol: 'Tick', activity: 'Kind', activity2: 'Detail', units: 'UnitPrice', price: 'UnitPrice', amount: 'Total', currency: 'Cur' },
    values: { 'Trade / BUY': 'buy', 'Trade / SELL': 'sell', 'Dividend / -': 'skip', 'Transfer / IN': 'skip' },
    defaultCurrency: null,
    symbolSuffix: { suffix: '.TO', whenCurrency: 'CAD' },
    questions: [],
    reply: 'Mapped (wrong on purpose: dividends skipped, units pointed at UnitPrice).',
  };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(followWizV1));
  r = await H.req('POST', '/api/investments/accounts', { name: 'CSV follow-up wizard', type: 'TFSA', institution: 'NorthTrade' });
  const followWizAcctId = r.data.id;
  const followTmp = path.join(os.tmpdir(), `ff-e2e-follow-${Date.now()}.csv`);
  fs.writeFileSync(followTmp, followWizFixture);
  const forwardFollow = (rq) => new Promise((resolve, reject) => {
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
  const loginResFollow = await fetch(H.BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookieValueFollow = loginResFollow.headers.get('set-cookie').split(';')[0].split('=')[1];
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('investments follow-up wizard browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
  const browserFollow = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pageFollow = await browserFollow.newPage();
    const clientFollow = await pageFollow.target().createCDPSession();
    await clientFollow.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    clientFollow.on('Fetch.requestPaused', async (e) => {
      try {
        const u = new URL(e.request.url);
        if (u.hostname !== 'ff.local') { await clientFollow.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
        const headers = {};
        for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
        const resp = await forwardFollow({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
        const respHeaders = Object.entries(resp.headers)
          .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) }));
        await clientFollow.send('Fetch.fulfillRequest', {
          requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
          body: resp.body.toString('base64'),
        });
      } catch {
        try { await clientFollow.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
      }
    });
    await clientFollow.send('Network.setCookie', { name: 'ff_session', value: cookieValueFollow, domain: 'ff.local', path: '/', httpOnly: true });
    const waitFollow = (ms) => new Promise((res2) => setTimeout(res2, ms));
    await pageFollow.goto(`http://ff.local/#invest-account/${followWizAcctId}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitFollow(800);
    await pageFollow.click('[data-invest-import-csv-map]');
    const followInput = await pageFollow.$('[data-invest-import-map-file]');
    await followInput.uploadFile(followTmp);
    await pageFollow.waitForFunction(() => !!document.querySelector('[data-map-confirm]'), { timeout: 20000 });
    await pageFollow.waitForFunction(() => document.querySelectorAll('[data-wiz-value-idx]').length === 4, { timeout: 20000 });
    await pageFollow.waitForFunction(
      () => (document.querySelector('[data-wiz-preview]') || {}).textContent.includes('Skipped: Dividend / -'),
      { timeout: 20000 });
    // Two follow-up rounds in place. A click can land while the
    // pair list is still reloading after a re-render, which the
    // editor reports as 'still loading' — retry in that case.
    const sendFollowup = async (text, expectSentence) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await pageFollow.evaluate((t) => { const el = document.querySelector('[data-wiz-followup]'); if (el) el.value = t; }, text);
        await pageFollow.click('[data-map-followup]');
        try {
          await pageFollow.waitForFunction(
            (s) => (document.querySelector('[data-wiz-preview]') || {}).textContent.includes(s),
            { timeout: 5000 }, expectSentence);
          return;
        } catch {
          const m = await pageFollow.evaluate(() => (document.querySelector('[data-invest-chat-msg]') || {}).textContent || '');
          if (!m.includes('still loading')) throw new Error(`follow-up did not update the preview; last message: ${m}`);
        }
      }
      throw new Error('follow-up still blocked by pair loading after retries');
    };
    fs.writeFileSync(H.aiStubFile, JSON.stringify({
      ...followWizV1,
      values: { ...followWizV1.values, 'Dividend / -': 'dividend' },
      reply: 'Flipped Dividend / - to dividend; everything else unchanged.',
    }));
    await sendFollowup('dividends are missing — Dividend rows should be dividends, not skipped',
      '2026-01-07 · Dividend · AAA.TO · $12.50');
    const followFixed1 = await pageFollow.evaluate(() => document.querySelector('[data-wiz-preview]').textContent);
    H.check('csv-ai follow-up wizard: round 1 revises the preview to show the dividend',
      followFixed1.includes('2026-01-07 · Dividend · AAA.TO · $12.50'), followFixed1);
    fs.writeFileSync(H.aiStubFile, JSON.stringify({
      ...followWizV1,
      columns: { ...followWizV1.columns, units: 'Units' },
      values: { ...followWizV1.values, 'Dividend / -': 'dividend' },
      reply: 'Moved the units column to Units; dividend fix kept.',
    }));
    await sendFollowup('units are in Units, not UnitPrice', '2026-01-06 · Buy · AAA.TO · 10 units @ $50.00');
    const followFixed2 = await pageFollow.evaluate(() => document.querySelector('[data-wiz-preview]').textContent);
    H.check('csv-ai follow-up wizard: round 2 revises the preview to 10 units and keeps the dividend fix',
      followFixed2.includes('2026-01-06 · Buy · AAA.TO · 10 units @ $50.00')
        && followFixed2.includes('2026-01-07 · Dividend · AAA.TO · $12.50'),
      followFixed2);
    await pageFollow.click('[data-map-confirm]');
    await pageFollow.waitForFunction(() => document.querySelectorAll('[data-invest-proposed] [data-ie-row]').length === 3, { timeout: 20000 });
    await pageFollow.click('[data-invest-apply]');
    await pageFollow.waitForFunction(() => document.querySelector('#investHoldingsWrap').textContent.includes('AAA.TO'), { timeout: 20000 });
    r = await H.req('GET', `/api/investments/accounts/${followWizAcctId}`);
    const followWizHolding = r.data.holdings.find((row) => row.holding.symbol === 'AAA.TO');
    H.check('csv-ai follow-up wizard: applying stores 5 AAA units with the dividend and source csv-ai',
      followWizHolding && followWizHolding.summary.units === 5 && followWizHolding.holding.source === 'csv-ai'
        && followWizHolding.events.some((e) => e.type === 'dividend' && e.amount === 12.5),
      JSON.stringify(r.data.holdings.map((row) => [row.holding.symbol, row.summary.units, row.events.map((e) => [e.type, e.units, e.price, e.amount])])));
  } catch (err) {
    H.check('investments AI-mapped CSV follow-up wizard browser flow runs to completion', false, String((err && err.message) || err));
  } finally {
    await browserFollow.close();
  }
  }

  // ---- Earnings: salary + rental (API round) ----
  S.sumBefore = await H.req('GET', '/api/summary');
}

runModuleMain(import.meta.url, { name: 'csv-wizard', deps, depNames: ['investments'], run });
