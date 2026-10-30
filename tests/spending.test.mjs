// Spending: QFX parsing, merchant mapping keys, aggregation, apply
// validation. Synthetic fixtures only — no real bank file is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEND_CATEGORIES, parseQfx, validateSpendApply, normalizeMerchant,
  maskAccountId, validSpendDate, spendMonthly, spendShareByCard,
  spendShareByCategory, spendTotal,
} from '../src/spending.js';

const QFX_CLOSED = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CCACCTFROM><ACCTID>1234567890123456</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261015</DTPOSTED><TRNAMT>-42.50</TRNAMT><FITID>F1</FITID><NAME>WHOLE FOODS</NAME><MEMO>Groceries</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261016000000.000[-5:EST]</DTPOSTED><TRNAMT>100.00</TRNAMT><FITID>F2</FITID><NAME>PAYMENT - THANK YOU</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

// SGML dialect: no closing tags on fields or rows, BANKACCTFROM
// instead of CCACCTFROM, MEMO-only merchant.
const QFX_SGML = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>98765</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902<TRNAMT>-12.00<FITID>G1<MEMO>UBER TRIP
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260230<TRNAMT>-5.00<FITID>G2<NAME>BAD DATE
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-7.00<FITID>G1<NAME>DUP FITID
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260904<TRNAMT>0<FITID>G3<NAME>ZERO
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260905<TRNAMT>-9.00<NAME>NO FITID
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('parseQfx: closed-tag file, masked account, charge/payment kinds', () => {
  const p = parseQfx(QFX_CLOSED);
  assert.equal(p.accountId, '••••3456');
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].date, '2026-10-15');
  assert.equal(p.rows[0].amount, -42.5);
  assert.equal(p.rows[0].kind, 'charge');
  assert.equal(p.rows[0].merchant, 'WHOLE FOODS');
  assert.equal(p.rows[1].date, '2026-10-16');
  assert.equal(p.rows[1].kind, 'payment');
  assert.deepEqual(p.dropped, []);
});

test('parseQfx: SGML dialect drops bad rows with reasons, never silently', () => {
  const p = parseQfx(QFX_SGML);
  assert.equal(p.accountId, '••••8765');
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].merchant, 'UBER TRIP');
  assert.equal(p.rows[0].date, '2026-09-02');
  const reasons = p.dropped.map((d) => d.reason).sort();
  assert.deepEqual(reasons, [
    'duplicate FITID in file',
    'missing FITID',
    'unreadable or zero amount',
    'unreadable posting date',
  ]);
});

test('maskAccountId and normalizeMerchant', () => {
  assert.equal(maskAccountId('1234567890'), '••••7890');
  assert.equal(maskAccountId('123'), '••••');
  assert.equal(maskAccountId(''), null);
  assert.equal(normalizeMerchant('  Whole Foods #1234  '), 'whole foods 1234');
  assert.equal(normalizeMerchant("L'OBELAW'S"), 'l obelaw s');
  assert.equal(normalizeMerchant(''), '');
});

test('validSpendDate rejects impossible dates', () => {
  assert.equal(validSpendDate('2026-02-28'), true);
  assert.equal(validSpendDate('2026-02-30'), false);
  assert.equal(validSpendDate('2026-13-01'), false);
  assert.equal(validSpendDate('2026-1-1'), false);
  assert.equal(validSpendDate('garbage'), false);
});

test('spending aggregation: charges only, payments never inflate', () => {
  const tx = [
    { card_id: 1, date: '2026-10-01', amount: -50, category: 'Groceries' },
    { card_id: 1, date: '2026-10-02', amount: 200, category: null },
    { card_id: 2, date: '2026-10-03', amount: -30, category: 'Groceries' },
    { card_id: 2, date: '2026-11-01', amount: -20, category: 'Dining' },
  ];
  assert.deepEqual(spendMonthly(tx), [
    { month: '2026-10', total: 80 },
    { month: '2026-11', total: 20 },
  ]);
  assert.equal(spendTotal(tx), 100);
  const cards = [{ id: 1, name: 'Visa' }, { id: 2, name: 'MC' }];
  assert.deepEqual(spendShareByCard(tx, cards).map((s) => [s.label, s.total]), [['Visa', 50], ['MC', 50]]);
  assert.deepEqual(spendShareByCategory(tx).map((s) => [s.label, s.total]), [['Groceries', 80], ['Dining', 20]]);
});

test('validateSpendApply: skips existing, drops malformed', () => {
  const v = validateSpendApply([
    { date: '2026-10-01', amount: -10, merchant: 'A', fitid: 'F1' },
    { date: '2026-10-02', amount: -20, merchant: 'B', fitid: 'F2' },
    { date: '2026-10-03', amount: -30, merchant: 'C', fitid: 'F2' },
    { date: '2026-13-01', amount: -40, merchant: 'D', fitid: 'F3' },
    { date: '2026-10-05', amount: 'nope', merchant: 'E', fitid: 'F4' },
    { date: '2026-10-06', amount: -60, merchant: '  ', fitid: 'F5' },
  ], new Set(['F1']));
  assert.equal(v.valid.length, 1);
  assert.equal(v.valid[0].fitid, 'F2');
  assert.equal(v.skipped.length, 1);
  assert.equal(v.dropped.length, 4);
});

test('category list is stable for AI prompts', () => {
  assert.ok(SPEND_CATEGORIES.includes('Groceries'));
  assert.ok(SPEND_CATEGORIES.includes('Other'));
});
