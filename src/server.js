// Finance Mate — server. Express + SQLite, no build step.
// Modules this round: Assets (properties / mortgages / other assets).
// Spending, Planning and Tax are placeholder pages in the UI for now.
import './env.js'; // .env fallback values first, before anything reads the env
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, PHOTOS_DIR, AVATARS_DIR, seedUsers, verifyPassword, hashPassword, defaultAvatarColor } from './db.js';
import { buildSchedule, segmentForMonth, segmentAnnualRate, remainingBalanceAt, FREQUENCIES, FREQUENCY_KEYS, periodPaymentFor } from './engine.js';
import { getRegion, REGION_CODES } from './regions/index.js';
import { getCurrentPrime, getPrimeHistory, ensureFreshPrime, refreshPrime, primeInfo, primeStatus, vancouverToday } from './prime.js';
import {
  applyBcaFetchResult, noteBcaAttempt, ensureFreshAssessment, bcaRefreshStatus,
  runHouseSigmaPull, houseSigmaPullStatus, pullHouseSigmaHistoryInBackground,
} from './assessed.js';
import { handleAiFill, handleAiFillChat, handleAiInvestFillChat, llmModels, llmDefaultModel, llmConfigured, callLlm, parseModelJson } from './aiFill.js';
import { costsView, listCosts, validCostInput, upsertCost, parseStoredMonthlyAmounts } from './costs.js';
import {
  ACCOUNT_TYPES, EVENT_TYPES, validAccountInput, validHoldingInput, validEventInput, validNavInput, validInitialEvents,
  addNavPoint, updateNavPoint,
  listAccounts, getAccount, listHoldings, getHolding, listEvents, listPricePoints, rebuildEventPricePoints,
  computeHolding, computeAccount, computePortfolio, computeFillPreview,
  effectiveAccountDefaultCurrency, pinCadReturnPct,
} from './investments.js';
import { ensureHoldingPrices, ensureFxRates, refreshAllPrices, priceStatusFor, makeFxResolver, searchSecurities, clearHoldingPriceMeta } from './prices.js';
import { parseWealthsimpleCsv, validateImportApply } from './wsImport.js';
import {
  PAY_FREQUENCIES, validJobInput, validRentalInput, validRentalYearInput, validRentalEntryInput,
  calcSalary, calcRentalYear, aggregateEarningsCharts, deriveJobYtd,
  deriveRentalYearFigures, entryCoveredYears,
} from './earnings.js';
import {
  validPlanInput, listPlans, getPlan, planView, generatePlan, generatePlansForAccount,
  recordPlanEventDeletion,
} from './plans.js';
import { analyzeCsv, activityValuesFor, applyMappedCsv, proposeCsvMapping, reviseCsvMapping, translatePreview } from './csvMapImport.js';
import {
  SPEND_CATEGORIES, parseQfx, validateSpendApply, normalizeMerchant, validSpendDate,
  spendMonthly, spendTotal,
} from './spending.js';

// Region-specific providers (assessment search/fetch) are reached
// through the region implementation, never directly.
const assessmentFor = (regionCode) => (getRegion(regionCode) || getRegion('CA')).assessment;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 9200);
const SESSION_DAYS = 30;

seedUsers();

const app = express();
app.use(express.json({ limit: '48mb' })); // photo uploads arrive as base64 JSON (a gallery batch can carry several)

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

// ---------------------------------------------------------- preferences ---
// Per-user preferences (user_preferences table): the API only ever
// reads or writes the SESSION user's own rows. One key so far:
// 'chart_colors' — { chartId: { seriesKey: '#rrggbb' } }, the
// user's colors for the multi-series charts. Unknown chart /
// series keys are stored as given and simply never match a
// series again (the client ignores them); color VALUES are
// validated strictly, anything but #rrggbb is a 400.
const PREFERENCE_KEYS = ['chart_colors'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validChartColors(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const series of Object.values(v)) {
    if (!series || typeof series !== 'object' || Array.isArray(series)) return false;
    for (const color of Object.values(series)) {
      if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) return false;
    }
  }
  return true;
}

app.get('/api/preferences', requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?').all(req.user.id);
  const preferences = {};
  for (const r of rows) {
    try { preferences[r.key] = JSON.parse(r.value); } catch { /* a corrupt row reads as unset */ }
  }
  res.json({ preferences });
});

app.put('/api/preferences/:key', requireApiAuth, (req, res) => {
  const key = req.params.key;
  if (!PREFERENCE_KEYS.includes(key)) return res.status(400).json({ error: `unknown preference key "${key}"` });
  const value = (req.body || {}).value;
  if (key === 'chart_colors' && !validChartColors(value)) {
    return res.status(400).json({ error: 'chart_colors must map chart ids to series keys to #rrggbb colors' });
  }
  db.prepare(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(req.user.id, key, JSON.stringify(value), nowIso());
  res.json({ ok: true });
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
// ------------------------------------------------------------- AI fill --
// Extract form field values from pasted text / an attached photo
// or PDF. Extraction NEVER writes to the database: it returns
// normalized candidate values and the user saves with the form's
// own Save. LLM config comes from the server env (see
// .env.example); unconfigured → 503 with guidance. Owner names
// from the model are mapped to real usernames (admin excluded —
// the same rule the owner picker enforces).
// The user's model choice for AI Fill is an app-level setting
// (app_meta), shared by every panel: the last model a fill ran
// with is the default for the next one.
const AI_FILL_MODEL_KEY = 'ai_fill_model';
const getAiFillModel = () => {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(AI_FILL_MODEL_KEY);
  return row ? row.value : null;
};
const setAiFillModel = (model) => {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(AI_FILL_MODEL_KEY, model);
};
const effectiveAiModel = () => {
  const models = llmModels();
  const persisted = getAiFillModel();
  return persisted && models.includes(persisted) ? persisted : llmDefaultModel();
};

app.get('/api/ai/config', requireApiAuth, (req, res) => {
  res.json({
    configured: llmConfigured(),
    models: llmModels(),
    model: effectiveAiModel(),
  });
});

app.post('/api/ai/fill', requireApiAuth, async (req, res) => {
  const { status, body } = await handleAiFill(req.body || {}, {
    model: getAiFillModel(),
    mapOwners: (names) => {
      const known = db.prepare('SELECT username FROM users WHERE username != ?').all(adminUsername()).map((u) => u.username);
      const byLower = new Map(known.map((u) => [u.toLowerCase(), u]));
      return names.map((n) => byLower.get(String(n).trim().toLowerCase())).filter(Boolean);
    },
  });
  // A fill that names a model and succeeds makes it the app
  // default for the next fill (the user's persisted choice).
  if (status === 200 && req.body && req.body.model) setAiFillModel(String(req.body.model).trim());
  res.status(status).json(body);
});

// The Property costs panel's AI chat: a multi-turn conversation
// (see aiFill.js). The chat extracts and proposes; it writes
// nothing — the panel applies the confirmed proposal through the
// costs POST with source 'ai'. The property and its recorded
// costs ride along as context so the model can ask instead of
// guess (and never re-proposes what is already on record).
app.post('/api/ai/fill-chat', requireApiAuth, async (req, res) => {
  const b = req.body || {};
  const pid = Number(b.propertyId);
  const property = Number.isInteger(pid) && pid > 0 ? getProperty(pid) : null;
  const { status, body } = await handleAiFillChat(b, {
    model: getAiFillModel(),
    property: property ? { id: property.id, address: property.address } : null,
    existing: property ? listCosts(db, property.id) : [],
  });
  if (status === 200 && b.model) setAiFillModel(String(b.model).trim());
  res.status(status).json(body);
});

// The Investments account page's AI chat: the same multi-turn
// conversation pattern (see aiFill.js), scoped to ONE account —
// it proposes new holdings and events, asks instead of guessing,
// and writes nothing; the panel applies the confirmed draft
// through the investments POST endpoints with source 'ai'. The
// account's recorded holdings and their events ride along as
// context (and power the server-side duplicate flags).
app.post('/api/ai/invest-fill-chat', requireApiAuth, async (req, res) => {
  const b = req.body || {};
  const aid = Number(b.accountId);
  const account = Number.isInteger(aid) && aid > 0 ? getAccount(db, aid) : null;
  const holdings = account
    ? listHoldings(db, account.id).map((h) => ({
      ...h,
      events: listEvents(db, h.id),
      navPoints: listPricePoints(db, h.id).filter((p) => p.source === 'manual'),
    }))
    : [];
  const { status, body } = await handleAiInvestFillChat(b, {
    model: getAiFillModel(),
    account,
    holdings,
    existingNav: holdings.flatMap((h) => h.navPoints.map((p) => ({ holding_id: h.id, date: p.date, price: p.price }))),
  });
  if (status === 200 && b.model) setAiFillModel(String(b.model).trim());
  res.status(status).json(body);
});

// The Investments account page's deterministic CSV import: a
// Wealthsimple activities export maps mechanically to holdings and
// events (see wsImport.js). Parse writes nothing — the panel
// reviews the preview and Apply writes it in one transaction with
// source 'csv', re-validated (shape, duplicates, sell guard).
const investExistingForImport = (accountId) => {
  const holdings = listHoldings(db, accountId);
  const eventsByHolding = {};
  for (const h of holdings) eventsByHolding[h.id] = listEvents(db, h.id);
  return { holdings, eventsByHolding };
};
app.post('/api/investments/accounts/:id/import-csv', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  if (csv.length > 1024 * 1024) return res.status(400).json({ error: 'csv is too large (max 1 MB)' });
  try {
    res.json(parseWealthsimpleCsv(csv, investExistingForImport(account.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// AI-mapped CSV import: for broker exports that are not
// Wealthsimple's. The model proposes a mapping from the file's
// structure (columns, samples, distinct activity words) — it
// never invents per-row figures. The user confirms or edits the
// mapping, the deterministic engine previews every row, and
// Apply writes atomically with source 'csv-ai'. A confirmed
// mapping is remembered per user by column fingerprint, so a
// second export from the same broker reuses it and skips the AI
// and confirmation steps; preview and Apply still run.
const CSV_MAPPINGS_KEY = 'csv_mappings';
const getSavedCsvMappings = (userId) => {
  const row = db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(userId, CSV_MAPPINGS_KEY);
  if (!row) return {};
  try {
    const v = JSON.parse(row.value);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
};
const saveCsvMapping = (userId, fingerprint, mapping, answers) => {
  const all = getSavedCsvMappings(userId);
  all[fingerprint] = { mapping, answers: answers || [], savedAt: nowIso() };
  db.prepare(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(userId, CSV_MAPPINGS_KEY, JSON.stringify(all), nowIso());
};
app.post('/api/investments/accounts/:id/import-csv-map/analyze', requireApiAuth, async (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  if (csv.length > 1024 * 1024) return res.status(400).json({ error: 'csv is too large (max 1 MB)' });
  let structure;
  try {
    structure = analyzeCsv(csv);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!req.body.forceRefresh) {
    const saved = getSavedCsvMappings(req.user.id)[structure.fingerprint];
    if (saved && saved.mapping) {
      return res.json({ structure, mapping: saved.mapping, questions: [], reused: true });
    }
  }
  if (!llmConfigured()) {
    return res.status(503).json({ error: 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.' });
  }
  try {
    const r = await proposeCsvMapping(structure, { model: effectiveAiModel() });
    res.json({ structure, mapping: r.mapping, questions: r.questions, reply: r.reply, reused: false });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
// Wizard live preview: the first rows of the file translated into
// plain words with the mapping as it currently stands in the
// editor. Read-only, writes nothing, and tolerates a partial
// mapping (a missing column shows as a placeholder in the
// sentence) so the user can see what is still unmapped.
app.post('/api/investments/accounts/:id/import-csv-map/translate', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  if (csv.length > 1024 * 1024) return res.status(400).json({ error: 'csv is too large (max 1 MB)' });
  const mapping = req.body.mapping;
  if (!mapping || typeof mapping !== 'object') return res.status(400).json({ error: 'mapping is required' });
  try {
    res.json({ sentences: translatePreview(csv, mapping, 5) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// AI-map wizard follow-up: the preview did not match, so the
// user tells the model what is wrong in one sentence and gets a
// whole revised mapping back. Preview-stage only — nothing is
// written here; the editor re-renders from the revised mapping
// and the user still confirms before any preview or apply. The
// mapping is remembered only at preview-confirm time, as before.
app.post('/api/investments/accounts/:id/import-csv-map/followup', requireApiAuth, async (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  if (csv.length > 1024 * 1024) return res.status(400).json({ error: 'csv is too large (max 1 MB)' });
  const mapping = req.body.mapping;
  if (!mapping || typeof mapping !== 'object') return res.status(400).json({ error: 'mapping is required' });
  const message = req.body.message;
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'a follow-up message is required' });
  const history = Array.isArray(req.body.history)
    ? req.body.history.filter((t) => t && typeof t.message === 'string' && typeof t.reply === 'string').slice(-5)
    : [];
  let structure;
  try {
    structure = analyzeCsv(csv);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!llmConfigured()) {
    return res.status(503).json({ error: 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.' });
  }
  try {
    const r = await reviseCsvMapping(structure, mapping, message, history, { model: effectiveAiModel() });
    res.json({ mapping: r.mapping, questions: r.questions, reply: r.reply });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
// Pair-mode step-4 list: the distinct activity keys (type / sub-type
// pairs, or plain values without a second column) for the mapping as
// it currently stands, in first-seen order with display labels. The
// editor cannot compute pairs from the analyze summary alone — it
// has column stats, not rows — so it asks here whenever the activity
// columns change. Read-only, writes nothing.
app.post('/api/investments/accounts/:id/import-csv-map/activity-values', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  if (csv.length > 1024 * 1024) return res.status(400).json({ error: 'csv is too large (max 1 MB)' });
  const mapping = req.body.mapping;
  if (!mapping || typeof mapping !== 'object') return res.status(400).json({ error: 'mapping is required' });
  try {
    res.json(activityValuesFor(csv, mapping));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/investments/accounts/:id/import-csv-map/preview', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  if (csv.length > 1024 * 1024) return res.status(400).json({ error: 'csv is too large (max 1 MB)' });
  const mapping = req.body.mapping;
  if (!mapping || typeof mapping !== 'object') return res.status(400).json({ error: 'mapping is required' });
  let structure;
  try {
    structure = analyzeCsv(csv);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const preview = applyMappedCsv(csv, mapping, investExistingForImport(account.id));
    // Confirming the mapping is what remembers it: the fingerprint
    // lookup on the next file from this broker reuses it. A
    // mapping that fails to preview is not remembered.
    const answers = Array.isArray(req.body.answers) ? req.body.answers.filter((a) => typeof a === 'string') : [];
    saveCsvMapping(req.user.id, structure.fingerprint, mapping, answers);
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/investments/accounts/:id/import-csv/apply', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const source = req.body && (req.body.source === 'csv-ai' ? 'csv-ai' : 'csv');
  const v = validateImportApply(req.body || {}, investExistingForImport(account.id));
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = nowIso();
  const refToId = new Map();
  try {
    db.transaction(() => {
      for (const h of v.holdings) {
        const info = db.prepare(
          'INSERT INTO invest_holdings (account_id, label, kind, symbol, fund_code, currency, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(account.id, h.label, h.kind, h.symbol, h.fundCode, h.currency, source, ts, ts);
        refToId.set(h.ref, info.lastInsertRowid);
      }
      const ins = db.prepare(
        'INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const e of v.events) {
        const holdingId = e.holdingId != null ? e.holdingId : refToId.get(e.holdingRef);
        ins.run(holdingId, e.date, e.type, e.units, e.price, e.amount, e.splitNew, e.splitOld, e.note, source, ts, ts);
      }
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const touched = new Set([...refToId.values(), ...v.events.filter((e) => e.holdingId != null).map((e) => e.holdingId)]);
  for (const hid of touched) rebuildEventPricePoints(db, hid, ts);
  res.status(201).json({ createdHoldings: v.holdings.length, createdEvents: v.events.length, skippedDuplicates: v.skippedDuplicates });
});

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

// A job's owner is ONE person, not a set: a T1 return is per-person,
// so splitting one salary across several owners would misstate tax.
// Same candidates as cleanOwners (existing non-admin users, no 'Joint');
// empty means unassigned, which is legal for pre-existing jobs.
function cleanJobOwner(v) {
  if (v === undefined || v === null || v === '') return { value: null };
  const s = String(v).trim();
  if (!s) return { value: null };
  if (s === 'Joint') return { error: '"Joint" is not an owner — a job belongs to one earner' };
  if (s === adminUsername()) return { error: 'admin cannot be an owner' };
  if (!ownerCandidates().includes(s)) return { error: `unknown owner "${s}" — pick from the users list` };
  return { value: s };
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
    for (const table of ['properties', 'other_assets', 'invest_accounts']) {
      const rows = db.prepare(`SELECT id, owners FROM ${table} WHERE owners IS NOT NULL`).all();
      const upd = db.prepare(`UPDATE ${table} SET owners = ? WHERE id = ?`);
      for (const row of rows) {
        const names = parseOwners(row.owners);
        if (names.includes(u.username)) {
          upd.run(JSON.stringify(names.filter((n) => n !== u.username)), row.id);
        }
      }
    }
    // A job's single earner clears to unassigned the same way.
    db.prepare('UPDATE earn_jobs SET owner = NULL WHERE owner = ?').run(u.username);
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
    const suggestions = await assessmentFor('CA').suggestAddresses(q);
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

// AI Fill provenance: the ai_fields column holds a JSON array of
// field names carrying the "filled by AI" flag. Serializers serve
// the parsed array; writes accept an array filtered to the form's
// real fields (unknown names dropped). Display metadata only.
const PROPERTY_AI_FIELDS = ['address', 'notes', 'assessed_value', 'assessed_year', 'purchase_date', 'mortgage_balance', 'owners'];
const TERM_AI_FIELDS = ['lender', 'start_date', 'term_months', 'amortization_years', 'opening_balance', 'payment_frequency', 'repayment_method', 'payment_override'];
const SEGMENT_AI_FIELDS = ['start_date', 'rate_type', 'rate_mode', 'annual_rate', 'spread', 'compounding'];

function parseAiFields(v) {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

// Cleaned ai_fields for a write: null when the body does not carry
// the key (leave the stored value alone), otherwise the filtered
// array (possibly empty — the user cleared every flag).
function cleanAiFields(body, allowed) {
  if (!body || body.ai_fields === undefined) return null;
  if (!Array.isArray(body.ai_fields)) return [];
  return [...new Set(body.ai_fields.filter((x) => allowed.includes(x)))];
}

const aiFieldsJson = (arr) => (arr && arr.length ? JSON.stringify(arr) : null);

// A segment as the API serves it: with its pricing mode normalized
// (rows from before prime pricing read as 'absolute') and the rate
// it effectively carries right now (prime-spread segments resolve
// against the current prime; null when no prime is known).
function segmentView(seg) {
  const prime = getCurrentPrime();
  return {
    ...seg,
    rate_mode: seg.rate_mode || 'absolute',
    compounding: seg.compounding || 'semi_annual',
    accrual: seg.accrual || 'monthly',
    ai_fields: parseAiFields(seg.ai_fields),
    effective_rate: segmentAnnualRate(seg, prime ? prime.rate : null),
  };
}

// A property's photo gallery as the client renders it: the uploaded
// photos in their stored order, then — for properties recorded before
// galleries existed — the old external photo_url as one extra entry
// (kind 'url', id 'url'). Removing that entry clears the column; there
// is no way to set a new URL (uploads only).
function photosView(p) {
  const rows = db
    .prepare('SELECT id, file_name FROM property_photos WHERE property_id = ? ORDER BY sort_order, id')
    .all(p.id);
  const photos = rows.map((r) => ({ id: r.id, src: `/photos/${r.file_name}`, kind: 'upload' }));
  if (p.photo_url) photos.push({ id: 'url', src: p.photo_url, kind: 'url' });
  return photos;
}

// --------------------------------------------------------- mortgage terms --
// A mortgage is a chain of terms (contracts). Each term carries its
// lender, start, length, amortization and opening balance; rate
// segments and lump sums belong to a term. The term the property's
// balance anchor sits in is the "current" term — the property-level
// lender / amortization_years the API has always served are read
// from it (the columns remain as a mirror for older data).
function termsOf(propertyId) {
  return db
    .prepare('SELECT * FROM mortgage_terms WHERE property_id = ? ORDER BY start_date, id')
    .all(propertyId);
}

function lumpSumsOf(propertyId) {
  return db
    .prepare('SELECT * FROM lump_sums WHERE property_id = ? ORDER BY date, id')
    .all(propertyId);
}

function currentTermOf(p, terms) {
  const list = terms || termsOf(p.id);
  if (!list.length) return null;
  const anchor = p.mortgage_balance_date || new Date().toISOString().slice(0, 10);
  let cur = null;
  for (const t of list) if (t.start_date <= anchor) cur = t;
  return cur || list[0];
}

// 'YYYY-MM-DD' + n months (day clamped into the target month).
function addMonthsDate(dateStr, months) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

function addDaysDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The last day a term covers: start + term_months, minus one day.
const termEndDate = (t) => addDaysDate(addMonthsDate(t.start_date, t.term_months), -1);

// Keep the property row's lender / amortization_years columns in
// step with the current term, so anything still reading the columns
// directly (older clients, the migration) sees the same values the
// API serves from the term.
function syncTermMirror(p) {
  const cur = currentTermOf(p);
  if (!cur) return;
  db.prepare('UPDATE properties SET lender = ?, amortization_years = ?, updated_at = ? WHERE id = ?')
    .run(cur.lender ?? null, cur.amortization_years ?? null, nowIso(), p.id);
}

// The payment schedule in effect for the CURRENT term (frequency +
// payment day), resolved per-term first: a term carries its own
// values now; the property columns remain as the fallback for
// terms that do not carry them. buildSchedule applies the same
// resolution inside every span; this is the anchor term's view of
// it, used for the build-level arguments and the response fields.
function termScheduleOf(p, terms) {
  const cur = currentTermOf(p, terms);
  const frequency = FREQUENCY_KEYS.includes(cur && cur.payment_frequency) ? cur.payment_frequency
    : (FREQUENCY_KEYS.includes(p.payment_frequency) ? p.payment_frequency : 'monthly');
  const paymentDay = cur && cur.payment_day != null ? cur.payment_day : (p.payment_day ?? null);
  return { frequency, paymentDay };
}

// Keep the property row's schedule columns in step with the anchor
// term (frequency / day) — the same mirror pattern as lender /
// amortization, so readers that still look at the property see the
// anchor term's schedule. (The property's mortgage_payment column
// is dormant: the monthly payment is always calculated now, never
// entered, so nothing mirrors into it any more.)
function syncScheduleMirror(p) {
  const cur = currentTermOf(p);
  if (!cur) return;
  db.prepare('UPDATE properties SET payment_day = ?, payment_frequency = ?, updated_at = ? WHERE id = ?')
    .run(cur.payment_day ?? null, cur.payment_frequency ?? null, nowIso(), p.id);
}

// Place the property's balance anchor on the term that contains
// it: that term's card shows (and edits) the anchor as its
// principal pair. An anchor dated on or before its term's start
// folds into the term's opening balance — where it already lives —
// so no term carries anchor columns for it.
function syncTermAnchor(p) {
  const terms = termsOf(p.id);
  if (!terms.length) return;
  const bd = p.mortgage_balance_date;
  let owner = null;
  if (bd) for (const t of terms) if (t.start_date <= bd) owner = t;
  owner = owner || terms[0];
  const place = !!(bd && p.mortgage_balance != null && bd > owner.start_date);
  db.transaction(() => {
    db.prepare('UPDATE mortgage_terms SET anchor_balance = NULL, anchor_date = NULL WHERE property_id = ? AND anchor_date IS NOT NULL').run(p.id);
    if (place) {
      db.prepare('UPDATE mortgage_terms SET anchor_balance = ?, anchor_date = ? WHERE id = ?')
        .run(p.mortgage_balance, bd, owner.id);
    }
  })();
}

// A term's payment triple from a projection run (buildSchedule's
// termPayments): the payment the term opens with — used, derived
// and whether an override is in play. Nulls when the projection
// does not reach the term (or cannot run at all).
function termView(t, segments, lumpSums, payMap) {
  const pay = (payMap && payMap[t.id]) || null;
  // payment_pricing_date is retired — the pricing anchor lives on
  // the governing segment as locked_on now — so the dormant column
  // is never served.
  const { payment_pricing_date: _retired, ...row } = t;
  return {
    ...row,
    ai_fields: parseAiFields(t.ai_fields),
    end_date: termEndDate(t),
    paymentDerived: pay ? pay.paymentDerived : null,
    paymentUsed: pay ? pay.paymentUsed : null,
    paymentOverridden: pay ? !!pay.paymentOverridden : false,
    segments: segments.filter((s) => s.term_id === t.id),
    lumpSums: lumpSums.filter((l) => l.term_id === t.id),
  };
}

// The term payment map of a property's projection, for term views
// served outside a full property view.
function termPayMapFor(p) {
  const r = projectionFor(p);
  return r ? r.termPayments : null;
}

function propertyView(p) {
  const segments = segmentsOf(p.id).map(segmentView);
  const cur = currentSegment(segments);
  const terms = termsOf(p.id);
  const lumpSums = lumpSumsOf(p.id);
  const curTerm = currentTermOf(p, terms);
  // What is still owed TODAY (the projection's balance at the
  // current month), as opposed to mortgage_balance — the anchor
  // the loan was last reconciled at, which falls ever further
  // behind as payments land. Falls back to the anchor when the
  // mortgage cannot project (see remainingBalanceFor). One
  // projection run also serves the payment triples below.
  const proj = projectionFor(p);
  const remaining = proj
    ? remainingBalanceAt(proj.series, currentMonthKey(), p.mortgage_balance ?? null, proj.payoffMonth)
    : { balance: p.mortgage_balance ?? null, month: null };
  return {
    ...p,
    ai_fields: parseAiFields(p.ai_fields),
    // The lender and remaining amortization are term facts now;
    // serve the current term's values under the long-standing field
    // names so existing consumers keep working unchanged.
    lender: curTerm ? (curTerm.lender ?? null) : p.lender,
    amortization_years: curTerm ? (curTerm.amortization_years ?? null) : p.amortization_years,
    // The payment schedule is a term fact too: serve the anchor
    // term's frequency / day under the property field names (the
    // term's own value wins; the property column is its mirror and
    // the fallback for a term not carrying one). The monthly
    // payment itself is served as the projection's triple —
    // paymentUsed (what actually runs; a term override when one
    // is set), paymentDerived (the engine's computed figure) and
    // paymentOverridden — never as a stored mortgage_payment.
    payment_frequency: curTerm ? (curTerm.payment_frequency ?? p.payment_frequency ?? null) : (p.payment_frequency ?? null),
    payment_day: curTerm ? (curTerm.payment_day ?? p.payment_day ?? null) : (p.payment_day ?? null),
    paymentDerived: proj ? proj.paymentDerived : null,
    paymentUsed: proj ? proj.paymentUsed : null,
    paymentOverridden: proj ? !!proj.paymentOverridden : false,
    owners: parseOwners(p.owners),
    photos: photosView(p),
    segments,
    terms: terms.map((t) => termView(t, segments, lumpSums, proj ? proj.termPayments : null)),
    lumpSums,
    remainingBalance: remaining.balance,
    remainingBalanceMonth: remaining.month,
    currentTermId: curTerm ? curTerm.id : null,
    currentRate: cur ? {
      rate_type: cur.rate_type, annual_rate: cur.effective_rate,
      rate_mode: cur.rate_mode, spread: cur.spread ?? null, start_date: cur.start_date,
    } : null,
  };
}

function assetView(a) {
  return { ...a, owners: parseOwners(a.owners) };
}

app.get('/api/properties', requireApiAuth, async (req, res) => {
  await ensureFreshPrime(); // segment effective rates resolve against prime
  const rows = db.prepare('SELECT * FROM properties ORDER BY id').all();
  res.json(rows.map(propertyView));
});

app.post('/api/properties', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.address || !String(b.address).trim()) return res.status(400).json({ error: 'address is required' });
  // The monthly payment is always calculated from the balance, the
  // rate plan and the amortization — it is never entered at the
  // PROPERTY level (an override lives on a term), so a request
  // carrying one is a contract error, not silently ignored.
  if (b.mortgage_payment !== undefined) {
    return res.status(400).json({ error: 'the monthly payment is calculated automatically and cannot be entered' });
  }
  // Adding a property takes just the essentials (address +
  // purchase date; owner optional). The outstanding principal is
  // OPTIONAL: with one, the balance is the CURRENT balance, so its
  // date defaults to today unless one is supplied, and it seeds
  // the balance anchor exactly as before; without one the
  // property is added with no mortgage anchor at all (Term 1
  // opens empty) and the mortgage is filled in later from the
  // detail page's Mortgage modal. A balance date supplied on its
  // own seeds nothing — the anchor is the pair or neither.
  const balance = num(b.mortgage_balance);
  if (balance !== null && balance < 0) {
    return res.status(400).json({ error: 'outstanding principal must be a number >= 0' });
  }
  const balanceDate = balance === null ? null
    : (b.mortgage_balance_date || new Date().toISOString().slice(0, 10));
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
  // A supplied remaining amortization must sit in the field's 1–35
  // year range (the usual Canadian maximums are 25 insured / 30
  // uninsured — those earn a UI hint, not a rejection; outside 1–35
  // is a data error).
  const amortYears = num(b.amortization_years);
  if (amortYears !== null && (amortYears < 1 || amortYears > 35)) {
    return res.status(400).json({ error: 'remaining amortization must be between 1 and 35 years' });
  }
  // Region: only Canada is implemented for now (src/regions/); the
  // column exists so properties are ready when that changes.
  if (b.region !== undefined && b.region !== null && b.region !== ''
    && !REGION_CODES.includes(String(b.region).toUpperCase())) {
    return res.status(400).json({ error: 'only region CA (Canada) is supported for now' });
  }
  const bcaId = b.bca_id ? String(b.bca_id) : null;
  const own = cleanOwners(b.owners !== undefined ? b.owners : b.owner);
  if (own.error) return res.status(400).json({ error: own.error });
  const info = db
    .prepare(
      `INSERT INTO properties (address, assessed_value, assessed_year, assessed_source,
         mortgage_balance, mortgage_balance_date, amortization_years, lender,
         notes, bca_id, bca_matched_address, owners, purchase_date, region, ai_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.address).trim(),
      num(b.assessed_value),
      num(b.assessed_year),
      b.assessed_value != null ? 'manual' : null,
      balance,
      balanceDate,
      amortYears,
      b.lender ? String(b.lender).trim() || null : null,
      b.notes || null,
      bcaId,
      // The picked suggestion's label is the submitted address text
      // itself; the fetch later replaces this with the GIS-canonical form.
      bcaId ? String(b.address).trim() : null,
      JSON.stringify(own.value ?? []),
      b.purchase_date,
      'CA',
      aiFieldsJson(cleanAiFields(b, PROPERTY_AI_FIELDS)),
      nowIso(),
      nowIso()
    );
  const created = getProperty(info.lastInsertRowid);
  // Every mortgage starts as Term 1: it opens on the balance date
  // with the current balance, runs a standard 5 years, and carries
  // the amortization / lender given at add time (either may be
  // filled in later — until the term has an amortization, the
  // projection reports NO_PAYMENT; the payment itself is always
  // calculated, never entered). With no principal given, the term
  // opens empty (NULL balance, starting today) and the anchor
  // arrives when the term's opening balance is first saved (see
  // the term PUT handler).
  db.prepare(
    `INSERT INTO mortgage_terms (property_id, lender, start_date, term_months, amortization_years, opening_balance, amortization_defaulted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    created.id,
    created.lender ?? null,
    created.mortgage_balance_date || new Date().toISOString().slice(0, 10),
    60,
    amortYears,
    balance,
    nowIso(),
    nowIso()
  );
  // Best-effort HouseSigma history pull in the background: earlier
  // assessment years appear on the property by themselves; a failure
  // is recorded on the property (detail page shows it) and never
  // blocks or fails the add.
  pullHouseSigmaHistoryInBackground(created.id);
  res.status(201).json(propertyView(created));
});

// ------------------------------------------------------------- portfolio --
// Aggregates across ALL properties for the Properties section's
// Portfolio block: totals, per-property shares, the assessed-value
// history summed by year, and the projected outstanding balances
// summed by month (with the per-property split for stacked bars).
// Defined before /api/properties/:id so 'portfolio' is not read as
// an id. All projection math reuses the single-property rules: the
// monthly payment is calculated from the balance, the rate plan
// and the remaining amortization (as in the amortization endpoint);
// a property with no rate plan contributes its balance but no
// payment, no interest and no projection.
app.get('/api/properties/portfolio', requireApiAuth, async (req, res) => {
  await ensureFreshPrime();
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const today = new Date().toISOString().slice(0, 10);
  const allProps = db.prepare('SELECT * FROM properties ORDER BY id').all();
  // Fetch-on-read for assessed values too (BC Assessment by-id
  // channel): properties whose stored roll is stale refresh inline
  // before the aggregates are computed; failures keep the stored
  // values and are reported in assessmentRefresh below.
  await Promise.all(allProps.map((p) => ensureFreshAssessment(p)));
  const props = db.prepare('SELECT * FROM properties ORDER BY id').all();

  const prime = getCurrentPrime();
  const primeRate = prime ? prime.rate : null;
  const currentMonth = currentMonthKey();
  const perProperty = [];
  const monthMaps = new Map(); // property id -> Map('YYYY-MM' -> balance)
  const assessedPoints = new Map(); // property id -> [{ year, value }] sorted
  let interestFrom = 0;
  let withPlan = 0;

  for (const p of props) {
    const balance = p.mortgage_balance > 0 ? p.mortgage_balance : 0;
    const segments = segmentsOf(p.id);
    const balanceDate = p.mortgage_balance_date || today;
    // Monthly payment: the term schedule's payment (exactly the
    // amortization endpoint's rules — the used figure, i.e. a term
    // override when one is set, with the derived figure beside
    // it), set below when the property projects. Only meaningful
    // with a balance.
    let monthlyPayment = null;
    let paymentDerived = null;
    let paymentOverridden = false;
    let projectedInterest = null;
    // Outstanding means what is still owed TODAY — the
    // projection's balance at the current month (the detail
    // page's remainingBalance, same figure) — once the property
    // projects; until then the recorded anchor balance stands.
    let outstandingNow = balance;
    if (balance > 0 && segments.length) withPlan++;
    // Prime-spread segments with no prime on record cannot project.
    const primeBlocked = primeRate === null
      && segments.some((s) => s.rate_type === 'variable' && s.rate_mode === 'prime_spread');
    if (balance > 0 && segments.length && !primeBlocked) {
      const { frequency, paymentDay } = termScheduleOf(p);
      const r = buildSchedule({
        balance, balanceDate,
        terms: termsOf(p.id), segments, lumpSums: lumpSumsOf(p.id),
        paymentDay, frequency, primeRate, primeHistory: getPrimeHistory(), region: p.region || 'CA',
      });
      if (r.state === 'projected') {
        monthlyPayment = r.paymentUsed;
        paymentDerived = r.paymentDerived;
        paymentOverridden = !!r.paymentOverridden;
        projectedInterest = r.totalInterest;
        outstandingNow = remainingBalanceAt(r.series, currentMonth, balance, r.payoffMonth).balance;
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
    // Projection state, so the overview can say exactly WHY a property
    // is (not) inside the projected interest instead of folding every
    // gap into one vague "with a rate plan" count: no rate plan / a
    // plan but nothing to compute a payment from / priced off a prime
    // rate that is not on record / projected.
    let projState = 'no_balance';
    if (balance > 0) {
      if (!segments.length) projState = 'no_plan';
      else if (primeBlocked) projState = 'no_prime';
      else if (!(monthlyPayment > 0)) projState = 'no_payment';
      else projState = 'projected';
    }
    perProperty.push({
      id: p.id,
      label: p.address,
      shortLabel: String(p.address).split(',')[0],
      outstanding: outstandingNow,
      monthlyPayment: monthlyPayment > 0 ? monthlyPayment : 0,
      paymentDerived: paymentDerived !== null && paymentDerived !== undefined ? paymentDerived : null,
      paymentOverridden,
      paymentKnown: monthlyPayment > 0,
      hasPlan: segments.length > 0,
      projState,
      projectedInterest,
      latestAssessed,
      // Equity, the app's one definition: the latest assessed
      // value minus the current remaining balance (the same
      // outstanding figure above — a property with no mortgage
      // counts a balance of 0). Null without an assessed value:
      // such properties are excluded from the total, never
      // counted as zero-equity.
      equity: latestAssessed != null ? r2(latestAssessed - outstandingNow) : null,
    });
  }

  const totalOutstanding = r2(perProperty.reduce((s, x) => s + x.outstanding, 0));
  const equityCount = perProperty.filter((x) => x.equity !== null).length;
  const totalAssessed = r2(perProperty.reduce((s, x) => s + (x.latestAssessed || 0), 0));
  const slices = (pick, total) => perProperty
    .filter((x) => pick(x) > 0 && total > 0)
    .map((x) => ({ id: x.id, label: x.label, shortLabel: x.shortLabel, value: pick(x), pct: r2((pick(x) / total) * 100) }));
  const totalEquity = r2(perProperty.reduce((s, x) => s + (x.equity || 0), 0));

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

  // Total equity by month, on the outstanding grid: the
  // carry-forward assessed total in force that month minus the
  // total outstanding that month — the card's definition extended
  // over time. A property joins the outstanding total only from
  // its first projected month (before that it counts as 0 owed);
  // months before the first assessed year on record have no
  // assessed total in force and carry a null equity.
  const equityByMonth = outstandingByMonth.map(({ month, total }) => {
    const y = Number(month.slice(0, 4));
    let assessed = null;
    for (const row of assessedByYear) { if (row.year <= y) assessed = row.total; else break; }
    return { month, value: assessed === null ? null : r2(assessed - total) };
  });

  res.json({
    totals: {
      outstanding: totalOutstanding,
      monthlyPayment: r2(perProperty.reduce((s, x) => s + x.monthlyPayment, 0)),
      totalInterest: r2(perProperty.reduce((s, x) => s + (x.projectedInterest || 0), 0)),
      interestFrom,
      withPlan,
      noPlanCount: perProperty.filter((x) => x.projState === 'no_plan').length,
      planNoPaymentCount: perProperty.filter((x) => x.projState === 'no_payment').length,
      planNoPrimeCount: perProperty.filter((x) => x.projState === 'no_prime').length,
      propertyCount: perProperty.length,
      paymentKnownCount: perProperty.filter((x) => x.paymentKnown).length,
      assessedTotal: totalAssessed,
      equity: equityCount ? r2(perProperty.reduce((s, x) => s + (x.equity || 0), 0)) : null,
      equityCount,
      equityExcluded: perProperty.length - equityCount,
    },
    properties: perProperty,
    pie: {
      outstanding: slices((x) => x.outstanding, totalOutstanding),
      assessed: slices((x) => x.latestAssessed || 0, totalAssessed),
      // Equity share: the Total equity card's per-property
      // figures. Properties without an assessed value have null
      // equity and drop out (the card's exclusion rule); the
      // shared slices() filter also drops zero/negative equity
      // and yields [] when the total is not positive.
      equity: slices((x) => x.equity || 0, totalEquity),
    },
    assessedByYear,
    outstandingByMonth,
    equityByMonth,
    prime: primeStatus(),
    assessmentRefresh: {
      staleIds: props.filter((p) => bcaRefreshStatus(p).stale).map((p) => p.id),
    },
  });
});

app.get('/api/properties/:id', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  await ensureFreshPrime();
  // Fetch-on-read: refresh the assessed value from BC Assessment
  // (by-id channel) when it is due; a failed refresh keeps the
  // stored value and is flagged in assessmentRefresh.
  await ensureFreshAssessment(p);
  const fresh = getProperty(p.id);
  res.json({
    ...propertyView(fresh),
    prime: primeStatus(),
    assessmentRefresh: bcaRefreshStatus(fresh),
    houseSigma: houseSigmaPullStatus(p.id),
  });
});

app.put('/api/properties/:id', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const b = req.body || {};
  // The monthly payment is always calculated — never entered at
  // the property level (see the POST handler); a request carrying
  // one is a contract error.
  if (b.mortgage_payment !== undefined) {
    return res.status(400).json({ error: 'the monthly payment is calculated automatically and cannot be entered' });
  }
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
    amortization_years: b.amortization_years !== undefined ? num(b.amortization_years) : p.amortization_years,
    // The mortgage lender (bank): free text, trimmed; empty clears it.
    lender: b.lender !== undefined ? (String(b.lender).trim() || null) : p.lender,
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
    region: p.region || 'CA',
  };
  if (b.region !== undefined && b.region !== null && b.region !== ''
    && !REGION_CODES.includes(String(b.region).toUpperCase())) {
    return res.status(400).json({ error: 'only region CA (Canada) is supported for now' });
  }
  if (b.region) next.region = String(b.region).toUpperCase();
  if (b.purchase_date !== undefined && b.purchase_date && !isDateStr(b.purchase_date)) {
    return res.status(400).json({ error: 'purchase date must be a valid date (YYYY-MM-DD)' });
  }
  if (b.amortization_years !== undefined) {
    const ay = num(b.amortization_years);
    if (ay !== null && (ay < 1 || ay > 35)) {
      return res.status(400).json({ error: 'remaining amortization must be between 1 and 35 years' });
    }
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
  const propAi = cleanAiFields(b, PROPERTY_AI_FIELDS);
  next.ai_fields = propAi === null ? (p.ai_fields ?? null) : aiFieldsJson(propAi);
  if (!next.address) return res.status(400).json({ error: 'address is required' });
  // Editing the assessed value by hand marks it as a manual value.
  if (b.assessed_value !== undefined && num(b.assessed_value) !== p.assessed_value) next.assessed_source = 'manual';
  db.prepare(
    `UPDATE properties SET address=?, bca_id=?, bca_matched_address=?, photo_url=?,
       assessed_value=?, assessed_year=?, assessed_source=?, mortgage_balance=?,
       mortgage_balance_date=?, amortization_years=?, lender=?, notes=?,
       owners=?, purchase_date=?, payment_day=?, payment_frequency=?, region=?, ai_fields=?, updated_at=? WHERE id=?`
  ).run(
    next.address, next.bca_id, next.bca_matched_address, next.photo_url,
    next.assessed_value, next.assessed_year, next.assessed_source,
    next.mortgage_balance, next.mortgage_balance_date,
    next.amortization_years, next.lender, next.notes, JSON.stringify(next.owners), next.purchase_date,
    next.payment_day, next.payment_frequency, next.region, next.ai_fields, nowIso(), p.id
  );
  // Lender and remaining amortization live on the current term
  // now: the Mortgage form still edits them at property level, so
  // write them through to the term the balance anchor sits in.
  if (b.amortization_years !== undefined || b.lender !== undefined) {
    const cur = currentTermOf(getProperty(p.id));
    if (cur) {
      db.prepare('UPDATE mortgage_terms SET lender = ?, amortization_years = ?, updated_at = ? WHERE id = ?')
        .run(
          b.lender !== undefined ? next.lender : cur.lender,
          b.amortization_years !== undefined ? next.amortization_years : cur.amortization_years,
          nowIso(),
          cur.id
        );
    }
  }
  // The payment schedule lives on the terms now, with the same
  // property-level editing contract as before: the frequency /
  // payment day — which ruled the whole mortgage before they were
  // per-term — write through to EVERY term, so a property-level
  // edit keeps its old whole-mortgage meaning. (There is no
  // property-level payment to write through: the payment is
  // always calculated.)
  if (b.payment_day !== undefined || b.payment_frequency !== undefined) {
    if (b.payment_day !== undefined) {
      db.prepare('UPDATE mortgage_terms SET payment_day = ?, updated_at = ? WHERE property_id = ?')
        .run(next.payment_day, nowIso(), p.id);
    }
    if (b.payment_frequency !== undefined) {
      db.prepare('UPDATE mortgage_terms SET payment_frequency = ?, updated_at = ? WHERE property_id = ?')
        .run(next.payment_frequency, nowIso(), p.id);
    }
  }
  // A moved balance anchor re-seats itself on the term that now
  // contains it (the anchor is carried — and edited — by that term).
  if (b.mortgage_balance !== undefined || b.mortgage_balance_date !== undefined) {
    syncTermAnchor(getProperty(p.id));
  }
  // A changed address invalidates the stored HouseSigma location:
  // clear its ids so the next history pull locates the new address.
  if (next.address !== p.address) {
    db.prepare('UPDATE properties SET hs_id_address = NULL, hs_id_listing = NULL WHERE id = ?').run(p.id);
  }
  res.json(propertyView(getProperty(p.id)));
});

app.delete('/api/properties/:id', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  // The gallery rows cascade away with the property; their files go too.
  const files = db.prepare('SELECT file_name FROM property_photos WHERE property_id = ?').all(p.id);
  db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
  for (const f of files) fs.promises.unlink(path.join(PHOTOS_DIR, f.file_name)).catch(() => {});
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
    const r = await assessmentFor(p.region).fetchAssessment(p.address, direct);
    // Record this year's point on the value-trend history too (one
    // row per year; a re-fetch refreshes that year's auto point).
    applyBcaFetchResult(p.id, r);
    noteBcaAttempt(p.id, true, null);
    res.json({ ok: true, result: r, property: propertyView(getProperty(p.id)) });
  } catch (e) {
    noteBcaAttempt(p.id, false, e.message);
    res.json({ ok: false, stage: e.stage || 'unknown', error: e.message });
  }
});

// Pull the assessed-value HISTORY (prior years) from HouseSigma:
// BC Assessment publishes only the current roll, so earlier years
// come from there. Imported points never overwrite manual or BC
// Assessment points (see importHistoryPoints in assessed.js).
app.post('/api/properties/:id/pull-history', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const r = await runHouseSigmaPull(p);
  if (!r.ok) return res.json(r);
  res.json({ ...r, property: propertyView(getProperty(p.id)), history: historyView(p.id) });
});

// Photo gallery uploads as base64 JSON (keeps us dependency-free).
// One call carries one image ({ dataBase64, contentType }) or several
// ({ images: [...] }); each image is validated like the avatar uploads
// (jpeg/png/webp/gif, non-empty, ≤ 9 MB) and appended to the gallery.
// Everything is validated before anything is written, so a bad file
// in a batch rejects the batch untouched with the reason named.
app.post('/api/properties/:id/photos', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const b = req.body || {};
  const items = Array.isArray(b.images) ? b.images : [b];
  if (!items.length || items.length > 20) {
    return res.status(400).json({ error: 'send between 1 and 20 images per upload' });
  }
  const exts = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const decoded = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const { dataBase64, contentType } = items[i] || {};
    const ext = exts[contentType];
    if (!dataBase64 || !ext) {
      return res.status(400).json({ error: `image ${i + 1}: expected { dataBase64, contentType: image/jpeg|png|webp|gif }` });
    }
    const buf = Buffer.from(String(dataBase64), 'base64');
    if (buf.length === 0) return res.status(400).json({ error: `image ${i + 1}: empty file` });
    if (buf.length > 9 * 1024 * 1024) return res.status(400).json({ error: `image ${i + 1}: larger than 9 MB` });
    total += buf.length;
    decoded.push({ buf, ext });
  }
  if (total > 36 * 1024 * 1024) return res.status(400).json({ error: 'upload batch larger than 36 MB in total' });
  let order = (db.prepare('SELECT MAX(sort_order) AS m FROM property_photos WHERE property_id = ?').get(p.id).m ?? -1) + 1;
  const ins = db.prepare('INSERT INTO property_photos (property_id, file_name, sort_order, created_at) VALUES (?, ?, ?, ?)');
  const stamp = Date.now();
  db.transaction(() => {
    for (let i = 0; i < decoded.length; i++) {
      const name = `property-${p.id}-${stamp}-${i}-${crypto.randomBytes(3).toString('hex')}.${decoded[i].ext}`;
      fs.writeFileSync(path.join(PHOTOS_DIR, name), decoded[i].buf);
      ins.run(p.id, name, order++, nowIso());
    }
  })();
  res.json(propertyView(getProperty(p.id)));
});

// Remove one gallery photo. Uploaded photos lose their row and file;
// the legacy external URL entry (photoId 'url') clears photo_url —
// after that the URL is gone for good (there is no URL field anymore).
app.delete('/api/properties/:id/photos/:photoId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  if (req.params.photoId === 'url') {
    if (!p.photo_url) return res.status(404).json({ error: 'photo not found' });
    db.prepare('UPDATE properties SET photo_url = NULL, updated_at = ? WHERE id = ?').run(nowIso(), p.id);
    return res.json(propertyView(getProperty(p.id)));
  }
  const row = db.prepare('SELECT * FROM property_photos WHERE id = ? AND property_id = ?')
    .get(Number(req.params.photoId), p.id);
  if (!row) return res.status(404).json({ error: 'photo not found' });
  db.prepare('DELETE FROM property_photos WHERE id = ?').run(row.id);
  fs.promises.unlink(path.join(PHOTOS_DIR, row.file_name)).catch(() => {});
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
// no prior-year fields); HouseSigma pulls fill in the earlier years;
// manual points are entered by hand and outrank both.
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

// A point's optional land / building split: the two travel
// together (both given or both blank), and when both are given
// the point's value IS their sum. `present` false means the body
// carries neither key (a PUT then leaves the stored split alone);
// present with nulls means both were blank (the split clears).
function cleanSplit(b) {
  const hasLand = b.land_value !== undefined;
  const hasBuilding = b.building_value !== undefined;
  if (!hasLand && !hasBuilding) return { present: false, land: null, building: null };
  const land = num(b.land_value);
  const building = num(b.building_value);
  if ((land === null) !== (building === null)) {
    return { error: 'land_value and building_value must be given together' };
  }
  if (land !== null && (land < 0 || building < 0)) {
    return { error: 'land_value and building_value must be numbers >= 0' };
  }
  return { present: true, land, building };
}

app.get('/api/properties/:id/value-history', requireApiAuth, (req, res) => {
  if (!getProperty(req.params.id)) return res.status(404).json({ error: 'property not found' });
  res.json(historyView(req.params.id));
});

app.post('/api/properties/:id/value-history', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const sp = cleanSplit(req.body || {});
  if (sp.error) return res.status(400).json({ error: sp.error });
  // Both split figures given: the year's total is their sum (the
  // sum stands in for the value in validation too — a split-only
  // entry needs no separate value).
  const v = validYearValue(sp.present && sp.land !== null
    ? { year: (req.body || {}).year, value: sp.land + sp.building }
    : (req.body || {}));
  if (v.error) return res.status(400).json({ error: v.error });
  const value = v.value;
  db.prepare(
    `INSERT INTO value_history (property_id, year, value, source, notes, land_value, building_value, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)
     ON CONFLICT(property_id, year) DO UPDATE SET
       value = excluded.value, source = 'manual', notes = excluded.notes,
       land_value = excluded.land_value, building_value = excluded.building_value,
       updated_at = excluded.updated_at`
  ).run(p.id, v.year, value, (req.body || {}).notes || null,
    sp.present ? sp.land : null, sp.present ? sp.building : null, nowIso(), nowIso());
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
  const sp = cleanSplit(b);
  if (sp.error) return res.status(400).json({ error: sp.error });
  // The split merges over the stored point; when both figures
  // stand, the value follows their sum.
  let value = v.value;
  let land = pt.land_value;
  let building = pt.building_value;
  if (sp.present) {
    land = sp.land;
    building = sp.building;
    if (land !== null) value = land + building;
  }
  // Hand-editing a value turns the point into a manual one.
  const source = value !== pt.value ? 'manual' : pt.source;
  try {
    db.prepare('UPDATE value_history SET year=?, value=?, source=?, notes=?, land_value=?, building_value=?, updated_at=? WHERE id=?')
      .run(v.year, value, source, b.notes !== undefined ? b.notes || null : pt.notes, land, building, nowIso(), pt.id);
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

// -------------------------------------------------------- property costs ---
// A property's yearly running costs (src/costs.js): one row per
// (year, category), the amount stored in its recorded basis
// ('annual' = the year's total; 'monthly' = a monthly average).
// The view pivots by year at the ANNUAL figure — totals and the
// chart never mix bases. Manual entries and AI-applied entries
// land through the same POST; the body names its source.
app.get('/api/properties/:id/costs', requireApiAuth, (req, res) => {
  if (!getProperty(req.params.id)) return res.status(404).json({ error: 'property not found' });
  res.json(costsView(db, req.params.id));
});

app.post('/api/properties/:id/costs', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const v = validCostInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  upsertCost(db, p.id, v, (req.body || {}).source === 'ai' ? 'ai' : 'manual', nowIso());
  res.status(201).json(costsView(db, p.id));
});

app.put('/api/properties/:id/costs/:costId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const row = db.prepare('SELECT * FROM property_costs WHERE id = ? AND property_id = ?').get(req.params.costId, p.id);
  if (!row) return res.status(404).json({ error: 'cost entry not found' });
  const b = req.body || {};
  // Merge the figure fields as a pair: a request may carry new
  // monthlyAmounts (the average is recomputed from them), a bare
  // amount (an average given directly — any stored month detail is
  // dropped), or neither (the stored figure rides along: the
  // month detail when there is one, else the stored amount).
  const merged = {
    year: b.year !== undefined ? b.year : row.year,
    category: b.category !== undefined ? b.category : row.category,
    basis: b.basis !== undefined ? b.basis : row.basis,
    notes: b.notes !== undefined ? b.notes : row.notes,
    amount: b.amount,
    monthlyAmounts: b.monthlyAmounts,
  };
  if (merged.monthlyAmounts === undefined && merged.amount === undefined) {
    const det = parseStoredMonthlyAmounts(row.monthly_amounts);
    if (merged.basis === 'monthly' && det) merged.monthlyAmounts = det;
    else merged.amount = row.amount;
  }
  const v = validCostInput(merged);
  if (v.error) return res.status(400).json({ error: v.error });
  // A hand edit makes the row manual again (the value-history
  // rule); re-saving the identical figures keeps its source.
  const changed = v.year !== row.year || v.category !== row.category
    || v.amount !== row.amount || v.basis !== row.basis || v.notes !== row.notes
    || JSON.stringify(v.monthlyAmounts) !== JSON.stringify(parseStoredMonthlyAmounts(row.monthly_amounts));
  try {
    db.prepare('UPDATE property_costs SET year=?, category=?, amount=?, basis=?, monthly_amounts=?, notes=?, source=?, updated_at=? WHERE id=?')
      .run(v.year, v.category, v.amount, v.basis,
        v.monthlyAmounts ? JSON.stringify(v.monthlyAmounts) : null,
        v.notes, changed ? 'manual' : row.source, nowIso(), row.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `a ${v.category} entry for ${v.year} already exists` });
    }
    throw e;
  }
  res.json(costsView(db, p.id));
});

app.delete('/api/properties/:id/costs/:costId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM property_costs WHERE id = ? AND property_id = ?').run(req.params.costId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'cost entry not found' });
  res.json(costsView(db, req.params.id));
});

// ---------------------------------------------------------- rate segments ---
// Validate/normalize a rate segment from request fields merged over
// an existing row (PUT) or from scratch (POST, base = null). Pricing
// modes: fixed is always absolute; variable is either 'absolute'
// (a stored annual rate) or 'prime_spread' (priced off the current
// prime: prime + spread, e.g. spread -1 = "Prime - 1"). Prime
// segments store annual_rate as NULL — their effective rate is
// always resolved live (segmentAnnualRate).
function cleanSegment(b, base) {
  const next = {
    start_date: b.start_date !== undefined ? String(b.start_date) : base?.start_date,
    rate_type: b.rate_type !== undefined ? b.rate_type : base?.rate_type,
    rate_mode: b.rate_mode !== undefined ? b.rate_mode : base?.rate_mode || 'absolute',
    annual_rate: b.annual_rate !== undefined ? num(b.annual_rate) : base?.annual_rate ?? null,
    spread: b.spread !== undefined ? num(b.spread) : base?.spread ?? null,
    // How the segment's nominal rate compounds: 'semi_annual'
    // (the Canadian standard, and every existing segment) or
    // 'monthly' (compounded at the payment frequency).
    compounding: b.compounding !== undefined ? b.compounding : base?.compounding || 'semi_annual',
    // How the segment's interest accrues: 'monthly' (the period's
    // converted rate — every existing segment) or 'daily' (the
    // nominal annual rate summed day by day over the period's
    // actual days).
    accrual: b.accrual !== undefined ? b.accrual : base?.accrual || 'monthly',
    // The date this segment's rate was locked (priced) on. Only
    // meaningful for variable prime_spread segments — anything
    // else is forced to null below, since a written-down rate has
    // no pricing date. Derivations governed by the segment price
    // prime as of this date; accrual never reads it.
    locked_on: b.locked_on !== undefined
      ? (b.locked_on === '' || b.locked_on === null ? null : String(b.locked_on))
      : (base?.locked_on ?? null),
  };
  if (!next.start_date) return { error: 'start_date is required' };
  if (!['fixed', 'variable'].includes(next.rate_type)) return { error: 'rate_type must be fixed or variable' };
  if (!['absolute', 'prime_spread'].includes(next.rate_mode)) return { error: 'rate_mode must be absolute or prime_spread' };
  if (!['semi_annual', 'monthly'].includes(next.compounding)) return { error: "compounding must be 'semi_annual' or 'monthly'" };
  if (!['monthly', 'daily'].includes(next.accrual)) return { error: "accrual must be 'monthly' or 'daily'" };
  if (next.locked_on !== null && !isDateStr(next.locked_on)) return { error: 'locked on date must be a valid date (YYYY-MM-DD)' };
  if (next.rate_type === 'fixed') { next.rate_mode = 'absolute'; next.spread = null; next.locked_on = null; }
  if (next.rate_mode === 'prime_spread') {
    if (next.rate_type !== 'variable') return { error: 'prime-based pricing is only for variable segments' };
    if (next.spread === null || !isFinite(next.spread) || next.spread < -10 || next.spread > 10) {
      return { error: 'spread must be a number between -10 and 10 (e.g. -1 for Prime - 1%)' };
    }
    next.annual_rate = null;
  } else {
    next.spread = null;
    next.locked_on = null;
    if (next.annual_rate === null || next.annual_rate < 0) return { error: 'annual_rate must be a number >= 0' };
  }
  return { value: next };
}

// Which term a segment belongs to: the one named in the request
// when it is valid, else the term in effect at the segment's start
// (falling back to the earliest term). Ownership is organizational —
// the projection prices months from the segment timeline itself —
// but it decides which accordion the segment is edited in.
function segmentTermId(p, body, base) {
  const terms = termsOf(p.id);
  if (!terms.length) return { value: null };
  if (body.term_id !== undefined && body.term_id !== null) {
    const t = terms.find((x) => x.id === Number(body.term_id));
    if (!t) return { error: 'term_id does not name a term of this property' };
    return { value: t.id };
  }
  if (base && base.term_id) return { value: base.term_id };
  const start = (body.start_date !== undefined ? String(body.start_date) : base?.start_date) || '';
  let owner = null;
  for (const t of terms) if (t.start_date <= start) owner = t;
  return { value: (owner || terms[0]).id };
}

// Two segments of one term may not share a start date — the
// timeline would be ambiguous about which segment prices that
// month. Enforced on add and on edit alike; an edit excludes
// the segment itself.
function segmentStartTaken(propertyId, termId, startDate, exceptId) {
  return !!db.prepare(
    'SELECT id FROM rate_segments WHERE property_id = ? AND term_id IS ? AND start_date = ? AND id <> ?'
  ).get(propertyId, termId, startDate, exceptId || -1);
}

app.post('/api/properties/:id/rates', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const clean = cleanSegment(req.body || {}, null);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const owner = segmentTermId(p, req.body || {}, null);
  if (owner.error) return res.status(400).json({ error: owner.error });
  const s = clean.value;
  if (segmentStartTaken(p.id, owner.value, s.start_date, null)) {
    return res.status(400).json({ error: `a segment already starts on ${s.start_date} in this term` });
  }
  const info = db
    .prepare('INSERT INTO rate_segments (property_id, term_id, start_date, rate_type, annual_rate, rate_mode, spread, compounding, accrual, locked_on, ai_fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, owner.value, s.start_date, s.rate_type, s.annual_rate, s.rate_mode, s.spread, s.compounding, s.accrual, s.locked_on, aiFieldsJson(cleanAiFields(req.body || {}, SEGMENT_AI_FIELDS)), nowIso());
  res.status(201).json(segmentView(db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/properties/:id/rates/:segId', requireApiAuth, (req, res) => {
  const seg = db.prepare('SELECT * FROM rate_segments WHERE id = ? AND property_id = ?').get(req.params.segId, req.params.id);
  if (!seg) return res.status(404).json({ error: 'segment not found' });
  const clean = cleanSegment(req.body || {}, seg);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const p = getProperty(req.params.id);
  const owner = segmentTermId(p, req.body || {}, seg);
  if (owner.error) return res.status(400).json({ error: owner.error });
  const s = clean.value;
  if (segmentStartTaken(p.id, owner.value, s.start_date, seg.id)) {
    return res.status(400).json({ error: `a segment already starts on ${s.start_date} in this term` });
  }
  const segAi = cleanAiFields(req.body || {}, SEGMENT_AI_FIELDS);
  db.prepare('UPDATE rate_segments SET term_id=?, start_date=?, rate_type=?, annual_rate=?, rate_mode=?, spread=?, compounding=?, accrual=?, locked_on=?, ai_fields=? WHERE id=?')
    .run(owner.value, s.start_date, s.rate_type, s.annual_rate, s.rate_mode, s.spread, s.compounding, s.accrual, s.locked_on, segAi === null ? (seg.ai_fields ?? null) : aiFieldsJson(segAi), seg.id);
  res.json(segmentView(db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(seg.id)));
});

app.delete('/api/properties/:id/rates/:segId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM rate_segments WHERE id = ? AND property_id = ?').run(req.params.segId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'segment not found' });
  res.json({ ok: true });
});

// --------------------------------------------------------- terms & lump sums --
// Validate/normalize a term from request fields merged over an
// existing row (PUT) or a prefilled candidate (POST). term_months
// is the stored unit (the UI offers year quick-picks); the range
// 1..120 covers the Canadian market (terms run 6 months to 10
// years). Amortization follows the same 1..35 rule as properties.
function cleanTerm(c) {
  const next = {
    lender: c.lender === undefined || c.lender === null ? null : (String(c.lender).trim() || null),
    start_date: c.start_date !== undefined ? String(c.start_date) : null,
    term_months: c.term_months !== undefined ? Number(c.term_months) : null,
    amortization_years: c.amortization_years !== undefined ? num(c.amortization_years) : null,
    opening_balance: c.opening_balance !== undefined ? num(c.opening_balance) : null,
    repayment_method: c.repayment_method !== undefined ? String(c.repayment_method) : 'equal_payment',
    // The term's optional monthly payment override: the engine
    // always derives the payment first; a positive override makes
    // the term run on that fixed payment instead. Empty / null
    // clears it (the derived payment rules).
    payment_override: c.payment_override !== undefined && c.payment_override !== null && c.payment_override !== ''
      ? num(c.payment_override) : null,
    // The term's own payment schedule + balance anchor (see the
    // mortgage_terms columns); the anchor pair is set together or
    // not at all.
    payment_frequency: c.payment_frequency !== undefined && c.payment_frequency !== null && c.payment_frequency !== ''
      ? String(c.payment_frequency) : null,
    payment_day: c.payment_day !== undefined && c.payment_day !== null && c.payment_day !== ''
      ? Number(c.payment_day) : null,
    anchor_balance: c.anchor_balance !== undefined ? num(c.anchor_balance) : null,
    anchor_date: c.anchor_date !== undefined && c.anchor_date !== null && c.anchor_date !== ''
      ? String(c.anchor_date) : null,
  };
  if (!next.start_date || !isDateStr(next.start_date)) return { error: 'start_date must be a valid date (YYYY-MM-DD)' };
  if (!Number.isInteger(next.term_months) || next.term_months < 1 || next.term_months > 120) {
    return { error: 'term length must be a whole number of months between 1 and 120' };
  }
  if (next.amortization_years !== null && (next.amortization_years < 1 || next.amortization_years > 35)) {
    return { error: 'amortization must be between 1 and 35 years' };
  }
  if (next.opening_balance !== null && next.opening_balance < 0) {
    return { error: 'opening balance must be a number >= 0' };
  }
  if (!['equal_payment', 'equal_principal'].includes(next.repayment_method)) {
    return { error: "repayment_method must be 'equal_payment' or 'equal_principal'" };
  }
  if (next.payment_override !== null && (!isFinite(next.payment_override) || next.payment_override <= 0)) {
    return { error: 'monthly payment override must be a number greater than 0' };
  }
  if (next.payment_frequency !== null && !FREQUENCY_KEYS.includes(next.payment_frequency)) {
    return {
      error: `payment frequency must be one of: ${FREQUENCY_KEYS.map((k) => FREQUENCIES[k].label).join(', ')}`,
    };
  }
  if (next.payment_day !== null && (!Number.isInteger(next.payment_day) || next.payment_day < 1 || next.payment_day > 31)) {
    return { error: 'payment day must be a whole number between 1 and 31' };
  }
  if ((next.anchor_balance === null) !== (next.anchor_date === null)) {
    return { error: 'a balance anchor needs both a balance and a date' };
  }
  if (next.anchor_date !== null && !isDateStr(next.anchor_date)) {
    return { error: 'anchor date must be a valid date (YYYY-MM-DD)' };
  }
  if (next.anchor_balance !== null && next.anchor_balance < 0) {
    return { error: 'anchor balance must be a number >= 0' };
  }
  // An anchor dated on or before the term's start IS the opening
  // balance: fold it in and carry no anchor columns.
  if (next.anchor_date !== null && next.anchor_date <= next.start_date) {
    next.opening_balance = next.anchor_balance;
    next.anchor_balance = null;
    next.anchor_date = null;
  }
  return { value: next };
}

// The property's full projection (the engine's buildSchedule
// result), or null when the mortgage cannot project: no balance,
// no rate plan, a state other than 'projected' (no payment / no
// prime), so callers fall back instead of inventing numbers.
function projectionFor(p) {
  const segments = segmentsOf(p.id);
  if (!segments.length || !(p.mortgage_balance > 0)) return null;
  const prime = getCurrentPrime();
  const { frequency, paymentDay } = termScheduleOf(p);
  const r = buildSchedule({
    balance: p.mortgage_balance, balanceDate: p.mortgage_balance_date || new Date().toISOString().slice(0, 10),
    terms: termsOf(p.id), segments, lumpSums: lumpSumsOf(p.id),
    paymentDay, frequency,
    primeRate: prime ? prime.rate : null, primeHistory: getPrimeHistory(), region: p.region || 'CA',
  });
  return r.state === 'projected' ? r : null;
}

// The current month ('YYYY-MM') on the household's calendar
// (America/Vancouver) — the month "today" means for balances.
function currentMonthKey() {
  return vancouverToday().slice(0, 7);
}

// The balance still owed TODAY: the projection's balance at the
// current month (see remainingBalanceAt in the engine). This is
// the one "current debt" figure every surface shows — the modal's
// Current Principal, the equity readout and the portfolio's
// outstanding — while mortgage_balance stays the recorded anchor.
// When the mortgage cannot project, the anchor is the fallback:
// it is the last balance actually recorded, never 0 or blank.
function remainingBalanceFor(p) {
  const anchor = p.mortgage_balance ?? null;
  if (!(p.mortgage_balance > 0)) return { balance: anchor, month: null };
  const r = projectionFor(p);
  if (!r) return { balance: anchor, month: null };
  return remainingBalanceAt(r.series, currentMonthKey(), anchor, r.payoffMonth);
}

// The projected balance at the end of a month ('YYYY-MM'), from the
// property's own schedule; null when the mortgage cannot project
// that far (no plan / no payment / past the horizon).
function projectedBalanceAtMonth(p, monthKey) {
  const r = projectionFor(p);
  if (!r) return null;
  const row = r.series.find((x) => x.month === monthKey);
  if (row) return row.balance;
  if (r.payoffMonth && r.payoffMonth <= monthKey) return 0;
  return null;
}

app.post('/api/properties/:id/terms', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  // The renewal prefill below computes a projected balance: like
  // every other calculation entry, refresh prime first so the
  // prefill prices against the latest full history.
  await ensureFreshPrime();
  const b = req.body || {};
  const terms = termsOf(p.id);
  const prev = terms.length ? terms[terms.length - 1] : null;
  // Renewal prefill: the new term starts the day after the previous
  // term ends, opens with the previous term's projected end balance
  // and keeps its lender until the user says otherwise (switching
  // banks = editing the lender here). The amortization is
  // deliberately NOT carried over — a renewal re-agrees it, so the
  // user re-enters it; until then the projection carries the last
  // payment past this term's start (see buildSchedule).
  const prevEndMonth = prev ? addMonthsDate(prev.start_date, prev.term_months - 1).slice(0, 7) : null;
  const candidate = {
    lender: b.lender !== undefined ? b.lender : (prev ? prev.lender : null),
    start_date: b.start_date !== undefined ? b.start_date
      : (prev ? addMonthsDate(prev.start_date, prev.term_months)
        : (p.mortgage_balance_date || new Date().toISOString().slice(0, 10))),
    term_months: b.term_months !== undefined ? b.term_months : 60,
    amortization_years: b.amortization_years !== undefined ? b.amortization_years : null,
    opening_balance: b.opening_balance !== undefined ? b.opening_balance
      : (prev ? (projectedBalanceAtMonth(p, prevEndMonth) ?? prev.opening_balance ?? p.mortgage_balance) : p.mortgage_balance),
    // The repayment method carries over a renewal like the lender
    // does — it is how the household pays, not a per-contract price.
    repayment_method: b.repayment_method !== undefined ? b.repayment_method
      : (prev ? prev.repayment_method || 'equal_payment' : 'equal_payment'),
    // The payment schedule (frequency / day) carries over a renewal
    // the same way; a balance anchor does not — it belongs to the
    // term containing it. A payment override does not carry over
    // either: a renewal re-derives its payment from its own
    // amortization unless an override is entered on it directly.
    payment_frequency: b.payment_frequency !== undefined ? b.payment_frequency
      : (prev ? prev.payment_frequency ?? null : null),
    payment_day: b.payment_day !== undefined ? b.payment_day
      : (prev ? prev.payment_day ?? null : null),
    payment_override: b.payment_override !== undefined ? b.payment_override : null,
    anchor_balance: b.anchor_balance !== undefined ? b.anchor_balance : null,
    anchor_date: b.anchor_date !== undefined ? b.anchor_date : null,
  };
  const clean = cleanTerm(candidate);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const t = clean.value;
  const info = db
    .prepare(`INSERT INTO mortgage_terms (property_id, lender, start_date, term_months, amortization_years, opening_balance, repayment_method, payment_frequency, payment_day, payment_override, anchor_balance, anchor_date, amortization_defaulted, ai_fields, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(p.id, t.lender, t.start_date, t.term_months, t.amortization_years, t.opening_balance, t.repayment_method, t.payment_frequency, t.payment_day, t.payment_override, t.anchor_balance, t.anchor_date, aiFieldsJson(cleanAiFields(b, TERM_AI_FIELDS)), nowIso(), nowIso());
  // A first term created already carrying an opening balance on a
  // property with no balance anchor seeds the anchor from the
  // pair, exactly as a term save does — otherwise the projection
  // has no balance to run from until some later edit. (A renewal
  // is never the earliest term, and an existing anchor is never
  // overwritten.)
  {
    const fresh = getProperty(p.id);
    if (fresh.mortgage_balance == null && t.opening_balance != null) {
      const earliest = termsOf(p.id)[0];
      if (earliest && earliest.id === Number(info.lastInsertRowid)) {
        db.prepare('UPDATE properties SET mortgage_balance = ?, mortgage_balance_date = ?, updated_at = ? WHERE id = ?')
          .run(t.opening_balance, t.start_date, nowIso(), p.id);
      }
    }
  }
  syncTermMirror(getProperty(p.id));
  syncTermAnchor(getProperty(p.id));
  syncScheduleMirror(getProperty(p.id));
  const row = db.prepare('SELECT * FROM mortgage_terms WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(termView(row, segmentsOf(p.id).map(segmentView), lumpSumsOf(p.id), termPayMapFor(getProperty(p.id))));
});

app.put('/api/properties/:id/terms/:termId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const term = db.prepare('SELECT * FROM mortgage_terms WHERE id = ? AND property_id = ?').get(req.params.termId, p.id);
  if (!term) return res.status(404).json({ error: 'term not found' });
  const b = req.body || {};
  const clean = cleanTerm({
    lender: b.lender !== undefined ? b.lender : term.lender,
    start_date: b.start_date !== undefined ? b.start_date : term.start_date,
    term_months: b.term_months !== undefined ? b.term_months : term.term_months,
    amortization_years: b.amortization_years !== undefined ? b.amortization_years : term.amortization_years,
    opening_balance: b.opening_balance !== undefined ? b.opening_balance : term.opening_balance,
    repayment_method: b.repayment_method !== undefined ? b.repayment_method : term.repayment_method,
    payment_frequency: b.payment_frequency !== undefined ? b.payment_frequency : term.payment_frequency,
    payment_day: b.payment_day !== undefined ? b.payment_day : term.payment_day,
    payment_override: b.payment_override !== undefined ? b.payment_override : term.payment_override,
    anchor_balance: b.anchor_balance !== undefined ? b.anchor_balance : term.anchor_balance,
    anchor_date: b.anchor_date !== undefined ? b.anchor_date : term.anchor_date,
  });
  if (clean.error) return res.status(400).json({ error: clean.error });
  const t = clean.value;
  const termAi = cleanAiFields(b, TERM_AI_FIELDS);
  db.prepare('UPDATE mortgage_terms SET lender=?, start_date=?, term_months=?, amortization_years=?, opening_balance=?, repayment_method=?, payment_frequency=?, payment_day=?, payment_override=?, anchor_balance=?, anchor_date=?, amortization_defaulted=0, ai_fields=?, updated_at=? WHERE id=?')
    .run(t.lender, t.start_date, t.term_months, t.amortization_years, t.opening_balance, t.repayment_method, t.payment_frequency, t.payment_day, t.payment_override, t.anchor_balance, t.anchor_date, termAi === null ? (term.ai_fields ?? null) : aiFieldsJson(termAi), nowIso(), term.id);
  // Editing the anchor pair on the term that carries it edits the
  // property's balance anchor itself — the two are one fact, stored
  // in both places: write the submitted pair through, then let the
  // placement sync re-seat the columns (a date moved onto or before
  // the term's start has already folded into the opening balance
  // above, and the anchor then lives there).
  if (b.anchor_balance !== undefined || b.anchor_date !== undefined) {
    const submittedBalance = b.anchor_balance !== undefined ? num(b.anchor_balance) : term.anchor_balance;
    const submittedDate = b.anchor_date !== undefined ? (b.anchor_date || null) : term.anchor_date;
    if (submittedBalance != null && submittedDate) {
      db.prepare('UPDATE properties SET mortgage_balance = ?, mortgage_balance_date = ?, updated_at = ? WHERE id = ?')
        .run(submittedBalance, submittedDate, nowIso(), p.id);
    }
  }
  // The earliest term's opening FIGURE and the property's
  // balance anchor are one fact whenever the anchor is folded
  // into that term (its date on or before the term's start — the
  // placement rule syncTermAnchor applies): the card edits the
  // figure as "Outstanding principal", while the projection runs
  // entirely off the property anchor, so an opening-figure save
  // must write the anchor figure through too, or the plan keeps
  // running on the old balance. The anchor DATE is its own fact:
  // it is seeded with the pair at the first save, but afterwards
  // it moves only through the anchor pair (the write-through
  // above) — a term-start edit never drags it; instead the
  // placement sync re-seats the standing anchor on the term that
  // now contains it, and the projection is unchanged by the move.
  // A save through the anchor pair itself is handled above and
  // excluded here, as is a save that never submitted the figure
  // (a lender-only edit must not move an anchor).
  {
    const fresh = getProperty(p.id);
    const earliest = termsOf(p.id)[0];
    if (earliest && earliest.id === term.id && t.opening_balance != null
      && b.anchor_balance === undefined && b.anchor_date === undefined) {
      if (fresh.mortgage_balance == null) {
        db.prepare('UPDATE properties SET mortgage_balance = ?, mortgage_balance_date = ?, updated_at = ? WHERE id = ?')
          .run(t.opening_balance, t.start_date, nowIso(), p.id);
      } else if (b.opening_balance !== undefined
        && p.mortgage_balance_date && p.mortgage_balance_date <= term.start_date) {
        db.prepare('UPDATE properties SET mortgage_balance = ?, updated_at = ? WHERE id = ?')
          .run(t.opening_balance, nowIso(), p.id);
      }
    }
  }
  syncTermAnchor(getProperty(p.id));
  syncScheduleMirror(getProperty(p.id));
  syncTermMirror(getProperty(p.id));
  const row = db.prepare('SELECT * FROM mortgage_terms WHERE id = ?').get(term.id);
  res.json(termView(row, segmentsOf(p.id).map(segmentView), lumpSumsOf(p.id), termPayMapFor(getProperty(p.id))));
});

app.delete('/api/properties/:id/terms/:termId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const term = db.prepare('SELECT * FROM mortgage_terms WHERE id = ? AND property_id = ?').get(req.params.termId, p.id);
  if (!term) return res.status(404).json({ error: 'term not found' });
  const terms = termsOf(p.id);
  if (terms.length <= 1) {
    return res.status(400).json({ error: 'a mortgage keeps at least one term — edit this term instead of deleting it' });
  }
  const remaining = terms.filter((t) => t.id !== term.id);
  db.transaction(() => {
    // The deleted term's segments move to the term in effect at
    // their start among the remaining ones (their dates — what the
    // projection prices from — do not change).
    const segs = db.prepare('SELECT id, start_date FROM rate_segments WHERE term_id = ?').all(term.id);
    const move = db.prepare('UPDATE rate_segments SET term_id = ? WHERE id = ?');
    for (const s of segs) {
      let owner = null;
      for (const t of remaining) if (t.start_date <= s.start_date) owner = t;
      move.run((owner || remaining[0]).id, s.id);
    }
    db.prepare('DELETE FROM lump_sums WHERE term_id = ?').run(term.id);
    db.prepare('DELETE FROM mortgage_terms WHERE id = ?').run(term.id);
  })();
  syncTermMirror(getProperty(p.id));
  syncTermAnchor(getProperty(p.id));
  syncScheduleMirror(getProperty(p.id));
  res.json(propertyView(getProperty(p.id)));
});

app.post('/api/properties/:id/lump-sums', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const b = req.body || {};
  if (!isDateStr(b.date)) return res.status(400).json({ error: 'date must be a valid date (YYYY-MM-DD)' });
  const amount = num(b.amount);
  if (amount === null || !(amount > 0)) return res.status(400).json({ error: 'amount must be a number > 0' });
  const terms = termsOf(p.id);
  let termId = null;
  if (b.term_id !== undefined && b.term_id !== null) {
    const t = terms.find((x) => x.id === Number(b.term_id));
    if (!t) return res.status(400).json({ error: 'term_id does not name a term of this property' });
    termId = t.id;
  } else if (terms.length) {
    let owner = null;
    for (const t of terms) if (t.start_date <= String(b.date)) owner = t;
    termId = (owner || terms[0]).id;
  }
  const info = db
    .prepare('INSERT INTO lump_sums (property_id, term_id, date, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, termId, String(b.date), amount, b.note ? String(b.note) : null, nowIso());
  res.status(201).json(db.prepare('SELECT * FROM lump_sums WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/properties/:id/lump-sums/:lsId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM lump_sums WHERE id = ? AND property_id = ?').run(req.params.lsId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'lump sum not found' });
  res.json({ ok: true });
});

// ------------------------------------------------------------- prime rate --
// The tracked prime lending rate (region source; Canada: Bank of
// Canada). current is the newest stored observation with its real
// as-of date; changes are the recent change points, newest first.
app.get('/api/prime', requireApiAuth, async (req, res) => {
  await ensureFreshPrime();
  res.json(primeInfo());
});

app.post('/api/prime/refresh', requireApiAuth, async (req, res) => {
  await refreshPrime();
  res.json(primeInfo());
});

// ---------------------------------------------------------- plan preview ---
// POST a DRAFT rate plan (a segment that is not saved yet, plus the
// owning term's plan fields as currently edited — repayment method
// and amortization) and get back the first month the plan would be
// in effect, computed by the SAME buildSchedule the projection
// endpoint runs on the saved data — so the previewed month is the
// month the projection will show once the plan is saved, to the
// cent. Nothing is written.
app.post('/api/properties/:id/preview', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  await ensureFreshPrime(); // previews price against the latest prime history too
  const b = req.body || {};
  const clean = cleanSegment(b, null);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const draft = clean.value;
  if (p.mortgage_balance === null || p.mortgage_balance === undefined || !(p.mortgage_balance > 0)) {
    return res.json({ ok: false, error: 'no outstanding principal recorded for this property' });
  }
  // The draft joins the segment timeline; a stored segment starting
  // the same day is the one being edited, so the draft replaces it.
  const segments = segmentsOf(p.id).filter((s) => s.start_date !== draft.start_date);
  segments.push({
    id: 0, property_id: p.id, term_id: null, created_at: nowIso(),
    start_date: draft.start_date, rate_type: draft.rate_type,
    rate_mode: draft.rate_mode, annual_rate: draft.annual_rate, spread: draft.spread,
    compounding: draft.compounding, accrual: draft.accrual, locked_on: draft.locked_on,
  });
  segments.sort((a, z) => (a.start_date < z.start_date ? -1 : a.start_date > z.start_date ? 1 : a.id - z.id));
  // The term the draft belongs to (the one named, else the one in
  // effect at its start) takes the draft plan fields.
  const terms = termsOf(p.id).map((t) => ({ ...t }));
  let owner = null;
  if (b.term_id !== undefined && b.term_id !== null) owner = terms.find((t) => t.id === Number(b.term_id)) || null;
  if (!owner) {
    for (const t of terms) if (t.start_date <= draft.start_date) owner = t;
    owner = owner || terms[0] || null;
  }
  if (owner) {
    if (b.repayment_method !== undefined) {
      if (!['equal_payment', 'equal_principal'].includes(b.repayment_method)) {
        return res.status(400).json({ error: "repayment_method must be 'equal_payment' or 'equal_principal'" });
      }
      owner.repayment_method = b.repayment_method;
    }
    if (b.amortization_years !== undefined) {
      const ay = num(b.amortization_years);
      if (ay !== null && (ay < 1 || ay > 35)) {
        return res.status(400).json({ error: 'amortization must be between 1 and 35 years' });
      }
      owner.amortization_years = ay;
    }
    // The owner term's payment override rides along the same way
    // (the term form's current value, saved or not): while it is
    // set the previewed payment IS the override.
    if (b.payment_override !== undefined) {
      if (b.payment_override === null || b.payment_override === '') {
        owner.payment_override = null;
      } else {
        const po = num(b.payment_override);
        if (po === null || !isFinite(po) || po <= 0) {
          return res.status(400).json({ error: 'monthly payment override must be a number greater than 0' });
        }
        owner.payment_override = po;
      }
    }
    // The draft segment's own locked_on (parsed by cleanSegment
    // above) prices the preview's derivations, so a preview
    // computed beside an unsaved Locked on edit derives the same
    // figure the save will produce.
  }
  const prime = getCurrentPrime();
  const { frequency, paymentDay } = termScheduleOf(p, terms);
  const r = buildSchedule({
    balance: p.mortgage_balance, balanceDate: p.mortgage_balance_date || new Date().toISOString().slice(0, 10),
    terms, segments, lumpSums: lumpSumsOf(p.id),
    paymentDay, frequency,
    primeRate: prime ? prime.rate : null, primeHistory: getPrimeHistory(), region: p.region || 'CA',
  });
  if (r.state === 'no_payment') {
    return res.json({ ok: false, code: 'NO_PAYMENT', error: 'set the term\u2019s amortization to preview this plan' });
  }
  if (r.state === 'no_prime') {
    return res.json({ ok: false, code: 'NO_PRIME', error: 'a variable segment is priced off the prime rate, but no prime rate is available yet' });
  }
  const startMonth = draft.start_date.slice(0, 7);
  const row = r.series.find((x) => x.month >= startMonth);
  if (!row) return res.json({ ok: false, error: 'this plan starts after the mortgage is paid off' });
  // The payment triple for the previewed month: `payment` is the
  // row's own (the override, when the owner term carries one);
  // the derived figure comes from a second run with the owner's
  // override stripped — the same month's row of that run.
  const ownerOverride = owner ? Number(owner.payment_override) : NaN;
  const paymentOverridden = isFinite(ownerOverride) && ownerOverride > 0;
  let paymentDerived = row.payment;
  if (paymentOverridden) {
    const derivedTerms = terms.map((t) => (t === owner ? { ...t, payment_override: null } : t));
    const rd = buildSchedule({
      balance: p.mortgage_balance, balanceDate: p.mortgage_balance_date || new Date().toISOString().slice(0, 10),
      terms: derivedTerms, segments, lumpSums: lumpSumsOf(p.id),
      paymentDay, frequency,
      primeRate: prime ? prime.rate : null, primeHistory: getPrimeHistory(), region: p.region || 'CA',
    });
    const dRow = rd.series.find((x) => x.month === row.month) || rd.series.find((x) => x.month >= startMonth);
    paymentDerived = dRow ? dRow.payment : null;
  }
  res.json({
    ok: true,
    month: row.month, date: row.date,
    payment: row.payment, interest: row.interest, principal: row.principal,
    balance: row.balance, rate: row.rate,
    paymentDerived, paymentOverridden,
  });
});

// ------------------------------------------------------- mortgage chart ---
// Monthly projection from the stored balance. The projection is computed
// ONLY from the user's own rate plan (the rate segments): there is no
// default or assumed rate anywhere. With no segments the endpoint reports
// a NO_RATE_PLAN state instead of projecting at 0%. The payment comes
// from the term schedule (engine buildSchedule): auto-computed from the
// balance, the rate in effect and the current term's amortization —
// re-derived at a term start, recast against the current trajectory's
// payoff at a rate change (equal payment) or re-anchored at the term's
// remaining amortization (equal principal), left unchanged by lump
// sums (they shorten the loan instead) and by prime moves (a variable
// plan's payment is set when the plan starts; prime only reprices
// each month's interest split, against the tracked prime history).
// The derived payment only ever comes out of this calculation; a
// term may carry a payment override that replaces it for that
// term's span — paymentUsed reports what actually runs,
// paymentDerived the calculated figure beside it.
app.get('/api/properties/:id/amortization', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  await ensureFreshPrime(); // fetch-on-read: refresh the prime history before computing
  const segments = segmentsOf(p.id);
  if (p.mortgage_balance === null || p.mortgage_balance === undefined || !(p.mortgage_balance > 0)) {
    return res.json({ ok: false, error: 'no outstanding principal recorded for this property', segments });
  }
  if (segments.length === 0) {
    return res.json({ ok: false, code: 'NO_RATE_PLAN', error: 'no rate plan yet', segments });
  }
  // Prime-spread segments resolve month by month against the
  // tracked prime history (each month at its own prime; only months
  // beyond the last observation hold at the latest known rate).
  // Without any prime on record they cannot be projected at all —
  // a named state, never a silent 0%.
  const prime = getCurrentPrime();
  const primeRate = prime ? prime.rate : null;
  if (segments.some((s) => s.rate_type === 'variable' && s.rate_mode === 'prime_spread') && primeRate === null) {
    return res.json({ ok: false, code: 'NO_PRIME', error: 'a variable segment is priced off the prime rate, but no prime rate is available yet', segments });
  }
  const balanceDate = p.mortgage_balance_date || new Date().toISOString().slice(0, 10);
  // The projection is built by the term schedule (engine
  // buildSchedule): the payment is calculated from the balance,
  // the rate in effect and the current term's amortization —
  // re-derived at a term start, recast or re-anchored (per the
  // term's repayment method) at a rate change, unchanged by lump
  // sums and by prime moves. NO_PAYMENT means the current term
  // has no amortization to compute a payment from.
  const { frequency, paymentDay } = termScheduleOf(p);
  const r = buildSchedule({
    balance: p.mortgage_balance, balanceDate,
    terms: termsOf(p.id), segments, lumpSums: lumpSumsOf(p.id),
    paymentDay, frequency, primeRate, primeHistory: getPrimeHistory(), region: p.region || 'CA',
  });
  if (r.state === 'no_payment') {
    return res.json({ ok: false, code: 'NO_PAYMENT', error: 'set the current term\u2019s remaining amortization (years) to project the mortgage', segments });
  }
  if (r.state === 'no_prime') {
    return res.json({ ok: false, code: 'NO_PRIME', error: 'a variable segment is priced off the prime rate, but no prime rate is available yet', segments });
  }
  const payment = r.paymentUsed;
  // What is still owed today, off this same projection (the
  // modal's Current Principal and the equity readout use the
  // matching server-side figure, so all three agree by construction).
  const remaining = remainingBalanceAt(r.series, currentMonthKey(), p.mortgage_balance, r.payoffMonth);
  res.json({
    ok: true,
    balance: p.mortgage_balance,
    balanceDate,
    remainingBalance: remaining.balance,
    remainingBalanceMonth: remaining.month,
    paymentUsed: payment,
    paymentDerived: r.paymentDerived,
    paymentOverridden: r.paymentOverridden,
    primeRate,
    primeAssumption: primeRate !== null
      ? `Past months use actual Bank of Canada prime history; future months assume prime stays at the latest known rate of ${Number(primeRate).toFixed(2)}%. For variable plans the payment is set when the plan starts and does not change when prime moves; only the interest/principal split changes.`
      : null,
    prime: primeStatus(),
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
// the property) minus the balance still owed TODAY (the projection's
// balance at the current month — the same remainingBalance the modal's
// Current Principal shows; the recorded anchor is only the fallback
// when the mortgage cannot project). Either side may be
// missing; the missing side comes back null and equity is null.
app.get('/api/properties/:id/equity', requireApiAuth, async (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  await ensureFreshPrime(); // the remaining balance prices off the prime history
  const points = historyPoints(p.id);
  const latest = points.length ? points[points.length - 1] : null;
  const assessed = latest ? latest.value : (p.assessed_value ?? null);
  const assessedYear = latest ? latest.year : (p.assessed_year ?? null);
  const remaining = remainingBalanceFor(p);
  const balance = remaining.balance;
  res.json({
    assessedValue: assessed,
    assessedYear,
    balance,
    remainingBalanceMonth: remaining.month,
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

// ------------------------------------------------------------ investments --
// Accounts → holdings → events, with the return engine's three
// views (portfolio / account / holding). Reads first refresh the
// price caches (fetch-on-read, see src/prices.js): exchange
// holdings pull Stooq closes, USD holdings pull the Valet FX
// series; failures keep the last known values and the response's
// priceStatus / fx fields say what is stale or missing — a read
// never fails because a price source is down.
// Display currency for a read: an explicit ?display=CAD|USD
// wins; anything else falls back to the caller-supplied page
// default (portfolio: CAD, account: the account's effective
// default, holding: the holding's own currency).
const parseInvestDisplay = (raw, fallback) =>
  (raw === 'CAD' || raw === 'USD') ? raw : fallback;

async function prepareInvestScope(holdings, display = 'CAD') {
  await Promise.all(holdings.map((h) => ensureHoldingPrices(db, h)));
  // FX is needed whenever a conversion crosses CAD↔USD: a USD
  // holding under a CAD display, or a CAD holding under a USD
  // display. (The cache itself is day-gated, so this costs
  // nothing on a fresh day.)
  if (holdings.some((h) => h.currency === 'USD' || (display === 'USD' && h.currency === 'CAD'))) {
    await ensureFxRates(db);
  }
  return makeFxResolver(db);
}

const investPriceStatus = (computed) => priceStatusFor(db, computed.holding,
  computed.summary.latestPrice != null
    ? { price: computed.summary.latestPrice, date: computed.summary.latestPriceDate, source: computed.summary.latestPriceSource }
    : null);

const investHoldingRow = (computed) => ({
  holding: computed.holding,
  summary: computed.summary,
  priceStatus: investPriceStatus(computed),
});

app.get('/api/investments', requireApiAuth, async (req, res) => {
  const display = parseInvestDisplay(req.query.display, 'CAD');
  const fx = await prepareInvestScope(listHoldings(db), display);
  const p = computePortfolio(db, fx, vancouverToday(), display);
  if (display === 'USD') pinCadReturnPct(p, computePortfolio(db, fx, vancouverToday(), 'CAD'));
  res.json({
    display,
    accounts: p.accounts.map((a) => ({
      account: a.account, summary: a.summary, monthly: a.monthly, series: a.series,
      holdings: a.holdings.map(investHoldingRow),
    })),
    monthly: p.monthly, series: p.series, summary: p.summary,
    fxMissing: fx.missing,
  });
});

// Security search for the Add Holding autocomplete. Best-effort
// by contract: upstream failure is an empty candidate list,
// never an error — the form always works fully manual.
app.get('/api/invest/search', requireApiAuth, async (req, res) => {
  res.json({ results: await searchSecurities(req.query.q) });
});

// Fill-with-AI preview: what each holding in a checked draft
// would be worth after Apply, and how far that moves its
// recorded value. Read-only — it writes nothing, and it uses
// stored prices/FX only (no fetch), so the preview is a pure
// function of recorded state + the draft. The panel posts the
// same checked rows Apply would write; the values come from
// computeFillPreview, the same engine the holding page uses.
app.post('/api/investments/accounts/:id/fill-preview', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const b = req.body || {};
  const draft = {
    holdings: Array.isArray(b.holdings) ? b.holdings : [],
    events: Array.isArray(b.events) ? b.events : [],
    nav: Array.isArray(b.nav) ? b.nav : [],
  };
  const recorded = listHoldings(db, account.id).map((h) => ({
    holding: h, events: listEvents(db, h.id), points: listPricePoints(db, h.id),
  }));
  const previews = computeFillPreview({ recorded, draft, fxResolver: makeFxResolver(db), today: vancouverToday() });
  res.json({ previews });
});

app.post('/api/investments/accounts', requireApiAuth, (req, res) => {
  const v = validAccountInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const own = cleanOwners((req.body || {}).owners);
  if (own.error) return res.status(400).json({ error: own.error });
  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO invest_accounts (name, type, institution, note, owners, default_currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(v.name, v.type, v.institution, v.note, JSON.stringify(own.value || []), v.defaultCurrency, ts, ts);
  res.status(201).json(getAccount(db, info.lastInsertRowid));
});

app.get('/api/investments/accounts/:id', requireApiAuth, async (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const holdings = listHoldings(db, account.id);
  // No explicit display → the account page opens in the
  // account's effective default (stored setting, else derived
  // from its holdings). An explicit ?display= overrides it for
  // this visit only and never rewrites the setting.
  const defaultCurrency = effectiveAccountDefaultCurrency(account, holdings);
  const display = parseInvestDisplay(req.query.display, defaultCurrency);
  const fx = await prepareInvestScope(holdings, display);
  // Contribution plans auto-generate on the account read (the
  // same fetch-on-read shape as prices): past due periods land
  // as buy events, newly priced skips fill in, and deleted
  // periods stay deleted. A generation failure never fails the
  // read — the plan view still lists its skipped periods.
  try { generatePlansForAccount(db, account.id, { today: vancouverToday(), ts: nowIso() }); } catch { /* plans still render below */ }
  const a = computeAccount(db, account, fx, vancouverToday(), display);
  if (display === 'USD') pinCadReturnPct(a, computeAccount(db, account, fx, vancouverToday(), 'CAD'));
  res.json({
    account: a.account, defaultCurrency, display,
    summary: a.summary, monthly: a.monthly, series: a.series,
    holdings: a.holdings.map((c) => ({ ...investHoldingRow(c), events: c.events })),
    plans: listPlans(db, account.id).map((p) => planView(db, p, vancouverToday())),
    fxMissing: fx.missing,
  });
});

// Contribution plans (see src/plans.js): frequency derives from
// the linked job, employer match is RRSP-only, due periods
// generate one buy event each on the target holding.
app.get('/api/investments/accounts/:id/plans', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  res.json({ plans: listPlans(db, account.id).map((p) => planView(db, p, vancouverToday())) });
});

app.post('/api/investments/accounts/:id/plans', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const v = validPlanInput(req.body || {}, { accountType: account.type });
  if (v.error) return res.status(400).json({ error: v.error });
  const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(v.jobId);
  if (!job) return res.status(400).json({ error: 'salary job not found' });
  const holding = getHolding(db, v.holdingId);
  if (!holding || holding.account_id !== account.id) return res.status(400).json({ error: 'target holding must belong to this account' });
  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO invest_plans (account_id, job_id, target_holding_id, start_date, own_amount, employer_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(account.id, v.jobId, v.holdingId, v.startDate, v.ownAmount, v.employerAmount, ts, ts);
  const plan = getPlan(db, info.lastInsertRowid);
  const gen = generatePlan(db, plan, { today: vancouverToday(), ts });
  res.status(201).json({ ...planView(db, plan, vancouverToday()), generation: gen });
});

app.put('/api/investments/plans/:id', requireApiAuth, (req, res) => {
  const plan = getPlan(db, Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const account = getAccount(db, plan.account_id);
  const v = validPlanInput(req.body || {}, { accountType: account.type });
  if (v.error) return res.status(400).json({ error: v.error });
  const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(v.jobId);
  if (!job) return res.status(400).json({ error: 'salary job not found' });
  const holding = getHolding(db, v.holdingId);
  if (!holding || holding.account_id !== account.id) return res.status(400).json({ error: 'target holding must belong to this account' });
  db.prepare('UPDATE invest_plans SET job_id = ?, target_holding_id = ?, start_date = ?, own_amount = ?, employer_amount = ?, updated_at = ? WHERE id = ?')
    .run(v.jobId, v.holdingId, v.startDate, v.ownAmount, v.employerAmount, nowIso(), plan.id);
  const updated = getPlan(db, plan.id);
  const gen = generatePlan(db, updated, { today: vancouverToday(), ts: nowIso() });
  res.json({ ...planView(db, updated, vancouverToday()), generation: gen });
});

app.delete('/api/investments/plans/:id', requireApiAuth, (req, res) => {
  const plan = getPlan(db, Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  // Generated buys stay as ordinary history (their plan link
  // clears); only the plan and its tombstones go.
  db.transaction(() => {
    db.prepare('UPDATE invest_events SET plan_id = NULL WHERE plan_id = ?').run(plan.id);
    db.prepare('DELETE FROM invest_plans WHERE id = ?').run(plan.id);
  })();
  res.json({ ok: true });
});

app.post('/api/investments/plans/:id/generate', requireApiAuth, (req, res) => {
  const plan = getPlan(db, Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const gen = generatePlan(db, plan, { today: vancouverToday(), ts: nowIso() });
  if (gen.error) return res.status(400).json({ error: gen.error });
  res.json({ ...planView(db, plan, vancouverToday()), generation: gen });
});

app.put('/api/investments/accounts/:id', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const v = validAccountInput(req.body || {}, account);
  if (v.error) return res.status(400).json({ error: v.error });
  // Owners follow the property rule: omitted means unchanged.
  let owners = account.owners || [];
  if ((req.body || {}).owners !== undefined) {
    const own = cleanOwners(req.body.owners);
    if (own.error) return res.status(400).json({ error: own.error });
    owners = own.value;
  }
  db.prepare('UPDATE invest_accounts SET name = ?, type = ?, institution = ?, note = ?, owners = ?, default_currency = ?, updated_at = ? WHERE id = ?')
    .run(v.name, v.type, v.institution, v.note, JSON.stringify(owners), v.defaultCurrency, nowIso(), account.id);
  res.json(getAccount(db, account.id));
});

app.delete('/api/investments/accounts/:id', requireApiAuth, (req, res) => {
  const doomed = listHoldings(db, Number(req.params.id)).map((h) => h.id);
  const info = db.prepare('DELETE FROM invest_accounts WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'account not found' });
  // Holdings cascade away, but their price-fetch stamps are
  // plain app_meta rows — clear them so a later holding that
  // reuses an id does not inherit a backoff or stale failure.
  for (const id of doomed) clearHoldingPriceMeta(db, id);
  res.json({ ok: true });
});

app.post('/api/investments/accounts/:id/holdings', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const v = validHoldingInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  // Optional initial transactions (the Add Holding form): the
  // whole batch validates BEFORE anything is written, then the
  // holding and its events land in one transaction — a bad row
  // is a 400 with nothing persisted.
  const ev = validInitialEvents(req.body ? req.body.events : undefined);
  if (ev.error) return res.status(400).json({ error: ev.error });
  const ts = nowIso();
  const source = req.body && req.body.source === 'ai' ? 'ai' : 'manual';
  let holdingId = null;
  db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO invest_holdings (account_id, label, kind, symbol, fund_code, currency, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(account.id, v.label, v.kind, v.symbol, v.fundCode, v.currency, source, ts, ts);
    holdingId = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of ev.events) {
      ins.run(holdingId, e.date, e.type, e.units, e.price, e.amount, e.splitNew, e.splitOld, e.note, source, ts, ts);
    }
  })();
  if (ev.events.length) rebuildEventPricePoints(db, holdingId, ts);
  res.status(201).json(getHolding(db, holdingId));
});

app.get('/api/investments/holdings/:id', requireApiAuth, async (req, res) => {
  const holding = getHolding(db, Number(req.params.id));
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const account = getAccount(db, holding.account_id);
  // No explicit display → the holding page opens in the
  // holding's own currency (a single holding's native view is
  // the natural default). An explicit ?display= overrides it
  // for this visit only.
  const display = parseInvestDisplay(req.query.display, holding.currency);
  const fx = await prepareInvestScope([holding], display);
  const c = computeHolding(db, holding, fx, vancouverToday(), display);
  res.json({
    holding: c.holding, account, display, summary: c.summary, monthly: c.monthly, series: c.series,
    events: c.events,
    navPoints: c.points.filter((p) => p.source === 'manual'),
    priceStatus: investPriceStatus(c),
    fxMissing: fx.missing,
  });
});

app.put('/api/investments/holdings/:id', requireApiAuth, (req, res) => {
  const holding = getHolding(db, Number(req.params.id));
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const v = validHoldingInput(req.body || {}, holding);
  if (v.error) return res.status(400).json({ error: v.error });
  db.transaction(() => {
    db.prepare('UPDATE invest_holdings SET label = ?, kind = ?, symbol = ?, fund_code = ?, currency = ?, updated_at = ? WHERE id = ?')
      .run(v.label, v.kind, v.symbol, v.fundCode, v.currency, nowIso(), holding.id);
    // A new symbol invalidates the closes fetched for the old
    // one; the next read refetches under the new symbol.
    if (v.symbol !== holding.symbol || v.kind !== holding.kind) {
      db.prepare("DELETE FROM invest_prices WHERE holding_id = ? AND source IN ('stooq', 'yahoo', 'nasdaq')").run(holding.id);
      db.prepare("DELETE FROM app_meta WHERE key = ?").run(`invest_px_${holding.id}_ok`);
    }
  })();
  res.json(getHolding(db, holding.id));
});

app.delete('/api/investments/holdings/:id', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM invest_holdings WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'holding not found' });
  clearHoldingPriceMeta(db, Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/investments/holdings/:id/events', requireApiAuth, (req, res) => {
  const holding = getHolding(db, Number(req.params.id));
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const v = validEventInput(req.body || {}, { events: listEvents(db, holding.id) });
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(holding.id, v.date, v.type, v.units, v.price, v.amount, v.splitNew, v.splitOld, v.note,
      req.body && req.body.source === 'ai' ? 'ai' : 'manual', ts, ts);
  rebuildEventPricePoints(db, holding.id, ts);
  res.status(201).json(db.prepare('SELECT * FROM invest_events WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/investments/events/:id', requireApiAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM invest_events WHERE id = ?').get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'event not found' });
  const v = validEventInput(req.body || {}, {
    base: ev, events: listEvents(db, ev.holding_id), exceptId: ev.id,
  });
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = nowIso();
  db.prepare('UPDATE invest_events SET date = ?, type = ?, units = ?, price = ?, amount = ?, split_new = ?, split_old = ?, note = ?, updated_at = ? WHERE id = ?')
    .run(v.date, v.type, v.units, v.price, v.amount, v.splitNew, v.splitOld, v.note, ts, ev.id);
  rebuildEventPricePoints(db, ev.holding_id, ts);
  res.json(db.prepare('SELECT * FROM invest_events WHERE id = ?').get(ev.id));
});

app.delete('/api/investments/events/:id', requireApiAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM invest_events WHERE id = ?').get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'event not found' });
  // A deleted plan-generated event tombstones its due period
  // so later generation runs never recreate it (see src/plans.js).
  db.transaction(() => {
    recordPlanEventDeletion(db, ev);
    db.prepare('DELETE FROM invest_events WHERE id = ?').run(ev.id);
  })();
  rebuildEventPricePoints(db, ev.holding_id, nowIso());
  res.json({ ok: true });
});

// A manual price snapshot — for bank funds this is the NAV
// entry, the fund's official price path; for an exchange holding
// it is a hand correction that outranks the fetched close on
// its date.
app.post('/api/investments/holdings/:id/nav', requireApiAuth, (req, res) => {
  const holding = getHolding(db, Number(req.params.id));
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const v = validNavInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const r = addNavPoint(db, holding.id, v, { overwrite: req.body && req.body.overwrite === true });
  if (r.error) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

// Inline row edit for a manual snapshot: date and price both
// changeable, full precision in and out (the row's displayed
// 2dp figure is never the edit value).
app.put('/api/investments/prices/:id', requireApiAuth, (req, res) => {
  const v = validNavInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const r = updateNavPoint(db, Number(req.params.id), v);
  if (r.error) return res.status(r.notFound ? 404 : 400).json({ error: r.error });
  res.json(r);
});

app.delete('/api/investments/prices/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM invest_prices WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'price point not found' });
  if (row.source !== 'manual') {
    return res.status(400).json({ error: 'only manual price snapshots can be deleted' });
  }
  db.prepare('DELETE FROM invest_prices WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.post('/api/investments/refresh', requireApiAuth, async (req, res) => {
  const results = await refreshAllPrices(db, listHoldings(db));
  res.json({ ok: true, refreshed: results.filter((r) => r.ok).map((r) => r.id), results });
});

// --------------------------------------------------------------- earnings ---
// Earnings is flows, not assets: nothing here feeds /api/summary.
// Salary and rental computations run server-side on read, so an edit
// always recalculates every derived number it governs.
const earnRegion = () => getRegion('CA');
const earnJobRow = (row) => {
  // A job's bonus_total is the bonuses dated in its tax year; the
  // calc adds it to the year's gross but never to the per-period
  // rate. Pay-change rows and bonuses ride along for the modal.
  const payChanges = db.prepare('SELECT effective_date, value FROM earn_pay_changes WHERE job_id = ? ORDER BY effective_date').all(row.id);
  const bonuses = db.prepare('SELECT date, amount FROM earn_bonuses WHERE job_id = ? ORDER BY date').all(row.id);
  const bonusTotal = bonuses.filter((b) => Number(String(b.date).slice(0, 4)) === row.tax_year)
    .reduce((s, b) => s + b.amount, 0);
  return {
    ...row,
    owner: row.owner || null,
    cpp_exempt: row.cpp_exempt === 1, ei_exempt: row.ei_exempt === 1,
    pay_changes: payChanges, bonuses, bonus_total: bonusTotal,
    calc: calcSalary({ ...row, bonus_total: bonusTotal }, earnRegion().payroll),
  };
};
const earnRentalYearRow = (rental, row) => {
  // Rent figures are derived from entries when any entry covers the
  // year; otherwise the row's stored figures stand (that is what
  // pre-entry records carry, and what a manual expenses-only year
  // shows). The calc always runs on the effective figures, so an
  // entry edit recalculates every derived number it governs.
  const entries = rental.entries || [];
  const derived = deriveRentalYearFigures(entries, row.tax_year);
  const effective = derived.covered
    ? { ...row, gross_rents: derived.gross_rents, rental_days: derived.rental_days }
    : row;
  const year = {
    ...effective,
    expenses: JSON.parse(row.expenses || '[]'),
    claim_cca: row.claim_cca === 1, cca_acknowledged: row.cca_acknowledged === 1,
    rent_derived: derived.covered,
  };
  return {
    ...year,
    calc: calcRentalYear(rental, {
      ...year, expenses: year.expenses,
      claim_cca: year.claim_cca, cca_acknowledged: year.cca_acknowledged,
    }, earnRegion().rental),
  };
};
const earnRentalRow = (row) => {
  const rental = {
    ...row,
    is_principal_residence: row.is_principal_residence === 1,
    was_principal_residence: row.was_principal_residence === 1,
    structural_change: row.structural_change === 1,
  };
  const entries = db.prepare('SELECT * FROM earn_rental_entries WHERE rental_id = ? ORDER BY start_ym, id').all(row.id);
  rental.entries = entries;
  const years = db.prepare('SELECT * FROM earn_rental_years WHERE rental_id = ? ORDER BY tax_year DESC').all(row.id);
  return { ...rental, years: years.map((y) => earnRentalYearRow(rental, y)) };
};
// Every tax year an entry covers gets a year record (bare defaults;
// the rent figures come from the entries at read time). INSERT OR
// IGNORE keeps a hand-made year record the user already has. Year
// records are never auto-deleted: if entries stop covering a year,
// that year falls back to its stored figures.
const ensureRentalYearsForEntry = (rentalId, entry) => {
  const ts = nowIso();
  for (const taxYear of entryCoveredYears(entry)) {
    const derived = deriveRentalYearFigures([entry], taxYear);
    db.prepare(
      `INSERT OR IGNORE INTO earn_rental_years (rental_id, tax_year, gross_rents, other_income, area_share_pct, rental_days,
       mortgage_interest, mortgage_principal, expenses, claim_cca, cca_acknowledged, created_at, updated_at)
       VALUES (?, ?, ?, 0, 100, ?, 0, 0, '[]', 0, 0, ?, ?)`).run(
      rentalId, taxYear, derived.gross_rents, derived.rental_days, ts, ts);
  }
};

app.get('/api/earnings/charts', requireApiAuth, (req, res) => {
  const jobs = db.prepare('SELECT * FROM earn_jobs ORDER BY employer').all().map(earnJobRow);
  const rentals = db.prepare('SELECT * FROM earn_rentals ORDER BY label').all().map(earnRentalRow);
  res.json(aggregateEarningsCharts(jobs, rentals));
});

app.get('/api/earnings', requireApiAuth, (req, res) => {
  const region = earnRegion();
  res.json({
    jobs: db.prepare('SELECT * FROM earn_jobs ORDER BY employer').all().map(earnJobRow),
    rentals: db.prepare('SELECT * FROM earn_rentals ORDER BY label').all().map(earnRentalRow),
    payrollProvinces: Object.entries(region.payroll.provinces).map(([code, p]) => ({
      code, label: p.label, verified: !!p.verified, note: p.note || null,
    })),
    payFrequencies: Object.entries(PAY_FREQUENCIES).map(([key, f]) => ({ key, ...f })),
    t776Lines: region.rental.t776Lines,
    taxYear: region.payroll.taxYear,
  });
});

// A derived save replaces a job's pay-change rows and bonus entries
// wholesale; a legacy save leaves them (and the derived date
// columns) untouched, so old jobs keep computing as before.
const writeJobChildren = (jobId, payChanges, bonuses, ts) => {
  db.prepare('DELETE FROM earn_pay_changes WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM earn_bonuses WHERE job_id = ?').run(jobId);
  const insC = db.prepare('INSERT INTO earn_pay_changes (job_id, effective_date, value, created_at) VALUES (?, ?, ?, ?)');
  const insB = db.prepare('INSERT INTO earn_bonuses (job_id, date, amount, created_at) VALUES (?, ?, ?, ?)');
  for (const c of payChanges) insC.run(jobId, c.effective_date, c.value, ts);
  for (const b of bonuses) insB.run(jobId, b.date, b.amount, ts);
};
const derivedJobYtd = (v, cppExempt, eiExempt) => deriveJobYtd({
  frequency: v.frequency, startDate: v.start_date, recentDate: v.recent_pay_date,
  changes: v.pay_changes, recentValue: v.recent_pay_value,
  payroll: earnRegion().payroll, cppExempt, eiExempt,
});

app.post('/api/earnings/jobs', requireApiAuth, (req, res) => {
  const v = validJobInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const own = cleanJobOwner((req.body || {}).owner);
  if (own.error) return res.status(400).json({ error: own.error });
  const ts = nowIso();
  if (v.mode === 'derived') {
    const ytd = derivedJobYtd(v, false, false);
    const id = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO earn_jobs (employer, owner, currency, province, frequency, gross_amount, gross_basis, tax_year,
         start_date, recent_pay_date,
         td1_federal, td1_provincial, ytd_cpp, ytd_cpp2, ytd_ei, cpp_exempt, ei_exempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        v.employer, own.value, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis, v.tax_year,
        v.start_date, v.recent_pay_date,
        null, null, ytd.ytd_cpp, ytd.ytd_cpp2, ytd.ytd_ei, 0, 0, ts, ts);
      writeJobChildren(info.lastInsertRowid, v.pay_changes, v.bonuses, ts);
      return info.lastInsertRowid;
    })();
    return res.status(201).json(earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)));
  }
  const info = db.prepare(
    `INSERT INTO earn_jobs (employer, owner, currency, province, frequency, gross_amount, gross_basis, tax_year,
     td1_federal, td1_provincial, ytd_cpp, ytd_cpp2, ytd_ei, cpp_exempt, ei_exempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    v.employer, own.value, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis, v.tax_year,
    v.td1_federal, v.td1_provincial, v.ytd_cpp, v.ytd_cpp2, v.ytd_ei,
    v.cpp_exempt ? 1 : 0, v.ei_exempt ? 1 : 0, ts, ts);
  res.status(201).json(earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(info.lastInsertRowid)));
});
app.put('/api/earnings/jobs/:id', requireApiAuth, (req, res) => {
  const v = validJobInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'job not found' });
  // Owner follows the property rule: omitted means unchanged, an
  // explicit empty value clears to unassigned.
  let owner = existing.owner || null;
  if ((req.body || {}).owner !== undefined) {
    const own = cleanJobOwner(req.body.owner);
    if (own.error) return res.status(400).json({ error: own.error });
    owner = own.value;
  }
  if (v.mode === 'derived') {
    // The new form carries no TD1 / exemption fields: an edit
    // preserves the stored values, so a job migrated by filling in
    // dates keeps its claims exactly.
    const ytd = derivedJobYtd(v, existing.cpp_exempt === 1, existing.ei_exempt === 1);
    db.transaction(() => {
      db.prepare(
        `UPDATE earn_jobs SET employer = ?, owner = ?, currency = ?, province = ?, frequency = ?, gross_amount = ?, gross_basis = ?,
         tax_year = ?, start_date = ?, recent_pay_date = ?, ytd_cpp = ?, ytd_cpp2 = ?, ytd_ei = ?, updated_at = ? WHERE id = ?`).run(
        v.employer, owner, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis,
        v.tax_year, v.start_date, v.recent_pay_date, ytd.ytd_cpp, ytd.ytd_cpp2, ytd.ytd_ei, nowIso(), id);
      writeJobChildren(id, v.pay_changes, v.bonuses, nowIso());
    })();
    return res.json(earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)));
  }
  db.prepare(
    `UPDATE earn_jobs SET employer = ?, owner = ?, currency = ?, province = ?, frequency = ?, gross_amount = ?, gross_basis = ?,
     tax_year = ?, td1_federal = ?, td1_provincial = ?, ytd_cpp = ?, ytd_cpp2 = ?, ytd_ei = ?,
     cpp_exempt = ?, ei_exempt = ?, updated_at = ? WHERE id = ?`).run(
    v.employer, owner, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis, v.tax_year,
    v.td1_federal, v.td1_provincial, v.ytd_cpp, v.ytd_cpp2, v.ytd_ei,
    v.cpp_exempt ? 1 : 0, v.ei_exempt ? 1 : 0, nowIso(), id);
  res.json(earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)));
});
app.delete('/api/earnings/jobs/:id', requireApiAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)) return res.status(404).json({ error: 'job not found' });
  // A job with linked contribution plans cannot go: plans
  // derive their frequency from it, so deleting it would
  // strand them. Delete the plans first, then the job.
  const linked = db.prepare('SELECT COUNT(*) AS n FROM invest_plans WHERE job_id = ?').get(id).n;
  if (linked > 0) {
    return res.status(400).json({ error: `cannot delete this job — ${linked} contribution plan${linked === 1 ? '' : 's'} link to it; delete the plan${linked === 1 ? '' : 's'} first` });
  }
  db.prepare('DELETE FROM earn_jobs WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/earnings/rentals', requireApiAuth, (req, res) => {
  const v = validRentalInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.property_id != null && !db.prepare('SELECT id FROM properties WHERE id = ?').get(v.property_id)) {
    return res.status(400).json({ error: 'property not found.' });
  }
  const ts = nowIso();
  const info = db.prepare(
    `INSERT INTO earn_rentals (property_id, label, address, rental_type, services_level, ownership_pct,
     is_principal_residence, was_principal_residence, structural_change, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    v.property_id, v.label, v.address, v.rental_type, v.services_level, v.ownership_pct,
    v.is_principal_residence ? 1 : 0, v.was_principal_residence ? 1 : 0, v.structural_change ? 1 : 0, ts, ts);
  res.status(201).json(earnRentalRow(db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(info.lastInsertRowid)));
});
app.put('/api/earnings/rentals/:id', requireApiAuth, (req, res) => {
  const v = validRentalInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM earn_rentals WHERE id = ?').get(id)) return res.status(404).json({ error: 'rental not found' });
  if (v.property_id != null && !db.prepare('SELECT id FROM properties WHERE id = ?').get(v.property_id)) {
    return res.status(400).json({ error: 'property not found.' });
  }
  db.prepare(
    `UPDATE earn_rentals SET property_id = ?, label = ?, address = ?, rental_type = ?, services_level = ?,
     ownership_pct = ?, is_principal_residence = ?, was_principal_residence = ?, structural_change = ?,
     updated_at = ? WHERE id = ?`).run(
    v.property_id, v.label, v.address, v.rental_type, v.services_level, v.ownership_pct,
    v.is_principal_residence ? 1 : 0, v.was_principal_residence ? 1 : 0, v.structural_change ? 1 : 0, nowIso(), id);
  res.json(earnRentalRow(db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(id)));
});
app.delete('/api/earnings/rentals/:id', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM earn_rentals WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'rental not found' });
  res.json({ ok: true });
});

app.post('/api/earnings/rentals/:id/years', requireApiAuth, (req, res) => {
  const rentalId = Number(req.params.id);
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(rentalId);
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  const v = validRentalYearInput(req.body || {}, earnRegion().rental.t776Lines);
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = nowIso();
  try {
    const info = db.prepare(
      `INSERT INTO earn_rental_years (rental_id, tax_year, gross_rents, other_income, area_share_pct, rental_days,
       mortgage_interest, mortgage_principal, expenses, claim_cca, cca_acknowledged, ucc_class1, ucc_class8,
       str_compliant_days, str_non_compliant_days, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, 365, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      rentalId, v.tax_year, v.other_income, v.area_share_pct,
      v.mortgage_interest, v.mortgage_principal, JSON.stringify(v.expenses),
      v.claim_cca ? 1 : 0, v.cca_acknowledged ? 1 : 0, v.ucc_class1, v.ucc_class8,
      v.str_compliant_days, v.str_non_compliant_days, ts, ts);
    res.status(201).json(earnRentalYearRow(earnRentalRow(rental), db.prepare('SELECT * FROM earn_rental_years WHERE id = ?').get(info.lastInsertRowid)));
  } catch {
    return res.status(400).json({ error: 'a year record already exists for this rental.' });
  }
});
app.put('/api/earnings/rentals/:rentalId/years/:yearId', requireApiAuth, (req, res) => {
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(req.params.rentalId));
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  const yearId = Number(req.params.yearId);
  if (!db.prepare('SELECT id FROM earn_rental_years WHERE id = ? AND rental_id = ?').get(yearId, rental.id)) {
    return res.status(404).json({ error: 'year record not found' });
  }
  const v = validRentalYearInput(req.body || {}, earnRegion().rental.t776Lines);
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare(
    `UPDATE earn_rental_years SET tax_year = ?, other_income = ?, area_share_pct = ?,
     mortgage_interest = ?, mortgage_principal = ?, expenses = ?, claim_cca = ?, cca_acknowledged = ?,
     ucc_class1 = ?, ucc_class8 = ?, str_compliant_days = ?, str_non_compliant_days = ?, updated_at = ?
     WHERE id = ?`).run(
    v.tax_year, v.other_income, v.area_share_pct,
    v.mortgage_interest, v.mortgage_principal, JSON.stringify(v.expenses),
    v.claim_cca ? 1 : 0, v.cca_acknowledged ? 1 : 0, v.ucc_class1, v.ucc_class8,
    v.str_compliant_days, v.str_non_compliant_days, nowIso(), yearId);
  res.json(earnRentalYearRow(earnRentalRow(rental), db.prepare('SELECT * FROM earn_rental_years WHERE id = ?').get(yearId)));
});
app.delete('/api/earnings/rentals/:rentalId/years/:yearId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM earn_rental_years WHERE id = ? AND rental_id = ?')
    .run(Number(req.params.yearId), Number(req.params.rentalId));
  if (!info.changes) return res.status(404).json({ error: 'year record not found' });
  res.json({ ok: true });
});

// -------------------------------------------------------- rent entries --
// The user-facing rent input: entries, not annual figures. An entry
// save re-derives every year it covers (the read path recomputes;
// this only ensures the year records exist).
app.post('/api/earnings/rentals/:id/entries', requireApiAuth, (req, res) => {
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(req.params.id));
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  const v = validRentalEntryInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = nowIso();
  const info = db.prepare(
    `INSERT INTO earn_rental_entries (rental_id, start_ym, end_ym, monthly_rent, pay_day, cash_amount, tenant_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rental.id, v.start_ym, v.end_ym, v.monthly_rent, v.pay_day, v.cash_amount, v.tenant_name, ts, ts);
  const entry = db.prepare('SELECT * FROM earn_rental_entries WHERE id = ?').get(info.lastInsertRowid);
  ensureRentalYearsForEntry(rental.id, entry);
  res.status(201).json(earnRentalRow(rental));
});
app.put('/api/earnings/rentals/:rentalId/entries/:entryId', requireApiAuth, (req, res) => {
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(req.params.rentalId));
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  const entryId = Number(req.params.entryId);
  if (!db.prepare('SELECT id FROM earn_rental_entries WHERE id = ? AND rental_id = ?').get(entryId, rental.id)) {
    return res.status(404).json({ error: 'entry not found' });
  }
  const v = validRentalEntryInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare(
    `UPDATE earn_rental_entries SET start_ym = ?, end_ym = ?, monthly_rent = ?, pay_day = ?,
     cash_amount = ?, tenant_name = ?, updated_at = ? WHERE id = ?`).run(
    v.start_ym, v.end_ym, v.monthly_rent, v.pay_day, v.cash_amount, v.tenant_name, nowIso(), entryId);
  const entry = db.prepare('SELECT * FROM earn_rental_entries WHERE id = ?').get(entryId);
  ensureRentalYearsForEntry(rental.id, entry);
  res.json(earnRentalRow(rental));
});
app.delete('/api/earnings/rentals/:rentalId/entries/:entryId', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM earn_rental_entries WHERE id = ? AND rental_id = ?')
    .run(Number(req.params.entryId), Number(req.params.rentalId));
  if (!info.changes) return res.status(404).json({ error: 'entry not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- spending ---
// Credit cards: cards (last 4 digits ONLY — a full PAN is rejected),
// transactions, QFX import (parse → preview → Apply), and AI
// category analysis. Spending is a flow, like Earnings: nothing here
// feeds /api/summary or net worth.
//   Sign rule: charges store NEGATIVE, payments positive; totals sum
//   -amount over charges only.
function getSpendCard(id) {
  return db.prepare('SELECT * FROM spend_cards WHERE id = ?').get(id) || null;
}
function listSpendCards() {
  return db.prepare('SELECT * FROM spend_cards ORDER BY name').all();
}
function listSpendTx(cardId) {
  return db.prepare('SELECT * FROM spend_transactions WHERE card_id = ? ORDER BY date DESC, id DESC').all(cardId);
}
function listAllSpendTx() {
  return db.prepare(
    `SELECT t.*, c.name AS card_name FROM spend_transactions t
     JOIN spend_cards c ON c.id = t.card_id ORDER BY t.date DESC, t.id DESC LIMIT 2000`).all();
}
function spendCardView(card) {
  const tx = listSpendTx(card.id);
  const charges = tx.filter((t) => Number(t.amount) < 0);
  return {
    ...card,
    txCount: tx.length,
    totalSpent: spendTotal(tx),
    lastTxDate: tx.length ? tx[0].date : null,
    chargeCount: charges.length,
  };
}
function validSpendCardInput(b) {
  const name = String((b && b.name) || '').trim();
  if (!name) return { error: 'Card name is required.' };
  const last4 = String((b && b.last4) || '').trim();
  if (!/^\d{4}$/.test(last4)) return { error: 'Enter only the last 4 digits of the card number.' };
  const issuer = b && b.issuer != null ? String(b.issuer).trim() : '';
  return { name, issuer: issuer || null, last4 };
}
function spendMerchantMappings(userId) {
  const row = db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'spend_merchant_categories'").get(userId);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
function saveSpendMerchantMappings(userId, mappings) {
  db.prepare(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, 'spend_merchant_categories', ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(mappings), nowIso());
}
const SPEND_AI_UNCONFIGURED = 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.';

app.get('/api/spending', requireApiAuth, (req, res) => {
  const cards = listSpendCards().map(spendCardView);
  const transactions = listAllSpendTx();
  res.json({ cards, transactions, monthly: spendMonthly(transactions) });
});
app.post('/api/spending/cards', requireApiAuth, (req, res) => {
  const v = validSpendCardInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const ts = nowIso();
  const info = db.prepare('INSERT INTO spend_cards (name, issuer, last4, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(v.name, v.issuer, v.last4, ts, ts);
  res.status(201).json(spendCardView(getSpendCard(info.lastInsertRowid)));
});
app.put('/api/spending/cards/:id', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const v = validSpendCardInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare('UPDATE spend_cards SET name = ?, issuer = ?, last4 = ?, updated_at = ? WHERE id = ?')
    .run(v.name, v.issuer, v.last4, nowIso(), card.id);
  res.json(spendCardView(getSpendCard(card.id)));
});
app.delete('/api/spending/cards/:id', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM spend_cards WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'card not found' });
  res.json({ ok: true });
});
app.get('/api/spending/cards/:id', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const transactions = listSpendTx(card.id);
  res.json({ card: spendCardView(card), transactions, monthly: spendMonthly(transactions) });
});
app.post('/api/spending/cards/:id/transactions', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const b = req.body || {};
  if (!validSpendDate(b.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
  const merchant = String(b.merchant || '').trim();
  if (!merchant) return res.status(400).json({ error: 'merchant is required.' });
  const raw = Number(b.amount);
  if (!Number.isFinite(raw) || raw === 0) return res.status(400).json({ error: 'amount must be a non-zero number.' });
  const amount = b.type === 'payment' ? Math.abs(raw) : -Math.abs(raw);
  const category = b.category != null ? String(b.category).trim() : '';
  const info = db.prepare(
    `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'manual', ?)`).run(
    card.id, b.date, merchant, b.memo != null ? String(b.memo) : null, category || null, amount, nowIso());
  res.status(201).json(db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(info.lastInsertRowid));
});
app.put('/api/spending/transactions/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'transaction not found' });
  const b = req.body || {};
  const merchant = b.merchant != null ? String(b.merchant).trim() : row.merchant;
  if (!merchant) return res.status(400).json({ error: 'merchant is required.' });
  const category = b.category != null ? String(b.category).trim() : row.category;
  db.prepare('UPDATE spend_transactions SET merchant = ?, memo = ?, category = ? WHERE id = ?')
    .run(merchant, b.memo != null ? String(b.memo) : row.memo, category || null, row.id);
  res.json(db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(row.id));
});
app.delete('/api/spending/transactions/:id', requireApiAuth, (req, res) => {
  const info = db.prepare('DELETE FROM spend_transactions WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'transaction not found' });
  res.json({ ok: true });
});
// QFX import, step 1: parse writes nothing. Rows already on the card
// are flagged existing so the preview can show what Apply will skip.
app.post('/api/spending/cards/:id/import-qfx/parse', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const text = req.body && typeof req.body.qfxText === 'string' ? req.body.qfxText : '';
  if (!text.trim()) return res.status(400).json({ error: 'Paste QFX file contents to parse.' });
  const parsed = parseQfx(text);
  const existing = new Set(listSpendTx(card.id).map((t) => t.fitid).filter(Boolean));
  res.json({
    accountId: parsed.accountId,
    rows: parsed.rows.map((r) => ({ ...r, existing: existing.has(r.fitid) })),
    dropped: parsed.dropped,
  });
});
// QFX import, step 2: one atomic transaction. Rows are re-validated
// here — the preview is client state, never trusted.
app.post('/api/spending/cards/:id/import-qfx/apply', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const existing = new Set(listSpendTx(card.id).map((t) => t.fitid).filter(Boolean));
  const v = validateSpendApply((req.body || {}).rows, existing);
  const ts = nowIso();
  try {
    db.transaction(() => {
      const ins = db.prepare(
        `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'qfx', ?)`);
      for (const r of v.valid) ins.run(card.id, r.date, r.merchant, r.memo, null, r.amount, r.fitid, ts);
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json({ inserted: v.valid.length, skipped: v.skipped.length, dropped: v.dropped });
});
// AI category analysis (overall level): propose a category for each
// merchant with uncategorized transactions and no remembered mapping.
// Writes nothing — Apply saves the mappings and categorizes.
app.post('/api/spending/ai-categories', requireApiAuth, async (req, res) => {
  if (!llmConfigured()) return res.status(503).json({ error: SPEND_AI_UNCONFIGURED });
  const mappings = spendMerchantMappings(req.user.id);
  const uncategorized = listAllSpendTx().filter((t) => !(t.category || '').trim());
  const byMerchant = new Map();
  for (const t of uncategorized) {
    const key = normalizeMerchant(t.merchant);
    if (!key || mappings[key]) continue;
    const entry = byMerchant.get(key) || { merchant: t.merchant, txCount: 0 };
    entry.txCount += 1;
    byMerchant.set(key, entry);
  }
  const merchants = [...byMerchant.values()];
  if (!merchants.length) return res.json({ proposals: [] });
  const prompt = `Assign each merchant one category from this list: ${SPEND_CATEGORIES.join(', ')}.
Reply with ONLY this JSON, no other text: {"proposals": [{"merchant": "<merchant as given>", "category": "<one of the list>"}]}.
Merchants: ${JSON.stringify(merchants.map((m) => m.merchant))}`;
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch {
    return res.status(502).json({ error: 'The AI service could not complete the analysis.' });
  }
  const parsed = parseModelJson(raw);
  const proposals = [];
  if (parsed && Array.isArray(parsed.proposals)) {
    for (const p of parsed.proposals) {
      if (!p || typeof p.merchant !== 'string') continue;
      const key = normalizeMerchant(p.merchant);
      const entry = byMerchant.get(key);
      if (!entry || !SPEND_CATEGORIES.includes(p.category)) continue;
      proposals.push({ merchant: entry.merchant, category: p.category, txCount: entry.txCount });
    }
  }
  res.json({ proposals });
});
app.post('/api/spending/ai-categories/apply', requireApiAuth, (req, res) => {
  const proposals = Array.isArray((req.body || {}).proposals) ? req.body.proposals : [];
  const mappings = spendMerchantMappings(req.user.id);
  let updated = 0;
  db.transaction(() => {
    for (const p of proposals) {
      if (!p || typeof p.merchant !== 'string' || !SPEND_CATEGORIES.includes(p.category)) continue;
      mappings[normalizeMerchant(p.merchant)] = p.category;
    }
    saveSpendMerchantMappings(req.user.id, mappings);
    // Per-merchant updates (a mapping keys on the normalized name, so
    // each merchant's rows update under its own category).
    for (const p of proposals) {
      if (!p || typeof p.merchant !== 'string' || !SPEND_CATEGORIES.includes(p.category)) continue;
      const key = normalizeMerchant(p.merchant);
      const rows = db.prepare("SELECT id, merchant FROM spend_transactions WHERE category IS NULL OR category = ''").all();
      for (const r of rows) {
        if (normalizeMerchant(r.merchant) === key) {
          updated += db.prepare('UPDATE spend_transactions SET category = ? WHERE id = ?').run(p.category, r.id).changes;
        }
      }
    }
  })();
  res.json({ mapped: proposals.length, updated });
});
// Card detail ✨ Fill with AI: propose transaction rows from pasted
// text. Writes nothing — Apply inserts the confirmed rows.
app.post('/api/spending/cards/:id/fill', requireApiAuth, async (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  if (!llmConfigured()) return res.status(503).json({ error: SPEND_AI_UNCONFIGURED });
  const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'Paste transaction text to extract from.' });
  const prompt = `Extract credit card transactions from this text. Amounts are positive spending amounts.
Categories, when clear, come from this list, else null: ${SPEND_CATEGORIES.join(', ')}.
Reply with ONLY this JSON, no other text: {"transactions": [{"date": "YYYY-MM-DD", "merchant": "...", "amount": 0, "category": null, "memo": null}]}.
Text: ${text.slice(0, 20000)}`;
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch {
    return res.status(502).json({ error: 'The AI service could not complete the extraction.' });
  }
  const parsed = parseModelJson(raw);
  const proposals = [];
  const dropped = [];
  if (parsed && Array.isArray(parsed.transactions)) {
    for (const t of parsed.transactions) {
      const merchant = t && typeof t.merchant === 'string' ? t.merchant.trim() : '';
      const amount = t ? Number(t.amount) : NaN;
      if (!t || !validSpendDate(t.date) || !merchant || !Number.isFinite(amount) || amount === 0) {
        dropped.push({ reason: 'invalid date, merchant or amount', merchant: merchant || null });
        continue;
      }
      proposals.push({
        date: t.date,
        merchant,
        amount: -Math.abs(amount),
        category: SPEND_CATEGORIES.includes(t.category) ? t.category : null,
        memo: t.memo != null ? String(t.memo) : null,
      });
    }
  }
  res.json({ proposals, dropped });
});
app.post('/api/spending/cards/:id/fill/apply', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const valid = [];
  const dropped = [];
  for (const r of rows) {
    const merchant = r && typeof r.merchant === 'string' ? r.merchant.trim() : '';
    const amount = r ? Number(r.amount) : NaN;
    if (!r || !validSpendDate(r.date) || !merchant || !Number.isFinite(amount) || amount === 0) {
      dropped.push({ reason: 'invalid date, merchant or amount', merchant: merchant || null });
      continue;
    }
    valid.push({
      date: r.date,
      merchant,
      memo: r.memo != null ? String(r.memo) : null,
      category: SPEND_CATEGORIES.includes(r.category) ? r.category : null,
      amount: -Math.abs(amount),
    });
  }
  const ts = nowIso();
  db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'ai', ?)`);
    for (const r of valid) ins.run(card.id, r.date, r.merchant, r.memo, r.category, r.amount, ts);
  })();
  res.status(201).json({ inserted: valid.length, dropped });
});

// ---------------------------------------------------------------- summary ---
// Overview asset-composition chart: Property + Stock history.
// Read-only aggregation for the Overview panel only — it changes
// no other endpoint's contract and never feeds net worth (stocks
// stay OUT of /api/summary; this chart is a composition view).
//   assessedByYear: yearly assessed totals, same carry-forward
//     rule as /api/properties/portfolio — a property counts from
//     its first known year on; a property with a stored assessed
//     value but no history points contributes that one point.
//   stockSeries: the Stocks engine's portfolio month-end series
//     in CAD (the /api/investments pipeline, display pinned CAD).
// No mortgage projection, no prime fetch, no BCA fetch here:
// assessed points come from stored history, prices/FX refresh
// under the same day gate as the Stocks page.
app.get('/api/overview/chart', requireApiAuth, async (req, res) => {
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const props = db.prepare('SELECT id, assessed_value, assessed_year FROM properties ORDER BY id').all();
  const perProperty = props.map((p) => {
    let points = historyPoints(p.id).map((pt) => ({ year: pt.year, value: pt.value }));
    if (!points.length && p.assessed_value != null && p.assessed_year) {
      points = [{ year: p.assessed_year, value: p.assessed_value }];
    }
    return points;
  });
  const years = [...new Set(perProperty.flatMap((pts) => pts.map((pt) => pt.year)))].sort((a, b) => a - b);
  const assessedByYear = years.map((year) => {
    let total = 0;
    for (const pts of perProperty) {
      let v = null;
      for (const pt of pts) { if (pt.year <= year) v = pt.value; else break; }
      if (v !== null) total += v;
    }
    return { year, total: r2(total) };
  });
  const holdings = listHoldings(db);
  const fx = await prepareInvestScope(holdings, 'CAD');
  const p = computePortfolio(db, fx, vancouverToday(), 'CAD');
  res.json({
    assessedByYear,
    stockSeries: p.series.map((s) => ({ month: s.month, value: s.value })),
    currentMonth: currentMonthKey(),
    fxMissing: fx.missing,
    hasUsdHoldings: holdings.some((h) => h.currency === 'USD'),
  });
});

app.get('/api/summary', requireApiAuth, (req, res) => {
  const props = db.prepare('SELECT * FROM properties').all();
  const propertyValue = props.reduce((s, p) => s + (p.assessed_value || 0), 0);
  // The mortgage total is what is still owed TODAY (each
  // property's remaining balance, anchor as the fallback) — the
  // same figure the portfolio and the detail page report.
  const mortgageBalance = props.reduce((s, p) => s + (remainingBalanceFor(p).balance || 0), 0);
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
// No prime pre-warm here: prime freshness is fetch-on-read (the
// projection and property endpoints ensure it inline), so startup
// stays instant.
export { app };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  app.listen(PORT, () => console.log(`[finance-mate] listening on http://localhost:${PORT} (data: ${DATA_DIR})`));
}
