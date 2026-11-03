// terms: Per-term payment schedule + balance anchors + previews — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-terms.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only terms]
import { simulate as engineSimulate, derivePayment as engineDerive, monthlyRate as engineMonthlyRate, buildSchedule as engineSchedule } from '../src/engine.js';
import { runModuleMain } from './e2e-child.mjs';
import { run as runCore } from './e2e-core.mjs';
export const deps = [runCore];
export async function run(H, S) {
  let r;
  // The frequency and payment day live on each term now.
  r = await H.req('PUT', `/api/properties/${S.termPid}/terms/${S.term2Id}`, { payment_frequency: 'daily' });
  H.check('an unknown term payment frequency is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${S.termPid}/terms/${S.term2Id}`, { anchor_balance: 100 });
  H.check('an anchor balance without its date is a 400', r.status === 400, JSON.stringify(r.data));

  // A term's own frequency + day drive its span; the property PUT
  // still writes the schedule through to every term, so a
  // property-level edit keeps its whole-mortgage meaning.
  r = await H.req('POST', '/api/properties', {
    address: '8 Term Schedule Way, Victoria, BC',
    mortgage_balance: 100000, mortgage_balance_date: '2026-01-15', purchase_date: '2020-01-01',
  });
  const pidTs = r.data.id;
  const tsTermId = r.data.terms[0].id;
  await H.req('POST', `/api/properties/${pidTs}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  await H.req('PUT', `/api/properties/${pidTs}`, { amortization_years: 25 });
  r = await H.req('PUT', `/api/properties/${pidTs}/terms/${tsTermId}`, { payment_day: 1, payment_frequency: 'semi_monthly' });
  H.check('a term accepts its own frequency + payment day',
    r.status === 200 && r.data.payment_frequency === 'semi_monthly' && r.data.payment_day === 1,
    JSON.stringify(r.data).slice(0, 160));
  r = await H.req('GET', `/api/properties/${pidTs}/amortization`);
  H.check('the term schedule drives the projection (semi-monthly on the term\u2019s day: periods on the 1st and 16th)',
    r.data.frequency === 'semi_monthly' && r.data.series[0].date === '2026-02-16',
    JSON.stringify({ f: r.data.frequency, d: r.data.series && r.data.series[0] && r.data.series[0].date }));
  r = await H.req('PUT', `/api/properties/${pidTs}`, { payment_frequency: 'monthly', payment_day: null });
  H.check('property schedule PUT stored', r.status === 200 && r.data.payment_frequency === 'monthly');
  r = await H.req('GET', `/api/properties/${pidTs}/amortization`);
  H.check('the property-level schedule PUT writes through to the terms',
    r.data.frequency === 'monthly' && r.data.series[0].date === '2026-02-15',
    JSON.stringify({ f: r.data.frequency, d: r.data.series && r.data.series[0] && r.data.series[0].date }));
  await H.req('DELETE', `/api/properties/${pidTs}`);

  // In-term anchor: once the term starts before the balance date,
  // the anchor rides on that term; editing it there writes the
  // property anchor back, and the projection follows it. Merely
  // placing it changes nothing (same balance, same plan).
  r = await H.req('POST', '/api/properties', {
    address: '9 Anchor Court, Victoria, BC',
    mortgage_balance: 200000, mortgage_balance_date: '2026-06-15', purchase_date: '2020-01-01',
  });
  const pidAnchor = r.data.id;
  const anchorTermId = r.data.terms[0].id;
  await H.req('POST', `/api/properties/${pidAnchor}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 5 });
  await H.req('PUT', `/api/properties/${pidAnchor}/terms/${anchorTermId}`, { amortization_years: 25 });
  const anchorBefore = (await H.req('GET', `/api/properties/${pidAnchor}/amortization`)).data;
  r = await H.req('PUT', `/api/properties/${pidAnchor}/terms/${anchorTermId}`, { start_date: '2026-01-01' });
  H.check('moving the term start earlier puts the balance anchor on the term',
    r.status === 200 && r.data.anchor_date === '2026-06-15' && r.data.anchor_balance === 200000,
    JSON.stringify(r.data).slice(0, 200));
  const anchorAfter = (await H.req('GET', `/api/properties/${pidAnchor}/amortization`)).data;
  H.check('the projection is unchanged by the anchor placement (same balance, same plan)',
    JSON.stringify(anchorAfter.series) === JSON.stringify(anchorBefore.series)
      && anchorAfter.paymentUsed === anchorBefore.paymentUsed,
    JSON.stringify({ rows: anchorAfter.series && anchorAfter.series.length }));
  r = await H.req('PUT', `/api/properties/${pidAnchor}/terms/${anchorTermId}`, { anchor_balance: 195000, anchor_date: '2026-06-15' });
  H.check('editing the anchor on the term is accepted', r.status === 200 && r.data.anchor_balance === 195000,
    JSON.stringify(r.data).slice(0, 200));
  r = await H.req('GET', `/api/properties/${pidAnchor}`);
  H.check('the property anchor follows the term edit',
    r.data.mortgage_balance === 195000 && r.data.mortgage_balance_date === '2026-06-15',
    JSON.stringify({ b: r.data.mortgage_balance, d: r.data.mortgage_balance_date }));
  r = await H.req('GET', `/api/properties/${pidAnchor}/amortization`);
  H.check('the projection re-derives from the corrected anchor balance',
    Math.abs(r.data.paymentUsed - engineDerive(195000, 5, 25)) < 0.02, String(r.data.paymentUsed));
  await H.req('DELETE', `/api/properties/${pidAnchor}`);

  // Validation + term deletion rules.
  r = await H.req('POST', `/api/properties/${S.termPid}/terms`, { term_months: 121 });
  H.check('a term longer than 120 months is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${S.termPid}/terms`, { term_months: 0 });
  H.check('a zero-length term is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${S.termPid}/terms`, { amortization_years: 40 });
  H.check('a term amortization outside 1-35 is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${S.termPid}/lump-sums`, { date: '2025-01-01', amount: -5 });
  H.check('a negative lump sum is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${S.termPid}/lump-sums`, { date: '2025-01-01', amount: 100, term_id: 99999 });
  H.check('a lump sum naming a foreign term is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/properties/${S.termPid}/terms/${S.term2Id}`);
  H.check('deleting Term 2 leaves Term 1 standing',
    r.status === 200 && Array.isArray(r.data.terms) && r.data.terms.length === 1, JSON.stringify(r.data.terms));
  r = await H.req('DELETE', `/api/properties/${S.termPid}/terms/${S.term1Id}`);
  H.check('the last remaining term cannot be deleted', r.status === 400, JSON.stringify(r.data));
  await H.req('DELETE', `/api/properties/${S.termPid}`);

  // ---- Repayment method (equal principal) + plan preview ----
  // The hand-computed fixture from the engine tests, end to end:
  // $120,000 at 6% fixed, 10-year amortization. Equal principal:
  // $1,000 of principal every month, first interest $592.63, first
  // payment $1,592.63, payoff exactly 120 months out (2036-01).
  r = await H.req('POST', '/api/properties', {
    address: '77 Equal Principal Parade, Victoria, BC',
    mortgage_balance: 120000, mortgage_balance_date: '2026-01-01', purchase_date: '2026-01-01',
  });
  const epPid = r.data.id;
  const epTermId = r.data.terms[0].id;
  H.check('a new term defaults to equal payment',
    r.data.terms[0].repayment_method === 'equal_payment', JSON.stringify(r.data.terms[0]));
  await H.req('PUT', `/api/properties/${epPid}`, { amortization_years: 10 });
  await H.req('POST', `/api/properties/${epPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 });
  r = await H.req('PUT', `/api/properties/${epPid}/terms/${epTermId}`, { repayment_method: 'bogus' });
  H.check('an unknown repayment method is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${epPid}/terms/${epTermId}`, { repayment_method: 'equal_principal' });
  H.check('the term takes the equal-principal method',
    r.status === 200 && r.data.repayment_method === 'equal_principal', JSON.stringify(r.data.repayment_method));
  const epProj = (await H.req('GET', `/api/properties/${epPid}/amortization`)).data;
  H.check('equal principal end to end: $1,000 principal a month, declining payments, payoff at the amortization end',
    epProj.ok === true && epProj.series.length === 120 && epProj.payoffMonth === '2036-01'
      && epProj.series.every((row) => row.principal === 1000)
      && epProj.series[0].interest === 592.63 && epProj.series[0].payment === 1592.63
      && epProj.paymentUsed === 1592.63
      && epProj.series.slice(0, 12).every((row, i, a) => i === 0 || row.payment < a[i - 1].payment),
    JSON.stringify({ used: epProj.paymentUsed, payoff: epProj.payoffMonth, first: epProj.series && epProj.series[0] }));
  r = await H.req('PUT', `/api/properties/${epPid}/terms/${epTermId}`, { repayment_method: 'equal_payment' });
  const epBack = (await H.req('GET', `/api/properties/${epPid}/amortization`)).data;
  H.check('switching back to equal payment restores one level payment',
    r.status === 200 && epBack.ok === true
      && Math.abs(epBack.paymentUsed - engineDerive(120000, 6, 10)) < 0.02
      && epBack.series.slice(0, -1).every((row) => row.payment === epBack.paymentUsed),
    JSON.stringify({ used: epBack.paymentUsed }));
  await H.req('DELETE', `/api/properties/${epPid}`);

  // Plan preview: a draft segment + the term's draft plan fields go
  // in, the plan's first month in effect comes out — computed by
  // the same engine, so it must equal the saved projection's row
  // for that month to the cent.
  r = await H.req('POST', '/api/properties', {
    address: '78 Preview Place, Victoria, BC',
    mortgage_balance: 120000, mortgage_balance_date: '2026-01-01', purchase_date: '2026-01-01',
  });
  const pvPid = r.data.id;
  const pvTermId = r.data.terms[0].id;
  await H.req('PUT', `/api/properties/${pvPid}`, { amortization_years: 10 });
  const pvDraft = {
    start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6,
    term_id: pvTermId, repayment_method: 'equal_principal',
  };
  r = await H.req('POST', `/api/properties/${pvPid}/preview`, pvDraft);
  H.check('preview: an equal-principal draft prices its first month (2026-02) before anything is saved',
    r.status === 200 && r.data.ok === true && r.data.month === '2026-02' && r.data.rate === 6
      && r.data.principal === 1000 && r.data.interest === 592.63 && r.data.payment === 1592.63
      && r.data.balance === 119000,
    JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${pvPid}`);
  H.check('the preview wrote nothing (no segment, method untouched)',
    r.data.segments.length === 0 && r.data.terms[0].repayment_method === 'equal_payment',
    JSON.stringify({ segs: r.data.segments.length, method: r.data.terms[0].repayment_method }));
  // Save exactly what was previewed: the projection's 2026-02 row
  // must be the previewed month, field for field.
  await H.req('POST', `/api/properties/${pvPid}/rates`, { start_date: '2026-01-01', rate_type: 'fixed', annual_rate: 6 });
  await H.req('PUT', `/api/properties/${pvPid}/terms/${pvTermId}`, { repayment_method: 'equal_principal' });
  const pvProj = (await H.req('GET', `/api/properties/${pvPid}/amortization`)).data;
  const pvRow = pvProj.series.find((x) => x.month === '2026-02') || {};
  H.check('the saved projection\u2019s first month equals the preview to the cent',
    pvRow.payment === 1592.63 && pvRow.interest === 592.63 && pvRow.principal === 1000
      && pvRow.balance === 119000 && pvRow.rate === 6,
    JSON.stringify(pvRow));
  // A changed draft re-prices live: same plan at 3% instead of 6%.
  r = await H.req('POST', `/api/properties/${pvPid}/preview`, { ...pvDraft, annual_rate: 3 });
  H.check('preview: editing the draft rate re-prices the first month (interest at 3%)',
    r.data.ok === true && r.data.rate === 3
      && r.data.interest === Math.round(120000 * engineMonthlyRate(3) * 100) / 100
      && r.data.payment === Math.round((1000 + 120000 * engineMonthlyRate(3)) * 100) / 100,
    JSON.stringify(r.data));
  // A mid-stream draft (a rate change next year) previews ITS first
  // month, not the projection's first month.
  r = await H.req('POST', `/api/properties/${pvPid}/preview`, {
    start_date: '2027-01-01', rate_type: 'fixed', annual_rate: 3,
    term_id: pvTermId, repayment_method: 'equal_principal',
  });
  const pvProjNow = (await H.req('GET', `/api/properties/${pvPid}/amortization`)).data;
  const decRow = pvProjNow.series.find((x) => x.month === '2026-12') || {};
  H.check('preview: a future-dated draft previews its own first month at its own rate',
    r.data.ok === true && r.data.month === '2027-01' && r.data.rate === 3 && r.data.principal === 1000
      && r.data.interest === Math.round(decRow.balance * engineMonthlyRate(3) * 100) / 100,
    JSON.stringify(r.data));
  await H.req('DELETE', `/api/properties/${pvPid}`);

  // ---- Property photo gallery ----
}

runModuleMain(import.meta.url, { name: 'terms', deps, depNames: ['core'], run });
