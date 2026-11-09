// British Columbia T1 tables (Form BC428), by tax year.
//
// Sources (researched 2026-11-08; see
// ~/workspace/fm-verify/tax-home-switcher-/research-canada-tax.md):
// gov.bc.ca "Personal income tax rates" and "B.C. basic personal
// income tax credits", CRA "British Columbia tax information for
// 2025" (Form BC428) and the CRA current/last-year tax rates pages.
//
// 2026 change (BC Budget 2026): the lowest rate rose 5.06% → 5.6%.
// Indexation was 2.8% for 2025 and 2.2% for 2026, and is PAUSED for
// 2027–2030 (resumes 2031) — later years need their own verified
// table, never an indexed guess.
// The BC basic personal amount is NOT income-tested (unlike the
// federal BPA). BC has no Canada-employment-amount equivalent: its
// v1 non-refundable credits are BPA + base CPP + EI (+ disability),
// all valued at the BC lowest rate.
//
// The 2026 entry is pinned by unit test against the Earnings payroll
// module (src/regions/ca.js `payroll.provinces.BC`). Shape matches
// `payroll.provinces.BC` ({brackets, bpa, lowestRate}) so the same
// object feeds calcSalary.

const bracket = (upper, rate) => ({ upper, rate });

export const BC = {
  2025: {
    brackets: [
      bracket(49279, 0.0506), bracket(98560, 0.077), bracket(113158, 0.105),
      bracket(137407, 0.1229), bracket(186306, 0.147), bracket(259829, 0.168),
      bracket(Infinity, 0.205),
    ],
    bpa: 12932, lowestRate: 0.0506, disabilityAmount: 9699,
  },
  2026: {
    brackets: [
      bracket(50363, 0.056), bracket(100728, 0.077), bracket(115648, 0.105),
      bracket(140430, 0.1229), bracket(190405, 0.147), bracket(265545, 0.168),
      bracket(Infinity, 0.205),
    ],
    bpa: 13216, lowestRate: 0.056, disabilityAmount: 9913,
  },
};

// The BC table for a tax year, or null when the year has no
// verified table.
export function bcTable(taxYear) {
  return BC[Number(taxYear)] || null;
}

// Tax on a taxable income under the BC bracket table.
export function bcBracketTax(taxable, table) {
  const income = Math.max(0, Number(taxable) || 0);
  let tax = 0;
  let prev = 0;
  for (const b of table.brackets || []) {
    if (income <= prev) break;
    tax += (Math.min(income, b.upper) - prev) * b.rate;
    prev = b.upper;
  }
  return Math.round(tax * 100) / 100;
}

// BC non-refundable credit AMOUNTS (Form BC428 Part B) for the v1
// lines: BPA (58040) + base CPP (58120) + EI (58140) + disability
// (58440, the entered amount — see the research note: the federal
// and BC statutory maxima differ, so one entered amount is used on
// both lines). The credit VALUE is the amount total × lowest rate.
export function bcCreditAmounts({ cppBase = 0, ei = 0, disability = 0 } = {}, table) {
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const amounts = {
    bpa: table.bpa,
    cppBase: round2(cppBase),
    ei: round2(ei),
    disability: round2(disability),
  };
  amounts.total = round2(amounts.bpa + amounts.cppBase + amounts.ei + amounts.disability);
  amounts.value = round2(amounts.total * table.lowestRate);
  return amounts;
}
