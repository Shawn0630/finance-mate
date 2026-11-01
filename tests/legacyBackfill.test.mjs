// Legacy opening-position backfill (src/db.js): pre-position-model
// jobs have a NULL opening_value because the 506f6cb migration added
// the column without backfilling. The migration must fill it from
// the current per-period value exactly when no pay-change record
// exists yet — and leave every other row alone. This test boots the
// REAL migration against a scratch database: first boot creates the
// full real schema, legacy-shaped rows are inserted, then a
// cache-busted re-import re-runs the migration over those rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fm-backfill-'));
process.env.DATA_DIR = dir;
await import('../src/db.js');

const seed = new Database(path.join(dir, 'finance.db'));
const addJob = seed.prepare(
  `INSERT INTO earn_jobs (employer, currency, province, frequency, gross_amount, gross_basis, tax_year, opening_value, start_date, created_at, updated_at)
   VALUES (?, 'CAD', 'BC', ?, ?, ?, 2026, ?, ?, '2026-01-01', '2026-01-01')`);
addJob.run('NoChangePeriod', 'biweekly', 6504.59, 'period', null, '2022-06-06');
addJob.run('NoChangeAnnual', 'biweekly', 169119.34, 'annual', null, '2022-06-06');
addJob.run('HasChange', 'biweekly', 5000, 'period', null, '2020-01-01');
addJob.run('AlreadySet', 'biweekly', 7000, 'period', 4000, '2019-01-01');
addJob.run('NoChangeMonthly', 'monthly', 120000, 'annual', null, '2021-01-01');
seed.prepare(
  `INSERT INTO earn_pay_changes (job_id, effective_date, value, created_at)
   VALUES ((SELECT id FROM earn_jobs WHERE employer = 'HasChange'), '2024-01-01', 5000, '2024-01-01')`).run();
seed.close();

// Re-run the real migration over the legacy rows.
await import('../src/db.js?backfill=1');

const check = new Database(path.join(dir, 'finance.db'), { readonly: true });
const val = (name) => check.prepare(
  'SELECT opening_value FROM earn_jobs WHERE employer = ?').get(name).opening_value;
const near = (a, b) => Math.abs(a - b) < 0.01;

test('legacy opening backfill fills only no-change jobs with a current pay', () => {
  assert.ok(near(val('NoChangePeriod'), 6504.59));
  assert.ok(near(val('NoChangeAnnual'), 6504.59));
  assert.equal(val('HasChange'), null);
  assert.equal(val('AlreadySet'), 4000);
  assert.ok(near(val('NoChangeMonthly'), 10000));
});
