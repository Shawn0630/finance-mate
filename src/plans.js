// Contribution plans — a Stocks account's recurring buys linked
// to a salary job ("工资联动 RRSP 供款计划").
//
// A plan belongs to one invest account and links to one earn job.
// Its frequency is NEVER stored: it is derived from the linked
// job at read time, so a job's frequency change moves the plan
// with it. Own amount = the payroll deduction; employer amount =
// the employer match, which exists only on RRSP accounts (the
// form never renders it elsewhere and the server rejects it
// elsewhere; RSU / NonRegistered / Other plans are own-only).
//
// Generation — due periods run from the plan's start date
// through today only, stepped by the job's pay cadence:
//   weekly 7d, biweekly 14d, semimonthly 15th + month-end,
//   monthly same-day clamped to month-end, annual yearly
// (same month/day, Feb 29 clamped to Feb 28). Each due period
// becomes ONE buy event on the target holding, priced at
// price(t) — the last known price point on or before the due
// date, exactly the engine's priceOn lookup over invest_prices
// (market closes and NAV snapshots alike; no second pricing
// rule). A period with no known price is SKIPPED, never
// guessed: no event, and the skipped period is listed on the
// plan view (due date + reason) so a later run — after a price
// arrives — fills it. A period the user DELETED is never
// recreated: deleting a source='plan' event writes a tombstone
// (invest_plan_deleted, plan_id + due date) that generation
// always honours. The event carries the own/employer split in
// invest_events.own_amount / employer_amount (NULL on every
// non-plan event); plan totals sum those columns, never a
// re-derivation from units × price.
import { priceOn, rebuildEventPricePoints, isDateStr } from './investments.js';
import { PAY_FREQUENCIES } from './earnings.js';

const round4 = (n) => Math.round(n * 10000) / 10000;
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------ dates
function dayNum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
function dayStr(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const ymPad = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Every pay date from `start` through `today` inclusive, on the
// job's cadence, anchored at the start date.
export function payDatesFrom(frequency, start, today) {
  if (!isDateStr(start) || !isDateStr(today) || start > today) return [];
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'weekly' ? 7 : 14;
    const out = [];
    for (let n = dayNum(start); n <= dayNum(today); n += step) out.push(dayStr(n));
    return out;
  }
  if (frequency === 'monthly') {
    const anchorDay = Number(start.slice(8, 10));
    let y = Number(start.slice(0, 4));
    let m = Number(start.slice(5, 7));
    const out = [];
    for (;;) {
      const cand = ymPad(y, m, Math.min(anchorDay, lastDayOfMonth(y, m)));
      if (cand > today) break;
      if (cand >= start) out.push(cand);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  if (frequency === 'semimonthly') {
    let y = Number(start.slice(0, 4));
    let m = Number(start.slice(5, 7));
    const out = [];
    for (;;) {
      const mid = ymPad(y, m, 15);
      const end = ymPad(y, m, lastDayOfMonth(y, m));
      if (mid >= start && mid <= today) out.push(mid);
      if (end >= start && end <= today) out.push(end);
      if (end > today) break;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  if (frequency === 'annual') {
    const mo = Number(start.slice(5, 7));
    const anchorDay = Number(start.slice(8, 10));
    const out = [];
    for (let y = Number(start.slice(0, 4)); ; y += 1) {
      const cand = ymPad(y, mo, Math.min(anchorDay, lastDayOfMonth(y, mo)));
      if (cand > today) break;
      if (cand >= start) out.push(cand);
    }
    return out;
  }
  return [];
}

export function frequencyLabel(frequency) {
  return (PAY_FREQUENCIES[frequency] && PAY_FREQUENCIES[frequency].label) || frequency || '';
}

// -------------------------------------------------------- validation
const cleanNum = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function validPlanInput(b, { accountType } = {}) {
  if (!b || typeof b !== 'object') return { error: 'a plan is required' };
  const jobId = Number(b.job_id ?? b.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return { error: 'a linked salary job is required' };
  const holdingId = Number(b.target_holding_id ?? b.targetHoldingId ?? b.holding_id);
  if (!Number.isInteger(holdingId) || holdingId <= 0) return { error: 'a target holding is required' };
  if (!isDateStr(b.start_date)) return { error: 'start date must be YYYY-MM-DD' };
  const ownAmount = cleanNum(b.own_amount ?? b.ownAmount);
  if (ownAmount == null || ownAmount <= 0) return { error: 'own amount must be a number > 0' };
  const employerRaw = cleanNum(b.employer_amount ?? b.employerAmount);
  if (employerRaw != null && employerRaw < 0) return { error: 'employer amount must be a number ≥ 0' };
  if (accountType !== 'RRSP' && employerRaw != null && employerRaw > 0) {
    return { error: 'employer contributions apply to RRSP accounts only' };
  }
  return {
    jobId, holdingId, startDate: b.start_date,
    ownAmount, employerAmount: accountType === 'RRSP' && employerRaw ? employerRaw : null,
  };
}

// ------------------------------------------------------------- reads
export function listPlans(db, accountId) {
  return db.prepare('SELECT * FROM invest_plans WHERE account_id = ? ORDER BY id').all(accountId);
}
export function getPlan(db, id) {
  return db.prepare('SELECT * FROM invest_plans WHERE id = ?').get(id) || null;
}
export function listPlanEvents(db, planId) {
  return db.prepare('SELECT * FROM invest_events WHERE plan_id = ? ORDER BY date, id').all(planId);
}

// One due period's state: an existing plan event, a tombstone
// (user-deleted), or a price on/before the due date — in that
// order of precedence. Generation and the plan view share this,
// so a listed skip and a generated buy can never disagree.
export function duePeriodStatus(db, plan, dueDate) {
  const existing = db.prepare(
    'SELECT id FROM invest_events WHERE plan_id = ? AND date = ? LIMIT 1').get(plan.id, dueDate);
  if (existing) return { dueDate, state: 'done', eventId: existing.id };
  const deleted = db.prepare(
    'SELECT 1 FROM invest_plan_deleted WHERE plan_id = ? AND due_date = ?').get(plan.id, dueDate);
  if (deleted) return { dueDate, state: 'deleted' };
  const points = db.prepare(
    'SELECT date, price, source FROM invest_prices WHERE holding_id = ? ORDER BY date, id').all(plan.target_holding_id);
  const px = priceOn(points, dueDate);
  if (!px) return { dueDate, state: 'skipped', reason: 'no price on or before this date' };
  return { dueDate, state: 'due', price: px.price, priceDate: px.date, priceSource: px.source };
}

// The plan as the UI reads it: frequency and employer name live
// from the linked job at read time (never stored on the plan),
// totals sum the plan events' own/employer columns, and skipped
// periods are listed with their reason.
export function planView(db, plan, today) {
  const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(plan.job_id);
  const holding = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(plan.target_holding_id);
  const frequency = job ? job.frequency : null;
  const dues = frequency ? payDatesFrom(frequency, plan.start_date, today) : [];
  const skipped = [];
  for (const d of dues) {
    const st = duePeriodStatus(db, plan, d);
    if (st.state === 'skipped') skipped.push({ due_date: d, reason: st.reason });
  }
  const events = listPlanEvents(db, plan.id);
  const ownTotal = round2(events.reduce((s, e) => s + (Number(e.own_amount) || 0), 0));
  const employerTotal = round2(events.reduce((s, e) => s + (Number(e.employer_amount) || 0), 0));
  return {
    ...plan,
    frequency, frequency_label: frequencyLabel(frequency),
    employer: job ? job.employer : null,
    target_holding_label: holding ? holding.label : null,
    generated_count: events.length,
    own_total: ownTotal, employer_total: employerTotal,
    skipped,
  };
}

// -------------------------------------------------------- generation
// Runs one plan's due periods through today. Idempotent: an
// existing event, a tombstone, and a skipped period are all left
// exactly as they are — a later run only fills periods that are
// still open AND newly priced. Returns what this run created
// and what it skipped (the view recomputes skips live, so the
// two can never drift apart).
export function generatePlan(db, plan, { today, ts }) {
  const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(plan.job_id);
  if (!job) return { created: [], skipped: [], error: 'linked job not found' };
  const holding = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(plan.target_holding_id);
  if (!holding) return { created: [], skipped: [], error: 'target holding not found' };
  const created = [];
  const skipped = [];
  const ins = db.prepare(
    `INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old,
     note, source, plan_id, own_amount, employer_amount, created_at, updated_at)
     VALUES (?, ?, 'buy', ?, ?, NULL, NULL, NULL, NULL, 'plan', ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const due of payDatesFrom(job.frequency, plan.start_date, today)) {
      const st = duePeriodStatus(db, plan, due);
      if (st.state !== 'due') {
        if (st.state === 'skipped') skipped.push({ due_date: due, reason: st.reason });
        continue;
      }
      const total = Number(plan.own_amount) + (Number(plan.employer_amount) || 0);
      const units = round4(total / st.price);
      if (!(units > 0)) { skipped.push({ due_date: due, reason: 'no price on or before this date' }); continue; }
      ins.run(plan.target_holding_id, due, units, st.price,
        plan.id, Number(plan.own_amount), Number(plan.employer_amount) || null, ts, ts);
      created.push({ date: due, units, price: st.price });
    }
  })();
  if (created.length) rebuildEventPricePoints(db, plan.target_holding_id, ts);
  return { created, skipped };
}

export function generatePlansForAccount(db, accountId, { today, ts }) {
  const out = {};
  for (const plan of listPlans(db, accountId)) {
    out[plan.id] = generatePlan(db, plan, { today, ts });
  }
  return out;
}

// Deleting a generated event tombstones its due period so no
// later generation run recreates it. Non-plan events and
// plan events whose plan is already gone pass through
// untouched. INSERT OR IGNORE keeps a repeat delete harmless.
export function recordPlanEventDeletion(db, event) {
  if (!event || event.source !== 'plan' || event.plan_id == null) return false;
  db.prepare('INSERT OR IGNORE INTO invest_plan_deleted (plan_id, due_date, created_at) VALUES (?, ?, ?)')
    .run(event.plan_id, event.date, new Date().toISOString());
  return true;
}
