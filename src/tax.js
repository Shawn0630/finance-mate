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
  'employment', 'rental', 'rrsp', 'investment_income',
  'capital_gain', 'other_income', 'deduction', 'credit',
];
export const TAX_ITEM_STATUSES = ['expected', 'linked', 'confirmed', 'excluded'];
export const TAX_FILING_STATUSES = ['open', 'filed'];

// Guided-return sections (TurboTax-style checklist). Review
// has no kinds — it summarises the other three.
export const TAX_SECTIONS = [
  { key: 'income', label: 'Income', kinds: ['employment', 'rental', 'investment_income', 'capital_gain', 'other_income'] },
  { key: 'deductions', label: 'Deductions', kinds: ['rrsp', 'deduction'] },
  { key: 'credits', label: 'Credits', kinds: ['credit'] },
];
export function sectionForKind(kind) {
  for (const s of TAX_SECTIONS) if (s.kinds.includes(kind)) return s.key;
  return 'income';
}
// Per-section checklist state: how many items are still
// 'expected' (derived, not yet reviewed — the work left in the
// section), how many are linked/confirmed, and the section's
// effective total (excluded items never count).
export function sectionSummary(items) {
  const out = {};
  for (const s of TAX_SECTIONS) {
    const rows = (items || []).filter((i) => s.kinds.includes(i.kind));
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
    const eff = effectiveAmount(it);
    byKind[it.kind] = round2((byKind[it.kind] || 0) + eff);
    total = round2(total + eff);
  }
  return { byKind, total };
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
export function buildExpectedContext({ taxYear, jobRows, rentalRows, planRows, dividendRows, sellRows, payroll }) {
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
    rentals.push({
      id: r.id, label: r.label,
      gross: c.grossWhole, deductible: c.deductibleExpenses,
      net: c.netWhole9946,
      ownerUsernames: parseOwners(r.propertyOwners),
    });
  }
  const plans = [];
  for (const p of planRows || []) {
    if (p.accountType !== 'RRSP') continue; // TFSA buys are not a deduction
    const ownAnnual = planOwnAnnual(p);
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
// ('projected' — the plan may not have generated yet).
export function planOwnAnnual(plan) {
  const year = Number(plan.taxYear);
  const events = plan.events || [];
  const actual = events
    .filter((e) => e.type === 'buy' && Number(String(e.date).slice(0, 4)) === year)
    .reduce((s, e) => s + (Number(e.own_amount) || 0), 0);
  if (actual > 0) { plan._basis = 'actual'; return round2(actual); }
  const perPeriodGross = planJobPerPeriodGross(plan.job || {});
  const amounts = planPeriodAmounts(plan, perPeriodGross);
  if (!(amounts.own > 0)) return 0;
  const start = plan.start_date;
  if (!start || start > `${year}-12-31`) return 0;
  const due = payDatesFrom(plan.jobFrequency || (plan.job && plan.job.frequency), start, `${year}-12-31`)
    .filter((d) => d >= `${year}-01-01` && d <= `${year}-12-31`
      && d >= start && !(plan.deletedDueDates || []).includes(d));
  if (!due.length) return 0;
  plan._basis = 'projected';
  return round2(amounts.own * due.length);
}

// ------------------------------------------------------------- generate --
// Upsert one filing's (or the unlinked bucket's, filingId null)
// expected items from the region's derived list. Only
// 'expected' items are refreshed or pruned; user-owned
// ('linked'/'confirmed'/'excluded') items are never touched.
// Returns { added, updated, removed }.
export function upsertExpectedItems(db, { filingId, taxYear, derived }) {
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT * FROM tax_items WHERE filing_id IS ? AND tax_year = ? AND source_type IS NOT NULL ORDER BY id',
  ).all(filingId, taxYear);
  const byKey = new Map(existing.map((r) => [`${r.source_type}:${r.source_id}`, r]));
  const seen = new Set();
  let added = 0;
  let updated = 0;
  for (const d of derived || []) {
    const key = `${d.sourceType}:${d.sourceId}`;
    seen.add(key);
    const row = byKey.get(key);
    if (!row) {
      db.prepare(`INSERT INTO tax_items
        (filing_id, tax_year, kind, label, source_type, source_id, slip_id, amount, currency, share_pct, status, detail, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'expected', ?, NULL, ?, ?)`)
        .run(filingId, taxYear, d.kind, d.label, d.sourceType, d.sourceId,
          d.amount, d.currency || 'CAD', d.sharePct == null ? 100 : d.sharePct,
          JSON.stringify(d.detail || {}), now, now);
      added += 1;
    } else if (row.status === 'expected') {
      const detail = JSON.stringify(d.detail || {});
      const ch = db.prepare(`UPDATE tax_items SET kind = ?, label = ?, amount = ?, currency = ?,
        share_pct = ?, detail = ?, updated_at = ? WHERE id = ? AND
        (kind != ? OR label != ? OR amount != ? OR currency != ? OR share_pct != ? OR detail != ?)`)
        .run(d.kind, d.label, d.amount, d.currency || 'CAD', d.sharePct == null ? 100 : d.sharePct,
          detail, now, row.id, d.kind, d.label, d.amount, d.currency || 'CAD',
          d.sharePct == null ? 100 : d.sharePct, detail);
      if (ch.changes) updated += 1;
    }
  }
  let removed = 0;
  for (const row of existing) {
    if (row.status !== 'expected') continue;
    if (seen.has(`${row.source_type}:${row.source_id}`)) continue;
    db.prepare('DELETE FROM tax_items WHERE id = ?').run(row.id);
    removed += 1;
  }
  return { added, updated, removed };
}

// Re-exported for the server's rental read path reuse in tests.
export { calcRentalYear, deriveRentalYearFigures };
