// SQLite storage (better-sqlite3). The database file lives in DATA_DIR,
// which docker-compose backs with a named volume so data survives rebuilds.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'finance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
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
`);

// Safe add-column migrations for databases created before a column existed.
const propCols = db.prepare('PRAGMA table_info(properties)').all().map((c) => c.name);
if (!propCols.includes('bca_id')) {
  // The BC Assessment property id of the suggestion the user picked from
  // the address dropdown; lets the assessment fetch skip the fuzzy search.
  db.exec('ALTER TABLE properties ADD COLUMN bca_id TEXT');
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
}

// Seed the initial admin user on first start. Override the credentials with
// SEED_ADMIN_USER / SEED_ADMIN_PASSWORD; defaults are admin / admin and
// MUST be changed before real use (see README).
export function seedAdmin() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (row.n > 0) return;
  const username = process.env.SEED_ADMIN_USER || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD || 'admin';
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hash, salt, new Date().toISOString());
  console.log(`[db] seeded initial user "${username}" (change the password before real use)`);
}
