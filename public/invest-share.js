// Range-end account-share computation for the Stocks portfolio
// doughnut. Pure: no DOM, no side effects, so the node unit
// tests load this exact file (via vm) instead of a copy.
//   accounts: [{ account, series: [{ month, value }] }] —
//     series points are month-end values in the page's display
//     currency, ascending by month (the payload the portfolio
//     chart already carries per account).
//   endMonth: 'YYYY-MM' in force, or null when there is no span.
// Value at the end month carries forward like the portfolio
// chart's bars: the last point dated <= endMonth, else 0.
// Accounts at 0 are dropped — a zero slice is not a share.
function investShareAtMonth(accounts, endMonth) {
  const rows = [];
  if (!endMonth) return { rows, total: 0 };
  for (const a of accounts || []) {
    let value = 0;
    let best = '';
    for (const p of a.series || []) {
      const v = p ? Number(p.value) : NaN;
      if (p && p.month && p.month <= endMonth && p.month > best && Number.isFinite(v)) {
        best = p.month;
        value = v;
      }
    }
    if (value > 0) rows.push({ account: a.account, value });
  }
  return { rows, total: rows.reduce((s, r) => s + r.value, 0) };
}
if (typeof window !== 'undefined') window.investShareAtMonth = investShareAtMonth;
if (typeof module !== 'undefined' && module.exports) module.exports = { investShareAtMonth };
