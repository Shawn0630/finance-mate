// Rental income series + range-share math for the Rentals income panel.
// Pure: no DOM, no side effects, so the node unit tests load this exact
// file (via vm) instead of a copy — the invest-share.js precedent.
//   rentals: [{ id, label, entries: [{ start_ym, end_ym, monthly_rent }] }]
//   nowYm: 'YYYY-MM' — the current month; a blank end_ym means the
//     entry is ongoing through nowYm (the 8ea1168 entry rule).
// Month granularity: an entry covers whole months; overlapping
// tenancies sum rent. Only rent sums matter here — rented days,
// expenses, mortgage interest/principal, CCA and the T776 computation
// never enter this panel, and year-record other income (line 8230)
// is not an input at all: income comes from rent entries only.
const RENT_YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function rentParseYm(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = RENT_YM_RE.exec(String(v).trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function rentYmIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

function rentYmFromIndex(k) {
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
}

function rentYmList(start, end) {
  const out = [];
  if (!start || !end || start > end) return out;
  for (let k = rentYmIndex(start); k <= rentYmIndex(end); k++) out.push(rentYmFromIndex(k));
  return out;
}

// Months one entry covers: start through (end || nowYm). Invalid
// entries (bad start, end before start) cover nothing.
function rentEntryMonths(entry, nowYm) {
  const start = rentParseYm(entry && entry.start_ym);
  if (!start) return [];
  const end = rentParseYm(entry && entry.end_ym) || nowYm;
  if (!end || end < start) return [];
  return rentYmList(start, end);
}

// Per-rental monthly income series: [{ rental, months: [{ month, value }] }],
// months sorted, only months the rental actually covers.
function rentMonthlySeries(rentals, nowYm) {
  const out = [];
  for (const r of rentals || []) {
    const byMonth = new Map();
    for (const e of (r && r.entries) || []) {
      const rent = Number(e && e.monthly_rent);
      if (!Number.isFinite(rent)) continue;
      for (const m of rentEntryMonths(e, nowYm)) {
        byMonth.set(m, (byMonth.get(m) || 0) + rent);
      }
    }
    const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, value]) => ({ month, value: Math.round(value * 100) / 100 }));
    out.push({ rental: { id: r.id, label: r.label }, months });
  }
  return out;
}

// Share over a RANGE (income is a flow — deliberately unlike the
// Stocks range-end point-in-time share): each rental's total income
// across the range's months. rows keep every rental with income > 0
// (hidden ones stay present so either legend can restore them, the
// invest doughnut precedent); total is all rows, visibleTotal counts
// non-hidden rows only and is what the doughnut center shows.
function rentRangeShare(series, range, hiddenIds) {
  const hidden = new Set(hiddenIds || []);
  const inR = (m) => !range || (m >= range.start && m <= range.end);
  const rows = [];
  for (const s of series || []) {
    let value = 0;
    for (const p of s.months || []) if (inR(p.month)) value += p.value;
    value = Math.round(value * 100) / 100;
    if (value > 0) rows.push({ rental: s.rental, value, hidden: hidden.has(s.rental.id) });
  }
  const total = rows.reduce((s, r) => s + r.value, 0);
  const visibleTotal = rows.filter((r) => !r.hidden).reduce((s, r) => s + r.value, 0);
  return { rows, total: Math.round(total * 100) / 100, visibleTotal: Math.round(visibleTotal * 100) / 100 };
}

// Annual-chart years for the combined Total income panel: the
// shared invest-range picker drives both the share and the chart.
// All (or no range) shows every year; a preset/custom range shows
// only the tax years the range's months touch — so a 1-year preset
// spanning December/January legitimately shows two tax years.
function rentAnnualYears(allYears, range, isAll) {
  const years = [...(allYears || [])];
  if (!range || !range.start || !range.end || isAll) return years;
  const sy = Number(String(range.start).slice(0, 4));
  const ey = Number(String(range.end).slice(0, 4));
  if (!Number.isFinite(sy) || !Number.isFinite(ey)) return years;
  return years.filter((y) => y >= sy && y <= ey);
}

// The annual chart's empty rule: hidden with a note when no rental
// year-record data exists for the filtered years — NOT merely when
// the shared years list is empty (that list also carries job tax
// years, which used to render a $0/$1-ticked all-zero chart for
// rentals with no year records).
function rentAnnualEmpty(rentalsByYear, years) {
  if (!rentalsByYear || !years || !years.length) return true;
  return !years.some((y) => rentalsByYear[y]);
}

if (typeof window !== 'undefined') {
  window.rentMonthlySeries = rentMonthlySeries;
  window.rentRangeShare = rentRangeShare;
  window.rentAnnualYears = rentAnnualYears;
  window.rentAnnualEmpty = rentAnnualEmpty;
  window.rentYmList = rentYmList;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rentMonthlySeries, rentRangeShare, rentYmList, rentEntryMonths, rentAnnualYears, rentAnnualEmpty };
}
