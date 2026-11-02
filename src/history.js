// App-global History: every user Apply/Save is one commit (event +
// snapshot), revert is append-only. This module owns the commit model;
// server.js calls recordCommit() from each save/apply endpoint inside
// the same DB transaction as the write, so a write and its commit row
// land together or not at all.
//
// Event = touched rows before→after (the diff view + undo). Snapshot =
// the touched aggregate's FULL post-commit state (restore-to). Undo
// applies the inverse of the event; restore-to writes back the
// snapshot. Neither ever rewrites history: both create a new commit.
//
// Volatile columns are ignored by the diff (a save that only touches
// updated_at is not a change) and ai_thread is never snapshotted
// (conversation state, not plan data) — restore preserves the current
// thread because restore only writes columns present in the snapshot.
const VOLATILE_KEYS = new Set(['updated_at', 'ai_thread']);

const ALLOWED_TABLES = new Set([
  'plan_projects', 'plan_strategies', 'plan_ops', 'plan_legs',
  'plan_assumptions', 'plan_baselines', 'plan_reports',
  'plan_declared_assets', 'plan_ai_models',
  'properties', 'mortgage_terms', 'rate_segments', 'lump_sums',
  'property_costs', 'value_history',
  'invest_accounts', 'invest_holdings', 'invest_events', 'invest_prices',
  'invest_plans', 'invest_plan_deleted',
  'earn_jobs', 'earn_pay_changes', 'earn_bonuses',
  'earn_rentals', 'earn_rental_years', 'earn_rental_entries',
  'spend_cards', 'spend_transactions',
  'other_assets',
  'user_preferences',
]);

const COL_RE = /^[A-Za-z0-9_]+$/;
function qcol(c) {
  if (!COL_RE.test(c)) throw new Error(`bad column ${c}`);
  return `"${c}"`;
}
function qtable(t) {
  if (!ALLOWED_TABLES.has(t)) throw new Error(`bad table ${t}`);
  return `"${t}"`;
}

function stripVolatile(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!VOLATILE_KEYS.has(k)) out[k] = v;
  return out;
}
function sameRow(a, b) {
  return JSON.stringify(stripVolatile(a)) === JSON.stringify(stripVolatile(b));
}
function pkOf(row) {
  if (row == null) return null;
  if (row.id !== undefined && row.id !== null) return { id: row.id };
  if (row.user_id !== undefined && row.key !== undefined) return { user_id: row.user_id, key: row.key };
  return null;
}
function pkWhere(pk) {
  const cols = Object.keys(pk);
  return { sql: cols.map((c) => `${qcol(c)} = ?`).join(' AND '), vals: cols.map((c) => pk[c]) };
}
function readRow(db, table, pk) {
  const w = pkWhere(pk);
  return db.prepare(`SELECT * FROM ${qtable(table)} WHERE ${w.sql}`).get(...w.vals) || null;
}
export { readRow };

// ------------------------------------------------------------ snapshots --
// Each builder returns an envelope { aggregate, tables: {name: rows} }.
// Missing root rows yield empty tables (creates record before/after
// states, deletes record after-states) — never a throw.
function rows(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}
function snapProject(db, projectId) {
  const strategies = rows(db, 'SELECT * FROM plan_strategies WHERE project_id = ? ORDER BY id', projectId);
  const sids = strategies.map((s) => s.id);
  const ops = sids.length
    ? rows(db, `SELECT * FROM plan_ops WHERE strategy_id IN (${sids.map(() => '?').join(',')}) ORDER BY id`, ...sids) : [];
  const oids = ops.map((o) => o.id);
  const legs = oids.length
    ? rows(db, `SELECT * FROM plan_legs WHERE op_id IN (${oids.map(() => '?').join(',')}) ORDER BY id`, ...oids) : [];
  const assumptions = sids.length
    ? rows(db, `SELECT * FROM plan_assumptions WHERE strategy_id IN (${sids.map(() => '?').join(',')}) ORDER BY id`, ...sids) : [];
  return {
    aggregate: 'project',
    tables: {
      plan_projects: rows(db, 'SELECT * FROM plan_projects WHERE id = ?', projectId),
      plan_strategies: strategies.map((s) => { const { ai_thread, ...rest } = s; return rest; }),
      plan_ops: ops,
      plan_legs: legs,
      plan_assumptions: assumptions,
      plan_baselines: rows(db, 'SELECT * FROM plan_baselines WHERE project_id = ? ORDER BY id', projectId),
      plan_reports: rows(db, 'SELECT * FROM plan_reports WHERE project_id = ? ORDER BY id', projectId),
      plan_declared_assets: rows(db, 'SELECT * FROM plan_declared_assets WHERE project_id = ? ORDER BY id', projectId),
      plan_ai_models: rows(db, 'SELECT * FROM plan_ai_models WHERE project_id = ? ORDER BY id', projectId),
    },
  };
}
function snapProperty(db, propertyId) {
  return {
    aggregate: 'property',
    tables: {
      properties: rows(db, 'SELECT * FROM properties WHERE id = ?', propertyId),
      mortgage_terms: rows(db, 'SELECT * FROM mortgage_terms WHERE property_id = ? ORDER BY id', propertyId),
      rate_segments: rows(db, 'SELECT * FROM rate_segments WHERE property_id = ? ORDER BY id', propertyId),
      lump_sums: rows(db, 'SELECT * FROM lump_sums WHERE property_id = ? ORDER BY id', propertyId),
      property_costs: rows(db, 'SELECT * FROM property_costs WHERE property_id = ? ORDER BY id', propertyId),
      value_history: rows(db, 'SELECT * FROM value_history WHERE property_id = ? ORDER BY id', propertyId),
    },
    // Rentals linked to this property: a property delete SET NULLs
    // these, so the snapshot carries the links for re-linking on
    // restore (only rentals still unlinked are re-linked).
    rentalLinks: rows(db, 'SELECT id, property_id FROM earn_rentals WHERE property_id = ?', propertyId),
  };
}
function snapAccount(db, accountId) {
  const holdings = rows(db, 'SELECT * FROM invest_holdings WHERE account_id = ? ORDER BY id', accountId);
  const hids = holdings.map((h) => h.id);
  const plans = rows(db, 'SELECT * FROM invest_plans WHERE account_id = ? ORDER BY id', accountId);
  const pids = plans.map((p) => p.id);
  return {
    aggregate: 'account',
    tables: {
      invest_accounts: rows(db, 'SELECT * FROM invest_accounts WHERE id = ?', accountId),
      invest_holdings: holdings,
      invest_events: hids.length
        ? rows(db, `SELECT * FROM invest_events WHERE holding_id IN (${hids.map(() => '?').join(',')}) ORDER BY id`, ...hids) : [],
      // Price points that belong to the account's state: the user's
      // manual NAV snapshots and the event-derived points (rebuilt
      // from events on every event write). Fetched closes (stooq /
      // yahoo / nasdaq) are market data, not user state — they are
      // left alone by snapshots and refetch on read if lost.
      invest_prices: hids.length
        ? rows(db, `SELECT * FROM invest_prices WHERE holding_id IN (${hids.map(() => '?').join(',')}) AND source IN ('manual', 'event') ORDER BY id`, ...hids) : [],
      invest_plans: plans,
      invest_plan_deleted: pids.length
        ? rows(db, `SELECT * FROM invest_plan_deleted WHERE plan_id IN (${pids.map(() => '?').join(',')}) ORDER BY plan_id, due_date`, ...pids) : [],
    },
  };
}
function snapJob(db, jobId) {
  return {
    aggregate: 'job',
    tables: {
      earn_jobs: rows(db, 'SELECT * FROM earn_jobs WHERE id = ?', jobId),
      earn_pay_changes: rows(db, 'SELECT * FROM earn_pay_changes WHERE job_id = ? ORDER BY id', jobId),
      earn_bonuses: rows(db, 'SELECT * FROM earn_bonuses WHERE job_id = ? ORDER BY id', jobId),
    },
  };
}
function snapRental(db, rentalId) {
  return {
    aggregate: 'rental',
    tables: {
      earn_rentals: rows(db, 'SELECT * FROM earn_rentals WHERE id = ?', rentalId),
      earn_rental_years: rows(db, 'SELECT * FROM earn_rental_years WHERE rental_id = ? ORDER BY id', rentalId),
      earn_rental_entries: rows(db, 'SELECT * FROM earn_rental_entries WHERE rental_id = ? ORDER BY id', rentalId),
    },
  };
}
function snapCard(db, cardId) {
  return {
    aggregate: 'card',
    tables: {
      spend_cards: rows(db, 'SELECT * FROM spend_cards WHERE id = ?', cardId),
      spend_transactions: rows(db, 'SELECT * FROM spend_transactions WHERE card_id = ? ORDER BY id', cardId),
    },
  };
}
// Spending-global (AI category analysis): the touched aggregate is the
// set of transactions the apply actually updated, plus the merchant
// mappings preference it wrote.
function snapSpendingGlobal(db, txIds, userId) {
  const txs = txIds.length
    ? rows(db, `SELECT * FROM spend_transactions WHERE id IN (${txIds.map(() => '?').join(',')}) ORDER BY id`, ...txIds) : [];
  const pref = db.prepare('SELECT user_id, key, value FROM user_preferences WHERE user_id = ? AND key = ?').get(userId, 'spend_merchant_categories') || null;
  return { aggregate: 'spending-global', tables: { spend_transactions: txs }, pref };
}
function snapOtherAsset(db, assetId) {
  return {
    aggregate: 'other-asset',
    tables: { other_assets: rows(db, 'SELECT * FROM other_assets WHERE id = ?', assetId) },
  };
}
export function snapshotByAggregate(db, aggregate, entityId, extra) {
  switch (aggregate) {
    case 'project': return snapProject(db, entityId);
    case 'property': return snapProperty(db, entityId);
    case 'account': return snapAccount(db, entityId);
    case 'job': return snapJob(db, entityId);
    case 'rental': return snapRental(db, entityId);
    case 'card': return snapCard(db, entityId);
    case 'spending-global': return snapSpendingGlobal(db, (extra && extra.txIds) || [], (extra && extra.userId) || null);
    case 'other-asset': return snapOtherAsset(db, entityId);
    default: throw new Error(`unknown aggregate ${aggregate}`);
  }
}
export function emptySnapshot(aggregate) {
  return { aggregate, tables: {} };
}

// ------------------------------------------------------------------ diff --
// Event entries: { table, pk, before, after } — before/after are full
// rows (or null for creates/deletes), except the rental-link and
// preference pseudo-rows, which carry partial rows on purpose: undo
// updates exactly the listed columns, leaving the rest untouched.
export function diffSnapshots(before, after) {
  const event = [];
  const tables = new Set([...Object.keys(before.tables || {}), ...Object.keys(after.tables || {})]);
  for (const table of tables) {
    const bMap = new Map((before.tables[table] || []).map((r) => [String(r.id), r]));
    const aMap = new Map((after.tables[table] || []).map((r) => [String(r.id), r]));
    for (const [id, aRow] of aMap) {
      const bRow = bMap.get(id);
      if (!bRow) event.push({ table, pk: { id: aRow.id }, before: null, after: aRow });
      else if (!sameRow(bRow, aRow)) event.push({ table, pk: { id: aRow.id }, before: bRow, after: aRow });
    }
    for (const [id, bRow] of bMap) {
      if (!aMap.has(id)) event.push({ table, pk: { id: bRow.id }, before: bRow, after: null });
    }
  }
  // Property → rental links (SET NULL on property delete).
  const bLinks = new Map((before.rentalLinks || []).map((l) => [l.id, l.property_id]));
  const aLinks = new Map((after.rentalLinks || []).map((l) => [l.id, l.property_id]));
  const linkIds = new Set([...bLinks.keys(), ...aLinks.keys()]);
  for (const id of linkIds) {
    if (bLinks.get(id) !== aLinks.get(id)) {
      event.push({
        table: 'earn_rentals', pk: { id },
        before: bLinks.has(id) ? { id, property_id: bLinks.get(id) } : null,
        after: aLinks.has(id) ? { id, property_id: aLinks.get(id) } : null,
      });
    }
  }
  // Spending-global mappings preference.
  const bPref = before.pref ? before.pref.value : null;
  const aPref = after.pref ? after.pref.value : null;
  if (bPref !== aPref) {
    const userId = (after.pref || before.pref).user_id;
    event.push({
      table: 'user_preferences', pk: { user_id: userId, key: 'spend_merchant_categories' },
      before: before.pref ? { user_id: userId, key: 'spend_merchant_categories', value: before.pref.value } : null,
      after: after.pref ? { user_id: userId, key: 'spend_merchant_categories', value: after.pref.value } : null,
    });
  }
  return event;
}

// Build an event from explicit before/after row states (merge +
// merge-revert commits, whose rows are read around the apply).
export function eventFromRowStates(states) {
  const event = [];
  for (const s of states) {
    if (s.before == null && s.after == null) continue;
    if (s.before == null || s.after == null || !sameRow(s.before, s.after)) {
      event.push({ table: s.table, pk: s.pk, before: s.before, after: s.after });
    }
  }
  return event;
}

// Convert planApplyWrites entries (merge) to event entries. Insert
// rows are re-read so the event carries full rows, not just values.
export function mergeEventFromEntries(db, entries) {
  const event = [];
  for (const e of entries) {
    if (e.kind === 'insert') {
      const row = readRow(db, e.table, { id: e.rowId });
      event.push({ table: e.table, pk: { id: e.rowId }, before: null, after: row });
    } else if (e.kind === 'update') {
      event.push({ table: e.table, pk: { id: e.rowId }, before: e.before || null, after: e.after || null });
    } else if (e.kind === 'delete') {
      event.push({ table: e.table, pk: { id: e.rowId }, before: e.before || null, after: null });
    }
  }
  return event;
}

// ---------------------------------------------------------------- record --
// Callers pass before + snapshot and the event is diffed; merge and
// merge-revert pass a prebuilt event instead (their rows are read
// around the apply, not from snapshots).
export function recordCommit(db, meta) {
  const event = meta.event || diffSnapshots(meta.before, meta.snapshot);
  const info = db.prepare(
    `INSERT INTO app_commits (user_id, username, module, entity_type, entity_id, entity_label,
       project_id, strategy_id, merge_record_id, kind, summary, event, snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    meta.userId, meta.username || null, meta.module, meta.entityType,
    meta.entityId == null ? null : meta.entityId, meta.entityLabel || null,
    meta.projectId == null ? null : meta.projectId,
    meta.strategyId == null ? null : meta.strategyId,
    meta.mergeRecordId == null ? null : meta.mergeRecordId,
    meta.kind || 'commit', meta.summary,
    JSON.stringify(event), JSON.stringify(meta.snapshot), meta.createdAt || new Date().toISOString(),
  );
  return info.lastInsertRowid;
}

export function commitListRow(row) {
  let eventCount = 0;
  try { eventCount = (JSON.parse(row.event || '[]') || []).length; } catch { /* keep 0 */ }
  const { event, snapshot, ...rest } = row;
  return { ...rest, eventCount };
}
export function listCommits(db, { module, q, projectId, limit, offset }) {
  const conds = [];
  const vals = [];
  if (module) { conds.push('module = ?'); vals.push(module); }
  if (projectId != null) { conds.push('project_id = ?'); vals.push(projectId); }
  if (q) { conds.push('(entity_label LIKE ? OR summary LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM app_commits ${where}`).get(...vals).n;
  const rows = db.prepare(
    `SELECT * FROM app_commits ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset);
  return { commits: rows.map(commitListRow), total };
}
export function getCommit(db, id) {
  const row = db.prepare('SELECT * FROM app_commits WHERE id = ?').get(id);
  if (!row) return null;
  let event = [];
  try { event = JSON.parse(row.event || '[]'); } catch { /* keep [] */ }
  const { snapshot, ...rest } = row;
  return { ...rest, event };
}
export function getCommitFull(db, id) {
  const row = db.prepare('SELECT * FROM app_commits WHERE id = ?').get(id);
  if (!row) return null;
  let event = [];
  let snapshot = null;
  try { event = JSON.parse(row.event || '[]'); } catch { /* keep [] */ }
  try { snapshot = JSON.parse(row.snapshot || 'null'); } catch { /* keep null */ }
  return { ...row, event, snapshot };
}

// ------------------------------------------------------------------ undo --
// Inverse of one event entry, with guards: undo never clobbers a row
// that moved since the commit (that is what the dependency check is
// for, plus this last-line guard for system writes, which carry no
// commit). Runs inside the caller's transaction — a throw rolls the
// whole undo back.
function guardRowMatches(db, table, pk, expected, label) {
  if (expected == null) return;
  const cur = readRow(db, table, pk);
  if (!cur) throw new Error(`${label}: row ${table} ${JSON.stringify(pk)} is gone`);
  for (const [k, v] of Object.entries(expected)) {
    if (VOLATILE_KEYS.has(k) || (pk && Object.prototype.hasOwnProperty.call(pk, k))) continue;
    if (JSON.stringify(cur[k]) !== JSON.stringify(v)) {
      throw new Error(`${label}: row ${table} ${JSON.stringify(pk)} changed since the commit`);
    }
  }
}
export function applyEventInverse(db, event) {
  for (const e of [...event].reverse()) {
    const w = pkWhere(e.pk);
    if (e.before == null && e.after != null) {
      // Was created by the commit: delete it (only if unchanged).
      guardRowMatches(db, e.table, e.pk, e.after, 'undo');
      db.prepare(`DELETE FROM ${qtable(e.table)} WHERE ${w.sql}`).run(...w.vals);
    } else if (e.before != null && e.after == null) {
      // Was deleted by the commit: re-insert it.
      const cur = readRow(db, e.table, e.pk);
      if (cur) throw new Error(`undo: row ${e.table} ${JSON.stringify(e.pk)} already exists`);
      const cols = Object.keys(e.before).filter((c) => COL_RE.test(c));
      db.prepare(`INSERT INTO ${qtable(e.table)} (${cols.map(qcol).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => e.before[c]));
    } else if (e.before != null && e.after != null) {
      // Was updated: restore the before columns (exactly the columns
      // the event carries — partial rows touch only those columns).
      guardRowMatches(db, e.table, e.pk, e.after, 'undo');
      const cols = Object.keys(e.before).filter((c) => !(e.pk && Object.prototype.hasOwnProperty.call(e.pk, c)) && COL_RE.test(c));
      if (!cols.length) continue;
      db.prepare(`UPDATE ${qtable(e.table)} SET ${cols.map((c) => `${qcol(c)} = ?`).join(', ')} WHERE ${w.sql}`)
        .run(...cols.map((c) => e.before[c]), ...w.vals);
    }
  }
}

// Later commits whose events touch any row this commit touched, by
// table + primary key. Those are the dependencies that block undo.
export function findDependents(db, commit) {
  const keys = new Set((commit.event || []).map((e) => `${e.table}:${JSON.stringify(e.pk)}`));
  if (!keys.size) return [];
  const later = db.prepare('SELECT * FROM app_commits WHERE id > ? ORDER BY id DESC').all(commit.id);
  const out = [];
  for (const row of later) {
    let ev = [];
    try { ev = JSON.parse(row.event || '[]'); } catch { /* skip */ }
    if (ev.some((e) => keys.has(`${e.table}:${JSON.stringify(e.pk)}`))) {
      out.push({ id: row.id, kind: row.kind, module: row.module, entityLabel: row.entity_label, summary: row.summary, created_at: row.created_at });
    }
  }
  return out;
}

// --------------------------------------------------------------- restore --
// Upsert one snapshot row: existing rows update exactly the snapshot's
// columns (columns absent from the snapshot — e.g. ai_thread — are
// preserved); missing rows insert whole.
function upsertRow(db, table, row) {
  const pk = pkOf(row);
  if (!pk) throw new Error(`restore: row in ${table} has no primary key`);
  const cur = readRow(db, table, pk);
  const cols = Object.keys(row).filter((c) => COL_RE.test(c));
  if (cur) {
    const sets = cols.filter((c) => !Object.prototype.hasOwnProperty.call(pk, c));
    if (sets.length) {
      const w = pkWhere(pk);
      db.prepare(`UPDATE ${qtable(table)} SET ${sets.map((c) => `${qcol(c)} = ?`).join(', ')} WHERE ${w.sql}`)
        .run(...sets.map((c) => row[c]), ...w.vals);
    }
  } else {
    db.prepare(`INSERT INTO ${qtable(table)} (${cols.map(qcol).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => row[c]));
  }
}
export function restoreSnapshot(db, snapshot) {
  const t = snapshot.tables || {};
  const one = (name) => (t[name] || []).slice();
  // Root id: from the snapshot's root row, or from _entityId when the
  // snapshot is empty (restore-to of a delete commit — the target
  // state has no root row, so the root row itself must be deleted).
  const root = (table) => (t[table] || [])[0];
  const scoped = (table, id, fn) => { if (id != null) fn(id); };
  switch (snapshot.aggregate) {
    case 'project': {
      const id = root('plan_projects')?.id ?? snapshot._entityId;
      scoped('plan_projects', id, (pid) => {
        db.prepare('DELETE FROM plan_legs WHERE op_id IN (SELECT id FROM plan_ops WHERE strategy_id IN (SELECT id FROM plan_strategies WHERE project_id = ?))').run(pid);
        db.prepare('DELETE FROM plan_ops WHERE strategy_id IN (SELECT id FROM plan_strategies WHERE project_id = ?)').run(pid);
        db.prepare('DELETE FROM plan_assumptions WHERE strategy_id IN (SELECT id FROM plan_strategies WHERE project_id = ?)').run(pid);
        for (const tbl of ['plan_baselines', 'plan_reports', 'plan_declared_assets', 'plan_ai_models']) {
          db.prepare(`DELETE FROM ${qtable(tbl)} WHERE project_id = ?`).run(pid);
        }
        db.prepare('DELETE FROM plan_strategies WHERE project_id = ?').run(pid);
        if (!one('plan_projects').length) db.prepare('DELETE FROM plan_projects WHERE id = ?').run(pid);
      });
      for (const r of one('plan_projects')) upsertRow(db, 'plan_projects', r);
      for (const r of one('plan_strategies')) upsertRow(db, 'plan_strategies', r);
      for (const r of one('plan_ops')) upsertRow(db, 'plan_ops', r);
      for (const r of one('plan_legs')) upsertRow(db, 'plan_legs', r);
      for (const r of one('plan_assumptions')) upsertRow(db, 'plan_assumptions', r);
      for (const r of one('plan_baselines')) upsertRow(db, 'plan_baselines', r);
      for (const r of one('plan_reports')) upsertRow(db, 'plan_reports', r);
      for (const r of one('plan_declared_assets')) upsertRow(db, 'plan_declared_assets', r);
      for (const r of one('plan_ai_models')) upsertRow(db, 'plan_ai_models', r);
      break;
    }
    case 'property': {
      const id = root('properties')?.id ?? snapshot._entityId;
      scoped('properties', id, (pid) => {
        for (const tbl of ['lump_sums', 'rate_segments', 'mortgage_terms', 'property_costs', 'value_history']) {
          db.prepare(`DELETE FROM ${qtable(tbl)} WHERE property_id = ?`).run(pid);
        }
        if (!one('properties').length) db.prepare('DELETE FROM properties WHERE id = ?').run(pid);
      });
      for (const r of one('properties')) upsertRow(db, 'properties', r);
      for (const r of one('mortgage_terms')) upsertRow(db, 'mortgage_terms', r);
      for (const r of one('rate_segments')) upsertRow(db, 'rate_segments', r);
      for (const r of one('lump_sums')) upsertRow(db, 'lump_sums', r);
      for (const r of one('property_costs')) upsertRow(db, 'property_costs', r);
      for (const r of one('value_history')) upsertRow(db, 'value_history', r);
      // Re-link rentals that are still unlinked (never steal one
      // that was re-linked elsewhere since).
      for (const l of snapshot.rentalLinks || []) {
        db.prepare('UPDATE earn_rentals SET property_id = ? WHERE id = ? AND property_id IS NULL').run(l.property_id, l.id);
      }
      break;
    }
    case 'account': {
      const id = root('invest_accounts')?.id ?? snapshot._entityId;
      scoped('invest_accounts', id, (aid) => {
        const planIds = rows(db, 'SELECT id FROM invest_plans WHERE account_id = ?', aid).map((r) => r.id);
        if (planIds.length) db.prepare(`DELETE FROM invest_plan_deleted WHERE plan_id IN (${planIds.map(() => '?').join(',')})`).run(...planIds);
        db.prepare('DELETE FROM invest_plans WHERE account_id = ?').run(aid);
        // Holdings on the account but absent from the snapshot
        // (added later) go too, or restore would keep them
        // alongside the snapshot's set; their events/prices die by
        // cascade. Snapshot holdings keep their fetched closes:
        // only manual + event points are cleared, then re-inserted.
        const hids = one('invest_holdings').map((h) => h.id);
        if (hids.length) {
          db.prepare(`DELETE FROM invest_prices WHERE holding_id IN (${hids.map(() => '?').join(',')}) AND source IN ('manual', 'event')`).run(...hids);
          db.prepare(`DELETE FROM invest_events WHERE holding_id IN (${hids.map(() => '?').join(',')})`).run(...hids);
        }
        db.prepare('DELETE FROM invest_holdings WHERE account_id = ?').run(aid);
        if (!one('invest_accounts').length) db.prepare('DELETE FROM invest_accounts WHERE id = ?').run(aid);
      });
      for (const r of one('invest_accounts')) upsertRow(db, 'invest_accounts', r);
      for (const r of one('invest_holdings')) upsertRow(db, 'invest_holdings', r);
      for (const r of one('invest_events')) upsertRow(db, 'invest_events', r);
      for (const r of one('invest_prices')) upsertRow(db, 'invest_prices', r);
      for (const r of one('invest_plans')) upsertRow(db, 'invest_plans', r);
      for (const r of one('invest_plan_deleted')) upsertRow(db, 'invest_plan_deleted', r);
      break;
    }
    case 'job': {
      const id = root('earn_jobs')?.id ?? snapshot._entityId;
      scoped('earn_jobs', id, (jid) => {
        db.prepare('DELETE FROM earn_pay_changes WHERE job_id = ?').run(jid);
        db.prepare('DELETE FROM earn_bonuses WHERE job_id = ?').run(jid);
        if (!one('earn_jobs').length) db.prepare('DELETE FROM earn_jobs WHERE id = ?').run(jid);
      });
      for (const r of one('earn_jobs')) upsertRow(db, 'earn_jobs', r);
      for (const r of one('earn_pay_changes')) upsertRow(db, 'earn_pay_changes', r);
      for (const r of one('earn_bonuses')) upsertRow(db, 'earn_bonuses', r);
      break;
    }
    case 'rental': {
      const id = root('earn_rentals')?.id ?? snapshot._entityId;
      scoped('earn_rentals', id, (rid) => {
        db.prepare('DELETE FROM earn_rental_years WHERE rental_id = ?').run(rid);
        db.prepare('DELETE FROM earn_rental_entries WHERE rental_id = ?').run(rid);
        if (!one('earn_rentals').length) db.prepare('DELETE FROM earn_rentals WHERE id = ?').run(rid);
      });
      for (const r of one('earn_rentals')) upsertRow(db, 'earn_rentals', r);
      for (const r of one('earn_rental_years')) upsertRow(db, 'earn_rental_years', r);
      for (const r of one('earn_rental_entries')) upsertRow(db, 'earn_rental_entries', r);
      break;
    }
    case 'card': {
      const id = root('spend_cards')?.id ?? snapshot._entityId;
      scoped('spend_cards', id, (cid) => {
        db.prepare('DELETE FROM spend_transactions WHERE card_id = ?').run(cid);
        if (!one('spend_cards').length) db.prepare('DELETE FROM spend_cards WHERE id = ?').run(cid);
      });
      for (const r of one('spend_cards')) upsertRow(db, 'spend_cards', r);
      for (const r of one('spend_transactions')) upsertRow(db, 'spend_transactions', r);
      break;
    }
    case 'other-asset': {
      const id = root('other_assets')?.id ?? snapshot._entityId;
      if (one('other_assets').length) {
        for (const r of one('other_assets')) upsertRow(db, 'other_assets', r);
      } else if (id != null) {
        db.prepare('DELETE FROM other_assets WHERE id = ?').run(id);
      }
      break;
    }
    case 'spending-global': {
      // Partial aggregate by design: only the touched rows (and the
      // mappings preference) are restored; rows deleted since are
      // left deleted, never resurrected.
      for (const r of one('spend_transactions')) {
        const cur = readRow(db, 'spend_transactions', { id: r.id });
        if (cur) upsertRow(db, 'spend_transactions', r);
      }
      if (snapshot.pref) {
        db.prepare(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(snapshot.pref.user_id, snapshot.pref.key, snapshot.pref.value, new Date().toISOString());
      }
      break;
    }
    default: throw new Error(`unknown aggregate ${snapshot.aggregate}`);
  }
}

// ------------------------------------------------------- undo / restore --
// Both run inside the caller's transaction and record a new 'revert'
// commit describing the state they leave behind. Throws Error with
// .dependents (undo blocked) or .code ('merge' | 'merge-revert' |
// 'merged-flag') for cases the caller routes elsewhere.
function revertRecord(db, user, commit, before, after, summary) {
  return recordCommit(db, {
    userId: user.id, username: user.username, module: commit.module,
    entityType: commit.entity_type, entityId: commit.entity_id,
    entityLabel: commit.entity_label, projectId: commit.project_id,
    strategyId: commit.strategy_id, kind: 'revert', summary,
    before, snapshot: after,
  });
}
export function undoCommit(db, commit, user) {
  if (commit.kind === 'merge') {
    const err = new Error('merge commits revert through the merge flow');
    err.code = 'merge';
    throw err;
  }
  if (commit.kind === 'merge-revert') {
    const err = new Error('a merge revert cannot be undone from History');
    err.code = 'merge-revert';
    throw err;
  }
  const dependents = findDependents(db, commit);
  if (dependents.length) {
    const err = new Error('later commits depend on this commit');
    err.dependents = dependents;
    throw err;
  }
  const snapshot = commit.snapshot;
  const extra = snapshot.aggregate === 'spending-global'
    ? { txIds: (snapshot.tables.spend_transactions || []).map((r) => r.id), userId: user.id }
    : undefined;
  const before = snapshotByAggregate(db, snapshot.aggregate, commit.entity_id, extra);
  applyEventInverse(db, commit.event);
  const after = snapshotByAggregate(db, snapshot.aggregate, commit.entity_id, extra);
  return revertRecord(db, user, commit, before, after, `Reverted commit #${commit.id}`);
}
export function restoreCommit(db, commit, user) {
  if (commit.kind === 'merge' || commit.kind === 'merge-revert') {
    const err = new Error('merge commits cannot be restored to — revert the merge instead');
    err.code = 'merge';
    throw err;
  }
  const snapshot = commit.snapshot;
  if (snapshot.aggregate === 'project') {
    // Planning state and mainline are linked through merged flags: a
    // restore that flips one without the other would desync them.
    const current = snapshotByAggregate(db, 'project', commit.entity_id);
    const curFlags = new Map((current.tables.plan_strategies || []).map((s) => [s.id, s.merged]));
    const snapFlags = new Map((snapshot.tables.plan_strategies || []).map((s) => [s.id, s.merged]));
    for (const [id, flag] of snapFlags) {
      if (curFlags.has(id) && curFlags.get(id) !== flag) {
        const err = new Error('cannot restore: a strategy\'s merged state changed since this commit — revert the merge first');
        err.code = 'merged-flag';
        throw err;
      }
    }
  }
  const extra = snapshot.aggregate === 'spending-global'
    ? { txIds: (snapshot.tables.spend_transactions || []).map((r) => r.id), userId: user.id }
    : undefined;
  const before = snapshotByAggregate(db, snapshot.aggregate, commit.entity_id, extra);
  const snap = { ...snapshot, _entityId: commit.entity_id };
  restoreSnapshot(db, snap);
  const after = snapshotByAggregate(db, snapshot.aggregate, commit.entity_id, extra);
  return revertRecord(db, user, commit, before, after, `Restored to commit #${commit.id}`);
}
