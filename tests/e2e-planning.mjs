// planning: Planning: projects, strategies, merge, scenarios, comparison, reports, wiring — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-planning.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only planning]
// Slim mode: E2E_PLAN_SLIM=1 replaces the 14-module dep replay with the
// minimal fixture in tests/e2e-plan-fixture.mjs (same own-check
// coverage, no 1413-check replay). Default (unset) keeps the full chain.
import { runSlimPlanFixture } from './e2e-plan-fixture.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runModuleMain } from './e2e-child.mjs';
import { derivePayment } from '../src/engine.js';
import { run as runCore } from './e2e-core.mjs';
import { run as runCosts } from './e2e-costs.mjs';
import { run as runNollm } from './e2e-nollm.mjs';
import { run as runTerms } from './e2e-terms.mjs';
import { run as runPhotos } from './e2e-photos.mjs';
import { run as runUiProperty } from './e2e-ui-property.mjs';
import { run as runCostsNollm } from './e2e-costs-nollm.mjs';
import { run as runAssessments } from './e2e-assessments.mjs';
import { run as runChartColors } from './e2e-chart-colors.mjs';
import { run as runVeil } from './e2e-veil.mjs';
import { run as runInvestments } from './e2e-investments.mjs';
import { run as runCsvWizard } from './e2e-csv-wizard.mjs';
import { run as runEarnings } from './e2e-earnings.mjs';
import { run as runSpending } from './e2e-spending.mjs';
const SLIM_PLAN = process.env.E2E_PLAN_SLIM === '1';
export const deps = SLIM_PLAN ? [runSlimPlanFixture] : [runCore, runCosts, runNollm, runTerms, runPhotos, runUiProperty, runCostsNollm, runAssessments, runChartColors, runVeil, runInvestments, runCsvWizard, runEarnings, runSpending];
export async function run(H, S) {
  let r;
  // Project → strategy → prepay op → comparison → merge-preview →
  // merge → mainline lump sum present → revert → lump sum gone.
  // The op date is the first of next month (always >= current month).
  const _planNow = new Date();
  const _planNext = new Date(Date.UTC(_planNow.getUTCFullYear(), _planNow.getUTCMonth() + 1, 1));
  const planOpDate = _planNext.toISOString().slice(0, 10);
  r = await H.req('POST', '/api/planning/projects', { name: 'Pay down test', question: 'Prepay then hold' });
  H.check('planning: create project', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const planProjectId = r.data.project.id;
  r = await H.req('GET', `/api/planning/projects/${planProjectId}`);
  H.check('planning: new project carries no scenarios (baseline is do-nothing by construction)',
    r.status === 200 && Array.isArray(r.data.scenarios) && r.data.scenarios.length === 0,
    JSON.stringify(r.data.scenarios));
  r = await H.req('POST', `/api/planning/projects/${planProjectId}/strategies`, { name: 'Prepay 10k', source: 'template' });
  H.check('planning: create strategy', r.status === 201 && r.data.strategy && r.data.strategy.letter === 'A', JSON.stringify(r.data));
  const planStrategyId = r.data.strategy.id;
  // The section owns its property: earlier fixture properties are
  // deleted by their own cleanup sections, so reusing one would point
  // the op at a row that no longer exists.
  r = await H.req('POST', '/api/properties', {
    address: '77 Planning Test Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('planning: create test property', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const planPid = r.data.id;
  r = await H.req('POST', `/api/properties/${planPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('planning: add test rate segment', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: planPid, date: planOpDate, amount: 10000, openClosed: 'open' },
  });
  H.check('planning: add prepay op', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/strategies/${planStrategyId}`);
  H.check('planning: strategy comparison is cost-exact and saves interest',
    r.status === 200 && r.data.comparison && r.data.comparison.cost === 10000
    && r.data.comparison.penaltyTotal === 0 && r.data.comparison.interestSaved > 0
    && r.data.comparison.payoffShiftMonths > 0
    && Math.abs(r.data.comparison.net - (r.data.comparison.gain - r.data.comparison.cost)) < 0.011,
    JSON.stringify(r.data.comparison));
  H.check('planning: strategy detail carries no scenario table; with no scenarios the applied world is flat',
    Array.isArray(r.data.scenarioTable) && r.data.scenarioTable.length === 0 && r.data.baseScenario == null,
    JSON.stringify({ scenarioTable: r.data.scenarioTable, baseScenario: r.data.baseScenario }));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/merge-preview`, {});
  H.check('planning: merge preview lists a lump-sum insert and no conflicts',
    r.status === 200 && (r.data.writes || []).some((w) => w.kind === 'insert' && w.table === 'lump_sums')
    && (r.data.conflicts || []).length === 0,
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/merge`, { resolutions: [] });
  H.check('planning: merge succeeds', r.status === 200 && r.data.mergeRecordId > 0, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${planPid}`);
  H.check('planning: merged prepay is a mainline lump sum',
    r.status === 200 && (r.data.lumpSums || []).some((l) => l.amount === 10000 && l.date === planOpDate),
    JSON.stringify((r.data.lumpSums || []).map((l) => [l.amount, l.date])));
  r = await H.req('GET', `/api/planning/strategies/${planStrategyId}`);
  H.check('planning: strategy shows merged', r.data.strategy && r.data.strategy.merged === 1);
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/revert-preview`, {});
  H.check('planning: revert preview lists the lump-sum removal',
    r.status === 200 && (r.data.inverse || []).some((w) => w.kind === 'delete' && w.table === 'lump_sums'),
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/revert`, { resolutions: [] });
  H.check('planning: revert succeeds', r.status === 200 && r.data.revertRecordId > 0, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${planPid}`);
  H.check('planning: reverted prepay is gone from mainline',
    r.status === 200 && !(r.data.lumpSums || []).some((l) => l.amount === 10000 && l.date === planOpDate),
    JSON.stringify((r.data.lumpSums || []).map((l) => [l.amount, l.date])));
  r = await H.req('GET', `/api/planning/projects/${planProjectId}/history`);
  H.check('planning: history shows merge and revert',
    r.status === 200 && (r.data.history || []).some((m) => m.kind === 'merge')
    && (r.data.history || []).some((m) => m.kind === 'revert'),
    JSON.stringify((r.data.history || []).map((m) => m.kind)));
  // Validation pins: a buy without a price is rejected (use Position),
  // and a sell above holdings is rejected.
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ops`, {
    op_type: 'buy', params: { accountId: 1, date: planOpDate, units: 10 },
  });
  H.check('planning: buy without a price is rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ops`, {
    op_type: 'sell', params: { holdingId: 999999, date: planOpDate, units: 10 },
  });
  H.check('planning: sell of an unknown holding is rejected', r.status === 400, JSON.stringify(r.data));
  // Return suggestions: NAV points spanning 1y and 3y windows label
  // their actual coverage; the AI describe endpoint rejects empty text.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Plan Test TFSA', type: 'TFSA' });
  H.check('planning: create test account', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const planAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${planAcctId}/holdings`, { label: 'Plan ETF', kind: 'exchange', symbol: 'PLAN.TO', currency: 'CAD' });
  H.check('planning: create test holding', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const planHoldingId = r.data.id;
  const _ym = (y, m) => `${y}-${String(m).padStart(2, '0')}-15`;
  // Shift dates from the VANCOUVER month (the app's month), not UTC:
  // in the first hours of a UTC month the two disagree and the window
  // points would land a month off.
  const _van = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit' }).format(new Date());
  const _cy = Number(_van.slice(0, 4));
  const _cm = Number(_van.slice(5, 7));
  const _shift = (months) => {
    const total = _cy * 12 + (_cm - 1) - months;
    return _ym(Math.floor(total / 12), (total % 12) + 1);
  };
  r = await H.req('POST', `/api/investments/holdings/${planHoldingId}/nav`, { date: _shift(36), price: 40 });
  H.check('planning: 3y NAV point', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${planHoldingId}/nav`, { date: _shift(12), price: 50 });
  H.check('planning: 1y NAV point', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${planHoldingId}/nav`, { date: _shift(1), price: 60 });
  H.check('planning: recent NAV point', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/return-suggestions?holdingId=${planHoldingId}`);
  H.check('planning: return suggestions label actual 1y and 3y windows',
    r.status === 200 && (r.data.suggestions || []).some((x) => x.label === '1y')
    && (r.data.suggestions || []).some((x) => x.label === '3y'),
    JSON.stringify(r.data.suggestions));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ai-describe`, { text: '' });
  H.check('planning: ai-describe rejects empty text', r.status === 400, JSON.stringify(r.data));
  // ---- App-global History tab -------------------------------------------
  // A save creates exactly one commit; undo restores the prior state;
  // restore-to writes back a snapshot; a later touch blocks undo with
  // a dependency list; merge commits refuse restore-to and
  // merge-revert commits refuse undo; one bulk Fill Apply is exactly
  // one commit.
  const histCount = async () => (await H.req('GET', '/api/history/commits?limit=1')).data.total;
  let histBefore = await histCount();
  r = await H.req('POST', '/api/properties', {
    address: '77 History Lane, Coquitlam, BC',
    mortgage_balance: 50000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('history: create property', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const histPid = r.data.id;
  r = await H.req('GET', '/api/history/commits?limit=1');
  H.check('history: one save = one commit',
    r.status === 200 && r.data.total === histBefore + 1
    && r.data.commits[0].module === 'property'
    && r.data.commits[0].entity_label === '77 History Lane, Coquitlam, BC',
    JSON.stringify(r.data.commits[0]));
  r = await H.req('PUT', `/api/properties/${histPid}`, { assessed_value: 800000 });
  H.check('history: first assessed update', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', '/api/history/commits?limit=1');
  const histUpd1Id = r.data.commits[0].id;
  r = await H.req('PUT', `/api/properties/${histPid}`, { assessed_value: 900000 });
  H.check('history: second assessed update', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', '/api/history/commits?limit=1');
  const histUpd2Id = r.data.commits[0].id;
  r = await H.req('POST', `/api/history/commits/${histUpd1Id}/undo`, {});
  H.check('history: undo blocked by later touch, dependency named',
    r.status === 400 && Array.isArray(r.data.dependents)
    && r.data.dependents.some((d) => d.id === histUpd2Id),
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/history/commits/${histUpd2Id}/undo`, {});
  H.check('history: undo newest update', r.status === 200 && r.data.commitId > 0, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${histPid}`);
  H.check('history: undo restored prior assessed value',
    r.status === 200 && r.data.assessed_value === 800000, JSON.stringify(r.data.assessed_value));
  r = await H.req('PUT', `/api/properties/${histPid}`, { assessed_value: 950000 });
  H.check('history: third assessed update', r.status === 200, JSON.stringify(r.data));
  r = await H.req('POST', `/api/history/commits/${histUpd1Id}/restore`, {});
  H.check('history: restore-to first update', r.status === 200 && r.data.commitId > 0, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${histPid}`);
  H.check('history: restore-to rewrote the assessed value to the snapshot',
    r.status === 200 && r.data.assessed_value === 800000, JSON.stringify(r.data.assessed_value));
  r = await H.req('GET', '/api/history/commits?module=planning&q=Merged%20strategy&limit=5');
  const histMerge = (r.data.commits || []).find((c) => c.kind === 'merge');
  H.check('history: merge commit visible in the global tab', !!histMerge, JSON.stringify((r.data.commits || []).map((c) => c.kind)));
  if (histMerge) {
    r = await H.req('POST', `/api/history/commits/${histMerge.id}/restore`, {});
    H.check('history: merge commit refuses restore-to', r.status === 400, JSON.stringify(r.data));
  }
  r = await H.req('GET', '/api/history/commits?module=planning&q=Reverted%20merge&limit=5');
  const histMergeRevert = (r.data.commits || []).find((c) => c.kind === 'merge-revert');
  H.check('history: merge-revert commit visible in the global tab', !!histMergeRevert, JSON.stringify((r.data.commits || []).map((c) => c.kind)));
  if (histMergeRevert) {
    r = await H.req('POST', `/api/history/commits/${histMergeRevert.id}/undo`, {});
    H.check('history: merge-revert commit refuses undo', r.status === 400, JSON.stringify(r.data));
  }
  r = await H.req('POST', '/api/investments/accounts', { name: 'Hist TFSA', type: 'TFSA' });
  H.check('history: create fill account', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const histAcctId = r.data.id;
  histBefore = await histCount();
  r = await H.req('POST', `/api/investments/accounts/${histAcctId}/fill/apply`, {
    holdings: [{ ref: 'h1', label: 'Hist ETF', kind: 'exchange', symbol: 'HIST.TO', currency: 'CAD',
      events: [{ date: '2026-01-15', type: 'buy', units: 10, price: 50 }] }],
    events: [],
    nav: [{ holdingRef: 'h1', date: '2026-01-15', price: 52 }],
  });
  H.check('history: bulk Fill Apply succeeds', r.status === 201 && r.data.appliedHoldings === 1 && r.data.appliedNav === 1, JSON.stringify(r.data));
  r = await H.req('GET', '/api/history/commits?limit=1');
  H.check('history: one bulk Apply = exactly one commit',
    r.status === 200 && r.data.total === histBefore + 1 && r.data.commits[0].module === 'stocks',
    JSON.stringify(r.data.commits[0]));
  r = await H.req('DELETE', `/api/properties/${histPid}`);
  H.check('history: cleanup delete property', r.status === 200, JSON.stringify(r.data));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('history browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardH = (rq) => new Promise((resolve, reject) => {
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
    const loginResH = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueH = loginResH.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserH = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserH.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardH({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueH, domain: 'ff.local', path: '/', httpOnly: true });
      const waitH = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#planning/project/${planProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitH(1500);
      const noPanel = await page.evaluate(() => !document.querySelector('#planHistoryList'));
      H.check('history: per-project History panel is gone', noPanel === true);
      await page.goto('http://ff.local/#history', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitH(1500);
      const tabOk = await page.evaluate(() => {
        const v = document.querySelector('#view-history');
        const list = document.querySelector('#histList');
        return v && !v.classList.contains('hidden') && list && list.textContent.includes('Hist TFSA');
      });
      H.check('history: History tab renders the commit list', tabOk === true);
    } finally {
      await browserH.close();
    }
  }
  // Template-first project creation (DOM): chooser with five templates,
  // per-template intake fields, prefilled question, blank path as before.
  // Runs before cleanup so the test property (mortgaged) is still there.
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('planning template-flow browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardT = (rq) => new Promise((resolve, reject) => {
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
    const loginResT = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueT = loginResT.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserT = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserT.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardT({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueT, domain: 'ff.local', path: '/', httpOnly: true });
      const waitT = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitT(1200);
      await page.click('#planAddProjectBtn');
      await waitT(300);
      const cats = await page.evaluate(() => {
        const m = document.querySelector('#planCategoryModal');
        return {
          open: m && !m.classList.contains('hidden'),
          categories: [...document.querySelectorAll('#planCategoryCards [data-plan-cat]')].map((el) => el.dataset.planCat),
        };
      });
      H.check('planning category picker renders all five big categories',
        cats.open && JSON.stringify(cats.categories) === JSON.stringify(['property', 'investment', 'earning', 'saving', 'tax_saving']),
        JSON.stringify(cats));
      // Big category → data entity → subcategory's optimal.
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="property"]').click(); });
      await waitT(800);
      const entityStep = await page.evaluate(() => ({
        hasSelect: !!document.querySelector('#planCatEntitySel'),
        options: [...document.querySelectorAll('#planCatEntitySel option')].map((o) => o.textContent),
      }));
      H.check('planning property category shows a property picker',
        entityStep.hasSelect && entityStep.options.some((o) => o.includes('77 Planning Test Lane')),
        JSON.stringify(entityStep));
      await page.evaluate(() => {
        const sel = document.querySelector('#planCatEntitySel');
        const opt = [...sel.options].find((o) => o.textContent.includes('77 Planning Test Lane'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await waitT(800);
      const subs = await page.evaluate(() => [...document.querySelectorAll('#planCategorySubs [data-plan-sub]')].map((el) => ({
        key: el.dataset.planSub, text: el.textContent,
      })));
      H.check('planning subcategory cards show recommended baseline + strategy for the picked property',
        subs.some((x) => x.key === 'interest_rate' && x.text.includes('Baseline:') && x.text.includes('Strategy:'))
          && subs.some((x) => x.key === 'refinance' && x.text.includes('Baseline:') && x.text.includes('Strategy:')),
        JSON.stringify(subs));
      await page.evaluate(() => { document.querySelector('#planCategorySubs [data-plan-sub="refinance"]').click(); });
      await waitT(800);
      const intake = await page.evaluate(() => ({
        modalOpen: !document.querySelector('#planProjectModal').classList.contains('hidden'),
        catNote: document.querySelector('#planProjectCategoryNote') ? document.querySelector('#planProjectCategoryNote').textContent : '',
        catBtnsVisible: !document.querySelector('#planProjectCategoryBtns').classList.contains('hidden'),
        saveLabel: document.querySelector('#planProjectSaveBtn').textContent,
        question: document.querySelector('#planProjectForm [name=question]').value,
      }));
      H.check('planning category intake shows the recommendation, Apply + AI + Create-without',
        intake.modalOpen && intake.catBtnsVisible && intake.saveLabel === 'Create without'
          && intake.catNote.includes('property') && intake.catNote.includes('refinance')
          && intake.catNote.includes('Baseline:') && intake.catNote.includes('Strategy:')
          && intake.question.length > 0,
        JSON.stringify(intake));
      await page.type('#planProjectForm [name=name]', 'Category Flow Test');
      await page.click('#planProjectApplyRecBtn');
      try { await page.waitForFunction(() => location.hash.startsWith('#planning/project/'), { timeout: 5000 }); } catch {}
      await waitT(1500);
      const landed = await page.evaluate(() => {
        const panelTitles = [...document.querySelectorAll('.panel .section-head h3')].map((el) => el.textContent);
        const baseCards = [...document.querySelectorAll('#planBaselineCards [data-plan-baseline]')].map((el) => ({
          name: el.textContent,
          edit: !!el.querySelector('[data-plan-baseline-edit]'),
          ai: !!el.querySelector('[data-plan-baseline-ai]'),
          del: !!el.querySelector('[data-plan-baseline-del]'),
        }));
        const stratCards = [...document.querySelectorAll('#planStrategyCards [data-plan-strategy]')].map((el) => ({
          text: el.textContent,
          edit: !!el.querySelector('[data-plan-strategy-edit]'),
          del: !!el.querySelector('[data-plan-strategy-del]'),
        }));
        return {
          hash: location.hash,
          headerTitle: document.querySelector('#planProjectHeader h3') ? document.querySelector('#planProjectHeader h3').textContent : '',
          panelTitles,
          catLine: document.querySelector('#planProjectCategoryLine') ? document.querySelector('#planProjectCategoryLine').textContent : '',
          baseCards, stratCards,
        };
      });
      H.check('planning detail title is an inline header row, not a standalone card',
        landed.hash.startsWith('#planning/project/') && landed.headerTitle === 'Category Flow Test'
          && !landed.panelTitles.includes('Category Flow Test'),
        JSON.stringify({ headerTitle: landed.headerTitle, panelTitles: landed.panelTitles }));
      H.check('planning detail shows the category as read-only metadata',
        landed.catLine.includes('Property') && landed.catLine.includes('Refinance') && landed.catLine.includes('77 Planning Test Lane'),
        JSON.stringify({ catLine: landed.catLine }));
      H.check('planning applied recommendation renders baseline cards with Edit/Delete and strategy cards as click-to-navigate only (no card toolbar)',
        landed.baseCards.length === 1 && landed.baseCards[0].edit && !landed.baseCards[0].ai && landed.baseCards[0].del
          && landed.stratCards.length === 1 && !landed.stratCards[0].edit && !landed.stratCards[0].del,
        JSON.stringify({ baseCards: landed.baseCards, stratCards: landed.stratCards }));
      const catProjectId = landed.hash.split('/').pop();
      // Edit modal carries no category control, and PUT rejects a change.
      await page.evaluate(() => { document.querySelector('#planProjectEditBtn').click(); });
      await waitT(500);
      const editModal = await page.evaluate(() => ({
        open: !document.querySelector('#planProjectModal').classList.contains('hidden'),
        catRowHidden: document.querySelector('#planProjectCategoryRow').classList.contains('hidden'),
        catBtnsHidden: document.querySelector('#planProjectCategoryBtns').classList.contains('hidden'),
        saveLabel: document.querySelector('#planProjectSaveBtn').textContent,
      }));
      H.check('planning edit modal has no category control',
        editModal.open && editModal.catRowHidden && editModal.catBtnsHidden && editModal.saveLabel === 'Save',
        JSON.stringify(editModal));
      await page.evaluate(() => { document.querySelector('#planProjectModal [data-close-modal]').click(); });
      await waitT(300);
      r = await H.req('PUT', `/api/planning/projects/${catProjectId}`, { name: 'Category Flow Test', category: 'investment' });
      H.check('planning PUT changing the category returns 400',
        r.status === 400 && String(r.data.error || '').includes('cannot be changed'), JSON.stringify(r.data));
      // Create-without: same flow, no recommendation applied.
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitT(1000);
      await page.click('#planAddProjectBtn');
      await waitT(300);
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="property"]').click(); });
      await waitT(800);
      await page.evaluate(() => {
        const sel = document.querySelector('#planCatEntitySel');
        const opt = [...sel.options].find((o) => o.textContent.includes('77 Planning Test Lane'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await waitT(800);
      await page.evaluate(() => { document.querySelector('#planCategorySubs [data-plan-sub="interest_rate"]').click(); });
      await waitT(800);
      await page.type('#planProjectForm [name=name]', 'Category Bare Test');
      await page.click('#planProjectSaveBtn');
      try { await page.waitForFunction(() => location.hash.startsWith('#planning/project/'), { timeout: 5000 }); } catch {}
      await waitT(1500);
      const bareLanded = await page.evaluate(() => ({ hash: location.hash }));
      H.check('planning create-without lands on a project page',
        bareLanded.hash.startsWith('#planning/project/') && bareLanded.hash !== landed.hash,
        JSON.stringify(bareLanded));
      const bareProjectId = bareLanded.hash.split('/').pop();
      r = await H.req('GET', `/api/planning/projects/${bareProjectId}`);
      H.check('planning create-without starts with no baseline and no strategy',
        (r.data.project.baselines || []).length === 0 && (r.data.strategies || []).length === 0,
        JSON.stringify({ baselines: (r.data.project.baselines || []).length, strategies: (r.data.strategies || []).length }));
      // Scope categories (saving / tax_saving): no property dropdown
      // may appear, survive a switch, or arrive late — and creation
      // completes through recommendations with the scope entity.
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitT(1000);
      await page.click('#planAddProjectBtn');
      await waitT(300);
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="saving"]').click(); });
      await waitT(800);
      const savingFirst = await page.evaluate(() => ({
        hasSelect: !!document.querySelector('#planCatEntitySel'),
        scopeNote: document.querySelector('#planCategoryEntity')?.textContent || '',
        hasGo: !!document.querySelector('#planCatEntityGo'),
      }));
      H.check('planning saving-first shows the scope picker with no property select',
        !savingFirst.hasSelect && savingFirst.hasGo && savingFirst.scopeNote.includes('all spending'),
        JSON.stringify(savingFirst));
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="property"]').click(); });
      await waitT(800);
      const propShown = await page.evaluate(() => !!document.querySelector('#planCatEntitySel'));
      H.check('planning property picker renders before the switch (pin setup)',
        propShown, JSON.stringify({ propShown }));
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="saving"]').click(); });
      await waitT(800);
      const afterSwitch = await page.evaluate(() => ({
        hasSelect: !!document.querySelector('#planCatEntitySel'),
        hasGo: !!document.querySelector('#planCatEntityGo'),
      }));
      H.check('planning property → saving switch shows no property select (scope picker instead)',
        !afterSwitch.hasSelect && afterSwitch.hasGo, JSON.stringify(afterSwitch));
      await page.evaluate(() => {
        document.querySelector('#planCategoryCards [data-plan-cat="property"]').click();
        document.querySelector('#planCategoryCards [data-plan-cat="saving"]').click();
      });
      await waitT(1200);
      const rapidSettled = await page.evaluate(() => ({
        hasSelect: !!document.querySelector('#planCatEntitySel'),
        hasGo: !!document.querySelector('#planCatEntityGo'),
      }));
      H.check('planning rapid property → saving switch settles with no property select',
        !rapidSettled.hasSelect && rapidSettled.hasGo, JSON.stringify(rapidSettled));
      await page.evaluate(() => { document.querySelector('#planCatEntityGo').click(); });
      await waitT(800);
      const savingSubs = await page.evaluate(() => [...document.querySelectorAll('#planCategorySubs [data-plan-sub]')].map((el) => el.dataset.planSub));
      H.check('planning saving recommendations render the spending_analysis subcategory',
        savingSubs.includes('spending_analysis'), JSON.stringify(savingSubs));
      await page.evaluate(() => { document.querySelector('#planCategorySubs [data-plan-sub="spending_analysis"]').click(); });
      await waitT(800);
      await page.type('#planProjectForm [name=name]', 'Saving Scope Test');
      await page.click('#planProjectSaveBtn');
      try { await page.waitForFunction(() => location.hash.startsWith('#planning/project/'), { timeout: 5000 }); } catch {}
      await waitT(1500);
      const savingLanded = await page.evaluate(() => ({
        hash: location.hash,
        catLine: document.querySelector('#planProjectCategoryLine') ? document.querySelector('#planProjectCategoryLine').textContent : '',
      }));
      H.check('planning saving creation lands on a project page with the scope category',
        savingLanded.hash.startsWith('#planning/project/') && savingLanded.catLine.includes('Saving'),
        JSON.stringify(savingLanded));
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitT(1000);
      await page.click('#planAddProjectBtn');
      await waitT(300);
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="tax_saving"]').click(); });
      await waitT(800);
      const taxFirst = await page.evaluate(() => ({
        hasSelect: !!document.querySelector('#planCatEntitySel'),
        scopeNote: document.querySelector('#planCategoryEntity')?.textContent || '',
        hasGo: !!document.querySelector('#planCatEntityGo'),
      }));
      H.check('planning tax_saving shows the all-earnings scope picker with no property select',
        !taxFirst.hasSelect && taxFirst.hasGo && taxFirst.scopeNote.includes('all earnings'),
        JSON.stringify(taxFirst));
      await page.evaluate(() => { document.querySelector('#planCatEntityGo').click(); });
      await waitT(800);
      const taxSubs = await page.evaluate(() => [...document.querySelectorAll('#planCategorySubs [data-plan-sub]')].map((el) => el.dataset.planSub));
      H.check('planning tax_saving recommendations render the tax_analysis subcategory',
        taxSubs.includes('tax_analysis'), JSON.stringify(taxSubs));
      await page.evaluate(() => { document.querySelector('#planCategorySubs [data-plan-sub="tax_analysis"]').click(); });
      await waitT(800);
      await page.type('#planProjectForm [name=name]', 'Tax Scope Test');
      await page.click('#planProjectSaveBtn');
      try { await page.waitForFunction(() => location.hash.startsWith('#planning/project/'), { timeout: 5000 }); } catch {}
      await waitT(1500);
      const taxLanded = await page.evaluate(() => ({ hash: location.hash }));
      H.check('planning tax_saving creation lands on a project page',
        taxLanded.hash.startsWith('#planning/project/') && taxLanded.hash !== savingLanded.hash,
        JSON.stringify(taxLanded));
      // Different entity → different recommendation figures (API-level).
      r = await H.req('POST', '/api/properties', { address: '1 Cat Entity Way', purchase_date: '2024-01-15', mortgage_balance: 500000 });
      const entA = r.data.id || (r.data.property && r.data.property.id);
      r = await H.req('POST', '/api/properties', { address: '2 Cat Entity Way', purchase_date: '2024-01-15', mortgage_balance: 900000 });
      const entB = r.data.id || (r.data.property && r.data.property.id);
      const recA = await H.req('POST', '/api/planning/recommendations', { category: 'property', entity: { type: 'property', propertyId: entA } });
      const recB = await H.req('POST', '/api/planning/recommendations', { category: 'property', entity: { type: 'property', propertyId: entB } });
      H.check('planning recommendation references the picked entity (different entity, different figures)',
        entA && entB && recA.data.recommendations.refinance.baseline.figures.balance === 500000
          && recB.data.recommendations.refinance.baseline.figures.balance === 900000,
        JSON.stringify({ a: recA.data.recommendations?.refinance?.baseline?.figures, b: recB.data.recommendations?.refinance?.baseline?.figures }));
      r = await H.req('DELETE', `/api/planning/projects/${catProjectId}`);
      H.check('planning category-flow project cleanup', r.status === 200);
      r = await H.req('DELETE', `/api/planning/projects/${bareProjectId}`);
      H.check('planning category-bare project cleanup', r.status === 200);
      if (entA) await H.req('DELETE', `/api/properties/${entA}`);
      if (entB) await H.req('DELETE', `/api/properties/${entB}`);
    } finally { await browserT.close(); }
  }
  // AI report: generate → preview → save (nothing writes before Save),
  // report block arithmetic, fixed-default save path, attached model spec.
  const aiReportDef = { charts: [
    { template: 'time_line', title: 'Balance path', series: ['mortgage_balance'], method: 'Monthly outstanding principal from the engine projection, baseline vs each strategy.' },
    { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'], method: 'Cost = fees + penalty + cash out; gain = interest saved vs baseline + asset growth; net = gain − cost.' },
    { template: 'yearly_bars', title: 'Year-end balance', series: ['mortgage_balance'], method: 'Year-end outstanding principal per year from the engine projection.' },
    { template: 'share_doughnut', title: 'Equity share', series: ['total_value'], method: 'Each property equity at the horizon month (assessed value − outstanding principal, baseline trajectory).' },
  ] };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiReportDef));
  r = await H.req('POST', `/api/planning/projects/${planProjectId}/ai-report`, { text: 'Compare balance paths and headlines' });
  H.check('planning: ai-report returns the stub definition',
    r.status === 200 && JSON.stringify(r.data.definition) === JSON.stringify(aiReportDef), JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ charts: [{ template: 'time_line', title: 'No method', series: ['mortgage_balance'] }] }));
  r = await H.req('POST', `/api/planning/projects/${planProjectId}/ai-report`, { text: 'Compare balance paths' });
  H.check('planning: ai-report without a chart method is rejected',
    r.status === 502 && JSON.stringify(r.data).includes('calculation method'), JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiReportDef));
  r = await H.req('GET', `/api/planning/projects/${planProjectId}`);
  H.check('planning: ai-report writes nothing before Save',
    r.status === 200 && !(r.data.reports || []).some((x) => x.name === 'AI report test'), JSON.stringify((r.data.reports || []).map((x) => x.name)));
  r = await H.req('POST', `/api/planning/projects/${planProjectId}/reports`, { name: 'AI report test', definition: aiReportDef });
  H.check('planning: save AI report', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const aiReportId = r.data.report.id;
  r = await H.req('POST', `/api/planning/projects/${planProjectId}/reports`, { name: 'Fixed report test', definition: { strategies: [], charts: [{ template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }] } });
  H.check('planning: fixed-default save path still works', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${planProjectId}/comparison`);
  const repBlock = r.data.report;
  const t0 = repBlock && repBlock.trajectories[0] && repBlock.trajectories[0].monthly[0];
  H.check('planning: report total = assessed - balance + stock',
    !!t0 && Math.abs(t0.total_value - (repBlock.assessedTotal - t0.mortgage_balance + t0.stock_value)) < 0.011,
    JSON.stringify({ t0, assessedTotal: repBlock && repBlock.assessedTotal }));
  const stratRow0 = (r.data.strategies || [])[0];
  const bd0 = stratRow0 && repBlock.costBreakdown[stratRow0.strategy.id];
  H.check('planning: report cost breakdown sums to cost',
    !!bd0 && Math.abs(bd0.fees + bd0.penalty + bd0.cashOut - bd0.total) < 0.011 && bd0.total === stratRow0.comparison.cost,
    JSON.stringify(bd0));
  // Attached AI model spec surfaces on the strategy, with formulas.
  const aiModelDef = { bindings: [{ name: 'balance', entity: 'property', field: 'mortgage_balance' }], formulas: [{ output: 'monthly interest', expression: 'prior balance * monthly rate / 12' }], assumptions: [{ key: 'stockReturnPct', value: 5, source: 'user' }], outputs: [{ id: 'monthly_interest', label: 'Monthly interest' }], charts: [{ template: 'time_line', title: 'Interest path', series: ['monthly_interest'] }] };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiModelDef));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ai-model`, { text: 'Model interest', name: 'Interest model' });
  H.check('planning: ai-model saves a spec', r.status === 201 && r.data.model && r.data.model.id > 0, JSON.stringify(r.data));
  const aiModelId = r.data.model.id;
  r = await H.req('PUT', `/api/planning/strategies/${planStrategyId}`, { model_id: aiModelId });
  H.check('planning: attach model to strategy', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/strategies/${planStrategyId}`);
  H.check('planning: strategy returns attached model spec',
    r.status === 200 && r.data.model && r.data.model.spec && (r.data.model.spec.formulas || []).length === 1,
    JSON.stringify(r.data.model && r.data.model.spec));
  // Positive equity for the share doughnut: the test property gains an
  // assessed value (earlier comparison pins already ran, so this cannot
  // disturb them).
  r = await H.req('PUT', `/api/properties/${planPid}`, { assessed_value: 500000 });
  H.check('planning: test property gains an assessed value', r.status === 200, JSON.stringify(r.data));
  // AI report UI flow in a real browser: Generate → preview → Save, then
  // the saved report renders charts, tables and how-calculated lines.
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('planning ai-report browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    fs.writeFileSync(H.aiStubFile, JSON.stringify(aiReportDef));
    const forwardR = (rq) => new Promise((resolve, reject) => {
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
    const loginResR = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueR = loginResR.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserR = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserR.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardR({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueR, domain: 'ff.local', path: '/', httpOnly: true });
      const waitR = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#planning/project/${planProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      await page.click('#planAiReportBtn');
      await waitR(400);
      const modalOpen = await page.evaluate(() => !document.querySelector('#planReportAiModal').classList.contains('hidden'));
      H.check('planning: Generate with AI opens the modal', modalOpen);
      await page.type('#planReportAiName', 'AI report browser');
      await page.type('#planReportAiText', 'Compare balance paths and headlines');
      await page.click('#planReportAiGenBtn');
      await waitR(1500);
      const preview = await page.evaluate(() => {
        const out = document.querySelector('#planReportAiOut');
        return { text: out ? out.textContent : '', save: !!document.querySelector('#planReportAiSaveBtn') };
      });
      H.check('planning: AI preview lists the proposed charts before Save',
        preview.save && preview.text.includes('Balance path') && preview.text.includes('Equity share'), JSON.stringify(preview));
      r = await H.req('GET', `/api/planning/projects/${planProjectId}`);
      H.check('planning: browser preview writes nothing before Save',
        !(r.data.reports || []).some((x) => x.name === 'AI report browser'), JSON.stringify((r.data.reports || []).map((x) => x.name)));
      await page.click('#planReportAiSaveBtn');
      await waitR(1500);
      const listed = await page.evaluate(() => document.querySelector('#planReportList').textContent.includes('AI report browser'));
      H.check('planning: saved AI report appears in the Reports list', listed);
      await page.evaluate(() => { document.querySelector('[data-plan-report-view]').click(); });
      await waitR(1500);
      const view = await page.evaluate(() => ({
        hash: location.hash,
        line: !!document.querySelector('#planReportChart0'),
        yearly: !!document.querySelector('#planReportChart2'),
        doughnut: !!document.querySelector('#planReportChart3'),
        defs: document.querySelector('#planReport').textContent.includes('Cost = fees + penalty + cash out'),
        lane: document.querySelector('#planReport').textContent.includes('Planning Test Lane'),
        metric: document.querySelector('#planReport').textContent.includes('Total cost'),
      }));
      H.check('planning: report view renders charts, tables and how-calculated lines',
        view.hash.startsWith('#planning/project/') && view.line && view.yearly && view.doughnut && view.defs && view.lane && view.metric,
        JSON.stringify(view));
      await page.goto(`http://ff.local/#planning/strategy/${planStrategyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      const modelPanel = await page.evaluate(() => {
        const el = document.querySelector('#planStrategy');
        return el ? { trial: el.textContent.includes('Month-1 trial row'), bindings: el.textContent.includes('Bindings'), formula: el.textContent.includes('prior balance * monthly rate / 12') } : {};
      });
      H.check('planning: strategy model panel shows bindings, formulas and the month-1 trial row',
        modelPanel.trial && modelPanel.bindings && modelPanel.formula, JSON.stringify(modelPanel));
    } finally { await browserR.close(); }
  }
  // --------------------------------------------- template metadata
  // Project templates own their questions: intake answers are stored
  // as project metadata, panels render only for sections the template
  // asks about, and the comparison table stays hidden until a strategy
  // exists. Legacy projects (no template) keep the full panels.
  r = await H.req('POST', '/api/planning/projects', { name: 'Meta Mortgage Test', question: 'Pay off early', template: 'mortgage', metadata: { property_id: planPid } });
  H.check('planning metadata: mortgage-template project stores template + metadata',
    r.status === 201 && r.data.project && r.data.project.template === 'mortgage' && r.data.project.metadata && r.data.project.metadata.property_id === planPid,
    JSON.stringify(r.data));
  const metaMortgageId = r.data.project.id;
  r = await H.req('GET', `/api/planning/projects/${metaMortgageId}`);
  H.check('planning metadata: mortgage schema shows declared-assets only, no prime scenarios section',
    r.status === 200 && r.data.project && r.data.project.templateSchema && r.data.project.templateSchema.sections.primeScenarios === undefined && r.data.project.templateSchema.sections.declaredAssets === false
    && r.data.project.metadataLabels && r.data.project.metadataLabels.property_id && r.data.project.metadataLabels.property_id.includes('Planning Test Lane'),
    JSON.stringify({ schema: r.data.project && r.data.project.templateSchema, labels: r.data.project && r.data.project.metadataLabels }));
  r = await H.req('POST', '/api/planning/projects', { name: 'Meta Buy Test', question: 'Buy', template: 'buy', metadata: { account_type: 'TFSA' } });
  H.check('planning metadata: buy-template project stores template + metadata',
    r.status === 201 && r.data.project && r.data.project.template === 'buy', JSON.stringify(r.data));
  const metaBuyId = r.data.project.id;
  r = await H.req('GET', `/api/planning/projects/${metaBuyId}`);
  H.check('planning metadata: buy schema shows neither prime scenarios nor declared assets',
    r.status === 200 && r.data.project && r.data.project.templateSchema && r.data.project.templateSchema.sections.primeScenarios === undefined && r.data.project.templateSchema.sections.declaredAssets === false
    && r.data.project.metadataLabels && r.data.project.metadataLabels.account_type === 'TFSA',
    JSON.stringify(r.data.project && r.data.project.templateSchema));
  r = await H.req('POST', '/api/planning/projects', { name: 'Meta Bad', template: 'mortgage', metadata: {} });
  H.check('planning metadata: mortgage template without a property is rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/projects', { name: 'Meta Bad2', template: 'mortgage', metadata: { property_id: 999999 } });
  H.check('planning metadata: mortgage template with an unknown property is rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/planning/projects/${metaMortgageId}`, { metadata: { property_id: planPid } });
  H.check('planning metadata: metadata edit saves', r.status === 200 && r.data.project && r.data.project.metadata && r.data.project.metadata.property_id === planPid, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${planProjectId}`);
  H.check('planning metadata: legacy project has no template schema',
    r.status === 200 && r.data.project && !r.data.project.templateSchema, JSON.stringify(r.data.project && r.data.project.templateSchema));
  // ai-model structured ask: the stub asks for a genuinely missing
  // field; answers round-trip into the stored model metadata.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'target_contribution', label: 'Target monthly contribution?', type: 'number' }] }));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ai-model`, { text: 'Model contributions', name: 'Contrib model' });
  H.check('planning metadata: ai-model returns structured questions, not a dead-end string',
    r.status === 200 && Array.isArray(r.data.ask) && r.data.ask.length === 1 && r.data.ask[0].field === 'target_contribution',
    JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiModelDef));
  r = await H.req('POST', `/api/planning/strategies/${planStrategyId}/ai-model`, { text: 'Model contributions', name: 'Contrib model', answers: { target_contribution: 500 } });
  H.check('planning metadata: ai-model answers round-trip into stored model metadata',
    r.status === 201 && r.data.model && r.data.model.metadata && r.data.model.metadata.target_contribution === 500,
    JSON.stringify(r.data));
  // AI template storage + apply: the spec is saved with its metadata
  // schema and applies to a new strategy with its model attached.
  r = await H.req('POST', '/api/planning/templates', { name: 'Meta Saved Template', spec: aiModelDef, metadata_schema: [{ field: 'target_contribution', label: 'Target monthly contribution?', type: 'number' }], metadata_answers: { target_contribution: 500 } });
  H.check('planning metadata: AI template stores its metadata schema',
    r.status === 201 && r.data.template && r.data.template.id > 0, JSON.stringify(r.data));
  const metaTplId = r.data.template.id;
  r = await H.req('GET', '/api/planning/templates');
  H.check('planning metadata: template list carries source ai and the schema',
    r.status === 200 && (r.data.templates || []).some((t) => t.id === metaTplId && t.source === 'ai' && (t.metadata_schema || []).length === 1),
    JSON.stringify((r.data.templates || []).map((t) => t.id)));
  // (Strategy creation on the buy project happens after the DOM
  // zero-state checks below, so the empty-table pin stays valid.)
  // DOM: panel visibility, comparison gating, baseline note.
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('planning metadata browser checks skipped (puppeteer-core / probe Chrome not available)');
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
      await page.goto(`http://ff.local/#planning/project/${metaBuyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitM(1500);
      const buyPage = await page.evaluate(() => ({
        scenarioPanel: !!document.querySelector('#planScenarioPanel'),
        scenarioCardsPanel: !!document.querySelector('#planScenarioCardsPanel'),
        assetPanel: !!document.querySelector('#planAssetPanel'),
        baselinePanel: !!document.querySelector('#planBaselinePanel'),
        metadataPanel: !!document.querySelector('#planMetadataView'),
        baselinesPanel: !!document.querySelector('#planBaselineCardsPanel'),
        futureWorld: !!document.querySelector('#planCompareScenarioWrap'),
        metaLine: !!document.querySelector('#planMetadataLine'),
        metaLineEdit: !!document.querySelector('#planMetadataLineEdit'),
        noLegacyCompare: !document.querySelector('#planLegacyComparePanel') && !document.querySelector('#planCompareTable') && !document.querySelector('#planCompareChart'),
        panelOrder: [...document.querySelectorAll('#planBaselineCardsPanel, #planStrategiesPanel, #planReportsPanel')].map((el) => el.id),
      }));
      H.check('planning detail: buy project order is scenarios → baselines → strategies → reports, compact metadata line, old scenario/future-world panels gone',
        !buyPage.scenarioPanel && buyPage.scenarioCardsPanel && !buyPage.assetPanel && !buyPage.baselinePanel && !buyPage.metadataPanel && !buyPage.futureWorld
        && buyPage.baselinesPanel && buyPage.metaLine && buyPage.metaLineEdit
        && buyPage.noLegacyCompare
        && JSON.stringify(buyPage.panelOrder) === JSON.stringify(['planBaselineCardsPanel', 'planStrategiesPanel', 'planReportsPanel']),
        JSON.stringify(buyPage));
      await page.goto(`http://ff.local/#planning/project/${metaMortgageId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitM(1500);
      const mortPage = await page.evaluate(() => ({
        scenarioPanel: !!document.querySelector('#planScenarioPanel'),
        assetPanel: !!document.querySelector('#planAssetPanel'),
        baselinesPanel: !!document.querySelector('#planBaselineCardsPanel'),
        metaLine: !!document.querySelector('#planMetadataLine'),
        metaLineText: document.querySelector('#planMetadataLine')?.textContent || '',
      }));
      H.check('planning detail: mortgage project shows the compact metadata line, no scenario panel, no declared assets',
        !mortPage.scenarioPanel && !mortPage.assetPanel && mortPage.baselinesPanel && mortPage.metaLine && mortPage.metaLineText.includes('Planning Test Lane'), JSON.stringify(mortPage));
      await page.goto(`http://ff.local/#planning/project/${planProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitM(1500);
      const legPage = await page.evaluate(() => ({
        scenarioPanel: !!document.querySelector('#planScenarioPanel'),
        assetPanel: !!document.querySelector('#planAssetPanel'),
        baselinesPanel: !!document.querySelector('#planBaselineCardsPanel'),
        metaLine: !!document.querySelector('#planMetadataLine'),
      }));
      H.check('planning detail: legacy project keeps baselines/strategies/assets/reports, no scenario panel, no metadata line',
        !legPage.scenarioPanel && legPage.assetPanel && legPage.baselinesPanel && !legPage.metaLine, JSON.stringify(legPage));
      // Strategy template recording on the From-template path; once a
      // strategy exists the strategy card shows figures.
      r = await H.req('POST', `/api/planning/projects/${metaBuyId}/strategies`, { name: 'Meta Strat', source: 'template', template: 'prepay', template_params: { propertyId: planPid, date: planOpDate, amount: 5000 } });
      H.check('planning metadata: strategy records its applied template',
        r.status === 201 && r.data.strategy && r.data.strategy.template === 'prepay', JSON.stringify(r.data));
      await page.goto(`http://ff.local/#planning/project/${metaBuyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitM(1500);
      const buyCard = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#planStrategyCards [data-plan-strategy]')].find((c) => (c.textContent || '').includes('Meta Strat'));
        return card ? card.textContent : '';
      });
      H.check('planning metadata: strategy card shows figures once a strategy exists',
        buyCard.includes('Meta Strat') && buyCard.includes('Cost') && buyCard.includes('Gain'),
        JSON.stringify({ card: buyCard.slice(0, 200) }));
    } finally { await browserM.close(); }
  }
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/strategies/from-template`, { name: 'From saved', template_id: metaTplId, answers: { target_contribution: 600 } });
  H.check('planning metadata: applying a saved template creates a strategy with its model',
    r.status === 201 && r.data.strategy && r.data.strategy.id > 0 && r.data.model && (r.data.model.spec.formulas || []).length === 1,
    JSON.stringify(r.data));
  const metaAppliedStrategyId = r.data.strategy.id;
  r = await H.req('GET', `/api/planning/strategies/${metaAppliedStrategyId}`);
  H.check('planning metadata: applied strategy records ai-template + answers',
    r.status === 200 && r.data.strategy && r.data.strategy.template === 'ai-template'
    && r.data.strategy.template_params && r.data.strategy.template_params.template_id === metaTplId
    && r.data.model && r.data.model.metadata && r.data.model.metadata.target_contribution === 600,
    JSON.stringify({ tpl: r.data.strategy && r.data.strategy.template, meta: r.data.model && r.data.model.metadata }));
  r = await H.req('DELETE', `/api/planning/templates/${metaTplId}`);
  H.check('planning metadata: template cleanup', r.status === 200);
  // AI-model conversation thread: the ask response carries the thread
  // with one AI turn; answering + Continue carries two turns (AI + the
  // user turn) and the answers into the model metadata; the strategy
  // GET persists the thread. The server reads the stub file per call,
  // so the suite rewrites aiStubFile between the two calls.
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/strategies`, { name: 'Thread Strat', source: 'ai' });
  H.check('planning thread: design session strategy created',
    r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const threadStrategyId = r.data.strategy.id;
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'target_contribution', label: 'Target monthly contribution?', type: 'number' }] }));
  r = await H.req('POST', `/api/planning/strategies/${threadStrategyId}/ai-model`, { text: 'design a model', history: [] });
  H.check('planning thread: ask response carries a thread with one AI turn',
    r.status === 200 && r.data.ask && Array.isArray(r.data.thread) && r.data.thread.length === 1
    && r.data.thread[0].role === 'ai' && r.data.thread[0].questions[0].field === 'target_contribution',
    JSON.stringify(r.data));
  const threadAfterAsk = r.data.thread;
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiModelDef));
  r = await H.req('POST', `/api/planning/strategies/${threadStrategyId}/ai-model`, { text: 'design a model', history: threadAfterAsk, answers: { target_contribution: 600 } });
  H.check('planning thread: spec response carries the user turn and the answers as metadata',
    r.status === 201 && r.data.model && Array.isArray(r.data.thread) && r.data.thread.length === 2
    && r.data.thread[1].role === 'user' && r.data.thread[1].answers.target_contribution === 600
    && r.data.model.metadata && r.data.model.metadata.target_contribution === 600,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/strategies/${threadStrategyId}`);
  H.check('planning thread: strategy GET persists the thread',
    r.status === 200 && r.data.strategy && Array.isArray(r.data.strategy.ai_thread) && r.data.strategy.ai_thread.length === 2,
    JSON.stringify({ thread: r.data.strategy && r.data.strategy.ai_thread }));
  // AI-model no-id fixes: the model asking for property_id/term_id is
  // rewritten server-side to name picks (never shown to the user), a
  // repeated question dedupes, a name answer binds, an unbindable
  // answer surfaces a mismatch with named candidates, and a question
  // already answered in the thread never re-appears.
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/strategies`, { name: 'AiModel Strat', source: 'ai' });
  H.check('ai-model no-id: design session strategy created',
    r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const aiModelStratId = r.data.strategy.id;
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [
    { field: 'property_id', label: 'Which property ID corresponds to 77 Planning Test Lane?', type: 'text' },
    { field: 'term_id', label: 'Which term ID?', type: 'text' },
    { field: 'property_id', label: 'Which property ID?', type: 'text' },
  ] }));
  r = await H.req('POST', `/api/planning/strategies/${aiModelStratId}/ai-model`, { text: 'switch to 4.2% fixed rate', history: [] });
  H.check('ai-model no-id: id questions rewritten to name picks, duplicates collapsed',
    r.status === 200 && Array.isArray(r.data.ask) && r.data.ask.length === 2
    && !r.data.ask.some((q) => /_id$/.test(q.field))
    && r.data.ask.some((q) => q.field === 'property' && q.label.includes('77 Planning Test Lane'))
    && r.data.ask.some((q) => q.field === 'term' && q.label.includes('Choose by name')),
    JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'property', label: 'Which property?', type: 'text' }] }));
  r = await H.req('POST', `/api/planning/strategies/${aiModelStratId}/ai-model`, { text: 'switch to 4.2% fixed rate', history: [], answers: { property: 'No Such Place 123' } });
  H.check('ai-model no-id: unbindable name answer surfaces a mismatch with named candidates, not a silent re-ask',
    r.status === 200 && r.data.mismatch === true && Array.isArray(r.data.ask) && r.data.ask.length === 1
    && r.data.ask[0].field === 'property' && r.data.ask[0].label.includes('No property matches "No Such Place 123"')
    && r.data.ask[0].label.includes('77 Planning Test Lane'),
    JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiModelDef));
  r = await H.req('POST', `/api/planning/strategies/${aiModelStratId}/ai-model`, { text: 'switch to 4.2% fixed rate', history: [], answers: { property: '77 Planning Test Lane, Victoria, BC' } });
  H.check('ai-model no-id: an answer by name binds to the entity and produces a spec, not a re-ask',
    r.status === 201 && r.data.model && Array.isArray(r.data.resolved) && r.data.resolved.some((x) => x.entity === 'property' && x.label.includes('77 Planning Test Lane')),
    JSON.stringify(r.data));
  const answeredHistory = [
    { role: 'ai', questions: [{ field: 'effective_date', label: 'Effective date?', type: 'date' }] },
    { role: 'user', answers: { effective_date: '2027-01-31' } },
  ];
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [
    { field: 'effective_date', label: 'Effective date?', type: 'date' },
    { field: 'fixed_rate', label: 'Fixed rate?', type: 'number' },
  ] }));
  r = await H.req('POST', `/api/planning/strategies/${aiModelStratId}/ai-model`, { text: 'switch to 4.2% fixed rate', history: answeredHistory });
  H.check('ai-model no-id: a question answered in the thread is dropped, only the new question is asked',
    r.status === 200 && Array.isArray(r.data.ask) && r.data.ask.length === 1 && r.data.ask[0].field === 'fixed_rate',
    JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'effective_date', label: 'Effective date?', type: 'date' }] }));
  r = await H.req('POST', `/api/planning/strategies/${aiModelStratId}/ai-model`, { text: 'switch to 4.2% fixed rate', history: answeredHistory });
  H.check('ai-model no-id: a model that only re-asks answered questions fails honestly instead of looping the user',
    r.status === 502 && typeof r.data.error === 'string' && r.data.error.includes('already answered'),
    JSON.stringify(r.data));
  // Browser: the model-form thread pairs answers with their question
  // (no raw "key = value" lines) and an empty answer shows a generic
  // error, never the question text pasted in as a field name.
  let aiPptr = null;
  try {
    const { createRequire } = await import('node:module');
    const aiReqmod = createRequire(import.meta.url);
    try { aiPptr = aiReqmod('puppeteer-core'); } catch { aiPptr = aiReqmod('/tmp/pptr/node_modules/puppeteer-core'); }
  } catch { aiPptr = null; }
  if (!aiPptr || !H.chromeAvailable) {
    console.log('ai-model browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const aiForward = (rq) => new Promise((resolve, reject) => {
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
    const aiLogin = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const aiCookie = aiLogin.headers.get('set-cookie').split(';')[0].split('=')[1];
    const aiBrowser = await aiPptr.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await aiBrowser.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await aiForward({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: aiCookie, domain: 'ff.local', path: '/', httpOnly: true });
      const aiWait = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#planning/project/${metaBuyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await aiWait(1500);
      await page.evaluate(() => document.querySelector('#planAddStrategyBtn').click());
      await page.waitForFunction(() => !document.querySelector('#planStrategyModal').classList.contains('hidden'), { timeout: 10000 });
      await page.evaluate(() => document.querySelector('#planChooseAi').click());
      await page.waitForFunction(() => !!document.querySelector('#planChooseModel'), { timeout: 10000 });
      await page.evaluate(() => document.querySelector('#planChooseModel').click());
      await page.waitForFunction(() => !!document.querySelector('#planStrategyModelText'), { timeout: 10000 });
      await page.evaluate(() => {
        document.querySelector('#planStrategyName').value = 'AiModel Browser';
        document.querySelector('#planStrategyModelText').value = 'design a model';
      });
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'target_contribution', label: 'Target monthly contribution?', type: 'number' }] }));
      await page.evaluate(() => document.querySelector('#planStrategyModelBtn').click());
      await page.waitForFunction(() => !!document.querySelector('#planModelAsk_target_contribution'), { timeout: 10000 });
      await page.evaluate(() => document.querySelector('#planStrategyModelContinue').click());
      await page.waitForFunction(() => (document.querySelector('#planStrategyModalMsg')?.textContent || '').length > 0, { timeout: 10000 });
      const errText = await page.evaluate(() => document.querySelector('#planStrategyModalMsg')?.textContent || '');
      H.check('ai-model browser: empty answer shows a generic error, never the question text as a field name',
        errText.includes('Please answer all questions before continuing.') && !errText.includes('Target monthly contribution? is required'),
        JSON.stringify({ errText }));
      fs.writeFileSync(H.aiStubFile, JSON.stringify(aiModelDef));
      await page.evaluate(() => { document.querySelector('#planModelAsk_target_contribution').value = '600'; });
      await page.evaluate(() => document.querySelector('#planStrategyModelContinue').click());
      await page.waitForFunction(() => (document.querySelector('#planStrategyModelOut')?.textContent || '').includes('Bindings:'), { timeout: 10000 });
      await page.evaluate(() => document.querySelector('#planStrategyModelThreadToggle').click());
      const threadText = await page.evaluate(() => document.querySelector('#planStrategyModelThread')?.textContent || '');
      H.check('ai-model browser: thread pairs the answer with its question, no raw key = value line',
        threadText.includes('You: Target monthly contribution?: 600') && !threadText.includes('target_contribution = 600'),
        JSON.stringify({ threadText }));
    } finally { await aiBrowser.close(); }
  }
  // Strategy-centric comparison deltas: template_params alone create
  // no ops, so the prepay and buy ops are posted for real. The prepay
  // strategy books an equity advantage but no principal delta; the
  // buy strategy books a principal delta (10 units × 60 CAD) but no
  // equity delta.
  r = await H.req('GET', `/api/planning/projects/${metaBuyId}/comparison`);
  const metaStratRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.name === 'Meta Strat');
  H.check('planning deltas: Meta Strat found for the prepay op',
    !!metaStratRow, JSON.stringify({ strategies: (r.data.strategies || []).map((x) => x.strategy && x.strategy.name) }));
  r = await H.req('POST', `/api/planning/strategies/${metaStratRow.strategy.id}/ops`, { op_type: 'prepay', params: { propertyId: planPid, date: planOpDate, amount: 5000 } });
  H.check('planning deltas: prepay op posted', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/strategies`, { name: 'Delta Buy Strat', source: 'template', template: 'buy', template_params: { accountId: planAcctId, holdingId: planHoldingId, date: planOpDate, units: 10, price: 60 } });
  H.check('planning deltas: buy strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const deltaBuyStratId = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${deltaBuyStratId}/ops`, { op_type: 'buy', params: { accountId: planAcctId, holdingId: planHoldingId, date: planOpDate, units: 10, price: 60 }, legs: [{ source_ref: 'cash', amount: 600 }] });
  H.check('planning deltas: buy op posted', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${metaBuyId}/comparison`);
  const metaRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.name === 'Meta Strat');
  const buyRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.name === 'Delta Buy Strat');
  H.check('planning deltas: prepay strategy has an equity advantage and no principal delta',
    r.status === 200 && metaRow && typeof metaRow.equityDelta === 'number' && metaRow.equityDelta >= 5000 && metaRow.principalDelta === null,
    JSON.stringify({ equityDelta: metaRow && metaRow.equityDelta, principalDelta: metaRow && metaRow.principalDelta }));
  H.check('planning deltas: buy strategy has a 600 principal delta and no equity delta',
    buyRow && buyRow.principalDelta === 600 && buyRow.equityDelta === null,
    JSON.stringify({ equityDelta: buyRow && buyRow.equityDelta, principalDelta: buyRow && buyRow.principalDelta }));
  // AI baseline-first flow (stub LLM): ask → spec → Apply, with the
  // baseline landing in the baselines list (primeScenario and
  // stockReference stripped, no scenario rows, no metadata write).
  // Template output stays refinable: the saved-template body offers
  // Refine with AI, and a pure buy project charts principal gain with
  // no property baseline line.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'prime_direction', label: 'Prime direction?', type: 'text' }] }));
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/ai-baseline`, { text: 'Prime rises, new money follows the current plan' });
  H.check('planning detail: ai-baseline ask returns structured questions, not a dead-end string',
    r.status === 200 && Array.isArray(r.data.ask) && r.data.ask.length === 1 && r.data.ask[0].field === 'prime_direction',
    JSON.stringify(r.data));
  const baselineThread = r.data.thread;
  const baselineDef = { description: 'Prime rises then holds', primeScenario: { name: 'AI Baseline Path', direction: 'up', stance: 'pessimistic', magnitude: 1, steps: [{ date: '2027-01-01', rate: 5.5 }] }, stockReference: 'current-plan', assumptions: [{ key: 'growth', value: 'flat' }] };
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ baseline: baselineDef }));
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/ai-baseline`, { text: 'Prime rises, new money follows the current plan', history: baselineThread, answers: { prime_direction: 'up' } });
  H.check('planning detail: ai-baseline spec returns the baseline with the continued thread',
    r.status === 200 && r.data.baseline && r.data.baseline.description === 'Prime rises then holds' && Array.isArray(r.data.thread) && r.data.thread.length >= 2,
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/ai-baseline/apply`, { baseline: { primeScenario: { direction: 'sideways' } } });
  H.check('planning detail: ai-baseline apply rejects an invalid baseline', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${metaBuyId}/ai-baseline/apply`, { baseline: baselineDef });
  H.check('planning detail: ai-baseline apply strips primeScenario/stockReference and appends a baselines-list entry, writing no metadata',
    r.status === 200 && r.data.baseline && r.data.baseline.definition && r.data.baseline.definition.description === 'Prime rises then holds'
      && !('primeScenario' in r.data.baseline.definition) && !('stockReference' in r.data.baseline.definition)
      && !(r.data.project && r.data.project.metadata && r.data.project.metadata.aiBaseline),
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${metaBuyId}/comparison`);
  H.check('planning detail: applied baseline creates no scenario rows',
    r.status === 200 && Array.isArray(r.data.scenarios) && r.data.scenarios.length === 0 && r.data.scenario === null,
    JSON.stringify({ scenarios: r.data.scenarios, scenario: r.data.scenario }));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ fields: {} }));
  // Pure buy project: no mortgage op anywhere, so the comparison chart
  // must show principal gain and no property baseline line.
  r = await H.req('POST', '/api/planning/projects', { name: 'Detail Buy Test', question: 'Buy', template: 'buy', metadata: { account_type: 'TFSA' } });
  H.check('planning detail: pure buy project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const detailBuyId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${detailBuyId}/strategies`, { name: 'Detail Buy Strat', source: 'template', template: 'buy', template_params: { accountId: planAcctId, holdingId: planHoldingId, date: planOpDate, units: 10, price: 60 } });
  H.check('planning detail: pure buy strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const detailBuyStratId = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${detailBuyStratId}/ops`, { op_type: 'buy', params: { accountId: planAcctId, holdingId: planHoldingId, date: planOpDate, units: 10, price: 60 }, legs: [{ source_ref: 'cash', amount: 600 }] });
  H.check('planning detail: pure buy op posted', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${detailBuyId}/comparison`);
  const detailRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.name === 'Detail Buy Strat');
  H.check('planning detail: buy strategy comparison carries touchesStocks and a principal gain series',
    r.status === 200 && detailRow && detailRow.touchesStocks === true && Array.isArray(detailRow.principalGainSeries) && detailRow.principalGainSeries.length > 0 && detailRow.principalGainSeries.every((p) => typeof p.value === 'number'),
    JSON.stringify({ touchesStocks: detailRow && detailRow.touchesStocks, len: detailRow && detailRow.principalGainSeries && detailRow.principalGainSeries.length }));
  // The earlier template fixture was cleaned up by its own round, so
  // this block creates its own saved template for the refine flow.
  r = await H.req('POST', '/api/planning/templates', { name: 'Detail Refine Template', spec: aiModelDef, metadata_schema: [{ field: 'target_contribution', label: 'Target monthly contribution?', type: 'number' }], metadata_answers: { target_contribution: 500 } });
  H.check('planning detail: refine fixture template created', r.status === 201 && r.data.template && r.data.template.id > 0, JSON.stringify(r.data));
  const detailTplId = r.data.template.id;
  r = await H.req('GET', '/api/planning/templates');
  H.check('planning detail: templates list non-empty before browser refine check',
    r.status === 200 && (r.data.templates || []).length >= 1, JSON.stringify((r.data.templates || []).map((t) => t.id)));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('planning detail browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
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
    const loginResD = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueD = loginResD.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserD = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    const waitD = (ms) => new Promise((res2) => setTimeout(res2, ms));
    try {
      const page = await browserD.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueD, domain: 'ff.local', path: '/', httpOnly: true });
      await page.goto(`http://ff.local/#planning/project/${detailBuyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitD(2000);
      // Diagnostic split: what does the page's own fetch see?
      const pageTpl = await page.evaluate(() => fetch('/api/planning/templates').then((x) => x.json()).catch((e) => ({ error: String(e) })));
      H.check('planning detail: page fetch sees the saved templates',
        Array.isArray(pageTpl.templates) && pageTpl.templates.length >= 1, JSON.stringify(pageTpl).slice(0, 200));
      // Template refine: saved templates now live inside the AI
      // fallback screen of the preset chooser; Refine with AI still
      // opens the model form prefilled with the template summary.
      await page.click('#planAddStrategyBtn');
      const refinePresent = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 12; i++) {
          const ai = document.querySelector('#planChooseAi');
          if (ai) ai.click();
          await sleep(300);
          const card = document.querySelector('#planChooseSaved');
          if (card) card.click();
          await sleep(500);
          if (document.querySelector('#planSavedTemplateRefine')) return true;
        }
        return false;
      });
      const refineDiag = refinePresent ? '' : await page.evaluate(() => document.querySelector('#planStrategyModalBody')?.textContent?.slice(0, 200) || 'no modal body');
      H.check('planning detail: saved-template body offers Refine with AI', refinePresent, refineDiag);
      if (refinePresent) {
        await page.click('#planSavedTemplateRefine');
        await waitD(800);
        const prefilled = await page.evaluate(() => {
          const ta = document.querySelector('#planStrategyModelText');
          return ta ? ta.value : '';
        });
        H.check('planning detail: Refine with AI prefills the model form with the template summary',
          prefilled.includes('Refine the "'), JSON.stringify(prefilled.slice(0, 120)));
      }
    } finally { await browserD.close(); }
  }
  r = await H.req('DELETE', `/api/planning/templates/${detailTplId}`);
  H.check('planning detail: refine fixture template cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${detailBuyId}`);
  H.check('planning detail: pure buy project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${metaMortgageId}`);
  H.check('planning metadata: mortgage project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${metaBuyId}`);
  H.check('planning metadata: buy project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${planProjectId}`);
  H.check('planning: project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/properties/${planPid}`);
  H.check('planning: test property cleanup', r.status === 200, JSON.stringify(r.data));

  // ---- Optimization categories: multi-baseline, cards, AI follow-up, grounding ----
  r = await H.req('POST', '/api/properties', { address: '9 Category Lane', purchase_date: '2024-01-15', mortgage_balance: 800000, amortization_years: 25 });
  H.check('planning category: fixture property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const catPid = r.data.id;
  r = await H.req('POST', `/api/properties/${catPid}/rates`, { start_date: '2024-01-15', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 });
  H.check('planning category: variable segment created', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/projects', { name: 'Category Multi', question: 'q', category: 'property', subcategory: 'refinance', entity: { type: 'property', propertyId: catPid } });
  H.check('planning category: bare categorized project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const catMultiId = r.data.project.id;
  const flatDef = { description: 'Flat path' };
  const upDef = { description: 'Rising path' };
  r = await H.req('POST', `/api/planning/projects/${catMultiId}/baselines`, { name: 'Baseline A', source: 'manual', definition: flatDef });
  H.check('planning category: baseline A created', r.status === 201 && r.data.baseline && r.data.baseline.id > 0, JSON.stringify(r.data));
  const baseA = r.data.baseline.id;
  r = await H.req('POST', `/api/planning/projects/${catMultiId}/baselines`, { name: 'Baseline B', source: 'manual', definition: upDef });
  H.check('planning category: baseline B created', r.status === 201 && r.data.baseline && r.data.baseline.id > 0, JSON.stringify(r.data));
  const baseB = r.data.baseline.id;
  r = await H.req('GET', `/api/planning/projects/${catMultiId}`);
  H.check('planning category: two baselines coexist in one project',
    (r.data.project.baselines || []).length === 2, JSON.stringify((r.data.project.baselines || []).map((b) => b.name)));
  const mkStrat = async (name, amount) => {
    const s2 = await H.req('POST', `/api/planning/projects/${catMultiId}/strategies`, { name, source: 'template' });
    const sid = s2.data.strategy.id;
    await H.req('POST', `/api/planning/strategies/${sid}/ops`, { op_type: 'prepay', params: { propertyId: catPid, date: '2026-12-01', amount, openClosed: 'open' } });
    return sid;
  };
  const stratX = await mkStrat('Cat Strat X', 10000);
  const stratY = await mkStrat('Cat Strat Y', 20000);
  H.check('planning category: two strategies created', stratX > 0 && stratY > 0 && stratX !== stratY, JSON.stringify({ stratX, stratY }));
  // Applying a subcategory recommendation APPENDS a baseline.
  const recCat = await H.req('POST', '/api/planning/recommendations', { category: 'property', entity: { type: 'property', propertyId: catPid } });
  r = await H.req('POST', `/api/planning/projects/${catMultiId}/baselines`, { name: recCat.data.recommendations.refinance.baseline.name, source: 'recommendation', category: 'property', subcategory: 'refinance', entity: { type: 'property', propertyId: catPid }, definition: recCat.data.recommendations.refinance.baseline });
  H.check('planning category: recommendation appends a third baseline', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catMultiId}`);
  H.check('planning category: append keeps the old baselines',
    (r.data.project.baselines || []).length === 3
      && (r.data.project.baselines || []).some((b) => b.id === baseA)
      && (r.data.project.baselines || []).some((b) => b.id === baseB),
    JSON.stringify((r.data.project.baselines || []).map((b) => b.name)));
  // Report from baseline A + strategies X,Y; switching to B changes values.
  r = await H.req('POST', `/api/planning/projects/${catMultiId}/reports`, { name: 'Cat Report', definition: { strategies: [stratX, stratY], charts: [{ template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] }] }, baseline_id: baseA, strategy_ids: [stratX, stratY] });
  H.check('planning category: report stores baseline A + strategies X,Y',
    r.status === 201 && r.data.report && r.data.report.baseline_id === baseA && r.data.report.strategy_ids === `[${stratX},${stratY}]`,
    JSON.stringify(r.data.report));
  const catRepId = r.data.report.id;
  const trajSum = (comp) => (comp.report.trajectories[0].monthly || []).reduce((s, m) => s + (m.mortgage_balance || 0), 0);
  const compA = await H.req('GET', `/api/planning/projects/${catMultiId}/comparison?baselineId=${baseA}`);
  const compB = await H.req('GET', `/api/planning/projects/${catMultiId}/comparison?baselineId=${baseB}`);
  H.check('planning category: report from baseline A compares both strategies against A',
    compA.status === 200 && compA.data.chosenBaseline && compA.data.chosenBaseline.id === baseA
      && (compA.data.strategies || []).length === 2,
    JSON.stringify({ chosen: compA.data.chosenBaseline && compA.data.chosenBaseline.id, n: (compA.data.strategies || []).length }));
  H.check('planning category: switching the baseline does NOT change comparison values (baseline changes nothing)',
    compB.status === 200 && compB.data.chosenBaseline && compB.data.chosenBaseline.id === baseB
      && trajSum(compA.data) === trajSum(compB.data)
      && compA.data.strategies[0].comparison.net === compB.data.strategies[0].comparison.net,
    JSON.stringify({ sumA: trajSum(compA.data), sumB: trajSum(compB.data), netA: compA.data.strategies[0].comparison.net, netB: compB.data.strategies[0].comparison.net }));
  // A scenario prime factor DOES change numbers: scenario factors apply
  // to BOTH the baseline and the strategy at evaluation time — the
  // prepay and the do-nothing plan price the variable segment on the
  // same 9% path, and the prepay avoids far more interest there than
  // on the flat path (the fixed payment no longer covers interest).
  const _catVan = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit' }).format(new Date());
  const _catY = Number(_catVan.slice(0, 4)); const _catM = Number(_catVan.slice(5, 7));
  const _catFut = new Date(Date.UTC(_catY, _catM - 1 + 12, 1));
  const catFutureYm = `${_catFut.getUTCFullYear()}-${String(_catFut.getUTCMonth() + 1).padStart(2, '0')}`;
  r = await H.req('POST', `/api/planning/projects/${catMultiId}/scenarios`, { name: 'Hot prime' });
  H.check('planning category: scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const catScenId = r.data.scenario.id;
  r = await H.req('PUT', `/api/planning/scenarios/${catScenId}`, { factors: { prime: { points: [{ month: catFutureYm, rate: 9.0 }] } } });
  H.check('planning category: scenario prime factor saves', r.status === 200 && r.data.scenario && r.data.scenario.factors && r.data.scenario.factors.prime && r.data.scenario.factors.prime.points && r.data.scenario.factors.prime.points[0].rate === 9.0, JSON.stringify(r.data));
  const compF = await H.req('GET', `/api/planning/projects/${catMultiId}/comparison?baselineId=${baseA}&scenarioIds=${catScenId}`);
  H.check('planning category: prime scenario changes the strategy net — a prepay saves more interest when prime rises',
    compF.status === 200 && compF.data.strategies[0].comparison.net > compA.data.strategies[0].comparison.net,
    JSON.stringify({ netA: compA.data.strategies[0].comparison.net, netF: compF.data.strategies[0].comparison.net }));
  r = await H.req('PUT', `/api/planning/scenarios/${catScenId}`, { factors: { prime: { points: [{ month: catFutureYm, rate: 9.0 }] }, propertyGrowth: { valuePct: 5 } } });
  H.check('planning category: property-growth factor saves alongside prime', r.status === 200 && r.data.scenario && r.data.scenario.factors && r.data.scenario.factors.propertyGrowth && r.data.scenario.factors.propertyGrowth.valuePct === 5, JSON.stringify(r.data));
  const compG = await H.req('GET', `/api/planning/projects/${catMultiId}/comparison?baselineId=${baseA}&scenarioIds=${catScenId}`);
  // One world, one assessed path: property growth lifts BOTH the
  // baseline and the strategy horizons past their flat-world values.
  H.check('planning category: property-growth scenario grows baseline and strategy values at horizon past the flat world',
    compG.status === 200 && compG.data.strategies[0].projection.valueAtHorizon > compA.data.strategies[0].projection.valueAtHorizon
    && compG.data.baseline.valueAtHorizon > compA.data.baseline.valueAtHorizon,
    JSON.stringify({ strat: compG.data.strategies[0].projection.valueAtHorizon, stratFlat: compA.data.strategies[0].projection.valueAtHorizon, base: compG.data.baseline.valueAtHorizon, baseFlat: compA.data.baseline.valueAtHorizon }));
  r = await H.req('PUT', `/api/planning/scenarios/${catScenId}`, { factors: { unknownKey: { valuePct: 1 } } });
  H.check('planning category: unknown factor key is rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/planning/scenarios/${catScenId}`, { factors: { prime: { points: [{ month: '2020-01', rate: 5 }] } } });
  H.check('planning category: past prime point is rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/planning/strategies/${stratX}/factors`, { factors: { prime: { points: [{ month: catFutureYm, rate: 9.0 }] } } });
  H.check('planning category: strategy factors endpoint moved to scenarios', r.status === 400 && JSON.stringify(r.data).includes('scenarios'), JSON.stringify(r.data));
  // Multi-scenario comparison: a second world renders a second block,
  // and unchecking every world shows a re-pick panel only — no numbers.
  r = await H.req('POST', `/api/planning/projects/${catMultiId}/scenarios`, { name: 'Cool prime' });
  H.check('scenario restructure: second scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const catCoolId = r.data.scenario.id;
  r = await H.req('PUT', `/api/planning/scenarios/${catCoolId}`, { factors: { prime: { points: [{ month: catFutureYm, rate: 2.0 }] } } });
  H.check('scenario restructure: second scenario factor saves', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catMultiId}/comparison?scenarioIds=${catScenId},${catCoolId}`);
  H.check('scenario restructure: comparison returns one block per selected scenario',
    r.status === 200 && (r.data.scenarioBlocks || []).length === 2
    && r.data.scenarioBlocks[0].scenario && r.data.scenarioBlocks[0].scenario.id === catScenId
    && r.data.scenarioBlocks[1].scenario && r.data.scenarioBlocks[1].scenario.id === catCoolId
    && r.data.scenarioBlocks[0].strategies[0].comparison.net !== r.data.scenarioBlocks[1].strategies[0].comparison.net,
    JSON.stringify({ n: (r.data.scenarioBlocks || []).length, nets: (r.data.scenarioBlocks || []).map((b) => b.strategies[0] && b.strategies[0].comparison.net) }));
  r = await H.req('GET', `/api/planning/projects/${catMultiId}/comparison?scenarioIds=999999`);
  H.check('scenario restructure: unknown scenario id is rejected, never substituted', r.status === 404, JSON.stringify(r.data));
  // Card edit updates only that entry.
  r = await H.req('PUT', `/api/planning/projects/${catMultiId}/baselines/${baseA}`, { name: 'Baseline A renamed' });
  H.check('planning category: baseline card rename succeeds', r.status === 200 && r.data.baseline && r.data.baseline.name === 'Baseline A renamed', JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catMultiId}`);
  H.check('planning category: card edit updates only that baseline',
    (r.data.project.baselines || []).some((b) => b.id === baseA && b.name === 'Baseline A renamed')
      && (r.data.project.baselines || []).some((b) => b.id === baseB && b.name === 'Baseline B'),
    JSON.stringify((r.data.project.baselines || []).map((b) => b.name)));
  // Card delete removes only that entry; deleting baseline A (in the
  // report draft) clears the report selection instead of falling back.
  r = await H.req('DELETE', `/api/planning/projects/${catMultiId}/baselines/${baseA}`);
  H.check('planning category: delete baseline A clears the report draft', r.status === 200 && r.data.clearedReports === 1, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catMultiId}`);
  const catRep = (r.data.reports || []).find((x) => x.id === catRepId);
  H.check('planning category: report selection cleared, other baseline + strategies intact',
    catRep && catRep.baseline_id === null && catRep.baseline_cleared === 1
      && (r.data.project.baselines || []).some((b) => b.id === baseB)
      && (r.data.strategies || []).length === 2,
    JSON.stringify({ rep: catRep, baselines: (r.data.project.baselines || []).map((b) => b.id), strategies: (r.data.strategies || []).length }));
  r = await H.req('DELETE', `/api/planning/strategies/${stratY}`);
  H.check('planning category: delete strategy Y removes only Y', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catMultiId}`);
  H.check('planning category: strategy X survives the Y delete',
    (r.data.strategies || []).length === 1 && r.data.strategies[0].id === stratX,
    JSON.stringify((r.data.strategies || []).map((s) => s.id)));
  // AI follow-up on an applied recommendation (stub LLM): baseline
  // ask → spec → Apply touches only the targeted baseline row (and
  // strips primeScenario/stockReference from the stored definition),
  // and ai-model attaches a spec to the recommendation strategy.
  r = await H.req('POST', '/api/planning/projects', { name: 'Category AI Follow', question: 'q', category: 'property', subcategory: 'interest_rate', entity: { type: 'property', propertyId: catPid }, applyRecommendation: true });
  H.check('planning category: recommendation applied for AI follow-up', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const catAiId = r.data.project.id;
  r = await H.req('GET', `/api/planning/projects/${catAiId}`);
  const aiBaseRow = (r.data.project.baselines || [])[0];
  const aiStratRow = (r.data.strategies || [])[0];
  H.check('planning category: applied project has one baseline + one strategy',
    !!aiBaseRow && !!aiStratRow, JSON.stringify({ baselines: (r.data.project.baselines || []).length, strategies: (r.data.strategies || []).length }));
  const aiBaseBefore = JSON.stringify(aiBaseRow.definition);
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ ask: [{ field: 'prime_direction', label: 'Prime direction?', type: 'text' }] }));
  r = await H.req('POST', `/api/planning/projects/${catAiId}/ai-baseline`, { text: 'Prime rises', baselineId: aiBaseRow.id });
  H.check('planning category: AI follow-up ask targets the baseline card without writing',
    r.status === 200 && Array.isArray(r.data.ask) && r.data.ask.length === 1,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catAiId}`);
  H.check('planning category: ask preview leaves the baseline row unchanged',
    JSON.stringify((r.data.project.baselines || [])[0].definition) === aiBaseBefore,
    JSON.stringify((r.data.project.baselines || [])[0].definition));
  const followDef = { description: 'Prime rises then holds (follow-up)', primeScenario: { name: 'Follow Path', direction: 'up', stance: 'pessimistic', magnitude: 1, steps: [{ date: '2027-01-01', rate: 5.5 }] }, stockReference: 'current-plan', assumptions: [{ key: 'growth', value: 'flat' }] };
  // The stored follow-up definition strips primeScenario/stockReference:
  // the baseline changes nothing, the prime path lives on strategies.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ baseline: followDef }));
  r = await H.req('POST', `/api/planning/projects/${catAiId}/ai-baseline`, { text: 'Prime rises', baselineId: aiBaseRow.id });
  H.check('planning category: AI follow-up spec previews without writing',
    r.status === 200 && r.data.baseline && r.data.baseline.description === 'Prime rises then holds (follow-up)',
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${catAiId}`);
  H.check('planning category: spec preview leaves the baseline row unchanged',
    JSON.stringify((r.data.project.baselines || [])[0].definition) === aiBaseBefore, '');
  r = await H.req('POST', `/api/planning/projects/${catAiId}/ai-baseline/apply`, { baseline: followDef, baselineId: aiBaseRow.id });
  H.check('planning category: AI follow-up Apply updates the targeted baseline and strips primeScenario/stockReference',
    r.status === 200 && r.data.baseline && r.data.baseline.definition && r.data.baseline.definition.description === 'Prime rises then holds (follow-up)'
      && !('primeScenario' in r.data.baseline.definition) && !('stockReference' in r.data.baseline.definition),
    JSON.stringify(r.data));
  const aiModelDef2 = { bindings: [{ name: 'balance', entity: 'property', field: 'mortgage_balance' }], formulas: [{ output: 'monthly interest', expression: 'prior balance * monthly rate / 12' }], assumptions: [{ key: 'stockReturnPct', value: 5, source: 'user' }], outputs: [{ id: 'monthly_interest', label: 'Monthly interest' }], charts: [{ template: 'time_line', title: 'Interest path', series: ['monthly_interest'] }] };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(aiModelDef2));
  r = await H.req('POST', `/api/planning/strategies/${aiStratRow.id}/ai-model`, { text: 'Model interest', name: 'Follow model' });
  H.check('planning category: AI follow-up designs a model on the recommendation strategy',
    r.status === 201 && r.data.model && r.data.model.id > 0, JSON.stringify(r.data));
  const followModelId = r.data.model.id;
  r = await H.req('PUT', `/api/planning/strategies/${aiStratRow.id}`, { model_id: followModelId });
  H.check('planning category: follow-up model attaches to the strategy', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/strategies/${aiStratRow.id}`);
  H.check('planning category: strategy returns the attached follow-up model',
    r.status === 200 && r.data.model && r.data.model.id === followModelId, JSON.stringify(r.data.model && r.data.model.id));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ fields: {} }));
  // Grounding: report numbers come from the live snapshot, not the template.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Cat Ground Acct', type: 'NonRegistered' });
  H.check('planning category: grounding account created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const gAcct = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${gAcct}/holdings`, { label: 'Ground Holding', kind: 'exchange', symbol: 'GROUND', currency: 'CAD', events: [{ date: '2026-01-15', type: 'buy', units: 100, price: 10 }] });
  H.check('planning category: grounding holding with buy event created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const gHold = r.data.id;
  r = await H.req('POST', '/api/planning/projects', { name: 'Category Ground', question: 'q', category: 'investment', subcategory: 'stock', entity: { type: 'holding', accountId: gAcct, holdingId: gHold } });
  H.check('planning category: grounding project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const gProj = r.data.project.id;
  const stockLast = async () => {
    const c = await H.req('GET', `/api/planning/projects/${gProj}/comparison`);
    const s = c.data.baseline && c.data.baseline.stocks && c.data.baseline.stocks.series;
    return s && s.length ? s[s.length - 1].value : null;
  };
  const stockBefore = await stockLast();
  r = await H.req('POST', `/api/investments/holdings/${gHold}/events`, { date: '2026-06-15', type: 'buy', units: 100, price: 10 });
  H.check('planning category: second buy event posted', r.status === 201, JSON.stringify(r.data));
  const stockAfter = await stockLast();
  H.check('planning category: comparison stock value moves with the live snapshot (not baked into the template)',
    stockBefore !== null && stockAfter !== null && stockAfter !== stockBefore,
    JSON.stringify({ stockBefore, stockAfter }));
  // Legacy project: no category, no baselines panel content.
  r = await H.req('POST', '/api/planning/projects', { name: 'Category Legacy', question: 'legacy q' });
  H.check('planning category: legacy project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const legacyId = r.data.project.id;
  r = await H.req('GET', `/api/planning/projects/${legacyId}`);
  H.check('planning category: legacy project shows no category and no baselines',
    r.data.project && !r.data.project.category && !r.data.project.categoryLabels && (r.data.project.baselines || []).length === 0,
    JSON.stringify({ category: r.data.project.category, baselines: (r.data.project.baselines || []).length }));
  r = await H.req('DELETE', `/api/planning/projects/${catMultiId}`);
  H.check('planning category: multi project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${catAiId}`);
  H.check('planning category: AI follow-up project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${gProj}`);
  H.check('planning category: grounding project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${legacyId}`);
  H.check('planning category: legacy project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/properties/${catPid}`);
  H.check('planning category: fixture property cleanup', r.status === 200, JSON.stringify(r.data));

  // ---- Investment pool + sink (factors model, corrected) ----
  // Per-source contributions: a percent is OF ITS OWN SOURCE, an
  // amount is CAD from that source. Contributions never sum to 100%
  // — the pool total is their sum. The baseline holds the pool but
  // still earns: each holding compounds at its current return rate
  // from its own history (same basis as the stock-factor trend).
  r = await H.req('POST', '/api/investments/accounts', { name: 'Pool Acct A', type: 'NonRegistered' });
  H.check('planning pool: account A created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const poolAcctA = r.data.id;
  r = await H.req('POST', '/api/investments/accounts', { name: 'Pool Acct B', type: 'NonRegistered' });
  H.check('planning pool: account B created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const poolAcctB = r.data.id;
  r = await H.req('POST', '/api/investments/accounts', { name: 'Pool Acct C', type: 'NonRegistered' });
  H.check('planning pool: account C created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const poolAcctC = r.data.id;
  const _poolVan = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit' }).format(new Date());
  const _poolY = Number(_poolVan.slice(0, 4)); const _poolM = Number(_poolVan.slice(5, 7));
  const _poolShift = (months) => {
    const total = _poolY * 12 + (_poolM - 1) - months;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-15`;
  };
  r = await H.req('POST', `/api/investments/accounts/${poolAcctA}/holdings`, { label: 'Pool Stock A', kind: 'exchange', symbol: 'POOL.A', currency: 'CAD', events: [{ date: '2025-01-15', type: 'buy', units: 100, price: 10 }] });
  H.check('planning pool: holding A created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const poolHoldA = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${poolAcctB}/holdings`, { label: 'Pool Stock B', kind: 'exchange', symbol: 'POOL.B', currency: 'CAD', events: [{ date: '2025-01-15', type: 'buy', units: 50, price: 10 }] });
  H.check('planning pool: holding B created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const poolHoldB = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${poolAcctC}/holdings`, { label: 'Pool Stock C', kind: 'exchange', symbol: 'POOL.C', currency: 'CAD', events: [{ date: '2025-01-15', type: 'buy', units: 100, price: 10 }] });
  H.check('planning pool: holding C created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const poolHoldC = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${poolHoldA}/nav`, { date: _poolShift(12), price: 19 });
  H.check('planning pool: NAV A 1y', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${poolHoldA}/nav`, { date: _poolShift(1), price: 20 });
  H.check('planning pool: NAV A recent', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${poolHoldB}/nav`, { date: _poolShift(12), price: 40 });
  H.check('planning pool: NAV B 1y', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${poolHoldB}/nav`, { date: _poolShift(1), price: 40 });
  H.check('planning pool: NAV B recent', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${poolHoldC}/nav`, { date: _poolShift(12), price: 16 });
  H.check('planning pool: NAV C 1y', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${poolHoldC}/nav`, { date: _poolShift(1), price: 20 });
  H.check('planning pool: NAV C recent', r.status === 201, JSON.stringify(r.data));
  // Current values: A = 100x20 = 2000 (1y CAGR 20/19-1 = 5.26%),
  // B = 50x40 = 2000 (flat), C = 100x20 = 2000 (1y CAGR 25%).
  r = await H.req('POST', '/api/planning/recommendations', { category: 'investment', entity: { type: 'pool', items: [{ accountId: poolAcctA, percent: 101 }] } });
  H.check('planning pool: percent over 100% of its source is rejected', r.status === 400 && /at most 100/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/recommendations', { category: 'investment', entity: { type: 'pool', items: [{ holdingId: poolHoldB, amount: 2001 }] } });
  H.check('planning pool: amount above its holding value is rejected', r.status === 400 && /exceeds/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/recommendations', { category: 'investment', entity: { type: 'pool', items: [{ accountId: poolAcctA, percent: 30 }, { holdingId: poolHoldA, percent: 10 }] } });
  H.check('planning pool: holding already covered by a picked account is rejected', r.status === 400 && /already covered/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/recommendations', { category: 'investment', entity: { type: 'pool', items: [{ accountId: poolAcctA, percent: 30 }, { holdingId: poolHoldB, amount: 500 }] } });
  const poolFigs = r.data.recommendations && r.data.recommendations.stock && r.data.recommendations.stock.baseline && r.data.recommendations.stock.baseline.figures;
  H.check('planning pool: 30% of account A + $500 from holding B sums to exactly 1100',
    r.status === 200 && poolFigs && poolFigs.poolValue === 1100 && poolFigs.stockCount === 2
      && poolFigs.items && poolFigs.items.length === 2 && poolFigs.items[0].value === 600 && poolFigs.items[1].value === 500,
    JSON.stringify(poolFigs));
  r = await H.req('POST', '/api/planning/projects', { name: 'Pool Project', question: 'q', category: 'investment', subcategory: 'stock', entity: { type: 'pool', items: [{ accountId: poolAcctA, percent: 30 }, { holdingId: poolHoldB, amount: 500 }] }, applyRecommendation: true });
  H.check('planning pool: pool project created with recommendation applied', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const poolProjId = r.data.project.id;
  r = await H.req('GET', `/api/planning/projects/${poolProjId}`);
  const poolBase = (r.data.project.baselines || [])[0];
  const poolStrat = (r.data.strategies || [])[0];
  H.check('planning pool: baseline is the 1100 pool over 2 stocks',
    !!poolBase && poolBase.name === 'Pool · 2 stocks' && poolBase.definition && poolBase.definition.figures && poolBase.definition.figures.poolValue === 1100
      && poolBase.definition.figures.stockCount === 2,
    JSON.stringify({ name: poolBase && poolBase.name, figures: poolBase && poolBase.definition && poolBase.definition.figures }));
  H.check('planning pool: recommendation strategy exists', !!poolStrat, JSON.stringify((r.data.strategies || []).map((x) => x.id)));
  r = await H.req('GET', '/api/planning/prime-presets?preset=optimistic');
  H.check('planning pool: prime presets endpoint returns a complete optimistic path',
    r.status === 200 && r.data.preset === 'optimistic' && Array.isArray(r.data.points) && r.data.points.length > 0 && typeof r.data.label === 'string' && r.data.label.length > 0,
    JSON.stringify(r.data));
  // Baseline growth: a single-holding pool (100% of C) compounds at
  // C's current 1y rate X with no strategy applied; the series ratio
  // over the 30y horizon is exactly (1+X)^30.
  r = await H.req('POST', '/api/planning/projects', { name: 'Pool Growth Project', question: 'q', category: 'investment', subcategory: 'stock', entity: { type: 'pool', items: [{ holdingId: poolHoldC, percent: 100 }] }, applyRecommendation: true });
  H.check('planning pool: growth pool project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const poolGrowthId = r.data.project.id;
  r = await H.req('GET', `/api/planning/return-suggestions?holdingId=${poolHoldC}`);
  const sug1y = (r.data.suggestions || []).find((x) => x.label === '1y');
  const rateX = sug1y ? sug1y.annualizedReturn : null;
  H.check('planning pool: holding C current 1y rate is 25%', rateX === 0.25, JSON.stringify(r.data.suggestions));
  r = await H.req('GET', `/api/planning/projects/${poolGrowthId}/comparison`);
  const growthSeries = r.data.baseline && r.data.baseline.stocks && r.data.baseline.stocks.series;
  const growthRatio = growthSeries && growthSeries.length ? growthSeries[growthSeries.length - 1].value / growthSeries[0].value : null;
  const growthExpected = rateX != null ? Math.pow(1 + rateX, 30) : null;
  H.check('planning pool: baseline with no strategy grows at the holding current rate',
    growthSeries && growthSeries.length > 0 && growthExpected != null && Math.abs(growthRatio - growthExpected) / growthExpected < 0.005,
    JSON.stringify({ first: growthSeries && growthSeries[0], last: growthSeries && growthSeries[growthSeries.length - 1], ratio: growthRatio, expected: growthExpected }));
  const baseFirstBefore = growthSeries && growthSeries.length ? growthSeries[0].value : null;
  const baseLastBefore = growthSeries && growthSeries.length ? growthSeries[growthSeries.length - 1].value : null;
  r = await H.req('GET', `/api/planning/projects/${poolGrowthId}`);
  const growthStrat = (r.data.strategies || [])[0];
  r = await H.req('POST', `/api/planning/projects/${poolGrowthId}/scenarios`, { name: 'Growth world' });
  H.check('planning pool: growth scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const growthScenId = r.data.scenario.id;
  r = await H.req('PUT', `/api/planning/scenarios/${growthScenId}`, { factors: { stock: { valuePct: 10 } } });
  H.check('planning pool: growth scenario stock factor saves', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${poolGrowthId}/comparison?scenarioIds=${growthScenId}`);
  const growthRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.id === growthStrat.id);
  const growthSeriesAfter = r.data.baseline && r.data.baseline.stocks && r.data.baseline.stocks.series;
  r = await H.req('GET', `/api/planning/strategies/${growthStrat.id}?scenarioId=0`);
  const growthFlat = r.data;
  // The scenario stock factor changes the strategy projection AND the
  // baseline follows the same world (no longer pinned at current
  // rates) — both move off their flat-world values.
  H.check('planning pool: scenario stock factor changes the projection and the baseline follows the same world',
    growthRow && growthRow.projection && growthRow.projection.valueAtHorizon !== growthFlat.projection.valueAtHorizon
      && growthSeriesAfter && growthSeriesAfter.length && growthSeriesAfter[growthSeriesAfter.length - 1].value !== baseLastBefore,
    JSON.stringify({ strat: growthRow && growthRow.projection.valueAtHorizon, stratFlat: growthFlat.projection.valueAtHorizon, lastAfter: growthSeriesAfter && growthSeriesAfter[growthSeriesAfter.length - 1].value, lastBefore: baseLastBefore }));
  r = await H.req('PUT', `/api/planning/strategies/${poolStrat.id}/sink`, { sink: { kind: 'stock', holdingId: poolHoldA, trendPct: 10, basis: 'Price CAGR', window: '1y' } });
  H.check('planning sink: stock sink saves', r.status === 200 && r.data.sink && r.data.sink.kind === 'stock', JSON.stringify(r.data.sink));
  r = await H.req('GET', `/api/planning/strategies/${poolStrat.id}`);
  H.check('planning sink: stock sink ops are two sells + one buy',
    r.status === 200 && (r.data.ops || []).length === 3 && (r.data.ops || []).filter((o) => o.op_type === 'sell').length === 2 && (r.data.ops || []).filter((o) => o.op_type === 'buy').length === 1,
    JSON.stringify((r.data.ops || []).map((o) => o.op_type)));
  r = await H.req('GET', `/api/planning/projects/${poolProjId}/comparison`);
  const sinkRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.id === poolStrat.id);
  H.check('planning sink: stock sink grows the pool at the 10% trend, not new cash',
    sinkRow && sinkRow.projection && sinkRow.projection.stocks && sinkRow.projection.stocks.valueAtHorizon > sinkRow.projection.stocks.buyCash * 10 && sinkRow.comparison && sinkRow.comparison.stockGain > 0,
    JSON.stringify({ value: sinkRow && sinkRow.projection.stocks.valueAtHorizon, buyCash: sinkRow && sinkRow.projection.stocks.buyCash, gain: sinkRow && sinkRow.comparison.stockGain }));
  r = await H.req('POST', `/api/planning/projects/${poolProjId}/strategies`, { name: 'Pool Custom Sink', source: 'manual' });
  H.check('planning sink: custom-sink strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const customStratId = r.data.strategy.id;
  r = await H.req('PUT', `/api/planning/strategies/${customStratId}/sink`, { sink: { kind: 'custom', name: 'Test GIC', expectedReturnPct: 6 } });
  H.check('planning sink: custom sink saves', r.status === 200 && r.data.sink && r.data.sink.kind === 'custom', JSON.stringify(r.data.sink));
  r = await H.req('GET', `/api/planning/projects/${poolProjId}/comparison`);
  const customRow = (r.data.strategies || []).find((x) => x.strategy && x.strategy.id === customStratId);
  H.check('planning sink: custom sink grows the pool at the user-filled 6% return',
    customRow && customRow.projection && customRow.projection.stocks && customRow.projection.stocks.valueAtHorizon > customRow.projection.stocks.buyCash * 5 && customRow.comparison && customRow.comparison.stockGain > 0,
    JSON.stringify({ value: customRow && customRow.projection.stocks.valueAtHorizon, buyCash: customRow && customRow.projection.stocks.buyCash, gain: customRow && customRow.comparison.stockGain }));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('planning pool/sink browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardQ = (rq) => new Promise((resolve, reject) => {
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
    const loginResQ = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueQ = loginResQ.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserQ = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    const waitQ = (ms) => new Promise((res2) => setTimeout(res2, ms));
    try {
      const page = await browserQ.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardQ({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueQ, domain: 'ff.local', path: '/', httpOnly: true });
      await page.goto(`http://ff.local/#planning/project/${poolProjId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitQ(1500);
      const poolPage = await page.evaluate(() => {
        const baseCards = [...document.querySelectorAll('#planBaselineCards [data-plan-baseline]')];
        const stratCards = [...document.querySelectorAll('#planStrategiesPanel [data-plan-strategy]')];
        return {
          baseText: baseCards.map((c) => c.textContent).join(' | '),
          stratText: stratCards.map((c) => c.textContent).join(' | '),
        };
      });
      H.check('planning pool: baseline cards carry no factor UI, strategy card shows the sink line',
        !poolPage.baseText.includes('Prime →') && !poolPage.baseText.includes('Sink:')
          && poolPage.stratText.includes('Sink: existing stock'),
        JSON.stringify(poolPage));
      // Factors live on scenarios now: the strategy detail carries no
      // Factors panel, only the Sink panel + a scenario picker.
      r = await H.req('POST', `/api/planning/projects/${poolProjId}/scenarios`, { name: 'Pool Prime' });
      H.check('planning pool: scenario created for the factor UI', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
      const poolScenId = r.data.scenario.id;
      await page.goto(`http://ff.local/#planning/strategy/${poolStrat.id}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitQ(1500);
      const stratPage = await page.evaluate(() => ({
        factorsPanel: !!document.querySelector('#planFactorsPanel'),
        sinkPanel: !!document.querySelector('#planSinkPanel'),
        scenSel: !!document.querySelector('#planStrategyScenarioSel'),
        scenarioPanelOld: !!document.querySelector('#planScenarioPanel'),
        fanChart: !!document.querySelector('#planStrategyFanChart'),
      }));
      H.check('planning pool: strategy detail has no Factors panel, keeps the Sink panel + scenario picker, no fan chart',
        !stratPage.factorsPanel && stratPage.sinkPanel && stratPage.scenSel && !stratPage.scenarioPanelOld && !stratPage.fanChart,
        JSON.stringify(stratPage));
      await page.goto(`http://ff.local/#planning/scenario/${poolScenId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitQ(1500);
      // Prime is opt-in now: add the factor first, then the chart + presets render.
      const primeAdded = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 12; i++) {
          const sel = document.querySelector('#planFactorAddSel');
          if (sel) {
            sel.value = 'prime';
            document.querySelector('#planFactorAddBtn').click();
          }
          await sleep(500);
          if (document.querySelector('#planFactorPrimeChart')) return true;
        }
        return false;
      });
      const scenPage = await page.evaluate(() => ({
        factorsPanel: !!document.querySelector('#planFactorsPanel'),
        primeChart: !!document.querySelector('#planFactorPrimeChart'),
        presetBtns: document.querySelectorAll('[data-plan-prime-preset]').length,
        scenarioPanelOld: !!document.querySelector('#planScenarioPanel'),
        fanChart: !!document.querySelector('#planStrategyFanChart'),
        addOpts: [...document.querySelectorAll('#planFactorAddSel option')].map((o) => o.value),
      }));
      H.check('planning pool: scenario detail shows the Factors panel with prime chart + view presets after Add factor, no fan chart',
        primeAdded && scenPage.factorsPanel && scenPage.primeChart && scenPage.presetBtns === 5 && !scenPage.scenarioPanelOld && !scenPage.fanChart,
        JSON.stringify(scenPage));
      H.check('scenario restructure: the scenario Add-factor select never offers Sink (sink lives on the strategy)',
        !scenPage.addOpts.includes('sink'), JSON.stringify(scenPage.addOpts));
      // Ops + sink still work with no factors: under the factor-less
      // Pool Prime world the strategy card keeps its figures + sink line.
      await page.goto(`http://ff.local/#planning/project/${poolProjId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitQ(1500);
      const poolAfter = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#planStrategiesPanel [data-plan-strategy]')];
        return { text: cards.map((c) => c.textContent).join(' | '), hasValue: cards.some((c) => !!c.querySelector('.v')) };
      });
      H.check('scenario restructure: strategy ops + sink still render figures under a factor-less scenario',
        poolAfter.hasValue && poolAfter.text.includes('Sink: existing stock'), JSON.stringify(poolAfter));
      // Pool builder: account percent + holding amount compose the same
      // 1100 total live, and the preview card carries it.
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitQ(1200);
      await page.click('#planAddProjectBtn');
      await waitQ(300);
      await page.evaluate(() => { document.querySelector('#planCategoryCards [data-plan-cat="investment"]').click(); });
      await waitQ(1200);
      const built = await page.evaluate((ids) => {
        const setVal = (sel, val, ev) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.value = val;
          el.dispatchEvent(new Event(ev, { bubbles: true }));
          return true;
        };
        const acctCb = document.querySelector(`[data-pool-account="${ids.acctA}"]`);
        if (!acctCb) return { error: 'no account row' };
        acctCb.click();
        setVal(`[data-pool-input="${ids.acctA}"]`, '30', 'input');
        const holdCb = document.querySelector(`[data-pool-holding="${ids.holdB}"]`);
        if (!holdCb) return { error: 'no holding row' };
        holdCb.click();
        setVal(`[data-pool-mode-h="${ids.holdB}"]`, 'amount', 'change');
        setVal(`[data-pool-input-h="${ids.holdB}"]`, '500', 'input');
        return { total: document.querySelector('#planPoolTotal')?.textContent || '' };
      }, { acctA: poolAcctA, holdB: poolHoldB });
      H.check('planning pool: builder composes 30% of account A + $500 of holding B into a 1,100.00 live total',
        built.total && built.total.includes('1,100.00'), JSON.stringify(built));
      await page.click('#planCatEntityGo');
      await waitQ(1200);
      const preview = await page.evaluate(() => document.querySelector('#planCategorySubs')?.textContent || '');
      H.check('planning pool: builder preview card carries the 1,100.00 pool value over 2 stocks',
        preview.includes('1,100.00') && preview.includes('2 stocks'), JSON.stringify(preview.slice(0, 300)));
    } finally { await browserQ.close(); }
  }
  r = await H.req('DELETE', `/api/planning/projects/${poolProjId}`);
  H.check('planning pool: project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/planning/projects/${poolGrowthId}`);
  H.check('planning pool: growth project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/investments/accounts/${poolAcctA}`);
  H.check('planning pool: account A cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/investments/accounts/${poolAcctB}`);
  H.check('planning pool: account B cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/investments/accounts/${poolAcctC}`);
  H.check('planning pool: account C cleanup', r.status === 200);

  // ---- Strategy editor: factor opt-in, category presets, quick actions ----
  r = await H.req('POST', '/api/properties', { address: '7 Editor Lane', purchase_date: '2024-01-15', mortgage_balance: 800000, amortization_years: 25 });
  H.check('strategy editor: fixture property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const edPid = r.data.id;
  r = await H.req('POST', `/api/properties/${edPid}/rates`, { start_date: '2024-01-15', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 });
  H.check('strategy editor: fixture variable segment created', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/projects', { name: 'Editor Opt-in', question: 'q', category: 'property', subcategory: 'refinance', entity: { type: 'property', propertyId: edPid } });
  H.check('strategy editor: fixture property project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const edProjId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${edProjId}/strategies`, { name: 'Editor Strat', source: 'manual' });
  H.check('strategy editor: fixture strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const edStratId = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${edStratId}/ops`, { op_type: 'prepay', params: { propertyId: edPid, date: (() => { const d = new Date(); d.setMonth(d.getMonth() + 3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })(), amount: 50000 } });
  H.check('strategy editor: fixture prepay op created', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/strategies/${edStratId}`);
  const edBase = r.data.comparison || {};
  H.check('strategy editor: baseline comparison reads', r.status === 200 && edBase.net != null, JSON.stringify(edBase));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('strategy editor browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardR = (rq) => new Promise((resolve, reject) => {
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
    const loginResR = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueR = loginResR.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserR = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    const waitR = (ms) => new Promise((res2) => setTimeout(res2, ms));
    try {
      const page = await browserR.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardR({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueR, domain: 'ff.local', path: '/', httpOnly: true });
      // Factors live on scenarios now: the strategy detail carries no
      // factor UI at all, only a scenario picker.
      r = await H.req('POST', `/api/planning/projects/${edProjId}/scenarios`, { name: 'Editor World' });
      H.check('strategy editor: scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
      const edScenId = r.data.scenario.id;
      await page.goto(`http://ff.local/#planning/strategy/${edStratId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      const fresh = await page.evaluate(() => ({
        addSel: !!document.querySelector('#planFactorAddSel'),
        primeChart: !!document.querySelector('#planFactorPrimeChart'),
        stockVal: !!document.querySelector('#planFactorStockVal'),
        growthInput: !!document.querySelector('[data-growth]'),
        sinkPanel: !!document.querySelector('#planSinkPanel'),
        scenSel: !!document.querySelector('#planStrategyScenarioSel'),
      }));
      H.check('strategy editor: property strategy detail carries no factor UI; scenario picker present',
        !fresh.addSel && !fresh.primeChart && !fresh.stockVal && !fresh.growthInput && !fresh.sinkPanel && fresh.scenSel, JSON.stringify(fresh));
      await page.goto(`http://ff.local/#planning/scenario/${edScenId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      const added = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const sel = document.querySelector('#planFactorAddSel');
        if (!sel) return false;
        sel.value = 'stock';
        document.querySelector('#planFactorAddBtn').click();
        for (let i = 0; i < 12; i++) {
          if (document.querySelector('#planFactorStockVal')) break;
          await sleep(500);
        }
        const inp = document.querySelector('#planFactorStockVal');
        if (!inp) return false;
        inp.value = '8';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#planFactorSaveBtn').click();
        await sleep(1500);
        return true;
      });
      H.check('strategy editor: stock factor added through the scenario UI', added);
      r = await H.req('GET', `/api/planning/scenarios/${edScenId}`);
      H.check('strategy editor: scenario stock factor saved', r.status === 200 && r.data.scenario && r.data.scenario.factors && r.data.scenario.factors.stock && r.data.scenario.factors.stock.valuePct === 8, JSON.stringify(r.data));
      r = await H.req('GET', `/api/planning/strategies/${edStratId}?scenarioId=${edScenId}`);
      const edAfter = r.data.comparison || {};
      // A stock factor is a global return override: with valued holdings
      // in the run it moves the blended total via stockGain, so gain/net
      // are NOT pinned here. What it provably never touches on a pure
      // property strategy is every property number — the decision itself.
      H.check('strategy editor: stock factor on a pure property strategy changes no property number',
        edAfter.interestSaved === edBase.interestSaved && edAfter.payoffShiftMonths === edBase.payoffShiftMonths
        && edAfter.paymentDelta === edBase.paymentDelta && edAfter.penaltyTotal === edBase.penaltyTotal
        && edAfter.cost === edBase.cost,
        JSON.stringify({ before: edBase, after: edAfter }));
      r = await H.req('PUT', `/api/planning/strategies/${edStratId}/factors`, { factors: { prime: { points: [{ month: '2027-01', rate: 4.5 }], preset: null }, stock: { valuePct: 8 } } });
      H.check('strategy editor: strategy factors endpoint moved to scenarios', r.status === 400 && JSON.stringify(r.data).includes('scenarios'), JSON.stringify(r.data));
      r = await H.req('PUT', `/api/planning/scenarios/${edScenId}`, { factors: { prime: { points: [{ month: '2027-01', rate: 4.5 }], preset: null }, stock: { valuePct: 8 } } });
      H.check('strategy editor: factors preset via scenario API', r.status === 200, JSON.stringify(r.data));
      // Legacy migration: a strategy row carrying old-shape factors is
      // lifted into a Default scenario on project read — nothing lost.
      const seedLegacyFactors = () => {
        const dbFile = new Database(path.join(H.dataDir, 'finance.db'));
        dbFile.pragma('busy_timeout = 5000');
        dbFile.prepare('UPDATE plan_strategies SET factors = ? WHERE id = ?').run(JSON.stringify({ prime: { points: [{ month: '2027-01', rate: 4.5 }], preset: null }, stock: { valuePct: 8 } }), edStratId);
        dbFile.close();
      };
      seedLegacyFactors();
      r = await H.req('GET', `/api/planning/projects/${edProjId}`);
      const migrated = (r.data.scenarios || []).find((x) => x.name === 'Default scenario');
      H.check('strategy editor: legacy strategy factors migrate into a Default scenario on project read',
        !!migrated && migrated.factors && migrated.factors.prime && migrated.factors.prime.points && migrated.factors.prime.points[0].rate === 4.5
        && migrated.factors.stock && migrated.factors.stock.valuePct === 8
        && (r.data.strategies || []).find((x) => x.id === edStratId).factors == null,
        JSON.stringify({ scenarios: (r.data.scenarios || []).map((x) => x.name), migrated: migrated && migrated.factors }));
      await page.goto(`http://ff.local/#planning/scenario/${migrated.id}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      const legacy = await page.evaluate(() => ({
        primeChart: !!document.querySelector('#planFactorPrimeChart'),
        stockVal: document.querySelector('#planFactorStockVal')?.value || '',
      }));
      H.check('strategy editor: migrated scenario still shows its factors (prime chart + stock 8)',
        legacy.primeChart && legacy.stockVal === '8', JSON.stringify(legacy));
      // Growth editor on a property project: Add factor reveals it.
      const growthAdded = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const sel = document.querySelector('#planFactorAddSel');
        if (!sel) return false;
        sel.value = 'propertyGrowth';
        document.querySelector('#planFactorAddBtn').click();
        for (let i = 0; i < 12; i++) {
          if (document.querySelector('[data-growth="propertyGrowth"]')) return true;
          await sleep(500);
        }
        return false;
      });
      H.check('scenario restructure: Add factor reveals the property-growth editor on a property project', growthAdded);
      await page.goto(`http://ff.local/#planning/project/${edProjId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      // Scenario cards: create / rename / delete through the UI.
      await page.click('#planAddScenarioBtn');
      await waitR(300);
      await page.evaluate(() => { document.querySelector('#planScenarioName').value = 'CRUD World'; });
      await page.evaluate(() => { document.querySelector('#planScenarioForm button[type="submit"]').click(); });
      await waitR(1200);
      const crudHash = await page.evaluate(() => location.hash);
      H.check('scenario restructure: Add scenario lands on the new scenario detail page',
        crudHash.startsWith('#planning/scenario/'), crudHash);
      await page.click('#planScenarioEditBtn');
      await waitR(300);
      await page.evaluate(() => { document.querySelector('#planScenarioEditName').value = 'CRUD World Renamed'; });
      await page.evaluate(() => { document.querySelector('#planScenarioEditForm button[type="submit"]').click(); });
      await waitR(1200);
      const crudName = await page.evaluate(() => document.querySelector('#planScenario .panel h3')?.textContent || '');
      H.check('scenario restructure: scenario rename shows the new name', crudName.includes('CRUD World Renamed'), crudName);
      page.once('dialog', (d) => d.accept());
      await page.click('#planScenarioDeleteBtn');
      await waitR(1200);
      const backHash = await page.evaluate(() => location.hash);
      H.check('scenario restructure: scenario delete returns to the project page', backHash === `#planning/project/${edProjId}`, backHash);
      const crudGone = await page.evaluate(() => !(document.querySelector('#planScenarioCards')?.textContent || '').includes('CRUD World Renamed'));
      H.check('scenario restructure: deleted scenario card is gone', crudGone);
      await page.goto(`http://ff.local/#planning/project/${edProjId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      await page.click('#planAddStrategyBtn');
      await waitR(1200);
      const modal = await page.evaluate(() => ({
        presets: [...document.querySelectorAll('[data-plan-preset]')].map((c) => c.dataset.planPreset),
        oldCards: ['#planChooseTemplate', '#planChooseDescribe', '#planChooseModel', '#planChooseSaved'].some((s) => !!document.querySelector(s)),
        aiBtn: !!document.querySelector('#planChooseAi'),
      }));
      H.check('strategy editor: Add strategy modal shows property presets first, AI only as fallback, old cards gone',
        JSON.stringify(modal.presets) === JSON.stringify(['prepay', 'rate_fixed', 'rate_variable', 'refinance', 'payment_change']) && !modal.oldCards && modal.aiBtn, JSON.stringify(modal));
      const presetClicked = await page.evaluate(() => {
        const c = document.querySelector('[data-plan-preset="refinance"]');
        if (c) c.click();
        return !!c;
      });
      await waitR(800);
      const formState = await page.evaluate(() => ({
        title: document.querySelector('#planStrategyModalTitle')?.textContent || '',
        typeSel: !!document.querySelector('#planStrategyOpType'),
        back: !!document.querySelector('#planBackToPresets'),
      }));
      H.check('strategy editor: Refinance preset opens an action form titled Refinance with no type select',
        presetClicked && formState.title === 'Refinance' && !formState.typeSel && formState.back, JSON.stringify(formState));
      await page.evaluate(() => { document.querySelector('#planBackToPresets').click(); });
      await waitR(500);
      const backToPresets = await page.evaluate(() => !!document.querySelector('[data-plan-preset="prepay"]'));
      H.check('strategy editor: back button returns to the preset chooser', backToPresets);
      await page.evaluate(() => { document.querySelector('#planStrategyModal [data-close-modal]').click(); });
      await waitR(500);
      await page.goto(`http://ff.local/#planning/strategy/${edStratId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      const quick = await page.evaluate(() => [...document.querySelectorAll('[data-plan-quick-op]')].map((b) => b.dataset.planQuickOp));
      H.check('strategy editor: property strategy shows Prepay/Refinance/Rate switch/Payment change quick actions',
        JSON.stringify(quick) === JSON.stringify(['prepay', 'refinance', 'rate_switch', 'payment_change']), JSON.stringify(quick));
      const quickClicked = await page.evaluate(() => {
        const b = document.querySelector('[data-plan-quick-op="payment_change"]');
        if (b) b.click();
        return !!b;
      });
      await waitR(800);
      const quickFormState = await page.evaluate(() => ({
        title: document.querySelector('#planOpModalTitle')?.textContent || '',
        type: document.querySelector('#planOpTypeSel')?.value || '',
      }));
      H.check('strategy editor: Payment change quick action opens the op editor with payment_change preselected',
        quickClicked && quickFormState.title === 'Add operation' && quickFormState.type === 'payment_change', JSON.stringify(quickFormState));
      // ---- Optional first operation + action-form pins ----
      await page.evaluate(() => { document.querySelector('#planOpModal [data-close-modal]')?.click(); });
      await waitR(500);
      const futYm = (() => { const d = new Date(); d.setMonth(d.getMonth() + 3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
      const pickTemplateMonth = (ym) => page.evaluate((target) => {
        document.querySelector('#planStrategyModalBody [data-plan-month]').click();
        const yearEl = document.querySelector('#monthPopYear');
        let guard = 0;
        while (Number(yearEl.textContent) !== Number(target.slice(0, 4)) && guard++ < 80) {
          const btn = Number(target.slice(0, 4)) < Number(yearEl.textContent) ? document.querySelector('#monthPopPrev') : document.querySelector('#monthPopNext');
          if (!btn || btn.disabled) break;
          btn.click();
        }
        const cell = document.querySelector(`#monthPopGrid button[data-ym="${target}"]`);
        if (!cell || cell.disabled) throw new Error(`month cell ${target} not pickable`);
        cell.click();
      }, ym);
      const openActionForm = async (preset) => {
        await page.goto(`http://ff.local/#planning/project/${edProjId}`, { waitUntil: 'networkidle0', timeout: 30000 });
        await waitR(1200);
        await page.click('#planAddStrategyBtn');
        await waitR(1200);
        const clicked = await page.evaluate((p) => { const c = document.querySelector(`[data-plan-preset="${p}"]`); if (c) c.click(); return !!c; }, preset);
        await waitR(800);
        return clicked;
      };
      const setMoney = async (sel, val) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }, [sel, val]);
      // (a) bare strategy: name only, blank date
      const bareOpened = await openActionForm('prepay');
      const bareFormState = await page.evaluate(() => ({
        title: document.querySelector('#planStrategyModalTitle')?.textContent || '',
        typeSel: !!document.querySelector('#planStrategyOpType'),
        nameStar: (document.querySelector('#planStrategyModalBody')?.textContent || '').includes('Strategy name *'),
        optLabel: (document.querySelector('#planStrategyModalBody')?.textContent || '').includes('First operation (optional)'),
        dateVal: document.querySelector('#planOpDateVal')?.value || '',
      }));
      H.check('strategy editor: Prepay preset opens an action form titled Prepay, no type select, name required, op optional',
        bareOpened && bareFormState.title === 'Prepay' && !bareFormState.typeSel && bareFormState.nameStar && bareFormState.optLabel && bareFormState.dateVal === '', JSON.stringify(bareFormState));
      // ---- Month-picker pins: empty plan date opens at the current
      // year with the nearest future month highlighted; clicking it
      // fills the field, closing without picking leaves it blank ----
      const curYear = new Date().getFullYear();
      const nextYm = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
      const planOpenState = await page.evaluate(() => {
        document.querySelector('#planStrategyModalBody [data-plan-month]').click();
        return {
          year: document.querySelector('#monthPopYear')?.textContent || '',
          preYm: (document.querySelector('#monthPopGrid button.pre') || {}).dataset?.ym || '',
          dateVal: document.querySelector('#planOpDateVal')?.value || '',
        };
      });
      H.check('month picker: empty plan date opens at the current year (not 2100) with the nearest future month highlighted and the field still blank',
        planOpenState.year === String(curYear) && planOpenState.preYm === nextYm && planOpenState.dateVal === '', JSON.stringify(planOpenState));
      const planPickedState = await page.evaluate((ym) => {
        document.querySelector(`#monthPopGrid button[data-ym="${ym}"]`).click();
        return {
          popHidden: document.querySelector('#monthPop').classList.contains('hidden'),
          dateVal: document.querySelector('#planOpDateVal')?.value || '',
          btnVal: (document.querySelector('#planStrategyModalBody [data-plan-month]') || {}).dataset?.value || '',
        };
      }, nextYm);
      H.check('month picker: clicking the highlighted nearest future month fills the plan date field',
        planPickedState.popHidden && planPickedState.dateVal === `${nextYm}-01` && planPickedState.btnVal === nextYm, JSON.stringify(planPickedState));
      // Fresh blank form: close the modal left open by the pick,
      // reopen the action form, open the picker, close with Escape
      // — the field must stay blank.
      await page.evaluate(() => { document.querySelector('#planStrategyModal [data-close-modal]')?.click(); });
      await waitR(500);
      const blankAgain = await openActionForm('prepay');
      const planEscState = await page.evaluate(() => {
        document.querySelector('#planStrategyModalBody [data-plan-month]').click();
        return { openedYear: document.querySelector('#monthPopYear')?.textContent || '' };
      });
      await page.keyboard.press('Escape');
      await waitR(300);
      const planEscAfter = await page.evaluate(() => ({
        popHidden: document.querySelector('#monthPop').classList.contains('hidden'),
        dateVal: document.querySelector('#planOpDateVal')?.value || '',
      }));
      H.check('month picker: closing without picking leaves the plan date blank (bare-strategy rule survives)',
        blankAgain && planEscState.openedYear === String(curYear) && planEscAfter.popHidden && planEscAfter.dateVal === '', JSON.stringify({ ...planEscState, ...planEscAfter }));
      const bareHash = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((res2) => setTimeout(res2, ms));
        document.querySelector('#planStrategyName').value = 'Bare Strat';
        document.querySelector('#planStrategyTemplateSave').click();
        for (let i = 0; i < 20; i++) {
          if (location.hash.startsWith('#planning/strategy/')) break;
          await sleep(500);
        }
        return location.hash;
      });
      await waitR(1500);
      const bareId = Number((bareHash.match(/(\d+)$/) || [])[1] || 0);
      const barePage = await page.evaluate(() => ({
        noOps: (document.body.textContent || '').includes('No operations yet.'),
        noTemplateNote: ![...document.querySelectorAll('.note')].some((el) => (el.textContent || '').includes('Template:')),
        quick: [...document.querySelectorAll('[data-plan-quick-op]')].map((b) => b.dataset.planQuickOp),
      }));
      H.check('strategy editor: name-only action form creates a bare strategy landing on its detail page with 0 ops and no Template note',
        bareId > 0 && bareHash === `#planning/strategy/${bareId}` && barePage.noOps && barePage.noTemplateNote
        && JSON.stringify(barePage.quick) === JSON.stringify(['prepay', 'refinance', 'rate_switch', 'payment_change']), JSON.stringify({ hash: bareHash, ...barePage }));
      r = await H.req('GET', `/api/planning/strategies/${bareId}`);
      const bareCmp = r.data.comparison || {};
      H.check('strategy editor: zero-op strategy compares equal to baseline (all deltas zero)',
        r.status === 200 && (r.data.ops || []).length === 0 && bareCmp.interestSaved === 0 && bareCmp.stockGain === 0
        && bareCmp.cost === 0 && bareCmp.gain === 0 && bareCmp.net === 0 && bareCmp.payoffShiftMonths === 0 && bareCmp.paymentDelta === 0,
        JSON.stringify({ ops: (r.data.ops || []).length, cmp: bareCmp }));
      // (b) quick-action Prepay from the bare strategy
      const bareQuick = await page.evaluate(() => {
        const b = document.querySelector('[data-plan-quick-op="prepay"]');
        if (b) b.click();
        return !!b;
      });
      await waitR(800);
      const bareQuickState = await page.evaluate(() => ({
        title: document.querySelector('#planOpModalTitle')?.textContent || '',
        type: document.querySelector('#planOpTypeSel')?.value || '',
      }));
      H.check('strategy editor: Prepay quick action on a bare strategy opens the op editor with prepay preselected',
        bareQuick && bareQuickState.title === 'Add operation' && bareQuickState.type === 'prepay', JSON.stringify(bareQuickState));
      await page.evaluate(() => { document.querySelector('#planOpModal [data-close-modal]')?.click(); });
      await waitR(500);
      // Switch to fixed: Fixed rate only, creates a fixed rate_switch op
      const fixedOpened = await openActionForm('rate_fixed');
      const fixedFormState = await page.evaluate(() => {
        const fields = document.querySelector('#planStrategyOpFields');
        const radio = fields ? fields.querySelector('input[name="planOpRateType"]') : null;
        const annual = fields ? fields.querySelector('#planOpAnnualRate') : null;
        const spread = fields ? fields.querySelector('#planOpSpread') : null;
        const amort = fields ? fields.querySelector('#planOpAmortYears') : null;
        return {
          title: document.querySelector('#planStrategyModalTitle')?.textContent || '',
          radioHidden: radio ? radio.closest('div').style.display : 'missing',
          annualHidden: annual ? annual.closest('div').style.display : 'missing',
          spreadHidden: spread ? spread.closest('div').style.display : 'missing',
          checked: fields ? (fields.querySelector('input[name="planOpRateType"]:checked') || {}).value || '' : '',
          amortPresent: !!amort,
          amortBlank: amort ? amort.value === '' : false,
          amortHidden: amort ? amort.closest('div').style.display : 'missing',
        };
      });
      H.check('strategy editor: Switch to fixed form shows Fixed rate only (radios + Spread hidden, Fixed checked)',
        fixedOpened && fixedFormState.title === 'Switch to fixed' && fixedFormState.radioHidden === 'none'
        && fixedFormState.annualHidden !== 'none' && fixedFormState.spreadHidden === 'none' && fixedFormState.checked === 'fixed', JSON.stringify(fixedFormState));
      H.check('switchfix: Switch to fixed form carries a blank amortization override (fixed only)',
        fixedOpened && fixedFormState.amortPresent && fixedFormState.amortBlank && fixedFormState.amortHidden !== 'none', JSON.stringify(fixedFormState));
      await page.evaluate(() => { document.querySelector('#planStrategyName').value = 'Fixed Strat'; });
      await pickTemplateMonth(futYm);
      await waitR(500);
      const fixedDate = await page.evaluate(() => document.querySelector('#planOpDateVal')?.value || '');
      await setMoney('#planOpAnnualRate', '4.25');
      await page.evaluate(() => { document.querySelector('#planStrategyTemplateSave').click(); });
      await waitR(1500);
      const fixedHash = await page.evaluate(() => location.hash);
      const fixedId = Number((fixedHash.match(/(\d+)$/) || [])[1] || 0);
      r = await H.req('GET', `/api/planning/strategies/${fixedId}`);
      const fixedOp = (r.data.ops || [])[0] || {};
      H.check('strategy editor: Switch to fixed creates a rate_switch op with rateType fixed + annualRate',
        fixedId > 0 && fixedHash === `#planning/strategy/${fixedId}` && fixedDate === `${futYm}-01` && (r.data.ops || []).length === 1
        && fixedOp.op_type === 'rate_switch' && fixedOp.params && fixedOp.params.rateType === 'fixed' && fixedOp.params.annualRate === 4.25 && fixedOp.params.spread == null,
        JSON.stringify({ hash: fixedHash, date: fixedDate, op: fixedOp }));
      // Switch to variable: Spread only, creates a variable rate_switch op
      const varOpened = await openActionForm('rate_variable');
      const varFormState = await page.evaluate(() => {
        const fields = document.querySelector('#planStrategyOpFields');
        const radio = fields ? fields.querySelector('input[name="planOpRateType"]') : null;
        const annual = fields ? fields.querySelector('#planOpAnnualRate') : null;
        const spread = fields ? fields.querySelector('#planOpSpread') : null;
        return {
          title: document.querySelector('#planStrategyModalTitle')?.textContent || '',
          radioHidden: radio ? radio.closest('div').style.display : 'missing',
          annualHidden: annual ? annual.closest('div').style.display : 'missing',
          spreadHidden: spread ? spread.closest('div').style.display : 'missing',
          checked: fields ? (fields.querySelector('input[name="planOpRateType"]:checked') || {}).value || '' : '',
        };
      });
      H.check('strategy editor: Switch to variable form shows Spread only (radios + Fixed hidden, Variable checked)',
        varOpened && varFormState.title === 'Switch to variable' && varFormState.radioHidden === 'none'
        && varFormState.annualHidden === 'none' && varFormState.spreadHidden !== 'none' && varFormState.checked === 'variable', JSON.stringify(varFormState));
      await page.evaluate(() => { document.querySelector('#planStrategyName').value = 'Var Strat'; });
      await pickTemplateMonth(futYm);
      await waitR(500);
      await setMoney('#planOpSpread', '0.5');
      await page.evaluate(() => { document.querySelector('#planStrategyTemplateSave').click(); });
      await waitR(1500);
      const varHash = await page.evaluate(() => location.hash);
      const varId = Number((varHash.match(/(\d+)$/) || [])[1] || 0);
      r = await H.req('GET', `/api/planning/strategies/${varId}`);
      const varOp = (r.data.ops || [])[0] || {};
      H.check('strategy editor: Switch to variable creates a rate_switch op with rateType variable + spread',
        varId > 0 && varHash === `#planning/strategy/${varId}` && (r.data.ops || []).length === 1
        && varOp.op_type === 'rate_switch' && varOp.params && varOp.params.rateType === 'variable' && varOp.params.spread === 0.5 && varOp.params.annualRate == null,
        JSON.stringify({ hash: varHash, op: varOp }));
      // (c) existing path unchanged: date + amount → strategy + exactly 1 op
      const fullOpened = await openActionForm('prepay');
      await page.evaluate(() => { document.querySelector('#planStrategyName').value = 'Full Strat'; });
      await pickTemplateMonth(futYm);
      await waitR(500);
      await setMoney('#planOpAmount', '50000');
      await page.evaluate(() => { document.querySelector('#planStrategyTemplateSave').click(); });
      await waitR(1500);
      const fullHash = await page.evaluate(() => location.hash);
      const fullId = Number((fullHash.match(/(\d+)$/) || [])[1] || 0);
      r = await H.req('GET', `/api/planning/strategies/${fullId}`);
      const fullOp = (r.data.ops || [])[0] || {};
      const fullPageNoEmpty = await page.evaluate(() => !(document.body.textContent || '').includes('No operations yet.'));
      H.check('strategy editor: date + amount action form creates a strategy with exactly 1 prepay op',
        fullOpened && fullId > 0 && fullHash === `#planning/strategy/${fullId}` && (r.data.ops || []).length === 1
        && fullOp.op_type === 'prepay' && fullOp.params && fullOp.params.amount === 50000 && fullPageNoEmpty,
        JSON.stringify({ hash: fullHash, op: fullOp }));
      // (d) date filled but amount blank → error, no strategy created
      r = await H.req('GET', `/api/planning/projects/${edProjId}`);
      const countBefore = (r.data.strategies || []).length;
      const badOpened = await openActionForm('prepay');
      await page.evaluate(() => { document.querySelector('#planStrategyName').value = 'Bad Strat'; });
      await pickTemplateMonth(futYm);
      await waitR(500);
      await page.evaluate(() => { document.querySelector('#planStrategyTemplateSave').click(); });
      await waitR(1200);
      const badState = await page.evaluate(() => ({
        msg: document.querySelector('#planStrategyModalMsg')?.textContent || '',
        hash: location.hash,
        modalOpen: !!document.querySelector('#planStrategyModalBody #planStrategyName'),
      }));
      r = await H.req('GET', `/api/planning/projects/${edProjId}`);
      const countAfter = (r.data.strategies || []).length;
      H.check('strategy editor: date filled but amount blank errors and creates no strategy (rejected op rolled back)',
        badOpened && badState.msg.includes('prepay amount') && badState.hash === `#planning/project/${edProjId}` && badState.modalOpen && countAfter === countBefore,
        JSON.stringify({ ...badState, countBefore, countAfter }));
      await page.evaluate(() => { document.querySelector('#planStrategyModal [data-close-modal]')?.click(); });
      await waitR(500);
      // (e) strategy list rows show no raw template suffix
      await page.goto(`http://ff.local/#planning/project/${edProjId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      const cardTexts = await page.evaluate(() => [...document.querySelectorAll('[data-plan-strategy]')].map((el) => el.textContent || ''));
      H.check('strategy editor: strategy list rows show no raw template suffix',
        cardTexts.length >= 4 && !cardTexts.some((t) => t.includes('· prepay') || t.includes('· rate_switch')), JSON.stringify(cardTexts.map((t) => t.slice(0, 120))));
    } finally { await browserR.close(); }
  }
  r = await H.req('DELETE', `/api/planning/projects/${edProjId}`);
  H.check('strategy editor: project cleanup', r.status === 200);
  r = await H.req('DELETE', `/api/properties/${edPid}`);
  H.check('strategy editor: property cleanup', r.status === 200);

  // ---- Funding-source multi-select picker (browser) ----
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('planning source-picker browser checks skipped (puppeteer-core / probe Chrome not available)');
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
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\\s+/).filter(Boolean) : [])],
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
      // Fixtures: one account, two holdings, one strategy, two sell ops
      // (one per holding) — the buy's two sources.
      r = await H.req('POST', '/api/investments/accounts', { name: 'Picker Acct', type: 'NonRegistered' });
      const pkAcct = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${pkAcct}/holdings`, { label: 'Picker H1', kind: 'exchange', symbol: 'PKA', currency: 'CAD', events: [{ date: '2026-01-15', type: 'buy', units: 50, price: 20 }] });
      const pkH1 = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${pkAcct}/holdings`, { label: 'Picker H2', kind: 'exchange', symbol: 'PKB', currency: 'CAD', events: [{ date: '2026-01-15', type: 'buy', units: 50, price: 20 }] });
      const pkH2 = r.data.id;
      r = await H.req('POST', '/api/planning/projects', { name: 'Picker Project', question: 'q', category: 'investment', subcategory: 'stock', entity: { type: 'account', accountId: pkAcct } });
      const pkProj = r.data.project.id;
      r = await H.req('POST', `/api/planning/projects/${pkProj}/strategies`, { name: 'Picker Strat', source: 'template' });
      const pkStrat = r.data.strategy.id;
      r = await H.req('POST', `/api/planning/strategies/${pkStrat}/ops`, { op_type: 'sell', params: { holdingId: pkH1, date: '2026-12-01', units: 10, price: 20 } });
      H.check('planning picker: sell op A posted', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/planning/strategies/${pkStrat}/ops`, { op_type: 'sell', params: { holdingId: pkH2, date: '2026-12-01', units: 10, price: 20 } });
      H.check('planning picker: sell op B posted', r.status === 201, JSON.stringify(r.data));
      await page.goto(`http://ff.local/#planning/strategy/${pkStrat}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(1500);
      await page.click('#planAddOpBtn');
      await waitP(500);
      await page.select('#planOpTypeSel', 'buy');
      await waitP(500);
      const pickerBefore = await page.evaluate(() => ({
        hasBtn: !!document.querySelector('#planOpSourceBtn'),
        panelHidden: document.querySelector('#planOpSourcePanel') ? document.querySelector('#planOpSourcePanel').classList.contains('hidden') : null,
        options: [...document.querySelectorAll('#planOpSourcePanel [data-plan-op-source]')].map((el) => el.dataset.planOpSource),
        legs: [...document.querySelectorAll('#planOpLegs .plan-leg-row .plan-leg-src')].map((el) => el.value),
      }));
      H.check('planning picker: buy form shows a multi-select source picker with both sell ops',
        pickerBefore.hasBtn && pickerBefore.panelHidden === true
          && pickerBefore.options.includes('op:1') && pickerBefore.options.includes('op:2'),
        JSON.stringify(pickerBefore));
      await page.click('#planOpSourceBtn');
      await waitP(300);
      await page.evaluate(() => {
        // The new buy starts with the default cash leg checked; uncheck
        // it first (unchecking removes the leg), then check both sells.
        const cash = document.querySelector('#planOpSourcePanel [data-plan-op-source="cash"]');
        if (cash && cash.checked) cash.click();
        for (const v of ['op:1', 'op:2']) {
          const box = document.querySelector(`#planOpSourcePanel [data-plan-op-source="${v}"]`);
          if (box && !box.checked) box.click();
        }
      });
      await waitP(300);
      const pickerAfter = await page.evaluate(() => ({
        btnLabel: document.querySelector('#planOpSourceBtn') ? document.querySelector('#planOpSourceBtn').textContent : '',
        legs: [...document.querySelectorAll('#planOpLegs .plan-leg-row .plan-leg-src')].map((el) => el.value),
      }));
      H.check('planning picker: checking two sources renders two funding legs',
        pickerAfter.legs.length === 2 && pickerAfter.legs.includes('op:1') && pickerAfter.legs.includes('op:2')
          && pickerAfter.btnLabel.includes('2 sources'),
        JSON.stringify(pickerAfter));
      // Fill the buy and save: both legs validate together.
      await page.evaluate((acct) => {
        const sel = document.querySelector('#planOpAccount');
        sel.value = String(acct);
        document.querySelector('#planOpSymbol').value = 'PKC';
        document.querySelector('#planOpUnits').value = '10';
        document.querySelector('#planOpPrice').value = '20';
        document.querySelector('#planOpDateVal').value = '2026-12-01';
      }, pkAcct);
      await page.click('#planOpSaveBtn');
      await waitP(1200);
      r = await H.req('GET', `/api/planning/strategies/${pkStrat}`);
      const buyOp = (r.data.ops || []).find((o) => o.op_type === 'buy');
      H.check('planning picker: saved buy carries both funding legs',
        !!buyOp && (buyOp.legs || []).length === 2
          && (buyOp.legs || []).map((l) => l.source_ref).includes('op:1')
          && (buyOp.legs || []).map((l) => l.source_ref).includes('op:2'),
        JSON.stringify(buyOp));
      r = await H.req('DELETE', `/api/planning/projects/${pkProj}`);
      H.check('planning picker: project cleanup', r.status === 200);
    } finally { await browserP.close(); }
  }

  // ------------------------------------------- comparison views
  // Strategy detail diff section (baseline/strategy/diff columns,
  // monthly/annual toggle, All-default range with presets) + project
  // overlay trajectory, master table, Apple compare, and the
  // scenario re-pick rule for the new panels. Fully self-contained
  // fixtures: the early 'Pay down test' project is deleted by the
  // metadata cleanup above, so this block builds its own project,
  // strategy, property and prepay op.
  r = await H.req('POST', '/api/planning/projects', { name: 'Compare test', question: 'Diff then hold' });
  H.check('comparison: pin project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const cmpProjectId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${cmpProjectId}/strategies`, { name: 'Prepay 10k', source: 'template' });
  H.check('comparison: pin strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const cmpStrategyId = r.data.strategy.id;
  r = await H.req('POST', '/api/properties', {
    address: '88 Compare Test Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('comparison: pin property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const cmpPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${cmpPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('comparison: pin rate segment added', r.status === 201, JSON.stringify(r.data));
  const _cmpNow = new Date();
  const _cmpNext = new Date(Date.UTC(_cmpNow.getUTCFullYear(), _cmpNow.getUTCMonth() + 1, 1));
  const cmpOpDate = _cmpNext.toISOString().slice(0, 10);
  r = await H.req('POST', `/api/planning/strategies/${cmpStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: cmpPropId, date: cmpOpDate, amount: 10000, openClosed: 'open' },
  });
  H.check('comparison: pin prepay op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${cmpProjectId}/scenarios`, { name: 'Compare world' });
  H.check('comparison: scenario created for the pin project', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('comparison browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardC = (rq) => new Promise((resolve, reject) => {
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
    const loginResC = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueC = loginResC.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserC = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserC.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardC({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueC, domain: 'ff.local', path: '/', httpOnly: true });
      const waitC = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto(`http://ff.local/#planning/strategy/${cmpStrategyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitC(1500);
      const diff = await page.evaluate(() => ({
        panel: !!document.querySelector('#planDiffPanel'),
        head: document.querySelector('#planDiffTable thead')?.textContent || '',
        rows: document.querySelectorAll('#planDiffTable tbody tr:not(.plan-year-head):not(.plan-year-total)').length,
        chart: !!document.querySelector('#planDiffChart'),
        allActive: !!document.querySelector('[data-plan-diff-preset="all"].active'),
        presets: [...document.querySelectorAll('[data-plan-diff-preset]')].map((b) => b.dataset.planDiffPreset),
        pagerYears: [...document.querySelectorAll('#planDiffYearPager [data-plan-diff-year]')].map((b) => b.dataset.planDiffYear),
        pagerActive: document.querySelector('#planDiffYearPager [data-plan-diff-year].active')?.dataset.planDiffYear || null,
        totalRows: document.querySelectorAll('#planDiffTable tbody tr.plan-year-total').length,
      }));
      H.check('comparison: strategy detail diff section renders baseline/strategy/diff columns, All default',
        diff.panel && diff.head.includes('Baseline') && diff.head.includes('Strategy') && diff.head.includes('Δ') && diff.rows > 0 && diff.chart && diff.allActive && diff.presets.includes('all') && diff.totalRows === 1,
        JSON.stringify(diff));
      // Monthly row count vs the API month union (same union the
      // client builds: mortgage baseline/strategy + stock series).
      r = await H.req('GET', `/api/planning/strategies/${cmpStrategyId}`);
      const apiMonths = new Set();
      for (const per of Object.values((r.data.baseline.mortgage.perProperty || {}))) for (const pt of ((per.baseline && per.baseline.series) || [])) apiMonths.add(pt.month);
      for (const per of Object.values((r.data.projection.mortgage.perProperty || {}))) for (const pt of ((per.strategy && per.strategy.series) || [])) apiMonths.add(pt.month);
      for (const pt of (((r.data.baseline.stocks) || {}).series || [])) apiMonths.add(pt.month);
      for (const pt of (((r.data.projection.stocks) || {}).series || [])) apiMonths.add(pt.month);
      // Year pager semantics: the default page is the FIRST year of
      // the span (not the whole span); the pager lists every span
      // year, and paging through all years covers the full span.
      const spanYears = [...new Set([...apiMonths].map((m) => m.slice(0, 4)))].sort();
      const firstYearMonths = [...apiMonths].filter((m) => m.slice(0, 4) === spanYears[0]).length;
      H.check('cleanup: diff table pages by year — default first year, pager lists the span years',
        JSON.stringify(diff.pagerYears) === JSON.stringify(spanYears) && diff.pagerActive === spanYears[0] && diff.rows === firstYearMonths && diff.totalRows === 1,
        JSON.stringify({ pagerYears: diff.pagerYears, pagerActive: diff.pagerActive, rows: diff.rows, firstYearMonths, spanYears }));
      let pagedRows = diff.rows;
      for (const y of spanYears.slice(1)) {
        await page.click(`#planDiffYearPager [data-plan-diff-year="${y}"]`);
        await waitC(300);
        pagedRows += await page.evaluate(() => document.querySelectorAll('#planDiffTable tbody tr:not(.plan-year-head):not(.plan-year-total)').length);
      }
      H.check('cleanup: diff pager pages sum to the full projection span',
        pagedRows === apiMonths.size, JSON.stringify({ pagedRows, apiMonths: apiMonths.size }));
      await page.click(`#planDiffYearPager [data-plan-diff-year="${spanYears[0]}"]`);
      await waitC(300);
      await page.click('[data-plan-diff-preset="1y"]');
      await waitC(800);
      const shortState = await page.evaluate(() => ({
        rows: document.querySelectorAll('#planDiffTable tbody tr:not(.plan-year-head):not(.plan-year-total)').length,
        pagerYears: [...document.querySelectorAll('#planDiffYearPager [data-plan-diff-year]')].map((b) => b.dataset.planDiffYear),
      }));
      const first12Years = [...new Set([...apiMonths].sort().slice(0, 12).map((m) => m.slice(0, 4)))];
      H.check('cleanup: diff 1y preset narrows the pager to the first 12 months',
        shortState.rows > 0 && shortState.rows <= 12 && JSON.stringify(shortState.pagerYears) === JSON.stringify(first12Years),
        JSON.stringify({ shortState, first12Years }));
      await page.click('[data-plan-diff-preset="all"]');
      await waitC(800);
      const backRows = await page.evaluate(() => document.querySelectorAll('#planDiffTable tbody tr:not(.plan-year-head):not(.plan-year-total)').length);
      H.check('comparison: diff All preset restores the first-year page', backRows === diff.rows, JSON.stringify({ backRows, fullRows: diff.rows }));
      await page.click('[data-plan-diff-gran="annual"]');
      await waitC(800);
      const annual = await page.evaluate(() => ({
        head: document.querySelector('#planDiffTable thead')?.textContent || '',
        first: document.querySelector('#planDiffTable tbody tr td')?.textContent || '',
      }));
      H.check('comparison: diff annual toggle switches to year rows with Equity Δ (peak)',
        annual.head.includes('Equity Δ (peak)') && /^\d{4}$/.test(annual.first.trim()), JSON.stringify(annual));
    } finally { await browserC.close(); }
  }
  // ------------------------------------------- monthly payment scope
  // User rule 2026-11-02: the Monthly payment figure covers ONLY the
  // properties a strategy's mortgage ops touch — never the project
  // total. Self-contained fixtures: each pin project carries its own
  // mortgaged properties plus an untouched mortgaged property, so a
  // leaking total is caught even though mainline is global.
  const psFmt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const psSigned = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + psFmt(v));
  const psClose = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.005;
  const _psNow = new Date();
  const _psNext = new Date(Date.UTC(_psNow.getUTCFullYear(), _psNow.getUTCMonth() + 1, 1));
  const psOpDate = _psNext.toISOString().slice(0, 10);
  const psMkProp = async (address, balance) => {
    let rr = await H.req('POST', '/api/properties', { address, mortgage_balance: balance, mortgage_balance_date: '2026-10-01', amortization_years: 25, purchase_date: '2020-03-15' });
    H.check(`payscope: property ${address} created`, rr.status === 201 && rr.data.id > 0, JSON.stringify(rr.data));
    const pid = rr.data.id;
    rr = await H.req('POST', `/api/properties/${pid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
    H.check(`payscope: rate segment for ${address}`, rr.status === 201, JSON.stringify(rr.data));
    return pid;
  };
  const psPay = (per, pid, side) => { const s = per[pid] && per[pid][side]; return s ? s.paymentAtEffect : null; };
  // --- single-property project: label names the property, baseline +
  // strategy cells are that property alone (untouched C excluded).
  r = await H.req('POST', '/api/planning/projects', { name: 'PayScope single', question: 'Fix one' });
  H.check('payscope: single project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const ps1Proj = r.data.project.id;
  const ps1A = await psMkProp('11 PayScope A Lane, Victoria, BC', 120000);
  await psMkProp('33 PayScope C Lane, Victoria, BC', 80000);
  r = await H.req('POST', `/api/planning/projects/${ps1Proj}/strategies`, { name: 'Fix A', source: 'template' });
  H.check('payscope: single strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const ps1Strat = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${ps1Strat}/ops`, { op_type: 'rate_switch', params: { propertyId: ps1A, date: psOpDate, rateType: 'fixed', annualRate: 4.5 } });
  H.check('payscope: single rate-switch op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${ps1Proj}/scenarios`, { name: 'PS world' });
  H.check('payscope: single scenario created', r.status === 201, JSON.stringify(r.data));
  const ps1Scen = r.data.scenario && r.data.scenario.id;
  r = await H.req('GET', `/api/planning/projects/${ps1Proj}/comparison`);
  H.check('payscope: single comparison loads', r.status === 200 && r.data.strategies && r.data.strategies.length === 1, JSON.stringify(r.status));
  const ps1Row = (r.data.strategies || [])[0] || {};
  const ps1Scope = ps1Row.paymentScope || {};
  const ps1BasePer = (r.data.baseline && r.data.baseline.mortgage && r.data.baseline.mortgage.perProperty) || {};
  const ps1StratPer = (ps1Row.projection && ps1Row.projection.mortgage && ps1Row.projection.mortgage.perProperty) || {};
  const ps1TotalBase = Object.values(ps1BasePer).reduce((s, per) => s + ((per.baseline && per.baseline.paymentAtEffect) || 0), 0);
  H.check('payscope: single scope names only property A with A-only payments',
    JSON.stringify(ps1Scope.propertyIds) === JSON.stringify([ps1A])
    && ps1Scope.baseline === psPay(ps1BasePer, ps1A, 'baseline')
    && ps1Scope.strategy === psPay(ps1StratPer, ps1A, 'strategy')
    && psClose(ps1Scope.delta, ps1Scope.strategy - ps1Scope.baseline)
    && ps1Scope.baseline < ps1TotalBase
    && (ps1Scope.label || '').includes('11 PayScope A Lane'),
    JSON.stringify({ scope: ps1Scope, totalBase: ps1TotalBase }));
  // --- multi project: a two-property strategy sums exactly those two;
  // a stock-only (position) strategy shows '—' everywhere.
  r = await H.req('POST', '/api/planning/projects', { name: 'PayScope multi', question: 'Fix two, stocks third' });
  H.check('payscope: multi project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const ps2Proj = r.data.project.id;
  const ps2A = await psMkProp('44 PayScope A2 Lane, Victoria, BC', 150000);
  const ps2B = await psMkProp('55 PayScope B2 Lane, Victoria, BC', 90000);
  await psMkProp('66 PayScope C2 Lane, Victoria, BC', 70000);
  r = await H.req('POST', '/api/investments/accounts', { name: 'PS Acct', type: 'NonRegistered' });
  H.check('payscope: stock account created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const psAcct = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${psAcct}/holdings`, { label: 'PS Fund', kind: 'fund', currency: 'CAD' });
  H.check('payscope: stock holding created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const psHold = r.data.id;
  r = await H.req('POST', `/api/planning/projects/${ps2Proj}/strategies`, { name: 'Fix AB', source: 'template' });
  H.check('payscope: Fix AB strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const ps2Fix = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${ps2Fix}/ops`, { op_type: 'rate_switch', params: { propertyId: ps2A, date: psOpDate, rateType: 'fixed', annualRate: 4.5 } });
  H.check('payscope: Fix AB op A2 added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${ps2Fix}/ops`, { op_type: 'rate_switch', params: { propertyId: ps2B, date: psOpDate, rateType: 'fixed', annualRate: 4.5 } });
  H.check('payscope: Fix AB op B2 added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${ps2Proj}/strategies`, { name: 'Stocks only', source: 'template' });
  H.check('payscope: Stocks only strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const ps2Stk = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${ps2Stk}/ops`, { op_type: 'position', params: { accountId: psAcct, holdingId: psHold, units: 50, date: psOpDate } });
  H.check('payscope: Stocks only position op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${ps2Proj}/scenarios`, { name: 'PS2 world' });
  H.check('payscope: multi scenario created', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${ps2Proj}/comparison`);
  H.check('payscope: multi comparison loads', r.status === 200 && r.data.strategies && r.data.strategies.length === 2, JSON.stringify(r.status));
  const ps2FixRow = (r.data.strategies || []).find((x) => x.strategy.name === 'Fix AB') || {};
  const ps2StkRow = (r.data.strategies || []).find((x) => x.strategy.name === 'Stocks only') || {};
  const ps2Scope = ps2FixRow.paymentScope || {};
  const ps2BasePer = (r.data.baseline && r.data.baseline.mortgage && r.data.baseline.mortgage.perProperty) || {};
  const ps2FixPer = (ps2FixRow.projection && ps2FixRow.projection.mortgage && ps2FixRow.projection.mortgage.perProperty) || {};
  const ps2TotalBase = Object.values(ps2BasePer).reduce((s, per) => s + ((per.baseline && per.baseline.paymentAtEffect) || 0), 0);
  const ps2ExpBase = (psPay(ps2BasePer, ps2A, 'baseline') || 0) + (psPay(ps2BasePer, ps2B, 'baseline') || 0);
  const ps2ExpStrat = (psPay(ps2FixPer, ps2A, 'strategy') || 0) + (psPay(ps2FixPer, ps2B, 'strategy') || 0);
  H.check('payscope: two-property scope sums exactly A2 + B2 (C2 excluded)',
    JSON.stringify(ps2Scope.propertyIds) === JSON.stringify([ps2A, ps2B])
    && psClose(ps2Scope.baseline, ps2ExpBase) && psClose(ps2Scope.strategy, ps2ExpStrat)
    && psClose(ps2Scope.delta, ps2Scope.strategy - ps2Scope.baseline)
    && ps2Scope.baseline < ps2TotalBase,
    JSON.stringify({ scope: ps2Scope, expBase: ps2ExpBase, totalBase: ps2TotalBase }));
  const ps2StkScope = ps2StkRow.paymentScope || {};
  H.check('payscope: stock-only scope is empty with null payments',
    JSON.stringify(ps2StkScope.propertyIds) === JSON.stringify([])
    && ps2StkScope.baseline == null && ps2StkScope.strategy == null && ps2StkScope.delta == null,
    JSON.stringify(ps2StkScope));
  // Legacy-table proof: the old summed delta for the stock-only row
  // is 0 (every payment unchanged), which the legacy table used to
  // render as '+$0.00'; the scoped delta is null, so it renders '—'.
  H.check('payscope: legacy stock-only delta is summed 0 but scoped null',
    ps2StkRow.comparison && ps2StkRow.comparison.paymentDelta === 0 && ps2StkScope.delta == null,
    JSON.stringify({ summed: ps2StkRow.comparison && ps2StkRow.comparison.paymentDelta, scoped: ps2StkScope.delta }));
  // --- switch-to-fixed (user rule 2026-11-02): the payment
  // re-derives from the current outstanding balance over the
  // remaining amortization; a pure switch does not move the
  // payoff; a variable switch keeps the payment; an override
  // re-amortizes over X years; refinance amortizationYears
  // drives its payment. Fixture terms start 2026-10-01 at 25y
  // (psMkProp), so the remaining amortization at the switch
  // state point is 300 minus the months from 2026-10 to it.
  const sfIdx = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
  const sfSwitchYm = psOpDate.slice(0, 7);
  const sfStateYm = (() => { const d = new Date(Date.UTC(Number(sfSwitchYm.slice(0, 4)), Number(sfSwitchYm.slice(5, 7)) - 2, 1)); return d.toISOString().slice(0, 7); })();
  const sfRemaining = 300 - (sfIdx(sfStateYm) - sfIdx('2026-10'));
  r = await H.req('POST', '/api/planning/projects', { name: 'SwitchFix', question: 'Fix or keep' });
  H.check('switchfix: project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const sfProj = r.data.project.id;
  const sfA = await psMkProp('77 SwitchFix Lane, Victoria, BC', 200000);
  const sfMkStrat = async (name, op) => {
    let rr = await H.req('POST', `/api/planning/projects/${sfProj}/strategies`, { name, source: 'template' });
    H.check(`switchfix: strategy ${name} created`, rr.status === 201 && rr.data.strategy && rr.data.strategy.id > 0, JSON.stringify(rr.data));
    const sid = rr.data.strategy.id;
    rr = await H.req('POST', `/api/planning/strategies/${sid}/ops`, op);
    H.check(`switchfix: strategy ${name} op added`, rr.status === 201, JSON.stringify(rr.data));
    return sid;
  };
  const sfFix = await sfMkStrat('Fix default', { op_type: 'rate_switch', params: { propertyId: sfA, date: psOpDate, rateType: 'fixed', annualRate: 4.5 } });
  const sfOver = await sfMkStrat('Fix 10y', { op_type: 'rate_switch', params: { propertyId: sfA, date: psOpDate, rateType: 'fixed', annualRate: 4.5, amortizationYears: 10 } });
  const sfVar = await sfMkStrat('To variable', { op_type: 'rate_switch', params: { propertyId: sfA, date: psOpDate, rateType: 'variable', spread: -1.0 } });
  const sfRef20 = await sfMkStrat('Refi 20y', { op_type: 'refinance', params: { propertyId: sfA, date: psOpDate, termMonths: 60, amortizationYears: 20, rateType: 'fixed', annualRate: 4.0 } });
  const sfRef25 = await sfMkStrat('Refi 25y', { op_type: 'refinance', params: { propertyId: sfA, date: psOpDate, termMonths: 60, amortizationYears: 25, rateType: 'fixed', annualRate: 4.0 } });
  r = await H.req('POST', `/api/planning/projects/${sfProj}/scenarios`, { name: 'SF world' });
  H.check('switchfix: scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${sfProj}/comparison`);
  H.check('switchfix: comparison loads', r.status === 200 && r.data.strategies && r.data.strategies.length === 5, JSON.stringify(r.status));
  const sfBasePer = (r.data.baseline && r.data.baseline.mortgage && r.data.baseline.mortgage.perProperty) || {};
  const sfRow = (name) => (r.data.strategies || []).find((x) => x.strategy.name === name) || {};
  const sfPer = (name) => { const row = sfRow(name); return (row.projection && row.projection.mortgage && row.projection.mortgage.perProperty) || {}; };
  const sfBasePay = psPay(sfBasePer, sfA, 'baseline');
  const sfBaseOff = (sfBasePer[sfA] && sfBasePer[sfA].baseline && sfBasePer[sfA].baseline.payoffMonth) || null;
  const sfSeries = (name) => { const per = sfPer(name); return (per[sfA] && per[sfA].strategy && per[sfA].strategy.series) || []; };
  const sfStateBal = (() => { const row = sfSeries('Fix default').find((x) => x.month === sfStateYm); return row ? row.balance : null; })();
  const sfExpFix = sfStateBal != null ? derivePayment(sfStateBal, 4.5, sfRemaining / 12, 'semi_annual') : null;
  const sfFixPay = psPay(sfPer('Fix default'), sfA, 'strategy');
  const sfFixOff = (sfPer('Fix default')[sfA] && sfPer('Fix default')[sfA].strategy && sfPer('Fix default')[sfA].strategy.payoffMonth) || null;
  H.check('switchfix: pure fixed switch re-derives over remaining amortization and keeps the payoff',
    sfStateBal != null && sfExpFix != null && Math.abs(sfFixPay - sfExpFix) < 0.02 && sfFixPay !== sfBasePay && sfFixOff === sfBaseOff,
    JSON.stringify({ stateBal: sfStateBal, remaining: sfRemaining, expected: sfExpFix, strategy: sfFixPay, baseline: sfBasePay, payoff: sfFixOff, basePayoff: sfBaseOff }));
  const sfOverPay = psPay(sfPer('Fix 10y'), sfA, 'strategy');
  const sfOverOff = (sfPer('Fix 10y')[sfA] && sfPer('Fix 10y')[sfA].strategy && sfPer('Fix 10y')[sfA].strategy.payoffMonth) || null;
  const sfOverIdx = sfOverOff ? sfIdx(sfOverOff) - sfIdx(sfSwitchYm) : null;
  // The switch month is payment #1 of the 120, so the last
  // payment falls at switch + 119 months; a cent-rounding
  // stub month can push the payoff to switch + 120.
  H.check('switchfix: fixed switch with a 10y override re-amortizes over 10 years',
    sfStateBal != null && Math.abs(sfOverPay - derivePayment(sfStateBal, 4.5, 10, 'semi_annual')) < 0.02 && (sfOverIdx === 119 || sfOverIdx === 120),
    JSON.stringify({ strategy: sfOverPay, expected: sfStateBal != null ? derivePayment(sfStateBal, 4.5, 10, 'semi_annual') : null, payoff: sfOverOff, monthsOut: sfOverIdx }));
  const sfVarRow = sfSeries('To variable').find((x) => x.month === sfSwitchYm);
  const sfVarPay = psPay(sfPer('To variable'), sfA, 'strategy');
  H.check('switchfix: variable switch keeps the payment and reprices only the split',
    sfVarRow && sfVarRow.rateType === 'variable' && Math.abs(sfVarRow.rate - 3.95) < 0.01 && sfVarPay === sfBasePay,
    JSON.stringify({ row: sfVarRow, strategy: sfVarPay, baseline: sfBasePay }));
  const sfRef20Pay = psPay(sfPer('Refi 20y'), sfA, 'strategy');
  const sfRef25Pay = psPay(sfPer('Refi 25y'), sfA, 'strategy');
  H.check('switchfix: refinance amortizationYears drives the payment (20y above 25y, both on formula)',
    sfStateBal != null && Math.abs(sfRef20Pay - derivePayment(sfStateBal, 4.0, 20, 'semi_annual')) < 0.02
    && Math.abs(sfRef25Pay - derivePayment(sfStateBal, 4.0, 25, 'semi_annual')) < 0.02 && sfRef20Pay > sfRef25Pay,
    JSON.stringify({ ref20: sfRef20Pay, ref25: sfRef25Pay, stateBal: sfStateBal }));
  r = await H.req('POST', `/api/planning/strategies/${sfOver}/merge-preview`, {});
  const sfWrites = (r.data && r.data.writes) || [];
  const sfTerm = sfWrites.find((w) => w.kind === 'insert' && w.table === 'mortgage_terms');
  H.check('switchfix: merge preview for the override switch inserts a 10y split term',
    r.status === 200 && sfTerm && sfTerm.values && sfTerm.values.start_date === psOpDate && sfTerm.values.amortization_years === 10 && sfTerm.values.payment_override == null,
    JSON.stringify({ status: r.status, term: sfTerm }));
  // Report view for the single project: same scoped payment.
  r = await H.req('POST', `/api/planning/projects/${ps1Proj}/reports`, { name: 'PS report', definition: { strategies: [ps1Strat], charts: [{ template: 'time_line', title: 'T', series: ['mortgage_balance'] }] }, strategy_ids: [ps1Strat], scenario_ids: [ps1Scen] });
  H.check('payscope: single report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const ps1Rep = r.data.report.id;
  const ps1Exp = { baseline: psFmt(ps1Scope.baseline), strategy: psFmt(ps1Scope.strategy), delta: psSigned(ps1Scope.delta) };
  const ps2Exp = { baseline: psFmt(ps2Scope.baseline), strategy: psFmt(ps2Scope.strategy), delta: psSigned(ps2Scope.delta) };
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('payscope browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardPS = (rq) => new Promise((resolve, reject) => {
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
    const loginResPS = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValuePS = loginResPS.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserPS = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserPS.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardPS({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValuePS, domain: 'ff.local', path: '/', httpOnly: true });
      const waitPS = (ms) => new Promise((res2) => setTimeout(res2, ms));
      // Merged table: baseline cell is plain text; each strategy cell
      // carries absolute + delta as two divs (stock-only: single '—').
      const readMergedPayRow = async (sel) => page.evaluate((sel2) => {
        const tr = [...document.querySelectorAll(`${sel2} tbody tr`)].find((x) => (x.cells[0]?.textContent || '').startsWith('Monthly payment'));
        if (!tr) return null;
        const cols = [...tr.cells].slice(2).map((c) => {
          const ds = [...c.querySelectorAll('div')].map((d) => d.textContent.trim());
          return ds.length >= 2 ? { abs: ds[0], delta: ds[1] } : { abs: c.textContent.trim(), delta: null };
        });
        return { label: tr.cells[0].textContent, baseline: tr.cells[1] ? tr.cells[1].textContent.trim() : null, cols };
      }, sel);
      await page.goto(`http://ff.local/#planning/report/${ps1Proj}/${ps1Rep}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitPS(2500);
      const psRepMerged = await readMergedPayRow('#planReportMergedTable');
      H.check('payscope: report view merged row names A with A-only absolute + delta',
        psRepMerged && psRepMerged.label.includes('11 PayScope A Lane')
        && psRepMerged.baseline === ps1Exp.baseline && psRepMerged.cols[0].abs === ps1Exp.strategy && psRepMerged.cols[0].delta === ps1Exp.delta,
        JSON.stringify({ merged: psRepMerged, exp: ps1Exp }));
    } finally { await browserPS.close(); }
  }
  // ------------------------------------------- property net excludes stockGain
  // Property-category strategies exclude stockGain from gain AND net
  // (net = gain − cost still holds); stockGain stays computed and is
  // shown separately. Investment-category strategies keep stockGain
  // inside gain/net. Scoping is by project category, so a mixed
  // mortgage + stock strategy in a property project follows the
  // property rule. Fixtures: a fund holding with a buy event + one
  // NAV price (flat $31 path — a single point has no growth window),
  // a mortgaged property, and a position op (strategy-only stock
  // exposure, no funding legs) that books stockGain without moving
  // the baseline trajectory. (A scenario stock factor alone cannot
  // produce nonzero stockGain: it reprices baseline and strategy
  // together by design — the exclusion operates on the computed
  // stockGain figure regardless of its source.)
  r = await H.req('POST', '/api/investments/accounts', { name: 'SG Test', type: 'NonRegistered' });
  H.check('stockgain: pin account created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const sgAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${sgAcctId}/holdings`, { label: 'SG Fund', kind: 'fund', currency: 'CAD' });
  H.check('stockgain: pin fund holding created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const sgHoldingId = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${sgHoldingId}/events`, { date: '2026-01-12', type: 'buy', units: 100, price: 30 });
  H.check('stockgain: pin fund buy recorded', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${sgHoldingId}/nav`, { date: '2026-01-31', price: 31 });
  H.check('stockgain: pin fund NAV recorded', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', {
    address: '55 StockGain Test Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('stockgain: pin property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const sgPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${sgPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('stockgain: pin rate segment added', r.status === 201, JSON.stringify(r.data));
  const _sgNow = new Date();
  const _sgNext = new Date(Date.UTC(_sgNow.getUTCFullYear(), _sgNow.getUTCMonth() + 1, 1));
  const sgOpDate = _sgNext.toISOString().slice(0, 10);
  r = await H.req('POST', '/api/planning/projects', { name: 'SG property', question: 'Mixed then hold', category: 'property', subcategory: 'interest_rate', entity: { type: 'property', propertyId: sgPropId } });
  H.check('stockgain: property project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const sgPropProjectId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${sgPropProjectId}/strategies`, { name: 'Prepay + position', source: 'template' });
  H.check('stockgain: property strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const sgPropStrategyId = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${sgPropStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: sgPropId, date: sgOpDate, amount: 10000, openClosed: 'open' },
  });
  H.check('stockgain: property prepay op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${sgPropStrategyId}/ops`, {
    op_type: 'position',
    params: { accountId: sgAcctId, holdingId: sgHoldingId, units: 50, date: sgOpDate },
  });
  H.check('stockgain: property position op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${sgPropProjectId}/scenarios`, { name: 'SG world' });
  H.check('stockgain: scenario created for the property project', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const sgScenId = r.data.scenario.id;
  r = await H.req('POST', `/api/planning/projects/${sgPropProjectId}/reports`, { name: 'SG report', definition: { strategies: [sgPropStrategyId], charts: [] }, baseline_id: null, strategy_ids: [sgPropStrategyId], scenario_ids: [sgScenId] });
  H.check('stockgain: pin report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const sgRepId = r.data.report.id;
  r = await H.req('GET', `/api/planning/strategies/${sgPropStrategyId}`);
  const sgC = (r.data && r.data.comparison) || {};
  const sgClose = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.005;
  H.check('stockgain: mixed property strategy books nonzero stockGain', sgC.stockGain > 0, JSON.stringify(sgC));
  H.check('stockgain: property gain excludes stockGain (gain == interest saved)', sgClose(sgC.gain, sgC.interestSaved) && sgC.interestSaved > 0, JSON.stringify(sgC));
  H.check('stockgain: property net = gain − cost to the cent', sgClose(sgC.net, sgC.gain - sgC.cost) && sgC.cost === 10000, JSON.stringify(sgC));
  r = await H.req('POST', '/api/planning/projects', { name: 'SG investment', question: 'Position then hold', category: 'investment', subcategory: 'stock', entity: { type: 'account', accountId: sgAcctId } });
  H.check('stockgain: investment project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const sgInvProjectId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${sgInvProjectId}/strategies`, { name: 'Position only', source: 'template' });
  H.check('stockgain: investment strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const sgInvStrategyId = r.data.strategy.id;
  r = await H.req('POST', `/api/planning/strategies/${sgInvStrategyId}/ops`, {
    op_type: 'position',
    params: { accountId: sgAcctId, holdingId: sgHoldingId, units: 50, date: sgOpDate },
  });
  H.check('stockgain: investment position op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/strategies/${sgInvStrategyId}`);
  const sgI = (r.data && r.data.comparison) || {};
  H.check('stockgain: investment gain keeps stockGain inside (gain == interest saved + stockGain)', sgI.stockGain > 0 && sgClose(sgI.gain, (sgI.interestSaved || 0) + sgI.stockGain), JSON.stringify(sgI));
  H.check('stockgain: investment net = gain − cost to the cent', sgClose(sgI.net, sgI.gain - sgI.cost), JSON.stringify(sgI));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('stockgain browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardSG = (rq) => new Promise((resolve, reject) => {
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
    const loginResSG = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueSG = loginResSG.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserSG = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const pageSG = await browserSG.newPage();
      const clientSG = await pageSG.target().createCDPSession();
      await clientSG.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      clientSG.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await clientSG.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardSG({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await clientSG.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await clientSG.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await clientSG.send('Network.setCookie', { name: 'ff_session', value: cookieValueSG, domain: 'ff.local', path: '/', httpOnly: true });
      const waitSG = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await pageSG.goto(`http://ff.local/#planning/strategy/${sgPropStrategyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitSG(1500);
      const sgCards = await pageSG.evaluate(() => [...document.querySelectorAll('.breakdown-card')].map((c) => ({ k: c.querySelector('.k')?.textContent || '', v: c.querySelector('.v')?.textContent || '' })));
      const sgCard = sgCards.find((c) => c.k === 'Stock gain');
      H.check('stockgain: strategy detail shows Stock gain as its own card', !!sgCard && sgCard.v !== '—' && sgCard.v !== '', JSON.stringify(sgCards));
      await pageSG.goto(`http://ff.local/#planning/report/${sgPropProjectId}/${sgRepId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitSG(2500);
      const sgRepMerged = await pageSG.evaluate(() => document.querySelector('#planReportMergedTable')?.textContent || '');
      H.check('stockgain: report merged table shows a Stock gain row', sgRepMerged.includes('Stock gain'),
        JSON.stringify(sgRepMerged.slice(0, 200)));
    } finally { await browserSG.close(); }
  }
  // ------------------------------------------- report + templates
  // Pinned scenario/baseline/strategy for report generation (never a
  // silent fallback), template recommendation slots (populated from
  // real entity data, scenario empty), AI chart methods, the
  // comparison component inside project reports, the strategy detail
  // report panel, and the Baselines AI entry point. Self-contained
  // fixtures, built after the comparison pins.
  r = await H.req('POST', '/api/properties', {
    address: '77 Report Test Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('report: pin property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const repPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${repPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('report: pin rate segment added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', '/api/planning/projects', { name: 'Report test', question: 'Pin then report' });
  H.check('report: pin project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const repProjectId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/strategies`, { name: 'Prepay 10k', source: 'template' });
  H.check('report: pin strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const repStrategyId = r.data.strategy.id;
  const _repNow = new Date();
  const _repNext = new Date(Date.UTC(_repNow.getUTCFullYear(), _repNow.getUTCMonth() + 1, 1));
  const repOpDate = _repNext.toISOString().slice(0, 10);
  r = await H.req('POST', `/api/planning/strategies/${repStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: repPropId, date: repOpDate, amount: 10000, openClosed: 'open' },
  });
  H.check('report: pin prepay op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/scenarios`, { name: 'Report world' });
  H.check('report: pin scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const repScenId = r.data.scenario.id;
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/scenarios`, { name: 'Report world 2' });
  H.check('report: pin second scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const repScen2Id = r.data.scenario.id;
  // Template recommendation slots: baseline + strategy populated from
  // the entity's real figures, scenario slot empty (never invented).
  r = await H.req('POST', '/api/planning/recommendations', { category: 'property', entity: { type: 'property', propertyId: repPropId } });
  const repRec = (r.data.recommendations || {}).refinance || {};
  H.check('report: template recommendation slots (real figures, scenario empty)',
    r.status === 200 && repRec.baseline && repRec.baseline.figures && repRec.baseline.figures.balance === 100000
      && repRec.strategy && !!repRec.strategy.name && repRec.scenario === null,
    JSON.stringify(repRec));
  const repDef = { strategies: [repStrategyId], charts: [{ template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }] };
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/reports`, { name: 'Unpinned report', definition: repDef, strategy_ids: [repStrategyId] });
  H.check('report: save without pinned scenarios is rejected on a project with scenarios',
    r.status === 400 && JSON.stringify(r.data).includes('pin at least one scenario'), JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/reports`, { name: 'Unknown scenario report', definition: repDef, strategy_ids: [repStrategyId], scenario_ids: [999999] });
  H.check('report: unknown pinned scenario is rejected',
    r.status === 400 && JSON.stringify(r.data).includes('not in this project'), JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/reports`, { name: 'Pinned report', definition: repDef, strategy_ids: [repStrategyId], scenario_ids: [repScenId] });
  H.check('report: pinned save works', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const repPinId = r.data.report.id;
  r = await H.req('GET', `/api/planning/projects/${repProjectId}`);
  const repPinRow = (r.data.reports || []).find((x) => x.id === repPinId);
  H.check('report: pinned scenario ids stored',
    !!repPinRow && JSON.stringify(repPinRow.scenarioIds) === JSON.stringify([repScenId]), JSON.stringify(repPinRow && repPinRow.scenarioIds));
  r = await H.req('PUT', `/api/planning/reports/${repPinId}`, { scenario_ids: [repScen2Id] });
  H.check('report: re-pin to another scenario works', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${repProjectId}`);
  const repPinRow2 = (r.data.reports || []).find((x) => x.id === repPinId);
  H.check('report: re-pinned scenario ids stored',
    !!repPinRow2 && JSON.stringify(repPinRow2.scenarioIds) === JSON.stringify([repScen2Id]), JSON.stringify(repPinRow2 && repPinRow2.scenarioIds));
  const repMethodDef = { strategies: [repStrategyId], charts: [{ template: 'time_line', title: 'Balance path', series: ['mortgage_balance'], method: 'Monthly outstanding principal from the engine projection, baseline vs strategy.' }] };
  r = await H.req('POST', `/api/planning/projects/${repProjectId}/reports`, { name: 'Method report', definition: repMethodDef, strategy_ids: [repStrategyId], scenario_ids: [repScenId] });
  H.check('report: method-carrying report saves', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const repMethodId = r.data.report.id;
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('report browser checks skipped (puppeteer-core / probe Chrome not available)');
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
    const browserP2 = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserP2.newPage();
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
      await page.goto(`http://ff.local/#planning/project/${repProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(1200);
      const aiBaseBtn = await page.evaluate(() => !!document.querySelector('#planAiBaselineBtn'));
      H.check('report: Baselines section has a Design with AI entry', aiBaseBtn);
      await page.click('#planAddReportBtn');
      await waitP(400);
      const picker = await page.evaluate(() => {
        const host = document.querySelector('#planReportSaveScenarios');
        const boxes = host ? [...host.querySelectorAll('input:checked')].map((el) => el.parentElement.textContent.trim()) : [];
        return { open: !document.querySelector('#planReportSaveModal').classList.contains('hidden'), checked: boxes };
      });
      H.check('report: save modal shows the scenario picker with the base pre-checked',
        picker.open && picker.checked.some((t) => t.includes('Report world')), JSON.stringify(picker));
      await page.evaluate(() => { document.querySelectorAll('#planReportSaveScenarios input:checked').forEach((el) => el.click()); });
      await page.type('#planReportSaveName', 'Report browser');
      await page.click('#planReportSaveBtn');
      await waitP(600);
      const pinPrompt = await page.evaluate(() => {
        const msg = document.querySelector('#planReportSaveMsg');
        return { text: msg ? msg.textContent : '', stillOpen: !document.querySelector('#planReportSaveModal').classList.contains('hidden') };
      });
      H.check('report: saving with no scenario pinned shows the pin prompt and saves nothing',
        pinPrompt.stillOpen && /Pin at least one scenario/i.test(pinPrompt.text), JSON.stringify(pinPrompt));
      await page.evaluate(() => { document.querySelector('#planReportSaveScenarios input').click(); });
      await page.click('#planReportSaveBtn');
      await waitP(1200);
      const listed = await page.evaluate(() => document.querySelector('#planReportList').textContent.includes('Report browser'));
      H.check('report: pinned save from the modal appears in the Reports list', listed);
      // Pinned report view: world label + method line + comparison component.
      await page.goto(`http://ff.local/#planning/report/${repProjectId}/${repMethodId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(2500);
      const view = await page.evaluate(() => {
        const el = document.querySelector('#planReport');
        const t = el ? el.textContent : '';
        return {
          hash: location.hash, world: t.includes('Under Report world'), method: t.includes('Monthly outstanding principal from the engine projection'),
          traj: !!document.querySelector('#planReportTrajectoryChart'), merged: (document.querySelector('#planReportMergedTable')?.textContent || '').includes('Baseline'),
          mergedPay: (document.querySelector('#planReportMergedTable')?.textContent || '').includes('Monthly payment'),
        };
      });
      H.check('report: pinned view renders under its scenario with method line + comparison component',
        view.hash.startsWith('#planning/project/') && view.world && view.method && view.traj && view.merged && view.mergedPay, JSON.stringify(view));
      // Deleted pinned scenario re-opens the pin panel; re-pinning restores the view.
      // (The base scenario cannot be deleted, so the second scenario becomes base first.)
      r = await H.req('POST', `/api/planning/scenarios/${repScen2Id}/set-base`, {});
      H.check('report: second scenario set as base', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/planning/scenarios/${repScenId}`);
      H.check('report: pinned scenario deleted', r.status === 200, JSON.stringify(r.data));
      // Same-hash goto fires no route change, so leave the report view
      // first and come back — otherwise the stale render would persist.
      await page.goto(`http://ff.local/#planning/project/${repProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(800);
      await page.goto(`http://ff.local/#planning/report/${repProjectId}/${repMethodId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(2500);
      const pinPanel = await page.evaluate(() => ({
        hash: location.hash,
        text: document.querySelector('#planReport') ? document.querySelector('#planReport').textContent : '',
        boxes: !!document.querySelector('#planReportPinScenarios'),
      }));
      H.check('report: deleted pinned scenario shows the pin panel, not silent numbers',
        pinPanel.hash.startsWith('#planning/project/') && pinPanel.boxes && /deleted/i.test(pinPanel.text), JSON.stringify(pinPanel));
      await page.click('#planReportPinBtn');
      await waitP(1500);
      const repinned = await page.evaluate(() => {
        const t = document.querySelector('#planReport') ? document.querySelector('#planReport').textContent : '';
        return { world2: t.includes('Under Report world 2'), traj: !!document.querySelector('#planReportTrajectoryChart') };
      });
      H.check('report: re-pinned view renders under the new scenario',
        repinned.world2 && repinned.traj, JSON.stringify(repinned));
      // Strategy detail report panel: current strategy × pinned scenarios.
      await page.goto(`http://ff.local/#planning/strategy/${repStrategyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(1500);
      const detailPanel = await page.evaluate(() => ({
        panel: !!document.querySelector('#planStrategyReportPanel'),
        scen: (document.querySelector('#planStrategyReportScenarios')?.textContent || '').includes('Report world 2'),
      }));
      H.check('report: strategy detail has a Report panel with the pinned scenarios', detailPanel.panel && detailPanel.scen, JSON.stringify(detailPanel));
      await page.click('#planStrategyReportBtn');
      await waitP(2500);
      const detailReport = await page.evaluate(() => ({
        hash: location.hash,
        strat: (document.querySelector('#planReport')?.textContent || '').includes('Prepay 10k'),
      }));
      H.check('report: strategy detail Generate opens a report scoped to the current strategy',
        detailReport.hash.startsWith('#planning/project/') && detailReport.strat, JSON.stringify(detailReport));
      // Baselines AI entry: propose → preview → Apply appends a baseline.
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ description: 'AI baseline test', assumptions: [{ key: 'note', value: 'test' }] }));
      await page.goto(`http://ff.local/#planning/project/${repProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitP(1200);
      await page.click('#planAiBaselineBtn');
      await waitP(400);
      await page.type('#planBaselineAiText', 'A plain do-nothing baseline');
      await page.click('#planBaselineAiGoBtn');
      await waitP(1500);
      const basePreview = await page.evaluate(() => ({
        text: document.querySelector('#planBaselineAiOut') ? document.querySelector('#planBaselineAiOut').textContent : '',
        apply: !!document.querySelector('#planBaselineAiApplyBtn'),
      }));
      H.check('report: baseline AI preview shows the proposed baseline before Apply',
        basePreview.apply && basePreview.text.includes('AI baseline test'), JSON.stringify(basePreview));
      await page.click('#planBaselineAiApplyBtn');
      await waitP(1200);
      const baseListed = await page.evaluate(() => (document.querySelector('#planBaselineCards')?.textContent || '').includes('AI baseline test'));
      H.check('report: applied AI baseline joins the Baselines list', baseListed);
    } finally { await browserP2.close(); }
  }
  // ------------------------------------------- strategy page redesign
  // The detail page holds only fillable things, each with Edit +
  // Delete: header rename + delete, op rows, funding-leg sub-rows,
  // sink view/edit/delete, AI spec detach, collapsed model thread.
  // Strategy cards are click-to-navigate only (the old card Edit
  // button just re-navigated — that bug is fixed by removing the
  // toolbar, not by making it do something else). Self-contained.
  const _rdNow = new Date();
  const _rdNext = new Date(Date.UTC(_rdNow.getUTCFullYear(), _rdNow.getUTCMonth() + 1, 1));
  const rdOpDate = _rdNext.toISOString().slice(0, 10);
  r = await H.req('POST', '/api/planning/projects', { name: 'Redesign test', question: 'Straightforward page' });
  H.check('redesign: pin project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const rdProjectId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${rdProjectId}/strategies`, { name: 'Redesign strat', source: 'template' });
  H.check('redesign: pin strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const rdStrategyId = r.data.strategy.id;
  r = await H.req('POST', '/api/properties', {
    address: '99 Redesign Test Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('redesign: pin property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const rdPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${rdPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('redesign: pin rate segment added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/strategies/${rdStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: rdPropId, date: rdOpDate, amount: 10000, openClosed: 'open' },
  });
  H.check('redesign: pin prepay op added', r.status === 201 && r.data.op && r.data.op.id > 0, JSON.stringify(r.data));
  const rdPrepayOpId = r.data.op.id;
  r = await H.req('POST', '/api/investments/accounts', { name: 'Redesign Acct', type: 'NonRegistered' });
  H.check('redesign: pin account created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const rdAcctId = r.data.id;
  r = await H.req('POST', `/api/planning/strategies/${rdStrategyId}/ops`, {
    op_type: 'buy',
    params: { accountId: rdAcctId, symbol: 'RDTEST', date: rdOpDate, amount: 5000, price: 50 },
    legs: [{ source_ref: 'cash', amount: 'remainder' }, { source_ref: 'pot', amount: 100 }],
  });
  H.check('redesign: pin buy op with two legs added', r.status === 201 && r.data.op && r.data.op.id > 0, JSON.stringify(r.data));
  const rdBuyOpId = r.data.op.id;
  r = await H.req('GET', `/api/planning/strategies/${rdStrategyId}`);
  H.check('redesign: buy op carries both legs from the API',
    r.status === 200 && (r.data.ops || []).find((o) => o.id === rdBuyOpId) && ((r.data.ops || []).find((o) => o.id === rdBuyOpId).legs || []).length === 2,
    JSON.stringify((r.data.ops || []).map((o) => [o.id, (o.legs || []).length])));
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('redesign browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardR = (rq) => new Promise((resolve, reject) => {
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
    const loginResR = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueR = loginResR.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserR = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserR.newPage();
      page.on('dialog', (d) => d.accept());
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardR({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueR, domain: 'ff.local', path: '/', httpOnly: true });
      const waitR = (ms) => new Promise((res2) => setTimeout(res2, ms));
      // Card: no toolbar, click navigates to the detail page.
      await page.goto(`http://ff.local/#planning/project/${rdProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      const card = await page.evaluate((sid) => {
        const el = document.querySelector(`[data-plan-strategy="${sid}"]`);
        return { found: !!el, edit: !!el?.querySelector('[data-plan-strategy-edit]'), del: !!el?.querySelector('[data-plan-strategy-del]') };
      }, rdStrategyId);
      H.check('redesign: strategy card has no toolbar buttons', card.found && !card.edit && !card.del, JSON.stringify(card));
      await page.evaluate((sid) => { document.querySelector(`[data-plan-strategy="${sid}"]`).click(); }, rdStrategyId);
      await waitR(1500);
      const landedDetail = await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('#planStrategyTitle')?.textContent || '' }));
      H.check('redesign: clicking the card navigates to the strategy detail page',
        landedDetail.hash === `#planning/strategy/${rdStrategyId}` && landedDetail.title.includes('Redesign strat'), JSON.stringify(landedDetail));
      // Header rename: Edit swaps the title for an input + Save.
      await page.click('#planStrategyRenameBtn');
      await waitR(400);
      const renameInput = await page.evaluate(() => !!document.querySelector('#planStrategyNameInput'));
      H.check('redesign: header Edit opens a rename input', renameInput);
      await page.click('#planStrategyNameInput');
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.type('#planStrategyNameInput', 'Redesign renamed');
      await page.click('#planStrategyRenameSave');
      await waitR(1200);
      const renamed = await page.evaluate(() => document.querySelector('#planStrategyTitle')?.textContent || '');
      H.check('redesign: header rename saves and shows the new name', renamed.includes('Redesign renamed'), JSON.stringify(renamed));
      // Op row Edit: modal opens, amount change persists.
      await page.evaluate((oid) => { document.querySelector(`[data-plan-op-edit="${oid}"]`).click(); }, rdPrepayOpId);
      await waitR(800);
      const opModal = await page.evaluate(() => ({ title: document.querySelector('#planOpModalTitle')?.textContent || '', amount: document.querySelector('#planOpAmount')?.value || '' }));
      H.check('redesign: op row Edit opens the edit modal with the current amount',
        opModal.title === 'Edit operation' && opModal.amount.replace(/,/g, '') === '10000', JSON.stringify(opModal));
      await page.click('#planOpAmount');
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.type('#planOpAmount', '15000');
      await page.click('#planOpSaveBtn');
      await waitR(1200);
      r = await H.req('GET', `/api/planning/strategies/${rdStrategyId}`);
      const editedOp = (r.data.ops || []).find((o) => o.id === rdPrepayOpId);
      H.check('redesign: op Edit saves the new amount', editedOp && Number(editedOp.params.amount) === 15000, JSON.stringify(editedOp && editedOp.params));
      // Op row Delete removes the op.
      await page.evaluate((oid) => { document.querySelector(`[data-plan-op-del="${oid}"]`).click(); }, rdPrepayOpId);
      await waitR(1200);
      r = await H.req('GET', `/api/planning/strategies/${rdStrategyId}`);
      H.check('redesign: op Delete removes the operation', !(r.data.ops || []).some((o) => o.id === rdPrepayOpId), JSON.stringify((r.data.ops || []).map((o) => o.id)));
      // Leg sub-rows: Edit swaps the row for the leg editor.
      const legRows = await page.evaluate(() => [...document.querySelectorAll('.plan-leg-subrow')].map((tr) => tr.textContent));
      H.check('redesign: buy op renders funding-leg sub-rows', legRows.length === 2 && legRows.some((t) => t.includes('Declared cash')) && legRows.some((t) => t.includes('Cash pot')), JSON.stringify(legRows));
      r = await H.req('GET', `/api/planning/strategies/${rdStrategyId}`);
      const buyOp = (r.data.ops || []).find((o) => o.id === rdBuyOpId);
      const legCash = (buyOp.legs || []).find((l) => l.source_ref === 'cash');
      const legPot = (buyOp.legs || []).find((l) => l.source_ref === 'pot');
      await page.evaluate((lid) => { document.querySelector(`[data-plan-leg-edit$=":${lid}"]`).click(); }, legCash.id);
      await waitR(1200);
      const legEditor = await page.evaluate((lid) => {
        const tr = document.querySelector(`tr[data-plan-leg-id="${lid}"]`);
        return { editor: !!tr?.querySelector('.plan-leg-src'), save: !!tr?.querySelector('#planLegSaveBtn') };
      }, legCash.id);
      H.check('redesign: leg Edit opens the inline leg editor', legEditor.editor && legEditor.save, JSON.stringify(legEditor));
      await page.select(`tr[data-plan-leg-id="${legCash.id}"] .plan-leg-mode`, 'fixed');
      await waitR(200);
      await page.type(`tr[data-plan-leg-id="${legCash.id}"] .plan-leg-amount`, '500');
      await page.click('#planLegSaveBtn');
      await waitR(1200);
      r = await H.req('GET', `/api/planning/strategies/${rdStrategyId}`);
      const buyOp2 = (r.data.ops || []).find((o) => o.id === rdBuyOpId);
      const legCash2 = (buyOp2.legs || []).find((l) => l.source_ref === 'cash');
      H.check('redesign: leg Edit saves the fixed amount', legCash2 && Number(legCash2.amount) === 500, JSON.stringify(buyOp2.legs));
      // Leg Delete drops one leg, survivors re-validate.
      await page.evaluate((lid) => { document.querySelector(`[data-plan-leg-del$=":${lid}"]`).click(); }, legPot.id);
      await waitR(1200);
      r = await H.req('GET', `/api/planning/strategies/${rdStrategyId}`);
      const buyOp3 = (r.data.ops || []).find((o) => o.id === rdBuyOpId);
      H.check('redesign: leg Delete leaves the surviving leg only',
        (buyOp3.legs || []).length === 1 && buyOp3.legs[0].source_ref === 'cash', JSON.stringify(buyOp3.legs));
      // The newer panels survive the redesign, in place.
      const panels = await page.evaluate(() => ({
        diff: !!document.querySelector('#planDiffPanel'),
        report: !!document.querySelector('#planStrategyReportPanel'),
        opsFirst: (() => { const heads = [...document.querySelectorAll('#planStrategy .panel .section-head h3')].map((h) => h.textContent.trim()); return heads.indexOf('Operations') < heads.indexOf('Difference vs baseline'); })(),
      }));
      H.check('redesign: diff + report panels still render, Operations sits before the diff section',
        panels.diff && panels.report && panels.opsFirst, JSON.stringify(panels));
      // Header Delete removes an unmerged strategy.
      r = await H.req('POST', `/api/planning/projects/${rdProjectId}/strategies`, { name: 'Delete me', source: 'template' });
      const rdDelId = r.data.strategy.id;
      await page.goto(`http://ff.local/#planning/strategy/${rdDelId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      await page.click('#planStrategyDeleteBtn');
      await waitR(1200);
      const delLanded = await page.evaluate(() => location.hash);
      r = await H.req('GET', `/api/planning/strategies/${rdDelId}`);
      H.check('redesign: header Delete removes an unmerged strategy and returns to the project',
        delLanded === `#planning/project/${rdProjectId}` && r.status === 404, JSON.stringify({ hash: delLanded, status: r.status }));
      // Header Delete on a merged strategy is refused (400), strategy stays.
      r = await H.req('POST', `/api/planning/projects/${rdProjectId}/strategies`, { name: 'Merge victim', source: 'template' });
      const rdMergeId = r.data.strategy.id;
      r = await H.req('POST', `/api/planning/strategies/${rdMergeId}/ops`, {
        op_type: 'prepay',
        params: { propertyId: rdPropId, date: rdOpDate, amount: 5000, openClosed: 'open' },
      });
      H.check('redesign: merge victim prepay op added', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/planning/strategies/${rdMergeId}/merge-preview`, {});
      H.check('redesign: merge victim preview has no conflicts', r.status === 200 && (r.data.conflicts || []).length === 0, JSON.stringify(r.data));
      r = await H.req('POST', `/api/planning/strategies/${rdMergeId}/merge`, { resolutions: [] });
      H.check('redesign: merge victim merged', r.status === 200 && r.data.mergeRecordId > 0, JSON.stringify(r.data));
      await page.goto(`http://ff.local/#planning/strategy/${rdMergeId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      await page.click('#planStrategyDeleteBtn');
      await waitR(1200);
      const mergedDel = await page.evaluate(() => ({
        msg: document.querySelector('#planStrategyMsg')?.textContent || '',
        stillThere: !!document.querySelector('#planStrategyTitle'),
      }));
      r = await H.req('GET', `/api/planning/strategies/${rdMergeId}`);
      H.check('redesign: header Delete on a merged strategy is refused and the strategy stays',
        /merged/i.test(mergedDel.msg) && mergedDel.stillThere && r.status === 200, JSON.stringify({ msg: mergedDel.msg, status: r.status }));
      // AI spec detach: stub a spec, attach it, Delete drops the panel.
      const rdAiDef = { bindings: [{ name: 'balance', entity: 'property', field: 'mortgage_balance' }], formulas: [{ output: 'monthly interest', expression: 'prior balance * monthly rate / 12' }], assumptions: [{ key: 'stockReturnPct', value: 5, source: 'user' }], outputs: [{ id: 'monthly_interest', label: 'Monthly interest' }], charts: [{ template: 'time_line', title: 'Interest path', series: ['monthly_interest'] }] };
      fs.writeFileSync(H.aiStubFile, JSON.stringify(rdAiDef));
      r = await H.req('POST', `/api/planning/projects/${rdProjectId}/strategies`, { name: 'AI strat', source: 'template' });
      const rdAiId = r.data.strategy.id;
      r = await H.req('POST', `/api/planning/strategies/${rdAiId}/ai-model`, { text: 'Model interest', name: 'Interest model' });
      H.check('redesign: ai-model spec saved for detach pin', r.status === 201 && r.data.model && r.data.model.id > 0, JSON.stringify(r.data));
      r = await H.req('PUT', `/api/planning/strategies/${rdAiId}`, { model_id: r.data.model.id });
      H.check('redesign: model attached to strategy', r.status === 200, JSON.stringify(r.data));
      await page.goto(`http://ff.local/#planning/strategy/${rdAiId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      const modelBefore = await page.evaluate(() => ({
        panel: [...document.querySelectorAll('#planStrategy .panel .section-head h3')].some((h) => h.textContent.trim() === 'Model'),
        detach: !!document.querySelector('#planModelDetachBtn'),
        follow: !!document.querySelector('#planModelFollowBtn'),
      }));
      H.check('redesign: attached AI spec renders with follow-up Edit + Delete (detach)',
        modelBefore.panel && modelBefore.detach && modelBefore.follow, JSON.stringify(modelBefore));
      await page.click('#planModelDetachBtn');
      await waitR(1200);
      const modelAfter = await page.evaluate(() => [...document.querySelectorAll('#planStrategy .panel .section-head h3')].some((h) => h.textContent.trim() === 'Model'));
      r = await H.req('GET', `/api/planning/strategies/${rdAiId}`);
      H.check('redesign: spec Delete detaches the model and the panel leaves',
        !modelAfter && r.data.model === null, JSON.stringify({ panelLeft: modelAfter, model: r.data.model }));
      // Sink Edit + Delete on a minimal pool project.
      r = await H.req('POST', '/api/investments/accounts', { name: 'Redesign Pool Acct', type: 'NonRegistered' });
      const rdPoolAcct = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${rdPoolAcct}/holdings`, { label: 'Redesign Pool Stock', kind: 'exchange', symbol: 'RD.POOL', currency: 'CAD', events: [{ date: '2025-01-15', type: 'buy', units: 100, price: 10 }] });
      const rdPoolHold = r.data.id;
      const _rdVan = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit' }).format(new Date());
      r = await H.req('POST', `/api/investments/holdings/${rdPoolHold}/nav`, { date: `${_rdVan.slice(0, 7)}-15`, price: 20 });
      H.check('redesign: pool holding NAV posted', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', '/api/planning/projects', { name: 'Redesign pool', question: 'q', category: 'investment', subcategory: 'stock', entity: { type: 'pool', items: [{ holdingId: rdPoolHold, percent: 100 }] }, applyRecommendation: true });
      H.check('redesign: pool project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
      const rdPoolProj = r.data.project.id;
      r = await H.req('GET', `/api/planning/projects/${rdPoolProj}`);
      const rdPoolStrat = (r.data.strategies || [])[0];
      H.check('redesign: pool recommendation strategy exists', !!rdPoolStrat, JSON.stringify((r.data.strategies || []).map((x) => x.id)));
      r = await H.req('PUT', `/api/planning/strategies/${rdPoolStrat.id}/sink`, { sink: { kind: 'stock', holdingId: rdPoolHold, trendPct: 10, basis: 'Price CAGR', window: '1y' } });
      H.check('redesign: pool sink saved', r.status === 200 && r.data.sink && r.data.sink.kind === 'stock', JSON.stringify(r.data.sink));
      await page.goto(`http://ff.local/#planning/strategy/${rdPoolStrat.id}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      const sinkView = await page.evaluate(() => ({
        panel: !!document.querySelector('#planSinkPanel'),
        line: (document.querySelector('#planFactorSink')?.textContent || '').includes('Current sink'),
        edit: !!document.querySelector('#planSinkEditBtn'),
        del: !!document.querySelector('#planSinkDelBtn'),
      }));
      H.check('redesign: picked sink shows as a line with Edit + Delete', sinkView.panel && sinkView.line && sinkView.edit && sinkView.del, JSON.stringify(sinkView));
      await page.click('#planSinkEditBtn');
      await waitR(800);
      const sinkEditor = await page.evaluate(() => !!document.querySelector('#planSinkSaveBtn'));
      H.check('redesign: sink Edit opens the pick form', sinkEditor);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1500);
      await page.click('#planSinkDelBtn');
      await waitR(1500);
      const sinkCleared = await page.evaluate(() => (document.querySelector('#planFactorSink')?.textContent || '').includes('No sink picked yet'));
      r = await H.req('GET', `/api/planning/strategies/${rdPoolStrat.id}`);
      H.check('redesign: sink Delete clears to the pick state and drops the sink ops',
        sinkCleared && r.data.sink === null && !(r.data.ops || []).some((o) => o.source === 'sink'), JSON.stringify({ cleared: sinkCleared, sink: r.data.sink, ops: (r.data.ops || []).map((o) => o.source) }));
      // Model thread display starts collapsed behind its toggle.
      await page.goto(`http://ff.local/#planning/project/${rdProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitR(1200);
      await page.click('#planAddStrategyBtn');
      await waitR(800);
      await page.click('#planChooseAi');
      await waitR(400);
      await page.click('#planChooseModel');
      await waitR(800);
      const thread = await page.evaluate(() => ({
        toggle: !!document.querySelector('#planStrategyModelThreadToggle'),
        hidden: !!document.querySelector('#planStrategyModelThread.hidden'),
      }));
      H.check('redesign: model thread starts collapsed behind a toggle', thread.toggle && thread.hidden, JSON.stringify(thread));
      await page.click('#planStrategyModelThreadToggle');
      await waitR(400);
      const threadShown = await page.evaluate(() => !document.querySelector('#planStrategyModelThread.hidden'));
      H.check('redesign: thread toggle reveals the thread', threadShown);
    } finally { await browserR.close(); }
  }
  // ------------------------------------------- strategy-detail clarity
  // Titles + axis captions on report charts (template + AI paths),
  // interest/principal stacked bars + range picker on time charts,
  // year-grouped diff table with annual-sum rows, Assumptions as top
  // metadata with Delete, Describe next to Operations, Report +
  // Penalties above Model.
  r = await H.req('POST', '/api/planning/projects', { name: 'DC Clarity', question: 'q' });
  H.check('detail-clarity: pin project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const dcProjectId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${dcProjectId}/strategies`, { name: 'DC strat', source: 'template' });
  H.check('detail-clarity: pin strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const dcStrategyId = r.data.strategy.id;
  r = await H.req('POST', '/api/properties', {
    address: '99 Clarity Test Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('detail-clarity: pin property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const dcPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${dcPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('detail-clarity: pin rate segment added', r.status === 201, JSON.stringify(r.data));
  const _dcNow = new Date();
  const _dcNext = new Date(Date.UTC(_dcNow.getUTCFullYear(), _dcNow.getUTCMonth() + 1, 1));
  const dcOpDate = _dcNext.toISOString().slice(0, 10);
  r = await H.req('POST', `/api/planning/strategies/${dcStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: dcPropId, date: dcOpDate, amount: 10000, openClosed: 'open' },
  });
  H.check('detail-clarity: pin prepay op added', r.status === 201, JSON.stringify(r.data));
  // Rate switch with no openClosed defaults to closed → a penalty
  // row, so the Penalties panel renders for the order pin.
  r = await H.req('POST', `/api/planning/strategies/${dcStrategyId}/ops`, {
    op_type: 'rate_switch',
    params: { propertyId: dcPropId, date: '2027-06-01', rateType: 'fixed', annualRate: 4.2 },
  });
  H.check('detail-clarity: pin rate-switch op added (closed → penalty)', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${dcProjectId}/scenarios`, { name: 'DC world' });
  H.check('detail-clarity: pin scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const dcScenId = r.data.scenario.id;
  r = await H.req('GET', `/api/planning/projects/${dcProjectId}/comparison?scenarioIds=${dcScenId}`);
  const dcTrajs = (r.data.report && r.data.report.trajectories) || [];
  const dcFirst = dcTrajs.length ? dcTrajs[0].monthly || [] : [];
  H.check('detail-clarity: trajectory rows carry scheduled interest + principal',
    r.status === 200 && dcTrajs.length >= 2 && dcFirst.length > 12 && dcFirst.every((m) => typeof m.interest === 'number' && typeof m.principal === 'number'),
    JSON.stringify({ trajs: dcTrajs.length, months: dcFirst.length, sample: dcFirst[0] }));
  r = await H.req('PUT', `/api/planning/strategies/${dcStrategyId}/assumptions`, { key: 'privilegePct', value: 10, confirmed: true });
  H.check('detail-clarity: pin privilege assumption set', r.status === 200, JSON.stringify(r.data));
  // Model attach (same stub path as the ai-model pins) so the Model
  // panel renders for the order pin.
  const dcModelDef = { bindings: [{ name: 'balance', entity: 'property', field: 'mortgage_balance' }], formulas: [{ output: 'monthly interest', expression: 'prior balance * monthly rate / 12' }], assumptions: [], outputs: [{ id: 'monthly_interest', label: 'Monthly interest' }], charts: [{ template: 'time_line', title: 'Interest path', series: ['monthly_interest'] }] };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(dcModelDef));
  r = await H.req('POST', `/api/planning/strategies/${dcStrategyId}/ai-model`, { text: 'Model interest', name: 'DC model' });
  H.check('detail-clarity: pin model saved', r.status === 201 && r.data.model && r.data.model.id > 0, JSON.stringify(r.data));
  const dcModelId = r.data.model.id;
  r = await H.req('PUT', `/api/planning/strategies/${dcStrategyId}`, { model_id: dcModelId });
  H.check('detail-clarity: pin model attached', r.status === 200, JSON.stringify(r.data));
  // Reports: template path (no method → engine how-line) and AI path
  // (method carried through) share the renderer.
  const dcDef = { strategies: [dcStrategyId], charts: [{ template: 'time_line', title: 'DC balance path', series: ['mortgage_balance'] }] };
  r = await H.req('POST', `/api/planning/projects/${dcProjectId}/reports`, { name: 'DC template report', definition: dcDef, strategy_ids: [dcStrategyId], scenario_ids: [dcScenId] });
  H.check('detail-clarity: template report saved', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const dcRepId = r.data.report.id;
  const dcMethodDef = { strategies: [dcStrategyId], charts: [{ template: 'time_line', title: 'DC AI balance path', series: ['mortgage_balance'], method: 'AI method line: monthly outstanding principal, baseline vs strategy.' }] };
  r = await H.req('POST', `/api/planning/projects/${dcProjectId}/reports`, { name: 'DC AI report', definition: dcMethodDef, strategy_ids: [dcStrategyId], scenario_ids: [dcScenId] });
  H.check('detail-clarity: AI-method report saved', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const dcAiRepId = r.data.report.id;
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('detail-clarity browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
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
    const loginResD = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueD = loginResD.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserD = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserD.newPage();
      await page.setRequestInterception(true);
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const url = new URL(e.request.url);
          if (url.host === 'ff.local') {
            const res = await forwardD({ url: url.pathname + url.search, method: e.request.method, headers: e.request.headers, postData: e.request.postData });
            await client.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: res.status, responseHeaders: Object.entries(res.headers).map(([name, value]) => ({ name, value: String(value) })), body: res.body.toString('base64') });
          } else {
            try { await client.send('Fetch.continueRequest', { requestId: e.requestId }); } catch {}
          }
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueD, domain: 'ff.local', path: '/', httpOnly: true });
      const waitD = (ms) => new Promise((res2) => setTimeout(res2, ms));
      page.on('dialog', (d) => d.accept());
      await page.goto(`http://ff.local/#planning/strategy/${dcStrategyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitD(1500);
      const order = await page.evaluate(() => {
        const heads = [...document.querySelectorAll('#planStrategy .panel h3')].map((h) => h.textContent.trim());
        const idx = (h) => heads.indexOf(h);
        const chartLabels = (id) => { const cv = document.getElementById(id); try { const ch = window.Chart && Chart.getChart ? Chart.getChart(cv) : null; return ch ? ch.data.labels.length : -1; } catch { return -2; } };
        return {
          heads,
          asmTop: idx('Assumptions') === 1,
          describeAfterOps: idx('Describe in words') === idx('Operations') + 1,
          reportAfterDiff: idx('Report') === idx('Difference vs baseline') + 2,
          penAfterReport: idx('Penalties') === idx('Report') + 1,
          modelLast: idx('Model') === heads.length - 1 || idx('Model') > idx('Penalties'),
          mortCap: !!document.querySelector('#planStrategyMortChart')?.closest('.panel')?.textContent.includes('X: month'),
          stockCap: !!document.querySelector('#planStrategyStockChart')?.closest('.panel')?.textContent.includes('X: month'),
          stockPanel: !!document.querySelector('#planStrategyStockChart'),
          diffCap: (document.querySelector('#planDiffCaption')?.textContent || '').includes('X: month'),
          diffBreak: !!document.querySelector('#planDiffBreakdownChart'),
          diffBreakLabels: chartLabels('planDiffBreakdownChart'),
          diffBreakCap: (document.querySelector('#planDiffBreakdownCaption')?.textContent || '').includes('X: month'),
          asmDel: [...document.querySelectorAll('[data-plan-asm-del]')].map((b) => b.dataset.planAsmDel),
          privVal: document.querySelector('#planAsmPrivilege')?.value || '',
          privChecked: !!document.querySelector('#planAsmPrivilegeOk')?.checked,
        };
      });
      H.check('detail-clarity: panel order — Assumptions top, Describe after Operations, Report + Penalties above Model',
        order.asmTop && order.describeAfterOps && order.reportAfterDiff && order.penAfterReport && order.modelLast, JSON.stringify(order.heads));
      H.check('detail-clarity: detail charts + diff carry axis captions and a breakdown chart',
        order.mortCap && order.diffCap && order.diffBreak && order.diffBreakLabels > 12 && order.diffBreakCap, JSON.stringify(order));
      // DC strat is mortgage-only (prepay + rate switch, no stock
      // op, no sink) — the Stock value chart must be hidden.
      H.check('cleanup: mortgage-only strategy hides the Stock value chart',
        !order.stockPanel && !order.stockCap, JSON.stringify(order));
      H.check('detail-clarity: assumptions panel has per-assumption Delete, privilege preset from API',
        order.asmDel.includes('comparableRate') && order.asmDel.includes('privilegePct') && order.privVal.replace(/,/g, '') === '10' && order.privChecked, JSON.stringify(order));
      await page.click('[data-plan-asm-del="privilegePct"]');
      await waitD(1500);
      const afterDel = await page.evaluate(() => ({
        val: document.querySelector('#planAsmPrivilege')?.value || '',
        checked: !!document.querySelector('#planAsmPrivilegeOk')?.checked,
        note: document.querySelector('#planStrategyAsmPanel')?.textContent.includes('Blank privilege % = penalty on the full amount (upper bound)') || false,
      }));
      H.check('detail-clarity: assumption Delete resets to unset, upper-bound note still true',
        afterDel.val === '' && !afterDel.checked && afterDel.note, JSON.stringify(afterDel));
      r = await H.req('GET', `/api/planning/strategies/${dcStrategyId}`);
      const privAsm = (r.data.assumptions || []).find((a) => a.key === 'privilegePct');
      H.check('detail-clarity: deleted assumption is NULL + unconfirmed in the API',
        r.status === 200 && privAsm && privAsm.value == null && !privAsm.confirmed, JSON.stringify(privAsm));
      // Diff year pager: each page holds one year's months + its
      // annual-sum row (same arithmetic as the old grouped table —
      // flows summed, balances year-end), verified page by page.
      await page.click('[data-plan-diff-gran="monthly"]');
      await waitD(800);
      const pagerYears = await page.evaluate(() => [...document.querySelectorAll('#planDiffYearPager [data-plan-diff-year]')].map((b) => b.dataset.planDiffYear));
      const grouped = [];
      for (const y of pagerYears) {
        await page.click(`#planDiffYearPager [data-plan-diff-year="${y}"]`);
        await waitD(300);
        grouped.push(await page.evaluate(() => {
          const parse = (t) => { const v = (t || '').replace(/[$,+\s]/g, ''); return v === '—' || v === '' ? null : Number(v); };
          const headCells = [...document.querySelectorAll('#planDiffTable thead th')].map((th) => th.textContent.trim());
          const col = (name) => headCells.indexOf(name);
          const rows = [...document.querySelectorAll('#planDiffTable tbody tr')];
          let cur = null;
          for (const tr of rows) {
            if (tr.classList.contains('plan-year-head')) { cur = { year: tr.textContent.trim(), months: [], total: null }; }
            else if (tr.classList.contains('plan-year-total')) { if (cur) cur.total = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()); }
            else if (cur) cur.months.push([...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
          }
          if (!cur || !cur.total || !cur.months.length) return null;
          const sum = (i) => cur.months.reduce((a, m) => a + (parse(m[i]) || 0), 0);
          const last = cur.months[cur.months.length - 1];
          return {
            year: cur.year,
            months: cur.months.length,
            intSavedOk: Math.abs(sum(col('Interest saved')) - (parse(cur.total[col('Interest saved')]) || 0)) <= 0.10,
            intBaseOk: Math.abs(sum(col('Baseline interest')) - (parse(cur.total[col('Baseline interest')]) || 0)) <= 0.10,
            balOk: cur.total[col('Baseline balance')] === last[col('Baseline balance')]
              && cur.total[col('Strategy balance')] === last[col('Strategy balance')]
              && cur.total[col('Balance Δ')] === last[col('Balance Δ')],
          };
        }));
      }
      H.check('detail-clarity: diff monthly table pages by year with annual-sum rows (flows summed, balances year-end)',
        grouped.length >= 2 && grouped.every((g) => g && g.intSavedOk && g.intBaseOk && g.balOk) && grouped.some((g) => g.months >= 12),
        JSON.stringify({ years: grouped.length, checked: grouped }));
      // A strategy with a buy op shows the Stock value chart.
      // Self-contained fixture: the earlier Detail Buy project is
      // deleted by its own block's cleanup, so it cannot be reused.
      r = await H.req('POST', '/api/planning/projects', { name: 'Cleanup Stock Chart', question: 'q' });
      H.check('cleanup: stock-chart pin project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
      const scProjectId = r.data.project.id;
      r = await H.req('POST', `/api/planning/projects/${scProjectId}/strategies`, { name: 'Cleanup Buy Strat', source: 'template' });
      H.check('cleanup: stock-chart pin strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
      const scStrategyId = r.data.strategy.id;
      r = await H.req('POST', `/api/planning/strategies/${scStrategyId}/ops`, { op_type: 'buy', params: { accountId: planAcctId, holdingId: planHoldingId, date: planOpDate, units: 10, price: 60 }, legs: [{ source_ref: 'cash', amount: 600 }] });
      H.check('cleanup: stock-chart pin buy op posted', r.status === 201, JSON.stringify(r.data));
      await page.goto(`http://ff.local/#planning/strategy/${scStrategyId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitD(1500);
      const buyStock = await page.evaluate(() => ({
        panel: !!document.querySelector('#planStrategyStockChart'),
        cap: !!document.querySelector('#planStrategyStockChart')?.closest('.panel')?.textContent.includes('X: month'),
      }));
      H.check('cleanup: stock-op strategy shows the Stock value chart',
        buyStock.panel && buyStock.cap, JSON.stringify(buyStock));
      // Report views: template path + AI path both carry titles +
      // axis captions (AI path keeps its method line).
      await page.goto(`http://ff.local/#planning/report/${dcProjectId}/${dcRepId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitD(2500);
      const repView = await page.evaluate(() => ({
        title: !!document.querySelector('#planReportChart0')?.closest('.panel')?.querySelector('h3')?.textContent.includes('DC balance path'),
        axis: (document.querySelector('#planReport')?.textContent || '').includes('X: month'),
        trajTitle: [...document.querySelectorAll('#planReportComparePanel h3')].map((h) => h.textContent.trim()).includes('Difference vs baseline'),
        trajBreak: !!document.querySelector('#planReportTrajectoryBreakdownChart'),
      }));
      H.check('detail-clarity: template report chart has title + axis caption, embedded comparison too',
        repView.title && repView.axis && repView.trajTitle && repView.trajBreak, JSON.stringify(repView));
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportComparePanel [data-plan-traj-preset="1y"]');
      await waitD(800);
      const repNarrowed = await page.evaluate(() => {
        const chartOf = (id) => { const cv = document.getElementById(id); try { const ch = window.Chart && Chart.getChart ? Chart.getChart(cv) : null; return ch ? ch.data.labels.length : -1; } catch { return -2; } };
        return { labels: chartOf('planReportTrajectoryChart'), labelsBreak: chartOf('planReportTrajectoryBreakdownChart'), active: !!document.querySelector('#planReportComparePanel [data-plan-traj-preset="1y"].active') };
      });
      H.check('detail-clarity: report difference 1y preset narrows both the difference chart and the breakdown bars',
        repNarrowed.labels === 12 && repNarrowed.labelsBreak === 12 && repNarrowed.active, JSON.stringify(repNarrowed));
      await page.goto(`http://ff.local/#planning/report/${dcProjectId}/${dcAiRepId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitD(2500);
      const aiView = await page.evaluate(() => ({
        title: !!document.querySelector('#planReportChart0')?.closest('.panel')?.querySelector('h3')?.textContent.includes('DC AI balance path'),
        axis: (document.querySelector('#planReport')?.textContent || '').includes('X: month'),
        method: (document.querySelector('#planReport')?.textContent || '').includes('AI method line:'),
      }));
      H.check('detail-clarity: AI report chart has title + axis caption + its method line',
        aiView.title && aiView.axis && aiView.method, JSON.stringify(aiView));
    } finally { await browserD.close(); }
  }
  // ------------------------------------------- project flow wiring
  // One connected flow (Scenarios | Baselines | Strategies |
  // Reports) with connector lines + shared selection: wiring picks
  // drive the comparison panel and the report pins.
  r = await H.req('POST', '/api/planning/projects', { name: 'Wiring test', question: 'Wiring pins' });
  H.check('wiring: pin project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const wProjectId = r.data.project.id;
  r = await H.req('POST', '/api/properties', {
    address: '77 Wiring Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('wiring: pin property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const wPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${wPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('wiring: pin rate segment added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${wProjectId}/strategies`, { name: 'Wiring prepay', source: 'template' });
  H.check('wiring: pin strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const wStrategyId = r.data.strategy.id;
  const _wNow = new Date();
  const _wNext = new Date(Date.UTC(_wNow.getUTCFullYear(), _wNow.getUTCMonth() + 1, 1));
  r = await H.req('POST', `/api/planning/strategies/${wStrategyId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: wPropId, date: _wNext.toISOString().slice(0, 10), amount: 10000, openClosed: 'open' },
  });
  H.check('wiring: pin prepay op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${wProjectId}/scenarios`, { name: 'Wiring world' });
  H.check('wiring: pin scenario 1 created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const wScen1 = r.data.scenario.id;
  r = await H.req('POST', `/api/planning/projects/${wProjectId}/scenarios`, { name: 'Wiring world 2' });
  H.check('wiring: pin scenario 2 created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const wScen2 = r.data.scenario.id;
  r = await H.req('POST', `/api/planning/projects/${wProjectId}/baselines`, { name: 'Wiring baseline', source: 'manual', definition: { description: 'Wiring base path' } });
  H.check('wiring: pin baseline created', r.status === 201 && r.data.baseline && r.data.baseline.id > 0, JSON.stringify(r.data));
  const wBaseId = r.data.baseline.id;
  const wDef = { strategies: [wStrategyId], charts: [{ template: 'time_line', title: 'Wiring balance', series: ['mortgage_balance'] }] };
  r = await H.req('POST', `/api/planning/projects/${wProjectId}/reports`, { name: 'Wiring report', definition: wDef, strategy_ids: [wStrategyId], baseline_id: wBaseId, scenario_ids: [wScen1] });
  H.check('wiring: pin report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const wRepId = r.data.report.id;
  r = await H.req('POST', `/api/planning/projects/${wProjectId}/reports`, { name: 'Wiring report 2', definition: wDef, strategy_ids: [wStrategyId], baseline_id: wBaseId, scenario_ids: [wScen2] });
  H.check('wiring: pin report 2 created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const wRep2Id = r.data.report.id;
  r = await H.req('GET', `/api/planning/projects/${wProjectId}`);
  const wRep = (r.data.reports || []).find((x) => x.id === wRepId);
  H.check('wiring: project GET carries report pins',
    !!wRep && JSON.stringify(wRep.scenarioIds) === JSON.stringify([wScen1]) && wRep.baseline_id === wBaseId
      && JSON.stringify(JSON.parse(wRep.strategy_ids || 'null')) === JSON.stringify([wStrategyId]), JSON.stringify(wRep));
  r = await H.req('POST', '/api/planning/projects', { name: 'Wiring flat', question: 'Flat pins' });
  H.check('wiring: flat project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const wFlatId = r.data.project.id;
  r = await H.req('POST', `/api/planning/projects/${wFlatId}/reports`, { name: 'Wiring flat report', definition: { strategies: [], charts: [{ template: 'time_line', title: 'Flat balance', series: ['mortgage_balance'] }] } });
  H.check('wiring: flat report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
  const wFlatRepId = r.data.report.id;
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('wiring browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardW = (rq) => new Promise((resolve, reject) => {
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
    const loginResW = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueW = loginResW.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserW = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
    });
    try {
      const page = await browserW.newPage();
      await page.setViewport({ width: 1500, height: 900 });
      await page.setRequestInterception(true);
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const url = new URL(e.request.url);
          if (url.host === 'ff.local') {
            const res = await forwardW({ url: url.pathname + url.search, method: e.request.method, headers: e.request.headers, postData: e.request.postData });
            await client.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: res.status, responseHeaders: Object.entries(res.headers).map(([name, value]) => ({ name, value: String(value) })), body: res.body.toString('base64') });
          } else {
            try { await client.send('Fetch.continueRequest', { requestId: e.requestId }); } catch {}
          }
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueW, domain: 'ff.local', path: '/', httpOnly: true });
      const waitW = (ms) => new Promise((res2) => setTimeout(res2, ms));
      page.on('dialog', (d) => d.accept());
      await page.goto(`http://ff.local/#planning/project/${wProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitW(1500);
      const flow = await page.evaluate(() => {
        const mid = document.querySelector('#planFlowMidTier');
        const tiers = [...document.querySelectorAll('#planFlowGrid > .plan-flow-tier')];
        const card = document.querySelector('#planFlowGrid .plan-flow-card');
        const selBtn = document.querySelector('[data-plan-scenario-select][aria-pressed="true"]');
        const selCard = selBtn ? selBtn.closest('.card') : null;
        const paths = [...document.querySelectorAll('#planFlowSvg path')].map((p) => ({ line: p.dataset.flowLine, from: p.dataset.flowFrom, to: p.dataset.flowTo, d: p.getAttribute('d') || '', fill: getComputedStyle(p).fill }));
        return {
          panel: !!document.querySelector('#planFlowPanel'),
          tiers: tiers.map((c) => c.id),
          tierTops: tiers.map((c) => c.getBoundingClientRect().top),
          midGroups: [...document.querySelectorAll('#planFlowMidTier > .plan-flow-group')].map((c) => c.id),
          midTracks: mid ? getComputedStyle(mid).gridTemplateColumns.split(' ').length : 0,
          cardPadTop: card ? getComputedStyle(card).paddingTop : '',
          selScen: selBtn ? Number(selBtn.dataset.planScenarioSelect) : null,
          selCard: !!selCard && selCard.classList.contains('plan-selected'),
          selBorder: selCard ? getComputedStyle(selCard).borderColor : '',
          selPaths: paths.filter((p) => p.line === 'sel'),
          repPaths: paths.filter((p) => p.line === 'report'),
          allPaths: paths,
        };
      });
      H.check('wiring: flow panel lays out three tiers with tightened cards and a selected base scenario',
        flow.panel && JSON.stringify(flow.tiers) === JSON.stringify(['planScenarioCardsPanel', 'planFlowMidTier', 'planReportsPanel'])
          && flow.tierTops[0] < flow.tierTops[1] && flow.tierTops[1] < flow.tierTops[2]
          && JSON.stringify(flow.midGroups) === JSON.stringify(['planBaselineCardsPanel', 'planStrategiesPanel'])
          && flow.midTracks === 2 && flow.cardPadTop === '12px' && flow.selScen === wScen1 && flow.selCard && flow.selBorder === 'rgb(22, 104, 196)',
        JSON.stringify(flow));
      H.check('wiring: no connector lines; selection + stored pins shown by highlight only',
        flow.allPaths.length === 0 && flow.selCard && flow.selBorder === 'rgb(22, 104, 196)',
        JSON.stringify(flow));
      await page.click(`[data-plan-scenario-select="${wScen2}"]`);
      await waitW(1200);
      const world2 = await page.evaluate((s1, s2) => ({
        note: document.querySelector('#planStrategyCardsWorld')?.textContent || '',
        selCard: !!document.querySelector(`[data-plan-scenario="${s2}"]`)?.classList.contains('plan-selected'),
        oldSel: !!document.querySelector(`[data-plan-scenario="${s1}"]`)?.classList.contains('plan-selected'),
      }), wScen1, wScen2);
      H.check('wiring: wiring scenario pick switches the card world',
        world2.note.includes('Wiring world 2') && world2.selCard && !world2.oldSel,
        JSON.stringify(world2));
      await page.click(`[data-plan-baseline-select="${wBaseId}"]`);
      await waitW(500);
      await page.click('#planAddReportBtn');
      await waitW(1000);
      const modal = await page.evaluate((b, s) => ({
        baseVal: document.querySelector('#planReportSaveBaseline')?.value || '',
        scenChecked: [...document.querySelectorAll('#planReportSaveScenarios input:checked')].map((el) => Number(el.value)),
        open: !document.querySelector('#planReportSaveModal').classList.contains('hidden'),
      }), wBaseId, wScen2);
      H.check('wiring: report modal defaults to the wiring baseline + wiring scenario',
        modal.open && modal.baseVal === String(wBaseId) && JSON.stringify(modal.scenChecked) === JSON.stringify([wScen2]),
        JSON.stringify(modal));
      await page.evaluate(() => { document.querySelector('#planReportSaveName').value = 'Wiring modal report'; });
      await page.click('#planReportSaveBtn');
      await waitW(1200);
      r = await H.req('GET', `/api/planning/projects/${wProjectId}`);
      const modalRep = (r.data.reports || []).find((x) => x.name === 'Wiring modal report');
      H.check('wiring: modal save pins the wiring selection into the report',
        !!modalRep && modalRep.baseline_id === wBaseId && JSON.stringify(modalRep.scenarioIds) === JSON.stringify([wScen2]),
        JSON.stringify(modalRep));
      // The modal save reloaded the project, which reset wiring
      // picks (baseline null, strategies null = all). Re-pick the
      // baseline first so the Generate guard below reflects ONLY
      // the strategy toggle, not a missing baseline.
      await page.click(`[data-plan-baseline-select="${wBaseId}"]`);
      await waitW(500);
      const selBefore = await page.evaluate((sid) => {
        const b = document.querySelector(`[data-plan-strategy-select="${sid}"]`);
        return { pressed: b?.getAttribute('aria-pressed'), selected: !!b?.closest('.card')?.classList.contains('plan-selected') };
      }, wStrategyId);
      await page.click(`[data-plan-strategy-select="${wStrategyId}"]`);
      await waitW(800);
      const selAfter = await page.evaluate((sid) => {
        const b = document.querySelector(`[data-plan-strategy-select="${sid}"]`);
        const gen = document.querySelector('#planFlowGenerateBtn');
        const note = document.querySelector('#planFlowGenerateNote')?.textContent || '';
        return { pressed: b?.getAttribute('aria-pressed'), selected: !!b?.closest('.card')?.classList.contains('plan-selected'), genDisabled: !!gen?.disabled, genNote: note };
      }, wStrategyId);
      H.check('wiring: wiring strategy toggle drives the Select state and the Generate guard',
        selBefore.pressed === 'true' && selBefore.selected
          && selAfter.pressed === 'false' && !selAfter.selected && selAfter.genDisabled && selAfter.genNote === 'Pick at least one strategy to generate.',
        JSON.stringify({ selBefore, selAfter }));
      await page.click(`[data-plan-strategy-select="${wStrategyId}"]`);
      await waitW(800);
      const selBack = await page.evaluate((sid) => {
        const b = document.querySelector(`[data-plan-strategy-select="${sid}"]`);
        const gen = document.querySelector('#planFlowGenerateBtn');
        return { pressed: b?.getAttribute('aria-pressed'), selected: !!b?.closest('.card')?.classList.contains('plan-selected'), genDisabled: !!gen?.disabled };
      }, wStrategyId);
      H.check('wiring: wiring strategy toggle back restores the Select state and the Generate guard',
        selBack.pressed === 'true' && selBack.selected && !selBack.genDisabled, JSON.stringify(selBack));
      await page.evaluate((sid) => { document.querySelector(`[data-plan-strategy="${sid}"] .k`).click(); }, wStrategyId);
      await waitW(800);
      const navHash = await page.evaluate(() => location.hash);
      H.check('wiring: strategy card click still navigates to the detail page',
        navHash === `#planning/strategy/${wStrategyId}`, navHash);
      r = await H.req('DELETE', `/api/planning/scenarios/${wScen2}`);
      H.check('wiring: non-base scenario deleted', r.status === 200, JSON.stringify(r.data));
      await page.goto(`http://ff.local/#planning/project/${wProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitW(1500);
      const gone = await page.evaluate((s2, r2) => ({
        repCard: !!document.querySelector(`[data-plan-report="${r2}"]`),
        scenCard: !!document.querySelector(`[data-plan-scenario="${s2}"]`),
        dangling: [...document.querySelectorAll('#planFlowSvg path')].some((p) => p.dataset.flowFrom === `scenario:${s2}` || p.dataset.flowTo === `scenario:${s2}`),
      }), wScen2, wRep2Id);
      H.check('wiring: report pinned to a deleted scenario draws no line to it',
        gone.repCard && !gone.scenCard && !gone.dangling, JSON.stringify(gone));
      await page.goto(`http://ff.local/#planning/project/${wFlatId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitW(1500);
      const flat = await page.evaluate((fr) => ({
        node: !!document.querySelector('#planFlowFlatNode'),
        nodeText: document.querySelector('#planFlowFlatNode')?.textContent || '',
        repTag: document.querySelector(`[data-plan-report="${fr}"]`)?.textContent || '',
        repPaths: [...document.querySelectorAll('#planFlowSvg path')].filter((p) => p.dataset.flowLine === 'report').map((p) => ({ from: p.dataset.flowFrom, to: p.dataset.flowTo })),
      }), wFlatRepId);
      H.check('wiring: scenario-less project shows a flat-world node with an Under note and no unpinned lines',
        flat.node && flat.nodeText.includes('Current rates (no scenario)') && flat.repTag.includes('Flat world') && flat.repTag.includes('Under Current rates (no scenario)') && flat.repPaths.length === 0,
        JSON.stringify(flat));
      await page.goto(`http://ff.local/#planning/project/${wProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitW(1500);
      await page.setViewport({ width: 700, height: 900 });
      await waitW(800);
      const narrow = await page.evaluate(() => {
        const mid = document.querySelector('#planFlowMidTier');
        return {
          tracks: mid ? getComputedStyle(mid).gridTemplateColumns.split(' ').length : 0,
          paths: document.querySelectorAll('#planFlowSvg path').length,
        };
      });
      H.check('wiring: narrow viewport stacks the middle row, still no lines',
        narrow.tracks === 1 && narrow.paths === 0, JSON.stringify(narrow));
      await page.setViewport({ width: 1500, height: 900 });
    } finally { await browserW.close(); }
  }

  // ------------------------------------------- project vertical flow
  // Three tiers (scenario → baseline+strategy row → reports),
  // no connector lines (highlight only), one-click Generate,
  // multi-tab reports, AI routing, AI vs preset titles.
  r = await H.req('POST', '/api/planning/projects', { name: 'Flow test', question: 'Flow pins' });
  H.check('flow: project created', r.status === 201 && r.data.project && r.data.project.id > 0, JSON.stringify(r.data));
  const fProjectId = r.data.project.id;
  r = await H.req('POST', '/api/properties', {
    address: '77 Flow Lane, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('flow: property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const fPropId = r.data.id;
  r = await H.req('POST', `/api/properties/${fPropId}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('flow: rate segment added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${fProjectId}/strategies`, { name: 'Flow prepay', source: 'template' });
  H.check('flow: strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const fStratId = r.data.strategy.id;
  const _fNow = new Date();
  const _fNext = new Date(Date.UTC(_fNow.getUTCFullYear(), _fNow.getUTCMonth() + 1, 1));
  r = await H.req('POST', `/api/planning/strategies/${fStratId}/ops`, {
    op_type: 'prepay',
    params: { propertyId: fPropId, date: _fNext.toISOString().slice(0, 10), amount: 10000, openClosed: 'open' },
  });
  H.check('flow: prepay op added', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/planning/projects/${fProjectId}/scenarios`, { name: 'Flow world' });
  H.check('flow: scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const fScenId = r.data.scenario.id;
  r = await H.req('POST', `/api/planning/projects/${fProjectId}/baselines`, { name: 'Flow baseline', source: 'manual', definition: { description: 'Flow base path' } });
  H.check('flow: baseline created', r.status === 201 && r.data.baseline && r.data.baseline.id > 0, JSON.stringify(r.data));
  const fBaseId = r.data.baseline.id;
  r = await H.req('POST', `/api/planning/projects/${fProjectId}/baselines`, { name: 'Flow AI baseline', source: 'ai', definition: { description: 'AI base path' } });
  H.check('flow: AI baseline created', r.status === 201 && r.data.baseline && r.data.baseline.id > 0, JSON.stringify(r.data));
  const fAiBaseId = r.data.baseline.id;
  r = await H.req('POST', `/api/planning/projects/${fProjectId}/scenarios`, { name: 'Flow AI world', source: 'ai' });
  H.check('flow: AI scenario created', r.status === 201 && r.data.scenario && r.data.scenario.id > 0, JSON.stringify(r.data));
  const fAiScenId = r.data.scenario.id;
  r = await H.req('POST', `/api/planning/projects/${fProjectId}/strategies`, { name: 'Flow AI strategy', source: 'manual' });
  H.check('flow: AI strategy created', r.status === 201 && r.data.strategy && r.data.strategy.id > 0, JSON.stringify(r.data));
  const fAiStratId = r.data.strategy.id;
  const fAiModelDef = { bindings: [{ name: 'balance', entity: 'property', field: 'mortgage_balance' }], formulas: [{ output: 'monthly interest', expression: 'prior balance * monthly rate / 12' }], assumptions: [{ key: 'stockReturnPct', value: 5, source: 'user' }], outputs: [{ id: 'monthly_interest', label: 'Monthly interest' }], charts: [{ template: 'time_line', title: 'Interest path', series: ['monthly_interest'] }] };
  fs.writeFileSync(H.aiStubFile, JSON.stringify(fAiModelDef));
  r = await H.req('POST', `/api/planning/strategies/${fAiStratId}/ai-model`, { text: 'Model interest', name: 'Flow interest model' });
  H.check('flow: ai-model saved', r.status === 201 && r.data.model && r.data.model.id > 0, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/planning/strategies/${fAiStratId}`, { model_id: r.data.model.id });
  H.check('flow: model attached to AI strategy', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
  const fStrat = (r.data.strategies || []).find((s) => s.id === fStratId);
  const fAiStrat = (r.data.strategies || []).find((s) => s.id === fAiStratId);
  const fScen = (r.data.scenarios || []).find((s) => s.id === fScenId);
  const fBase = (r.data.project.baselines || []).find((b) => b.id === fBaseId);
  const fAiBase = (r.data.project.baselines || []).find((b) => b.id === fAiBaseId);
  const fAiScen = (r.data.scenarios || []).find((s) => s.id === fAiScenId);
  H.check('flow: project GET marks AI-designed entities only',
    !!fStrat && !!fAiStrat && fAiStrat.modelSource === 'ai' && fStrat.modelSource !== 'ai'
      && !!fScen && !!fAiScen && fAiScen.source === 'ai' && fScen.source !== 'ai'
      && !!fBase && !!fAiBase && fAiBase.source === 'ai' && fBase.source !== 'ai',
    JSON.stringify({ fStrat, fAiStrat, fScen, fAiScen, fBase, fAiBase }));
  const fLetter = fStrat ? fStrat.letter : 'A';
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('flow browser checks skipped (puppeteer-core / probe Chrome not available)');
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
      await page.setViewport({ width: 1500, height: 900 });
      await page.setRequestInterception(true);
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const url = new URL(e.request.url);
          if (url.host === 'ff.local') {
            const res = await forwardF({ url: url.pathname + url.search, method: e.request.method, headers: e.request.headers, postData: e.request.postData });
            await client.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: res.status, responseHeaders: Object.entries(res.headers).map(([name, value]) => ({ name, value: String(value) })), body: res.body.toString('base64') });
          } else {
            try { await client.send('Fetch.continueRequest', { requestId: e.requestId }); } catch {}
          }
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueF, domain: 'ff.local', path: '/', httpOnly: true });
      const waitF = (ms) => new Promise((res2) => setTimeout(res2, ms));
      page.on('dialog', (d) => d.accept());
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1500);
      // Tier order + vertical elbows + no crossing jog.
      const tiers = await page.evaluate(() => {
        const ts = [...document.querySelectorAll('#planFlowGrid > .plan-flow-tier')];
        return { tops: ts.map((t) => t.getBoundingClientRect().top), ids: ts.map((t) => t.id), svg: !!document.querySelector('#planFlowSvg'), paths: document.querySelectorAll('#planFlowGrid path').length };
      });
      H.check('flow: tiers stack scenario above baseline+strategy row above reports',
        JSON.stringify(tiers.ids) === JSON.stringify(['planScenarioCardsPanel', 'planFlowMidTier', 'planReportsPanel'])
          && tiers.tops[0] < tiers.tops[1] && tiers.tops[1] < tiers.tops[2], JSON.stringify(tiers));
      H.check('flow: no connector lines in the flow panel',
        !tiers.svg && tiers.paths === 0, JSON.stringify(tiers));
      // Guard: baseline is not picked yet (only the base scenario is).
      // Deselect the AI strategy first, or the routing rule (not the
      // guard) would own the button state from here on.
      await page.click(`[data-plan-strategy-select="${fAiStratId}"]`);
      await waitF(800);
      const guard0 = await page.evaluate(() => ({
        disabled: !!document.querySelector('#planFlowGenerateBtn')?.disabled,
        note: document.querySelector('#planFlowGenerateNote')?.textContent || '',
      }));
      H.check('flow: missing-pick guard names the missing baseline',
        guard0.disabled && guard0.note.includes('a baseline'), JSON.stringify(guard0));
      await page.click(`[data-plan-baseline-select="${fBaseId}"]`);
      await waitF(800);
      const guard1 = await page.evaluate(() => ({
        disabled: !!document.querySelector('#planFlowGenerateBtn')?.disabled,
        note: document.querySelector('#planFlowGenerateNote')?.textContent || '',
      }));
      H.check('flow: guard clears once scenario + baseline + strategy are picked',
        !guard1.disabled && guard1.note === '', JSON.stringify(guard1));
      // Selection alone creates no report.
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const repCount0 = (r.data.reports || []).length;
      await page.click(`[data-plan-strategy-select="${fStratId}"]`);
      await waitF(800);
      await page.click(`[data-plan-strategy-select="${fStratId}"]`);
      await waitF(800);
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      H.check('flow: selection alone creates no report',
        (r.data.reports || []).length === repCount0, JSON.stringify((r.data.reports || []).map((x) => x.name)));
      // Select-button selection vs card-click navigation, on the
      // strategy card: Select toggles the highlight, the card body
      // navigates to the detail page.
      await page.click(`[data-plan-strategy-select="${fStratId}"]`);
      await waitF(500);
      const selOff = await page.evaluate((sid) => ({
        pressed: document.querySelector(`[data-plan-strategy-select="${sid}"]`)?.getAttribute('aria-pressed'),
        sel: !!document.querySelector(`[data-plan-strategy="${sid}"]`)?.classList.contains('plan-selected'),
      }), fStratId);
      await page.click(`[data-plan-strategy-select="${fStratId}"]`);
      await waitF(500);
      const selOn = await page.evaluate((sid) => ({
        pressed: document.querySelector(`[data-plan-strategy-select="${sid}"]`)?.getAttribute('aria-pressed'),
        sel: !!document.querySelector(`[data-plan-strategy="${sid}"]`)?.classList.contains('plan-selected'),
      }), fStratId);
      H.check('flow: strategy Select toggles selection state',
        selOff.pressed === 'false' && !selOff.sel && selOn.pressed === 'true' && selOn.sel, JSON.stringify({ selOff, selOn }));
      await page.evaluate((sid) => { document.querySelector(`[data-plan-strategy="${sid}"] .k`).click(); }, fStratId);
      await waitF(800);
      const navHash = await page.evaluate(() => location.hash);
      H.check('flow: strategy card click still navigates to the detail page',
        navHash === `#planning/strategy/${fStratId}`, navHash);
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1500);
      // A reload resets wiring state (baseline unpicked, every
      // strategy picked), so re-pick the engine selection first.
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-baseline-select="${fBaseId}"]`);
      await waitF(500);
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-strategy-select="${fAiStratId}"]`);
      await waitF(800);
      // One-click Generate: creates + opens a report pinned to the
      // then-current wiring selection, with no modal. Inline: the
      // hash stays on the project page and the viewer shows the tab.
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planFlowGenerateBtn');
      await waitF(1500);
      const genHash = await page.evaluate(() => location.hash);
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const genRep = (r.data.reports || []).find((x) => x.name === `Report · Flow world · Flow baseline · ${fLetter}`);
      const genInline = await page.evaluate((rid) => ({
        inline: !!document.querySelector('#planProject #planReport'),
        tab: !!document.querySelector(`[data-plan-report-tab="${rid}"]`),
      }), genRep ? genRep.id : -1);
      const modalHidden = await page.evaluate(() => {
        const m = document.querySelector('#planReportSaveModal');
        return !m || m.classList.contains('hidden');
      });
      H.check('flow: one-click Generate creates and opens a pinned preset report, no modal',
        !!genRep && genHash === `#planning/project/${fProjectId}` && genInline.inline && genInline.tab
          && JSON.stringify(genRep.scenarioIds) === JSON.stringify([fScenId]) && genRep.baseline_id === fBaseId
          && JSON.stringify(JSON.parse(genRep.strategy_ids || 'null')) === JSON.stringify([fStratId])
          && JSON.stringify(genRep.definition.charts) === JSON.stringify([
            { template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] },
            { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] },
          ]) && modalHidden,
        JSON.stringify({ genHash, genInline, genRep, modalHidden }));
      // Multi-tab (inline): open a second report, switch tabs, close
      // tabs — closing removes only the tab, never the report, and
      // the user never leaves the project page (no separate report
      // page is navigated to at any point).
      r = await H.req('POST', `/api/planning/projects/${fProjectId}/reports`, { name: 'Flow second report', definition: { strategies: [fStratId], charts: [{ template: 'time_line', title: 'Second balance', series: ['mortgage_balance'] }] }, strategy_ids: [fStratId], baseline_id: fBaseId, scenario_ids: [fScenId] });
      H.check('flow: second report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
      const fRep2Id = r.data.report.id;
      // Open the second report via its deep link: the card list only
      // re-renders on a project load, and the page is already on the
      // project hash (a same-hash goto would be a no-op), so the
      // API-created report has no card yet. The redirect lands on
      // the project page with this tab open.
      await page.goto(`http://ff.local/#planning/report/${fProjectId}/${fRep2Id}`, { waitUntil: 'networkidle0', timeout: 30000 });
      // Deep-link render races the same async viewer as the other tabs
      // pins: wait for the tab and its blocks instead of a fixed sleep
      // (a fixed 2000ms read the not-yet-rendered viewer: tab=false).
      await page.waitForSelector(`[data-plan-report-tab="${fRep2Id}"]`, { timeout: 15000 });
      await page.waitForFunction((rid) => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent).includes('Second balance'), { timeout: 15000 }, fRep2Id);
      // The redirect chain renders the tab bar asynchronously, and
      // page.click does NOT wait for its selector — wait for the bar
      // explicitly before any tab click.
      await page.waitForSelector(`[data-plan-report-tab="${fRep2Id}"]`, { timeout: 15000 });
      const tabs2 = await page.evaluate(() => [...document.querySelectorAll('[data-plan-report-tab]')].map((b) => Number(b.dataset.planReportTab)));
      const viewerState = async () => page.evaluate(() => ({
        hash: location.hash,
        inline: !!document.querySelector('#planProject #planReport'),
        strip: !!document.querySelector('#planReportTabsBar'),
        blocks: [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent),
        currentWrap: !!document.querySelector('.plan-report-tabwrap-current'),
      }));
      const st2 = await viewerState();
      await page.waitForSelector(`[data-plan-report-tab="${genRep.id}"]`, { timeout: 15000 });
      // Click via evaluate (re-query at click time): a plain page.click
      // holds the handle from waitForSelector, and the switch render can
      // replace the tab bar between the two ("Node is detached from
      // document" killed full runs #4/#5's planning module here).
      await page.evaluate((id) => { document.querySelector(`[data-plan-report-tab="${id}"]`).click(); }, genRep.id);
      await waitF(1000);
      // Wait for the switch render itself before reading state: a fixed
      // 1000ms read the pre-switch viewer (stSwitch still showed the
      // old tab's blocks) when the render ran long.
      await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'Mortgage balance'), { timeout: 15000 });
      const stSwitch = await viewerState();
      await page.waitForSelector(`[data-plan-report-tab-close="${genRep.id}"]`, { timeout: 15000 });
      await page.evaluate((id) => { document.querySelector(`[data-plan-report-tab-close="${id}"]`).click(); }, genRep.id);
      await waitF(1000);
      // Post-close fallback re-renders the remaining tab (project +
      // comparison + properties fetches): under full-run load this took
      // over 15s once, so the budget here is 30s (a genuinely broken
      // render still fails, just later).
      await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'Second balance'), { timeout: 30000 });
      const stClose = await viewerState();
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const bothAlive = (r.data.reports || []).some((x) => x.id === genRep.id) && (r.data.reports || []).some((x) => x.id === fRep2Id);
      await page.waitForSelector(`[data-plan-report-tab-close="${fRep2Id}"]`, { timeout: 15000 });
      await page.evaluate((id) => { document.querySelector(`[data-plan-report-tab-close="${id}"]`).click(); }, fRep2Id);
      await waitF(1000);
      await page.waitForFunction(() => !document.querySelector('[data-plan-report-tab]'), { timeout: 15000 });
      const stEmpty = await viewerState();
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const bothAlive2 = (r.data.reports || []).some((x) => x.id === genRep.id) && (r.data.reports || []).some((x) => x.id === fRep2Id);
      H.check('flow: tabs open, switch, and close without deleting reports (inline)',
        JSON.stringify(tabs2.sort((a, b) => a - b)) === JSON.stringify([genRep.id, fRep2Id].sort((a, b) => a - b))
          && st2.hash === `#planning/project/${fProjectId}` && st2.inline && st2.strip && st2.blocks.includes('Second balance')
          && stSwitch.hash === `#planning/project/${fProjectId}` && stSwitch.blocks.includes('Mortgage balance') && stSwitch.currentWrap
          && stClose.hash === `#planning/project/${fProjectId}` && stClose.blocks.includes('Second balance') && bothAlive
          && stEmpty.hash === `#planning/project/${fProjectId}` && !stEmpty.strip && stEmpty.blocks.length === 0 && bothAlive2,
        JSON.stringify({ tabs2, st2, stSwitch, stClose, bothAlive, stEmpty, bothAlive2 }));
      // Routing: each AI-designed pick disables preset Generate with
      // a reason, while Generate with AI stays available.
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1500);
      // Reload resets wiring state, so start from the engine-only
      // selection (AI strategy off) before each routing case.
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-strategy-select="${fAiStratId}"]`);
      await waitF(800);
      const routingState = async () => page.evaluate(() => ({
        disabled: !!document.querySelector('#planFlowGenerateBtn')?.disabled,
        note: document.querySelector('#planFlowGenerateNote')?.textContent || '',
        aiEnabled: !document.querySelector('#planAiReportBtn')?.disabled,
      }));
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-baseline-select="${fAiBaseId}"]`);
      await waitF(800);
      const routeBase = await routingState();
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-baseline-select="${fBaseId}"]`);
      await waitF(800);
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-scenario-select="${fAiScenId}"]`);
      // Wait for the scenario-click render itself, not a fixed sleep:
      // a fixed 1200ms read the pre-click routing (disabled false, note
      // empty) under full-run load and flaked this check. Waiting for
      // the asserted state keeps the pin exactly as strong — a broken
      // render times out here and the check below still fails.
      await page.waitForFunction(() => {
        const b = document.querySelector('#planFlowGenerateBtn');
        const n = document.querySelector('#planFlowGenerateNote')?.textContent || '';
        return !!b?.disabled && n.includes('scenario');
      }, { timeout: 15000 }).catch(() => {});
      const routeScen = await routingState();
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-scenario-select="${fScenId}"]`);
      await waitF(1200);
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-strategy-select="${fAiStratId}"]`);
      await waitF(800);
      const routeStrat = await routingState();
      H.check('flow: AI-designed baseline/scenario/strategy each disable preset Generate with reason, AI Generate stays available',
        routeBase.disabled && routeBase.note.includes('AI-designed') && routeBase.note.includes('baseline') && routeBase.aiEnabled
          && routeScen.disabled && routeScen.note.includes('AI-designed') && routeScen.note.includes('scenario') && routeScen.aiEnabled
          && routeStrat.disabled && routeStrat.note.includes('AI-designed') && routeStrat.note.includes('strategy') && routeStrat.aiEnabled,
        JSON.stringify({ routeBase, routeScen, routeStrat }));
      // AI title vs preset title: the AI modal prefills its name
      // from the AI title; without one it falls back to the
      // auto-name pattern. The preset report from Generate keeps
      // the preset title (already pinned above).
      const fAiCharts = [
        { template: 'time_line', title: 'Balance path', series: ['mortgage_balance'], method: 'Monthly outstanding principal from the engine projection, baseline vs each strategy.' },
        { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'], method: 'Cost = fees + penalty + cash out; gain = interest saved vs baseline + asset growth; net = gain − cost.' },
      ];
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ title: 'Flow AI outlook', charts: fAiCharts }));
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planAiReportBtn');
      await waitF(1000);
      await page.evaluate(() => { document.querySelector('#planReportAiText').value = 'Compare balance paths and headlines'; });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportAiGenBtn');
      await waitF(1200);
      const aiPrefill = await page.evaluate(() => document.querySelector('#planReportAiName')?.value || '');
      await page.evaluate((sid) => { const el = document.querySelector(`#planReportAiScenarios input[value="${sid}"]`); if (el) el.checked = true; }, fScenId);
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportAiSaveBtn');
      await waitF(1200);
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const aiTitled = (r.data.reports || []).find((x) => x.name === 'Flow AI outlook');
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ charts: fAiCharts }));
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planAiReportBtn');
      await waitF(1000);
      await page.evaluate(() => { document.querySelector('#planReportAiText').value = 'Compare balance paths and headlines'; });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportAiGenBtn');
      await waitF(1200);
      const aiBlank = await page.evaluate(() => document.querySelector('#planReportAiName')?.value || '');
      await page.evaluate((sid) => { const el = document.querySelector(`#planReportAiScenarios input[value="${sid}"]`); if (el) el.checked = true; }, fScenId);
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportAiSaveBtn');
      await waitF(1200);
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const aiFallback = (r.data.reports || []).find((x) => x.name === `Report · ${fLetter} · Flow prepay`);
      H.check('flow: AI report title comes from the AI, falling back to the auto-name pattern',
        aiPrefill === 'Flow AI outlook' && !!aiTitled && aiBlank === '' && !!aiFallback,
        JSON.stringify({ aiPrefill, aiTitled: !!aiTitled, aiBlank, aiFallback: !!aiFallback }));
      // ---- report-tab refinement pins (inline model) ----
      // Fixture: an AI-pinned report (baseline/scenario/strategy all AI).
      r = await H.req('POST', `/api/planning/projects/${fProjectId}/reports`, { name: 'Reporttab AI', definition: { charts: [{ template: 'time_line', title: 'AI balance', series: ['mortgage_balance'] }] }, baseline_id: fAiBaseId, strategy_ids: [fAiStratId], scenario_ids: [fAiScenId] });
      H.check('reporttab: AI-pinned report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
      const rtAiId = r.data.report.id;
      // No report-highlight when no report tab is selected: close any
      // tab left open, then the tiers show wiring blue only.
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1500);
      for (;;) {
        const closeBtn = await page.$('[data-plan-report-tab-close]');
        if (!closeBtn) break;
        await closeBtn.click();
        await waitF(800);
      }
      const noPin = await page.evaluate(() => ({
        pins: [...document.querySelectorAll('.plan-report-pin')].filter((el) => el.offsetParent !== null).length,
        viewerEmpty: (document.querySelector('#planReport')?.innerHTML || '').trim() === '',
      }));
      H.check('reporttab: no report-highlight when no report tab is selected', noPin.pins === 0 && noPin.viewerEmpty, JSON.stringify(noPin));
      // Wiring scenario = engine scenario, so the engine report's
      // scenario card can show both states at once (radio: no-op if set).
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-scenario-select="${fScenId}"]`);
      await waitF(800);
      const readTier = (scenId, baseId, stratId) => page.evaluate((s, b, t) => {
        const card = (kind, id) => document.querySelector(`[data-plan-${kind}="${id}"]`);
        const styleOf = (el) => el ? { pin: el.classList.contains('plan-report-pin'), sel: el.classList.contains('plan-selected'), border: getComputedStyle(el).borderColor, outline: getComputedStyle(el).outlineColor, outlineStyle: getComputedStyle(el).outlineStyle, bg: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow } : null;
        return {
          scenPins: [...document.querySelectorAll('[data-plan-scenario].plan-report-pin')].map((el) => Number(el.dataset.planScenario)),
          basePins: [...document.querySelectorAll('[data-plan-baseline].plan-report-pin')].map((el) => Number(el.dataset.planBaseline)),
          stratPins: [...document.querySelectorAll('[data-plan-strategy].plan-report-pin')].map((el) => Number(el.dataset.planStrategy)),
          scen: styleOf(card('scenario', s)), base: styleOf(card('baseline', b)), strat: styleOf(card('strategy', t)),
          inline: !!document.querySelector('#planProject #planReport'),
          hash: location.hash,
        };
      }, scenId, baseId, stratId);
      const openCard = async (rid, blockTitle) => { await page.evaluate((id) => { document.querySelector(`[data-plan-report-view="${id}"]`).click(); }, rid); await waitF(1200); await page.waitForFunction((t) => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === t), { timeout: 15000 }, blockTitle); };
      // Per-tab buttons present on the engine report tab.
      await openCard(genRep.id, 'Mortgage balance');
      const tabBtns = await page.evaluate(() => ({
        gen: !!document.querySelector('#planReportTabGenerateBtn'),
        ai: !!document.querySelector('#planReportTabAiBtn'),
        save: !!document.querySelector('#planReportTabSaveBtn'),
        genDisabled: !!document.querySelector('#planReportTabGenerateBtn')?.disabled,
      }));
      H.check('reporttab: per-tab Generate, AI Generate, Save buttons present; preset enabled for engine pins', tabBtns.gen && tabBtns.ai && tabBtns.save && !tabBtns.genDisabled, JSON.stringify(tabBtns));
      // Highlight: engine tab highlights its own pins on the tiers
      // above (amber); the scenario card — wiring-selected AND
      // report-pinned — shows ONE combined frame: selection border
      // + background kept, report left bar kept, amber outline
      // dropped (no double frame); the viewer sits inline on the
      // project page.
      const tierEngine = await readTier(fScenId, fBaseId, fStratId);
      H.check('reporttab: engine tab highlights its own pins on the tiers above; scenario card shows one combined frame; viewer inline',
        JSON.stringify(tierEngine.scenPins) === JSON.stringify([fScenId]) && JSON.stringify(tierEngine.basePins) === JSON.stringify([fBaseId]) && tierEngine.stratPins.includes(fStratId)
          && tierEngine.scen && tierEngine.scen.pin && tierEngine.scen.sel
          && tierEngine.scen.border === 'rgb(22, 104, 196)' && tierEngine.scen.bg === 'rgb(240, 246, 252)'
          && tierEngine.scen.outlineStyle === 'none' && tierEngine.scen.shadow.includes('183, 121, 31') && tierEngine.scen.shadow.includes('inset')
          && tierEngine.inline && tierEngine.hash === `#planning/project/${fProjectId}`, JSON.stringify(tierEngine));
      // Highlight de-stacking: the other two states. The AI
      // strategy card is wiring-picked (all picked by default) but
      // not engine-pinned: selected-only. Toggling the engine
      // strategy's Select off leaves it report-pinned only; toggling
      // back restores the combined frame. Mouse moved away first so
      // the breakdown-card hover border cannot tint the reads.
      const stratStyle = (id) => page.evaluate((sid) => { const el = document.querySelector(`[data-plan-strategy="${sid}"]`); if (!el) return null; const cs = getComputedStyle(el); return { pin: el.classList.contains('plan-report-pin'), sel: el.classList.contains('plan-selected'), border: cs.borderColor, bg: cs.backgroundColor, outline: cs.outlineColor, outlineStyle: cs.outlineStyle, shadow: cs.boxShadow }; }, id);
      await page.mouse.move(0, 0);
      const selOnly = await stratStyle(fAiStratId);
      H.check('highlight: selected-only card shows blue border/bg, no amber frame',
        selOnly && selOnly.sel && !selOnly.pin && selOnly.border === 'rgb(22, 104, 196)' && selOnly.bg === 'rgb(240, 246, 252)' && selOnly.outlineStyle === 'none' && selOnly.shadow === 'none', JSON.stringify(selOnly));
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-strategy-select="${fStratId}"]`);
      await waitF(800);
      await page.mouse.move(0, 0);
      const pinOnly = await stratStyle(fStratId);
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-strategy-select="${fStratId}"]`);
      await waitF(800);
      const restored = await stratStyle(fStratId);
      H.check('highlight: pinned-only card shows amber frame + left bar, no blue border; toggling back restores the combined frame',
        pinOnly && pinOnly.pin && !pinOnly.sel && pinOnly.outline === 'rgb(183, 121, 31)' && pinOnly.outlineStyle === 'solid' && pinOnly.shadow.includes('183, 121, 31') && pinOnly.shadow.includes('inset') && pinOnly.border === 'rgb(221, 228, 236)' && pinOnly.bg === 'rgb(255, 255, 255)'
        && restored && restored.pin && restored.sel && restored.outlineStyle === 'none' && restored.border === 'rgb(22, 104, 196)', JSON.stringify({ pinOnly, restored }));
      // Preset regenerate: touching the strategy stales the report;
      // per-tab Generate clears the stale badge (reopening the tab
      // re-reads the report, so no page reload is needed).
      r = await H.req('PUT', `/api/planning/strategies/${fStratId}`, { name: 'Flow prepay' });
      H.check('reporttab: strategy touch succeeds', r.status === 200, JSON.stringify(r.data));
      await openCard(genRep.id, 'Mortgage balance');
      // Wait for the post-touch render itself: the badge must appear
      // (the touch bumped the strategy past the report), so a read
      // taken before that render lands sees a stale-free viewer.
      await page.waitForFunction(() => [...document.querySelectorAll('#planReport .section-head .msg.warn')].length > 0, { timeout: 15000 });
      const staleBefore = await page.evaluate(() => !!document.querySelector('#planReport .msg.warn') || [...document.querySelectorAll('#planReport .section-head .msg.warn')].length > 0);
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportTabGenerateBtn');
      // Regenerate re-renders after a PUT + comparison fetch: wait for
      // the badge to clear instead of a fixed sleep (1500ms was too
      // short under full-run load: staleAfter stayed 1).
      await page.waitForFunction(() => [...document.querySelectorAll('#planReport .section-head .msg.warn')].length === 0, { timeout: 15000 });
      const staleAfter = await page.evaluate(() => [...document.querySelectorAll('#planReport .section-head .msg.warn')].length);
      H.check('reporttab: per-tab Generate clears the stale badge', staleBefore && staleAfter === 0, JSON.stringify({ staleBefore, staleAfter }));
      // Per-tab routing on the AI-pinned report + its highlight.
      // First open is via deep link: the report was created via API
      // after the last project render, so it has no card yet.
      await page.goto(`http://ff.local/#planning/report/${fProjectId}/${rtAiId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(2000);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'AI balance'), { timeout: 15000 });
      const tabRoute = await page.evaluate(() => ({
        genDisabled: !!document.querySelector('#planReportTabGenerateBtn')?.disabled,
        note: document.querySelector('#planReportTabNote')?.textContent || '',
        aiEnabled: !document.querySelector('#planReportTabAiBtn')?.disabled,
      }));
      H.check('reporttab: AI-pinned tab disables preset Generate with reason, AI stays enabled', tabRoute.genDisabled && tabRoute.note.includes('AI-designed') && tabRoute.aiEnabled, JSON.stringify(tabRoute));
      const tierAi = await readTier(fAiScenId, fAiBaseId, fAiStratId);
      H.check('reporttab: AI tab highlights its own pins above, not the engine pins',
        JSON.stringify(tierAi.scenPins) === JSON.stringify([fAiScenId]) && JSON.stringify(tierAi.basePins) === JSON.stringify([fAiBaseId]) && JSON.stringify(tierAi.stratPins) === JSON.stringify([fAiStratId]), JSON.stringify(tierAi));
      // Round-trip: back to the engine tab, its highlight returns.
      await page.waitForSelector(`[data-plan-report-tab="${genRep.id}"]`, { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-report-tab="${genRep.id}"]`);
      await waitF(1000);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'Mortgage balance'), { timeout: 15000 });
      const tierBack = await readTier(fScenId, fBaseId, fStratId);
      H.check('reporttab: highlight follows the tab back to the engine pins',
        JSON.stringify(tierBack.scenPins) === JSON.stringify([fScenId]) && JSON.stringify(tierBack.basePins) === JSON.stringify([fBaseId]) && tierBack.stratPins.includes(fStratId), JSON.stringify(tierBack));
      // AI append on the AI tab: new charts join, old ones stay, and
      // the append persists across a close + reopen.
      await page.waitForSelector(`[data-plan-report-tab="${rtAiId}"]`, { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-report-tab="${rtAiId}"]`);
      await waitF(1000);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'AI balance'), { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportTabAiBtn');
      await waitF(1000);
      const appendUi = await page.evaluate(() => ({
        modalOpen: !document.querySelector('#planReportAiModal')?.classList.contains('hidden'),
        pickersHidden: ['planReportAiBaseline', 'planReportAiScenarios', 'planReportAiStrategies'].every((id) => !!document.getElementById(id)?.closest('div')?.classList.contains('hidden')),
        note: document.querySelector('#planReportAiAppendNote')?.textContent || '',
      }));
      H.check('reporttab: per-tab AI opens append mode (pickers hidden, pins-unchanged note)', appendUi.modalOpen && appendUi.pickersHidden && appendUi.note.includes('pins unchanged'), JSON.stringify(appendUi));
      fs.writeFileSync(H.aiStubFile, JSON.stringify({ title: 'Reporttab AI extra', charts: [{ template: 'time_line', title: 'Extra balance', series: ['mortgage_balance'], method: 'Monthly outstanding principal from the engine projection.' }] }));
      await page.evaluate(() => { document.querySelector('#planReportAiText').value = 'Add an extra balance path'; });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportAiGenBtn');
      await waitF(1200);
      const appendSaveLabel = await page.evaluate(() => document.querySelector('#planReportAiSaveBtn')?.textContent || '');
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportAiSaveBtn');
      await waitF(1500);
      const appendTitles = await page.evaluate(() => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent));
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const rtAiDef = ((r.data.reports || []).find((x) => x.id === rtAiId) || {}).definition || {};
      H.check('reporttab: AI charts append (not replace) and persist',
        appendSaveLabel === 'Append to this report' && appendTitles.includes('AI balance') && appendTitles.includes('Extra balance') && (rtAiDef.charts || []).length === 2, JSON.stringify({ appendSaveLabel, appendTitles, charts: rtAiDef.charts }));
      await page.waitForSelector(`[data-plan-report-tab-close="${rtAiId}"]`, { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-report-tab-close="${rtAiId}"]`);
      await waitF(1000);
      await openCard(rtAiId, 'AI balance');
      const appendTitles2 = await page.evaluate(() => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent));
      H.check('reporttab: appended charts survive a close + reopen', appendTitles2.includes('AI balance') && appendTitles2.includes('Extra balance'), JSON.stringify(appendTitles2));
      // Block delete on the engine tab persists across a close + reopen.
      await page.waitForSelector(`[data-plan-report-tab="${genRep.id}"]`, { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-report-tab="${genRep.id}"]`);
      await waitF(1000);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'Mortgage balance'), { timeout: 15000 });
      const blocksBefore = await page.evaluate(() => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent));
      await page.evaluate((s) => { document.querySelector(s).click(); }, '[data-plan-report-block-del="0"]');
      // Wait for the post-delete render (server already applied the
      // delete; a fixed sleep read the pre-delete DOM).
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent); return b.length === 1 && b[0] === 'Headlines'; }, { timeout: 15000 });
      const blocksAfter = await page.evaluate(() => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent));
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const genDef = ((r.data.reports || []).find((x) => x.id === genRep.id) || {}).definition || {};
      H.check('reporttab: block delete removes one block and persists',
        blocksBefore.length === 2 && blocksBefore.includes('Mortgage balance') && blocksAfter.length === 1 && blocksAfter[0] === 'Headlines' && (genDef.charts || []).length === 1, JSON.stringify({ blocksBefore, blocksAfter, charts: genDef.charts }));
      await page.waitForSelector(`[data-plan-report-tab-close="${genRep.id}"]`, { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-report-tab-close="${genRep.id}"]`);
      await waitF(1000);
      await openCard(genRep.id, 'Headlines');
      const blocksReopen = await page.evaluate(() => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent));
      H.check('reporttab: deleted block stays gone after close + reopen', blocksReopen.length === 1 && blocksReopen[0] === 'Headlines', JSON.stringify(blocksReopen));
      // Polish: quiet defs note + subtitle + metric cards + current tab wrap.
      const polish = await page.evaluate(() => ({
        defs: !!document.querySelector('#planReport .plan-report-defs'),
        subtitle: !!document.querySelector('#planReport .plan-report-subtitle'),
        metric: [...document.querySelectorAll('#planReport .plan-metric-card')].length,
        currentWrap: !!document.querySelector('.plan-report-tabwrap-current'),
      }));
      H.check('reporttab: polished elements render (quiet defs note, subtitle, metric cards, current tab wrap)',
        polish.defs && polish.subtitle && polish.metric === 3 && polish.currentWrap, JSON.stringify(polish));
      // Per-tab Save triggers the browser print/export path.
      await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planReportTabSaveBtn');
      await waitF(500);
      const printCalled = await page.evaluate(() => !!window.__printCalled);
      H.check('reporttab: per-tab Save invokes the print/export path', printCalled, JSON.stringify({ printCalled }));
      // Old deep link: a #planning/report/... URL lands on the project
      // page with that report's tab open.
      await page.goto(`http://ff.local/#planning/report/${fProjectId}/${fRep2Id}`, { waitUntil: 'networkidle0', timeout: 30000 });
      // Same race as the other tabs pins: wait for the tab and its
      // blocks instead of a fixed sleep (a fixed 2000ms read the
      // not-yet-rendered viewer: tab=false, blocks=[]).
      await page.waitForSelector(`[data-plan-report-tab="${fRep2Id}"]`, { timeout: 15000 });
      await page.waitForFunction((rid) => [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent).includes('Second balance'), { timeout: 15000 }, fRep2Id);
      const deepLink = await page.evaluate((rid) => ({
        hash: location.hash,
        tab: !!document.querySelector(`[data-plan-report-tab="${rid}"]`),
        blocks: [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent),
      }), fRep2Id);
      H.check('reporttab: old report deep link lands on the project page with the tab open',
        deepLink.hash === `#planning/project/${fProjectId}` && deepLink.tab && deepLink.blocks.includes('Second balance'), JSON.stringify(deepLink));
      // UI bundle: remove-a-strategy-from-report + small toolbar
      // buttons + right-aligned strategy header.
      const ubDef = { strategies: [fStratId, fAiStratId], charts: [{ template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }] };
      r = await H.req('POST', `/api/planning/projects/${fProjectId}/reports`, { name: 'UI bundle report', definition: ubDef, strategy_ids: [fStratId, fAiStratId], scenario_ids: [fScenId] });
      H.check('uibundle: two-strategy report created', r.status === 201 && r.data.report && r.data.report.id > 0, JSON.stringify(r.data));
      const ubRepId = r.data.report.id;
      // Diagnostic first: the exact comparison call the viewer will
      // make for this report (null baseline + scenario pin). If this
      // fails, the viewer cannot open the report at all.
      r = await H.req('GET', `/api/planning/projects/${fProjectId}/comparison?scenarioIds=${fScenId}`);
      H.check('uibundle: viewer comparison endpoint answers for this report', r.status === 200 && Array.isArray(r.data.scenarioBlocks), JSON.stringify({ status: r.status, blocks: r.data && r.data.scenarioBlocks ? r.data.scenarioBlocks.length : null, err: r.data && r.data.error }));
      // The report list in the DOM predates this API-created report,
      // so leave and come back for a fresh list before opening it.
      // Open fail-soft (30s + viewer-state dump): a slow viewer must
      // fail the pin with diagnostics, never abort the module. The
      // card click can lose a seq race to the project page's restore
      // load (loadPlanProject awaits loadPlanComparison before it
      // restores the current tab): if the tab has not appeared 10s
      // after the first click, click again — the retry starts after
      // the restore finished, so it wins. If both clicks fail, the
      // deep link distinguishes a click-path fault from a load fault.
      const openUb = async () => {
        const clickCard = async () => { await page.evaluate((id) => { document.querySelector(`[data-plan-report-view="${id}"]`).click(); }, ubRepId); };
        await clickCard();
        let via = 'card';
        try {
          await page.waitForFunction((id) => [...document.querySelectorAll('[data-plan-report-tab]')].some((t) => t.dataset.planReportTab === String(id)), { timeout: 10000 }, ubRepId);
        } catch { await clickCard(); }
        try {
          await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'Mortgage balance'), { timeout: 30000 });
        } catch {
          via = 'none';
          await page.goto(`http://ff.local/#planning/report/${fProjectId}/${ubRepId}`, { waitUntil: 'networkidle0', timeout: 30000 });
          try {
            await page.waitForFunction(() => [...document.querySelectorAll('[data-plan-report-block] h3')].some((h) => h.textContent === 'Mortgage balance'), { timeout: 15000 });
            via = 'deeplink';
          } catch { /* state check below carries the diagnosis */ }
        }
        return { opened: via !== 'none', via, ...(await page.evaluate(() => ({
          tabs: [...document.querySelectorAll('[data-plan-report-tab]')].map((t) => t.dataset.planReportTab),
          blocks: [...document.querySelectorAll('[data-plan-report-block] h3')].map((h) => h.textContent),
          viewerHead: (document.querySelector('#planReport')?.textContent || '').slice(0, 200),
        }))) };
      };
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1500);
      const ubOpen = await openUb();
      H.check('uibundle: UI bundle report opens with its Mortgage balance block', ubOpen.opened && ubOpen.blocks.includes('Mortgage balance'), JSON.stringify(ubOpen));
      const ubBefore = await page.evaluate(() => ({
        removes: [...document.querySelectorAll('#planReportComparePicker [data-plan-remove]')].map((b) => Number(b.dataset.planRemove)),
        genDisabled: !!document.querySelector('#planReportTabGenerateBtn')?.disabled,
        note: document.querySelector('#planReportTabNote')?.textContent || '',
        cols: document.querySelectorAll('#planReportMergedTable thead th').length,
      }));
      H.check('uibundle: report picker shows a remove control per pinned strategy and AI pin disables preset Generate',
        ubBefore.removes.length === 2 && ubBefore.removes.includes(fStratId) && ubBefore.removes.includes(fAiStratId)
          && ubBefore.genDisabled && ubBefore.note.includes('AI-designed') && ubBefore.note.includes('strategy') && ubBefore.cols === 4,
        JSON.stringify(ubBefore));
      // Remove the AI strategy: routing recomputes from the
      // remaining pins (preset Generate re-enables) and the
      // comparison drops to one strategy column.
      await page.evaluate((id) => { document.querySelector(`#planReportComparePicker [data-plan-remove="${id}"]`).click(); }, fAiStratId);
      await page.waitForFunction(() => document.querySelectorAll('#planReportComparePicker [data-plan-remove]').length === 1, { timeout: 30000 });
      const ubAfter = await page.evaluate(() => ({
        removes: [...document.querySelectorAll('#planReportComparePicker [data-plan-remove]')].map((b) => Number(b.dataset.planRemove)),
        genDisabled: !!document.querySelector('#planReportTabGenerateBtn')?.disabled,
        note: document.querySelector('#planReportTabNote')?.textContent || '',
        cols: document.querySelectorAll('#planReportMergedTable thead th').length,
        subtitle: document.querySelector('#planReport .plan-report-subtitle')?.textContent || '',
      }));
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const ubRow = (r.data.reports || []).find((x) => x.id === ubRepId);
      H.check('uibundle: removing one strategy persists in pins, re-enables preset Generate, and narrows the comparison',
        ubAfter.removes.length === 1 && ubAfter.removes[0] === fStratId && !ubAfter.genDisabled && ubAfter.note === ''
          && ubAfter.cols === 3 && ubAfter.subtitle.includes('Flow prepay') && !ubAfter.subtitle.includes('Flow AI strategy')
          && !!ubRow && JSON.stringify(JSON.parse(ubRow.strategy_ids)) === JSON.stringify([fStratId]),
        JSON.stringify({ ubAfter, pins: ubRow && ubRow.strategy_ids }));
      // Close + reopen: the removal stays gone.
      await page.waitForSelector(`[data-plan-report-tab-close="${ubRepId}"]`, { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, `[data-plan-report-tab-close="${ubRepId}"]`);
      await waitF(1000);
      await page.goto('http://ff.local/#planning', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitF(1500);
      const ubReopenOpen = await openUb();
      H.check('uibundle: removed report reopens with its Mortgage balance block', ubReopenOpen.opened && ubReopenOpen.blocks.includes('Mortgage balance'), JSON.stringify(ubReopenOpen));
      const ubReopen = await page.evaluate(() => ({
        removes: [...document.querySelectorAll('#planReportComparePicker [data-plan-remove]')].map((b) => Number(b.dataset.planRemove)),
        cols: document.querySelectorAll('#planReportMergedTable thead th').length,
      }));
      H.check('uibundle: removed strategy stays gone after close + reopen',
        ubReopen.removes.length === 1 && ubReopen.removes[0] === fStratId && ubReopen.cols === 3, JSON.stringify(ubReopen));
      // Last-strategy removal: the server sets no minimum, so the
      // report becomes baseline-only (pins []) rather than blocking.
      await page.evaluate((id) => { document.querySelector(`#planReportComparePicker [data-plan-remove="${id}"]`).click(); }, fStratId);
      await page.waitForFunction(() => (document.querySelector('#planReport .plan-report-subtitle')?.textContent || '').includes('Strategies: None'), { timeout: 30000 });
      r = await H.req('GET', `/api/planning/projects/${fProjectId}`);
      const ubRow0 = (r.data.reports || []).find((x) => x.id === ubRepId);
      const ubEmpty = await page.evaluate(() => ({
        removes: document.querySelectorAll('#planReportComparePicker [data-plan-remove]').length,
        subtitle: document.querySelector('#planReport .plan-report-subtitle')?.textContent || '',
      }));
      H.check('uibundle: removing the last strategy leaves a baseline-only report (pins [])',
        ubEmpty.removes === 0 && ubEmpty.subtitle.includes('Strategies: None') && !!ubRow0 && JSON.stringify(JSON.parse(ubRow0.strategy_ids)) === JSON.stringify([]),
        JSON.stringify({ ubEmpty, pins: ubRow0 && ubRow0.strategy_ids }));
      // Report viewer tab buttons are small (still on the report view).
      const ubViewer = await page.evaluate(() => ({
        genSmall: !!document.querySelector('#planReportTabGenerateBtn.small'),
        aiSmall: !!document.querySelector('#planReportTabAiBtn.small'),
        saveSmall: !!document.querySelector('#planReportTabSaveBtn.small'),
      }));
      H.check('uibundle: report viewer tab buttons are small',
        ubViewer.genSmall && ubViewer.aiSmall && ubViewer.saveSmall, JSON.stringify(ubViewer));
      // The project-page comparison panel is gone; the tier buttons
      // are small.
      await page.goto(`http://ff.local/#planning/project/${fProjectId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#planFlowGenerateBtn', { timeout: 15000 });
      const ubProj = await page.evaluate(() => ({
        panelGone: !document.querySelector('#planCompareNewPanel'),
        small: ['planFlowGenerateBtn', 'planAddScenarioBtn', 'planAddStrategyBtn'].map((id) => !!document.querySelector(`#${id}.small`)),
      }));
      H.check('uibundle: project comparison panel is gone and tier buttons are small',
        ubProj.panelGone && ubProj.small.every(Boolean), JSON.stringify(ubProj));
      // Saved-template form: Apply template is small.
      r = await H.req('POST', '/api/planning/templates', { name: 'UI bundle template', spec: fAiModelDef, metadata_schema: [], metadata_answers: {} });
      H.check('uibundle: saved template created', r.status === 201 && r.data.template && r.data.template.id > 0, JSON.stringify(r.data));
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planAddStrategyBtn');
      // Saved templates live inside the AI fallback screen of the
      // preset chooser (Add → AI design → From saved template).
      await page.waitForSelector('#planChooseAi', { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planChooseAi');
      await page.waitForSelector('#planChooseSaved', { timeout: 15000 });
      await page.evaluate((s) => { document.querySelector(s).click(); }, '#planChooseSaved');
      await page.waitForSelector('#planSavedTemplateApply', { timeout: 15000 });
      const ubTpl = await page.evaluate(() => ({
        applySmall: !!document.querySelector('#planSavedTemplateApply.small'),
        refineSmall: !!document.querySelector('#planSavedTemplateRefine.small'),
      }));
      H.check('uibundle: saved-template Apply/Refine buttons are small',
        ubTpl.applySmall && ubTpl.refineSmall, JSON.stringify(ubTpl));
      await page.evaluate(() => { document.querySelector('[data-close-modal]')?.click(); });
      await waitF(500);
      // Strategy detail header: Merge is small and the tools sit at
      // the right edge (title left, tools right, small panel gap).
      await page.goto(`http://ff.local/#planning/strategy/${fStratId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#planStrategyHeaderTools', { timeout: 15000 });
      // Wait until the header is actually rendered: the tools div
      // enters the DOM while the detail section is still hidden, so
      // an immediate measure reads all-zero rects (rightGap 0,
      // toolsAfterTitle false) even though the laid-out header is
      // correct. Waiting for a non-zero rect keeps the geometry
      // check exactly as strong — a truly hidden/broken header
      // times out here and the check below still fails.
      await page.waitForFunction(() => {
        const t = document.querySelector('#planStrategyHeaderTools');
        return !!t && t.getBoundingClientRect().width > 0;
      }, { timeout: 15000 }).catch(() => {});
      const ubStrat = await page.evaluate(() => {
        const tools = document.querySelector('#planStrategyHeaderTools');
        const title = document.querySelector('#planStrategyTitle');
        const panel = tools ? tools.closest('.panel') : null;
        const tr = tools ? tools.getBoundingClientRect() : null;
        const pr = panel ? panel.getBoundingClientRect() : null;
        const tir = title ? title.getBoundingClientRect() : null;
        return {
          mergeSmall: !!document.querySelector('#planMergeBtn.small'),
          rightGap: (tr && pr) ? Math.round(pr.right - tr.right) : null,
          toolsAfterTitle: (tr && tir) ? tr.left > tir.right : null,
        };
      });
      H.check('uibundle: strategy header Merge is small and tools sit at the right edge',
        ubStrat.mergeSmall && ubStrat.rightGap != null && ubStrat.rightGap <= 32 && ubStrat.toolsAfterTitle === true, JSON.stringify(ubStrat));
    } finally { await browserF.close(); }
  }
}

runModuleMain(import.meta.url, { name: 'planning', deps, depNames: SLIM_PLAN ? [] : ['core', 'costs', 'nollm', 'terms', 'photos', 'ui-property', 'costs-nollm', 'assessments', 'chart-colors', 'veil', 'investments', 'csv-wizard', 'earnings', 'spending'], run });
