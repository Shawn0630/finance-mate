// Region implementation: Canada (the only region for now).
//
// Everything region-specific lives behind this shape (see index.js):
//   - periodRate:  the mortgage interest convention — Canada quotes a
//                  nominal annual rate with semi-annual compounding.
//   - prime:       where the prime lending rate comes from and how to
//                  fetch it (Bank of Canada Valet, series V80691311 —
//                  verified live Oct 2026: "Prime rate", weekly; the
//                  V80691342 id sometimes quoted for it is actually
//                  the 1-month Treasury bill rate).
//   - assessment:  the property-assessment provider (BC Assessment,
//                  via the existing bca.js — passed through, not
//                  rewritten).
//   - assessmentHistory: the prior-years provider. BC Assessment
//                  publishes only the current roll, so the history
//                  behind it comes from HouseSigma (its assessment
//                  tables are drawn from the same public records).
// A future region (e.g. a US state) implements the same shape with
// its own conventions and providers.
import { fetchAssessment, suggestAddresses } from '../bca.js';
import { locateProperty, fetchHistory } from '../housesigma.js';

export const code = 'CA';
export const label = 'Canada';

// Per-period rate for a nominal annual rate (in %) over
// periodsPerYear payment periods, under the rate's compounding
// convention (a per-segment fact — the contract states it):
//   - 'semi_annual' (the Canadian standard, the default): the
//     nominal rate compounds semi-annually, i = (1 + r/2)^(2/N) - 1.
//     For N = 12 this is the familiar Canadian monthly rate.
//   - 'monthly': the nominal rate compounds at the payment
//     frequency ("calculated not in advance, at the same frequency
//     as your payments" — e.g. RBC variable-rate contracts),
//     i = (1 + r/12)^(12/N) - 1; for N = 12 that is simply r/12.
export function periodRate(annualRatePct, periodsPerYear, compounding = 'semi_annual') {
  const r = Number(annualRatePct) / 100;
  if (!isFinite(r) || r <= 0) return 0;
  if (compounding === 'monthly') return Math.pow(1 + r / 12, 12 / periodsPerYear) - 1;
  return Math.pow(1 + r / 2, 2 / periodsPerYear) - 1;
}

export const primeSource = {
  name: 'Bank of Canada Valet',
  series: 'V80691311',
  label: 'Bank of Canada prime rate',
};

// Fetch the prime series from the Bank of Canada Valet API and
// return [{ date, rate }] newest first. The range starts 2023-01-01
// and runs to the newest observation (~200 weekly rows): the full
// history, not a recent window — projections price each past month
// at that month's prime, so the stored series has to reach back as
// far as a mortgage can. Throws on any failure — callers keep the
// last known values rather than inventing one. PRIME_API_URL is a
// test seam (the e2e suite points it at a stub), mirroring
// BCA_BASE_URL.
export async function fetchPrimeRates(timeoutMs = 10000) {
  const url = process.env.PRIME_API_URL
    || 'https://www.bankofcanada.ca/valet/observations/V80691311/json?start_date=2023-01-01';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FinanceMate/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`prime fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const rates = (data.observations || [])
    .map((o) => {
      const key = Object.keys(o).find((k) => k !== 'd');
      return { date: o.d, rate: key ? Number(o[key].v) : NaN };
    })
    .filter((o) => o.date && isFinite(o.rate))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!rates.length) throw new Error('prime fetch returned no observations');
  return rates;
}

export const assessment = {
  providerName: 'BC Assessment',
  suggestAddresses,
  fetchAssessment,
};

export const assessmentHistory = {
  providerName: 'HouseSigma',
  locateProperty,
  fetchHistory,
};

// ---------------------------------------------------------------- payroll --
// Canada payroll tables for the Earnings module (tax year 2026).
//
// Sources (verified Oct 2026): CRA "Current year tax rates and income
// brackets" page (federal + Alberta + BC brackets), gov.bc.ca personal
// tax rates page (BC 2026, indexed 2.2%), and corroborating 2026
// calculators for Ontario (brackets, surtax thresholds $5,818/$7,446,
// health-premium tiers). Federal BPA phase-out $181,440→$258,482 and
// the CPP/EI 2026 figures are from the CRA research pass.
// The Canada employment amount maximum ($1,501) comes from a CRA T4032
// worked example — applied, but flagged in code comments as the one
// figure to confirm against T4127 Chapter 8 before relying on it.
//
// Shape a future region must implement for payroll:
//   { taxYear, federal: {brackets, bpaMax, bpaBase, phaseOutStart,
//     phaseOutEnd, lowestRate, employmentAmountMax},
//     cpp: {ympe, yampe, exemption, rate, baseRate, cpp2Rate, max, max2},
//     ei: {mie, rate, max},
//     provinces: { CODE: {verified, brackets, bpa, lowestRate,
//       surtax?, healthPremium?} } }
// Provinces without a verified table carry verified:false and NO
// brackets — the engine then computes federal + CPP/EI only and says
// so, instead of inventing a provincial number. Quebec is deliberately
// unverified here: it runs QPP/QPIP and a separate Revenu Québec
// return, so it needs its own region variant, not a table row.
const bracket = (upper, rate) => ({ upper, rate });

export const payroll = {
  taxYear: 2026,
  federal: {
    brackets: [bracket(58523, 0.14), bracket(117045, 0.205), bracket(181440, 0.26), bracket(258482, 0.29), bracket(Infinity, 0.33)],
    bpaMax: 16452, bpaBase: 14829, phaseOutStart: 181440, phaseOutEnd: 258482,
    lowestRate: 0.14, employmentAmountMax: 1501, // T4032 worked example — confirm vs T4127 Ch.8
  },
  cpp: { ympe: 74600, yampe: 85000, exemption: 3500, rate: 0.0595, baseRate: 0.0495, cpp2Rate: 0.04, max: 4230.45, max2: 416 },
  ei: { mie: 68900, rate: 0.0163, max: 1123.07 },
  provinces: {
    BC: { verified: true, label: 'British Columbia', bpa: 13216, lowestRate: 0.056,
      brackets: [bracket(50363, 0.056), bracket(100728, 0.077), bracket(115648, 0.105), bracket(140430, 0.1229), bracket(190405, 0.147), bracket(265545, 0.168), bracket(Infinity, 0.205)] },
    AB: { verified: true, label: 'Alberta', bpa: 22769, lowestRate: 0.08,
      brackets: [bracket(61200, 0.08), bracket(154259, 0.10), bracket(185111, 0.12), bracket(246813, 0.13), bracket(370220, 0.14), bracket(Infinity, 0.15)] },
    ON: { verified: true, label: 'Ontario', bpa: 12989, lowestRate: 0.0505,
      brackets: [bracket(53891, 0.0505), bracket(107785, 0.0915), bracket(150000, 0.1116), bracket(220000, 0.1216), bracket(Infinity, 0.1316)],
      surtax: [{ threshold: 5818, rate: 0.20 }, { threshold: 7446, rate: 0.36 }],
      healthPremium: [ // [upper taxable income, premium]: the graduated tiers
        { upper: 20000, premium: 0 }, { upper: 36000, premium: 300 }, { upper: 48000, premium: 450 },
        { upper: 72000, premium: 600 }, { upper: 200000, premium: 750 }, { upper: Infinity, premium: 900 },
      ] },
    MB: { verified: false, label: 'Manitoba' },
    SK: { verified: false, label: 'Saskatchewan' },
    QC: { verified: false, label: 'Quebec', note: 'Quebec runs QPP/QPIP and a separate Revenu Québec return — not a CRA-table province.' },
    NB: { verified: false, label: 'New Brunswick' },
    NS: { verified: false, label: 'Nova Scotia' },
    PE: { verified: false, label: 'Prince Edward Island' },
    NL: { verified: false, label: 'Newfoundland and Labrador' },
    YT: { verified: false, label: 'Yukon' },
    NT: { verified: false, label: 'Northwest Territories' },
    NU: { verified: false, label: 'Nunavut' },
  },
};

// ----------------------------------------------------------------- rental --
// Canada rental rules for the Earnings module (CRA Guide T4036, form
// T776). Shape a future region must implement for rental:
//   { t776Lines: [{line, key, label}], ccaClasses: [{class, rate}],
//     gst: {longTermExempt, shortTermTaxable, smallSupplierThreshold} }.
export const rental = {
  t776Lines: [
    { line: '8521', key: 'advertising', label: 'Advertising' },
    { line: '8690', key: 'insurance', label: 'Insurance' },
    { line: '8710', key: 'interest', label: 'Interest and bank charges' },
    { line: '8810', key: 'office', label: 'Office expenses' },
    { line: '8860', key: 'professional', label: 'Legal, accounting and other professional fees' },
    { line: '8871', key: 'management', label: 'Management and administration fees' },
    { line: '8960', key: 'repairs', label: 'Repairs and maintenance' },
    { line: '9060', key: 'salaries', label: 'Salaries, wages and benefits' },
    { line: '9180', key: 'property_taxes', label: 'Property taxes' },
    { line: '9200', key: 'travel', label: 'Travel' },
    { line: '9220', key: 'utilities', label: 'Utilities' },
    { line: '9281', key: 'motor_vehicle', label: 'Motor vehicle expenses (excluding CCA)' },
    { line: '9270', key: 'other', label: 'Other expenses (including condo/strata fees)' },
  ],
  ccaClasses: [
    { class: 1, rate: 0.04, label: 'Class 1 — building' },
    { class: 8, rate: 0.20, label: 'Class 8 — equipment and furniture' },
  ],
  gst: { longTermExempt: true, shortTermTaxable: true, smallSupplierThreshold: 30000 },
};
