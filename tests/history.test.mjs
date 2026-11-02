// App-global History (src/history.js): commit creation, undo,
// restore-to, dependency block, merge-revert rule, bulk-Apply = 1
// commit. Runs against an in-memory Database with a minimal schema
// (the columns the history module reads/writes, no FKs).
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  snapshotByAggregate, recordCommit, listCommits, getCommitFull,
  undoCommit, restoreCommit, findDependents, restoreSnapshot,
} from '../src/history.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_commits (
      id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, module TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id INTEGER, entity_label TEXT,
      project_id INTEGER, strategy_id INTEGER, merge_record_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'commit', summary TEXT NOT NULL,
      event TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE properties (id INTEGER PRIMARY KEY, address TEXT, mortgage_balance REAL, updated_at TEXT);
    CREATE TABLE mortgage_terms (id INTEGER PRIMARY KEY, property_id INTEGER, lender TEXT, start_date TEXT, updated_at TEXT);
    CREATE TABLE rate_segments (id INTEGER PRIMARY KEY, property_id INTEGER, term_id INTEGER, start_date TEXT, updated_at TEXT);
    CREATE TABLE lump_sums (id INTEGER PRIMARY KEY, property_id INTEGER, term_id INTEGER, date TEXT, amount REAL);
    CREATE TABLE property_costs (id INTEGER PRIMARY KEY, property_id INTEGER, year INTEGER, category TEXT, amount REAL);
    CREATE TABLE value_history (id INTEGER PRIMARY KEY, property_id INTEGER, year INTEGER, value REAL);
    CREATE TABLE plan_projects (id INTEGER PRIMARY KEY, name TEXT, snapshot TEXT, updated_at TEXT);
    CREATE TABLE plan_strategies (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, merged INTEGER DEFAULT 0, ai_thread TEXT, updated_at TEXT);
    CREATE TABLE plan_ops (id INTEGER PRIMARY KEY, strategy_id INTEGER, seq INTEGER, op_type TEXT, params TEXT, updated_at TEXT);
    CREATE TABLE plan_legs (id INTEGER PRIMARY KEY, op_id INTEGER, source_ref TEXT, amount TEXT);
    CREATE TABLE plan_assumptions (id INTEGER PRIMARY KEY, strategy_id INTEGER, key TEXT, value TEXT);
    CREATE TABLE plan_baselines (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, definition TEXT);
    CREATE TABLE plan_reports (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, definition TEXT);
    CREATE TABLE plan_declared_assets (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, amount REAL);
    CREATE TABLE plan_ai_models (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, spec TEXT);
    CREATE TABLE invest_accounts (id INTEGER PRIMARY KEY, name TEXT, updated_at TEXT);
    CREATE TABLE invest_holdings (id INTEGER PRIMARY KEY, account_id INTEGER, symbol TEXT, updated_at TEXT);
    CREATE TABLE invest_events (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, type TEXT, units REAL);
    CREATE TABLE invest_prices (id INTEGER PRIMARY KEY, holding_id INTEGER, date TEXT, price REAL, source TEXT);
    CREATE TABLE invest_plans (id INTEGER PRIMARY KEY, account_id INTEGER, job_id INTEGER);
    CREATE TABLE invest_plan_deleted (plan_id INTEGER, due_date TEXT);
    CREATE TABLE earn_jobs (id INTEGER PRIMARY KEY, employer TEXT, updated_at TEXT);
    CREATE TABLE earn_pay_changes (id INTEGER PRIMARY KEY, job_id INTEGER, effective_date TEXT, value REAL);
    CREATE TABLE earn_bonuses (id INTEGER PRIMARY KEY, job_id INTEGER, date TEXT, amount REAL);
    CREATE TABLE earn_rentals (id INTEGER PRIMARY KEY, property_id INTEGER, label TEXT, updated_at TEXT);
    CREATE TABLE earn_rental_years (id INTEGER PRIMARY KEY, rental_id INTEGER, tax_year INTEGER);
    CREATE TABLE earn_rental_entries (id INTEGER PRIMARY KEY, rental_id INTEGER, start_ym TEXT);
    CREATE TABLE spend_cards (id INTEGER PRIMARY KEY, name TEXT, balance_owed REAL, updated_at TEXT);
    CREATE TABLE spend_transactions (id INTEGER PRIMARY KEY, card_id INTEGER, merchant TEXT, category TEXT, amount REAL);
    CREATE TABLE user_preferences (user_id INTEGER, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (user_id, key));
  `);
  return db;
}
const USER = { id: 7, username: 'Shawn' };
function commit(db, meta) {
  return recordCommit(db, { userId: USER.id, username: USER.username, ...meta });
}
function propCommit(db, pid, label, summary) {
  return commit(db, {
    module: 'property', entityType: 'property', entityId: pid, entityLabel: label, summary,
    before: db._before, snapshot: snapshotByAggregate(db, 'property', pid),
  });
}
function saveProp(db, pid, address) {
  db._before = snapshotByAggregate(db, 'property', pid);
  db.prepare('UPDATE properties SET address = ?, updated_at = ? WHERE id = ?').run(address, 't', pid);
  return propCommit(db, pid, address, `Updated property ${address}`);
}

test('commit creation: a save records one commit with event + snapshot', () => {
  const db = makeDb();
  db.prepare("INSERT INTO properties (id, address) VALUES (1, 'A St')").run();
  const before = snapshotByAggregate(db, 'property', 1);
  db.prepare("UPDATE properties SET address = 'B St' WHERE id = 1").run();
  const id = commit(db, {
    module: 'property', entityType: 'property', entityId: 1, entityLabel: 'B St',
    summary: 'Updated property B St', before, snapshot: snapshotByAggregate(db, 'property', 1),
  });
  const c = getCommitFull(db, id);
  assert.equal(c.kind, 'commit');
  assert.equal(c.module, 'property');
  assert.equal(c.entity_label, 'B St');
  assert.equal(c.event.length, 1);
  assert.equal(c.event[0].before.address, 'A St');
  assert.equal(c.event[0].after.address, 'B St');
  assert.equal(c.snapshot.tables.properties[0].address, 'B St');
  assert.equal(listCommits(db, { module: null, q: null, projectId: null, limit: 50, offset: 0 }).total, 1);
});

test('undo restores the prior state and appends a revert commit', () => {
  const db = makeDb();
  db.prepare("INSERT INTO properties (id, address) VALUES (1, 'A St')").run();
  const c1 = saveProp(db, 1, 'B St');
  const c2 = saveProp(db, 1, 'C St');
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, 'C St');
  const tx = db.transaction(() => undoCommit(db, getCommitFull(db, c2), USER));
  const revertId = tx();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, 'B St');
  const revert = getCommitFull(db, revertId);
  assert.equal(revert.kind, 'revert');
  assert.equal(revert.summary, `Reverted commit #${c2}`);
  // The undone commit itself is untouched (history is append-only).
  assert.equal(getCommitFull(db, c2).kind, 'commit');
  assert.equal(c1, 1);
});

test('undo of a create deletes the row; undo of a delete re-inserts it', () => {
  const db = makeDb();
  const before = snapshotByAggregate(db, 'property', 9);
  db.prepare("INSERT INTO properties (id, address) VALUES (9, 'New St')").run();
  const cCreate = commit(db, {
    module: 'property', entityType: 'property', entityId: 9, entityLabel: 'New St',
    summary: 'Added property New St', before, snapshot: snapshotByAggregate(db, 'property', 9),
  });
  db.transaction(() => undoCommit(db, getCommitFull(db, cCreate), USER))();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties WHERE id = 9').get().n, 0);
  // Delete path: re-create, delete with a commit, undo the delete.
  db.prepare("INSERT INTO properties (id, address) VALUES (9, 'New St')").run();
  const beforeDel = snapshotByAggregate(db, 'property', 9);
  db.prepare('DELETE FROM properties WHERE id = 9').run();
  const cDel = commit(db, {
    module: 'property', entityType: 'property', entityId: 9, entityLabel: 'New St',
    summary: 'Deleted property New St', before: beforeDel, snapshot: snapshotByAggregate(db, 'property', 9),
  });
  db.transaction(() => undoCommit(db, getCommitFull(db, cDel), USER))();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 9').get().address, 'New St');
});

test('restore-to writes back the snapshot as a new commit', () => {
  const db = makeDb();
  db.prepare("INSERT INTO properties (id, address) VALUES (1, 'A St')").run();
  const c1 = saveProp(db, 1, 'B St');
  saveProp(db, 1, 'C St');
  saveProp(db, 1, 'D St');
  const tx = db.transaction(() => restoreCommit(db, getCommitFull(db, c1), USER));
  const revertId = tx();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, 'B St');
  assert.equal(getCommitFull(db, revertId).summary, `Restored to commit #${c1}`);
});

test('restore-to of a delete commit deletes the aggregate', () => {
  const db = makeDb();
  db.prepare("INSERT INTO properties (id, address) VALUES (1, 'A St')").run();
  const c1 = saveProp(db, 1, 'B St');
  const beforeDel = snapshotByAggregate(db, 'property', 1);
  db.prepare('DELETE FROM properties WHERE id = 1').run();
  const cDel = commit(db, {
    module: 'property', entityType: 'property', entityId: 1, entityLabel: 'B St',
    summary: 'Deleted property B St', before: beforeDel, snapshot: snapshotByAggregate(db, 'property', 1),
  });
  db.transaction(() => restoreCommit(db, getCommitFull(db, c1), USER))();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, 'B St');
  db.transaction(() => restoreCommit(db, getCommitFull(db, cDel), USER))();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties WHERE id = 1').get().n, 0);
});

test('dependency block: undo is refused while a later commit touched the same rows', () => {
  const db = makeDb();
  db.prepare("INSERT INTO properties (id, address) VALUES (1, 'A St')").run();
  db.prepare("INSERT INTO properties (id, address) VALUES (2, 'X St')").run();
  const c1 = saveProp(db, 1, 'B St');
  const c2 = saveProp(db, 1, 'C St');
  const c3 = saveProp(db, 2, 'Y St');
  assert.throws(
    () => db.transaction(() => undoCommit(db, getCommitFull(db, c1), USER))(),
    (err) => {
      assert.equal(err.dependents.length, 1);
      assert.equal(err.dependents[0].id, c2);
      return true;
    },
  );
  // An unrelated row's commit undoes freely and does not unblock c1.
  db.transaction(() => undoCommit(db, getCommitFull(db, c3), USER))();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 2').get().address, 'X St');
  assert.throws(
    () => db.transaction(() => undoCommit(db, getCommitFull(db, c1), USER))(),
    (err) => err.dependents.length === 1 && err.dependents[0].id === c2,
  );
  // Undoing c2 works (it is the latest touch on its rows) — but the
  // revert itself is a later touch, so c1 stays blocked afterwards.
  // That is the spec's rule; restore-to is the escape hatch for
  // older states, and it carries no dependency block.
  const r1 = db.transaction(() => undoCommit(db, getCommitFull(db, c2), USER))();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, 'B St');
  assert.throws(
    () => db.transaction(() => undoCommit(db, getCommitFull(db, c1), USER))(),
    (err) => err.dependents.some((d) => d.id === r1),
  );
  saveProp(db, 1, 'C St');
  db.transaction(() => restoreCommit(db, getCommitFull(db, c1), USER))();
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, 'B St');
});

test('merge commits: generic undo/restore refuse, merge-revert commits display only', () => {
  const db = makeDb();
  db.prepare("INSERT INTO plan_projects (id, name) VALUES (1, 'P')").run();
  db.prepare("INSERT INTO plan_strategies (id, project_id, name, merged) VALUES (1, 1, 'S', 1)").run();
  const snap = snapshotByAggregate(db, 'project', 1);
  const cMerge = commit(db, {
    module: 'planning', entityType: 'project', entityId: 1, projectId: 1, strategyId: 1,
    kind: 'merge', summary: 'Merged strategy S → mainline',
    event: [], snapshot: snap,
  });
  assert.throws(
    () => undoCommit(db, getCommitFull(db, cMerge), USER),
    (err) => err.code === 'merge',
  );
  assert.throws(
    () => restoreCommit(db, getCommitFull(db, cMerge), USER),
    (err) => err.code === 'merge',
  );
  const cRevert = commit(db, {
    module: 'planning', entityType: 'project', entityId: 1, projectId: 1, strategyId: 1,
    kind: 'merge-revert', summary: 'Reverted merge · S',
    event: [], snapshot: snap,
  });
  assert.throws(
    () => undoCommit(db, getCommitFull(db, cRevert), USER),
    (err) => err.code === 'merge-revert',
  );
  assert.throws(
    () => restoreCommit(db, getCommitFull(db, cRevert), USER),
    (err) => err.code === 'merge',
  );
});

test('merged-flag guard: project restore refuses when a strategy merged since', () => {
  const db = makeDb();
  db.prepare("INSERT INTO plan_projects (id, name) VALUES (1, 'P')").run();
  db.prepare("INSERT INTO plan_strategies (id, project_id, name, merged) VALUES (1, 1, 'S', 0)").run();
  const before = snapshotByAggregate(db, 'project', 1);
  db.prepare("UPDATE plan_strategies SET name = 'S2' WHERE id = 1").run();
  const c1 = commit(db, {
    module: 'planning', entityType: 'project', entityId: 1, projectId: 1, strategyId: 1,
    summary: 'Updated strategy S2 · P', before, snapshot: snapshotByAggregate(db, 'project', 1),
  });
  db.prepare('UPDATE plan_strategies SET merged = 1 WHERE id = 1').run();
  assert.throws(
    () => db.transaction(() => restoreCommit(db, getCommitFull(db, c1), USER))(),
    (err) => err.code === 'merged-flag',
  );
});

test('bulk Apply = 1 commit: many rows, one commit row, full event', () => {
  const db = makeDb();
  db.prepare("INSERT INTO invest_accounts (id, name) VALUES (1, 'TFSA')").run();
  const before = snapshotByAggregate(db, 'account', 1);
  db.transaction(() => {
    for (let i = 0; i < 3; i++) {
      const h = db.prepare('INSERT INTO invest_holdings (account_id, symbol) VALUES (1, ?)').run(`SYM${i}`);
      for (let j = 0; j < 5; j++) {
        db.prepare('INSERT INTO invest_events (holding_id, date, type, units) VALUES (?, ?, ?, ?)').run(h.lastInsertRowid, '2026-01-01', 'buy', 10);
      }
    }
    recordCommit(db, {
      userId: USER.id, username: USER.username, module: 'stocks',
      entityType: 'account', entityId: 1, entityLabel: 'TFSA',
      summary: 'Imported CSV · TFSA (15 events)', before, snapshot: snapshotByAggregate(db, 'account', 1),
    });
  })();
  const { commits, total } = listCommits(db, { module: 'stocks', q: null, projectId: null, limit: 50, offset: 0 });
  assert.equal(total, 1);
  assert.equal(commits[0].eventCount, 3 + 15);
  const full = getCommitFull(db, commits[0].id);
  assert.equal(full.event.filter((e) => e.table === 'invest_holdings').length, 3);
  assert.equal(full.event.filter((e) => e.table === 'invest_events').length, 15);
});

test('spending-global: category apply undoes rows + mappings together', () => {
  const db = makeDb();
  db.prepare("INSERT INTO spend_cards (id, name) VALUES (1, 'CIBC')").run();
  db.prepare("INSERT INTO spend_transactions (id, card_id, merchant, category, amount) VALUES (1, 1, 'Loblaws', NULL, -50)").run();
  db.prepare("INSERT INTO spend_transactions (id, card_id, merchant, category, amount) VALUES (2, 1, 'Loblaws', NULL, -30)").run();
  const extra = { txIds: [1, 2], userId: USER.id };
  const before = snapshotByAggregate(db, 'spending-global', null, extra);
  db.transaction(() => {
    db.prepare("UPDATE spend_transactions SET category = 'Groceries' WHERE id IN (1, 2)").run();
    db.prepare('INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(USER.id, 'spend_merchant_categories', '{"loblaws":"Groceries"}', 't');
    recordCommit(db, {
      userId: USER.id, username: USER.username, module: 'spending',
      entityType: 'spending-global', entityId: null, entityLabel: 'All cards',
      summary: 'Applied category analysis (2 transactions)',
      before, snapshot: snapshotByAggregate(db, 'spending-global', null, extra),
    });
  })();
  const c = listCommits(db, { module: 'spending', q: null, projectId: null, limit: 50, offset: 0 }).commits[0];
  db.transaction(() => undoCommit(db, getCommitFull(db, c.id), USER))();
  assert.equal(db.prepare('SELECT category FROM spend_transactions WHERE id = 1').get().category, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = ?').get(USER.id).n, 0);
});

test('diff ignores updated_at and ai_thread', () => {
  const db = makeDb();
  db.prepare("INSERT INTO plan_projects (id, name) VALUES (1, 'P')").run();
  db.prepare("INSERT INTO plan_strategies (id, project_id, name, merged, ai_thread) VALUES (1, 1, 'S', 0, '[]')").run();
  const before = snapshotByAggregate(db, 'project', 1);
  db.prepare("UPDATE plan_strategies SET updated_at = 't2', ai_thread = '[{\"role\":\"user\"}]' WHERE id = 1").run();
  const id = commit(db, {
    module: 'planning', entityType: 'project', entityId: 1, projectId: 1,
    summary: 'thread-only', before, snapshot: snapshotByAggregate(db, 'project', 1),
  });
  assert.equal(getCommitFull(db, id).event.length, 0);
});

test('findDependents is scoped to exact rows, not the whole aggregate', () => {
  const db = makeDb();
  db.prepare("INSERT INTO invest_accounts (id, name) VALUES (1, 'A')").run();
  db.prepare("INSERT INTO invest_holdings (id, account_id, symbol) VALUES (1, 1, 'X'), (2, 1, 'Y')").run();
  const before = snapshotByAggregate(db, 'account', 1);
  db.prepare("UPDATE invest_holdings SET symbol = 'X2' WHERE id = 1").run();
  const c1 = commit(db, {
    module: 'stocks', entityType: 'account', entityId: 1, entityLabel: 'A',
    summary: 'Updated holding X2 · A', before, snapshot: snapshotByAggregate(db, 'account', 1),
  });
  const before2 = snapshotByAggregate(db, 'account', 1);
  db.prepare("UPDATE invest_holdings SET symbol = 'Y2' WHERE id = 2").run();
  commit(db, {
    module: 'stocks', entityType: 'account', entityId: 1, entityLabel: 'A',
    summary: 'Updated holding Y2 · A', before: before2, snapshot: snapshotByAggregate(db, 'account', 1),
  });
  // The Y-holding commit does not depend on the X-holding commit.
  assert.equal(findDependents(db, getCommitFull(db, c1)).length, 0);
  assert.equal(restoreSnapshot !== undefined, true);
});
