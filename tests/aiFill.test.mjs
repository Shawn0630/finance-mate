// AI Fill: extraction-response validation / normalization, the
// endpoint's status contract (503 unconfigured, 400 bad input,
// 502 unreadable model output), and the PDF text extractor.
// The LLM call is injected — no network, no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAiFields, parseModelJson, handleAiFill, llmConfigured, extractPdfText,
  llmModels, llmDefaultModel, callLlm,
} from '../src/aiFill.js';

test('normalizeAiFields: unknown keys are dropped, garbage values are dropped', () => {
  const out = normalizeAiFields('term', {
    lender: 'RBC', evil: 'x', mortgage_payment: 999, term_months: { nope: 1 },
    start_date: ['2024-01-01'], opening_balance: 'not a number',
  });
  assert.deepEqual(out, { lender: 'RBC' });
  assert.deepEqual(normalizeAiFields('term', null), {});
  assert.deepEqual(normalizeAiFields('term', 'junk'), {});
  assert.deepEqual(normalizeAiFields('property', { assessed_value: -5, assessed_year: 1800 }), {});
});

test('normalizeAiFields: money, dates and ints are normalized', () => {
  const out = normalizeAiFields('term', {
    opening_balance: '$1,350,000', payment_override: '7,207.10',
    start_date: 'Dec 17, 2024', term_months: '60', amortization_years: '30',
  });
  assert.deepEqual(out, {
    start_date: '2024-12-17', term_months: 60, amortization_years: 30,
    opening_balance: 1350000, payment_override: 7207.1,
  });
  assert.equal(normalizeAiFields('term', { start_date: '2024/12/17' }).start_date, '2024-12-17');
  assert.equal(normalizeAiFields('term', { start_date: '17 December 2024' }).start_date, '2024-12-17');
  assert.equal(normalizeAiFields('term', { start_date: '2024-02-30' }).start_date, undefined);
  assert.equal(normalizeAiFields('term', { payment_override: 0 }).payment_override, undefined);
  assert.equal(normalizeAiFields('term', { payment_override: -10 }).payment_override, undefined);
  assert.equal(normalizeAiFields('term', { term_months: 121 }).term_months, undefined);
});

test('normalizeAiFields: enums are mapped from document phrasings', () => {
  assert.equal(normalizeAiFields('term', { payment_frequency: 'Accelerated Bi-Weekly' }).payment_frequency, 'accelerated_bi_weekly');
  assert.equal(normalizeAiFields('term', { payment_frequency: 'biweekly' }).payment_frequency, 'bi_weekly');
  assert.equal(normalizeAiFields('term', { payment_frequency: 'daily' }).payment_frequency, undefined);
  assert.equal(normalizeAiFields('term', { repayment_method: 'Equal Principal' }).repayment_method, 'equal_principal');
  assert.equal(normalizeAiFields('term', { segment_compounding: 'monthly' }).segment_compounding, 'monthly');
  assert.equal(normalizeAiFields('term', { segment_compounding: 'Semi-Annual' }).segment_compounding, 'semi_annual');
  // The commitment-letter phrasing for monthly compounding.
  assert.equal(
    normalizeAiFields('term', { segment_compounding: 'calculated not in advance, at the same frequency as your payments' }).segment_compounding,
    'monthly');
});

test('normalizeAiFields: spread is a signed number, unicode minus included', () => {
  assert.equal(normalizeAiFields('term', { segment_rate_mode: 'prime_spread', segment_spread: 'Prime − 1.00' }).segment_spread, -1);
  assert.equal(normalizeAiFields('term', { segment_rate_mode: 'prime_spread', segment_spread: '+0.5%' }).segment_spread, 0.5);
  assert.equal(normalizeAiFields('term', { segment_rate_mode: 'prime_spread', segment_spread: -1.25 }).segment_spread, -1.25);
});

test('normalizeAiFields: the segment kind vocabulary expands to the form fields, coherently', () => {
  // prime_spread kind → variable + prime_spread, spread kept, rate dropped.
  assert.deepEqual(
    normalizeAiFields('term', { segment_kind: 'prime_spread', segment_rate: 9.99, spread: -1, segment_compounding: 'monthly' }),
    { segment_rate_type: 'variable', segment_rate_mode: 'prime_spread', segment_spread: -1, segment_compounding: 'monthly' });
  // fixed kind → fixed + absolute, rate kept, spread dropped.
  assert.deepEqual(
    normalizeAiFields('term', { segment_kind: 'fixed', segment_rate: '4.95', segment_spread: -1 }),
    { segment_rate_type: 'fixed', segment_rate_mode: 'absolute', segment_annual_rate: 4.95 });
  // Explicit form fields win and stay coherent.
  assert.deepEqual(
    normalizeAiFields('term', { segment_rate_type: 'fixed', segment_annual_rate: 5, segment_spread: 2 }),
    { segment_rate_type: 'fixed', segment_rate_mode: 'absolute', segment_annual_rate: 5 });
  assert.deepEqual(
    normalizeAiFields('property', { address: '1 Main St', owners: ['Shawn', ' ', 42], mortgage_balance: '250,000' }),
    { address: '1 Main St', mortgage_balance: 250000, owners: ['Shawn'] });
});

test('parseModelJson: plain, fenced and prose-wrapped JSON', () => {
  assert.deepEqual(parseModelJson('{"fields":{}}'), { fields: {} });
  assert.deepEqual(parseModelJson('```json\n{"fields":{"a":1}}\n```'), { fields: { a: 1 } });
  assert.deepEqual(parseModelJson('Here you go: {"fields":{"a":1}} done'), { fields: { a: 1 } });
  assert.equal(parseModelJson('no json at all'), null);
  assert.equal(parseModelJson(''), null);
});

const stubCall = (text) => async () => text;
const CONFIGURED = { LLM_API_KEY: 'test-key', LLM_MODEL: 'm1' };

test('handleAiFill: unconfigured LLM is a 503 with guidance', async () => {
  assert.equal(llmConfigured({}), false);
  assert.equal(llmConfigured({ LLM_API_KEY: 'k' }), false); // a key with no model at all is not configured
  assert.equal(llmConfigured(CONFIGURED), true);
  assert.equal(llmConfigured({ LLM_STUB_RESPONSE: '{}' }), true);
  const r = await handleAiFill({ context: 'term', text: 'RBC letter' }, { env: {}, callLlm: stubCall('{}') });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /LLM_API_KEY/);
});

test('llmModels / llmDefaultModel: LLM_MODELS list, else the single LLM_MODEL', () => {
  assert.deepEqual(llmModels({ LLM_MODELS: ' a, b ,, c ,a ', LLM_MODEL: 'x' }), ['a', 'b', 'c']);
  assert.deepEqual(llmModels({ LLM_MODEL: 'only' }), ['only']);
  assert.deepEqual(llmModels({}), []);
  assert.equal(llmDefaultModel({ LLM_MODEL: 'd', LLM_MODELS: 'a,b' }), 'd');
  assert.equal(llmDefaultModel({ LLM_MODELS: 'a,b' }), 'a');
  assert.equal(llmDefaultModel({}), null);
});

test('handleAiFill: the model must be in the configured list; the choice reaches the LLM call', async () => {
  const env = { LLM_API_KEY: 'k', LLM_MODEL: 'm1', LLM_MODELS: 'm1,m2' };
  let seenModel = null;
  const capture = async (messages, e, model) => { seenModel = model; return '{"fields":{"lender":"RBC"}}'; };
  const bad = await handleAiFill({ context: 'term', text: 'x', model: 'm3' }, { env, callLlm: capture });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not in the configured model list/);
  const picked = await handleAiFill({ context: 'term', text: 'x', model: 'm2' }, { env, callLlm: capture });
  assert.equal(picked.status, 200);
  assert.equal(seenModel, 'm2');
  assert.equal(picked.body.model, 'm2');
  const defaulted = await handleAiFill({ context: 'term', text: 'x' }, { env, callLlm: capture, model: 'm2' });
  assert.equal(defaulted.status, 200);
  assert.equal(seenModel, 'm2'); // the caller's persisted choice is the default
  const envDefault = await handleAiFill({ context: 'term', text: 'x' }, { env, callLlm: capture });
  assert.equal(seenModel, 'm1'); // otherwise LLM_MODEL
  assert.equal(envDefault.body.model, 'm1');
});

test('callLlm: the stub file can answer per model name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-stub-'));
  const file = path.join(dir, 'stub.json');
  fs.writeFileSync(file, JSON.stringify({
    models: { m1: '{"fields":{"lender":"A"}}', m2: { fields: { lender: 'B' } } },
  }));
  const env = { LLM_STUB_RESPONSE_FILE: file };
  assert.equal(await callLlm([], env, 'm1'), '{"fields":{"lender":"A"}}');
  assert.equal(await callLlm([], env, 'm2'), '{"fields":{"lender":"B"}}');
  // A plain response file (no models map) is returned raw, as before.
  fs.writeFileSync(file, '{"fields":{"lender":"C"}}');
  assert.equal(await callLlm([], env, 'm1'), '{"fields":{"lender":"C"}}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('callLlm: LLM_MODEL_FALLBACK takes over when the primary call fails', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const model = JSON.parse(opts.body).model;
    seen.push(model);
    if (model === 'primary') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"fields":{}}' } }] }) };
  };
  try {
    const env = { LLM_API_KEY: 'k', LLM_BASE_URL: 'http://llm.test/v1', LLM_MODEL_FALLBACK: 'lite' };
    const out = await callLlm([{ role: 'user', content: 'x' }], env, 'primary');
    assert.equal(out, '{"fields":{}}');
    assert.deepEqual(seen, ['primary', 'lite']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handleAiFill: bad context / no input / bad file are 400s, oversize is a 413', async () => {
  const deps = { env: CONFIGURED, callLlm: stubCall('{"fields":{}}') };
  assert.equal((await handleAiFill({ context: 'bogus', text: 'x' }, deps)).status, 400);
  assert.equal((await handleAiFill({ context: 'term' }, deps)).status, 400);
  assert.equal((await handleAiFill({ context: 'term', text: '  ' }, deps)).status, 400);
  assert.equal((await handleAiFill({ context: 'term', file: { name: 'a.docx', type: 'application/msword', data: 'aGk=' } }, deps)).status, 400);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64');
  assert.equal((await handleAiFill({ context: 'term', file: { name: 'a.pdf', type: 'application/pdf', data: big } }, deps)).status, 413);
});

test('handleAiFill: garbage model output is a 502; a valid response is normalized', async () => {
  assert.equal((await handleAiFill({ context: 'term', text: 'x' }, { env: CONFIGURED, callLlm: stubCall('not json') })).status, 502);
  assert.equal((await handleAiFill({ context: 'term', text: 'x' }, { env: CONFIGURED, callLlm: stubCall('{"fields":"nope"}') })).status, 502);
  assert.equal((await handleAiFill({ context: 'term', text: 'x' }, { env: CONFIGURED, callLlm: async () => { throw new Error('down'); } })).status, 502);
  const ok = await handleAiFill(
    { context: 'term', text: 'x' },
    { env: CONFIGURED, callLlm: stubCall('{"fields":{"lender":"RBC","opening_balance":"$1,350,000","unknown":1}}') });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.fields, { lender: 'RBC', opening_balance: 1350000 });
});

test('handleAiFill: images reach the model as image parts; owners map through the dep', async () => {
  let seen = null;
  const capture = async (messages) => { seen = messages; return '{"fields":{"owners":["shawn","Nobody"]}}'; };
  const r = await handleAiFill(
    { context: 'property', file: { name: 'p.png', type: 'image/png', data: Buffer.from('pngbytes').toString('base64') } },
    { env: CONFIGURED, callLlm: capture, mapOwners: (names) => names.filter((n) => n === 'shawn').map(() => 'Shawn') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.fields, { owners: ['Shawn'] });
  const userParts = seen[1].content;
  assert.equal(userParts[1].type, 'image_url');
  assert.ok(userParts[1].image_url.url.startsWith('data:image/png;base64,'));
});

test('extractPdfText: recovers text from a Flate content stream', () => {
  const content = 'BT /F1 12 Tf (RBC Royal Bank) Tj (Prime - 1.00) Tj ET';
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  const text = extractPdfText(pdf);
  assert.ok(text.includes('RBC Royal Bank'), text);
  assert.ok(text.includes('Prime - 1.00'), text);
  assert.equal(extractPdfText(Buffer.from('not a pdf')), '');
});
