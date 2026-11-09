// T1 computation — the ONE compute surface behind the Tax refund
// headline + popup. It lives in the region layer (CA federal + the
// province module) so another province — or a US implementation —
// plugs in without touching the UI or the filing storage.
//
// Scope (user 2026-11-08 16:20): headline + popup ONLY. The full
// filing flow is still out of scope. Research, sources and the
// verified-vs-assumed list live in
// ~/workspace/fm-verify/tax-home-switcher-/research-canada-tax.md;
// the headline figure must reproduce the user's 2025 return
// (refund $16,615.42) from equivalent 2025 items — pinned by unit
// test.
//
// Inputs:
//   { taxYear, province, items, slips, jobs }
//   items: filing items (taxItemView shape) — kind, amount,
//     share_pct, status, detail (parsed), slipKind (the kind of the
//     slip the item is backed by, when any).
//   slips: the filing's slips — { kind, fields } (fields parsed).
//   jobs: the filer's earn_jobs rows for the tax year (for CPP/EI
//     via calcSalary; the same rows the RRSP benefit endpoint uses).
//
// Output:
//   { taxYear, province, refund, isRefund, label, displayAmount,
//     lines: [{ line, label, amount, sub? }], notes: [string] }
//   refund is SIGNED: positive = refund, negative = balance owing.
//   lines carry T1 line numbers (line null = an unlabeled sub-line,
//   e.g. the gross tax before credits). Income/deduction/credit
//   lines with a zero amount are omitted; the structural totals
//   (15000, 23600, 26000, 33500, 33800, 35000, 40600, 42000, 43500,
//   43700, 48200, 48400) are always present.
//   A province with no module (or a year with no verified table)
//   returns { unsupportedProvince: true } / { unsupportedYear: true }
//   instead of a number — never a guessed figure.

import { calcSalary } from '../../earnings.js';
import { effectiveAmount } from '../../tax.js';
import { federalTable, bracketTax, basicPersonalAmount, cppSplit, eiPremium } from './federal.js';
import { bcTable, bcBracketTax, bcCreditAmounts } from './bc.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Province modules. BC is the only one in v1; ON/AB brackets are
// verified in the Earnings payroll module (2026) but have no T1
// province module yet, and Quebec runs QPP/QPIP + a separate
// return, so it needs its own variant, not a table row.
const PROVINCES = {
  BC: { label: 'British Columbia', table: bcTable, bracketTax: bcBracketTax, creditAmounts: bcCreditAmounts },
};

// Tax-deducted boxes per slip kind (region slipKinds field keys).
// Tax deducted is a CREDIT (line 43700), never income.
const TAX_DEDUCTED_BOXES = {
  T4: ['box22'], T4A: ['box022'], T5: ['box25'], T3: ['box30'],
  T4RSP: ['box22'], T4RIF: ['box22'],
};

function countedItems(items) {
  return (items || []).filter((it) => {
    if (!it || it.status === 'excluded') return false;
    if (it.detail && it.detail.derived) return false; // already netted in its source item
    return true;
  });
}

export function computeT1({ taxYear, province, items, slips, jobs }) {
  const year = Number(taxYear);
  const fed = federalTable(year);
  if (!fed) return { taxYear: year, province, unsupportedYear: true, notes: [`No verified federal table for tax year ${year}.`] };
  const prov = PROVINCES[province];
  if (!prov) return { taxYear: year, province, unsupportedProvince: true, notes: [`No T1 province module for ${province} yet — BC only in v1.`] };
  const provTable = prov.table(year);
  if (!provTable) return { taxYear: year, province, unsupportedYear: true, notes: [`No verified ${province} table for tax year ${year}.`] };

  const notes = [];
  const lines = [];
  const add = (line, label, amount, sub = false) => {
    lines.push({ line, label, amount: round2(amount), sub });
  };
  // A structural total is always shown; an input line only when nonzero.
  const addIf = (line, label, amount) => { if (round2(amount) !== 0) add(line, label, amount); };

  // ---------------------------------------------------------- income --
  // Amounts are the item's effective amount (amount × share %).
  // RESP contributes $0 (not deductible — but it is not income
  // either, so it simply never appears here); capital_gain items
  // carry sale PROCEEDS, not the gain, so they cannot enter line
  // 12700 — listed in the notes instead (see below).
  const sums = {};
  for (const it of countedItems(items)) {
    const eff = effectiveAmount(it);
    sums[it.kind] = round2((sums[it.kind] || 0) + eff);
  }
  const employment = sums.employment || 0;
  const pension = (items || []).filter((it) => it && it.kind === 'other_income' && it.slipKind === 'T4A' && it.status !== 'excluded' && !(it.detail && it.detail.derived))
    .reduce((a, it) => round2(a + effectiveAmount(it)), 0);
  const rrspIncome = round2((sums.other_income || 0) - pension);
  addIf('10100', 'Employment income', employment);
  addIf('11500', 'Pension income', pension);
  addIf('12100', 'Interest and other investment income', sums.investment_income || 0);
  addIf('12600', 'Net rental income', sums.rental || 0);
  addIf('12900', 'RRSP income', rrspIncome);
  const totalIncome = round2(employment + pension + (sums.investment_income || 0) + (sums.rental || 0) + rrspIncome);
  add('15000', 'Total income', totalIncome);

  // ------------------------------------------------------- deductions --
  const rpp = sums.rpp || 0;
  const rrspPrpp = round2((sums.rrsp || 0) + (sums.prpp || 0));
  addIf('20700', 'Registered pension plan (RPP) deduction', rpp);
  addIf('20800', 'RRSP/PRPP deduction', rrspPrpp);

  // --------------------------------------------------------- CPP / EI --
  // Primary source: the filer's jobs for the tax year, through the
  // established calcSalary split (base = credit, enhancement =
  // deduction). Fallback: the T4 slips' boxes (box 26 pensionable
  // earnings → the same split; box 18 EI). Neither → 0 + a note.
  let cppBase = 0;
  let cppEnhancement = 0;
  let ei = 0;
  const jobRows = (jobs || []).filter(Boolean);
  if (jobRows.length) {
    const payroll = {
      federal: fed,
      cpp: fed.cpp,
      ei: fed.ei,
      provinces: { BC: { ...provTable, verified: true, label: 'British Columbia' } },
    };
    for (const job of jobRows) {
      const calc = calcSalary({ ...job, bonus_total: job.bonus_total || 0, rrspDeduction: 0 }, payroll);
      cppBase = round2(cppBase + (calc.cppBase || 0));
      cppEnhancement = round2(cppEnhancement + (calc.cppEnhancement || 0));
      ei = round2(ei + (calc.ei || 0));
    }
  } else {
    const t4s = (slips || []).filter((s) => s && s.kind === 'T4');
    if (t4s.length) {
      for (const s of t4s) {
        const f = s.fields || {};
        if (isFinite(Number(f.box26))) {
          const split = cppSplit(f.box26, fed.cpp);
          cppBase = round2(cppBase + split.base);
          cppEnhancement = round2(cppEnhancement + split.enhancement);
        }
        if (isFinite(Number(f.box18))) ei = round2(ei + Number(f.box18));
      }
      if (!t4s.some((s) => isFinite(Number((s.fields || {}).box26)))) {
        notes.push('CPP split not computed — the T4 slips carry no Box 26 pensionable earnings.');
      }
    } else {
      notes.push('No job or T4 on file for this year — CPP/EI and the Canada employment amount are not included.');
    }
  }
  addIf('22215', 'CPP/QPP enhancement deduction', cppEnhancement);
  const netIncome = round2(Math.max(0, totalIncome - rpp - rrspPrpp - cppEnhancement));
  add('23600', 'Net income', netIncome);
  const taxableIncome = netIncome; // no other deductions in v1
  add('26000', 'Taxable income', taxableIncome);

  // ------------------------------------------- federal credits (30000) --
  const bpa = basicPersonalAmount(netIncome, fed);
  const canadaEmployment = round2(Math.min(Math.max(0, employment), fed.employmentAmountMax));
  const disability = sums.disability || 0;
  const creditAmounts = round2(bpa + cppBase + ei + canadaEmployment + disability);
  addIf('30000', 'Basic personal amount', bpa);
  addIf('30800', 'CPP/QPP contributions through employment', cppBase);
  addIf('31200', 'EI premiums through employment', ei);
  addIf('31260', 'Canada employment amount', canadaEmployment);
  addIf('31600', 'Disability amount', disability);
  add('33500', 'Total non-refundable credit amounts', creditAmounts);
  const creditRate = fed.lowestRate;
  const creditValue = round2(creditAmounts * creditRate);
  add('33800', `Total at the ${Math.round(creditRate * 1000) / 10}% credit rate`, creditValue);
  add('35000', 'Total federal non-refundable tax credits', creditValue);

  // ----------------------------------------------------- federal tax --
  const federalGross = bracketTax(taxableIncome, fed.brackets);
  add(null, 'Federal tax on taxable income', federalGross, true);
  const federalTax = round2(Math.max(0, federalGross - creditValue));
  add('40600', 'Federal tax', federalTax);
  add('42000', 'Net federal tax', federalTax); // no other federal credits in v1

  // ---------------------------------------------------- provincial tax --
  const provGross = prov.bracketTax(taxableIncome, provTable);
  const provCredits = prov.creditAmounts({ cppBase, ei, disability }, provTable);
  add(null, `${prov.label} tax on taxable income`, provGross, true);
  add(null, `${prov.label} non-refundable credits`, -provCredits.value, true);
  const provTax = round2(Math.max(0, provGross - provCredits.value));
  add('42800', `Provincial tax (${province})`, provTax);

  // --------------------------------------------------- payable / refund --
  const totalPayable = round2(federalTax + provTax);
  add('43500', 'Total payable', totalPayable);
  let taxDeducted = 0;
  for (const s of slips || []) {
    if (!s || !s.fields) continue;
    for (const key of TAX_DEDUCTED_BOXES[s.kind] || []) {
      const v = Number(s.fields[key]);
      if (isFinite(v)) taxDeducted = round2(taxDeducted + v);
    }
  }
  add('43700', 'Total income tax deducted', taxDeducted);
  add('48200', 'Total credits', taxDeducted); // only tax deducted in v1
  const refund = round2(taxDeducted - totalPayable);
  add('48400', refund >= 0 ? 'Refund' : 'Balance owing', refund);

  // ------------------------------------------------------------ notes --
  // Items the v1 computation cannot place, listed so the popup
  // never silently drops them.
  const excluded = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.kind === 'capital_gain' && it.status !== 'excluded') {
      excluded.push(`“${it.label || 'Sale'}”: sale proceeds are not the gain — the cost base is not tracked, so no capital gain is included.`);
    } else if (it.kind === 'resp' && it.status !== 'excluded') {
      excluded.push(`“${it.label || 'RESP'}”: RESP contributions are not tax-deductible — $0 in the computation.`);
    } else if (it.kind === 'student' && it.status !== 'excluded') {
      excluded.push(`“${it.label || 'Student'}”: no single T1 line — tuition/education amounts need the T2202 slip.`);
    } else if (it.kind === 'hbp' && it.status !== 'excluded') {
      excluded.push(`“${it.label || 'Home buyers plan'}”: HBP repayment vs income inclusion needs the designation — not computed.`);
    } else if (it.kind === 'credit' && it.status !== 'excluded') {
      excluded.push(`“${it.label || 'Provincial credit'}”: provincial credits need their BC428 line — not computed.`);
    } else if (it.kind === 'deduction' && it.status !== 'excluded' && !(it.detail && it.detail.derived)) {
      excluded.push(`“${it.label || 'Deduction'}”: no T1 line in the v1 computation.`);
    }
  }
  notes.push(...excluded);
  if (disability) {
    notes.push('Disability: one entered amount is used on both the federal (31600) and BC (58440) lines; the statutory maxima differ ($10,138 vs $9,699 for 2025), so a claim at the federal maximum slightly overstates the BC credit.');
  }
  if (sums.investment_income) {
    notes.push('Investment income enters at face value — eligible Canadian dividends need a gross-up plus dividend tax credit on the real T1.');
  }

  return {
    taxYear: year, province,
    refund, isRefund: refund >= 0,
    label: refund >= 0 ? 'Refund' : 'Balance owing',
    displayAmount: Math.abs(refund),
    lines, notes,
  };
}
