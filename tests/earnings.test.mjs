// Earnings: salary gross-to-net (T4127-style estimate) and rental
// T776 summaries. CPP/EI figures are pinned to the CRA 2026 worked
// checks; provincial brackets are the verified 2026 BC/AB/ON tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { payroll, rental } from '../src/regions/ca.js';
import {
  PAY_FREQUENCIES, validJobInput, validRentalInput, validRentalYearInput, validRentalEntryInput,
  calcSalary, calcRentalYear, federalBpa, bracketTax,
  deriveRentalYearFigures, entryCoveredYears,
  payDatesInWindow, deriveJobYtd,
} from '../src/earnings.js';

const job = (over = {}) => ({
  frequency: 'annual', gross_amount: 60000, gross_basis: 'annual',
  tax_year: 2026, province: 'BC', ytd_cpp: 0, ytd_cpp2: 0, ytd_ei: 0,
  cpp_exempt: false, ei_exempt: false, td1_federal: null, td1_provincial: null, ...over,
});

test('salary: $60,000 → CPP $3,361.75 and EI $978.00 (CRA worked check)', () => {
  const c = calcSalary(job(), payroll);
  assert.equal(c.cpp, 3361.75);
  assert.equal(c.ei, 978);
  assert.equal(c.cpp2, 0);
});

test('salary: $90,000 → CPP $4,230.45 + CPP2 $416.00, EI capped $1,123.07', () => {
  const c = calcSalary(job({ gross_amount: 90000 }), payroll);
  assert.equal(c.cpp, 4230.45);
  assert.equal(c.cpp2, 416);
  assert.equal(c.ei, 1123.07);
});

test('salary: frequency annualisation — $3,000 semi-monthly is $72,000, bi-weekly is $78,000', () => {
  assert.equal(calcSalary(job({ frequency: 'semimonthly', gross_amount: 3000, gross_basis: 'period' }), payroll).annualGross, 72000);
  assert.equal(calcSalary(job({ frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period' }), payroll).annualGross, 78000);
  assert.equal(PAY_FREQUENCIES.weekly.periods, 52);
  assert.equal(PAY_FREQUENCIES.biweekly.periods, 26);
  assert.equal(PAY_FREQUENCIES.semimonthly.periods, 24);
  assert.equal(PAY_FREQUENCIES.monthly.periods, 12);
});

test('salary: caps respect YTD already paid; exempt flags zero the deduction', () => {
  const c = calcSalary(job({ gross_amount: 90000, ytd_cpp: 4000, ytd_ei: 1000 }), payroll);
  assert.equal(c.cpp, 230.45);
  assert.equal(c.ei, 123.07);
  const ex = calcSalary(job({ cpp_exempt: true, ei_exempt: true }), payroll);
  assert.equal(ex.cpp, 0);
  assert.equal(ex.cpp2, 0);
  assert.equal(ex.ei, 0);
});

test('salary: federal BPA is full at $100k, phased at $200k, base at $300k', () => {
  assert.equal(federalBpa(100000, payroll.federal), 16452);
  const mid = federalBpa(200000, payroll.federal);
  assert.ok(mid < 16452 && mid > 14829, `phased BPA ${mid}`);
  assert.equal(federalBpa(300000, payroll.federal), 14829);
});

test('salary: bracket tax is marginal, not flat', () => {
  assert.ok(Math.abs(bracketTax(payroll.federal.brackets, 58523) - 58523 * 0.14) < 0.01);
  assert.ok(bracketTax(payroll.federal.brackets, 100000) < 100000 * 0.205);
});

test('salary: unverified province computes federal + CPP/EI only and warns', () => {
  const c = calcSalary(job({ province: 'QC' }), payroll);
  assert.equal(c.provincialTax, null);
  assert.equal(c.provinceVerified, false);
  assert.ok(c.warnings.length >= 1);
  const mb = calcSalary(job({ province: 'MB' }), payroll);
  assert.equal(mb.provincialTax, null);
});

test('salary: verified provinces compute provincial tax (BC/AB/ON)', () => {
  for (const p of ['BC', 'AB', 'ON']) {
    const c = calcSalary(job({ province: p }), payroll);
    assert.equal(c.provinceVerified, true);
    assert.ok(c.provincialTax > 0, `${p} provincial tax ${c.provincialTax}`);
  }
});

test('salary: per-period net divides the annual net', () => {
  const c = calcSalary(job({ frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period' }), payroll);
  assert.ok(Math.abs(c.perPeriod.net * 26 - c.netAnnual) < 1);
});

test('salary validation: rejects bad province, bad frequency, missing employer', () => {
  assert.ok(validJobInput({ employer: 'Acme', province: 'XX', frequency: 'monthly', gross_amount: 1, tax_year: 2026 }).error);
  assert.ok(validJobInput({ employer: 'Acme', province: 'BC', frequency: 'daily', gross_amount: 1, tax_year: 2026 }).error);
  assert.ok(validJobInput({ province: 'BC', frequency: 'monthly', gross_amount: 1, tax_year: 2026 }).error);
  assert.ok(!validJobInput({ employer: 'Acme', province: 'BC', frequency: 'monthly', gross_amount: 5000, gross_basis: 'period', tax_year: 2026 }).error);
});

const rentalBase = (over = {}) => ({
  rental_type: 'long_term', services_level: 'basic', ownership_pct: 100,
  is_principal_residence: false, was_principal_residence: false, structural_change: false, ...over,
});
const yearBase = (over = {}) => ({
  tax_year: 2026, gross_rents: 24000, other_income: 0, area_share_pct: 100, rental_days: 365,
  mortgage_interest: 6000, mortgage_principal: 9000, expenses: [], claim_cca: false,
  cca_acknowledged: false, ucc_class1: null, ucc_class8: null,
  str_compliant_days: null, str_non_compliant_days: null, ...over,
});

test('rental: partial rental pro-rates shared expenses by area × time; direct at 100%', () => {
  const c = calcRentalYear(rentalBase(), yearBase({
    area_share_pct: 50, rental_days: 365,
    expenses: [
      { line: '9180', amount: 12000, direct: false },
      { line: '8521', amount: 500, direct: true },
    ],
  }), rental);
  assert.equal(c.personalPortion9949, 6000);
  assert.equal(c.deductibleExpenses, 6000 + 500 + 6000);
  const half = calcRentalYear(rentalBase(), yearBase({
    area_share_pct: 50, rental_days: 182,
    expenses: [{ line: '9180', amount: 12000, direct: false }],
  }), rental);
  assert.ok(Math.abs(half.personalPortion9949 - 12000 * (1 - 0.5 * 182 / 365)) < 0.01);
});

test('rental: mortgage interest flows to 8710; principal never flows to expenses', () => {
  const c = calcRentalYear(rentalBase(), yearBase(), rental);
  assert.equal(c.expensesByLine['8710'], 6000);
  assert.equal(c.mortgagePrincipal, 9000);
  assert.ok(!Object.values(c.expensesByLine).includes(9000), 'principal must not appear in any expense line');
  assert.equal(c.deductibleExpenses, 6000);
});

test('rental: line 8710 cannot be entered as an expense', () => {
  const v = validRentalYearInput({ tax_year: 2026, gross_rents: 1, expenses: [{ line: '8710', amount: 1 }] }, rental.t776Lines);
  assert.ok(v.error);
});

test('rental: CCA cannot create or increase a loss', () => {
  const c = calcRentalYear(rentalBase(), yearBase({
    gross_rents: 1000, mortgage_interest: 6000, claim_cca: true, ucc_class1: 1000000,
  }), rental);
  assert.equal(c.netBeforeCca9369, -5000);
  assert.equal(c.ccaClaim9936, 0);
  const d = calcRentalYear(rentalBase(), yearBase({
    gross_rents: 24000, mortgage_interest: 6000, claim_cca: true, ucc_class1: 1000000,
  }), rental);
  assert.equal(d.netBeforeCca9369, 18000);
  assert.equal(d.ccaClaim9936, 18000); // capped at net, not at 4% of UCC (40,000)
});

test('rental: CCA on a principal residence is blocked without acknowledgement', () => {
  const blocked = calcRentalYear(rentalBase({ is_principal_residence: true }), yearBase({ claim_cca: true, ucc_class1: 100000 }), rental);
  assert.equal(blocked.ccaClaim9936, 0);
  assert.ok(blocked.warnings.some((w) => w.includes('CCA blocked')));
  const acked = calcRentalYear(rentalBase({ is_principal_residence: true }), yearBase({ claim_cca: true, cca_acknowledged: true, ucc_class1: 100000 }), rental);
  assert.ok(acked.ccaClaim9936 > 0);
  assert.ok(acked.warnings.some((w) => w.includes('principal-residence exemption')));
});

test('rental: long-term rent is GST-exempt; short-term is taxable', () => {
  assert.equal(calcRentalYear(rentalBase(), yearBase(), rental).gst.status, 'exempt');
  assert.equal(calcRentalYear(rentalBase({ rental_type: 'short_term' }), yearBase(), rental).gst.status, 'taxable');
});

test('rental: hotel-like services route to T2125, not T776', () => {
  const c = calcRentalYear(rentalBase({ services_level: 'hotel_like' }), yearBase(), rental);
  assert.equal(c.filing, 'T2125');
  assert.ok(c.warnings.some((w) => w.includes('T2125')));
});

test('rental: co-owner share applies to net only', () => {
  const c = calcRentalYear(rentalBase({ ownership_pct: 50 }), yearBase(), rental);
  assert.equal(c.netWhole9946, 18000);
  assert.equal(c.ownerShareNet, 9000);
  assert.equal(c.grossWhole, 24000); // whole-property gross, not halved
});

test('rental validation: rejects bad ownership and bad rental type', () => {
  assert.ok(validRentalInput({ label: 'X', rental_type: 'long_term', ownership_pct: 150 }).error);
  assert.ok(validRentalInput({ label: 'X', rental_type: 'weekly', ownership_pct: 50 }).error);
  assert.ok(!validRentalInput({ label: 'X', rental_type: 'long_term', ownership_pct: 50 }).error);
});

test('job owner: single earner kept, empty/omitted means unassigned', () => {
  const base = { employer: 'Acme', province: 'BC', frequency: 'annual', gross_amount: 60000, tax_year: 2026 };
  assert.equal(validJobInput({ ...base, owner: 'Shawn' }).owner, 'Shawn');
  assert.equal(validJobInput({ ...base, owner: '' }).owner, null);
  assert.equal(validJobInput({ ...base }).owner, null);
  assert.equal(validJobInput({ ...base, owner: '  Jiaying  ' }).owner, 'Jiaying');
});

// ------------------------------------------------------- chart aggregates --
import { aggregateEarningsCharts } from '../src/earnings.js';

const chartJobs = [
  { tax_year: 2025, employer: 'Acme', owner: 'Shawn', calc: { annualGross: 60000, netAnnual: 50000 } },
  { tax_year: 2026, employer: 'Acme', owner: 'Shawn', calc: { annualGross: 65000, netAnnual: 54000 } },
  { tax_year: 2026, employer: 'Beta', owner: null, calc: { annualGross: 20000, netAnnual: 17000 } },
  { tax_year: 2026, employer: 'Ghost', owner: 'Nobody', calc: null }, // no calc: skipped, never crashes
];
const chartRentals = [
  { id: 1, label: 'Suite', years: [
    { tax_year: 2025, calc: { grossWhole: 12000, deductibleExpenses: 3000, netWhole9946: 9000, ownerShareNet: 9000 } },
    { tax_year: 2026, calc: { grossWhole: 13200, deductibleExpenses: 3200, netWhole9946: 10000, ownerShareNet: 5000 } },
  ] },
  { id: 2, label: 'Empty House', years: [] },
];

test('charts: overview composition sums salary net + rental net by year', () => {
  const c = aggregateEarningsCharts(chartJobs, chartRentals);
  assert.deepEqual(c.years, [2025, 2026]);
  assert.equal(c.overview[2025].salaryNet, 50000);
  assert.equal(c.overview[2025].rentalNet, 9000);
  assert.equal(c.overview[2026].salaryNet, 71000);
  assert.equal(c.overview[2026].rentalNet, 10000);
  assert.equal(c.overview[2026].earners.Shawn, 54000);
  assert.equal(c.overview[2026].earners.Unassigned, 17000);
});

test('charts: salary trend aggregates gross/net and per-employer net by year', () => {
  const c = aggregateEarningsCharts(chartJobs, chartRentals);
  assert.equal(c.salary[2026].gross, 85000);
  assert.equal(c.salary[2026].net, 71000);
  assert.equal(c.salary[2026].employers.Acme.net, 54000);
  assert.equal(c.salary[2026].employers.Beta.net, 17000);
  assert.equal(c.salary[2025].employers.Acme.gross, 60000);
  assert.deepEqual(c.employers, ['Acme', 'Beta']);
});

test('charts: rental aggregates per-property 9946 net and income vs expenses by year', () => {
  const c = aggregateEarningsCharts(chartJobs, chartRentals);
  assert.equal(c.rentals[2025].net, 9000);
  assert.equal(c.rentals[2025].gross, 12000);
  assert.equal(c.rentals[2025].expenses, 3000);
  assert.equal(c.rentals[2026].properties[1].net, 10000);
  assert.equal(c.rentals[2026].properties[1].ownerShareNet, 5000);
  assert.deepEqual(c.properties.map((p) => p.label), ['Suite', 'Empty House']);
});

test('charts: empty input aggregates to empty years, no crash', () => {
  const c = aggregateEarningsCharts([], []);
  assert.deepEqual(c, { years: [], earners: [], employers: [], properties: [], overview: {}, salary: {}, rentals: {} });
});

// -------------------------------------------------------- rent entries --
test('rent entries: a tenancy spanning a year boundary splits gross and days by coverage month', () => {
  const e = { start_ym: '2025-03', end_ym: '2026-02', monthly_rent: 2000 };
  assert.deepEqual(deriveRentalYearFigures([e], 2025), { gross_rents: 20000, rental_days: 306, covered: true });
  assert.deepEqual(deriveRentalYearFigures([e], 2026), { gross_rents: 4000, rental_days: 59, covered: true });
  assert.deepEqual(deriveRentalYearFigures([e], 2024), { gross_rents: 0, rental_days: 0, covered: false });
});

test('rent entries: ongoing entry covers through the current month only', () => {
  const e = { start_ym: '2026-06', end_ym: null, monthly_rent: 1500 };
  assert.deepEqual(deriveRentalYearFigures([e], 2026, { year: 2026, month: 10 }), { gross_rents: 7500, rental_days: 153, covered: true });
  assert.deepEqual(deriveRentalYearFigures([e], 2025, { year: 2026, month: 10 }), { gross_rents: 0, rental_days: 0, covered: false });
  assert.deepEqual(entryCoveredYears(e, { year: 2026, month: 10 }), [2026]);
});

test('rent entries: month granularity counts whole calendar months, leap February included', () => {
  const e = { start_ym: '2024-02', end_ym: '2024-02', monthly_rent: 1000 };
  assert.deepEqual(deriveRentalYearFigures([e], 2024), { gross_rents: 1000, rental_days: 29, covered: true });
});

test('rent entries: overlapping tenancies sum gross but count days only once', () => {
  const es = [
    { start_ym: '2026-01', end_ym: '2026-12', monthly_rent: 1000 },
    { start_ym: '2026-06', end_ym: '2026-12', monthly_rent: 500 },
  ];
  assert.deepEqual(deriveRentalYearFigures(es, 2026), { gross_rents: 15500, rental_days: 365, covered: true });
});

test('rent entries: validation rejects bad months, bad pay day, end before start, cash over rent', () => {
  const base = { start_ym: '2026-01', end_ym: '2026-12', monthly_rent: 2000, pay_day: 1 };
  assert.ok(validRentalEntryInput({ ...base, start_ym: '2026-13' }).error);
  assert.ok(validRentalEntryInput({ ...base, pay_day: 0 }).error);
  assert.ok(validRentalEntryInput({ ...base, pay_day: 32 }).error);
  assert.ok(validRentalEntryInput({ ...base, end_ym: '2025-12' }).error);
  assert.ok(validRentalEntryInput({ ...base, cash_amount: 2001 }).error);
  const ok = validRentalEntryInput({ ...base, cash_amount: 500, tenant_name: 'Jane Doe' });
  assert.ok(!ok.error);
  assert.equal(ok.cash_amount, 500);
  assert.equal(ok.tenant_name, 'Jane Doe');
  assert.equal(ok.end_ym, '2026-12');
  const ongoing = validRentalEntryInput({ start_ym: '2026-01', monthly_rent: 2000, pay_day: 15 });
  assert.ok(!ongoing.error);
  assert.equal(ongoing.end_ym, null);
  assert.equal(ongoing.cash_amount, null);
  assert.equal(ongoing.tenant_name, null);
});

test('rent entries: year input no longer takes gross rents or rented days, but still guards 8710', () => {
  const v = validRentalYearInput({ tax_year: 2026, other_income: 0, area_share_pct: 100 }, rental.t776Lines);
  assert.ok(!v.error);
  assert.equal(v.gross_rents, undefined);
  assert.equal(v.rental_days, undefined);
  assert.ok(validRentalYearInput({ tax_year: 2026, gross_rents: 1, expenses: [{ line: '8710', amount: 1 }] }, rental.t776Lines).error);
});

// ------------------------------------------------- simplified job form --
// The modal asks only for key facts; the rest is derived here.
test('simplified job: pay-date cadences per frequency', () => {
  assert.deepEqual(payDatesInWindow('weekly', '2026-01-05', '2026-01-31', '2026-01-05'),
    ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
  assert.deepEqual(payDatesInWindow('biweekly', '2026-01-05', '2026-01-31', '2026-01-05'),
    ['2026-01-05', '2026-01-19']);
  assert.deepEqual(payDatesInWindow('semimonthly', '2026-01-05', '2026-01-31', '2026-01-05'),
    ['2026-01-15', '2026-01-31']);
  assert.deepEqual(payDatesInWindow('monthly', '2026-01-05', '2026-01-31', '2026-01-05'), ['2026-01-05']);
  assert.deepEqual(payDatesInWindow('annual', '2026-01-05', '2026-01-31', '2026-01-05'), ['2026-01-31']);
  // Monthly anchors clamp to month-end (31st -> Feb 28).
  assert.deepEqual(payDatesInWindow('monthly', '2026-01-31', '2026-04-30', '2026-01-31'),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(payDatesInWindow('biweekly', '2026-02-01', '2026-01-01', '2026-01-05'), []);
});

test('simplified job: YTD from elapsed periods, bi-weekly $3,000 Jan 5 -> Oct 23', () => {
  const ytd = deriveJobYtd({
    frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
    changes: [], recentValue: 3000, payroll, cppExempt: false, eiExempt: false,
  });
  assert.equal(ytd.elapsed_periods, 21);
  assert.equal(ytd.ytd_cpp, 3416.9); // 21/26 of the $4,230.45 full-year CPP
  assert.equal(ytd.ytd_cpp2, 109.85); // 21/26 of $136.00
  assert.equal(ytd.ytd_ei, 907.1); // 21/26 of the $1,123.07 EI cap
});

test('simplified job: mid-year start counts only this year\'s pays', () => {
  const ytd = deriveJobYtd({
    frequency: 'biweekly', startDate: '2026-07-01', recentDate: '2026-10-23',
    changes: [], recentValue: 3000, payroll, cppExempt: false, eiExempt: false,
  });
  assert.equal(ytd.elapsed_periods, 9);
  assert.equal(ytd.ytd_cpp, 1464.39);
  assert.equal(ytd.ytd_ei, 388.76);
});

test('simplified job: a prior-year start still windows YTD at Jan 1', () => {
  const ytd = deriveJobYtd({
    frequency: 'biweekly', startDate: '2024-03-04', recentDate: '2026-10-23',
    changes: [], recentValue: 3000, payroll, cppExempt: false, eiExempt: false,
  });
  assert.equal(ytd.elapsed_periods, 21);
  assert.equal(ytd.ytd_cpp, 3416.9);
});

test('simplified job: a mid-year raise prices each segment, never the new rate over old pays', () => {
  const ytd = deriveJobYtd({
    frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
    changes: [
      { effective_date: '2026-01-05', value: 2500 },
      { effective_date: '2026-06-01', value: 3000 },
    ],
    recentValue: 3000, payroll, cppExempt: false, eiExempt: false,
  });
  assert.equal(ytd.elapsed_periods, 21);
  // 11 pays at $2,500 + 10 at $3,000: CPP 1548.15 + 1627.10, EI 448.25 + 431.95.
  assert.equal(ytd.ytd_cpp, 3175.24);
  assert.equal(ytd.ytd_cpp2, 52.31);
  assert.equal(ytd.ytd_ei, 880.2);
});

test('simplified job: bonus counts into the year\'s gross, never the per-period rate', () => {
  const base = job({ frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period' });
  assert.equal(calcSalary({ ...base, bonus_total: 5000 }, payroll).annualGross, 83000);
  assert.equal(calcSalary({ ...base, bonus_total: 5000 }, payroll).perPeriod.gross, 3000);
  assert.equal(calcSalary(base, payroll).annualGross, 78000);
});

test('simplified job: validJobInput derives, legacy input is untouched', () => {
  const d = validJobInput({
    employer: 'Acme', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
    pay_changes: [{ effective_date: '2026-06-01', value: 3000 }],
    bonuses: [{ date: '2026-06-30', amount: 5000 }],
  });
  assert.equal(d.mode, 'derived');
  assert.equal(d.gross_amount, 3000);
  assert.equal(d.gross_basis, 'period');
  assert.equal(d.tax_year, 2026);
  assert.equal(d.pay_changes.length, 1);
  assert.equal(d.bonuses.length, 1);
  const l = validJobInput({
    employer: 'Acme', province: 'BC', frequency: 'annual',
    gross_amount: 60000, gross_basis: 'annual', tax_year: 2026, ytd_cpp: 100,
  });
  assert.equal(l.mode, 'legacy');
  assert.equal(l.gross_amount, 60000);
  assert.equal(l.ytd_cpp, 100);
  assert.ok(validJobInput({
    employer: 'Acme', province: 'BC', frequency: 'biweekly',
    start_date: '2026-10-23', recent_pay_date: '2026-01-05', recent_pay_value: 3000,
  }).error);
  assert.ok(validJobInput({
    employer: 'Acme', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-05', recent_pay_date: '2026-10-23',
  }).error);
  assert.ok(validJobInput({
    employer: 'Acme', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-05', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
    pay_changes: [{ effective_date: '2025-01-01', value: 2500 }],
  }).error);
});
