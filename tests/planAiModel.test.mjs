// AI design-model fixes: the model never asks the user for a database
// id (name picks only, bound server-side), repeated questions dedupe,
// answered questions drop, unbindable answers surface a mismatch with
// named candidates, and the thread pairs answers with their questions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAiAsk, aiAskEntityType, planAiEntityCandidates,
  rewriteAiIdQuestions, dropAnsweredAiQuestions, bindAiNameAnswers,
  renderAiThreadText,
} from '../src/planning.js';

const SNAP = {
  properties: [
    { id: 7, address: '2985 Christina Place, Coquitlam, BC' },
    { id: 9, address: '2881 Nash Drive, Coquitlam, BC' },
  ],
  terms: [
    { id: 3, property_id: 7, start_date: '2024-12-17' },
    { id: 4, property_id: 9, start_date: '2025-03-20' },
  ],
  accounts: [{ id: 2, name: 'Wealthsimple TFSA' }],
  holdings: [{ id: 5, symbol: 'XQQ.TO', label: 'iShares NASDAQ 100' }],
};
const CANDS = planAiEntityCandidates(SNAP);

test('normalizeAiAsk dedupes a repeated field (first wins) and still rejects malformed asks', () => {
  const qs = normalizeAiAsk([
    { field: 'property_id', label: 'Which property ID?', type: 'text' },
    { field: 'property_id', label: 'Which property ID again?', type: 'text' },
    { field: 'effective_date', label: 'Effective date?', type: 'date' },
  ]);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].label, 'Which property ID?');
  assert.equal(qs[1].field, 'effective_date');
  assert.equal(normalizeAiAsk([{ field: '', label: 'x' }]), null);
  assert.equal(normalizeAiAsk([]), null);
});

test('aiAskEntityType detects only real picks, not value fields mentioning an entity', () => {
  assert.equal(aiAskEntityType('property_id'), 'property');
  assert.equal(aiAskEntityType('property'), 'property');
  assert.equal(aiAskEntityType('term_id'), 'term');
  assert.equal(aiAskEntityType('account_name'), 'account');
  assert.equal(aiAskEntityType('holding'), 'holding');
  assert.equal(aiAskEntityType('property_tax_rate'), null);
  assert.equal(aiAskEntityType('target_contribution'), null);
  assert.equal(aiAskEntityType('effective_date'), null);
});

test('planAiEntityCandidates labels terms by property address + start date', () => {
  assert.deepEqual(CANDS.properties.map((c) => c.label), ['2985 Christina Place, Coquitlam, BC', '2881 Nash Drive, Coquitlam, BC']);
  assert.deepEqual(CANDS.terms.map((c) => c.label), ['2985 Christina Place, Coquitlam, BC · 2024-12-17', '2881 Nash Drive, Coquitlam, BC · 2025-03-20']);
  assert.equal(CANDS.holdings[0].label, 'XQQ.TO (iShares NASDAQ 100)');
});

test('rewriteAiIdQuestions turns id questions into name picks with candidates; name questions pass through', () => {
  const out = rewriteAiIdQuestions([
    { field: 'property_id', label: 'Which property ID corresponds to 2985 CHRISTINA PL COQUITLAM?', type: 'text' },
    { field: 'term_id', label: 'Which term ID?', type: 'text' },
    { field: 'effective_date', label: 'Effective date?', type: 'date' },
  ], CANDS);
  assert.equal(out[0].field, 'property');
  assert.match(out[0].label, /Choose by name: 2985 Christina Place, Coquitlam, BC; 2881 Nash Drive, Coquitlam, BC/);
  assert.equal(out[1].field, 'term');
  assert.match(out[1].label, /2024-12-17/);
  assert.equal(out[2].field, 'effective_date');
  assert.equal(out[2].label, 'Effective date?');
  assert.ok(!out.some((q) => /_id$/.test(q.field)));
});

test('dropAnsweredAiQuestions drops fields answered in the thread or the current payload', () => {
  const thread = [
    { role: 'ai', questions: [{ field: 'effective_date', label: 'Effective date?', type: 'date' }] },
    { role: 'user', answers: { effective_date: '2027-01-31' } },
  ];
  const out = dropAnsweredAiQuestions([
    { field: 'effective_date', label: 'Effective date?', type: 'date' },
    { field: 'fixed_rate', label: 'Fixed rate?', type: 'number' },
    { field: 'term', label: 'Which term?', type: 'text' },
  ], thread, { term: '2985 Christina Place, Coquitlam, BC · 2024-12-17' });
  assert.deepEqual(out.map((q) => q.field), ['fixed_rate']);
});

test('bindAiNameAnswers resolves exact, unique-substring, and legacy numeric-id answers', () => {
  let r = bindAiNameAnswers({ property: '2985 Christina Place, Coquitlam, BC' }, CANDS);
  assert.deepEqual(r.resolved, [{ field: 'property', entity: 'property', id: 7, label: '2985 Christina Place, Coquitlam, BC' }]);
  assert.deepEqual(r.mismatches, []);
  // The user's exact failure: "property_id = 2985" — a street number,
  // not an id — resolves by unique substring to the Christina property.
  r = bindAiNameAnswers({ property_id: '2985' }, CANDS);
  assert.deepEqual(r.resolved.map((x) => x.id), [7]);
  r = bindAiNameAnswers({ term_id: 3 }, CANDS);
  assert.deepEqual(r.resolved.map((x) => x.id), [3]);
  // Non-entity fields and blank values pass through untouched.
  r = bindAiNameAnswers({ fixed_rate: 4.2, effective_date: '2027-01-31', property: '' }, CANDS);
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.mismatches, []);
});

test('bindAiNameAnswers reports no-match and ambiguous mismatches with named candidates', () => {
  let r = bindAiNameAnswers({ property: 'No Such Place 123' }, CANDS);
  assert.equal(r.resolved.length, 0);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].ambiguous, false);
  assert.deepEqual(r.mismatches[0].candidates, ['2985 Christina Place, Coquitlam, BC', '2881 Nash Drive, Coquitlam, BC']);
  r = bindAiNameAnswers({ property: 'Coquitlam' }, CANDS);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].ambiguous, true);
  assert.equal(r.mismatches[0].candidates.length, 2);
});

test('renderAiThreadText pairs answers with their question labels, never key = value', () => {
  const text = renderAiThreadText([
    { role: 'ai', questions: [
      { field: 'property', label: 'Which property?', type: 'text' },
      { field: 'effective_date', label: 'Effective date?', type: 'date' },
    ] },
    { role: 'user', answers: { property: '2985 Christina Place, Coquitlam, BC', effective_date: '2027-01-31' } },
  ]);
  assert.match(text, /User answered "Which property\?": 2985 Christina Place, Coquitlam, BC/);
  assert.match(text, /User answered "Effective date\?": 2027-01-31/);
  assert.doesNotMatch(text, /property =/);
  assert.doesNotMatch(text, /effective_date =/);
  assert.doesNotMatch(text, /\(property\)/);
  // An answer with no preceding question renders the value alone.
  assert.equal(renderAiThreadText([{ role: 'user', answers: { note: 'hello' } }]), 'User answered: hello');
});
