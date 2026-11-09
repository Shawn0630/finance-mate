// Home highlight marks: rental marks key by the rent ENTRY id (user
// 2026-11-08 — entries stay separate, never merged). Old rows keyed
// by the rental id are rewritten by migrateRentalMarkSources
// (src/db.js): one old row maps to every entry of that rental whose
// due date in the mark's month equals the mark's date; rows with no
// matching entry are dropped. Idempotent — already-migrated rows are
// untouched, and re-running changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fm-homemarks-'));
process.env.DATA_DIR = dir;
const { db, migrateRentalMarkSources } = await import('../src/db.js');

const ts = '2026-11-08T00:00:00.000Z';
function seed() {
  db.prepare("INSERT INTO earn_rentals (id, label, rental_type, services_level, created_at, updated_at) VALUES (9, '2881', 'long_term', 'basic', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO earn_rental_entries (id, rental_id, start_ym, end_ym, monthly_rent, pay_day, created_at, updated_at) VALUES (41, 9, '2026-05', '2027-02', 960, 1, ?, ?), (42, 9, '2026-07', '2027-07', 1600, 1, ?, ?)").run(ts, ts, ts, ts);
  // Old-format rows: source_id is the RENTAL id (9).
  db.prepare("INSERT INTO income_marks (user_id, kind, source_id, pay_date, received, updated_at) VALUES (2, 'rental', 9, '2026-11-01', 1, ?), (2, 'rental', 9, '2026-10-01', 0, ?), (2, 'rental', 9, '2025-01-01', 1, ?)").run(ts, ts, ts);
  // Already-migrated row: source_id is an ENTRY id — must survive.
  db.prepare("INSERT INTO income_marks (user_id, kind, source_id, pay_date, received, updated_at) VALUES (2, 'rental', 41, '2026-12-01', 1, ?)").run(ts);
  // Orphan: a rental that no longer exists.
  db.prepare("INSERT INTO income_marks (user_id, kind, source_id, pay_date, received, updated_at) VALUES (2, 'rental', 99, '2026-11-01', 1, ?)").run(ts);
}
seed();

const marks = () => db.prepare('SELECT user_id, kind, source_id, pay_date, received FROM income_marks ORDER BY source_id, pay_date').all();

test('home marks: old rental-id marks rewrite to entry ids', () => {
  const first = migrateRentalMarkSources(db);
  // Nov 1 + Oct 1 each map to BOTH entries (both due day 1);
  // Jan 2025 matches no entry and the orphan rental is dropped.
  assert.deepEqual(first, { migrated: 4, dropped: 2 });
  assert.deepEqual(marks(), [
    { user_id: 2, kind: 'rental', source_id: 41, pay_date: '2026-10-01', received: 0 },
    { user_id: 2, kind: 'rental', source_id: 41, pay_date: '2026-11-01', received: 1 },
    { user_id: 2, kind: 'rental', source_id: 41, pay_date: '2026-12-01', received: 1 },
    { user_id: 2, kind: 'rental', source_id: 42, pay_date: '2026-10-01', received: 0 },
    { user_id: 2, kind: 'rental', source_id: 42, pay_date: '2026-11-01', received: 1 },
  ]);
});

test('home marks: migration is idempotent', () => {
  const before = marks();
  assert.deepEqual(migrateRentalMarkSources(db), { migrated: 0, dropped: 0 });
  assert.deepEqual(marks(), before);
});

test('home marks: an old row maps only to entries due that day', () => {
  // Entry 41 ends Feb 2027; entry 42 runs to Jul 2027. A mark on
  // Mar 1, 2027 (after 41 ended) maps to 42 only.
  db.prepare("INSERT INTO income_marks (user_id, kind, source_id, pay_date, received, updated_at) VALUES (2, 'rental', 9, '2027-03-01', 1, ?)").run(ts);
  assert.deepEqual(migrateRentalMarkSources(db), { migrated: 1, dropped: 0 });
  assert.deepEqual(
    db.prepare("SELECT source_id, pay_date FROM income_marks WHERE pay_date = '2027-03-01'").all(),
    [{ source_id: 42, pay_date: '2027-03-01' }],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
