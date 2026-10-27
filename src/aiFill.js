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

function validateFile(file) {
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
