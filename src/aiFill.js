// AI Fill — extract form field values from pasted text or an
// attached document (photo / PDF) with an LLM.
//
// Hard rules:
//  - Extraction NEVER writes to the database. The endpoint
//    returns candidate values; the user reviews them in the form
//    and saves with the form's own Save button.
//  - Only fields that really exist on the target form are
//    returned; unknown keys from the model are dropped and every
//    value is normalized server-side (dates YYYY-MM-DD, amounts
//    plain numbers, spread signed, enums mapped).
//  - The API key comes from the server env (LLM_API_KEY, see
//    .env.example) and is never logged; neither is the submitted
//    text or file content.
//
// Test seams (the env-var pattern the other providers use):
// LLM_STUB_RESPONSE (a JSON string) or LLM_STUB_RESPONSE_FILE (a
// path read on every call) short-circuit the network call with a
// canned model response and count as "configured".
import fs from 'node:fs';
import zlib from 'node:zlib';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const PROPERTY_FIELDS = ['address', 'notes', 'assessed_value', 'assessed_year', 'purchase_date', 'mortgage_balance', 'owners'];
export const TERM_FIELDS = [
  'lender', 'start_date', 'term_months', 'amortization_years', 'opening_balance',
  'payment_frequency', 'repayment_method', 'payment_override',
  'segment_start_date', 'segment_rate_type', 'segment_rate_mode',
  'segment_annual_rate', 'segment_spread', 'segment_compounding',
];

// The selectable models, from LLM_MODELS (comma-separated). When
// it is not set, the list is just LLM_MODEL. Same variables and
// semantics as the algorithm visualizer's AI assistant, so one
// mental model covers both apps.
export function llmModels(env = process.env) {
  const list = String(env.LLM_MODELS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const models = [...new Set(list)];
  if (!models.length && env.LLM_MODEL) models.push(String(env.LLM_MODEL).trim());
  return models.filter(Boolean);
}

export function llmDefaultModel(env = process.env) {
  if (env.LLM_MODEL) return String(env.LLM_MODEL).trim();
  return llmModels(env)[0] || null;
}

export function llmConfigured(env = process.env) {
  if (env.LLM_STUB_RESPONSE || env.LLM_STUB_RESPONSE_FILE) return true;
  return Boolean(env.LLM_API_KEY) && llmDefaultModel(env) != null;
}

// ------------------------------------------------------------- LLM call

const SYSTEM_PROMPT = [
  'You extract structured form fields from mortgage documents and user notes.',
  'Reply with ONLY a JSON object of the form {"fields": {...}} — no prose, no code fences.',
  'Use only the keys listed for the form; omit keys you cannot determine from the source.',
  'Normalization: dates as YYYY-MM-DD; money and rates as plain numbers (no $, commas or % signs);',
  'a spread versus prime as a signed number (negative when the rate is below prime, e.g. "Prime - 1.00" -> -1).',
].join('\n');

const FORM_SPECS = {
  property: [
    'Form: property.',
    'Keys: address, notes, assessed_value, assessed_year, purchase_date,',
    'mortgage_balance (the outstanding principal), owners (an array of people names).',
  ].join('\n'),
  term: [
    'Form: mortgage term.',
    'Keys: lender (bank name), start_date, term_months (term length in months), amortization_years,',
    'opening_balance (balance at term start), payment_frequency (monthly | semi_monthly | bi_weekly |',
    'accelerated_bi_weekly | weekly | accelerated_weekly), repayment_method (equal_payment | equal_principal),',
    'payment_override (a fixed monthly payment stated in the document).',
    'First rate segment keys: segment_start_date, segment_rate_type (fixed | variable),',
    'segment_rate_mode (absolute | prime_spread), segment_annual_rate (fixed or absolute segments),',
    'segment_spread (prime_spread segments), segment_compounding (semi_annual | monthly — use monthly',
    'when the document says interest is calculated at the same frequency as the payments, or compounded monthly).',
  ].join('\n'),
};

export function buildMessages(context, text, fileInfo) {
  const content = [{ type: 'text', text: (text && text.trim()) || 'Extract the fields from the attached document.' }];
  if (fileInfo) {
    if (fileInfo.type.startsWith('image/')) {
      content.push({ type: 'image_url', image_url: { url: `data:${fileInfo.type};base64,${fileInfo.data}` } });
    } else if (fileInfo.type === 'application/pdf') {
      const extracted = extractPdfText(fileInfo.bytes);
      content.push({
        type: 'text',
        text: extracted ? `Document text:\n${extracted.slice(0, 20000)}` : 'A PDF was attached, but no text could be extracted from it.',
      });
    }
  }
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${FORM_SPECS[context]}` },
    { role: 'user', content },
  ];
}

export async function callLlm(messages, env = process.env, model = null) {
  const useModel = model || llmDefaultModel(env);
  if (env.LLM_STUB_RESPONSE_FILE) {
    const raw = fs.readFileSync(env.LLM_STUB_RESPONSE_FILE, 'utf8');
    // A stub file may map model names to responses:
    // { "models": { "<model>": <response object or string>, "default": ... } }
    // — anything else is the raw model response, as before.
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
        const entry = parsed.models[useModel] ?? parsed.models.default ?? parsed.default;
        if (entry === undefined) throw new Error(`stub has no response for model ${useModel}`);
        return typeof entry === 'string' ? entry : JSON.stringify(entry);
      }
    } catch (e) {
      if (e instanceof SyntaxError) return raw; // not JSON at all — the raw response
      throw e;
    }
    return raw;
  }
  if (env.LLM_STUB_RESPONSE) return env.LLM_STUB_RESPONSE;
  const base = String(env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 180000;
  const attempt = async (m) => {
    const post = (withFormat) => fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: m, messages, temperature: 0,
        ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await post(true);
    if (res.status === 400) res = await post(false); // some providers reject response_format — retry plain
    if (!res.ok) throw new Error(`AI service returned ${res.status}`);
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI service returned no content');
    return content;
  };
  try {
    return await attempt(useModel);
  } catch (e) {
    // LLM_MODEL_FALLBACK takes over when the primary call fails
    // (the visualizer's semantics).
    const fallback = env.LLM_MODEL_FALLBACK && String(env.LLM_MODEL_FALLBACK).trim();
    if (fallback && fallback !== useModel) return attempt(fallback);
    throw e;
  }
}

// ------------------------------------------------------------- PDF text

// Best-effort text recovery from a PDF's content streams (Flate
// or plain): the (…) strings of the text-showing operators. Good
// enough for generated statements and commitment letters;
// scanned-image PDFs yield '' and the caller says so.
export function extractPdfText(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return '';
  const raw = buf.toString('latin1');
  const chunks = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const data = Buffer.from(raw.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    try { chunks.push(zlib.inflateSync(data).toString('latin1')); } catch { chunks.push(data.toString('latin1')); }
    streamRe.lastIndex = end + 9;
  }
  const parts = [];
  const strRe = /\((?:\\.|[^\\()])*\)/g;
  for (const chunk of chunks) {
    if (!/\b(Tj|TJ|BT)\b/.test(chunk)) continue;
    let sm;
    while ((sm = strRe.exec(chunk)) !== null) parts.push(decodePdfString(sm[0].slice(1, -1)));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function decodePdfString(s) {
  return s
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] || c));
}

// ------------------------------------------------------- normalization

const slug = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '');

function normStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function normNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[$,\s]/g, '').replace(/%$/, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normInt(v, lo, hi) {
  const n = normNum(v);
  if (n == null) return null;
  const i = Math.round(n);
  return i >= lo && i <= hi ? i : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function isoDate(y, mo, d) {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return isoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return isoDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  return null;
}

function normEnum(v, valid, aliases = {}) {
  const g = slug(v);
  if (valid.includes(g)) return g;
  if (aliases[g]) return aliases[g];
  const squashed = g.replace(/_/g, '');
  for (const k of valid) if (k.replace(/_/g, '') === squashed) return k;
  for (const [a, t] of Object.entries(aliases)) if (a.replace(/_/g, '') === squashed) return t;
  return null;
}

function normCompounding(v) {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  // The commitment-letter phrasing: interest "calculated not in
  // advance, at the same frequency as your payments" = monthly.
  if (s.includes('same frequency as') && s.includes('payment')) return 'monthly';
  if (s.includes('semi') && (s.includes('annual') || s.includes('annum'))) return 'semi_annual';
  const g = normEnum(v, ['monthly', 'semi_annual'], { semiannual: 'semi_annual' });
  if (g) return g;
  if (s.includes('month')) return 'monthly';
  return null;
}

function normSpread(v) {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 10 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/−/g, '-').replace(/%/g, '').trim();
  const m = /([+-])\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) {
    const n = (m[1] === '-' ? -1 : 1) * Number(m[2]);
    return Math.abs(n) <= 10 ? n : null;
  }
  const bare = normNum(s);
  return bare != null && Math.abs(bare) <= 10 ? bare : null;
}

// Validate + normalize the model's fields for a context. Unknown
// keys and unusable values are dropped; returns a plain object in
// form-fill order (term basics first, then the segment).
export function normalizeAiFields(context, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const put = (key, value) => { if (value != null) out[key] = value; };
  if (context === 'property') {
    put('address', normStr(raw.address, 300));
    put('notes', normStr(raw.notes, 1000));
    const av = normNum(raw.assessed_value);
    put('assessed_value', av != null && av >= 0 ? av : null);
    put('assessed_year', normInt(raw.assessed_year, 1900, 2100));
    put('purchase_date', normDate(raw.purchase_date));
    const mb = normNum(raw.mortgage_balance);
    put('mortgage_balance', mb != null && mb >= 0 ? mb : null);
    if (Array.isArray(raw.owners)) {
      const owners = raw.owners.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim()).slice(0, 10);
      if (owners.length) out.owners = owners;
    }
    return out;
  }
  // context === 'term'
  put('lender', normStr(raw.lender, 120));
  put('start_date', normDate(raw.start_date));
  put('term_months', normInt(raw.term_months, 1, 120));
  const ay = normNum(raw.amortization_years);
  put('amortization_years', ay != null && ay > 0 && ay <= 40 ? ay : null);
  const ob = normNum(raw.opening_balance);
  put('opening_balance', ob != null && ob >= 0 ? ob : null);
  put('payment_frequency', normEnum(raw.payment_frequency,
    ['monthly', 'semi_monthly', 'bi_weekly', 'accelerated_bi_weekly', 'weekly', 'accelerated_weekly'],
    { biweekly: 'bi_weekly', twice_monthly: 'semi_monthly', semimonthly: 'semi_monthly' }));
  put('repayment_method', normEnum(raw.repayment_method,
    ['equal_payment', 'equal_principal'],
    { annuity: 'equal_payment', straight_line: 'equal_principal' }));
  const po = normNum(raw.payment_override);
  put('payment_override', po != null && po > 0 ? po : null);
  // First rate segment. The model may answer in "kind" terms
  // (segment_kind: fixed | prime_spread | absolute, segment_rate);
  // expand those into the segment form's own fields.
  put('segment_start_date', normDate(raw.segment_start_date ?? raw.segment_start));
  let segType = normEnum(raw.segment_rate_type, ['fixed', 'variable']);
  let segMode = normEnum(raw.segment_rate_mode, ['absolute', 'prime_spread'], { prime: 'prime_spread', spread: 'prime_spread' });
  if (segType == null && segMode == null) {
    const kind = slug(raw.segment_kind);
    if (kind === 'fixed') { segType = 'fixed'; segMode = 'absolute'; }
    else if (kind === 'prime_spread') { segType = 'variable'; segMode = 'prime_spread'; }
    else if (kind === 'absolute') { segType = 'variable'; segMode = 'absolute'; }
  }
  if (segMode === 'prime_spread' && segType == null) segType = 'variable';
  if (segType === 'fixed') segMode = 'absolute';
  put('segment_rate_type', segType);
  put('segment_rate_mode', segMode);
  if (segMode !== 'prime_spread') {
    const rate = normNum(raw.segment_annual_rate ?? raw.segment_rate);
    put('segment_annual_rate', rate != null && rate >= 0 && rate <= 30 ? rate : null);
  }
  if (segType !== 'fixed' && segMode !== 'absolute') {
    put('segment_spread', normSpread(raw.segment_spread ?? raw.spread));
  }
  put('segment_compounding', normCompounding(raw.segment_compounding ?? raw.compounding));
  return out;
}

export function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1];
  try { return JSON.parse(s); } catch { /* fall through to the brace scan */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  }
  return null;
}

// ------------------------------------------------------------ endpoint

export function validateFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return { status: 400, error: 'file must be an object with name, type and data (base64).' };
  }
  const type = String(file.type || '');
  if (!type.startsWith('image/') && type !== 'application/pdf') {
    return { status: 400, error: 'Attachments must be an image or a PDF.' };
  }
  if (typeof file.data !== 'string' || !file.data) return { status: 400, error: 'file data is missing.' };
  const bytes = Buffer.from(file.data, 'base64');
  if (!bytes.length) return { status: 400, error: 'file is empty.' };
  if (bytes.length > MAX_FILE_BYTES) return { status: 413, error: 'Attachment is too large (max 10 MB).' };
  return { type, bytes, data: file.data, name: String(file.name || '') };
}

// The whole endpoint as a pure-ish function (deps injectable for
// tests): validates input, checks configuration, calls the model,
// normalizes. Returns { status, body }.
export async function handleAiFill(input, deps = {}) {
  const env = deps.env || process.env;
  const call = deps.callLlm || callLlm;
  const { context, text, file } = input || {};
  if (context !== 'property' && context !== 'term') {
    return { status: 400, body: { error: "context must be 'property' or 'term'." } };
  }
  if (!llmConfigured(env)) {
    return {
      status: 503,
      body: { error: 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.' },
    };
  }
  // The user picks the model in the panel; it must be one of the
  // configured models (LLM_MODELS, defaulting to LLM_MODEL). No
  // model in the request → the caller's default (the persisted
  // choice, else LLM_MODEL).
  const models = llmModels(env);
  let model = null;
  if (input && input.model != null && String(input.model).trim() !== '') {
    model = String(input.model).trim();
    if (!models.includes(model)) {
      return { status: 400, body: { error: `model "${model}" is not in the configured model list` } };
    }
  } else if (deps.model && models.includes(deps.model)) {
    model = deps.model;
  } else {
    model = llmDefaultModel(env);
  }
  let fileInfo = null;
  if (file != null) {
    fileInfo = validateFile(file);
    if (fileInfo.error) return { status: fileInfo.status, body: { error: fileInfo.error } };
  }
  const hasText = typeof text === 'string' && text.trim().length > 0;
  if (!hasText && !fileInfo) {
    return { status: 400, body: { error: 'Provide text or a file to extract from.' } };
  }
  let rawText;
  try {
    rawText = await call(buildMessages(context, hasText ? text : '', fileInfo), env, model);
  } catch {
    return { status: 502, body: { error: 'The AI service could not complete the extraction.' } };
  }
  const parsed = parseModelJson(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.fields || typeof parsed.fields !== 'object' || Array.isArray(parsed.fields)) {
    return { status: 502, body: { error: 'The AI response could not be read as fields.' } };
  }
  const fields = normalizeAiFields(context, parsed.fields);
  if (fields.owners && deps.mapOwners) {
    const mapped = deps.mapOwners(fields.owners);
    if (mapped && mapped.length) fields.owners = mapped;
    else delete fields.owners;
  }
  return { status: 200, body: { fields, model } };
}

// ------------------------------------------------- property costs chat
// The multi-turn sibling of AI Fill, for the Property costs
// panel. Unlike the one-shot form fill, this is a CONVERSATION:
// the model proposes cost entries, asks a follow-up whenever a
// year / period / category / property attribution is ambiguous
// (it must never guess), and revises the draft as the user
// answers. Nothing is written by the chat itself — the panel
// applies the confirmed proposal through the costs POST with
// source 'ai'. The conversation lives in the page session only.
//
// Response contract (the model replies with ONLY this JSON):
//   {"reply": "…", "proposed": [{year, category, amount, basis, notes}], "ready": bool}
//
// Basis rule: amount is stored in the basis it was recorded in —
// 'annual' = the year's total (property tax); 'monthly' = a
// monthly AVERAGE whose year total is the average × 12.

export const COSTS_CHAT_HISTORY_TURNS = 20;
export const COSTS_CHAT_TURN_CHARS = 12000;
export const MAX_CHAT_FILES = 5;

const COSTS_CHAT_PROMPT = [
  'You help the user record one property\'s yearly running costs (property tax, strata fees,',
  'utilities, insurance and similar) from bills and notes they paste or attach.',
  'Reply with ONLY a JSON object of the form',
  '{"reply": "...", "proposed": [{"year": 2025, "category": "Property tax", "amount": 4321, "basis": "annual", "notes": null}], "ready": false}',
  '— no prose outside the JSON, no code fences.',
  '',
  'The "proposed" array is the CURRENT DRAFT of new cost entries for this property: return the',
  'whole draft every time (the entries you extracted plus any the user confirmed or corrected),',
  'never entries that are already recorded (they are listed for you) unless the user is',
  'correcting one of those.',
  'Each proposed item: year (the calendar year the cost belongs to), category (prefer exactly',
  'one of: Property tax, Strata fee, Water, Electricity, Gas, Home insurance, Other — a clearly',
  'named different category is acceptable), amount (a plain number, no $ or commas), basis',
  '("annual" or "monthly"), notes (short, or null).',
  '',
  'BASIS — read carefully:',
  '- basis "annual": amount is the FULL YEAR total (e.g. an annual property-tax notice).',
  '- basis "monthly": amount is a MONTHLY AVERAGE; the year total is the average × 12.',
  '- Several months of the same bill: average them, propose basis "monthly" with the average,',
  '  and say in "reply" how many months you used and the average you computed.',
  '- Only one month given: use that month as the monthly average (basis "monthly") and say in',
  '  "reply" that the sample is a single month.',
  '- A quarterly amount: convert it — either the annual total = quarterly × 4 (basis "annual")',
  '  or the monthly average = quarterly ÷ 3 (basis "monthly") — and state the multiplier you',
  '  used in "reply". The same applies to any other non-monthly, non-annual period: convert',
  '  and state the multiplier.',
  '- When the user corrects the period of a draft item ("that was quarterly"), update that',
  '  item\'s basis/amount accordingly and say what changed in "reply".',
  '',
  'AMBIGUITY — never guess:',
  'If the year or period a figure covers, the category, or WHICH PROPERTY a bill belongs to is',
  'unclear in any way, do NOT propose the item yet: ask one focused question in "reply" and',
  'leave the item out of "proposed" (or keep it out until answered). Typical traps: a bill',
  'with no year on it; a figure that could be monthly, quarterly or annual; a strata fee that',
  'could belong to a different property.',
  '',
  '"ready" is true only when the draft covers everything the user provided and no question',
  'is outstanding; otherwise false. Keep "reply" short and concrete.',
].join('\n');

function fmtCostLine(r) {
  const amt = Number(r.amount).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return r.basis === 'monthly'
    ? `${r.year} · ${r.category} · avg $${amt}/mo (monthly basis)`
    : `${r.year} · ${r.category} · $${amt} (annual)`;
}

// Keep the conversation the model sees bounded (the visualizer's
// assistant uses the same order of limits): the last N turns,
// each turn's text capped. Only user/assistant turns pass.
export function truncateChatHistory(history) {
  if (!Array.isArray(history)) return [];
  const turns = [];
  for (const t of history) {
    if (!t || typeof t !== 'object') continue;
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    if (typeof t.content !== 'string' || !t.content.trim()) continue;
    turns.push({ role: t.role, content: t.content.slice(0, COSTS_CHAT_TURN_CHARS) });
  }
  return turns.slice(-COSTS_CHAT_HISTORY_TURNS);
}

// Validate + normalize the model's proposed entries. Unknown
// shapes, unusable years/amounts and blank categories drop out;
// basis defaults to 'annual' unless it says 'monthly'.
export function normalizeProposedCosts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const year = normInt(item.year, 1900, 2100);
    const category = normStr(item.category, 80);
    const amount = normNum(item.amount);
    if (year == null || !category || amount == null || amount < 0) continue;
    out.push({
      year,
      category,
      amount,
      basis: typeof item.basis === 'string' && item.basis.trim().toLowerCase() === 'monthly' ? 'monthly' : 'annual',
      notes: normStr(item.notes, 500),
    });
    if (out.length >= 50) break;
  }
  return out;
}

export function buildCostsChatMessages({ property, existing, draft, history, text, files }) {
  const context = [
    `Property: ${property && property.address ? property.address : '(unknown address)'}`,
    'Already recorded for this property (do not re-propose these unless the user is correcting one):',
    ...(existing && existing.length ? existing.map((r) => `- ${fmtCostLine(r)}`) : ['- (none)']),
    'Current draft proposals (the user may correct these):',
    ...(draft && draft.length ? draft.map((r) => `- ${fmtCostLine(r)}`) : ['- (none yet)']),
  ].join('\n');
  const content = [{ type: 'text', text: (text && text.trim()) || 'Please review the attached document(s).' }];
  for (const f of files || []) {
    if (f.type.startsWith('image/')) {
      content.push({ type: 'image_url', image_url: { url: `data:${f.type};base64,${f.data}` } });
    } else if (f.type === 'application/pdf') {
      const extracted = extractPdfText(f.bytes);
      content.push({
        type: 'text',
        text: extracted ? `Document text (${f.name || 'attachment'}):\n${extracted.slice(0, 20000)}` : `A PDF (${f.name || 'attachment'}) was attached, but no text could be extracted from it.`,
      });
    }
  }
  return [
    { role: 'system', content: `${COSTS_CHAT_PROMPT}\n\n${context}` },
    ...truncateChatHistory(history),
    { role: 'user', content },
  ];
}

// The fill-chat endpoint as a pure-ish function (same deps /
// error conventions as handleAiFill): validates input, checks
// configuration, calls the model, normalizes. The caller
// supplies the property and its recorded costs as deps. The chat
// itself writes nothing.
export async function handleAiFillChat(input, deps = {}) {
  const env = deps.env || process.env;
  const call = deps.callLlm || callLlm;
  const { propertyId, history, text, files, proposed } = input || {};
  if (!Number.isInteger(Number(propertyId)) || Number(propertyId) <= 0) {
    return { status: 400, body: { error: 'propertyId is required.' } };
  }
  if (!deps.property) return { status: 404, body: { error: 'property not found' } };
  if (!llmConfigured(env)) {
    return {
      status: 503,
      body: { error: 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.' },
    };
  }
  const models = llmModels(env);
  let model = null;
  if (input && input.model != null && String(input.model).trim() !== '') {
    model = String(input.model).trim();
    if (!models.includes(model)) {
      return { status: 400, body: { error: `model "${model}" is not in the configured model list` } };
    }
  } else if (deps.model && models.includes(deps.model)) {
    model = deps.model;
  } else {
    model = llmDefaultModel(env);
  }
  let fileInfos = [];
  if (files != null) {
    if (!Array.isArray(files)) return { status: 400, body: { error: 'files must be an array.' } };
    if (files.length > MAX_CHAT_FILES) {
      return { status: 400, body: { error: `Attach at most ${MAX_CHAT_FILES} files per message.` } };
    }
    for (const f of files) {
      const v = validateFile(f);
      if (v.error) return { status: v.status, body: { error: v.error } };
      fileInfos.push(v);
    }
  }
  const hasText = typeof text === 'string' && text.trim().length > 0;
  if (!hasText && !fileInfos.length) {
    return { status: 400, body: { error: 'Write a message or attach a document first.' } };
  }
  let rawText;
  try {
    rawText = await call(buildCostsChatMessages({
      property: deps.property,
      existing: deps.existing || [],
      draft: normalizeProposedCosts(proposed),
      history, text: hasText ? text : '', files: fileInfos,
    }), env, model);
  } catch {
    return { status: 502, body: { error: 'The AI service could not complete the chat.' } };
  }
  const parsed = parseModelJson(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed.reply === undefined && parsed.proposed === undefined)) {
    return { status: 502, body: { error: 'The AI response could not be read.' } };
  }
  return {
    status: 200,
    body: {
      reply: typeof parsed.reply === 'string' ? parsed.reply.slice(0, 4000) : '',
      proposed: normalizeProposedCosts(parsed.proposed),
      ready: parsed.ready === true,
      model,
    },
  };
}
