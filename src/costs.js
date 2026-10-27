// Property costs — a property's yearly running costs (property
// tax, strata fees, utilities, insurance…), one row per
// (property, year, category).
//
// Basis rule (the user's, 2026-10-27): some costs only come as a
// monthly figure. A row therefore stores its amount in the basis
// it was recorded in — basis 'annual' means amount IS the year's
// total (a property-tax bill); basis 'monthly' means amount is a
// MONTHLY AVERAGE and the year's total is the average × 12. Every
// pivot, total and chart works at the annual figure; the monthly
// average stays on the row so the UI can show "avg $X/mo" beside
// the annualized figure instead of making anyone do the ×12 in
// their head.
//
// Monthly detail (the user's refinement, later the same day): a
// monthly row is no longer keyed in as a pre-computed average —
// the user records the months they actually have (a JSON map
// monthlyAmounts, {"1": 312.5, "3": 298}) and the SERVER computes
// the average from them; the stored amount IS that average.
// Averages handed in directly (no monthlyAmounts) keep working —
// rows recorded before this change have no detail and read as
// "avg $X/mo" exactly as before.

// The preset categories offered in the form's datalist (and the
// vocabulary the AI fill chat prefers). Categories are free text
// otherwise — a household names its own when none of these fit.
export const COST_CATEGORIES = [
  'Property tax', 'Strata fee', 'Water', 'Electricity', 'Gas', 'Home insurance', 'Other',
];

export const COST_BASES = ['annual', 'monthly'];

// The year's figure for one row, at the annual basis every
// aggregate uses.
export function costAnnual(row) {
  if (!row || !Number.isFinite(Number(row.amount))) return 0;
  const a = Number(row.amount);
  return row.basis === 'monthly' ? a * 12 : a;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Validate + normalize a monthlyAmounts map from request JSON:
// a plain object whose keys are month numbers "1".."12" and whose
// values are non-negative amounts, with at least one month
// present. Returns { value: {"1": n, …} } or { error }.
export function parseMonthlyAmounts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'monthlyAmounts must be an object mapping month (1-12) to an amount' };
  }
  const keys = Object.keys(raw);
  if (!keys.length) return { error: 'monthlyAmounts needs at least one month' };
  const out = {};
  for (const k of keys) {
    if (!/^(1[0-2]|[1-9])$/.test(k)) {
      return { error: `monthlyAmounts has an invalid month "${k}" (use 1-12)` };
    }
    const v = raw[k] === '' || raw[k] === null || raw[k] === undefined ? NaN : Number(raw[k]);
    if (!Number.isFinite(v) || v < 0) {
      return { error: `monthlyAmounts month ${k} must be a number >= 0` };
    }
    out[k] = round2(v);
  }
  return { value: out };
}

// The average the server derives from a monthlyAmounts map —
// the mean of the months present, in cents.
export function monthlyAmountsAverage(map) {
  const vals = Object.values(map || {});
  if (!vals.length) return null;
  return round2(vals.reduce((a, b) => a + Number(b), 0) / vals.length);
}

// A stored monthly_amounts JSON string back into a normalized
// map, or null when the row carries no (usable) detail.
export function parseStoredMonthlyAmounts(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const parsed = parseMonthlyAmounts(JSON.parse(text));
    return parsed.error ? null : parsed.value;
  } catch {
    return null;
  }
}

// The twelve month figures one row contributes to a by-month
// view: an annual row spreads its total evenly; a monthly row
// lands its recorded months at their actual amounts and fills
// the months it does not carry with the average. Either way the
// twelve sum back to the row's annual figure.
export function costMonthSeries(row) {
  if (row && row.basis === 'monthly') {
    const avg = Number.isFinite(Number(row.amount)) ? Number(row.amount) : 0;
    const det = row.monthlyAmounts;
    if (det && typeof det === 'object' && !Array.isArray(det)) {
      return Array.from({ length: 12 }, (_, i) => {
        const v = det[String(i + 1)];
        return v === undefined ? avg : Number(v);
      });
    }
    return Array(12).fill(avg);
  }
  return Array(12).fill(costAnnual(row) / 12);
}

// Pivot raw rows into the shape the panel renders: the category
// columns in a stable order (presets first, in preset order; any
// other category after, alphabetically), one entry per year
// (newest first) with a cell per category that year carries, and
// each year's annual-basis total. `latest` is the newest year's
// total — the panel's headline stat.
export function pivotCosts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const present = new Set(list.map((r) => String(r.category)));
  const categories = [
    ...COST_CATEGORIES.filter((c) => present.has(c)),
    ...[...present].filter((c) => !COST_CATEGORIES.includes(c)).sort((a, b) => a.localeCompare(b)),
  ];
  const byYear = new Map();
  for (const r of list) {
    const y = Number(r.year);
    if (!byYear.has(y)) byYear.set(y, { year: y, cells: {}, total: 0 });
    const cell = { ...r, annual: round2(costAnnual(r)), months: costMonthSeries(r) };
    byYear.get(y).cells[String(r.category)] = cell;
    byYear.get(y).total = round2(byYear.get(y).total + cell.annual);
  }
  const years = [...byYear.values()].sort((a, b) => b.year - a.year);
  const latest = years.length ? { year: years[0].year, total: years[0].total } : null;
  return { categories, years, latest };
}

// Validate + normalize one cost entry from request fields (POST:
// from scratch; PUT: merged over the stored row by the caller
// passing the merged object). Returns {year, category, amount,
// basis, notes, monthlyAmounts} or {error}.
//
// For a monthly entry the caller may send monthlyAmounts (the
// months actually recorded): the stored amount is then the
// average the SERVER computes from those months — a client-sent
// amount is not trusted alongside it. Without monthlyAmounts the
// amount is taken as the average given directly (the original
// form, kept for rows recorded before per-month detail existed).
// Annual entries never carry monthlyAmounts.
export function validCostInput(b) {
  if (!b || typeof b !== 'object') return { error: 'a cost entry is required' };
  const year = Number(b.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return { error: 'year must be a whole year between 1900 and 2100' };
  }
  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category) return { error: 'category is required' };
  if (category.length > 80) return { error: 'category is too long (max 80 characters)' };
  const basis = b.basis === undefined || b.basis === null || b.basis === '' ? 'annual' : String(b.basis);
  if (!COST_BASES.includes(basis)) return { error: "basis must be 'annual' or 'monthly'" };
  let monthlyAmounts = null;
  if (basis === 'monthly' && b.monthlyAmounts !== undefined && b.monthlyAmounts !== null) {
    const parsed = parseMonthlyAmounts(b.monthlyAmounts);
    if (parsed.error) return { error: parsed.error };
    monthlyAmounts = parsed.value;
  }
  let amount;
  if (monthlyAmounts) {
    amount = monthlyAmountsAverage(monthlyAmounts);
  } else {
    amount = b.amount === '' || b.amount === null || b.amount === undefined ? null : Number(b.amount);
    if (amount === null || !Number.isFinite(amount) || amount < 0) {
      return { error: 'amount must be a number >= 0' };
    }
  }
  const notes = b.notes === undefined || b.notes === null || String(b.notes).trim() === ''
    ? null : String(b.notes).trim().slice(0, 500);
  return { year, category, amount, basis, notes, monthlyAmounts };
}

// -------------------------------------------------------------- storage

export function listCosts(db, propertyId) {
  return db.prepare('SELECT * FROM property_costs WHERE property_id = ? ORDER BY year, category')
    .all(propertyId)
    .map((r) => {
      const { monthly_amounts, ...rest } = r;
      return { ...rest, monthlyAmounts: parseStoredMonthlyAmounts(monthly_amounts) };
    });
}

export function costsView(db, propertyId) {
  const entries = listCosts(db, propertyId);
  return { entries, ...pivotCosts(entries) };
}

// Insert or overwrite one (year, category) row. The UNIQUE
// constraint makes the pair the identity: re-adding an existing
// pair replaces it (the same upsert the value-history POST uses).
export function upsertCost(db, propertyId, v, source, ts) {
  db.prepare(
    `INSERT INTO property_costs (property_id, year, category, amount, basis, monthly_amounts, notes, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(property_id, year, category) DO UPDATE SET
       amount = excluded.amount, basis = excluded.basis, monthly_amounts = excluded.monthly_amounts,
       notes = excluded.notes, source = excluded.source, updated_at = excluded.updated_at`
  ).run(propertyId, v.year, v.category, v.amount, v.basis,
    v.monthlyAmounts ? JSON.stringify(v.monthlyAmounts) : null, v.notes,
    source === 'ai' ? 'ai' : 'manual', ts, ts);
}
