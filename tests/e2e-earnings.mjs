// earnings: Earnings: salary + rental API + browser rounds — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-earnings.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only earnings]
import http from 'node:http';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
import { run as runInvestments } from './e2e-investments.mjs';
import { run as runCsvWizard } from './e2e-csv-wizard.mjs';
export const deps = [runInvestments, runCsvWizard];
export async function run(H, S) {
  let r;
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Acme Corp', currency: 'CAD', province: 'BC', frequency: 'annual',
    gross_amount: 60000, gross_basis: 'annual', tax_year: 2026,
  });
  H.check('earnings: job created with the pinned CPP/EI figures',
    r.status === 201 && r.data.calc.cpp === 3361.75 && r.data.calc.ei === 978, JSON.stringify(r.data.calc));
  const earnJobId = r.data.id;
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'No SIN Here', currency: 'CAD', province: 'QC', frequency: 'monthly',
    gross_amount: 5000, gross_basis: 'period', tax_year: 2026,
  });
  H.check('earnings: unverified province computes federal only, provincial null',
    r.status === 201 && r.data.calc.provincialTax === null && r.data.calc.provinceVerified === false,
    JSON.stringify(r.data.calc));
  r = await H.req('POST', '/api/earnings/rentals', {
    label: 'Basement suite', rental_type: 'long_term', services_level: 'basic', ownership_pct: 50,
  });
  H.check('earnings: rental created', r.status === 201 && r.data.label === 'Basement suite', JSON.stringify(r.data));
  const earnRentalId = r.data.id;
  r = await H.req('POST', `/api/earnings/rentals/${earnRentalId}/years`, {
    tax_year: 2026, other_income: 0, area_share_pct: 50,
    mortgage_interest: 6000, mortgage_principal: 9000,
    expenses: [{ line: '9180', amount: 12000, direct: false }, { line: '8521', amount: 500, direct: true }],
  });
  H.check('earnings: rental year created without typed rent figures', r.status === 201 && r.data.tax_year === 2026, JSON.stringify(r.data));
  r = await H.req('POST', `/api/earnings/rentals/${earnRentalId}/entries`, {
    start_ym: '2025-01', end_ym: '2026-12', monthly_rent: 2000, pay_day: 1, cash_amount: 500, tenant_name: 'Test Tenant',
  });
  H.check('earnings: rent entry created with tenant as a plain string', r.status === 201
    && r.data.entries.length === 1 && r.data.entries[0].tenant_name === 'Test Tenant'
    && r.data.entries[0].cash_amount === 500, JSON.stringify(r.data.entries));
  r = await H.req('POST', `/api/earnings/rentals/${earnRentalId}/entries`, {
    start_ym: '2026-01', monthly_rent: 1000, pay_day: 32,
  });
  H.check('earnings: rent entry validation rejects pay day 32', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/earnings/rentals/${earnRentalId}/entries`, {
    start_ym: '2026-01', monthly_rent: 1000, pay_day: 1, cash_amount: 1001,
  });
  H.check('earnings: rent entry validation rejects cash over monthly rent', r.status === 400, JSON.stringify(r.data));
  r = await H.req('GET', '/api/earnings');
  const earnYear2026 = r.data.rentals[0].years.find((y) => y.tax_year === 2026);
  const earnYear2025 = r.data.rentals[0].years.find((y) => y.tax_year === 2025);
  H.check('earnings: entry auto-creates covered years and derives gross + days (no typing)',
    r.status === 200 && r.data.rentals[0].years.length === 2
    && earnYear2026.gross_rents === 24000 && earnYear2026.rental_days === 365 && earnYear2026.rent_derived === true
    && earnYear2026.calc.personalPortion9949 === 6000 && earnYear2026.calc.ownerShareNet === 5750
    && earnYear2026.calc.netWhole9946 === 11500 && earnYear2026.calc.gst.status === 'exempt'
    && earnYear2025.gross_rents === 24000 && earnYear2025.rental_days === 365,
    JSON.stringify(r.data.rentals[0].years.map((y) => ({ tax_year: y.tax_year, gross_rents: y.gross_rents, rental_days: y.rental_days, rent_derived: y.rent_derived, calc: y.calc }))));
  r = await H.req('GET', '/api/earnings');
  H.check('earnings: overview lists both jobs and the rental with computed summaries',
    r.status === 200 && r.data.jobs.length === 2 && r.data.rentals.length === 1
    && r.data.rentals[0].years.length === 2 && r.data.payrollProvinces.some((p) => p.code === 'BC' && p.verified)
    && r.data.payrollProvinces.some((p) => p.code === 'QC' && !p.verified),
    JSON.stringify({ jobs: r.data.jobs.length, rentals: r.data.rentals.length }));
  r = await H.req('GET', '/api/summary');
  H.check('earnings: flows do not enter the net-worth summary',
    r.status === 200 && r.data.netWorth === S.sumBefore.data.netWorth
    && r.data.propertyValue === S.sumBefore.data.propertyValue && r.data.otherAssets === S.sumBefore.data.otherAssets,
    JSON.stringify({ before: S.sumBefore.data, after: r.data }));
  r = await H.req('GET', '/api/earnings/charts');
  H.check('earnings charts: aggregation sums salary gross and rental 9946 net by year',
    r.status === 200 && JSON.stringify(r.data.years) === '[2025,2026]'
    && r.data.salary[2026].gross === 120000 && r.data.rentals[2026].net === 11500
    && r.data.rentals[2026].gross === 24000 && r.data.rentals[2026].expenses === 12500
    && r.data.overview[2026].rentalNet === 11500
    && r.data.rentals[2025].gross === 24000 && r.data.rentals[2025].net === 24000
    && r.data.overview[2025].rentalNet === 24000
    && r.data.employers.includes('Acme Corp') && r.data.properties.length === 1,
    JSON.stringify(r.data));
  // Editing the entry recomputes the affected years, then reverts.
  const earnEntryId = (await H.req('GET', '/api/earnings')).data.rentals[0].entries[0].id;
  r = await H.req('PUT', `/api/earnings/rentals/${earnRentalId}/entries/${earnEntryId}`, {
    start_ym: '2025-01', end_ym: '2026-12', monthly_rent: 2100, pay_day: 1, cash_amount: 500, tenant_name: 'Test Tenant',
  });
  H.check('earnings: editing an entry recomputes the derived year gross',
    r.status === 200 && r.data.years.find((y) => y.tax_year === 2026).gross_rents === 25200,
    JSON.stringify(r.data.years.map((y) => ({ tax_year: y.tax_year, gross_rents: y.gross_rents }))));
  r = await H.req('PUT', `/api/earnings/rentals/${earnRentalId}/entries/${earnEntryId}`, {
    start_ym: '2025-01', end_ym: '2026-12', monthly_rent: 2000, pay_day: 1, cash_amount: 500, tenant_name: 'Test Tenant',
  });
  H.check('earnings: entry edit reverts to the original derived gross',
    r.status === 200 && r.data.years.find((y) => y.tax_year === 2026).gross_rents === 24000,
    JSON.stringify(r.data.years.map((y) => ({ tax_year: y.tax_year, gross_rents: y.gross_rents }))));
  // ---- Earnings: browser pass over the new section ----
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('earnings browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    const forwardE = (rq) => new Promise((resolve, reject) => {
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
    const loginResE = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueE = loginResE.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserE = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserE.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardE({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
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
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueE, domain: 'ff.local', path: '/', httpOnly: true });
      const waitE = (ms) => new Promise((res2) => setTimeout(res2, ms));
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const salaryText = await page.evaluate(() => document.querySelector('#earn-salary').textContent);
      H.check('earnings UI: salary section lists the job with annual net',
        salaryText.includes('Acme Corp') && salaryText.includes('Annual net'),
        salaryText.slice(0, 300));
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const rentalText = await page.evaluate(() => document.querySelector('#earn-rentals').textContent);
      H.check('earnings UI: rentals section lists the rental with its T776 year summary',
        rentalText.includes('Basement suite') && rentalText.includes('Owner share'),
        rentalText.slice(0, 300));
      // Earnings charts: overview composition, rental net — plus
      // the standard legend left-click toggle. The Salary view
      // carries no chart any more (it moved to the job detail
      // page), so its panel-absence is pinned below instead.
      const clickLegend = (chartKey, seriesKey) => page.evaluate((ck, sk) => {
        const c = window.__fmCharts[ck];
        if (!c || !c.legend) return 'no-chart';
        const i = c.legend.legendItems.findIndex((it) => {
          const ds = c.data.datasets[it.datasetIndex];
          return ds && ds.key === sk;
        });
        if (i < 0) return 'no-item';
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        c.canvas.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true,
          clientX: r.left + b.left + b.width / 2, clientY: r.top + b.top + b.height / 2,
        }));
        return 'clicked';
      }, chartKey, seriesKey);
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const ovInfo = await page.evaluate(() => {
        const c = window.__fmCharts.earnOverview;
        return c ? { labels: c.data.labels, keys: c.data.datasets.map((d) => d.key) } : null;
      });
      H.check('earnings charts: overview composition shows salary + rental series for 2026',
        ovInfo && ovInfo.labels.includes('2026') && ovInfo.keys.includes('salary') && ovInfo.keys.includes('rental'),
        JSON.stringify(ovInfo));
      await clickLegend('earnOverview', 'salary');
      await waitE(300);
      const salaryHidden = await page.evaluate(() => {
        const c = window.__fmCharts.earnOverview;
        return c ? !c.isDatasetVisible(0) : null;
      });
      H.check('earnings charts: legend left click hides the salary series',
        salaryHidden === true, JSON.stringify(salaryHidden));
      // The Salary view carries no chart any more: the annual salary
      // chart moved to the job detail page as a monthly stacked
      // chart. The view keeps its header, estimate note and list.
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const salGone = await page.evaluate(() => ({
        canvas: !!document.querySelector('#earnSalaryChart'),
        range: !!document.querySelector('#earnSalaryRange'),
        empty: !!document.querySelector('#earnSalaryEmpty'),
        rangeBar: !!document.querySelector('[data-earn-range="salary"]'),
        chart: !!window.__fmCharts.earnSalary,
        list: !!document.querySelector('#earnJobList'),
        addBtn: !!document.querySelector('#addEarnJobBtn'),
      }));
      H.check('earnings UI: salary chart panel is gone from the Salary view, list and Add stay',
        !salGone.canvas && !salGone.range && !salGone.empty && !salGone.rangeBar && !salGone.chart
        && salGone.list && salGone.addBtn, JSON.stringify(salGone));
      // Earnings range bars use the shared month picker now, not
      // native year selects (whose popup rendered detached from
      // the panel). The picked month's YEAR drives the year filter.
      // The picker coverage moved to the overview bar with the
      // salary chart's removal.
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const earnRangeUi = await page.evaluate(() => {
        const bar = document.querySelector('[data-earn-range="overview"]');
        return {
          hasSelect: !!bar.querySelector('select'),
          hasFromBtn: !!bar.querySelector('[data-earn-month="from"]'),
          hasToBtn: !!bar.querySelector('[data-earn-month="to"]'),
        };
      });
      H.check('earnings UI: overview range bar uses month-field buttons, no native year selects',
        !earnRangeUi.hasSelect && earnRangeUi.hasFromBtn && earnRangeUi.hasToBtn, JSON.stringify(earnRangeUi));
      const earnPresetSet = await page.evaluate(() => {
        const bar = document.querySelector('[data-earn-range="overview"]');
        const q = (s) => !!bar.querySelector(s);
        return { three: q('[data-preset="3mo"]'), ytd: q('[data-preset="ytd"]'), two: q('[data-years="2"]'), all: q('[data-years="0"]'), five: q('[data-years="5"]'), ten: q('[data-years="10"]'), one: q('[data-years="1"]') };
      });
      H.check('date range: salary overview presets are 3 months / This year / 2 years / All (no 1/5/10-year buttons)',
        earnPresetSet.three && earnPresetSet.ytd && earnPresetSet.two && earnPresetSet.all && !earnPresetSet.five && !earnPresetSet.ten && !earnPresetSet.one,
        JSON.stringify(earnPresetSet));
      await page.click('[data-earn-range="overview"] [data-preset="ytd"]');
      await waitE(500);
      const earnYtd = await page.evaluate(() => {
        const c = window.__fmCharts.earnOverview;
        const bar = document.querySelector('[data-earn-range="overview"]');
        return { labels: c ? c.data.labels : null,
          from: bar.querySelector('[data-earn-month="from"]').dataset.value,
          to: bar.querySelector('[data-earn-month="to"]').dataset.value };
      });
      H.check('date range: salary This year preset filters the overview chart to the current tax year',
        earnYtd.labels && earnYtd.labels.length >= 1 && earnYtd.labels.every((y) => y === '2026') && earnYtd.from === '2026-01',
        JSON.stringify(earnYtd));
      await page.click('[data-earn-range="overview"] [data-years="2"]');
      await waitE(500);
      const earn2y = await page.evaluate(() => {
        const c = window.__fmCharts.earnOverview;
        return c ? c.data.labels : null;
      });
      H.check('date range: salary 2 years preset shows the last two tax years',
        earn2y && earn2y.includes('2025') && earn2y.includes('2026') && earn2y.every((y) => Number(y) >= 2025),
        JSON.stringify(earn2y));
      await page.click('[data-earn-range="overview"] [data-years="0"]');
      await waitE(500);
      const earnAll2 = await page.evaluate(() => {
        const c = window.__fmCharts.earnOverview;
        return c ? c.data.labels : null;
      });
      H.check('date range: salary All preset restores all tax years',
        earnAll2 && earnAll2.includes('2025') && earnAll2.includes('2026'),
        JSON.stringify(earnAll2));
      await page.click('[data-earn-range="overview"] [data-earn-month="from"]');
      await waitE(300);
      const earnPopRect = await page.evaluate(() => {
        const f = document.querySelector('[data-earn-range="overview"] [data-earn-month="from"]').getBoundingClientRect();
        const p = document.querySelector('#monthPop');
        const pr = p.getBoundingClientRect();
        return { hidden: p.classList.contains('hidden'), fBottom: f.bottom, fLeft: f.left, pTop: pr.top, pLeft: pr.left, pWidth: p.offsetWidth, vw: window.innerWidth };
      });
      H.check('earnings UI: the month picker opens glued to its overview From button',
        !earnPopRect.hidden && Math.abs(earnPopRect.pTop - (earnPopRect.fBottom + 6)) <= 2
        && Math.abs(earnPopRect.pLeft - Math.max(4, Math.min(earnPopRect.fLeft, earnPopRect.vw - earnPopRect.pWidth - 4))) <= 2,
        JSON.stringify(earnPopRect));
      await page.click('#monthPop button[data-ym="2026-06"]');
      await waitE(600);
      const earnPick = await page.evaluate(() => {
        const c = window.__fmCharts.earnOverview;
        const btn = document.querySelector('[data-earn-range="overview"] [data-earn-month="from"]');
        return { labels: c ? c.data.labels : null, btnText: btn ? btn.textContent : null, btnVal: btn ? btn.dataset.value : null };
      });
      H.check('earnings UI: picking Jun 2026 filters the overview chart to 2026+ and labels the button',
        earnPick.labels && earnPick.labels.length >= 1 && earnPick.labels.includes('2026')
        && earnPick.labels.every((y) => Number(y) >= 2026)
        && earnPick.btnText === 'Jun 2026' && earnPick.btnVal === '2026-06',
        JSON.stringify(earnPick));
      await page.click('[data-earn-range="overview"] [data-years="0"]');
      await waitE(500);
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const rentInfo = await page.evaluate(() => {
        const c = window.__fmCharts.earnRentals;
        if (!c) return null;
        const line = c.data.datasets.find((d) => d.type === 'line');
        return {
          labels: c.data.labels, keys: c.data.datasets.map((d) => d.key),
          bars: c.data.datasets.filter((d) => d.type !== 'line').map((d) => d.data),
          line: line ? { label: line.label, data: line.data } : null,
        };
      });
      const rentLineOk = rentInfo && rentInfo.line && rentInfo.line.label === 'Total net'
        && rentInfo.line.data.every((v, i) => Math.abs(v - rentInfo.bars.reduce((s, arr) => s + (arr[i] || 0), 0)) < 0.011);
      H.check('earnings charts: rentals chart shows the property net series + Total net line',
        rentInfo && rentInfo.labels.includes('2026') && rentInfo.keys.some((k) => k.startsWith('rental:')) && rentLineOk,
        JSON.stringify(rentInfo));
      await page.click('#earnRentalsViewBtns [data-view="income"]');
      await waitE(500);
      const rentIncomeInfo = await page.evaluate(() => {
        const c = window.__fmCharts.earnRentals;
        if (!c) return null;
        const line = c.data.datasets.find((d) => d.type === 'line');
        const bars = c.data.datasets.filter((d) => d.type !== 'line');
        return {
          keys: c.data.datasets.map((d) => d.key),
          gross: bars.find((d) => d.key === 'gross') ? bars.find((d) => d.key === 'gross').data : null,
          expenses: bars.find((d) => d.key === 'expenses') ? bars.find((d) => d.key === 'expenses').data : null,
          line: line ? { label: line.label, data: line.data } : null,
        };
      });
      const rentIncomeLineOk = rentIncomeInfo && rentIncomeInfo.line && rentIncomeInfo.line.label === 'Net'
        && rentIncomeInfo.gross && rentIncomeInfo.expenses
        && rentIncomeInfo.line.data.every((v, i) => Math.abs(v - Math.round((rentIncomeInfo.gross[i] - rentIncomeInfo.expenses[i]) * 100) / 100) < 0.011);
      H.check('earnings charts: income vs expenses view swaps in gross + expenses series + Net line',
        rentIncomeInfo && rentIncomeInfo.keys.includes('gross') && rentIncomeInfo.keys.includes('expenses') && rentIncomeLineOk,
        JSON.stringify(rentIncomeInfo));

      // Rent entries UI: the rental card lists the entry (tenant as a
      // plain string) and the year block marks its days as derived;
      // the monthly-rent money input groups while typing.
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const entryUi = await page.evaluate(async () => {
        const text = document.querySelector('#earn-rentals').textContent;
        const d = await (await fetch('/api/earnings')).json();
        const rental = d.rentals.find((x) => x.label === 'Basement suite');
        window.earnAddEntry(rental.id);
        const input = document.querySelector('#earnRentalEntryForm [name="monthly_rent"]');
        input.value = '1234';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const grouped = input.value;
        document.querySelector('#earnRentalEntryCancelBtn').click();
        return { textHasTenant: text.includes('Test Tenant'), textHasDerived: text.includes('from rent entries'), grouped };
      });
      H.check('earnings UI: rental card lists the rent entry and marks derived days',
        entryUi.textHasTenant && entryUi.textHasDerived, JSON.stringify(entryUi));
      H.check('earnings UI: monthly-rent input groups thousands while typing',
        entryUi.grouped === '1,234', JSON.stringify(entryUi));

      // Rental modals: the rent entry modal (not an inline
      // panel); saving from the modal creates the entry and the
      // card refreshes with derived years; + Year record is gone;
      // year edit opens a modal too. The card no longer carries
      // + Rent entry — the detail panel does — so the modal here
      // opens through the same handler the button calls, and the
      // detail button itself is pinned in the detail section below.
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Modal rental', rental_type: 'long_term', services_level: 'basic', ownership_pct: 100,
      });
      H.check('rental modals setup: rental created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const modalRentalId = r.data.id;
      // Same-hash navigation does not reload — go away and back so
      // loadEarnings renders the new card before clicking its button.
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(500);
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const modalUi = await page.evaluate(() => {
        const hasYearBtn = [...document.querySelectorAll('#earnRentalList button')].some((b) => b.textContent.includes('Year record'));
        const inlinePanel = document.querySelector('#earnRentalEntryFormPanel') || document.querySelector('#earnRentalYearFormPanel') || document.querySelector('#earnRentalFormPanel');
        return { hasYearBtn, inlinePanel: !!inlinePanel };
      });
      await page.evaluate((rid) => window.earnAddEntry(rid), modalRentalId);
      await waitE(300);
      const modalOpen = await page.evaluate(() => {
        const modal = document.querySelector('#earnRentalEntryModal');
        return modal && !modal.classList.contains('hidden') && !!modal.querySelector('.modal-card #earnRentalEntryForm');
      });
      H.check('rental modals: rent entry modal opens, no inline panel remains',
        modalOpen && !modalUi.inlinePanel, JSON.stringify({ ...modalUi, modalOpen }));
      H.check('rental modals: + Year record button is gone from rental cards',
        !modalUi.hasYearBtn, JSON.stringify(modalUi));
      // The entry From/To fields are the app's month-field picker
      // (same popover as the range pickers), not native month inputs.
      const entryPicker = await page.evaluate(() => {
        const f = document.querySelector('#earnRentalEntryForm');
        const startBtn = document.querySelector('#earnEntryStartBtn');
        const endBtn = document.querySelector('#earnEntryEndBtn');
        return {
          nativeMonth: !!f.querySelector('input[type="month"]'),
          startIsField: !!startBtn && startBtn.classList.contains('month-field'),
          endIsField: !!endBtn && endBtn.classList.contains('month-field'),
        };
      });
      H.check('rental modals: entry From/To are month-field picker buttons, no native month inputs',
        !entryPicker.nativeMonth && entryPicker.startIsField && entryPicker.endIsField, JSON.stringify(entryPicker));
      // Pick both months through the popup: open, step the year,
      // click the cell — the same interaction as the range picker.
      const pickEntryMonth = (btnSel, ym) => page.evaluate(([sel, target]) => {
        document.querySelector(sel).click();
        const ty = Number(target.slice(0, 4));
        const yearEl = document.querySelector('#monthPopYear');
        let guard = 0;
        while (Number(yearEl.textContent) !== ty && guard++ < 120) {
          const btn = ty < Number(yearEl.textContent)
            ? document.querySelector('#monthPopPrev') : document.querySelector('#monthPopNext');
          if (!btn || btn.disabled) break;
          btn.click();
        }
        const cell = document.querySelector(`#monthPopGrid button[data-ym="${target}"]`);
        if (!cell || cell.disabled) throw new Error(`month cell ${target} not pickable`);
        cell.click();
      }, [btnSel, ym]);
      await pickEntryMonth('#earnEntryStartBtn', '2026-01');
      await waitE(200);
      await pickEntryMonth('#earnEntryEndBtn', '2026-12');
      await waitE(200);
      const pickedEntry = await page.evaluate(() => {
        const f = document.querySelector('#earnRentalEntryForm');
        return {
          startVal: f.start_ym.value, startLabel: document.querySelector('#earnEntryStartBtn').textContent,
          endVal: f.end_ym.value, endLabel: document.querySelector('#earnEntryEndBtn').textContent,
          popHidden: document.querySelector('#monthPop').classList.contains('hidden'),
        };
      });
      H.check('rental modals: picking through the popup sets YYYY-MM values and formatted labels',
        pickedEntry.startVal === '2026-01' && pickedEntry.startLabel === 'Jan 2026'
          && pickedEntry.endVal === '2026-12' && pickedEntry.endLabel === 'Dec 2026' && pickedEntry.popHidden,
        JSON.stringify(pickedEntry));
      // Scroll safety for the modal fields: the same fixed popover
      // serves the entry buttons, and the modal overlay is itself
      // a scroll container — scrolling must neither strand the
      // picker nor close it while its button stays in view.
      await page.evaluate(() => document.querySelector('#earnEntryStartBtn').click());
      await waitE(200);
      const entryPopRect = () => page.evaluate(() => {
        const b = document.querySelector('#earnEntryStartBtn').getBoundingClientRect();
        const p = document.querySelector('#monthPop');
        const pr = p.getBoundingClientRect();
        return { hidden: p.classList.contains('hidden'), bBottom: b.bottom, bLeft: b.left, pTop: pr.top, pLeft: pr.left, pWidth: p.offsetWidth, vw: window.innerWidth };
      });
      const entryBefore = await entryPopRect();
      await page.evaluate(() => {
        const ov = document.querySelector('#earnRentalEntryModal');
        if (ov) ov.scrollBy(0, 150);
        window.scrollBy(0, 150);
      });
      await waitE(300);
      const entryAfter = await entryPopRect();
      const entryWantLeft = Math.max(4, Math.min(entryAfter.bLeft, entryAfter.vw - entryAfter.pWidth - 4));
      H.check('rental modals: scrolling with the entry picker open keeps it anchored to its button',
        !entryAfter.hidden
        && Math.abs(entryAfter.pTop - (entryAfter.bBottom + 6)) <= 2
        && Math.abs(entryAfter.pLeft - entryWantLeft) <= 2,
        JSON.stringify({ before: entryBefore, after: entryAfter, wantLeft: entryWantLeft }));
      // Close the picker by toggling its own button: a global Esc
      // would also close the modal (app.js:311), which the steps
      // below still need open.
      await page.evaluate(() => document.querySelector('#earnEntryStartBtn').click());
      await waitE(150);
      await page.type('#earnRentalEntryForm [name="monthly_rent"]', '1500');
      await waitE(200);
      const modalGrouped = await page.evaluate(() => document.querySelector('#earnRentalEntryForm [name="monthly_rent"]').value);
      H.check('rental modals: monthly-rent input groups while typing inside the modal',
        modalGrouped === '1,500', JSON.stringify(modalGrouped));
      await page.type('#earnRentalEntryForm [name="tenant_name"]', 'Modal Tenant');
      await page.evaluate(() => { document.querySelector('#earnRentalEntryForm').pay_day.value = '1'; });
      await page.click('#earnRentalEntryForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#earnRentalList').textContent.includes('Modal Tenant'), { timeout: 10000 });
      r = await H.req('GET', '/api/earnings');
      const modalRental = (r.data.rentals || []).find((x) => x.id === modalRentalId);
      const modalYear = modalRental && modalRental.years.find((y) => y.tax_year === 2026);
      H.check('rental modals: saving from the modal creates the entry with derived year figures',
        !!modalRental && modalRental.entries.some((e) => e.tenant_name === 'Modal Tenant')
          && !!modalYear && modalYear.rent_derived === true && modalYear.gross_rents === 18000,
        JSON.stringify(modalYear));
      await page.evaluate((rid, yid) => window.earnEditYear(rid, yid), modalRentalId, modalYear.id);
      await waitE(300);
      const yearModalOpen = await page.evaluate(() => {
        const m = document.querySelector('#earnRentalYearModal');
        return m && !m.classList.contains('hidden') && !!m.querySelector('.modal-card #earnRentalYearForm');
      });
      H.check('rental modals: editing a year record opens a modal', yearModalOpen === true, JSON.stringify(yearModalOpen));
      await page.click('#earnRentalYearCancelBtn');
      await waitE(200);
      const yearModalClosed = await page.evaluate(() => document.querySelector('#earnRentalYearModal').classList.contains('hidden'));
      H.check('rental modals: year modal Cancel closes it', yearModalClosed === true, JSON.stringify(yearModalClosed));

      // Blank To still means ongoing: pick only a start month and
      // save; the entry stores a null end and the card shows it.
      await page.evaluate((rid) => window.earnAddEntry(rid), modalRentalId);
      await waitE(300);
      await pickEntryMonth('#earnEntryStartBtn', '2025-06');
      await waitE(200);
      const blankTo = await page.evaluate(() => {
        const f = document.querySelector('#earnRentalEntryForm');
        return { startVal: f.start_ym.value, endVal: f.end_ym.value, endLabel: document.querySelector('#earnEntryEndBtn').textContent };
      });
      H.check('rental modals: leaving To unpicked keeps it blank (ongoing)',
        blankTo.startVal === '2025-06' && blankTo.endVal === '' && blankTo.endLabel === '—', JSON.stringify(blankTo));
      await page.type('#earnRentalEntryForm [name="monthly_rent"]', '2000');
      await page.evaluate(() => { document.querySelector('#earnRentalEntryForm').pay_day.value = '5'; });
      await page.click('#earnRentalEntryForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#earnRentalList').textContent.includes('Jun 2025 – Ongoing'), { timeout: 10000 });
      r = await H.req('GET', '/api/earnings');
      const ongoingRental = (r.data.rentals || []).find((x) => x.id === modalRentalId);
      const ongoingEntry = ongoingRental && ongoingRental.entries.find((e) => e.start_ym === '2025-06');
      H.check('rental modals: blank-To entry saves with a null end',
        !!ongoingEntry && ongoingEntry.end_ym === null, JSON.stringify(ongoingEntry));

      // Rental detail page: card click navigates; eye does not; the
      // detail carries header Edit/Delete + summary + chart +
      // both history panels; the cards no longer show rental
      // Edit/Delete or + Rent entry; Total income stays.
      page.on('dialog', (d) => d.accept());
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Detail rental', rental_type: 'long_term', services_level: 'basic', ownership_pct: 66.67,
      });
      H.check('rental detail setup: rental created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const detailRentalId = r.data.id;
      r = await H.req('POST', `/api/earnings/rentals/${detailRentalId}/years`, {
        tax_year: 2025, other_income: 0, area_share_pct: 100,
        mortgage_interest: 0, mortgage_principal: 0,
        expenses: [{ line: '9180', amount: 4000, direct: false }],
      });
      H.check('rental detail setup: 2025 year with expenses created', r.status === 201 && r.data.tax_year === 2025, JSON.stringify(r.data));
      r = await H.req('POST', `/api/earnings/rentals/${detailRentalId}/entries`, {
        start_ym: '2024-01', end_ym: '2024-12', monthly_rent: 1000, pay_day: 1,
      });
      H.check('rental detail setup: 2024 entry created', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/earnings/rentals/${detailRentalId}/entries`, {
        start_ym: '2025-01', end_ym: '2025-12', monthly_rent: 2000, pay_day: 1,
      });
      H.check('rental detail setup: 2025 entry created', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Empty rental', rental_type: 'long_term', services_level: 'basic', ownership_pct: 100,
      });
      H.check('rental detail setup: empty rental created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const emptyRentalId = r.data.id;
      // Same-hash navigation does not reload — go away and back so
      // loadEarnings renders the new cards before clicking one.
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(500);
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const detailCardHead = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Detail rental'));
        if (!card) return null;
        const head = card.querySelector('.section-head');
        return {
          headBtns: [...head.querySelectorAll('button')].map((b) => b.textContent.trim()),
          hasEye: !!card.querySelector('.rent-hide-btn'),
        };
      });
      H.check('rental card header has no buttons, eye stays',
        detailCardHead && detailCardHead.headBtns.length === 0
          && detailCardHead.hasEye,
        JSON.stringify(detailCardHead));
      // Eye click must not navigate.
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Detail rental'));
        card.querySelector('.rent-hide-btn').click();
      });
      await waitE(300);
      H.check('rental card eye click does not navigate to a detail page',
        await page.evaluate(() => location.hash === '#earnings/rentals'));
      // Restore visibility for the steps below.
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Detail rental'));
        card.querySelector('.rent-hide-btn').click();
      });
      await waitE(300);
      // Card click (on the heading, not a button) navigates.
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Detail rental'));
        card.querySelector('h3').click();
      });
      try { await page.waitForFunction((id) => location.hash === `#earnings/rental/${id}`, { timeout: 10000 }, detailRentalId); } catch {}
      const detailNav = await page.evaluate(() => ({
        hash: location.hash,
        detailHidden: document.querySelector('#earnRentalDetail').classList.contains('hidden'),
        listHidden: document.querySelector('#earn-rentals').classList.contains('hidden'),
      }));
      H.check('rental card click navigates to the detail page',
        detailNav.hash === `#earnings/rental/${detailRentalId}` && !detailNav.detailHidden && detailNav.listHidden,
        JSON.stringify(detailNav));
      // The hash changes before the async detail load finishes — wait
      // for the rendered back link, not just the hash, before reading.
      await page.waitForFunction(() => !!document.querySelector('#earnRentalBackLink'), { timeout: 10000 });
      // The detail Rent entries panel keeps its + Rent entry button:
      // clicking it opens the modal without navigating away.
      await page.evaluate(() => document.querySelector('#earnRentalDetailAddEntry').click());
      await waitE(300);
      const detailEntryModalNav = await page.evaluate(() => ({
        hash: location.hash,
        open: !document.querySelector('#earnRentalEntryModal').classList.contains('hidden'),
      }));
      H.check('rental detail + Rent entry click opens the modal without navigating',
        detailEntryModalNav.hash === `#earnings/rental/${detailRentalId}` && detailEntryModalNav.open === true,
        JSON.stringify(detailEntryModalNav));
      await page.click('#earnRentalEntryCancelBtn');
      await waitE(200);
      const apiDetailRental = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.id === detailRentalId);
      const sortedDetailYears = [...apiDetailRental.years].sort((a, b) => a.tax_year - b.tax_year);
      const latestDetailYear = sortedDetailYears[sortedDetailYears.length - 1];
      const cad = (v) => Number(v).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const detailInfo = await page.evaluate(() => {
        const d = document.querySelector('#earnRentalDetail');
        const head = d ? d.firstElementChild : null;
        const back = document.querySelector('#earnRentalBackLink');
        const chart = window.__fmCharts && window.__fmCharts.earnRentalDetail;
        return {
          backTag: back ? back.tagName : null,
          backText: back ? back.textContent.trim() : null,
          backHref: back ? back.getAttribute('href') : null,
          backClass: back ? back.className : null,
          headButtons: head ? head.querySelectorAll('button').length : null,
          headIsToolbar: !!head && head.classList.contains('toolbar'),
          header: d ? (d.querySelector('.panel .section-head')?.textContent || null) : null,
          cards: [...d.querySelectorAll('.summary-card')].map((c) => [
            c.querySelector('.k')?.textContent.trim(), c.querySelector('.v')?.textContent.trim()]),
          chartLabels: chart ? chart.data.labels : null,
          chartSets: chart ? chart.data.datasets.map((s) => ({ label: s.label, data: s.data })) : null,
          hasYearPanel: !!([...d.querySelectorAll('.panel .section-head h3')].find((h) => h.textContent.trim() === 'Year records')),
          hasEntryPanel: !!([...d.querySelectorAll('.panel .section-head h3')].find((h) => h.textContent.trim() === 'Rent entries')),
          yearText: d.textContent.includes('2024') && d.textContent.includes('2025'),
          entryText: d.textContent.includes('$1,000.00/mo') && d.textContent.includes('$2,000.00/mo'),
          detailAddEntry: !!document.querySelector('#earnRentalDetailAddEntry'),
          noBottomRow: !document.querySelector('#earnRentalDetailActions'),
          headerEdit: !!document.querySelector('#earnRentalDetailEditBtn'),
          headerDelete: !!document.querySelector('#earnRentalDetailDeleteBtn'),
          headerEditInHead: !!document.querySelector('#earnRentalDetail .panel .section-head #earnRentalDetailEditBtn'),
          headerDeleteInHead: !!document.querySelector('#earnRentalDetail .panel .section-head #earnRentalDetailDeleteBtn'),
        };
      });
      H.check('rental detail back is a plain link above the card with no buttons',
        detailInfo.backTag === 'A' && detailInfo.backText === '← Back to Rentals' && detailInfo.backHref === '#earnings/rentals'
          && detailInfo.backClass === '' && detailInfo.headButtons === 0 && detailInfo.headIsToolbar,
        JSON.stringify(detailInfo));
      H.check('rental detail header shows label + type and ownership',
        detailInfo.header && detailInfo.header.includes('Detail rental') && detailInfo.header.includes('long_term')
          && detailInfo.header.includes('basic') && detailInfo.header.includes('66.67% owned'),
        JSON.stringify(detailInfo.header));
      const wantDetailCards = [
        ['Gross rents', cad(latestDetailYear.calc.grossWhole)],
        ['Deductible expenses', cad(latestDetailYear.calc.deductibleExpenses)],
        ['Net, whole property (9946)', cad(latestDetailYear.calc.netWhole9946)],
        ['Owner share', cad(latestDetailYear.calc.ownerShareNet)],
      ];
      H.check('rental detail summary strip shows the latest year calc figures',
        JSON.stringify(detailInfo.cards) === JSON.stringify(wantDetailCards),
        JSON.stringify({ got: detailInfo.cards, want: wantDetailCards }));
      H.check('rental detail chart shows annual gross vs net bars per tax year',
        detailInfo.chartLabels && detailInfo.chartLabels.join(',') === '2024,2025'
          && detailInfo.chartSets && detailInfo.chartSets.length === 2
          && detailInfo.chartSets[0].label === 'Gross rents'
          && JSON.stringify(detailInfo.chartSets[0].data) === JSON.stringify(sortedDetailYears.map((y) => y.calc.grossWhole))
          && detailInfo.chartSets[1].label === 'Net (9946)'
          && JSON.stringify(detailInfo.chartSets[1].data) === JSON.stringify(sortedDetailYears.map((y) => y.calc.netWhole9946)),
        JSON.stringify({ labels: detailInfo.chartLabels, sets: detailInfo.chartSets }));
      H.check('rental detail history shows year records and rent entries panels',
        detailInfo.hasYearPanel && detailInfo.hasEntryPanel && detailInfo.yearText && detailInfo.entryText && detailInfo.detailAddEntry,
        JSON.stringify(detailInfo));
      H.check('rental detail header has Edit + Delete by the title, no bottom row',
        detailInfo.headerEditInHead && detailInfo.headerDeleteInHead && detailInfo.noBottomRow, JSON.stringify(detailInfo));
      // Edit from the detail header opens the shared modal prefilled.
      await page.click('#earnRentalDetailEditBtn');
      await waitE(300);
      H.check('rental detail header Edit opens the prefilled rental modal',
        await page.evaluate(() => {
          const m = document.querySelector('#earnRentalModal');
          const f = document.querySelector('#earnRentalForm');
          return m && !m.classList.contains('hidden') && f && f.label.value === 'Detail rental';
        }));
      await page.click('#earnRentalCancelBtn');
      await waitE(200);
      // Back link returns to the Rentals list.
      await page.click('#earnRentalBackLink');
      try { await page.waitForFunction(() => location.hash === '#earnings/rentals', { timeout: 5000 }); } catch {}
      try { await page.waitForFunction(() => document.querySelector('#earnRentalDetail').classList.contains('hidden'), { timeout: 5000 }); } catch {}
      const rentalBackNav = await page.evaluate(() => ({
        hash: location.hash,
        detailHidden: document.querySelector('#earnRentalDetail').classList.contains('hidden'),
      }));
      H.check('clicking the rental detail back link returns to the Rentals list',
        rentalBackNav.hash === '#earnings/rentals' && rentalBackNav.detailHidden === true, JSON.stringify(rentalBackNav));
      // Delete from the detail header round-trips back to Rentals.
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Detail rental'));
        card.querySelector('h3').click();
      });
      try { await page.waitForFunction((id) => location.hash === `#earnings/rental/${id}`, { timeout: 10000 }, detailRentalId); } catch {}
      await page.waitForFunction(() => !!document.querySelector('#earnRentalDetailDeleteBtn'), { timeout: 10000 });
      await waitE(300);
      // In-page click, not page.click: the button arrives with the
      // async detail load, and page.click's scroll step can catch it
      // mid-re-render and throw "detached from document".
      await page.evaluate(() => document.querySelector('#earnRentalDetailDeleteBtn').click());
      try { await page.waitForFunction(() => location.hash === '#earnings/rentals', { timeout: 10000 }); } catch {}
      const rentalDelNav = await page.evaluate(() => ({
        hash: location.hash,
        detailHidden: document.querySelector('#earnRentalDetail').classList.contains('hidden'),
        cardGone: ![...document.querySelectorAll('#earnRentalList .earn-rental-card')].some((c) => c.textContent.includes('Detail rental')),
      }));
      H.check('rental detail header Delete removes the rental and returns to Rentals',
        rentalDelNav.hash === '#earnings/rentals' && rentalDelNav.detailHidden && rentalDelNav.cardGone,
        JSON.stringify(rentalDelNav));
      // No-year-records rental: detail renders with entry facts only,
      // no chart panel, no invented figures.
      await page.goto(`http://ff.local/#earnings/rental/${emptyRentalId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      await page.waitForFunction(() => !!document.querySelector('#earnRentalBackLink'), { timeout: 10000 });
      const emptyInfo = await page.evaluate(() => {
        const d = document.querySelector('#earnRentalDetail');
        const panel = document.querySelector('#earnRentalDetailChartPanel');
        return {
          cards: [...d.querySelectorAll('.summary-card')].map((c) => [
            c.querySelector('.k')?.textContent.trim(), c.querySelector('.v')?.textContent.trim()]),
          chartPanelHidden: !!panel && panel.classList.contains('hidden'),
          chartInstance: !!(window.__fmCharts && window.__fmCharts.earnRentalDetail),
          noYearsNote: d.textContent.includes('No year records yet.'),
        };
      });
      H.check('no-year-records rental detail shows entry facts, no chart, no invented figures',
        emptyInfo.chartPanelHidden && !emptyInfo.chartInstance && emptyInfo.noYearsNote
          && JSON.stringify(emptyInfo.cards) === JSON.stringify([['Monthly rent', '—'], ['Rent entries', '0'], ['Coverage', '—'], ['Owned', '100%']]),
        JSON.stringify(emptyInfo));
      // Total income panel is untouched by the detail-page work.
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const incomePanel = await page.evaluate(() => {
        const p = document.querySelector('#rentIncomePanel');
        return p ? { title: p.querySelector('h3')?.textContent.trim(), share: document.querySelector('#rentIncomeShareTitle')?.textContent.trim() } : null;
      });
      H.check('rentals Total income panel is untouched',
        incomePanel && incomePanel.title === 'Total income' && incomePanel.share.startsWith('Income share'),
        JSON.stringify(incomePanel));

      // Rental form: property dropdown lists app properties (never BCA
      // results); picking one disables + clears Address; Standalone
      // re-enables it; BCA suggest fills standalone text only.
      r = await H.req('POST', '/api/properties', {
        address: '999 Rental Test St, Victoria, BC',
        mortgage_balance: 100000, purchase_date: '2020-03-15',
      });
      H.check('rental form setup: property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data).slice(0, 200));
      const rentPropId = r.data.id;
      // The page is already on #earnings/rentals from the chart checks,
      // and same-hash navigation does not reload — go away and back so
      // loadEarnings refills the dropdown with the new property.
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(500);
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      await page.click('#addEarnRentalBtn');
      await waitE(300);
      const rentPropOpts = await page.evaluate(() => [...document.querySelectorAll('#earnRentalProperty option')].map((o) => [o.value, o.textContent]));
      H.check('rental form: property dropdown lists app properties with standalone first',
        rentPropOpts.length > 1 && rentPropOpts[0][1].includes('Standalone') && rentPropOpts.some(([v, t]) => v === String(rentPropId) && t.includes('999 Rental Test St')),
        JSON.stringify(rentPropOpts));
      await page.select('#earnRentalProperty', String(rentPropId));
      await waitE(200);
      const linkedState = await page.evaluate(() => {
        const a = document.querySelector('#earnRentalForm [name="address"]');
        return { disabled: a.disabled, value: a.value };
      });
      H.check('rental form: picking a property disables and clears Address',
        linkedState.disabled === true && linkedState.value === '', JSON.stringify(linkedState));
      await page.select('#earnRentalProperty', '');
      await waitE(200);
      const standaloneState = await page.evaluate(() => {
        const a = document.querySelector('#earnRentalForm [name="address"]');
        return { disabled: a.disabled };
      });
      H.check('rental form: back to Standalone re-enables Address', standaloneState.disabled === false, JSON.stringify(standaloneState));
      await page.type('#earnRentalForm [name="label"]', 'Suite standalone');
      await page.type('#earnRentalForm [name="address"]', '12 Test Lane');
      await page.click('#earnRentalForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#earnRentalList').textContent.includes('Suite standalone'), { timeout: 10000 });
      r = await H.req('GET', '/api/earnings');
      const suiteStandalone = (r.data.rentals || []).find((x) => x.label === 'Suite standalone');
      H.check('rental form: standalone save stores address, property_id null',
        suiteStandalone && suiteStandalone.property_id == null && suiteStandalone.address === '12 Test Lane',
        JSON.stringify(suiteStandalone));
      await page.click('#addEarnRentalBtn');
      await waitE(300);
      await page.type('#earnRentalForm [name="label"]', 'Suite linked');
      await page.select('#earnRentalProperty', String(rentPropId));
      await waitE(200);
      await page.click('#earnRentalForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#earnRentalList').textContent.includes('Suite linked'), { timeout: 10000 });
      r = await H.req('GET', '/api/earnings');
      const suiteLinked = (r.data.rentals || []).find((x) => x.label === 'Suite linked');
      H.check('rental form: linked save stores property_id, address null',
        suiteLinked && suiteLinked.property_id === rentPropId && suiteLinked.address == null,
        JSON.stringify(suiteLinked));
      await page.evaluate((id) => window.earnEditRental(id), suiteLinked.id);
      await waitE(300);
      const editState = await page.evaluate(() => ({
        prop: document.querySelector('#earnRentalProperty').value,
        disabled: document.querySelector('#earnRentalForm [name="address"]').disabled,
      }));
      H.check('rental form: edit echo restores linked property + disabled Address',
        editState.prop === String(rentPropId) && editState.disabled === true, JSON.stringify(editState));
      await page.click('#earnRentalCancelBtn');
      await page.click('#addEarnRentalBtn');
      await waitE(300);
      await page.type('#earnRentalForm [name="address"]', '1200 Gov');
      await page.waitForFunction(() => document.querySelectorAll('#earnRentalForm .suggest-list li').length > 0, { timeout: 10000 });
      const sugText = await page.evaluate(() => document.querySelector('#earnRentalForm .suggest-list').textContent);
      H.check('rental form: BCA suggest offers the stub suggestion',
        sugText.includes('1200 GOVERNMENT ST VICTORIA'), sugText);
      await page.click('#earnRentalForm .suggest-list li');
      await waitE(200);
      const pickedAddr = await page.evaluate(() => document.querySelector('#earnRentalForm [name="address"]').value);
      const pickedProp = await page.evaluate(() => document.querySelector('#earnRentalProperty').value);
      H.check('rental form: picking a suggestion fills standalone text only, no property link',
        pickedAddr === '1200 GOVERNMENT ST VICTORIA' && pickedProp === '', JSON.stringify({ pickedAddr, pickedProp }));
      await page.click('#earnRentalCancelBtn');
      H.flags.bcaDown = true;
      await page.click('#addEarnRentalBtn');
      await waitE(300);
      await page.type('#earnRentalForm [name="label"]', 'Suite typed');
      await page.type('#earnRentalForm [name="address"]', '34 Typed Rd');
      await page.waitForFunction(() => !document.querySelector('#earnRentalForm .suggest-note').classList.contains('hidden'), { timeout: 10000 });
      H.check('rental form: BCA down shows the suggestions-unavailable note', true, '');
      await page.click('#earnRentalForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#earnRentalList').textContent.includes('Suite typed'), { timeout: 10000 });
      r = await H.req('GET', '/api/earnings');
      const suiteTyped = (r.data.rentals || []).find((x) => x.label === 'Suite typed');
      H.check('rental form: BCA down still saves free-text standalone address',
        suiteTyped && suiteTyped.address === '34 Typed Rd', JSON.stringify(suiteTyped));
      H.flags.bcaDown = false;

      // Rentals income panel: share-left / history-right above the
      // cards, range share from entries only, per-rental eye hide.
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Chart A', rental_type: 'long_term', services_level: 'basic', ownership_pct: 100,
      });
      H.check('rental income panel setup: Chart A created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const chartAId = r.data.id;
      // A year record carrying other income (8230) first: the panel
      // must still count entries only, never this 5000.
      r = await H.req('POST', `/api/earnings/rentals/${chartAId}/years`, {
        tax_year: 2025, other_income: 5000, area_share_pct: 100,
        mortgage_interest: 0, mortgage_principal: 0, expenses: [],
      });
      H.check('rental income panel setup: Chart A year with other income', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/earnings/rentals/${chartAId}/entries`, {
        start_ym: '2025-01', end_ym: '2025-12', monthly_rent: 1000, pay_day: 1,
      });
      H.check('rental income panel setup: Chart A entry', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Chart B', rental_type: 'long_term', services_level: 'basic', ownership_pct: 100,
      });
      H.check('rental income panel setup: Chart B created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const chartBId = r.data.id;
      r = await H.req('POST', `/api/earnings/rentals/${chartBId}/entries`, {
        start_ym: '2025-01', end_ym: '2025-06', monthly_rent: 3000, pay_day: 1,
      });
      H.check('rental income panel setup: Chart B entry', r.status === 201, JSON.stringify(r.data));
      // Expected figures recomputed from the live API payload with
      // the same entry rules (month granularity, ongoing through
      // the current month) — never hand-typed totals.
      const earnAll = (await H.req('GET', '/api/earnings')).data;
      const nowD = new Date();
      const nowYm = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;
      const ymIdx = (ym) => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
      const ymFromIdx = (k) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
      const addM = (ym, n) => ymFromIdx(ymIdx(ym) + n);
      const entryMonths = (e) => {
        const end = e.end_ym || nowYm;
        if (end < e.start_ym) return [];
        const out = [];
        for (let k = ymIdx(e.start_ym); k <= ymIdx(e.end_ym || nowYm); k++) out.push(ymFromIdx(k));
        return out;
      };
      const rentalTotal = (rental, from, to) => (rental.entries || []).reduce((s, e) => {
        const n = entryMonths(e).filter((m) => (!from || m >= from) && (!to || m <= to)).length;
        return s + n * e.monthly_rent;
      }, 0);
      const allMonths = new Set();
      for (const rt of earnAll.rentals) for (const e of rt.entries || []) for (const m of entryMonths(e)) allMonths.add(m);
      const sortedMonths = [...allMonths].sort();
      const span = { start: sortedMonths[0], end: sortedMonths[sortedMonths.length - 1] };
      const expectedAll = {};
      let expectedCenter = 0;
      for (const rt of earnAll.rentals) { expectedAll[rt.label] = rentalTotal(rt); expectedCenter += expectedAll[rt.label]; }
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(500);
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      // Normalize: an earlier chart pin leaves the toggle on income;
      // this block's annual checks assume net mode.
      await page.click('#earnRentalsViewBtns [data-view="net"]');
      await waitE(500);
      const panelPlace = await page.evaluate(() => {
        const panel = document.querySelector('#rentIncomePanel');
        const list = document.querySelector('#earnRentalList');
        const chart = document.querySelector('#earnRentalsChart');
        const row = panel && panel.querySelector('.invest-charts-row');
        const shareFirst = row && (row.children[0].querySelector('#rentIncomeShareChart') ? true : false);
        const chartSecond = row && row.children.length > 1 && !!row.children[1].querySelector('#earnRentalsChart');
        const toggle = document.querySelector('#earnRentalsViewBtns');
        const shareEmpty = document.querySelector('#rentIncomeShareEmpty');
        const annualEmpty = document.querySelector('#earnRentalsEmpty');
        return {
          panel: !!panel,
          beforeList: !!(panel && list && (panel.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)),
          chartInsidePanel: !!(panel && chart && panel.contains(chart)),
          toggleInsidePanel: !!(panel && toggle && panel.contains(toggle)),
          onePresetRow: document.querySelectorAll('#invRangeBtns-rentIncome').length === 1,
          noSecondPicker: !document.querySelector('#earnRentalsRange') && !document.querySelector('[data-earn-range="rentals"]'),
          shareLeft: !!shareFirst,
          chartRight: !!chartSecond,
          rangeBtns: !!document.querySelector('#invRangeBtns-rentIncome'),
          shareEmptyText: shareEmpty ? shareEmpty.textContent : null,
          annualEmptyText: annualEmpty ? annualEmpty.textContent : null,
          annualEmptyHidden: annualEmpty ? annualEmpty.classList.contains('hidden') : null,
        };
      });
      H.check('rental income panel: ONE combined panel — share left, annual chart right, one preset row, no second picker',
        panelPlace.panel && panelPlace.beforeList && panelPlace.chartInsidePanel && panelPlace.toggleInsidePanel
          && panelPlace.onePresetRow && panelPlace.noSecondPicker && panelPlace.shareLeft && panelPlace.chartRight
          && panelPlace.rangeBtns && panelPlace.shareEmptyText === 'No rental income in this range yet.'
          && panelPlace.annualEmptyText === 'No rental year records yet.' && panelPlace.annualEmptyHidden === true,
        JSON.stringify(panelPlace));
      const chartsApi = await H.req('GET', '/api/earnings/charts');
      const apiYears = chartsApi.data.years.map(String);
      // Round 3: the rentals picker loads on the 1-year trailing
      // default now; pin the default window, then restore All for
      // the full-span share pins below.
      const rentDef = await page.evaluate(() => ({
        from: document.querySelector('#invRangeStart-rentIncome') ? document.querySelector('#invRangeStart-rentIncome').dataset.value : null,
        to: document.querySelector('#invRangeEnd-rentIncome') ? document.querySelector('#invRangeEnd-rentIncome').dataset.value : null,
      }));
      const rentDefFrom = ymIdx(span.end) - 11 >= ymIdx(span.start) ? addM(span.end, -11) : span.start;
      H.check('date range: rentals picker defaults to the past 12 months',
        rentDef.from === rentDefFrom && rentDef.to === span.end,
        JSON.stringify({ ...rentDef, wantFrom: rentDefFrom, wantTo: span.end }));
      const rentSet = await page.evaluate(() => {
        const bar = document.querySelector('#invRangeBtns-rentIncome');
        const q = (s) => !!bar.querySelector(s);
        return { three: q('button[data-months="3"]'), ytd: q('button[data-ytd]'), two: q('button[data-months="24"]'), all: q('button[data-months="0"]'), twelve: q('button[data-months="12"]'), sixty: q('button[data-months="60"]') };
      });
      H.check('date range: rentals presets are 3 months / This year / 2 years / All (no 1/5-year buttons)',
        rentSet.three && rentSet.ytd && rentSet.two && rentSet.all && !rentSet.twelve && !rentSet.sixty,
        JSON.stringify(rentSet));
      await page.click('#invRangeBtns-rentIncome button[data-months="0"]');
      await waitE(600);
      const shareAll = await page.evaluate(() => {
        const c = window.__fmCharts.rentIncomeShare;
        const a = window.__fmCharts.earnRentals;
        if (!c || !a) return null;
        const byLabel = {};
        c.data.labels.forEach((l, i) => { byLabel[l] = c.data.datasets[0].data[i]; });
        const line = a.data.datasets.find((d) => d.type === 'line');
        return {
          labels: c.data.labels, byLabel,
          center: window.__fmCharts.rentIncomeShareCenter ? window.__fmCharts.rentIncomeShareCenter.total : null,
          hoverOffset: c.data.datasets[0].hoverOffset,
          annualLabels: a.data.labels,
          annualBars: a.data.datasets.filter((d) => d.type !== 'line').map((d) => ({ key: d.key, data: d.data })),
          annualLine: line ? { label: line.label, data: line.data } : null,
        };
      });
      H.check('rental income panel: share slices are range totals from entries only (Chart A 12000, Chart B 18000)',
        shareAll && shareAll.byLabel['Chart A'] === 12000 && shareAll.byLabel['Chart B'] === 18000,
        JSON.stringify(shareAll && shareAll.byLabel));
      H.check('rental income panel: center total is entries-only (excludes the 5000 other income)',
        shareAll && shareAll.center === expectedCenter,
        JSON.stringify({ center: shareAll && shareAll.center, expected: expectedCenter }));
      H.check('rental income panel: doughnut pops on hover',
        shareAll && shareAll.hoverOffset === 10, JSON.stringify(shareAll && shareAll.hoverOffset));
      const idx2025 = shareAll ? shareAll.annualLabels.indexOf('2025') : -1;
      const annualBarsOk = shareAll && idx2025 >= 0
        && shareAll.annualBars.every((b) => b.key && b.key.startsWith('rental:'))
        && chartsApi.data.properties.every((p) => {
          const b = shareAll.annualBars.find((x) => x.key === `rental:${p.id}`);
          const rec = chartsApi.data.rentals['2025'] && chartsApi.data.rentals['2025'].properties
            ? chartsApi.data.rentals['2025'].properties[p.id] : null;
          return b && b.data[idx2025] === (rec ? rec.net : 0);
        });
      const annualLineOk = shareAll && shareAll.annualLine && shareAll.annualLine.label === 'Total net'
        && shareAll.annualLine.data.every((v, i) => Math.abs(v - shareAll.annualBars.reduce((s, b) => s + (b.data[i] || 0), 0)) < 0.011);
      H.check('rental income panel: annual chart (net mode) shows per-rental bars + Total net line matching the API',
        shareAll && JSON.stringify(shareAll.annualLabels) === JSON.stringify(apiYears) && annualBarsOk && annualLineOk,
        JSON.stringify({ labels: shareAll && shareAll.annualLabels, apiYears, bars: shareAll && shareAll.annualBars, line: shareAll && shareAll.annualLine }));
      // Range change: 1 year = last 12 months of the span. Chart A
      // and Chart B (both 2025-only) must drop out of the share.
      // The spend preset set has no 12-month button (the default
      // IS 1 year), so set the window through the month popovers.
      const winStart = ymIdx(span.end) - 11 >= ymIdx(span.start) ? addM(span.end, -11) : span.start;
      const pickRentMonth = async (fieldSel, ym) => {
        await page.click(fieldSel);
        await page.waitForFunction(() => !document.querySelector('#invMonthPop-rentIncome').classList.contains('hidden'), { timeout: 5000 });
        const targetYear = Number(ym.slice(0, 4));
        for (let i = 0; i < 40; i++) {
          const y = await page.evaluate(() => Number(document.querySelector('#invMonthPop-rentIncome .month-pop-year').textContent));
          if (y === targetYear) break;
          await page.click(`#invMonthPop-rentIncome ${y < targetYear ? '[data-pop-next]' : '[data-pop-prev]'}`);
          await waitE(120);
        }
        await page.click(`#invMonthPop-rentIncome button[data-ym="${ym}"]`);
        await waitE(300);
      };
      await pickRentMonth('#invRangeStart-rentIncome', winStart);
      await pickRentMonth('#invRangeEnd-rentIncome', span.end);
      await waitE(600);
      const expectedWin = {};
      let expectedWinCenter = 0;
      for (const rt of earnAll.rentals) { expectedWin[rt.label] = rentalTotal(rt, winStart, span.end); expectedWinCenter += expectedWin[rt.label]; }
      const shareWin = await page.evaluate(() => {
        const c = window.__fmCharts.rentIncomeShare;
        const a = window.__fmCharts.earnRentals;
        if (!c) return null;
        const byLabel = {};
        c.data.labels.forEach((l, i) => { byLabel[l] = c.data.datasets[0].data[i]; });
        return {
          labels: c.data.labels, byLabel,
          center: window.__fmCharts.rentIncomeShareCenter ? window.__fmCharts.rentIncomeShareCenter.total : null,
          fromVal: document.querySelector('#invRangeStart-rentIncome') ? document.querySelector('#invRangeStart-rentIncome').dataset.value : null,
          toVal: document.querySelector('#invRangeEnd-rentIncome') ? document.querySelector('#invRangeEnd-rentIncome').dataset.value : null,
          annualLabels: a ? a.data.labels : null,
        };
      });
      H.check('rental income panel: 1-year range drops 2025-only rentals and recomputes the center',
        shareWin && !('Chart A' in shareWin.byLabel) && !('Chart B' in shareWin.byLabel)
          && shareWin.center === expectedWinCenter,
        JSON.stringify({ labels: shareWin && shareWin.labels, center: shareWin && shareWin.center, expected: expectedWinCenter }));
      const winYears = shareWin ? chartsApi.data.years.filter((y) => y >= Number(shareWin.fromVal.slice(0, 4)) && y <= Number(shareWin.toVal.slice(0, 4))).map(String) : [];
      H.check('rental income panel: 1-year range drives the annual chart years too',
        shareWin && JSON.stringify(shareWin.annualLabels) === JSON.stringify(winYears),
        JSON.stringify({ annual: shareWin && shareWin.annualLabels, expected: winYears, from: shareWin && shareWin.fromVal, to: shareWin && shareWin.toVal }));
      await page.click('#invRangeBtns-rentIncome button[data-months="0"]');
      await waitE(600);
      const backAll = await page.evaluate(() => {
        const c = window.__fmCharts.rentIncomeShare;
        const a = window.__fmCharts.earnRentals;
        return { share: c ? c.data.labels.includes('Chart A') : false, annual: a ? a.data.labels : null };
      });
      H.check('rental income panel: All range restores the 2025 rentals + all annual years',
        backAll.share === true && JSON.stringify(backAll.annual) === JSON.stringify(apiYears), JSON.stringify(backAll));
      // Round 3: preset actions drive the rentals range and chart.
      const rentFields = () => page.evaluate(() => ({
        from: document.querySelector('#invRangeStart-rentIncome').dataset.value,
        to: document.querySelector('#invRangeEnd-rentIncome').dataset.value,
        annual: window.__fmCharts.earnRentals ? window.__fmCharts.earnRentals.data.labels : null,
      }));
      await page.click('#invRangeBtns-rentIncome button[data-ytd]');
      await waitE(600);
      const rentYtd = await rentFields();
      H.check('date range: rentals This year preset narrows to Jan-current month',
        rentYtd.from === '2026-01' && rentYtd.to === span.end && JSON.stringify(rentYtd.annual) === JSON.stringify(['2026']),
        JSON.stringify(rentYtd));
      await page.click('#invRangeBtns-rentIncome button[data-months="24"]');
      await waitE(600);
      const rent2y = await rentFields();
      const rent2yFrom = ymIdx(span.end) - 23 >= ymIdx(span.start) ? addM(span.end, -23) : span.start;
      H.check('date range: rentals 2 years preset widens to the trailing 24 months',
        rent2y.from === rent2yFrom && rent2y.to === span.end, JSON.stringify(rent2y));
      await page.click('#invRangeBtns-rentIncome button[data-months="0"]');
      await waitE(600);
      const rentAll2 = await rentFields();
      H.check('date range: rentals All preset restores the full span',
        rentAll2.from === span.start && rentAll2.to === span.end && JSON.stringify(rentAll2.annual) === JSON.stringify(apiYears),
        JSON.stringify(rentAll2));
      // Toggle: Income vs expenses swaps in gross + expenses bars
      // with a Net line (gross minus expenses) from the same range.
      await page.click('#earnRentalsViewBtns [data-view="income"]');
      await waitE(500);
      const incomeView = await page.evaluate(() => {
        const a = window.__fmCharts.earnRentals;
        if (!a) return null;
        const line = a.data.datasets.find((d) => d.type === 'line');
        return {
          labels: a.data.labels,
          bars: a.data.datasets.filter((d) => d.type !== 'line').map((d) => ({ key: d.key, data: d.data })),
          line: line ? { label: line.label, data: line.data } : null,
        };
      });
      const incomeOk = incomeView && incomeView.bars.some((b) => b.key === 'gross') && incomeView.bars.some((b) => b.key === 'expenses')
        && incomeView.line && incomeView.line.label === 'Net'
        && incomeView.labels.every((y, i) => {
          const rec = chartsApi.data.rentals[y] || {};
          const g = incomeView.bars.find((b) => b.key === 'gross').data[i] || 0;
          const e = incomeView.bars.find((b) => b.key === 'expenses').data[i] || 0;
          return g === (rec.gross || 0) && e === (rec.expenses || 0)
            && Math.abs(incomeView.line.data[i] - Math.round((g - e) * 100) / 100) < 0.011;
        });
      H.check('rental income panel: Income vs expenses shows gross + expenses bars + Net line matching the API',
        incomeOk, JSON.stringify(incomeView));
      // Back to net mode for the legend pin below.
      await page.click('#earnRentalsViewBtns [data-view="net"]');
      await waitE(500);
      // Legend click on a rental bar toggles it AND recomputes the
      // Total net line from the visible bars only.
      const beforeLegend = await page.evaluate(() => {
        const a = window.__fmCharts.earnRentals;
        const line = a.data.datasets.find((d) => d.type === 'line');
        return { labels: a.data.labels, line: line ? line.data : null };
      });
      const idxA = beforeLegend.labels.indexOf('2025');
      const chartANet2025 = (chartsApi.data.rentals['2025'] && chartsApi.data.rentals['2025'].properties
        && chartsApi.data.rentals['2025'].properties[chartAId])
        ? chartsApi.data.rentals['2025'].properties[chartAId].net : 0;
      const clickAnnualLegend = async (key) => {
        await page.evaluate((k) => {
          const a = window.__fmCharts.earnRentals;
          const i = a.data.datasets.findIndex((d) => d.key === k);
          const b = a.legend.legendHitBoxes[i];
          const r = a.canvas.getBoundingClientRect();
          a.canvas.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
            clientX: r.left + b.left + b.width / 2, clientY: r.top + b.top + b.height / 2,
          }));
        }, key);
        await waitE(500);
      };
      await clickAnnualLegend(`rental:${chartAId}`);
      const afterLegend = await page.evaluate(() => {
        const a = window.__fmCharts.earnRentals;
        const line = a.data.datasets.find((d) => d.type === 'line');
        return { line: line ? line.data : null };
      });
      H.check('rental income panel: legend toggle drops the rental from the Total net line',
        idxA >= 0 && afterLegend.line && Math.abs(afterLegend.line[idxA] - (beforeLegend.line[idxA] - chartANet2025)) < 0.011,
        JSON.stringify({ before: beforeLegend.line, after: afterLegend.line, chartANet2025 }));
      // Restore it for the eye pins below.
      await clickAnnualLegend(`rental:${chartAId}`);
      // Annual chart snapshot before hiding: eye-hide must not move it.
      const annualBeforeHide = await page.evaluate(() => {
        const a = window.__fmCharts.earnRentals;
        return a ? { labels: a.data.labels, sets: a.data.datasets.map((d) => ({ key: d.key || null, label: d.label, data: d.data })) } : null;
      });
      // Eye hide: Chart A's card greys, its slice flips off, the
      // center total drops by its income — but the annual chart
      // never moves (eye-hide affects the share only).
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .rent-card')].find((p) => p.textContent.includes('Chart A'));
        const btn = card && card.querySelector('.rent-hide-btn');
        if (btn) btn.click();
      });
      await waitE(600);
      const hiddenState = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .rent-card')].find((p) => p.textContent.includes('Chart A'));
        const btn = card && card.querySelector('.rent-hide-btn');
        const c = window.__fmCharts.rentIncomeShare;
        const a = window.__fmCharts.earnRentals;
        const idx = c ? c.data.labels.indexOf('Chart A') : -1;
        return {
          cardGrey: card ? card.classList.contains('rent-hidden-card') : false,
          eyeClosed: btn ? btn.classList.contains('invest-eye-hidden') : false,
          eyeSvg: btn ? !!btn.querySelector('svg') : false,
          eyeStroke: btn && btn.querySelector('svg') ? btn.querySelector('svg').getAttribute('stroke-width') : null,
          eyeLashes: btn ? btn.querySelectorAll('.eye-closed line').length : 0,
          eyePupilRing: btn ? (() => { const c = btn.querySelector('.eye-open circle'); return !!c && c.getAttribute('fill') === 'none'; })() : false,
          eyeOpenPath: btn ? (btn.querySelector('.eye-open path') ? btn.querySelector('.eye-open path').getAttribute('d') : null) : null,
          eyeSym: btn ? (() => {
            const p = btn.querySelector('.eye-open path');
            if (!p) return false;
            const len = p.getTotalLength();
            const a = p.getPointAtLength(len * 0.25);
            const b = p.getPointAtLength(len * 0.75);
            return Math.abs(a.x - b.x) < 1 && Math.abs(a.y + b.y - 24) < 1;
          })() : false,
          sliceVisible: idx >= 0 ? c.getDataVisibility(idx) : null,
          center: window.__fmCharts.rentIncomeShareCenter ? window.__fmCharts.rentIncomeShareCenter.total : null,
          annual: a ? { labels: a.data.labels, sets: a.data.datasets.map((d) => ({ key: d.key || null, label: d.label, data: d.data })) } : null,
        };
      });
      H.check('rental income panel: bold eye hide greys the card, closes the eye, drops slice + center, annual chart unchanged',
        hiddenState.cardGrey && hiddenState.eyeClosed && hiddenState.eyeSvg
          && hiddenState.eyeStroke === '2.6' && hiddenState.eyeLashes === 5 && hiddenState.eyePupilRing === true
          && hiddenState.eyeOpenPath === 'M2 12C6 5.5 18 5.5 22 12C18 18.5 6 18.5 2 12Z' && hiddenState.eyeSym === true
          && hiddenState.sliceVisible === false && hiddenState.center === expectedCenter - 12000
          && JSON.stringify(hiddenState.annual) === JSON.stringify(annualBeforeHide),
        JSON.stringify(hiddenState));
      // Legend click restores it (same shared hidden set, other way).
      await page.evaluate(() => {
        const c = window.__fmCharts.rentIncomeShare;
        const i = c.legend.legendItems.findIndex((it) => c.data.labels[it.index] === 'Chart A');
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        c.canvas.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true,
          clientX: r.left + b.left + b.width / 2, clientY: r.top + b.top + b.height / 2,
        }));
      });
      await waitE(600);
      const restored = await page.evaluate(() => {
        const c = window.__fmCharts.rentIncomeShare;
        const idx = c ? c.data.labels.indexOf('Chart A') : -1;
        return {
          sliceVisible: idx >= 0 ? c.getDataVisibility(idx) : null,
          center: window.__fmCharts.rentIncomeShareCenter ? window.__fmCharts.rentIncomeShareCenter.total : null,
        };
      });
      H.check('rental income panel: legend click restores the hidden rental',
        restored.sliceVisible === true && restored.center === expectedCenter, JSON.stringify(restored));
      // Per-visit: a reload restores everything.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      // The page reloads on the 1-year default now; restore All
      // for the full-span assertions below (the range is not what
      // this pin is about).
      await page.click('#invRangeBtns-rentIncome button[data-months="0"]');
      await waitE(600);
      const afterReload = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .rent-card')].find((p) => p.textContent.includes('Chart A'));
        const btn = card && card.querySelector('.rent-hide-btn');
        const c = window.__fmCharts.rentIncomeShare;
        const idx = c ? c.data.labels.indexOf('Chart A') : -1;
        return {
          cardGrey: card ? card.classList.contains('rent-hidden-card') : false,
          eyeClosed: btn ? btn.classList.contains('invest-eye-hidden') : false,
          sliceVisible: idx >= 0 ? c.getDataVisibility(idx) : null,
          center: window.__fmCharts.rentIncomeShareCenter ? window.__fmCharts.rentIncomeShareCenter.total : null,
        };
      });
      H.check('rental income panel: reload restores hidden rentals (per-visit)',
        afterReload.cardGrey === false && afterReload.eyeClosed === false
          && afterReload.sliceVisible === true && afterReload.center === expectedCenter,
        JSON.stringify(afterReload));
      // Cleanup: remove the fixture rentals so later checks see the
      // pre-existing rentals only.
      r = await H.req('DELETE', `/api/earnings/rentals/${chartAId}`);
      H.check('rental income panel cleanup: Chart A deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/rentals/${chartBId}`);
      H.check('rental income panel cleanup: Chart B deleted', r.status === 200, JSON.stringify(r.data));
    } finally {
      await browserE.close();
    }
  }
}

runModuleMain(import.meta.url, { name: 'earnings', deps, depNames: ['investments', 'csv-wizard'], run });
