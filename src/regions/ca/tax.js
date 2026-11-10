// Region Tax interface — Canada (the only region for now).
//
// The Tax module's UI and its filing/item/slip/profile storage
// are region-free. Everything that varies by tax jurisdiction
// lives behind this one module, so a later US or cross-border
// CA/US implementation plugs in without touching the UI or the
// tables. The region-free rules live in src/tax.js:
//
//   - a filing is one tax PROJECT (many per person per year);
//   - nothing generates automatically — Generate runs only on
//     the user's explicit action on a project;
//   - the detail page is sectioned (TAX_SECTIONS in src/tax.js):
//     Income, Registered savings plans, Deductions, Provincial
//     (2026-11-08 re-split; Review + Finish and file removed
//     2026-11-09);
//   - the RRSP benefit estimate reuses the region's T4127-style
//     engine (calcSalary over the region's payroll tables —
//     src/tax.js rrspBenefit). The region provides the payroll
//     tables; it does NOT provide a second calculator;
//   - the refund headline + popup (2026-11-08) DOES compute a T1:
//     computeT1 in ./t1.js, from the federal + province modules
//     (./federal.js, ./bc.js). Headline + popup only — the full
//     filing flow is still out of scope.
//   - the Tax Profile's room figures are user-entered from the
//     CRA Notice of Assessment, never derived or estimated.
//     The RESP/CESG limits (src/tax.js) only split an entered
//     remaining room into contributed vs remaining.
//
// A region's tax module must export:
//   code, label,
//   slipKinds: [{ kind, label, form, fields: [{ key, label, money }] }]
//     — the slips the region recognises (T4, T5, …) and the boxes
//     each one carries. `form` is the paper form the kind maps to
//     (e.g. 'T4' → employment income on the T1).
//   slipToItemKind(kind) -> one of the item kinds below, or null
//     when the slip does not map to a filing item.
//   slipAmount(kind, fields) -> the filing-item amount a slip
//     implies (a plain number, or null when the slip carries no
//     usable amount). Only the region knows which boxes count.
//   expectedItems(ctx) -> [{ kind, label, sourceType, sourceId,
//     personKey, amount, currency, sharePct, detail }]
//     — the filing items the app's own records imply for one tax
//     year. This is the ADD PICKER's candidate list, not a
//     generator: nothing is written until the user picks a
//     candidate (2026-11-08: Generate was removed entirely).
//     ctx:
//       { taxYear,
//         jobs: [{ id, employer, owner, annualGross, currency }],
//         rentals: [{ id, label, gross, deductible, net,
//                     ownerUsernames }],
//         plans: [{ id, label, owner, ownAnnual, basis, currency }],
//         dividends: [{ id, holdingLabel, accountName, amount,
//                       currency, ownerUsernames }],
//         sells: [{ id, holdingLabel, accountName, proceeds, units,
//                   price, currency, ownerUsernames }] }
//     Item kinds: 'employment' | 'rental' | 'rrsp' | 'resp' |
//     'prpp' | 'rpp' | 'hbp' | 'investment_income' |
//     'capital_gain' | 'other_income' | 'deduction' |
//     'disability' | 'student' | 'credit'. The derivation only
//     ever yields employment / rental / rrsp / investment_income
//     / capital_gain — prpp, rpp, hbp, disability, student,
//     resp and the generic 'deduction' are manual-only kinds
//     (the app holds no source records for them); the user adds
//     them by hand or from a receipt. personKey is a username, or null
//     when the app cannot determine the person — the item is then
//     UNLINKED and the user links it on the detail page; it is
//     never guessed. sharePct is the filer's share of the amount
//     (100 = whole item); a source owned by several people yields
//     one item per owner, each carrying its share. detail is free
//     JSON the UI shows beside the amount.
//   rrspWindow(taxYear) -> { start, end, label } — the CRA
//     first-60-days contribution window for a tax year.
//   t776FormDef(expenseLines) -> the T776 form structure (income
//     lines, numbered expense lines, computed totals/net).
//   t776Totals(lines) -> { gross, expenses, net } from a T776
//     line set. validT776Lines(lines, expenseLines) validates one.
//
// What this module deliberately does NOT do: no tax computation.
// v1 is an items inventory + linking + slip capture; the T1
// payable/refund math is a later round. (The RRSP benefit
// slider is a scoped estimate from the existing Earnings engine,
// not a return computation.)

export const code = 'CA';
export const label = 'Canada';

// The slips Canada recognises. Field keys are the slip's box
// numbers, so a slip's stored fields read like the paper slip.
export const slipKinds = [
  {
    kind: 'T4', label: 'T4 — Statement of Remuneration Paid', form: 'T1 employment income',
    fields: [
      { key: 'employer_name', label: 'Employer name' },
      { key: 'box14', label: 'Box 14 — Employment income', money: true },
      { key: 'box16', label: "Box 16 — Employee's CPP contributions", money: true },
      { key: 'box18', label: "Box 18 — Employee's EI premiums", money: true },
      { key: 'box22', label: 'Box 22 — Income tax deducted', money: true },
      { key: 'box24', label: 'Box 24 — EI insurable earnings', money: true },
      { key: 'box26', label: 'Box 26 — CPP/QPP pensionable earnings', money: true },
    ],
  },
  {
    kind: 'T4A', label: 'T4A — Pension, Retirement, Annuity, and Other Income', form: 'T1 other income',
    fields: [
      { key: 'payer_name', label: 'Payer name' },
      { key: 'box016', label: 'Box 016 — Pension or superannuation', money: true },
      { key: 'box020', label: 'Box 020 — Other income', money: true },
      { key: 'box105', label: 'Box 105 — Scholarships, bursaries, fellowships', money: true },
      { key: 'box022', label: 'Box 022 — Income tax deducted', money: true },
    ],
  },
  {
    kind: 'T5', label: 'T5 — Statement of Investment Income', form: 'T1 investment income',
    fields: [
      { key: 'payer_name', label: 'Payer name' },
      { key: 'box11', label: 'Box 11 — Taxable amount of dividends', money: true },
      { key: 'box13', label: 'Box 13 — Interest from Canadian sources', money: true },
      { key: 'box25', label: 'Box 25 — Federal tax deducted', money: true },
    ],
  },
  {
    kind: 'T3', label: 'T3 — Statement of Trust Income Allocations and Designations', form: 'T1 investment income',
    fields: [
      { key: 'payer_name', label: 'Trust name' },
      { key: 'box21', label: 'Box 21 — Capital gains', money: true },
      { key: 'box23', label: 'Box 23 — Other income', money: true },
      { key: 'box26', label: 'Box 26 — Foreign non-business income', money: true },
      { key: 'box30', label: 'Box 30 — Tax deducted', money: true },
    ],
  },
  {
    kind: 'T4RSP', label: 'T4RSP — Statement of RRSP Income', form: 'T1 other income',
    fields: [
      { key: 'payer_name', label: 'Payer name' },
      { key: 'box16', label: 'Box 16 — Annuity payments from an RRSP', money: true },
      { key: 'box22', label: 'Box 22 — Income tax deducted', money: true },
    ],
  },
  {
    kind: 'T4RIF', label: 'T4RIF — Statement of Income from a RRIF', form: 'T1 other income',
    fields: [
      { key: 'payer_name', label: 'Payer name' },
      { key: 'box16', label: 'Box 16 — Taxable amounts', money: true },
      { key: 'box22', label: 'Box 22 — Income tax deducted', money: true },
    ],
  },
  {
    kind: 'T5008', label: 'T5008 — Statement of Securities Transactions', form: 'T1 capital gains',
    fields: [
      { key: 'payer_name', label: 'Payer name' },
      { key: 'box20', label: 'Box 20 — Proceeds of disposition', money: true },
      { key: 'box21', label: 'Box 21 — Cost or book value', money: true },
    ],
  },
];

const slipKindByKind = new Map(slipKinds.map((s) => [s.kind, s]));
export function slipKindDef(kind) {
  return slipKindByKind.get(kind) || null;
}

// Which boxes of a slip count toward the filing item. Tax
// deducted never counts (it is a credit, not income); a T5008's
// box 21 is the cost base, kept in the item detail instead.
const SLIP_AMOUNT_FIELDS = {
  T4: ['box14'],
  T4A: ['box016', 'box020', 'box105'],
  T5: ['box11', 'box13'],
  T3: ['box21', 'box23', 'box26'],
  T4RSP: ['box16'],
  T4RIF: ['box16'],
  T5008: ['box20'],
};

const SLIP_ITEM_KIND = {
  T4: 'employment',
  T4A: 'other_income',
  T5: 'investment_income',
  T3: 'investment_income',
  T4RSP: 'other_income',
  T4RIF: 'other_income',
  T5008: 'capital_gain',
};

export function slipToItemKind(kind) {
  return SLIP_ITEM_KIND[kind] || null;
}

export function slipAmount(kind, fields) {
  const keys = SLIP_AMOUNT_FIELDS[kind];
  if (!keys || !fields || typeof fields !== 'object') return null;
  let total = 0;
  let seen = false;
  for (const k of keys) {
    const v = Number(fields[k]);
    if (isFinite(v) && v !== 0) { total += v; seen = true; }
    else if (isFinite(v)) seen = true;
  }
  return seen ? Math.round(total * 100) / 100 : null;
}

// The slip field carrying the payer/employer name — the
// identity a slip is matched against an existing item by when
// it is added (see findSlipLinkMatches in src/tax.js). A slip
// with no name field filled cannot be matched to an item.
const SLIP_PAYER_FIELD = {
  T4: 'employer_name',
  T4A: 'payer_name', T5: 'payer_name', T3: 'payer_name',
  T4RSP: 'payer_name', T4RIF: 'payer_name', T5008: 'payer_name',
};

export function slipPayerName(kind, fields) {
  const key = SLIP_PAYER_FIELD[kind];
  if (!key || !fields || typeof fields !== 'object') return null;
  const v = fields[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The RRSP contribution window for a tax year — the CRA
// first-60-days rule (verified 2026-11-08): contributions made
// from March 1 of the tax year through the first 60 days of the
// NEXT year count toward that tax year. The 60th day of the next
// year is March 1 in a common year and February 29 in a leap
// year; when it falls on a weekend the CRA extends the deadline
// to the next business day (the 2025 deadline was Monday,
// March 2, 2026, because March 1 was a Sunday). Returns
// { start, end, label } as ISO dates plus a display label.
export function rrspWindow(taxYear) {
  const y = Number(taxYear);
  const next = y + 1;
  const leap = (next % 4 === 0 && next % 100 !== 0) || next % 400 === 0;
  let end = new Date(Date.UTC(next, leap ? 1 : 2, leap ? 29 : 1));
  const dow = end.getUTCDay();
  if (dow === 6) end = new Date(end.getTime() + 2 * 86400000);
  else if (dow === 0) end = new Date(end.getTime() + 86400000);
  const start = `${y}-03-01`;
  const endIso = end.toISOString().slice(0, 10);
  const fmt = (s) => {
    const [yy, mm, dd] = s.split('-').map(Number);
    return new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
  };
  return { start, end: endIso, label: `${fmt(start)} – ${fmt(endIso)}` };
}

// The T776 (Statement of Real Estate Rentals) form structure.
// Income lines are the form's own: 8141 total gross rents, 8230
// other income, 8299 total gross rental income (computed). The
// numbered expense lines come from the region's rental module
// (getRegion('CA').rental.t776Lines) — the server passes them in
// so the two modules never import each other. Net is line 9946
// (gross − expenses); the net flows to T1 line 12600, the gross
// to line 12599. There is NO T5A slip in CRA's set — the
// similarly-named slip is T4A (already in slipKinds above);
// the app must never invent a T5A form.
export const T776_INCOME_LINES = [
  { key: 'gross_rents', line: '8141', label: 'Line 8141 — Total gross rents', money: true },
  { key: 'other_income', line: '8230', label: 'Line 8230 — Other income', money: true },
];
export function t776FormDef(expenseLines) {
  return {
    form: 'T776',
    label: 'T776 — Statement of Real Estate Rentals',
    income: T776_INCOME_LINES,
    expenses: (expenseLines || []).map((l) => ({
      key: l.line, line: l.line, label: `Line ${l.line} — ${l.label}`, money: true,
    })),
    totalGrossLine: { key: 'total_gross', line: '8299', label: 'Line 8299 — Total gross rental income' },
    netLine: { key: 'net', line: '9946', label: 'Line 9946 — Net rental income' },
  };
}
// Totals from a T776 line set: { gross_rents, other_income,
// '<expense line number>': amount, ... } → { gross, expenses, net }.
export function t776Totals(lines) {
  const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
  const gross = round2(num(lines.gross_rents) + num(lines.other_income));
  let expenses = 0;
  for (const [k, v] of Object.entries(lines || {})) {
    if (k === 'gross_rents' || k === 'other_income') continue;
    expenses += num(v);
  }
  expenses = round2(expenses);
  return { gross, expenses, net: round2(gross - expenses) };
}
export function validT776Lines(lines, expenseLines) {
  if (!lines || typeof lines !== 'object' || Array.isArray(lines)) {
    return 'lines must be an object of T776 line values.';
  }
  const known = new Set(['gross_rents', 'other_income', ...((expenseLines || []).map((l) => l.line))]);
  for (const [k, v] of Object.entries(lines)) {
    if (!known.has(k)) return `unknown T776 line "${k}".`;
    if (v != null && v !== '' && !isFinite(Number(v))) return `T776 line "${k}" must be a number.`;
    if (isFinite(Number(v)) && Number(v) < 0) return `T776 line "${k}" must not be negative.`;
  }
  return null;
}

// Split a source owned by several people into one expected item
// per owner, each carrying its equal share. A source with no
// known owners yields one UNLINKED item (personKey null) — the
// user links it; the split is never guessed.
function perOwnerItems(base, ownerUsernames) {
  const owners = (ownerUsernames || []).filter(Boolean);
  if (owners.length === 0) return [{ ...base, personKey: null, sharePct: 100 }];
  const share = Math.round((100 / owners.length) * 100) / 100;
  return owners.map((personKey, i) => ({
    ...base,
    personKey,
    // The last owner's share absorbs the rounding remainder so
    // the shares always sum to exactly 100.
    sharePct: i === owners.length - 1 ? Math.round((100 - share * (owners.length - 1)) * 100) / 100 : share,
  }));
}

export function expectedItems(ctx) {
  const items = [];
  const year = ctx.taxYear;
  for (const job of ctx.jobs || []) {
    if (!(Number(job.annualGross) > 0)) continue;
    items.push({
      kind: 'employment',
      label: `${job.employer} — employment income`,
      sourceType: 'job', sourceId: job.id,
      personKey: job.owner || null,
      amount: Math.round(Number(job.annualGross) * 100) / 100,
      currency: job.currency || 'CAD',
      sharePct: 100,
      detail: { employer: job.employer, taxYear: year },
    });
  }
  for (const rental of ctx.rentals || []) {
    // A rental year with no year record derives nothing; a year
    // record with zero gross and zero deductible is still an item
    // (a vacant year is a filing fact), so no amount gate here.
    if (rental.gross == null && rental.net == null) continue;
    const base = {
      kind: 'rental',
      label: `${rental.label} — rental income (T776)`,
      sourceType: 'rental', sourceId: rental.id,
      amount: Math.round(Number(rental.net || 0) * 100) / 100,
      currency: 'CAD',
      detail: {
        gross: Math.round(Number(rental.gross || 0) * 100) / 100,
        grossRents: Math.round(Number(rental.grossRents ?? rental.gross) * 100) / 100,
        otherIncome: Math.round(Number(rental.otherIncome || 0) * 100) / 100,
        deductible: Math.round(Number(rental.deductible || 0) * 100) / 100,
        net: Math.round(Number(rental.net || 0) * 100) / 100,
        // The T776 view of the rental year: the manual lines by
        // T776 line number, and the rental calc's deductible
        // expense table (derived property costs + manual rows +
        // mortgage interest — the 8710 content lives here).
        lines: rental.lines || null,
        expenseRows: rental.expenseRows || null,
        taxYear: year,
      },
    };
    items.push(...perOwnerItems(base, rental.ownerUsernames));
  }
  for (const plan of ctx.plans || []) {
    if (!(Number(plan.ownAnnual) > 0)) continue;
    items.push({
      kind: 'rrsp',
      label: `${plan.label} — RRSP contributions`,
      sourceType: 'plan', sourceId: plan.id,
      personKey: plan.owner || null,
      amount: Math.round(Number(plan.ownAnnual) * 100) / 100,
      currency: plan.currency || 'CAD',
      sharePct: 100,
      detail: { basis: plan.basis || 'actual', taxYear: year },
    });
  }
  for (const d of ctx.dividends || []) {
    if (!(Number(d.amount) > 0)) continue;
    const base = {
      kind: 'investment_income',
      label: `${d.holdingLabel} — dividends (${d.accountName})`,
      sourceType: 'dividend', sourceId: d.id,
      amount: Math.round(Number(d.amount) * 100) / 100,
      currency: d.currency || 'CAD',
      detail: { holding: d.holdingLabel, account: d.accountName, taxYear: year },
    };
    items.push(...perOwnerItems(base, d.ownerUsernames));
  }
  for (const s of ctx.sells || []) {
    if (!(Number(s.proceeds) > 0)) continue;
    const base = {
      kind: 'capital_gain',
      label: `${s.holdingLabel} — sale proceeds (${s.accountName})`,
      sourceType: 'sell', sourceId: s.id,
      amount: Math.round(Number(s.proceeds) * 100) / 100,
      currency: s.currency || 'CAD',
      detail: {
        holding: s.holdingLabel, account: s.accountName,
        units: s.units, price: s.price, proceeds: Math.round(Number(s.proceeds) * 100) / 100,
        // The app tracks proceeds, not the adjusted cost base:
        // the amount is proceeds until the user confirms the gain.
        note: 'Proceeds — confirm the gain against the cost base.',
        taxYear: year,
      },
    };
    items.push(...perOwnerItems(base, s.ownerUsernames));
  }
  return items;
}

// The T1 computation behind the refund headline + popup (see
// ./t1.js): one compute surface, federal + province modules under
// it. Re-exported so the server calls region.tax.computeT1(...)
// and the UI never sees a bracket table. countedItems is the same
// rule the T1 math uses for which items count — the server's home
// project-card balance shows a figure only when a project has at
// least one counted item, never a guessed $0.
export { computeT1, countedItems } from './t1.js';
