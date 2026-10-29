// AI-mapped CSV import: for broker exports whose format is NOT
// Wealthsimple's. The split of labour is the whole point:
//   - the MODEL decides semantics only: which column is the date /
//     symbol / activity / units / price / amount / currency, and
//     which distinct activity word means buy / sell / grant /
//     dividend / split / skip. It never sees per-row figures and
//     never invents a mapping it cannot support — anything
//     unclear becomes a question for the user, not a guess.
//   - the DETERMINISTIC engine below applies the user-confirmed
//     mapping to every row: units take absolute value, the sell
//     guard runs over recorded + new events in current terms,
//     duplicates reuse the AI proposal semantics, split ratios
//     derive from the running position (or come straight from
//     mapped ratio columns), cash-like rows count as skipped,
//     and every failed row surfaces with its reason — never a
//     silent drop (the rule from the 3191b85 sell fix).
// A confirmed mapping is remembered by the file's column
// fingerprint (normalized, sorted column names), so a second
// export from the same broker reuses it and skips the AI and
// confirmation steps — the uncertain format grows into a
// deterministic one. Parse and preview write nothing; Apply
// reuses validateImportApply and writes atomically.

import { isDateStr } from './investments.js';
import { readCsvRows, dupKey, guardFailures } from './wsImport.js';
import { callLlm } from './aiFill.js';

export const MAP_TARGETS = ['buy', 'sell', 'grant', 'dividend', 'split', 'skip'];
export const MAP_COLUMN_FIELDS = [
  'date', 'symbol', 'name', 'activity', 'activity2', 'units', 'price', 'amount',
  'currency', 'splitAdded', 'splitNew', 'splitOld',
];
// The value(s) that decide a row's operation. With a second activity
// column set, the key is the pair "type / subtype" built from the raw
// trimmed values — a blank part stays blank, so a blank sub-type and
// a literal '-' sub-type are different keys (a file that writes '-'
// for both dividends and interest still needs the type column to
// tell them apart, which is the whole point of the pair). Pair keys
// are only ever interpreted in pair mode, so they can never collide
// with single-column keys; broker activity words are short codes
// that never contain ' / ', and the display form keeps the split
// visible. Without a second column, the key is the single column's
// value, exactly as before.
export const PAIR_SEP = ' / ';
export function activityKeyOf(row, cols) {
  const a = String((cols.activity ? row[cols.activity] : '') ?? '').trim();
  if (!cols.activity2) return a;
  const b = String((cols.activity2 ? row[cols.activity2] : '') ?? '').trim();
  return `${a}${PAIR_SEP}${b}`;
}
// Display form of a key: blank parts read as '-', the wizard's
// blank-value convention. Single-column keys pass through untouched.
export function activityKeyLabel(key, paired) {
  if (!paired) return key;
  return String(key).split(PAIR_SEP).map((p) => (p === '' ? '-' : p)).join(PAIR_SEP);
}
// Distinct activity keys in first-seen order, capped like the
// column-stats distinct lists (the rest fail loudly at apply, never
// silently). Returns the kept keys plus whether more exist.
export function distinctActivityKeys(rows, cols, cap = 50) {
  const keys = [];
  const seen = new Set();
  for (const row of rows) {
    const k = activityKeyOf(row, cols);
    if (seen.has(k)) continue;
    seen.add(k);
    if (keys.length < cap) keys.push(k);
  }
  return { keys, truncated: seen.size > keys.length, count: seen.size };
}
// Wizard step state: the same mapping, organized the way a user
// thinks about a trade — when, what, how many, buy-or-sell,
// what it cost — instead of a flat column list. The wizard UI
// holds this shape; wizardToMapping turns it into the engine
// mapping (and back, for pre-filling from an AI proposal or a
// saved mapping). The engine never sees the wizard shape.
export const WIZARD_STEP_FIELDS = [
  'dateCol', 'symbolCol', 'nameCol', 'activityCol', 'activity2Col', 'unitsCol',
  'priceCol', 'amountCol', 'currencyCol',
];
export function wizardToMapping(wizard, columns) {
  if (!wizard || typeof wizard !== 'object' || Array.isArray(wizard)) return { error: 'wizard state must be an object' };
  const columnsOut = {};
  const pairs = [
    ['dateCol', 'date'], ['symbolCol', 'symbol'], ['nameCol', 'name'],
    ['activityCol', 'activity'], ['activity2Col', 'activity2'], ['unitsCol', 'units'], ['priceCol', 'price'],
    ['amountCol', 'amount'], ['currencyCol', 'currency'],
    ['splitAddedCol', 'splitAdded'], ['splitNewCol', 'splitNew'], ['splitOldCol', 'splitOld'],
  ];
  for (const [w, e] of pairs) {
    const v = wizard[w];
    if (typeof v === 'string' && v.trim() !== '') columnsOut[e] = v.trim();
  }
  const suffix = typeof wizard.symbolSuffix === 'string' ? wizard.symbolSuffix.trim() : '';
  const raw = {
    columns: columnsOut,
    values: wizard.valueTargets && typeof wizard.valueTargets === 'object' && !Array.isArray(wizard.valueTargets)
      ? wizard.valueTargets : {},
    defaultCurrency: wizard.defaultCurrency,
    symbolSuffix: suffix
      ? { suffix, whenCurrency: wizard.suffixWhenCurrency || null }
      : null,
  };
  return normalizeMapping(raw, columns, { allowMissingCurrency: true });
}
export function mappingToWizard(mapping) {
  const m = (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) ? mapping : {};
  const c = m.columns || {};
  return {
    dateCol: c.date || '', symbolCol: c.symbol || '', nameCol: c.name || '',
    activityCol: c.activity || '', activity2Col: c.activity2 || '', unitsCol: c.units || '', priceCol: c.price || '',
    amountCol: c.amount || '', currencyCol: c.currency || '',
    splitAddedCol: c.splitAdded || '', splitNewCol: c.splitNew || '', splitOldCol: c.splitOld || '',
    defaultCurrency: m.defaultCurrency || null,
    valueTargets: { ...(m.values || {}) },
    symbolSuffix: (m.symbolSuffix && m.symbolSuffix.suffix) || '',
    suffixWhenCurrency: (m.symbolSuffix && m.symbolSuffix.whenCurrency) || null,
  };
}

const fmtSentenceUnits = (n) => {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  return Number.isInteger(abs) ? String(abs) : String(Math.round(abs * 10000) / 10000);
};
const fmtSentenceMoney = (n) => {
  if (n == null || !Number.isFinite(n)) return null;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
// One data row translated into plain words, so the user can see
// at a glance whether the mapping matches their file — before
// anything is previewed or applied. Display-only: it never
// writes, never guards, never derives a split ratio (a split
// from an added-units column says so plainly, since its ratio
// needs the running position only the engine has).
export function translatePreviewRow(row, mapping) {
  const cols = (mapping && mapping.columns) || {};
  const val = (f) => (cols[f] ? (row[cols[f]] ?? '') : '');
  const date = String(val('date') || '').trim() || '(no date)';
  const rawActivity = activityKeyOf(row, cols);
  const shownActivity = cols.activity2 ? activityKeyLabel(rawActivity, true) : (rawActivity || '(blank)');
  const target = mapping && mapping.values ? mapping.values[rawActivity] : undefined;
  const currency = (String(val('currency') || '').trim().toUpperCase())
    || (mapping && mapping.defaultCurrency) || '';
  let symbol = String(val('symbol') || '').trim().toUpperCase();
  if (symbol && mapping && mapping.symbolSuffix
    && (mapping.symbolSuffix.whenCurrency == null || mapping.symbolSuffix.whenCurrency === currency)
    && !symbol.includes('.')) {
    symbol += mapping.symbolSuffix.suffix;
  }
  symbol = symbol || '(no symbol)';
  if (target === undefined) return `${date} · Unmapped "${shownActivity}" · ${symbol}`;
  if (target === 'skip') return `${date} · Skipped: ${shownActivity}`;
  if (target === 'dividend') {
    const amount = numOrNull(cols.amount ? row[cols.amount] : null);
    return `${date} · Dividend · ${symbol} · ${fmtSentenceMoney(amount) || '(no amount)'}`;
  }
  if (target === 'split') {
    if (cols.splitNew && cols.splitOld) {
      const sn = numOrNull(row[cols.splitNew]);
      const so = numOrNull(row[cols.splitOld]);
      return (sn != null && so != null && sn > 0 && so > 0)
        ? `${date} · Split · ${symbol} · ${fmtSentenceUnits(sn)}:${fmtSentenceUnits(so)}`
        : `${date} · Split · ${symbol} · (no ratio)`;
    }
    if (cols.splitAdded) {
      const added = numOrNull(row[cols.splitAdded]);
      return added != null && added !== 0
        ? `${date} · Split · ${symbol} · +${fmtSentenceUnits(added)} units (ratio derived on apply)`
        : `${date} · Split · ${symbol} · (no split quantity)`;
    }
    return `${date} · Split · ${symbol} · (no ratio mapping)`;
  }
  // buy / sell / grant
  const unitsNum = numOrNull(cols.units ? row[cols.units] : null);
  const units = fmtSentenceUnits(unitsNum);
  const action = target === 'buy' ? 'Buy' : target === 'sell' ? 'Sell' : 'Grant';
  let pricePart = '';
  let price = numOrNull(cols.price ? row[cols.price] : null);
  if (price != null && price > 0) {
    pricePart = ` @ ${fmtSentenceMoney(price)}`;
  } else if (target !== 'grant') {
    const amount = numOrNull(cols.amount ? row[cols.amount] : null);
    if (amount != null && amount !== 0 && unitsNum != null && unitsNum !== 0) {
      pricePart = ` @ ${fmtSentenceMoney(Math.abs(amount) / Math.abs(unitsNum))} (derived from total ${fmtSentenceMoney(Math.abs(amount))})`;
    } else {
      pricePart = ' @ (no price)';
    }
  }
  return `${date} · ${action} · ${symbol} · ${units != null ? `${units} units` : '(no units)'}${pricePart}`;
}
// First N data rows of the file, in file order, as plain-words
// sentences for the wizard's live preview.
// First `count` rows in file order, plus one sample row per activity
// key not already covered — a whole operation class skipped by the
// mapping must show up here, not hide behind the file's first rows
// (a file that opens with cash rows would otherwise preview clean
// while its dividends vanish). Added samples are capped at 50, the
// same distinct-value budget as the column stats.
export function translatePreview(text, mapping, count = 5) {
  const { structure, rows } = rowsOf(text);
  const { mapping: norm } = normalizeMapping(mapping, structure.columns, { allowMissingCurrency: true });
  const m = norm || { columns: {}, values: {} };
  const picked = [];
  const seen = new Set();
  const take = (row) => { picked.push(row); seen.add(activityKeyOf(row, m.columns)); };
  rows.slice(0, count).forEach(take);
  for (const row of rows) {
    if (picked.length >= count + 50) break;
    if (!seen.has(activityKeyOf(row, m.columns))) take(row);
  }
  return picked.map((row) => translatePreviewRow(row, m));
}
// Distinct activity keys for the mapping editor's step-4 list, in
// first-seen order with display labels. With no activity column
// there is nothing to list; with no second column the editor keeps
// using the column stats, so this is only the pair-mode list.
export function activityValuesFor(text, mapping) {
  const { structure, rows } = rowsOf(text);
  const { mapping: norm } = normalizeMapping(mapping, structure.columns, { allowMissingCurrency: true });
  const m = norm || { columns: {}, values: {} };
  if (!m.columns.activity) return { values: [], labels: [], truncated: false, count: 0 };
  const { keys, truncated, count } = distinctActivityKeys(rows, m.columns);
  const paired = !!m.columns.activity2;
  return { values: keys, labels: keys.map((k) => (paired ? activityKeyLabel(k, true) : k)), truncated, count };
}
export const MAP_REQUIRED_FIELDS = ['date', 'symbol', 'activity'];
const MAX_DISTINCT = 50;
const MAX_SAMPLES = 5;
const MAX_SAMPLE_ROWS = 3;

const numOrNull = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const round4 = (n) => Math.round(n * 10000) / 10000;

// Column fingerprint: normalized (trimmed, lowercased) names,
// sorted, so column order does not matter but the column set does.
export function fingerprintFor(columns) {
  return (columns || []).map((c) => String(c).trim().toLowerCase()).sort().join('|');
}

// Structural summary only — no semantics. Column stats carry a
// few samples plus the distinct values (capped) so the model can
// map activity words without seeing the whole file.
export function analyzeCsv(text) {
  const raw = readCsvRows(text);
  const nonEmpty = raw.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) throw new Error('CSV is empty');
  const columns = nonEmpty[0].map((c) => String(c).trim());
  if (!columns.length || columns.some((c) => !c)) throw new Error('CSV header is missing a column name');
  const rows = nonEmpty.slice(1).map((r) => {
    const obj = {};
    columns.forEach((c, k) => { obj[c] = (r[k] ?? '').trim(); });
    return obj;
  });
  const columnStats = columns.map((c) => {
    const seen = [];
    const set = new Set();
    for (const row of rows) {
      const v = row[c];
      if (v === '' || set.has(v)) continue;
      set.add(v);
      if (seen.length < MAX_DISTINCT) seen.push(v);
    }
    return {
      name: c,
      samples: seen.slice(0, MAX_SAMPLES),
      distinct: set.size <= MAX_DISTINCT ? seen : [],
      distinctCount: set.size,
      distinctTruncated: set.size > MAX_DISTINCT,
    };
  });
  return {
    columns,
    rowCount: rows.length,
    fingerprint: fingerprintFor(columns),
    sampleRows: rows.slice(0, MAX_SAMPLE_ROWS),
    columnStats,
  };
}

function rowsOf(text) {
  const structure = analyzeCsv(text);
  const raw = readCsvRows(text);
  const nonEmpty = raw.filter((r) => r.some((c) => String(c).trim() !== ''));
  const rows = nonEmpty.slice(1).map((r) => {
    const obj = {};
    structure.columns.forEach((c, k) => { obj[c] = (r[k] ?? '').trim(); });
    return obj;
  });
  return { structure, rows };
}

// Validate and normalize a mapping (model-proposed or user-edited)
// against the file's columns. Unknown keys and invalid entries
// are dropped, never trusted — the same convention as the AI
// fill normalizers.
export function normalizeMapping(raw, columns, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'mapping must be an object' };
  const cols = new Set(columns || []);
  const out = { columns: {}, values: {}, defaultCurrency: null, symbolSuffix: null };
  const inCols = raw.columns && typeof raw.columns === 'object' && !Array.isArray(raw.columns) ? raw.columns : {};
  for (const f of MAP_COLUMN_FIELDS) {
    const v = inCols[f];
    if (typeof v === 'string' && v.trim() !== '') {
      if (!cols.has(v.trim())) continue; // a column this file does not have
      out.columns[f] = v.trim();
    }
  }
  const inValues = raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? raw.values : {};
  for (const [k, v] of Object.entries(inValues)) {
    if (typeof k === 'string' && MAP_TARGETS.includes(v)) out.values[k.trim()] = v;
  }
  if (raw.defaultCurrency === 'CAD' || raw.defaultCurrency === 'USD') out.defaultCurrency = raw.defaultCurrency;
  if (raw.symbolSuffix && typeof raw.symbolSuffix === 'object' && !Array.isArray(raw.symbolSuffix)) {
    const suffix = raw.symbolSuffix.suffix;
    const when = raw.symbolSuffix.whenCurrency;
    if (typeof suffix === 'string' && /^\.[A-Za-z]{1,5}$/.test(suffix.trim())) {
      out.symbolSuffix = {
        suffix: suffix.trim(),
        whenCurrency: when === 'CAD' || when === 'USD' ? when : null,
      };
    }
  }
  // The engine path (default) rejects a mapping with no currency
  // source at all; the proposal path allows it so the user can
  // fix it in the editor, and asks about it instead.
  if (!opts.allowMissingCurrency && !out.columns.currency && !out.defaultCurrency) {
    return { error: 'mapping needs a currency column or a default currency' };
  }
  return { mapping: out };
}

const MAP_PROMPT = [
  'You map the columns of an unknown broker\'s CSV export to investment events. Reply with ONLY a JSON object — no prose, no code fences.',
  'Form: {"columns": {"date": "<exact column name>", "symbol": "<exact column name>", "name": "<exact column name>"|null, "activity": "<exact column name>", "activity2": "<exact column name>"|null, "units": "<exact column name>"|null, "price": "<exact column name>"|null, "amount": "<exact column name>"|null, "currency": "<exact column name>"|null, "splitAdded": "<exact column name>"|null, "splitNew": "<exact column name>"|null, "splitOld": "<exact column name>"|null}, "values": {"<exact activity value>": "buy"|"sell"|"grant"|"dividend"|"split"|"skip"}, "defaultCurrency": "CAD"|"USD"|null, "symbolSuffix": {"suffix": ".TO", "whenCurrency": "CAD"|"USD"|null}|null, "questions": ["..."], "reply": "..."}',
  'Rules:',
  '- Column names and activity values must be copied EXACTLY from the file summary below; never invent one.',
  '- "columns.date", "columns.symbol" and "columns.activity" are required; the rest are null when the file has no such column.',
  '- "values" maps every distinct activity value you can identify: a purchase word -> "buy", a sale word -> "sell", a grant/vesting word -> "grant", a dividend/distribution word -> "dividend", a split/subdivision word -> "split", a cash-flow word (deposit, withdrawal, interest, fee, tax) -> "skip".',
  '- When the file has BOTH a type column (Trade, Dividend, Interest, …) and a sub-type column (BUY, SELL, -, EFT, …) and one column alone would map different operations to the same value — a Trade column covering both buys and sells, or a "-" / blank sub-type that is a dividend under Dividend but cash under Interest — map BOTH: "activity" is the type column, "activity2" is the sub-type column, and "values" keys are "Type / Subtype" pairs (a blank second part is written as an empty string after the separator, e.g. "Dividend / "). Never decide a bare "-" or blank sub-type on its own: under a dividend/distribution type it is "dividend", under an interest/cash type it is "skip". When a single column already separates every operation, leave "activity2" null and use plain values.',
  '- A split row either carries ratio columns (map splitNew/splitOld) or an added-units column (map splitAdded) — map whichever the file has, never both.',
  '- "defaultCurrency" is the holding currency when the file has no currency column; use it only when the file or account context states it, else null.',
  '- "symbolSuffix" only when the evidence supports it (e.g. a CAD account whose tickers are bare Toronto symbols that need ".TO"); "whenCurrency" restricts it to that currency, null means always.',
  '- NEVER GUESS: any column, value or currency you cannot determine is left out of the mapping and asked about in "questions" instead. Asking is always better than inventing.',
  '- Keep "reply" short and concrete, naming anything you left unmapped.',
].join('\n');

export function buildMapMessages(structure) {
  return [
    { role: 'system', content: MAP_PROMPT },
    {
      role: 'user',
      content: `CSV structure: ${structure.rowCount} data rows.\n${structureSummary(structure)}`,
    },
  ];
}

// The file summary the model sees: columns, samples, distinct
// values — never per-row figures. Shared by the first mapping
// and every follow-up revision so both see exactly the same
// evidence.
function structureSummary(structure) {
  const stats = structure.columnStats.map((s) => {
    const bits = [`- ${s.name}: samples [${s.samples.join(', ')}]`];
    if (s.distinctTruncated) bits.push(`(${s.distinctCount} distinct values, too many to list)`);
    else if (s.distinct.length) bits.push(`distinct [${s.distinct.join(', ')}]`);
    return bits.join(' ');
  }).join('\n');
  const samples = structure.sampleRows.map((r) => JSON.stringify(r)).join('\n');
  return `Columns: ${structure.columns.join(', ')}\n${stats}\nSample rows:\n${samples}`;
}

const MAP_FOLLOWUP_PROMPT = [
  'You revise a CSV column mapping for an unknown broker\'s export, after the user looked at the preview and found something wrong. Reply with ONLY a JSON object — no prose, no code fences.',
  'Form: {"columns": {"date": "<exact column name>", "symbol": "<exact column name>", "name": "<exact column name>"|null, "activity": "<exact column name>", "activity2": "<exact column name>"|null, "units": "<exact column name>"|null, "price": "<exact column name>"|null, "amount": "<exact column name>"|null, "currency": "<exact column name>"|null, "splitAdded": "<exact column name>"|null, "splitNew": "<exact column name>"|null, "splitOld": "<exact column name>"|null}, "values": {"<exact activity value>": "buy"|"sell"|"grant"|"dividend"|"split"|"skip"}, "defaultCurrency": "CAD"|"USD"|null, "symbolSuffix": {"suffix": ".TO", "whenCurrency": "CAD"|"USD"|null}|null, "questions": ["..."], "reply": "..."}',
  'Rules:',
  '- Return the COMPLETE revised mapping, not a delta: every column and value target, including the parts the user did not mention.',
  '- Keep everything the user did not mention EXACTLY as it is in the current mapping below — same columns, same value targets, same currency, same symbol suffix. Change only what the user\'s message asks to change, plus what that change mechanically requires (if the user says the units live in another column, move the units column; if they say a value means something else, flip that value\'s target).',
  '- Column names and activity values must be copied EXACTLY from the file summary or from the current mapping; never invent one. Activity keys follow the activity columns you return: plain values for one activity column, "Type / Subtype" pairs for two (a blank second part is written as an empty string after the separator, e.g. "Dividend / "). Never decide a bare "-" or blank sub-type on its own: under a dividend/distribution type it is "dividend", under an interest/cash type it is "skip".',
  '- A split row either carries ratio columns (map splitNew/splitOld) or an added-units column (map splitAdded) — map whichever the file has, never both.',
  '- NEVER GUESS: anything the user\'s message raises that you cannot determine from the file summary or the current mapping stays as it is in the current mapping and is asked about in "questions" instead. Asking is always better than inventing.',
  '- Keep "reply" short and concrete, naming exactly what you changed and why, in the user\'s terms.',
].join('\n');

// Follow-up messages: the same file summary as the first
// mapping, the current mapping, the capped prior turns, and the
// user's latest message. The model never sees per-row figures —
// only the summary, same as the first proposal.
export function buildFollowupMessages(structure, currentMapping, message, history = []) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && typeof t.message === 'string' && t.message.trim() && typeof t.reply === 'string')
    .slice(-5);
  const turnsText = turns.length
    ? `\nEarlier in this conversation:\n${turns.map((t) => `User: ${t.message}\nYou: ${t.reply}`).join('\n')}`
    : '';
  return [
    { role: 'system', content: MAP_FOLLOWUP_PROMPT },
    {
      role: 'user',
      content: `CSV structure: ${structure.rowCount} data rows.\n${structureSummary(structure)}\nCurrent mapping:\n${JSON.stringify(currentMapping)}${turnsText}\nUser's latest message: ${message}`,
    },
  ];
}

// Revise a mapping from a follow-up message. Same validation
// shape as proposeCsvMapping: the reply must be JSON, unknown
// columns and invalid targets are dropped by normalizeMapping,
// and anything the model left unidentified becomes a question
// for the editor instead of a guess.
export async function reviseCsvMapping(structure, currentMapping, message, history = [], deps = {}) {
  if (!currentMapping || typeof currentMapping !== 'object' || Array.isArray(currentMapping)) {
    throw new Error('a current mapping is required');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('a follow-up message is required');
  }
  const call = deps.callLlm || callLlm;
  const raw = await call(buildFollowupMessages(structure, currentMapping, message, history), process.env, deps.model || null);
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AI mapping reply was not valid JSON');
  }
  const { mapping, error } = normalizeMapping(parsed, structure.columns, { allowMissingCurrency: true });
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 10)
    : [];
  if (error) throw new Error(`AI mapping is unusable: ${error}`);
  for (const f of MAP_REQUIRED_FIELDS) {
    if (!mapping.columns[f]) {
      questions.push(`The model did not identify a ${f} column — please pick it below.`);
    }
  }
  if (!mapping.columns.currency && !mapping.defaultCurrency) {
    questions.push('No currency column or default currency was identified — please pick one below.');
  }
  return {
    mapping,
    questions,
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
  };
}
export async function proposeCsvMapping(structure, deps = {}) {
  const call = deps.callLlm || callLlm;
  const raw = await call(buildMapMessages(structure), process.env, deps.model || null);
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AI mapping reply was not valid JSON');
  }
  const { mapping, error } = normalizeMapping(parsed, structure.columns, { allowMissingCurrency: true });
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 10)
    : [];
  if (error) throw new Error(`AI mapping is unusable: ${error}`);
  for (const f of MAP_REQUIRED_FIELDS) {
    if (!mapping.columns[f]) {
      questions.push(`The model did not identify a ${f} column — please pick it below.`);
    }
  }
  if (!mapping.columns.currency && !mapping.defaultCurrency) {
    questions.push('No currency column or default currency was identified — please pick one below.');
  }
  return {
    mapping,
    questions,
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
  };
}

// One pass over mapped rows (stable date order) with the given
// row indices skipped (guard-failed sells from a previous pass).
// Mirrors the Wealthsimple processor's shape so the same guard,
// dedup and apply paths serve both importers.
function processMappedRows(rows, mapping, existing, skipIndices) {
  const holdings = [];
  const events = [];
  const failed = [];
  const skipped = { byType: {}, total: 0 };
  let duplicates = 0;
  const bySymbol = new Map();
  const byLabel = new Map();
  const seenKeys = new Set();

  for (const h of existing.holdings) {
    const key = `id:${h.id}`;
    const recorded = (existing.eventsByHolding && existing.eventsByHolding[h.id]) || [];
    const state = {
      holdingId: h.id, holdingRef: null, label: h.label,
      symbol: h.symbol ? String(h.symbol).toUpperCase() : null,
      currency: h.currency, csvPosition: 0, csvSplits: [], recorded,
    };
    if (state.symbol) bySymbol.set(state.symbol, state);
    if (h.label) byLabel.set(String(h.label).toLowerCase(), state);
    for (const e of recorded) {
      seenKeys.add(dupKey(key, { date: e.date, type: e.type, units: e.units, price: e.price, amount: e.amount, splitNew: e.split_new ?? e.splitNew, splitOld: e.split_old ?? e.splitOld }));
    }
  }

  const fail = (summary, reason) => { failed.push({ summary, reason }); };
  // Position held just before `date`, in terms current at that
  // date: recorded lots restated by every split between the lot
  // and the date — recorded splits AND splits already processed
  // from this file (a CSV split restates recorded lots exactly
  // like a recorded one does) — plus the CSV-side position,
  // which each processed split scales by its ratio.
  const positionBefore = (state, date) => {
    let pos = 0;
    for (const e of state.recorded) {
      if (e.date >= date) continue;
      if (e.type !== 'buy' && e.type !== 'grant' && e.type !== 'sell') continue;
      let f = 1;
      const restate = (s) => {
        if (s.date > e.date && s.date < date) {
          const n = Number(s.split_new ?? s.splitNew);
          const o = Number(s.split_old ?? s.splitOld);
          if (Number.isFinite(n) && Number.isFinite(o) && n > 0 && o > 0) f *= n / o;
        }
      };
      for (const s of state.recorded) if (s.type === 'split') restate(s);
      for (const s of state.csvSplits) restate(s);
      pos += (e.type === 'sell' ? -1 : 1) * Number(e.units || 0) * f;
    }
    return pos + state.csvPosition;
  };
  const cols = mapping.columns;
  const ordered = rows.map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const da = a.row[cols.date] || '';
      const db = b.row[cols.date] || '';
      return da < db ? -1 : da > db ? 1 : a.i - b.i;
    });

  for (const { row, i } of ordered) {
    if (skipIndices.has(i)) continue;
    const date = row[cols.date];
    if (!isDateStr(date)) { fail(`${row[cols.symbol] || '(no symbol)'} ${date || '(no date)'}`, 'missing or invalid date'); continue; }
    const rawActivity = activityKeyOf(row, cols);
    const shownActivity = cols.activity2 ? activityKeyLabel(rawActivity, true) : rawActivity;
    const target = mapping.values[rawActivity];
    if (target === undefined) { fail(`${date} ${row[cols.symbol] || '(no symbol)'} ${shownActivity || '(no activity)'}`, `no mapping for activity value "${shownActivity}"`); continue; }
    if (target === 'skip') {
      skipped.byType[shownActivity || '(blank)'] = (skipped.byType[shownActivity || '(blank)'] || 0) + 1;
      skipped.total += 1;
      continue;
    }
    const rawSymbol = (row[cols.symbol] || '').trim();
    if (!rawSymbol) { fail(`${date} ${rawActivity}`, 'no symbol on the row'); continue; }
    // Resolve the holding: the raw ticker first, then the
    // suffixed form (a file with no name column must still find
    // an existing XQQ.TO holding from a bare XQQ row), then the
    // label. The conflict rule below still guards the match: a
    // label- or suffix-matched holding whose stored symbol differs
    // from this row's mapped symbol loses, and the row resolves
    // on its own.
    let state = bySymbol.get(rawSymbol.toUpperCase());
    if (!state && mapping.symbolSuffix) state = bySymbol.get(rawSymbol.toUpperCase() + mapping.symbolSuffix.suffix);
    const rawLabel = cols.name ? (row[cols.name] || '').trim() : '';
    if (!state && rawLabel) state = byLabel.get(rawLabel.toLowerCase());
    const currency = (cols.currency ? (row[cols.currency] || '').trim().toUpperCase() : '') || mapping.defaultCurrency;
    if (!currency) { fail(`${date} ${rawSymbol} ${rawActivity}`, 'no currency on the row and no default currency'); continue; }
    let symbol = rawSymbol.toUpperCase();
    if (mapping.symbolSuffix
      && (mapping.symbolSuffix.whenCurrency == null || mapping.symbolSuffix.whenCurrency === currency)
      && !symbol.includes('.')) {
      symbol += mapping.symbolSuffix.suffix;
    }
    if (state && state.symbol && state.symbol !== symbol) state = bySymbol.get(symbol) || null;
    if (!state) {
      const ref = `h${holdings.length + 1}`;
      const label = (rawLabel || symbol).slice(0, 160);
      if (!label) { fail(`${date} ${rawSymbol} ${rawActivity}`, 'no holding name on the row'); continue; }
      holdings.push({ ref, label, kind: 'exchange', symbol, fundCode: null, currency });
      state = { holdingId: null, holdingRef: ref, label, symbol, currency, csvPosition: 0, csvSplits: [], recorded: [] };
      bySymbol.set(symbol, state);
      if (label) byLabel.set(label.toLowerCase(), state);
    } else if (!state.currency) {
      state.currency = currency;
    }
    const holdingKey = state.holdingId != null ? `id:${state.holdingId}` : `ref:${state.holdingRef}`;
    const targetRef = state.holdingId != null ? { holdingId: state.holdingId, holdingRef: null } : { holdingId: null, holdingRef: state.holdingRef };
    const summary = `${date} ${symbol} ${shownActivity}`;

    let ev = null;
    if (target === 'buy' || target === 'sell' || target === 'grant') {
      const units = numOrNull(cols.units ? row[cols.units] : null);
      if (units == null || units === 0) { fail(summary, 'missing or zero quantity'); continue; }
      let price = numOrNull(cols.price ? row[cols.price] : null);
      let priceDerived = false;
      if (target !== 'grant' && (price == null || price <= 0)) {
        // Totals print signed (buys negative, sells positive);
        // the per-unit price derives from the absolute total.
        const amount = numOrNull(cols.amount ? row[cols.amount] : null);
        if (amount != null && amount !== 0) { price = round4(Math.abs(amount) / Math.abs(units)); priceDerived = true; }
        else { fail(summary, 'missing or invalid unit price'); continue; }
      }
      if (target === 'grant' && price != null && price <= 0) price = null;
      ev = { ...targetRef, date, type: target, units: Math.abs(units), price, amount: null, splitNew: null, splitOld: null, note: null, priceDerived: priceDerived || undefined };
    } else if (target === 'dividend') {
      const amount = numOrNull(cols.amount ? row[cols.amount] : null);
      if (amount == null || amount <= 0) { fail(summary, 'missing or invalid dividend amount'); continue; }
      ev = { ...targetRef, date, type: 'dividend', units: null, price: null, amount, splitNew: null, splitOld: null, note: null };
    } else { // split
      if (cols.splitNew && cols.splitOld) {
        const sn = numOrNull(row[cols.splitNew]);
        const so = numOrNull(row[cols.splitOld]);
        if (sn == null || so == null || sn <= 0 || so <= 0 || sn === so) { fail(summary, 'missing or invalid split ratio'); continue; }
        ev = { ...targetRef, date, type: 'split', units: null, price: null, amount: null, splitNew: sn, splitOld: so, note: null };
      } else if (cols.splitAdded) {
        const added = numOrNull(row[cols.splitAdded]);
        const p = positionBefore(state, date);
        if (added == null || added === 0) { fail(summary, 'missing or zero split quantity'); continue; }
        if (p <= 0) { fail(summary, 'cannot derive a split ratio — no position held before this date'); continue; }
        const splitNew = p + added;
        if (splitNew <= 0 || splitNew === p) { fail(summary, 'split quantity does not change the position'); continue; }
        ev = { ...targetRef, date, type: 'split', units: null, price: null, amount: null, splitNew, splitOld: p, note: null };
      } else {
        fail(summary, 'split row has no usable ratio mapping');
        continue;
      }
    }

    const key = dupKey(holdingKey, ev);
    if (seenKeys.has(key)) { duplicates += 1; continue; }
    seenKeys.add(key);
    events.push({ ...ev, _row: i, _symbol: symbol });
    if (ev.type === 'buy') state.csvPosition += ev.units;
    else if (ev.type === 'sell') state.csvPosition -= ev.units;
    else if (ev.type === 'split') {
      // A split scales every lot by its ratio, whatever its
      // source — so the CSV-side position scales too, and the
      // split joins the list that restates recorded lots for
      // later derivations.
      state.csvPosition *= ev.splitNew / ev.splitOld;
      state.csvSplits.push({ date, splitNew: ev.splitNew, splitOld: ev.splitOld });
    }
  }
  return { holdings, events, skipped, duplicates, failed };
}

// Full mapped parse: rows -> preview, re-running without
// guard-failed sells until stable (same accumulation rule as
// the Wealthsimple importer — a sell dropped on re-run keeps
// its reason reported).
export function applyMappedCsv(text, mapping, existing = { holdings: [], eventsByHolding: {} }) {
  const { structure, rows } = rowsOf(text);
  const { mapping: norm, error } = normalizeMapping(mapping, structure.columns);
  if (error) throw new Error(error);
  for (const f of MAP_REQUIRED_FIELDS) {
    if (!norm.columns[f]) throw new Error(`mapping is missing the ${f} column`);
  }
  if (!rows.length) throw new Error('no activity rows found in CSV');
  let skip = new Set();
  let result = null;
  const guardByRow = new Map();
  for (let pass = 0; pass < 10; pass++) {
    result = processMappedRows(rows, norm, existing, skip);
    const failures = guardFailures(result.events, existing);
    for (const f of failures) guardByRow.set(f.row, f);
    if (!failures.length) break;
    const next = new Set([...skip, ...failures.map((f) => f.row)]);
    if (next.size === skip.size) break;
    skip = next;
  }
  const failed = [...result.failed, ...[...guardByRow.values()].map((f) => ({ summary: f.summary, reason: f.reason }))];
  const failedRows = new Set(guardByRow.keys());
  const events = result.events
    .filter((e) => !failedRows.has(e._row))
    .map(({ _row, _symbol, ...rest }) => rest);
  const usedRefs = new Set(events.filter((e) => e.holdingRef).map((e) => e.holdingRef));
  const holdings = result.holdings.filter((h) => usedRefs.has(h.ref));
  return { holdings, events, skipped: result.skipped, duplicates: result.duplicates, failed };
}
