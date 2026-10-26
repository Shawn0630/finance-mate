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
  mortgage_payment REAL,              -- DORMANT (entered-payment era): the payment is always calculated now; never read or written
  amortization_years REAL,            -- used to derive payment when unset
  lender TEXT,                        -- mortgage lender (bank), free text
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_segments (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,           -- 'YYYY-MM-DD', segment applies from here
  rate_type TEXT NOT NULL,            -- 'fixed' | 'variable'
  annual_rate REAL,                   -- nominal annual %; NULL for prime-spread segments
  rate_mode TEXT,                     -- 'absolute' | 'prime_spread' (variable only)
  spread REAL,                        -- prime_spread only: percentage points vs prime (e.g. -1 = Prime - 1)
  created_at TEXT NOT NULL
);
-- Prime lending rate history, fetched from the region's prime
-- source (Canada: Bank of Canada Valet). One row per observation
-- date; the newest row is the current prime.
CREATE TABLE IF NOT EXISTS prime_rates (
  date TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' observation date
  rate REAL NOT NULL,                 -- %
  source TEXT                         -- series id the value came from
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
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
-- assessment year. 'auto' points are written by BC Assessment fetches
-- (current roll only — BC Assessment's public data has no prior years);
-- 'housesigma' points come from HouseSigma history pulls (prior years);
-- 'manual' points are entered by hand. A year keeps the strongest
-- source: manual > auto (BC Assessment) > housesigma — imports never
-- overwrite a stronger source's point.
CREATE TABLE IF NOT EXISTS value_history (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- 'auto' | 'manual' | 'housesigma'
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (property_id, year)
);
-- A property's uploaded photos, in display order: the gallery the
-- detail page shows as a carousel; the first row is the Properties
-- card cover. Files live in PHOTOS_DIR; the row stores only the name.
-- (The older single-photo column properties.photo_url — an external
-- link — is NOT part of this table: it joins the gallery view as one
-- extra entry the user can remove, which clears the column.)
CREATE TABLE IF NOT EXISTS property_photos (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_property_photos ON property_photos(property_id, sort_order, id);
`);

// Properties used to carry ONE uploaded photo in properties.photo_file;
// the gallery replaces it. Fold any existing single photo into the
// gallery as a photo of that property (keeping its place as the first
// upload), then clear the column so property_photos is the single
// source of truth. Idempotent: an already-migrated file is skipped.
{
  const singles = db.prepare('SELECT id, photo_file, created_at FROM properties WHERE photo_file IS NOT NULL').all();
  if (singles.length) {
    const has = db.prepare('SELECT 1 FROM property_photos WHERE property_id = ? AND file_name = ?');
    const ins = db.prepare('INSERT INTO property_photos (property_id, file_name, sort_order, created_at) VALUES (?, ?, 0, ?)');
    const clear = db.prepare('UPDATE properties SET photo_file = NULL WHERE id = ?');
    db.transaction(() => {
      for (const r of singles) {
        if (!has.get(r.id, r.photo_file)) ins.run(r.id, r.photo_file, r.created_at);
        clear.run(r.id);
      }
    })();
  }
}

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
if (!propCols.includes('region')) {
  // Region code (src/regions/): only 'CA' is implemented; the API
  // rejects anything else for now. Existing rows default to 'CA'.
  db.exec("ALTER TABLE properties ADD COLUMN region TEXT DEFAULT 'CA'");
}
if (!propCols.includes('lender')) {
  // The mortgage lender (bank) for the property: free text, with the
  // big Canadian banks offered as quick picks in the UI. Nullable;
  // rows that predate it simply show no lender anywhere.
  db.exec('ALTER TABLE properties ADD COLUMN lender TEXT');
}
if (!propCols.includes('hs_id_address')) {
  // HouseSigma's ids for this property (its id_address / id_listing),
  // stored on the first successful history pull so later pulls can
  // skip the address locate step.
  db.exec('ALTER TABLE properties ADD COLUMN hs_id_address TEXT');
  db.exec('ALTER TABLE properties ADD COLUMN hs_id_listing TEXT');
}
// rate_segments: databases created before prime-spread pricing have
// annual_rate NOT NULL and no rate_mode / spread columns. Prime
// segments store annual_rate as NULL, so when either difference is
// found the table is rebuilt in the new shape (existing rows become
// 'absolute' — exactly how they were always interpreted).
{
  const segCols = db.prepare('PRAGMA table_info(rate_segments)').all();
  const annual = segCols.find((c) => c.name === 'annual_rate');
  const needsRebuild = !segCols.some((c) => c.name === 'rate_mode') || (annual && annual.notnull === 1);
  if (segCols.length && needsRebuild) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE rate_segments_new (
          id INTEGER PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
          start_date TEXT NOT NULL,
          rate_type TEXT NOT NULL,
          annual_rate REAL,
          rate_mode TEXT,
          spread REAL,
          created_at TEXT NOT NULL
        );
        INSERT INTO rate_segments_new (id, property_id, start_date, rate_type, annual_rate, rate_mode, spread, created_at)
          SELECT id, property_id, start_date, rate_type, annual_rate, 'absolute', NULL, created_at FROM rate_segments;
        DROP TABLE rate_segments;
        ALTER TABLE rate_segments_new RENAME TO rate_segments;
        CREATE INDEX IF NOT EXISTS idx_segments_property ON rate_segments(property_id, start_date);
      `);
    })();
  }
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

// ------------------------------------------------------- mortgage terms ---
// The mortgage is modelled the way Canadian lenders actually run
// it: a TERM is the top-level contract (lender, start, length in
// months, the amortization agreed for that term, the balance it
// opened with). Inside a term the rate can change (rate_segments,
// each now owned by a term) and lump sums can land (lump_sums).
// The property keeps the CURRENT balance anchor (mortgage_balance /
// mortgage_balance_date). The payment schedule lives ON each term
// (payment_frequency / payment_day) — a renewal can change banks
// and schedule together — and the term containing the balance
// anchor also carries it (anchor_balance / anchor_date) when the
// anchor date falls inside the term, after its start. The property's
// payment_frequency / payment_day columns remain as mirrors of the
// anchor term's values for older readers. The monthly payment is
// ALWAYS calculated (from balance, rate plan and amortization) and
// never entered: the payment_override column below and the
// property's mortgage_payment column are DORMANT — kept only so
// existing databases keep their shape; nothing reads or writes
// them, and a value left over from the entered-payment era no
// longer rules anything.
db.exec(`
CREATE TABLE IF NOT EXISTS mortgage_terms (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lender TEXT,                        -- the bank for this term (free text)
  start_date TEXT NOT NULL,           -- 'YYYY-MM-DD' the term begins
  term_months INTEGER NOT NULL DEFAULT 60,  -- contract length, 1..120
  amortization_years REAL,            -- amortization agreed for this term; NULL = not set
  opening_balance REAL,               -- balance the term opened with
  repayment_method TEXT NOT NULL DEFAULT 'equal_payment',  -- 'equal_payment' (level payment) | 'equal_principal' (fixed monthly principal)
  amortization_defaulted INTEGER NOT NULL DEFAULT 0,  -- 1 = amortization came from the migration default (25y)
  payment_override REAL,              -- DORMANT (entered-payment era): the payment is always calculated now; never read or written
  payment_frequency TEXT,             -- payment schedule for this term; NULL = fall back to the property mirror
  payment_day INTEGER,                -- deduction day 1..31 for this term; NULL = fall back
  anchor_balance REAL,                -- the property's balance anchor, when it lands inside this term after its start
  anchor_date TEXT,                   -- 'YYYY-MM-DD' of that anchor; both anchor columns are set together or neither
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lump_sums (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  term_id INTEGER REFERENCES mortgage_terms(id) ON DELETE SET NULL,
  date TEXT NOT NULL,                 -- 'YYYY-MM-DD' the lump sum lands
  amount REAL NOT NULL,               -- principal paid in one shot
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terms_property ON mortgage_terms(property_id, start_date);
CREATE INDEX IF NOT EXISTS idx_lump_sums_property ON lump_sums(property_id, date);
`);
{
  const segCols = db.prepare('PRAGMA table_info(rate_segments)').all().map((c) => c.name);
  if (segCols.length && !segCols.includes('term_id')) {
    db.exec('ALTER TABLE rate_segments ADD COLUMN term_id INTEGER REFERENCES mortgage_terms(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_segments_term ON rate_segments(term_id)');
  }
  // Terms from before repayment methods existed are level-payment
  // plans — the only shape the engine had — so the column lands
  // with that default and their projections do not move.
  const termCols = db.prepare('PRAGMA table_info(mortgage_terms)').all().map((c) => c.name);
  if (termCols.length && !termCols.includes('repayment_method')) {
    db.exec("ALTER TABLE mortgage_terms ADD COLUMN repayment_method TEXT NOT NULL DEFAULT 'equal_payment'");
  }
  // Per-term payment schedule + balance anchors: the columns land
  // nullable and the backfill after the Term-1 pass seeds them from
  // the property, so a migrated mortgage behaves exactly as before.
  if (termCols.length) {
    if (!termCols.includes('payment_override')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN payment_override REAL');
    if (!termCols.includes('payment_frequency')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN payment_frequency TEXT');
    if (!termCols.includes('payment_day')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN payment_day INTEGER');
    if (!termCols.includes('anchor_balance')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN anchor_balance REAL');
    if (!termCols.includes('anchor_date')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN anchor_date TEXT');
  }
}
// Idempotent backfill: every property gets a Term 1, and every
// segment that does not name a term yet is assigned to its
// property's first term. Term 1 mirrors the pre-term model exactly —
// start at the earliest segment (else the balance date), 60 months,
// the property's amortization (else the 25-year default, flagged),
// the current balance as its opening balance, the property's
// lender — so a migrated mortgage projects month-by-month exactly
// as it did before terms existed.
{
  const props = db.prepare('SELECT * FROM properties').all();
  const termCount = db.prepare('SELECT COUNT(*) AS n FROM mortgage_terms WHERE property_id = ?');
  const firstTerm = db.prepare('SELECT id FROM mortgage_terms WHERE property_id = ? ORDER BY start_date, id LIMIT 1');
  const firstSegStart = db.prepare('SELECT MIN(start_date) AS s FROM rate_segments WHERE property_id = ?');
  const insTerm = db.prepare(
    `INSERT INTO mortgage_terms (property_id, lender, start_date, term_months, amortization_years, opening_balance, amortization_defaulted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const assignSegs = db.prepare('UPDATE rate_segments SET term_id = ? WHERE property_id = ? AND term_id IS NULL');
  db.transaction(() => {
    for (const p of props) {
      if (termCount.get(p.id).n > 0) {
        assignSegs.run(firstTerm.get(p.id).id, p.id);
        continue;
      }
      const start = firstSegStart.get(p.id).s
        || p.mortgage_balance_date || p.purchase_date || String(p.created_at).slice(0, 10);
      const hasAmort = p.amortization_years > 0;
      const info = insTerm.run(
        p.id, p.lender ?? null, start, 60,
        hasAmort ? p.amortization_years : 25,
        p.mortgage_balance ?? null,
        hasAmort ? 0 : 1,
        p.created_at, p.updated_at
      );
      assignSegs.run(info.lastInsertRowid, p.id);
    }
  })();
}
// Seed the per-term schedule fields from the property (their
// pre-term home) and place the balance anchor on the term that
// contains it. Idempotent: a term only receives a value it does
// not already carry, so a value later edited (or deliberately
// cleared-and-reset by the server's syncs) is never resurrected by
// a restart. The property's frequency/day go to EVERY term (they
// ruled globally before, so every span keeps its behavior). An
// anchor dated on or before its term's start folds into the
// term's opening balance — where it already lives — so no anchor
// columns are set for it; a later anchor lands on the term as
// anchor_balance / anchor_date. (The property's old entered
// payment is deliberately NOT seeded anywhere: payments are
// always calculated now, so it rules nothing.)
{
  const props = db.prepare('SELECT * FROM properties').all();
  const termsOfProp = db.prepare('SELECT * FROM mortgage_terms WHERE property_id = ? ORDER BY start_date, id');
  const setFreq = db.prepare('UPDATE mortgage_terms SET payment_frequency = ? WHERE id = ? AND payment_frequency IS NULL');
  const setDay = db.prepare('UPDATE mortgage_terms SET payment_day = ? WHERE id = ? AND payment_day IS NULL');
  const setAnchor = db.prepare('UPDATE mortgage_terms SET anchor_balance = ?, anchor_date = ? WHERE id = ? AND anchor_date IS NULL');
  db.transaction(() => {
    for (const p of props) {
      const terms = termsOfProp.all(p.id);
      if (!terms.length) continue;
      for (const t of terms) {
        if (p.payment_frequency != null) setFreq.run(p.payment_frequency, t.id);
        if (p.payment_day != null) setDay.run(p.payment_day, t.id);
      }
      const bd = p.mortgage_balance_date;
      let anchorTerm = null;
      if (bd) for (const t of terms) if (t.start_date <= bd) anchorTerm = t;
      anchorTerm = anchorTerm || terms[0];
      if (bd && p.mortgage_balance != null && bd > anchorTerm.start_date) {
        setAnchor.run(p.mortgage_balance, bd, anchorTerm.id);
      }
    }
  })();
}

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
