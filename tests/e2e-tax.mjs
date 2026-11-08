// tax: Tax module — projects per person-year (many per
// person-year), on-demand Generate only (nothing pre-generates),
// TurboTax-style sections, RRSP benefit slider + Tax Profile +
// contributed-vs-remaining charts, export round-trip, and UI.
// Run standalone: node tests/e2e-tax.mjs
// Run via the suite runner: node tests/e2e-run.mjs --only tax
import http from 'node:http';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  const ensureAdmin = async () => {
    const l = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
    if (l.status !== 200) throw new Error('re-login failed after import wiped sessions');
  };

  // ---- years endpoint ----
  r = await H.req('GET', '/api/tax/years');
  H.check('tax: years endpoint lists the current year',
    r.status === 200 && Array.isArray(r.data.years) && r.data.years.includes(2026) && r.data.current === 2026,
    JSON.stringify(r.data));

  // ---- seed: a Shawn job (Meta-like), an ownerless job, an RRSP
  // plan for the slider start, and a TFSA buy for the charts ----
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Tax Meta', owner: 'Shawn', currency: 'CAD', province: 'BC',
    frequency: 'biweekly', gross_amount: 7334.77, gross_basis: 'period', tax_year: 2026,
  });
  H.check('tax: Shawn job created (annual gross 190,704.02)',
    r.status === 201 && r.data.calc && r.data.calc.annualGross === 190704.02,
    JSON.stringify(r.data && r.data.calc));
  const metaJobId = r.data.id;
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Tax Gig', currency: 'CAD', province: 'BC',
    frequency: 'biweekly', gross_amount: 1000, gross_basis: 'period', tax_year: 2026,
  });
  H.check('tax: ownerless job created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const gigJobId = r.data.id;

  r = await H.req('POST', '/api/investments/accounts', { name: 'Tax RRSP', type: 'RRSP', owners: ['Shawn'] });
  H.check('tax: RRSP account created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const rrspAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${rrspAcctId}/holdings`, { label: 'Tax Fund', kind: 'fund', currency: 'CAD' });
  const rrspFundId = r.data.id;
  // A manual buy first: plan generation needs a price on or
  // before each due date, and a priceless fund skips every
  // period ("no price on or before this date").
  r = await H.req('POST', `/api/investments/holdings/${rrspFundId}/events`, { date: '2025-12-31', type: 'buy', units: 100, price: 10 });
  H.check('tax: RRSP fund seeded with a price ($10)', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/accounts/${rrspAcctId}/plans`, {
    job_id: metaJobId, target_holding_id: rrspFundId, start_date: '2026-01-01', own_amount: 220.05, employer_amount: 0,
  });
  H.check('tax: RRSP contribution plan created (generated buys exist)',
    r.status === 201 && r.data.generation && Array.isArray(r.data.generation.created) && r.data.generation.created.length > 0,
    JSON.stringify(r.data && r.data.generation));

  r = await H.req('POST', '/api/investments/accounts', { name: 'Tax TFSA', type: 'TFSA', owners: ['Shawn'] });
  H.check('tax: TFSA account created', r.status === 201 && !!r.data.id, JSON.stringify(r.data));
  const tfsaAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${tfsaAcctId}/holdings`, { label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', currency: 'CAD' });
  const xqqId = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${xqqId}/events`, { date: '2026-01-05', type: 'buy', units: 10, price: 145 });
  H.check('tax: TFSA buy recorded (10 × $145 = $1,450 contributed)',
    r.status === 201 && !!r.data.id, JSON.stringify(r.data));

  // NonRegistered account: a dividend and a sell feed the
  // investment-income and capital-gain derivations on Generate.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Tax Margin', type: 'NonRegistered', owners: ['Shawn'] });
  const marginAcctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${marginAcctId}/holdings`, { label: 'SHOP', kind: 'exchange', symbol: 'SHOP.TO', currency: 'CAD' });
  const shopId = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${shopId}/events`, { date: '2026-01-06', type: 'buy', units: 10, price: 100 });
  H.check('tax: margin buy recorded', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${shopId}/events`, { date: '2026-03-10', type: 'dividend', amount: 123.45 });
  H.check('tax: dividend recorded', r.status === 201, JSON.stringify(r.data));
  r = await H.req('POST', `/api/investments/holdings/${shopId}/events`, { date: '2026-04-01', type: 'sell', units: 10, price: 150.5 });
  H.check('tax: sell recorded (10 × $150.50 = $1,505 proceeds)',
    r.status === 201 && !!r.data.id, JSON.stringify(r.data));

  // ---- filers: Shawn + Jiaying, admin excluded ----
  r = await H.req('GET', '/api/tax/filings?year=2026');
  H.check('tax: filings list has Shawn + Jiaying and no admin',
    r.status === 200 && Array.isArray(r.data.filers)
      && r.data.filers.map((f) => f.person.username).sort().join(',') === 'Jiaying,Shawn',
    JSON.stringify((r.data.filers || []).map((f) => f.person.username)));
  const shawnId = r.data.filers.find((f) => f.person.username === 'Shawn').person.id;

  // ---- two projects for the same person + year ----
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'Tax return 2026' });
  H.check('tax: project A created', r.status === 201 && !!r.data.id && r.data.name === 'Tax return 2026', JSON.stringify(r.data));
  const projA = r.data.id;
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'Rental only' });
  H.check('tax: project B created for the same person + year (distinct id)',
    r.status === 201 && !!r.data.id && r.data.id !== projA, JSON.stringify(r.data));
  const projB = r.data.id;
  r = await H.req('POST', '/api/tax/filings', { personId: 9999, year: 2026, name: 'Ghost' });
  H.check('tax: unknown person is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('POST', '/api/tax/filings', { personId: shawnId, year: 2026, name: 'US one', region: 'US' });
  H.check('tax: unknown region is a 400', r.status === 400, JSON.stringify(r.status));

  // ---- no pre-generation: both projects list 0 items ----
  r = await H.req('GET', '/api/tax/filings?year=2026');
  const shawn = r.data.filers.find((f) => f.person.username === 'Shawn');
  H.check('tax: no pre-generation — both projects list 0 items before Generate',
    shawn.projects.length === 2 && shawn.projects.every((p) => p.itemCount === 0 && !p.generated_at),
    JSON.stringify(shawn.projects.map((p) => ({ name: p.name, itemCount: p.itemCount, generated_at: p.generated_at }))));

  // ---- detail before Generate: sections exist, no items ----
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: detail renders the guided sections with no items yet',
    r.status === 200 && r.data.sections && Object.keys(r.data.sections).sort().join(',') === 'credits,deductions,income'
      && r.data.items.length === 0 && r.data.generated_at === null && r.data.rrspPlanAnnual === 5061.15,
    JSON.stringify({ sections: Object.keys(r.data.sections || {}), items: (r.data.items || []).length, rrspPlanAnnual: r.data.rrspPlanAnnual }));

  // ---- Generate on A only ----
  r = await H.req('POST', `/api/tax/filings/${projA}/generate`, {});
  H.check('tax: Generate on A adds exactly 4 items (employment, RRSP, dividend, sell)',
    r.status === 200 && r.data.counts && r.data.counts.added === 4, JSON.stringify(r.data && r.data.counts));
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  const empItem = (r.data.items || []).find((i) => i.kind === 'employment' && i.source_type === 'job');
  const rrspItem = (r.data.items || []).find((i) => i.kind === 'rrsp');
  const divItem = (r.data.items || []).find((i) => i.kind === 'investment_income');
  const sellItem = (r.data.items || []).find((i) => i.kind === 'capital_gain');
  H.check('tax: A holds employment $190,704.02, RRSP $5,061.15, dividend $123.45, sell $1,505',
    r.status === 200 && empItem && empItem.amount === 190704.02 && empItem.status === 'expected'
      && rrspItem && rrspItem.amount === 5061.15 && divItem && divItem.amount === 123.45 && sellItem && sellItem.amount === 1505,
    JSON.stringify((r.data.items || []).map((i) => ({ kind: i.kind, amount: i.amount, status: i.status }))));
  r = await H.req('GET', '/api/tax/filings?year=2026');
  const afterGen = r.data.filers.find((f) => f.person.username === 'Shawn').projects;
  H.check('tax: B still has 0 items after A was generated',
    afterGen.find((p) => p.id === projA).itemCount > 0 && afterGen.find((p) => p.id === projB).itemCount === 0,
    JSON.stringify(afterGen.map((p) => ({ id: p.id, itemCount: p.itemCount }))));
  const unlinkedGig = (r.data.unlinked || []).find((i) => i.label && i.label.includes('Tax Gig'));
  H.check('tax: the ownerless job lands in the unlinked bucket',
    !!unlinkedGig && unlinkedGig.kind === 'employment' && unlinkedGig.amount === 26000,
    JSON.stringify(r.data.unlinked));

  // ---- Re-generate adds nothing (no duplicates) ----
  const countBefore = afterGen.find((p) => p.id === projA).itemCount;
  r = await H.req('POST', `/api/tax/filings/${projA}/generate`, {});
  H.check('tax: re-generate adds 0 items',
    r.status === 200 && r.data.counts && r.data.counts.added === 0, JSON.stringify(r.data && r.data.counts));
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: item count unchanged after re-generate',
    (r.data.items || []).length === countBefore, JSON.stringify((r.data.items || []).length));

  // ---- Link the unlinked gig item into B ----
  r = await H.req('POST', `/api/tax/items/${unlinkedGig.id}/link`, { filingId: projB });
  H.check('tax: unlinked item links into B', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projB}`);
  H.check('tax: B now holds the gig item as linked',
    (r.data.items || []).some((i) => i.kind === 'employment' && i.amount === 26000 && i.status === 'linked'),
    JSON.stringify((r.data.items || []).map((i) => ({ kind: i.kind, amount: i.amount, status: i.status }))));
  r = await H.req('GET', '/api/tax/filings?year=2026');
  H.check('tax: unlinked bucket is empty after the link',
    !(r.data.unlinked || []).some((i) => i.id === unlinkedGig.id), JSON.stringify(r.data.unlinked));

  // ---- Slip on A creates a linked item ----
  r = await H.req('POST', `/api/tax/filings/${projA}/slips`, {
    kind: 'T4', tax_year: 2026, fields: { box14: 190704.02, employer_name: 'Tax Meta' }, source: 'manual',
  });
  H.check('tax: T4 slip created with its linked employment item',
    r.status === 201 && r.data.slip && r.data.slip.kind === 'T4' && r.data.item && r.data.item.amount === 190704.02 && r.data.item.status === 'linked',
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/tax/filings/${projA}/slips`, { kind: 'T9', tax_year: 2026, fields: {} });
  H.check('tax: unknown slip kind is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('POST', `/api/tax/filings/${projA}/slips`, { kind: 'T4', tax_year: 2025, fields: { box14: 1 } });
  H.check('tax: slip year must match the filing year', r.status === 400, JSON.stringify(r.status));

  // ---- Tax Profile: user-entered room, validated ----
  r = await H.req('PUT', `/api/tax/profiles/${shawnId}`, {
    rrsp_room: 20000, tfsa_room: 5000, resp_beneficiary: 'Baby', resp_subscriber: 'Shawn',
    resp_room: 45000, cesg_room: 7000, as_of_date: '2026-10-31',
  });
  H.check('tax: profile saved', r.status === 200 && r.data.profile && r.data.profile.rrsp_room === 20000, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/tax/profiles/${shawnId}`, { resp_room: 50001 });
  H.check('tax: RESP room above the $50,000 lifetime limit is a 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('GET', `/api/tax/profiles/${shawnId}`);
  H.check('tax: profile reads back with all rooms',
    r.status === 200 && r.data.profile && r.data.profile.rrsp_room === 20000 && r.data.profile.tfsa_room === 5000
      && r.data.profile.resp_room === 45000 && r.data.profile.cesg_room === 7000 && r.data.profile.resp_beneficiary === 'Baby',
    JSON.stringify(r.data.profile));

  // ---- RRSP benefit slider endpoint (reuses the Earnings engine) ----
  r = await H.req('GET', `/api/tax/filings/${projA}/rrsp-benefit?amount=11442.60`);
  H.check('tax: $11,442.60 saves $4,925.25 (his paystub figure, to the cent of the engine)',
    r.status === 200 && r.data.benefit === 4925.25 && r.data.capped === false && r.data.effectiveAmount === 11442.6,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}/rrsp-benefit?amount=25000`);
  H.check('tax: amount above the recorded room is capped at $20,000',
    r.status === 200 && r.data.capped === true && r.data.effectiveAmount === 20000 && r.data.room === 20000,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/tax/filings/${projA}/rrsp-benefit?amount=-1`);
  H.check('tax: negative amount is a 400', r.status === 400, JSON.stringify(r.status));

  // ---- Charts: contributed vs remaining, from real records ----
  r = await H.req('GET', `/api/tax/filings/${projA}/charts`);
  H.check('tax: charts split contributed vs remaining (RRSP plan buys, TFSA $1,450, RESP $5,000 of $50,000, CESG $200 of $7,200)',
    r.status === 200
      && r.data.rrsp && r.data.rrsp.contributed === 5061.15 && r.data.rrsp.room === 20000
      && r.data.tfsa && r.data.tfsa.contributed === 1450 && r.data.tfsa.room === 5000
      && r.data.resp && r.data.resp.split && r.data.resp.split.contributed === 5000 && r.data.resp.split.remaining === 45000
      && r.data.resp.cesg && r.data.resp.cesg.earned === 200 && r.data.resp.cesg.remaining === 7000,
    JSON.stringify(r.data));

  // ---- Export round-trip: tax tables travel, delete, import, back ----
  r = await H.req('GET', '/api/admin/data/export');
  const taxExport = r.data;
  H.check('tax: export carries all four Tax tables with rows',
    r.status === 200 && Array.isArray(taxExport.tables.tax_filings) && taxExport.tables.tax_filings.some((f) => f.id === projA)
      && Array.isArray(taxExport.tables.tax_profiles) && taxExport.tables.tax_profiles.some((p) => p.rrsp_room === 20000)
      && Array.isArray(taxExport.tables.tax_items) && taxExport.tables.tax_items.length === 6
      && Array.isArray(taxExport.tables.tax_slips) && taxExport.tables.tax_slips.some((s) => s.kind === 'T4'),
    JSON.stringify({ filings: (taxExport.tables.tax_filings || []).length, profiles: (taxExport.tables.tax_profiles || []).length, items: (taxExport.tables.tax_items || []).length, slips: (taxExport.tables.tax_slips || []).length }));
  r = await H.req('DELETE', `/api/tax/filings/${projA}`);
  H.check('tax: project A deleted', r.status === 200, JSON.stringify(r.status));
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: project A is gone before import', r.status === 404, JSON.stringify(r.status));
  r = await H.req('POST', '/api/admin/data/import', { data: taxExport, confirm: true });
  H.check('tax: import restores the export', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  await ensureAdmin();
  r = await H.req('GET', `/api/tax/filings/${projA}`);
  H.check('tax: project A is back after import',
    r.status === 200 && r.data.name === 'Tax return 2026' && (r.data.items || []).length === 5 && (r.data.slips || []).length === 1,
    JSON.stringify({ name: r.data && r.data.name, items: (r.data.items || []).length, slips: (r.data.slips || []).length }));

  // ---- UI: home lists the projects, detail shows sections, slider
  // and charts; the slider updates the benefit live ----
  if (!H.chromeAvailable) {
    H.check('tax UI: skipped (no Chrome)', true, 'no chrome');
    return;
  }
  const forwardH = (rq) => new Promise((resolve, reject) => {
    const rr = http.request(
      { host: '127.0.0.1', port: H.PORT, path: rq.url, method: rq.method, headers: rq.headers },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      },
    );
    rr.on('error', reject);
    if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
    rr.end();
  });
  const loginRes = await fetch(`${H.BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
  const browser = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--unsafely-treat-insecure-origin-as-secure=http://ff.local',
      ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
  });
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const page = await browser.newPage();
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
        requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders, body: resp.body.toString('base64'),
      });
    } catch {
      try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
    }
  });
  await client.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });
  const until = async (fn, tries = 48) => {
    for (let i = 0; i < tries; i++) {
      try { const v = await page.evaluate(fn); if (v) return v; } catch {}
      await wait(250);
    }
    return null;
  };
  try {
    await page.goto('http://ff.local/#tax', { waitUntil: 'networkidle0', timeout: 30000 });
    H.check('tax UI: home lists both projects for Shawn',
      await until(() => {
        const el = document.querySelector('#taxFilerCards');
        return el && el.textContent.includes('Tax return 2026') && el.textContent.includes('Rental only') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxFilerCards').textContent));
    H.check('tax UI: profile panel shows the recorded RRSP room ($20,000.00)',
      await until(() => {
        const el = document.querySelector('#taxProfileList');
        return el && el.textContent.includes('20,000.00') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxProfileList').textContent));
    await page.evaluate((id) => { location.hash = `#tax/filing/${id}`; }, projA);
    H.check('tax UI: detail title shows the project',
      await until(() => {
        const el = document.querySelector('#taxDetailTitle');
        return el && el.textContent.includes('Tax return 2026') ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxDetailTitle').textContent));
    H.check('tax UI: Income / Deductions / Credits / Review sections render',
      await until(() => {
        const el = document.querySelector('#taxSections');
        return el && ['Income', 'Deductions', 'Credits', 'Review'].every((s) => el.textContent.includes(s)) ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxSections').textContent.slice(0, 200)));
    H.check('tax UI: RRSP slider and its estimate render',
      await until(() => {
        const s = document.querySelector('#taxRrspSlider');
        const res = document.querySelector('#taxRrspResult');
        return s && res && res.textContent.includes('Tax saved') ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxRrspResult') || { textContent: 'missing' }).textContent));
    // Drag the slider to $5,000 and watch the benefit update live.
    await page.evaluate(() => {
      const s = document.querySelector('#taxRrspSlider');
      s.value = '5000';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    H.check('tax UI: moving the slider updates the benefit ($5,000 contributed)',
      await until(() => {
        const res = document.querySelector('#taxRrspResult');
        return res && res.textContent.includes('5,000.00') && res.textContent.includes('Tax saved') ? true : null;
      }),
      await page.evaluate(() => (document.querySelector('#taxRrspResult') || { textContent: 'missing' }).textContent));
    H.check('tax UI: contributed-vs-remaining charts render (RRSP / TFSA / RESP / CESG)',
      await until(() => {
        const el = document.querySelector('#taxCharts');
        return el && ['RRSP', 'TFSA', 'RESP', 'CESG grant'].every((s) => el.textContent.includes(s))
          && el.querySelectorAll('canvas').length >= 4 ? true : null;
      }),
      await page.evaluate(() => document.querySelector('#taxCharts').textContent.slice(0, 300)));
  } finally {
    await browser.close();
  }
}
runModuleMain(import.meta.url, { name: 'tax', deps, depNames: [], run });
