// Earnings — salary gross-to-net and rental T776 summaries.
//
// Pure computation + input validation. Region-specific numbers (tax
// brackets, CPP/EI, T776 lines, CCA classes) come from the region
// layer (src/regions/ca.js); nothing Canadian is hard-coded here, so
// a future region implements the same payroll/rental shape.
//
// SALARY MODEL — a simplified T4127-style estimate, documented
// honestly: CRA's statutory withholding uses the full T4127 formula
// (K factors, exact TD1 handling) and will differ from this estimate
// by small amounts. Every salary surface therefore carries an
// "estimate — actual tax is settled on the T1" note. What IS exact
// here: the CPP/CPP2/EI annual amounts and caps (pinned by tests),
// and the frequency annualisation.
//   annualGross = per-period gross × periodsPerYear
//   cpp  = min(max(0, min(annualGross, ympe) − exemption) × rate, max) − ytdCpp
//   cpp2 = min(max(0, annualGross − ympe) × cpp2Rate, max2) − ytdCpp2
//   ei   = min(annualGross, mie) × rate − ytdEi
//   cppBase = 4.95% portion of cpp (a credit); the rest of cpp plus
//     all of cpp2 is a deduction from income (the CPP enhancement).
//   taxable = annualGross − cppEnhancement
//   federalTax = bracketTax(federal, taxable)
//     − (td1Federal + cppBase + ei) × federalLowestRate
//     − min(annualGross, employmentAmountMax) × federalLowestRate
//   provincialTax = bracketTax(province, taxable)
//     − (td1Provincial + cppBase + ei) × provincialLowestRate
//     (+ Ontario surtax + Ontario health premium)
//   All taxes floored at 0. Per-period figures = annual ÷ periods.
//   The default TD1 claim is the basic personal amount (federal BPA
//   phases out $181,440→$258,482); an entered TD1 total replaces it.
//
// RENTAL MODEL — one T776-equivalent per property per tax year:
//   shared expenses are pro-rated by area share × time share;
//   direct expenses count 100%. Personal portion (line 9949) is the
//   shared part that is NOT deductible. Mortgage interest flows to
//   line 8710; mortgage principal NEVER flows to any expense line.
//   CCA is optional, capped at net-before-CCA (it cannot create or
//   increase a loss), and blocked with a warning on any (former)
//   principal residence unless explicitly acknowledged (the PRE trap).
//   Long-term residential rent is GST/HST-exempt: no GST fields exist
//   on that path. Short-term rent is taxable: the summary carries the
//   registration-threshold note and the s.67.7 non-compliant-day
//   expense denial. Hotel-like services route to T2125, not T776.
//   RENT ENTRIES — the year record's rent figures are DERIVED, not
//   typed: the user enters rent entries (a tenancy period, a monthly
//   amount, the day of the month rent is paid, an optional cash
//   portion, an optional tenant name as a raw string) and the app
//   computes each tax year's gross rents and rented days from them.
//   Month granularity: a covered month counts fully, no mid-month
//   pro-rating. Gross sums across entries; rented days count the
//   UNION of covered months, so two overlapping tenancies never push
//   days past the year's calendar. Pay day is recorded only — it
//   never shifts year attribution; coverage months govern. An entry
//   with no end month is ongoing and covers through the current
//   month.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const PAY_FREQUENCIES = {
  weekly: { periods: 52, label: 'Weekly' },
  biweekly: { periods: 26, label: 'Bi-weekly' },
  semimonthly: { periods: 24, label: 'Semi-monthly' },
  monthly: { periods: 12, label: 'Monthly' },
  annual: { periods: 1, label: 'Annual salary' },
};

export const PROVINCE_CODES = ['BC', 'AB', 'ON', 'MB', 'SK', 'QC', 'NB', 'NS', 'PE', 'NL', 'YT', 'NT', 'NU'];
export const RENTAL_TYPES = ['long_term', 'short_term', 'commercial'];
export const RENTAL_TYPE_LABELS = { long_term: 'Long-term', short_term: 'Short-term', commercial: 'Commercial' };
export const SERVICE_LEVELS = ['basic', 'hotel_like'];

export function bracketTax(brackets, income) {
  let tax = 0;
  let lower = 0;
  for (const b of brackets || []) {
    if (income <= lower) break;
    tax += (Math.min(income, b.upper) - lower) * b.rate;
    lower = b.upper;
  }
  return tax;
}

// Full-year CPP / CPP2 / EI entitlements for an annual gross, before
// any YTD offset — the same formulas calcSalary subtracts YTD from.
// Extracted so the simplified job form's YTD derivation prices each
// elapsed pay period at exactly the rate the engine would.
export function cppEntitlement(annualGross, cpp) {
  return Math.min(Math.max(0, Math.min(annualGross, cpp.ympe) - cpp.exemption) * cpp.rate, cpp.max);
}
export function cpp2Entitlement(annualGross, cpp) {
  return Math.min(Math.max(0, annualGross - cpp.ympe) * cpp.cpp2Rate, cpp.max2);
}
export function eiEntitlement(annualGross, ei) {
  return Math.min(annualGross, ei.mie) * ei.rate;
}

export function federalBpa(income, fed) {
  if (income <= fed.phaseOutStart) return fed.bpaMax;
  if (income >= fed.phaseOutEnd) return fed.bpaBase;
  return fed.bpaMax - (fed.bpaMax - fed.bpaBase) * ((income - fed.phaseOutStart) / (fed.phaseOutEnd - fed.phaseOutStart));
}

export function ontarioHealthPremium(taxableIncome, tiers) {
  // Graduated tiers: the premium steps up at each threshold (the
  // within-tier percentages in CRA tables are approximated by the
  // tier ceilings here — the premium is an estimate line, labelled so).
  let premium = 0;
  for (const t of tiers || []) {
    if (taxableIncome > t.upper) premium = t.premium;
    else break;
  }
  // The top tier's ceiling is the $900 cap.
  return premium;
}

function ontarioSurtax(basicTax, surtax) {
  // Surtax tiers stack: each slice between thresholds is taxed at
  // that tier's rate (20% over $5,818, plus 36% over $7,446).
  let total = 0;
  const sorted = [...(surtax || [])].sort((a, b) => a.threshold - b.threshold);
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i].threshold;
    const hi = i + 1 < sorted.length ? sorted[i + 1].threshold : Infinity;
    if (basicTax > lo) total += (Math.min(basicTax, hi) - lo) * sorted[i].rate;
  }
  return total;
}

// ------------------------------------------------------------ salary --
const cleanStr = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const numOr = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const optNum = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ------------------------------------------- simplified job derivation --
// The simplified Add job form asks only for key facts — employer,
// earner, province, frequency, job start date, recent pay date and
// that pay's gross value, plus optional dated pay-change rows
// (effective date + new per-period value) and bonus entries (date +
// amount). Everything the old form asked for is derived here:
//
//   annual gross = current per-period value × periods/year
//   tax year     = year of the recent payment date
//   TD1 claims   = blank = basic personal amounts (no fields)
//   YTD CPP/CPP2/EI = Σ over the pay dates in the YTD window of
//     (that segment's full-year entitlement ÷ periods/year)
//
// YTD means year-to-date, so the window runs from the later of the
// job start date and January 1 of the recent payment's year through
// the recent payment date. Pay dates follow the frequency's cadence
// anchored at the start date (weekly / bi-weekly step 7 / 14 days,
// monthly steps the start date's day-of-month clamped to month-end);
// semi-monthly pays on the 15th and month-end; annual pays once, on
// the recent payment date itself.
//
// Segment rule for pay changes: the recent value is the CURRENT
// segment. A pay date takes the latest change on or before it, or
// the recent value once past the last change; pay dates before the
// first listed change take the first change's value (the list is
// assumed to start at or before the window — a mid-year raise is
// entered as two rows: the pre-raise rate from the start and the
// new rate from the raise date). A post-raise rate is therefore
// never annualised over pre-raise periods.

const JOB_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function normJobDate(v) {
  if (typeof v !== 'string' || !JOB_DATE_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}

function jobDayNum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
function jobDayStr(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function ymPad(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function payDatesInWindow(frequency, from, to, anchor) {
  if (from > to) return [];
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'weekly' ? 7 : 14;
    const fromN = jobDayNum(from);
    const toN = jobDayNum(to);
    let n = jobDayNum(anchor);
    if (n < fromN) n += Math.ceil((fromN - n) / step) * step;
    const out = [];
    while (n <= toN) { out.push(jobDayStr(n)); n += step; }
    return out;
  }
  if (frequency === 'monthly') {
    const anchorDay = Number(anchor.slice(8, 10));
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const out = [];
    for (;;) {
      const cand = ymPad(y, m, Math.min(anchorDay, lastDayOfMonth(y, m)));
      if (cand >= from) break;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    for (;;) {
      const cand = ymPad(y, m, Math.min(anchorDay, lastDayOfMonth(y, m)));
      if (cand > to) break;
      out.push(cand);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  if (frequency === 'semimonthly') {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const out = [];
    for (;;) {
      const mid = ymPad(y, m, 15);
      const end = ymPad(y, m, lastDayOfMonth(y, m));
      if (mid >= from && mid <= to) out.push(mid);
      if (end >= from && end <= to) out.push(end);
      if (end > to) break;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  return [to]; // annual: one pay in the window, on the recent date
}

export function deriveJobYtd({ frequency, startDate, recentDate, changes, recentValue, payroll, cppExempt, eiExempt }) {
  const periods = PAY_FREQUENCIES[frequency].periods;
  const taxYear = Number(recentDate.slice(0, 4));
  const yearStart = `${taxYear}-01-01`;
  const windowStart = startDate > yearStart ? startDate : yearStart;
  const pays = payDatesInWindow(frequency, windowStart, recentDate, startDate);
  const sorted = [...(changes || [])].sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1));
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  const valueAt = (d) => {
    if (last && d >= last.effective_date) return recentValue;
    let v = null;
    for (const c of sorted) { if (c.effective_date <= d) v = c.value; else break; }
    return v != null ? v : (sorted.length ? sorted[0].value : recentValue);
  };
  let ytdCpp = 0;
  let ytdCpp2 = 0;
  let ytdEi = 0;
  for (const d of pays) {
    const ann = valueAt(d) * periods;
    if (!cppExempt) {
      ytdCpp += cppEntitlement(ann, payroll.cpp) / periods;
      ytdCpp2 += cpp2Entitlement(ann, payroll.cpp) / periods;
    }
    if (!eiExempt) ytdEi += eiEntitlement(ann, payroll.ei) / periods;
  }
  return {
    ytd_cpp: round2(Math.min(ytdCpp, payroll.cpp.max)),
    ytd_cpp2: round2(Math.min(ytdCpp2, payroll.cpp.max2)),
    ytd_ei: round2(Math.min(ytdEi, payroll.ei.max)),
    elapsed_periods: pays.length,
  };
}

// Take-home input: back-solve the per-period gross whose computed
// per-period net equals the entered take-home pay, to the cent.
// The solve inverts the existing pipeline — deriveJobYtd for the YTD
// (the current segment priced at the candidate gross) and calcSalary
// for the per-period net — no tax formula is reimplemented here. The
// per-period net is non-decreasing in the gross (deductions are
// floored at 0 and marginal rates stay below 100%), so bisection
// over the candidate gross converges; the returned gross is the
// smallest value, to the cent, whose computed net equals the target.
// A target no gross yields (e.g. below the net of a bonus-only job)
// is an error, never a silent fallback.
export function solveGrossForTakeHome({ targetNet, frequency, province, startDate, recentDate,
  changes, bonuses, payroll, td1Federal, td1Provincial, cppExempt, eiExempt }) {
  const target = Number(targetNet);
  if (!Number.isFinite(target) || target < 0) return { error: 'take-home pay must be a number ≥ 0.' };
  if (!PAY_FREQUENCIES[frequency] || !payroll) return { error: 'take-home pay needs a valid pay frequency.' };
  const bonusTotal = (bonuses || []).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const netAt = (gross) => {
    const ytd = deriveJobYtd({
      frequency, startDate, recentDate, changes, recentValue: gross, payroll, cppExempt, eiExempt,
    });
    return calcSalary({
      frequency, gross_amount: gross, gross_basis: 'period', province, bonus_total: bonusTotal,
      ytd_cpp: ytd.ytd_cpp, ytd_cpp2: ytd.ytd_cpp2, ytd_ei: ytd.ytd_ei,
      td1_federal: td1Federal ?? null, td1_provincial: td1Provincial ?? null,
      cpp_exempt: !!cppExempt, ei_exempt: !!eiExempt,
    }, payroll).perPeriod.net;
  };
  const unreachable = 'no per-period gross produces that take-home pay.';
  if (netAt(0) > target) return { error: unreachable };
  if (netAt(0) === target) return { gross: 0 };
  let lo = 0;
  let hi = Math.max(target, 1);
  while (netAt(hi) < target) {
    hi *= 2;
    if (hi > 1e9) return { error: unreachable };
  }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (netAt(mid) >= target) hi = mid; else lo = mid;
  }
  // Bisection lands within a fraction of a cent; round to cents and
  // step by cents to the exact match (the rounded net moves at most
  // one cent per cent of gross, so no cent value is skipped).
  let g = round2(hi);
  let guard = 0;
  while (netAt(g) < target && guard++ < 1000) g = round2(g + 0.01);
  guard = 0;
  while (netAt(g) > target && guard++ < 1000) g = round2(g - 0.01);
  if (g < 0 || netAt(g) !== target) return { error: unreachable };
  return { gross: g };
}

export function validPayChanges(rows, startDate) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) return { error: 'pay changes must be an array.' };
  const out = [];
  for (const r of rows) {
    const d = normJobDate(r && r.effective_date);
    const rawV = r && r.value;
    const v = rawV === '' || rawV == null ? NaN : Number(rawV);
    if (!d) return { error: 'each pay change needs a valid effective date.' };
    if (!Number.isFinite(v) || v < 0) return { error: 'each pay change needs a per-period value ≥ 0.' };
    if (startDate && d < startDate) return { error: 'pay change date must be on or after the job start date.' };
    out.push({ effective_date: d, value: v });
  }
  out.sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1));
  return out;
}

export function validBonuses(rows) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) return { error: 'bonuses must be an array.' };
  const out = [];
  for (const r of rows) {
    const d = normJobDate(r && r.date);
    const rawA = r && r.amount;
    const a = rawA === '' || rawA == null ? NaN : Number(rawA);
    if (!d) return { error: 'each bonus needs a valid date.' };
    if (!Number.isFinite(a) || a < 0) return { error: 'each bonus needs an amount ≥ 0.' };
    out.push({ date: d, amount: a });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

export function validJobInput(body) {
  const b = body || {};
  const employer = cleanStr(b.employer, 120);
  if (!employer) return { error: 'employer is required.' };
  const province = String(b.province || '').toUpperCase();
  if (!PROVINCE_CODES.includes(province)) return { error: 'province must be a Canadian province or territory code.' };
  const frequency = String(b.frequency || '');
  if (!PAY_FREQUENCIES[frequency]) return { error: 'frequency must be weekly, biweekly, semimonthly, monthly or annual.' };
  const currency = cleanStr(b.currency, 3) || 'CAD';
  // Simplified mode: any simplified field present means the new form
  // is in use — start date, recent pay date and recent pay value are
  // then all required, and gross / tax year / YTD are derived, never
  // typed. TD1 and exemption flags are not fields of the new form:
  // new jobs take the defaults, edits preserve the stored values
  // (the route decides — validJobInput leaves them undefined here).
  const simplified = b.start_date !== undefined || b.recent_pay_date !== undefined || b.recent_pay_value !== undefined;
  if (simplified) {
    const startDate = normJobDate(b.start_date);
    const recentDate = normJobDate(b.recent_pay_date);
    const recentValue = b.recent_pay_value === '' || b.recent_pay_value === undefined || b.recent_pay_value === null
      ? null : Number(b.recent_pay_value);
    if (!startDate) return { error: 'job start date must be a valid date.' };
    if (!recentDate) return { error: 'recent payment date must be a valid date.' };
    if (recentDate < startDate) return { error: 'recent payment date must be on or after the job start date.' };
    if (recentValue == null || !Number.isFinite(recentValue) || recentValue < 0) return { error: 'recent payment value must be a number ≥ 0.' };
    const payChanges = validPayChanges(b.pay_changes, startDate);
    if (payChanges.error) return payChanges;
    const bonuses = validBonuses(b.bonuses);
    if (bonuses.error) return bonuses;
    return {
      mode: 'derived', employer, province, frequency, currency: currency.toUpperCase(),
      owner: cleanStr(b.owner, 120),
      start_date: startDate, recent_pay_date: recentDate, recent_pay_value: recentValue,
      pay_changes: payChanges, bonuses,
      gross_amount: recentValue, gross_basis: 'period', tax_year: Number(recentDate.slice(0, 4)),
      td1_federal: undefined, td1_provincial: undefined, ytd_cpp: null, ytd_cpp2: null, ytd_ei: null,
      cpp_exempt: undefined, ei_exempt: undefined,
    };
  }
  // Legacy mode: the old form's fields, exactly as before — old rows
  // and old clients keep working, and old jobs edited without dates
  // keep their stored gross / tax year / YTD untouched (the route
  // leaves the derived columns alone on a legacy save).
  const grossAmount = Number(b.gross_amount);
  if (!Number.isFinite(grossAmount) || grossAmount < 0) return { error: 'gross amount must be a number ≥ 0.' };
  const grossBasis = b.gross_basis === 'period' ? 'period' : 'annual';
  const taxYear = Number(b.tax_year);
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) return { error: 'tax year must be a valid year.' };
  // Deliberately no SIN, birth date, bank details, employer payroll
  // account number, or T4 fields: none of them affect this estimate.
  // Owner is the single earner (T1 is per-person): a bare username,
  // null when unassigned. Candidate validation (existing non-admin
  // user, never 'Joint') lives server-side with the users table.
  return {
    mode: 'legacy', employer, province, frequency, gross_amount: grossAmount, gross_basis: grossBasis,
    tax_year: taxYear, currency: currency.toUpperCase(),
    owner: cleanStr(b.owner, 120),
    td1_federal: optNum(b.td1_federal), td1_provincial: optNum(b.td1_provincial),
    ytd_cpp: numOr(b.ytd_cpp, 0), ytd_cpp2: numOr(b.ytd_cpp2, 0), ytd_ei: numOr(b.ytd_ei, 0),
    cpp_exempt: b.cpp_exempt === true || b.cpp_exempt === 1 || b.cpp_exempt === '1',
    ei_exempt: b.ei_exempt === true || b.ei_exempt === 1 || b.ei_exempt === '1',
  };
}

export function calcSalary(job, payroll) {
  const periods = PAY_FREQUENCIES[job.frequency].periods;
  // Salary annualised from the per-period rate; bonuses (job.bonus_total,
  // default 0) count into the year's gross — pensionable/insurable like
  // other earnings — but never into the per-period rate, which stays
  // salary-only. A job without bonuses computes exactly as before.
  const salaryAnnual = job.gross_basis === 'period' ? job.gross_amount * periods : job.gross_amount;
  const annualGross = salaryAnnual + (job.bonus_total || 0);
  const perPeriodGross = salaryAnnual / periods;
  const warnings = [];
  const { cpp, ei, federal } = payroll;
  let cppAnnual = 0;
  let cpp2Annual = 0;
  let eiAnnual = 0;
  if (!job.cpp_exempt) {
    cppAnnual = Math.max(0, cppEntitlement(annualGross, cpp) - (job.ytd_cpp || 0));
    cpp2Annual = Math.max(0, cpp2Entitlement(annualGross, cpp) - (job.ytd_cpp2 || 0));
  }
  if (!job.ei_exempt) {
    eiAnnual = Math.max(0, eiEntitlement(annualGross, ei) - (job.ytd_ei || 0));
  }
  const cppBase = job.cpp_exempt ? 0
    : Math.min(Math.max(0, Math.min(annualGross, cpp.ympe) - cpp.exemption) * cpp.baseRate,
      Math.max(0, (cpp.ympe - cpp.exemption) * cpp.baseRate));
  const cppEnhancement = Math.max(0, (cppAnnual + (job.ytd_cpp || 0) + cpp2Annual + (job.ytd_cpp2 || 0)) - cppBase);
  const taxable = Math.max(0, annualGross - cppEnhancement);
  const td1Federal = job.td1_federal != null ? job.td1_federal : federalBpa(taxable, federal);
  const employmentCredit = Math.min(annualGross, federal.employmentAmountMax) * federal.lowestRate;
  const federalTax = Math.max(0, bracketTax(federal.brackets, taxable)
    - (td1Federal + cppBase + eiAnnual + (job.ytd_ei || 0)) * federal.lowestRate - employmentCredit);
  const prov = payroll.provinces[job.province];
  let provincialTax = null;
  let healthPremium = 0;
  if (prov && prov.verified) {
    const td1Prov = job.td1_provincial != null ? job.td1_provincial : prov.bpa;
    const basic = Math.max(0, bracketTax(prov.brackets, taxable)
      - (td1Prov + cppBase + eiAnnual + (job.ytd_ei || 0)) * prov.lowestRate);
    provincialTax = basic;
    if (prov.surtax) provincialTax += ontarioSurtax(basic, prov.surtax);
    if (prov.healthPremium) {
      healthPremium = ontarioHealthPremium(taxable, prov.healthPremium);
      provincialTax += healthPremium;
    }
  } else {
    warnings.push(prov && prov.note
      ? `Provincial table unverified — ${prov.note} Federal tax, CPP and EI are computed; provincial tax is not.`
      : 'Provincial table unverified — federal tax, CPP and EI are computed; provincial tax is not.');
  }
  const totalTax = federalTax + (provincialTax || 0);
  const netAnnual = annualGross - cppAnnual - cpp2Annual - eiAnnual - totalTax;
  const div = (n) => round2(n / periods);
  return {
    annualGross: round2(annualGross), perPeriodGross: round2(perPeriodGross),
    cpp: round2(cppAnnual), cpp2: round2(cpp2Annual), ei: round2(eiAnnual),
    cppBase: round2(cppBase), cppEnhancement: round2(cppEnhancement),
    taxableIncome: round2(taxable), td1Federal: round2(td1Federal),
    federalTax: round2(federalTax), provincialTax: provincialTax == null ? null : round2(provincialTax),
    healthPremium: round2(healthPremium), totalTax: round2(totalTax), netAnnual: round2(netAnnual),
    perPeriod: {
      gross: round2(perPeriodGross), cpp: div(cppAnnual), cpp2: div(cpp2Annual), ei: div(eiAnnual),
      federalTax: div(federalTax), provincialTax: provincialTax == null ? null : div(provincialTax),
      totalTax: div(totalTax), net: div(netAnnual),
    },
    provinceVerified: !!(prov && prov.verified),
    provinceLabel: prov ? prov.label : job.province,
    estimateNote: 'Estimate — actual tax is settled on the T1.',
    warnings,
  };
}

// ------------------------------------------------------- charts --
// Pure aggregation for the Earnings charts. Read-only over the
// server-computed calcs — charts never recompute tax. A job is one
// annual figure per tax year; a rental year is one annual figure
// per property per tax year, so every chart's axis is tax years.
// Salary net is the person's income; rental net is the whole
// property's 9946 net (ownerShareNet rides alongside for the
// per-person note). Rentals carry no person field, so only salary
// splits by earner; rental stays a total in the overview.
export function aggregateEarningsCharts(jobs, rentals) {
  const yearsSet = new Set();
  const overview = {}; // year -> { salaryGross, salaryNet, rentalGross, rentalNet, earners: {name: net} }
  const salary = {}; // year -> { gross, net, employers: {name: {gross, net}} }
  const rentalAgg = {}; // year -> { gross, expenses, net, properties: {id: {label, gross, expenses, net, ownerShareNet}} }
  const earners = new Set();
  const employers = new Set();
  const properties = new Map();
  const yearOf = (y) => {
    if (!overview[y]) overview[y] = { salaryGross: 0, salaryNet: 0, rentalGross: 0, rentalNet: 0, earners: {} };
    if (!salary[y]) salary[y] = { gross: 0, net: 0, employers: {} };
    if (!rentalAgg[y]) rentalAgg[y] = { gross: 0, expenses: 0, net: 0, properties: {} };
    yearsSet.add(y);
    return y;
  };
  for (const j of jobs || []) {
    if (!j || !j.calc) continue;
    const y = yearOf(j.tax_year);
    const g = round2(j.calc.annualGross || 0);
    const n = round2(j.calc.netAnnual || 0);
    overview[y].salaryGross = round2(overview[y].salaryGross + g);
    overview[y].salaryNet = round2(overview[y].salaryNet + n);
    salary[y].gross = round2(salary[y].gross + g);
    salary[y].net = round2(salary[y].net + n);
    const earner = j.owner || 'Unassigned';
    earners.add(earner);
    overview[y].earners[earner] = round2((overview[y].earners[earner] || 0) + n);
    const emp = j.employer || 'Unnamed';
    employers.add(emp);
    if (!salary[y].employers[emp]) salary[y].employers[emp] = { gross: 0, net: 0 };
    salary[y].employers[emp].gross = round2(salary[y].employers[emp].gross + g);
    salary[y].employers[emp].net = round2(salary[y].employers[emp].net + n);
  }
  for (const r of rentals || []) {
    properties.set(r.id, r.label || 'Unnamed');
    for (const yr of r.years || []) {
      if (!yr || !yr.calc) continue;
      const y = yearOf(yr.tax_year);
      const g = round2(yr.calc.grossWhole || 0);
      const e = round2(yr.calc.deductibleExpenses || 0);
      const n = round2(yr.calc.netWhole9946 || 0);
      overview[y].rentalGross = round2(overview[y].rentalGross + g);
      overview[y].rentalNet = round2(overview[y].rentalNet + n);
      rentalAgg[y].gross = round2(rentalAgg[y].gross + g);
      rentalAgg[y].expenses = round2(rentalAgg[y].expenses + e);
      rentalAgg[y].net = round2(rentalAgg[y].net + n);
      rentalAgg[y].properties[r.id] = {
        label: r.label || 'Unnamed',
        gross: g, expenses: e, net: n, ownerShareNet: round2(yr.calc.ownerShareNet || 0),
      };
    }
  }
  const years = [...yearsSet].sort((a, b) => a - b);
  return {
    years,
    earners: [...earners].sort(),
    employers: [...employers].sort(),
    properties: [...properties.entries()].map(([id, label]) => ({ id, label })),
    overview, salary, rentals: rentalAgg,
  };
}

// ------------------------------------------------------------ rental --
export function validRentalInput(body) {
  const b = body || {};
  const label = cleanStr(b.label, 160);
  if (!label) return { error: 'label is required.' };
  const rentalType = String(b.rental_type || '');
  if (!RENTAL_TYPES.includes(rentalType)) return { error: 'rental_type must be long_term, short_term or commercial.' };
  const servicesLevel = String(b.services_level || 'basic');
  if (!SERVICE_LEVELS.includes(servicesLevel)) return { error: 'services_level must be basic or hotel_like.' };
  const ownershipPct = Number(b.ownership_pct);
  if (!Number.isFinite(ownershipPct) || ownershipPct <= 0 || ownershipPct > 100) {
    return { error: 'ownership_pct must be between 0 and 100.' };
  }
  const propertyId = b.property_id == null || b.property_id === '' ? null : Number(b.property_id);
  if (propertyId != null && (!Number.isInteger(propertyId) || propertyId <= 0)) {
    return { error: 'property_id must be an existing property id.' };
  }
  // Deliberately no tenant identifiers, mortgage account number, or
  // GST fields here: long-term rent is GST-exempt, and GST fields
  // only exist on the short-term/commercial path (year records).
  return {
    label, rental_type: rentalType, services_level: servicesLevel, ownership_pct: ownershipPct,
    property_id: propertyId, address: cleanStr(b.address, 240),
    is_principal_residence: b.is_principal_residence === true || b.is_principal_residence === 1 || b.is_principal_residence === '1',
    was_principal_residence: b.was_principal_residence === true || b.was_principal_residence === 1 || b.was_principal_residence === '1',
    structural_change: b.structural_change === true || b.structural_change === 1 || b.structural_change === '1',
  };
}

// --------------------------------------------------- rent entries --
// A rent entry is one tenancy's rent schedule: from year-month to
// year-month (blank end = ongoing), a monthly amount, the day of the
// month rent is paid, an optional cash portion of that month's rent,
// and an optional tenant name — a raw string on the entry, never a
// tenant record, lookup, or dropdown.
const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
function parseYm(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = YM_RE.exec(String(v).trim());
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return null;
  return { year, month: Number(m[2]) };
}
const ymKey = (y, m) => y * 12 + (m - 1);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const currentYm = () => {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
};

export function validRentalEntryInput(body) {
  const b = body || {};
  const start = parseYm(b.start_ym);
  if (!start) return { error: 'start month must be a year-month (YYYY-MM).' };
  const end = parseYm(b.end_ym);
  if (b.end_ym !== null && b.end_ym !== undefined && b.end_ym !== '' && !end) {
    return { error: 'end month must be a year-month (YYYY-MM) or blank for ongoing.' };
  }
  if (end && ymKey(end.year, end.month) < ymKey(start.year, start.month)) {
    return { error: 'end month must not be before start month.' };
  }
  const monthlyRent = Number(b.monthly_rent);
  if (!Number.isFinite(monthlyRent) || monthlyRent < 0) return { error: 'monthly_rent must be a number ≥ 0.' };
  const payDay = Number(b.pay_day);
  if (!Number.isInteger(payDay) || payDay < 1 || payDay > 31) return { error: 'pay_day must be a day of the month (1–31).' };
  let cashAmount = null;
  if (b.cash_amount !== null && b.cash_amount !== undefined && b.cash_amount !== '') {
    cashAmount = Number(b.cash_amount);
    if (!Number.isFinite(cashAmount) || cashAmount < 0) return { error: 'cash_amount must be a number ≥ 0.' };
    if (cashAmount > monthlyRent) return { error: 'cash_amount must not exceed monthly_rent.' };
  }
  return {
    start_ym: `${start.year}-${String(start.month).padStart(2, '0')}`,
    end_ym: end ? `${end.year}-${String(end.month).padStart(2, '0')}` : null,
    monthly_rent: monthlyRent, pay_day: payDay, cash_amount: cashAmount,
    tenant_name: cleanStr(b.tenant_name, 160),
  };
}

// Months of taxYear an entry covers, as [year, month] pairs. An
// ongoing entry (no end) runs through the current month.
export function entryCoveredMonths(entry, taxYear, now = currentYm()) {
  const start = parseYm(entry.start_ym);
  if (!start) return [];
  const end = parseYm(entry.end_ym) || now;
  const from = Math.max(ymKey(start.year, start.month), ymKey(taxYear, 1));
  const to = Math.min(ymKey(end.year, end.month), ymKey(taxYear, 12));
  const months = [];
  for (let k = from; k <= to; k++) months.push([Math.floor(k / 12), (k % 12) + 1]);
  return months;
}

// Tax years an entry covers (for auto-creating year records).
export function entryCoveredYears(entry, now = currentYm()) {
  const start = parseYm(entry.start_ym);
  if (!start) return [];
  const end = parseYm(entry.end_ym) || now;
  const years = [];
  for (let y = start.year; y <= end.year; y++) years.push(y);
  return years;
}

// Derive one tax year's rent figures from entries. Gross sums across
// entries; days count the union of covered months. covered is false
// when no entry touches the year (callers then fall back to the year
// record's stored figures, which is what pre-entry records carry).
export function deriveRentalYearFigures(entries, taxYear, now = currentYm()) {
  const coveredMonths = new Set();
  let gross = 0;
  for (const e of entries || []) {
    const months = entryCoveredMonths(e, taxYear, now);
    for (const [y, m] of months) coveredMonths.add(`${y}-${m}`);
    gross = round2(gross + e.monthly_rent * months.length);
  }
  let days = 0;
  for (const key of coveredMonths) {
    const [y, m] = key.split('-').map(Number);
    days += daysInMonth(y, m);
  }
  return { gross_rents: gross, rental_days: days, covered: coveredMonths.size > 0 };
}

export function validRentalYearInput(body, t776Lines) {
  const b = body || {};
  const taxYear = Number(b.tax_year);
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) return { error: 'tax year must be a valid year.' };
  // Gross rents and rented days are DERIVED from rent entries, never
  // typed: the form no longer sends them, and values in an old
  // request body are ignored rather than stored.
  const otherIncome = numOr(b.other_income, 0);
  if (otherIncome < 0) return { error: 'other_income must be ≥ 0.' };
  const areaShare = numOr(b.area_share_pct, 100);
  if (areaShare <= 0 || areaShare > 100) return { error: 'area_share_pct must be between 0 and 100.' };
  const mortgageInterest = numOr(b.mortgage_interest, 0);
  const mortgagePrincipal = numOr(b.mortgage_principal, 0);
  if (mortgageInterest < 0 || mortgagePrincipal < 0) return { error: 'mortgage interest and principal must be ≥ 0.' };
  // Expenses: [{line, amount, direct}] — line must be a T776 line.
  const lineSet = new Set((t776Lines || []).map((l) => l.line));
  const expenses = [];
  if (Array.isArray(b.expenses)) {
    for (const e of b.expenses) {
      if (!e || !lineSet.has(String(e.line))) return { error: `expense line ${e && e.line} is not a T776 line.` };
      const amount = Number(e.amount);
      if (!Number.isFinite(amount) || amount < 0) return { error: 'expense amounts must be ≥ 0.' };
      if (String(e.line) === '8710') return { error: 'line 8710 comes from mortgage interest — enter it as mortgage interest, not as an expense.' };
      expenses.push({ line: String(e.line), amount, direct: e.direct === true || e.direct === 1 || e.direct === '1' });
    }
  }
  const claimCca = b.claim_cca === true || b.claim_cca === 1 || b.claim_cca === '1';
  return {
    tax_year: taxYear, other_income: otherIncome,
    area_share_pct: areaShare,
    mortgage_interest: mortgageInterest, mortgage_principal: mortgagePrincipal,
    expenses, claim_cca: claimCca,
    cca_acknowledged: b.cca_acknowledged === true || b.cca_acknowledged === 1 || b.cca_acknowledged === '1',
    ucc_class1: optNum(b.ucc_class1), ucc_class8: optNum(b.ucc_class8),
    str_compliant_days: b.str_compliant_days == null ? null : Number(b.str_compliant_days),
    str_non_compliant_days: b.str_non_compliant_days == null ? null : Number(b.str_non_compliant_days),
  };
}

export function calcRentalYear(rental, year, rentalRegion) {
  const warnings = [];
  const factor = (year.area_share_pct / 100) * (year.rental_days / 365);
  const byLine = {};
  for (const l of rentalRegion.t776Lines) byLine[l.line] = 0;
  let directTotal = 0;
  let sharedTotal = 0;
  for (const e of year.expenses || []) {
    if (e.direct) directTotal += e.amount;
    else sharedTotal += e.amount;
    byLine[e.line] = round2((byLine[e.line] || 0) + e.amount);
  }
  // Mortgage interest flows to 8710 (it is an expense); principal
  // never flows anywhere in the expense set.
  byLine['8710'] = round2((byLine['8710'] || 0) + year.mortgage_interest);
  const deductibleShared = sharedTotal * factor;
  const personalPortion = round2(sharedTotal * (1 - factor));
  const deductibleExpenses = round2(directTotal + deductibleShared + year.mortgage_interest);
  const grossWhole = round2(year.gross_rents + year.other_income);
  let netBeforeCca = round2(grossWhole - deductibleExpenses);
  // s.67.7: short-term non-compliant days deny expenses pro-rata.
  let deniedExpenses = 0;
  if (rental.rental_type === 'short_term' && year.str_non_compliant_days > 0) {
    const totalDays = (year.str_compliant_days || 0) + year.str_non_compliant_days;
    if (totalDays > 0) {
      deniedExpenses = round2(deductibleExpenses * (year.str_non_compliant_days / totalDays));
      netBeforeCca = round2(netBeforeCca + deniedExpenses);
      warnings.push(`s.67.7: ${year.str_non_compliant_days} non-compliant short-term days deny $${deniedExpenses.toFixed(2)} of expenses.`);
    }
  }
  // CCA: optional, capped at net-before-CCA (never creates or
  // increases a loss), blocked on (former) principal residences
  // unless explicitly acknowledged (the PRE trap).
  let ccaClaim = 0;
  if (year.claim_cca) {
    const isPr = rental.is_principal_residence || rental.was_principal_residence;
    if (isPr && !year.cca_acknowledged) {
      warnings.push('CCA blocked: claiming CCA on a (former) principal residence can end its principal-residence exemption. Acknowledge the trade-off to claim.');
    } else {
      if (isPr && year.cca_acknowledged) {
        warnings.push('CCA acknowledged on a (former) principal residence — the principal-residence exemption for the rented portion is at risk.');
      }
      const maxClaim = rentalRegion.ccaClasses.reduce((sum, c) => {
        const ucc = c.class === 1 ? (year.ucc_class1 || 0) : (year.ucc_class8 || 0);
        return sum + ucc * c.rate;
      }, 0);
      ccaClaim = round2(Math.min(maxClaim, Math.max(0, netBeforeCca)));
    }
  }
  const netWhole = round2(netBeforeCca - ccaClaim);
  const ownerShare = round2(netWhole * (rental.ownership_pct / 100));
  const filing = rental.services_level === 'hotel_like' ? 'T2125' : 'T776';
  if (filing === 'T2125') {
    warnings.push('Hotel-like services (meals, daily cleaning during a stay, concierge) make this business income — report on T2125, not T776.');
  }
  const gst = rental.rental_type === 'long_term'
    ? { status: 'exempt', note: 'Long-term residential rent is GST/HST-exempt — no GST field applies.' }
    : rental.rental_type === 'short_term'
      ? { status: 'taxable', note: 'Short-term rent is a taxable supply — GST/HST registration is mandatory once taxable supplies exceed $30,000 over four quarters.' }
      : { status: 'taxable', note: 'Commercial rent is a taxable supply.' };
  return {
    grossWhole, otherIncome: round2(year.other_income),
    expensesByLine: byLine, totalExpensesEntered: round2(directTotal + sharedTotal),
    personalPortion9949: personalPortion, deductibleExpenses,
    mortgageInterest: round2(year.mortgage_interest), mortgagePrincipal: round2(year.mortgage_principal),
    deniedExpenses, netBeforeCca9369: netBeforeCca, ccaClaim9936: ccaClaim,
    netWhole9946: netWhole, ownerShareNet: ownerShare, ownershipPct: rental.ownership_pct,
    filing, gst, warnings,
  };
}
