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
  ai_fields TEXT,                     -- JSON array of field names carrying the "filled by AI" flag
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
  compounding TEXT NOT NULL DEFAULT 'semi_annual',  -- 'semi_annual' | 'monthly': how this segment's nominal rate compounds
  accrual TEXT NOT NULL DEFAULT 'monthly',  -- 'monthly' | 'daily': interest accrues per period (converted rate) or per actual day
  locked_on TEXT,                     -- 'YYYY-MM-DD' the date this segment's rate was locked (priced) on; only variable prime_spread segments carry one — derivations governed by the segment price prime as of this date; accrual never reads it
  ai_fields TEXT,                     -- JSON array of field names carrying the "filled by AI" flag
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
-- Per-user preferences, keyed by name; value is JSON text. One
-- row per (user, key) — e.g. 'chart_colors' holds the user's
-- per-series chart colors. Strictly the owner's own rows are
-- ever read or written (the API scopes by the session user).
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
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
  -- The land / building split of the year's assessed value, when
  -- the source carries one (BC Assessment's current roll and
  -- HouseSigma's history both do). NULL on points whose source
  -- has no split — the Assessment History chart stacks the split
  -- years and draws the rest as single total bars.
  land_value REAL,
  building_value REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (property_id, year)
);
-- A property's yearly running costs (property tax, strata fees,
-- utilities, insurance…): one row per (year, category). The amount
-- is stored in the basis it was recorded in: 'annual' = the year's
-- total; 'monthly' = a monthly average, whose year total is the
-- average × 12. A monthly row may also carry monthly_amounts — a
-- JSON map of the months actually recorded ({"1": 312.5, …}); the
-- stored amount is then the server-computed average of those
-- months. Rows without it are averages given directly. Every
-- total, pivot and chart reads at the ANNUAL figure (see
-- src/costs.js). source is provenance only: 'manual' rows were
-- typed in, 'ai' rows landed through the AI fill chat's Apply
-- button.
CREATE TABLE IF NOT EXISTS property_costs (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  basis TEXT NOT NULL DEFAULT 'annual',   -- 'annual' | 'monthly'
  monthly_amounts TEXT,                   -- JSON {"1": n, …} for monthly rows with per-month detail
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (property_id, year, category)
);
CREATE INDEX IF NOT EXISTS idx_property_costs ON property_costs(property_id, year);
-- Investments: accounts (TFSA / RRSP / RSU / non-registered …)
-- hold exchange-traded stocks/ETFs and bank mutual funds. A
-- holding's life is its EVENTS (buys, sells, RSU grants,
-- dividends); its price history is cached in invest_prices from
-- four sources — 'stooq' (fetched daily closes for exchange
-- symbols), 'yahoo' (the same, via Yahoo Finance when Stooq has
-- nothing for a symbol), 'manual' (NAV snapshots the user
-- records for bank funds, which have no clean public history
-- feed) and 'event'
-- (the per-unit price of a priced event, materialized so a
-- holding with no other price source still values at its last
-- traded price). source on holdings/events is provenance only:
-- 'manual' rows were typed in, 'ai' rows landed through the
-- account page's AI fill chat Apply button (see src/aiFill.js).
CREATE TABLE IF NOT EXISTS invest_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'NonRegistered',  -- 'TFSA' | 'RRSP' | 'RSU' | 'NonRegistered' | 'Other'
  institution TEXT,                            -- free text: CIBC, Scotia, employer plan…
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invest_holdings (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES invest_accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                         -- display name, e.g. 'CIBC US Index Fund'
  kind TEXT NOT NULL DEFAULT 'exchange',       -- 'exchange' (stock/ETF) | 'fund' (bank mutual fund)
  symbol TEXT,                                 -- exchange only: 'XQQ.TO', 'AAPL'
  fund_code TEXT,                              -- optional fund code, display only
  currency TEXT NOT NULL DEFAULT 'CAD',        -- 'CAD' | 'USD' — shown beside the holding everywhere
  source TEXT NOT NULL DEFAULT 'manual',       -- 'manual' | 'ai'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invest_events (
  id INTEGER PRIMARY KEY,
  holding_id INTEGER NOT NULL REFERENCES invest_holdings(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                          -- 'YYYY-MM-DD'
  type TEXT NOT NULL,                          -- 'buy' | 'sell' | 'grant' | 'dividend' | 'split'
  units REAL,                                  -- buy/sell/grant: units moved
  price REAL,                                  -- per-unit price in the holding's currency; grant: cost-basis price, NULL = market price on the grant date
  amount REAL,                                 -- dividend: total paid, in the holding's currency
  split_new REAL,                              -- split only: the ratio's new side (3:1 → 3)
  split_old REAL,                              -- split only: the ratio's old side (3:1 → 1); multiplier = split_new / split_old
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',       -- 'manual' | 'ai'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invest_prices (
  id INTEGER PRIMARY KEY,
  holding_id INTEGER NOT NULL REFERENCES invest_holdings(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                          -- 'YYYY-MM-DD'
  price REAL NOT NULL,                         -- per-unit price / NAV in the holding's currency
  source TEXT NOT NULL DEFAULT 'manual',       -- 'stooq' | 'yahoo' | 'manual' | 'event'
  created_at TEXT NOT NULL,
  UNIQUE (holding_id, date, source)
);
-- Contribution plans (salary-linked recurring buys): one plan
-- per account + job + target holding. Frequency is NOT stored
-- — it derives from the linked job at read time. A generated
-- buy event carries plan_id + the own/employer split; a deleted
-- generated event leaves a tombstone row so generation never
-- recreates that due period (see src/plans.js).
CREATE TABLE IF NOT EXISTS invest_plans (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES invest_accounts(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES earn_jobs(id),
  target_holding_id INTEGER REFERENCES invest_holdings(id) ON DELETE SET NULL,
  start_date TEXT NOT NULL,                   -- 'YYYY-MM-DD', first due period
  own_amount REAL NOT NULL,                   -- payroll deduction per period, holding currency
  employer_amount REAL,                       -- employer match per period; RRSP only, NULL = none
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invest_plan_deleted (
  plan_id INTEGER NOT NULL REFERENCES invest_plans(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,                     -- 'YYYY-MM-DD' the user deleted
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_invest_holdings_account ON invest_holdings(account_id);
CREATE INDEX IF NOT EXISTS idx_invest_events_holding ON invest_events(holding_id, date, id);
CREATE INDEX IF NOT EXISTS idx_invest_prices_holding ON invest_prices(holding_id, date);
-- USD/CAD daily rates (Bank of Canada Valet FXUSDCAD), cached
-- the way prime_rates caches the prime series: fetch-on-read,
-- last known value when a fetch fails.
CREATE TABLE IF NOT EXISTS invest_fx_rates (
  date TEXT PRIMARY KEY,                       -- 'YYYY-MM-DD' observation date
  rate REAL NOT NULL,                          -- CAD per 1 USD
  source TEXT                                  -- series id the value came from
);
-- Earnings (salary + rental): flows, never assets — nothing here
-- feeds the net-worth summary. Salary jobs carry the inputs the
-- T4127-style estimate needs and nothing else: no SIN, birth date,
-- bank details, employer payroll account, or T4 fields. Rental years
-- carry T776-line expenses as JSON plus mortgage interest and
-- principal as SEPARATE columns — principal never flows to an
-- expense line. GST fields do not exist on this schema: long-term
-- rent is GST-exempt; short-term GST/ITC tracking belongs to the
-- future Tax module, not to a rental year row.
CREATE TABLE IF NOT EXISTS earn_jobs (
  id INTEGER PRIMARY KEY,
  employer TEXT NOT NULL,
  owner TEXT,                                   -- single earner username (T1 is per-person); NULL = unassigned
  currency TEXT NOT NULL DEFAULT 'CAD',
  province TEXT NOT NULL,                        -- employment province code (BC, ON, …)
  frequency TEXT NOT NULL,                      -- weekly | biweekly | semimonthly | monthly | annual
  gross_amount REAL NOT NULL,                   -- per-period if gross_basis='period', else annual
  gross_basis TEXT NOT NULL DEFAULT 'annual',   -- 'annual' | 'period'
  tax_year INTEGER NOT NULL,
  td1_federal REAL,                             -- NULL = default (federal BPA, phased out at high income)
  td1_provincial REAL,                          -- NULL = default (provincial BPA)
  ytd_cpp REAL NOT NULL DEFAULT 0,
  ytd_cpp2 REAL NOT NULL DEFAULT 0,
  ytd_ei REAL NOT NULL DEFAULT 0,
  cpp_exempt INTEGER NOT NULL DEFAULT 0,
  ei_exempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS earn_rentals (
  id INTEGER PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  address TEXT,
  rental_type TEXT NOT NULL,                    -- long_term | short_term | commercial
  services_level TEXT NOT NULL DEFAULT 'basic', -- basic (T776) | hotel_like (T2125)
  ownership_pct REAL NOT NULL DEFAULT 100,      -- owner's share of net (T1 line 12600)
  is_principal_residence INTEGER NOT NULL DEFAULT 0,
  was_principal_residence INTEGER NOT NULL DEFAULT 0,
  structural_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS earn_rental_years (
  id INTEGER PRIMARY KEY,
  rental_id INTEGER NOT NULL REFERENCES earn_rentals(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  gross_rents REAL NOT NULL DEFAULT 0,
  other_income REAL NOT NULL DEFAULT 0,         -- T776 line 8230
  area_share_pct REAL NOT NULL DEFAULT 100,     -- rented area share (partial rentals)
  rental_days INTEGER NOT NULL DEFAULT 365,     -- rented days in the year
  mortgage_interest REAL NOT NULL DEFAULT 0,    -- flows to T776 line 8710
  mortgage_principal REAL NOT NULL DEFAULT 0,   -- stored only; NEVER an expense
  expenses TEXT NOT NULL DEFAULT '[]',          -- [{line, amount, direct}] — line 8710 excluded (see above)
  claim_cca INTEGER NOT NULL DEFAULT 0,
  cca_acknowledged INTEGER NOT NULL DEFAULT 0,
  ucc_class1 REAL,                              -- Class 1 (4%) undepreciated capital cost
  ucc_class8 REAL,                              -- Class 8 (20%) UCC
  str_compliant_days INTEGER,
  str_non_compliant_days INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (rental_id, tax_year)
);
CREATE INDEX IF NOT EXISTS idx_earn_rental_years ON earn_rental_years(rental_id, tax_year);
CREATE TABLE IF NOT EXISTS earn_rental_entries (
  id INTEGER PRIMARY KEY,
  rental_id INTEGER NOT NULL REFERENCES earn_rentals(id) ON DELETE CASCADE,
  start_ym TEXT NOT NULL,                      -- 'YYYY-MM', first rent month
  end_ym TEXT,                                 -- 'YYYY-MM' or NULL = ongoing
  monthly_rent REAL NOT NULL DEFAULT 0,
  pay_day INTEGER NOT NULL,                    -- day of month rent is paid (1–31)
  cash_amount REAL,                            -- optional cash portion of monthly rent
  tenant_name TEXT,                            -- optional raw string; never a tenant record
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earn_rental_entries ON earn_rental_entries(rental_id, start_ym);
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

// Jobs predate the single-earner field; existing rows default to
// unassigned (NULL). New databases get the column from the CREATE
// TABLE above.
const earnJobCols = db.prepare('PRAGMA table_info(earn_jobs)').all().map((c) => c.name);
if (!earnJobCols.includes('owner')) {
  db.exec('ALTER TABLE earn_jobs ADD COLUMN owner TEXT');
}
// The simplified Add job form records the dates the derivation runs
// from; old rows predate them and keep NULL (a legacy save never
// touches these columns, so old jobs keep computing as before).
if (!earnJobCols.includes('start_date')) {
  db.exec('ALTER TABLE earn_jobs ADD COLUMN start_date TEXT');
}
if (!earnJobCols.includes('recent_pay_date')) {
  db.exec('ALTER TABLE earn_jobs ADD COLUMN recent_pay_date TEXT');
}
// Optional dated pay-change rows (effective date + new per-period
// value) and bonus entries (date + amount) for a job. Both are
// replaced wholesale on a derived save; deleting the job cascades.
db.exec(`CREATE TABLE IF NOT EXISTS earn_pay_changes (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES earn_jobs(id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS earn_bonuses (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES earn_jobs(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
)`);

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
// value_history: the land / building split columns (see the table
// comment). Existing points predate the split and stay NULL — no
// source is invented for them; a re-pull / re-fetch fills the
// years its payload actually carries a split for.
{
  const histCols = db.prepare('PRAGMA table_info(value_history)').all().map((c) => c.name);
  if (!histCols.includes('land_value')) {
    db.exec('ALTER TABLE value_history ADD COLUMN land_value REAL');
  }
  if (!histCols.includes('building_value')) {
    db.exec('ALTER TABLE value_history ADD COLUMN building_value REAL');
  }
}
// property_costs: databases created before per-month detail have
// no monthly_amounts column. Existing rows keep NULL (= an average
// given directly, no month-by-month detail) — exactly how they
// were always interpreted.
{
  const costCols = db.prepare('PRAGMA table_info(property_costs)').all().map((c) => c.name);
  if (costCols.length && !costCols.includes('monthly_amounts')) {
    db.exec('ALTER TABLE property_costs ADD COLUMN monthly_amounts TEXT');
  }
}
// invest_accounts: databases created before account default
// currencies have no default_currency column. Existing rows
// keep NULL — the default then derives from the holdings at
// read time (one currency wins, mixed falls back to CAD), so a
// single-currency account now opens in its own currency while
// a mixed account keeps opening in CAD, as before.
{
  const accCols = db.prepare('PRAGMA table_info(invest_accounts)').all().map((c) => c.name);
  if (accCols.length && !accCols.includes('default_currency')) {
    db.exec('ALTER TABLE invest_accounts ADD COLUMN default_currency TEXT');
  }
}
// invest_events: databases created before split events have no
// ratio columns. Existing rows keep NULL — they are not splits,
// exactly how they were always interpreted.
{
  const evCols = db.prepare('PRAGMA table_info(invest_events)').all().map((c) => c.name);
  if (evCols.length && !evCols.includes('split_new')) {
    db.exec('ALTER TABLE invest_events ADD COLUMN split_new REAL');
  }
  if (evCols.length && !evCols.includes('split_old')) {
    db.exec('ALTER TABLE invest_events ADD COLUMN split_old REAL');
  }
}
// invest_events: databases created before contribution plans
// have no plan link or own/employer split columns. Existing
// rows keep NULL — they are not plan events, exactly how they
// were always interpreted. The plan link is app-enforced (a
// plan delete clears it on its events, keeping the buys as
// ordinary history); no FK is declared on the added column.
{
  const evCols2 = db.prepare('PRAGMA table_info(invest_events)').all().map((c) => c.name);
  if (evCols2.length && !evCols2.includes('plan_id')) {
    db.exec('ALTER TABLE invest_events ADD COLUMN plan_id INTEGER');
  }
  if (evCols2.length && !evCols2.includes('own_amount')) {
    db.exec('ALTER TABLE invest_events ADD COLUMN own_amount REAL');
  }
  if (evCols2.length && !evCols2.includes('employer_amount')) {
    db.exec('ALTER TABLE invest_events ADD COLUMN employer_amount REAL');
  }
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
migrateOwners('invest_accounts');

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
// always CALCULATED first (from balance, rate plan and
// amortization); a term may then override it via the
// payment_override column below — a positive value makes the term
// run on that fixed payment, NULL means the calculated one rules.
// The property's own mortgage_payment column stays DORMANT — kept
// only so existing databases keep their shape; nothing reads or
// writes it.
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
  payment_override REAL,              -- optional monthly payment override for this term; NULL = the calculated payment rules
  payment_pricing_date TEXT,          -- RETIRED: the pricing anchor moved to the governing segment's locked_on (a property of the rate, not of the payment). Kept dormant so existing databases keep their shape; nothing reads or writes it, and stored values were migrated to the term's first segment's locked_on
  payment_frequency TEXT,             -- payment schedule for this term; NULL = fall back to the property mirror
  payment_day INTEGER,                -- deduction day 1..31 for this term; NULL = fall back
  anchor_balance REAL,                -- the property's balance anchor, when it lands inside this term after its start
  anchor_date TEXT,                   -- 'YYYY-MM-DD' of that anchor; both anchor columns are set together or neither
  ai_fields TEXT,                     -- JSON array of field names carrying the "filled by AI" flag
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
  // Per-segment compounding: every existing segment was priced
  // semi-annually (the only convention the engine had), so the
  // column lands with that default and no projection moves.
  if (segCols.length && !segCols.includes('compounding')) {
    db.exec("ALTER TABLE rate_segments ADD COLUMN compounding TEXT NOT NULL DEFAULT 'semi_annual'");
  }
  // Per-segment accrual: every existing segment accrued monthly
  // (the period's converted rate on the period-start balance);
  // 'daily' accrues the nominal annual rate day by day over the
  // period's actual days instead.
  if (segCols.length && !segCols.includes('accrual')) {
    db.exec("ALTER TABLE rate_segments ADD COLUMN accrual TEXT NOT NULL DEFAULT 'monthly'");
  }
  // Per-segment pricing lock (locked_on): the date a prime-spread
  // segment's rate was locked on. Existing segments carry no lock —
  // NULL is the long-standing behaviour (derivations price at the
  // derivation month) — so the column lands empty, apart from the
  // one-way move of retired term pricing dates further below.
  if (segCols.length && !segCols.includes('locked_on')) {
    db.exec('ALTER TABLE rate_segments ADD COLUMN locked_on TEXT');
  }
  // AI Fill provenance: a JSON array of the field names currently
  // carrying the "filled by AI" flag, per form (properties /
  // mortgage_terms) and per rate segment. Display metadata only —
  // extraction itself never writes business data.
  const propCols = db.prepare('PRAGMA table_info(properties)').all().map((c) => c.name);
  if (propCols.length && !propCols.includes('ai_fields')) {
    db.exec('ALTER TABLE properties ADD COLUMN ai_fields TEXT');
  }
  if (segCols.length && !segCols.includes('ai_fields')) {
    db.exec('ALTER TABLE rate_segments ADD COLUMN ai_fields TEXT');
  }
  // Terms from before repayment methods existed are level-payment
  // plans — the only shape the engine had — so the column lands
  // with that default and their projections do not move.
  const termCols = db.prepare('PRAGMA table_info(mortgage_terms)').all().map((c) => c.name);
  if (termCols.length && !termCols.includes('repayment_method')) {
    db.exec("ALTER TABLE mortgage_terms ADD COLUMN repayment_method TEXT NOT NULL DEFAULT 'equal_payment'");
  }
  if (termCols.length && !termCols.includes('ai_fields')) {
    db.exec('ALTER TABLE mortgage_terms ADD COLUMN ai_fields TEXT');
  }
  // Per-term payment schedule + balance anchors: the columns land
  // nullable and the backfill after the Term-1 pass seeds them from
  // the property, so a migrated mortgage behaves exactly as before.
  if (termCols.length) {
    if (!termCols.includes('payment_override')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN payment_override REAL');
    // The retired term-level payment pricing anchor (see the
    // CREATE TABLE note): the column may still land on databases
    // that predate it, so the one-way locked_on move below finds
    // the shape it expects; nothing else touches it.
    if (!termCols.includes('payment_pricing_date')) db.exec('ALTER TABLE mortgage_terms ADD COLUMN payment_pricing_date TEXT');
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
// One-way move of the retired term-level pricing anchor: a term's
// payment_pricing_date, when one was set, becomes its FIRST
// segment's locked_on — the anchor is a property of the rate that
// was locked, not of the payment. The term column is cleared as
// each value moves, so the move runs exactly once and a locked_on
// later edited by hand is never overwritten by a restart. A first
// segment already carrying a locked_on keeps it (the segment's own
// value wins); a term with no segments simply drops its date (the
// engine no longer reads the term field anywhere).
{
  const dated = db.prepare('SELECT id, payment_pricing_date FROM mortgage_terms WHERE payment_pricing_date IS NOT NULL').all();
  if (dated.length) {
    const firstSeg = db.prepare('SELECT id, locked_on FROM rate_segments WHERE term_id = ? ORDER BY start_date, id LIMIT 1');
    const setLock = db.prepare('UPDATE rate_segments SET locked_on = ? WHERE id = ?');
    const clear = db.prepare('UPDATE mortgage_terms SET payment_pricing_date = NULL WHERE id = ?');
    db.transaction(() => {
      for (const t of dated) {
        const seg = firstSeg.get(t.id);
        if (seg && seg.locked_on == null) setLock.run(t.payment_pricing_date, seg.id);
        clear.run(t.id);
      }
    })();
  }
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
