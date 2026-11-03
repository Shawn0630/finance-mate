// core: Auth, properties, owners, jobs, portfolio, prime, terms, equity (API) — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-core.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only core]
import path from 'node:path';
import Database from 'better-sqlite3';
import { simulate as engineSimulate, derivePayment as engineDerive, monthlyRate as engineMonthlyRate, buildSchedule as engineSchedule } from '../src/engine.js';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  // Wait for the server to come up.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(H.BASE + '/api/summary'); up = r.status === 401; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  H.check('server starts, unauthenticated /api/summary is 401', up);

  let r = await H.req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government'));
  H.check('unauthenticated /api/address/suggest is 401', r.status === 401);

  r = await H.req('POST', '/api/login', { username: 'admin', password: 'wrong' });
  H.check('wrong password rejected', r.status === 401);
  r = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
  H.check('admin/admin login succeeds', r.status === 200 && r.data.ok === true);

  // Seeded household users (idempotent seeds in db.js). /api/users
  // lists the owner candidates with their avatars: every user EXCEPT
  // admin.
  r = await H.req('GET', '/api/users');
  const candidateNames = (r.data || []).map((u) => u.username);
  H.check('owner candidates are Shawn + Jiaying (admin not offered)',
    candidateNames.includes('Shawn') && candidateNames.includes('Jiaying') && !candidateNames.includes('admin'),
    JSON.stringify(r.data));

  // Legacy-owner migration (the pre-seeded DB above): a single stored
  // owner became a one-element set; the literal 'Joint' became an empty
  // set; NULL stayed empty.
  r = await H.req('GET', '/api/properties');
  const legacyProps = Object.fromEntries((r.data || []).map((p) => [p.address, p.owners]));
  H.check('legacy single owner migrated to a one-element set',
    JSON.stringify(legacyProps['1 Legacy Lane']) === '["Shawn"]', JSON.stringify(legacyProps));
  H.check('legacy Joint owner migrated to an empty set',
    JSON.stringify(legacyProps['2 Legacy Lane']) === '[]');
  H.check('legacy NULL owner migrated to an empty set',
    JSON.stringify(legacyProps['3 Legacy Lane']) === '[]');
  r = await H.req('GET', '/api/assets');
  const legacyAsset = (r.data || []).find((a) => a.name === 'Legacy thing');
  H.check('legacy asset owner migrated to a one-element set',
    !!legacyAsset && JSON.stringify(legacyAsset.owners) === '["Jiaying"]');
  r = await H.req('POST', '/api/login', { username: 'Shawn', password: 'wrong' });
  H.check('Shawn wrong password rejected', r.status === 401);
  r = await H.req('POST', '/api/login', { username: 'Shawn', password: 'Shawn' });
  H.check('Shawn/Shawn login succeeds', r.status === 200 && r.data.username === 'Shawn');
  r = await H.req('POST', '/api/login', { username: 'Jiaying', password: 'Jiaying' });
  H.check('Jiaying/Jiaying login succeeds', r.status === 200 && r.data.username === 'Jiaying');

  // Address suggestions come from the (stubbed) BC Assessment search:
  // the junk "No results" entry must be filtered out.
  r = await H.req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government Street, Victoria, BC'));
  const sug = r.data.suggestions || [];
  H.check('suggest returns one real suggestion', r.status === 200 && sug.length === 1, JSON.stringify(sug));
  H.check('suggest maps id + label', sug.length === 1 && sug[0].id === 'QkxPQy0xMjAw' && sug[0].label === '1200 GOVERNMENT ST VICTORIA');
  const searchBeforeShort = H.stubHits.search;
  r = await H.req('GET', '/api/address/suggest?q=ab');
  H.check('short query returns no suggestions', Array.isArray(r.data.suggestions) && r.data.suggestions.length === 0);
  H.check('short query does not hit BC Assessment', H.stubHits.search === searchBeforeShort);

  // Outage shape (the live Oct 2026 failure): BC Assessment's search
  // backend 500s. The endpoint must surface sourceError with a readable
  // note — never a raw JSON parse error — and the app must ask the way
  // the site's own JS does (X-Requested-With), which the stub records.
  H.flags.bcaDown = true;
  r = await H.req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government'));
  H.check('suggest outage -> sourceError flagged', r.status === 200 && r.data.sourceError === true, JSON.stringify(r.data).slice(0, 200));
  H.check('suggest outage -> empty suggestions', Array.isArray(r.data.suggestions) && r.data.suggestions.length === 0);
  H.check('suggest outage -> clean note, no parse noise',
    typeof r.data.note === 'string' && /HTTP 500/.test(r.data.note) && !/Unexpected token|not valid JSON/.test(r.data.note),
    String(r.data.note));
  H.check('app asks like the site own JS (X-Requested-With)', H.stubHits.xhr === true);
  H.flags.bcaDown = false;
  r = await H.req('GET', '/api/address/suggest?q=' + encodeURIComponent('1200 Government'));
  H.check('suggest recovers when BC Assessment is back', (r.data.suggestions || []).length === 1 && !r.data.sourceError);

  // The outage note element exists in BOTH address forms and the
  // frontend shows it when the endpoint reports sourceError.
  const pageRes = await fetch(H.BASE + '/', { headers: { Cookie: H.getCookie() } });
  S.pageHtml = await pageRes.text();
  H.check('both address forms carry the suggest-unavailable note', (S.pageHtml.match(/suggest-note/g) || []).length >= 2);
  const jsRes = await fetch(H.BASE + '/app.js', { headers: { Cookie: H.getCookie() } });
  S.jsText = await jsRes.text();
  H.check('address suggest UI reacts to sourceError', S.jsText.includes('sourceError') && S.jsText.includes('suggest-note'));

  // Property CRUD (fictional address and numbers only).
  r = await H.req('POST', '/api/properties', {
    address: '1234 Example Street, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-03-15',
  });
  H.check('create property', r.status === 201 && r.data.id > 0);
  const pid = r.data.id;

  r = await H.req('POST', `/api/properties/${pid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('add rate segment', r.status === 201);
  const segId = r.data.id;
  r = await H.req('PUT', `/api/properties/${pid}/rates/${segId}`, { annual_rate: 5.0 });
  H.check('edit rate segment', r.status === 200 && r.data.annual_rate === 5);

  // Amortization must match the engine / hand calculation: the
  // payment is the calculated one — derivePayment($100,000, 5%,
  // 25y) = $581.60 — so month 1 interest is $412.39 and the
  // balance $99,830.79 (see tests/engine.test.mjs).
  r = await H.req('GET', `/api/properties/${pid}/amortization`);
  const s0 = r.data.series && r.data.series[0];
  H.check('amortization ok', r.data.ok === true && !!s0);
  H.check('month 1 interest = 412.39', s0 && Math.abs(s0.interest - 412.39) <= 0.02, s0 && String(s0.interest));
  H.check('month 1 balance = 99830.79', s0 && Math.abs(s0.balance - 99830.79) <= 0.02, s0 && String(s0.balance));
  H.check('the payment is calculated (581.60) and carries no source field',
    r.data.paymentUsed === 581.60 && !('paymentSource' in r.data),
    JSON.stringify({ used: r.data.paymentUsed, src: r.data.paymentSource }));

  // Manual assessed value, then the summary arithmetic.
  r = await H.req('PUT', `/api/properties/${pid}`, { assessed_value: 800000 });
  H.check('set manual assessed value', r.status === 200 && r.data.assessed_source === 'manual');
  r = await H.req('POST', '/api/assets', { category: 'stocks', name: 'Test ETF', value: 5000, currency: 'CAD' });
  H.check('add other asset', r.status === 201);
  const aid = r.data.id;
  r = await H.req('GET', `/api/assets/${aid}`);
  H.check('get single asset (detail view source)', r.status === 200 && r.data.name === 'Test ETF' && r.data.category === 'stocks');
  r = await H.req('GET', '/api/assets/999999');
  H.check('get missing asset is 404', r.status === 404);
  // The summary mortgage figure is the REMAINING balance at the
  // current month (time-aware), not the recorded anchor: with a
  // 2026-10-01 balance date it reads 100000 in October and one
  // payment less from November on. The amortization endpoint's
  // remainingBalance is the independent expectation, so this pin
  // stays green across month boundaries.
  const amortSummary = (await H.req('GET', `/api/properties/${pid}/amortization`)).data;
  r = await H.req('GET', '/api/summary');
  H.check('summary property value = 800000', r.data.propertyValue === 800000, JSON.stringify(r.data));
  H.check('summary mortgage = remaining balance at current month', Math.abs(r.data.mortgageBalance - amortSummary.remainingBalance) <= 0.02, String(r.data.mortgageBalance));
  H.check('summary other assets = 5000', r.data.otherAssets === 5000);
  H.check('summary net worth = assessed - remaining + other', Math.abs(r.data.netWorth - (800000 - amortSummary.remainingBalance + 5000)) <= 0.02, String(r.data.netWorth));
  r = await H.req('DELETE', `/api/assets/${aid}`);
  H.check('delete other asset', r.status === 200);
  r = await H.req('GET', '/api/summary');
  H.check('summary other assets back to 0', r.data.otherAssets === 0);

  // Equity endpoint: no history points on pid, so the stored manual
  // assessed value is the latest value: 800000 minus the remaining
  // balance at the current month (100000 in October, one payment
  // less from November on).
  r = await H.req('GET', `/api/properties/${pid}/equity`);
  H.check('equity uses stored assessed value when no history',
    r.data.assessedValue === 800000 && Math.abs(r.data.balance - amortSummary.remainingBalance) <= 0.02 && Math.abs(r.data.equity - (800000 - amortSummary.remainingBalance)) <= 0.02,
    JSON.stringify(r.data));

  // A property created from a picked suggestion stores the BC Assessment
  // property id; fetching its value then goes straight to the property
  // page (no new address search) and returns the stubbed GIS values.
  r = await H.req('POST', '/api/properties', { address: '1200 Government St, Victoria', bca_id: 'QkxPQy0xMjAw', mortgage_balance: 500000, purchase_date: '2018-07-01' });
  H.check('create property with picked bca_id', r.status === 201 && r.data.bca_id === 'QkxPQy0xMjAw');
  const pid2 = r.data.id;
  const searchBeforeFetch = H.stubHits.search;
  r = await H.req('POST', `/api/properties/${pid2}/fetch-bca`);
  H.check('fetch-bca via picked id succeeds', r.data.ok === true && r.data.result && r.data.result.assessedValue === 6532000, JSON.stringify(r.data).slice(0, 200));
  H.check('fetch-bca via picked id skipped the address search', H.stubHits.search === searchBeforeFetch);
  H.check('fetch-bca via picked id opened the picked property page', H.stubHits.info.includes('/Property/Info/QkxPQy0xMjAw'));
  // Editing the address back to free text clears the stored id.
  r = await H.req('PUT', `/api/properties/${pid2}`, { address: '999 Somewhere Else', bca_id: null });
  H.check('editing address to free text clears bca_id', r.status === 200 && r.data.bca_id === null);

  // The fuzzy assessment fetch shares the address search: with BC
  // Assessment's backend down it must fail at the "address search"
  // stage with the same readable error, not a JSON parse error, and
  // leave the stored values untouched.
  H.flags.bcaDown = true;
  r = await H.req('POST', `/api/properties/${pid2}/fetch-bca`);
  H.check('fetch-bca outage -> ok:false at address search stage',
    r.data.ok === false && r.data.stage === 'address search', JSON.stringify(r.data).slice(0, 200));
  H.check('fetch-bca outage -> clean error, no parse noise',
    typeof r.data.error === 'string' && /HTTP 500/.test(r.data.error) && !/Unexpected token|not valid JSON/.test(r.data.error),
    String(r.data.error));
  H.flags.bcaDown = false;

  // Owners are a SET of people: joint ownership is picking several
  // names. admin is never a candidate; unknown names and the literal
  // 'Joint' are rejected; an empty selection is allowed.
  r = await H.req('POST', '/api/properties', { address: '1 Owner Way', owners: ['Shawn', 'Jiaying'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  H.check('property can have two owners (co-ownership)', r.status === 201 && JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]', JSON.stringify(r.data.owners));
  const pidOwn = r.data.id;
  r = await H.req('GET', `/api/properties/${pidOwn}`);
  H.check('two owners persisted', JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]');
  r = await H.req('PUT', `/api/properties/${pidOwn}`, { owners: ['Jiaying'] });
  H.check('property owners can be reduced to one', r.status === 200 && JSON.stringify(r.data.owners) === '["Jiaying"]');
  r = await H.req('PUT', `/api/properties/${pidOwn}`, { owners: [] });
  H.check('property owners can be cleared', r.status === 200 && JSON.stringify(r.data.owners) === '[]');
  r = await H.req('POST', '/api/properties', { address: '2 Owner Way', owners: ['Nobody'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  H.check('property with unknown owner rejected', r.status === 400);
  r = await H.req('POST', '/api/properties', { address: '2 Owner Way', owners: ['Shawn', 'Nobody'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  H.check('one bad name poisons the whole owners list', r.status === 400);
  r = await H.req('POST', '/api/properties', { address: '2 Owner Way', owners: ['admin'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  H.check('admin as property owner rejected', r.status === 400 && String(r.data.error || '').includes('admin'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', { address: '2 Owner Way', owners: ['Joint'], mortgage_balance: 100000, purchase_date: '2022-01-20' });
  H.check('literal Joint as property owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/assets', { category: 'other', name: 'Co-owned thing', owners: ['Shawn', 'Jiaying'] });
  H.check('other asset can have two owners', r.status === 201 && JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]', JSON.stringify(r.data.owners));
  const aidOwn = r.data.id;
  r = await H.req('POST', '/api/assets', { category: 'other', name: 'Joint test', owners: ['Joint'] });
  H.check('other asset with Joint owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/assets', { category: 'other', name: 'Admin test', owners: ['admin'] });
  H.check('other asset with admin owner rejected', r.status === 400);
  r = await H.req('PUT', `/api/assets/${aidOwn}`, { owners: ['Shawn'] });
  H.check('asset owners updated via PUT', r.status === 200 && JSON.stringify(r.data.owners) === '["Shawn"]');
  r = await H.req('DELETE', `/api/properties/${pidOwn}`);
  r = await H.req('DELETE', `/api/assets/${aidOwn}`);
  H.check('owner fixtures cleaned up', r.status === 200);

  // Investment accounts carry the same owners set as properties.
  r = await H.req('POST', '/api/investments/accounts', { name: 'Owner TFSA', type: 'TFSA', owners: ['Shawn', 'Jiaying'] });
  H.check('investment account can have two owners', r.status === 201 && JSON.stringify(r.data.owners) === '["Shawn","Jiaying"]', JSON.stringify(r.data));
  const invAccOwn = r.data.id;
  r = await H.req('GET', `/api/investments/accounts/${invAccOwn}`);
  H.check('account owners persisted', JSON.stringify(r.data.account.owners) === '["Shawn","Jiaying"]', JSON.stringify(r.data.account));
  r = await H.req('PUT', `/api/investments/accounts/${invAccOwn}`, { owners: ['Jiaying'] });
  H.check('account owners can be reduced to one', r.status === 200 && JSON.stringify(r.data.owners) === '["Jiaying"]', JSON.stringify(r.data));
  r = await H.req('PUT', `/api/investments/accounts/${invAccOwn}`, { owners: [] });
  H.check('account owners can be cleared', r.status === 200 && JSON.stringify(r.data.owners) === '[]');
  r = await H.req('PUT', `/api/investments/accounts/${invAccOwn}`, { name: 'Owner TFSA renamed' });
  H.check('account owners unchanged when omitted from PUT', r.status === 200 && JSON.stringify(r.data.owners) === '[]');
  r = await H.req('POST', '/api/investments/accounts', { name: 'Bad Joint', type: 'TFSA', owners: ['Joint'] });
  H.check('account with Joint owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/accounts', { name: 'Bad admin', type: 'TFSA', owners: ['admin'] });
  H.check('account with admin owner rejected', r.status === 400 && String(r.data.error || '').includes('admin'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/investments/accounts', { name: 'Bad nobody', type: 'TFSA', owners: ['Nobody'] });
  H.check('account with unknown owner rejected', r.status === 400);
  r = await H.req('POST', '/api/investments/accounts', { name: 'No owner account', type: 'TFSA' });
  H.check('account without owners is legal and reads as []', r.status === 201 && JSON.stringify(r.data.owners) === '[]', JSON.stringify(r.data));
  const invAccNoOwn = r.data.id;
  r = await H.req('DELETE', `/api/investments/accounts/${invAccOwn}`);
  H.check('owner account fixture cleaned up', r.status === 200);
  r = await H.req('DELETE', `/api/investments/accounts/${invAccNoOwn}`);
  H.check('no-owner account fixture cleaned up', r.status === 200);

  // A job's owner is ONE earner (T1 is per-person), same candidates.
  const jobBody = { employer: 'Owner Corp', province: 'BC', frequency: 'annual', gross_amount: 60000, gross_basis: 'annual', tax_year: 2026 };
  r = await H.req('POST', '/api/earnings/jobs', { ...jobBody, owner: 'Shawn' });
  H.check('job can carry one owner', r.status === 201 && r.data.owner === 'Shawn', JSON.stringify(r.data));
  const jobOwn = r.data.id;
  r = await H.req('PUT', `/api/earnings/jobs/${jobOwn}`, { ...jobBody, owner: 'Jiaying' });
  H.check('job owner can change', r.status === 200 && r.data.owner === 'Jiaying', JSON.stringify(r.data));
  r = await H.req('PUT', `/api/earnings/jobs/${jobOwn}`, { ...jobBody });
  H.check('job owner unchanged when omitted from PUT', r.status === 200 && r.data.owner === 'Jiaying', JSON.stringify(r.data));
  r = await H.req('PUT', `/api/earnings/jobs/${jobOwn}`, { ...jobBody, owner: '' });
  H.check('job owner clears on explicit empty value', r.status === 200 && r.data.owner === null, JSON.stringify(r.data));
  r = await H.req('POST', '/api/earnings/jobs', { ...jobBody, owner: 'Joint' });
  H.check('job with Joint owner rejected', r.status === 400 && String(r.data.error || '').includes('Joint'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/earnings/jobs', { ...jobBody, owner: 'admin' });
  H.check('job with admin owner rejected', r.status === 400 && String(r.data.error || '').includes('admin'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/earnings/jobs', { ...jobBody, owner: 'Nobody' });
  H.check('job with unknown owner rejected', r.status === 400);
  r = await H.req('POST', '/api/earnings/jobs', { ...jobBody });
  H.check('job without owner is legal and reads as null', r.status === 201 && r.data.owner === null, JSON.stringify(r.data));
  const jobNoOwn = r.data.id;
  r = await H.req('DELETE', `/api/earnings/jobs/${jobOwn}`);
  H.check('owner job fixture cleaned up', r.status === 200);
  r = await H.req('DELETE', `/api/earnings/jobs/${jobNoOwn}`);
  H.check('no-owner job fixture cleaned up', r.status === 200);

  // Simplified job form: key facts in, everything else derived.
  const derivedBody = {
    employer: 'Derived Corp', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
  };
  r = await H.req('POST', '/api/earnings/jobs', derivedBody);
  H.check('simplified job creates: period basis, tax year from recent date, annual 78,000',
    r.status === 201 && r.data.gross_amount === 3000 && r.data.gross_basis === 'period'
    && r.data.tax_year === 2026 && r.data.calc.annualGross === 78000
    && r.data.calc.perPeriod.gross === 3000, JSON.stringify(r.data));
  const derivedJob = r.data.id;
  H.check('simplified job YTD derives from elapsed periods (21 pays)',
    r.data.ytd_cpp === 3416.9 && r.data.ytd_cpp2 === 109.85 && r.data.ytd_ei === 907.1, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/earnings/jobs/${derivedJob}`, {
    ...derivedBody,
    pay_changes: [
      { effective_date: '2026-01-05', value: 2500 },
      { effective_date: '2026-06-01', value: 3000 },
    ],
  });
  H.check('a mid-year raise re-derives YTD segment by segment, annual stays on the current rate',
    r.status === 200 && r.data.ytd_cpp === 3175.24 && r.data.ytd_cpp2 === 52.31 && r.data.ytd_ei === 880.2
    && r.data.calc.annualGross === 78000, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/earnings/jobs/${derivedJob}`, {
    ...derivedBody,
    pay_changes: [
      { effective_date: '2026-01-05', value: 2500 },
      { effective_date: '2026-06-01', value: 3000 },
    ],
    bonuses: [{ date: '2026-06-30', amount: 5000 }],
  });
  H.check('a bonus lands in the year\'s gross but not the per-period rate',
    r.status === 200 && r.data.calc.annualGross === 83000 && r.data.calc.perPeriod.gross === 3000
    && r.data.bonus_total === 5000, JSON.stringify(r.data));
  // A legacy save (no dates) on a derived job leaves the derived
  // columns and child rows alone.
  r = await H.req('PUT', `/api/earnings/jobs/${derivedJob}`, { ...jobBody, employer: 'Derived Corp' });
  H.check('legacy save without dates preserves derived dates and rows',
    r.status === 200 && r.data.start_date === '2026-01-05' && r.data.pay_changes.length === 2
    && r.data.bonuses.length === 1, JSON.stringify(r.data));
  r = await H.req('POST', '/api/earnings/jobs', { ...derivedBody, start_date: '2026-10-23', recent_pay_date: '2026-01-05' });
  H.check('simplified job rejects a recent date before the start date', r.status === 400);
  r = await H.req('POST', '/api/earnings/jobs', { ...derivedBody, recent_pay_value: undefined, start_date: '2026-01-05', recent_pay_date: '2026-10-23' });
  H.check('simplified job rejects a missing recent value', r.status === 400);
  r = await H.req('DELETE', `/api/earnings/jobs/${derivedJob}`);
  H.check('derived job fixture cleaned up', r.status === 200);

  // Take-home input: the form value is a per-period net; the server
  // back-solves the gross through the same derived path, so the
  // stored job is indistinguishable from one entered as gross.
  const grossTakeBody = {
    employer: 'Gross Corp', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
  };
  r = await H.req('POST', '/api/earnings/jobs', grossTakeBody);
  H.check('take-home fixture: gross job created', r.status === 201);
  const grossTakeJob = r.data;
  r = await H.req('POST', '/api/earnings/jobs', {
    ...grossTakeBody, employer: 'Takehome Corp',
    recent_pay_value: grossTakeJob.calc.perPeriod.net, pay_value_basis: 'takehome',
  });
  H.check('take-home save back-solves the gross: per-period net matches to the cent, annual is solved gross x periods',
    r.status === 201 && r.data.calc.perPeriod.net === grossTakeJob.calc.perPeriod.net
    && r.data.calc.annualGross === Math.round(r.data.gross_amount * 26 * 100) / 100, JSON.stringify(r.data));
  const takeJob = r.data;
  r = await H.req('POST', '/api/earnings/jobs', { ...grossTakeBody, employer: 'Gross Twin', recent_pay_value: takeJob.gross_amount });
  H.check('take-home job computes exactly like the equivalent gross job',
    r.status === 201 && JSON.stringify(r.data.calc) === JSON.stringify(takeJob.calc)
    && r.data.ytd_cpp === takeJob.ytd_cpp && r.data.ytd_cpp2 === takeJob.ytd_cpp2
    && r.data.ytd_ei === takeJob.ytd_ei, JSON.stringify(r.data));
  const grossTwin = r.data.id;
  r = await H.req('PUT', `/api/earnings/jobs/${takeJob.id}`, {
    ...grossTakeBody, employer: 'Takehome Corp',
    recent_pay_value: grossTakeJob.calc.perPeriod.net, pay_value_basis: 'takehome',
  });
  H.check('take-home edit re-solves the same gross',
    r.status === 200 && r.data.gross_amount === takeJob.gross_amount
    && r.data.calc.perPeriod.net === grossTakeJob.calc.perPeriod.net, JSON.stringify(r.data));
  r = await H.req('POST', '/api/earnings/jobs', {
    ...grossTakeBody, employer: 'Takehome Bad', recent_pay_value: 0.01, pay_value_basis: 'takehome',
    bonuses: [{ date: '2026-06-30', amount: 50000 }],
  });
  H.check('unreachable take-home target is a 400, never a silent fallback',
    r.status === 400 && /no per-period gross/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await H.req('POST', '/api/earnings/jobs', { ...grossTakeBody, pay_value_basis: 'bogus' });
  H.check('unknown pay value basis is a 400', r.status === 400);
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Legacy Takehome', province: 'BC', frequency: 'biweekly',
    gross_amount: 78000, gross_basis: 'annual', tax_year: 2026, pay_value_basis: 'takehome',
  });
  H.check('take-home without dates is a 400', r.status === 400);
  r = await H.req('DELETE', `/api/earnings/jobs/${grossTakeJob.id}`);
  H.check('take-home gross fixture cleaned up', r.status === 200);
  r = await H.req('DELETE', `/api/earnings/jobs/${takeJob.id}`);
  H.check('take-home fixture cleaned up', r.status === 200);
  r = await H.req('DELETE', `/api/earnings/jobs/${grossTwin}`);
  H.check('take-home gross twin cleaned up', r.status === 200);

  // Value history: the stub fetch above already recorded the 2026 auto
  // point for pid2; manual points fill the earlier years.
  r = await H.req('GET', `/api/properties/${pid2}/value-history`);
  H.check('fetch recorded one auto history point (2026)',
    r.data.points && r.data.points.length === 1 && r.data.points[0].year === 2026
      && r.data.points[0].source === 'auto' && r.data.points[0].value === 6532000,
    JSON.stringify(r.data.points || []));
  r = await H.req('POST', `/api/properties/${pid2}/value-history`, { year: 2024, value: 5900000 });
  H.check('manual history point 2024 added', r.status === 201 && r.data.points.length === 2);
  r = await H.req('POST', `/api/properties/${pid2}/value-history`, { year: 2025, value: 6100000 });
  const ch = r.data.change || {};
  H.check('three history points sorted by year', r.data.points.length === 3 && r.data.points.map((p) => p.year).join(',') === '2024,2025,2026');
  H.check('trend change abs = +632000 (2024 -> 2026)', ch.abs === 632000, JSON.stringify(ch));
  H.check('trend change pct ~ +10.71%', typeof ch.pct === 'number' && Math.abs(ch.pct - 10.7119) < 0.01, String(ch.pct));
  const pt2025 = r.data.points.find((p) => p.year === 2025);
  r = await H.req('PUT', `/api/properties/${pid2}/value-history/${pt2025.id}`, { value: 6150000 });
  H.check('history point edited', r.status === 200 && r.data.points.find((p) => p.year === 2025).value === 6150000);
  r = await H.req('POST', `/api/properties/${pid2}/fetch-bca`);
  H.check('re-fetch does not duplicate the 2026 point', r.data.ok === true);
  r = await H.req('GET', `/api/properties/${pid2}/value-history`);
  H.check('still three points after re-fetch', r.data.points.length === 3, JSON.stringify(r.data.points.map((p) => p.year)));
  const pt2024 = r.data.points.find((p) => p.year === 2024);
  r = await H.req('DELETE', `/api/properties/${pid2}/value-history/${pt2024.id}`);
  H.check('history point deleted, change now starts 2025', r.data.points.length === 2 && r.data.change && r.data.change.fromYear === 2025);

  // Equity with history: the newest history point (2026, 6532000) is the
  // latest assessed value; 6532000 - 900000 = 5632000.
  r = await H.req('PUT', `/api/properties/${pid2}`, { mortgage_balance: 900000 });
  H.check('set balance on pid2 for equity', r.status === 200);
  r = await H.req('GET', `/api/properties/${pid2}/equity`);
  H.check('equity uses newest history point',
    r.data.assessedValue === 6532000 && r.data.assessedYear === 2026 && r.data.balance === 900000 && r.data.equity === 5632000,
    JSON.stringify(r.data));

  // Rate-plan chain: a property with a balance but NO rate
  // segments gets no projection at all (never a hidden default rate);
  // adding a segment produces numbers that follow that segment, and
  // editing the segment's rate changes the numbers.
  r = await H.req('POST', '/api/properties', {
    address: '9 Rateplan Road, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2019-11-05',
  });
  H.check('create rate-plan chain property', r.status === 201);
  const pid3 = r.data.id;
  r = await H.req('GET', `/api/properties/${pid3}/amortization`);
  H.check('no rate plan -> NO_RATE_PLAN and no series',
    r.data.ok === false && r.data.code === 'NO_RATE_PLAN' && !r.data.series,
    JSON.stringify(r.data).slice(0, 160));
  r = await H.req('POST', `/api/properties/${pid3}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('add first rate segment', r.status === 201);
  const seg3 = r.data.id;
  r = await H.req('GET', `/api/properties/${pid3}/amortization`);
  H.check('projection appears with the segment',
    r.data.ok === true && Math.abs(r.data.series[0].interest - 412.39) <= 0.02,
    r.data.series && String(r.data.series[0].interest));
  H.check('amortization carries balance + balanceDate for chart A',
    r.data.balance === 100000 && r.data.balanceDate === '2026-10-01');
  r = await H.req('PUT', `/api/properties/${pid3}/rates/${seg3}`, { annual_rate: 6 });
  H.check('edit segment rate', r.status === 200 && r.data.annual_rate === 6);
  r = await H.req('GET', `/api/properties/${pid3}/amortization`);
  H.check('projection follows the edited rate (6% -> 493.86)',
    r.data.ok === true && Math.abs(r.data.series[0].interest - 493.86) <= 0.02,
    r.data.series && String(r.data.series[0].interest));
  r = await H.req('DELETE', `/api/properties/${pid3}`);
  H.check('delete rate-plan chain property', r.status === 200);

  // Slim add: only address + owner + outstanding principal + purchase
  // date. The balance date defaults to today (current-balance
  // semantics); payment and amortization stay empty for the detail page
  // to fill in, and with no rate plan yet the projection is the
  // NO_RATE_PLAN prompt state. Purchase date is required at add time
  // (the column itself stays nullable for older rows).
  // The outstanding principal itself is OPTIONAL: a request with
  // no balance at all is rejected only for the still-missing
  // purchase date, never for the principal.
  r = await H.req('POST', '/api/properties', { address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'] });
  H.check('add without balance is not rejected for the principal (the missing purchase date is what blocks it)',
    r.status === 400 && String(r.data.error || '') === 'purchase date is required', JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', {
    address: '8 No Principal Lane, Victoria, BC', owners: ['Shawn'], purchase_date: '2021-05-14',
  });
  H.check('add without balance succeeds: no anchor, no balance date, Term 1 opens empty',
    r.status === 201 && r.data.mortgage_balance === null && r.data.mortgage_balance_date === null
      && r.data.terms[0].opening_balance === null,
    JSON.stringify({ b: r.data.mortgage_balance, bd: r.data.mortgage_balance_date, open: r.data.terms[0] && r.data.terms[0].opening_balance }));
  S.pidNoBal = r.data.id;
  r = await H.req('POST', '/api/properties', {
    address: '9 Date Only Lane, Victoria, BC', purchase_date: '2021-05-14', mortgage_balance_date: '2020-01-01',
  });
  H.check('a balance date on its own seeds no anchor (balance and date both stay null)',
    r.status === 201 && r.data.mortgage_balance === null && r.data.mortgage_balance_date === null,
    JSON.stringify({ b: r.data.mortgage_balance, bd: r.data.mortgage_balance_date }));
  const pidDateOnly = r.data.id;
  r = await H.req('POST', '/api/properties', {
    address: '10 Negative Lane, Victoria, BC', purchase_date: '2021-05-14', mortgage_balance: -5,
  });
  H.check('a negative principal is still rejected', r.status === 400 && String(r.data.error || '').includes('principal'), JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${S.pidNoBal}/amortization`);
  H.check('a balance-less property reports no outstanding principal (a named state, not a crash)',
    r.data.ok === false && String(r.data.error || '').includes('no outstanding principal'), JSON.stringify(r.data).slice(0, 160));
  await H.req('DELETE', `/api/properties/${pidDateOnly}`);
  r = await H.req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'], mortgage_balance: 123456,
  });
  H.check('add without purchase date rejected', r.status === 400 && String(r.data.error || '') === 'purchase date is required', JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'], mortgage_balance: 123456, purchase_date: '2021-13-40',
  });
  H.check('add with impossible purchase date rejected', r.status === 400 && String(r.data.error || '').includes('valid date'), JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', {
    address: '7 Slim Lane, Victoria, BC', owners: ['Shawn'], mortgage_balance: 123456, purchase_date: '2021-05-14',
  });
  const today = new Date().toISOString().slice(0, 10);
  H.check('slim add (4 fields) creates the property', r.status === 201 && r.data.mortgage_balance === 123456, JSON.stringify(r.data).slice(0, 160));
  H.check('purchase date stored', r.data.purchase_date === '2021-05-14', String(r.data.purchase_date));
  H.check('balance date defaults to today (not the purchase date)', r.data.mortgage_balance_date === today, String(r.data.mortgage_balance_date));
  H.check('payment/amortization left empty at add', (r.data.mortgage_payment ?? null) === null && (r.data.amortization_years ?? null) === null);
  const pidSlim = r.data.id;
  r = await H.req('PUT', `/api/properties/${pidSlim}`, { purchase_date: '2022-08-30' });
  H.check('purchase date changed on the detail side', r.status === 200 && r.data.purchase_date === '2022-08-30');
  r = await H.req('GET', `/api/properties/${pidSlim}`);
  H.check('purchase date change persisted', r.data.purchase_date === '2022-08-30');
  r = await H.req('GET', `/api/properties/${pidSlim}/amortization`);
  H.check('slim-added property sits in NO_RATE_PLAN state', r.data.ok === false && r.data.code === 'NO_RATE_PLAN');
  r = await H.req('DELETE', `/api/properties/${pidSlim}`);
  H.check('delete slim property', r.status === 200);

  // Payment day (deduction day): anchors the projection's monthly node
  // dates only — the interest amounts must not move when it changes.
  r = await H.req('POST', '/api/properties', {
    address: '24 Payday Place, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-24', amortization_years: 25,
    purchase_date: '2020-01-01',
  });
  const pidPay = r.data.id;
  await H.req('POST', `/api/properties/${pidPay}/rates`, {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  r = await H.req('GET', `/api/properties/${pidPay}/amortization`);
  H.check('no payment day: nodes on the balance-date anniversary',
    r.data.series[0].date === '2026-11-24' && r.data.series[0].interest === 412.39,
    JSON.stringify(r.data.series[0]));
  const interestBefore = r.data.series[0].interest;
  r = await H.req('PUT', `/api/properties/${pidPay}`, { payment_day: 1 });
  H.check('payment day stored', r.status === 200 && r.data.payment_day === 1, JSON.stringify(r.data.payment_day));
  r = await H.req('GET', `/api/properties/${pidPay}/amortization`);
  H.check('payment day 1: nodes land on the 1st',
    r.data.series[0].date === '2026-11-01' && r.data.series[1].date === '2026-12-01',
    JSON.stringify([r.data.series[0].date, r.data.series[1].date]));
  H.check('payment day does not change the interest math', r.data.series[0].interest === interestBefore);
  r = await H.req('PUT', `/api/properties/${pidPay}`, { payment_day: 15 });
  H.check('payment day update stored', r.status === 200 && r.data.payment_day === 15);
  r = await H.req('GET', `/api/properties/${pidPay}/amortization`);
  H.check('nodes follow the new payment day', r.data.series[0].date === '2026-11-15', String(r.data.series[0].date));
  await H.req('PUT', `/api/properties/${pidPay}`, { payment_day: 31 });
  r = await H.req('GET', `/api/properties/${pidPay}/amortization`);
  H.check('payment day 31 clamps to month end', r.data.series[0].date === '2026-11-30'
    && r.data.series.find((s) => s.month === '2027-02')?.date === '2027-02-28');
  r = await H.req('PUT', `/api/properties/${pidPay}`, { payment_day: 0 });
  H.check('payment day 0 rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${pidPay}`, { payment_day: 32 });
  H.check('payment day 32 rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${pidPay}`, { payment_day: null });
  H.check('payment day cleared', r.status === 200 && (r.data.payment_day ?? null) === null);
  r = await H.req('GET', `/api/properties/${pidPay}/amortization`);
  H.check('cleared payment day restores anniversary nodes', r.data.series[0].date === '2026-11-24');
  r = await H.req('DELETE', `/api/properties/${pidPay}`);
  H.check('delete payday property', r.status === 200);

  // Payment frequency: stored on the property, validated, and it
  // drives the projection. Same loan family as the engine anchors
  // ($100,000 at 5% from 2026-10-01) with the payment CALCULATED
  // from a 25-year amortization ($581.60): monthly totals are the
  // baseline (total interest 74482.97); accelerated bi-weekly pays
  // $290.80 per period, pays off in 2048-03 and costs 62395.46
  // (both totals cross-checked against the engine directly).
  r = await H.req('POST', '/api/properties', {
    address: '3 Frequency Court, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2019-06-15',
  });
  const pidFreq = r.data.id;
  await H.req('POST', `/api/properties/${pidFreq}/rates`, {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  r = await H.req('GET', `/api/properties/${pidFreq}/amortization`);
  H.check('default frequency is monthly with the baseline totals',
    r.data.frequency === 'monthly' && Math.abs(r.data.totalInterest - 74482.97) <= 0.02,
    JSON.stringify({ f: r.data.frequency, t: r.data.totalInterest }));
  const monthlyTotal = r.data.totalInterest;
  const monthlyPayoff = r.data.payoffMonth;
  r = await H.req('PUT', `/api/properties/${pidFreq}`, { payment_frequency: 'daily' });
  H.check('unknown payment frequency rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${pidFreq}`, { payment_frequency: 'accelerated_bi_weekly' });
  H.check('payment frequency stored', r.status === 200 && r.data.payment_frequency === 'accelerated_bi_weekly',
    JSON.stringify(r.data.payment_frequency));
  r = await H.req('GET', `/api/properties/${pidFreq}`);
  H.check('payment frequency persisted', r.data.payment_frequency === 'accelerated_bi_weekly');
  r = await H.req('GET', `/api/properties/${pidFreq}/amortization`);
  H.check('accelerated bi-weekly: $290.80 per period, less interest, earlier payoff',
    r.data.frequency === 'accelerated_bi_weekly' && r.data.periodPayment === 290.80
      && Math.abs(r.data.totalInterest - 62395.46) <= 0.02
      && r.data.totalInterest < monthlyTotal && r.data.payoffMonth === '2048-03'
      && r.data.payoffMonth < monthlyPayoff && r.data.series[0].month === '2026-10',
    JSON.stringify({ p: r.data.periodPayment, t: r.data.totalInterest, po: r.data.payoffMonth }).slice(0, 160));
  r = await H.req('PUT', `/api/properties/${pidFreq}`, { payment_frequency: 'monthly' });
  H.check('frequency reset to monthly', r.status === 200 && r.data.payment_frequency === 'monthly');
  r = await H.req('GET', `/api/properties/${pidFreq}/amortization`);
  H.check('monthly totals restored after reset', Math.abs(r.data.totalInterest - monthlyTotal) <= 0.02);
  r = await H.req('DELETE', `/api/properties/${pidFreq}`);
  H.check('delete frequency property', r.status === 200);

  // ------------------------------------------------------------ admin ---
  // User management is admin-only. The live session at this point is
  // Jiaying's (from the login checks near the top), i.e. NOT admin.
  r = await H.req('GET', '/api/admin/users');
  H.check('non-admin gets 403 on the admin user list', r.status === 403, JSON.stringify(r.data));
  r = await H.req('POST', '/api/admin/users', { username: 'Nope', password: 'nope' });
  H.check('non-admin cannot create users', r.status === 403);
  r = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
  H.check('admin signs back in for the admin checks', r.status === 200);
  r = await H.req('GET', '/api/me');
  H.check('/api/me flags admin and carries avatar data',
    r.data.isAdmin === true && typeof r.data.avatarColor === 'string' && r.data.avatarFile === null,
    JSON.stringify(r.data));

  r = await H.req('GET', '/api/admin/users');
  H.check('admin can list all users', r.status === 200 && r.data.length === 3, JSON.stringify(r.data).slice(0, 200));
  const byName = Object.fromEntries((r.data || []).map((u) => [u.username, u]));
  H.check('default avatar colors are stored and Shawn != Jiaying',
    !!byName.Shawn.avatarColor && !!byName.Jiaying.avatarColor && byName.Shawn.avatarColor !== byName.Jiaying.avatarColor,
    JSON.stringify({ Shawn: byName.Shawn && byName.Shawn.avatarColor, Jiaying: byName.Jiaying && byName.Jiaying.avatarColor }));
  H.check('seeded users start on letter avatars (no photo file)',
    byName.Shawn.avatarFile === null && byName.Jiaying.avatarFile === null && byName.admin.avatarFile === null);
  const jiayingId = byName.Jiaying.id;
  const adminId = byName.admin.id;

  // Avatar upload for Jiaying (a tiny PNG): afterwards the file is
  // served back, and the owner-candidate directory — which the owner
  // chips on cards and detail pages render from — carries it.
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await H.req('POST', `/api/admin/users/${jiayingId}/avatar`, { dataBase64: TINY_PNG, contentType: 'image/png' });
  H.check('avatar upload accepted', r.status === 200 && !!r.data.avatarFile, JSON.stringify(r.data).slice(0, 160));
  const jiayingAvatar = r.data.avatarFile;
  const avRes = await fetch(`${H.BASE}/avatars/${jiayingAvatar}`, { headers: { Cookie: H.getCookie() } });
  H.check('uploaded avatar is served back as an image',
    avRes.status === 200 && String(avRes.headers.get('content-type')).includes('image/png'),
    `${avRes.status} ${avRes.headers.get('content-type')}`);
  r = await H.req('GET', '/api/users');
  const jiaDir = (r.data || []).find((u) => u.username === 'Jiaying');
  H.check('owner directory carries Jiaying\'s uploaded avatar (chips render from this)',
    !!jiaDir && jiaDir.avatarFile === jiayingAvatar, JSON.stringify(jiaDir));
  r = await H.req('POST', `/api/admin/users/${jiayingId}/avatar`, { dataBase64: TINY_PNG, contentType: 'text/plain' });
  H.check('non-image avatar upload rejected', r.status === 400);

  // A property owned by Jiaying: its owners name her, and her chip
  // everywhere (card, detail) renders the avatar from the directory.
  r = await H.req('POST', '/api/properties', { address: '5 Avatar Avenue', owners: ['Jiaying'], mortgage_balance: 200000, purchase_date: '2023-06-01' });
  H.check('property owned by Jiaying created', r.status === 201 && JSON.stringify(r.data.owners) === '["Jiaying"]');
  const pidAvatar = r.data.id;
  r = await H.req('GET', `/api/properties/${pidAvatar}`);
  H.check('property detail data names Jiaying as owner', JSON.stringify(r.data.owners) === '["Jiaying"]');

  // Restore default: photo cleared, stored color kept, file gone.
  r = await H.req('DELETE', `/api/admin/users/${jiayingId}/avatar`);
  H.check('restore-default clears the photo and keeps the color',
    r.status === 200 && r.data.avatarFile === null && r.data.avatarColor === byName.Jiaying.avatarColor,
    JSON.stringify(r.data).slice(0, 160));
  const avGone = await fetch(`${H.BASE}/avatars/${jiayingAvatar}`, { headers: { Cookie: H.getCookie() } });
  H.check('removed avatar file no longer served', avGone.status === 404);
  r = await H.req('DELETE', `/api/properties/${pidAvatar}`);
  H.check('avatar property cleaned up', r.status === 200);

  // Create / reset-password / delete lifecycle for a throwaway user.
  r = await H.req('POST', '/api/admin/users', { username: 'TestUser', password: 'firstpass' });
  H.check('admin creates a user (with a stored avatar color)',
    r.status === 201 && r.data.username === 'TestUser' && !!r.data.avatarColor, JSON.stringify(r.data).slice(0, 160));
  const testUserId = r.data.id;
  r = await H.req('POST', '/api/admin/users', { username: 'TestUser', password: 'whatever' });
  H.check('duplicate username rejected', r.status === 400);
  r = await H.req('POST', '/api/login', { username: 'TestUser', password: 'firstpass' });
  H.check('new user can sign in', r.status === 200);
  r = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
  r = await H.req('POST', `/api/admin/users/${testUserId}/password`, { password: 'secondpass' });
  H.check('admin resets a password', r.status === 200);
  r = await H.req('POST', '/api/login', { username: 'TestUser', password: 'firstpass' });
  H.check('old password fails after reset', r.status === 401);
  r = await H.req('POST', '/api/login', { username: 'TestUser', password: 'secondpass' });
  H.check('new password works after reset', r.status === 200);

  // Deleting a user scrubs their name from owners lists and ends their
  // sign-in; the admin user itself cannot be deleted.
  r = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
  r = await H.req('POST', '/api/properties', { address: '6 Scrub Street', owners: ['TestUser'], mortgage_balance: 1000, purchase_date: '2024-01-01' });
  const pidScrub = r.data.id;
  H.check('property owned by TestUser created', r.status === 201 && JSON.stringify(r.data.owners) === '["TestUser"]');
  r = await H.req('DELETE', `/api/admin/users/${testUserId}`);
  H.check('admin deletes a user', r.status === 200);
  r = await H.req('GET', `/api/properties/${pidScrub}`);
  H.check('deleted user scrubbed from owners', JSON.stringify(r.data.owners) === '[]', JSON.stringify(r.data.owners));
  r = await H.req('POST', '/api/login', { username: 'TestUser', password: 'secondpass' });
  H.check('deleted user can no longer sign in', r.status === 401);
  r = await H.req('DELETE', `/api/admin/users/${adminId}`);
  H.check('deleting the admin user is refused', r.status === 400, JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/properties/${pidScrub}`);
  H.check('scrub property cleaned up', r.status === 200);

  // Segment delete + property delete paths.
  r = await H.req('DELETE', `/api/properties/${pid}/rates/${segId}`);
  H.check('delete rate segment', r.status === 200);
  r = await H.req('DELETE', `/api/properties/${pid}`);
  H.check('delete property', r.status === 200);

  // ------------------------------------------------------------ portfolio --
  // Cross-property aggregates from GET /api/properties/portfolio.
  // Assertions are delta-based against the portfolio as it was before
  // the fixtures, with per-property expectations taken from the
  // single-property endpoints (independent of the aggregation code).
  const portBefore = (await H.req('GET', '/api/properties/portfolio')).data;
  H.check('portfolio endpoint responds', portBefore && portBefore.totals && Array.isArray(portBefore.outstandingByMonth));
  r = await H.req('POST', '/api/properties', {
    address: '11 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2019-11-05',
  });
  const pidPA = r.data.id;
  await H.req('POST', `/api/properties/${pidPA}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  r = await H.req('POST', '/api/properties', {
    address: '22 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 50000, mortgage_balance_date: '2026-10-01', amortization_years: 25,
    purchase_date: '2020-05-20',
  });
  const pidPB = r.data.id;
  await H.req('POST', `/api/properties/${pidPB}/rates`, { start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 3 });
  const amortA = (await H.req('GET', `/api/properties/${pidPA}/amortization`)).data;
  const amortB = (await H.req('GET', `/api/properties/${pidPB}/amortization`)).data;
  H.check('portfolio fixtures project individually (A matches the 74482.97 anchor: $100k at 5%, payment calculated over 25y)',
    amortA.ok && amortB.ok && Math.abs(amortA.totalInterest - 74482.97) <= 0.02,
    JSON.stringify({ a: amortA.totalInterest, b: amortB.totalInterest }));
  const port = (await H.req('GET', '/api/properties/portfolio')).data;
  H.check('portfolio totals = baseline + both properties',
    Math.abs(port.totals.outstanding - (portBefore.totals.outstanding + amortA.remainingBalance + amortB.remainingBalance)) <= 0.02
      && Math.abs(port.totals.monthlyPayment - (portBefore.totals.monthlyPayment + 818.22)) <= 0.02
      && Math.abs(port.totals.totalInterest - (portBefore.totals.totalInterest + amortA.totalInterest + amortB.totalInterest)) <= 0.05,
    JSON.stringify(port.totals));
  const sliceA = port.pie.outstanding.find((s) => s.id === pidPA);
  const sliceB = port.pie.outstanding.find((s) => s.id === pidPB);
  const pctSum = port.pie.outstanding.reduce((s, x) => s + x.pct, 0);
  H.check('pie shares match the balances and sum to 100',
    !!sliceA && !!sliceB
      && Math.abs(sliceA.pct - (100000 / port.totals.outstanding) * 100) <= 0.11
      && Math.abs(sliceB.pct - (50000 / port.totals.outstanding) * 100) <= 0.11
      && Math.abs(pctSum - 100) <= 0.5,
    JSON.stringify(port.pie.outstanding).slice(0, 200));
  const eqSlices = port.pie.equity || [];
  const eqProps = port.properties.filter((x) => x.equity > 0);
  const eqPctSum = eqSlices.reduce((s, x) => s + x.pct, 0);
  const eqValSum = eqSlices.reduce((s, x) => s + x.value, 0);
  H.check('equity pie: one slice per positive-equity property, pcts sum to 100, values sum to the Total equity figure',
    Array.isArray(port.pie.equity)
      && eqSlices.length === eqProps.length
      && eqSlices.every((s) => { const p = port.properties.find((x) => x.id === s.id); return p && Math.abs(s.value - p.equity) <= 0.02; })
      && (eqSlices.length === 0 || (Math.abs(eqPctSum - 100) <= 0.5 && Math.abs(eqValSum - port.totals.equity) <= 0.05)),
    JSON.stringify({ slices: eqSlices.length, props: eqProps.length, pct: eqPctSum, sum: eqValSum, total: port.totals.equity }).slice(0, 200));
  const rowJun27 = port.outstandingByMonth.find((m) => m.month === '2027-06');
  const balA27 = amortA.series.find((s) => s.month === '2027-06').balance;
  const balB27 = amortB.series.find((s) => s.month === '2027-06').balance;
  const stackSum = rowJun27 ? Object.values(rowJun27.byProperty).reduce((s, v) => s + (v || 0), 0) : -1;
  H.check('stacked bars top out at the total line (2027-06)',
    !!rowJun27 && Math.abs(rowJun27.byProperty[pidPA] - balA27) <= 0.02
      && Math.abs(rowJun27.byProperty[pidPB] - balB27) <= 0.02
      && Math.abs(stackSum - rowJun27.total) <= 0.02,
    JSON.stringify(rowJun27).slice(0, 200));
  // Assessed-by-year, carry rule: A's 2024 point carries into 2025;
  // B counts only from its first point (2025).
  await H.req('POST', `/api/properties/${pidPA}/value-history`, { year: 2024, value: 980000 });
  await H.req('POST', `/api/properties/${pidPA}/value-history`, { year: 2026, value: 1150000 });
  await H.req('POST', `/api/properties/${pidPB}/value-history`, { year: 2025, value: 500000 });
  const port2 = (await H.req('GET', '/api/properties/portfolio')).data;
  const assessedAt = (resp, y) => { const row = resp.assessedByYear.find((a) => a.year === y); return row ? row.total : 0; };
  H.check('assessed-by-year deltas follow the carry rule',
    Math.abs(assessedAt(port2, 2024) - assessedAt(port, 2024) - 980000) <= 0.02
      && Math.abs(assessedAt(port2, 2025) - assessedAt(port, 2025) - 1480000) <= 0.02
      && Math.abs(assessedAt(port2, 2026) - assessedAt(port, 2026) - 1650000) <= 0.02,
    JSON.stringify(port2.assessedByYear).slice(0, 200));
  // A property with a later balance date joins the projection only
  // from its own start — never back-filled into earlier months.
  r = await H.req('POST', '/api/properties', {
    address: '33 Portfolio Avenue, Victoria, BC',
    mortgage_balance: 20000, mortgage_balance_date: '2027-03-15', amortization_years: 25,
    purchase_date: '2027-03-15',
  });
  const pidPC = r.data.id;
  await H.req('POST', `/api/properties/${pidPC}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 4 });
  const port3 = (await H.req('GET', '/api/properties/portfolio')).data;
  const rowNov26 = port3.outstandingByMonth.find((m) => m.month === '2026-11');
  const cMonths = port3.outstandingByMonth.filter((m) => m.byProperty[pidPC] != null);
  H.check('a property joins the projection only from its own balance date',
    !!rowNov26 && rowNov26.byProperty[pidPC] === null
      && cMonths.length > 0 && cMonths[0].month === '2027-04'
      && Math.abs(port3.totals.outstanding - (port.totals.outstanding + 20000)) <= 0.02,
    JSON.stringify({ first: cMonths[0] && cMonths[0].month, nov: rowNov26 && rowNov26.byProperty[pidPC] }));
  r = await H.req('DELETE', `/api/properties/${pidPA}`);
  H.check('delete portfolio property A', r.status === 200);
  await H.req('DELETE', `/api/properties/${pidPB}`);
  await H.req('DELETE', `/api/properties/${pidPC}`);

  // ------------------------------------------- projection states --
  // The portfolio must say WHY a property is missing from the
  // projected interest, in three distinct states. The fixture mirrors
  // a real first run: a balance and one variable prime-spread segment
  // (2024-12-17, prime - 1), but NO amortization — a rate plan alone
  // cannot project (NO_PAYMENT), because the payment is calculated
  // from the amortization and there is nothing to calculate it from.
  const portStates0 = (await H.req('GET', '/api/properties/portfolio')).data;
  r = await H.req('POST', '/api/properties', {
    address: '44 State Test Crescent, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
    purchase_date: '2024-12-17',
  });
  const pidState = r.data.id;
  let portS = (await H.req('GET', '/api/properties/portfolio')).data;
  let rowS = portS.properties.find((x) => x.id === pidState);
  H.check('portfolio state: balance with no rate segments is no_plan',
    !!rowS && rowS.projState === 'no_plan'
      && portS.totals.noPlanCount === (portStates0.totals.noPlanCount || 0) + 1,
    JSON.stringify(rowS && rowS.projState));
  await H.req('POST', `/api/properties/${pidState}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  const amortState = (await H.req('GET', `/api/properties/${pidState}/amortization`)).data;
  H.check('a plan with no amortization reports NO_PAYMENT',
    !amortState.ok && amortState.code === 'NO_PAYMENT', JSON.stringify(amortState.code));
  portS = (await H.req('GET', '/api/properties/portfolio')).data;
  rowS = portS.properties.find((x) => x.id === pidState);
  H.check('portfolio state: plan but no amortization is no_payment, contributing no interest',
    !!rowS && rowS.projState === 'no_payment'
      && portS.totals.planNoPaymentCount === (portStates0.totals.planNoPaymentCount || 0) + 1
      && portS.totals.interestFrom === portStates0.totals.interestFrom
      && Math.abs(portS.totals.totalInterest - portStates0.totals.totalInterest) <= 0.02,
    JSON.stringify({ state: rowS && rowS.projState, totals: portS.totals }));
  await H.req('PUT', `/api/properties/${pidState}`, { amortization_years: 25 });
  const amortState2 = (await H.req('GET', `/api/properties/${pidState}/amortization`)).data;
  portS = (await H.req('GET', '/api/properties/portfolio')).data;
  rowS = portS.properties.find((x) => x.id === pidState);
  H.check('portfolio state: setting the amortization flips it to projected and its interest joins the total',
    !!rowS && rowS.projState === 'projected' && amortState2.ok === true
      && portS.totals.interestFrom === portStates0.totals.interestFrom + 1
      && Math.abs(portS.totals.totalInterest - (portStates0.totals.totalInterest + amortState2.totalInterest)) <= 0.05,
    JSON.stringify({ state: rowS && rowS.projState, interest: amortState2.totalInterest }));
  await H.req('DELETE', `/api/properties/${pidState}`);

  // -------------------------------- lender + amortization-year range --
  // The lender is a plain mortgage fact: it round-trips through the
  // property PUT/GET and stays null until the user names their bank —
  // the app never invents one.
  r = await H.req('POST', '/api/properties', {
    address: '77 Lender Test Road, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
    purchase_date: '2024-12-17',
  });
  const pidLender = r.data.id;
  H.check('lender starts unset (never invented)', (r.data.lender ?? null) === null, JSON.stringify(r.data.lender));
  r = await H.req('PUT', `/api/properties/${pidLender}`, { lender: '  Scotiabank  ' });
  H.check('lender saves trimmed', r.status === 200 && r.data.lender === 'Scotiabank', JSON.stringify(r.data.lender));
  r = await H.req('GET', `/api/properties/${pidLender}`);
  H.check('lender round-trips on the property', r.data.lender === 'Scotiabank', JSON.stringify(r.data.lender));
  r = await H.req('PUT', `/api/properties/${pidLender}`, { amortization_years: 36 });
  H.check('amortization above 35 years is rejected',
    r.status === 400 && String(r.data.error || '').includes('between 1 and 35'), JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${pidLender}`, { amortization_years: 0.5 });
  H.check('amortization below 1 year is rejected', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${pidLender}`, { amortization_years: 35 });
  H.check('amortization of 35 years is accepted (the range edge)',
    r.status === 200 && r.data.amortization_years === 35, JSON.stringify(r.data.amortization_years));
  await H.req('DELETE', `/api/properties/${pidLender}`);

  // Amortization ALONE (no monthly payment) must project: the states
  // fixture above proved a payment flips no_payment -> projected;
  // here the remaining years do it, the payment being derived from
  // the balance, the segment rate (stub prime 4.95 - 1 = 3.95%) and
  // the 30 years — the same hand-computed anchor as the unit tests.
  r = await H.req('POST', '/api/properties', {
    address: '78 Amort Only Road, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2026-10-25',
    purchase_date: '2024-12-17',
  });
  const pidAmortOnly = r.data.id;
  await H.req('POST', `/api/properties/${pidAmortOnly}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  await H.req('PUT', `/api/properties/${pidAmortOnly}`, { amortization_years: 30 });
  const amortOnly = (await H.req('GET', `/api/properties/${pidAmortOnly}/amortization`)).data;
  H.check('amortization alone projects with a calculated payment of $6,381.36',
    amortOnly.ok === true && Math.abs(amortOnly.paymentUsed - 6381.36) < 0.5,
    JSON.stringify({ ok: amortOnly.ok, used: amortOnly.paymentUsed }));
  const portAmort = (await H.req('GET', '/api/properties/portfolio')).data;
  const rowAmort = portAmort.properties.find((x) => x.id === pidAmortOnly);
  H.check('amortization alone flips the portfolio state to projected',
    !!rowAmort && rowAmort.projState === 'projected', JSON.stringify(rowAmort && rowAmort.projState));
  await H.req('DELETE', `/api/properties/${pidAmortOnly}`);

  // ------------------------------------------------------------ prime ---
  r = await H.req('GET', '/api/prime');
  H.check('fetch-on-read stored the stub prime with its as-of date',
    r.data.current && r.data.current.rate === 4.95 && r.data.current.date === '2026-10-21'
      && r.data.source && r.data.source.series === 'V80691311', JSON.stringify(r.data.current));
  H.check('prime change points walk back through the stored history (4.95, 4.70, 4.45, ...)',
    Array.isArray(r.data.changes) && r.data.changes.length === 5
      && r.data.changes[0].rate === 4.95 && r.data.changes[1].rate === 4.7 && r.data.changes[2].rate === 4.45,
    JSON.stringify(r.data.changes));
  H.check('prime info carries the full step history for the chart (first observation, every change point, newest observation)',
    Array.isArray(r.data.history) && r.data.history.length === 8
      && r.data.history[0].date === '2024-12-11' && r.data.history[0].rate === 5.95
      && r.data.history.some((h) => h.date === '2024-12-18' && h.rate === 5.45)
      && r.data.history.some((h) => h.date === '2025-11-05' && h.rate === 4.45)
      && r.data.history[r.data.history.length - 1].date === '2026-10-21'
      && r.data.history[r.data.history.length - 1].rate === 4.95,
    JSON.stringify(r.data.history));

  r = await H.req('GET', '/api/properties/1');
  H.check('legacy variable segment migrated as absolute, value intact',
    r.data.segments.length === 1 && r.data.segments[0].rate_mode === 'absolute'
      && r.data.segments[0].effective_rate === 5, JSON.stringify(r.data.segments));

  r = await H.req('POST', '/api/properties', {
    address: '7 Prime Place, Victoria, BC', mortgage_balance: 100000,
    mortgage_balance_date: '2026-10-01', amortization_years: 25, purchase_date: '2020-01-01',
  });
  const pidPrime = r.data.id;
  r = await H.req('POST', `/api/properties/${pidPrime}/rates`, { start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread' });
  H.check('a prime segment without a spread is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${pidPrime}/rates`, { start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: 99 });
  H.check('an out-of-range spread is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${pidPrime}/rates`, { start_date: '2026-01-01', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 });
  H.check('Prime - 1 at prime 4.95 resolves to 3.95 and stores no absolute rate',
    r.status === 201 && r.data.rate_mode === 'prime_spread' && r.data.annual_rate === null && r.data.effective_rate === 3.95,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${pidPrime}/amortization`);
  H.check('projection uses the resolved rate (first interest 326.49 at 3.95%)',
    r.data.ok === true && r.data.primeRate === 4.95 && r.data.series[0].interest === 326.49,
    JSON.stringify({ primeRate: r.data.primeRate, first: r.data.series && r.data.series[0] }));

  const vanToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  H.check('the projection response carries a fresh prime status dated today',
    r.data.prime && r.data.prime.fresh === true && r.data.prime.rate === 4.95 && r.data.prime.asOf === vanToday,
    JSON.stringify(r.data.prime));

  // Fetch-on-read policy: within the same Vancouver day the moved
  // stub prime is NOT picked up — the value fetched today is fresh.
  H.flags.prime = 5.45;
  r = await H.req('GET', `/api/properties/${pidPrime}/amortization`);
  H.check('same-day reads do not refetch (still projecting at prime 4.95)',
    r.data.ok === true && r.data.primeRate === 4.95 && r.data.prime.fresh === true,
    JSON.stringify({ primeRate: r.data.primeRate, prime: r.data.prime }));

  // Simulate the next day by backdating the fetch bookkeeping in the
  // app's own database: the very next projection must pull the moved
  // prime inline — no manual refresh, no restart.
  const backdatePrimeMeta = () => {
    const dbFile = new Database(path.join(H.dataDir, 'finance.db'));
    dbFile.pragma('busy_timeout = 5000');
    const old = String(Date.now() - 25 * 3600 * 1000);
    dbFile.prepare("UPDATE app_meta SET value = ? WHERE key IN ('prime_last_success', 'prime_last_attempt')").run(old);
    dbFile.close();
  };
  backdatePrimeMeta();
  r = await H.req('GET', `/api/properties/${pidPrime}/amortization`);
  H.check('the next-day projection fetches inline and uses the moved prime (367.44 at 4.45%)',
    r.data.ok === true && r.data.primeRate === 5.45 && r.data.series[0].interest === 367.44
      && r.data.prime && r.data.prime.fresh === true && r.data.prime.rate === 5.45 && r.data.prime.asOf === vanToday,
    JSON.stringify({ primeRate: r.data.primeRate, prime: r.data.prime, first: r.data.series && r.data.series[0] }));
  r = await H.req('GET', `/api/properties/${pidPrime}`);
  H.check('the same segment now resolves to 4.45', r.data.segments[0].effective_rate === 4.45, JSON.stringify(r.data.segments[0]));

  // BoC down: the request still succeeds on the last known value,
  // and the response flags it stale (fresh: false) for the warning.
  H.flags.primeDown = true;
  backdatePrimeMeta();
  r = await H.req('GET', `/api/properties/${pidPrime}/amortization`);
  H.check('with BoC down the projection falls back to the last known prime, flagged stale',
    r.data.ok === true && r.data.primeRate === 5.45 && r.data.prime && r.data.prime.fresh === false && r.data.prime.rate === 5.45,
    JSON.stringify({ primeRate: r.data.primeRate, prime: r.data.prime }));
  r = await H.req('GET', '/api/prime');
  H.check('prime info stays available and stale while BoC is down (observation as-of unchanged)',
    r.data.current && r.data.current.rate === 5.45 && r.data.current.date === '2026-10-21' && r.data.fresh === false,
    JSON.stringify({ current: r.data.current, fresh: r.data.fresh }));
  H.flags.primeDown = false;
  backdatePrimeMeta();
  r = await H.req('GET', `/api/properties/${pidPrime}/amortization`);
  H.check('when BoC recovers, the next read is fresh again',
    r.data.ok === true && r.data.prime && r.data.prime.fresh === true && r.data.prime.rate === 5.45,
    JSON.stringify(r.data.prime));

  // The manual refresh endpoint still forces a fetch at any time.
  H.flags.prime = 4.95;
  r = await H.req('POST', '/api/prime/refresh');
  H.check('manual refresh forces a fetch of the current value',
    r.data.current && r.data.current.rate === 4.95 && r.data.fresh === true, JSON.stringify(r.data.current));

  // The user's real shape, replayed on the stub history: $1,350,000
  // dated 2024-12-17, Prime - 1, 25-year amortization, and NO
  // entered payment — the payment must come out of the model. It is
  // derived ONCE at the start month's prime (Dec 2024: 5.45 ->
  // 4.45%) and then NEVER moves: his variable product is
  // fixed-payment, so each month prices its interest at its own
  // prime (Feb 5.20 -> 4.20%, Mar 4.95 -> 3.95%, Sep 4.70 -> 3.70%,
  // Nov 4.45 -> 3.45%) and only the interest/principal split walks
  // — prime is not priced at today's value for the whole loan, and
  // it does not recast the payment either.
  r = await H.req('POST', '/api/properties', {
    address: '9 Replay Road, Victoria, BC', mortgage_balance: 1350000,
    mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
  });
  const pidReplay = r.data.id;
  await H.req('POST', `/api/properties/${pidReplay}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  await H.req('PUT', `/api/properties/${pidReplay}`, { amortization_years: 25 });
  const replay = (await H.req('GET', `/api/properties/${pidReplay}/amortization`)).data;
  const replayRow = (m) => replay.series.find((x) => x.month === m) || {};
  H.check('replay: the payment is calculated at the start month\u2019s prime (4.45%), nothing entered',
    replay.ok === true
      && Math.abs(replay.paymentUsed - engineDerive(1350000, 4.45, 25)) < 0.02
      && replayRow('2025-01').rate === 4.45
      && replayRow('2025-01').interest === Math.round(1350000 * engineMonthlyRate(4.45) * 100) / 100,
    JSON.stringify({ used: replay.paymentUsed, first: replay.series && replay.series[0] }));
  H.check('replay: every month prices at its own prime but the payment never steps (fixed-payment variable)',
    replayRow('2025-02').rate === 4.2 && replayRow('2025-03').rate === 3.95
      && replayRow('2025-09').rate === 3.7 && replayRow('2025-11').rate === 3.45
      && replay.series.slice(0, -1).every((row) => row.payment === replay.paymentUsed)
      && replayRow('2025-03').interest === Math.round(replayRow('2025-02').balance * engineMonthlyRate(3.95) * 100) / 100,
    JSON.stringify(['2025-01', '2025-02', '2025-03', '2025-09', '2025-11']
      .map((m) => [m, replayRow(m).rate, replayRow(m).payment, replayRow(m).interest])));
  H.check('replay: the response states the pricing assumption (history for the past, latest known for the future, fixed payment)',
    typeof replay.primeAssumption === 'string'
      && replay.primeAssumption.includes('actual Bank of Canada prime history')
      && replay.primeAssumption.includes('4.95%')
      && replay.primeAssumption.includes('does not change when prime moves'),
    JSON.stringify(replay.primeAssumption));
  await H.req('DELETE', `/api/properties/${pidReplay}`);

  r = await H.req('POST', '/api/properties', { address: '1 Region Road', mortgage_balance: 1000, purchase_date: '2020-01-01', region: 'US' });
  H.check('a non-CA region is refused (Canada only for now)', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', { address: '2 Region Road', mortgage_balance: 1000, purchase_date: '2020-01-01', region: 'CA' });
  H.check('region CA is accepted and stored', r.status === 201 && r.data.region === 'CA', JSON.stringify(r.data.region));
  await H.req('DELETE', `/api/properties/${r.data.id}`);
  await H.req('DELETE', `/api/properties/${pidPrime}`);

  // ---- Mortgage terms: migration, renewal, lump sums ----
  // The legacy pre-seed (property '1 Legacy Lane': one old-shape
  // segment from 2025-01-01, no amortization, no lender) must have
  // been migrated into a Term 1 that mirrors the old model exactly.
  r = await H.req('GET', '/api/properties');
  const legacy1 = (r.data || []).find((p) => p.address === '1 Legacy Lane');
  H.check('legacy property migrated to a single Term 1',
    !!legacy1 && Array.isArray(legacy1.terms) && legacy1.terms.length === 1,
    JSON.stringify(legacy1 && legacy1.terms));
  H.check('Term 1 starts at the earliest segment, runs 60 months, opens with the balance',
    !!legacy1 && legacy1.terms[0].start_date === '2025-01-01' && legacy1.terms[0].term_months === 60
      && legacy1.terms[0].opening_balance === 0,
    JSON.stringify(legacy1 && legacy1.terms[0]));
  H.check('a missing amortization migrates to the flagged 25-year default',
    !!legacy1 && legacy1.terms[0].amortization_years === 25 && legacy1.terms[0].amortization_defaulted === 1,
    JSON.stringify(legacy1 && legacy1.terms[0]));
  H.check('legacy segments were assigned to Term 1',
    !!legacy1 && legacy1.segments.length === 1 && legacy1.segments[0].term_id === legacy1.terms[0].id,
    JSON.stringify(legacy1 && legacy1.segments));

  // His real shape, end to end over the terms model (stub prime is
  // 4.95 here): balance 1,350,000 dated 2024-12-17, one Prime - 1
  // segment, amortization 30 arriving later via the Mortgage form.
  r = await H.req('POST', '/api/properties', {
    address: '55 Term Test Terrace, Victoria, BC',
    mortgage_balance: 1350000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17',
  });
  S.termPid = r.data.id;
  H.check('a new property starts with exactly one term',
    Array.isArray(r.data.terms) && r.data.terms.length === 1, JSON.stringify(r.data.terms));
  H.check('Term 1 opens on the balance date with the balance, 60 months, amortization unset',
    r.data.terms[0].start_date === '2024-12-17' && r.data.terms[0].term_months === 60
      && r.data.terms[0].amortization_years === null && r.data.terms[0].opening_balance === 1350000,
    JSON.stringify(r.data.terms[0]));
  S.term1Id = r.data.terms[0].id;
  r = await H.req('POST', `/api/properties/${S.termPid}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1,
  });
  H.check('a segment added without a term lands in Term 1',
    r.status === 201 && r.data.term_id === S.term1Id, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${S.termPid}/amortization`);
  H.check('a term with no amortization is NO_PAYMENT',
    r.data.ok === false && r.data.code === 'NO_PAYMENT', JSON.stringify(r.data.code));
  r = await H.req('PUT', `/api/properties/${S.termPid}`, { amortization_years: 30, lender: 'RBC' });
  H.check('property-level amortization + lender write through to the current term',
    r.data.amortization_years === 30 && r.data.lender === 'RBC'
      && r.data.terms[0].amortization_years === 30 && r.data.terms[0].lender === 'RBC',
    JSON.stringify({ lender: r.data.lender, term: r.data.terms && r.data.terms[0] }));
  const projT1 = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  H.check('the term projection calculates its payment at the start month\u2019s prime (5.45 - 1 = 4.45%, 30y)',
    projT1.ok === true
      && Math.abs(projT1.paymentUsed - engineDerive(1350000, 4.45, 30)) < 0.5,
    JSON.stringify({ used: projT1.paymentUsed }));
  // Projection equivalence, locked: the series equals the engine's
  // term schedule for the same inputs (same stub prime history), to
  // the row — pricing every month at its own prime, payment fixed.
  const engineRun = engineSchedule({
    balance: 1350000, balanceDate: '2024-12-17',
    terms: [{ id: S.term1Id, start_date: '2024-12-17', amortization_years: 30 }],
    segments: [{ start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1 }],
    primeHistory: [...H.stubPrimeHistory, { date: '2026-10-21', rate: H.flags.prime }],
  });
  H.check('single-term projection is month-by-month identical to the engine schedule',
    JSON.stringify(projT1.series) === JSON.stringify(engineRun.series)
      && projT1.totalInterest === engineRun.totalInterest && projT1.payoffMonth === engineRun.payoffMonth,
    JSON.stringify({ rows: projT1.series && projT1.series.length, ti: projT1.totalInterest }));

  // Renewal: prefilled from Term 1 (start = day after it ends,
  // opening = its projected end balance, amortization left unset).
  r = await H.req('POST', `/api/properties/${S.termPid}/terms`, {});
  H.check('renewal prefill: starts 2029-12-17 (day after Term 1 ends), amortization unset',
    r.status === 201 && r.data.start_date === '2029-12-17' && r.data.amortization_years === null
      && r.data.term_months === 60,
    JSON.stringify(r.data));
  S.term2Id = r.data.id;
  const projCarry = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  const novRow = projCarry.series.find((x) => x.month === '2029-11');
  H.check('renewal opening balance is Term 1\u2019s projected end balance',
    !!novRow && Math.abs(r.data.opening_balance - novRow.balance) < 0.02,
    JSON.stringify({ opening: r.data.opening_balance, nov: novRow && novRow.balance }));
  const decCarry = projCarry.series.find((x) => x.month === '2029-12');
  H.check('with no amortization on Term 2 the running payment carries over the boundary unchanged',
    !!decCarry && !!novRow && Math.abs(decCarry.payment - novRow.payment) < 0.02,
    JSON.stringify({ dec: decCarry && decCarry.payment, nov: novRow && novRow.payment }));
  r = await H.req('PUT', `/api/properties/${S.termPid}/terms/${S.term2Id}`, { amortization_years: 25, lender: 'TD' });
  H.check('Term 2 updated in place (new lender, fresh amortization)',
    r.status === 200 && r.data.lender === 'TD' && r.data.amortization_years === 25,
    JSON.stringify(r.data));
  const projT2 = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  const nov2 = projT2.series.find((x) => x.month === '2029-11');
  const dec2 = projT2.series.find((x) => x.month === '2029-12');
  H.check('the projection is continuous across the term boundary (no balance jump)',
    !!nov2 && !!dec2 && Math.abs(dec2.balance - (nov2.balance + dec2.interest - dec2.payment)) < 0.02
      && Math.abs(dec2.interest - Math.round(nov2.balance * engineMonthlyRate(3.95) * 100) / 100) < 0.02,
    JSON.stringify({ nov: nov2 && nov2.balance, dec: dec2 }));
  H.check('the payment jumps at the boundary to the new term\u2019s amortization (25y)',
    !!dec2 && Math.abs(dec2.payment - engineDerive(nov2.balance, 3.95, 25)) < 0.02
      && Math.abs(dec2.payment - projT2.paymentUsed) > 1,
    JSON.stringify({ decPay: dec2 && dec2.payment, t1Pay: projT2.paymentUsed }));

  // Lump sum: deducts first; the payment does NOT change (bank
  // standard) — the smaller balance just pays off sooner inside
  // the running term, and at the renewal the benefit reappears as
  // a lower re-derived Term 2 payment.
  const projPreLump = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  // The lump lands in May 2025, priced at March's prime step
  // (4.95 - 1 = 3.95%) — the interest check below is hand-computed
  // at that rate, and the payment around it must be exactly the
  // running payment (prime moves never recast it either).
  r = await H.req('POST', `/api/properties/${S.termPid}/lump-sums`, { date: '2025-05-10', amount: 50000, note: 'Bonus' });
  H.check('lump sum created in the term active on its date',
    r.status === 201 && r.data.term_id === S.term1Id && r.data.amount === 50000, JSON.stringify(r.data));
  const lumpId = r.data.id;
  const projLump = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  const aprPre = projPreLump.series.find((x) => x.month === '2025-04');
  const aprPost = projLump.series.find((x) => x.month === '2025-04');
  const mayPost = projLump.series.find((x) => x.month === '2025-05');
  H.check('months before the lump sum are unchanged',
    JSON.stringify(aprPost) === JSON.stringify(aprPre), JSON.stringify(aprPost));
  H.check('the lump month charges interest on the reduced balance (May prices at prime 4.95) and the payment is unchanged',
    !!mayPost && Math.abs(mayPost.interest - Math.round((aprPost.balance - 50000) * engineMonthlyRate(3.95) * 100) / 100) < 0.02
      && Math.abs(mayPost.payment - aprPre.payment) < 0.02,
    JSON.stringify(mayPost));
  // The payoff inside Term 1 pulls in, but the renewal re-derives
  // Term 2's payment on its own fresh amortization — so end to end
  // the lump's certain effects are materially less total interest
  // and a lower payment from the renewal on, not a changed Term 1
  // payment or an earlier final payoff.
  const decPreLump = projPreLump.series.find((x) => x.month === '2029-12');
  const decPostLump = projLump.series.find((x) => x.month === '2029-12');
  H.check('the lump sum cuts the total interest and lowers the payment re-derived at the renewal',
    projLump.totalInterest < projPreLump.totalInterest - 10000
      && !!decPreLump && !!decPostLump && decPostLump.payment < decPreLump.payment - 100,
    JSON.stringify({
      interestBefore: projPreLump.totalInterest, interestAfter: projLump.totalInterest,
      decBefore: decPreLump && decPreLump.payment, decAfter: decPostLump && decPostLump.payment,
    }));
  r = await H.req('DELETE', `/api/properties/${S.termPid}/lump-sums/${lumpId}`);
  const projLumpGone = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  H.check('deleting the lump sum restores the previous projection',
    r.status === 200 && JSON.stringify(projLumpGone.series) === JSON.stringify(projPreLump.series));

  // The monthly payment is always calculated first; it cannot be
  // entered at the PROPERTY level at all (the property write paths
  // refuse it with a 400 — a contract error, never silently
  // swallowed), and a term-level override must be a positive
  // number (an invalid one is a 400 too). The dedicated override
  // section below exercises the valid writes; here the projection
  // stays the calculated one throughout.
  r = await H.req('PUT', `/api/properties/${S.termPid}`, { mortgage_payment: 7000 });
  H.check('entering a monthly payment on the property is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('calculated automatically'),
    JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', {
    address: '1 No Payment Entry Road', mortgage_balance: 1000, purchase_date: '2020-01-01', mortgage_payment: 100,
  });
  H.check('creating a property with a monthly payment is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('calculated automatically'),
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${S.termPid}/terms`, { payment_override: -100 });
  H.check('creating a term with a non-positive payment override is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('greater than 0'),
    JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${S.termPid}/terms/${S.term2Id}`, { payment_override: 0 });
  H.check('editing a term with a zero payment override is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('greater than 0'),
    JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${S.termPid}/terms/${S.term2Id}`, { payment_override: 'abc' });
  H.check('editing a term with a non-numeric payment override is refused (400)',
    r.status === 400 && String(r.data.error || '').includes('greater than 0'),
    JSON.stringify(r.data));
  const projCalc = (await H.req('GET', `/api/properties/${S.termPid}/amortization`)).data;
  const novCalc = projCalc.series.find((x) => x.month === '2029-11');
  const decCalc = projCalc.series.find((x) => x.month === '2029-12');
  H.check('the projection stays the calculated one in both terms (Term 2 re-derived at the renewal)',
    Math.abs(projCalc.paymentUsed - engineDerive(1350000, 4.45, 30)) < 0.5
      && !!decCalc && !!novCalc && Math.abs(decCalc.payment - engineDerive(novCalc.balance, 3.95, 25)) < 0.02,
    JSON.stringify({ used: projCalc.paymentUsed, dec: decCalc && decCalc.payment }));

  // ---- Term payment override (API) ----
  // The engine derives the payment first (the baseline); a term
  // may then carry an override that runs the term on that fixed
  // payment instead. Fixture: $100,000 at 5% fixed over 25y —
  // derived $581.60 (payoff 2051-02, interest $74,482.97);
  // override $700 (payoff 2044-02, interest $51,293.17) — the
  // engine unit tests anchor both trajectories.
  r = await H.req('POST', '/api/properties', {
    address: '9 Override Court, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-01', purchase_date: '2025-06-01', amortization_years: 25,
  });
  const ovPid = r.data.id;
  const ovTermId = r.data.terms[0].id;
  await H.req('POST', `/api/properties/${ovPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  const ovBase = (await H.req('GET', `/api/properties/${ovPid}/amortization`)).data;
  H.check('override fixture: the baseline triple is the derived payment, not overridden',
    ovBase.paymentUsed === 581.6 && ovBase.paymentDerived === 581.6 && ovBase.paymentOverridden === false
      && ovBase.payoffMonth === '2051-02' && ovBase.totalInterest === 74482.97,
    JSON.stringify({ u: ovBase.paymentUsed, d: ovBase.paymentDerived, o: ovBase.paymentOverridden }));
  r = await H.req('PUT', `/api/properties/${ovPid}/terms/${ovTermId}`, { payment_override: 700 });
  H.check('a term payment_override write succeeds (200), stores the value and serves the term triple',
    r.status === 200 && r.data.payment_override === 700
      && r.data.paymentUsed === 700 && r.data.paymentDerived === 581.6 && r.data.paymentOverridden === true,
    JSON.stringify(r.data));
  const ovProj = (await H.req('GET', `/api/properties/${ovPid}/amortization`)).data;
  H.check('the projection runs on the override (used 700, derived 581.60 beside it, payoff 2044-02, interest 51,293.17)',
    ovProj.paymentUsed === 700 && ovProj.paymentDerived === 581.6 && ovProj.paymentOverridden === true
      && ovProj.payoffMonth === '2044-02' && ovProj.totalInterest === 51293.17
      && ovProj.series[0].payment === 700 && ovProj.series[0].principal === 287.61,
    JSON.stringify({ u: ovProj.paymentUsed, d: ovProj.paymentDerived, p: ovProj.payoffMonth, i: ovProj.totalInterest }));
  const ovEngine = engineSchedule({
    balance: 100000, balanceDate: '2026-01-01',
    terms: [{ id: ovTermId, start_date: '2026-01-01', amortization_years: 25, payment_override: 700 }],
    segments: [{ id: 1, start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 }],
  });
  H.check('the override trajectory matches the engine run to the row',
    JSON.stringify(ovProj.series) === JSON.stringify(ovEngine.series));
  const ovProp = (await H.req('GET', `/api/properties/${ovPid}`)).data;
  H.check('the property payload serves the triple at property level and term level',
    ovProp.paymentUsed === 700 && ovProp.paymentDerived === 581.6 && ovProp.paymentOverridden === true
      && ovProp.terms[0].paymentUsed === 700 && ovProp.terms[0].paymentDerived === 581.6 && ovProp.terms[0].paymentOverridden === true,
    JSON.stringify({ u: ovProp.paymentUsed, d: ovProp.paymentDerived, o: ovProp.paymentOverridden }));
  const ovPort = (await H.req('GET', '/api/properties/portfolio')).data;
  const ovRow = ovPort.properties.find((x) => x.id === ovPid);
  H.check('the portfolio row serves the used payment with its derived beside it (the total sums used values)',
    !!ovRow && ovRow.monthlyPayment === 700 && ovRow.paymentDerived === 581.6 && ovRow.paymentOverridden === true,
    JSON.stringify(ovRow));
  r = await H.req('POST', `/api/properties/${ovPid}/preview`, { start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 4.5, term_id: ovTermId });
  H.check('the plan preview inside an overridden term previews the override payment with the derived beside it',
    r.data.ok === true && r.data.payment === 700 && r.data.paymentOverridden === true
      && r.data.paymentDerived !== 700 && r.data.paymentDerived > 0,
    JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${ovPid}/terms/${ovTermId}`, { payment_override: null });
  const ovCleared = (await H.req('GET', `/api/properties/${ovPid}/amortization`)).data;
  H.check('clearing the override restores the pure-derived schedule to the cent',
    r.status === 200 && r.data.payment_override === null
      && ovCleared.paymentUsed === 581.6 && ovCleared.paymentDerived === 581.6 && ovCleared.paymentOverridden === false
      && JSON.stringify(ovCleared.series) === JSON.stringify(ovBase.series)
      && ovCleared.totalInterest === ovBase.totalInterest,
    JSON.stringify({ u: ovCleared.paymentUsed, o: ovCleared.paymentOverridden }));
  await H.req('DELETE', `/api/properties/${ovPid}`);

  // ---- Segment compounding (API) ----
  // Each segment carries its own compounding convention:
  // 'semi_annual' (the default — every pre-existing segment) or
  // 'monthly'. Interest and payment derivation both price under
  // the segment's own convention.
  r = await H.req('POST', '/api/properties', {
    address: '11 Compounding Crescent, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-01', purchase_date: '2025-06-01', amortization_years: 25,
  });
  const cmpPid = r.data.id;
  r = await H.req('POST', `/api/properties/${cmpPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5, compounding: 'weekly' });
  H.check('an invalid compounding value is a 400',
    r.status === 400 && String(r.data.error || '').includes('compounding'), JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${cmpPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  H.check('a segment created without compounding defaults to semi_annual (the serializer carries it)',
    r.status === 201 && r.data.compounding === 'semi_annual', JSON.stringify(r.data));
  const cmpSegId = r.data.id;
  const cmpBase = (await H.req('GET', `/api/properties/${cmpPid}/amortization`)).data;
  H.check('compounding fixture baseline: semi-annual interest 412.39 and derived payment 581.60',
    cmpBase.series[0].interest === 412.39 && cmpBase.paymentUsed === 581.6,
    JSON.stringify({ i: cmpBase.series[0].interest, p: cmpBase.paymentUsed }));
  r = await H.req('PUT', `/api/properties/${cmpPid}/rates/${cmpSegId}`, { compounding: 'monthly' });
  H.check('a segment compounding write succeeds (200) and the serializer carries monthly',
    r.status === 200 && r.data.compounding === 'monthly', JSON.stringify(r.data));
  const cmpMonthly = (await H.req('GET', `/api/properties/${cmpPid}/amortization`)).data;
  H.check('the projection reprices monthly: first interest 416.67 (100,000 x 5%/12), derived payment follows the convention',
    cmpMonthly.series[0].interest === 416.67
      && cmpMonthly.paymentUsed === engineDerive(100000, 5, 25, 'monthly')
      && cmpMonthly.paymentUsed !== cmpBase.paymentUsed,
    JSON.stringify({ i: cmpMonthly.series[0].interest, p: cmpMonthly.paymentUsed }));
  const cmpProp = (await H.req('GET', `/api/properties/${cmpPid}`)).data;
  H.check('the property payload segment carries the compounding',
    cmpProp.segments[0].compounding === 'monthly', JSON.stringify(cmpProp.segments[0]));
  r = await H.req('PUT', `/api/properties/${cmpPid}/rates/${cmpSegId}`, { compounding: 'semi_annual' });
  const cmpBack = (await H.req('GET', `/api/properties/${cmpPid}/amortization`)).data;
  H.check('flipping back to semi_annual restores the baseline projection to the row',
    r.status === 200 && JSON.stringify(cmpBack.series) === JSON.stringify(cmpBase.series)
      && cmpBack.paymentUsed === cmpBase.paymentUsed,
    JSON.stringify({ p: cmpBack.paymentUsed }));
  r = await H.req('POST', `/api/properties/${cmpPid}/preview`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5, compounding: 'monthly' });
  H.check('a preview draft prices under its own compounding (monthly interest 416.67) while the saved segment stays semi-annual',
    r.data.ok === true && r.data.interest === 416.67, JSON.stringify(r.data));
  const cmpAfterPreview = (await H.req('GET', `/api/properties/${cmpPid}`)).data;
  H.check('the preview wrote nothing (saved segment still semi_annual)',
    cmpAfterPreview.segments[0].compounding === 'semi_annual', JSON.stringify(cmpAfterPreview.segments[0]));
  await H.req('DELETE', `/api/properties/${cmpPid}`);

  // ---- Segment Locked on (API) ----
  // The pricing anchor is a property of the RATE: a prime-spread
  // segment may carry locked_on, the date its rate was locked,
  // and derivations the segment governs price prime as of that
  // date. His real shape: $1,450,000 opening with the $100,000
  // month-1 lump folding it to $1,350,000, Prime - 1
  // monthly-compounded, 30y. Blank derives at the start month's
  // prime (Dec 2024 month-end 5.45 -> 4.45%) = $6,800.20; a
  // segment locked on 2024-12-10 (prime still 5.95 -> 4.95%) =
  // the commitment letter's $7,205.89. Accrual never reads the
  // lock: the override trajectory stays the verified one
  // (2026-05 $1,298,221.75 / 2026-09 $1,284,262.85). The retired
  // term-level pricing date is gone from term payloads entirely
  // and ignored on write.
  r = await H.req('POST', '/api/properties', {
    address: '12 Pricing Date Place, Victoria, BC',
    mortgage_balance: 1450000, mortgage_balance_date: '2024-12-17', purchase_date: '2024-12-17', amortization_years: 30,
  });
  const pdPid = r.data.id;
  const pdTermId = r.data.terms[0].id;
  const pdSeg = await H.req('POST', `/api/properties/${pdPid}/rates`, {
    start_date: '2024-12-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, compounding: 'monthly',
  });
  const pdSegId = pdSeg.data.id;
  await H.req('POST', `/api/properties/${pdPid}/lump-sums`, { date: '2024-12-20', amount: 100000 });
  const pdBlank = (await H.req('GET', `/api/properties/${pdPid}/amortization`)).data;
  H.check('locked on blank: the payment derives at the start month’s prime (4.45%, monthly) = 6,800.20, the segment carries no lock and the term payload has no pricing-date field',
    pdBlank.paymentDerived === 6800.2 && pdBlank.paymentUsed === 6800.2
      && (pdSeg.data.locked_on ?? null) === null
      && !('payment_pricing_date' in r.data.terms[0]),
    JSON.stringify({ d: pdBlank.paymentDerived, stored: pdSeg.data.locked_on }));
  r = await H.req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: '2024-13-40' });
  H.check('an invalid locked on date is a 400', r.status === 400 && String(r.data.error || '').includes('locked on'),
    JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${pdPid}/rates`, { start_date: '2025-06-17', rate_type: 'variable', rate_mode: 'prime_spread', spread: -1, locked_on: '2024-02-30' });
  H.check('creating a segment with an invalid locked on date is a 400 too',
    r.status === 400 && String(r.data.error || '').includes('locked on'), JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: '2024-12-10' });
  const pdLockedProj = (await H.req('GET', `/api/properties/${pdPid}/amortization`)).data;
  H.check('setting locked_on succeeds (200), echoes on the segment and re-derives the payment at that date’s prime (4.95%) = 7,205.89',
    r.status === 200 && r.data.locked_on === '2024-12-10'
      && pdLockedProj.paymentDerived === 7205.89 && pdLockedProj.paymentUsed === 7205.89 && pdLockedProj.paymentOverridden === false,
    JSON.stringify({ stored: r.data.locked_on, d: pdLockedProj.paymentDerived, u: pdLockedProj.paymentUsed }));
  H.check('the projection derives 7,205.89 with the lock set (and the first month still charges at the real 4.45%)',
    pdLockedProj.paymentDerived === 7205.89 && pdLockedProj.series[0].rate === 4.45,
    JSON.stringify({ d: pdLockedProj.paymentDerived, rate: pdLockedProj.series[0] && pdLockedProj.series[0].rate }));
  r = await H.req('PUT', `/api/properties/${pdPid}/terms/${pdTermId}`, { payment_override: 7207.10 });
  const pdOv = (await H.req('GET', `/api/properties/${pdPid}/amortization`)).data;
  const pdBal = (m) => (pdOv.series.find((x) => x.month === m) || {}).balance;
  H.check('lock + override: used 7,207.10, locked derived 7,205.89 beside it, trajectory the verified one',
    r.status === 200 && pdOv.paymentUsed === 7207.1 && pdOv.paymentDerived === 7205.89 && pdOv.paymentOverridden === true
      && pdBal('2026-05') === 1298221.75 && pdBal('2026-09') === 1284262.85,
    JSON.stringify({ u: pdOv.paymentUsed, d: pdOv.paymentDerived, may: pdBal('2026-05'), sep: pdBal('2026-09') }));
  r = await H.req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: '2024-12-20' });
  const pdAfterProj = (await H.req('GET', `/api/properties/${pdPid}/amortization`)).data;
  H.check('a lock date after the cut prices at the post-cut prime (derived back to 6,800.20) — resolution is by date',
    r.status === 200 && pdAfterProj.paymentDerived === 6800.2 && pdAfterProj.paymentUsed === 7207.1,
    JSON.stringify({ d: pdAfterProj.paymentDerived, u: pdAfterProj.paymentUsed }));
  r = await H.req('PUT', `/api/properties/${pdPid}/rates/${pdSegId}`, { locked_on: null });
  await H.req('PUT', `/api/properties/${pdPid}/terms/${pdTermId}`, { payment_override: null });
  const pdCleared = (await H.req('GET', `/api/properties/${pdPid}/amortization`)).data;
  H.check('clearing the lock restores the blank derivation to the cent',
    r.status === 200 && r.data.locked_on === null
      && pdCleared.paymentDerived === 6800.2 && JSON.stringify(pdCleared.series) === JSON.stringify(pdBlank.series),
    JSON.stringify({ d: pdCleared.paymentDerived }));
  const pdProp = (await H.req('GET', `/api/properties/${pdPid}`)).data;
  H.check('the property payload echoes the (cleared) lock on the segment and no pricing-date field on the term',
    (pdProp.segments[0].locked_on ?? null) === null && !('payment_pricing_date' in pdProp.terms[0]),
    JSON.stringify({ seg: pdProp.segments[0].locked_on }));
  r = await H.req('PUT', `/api/properties/${pdPid}/terms/${pdTermId}`, { payment_pricing_date: '2024-12-10' });
  const pdIgnored = (await H.req('GET', `/api/properties/${pdPid}/amortization`)).data;
  H.check('the retired term-level pricing date is ignored on write (200, never echoed, derivation unchanged)',
    r.status === 200 && !('payment_pricing_date' in r.data) && pdIgnored.paymentDerived === 6800.2,
    JSON.stringify({ d: pdIgnored.paymentDerived }));
  await H.req('DELETE', `/api/properties/${pdPid}`);

  // ---- Segment accrual (API) ----
  // accrual: 'monthly' (the default — the period's converted
  // rate; every existing segment) or 'daily' (the nominal annual
  // rate summed over the period's actual days). Validation and
  // echo mirror compounding. $100,000 at 3.65% fixed from
  // 2026-01-15: the first period (Jan 15, Feb 15] is 31 days —
  // $310.00 daily vs $304.17 monthly-compounded.
  r = await H.req('POST', '/api/properties', {
    address: '14 Accrual Avenue, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-15', purchase_date: '2026-01-15', amortization_years: 25,
  });
  const acPid = r.data.id;
  r = await H.req('POST', `/api/properties/${acPid}/rates`, { start_date: '2026-01-15', rate_type: 'fixed', annual_rate: 3.65, compounding: 'monthly' });
  H.check('a segment created without accrual reads monthly', r.status === 201 && r.data.accrual === 'monthly',
    JSON.stringify(r.data.accrual));
  const acSegId = r.data.id;
  r = await H.req('POST', `/api/properties/${acPid}/rates`, { start_date: '2026-06-15', rate_type: 'fixed', annual_rate: 3.65, accrual: 'weekly' });
  H.check('an invalid accrual is a 400', r.status === 400 && String(r.data.error || '').includes('accrual'),
    JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${acPid}/rates/${acSegId}`, { accrual: 'daily' });
  H.check('setting accrual=daily succeeds (200) and echoes on the segment',
    r.status === 200 && r.data.accrual === 'daily', JSON.stringify(r.data.accrual));
  const acDaily = (await H.req('GET', `/api/properties/${acPid}/amortization`)).data;
  H.check('daily accrual charges the first period at the nominal rate over its 31 days ($310.00)',
    acDaily.series.length > 0 && acDaily.series[0].interest === 310,
    JSON.stringify(acDaily.series[0] && acDaily.series[0].interest));
  r = await H.req('PUT', `/api/properties/${acPid}/rates/${acSegId}`, { accrual: 'monthly' });
  const acMonthly = (await H.req('GET', `/api/properties/${acPid}/amortization`)).data;
  H.check('back to monthly accrual the first period converts as before ($304.17), derivation unchanged',
    r.status === 200 && acMonthly.series[0].interest === 304.17
      && acMonthly.paymentDerived === acDaily.paymentDerived,
    JSON.stringify({ i: acMonthly.series[0] && acMonthly.series[0].interest, d: acMonthly.paymentDerived, dd: acDaily.paymentDerived }));
  await H.req('DELETE', `/api/properties/${acPid}`);

  // ---- Equity (API) ----
  // One definition app-wide: equity = latest assessed value -
  // current remaining balance; a property with no mortgage
  // counts a balance of 0. The anchor fixture mirrors the
  // user's real figures: assessed 1,931,000 with a remaining
  // balance of 1,280,775 (an unprojected anchor — no rate plan —
  // so the remaining balance IS the anchor) -> equity 650,225.
  r = await H.req('POST', '/api/properties', {
    address: '2985 Equity Anchor Way, Coquitlam, BC',
    mortgage_balance: 1280775, mortgage_balance_date: '2026-10-01', purchase_date: '2024-12-17',
    assessed_value: 1931000, assessed_year: 2026,
  });
  S.eqPid = r.data.id;
  r = await H.req('GET', `/api/properties/${S.eqPid}/equity`);
  H.check('equity endpoint: 1,931,000 - 1,280,775 = 650,225',
    r.data.equity === 650225 && r.data.balance === 1280775 && r.data.assessedValue === 1931000,
    JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', { address: '1 No Assessed Lane, Victoria, BC', purchase_date: '2024-01-01' });
  S.eqBarePid = r.data.id;
  const pfEq = (await H.req('GET', '/api/properties/portfolio')).data;
  const pfEqRow = pfEq.properties.find((x) => x.id === S.eqPid);
  const pfBareRow = pfEq.properties.find((x) => x.id === S.eqBarePid);
  H.check('portfolio per-property equity carries the same figure; a property without an assessed value has null equity',
    !!pfEqRow && pfEqRow.equity === 650225 && !!pfBareRow && pfBareRow.equity === null,
    JSON.stringify({ eq: pfEqRow && pfEqRow.equity, bare: pfBareRow && pfBareRow.equity }));
  H.check('portfolio totals: equity is the sum over assessed properties only, exclusions counted',
    Math.abs(pfEq.totals.equity - pfEq.properties.reduce((s, x) => s + (x.equity || 0), 0)) < 0.005
      && pfEq.totals.equityExcluded === pfEq.properties.filter((x) => x.equity === null).length
      && pfEq.totals.equityCount + pfEq.totals.equityExcluded === pfEq.totals.propertyCount
      && pfEq.totals.equity >= 650225,
    JSON.stringify(pfEq.totals));

  // ---- Property costs (API) ----
}

runModuleMain(import.meta.url, { name: 'core', deps, depNames: [], run });
