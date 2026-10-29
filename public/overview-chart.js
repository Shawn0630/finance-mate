// Overview asset-composition helpers: Property + Stock monthly
// history and range-end share. Pure: no DOM, no side effects,
// so the node unit tests load this exact file (via vm) instead
// of a copy — the same pattern as public/invest-share.js.
//
//   assessedByYear: [{ year, total }] — yearly assessed totals,
//     ascending by year (the /api/overview/chart shape, same
//     carry-forward rule as the property portfolio: a property
//     counts from its first known year on).
//   stockSeries: [{ month, value }] — portfolio month-end values
//     in CAD, ascending by month (the Stocks engine's series).
//
// Property value in a month = the assessed total in force that
// month's year (latest year <= it; 0 before the first known
// year — the property is not counted yet). Stock value in a
// month = the last series point <= it (carried forward like
// the Stocks chart's bars; 0 before the first point).
// Months span the union of the stock months and every month
// from January of the first assessed year through currentMonth
// (the server's Vancouver current month), so property history
// is never clipped to the stock span.
function overviewRound2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function overviewNextMonth(m) {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

function overviewPropertyAtMonth(assessedByYear, month) {
  const y = Number(month.slice(0, 4));
  let v = 0;
  for (const row of assessedByYear || []) {
    if (row.year <= y) v = row.total;
    else break;
  }
  return v;
}

function overviewStockAtMonth(stockSeries, month) {
  let v = 0;
  let best = '';
  for (const p of stockSeries || []) {
    const val = p ? Number(p.value) : NaN;
    if (p && p.month && p.month <= month && p.month > best && Number.isFinite(val)) {
      best = p.month;
      v = val;
    }
  }
  return v;
}

function overviewMonthly(assessedByYear, stockSeries, currentMonth) {
  const months = new Set((stockSeries || []).map((p) => p.month).filter(Boolean));
  const years = (assessedByYear || []).map((r) => r.year).filter((y) => Number.isFinite(y));
  if (years.length && currentMonth) {
    let m = `${Math.min(...years)}-01`;
    let guard = 0;
    while (m <= currentMonth && guard < 1200) {
      months.add(m);
      m = overviewNextMonth(m);
      guard++;
    }
  }
  return [...months].sort().map((month) => {
    const property = overviewPropertyAtMonth(assessedByYear, month);
    const stock = overviewStockAtMonth(stockSeries, month);
    return { month, property, stock, total: overviewRound2(property + stock) };
  });
}

// Range-end share: exactly two portions, Property and Stock.
// Zero-value portions are dropped — a zero slice is not a share.
function overviewShareAtMonth(assessedByYear, stockSeries, endMonth) {
  if (!endMonth) return { rows: [], total: 0 };
  const rows = [];
  const property = overviewPropertyAtMonth(assessedByYear, endMonth);
  const stock = overviewStockAtMonth(stockSeries, endMonth);
  if (property > 0) rows.push({ label: 'Property', value: property });
  if (stock > 0) rows.push({ label: 'Stock', value: stock });
  return { rows, total: rows.reduce((s, r) => s + r.value, 0) };
}
if (typeof window !== 'undefined') {
  window.overviewPropertyAtMonth = overviewPropertyAtMonth;
  window.overviewStockAtMonth = overviewStockAtMonth;
  window.overviewMonthly = overviewMonthly;
  window.overviewShareAtMonth = overviewShareAtMonth;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { overviewPropertyAtMonth, overviewStockAtMonth, overviewMonthly, overviewShareAtMonth };
}
