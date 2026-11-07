// Home page insights — pure computation, no DB, no LLM.
//
// Two things live here:
//   1. The standard insight cards: 12 deterministic cards (3 per
//      section) computed from the monthly series the app already
//      builds elsewhere (property equity, stock series, earnings
//      monthly chart, spending monthly). Point-in-time metrics use
//      the current month-end value; flow metrics use the LAST
//      COMPLETED month. Primary delta is MoM, second is YoY;
//      sparkline is the trailing 12 months of the metric.
//   2. The highlight rows: recent salary + rental occurrences.
//      Rollover rule (user, 2026-11-07): a row leaves the highlight
//      only when it was MARKED (received or not-received) AND the
//      next occurrence of the same source has arrived. An UNMARKED
//      row is NEVER replaced — it keeps showing until marked, even
//      past its date, so overdue payments accumulate visibly. No
//      arbitrary time cutoff. The query is therefore: the current
//      occurrence per source + all unmarked occurrences.
import { payDatesInWindow, nominalRecentDate, normJobDate, PAY_FREQUENCIES } from './earnings.js';
import { adjustPayday } from './holidays.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------ months --
export function prevMonth(ym) {
  const y = Number(String(ym).slice(0, 4));
  const m = Number(String(ym).slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function nextMonth(ym) {
  const y = Number(String(ym).slice(0, 4));
  const m = Number(String(ym).slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export function addMonthsYm(ym, n) {
  let out = String(ym);
  if (n >= 0) for (let i = 0; i < n; i++) out = nextMonth(out);
  else for (let i = 0; i < -n; i++) out = prevMonth(out);
  return out;
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}
// Last completed month relative to the current month key.
export function lastCompletedMonth(currentYm) {
  return prevMonth(currentYm);
}
// The 12 month keys ending at endYm (inclusive), oldest first.
export function trailing12(endYm) {
  const out = [];
  let m = addMonthsYm(endYm, -11);
  for (let i = 0; i < 12; i++) { out.push(m); m = nextMonth(m); }
  return out;
}
export function daysInMonth(ym) {
  const y = Number(String(ym).slice(0, 4));
  const m = Number(String(ym).slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ------------------------------------------------------------ deltas --
function deltaPair(current, prev, prevYear) {
  const one = (c, p) => {
    if (c == null || p == null) return null;
    const d = r2(c - p);
    return { delta: d, pct: p !== 0 ? r2(((c - p) / Math.abs(p)) * 100) : null };
  };
  return { mom: one(current, prev), yoy: one(current, prevYear) };
}
// Value lookup in a month-keyed series [{month, ...}].
function at(series, ym, field) {
  const row = (series || []).find((r) => r.month === ym);
  return row ? row[field] : undefined;
}

// ------------------------------------------------------------ cards --
const SECTIONS = ['property', 'stock', 'earning', 'spending'];
export const HOME_SECTIONS = SECTIONS;

function baseCard({ section, title, metric, period, value, valueKind = 'money', sublabel = null,
  mom = null, yoy = null, spark = [], sparkMonths = [], downIsGood = false,
  hasData = true, method = '' }) {
  return {
    section, title, metric, period, periodLabel: monthLabel(period),
    value: value == null ? null : r2(value), valueKind, sublabel,
    mom, yoy, spark: (spark || []).map((v) => (v == null ? null : r2(v))), sparkMonths,
    downIsGood, hasData, method,
  };
}

// A point-in-time card: value at the current month-end, sparkline
// trailing 12 months ending at the current month.
function pointCard({ section, title, metric, currentYm, series, field, valueKind = 'money',
  downIsGood = false, method = '' }) {
  const months = trailing12(currentYm);
  const value = at(series, currentYm, field);
  const spark = months.map((m) => at(series, m, field) ?? null);
  const hasData = value != null && (series || []).length > 0;
  const { mom, yoy } = deltaPair(value ?? null, at(series, prevMonth(currentYm), field) ?? null,
    at(series, addMonthsYm(currentYm, -12), field) ?? null);
  return baseCard({ section, title, metric, period: currentYm, value: hasData ? value : null,
    valueKind, mom: hasData ? mom : null, yoy: hasData ? yoy : null,
    spark, sparkMonths: months, downIsGood, hasData, method });
}

// A flow card: value in the last completed month, sparkline trailing
// 12 months ending at the last completed month.
function flowCard({ section, title, metric, currentYm, series, field, valueKind = 'money',
  downIsGood = false, method = '', sublabel = null }) {
  const lcm = lastCompletedMonth(currentYm);
  const months = trailing12(lcm);
  const value = at(series, lcm, field);
  const spark = months.map((m) => at(series, m, field) ?? null);
  const hasData = value != null && (series || []).length > 0;
  const { mom, yoy } = deltaPair(value ?? null, at(series, prevMonth(lcm), field) ?? null,
    at(series, addMonthsYm(lcm, -12), field) ?? null);
  return baseCard({ section, title, metric, period: lcm, value: hasData ? value : null,
    valueKind, sublabel, mom: hasData ? mom : null, yoy: hasData ? yoy : null,
    spark, sparkMonths: months, downIsGood, hasData, method });
}

function emptyCard(section, title, metric, currentYm, flow) {
  const period = flow ? lastCompletedMonth(currentYm) : currentYm;
  return baseCard({ section, title, metric, period, value: null, hasData: false,
    spark: [], sparkMonths: trailing12(period),
    method: 'No data yet for this metric.' });
}

// Last price point on or before the end of a month (price history
// points are {date, price}).
function priceAtMonthEnd(points, ym) {
  const end = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  let best = null;
  for (const p of points || []) {
    const d = String(p.date || '').slice(0, 10);
    if (d <= end && (best == null || d >= String(best.date).slice(0, 10))) best = p;
  }
  return best ? Number(best.price) : null;
}
// Trailing-12-month return ending at ym, from price history only.
function trailing12Return(points, ym) {
  const now = priceAtMonthEnd(points, ym);
  const then = priceAtMonthEnd(points, addMonthsYm(ym, -12));
  if (now == null || then == null || then <= 0) return null;
  return r2(((now - then) / then) * 100);
}

// The 12 standard cards. data:
//   property: [{month, equity, assessed, outstanding}] (sorted asc)
//   stocks: {months: [{month, value, gain}], topGainer: {label, returnPct, points, valueSeries} | null}
//   earnings: [{month, salary, rental, total}]
//   spending: [{month, total, byCategory: {category: amount}}]
//   currentYm: 'YYYY-MM' (the current month)
export function buildStandardInsights(data) {
  const currentYm = data.currentYm;
  const property = data.property || [];
  const stockMonths = (data.stocks && data.stocks.months) || [];
  const earnings = data.earnings || [];
  const spending = data.spending || [];
  const cards = [];

  const propMethod = 'Monthly equity = assessed value in force − outstanding principal at month-end.';
  cards.push(property.length
    ? pointCard({ section: 'property', title: 'Total equity', metric: 'property_equity',
      currentYm, series: property, field: 'equity', method: propMethod })
    : emptyCard('property', 'Total equity', 'property_equity', currentYm, false));
  cards.push(property.length
    ? pointCard({ section: 'property', title: 'Assessed total', metric: 'property_assessed',
      currentYm, series: property, field: 'assessed', method: 'Sum of assessed values in force at month-end.' })
    : emptyCard('property', 'Assessed total', 'property_assessed', currentYm, false));
  cards.push(property.length
    ? pointCard({ section: 'property', title: 'Outstanding principal', metric: 'property_outstanding',
      currentYm, series: property, field: 'outstanding', downIsGood: true,
      method: 'Sum of outstanding principal at month-end. Down is good.' })
    : emptyCard('property', 'Outstanding principal', 'property_outstanding', currentYm, false));

  const stockMethod = 'Portfolio value at month-end, CAD.';
  cards.push(stockMonths.length
    ? pointCard({ section: 'stock', title: 'Portfolio value', metric: 'stock_value',
      currentYm, series: stockMonths, field: 'value', method: stockMethod })
    : emptyCard('stock', 'Portfolio value', 'stock_value', currentYm, false));
  cards.push(stockMonths.length
    ? pointCard({ section: 'stock', title: 'Total gain', metric: 'stock_gain',
      currentYm, series: stockMonths, field: 'gain', method: 'Cumulative gain (value − contributions + dividends) at month-end, CAD.' })
    : emptyCard('stock', 'Total gain', 'stock_gain', currentYm, false));
  const tg = data.stocks && data.stocks.topGainer;
  if (tg && tg.returnPct != null) {
    const months = trailing12(currentYm);
    const spark = months.map((m) => {
      const row = (tg.valueSeries || []).find((r) => r.month === m);
      return row ? row.value : null;
    });
    const momRet = trailing12Return(tg.points, prevMonth(currentYm));
    const yoyRet = trailing12Return(tg.points, addMonthsYm(currentYm, -12));
    const mom = momRet == null ? null : { delta: r2(tg.returnPct - momRet), pct: null };
    const yoy = yoyRet == null ? null : { delta: r2(tg.returnPct - yoyRet), pct: null };
    cards.push(baseCard({ section: 'stock', title: 'Top gainer', metric: 'stock_top_gainer',
      period: currentYm, value: tg.returnPct, valueKind: 'pct', sublabel: tg.label,
      mom, yoy, spark, sparkMonths: months,
      method: 'Highest trailing-12-month return among holdings with value. Deltas are percentage points of the 12-month return.' }));
  } else {
    cards.push(emptyCard('stock', 'Top gainer', 'stock_top_gainer', currentYm, false));
  }

  const earnMethod = 'Salary take-home (cash) + rental income for the month.';
  cards.push(earnings.length
    ? flowCard({ section: 'earning', title: 'Total income', metric: 'earning_total',
      currentYm, series: earnings, field: 'total', method: earnMethod })
    : emptyCard('earning', 'Total income', 'earning_total', currentYm, true));
  cards.push(earnings.length
    ? flowCard({ section: 'earning', title: 'Salary take-home', metric: 'earning_salary',
      currentYm, series: earnings, field: 'salary', method: 'Cash take-home across salary jobs for the month.' })
    : emptyCard('earning', 'Salary take-home', 'earning_salary', currentYm, true));
  cards.push(earnings.length
    ? flowCard({ section: 'earning', title: 'Rental income', metric: 'earning_rental',
      currentYm, series: earnings, field: 'rental', method: 'Rent due across rentals for the month.' })
    : emptyCard('earning', 'Rental income', 'earning_rental', currentYm, true));

  const lcm = lastCompletedMonth(currentYm);
  const spendMonths = trailing12(lcm);
  const lcmRow = spending.find((r) => r.month === lcm);
  const prevRow = spending.find((r) => r.month === prevMonth(lcm));
  const yoyRow = spending.find((r) => r.month === addMonthsYm(lcm, -12));
  cards.push(spending.length
    ? flowCard({ section: 'spending', title: 'Total spend', metric: 'spending_total',
      currentYm, series: spending, field: 'total', method: 'Charges only, for the month. Payments and balance adjustments excluded.' })
    : emptyCard('spending', 'Total spend', 'spending_total', currentYm, true));
  // Top category in the last completed month.
  const topCat = (() => {
    if (!lcmRow || !lcmRow.byCategory) return null;
    let best = null;
    for (const [cat, amt] of Object.entries(lcmRow.byCategory)) {
      if (amt > 0 && (best == null || amt > best.amount)) best = { category: cat, amount: amt };
    }
    return best;
  })();
  if (topCat) {
    const catSeries = spending.map((r) => ({ month: r.month, v: (r.byCategory || {})[topCat.category] ?? 0 }));
    const prevAmt = prevRow ? ((prevRow.byCategory || {})[topCat.category] ?? 0) : null;
    const yoyAmt = yoyRow ? ((yoyRow.byCategory || {})[topCat.category] ?? 0) : null;
    const { mom, yoy } = deltaPair(topCat.amount, prevAmt, yoyAmt);
    const share = lcmRow.total > 0 ? r2((topCat.amount / lcmRow.total) * 100) : null;
    cards.push(baseCard({ section: 'spending', title: 'Top category', metric: 'spending_top_category',
      period: lcm, value: topCat.amount, valueKind: 'money',
      sublabel: `${topCat.category}${share != null ? ` · ${share}% of spend` : ''}`,
      mom, yoy, spark: spendMonths.map((m) => { const r = catSeries.find((x) => x.month === m); return r ? r.v : null; }),
      sparkMonths: spendMonths, method: 'Largest spending category in the last completed month.' }));
  } else {
    cards.push(emptyCard('spending', 'Top category', 'spending_top_category', currentYm, true));
  }
  // Biggest mover: largest absolute MoM change by category.
  const mover = (() => {
    if (!lcmRow || !prevRow || !lcmRow.byCategory) return null;
    let best = null;
    for (const [cat, amt] of Object.entries(lcmRow.byCategory)) {
      const prev = (prevRow.byCategory || {})[cat] ?? 0;
      const d = r2(amt - prev);
      if (best == null || Math.abs(d) > Math.abs(best.delta)) best = { category: cat, amount: amt, delta: d };
    }
    // A category that vanished entirely also moves.
    for (const [cat, amt] of Object.entries(prevRow.byCategory || {})) {
      if (lcmRow.byCategory[cat] == null && amt > 0) {
        const d = r2(0 - amt);
        if (best == null || Math.abs(d) > Math.abs(best.delta)) best = { category: cat, amount: 0, delta: d };
      }
    }
    return best;
  })();
  if (mover) {
    const catSeries = spending.map((r) => ({ month: r.month, v: (r.byCategory || {})[mover.category] ?? 0 }));
    const share = lcmRow.total > 0 && mover.amount > 0 ? r2((mover.amount / lcmRow.total) * 100) : null;
    cards.push(baseCard({ section: 'spending', title: 'Biggest mover', metric: 'spending_biggest_mover',
      period: lcm, value: mover.delta, valueKind: 'money',
      sublabel: `${mover.category} · ${monthLabel(lcm)} ${mover.amount != null ? `$${mover.amount.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}${share != null ? ` · ${share}%` : ''}`,
      mom: null, yoy: null,
      spark: spendMonths.map((m) => { const r = catSeries.find((x) => x.month === m); return r ? r.v : null; }),
      sparkMonths: spendMonths,
      method: 'Largest month-over-month change by category. The big number is the signed change vs the previous month.' }));
  } else {
    cards.push(emptyCard('spending', 'Biggest mover', 'spending_biggest_mover', currentYm, true));
  }

  return cards;
}

// ------------------------------------------------------------ highlight --
// jobs: [{id, label, frequency, startDate, recentDate, cashNet}]
//   cashNet = the displayed per-period take-home (cash).
// rentals: [{id, label, entries: [{start_ym, end_ym, monthly_rent, pay_day}]}]
// marks: Map keyed `${kind}:${sourceId}:${date}` -> 0 | 1
// today: 'YYYY-MM-DD' (Vancouver date).
// Returns rows, most recent first. Per source: the current occurrence
// (latest occurrence on or before today) is always shown; every
// unmarked occurrence is shown too, however old. A marked occurrence
// that is not the current one has rolled off.
export function homeHighlightRows({ jobs, rentals, marks, today }) {
  const cur = String(today).slice(0, 7);
  const rows = [];
  const isMarked = (kind, sourceId, date) => marks.has(`${kind}:${sourceId}:${date}`);

  for (const job of jobs || []) {
    // Jobs without dates (legacy) have no grid — never a guessed date.
    if (!PAY_FREQUENCIES[job.frequency] || !normJobDate(job.startDate) || !normJobDate(job.recentDate) || !normJobDate(today)) continue;
    // The job's own payday grid: nominal recent-date grid
    // (payDatesInWindow) + the holiday advance (adjustPayday) — the
    // same computation as the displayed Next pay date. Annual is
    // special: the anniversary in each year (payDatesInWindow's
    // annual fallthrough is only valid for its YTD window).
    let nominal;
    if (job.frequency === 'annual') {
      const anchor = nominalRecentDate(job.recentDate);
      const [, am, ad] = anchor.split('-').map(Number);
      nominal = [];
      for (let y = Number(job.startDate.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) {
        const ym = `${y}-${String(am).padStart(2, '0')}`;
        const d = `${ym}-${String(Math.min(ad, daysInMonth(ym))).padStart(2, '0')}`;
        if (d >= job.startDate && d <= today) nominal.push(d);
      }
    } else {
      nominal = payDatesInWindow(job.frequency, job.startDate, today, nominalRecentDate(job.recentDate));
    }
    // Two nominal dates can adjust onto the same day; one row.
    const dates = [...new Set(nominal.map((d) => adjustPayday(d)))].sort();
    if (!dates.length) continue;
    const current = dates[dates.length - 1];
    for (const d of dates) {
      if (d === current || !isMarked('salary', job.id, d)) {
        rows.push({
          kind: 'salary', sourceId: job.id, sourceLabel: job.label, date: d,
          month: d.slice(0, 7), amount: r2(job.cashNet ?? 0),
          received: marks.get(`salary:${job.id}:${d}`) ?? null,
          isCurrent: d === current,
        });
      }
    }
  }
  for (const rental of rentals || []) {
    const entries = rental.entries || [];
    if (!entries.length) continue;
    // Months from the earliest entry start through the current month.
    const startYm = entries.map((e) => e.start_ym).sort()[0];
    const months = [];
    let m = startYm;
    while (m <= cur) { months.push(m); m = nextMonth(m); }
    // One occurrence per (rental, month): amounts sum across
    // covering entries, due day from the latest-starting entry.
    const occ = [];
    for (const ym of months) {
      const covering = entries.filter((e) => e.start_ym <= ym && (e.end_ym == null || e.end_ym === '' || ym <= e.end_ym));
      if (!covering.length) continue;
      const amount = r2(covering.reduce((s, e) => s + Number(e.monthly_rent || 0), 0));
      const latest = [...covering].sort((a, b) => String(a.start_ym).localeCompare(String(b.start_ym)) || (a.id - b.id)).pop();
      const day = Math.min(Number(latest.pay_day) || 1, daysInMonth(ym));
      const d = `${ym}-${String(day).padStart(2, '0')}`;
      if (d > today) continue;
      occ.push({ date: d, month: ym, amount });
    }
    if (!occ.length) continue;
    const current = occ[occ.length - 1].date;
    for (const o of occ) {
      if (o.date === current || !isMarked('rental', rental.id, o.date)) {
        rows.push({
          kind: 'rental', sourceId: rental.id, sourceLabel: rental.label, date: o.date,
          month: o.month, amount: o.amount,
          received: marks.get(`rental:${rental.id}:${o.date}`) ?? null,
          isCurrent: o.date === current,
        });
      }
    }
  }
  // Most recent first; ties: salary before rental, then label.
  rows.sort((a, b) => b.date.localeCompare(a.date)
    || (a.kind === b.kind ? 0 : a.kind === 'salary' ? -1 : 1)
    || String(a.sourceLabel).localeCompare(String(b.sourceLabel)));
  return rows;
}

// ------------------------------------------------------------ AI metric library --
// The computable metric library the AI may propose from. Standard ids
// are the 12 above; per-entity variants are built from live entities
// by the server (buildHomeMetricLibrary). A metric id is either a
// standard id or `<base>:<entityId>` / `category_spend:<name>`.
export const HOME_STANDARD_METRICS = [
  { metric: 'property_equity', section: 'property', title: 'Total equity' },
  { metric: 'property_assessed', section: 'property', title: 'Assessed total' },
  { metric: 'property_outstanding', section: 'property', title: 'Outstanding principal' },
  { metric: 'stock_value', section: 'stock', title: 'Portfolio value' },
  { metric: 'stock_gain', section: 'stock', title: 'Total gain' },
  { metric: 'stock_top_gainer', section: 'stock', title: 'Top gainer' },
  { metric: 'earning_total', section: 'earning', title: 'Total income' },
  { metric: 'earning_salary', section: 'earning', title: 'Salary take-home' },
  { metric: 'earning_rental', section: 'earning', title: 'Rental income' },
  { metric: 'spending_total', section: 'spending', title: 'Total spend' },
  { metric: 'spending_top_category', section: 'spending', title: 'Top category' },
  { metric: 'spending_biggest_mover', section: 'spending', title: 'Biggest mover' },
];

// Build the full library from live entities. entities:
//   properties: [{id, label}], holdings: [{id, label}], categories: [name]
export function buildHomeMetricLibrary(entities) {
  const lib = [...HOME_STANDARD_METRICS];
  for (const p of entities.properties || []) {
    lib.push({ metric: `property_equity:${p.id}`, section: 'property', title: `${p.label} equity` });
    lib.push({ metric: `property_assessed:${p.id}`, section: 'property', title: `${p.label} assessed` });
    lib.push({ metric: `property_outstanding:${p.id}`, section: 'property', title: `${p.label} outstanding` });
  }
  for (const h of entities.holdings || []) {
    lib.push({ metric: `holding_value:${h.id}`, section: 'stock', title: `${h.label} value` });
    lib.push({ metric: `holding_gain:${h.id}`, section: 'stock', title: `${h.label} gain` });
  }
  for (const c of entities.categories || []) {
    lib.push({ metric: `category_spend:${c}`, section: 'spending', title: `${c} spend` });
  }
  return lib;
}

// Compute ONE card from a metric id (standard or per-entity) using
// the same series the standard set uses. data matches
// buildStandardInsights, plus:
//   propertyById: {id: [{month, equity, assessed, outstanding}]}
//   holdingById: {id: {months: [{month, value, gain}], label}}
//   categorySeries: {name: [{month, total}]}
// Returns a card payload, or {error} when the metric is unknown or
// has no data.
export function resolveHomeMetric(metric, data) {
  const standard = buildStandardInsights(data).find((c) => c.metric === metric);
  if (standard) {
    if (!standard.hasData) return { error: 'no_data', message: 'That metric has no data yet.' };
    return standard;
  }
  const currentYm = data.currentYm;
  const colon = String(metric).indexOf(':');
  const base = colon === -1 ? String(metric) : String(metric).slice(0, colon);
  const entityId = colon === -1 ? null : String(metric).slice(colon + 1);
  if (base === 'property_equity' || base === 'property_assessed' || base === 'property_outstanding') {
    const series = (data.propertyById || {})[entityId];
    if (!series || !series.length) return { error: 'no_data', message: 'That property has no data yet.' };
    const field = base === 'property_equity' ? 'equity' : base === 'property_assessed' ? 'assessed' : 'outstanding';
    const label = (data.propertyLabels || {})[entityId] || 'Property';
    return pointCard({ section: 'property', title: `${label} ${field === 'equity' ? 'equity' : field === 'assessed' ? 'assessed' : 'outstanding'}`,
      metric, currentYm, series, field, downIsGood: base === 'property_outstanding',
      method: `One property's ${field} at month-end.` });
  }
  if (base === 'holding_value' || base === 'holding_gain') {
    const h = (data.holdingById || {})[entityId];
    if (!h || !h.months || !h.months.length) return { error: 'no_data', message: 'That holding has no data yet.' };
    const field = base === 'holding_value' ? 'value' : 'gain';
    return pointCard({ section: 'stock', title: `${h.label} ${field === 'value' ? 'value' : 'gain'}`,
      metric, currentYm, series: h.months, field,
      method: `One holding's ${field} at month-end, CAD.` });
  }
  if (base === 'category_spend') {
    const series = (data.categorySeries || {})[entityId];
    if (!series || !series.length) return { error: 'no_data', message: 'That category has no spending yet.' };
    return flowCard({ section: 'spending', title: `${entityId} spend`, metric,
      currentYm, series, field: 'total',
      method: `One category's spend in the last completed month.` });
  }
  return { error: 'unknown_metric', message: 'That metric is not computable.' };
}

// ------------------------------------------------------------ AI prompt --
export function homeAiPrompt({ text, history, library, existingTitles }) {
  const lines = (history || []).slice(-10).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');
  const libLines = library.map((m) => `- ${m.metric} (${m.section}): ${m.title}`).join('\n');
  return [
    'You help add ONE insight card to a family finance home page.',
    'You may ONLY propose a card whose metric is in the computable library below.',
    'Reply with a single JSON object, no other text:',
    '  {"card": {"section": "<one of property|stock|earning|spending>", "title": "<short card title>", "metric": "<metric id from the library>"}}',
    '  — when the request maps to exactly one library metric. The title should name the thing being measured.',
    '  {"ask": "<one short question>"} — when the request is ambiguous (e.g. which property, which holding, which category) and you need one detail before you can pick a metric. Ask, never guess.',
    '  {"decline": "<one plain sentence>"} — when the request cannot be computed from the library (e.g. a forecast, a comparison the app does not track, a non-financial topic). Plain words, never validation jargon.',
    'Computable metric library:',
    libLines,
    existingTitles && existingTitles.length ? `Cards already on the page (do not duplicate these titles): ${existingTitles.join(', ')}` : '',
    lines ? `Conversation so far:\n${lines}` : '',
    `User: ${text}`,
  ].filter(Boolean).join('\n');
}
