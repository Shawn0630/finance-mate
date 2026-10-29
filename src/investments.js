// Investments — accounts (TFSA / RRSP / RSU / non-registered …),
// their holdings (exchange-traded stocks/ETFs and bank mutual
// funds), the events that make up each holding's life, and the
// return engine behind the three-level views (portfolio →
// account → holding).
//
// Return engine — the conventions, pinned by tests:
//   units(t)      = Σ buy + Σ grant − Σ sell over events dated ≤ t,
//                   every lot restated into current terms by the
//                   splits that followed it (see Splits below).
//   price(t)      = the last price point dated ≤ t (invest_prices;
//                   same-date ties resolve manual > stooq > yahoo
//                   > event — a hand-recorded NAV outranks a
//                   fetched close, which outranks a traded price).
//   value(t)      = units(t) × price(t); USD holdings convert at
//                   fx(t), the last USD/CAD rate dated ≤ t.
//   Monthly row   = start value (previous month-end), the month's
//                   NET CONTRIBUTIONS (buy cost − sell proceeds +
//                   grant value — a grant counts at its cost price,
//                   else the market price on the grant date, so a
//                   vest never books as profit), DIVIDENDS (paid
//                   out, never part of end value), MARKET GAIN
//                   (end − start − contributions; the identity
//                   end == start + contributions + gain always
//                   holds) and RETURN = gain + dividends.
//   Return %      = return ÷ (start value + net contributions);
//                   a zero denominator (nothing held, nothing put
//                   in) reads null — the UI shows '—'. A negative
//                   denominator (net selling past the start value)
//                   also reads null: the percentage is meaningless
//                   there even though the $ return is real.
//   Cumulative return on the charts = value − cumulative net
//                   contributions + cumulative dividends.
//
// A fund holding with no NAV snapshots values at its event
// prices (flat between them); a holding with no price at all
// values at 0 until its first priced event / snapshot and its
// view says so (priceStatus.pricedBy 'none') — the app never
// invents a price.
//
// Splits — a 'split' event carries a ratio (split_new : split_old,
// e.g. 3:1; a reverse split is 1:2, multiplier 0.5). Fetched
// closes are already split-adjusted (current terms), so every
// quantity is restated into current terms before it meets a
// price: an event's adjusted units = its recorded units × the
// product of the multipliers of every split dated AFTER it.
// History is restated the same way adjusted price series are:
// a pre-split lot reads at its current-terms size in every
// month, and an event (trade) price divides by the same product
// so the fallback path lands on the same scale. Contribution
// DOLLARS (buy cost, sell proceeds, dividend amounts) are never
// restated — they are money that actually moved — and the sell
// guard compares in current terms on both sides, which reduces
// to the old recorded-terms check when no split exists.

export const ACCOUNT_TYPES = ['TFSA', 'RRSP', 'RSU', 'NonRegistered', 'Other'];
export const HOLDING_KINDS = ['exchange', 'fund'];
export const HOLDING_CURRENCIES = ['CAD', 'USD'];
export const EVENT_TYPES = ['buy', 'sell', 'grant', 'dividend', 'split', 'position'];

// ------------------------------------------------------------- splits
// A split event's multiplier: split_new / split_old (3:1 → 3,
// 1:2 → 0.5). Rows carry the ratio sides as split_new/split_old
// (DB / API shape) or splitNew/splitOld (validated shape).
export function splitMultiplier(e) {
  if (!e || e.type !== 'split') return 1;
  const n = Number(e.split_new ?? e.splitNew);
  const o = Number(e.split_old ?? e.splitOld);
  return Number.isFinite(n) && Number.isFinite(o) && n > 0 && o > 0 ? n / o : 1;
}

// The product of the multipliers of every split dated strictly
// after `date` — the factor that restates a quantity recorded
// on that date into current (post-all-splits) terms.
export function splitFactorAfter(events, date) {
  let f = 1;
  for (const e of events || []) {
    if (e && e.type === 'split' && e.date > date) f *= splitMultiplier(e);
  }
  return f;
}

// An event's units restated into current terms.
export function adjustedUnitsOf(e, events) {
  return Number(e.units || 0) * splitFactorAfter(events, e.date);
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// ------------------------------------------------------------ dates
export const isDateStr = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

export const monthKeyOf = (dateStr) => String(dateStr).slice(0, 7);

export function monthEndDate(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function addMonthKey(monthKey, n) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(fromKey, toKey) {
  const out = [];
  for (let k = fromKey; k <= toKey; k = addMonthKey(k, 1)) out.push(k);
  return out;
}

// --------------------------------------------------------- validation
const cleanStr = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const posNum = (v) => {
  const n = v === '' || v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function validAccountInput(b, base = null) {
  if (!b || typeof b !== 'object') return { error: 'an account is required' };
  const merged = { ...(base || {}), ...b };
  const name = cleanStr(merged.name, 120);
  if (!name) return { error: 'name is required' };
  const type = ACCOUNT_TYPES.includes(merged.type) ? merged.type : (base ? base.type : null);
  if (!type) return { error: `type must be one of ${ACCOUNT_TYPES.join(', ')}` };
  return {
    name,
    type,
    institution: cleanStr(merged.institution, 120),
    note: cleanStr(merged.note, 500),
  };
}

export function validHoldingInput(b, base = null) {
  if (!b || typeof b !== 'object') return { error: 'a holding is required' };
  const merged = { ...(base || {}), ...b };
  const label = cleanStr(merged.label, 160);
  if (!label) return { error: 'label is required' };
  const kind = HOLDING_KINDS.includes(merged.kind) ? merged.kind : (base ? base.kind : null);
  if (!kind) return { error: "kind must be 'exchange' or 'fund'" };
  const currency = HOLDING_CURRENCIES.includes(merged.currency) ? merged.currency : (base ? base.currency : null);
  if (!currency) return { error: "currency must be 'CAD' or 'USD'" };
  let symbol = cleanStr(merged.symbol, 24);
  if (symbol) symbol = symbol.toUpperCase();
  if (kind === 'exchange' && !symbol) return { error: 'an exchange holding needs a symbol' };
  if (kind === 'fund') symbol = symbol || null; // a fund may carry a ticker too; never required
  return {
    label,
    kind,
    symbol,
    fundCode: cleanStr(merged.fundCode ?? merged.fund_code, 40),
    currency,
  };
}

// Sell guard: the units a sell may move are what the holding
// holds ON the event's date (all other events dated ≤ that date;
// a same-day event always lands after the ones already recorded).
// Both sides are compared in CURRENT terms — every lot restated
// by the splits that followed it — which is the recorded-terms
// check whenever no split exists.
export function unitsAvailableForSell(events, date, exceptId = null) {
  let u = 0;
  for (const e of events) {
    if (e.id === exceptId || e.date > date) continue;
    if (e.type === 'buy' || e.type === 'grant' || e.type === 'position') u += adjustedUnitsOf(e, events);
    else if (e.type === 'sell') u -= adjustedUnitsOf(e, events);
  }
  return round4(u);
}

export function validEventInput(b, ctx = {}) {
  if (!b || typeof b !== 'object') return { error: 'an event is required' };
  const merged = { ...(ctx.base || {}), ...b };
  if (!EVENT_TYPES.includes(merged.type)) {
    return { error: `type must be one of ${EVENT_TYPES.join(', ')}` };
  }
  if (!isDateStr(merged.date)) return { error: 'date must be YYYY-MM-DD' };
  const out = {
    date: merged.date,
    type: merged.type,
    units: null, price: null, amount: null,
    splitNew: null, splitOld: null,
    note: cleanStr(merged.note, 500),
  };
  if (merged.type === 'dividend') {
    out.amount = posNum(merged.amount);
    if (out.amount == null) return { error: 'a dividend needs an amount > 0' };
    return out;
  }
  if (merged.type === 'split') {
    // A split moves no money and trades no units itself — it
    // restates every earlier lot. Only the ratio is recorded.
    out.splitNew = posNum(merged.splitNew ?? merged.split_new);
    out.splitOld = posNum(merged.splitOld ?? merged.split_old);
    if (out.splitNew == null || out.splitOld == null) {
      return { error: 'a split needs both sides of its ratio (new : old) as numbers > 0' };
    }
    if (out.splitNew === out.splitOld) {
      return { error: 'a split ratio must change the unit count (new ≠ old)' };
    }
    return out;
  }
  if (merged.type === 'position') {
    // A cost-unknown position: units observed (a statement
    // holding, or value ÷ NAV on one date), NO price. A price
    // on this record would make it a buy — the whole point of
    // the type is that nothing about cost is invented. It
    // counts toward units held and toward the sell guard, but
    // contributes $0 and flags the holding cost-unknown until
    // real buy records replace it.
    out.units = posNum(merged.units);
    if (out.units == null) return { error: 'a position needs units > 0' };
    if (merged.price !== undefined && merged.price !== null && merged.price !== '') {
      return { error: 'a position carries no price — use buy when a price is known' };
    }
    return out;
  }
  out.units = posNum(merged.units);
  if (out.units == null) return { error: 'units must be a number > 0' };
  if (merged.type === 'grant') {
    // A grant's price is its cost basis; empty means "the market
    // price on the grant date", resolved by the engine.
    if (merged.price !== undefined && merged.price !== null && merged.price !== '') {
      out.price = posNum(merged.price);
      if (out.price == null) return { error: 'grant price must be a number > 0 when given' };
    }
  } else {
    out.price = posNum(merged.price);
    if (out.price == null) return { error: 'price must be a number > 0' };
  }
  if (merged.type === 'sell' && Array.isArray(ctx.events)) {
    const avail = unitsAvailableForSell(ctx.events, out.date, ctx.exceptId ?? null);
    // The candidate folds by the splits after ITS date, the
    // same restatement the recorded lots get — the comparison
    // is in current terms on both sides.
    const mine = out.units * splitFactorAfter(ctx.events, out.date);
    if (mine > avail + 1e-9) {
      return { error: `cannot sell ${out.units} units on ${out.date} — only ${avail} held` };
    }
  }
  return out;
}

// The Add Holding form's optional initial transactions: a batch
// of events created together with a brand-new holding. Rows are
// validated in DATE order (input order breaks same-day ties) in
// two passes: first every row's shape through the same
// validEventInput rules as a detail-page event, then the sell
// guard across the whole batch in current terms — a sell is
// only accepted against units the batch itself has acquired by
// that date, with split restatement computed over the FULL
// batch (a split later in the batch still restates an earlier
// buy before an in-between sell is judged), the same "a same-day
// event lands after the ones already recorded" convention as
// the single-event path. Any bad row fails the whole batch; the
// caller creates nothing.
export function validInitialEvents(list) {
  if (list === undefined || list === null) return { events: [] };
  if (!Array.isArray(list)) return { error: 'events must be an array' };
  const ordered = list.map((row, i) => ({ row, i })).sort((a, b) => {
    const da = a.row && typeof a.row.date === 'string' ? a.row.date : '';
    const db2 = b.row && typeof b.row.date === 'string' ? b.row.date : '';
    return da < db2 ? -1 : da > db2 ? 1 : a.i - b.i;
  });
  const validated = [];
  for (const { row } of ordered) {
    const v = validEventInput(row || {}, {});
    if (v.error) return { error: v.error };
    validated.push(v);
  }
  let balance = 0; // current-terms units acquired so far
  for (const v of validated) {
    const f = splitFactorAfter(validated, v.date);
    if (v.type === 'buy' || v.type === 'grant' || v.type === 'position') balance += Number(v.units) * f;
    else if (v.type === 'sell') {
      const mine = Number(v.units) * f;
      if (mine > balance + 1e-9) {
        return { error: `cannot sell ${v.units} units on ${v.date} — only ${round4(balance / f)} held` };
      }
      balance -= mine;
    }
  }
  return { events: validated };
}

export function validNavInput(b) {
  if (!b || typeof b !== 'object') return { error: 'a NAV snapshot is required' };
  if (!isDateStr(b.date)) return { error: 'date must be YYYY-MM-DD' };
  const price = posNum(b.price ?? b.nav);
  if (price == null) return { error: 'price must be a number > 0' };
  return { date: b.date, price };
}

// ------------------------------------------------------------ storage
// Owners are a SET of usernames, exactly like properties: stored as a
// JSON array in the `owners` column, read back as an array (empty when
// the column is NULL, i.e. an account created before owners existed).
function parseOwnerList(stored) {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function accountRow(row) {
  return row ? { ...row, owners: parseOwnerList(row.owners) } : null;
}
export function listAccounts(db) {
  return db.prepare('SELECT * FROM invest_accounts ORDER BY id').all().map(accountRow);
}
export function getAccount(db, id) {
  return accountRow(db.prepare('SELECT * FROM invest_accounts WHERE id = ?').get(id) || null);
}
export function listHoldings(db, accountId = null) {
  return accountId == null
    ? db.prepare('SELECT * FROM invest_holdings ORDER BY account_id, id').all()
    : db.prepare('SELECT * FROM invest_holdings WHERE account_id = ? ORDER BY id').all(accountId);
}
export function getHolding(db, id) {
  return db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(id) || null;
}
export function listEvents(db, holdingId) {
  return db.prepare('SELECT * FROM invest_events WHERE holding_id = ? ORDER BY date, id').all(holdingId);
}
export function listPricePoints(db, holdingId) {
  return db.prepare('SELECT * FROM invest_prices WHERE holding_id = ? ORDER BY date, id').all(holdingId);
}
export function listFxPoints(db) {
  return db.prepare('SELECT date, rate FROM invest_fx_rates ORDER BY date').all();
}

// Event prices are materialized into invest_prices (source
// 'event') so the price function sees every source through one
// table. Rebuilt wholesale after any event mutation: priced
// buys/sells/grants contribute their per-unit price; dividends
// never do (their amount is a total, not a price). A trade
// price is recorded in the terms of its day, so it is divided
// by the splits that followed it — the materialized point is
// in current terms, the scale the restated unit counts use.
export function rebuildEventPricePoints(db, holdingId, ts) {
  const events = listEvents(db, holdingId);
  db.transaction(() => {
    db.prepare("DELETE FROM invest_prices WHERE holding_id = ? AND source = 'event'").run(holdingId);
    const ins = db.prepare(
      "INSERT OR REPLACE INTO invest_prices (holding_id, date, price, source, created_at) VALUES (?, ?, ?, 'event', ?)");
    for (const e of events) {
      if (e.type !== 'dividend' && e.type !== 'split' && e.price != null && Number(e.price) > 0) {
        ins.run(holdingId, e.date, Number(e.price) / splitFactorAfter(events, e.date), ts);
      }
    }
  })();
}

// ------------------------------------------------------ price access
const SOURCE_PRIORITY = { event: 1, yahoo: 2, stooq: 3, manual: 4 };

// The last price point dated ≤ date; same-date ties resolve by
// source priority (manual > stooq > yahoo > event). Null before the
// first point — the caller values the holding at 0 there and
// the view's priceStatus says why.
export function priceOn(points, date) {
  let best = null;
  for (const p of points) {
    if (p.date > date) continue;
    if (!best || p.date > best.date
      || (p.date === best.date && (SOURCE_PRIORITY[p.source] || 0) > (SOURCE_PRIORITY[best.source] || 0))) {
      best = p;
    }
  }
  return best ? { price: Number(best.price), date: best.date, source: best.source } : null;
}

// The last FX rate dated ≤ date; a date before the series start
// uses the earliest known rate (the series reaches back to 2015,
// well before any holding here). Null when no rates are stored.
export function fxOn(fxPoints, date) {
  if (!fxPoints || !fxPoints.length) return null;
  let best = null;
  for (const p of fxPoints) {
    if (p.date <= date && (!best || p.date > best.date)) best = p;
  }
  return best ? Number(best.rate) : Number(fxPoints[0].rate);
}

// Units held on a date, in CURRENT terms: each lot is restated
// by every split that followed it (splits themselves move no
// units here — they act through the restatement).
export function unitsOn(events, date) {
  let u = 0;
  for (const e of events) {
    if (e.date > date) continue;
    if (e.type === 'buy' || e.type === 'grant' || e.type === 'position') u += adjustedUnitsOf(e, events);
    else if (e.type === 'sell') u -= adjustedUnitsOf(e, events);
  }
  return round4(u);
}

// Derive units from a same-date total value and per-unit
// price — the ONLY arithmetic the cost-unknown path allows:
// both inputs are observed figures, the quotient is exact.
// Null when either side is missing or not positive.
export function derivePositionUnits(value, nav) {
  const v = posNum(value);
  const n = posNum(nav);
  if (v == null || n == null) return null;
  return round4(v / n);
}

// ------------------------------------------------------------- engine
// One holding's full computation: the monthly return table (in
// the holding's native currency AND in CAD), the month-end
// series for the chart, and the current summary.
//   fxRate(date) → CAD per 1 unit of the holding's currency
//                  (identically 1 for CAD holdings).
export function computeHoldingSeries({ events, points, fxRate, today }) {
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  if (!sorted.length) {
    return { monthly: [], series: [], summary: emptySummary() };
  }
  const firstMonth = monthKeyOf(sorted[0].date);
  const currentMonth = monthKeyOf(today);
  const lastMonth = currentMonth > firstMonth ? currentMonth : firstMonth;
  const months = monthRange(firstMonth, lastMonth);

  const fxAt = (d) => {
    const r = fxRate(d);
    return r == null || !Number.isFinite(r) ? 1 : r;
  };
  const valueAt = (date) => {
    const units = unitsOn(sorted, date);
    const px = priceOn(points, date);
    if (!units || !px) return { native: 0, cad: 0, units };
    const native = units * px.price;
    return { native, cad: native * fxAt(date), units };
  };
  // A grant's contribution, in dollars: at its stated cost
  // price (recorded units × recorded price — money terms, never
  // restated) or, when unstated, at the market price on its own
  // date (from whatever price source covers it). A market price
  // lives in current terms, so it multiplies the grant's
  // RESTATED units to land on the same dollars. With no price
  // anywhere the grant contributes 0 — and the holding view can
  // count those (unpricedGrants in the summary).
  const grantValue = (e) => {
    if (e.price != null) return Number(e.units) * Number(e.price);
    const px = priceOn(points, e.date);
    return px ? adjustedUnitsOf(e, sorted) * px.price : 0;
  };
  const flowsIn = (month) => {
    let contribN = 0; let contribC = 0; let divN = 0; let divC = 0;
    for (const e of sorted) {
      if (monthKeyOf(e.date) !== month) continue;
      const fx = fxAt(e.date);
      if (e.type === 'buy') { const v = Number(e.units) * Number(e.price); contribN += v; contribC += v * fx; }
      else if (e.type === 'sell') { const v = Number(e.units) * Number(e.price); contribN -= v; contribC -= v * fx; }
      else if (e.type === 'grant') { const v = grantValue(e); contribN += v; contribC += v * fx; }
      else if (e.type === 'dividend') { const v = Number(e.amount || 0); divN += v; divC += v * fx; }
    }
    return { contribN, contribC, divN, divC };
  };
  const pct = (ret, start, contrib) => {
    const denom = start + contrib;
    return denom > 0 ? round2((ret / denom) * 100) : null;
  };

  const monthly = [];
  const series = [];
  let cumContribC = 0; let cumDivC = 0; let cumContribN = 0; let cumDivN = 0;
  let totContribN = 0; let totContribC = 0; let totDivN = 0; let totDivC = 0;
  for (const month of months) {
    const prevEnd = monthEndDate(addMonthKey(month, -1));
    const end = monthEndDate(month);
    const start = valueAt(prevEnd);
    const finish = valueAt(end);
    const f = flowsIn(month);
    const gainN = finish.native - start.native - f.contribN;
    const gainC = finish.cad - start.cad - f.contribC;
    const retN = gainN + f.divN;
    const retC = gainC + f.divC;
    monthly.push({
      month,
      startValue: round2(start.cad), endValue: round2(finish.cad),
      contributions: round2(f.contribC), dividends: round2(f.divC),
      gain: round2(gainC), returnAmount: round2(retC),
      returnPct: pct(retC, start.cad, f.contribC),
      startValueNative: round2(start.native), endValueNative: round2(finish.native),
      contributionsNative: round2(f.contribN), dividendsNative: round2(f.divN),
      gainNative: round2(gainN), returnAmountNative: round2(retN),
      returnPctNative: pct(retN, start.native, f.contribN),
      unitsEnd: finish.units,
    });
    cumContribC += f.contribC; cumDivC += f.divC;
    cumContribN += f.contribN; cumDivN += f.divN;
    totContribN += f.contribN; totContribC += f.contribC;
    totDivN += f.divN; totDivC += f.divC;
    series.push({
      month,
      value: round2(finish.cad), valueNative: round2(finish.native),
      contributions: round2(cumContribC), contributionsNative: round2(cumContribN),
      returnAmount: round2(finish.cad - cumContribC + cumDivC),
      returnAmountNative: round2(finish.native - cumContribN + cumDivN),
    });
  }

  const now = valueAt(today);
  const latestPx = priceOn(points, today);
  const totalRetC = now.cad - totContribC + totDivC;
  const totalRetN = now.native - totContribN + totDivN;
  // Cost-unknown units: position events restated into current
  // terms, like every other lot. While any remain, the
  // holding's gain is NOT a number — it would read as
  // "value minus zero contributions" — so the summary flags
  // it and the views render gain / return % as unknown.
  // The monthly identity itself still holds numerically;
  // only the display suppresses the gain.
  const unknownCostUnits = round4(sorted.reduce(
    (s, e) => (e.type === 'position' ? s + adjustedUnitsOf(e, sorted) : s), 0));
  const summary = {
    units: now.units,
    latestPrice: latestPx ? latestPx.price : null,
    latestPriceDate: latestPx ? latestPx.date : null,
    latestPriceSource: latestPx ? latestPx.source : null,
    value: round2(now.cad), valueNative: round2(now.native),
    contributions: round2(totContribC), contributionsNative: round2(totContribN),
    dividends: round2(totDivC), dividendsNative: round2(totDivN),
    totalReturn: round2(totalRetC), totalReturnNative: round2(totalRetN),
    totalReturnPct: totContribC > 0 ? round2((totalRetC / totContribC) * 100) : null,
    totalReturnPctNative: totContribN > 0 ? round2((totalRetN / totContribN) * 100) : null,
    unpricedGrants: sorted.filter((e) => e.type === 'grant' && e.price == null && !priceOn(points, e.date)).length,
    unknownCostUnits,
    costUnknown: unknownCostUnits > 0,
  };
  return { monthly, series, summary };
}

function emptySummary() {
  return {
    units: 0, latestPrice: null, latestPriceDate: null, latestPriceSource: null,
    value: 0, valueNative: 0, contributions: 0, contributionsNative: 0,
    dividends: 0, dividendsNative: 0, totalReturn: 0, totalReturnNative: 0,
    totalReturnPct: null, totalReturnPctNative: null, unpricedGrants: 0,
    unknownCostUnits: 0, costUnknown: false,
  };
}

// Aggregate computed holdings (same engine output) into one
// monthly table + series + summary, all in CAD. Months span the
// union of the inputs.
export function aggregateComputed(list) {
  const byMonth = new Map();
  for (const c of list) {
    for (const r of c.monthly) {
      const cur = byMonth.get(r.month) || {
        month: r.month, startValue: 0, endValue: 0, contributions: 0,
        dividends: 0, gain: 0, returnAmount: 0,
      };
      cur.startValue += r.startValue; cur.endValue += r.endValue;
      cur.contributions += r.contributions; cur.dividends += r.dividends;
      cur.gain += r.gain; cur.returnAmount += r.returnAmount;
      byMonth.set(r.month, cur);
    }
  }
  const months = [...byMonth.keys()].sort();
  const monthly = months.map((m) => {
    const r = byMonth.get(m);
    const denom = r.startValue + r.contributions;
    return {
      ...r,
      startValue: round2(r.startValue), endValue: round2(r.endValue),
      contributions: round2(r.contributions), dividends: round2(r.dividends),
      gain: round2(r.gain), returnAmount: round2(r.returnAmount),
      returnPct: denom > 0 ? round2((r.returnAmount / denom) * 100) : null,
    };
  });
  let cumC = 0; let cumD = 0;
  const series = monthly.map((r) => {
    cumC += r.contributions; cumD += r.dividends;
    return {
      month: r.month, value: r.endValue, contributions: round2(cumC),
      returnAmount: round2(r.endValue - cumC + cumD),
    };
  });
  const summary = {
    value: 0, contributions: 0, dividends: 0, totalReturn: 0, totalReturnPct: null,
    unknownCostUnits: 0, costUnknown: false,
  };
  for (const c of list) {
    summary.value += c.summary.value;
    summary.contributions += c.summary.contributions;
    summary.dividends += c.summary.dividends;
    summary.totalReturn += c.summary.totalReturn;
    summary.unknownCostUnits += c.summary.unknownCostUnits || 0;
    if (c.summary.costUnknown) summary.costUnknown = true;
  }
  summary.value = round2(summary.value);
  summary.contributions = round2(summary.contributions);
  summary.dividends = round2(summary.dividends);
  summary.totalReturn = round2(summary.totalReturn);
  summary.unknownCostUnits = round4(summary.unknownCostUnits);
  summary.totalReturnPct = summary.contributions > 0
    ? round2((summary.totalReturn / summary.contributions) * 100) : null;
  return { monthly, series, summary };
}

// --------------------------------------------------------------- views
// fxResolver: { rate(currency, date) → CAD per unit | null,
// missing: bool } built by the caller (server) after ensuring
// the FX cache; CAD always resolves to 1.
export function computeHolding(db, holding, fxResolver, today) {
  const events = listEvents(db, holding.id);
  const points = listPricePoints(db, holding.id);
  const fxRate = holding.currency === 'CAD'
    ? () => 1
    : (d) => fxResolver.rate(holding.currency, d);
  const computed = computeHoldingSeries({ events, points, fxRate, today });
  return { holding, events, points, ...computed };
}

export function computeAccount(db, account, fxResolver, today) {
  const holdings = listHoldings(db, account.id)
    .map((h) => computeHolding(db, h, fxResolver, today));
  const agg = aggregateComputed(holdings);
  return { account, holdings, ...agg };
}

export function computePortfolio(db, fxResolver, today) {
  const accounts = listAccounts(db).map((a) => computeAccount(db, a, fxResolver, today));
  const agg = aggregateComputed(accounts.flatMap((a) => a.holdings));
  return { accounts, ...agg };
}

// --------------------------------------------- monthly year paging --
// The Monthly returns table spans first-event month to today, so
// a multi-year holding renders dozens of rows. The table pages
// by year (the chart keeps the full range): distinct years in
// the visible rows, the latest year as the default page, and
// the rows of one year. Pure functions — the frontend mirrors
// the same slice (month prefix match) for display.
export function monthlyYears(monthly) {
  const years = new Set((monthly || []).map((r) => String(r.month || '').slice(0, 4)).filter(Boolean));
  return [...years].sort();
}

export function latestMonthlyYear(monthly) {
  const years = monthlyYears(monthly);
  return years.length ? years[years.length - 1] : null;
}

export function monthlyRowsForYear(monthly, year) {
  if (!year) return monthly || [];
  return (monthly || []).filter((r) => String(r.month || '').startsWith(`${year}-`));
}
