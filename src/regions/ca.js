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
// A future region (e.g. a US state) implements the same shape with
// its own conventions and providers.
import { fetchAssessment, suggestAddresses } from '../bca.js';

export const code = 'CA';
export const label = 'Canada';

// Per-period rate for a nominal annual rate (in %) over
// periodsPerYear payment periods: i = (1 + r/2)^(2/N) - 1.
// For N = 12 this is the familiar Canadian monthly rate.
export function periodRate(annualRatePct, periodsPerYear) {
  const r = Number(annualRatePct) / 100;
  if (!isFinite(r) || r <= 0) return 0;
  return Math.pow(1 + r / 2, 2 / periodsPerYear) - 1;
}

export const primeSource = {
  name: 'Bank of Canada Valet',
  series: 'V80691311',
  label: 'Bank of Canada prime rate',
};

// Fetch the prime series from the Bank of Canada Valet API and
// return [{ date, rate }] newest first (about two years of weekly
// observations). Throws on any failure — callers keep the last known
// values rather than inventing one. PRIME_API_URL is a test seam
// (the e2e suite points it at a stub), mirroring BCA_BASE_URL.
export async function fetchPrimeRates(timeoutMs = 10000) {
  const url = process.env.PRIME_API_URL
    || 'https://www.bankofcanada.ca/valet/observations/V80691311/json?recent=104';
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
