// Federal (Canada) T1 tables, by tax year.
//
// Sources (researched 2026-11-08; see
// ~/workspace/fm-verify/tax-home-switcher-/research-canada-tax.md):
// CRA "Canadian income tax rates for individuals", Dept. of Finance
// Canada (middle-class tax cut, Bill C-4), CRA T1 2025 form 5005-R
// (line 31260 prints $1,471; line 33800 prints "× 14.5%"), CRA "CPP
// contribution rates, maximums and exemptions" + "Second additional
// CPP contribution (CPP2) rates and maximums", CRA "EI premium rates
// and maximums", CRA "Claiming the [disability] credit" (2025 $10,138;
// 2026 $10,341).
//
// The 2026 entries are pinned by unit test against the Earnings
// payroll module (src/regions/ca.js `payroll`) — the two table sets
// must not drift apart. Shape matches `payroll` exactly
// ({federal, cpp, ei}) so the same object feeds calcSalary.
//
// The lowest bracket rate is also the non-refundable credit rate:
// 14.5% for 2025 (the July 1, 2025 cut from 15% to 14%, blended for
// the full year), 14% flat from 2026. Never 15% for 2025+.

const bracket = (upper, rate) => ({ upper, rate });

export const FEDERAL = {
  2025: {
    brackets: [
      bracket(57375, 0.145), bracket(114750, 0.205), bracket(177882, 0.26),
      bracket(253414, 0.29), bracket(Infinity, 0.33),
    ],
    bpaMax: 16129, bpaBase: 14538, phaseOutStart: 177882, phaseOutEnd: 253414,
    lowestRate: 0.145, employmentAmountMax: 1471,
    cpp: { ympe: 71300, yampe: 81200, exemption: 3500, rate: 0.0595, baseRate: 0.0495, cpp2Rate: 0.04, max: 4034.10, max2: 396 },
    ei: { mie: 65700, rate: 0.0164, max: 1077.48 },
    disabilityAmount: 10138,
  },
  2026: {
    brackets: [
      bracket(58523, 0.14), bracket(117045, 0.205), bracket(181440, 0.26),
      bracket(258482, 0.29), bracket(Infinity, 0.33),
    ],
    bpaMax: 16452, bpaBase: 14829, phaseOutStart: 181440, phaseOutEnd: 258482,
    lowestRate: 0.14, employmentAmountMax: 1501,
    cpp: { ympe: 74600, yampe: 85000, exemption: 3500, rate: 0.0595, baseRate: 0.0495, cpp2Rate: 0.04, max: 4230.45, max2: 416 },
    ei: { mie: 68900, rate: 0.0163, max: 1123.07 },
    disabilityAmount: 10341,
  },
};

// The federal table for a tax year, or null when the year has no
// verified table (the caller reports "unsupported year" rather than
// computing from a guessed table).
export function federalTable(taxYear) {
  return FEDERAL[Number(taxYear)] || null;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Tax on a taxable income under a bracket table: each bracket
// taxes only the slice inside it.
export function bracketTax(taxable, brackets) {
  const income = Math.max(0, Number(taxable) || 0);
  let tax = 0;
  let prev = 0;
  for (const b of brackets || []) {
    if (income <= prev) break;
    tax += (Math.min(income, b.upper) - prev) * b.rate;
    prev = b.upper;
  }
  return round2(tax);
}

// The federal basic personal amount for a net income: full up to
// phaseOutStart, the minimum above phaseOutEnd, linear taper
// between (CRA indexation table).
export function basicPersonalAmount(netIncome, table) {
  const net = Math.max(0, Number(netIncome) || 0);
  if (net <= table.phaseOutStart) return table.bpaMax;
  if (net >= table.phaseOutEnd) return table.bpaBase;
  const frac = (net - table.phaseOutStart) / (table.phaseOutEnd - table.phaseOutStart);
  return round2(table.bpaMax - frac * (table.bpaMax - table.bpaBase));
}

// The CPP split for pensionable earnings in a year: base (4.95% —
// a non-refundable CREDIT, line 30800) vs enhancement (1.00% up to
// YMPE + 4% CPP2 between YMPE and YAMPE — a DEDUCTION, line 22215).
// Used for the T4-slip fallback when no job rows exist; the job
// path reuses calcSalary, which computes the same split.
export function cppSplit(pensionableEarnings, cpp) {
  const earn = Math.max(0, Number(pensionableEarnings) || 0);
  const base = Math.min(Math.max(0, Math.min(earn, cpp.ympe) - cpp.exemption) * cpp.baseRate,
    Math.max(0, (cpp.ympe - cpp.exemption) * cpp.baseRate));
  const total = Math.min(Math.max(0, Math.min(earn, cpp.ympe) - cpp.exemption) * cpp.rate, cpp.max)
    + Math.min(Math.max(0, earn - cpp.ympe) * cpp.cpp2Rate, cpp.max2);
  return { base: round2(base), enhancement: round2(Math.max(0, total - base)), total: round2(total) };
}

// EI premium on insurable earnings in a year (line 31200).
export function eiPremium(insurableEarnings, ei) {
  return round2(Math.min(Math.max(0, Number(insurableEarnings) || 0), ei.mie) * ei.rate);
}
