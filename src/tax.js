// Tax module — region-free logic. Everything jurisdiction-
// specific (slip kinds, which boxes count, which items the app's
// records imply) lives in the region's tax module (see
// src/regions/ca/tax.js); this file only knows the filing/item/
// slip/profile storage shape and the rules that hold for every
// region:
//
//   - a filing is one tax PROJECT: one person may have many
//     projects for one tax year, each with its own name, items,
//     slips, and on-demand Generate. Nothing generates
//     automatically — Generate runs only when the user presses
//     it on a project (generated_at records when);
//     (2026-11-08, superseded: Generate was REMOVED entirely.
//     Projects start empty; the user adds items manually via an
//     Add action, picking from the region's expected-items
//     derivation as a CANDIDATE list. Nothing generates on page
//     load, year change, or in the background, ever.)
//   - an item belongs to one filing, or to no filing (UNLINKED);
//   - an item's effective amount is amount × sharePct / 100 —
//     the split between filers is a per-item share, editable,
//     never hardcoded;
//   - 'expected' items are system-owned: Generate may refresh
//     their amounts and prune ones whose source no longer
//     derives; 'linked'/'confirmed' items are the user's and are
//     never overwritten or pruned;
//   - the detail page is sectioned like a guided return
//     (TAX_SECTIONS): Income, Deductions, Credits, then Review;
//   - the RRSP benefit estimate reuses the region's T4127-style
//     engine (calcSalary): tax without the contribution minus
//     tax with it. It is an ESTIMATE, never a T1 computation;
//   - a tax profile records a person's remaining contribution
//     room (RRSP / TFSA / RESP), user-entered from their CRA
//     Notice of Assessment, never invented;
//   - v1 is an items inventory + linking + slip capture. There
//     is NO tax computation here (no payable/refund math).
import { calcSalary, PAY_FREQUENCIES, calcRentalYear, deriveRentalYearFigures } from './earnings.js';
import { planPeriodAmounts, planJobPerPeriodGross, payDatesFrom } from './plans.js';

export const TAX_ITEM_KINDS = [
  'employment', 'rental', 'rrsp', 'resp', 'prpp', 'rpp', 'hbp',
  'investment_income', 'capital_gain', 'other_income',
  'deduction', 'disability', 'student', 'credit',
];
export const TAX_ITEM_STATUSES = ['expected', 'linked', 'confirmed', 'excluded'];
export const TAX_FILING_STATUSES = ['open', 'filed'];

// Guided-return sections (TurboTax-style checklist, user
// 2026-11-08 16:19 — supersedes the Income / Deductions /
// Credits split). Review and Finish and file are summaries,
// not kind buckets: Review totals the four sections, Finish
// and file is a completeness/readiness summary, never a filing
// calculation (v1 has no T1 math). The sub-labels name what
// each section holds, as on the TurboTax checklist.
//   - Income: T4 employment, T5 investment, T4RSP RRSP income,
//     rental properties (the T776's deductible expenses ride
//     along as a DERIVED row under their rental item — the
//     rental amount is already net, so the row never adds to
//     the section total).
//   - Registered savings plans: RRSP / PRPP / RPP / HBP
//     contributions — and RESP contributions (a registered plan;
//     tracked, non-deductible, $0 in every total).
//   - Deductions: disability amount, students, other manual
//     deductions. (The disability amount is technically a
//     non-refundable credit, not a deduction — it sits here
//     because the user placed it here.)
//   - Provincial: provincial tax credits (BC). There is no
//     separate federal-credits section in this split, so every
//     'credit' item renders here.
export const TAX_SECTIONS = [
  { key: 'income', label: 'Income', sub: 'T4 Employment income · T5 Investment income · T4RSP Income from an RRSP · Rental properties', kinds: ['employment', 'rental', 'investment_income', 'capital_gain', 'other_income'] },
  { key: 'registered', label: 'Registered savings plans', sub: 'RRSP contributions · PRPP contributions · Registered pension plan (RPP) · Home buyers plan (HBP)', kinds: ['rrsp', 'resp', 'prpp', 'rpp', 'hbp'] },
  { key: 'deductions', label: 'Deductions', sub: 'Disability amount · Students', kinds: ['deduction', 'disability', 'student'] },
  { key: 'provincial', label: 'Provincial', sub: 'Provincial tax credits (BC)', kinds: ['credit'] },
];
export function sectionForKind(kind) {
  for (const s of TAX_SECTIONS) if (s.kinds.includes(kind)) return s.key;
  return 'income';
}
// Per-section checklist state: how many items are still
// 'expected' (derived, not yet reviewed — the work left in the
// section), how many are linked/confirmed, and the section's
// effective total (excluded items never count; a derived
// rental-deduction row never adds to any total — its rental item
// already carries the net). The derived rental-deduction row
// renders in Income, under its rental item, so it counts in
// Income's row counts but in no section's amount.
export function sectionSummary(items) {
  const out = {};
  const derived = (items || []).filter((i) => i.detail && i.detail.derived);
  const regular = (items || []).filter((i) => !(i.detail && i.detail.derived));
  for (const s of TAX_SECTIONS) {
    let rows = regular.filter((i) => s.kinds.includes(i.kind));
    if (s.key === 'income') rows = rows.concat(derived);
    const counted = rows.filter((i) => i.status !== 'excluded');
    out[s.key] = {
      key: s.key, label: s.label,
      total: rows.length,
      expected: rows.filter((i) => i.status === 'expected').length,
      linked: rows.filter((i) => i.status === 'linked').length,
      confirmed: rows.filter((i) => i.status === 'confirmed').length,
      excluded: rows.filter((i) => i.status === 'excluded').length,
      amount: filingTotals(counted).total,
    };
  }
  return out;
}

// ------------------------------------------------- contribution room --
// CRA/ESDC 2026 limits, verified 2026-11-08 against CRA and ESDC
// sources: RESP lifetime contribution limit $50,000 per
// beneficiary, no annual limit; basic CESG 20% on the first
// $2,500 contributed per year (max $500/yr) to a lifetime
// maximum of $7,200 per beneficiary (CESG ends Dec 31 of the
// year the beneficiary turns 17). These constants only split a
// USER-ENTERED remaining room into contributed vs remaining —
// they never invent a room figure; a null room stays null.
export const RESP_LIFETIME_LIMIT = 50000;
export const CESG_LIFETIME_MAX = 7200;
export const CESG_ANNUAL_MAX = 500;

export function respRoomSplit(respRoom) {
  if (respRoom == null || !isFinite(Number(respRoom))) return null;
  const remaining = Math.max(0, round2(Number(respRoom)));
  return { contributed: round2(RESP_LIFETIME_LIMIT - remaining), remaining, limit: RESP_LIFETIME_LIMIT };
}
export function cesgRoomSplit(cesgRoom) {
  if (cesgRoom == null || !isFinite(Number(cesgRoom))) return null;
  const remaining = Math.max(0, round2(Number(cesgRoom)));
  return { earned: round2(CESG_LIFETIME_MAX - remaining), remaining, limit: CESG_LIFETIME_MAX };
}
// Net TFSA contributions from the app's records: buys minus
// sells across the person's TFSA accounts (cost basis, not
// market value — a sell's proceeds include its gain). Floored
// at zero; events with no price contribute nothing.
export function tfsaNetContributed(events) {
  let net = 0;
  for (const e of events || []) {
    const v = (Number(e.units) || 0) * (Number(e.price) || 0);
    if (e.type === 'buy') net += v;
    else if (e.type === 'sell') net -= v;
  }
  return round2(Math.max(0, net));
}
// RRSP contributions from the app's records: own amounts on
// generated plan buy events only. Projected due periods are not
// contributions made, so they never count here.
export function rrspContributed(events) {
  let sum = 0;
  for (const e of events || []) {
    if (e.type === 'buy') sum += Number(e.own_amount) || 0;
  }
  return round2(sum);
}
// -------------------------------------------------- room history ----
// The Tax home's Contribution room charts for year Y are keyed to
// year Y−1 (the last completed year): the 2026 view reads 2025
// records, the 2025 view reads 2024 records, and so on. The
// cutoff is the END of the last completed tax year — Dec 31 of
// Y−1 — so the home charts show the carried-forward room state
// as of that date, from previous years' history. The RRSP
// first-60-days window still governs which year a contribution
// DEDUCTS against; it does not move this cutoff. The in-project
// Tax Profile is different: it follows the person's CURRENT
// profile record plus the current project's items, with no
// cutoff at all.
export function taxRoomCutoff(asOfYear) {
  return `${Number(asOfYear)}-12-31`;
}
export function throughDate(events, cutoff) {
  if (!cutoff) return events || [];
  return (events || []).filter((e) => !e.date || String(e.date).slice(0, 10) <= cutoff);
}

// -------------------------------------------- RRSP benefit estimate --
// Tax saved by an RRSP contribution, computed with the region's
// own T4127-style engine (calcSalary — the same code Earnings
// uses): total income tax (federal + provincial) without the
// contribution minus total income tax with it. CPP/CPP2/EI are
// unchanged by an RRSP deduction (full gross), so they cancel
// out of the difference and are not part of the benefit. The
// contribution is applied to the person's jobs highest-gross
// first, up to each job's annual gross; any remainder above
// total income saves nothing. An unverified province yields a
// federal-only figure (provincialTax null) with provinceVerified
// false — the caller says so. ESTIMATE ONLY: the same
// "Estimate — actual tax is settled on the T1." disclaimer
// Earnings carries. This is not a T1 computation.
export function rrspBenefit({ jobRows, payroll, amount }) {
  const contribution = Math.max(0, round2(Number(amount) || 0));
  const jobs = (jobRows || [])
    .filter((j) => j && PAY_FREQUENCIES[j.frequency])
    .map((j) => ({
      ...j,
      annualGross: calcSalary({ ...j, bonus_total: j.bonus_total || 0, rrspDeduction: 0 }, payroll).annualGross,
    }))
    .sort((a, b) => b.annualGross - a.annualGross);
  const income = round2(jobs.reduce((s, j) => s + j.annualGross, 0));
  let remaining = contribution;
  let taxWithout = 0;
  let taxWith = 0;
  let provinceVerified = true;
  const warnings = [];
  const allocations = [];
  for (const j of jobs) {
    const periods = PAY_FREQUENCIES[j.frequency].periods;
    const base = { ...j, bonus_total: j.bonus_total || 0 };
    const calc0 = calcSalary({ ...base, rrspDeduction: 0 }, payroll);
    const allocated = Math.min(remaining, Math.max(0, j.annualGross));
    const calc1 = calcSalary({ ...base, rrspDeduction: allocated / periods }, payroll);
    taxWithout = round2(taxWithout + calc0.totalTax);
    taxWith = round2(taxWith + calc1.totalTax);
    if (!calc0.provinceVerified) provinceVerified = false;
    for (const w of calc0.warnings || []) if (!warnings.includes(w)) warnings.push(w);
    allocations.push({ employer: j.employer, gross: calc0.annualGross, allocated: round2(allocated) });
    remaining = round2(remaining - allocated);
  }
  const benefit = round2(Math.max(0, taxWithout - taxWith));
  return {
    amount: contribution,
    income,
    province: jobs.length ? jobs[0].province : null,
    provinceVerified,
    taxWithout, taxWith, benefit,
    benefitRatePct: contribution > 0 ? Math.round((benefit / contribution) * 1000) / 10 : 0,
    jobs: allocations,
    warnings,
    estimateNote: 'Estimate — actual tax is settled on the T1.',
  };
}

export const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function parseOwners(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch { return []; }
}

// The amount a filing actually counts for an item: the item's
// amount times the filer's share.
export function effectiveAmount(item) {
  const share = item.share_pct == null ? 100 : Number(item.share_pct);
  return round2(Number(item.amount || 0) * (isFinite(share) ? share : 100) / 100);
}

export function filingTotals(items) {
  const byKind = {};
  let total = 0;
  for (const it of items || []) {
    if (it.status === 'excluded') continue;
    // A derived row (the rental deduction) is a display of
    // numbers already netted in its source item — it contributes
    // $0 to every total, in every section and in Review.
    if (it.detail && it.detail.derived) continue;
    // RESP contributions are NOT tax-deductible in Canada (CRA,
    // verified 2026-11-08): an RESP item is tracked, never counted
    // in any deduction total — it contributes $0 here, in every
    // section total and in Review. The row still shows its own
    // amount; only the totals skip it.
    if (it.kind === 'resp') continue;
    const eff = effectiveAmount(it);
    byKind[it.kind] = round2((byKind[it.kind] || 0) + eff);
    total = round2(total + eff);
  }
  return { byKind, total };
}

// A rental item's deductible expenses and net, from its detail:
// a manual T776 item carries its lines (the expense lines sum
// to the deductible; gross − expenses is the net); a
// source-backed item carries the rental calc's deductible and
// net directly. The server stores deductible + net in the detail
// at write time for manual items, so this is a read, not a
// recomputation — the fallback only covers older rows.
export function rentalDeductible(item) {
  const d = (item && item.detail) || {};
  if (isFinite(Number(d.deductible))) return round2(Number(d.deductible));
  if (d.lines && typeof d.lines === 'object') {
    let s = 0;
    for (const [k, v] of Object.entries(d.lines)) {
      if (k === 'gross_rents' || k === 'other_income') continue;
      s += Number(v) || 0;
    }
    return round2(s);
  }
  return 0;
}
export function rentalNet(item) {
  const d = (item && item.detail) || {};
  if (isFinite(Number(d.net))) return round2(Number(d.net));
  const gross = isFinite(Number(d.gross)) ? Number(d.gross) : 0;
  return round2(gross - rentalDeductible(item));
}

// ------------------------------------------------------------ validation --
export function validSharePct(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 && n <= 100;
}

export function validTaxItemInput(b) {
  if (!b || typeof b !== 'object') return 'item must be an object.';
  if (!TAX_ITEM_KINDS.includes(b.kind)) return `kind must be one of ${TAX_ITEM_KINDS.join(', ')}.`;
  if (typeof b.label !== 'string' || !b.label.trim()) return 'label is required.';
  if (b.label.trim().length > 200) return 'label is too long (max 200 characters).';
  if (b.amount == null || !isFinite(Number(b.amount))) return 'amount must be a number.';
  if (b.share_pct != null && !validSharePct(b.share_pct)) return 'share must be between 0 and 100.';
  if (b.currency != null && (typeof b.currency !== 'string' || b.currency.trim().length !== 3)) {
    return 'currency must be a 3-letter code.';
  }
  if (b.notes != null && typeof b.notes !== 'string') return 'notes must be text.';
  if (b.notes != null && b.notes.length > 1000) return 'notes are too long (max 1000 characters).';
  return null;
}

export function validTaxSlipInput(b, regionTax) {
  if (!b || typeof b !== 'object') return 'slip must be an object.';
  const def = regionTax.slipKindDef(b.kind);
  if (!def) return `kind must be one of ${regionTax.slipKinds.map((s) => s.kind).join(', ')}.`;
  if (b.tax_year == null || !Number.isInteger(Number(b.tax_year)) || Number(b.tax_year) < 2000 || Number(b.tax_year) > 2100) {
    return 'tax_year must be a year between 2000 and 2100.';
  }
  if (b.fields == null || typeof b.fields !== 'object' || Array.isArray(b.fields)) {
    return 'fields must be an object of box values.';
  }
  const known = new Set(def.fields.map((f) => f.key));
  for (const k of Object.keys(b.fields)) {
    if (!known.has(k)) return `unknown field "${k}" for a ${b.kind} slip.`;
    const v = b.fields[k];
    if (v != null && typeof v !== 'string' && typeof v !== 'number') return `field "${k}" must be text or a number.`;
  }
  return null;
}

export function validTaxProfileInput(b) {
  if (!b || typeof b !== 'object') return 'profile must be an object.';
  for (const k of ['rrsp_room', 'tfsa_room', 'resp_room', 'cesg_room']) {
    const v = b[k];
    if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0)) {
      return `${k} must be a positive amount or empty.`;
    }
  }
  if (b.resp_room != null && b.resp_room > RESP_LIFETIME_LIMIT) {
    return `resp_room cannot exceed the $${RESP_LIFETIME_LIMIT.toLocaleString('en-CA')} lifetime limit.`;
  }
  if (b.cesg_room != null && b.cesg_room > CESG_LIFETIME_MAX) {
    return `cesg_room cannot exceed the $${CESG_LIFETIME_MAX.toLocaleString('en-CA')} lifetime maximum.`;
  }
  for (const k of ['resp_beneficiary', 'resp_subscriber']) {
    if (b[k] != null && (typeof b[k] !== 'string' || b[k].length > 100)) {
      return `${k} must be text (max 100 characters).`;
    }
  }
  if (b.as_of_date != null && b.as_of_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(b.as_of_date)) {
    return 'as_of_date must be a date (YYYY-MM-DD).';
  }
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 1000)) {
    return 'notes must be text (max 1000 characters).';
  }
  return null;
}

// --------------------------------------------- slip → item linking --
// Adding a slip links it to an equivalent item already in the
// project instead of creating a second one (user 2026-11-08).
// "Equivalent" is KIND + SOURCE NAME, deliberately NOT the
// amount: the slip governs (user 2026-11-08 19:28 — the T4's
// boxes are the official figures), so a candidate item whose
// amount differs by rounding — or by the app's own record of
// the source — still matches, and the link updates the item to
// the slip's figures. The amount is never part of the identity.
//
//   - kind: the slip's item kind (region slipToItemKind).
//   - source name: the slip's employer/payer name against the
//     item's detail.employer / detail.payer (job candidates
//     store detail.employer; a manual item matches only when it
//     carries one of those detail fields). Compared
//     case-insensitively with whitespace collapsed; a slip with
//     no name filled matches nothing.
//   - the pool excludes items already backed by a slip (a second
//     slip for the same source is its own item — the user edits
//     or deletes the first slip), derived rows, and excluded
//     items.
// One match → link it. Several → the server answers 409 with
// the matches and the UI asks the user which one; it never
// guesses. No match → the slip creates its item as before.
export function normalizeSourceName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  return n ? n.toLowerCase() : null;
}

export function itemSourceName(item) {
  if (!item) return null;
  let d = item.detail;
  if (typeof d === 'string') { try { d = JSON.parse(d || '{}'); } catch { d = {}; } }
  if (!d || typeof d !== 'object') return null;
  return d.employer || d.payer || null;
}

export function findSlipLinkMatches(items, itemKind, payerName) {
  const want = normalizeSourceName(payerName);
  if (!itemKind || !want) return [];
  return (items || []).filter((it) => {
    if (!it || it.kind !== itemKind) return false;
    if (it.status === 'excluded') return false;
    if (it.slip_id != null) return false;
    let d = it.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d || '{}'); } catch { d = {}; } }
    if (d && typeof d === 'object' && d.derived) return false;
    return normalizeSourceName(itemSourceName(it)) === want;
  });
}

// ------------------------------------------- expected-items context --
// Build the region's expectedItems() context from the app's rows.
// jobRows are earnJobRow-shaped ({ tax_year, employer, owner,
// calc: { annualGross }, currency }); rentalRows are
// earnRentalRow-shaped ({ id, label, property_id, owners,
// years: [{ tax_year, calc: { grossWhole, deductibleExpenses,
// netWhole9946 } }] }); planRows are invest_plans rows
// joined with their account ({ type, name, currency }) and job
// ({ owner, frequency, gross_amount, gross_basis }); dividendRows
// and sellRows are invest_events rows joined with their holding
// ({ label, currency }) and account ({ name, type, owners }).
export function buildExpectedContext({ taxYear, jobRows, rentalRows, planRows, dividendRows, sellRows, payroll, rrspWindow, t776Lines }) {
  const jobs = (jobRows || [])
    .filter((j) => Number(j.tax_year) === Number(taxYear))
    .map((j) => {
      // The gross is deduction-independent, so the zero-deduction
      // calc gives the exact annual gross (salary + that year's
      // bonuses); the RRSP deduction never enters a T4 amount.
      const calc = calcSalary({ ...j, bonus_total: j.bonus_total || 0, rrspDeduction: 0 }, payroll);
      return {
        id: j.id, employer: j.employer, owner: j.owner || null,
        annualGross: calc.annualGross, currency: j.currency || 'CAD',
      };
    });
  const rentals = [];
  for (const r of rentalRows || []) {
    const yearRow = (r.years || []).find((y) => Number(y.tax_year) === Number(taxYear));
    if (!yearRow || !yearRow.calc) continue;
    const c = yearRow.calc;
    // The T776 view of the year: the manual lines by T776 line
    // number (labels from the region's rental module, passed in
    // through ctx so this file never imports region code), and
    // the rental calc's deductible expense table (derived
    // property costs + manual rows + mortgage interest).
    const lines = (t776Lines || []).map((l) => ({
      line: l.line, label: l.label,
      amount: round2(Number((c.expensesByLine || {})[l.line]) || 0),
    }));
    const expenseRows = (c.expenseTable && c.expenseTable.rows) || [];
    rentals.push({
      id: r.id, label: r.label,
      gross: c.grossWhole,
      grossRents: round2((c.grossWhole || 0) - (c.otherIncome || 0)),
      otherIncome: c.otherIncome || 0,
      deductible: c.deductibleExpenses,
      net: c.netWhole9946,
      ownerUsernames: parseOwners(r.propertyOwners),
      lines, expenseRows,
    });
  }
  const plans = [];
  for (const p of planRows || []) {
    if (p.accountType !== 'RRSP') continue; // TFSA buys are not a deduction
    const ownAnnual = planOwnAnnual(p, rrspWindow);
    if (!(ownAnnual > 0)) continue;
    plans.push({
      id: p.id,
      label: `${p.accountName} — ${p.holdingLabel || 'RRSP'}`,
      owner: p.jobOwner || null,
      ownAnnual,
      basis: p._basis,
      currency: p.currency || 'CAD',
    });
  }
  const dividends = (dividendRows || [])
    .filter((d) => d.accountType === 'NonRegistered') // TFSA/RRSP income is not taxed in-year
    .map((d) => ({
      id: d.id, holdingLabel: d.holdingLabel, accountName: d.accountName,
      amount: Number(d.amount) || 0, currency: d.currency || 'CAD',
      ownerUsernames: parseOwners(d.accountOwners),
    }));
  const sells = (sellRows || [])
    .filter((s) => s.accountType === 'NonRegistered')
    .map((s) => ({
      id: s.id, holdingLabel: s.holdingLabel, accountName: s.accountName,
      proceeds: round2((Number(s.units) || 0) * (Number(s.price) || 0)),
      units: s.units, price: s.price, currency: s.currency || 'CAD',
      ownerUsernames: parseOwners(s.accountOwners),
    }))
    .filter((s) => s.proceeds > 0);
  return { taxYear: Number(taxYear), jobs, rentals, plans, dividends, sells };
}

// One plan's OWN contributions for a tax year: generated buy
// events are the ground truth ('actual'); with none yet, the
// year's due periods × the current per-period own amount
// ('projected' — the plan may not have generated yet). The year
// is the RRSP CONTRIBUTION WINDOW, not the calendar year: for
// tax year Y, contributions from March 1 of Y through the first
// 60 days of Y+1 (the region's rrspWindow — CRA rule). Pass no
// window and the calendar year is used (the old behaviour,
// kept for callers without a region).
export function planOwnAnnual(plan, window) {
  const year = Number(plan.taxYear);
  const start = window ? window.start : `${year}-01-01`;
  const end = window ? window.end : `${year}-12-31`;
  const events = plan.events || [];
  const actual = events
    .filter((e) => e.type === 'buy' && String(e.date) >= start && String(e.date) <= end)
    .reduce((s, e) => s + (Number(e.own_amount) || 0), 0);
  if (actual > 0) { plan._basis = 'actual'; return round2(actual); }
  const perPeriodGross = planJobPerPeriodGross(plan.job || {});
  const amounts = planPeriodAmounts(plan, perPeriodGross);
  if (!(amounts.own > 0)) return 0;
  const planStart = plan.start_date;
  if (!planStart || planStart > end) return 0;
  const due = payDatesFrom(plan.jobFrequency || (plan.job && plan.job.frequency), planStart, end)
    .filter((d) => d >= start && d <= end
      && d >= planStart && !(plan.deletedDueDates || []).includes(d));
  if (!due.length) return 0;
  plan._basis = 'projected';
  return round2(amounts.own * due.length);
}

// Re-exported for the server's rental read path reuse in tests.
export { calcRentalYear, deriveRentalYearFigures };
