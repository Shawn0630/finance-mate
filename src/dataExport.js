// Data export / import (2026-11-07): one JSON file carrying the whole
// mainline database, so the app can move to another server. Planning is
// NEVER in a manual export (user 2026-11-07): no plan_projects,
// strategies, operations, scenarios, baselines, reports or merge
// records, and no planning-related Global History commits. Secrets are
// never in the file either: LLM keys live in server/.env, outside the
// DB, and nothing here reads the environment. Password hashes DO travel
// (users keep signing in after a migration); session tokens never do.
//
// The same builder backs the pre-import backup — with includePlanning,
// so a restore puts back exactly what an import replaced. Import
// replaces exactly the tables the payload carries: a manual export
// leaves planning untouched on the target; a backup restore replaces
// planning too. Sessions are always wiped by an import (the users just
// changed), so everyone signs in again afterwards.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PHOTOS_DIR, AVATARS_DIR } from './db.js';

export const EXPORT_FORMAT = 'finance-mate-export';
export const EXPORT_VERSION = 1;
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Tables in insert order (parents before children). Every row keeps
// its id, so foreign keys stay valid across the restore.
export const MAINLINE_TABLES = [
  'users',
  'properties',
  'mortgage_terms',
  'rate_segments',
  'lump_sums',
  'value_history',
  'property_costs',
  'property_photos',
  'prime_rates',
  'invest_fx_rates',
  'invest_accounts',
  'invest_holdings',
  'invest_events',
  'invest_prices',
  'invest_symbol_prices',
  'invest_plans',
  'invest_plan_deleted',
  'earn_jobs',
  'earn_pay_changes',
  'earn_bonuses',
  'earn_rentals',
  'earn_rental_years',
  'earn_rental_entries',
  'spend_cards',
  'spend_transactions',
  'other_assets',
  'home_insights',
  'home_insight_order',
  'income_marks',
  'user_preferences',
  'app_meta',
  'app_commits',
];

export const PLANNING_TABLES = [
  'plan_projects',
  'plan_strategies',
  'plan_ops',
  'plan_legs',
  'plan_declared_assets',
  'plan_scenarios',
  'plan_assumptions',
  'plan_ai_models',
  'plan_merge_records',
  'plan_reports',
  'plan_baselines',
  'plan_templates',
];

// Sync settings/state live in app_meta but are per-machine: they are
// never exported (the target re-enables sync itself) and an import
// preserves the target's own rows.
export const SYNC_META_KEYS = new Set(['data_sync', 'data_sync_state', 'data_sync_dirty']);
const COL_RE = /^[A-Za-z0-9_]+$/;

const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
function contentTypeFor(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || null;
}
function exportFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `finance-mate-export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
function backupFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `finance-mate-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

function orderByFor(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes('id')) return 'ORDER BY id';
  const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return pk.length ? `ORDER BY ${pk.map((c) => `"${c}"`).join(', ')}` : '';
}

// Checksum over exactly what integrity means: the tables + the files.
// The sync loop also hashes the raw file bytes; this one guards the
// content itself (a hand-edited file with a stale checksum is refused).
export function payloadChecksum(payload) {
  return crypto.createHash('sha256').update(JSON.stringify({ tables: payload.tables, files: payload.files })).digest('hex');
}

// Build the export payload. Photos and avatars travel as base64 inside
// the JSON (files on disk, so a migration does not lose them); a file
// referenced by a row but missing on disk is listed under files.missing
// and never fails the export.
export function buildExport(db, { includePlanning = false, photosDir = PHOTOS_DIR, avatarsDir = AVATARS_DIR } = {}) {
  const tables = {};
  for (const table of MAINLINE_TABLES) {
    if (table === 'app_meta') {
      tables.app_meta = db.prepare('SELECT * FROM app_meta ORDER BY key').all()
        .filter((r) => !SYNC_META_KEYS.has(r.key));
    } else if (table === 'app_commits') {
      tables.app_commits = includePlanning
        ? db.prepare('SELECT * FROM app_commits ORDER BY id').all()
        : db.prepare("SELECT * FROM app_commits WHERE module != 'planning' ORDER BY id").all();
    } else {
      tables[table] = db.prepare(`SELECT * FROM "${table}" ${orderByFor(db, table)}`).all();
    }
  }
  if (includePlanning) {
    for (const table of PLANNING_TABLES) {
      tables[table] = db.prepare(`SELECT * FROM "${table}" ${orderByFor(db, table)}`).all();
    }
  }
  const files = { photos: [], avatars: [], missing: [] };
  for (const row of tables.property_photos) {
    const file = path.join(photosDir, row.file_name);
    const contentType = contentTypeFor(row.file_name);
    if (contentType && fs.existsSync(file)) {
      files.photos.push({ kind: 'photo', file_name: row.file_name, contentType, dataBase64: fs.readFileSync(file).toString('base64') });
    } else {
      files.missing.push({ kind: 'photo', file_name: row.file_name });
    }
  }
  for (const row of tables.users) {
    if (!row.avatar_file) continue;
    const file = path.join(avatarsDir, row.avatar_file);
    const contentType = contentTypeFor(row.avatar_file);
    if (contentType && fs.existsSync(file)) {
      files.avatars.push({ kind: 'avatar', file_name: row.avatar_file, contentType, dataBase64: fs.readFileSync(file).toString('base64') });
    } else {
      files.missing.push({ kind: 'avatar', file_name: row.avatar_file });
    }
  }
  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    app: 'finance-mate',
    exported_at: new Date().toISOString(),
    tables,
    files,
    checksum: '',
  };
  payload.checksum = payloadChecksum(payload);
  return payload;
}

// Strict validation — fail closed, with the reason named. Unknown
// tables, unknown versions and checksum mismatches are refused;
// an export with no users is refused (nobody could sign in after it).
export function validateExport(payload) {
  const fail = (msg) => { throw new Error(msg); };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('not a finance-mate export file');
  if (payload.format !== EXPORT_FORMAT) fail('not a finance-mate export file');
  if (payload.version !== EXPORT_VERSION) fail(`unsupported export version ${payload.version} (this app reads version ${EXPORT_VERSION})`);
  if (typeof payload.exported_at !== 'string' || !payload.exported_at) fail('export is missing exported_at');
  if (!payload.tables || typeof payload.tables !== 'object' || Array.isArray(payload.tables)) fail('export is missing tables');
  if (!payload.files || typeof payload.files !== 'object') fail('export is missing files');
  const known = new Set([...MAINLINE_TABLES, ...PLANNING_TABLES]);
  for (const name of Object.keys(payload.tables)) {
    if (!known.has(name)) fail(`unknown table in export: ${name}`);
    if (!Array.isArray(payload.tables[name])) fail(`table ${name} is not a list`);
    for (const row of payload.tables[name]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`table ${name} has a bad row`);
    }
  }
  if (!Array.isArray(payload.tables.users) || !payload.tables.users.length) fail('export has no users');
  for (const list of [payload.files.photos || [], payload.files.avatars || []]) {
    if (!Array.isArray(list)) fail('export files are malformed');
    for (const f of list) {
      if (!f || typeof f.file_name !== 'string' || f.file_name !== path.basename(f.file_name)
        || typeof f.dataBase64 !== 'string' || !f.dataBase64 || !contentTypeFor(f.file_name)) {
        fail(`bad file entry: ${f && f.file_name}`);
      }
    }
  }
  if (typeof payload.checksum !== 'string' || payload.checksum !== payloadChecksum(payload)) {
    fail('export checksum mismatch — the file was edited or is corrupt');
  }
  return true;
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Replace exactly the tables the payload carries (plus files), inside
// one transaction with foreign keys off; a foreign_key_check runs
// before the commit. Sessions are wiped (the users just changed).
// The target's own sync settings survive the replace. Returns a
// summary of what landed.
export function applyImport(db, payload, { photosDir = PHOTOS_DIR, avatarsDir = AVATARS_DIR } = {}) {
  validateExport(payload);
  const tables = Object.keys(payload.tables);
  const replacedPlanning = tables.some((t) => PLANNING_TABLES.includes(t));
  // Files first: a DB failure after this leaves orphan files, which
  // are unreferenced and pruned by the next import's cleanup.
  let filesWritten = { photos: 0, avatars: 0 };
  for (const f of [...(payload.files.photos || []), ...(payload.files.avatars || [])]) {
    const dir = f.kind === 'avatar' ? avatarsDir : photosDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, f.file_name), Buffer.from(f.dataBase64, 'base64'));
    filesWritten[f.kind === 'avatar' ? 'avatars' : 'photos']++;
  }
  const syncMeta = db.prepare('SELECT * FROM app_meta WHERE key IN (?, ?, ?)')
    .all('data_sync', 'data_sync_state', 'data_sync_dirty');
  const summary = {};
  // app_commits is shared: a manual export carries mainline commits
  // only, so its import replaces the mainline rows and leaves the
  // target's planning commits alone; a backup carries all commits
  // and replaces the whole table.
  const payloadHasPlanningCommits = (payload.tables.app_commits || []).some((c) => c.module === 'planning');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const table of [...tables].reverse()) {
        if (table === 'app_commits' && !payloadHasPlanningCommits) {
          db.prepare("DELETE FROM app_commits WHERE module != 'planning'").run();
        } else {
          db.prepare(`DELETE FROM "${table}"`).run();
        }
      }
      for (const table of tables) {
        const cols = tableColumns(db, table);
        const rows = payload.tables[table];
        summary[table] = rows.length;
        if (!rows.length) continue;
        for (const row of rows) {
          const keys = Object.keys(row).filter((k) => COL_RE.test(k));
          const unknown = keys.filter((k) => !cols.includes(k));
          if (unknown.length) throw new Error(`table ${table} has unknown column ${unknown[0]}`);
          db.prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
            .run(...keys.map((k) => row[k]));
        }
      }
      // The target's own sync settings survive the replace.
      for (const r of syncMeta) {
        db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(r.key, r.value);
      }
      db.prepare('DELETE FROM sessions').run();
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violations = db.pragma('foreign_key_check');
  if (violations.length) throw new Error(`import failed foreign-key check: ${JSON.stringify(violations.slice(0, 3))}`);
  // Prune files nothing references anymore (a photo deleted on the
  // source must not linger on the target).
  const prune = (dir, referenced) => {
    let removed = 0;
    if (!fs.existsSync(dir)) return removed;
    for (const name of fs.readdirSync(dir)) {
      if (!referenced.has(name)) { fs.promises.unlink(path.join(dir, name)).catch(() => {}); removed++; }
    }
    return removed;
  };
  const photoNames = new Set(db.prepare('SELECT file_name FROM property_photos').all().map((r) => r.file_name));
  const avatarNames = new Set(db.prepare('SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL').all().map((r) => r.avatar_file));
  prune(photosDir, photoNames);
  prune(avatarsDir, avatarNames);
  return { tables: summary, files: filesWritten, missing: (payload.files.missing || []).length, replacedPlanning };
}

// A full backup (planning included) in the export format, written to
// DATA_DIR/backups. Restoring one is the same import path as a manual
// export, so a backup always puts back exactly what an import replaced.
export function writeBackup(db, { includePlanning = true } = {}) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const payload = buildExport(db, { includePlanning });
  const name = backupFileName();
  const file = path.join(BACKUPS_DIR, name);
  fs.writeFileSync(file, JSON.stringify(payload));
  return { name, createdAt: payload.exported_at, size: fs.statSync(file).size, includesPlanning: includePlanning };
}

export function listBackups() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  return fs.readdirSync(BACKUPS_DIR)
    .filter((n) => /^finance-mate-backup-\d{8}-\d{6}\.json$/.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(BACKUPS_DIR, n));
      return { name: n, createdAt: st.mtime.toISOString(), size: st.size };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function readBackup(name) {
  if (typeof name !== 'string' || !/^finance-mate-backup-\d{8}-\d{6}\.json$/.test(name)) {
    throw new Error('unknown backup');
  }
  const file = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(file)) throw new Error('backup not found');
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('backup file is corrupt'); }
  validateExport(payload);
  return payload;
}
