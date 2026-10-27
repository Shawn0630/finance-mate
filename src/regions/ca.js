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
