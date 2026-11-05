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
  payDatesInWindow, deriveJobYtd, solveGrossForTakeHome, nextPayDate, jobMonthlySeries,
  validPayChanges, resolvePayChangeValues, positionValueFor,
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

test('next pay date: recent-date anchor, holiday moves a day earlier, today counts, dateless is null', () => {
  const npd = (frequency, startDate, recentDate, today) => nextPayDate({ frequency, startDate, recentDate }, today);
  // Bi-weekly Fridays from the recent payment (2026-10-23), NOT the
  // start-date Mondays: the anchor moved 2026-11-01 (user rule).
  assert.equal(npd('biweekly', '2026-01-05', '2026-10-23', '2026-01-05'), '2026-01-16');
  assert.equal(npd('biweekly', '2026-01-05', '2026-10-23', '2026-01-06'), '2026-01-16');
  assert.equal(npd('biweekly', '2026-01-05', '2026-10-23', '2026-01-19'), '2026-01-30');
  // The user's Meta job: start Monday 2022-06-06, recent Friday
  // 2026-10-23 -> next is Fri Nov 6, 2026 (was Mon Nov 2 on the old anchor).
  assert.equal(npd('biweekly', '2022-06-06', '2026-10-23', '2026-11-01'), '2026-11-06');
  // Today counts on the new cadence: the recent date itself, and a Friday payday.
  assert.equal(npd('biweekly', '2022-06-06', '2026-10-23', '2026-10-23'), '2026-10-23');
  assert.equal(npd('biweekly', '2022-06-06', '2026-10-23', '2026-11-06'), '2026-11-06');
  assert.equal(npd('biweekly', '2022-06-06', '2026-10-23', '2026-10-24'), '2026-11-06');
  // Weekly: Fridays from the recent date.
  assert.equal(npd('weekly', '2026-01-05', '2026-10-23', '2026-01-07'), '2026-01-09');
  assert.equal(npd('weekly', '2022-06-06', '2026-10-23', '2026-10-24'), '2026-10-30');
  // Monthly: day-of-month now from the RECENT date, not the start date.
  assert.equal(npd('monthly', '2026-01-15', '2026-10-15', '2026-01-15'), '2026-01-15');
  assert.equal(npd('monthly', '2026-01-15', '2026-10-15', '2026-01-16'), '2026-02-15');
  assert.equal(npd('monthly', '2026-01-31', '2026-10-31', '2026-02-01'), '2026-02-28');
  assert.equal(npd('monthly', '2026-01-15', '2026-10-20', '2026-01-16'), '2026-01-20');
  // Semi-monthly: 15th and month-end, anchor-independent.
  assert.equal(npd('semimonthly', '2026-01-05', '2026-10-23', '2026-01-15'), '2026-01-15');
  assert.equal(npd('semimonthly', '2026-01-05', '2026-10-23', '2026-01-16'), '2026-01-31');
  // Annual: the recent date's anniversary.
  assert.equal(npd('annual', '2026-01-05', '2026-03-10', '2026-03-10'), '2026-03-10');
  assert.equal(npd('annual', '2026-01-05', '2026-03-10', '2026-10-29'), '2027-03-10');
  // Holiday rule: a payday landing on a holiday moves a day earlier.
  // Note the cadence matters: the Oct 23 biweekly Fridays never land
  // on Dec 25 (..., Dec 18, Jan 1), so the Christmas pin uses a
  // weekly cadence (every Friday) and a biweekly run landing Dec 25.
  assert.equal(npd('weekly', '2022-06-06', '2026-10-23', '2026-12-24'), '2026-12-24');
  assert.equal(npd('biweekly', '2022-06-06', '2026-12-11', '2026-12-24'), '2026-12-24');
  // ... and when today IS the holiday payday, it already paid yesterday.
  assert.equal(npd('weekly', '2022-06-06', '2026-10-23', '2026-12-25'), '2026-12-31');
  assert.equal(npd('biweekly', '2022-06-06', '2026-12-11', '2026-12-25'), '2027-01-08');
  // Holiday chain: the Oct 23 biweekly run's next nominal after
  // Dec 24 is Jan 1 (New Year's Day) -> Dec 31, 2026.
  assert.equal(npd('biweekly', '2022-06-06', '2026-10-23', '2026-12-24'), '2026-12-31');
  // Consecutive holidays loop: a Dec 26 payday moves to Dec 24, never Dec 25.
  assert.equal(npd('monthly', '2026-01-26', '2026-11-26', '2026-12-20'), '2026-12-24');
  // Fixed-weekday grid never drifts: a recent payment that was itself
  // moved early (Thu Dec 24, because Fri Dec 25 is a holiday) still
  // anchors the Friday grid — next is Fri Jan 8, not Thu Jan 7.
  assert.equal(npd('biweekly', '2022-06-06', '2026-12-24', '2026-12-26'), '2027-01-08');
  assert.equal(npd('biweekly', '2022-06-06', '2026-12-24', '2026-12-24'), '2026-12-24');
  assert.equal(npd('weekly', '2022-06-06', '2026-12-24', '2027-01-02'), '2027-01-08');
  // Same no-drift rule for monthly and annual: the day (monthly) or
  // month-day (annual) comes from the NOMINAL recent date, not the
  // entered moved-early one.
  assert.equal(npd('monthly', '2026-01-25', '2026-12-24', '2027-01-05'), '2027-01-25');
  assert.equal(npd('monthly', '2025-01-01', '2025-12-31', '2026-01-05'), '2026-02-01');
  assert.equal(npd('monthly', '2026-01-25', '2026-12-24', '2026-12-24'), '2026-12-24');
  assert.equal(npd('annual', '2020-04-03', '2026-04-02', '2026-06-01'), '2027-04-03');
  // A future start date is its own first pay date.
  assert.equal(npd('biweekly', '2026-06-01', '2026-06-01', '2026-01-06'), '2026-06-01');
  // Dateless legacy jobs and bad inputs: no guessed date.
  assert.equal(npd('biweekly', null, null, '2026-01-06'), null);
  assert.equal(npd('biweekly', '2026-01-05', null, '2026-01-06'), null);
  assert.equal(npd('biweekly', null, '2026-10-23', '2026-01-06'), null);
  assert.equal(npd('fortnightly', '2026-01-05', '2026-10-23', '2026-01-06'), null);
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

// Take-home input: back-solving the per-period gross from a net.
const takeHomeNetAt = (gross, over = {}) => {
  const { frequency = 'biweekly', province = 'BC', startDate = '2026-01-05', recentDate = '2026-10-23',
    changes = [], bonuses = [], cppExempt = false, eiExempt = false,
    td1Federal = null, td1Provincial = null } = over;
  const ytd = deriveJobYtd({
    frequency, startDate, recentDate, changes, recentValue: gross, payroll, cppExempt, eiExempt,
  });
  return calcSalary({
    frequency, gross_amount: gross, gross_basis: 'period', province,
    bonus_total: bonuses.reduce((a, b) => a + b.amount, 0),
    ytd_cpp: ytd.ytd_cpp, ytd_cpp2: ytd.ytd_cpp2, ytd_ei: ytd.ytd_ei,
    td1_federal: td1Federal, td1_provincial: td1Provincial, cpp_exempt: cppExempt, ei_exempt: eiExempt,
  }, payroll).perPeriod.net;
};
const solveTakeHome = (targetNet, over = {}) => solveGrossForTakeHome({
  targetNet, frequency: 'biweekly', province: 'BC', startDate: '2026-01-05', recentDate: '2026-10-23',
  changes: [], bonuses: [], payroll, td1Federal: null, td1Provincial: null, cppExempt: false, eiExempt: false,
  ...over,
});

test('take-home: BC biweekly $3,000 gross round-trips exactly, and the solve is minimal', () => {
  const target = takeHomeNetAt(3000);
  assert.equal(target, 2469.7);
  const s = solveTakeHome(target);
  assert.equal(s.gross, 3000);
  assert.equal(takeHomeNetAt(s.gross), target);
  assert.ok(takeHomeNetAt(2999.99) < target, 'one cent less gross must net below the target');
});

test('take-home: pay changes + bonus round-trip to the cent (within rounding granularity of the true gross)', () => {
  const over = {
    changes: [{ effective_date: '2026-01-05', value: 2500 }, { effective_date: '2026-06-01', value: 3000 }],
    bonuses: [{ date: '2026-06-30', amount: 5000 }],
  };
  const target = takeHomeNetAt(3000, over);
  const s = solveTakeHome(target, over);
  assert.equal(takeHomeNetAt(s.gross, over), target);
  assert.ok(Math.abs(s.gross - 3000) <= 0.1, `solved ${s.gross} should be within 10 cents of 3000`);
});

test('take-home: annual frequency and CPP/EI-exempt jobs round-trip', () => {
  const annual = { frequency: 'annual', startDate: '2026-01-01', recentDate: '2026-10-23' };
  assert.equal(solveTakeHome(takeHomeNetAt(60000, annual), annual).gross, 60000);
  const ex = { cppExempt: true, eiExempt: true };
  const s = solveTakeHome(takeHomeNetAt(3000, ex), ex);
  assert.equal(takeHomeNetAt(s.gross, ex), takeHomeNetAt(3000, ex));
});

test('take-home: unreachable targets are errors, never silent fallbacks', () => {
  const bonus = { bonuses: [{ date: '2026-06-30', amount: 50000 }] };
  assert.ok(solveTakeHome(0.01, bonus).error);
  assert.ok(solveTakeHome(0, bonus).error);
  assert.ok(solveTakeHome(-5).error);
  assert.ok(solveTakeHome(100, { frequency: 'bogus' }).error);
  assert.equal(solveTakeHome(0).gross, 0);
});

// ------------------------------------------------------- position model --
test('pay changes: amount + basis + scope normalise, legacy value-only means gross/period', () => {
  const rows = validPayChanges([
    { effective_date: '2026-06-01', value: 3000 },
    { effective_date: '2026-01-05', amount: 104000, basis: 'gross', scope: 'annual' },
    { effective_date: '2026-03-01', amount: 2500, basis: 'takehome', scope: 'period' },
  ], '2026-01-01');
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].amount, rows[0].basis, rows[0].scope], [104000, 'gross', 'annual']);
  assert.deepEqual([rows[1].amount, rows[1].basis, rows[1].scope], [2500, 'takehome', 'period']);
  assert.deepEqual([rows[2].amount, rows[2].basis, rows[2].scope], [3000, 'gross', 'period']);
  assert.equal(rows[2].value, null);
  assert.ok(validPayChanges([{ effective_date: '2026-06-01', amount: 100, basis: 'net' }]).error);
  assert.ok(validPayChanges([{ effective_date: '2026-06-01', amount: 100, scope: 'monthly' }]).error);
  assert.ok(validPayChanges([{ effective_date: '2026-06-01', amount: -5 }]).error);
});

test('pay changes: gross annual annualises, take-home back-solves, position is the latest entry', () => {
  const entries = validPayChanges([
    { effective_date: '2026-01-05', amount: 104000, basis: 'gross', scope: 'annual' },
    { effective_date: '2026-06-01', amount: takeHomeNetAt(3000), basis: 'takehome', scope: 'period' },
  ], '2026-01-01');
  const err = resolvePayChangeValues({
    entries, frequency: 'biweekly', province: 'BC', startDate: '2026-01-05', recentDate: '2026-10-23',
    bonuses: [], payroll, td1Federal: null, td1Provincial: null, cppExempt: false, eiExempt: false,
  });
  assert.equal(err, null);
  assert.equal(entries[0].value, 4000);
  // The take-home entry nets to its target under the annual entry's segment.
  assert.equal(
    takeHomeNetAt(entries[1].value, { changes: [{ effective_date: '2026-01-05', value: 4000 }] }),
    takeHomeNetAt(3000));
  assert.equal(positionValueFor(entries, 9999), entries[1].value);
  assert.equal(positionValueFor([], 9999), 9999);
});

test('pay changes: unreachable take-home is an error; equal dates keep submission order', () => {
  const entries = validPayChanges([
    { effective_date: '2026-06-01', amount: 1, basis: 'takehome', scope: 'period' },
  ], '2026-01-01');
  const err = resolvePayChangeValues({
    entries, frequency: 'biweekly', province: 'BC', startDate: '2026-01-05', recentDate: '2026-10-23',
    bonuses: [{ date: '2026-06-30', amount: 50000 }], payroll,
    td1Federal: null, td1Provincial: null, cppExempt: false, eiExempt: false,
  });
  assert.ok(err);
  const ties = validPayChanges([
    { effective_date: '2026-06-01', amount: 3000 },
    { effective_date: '2026-06-01', amount: 3200 },
  ], '2026-01-01');
  resolvePayChangeValues({
    entries: ties, frequency: 'biweekly', province: 'BC', startDate: '2026-01-05', recentDate: '2026-10-23',
    bonuses: [], payroll, td1Federal: null, td1Provincial: null, cppExempt: false, eiExempt: false,
  });
  assert.equal(positionValueFor(ties, 0), 3200);
});

// ------------------------------------------------------- job monthly chart --
const monthlyCalc = { perPeriod: { gross: 3000, net: 2000, totalTax: 800, cpp: 100, cpp2: 50, ei: 50 } };
const monthlyBase = {
  frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
  calc: monthlyCalc, plans: [], today: '2026-10-31',
};

test('monthly chart: months run start month through current month, stack sums to gross to the cent', () => {
  const s = jobMonthlySeries(monthlyBase);
  assert.deepEqual(s.months, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(s.rrsp, null);
  // Biweekly from Mon 2026-01-05: Jan has 2 paydays, Mar has 3.
  assert.equal(s.gross[0], 6000);
  assert.equal(s.gross[2], 9000);
  assert.equal(s.tax[2], 2400);
  assert.equal(s.cppEi[2], 600);
  assert.equal(s.net[2], 6000);
  for (let i = 0; i < s.months.length; i++) {
    assert.equal(Math.round((s.tax[i] + s.cppEi[i] + s.net[i]) * 100) / 100, s.gross[i], `month ${s.months[i]} stack must equal gross`);
  }
});

test('monthly chart: RRSP segment is own only — employer match never enters the stack', () => {
  const s = jobMonthlySeries({
    ...monthlyBase,
    plans: [{ start_date: '2026-01-05', own_amount: 100, employer_amount: 50 }],
  });
  assert.ok(Array.isArray(s.rrsp));
  // Mar 2026 has 3 plan paydays: own 100 × 3 = 300, not (100 + 50) × 3.
  assert.equal(s.rrsp[2], 300);
  assert.equal(s.net[2], 6000 - 300);
  for (let i = 0; i < s.months.length; i++) {
    assert.equal(Math.round((s.tax[i] + s.cppEi[i] + s.rrsp[i] + s.net[i]) * 100) / 100, s.gross[i]);
  }
});

test('monthly chart: RRSP starts at the plan start month, absent with no own-positive plan', () => {
  const s = jobMonthlySeries({
    ...monthlyBase,
    plans: [{ start_date: '2026-03-02', own_amount: 100, employer_amount: 0 }],
  });
  assert.equal(s.rrsp[0], 0);
  assert.equal(s.rrsp[1], 0);
  assert.ok(s.rrsp[2] > 0);
  const employerOnly = jobMonthlySeries({
    ...monthlyBase,
    plans: [{ start_date: '2026-01-05', own_amount: 0, employer_amount: 50 }],
  });
  assert.equal(employerOnly.rrsp, null);
});

test('monthly chart: annual jobs bar only on the anniversary month, other months show no bar', () => {
  const s = jobMonthlySeries({
    ...monthlyBase, frequency: 'annual', startDate: '2026-01-05', recentDate: '2026-10-23',
    calc: { perPeriod: { gross: 60000, net: 40000, totalTax: 16000, cpp: 2000, cpp2: 500, ei: 1500 } },
  });
  assert.equal(s.months.length, 10);
  for (let i = 0; i < 9; i++) assert.equal(s.gross[i], 0, `month ${s.months[i]} must have no bar`);
  assert.equal(s.gross[9], 60000);
  assert.equal(s.tax[9] + s.cppEi[9] + s.net[9], 60000);
});

test('monthly chart: dateless jobs get null, never a guessed date', () => {
  assert.equal(jobMonthlySeries({ ...monthlyBase, startDate: null }), null);
  assert.equal(jobMonthlySeries({ ...monthlyBase, recentDate: null }), null);
  assert.equal(jobMonthlySeries({ ...monthlyBase, calc: null }), null);
});

// ------------------------------------------------- pre-tax RRSP --
const c2 = (n) => Math.round(n * 100) / 100;
const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const nIn = (ym) => payDatesInWindow('biweekly', `${ym}-01`, monthEnd(ym), '2026-01-05').length;
const pretaxJob = (over = {}) => ({
  frequency: 'biweekly', gross_amount: 3000, gross_basis: 'period',
  tax_year: 2026, province: 'BC', ytd_cpp: 0, ytd_cpp2: 0, ytd_ei: 0,
  cpp_exempt: false, ei_exempt: false, td1_federal: null, td1_provincial: null, bonus_total: 0, ...over,
});

test('salary: pre-tax RRSP reduces taxable income and both taxes, CPP/EI unchanged, net up by exactly the tax saved', () => {
  const oldC = calcSalary(pretaxJob(), payroll);
  const newC = calcSalary(pretaxJob({ rrspDeduction: 220.05 }), payroll);
  assert.equal(newC.rrspAnnual, 5721.30);
  assert.equal(newC.taxableIncome, 71431.70);
  assert.equal(c2(oldC.taxableIncome - newC.taxableIncome), 5721.30);
  assert.equal(newC.federalTax, 7676.13);
  assert.equal(newC.provincialTax, 3442.54);
  assert.equal(newC.totalTax, 11118.67);
  assert.equal(newC.cpp, oldC.cpp);
  assert.equal(newC.cpp2, oldC.cpp2);
  assert.equal(newC.ei, oldC.ei);
  assert.equal(newC.annualGross, oldC.annualGross);
  assert.equal(c2(newC.netAnnual - oldC.netAnnual), c2(oldC.totalTax - newC.totalTax));
  assert.equal(c2(newC.netAnnual - oldC.netAnnual), 1613.41);
  assert.equal(newC.perPeriod.net, 2361.22);
  // Cash definition: displayed take-home is the economic net minus
  // the own deduction; with no deduction cash equals economic.
  assert.equal(newC.perPeriod.cashNet, 2141.17);
  assert.equal(oldC.perPeriod.cashNet, oldC.perPeriod.net);
  assert.equal(oldC.cashNetAnnual, oldC.netAnnual);
});

test('salary: zero RRSP deduction is identical to no deduction, and the deduction floor holds at zero taxable', () => {
  const a = calcSalary(pretaxJob(), payroll);
  const b = calcSalary(pretaxJob({ rrspDeduction: 0 }), payroll);
  assert.deepEqual(b, a);
  const floored = calcSalary(pretaxJob({ rrspDeduction: 100000 }), payroll);
  assert.equal(floored.taxableIncome, 0);
  assert.equal(floored.totalTax, 0);
  assert.equal(floored.cpp, a.cpp);
  assert.equal(floored.ei, a.ei);
});

test('salary: take-home solve with a pre-tax deduction reproduces the CASH target net under the pre-tax calc', () => {
  const target = 2141.17; // economic net 2361.22 minus the own 220.05 deduction: the displayed take-home is cash
  const solved = solveGrossForTakeHome({
    targetNet: target, frequency: 'biweekly', province: 'BC',
    startDate: '2026-01-05', recentDate: '2026-10-23', changes: [], bonuses: [], payroll,
    td1Federal: null, td1Provincial: null, cppExempt: false, eiExempt: false, rrspDeduction: 220.05,
  });
  assert.ok(!solved.error, JSON.stringify(solved));
  // The solve prices the net with the job's YTD offsets (start +
  // recent dates), so the verification must derive the same YTD —
  // ytd 0 would price a different, lower net.
  const ytd = deriveJobYtd({
    frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
    changes: [], recentValue: solved.gross, payroll, cppExempt: false, eiExempt: false,
  });
  assert.equal(calcSalary(pretaxJob({
    gross_amount: solved.gross, ytd_cpp: ytd.ytd_cpp, ytd_cpp2: ytd.ytd_cpp2, ytd_ei: ytd.ytd_ei,
    rrspDeduction: 220.05,
  }), payroll).perPeriod.cashNet, target);
});

test('monthly chart: pre-tax RRSP leaves pre-plan months at full-gross tax, cuts post-plan months', () => {
  const full = calcSalary(pretaxJob(), payroll).perPeriod;
  const reduced = calcSalary(pretaxJob({ rrspDeduction: 220.05 }), payroll).perPeriod;
  const s = jobMonthlySeries({
    frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
    calc: calcSalary(pretaxJob({ rrspDeduction: 220.05 }), payroll),
    plans: [{ start_date: '2026-07-06', own_amount: 220.05 }],
    today: '2026-10-31', job: pretaxJob(), payroll,
  });
  for (let i = 0; i < 6; i++) {
    const ym = s.months[i];
    assert.equal(s.tax[i], c2(full.totalTax * nIn(ym)), `${ym} must keep full-gross tax`);
    assert.equal(s.rrsp[i], 0, `${ym} must have no RRSP before the plan starts`);
    assert.equal(s.net[i], c2(full.net * nIn(ym)), `${ym} net must be full net`);
  }
  for (let i = 6; i < 10; i++) {
    const ym = s.months[i];
    assert.equal(s.tax[i], c2(reduced.totalTax * nIn(ym)), `${ym} must use reduced tax`);
    assert.ok(s.rrsp[i] > 0, `${ym} must have an RRSP segment`);
    assert.equal(s.net[i], c2(reduced.net * nIn(ym)) - s.rrsp[i], `${ym} net must be reduced net minus RRSP`);
  }
  for (let i = 0; i < s.months.length; i++) {
    assert.equal(Math.round((s.tax[i] + s.cppEi[i] + s.rrsp[i] + s.net[i]) * 100) / 100, s.gross[i]);
  }
});

test('monthly chart: mid-month plan start deducts only from paydays on/after the start', () => {
  const full = calcSalary(pretaxJob(), payroll).perPeriod;
  const reduced = calcSalary(pretaxJob({ rrspDeduction: 220.05 }), payroll).perPeriod;
  const s = jobMonthlySeries({
    frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
    calc: calcSalary(pretaxJob({ rrspDeduction: 220.05 }), payroll),
    plans: [{ start_date: '2026-03-10', own_amount: 220.05 }],
    today: '2026-10-31', job: pretaxJob(), payroll,
  });
  // March 2026 job paydays: Mar 2 (before the plan), Mar 16 + 30 (after it).
  assert.equal(s.tax[2], c2(full.totalTax + 2 * reduced.totalTax));
  // Plan-anchored dues in March: Mar 10 + 24.
  assert.equal(s.rrsp[2], 440.10);
  assert.equal(s.tax[0], c2(full.totalTax * 2));
  assert.equal(s.rrsp[0], 0);
});

test('monthly chart: employer-only plan changes nothing', () => {
  const full = calcSalary(pretaxJob(), payroll).perPeriod;
  const s = jobMonthlySeries({
    frequency: 'biweekly', startDate: '2026-01-05', recentDate: '2026-10-23',
    calc: calcSalary(pretaxJob(), payroll),
    plans: [{ start_date: '2026-01-05', own_amount: 0, employer_amount: 50 }],
    today: '2026-10-31', job: pretaxJob(), payroll,
  });
  assert.equal(s.rrsp, null);
  for (let i = 0; i < s.months.length; i++) {
    assert.equal(s.tax[i], c2(full.totalTax * payDatesInWindow('biweekly', `${s.months[i]}-01`, monthEnd(s.months[i]), '2026-01-05').length));
  }
});

test('monthly chart: monthly plan paints no RRSP and no tax cut before its start month', () => {
  const full = calcSalary(pretaxJob({ frequency: 'monthly' }), payroll).perPeriod;
  const s = jobMonthlySeries({
    frequency: 'monthly', startDate: '2026-01-15', recentDate: '2026-10-15',
    calc: calcSalary(pretaxJob({ frequency: 'monthly', rrspDeduction: 220.05 }), payroll),
    plans: [{ start_date: '2026-11-06', own_amount: 220.05 }],
    today: '2026-11-20', job: pretaxJob({ frequency: 'monthly' }), payroll,
  });
  for (let i = 0; i < 10; i++) {
    assert.equal(s.rrsp[i], 0, `${s.months[i]} must have no RRSP before the plan starts`);
    assert.equal(s.tax[i], c2(full.totalTax), `${s.months[i]} must keep full-gross tax`);
  }
  assert.equal(s.rrsp[10], 220.05);
  // The gate applies to the legacy stored-calc path too.
  const legacy = jobMonthlySeries({
    frequency: 'monthly', startDate: '2026-01-15', recentDate: '2026-10-15',
    calc: calcSalary(pretaxJob({ frequency: 'monthly', rrspDeduction: 220.05 }), payroll),
    plans: [{ start_date: '2026-11-06', own_amount: 220.05 }],
    today: '2026-11-20',
  });
  for (let i = 0; i < 10; i++) assert.equal(legacy.rrsp[i], 0);
});
