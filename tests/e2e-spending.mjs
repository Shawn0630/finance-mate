// spending: Spending: cards, QFX import, categories, tables, charts — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-spending.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only spending]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // ---------------------------------------------------------------
  // Spending prototype: credit cards, QFX import, AI categories,
  // card-detail AI fill. Synthetic QFX only — no real bank file.
  r = await H.req('POST', '/api/spending/cards', { name: 'Visa', issuer: 'RBC', last4: '12345' });
  H.check('spending: a full card number is rejected (last 4 only)', r.status === 400 && /last 4/.test(r.data.error || ''));
  r = await H.req('POST', '/api/spending/cards', { name: 'Visa', issuer: 'RBC', last4: '1234' });
  H.check('spending: card created with last 4', r.status === 201 && r.data.last4 === '1234' && r.data.name === 'Visa', JSON.stringify(r.data));
  const spendCardId = r.data.id;
  const spendQfx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CCACCTFROM><ACCTID>1111222233334444</ACCTID></CCACCTFROM><BANKTRANLIST>`
    + `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-42.50</TRNAMT><FITID>SP1</FITID><NAME>WHOLE FOODS</NAME></STMTTRN>`
    + `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261006</DTPOSTED><TRNAMT>-15.00</TRNAMT><FITID>SP2</FITID><NAME>SHELL</NAME></STMTTRN>`
    + `<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261007</DTPOSTED><TRNAMT>100.00</TRNAMT><FITID>SP3</FITID><NAME>PAYMENT - THANK YOU</NAME></STMTTRN>`
    + `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261008</DTPOSTED><TRNAMT>-9.00</TRNAMT><FITID>SP1</FITID><NAME>DUP</NAME></STMTTRN>`
    + `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261009</DTPOSTED><TRNAMT>-9.00</TRNAMT><NAME>NO FITID</NAME></STMTTRN>`
    + `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/import-qfx/parse`, { qfxText: spendQfx });
  H.check('spending: QFX parse previews 3 rows + 2 dropped with reasons, account masked',
    r.status === 200 && r.data.rows.length === 3 && r.data.dropped.length === 2 && r.data.accountId === '••••4444',
    JSON.stringify(r.data));
  const spendParsedRows = r.data.rows;
  r = await H.req('GET', '/api/spending');
  H.check('spending: parse wrote nothing', r.status === 200 && r.data.transactions.length === 0);
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/import-qfx/apply`, { rows: spendParsedRows });
  H.check('spending: QFX apply inserts all three rows',
    r.status === 201 && r.data.inserted === 3 && r.data.skipped === 0, JSON.stringify(r.data));
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/import-qfx/apply`, { rows: spendParsedRows });
  H.check('spending: re-apply skips every existing FITID',
    r.status === 201 && r.data.inserted === 0 && r.data.skipped === 3, JSON.stringify(r.data));
  r = await H.req('GET', `/api/spending/cards/${spendCardId}`);
  H.check('spending: card detail carries charges-only total and monthly series',
    r.status === 200 && r.data.card.totalSpent === 57.5 && r.data.monthly.length === 1 && r.data.monthly[0].total === 57.5,
    JSON.stringify({ total: r.data.card.totalSpent, monthly: r.data.monthly }));
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/transactions`, { date: '2026-10-10', merchant: 'COSTCO', type: 'charge', amount: 80, category: '' });
  H.check('spending: manual charge stored negative', r.status === 201 && r.data.amount === -80, JSON.stringify(r.data));
  const spendTxId = r.data.id;
  r = await H.req('PUT', `/api/spending/transactions/${spendTxId}`, { category: 'Groceries' });
  H.check('spending: transaction category edits', r.status === 200 && r.data.category === 'Groceries');
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ proposals: [{ merchant: 'WHOLE FOODS', category: 'Groceries' }, { merchant: 'SHELL', category: 'Transport' }] }));
  r = await H.req('POST', '/api/spending/ai-categories', {});
  H.check('spending: AI category proposals cover uncategorized merchants',
    r.status === 200 && r.data.proposals.length === 2, JSON.stringify(r.data));
  r = await H.req('POST', '/api/spending/ai-categories/apply', { proposals: r.data.proposals });
  H.check('spending: AI category apply categorizes rows',
    r.status === 200 && r.data.updated === 2, JSON.stringify(r.data));
  r = await H.req('GET', `/api/spending/cards/${spendCardId}`);
  const wholeFoods = (r.data.transactions || []).find((t) => t.merchant === 'WHOLE FOODS');
  H.check('spending: applied category lands on the transaction', !!wholeFoods && wholeFoods.category === 'Groceries');
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ transactions: [{ date: '2026-10-20', merchant: 'STARBUCKS', amount: 6.5, category: 'Dining', memo: null }] }));
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/fill`, { text: 'Oct 20 Starbucks 6.50' });
  H.check('spending: AI fill proposes a charge row, writes nothing',
    r.status === 200 && r.data.proposals.length === 1 && r.data.proposals[0].amount === -6.5, JSON.stringify(r.data));
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/fill/apply`, { rows: r.data.proposals });
  H.check('spending: AI fill apply inserts the row', r.status === 201 && r.data.inserted === 1, JSON.stringify(r.data));
  r = await H.req('GET', '/api/spending');
  H.check('spending: overall page carries cards, transactions and monthly series',
    r.status === 200 && r.data.cards.length === 1 && r.data.transactions.length === 5 && r.data.monthly.length === 1,
    JSON.stringify({ cards: r.data.cards.length, tx: r.data.transactions.length, months: r.data.monthly.length }));

  // Corrections round: import lives on card detail pages only;
  // the overall page carries no import entry. Category filter
  // narrows the table to one category's transactions.
  // (Its own browser: the section-level `page` is out of scope
  // this late in the script, like the other late browser blocks.)
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardS = (rq) => new Promise((resolve, reject) => {
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
    const loginResS = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueS = loginResS.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserS = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserS.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardS({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueS, domain: 'ff.local', path: '/', httpOnly: true });
      const waitS = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitS(1200);
      const spendOverallUi = await page.evaluate(() => {
        const list = document.querySelector('#spendList');
        const importBtns = [...list.querySelectorAll('button')].filter((b) => b.textContent.includes('Import QFX'));
        const visibleImport = importBtns.filter((b) => b.getBoundingClientRect().height > 0);
        return { hasSpendImportBtn: !!document.querySelector('#spendImportBtn'), visibleImport: visibleImport.length, hasCatFilter: !!document.querySelector('#spendCatBtn') };
      });
      H.check('spending UI: the overall page has no Import QFX entry',
        !spendOverallUi.hasSpendImportBtn && spendOverallUi.visibleImport === 0, JSON.stringify(spendOverallUi));
      H.check('spending UI: the overall transactions table has a category filter',
        spendOverallUi.hasCatFilter, JSON.stringify(spendOverallUi));
      // Multi-select: the panel opens from the button, Select
      // none + one box narrows to that category, Select all
      // restores the page. (The panel rebuilds on every render,
      // so each click re-queries its controls.)
      await page.click('#spendCatBtn');
      await waitS(300);
      const spendPanelOpen = await page.evaluate(() => {
        const p = document.querySelector('#spendCatPanel');
        return !!p && p.getBoundingClientRect().height > 0;
      });
      H.check('spending UI: clicking the category filter opens the checkbox panel',
        spendPanelOpen, JSON.stringify({ spendPanelOpen }));
      // Beautification (screenshot): the action row is one line
      // with equal-height buttons, every checkbox shares one left
      // edge, and every name starts at one left edge tight against
      // its checkbox; panel padding matches the app panels (16px).
      const catPanelGeo = await page.evaluate(() => {
        const p = document.querySelector('#spendCatPanel');
        if (!p) return null;
        const cs = getComputedStyle(p);
        const btns = [...p.querySelectorAll('.spend-tx-catpanel-actions button')].map((b) => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent.trim(), top: Math.round(r.top), h: Math.round(r.height), wrapped: b.scrollWidth > b.clientWidth + 1 };
        });
        const labels = [...p.querySelectorAll('label')].map((l) => {
          const box = l.querySelector('input[type="checkbox"]');
          const textNode = [...l.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
          const range = document.createRange();
          range.selectNodeContents(textNode);
          const tr = range.getBoundingClientRect();
          const br = box.getBoundingClientRect();
          return { boxLeft: Math.round(br.left), boxRight: Math.round(br.right), nameLeft: Math.round(tr.left) };
        });
        return {
          pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
          btns,
          labels,
        };
      });
      H.check('spending UI: category dropdown actions share one line and height, checkbox and name columns align, panel padding is 16px',
        catPanelGeo && catPanelGeo.pad.every((v) => v === '16px')
          && catPanelGeo.btns.length === 3 && catPanelGeo.btns.every((b) => !b.wrapped)
          && new Set(catPanelGeo.btns.map((b) => b.top)).size === 1 && new Set(catPanelGeo.btns.map((b) => b.h)).size === 1
          && catPanelGeo.labels.length > 0 && new Set(catPanelGeo.labels.map((l) => l.boxLeft)).size === 1
          && new Set(catPanelGeo.labels.map((l) => l.nameLeft)).size === 1
          && catPanelGeo.labels.every((l) => l.nameLeft - l.boxRight >= 4 && l.nameLeft - l.boxRight <= 10),
        JSON.stringify(catPanelGeo));
      await page.evaluate(() => { document.querySelector('[data-spend-cat-none="spending"]').click(); });
      await waitS(300);
      await page.evaluate(() => { document.querySelector('#spendCatPanel input[data-spend-cat="Groceries"]').click(); });
      await waitS(300);
      const spendFiltered = await page.evaluate(() => [...document.querySelectorAll('#spendTxTable tbody tr:not(.spend-tx-group)')].map((tr) => tr.children[3].textContent.trim()));
      H.check('spending UI: filtering by Groceries shows only Groceries rows',
        spendFiltered.length === 2 && spendFiltered.every((c) => c === 'Groceries'), JSON.stringify(spendFiltered));
      await page.evaluate(() => { document.querySelector('[data-spend-cat-none="spending"]').click(); });
      await waitS(300);
      await page.evaluate(() => { document.querySelector('#spendCatPanel input[data-spend-cat="__uncat__"]').click(); });
      await waitS(300);
      const spendUncat = await page.evaluate(() => [...document.querySelectorAll('#spendTxTable tbody tr:not(.spend-tx-group)')].map((tr) => tr.children[2].textContent.trim()));
      H.check('spending UI: filtering by Uncategorized shows only the uncategorized payment row',
        spendUncat.length === 1 && spendUncat[0] === 'PAYMENT - THANK YOU', JSON.stringify(spendUncat));
      await page.evaluate(() => { document.querySelector('[data-spend-cat-all="spending"]').click(); });
      await waitS(300);
      await page.goto(`http://ff.local/#spending/card/${spendCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitS(1200);
      const spendDetailUi = await page.evaluate(() => {
        const b = document.querySelector('#spendDetailImportBtn');
        return { present: !!b, visible: !!b && b.getBoundingClientRect().height > 0 };
      });
      H.check('spending UI: the card detail page keeps its Import QFX button',
        spendDetailUi.present && spendDetailUi.visible, JSON.stringify(spendDetailUi));
    } finally { await browserS.close(); }
  }

  // Global analyze: one run covers transactions on TWO cards;
  // a preview override changes only its row, never the mapping.
  r = await H.req('POST', '/api/spending/cards', { name: 'Amex', issuer: 'Amex', last4: '5678' });
  H.check('spending corrections setup: second card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const spendCard2Id = r.data.id;
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/transactions`, { date: '2026-10-11', merchant: 'WAYNE', type: 'charge', amount: 10, category: '' });
  H.check('spending corrections setup: WAYNE row on card 1', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const wayneTxId = r.data.id;
  r = await H.req('POST', `/api/spending/cards/${spendCard2Id}/transactions`, { date: '2026-10-11', merchant: 'ACME', type: 'charge', amount: 20, category: '' });
  H.check('spending corrections setup: ACME row on card 2', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ proposals: [{ merchant: 'WAYNE', category: 'Shopping' }, { merchant: 'ACME', category: 'Groceries' }] }));
  r = await H.req('POST', '/api/spending/ai-categories', {});
  H.check('spending: one global analyze run covers merchants on two different cards',
    r.status === 200 && r.data.proposals.length === 2
    && r.data.proposals.some((p) => p.merchant === 'WAYNE' && p.transactions.some((t) => t.cardName === 'Visa'))
    && r.data.proposals.some((p) => p.merchant === 'ACME' && p.transactions.some((t) => t.cardName === 'Amex')),
    JSON.stringify(r.data.proposals.map((p) => ({ merchant: p.merchant, category: p.category, source: p.source }))));
  r = await H.req('POST', '/api/spending/ai-categories/apply', {
    proposals: [{ merchant: 'WAYNE', category: 'Shopping' }, { merchant: 'ACME', category: 'Groceries' }],
    overrides: [{ txId: wayneTxId, category: 'Dining' }],
  });
  H.check('spending: apply with a preview override categorizes both rows',
    r.status === 200 && r.data.updated === 2, JSON.stringify(r.data));
  r = await H.req('GET', `/api/spending/cards/${spendCardId}`);
  const wayneRow = (r.data.transactions || []).find((t) => t.id === wayneTxId);
  H.check('spending: the overridden row takes the override, not the merchant proposal',
    !!wayneRow && wayneRow.category === 'Dining', JSON.stringify(wayneRow));
  r = await H.req('GET', `/api/spending/cards/${spendCard2Id}`);
  const acmeRow = (r.data.transactions || []).find((t) => t.merchant === 'ACME');
  H.check('spending: the other card row takes the merchant proposal',
    !!acmeRow && acmeRow.category === 'Groceries', JSON.stringify(acmeRow));
  // The override must not rewrite the mapping: a new WAYNE row
  // still proposes Shopping (the confirmed mapping), not Dining.
  r = await H.req('POST', `/api/spending/cards/${spendCardId}/transactions`, { date: '2026-10-12', merchant: 'WAYNE', type: 'charge', amount: 11, category: '' });
  H.check('spending corrections setup: second WAYNE row', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ proposals: [] }));
  r = await H.req('POST', '/api/spending/ai-categories', {});
  H.check('spending: a manual override does not rewrite the merchant mapping',
    r.status === 200 && r.data.proposals.some((p) => p.merchant === 'WAYNE' && p.category === 'Shopping' && p.source === 'remembered'),
    JSON.stringify(r.data.proposals.map((p) => ({ merchant: p.merchant, category: p.category, source: p.source }))));
  r = await H.req('POST', '/api/spending/ai-categories/apply', { proposals: [{ merchant: 'WAYNE', category: 'Shopping' }] });
  H.check('spending: second WAYNE row takes the mapping', r.status === 200 && r.data.updated === 1, JSON.stringify(r.data));
  // Remembered mappings join the same global run: a new ACME row
  // comes back as a remembered proposal with no LLM proposal.
  r = await H.req('POST', `/api/spending/cards/${spendCard2Id}/transactions`, { date: '2026-10-12', merchant: 'ACME', type: 'charge', amount: 21, category: '' });
  H.check('spending corrections setup: second ACME row', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ proposals: [] }));
  r = await H.req('POST', '/api/spending/ai-categories', {});
  H.check('spending: a mapped merchant returns as a remembered proposal in the global run',
    r.status === 200 && r.data.proposals.some((p) => p.merchant === 'ACME' && p.category === 'Groceries' && p.source === 'remembered'),
    JSON.stringify(r.data.proposals.map((p) => ({ merchant: p.merchant, category: p.category, source: p.source }))));
  r = await H.req('POST', '/api/spending/ai-categories/apply', { proposals: r.data.proposals.filter((p) => p.merchant === 'ACME') });
  H.check('spending: remembered proposal categorizes the row', r.status === 200 && r.data.updated === 1, JSON.stringify(r.data));
  // Preview UI: groups by category, expandable to transactions,
  // each row's category editable before Apply.
  r = await H.req('POST', `/api/spending/cards/${spendCard2Id}/transactions`, { date: '2026-10-13', merchant: 'PREVIEWA', type: 'charge', amount: 5, category: '' });
  H.check('spending corrections setup: PREVIEWA row', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const previewATxId = r.data.id;
  r = await H.req('POST', `/api/spending/cards/${spendCard2Id}/transactions`, { date: '2026-10-13', merchant: 'PREVIEWB', type: 'charge', amount: 7, category: '' });
  H.check('spending corrections setup: PREVIEWB row', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ proposals: [{ merchant: 'PREVIEWA', category: 'Dining' }, { merchant: 'PREVIEWB', category: 'Shopping' }] }));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending preview browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardS = (rq) => new Promise((resolve, reject) => {
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
    const loginResS = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueS = loginResS.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserS = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserS.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardS({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueS, domain: 'ff.local', path: '/', httpOnly: true });
      const waitS = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitS(1200);
      const aiHeader = await page.evaluate(() => {
        const btn = document.querySelector('#spendAiAnalyzeBtn');
        const add = document.querySelector('#addSpendCardBtn');
        const head = btn ? btn.closest('.section-head') : null;
        return { btnVisible: !!btn && btn.offsetParent !== null, sameHead: !!head && !!add && head.contains(add), btnText: btn ? btn.textContent : '' };
      });
      H.check('spending UI: header holds ✨ Analyze categories beside + Add card',
        aiHeader.btnVisible && aiHeader.sameHead && /Analyze categories/.test(aiHeader.btnText), JSON.stringify(aiHeader));
      // Spending head row: the same standard as Properties/Stocks —
      // title and + Add card align with the chart panel's content
      // edges (panel border 1px + padding 16px = a 17px inset), and
      // the row leaves 16px of air above the chart panel instead of
      // sitting flush on it.
      const spendHeadGeom = await page.evaluate(() => {
        const head = document.querySelector('#spendList .section-head');
        const title = head.querySelector('h2');
        const btn = document.querySelector('#addSpendCardBtn');
        const panel = document.querySelector('#spendPanel');
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
      H.check('spending head: title left edge aligns with the chart panel content left edge',
        spendHeadGeom.titleLeftDelta <= 3, JSON.stringify(spendHeadGeom));
      H.check('spending head: + Add card right edge aligns with the panel content right edge',
        spendHeadGeom.btnRightDelta <= 3, JSON.stringify(spendHeadGeom));
      H.check('spending head: the button has the standard 16px padding of space above it',
        spendHeadGeom.btnTopGap > 0 && Math.abs(spendHeadGeom.btnTopGap - 16) <= 3, JSON.stringify(spendHeadGeom));
      H.check('spending head: the button leaves the standard 16px gap above the chart panel (not flush)',
        Math.abs(spendHeadGeom.btnPanelGap - 16) <= 3, JSON.stringify(spendHeadGeom));
      const headPadRef = await page.evaluate(() => ({
        prop: getComputedStyle(document.querySelector('#section-properties .section-head')).padding,
        spend: getComputedStyle(document.querySelector('#spendList .section-head')).padding,
      }));
      H.check('spending head: padding matches the Properties section-head standard',
        headPadRef.prop === headPadRef.spend, JSON.stringify(headPadRef));
      const inlineGone = await page.evaluate(() => ({
        inlineHost: !!document.querySelector('#spendList #spendAiProposals'),
        inlineHeading: [...document.querySelectorAll('#spendList h3')].some((h) => h.textContent.includes('Category analysis')),
      }));
      H.check('spending UI: the inline analysis panel is gone from the overall page',
        !inlineGone.inlineHost && !inlineGone.inlineHeading, JSON.stringify(inlineGone));
      await page.click('#spendAiAnalyzeBtn');
      await page.waitForFunction(() => !!document.querySelector('[data-ai-group]'), { timeout: 10000 });
      const modalOpen = await page.evaluate(() => {
        const modal = document.querySelector('#spendAiModal');
        const groupsInModal = modal ? modal.querySelectorAll('[data-ai-group]').length : 0;
        return { modalVisible: !!modal && !modal.classList.contains('hidden'), groupsInModal };
      });
      H.check('spending UI: clicking Analyze opens the modal with the category groups',
        modalOpen.modalVisible && modalOpen.groupsInModal > 0, JSON.stringify(modalOpen));
      const previewUi = await page.evaluate(() => {
        const groups = [...document.querySelectorAll('[data-ai-group]')].map((g) => g.textContent);
        return { groups, hasDining: groups.some((t) => t.includes('Dining')), hasShopping: groups.some((t) => t.includes('Shopping')) };
      });
      H.check('spending UI: analyze preview groups proposals by category',
        previewUi.hasDining && previewUi.hasShopping, JSON.stringify(previewUi.groups));
      // Card grid: one card per group, each with a checkbox, an
      // icon, a per-category color and a source tag.
      const gridUi = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#spendAiModal [data-ai-group]')];
        return {
          grid: !!document.querySelector('#spendAiModal .spend-ai-grid'),
          cards: cards.map((c) => ({
            name: c.querySelector('.ai-name') ? c.querySelector('.ai-name').textContent.trim() : null,
            hasCheck: !!c.querySelector('[data-ai-group-check]'),
            checkChecked: c.querySelector('[data-ai-group-check]') ? c.querySelector('[data-ai-group-check]').checked : null,
            hasIcon: !!c.querySelector('.ai-icon svg'),
            color: c.style.getPropertyValue('--ai-color').trim(),
            hasTag: !!c.querySelector('.badge'),
          })),
        };
      });
      H.check('spending UI: analysis groups render as cards with checkbox, icon, color and source tag',
        gridUi.grid && gridUi.cards.length > 0 && gridUi.cards.every((c) => c.name && c.hasCheck && c.checkChecked && c.hasIcon && c.color && c.hasTag),
        JSON.stringify(gridUi));
      // Clicking a card's checkbox must NOT open the detail modal;
      // toggling it twice leaves the group included for Apply.
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#spendAiModal [data-ai-group]')];
        cards[cards.length - 1].querySelector('[data-ai-group-check]').click();
      });
      await waitS(300);
      const checkNoOpen = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#spendAiModal [data-ai-group]')];
        const last = cards[cards.length - 1];
        return {
          detailHidden: document.querySelector('#spendAiDetailModal').classList.contains('hidden'),
          unchecked: last.querySelector('[data-ai-group-check]').checked === false,
        };
      });
      H.check('spending UI: clicking a card checkbox does not open the detail modal',
        checkNoOpen.detailHidden && checkNoOpen.unchecked, JSON.stringify(checkNoOpen));
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#spendAiModal [data-ai-group]')];
        cards[cards.length - 1].querySelector('[data-ai-group-check]').click();
      });
      await waitS(200);
      // The preview row lives in exactly one group's detail table;
      // open that group's card (not just the first card).
      const previewAGroup = await page.evaluate((txId) => {
        const sel = document.querySelector(`select[data-ai-row-cat="${txId}"]`);
        const grp = sel ? sel.closest('[data-ai-detail-group]') : null;
        return grp ? grp.dataset.aiDetailGroup : null;
      }, previewATxId);
      H.check('spending UI: the preview row belongs to one analysis group', previewAGroup !== null, JSON.stringify({ previewAGroup }));
      await page.evaluate((gi) => { document.querySelector(`#spendAiModal [data-ai-group="${gi}"]`).click(); }, previewAGroup);
      await waitS(300);
      const previewRows = await page.evaluate(() => {
        const modal = document.querySelector('#spendAiDetailModal');
        const rows = modal ? modal.querySelector('[data-ai-detail-group]:not(.hidden)') : null;
        return {
          visible: !!modal && !modal.classList.contains('hidden'),
          title: document.querySelector('#spendAiDetailTitle') ? document.querySelector('#spendAiDetailTitle').textContent : null,
          rowSels: rows ? rows.querySelectorAll('select[data-ai-row-cat]').length : 0,
        };
      });
      H.check('spending UI: clicking a category card opens its detail modal with editable transaction rows',
        previewRows.visible && previewRows.rowSels > 0 && !!previewRows.title, JSON.stringify(previewRows));
      await page.evaluate((txId) => {
        const sel = document.querySelector(`select[data-ai-row-cat="${txId}"]`);
        if (sel) { sel.value = 'Groceries'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }, previewATxId);
      // Close the detail modal; the edit is held, not written, and
      // reopening the same card still shows it.
      await page.evaluate(() => {
        document.querySelector('#spendAiDetailModal [data-close-modal]').click();
      });
      await waitS(300);
      await page.evaluate((gi) => { document.querySelector(`#spendAiModal [data-ai-group="${gi}"]`).click(); }, previewAGroup);
      await waitS(300);
      const heldEdit = await page.evaluate((txId) => {
        const sel = document.querySelector(`select[data-ai-row-cat="${txId}"]`);
        return { held: sel ? sel.value : null, detailVisible: !document.querySelector('#spendAiDetailModal').classList.contains('hidden') };
      }, previewATxId);
      H.check('spending UI: a detail-modal edit is held across close and reopen, before Apply',
        heldEdit.held === 'Groceries' && heldEdit.detailVisible, JSON.stringify(heldEdit));
      await page.evaluate(() => {
        document.querySelector('#spendAiDetailModal [data-close-modal]').click();
      });
      await waitS(300);
      await page.click('#spendAiApplyBtn');
      await waitS(800);
      const modalClosed = await page.evaluate(() => {
        const modal = document.querySelector('#spendAiModal');
        return { modalHidden: !!modal && modal.classList.contains('hidden') };
      });
      H.check('spending UI: Apply closes the analysis modal', modalClosed.modalHidden, JSON.stringify(modalClosed));
    } finally { await browserS.close(); }
  }
  r = await H.req('GET', `/api/spending/cards/${spendCard2Id}`);
  const previewARow = (r.data.transactions || []).find((t) => t.id === previewATxId);
  const previewBRow = (r.data.transactions || []).find((t) => t.merchant === 'PREVIEWB');
  H.check('spending UI: a preview row edit changes only that row on Apply',
    !!previewARow && previewARow.category === 'Groceries' && !!previewBRow && previewBRow.category === 'Shopping',
    JSON.stringify({ a: previewARow && previewARow.category, b: previewBRow && previewBRow.category }));
  r = await H.req('DELETE', `/api/spending/cards/${spendCard2Id}`);
  H.check('spending corrections cleanup: second card deleted', r.status === 200);
  r = await H.req('DELETE', `/api/spending/transactions/${spendTxId}`);
  H.check('spending: transaction deletes', r.status === 200);
  r = await H.req('DELETE', `/api/spending/cards/${spendCardId}`);
  H.check('spending: card deletes', r.status === 200);
  r = await H.req('GET', '/api/spending');
  H.check('spending: cleanup leaves no cards', r.status === 200 && r.data.cards.length === 0);

  // Stacked history round: the overall monthly bars break down by
  // the share toggle's portion (By card / By category) under a
  // total line, with the doughnut's colors; toggling re-stacks
  // without a reload. Self-contained fixtures + browser block.
  r = await H.req('POST', '/api/spending/cards', { name: 'StackA', issuer: 'CIBC', last4: '1001' });
  H.check('spending stacked setup: card A created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const stackCardAId = r.data.id;
  r = await H.req('POST', '/api/spending/cards', { name: 'StackB', issuer: 'Amex', last4: '1002' });
  H.check('spending stacked setup: card B created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const stackCardBId = r.data.id;
  for (const [cardId, date, merchant, amount, category] of [
    [stackCardAId, '2026-10-05', 'STACK DINING A', 30, 'Dining'],
    [stackCardAId, '2026-10-06', 'STACK GROCERY A', 50, 'Groceries'],
    [stackCardBId, '2026-10-07', 'STACK DINING B', 20, 'Dining'],
    [stackCardBId, '2026-10-08', 'STACK SHOP B', 40, 'Shopping'],
  ]) {
    r = await H.req('POST', `/api/spending/cards/${cardId}/transactions`, { date, merchant, type: 'charge', amount, category });
    H.check(`spending stacked setup: ${merchant} row`, r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  }
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending stacked browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardK = (rq) => new Promise((resolve, reject) => {
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
    const loginResK = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueK = loginResK.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserK = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserK.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardK({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueK, domain: 'ff.local', path: '/', httpOnly: true });
      const waitK = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitK(1200);
      const readSpendHist = () => {
        const hist = window.__fmCharts.spend;
        const share = window.__fmCharts.spendShare;
        if (!hist || !share) return null;
        const mi = hist.data.labels.indexOf('2026-10');
        const bars = hist.data.datasets.filter((d) => d.type === 'bar');
        const line = hist.data.datasets.find((d) => d.type !== 'bar');
        const shareColors = {};
        share.data.labels.forEach((l, i) => { shareColors[l] = share.data.datasets[0].backgroundColor[i]; });
        return {
          monthIdx: mi,
          barLabels: bars.map((d) => d.label),
          barValues: bars.map((d) => (mi >= 0 ? d.data[mi] : null)),
          barColors: bars.map((d) => d.backgroundColor),
          barStacks: bars.map((d) => d.stack),
          lineLabel: line ? line.label : null,
          lineValue: line && mi >= 0 ? line.data[mi] : null,
          shareColors,
        };
      };
      const byCard = await page.evaluate(readSpendHist);
      H.check('spending UI: history stacks by card under a total line',
        !!byCard && byCard.monthIdx >= 0
        && byCard.barLabels.join(',') === 'StackA,StackB'
        && byCard.barValues.join(',') === '80,60'
        && byCard.barValues.reduce((s, v) => s + v, 0) === byCard.lineValue && byCard.lineValue === 140
        && byCard.barStacks.every((s) => s === 'spend')
        && byCard.barColors.every((c, i) => c === byCard.shareColors[byCard.barLabels[i]]),
        JSON.stringify(byCard));
      await page.click('#spendShareModeBtns button[data-mode="category"]');
      await waitK(800);
      const byCat = await page.evaluate(readSpendHist);
      H.check('spending UI: toggling to By category re-stacks without reload',
        !!byCat && byCat.monthIdx >= 0
        && byCat.barLabels.join(',') === 'Dining,Groceries,Shopping'
        && byCat.barValues.join(',') === '50,50,40'
        && byCat.barValues.reduce((s, v) => s + v, 0) === byCat.lineValue && byCat.lineValue === 140
        && byCat.barStacks.every((s) => s === 'spend')
        && byCat.barColors.every((c, i) => c === byCat.shareColors[byCat.barLabels[i]]),
        JSON.stringify(byCat));
    } finally { await browserK.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${stackCardAId}`);
  H.check('spending stacked cleanup: card A deleted', r.status === 200);
  r = await H.req('DELETE', `/api/spending/cards/${stackCardBId}`);
  H.check('spending stacked cleanup: card B deleted', r.status === 200);

  // Month-paged transaction tables round: the overall and the
  // card detail tables both paginate by year-month (one month
  // per page, same pager), the overall page grouping by
  // category, the range picker constraining pageable months.
  // Fixture months: 2024-05 (old), 2026-08, 2026-10 — Sep 2026
  // is deliberately empty so stepping can land on a no-row month.
  r = await H.req('POST', '/api/spending/cards', { name: 'MonthA', issuer: 'CIBC', last4: '2001' });
  H.check('spending month setup: card A created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const monthCardAId = r.data.id;
  r = await H.req('POST', '/api/spending/cards', { name: 'MonthB', issuer: 'Amex', last4: '2002' });
  H.check('spending month setup: card B created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const monthCardBId = r.data.id;
  for (const [cardId, date, merchant, amount, category] of [
    [monthCardAId, '2024-05-10', 'MONTH OLD A', 5, 'Dining'],
    [monthCardAId, '2026-08-10', 'MONTH AUG A', 10, 'Dining'],
    [monthCardBId, '2026-08-12', 'MONTH AUG B', 20, 'Groceries'],
    [monthCardAId, '2026-10-07', 'MONTH OCT A', 50, 'Dining'],
    [monthCardBId, '2026-10-08', 'MONTH OCT B', 60, 'Shopping'],
  ]) {
    r = await H.req('POST', `/api/spending/cards/${cardId}/transactions`, { date, merchant, type: 'charge', amount, category });
    H.check(`spending month setup: ${merchant} row`, r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  }
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending month browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardM = (rq) => new Promise((resolve, reject) => {
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
    const loginResM = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueM = loginResM.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserM = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserM.newPage();
      page.on('dialog', (d) => d.accept());
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardM({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueM, domain: 'ff.local', path: '/', httpOnly: true });
      const waitM = (ms) => new Promise((res2) => setTimeout(res2, ms));
      const readSpendTxPage = () => {
        const pager = document.querySelector('[data-spend-tx-pager="spending"]');
        const tbl = document.querySelector('#spendTxTable table');
        const rows = tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
        return {
          label: pager ? pager.querySelector('span').textContent.trim() : null,
          prevDisabled: pager ? pager.querySelectorAll('button')[0].disabled : null,
          nextDisabled: pager ? pager.querySelectorAll('button')[1].disabled : null,
          merchants: rows.filter((tr) => !tr.classList.contains('spend-tx-group')).map((tr) => tr.cells[2].textContent.trim()),
          groups: rows.filter((tr) => tr.classList.contains('spend-tx-group')).map((tr) => tr.cells[0].textContent.trim()),
          note: document.querySelector('#spendTxTable .note') ? document.querySelector('#spendTxTable .note').textContent.trim() : null,
        };
      };
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitM(1200);
      const octPage = await page.evaluate(readSpendTxPage);
      H.check('spending UI: overall table defaults to the latest month page, grouped by category',
        octPage.label === 'Oct 2026' && octPage.groups.join(',') === 'Dining,Shopping'
        && octPage.merchants.join(',') === 'MONTH OCT A,MONTH OCT B' && octPage.nextDisabled === true,
        JSON.stringify(octPage));
      await page.evaluate(() => { document.querySelector('[data-spend-tx-pager="spending"] button').click(); });
      await waitM(600);
      const sepPage = await page.evaluate(readSpendTxPage);
      H.check('spending UI: stepping into an empty month renders empty, not an error',
        sepPage.label === 'Sep 2026' && sepPage.merchants.length === 0 && sepPage.note === 'No transactions in this month.',
        JSON.stringify(sepPage));
      await page.evaluate(() => { document.querySelector('[data-spend-tx-pager="spending"] button').click(); });
      await waitM(600);
      const augPage = await page.evaluate(readSpendTxPage);
      H.check('spending UI: Aug page groups Dining before Groceries',
        augPage.label === 'Aug 2026' && augPage.groups.join(',') === 'Dining,Groceries'
        && augPage.merchants.join(',') === 'MONTH AUG A,MONTH AUG B',
        JSON.stringify(augPage));
      const filterRow = await page.evaluate(() => {
        const btn = document.querySelector('#spendCatBtn');
        const pager = document.querySelector('[data-spend-tx-pager="spending"]');
        const row = btn ? btn.closest('.spend-tx-controls') : null;
        const s = btn.getBoundingClientRect(), p = pager.getBoundingClientRect();
        const pb = pager.querySelector('button').getBoundingClientRect();
        const card = document.querySelector('#spendCardList .breakdown-card');
        const panel = document.querySelector('#spendTxTable').closest('.panel');
        const cs = getComputedStyle(card), ps = getComputedStyle(panel);
        return {
          sameRow: !!(row && row.contains(pager)),
          overlap: s.top < p.bottom && p.top < s.bottom,
          // One clean band: the filter button and the pager
          // buttons share one vertical center and one height.
          centerDiff: Math.abs((s.top + s.height / 2) - (pb.top + pb.height / 2)),
          heightDiff: Math.abs(s.height - pb.height),
          cardPad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
          panelPad: [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].join(' '),
        };
      });
      H.check('spending UI: category filter and month pager share one row, transactions panel padding equals credit-card card padding',
        filterRow.sameRow && filterRow.overlap && filterRow.centerDiff <= 2 && filterRow.heightDiff <= 2 && filterRow.cardPad === filterRow.panelPad,
        JSON.stringify(filterRow));
      // Padding alignment: the transactions table's text edges sit
      // on the same vertical line as the credit-card titles above
      // (panel 16px + border 1px = 17px inset), not 8px deeper from
      // cell padding stacking on panel padding; group bars still
      // span the full table width.
      const spendAlign = await page.evaluate(() => {
        const cardTitle = document.querySelector('#spendCardList .breakdown-card .k');
        const tbl = document.querySelector('#spendTxTable table');
        const dataRow = tbl ? [...tbl.querySelectorAll('tbody tr')].find((tr) => !tr.classList.contains('spend-tx-group')) : null;
        const groupCell = tbl ? tbl.querySelector('tbody tr.spend-tx-group td') : null;
        return {
          cardX: cardTitle ? cardTitle.getBoundingClientRect().left : null,
          cellX: dataRow ? dataRow.cells[0].getBoundingClientRect().left : null,
          groupX: groupCell ? groupCell.getBoundingClientRect().left : null,
          groupW: groupCell ? groupCell.getBoundingClientRect().width : null,
          tableW: tbl ? tbl.getBoundingClientRect().width : null,
        };
      });
      H.check('spending UI: table first-column text aligns with the credit-card title, group bars span the table width',
        spendAlign.cardX != null && spendAlign.cellX != null && Math.abs(spendAlign.cardX - spendAlign.cellX) <= 1
        && spendAlign.groupX != null && Math.abs(spendAlign.groupX - spendAlign.cellX) <= 1
        && spendAlign.groupW != null && spendAlign.tableW != null && Math.abs(spendAlign.groupW - spendAlign.tableW) <= 1,
        JSON.stringify(spendAlign));
      // Round 3: the spending picker loads on the 1-year trailing
      // default (Nov 2025-Oct 2026 on this fixture's span).
      const spendDef = await page.evaluate(() => ({
        from: document.querySelector('#invRangeStart-spending').textContent.trim(),
        to: document.querySelector('#invRangeEnd-spending').textContent.trim(),
      }));
      H.check('date range: spending picker defaults to the past 12 months',
        spendDef.from === 'Nov 2025' && spendDef.to === 'Oct 2026', JSON.stringify(spendDef));
      const spendSet = await page.evaluate(() => {
        const bar = document.querySelector('#invRangeBtns-spending');
        const q = (s) => !!bar.querySelector(s);
        return { three: q('button[data-months="3"]'), ytd: q('button[data-ytd]'), two: q('button[data-months="24"]'), all: q('button[data-months="0"]'), twelve: q('button[data-months="12"]'), sixty: q('button[data-months="60"]') };
      });
      H.check('date range: spending presets are 3 months / This year / 2 years / All (no 1/5-year buttons)',
        spendSet.three && spendSet.ytd && spendSet.two && spendSet.all && !spendSet.twelve && !spendSet.sixty,
        JSON.stringify(spendSet));
      // Range constrains pageable months: 1 year from Oct 2026
      // ends at Nov 2025, so stepping back must stop there and
      // can never reach the 2024-05 row. The spend preset set has
      // no 12-month button, so set the window explicitly: All
      // first (a real change, re-defaulting the table), then the
      // 1-year window through the month popovers.
      await page.click('#invRangeBtns-spending button[data-months="0"]');
      await waitM(800);
      const pickSpendMonth = async (fieldSel, ym) => {
        await page.click(fieldSel);
        await page.waitForFunction(() => !document.querySelector('#invMonthPop-spending').classList.contains('hidden'), { timeout: 5000 });
        const targetYear = Number(ym.slice(0, 4));
        for (let i = 0; i < 40; i++) {
          const y = await page.evaluate(() => Number(document.querySelector('#invMonthPop-spending .month-pop-year').textContent));
          if (y === targetYear) break;
          await page.click(`#invMonthPop-spending ${y < targetYear ? '[data-pop-next]' : '[data-pop-prev]'}`);
          await waitM(120);
        }
        await page.click(`#invMonthPop-spending button[data-ym="${ym}"]`);
        await waitM(300);
      };
      await pickSpendMonth('#invRangeStart-spending', '2025-11');
      await pickSpendMonth('#invRangeEnd-spending', '2026-10');
      await waitM(800);
      const afterPreset = await page.evaluate(readSpendTxPage);
      H.check('spending UI: a range change re-defaults the table to the latest month in range',
        afterPreset.label === 'Oct 2026', JSON.stringify(afterPreset));
      for (let i = 0; i < 12; i++) {
        const stepped = await page.evaluate(() => {
          const pager = document.querySelector('[data-spend-tx-pager="spending"]');
          const prev = pager.querySelectorAll('button')[0];
          if (prev.disabled) return false;
          prev.click();
          return true;
        });
        await waitM(300);
        if (!stepped) break;
      }
      const rangeEdge = await page.evaluate(readSpendTxPage);
      H.check('spending UI: pager stops at the range start and never reaches the out-of-range month',
        rangeEdge.label === 'Nov 2025' && rangeEdge.prevDisabled === true && !rangeEdge.merchants.includes('MONTH OLD A'),
        JSON.stringify(rangeEdge));
      await page.click('#invRangeBtns-spending button[data-months="0"]');
      await waitM(800);
      // Round 3: preset actions drive the spending range (and the
      // table re-defaults to the latest month in range each time).
      const spendRangeFields = () => page.evaluate(() => ({
        from: document.querySelector('#invRangeStart-spending').textContent.trim(),
        to: document.querySelector('#invRangeEnd-spending').textContent.trim(),
        pager: document.querySelector('[data-spend-tx-pager="spending"]') ? document.querySelector('[data-spend-tx-pager="spending"]').querySelector('span').textContent.trim() : null,
      }));
      await page.click('#invRangeBtns-spending button[data-ytd]');
      await waitM(800);
      const spendYtd = await spendRangeFields();
      H.check('date range: spending This year preset narrows to Jan-current month and re-defaults the table',
        spendYtd.from === 'Jan 2026' && spendYtd.to === 'Oct 2026' && spendYtd.pager === 'Oct 2026', JSON.stringify(spendYtd));
      await page.click('#invRangeBtns-spending button[data-months="24"]');
      await waitM(800);
      const spend2y = await spendRangeFields();
      H.check('date range: spending 2 years preset widens to the trailing 24 months',
        spend2y.from === 'Nov 2024' && spend2y.to === 'Oct 2026' && spend2y.pager === 'Oct 2026', JSON.stringify(spend2y));
      await page.click('#invRangeBtns-spending button[data-months="0"]');
      await waitM(800);
      const spendAll2 = await spendRangeFields();
      const monIdx = (s) => { const [mo, y] = s.split(' '); return Number(y) * 12 + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(mo); };
      H.check('date range: spending All preset restores the full span',
        spendAll2.to === 'Oct 2026' && spendAll2.pager === 'Oct 2026' && monIdx(spendAll2.from) < monIdx('Nov 2024'),
        JSON.stringify(spendAll2));
      // Detail table: the identical month pager on card A.
      await page.goto(`http://ff.local/#spending/card/${monthCardAId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitM(1200);
      const readDetailTxPage = () => {
        const pager = document.querySelector('[data-spend-tx-pager="spendCard"]');
        const tbl = document.querySelector('#spendDetailTxTable table');
        const rows = tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
        return {
          label: pager ? pager.querySelector('span').textContent.trim() : null,
          merchants: rows.map((tr) => tr.cells[1].textContent.trim()),
          note: document.querySelector('#spendDetailTxTable .note') ? document.querySelector('#spendDetailTxTable .note').textContent.trim() : null,
        };
      };
      const detOct = await page.evaluate(readDetailTxPage);
      H.check('spending UI: detail table uses the same month pager, latest month first',
        detOct.label === 'Oct 2026' && detOct.merchants.join(',') === 'MONTH OCT A',
        JSON.stringify(detOct));
      await page.evaluate(() => { document.querySelector('[data-spend-tx-pager="spendCard"] button').click(); });
      await waitM(600);
      const detSep = await page.evaluate(readDetailTxPage);
      H.check('spending UI: detail table stepping into an empty month renders empty',
        detSep.label === 'Sep 2026' && detSep.merchants.length === 0 && detSep.note === 'No transactions in this month.',
        JSON.stringify(detSep));
      await page.evaluate(() => { document.querySelector('[data-spend-tx-pager="spendCard"] button').click(); });
      await waitM(600);
      const detAug = await page.evaluate(readDetailTxPage);
      H.check('spending UI: detail Aug page shows the card row',
        detAug.label === 'Aug 2026' && detAug.merchants.join(',') === 'MONTH AUG A',
        JSON.stringify(detAug));
      const detFilterRow = await page.evaluate(() => {
        const btn = document.querySelector('#spendDetailCatBtn');
        const pager = document.querySelector('[data-spend-tx-pager="spendCard"]');
        const row = btn ? btn.closest('.spend-tx-controls') : null;
        const s = btn.getBoundingClientRect(), p = pager.getBoundingClientRect();
        const pb = pager.querySelector('button').getBoundingClientRect();
        const panel = document.querySelector('#spendDetailTxTable').closest('.panel');
        const ps = getComputedStyle(panel);
        return {
          sameRow: !!(row && row.contains(pager)),
          overlap: s.top < p.bottom && p.top < s.bottom,
          centerDiff: Math.abs((s.top + s.height / 2) - (pb.top + pb.height / 2)),
          heightDiff: Math.abs(s.height - pb.height),
          panelPad: [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].join(' '),
        };
      });
      H.check('spending UI: detail filter and pager share one row, detail panel padding matches the 16px card standard',
        detFilterRow.sameRow && detFilterRow.overlap && detFilterRow.centerDiff <= 2 && detFilterRow.heightDiff <= 2 && detFilterRow.panelPad === '16px 16px 16px 16px',
        JSON.stringify(detFilterRow));
      // Detail table: same alignment — first-column text sits on
      // the panel's 17px content inset, matching the detail page's
      // own panel headings (not 8px deeper).
      const detAlign = await page.evaluate(() => {
        const tbl = document.querySelector('#spendDetailTxTable table');
        const row = tbl ? tbl.querySelector('tbody tr') : null;
        const head = document.querySelector('#spendDetailPanel h3');
        return {
          cellX: row ? row.cells[0].getBoundingClientRect().left : null,
          headX: head ? head.getBoundingClientRect().left : null,
        };
      });
      H.check('spending UI: detail table first-column text aligns with the detail panel heading',
        detAlign.cellX != null && detAlign.headX != null && Math.abs(detAlign.cellX - detAlign.headX) <= 1,
        JSON.stringify(detAlign));
      // Edit from the paged detail table, then Delete from it.
      await page.evaluate(() => {
        const tbl = document.querySelector('#spendDetailTxTable table');
        [...tbl.querySelectorAll('tbody tr')].find((tr) => tr.cells[1].textContent.trim() === 'MONTH AUG A')
          .querySelector('button').click();
      });
      await waitM(600);
      const editOpened = await page.evaluate(() => ({
        title: document.querySelector('#spendTxFormTitle').textContent.trim(),
        merchant: document.querySelector('#spendTxForm [name=merchant]').value,
      }));
      H.check('spending UI: Edit opens from the paged detail table with the row values',
        editOpened.title === 'Edit transaction' && editOpened.merchant === 'MONTH AUG A',
        JSON.stringify(editOpened));
      await page.evaluate(() => { document.querySelector('#spendTxForm [name=merchant]').value = 'MONTH AUG A EDITED'; });
      await page.click('#spendTxForm button[type=submit]');
      await waitM(1000);
      const detAugEdited = await page.evaluate(readDetailTxPage);
      H.check('spending UI: Edit from the paged table saves and stays on the same month page',
        detAugEdited.label === 'Aug 2026' && detAugEdited.merchants.join(',') === 'MONTH AUG A EDITED',
        JSON.stringify(detAugEdited));
      await page.evaluate(() => {
        const tbl = document.querySelector('#spendDetailTxTable table');
        const row = [...tbl.querySelectorAll('tbody tr')].find((tr) => tr.cells[1].textContent.trim() === 'MONTH AUG A EDITED');
        row.querySelectorAll('button')[1].click();
      });
      await waitM(1000);
      const detAugDeleted = await page.evaluate(readDetailTxPage);
      H.check('spending UI: Delete from the paged table removes the row and leaves the month empty',
        detAugDeleted.label === 'Aug 2026' && detAugDeleted.merchants.length === 0 && detAugDeleted.note === 'No transactions in this month.',
        JSON.stringify(detAugDeleted));
    } finally { await browserM.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${monthCardAId}`);
  H.check('spending month cleanup: card A deleted', r.status === 200);
  r = await H.req('DELETE', `/api/spending/cards/${monthCardBId}`);
  H.check('spending month cleanup: card B deleted', r.status === 200);

  // Multi-select + sum row round: the category filter is a
  // checkbox multi-select (Select all / Select none, live
  // filtering) on both tables, and each table carries one sum
  // row in <tfoot> equal to the displayed rows to the cent.
  // Spacing rides along: the Spending gaps must equal the
  // app-wide standards (panel 16px / 14px, section-head
  // 16px 17px, h3-to-controls 8px, controls-to-table 10px,
  // last-row-to-panel-bottom 16px, cards gap 12px).
  r = await H.req('POST', '/api/spending/cards', { name: 'Sum', issuer: 'CIBC', last4: '7001' });
  H.check('spending sum setup: card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const sumCardId = r.data.id;
  for (const [date, merchant, type, amount, category] of [
    ['2026-10-05', 'SUM DIN A', 'charge', 50, 'Dining'],
    ['2026-10-06', 'SUM DIN B', 'charge', 30, 'Dining'],
    ['2026-10-07', 'SUM GRO', 'charge', 20, 'Groceries'],
    ['2026-10-08', 'SUM PAY', 'payment', 40, ''],
  ]) {
    r = await H.req('POST', `/api/spending/cards/${sumCardId}/transactions`, { date, merchant, type, amount, category });
    H.check(`spending sum setup: ${merchant} row`, r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  }
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending sum browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardN = (rq) => new Promise((resolve, reject) => {
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
    const loginResN = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueN = loginResN.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserN = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserN.newPage();
      page.on('dialog', (d) => d.accept());
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardN({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueN, domain: 'ff.local', path: '/', httpOnly: true });
      const waitN = (ms) => new Promise((res2) => setTimeout(res2, ms));
      // Overall page: the sum row must equal the displayed
      // month page recomputed from the API (other cards' rows
      // share the page, so the expectation is computed, not
      // hardcoded). The displayed amount of a row is the charge
      // negated, the payment negated, the adjustment as stored.
      const apiAll = (await H.req('GET', '/api/spending')).data;
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitN(1200);
      const overallSum = await page.evaluate(() => {
        const pager = document.querySelector('[data-spend-tx-pager="spending"]');
        const foot = document.querySelector('#spendTxTable tfoot tr.spend-tx-sum');
        const panel = document.querySelector('#spendTxTable').closest('.panel');
        const h3 = panel.querySelector('h3');
        const controls = document.querySelector('#spendTxTable .spend-tx-controls');
        const table = document.querySelector('#spendTxTable table');
        // Measure from the TABLE's bottom, not the last row's:
        // in the collapsed-border model a tr rect stops 1px short
        // of its cells' bottom border, which would read 17px
        // against a true 16px padding. The table box includes
        // the collapsed bottom border, so it reads exactly 16.
        const lastRow = table; // bottom edge of the whole table
        const pr = panel.getBoundingClientRect();
        const ps = getComputedStyle(panel);
        const head = document.querySelector('#spendList .section-head');
        const hs = getComputedStyle(head);
        const btn = document.querySelector('#spendCatBtn');
        const pb = pager.querySelector('button').getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const cards = document.querySelector('#spendCardList');
        const round = (v) => Math.round(v);
        return {
          label: pager ? pager.querySelector('span').textContent.trim() : null,
          foot: foot ? foot.cells[1].textContent.trim() : null,
          panelPad: [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].join(' '),
          panelMarginBottom: ps.marginBottom,
          headPad: [hs.paddingTop, hs.paddingRight, hs.paddingBottom, hs.paddingLeft].join(' '),
          h3ToControls: round(controls.getBoundingClientRect().top - h3.getBoundingClientRect().bottom),
          controlsToTable: round(table.getBoundingClientRect().top - controls.getBoundingClientRect().bottom),
          lastToPanel: round(pr.bottom - lastRow.getBoundingClientRect().bottom - parseFloat(ps.borderBottomWidth)),
          centerDiff: Math.abs((br.top + br.height / 2) - (pb.top + pb.height / 2)),
          heightDiff: Math.abs(br.height - pb.height),
          cardsGap: getComputedStyle(cards).gap,
        };
      });
      const shownMonth = overallSum.label === 'Oct 2026' ? '2026-10' : null;
      const expectedOverall = Math.round((apiAll.transactions || [])
        .filter((t) => String(t.date).slice(0, 7) === shownMonth)
        .reduce((s, t) => s + (t.kind === 'adjustment' ? Number(t.amount) : -Number(t.amount)), 0) * 100) / 100;
      const expectedOverallText = expectedOverall.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      H.check('spending UI: overall sum row equals the displayed month page to the cent',
        shownMonth !== null && overallSum.foot === expectedOverallText,
        JSON.stringify({ foot: overallSum.foot, expected: expectedOverallText, label: overallSum.label }));
      H.check('spending UI: overall spacing matches the app-wide standards',
        overallSum.panelPad === '16px 16px 16px 16px' && overallSum.panelMarginBottom === '14px'
          && overallSum.headPad === '16px 17px 16px 17px' && overallSum.h3ToControls === 8
          && overallSum.controlsToTable === 10 && overallSum.lastToPanel === 16
          && overallSum.centerDiff <= 2 && overallSum.heightDiff <= 2 && overallSum.cardsGap === '12px',
        JSON.stringify(overallSum));
      // Cards-gap round: the Transactions panel below the card
      // grid sits exactly one standard block gap (14px) under the
      // cards — previously the two borders touched (0px), because
      // .cards carries no margin and .panel carries no margin-top.
      // Card-to-card gap stays 12px.
      const cardsGapBlock = await page.evaluate(() => {
        const list = document.querySelector('#spendCardList');
        const panel = document.querySelector('#spendTxTable').closest('.panel');
        const lr = list.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        const cards = [...document.querySelectorAll('#spendCardList .breakdown-card')];
        let rowGap = null;
        for (let i = 1; i < cards.length; i++) {
          const a = cards[i - 1].getBoundingClientRect();
          const b = cards[i].getBoundingClientRect();
          if (Math.abs(a.top - b.top) <= 1) { rowGap = Math.round(b.left - a.right); break; }
        }
        return {
          blockGap: Math.round(pr.top - lr.bottom),
          cardsGap: getComputedStyle(list).gap,
          rowGap,
        };
      });
      H.check('spending UI: card grid to Transactions panel gap is 14px, card-to-card gap stays 12px',
        cardsGapBlock.blockGap === 14 && cardsGapBlock.cardsGap === '12px' && (cardsGapBlock.rowGap === null || cardsGapBlock.rowGap === 12),
        JSON.stringify(cardsGapBlock));
      // Overall multi-select: Select none empties the table
      // (note, no sum row); Select all restores page + sum.
      await page.click('#spendCatBtn');
      await waitN(300);
      await page.evaluate(() => { document.querySelector('[data-spend-cat-none="spending"]').click(); });
      await waitN(300);
      const noneState = await page.evaluate(() => ({
        table: !!document.querySelector('#spendTxTable table'),
        foot: !!document.querySelector('#spendTxTable tfoot'),
        note: document.querySelector('#spendTxTable .note') ? document.querySelector('#spendTxTable .note').textContent.trim() : null,
        btnText: document.querySelector('#spendCatBtn').textContent.trim(),
      }));
      H.check('spending UI: Select none empties the table with the category note and no sum row',
        noneState.table === false && noneState.foot === false && noneState.note === 'No transactions in this category.' && noneState.btnText === 'Category: None',
        JSON.stringify(noneState));
      await page.evaluate(() => { document.querySelector('[data-spend-cat-all="spending"]').click(); });
      await waitN(300);
      const allState = await page.evaluate(() => ({
        foot: document.querySelector('#spendTxTable tfoot tr.spend-tx-sum') ? document.querySelector('#spendTxTable tfoot tr.spend-tx-sum').cells[1].textContent.trim() : null,
        btnText: document.querySelector('#spendCatBtn').textContent.trim(),
      }));
      H.check('spending UI: Select all restores the full page and its sum',
        allState.foot === expectedOverallText && allState.btnText === 'Category: All categories',
        JSON.stringify(allState));
      // Detail page: this card alone, so the sums are exact.
      // (The API serves transactions newest-first, so the row
      // order below is reverse-chronological, not insertion order.)
      await page.goto(`http://ff.local/#spending/card/${sumCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitN(1200);
      const detSum = await page.evaluate(() => {
        const foot = document.querySelector('#spendDetailTxTable tfoot tr.spend-tx-sum');
        const rows = [...document.querySelectorAll('#spendDetailTxTable tbody tr')].map((tr) => tr.cells[1].textContent.trim());
        return { foot: foot ? foot.cells[1].textContent.trim() : null, rows };
      });
      H.check('spending UI: detail sum row equals the card month page to the cent',
        detSum.foot === '$60.00' && detSum.rows.join(',') === 'SUM PAY,SUM GRO,SUM DIN B,SUM DIN A',
        JSON.stringify(detSum));
      // Toggling Groceries off removes exactly its rows and
      // re-sums the rest (50 + 30 - 40 = 40.00).
      await page.click('#spendDetailCatBtn');
      await waitN(300);
      await page.evaluate(() => { document.querySelector('#spendDetailCatPanel input[data-spend-cat="Groceries"]').click(); });
      await waitN(300);
      const detNoGro = await page.evaluate(() => {
        const foot = document.querySelector('#spendDetailTxTable tfoot tr.spend-tx-sum');
        const rows = [...document.querySelectorAll('#spendDetailTxTable tbody tr')].map((tr) => tr.cells[1].textContent.trim());
        return { foot: foot ? foot.cells[1].textContent.trim() : null, rows };
      });
      H.check('spending UI: toggling one category off removes exactly its rows and re-sums',
        detNoGro.foot === '$40.00' && detNoGro.rows.join(',') === 'SUM PAY,SUM DIN B,SUM DIN A',
        JSON.stringify(detNoGro));
      // Outside click closes the panel; detail spacing matches.
      await page.evaluate(() => { document.querySelector('#spendDetailTxTable').closest('.panel').querySelector('h3, .toolbar').click(); });
      await waitN(300);
      const detSpace = await page.evaluate(() => {
        const panel = document.querySelector('#spendDetailTxTable').closest('.panel');
        const ps = getComputedStyle(panel);
        const controls = document.querySelector('#spendDetailTxTable .spend-tx-controls');
        const table = document.querySelector('#spendDetailTxTable table');
        const toolbar = panel.querySelector('.toolbar');
        const pager = document.querySelector('[data-spend-tx-pager="spendCard"]');
        const btn = document.querySelector('#spendDetailCatBtn');
        const pb = pager.querySelector('button').getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const round = (v) => Math.round(v);
        return {
          panelOpen: !!document.querySelector('#spendDetailCatPanel'),
          panelPad: [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].join(' '),
          toolbarToControls: round(controls.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom),
          controlsToTable: round(table.getBoundingClientRect().top - controls.getBoundingClientRect().bottom),
          centerDiff: Math.abs((br.top + br.height / 2) - (pb.top + pb.height / 2)),
          heightDiff: Math.abs(br.height - pb.height),
        };
      });
      H.check('spending UI: outside click closes the filter panel and detail spacing matches',
        detSpace.panelOpen === false && detSpace.panelPad === '16px 16px 16px 16px'
          && detSpace.toolbarToControls === 10 && detSpace.controlsToTable === 10
          && detSpace.centerDiff <= 2 && detSpace.heightDiff <= 2,
        JSON.stringify(detSpace));
    } finally { await browserN.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${sumCardId}`);
  H.check('spending sum cleanup: card deleted', r.status === 200);

  // History bar-click round: clicking a bar in the monthly
  // history chart sets that page's range to From = To = the
  // bar's month (a custom range — no preset stays active) and
  // the share, the history and the transactions table update in
  // sync, the table landing on the clicked month's page.
  r = await H.req('POST', '/api/spending/cards', { name: 'Bar', issuer: 'CIBC', last4: '7002' });
  H.check('spending bar-click setup: card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const barCardId = r.data.id;
  for (const [date, merchant, amount, category] of [
    ['2026-10-10', 'BAR OCT', 70, 'Dining'],
    ['2026-08-10', 'BAR AUG A', 40, 'Dining'],
    ['2026-08-11', 'BAR AUG B', 25, 'Groceries'],
  ]) {
    r = await H.req('POST', `/api/spending/cards/${barCardId}/transactions`, { date, merchant, type: 'charge', amount, category });
    H.check(`spending bar-click setup: ${merchant} row`, r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  }
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending bar-click browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardB = (rq) => new Promise((resolve, reject) => {
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
    const loginResB = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueB = loginResB.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserB = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserB.newPage();
      page.on('dialog', (d) => d.accept());
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardB({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueB, domain: 'ff.local', path: '/', httpOnly: true });
      const waitB = (ms) => new Promise((res2) => setTimeout(res2, ms));
      // Click a bar: resolve a non-zero bar segment's center in
      // CSS pixels, scroll the canvas into view, click it.
      const clickBar = async (chartKey, canvasSel, month) => {
        const pos = await page.evaluate((ck, cs, mo) => {
          const chart = window.__fmCharts[ck];
          const canvas = document.querySelector(cs);
          canvas.scrollIntoView();
          const idx = chart.data.labels.indexOf(mo);
          if (idx < 0) return null;
          for (let d = 0; d < chart.data.datasets.length; d++) {
            const ds = chart.data.datasets[d];
            const isBar = ds.type === 'bar' || (ds.type === undefined && chart.config.type === 'bar');
            if (!isBar) continue;
            const el = chart.getDatasetMeta(d).data[idx];
            if (!el) continue;
            const p = el.getProps(['x', 'y', 'base'], true);
            if (p.y === p.base) continue;
            const r = canvas.getBoundingClientRect();
            return { x: r.left + p.x, y: r.top + (p.y + p.base) / 2 };
          }
          return null;
        }, chartKey, canvasSel, month);
        if (!pos) return null;
        await waitB(200);
        await page.mouse.click(pos.x, pos.y);
        await waitB(800);
        return true;
      };
      const apiBar = (await H.req('GET', '/api/spending')).data;
      const augTotal = Math.round((apiBar.transactions || [])
        .filter((t) => String(t.date).slice(0, 7) === '2026-08')
        .reduce((s, t) => s + (t.kind === 'adjustment' ? Number(t.amount) : -Number(t.amount)), 0) * 100) / 100;
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitB(1200);
      const clickedAug = await clickBar('spend', '#spendChart', '2026-08');
      H.check('spending UI: the Aug bar resolves to a clickable segment', clickedAug === true, JSON.stringify({ clickedAug }));
      const afterAug = await page.evaluate(() => {
        const pager = document.querySelector('[data-spend-tx-pager="spending"]');
        const share = window.__fmCharts.spendShare;
        const hist = window.__fmCharts.spend;
        const activePreset = document.querySelector('#invRangeBtns-spending button.active');
        return {
          from: document.querySelector('#invRangeStart-spending').textContent.trim(),
          to: document.querySelector('#invRangeEnd-spending').textContent.trim(),
          pager: pager ? pager.querySelector('span').textContent.trim() : null,
          histLabels: hist ? [...hist.data.labels] : null,
          shareSum: share ? Math.round(share.data.datasets[0].data.reduce((s, v) => s + v, 0) * 100) / 100 : null,
          activePreset: activePreset ? activePreset.textContent.trim() : null,
        };
      });
      H.check('spending UI: clicking a history bar selects that month everywhere in sync',
        afterAug.from === 'Aug 2026' && afterAug.to === 'Aug 2026' && afterAug.pager === 'Aug 2026'
          && JSON.stringify(afterAug.histLabels) === JSON.stringify(['2026-08'])
          && Math.abs(afterAug.shareSum - augTotal) < 0.005 && afterAug.activePreset === null,
        JSON.stringify({ ...afterAug, augTotal }));
      // Clicking empty plot space above the bars changes nothing.
      await page.evaluate(() => {
        const chart = window.__fmCharts.spend;
        const canvas = document.querySelector('#spendChart');
        canvas.scrollIntoView();
        const area = chart.chartArea;
        const r = canvas.getBoundingClientRect();
        return { x: r.left + area.left + 5, y: r.top + area.top + 5 };
      }).then(async (pt) => { await waitB(200); await page.mouse.click(pt.x, pt.y); await waitB(600); });
      const afterEmpty = await page.evaluate(() => ({
        from: document.querySelector('#invRangeStart-spending').textContent.trim(),
        to: document.querySelector('#invRangeEnd-spending').textContent.trim(),
      }));
      H.check('spending UI: clicking empty chart space leaves the range alone',
        afterEmpty.from === 'Aug 2026' && afterEmpty.to === 'Aug 2026', JSON.stringify(afterEmpty));
      // Detail chart: the same mechanism on the card's own page.
      await page.goto(`http://ff.local/#spending/card/${barCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitB(1200);
      const clickedOct = await clickBar('spendCard', '#spendDetailChart', '2026-10');
      H.check('spending UI: the detail Oct bar resolves to a clickable segment', clickedOct === true, JSON.stringify({ clickedOct }));
      const afterDet = await page.evaluate(() => {
        const pager = document.querySelector('[data-spend-tx-pager="spendCard"]');
        const hist = window.__fmCharts.spendCard;
        return {
          from: document.querySelector('#invRangeStart-spendCard').textContent.trim(),
          to: document.querySelector('#invRangeEnd-spendCard').textContent.trim(),
          pager: pager ? pager.querySelector('span').textContent.trim() : null,
          histLabels: hist ? [...hist.data.labels] : null,
        };
      });
      H.check('spending UI: clicking a detail history bar selects that month on the card page',
        afterDet.from === 'Oct 2026' && afterDet.to === 'Oct 2026' && afterDet.pager === 'Oct 2026'
          && JSON.stringify(afterDet.histLabels) === JSON.stringify(['2026-10']),
        JSON.stringify(afterDet));
    } finally { await browserB.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${barCardId}`);
  H.check('spending bar-click cleanup: card deleted', r.status === 200);

  // Detail stacked chart round: the card-detail history chart
  // stacks each month's bar by category (same convention as the
  // overall By-category chart), with the doughnut's colors and a
  // total line equal to the stack sums.
  r = await H.req('POST', '/api/spending/cards', { name: 'Stack', issuer: 'CIBC', last4: '7003' });
  H.check('spending stack setup: card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const stackCardId = r.data.id;
  for (const [date, merchant, amount, category] of [
    ['2026-10-05', 'STK DIN A', 50, 'Dining'],
    ['2026-10-06', 'STK DIN B', 30, 'Dining'],
    ['2026-10-07', 'STK GRO', 20, 'Groceries'],
    ['2026-08-10', 'STK AUG', 15, 'Dining'],
  ]) {
    r = await H.req('POST', `/api/spending/cards/${stackCardId}/transactions`, { date, merchant, type: 'charge', amount, category });
    H.check(`spending stack setup: ${merchant} row`, r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  }
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending stack browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardK = (rq) => new Promise((resolve, reject) => {
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
    const loginResK = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueK = loginResK.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserK = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserK.newPage();
      page.on('dialog', (d) => d.accept());
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardK({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueK, domain: 'ff.local', path: '/', httpOnly: true });
      const waitK = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#spending/card/${stackCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitK(1200);
      const stackState = await page.evaluate(() => {
        const hist = window.__fmCharts.spendCard;
        const dough = window.__fmCharts.spendCardShare;
        if (!hist || !dough) return null;
        const bars = hist.data.datasets.filter((d) => d.type === 'bar');
        const total = hist.data.datasets.find((d) => d.label === 'Total');
        const dLabels = [...dough.data.labels];
        const dColors = [...dough.data.datasets[0].backgroundColor];
        const at = (arr, label) => {
          const i = hist.data.labels.indexOf(label);
          return i < 0 ? null : arr[i];
        };
        const colorMatch = bars.every((b) => {
          const di = dLabels.indexOf(b.label);
          return di >= 0 && dColors[di] === b.backgroundColor;
        });
        const sumsMatch = hist.data.labels.every((_, i) => {
          const s = Math.round(bars.reduce((t, b) => t + (b.data[i] || 0), 0) * 100) / 100;
          return Math.abs(s - total.data[i]) < 0.005;
        });
        return {
          chartType: hist.config.type,
          barLabels: bars.map((b) => b.label),
          barStacked: bars.every((b) => b.stack === 'spend'),
          colorMatch,
          sumsMatch,
          oct: { dining: at(bars.find((b) => b.label === 'Dining').data, '2026-10'), gro: at(bars.find((b) => b.label === 'Groceries').data, '2026-10'), total: at(total.data, '2026-10') },
          aug: { dining: at(bars.find((b) => b.label === 'Dining').data, '2026-08'), gro: at(bars.find((b) => b.label === 'Groceries').data, '2026-08'), total: at(total.data, '2026-08') },
        };
      });
      H.check('spending UI: detail history stacks by category with the doughnut colors and a stack-sum total line',
        stackState && stackState.barLabels.join(',') === 'Dining,Groceries' && stackState.barStacked
          && stackState.colorMatch && stackState.sumsMatch
          && stackState.oct.dining === 80 && stackState.oct.gro === 20 && stackState.oct.total === 100
          && stackState.aug.dining === 15 && stackState.aug.gro === 0 && stackState.aug.total === 15,
        JSON.stringify(stackState));
    } finally { await browserK.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${stackCardId}`);
  H.check('spending stack cleanup: card deleted', r.status === 200);

  // UI unification round: the whole Spending section uses the
  // property/Stocks visual language — standard section-head
  // padding (overall + card detail), share-left chart row
  // proportions, breakdown-card figures, panel-wrapped tables,
  // and an empty history that hides instead of rendering
  // Chart.js's default $0/$1 axis ticks. Styling only: no data,
  // totals or flows change.
  r = await H.req('POST', '/api/spending/cards', { name: 'Uni', issuer: 'CIBC', last4: '3001' });
  H.check('spending unification setup: empty card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const uniCardId = r.data.id;
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending unification browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardU = (rq) => new Promise((resolve, reject) => {
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
    const loginResU = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueU = loginResU.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserU = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserU.newPage();
      page.on('dialog', (d) => d.accept());
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardU({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueU, domain: 'ff.local', path: '/', httpOnly: true });
      const waitU = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitU(1200);
      const uniOverall = await page.evaluate(() => {
        const head = document.querySelector('#spendList .section-head');
        const row = document.querySelector('#spendPanel .invest-charts-row');
        const shareCol = document.querySelector('#spendPanel .invest-share-col');
        const mainCol = document.querySelector('#spendPanel .invest-main-chart');
        const card = document.querySelector('#spendCardList .breakdown-card');
        // List cards with no balance render no figure (current
        // balance only), so the figure style is pinned via the
        // shared .breakdown-card .v rule instead of a rendered card.
        const vRule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
          .find((r) => r.selectorText && r.selectorText.split(',').map((x) => x.trim()).includes('.breakdown-card .v'));
        return {
          headPad: head ? getComputedStyle(head).padding : null,
          rowGap: row ? getComputedStyle(row).gap : null,
          shareBasis: shareCol ? getComputedStyle(shareCol).flexBasis : null,
          mainBasis: mainCol ? getComputedStyle(mainCol).flexBasis : null,
          mainGrow: mainCol ? getComputedStyle(mainCol).flexGrow : null,
          txInPanel: !!document.querySelector('#spendTxTable').closest('.panel'),
          cardPad: card ? getComputedStyle(card).padding : null,
          vSize: vRule ? vRule.style.fontSize : null,
          vWeight: vRule ? vRule.style.fontWeight : null,
        };
      });
      H.check('spending UI: overall head padding, share-left proportions, card figures and panel-wrapped table match the Stocks standard',
        uniOverall.headPad === '16px 17px' && uniOverall.rowGap === '18px'
        && uniOverall.shareBasis === '300px' && uniOverall.mainBasis === '430px' && uniOverall.mainGrow === '1'
        && uniOverall.txInPanel === true && uniOverall.cardPad === '16px'
        && uniOverall.vSize === '21px' && uniOverall.vWeight === '650',
        JSON.stringify(uniOverall));
      await page.goto(`http://ff.local/#spending/card/${uniCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitU(1200);
      const uniDetailEmpty = await page.evaluate(() => {
        const head = document.querySelector('#spendCardDetail .section-head');
        const h2 = document.querySelector('#spendDetailTitle');
        const panel = document.querySelector('#spendDetailPanel');
        const backBtn = document.querySelector('#spendBackBtn');
        const wrap = document.querySelector('#spendDetailMainWrap .chart-wrap');
        const note = document.querySelector('#spendDetailHistEmpty');
        const shareNote = document.querySelector('#spendDetailShareEmpty');
        return {
          headPad: head ? getComputedStyle(head).padding : null,
          h2MarginTop: h2 ? getComputedStyle(h2).marginTop : null,
          headFirstLeftDelta: (backBtn && panel) ? Math.round(backBtn.getBoundingClientRect().left - (panel.getBoundingClientRect().left + 17)) : null,
          detailTxInPanel: !!document.querySelector('#spendDetailTxTable').closest('.panel'),
          histWrapHidden: wrap ? wrap.classList.contains('hidden') : null,
          histNoteVisible: note ? !note.classList.contains('hidden') : null,
          histChartNull: window.__fmCharts ? window.__fmCharts.spendCard === null : null,
          shareNoteVisible: shareNote ? !shareNote.classList.contains('hidden') : null,
        };
      });
      H.check('spending UI: detail head matches the overall head, table in a panel, empty history hides with a note and no chart',
        uniDetailEmpty.headPad === '16px 17px' && uniDetailEmpty.h2MarginTop === '0px'
        && uniDetailEmpty.headFirstLeftDelta === 0 && uniDetailEmpty.detailTxInPanel === true
        && uniDetailEmpty.histWrapHidden === true && uniDetailEmpty.histNoteVisible === true
        && uniDetailEmpty.histChartNull === true && uniDetailEmpty.shareNoteVisible === true,
        JSON.stringify(uniDetailEmpty));
      // One charge restores the history chart (the empty branch
      // must not break normal rendering).
      r = await H.req('POST', `/api/spending/cards/${uniCardId}/transactions`, { date: '2026-10-15', merchant: 'UNI SHOP', type: 'charge', amount: 25, category: 'Shopping' });
      H.check('spending unification setup: charge added', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      // The page is already on this card's hash, and a goto to the
      // already-current hash is a no-op in Puppeteer — reload so
      // the detail view re-fetches with the new charge.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await waitU(1200);
      const uniDetailFull = await page.evaluate(() => {
        const wrap = document.querySelector('#spendDetailMainWrap .chart-wrap');
        const note = document.querySelector('#spendDetailHistEmpty');
        return {
          histWrapHidden: wrap ? wrap.classList.contains('hidden') : null,
          histNoteVisible: note ? !note.classList.contains('hidden') : null,
          histChartLive: !!(window.__fmCharts && window.__fmCharts.spendCard),
        };
      });
      H.check('spending UI: one charge restores the detail history chart',
        uniDetailFull.histWrapHidden === false && uniDetailFull.histNoteVisible === false && uniDetailFull.histChartLive === true,
        JSON.stringify(uniDetailFull));
    } finally { await browserU.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${uniCardId}`);
  H.check('spending unification cleanup: card deleted', r.status === 200);

  // Card fields round: credit limit, file balance + balance check
  // with adjustment, type-aware kinds, file-upload import, Fill
  // placement, danger Delete. Synthetic QFX only — the shape
  // mirrors a real CIBC file (LEDGERBAL -309.85, DTASOF
  // 2026-10-30) without using it.
  r = await H.req('POST', '/api/spending/cards', { name: 'Limit', issuer: 'RBC', last4: '1111', credit_limit: 5000 });
  H.check('spending: card created with a credit limit', r.status === 201 && r.data.credit_limit === 5000, JSON.stringify(r.data));
  const limCardId = r.data.id;
  r = await H.req('PUT', `/api/spending/cards/${limCardId}`, { name: 'Limit', issuer: 'RBC', last4: '1111', credit_limit: 7500 });
  H.check('spending: credit limit edits', r.status === 200 && r.data.credit_limit === 7500, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/spending/cards/${limCardId}`, { name: 'Limit', issuer: 'RBC', last4: '1111', credit_limit: null });
  H.check('spending: blank credit limit clears to null', r.status === 200 && r.data.credit_limit === null, JSON.stringify(r.data));
  r = await H.req('POST', '/api/spending/cards', { name: 'Bad', issuer: 'RBC', last4: '2222', credit_limit: -100 });
  H.check('spending: a negative credit limit is rejected', r.status === 400 && /positive/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await H.req('POST', '/api/spending/cards', { name: 'Plain', issuer: 'RBC', last4: '3333' });
  H.check('spending: a card without a limit stores null', r.status === 201 && r.data.credit_limit === null, JSON.stringify(r.data));
  const plainCardId = r.data.id;
  r = await H.req('POST', '/api/spending/cards', { name: 'CIBC', issuer: 'CIBC', last4: '9586', credit_limit: 5000 });
  H.check('spending: balance-check card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const balCardId = r.data.id;
  const balQfx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CCACCTFROM><ACCTID>9999888877776666</ACCTID></CCACCTFROM>`
    + `<LEDGERBAL><BALAMT>-309.85</BALAMT><DTASOF>20261030125401</DTASOF></LEDGERBAL><BANKTRANLIST>`
    + `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>CB1</FITID><NAME>WHOLE FOODS</NAME></STMTTRN>`
    + `<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261006</DTPOSTED><TRNAMT>40.00</TRNAMT><FITID>CB2</FITID><NAME>PAYMENT - THANK YOU</NAME></STMTTRN>`
    + `<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261007</DTPOSTED><TRNAMT>25.00</TRNAMT><FITID>CB3</FITID><NAME>AMAZON</NAME></STMTTRN>`
    + `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  r = await H.req('POST', `/api/spending/cards/${balCardId}/import-qfx/parse`, { qfxText: balQfx });
  H.check('spending: parse reads the file balance and type-aware kinds',
    r.status === 200 && r.data.balance && r.data.balance.owed === 309.85 && r.data.balance.asof === '2026-10-30'
    && r.data.rows.map((x) => x.kind).join(',') === 'charge,payment,refund', JSON.stringify(r.data));
  H.check('spending: balance check shows both figures, difference and the reconciling adjustment',
    r.status === 200 && r.data.balanceCheck && r.data.balanceCheck.fileOwed === 309.85 && r.data.balanceCheck.computedOwed === 35
    && r.data.balanceCheck.difference === 274.85 && r.data.balanceCheck.adjustmentAmount === -274.85,
    JSON.stringify(r.data.balanceCheck));
  const balParsedRows = r.data.rows;
  const balCheck = r.data.balanceCheck;
  r = await H.req('POST', `/api/spending/cards/${balCardId}/import-qfx/apply`, {
    rows: balParsedRows, fileOwed: balCheck.fileOwed, balanceAsof: balCheck.asof, includeAdjustment: true,
  });
  H.check('spending: apply writes the rows plus exactly one adjustment and refreshes the balance',
    r.status === 201 && r.data.inserted === 3 && r.data.adjustment && r.data.adjustment.amount === -274.85
    && r.data.balance && r.data.balance.owed === 309.85 && r.data.balance.asof === '2026-10-30', JSON.stringify(r.data));
  r = await H.req('GET', `/api/spending/cards/${balCardId}`);
  const balTx = r.data.transactions || [];
  const balAdj = balTx.find((t) => t.kind === 'adjustment');
  const balOwed = Math.round(-balTx.reduce((n, t) => n + Number(t.amount), 0) * 100) / 100;
  H.check('spending: adjustment reconciles the balance while spending totals exclude it',
    r.status === 200 && r.data.card.totalSpent === 100 && r.data.card.balance_owed === 309.85 && r.data.card.balance_asof === '2026-10-30'
    && !!balAdj && balAdj.amount === -274.85 && balOwed === 309.85,
    JSON.stringify({ totalSpent: r.data.card.totalSpent, owed: r.data.card.balance_owed, adj: balAdj, recomputed: balOwed }));
  r = await H.req('POST', `/api/spending/cards/${balCardId}/import-qfx/parse`, { qfxText: balQfx });
  H.check('spending: re-parse after reconciliation shows no difference',
    r.status === 200 && r.data.balanceCheck && r.data.balanceCheck.difference === 0, JSON.stringify(r.data.balanceCheck));
  r = await H.req('POST', '/api/spending/cards', { name: 'NoAdj', issuer: 'CIBC', last4: '4444' });
  H.check('spending: no-adjustment card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const noAdjCardId = r.data.id;
  r = await H.req('POST', `/api/spending/cards/${noAdjCardId}/import-qfx/parse`, { qfxText: balQfx });
  const noAdjParsed = r.data.rows;
  const noAdjCheck = r.data.balanceCheck;
  r = await H.req('POST', `/api/spending/cards/${noAdjCardId}/import-qfx/apply`, {
    rows: noAdjParsed, fileOwed: noAdjCheck.fileOwed, balanceAsof: noAdjCheck.asof, includeAdjustment: false,
  });
  H.check('spending: declining the adjustment still refreshes the balance and writes no adjustment row',
    r.status === 201 && r.data.adjustment === null && r.data.balance && r.data.balance.owed === 309.85, JSON.stringify(r.data));
  r = await H.req('GET', `/api/spending/cards/${noAdjCardId}`);
  H.check('spending: declined-adjustment card has no adjustment row',
    !(r.data.transactions || []).some((t) => t.kind === 'adjustment') && r.data.card.balance_owed === 309.85,
    JSON.stringify(r.data.transactions.map((t) => t.kind)));
  r = await H.req('POST', `/api/spending/cards/${noAdjCardId}/transactions`, { date: '2026-10-08', merchant: 'SHOP', type: 'payment', amount: 50, category: '' });
  H.check('spending: manual payment stores kind payment', r.status === 201 && r.data.kind === 'payment', JSON.stringify(r.data));
  r = await H.req('POST', `/api/spending/cards/${noAdjCardId}/transactions`, { date: '2026-10-09', merchant: 'SHOP', type: 'charge', amount: 10, category: '' });
  H.check('spending: manual charge stores kind charge', r.status === 201 && r.data.kind === 'charge', JSON.stringify(r.data));

  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('spending card-fields browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardF = (rq) => new Promise((resolve, reject) => {
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
    const loginResF = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueF = loginResF.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserF = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserF.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardF({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueF, domain: 'ff.local', path: '/', httpOnly: true });
      const waitF = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#spending/card/${balCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1200);
      const balUi = await page.evaluate(() => {
        const info = document.querySelector('#spendDetailCardInfo');
        const fillBtn = document.querySelector('#spendFillToggleBtn');
        const importBtn = document.querySelector('#spendDetailImportBtn');
        const panel = document.querySelector('#spendFillPanel');
        const delBtn = document.querySelector('#spendDetailDeleteBtn');
        return {
          info: info ? info.textContent : null,
          fillPresent: !!fillBtn, fillVisible: !!fillBtn && fillBtn.getBoundingClientRect().height > 0,
          sameHead: !!fillBtn && !!importBtn && fillBtn.closest('.section-head') === importBtn.closest('.section-head'),
          panelCollapsedBefore: !!panel && !panel.classList.contains('fill-open') && panel.getBoundingClientRect().height === 0,
          delDanger: !!delBtn && delBtn.classList.contains('danger'),
        };
      });
      H.check('spending UI: detail page shows limit + balance with as-of, Fill beside Import, danger Delete',
        balUi.info && balUi.info.includes('Credit limit $5,000.00') && balUi.info.includes('Balance owed $309.85') && balUi.info.includes('as of 2026-10-30')
        && balUi.fillPresent && balUi.fillVisible && balUi.sameHead && balUi.panelCollapsedBefore && balUi.delDanger,
        JSON.stringify(balUi));
      // Rearranged header: Back on its own line above; the title
      // shares its line with all four action buttons on the right;
      // the Balance owed figure is bold and larger, as-of small.
      const detHeadLayout = await page.evaluate(() => {
        const back = document.querySelector('#spendBackBtn');
        const title = document.querySelector('#spendDetailTitle');
        const center = (el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
        const btns = ['#spendFillToggleBtn', '#spendDetailImportBtn', '#spendDetailEditBtn', '#spendDetailDeleteBtn']
          .map((id) => document.querySelector(id));
        const fig = document.querySelector('#spendDetailCardInfo .spend-balance-figure');
        const asof = document.querySelector('#spendDetailCardInfo .spend-balance-asof');
        const figStyle = fig ? getComputedStyle(fig) : null;
        const asofStyle = asof ? getComputedStyle(asof) : null;
        return {
          backTop: back ? Math.round(back.getBoundingClientRect().top) : null,
          titleTop: title ? Math.round(title.getBoundingClientRect().top) : null,
          titleCenter: title ? Math.round(center(title)) : null,
          btnCenters: btns.map((b) => b ? Math.round(center(b)) : null),
          figWeight: figStyle ? figStyle.fontWeight : null,
          figSize: figStyle ? figStyle.fontSize : null,
          asofSize: asofStyle ? asofStyle.fontSize : null,
        };
      });
      H.check('spending UI: detail header has Back above, title with four buttons on one line, bold enlarged balance figure',
        detHeadLayout.backTop !== null && detHeadLayout.titleTop !== null && detHeadLayout.backTop < detHeadLayout.titleTop
          && detHeadLayout.btnCenters.every((c) => c !== null && Math.abs(c - detHeadLayout.titleCenter) <= 6)
          && Number(detHeadLayout.figWeight) >= 700 && detHeadLayout.figSize === '18px' && detHeadLayout.asofSize === '12px',
        JSON.stringify(detHeadLayout));
      // The Fill panel now sits ABOVE the Spending-over-time panel,
      // so opening it pushes both that panel and the transactions
      // panel down; closing pulls both back.
      const fillBefore = await page.evaluate(() => {
        const fill = document.querySelector('#spendFillPanel');
        const detail = document.querySelector('#spendDetailPanel');
        const tx = document.querySelector('#spendDetailTxTable').closest('.panel');
        const top = (el) => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
        return {
          fillAboveDetail: !!(fill && detail) && (fill.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          detailTop: top(detail),
          txTop: top(tx),
        };
      });
      await page.click('#spendFillToggleBtn');
      await waitF(650);
      const fillOpen = await page.evaluate(() => {
        const panel = document.querySelector('#spendFillPanel');
        const detail = document.querySelector('#spendDetailPanel');
        const tx = document.querySelector('#spendDetailTxTable').closest('.panel');
        const top = (el) => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
        return {
          open: !!panel && panel.classList.contains('fill-open') && panel.getBoundingClientRect().height > 0,
          detailTop: top(detail),
          txTop: top(tx),
          hasPaste: !!document.querySelector('#spendFillText'),
          hasExtract: !!document.querySelector('#spendFillBtn'),
          hasProposals: !!document.querySelector('#spendFillProposals'),
        };
      });
      H.check('spending UI: clicking Fill with AI expands the Fill panel and pushes the detail and transactions panels down',
        fillBefore.fillAboveDetail && fillOpen.open && fillBefore.detailTop !== null && fillOpen.detailTop > fillBefore.detailTop
          && fillBefore.txTop !== null && fillOpen.txTop > fillBefore.txTop
          && fillOpen.hasPaste && fillOpen.hasExtract && fillOpen.hasProposals,
        JSON.stringify({ before: fillBefore, ...fillOpen }));
      await page.click('#spendFillToggleBtn');
      await waitF(650);
      const fillClosed = await page.evaluate(() => {
        const panel = document.querySelector('#spendFillPanel');
        const detail = document.querySelector('#spendDetailPanel');
        const tx = document.querySelector('#spendDetailTxTable').closest('.panel');
        const top = (el) => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
        return {
          closed: !!panel && !panel.classList.contains('fill-open') && panel.getBoundingClientRect().height === 0,
          detailTop: top(detail),
          txTop: top(tx),
        };
      });
      H.check('spending UI: closing Fill with AI collapses it to zero space and pulls the detail and transactions panels back',
        fillClosed.closed && fillClosed.detailTop === fillBefore.detailTop && fillClosed.txTop === fillBefore.txTop,
        JSON.stringify({ before: fillBefore, ...fillClosed }));
      await page.click('#spendDetailImportBtn');
      await waitF(300);
      const importUi = await page.evaluate(() => {
        const fileInput = document.querySelector('#spendImportFile');
        return { hasFile: !!fileInput && fileInput.type === 'file', hasTextarea: !!document.querySelector('#spendImportText') };
      });
      H.check('spending UI: import modal has a file input and no paste textarea',
        importUi.hasFile && !importUi.hasTextarea, JSON.stringify(importUi));
      await page.goto(`http://ff.local/#spending/card/${plainCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1200);
      const plainInfo = await page.evaluate(() => {
        const info = document.querySelector('#spendDetailCardInfo');
        return info ? info.textContent.trim() : null;
      });
      H.check('spending UI: a card with no limit and no balance shows no info line',
        plainInfo === '', JSON.stringify({ plainInfo }));
      // List cards show ONLY the current balance: the balance
      // card carries its figure + as-of and none of the removed
      // lines; the no-balance card shows its name only.
      await page.goto('http://ff.local/#spending', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1200);
      const listCards = await page.evaluate(() => {
        const find = (last4) => [...document.querySelectorAll('#spendCardList .breakdown-card')]
          .find((c) => c.textContent.includes(`••••${last4}`));
        const read = (c) => c ? {
          text: c.textContent.replace(/\s+/g, ' ').trim(),
          figure: c.querySelector('.v') ? c.querySelector('.v').textContent.trim() : null,
          note: c.querySelector('.n') ? c.querySelector('.n').textContent.trim() : null,
        } : null;
        return { bal: read(find('9586')), plain: read(find('3333')) };
      });
      H.check('spending UI: list cards show only the current balance, no spent/count/limit lines',
        listCards.bal && listCards.bal.figure === '$309.85' && listCards.bal.note === 'Current balance · as of 2026-10-30'
          && !listCards.bal.text.includes('transactions') && !listCards.bal.text.includes('Credit limit') && !listCards.bal.text.includes('Balance owed')
          && listCards.plain && listCards.plain.figure === null && listCards.plain.note === null,
        JSON.stringify(listCards));
      // Detail header: back is a plain property-style link and
      // Edit matches Fill/Import height and padding exactly.
      await page.goto(`http://ff.local/#spending/card/${balCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1200);
      const detHead = await page.evaluate(() => {
        const back = document.querySelector('#spendBackBtn');
        const ref = document.createElement('a');
        ref.textContent = 'ref';
        document.body.appendChild(ref);
        // Read the values BEFORE detaching: a live computed-style
        // object goes blank once its element leaves the document.
        const refStyle = getComputedStyle(ref);
        const refLinkStyle = { color: refStyle.color, deco: refStyle.textDecorationLine, size: refStyle.fontSize };
        const backStyle = back ? getComputedStyle(back) : null;
        document.body.removeChild(ref);
        const btn = (id) => document.querySelector(id);
        const dims = (el) => el ? {
          h: Math.round(el.getBoundingClientRect().height),
          pad: getComputedStyle(el).padding,
        } : null;
        return {
          backTag: back ? back.tagName : null,
          backText: back ? back.textContent.trim() : null,
          backHref: back ? back.getAttribute('href') : null,
          backClass: back ? back.className : null,
          backLinkStyle: backStyle ? {
            color: backStyle.color, deco: backStyle.textDecorationLine, size: backStyle.fontSize,
          } : null,
          refLinkStyle,
          edit: dims(btn('#spendDetailEditBtn')),
          fill: dims(btn('#spendFillToggleBtn')),
          imp: dims(btn('#spendDetailImportBtn')),
        };
      });
      H.check('spending UI: detail back is a plain link styled like any link, Edit/Fill/Import share height and padding',
        detHead.backTag === 'A' && detHead.backText === '← Back to Spending' && detHead.backHref === '#spending'
          && detHead.backClass === '' && JSON.stringify(detHead.backLinkStyle) === JSON.stringify(detHead.refLinkStyle)
          && detHead.edit && detHead.fill && detHead.imp
          && detHead.edit.h === detHead.fill.h && detHead.edit.h === detHead.imp.h
          && detHead.edit.pad === detHead.fill.pad && detHead.edit.pad === detHead.imp.pad,
        JSON.stringify(detHead));
      // The Import modal opened above is still up: a hash-only goto
      // never reloads the SPA, so its overlay would swallow this
      // click (and just close itself) instead of following the link.
      await page.keyboard.press('Escape');
      await waitF(300);
      await page.click('#spendBackBtn');
      try { await page.waitForFunction(() => location.hash === '#spending', { timeout: 5000 }); } catch {}
      const backNav = await page.evaluate(() => ({
        hash: location.hash,
        detailHidden: document.querySelector('#spendCardDetail').classList.contains('hidden'),
      }));
      H.check('spending UI: clicking the detail back link returns to the Spending list',
        backNav.hash === '#spending' && backNav.detailHidden === true, JSON.stringify(backNav));
    } finally { await browserF.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${limCardId}`);
  H.check('spending card-fields cleanup: limit card deleted', r.status === 200);
  r = await H.req('DELETE', `/api/spending/cards/${plainCardId}`);
  H.check('spending card-fields cleanup: plain card deleted', r.status === 200);
  r = await H.req('DELETE', `/api/spending/cards/${balCardId}`);
  H.check('spending card-fields cleanup: balance card deleted', r.status === 200);
  r = await H.req('DELETE', `/api/spending/cards/${noAdjCardId}`);
  H.check('spending card-fields cleanup: no-adjustment card deleted', r.status === 200);
  r = await H.req('GET', '/api/spending');
  H.check('spending card-fields cleanup leaves no cards', r.status === 200 && r.data.cards.length === 0);

  // Import preview pagination: a 140-row file renders one page
  // of new rows first; already-imported rows stay collapsed
  // behind a count + toggle. Synthetic QFX only.
  r = await H.req('POST', '/api/spending/cards', { name: 'Preview', issuer: 'CIBC', last4: '7777' });
  H.check('import preview: card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const prevCardId = r.data.id;
  const prevOldRow = (i) => `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>OLD${i}</FITID><NAME>OLD MERCHANT ${i}</NAME></STMTTRN>`;
  const prevOldQfx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CCACCTFROM><ACCTID>7777666655554444</ACCTID></CCACCTFROM><BANKTRANLIST>`
    + Array.from({ length: 110 }, (_, i) => prevOldRow(i + 1)).join('')
    + `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  r = await H.req('POST', `/api/spending/cards/${prevCardId}/import-qfx/parse`, { qfxText: prevOldQfx });
  H.check('import preview: first parse sees 110 rows', r.status === 200 && r.data.rows.length === 110, JSON.stringify({ n: r.data.rows && r.data.rows.length }));
  const prevOldParsed = r.data.rows;
  r = await H.req('POST', `/api/spending/cards/${prevCardId}/import-qfx/apply`, { rows: prevOldParsed });
  H.check('import preview: first apply inserts 110 rows', r.status === 201 && r.data.inserted === 110, JSON.stringify(r.data));
  const prevNewRows = Array.from({ length: 30 }, (_, i) =>
    `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261006</DTPOSTED><TRNAMT>-2.00</TRNAMT><FITID>NEW${i + 1}</FITID><NAME>NEW MERCHANT ${i + 1}</NAME></STMTTRN>`).join('');
  // Stored sum is -110, new sum is -60: file owed 170 matches
  // computed owed, so the balance line shows difference 0 and
  // no adjustment is proposed.
  const prevBigQfx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CCACCTFROM><ACCTID>7777666655554444</ACCTID></CCACCTFROM>`
    + `<LEDGERBAL><BALAMT>-170.00</BALAMT><DTASOF>20261030120000</DTASOF></LEDGERBAL><BANKTRANLIST>`
    + Array.from({ length: 110 }, (_, i) => prevOldRow(i + 1)).join('') + prevNewRows
    + `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const prevTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-prev-'));
  const prevTmpFile = path.join(prevTmpDir, 'big.qfx');
  fs.writeFileSync(prevTmpFile, prevBigQfx);

  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('import preview browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardP = (rq) => new Promise((resolve, reject) => {
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
    const loginResP = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueP = loginResP.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserP = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserP.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardP({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueP, domain: 'ff.local', path: '/', httpOnly: true });
      const waitP = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#spending/card/${prevCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(1200);
      await page.click('#spendDetailImportBtn');
      await waitP(300);
      const fileHandle = await page.$('#spendImportFile');
      await fileHandle.uploadFile(prevTmpFile);
      await page.click('#spendImportParseBtn');
      await waitP(1200);
      const prevUi = await page.evaluate(() => {
        const newRows = [...document.querySelectorAll('#spendImportNewRows tr')];
        const oldToggle = document.querySelector('#spendImportOldToggle');
        const preview = document.querySelector('#spendImportPreview');
        return {
          newCount: newRows.length,
          firstNewStatus: newRows[0] ? newRows[0].children[3].textContent.trim() : null,
          oldToggleText: oldToggle ? oldToggle.textContent.trim() : null,
          oldVisible: !!document.querySelector('#spendImportOldRows'),
          balanceLine: preview ? preview.textContent.includes('File balance') && preview.textContent.includes('Difference:') : false,
        };
      });
      H.check('import preview: one page of new rows first, old rows collapsed behind count + toggle',
        prevUi.newCount === 25 && prevUi.firstNewStatus === 'New' && prevUi.oldToggleText && prevUi.oldToggleText.includes('110') && !prevUi.oldVisible && prevUi.balanceLine,
        JSON.stringify(prevUi));
      await page.click('#spendImportNewNext');
      await waitP(300);
      const prevPage2 = await page.evaluate(() => [...document.querySelectorAll('#spendImportNewRows tr')].length);
      H.check('import preview: pager Next shows the second page of new rows', prevPage2 === 5, JSON.stringify({ prevPage2 }));
      await page.click('#spendImportOldToggle');
      await waitP(300);
      const prevOldCount = await page.evaluate(() => [...document.querySelectorAll('#spendImportOldRows tbody tr')].length);
      H.check('import preview: expanding shows one page of already-imported rows', prevOldCount === 25, JSON.stringify({ prevOldCount }));
      await page.click('#spendImportApplyBtn');
      await waitP(1200);
      const prevMsg = await page.evaluate(() => {
        const m = document.querySelector('#spendImportModalMsg');
        return m ? m.textContent.trim() : null;
      });
      H.check('import preview: Apply message reports 30 imported', prevMsg && prevMsg.includes('Imported 30 transactions'), JSON.stringify({ prevMsg }));
    } finally { await browserP.close(); }
  }
  r = await H.req('GET', `/api/spending/cards/${prevCardId}`);
  H.check('import preview: Apply imported exactly the 30 new rows', r.status === 200 && r.data.transactions.length === 140, JSON.stringify({ n: r.data.transactions && r.data.transactions.length }));
  r = await H.req('DELETE', `/api/spending/cards/${prevCardId}`);
  H.check('import preview cleanup: card deleted', r.status === 200);
  fs.rmSync(prevTmpDir, { recursive: true, force: true });

  // Transaction form Category combobox: one input + datalist holding
  // the presets plus categories already used; a custom name typed once
  // is offered next time. Synthetic data only.
  r = await H.req('POST', '/api/spending/cards', { name: 'Combo', issuer: 'CIBC', last4: '4242' });
  H.check('category combobox: card created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const comboCardId = r.data.id;
  r = await H.req('POST', `/api/spending/cards/${comboCardId}/transactions`, { date: '2026-10-19', merchant: 'PET STORE', type: 'charge', amount: 20, category: 'PetCareX' });
  H.check('category combobox: custom-category transaction created', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', '/api/spending');
  H.check('category combobox: API lists the used custom category', r.status === 200 && Array.isArray(r.data.categories) && r.data.categories.includes('PetCareX'), JSON.stringify({ categories: r.data.categories }));

  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('category combobox browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardP = (rq) => new Promise((resolve, reject) => {
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
    const loginResP = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueP = loginResP.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserP = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserP.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardP({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueP, domain: 'ff.local', path: '/', httpOnly: true });
      const waitP = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#spending/card/${comboCardId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(1200);
      await page.click('#spendDetailAddTxBtn');
      await waitP(300);
      const comboUi = await page.evaluate(() => {
        const input = document.querySelector('#spendTxForm input[name=category]');
        const opts = [...document.querySelectorAll('#spendCategoryList option')].map((o) => o.value);
        return {
          inputs: document.querySelectorAll('#spendTxForm input[name=category]').length,
          selects: document.querySelectorAll('#spendTxForm select[name=category]').length,
          listAttr: input ? input.getAttribute('list') : null,
          hasDining: opts.includes('Dining'),
          hasPetCareX: opts.includes('PetCareX'),
        };
      });
      H.check('category combobox: single input + datalist offers presets and the used custom category',
        comboUi.inputs === 1 && comboUi.selects === 0 && comboUi.listAttr === 'spendCategoryList' && comboUi.hasDining && comboUi.hasPetCareX,
        JSON.stringify(comboUi));
      await page.evaluate(() => { document.querySelector('#spendTxForm [name=date]').value = '2026-10-20'; });
      await page.type('#spendTxForm [name=merchant]', 'GARDEN SHOP');
      await page.select('#spendTxForm [name=type]', 'charge');
      await page.type('#spendTxForm [name=amount]', '12.34');
      await page.type('#spendTxForm [name=category]', 'GardenY');
      await page.click('#spendTxForm button[type=submit]');
      await waitP(1500);
      await page.click('#spendDetailAddTxBtn');
      await waitP(300);
      const comboUi2 = await page.evaluate(() => {
        const opts = [...document.querySelectorAll('#spendCategoryList option')].map((o) => o.value);
        return { hasGardenY: opts.includes('GardenY'), hasPetCareX: opts.includes('PetCareX') };
      });
      H.check('category combobox: a typed custom name is offered afterwards',
        comboUi2.hasGardenY && comboUi2.hasPetCareX, JSON.stringify(comboUi2));
      r = await H.req('GET', `/api/spending/cards/${comboCardId}`);
      const gardenTx = (r.data.transactions || []).find((t) => t.merchant === 'GARDEN SHOP');
      H.check('category combobox: UI-saved transaction stored with the custom category',
        !!gardenTx && gardenTx.category === 'GardenY', JSON.stringify(gardenTx));
      if (gardenTx) {
        await page.evaluate((id) => {
          const btn = document.querySelector(`button[onclick="spendEditTx(${id})"]`);
          if (btn) btn.click();
        }, gardenTx.id);
        await waitP(300);
        const editVal = await page.evaluate(() => {
          const input = document.querySelector('#spendTxForm input[name=category]');
          return input ? input.value : null;
        });
        H.check('category combobox: editing shows the stored category in the field', editVal === 'GardenY', JSON.stringify({ editVal }));
      }
    } finally { await browserP.close(); }
  }
  r = await H.req('DELETE', `/api/spending/cards/${comboCardId}`);
  H.check('category combobox cleanup: card deleted', r.status === 200);

  // ------------------------------------------------------------ planning ---
}

runModuleMain(import.meta.url, { name: 'spending', deps, depNames: [], run });
