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
    const cell = { ...r, annual: round2(costAnnual(r)) };
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
// basis, notes} or {error}.
export function validCostInput(b) {
  if (!b || typeof b !== 'object') return { error: 'a cost entry is required' };
  const year = Number(b.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return { error: 'year must be a whole year between 1900 and 2100' };
  }
  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category) return { error: 'category is required' };
  if (category.length > 80) return { error: 'category is too long (max 80 characters)' };
  const amount = b.amount === '' || b.amount === null || b.amount === undefined ? null : Number(b.amount);
  if (amount === null || !Number.isFinite(amount) || amount < 0) {
    return { error: 'amount must be a number >= 0' };
  }
  const basis = b.basis === undefined || b.basis === null || b.basis === '' ? 'annual' : String(b.basis);
  if (!COST_BASES.includes(basis)) return { error: "basis must be 'annual' or 'monthly'" };
  const notes = b.notes === undefined || b.notes === null || String(b.notes).trim() === ''
    ? null : String(b.notes).trim().slice(0, 500);
  return { year, category, amount, basis, notes };
}

// -------------------------------------------------------------- storage

export function listCosts(db, propertyId) {
  return db.prepare('SELECT * FROM property_costs WHERE property_id = ? ORDER BY year, category').all(propertyId);
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
    `INSERT INTO property_costs (property_id, year, category, amount, basis, notes, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(property_id, year, category) DO UPDATE SET
       amount = excluded.amount, basis = excluded.basis, notes = excluded.notes,
       source = excluded.source, updated_at = excluded.updated_at`
  ).run(propertyId, v.year, v.category, v.amount, v.basis, v.notes,
    source === 'ai' ? 'ai' : 'manual', ts, ts);
}
