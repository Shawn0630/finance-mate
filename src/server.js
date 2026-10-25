// Finance Mate — server. Express + SQLite, no build step.
// Modules this round: Assets (properties / mortgages / other assets).
// Spending, Planning and Tax are placeholder pages in the UI for now.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, PHOTOS_DIR, AVATARS_DIR, seedUsers, verifyPassword, hashPassword, defaultAvatarColor } from './db.js';
import { simulate, derivePayment, segmentForMonth, FREQUENCIES, FREQUENCY_KEYS, periodPaymentFor } from './engine.js';
import { fetchAssessment, suggestAddresses } from './bca.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 9200);
const SESSION_DAYS = 30;

seedUsers();

const app = express();
app.use(express.json({ limit: '12mb' })); // photo uploads arrive as base64 JSON

// ---------------------------------------------------------------- auth ---
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).ff_session;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, new Date().toISOString());
  return row || null;
}

function requireApiAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  req.user = user;
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user)) {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, user.id, now.toISOString(), expires.toISOString());
  res.setHeader(
    'Set-Cookie',
    `ff_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  );
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).ff_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'ff_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireApiAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(userView(u));
});

// The public shape of a user wherever the UI shows one (top bar, owner
// chips, admin list): username + avatar. The users table is the single
// source for avatar data — nothing copies it onto properties or assets.
function userView(u) {
  return {
    id: u.id,
    username: u.username,
    avatarFile: u.avatar_file || null,
    avatarColor: u.avatar_color || defaultAvatarColor(u.username),
    isAdmin: u.username === adminUsername(),
    created_at: u.created_at,
  };
}

const adminUsername = () => process.env.SEED_ADMIN_USER || 'admin';

// Owner candidates with their avatars: every user EXCEPT admin. The
// admin account signs in to manage the app; it is never an owner
// candidate and never appears in the owner pickers.
app.get('/api/users', requireApiAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM users WHERE username != ? ORDER BY id')
    .all(adminUsername());
  res.json(rows.map((u) => ({
    username: u.username,
    avatarFile: u.avatar_file || null,
    avatarColor: u.avatar_color || defaultAvatarColor(u.username),
  })));
});

// --------------------------------------------------------------- owners ---
// Owners are a SET of usernames: joint ownership is expressed by picking
// several people — there is no 'Joint' value. Stored as a JSON array in
// the `owners` column; the API speaks `owners: string[]`.
function ownerCandidates() {
  return db
    .prepare('SELECT username FROM users WHERE username != ? ORDER BY id')
    .all(adminUsername())
    .map((r) => r.username);
}

function parseOwners(stored) {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Validates an incoming owners value. undefined passes through (the field
// is not being changed); a bare string is tolerated as a one-name list.
// Every name must be an existing non-admin user; 'Joint' and 'admin' get
// their own explicit errors. Returns { value } or { error }.
function cleanOwners(v) {
  if (v === undefined) return { value: undefined };
  let list = v;
  if (list === null || list === '') list = [];
  if (typeof list === 'string') list = [list];
  if (!Array.isArray(list)) return { error: 'owners must be a list of usernames' };
  const candidates = new Set(ownerCandidates());
  const names = [];
  for (const item of list) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    if (s === 'Joint') return { error: '"Joint" is not an owner — select the people who co-own it instead' };
    if (s === adminUsername()) return { error: 'admin cannot be an owner' };
    if (!candidates.has(s)) return { error: `unknown owner "${s}" — pick from the users list` };
    if (!names.includes(s)) names.push(s);
  }
  return { value: names };
}

// --------------------------------------------------------------- admin ---
// User management is admin-only. requireAdmin enforces it on the server
// for every /api/admin route (the UI also hides the Admin nav entry
// from non-admin users, but the check here is the real one).
function requireAdmin(req, res, next) {
  if (req.user.username !== adminUsername()) {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

app.get('/api/admin/users', requireApiAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(userView));
});

app.post('/api/admin/users', requireApiAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (!password) return res.status(400).json({ error: 'password is required' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(400).json({ error: `username "${username}" already exists` });
  }
  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (username, pass_hash, salt, avatar_color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, salt, defaultAvatarColor(username), nowIso());
  res.status(201).json(userView(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
});

app.post('/api/admin/users/:id/password', requireApiAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  const password = String((req.body || {}).password || '');
  if (!password) return res.status(400).json({ error: 'password is required' });
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, u.id);
  // A password reset signs that user out everywhere; they sign back in
  // with the new password.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireApiAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (u.username === adminUsername()) return res.status(400).json({ error: 'the admin user cannot be deleted' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'you cannot delete yourself' });
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    // Scrub the name out of every owners list, so owner data never
    // points at a user who no longer exists.
    for (const table of ['properties', 'other_assets']) {
      const rows = db.prepare(`SELECT id, owners FROM ${table} WHERE owners IS NOT NULL`).all();
      const upd = db.prepare(`UPDATE ${table} SET owners = ? WHERE id = ?`);
      for (const row of rows) {
        const names = parseOwners(row.owners);
        if (names.includes(u.username)) {
          upd.run(JSON.stringify(names.filter((n) => n !== u.username)), row.id);
        }
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  })();
  if (u.avatar_file) fs.promises.unlink(path.join(AVATARS_DIR, u.avatar_file)).catch(() => {});
  res.json({ ok: true });
});

// Avatar photo upload — same base64-JSON shape as property photos, but
// capped at 5 MB. The file lives in AVATARS_DIR; the user row stores
// only its name. Deleting the avatar restores the letter default.
app.post('/api/admin/users/:id/avatar', requireApiAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  const { dataBase64, contentType } = req.body || {};
  const exts = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = exts[contentType];
  if (!dataBase64 || !ext) return res.status(400).json({ error: 'expected { dataBase64, contentType: image/jpeg|png|webp|gif }' });
  const buf = Buffer.from(String(dataBase64), 'base64');
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'image empty or larger than 5 MB' });
  const name = `user-${u.id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(AVATARS_DIR, name), buf);
  if (u.avatar_file) fs.promises.unlink(path.join(AVATARS_DIR, u.avatar_file)).catch(() => {});
  db.prepare('UPDATE users SET avatar_file = ? WHERE id = ?').run(name, u.id);
  res.json(userView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});

app.delete('/api/admin/users/:id/avatar', requireApiAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (u.avatar_file) fs.promises.unlink(path.join(AVATARS_DIR, u.avatar_file)).catch(() => {});
  db.prepare('UPDATE users SET avatar_file = NULL WHERE id = ?').run(u.id);
  res.json(userView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});

// ------------------------------------------------------ address suggest ---
// Autocomplete for the address inputs. Suggestions come from BC
// Assessment's own address search (see suggestAddresses in bca.js), so a
// picked suggestion is exactly the address form the assessment fetch can
// match. Any failure on the BC Assessment side returns an empty list with
// sourceError set — the dropdown just shows no candidates, never an error.
app.get('/api/address/suggest', requireApiAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 4) return res.json({ suggestions: [] });
  try {
    const suggestions = await suggestAddresses(q);
    res.json({ suggestions });
  } catch (e) {
    res.json({ suggestions: [], sourceError: true, note: e.message });
  }
});

// ------------------------------------------------------------ properties ---
const nowIso = () => new Date().toISOString();
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
// Strict 'YYYY-MM-DD' calendar-date check (rejects 2021-13-40 etc.).
const isDateStr = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

function getProperty(id) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
}

function segmentsOf(propertyId) {
  return db
    .prepare('SELECT * FROM rate_segments WHERE property_id = ? ORDER BY start_date, id')
    .all(propertyId);
}

// The segment in effect today (for card summaries).
function currentSegment(segments) {
  const today = new Date().toISOString().slice(0, 7);
  return segmentForMonth(segments, today);
}

function propertyView(p) {
  const segments = segmentsOf(p.id);
  const cur = currentSegment(segments);
  return {
    ...p,
    owners: parseOwners(p.owners),
    segments,
    currentRate: cur ? { rate_type: cur.rate_type, annual_rate: cur.annual_rate, start_date: cur.start_date } : null,
  };
}

function assetView(a) {
  return { ...a, owners: parseOwners(a.owners) };
}

app.get('/api/properties', requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM properties ORDER BY id').all();
  res.json(rows.map(propertyView));
});

app.post('/api/properties', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.address || !String(b.address).trim()) return res.status(400).json({ error: 'address is required' });
  // Adding a property takes just the essentials (address + outstanding
  // balance; owner optional). The balance is the CURRENT balance, so its
  // date defaults to today unless one is supplied. Everything else
  // (payment, amortization, segments, notes, photo) is filled in later
  // on the detail page.
  const balance = num(b.mortgage_balance);
  if (balance === null || balance < 0) {
    return res.status(400).json({ error: 'outstanding principal is required' });
  }
  // Purchase date is required when adding (the column itself stays
  // nullable for properties recorded before it existed). It is NOT the
  // balance date: the balance date defaults to today (current balance),
  // the purchase date is the day the property was bought.
  if (b.purchase_date === undefined || b.purchase_date === null || b.purchase_date === '') {
    return res.status(400).json({ error: 'purchase date is required' });
  }
  if (!isDateStr(b.purchase_date)) {
    return res.status(400).json({ error: 'purchase date must be a valid date (YYYY-MM-DD)' });
  }
  const bcaId = b.bca_id ? String(b.bca_id) : null;
  const own = cleanOwners(b.owners !== undefined ? b.owners : b.owner);
  if (own.error) return res.status(400).json({ error: own.error });
  const info = db
    .prepare(
      `INSERT INTO properties (address, assessed_value, assessed_year, assessed_source,
         mortgage_balance, mortgage_balance_date, mortgage_payment, amortization_years,
         notes, bca_id, bca_matched_address, owners, purchase_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.address).trim(),
      num(b.assessed_value),
      num(b.assessed_year),
      b.assessed_value != null ? 'manual' : null,
      balance,
      b.mortgage_balance_date || new Date().toISOString().slice(0, 10),
      num(b.mortgage_payment),
      num(b.amortization_years),
      b.notes || null,
      bcaId,
      // The picked suggestion's label is the submitted address text
      // itself; the fetch later replaces this with the GIS-canonical form.
      bcaId ? String(b.address).trim() : null,
      JSON.stringify(own.value ?? []),
      b.purchase_date,
      nowIso(),
      nowIso()
    );
  res.status(201).json(propertyView(getProperty(info.lastInsertRowid)));
});

// ------------------------------------------------------------- portfolio --
// Aggregates across ALL properties for the Properties section's
// Portfolio block: totals, per-property shares, the assessed-value
// history summed by year, and the projected outstanding balances
// summed by month (with the per-property split for stacked bars).
// Defined before /api/properties/:id so 'portfolio' is not read as
// an id. All projection math reuses the single-property rules: the
// monthly payment is the entered one, else derived from the balance,
// the rate plan and the remaining amortization (as in the
// amortization endpoint); a property with no rate plan contributes
// its balance and payment but no interest and no projection.
app.get('/api/properties/portfolio', requireApiAuth, (req, res) => {
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const today = new Date().toISOString().slice(0, 10);
  const props = db.prepare('SELECT * FROM properties ORDER BY id').all();

  const perProperty = [];
  const monthMaps = new Map(); // property id -> Map('YYYY-MM' -> balance)
  const assessedPoints = new Map(); // property id -> [{ year, value }] sorted
  let interestFrom = 0;
  let withPlan = 0;

  for (const p of props) {
    const balance = p.mortgage_balance > 0 ? p.mortgage_balance : 0;
    const segments = segmentsOf(p.id);
    const balanceDate = p.mortgage_balance_date || today;
    // Monthly payment (entered wins; else derived exactly like the
    // amortization endpoint). Only meaningful with a balance.
    let monthlyPayment = null;
    if (balance > 0 && p.mortgage_payment > 0) {
      monthlyPayment = p.mortgage_payment;
    } else if (balance > 0 && segments.length && p.amortization_years > 0) {
      const seg = segmentForMonth(segments, balanceDate.slice(0, 7));
      monthlyPayment = derivePayment(balance, seg ? seg.annual_rate : 0, p.amortization_years);
    }
    let projectedInterest = null;
    if (balance > 0 && segments.length) withPlan++;
    if (balance > 0 && segments.length && monthlyPayment > 0) {
      const frequency = FREQUENCY_KEYS.includes(p.payment_frequency) ? p.payment_frequency : 'monthly';
      const r = simulate({ balance, balanceDate, payment: monthlyPayment, segments, paymentDay: p.payment_day ?? null, frequency });
      projectedInterest = r.totalInterest;
      interestFrom++;
      const map = new Map();
      for (const row of r.series) map.set(row.month, { balance: row.balance, last: row.month === r.series[r.series.length - 1].month });
      monthMaps.set(p.id, {
        map, payoffMonth: r.payoffMonth,
        firstMonth: r.series.length ? r.series[0].month : null,
        lastMonth: r.series.length ? r.series[r.series.length - 1].month : null,
        lastBalance: r.series.length ? r.series[r.series.length - 1].balance : 0,
      });
    }
    // Assessed history: the recorded value-history points; a property
    // with a stored assessed value but no points contributes that one
    // point in its assessed year.
    let points = historyPoints(p.id).map((pt) => ({ year: pt.year, value: pt.value }));
    if (!points.length && p.assessed_value != null && p.assessed_year) {
      points = [{ year: p.assessed_year, value: p.assessed_value }];
    }
    assessedPoints.set(p.id, points);
    const latestAssessed = points.length ? points[points.length - 1].value : (p.assessed_value ?? null);
    perProperty.push({
      id: p.id,
      label: p.address,
      shortLabel: String(p.address).split(',')[0],
      outstanding: balance,
      monthlyPayment: monthlyPayment > 0 ? monthlyPayment : 0,
      paymentKnown: monthlyPayment > 0,
      hasPlan: segments.length > 0,
      projectedInterest,
      latestAssessed,
    });
  }

  const totalOutstanding = r2(perProperty.reduce((s, x) => s + x.outstanding, 0));
  const totalAssessed = r2(perProperty.reduce((s, x) => s + (x.latestAssessed || 0), 0));
  const slices = (pick, total) => perProperty
    .filter((x) => pick(x) > 0 && total > 0)
    .map((x) => ({ id: x.id, label: x.label, shortLabel: x.shortLabel, value: pick(x), pct: r2((pick(x) / total) * 100) }));

  // Assessed totals by year, carry-forward: a property counts from
  // its first known year on, at its most recent point at or before
  // the year; years before its first point it is not counted.
  const years = [...new Set(perProperty.flatMap((x) => (assessedPoints.get(x.id) || []).map((pt) => pt.year)))].sort((a, b) => a - b);
  const assessedByYear = years.map((year) => {
    let total = 0;
    for (const x of perProperty) {
      const pts = assessedPoints.get(x.id) || [];
      let v = null;
      for (const pt of pts) { if (pt.year <= year) v = pt.value; else break; }
      if (v !== null) total += v;
    }
    return { year, total: r2(total) };
  });

  // Outstanding by month: union of all projection months. A property
  // is null before its first projected month (not counted — never
  // back-filled with its current balance); after its last month it is
  // 0 when it paid off, else its final projected balance held flat
  // (its projection hit the horizon cap). total is exactly the sum of
  // the non-null parts, so stacked bars top out at the total line.
  const months = [...new Set([...monthMaps.values()].flatMap((m) => [...m.map.keys()]))].sort();
  const outstandingByMonth = months.map((month) => {
    const byProperty = {};
    let total = 0;
    for (const x of perProperty) {
      const m = monthMaps.get(x.id);
      let v = null;
      if (m) {
        if (m.map.has(month)) v = m.map.get(month).balance;
        else if (month > m.lastMonth) v = m.payoffMonth ? 0 : m.lastBalance;
      }
      byProperty[x.id] = v;
      if (v !== null) total += v;
    }
    return { month, total: r2(total), byProperty };
  });

  res.json({
    totals: {
      outstanding: totalOutstanding,
      monthlyPayment: r2(perProperty.reduce((s, x) => s + x.monthlyPayment, 0)),
      totalInterest: r2(perProperty.reduce((s, x) => s + (x.projectedInterest || 0), 0)),
      interestFrom,
      withPlan,
      propertyCount: perProperty.length,
      paymentKnownCount: perProperty.filter((x) => x.paymentKnown).length,
      assessedTotal: totalAssessed,
    },
    properties: perProperty,
    pie: {
      outstanding: slices((x) => x.outstanding, totalOutstanding),
      assessed: slices((x) => x.latestAssessed || 0, totalAssessed),
    },
    assessedByYear,
    outstandingByMonth,
  });
});

app.get('/api/properties/:id', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  res.json(propertyView(p));
});

app.put('/api/properties/:id', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const b = req.body || {};
  const next = {
    address: b.address !== undefined ? String(b.address).trim() : p.address,
    // bca_id is owned by the address field: forms that submit the address
    // always send it (null when the text is free-typed or was edited after
    // picking a suggestion); forms that don't (e.g. the mortgage form)
    // leave it untouched.
    bca_id: b.bca_id !== undefined ? (b.bca_id ? String(b.bca_id) : null) : p.bca_id,
    bca_matched_address:
      b.bca_id !== undefined
        ? (b.bca_id ? (b.address !== undefined ? String(b.address).trim() : p.address) : null)
        : p.bca_matched_address,
    photo_url: b.photo_url !== undefined ? b.photo_url || null : p.photo_url,
    assessed_value: b.assessed_value !== undefined ? num(b.assessed_value) : p.assessed_value,
    assessed_year: b.assessed_year !== undefined ? num(b.assessed_year) : p.assessed_year,
    assessed_source: p.assessed_source,
    mortgage_balance: b.mortgage_balance !== undefined ? num(b.mortgage_balance) : p.mortgage_balance,
    mortgage_balance_date: b.mortgage_balance_date !== undefined ? b.mortgage_balance_date || null : p.mortgage_balance_date,
    mortgage_payment: b.mortgage_payment !== undefined ? num(b.mortgage_payment) : p.mortgage_payment,
    amortization_years: b.amortization_years !== undefined ? num(b.amortization_years) : p.amortization_years,
    notes: b.notes !== undefined ? b.notes || null : p.notes,
    owners: parseOwners(p.owners),
    // Purchase date can be changed any time on the detail page (the Add
    // form requires it, editing does not re-require it).
    purchase_date: b.purchase_date !== undefined ? (b.purchase_date || null) : p.purchase_date,
    // Payment day is edited from the rate-plan area; null clears it.
    payment_day: p.payment_day ?? null,
    // Payment frequency is edited from the rate-plan area too; NULL in
    // the database (rows that predate it) means 'monthly'.
    payment_frequency: p.payment_frequency ?? null,
  };
  if (b.purchase_date !== undefined && b.purchase_date && !isDateStr(b.purchase_date)) {
    return res.status(400).json({ error: 'purchase date must be a valid date (YYYY-MM-DD)' });
  }
  if (b.payment_day !== undefined) {
    if (b.payment_day === null || b.payment_day === '') {
      next.payment_day = null;
    } else {
      const d = Number(b.payment_day);
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        return res.status(400).json({ error: 'payment day must be a whole number between 1 and 31' });
      }
      next.payment_day = d;
    }
  }
  if (b.payment_frequency !== undefined) {
    if (b.payment_frequency === null || b.payment_frequency === '') {
      next.payment_frequency = null;
    } else if (!FREQUENCY_KEYS.includes(String(b.payment_frequency))) {
      return res.status(400).json({
        error: `payment frequency must be one of: ${FREQUENCY_KEYS.map((k) => FREQUENCIES[k].label).join(', ')}`,
      });
    } else {
      next.payment_frequency = String(b.payment_frequency);
    }
  }
  if (b.owners !== undefined || b.owner !== undefined) {
    const own = cleanOwners(b.owners !== undefined ? b.owners : b.owner);
    if (own.error) return res.status(400).json({ error: own.error });
    next.owners = own.value;
  }
  if (!next.address) return res.status(400).json({ error: 'address is required' });
  // Editing the assessed value by hand marks it as a manual value.
  if (b.assessed_value !== undefined && num(b.assessed_value) !== p.assessed_value) next.assessed_source = 'manual';
  db.prepare(
    `UPDATE properties SET address=?, bca_id=?, bca_matched_address=?, photo_url=?,
       assessed_value=?, assessed_year=?, assessed_source=?, mortgage_balance=?,
       mortgage_balance_date=?, mortgage_payment=?, amortization_years=?, notes=?,
       owners=?, purchase_date=?, payment_day=?, payment_frequency=?, updated_at=? WHERE id=?`
  ).run(
    next.address, next.bca_id, next.bca_matched_address, next.photo_url,
    next.assessed_value, next.assessed_year, next.assessed_source,
    next.mortgage_balance, next.mortgage_balance_date, next.mortgage_payment,
    next.amortization_years, next.notes, JSON.stringify(next.owners), next.purchase_date,
    next.payment_day, next.payment_frequency, nowIso(), p.id
  );
  res.json(propertyView(getProperty(p.id)));
});

app.delete('/api/properties/:id', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  if (p.photo_file) fs.promises.unlink(path.join(PHOTOS_DIR, p.photo_file)).catch(() => {});
  db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// Best-effort BC Assessment fetch: never blocks saving; on success it fills
// the value fields and marks them source='auto', on failure it reports the
// stage that failed and leaves the stored values untouched.
app.post('/api/properties/:id/fetch-bca', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  try {
    // A property whose address was picked from the suggestion dropdown
    // carries the BC Assessment property id: go straight to its page
    // instead of running the fuzzy address search again.
    const direct = p.bca_id ? { id: p.bca_id, label: p.bca_matched_address || p.address } : undefined;
    const r = await fetchAssessment(p.address, direct);
    db.prepare(
      `UPDATE properties SET assessed_value=?, assessed_year=?, land_value=?, building_value=?,
         assessed_source='auto', assessed_fetched_at=?, bca_matched_address=?, bca_extract_date=?,
         updated_at=? WHERE id=?`
    ).run(
      r.assessedValue, r.assessedYear, r.landValue, r.buildingValue,
      nowIso(), r.matchedAddress, r.extractDate, nowIso(), p.id
    );
    // Record this year's point on the value-trend history (one row per
    // year; a re-fetch refreshes that year's auto point in place).
    if (r.assessedValue != null && r.assessedYear) {
      db.prepare(
        `INSERT INTO value_history (property_id, year, value, source, created_at, updated_at)
         VALUES (?, ?, ?, 'auto', ?, ?)
         ON CONFLICT(property_id, year) DO UPDATE SET
           value = excluded.value, source = 'auto', updated_at = excluded.updated_at`
      ).run(p.id, r.assessedYear, r.assessedValue, nowIso(), nowIso());
    }
    res.json({ ok: true, result: r, property: propertyView(getProperty(p.id)) });
  } catch (e) {
    res.json({ ok: false, stage: e.stage || 'unknown', error: e.message });
  }
});

// Photo upload as base64 JSON (keeps us dependency-free; ~12 MB body limit).
app.post('/api/properties/:id/photo-upload', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const { dataBase64, contentType } = req.body || {};
  const exts = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = exts[contentType];
  if (!dataBase64 || !ext) return res.status(400).json({ error: 'expected { dataBase64, contentType: image/jpeg|png|webp|gif }' });
  const buf = Buffer.from(String(dataBase64), 'base64');
  if (buf.length === 0 || buf.length > 9 * 1024 * 1024) return res.status(400).json({ error: 'image empty or too large' });
  const name = `property-${p.id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, name), buf);
  if (p.photo_file) fs.promises.unlink(path.join(PHOTOS_DIR, p.photo_file)).catch(() => {});
  db.prepare('UPDATE properties SET photo_file=?, photo_url=NULL, updated_at=? WHERE id=?').run(name, nowIso(), p.id);
  res.json(propertyView(getProperty(p.id)));
});

// Uploaded photos (login required).
app.get('/photos/:name', (req, res) => {
  if (!currentUser(req)) return res.status(401).json({ error: 'not signed in' });
  const name = path.basename(req.params.name);
  const file = path.join(PHOTOS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'photo not found' });
  res.sendFile(file);
});

// Uploaded user avatars (login required — every signed-in user sees
// them in the top bar and on owner chips).
app.get('/avatars/:name', (req, res) => {
  if (!currentUser(req)) return res.status(401).json({ error: 'not signed in' });
  const name = path.basename(req.params.name);
  const file = path.join(AVATARS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'avatar not found' });
  res.sendFile(file);
});

// --------------------------------------------------------- value history ---
// Assessed-value trend points, one per assessment year. Auto points come
// from BC Assessment fetches (current year only — the public GIS data has
// no prior-year fields); manual points fill in earlier years.
function historyPoints(propertyId) {
  return db.prepare('SELECT * FROM value_history WHERE property_id = ? ORDER BY year').all(propertyId);
}

function historyView(propertyId) {
  const points = historyPoints(propertyId);
  let change = null;
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    change = {
      fromYear: first.year, toYear: last.year, from: first.value, to: last.value,
      abs: last.value - first.value,
      pct: first.value ? ((last.value - first.value) / first.value) * 100 : null,
    };
  }
  return { points, change };
}

function validYearValue(b) {
  const year = Number(b.year);
  const value = num(b.value);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return { error: 'year must be a whole year between 1900 and 2100' };
  if (value === null || value < 0) return { error: 'value must be a number >= 0' };
  return { year, value };
}

app.get('/api/properties/:id/value-history', requireApiAuth, (req, res) => {
  if (!getProperty(req.params.id)) return res.status(404).json({ error: 'property not found' });
  res.json(historyView(req.params.id));
});

app.post('/api/properties/:id/value-history', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const v = validYearValue(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare(
    `INSERT INTO value_history (property_id, year, value, source, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?)
     ON CONFLICT(property_id, year) DO UPDATE SET
       value = excluded.value, source = 'manual', notes = excluded.notes, updated_at = excluded.updated_at`
  ).run(p.id, v.year, v.value, (req.body || {}).notes || null, nowIso(), nowIso());
  res.status(201).json(historyView(p.id));
});

app.put('/api/properties/:id/value-history/:pointId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const pt = db.prepare('SELECT * FROM value_history WHERE id = ? AND property_id = ?').get(req.params.pointId, p.id);
  if (!pt) return res.status(404).json({ error: 'history point not found' });
  const b = req.body || {};
  const v = validYearValue({ year: b.year !== undefined ? b.year : pt.year, value: b.value !== undefined ? b.value : pt.value });
  if (v.error) return res.status(400).json({ error: v.error });
  // Hand-editing a value turns the point into a manual one.
  const source = b.value !== undefined && Number(b.value) !== pt.value ? 'manual' : pt.source;
  try {
    db.prepare('UPDATE value_history SET year=?, value=?, source=?, notes=?, updated_at=? WHERE id=?')
      .run(v.year, v.value, source, b.notes !== undefined ? b.notes || null : pt.notes, nowIso(), pt.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: `a point for ${v.year} already exists` });
    throw e;
  }
  res.json(historyView(p.id));
});

app.delete('/api/properties/:id/value-history/:pointId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM value_history WHERE id = ? AND property_id = ?').run(req.params.pointId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'history point not found' });
  res.json(historyView(req.params.id));
});

// ---------------------------------------------------------- rate segments ---
app.post('/api/properties/:id/rates', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const b = req.body || {};
  if (!b.start_date) return res.status(400).json({ error: 'start_date is required' });
  if (!['fixed', 'variable'].includes(b.rate_type)) return res.status(400).json({ error: 'rate_type must be fixed or variable' });
  if (num(b.annual_rate) === null || num(b.annual_rate) < 0) return res.status(400).json({ error: 'annual_rate must be a number >= 0' });
  const info = db
    .prepare('INSERT INTO rate_segments (property_id, start_date, rate_type, annual_rate, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, String(b.start_date), b.rate_type, num(b.annual_rate), nowIso());
  res.status(201).json(db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/properties/:id/rates/:segId', requireApiAuth, (req, res) => {
  const seg = db.prepare('SELECT * FROM rate_segments WHERE id = ? AND property_id = ?').get(req.params.segId, req.params.id);
  if (!seg) return res.status(404).json({ error: 'segment not found' });
  const b = req.body || {};
  const next = {
    start_date: b.start_date !== undefined ? String(b.start_date) : seg.start_date,
    rate_type: b.rate_type !== undefined ? b.rate_type : seg.rate_type,
    annual_rate: b.annual_rate !== undefined ? num(b.annual_rate) : seg.annual_rate,
  };
  if (!['fixed', 'variable'].includes(next.rate_type)) return res.status(400).json({ error: 'rate_type must be fixed or variable' });
  if (next.annual_rate === null || next.annual_rate < 0) return res.status(400).json({ error: 'annual_rate must be a number >= 0' });
  db.prepare('UPDATE rate_segments SET start_date=?, rate_type=?, annual_rate=? WHERE id=?')
    .run(next.start_date, next.rate_type, next.annual_rate, seg.id);
  res.json(db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(seg.id));
});

app.delete('/api/properties/:id/rates/:segId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM rate_segments WHERE id = ? AND property_id = ?').run(req.params.segId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'segment not found' });
  res.json({ ok: true });
});

// ------------------------------------------------------- mortgage chart ---
// Monthly projection from the stored balance. The projection is computed
// ONLY from the user's own rate plan (the rate segments): there is no
// default or assumed rate anywhere. With no segments the endpoint reports
// a NO_RATE_PLAN state instead of projecting at 0%. The monthly payment
// stored on the property wins; otherwise it is derived from the balance,
// the rate plan and the remaining amortization years.
app.get('/api/properties/:id/amortization', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const segments = segmentsOf(p.id);
  if (p.mortgage_balance === null || p.mortgage_balance === undefined || !(p.mortgage_balance > 0)) {
    return res.json({ ok: false, error: 'no outstanding principal recorded for this property', segments });
  }
  if (segments.length === 0) {
    return res.json({ ok: false, code: 'NO_RATE_PLAN', error: 'no rate plan yet', segments });
  }
  const balanceDate = p.mortgage_balance_date || new Date().toISOString().slice(0, 10);
  let payment = p.mortgage_payment;
  let paymentSource = 'entered';
  if (!(payment > 0)) {
    if (!(p.amortization_years > 0)) {
      return res.json({ ok: false, code: 'NO_PAYMENT', error: 'enter a monthly payment or a remaining amortization (years) to project the mortgage', segments });
    }
    const firstMonth = balanceDate.slice(0, 7);
    const seg = segmentForMonth(segments, firstMonth);
    payment = derivePayment(p.mortgage_balance, seg ? seg.annual_rate : 0, p.amortization_years);
    paymentSource = 'derived';
  }
  // The payment day only anchors the series' node dates (see engine);
  // it never enters the interest math. The payment frequency drives
  // the period stepping and the per-period amount (both in the
  // engine); `payment` here stays the MONTHLY amount throughout.
  const frequency = FREQUENCY_KEYS.includes(p.payment_frequency) ? p.payment_frequency : 'monthly';
  const r = simulate({ balance: p.mortgage_balance, balanceDate, payment, segments, paymentDay: p.payment_day ?? null, frequency });
  res.json({
    ok: true,
    balance: p.mortgage_balance,
    balanceDate,
    paymentUsed: payment,
    paymentSource,
    frequency,
    frequencyLabel: FREQUENCIES[frequency].label,
    periodsPerYear: FREQUENCIES[frequency].periodsPerYear,
    periodPayment: periodPaymentFor(payment, frequency),
    series: r.series,
    totalInterest: r.totalInterest,
    payoffMonth: r.payoffMonth,
    negativeAmortization: r.negativeAmortization,
  });
});

// Equity snapshot for the detail page: the latest assessed value (the
// newest value-history point when there is one, else the value stored on
// the property) minus the current outstanding principal. Either side may be
// missing; the missing side comes back null and equity is null.
app.get('/api/properties/:id/equity', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const points = historyPoints(p.id);
  const latest = points.length ? points[points.length - 1] : null;
  const assessed = latest ? latest.value : (p.assessed_value ?? null);
  const assessedYear = latest ? latest.year : (p.assessed_year ?? null);
  const balance = p.mortgage_balance ?? null;
  res.json({
    assessedValue: assessed,
    assessedYear,
    balance,
    equity: assessed !== null && balance !== null ? assessed - balance : null,
  });
});

// ------------------------------------------------------------ other assets ---
const ASSET_CATEGORIES = ['fixed_assets', 'stocks', 'term_deposits', 'other'];

app.get('/api/assets', requireApiAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM other_assets ORDER BY category, id').all().map(assetView));
});

app.get('/api/assets/:id', requireApiAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM other_assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'asset not found' });
  res.json(assetView(a));
});

app.post('/api/assets', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!ASSET_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'unknown category' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
  const own = cleanOwners(b.owners !== undefined ? b.owners : b.owner);
  if (own.error) return res.status(400).json({ error: own.error });
  const info = db
    .prepare('INSERT INTO other_assets (category, name, value, currency, notes, owners, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.category, String(b.name).trim(), num(b.value) ?? 0, b.currency || 'CAD', b.notes || null, JSON.stringify(own.value ?? []), nowIso(), nowIso());
  res.status(201).json(assetView(db.prepare('SELECT * FROM other_assets WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/assets/:id', requireApiAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM other_assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'asset not found' });
  const b = req.body || {};
  const next = {
    category: b.category !== undefined ? b.category : a.category,
    name: b.name !== undefined ? String(b.name).trim() : a.name,
    value: b.value !== undefined ? num(b.value) ?? 0 : a.value,
    currency: b.currency !== undefined ? b.currency : a.currency,
    notes: b.notes !== undefined ? b.notes || null : a.notes,
    owners: parseOwners(a.owners),
  };
  if (b.owners !== undefined || b.owner !== undefined) {
    const own = cleanOwners(b.owners !== undefined ? b.owners : b.owner);
    if (own.error) return res.status(400).json({ error: own.error });
    next.owners = own.value;
  }
  if (!ASSET_CATEGORIES.includes(next.category)) return res.status(400).json({ error: 'unknown category' });
  if (!next.name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE other_assets SET category=?, name=?, value=?, currency=?, notes=?, owners=?, updated_at=? WHERE id=?')
    .run(next.category, next.name, next.value, next.currency, next.notes, JSON.stringify(next.owners), nowIso(), a.id);
  res.json(assetView(db.prepare('SELECT * FROM other_assets WHERE id = ?').get(a.id)));
});

app.delete('/api/assets/:id', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM other_assets WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'asset not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- summary ---
app.get('/api/summary', requireApiAuth, (req, res) => {
  const props = db.prepare('SELECT * FROM properties').all();
  const propertyValue = props.reduce((s, p) => s + (p.assessed_value || 0), 0);
  const mortgageBalance = props.reduce((s, p) => s + (p.mortgage_balance || 0), 0);
  const otherAssets = db.prepare('SELECT COALESCE(SUM(value), 0) AS s FROM other_assets').get().s;
  res.json({
    propertyValue,
    mortgageBalance,
    otherAssets,
    netWorth: propertyValue + otherAssets - mortgageBalance,
    propertyCount: props.length,
  });
});

// ------------------------------------------------------------------ pages ---
app.get('/', (req, res) => {
  if (!currentUser(req)) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/index.html', (req, res) => {
  if (!currentUser(req)) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use(express.static(PUBLIC_DIR, { index: false }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

// Exported for the e2e test; listening happens only when run directly.
export { app };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  app.listen(PORT, () => console.log(`[finance-mate] listening on http://localhost:${PORT} (data: ${DATA_DIR})`));
}
