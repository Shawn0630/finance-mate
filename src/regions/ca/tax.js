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
//     Income, Deductions, Credits, Review;
//   - the RRSP benefit estimate reuses the region's T4127-style
//     engine (calcSalary over the region's payroll tables —
//     src/tax.js rrspBenefit). The region provides the payroll
//     tables; it does NOT provide a second calculator;
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
//     year. ctx:
//       { taxYear,
//         jobs: [{ id, employer, owner, annualGross, currency }],
//         rentals: [{ id, label, gross, deductible, net,
//                     ownerUsernames }],
//         plans: [{ id, label, owner, ownAnnual, basis, currency }],
//         dividends: [{ id, holdingLabel, accountName, amount,
//                       currency, ownerUsernames }],
//         sells: [{ id, holdingLabel, accountName, proceeds, units,
//                   price, currency, ownerUsernames }] }
//     Item kinds: 'employment' | 'rental' | 'rrsp' |
//     'investment_income' | 'capital_gain' | 'other_income' |
//     'deduction' | 'credit'. personKey is a username, or null
//     when the app cannot determine the person — the item is then
//     UNLINKED and the user links it on the detail page; it is
//     never guessed. sharePct is the filer's share of the amount
//     (100 = whole item); a source owned by several people yields
//     one item per owner, each carrying its share. detail is free
//     JSON the UI shows beside the amount.
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
  T4A: ['box016', 'box020'],
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
        deductible: Math.round(Number(rental.deductible || 0) * 100) / 100,
        net: Math.round(Number(rental.net || 0) * 100) / 100,
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
