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
    label: 'Basement suite', rental_type: 'long_term', services_level: 'basic',
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
    && earnYear2026.calc.personalPortion9949 === 6000 && earnYear2026.calc.ownerShareNet === 11500
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
  // ---- RRSP tax benefit (job detail page) ----
  // Fixture mirrors the unit-pinned pretax case: biweekly BC job,
  // 3000/period, one fixed plan own 220.05 starting mid-year
  // (2026-07-06). The benefit is the engine's tax difference:
  // annual 1613.41, per-period 62.05. The by-year table covers
  // months elapsed only, so it is checked against the monthly
  // series (definition), never a literal — it grows with the
  // current month.
  r = await H.req('POST', '/api/earnings/jobs', { employer: 'TaxBenefit Corp', province: 'BC', frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period', tax_year: 2026, start_date: '2026-01-05', recent_pay_date: '2026-10-26', recent_pay_value: 3000 });
  H.check('tax benefit: job created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const tbJob = r.data.id;
  r = await H.req('POST', '/api/investments/accounts', { name: 'TaxBenefit RRSP', type: 'RRSP' });
  H.check('tax benefit: RRSP account created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const tbAcct = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${tbAcct}/holdings`, { label: 'TaxBenefit Fund', kind: 'fund', currency: 'CAD' });
  const tbFund = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${tbAcct}/plans`, { job_id: tbJob, target_holding_id: tbFund, start_date: '2026-07-06', own_amount: 220.05, employer_amount: 0 });
  H.check('tax benefit: fixed plan created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
  const tbPlan = r.data.id;
  r = await H.req('GET', '/api/earnings');
  const tbRead = (r.data.jobs || []).find((j) => j.id === tbJob);
  H.check('tax benefit: annual = tax(0) − tax(ded), per-period = annual / 26',
    tbRead && tbRead.taxBenefit && tbRead.taxBenefit.annual === 1613.41 && tbRead.taxBenefit.perPeriod === 62.05,
    JSON.stringify(tbRead?.taxBenefit));
  // Monthly series: no benefit before the plan starts; Jul (2
  // paydays) 124.12, Aug (3 paydays) 186.18; the by-year table is
  // exactly the series summed for the year.
  r = await H.req('GET', `/api/earnings/jobs/${tbJob}/monthly-chart`);
  const tbMonths = r.data.months || [];
  const tbBen = r.data.taxBenefit || [];
  const tbJul = tbMonths.indexOf('2026-07');
  const tbAug = tbMonths.indexOf('2026-08');
  const tbByYearOk = tbRead && tbRead.taxBenefit && Array.isArray(tbRead.taxBenefit.byYear)
    && tbRead.taxBenefit.byYear.length === 1 && tbRead.taxBenefit.byYear[0].year === 2026
    && Math.abs(tbRead.taxBenefit.byYear[0].annual - tbBen.reduce((a, b) => a + b, 0)) < 0.011;
  H.check('tax benefit: monthly benefit is 0 before the plan starts, paydays × 62.06 after; by-year table = series sum',
    tbJul >= 0 && tbAug >= 0 && tbBen.slice(0, tbJul).every((v) => v === 0)
      && tbBen[tbJul] === 124.12 && tbBen[tbAug] === 186.18 && tbByYearOk,
    JSON.stringify({ months: tbMonths, taxBenefit: tbBen, byYear: tbRead?.taxBenefit?.byYear }));
  // Per-pay table: the current tax year's paydays with a saving, from
  // the same per-payday values as the monthly series. Expected grid:
  // biweekly anchored on the recent payment (2026-10-26, the same
  // Monday grid as the start), paydays on or after the plan start
  // (2026-07-06) through the end of the current Vancouver month; each row is the per-payday saving (Jul 124.12
  // over 2 paydays = 62.06); the rows sum to the total, and the total
  // is the by-year figure for the year.
  const tbPays = tbRead.taxBenefit.pays;
  const tbToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const tbYear = Number(tbToday.slice(0, 4));
  const tbMonthEnd = new Date(Date.UTC(tbYear, Number(tbToday.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const tbExpectedDates = [];
  for (let d = new Date(Date.UTC(2026, 0, 5)); d.toISOString().slice(0, 10) <= tbMonthEnd; d = new Date(d.getTime() + 14 * 86400000)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso >= '2026-07-06') tbExpectedDates.push(iso);
  }
  const tbByYearNow = (tbRead.taxBenefit.byYear || []).find((y) => y.year === tbYear);
  const tbPaysOk = tbPays && tbPays.year === tbYear
    && JSON.stringify(tbPays.rows.map((r) => r.date)) === JSON.stringify(tbExpectedDates)
    && tbPays.rows.every((r) => r.benefit === 62.06)
    && Math.abs(tbPays.rows.reduce((a, r) => a + r.benefit, 0) - tbPays.total) < 0.001
    && tbByYearNow && tbPays.total === tbByYearNow.annual;
  H.check('tax benefit: per-pay table lists each current-year payday with its saving and sums to the by-year figure',
    tbPaysOk, JSON.stringify({ pays: tbPays, byYear: tbRead?.taxBenefit?.byYear, expectedDates: tbExpectedDates }));
  // No-plan job: no benefit at all.
  r = await H.req('POST', '/api/earnings/jobs', { employer: 'TaxBenefit Solo', province: 'BC', frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period', tax_year: 2026 });
  const tbSolo = r.data.id;
  H.check('tax benefit: no-plan job carries no benefit', r.status === 201 && r.data.taxBenefit === null, JSON.stringify(r.data.taxBenefit));
  // Take-home back-solve prices the DISPLAYED cash (cashNet minus the
  // per-period benefit): feeding a job's displayed per-period cash as
  // the take-home target must solve back to the job's own gross, and
  // the re-read displayed cash must equal the target to the cent.
  // The target is rounded to cents first — it is the displayed
  // figure, which the user reads as a 2-decimal string and re-types
  // (the raw cashNet − benefit subtraction can sit 1 ulp below the
  // cent double, which no gross could ever match).
  const rtCash = Math.round((tbRead.calc.perPeriod.cashNet - tbRead.taxBenefit.perPeriod) * 100) / 100;
  r = await H.req('PUT', `/api/earnings/jobs/${tbJob}`, { employer: 'TaxBenefit Corp', province: 'BC', frequency: 'biweekly', start_date: '2026-01-05', recent_pay_date: '2026-10-26', recent_pay_value: rtCash, pay_value_basis: 'takehome' });
  H.check('take-home solve: PUT with the displayed cash as target succeeds', r.status === 200, JSON.stringify({ status: r.status, data: r.data }));
  r = await H.req('GET', '/api/earnings');
  const rtJob = (r.data.jobs || []).find((j) => j.id === tbJob);
  H.check('take-home solve: displayed cash round-trips to the job gross with an RRSP plan',
    rtJob && rtJob.calc.perPeriod.gross === 3000
      && Math.abs((rtJob.calc.perPeriod.cashNet - rtJob.taxBenefit.perPeriod) - rtCash) < 0.001,
    JSON.stringify({ gross: rtJob?.calc?.perPeriod?.gross, cashNet: rtJob?.calc?.perPeriod?.cashNet, benefit: rtJob?.taxBenefit?.perPeriod, target: rtCash }));
  // No-plan job (benefit 0): the same round-trip through the PUT path,
  // with dates so the take-home toggle applies. The gross is asserted
  // within one cent, not exactly: the solver returns the SMALLEST
  // gross whose computed net equals the target, and the per-period net
  // is flat over a 1-cent gross step here (2477.82 at both 2999.99 and
  // 3000) — the displayed cash is what must match exactly, and it does.
  // This is the pre-existing minimal-gross contract, untouched by the
  // benefit change (no-plan netAt is byte-identical to before). The
  // comparison is in integer cents: |2999.99 − 3000| computes as
  // 0.010000000000218279 in floating point, above a 0.01 tolerance.
  r = await H.req('POST', '/api/earnings/jobs', { employer: 'TakeHome Solo', province: 'BC', frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period', tax_year: 2026, start_date: '2026-01-05', recent_pay_date: '2026-10-26', recent_pay_value: 3000 });
  const rtSolo = r.data.id;
  H.check('take-home solve: no-plan job created', r.status === 201 && rtSolo > 0, JSON.stringify(r.data));
  r = await H.req('GET', '/api/earnings');
  const rtSoloRead = (r.data.jobs || []).find((j) => j.id === rtSolo);
  const rtSoloCash = rtSoloRead ? Math.round(rtSoloRead.calc.perPeriod.cashNet * 100) / 100 : null;
  r = await H.req('PUT', `/api/earnings/jobs/${rtSolo}`, { employer: 'TakeHome Solo', province: 'BC', frequency: 'biweekly', start_date: '2026-01-05', recent_pay_date: '2026-10-26', recent_pay_value: rtSoloCash, pay_value_basis: 'takehome' });
  H.check('take-home solve: no-plan PUT with the displayed cash as target succeeds', r.status === 200, JSON.stringify({ status: r.status, data: r.data }));
  r = await H.req('GET', '/api/earnings');
  const rtSoloAfter = (r.data.jobs || []).find((j) => j.id === rtSolo);
  H.check('take-home solve: no-plan job round-trips the displayed cash to its gross',
    rtSoloAfter && Math.abs(Math.round(rtSoloAfter.calc.perPeriod.gross * 100) - 300000) <= 1 && rtSoloAfter.taxBenefit === null
      && Math.abs(rtSoloAfter.calc.perPeriod.cashNet - rtSoloCash) < 0.001,
    JSON.stringify({ gross: rtSoloAfter?.calc?.perPeriod?.gross, cashNet: rtSoloAfter?.calc?.perPeriod?.cashNet, target: rtSoloCash }));

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
      // Rentals: the list card is slim — title + a Next rent due
      // headline (the API's next payment date + gross rent); the
      // T776 year summary and the entries live on the detail page.
      const rentalUi = await page.evaluate(async () => {
        const d = await (await fetch('/api/earnings')).json();
        const r = d.rentals.find((x) => x.label === 'Basement suite');
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Basement suite'));
        const head = card ? card.querySelector('.summary-card .v')?.textContent.trim() : null;
        const sub = card ? card.querySelector('.summary-card .n')?.textContent.trim() : null;
        const text = document.querySelector('#earn-rentals').textContent;
        return {
          hasBasement: text.includes('Basement suite'),
          head, sub,
          wantDate: r && r.nextRentDues && r.nextRentDues[0] ? window.earnJobDateLabel(r.nextRentDues[0].date) : null,
          hasNeutral: text.includes('No upcoming payment'),
          hasOwnerShare: text.includes('Owner share'),
          hasDerived: text.includes('from rent entries'),
          hasTenant: text.includes('Test Tenant'),
        };
      });
      const rentalHeadOk = rentalUi.wantDate
        ? (rentalUi.head === rentalUi.wantDate && rentalUi.sub && rentalUi.sub.includes('2,000.00'))
        : rentalUi.hasNeutral;
      H.check('earnings UI: rental card shows the Next rent due headline, no T776 detail',
        rentalUi.hasBasement && rentalHeadOk
          && !rentalUi.hasOwnerShare && !rentalUi.hasDerived && !rentalUi.hasTenant,
        JSON.stringify(rentalUi));
      // Rent entries stay separate (user 2026-11-08): a rental with
      // two ongoing entries shows ONE Next rent due box per entry,
      // never a single earliest payment. Mirrors the live 2881 case
      // ($960 + $1,600, both due Dec 1, 2026).
      r = await H.req('POST', '/api/earnings/rentals', { label: 'Split suite', rental_type: 'long_term', services_level: 'basic' });
      const splitRentalId = r.data.id;
      r = await H.req('POST', `/api/earnings/rentals/${splitRentalId}/entries`, { start_ym: '2026-05', end_ym: '2027-02', monthly_rent: 960, pay_day: 1 });
      const splitEntryA = r.data.entries.find((e) => e.monthly_rent === 960).id;
      r = await H.req('POST', `/api/earnings/rentals/${splitRentalId}/entries`, { start_ym: '2026-07', end_ym: '2027-07', monthly_rent: 1600, pay_day: 1 });
      const splitEntryB = r.data.entries.find((e) => e.monthly_rent === 1600).id;
      r = await H.req('GET', '/api/earnings');
      const splitApi = r.data.rentals.find((x) => x.label === 'Split suite');
      H.check('earnings split: the API lists one next rent due per ongoing entry, sorted by date then entry start',
        splitApi && splitApi.nextRentDues && splitApi.nextRentDues.length === 2
        && splitApi.nextRentDues[0].date === '2026-12-01' && splitApi.nextRentDues[0].amount === 960 && splitApi.nextRentDues[0].entryId === splitEntryA
        && splitApi.nextRentDues[1].date === '2026-12-01' && splitApi.nextRentDues[1].amount === 1600 && splitApi.nextRentDues[1].entryId === splitEntryB
        && !('nextRentDue' in splitApi),
        JSON.stringify(splitApi && splitApi.nextRentDues));
      // UI: the list card renders two Next rent due boxes. The page
      // is already on #earnings/rentals, so a same-URL goto would be
      // a no-op — reload so the list re-fetches with the new rental.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const splitUi = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Split suite'));
        if (!card) return null;
        return [...card.querySelectorAll('.summary-card')].map((s) => ({
          head: s.querySelector('.v')?.textContent.trim(),
          sub: s.querySelector('.n')?.textContent.trim(),
        }));
      });
      H.check('earnings split UI: the list card shows two Next rent due boxes, $960 and $1,600 on Dec 1, 2026',
        splitUi && splitUi.length === 2
        && splitUi.some((s) => s.sub && s.sub.includes('960.00'))
        && splitUi.some((s) => s.sub && s.sub.includes('1,600.00'))
        && splitUi.every((s) => s.head && s.head.includes('Dec 1, 2026')),
        JSON.stringify(splitUi));
      r = await H.req('DELETE', `/api/earnings/rentals/${splitRentalId}`);
      H.check('earnings split: cleanup deletes the Split suite rental', r.status === 200, JSON.stringify(r.data));
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
      // The From button names the effective range's first month
      // (2024), so the picker opens at 2024: step to 2026 first.
      await page.click('#monthPopNext');
      await waitE(200);
      await page.click('#monthPopNext');
      await waitE(200);
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

      // Rent entries UI: the entry (tenant as a plain string) and the
      // year block's derived-days marker live on the DETAIL page now
      // (the list card is slim); the monthly-rent money input groups
      // while typing.
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const entryUi = await page.evaluate(async () => {
        const d = await (await fetch('/api/earnings')).json();
        const rental = d.rentals.find((x) => x.label === 'Basement suite');
        window.earnAddEntry(rental.id);
        const input = document.querySelector('#earnRentalEntryForm [name="monthly_rent"]');
        input.value = '1234';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const grouped = input.value;
        document.querySelector('#earnRentalEntryCancelBtn').click();
        return { rentalId: rental.id, grouped };
      });
      H.check('earnings UI: monthly-rent input groups thousands while typing',
        entryUi.grouped === '1,234', JSON.stringify(entryUi));
      await page.goto(`http://ff.local/#earnings/rental/${entryUi.rentalId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForFunction(() => !!document.querySelector('#earnRentalBackLink'), { timeout: 10000 });
      const detailEntryUi = await page.evaluate(() => {
        const text = document.querySelector('#earnRentalDetail').textContent;
        return { textHasTenant: text.includes('Test Tenant'), textHasDerived: text.includes('from rent entries') };
      });
      H.check('earnings UI: rental detail lists the rent entry and marks derived days',
        detailEntryUi.textHasTenant && detailEntryUi.textHasDerived, JSON.stringify(detailEntryUi));
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);

      // Rental modals: the rent entry modal (not an inline
      // panel); saving from the modal creates the entry with derived
      // years; + Year record is gone; year edit opens a modal too.
      // The card no longer carries + Rent entry — the detail panel
      // does — so the modal here opens through the same handler the
      // button calls, and the detail button itself is pinned in the
      // detail section below.
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Modal rental', rental_type: 'long_term', services_level: 'basic',
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
      // The list card no longer shows entries (the detail page does),
      // so the save's completion signal is the modal closing.
      await page.waitForFunction(() => document.querySelector('#earnRentalEntryModal').classList.contains('hidden'), { timeout: 10000 });
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
      // save; the entry stores a null end (its range label lives on
      // the detail page now — the list card shows the headline only).
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
      await page.waitForFunction(() => document.querySelector('#earnRentalEntryModal').classList.contains('hidden'), { timeout: 10000 });
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
        label: 'Detail rental', rental_type: 'long_term', services_level: 'basic',
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
        label: 'Empty rental', rental_type: 'long_term', services_level: 'basic',
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
          entryText: [...document.querySelectorAll('#earnRentalEntriesPanel tbody td')].some((td) => td.textContent.trim() === '$1,000.00')
            && [...document.querySelectorAll('#earnRentalEntriesPanel tbody td')].some((td) => td.textContent.trim() === '$2,000.00'),
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
      H.check('rental detail header shows label + type tags, no ownership text',
        detailInfo.header && detailInfo.header.includes('Detail rental') && detailInfo.header.includes('long_term')
          && detailInfo.header.includes('basic') && !detailInfo.header.includes('owned'),
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
        label: 'Chart A', rental_type: 'long_term', services_level: 'basic',
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
        label: 'Chart B', rental_type: 'long_term', services_level: 'basic',
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
      // Tax benefit: the fixture job's detail page shows the section
      // (per-period + annual + by-year table) and marks the take-home
      // figures; the no-plan job shows neither.
      await page.goto(`http://ff.local/#earnings/job/${tbJob}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('#earnJobTaxBenefitPanel'), { timeout: 15000 });
      await waitE(500);
      const tbView = await page.evaluate(() => {
        const panel = document.querySelector('#earnJobTaxBenefitPanel');
        const cards = [...document.querySelectorAll('#earnJobDetail .summary-card')];
        const annual = cards.find((el) => (el.querySelector('.k')?.textContent || '').includes('Annual net'));
        const next = cards.find((el) => (el.querySelector('.k')?.textContent || '').includes('Next net pay date'));
        const paysRows = [...document.querySelectorAll('#earnJobTaxBenefitPaysTable tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        return {
          panelText: panel ? panel.textContent : null,
          paysRows,
          annualMain: annual ? (annual.querySelector('.v')?.textContent || '') : null,
          annualSub: annual ? (annual.querySelector('.n')?.textContent || '') : null,
          nextSub: next ? (next.querySelector('.n')?.textContent || '') : null,
          hasInclMarker: document.querySelector('#earnJobDetail') ? document.querySelector('#earnJobDetail').textContent.includes('incl. tax benefit') : null,
        };
      });
      const tbMoney = (t) => Number(String(t || '').replace(/[^0-9.]/g, ''));
      // Cash take-home: the old combined figure minus the benefit
      // (cash + benefit = the figure the old display showed).
      const tbCashAnnual = tbRead.calc.cashNetAnnual - tbRead.taxBenefit.annual;
      const tbCashPeriod = tbRead.calc.perPeriod.cashNet - tbRead.taxBenefit.perPeriod;
      H.check('tax benefit: job detail shows the Tax benefit section with per-period + annual figures and the by-year table',
        tbView.panelText && tbView.panelText.includes('Tax benefit') && tbView.panelText.includes('62.05')
          && tbView.panelText.includes('1,613.41') && tbView.panelText.includes('2026'), JSON.stringify(tbView));
      H.check('tax benefit: take-home cards show cash with the benefit on its own sub-line, no incl-benefit marker',
        Math.abs(tbMoney(tbView.annualMain) - tbCashAnnual) < 0.01
          && tbView.annualSub && tbView.annualSub.includes('+ $1,613.41 tax benefit')
          && tbView.nextSub && Math.abs(tbMoney(tbView.nextSub.split('+')[0]) - tbCashPeriod) < 0.01
          && tbView.nextSub.includes('+ $62.05 tax benefit')
          && tbView.hasInclMarker === false, JSON.stringify({ ...tbView, tbCashAnnual, tbCashPeriod }));
      const tbMon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const tbDateLabel = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${tbMon[m - 1]} ${d}, ${y}`; };
      H.check('tax benefit: per-pay table lists the API paydays and totals to the by-year figure',
        tbView.paysRows.length === tbRead.taxBenefit.pays.rows.length + 1
          && tbView.paysRows.slice(0, -1).every((row, i) => row[0] === tbDateLabel(tbRead.taxBenefit.pays.rows[i].date)
            && Math.abs(tbMoney(row[1]) - tbRead.taxBenefit.pays.rows[i].benefit) < 0.01)
          && tbView.paysRows[tbView.paysRows.length - 1][0].includes(`Total (${tbRead.taxBenefit.pays.year})`)
          && Math.abs(tbMoney(tbView.paysRows[tbView.paysRows.length - 1][1]) - tbRead.taxBenefit.pays.total) < 0.01,
        JSON.stringify({ paysRows: tbView.paysRows, pays: tbRead.taxBenefit.pays }));
      // Layout: Pay changes + Bonuses above the Monthly pay chart,
      // Tax benefit last (main panel first).
      const tbOrder = await page.evaluate(() => [...document.querySelectorAll('#earnJobDetail > .panel')].map((p) => p.querySelector('.section-head h3')?.textContent?.trim()));
      H.check('job detail: Pay changes + Bonuses above the Monthly pay chart, Tax benefit last',
        JSON.stringify(tbOrder) === JSON.stringify(['TaxBenefit Corp', 'Pay changes', 'Bonuses', 'Monthly pay', 'Tax benefit']),
        JSON.stringify(tbOrder));
      // List card: the same cash + benefit treatment as the detail page.
      await page.goto('http://ff.local/#earnings/salary', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const tbCard = await page.evaluate((id) => {
        const card = document.querySelector(`.earn-job-card[data-job-id="${id}"]`);
        if (!card) return null;
        const cards = [...card.querySelectorAll('.summary-card')];
        const annual = cards.find((el) => (el.querySelector('.k')?.textContent || '').includes('Annual net'));
        const period = cards.find((el) => (el.querySelector('.k')?.textContent || '').includes('Net per pay period'));
        const next = card.querySelector('.earn-next-pay');
        return {
          annualMain: annual ? (annual.querySelector('.v')?.textContent || '') : null,
          annualSub: annual ? (annual.querySelector('.n')?.textContent || '') : null,
          periodMain: period ? (period.querySelector('.v')?.textContent || '') : null,
          periodSub: period ? (period.querySelector('.n')?.textContent || '') : null,
          nextLine: next ? next.textContent : null,
          text: card.textContent,
        };
      }, tbJob);
      H.check('tax benefit: job list card shows cash take-home with the benefit sub-line',
        tbCard && Math.abs(tbMoney(tbCard.annualMain) - tbCashAnnual) < 0.01
          && tbCard.annualSub && tbCard.annualSub.includes('+ $1,613.41 tax benefit')
          && Math.abs(tbMoney(tbCard.periodMain) - tbCashPeriod) < 0.01
          && tbCard.periodSub && tbCard.periodSub.includes('+ $62.05 tax benefit')
          && tbCard.nextLine && tbCard.nextLine.includes('Take-home') && Math.abs(tbMoney(tbCard.nextLine.split('Take-home')[1].split('+')[0]) - tbCashPeriod) < 0.01
          && tbCard.nextLine.includes('+ $62.05 tax benefit')
          && !tbCard.text.includes('incl. tax benefit'), JSON.stringify(tbCard));
      await page.goto(`http://ff.local/#earnings/job/${tbSolo}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const tbSoloView = await page.evaluate(() => {
        const el = document.querySelector('#earnJobDetail');
        return {
          panel: !!document.querySelector('#earnJobTaxBenefitPanel'),
          paysTable: !!document.querySelector('#earnJobTaxBenefitPaysTable'),
          anyBenefitText: el ? el.textContent.includes('tax benefit') : null,
        };
      });
      H.check('tax benefit: no-plan job shows no Tax benefit section, no per-pay table and no benefit sub-line',
        tbSoloView.panel === false && tbSoloView.paysTable === false && tbSoloView.anyBenefitText === false, JSON.stringify(tbSoloView));
      // Cleanup: remove the tax-benefit fixture (plan first — a job
      // with linked plans cannot be deleted).
      r = await H.req('DELETE', `/api/investments/plans/${tbPlan}`);
      H.check('tax benefit cleanup: plan deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/jobs/${tbJob}`);
      H.check('tax benefit cleanup: job deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/jobs/${tbSolo}`);
      H.check('tax benefit cleanup: solo job deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/jobs/${rtSolo}`);
      H.check('take-home solve cleanup: no-plan round-trip job deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/investments/accounts/${tbAcct}`);
      H.check('tax benefit cleanup: RRSP account deleted', r.status === 200, JSON.stringify(r.data));
      // ---- Payday-grid unification + per-pay year pager ----
      // Divergent-grid fixture (the user's Meta job shape): start
      // Monday 2022-06-06, recent Friday 2026-10-23, bi-weekly, plan
      // from 2026-11-06. The per-pay table must list the Friday
      // paydays Nov 6 + 20 — never the old Monday-grid Nov 16/30 —
      // and next pay must stay Nov 6.
      r = await H.req('POST', '/api/investments/accounts', { name: 'Grid Pager RRSP', type: 'RRSP' });
      H.check('payday grid: RRSP account created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const gpAcct = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${gpAcct}/holdings`, { label: 'GridPager Fund', kind: 'fund', currency: 'CAD' });
      H.check('payday grid: holding created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const gpFund = r.data.id;
      r = await H.req('POST', '/api/earnings/jobs', { employer: 'Grid Corp', province: 'BC', frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period', tax_year: 2026, start_date: '2022-06-06', recent_pay_date: '2026-10-23', recent_pay_value: 3000 });
      H.check('payday grid: divergent job created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const gridJob = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${gpAcct}/plans`, { job_id: gridJob, target_holding_id: gpFund, start_date: '2026-11-06', own_amount: 220.05, employer_amount: 0 });
      H.check('payday grid: divergent plan created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const gridPlan = r.data.id;
      // Multi-year fixture for the pager: start 2025-01-06, recent
      // 2026-10-26 (same Monday grid), plan from 2025-07-07 — the
      // per-pay table spans 2025 + 2026.
      r = await H.req('POST', '/api/earnings/jobs', { employer: 'Pager Corp', province: 'BC', frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period', tax_year: 2026, start_date: '2025-01-06', recent_pay_date: '2026-10-26', recent_pay_value: 3000 });
      H.check('tax benefit pager: multi-year job created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const pgJob = r.data.id;
      r = await H.req('POST', `/api/investments/accounts/${gpAcct}/plans`, { job_id: pgJob, target_holding_id: gpFund, start_date: '2025-07-07', own_amount: 220.05, employer_amount: 0 });
      H.check('tax benefit pager: multi-year plan created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const pgPlan = r.data.id;
      r = await H.req('GET', '/api/earnings');
      const gridRead = (r.data.jobs || []).find((j) => j.id === gridJob);
      const pgRead = (r.data.jobs || []).find((j) => j.id === pgJob);
      const gpToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const gpYear = Number(gpToday.slice(0, 4));
      const gpMonthEnd = new Date(Date.UTC(gpYear, Number(gpToday.slice(5, 7)), 0)).toISOString().slice(0, 10);
      // Expected divergent-grid paydays: step 14 days from the plan
      // start (2026-11-06, a Friday on the recent grid) through the
      // end of the current Vancouver month.
      const gridExpected = [];
      for (let d = new Date(Date.UTC(2026, 10, 6)); d.toISOString().slice(0, 10) <= gpMonthEnd; d = new Date(d.getTime() + 14 * 86400000)) gridExpected.push(d.toISOString().slice(0, 10));
      // Expected next pay: the first Friday-grid payday on or after
      // today (Nov 6 when run Nov 5–6; no holiday falls on the
      // November grid dates, so no adjustment applies here).
      let gridNext = '2026-11-06';
      while (gridNext < gpToday) gridNext = new Date(new Date(`${gridNext}T00:00:00Z`).getTime() + 14 * 86400000).toISOString().slice(0, 10);
      const gridPays = gridRead?.taxBenefit?.pays;
      H.check('payday grid: per-pay table follows the recent-date grid (Nov 6 + 20, never Nov 16/30)',
        gridRead?.next_pay_date === gridNext
          && gridPays && JSON.stringify(gridPays.rows.map((x) => x.date)) === JSON.stringify(gridExpected)
          && gridPays.rows.every((x) => x.benefit === 62.06)
          && !gridPays.rows.some((x) => x.date === '2026-11-16' || x.date === '2026-11-30')
          && Math.abs(gridPays.rows.reduce((a, x) => a + x.benefit, 0) - gridPays.total) < 0.001
          && gridPays.total === (gridRead.taxBenefit.byYear || []).find((y) => y.year === gpYear)?.annual,
        JSON.stringify({ next: gridRead?.next_pay_date, pays: gridPays, expected: gridExpected }));
      // Multi-year grouping: 2025 is a complete year (13 Monday
      // paydays from Jul 7), 2026 runs through the current month.
      const pgExpected2025 = [];
      for (let d = new Date(Date.UTC(2025, 6, 7)); d.toISOString().slice(0, 10) <= '2025-12-31'; d = new Date(d.getTime() + 14 * 86400000)) pgExpected2025.push(d.toISOString().slice(0, 10));
      const pgExpected2026 = [];
      for (let d = new Date(Date.UTC(2026, 0, 5)); d.toISOString().slice(0, 10) <= gpMonthEnd; d = new Date(d.getTime() + 14 * 86400000)) pgExpected2026.push(d.toISOString().slice(0, 10));
      const pgGroups = pgRead?.taxBenefit?.paysByYear || [];
      const pgG25 = pgGroups.find((g) => g.year === 2025);
      const pgG26 = pgGroups.find((g) => g.year === gpYear);
      const pgByYear = pgRead?.taxBenefit?.byYear || [];
      H.check('tax benefit: per-pay table groups pays by year with each year totalled',
        pgGroups.length >= 2 && pgGroups[0].year === 2025 && pgGroups[pgGroups.length - 1].year === gpYear
          && pgG25 && JSON.stringify(pgG25.rows.map((x) => x.date)) === JSON.stringify(pgExpected2025)
          && pgG25.rows.every((x) => x.benefit === 62.06) && pgG25.rows.length === 13
          && Math.abs(pgG25.total - 806.78) < 0.01 && pgG25.total === pgByYear.find((y) => y.year === 2025)?.annual
          && pgG26 && JSON.stringify(pgG26.rows.map((x) => x.date)) === JSON.stringify(pgExpected2026)
          && pgG26.rows.every((x) => x.benefit === 62.06)
          && Math.abs(pgG26.rows.reduce((a, x) => a + x.benefit, 0) - pgG26.total) < 0.001
          && pgG26.total === pgByYear.find((y) => y.year === gpYear)?.annual,
        JSON.stringify({ groups: pgGroups, byYear: pgByYear }));
      // Browser: the pager defaults to the latest year; flipping to
      // 2025 shows that year's rows + total, and the layout order
      // holds on this page too.
      await page.goto(`http://ff.local/#earnings/job/${pgJob}`, { waitUntil: 'networkidle0', timeout: 30000 });
      // Same-URL goto is a no-op: pgJob reuses the deleted tbSolo job's
      // id (SQLite reuses the freed id), so the browser may still sit on
      // that stale page — reload to force the fresh render.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('#earnJobTaxBenefitPaysTable'), { timeout: 15000 });
      await waitE(500);
      const pgView0 = await page.evaluate(() => {
        const pager = [...document.querySelectorAll('#earnJobTaxBenefitPaysPager button')].map((b) => ({ year: b.dataset.earnTbYear, active: b.classList.contains('active') }));
        const rows = [...document.querySelectorAll('#earnJobTaxBenefitPaysTable tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        const order = [...document.querySelectorAll('#earnJobDetail > .panel')].map((p) => p.querySelector('.section-head h3')?.textContent?.trim());
        return { pager, rows, order };
      });
      H.check('tax benefit: year pager defaults to the latest year with matching rows + total',
        pgView0.pager.length === 2 && pgView0.pager[0].year === '2025' && pgView0.pager[1].year === String(gpYear) && pgView0.pager[1].active === true
          && pgView0.rows.length === pgG26.rows.length + 1
          && pgView0.rows[pgView0.rows.length - 1][0].includes(`Total (${gpYear})`)
          && Math.abs(tbMoney(pgView0.rows[pgView0.rows.length - 1][1]) - pgG26.total) < 0.01
          && JSON.stringify(pgView0.order) === JSON.stringify(['Pager Corp', 'Pay changes', 'Bonuses', 'Monthly pay', 'Tax benefit']),
        JSON.stringify(pgView0));
      await page.click('[data-earn-tb-year="2025"]');
      await waitE(500);
      const pgView25 = await page.evaluate(() => {
        const pager = [...document.querySelectorAll('#earnJobTaxBenefitPaysPager button')].map((b) => ({ year: b.dataset.earnTbYear, active: b.classList.contains('active') }));
        const rows = [...document.querySelectorAll('#earnJobTaxBenefitPaysTable tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        return { pager, rows };
      });
      H.check('tax benefit: year pager flips to 2025 with that year\'s rows + total',
        pgView25.pager.find((b) => b.year === '2025')?.active === true
          && pgView25.rows.length === 14
          && pgView25.rows[0][0] === 'Jul 7, 2025' && pgView25.rows[12][0] === 'Dec 22, 2025'
          && pgView25.rows.slice(0, 13).every((row) => Math.abs(tbMoney(row[1]) - 62.06) < 0.01)
          && pgView25.rows[13][0].includes('Total (2025)') && Math.abs(tbMoney(pgView25.rows[13][1]) - 806.78) < 0.01,
        JSON.stringify(pgView25));
      // Cleanup: plans first, then jobs, then the account.
      r = await H.req('DELETE', `/api/investments/plans/${gridPlan}`);
      H.check('payday grid cleanup: divergent plan deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/investments/plans/${pgPlan}`);
      H.check('tax benefit pager cleanup: multi-year plan deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/jobs/${gridJob}`);
      H.check('payday grid cleanup: divergent job deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/jobs/${pgJob}`);
      H.check('tax benefit pager cleanup: multi-year job deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/investments/accounts/${gpAcct}`);
      H.check('tax benefit pager cleanup: RRSP account deleted', r.status === 200, JSON.stringify(r.data));
      // Cleanup: remove the fixture rentals so later checks see the
      // pre-existing rentals only.
      r = await H.req('DELETE', `/api/earnings/rentals/${chartAId}`);
      H.check('rental income panel cleanup: Chart A deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/rentals/${chartBId}`);
      H.check('rental income panel cleanup: Chart B deleted', r.status === 200, JSON.stringify(r.data));

      // ---- Earnings rental round (2026-11-05): Item A headline card,
      // Item B overview default All + From/To, Item C derived expenses.
      // Item A: a fixture rental with only ended entries shows the
      // neutral line on its card.
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Ended rental', rental_type: 'long_term', services_level: 'basic',
      });
      H.check('rental headline setup: ended rental created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const endedRentalId = r.data.id;
      r = await H.req('POST', `/api/earnings/rentals/${endedRentalId}/entries`, {
        start_ym: '2025-01', end_ym: '2025-12', monthly_rent: 1500, pay_day: 1,
      });
      H.check('rental headline setup: ended entry created', r.status === 201, JSON.stringify(r.data));
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const endedCard = await page.evaluate(() => {
        const card = [...document.querySelectorAll('#earnRentalList .earn-rental-card')]
          .find((c) => c.textContent.includes('Ended rental'));
        return card ? { hasHeadline: card.textContent.includes('Next rent due'), hasNeutral: card.textContent.includes('No upcoming payment') } : null;
      });
      H.check('rental headline: ended-only rental shows the neutral line, no headline',
        endedCard && !endedCard.hasHeadline && endedCard.hasNeutral, JSON.stringify(endedCard));

      // Item B: the overview defaults to All on load (fresh state
      // after a reload) and From/To name the data's actual years.
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      await page.goto('http://ff.local/#earnings/overview', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(800);
      const ovDefault = await page.evaluate(() => {
        const chart = window.__fmCharts.earnOverview;
        const from = document.querySelector('[data-earn-range="overview"] [data-earn-month="from"]');
        const to = document.querySelector('[data-earn-range="overview"] [data-earn-month="to"]');
        const allBtn = document.querySelector('[data-earn-range="overview"] [data-years="0"]');
        return {
          labels: chart ? chart.data.labels : null,
          fromText: from ? from.textContent.trim() : null, fromVal: from ? from.dataset.value : null,
          toText: to ? to.textContent.trim() : null, toVal: to ? to.dataset.value : null,
          allActive: allBtn ? allBtn.classList.contains('active') : null,
        };
      });
      const ovChartYears = (await H.req('GET', '/api/earnings/charts')).data.years;
      H.check('overview default: All active on load, chart shows every data year, From/To name the range',
        ovDefault.allActive === true
          && ovDefault.labels && JSON.stringify(ovDefault.labels) === JSON.stringify(ovChartYears.map(String))
          && ovDefault.fromVal === `${ovChartYears[0]}-01` && ovDefault.toVal === `${ovChartYears[ovChartYears.length - 1]}-12`
          && ovDefault.fromText !== '—' && ovDefault.toText !== '—',
        JSON.stringify({ ...ovDefault, chartYears: ovChartYears }));
      await page.click('[data-earn-range="overview"] [data-preset="ytd"]');
      await waitE(500);
      const ovYtd2 = await page.evaluate(() => {
        const chart = window.__fmCharts.earnOverview;
        const from = document.querySelector('[data-earn-range="overview"] [data-earn-month="from"]');
        const to = document.querySelector('[data-earn-range="overview"] [data-earn-month="to"]');
        return {
          labels: chart ? chart.data.labels : null,
          fromVal: from ? from.dataset.value : null, toVal: to ? to.dataset.value : null,
        };
      });
      const curYear = new Date().getFullYear();
      const curYm = `${curYear}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
      H.check('overview This year (round): From Jan, To current month, chart narrows to the year',
        ovYtd2.labels && ovYtd2.labels.join(',') === String(curYear)
          && ovYtd2.fromVal === `${curYear}-01` && ovYtd2.toVal === curYm,
        JSON.stringify(ovYtd2));
      await page.click('[data-earn-range="overview"] [data-years="0"]');
      await waitE(500);
      await page.click('[data-earn-range="overview"] [data-earn-month="from"]');
      await waitE(300);
      // The From button names the effective range's first month, so
      // the picker opens there: step to 2026 before picking June.
      await page.evaluate(() => {
        const yearEl = document.querySelector('#monthPopYear');
        let guard = 0;
        while (Number(yearEl.textContent) !== 2026 && guard++ < 120) {
          document.querySelector('#monthPopNext').click();
        }
      });
      await waitE(300);
      await page.click('#monthPop button[data-ym="2026-06"]');
      await waitE(600);
      const ovManual2 = await page.evaluate(() => {
        const chart = window.__fmCharts.earnOverview;
        const from = document.querySelector('[data-earn-range="overview"] [data-earn-month="from"]');
        const to = document.querySelector('[data-earn-range="overview"] [data-earn-month="to"]');
        return {
          labels: chart ? chart.data.labels : null,
          fromText: from ? from.textContent.trim() : null, fromVal: from ? from.dataset.value : null,
          toText: to ? to.textContent.trim() : null, toVal: to ? to.dataset.value : null,
        };
      });
      H.check('overview manual pick (round): From Jun 2026 narrows the chart to 2026+, To names the range end',
        ovManual2.labels && ovManual2.labels.join(',') === '2026'
          && ovManual2.fromVal === '2026-06' && ovManual2.fromText === 'Jun 2026'
          && ovManual2.toVal === '2026-12',
        JSON.stringify(ovManual2));

      // Item C: a property with known 2025/2026 costs + a fixed 5%
      // mortgage, a rental linked to it with portion 33% — the
      // derived 2026 deductible = 33% x (costs + interest) to the cent.
      r = await H.req('POST', '/api/properties', {
        address: '1 Derived Way, Coquitlam, BC', region: 'CA', purchase_date: '2024-12-01',
        mortgage_balance: 120000, mortgage_balance_date: '2025-01-01', amortization_years: 25,
      });
      H.check('derived setup: property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const derPropId = r.data.id;
      r = await H.req('POST', `/api/properties/${derPropId}/rates`, {
        start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5,
      });
      H.check('derived setup: fixed 5% segment created', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/properties/${derPropId}/costs`, { year: 2025, category: 'Property tax', amount: 5000 });
      H.check('derived setup: 2025 Property tax cost created', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/properties/${derPropId}/costs`, { year: 2026, category: 'Property tax', amount: 6000 });
      H.check('derived setup: 2026 Property tax cost created', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/properties/${derPropId}/costs`, { year: 2026, category: 'Gas', amount: 100, basis: 'monthly' });
      H.check('derived setup: 2026 Gas monthly cost created', r.status === 201, JSON.stringify(r.data));
      const amort = await H.req('GET', `/api/properties/${derPropId}/amortization`);
      const interestByYear = {};
      for (const row of (amort.data.series || [])) {
        const y = Number(String(row.month).slice(0, 4));
        interestByYear[y] = Math.round(((interestByYear[y] || 0) + (row.interest || 0)) * 100) / 100;
      }
      H.check('derived setup: amortization series read', amort.status === 200 && interestByYear[2025] > 0 && interestByYear[2026] > 0, JSON.stringify({ i25: interestByYear[2025], i26: interestByYear[2026] }));
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Derived rental', rental_type: 'long_term', services_level: 'basic',
        property_id: derPropId, rental_portion_pct: 33,
      });
      H.check('derived setup: linked rental created with portion 33', r.status === 201 && r.data.rental_portion_pct === 33, JSON.stringify(r.data));
      const derRentalId = r.data.id;
      r = await H.req('POST', `/api/earnings/rentals/${derRentalId}/entries`, {
        start_ym: '2025-01', end_ym: '2026-12', monthly_rent: 2000, pay_day: 15,
      });
      H.check('derived setup: entry covering 2025–2026 created', r.status === 201, JSON.stringify(r.data));
      const derEarn = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.id === derRentalId);
      const derY26 = derEarn.years.find((y) => y.tax_year === 2026);
      const derY25 = derEarn.years.find((y) => y.tax_year === 2025);
      const want26 = Math.round((0.33 * (7200 + interestByYear[2026])) * 100) / 100;
      const want25 = Math.round((0.33 * (5000 + interestByYear[2025])) * 100) / 100;
      H.check('derived expenses: 2026 deductible = 33% x (costs + interest) to the cent',
        derY26 && Math.abs(derY26.calc.deductibleExpenses - want26) < 0.01
          && Math.abs(derY26.calc.personalPortion9949 - Math.round(0.67 * (7200 + interestByYear[2026]) * 100) / 100) < 0.02,
        JSON.stringify({ got: derY26 && derY26.calc.deductibleExpenses, want: want26, personal: derY26 && derY26.calc.personalPortion9949 }));
      H.check('derived expenses: 2025 deductible = 33% x (costs + interest) to the cent',
        derY25 && Math.abs(derY25.calc.deductibleExpenses - want25) < 0.01,
        JSON.stringify({ got: derY25 && derY25.calc.deductibleExpenses, want: want25 }));
      H.check('derived expenses: expense table rows + sum match the year calc',
        derY26 && derY26.calc.expenseTable.hasDerived === true
          && Math.abs(derY26.calc.expenseTable.sum - derY26.calc.deductibleExpenses) < 0.01
          && derY26.calc.expenseTable.rows.some((row) => row.label === 'Property tax' && Math.abs(row.deductible - 1980) < 0.01)
          && derY26.calc.expenseTable.rows.some((row) => row.label === 'Gas' && Math.abs(row.deductible - 396) < 0.01)
          && derY26.calc.expenseTable.rows.some((row) => row.label === 'Mortgage interest' && Math.abs(row.deductible - Math.round(interestByYear[2026] * 0.33 * 100) / 100) < 0.01),
        JSON.stringify(derY26 && derY26.calc.expenseTable));
      H.check('derived expenses: rows carry Total + Tenant % with Deductible == Total x portion, Sum == year deductible',
        derY26 && derY26.calc.expenseTable.rows.every((row) => row.pct == null
            ? Math.abs(row.total - row.deductible) < 0.01
            : Math.abs(row.deductible - Math.round(row.total * row.pct / 100 * 100) / 100) < 0.01)
          && Math.abs(derY26.calc.expenseTable.totalSum - (7200 + interestByYear[2026])) < 0.01
          && Math.abs(derY26.calc.expenseTable.rows.reduce((s, r) => s + r.deductible, 0) - derY26.calc.deductibleExpenses) < 0.01
          && derY26.calc.expenseTable.rows.some((row) => row.label === 'Property tax' && Math.abs(row.total - 6000) < 0.01 && row.pct === 33)
          && derY26.calc.expenseTable.rows.some((row) => row.label === 'Gas' && Math.abs(row.total - 1200) < 0.01 && row.pct === 33)
          && derY26.calc.expenseTable.rows.some((row) => row.label === 'Mortgage interest' && Math.abs(row.total - interestByYear[2026]) < 0.01 && row.pct === 33),
        JSON.stringify(derY26 && derY26.calc.expenseTable));
      // A rental with no linked property shows no derived table.
      const baseEarn = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.label === 'Basement suite');
      const baseY26 = baseEarn.years.find((y) => y.tax_year === 2026);
      H.check('derived expenses: unlinked rental has no derived table, manual calc unchanged',
        baseY26 && baseY26.calc.expenseTable.hasDerived === false && baseY26.calc.deductibleExpenses === 12500,
        JSON.stringify(baseY26 && baseY26.calc));
      // Editing the portion re-derives on save (the save rule).
      r = await H.req('PUT', `/api/earnings/rentals/${derRentalId}`, {
        label: 'Derived rental', rental_type: 'long_term', services_level: 'basic',
        property_id: derPropId, rental_portion_pct: 50,
      });
      const derEarn50 = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.id === derRentalId);
      const derY26b = derEarn50.years.find((y) => y.tax_year === 2026);
      const want50 = Math.round((0.5 * (7200 + interestByYear[2026])) * 100) / 100;
      H.check('derived expenses: editing the portion to 50% re-derives the deductible',
        r.status === 200 && derY26b && Math.abs(derY26b.calc.deductibleExpenses - want50) < 0.01,
        JSON.stringify({ got: derY26b && derY26b.calc.deductibleExpenses, want: want50 }));
      // Validation: portion outside 1–100 is rejected.
      r = await H.req('PUT', `/api/earnings/rentals/${derRentalId}`, {
        label: 'Derived rental', rental_type: 'long_term', services_level: 'basic',
        property_id: derPropId, rental_portion_pct: 0,
      });
      H.check('derived expenses: portion 0 is rejected', r.status === 400, JSON.stringify(r.data));
      // Restore the portion, then check the detail page: the
      // year-paged table lists each item + the sum, the summary-strip
      // Deductible expenses card matches, and the pager flips years.
      r = await H.req('PUT', `/api/earnings/rentals/${derRentalId}`, {
        label: 'Derived rental', rental_type: 'long_term', services_level: 'basic',
        property_id: derPropId, rental_portion_pct: 33,
      });
      H.check('derived expenses: portion restored to 33', r.status === 200, JSON.stringify(r.data));
      await page.goto(`http://ff.local/#earnings/rental/${derRentalId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForFunction(() => !!document.querySelector('#earnRentalBackLink'), { timeout: 10000 });
      const derDetail = await page.evaluate(() => {
        const d = document.querySelector('#earnRentalDetail');
        const strip = [...d.querySelectorAll('.summary-card')].map((c) => [c.querySelector('.k')?.textContent.trim(), c.querySelector('.v')?.textContent.trim()]);
        const headSel = document.querySelector('#earnRentalYearSel');
        const sel = document.querySelector('#earnRentalExpenseYearSel');
        const head = document.querySelector('#earnRentalDetail .cost-year-head')?.textContent.trim() || null;
        const rows = [...document.querySelectorAll('#earnRentalExpenseTable tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        const sumRow = [...document.querySelectorAll('#earnRentalExpenseTable tfoot tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        const deductHead = document.querySelector('#earnRentalExpenseWrap .panel-head');
        const order = [...d.children].map((el) => el.id).filter((id) => id);
        const entryHead = [...document.querySelectorAll('#earnRentalEntriesPanel thead th')].map((th) => th.textContent.trim());
        const entryRows = [...document.querySelectorAll('#earnRentalEntriesPanel tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        const tags = [...document.querySelectorAll('#earnRentalDetailHeadPanel .meta-tag')].map((t) => t.textContent.trim());
        return {
          strip,
          headSelValue: headSel ? headSel.value : null,
          headSelOptions: headSel ? [...headSel.options].map((o) => o.value) : null,
          headText: document.querySelector('#earnRentalDetailHeadPanel .section-head')?.textContent || '',
          tags,
          selValue: sel ? sel.value : null, selOptions: sel ? [...sel.options].map((o) => o.value) : null,
          selWidth: sel ? sel.offsetWidth : null,
          deductTotal: deductHead?.querySelector('.note')?.textContent.trim() || null,
          deductHasCanvas: !!document.querySelector('#earnRentalExpenseWrap canvas'),
          head, rows, sumRow, hasTable: !!document.querySelector('#earnRentalExpenseTable'),
          order, entryHead, entryRows,
        };
      });
      const want26Str = want26.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const want26TotalFmt = (Math.round((7200 + interestByYear[2026]) * 100) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const int26Fmt = (Math.round(interestByYear[2026] * 100) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const int26DedFmt = (Math.round(interestByYear[2026] * 0.33 * 100) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const net26Str = (24000 - want26).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      H.check('derived expenses: detail shows the restyled table (2026 default, 4 columns) + header tags + shared year select + compact deductible select + top-right total + no charts + entries table after the header',
        derDetail.hasTable
          && derDetail.headSelValue === '2026' && JSON.stringify(derDetail.headSelOptions) === JSON.stringify(['2025', '2026'])
          && derDetail.tags.includes('long_term') && derDetail.tags.includes('basic') && !derDetail.headText.includes('owned')
          && derDetail.selValue === '2026' && JSON.stringify(derDetail.selOptions) === JSON.stringify(['2025', '2026'])
          && derDetail.selWidth != null && derDetail.selWidth < 300
          && derDetail.deductTotal === `2026 total: ${want26Str}`
          && derDetail.deductHasCanvas === false
          && derDetail.head === '2026'
          && derDetail.rows.some((row) => row[0] === 'Property tax' && row[1] === '$6,000.00' && row[2] === '33%' && row[3] === '$1,980.00')
          && derDetail.rows.some((row) => row[0] === 'Gas' && row[1] === '$1,200.00' && row[2] === '33%' && row[3] === '$396.00')
          && derDetail.rows.some((row) => row[0] === 'Mortgage interest' && row[1] === int26Fmt && row[2] === '33%' && row[3] === int26DedFmt)
          && derDetail.sumRow.length === 1 && derDetail.sumRow[0][0] === 'Sum'
          && derDetail.sumRow[0][1] === want26TotalFmt && derDetail.sumRow[0][3] === want26Str
          && derDetail.strip.find((c) => c[0] === 'Deductible expenses')?.[1] === want26Str
          && derDetail.strip.find((c) => c[0] === 'Owner share')?.[1] === net26Str
          && JSON.stringify(derDetail.order) === JSON.stringify(['earnRentalDetailMsg', 'earnRentalDetailHeadPanel', 'earnRentalEntriesPanel', 'earnRentalDetailChartPanel', 'earnRentalYearRecordsPanel', 'earnRentalExpenseWrap'])
          && JSON.stringify(derDetail.entryHead) === JSON.stringify(['Period', 'Monthly rent', 'Paid on day', 'Cash', ''])
          && derDetail.entryRows.some((row) => row[0].startsWith('Jan 2025 – Dec 2026') && row[1] === '$2,000.00' && row[2] === '15' && row[3] === '—'),
        JSON.stringify({ ...derDetail, want26Str, net26Str, want26TotalFmt, int26Fmt, int26DedFmt }));
      // The Ongoing tag sits exactly on the entry covering the
      // current month (computed in-page, so the pin holds whenever
      // the suite runs).
      const entryOngoing = await page.evaluate(() => {
        const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
        const now = new Date();
        const nowKey = now.getFullYear() * 12 + now.getMonth();
        return [...document.querySelectorAll('#earnRentalEntriesPanel tbody tr')].map((tr) => {
          const tds = [...tr.querySelectorAll('td')];
          const txt = tds[0]?.textContent.trim() || '';
          const m = txt.match(/^([A-Z][a-z]{2}) (\d{4}) – (?:([A-Z][a-z]{2}) (\d{4})|Ongoing)/);
          if (!m) return { txt, tagged: false, covers: false, skip: true };
          const startKey = Number(m[2]) * 12 + (months[m[1]] - 1);
          const endKey = m[3] ? Number(m[4]) * 12 + (months[m[3]] - 1) : Infinity;
          const tagged = tds[0]?.querySelector('.meta-tag')?.textContent.trim() === 'Ongoing';
          return { txt, tagged, covers: startKey <= nowKey && nowKey <= endKey };
        });
      });
      H.check('rent entries: the Ongoing tag sits exactly on the entry covering the current month',
        entryOngoing.length > 0 && entryOngoing.every((r) => r.skip || r.tagged === r.covers),
        JSON.stringify(entryOngoing));
      await page.select('#earnRentalYearSel', '2025');
      await waitE(500);
      const derDetail25 = await page.evaluate(() => {
        const d = document.querySelector('#earnRentalDetail');
        const strip = [...d.querySelectorAll('.summary-card')].map((c) => [c.querySelector('.k')?.textContent.trim(), c.querySelector('.v')?.textContent.trim()]);
        const headSel = document.querySelector('#earnRentalYearSel');
        const sel = document.querySelector('#earnRentalExpenseYearSel');
        const recSel = document.querySelector('#earnRentalYearRecordsSel');
        const head = document.querySelector('#earnRentalDetail .cost-year-head')?.textContent.trim() || null;
        const rows = [...document.querySelectorAll('#earnRentalExpenseTable tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        const sumRow = [...document.querySelectorAll('#earnRentalExpenseTable tfoot tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        const recHeads = [...document.querySelectorAll('#earnRentalYearRecordsPanel .panel .section-head h3')].map((h) => h.textContent.trim());
        return { strip, headSelValue: headSel ? headSel.value : null, selValue: sel ? sel.value : null, recSelValue: recSel ? recSel.value : null, head, rows, sumRow, recHeads };
      });
      const want25Str = want25.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const net25Str = (24000 - want25).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      H.check('shared year: header dropdown flips to 2025 — summary cards, deductible table and year records all follow',
        derDetail25.headSelValue === '2025' && derDetail25.selValue === '2025' && derDetail25.recSelValue === '2025'
          && derDetail25.head === '2025'
          && derDetail25.strip.find((c) => c[0] === 'Gross rents')?.[1] === '$24,000.00'
          && derDetail25.strip.find((c) => c[0] === 'Deductible expenses')?.[1] === want25Str
          && derDetail25.strip.find((c) => c[0] === 'Net, whole property (9946)')?.[1] === net25Str
          && derDetail25.strip.find((c) => c[0] === 'Owner share')?.[1] === net25Str
          && derDetail25.rows.some((row) => row[0] === 'Property tax' && row[1] === '$5,000.00' && row[2] === '33%' && row[3] === '$1,650.00')
          && derDetail25.sumRow.length === 1 && derDetail25.sumRow[0][0] === 'Sum'
          && JSON.stringify(derDetail25.recHeads) === JSON.stringify(['2025']),
        JSON.stringify({ ...derDetail25, want25Str, net25Str }));
      // Live derivation: adding a property cost updates the table on
      // the next read — no re-entry on the rental side.
      r = await H.req('POST', `/api/properties/${derPropId}/costs`, { year: 2026, category: 'Electricity', amount: 1200 });
      H.check('derived expenses: live-add setup — 2026 Electricity cost created', r.status === 201, JSON.stringify(r.data));
      const liveCostId = r.data.entries
        ? (r.data.entries.find((e) => e.category === 'Electricity' && e.year === 2026) || {}).id : null;
      const derEarnLive = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.id === derRentalId);
      const derY26Live = derEarnLive.years.find((y) => y.tax_year === 2026);
      H.check('derived expenses: a property cost added later appears in the table with Total x portion == deductible',
        liveCostId != null && derY26Live && derY26Live.calc.expenseTable.rows.some((row) => row.label === 'Electricity' && Math.abs(row.total - 1200) < 0.01 && row.pct === 33 && Math.abs(row.deductible - 396) < 0.01)
          && Math.abs(derY26Live.calc.deductibleExpenses - Math.round((want26 + 396) * 100) / 100) < 0.01,
        JSON.stringify({ liveCostId, table: derY26Live && derY26Live.calc.expenseTable }));
      r = await H.req('DELETE', `/api/properties/${derPropId}/costs/${liveCostId}`);
      H.check('derived expenses: live-add cleanup — cost deleted', r.status === 200, JSON.stringify(r.data));
      const derEarnBack = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.id === derRentalId);
      const derY26Back = derEarnBack.years.find((y) => y.tax_year === 2026);
      H.check('derived expenses: deleting the cost removes its row again',
        derY26Back && !derY26Back.calc.expenseTable.rows.some((row) => row.label === 'Electricity')
          && Math.abs(derY26Back.calc.deductibleExpenses - want26) < 0.01,
        JSON.stringify(derY26Back && derY26Back.calc.expenseTable));

      // Item 2: the owner share is always 100% — a rental linked
      // to an existing property is 100% even when jointly owned
      // (the household's share; the 50/50 co-owner split is a Tax
      // module concern), and the rental saves with no ownership
      // value at all.
      r = await H.req('POST', '/api/properties', {
        address: '2 Owners Way, Coquitlam, BC', region: 'CA', purchase_date: '2024-12-01',
        owners: ['Shawn', 'Jiaying'],
      });
      H.check('derived ownership: two-owner property created', r.status === 201 && r.data.id > 0, JSON.stringify(r.data));
      const twoPropId = r.data.id;
      r = await H.req('POST', '/api/earnings/rentals', {
        label: 'Two-owner rental', rental_type: 'long_term', services_level: 'basic',
        property_id: twoPropId,
      });
      H.check('derived ownership: rental linked to the two-owner property, saved with no ownership value',
        r.status === 201 && r.data.ownership_pct === 100, JSON.stringify(r.data));
      const twoRentalId = r.data.id;
      r = await H.req('POST', `/api/earnings/rentals/${twoRentalId}/years`, {
        tax_year: 2026, other_income: 0, area_share_pct: 100,
        mortgage_interest: 0, mortgage_principal: 0,
        expenses: [{ line: '9180', amount: 4000, direct: false }],
      });
      H.check('derived ownership: year created', r.status === 201, JSON.stringify(r.data));
      r = await H.req('POST', `/api/earnings/rentals/${twoRentalId}/entries`, {
        start_ym: '2026-01', end_ym: '2026-12', monthly_rent: 2000, pay_day: 1,
      });
      H.check('derived ownership: entry created', r.status === 201, JSON.stringify(r.data));
      const twoEarn = (await H.req('GET', '/api/earnings')).data.rentals.find((x) => x.id === twoRentalId);
      const twoY26 = twoEarn.years.find((y) => y.tax_year === 2026);
      // Gross 24,000 − deductible 4,000 = net 20,000; owner share is the full net (100%).
      H.check('derived ownership: two owners -> Owner share = full net (100%)',
        twoEarn && twoEarn.ownership_pct === 100 && twoY26 && twoY26.calc.netWhole9946 === 20000 && twoY26.calc.ownerShareNet === 20000,
        JSON.stringify({ pct: twoEarn && twoEarn.ownership_pct, calc: twoY26 && twoY26.calc }));
      await page.goto(`http://ff.local/#earnings/rental/${twoRentalId}`, { waitUntil: 'networkidle0', timeout: 30000 });
      // Same-hash detail navigation does not reload the panel: the
      // previous rental's detail stays rendered until the new load
      // finishes, so wait for this rental's heading, not just the
      // back link (which already exists from the stale render).
      await page.waitForFunction(() => document.querySelector('#earnRentalDetail .panel .section-head h3')?.textContent.includes('Two-owner rental'), { timeout: 10000 });
      const twoHeader = await page.evaluate(() => {
        const head = document.querySelector('#earnRentalDetailHeadPanel .section-head');
        const yr = document.querySelector('#earnRentalYearRecordsPanel');
        return {
          tags: [...(head?.querySelectorAll('.meta-tag') || [])].map((t) => t.textContent.trim()),
          text: head?.textContent || '',
          yearBlock: yr?.textContent || '',
        };
      });
      H.check('derived ownership: detail header shows long_term + basic tags, no % owned text; year block shows Owner share (100%)',
        twoHeader.tags.includes('long_term') && twoHeader.tags.includes('basic')
          && !twoHeader.text.includes('% owned') && !twoHeader.text.includes('owned')
          && twoHeader.yearBlock.includes('Owner share (100%)') && twoHeader.yearBlock.includes('$20,000.00'),
        JSON.stringify(twoHeader));
      // The rental form carries no ownership % field — the only
      // percentage on the form is the Rental portion.
      await page.goto('http://ff.local/#earnings/rentals', { waitUntil: 'networkidle0', timeout: 30000 });
      await waitE(500);
      await page.evaluate(() => document.querySelector('#addEarnRentalBtn').click());
      await waitE(300);
      const formFields = await page.evaluate(() => ({
        hasOwnership: !!document.querySelector('#earnRentalForm [name="ownership_pct"]'),
        hasPortion: !!document.querySelector('#earnRentalForm [name="rental_portion_pct"]'),
      }));
      H.check('derived ownership: the rental form has no ownership % field, only Rental portion',
        formFields.hasOwnership === false && formFields.hasPortion === true, JSON.stringify(formFields));
      await page.click('#earnRentalCancelBtn');
      await waitE(200);
      r = await H.req('DELETE', `/api/earnings/rentals/${twoRentalId}`);
      H.check('derived ownership cleanup: rental deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/properties/${twoPropId}`);
      H.check('derived ownership cleanup: property deleted', r.status === 200, JSON.stringify(r.data));
      // Cleanup: the derived rental + its property, and the ended rental.
      r = await H.req('DELETE', `/api/earnings/rentals/${derRentalId}`);
      H.check('derived cleanup: rental deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/properties/${derPropId}`);
      H.check('derived cleanup: property deleted', r.status === 200, JSON.stringify(r.data));
      r = await H.req('DELETE', `/api/earnings/rentals/${endedRentalId}`);
      H.check('rental headline cleanup: ended rental deleted', r.status === 200, JSON.stringify(r.data));
    } finally {
      await browserE.close();
    }
  }
}

runModuleMain(import.meta.url, { name: 'earnings', deps, depNames: ['investments', 'csv-wizard'], run });
