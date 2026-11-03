// costs: Property costs API + fill-chat + AI fill config — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-costs.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only costs]
import fs from 'node:fs';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // Yearly running costs: one row per (year, category), stored
  // in its recorded basis — a 'monthly' entry holds the monthly
  // average and counts ×12 in every annual figure the pivot
  // returns (cells, year totals, latest).
  r = await H.req('POST', '/api/properties', { address: '77 Costs Court, Victoria, BC', purchase_date: '2024-01-01' });
  const costPid = r.data.id;
  r = await H.req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Property tax', amount: 5400 });
  const costEntry = (view, cat, year) => (view.entries || []).find((e) => e.category === cat && e.year === year);
  H.check('create an annual cost entry (201, source manual by default)',
    r.status === 201 && !!costEntry(r.data, 'Property tax', 2026)
      && costEntry(r.data, 'Property tax', 2026).basis === 'annual'
      && costEntry(r.data, 'Property tax', 2026).source === 'manual',
    JSON.stringify(r.data).slice(0, 300));
  r = await H.req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Electricity', amount: 85, basis: 'monthly' });
  H.check('create a monthly-basis entry (the stored amount is the monthly average)',
    r.status === 201 && !!costEntry(r.data, 'Electricity', 2026)
      && costEntry(r.data, 'Electricity', 2026).amount === 85,
    JSON.stringify(r.data).slice(0, 300));
  const costElecId = costEntry(r.data, 'Electricity', 2026).id;
  r = await H.req('POST', `/api/properties/${costPid}/costs`, { year: 2025, category: 'Property tax', amount: 5100 });
  r = await H.req('GET', `/api/properties/${costPid}/costs`);
  H.check('the pivot annualizes monthly entries (85 × 12) in cells, totals and latest',
    r.status === 200 && r.data.entries.length === 3
      && r.data.latest.year === 2026 && r.data.latest.total === 6420
      && r.data.years.find((y) => y.year === 2026).cells.Electricity.annual === 1020
      && r.data.years.find((y) => y.year === 2025).total === 5100,
    JSON.stringify(r.data).slice(0, 400));
  r = await H.req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Electricity', amount: 90, basis: 'monthly' });
  H.check('POST on an existing (year, category) upserts instead of duplicating',
    r.status === 201 && r.data.entries.length === 3
      && costEntry(r.data, 'Electricity', 2026).amount === 90
      && r.data.latest.total === 6480,
    JSON.stringify(r.data).slice(0, 300));
  r = await H.req('PUT', `/api/properties/${costPid}/costs/${costElecId}`, { category: 'Property tax' });
  H.check('PUT onto a colliding (year, category) is a 400 naming the clash',
    r.status === 400 && String(r.data.error || '').includes('already exists'), JSON.stringify(r.data));
  r = await H.req('PUT', `/api/properties/${costPid}/costs/${costElecId}`, { amount: 95 });
  H.check('PUT edits the amount (basis kept), the year total follows',
    r.status === 200 && costEntry(r.data, 'Electricity', 2026).amount === 95
      && costEntry(r.data, 'Electricity', 2026).basis === 'monthly'
      && r.data.latest.total === 6540,
    JSON.stringify(r.data).slice(0, 300));
  r = await H.req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Water', amount: -5 });
  H.check('a negative amount is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${costPid}/costs`, { year: 2026, category: 'Water', amount: 5, basis: 'weekly' });
  H.check('an unknown basis is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/properties/${costPid}/costs/${costElecId}`);
  H.check('DELETE removes the entry and the total drops back',
    r.status === 200 && r.data.entries.length === 2 && r.data.latest.total === 5400,
    JSON.stringify(r.data).slice(0, 300));
  r = await H.req('DELETE', `/api/properties/${costPid}/costs/${costElecId}`);
  H.check('deleting a missing entry is a 404', r.status === 404, JSON.stringify(r.data));
  r = await H.req('GET', '/api/properties/999999/costs');
  H.check('costs of a missing property are a 404', r.status === 404, JSON.stringify(r.data));

  // ---- Property costs: monthly detail (API) ----
  // A monthly entry may carry the months actually recorded; the
  // stored amount is the average the SERVER computes from them —
  // a client-sent amount alongside the months is not trusted.
  r = await H.req('POST', '/api/properties', { address: '78 Monthly Detail Drive, Victoria, BC', purchase_date: '2024-01-01' });
  const mdPid = r.data.id;
  r = await H.req('POST', `/api/properties/${mdPid}/costs`, {
    year: 2026, category: 'Electricity', basis: 'monthly', amount: 999, monthlyAmounts: { 1: 80, 2: 90, 3: 85 },
  });
  H.check('POST monthly with monthlyAmounts: stored amount is the computed average (85), months ride along',
    r.status === 201 && !!costEntry(r.data, 'Electricity', 2026)
      && costEntry(r.data, 'Electricity', 2026).amount === 85
      && JSON.stringify(costEntry(r.data, 'Electricity', 2026).monthlyAmounts) === JSON.stringify({ '1': 80, '2': 90, '3': 85 })
      && r.data.years.find((y) => y.year === 2026).cells.Electricity.annual === 1020
      && JSON.stringify(r.data.years.find((y) => y.year === 2026).cells.Electricity.months.slice(0, 4)) === JSON.stringify([80, 90, 85, 85]),
    JSON.stringify(r.data).slice(0, 400));
  r = await H.req('POST', `/api/properties/${mdPid}/costs`, { year: 2026, category: 'Water', basis: 'monthly', monthlyAmounts: {} });
  H.check('an empty monthlyAmounts map is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${mdPid}/costs`, { year: 2026, category: 'Water', basis: 'monthly', monthlyAmounts: { 13: 5 } });
  H.check('an out-of-range month in monthlyAmounts is a 400', r.status === 400, JSON.stringify(r.data));
  const mdElecId = costEntry(
    (await H.req('GET', `/api/properties/${mdPid}/costs`)).data, 'Electricity', 2026).id;
  r = await H.req('PUT', `/api/properties/${mdPid}/costs/${mdElecId}`, { monthlyAmounts: { 5: 130 } });
  H.check('PUT with fresh monthlyAmounts replaces the months and recomputes the average (130)',
    r.status === 200 && costEntry(r.data, 'Electricity', 2026).amount === 130
      && JSON.stringify(costEntry(r.data, 'Electricity', 2026).monthlyAmounts) === JSON.stringify({ '5': 130 })
      && r.data.latest.total === 1560,
    JSON.stringify(r.data).slice(0, 300));
  r = await H.req('PUT', `/api/properties/${mdPid}/costs/${mdElecId}`, { notes: 'hydro' });
  H.check('PUT naming no figure keeps the stored months and average',
    r.status === 200 && costEntry(r.data, 'Electricity', 2026).amount === 130
      && JSON.stringify(costEntry(r.data, 'Electricity', 2026).monthlyAmounts) === JSON.stringify({ '5': 130 }),
    JSON.stringify(r.data).slice(0, 300));
  r = await H.req('POST', `/api/properties/${mdPid}/costs`, { year: 2025, category: 'Gas', amount: 60, basis: 'monthly' });
  H.check('POST monthly with a bare amount keeps the legacy form (monthlyAmounts null, no detail)',
    r.status === 201 && costEntry(r.data, 'Gas', 2025).amount === 60
      && costEntry(r.data, 'Gas', 2025).monthlyAmounts === null,
    JSON.stringify(r.data).slice(0, 300));
  await H.req('DELETE', `/api/properties/${mdPid}`);

  // ---- AI fill chat (API): the multi-turn flow ----
  // Round 1: the model asks about the year and proposes the one
  // entry it is sure of — a monthly-basis electricity figure.
  // Round 2: with the answer and the draft in the history, it
  // completes the proposal. The chat itself writes nothing.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Which year are these electricity bills for? The 3 bills (Jan $80, Feb $90, Mar $85) average $85/mo.',
    proposed: [{ year: 2026, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } }],
    ready: false,
  }));
  const chat1 = await H.req('POST', '/api/ai/fill-chat', {
    propertyId: costPid, history: [], text: 'electricity bills', proposed: [],
  });
  H.check('fill-chat round 1: asks a question and proposes the monthly entry month by month',
    chat1.status === 200 && chat1.data.ready === false
      && chat1.data.proposed.length === 1 && chat1.data.proposed[0].basis === 'monthly'
      && chat1.data.proposed[0].amount === 85
      && JSON.stringify(chat1.data.proposed[0].monthlyAmounts) === JSON.stringify({ '1': 80, '2': 90, '3': 85 }),
    JSON.stringify(chat1.data).slice(0, 300));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    reply: 'Recorded as 2026 figures.',
    proposed: [
      { year: 2026, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } },
      { year: 2026, category: 'Property tax', amount: 5400, basis: 'annual' },
    ],
    ready: true,
  }));
  const chat2 = await H.req('POST', '/api/ai/fill-chat', {
    propertyId: costPid,
    history: [
      { role: 'user', content: 'electricity bills' },
      { role: 'assistant', content: chat1.data.reply },
    ],
    text: '2026', proposed: chat1.data.proposed,
  });
  H.check('fill-chat round 2: the completed proposal comes back ready',
    chat2.status === 200 && chat2.data.ready === true && chat2.data.proposed.length === 2,
    JSON.stringify(chat2.data).slice(0, 300));
  r = await H.req('GET', `/api/properties/${costPid}/costs`);
  H.check('the chat wrote nothing by itself (only Apply lands entries)',
    r.data.entries.length === 2 && !costEntry(r.data, 'Electricity', 2026),
    JSON.stringify(r.data.entries.map((e) => e.category)));
  r = await H.req('POST', '/api/ai/fill-chat', { propertyId: 999999, text: 'x' });
  H.check('fill-chat for a missing property is a 404', r.status === 404, JSON.stringify(r.data));
  r = await H.req('POST', '/api/ai/fill-chat', { propertyId: costPid });
  H.check('fill-chat with no message and no files is a 400', r.status === 400, JSON.stringify(r.data));

  // ---- AI Fill (API) ----
  // The stubbed model answers with the RBC commitment-letter
  // fields in raw document shapes; the endpoint must normalize
  // them, expand the segment "kind" vocabulary into the segment
  // form's fields, and drop unknown keys. Extraction writes
  // nothing by itself.
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    fields: {
      lender: 'RBC', start_date: 'Dec 17, 2024', term_months: 60, amortization_years: 30,
      opening_balance: '$1,350,000', payment_override: 7207.10,
      segment_kind: 'prime_spread', spread: -1, segment_compounding: 'monthly',
      segment_start_date: '2024-12-17', not_a_field: 'drop me',
    },
  }));
  r = await H.req('POST', '/api/ai/fill', { context: 'term', text: 'RBC commitment letter' });
  H.check('AI fill returns the commitment fields normalized (kind expanded, unknown keys dropped)',
    r.status === 200 && r.data.fields.lender === 'RBC' && r.data.fields.start_date === '2024-12-17'
      && r.data.fields.term_months === 60 && r.data.fields.amortization_years === 30
      && r.data.fields.opening_balance === 1350000 && r.data.fields.payment_override === 7207.1
      && r.data.fields.segment_rate_type === 'variable' && r.data.fields.segment_rate_mode === 'prime_spread'
      && r.data.fields.segment_spread === -1 && r.data.fields.segment_compounding === 'monthly'
      && r.data.fields.segment_start_date === '2024-12-17' && !('not_a_field' in r.data.fields),
    JSON.stringify(r.data));
  r = await H.req('POST', '/api/ai/fill', { context: 'bogus', text: 'x' });
  H.check('AI fill rejects an unknown context (400)', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/ai/fill', { context: 'term' });
  H.check('AI fill requires text or a file (400)', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/ai/fill', { context: 'term', file: { name: 'a.docx', type: 'application/msword', data: 'aGk=' } });
  H.check('AI fill rejects a non-image/PDF/text attachment (400)', r.status === 400, JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ fields: { lender: 'RBC' } }));
  r = await H.req('POST', '/api/ai/fill', { context: 'term', text: 'letter' });
  H.check('the stub file is re-read per call (the next extraction sees the new response)',
    r.status === 200 && JSON.stringify(r.data.fields) === JSON.stringify({ lender: 'RBC' }), JSON.stringify(r.data));
  // ---- AI Fill model selection (API) ----
  // The server runs with LLM_MODELS=stub-a,stub-b and
  // LLM_MODEL=stub-a. The stub answers per model name, so the
  // response proves which model a fill ran with; the choice
  // persists server-side (app setting) as the next default.
  r = await H.req('GET', '/api/ai/config');
  H.check('AI config lists the env models with LLM_MODEL as the default',
    r.status === 200 && r.data.configured === true
      && JSON.stringify(r.data.models) === JSON.stringify(['stub-a', 'stub-b'])
      && r.data.model === 'stub-a', JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({
    models: { 'stub-a': { fields: { lender: 'Bank A' } }, 'stub-b': { fields: { lender: 'Bank B' } } },
  }));
  r = await H.req('POST', '/api/ai/fill', { context: 'term', text: 'letter', model: 'stub-c' });
  H.check('a model outside the configured list is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/ai/fill', { context: 'term', text: 'letter', model: 'stub-b' });
  H.check('a fill with model stub-b runs with stub-b (per-model stub response)',
    r.status === 200 && r.data.fields.lender === 'Bank B' && r.data.model === 'stub-b', JSON.stringify(r.data));
  r = await H.req('GET', '/api/ai/config');
  H.check('the chosen model persisted server-side as the new default',
    r.status === 200 && r.data.model === 'stub-b', JSON.stringify(r.data));
  r = await H.req('POST', '/api/ai/fill', { context: 'term', text: 'letter' });
  H.check('a fill without a model uses the persisted choice',
    r.status === 200 && r.data.fields.lender === 'Bank B' && r.data.model === 'stub-b', JSON.stringify(r.data));
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ fields: {} }));
}

runModuleMain(import.meta.url, { name: 'costs', deps, depNames: [], run });
