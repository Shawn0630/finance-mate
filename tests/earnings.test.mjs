// Earnings: salary gross-to-net (T4127-style estimate) and rental
// T776 summaries. CPP/EI figures are pinned to the CRA 2026 worked
// checks; provincial brackets are the verified 2026 BC/AB/ON tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { payroll, rental } from '../src/regions/ca.js';
import {
  PAY_FREQUENCIES, validJobInput, validRentalInput, validRentalYearInput,
  calcSalary, calcRentalYear, federalBpa, bracketTax,
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
