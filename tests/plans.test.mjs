// Contribution plans: pay-date stepping, RRSP-only employer
// validation, price(t) generation, skipped-period re-evaluation,
// and the deleted-never-recreated tombstone — all against an
// in-memory database with the plan tables in their real shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  payDatesFrom, frequencyLabel, validPlanInput,
  listPlans, getPlan, planView, generatePlan, recordPlanEventDeletion,
} from '../src/plans.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE earn_jobs (id INTEGER PRIMARY KEY, employer TEXT NOT NULL, frequency TEXT NOT NULL);
    CREATE TABLE invest_holdings (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER NOT NULL, date TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE invest_events (id INTEGER PRIMARY KEY, holding_id INTEGER NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL,
      units REAL, price REAL, amount REAL, split_new REAL, split_old REAL, note TEXT, source TEXT NOT NULL DEFAULT 'manual',
      plan_id INTEGER, own_amount REAL, employer_amount REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE invest_plans (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, job_id INTEGER NOT NULL,
      target_holding_id INTEGER, start_date TEXT NOT NULL, own_amount REAL NOT NULL, employer_amount REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE invest_plan_deleted (plan_id INTEGER NOT NULL, due_date TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, due_date));
  `);
  db.prepare("INSERT INTO earn_jobs (id, employer, frequency) VALUES (1, 'Acme Corp', 'biweekly')").run();
  db.prepare("INSERT INTO invest_holdings (id, label) VALUES (10, 'Index Fund')").run();
  const ts = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO invest_plans (id, account_id, job_id, target_holding_id, start_date, own_amount, employer_amount, created_at, updated_at) VALUES (1, 1, 1, 10, ?, 100, 50, ?, ?)')
    .run('2026-01-05', ts, ts);
  return db;
}
const plan = (db) => getPlan(db, 1);
const px = (db, date, price, source = 'manual') =>
  db.prepare('INSERT INTO invest_prices (holding_id, date, price, source) VALUES (10, ?, ?, ?)').run(date, price, source);
const events = (db) => db.prepare('SELECT * FROM invest_events ORDER BY date').all();

// ------------------------------------------------------------ stepping
test('payDatesFrom: weekly and biweekly step 7/14 days from the start', () => {
  assert.deepEqual(payDatesFrom('weekly', '2026-01-05', '2026-01-20'), ['2026-01-05', '2026-01-12', '2026-01-19']);
  assert.deepEqual(payDatesFrom('biweekly', '2026-01-05', '2026-02-02'), ['2026-01-05', '2026-01-19', '2026-02-02']);
  assert.deepEqual(payDatesFrom('weekly', '2026-01-20', '2026-01-05'), []);
});

test('payDatesFrom: monthly clamps to month-end, semimonthly pays 15th + month-end', () => {
  assert.deepEqual(payDatesFrom('monthly', '2026-01-31', '2026-03-31'), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(payDatesFrom('semimonthly', '2026-01-20', '2026-02-28'),
    ['2026-01-31', '2026-02-15', '2026-02-28']);
  assert.deepEqual(payDatesFrom('semimonthly', '2026-01-10', '2026-01-31'), ['2026-01-15', '2026-01-31']);
});

test('payDatesFrom: annual steps yearly, Feb 29 clamps to Feb 28', () => {
  assert.deepEqual(payDatesFrom('annual', '2024-02-29', '2026-03-01'), ['2024-02-29', '2025-02-28', '2026-02-28']);
  assert.equal(frequencyLabel('biweekly'), 'Bi-weekly');
});

// --------------------------------------------------------- validation
test('validPlanInput: employer amount is RRSP-only, own amount must be > 0', () => {
  assert.equal(validPlanInput({ job_id: 1, target_holding_id: 10, start_date: '2026-01-05', own_amount: 100, employer_amount: 50 }, { accountType: 'RRSP' }).error, undefined);
  assert.match(validPlanInput({ job_id: 1, target_holding_id: 10, start_date: '2026-01-05', own_amount: 100, employer_amount: 50 }, { accountType: 'TFSA' }).error, /RRSP/);
  assert.match(validPlanInput({ job_id: 1, target_holding_id: 10, start_date: '2026-01-05', own_amount: 100, employer_amount: 50 }, { accountType: 'RSU' }).error, /RRSP/);
  assert.match(validPlanInput({ job_id: 1, target_holding_id: 10, start_date: '2026-01-05', own_amount: 0 }, { accountType: 'RRSP' }).error, /own amount/);
  assert.match(validPlanInput({ job_id: 1, target_holding_id: 10, start_date: '2026-13-05', own_amount: 100 }, { accountType: 'RRSP' }).error, /start date/);
  // Zero employer on a TFSA normalizes to null (no match to reject).
  assert.equal(validPlanInput({ job_id: 1, target_holding_id: 10, start_date: '2026-01-05', own_amount: 100, employer_amount: 0 }, { accountType: 'TFSA' }).employerAmount, null);
});

// -------------------------------------------------------- generation
test('generatePlan: one buy per due period, priced at last price ≤ due date, split columns stored', () => {
  const db = setup();
  px(db, '2026-01-01', 10);
  px(db, '2026-01-20', 20);
  const gen = generatePlan(db, plan(db), { today: '2026-02-02', ts: '2026-02-02T00:00:00.000Z' });
  assert.equal(gen.skipped.length, 0);
  assert.deepEqual(gen.created.map((c) => [c.date, c.units, c.price]), [
    ['2026-01-05', 15, 10], ['2026-01-19', 15, 10], ['2026-02-02', 7.5, 20],
  ]);
  const evs = events(db);
  assert.equal(evs.length, 3);
  for (const e of evs) {
    assert.equal(e.type, 'buy');
    assert.equal(e.source, 'plan');
    assert.equal(e.plan_id, 1);
    assert.equal(e.own_amount, 100);
    assert.equal(e.employer_amount, 50);
  }
  // Idempotent: a second run creates nothing.
  const again = generatePlan(db, plan(db), { today: '2026-02-02', ts: '2026-02-02T00:00:00.000Z' });
  assert.deepEqual([again.created.length, again.skipped.length, events(db).length], [0, 0, 3]);
  // The plan view splits totals from the portion columns.
  const view = planView(db, plan(db), '2026-02-02');
  assert.equal(view.frequency, 'biweekly');
  assert.equal(view.employer, 'Acme Corp');
  assert.equal(view.generated_count, 3);
  assert.equal(view.own_total, 300);
  assert.equal(view.employer_total, 150);
  assert.deepEqual(view.skipped, []);
});

test('generatePlan: periods with no price are skipped, never guessed — and fill in when a price arrives', () => {
  const db = setup();
  const gen = generatePlan(db, plan(db), { today: '2026-02-02', ts: '2026-02-02T00:00:00.000Z' });
  assert.equal(events(db).length, 0);
  assert.deepEqual(gen.skipped.map((s) => s.due_date), ['2026-01-05', '2026-01-19', '2026-02-02']);
  assert.deepEqual(planView(db, plan(db), '2026-02-02').skipped.map((s) => s.due_date), gen.skipped.map((s) => s.due_date));
  // A price arriving 2026-01-10 fills the later periods only —
  // the 2026-01-05 period predates every known price, so it
  // stays skipped (still no price on or before it).
  px(db, '2026-01-10', 10);
  const gen2 = generatePlan(db, plan(db), { today: '2026-02-02', ts: '2026-02-03T00:00:00.000Z' });
  assert.deepEqual(gen2.created.map((c) => c.date), ['2026-01-19', '2026-02-02']);
  assert.deepEqual(gen2.skipped.map((s) => s.due_date), ['2026-01-05']);
});

test('generatePlan: a deleted period is never recreated; other periods still generate', () => {
  const db = setup();
  px(db, '2026-01-01', 10);
  generatePlan(db, plan(db), { today: '2026-02-02', ts: '2026-02-02T00:00:00.000Z' });
  assert.equal(events(db).length, 3);
  const doomed = db.prepare("SELECT * FROM invest_events WHERE date = '2026-01-19'").get();
  assert.equal(recordPlanEventDeletion(db, doomed), true);
  db.prepare('DELETE FROM invest_events WHERE id = ?').run(doomed.id);
  // A non-plan event deletion writes no tombstone.
  assert.equal(recordPlanEventDeletion(db, { source: 'manual', plan_id: null, date: '2026-01-19' }), false);
  const gen = generatePlan(db, plan(db), { today: '2026-02-16', ts: '2026-02-16T00:00:00.000Z' });
  assert.deepEqual(gen.created.map((c) => c.date), ['2026-02-16']);
  assert.deepEqual(events(db).map((e) => e.date), ['2026-01-05', '2026-02-02', '2026-02-16']);
});

test('planView: frequency follows the linked job when it changes', () => {
  const db = setup();
  px(db, '2026-01-01', 10);
  assert.equal(planView(db, plan(db), '2026-02-02').frequency, 'biweekly');
  db.prepare("UPDATE earn_jobs SET frequency = 'monthly' WHERE id = 1").run();
  const view = planView(db, plan(db), '2026-02-02');
  assert.equal(view.frequency, 'monthly');
  assert.equal(view.frequency_label, 'Monthly');
  // Monthly dues from 2026-01-05 through 2026-02-02: only 2026-01-05.
  generatePlan(db, plan(db), { today: '2026-02-02', ts: '2026-02-02T00:00:00.000Z' });
  assert.deepEqual(events(db).map((e) => e.date), ['2026-01-05']);
  assert.equal(listPlans(db, 1).length, 1);
});
