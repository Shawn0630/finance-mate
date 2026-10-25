// Finance Mate — server. Express + SQLite, no build step.
// Modules this round: Assets (properties / mortgages / other assets).
// Spending, Planning and Tax are placeholder pages in the UI for now.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, PHOTOS_DIR, seedUsers, verifyPassword } from './db.js';
import { simulate, derivePayment, segmentForMonth } from './engine.js';
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

app.get('/api/me', requireApiAuth, (req, res) => res.json({ username: req.user.username }));

// Usernames for the owner dropdowns. Includes admin: it is a real login
// and can own assets the same way; 'Joint' is added client-side for
// properties only (and enforced server-side below).
app.get('/api/users', requireApiAuth, (req, res) => {
  res.json(db.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username));
});

// ------------------------------------------------------------ owners ---
// Owner is a username, 'Joint' (properties only), or null. Anything else
// is rejected so the dropdown data stays clean.
function cleanOwner(v, allowJoint) {
  if (v === undefined) return { value: undefined };
  const s = v === null ? '' : String(v).trim();
  if (!s) return { value: null };
  if (s === 'Joint') {
    if (!allowJoint) return { error: 'Joint ownership is only available for properties' };
    return { value: 'Joint' };
  }
  const known = db.prepare('SELECT 1 FROM users WHERE username = ?').get(s);
  if (!known) return { error: `unknown owner "${s}" — pick one of the users` };
  return { value: s };
}

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
    segments,
    currentRate: cur ? { rate_type: cur.rate_type, annual_rate: cur.annual_rate, start_date: cur.start_date } : null,
  };
}

app.get('/api/properties', requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM properties ORDER BY id').all();
  res.json(rows.map(propertyView));
});

app.post('/api/properties', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.address || !String(b.address).trim()) return res.status(400).json({ error: 'address is required' });
  const bcaId = b.bca_id ? String(b.bca_id) : null;
  const own = cleanOwner(b.owner, true);
  if (own.error) return res.status(400).json({ error: own.error });
  const info = db
    .prepare(
      `INSERT INTO properties (address, assessed_value, assessed_year, assessed_source,
         mortgage_balance, mortgage_balance_date, mortgage_payment, amortization_years,
         notes, bca_id, bca_matched_address, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.address).trim(),
      num(b.assessed_value),
      num(b.assessed_year),
      b.assessed_value != null ? 'manual' : null,
      num(b.mortgage_balance),
      b.mortgage_balance_date || null,
      num(b.mortgage_payment),
      num(b.amortization_years),
      b.notes || null,
      bcaId,
      // The picked suggestion's label is the submitted address text
      // itself; the fetch later replaces this with the GIS-canonical form.
      bcaId ? String(b.address).trim() : null,
      own.value ?? null,
      nowIso(),
      nowIso()
    );
  res.status(201).json(propertyView(getProperty(info.lastInsertRowid)));
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
    owner: p.owner,
  };
  if (b.owner !== undefined) {
    const own = cleanOwner(b.owner, true);
    if (own.error) return res.status(400).json({ error: own.error });
    next.owner = own.value;
  }
  if (!next.address) return res.status(400).json({ error: 'address is required' });
  // Editing the assessed value by hand marks it as a manual value.
  if (b.assessed_value !== undefined && num(b.assessed_value) !== p.assessed_value) next.assessed_source = 'manual';
  db.prepare(
    `UPDATE properties SET address=?, bca_id=?, bca_matched_address=?, photo_url=?,
       assessed_value=?, assessed_year=?, assessed_source=?, mortgage_balance=?,
       mortgage_balance_date=?, mortgage_payment=?, amortization_years=?, notes=?,
       owner=?, updated_at=? WHERE id=?`
  ).run(
    next.address, next.bca_id, next.bca_matched_address, next.photo_url,
    next.assessed_value, next.assessed_year, next.assessed_source,
    next.mortgage_balance, next.mortgage_balance_date, next.mortgage_payment,
    next.amortization_years, next.notes, next.owner, nowIso(), p.id
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
// Monthly projection from the stored balance. The monthly payment stored on
// the property wins; otherwise it is derived from the remaining
// amortization years and the rate in effect for the first projected month.
app.get('/api/properties/:id/amortization', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const segments = segmentsOf(p.id);
  if (p.mortgage_balance === null || p.mortgage_balance === undefined || !(p.mortgage_balance > 0)) {
    return res.json({ ok: false, error: 'no mortgage balance recorded for this property', segments });
  }
  const balanceDate = p.mortgage_balance_date || new Date().toISOString().slice(0, 10);
  let payment = p.mortgage_payment;
  let paymentSource = 'entered';
  if (!(payment > 0)) {
    if (!(p.amortization_years > 0)) {
      return res.json({ ok: false, error: 'enter a monthly payment or a remaining amortization (years) to project the mortgage', segments });
    }
    const firstMonth = balanceDate.slice(0, 7);
    const seg = segmentForMonth(segments, firstMonth);
    payment = derivePayment(p.mortgage_balance, seg ? seg.annual_rate : 0, p.amortization_years);
    paymentSource = 'derived';
  }
  const r = simulate({ balance: p.mortgage_balance, balanceDate, payment, segments });
  res.json({
    ok: true,
    paymentUsed: payment,
    paymentSource,
    hasRates: segments.length > 0,
    series: r.series,
    totalInterest: r.totalInterest,
    payoffMonth: r.payoffMonth,
    negativeAmortization: r.negativeAmortization,
  });
});

// ------------------------------------------------------------ other assets ---
const ASSET_CATEGORIES = ['fixed_assets', 'stocks', 'term_deposits', 'other'];

app.get('/api/assets', requireApiAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM other_assets ORDER BY category, id').all());
});

app.get('/api/assets/:id', requireApiAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM other_assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'asset not found' });
  res.json(a);
});

app.post('/api/assets', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!ASSET_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'unknown category' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
  const own = cleanOwner(b.owner, false);
  if (own.error) return res.status(400).json({ error: own.error });
  const info = db
    .prepare('INSERT INTO other_assets (category, name, value, currency, notes, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.category, String(b.name).trim(), num(b.value) ?? 0, b.currency || 'CAD', b.notes || null, own.value ?? null, nowIso(), nowIso());
  res.status(201).json(db.prepare('SELECT * FROM other_assets WHERE id = ?').get(info.lastInsertRowid));
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
    owner: a.owner,
  };
  if (b.owner !== undefined) {
    const own = cleanOwner(b.owner, false);
    if (own.error) return res.status(400).json({ error: own.error });
    next.owner = own.value;
  }
  if (!ASSET_CATEGORIES.includes(next.category)) return res.status(400).json({ error: 'unknown category' });
  if (!next.name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE other_assets SET category=?, name=?, value=?, currency=?, notes=?, owner=?, updated_at=? WHERE id=?')
    .run(next.category, next.name, next.value, next.currency, next.notes, next.owner, nowIso(), a.id);
  res.json(db.prepare('SELECT * FROM other_assets WHERE id = ?').get(a.id));
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
