// Deterministic import for a Wealthsimple activities export (CSV).
// This is the mechanical sibling of the AI fill chat: no model, no
// guessing — every row maps by its activity columns or is reported
// as skipped / duplicate / failed, never silently dropped. The
// parse step writes nothing; the panel applies the reviewed preview
// through the apply endpoint, which re-validates atomically.
//
// Wealthsimple's column contract (rejected outright when it does
// not match — the importer never guesses at another format):
//   effective_date,effective_time,settlement_date,account_id,
//   account_type,activity_type,activity_sub_type,description,
//   direction,symbol,name,currency,quantity,unit_price,
//   commission,net_cash_amount
//
// Mapping rules, each pinned by a unit test:
// - Trade BUY  -> buy event, units = |quantity|, price = unit_price.
// - Trade SELL -> sell event, units = |quantity| (exports print
//   sells negative), price = unit_price.
// - Dividend   -> dividend event, amount = net_cash_amount. The
//   row's quantity column carries the same dollars, never units.
// - CorporateAction SUBDIVISION -> split event. The row's quantity
//   is the units ADDED, so the ratio derives from the running
//   position P just before it: New = P + quantity, Old = P
//   (204 held + 408 added = 3:1). P == 0 cannot derive a ratio
//   and fails with a reason.
// - MoneyMovement / Interest / Tax / BonusPayment are cash
//   activity, not holding events: counted as skipped, not lost.
// - Symbols: a CAD row with a bare ticker gains a .TO suffix
//   (XQQ -> XQQ.TO); a suffixed ticker or a non-CAD row is left
//   alone. A split row carries no currency and inherits the
//   holding's currency (from its earlier rows or the recorded
//   holding); with nowhere to inherit from it fails.
// - Duplicates reuse the AI proposal semantics: same holding,
//   same date, same type, same figures as a recorded event is
//   already recorded, not proposed again.
// - The sell guard reuses the engine's current-terms rule (the
//   same walk validInitialEvents performs over a batch): a sell
//   may move only what the holding holds on its date, lots
//   restated by every split after them. A failing sell is a
//   failed item with its reason, never a silent drop.

import { isDateStr, splitFactorAfter, validHoldingInput, validEventInput } from './investments.js';

export const WS_COLUMNS = [
  'effective_date', 'effective_time', 'settlement_date', 'account_id', 'account_type',
  'activity_type', 'activity_sub_type', 'description', 'direction', 'symbol', 'name',
  'currency', 'quantity', 'unit_price', 'commission', 'net_cash_amount',
];

const CASH_TYPES = ['MoneyMovement', 'Interest', 'Tax', 'BonusPayment'];

// Canonical number for duplicate keys: trims float dust so a
// stored 100.3 and a parsed 100.30 compare equal.
const canon = (n) => String(Math.round(Number(n) * 10000) / 10000);
const round4 = (n) => Math.round(n * 10000) / 10000;
const numOrNull = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Minimal RFC 4180 reader: quoted fields (with "" escapes), CRLF,
// trailing newline. Returns raw rows (arrays of strings, untrimmed)
// — the format-specific parsers above it decide what a header is.
// Shared with the AI-mapped CSV import, which must read files
// whose column contract is unknown until the model maps it.
export function readCsvRows(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { quoted = false; i += 1; }
      } else { field += ch; i += 1; }
    } else if (ch === '"') {
      if (field === '') { quoted = true; i += 1; }
      else { field += ch; i += 1; }
    } else if (ch === ',') { pushField(); i += 1; }
    else if (ch === '\r') { if (src[i + 1] === '\n') i += 1; pushRow(); i += 1; }
    else if (ch === '\n') { pushRow(); i += 1; }
    else { field += ch; i += 1; }
  }
  if (quoted) throw new Error('unclosed quoted field in CSV');
  if (field !== '' || row.length) pushRow();
  return rows;
}

export function parseCsvText(text) {
  const rows = readCsvRows(text);
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) throw new Error('CSV is empty');
  const header = nonEmpty[0].map((c) => String(c).trim());
  if (header.length !== WS_COLUMNS.length || header.some((c, k) => c !== WS_COLUMNS[k])) {
    throw new Error('not a Wealthsimple activities export: unexpected columns');
  }
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    WS_COLUMNS.forEach((c, k) => { obj[c] = (r[k] ?? '').trim(); });
    return obj;
  });
}

export function mapWsSymbol(raw, currency) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  if (currency === 'CAD' && !s.includes('.')) return `${s}.TO`;
  return s;
}

export const dupKey = (holdingKey, ev) => {
  const figures = ev.type === 'dividend' ? `amount ${canon(ev.amount)}`
    : ev.type === 'split' ? `split ${canon(ev.splitNew)}:${canon(ev.splitOld)}`
    : `${canon(ev.units)} @ ${canon(ev.price)}`;
  return `${holdingKey}|${ev.date}|${ev.type}|${figures}`;
};

// Recorded position just before `date`, in terms current at that
// date: every recorded lot restated by the recorded splits dated
// after it and before `date`. A CSV split's ratio needs this plus
// the CSV rows already processed for the holding — a split derives
// from everything held before it, not just the file's rows.
export function recordedPositionBefore(recordedEvents, date) {
  let pos = 0;
  for (const e of recordedEvents || []) {
    if (e.date >= date) continue;
    if (e.type === 'buy' || e.type === 'grant') {
      let f = 1;
      for (const s of recordedEvents) {
        if (s.type === 'split' && s.date > e.date && s.date < date) {
          const n = Number(s.split_new ?? s.splitNew);
          const o = Number(s.split_old ?? s.splitOld);
          if (Number.isFinite(n) && Number.isFinite(o) && n > 0 && o > 0) f *= n / o;
        }
      }
      pos += Number(e.units || 0) * f;
    } else if (e.type === 'sell') {
      let f = 1;
      for (const s of recordedEvents) {
        if (s.type === 'split' && s.date > e.date && s.date < date) {
          const n = Number(s.split_new ?? s.splitNew);
          const o = Number(s.split_old ?? s.splitOld);
          if (Number.isFinite(n) && Number.isFinite(o) && n > 0 && o > 0) f *= n / o;
        }
      }
      pos -= Number(e.units || 0) * f;
    }
  }
  return pos;
}

// One pass over the rows (in stable date order) with the given
// row indices skipped (guard-failed sells from a previous pass).
// Returns candidate holdings/events plus skipped counts, duplicate
// count, and row-processing failures. Guard failures are found by
// the caller's walk, not here.
function processRows(rows, existing, skipIndices) {
  const holdings = []; // new holdings, in first-seen order
  const events = []; // candidate events, each with _row (stripped later)
  const failed = [];
  const skipped = { byType: {}, total: 0 };
  let duplicates = 0;
  const bySymbol = new Map(); // mapped symbol -> state
  const byLabel = new Map(); // lowercased label -> state (fallback match)
  const seenKeys = new Set(); // dedup keys of recorded + proposed events

  for (const h of existing.holdings) {
    const key = `id:${h.id}`;
    const recorded = (existing.eventsByHolding && existing.eventsByHolding[h.id]) || [];
    const state = {
      holdingId: h.id, holdingRef: null, label: h.label,
      symbol: h.symbol ? String(h.symbol).toUpperCase() : null,
      currency: h.currency, csvPosition: 0, recorded,
    };
    if (state.symbol) bySymbol.set(state.symbol, state);
    if (h.label) byLabel.set(String(h.label).toLowerCase(), state);
    for (const e of recorded) {
      seenKeys.add(dupKey(key, { date: e.date, type: e.type, units: e.units, price: e.price, amount: e.amount, splitNew: e.split_new ?? e.splitNew, splitOld: e.split_old ?? e.splitOld }));
    }
  }

  const fail = (row, summary, reason) => { failed.push({ summary, reason }); };
  const summaryOf = (row, activity) => `${row.effective_date || '?'} ${row.symbol || '(no symbol)'} ${activity}`;

  const ordered = rows.map((row, i) => ({ row, i }))
    .sort((a, b) => (a.row.effective_date < b.row.effective_date ? -1 : a.row.effective_date > b.row.effective_date ? 1 : a.i - b.i));

  for (const { row, i } of ordered) {
    if (skipIndices.has(i)) continue;
    const activity = row.activity_type;
    if (CASH_TYPES.includes(activity)) {
      skipped.byType[activity] = (skipped.byType[activity] || 0) + 1;
      skipped.total += 1;
      continue;
    }
    if (!isDateStr(row.effective_date)) {
      fail(row, summaryOf(row, activity || '(no activity)'), 'missing or invalid date');
      continue;
    }
    if (activity !== 'Trade' && activity !== 'Dividend' && activity !== 'CorporateAction') {
      fail(row, summaryOf(row, activity || '(no activity)'), `unrecognized activity type ${activity || '(blank)'}`);
      continue;
    }
    if (!row.symbol) {
      fail(row, summaryOf(row, activity), 'no symbol on the row');
      continue;
    }
    // Resolve the holding: mapped symbol first, label as fallback.
    // A label match never overrides a conflicting symbol: when
    // the label-matched holding carries a different symbol, the
    // row's symbol wins and resolves on its own. A split row's
    // blank currency inherits from the state found.
    const rawSymbol = row.symbol;
    let state = bySymbol.get(String(rawSymbol).toUpperCase());
    if (!state && row.name) state = byLabel.get(String(row.name).toLowerCase());
    const currency = row.currency || (state && state.currency) || null;
    if (!currency) {
      fail(row, summaryOf(row, activity), 'no currency on the row and none to inherit');
      continue;
    }
    const symbol = mapWsSymbol(rawSymbol, currency);
    if (state && state.symbol && state.symbol !== symbol) state = bySymbol.get(symbol) || null;
    if (!state) {
      const ref = `h${holdings.length + 1}`;
      const label = (row.name || symbol || '').slice(0, 160);
      if (!label) { fail(row, summaryOf(row, activity), 'no holding name on the row'); continue; }
      holdings.push({ ref, label, kind: 'exchange', symbol, fundCode: null, currency });
      state = { holdingId: null, holdingRef: ref, label, symbol, currency, csvPosition: 0, recorded: [] };
      bySymbol.set(symbol, state);
      if (label) byLabel.set(label.toLowerCase(), state);
    } else if (!state.currency) {
      state.currency = currency;
    }
    const holdingKey = state.holdingId != null ? `id:${state.holdingId}` : `ref:${state.holdingRef}`;
    const target = state.holdingId != null ? { holdingId: state.holdingId, holdingRef: null } : { holdingId: null, holdingRef: state.holdingRef };

    let ev = null;
    if (activity === 'Trade') {
      const sub = row.activity_sub_type;
      if (sub !== 'BUY' && sub !== 'SELL') {
        fail(row, summaryOf(row, `Trade ${sub}`), `unrecognized trade type ${sub || '(blank)'}`);
        continue;
      }
      const units = numOrNull(row.quantity);
      const price = numOrNull(row.unit_price);
      if (units == null || units === 0) { fail(row, summaryOf(row, `Trade ${sub}`), 'missing or zero quantity'); continue; }
      if (price == null || price <= 0) { fail(row, summaryOf(row, `Trade ${sub}`), 'missing or invalid unit price'); continue; }
      ev = { ...target, date: row.effective_date, type: sub === 'BUY' ? 'buy' : 'sell', units: Math.abs(units), price, amount: null, splitNew: null, splitOld: null, note: null };
    } else if (activity === 'Dividend') {
      const amount = numOrNull(row.net_cash_amount);
      if (amount == null || amount <= 0) { fail(row, summaryOf(row, 'Dividend'), 'missing or invalid dividend amount'); continue; }
      ev = { ...target, date: row.effective_date, type: 'dividend', units: null, price: null, amount, splitNew: null, splitOld: null, note: null };
    } else { // CorporateAction
      if (row.activity_sub_type !== 'SUBDIVISION') {
        fail(row, summaryOf(row, `CorporateAction ${row.activity_sub_type}`), `unsupported corporate action ${row.activity_sub_type || '(blank)'}`);
        continue;
      }
      const added = numOrNull(row.quantity);
      const p = recordedPositionBefore(state.recorded, row.effective_date) + state.csvPosition;
      if (added == null || added === 0) { fail(row, summaryOf(row, 'Subdivision'), 'missing or zero split quantity'); continue; }
      if (p <= 0) { fail(row, summaryOf(row, 'Subdivision'), 'cannot derive a split ratio — no position held before this date'); continue; }
      const splitNew = p + added;
      if (splitNew <= 0 || splitNew === p) { fail(row, summaryOf(row, 'Subdivision'), 'split quantity does not change the position'); continue; }
      ev = { ...target, date: row.effective_date, type: 'split', units: null, price: null, amount: null, splitNew, splitOld: p, note: null };
    }

    const key = dupKey(holdingKey, ev);
    if (seenKeys.has(key)) { duplicates += 1; continue; }
    seenKeys.add(key);
    events.push({ ...ev, _row: i, _symbol: symbol });
    // Track the CSV-side position for later split derivation
    // (recorded lots join it through recordedPositionBefore).
    if (ev.type === 'buy') state.csvPosition += ev.units;
    else if (ev.type === 'sell') state.csvPosition -= ev.units;
    else if (ev.type === 'split') state.csvPosition = ev.splitNew - recordedPositionBefore(state.recorded, row.effective_date);
  }
  return { holdings, events, skipped, duplicates, failed };
}

// The sell guard over combined (recorded + candidate) events, per
// holding, in date order with recorded events first on ties. Only
// candidate sells can fail; a failing sell's row index is returned
// so the caller can re-run without it (its exclusion changes later
// split ratios, which changes other sells' standing).
export function guardFailures(candidates, existing) {
  const failures = [];
  const byHolding = new Map();
  for (const e of candidates) {
    const key = e.holdingId != null ? `id:${e.holdingId}` : `ref:${e.holdingRef}`;
    if (!byHolding.has(key)) byHolding.set(key, []);
    byHolding.get(key).push(e);
  }
  for (const [key, cands] of byHolding) {
    const recorded = key.startsWith('id:')
      ? ((existing.eventsByHolding && existing.eventsByHolding[Number(key.slice(3))]) || [])
      : [];
    const combined = [
      ...recorded.map((e, i) => ({ date: e.date, type: e.type, units: e.units, price: e.price, amount: e.amount, splitNew: e.split_new ?? e.splitNew, splitOld: e.split_old ?? e.splitOld, candidate: null, order: i })),
      ...cands.map((e, i) => ({ ...e, candidate: e, order: 1000000 + i })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    let balance = 0; // current-terms units
    for (const e of combined) {
      const f = splitFactorAfter(combined, e.date);
      if (e.type === 'buy' || e.type === 'grant') balance += Number(e.units || 0) * f;
      else if (e.type === 'sell') {
        const mine = Number(e.units || 0) * f;
        if (e.candidate && mine > balance + 1e-9) {
          failures.push({
            row: e.candidate._row,
            summary: `${e.date} ${e.candidate._symbol || ''} sell`.trim(),
            reason: `cannot sell ${e.units} units on ${e.date} — only ${round4(balance / f)} held`,
          });
        } else {
          balance -= mine;
        }
      }
    }
  }
  return failures;
}

// Full parse: rows -> preview. Re-runs without guard-failed sells
// until the set is stable (a dropped sell changes later split
// ratios, which can change other sells' standing); capped so a
// pathological file still terminates with its failures reported.
export function parseWealthsimpleCsv(text, existing = { holdings: [], eventsByHolding: {} }) {
  const rows = parseCsvText(text);
  if (!rows.length) throw new Error('no activity rows found in CSV');
  let skip = new Set();
  let result = null;
  // Guard failures accumulate across passes: a sell dropped on
  // re-run stops failing (it is gone), but its reason must still
  // be reported — the last pass alone would show none.
  const guardByRow = new Map();
  for (let pass = 0; pass < 10; pass++) {
    result = processRows(rows, existing, skip);
    const failures = guardFailures(result.events, existing);
    for (const f of failures) guardByRow.set(f.row, f);
    if (!failures.length) break;
    const next = new Set([...skip, ...failures.map((f) => f.row)]);
    if (next.size === skip.size) break; // stable: report what accumulated
    skip = next;
  }
  const failed = [...result.failed, ...[...guardByRow.values()].map((f) => ({ summary: f.summary, reason: f.reason }))];
  // Guard-failed sells must not reach the preview.
  const failedRows = new Set(guardByRow.keys());
  const events = result.events
    .filter((e) => !failedRows.has(e._row))
    .map(({ _row, _symbol, ...rest }) => rest);
  // A new holding with no surviving events drops out of the preview.
  const usedRefs = new Set(events.filter((e) => e.holdingRef).map((e) => e.holdingRef));
  const holdings = result.holdings.filter((h) => usedRefs.has(h.ref));
  return { holdings, events, skipped: result.skipped, duplicates: result.duplicates, failed };
}

// Validate a user-reviewed preview for the apply endpoint: shape
// through the same validators as the detail-page forms, duplicates
// re-checked (a row recorded since the preview is skipped, not
// failed), and the sell guard over the combined set. Returns
// { holdings, events, skippedDuplicates } or { error }.
export function validateImportApply(body, existing = { holdings: [], eventsByHolding: {} }) {
  const rawHoldings = Array.isArray(body && body.holdings) ? body.holdings : null;
  const rawEvents = Array.isArray(body && body.events) ? body.events : null;
  if (!rawHoldings || !rawEvents) return { error: 'holdings and events are required' };
  const holdings = [];
  const refSet = new Set();
  for (const h of rawHoldings) {
    const v = validHoldingInput({ label: h.label, kind: h.kind, symbol: h.symbol, fundCode: h.fundCode, currency: h.currency });
    if (v.error) return { error: `holding ${h.label || h.ref || '?'}: ${v.error}` };
    if (!h.ref || typeof h.ref !== 'string') return { error: 'a new holding is missing its ref' };
    if (refSet.has(h.ref)) return { error: `duplicate holding ref ${h.ref}` };
    refSet.add(h.ref);
    holdings.push({ ref: h.ref, ...v });
  }
  const existingById = new Map((existing.holdings || []).map((h) => [h.id, h]));
  const seenKeys = new Set();
  for (const h of existing.holdings || []) {
    const evs = (existing.eventsByHolding && existing.eventsByHolding[h.id]) || [];
    for (const e of evs) {
      seenKeys.add(dupKey(`id:${h.id}`, { date: e.date, type: e.type, units: e.units, price: e.price, amount: e.amount, splitNew: e.split_new ?? e.splitNew, splitOld: e.split_old ?? e.splitOld }));
    }
  }
  const events = [];
  const skippedDuplicates = [];
  for (const raw of rawEvents) {
    const holdingId = raw.holdingId != null ? Number(raw.holdingId) : null;
    const holdingRef = raw.holdingRef || null;
    if (holdingId != null && !existingById.has(holdingId)) return { error: `event references unknown holding ${holdingId}` };
    if (holdingId == null && !refSet.has(holdingRef)) return { error: 'an event belongs to a new holding that is not included' };
    const v = validEventInput({ date: raw.date, type: raw.type, units: raw.units, price: raw.price, amount: raw.amount, splitNew: raw.splitNew, splitOld: raw.splitOld, note: raw.note || null }, {});
    if (v.error) return { error: `${raw.date || '?'} ${raw.type || '?'}: ${v.error}` };
    const key = dupKey(holdingId != null ? `id:${holdingId}` : `ref:${holdingRef}`, v);
    if (seenKeys.has(key)) { skippedDuplicates.push(`${v.date} ${v.type}`); continue; }
    seenKeys.add(key);
    events.push({ holdingId, holdingRef, ...v });
  }
  // Guard over the combined set, per holding, in date order.
  const byHolding = new Map();
  for (const e of events) {
    const key = e.holdingId != null ? `id:${e.holdingId}` : `ref:${e.holdingRef}`;
    if (!byHolding.has(key)) byHolding.set(key, []);
    byHolding.get(key).push(e);
  }
  for (const [key, cands] of byHolding) {
    const recorded = key.startsWith('id:')
      ? ((existing.eventsByHolding && existing.eventsByHolding[Number(key.slice(3))]) || [])
      : [];
    const combined = [
      ...recorded.map((e, i) => ({ date: e.date, type: e.type, units: e.units, splitNew: e.split_new ?? e.splitNew, splitOld: e.split_old ?? e.splitOld, candidate: null, order: i })),
      ...cands.map((e, i) => ({ ...e, candidate: e, order: 1000000 + i })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    let balance = 0;
    for (const e of combined) {
      const f = splitFactorAfter(combined, e.date);
      if (e.type === 'buy' || e.type === 'grant') balance += Number(e.units || 0) * f;
      else if (e.type === 'sell') {
        const mine = Number(e.units || 0) * f;
        if (e.candidate && mine > balance + 1e-9) {
          return { error: `cannot sell ${e.units} units on ${e.date} — only ${round4(balance / f)} held` };
        }
        balance -= mine;
      }
    }
  }
  return { holdings, events, skippedDuplicates };
}
