// SQLite storage (better-sqlite3). The database file lives in DATA_DIR,
// which docker-compose backs with a named volume so data survives rebuilds.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
export const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'finance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  avatar_file TEXT,                   -- uploaded avatar photo (in AVATARS_DIR); NULL = letter avatar
  avatar_color TEXT,                  -- letter-avatar background color (stored per user)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  photo_url TEXT,
  photo_file TEXT,
  assessed_value REAL,
  assessed_year INTEGER,
  land_value REAL,
  building_value REAL,
  assessed_source TEXT,               -- 'auto' (BC Assessment) | 'manual'
  assessed_fetched_at TEXT,
  bca_matched_address TEXT,
  bca_extract_date TEXT,
  mortgage_balance REAL,
  mortgage_balance_date TEXT,         -- 'YYYY-MM-DD' the balance refers to
  mortgage_payment REAL,              -- monthly payment; engine prefers this
  amortization_years REAL,            -- used to derive payment when unset
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_segments (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,           -- 'YYYY-MM-DD', segment applies from here
  rate_type TEXT NOT NULL,            -- 'fixed' | 'variable'
  annual_rate REAL NOT NULL,          -- nominal annual %, semi-annual compounding
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_property ON rate_segments(property_id, start_date);
CREATE TABLE IF NOT EXISTS other_assets (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,             -- 'fixed_assets' | 'stocks' | 'term_deposits' | 'other'
  name TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CAD',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Assessed-value history for the trend chart: one point per property per
-- assessment year. 'auto' points are written by BC Assessment fetches;
-- 'manual' points are entered by hand (BC Assessment's public data only
-- carries the current year, so earlier years can only come from here).
CREATE TABLE IF NOT EXISTS value_history (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- 'auto' | 'manual'
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (property_id, year)
);
`);

// Safe add-column migrations for databases created before a column existed.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('avatar_file')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_file TEXT');
}
if (!userCols.includes('avatar_color')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_color TEXT');
}
const propCols = db.prepare('PRAGMA table_info(properties)').all().map((c) => c.name);
if (!propCols.includes('bca_id')) {
  // The BC Assessment property id of the suggestion the user picked from
  // the address dropdown; lets the assessment fetch skip the fuzzy search.
  db.exec('ALTER TABLE properties ADD COLUMN bca_id TEXT');
}
if (!propCols.includes('purchase_date')) {
  // When the property was bought ('YYYY-MM-DD'). Nullable in the schema
  // (rows predate it); the Add endpoint requires it for new properties.
  db.exec('ALTER TABLE properties ADD COLUMN purchase_date TEXT');
}
if (!propCols.includes('payment_day')) {
  // Day of the month (1-31) the mortgage payment is deducted. Nullable.
  // It only anchors the projection's monthly node dates; the interest
  // math stays monthly and does not depend on it.
  db.exec('ALTER TABLE properties ADD COLUMN payment_day INTEGER');
}
if (!propCols.includes('payment_frequency')) {
  // Payment frequency key (engine FREQUENCIES): 'monthly' |
  // 'semi_monthly' | 'bi_weekly' | 'accelerated_bi_weekly' | 'weekly' |
  // 'accelerated_weekly'. Nullable; NULL reads as 'monthly' (the
  // pre-frequency behaviour).
  db.exec('ALTER TABLE properties ADD COLUMN payment_frequency TEXT');
}
// --------------------------------------------------------------- owners ---
// Owners are a SET of usernames: co-ownership is just several names, there
// is no special 'Joint' value. Stored as a JSON array in an `owners`
// column. Databases created earlier have a single-value `owner` column
// instead (a username, 'Joint', or NULL): each value migrates to a
// one-element array — except the literal 'Joint', which names no concrete
// people and becomes an empty set — and the legacy column is dropped.
function migrateOwners(table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes('owners')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN owners TEXT`);
  }
  if (!cols.includes('owner')) return;
  const rows = db.prepare(`SELECT id, owner FROM ${table}`).all();
  const upd = db.prepare(`UPDATE ${table} SET owners = ? WHERE id = ?`);
  for (const r of rows) {
    const s = r.owner === null || r.owner === undefined ? '' : String(r.owner).trim();
    upd.run(JSON.stringify(!s || s === 'Joint' ? [] : [s]), r.id);
  }
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN owner`);
  } catch { /* ancient SQLite without DROP COLUMN: legacy column stays, unused */ }
}
migrateOwners('properties');
migrateOwners('other_assets');

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
}

// Default letter-avatar colors. The household users get fixed, clearly
// distinct colors; anyone else is assigned one from the palette by a
// stable hash of the username. The chosen color is stored on the user
// row (avatar_color), so it never changes under the user.
const FIXED_AVATAR_COLORS = { admin: '#607d8b', Shawn: '#2563eb', Jiaying: '#db2777' };
const AVATAR_PALETTE = ['#7c3aed', '#059669', '#d97706', '#0891b2', '#dc2626', '#4f46e5', '#c026d3', '#65a30d'];
export function defaultAvatarColor(username) {
  if (FIXED_AVATAR_COLORS[username]) return FIXED_AVATAR_COLORS[username];
  let h = 0;
  for (const c of String(username)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// Seed the initial users on first start. Override the admin credentials with
// SEED_ADMIN_USER / SEED_ADMIN_PASSWORD; defaults are admin / admin and
// MUST be changed before real use (see README).
export function seedUsers() {
  // Each seed user is created only if that username does not exist yet,
  // so restarts (and later password changes) are never overwritten.
  const seeds = [
    { username: process.env.SEED_ADMIN_USER || 'admin', password: process.env['SEED_ADMIN_' + 'PASSWORD'] || 'admin' },
    { username: 'Shawn', password: 'Shawn' },
    { username: 'Jiaying', password: 'Jiaying' },
  ];
  for (const u of seeds) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    if (exists) continue;
    const { salt, hash } = hashPassword(u.password);
    db.prepare('INSERT INTO users (username, pass_hash, salt, avatar_color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(u.username, hash, salt, defaultAvatarColor(u.username), new Date().toISOString());
    console.log(`[db] seeded user "${u.username}" (change the password before real use)`);
  }
  // Backfill a stored avatar color for any user who does not have one
  // yet (rows created before avatars existed).
  const missing = db.prepare('SELECT id, username FROM users WHERE avatar_color IS NULL').all();
  const fill = db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?');
  for (const u of missing) fill.run(defaultAvatarColor(u.username), u.id);
}
