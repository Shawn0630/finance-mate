// Spending — credit cards: QFX import, transactions, category analysis.
//
// Sign rule (one rule everywhere): a charge is stored as a NEGATIVE
// amount, exactly as the bank file states it; a payment or credit is
// positive. Spending totals sum -amount over charges only, so a
// payment never inflates spending and a refund never hides it.
//
// Kind rule: a row's kind is charge | payment | refund |
// adjustment. Charges are negative amounts. A positive amount is a
// payment ONLY when the merchant reads like a payment (PAYMENT /
// PAIEMEN / THANK YOU); any other positive amount is a refund —
// sign alone must never label a merchant refund a payment. An
// adjustment row reconciles the stored balance with a file balance
// (see the balance check); it is EXCLUDED from every spending
// total but INCLUDED in the balance computation, so the balance
// can reconcile without inflating spending.
//
// Security rule: a card stores its last 4 digits ONLY, never a full
// PAN; QFX account ids are masked at parse time and never stored.

export const SPEND_CATEGORIES = [
  'Groceries', 'Dining', 'Transport', 'Housing', 'Utilities', 'Health',
  'Entertainment', 'Shopping', 'Travel', 'Education', 'Fees & interest', 'Other',
];

// The merchant key a remembered category maps under: lowercase,
// punctuation collapsed to spaces. Unicode letters survive, so a
// non-English merchant name still maps.
export function normalizeMerchant(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// A bank account id as it may leave the app: last 4 only, or a bare
// mask when there is nothing to take 4 from. Never the full id.
export function maskAccountId(id) {
  const s = String(id || '').replace(/\s/g, '');
  if (!s) return null;
  return s.length > 4 ? '••••' + s.slice(-4) : '••••';
}

const round2 = (n) => Math.round(n * 100) / 100;

// Strict YYYY-MM-DD: the regex shape plus a real calendar date
// (Feb 30 is not a date, and neither is month 13).
export function validSpendDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// QFX is OFX SGML: tags frequently arrive WITHOUT closing tags, so
// this parses tag-by-tag instead of as XML. A <STMTTRN> block runs
// until the next <STMTTRN>, its closing tag, or </BANKTRANLIST>.
// Bank dialects vary in which of CCACCTFROM / BANKACCTFROM wraps
// the account, in whether DTPOSTED carries a time suffix, and in
// whether NAME or only MEMO names the merchant — all handled.
function qfxField(block, tag) {
  const m = new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i').exec(block);
  return m ? m[1].trim() : '';
}

// DTPOSTED like 20261015 or 20261015000000.000[-5:EST] → YYYY-MM-DD.
function qfxDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const out = `${m[1]}-${m[2]}-${m[3]}`;
  return validSpendDate(out) ? out : null;
}

// A merchant that reads like a repayment, not a purchase: the
// bank's payment rows are literally "PAYMENT THANK YOU" (and the
// French "PAIEMEN[T]"). Words, not substrings — a biller named
// PAYMENTUS is not a repayment row. Anything else with a
// positive amount is a refund, not a payment.
export function isPaymentMerchant(name) {
  const words = normalizeMerchant(name).split(' ').filter(Boolean);
  return words.includes('payment') || words.includes('paiemen') || words.includes('paiement')
    || (words.includes('thank') && words.includes('you'));
}

// Kind from amount + merchant evidence, never sign alone.
export function spendKind({ amount, merchant }) {
  if (Number(amount) < 0) return 'charge';
  return isPaymentMerchant(merchant) ? 'payment' : 'refund';
}

// Owed balance implied by stored rows (all kinds, adjustments
// included): charges push it up, payments and refunds push it
// down. The file balance is compared against this, never against
// a spending total.
export function spendBalance(transactions) {
  return round2(-(transactions || []).reduce((n, t) => n + Number(t.amount || 0), 0));
}

// A QFX statement balance: LEDGERBAL's BALAMT is negative when
// the cardholder owes, so owed = -BALAMT; DTASOF is the as-of
// date. Null when the file carries no ledger balance.
function qfxBalance(src) {
  const m = /<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<BANKTRANLIST>|<\/STMTRS>)/i.exec(src);
  if (!m) return null;
  const raw = qfxField(m[1], 'BALAMT');
  if (raw === '') return null;
  const balamt = Number(raw);
  if (!Number.isFinite(balamt)) return null;
  return { owed: round2(-balamt), asof: qfxDate(qfxField(m[1], 'DTASOF')) };
}

export function parseQfx(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const acctMatch = /<(?:CCACCTFROM|BANKACCTFROM)>([\s\S]*?)<\/(?:CCACCTFROM|BANKACCTFROM)>/i.exec(src)
    || /<(?:CCACCTFROM|BANKACCTFROM)>([\s\S]*?)(?=<STMTTRN>|<BANKTRANLIST>)/i.exec(src);
  const accountId = acctMatch ? maskAccountId(qfxField(acctMatch[1], 'ACCTID')) : null;
  const balance = qfxBalance(src);
  const rows = [];
  const dropped = [];
  const seenFitids = new Set();
  const blockRe = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>)/gi;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    const block = m[1];
    const fitid = qfxField(block, 'FITID');
    const date = qfxDate(qfxField(block, 'DTPOSTED'));
    const amountRaw = qfxField(block, 'TRNAMT');
    const amount = amountRaw === '' ? NaN : Number(amountRaw);
    const merchant = qfxField(block, 'NAME') || qfxField(block, 'MEMO') || 'Unknown';
    const memo = qfxField(block, 'MEMO');
    const drop = (reason) => dropped.push({ reason, fitid: fitid || null, merchant, date: date || null });
    if (!fitid) { drop('missing FITID'); continue; }
    if (seenFitids.has(fitid)) { drop('duplicate FITID in file'); continue; }
    seenFitids.add(fitid);
    if (!date) { drop('unreadable posting date'); continue; }
    if (!Number.isFinite(amount) || amount === 0) { drop('unreadable or zero amount'); continue; }
    rows.push({
      date,
      amount,
      merchant,
      memo: memo || null,
      fitid,
      type: qfxField(block, 'TRNTYPE') || null,
      kind: spendKind({ amount, merchant }),
    });
  }
  return { accountId, balance, rows, dropped };
}

// Re-validate rows a client sends to Apply (the preview is client
// state, never trusted): shape, dates, amounts, FITIDs. Existing
// FITIDs skip; anything malformed drops with a reason. Nothing
// here writes — the endpoint inserts the valid rows in one
// transaction.
export function validateSpendApply(rows, existingFitids) {
  const existing = existingFitids instanceof Set ? existingFitids : new Set(existingFitids || []);
  const valid = [];
  const skipped = [];
  const dropped = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const drop = (reason) => dropped.push({ reason, fitid: (r && r.fitid) || null, merchant: (r && r.merchant) || null });
    if (!r || typeof r !== 'object') { drop('not a row'); continue; }
    const fitid = String(r.fitid || '').trim();
    if (!fitid) { drop('missing FITID'); continue; }
    if (seen.has(fitid)) { drop('duplicate FITID in file'); continue; }
    seen.add(fitid);
    if (existing.has(fitid)) { skipped.push({ ...r, fitid }); continue; }
    if (!validSpendDate(r.date)) { drop('invalid date'); continue; }
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount === 0) { drop('invalid amount'); continue; }
    const merchant = String(r.merchant || '').trim();
    if (!merchant) { drop('missing merchant'); continue; }
    valid.push({
      date: r.date,
      amount,
      merchant,
      memo: r.memo != null ? String(r.memo) : null,
      fitid,
      type: r.type != null ? String(r.type) : null,
      kind: spendKind({ amount, merchant }),
    });
  }
  return { valid, skipped, dropped };
}

// Monthly spending series (charges only, adjustments excluded),
// sorted by month.
export function spendMonthly(transactions) {
  const map = new Map();
  for (const t of transactions || []) {
    if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
    const month = String(t.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    map.set(month, (map.get(month) || 0) + -Number(t.amount));
  }
  return [...map.entries()].sort().map(([month, total]) => ({ month, total: round2(total) }));
}

// Share of spending over a set of transactions, by card.
// Zero-spend cards drop out, like zero-value accounts in Stocks.
export function spendShareByCard(transactions, cards) {
  const totals = new Map();
  for (const t of transactions || []) {
    if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
    totals.set(t.card_id, (totals.get(t.card_id) || 0) + -Number(t.amount));
  }
  return (cards || [])
    .map((c) => ({ id: c.id, label: c.name, total: round2(totals.get(c.id) || 0) }))
    .filter((s) => s.total > 0);
}

// Share of spending over a set of transactions, by category.
export function spendShareByCategory(transactions) {
  const totals = new Map();
  for (const t of transactions || []) {
    if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
    const label = (t.category || '').trim() || 'Uncategorized';
    totals.set(label, (totals.get(label) || 0) + -Number(t.amount));
  }
  return [...totals.entries()]
    .map(([label, total]) => ({ label, total: round2(total) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);
}

export function spendTotal(transactions) {
  return round2((transactions || []).reduce((n, t) => (t.kind === 'adjustment' || !(Number(t.amount) < 0) ? n : n + -Number(t.amount)), 0));
}
