// Data export / import (src/dataExport.js): the manual export covers
// all mainline data and nothing else — no planning tables, no
// planning-related History commits, no sessions, no sync settings, no
// secrets. Photos and avatars travel as base64. Import replaces
// exactly what the payload carries and wipes sessions. The backup
// (planning included) restores everything an import replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fm-dataexport-'));
process.env.DATA_DIR = dir;
const { db, PHOTOS_DIR, AVATARS_DIR } = await import('../src/db.js');
const {
  buildExport, validateExport, applyImport, writeBackup, listBackups, readBackup,
  MAINLINE_TABLES, PLANNING_TABLES,
} = await import('../src/dataExport.js');

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function seed() {
  const ts = '2026-11-07T00:00:00.000Z';
  db.prepare("INSERT INTO users (id, username, pass_hash, salt, avatar_file, avatar_color, created_at) VALUES (1, 'admin', 'h1', 's1', NULL, '#607d8b', ?), (2, 'Shawn', 'h2', 's2', 'user-2-test.png', '#2563eb', ?), (3, 'Jiaying', 'h3', 's3', NULL, '#db2777', ?)").run(ts, ts, ts);
  fs.writeFileSync(path.join(AVATARS_DIR, 'user-2-test.png'), PNG_1X1);
  db.prepare("INSERT INTO properties (id, address, assessed_value, assessed_year, mortgage_balance, mortgage_balance_date, purchase_date, region, owners, created_at, updated_at) VALUES (1, '1 Export Way', 1000000, 2026, 500000, '2026-11-01', '2024-12-17', 'CA', '[\"Shawn\"]', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO mortgage_terms (id, property_id, lender, start_date, term_months, amortization_years, opening_balance, created_at, updated_at) VALUES (1, 1, 'RBC', '2024-12-17', 60, 30, 600000, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO rate_segments (id, property_id, term_id, start_date, rate_type, rate_mode, spread, compounding, accrual, created_at) VALUES (1, 1, 1, '2024-12-17', 'variable', 'prime_spread', -1, 'semi_annual', 'daily', ?)").run(ts);
  db.prepare("INSERT INTO lump_sums (id, property_id, term_id, date, amount, created_at) VALUES (1, 1, 1, '2025-01-15', 10000, ?)").run(ts);
  db.prepare("INSERT INTO value_history (id, property_id, year, value, source, created_at, updated_at) VALUES (1, 1, 2026, 1000000, 'manual', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO property_costs (id, property_id, year, category, amount, basis, source, created_at, updated_at) VALUES (1, 1, 2026, 'Property tax', 5000, 'annual', 'manual', ?, ?)").run(ts, ts);
  fs.writeFileSync(path.join(PHOTOS_DIR, 'property-1-test.png'), PNG_1X1);
  db.prepare("INSERT INTO property_photos (id, property_id, file_name, sort_order, created_at) VALUES (1, 1, 'property-1-test.png', 0, ?)").run(ts);
  db.prepare("INSERT INTO prime_rates (date, rate, source) VALUES ('2026-11-01', 4.7, 'V80691311')").run();
  db.prepare("INSERT INTO invest_fx_rates (date, rate, source) VALUES ('2026-11-01', 1.41, 'FXUSDCAD')").run();
  db.prepare("INSERT INTO invest_accounts (id, name, type, owners, created_at, updated_at) VALUES (1, 'TFSA', 'TFSA', '[\"Shawn\"]', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO invest_holdings (id, account_id, label, kind, symbol, currency, created_at, updated_at) VALUES (1, 1, 'XQQ', 'exchange', 'XQQ.TO', 'CAD', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO invest_events (id, holding_id, date, type, units, price, created_at, updated_at) VALUES (1, 1, '2026-01-05', 'buy', 10, 50, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO invest_prices (id, holding_id, date, price, source, created_at) VALUES (1, 1, '2026-01-05', 50, 'event', ?)").run(ts);
  db.prepare("INSERT INTO invest_symbol_prices (symbol, date, price, currency, source, created_at) VALUES ('AMZN', '2026-10-30', 259.3, 'USD', 'yahoo', ?)").run(ts);
  db.prepare("INSERT INTO earn_jobs (id, employer, owner, currency, province, frequency, gross_amount, gross_basis, tax_year, created_at, updated_at) VALUES (1, 'Meta', 'Shawn', 'CAD', 'BC', 'biweekly', 7334.77, 'period', 2026, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO earn_pay_changes (id, job_id, effective_date, value, created_at) VALUES (1, 1, '2022-06-06', 6504.59, ?)").run(ts);
  db.prepare("INSERT INTO earn_bonuses (id, job_id, date, amount, created_at) VALUES (1, 1, '2026-03-15', 5000, ?)").run(ts);
  db.prepare("INSERT INTO invest_plans (id, account_id, job_id, target_holding_id, start_date, own_amount, created_at, updated_at) VALUES (1, 1, 1, 1, '2026-01-01', 100, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO invest_plan_deleted (plan_id, due_date, created_at) VALUES (1, '2026-02-01', ?)").run(ts);
  db.prepare("INSERT INTO earn_rentals (id, label, rental_type, created_at, updated_at) VALUES (1, 'Basement', 'long_term', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO earn_rental_years (id, rental_id, tax_year, gross_rents, created_at, updated_at) VALUES (1, 1, 2026, 12000, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO earn_rental_entries (id, rental_id, start_ym, monthly_rent, pay_day, created_at, updated_at) VALUES (1, 1, '2026-01', 1000, 15, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO spend_cards (id, name, last4, created_at, updated_at) VALUES (1, 'CIBC', '9586', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO spend_transactions (id, card_id, date, merchant, category, amount, kind, created_at) VALUES (1, 1, '2026-11-01', 'Store', 'Groceries', -50, 'charge', ?)").run(ts);
  db.prepare("INSERT INTO other_assets (id, category, name, value, currency, owners, created_at, updated_at) VALUES (1, 'other', 'Bike', 500, 'CAD', '[\"Shawn\"]', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO home_insights (id, user_id, kind, section, title, metric, payload, generated_at, created_at, updated_at) VALUES (1, 2, 'system', 'property', 'Equity', 'equity', '{}', ?, ?, ?)").run(ts, ts, ts);
  db.prepare("INSERT INTO home_insight_order (user_id, section, card_key, position, updated_at) VALUES (2, 'property', 'property|equity|Equity', 0, ?)").run(ts);
  db.prepare("INSERT INTO income_marks (user_id, kind, source_id, pay_date, received, updated_at) VALUES (2, 'salary', 1, '2026-11-06', 1, ?)").run(ts);
  db.prepare("INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (2, 'chart_colors', '{}', ?), (2, 'spend_merchant_categories', '{}', ?)").run(ts, ts);
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('ai_fill_model', 'gemini-x'), ('data_sync', '{\"enabled\":true}'), ('data_sync_state', '{\"lastHash\":\"abc\"}')").run();
  db.prepare(`INSERT INTO app_commits (id, user_id, username, module, entity_type, entity_id, entity_label, kind, summary, event, snapshot, created_at)
    VALUES (1, 2, 'Shawn', 'property', 'property', 1, '1 Export Way', 'commit', 'Added property', '[]', '{}', ?),
           (2, 2, 'Shawn', 'planning', 'project', 1, 'Plan', 'commit', 'Created project', '[]', '{}', ?),
           (3, 2, 'Shawn', 'planning', 'project', 1, 'Plan', 'merge', 'Merged strategy', '[]', '{}', ?)`).run(ts, ts, ts);
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('tok1', 2, ?, '2027-01-01T00:00:00.000Z')").run(ts);
  db.prepare("INSERT INTO plan_projects (id, user_id, name, snapshot, created_at, updated_at) VALUES (1, 2, 'Plan', '{}', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO plan_strategies (id, project_id, name, letter, created_at, updated_at) VALUES (1, 1, 'A', 'A', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO plan_ops (id, strategy_id, seq, op_type, params, created_at, updated_at) VALUES (1, 1, 0, 'prepay', '{}', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO plan_legs (id, op_id, source_ref, amount, created_at) VALUES (1, 1, 'cash', '100', ?)").run(ts);
  db.prepare("INSERT INTO plan_scenarios (id, project_id, name, created_at, updated_at) VALUES (1, 1, 'Base', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO plan_reports (id, project_id, name, definition, created_at, updated_at) VALUES (1, 1, 'R1', '{}', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO plan_merge_records (id, strategy_id, kind, entries, created_at) VALUES (1, 1, 'merge', '[]', ?)").run(ts);
}
seed();

test('manual export covers mainline, excludes planning, sessions and sync settings', () => {
  const p = buildExport(db, { includePlanning: false });
  assert.equal(p.format, 'finance-mate-export');
  assert.equal(p.version, 1);
  assert.deepEqual(Object.keys(p).sort(), ['app', 'checksum', 'exported_at', 'files', 'format', 'tables', 'version']);
  for (const t of MAINLINE_TABLES) assert.ok(Array.isArray(p.tables[t]), `missing table ${t}`);
  for (const t of PLANNING_TABLES) assert.ok(!(t in p.tables), `planning table leaked: ${t}`);
  assert.ok(!('sessions' in p.tables), 'sessions leaked');
  assert.equal(p.tables.properties.length, 1);
  assert.equal(p.tables.properties[0].address, '1 Export Way');
  assert.equal(p.tables.mortgage_terms.length, 1);
  assert.equal(p.tables.rate_segments[0].spread, -1);
  assert.equal(p.tables.invest_events.length, 1);
  assert.equal(p.tables.earn_jobs[0].employer, 'Meta');
  // History: the mainline commit travels; planning + merge commits do not.
  assert.deepEqual(p.tables.app_commits.map((c) => c.id), [1]);
  // app_meta: the model key travels; sync keys do not.
  assert.deepEqual(p.tables.app_meta.map((r) => r.key), ['ai_fill_model']);
  // Files travel as base64; a missing file is listed, never fatal.
  assert.equal(p.files.photos.length, 1);
  assert.equal(p.files.photos[0].file_name, 'property-1-test.png');
  assert.equal(Buffer.from(p.files.photos[0].dataBase64, 'base64').equals(PNG_1X1), true);
  assert.equal(p.files.avatars.length, 1);
  assert.equal(p.files.avatars[0].file_name, 'user-2-test.png');
  assert.deepEqual(p.files.missing, []);
  assert.equal(validateExport(p), true);
});

test('missing photo file is listed, not fatal', () => {
  fs.unlinkSync(path.join(PHOTOS_DIR, 'property-1-test.png'));
  const p = buildExport(db, { includePlanning: false });
  assert.equal(p.files.photos.length, 0);
  assert.deepEqual(p.files.missing, [{ kind: 'photo', file_name: 'property-1-test.png' }]);
  assert.equal(validateExport(p), true);
  fs.writeFileSync(path.join(PHOTOS_DIR, 'property-1-test.png'), PNG_1X1);
});

test('round-trip replace restores the exported state and wipes sessions', () => {
  const exported = buildExport(db, { includePlanning: false });
  db.prepare("DELETE FROM properties WHERE id = 1").run();
  db.prepare("UPDATE earn_jobs SET employer = 'Changed' WHERE id = 1").run();
  db.prepare("INSERT INTO properties (id, address, created_at, updated_at) VALUES (99, 'Junk', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')").run();
  db.prepare("INSERT INTO spend_cards (id, name, last4, created_at, updated_at) VALUES (99, 'Junk', '0000', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')").run();
  fs.unlinkSync(path.join(PHOTOS_DIR, 'property-1-test.png'));
  const summary = applyImport(db, exported);
  assert.equal(summary.tables.properties, 1);
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, '1 Export Way');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM properties WHERE id = 99").get().n, 0);
  assert.equal(db.prepare('SELECT employer FROM earn_jobs WHERE id = 1').get().employer, 'Meta');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend_cards WHERE id = 99").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mortgage_terms').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_segments').get().n, 1);
  assert.equal(fs.readFileSync(path.join(PHOTOS_DIR, 'property-1-test.png')).equals(PNG_1X1), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_projects').get().n, 1, 'import leaves planning alone');
  assert.deepEqual(db.prepare("SELECT id FROM app_commits WHERE module = 'planning' ORDER BY id").all().map((c) => c.id), [2, 3], 'planning commits survive a manual import');
  assert.equal(summary.replacedPlanning, false);
  // The target's own sync settings survive the replace.
  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'data_sync'").get().value, '{"enabled":true}');
});

test('import refuses bad payloads', () => {
  const good = buildExport(db, { includePlanning: false });
  const badVersion = { ...good, version: 99 };
  assert.throws(() => validateExport(badVersion), /unsupported export version/);
  const tampered = JSON.parse(JSON.stringify(good));
  tampered.tables.properties[0].address = 'Tampered';
  assert.throws(() => validateExport(tampered), /checksum mismatch/);
  const unknownTable = JSON.parse(JSON.stringify(good));
  unknownTable.tables.evil = [];
  unknownTable.checksum = 'x';
  assert.throws(() => validateExport(unknownTable), /unknown table/);
  const noUsers = JSON.parse(JSON.stringify(good));
  noUsers.tables.users = [];
  assert.throws(() => validateExport(noUsers), /no users/);
  assert.throws(() => validateExport({ format: 'other' }), /not a finance-mate export/);
  assert.throws(() => validateExport(null), /not a finance-mate export/);
});

test('backup includes planning and restores everything an import replaced', () => {
  const backup = writeBackup(db, { includePlanning: true });
  assert.equal(backup.includesPlanning, true);
  assert.deepEqual(listBackups().map((b) => b.name), [backup.name]);
  const payload = readBackup(backup.name);
  assert.equal(payload.tables.plan_projects.length, 1);
  assert.equal(payload.tables.plan_strategies.length, 1);
  assert.deepEqual(payload.tables.app_commits.map((c) => c.id), [1, 2, 3]);
  db.prepare('DELETE FROM plan_projects WHERE id = 1').run();
  db.prepare("DELETE FROM properties WHERE id = 1").run();
  const summary = applyImport(db, payload);
  assert.equal(summary.replacedPlanning, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_projects').get().n, 1);
  assert.equal(db.prepare('SELECT address FROM properties WHERE id = 1').get().address, '1 Export Way');
  assert.throws(() => readBackup('finance-mate-backup-19990101-000000.json'), /backup not found/);
  assert.throws(() => readBackup('../../etc/passwd'), /unknown backup/);
});
