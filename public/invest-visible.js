// Visible-accounts aggregate for the Stocks portfolio Hide
// filter. Pure: no DOM, no side effects, so the node unit tests
// load this exact file (via vm) instead of a copy.
//
// The portfolio payload already carries each account's own
// monthly rows, series, and summary (computeAccount), so a
// hidden account is excluded client-side with no server change
// and no endpoint contract change. This mirrors the server's
// aggregateComputed over the VISIBLE accounts only:
//   monthly: per-month sums of the visible accounts' monthly
//     rows (start/end/contributions/dividends/gain/return),
//     returnPct recomputed as returnAmount ÷ (start +
//     contributions), null when the denominator is 0 — so the
//     monthly identity end == start + contributions + gain
//     holds on every recomputed row, exactly as the server's.
//   series: from the recomputed monthly rows (cumulative
//     contributions/dividends, value = month-end value,
//     returnAmount = value − cumulative contributions +
//     cumulative dividends). When spanMonths is given, the
//     series zero-fills every span month with no visible row,
//     so hiding the earliest account never shrinks the chart's
//     time axis — early months read 0 instead of vanishing.
//   summary: sums of the visible accounts' summaries (the
//     same figures their cards show), totalReturnPct =
//     totalReturn ÷ contributions (null when contributions
//     are 0), costUnknown = any visible account costUnknown —
//     so a HIDDEN cost-unknown account suppresses nothing,
//     while a visible one still suppresses gain/return exactly
//     as the server's aggregate does.
// All money fields carry the payload's display currency —
// hiding never converts, fetches, or writes anything.
function investVisibleAggregate(accounts, hidden, spanMonths) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const visible = (accounts || []).filter((a) => a && a.account && !(hidden && hidden.has(a.account.id)));
  const byMonth = new Map();
  for (const a of visible) {
    for (const r of a.monthly || []) {
      const cur = byMonth.get(r.month) || {
        month: r.month, startValue: 0, endValue: 0, contributions: 0,
        dividends: 0, gain: 0, returnAmount: 0,
      };
      cur.startValue += r.startValue || 0; cur.endValue += r.endValue || 0;
      cur.contributions += r.contributions || 0; cur.dividends += r.dividends || 0;
      cur.gain += r.gain || 0; cur.returnAmount += r.returnAmount || 0;
      byMonth.set(r.month, cur);
    }
  }
  const monthly = [...byMonth.keys()].sort().map((m) => {
    const r = byMonth.get(m);
    const denom = r.startValue + r.contributions;
    return {
      month: m,
      startValue: round2(r.startValue), endValue: round2(r.endValue),
      contributions: round2(r.contributions), dividends: round2(r.dividends),
      gain: round2(r.gain), returnAmount: round2(r.returnAmount),
      returnPct: denom > 0 ? round2((r.returnAmount / denom) * 100) : null,
    };
  });
  const byMonthMap = new Map(monthly.map((r) => [r.month, r]));
  const months = spanMonths && spanMonths.length ? spanMonths : monthly.map((r) => r.month);
  let cumC = 0; let cumD = 0;
  const series = months.map((m) => {
    const r = byMonthMap.get(m);
    if (r) { cumC += r.contributions; cumD += r.dividends; }
    const value = r ? r.endValue : 0;
    return {
      month: m, value,
      contributions: round2(cumC),
      returnAmount: round2(value - cumC + cumD),
    };
  });
  const summary = {
    value: 0, contributions: 0, dividends: 0, totalReturn: 0,
    totalReturnPct: null, costUnknown: false,
  };
  for (const a of visible) {
    const s = a.summary || {};
    summary.value += s.value || 0; summary.contributions += s.contributions || 0;
    summary.dividends += s.dividends || 0; summary.totalReturn += s.totalReturn || 0;
    if (s.costUnknown) summary.costUnknown = true;
  }
  summary.value = round2(summary.value);
  summary.contributions = round2(summary.contributions);
  summary.dividends = round2(summary.dividends);
  summary.totalReturn = round2(summary.totalReturn);
  summary.totalReturnPct = summary.contributions > 0
    ? round2((summary.totalReturn / summary.contributions) * 100) : null;
  return { monthly, series, summary };
}
if (typeof window !== 'undefined') window.investVisibleAggregate = investVisibleAggregate;
if (typeof module !== 'undefined' && module.exports) module.exports = { investVisibleAggregate };
