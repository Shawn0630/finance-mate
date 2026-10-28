// Property costs: the pivot/total math (a 'monthly'-basis entry
// counts at its monthly average × 12 everywhere a year figure is
// shown), input validation, the UNIQUE (property, year, category)
// upsert against a real SQLite table, and the multi-turn AI fill
// chat — its two-round flow, history truncation, proposal
// normalization and the endpoint's status contract. The LLM call
// is injected; no network, no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  COST_CATEGORIES, costAnnual, costMonthSeries, pivotCosts, validCostInput, listCosts, costsView, upsertCost,
  parseMonthlyAmounts, monthlyAmountsAverage,
} from '../src/costs.js';
import {
  handleAiFillChat, truncateChatHistory, normalizeProposedCosts, buildCostsChatMessages,
  handleAiFill, validateFile, TEXT_FILE_MAX_CHARS,
} from '../src/aiFill.js';

const E = (year, category, amount, basis = 'annual', extra = {}) => ({
  id: extra.id || 0, property_id: 1, year, category, amount, basis,
  notes: extra.notes ?? null, source: extra.source || 'manual',
});

// ------------------------------------------------------------- pivot math
test('costAnnual: annual passes through, monthly is the average × 12', () => {
  assert.equal(costAnnual(E(2025, 'Water', 1200)), 1200);
  assert.equal(costAnnual(E(2025, 'Water', 100, 'monthly')), 1200);
  assert.equal(costAnnual(E(2025, 'Water', 312.5, 'monthly')), 3750);
});

test('pivotCosts: monthly entries count ×12 in cells, year totals and latest', () => {
  const pivot = pivotCosts([
    E(2026, 'Property tax', 5400),
    E(2026, 'Electricity', 85, 'monthly'),
    E(2025, 'Property tax', 5100),
    E(2025, 'Water', 40, 'monthly'),
    E(2025, 'Gardening', 900), // a custom category
  ]);
  // Presets first (in preset order), customs after, alphabetical.
  assert.deepEqual(pivot.categories, ['Property tax', 'Water', 'Electricity', 'Gardening']);
  assert.deepEqual(pivot.years.map((y) => y.year), [2026, 2025]); // newest first
  const y2026 = pivot.years[0];
  assert.equal(y2026.cells['Electricity'].annual, 1020); // 85 × 12
  assert.equal(y2026.cells['Electricity'].amount, 85);    // raw stored figure kept
  assert.equal(y2026.total, 6420);
  const y2025 = pivot.years[1];
  assert.equal(y2025.cells.Water.annual, 480);
  assert.equal(y2025.total, 5100 + 480 + 900);
  assert.deepEqual(pivot.latest, { year: 2026, total: 6420 });
  assert.deepEqual(pivotCosts([]), { categories: [], years: [], latest: null });
  assert.ok(COST_CATEGORIES.includes('Other'));
});

// -------------------------------------------------------------- validation
test('validCostInput: accepts annual and monthly rows, rejects bad shape', () => {
  assert.deepEqual(validCostInput({ year: 2025, category: 'Water', amount: 480 }),
    { year: 2025, category: 'Water', amount: 480, basis: 'annual', notes: null, monthlyAmounts: null });
  assert.deepEqual(validCostInput({ year: '2025', category: ' Electricity ', amount: '85.5', basis: 'monthly', notes: ' x ' }),
    { year: 2025, category: 'Electricity', amount: 85.5, basis: 'monthly', notes: 'x', monthlyAmounts: null });
  assert.equal(validCostInput({ year: 2025, category: 'Water', amount: 0 }).amount, 0);
  // Over-long notes truncate rather than reject.
  assert.equal(validCostInput({ year: 2025, category: 'Water', amount: 1, notes: 'n'.repeat(501) }).notes.length, 500);
  for (const bad of [
    { year: 1800, category: 'Water', amount: 1 },
    { year: 2101, category: 'Water', amount: 1 },
    { year: 2025.5, category: 'Water', amount: 1 },
    { year: 'x', category: 'Water', amount: 1 },
    { year: 2025, category: '  ', amount: 1 },
    { year: 2025, category: 'Water', amount: -1 },
    { year: 2025, category: 'Water', amount: 'abc' },
    { year: 2025, category: 'Water', amount: 1, basis: 'quarterly' },
    { year: 2025, category: 'c'.repeat(81), amount: 1 },
    null, 'junk',
  ]) {
    assert.ok(validCostInput(bad).error, JSON.stringify(bad));
  }
  // (The routes turn that error into a 400; covered in e2e.)
});

// ------------------------------------------------------ monthly detail
test('validCostInput: monthlyAmounts — the server computes the average', () => {
  assert.deepEqual(
    validCostInput({ year: 2025, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } }),
    { year: 2025, category: 'Electricity', amount: 85, basis: 'monthly', notes: null, monthlyAmounts: { '1': 80, '2': 90, '3': 85 } });
  // A client-sent amount is never trusted alongside the months.
  assert.equal(
    validCostInput({ year: 2025, category: 'Electricity', basis: 'monthly', amount: 999, monthlyAmounts: { 6: 120 } }).amount,
    120);
  // A single month: the average is that month.
  assert.equal(
    validCostInput({ year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 7: 200 } }).amount,
    200);
  assert.equal(
    validCostInput({ year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 1: 100, 2: 101, 3: 103 } }).amount,
    101.33); // 304/3 = 101.333… -> cents
  // Annual entries ignore month detail entirely.
  const annual = validCostInput({ year: 2025, category: 'Water', amount: 480, monthlyAmounts: { 1: 40 } });
  assert.equal(annual.monthlyAmounts, null);
  assert.equal(annual.amount, 480);
});

test('validCostInput: monthlyAmounts rejects empty maps and invalid months', () => {
  for (const bad of [
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: {} },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 13: 5 } },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 0: 5 } },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { Jan: 5 } },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 1: -5 } },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 1: 'x' } },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: { 1: '' } },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: [80, 90] },
    { year: 2025, category: 'Water', basis: 'monthly', monthlyAmounts: 'x' },
  ]) {
    assert.ok(validCostInput(bad).error, JSON.stringify(bad));
  }
  assert.deepEqual(parseMonthlyAmounts({ 2: '42.5' }), { value: { '2': 42.5 } });
  assert.equal(monthlyAmountsAverage({ '1': 80, '2': 90, '3': 85 }), 85);
  assert.equal(monthlyAmountsAverage({}), null);
});

test('costMonthSeries: recorded months land actual, the rest fill with the average', () => {
  assert.deepEqual(costMonthSeries(E(2025, 'Property tax', 1200)), Array(12).fill(100));
  assert.deepEqual(costMonthSeries(E(2025, 'Water', 40, 'monthly')), Array(12).fill(40));
  const row = { ...E(2025, 'Electricity', 85, 'monthly'), monthlyAmounts: { '1': 80, '2': 90, '3': 85 } };
  const s = costMonthSeries(row);
  assert.deepEqual(s.slice(0, 3), [80, 90, 85]);
  assert.equal(s[3], 85);
  assert.equal(s[11], 85);
  // … and the twelve sum back to the annual figure (avg × 12).
  assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1020) < 1e-9);
});

// ------------------------------------------------------------- DB behavior
const COSTS_DDL = `
CREATE TABLE property_costs (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  basis TEXT NOT NULL DEFAULT 'annual',
  monthly_amounts TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (property_id, year, category)
);`;

function freshDb() {
  const database = new Database(':memory:');
  database.exec(COSTS_DDL);
  return database;
}
const TS = '2026-01-01T00:00:00.000Z';
const up = (database, pid, body, source) => upsertCost(database, pid, validCostInput(body), source, TS);

test('upsertCost: same (property, year, category) updates in place — UNIQUE holds', () => {
  const database = freshDb();
  up(database, 7, { year: 2025, category: 'Water', amount: 480 }, 'manual');
  const firstId = listCosts(database, 7)[0].id;
  up(database, 7, { year: 2025, category: 'Water', amount: 512.25, notes: 'corrected' }, 'ai');
  const rows = listCosts(database, 7);
  assert.equal(rows[0].id, firstId); // same row, not a duplicate
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 512.25);
  assert.equal(rows[0].source, 'ai');
  assert.equal(rows[0].notes, 'corrected');
  // A different category in the same year is a different row.
  up(database, 7, { year: 2025, category: 'Gas', amount: 60, basis: 'monthly' }, 'manual');
  assert.equal(listCosts(database, 7).length, 2);
  // And a different property never collides.
  up(database, 8, { year: 2025, category: 'Water', amount: 1 }, 'manual');
  assert.equal(listCosts(database, 8).length, 1);
  database.close();
});

test('costsView: entries + pivot served from the stored rows', () => {
  const database = freshDb();
  up(database, 3, { year: 2026, category: 'Property tax', amount: 5400 }, 'manual');
  up(database, 3, { year: 2026, category: 'Electricity', amount: 85, basis: 'monthly' }, 'ai');
  const view = costsView(database, 3);
  assert.equal(view.entries.length, 2);
  assert.equal(view.latest.total, 6420);
  assert.equal(view.entries.find((e) => e.category === 'Electricity').source, 'ai');
  database.close();
});

test('monthly detail: stored as JSON, served parsed, the pivot carries the month series', () => {
  const database = freshDb();
  up(database, 4, { year: 2026, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } }, 'manual');
  const rows = listCosts(database, 4);
  assert.equal(rows[0].amount, 85); // the server-computed average
  assert.deepEqual(rows[0].monthlyAmounts, { '1': 80, '2': 90, '3': 85 });
  assert.equal(rows[0].monthly_amounts, undefined); // raw column never leaks
  const cell = costsView(database, 4).years[0].cells.Electricity;
  assert.equal(cell.annual, 1020);
  assert.deepEqual(cell.months.slice(0, 4), [80, 90, 85, 85]);
  assert.ok(Math.abs(cell.months.reduce((a, b) => a + b, 0) - 1020) < 1e-9);
  // Re-upserting the pair replaces the detail wholesale.
  up(database, 4, { year: 2026, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 5: 130 } }, 'manual');
  const again = listCosts(database, 4);
  assert.equal(again[0].amount, 130);
  assert.deepEqual(again[0].monthlyAmounts, { '5': 130 });
  database.close();
});

test('legacy monthly rows (no monthly_amounts) keep working unchanged', () => {
  const database = freshDb();
  // A row written the pre-detail way: an average, NULL detail.
  database.prepare(`INSERT INTO property_costs
    (property_id, year, category, amount, basis, monthly_amounts, notes, source, created_at, updated_at)
    VALUES (9, 2025, 'Water', 40, 'monthly', NULL, NULL, 'manual', ?, ?)`)
    .run(TS, TS);
  const rows = listCosts(database, 9);
  assert.equal(rows[0].monthlyAmounts, null);
  assert.equal(rows[0].amount, 40);
  const view = costsView(database, 9);
  assert.deepEqual(view.years[0].cells.Water.months, Array(12).fill(40));
  assert.equal(view.years[0].total, 480);
  database.close();
});

// --------------------------------------------------------------- AI chat
const CONFIGURED = { LLM_API_KEY: 'test-key', LLM_MODEL: 'm1', LLM_MODELS: 'm1,m2' };
const PROPERTY = { id: 5, address: '2985 Christina Place', city: 'Coquitlam', province: 'BC' };
const EXISTING = [E(2025, 'Property tax', 5400)];

test('truncateChatHistory: last 20 turns, each capped at 12,000 chars', () => {
  const history = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  const out = truncateChatHistory(history);
  assert.equal(out.length, 20);
  assert.equal(out[0].content, 'turn 5');
  const long = truncateChatHistory([{ role: 'user', content: 'x'.repeat(13000) }]);
  assert.equal(long[0].content.length, 12000);
  assert.deepEqual(truncateChatHistory('junk'), []);
  assert.deepEqual(truncateChatHistory([{ role: 'system', content: 'no' }, { nope: 1 }]), []);
});

test('normalizeProposedCosts: unusable items drop, basis defaults to annual', () => {
  const out = normalizeProposedCosts([
    { year: 2025, category: 'Electricity', amount: 85, basis: 'monthly' },
    { year: 2025, category: 'Water', amount: '480' },
    { year: 2025, category: 'Gas', amount: 10, basis: 'quarterly' }, // unknown basis → annual
    { year: 'x', category: 'Water', amount: 1 },
    { year: 2025, category: '', amount: 1 },
    { year: 2025, category: 'Water', amount: -3 },
    null, 'junk',
  ]);
  assert.deepEqual(out, [
    { year: 2025, category: 'Electricity', amount: 85, basis: 'monthly', monthlyAmounts: null, notes: null },
    { year: 2025, category: 'Water', amount: 480, basis: 'annual', monthlyAmounts: null, notes: null },
    { year: 2025, category: 'Gas', amount: 10, basis: 'annual', monthlyAmounts: null, notes: null },
  ]);
  assert.equal(normalizeProposedCosts(Array.from({ length: 60 }, () => ({ year: 2025, category: 'Water', amount: 1 }))).length, 50);
});

test('normalizeProposedCosts: monthlyAmounts rides along and sets the average', () => {
  const out = normalizeProposedCosts([
    { year: 2025, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 }, amount: 999 },
    { year: 2025, category: 'Gas', basis: 'monthly', monthlyAmounts: { 13: 5 }, amount: 60 },
    { year: 2025, category: 'Water', basis: 'monthly' },
    { year: 2025, category: 'Strata fee', basis: 'annual', amount: 3744, monthlyAmounts: { 1: 312 } },
  ]);
  assert.deepEqual(out, [
    // The model's own averaged figure is ignored: the average is
    // recomputed from the months (and the server will again).
    { year: 2025, category: 'Electricity', amount: 85, basis: 'monthly', monthlyAmounts: { '1': 80, '2': 90, '3': 85 }, notes: null },
    // An unusable month drops the detail; the given average survives.
    { year: 2025, category: 'Gas', amount: 60, basis: 'monthly', monthlyAmounts: null, notes: null },
    // (Water had neither months nor an amount — dropped.)
    // Annual items never carry month detail.
    { year: 2025, category: 'Strata fee', amount: 3744, basis: 'annual', monthlyAmounts: null, notes: null },
  ]);
});

test('buildCostsChatMessages: property, recorded entries and draft are context', () => {
  const messages = buildCostsChatMessages({
    property: PROPERTY, existing: EXISTING,
    draft: [{ year: 2025, category: 'Electricity', amount: 85, basis: 'monthly', monthlyAmounts: { '1': 80, '2': 90, '3': 85 }, notes: null }],
    history: [{ role: 'user', content: 'earlier question' }],
    text: 'and this bill?',
    files: [],
  });
  const blob = JSON.stringify(messages);
  assert.match(blob, /2985 Christina Place/);
  assert.match(blob, /Property tax/);
  assert.match(blob, /Electricity/);
  assert.match(blob, /earlier question/);
  assert.match(blob, /and this bill\?/);
  // The draft's recorded months reach the model month by month.
  assert.match(JSON.stringify(messages), /Jan \$80/);
  // The system prompt carries the ambiguity and basis rules.
  assert.match(messages[0].content, /never guess/);
  assert.match(messages[0].content, /monthlyAmounts/);
  assert.match(messages[0].content, /monthly average/);
});

test('handleAiFillChat: two rounds — asks first with a partial monthly proposal, then completes', async () => {
  const seen = [];
  const replies = [
    JSON.stringify({ reply: 'Which year are these electricity bills for? I used the 3 bills you attached: their average is $85/mo.', proposed: [{ year: 2025, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 } }], ready: false }),
    JSON.stringify({ reply: 'Thanks — recorded as 2025 figures.', proposed: [{ year: 2025, category: 'Electricity', basis: 'monthly', monthlyAmounts: { 1: 80, 2: 90, 3: 85 }, notes: '3 bills' }, { year: 2025, category: 'Water', amount: 480, basis: 'annual' }], ready: true }),
  ];
  const callLlm = async (messages) => { seen.push(messages); return replies[seen.length - 1]; };
  const deps = { env: CONFIGURED, callLlm, property: PROPERTY };

  const round1 = await handleAiFillChat(
    { propertyId: 5, history: [], text: 'electricity bills attached', proposed: [] },
    { ...deps, existing: EXISTING });
  assert.equal(round1.status, 200);
  assert.equal(round1.body.ready, false);
  assert.match(round1.body.reply, /Which year/);
  // The months ride through individually; the amount is their
  // server-side average, not anything the model claimed.
  assert.deepEqual(round1.body.proposed, [{ year: 2025, category: 'Electricity', amount: 85, basis: 'monthly', monthlyAmounts: { '1': 80, '2': 90, '3': 85 }, notes: null }]);
  // The already-recorded entries reached the model as context.
  assert.match(JSON.stringify(seen[0]), /2985 Christina Place/);
  assert.match(JSON.stringify(seen[0]), /Property tax/);

  const round2 = await handleAiFillChat(
    {
      propertyId: 5,
      history: [
        { role: 'user', content: 'electricity bills attached' },
        { role: 'assistant', content: round1.body.reply },
        { role: 'user', content: '2025, and water was $480 for the year' },
      ],
      text: '2025, and water was $480 for the year',
      proposed: round1.body.proposed,
    },
    { ...deps, existing: EXISTING });
  assert.equal(round2.status, 200);
  assert.equal(round2.body.ready, true);
  assert.equal(round2.body.proposed.length, 2);
  assert.equal(round2.body.proposed[0].basis, 'monthly');
  // The follow-up round carried the history AND the draft back in.
  const blob2 = JSON.stringify(seen[1]);
  assert.match(blob2, /Which year are these electricity bills for/);
  assert.match(blob2, /Electricity/);
});

test('handleAiFillChat: status contract — 400 / 404 / 503 / 502', async () => {
  const ok = async () => '{"reply":"hi","proposed":[],"ready":false}';
  const deps = { env: CONFIGURED, callLlm: ok, property: PROPERTY, existing: [] };
  assert.equal((await handleAiFillChat({ propertyId: 'x', text: 'a' }, deps)).status, 400);
  assert.equal((await handleAiFillChat({ propertyId: 5, text: 'a' }, { ...deps, property: null })).status, 404);
  const unconf = await handleAiFillChat({ propertyId: 5, text: 'a' }, { env: {}, callLlm: ok, property: PROPERTY, existing: [] });
  assert.equal(unconf.status, 503);
  assert.match(unconf.body.error, /LLM_BASE_URL/);
  assert.equal((await handleAiFillChat({ propertyId: 5, text: 'a', model: 'm9' }, deps)).status, 400);
  assert.equal((await handleAiFillChat({ propertyId: 5 }, deps)).status, 400); // no text, no files
  assert.equal((await handleAiFillChat(
    { propertyId: 5, files: Array.from({ length: 6 }, () => ({ name: 'a.png', type: 'image/png', data: '' })) }, deps)).status, 400);
  const boom = await handleAiFillChat({ propertyId: 5, text: 'a' },
    { ...deps, callLlm: async () => { throw new Error('down'); } });
  assert.equal(boom.status, 502);
  const junk = await handleAiFillChat({ propertyId: 5, text: 'a' },
    { ...deps, callLlm: async () => 'not json at all' });
  assert.equal(junk.status, 502);
});

// ------------------------------------------------------ text attachments
// CSV / TXT files are read as UTF-8 text and ride into the
// prompt as a named text block (never an image part); text
// past ~50 KB is truncated with a note at the block's tail.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const CSV_TEXT = 'month,amount\n2025-01,80\n2025-02,90\n2025-03,85\n';

test('validateFile: CSV/TXT accepted as text; other types still rejected', () => {
  const csv = validateFile({ name: 'bills.csv', type: 'text/csv', data: b64(CSV_TEXT) });
  assert.equal(csv.error, undefined);
  assert.equal(csv.text, CSV_TEXT);
  assert.equal(csv.truncated, false);
  // Extension alone is enough (some browsers send no useful type).
  const txt = validateFile({ name: 'notes.txt', type: '', data: b64('hello') });
  assert.equal(txt.error, undefined);
  assert.equal(txt.text, 'hello');
  const bad = validateFile({ name: 'a.docx', type: 'application/msword', data: b64('x') });
  assert.equal(bad.status, 400);
  assert.match(bad.error, /\.csv \/ \.txt/);
  // The 10 MB cap still applies to text files.
  const big = validateFile({ name: 'big.csv', type: 'text/csv', data: Buffer.alloc(11 * 1024 * 1024, 97).toString('base64') });
  assert.equal(big.status, 413);
});

test('fill-chat: a CSV reaches the model as a named text block, not an image part', async () => {
  const seen = [];
  const callLlm = async (messages) => {
    seen.push(messages);
    return '{"reply":"Got the water bills.","proposed":[{"year":2025,"category":"Water","basis":"monthly","monthlyAmounts":{"1":80,"2":90,"3":85}}],"ready":true}';
  };
  const r = await handleAiFillChat(
    { propertyId: 5, history: [], text: 'water bills', files: [{ name: 'bills.csv', type: 'text/csv', data: b64(CSV_TEXT) }] },
    { env: CONFIGURED, callLlm, property: PROPERTY, existing: [] });
  assert.equal(r.status, 200);
  const user = seen[0][seen[0].length - 1];
  const texts = user.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  assert.match(texts, /File "bills\.csv":/);
  assert.match(texts, /2025-02,90/);
  assert.equal(user.content.some((p) => p.type === 'image_url'), false);
});

test('fill-chat: a CSV and an image in one message both reach the model', async () => {
  const seen = [];
  const callLlm = async (messages) => { seen.push(messages); return '{"reply":"ok","proposed":[],"ready":false}'; };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const r = await handleAiFillChat(
    {
      propertyId: 5, history: [], text: '',
      files: [
        { name: 'bills.csv', type: 'text/csv', data: b64(CSV_TEXT) },
        { name: 'shot.png', type: 'image/png', data: png },
      ],
    },
    { env: CONFIGURED, callLlm, property: PROPERTY, existing: [] });
  assert.equal(r.status, 200);
  const user = seen[0][seen[0].length - 1];
  assert.equal(user.content.filter((p) => p.type === 'image_url').length, 1);
  assert.match(user.content.map((p) => p.text || '').join('\n'), /2025-03,85/);
});

test('fill-chat: an over-long text file is truncated at ~50 KB with a note, not an error', async () => {
  const seen = [];
  const callLlm = async (messages) => { seen.push(messages); return '{"reply":"ok","proposed":[],"ready":false}'; };
  const long = 'x'.repeat(TEXT_FILE_MAX_CHARS + 5000);
  const r = await handleAiFillChat(
    { propertyId: 5, history: [], text: '', files: [{ name: 'long.txt', type: 'text/plain', data: b64(long) }] },
    { env: CONFIGURED, callLlm, property: PROPERTY, existing: [] });
  assert.equal(r.status, 200);
  const user = seen[0][seen[0].length - 1];
  const block = user.content.map((p) => p.text || '').join('\n');
  assert.match(block, /truncated/);
  assert.ok(block.length < TEXT_FILE_MAX_CHARS + 500, `block was ${block.length} chars`);
});

test('one-shot AI Fill shares the pipeline: a CSV file fills from its text', async () => {
  const seen = [];
  const callLlm = async (messages) => { seen.push(messages); return '{"fields":{"lender":"RBC"}}'; };
  const r = await handleAiFill(
    { context: 'term', text: '', file: { name: 'terms.csv', type: 'text/csv', data: b64('lender,RBC\n') } },
    { env: CONFIGURED, callLlm });
  assert.equal(r.status, 200);
  assert.equal(r.body.fields.lender, 'RBC');
  const user = seen[0][seen[0].length - 1];
  assert.match(user.content.map((p) => p.text || '').join('\n'), /lender,RBC/);
  assert.equal(user.content.some((p) => p.type === 'image_url'), false);
});
