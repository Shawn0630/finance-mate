// Finance Mate — server. Express + SQLite, no build step.
// Modules this round: Assets (properties / mortgages / other assets).
// Spending, Planning and Tax are placeholder pages in the UI for now.
import './env.js'; // .env fallback values first, before anything reads the env
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, PHOTOS_DIR, AVATARS_DIR, seedUsers, verifyPassword, hashPassword, defaultAvatarColor, migrateRentalMarkSources } from './db.js';
import { buildSchedule, segmentForMonth, segmentAnnualRate, segmentRateForMonth, derivePayment, primeAtDateResolver, primeHistoryResolver, remainingBalanceAt, FREQUENCIES, FREQUENCY_KEYS, periodPaymentFor } from './engine.js';
import { getRegion, REGION_CODES } from './regions/index.js';
import { getCurrentPrime, getPrimeHistory, ensureFreshPrime, refreshPrime, primeInfo, primeStatus, vancouverToday } from './prime.js';
import {
  applyBcaFetchResult, noteBcaAttempt, ensureFreshAssessment, bcaRefreshStatus,
  runHouseSigmaPull, houseSigmaPullStatus, pullHouseSigmaHistoryInBackground,
} from './assessed.js';
import { handleAiFill, handleAiFillChat, handleAiInvestFillChat, handleAiSlipFill, handleAiItemFill, handleAiProfileFill, llmModels, llmDefaultModel, llmConfigured, callLlm, parseModelJson, validateChatFiles, fileContentParts } from './aiFill.js';
import { costsView, listCosts, validCostInput, upsertCost, parseStoredMonthlyAmounts, costAnnual } from './costs.js';
import {
  ACCOUNT_TYPES, EVENT_TYPES, validAccountInput, validHoldingInput, validEventInput, validNavInput, validInitialEvents,
  addNavPoint, updateNavPoint,
  listAccounts, getAccount, listHoldings, getHolding, listEvents, listPricePoints, rebuildEventPricePoints,
  computeHolding, computeAccount, computePortfolio, computeFillPreview, unitsOn, displayRate,
  effectiveAccountDefaultCurrency, pinCadReturnPct,
} from './investments.js';
import { ensureHoldingPrices, ensureFxRates, refreshAllPrices, priceStatusFor, makeFxResolver, searchSecurities, latestPrice, clearHoldingPriceMeta, ensurePoolHistory, ensureSymbolHistory, listSymbolPricePoints } from './prices.js';
import { parseWealthsimpleCsv, validateImportApply } from './wsImport.js';
import {
  PAY_FREQUENCIES, validJobInput, validRentalInput, validRentalYearInput, validRentalEntryInput,
  calcSalary, calcRentalYear, aggregateEarningsCharts, deriveJobYtd, solveGrossForTakeHome, nextPayDate, jobMonthlySeries,
  deriveRentalYearFigures, entryCoveredYears, resolvePayChangeValues, positionValueFor, nextRentPayments,
} from './earnings.js';
import {
  validPlanInput, listPlans, getPlan, planView, generatePlan, generatePlansForAccount,
  recordPlanEventDeletion, planPeriodAmounts, planJobPerPeriodGross,
} from './plans.js';
import { analyzeCsv, activityValuesFor, applyMappedCsv, proposeCsvMapping, reviseCsvMapping, translatePreview } from './csvMapImport.js';
import {
  SPEND_CATEGORIES, parseQfx, validateSpendApply, normalizeMerchant, validSpendDate,
  spendMonthly, spendTotal, spendBalance,
} from './spending.js';
import {
  buildStandardInsights, homeHighlightRows, buildHomeMetricLibrary, resolveHomeMetric, homeAiPrompt,
  displayedSalaryMonths, homeOrderKey, applyHomeInsightOrder, mortgageMonthPaymentDates, jobTakehomePeriods,
  homeCalendarDates, daysInMonth as homeDaysInMonth, validateHomeComposite, parseHomeCompositeMetric,
  nextMonth as homeNextMonth, prevMonth as homePrevMonth, lastCompletedMonth as homeLastCompletedMonth,
  addMonthsYm as homeAddMonthsYm,
} from './home.js';
import {
  snapshotByAggregate, emptySnapshot, recordCommit, listCommits, getCommit, getCommitFull,
  undoCommit, restoreCommit, findDependents, mergeEventFromEntries, eventFromRowStates, readRow,
} from './history.js';
import {
  buildExport, validateExport, applyImport, writeBackup, listBackups, readBackup,
  EXPORT_FORMAT, EXPORT_VERSION,
} from './dataExport.js';
import { recordSyncLog, listSyncLog } from './syncLog.js';
import {
  TAX_ITEM_KINDS, TAX_ITEM_STATUSES, TAX_FILING_STATUSES,
  effectiveAmount, filingTotals, sectionSummary,
  validSharePct, validTaxItemInput, validTaxSlipInput, validTaxProfileInput,
  buildExpectedContext, rrspBenefit, rentalDeductible, rentalNet,
  respRoomSplit, cesgRoomSplit, RESP_LIFETIME_LIMIT,
  taxRoomCutoff, throughDate, findSlipLinkMatches,
} from './tax.js';
import {
  applyStoredCustomSinkRate,
  calcPenalty, validateOp, validateLegs,
  computeProjection, compareProjections, returnSuggestionsFromPoints,
  buildMergeWrites, buildRevertInverse, OP_TYPES, monthIdxOf, ymOfIdx, round2,
  latestMaturityMonth, maturityHorizonMonths, activeTermEndMonth,
  reportMonthlySeries, reportCostBreakdown, monthlyNetCashflowSeries,
  planProjectTemplate, buildPlanAiSnapshot, normalizeAiAsk,
  planAiEntityCandidates, rewriteAiIdQuestions, dropAnsweredAiQuestions, bindAiNameAnswers,
  sanitizeAiThread, appendAiThread, renderAiThreadText,
  equityDeltaPeak, principalDeltaVsBaseline,
  principalGainSeries, validateAiBaseline, validateAiCreateProposal, paymentScopeFor,
  scopeMainlineToProperty,
  PLAN_OPT_CATEGORIES, planOptCategory, planOptSubcategory, planFirstSubcategory,
  planListSections,
  validateStrategyFactors, validateScenarioFactors, groupStrategyFactorsForMigration,
  primeFactorToScenario, factorsToAssumptions,
  primeFactorPresetPoints, PLAN_PRIME_PRESETS, PLAN_PRIME_PRESET_LABELS,
  expandScenarioPrimePreset, planProjectAiSummaries, aiRepairPrompt,
  currentReturnRateFromPoints, validatePoolItemShapes, poolExternalCash,
  validateReportScenarioIds, validateAiChartMethods, validateReportDefinition,
  validateAiReportChartSeries, aiReportPrompt, validateAiReportBaselineKind, aiSuggestNamePrompt, cleanAiSuggestedName,
  validateReportVariables, applyReportVariables, validateAiEngine, evaluateAiEngine,
  aiReportRefinePrompt, aiReportDefinitionDiff, whatIfBacktest,
  anchorWhatIfLeg,
  droppedScenarioPrimeSteps, primeStepDroppedMessage,
} from './planning.js';

// Region-specific providers (assessment search/fetch) are reached
// through the region implementation, never directly.
const assessmentFor = (regionCode) => (getRegion(regionCode) || getRegion('CA')).assessment;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 9200);
const SESSION_DAYS = 30;

seedUsers();

const app = express();
const json48 = express.json({ limit: '48mb' }); // photo uploads arrive as base64 JSON (a gallery batch can carry several)
// The import route parses its own body at 200 MB (a photo-heavy
// export can exceed 48 MB), so the global parser skips it.
app.use((req, res, next) => {
  if (req.path === '/api/admin/data/import') return next();
  json48(req, res, next);
});

// (No server-side sync dirty-marking: sync now runs in the browser,
// which tracks its own dirty state. The server-side sync loop was
// retired 2026-11-08 — its settings stay in app_meta untouched, but
// nothing reads or writes them anymore.)

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

// History: run a user write + its commit in one transaction (the
// commit row and the write land together or not at all). fn runs
// inside the transaction and returns { value, entityId?, entityLabel?,
// extra? }; entityId defaults to meta.entityId (known for updates and
// deletes; creates return the new id). The before snapshot is taken
// before the transaction, so it always sees the pre-write state.
function commitTx(req, aggregate, meta, fn) {
  const before = snapshotByAggregate(db, aggregate, meta.entityId ?? null, meta.extra);
  return db.transaction(() => {
    const r = fn();
    const entityId = r.entityId != null ? r.entityId : meta.entityId;
    const snapshot = snapshotByAggregate(db, aggregate, entityId, r.extra || meta.extra);
    recordCommit(db, {
      userId: req.user.id, username: req.user.username,
      before, snapshot, ...meta,
      entityId, entityLabel: r.entityLabel != null ? r.entityLabel : meta.entityLabel,
    });
    return r.value;
  })();
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
  const before = snapshotByAggregate(db, 'account', account.id);
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
      const touched = new Set([...refToId.values(), ...v.events.filter((e) => e.holdingId != null).map((e) => e.holdingId)]);
      for (const hid of touched) rebuildEventPricePoints(db, hid, ts);
      // One bulk Apply = one commit, however many rows it wrote.
      recordCommit(db, {
        userId: req.user.id, username: req.user.username, module: 'stocks',
        entityType: 'account', entityId: account.id, entityLabel: account.name,
        summary: `Imported CSV · ${account.name} (${v.events.length} events)`,
        before, snapshot: snapshotByAggregate(db, 'account', account.id),
      });
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
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

app.delete('/api/admin/users/:id/avatar', requireApiAuth, requireAdmin, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  // Await the unlink: a fire-and-forget delete raced the next
  // fetch, which could still see the file and report it served.
  if (u.avatar_file) await fs.promises.unlink(path.join(AVATARS_DIR, u.avatar_file)).catch(() => {});
  db.prepare('UPDATE users SET avatar_file = NULL WHERE id = ?').run(u.id);
  res.json(userView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});

// ------------------------------------------------- data export / import ---
// One JSON file with all mainline data (planning excluded, secrets
// never included) for migrating to another server. Import replaces
// the data on this server after a confirmation, backs the current
// data up first (planning included, so a restore is complete), and
// signs everyone out — the admin signs back in with the imported
// admin credentials. Backups live in DATA_DIR/backups and restore
// through the same import path.
function exportDownloadName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `finance-mate-export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

app.get('/api/admin/data/export', requireApiAuth, requireAdmin, (req, res) => {
  const payload = buildExport(db, { includePlanning: false });
  res.setHeader('Content-Disposition', `attachment; filename="${exportDownloadName()}"`);
  res.type('application/json');
  res.send(JSON.stringify(payload));
});

// The import body carries the parsed export JSON; a photo-heavy
// export can exceed the 48 MB default, so this route alone allows
// 200 MB. confirm is required — the UI asks first, and the server
// refuses a bare call.
app.post('/api/admin/data/import', requireApiAuth, requireAdmin, express.json({ limit: '200mb' }), (req, res) => {
  const b = req.body || {};
  if (b.confirm !== true) return res.status(400).json({ error: 'confirm the import first' });
  let payload = b.data;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return res.status(400).json({ error: 'import file is not valid JSON' }); }
  }
  try { validateExport(payload); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const backup = writeBackup(db, { includePlanning: true });
    const summary = applyImport(db, payload);
    // An old export carries rental marks keyed by rental id; rewrite
    // them to entry ids (same migration as server startup).
    migrateRentalMarkSources(db);
    // A browser sync download carries its log entry in the request:
    // the import wipes sessions, so the browser could not post the
    // log afterwards. A manual import sends no `sync` field and logs
    // nothing.
    if (b.sync && b.sync.direction === 'download') {
      try {
        recordSyncLog(db, {
          direction: 'download', status: 'ok',
          bytes: Number.isInteger(b.sync.bytes) ? b.sync.bytes : null,
          exported_at: typeof b.sync.exported_at === 'string' ? b.sync.exported_at : payload.exported_at,
          detail: 'Downloaded from the sync folder.',
        });
      } catch { /* the import itself succeeded; never fail it on the log */ }
    }
    res.json({ ok: true, summary, backup: backup.name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/data/backups', requireApiAuth, requireAdmin, (req, res) => {
  res.json({ backups: listBackups() });
});

app.post('/api/admin/data/backups/:name/restore', requireApiAuth, requireAdmin, (req, res) => {
  if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'confirm the restore first' });
  let payload;
  try { payload = readBackup(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const backup = writeBackup(db, { includePlanning: true });
    const summary = applyImport(db, payload);
    // A backup from before the entry-keyed marks carries rental marks
    // keyed by rental id; rewrite them (same migration as startup).
    migrateRentalMarkSources(db);
    res.json({ ok: true, summary, backup: backup.name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ------------------------------------------------------- browser sync log --
// iCloud sync now runs in the browser (File System Access API): the
// page reads/writes the export file in a folder the user picked, so
// no Docker bind-mount is needed. The server only keeps the sync
// LOG — every browser sync event is posted here (newest first in
// Admin → Data) — plus the export/import endpoints the browser
// reuses. The old server-side sync loop (auto-write on change +
// 5-minute poll of a container folder) was retired 2026-11-08; its
// settings stay in app_meta untouched, and the old /sync endpoints
// are gone.
app.get('/api/admin/data/sync/log', requireApiAuth, requireAdmin, (req, res) => {
  const limit = req.query.limit === undefined ? 50 : parseInt(req.query.limit, 10);
  res.json({ log: listSyncLog(db, Number.isNaN(limit) ? 50 : limit) });
});

app.post('/api/admin/data/sync/log', requireApiAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  try {
    const row = recordSyncLog(db, {
      direction: b.direction, status: b.status,
      bytes: b.bytes === undefined ? null : b.bytes,
      exported_at: b.exported_at === undefined ? null : b.exported_at,
      detail: b.detail === undefined ? null : b.detail,
    });
    res.json({ ok: true, entry: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
const SEGMENT_AI_FIELDS = ['start_date', 'rate_type', 'rate_mode', 'annual_rate', 'spread', 'compounding', 'accrual', 'locked_on'];

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

// A term's opening payment triple, derived directly from its own
// opening balance, its first segment's rate and its amortization —
// the payment the term opened with. Used for a term the projection
// never reaches (it starts before the balance anchor, so no span is
// governed by it): without this its card shows "—" and the term's
// own history is invisible. A prime-spread segment prices at its
// locked_on rate when one is present, else at the rate in the
// term's start month; a fixed segment prices at its nominal rate.
// An override, when present, is the used figure. Null when the
// triple cannot be derived (no segment, no opening, no
// amortization, or no prime for a prime-spread segment) — the
// term keeps showing "—" then, exactly as before.
function termOpeningTriple(t, segments, primeHistory, primeRate) {
  const segs = (segments || [])
    .filter((s) => s.term_id === t.id)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id));
  const seg = segs[0] || null;
  const opening = Number(t.opening_balance);
  const amort = Number(t.amortization_years);
  if (!seg || !isFinite(opening) || !(opening > 0) || !isFinite(amort) || !(amort > 0)) return null;
  let rate = null;
  if (seg.rate_type === 'variable' && seg.rate_mode === 'prime_spread' && seg.locked_on) {
    const atDate = primeAtDateResolver(primeHistory, primeRate);
    if (!atDate) return null;
    const prime = atDate(String(seg.locked_on));
    if (prime === null || prime === undefined || !isFinite(Number(prime))) return null;
    rate = Math.max(0, Math.round((Number(prime) + Number(seg.spread || 0)) * 100) / 100);
  } else if (seg.rate_type === 'variable' && seg.rate_mode === 'prime_spread') {
    const forMonth = primeHistoryResolver(primeHistory, primeRate);
    if (!forMonth) return null;
    rate = segmentRateForMonth(seg, String(t.start_date).slice(0, 7), forMonth);
  } else {
    rate = segmentAnnualRate(seg, primeRate);
  }
  if (rate === null || rate === undefined || !isFinite(Number(rate))) return null;
  const derived = derivePayment(opening, Number(rate), amort, seg.compounding || undefined);
  if (!isFinite(derived) || !(derived > 0)) return null;
  const ov = Number(t.payment_override);
  const overridden = isFinite(ov) && ov > 0;
  return {
    paymentUsed: overridden ? Math.round(ov * 100) / 100 : derived,
    paymentDerived: derived,
    paymentOverridden: overridden,
  };
}

// The term payment map of a property's projection, for term views
// served outside a full property view. Terms the projection never
// reaches keep their opening triple (see termOpeningTriple) instead
// of nulls — a past term's payment is its own history, not a gap.
function fillTermPayMap(p, proj) {
  const map = proj ? { ...proj.termPayments } : {};
  const terms = termsOf(p.id);
  if (!terms.some((t) => !map[t.id])) return Object.keys(map).length ? map : null;
  const segments = segmentsOf(p.id);
  const primeHistory = getPrimeHistory();
  const prime = getCurrentPrime();
  for (const t of terms) {
    if (map[t.id]) continue;
    const triple = termOpeningTriple(t, segments, primeHistory, prime ? prime.rate : null);
    if (triple) map[t.id] = triple;
  }
  return Object.keys(map).length ? map : null;
}

function termPayMapFor(p) {
  return fillTermPayMap(p, projectionFor(p));
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
  // One payment map for every term card: the projection's triples
  // plus the opening triple for any term it never reaches.
  const payMap = fillTermPayMap(p, proj);
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
    terms: terms.map((t) => termView(t, segments, lumpSums, payMap)),
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
  const created = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: null,
    entityLabel: String(b.address).trim(),
    summary: `Added property ${String(b.address).trim()}`,
  }, () => {
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
    const createdRow = getProperty(info.lastInsertRowid);
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
      createdRow.id,
      createdRow.lender ?? null,
      createdRow.mortgage_balance_date || new Date().toISOString().slice(0, 10),
      60,
      amortYears,
      balance,
      nowIso(),
      nowIso()
    );
    return { value: createdRow, entityId: createdRow.id };
  });
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
  const updated = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: next.address, summary: `Updated property ${next.address}`,
  }, () => {
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
    return { value: propertyView(getProperty(p.id)), entityId: p.id };
  });
  res.json(updated);
});

app.delete('/api/properties/:id', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  // The gallery rows cascade away with the property; their files go too.
  const files = db.prepare('SELECT file_name FROM property_photos WHERE property_id = ?').all(p.id);
  commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Deleted property ${p.address}`,
  }, () => {
    db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
    return { value: { ok: true }, entityId: p.id };
  });
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
  const view = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated assessment history · ${p.address}`,
  }, () => {
    db.prepare(
      `INSERT INTO value_history (property_id, year, value, source, notes, land_value, building_value, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)
       ON CONFLICT(property_id, year) DO UPDATE SET
         value = excluded.value, source = 'manual', notes = excluded.notes,
         land_value = excluded.land_value, building_value = excluded.building_value,
         updated_at = excluded.updated_at`
    ).run(p.id, v.year, value, (req.body || {}).notes || null,
      sp.present ? sp.land : null, sp.present ? sp.building : null, nowIso(), nowIso());
    return { value: historyView(p.id), entityId: p.id };
  });
  res.status(201).json(view);
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
  let view;
  try {
    view = commitTx(req, 'property', {
      module: 'property', entityType: 'property', entityId: p.id,
      entityLabel: p.address, summary: `Updated assessment history · ${p.address}`,
    }, () => {
      db.prepare('UPDATE value_history SET year=?, value=?, source=?, notes=?, land_value=?, building_value=?, updated_at=? WHERE id=?')
        .run(v.year, value, source, b.notes !== undefined ? b.notes || null : pt.notes, land, building, nowIso(), pt.id);
      return { value: historyView(p.id), entityId: p.id };
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: `a point for ${v.year} already exists` });
    throw e;
  }
  res.json(view);
});

app.delete('/api/properties/:id/value-history/:pointId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const pt = db.prepare('SELECT id FROM value_history WHERE id = ? AND property_id = ?').get(req.params.pointId, req.params.id);
  if (!pt) return res.status(404).json({ error: 'history point not found' });
  const view = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated assessment history · ${p.address}`,
  }, () => {
    db.prepare('DELETE FROM value_history WHERE id = ? AND property_id = ?').run(req.params.pointId, req.params.id);
    return { value: historyView(req.params.id), entityId: p.id };
  });
  res.json(view);
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
  const view = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated costs · ${p.address}`,
  }, () => {
    upsertCost(db, p.id, v, (req.body || {}).source === 'ai' ? 'ai' : 'manual', nowIso());
    return { value: costsView(db, p.id), entityId: p.id };
  });
  res.status(201).json(view);
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
  let view;
  try {
    view = commitTx(req, 'property', {
      module: 'property', entityType: 'property', entityId: p.id,
      entityLabel: p.address, summary: `Updated costs · ${p.address}`,
    }, () => {
      db.prepare('UPDATE property_costs SET year=?, category=?, amount=?, basis=?, monthly_amounts=?, notes=?, source=?, updated_at=? WHERE id=?')
        .run(v.year, v.category, v.amount, v.basis,
          v.monthlyAmounts ? JSON.stringify(v.monthlyAmounts) : null,
          v.notes, changed ? 'manual' : row.source, nowIso(), row.id);
      return { value: costsView(db, p.id), entityId: p.id };
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: `a ${v.category} entry for ${v.year} already exists` });
    }
    throw e;
  }
  res.json(view);
});

app.delete('/api/properties/:id/costs/:costId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const row = db.prepare('SELECT id FROM property_costs WHERE id = ? AND property_id = ?').get(req.params.costId, req.params.id);
  if (!row) return res.status(404).json({ error: 'cost entry not found' });
  const view = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated costs · ${p.address}`,
  }, () => {
    db.prepare('DELETE FROM property_costs WHERE id = ? AND property_id = ?').run(req.params.costId, req.params.id);
    return { value: costsView(db, req.params.id), entityId: p.id };
  });
  res.json(view);
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
  const seg = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated rate plan · ${p.address}`,
  }, () => {
    const info = db
      .prepare('INSERT INTO rate_segments (property_id, term_id, start_date, rate_type, annual_rate, rate_mode, spread, compounding, accrual, locked_on, ai_fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, owner.value, s.start_date, s.rate_type, s.annual_rate, s.rate_mode, s.spread, s.compounding, s.accrual, s.locked_on, aiFieldsJson(cleanAiFields(req.body || {}, SEGMENT_AI_FIELDS)), nowIso());
    return { value: segmentView(db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(info.lastInsertRowid)), entityId: p.id };
  });
  res.status(201).json(seg);
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
  const updated = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated rate plan · ${p.address}`,
  }, () => {
    db.prepare('UPDATE rate_segments SET term_id=?, start_date=?, rate_type=?, annual_rate=?, rate_mode=?, spread=?, compounding=?, accrual=?, locked_on=?, ai_fields=? WHERE id=?')
      .run(owner.value, s.start_date, s.rate_type, s.annual_rate, s.rate_mode, s.spread, s.compounding, s.accrual, s.locked_on, segAi === null ? (seg.ai_fields ?? null) : aiFieldsJson(segAi), seg.id);
    return { value: segmentView(db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(seg.id)), entityId: p.id };
  });
  res.json(updated);
});

app.delete('/api/properties/:id/rates/:segId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const seg = db.prepare('SELECT id FROM rate_segments WHERE id = ? AND property_id = ?').get(req.params.segId, req.params.id);
  if (!seg) return res.status(404).json({ error: 'segment not found' });
  commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated rate plan · ${p.address}`,
  }, () => {
    db.prepare('DELETE FROM rate_segments WHERE id = ? AND property_id = ?').run(req.params.segId, req.params.id);
    return { value: { ok: true }, entityId: p.id };
  });
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
  const out = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Added mortgage term · ${p.address}`,
  }, () => {
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
    return { value: termView(row, segmentsOf(p.id).map(segmentView), lumpSumsOf(p.id), termPayMapFor(getProperty(p.id))), entityId: p.id };
  });
  res.status(201).json(out);
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
  const out = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated mortgage term · ${p.address}`,
  }, () => {
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
    return { value: termView(row, segmentsOf(p.id).map(segmentView), lumpSumsOf(p.id), termPayMapFor(getProperty(p.id))), entityId: p.id };
  });
  res.json(out);
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
  const view = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Updated mortgage term · ${p.address}`,
  }, () => {
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
    syncTermMirror(getProperty(p.id));
    syncTermAnchor(getProperty(p.id));
    syncScheduleMirror(getProperty(p.id));
    return { value: propertyView(getProperty(p.id)), entityId: p.id };
  });
  res.json(view);
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
  const lump = commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Added lump sum · ${p.address}`,
  }, () => {
    const info = db
      .prepare('INSERT INTO lump_sums (property_id, term_id, date, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, termId, String(b.date), amount, b.note ? String(b.note) : null, nowIso());
    return { value: db.prepare('SELECT * FROM lump_sums WHERE id = ?').get(info.lastInsertRowid), entityId: p.id };
  });
  res.status(201).json(lump);
});

app.delete('/api/properties/:id/lump-sums/:lsId', requireApiAuth, (req, res) => {
  const p = getProperty(req.params.id);
  if (!p) return res.status(404).json({ error: 'property not found' });
  const row = db.prepare('SELECT id FROM lump_sums WHERE id = ? AND property_id = ?').get(req.params.lsId, req.params.id);
  if (!row) return res.status(404).json({ error: 'lump sum not found' });
  commitTx(req, 'property', {
    module: 'property', entityType: 'property', entityId: p.id,
    entityLabel: p.address, summary: `Deleted lump sum · ${p.address}`,
  }, () => {
    db.prepare('DELETE FROM lump_sums WHERE id = ? AND property_id = ?').run(req.params.lsId, req.params.id);
    return { value: { ok: true }, entityId: p.id };
  });
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
// re-derived at a term start, re-derived over the governing term's
// remaining amortization at a fixed switch (never a fresh full
// amortization), kept unchanged at a variable switch and by lump
// sums (they shorten the loan instead) and by prime moves (a variable
// plan's payment is set when the plan starts; prime only reprices
// each month's interest split, against the tracked prime history).
// The derived payment only ever comes out of this calculation; a
// Display-only pre-anchor history for the mortgage chart + monthly
// table: a second buildSchedule run anchored at the earliest term's
// opening balance (the contract's balance when the loan started),
// whose rows strictly before the anchor month are prepended to the
// main projection's series. The main projection (projectionFor /
// the amortization run below) is untouched — every figure still
// comes from it, and the user's anchor never moves.
//
// Rules: no terms, or the earliest opening at/after the anchor
// month, or a replay that cannot project (no_payment / no_prime)
// all mean no replay — the chart is exactly as before. A term with
// a missing or non-positive opening carries no replay start (a
// missing opening must never zero a balance); the replay starts at
// the earliest term WITH a positive opening. Lump sums dated before
// the anchor are dated events inside the replay, so they lower the
// replayed balance from their month on — with one display-only
// caveat: when the replay itself starts mid-history (the earliest
// term has no opening), a later term's opening resets the replayed
// balance at its start, erasing a lump recorded after that renewal
// was created; pre-anchor months after that renewal would then read
// high. Post-anchor figures are unaffected — they come from the
// main run, never the replay. The anchor month itself has no series
// row when no payment falls in it (the anchor month is a state
// point, not a payment month), so the combined series jumps from
// the last replay month to the main run's first payment month and
// the chart's anchor point bridges the gap.
function preAnchorReplaySeries({ balanceDate, terms, segments, lumpSums, frequency, paymentDay, primeRate, primeHistory, region }) {
  const anchorMonth = monthIdxOf(balanceDate);
  const withOpening = [...terms]
    .filter((t) => isFinite(Number(t.opening_balance)) && Number(t.opening_balance) > 0)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id));
  const first = withOpening[0];
  if (!first) return [];
  if (monthIdxOf(first.start_date) >= anchorMonth) return [];
  const replay = buildSchedule({
    balance: Number(first.opening_balance), balanceDate: first.start_date,
    terms, segments, lumpSums, paymentDay, frequency,
    primeRate, primeHistory, region,
  });
  if (replay.state !== 'projected' || !replay.series.length) return [];
  const anchorYM = ymOfIdx(anchorMonth);
  return replay.series.filter((row) => row.month < anchorYM);
}
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
  // The chart + monthly table show the full history from the
  // earliest term's start: the display-only replay's pre-anchor
  // months prepended to the main run's series. Every figure in
  // this response (remaining balance, payments, payoff, total
  // interest) still comes from the main run above.
  const displaySeries = [...preAnchorReplaySeries({
    balanceDate, terms: termsOf(p.id), segments, lumpSums: lumpSumsOf(p.id),
    paymentDay, frequency, primeRate, primeHistory: getPrimeHistory(), region: p.region || 'CA',
  }), ...r.series];
  res.json({
    ok: true,
    balance: p.mortgage_balance,
    balanceDate,
    // The balance the projection starts from at the anchor date —
    // the chart's anchor point plots this, not the raw recorded
    // anchor (which can be a stale earlier term's opening).
    anchorBalance: r.anchorBalance ?? p.mortgage_balance,
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
    series: displaySeries,
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
  const asset = commitTx(req, 'other-asset', {
    module: 'property', entityType: 'other-asset', entityId: null,
    entityLabel: String(b.name).trim(), summary: `Added asset ${String(b.name).trim()}`,
  }, () => {
    const info = db
      .prepare('INSERT INTO other_assets (category, name, value, currency, notes, owners, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.category, String(b.name).trim(), num(b.value) ?? 0, b.currency || 'CAD', b.notes || null, JSON.stringify(own.value ?? []), nowIso(), nowIso());
    return { value: assetView(db.prepare('SELECT * FROM other_assets WHERE id = ?').get(info.lastInsertRowid)), entityId: info.lastInsertRowid };
  });
  res.status(201).json(asset);
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
  const updated = commitTx(req, 'other-asset', {
    module: 'property', entityType: 'other-asset', entityId: a.id,
    entityLabel: next.name, summary: `Updated asset ${next.name}`,
  }, () => {
    db.prepare('UPDATE other_assets SET category=?, name=?, value=?, currency=?, notes=?, owners=?, updated_at=? WHERE id=?')
      .run(next.category, next.name, next.value, next.currency, next.notes, JSON.stringify(next.owners), nowIso(), a.id);
    return { value: assetView(db.prepare('SELECT * FROM other_assets WHERE id = ?').get(a.id)), entityId: a.id };
  });
  res.json(updated);
});

app.delete('/api/assets/:id', requireApiAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM other_assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'asset not found' });
  commitTx(req, 'other-asset', {
    module: 'property', entityType: 'other-asset', entityId: a.id,
    entityLabel: a.name, summary: `Deleted asset ${a.name}`,
  }, () => {
    db.prepare('DELETE FROM other_assets WHERE id = ?').run(req.params.id);
    return { value: { ok: true }, entityId: a.id };
  });
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

// Current price for the buy-op autocomplete, via the existing
// price tiers. Best-effort by the same contract: no data yields
// price null, never an error and never a guessed price — the
// form still works fully manual.
app.get('/api/invest/price', requireApiAuth, async (req, res) => {
  const sym = String(req.query.symbol || '').trim();
  if (!sym) return res.json({ price: null });
  const p = await latestPrice(sym);
  res.json(p ? { price: p.price, date: p.date, source: p.source } : { price: null });
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

// Fill-with-AI Apply, batched: the client used to apply a checked
// draft row by row (one POST per holding/event/NAV), which would
// record one History commit per row. One Apply is one commit, so
// the whole checked draft lands in a single transaction — and a
// bad row rejects the batch untouched, where the row-by-row flow
// left earlier rows applied. Holdings validate up front; events
// validate in order against their holding's events-so-far (the
// same rule the single-event endpoint applies); NAV snapshots
// write with overwrite, exactly as the single-NAV endpoint did
// for checked rows.
app.post('/api/investments/accounts/:id/fill/apply', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const b = req.body || {};
  const holdings = Array.isArray(b.holdings) ? b.holdings : [];
  const events = Array.isArray(b.events) ? b.events : [];
  const nav = Array.isArray(b.nav) ? b.nav : [];
  const validated = [];
  for (const h of holdings) {
    const v = validHoldingInput(h);
    if (v.error) return res.status(400).json({ error: v.error });
    const ev = validInitialEvents(h.events);
    if (ev.error) return res.status(400).json({ error: ev.error });
    validated.push({ h, v, ev });
  }
  const before = snapshotByAggregate(db, 'account', account.id);
  try {
    db.transaction(() => {
      const ts = nowIso();
      const refToId = new Map();
      const touched = new Set();
      const insHolding = db.prepare(
        'INSERT INTO invest_holdings (account_id, label, kind, symbol, fund_code, currency, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insEvent = db.prepare(
        'INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const { h, v, ev } of validated) {
        const info = insHolding.run(account.id, v.label, v.kind, v.symbol, v.fundCode, v.currency, 'ai', ts, ts);
        if (h.ref != null) refToId.set(h.ref, info.lastInsertRowid);
        for (const e of ev.events) {
          insEvent.run(info.lastInsertRowid, e.date, e.type, e.units, e.price, e.amount, e.splitNew, e.splitOld, e.note, 'ai', ts, ts);
        }
        if (ev.events.length) touched.add(info.lastInsertRowid);
      }
      for (const e of events) {
        const holdingId = e.holdingId != null ? e.holdingId : refToId.get(e.holdingRef);
        const holding = holdingId != null ? getHolding(db, holdingId) : null;
        if (!holding || holding.account_id !== account.id) throw new Error('an event names a holding that is not in this account');
        const v = validEventInput(e, { events: listEvents(db, holdingId) });
        if (v.error) throw new Error(v.error);
        insEvent.run(holdingId, v.date, v.type, v.units, v.price, v.amount, v.splitNew, v.splitOld, v.note, 'ai', ts, ts);
        touched.add(holdingId);
      }
      for (const n of nav) {
        const holdingId = n.holdingId != null ? n.holdingId : refToId.get(n.holdingRef);
        const holding = holdingId != null ? getHolding(db, holdingId) : null;
        if (!holding || holding.account_id !== account.id) throw new Error('a NAV snapshot names a holding that is not in this account');
        const v = validNavInput(n);
        if (v.error) throw new Error(v.error);
        const r = addNavPoint(db, holdingId, v, { overwrite: true });
        if (r.error) throw new Error(r.error);
      }
      for (const hid of touched) rebuildEventPricePoints(db, hid, ts);
      recordCommit(db, {
        userId: req.user.id, username: req.user.username, module: 'stocks',
        entityType: 'account', entityId: account.id, entityLabel: account.name,
        summary: `Applied Fill with AI · ${account.name} (${holdings.length + events.length + nav.length} items)`,
        before, snapshot: snapshotByAggregate(db, 'account', account.id),
      });
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json({ appliedHoldings: holdings.length, appliedEvents: events.length, appliedNav: nav.length });
});

app.post('/api/investments/accounts', requireApiAuth, (req, res) => {
  const v = validAccountInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const own = cleanOwners((req.body || {}).owners);
  if (own.error) return res.status(400).json({ error: own.error });
  const account = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: null,
    entityLabel: v.name, summary: `Added account ${v.name}`,
  }, () => {
    const ts = nowIso();
    const info = db.prepare(
      'INSERT INTO invest_accounts (name, type, institution, note, owners, default_currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(v.name, v.type, v.institution, v.note, JSON.stringify(own.value || []), v.defaultCurrency, ts, ts);
    return { value: getAccount(db, info.lastInsertRowid), entityId: info.lastInsertRowid };
  });
  res.status(201).json(account);
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
  const out = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: account.id,
    entityLabel: account.name, summary: `Added contribution plan · ${account.name}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    const ts = nowIso();
    const info = db.prepare(
      'INSERT INTO invest_plans (account_id, job_id, target_holding_id, start_date, own_amount, employer_amount, own_pct, employer_pct, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(account.id, v.jobId, v.holdingId, v.startDate, v.ownAmount, v.employerAmount, v.ownPct, v.employerPct, ts, ts);
    const plan = getPlan(db, info.lastInsertRowid);
    const gen = generatePlan(db, plan, { today: vancouverToday(), ts });
    return { value: { ...planView(db, plan, vancouverToday()), generation: gen }, entityId: account.id };
  });
  res.status(201).json(out);
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
  const out = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: account.id,
    entityLabel: account.name, summary: `Updated contribution plan · ${account.name}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare('UPDATE invest_plans SET job_id = ?, target_holding_id = ?, start_date = ?, own_amount = ?, employer_amount = ?, own_pct = ?, employer_pct = ?, updated_at = ? WHERE id = ?')
      .run(v.jobId, v.holdingId, v.startDate, v.ownAmount, v.employerAmount, v.ownPct, v.employerPct, nowIso(), plan.id);
    const updated = getPlan(db, plan.id);
    const gen = generatePlan(db, updated, { today: vancouverToday(), ts: nowIso() });
    return { value: { ...planView(db, updated, vancouverToday()), generation: gen }, entityId: account.id };
  });
  res.json(out);
});

app.delete('/api/investments/plans/:id', requireApiAuth, (req, res) => {
  const plan = getPlan(db, Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const account = getAccount(db, plan.account_id);
  commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: account.id,
    entityLabel: account ? account.name : null, summary: `Deleted contribution plan · ${account ? account.name : ''}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    // Generated buys stay as ordinary history (their plan link
    // clears); only the plan and its tombstones go.
    db.prepare('UPDATE invest_events SET plan_id = NULL WHERE plan_id = ?').run(plan.id);
    db.prepare('DELETE FROM invest_plans WHERE id = ?').run(plan.id);
    return { value: { ok: true }, entityId: account.id };
  });
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
  const updated = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: account.id,
    entityLabel: v.name, summary: `Updated account ${v.name}`,
  }, () => {
    db.prepare('UPDATE invest_accounts SET name = ?, type = ?, institution = ?, note = ?, owners = ?, default_currency = ?, updated_at = ? WHERE id = ?')
      .run(v.name, v.type, v.institution, v.note, JSON.stringify(owners), v.defaultCurrency, nowIso(), account.id);
    return { value: getAccount(db, account.id), entityId: account.id };
  });
  res.json(updated);
});

app.delete('/api/investments/accounts/:id', requireApiAuth, (req, res) => {
  const account = getAccount(db, Number(req.params.id));
  if (!account) return res.status(404).json({ error: 'account not found' });
  const doomed = listHoldings(db, Number(req.params.id)).map((h) => h.id);
  commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: account.id,
    entityLabel: account.name, summary: `Deleted account ${account.name}`,
  }, () => {
    db.prepare('DELETE FROM invest_accounts WHERE id = ?').run(Number(req.params.id));
    // Holdings cascade away, but their price-fetch stamps are
    // plain app_meta rows — clear them so a later holding that
    // reuses an id does not inherit a backoff or stale failure.
    for (const id of doomed) clearHoldingPriceMeta(db, id);
    return { value: { ok: true }, entityId: account.id };
  });
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
  const holding = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: account.id,
    entityLabel: account.name, summary: `Added holding ${v.label || v.symbol || ''} · ${account.name}`,
  }, () => {
    let holdingId = null;
    const info = db.prepare(
      'INSERT INTO invest_holdings (account_id, label, kind, symbol, fund_code, currency, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(account.id, v.label, v.kind, v.symbol, v.fundCode, v.currency, source, ts, ts);
    holdingId = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of ev.events) {
      ins.run(holdingId, e.date, e.type, e.units, e.price, e.amount, e.splitNew, e.splitOld, e.note, source, ts, ts);
    }
    if (ev.events.length) rebuildEventPricePoints(db, holdingId, ts);
    return { value: getHolding(db, holdingId), entityId: account.id };
  });
  res.status(201).json(holding);
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
  const account = getAccount(db, holding.account_id);
  const updated = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: holding.account_id,
    entityLabel: account ? account.name : null, summary: `Updated holding ${v.label || v.symbol || ''} · ${account ? account.name : ''}`,
  }, () => {
    db.prepare('UPDATE invest_holdings SET label = ?, kind = ?, symbol = ?, fund_code = ?, currency = ?, updated_at = ? WHERE id = ?')
      .run(v.label, v.kind, v.symbol, v.fundCode, v.currency, nowIso(), holding.id);
    // A new symbol invalidates the closes fetched for the old
    // one; the next read refetches under the new symbol.
    if (v.symbol !== holding.symbol || v.kind !== holding.kind) {
      db.prepare("DELETE FROM invest_prices WHERE holding_id = ? AND source IN ('stooq', 'yahoo', 'nasdaq')").run(holding.id);
      db.prepare("DELETE FROM app_meta WHERE key = ?").run(`invest_px_${holding.id}_ok`);
    }
    return { value: getHolding(db, holding.id), entityId: holding.account_id };
  });
  res.json(updated);
});

app.delete('/api/investments/holdings/:id', requireApiAuth, (req, res) => {
  const holding = getHolding(db, Number(req.params.id));
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const account = getAccount(db, holding.account_id);
  commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: holding.account_id,
    entityLabel: account ? account.name : null, summary: `Deleted holding ${holding.label || holding.symbol || ''} · ${account ? account.name : ''}`,
  }, () => {
    db.prepare('DELETE FROM invest_holdings WHERE id = ?').run(Number(req.params.id));
    clearHoldingPriceMeta(db, Number(req.params.id));
    return { value: { ok: true }, entityId: holding.account_id };
  });
  res.json({ ok: true });
});

app.post('/api/investments/holdings/:id/events', requireApiAuth, (req, res) => {
  const holding = getHolding(db, Number(req.params.id));
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const v = validEventInput(req.body || {}, { events: listEvents(db, holding.id) });
  if (v.error) return res.status(400).json({ error: v.error });
  const account = getAccount(db, holding.account_id);
  const ev = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: holding.account_id,
    entityLabel: account ? account.name : null, summary: `Added event · ${holding.symbol || holding.label || ''} · ${account ? account.name : ''}`,
  }, () => {
    const ts = nowIso();
    const info = db.prepare(
      'INSERT INTO invest_events (holding_id, date, type, units, price, amount, split_new, split_old, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(holding.id, v.date, v.type, v.units, v.price, v.amount, v.splitNew, v.splitOld, v.note,
        req.body && req.body.source === 'ai' ? 'ai' : 'manual', ts, ts);
    rebuildEventPricePoints(db, holding.id, ts);
    return { value: db.prepare('SELECT * FROM invest_events WHERE id = ?').get(info.lastInsertRowid), entityId: holding.account_id };
  });
  res.status(201).json(ev);
});

app.put('/api/investments/events/:id', requireApiAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM invest_events WHERE id = ?').get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'event not found' });
  const v = validEventInput(req.body || {}, {
    base: ev, events: listEvents(db, ev.holding_id), exceptId: ev.id,
  });
  if (v.error) return res.status(400).json({ error: v.error });
  const holding = getHolding(db, ev.holding_id);
  const account = holding ? getAccount(db, holding.account_id) : null;
  const updated = commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: holding ? holding.account_id : null,
    entityLabel: account ? account.name : null, summary: `Updated event · ${holding ? (holding.symbol || holding.label || '') : ''} · ${account ? account.name : ''}`,
  }, () => {
    const ts = nowIso();
    db.prepare('UPDATE invest_events SET date = ?, type = ?, units = ?, price = ?, amount = ?, split_new = ?, split_old = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(v.date, v.type, v.units, v.price, v.amount, v.splitNew, v.splitOld, v.note, ts, ev.id);
    rebuildEventPricePoints(db, ev.holding_id, ts);
    return { value: db.prepare('SELECT * FROM invest_events WHERE id = ?').get(ev.id), entityId: holding ? holding.account_id : null };
  });
  res.json(updated);
});

app.delete('/api/investments/events/:id', requireApiAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM invest_events WHERE id = ?').get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'event not found' });
  const holding = getHolding(db, ev.holding_id);
  const account = holding ? getAccount(db, holding.account_id) : null;
  commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: holding ? holding.account_id : null,
    entityLabel: account ? account.name : null, summary: `Deleted event · ${holding ? (holding.symbol || holding.label || '') : ''} · ${account ? account.name : ''}`,
  }, () => {
    // A deleted plan-generated event tombstones its due period
    // so later generation runs never recreate it (see src/plans.js).
    recordPlanEventDeletion(db, ev);
    db.prepare('DELETE FROM invest_events WHERE id = ?').run(ev.id);
    rebuildEventPricePoints(db, ev.holding_id, nowIso());
    return { value: { ok: true }, entityId: holding ? holding.account_id : null };
  });
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
  const account = getAccount(db, holding.account_id);
  let out;
  try {
    out = commitTx(req, 'account', {
      module: 'stocks', entityType: 'account', entityId: holding.account_id,
      entityLabel: account ? account.name : null, summary: `Added NAV snapshot · ${holding.symbol || holding.label || ''} · ${account ? account.name : ''}`,
    }, () => {
      const r = addNavPoint(db, holding.id, v, { overwrite: req.body && req.body.overwrite === true });
      if (r.error) throw Object.assign(new Error(r.error), { status: 400 });
      return { value: r, entityId: holding.account_id };
    });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
  res.status(201).json(out);
});

// Inline row edit for a manual snapshot: date and price both
// changeable, full precision in and out (the row's displayed
// 2dp figure is never the edit value).
app.put('/api/investments/prices/:id', requireApiAuth, (req, res) => {
  const v = validNavInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const row0 = db.prepare('SELECT * FROM invest_prices WHERE id = ?').get(Number(req.params.id));
  if (!row0) return res.status(404).json({ error: 'price point not found' });
  const holding = getHolding(db, row0.holding_id);
  const account = holding ? getAccount(db, holding.account_id) : null;
  let out;
  try {
    out = commitTx(req, 'account', {
      module: 'stocks', entityType: 'account', entityId: holding ? holding.account_id : null,
      entityLabel: account ? account.name : null, summary: `Updated NAV snapshot · ${holding ? (holding.symbol || holding.label || '') : ''} · ${account ? account.name : ''}`,
    }, () => {
      const r = updateNavPoint(db, Number(req.params.id), v);
      if (r.error) throw Object.assign(new Error(r.error), { status: r.notFound ? 404 : 400 });
      return { value: r, entityId: holding ? holding.account_id : null };
    });
  } catch (e) {
    if (e.status === 400 || e.status === 404) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(out);
});

app.delete('/api/investments/prices/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM invest_prices WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'price point not found' });
  if (row.source !== 'manual') {
    return res.status(400).json({ error: 'only manual price snapshots can be deleted' });
  }
  const holding = getHolding(db, row.holding_id);
  const account = holding ? getAccount(db, holding.account_id) : null;
  commitTx(req, 'account', {
    module: 'stocks', entityType: 'account', entityId: holding ? holding.account_id : null,
    entityLabel: account ? account.name : null, summary: `Deleted NAV snapshot · ${holding ? (holding.symbol || holding.label || '') : ''} · ${account ? account.name : ''}`,
  }, () => {
    db.prepare('DELETE FROM invest_prices WHERE id = ?').run(row.id);
    return { value: { ok: true }, entityId: holding ? holding.account_id : null };
  });
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
  const payChanges = db.prepare('SELECT effective_date, value, amount, basis, scope FROM earn_pay_changes WHERE job_id = ? ORDER BY effective_date, id').all(row.id)
    .map((r) => ({
      effective_date: r.effective_date, value: r.value,
      amount: r.amount ?? r.value, basis: r.basis || 'gross', scope: r.scope || 'period',
    }));
  const bonuses = db.prepare('SELECT date, amount FROM earn_bonuses WHERE job_id = ? ORDER BY date').all(row.id);
  const bonusTotal = bonuses.filter((b) => Number(String(b.date).slice(0, 4)) === row.tax_year)
    .reduce((s, b) => s + b.amount, 0);
  // Pre-tax RRSP: linked plans' OWN per-period amount reduces taxable
  // income in the calc (federal and provincial); the employer match
  // never enters. Percent plans derive from the job's CURRENT
  // per-period gross, so a pay change flows into the deduction (and
  // the cash take-home) with no stored figure to refresh. The calc
  // runs on read, so a plan create/edit/delete flows into every
  // surface — list cards, detail summary, breakdown table, charts —
  // with no history row touched. The gross is deduction-independent,
  // so a zero-deduction calc gives the exact gross the percent
  // derivation prices from.
  // Per-payday rule (user 2026-11-04): a plan's own amount counts
  // for a payday iff plan start ≤ THAT payday (inclusive). The
  // per-period calc prices the NEXT payday, so the deduction is
  // evaluated at the next pay date — not today. A plan starting
  // 11/6 contributes $0 on 11/4 but is fully active in the 11/6
  // next-pay figure (and in the annual run-rate, which annualizes
  // that per-period value). The next payday is always ≥ today, so
  // this set only grows vs the old today rule; a dateless job (no
  // next payday) keeps the today rule.
  const today = vancouverToday();
  const nextDate = nextPayDate(
    { frequency: row.frequency, startDate: row.start_date, recentDate: row.recent_pay_date }, today);
  const linkedPlans = db.prepare('SELECT * FROM invest_plans WHERE job_id = ?').all(row.id);
  const calc0 = calcSalary({ ...row, bonus_total: bonusTotal, rrspDeduction: 0 }, earnRegion().payroll);
  const gross0 = calc0.perPeriod.gross;
  const rrspDeduction = linkedPlans
    .reduce((s, p) => s + ((nextDate == null ? p.start_date <= today : p.start_date <= nextDate) ? planPeriodAmounts(p, gross0).own : 0), 0);
  const calc = calcSalary({ ...row, bonus_total: bonusTotal, rrspDeduction }, earnRegion().payroll);
  // RRSP tax benefit (engine, never hand-rolled brackets): total tax
  // without the deduction minus total tax with it (federal +
  // provincial). The annual figure is primary; per-period is the
  // annual figure over the pay frequency. The by-year table accrues
  // the same saving month by month from the monthly series (current
  // pay rate and plans; yearly rows cover months elapsed, so the
  // current year is partial). No active deduction, or a deduction
  // that saves $0 tax, yields no benefit — no section, no marker.
  let taxBenefit = null;
  if (rrspDeduction > 0) {
    const benefitAnnual = Math.round((calc0.totalTax - calc.totalTax) * 100) / 100;
    if (benefitAnnual > 0) {
      const periods = PAY_FREQUENCIES[row.frequency].periods;
      const plans = linkedPlans.map((p) => ({
        start_date: p.start_date,
        own_amount: planPeriodAmounts(p, gross0).own,
        employer_amount: planPeriodAmounts(p, gross0).employer,
      }));
      const series = (row.start_date && row.recent_pay_date) ? jobMonthlySeries({
        frequency: row.frequency, startDate: row.start_date, recentDate: row.recent_pay_date,
        calc, plans, today, job: { ...row, bonus_total: bonusTotal }, payroll: earnRegion().payroll,
      }) : null;
      // Per-pay table: the current tax year's paydays with a saving,
      // from the same per-payday values the monthly series is built
      // from. The total is the by-year figure for that year (the rows
      // sum to it exactly); no current-year rows → no table.
      const paysYear = Number(today.slice(0, 4));
      const paysRows = series && series.taxBenefitPays
        ? series.taxBenefitPays.filter((p) => Number(p.date.slice(0, 4)) === paysYear) : [];
      const paysByYear = series ? (series.taxBenefitByYear || []).find((y) => y.year === paysYear) : null;
      // Per-pay table, grouped by year for the year pager: every year
      // with a saving, each with its rows and its by-year total (the
      // rows sum to it exactly). Only nonzero-benefit years get a page.
      const paysByYearAll = (() => {
        if (!series || !series.taxBenefitPays) return [];
        const rowsByYear = new Map();
        for (const p of series.taxBenefitPays) {
          const y = Number(p.date.slice(0, 4));
          if (!rowsByYear.has(y)) rowsByYear.set(y, []);
          rowsByYear.get(y).push(p);
        }
        return [...rowsByYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, rows]) => {
          const byYear = (series.taxBenefitByYear || []).find((yy) => yy.year === year);
          return {
            year,
            rows,
            total: byYear ? byYear.annual : Math.round(rows.reduce((a, r) => a + r.benefit, 0) * 100) / 100,
          };
        });
      })();
      taxBenefit = {
        perPeriod: Math.round((benefitAnnual / periods) * 100) / 100,
        annual: benefitAnnual,
        byYear: series ? (series.taxBenefitByYear || []) : [],
        pays: paysRows.length ? {
          year: paysYear,
          rows: paysRows,
          total: paysByYear ? paysByYear.annual : Math.round(paysRows.reduce((a, r) => a + r.benefit, 0) * 100) / 100,
        } : null,
        paysByYear: paysByYearAll,
      };
    }
  }
  return {
    ...row,
    owner: row.owner || null,
    cpp_exempt: row.cpp_exempt === 1, ei_exempt: row.ei_exempt === 1,
    pay_changes: payChanges, bonuses, bonus_total: bonusTotal,
    next_pay_date: nextDate,
    calc,
    taxBenefit,
  };
};
// The owner share is always 100%: the app tracks the household,
// so a rental linked to an existing property is 100% even when
// the property is jointly owned. The 50/50 split between co-owners
// (e.g. Shawn/Jiaying on the 2985 Basement net) is a TAX-module
// concern, not the app's share — the Tax module does not exist yet.
// The stored ownership_pct column is dormant: it is never read on
// the read path and never written; it is kept only so old rows keep
// their history.
const derivedOwnershipPct = () => 100;
// Property-derived deductible inputs for a rental: the linked
// property's costs by year (annual totals by category, monthly
// entries averaged x 12) plus that year's mortgage interest from the
// engine's schedule. Only when the rental is linked to a property
// AND a rental portion is set; otherwise null and expenses stay as
// manually entered. Returns a Map taxYear -> { costs, interest }.
const rentalDerivedInputs = (rental) => {
  if (!rental || rental.property_id == null || rental.rental_portion_pct == null) return null;
  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(rental.property_id);
  if (!prop) return null;
  const costsByYear = new Map();
  for (const c of db.prepare('SELECT * FROM property_costs WHERE property_id = ?').all(prop.id)) {
    const annual = costAnnual(c);
    if (!(annual > 0)) continue;
    const list = costsByYear.get(c.year) || [];
    list.push({ label: c.category, annual: Math.round(annual * 100) / 100 });
    costsByYear.set(c.year, list);
  }
  const interestByYear = new Map();
  const proj = projectionFor(prop);
  if (proj) {
    for (const row of proj.series || []) {
      if (!(row.interest > 0)) continue;
      const y = Number(String(row.month).slice(0, 4));
      interestByYear.set(y, Math.round(((interestByYear.get(y) || 0) + row.interest) * 100) / 100);
    }
  }
  const years = new Set([...costsByYear.keys(), ...interestByYear.keys()]);
  const out = new Map();
  for (const y of years) out.set(y, { costs: costsByYear.get(y) || [], interest: interestByYear.has(y) ? interestByYear.get(y) : null });
  return out;
};
const earnRentalYearRow = (rental, row, derivedByYear) => {
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
    }, earnRegion().rental, derivedByYear ? (derivedByYear.get(row.tax_year) || null) : null),
  };
};
const earnRentalRow = (row) => {
  const rental = {
    ...row,
    is_principal_residence: row.is_principal_residence === 1,
    was_principal_residence: row.was_principal_residence === 1,
    structural_change: row.structural_change === 1,
  };
  // The stored ownership_pct is dormant — the read path always
  // carries the derived share, so every surface (list card, detail
  // header, Owned card, year Owner share) shows the same figure.
  rental.ownership_pct = derivedOwnershipPct();
  const entries = db.prepare('SELECT * FROM earn_rental_entries WHERE rental_id = ? ORDER BY start_ym, id').all(row.id);
  rental.entries = entries;
  rental.nextRentDues = nextRentPayments(entries, vancouverToday());
  const years = db.prepare('SELECT * FROM earn_rental_years WHERE rental_id = ? ORDER BY tax_year DESC').all(row.id);
  const derivedByYear = rentalDerivedInputs(rental);
  return { ...rental, years: years.map((y) => earnRentalYearRow(rental, y, derivedByYear)) };
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
// wholesale — but only for the sides the PUT actually carries. An
// absent side is left untouched (same omitted-means-unchanged rule
// as the owner field): the job form no longer edits rows, so its
// saves carry neither side, while the detail-page row flow sends
// both. A legacy save leaves them (and the derived date columns)
// untouched, so old jobs keep computing as before. A null side
// means "leave alone"; an array (possibly empty) replaces it.
const writeJobChildren = (jobId, payChanges, bonuses, ts) => {
  if (payChanges != null) {
    db.prepare('DELETE FROM earn_pay_changes WHERE job_id = ?').run(jobId);
    const insC = db.prepare('INSERT INTO earn_pay_changes (job_id, effective_date, value, amount, basis, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of payChanges) insC.run(jobId, c.effective_date, c.value, c.amount, c.basis, c.scope, ts);
  }
  if (bonuses != null) {
    db.prepare('DELETE FROM earn_bonuses WHERE job_id = ?').run(jobId);
    const insB = db.prepare('INSERT INTO earn_bonuses (job_id, date, amount, created_at) VALUES (?, ?, ?, ?)');
    for (const b of bonuses) insB.run(jobId, b.date, b.amount, ts);
  }
};
const derivedJobYtd = (v, cppExempt, eiExempt) => deriveJobYtd({
  frequency: v.frequency, startDate: v.start_date, recentDate: v.recent_pay_date,
  changes: v.pay_changes, recentValue: v.recent_pay_value,
  payroll: earnRegion().payroll, cppExempt, eiExempt,
});

// Take-home input: the form's value is a per-period net, not a gross.
// Back-solve the gross through the same derived path the gross value
// takes, so the stored job is indistinguishable from one entered as
// gross. Returns an error string, or null after rewriting v in place.
const resolveTakeHome = (body, v, existing, rrspDeduction = 0) => {
  const basis = body.pay_value_basis;
  if (basis !== undefined && basis !== 'gross' && basis !== 'takehome') return 'pay value basis must be gross or takehome.';
  if (basis !== 'takehome') return null;
  if (v.mode !== 'derived') return 'take-home pay needs a job start date and recent payment date.';
  const solved = solveGrossForTakeHome({
    targetNet: v.recent_pay_value, frequency: v.frequency, province: v.province,
    startDate: v.start_date, recentDate: v.recent_pay_date, changes: v.pay_changes, bonuses: v.bonuses,
    payroll: earnRegion().payroll,
    td1Federal: existing ? existing.td1_federal : null,
    td1Provincial: existing ? existing.td1_provincial : null,
    cppExempt: existing ? existing.cpp_exempt === 1 : false,
    eiExempt: existing ? existing.ei_exempt === 1 : false,
    rrspDeduction,
  });
  if (solved.error) return solved.error;
  v.recent_pay_value = solved.gross;
  v.gross_amount = solved.gross;
  return null;
};

// Position rule: a job's current pay always equals its latest-dated
// pay-change entry. derivePayChangeValues fills every entry's
// per-period value (take-home back-solved, annual annualised) and
// must run before any solve that prices segments; pinPositionToLatest
// then pins the rate to the latest entry (with no entries the
// submitted rate stands, so a legacy save and a delete-to-zero whose
// caller sends the opening position keep working).
const derivePayChangeValues = (v, existing, rrspDeduction = 0) => resolvePayChangeValues({
  entries: v.pay_changes, frequency: v.frequency, province: v.province,
  startDate: v.start_date, recentDate: v.recent_pay_date, bonuses: v.bonuses,
  payroll: earnRegion().payroll,
  td1Federal: existing ? existing.td1_federal : null,
  td1Provincial: existing ? existing.td1_provincial : null,
  cppExempt: existing ? existing.cpp_exempt === 1 : false,
  eiExempt: existing ? existing.ei_exempt === 1 : false,
  rrspDeduction,
});
const pinPositionToLatest = (v) => {
  if (!v.pay_changes || !v.pay_changes.length) return;
  const pos = positionValueFor(v.pay_changes, v.recent_pay_value);
  v.recent_pay_value = pos;
  v.gross_amount = pos;
};

app.post('/api/earnings/jobs', requireApiAuth, (req, res) => {
  const v = validJobInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const pcErr = derivePayChangeValues(v, null);
  if (pcErr) return res.status(400).json({ error: pcErr });
  const takeErr = resolveTakeHome(req.body || {}, v, null);
  if (takeErr) return res.status(400).json({ error: takeErr });
  const own = cleanJobOwner((req.body || {}).owner);
  if (own.error) return res.status(400).json({ error: own.error });
  const ts = nowIso();
  if (v.mode === 'derived') {
    // The create-time current pay is the opening position, captured
    // before the position rule pins the rate to the latest entry.
    const opening = v.recent_pay_value;
    pinPositionToLatest(v);
    const ytd = derivedJobYtd(v, false, false);
    const out = commitTx(req, 'job', {
      module: 'earnings', entityType: 'job', entityId: null,
      entityLabel: v.employer, summary: `Added job ${v.employer}`,
    }, () => {
      dropSystemHomeInsights(req.user.id);
      const id = db.transaction(() => {
        const info = db.prepare(
          `INSERT INTO earn_jobs (employer, owner, currency, province, frequency, gross_amount, gross_basis, tax_year,
           start_date, recent_pay_date, opening_value,
           td1_federal, td1_provincial, ytd_cpp, ytd_cpp2, ytd_ei, cpp_exempt, ei_exempt, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          v.employer, own.value, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis, v.tax_year,
          v.start_date, v.recent_pay_date, opening,
          null, null, ytd.ytd_cpp, ytd.ytd_cpp2, ytd.ytd_ei, 0, 0, ts, ts);
        writeJobChildren(info.lastInsertRowid, v.pay_changes, v.bonuses, ts);
        return info.lastInsertRowid;
      })();
      return { value: earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)), entityId: id };
    });
    return res.status(201).json(out);
  }
  const out = commitTx(req, 'job', {
    module: 'earnings', entityType: 'job', entityId: null,
    entityLabel: v.employer, summary: `Added job ${v.employer}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    const info = db.prepare(
      `INSERT INTO earn_jobs (employer, owner, currency, province, frequency, gross_amount, gross_basis, tax_year,
       td1_federal, td1_provincial, ytd_cpp, ytd_cpp2, ytd_ei, cpp_exempt, ei_exempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      v.employer, own.value, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis, v.tax_year,
      v.td1_federal, v.td1_provincial, v.ytd_cpp, v.ytd_cpp2, v.ytd_ei,
      v.cpp_exempt ? 1 : 0, v.ei_exempt ? 1 : 0, ts, ts);
    return { value: earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(info.lastInsertRowid)), entityId: info.lastInsertRowid };
  });
  res.status(201).json(out);
});
app.put('/api/earnings/jobs/:id', requireApiAuth, (req, res) => {
  const v = validJobInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'job not found' });
  // Take-home back-solves price the displayed net definition, so a
  // job with linked plans solves with the same pre-tax deduction
  // the read-time calc applies (per-payday rule: plans active at the
  // edited job's next payday, falling back to today for a dateless
  // job; a new job has no plans, so POST keeps the 0). Percent plans
  // derive from the job's POST-edit gross: the derive/solve/pin cycle
  // iterates until the deduction implied by the resulting gross
  // matches the deduction used (fixed point, cent tolerance). The
  // read path re-derives on every read, but the STORED values — a
  // take-home-solved gross, take-home-basis pay-change values — are
  // priced with this deduction, so a pre-edit figure would store a
  // gross off by the percent of the gross delta until the next edit.
  // Already-generated plan events keep generation-time amounts; only
  // newly generated periods use the new derived amount.
  const putToday = vancouverToday();
  const putNext = nextPayDate({ frequency: v.frequency || existing.frequency, startDate: v.start_date || existing.start_date, recentDate: v.recent_pay_date || existing.recent_pay_date }, putToday);
  const activePlans = db.prepare('SELECT * FROM invest_plans WHERE job_id = ?').all(id)
    .filter((p) => putNext == null ? p.start_date <= putToday : p.start_date <= putNext);
  const dedForGross = (g) => activePlans.reduce((s, p) => s + planPeriodAmounts(p, g).own, 0);
  const takeHomeTarget = (req.body || {}).pay_value_basis === 'takehome' ? v.recent_pay_value : null;
  let rrspDed = dedForGross(earnJobRow(existing).calc.perPeriod.gross);
  for (let iter = 0; iter < 10; iter++) {
    // resolveTakeHome rewrites recent_pay_value with the solved
    // gross, so restore the entered take-home target each pass.
    if (takeHomeTarget != null) v.recent_pay_value = takeHomeTarget;
    const pcErr = derivePayChangeValues(v, existing, rrspDed);
    if (pcErr) return res.status(400).json({ error: pcErr });
    const takeErr = resolveTakeHome(req.body || {}, v, existing, rrspDed);
    if (takeErr) return res.status(400).json({ error: takeErr });
    if (v.mode === 'derived') pinPositionToLatest(v);
    const postGross = planJobPerPeriodGross({ gross_amount: v.gross_amount, frequency: v.frequency, gross_basis: v.gross_basis });
    const newDed = postGross == null ? rrspDed : dedForGross(postGross);
    if (Math.abs(newDed - rrspDed) < 0.005) { rrspDed = newDed; break; }
    rrspDed = newDed;
  }
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
    pinPositionToLatest(v);
    const ytd = derivedJobYtd(v, existing.cpp_exempt === 1, existing.ei_exempt === 1);
    const out = commitTx(req, 'job', {
      module: 'earnings', entityType: 'job', entityId: id,
      entityLabel: v.employer, summary: `Updated job ${v.employer}`,
    }, () => {
      dropSystemHomeInsights(req.user.id);
      db.transaction(() => {
        db.prepare(
          `UPDATE earn_jobs SET employer = ?, owner = ?, currency = ?, province = ?, frequency = ?, gross_amount = ?, gross_basis = ?,
           tax_year = ?, start_date = ?, recent_pay_date = ?, ytd_cpp = ?, ytd_cpp2 = ?, ytd_ei = ?, updated_at = ? WHERE id = ?`).run(
          v.employer, owner, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis,
          v.tax_year, v.start_date, v.recent_pay_date, ytd.ytd_cpp, ytd.ytd_cpp2, ytd.ytd_ei, nowIso(), id);
        writeJobChildren(id,
          (req.body || {}).pay_changes !== undefined ? v.pay_changes : null,
          (req.body || {}).bonuses !== undefined ? v.bonuses : null,
          nowIso());
      })();
      return { value: earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)), entityId: id };
    });
    return res.json(out);
  }
  const out = commitTx(req, 'job', {
    module: 'earnings', entityType: 'job', entityId: id,
    entityLabel: v.employer, summary: `Updated job ${v.employer}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare(
      `UPDATE earn_jobs SET employer = ?, owner = ?, currency = ?, province = ?, frequency = ?, gross_amount = ?, gross_basis = ?,
       tax_year = ?, td1_federal = ?, td1_provincial = ?, ytd_cpp = ?, ytd_cpp2 = ?, ytd_ei = ?,
       cpp_exempt = ?, ei_exempt = ?, updated_at = ? WHERE id = ?`).run(
      v.employer, owner, v.currency, v.province, v.frequency, v.gross_amount, v.gross_basis, v.tax_year,
      v.td1_federal, v.td1_provincial, v.ytd_cpp, v.ytd_cpp2, v.ytd_ei,
      v.cpp_exempt ? 1 : 0, v.ei_exempt ? 1 : 0, nowIso(), id);
    return { value: earnJobRow(db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id)), entityId: id };
  });
  res.json(out);
});
app.delete('/api/earnings/jobs/:id', requireApiAuth, (req, res) => {
  const id = Number(req.params.id);
  const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  // A job with linked contribution plans cannot go: plans
  // derive their frequency from it, so deleting it would
  // strand them. Delete the plans first, then the job.
  const linked = db.prepare('SELECT COUNT(*) AS n FROM invest_plans WHERE job_id = ?').get(id).n;
  if (linked > 0) {
    return res.status(400).json({ error: `cannot delete this job — ${linked} contribution plan${linked === 1 ? '' : 's'} link to it; delete the plan${linked === 1 ? '' : 's'} first` });
  }
  commitTx(req, 'job', {
    module: 'earnings', entityType: 'job', entityId: id,
    entityLabel: job.employer, summary: `Deleted job ${job.employer}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare('DELETE FROM earn_jobs WHERE id = ?').run(id);
    return { value: { ok: true }, entityId: id };
  });
  res.json({ ok: true });
});

// Monthly pay composition for the job detail page: stacked gross
// segments per month (see jobMonthlySeries). Dateless jobs get an
// empty series — the detail page renders no chart for them.
app.get('/api/earnings/jobs/:id/monthly-chart', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'job not found' });
  const job = earnJobRow(row);
  // Percent plans price from the job's current gross (the chart's
  // current-rate convention), so the RRSP slices and the per-payday
  // tax recompute both see derived amounts, never stored NULLs.
  const gross = job.calc.perPeriod.gross;
  const plans = db.prepare('SELECT * FROM invest_plans WHERE job_id = ?').all(row.id)
    .map((p) => ({ start_date: p.start_date, own_amount: planPeriodAmounts(p, gross).own, employer_amount: planPeriodAmounts(p, gross).employer }));
  const series = jobMonthlySeries({
    frequency: row.frequency, startDate: row.start_date, recentDate: row.recent_pay_date,
    calc: job.calc, plans, today: vancouverToday(),
    job, payroll: earnRegion().payroll,
  });
  res.json(series || { months: [], gross: [], tax: [], cppEi: [], rrsp: null, net: [] });
});

app.post('/api/earnings/rentals', requireApiAuth, (req, res) => {
  const v = validRentalInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.property_id != null && !db.prepare('SELECT id FROM properties WHERE id = ?').get(v.property_id)) {
    return res.status(400).json({ error: 'property not found.' });
  }
  const out = commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: null,
    entityLabel: v.label, summary: `Added rental ${v.label}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    const ts = nowIso();
    const info = db.prepare(
      `INSERT INTO earn_rentals (property_id, label, address, rental_type, services_level,
       rental_portion_pct, is_principal_residence, was_principal_residence, structural_change, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      v.property_id, v.label, v.address, v.rental_type, v.services_level, v.rental_portion_pct,
      v.is_principal_residence ? 1 : 0, v.was_principal_residence ? 1 : 0, v.structural_change ? 1 : 0, ts, ts);
    return { value: earnRentalRow(db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(info.lastInsertRowid)), entityId: info.lastInsertRowid };
  });
  res.status(201).json(out);
});
app.put('/api/earnings/rentals/:id', requireApiAuth, (req, res) => {
  const v = validRentalInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM earn_rentals WHERE id = ?').get(id)) return res.status(404).json({ error: 'rental not found' });
  if (v.property_id != null && !db.prepare('SELECT id FROM properties WHERE id = ?').get(v.property_id)) {
    return res.status(400).json({ error: 'property not found.' });
  }
  const out = commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: id,
    entityLabel: v.label, summary: `Updated rental ${v.label}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare(
      `UPDATE earn_rentals SET property_id = ?, label = ?, address = ?, rental_type = ?, services_level = ?,
       rental_portion_pct = ?, is_principal_residence = ?, was_principal_residence = ?, structural_change = ?,
       updated_at = ? WHERE id = ?`).run(
      v.property_id, v.label, v.address, v.rental_type, v.services_level, v.rental_portion_pct,
      v.is_principal_residence ? 1 : 0, v.was_principal_residence ? 1 : 0, v.structural_change ? 1 : 0, nowIso(), id);
    return { value: earnRentalRow(db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(id)), entityId: id };
  });
  res.json(out);
});
app.delete('/api/earnings/rentals/:id', requireApiAuth, (req, res) => {
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(req.params.id));
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: rental.id,
    entityLabel: rental.label, summary: `Deleted rental ${rental.label}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare('DELETE FROM earn_rentals WHERE id = ?').run(Number(req.params.id));
    return { value: { ok: true }, entityId: rental.id };
  });
  res.json({ ok: true });
});

app.post('/api/earnings/rentals/:id/years', requireApiAuth, (req, res) => {
  const rentalId = Number(req.params.id);
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(rentalId);
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  const v = validRentalYearInput(req.body || {}, earnRegion().rental.t776Lines);
  if (v.error) return res.status(400).json({ error: v.error });
  let out;
  try {
    out = commitTx(req, 'rental', {
      module: 'earnings', entityType: 'rental', entityId: rentalId,
      entityLabel: rental.label, summary: `Updated year record · ${rental.label}`,
    }, () => {
      const ts = nowIso();
      const info = db.prepare(
        `INSERT INTO earn_rental_years (rental_id, tax_year, gross_rents, other_income, area_share_pct, rental_days,
         mortgage_interest, mortgage_principal, expenses, claim_cca, cca_acknowledged, ucc_class1, ucc_class8,
         str_compliant_days, str_non_compliant_days, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, 365, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        rentalId, v.tax_year, v.other_income, v.area_share_pct,
        v.mortgage_interest, v.mortgage_principal, JSON.stringify(v.expenses),
        v.claim_cca ? 1 : 0, v.cca_acknowledged ? 1 : 0, v.ucc_class1, v.ucc_class8,
        v.str_compliant_days, v.str_non_compliant_days, ts, ts);
      return { value: earnRentalYearRow(earnRentalRow(rental), db.prepare('SELECT * FROM earn_rental_years WHERE id = ?').get(info.lastInsertRowid), rentalDerivedInputs(rental)), entityId: rentalId };
    });
  } catch {
    return res.status(400).json({ error: 'a year record already exists for this rental.' });
  }
  res.status(201).json(out);
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
  const out = commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: rental.id,
    entityLabel: rental.label, summary: `Updated year record · ${rental.label}`,
  }, () => {
    db.prepare(
      `UPDATE earn_rental_years SET tax_year = ?, other_income = ?, area_share_pct = ?,
       mortgage_interest = ?, mortgage_principal = ?, expenses = ?, claim_cca = ?, cca_acknowledged = ?,
       ucc_class1 = ?, ucc_class8 = ?, str_compliant_days = ?, str_non_compliant_days = ?, updated_at = ?
       WHERE id = ?`).run(
      v.tax_year, v.other_income, v.area_share_pct,
      v.mortgage_interest, v.mortgage_principal, JSON.stringify(v.expenses),
      v.claim_cca ? 1 : 0, v.cca_acknowledged ? 1 : 0, v.ucc_class1, v.ucc_class8,
      v.str_compliant_days, v.str_non_compliant_days, nowIso(), yearId);
    return { value: earnRentalYearRow(earnRentalRow(rental), db.prepare('SELECT * FROM earn_rental_years WHERE id = ?').get(yearId), rentalDerivedInputs(rental)), entityId: rental.id };
  });
  res.json(out);
});
app.delete('/api/earnings/rentals/:rentalId/years/:yearId', requireApiAuth, (req, res) => {
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(req.params.rentalId));
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  if (!db.prepare('SELECT id FROM earn_rental_years WHERE id = ? AND rental_id = ?').get(Number(req.params.yearId), rental.id)) {
    return res.status(404).json({ error: 'year record not found' });
  }
  commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: rental.id,
    entityLabel: rental.label, summary: `Updated year record · ${rental.label}`,
  }, () => {
    db.prepare('DELETE FROM earn_rental_years WHERE id = ? AND rental_id = ?')
      .run(Number(req.params.yearId), Number(req.params.rentalId));
    return { value: { ok: true }, entityId: rental.id };
  });
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
  const out = commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: rental.id,
    entityLabel: rental.label, summary: `Updated rent entry · ${rental.label}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    const ts = nowIso();
    const info = db.prepare(
      `INSERT INTO earn_rental_entries (rental_id, start_ym, end_ym, monthly_rent, pay_day, cash_amount, tenant_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      rental.id, v.start_ym, v.end_ym, v.monthly_rent, v.pay_day, v.cash_amount, v.tenant_name, ts, ts);
    const entry = db.prepare('SELECT * FROM earn_rental_entries WHERE id = ?').get(info.lastInsertRowid);
    ensureRentalYearsForEntry(rental.id, entry);
    return { value: earnRentalRow(rental), entityId: rental.id };
  });
  res.status(201).json(out);
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
  const out = commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: rental.id,
    entityLabel: rental.label, summary: `Updated rent entry · ${rental.label}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare(
      `UPDATE earn_rental_entries SET start_ym = ?, end_ym = ?, monthly_rent = ?, pay_day = ?,
       cash_amount = ?, tenant_name = ?, updated_at = ? WHERE id = ?`).run(
      v.start_ym, v.end_ym, v.monthly_rent, v.pay_day, v.cash_amount, v.tenant_name, nowIso(), entryId);
    const entry = db.prepare('SELECT * FROM earn_rental_entries WHERE id = ?').get(entryId);
    ensureRentalYearsForEntry(rental.id, entry);
    return { value: earnRentalRow(rental), entityId: rental.id };
  });
  res.json(out);
});
app.delete('/api/earnings/rentals/:rentalId/entries/:entryId', requireApiAuth, (req, res) => {
  const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(req.params.rentalId));
  if (!rental) return res.status(404).json({ error: 'rental not found' });
  if (!db.prepare('SELECT id FROM earn_rental_entries WHERE id = ? AND rental_id = ?').get(Number(req.params.entryId), rental.id)) {
    return res.status(404).json({ error: 'entry not found' });
  }
  commitTx(req, 'rental', {
    module: 'earnings', entityType: 'rental', entityId: rental.id,
    entityLabel: rental.label, summary: `Updated rent entry · ${rental.label}`,
  }, () => {
    dropSystemHomeInsights(req.user.id);
    db.prepare('DELETE FROM earn_rental_entries WHERE id = ? AND rental_id = ?')
      .run(Number(req.params.entryId), Number(req.params.rentalId));
    return { value: { ok: true }, entityId: rental.id };
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- tax ---
// Tax (v1, 2026-11-08): an items inventory + linking + slip
// capture, organised as tax PROJECTS. One person may have MANY
// projects for one tax year — each project has its own name, its
// own items/links/slips. NO tax computation — no payable/refund
// math anywhere in this module (the RRSP benefit slider is a
// scoped estimate from the existing Earnings engine, not a return
// computation).
// Jurisdiction logic lives in the region's tax module
// (src/regions/ca/tax.js); the endpoints below only wire
// filings/items/slips/profiles to it, so a later US or
// cross-border region plugs in without touching them. Filings
// cover every household user EXCEPT admin; the admin account
// itself never files.
// NO GENERATION (user 2026-11-08, supersedes the on-demand
// Generate rule): there is NO Generate button anywhere in Tax.
// Projects start empty (0 items); the user adds items manually
// via an Add action, picking from the region's expected-items
// derivation as a CANDIDATE list (GET .../candidates) —
// candidates are shown for the user to choose, never
// auto-applied. Nothing generates on page load, year change, or
// in the background. The detail page is sectioned like a guided
// return (Income, Deductions, Credits, Review — TAX_SECTIONS in
// src/tax.js). Slips sit at the TOP of the detail (Tax Profile
// left, Slips right); adding a slip — manually or via Fill with
// AI — automatically places its item in the matching section
// (slipToItemKind + slipAmount), because the slip IS the source
// document. That placement is the consequence of the user adding
// the slip, not background generation: nothing is placed until
// a slip is added, and placed items stay editable/deletable.
// A Tax Profile per person records remaining contribution room
// (RRSP / TFSA / RESP), user-entered from the CRA Notice of
// Assessment, never invented; the RRSP slider caps at the
// recorded room when one exists.
// RRSP contributions for a tax year use the CRA first-60-days
// window (Mar 1 of the year through the 60th day of the next
// year — region rrspWindow), not the calendar year. RESP
// contributions are NOT tax-deductible (CRA): RESP items are
// tracked in Deductions, marked non-deductible, and contribute
// $0 to every deduction total. Rental deductions are edited
// TOGETHER with the rental income item (the T776 form carries
// gross rents and deductible expenses on one form) and applied
// automatically to Deductions as a derived, read-only row —
// never separately editable or addable there.
const taxRegionFor = (filing) => {
  const r = getRegion((filing && filing.region) || 'CA') || getRegion('CA');
  return r.tax;
};
const taxFilers = () => db.prepare('SELECT * FROM users WHERE username != ? ORDER BY id').all(adminUsername());
const taxFilingLabel = (filing, person) => {
  const name = filing && filing.name ? filing.name : 'Tax return';
  const who = person ? person.username : '?';
  return `${name} · ${who} · ${filing ? filing.tax_year : '?'}`;
};
const getTaxProfile = (personId) => db.prepare('SELECT * FROM tax_profiles WHERE person_id = ?').get(Number(personId)) || null;
const taxItemView = (row) => {
  if (!row) return null;
  let detail = {};
  // Idempotent: callers pass both raw rows (detail is a JSON
  // string) and already-viewed items (detail is an object) —
  // syncRentalDeduction views an item it was handed as a view,
  // and JSON.parse on an object throws and would silently
  // clobber the detail to {} (a $0 derived rental row).
  try { detail = typeof row.detail === 'string' ? JSON.parse(row.detail || '{}') : (row.detail || {}); } catch { detail = {}; }
  return { ...row, detail, effective_amount: effectiveAmount(row) };
};
const taxSlipView = (row) => {
  if (!row) return null;
  let fields = {};
  try { fields = typeof row.fields === 'string' ? JSON.parse(row.fields || '{}') : (row.fields || {}); } catch { fields = {}; }
  let aiFields = null;
  try { aiFields = row.ai_fields ? (typeof row.ai_fields === 'string' ? JSON.parse(row.ai_fields) : row.ai_fields) : null; } catch { aiFields = null; }
  return { ...row, fields, ai_fields: aiFields };
};
const taxFilingView = (filing) => {
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(filing.person_id);
  const items = db.prepare('SELECT * FROM tax_items WHERE filing_id = ? ORDER BY kind, id').all(filing.id).map(taxItemView);
  const slips = db.prepare('SELECT * FROM tax_slips WHERE filing_id = ? ORDER BY id').all(filing.id).map(taxSlipView);
  return {
    ...filing,
    person: person ? { id: person.id, username: person.username } : null,
    items, slips,
    totals: filingTotals(items),
  };
};
const validTaxYear = (y) => Number.isInteger(Number(y)) && Number(y) >= 2000 && Number(y) <= 2100;
// The region's expected-items context for one tax year, built
// from the app's own records: salary jobs (annual gross from the
// earnings calc), rental years (T776 net from the rental calc),
// RRSP plans (own contributions, actual generated events first,
// projected due periods otherwise), and NonRegistered dividends
// and sales (TFSA/RRSP income is not taxed in-year).
const deriveTaxContext = (taxYear) => {
  const region = getRegion('CA');
  const jobRows = db.prepare('SELECT * FROM earn_jobs WHERE tax_year = ? ORDER BY employer').all(taxYear).map(earnJobRow);
  const rentalRows = db.prepare('SELECT * FROM earn_rentals ORDER BY label').all().map((r) => {
    const row = earnRentalRow(r);
    let owners = [];
    if (r.property_id != null) {
      const prop = db.prepare('SELECT owners FROM properties WHERE id = ?').get(r.property_id);
      owners = parseOwners(prop ? prop.owners : null);
    }
    return { ...row, propertyOwners: owners };
  });
  // NOTE: the joined columns are aliased to the camelCase names
  // buildExpectedContext expects (accountType, accountName,
  // holdingLabel, jobOwner, jobFrequency) — the raw table columns
  // stay snake_case (start_date, own_amount, …), which
  // planOwnAnnual / planPeriodAmounts read as-is.
  const planRows = db.prepare(`
    SELECT p.*, a.name AS accountName, a.type AS accountType, a.default_currency AS currency,
      h.label AS holdingLabel, j.owner AS jobOwner, j.frequency AS jobFrequency,
      j.gross_amount AS jobGrossAmount, j.gross_basis AS jobGrossBasis
    FROM invest_plans p
    JOIN invest_accounts a ON a.id = p.account_id
    LEFT JOIN invest_holdings h ON h.id = p.target_holding_id
    JOIN earn_jobs j ON j.id = p.job_id ORDER BY p.id`).all()
    .map((p) => ({
      ...p,
      taxYear,
      currency: p.currency || 'CAD',
      events: db.prepare("SELECT * FROM invest_events WHERE plan_id = ? AND type = 'buy' ORDER BY date").all(p.id),
      deletedDueDates: db.prepare('SELECT due_date FROM invest_plan_deleted WHERE plan_id = ?').all(p.id).map((d) => d.due_date),
      job: { frequency: p.jobFrequency, gross_amount: p.jobGrossAmount, gross_basis: p.jobGrossBasis },
    }));
  const eventRows = (type) => db.prepare(`
    SELECT e.*, h.label AS holdingLabel, h.currency, a.name AS accountName, a.type AS accountType, a.owners AS accountOwners
    FROM invest_events e
    JOIN invest_holdings h ON h.id = e.holding_id
    JOIN invest_accounts a ON a.id = h.account_id
    WHERE e.type = ? AND substr(e.date, 1, 4) = ? ORDER BY e.date, e.id`).all(type, String(taxYear));
  return buildExpectedContext({
    taxYear, jobRows, rentalRows, planRows,
    dividendRows: eventRows('dividend'), sellRows: eventRows('sell'),
    payroll: region.payroll,
    // The RRSP window is the region's CRA rule (Mar 1 → first
    // 60 days of the next year), not the calendar year; the T776
    // expense lines come from the region's rental module so the
    // candidate detail can label the rental year's lines.
    rrspWindow: region.tax.rrspWindow(taxYear),
    t776Lines: region.rental ? region.rental.t776Lines : [],
  });
};
const getTaxFiling = (id) => db.prepare('SELECT * FROM tax_filings WHERE id = ?').get(Number(id));

// The region's candidate list for one filing: the derivation for
// the filing's tax year, filtered to items this person owns (or
// that no record owns — UNLINKED, the user claims them by
// adding), minus the sources already in this filing. Candidates
// are a read-only proposal — adding one is a separate explicit
// POST (from-candidate below), never automatic.
const taxCandidatesFor = (filing) => {
  const regionTax = taxRegionFor(filing);
  const ctx = deriveTaxContext(filing.tax_year);
  const person = db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id);
  const username = person ? person.username : null;
  const added = new Set(
    db.prepare("SELECT source_type, source_id FROM tax_items WHERE filing_id = ? AND source_type IS NOT NULL")
      .all(filing.id).map((r) => `${r.source_type}:${r.source_id}`),
  );
  return regionTax.expectedItems(ctx)
    .filter((d) => !d.personKey || (username && d.personKey === username))
    .filter((d) => !added.has(`${d.sourceType}:${d.sourceId}`));
};

app.get('/api/tax/years', requireApiAuth, (req, res) => {
  const years = new Set([Number(vancouverToday().slice(0, 4))]);
  for (const r of db.prepare('SELECT DISTINCT tax_year FROM earn_jobs').all()) years.add(Number(r.tax_year));
  for (const r of db.prepare('SELECT DISTINCT tax_year FROM earn_rental_years').all()) years.add(Number(r.tax_year));
  for (const r of db.prepare("SELECT DISTINCT CAST(substr(date, 1, 4) AS INTEGER) AS y FROM invest_events").all()) {
    if (r.y) years.add(Number(r.y));
  }
  for (const r of db.prepare('SELECT DISTINCT tax_year FROM tax_filings').all()) years.add(Number(r.tax_year));
  const sorted = [...years].filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100).sort((a, b) => b - a);
  res.json({ years: sorted, current: Number(vancouverToday().slice(0, 4)) });
});

app.get('/api/tax/filings', requireApiAuth, (req, res) => {
  const year = Number(req.query.year || vancouverToday().slice(0, 4));
  if (!validTaxYear(year)) return res.status(400).json({ error: 'year must be between 2000 and 2100.' });
  // Projects grouped by person: one person may have many
  // projects for the year, each with its own name and items.
  // Nothing here generates — the list only reads what already
  // exists. (The old unlinked bucket died with Generate: with
  // no generation, unlinked candidates are offered per filing
  // by the candidates endpoint and added straight into it.)
  const filers = taxFilers().map((u) => {
    const projects = db.prepare('SELECT * FROM tax_filings WHERE person_id = ? AND tax_year = ? ORDER BY id').all(u.id, year)
      .map((f) => {
        const view = taxFilingView(f);
        // The home card's highlighted balance — the same T1 figure
        // as the detail headline, or null when there is nothing
        // computable to show (the card then shows the title only).
        return { ...view, items: undefined, slips: undefined, itemCount: view.items.length, refund: filingCardRefund(f, view) };
      });
    return {
      person: { id: u.id, username: u.username },
      projects,
      profile: getTaxProfile(u.id),
    };
  });
  res.json({ year, filers });
});

app.post('/api/tax/filings', requireApiAuth, (req, res) => {
  const b = req.body || {};
  const year = Number(b.year);
  if (!validTaxYear(year)) return res.status(400).json({ error: 'year must be between 2000 and 2100.' });
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(b.personId));
  if (!person || person.username === adminUsername()) {
    return res.status(400).json({ error: 'person must be a household user (not admin).' });
  }
  const regionCode = b.region != null ? String(b.region).toUpperCase() : 'CA';
  if (!getRegion(regionCode)) return res.status(400).json({ error: `unknown region "${regionCode}".` });
  // Many projects per person per year are allowed — there is no
  // duplicate check. The name defaults when blank; the UI asks
  // for one. Creating a project adds NOTHING — items come only
  // from the user's Add actions on the project (candidates,
  // forms, slips).
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 100) : `Tax return ${year}`;
  const out = commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: null,
    entityLabel: `${name} · ${person.username} · ${year}`,
    summary: `Created tax project · ${name} · ${person.username} · ${year}`,
  }, () => {
    const now = nowIso();
    const info = db.prepare('INSERT INTO tax_filings (person_id, name, tax_year, region, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(person.id, name, year, regionCode, 'open', now, now);
    return { value: taxFilingView(db.prepare('SELECT * FROM tax_filings WHERE id = ?').get(info.lastInsertRowid)), entityId: info.lastInsertRowid };
  });
  res.status(201).json(out);
});

app.get('/api/tax/filings/:id', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const regionTax = taxRegionFor(filing);
  const view = taxFilingView(filing);
  const person = view.person;
  // The RRSP slider starts from this person's linked RRSP plan
  // amounts for the year (actual generated events first,
  // projected due periods otherwise — planOwnAnnual, over the
  // CRA first-60-days window for the tax year).
  const ctx = deriveTaxContext(filing.tax_year);
  const rrspPlanAnnual = person
    ? round2(ctx.plans.filter((p) => p.owner === person.username).reduce((s, p) => s + (Number(p.ownAnnual) || 0), 0))
    : 0;
  const region = getRegion('CA');
  res.json({
    ...view,
    slipKinds: regionTax.slipKinds,
    // The T776 form structure (income lines + numbered expense
    // lines + computed totals) for the Add/Edit item forms, and
    // the RRSP contribution window for the tax year.
    t776Form: regionTax.t776FormDef(region && region.rental ? region.rental.t776Lines : []),
    rrspWindow: regionTax.rrspWindow(filing.tax_year),
    sections: sectionSummary(view.items),
    profile: person ? getTaxProfile(person.id) : null,
    rrspPlanAnnual,
  });
});

// The Add picker's candidate list for one filing: the region's
// derivation for the filing's year, filtered to this person (or
// unlinked) and minus sources already in the filing. Read-only —
// nothing is written until the user picks one (from-candidate).
app.get('/api/tax/filings/:id/candidates', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  res.json({ filingId: filing.id, taxYear: filing.tax_year, candidates: taxCandidatesFor(filing) });
});

// Add one candidate to a filing, by source. The candidate is
// re-derived at write time (never trusted from the client), the
// item is 'linked' — the user chose it — and a rental candidate
// also syncs its Deductions row (below).
app.post('/api/tax/filings/:id/items/from-candidate', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const b = req.body || {};
  if (typeof b.sourceType !== 'string' || b.sourceType.trim() === '' || b.sourceId == null) {
    return res.status(400).json({ error: 'sourceType and sourceId are required.' });
  }
  const candidate = taxCandidatesFor(filing)
    .find((d) => d.sourceType === b.sourceType && Number(d.sourceId) === Number(b.sourceId));
  if (!candidate) {
    return res.status(400).json({ error: 'that source is not an addable candidate for this filing (it may already be added).' });
  }
  const person = db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id);
  const out = commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: `${taxFilingLabel(filing, person)}`,
    summary: `Added ${candidate.kind} item · ${taxFilingLabel(filing, person)}`,
  }, () => {
    const now = nowIso();
    const info = db.prepare(`INSERT INTO tax_items
      (filing_id, tax_year, kind, label, source_type, source_id, slip_id, amount, currency, share_pct, status, detail, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'linked', ?, NULL, ?, ?)`)
      .run(filing.id, filing.tax_year, candidate.kind, candidate.label, candidate.sourceType, candidate.sourceId,
        candidate.amount, candidate.currency || 'CAD', candidate.sharePct == null ? 100 : candidate.sharePct,
        JSON.stringify(candidate.detail || {}), now, now);
    const item = taxItemView(db.prepare('SELECT * FROM tax_items WHERE id = ?').get(info.lastInsertRowid));
    syncRentalDeduction(filing, item);
    return { value: item, entityId: filing.id };
  });
  res.status(201).json(out);
});

// ------------------------------------------------- rental deduction sync --
// The Deductions section shows the rental deduction as a DERIVED
// row (computed from the T776 expenses × share) — it is never
// separately editable or addable there. This runs inside the
// caller's commitTx whenever a rental item is added, edited or
// deleted, so editing the T776 in Income updates Deductions in
// the same write. The row is kind 'deduction', source
// 'rental-deduction', status 'linked', with detail.derived true;
// excluding or deleting the rental item removes its row.
function syncRentalDeduction(filing, rentalItem) {
  const existing = db.prepare("SELECT * FROM tax_items WHERE filing_id = ? AND source_type = 'rental-deduction' AND source_id = ?")
    .get(filing.id, rentalItem.id);
  const view = taxItemView(rentalItem);
  if (!view || view.kind !== 'rental' || view.status === 'excluded') {
    if (existing) db.prepare('DELETE FROM tax_items WHERE id = ?').run(existing.id);
    return;
  }
  // A rental with no T776 data — a plain manual amount, no form
  // lines — has no deductible expenses to derive, so it gets no
  // row (a $0 derived row would be noise in Deductions and in
  // the item count). A T776-backed rental (manual form or
  // source-backed calc) always carries deductible/lines.
  const d = (view.detail || {});
  const hasT776 = d.form === 'T776' || isFinite(Number(d.deductible))
    || (d.lines && typeof d.lines === 'object' && (Array.isArray(d.lines) ? d.lines.length > 0 : Object.keys(d.lines).length > 0));
  if (!hasT776) {
    if (existing) db.prepare('DELETE FROM tax_items WHERE id = ?').run(existing.id);
    return;
  }
  const amount = round2(rentalDeductible(view) * (Number(view.share_pct) || 100) / 100);
  const now = nowIso();
  const detail = JSON.stringify({
    derived: true, rental_item_id: rentalItem.id,
    deductible: rentalDeductible(view),
    gross: isFinite(Number(view.detail.gross)) ? round2(Number(view.detail.gross)) : round2(rentalNet(view) + rentalDeductible(view)),
  });
  if (existing) {
    db.prepare(`UPDATE tax_items SET label = ?, amount = ?, share_pct = ?, detail = ?, updated_at = ? WHERE id = ?`)
      .run(`Rental deduction — ${view.label}`, amount, view.share_pct, detail, now, existing.id);
  } else {
    db.prepare(`INSERT INTO tax_items
      (filing_id, tax_year, kind, label, source_type, source_id, slip_id, amount, currency, share_pct, status, detail, notes, created_at, updated_at)
      VALUES (?, ?, 'deduction', ?, 'rental-deduction', ?, NULL, ?, 'CAD', ?, 'linked', ?, NULL, ?, ?)`)
      .run(filing.id, filing.tax_year, `Rental deduction — ${view.label}`, rentalItem.id,
        amount, view.share_pct, detail, now, now);
  }
}

app.put('/api/tax/filings/:id', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 100) {
      return res.status(400).json({ error: 'name is required (max 100 characters).' });
    }
    patch.name = b.name.trim();
  }
  if (b.status !== undefined) {
    if (!TAX_FILING_STATUSES.includes(String(b.status))) {
      return res.status(400).json({ error: `status must be one of ${TAX_FILING_STATUSES.join(', ')}.` });
    }
    patch.status = String(b.status);
  }
  if (!Object.keys(patch).length) return res.json(taxFilingView(filing));
  const person = db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id);
  const next = { ...filing, ...patch };
  const summary = patch.name != null && patch.status != null
    ? `Renamed project and marked ${patch.status} · ${taxFilingLabel(next, person)}`
    : patch.name != null
      ? `Renamed project · ${taxFilingLabel(next, person)}`
      : `Marked filing ${patch.status} · ${taxFilingLabel(filing, person)}`;
  commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: taxFilingLabel(next, person),
    summary,
  }, () => {
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE tax_filings SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(patch), nowIso(), filing.id);
    return { value: null, entityId: filing.id };
  });
  res.json(taxFilingView(getTaxFiling(req.params.id)));
});

app.delete('/api/tax/filings/:id', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const person = db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id);
  commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: taxFilingLabel(filing, person),
    summary: `Deleted tax project · ${taxFilingLabel(filing, person)}`,
  }, () => {
    // Items and slips go with the project (FK cascade).
    db.prepare('DELETE FROM tax_filings WHERE id = ?').run(filing.id);
    return { value: null, entityId: filing.id };
  });
  res.json({ ok: true });
});

app.post('/api/tax/filings/:id/items', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const err = validTaxItemInput(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const regionTax = taxRegionFor(filing);
  const region = getRegion('CA');
  // A manual item may carry a detail — today that means a manual
  // T776: the form's lines, from which the server derives the
  // amount (gross − expenses = net). The client never supplies
  // the amount for a form-backed item; a forged `derived` flag
  // is stripped (derived rows are only written by
  // syncRentalDeduction).
  let detail = {};
  let amount = Number(b.amount);
  if (b.detail != null) {
    if (typeof b.detail !== 'object' || Array.isArray(b.detail)) {
      return res.status(400).json({ error: 'detail must be an object.' });
    }
    detail = { ...b.detail };
    delete detail.derived;
    if (b.kind === 'rental' && detail.form === 'T776') {
      const linesErr = regionTax.validT776Lines(detail.lines, region && region.rental ? region.rental.t776Lines : []);
      if (linesErr) return res.status(400).json({ error: linesErr });
      const cleaned = {};
      for (const [k, v] of Object.entries(detail.lines || {})) {
        if (v != null && v !== '') cleaned[k] = Number(v);
      }
      const totals = regionTax.t776Totals(cleaned);
      detail = { form: 'T776', lines: cleaned, gross: totals.gross, deductible: totals.expenses, net: totals.net };
      amount = totals.net;
    }
  }
  const person = db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id);
  const out = commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: `${taxFilingLabel(filing, person)}`,
    summary: `Added ${b.kind} item · ${taxFilingLabel(filing, person)}`,
  }, () => {
    const now = nowIso();
    const info = db.prepare(`INSERT INTO tax_items
      (filing_id, tax_year, kind, label, source_type, source_id, slip_id, amount, currency, share_pct, status, detail, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 'linked', ?, ?, ?, ?)`)
      .run(filing.id, filing.tax_year, b.kind, String(b.label).trim(), amount,
        (b.currency || 'CAD').toUpperCase(), b.share_pct == null ? 100 : Number(b.share_pct),
        JSON.stringify(detail), b.notes != null ? String(b.notes) : null, now, now);
    const item = taxItemView(db.prepare('SELECT * FROM tax_items WHERE id = ?').get(info.lastInsertRowid));
    syncRentalDeduction(filing, item);
    return { value: item, entityId: filing.id };
  });
  res.status(201).json(out);
});

app.put('/api/tax/items/:id', requireApiAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM tax_items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'item not found' });
  // A derived rental-deduction row is not editable anywhere —
  // edit the T776 in Income and the row follows (sync below).
  if (item.source_type === 'rental-deduction') {
    return res.status(400).json({ error: 'this rental deduction is derived from the T776 in Income — edit the rental item instead.' });
  }
  const b = req.body || {};
  const isSlipBacked = item.slip_id != null;
  const isSourceBacked = item.source_type != null && item.source_type !== 'manual';
  const isManual = !isSlipBacked && !isSourceBacked;
  const patch = {};
  // Amount rules by backing (the Edit form is per-form, not
  // free-form, for backed items): slip-backed amounts come from
  // the slip's boxes — edit the slip, not the amount. A
  // source-backed amount comes from its source — except a
  // capital gain, where the user confirms the gain against the
  // cost base. Manual items take an amount, unless they carry
  // T776 lines — then the lines derive it.
  if (b.amount != null) {
    if (!isFinite(Number(b.amount))) return res.status(400).json({ error: 'amount must be a number.' });
    if (isSlipBacked) return res.status(400).json({ error: 'this item is backed by a slip — edit the slip, not the amount.' });
    if (isSourceBacked && item.kind !== 'capital_gain') {
      return res.status(400).json({ error: 'this item comes from an app record — its amount is derived, not typed.' });
    }
    patch.amount = Number(b.amount);
  }
  if (b.detail !== undefined) {
    if (!isManual) return res.status(400).json({ error: 'only manual items carry an editable detail.' });
    if (b.detail == null || typeof b.detail !== 'object' || Array.isArray(b.detail)) {
      return res.status(400).json({ error: 'detail must be an object.' });
    }
    const detail = { ...b.detail };
    delete detail.derived;
    if (item.kind === 'rental' && detail.form === 'T776') {
      const filing0 = item.filing_id != null ? getTaxFiling(item.filing_id) : null;
      const regionTax = taxRegionFor(filing0);
      const region = getRegion('CA');
      const linesErr = regionTax.validT776Lines(detail.lines, region && region.rental ? region.rental.t776Lines : []);
      if (linesErr) return res.status(400).json({ error: linesErr });
      const cleaned = {};
      for (const [k, v] of Object.entries(detail.lines || {})) {
        if (v != null && v !== '') cleaned[k] = Number(v);
      }
      const totals = regionTax.t776Totals(cleaned);
      patch.detail = JSON.stringify({ form: 'T776', lines: cleaned, gross: totals.gross, deductible: totals.expenses, net: totals.net });
      patch.amount = totals.net;
    } else {
      patch.detail = JSON.stringify(detail);
    }
  }
  if (b.share_pct != null) {
    if (!validSharePct(b.share_pct)) return res.status(400).json({ error: 'share must be between 0 and 100.' });
    patch.share_pct = Number(b.share_pct);
  }
  if (b.status != null) {
    if (!TAX_ITEM_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: `status must be one of ${TAX_ITEM_STATUSES.join(', ')}.` });
    }
    patch.status = b.status;
  }
  if (b.label != null) {
    if (typeof b.label !== 'string' || !b.label.trim() || b.label.trim().length > 200) {
      return res.status(400).json({ error: 'label is required (max 200 characters).' });
    }
    patch.label = b.label.trim();
  }
  if (b.notes !== undefined) {
    if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 1000)) {
      return res.status(400).json({ error: 'notes must be text (max 1000 characters).' });
    }
    patch.notes = b.notes == null ? null : b.notes;
  }
  if (!Object.keys(patch).length) return res.json(taxItemView(item));
  if (item.filing_id != null) {
    const filing = getTaxFiling(item.filing_id);
    const person = filing ? db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id) : null;
    commitTx(req, 'tax', {
      module: 'tax', entityType: 'filing', entityId: filing.id,
      entityLabel: `${taxFilingLabel(filing, person)}`,
      summary: `Updated ${item.kind} item · ${taxFilingLabel(filing, person)}`,
    }, () => {
      applyTaxItemPatch(item.id, patch);
      // A rental edit re-syncs its Deductions row in the same
      // write (same for a share/status change on it).
      const updated = db.prepare('SELECT * FROM tax_items WHERE id = ?').get(item.id);
      if (updated && updated.kind === 'rental') syncRentalDeduction(filing, updated);
      return { value: null, entityId: filing.id };
    });
  } else {
    commitTx(req, 'tax', {
      module: 'tax', entityType: 'filing', entityId: null,
      entityLabel: `Unlinked · ${item.tax_year}`,
      summary: `Updated unlinked ${item.kind} item · ${item.tax_year}`,
      extra: { taxItemId: item.id },
    }, () => {
      applyTaxItemPatch(item.id, patch);
      return { value: null, entityId: null, extra: { taxItemId: item.id } };
    });
  }
  res.json(taxItemView(db.prepare('SELECT * FROM tax_items WHERE id = ?').get(item.id)));
});

function applyTaxItemPatch(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
  sets.push('updated_at = ?');
  vals.push(nowIso(), id);
  db.prepare(`UPDATE tax_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

app.delete('/api/tax/items/:id', requireApiAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM tax_items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'item not found' });
  if (item.source_type === 'rental-deduction') {
    return res.status(400).json({ error: 'this rental deduction is derived from the T776 in Income — delete the rental item instead.' });
  }
  if (item.filing_id != null) {
    const filing = getTaxFiling(item.filing_id);
    const person = filing ? db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id) : null;
    commitTx(req, 'tax', {
      module: 'tax', entityType: 'filing', entityId: filing.id,
      entityLabel: `${taxFilingLabel(filing, person)}`,
      summary: `Deleted ${item.kind} item · ${taxFilingLabel(filing, person)}`,
    }, () => {
      db.prepare('DELETE FROM tax_items WHERE id = ?').run(item.id);
      // Deleting a rental item removes its derived Deductions
      // row in the same write.
      if (item.kind === 'rental') {
        db.prepare("DELETE FROM tax_items WHERE filing_id = ? AND source_type = 'rental-deduction' AND source_id = ?")
          .run(filing.id, item.id);
      }
      return { value: null, entityId: filing.id };
    });
  } else {
    commitTx(req, 'tax', {
      module: 'tax', entityType: 'filing', entityId: null,
      entityLabel: `Unlinked · ${item.tax_year}`,
      summary: `Deleted unlinked ${item.kind} item · ${item.tax_year}`,
      extra: { taxItemId: item.id },
    }, () => {
      db.prepare('DELETE FROM tax_items WHERE id = ?').run(item.id);
      return { value: null, entityId: null, extra: { taxItemId: item.id } };
    });
  }
  res.json({ ok: true });
});

// ------------------------------------------------------------ tax slips --
// A slip belongs to one filing and always creates its filing
// item (kind + amount from the region's mapping). The item is
// 'linked' — the slip is the source document, and the user
// confirms the item when the numbers are checked. Editing a slip
// re-derives its item's amount while the item is still 'linked';
// a 'confirmed' item keeps the amount the user verified.
app.post('/api/tax/filings/:id/slips', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const regionTax = taxRegionFor(filing);
  const err = validTaxSlipInput(req.body || {}, regionTax);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  if (Number(b.tax_year) !== filing.tax_year) {
    return res.status(400).json({ error: 'the slip year must match the filing year.' });
  }
  const source = b.source === 'ai' ? 'ai' : 'manual';
  const itemKind = regionTax.slipToItemKind(b.kind);
  const amount = regionTax.slipAmount(b.kind, b.fields);
  const person = db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id);
  // The slip's box fields, cleaned to the kind's own fields —
  // the payer name and the stored slip both read this object.
  const fields = {};
  for (const f of regionTax.slipKindDef(b.kind).fields) {
    if (b.fields[f.key] != null && b.fields[f.key] !== '') fields[f.key] = b.fields[f.key];
  }
  // Slip → existing-item linking (user 2026-11-08): when an
  // equivalent item is already in this project, the slip links
  // to it instead of creating a second one. The match is
  // decided BEFORE anything is written — on ambiguity nothing
  // is saved and the client asks the user which item it is.
  let linkTarget = null;
  if (itemKind && amount != null) {
    const payerName = regionTax.slipPayerName(b.kind, fields);
    const filingItems = db.prepare('SELECT * FROM tax_items WHERE filing_id = ?').all(filing.id).map(taxItemView);
    const matches = findSlipLinkMatches(filingItems, itemKind, payerName);
    if (b.linkItemId != null) {
      // The user's explicit pick after an ambiguous 409: it
      // must be one of the matches, re-checked here (never
      // trusted from the client).
      linkTarget = matches.find((m) => Number(m.id) === Number(b.linkItemId)) || null;
      if (!linkTarget) {
        return res.status(400).json({ error: 'that item is not a match for this slip — pick one of the listed matches.' });
      }
    } else if (matches.length === 1) {
      linkTarget = matches[0];
    } else if (matches.length > 1) {
      return res.status(409).json({
        error: `this ${b.kind} slip matches ${matches.length} items already in this project — pick which one it belongs to.`,
        candidates: matches,
      });
    }
  }
  const out = commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: `${taxFilingLabel(filing, person)}`,
    summary: linkTarget
      ? `Linked ${b.kind} slip to ${linkTarget.label} · ${taxFilingLabel(filing, person)}`
      : `Added ${b.kind} slip · ${taxFilingLabel(filing, person)}`,
  }, () => {
    const now = nowIso();
    const slipInfo = db.prepare(`INSERT INTO tax_slips
      (filing_id, kind, tax_year, fields, source, ai_fields, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(filing.id, b.kind, Number(b.tax_year), JSON.stringify(fields), source,
        Array.isArray(b.ai_fields) ? JSON.stringify(b.ai_fields) : null, now, now);
    const slipId = slipInfo.lastInsertRowid;
    let item = null;
    let linked = false;
    let amountUpdated = false;
    let previousAmount = null;
    if (itemKind && amount != null) {
      if (linkTarget) {
        // The slip governs (user 2026-11-08 19:28): the item
        // takes the slip's figures. A changed amount is recorded
        // in the item's detail so deleting the slip restores it.
        const detail = { ...(linkTarget.detail || {}) };
        if (Number(linkTarget.amount) !== Number(amount)) {
          previousAmount = Number(linkTarget.amount);
          detail.preSlipAmount = previousAmount;
          amountUpdated = true;
        }
        db.prepare('UPDATE tax_items SET slip_id = ?, amount = ?, detail = ?, updated_at = ? WHERE id = ?')
          .run(slipId, amount, JSON.stringify(detail), now, linkTarget.id);
        item = taxItemView(db.prepare('SELECT * FROM tax_items WHERE id = ?').get(linkTarget.id));
        linked = true;
      } else {
        const info = db.prepare(`INSERT INTO tax_items
        (filing_id, tax_year, kind, label, source_type, source_id, slip_id, amount, currency, share_pct, status, detail, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'slip', ?, ?, ?, 'CAD', 100, 'linked', ?, NULL, ?, ?)`)
          .run(filing.id, filing.tax_year, itemKind, `${b.kind} — ${regionTax.slipKindDef(b.kind).label}`,
            slipId, slipId, amount, JSON.stringify({ slip_kind: b.kind }), now, now);
        item = taxItemView(db.prepare('SELECT * FROM tax_items WHERE id = ?').get(info.lastInsertRowid));
      }
    }
    return { value: { slip: taxSlipView(db.prepare('SELECT * FROM tax_slips WHERE id = ?').get(slipId)), item, linked, amountUpdated, previousAmount }, entityId: filing.id };
  });
  res.status(201).json(out);
});

app.put('/api/tax/slips/:id', requireApiAuth, (req, res) => {
  const slip = db.prepare('SELECT * FROM tax_slips WHERE id = ?').get(Number(req.params.id));
  if (!slip) return res.status(404).json({ error: 'slip not found' });
  const filing = getTaxFiling(slip.filing_id);
  const regionTax = taxRegionFor(filing);
  const b = req.body || {};
  const next = {
    kind: b.kind != null ? b.kind : slip.kind,
    tax_year: b.tax_year != null ? Number(b.tax_year) : slip.tax_year,
    fields: b.fields != null ? b.fields : JSON.parse(slip.fields || '{}'),
  };
  const err = validTaxSlipInput(next, regionTax);
  if (err) return res.status(400).json({ error: err });
  if (next.tax_year !== filing.tax_year) {
    return res.status(400).json({ error: 'the slip year must match the filing year.' });
  }
  const person = filing ? db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id) : null;
  commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: `${taxFilingLabel(filing, person)}`,
    summary: `Updated ${next.kind} slip · ${taxFilingLabel(filing, person)}`,
  }, () => {
    const fields = {};
    for (const f of regionTax.slipKindDef(next.kind).fields) {
      if (next.fields[f.key] != null && next.fields[f.key] !== '') fields[f.key] = next.fields[f.key];
    }
    db.prepare('UPDATE tax_slips SET kind = ?, tax_year = ?, fields = ?, updated_at = ? WHERE id = ?')
      .run(next.kind, next.tax_year, JSON.stringify(fields), nowIso(), slip.id);
    const item = db.prepare('SELECT * FROM tax_items WHERE slip_id = ?').get(slip.id);
    if (item && item.status === 'linked') {
      const amount = regionTax.slipAmount(next.kind, fields);
      const itemKind = regionTax.slipToItemKind(next.kind);
      if (itemKind && amount != null) {
        if (item.source_type === 'slip') {
          db.prepare('UPDATE tax_items SET kind = ?, label = ?, amount = ?, updated_at = ? WHERE id = ?')
            .run(itemKind, `${next.kind} — ${regionTax.slipKindDef(next.kind).label}`, amount, nowIso(), item.id);
        } else {
          // A pre-existing item linked to this slip keeps its own
          // label (it names the source) — only the slip's figures
          // follow the slip; the slip governs the amount.
          db.prepare('UPDATE tax_items SET kind = ?, amount = ?, updated_at = ? WHERE id = ?')
            .run(itemKind, amount, nowIso(), item.id);
        }
      }
    }
    return { value: null, entityId: filing.id };
  });
  res.json(taxSlipView(db.prepare('SELECT * FROM tax_slips WHERE id = ?').get(slip.id)));
});

app.delete('/api/tax/slips/:id', requireApiAuth, (req, res) => {
  const slip = db.prepare('SELECT * FROM tax_slips WHERE id = ?').get(Number(req.params.id));
  if (!slip) return res.status(404).json({ error: 'slip not found' });
  const filing = getTaxFiling(slip.filing_id);
  const person = filing ? db.prepare('SELECT username FROM users WHERE id = ?').get(filing.person_id) : null;
  commitTx(req, 'tax', {
    module: 'tax', entityType: 'filing', entityId: filing.id,
    entityLabel: `${taxFilingLabel(filing, person)}`,
    summary: `Deleted ${slip.kind} slip · ${taxFilingLabel(filing, person)}`,
  }, () => {
    const item = db.prepare('SELECT * FROM tax_items WHERE slip_id = ?').get(slip.id);
    if (item) {
      if (item.source_type === 'slip' && item.status === 'linked') {
        db.prepare('DELETE FROM tax_items WHERE id = ?').run(item.id);
      } else if (item.source_type === 'slip') {
        db.prepare("UPDATE tax_items SET slip_id = NULL, source_type = 'manual', source_id = NULL, updated_at = ? WHERE id = ?").run(nowIso(), item.id);
      } else {
        // The item predates the slip (a candidate or manual item
        // the slip was linked to): it stays, unlinked, with its
        // pre-slip amount restored when the link had changed it.
        let detail = {};
        try { detail = JSON.parse(item.detail || '{}'); } catch { detail = {}; }
        let amount = item.amount;
        if (isFinite(Number(detail.preSlipAmount))) {
          amount = Number(detail.preSlipAmount);
          delete detail.preSlipAmount;
        }
        db.prepare('UPDATE tax_items SET slip_id = NULL, amount = ?, detail = ?, updated_at = ? WHERE id = ?')
          .run(amount, JSON.stringify(detail), nowIso(), item.id);
      }
    }
    db.prepare('DELETE FROM tax_slips WHERE id = ?').run(slip.id);
    return { value: null, entityId: filing.id };
  });
  res.json({ ok: true });
});

// AI slip extraction: text or one attachment in, slip candidate
// out. Writes nothing — the panel applies the candidate through
// the slip POST above. Unconfigured LLM → 503, like every other
// AI fill in the app.
app.post('/api/tax/slips/fill', requireApiAuth, async (req, res) => {
  const regionTax = (getRegion('CA') || {}).tax;
  const { status, body } = await handleAiSlipFill(req.body || {}, {
    model: getAiFillModel(),
    slipKinds: regionTax.slipKinds,
  });
  if (status === 200 && req.body && req.body.model) setAiFillModel(String(req.body.model).trim());
  res.status(status).json(body);
});

// AI item extraction: one slip, receipt or rental statement in,
// one item candidate out. Writes nothing — the item modal
// applies the candidate to its editable form and only Save
// writes. A slip candidate is applied through the slip POST
// (which stores the slip and places its item); a receipt or
// T776 candidate fills the item form's fields. Unconfigured
// LLM → 503.
app.post('/api/tax/items/fill', requireApiAuth, async (req, res) => {
  const region = getRegion('CA');
  const regionTax = (region || {}).tax;
  const { status, body } = await handleAiItemFill(req.body || {}, {
    model: getAiFillModel(),
    slipKinds: regionTax.slipKinds,
    itemKinds: TAX_ITEM_KINDS,
    t776Lines: region && region.rental ? region.rental.t776Lines : [],
  });
  if (status === 200 && req.body && req.body.model) setAiFillModel(String(req.body.model).trim());
  res.status(status).json(body);
});

// --------------------------------------------------- tax RRSP benefit --
// ADDITIONAL tax saved by raising the RRSP contribution to
// `amount` on top of the person's linked contribution plans for
// the year (rrspBenefit in src/tax.js — the same code Earnings
// uses): tax with the plans' deduction minus tax with the total
// deduction. The baseline is the plans, not $0 (user 2026-11-10).
// Capped at the person's recorded remaining RRSP room when the
// Tax Profile has one; otherwise the amount is free. ESTIMATE
// ONLY — the same "Estimate — actual tax is settled on the T1."
// disclaimer Earnings carries. Not a T1 computation.
app.get('/api/tax/filings/:id/rrsp-benefit', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const amount = Number(req.query.amount);
  if (!isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a positive number.' });
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(filing.person_id);
  const region = getRegion(filing.region || 'CA') || getRegion('CA');
  const jobRows = db.prepare('SELECT * FROM earn_jobs WHERE tax_year = ? AND owner = ? ORDER BY employer')
    .all(filing.tax_year, person ? person.username : '').map(earnJobRow);
  const profile = person ? getTaxProfile(person.id) : null;
  const room = profile && profile.rrsp_room != null ? Number(profile.rrsp_room) : null;
  const effectiveAmount = room != null ? Math.min(amount, room) : amount;
  // The baseline: this person's linked RRSP plan amounts for the
  // year — same derivation as the filing detail's rrspPlanAnnual
  // (actual generated events first, projected due periods
  // otherwise — planOwnAnnual, over the CRA first-60-days window
  // for the tax year).
  const ctx = deriveTaxContext(filing.tax_year);
  const baseAmount = person
    ? round2(ctx.plans.filter((p) => p.owner === person.username).reduce((s, p) => s + (Number(p.ownAnnual) || 0), 0))
    : 0;
  const out = rrspBenefit({ jobRows, payroll: region.payroll, amount: effectiveAmount, baseAmount });
  res.json({
    ...out,
    requestedAmount: round2(amount),
    effectiveAmount: round2(effectiveAmount),
    room, capped: room != null && amount > room,
  });
});

// The T1 computation for one filing, shared by the detail
// headline + popup (GET …/refund) and the home project card
// (GET /api/tax/filings). Province = the filer's first job's
// province, else BC (the app has no residence field). Returns the
// full computeT1 output plus province — including the
// unsupported flags when a table is missing, never a guessed
// number. The caller decides whether the figure is showable:
// the home card shows it only when the project has at least one
// counted item (region countedItems — the same rule the T1 math
// uses), otherwise null.
function filingT1(filing, view) {
  const person = view.person;
  const jobRows = person
    ? db.prepare('SELECT * FROM earn_jobs WHERE tax_year = ? AND owner = ? ORDER BY employer')
      .all(filing.tax_year, person.username).map(earnJobRow)
    : [];
  const province = (jobRows[0] && jobRows[0].province) || 'BC';
  const slipKindById = new Map((view.slips || []).map((s) => [s.id, s.kind]));
  const items = (view.items || []).map((it) => ({
    ...it,
    slipKind: it.slip_id != null ? (slipKindById.get(it.slip_id) || null) : null,
  }));
  const regionTax = taxRegionFor(filing);
  const out = regionTax.computeT1({
    taxYear: filing.tax_year, province, items,
    slips: (view.slips || []).map((s) => ({ kind: s.kind, fields: s.fields || {} })),
    jobs: jobRows,
  });
  return { province, ...out };
}

// The card balance for the home project list: the same T1 figure
// as the detail headline, or null when there is nothing
// computable to show (no counted items, or an unsupported
// province/year) — the card then shows the title only, never a
// guessed $0.
function filingCardRefund(filing, view) {
  const t1 = filingT1(filing, view);
  if (t1.unsupportedProvince || t1.unsupportedYear) return null;
  const regionTax = taxRegionFor(filing);
  if (!regionTax.countedItems(view.items).length) return null;
  return { refund: t1.refund, isRefund: t1.isRefund, label: t1.label, displayAmount: t1.displayAmount };
}

// ---------------------------------------------------- tax refund ----
// The T1 computation behind the refund headline + popup (user
// 2026-11-08 16:20): one big refund/balance-owing figure at the top
// of the detail, with a line-by-line popup. Computed from the
// project's items via the region engine (computeT1 — federal +
// province modules); headline + popup only, no filing flow.
// Province = the filer's first job's province, else BC (the app
// has no residence field). A province/year with no verified table
// returns the unsupported flag, never a guessed number.
app.get('/api/tax/filings/:id/refund', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const view = taxFilingView(filing);
  const out = filingT1(filing, view);
  res.json({ filingId: filing.id, taxYear: filing.tax_year, ...out });
});

// ------------------------------------------------------- tax charts ---
// Contributed vs remaining for one person, in CAD. When a filing
// is given, the contributed side of the RRSP and RESP charts
// comes from THAT PROJECT's items (the user works the return in
// this project — adding, editing, deleting or confirming an
// RRSP or RESP item re-computes the chart at once, no reload);
// when the project has no such items yet, the app's underlying
// records are the fallback (RRSP plan buys; the RESP room
// split). TFSA has no filing items, so it always reads the
// Stocks records; CESG always reads the profile split. The
// remaining side always comes from the Tax Profile rooms. Only
// real figures: no room recorded means no remaining portion —
// never a guessed total; no contributions recorded means a zero
// contributed portion with a no-data note, never invented
// history. `basis` tells the UI which source the contributed
// figure came from ('project' | 'plans' | 'profile' | 'records').
// `asOf` (home only): { asOfYear } — the home charts for year Y
// are keyed to Y−1, so dated records are cut off at Dec 31 of
// Y−1 (taxRoomCutoff). The filing (project) charts never pass
// asOf: the in-project view is the CURRENT profile record plus
// the current project's items, with no cutoff. RESP/CESG
// contributed comes from the profile split (limit minus the
// recorded remaining room) — the app holds no dated RESP
// history, so that side is the same in both views; only the
// dated RRSP-plan and TFSA-event records move with the cutoff.
// The TFSA "Current value" stays today's market value in both
// views — it is labelled current, not a historical record.
function personTaxCharts(person, filing, asOf) {
  const username = person ? person.username : '';
  const profile = person ? getTaxProfile(person.id) : null;
  const today = vancouverToday();
  const cutoff = asOf && asOf.asOfYear ? taxRoomCutoff(asOf.asOfYear) : null;
  const fx = makeFxResolver(db);
  const toCad = (amount, currency, date) => {
    if (!currency || currency === 'CAD') return Number(amount) || 0;
    const rate = displayRate(fx, currency, 'CAD', date);
    return rate == null ? Number(amount) || 0 : (Number(amount) || 0) * rate;
  };
  const filingItems = filing
    ? db.prepare('SELECT * FROM tax_items WHERE filing_id = ?').all(filing.id)
    : [];
  // RRSP: the project's RRSP items when it has any, else the own
  // amounts on generated plan buy events for this person's jobs.
  // Projected due periods are not contributions made, so they
  // never count here.
  const rrspItems = filingItems.filter((i) => i.kind === 'rrsp' && i.status !== 'excluded');
  let rrspContributedAmt;
  let rrspBasis;
  if (rrspItems.length) {
    rrspContributedAmt = round2(rrspItems.reduce((s, i) => s + effectiveAmount(i), 0));
    rrspBasis = 'project';
  } else {
    const rrspRows = db.prepare(`
      SELECT e.own_amount AS own_amount, a.default_currency AS currency, e.date AS date
      FROM invest_events e
      JOIN invest_plans p ON p.id = e.plan_id
      JOIN invest_accounts a ON a.id = p.account_id
      JOIN earn_jobs j ON j.id = p.job_id
      WHERE a.type = 'RRSP' AND e.type = 'buy' AND j.owner = ?`).all(username);
    rrspContributedAmt = round2(throughDate(rrspRows, cutoff).reduce((s, r) => s + toCad(r.own_amount || 0, r.currency, r.date), 0));
    rrspBasis = 'plans';
  }
  // TFSA: net buy-minus-sell across the person's TFSA accounts
  // (cost basis, not market value), plus the accounts' current
  // value from the Stocks engine.
  const tfsaAccounts = db.prepare("SELECT * FROM invest_accounts WHERE type = 'TFSA'").all()
    .filter((a) => parseOwners(a.owners).includes(username));
  let tfsaEvents = [];
  let tfsaValue = 0;
  if (tfsaAccounts.length) {
    const ids = tfsaAccounts.map((a) => a.id);
    tfsaEvents = db.prepare(`
      SELECT e.*, h.currency AS currency FROM invest_events e
      JOIN invest_holdings h ON h.id = e.holding_id
      WHERE h.account_id IN (${ids.map(() => '?').join(',')}) AND e.type IN ('buy', 'sell')`).all(...ids);
    for (const a of tfsaAccounts) {
      const computed = computeAccount(db, a, fx, today, 'CAD');
      tfsaValue = round2(tfsaValue + (computed.summary ? computed.summary.value : 0));
    }
  }
  const tfsaContributedAmt = round2(throughDate(tfsaEvents, cutoff).reduce((s, e) => {
    const v = toCad((Number(e.units) || 0) * (Number(e.price) || 0), e.currency, e.date);
    return s + (e.type === 'buy' ? v : -v);
  }, 0));
  const tfsaNet = Math.max(0, tfsaContributedAmt);
  // RESP: the project's RESP items when it has any, else the
  // profile's remaining room split against the verified $50,000
  // lifetime limit; CESG earned vs the $7,200 lifetime maximum.
  const respItems = filingItems.filter((i) => i.kind === 'resp' && i.status !== 'excluded');
  let respSplit = respRoomSplit(profile ? profile.resp_room : null);
  let respBasis = 'profile';
  if (respItems.length) {
    respSplit = {
      contributed: round2(respItems.reduce((s, i) => s + effectiveAmount(i), 0)),
      remaining: profile && profile.resp_room != null ? Number(profile.resp_room) : null,
      limit: RESP_LIFETIME_LIMIT,
    };
    respBasis = 'project';
  }
  return {
    // The year the dated records are cut off at (home only,
    // Y−1); null on the project view, which has no cutoff.
    asOfYear: asOf && asOf.asOfYear ? Number(asOf.asOfYear) : null,
    rrsp: {
      contributed: rrspContributedAmt,
      room: profile && profile.rrsp_room != null ? Number(profile.rrsp_room) : null,
      asOf: profile ? profile.as_of_date : null,
      basis: rrspBasis,
    },
    tfsa: {
      contributed: tfsaNet,
      room: profile && profile.tfsa_room != null ? Number(profile.tfsa_room) : null,
      asOf: profile ? profile.as_of_date : null,
      currentValue: tfsaValue,
      basis: 'records',
    },
    resp: {
      beneficiary: profile ? profile.resp_beneficiary : null,
      subscriber: profile ? profile.resp_subscriber : null,
      split: respSplit,
      cesg: cesgRoomSplit(profile ? profile.cesg_room : null),
      asOf: profile ? profile.as_of_date : null,
      basis: respBasis,
    },
  };
}

app.get('/api/tax/filings/:id/charts', requireApiAuth, (req, res) => {
  const filing = getTaxFiling(req.params.id);
  if (!filing) return res.status(404).json({ error: 'filing not found' });
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(filing.person_id);
  res.json(personTaxCharts(person, filing));
});

// The same contributed-vs-remaining charts for one person
// WITHOUT a project (the Tax home switcher): the contributed
// side reads the app's underlying records / the profile split,
// since there is no project to draw items from. Keyed to the
// requested year Y, the charts show year Y−1's records
// (asOfYear = Y − 1) — the 2026 view reads 2025 records, the
// 2025 view reads 2024 records. No year given defaults to the
// current tax year.
app.get('/api/tax/profiles/:personId/charts', requireApiAuth, (req, res) => {
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.personId));
  if (!person || person.username === adminUsername()) {
    return res.status(400).json({ error: 'person must be a household user (not admin).' });
  }
  const yearParam = Number.parseInt(req.query.year, 10);
  const year = Number.isFinite(yearParam) ? yearParam : Number(vancouverToday().slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return res.status(400).json({ error: 'year must be a tax year (1900–2100).' });
  }
  res.json(personTaxCharts(person, null, { asOfYear: year - 1 }));
});

// ----------------------------------------------------- tax profiles ---
// One profile per person: remaining contribution room
// (RRSP / TFSA / RESP), user-entered from the CRA Notice of
// Assessment / My Account, editable, with an as-of date. The
// app cannot fetch CRA data — a blank figure means "not
// recorded", never zero, and no figure is ever estimated.
app.get('/api/tax/profiles', requireApiAuth, (req, res) => {
  res.json({
    profiles: taxFilers().map((u) => ({
      person: { id: u.id, username: u.username },
      profile: getTaxProfile(u.id),
    })),
  });
});

app.get('/api/tax/profiles/:personId', requireApiAuth, (req, res) => {
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.personId));
  if (!person || person.username === adminUsername()) {
    return res.status(400).json({ error: 'person must be a household user (not admin).' });
  }
  res.json({ person: { id: person.id, username: person.username }, profile: getTaxProfile(person.id) });
});

app.put('/api/tax/profiles/:personId', requireApiAuth, (req, res) => {
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.personId));
  if (!person || person.username === adminUsername()) {
    return res.status(400).json({ error: 'person must be a household user (not admin).' });
  }
  const b = req.body || {};
  // Blank inputs arrive as '' — normalise to null (not
  // recorded), never to zero.
  const norm = (v) => (v === '' || v == null ? null : Number(v));
  const body = {
    rrsp_room: norm(b.rrsp_room),
    tfsa_room: norm(b.tfsa_room),
    resp_room: norm(b.resp_room),
    cesg_room: norm(b.cesg_room),
    resp_beneficiary: b.resp_beneficiary === '' ? null : (b.resp_beneficiary != null ? String(b.resp_beneficiary).trim() || null : null),
    resp_subscriber: b.resp_subscriber === '' ? null : (b.resp_subscriber != null ? String(b.resp_subscriber).trim() || null : null),
    as_of_date: b.as_of_date === '' ? null : (b.as_of_date != null ? String(b.as_of_date) : null),
    notes: b.notes === '' ? null : (b.notes != null ? String(b.notes) : null),
  };
  const err = validTaxProfileInput(body);
  if (err) return res.status(400).json({ error: err });
  const out = commitTx(req, 'tax-profile', {
    module: 'tax-profile', entityType: 'profile', entityId: person.id,
    entityLabel: `${person.username} · contribution room`,
    summary: `Updated contribution room · ${person.username}`,
  }, () => {
    const now = nowIso();
    const existing = getTaxProfile(person.id);
    if (existing) {
      db.prepare(`UPDATE tax_profiles SET rrsp_room = ?, tfsa_room = ?, resp_beneficiary = ?, resp_subscriber = ?,
        resp_room = ?, cesg_room = ?, as_of_date = ?, notes = ?, updated_at = ? WHERE person_id = ?`)
        .run(body.rrsp_room, body.tfsa_room, body.resp_beneficiary, body.resp_subscriber,
          body.resp_room, body.cesg_room, body.as_of_date, body.notes, now, person.id);
    } else {
      db.prepare(`INSERT INTO tax_profiles
        (person_id, rrsp_room, tfsa_room, resp_beneficiary, resp_subscriber, resp_room, cesg_room, as_of_date, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(person.id, body.rrsp_room, body.tfsa_room, body.resp_beneficiary, body.resp_subscriber,
          body.resp_room, body.cesg_room, body.as_of_date, body.notes, now, now);
    }
    return { value: getTaxProfile(person.id), entityId: person.id };
  });
  res.json({ person: { id: person.id, username: person.username }, profile: out });
});

// AI room extraction from a Notice of Assessment / My Account
// summary: candidates out, writes nothing — the profile form
// applies them. Unconfigured LLM → 503.
app.post('/api/tax/profiles/fill', requireApiAuth, async (req, res) => {
  const { status, body } = await handleAiProfileFill(req.body || {}, {
    model: getAiFillModel(),
  });
  if (status === 200 && req.body && req.body.model) setAiFillModel(String(req.body.model).trim());
  res.status(status).json(body);
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
// Distinct categories already used in stored transactions, for the
// transaction form's combobox (presets + used customs, merged client-side).
function listSpendCategories() {
  return db.prepare(
    `SELECT DISTINCT category FROM spend_transactions
     WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category`).all()
    .map((r) => r.category);
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
  // Credit limit is optional: blank stays NULL, a figure must be
  // a positive number.
  let creditLimit = null;
  if (b && b.credit_limit != null && String(b.credit_limit).trim() !== '') {
    creditLimit = Number(b.credit_limit);
    if (!Number.isFinite(creditLimit) || creditLimit <= 0) return { error: 'Credit limit must be a positive number.' };
  }
  return { name, issuer: issuer || null, last4, credit_limit: creditLimit };
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
  res.json({ cards, transactions, monthly: spendMonthly(transactions), categories: listSpendCategories() });
});
app.post('/api/spending/cards', requireApiAuth, (req, res) => {
  const v = validSpendCardInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const card = commitTx(req, 'card', {
    module: 'spending', entityType: 'card', entityId: null,
    entityLabel: v.name, summary: `Added card ${v.name}`,
  }, () => {
    const ts = nowIso();
    const info = db.prepare('INSERT INTO spend_cards (name, issuer, last4, credit_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(v.name, v.issuer, v.last4, v.credit_limit, ts, ts);
    return { value: spendCardView(getSpendCard(info.lastInsertRowid)), entityId: info.lastInsertRowid };
  });
  res.status(201).json(card);
});
app.put('/api/spending/cards/:id', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const v = validSpendCardInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const updated = commitTx(req, 'card', {
    module: 'spending', entityType: 'card', entityId: card.id,
    entityLabel: v.name, summary: `Updated card ${v.name}`,
  }, () => {
    db.prepare('UPDATE spend_cards SET name = ?, issuer = ?, last4 = ?, credit_limit = ?, updated_at = ? WHERE id = ?')
      .run(v.name, v.issuer, v.last4, v.credit_limit, nowIso(), card.id);
    return { value: spendCardView(getSpendCard(card.id)), entityId: card.id };
  });
  res.json(updated);
});
app.delete('/api/spending/cards/:id', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  commitTx(req, 'card', {
    module: 'spending', entityType: 'card', entityId: card.id,
    entityLabel: card.name, summary: `Deleted card ${card.name}`,
  }, () => {
    db.prepare('DELETE FROM spend_cards WHERE id = ?').run(Number(req.params.id));
    return { value: { ok: true }, entityId: card.id };
  });
  res.json({ ok: true });
});
app.get('/api/spending/cards/:id', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const transactions = listSpendTx(card.id);
  res.json({ card: spendCardView(card), transactions, monthly: spendMonthly(transactions), categories: listSpendCategories() });
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
  const kind = b.type === 'payment' ? 'payment' : 'charge';
  const category = b.category != null ? String(b.category).trim() : '';
  const row = commitTx(req, 'card', {
    module: 'spending', entityType: 'card', entityId: card.id,
    entityLabel: card.name, summary: `Added transaction · ${card.name}`,
  }, () => {
    const info = db.prepare(
      `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'manual', ?, ?)`).run(
      card.id, b.date, merchant, b.memo != null ? String(b.memo) : null, category || null, amount, kind, nowIso());
    return { value: db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(info.lastInsertRowid), entityId: card.id };
  });
  res.status(201).json(row);
});
app.put('/api/spending/transactions/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'transaction not found' });
  const b = req.body || {};
  const merchant = b.merchant != null ? String(b.merchant).trim() : row.merchant;
  if (!merchant) return res.status(400).json({ error: 'merchant is required.' });
  const category = b.category != null ? String(b.category).trim() : row.category;
  const card = getSpendCard(row.card_id);
  const updated = commitTx(req, 'card', {
    module: 'spending', entityType: 'card', entityId: row.card_id,
    entityLabel: card ? card.name : null, summary: `Updated transaction · ${card ? card.name : ''}`,
  }, () => {
    db.prepare('UPDATE spend_transactions SET merchant = ?, memo = ?, category = ? WHERE id = ?')
      .run(merchant, b.memo != null ? String(b.memo) : row.memo, category || null, row.id);
    return { value: db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(row.id), entityId: row.card_id };
  });
  res.json(updated);
});
app.delete('/api/spending/transactions/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM spend_transactions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'transaction not found' });
  const card = getSpendCard(row.card_id);
  commitTx(req, 'card', {
    module: 'spending', entityType: 'card', entityId: row.card_id,
    entityLabel: card ? card.name : null, summary: `Deleted transaction · ${card ? card.name : ''}`,
  }, () => {
    db.prepare('DELETE FROM spend_transactions WHERE id = ?').run(Number(req.params.id));
    return { value: { ok: true }, entityId: row.card_id };
  });
  res.json({ ok: true });
});
// QFX import, step 1: parse writes nothing. Rows already on the card
// are flagged existing so the preview can show what Apply will skip.
// When the file carries a ledger balance, the preview also carries
// the balance check: the file's owed figure against the owed figure
// computed from stored rows plus the new rows this import would
// insert (adjustments included). A mismatch is normal on a first
// import — the file covers only its window, so the difference is
// the pre-window owed — and the preview proposes exactly one
// adjustment row for it; the prompt precedes any write.
app.post('/api/spending/cards/:id/import-qfx/parse', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const text = req.body && typeof req.body.qfxText === 'string' ? req.body.qfxText : '';
  if (!text.trim()) return res.status(400).json({ error: 'Choose a QFX file to parse.' });
  const parsed = parseQfx(text);
  const existing = new Set(listSpendTx(card.id).map((t) => t.fitid).filter(Boolean));
  let balanceCheck = null;
  if (parsed.balance) {
    // The check is framed post-import: the new rows are what Apply
    // will insert, so the computed figure includes them and the
    // proposed adjustment equals minus the difference exactly —
    // the preview number is the number Apply will write. On a
    // first import the difference is the pre-window owed.
    const newRows = parsed.rows.filter((r) => !existing.has(r.fitid));
    const computedOwed = spendBalance([...listSpendTx(card.id), ...newRows]);
    const difference = Math.round((parsed.balance.owed - computedOwed) * 100) / 100;
    balanceCheck = {
      fileOwed: parsed.balance.owed,
      asof: parsed.balance.asof,
      computedOwed,
      difference,
      adjustmentAmount: Math.round((computedOwed - parsed.balance.owed) * 100) / 100,
    };
  }
  res.json({
    accountId: parsed.accountId,
    balance: parsed.balance,
    balanceCheck,
    rows: parsed.rows.map((r) => ({ ...r, existing: existing.has(r.fitid) })),
    dropped: parsed.dropped,
  });
});
// QFX import, step 2: one atomic transaction. Rows are re-validated
// here — the preview is client state, never trusted. When the
// client passes the file balance, the card's stored balance is
// refreshed from it; when it also confirms the adjustment, the
// server recomputes the adjustment from stored rows + the new
// rows (never trusting a client amount) and inserts exactly one
// adjustment row when the recomputed figure is non-zero. The
// adjustment is kind 'adjustment': excluded from spending totals,
// included in the balance computation.
app.post('/api/spending/cards/:id/import-qfx/apply', requireApiAuth, (req, res) => {
  const card = getSpendCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'card not found' });
  const existing = new Set(listSpendTx(card.id).map((t) => t.fitid).filter(Boolean));
  const v = validateSpendApply((req.body || {}).rows, existing);
  const b = req.body || {};
  const fileOwed = Number(b.fileOwed);
  const hasFileBalance = Number.isFinite(fileOwed);
  const balanceAsof = validSpendDate(b.balanceAsof) ? b.balanceAsof : null;
  const ts = nowIso();
  let adjustment = null;
  const before = snapshotByAggregate(db, 'card', card.id);
  try {
    db.transaction(() => {
      const ins = db.prepare(
        `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'qfx', ?, ?)`);
      for (const r of v.valid) ins.run(card.id, r.date, r.merchant, r.memo, null, r.amount, r.fitid, r.kind, ts);
      if (hasFileBalance) {
        db.prepare('UPDATE spend_cards SET balance_owed = ?, balance_asof = ?, updated_at = ? WHERE id = ?')
          .run(fileOwed, balanceAsof, ts, card.id);
        if (b.includeAdjustment) {
          const postOwed = spendBalance(listSpendTx(card.id));
          const adj = Math.round((postOwed - fileOwed) * 100) / 100;
          if (adj !== 0) {
            db.prepare(
              `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, kind, created_at)
               VALUES (?, ?, 'Balance adjustment', NULL, NULL, ?, NULL, 'qfx', 'adjustment', ?)`)
              .run(card.id, balanceAsof || ts.slice(0, 10), adj, ts);
            adjustment = { amount: adj };
          }
        }
      }
      // One import Apply = one commit, however many rows it wrote.
      recordCommit(db, {
        userId: req.user.id, username: req.user.username, module: 'spending',
        entityType: 'card', entityId: card.id, entityLabel: card.name,
        summary: `Imported QFX · ${card.name} (${v.valid.length} transactions)`,
        before, snapshot: snapshotByAggregate(db, 'card', card.id),
      });
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json({
    inserted: v.valid.length, skipped: v.skipped.length, dropped: v.dropped,
    adjustment,
    balance: hasFileBalance ? { owed: fileOwed, asof: balanceAsof } : null,
  });
});
// AI category analysis (SPENDING-GLOBAL): one pass over ALL
// existing uncategorized transactions across ALL cards. Merchants
// with no remembered mapping get an AI proposal; merchants WITH a
// remembered mapping come back as remembered proposals (no LLM
// call needed) so the run still covers them. Writes nothing —
// Apply saves the mappings and categorizes. Each proposal carries
// its transactions so the preview can group by category and let
// each row's category be edited before Apply.
app.post('/api/spending/ai-categories', requireApiAuth, async (req, res) => {
  const mappings = spendMerchantMappings(req.user.id);
  const cards = new Map(listSpendCards().map((c) => [c.id, c.name]));
  const uncategorized = listAllSpendTx().filter((t) => !(t.category || '').trim());
  const byMerchant = new Map();
  for (const t of uncategorized) {
    const key = normalizeMerchant(t.merchant);
    if (!key) continue;
    const entry = byMerchant.get(key) || { merchant: t.merchant, txCount: 0, transactions: [] };
    entry.txCount += 1;
    entry.transactions.push({ id: t.id, date: t.date, merchant: t.merchant, cardId: t.card_id, cardName: cards.get(t.card_id) || 'Card', amount: t.amount });
    byMerchant.set(key, entry);
  }
  const proposals = [];
  const unmapped = [];
  for (const [key, entry] of byMerchant) {
    if (mappings[key]) proposals.push({ merchant: entry.merchant, category: mappings[key], txCount: entry.txCount, source: 'remembered', transactions: entry.transactions });
    else unmapped.push(entry);
  }
  if (unmapped.length) {
    if (!llmConfigured()) return res.status(503).json({ error: SPEND_AI_UNCONFIGURED });
    const prompt = `Assign each merchant one category from this list: ${SPEND_CATEGORIES.join(', ')}.
Reply with ONLY this JSON, no other text: {"proposals": [{"merchant": "<merchant as given>", "category": "<one of the list>"}]}.
Merchants: ${JSON.stringify(unmapped.map((m) => m.merchant))}`;
    let raw;
    try {
      raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
    } catch {
      return res.status(502).json({ error: 'The AI service could not complete the analysis.' });
    }
    const parsed = parseModelJson(raw);
    if (parsed && Array.isArray(parsed.proposals)) {
      for (const p of parsed.proposals) {
        if (!p || typeof p.merchant !== 'string') continue;
        const key = normalizeMerchant(p.merchant);
        const entry = byMerchant.get(key);
        if (!entry || mappings[key] || !SPEND_CATEGORIES.includes(p.category)) continue;
        proposals.push({ merchant: entry.merchant, category: p.category, txCount: entry.txCount, source: 'ai', transactions: entry.transactions });
      }
    }
  }
  res.json({ proposals });
});
app.post('/api/spending/ai-categories/apply', requireApiAuth, (req, res) => {
  const proposals = Array.isArray((req.body || {}).proposals) ? req.body.proposals : [];
  const overrides = Array.isArray((req.body || {}).overrides) ? req.body.overrides : [];
  const mappings = spendMerchantMappings(req.user.id);
  // A per-transaction override changes ONLY that row: it never
  // writes or rewrites a merchant mapping, and it wins over the
  // merchant bulk update below.
  const overrideById = new Map();
  for (const o of overrides) {
    if (!o || !Number.isFinite(Number(o.txId)) || !SPEND_CATEGORIES.includes(o.category)) continue;
    overrideById.set(Number(o.txId), o.category);
  }
  let updated = 0;
  db.transaction(() => {
    // The touched set is fixed before any write: the uncategorized
    // rows each proposal's merchant would claim, plus every
    // override row. The before snapshot reads these rows (and the
    // mappings preference) pre-update; the after snapshot reads
    // the same set post-update.
    const uncategorized = db.prepare("SELECT id, merchant FROM spend_transactions WHERE category IS NULL OR category = ''").all();
    const touchedIds = new Set();
    for (const p of proposals) {
      if (!p || typeof p.merchant !== 'string' || !SPEND_CATEGORIES.includes(p.category)) continue;
      const key = normalizeMerchant(p.merchant);
      for (const r of uncategorized) {
        if (normalizeMerchant(r.merchant) === key && !overrideById.has(r.id)) touchedIds.add(r.id);
      }
    }
    for (const txId of overrideById.keys()) touchedIds.add(txId);
    const extra = { txIds: [...touchedIds], userId: req.user.id };
    const before = snapshotByAggregate(db, 'spending-global', null, extra);
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
        if (normalizeMerchant(r.merchant) === key && !overrideById.has(r.id)) {
          updated += db.prepare('UPDATE spend_transactions SET category = ? WHERE id = ?').run(p.category, r.id).changes;
        }
      }
    }
    for (const [txId, category] of overrideById) {
      updated += db.prepare('UPDATE spend_transactions SET category = ? WHERE id = ?').run(category, txId).changes;
    }
    // One analysis Apply = one commit, across all cards.
    recordCommit(db, {
      userId: req.user.id, username: req.user.username, module: 'spending',
      entityType: 'spending-global', entityId: null, entityLabel: 'All cards',
      summary: `Applied category analysis (${updated} transactions)`,
      before, snapshot: snapshotByAggregate(db, 'spending-global', null, extra),
    });
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
  const before = snapshotByAggregate(db, 'card', card.id);
  db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO spend_transactions (card_id, date, merchant, memo, category, amount, fitid, source, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'ai', 'charge', ?)`);
    for (const r of valid) ins.run(card.id, r.date, r.merchant, r.memo, r.category, r.amount, ts);
    recordCommit(db, {
      userId: req.user.id, username: req.user.username, module: 'spending',
      entityType: 'card', entityId: card.id, entityLabel: card.name,
      summary: `Applied Fill with AI · ${card.name} (${valid.length} transactions)`,
      before, snapshot: snapshotByAggregate(db, 'card', card.id),
    });
  })();
  res.status(201).json({ inserted: valid.length, dropped });
});

// ---------------------------------------------------------------- summary ---
// Overview asset-composition chart: Property + Stock history.
// Read-only aggregation for the Overview panel only — it changes
// no other endpoint's contract and never feeds net worth (stocks
// stay OUT of /api/summary; this chart is a composition view).
//   propertyByMonth: monthly EQUITY (assessed minus outstanding
//     principal), one point per month from January of the first
//     assessed year through the current month. A property counts
//     from its first known year on (same carry-forward rule as
//     /api/properties/portfolio); a property with a stored
//     assessed value but no history points contributes that one
//     point. Outstanding follows the detail page exactly: the
//     projection's balance at the month (remainingBalanceAt),
//     the anchor when the mortgage cannot project, 0 with no
//     mortgage — so a mortgage-free property contributes its
//     assessed value. No BCA fetch here: assessed points come
//     from stored history; prime refreshes under the same day
//     gate as every other computation entry, since projections
//     price variable segments off the prime history.
//   stockSeries: the Stocks engine's portfolio month-end series
//     in CAD (the /api/investments pipeline, display pinned CAD).
app.get('/api/overview/chart', requireApiAuth, async (req, res) => {
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  await ensureFreshPrime();
  const cur = currentMonthKey();
  const props = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const perProperty = props.map((p) => {
    let points = historyPoints(p.id).map((pt) => ({ year: pt.year, value: pt.value }));
    if (!points.length && p.assessed_value != null && p.assessed_year) {
      points = [{ year: p.assessed_year, value: p.assessed_value }];
    }
    if (!points.length) return null;
    const proj = projectionFor(p);
    return {
      firstYear: points[0].year,
      assessedInForce: (year) => {
        let v = null;
        for (const pt of points) { if (pt.year <= year) v = pt.value; else break; }
        return v;
      },
      outstandingAt: (month) => {
        if (!proj) return p.mortgage_balance ?? 0;
        return remainingBalanceAt(proj.series, month, p.mortgage_balance ?? null, proj.payoffMonth).balance ?? 0;
      },
    };
  }).filter(Boolean);
  const propertyByMonth = [];
  if (perProperty.length) {
    const nextMonth = (m) => {
      const y = Number(m.slice(0, 4)); const mo = Number(m.slice(5, 7));
      return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    };
    let m = `${Math.min(...perProperty.map((x) => x.firstYear))}-01`;
    let guard = 0;
    while (m <= cur && guard < 1200) {
      const y = Number(m.slice(0, 4));
      let total = 0;
      for (const pp of perProperty) {
        if (pp.firstYear > y) continue;
        const av = pp.assessedInForce(y);
        if (av === null) continue;
        total += av - pp.outstandingAt(m);
      }
      propertyByMonth.push({ month: m, value: r2(total) });
      m = nextMonth(m);
      guard++;
    }
  }
  const holdings = listHoldings(db);
  const fx = await prepareInvestScope(holdings, 'CAD');
  const p = computePortfolio(db, fx, vancouverToday(), 'CAD');
  res.json({
    propertyByMonth,
    stockSeries: p.series.map((s) => ({ month: s.month, value: s.value })),
    currentMonth: currentMonthKey(),
    fxMissing: fx.missing,
    hasUsdHoldings: holdings.some((h) => h.currency === 'USD'),
  });
});

// ------------------------------------------------------------ Home page --
// The Home page (#home) is insight cards + a payment highlight. It
// reuses the series the app already builds: the overview chart's
// property equity series, the portfolio series, the earnings monthly
// chart and the spending monthly totals. Nothing here writes to any
// other module; marks and generated cards live in their own tables
// (home_insights, income_marks) and generation is a recompute, not
// a Global History commit.
const homeR2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Assemble every series buildStandardInsights needs, plus the
// per-entity series resolveHomeMetric needs and the job/rental lists
// Payment dates of ONE mortgage in ONE month, on the projection's
// own grid (the same governing-term + mortgageMonthPaymentDates
// computation the highlight uses). Returns { dates, row, gov, freq }:
// dates are the payment dates in the month, capped to [from, to];
// row/gov/freq are the projection row, the term governing the month,
// and its frequency, for the amount derivation (collectHomeData uses
// them; the calendar only needs dates).
function mortgageMonthInfo(p, proj, terms, month, from, to) {
  const row = (proj.series || []).find((r) => r.month === month);
  if (!row) return { dates: [], row: null, gov: null, freq: 'monthly' };
  let gov = null;
  for (const t of terms || []) { if (String(t.start_date).slice(0, 7) <= month) gov = t; }
  gov = gov || (terms && terms[0]) || null;
  const freq = gov && FREQUENCY_KEYS.includes(gov.payment_frequency) ? gov.payment_frequency
    : (FREQUENCY_KEYS.includes(p.payment_frequency) ? p.payment_frequency : 'monthly');
  const anchorDay = gov && gov.payment_day != null ? gov.payment_day : (p.payment_day ?? null);
  const dates = mortgageMonthPaymentDates({
    frequency: freq, anchorDay, rowDate: row.date, month,
    from, to, earliest: p.mortgage_balance_date,
  });
  return { dates, row, gov, freq };
}

// homeHighlightRows needs.
async function collectHomeData() {
  const today = vancouverToday();
  const cur = currentMonthKey();
  await ensureFreshPrime();

  // Property: monthly totals + per-property series, same
  // construction as GET /api/overview/chart (assessed in force −
  // outstanding at month-end).
  const props = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const projById = new Map(); // property id -> projectionFor result (shared by the equity series + the mortgage highlight)
  const perProperty = props.map((p) => {
    let points = historyPoints(p.id).map((pt) => ({ year: pt.year, value: pt.value }));
    if (!points.length && p.assessed_value != null && p.assessed_year) {
      points = [{ year: p.assessed_year, value: p.assessed_value }];
    }
    if (!points.length) return null;
    const proj = projectionFor(p);
    projById.set(p.id, proj);
    return {
      id: p.id,
      label: p.address,
      firstYear: points[0].year,
      assessedInForce: (year) => {
        let v = null;
        for (const pt of points) { if (pt.year <= year) v = pt.value; else break; }
        return v;
      },
      outstandingAt: (month) => {
        if (!proj) return p.mortgage_balance ?? 0;
        return remainingBalanceAt(proj.series, month, p.mortgage_balance ?? null, proj.payoffMonth).balance ?? 0;
      },
    };
  }).filter(Boolean);
  const propertyMonths = [];
  const propertyById = {};
  const propertyLabels = {};
  if (perProperty.length) {
    let m = `${Math.min(...perProperty.map((x) => x.firstYear))}-01`;
    let guard = 0;
    while (m <= cur && guard < 1200) {
      const y = Number(m.slice(0, 4));
      let equity = 0; let assessed = 0; let outstanding = 0;
      for (const pp of perProperty) {
        if (pp.firstYear > y) continue;
        const av = pp.assessedInForce(y);
        if (av === null) continue;
        const ob = pp.outstandingAt(m);
        assessed += av; outstanding += ob; equity += av - ob;
      }
      propertyMonths.push({ month: m, equity: homeR2(equity), assessed: homeR2(assessed), outstanding: homeR2(outstanding) });
      m = homeNextMonth(m); guard++;
    }
    for (const pp of perProperty) {
      const series = [];
      let m2 = `${pp.firstYear}-01`;
      let g2 = 0;
      while (m2 <= cur && g2 < 1200) {
        const y2 = Number(m2.slice(0, 4));
        const av = pp.assessedInForce(y2);
        if (av !== null) {
          const ob = pp.outstandingAt(m2);
          series.push({ month: m2, equity: homeR2(av - ob), assessed: homeR2(av), outstanding: homeR2(ob) });
        }
        m2 = homeNextMonth(m2); g2++;
      }
      propertyById[pp.id] = series;
      propertyLabels[pp.id] = String(pp.label).split(',')[0];
    }
  }

  // Stocks: portfolio series (value + cumulative gain) and the top
  // gainer by trailing-12-month return among holdings with value.
  const holdings = listHoldings(db);
  const fx = await prepareInvestScope(holdings, 'CAD');
  const pf = computePortfolio(db, fx, today, 'CAD');
  const stockMonths = pf.series.map((s) => ({ month: s.month, value: s.value, gain: s.returnAmount }));
  let topGainer = null;
  const holdingById = {};
  for (const h of holdings) {
    const computed = computeHolding(db, h, fx, today, 'CAD');
    const months = computed.series.map((s) => ({ month: s.month, value: s.value, gain: s.returnAmount }));
    holdingById[h.id] = { label: h.symbol || h.name || `#${h.id}`, months };
    const value = computed.summary.value;
    if (!(value > 0)) continue;
    const pts = listPricePoints(db, h.id);
    const rate = currentReturnRateFromPoints(pts, cur);
    if (!rate) continue;
    if (!topGainer || rate.ratePct > topGainer.returnPct) {
      topGainer = {
        label: h.symbol || h.name || `#${h.id}`, returnPct: rate.ratePct,
        points: pts.map((p) => ({ date: String(p.date).slice(0, 10), price: Number(p.price) })),
        valueSeries: months,
      };
    }
  }

  // Accounts: per-account + per-type monthly series, from the same
  // account-level engine the account pages use (computePortfolio
  // already computes every account — no extra engine work). An
  // account with no priced holdings has an empty series; its value
  // is honestly $0, so it anchors a single current-month $0 row
  // instead of reading as "no data" — the account exists, it just
  // holds nothing valued yet. The same $0 anchor covers a type whose
  // accounts are all empty.
  const accountById = {};
  const accountTypeById = {};
  const accountLabels = [];
  {
    const byType = new Map();
    for (const a of pf.accounts) {
      const row = a.account;
      const name = String(row.name || '').trim();
      const inst = String(row.institution || '').trim();
      const label = (inst && !name.toLowerCase().includes(inst.toLowerCase())) ? `${inst} ${name}` : (name || `#${row.id}`);
      let months = (a.series || []).map((s) => ({ month: s.month, value: homeR2(s.value), gain: homeR2(s.returnAmount) }));
      if (!months.length) months = [{ month: cur, value: 0, gain: 0 }];
      accountById[row.id] = { label, type: row.type, months };
      accountLabels.push({ id: row.id, label, type: row.type });
      const agg = byType.get(row.type) || new Map();
      for (const m of months) {
        const slot = agg.get(m.month) || { month: m.month, value: 0, gain: 0 };
        slot.value = homeR2(slot.value + m.value);
        slot.gain = homeR2(slot.gain + m.gain);
        agg.set(m.month, slot);
      }
      byType.set(row.type, agg);
    }
    for (const [type, agg] of byType) {
      const months = [...agg.values()].sort((x, y) => x.month.localeCompare(y.month));
      accountTypeById[type] = { label: `${type} accounts`, months: months.length ? months : [{ month: cur, value: 0, gain: 0 }] };
    }
  }

  // Earnings: salary take-home (cash) per month from the job
  // monthly chart, rental income per month from entries.
  const salaryByMonth = new Map();
  const jobsForHighlight = [];
  const jobById = {};
  const jobPeriodById = {};
  for (const row of db.prepare('SELECT * FROM earn_jobs ORDER BY id').all()) {
    const job = earnJobRow(row);
    const gross = job.calc.perPeriod.gross;
    const rawPlans = db.prepare('SELECT * FROM invest_plans WHERE job_id = ?').all(row.id);
    const plans = rawPlans
      .map((p) => ({ start_date: p.start_date, own_amount: planPeriodAmounts(p, gross).own, employer_amount: planPeriodAmounts(p, gross).employer }));
    const series = jobMonthlySeries({
      frequency: row.frequency, startDate: row.start_date, recentDate: row.recent_pay_date,
      calc: job.calc, plans, today, job, payroll: earnRegion().payroll,
    });
    if (series) {
      // Displayed cash, not engine net: the series' net still
      // carries the deferred RRSP tax benefit (see
      // displayedSalaryMonths). This feeds both the earnings series
      // 'salary' field and the per-job jobById series, so the
      // Salary take-home card and the job_takehome:<id> AI card both
      // show cash. The monthly chart's Net segment is untouched.
      const months = displayedSalaryMonths(series, job.taxBenefit ? job.taxBenefit.perPeriod : 0);
      for (const { month, salary } of months) {
        salaryByMonth.set(month, homeR2((salaryByMonth.get(month) || 0) + salary));
      }
      jobById[row.id] = { label: row.employer, months };
    }
    // Per-period take-home: the last 12 paydays' displayed cash, each
    // priced from the job's own records (see jobTakehomePeriods).
    const periods = jobTakehomePeriods({ job, plans: rawPlans, payroll: earnRegion().payroll, today });
    if (periods.length) jobPeriodById[row.id] = { label: row.employer, periods };
    // Displayed per-period take-home: the job page shows cashNet
    // minus the per-period RRSP tax benefit (the benefit is on its
    // own sub-line — see earnNextPayHtml and the detail summary
    // cards), so the highlight must use the same figure.
    const displayedCash = homeR2(
      (job.calc.perPeriod.cashNet ?? job.calc.perPeriod.net)
      - (job.taxBenefit ? job.taxBenefit.perPeriod : 0));
    jobsForHighlight.push({
      id: row.id, label: row.employer, frequency: row.frequency,
      startDate: row.start_date, recentDate: row.recent_pay_date,
      cashNet: displayedCash,
    });
  }
  const rentalByMonth = new Map();
  const rentalsForHighlight = [];
  const rentalById = {};
  for (const r of db.prepare('SELECT * FROM earn_rentals ORDER BY id').all()) {
    const entries = db.prepare('SELECT * FROM earn_rental_entries WHERE rental_id = ? ORDER BY start_ym, id').all(r.id);
    rentalsForHighlight.push({
      id: r.id, label: r.label,
      entries: entries.map((e) => ({ id: e.id, start_ym: e.start_ym, end_ym: e.end_ym, monthly_rent: e.monthly_rent, pay_day: e.pay_day })),
    });
    const perRental = new Map();
    for (const e of entries) {
      let m = e.start_ym;
      const end = e.end_ym && e.end_ym !== '' ? e.end_ym : cur;
      let guard = 0;
      while (m <= end && m <= cur && guard < 1200) {
        rentalByMonth.set(m, homeR2((rentalByMonth.get(m) || 0) + Number(e.monthly_rent || 0)));
        perRental.set(m, homeR2((perRental.get(m) || 0) + Number(e.monthly_rent || 0)));
        m = homeNextMonth(m); guard++;
      }
    }
    if (perRental.size) {
      rentalById[r.id] = { label: r.label, months: [...perRental.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, rental]) => ({ month, rental })) };
    }
  }
  const earningMonths = [];
  {
    const all = new Set([...salaryByMonth.keys(), ...rentalByMonth.keys()]);
    if (all.size) {
      let m = [...all].sort()[0];
      let guard = 0;
      while (m <= cur && guard < 1200) {
        const salary = salaryByMonth.get(m) || 0;
        const rental = rentalByMonth.get(m) || 0;
        earningMonths.push({ month: m, salary: homeR2(salary), rental: homeR2(rental), total: homeR2(salary + rental) });
        m = homeNextMonth(m); guard++;
      }
    }
  }

  // Spending: monthly charge totals + per-category monthly totals.
  // Charges only: payments and balance adjustments never count.
  const txs = db.prepare('SELECT * FROM spend_transactions').all();
  const byCatMonth = new Map();
  for (const t of txs) {
    if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
    const m = String(t.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    const map = byCatMonth.get(m) || {};
    const cat = t.category || 'Other';
    map[cat] = homeR2((map[cat] || 0) + -Number(t.amount));
    byCatMonth.set(m, map);
  }
  const spendingMonths = [];
  const categorySeries = {};
  {
    const totals = spendMonthly(txs);
    const all = totals.map((r) => r.month);
    if (all.length) {
      let m = all.sort()[0];
      let guard = 0;
      while (m <= cur && guard < 1200) {
        const total = (totals.find((r) => r.month === m) || {}).total || 0;
        spendingMonths.push({ month: m, total: homeR2(total), byCategory: byCatMonth.get(m) || {} });
        m = homeNextMonth(m); guard++;
      }
      for (const cat of SPEND_CATEGORIES) {
        categorySeries[cat] = spendingMonths.map((r) => ({ month: r.month, total: (r.byCategory[cat] || 0) }));
      }
    }
  }

  // Mortgages: one highlight source per property with a live
  // mortgage. Occurrences come from the projection's own grid (see
  // mortgageMonthPaymentDates): the term governing each window month
  // sets the frequency + day, and its opening plan (termPayments)
  // sets the monthly payment — the per-period amount follows
  // periodPaymentFor, and a term override is already inside the plan
  // (an override replaces the derivation for the whole term).
  // Equal-principal terms decline month to month, so their amount is
  // that month's row total over its payment count instead.
  const mortgagesForHighlight = [];
  {
    const windowStart = homePrevMonth(cur);
    const fromDate = `${windowStart}-01`;
    for (const p of props) {
      if (!(p.mortgage_balance > 0)) continue;
      let proj = projById.has(p.id) ? projById.get(p.id) : undefined;
      if (proj === undefined) { proj = projectionFor(p); projById.set(p.id, proj); }
      if (!proj || !proj.series.length) continue;
      const terms = termsOf(p.id);
      const occurrences = [];
      for (const m of [windowStart, cur]) {
        const info = mortgageMonthInfo(p, proj, terms, m, fromDate, today);
        if (!info.row) continue;
        let perPeriod = null;
        if (!info.gov || info.gov.repayment_method !== 'equal_principal') {
          const monthly = (info.gov && proj.termPayments && proj.termPayments[info.gov.id]
            && proj.termPayments[info.gov.id].paymentUsed != null)
            ? proj.termPayments[info.gov.id].paymentUsed : proj.paymentUsed;
          if (monthly == null) continue;
          perPeriod = periodPaymentFor(monthly, info.freq);
        }
        if (!info.dates.length) continue;
        if (perPeriod == null) perPeriod = homeR2(info.row.payment / info.dates.length);
        for (const d of info.dates) occurrences.push({ date: d, amount: perPeriod });
      }
      if (occurrences.length) {
        occurrences.sort((a, b) => a.date.localeCompare(b.date));
        mortgagesForHighlight.push({ id: p.id, label: String(p.address).split(',')[0], occurrences });
      }
    }
  }

  // Mortgages: monthly payment totals per property + all properties,
  // over the trailing year ending at the last completed month — the
  // series the mortgage_payment library metrics and composite
  // formulas read. Same per-month derivation as the highlight above
  // (governing term → monthly payment → per-period amount × payment
  // dates in the month); a month with no payment due is 0, and a
  // month before the mortgage starts is 0 too.
  const mortgageById = {};
  const mortgageMonths = [];
  {
    const lcm = homeLastCompletedMonth(cur);
    const startM = homeAddMonthsYm(lcm, -12);
    const monthTotals = new Map(); // month -> total across properties
    for (const p of props) {
      if (!(p.mortgage_balance > 0)) continue;
      let proj = projById.has(p.id) ? projById.get(p.id) : undefined;
      if (proj === undefined) { proj = projectionFor(p); projById.set(p.id, proj); }
      if (!proj || !proj.series.length) continue;
      const terms = termsOf(p.id);
      const totals = new Map();
      let mm = startM;
      let guard = 0;
      while (mm <= cur && guard < 60) {
        const monthEnd = `${mm}-${String(homeDaysInMonth(mm)).padStart(2, '0')}`;
        const to = monthEnd > today ? today : monthEnd;
        const info = mortgageMonthInfo(p, proj, terms, mm, `${mm}-01`, to);
        let total = 0;
        if (info.row && info.dates.length) {
          let perPeriod = null;
          if (!info.gov || info.gov.repayment_method !== 'equal_principal') {
            const monthly = (info.gov && proj.termPayments && proj.termPayments[info.gov.id]
              && proj.termPayments[info.gov.id].paymentUsed != null)
              ? proj.termPayments[info.gov.id].paymentUsed : proj.paymentUsed;
            if (monthly != null) perPeriod = periodPaymentFor(monthly, info.freq);
          }
          if (perPeriod == null) perPeriod = homeR2(info.row.payment / info.dates.length);
          total = homeR2(perPeriod * info.dates.length);
        }
        totals.set(mm, total);
        monthTotals.set(mm, homeR2((monthTotals.get(mm) || 0) + total));
        mm = homeNextMonth(mm); guard++;
      }
      mortgageById[p.id] = { label: String(p.address).split(',')[0], months: [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, payment]) => ({ month, payment })) };
    }
    for (const [month, payment] of [...monthTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      mortgageMonths.push({ month, payment });
    }
  }

  return {
    currentYm: cur,
    property: propertyMonths, propertyById, propertyLabels,
    stocks: { months: stockMonths, topGainer },
    accountById, accountTypeById,
    earnings: earningMonths, jobById, jobPeriodById, rentalById,
    spending: spendingMonths, categorySeries, holdingById,
    mortgage: mortgageMonths, mortgageById,
    jobsForHighlight, rentalsForHighlight, mortgagesForHighlight,
    entities: {
      properties: props.filter((p) => propertyById[p.id]).map((p) => ({ id: p.id, label: String(p.address).split(',')[0] })),
      mortgageProperties: Object.entries(mortgageById).map(([id, s]) => ({ id: Number(id), label: s.label })),
      holdings: holdings.map((h) => ({ id: h.id, label: h.symbol || h.name || `#${h.id}` })),
      accounts: accountLabels,
      accountTypes: [...new Set(accountLabels.map((a) => a.type))],
      categories: SPEND_CATEGORIES,
      jobs: Object.entries(jobById).map(([id, j]) => ({ id: Number(id), label: j.label })),
      rentals: Object.entries(rentalById).map(([id, r]) => ({ id: Number(id), label: r.label })),
    },
  };
}

const parseHomeInsight = (row) => {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
  return { id: row.id, kind: row.kind, section: row.section, title: row.title, metric: row.metric, generated_at: row.generated_at, ...payload };
};
const readHomeInsights = (userId) => {
  const rows = db.prepare('SELECT * FROM home_insights WHERE user_id = ? ORDER BY id').all(userId).map(parseHomeInsight);
  // The stored drag order (home_insight_order) re-applies after every
  // read, so a regeneration — which deletes + re-inserts the system
  // rows with new ids — keeps the user's order.
  const orderRows = db.prepare('SELECT section, card_key, position FROM home_insight_order WHERE user_id = ? ORDER BY position').all(userId);
  const orders = {};
  for (const o of orderRows) (orders[o.section] = orders[o.section] || []).push(o.card_key);
  return applyHomeInsightOrder(rows, orders);
};

// Home insight cards are stored snapshots: the system set only
// regenerates when >7 days stale (GET /api/home). A rental, rent
// entry, salary job, or contribution plan change makes those
// snapshots wrong immediately, so the write drops the system rows —
// the next Home load regenerates them from live data instead of
// waiting out the 7 days (user 2026-11-08: the system Rental
// income card showed $1,700 while the freshly-appended AI card
// showed the right $7,260; user 2026-11-09: the same for Salary
// take-home after a job change).
function dropSystemHomeInsights(userId) {
  db.prepare('DELETE FROM home_insights WHERE user_id = ? AND kind = ?').run(userId, 'system');
}

// Rental-dependent AI cards are stored snapshots too and never
// auto-refresh, so one goes stale when its rental's entries change
// (and outlives its rental when the rental is deleted). Recompute
// those from the live data on every Home load — pure computation on
// data already collected — and keep the model's title/section.
// System cards are handled by the staleness regeneration above.
const RENTAL_AI_METRICS = new Set(['earning_rental', 'earning_total']);
function refreshRentalAiInsights(userId, insights, data) {
  const now = new Date().toISOString();
  let changed = false;
  const out = [];
  for (const row of insights) {
    if (row.kind !== 'ai') { out.push(row); continue; }
    const colon = String(row.metric).indexOf(':');
    const base = colon === -1 ? String(row.metric) : String(row.metric).slice(0, colon);
    if (!RENTAL_AI_METRICS.has(row.metric) && base !== 'rental_income') { out.push(row); continue; }
    const computed = resolveHomeMetric(row.metric, data);
    if (!computed || computed.error) {
      // The rental itself is gone — the card can never compute
      // again, so drop it. A rental that merely has no entries yet
      // keeps its card (entries can be added later).
      if (base === 'rental_income' && computed && computed.error
        && !db.prepare('SELECT id FROM earn_rentals WHERE id = ?').get(Number(row.metric.slice(colon + 1)))) {
        db.prepare('DELETE FROM home_insights WHERE id = ?').run(row.id);
        changed = true;
        continue;
      }
      out.push(row);
      continue;
    }
    const fresh = { ...computed, title: row.title, section: row.section };
    const sig = (c) => JSON.stringify([c.value, c.period, c.spark, c.mom, c.yoy, c.equation]);
    if (sig(fresh) !== sig(row)) {
      db.prepare('UPDATE home_insights SET payload = ?, generated_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(fresh), now, now, row.id);
      changed = true;
      out.push({ ...row, ...fresh, generated_at: now });
    } else {
      out.push(row);
    }
  }
  return changed ? out : insights;
}

// Salary-dependent AI cards are stored snapshots too and never
// auto-refresh, so one goes stale when its job's pay or a linked
// plan changes (and outlives its job when the job is deleted).
// Recompute those from the live data on every Home load — pure
// computation on data already collected — and keep the model's
// title/section. System cards are handled by the staleness
// regeneration above. (User 2026-11-09, approved "一起给改上":
// the same treatment the rental cards got in c3bd73f.)
const SALARY_AI_METRICS = new Set(['earning_salary', 'earning_total']);
function refreshSalaryAiInsights(userId, insights, data) {
  const now = new Date().toISOString();
  let changed = false;
  const out = [];
  for (const row of insights) {
    if (row.kind !== 'ai') { out.push(row); continue; }
    const colon = String(row.metric).indexOf(':');
    const base = colon === -1 ? String(row.metric) : String(row.metric).slice(0, colon);
    if (!SALARY_AI_METRICS.has(row.metric) && base !== 'job_takehome' && base !== 'job_takehome_period') { out.push(row); continue; }
    const computed = resolveHomeMetric(row.metric, data);
    if (!computed || computed.error) {
      // The job itself is gone — the card can never compute
      // again, so drop it. A job that merely has no pay history
      // yet keeps its card (dates can be filled in later).
      if ((base === 'job_takehome' || base === 'job_takehome_period') && computed && computed.error
        && !db.prepare('SELECT id FROM earn_jobs WHERE id = ?').get(Number(row.metric.slice(colon + 1)))) {
        db.prepare('DELETE FROM home_insights WHERE id = ?').run(row.id);
        changed = true;
        continue;
      }
      out.push(row);
      continue;
    }
    const fresh = { ...computed, title: row.title, section: row.section };
    const sig = (c) => JSON.stringify([c.value, c.period, c.spark, c.mom, c.yoy, c.equation]);
    if (sig(fresh) !== sig(row)) {
      db.prepare('UPDATE home_insights SET payload = ?, generated_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(fresh), now, now, row.id);
      changed = true;
      out.push({ ...row, ...fresh, generated_at: now });
    } else {
      out.push(row);
    }
  }
  return changed ? out : insights;
}

// Composite AI cards are stored snapshots too, and their legs move
// when a job, rental, mortgage or spending series changes — so
// recompute every composite from live data on each Home load and
// keep the model's title/section. On an error the stored snapshot
// is kept (a leg may only temporarily have no data); composites are
// never deleted on read.
function refreshCompositeAiInsights(userId, insights, data) {
  const now = new Date().toISOString();
  let changed = false;
  const out = [];
  for (const row of insights) {
    if (row.kind !== 'ai' || !String(row.metric).startsWith('composite:')) { out.push(row); continue; }
    const computed = resolveHomeMetric(row.metric, data);
    if (!computed || computed.error) { out.push(row); continue; }
    const fresh = { ...computed, title: row.title, section: row.section };
    const sig = (c) => JSON.stringify([c.value, c.period, c.spark, c.mom, c.yoy, c.equation]);
    if (sig(fresh) !== sig(row)) {
      db.prepare('UPDATE home_insights SET payload = ?, generated_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(fresh), now, now, row.id);
      changed = true;
      out.push({ ...row, ...fresh, generated_at: now });
    } else {
      out.push(row);
    }
  }
  return changed ? out : insights;
}

// Standard (system) cards are stored snapshots, regenerated only
// when >7 days stale — but the numbers behind a card move with an
// edit (a new assessment, a rent change) long before that, and the
// breakdown is new code on old rows. Re-resolve the standard set
// from live data on every Home load and update stored rows whose
// value, period, spark, deltas or equation moved — the same
// read-time refresh the AI cards get. In-place payload update only:
// ids and the user's drag order are untouched.
function refreshStandardInsights(userId, insights, data) {
  const fresh = buildStandardInsights(data);
  const byMetric = new Map(fresh.map((c) => [c.metric, c]));
  const now = new Date().toISOString();
  let changed = false;
  const out = [];
  for (const row of insights) {
    if (row.kind !== 'system') { out.push(row); continue; }
    const computed = byMetric.get(row.metric);
    if (!computed) { out.push(row); continue; }
    const sig = (c) => JSON.stringify([c.value, c.period, c.spark, c.mom, c.yoy, c.equation]);
    if (sig(computed) !== sig(row)) {
      db.prepare('UPDATE home_insights SET payload = ?, generated_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(computed), now, now, row.id);
      changed = true;
      out.push({ ...row, ...computed, generated_at: now });
    } else {
      out.push(row);
    }
  }
  return changed ? out : insights;
}

// The remaining AI cards — per-property / holding / account /
// account-type / category / mortgage, plus AI cards on a standard
// metric (e.g. an AI 'Total gain' card) — are stored snapshots too
// and never refreshed on read (the known property/stock gap). This
// closes that gap for the tooltip round: re-resolve them from live
// data on every Home load, like the other AI cards. On an error the
// stored snapshot is kept (never deleted on read); the rental and
// salary refreshes above keep their own delete-when-the-entity-is-
// gone rules, so this runs last and skips what they already cover.
function refreshOtherAiInsights(userId, insights, data) {
  const now = new Date().toISOString();
  let changed = false;
  const out = [];
  for (const row of insights) {
    if (row.kind !== 'ai') { out.push(row); continue; }
    const colon = String(row.metric).indexOf(':');
    const base = colon === -1 ? String(row.metric) : String(row.metric).slice(0, colon);
    if (String(row.metric).startsWith('composite:')) { out.push(row); continue; }
    if (RENTAL_AI_METRICS.has(row.metric) || base === 'rental_income') { out.push(row); continue; }
    if (SALARY_AI_METRICS.has(row.metric) || base === 'job_takehome' || base === 'job_takehome_period') { out.push(row); continue; }
    const computed = resolveHomeMetric(row.metric, data);
    if (!computed || computed.error) { out.push(row); continue; }
    const fresh = { ...computed, title: row.title, section: row.section };
    const sig = (c) => JSON.stringify([c.value, c.period, c.spark, c.mom, c.yoy, c.equation]);
    if (sig(fresh) !== sig(row)) {
      db.prepare('UPDATE home_insights SET payload = ?, generated_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(fresh), now, now, row.id);
      changed = true;
      out.push({ ...row, ...fresh, generated_at: now });
    } else {
      out.push(row);
    }
  }
  return changed ? out : insights;
}

// Recompute the standard set only; AI cards are untouched.
function generateStandardInsights(userId, data) {
  const cards = buildStandardInsights(data);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM home_insights WHERE user_id = ? AND kind = ?').run(userId, 'system');
    const ins = db.prepare('INSERT INTO home_insights (user_id, kind, section, title, metric, payload, generated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of cards) ins.run(userId, 'system', c.section, c.title, c.metric, JSON.stringify(c), now, now, now);
  });
  tx();
  return readHomeInsights(userId);
}

app.get('/api/home', requireApiAuth, async (req, res) => {
  const userId = req.user.id;
  const marks = new Map(db.prepare('SELECT kind, source_id, pay_date, received FROM income_marks WHERE user_id = ?').all(userId)
    .map((m) => [`${m.kind}:${m.source_id}:${m.pay_date}`, m.received]));
  const data = await collectHomeData();
  const highlights = homeHighlightRows({ jobs: data.jobsForHighlight, rentals: data.rentalsForHighlight, mortgages: data.mortgagesForHighlight, marks, today: vancouverToday() });
  let insights = readHomeInsights(userId);
  const sys = insights.filter((r) => r.kind === 'system');
  const staleMs = 7 * 24 * 3600 * 1000;
  const stale = !sys.length || sys.some((r) => Date.now() - new Date(r.generated_at).getTime() > staleMs);
  if (stale) insights = generateStandardInsights(userId, data);
  // Rental-dependent AI cards refresh from live data (see
  // refreshRentalAiInsights): an entry edit must move them at once.
  insights = refreshRentalAiInsights(userId, insights, data);
  // Salary-dependent AI cards refresh from live data (see
  // refreshSalaryAiInsights): a pay or plan edit must move them at once.
  insights = refreshSalaryAiInsights(userId, insights, data);
  // Composite AI cards refresh from live data (see
  // refreshCompositeAiInsights): a leg change must move them at once.
  insights = refreshCompositeAiInsights(userId, insights, data);
  // Standard cards refresh from live data too (see
  // refreshStandardInsights): an edit moves them at once instead
  // of waiting for the 7-day regeneration.
  insights = refreshStandardInsights(userId, insights, data);
  // The remaining AI cards refresh from live data (see
  // refreshOtherAiInsights): this closes the property/stock gap
  // for the tooltip round.
  insights = refreshOtherAiInsights(userId, insights, data);
  // Report mode shows a property card's house photo: attach the
  // first gallery photo (or the legacy photo_url) to property-entity
  // cards. No photo → photo: null, and the card renders no
  // projection at all. Standard cards carry no entity and are
  // untouched.
  const photoByProperty = new Map();
  for (const c of insights) {
    if (!c.entity || c.entity.kind !== 'property' || photoByProperty.has(c.entity.id)) continue;
    const p = db.prepare('SELECT id, photo_url FROM properties WHERE id = ?').get(c.entity.id);
    const photos = p ? photosView(p) : [];
    photoByProperty.set(c.entity.id, photos.length ? photos[0].src : null);
  }
  if (photoByProperty.size) {
    insights = insights.map((c) => (c.entity && c.entity.kind === 'property'
      ? { ...c, photo: photoByProperty.get(c.entity.id) ?? null } : c));
  }
  res.json({ highlights, insights, generatedAt: sys.length ? sys[0].generated_at : null });
});

// Home calendar: payment dates in ONE month (salary, rental,
// mortgage), color-coded per kind on the client. The date sources
// are exactly the highlight's — the job payday grid, the rental due
// dates, the mortgage projection grid — but the month is NOT capped
// at today: the calendar shows the whole month, past and future, so
// prev/next navigation into other months works. Jobs and rentals
// come straight from their tables (no series needed); mortgage
// dates come from the projection grid via mortgageMonthInfo.
app.get('/api/home/calendar', requireApiAuth, async (req, res) => {
  const today = vancouverToday();
  const cur = currentMonthKey();
  const month = String(req.query.month || cur);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const jobs = db.prepare('SELECT id, employer, frequency, start_date, recent_pay_date FROM earn_jobs ORDER BY id').all()
    .map((j) => ({ id: j.id, label: j.employer, frequency: j.frequency, startDate: j.start_date, recentDate: j.recent_pay_date }));
  const rentals = db.prepare('SELECT * FROM earn_rentals ORDER BY id').all().map((r) => ({
    id: r.id, label: r.label,
    entries: db.prepare('SELECT * FROM earn_rental_entries WHERE rental_id = ? ORDER BY start_ym, id').all(r.id)
      .map((e) => ({ id: e.id, start_ym: e.start_ym, end_ym: e.end_ym, monthly_rent: e.monthly_rent, pay_day: e.pay_day })),
  }));
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(homeDaysInMonth(month)).padStart(2, '0')}`;
  const mortgageOccurrences = [];
  for (const p of db.prepare('SELECT * FROM properties ORDER BY id').all()) {
    if (!(p.mortgage_balance > 0)) continue;
    const proj = projectionFor(p);
    if (!proj || !proj.series.length) continue;
    const { dates } = mortgageMonthInfo(p, proj, termsOf(p.id), month, monthStart, monthEnd);
    for (const d of dates) mortgageOccurrences.push({ date: d, sourceId: p.id, label: String(p.address).split(',')[0] });
  }
  // The same income_marks map /api/home builds, so each day entry
  // carries its mark state (received 1/0) for the done-dot style.
  const marks = new Map(db.prepare('SELECT kind, source_id, pay_date, received FROM income_marks WHERE user_id = ?').all(req.user.id)
    .map((m) => [`${m.kind}:${m.source_id}:${m.pay_date}`, m.received]));
  res.json({ month, today, days: homeCalendarDates({ jobs, rentals, mortgageOccurrences, month, marks }) });
});

app.post('/api/home/insights/generate', requireApiAuth, async (req, res) => {
  const data = await collectHomeData();
  res.json({ insights: generateStandardInsights(req.user.id, data) });
});

app.post('/api/home/marks', requireApiAuth, (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'salary' || b.kind === 'rental' || b.kind === 'mortgage' ? b.kind : null;
  const sourceId = Number(b.source_id);
  const date = String(b.date || '');
  const received = b.received === 1 || b.received === true ? 1 : (b.received === 0 || b.received === false ? 0 : null);
  if (!kind || !Number.isInteger(sourceId) || sourceId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || received == null) {
    return res.status(400).json({ error: 'kind, source_id, date and received (0/1) are required.' });
  }
  // Rental marks key by the rent ENTRY (its id), not the rental:
  // entries stay separate, never merged (user 2026-11-08), so one
  // entry's mark must not mark its sibling.
  const exists = kind === 'salary'
    ? db.prepare('SELECT id FROM earn_jobs WHERE id = ?').get(sourceId)
    : kind === 'rental'
      ? db.prepare('SELECT id FROM earn_rental_entries WHERE id = ?').get(sourceId)
      : db.prepare('SELECT id FROM properties WHERE id = ?').get(sourceId);
  if (!exists) return res.status(404).json({ error: 'source not found' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO income_marks (user_id, kind, source_id, pay_date, received, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, kind, source_id, pay_date)
    DO UPDATE SET received = excluded.received, updated_at = excluded.updated_at`)
    .run(req.user.id, kind, sourceId, date, received, now);
  res.json({ ok: true, kind, source_id: sourceId, date, received });
});

// AI-append: propose only. The AI returns a card DEFINITION (metric
// from the computable library); the app computes the numbers, and
// nothing writes until the client Applies the proposal.
app.post('/api/home/insights/ai-append', requireApiAuth, async (req, res) => {
  if (!llmConfigured()) return res.status(503).json({ error: 'AI is not configured.' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required.' });
  const history = Array.isArray((req.body || {}).history)
    ? (req.body.history || []).slice(-20).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', text: String(h.text || '').slice(0, 500) }))
    : [];
  const data = await collectHomeData();
  const library = buildHomeMetricLibrary(data.entities);
  const existingTitles = readHomeInsights(req.user.id).map((r) => r.title);
  const prompt = homeAiPrompt({ text, history, library, existingTitles });
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch {
    return res.status(502).json({ error: 'AI call failed.' });
  }
  const parsed = parseModelJson(typeof raw === 'string' ? raw : JSON.stringify(raw || ''));
  if (!parsed || typeof parsed !== 'object') {
    return res.json({ note: 'The AI did not return a usable proposal. Try rephrasing the request.' });
  }
  if (parsed.ask) return res.json({ ask: String(parsed.ask).slice(0, 500) });
  if (parsed.decline) return res.json({ decline: String(parsed.decline).slice(0, 500) });
  if (parsed.card && typeof parsed.card === 'object') {
    // A composite proposal: the model writes a formula over library
    // metrics; the server validates it and computes it
    // deterministically. A failed validation is a decline, never a
    // guessed number.
    if (parsed.card.composite && typeof parsed.card.composite === 'object') {
      const v = validateHomeComposite(parsed.card.composite, library);
      if (!v.ok) return res.json({ decline: v.message });
      const section = String(parsed.card.section || v.section);
      if (section !== v.section) return res.json({ decline: 'That combination belongs to a different section.' });
      const title = String(parsed.card.title || '').slice(0, 80) || 'Combined flow';
      const computed = resolveHomeMetric(v.metricId, data);
      if (computed && computed.error) return res.json({ decline: computed.message || 'That combination has no data yet.' });
      return res.json({ proposal: { section, title, metric: v.metricId, preview: { ...computed, title } } });
    }
    const metric = String(parsed.card.metric || '');
    const libEntry = library.find((m) => m.metric === metric);
    if (!libEntry) return res.json({ decline: 'That metric is not one the home page can compute.' });
    const section = String(parsed.card.section || libEntry.section);
    if (section !== libEntry.section) return res.json({ decline: 'That metric belongs to a different section.' });
    const title = String(parsed.card.title || libEntry.title).slice(0, 80);
    const computed = resolveHomeMetric(metric, data);
    if (computed && computed.error) return res.json({ decline: computed.message || 'That metric has no data yet.' });
    return res.json({ proposal: { section, title, metric, preview: { ...computed, title } } });
  }
  return res.json({ note: 'The AI did not return a usable proposal. Try rephrasing the request.' });
});

// Apply an AI proposal: compute the card deterministically and append
// it at the end of its section. A second Apply on the same turn does
// not double-append (same metric + title dedupes).
app.post('/api/home/insights/ai-apply', requireApiAuth, async (req, res) => {
  const def = (req.body || {}).definition || req.body || {};
  const metric = String(def.metric || '');
  const section = String(def.section || '');
  const title = String(def.title || '').slice(0, 80);
  if (!metric || !section || !title) {
    return res.status(400).json({ error: 'definition.metric, definition.section and definition.title are required.' });
  }
  const data = await collectHomeData();
  const library = buildHomeMetricLibrary(data.entities);
  let computed;
  if (metric.startsWith('composite:')) {
    // A composite id carries its own formula: re-validate it
    // against the live library (a hand-posted id cannot smuggle in
    // an unknown or non-flow leg) and require the canonical form.
    const terms = parseHomeCompositeMetric(metric);
    const v = terms ? validateHomeComposite({ terms }, library) : null;
    if (!v || !v.ok) return res.status(400).json({ error: (v && v.message) || 'Invalid composite formula.' });
    if (v.metricId !== metric) return res.status(400).json({ error: 'Composite formula is not in canonical form.' });
    if (v.section !== section) return res.status(400).json({ error: 'Section mismatch.' });
    computed = resolveHomeMetric(metric, data);
  } else {
    const libEntry = library.find((m) => m.metric === metric);
    if (!libEntry || libEntry.section !== section) {
      return res.status(400).json({ error: 'Unknown metric or section mismatch.' });
    }
    computed = resolveHomeMetric(metric, data);
  }
  if (computed && computed.error) return res.status(400).json({ error: computed.message });
  const card = { ...computed, title, section };
  const existing = db.prepare('SELECT * FROM home_insights WHERE user_id = ? AND kind = ? AND metric = ? AND title = ?')
    .get(req.user.id, 'ai', metric, title);
  if (existing) return res.json({ insight: parseHomeInsight(existing), duplicate: true });
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO home_insights (user_id, kind, section, title, metric, payload, generated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, 'ai', section, title, metric, JSON.stringify(card), now, now, now);
  const row = db.prepare('SELECT * FROM home_insights WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ insight: parseHomeInsight(row) });
});

// Only AI cards are deletable; system cards are never deletable.
app.delete('/api/home/insights/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM home_insights WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'insight not found' });
  if (row.kind !== 'ai') return res.status(400).json({ error: 'System cards cannot be deleted.' });
  db.prepare('DELETE FROM home_insights WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// Reorder insight cards within a section (drag-and-drop). The order
// is keyed by the card's stable identity (section + metric + title),
// NOT by row id — regeneration deletes + re-inserts system rows, so
// an id-keyed order would be wiped. A lightweight UI-state write,
// like marks: not a Global History commit. Cards missing from the
// posted order (newly generated or AI-appended) append at the end.
app.post('/api/home/insights/reorder', requireApiAuth, (req, res) => {
  const userId = req.user.id;
  const b = req.body || {};
  const section = String(b.section || '');
  const order = Array.isArray(b.order) ? b.order : null;
  if (!['property', 'stock', 'earning', 'spending'].includes(section) || !order
    || order.some((k) => typeof k !== 'string' || !k)) {
    return res.status(400).json({ error: 'section and order (array of card keys) are required.' });
  }
  const known = new Set(readHomeInsights(userId).filter((c) => c.section === section).map((c) => homeOrderKey(c)));
  const keys = order.filter((k) => known.has(k));
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM home_insight_order WHERE user_id = ? AND section = ?').run(userId, section);
    const ins = db.prepare('INSERT INTO home_insight_order (user_id, section, card_key, position, updated_at) VALUES (?, ?, ?, ?, ?)');
    keys.forEach((k, i) => ins.run(userId, section, k, i, now));
  })();
  res.json({ ok: true, section, order: keys });
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

// -------------------------------------------------------------- planning ---
// Planning is a sandbox branch off mainline: projects hold strategies,
// strategies hold ordered ops + funding legs, and NOTHING writes
// mainline except the atomic Merge path (with per-row before/after
// records). Preview numbers equal post-confirm numbers because both
// read the same projection.
function planProjectById(id, userId) {
  const row = db.prepare('SELECT * FROM plan_projects WHERE id = ?').get(id);
  if (!row || (userId != null && row.user_id !== userId)) return null;
  return row;
}
function planStrategyById(id) {
  const row = db.prepare('SELECT * FROM plan_strategies WHERE id = ?').get(id);
  return row || null;
}
function planProjectEntityOf(project) {
  if (!project) return null;
  try { return project.entity ? JSON.parse(project.entity) : null; } catch { return null; }
}
// Property-project entity property (user rule 2026-11-04): the single
// property the project is about, with its address for captions. Null
// for legacy projects (no category/entity) and non-property projects.
function planEntityProperty(project) {
  if (!project || project.category !== 'property') return null;
  const entity = planProjectEntityOf(project);
  if (!entity || entity.type !== 'property' || !Number.isInteger(Number(entity.propertyId))) return null;
  const row = db.prepare('SELECT id, address FROM properties WHERE id = ?').get(Number(entity.propertyId));
  return row ? { id: row.id, address: row.address } : null;
}
function planOpsOf(strategyId) {
  const ops = db.prepare('SELECT * FROM plan_ops WHERE strategy_id = ? ORDER BY seq, id').all(strategyId)
    .map((o) => ({ ...o, params: JSON.parse(o.params || '{}') }));
  for (const o of ops) {
    o.legs = db.prepare('SELECT * FROM plan_legs WHERE op_id = ? ORDER BY id').all(o.id);
  }
  // Buy/sell ops that target an existing holding carry only its id —
  // the strategy page's buy list shows the holding's symbol, resolved
  // here so the client never has to join holdings itself.
  const holdingIds = [...new Set(ops.map((o) => (o.params && o.params.holdingId) || null).filter((x) => x != null))];
  if (holdingIds.length) {
    const rows = db.prepare(`SELECT id, symbol, label FROM invest_holdings WHERE id IN (${holdingIds.map(() => '?').join(',')})`).all(...holdingIds);
    const byId = new Map(rows.map((r) => [r.id, r.symbol || r.label || '']));
    for (const o of ops) if (o.params && o.params.holdingId && byId.has(Number(o.params.holdingId))) o.holdingSymbol = byId.get(Number(o.params.holdingId));
  }
  return ops;
}
function planAssumptionsOf(strategyId) {
  return db.prepare('SELECT * FROM plan_assumptions WHERE strategy_id = ? ORDER BY id').all(strategyId);
}
// Confirmed assumptions only: an unconfirmed assumption never enters
// a computation (it is shown as pending in the UI instead).
function planConfirmedAssumptions(strategyId) {
  const out = {};
  for (const a of planAssumptionsOf(strategyId)) {
    if (a.confirmed) out[a.key] = a.value;
  }
  return out;
}
function planSnapshotMainline() {
  return {
    properties: db.prepare('SELECT * FROM properties ORDER BY id').all(),
    terms: db.prepare('SELECT * FROM mortgage_terms ORDER BY id').all(),
    segments: db.prepare('SELECT * FROM rate_segments ORDER BY id').all(),
    lumpSums: db.prepare('SELECT * FROM lump_sums ORDER BY id').all(),
    accounts: db.prepare('SELECT * FROM invest_accounts ORDER BY id').all(),
    holdings: db.prepare('SELECT * FROM invest_holdings ORDER BY id').all(),
    events: db.prepare('SELECT * FROM invest_events ORDER BY id').all(),
  };
}
function planSnapshotStale(snapshot) {
  try {
    const snap = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    const cur = planSnapshotMainline();
    for (const table of Object.keys(snap)) {
      const sRows = snap[table] || [];
      const cRows = cur[table] || [];
      if (sRows.length !== cRows.length) return true;
      const cById = new Map(cRows.map((r) => [r.id, r]));
      for (const s of sRows) {
        const c = cById.get(s.id);
        if (!c || JSON.stringify(s) !== JSON.stringify(c)) return true;
      }
    }
    return false;
  } catch { return true; }
}
// Mainline data shaped for computeProjection. Assessed value is the
// property's latest known figure (the app stores one current assessed
// value per property); FX is the latest stored BoC rate.
function planAssembleMainline(projectId) {
  const props = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const properties = props.map((p) => ({
    ...p,
    terms: db.prepare('SELECT * FROM mortgage_terms WHERE property_id = ? ORDER BY start_date, id').all(p.id),
    segments: db.prepare('SELECT * FROM rate_segments WHERE property_id = ? ORDER BY start_date, id').all(p.id),
    lumpSums: db.prepare('SELECT * FROM lump_sums WHERE property_id = ? ORDER BY date, id').all(p.id),
  }));
  const holdings = listHoldings(db).map((h) => ({
    ...h,
    accountId: h.account_id,
    events: listEvents(db, h.id),
    pricePoints: listPricePoints(db, h.id).map((pt) => ({ date: pt.date, price: pt.price })),
  }));
  const fxRow = db.prepare('SELECT rate FROM invest_fx_rates ORDER BY date DESC LIMIT 1').get();
  const declaredAssets = db.prepare('SELECT * FROM plan_declared_assets WHERE project_id = ? ORDER BY id').all(projectId);
  const assessed = {};
  for (const p of props) assessed[p.id] = p.assessed_value ?? 0;
  return { properties, holdings, fxRateLatest: fxRow ? fxRow.rate : null, declaredAssets, assessed };
}
// A strategy row's factors, parsed (client parses the same way from
// the raw row; this helper is for server-side computation).
function planStrategyFactors(strategy) {
  if (!strategy) return {};
  try { return JSON.parse(strategy.factors || '{}') || {}; } catch { return {}; }
}
// Investment-pool mainline: for an investment project whose entity is
// a user-defined cash pool, the projection mainline holds ONLY the
// pool's contributions, each with a synthetic position event at the
// current month. A percent contributes that percent OF ITS OWN SOURCE
// (an account spreads pro-rata across its holdings); a CAD amount
// contributes that amount (an account amount spreads pro-rata by
// holding value). The pool total is the sum of the contributions.
function planPoolMainline(project, mainline, currentMonth) {
  const entity = planProjectEntityOf(project);
  if (project.category !== 'investment' || !entity || entity.type !== 'pool') return mainline;
  const fx = Number(mainline.fxRateLatest) || 1;
  const byId = new Map((mainline.holdings || []).map((h) => [h.id, h]));
  const cutoff = `${currentMonth}-31`;
  const priceOn = (h) => {
    let last = null;
    for (const pt of h.pricePoints || []) if (String(pt.date).slice(0, 10) <= cutoff) last = pt; else break;
    return last ? Number(last.price) : null;
  };
  const unitsOnAt = (h) => unitsOn(h.events || [], cutoff);
  const toCad = (h, v) => (h.currency === 'USD' ? v * fx : v);
  const fromCad = (h, v) => (h.currency === 'USD' ? v / fx : v);
  const unitsByHolding = new Map();
  const addUnits = (id, units) => { if (units > 0) unitsByHolding.set(id, (unitsByHolding.get(id) || 0) + units); };
  for (const it of entity.items || []) {
    if (it.accountId != null) {
      const accHoldings = (mainline.holdings || []).filter((h) => Number(h.accountId) === Number(it.accountId));
      if (it.percent != null) {
        const pct = Number(it.percent) / 100;
        for (const h of accHoldings) addUnits(h.id, pct * unitsOnAt(h));
      } else {
        const valued = [];
        let total = 0;
        for (const h of accHoldings) {
          const pr = priceOn(h);
          const u = unitsOnAt(h);
          if (pr == null || !u) continue;
          const v = toCad(h, u * pr);
          valued.push({ h, pr, v });
          total += v;
        }
        if (!total) continue;
        for (const { h, pr, v } of valued) addUnits(h.id, fromCad(h, (v / total) * Number(it.amount)) / pr);
      }
    } else {
      const h = byId.get(Number(it.holdingId));
      if (!h) continue;
      const pr = priceOn(h);
      if (pr == null) continue;
      if (it.percent != null) addUnits(h.id, (Number(it.percent) / 100) * unitsOnAt(h));
      else addUnits(h.id, fromCad(h, Number(it.amount)) / pr);
    }
  }
  const poolHoldings = [...unitsByHolding.entries()].map(([id, units]) => {
    const holding = byId.get(id);
    return {
      ...holding,
      events: [{ date: `${currentMonth}-01`, type: 'position', units: Math.round(units * 10000) / 10000 }],
      pricePoints: holding.pricePoints,
    };
  });
  return { ...mainline, holdings: poolHoldings };
}
// Per-holding CURRENT return rates for a mainline, from stored price
// history only (never fetched, never invented): the map feeds the
// engine, the labeled list feeds the comparison payload so the user
// can check which rate each holding grows at.
function planHoldingGrowth(mainline, currentMonth) {
  const map = {};
  const rates = [];
  for (const h of mainline.holdings || []) {
    const r = currentReturnRateFromPoints(h.pricePoints, currentMonth);
    if (r) {
      map[h.id] = r.ratePct;
      rates.push({ holdingId: h.id, symbol: h.symbol || h.label || '', label: h.label || h.symbol || '', ratePct: r.ratePct, basis: r.basis, window: r.window });
    }
  }
  return { map, rates };
}
// A strategy's projection under its OWN factors; the baseline is
// always the do-nothing reference (no ops, no factor overrides, no
// scenario — variable segments price at the last actual prime held
// flat). "Changes nothing" does NOT mean flat: holdings still earn
// their current rates, so both runs grow each holding at its current
// rate unless the scenario overrides it with a stock factor or a
// buy carries its own rate (a custom product, e.g. a GIC).
// Projection under a world: scenario factors apply to BOTH the baseline
// and the strategy at evaluation time (variable mortgages follow the
// scenario prime, stocks follow the scenario return; unfactored parts
// keep current rates/terms). The baseline spec itself belongs to no
// scenario — it is the do-nothing reference, repriced under the world.
// scenarioInput: undefined = the project's base scenario (the labeled
// default); null = flat world; a scenario row = that row's factors
// (legacy steps restated as prime points); a factors object = itself.
// The return is set on the scenario (stock factor) or carried on a
// buy op (a custom product's own rate, e.g. a GIC) — there is no
// sink anymore (user 2026-11-05): the buy list IS the sink.
async function planProjectionFor(strategy, project, scenarioInput, overrides) {
  await ensureFreshPrime();
  const baseMainline = planAssembleMainline(project.id);
  const currentMonth = currentMonthKey();
  let mainline = planPoolMainline(project, baseMainline, currentMonth);
  // Entity scope (user rule 2026-11-04): a property project's
  // projection world holds ONLY its entity property — every figure
  // below (balance, interest, payment, payoff, cost/gain/net, deltas)
  // is then entity-only by construction. Holdings are untouched.
  const entityProp = planEntityProperty(project);
  if (entityProp) mainline = scopeMainlineToProperty(mainline, entityProp.id);
  const rawOps = planOpsOf(strategy.id);
  // Preview-only op overrides (report variables, trajectory tier):
  // patch op params IN MEMORY — the caller validates the patched
  // ops via planValidateStrategyOps first; nothing is written.
  const ops = overrides && overrides.opParams
    ? rawOps.map((o) => (overrides.opParams[o.id] ? { ...o, params: { ...(o.params || {}), ...overrides.opParams[o.id] } } : o))
    : rawOps;
  const legs = [];
  for (const o of ops) for (const l of o.legs) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
  let scenarioRow = null;
  let factors = null;
  if (scenarioInput === undefined) {
    scenarioRow = planBaseScenario(project.id);
    factors = planScenarioFactorsOfRow(scenarioRow);
  } else if (scenarioInput === null) {
    factors = null;
  } else if (scenarioInput && typeof scenarioInput === 'object' && ('factors' in scenarioInput || 'steps' in scenarioInput || 'project_id' in scenarioInput)) {
    scenarioRow = scenarioInput;
    factors = planScenarioFactorsOfRow(scenarioInput);
  } else {
    factors = scenarioInput;
  }
  const confirmed = planConfirmedAssumptions(strategy.id);
  const baseAssumptions = factorsToAssumptions(factors, {});
  const strategyAssumptions = factorsToAssumptions(factors, confirmed);
  const primeHistory = getPrimeHistory();
  const cur = getCurrentPrime();
  const currentPrime = cur ? cur.rate : null;
  // External pool cash seeds the pot in both runs (0 when the pool
  // has none) — it is spendable from the first month.
  const potInitial = poolExternalCash(planProjectEntityOf(project));
  // A buy on a cash-pool project is funded BY the pool: the engine
  // sells pool holdings to raise the buy's 'cash' leg (user
  // 2026-11-05 — the old code treated 'cash' as unlimited external
  // money, so the strategy kept both XQQ.TO and AMZN). The pool is
  // the mainline's holdings after planPoolMainline; single-holding
  // or account projects have no pool, so their 'cash' legs stay
  // external cash as before.
  const poolEntity = planProjectEntityOf(project);
  const poolHoldingIds = (project.category === 'investment' && poolEntity && poolEntity.type === 'pool')
    ? (mainline.holdings || []).map((h) => h.id)
    : null;
  // Maturing custom buys (user 2026-11-05): the comparison ends at
  // the latest maturity month — report charts/tables/pager stop there,
  // no more 2056 for a GIC strategy. An explicit horizon override
  // (the report block's shared window) wins; otherwise the horizon
  // comes from this strategy's own ops. The baseline runs to the SAME
  // horizon so the comparison shares one window.
  const horizonMonths = (overrides && overrides.horizonMonths != null)
    ? overrides.horizonMonths
    : maturityHorizonMonths(ops, currentMonth);
  const args = { mainline, ops, legs, primeHistory, currentPrime, currentMonth, potInitial, poolHoldingIds, horizonMonths };
  // Buy-target history (user 2026-11-07 — the AMZN-flat fix): a buy
  // op can target a symbol the user does not hold yet (no
  // holdingId), so the pool pull never sees it. Pull its history
  // here — every projection runs through this function (strategy
  // page, merge preview, comparison), so all of them get the same
  // fix — and hand the stored points to the engine so the synthetic
  // holding grows at its history rate. The pull is gated (a usable
  // rate → skip) and backed off, so repeated renders cost nothing
  // after the first fetch; a failed fetch never fails the
  // projection (the buy stays flat and the note names it).
  let symbolHistoryNotes = [];
  let symbolPricePoints = {};
  {
    const targets = [];
    const seenSym = new Set();
    for (const o of ops) {
      const p = o.params || {};
      if (o.op_type !== 'buy' || p.holdingId != null || !p.symbol) continue;
      const sym = String(p.symbol).toUpperCase();
      if (seenSym.has(sym)) continue;
      seenSym.add(sym);
      targets.push({ symbol: sym, currency: p.currency || 'CAD' });
    }
    if (targets.length) {
      try {
        const pulled = await ensureSymbolHistory(db, targets, { currentMonth });
        symbolHistoryNotes = pulled.notes;
        for (const t of targets) {
          const pts = listSymbolPricePoints(db, t.symbol);
          if (pts.length) symbolPricePoints[t.symbol] = pts;
        }
      } catch (err) {
        console.warn(`[planning] symbol history pull failed, using stored points: ${err.message}`);
        symbolHistoryNotes = [{ symbol: targets.map((t) => t.symbol).join(', '), error: err.message }];
      }
    }
  }
  const argsWithSymbols = { ...args, symbolPricePoints };
  const { map: holdingGrowth, rates: currentRates } = planHoldingGrowth(mainline, currentMonth);
  const baseline = computeProjection({ ...argsWithSymbols, ops: [], legs: [], assumptions: baseAssumptions, scenario: primeFactorToScenario(factors), holdingGrowth });
  baseline.currentRates = currentRates;
  // A buy of a holding outside the pool is injected into the
  // strategy run's mainline with empty events + actual price points:
  // its pre-existing position outside the pool is NOT counted, only
  // the buy is. A symbol-only buy (a new stock the user does not
  // hold yet) has no holding to inject — the buy op creates it in
  // the engine.
  let strategyMainline = mainline;
  for (const o of ops) {
    if (o.op_type !== 'buy' || !(o.params && o.params.holdingId != null)) continue;
    const hid = Number(o.params.holdingId);
    if (strategyMainline.holdings.some((h) => Number(h.id) === hid)) continue;
    const real = baseMainline.holdings.find((h) => Number(h.id) === hid);
    if (real) strategyMainline = { ...strategyMainline, holdings: [...strategyMainline.holdings, { ...real, events: [] }] };
  }
  // Compatibility shim for pre-simplification GICs (user 2026-11-05):
  // their rate rode on the stored custom sink, not on the buy — the
  // stored rate is inherited in memory onto rateless account-less
  // buys; a stock sink's trend is dropped (the scenario return
  // governs now). The sink column is otherwise unread.
  applyStoredCustomSinkRate(ops, planStrategySink(strategy));
  const strategyProj = computeProjection({ ...argsWithSymbols, mainline: strategyMainline, assumptions: strategyAssumptions, scenario: primeFactorToScenario(factors), holdingGrowth });
  return { baseline, strategy: strategyProj, comparison: compareProjections(baseline, strategyProj, { excludeStockGain: project.category === 'property', investmentScope: project.category === 'investment' }), factors, appliedScenario: scenarioRow ? { id: scenarioRow.id, name: scenarioRow.name } : null, currentRates, symbolHistoryNotes };
}
function planScenarioRow(r) {
  if (!r) return null;
  let factors = null;
  try { factors = r.factors ? JSON.parse(r.factors) : null; } catch { factors = null; }
  return { ...r, steps: r.steps ? JSON.parse(r.steps) : null, factors };
}
function planScenariosOf(projectId) {
  return db.prepare('SELECT * FROM plan_scenarios WHERE project_id = ? ORDER BY id').all(projectId).map(planScenarioRow);
}
// A scenario row's world factors: the factors column when set, else a
// legacy prime-only row's steps restated as prime points. NULL = a flat
// world (current rates/terms throughout).
function planScenarioFactorsOfRow(row) {
  if (!row) return null;
  if (row.factors && typeof row.factors === 'object') return row.factors;
  if (Array.isArray(row.steps) && row.steps.length) {
    return { prime: { points: row.steps.map((st) => ({ month: String(st.date || '').slice(0, 7), rate: Number(st.rate) })) } };
  }
  return null;
}
// The project's default world: the is_base scenario, else the earliest
// scenario, else null (flat world). This is the labeled default every
// projection uses when no scenario is explicitly picked — never a
// silent substitution: callers surface it as appliedScenario.
function planBaseScenario(projectId) {
  const rows = planScenariosOf(projectId);
  return rows.find((x) => x.is_base) || rows[0] || null;
}
function planStrategySink(strategy) {
  if (!strategy) return null;
  try { return strategy.sink ? JSON.parse(strategy.sink) : null; } catch { return null; }
}
// One-time migration of legacy strategy factors into scenarios, run on
// project read (same lazy pattern as planSeedLegacyBaseline) and on
// strategy/comparison reads. Strategies are grouped by their world
// factor set — the common case (one set) yields exactly ONE default
// scenario; distinct sets yield one per set, so nothing is silently
// lost. A strategy's sink moves to its sink column, never into a
// scenario. Runs inside one transaction; a structural migration, not a
// user Apply, so it writes no History commit.
function planMigrateStrategyFactors(projectId) {
  const strategies = db.prepare('SELECT * FROM plan_strategies WHERE project_id = ? AND factors IS NOT NULL').all(projectId);
  if (!strategies.length) return [];
  const groups = groupStrategyFactorsForMigration(strategies.map((st) => {
    let f = null;
    try { f = st.factors ? JSON.parse(st.factors) : null; } catch { f = null; }
    return { id: st.id, factors: f };
  }));
  if (!groups.length) {
    // Sink-only factors: move the sink, clear the column, no scenario.
    const move = db.transaction(() => {
      for (const st of strategies) {
        let f = null;
        try { f = st.factors ? JSON.parse(st.factors) : null; } catch { f = null; }
        if (f && f.sink) db.prepare('UPDATE plan_strategies SET sink = ?, factors = NULL, updated_at = ? WHERE id = ?').run(JSON.stringify(f.sink), nowIso(), st.id);
      }
    });
    move();
    return [];
  }
  const existingNames = new Set(planScenariosOf(projectId).map((x) => x.name));
  const created = [];
  const migrate = db.transaction(() => {
    const now = nowIso();
    const hasBase = planScenariosOf(projectId).some((x) => x.is_base);
    groups.forEach((g, gi) => {
      let name = g.name;
      let n = 2;
      while (existingNames.has(name)) { name = `${g.name} ${n}`; n += 1; }
      existingNames.add(name);
      const steps = g.factors && g.factors.prime && Array.isArray(g.factors.prime.points)
        ? g.factors.prime.points.map((pt) => ({ date: `${pt.month}-01`, rate: Number(pt.rate) })) : null;
      const info = db.prepare('INSERT INTO plan_scenarios (project_id, name, direction, stance, magnitude, steps, factors, is_base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, name, 'flat', 'neutral', null, steps ? JSON.stringify(steps) : null, JSON.stringify(g.factors), (!hasBase && gi === 0) ? 1 : 0, now, now);
      created.push(planScenarioRow(db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(info.lastInsertRowid)));
      for (const sid of g.strategyIds) {
        const st = strategies.find((x) => x.id === sid);
        let f = null;
        try { f = st.factors ? JSON.parse(st.factors) : null; } catch { f = null; }
        if (f && f.sink) db.prepare('UPDATE plan_strategies SET sink = ?, factors = NULL, updated_at = ? WHERE id = ?').run(JSON.stringify(f.sink), now, sid);
        else db.prepare('UPDATE plan_strategies SET factors = NULL, updated_at = ? WHERE id = ?').run(now, sid);
      }
    });
  });
  migrate();
  return created;
}
const PLAN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function planNextLetter(projectId) {
  const used = db.prepare('SELECT letter FROM plan_strategies WHERE project_id = ?').all(projectId).map((r) => r.letter);
  for (const ch of PLAN_LETTERS) if (!used.includes(ch)) return ch;
  return `${used.length + 1}`;
}
function planUnitsHeldAt(holdingId, dateStr, strategyId, beforeSeq) {
  const events = listEvents(db, holdingId);
  let u = unitsOn(events, dateStr);
  if (strategyId != null) {
    const ops = planOpsOf(strategyId).filter((o) => beforeSeq == null || o.seq < beforeSeq);
    for (const o of ops) {
      const p = o.params || {};
      if (Number(p.holdingId) !== Number(holdingId)) continue;
      if (String(p.date || '') > dateStr) continue;
      if (o.op_type === 'buy' || o.op_type === 'position') u += Number(p.units) || 0;
      if (o.op_type === 'sell') u -= Number(p.units) || 0;
    }
  }
  return Math.round(u * 10000) / 10000;
}
function planValidateStrategyOps(strategyId, ops, legs) {
  const errs = [];
  const currentMonth = currentMonthKey();
  for (const o of ops) {
    const ctx = { currentMonth };
    if (o.op_type === 'sell' && o.params && o.params.holdingId) {
      ctx.unitsAvailable = planUnitsHeldAt(Number(o.params.holdingId), String(o.params.date || ''), strategyId, o.seq);
    }
    if (o.op_type === 'buy' && o.params && o.params.price == null) {
      errs.push(`buy operation ${o.seq} needs a price — use Position for units without a price`);
    }
    errs.push(...validateOp(o, ctx));
  }
  errs.push(...validateLegs(ops, legs));
  return errs;
}

app.get('/api/planning/projects', requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM plan_projects WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  const out = rows.map((p) => {
    const strategies = db.prepare('SELECT * FROM plan_strategies WHERE project_id = ? ORDER BY id').all(p.id);
    let entity = null;
    try { entity = p.entity ? JSON.parse(p.entity) : null; } catch { entity = null; }
    return { ...p, strategies, stale: planSnapshotStale(p.snapshot), categoryLabels: planOptCategoryLabels(p.category, p.subcategory, entity), entityTags: planEntityTags(p.category, entity) };
  });
  res.json({ projects: out, sections: planListSections(out) });
});

// Template metadata validation: a template's required fields must be
// present and reference real rows. Returns an error string or null.
function planValidateProjectMetadata(template, metadata) {
  const schema = planProjectTemplate(template);
  if (!schema) return null;
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  for (const f of schema.fields) {
    if (!f.required) continue;
    const v = meta[f.key];
    if (v === undefined || v === null || v === '') return `${f.label} is required`;
  }
  if (meta.property_id !== undefined && meta.property_id !== null && meta.property_id !== '') {
    const row = db.prepare('SELECT id FROM properties WHERE id = ?').get(Number(meta.property_id));
    if (!row) return 'property not found';
  }
  if (meta.account_type !== undefined && meta.account_type !== null && meta.account_type !== ''
    && !['TFSA', 'RRSP', 'NonRegistered'].includes(meta.account_type)) {
    return 'account type must be TFSA, RRSP or NonRegistered';
  }
  return null;
}
function planProjectMetadataLabels(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const out = {};
  if (meta.property_id) {
    const row = db.prepare('SELECT address FROM properties WHERE id = ?').get(Number(meta.property_id));
    if (row) out.property_id = row.address;
  }
  if (meta.account_type) out.account_type = meta.account_type;
  return out;
}
function planProjectViewRow(p) {
  if (!p) return null;
  const metadata = p.metadata ? JSON.parse(p.metadata) : null;
  const entity = p.entity ? JSON.parse(p.entity) : null;
  // Categorized projects render the templated detail layout (baseline →
  // strategies → reports) with a synthesized schema: no category keeps
  // a legacy panel — prime scenarios are per-strategy factors now.
  let templateSchema = planProjectTemplate(p.template);
  if (!templateSchema && p.category) {
    const sub = planOptSubcategory(p.category, p.subcategory);
    const cat = planOptCategory(p.category);
    templateSchema = {
      key: 'categorized', label: sub ? sub.label : (cat ? cat.label : p.category),
      sections: { declaredAssets: false }, fields: [],
    };
  }
  return {
    ...p, metadata, entity, templateSchema,
    metadataLabels: planProjectMetadataLabels(metadata),
    categoryLabels: planOptCategoryLabels(p.category, p.subcategory, entity),
    baselines: planBaselinesOf(p.id),
    fixedBaseline: planFixedBaseline({ id: p.id, category: p.category, subcategory: p.subcategory, entity }),
  };
}
function planBaselineRow(b) {
  if (!b) return null;
  return { ...b, definition: b.definition ? JSON.parse(b.definition) : null, entity: b.entity ? JSON.parse(b.entity) : null };
}
function planBaselinesOf(projectId) {
  return db.prepare('SELECT * FROM plan_baselines WHERE project_id = ? ORDER BY id').all(projectId).map(planBaselineRow);
}
// One-time seed: a pre-multi-baseline project's single metadata
// baseline becomes its first list entry, so the list never loses it.
function planSeedLegacyBaseline(p) {
  const meta = p.metadata ? JSON.parse(p.metadata) : null;
  if (!meta || !meta.aiBaseline) return;
  if (db.prepare('SELECT id FROM plan_baselines WHERE project_id = ? LIMIT 1').get(p.id)) return;
  const now = nowIso();
  db.prepare('INSERT INTO plan_baselines (project_id, name, source, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, 'AI baseline', 'ai', JSON.stringify(meta.aiBaseline), now, now);
}
function planOptEntityLabel(entity) {
  if (!entity || typeof entity !== 'object') return '';
  try {
    if (entity.type === 'property' && entity.propertyId) {
      const row = db.prepare('SELECT address FROM properties WHERE id = ?').get(Number(entity.propertyId));
      return row ? row.address : '';
    }
    if (entity.type === 'pool') {
      const items = Array.isArray(entity.items) ? entity.items : [];
      const ids = new Set();
      for (const it of items) {
        if (it.accountId != null) {
          const hs = db.prepare('SELECT id FROM invest_holdings WHERE account_id = ?').all(Number(it.accountId));
          for (const h of hs) {
            if (unitsOn(listEvents(db, h.id), currentMonthKey()) > 0) ids.add(Number(h.id));
          }
        } else if (it.holdingId != null && unitsOn(listEvents(db, it.holdingId), currentMonthKey()) > 0) ids.add(Number(it.holdingId));
      }
      return `Pool · ${ids.size} stock${ids.size === 1 ? '' : 's'}`;
    }
    if (entity.type === 'account' || entity.type === 'holding') {
      const acc = db.prepare('SELECT name FROM invest_accounts WHERE id = ?').get(Number(entity.accountId));
      if (!acc) return '';
      if (entity.holdingId) {
        const h = db.prepare('SELECT symbol, label FROM invest_holdings WHERE id = ?').get(Number(entity.holdingId));
        return h ? `${acc.name} · ${h.symbol || h.label || ''}`.trim() : acc.name;
      }
      return acc.name;
    }
    if (entity.type === 'job' && entity.jobId) {
      const row = db.prepare('SELECT employer FROM earn_jobs WHERE id = ?').get(Number(entity.jobId));
      return row ? row.employer : '';
    }
    if (entity.type === 'rental' && entity.rentalId) {
      const row = db.prepare('SELECT name, address FROM earn_rentals WHERE id = ?').get(Number(entity.rentalId));
      return row ? (row.name || row.address || '') : '';
    }
    if (entity.type === 'all-spending') return 'All spending';
    if (entity.type === 'all-earnings') return 'All earnings';
  } catch { /* label falls back to empty */ }
  return '';
}
function planOptCategoryLabels(category, subcategory, entity) {
  if (!category) return null;
  const cat = planOptCategory(category);
  const sub = planOptSubcategory(category, subcategory);
  return {
    category: cat ? cat.label : category,
    subcategory: sub ? sub.label : (subcategory || ''),
    entity: planOptEntityLabel(entity),
  };
}
// Entity identity as tag pills for the list page (user 2026-11-06):
// a property project carries its property name; a cash-pool project
// carries its funding sources (one tag per source: account name,
// holding symbol, or External funding). Other categories carry their
// entity label (job employer, rental name, scope label); no entity
// means no tags.
function planEntityTags(category, entity) {
  if (!entity || typeof entity !== 'object') return [];
  if (entity.type === 'pool') {
    const tags = [];
    for (const it of Array.isArray(entity.items) ? entity.items : []) {
      if (it.source === 'external') tags.push('External funding');
      else if (it.accountId != null) {
        const acc = db.prepare('SELECT name FROM invest_accounts WHERE id = ?').get(Number(it.accountId));
        if (acc && acc.name) tags.push(acc.name);
      } else if (it.holdingId != null) {
        const h = db.prepare('SELECT symbol, label FROM invest_holdings WHERE id = ?').get(Number(it.holdingId));
        if (h && (h.symbol || h.label)) tags.push(h.symbol || h.label);
      }
    }
    return [...new Set(tags)];
  }
  const label = planOptEntityLabel(entity);
  return label ? [label] : [];
}
function planValidateOptEntity(category, entity) {
  if (!entity || typeof entity !== 'object') return 'entity is required';
  if (category === 'property') {
    if (entity.type !== 'property' || !entity.propertyId) return 'property is required';
    if (!db.prepare('SELECT id FROM properties WHERE id = ?').get(Number(entity.propertyId))) return 'property not found';
  } else if (category === 'investment') {
    if (entity.type === 'pool') {
      // User-defined cash pool: each source (an account or a holding)
      // contributes a percent OF THAT SOURCE or a CAD amount from it.
      // Contributions NEVER need to sum to 100% — the pool total is
      // simply their sum. Validation is hard and flagged, never
      // silent: every percent within 0–100% of its own source, every
      // amount not above its source's current value, every involved
      // holding with units priced (never an invented price).
      const shapeErr = validatePoolItemShapes(entity.items);
      if (shapeErr) return shapeErr;
      const items = entity.items;
      const fxRow = db.prepare('SELECT rate FROM invest_fx_rates ORDER BY date DESC LIMIT 1').get();
      const fx = fxRow ? fxRow.rate : 1;
      const holdingValueCad = (hid) => {
        const h = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(Number(hid));
        if (!h) return { error: 'pool holding not found' };
        const units = unitsOn(listEvents(db, h.id), currentMonthKey());
        const pts = listPricePoints(db, h.id).filter((pt) => String(pt.date) <= vancouverToday());
        if (units > 0 && !pts.length) return { error: `pool holding ${h.symbol || h.label || ''} has no current price` };
        const price = pts.length ? pts[pts.length - 1].price : null;
        const value = price != null ? units * price : 0;
        return { holding: h, units, price, valueCad: h.currency === 'USD' ? value * fx : value };
      };
      // Account items first: the holdings they cover cannot also be
      // picked directly (that would double-count one source).
      const coveredHoldings = new Set();
      for (const it of items) {
        if (it.accountId == null) continue;
        if (!db.prepare('SELECT id FROM invest_accounts WHERE id = ?').get(Number(it.accountId))) return 'pool account not found';
        const hs = db.prepare('SELECT id FROM invest_holdings WHERE account_id = ?').all(Number(it.accountId));
        if (!hs.length) return 'pool account has no holdings';
        for (const h of hs) coveredHoldings.add(Number(h.id));
      }
      let total = 0;
      for (const it of items) {
        // External funding adds its amount straight to the pool —
        // no holding or account value to check against.
        if (it.source === 'external') { total += Number(it.amount); continue; }
        if (it.accountId != null) {
          const hs = db.prepare('SELECT id FROM invest_holdings WHERE account_id = ?').all(Number(it.accountId));
          let accountValue = 0;
          for (const h of hs) {
            const v = holdingValueCad(h.id);
            if (v.error) return v.error;
            accountValue += v.valueCad;
          }
          if (it.percent != null) total += accountValue * Number(it.percent) / 100;
          else {
            if (Number(it.amount) > accountValue + 0.005) return 'pool amount exceeds its account value';
            total += Number(it.amount);
          }
        } else {
          if (coveredHoldings.has(Number(it.holdingId))) return 'pool holding is already covered by a picked account';
          const v = holdingValueCad(it.holdingId);
          if (v.error) return v.error;
          if (it.percent != null) total += v.valueCad * Number(it.percent) / 100;
          else {
            if (Number(it.amount) > v.valueCad + 0.005) return 'pool amount exceeds its holding value';
            total += Number(it.amount);
          }
        }
      }
      if (!(total > 0)) return 'pool contributions add up to 0';
    } else if ((entity.type !== 'account' && entity.type !== 'holding') || !entity.accountId) return 'account is required';
    else {
      if (!db.prepare('SELECT id FROM invest_accounts WHERE id = ?').get(Number(entity.accountId))) return 'account not found';
      if (entity.type === 'holding' || entity.holdingId) {
        if (!entity.holdingId) return 'holding is required';
        const h = db.prepare('SELECT id, account_id FROM invest_holdings WHERE id = ?').get(Number(entity.holdingId));
        if (!h) return 'holding not found';
        if (Number(h.account_id) !== Number(entity.accountId)) return 'holding is not in this account';
      }
    }
  } else if (category === 'earning') {
    if (entity.type === 'job') {
      if (!entity.jobId || !db.prepare('SELECT id FROM earn_jobs WHERE id = ?').get(Number(entity.jobId))) return 'job not found';
    } else if (entity.type === 'rental') {
      if (!entity.rentalId || !db.prepare('SELECT id FROM earn_rentals WHERE id = ?').get(Number(entity.rentalId))) return 'rental not found';
    } else return 'job or rental is required';
  } else if (category === 'saving') {
    if (entity.type !== 'all-spending') return 'saving scope is all spending';
  } else if (category === 'tax_saving') {
    if (entity.type !== 'all-earnings') return 'tax saving scope is all earnings';
  } else return 'unknown category';
  return null;
}
// Subcategory recommendations, computed from the picked entity's REAL
// figures at request time — never generic template numbers. The baseline
// is the do-nothing reference (it changes nothing; its figures are just
// the current position for display); the strategy is the optimization
// direction. Charts and comparisons still come from the projection
// engine replaying the project's ops against live mainline data, never
// from these figures.
function planRecommendationFor(category, subcategory, entity) {
  const sub = planOptSubcategory(category, subcategory);
  if (!sub) return { error: 'unknown subcategory' };
  const entErr = planValidateOptEntity(category, entity);
  if (entErr) return { error: entErr };
  const label = planOptEntityLabel(entity);
  if (category === 'property') {
    const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(Number(entity.propertyId));
    const seg = db.prepare('SELECT * FROM rate_segments WHERE property_id = ? ORDER BY start_date DESC, id DESC LIMIT 1').get(Number(entity.propertyId));
    const cur = getCurrentPrime();
    let rate = seg ? seg.annual_rate : null;
    if (rate == null && seg && seg.rate_type === 'prime_spread' && cur) rate = cur.rate + (Number(seg.spread) || 0);
    const balance = prop.mortgage_balance ?? null;
    const figures = { balance, rate };
    return {
      baseline: { name: `Current path · ${label}`, description: `Stay on the current path for ${label}`, figures },
      strategy: { name: `${sub.strategyLabel} · ${label}`, summary: `Bound to ${label}`, template_params: { category, subcategory, entity, opType: sub.opType, propertyId: Number(entity.propertyId) } },
    };
  }
  if (category === 'investment' && entity.type === 'pool') {
    // The baseline's starting position IS the pool: its figures are the
    // pool's current value and per-item contributions (a percent OF
    // ITS OWN SOURCE, or a CAD amount from it). The strategy is the
    // buy list the user builds on the strategy page (buys of a stock
    // or a custom product); the recommendation carries only the
    // binding.
    const fxRow = db.prepare('SELECT rate FROM invest_fx_rates ORDER BY date DESC LIMIT 1').get();
    const fx = fxRow ? fxRow.rate : 1;
    let poolTotal = 0;
    const items = [];
    const stockIds = new Set();
    const holdingDetail = (hid) => {
      const h = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(Number(hid));
      const acc = db.prepare('SELECT name FROM invest_accounts WHERE id = ?').get(Number(h.account_id));
      const units = unitsOn(listEvents(db, h.id), currentMonthKey());
      const pts = listPricePoints(db, h.id).filter((pt) => String(pt.date) <= vancouverToday());
      const price = pts.length ? pts[pts.length - 1].price : null;
      const valueNative = price != null ? Math.round(units * price * 100) / 100 : 0;
      return { h, account: acc ? acc.name : '', units, price, valueCad: h.currency === 'USD' ? valueNative * fx : valueNative };
    };
    for (const it of entity.items) {
      if (it.source === 'external') {
        const contribution = Number(it.amount);
        poolTotal += contribution;
        items.push({ source: 'external', amount: contribution, value: contribution });
      } else if (it.accountId != null) {
        const acc = db.prepare('SELECT name FROM invest_accounts WHERE id = ?').get(Number(it.accountId));
        const hs = db.prepare('SELECT id FROM invest_holdings WHERE account_id = ?').all(Number(it.accountId));
        const details = hs.map((row) => holdingDetail(row.id)).filter((d) => d.units > 0);
        const accountValue = details.reduce((s, d) => s + d.valueCad, 0);
        const contribution = it.percent != null
          ? Math.round(accountValue * Number(it.percent) / 100 * 100) / 100
          : Number(it.amount);
        poolTotal += contribution;
        for (const d of details) stockIds.add(d.h.id);
        items.push({ accountId: Number(it.accountId), account: acc ? acc.name : '', percent: it.percent != null ? Number(it.percent) : undefined, amount: it.amount != null ? Number(it.amount) : undefined, value: contribution, holdings: details.map((d) => ({ holdingId: d.h.id, symbol: d.h.symbol || d.h.label || '', units: d.units, price: d.price })) });
      } else {
        const d = holdingDetail(it.holdingId);
        const contribution = it.percent != null
          ? Math.round(d.valueCad * Number(it.percent) / 100 * 100) / 100
          : Number(it.amount);
        poolTotal += contribution;
        stockIds.add(d.h.id);
        items.push({ holdingId: Number(it.holdingId), symbol: d.h.symbol || d.h.label || '', account: d.account, percent: it.percent != null ? Number(it.percent) : undefined, amount: it.amount != null ? Number(it.amount) : undefined, units: d.units, price: d.price, value: contribution });
      }
    }
    const figures = { poolValue: Math.round(poolTotal * 100) / 100, stockCount: stockIds.size, items };
    return {
      baseline: { name: label, description: `Hold the pool as-is`, figures },
      strategy: { name: `${sub.strategyLabel} · ${label}`, summary: `Buys: add buys on the strategy page`, template_params: { category, subcategory, entity, opType: 'buy', sinkKind: subcategory === 'gic' ? 'custom' : 'stock', sinkLabel: label, summary: `Pool → buys (add buys on the strategy page)` } },
    };
  }
  if (category === 'investment') {
    const acc = db.prepare('SELECT * FROM invest_accounts WHERE id = ?').get(Number(entity.accountId));
    let figures = {};
    let sinkLabel = acc.name;
    let sink = { type: subcategory === 'gic' ? 'gic' : 'account', accountId: Number(entity.accountId) };
    if (entity.holdingId) {
      const h = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(Number(entity.holdingId));
      const units = unitsOn(listEvents(db, h.id), currentMonthKey());
      const pts = listPricePoints(db, h.id).filter((pt) => String(pt.date) <= vancouverToday());
      const price = pts.length ? pts[pts.length - 1].price : null;
      figures = { units, price, value: price != null ? Math.round(units * price * 100) / 100 : null };
      sinkLabel = h.symbol || h.label || acc.name;
      sink = { type: 'holding', holdingId: Number(entity.holdingId), accountId: Number(entity.accountId) };
    } else {
      const holdings = listHoldings(db, acc.id);
      let total = 0;
      for (const h of holdings) {
        const units = unitsOn(listEvents(db, h.id), currentMonthKey());
        const pts = listPricePoints(db, h.id).filter((pt) => String(pt.date) <= vancouverToday());
        if (pts.length) total += units * pts[pts.length - 1].price;
      }
      figures = { value: Math.round(total * 100) / 100 };
    }
    return {
      baseline: { name: `Current plan · ${sinkLabel}`, description: `Keep the current plan for ${sinkLabel}`, figures },
      strategy: { name: `${sub.strategyLabel} · ${sinkLabel}`, summary: `Source: cash pot → Buys: ${sinkLabel}`, template_params: { category, subcategory, entity, opType: 'buy', source: 'pot', sink, sinkLabel, summary: `Source: cash pot → Buys: ${sinkLabel}` } },
    };
  }
  if (category === 'earning' && entity.type === 'job') {
    const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(Number(entity.jobId));
    const periods = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, annual: 1 }[job.frequency] || 12;
    const annualGross = job.gross_basis === 'annual' ? job.gross_amount : job.gross_amount * periods;
    return {
      baseline: { name: `Current pay · ${label}`, description: `Keep the current pay for ${label}`, figures: { annualGross, frequency: job.frequency } },
      strategy: { name: `${sub.strategyLabel} · ${label}`, summary: `Bound to ${label}`, template_params: { category, subcategory, entity, jobId: Number(entity.jobId) } },
    };
  }
  if (category === 'earning' && entity.type === 'rental') {
    const yr = db.prepare('SELECT * FROM earn_rental_years WHERE rental_id = ? ORDER BY tax_year DESC LIMIT 1').get(Number(entity.rentalId));
    const figures = yr ? { taxYear: yr.tax_year, gross: yr.gross_rents, net: yr.net ?? null } : {};
    return {
      baseline: { name: `Current rents · ${label}`, description: `Keep the current rents for ${label}`, figures },
      strategy: { name: `${sub.strategyLabel} · ${label}`, summary: `Bound to ${label}`, template_params: { category, subcategory, entity, rentalId: Number(entity.rentalId) } },
    };
  }
  if (category === 'saving') {
    const cur = currentMonthKey();
    const [y, m] = cur.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    from.setUTCMonth(from.getUTCMonth() - 11);
    const fromKey = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = db.prepare(`SELECT COALESCE(SUM(-amount), 0) AS total FROM spend_transactions WHERE amount < 0 AND kind != 'adjustment' AND substr(date, 1, 7) >= ?`).get(fromKey);
    return {
      baseline: { name: 'Current spending', description: 'Keep the current spending pattern', figures: { spent12m: Math.round((row.total || 0) * 100) / 100 } },
      strategy: { name: 'Spending analysis', summary: 'Scope: all spending cards', template_params: { category, subcategory, entity, scope: 'all-spending' } },
    };
  }
  if (category === 'tax_saving') {
    const jobs = db.prepare('SELECT COUNT(*) AS n FROM earn_jobs').get().n;
    const rentals = db.prepare('SELECT COUNT(*) AS n FROM earn_rentals').get().n;
    return {
      baseline: { name: 'Current tax position', description: 'Keep the current earnings and tax position', figures: { jobs, rentals } },
      strategy: { name: 'Tax analysis', summary: 'Scope: all earnings', template_params: { category, subcategory, entity, scope: 'all-earnings' } },
    };
  }
  return { error: 'unknown category' };
}

// The FIXED baseline (user 2026-11-04): the current do-nothing
// state, never user-added. The engine already treats every baseline
// as the do-nothing reference (comparison endpoint: a chosen
// baselineId is numerically inert, only a label), so the fixed
// baseline is a live computation from current stored data, not a
// record: name + description from the recommendation's do-nothing
// baseline, facts per category from the same sources the engine
// uses. recordId points at the project's recommendation-source
// baseline record when one exists (report pins keep working);
// legacy AI/manual records are never the fixed baseline.
function planFixedBaseline(view) {
  const category = view.category;
  // The baseline figures are identical across a category's
  // subcategories (only the strategy differs), so a project with no
  // subcategory (baseline-only creation, user 2026-11-05) reads its
  // baseline off the category's first subcategory.
  const subcategory = view.subcategory || planFirstSubcategory(category);
  const entity = view.entity;
  if (!category || !entity) return null;
  const rec = planRecommendationFor(category, subcategory, entity);
  if (!rec || rec.error) return null;
  const label = planOptEntityLabel(entity);
  let recordId = null;
  if (view.id) {
    const rows = db.prepare('SELECT id, source FROM plan_baselines WHERE project_id = ? ORDER BY id').all(view.id);
    const fixed = rows.find((r) => r.source === 'recommendation');
    recordId = fixed ? fixed.id : null;
  }
  const base = { name: rec.baseline.name, description: rec.baseline.description, recordId, kind: category };
  const figs = rec.baseline.figures || {};
  if (category === 'property') {
    const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(Number(entity.propertyId));
    if (!prop) return null;
    const seg = db.prepare('SELECT * FROM rate_segments WHERE property_id = ? ORDER BY start_date DESC, id DESC LIMIT 1').get(Number(entity.propertyId));
    let rateLabel = '—';
    if (seg) {
      if (seg.rate_type === 'fixed') rateLabel = `${seg.annual_rate}% fixed`;
      else if (seg.rate_mode === 'prime_spread') rateLabel = `Prime ${Number(seg.spread) >= 0 ? '+' : ''}${seg.spread}`;
      else if (seg.annual_rate != null) rateLabel = `${seg.annual_rate}% variable`;
    }
    // Monthly payment + remaining balance: the same schedule the
    // property page projects (paymentUsed, balance at current month).
    let payment = null; let outstanding = prop.mortgage_balance ?? null;
    const balance = prop.mortgage_balance > 0 ? prop.mortgage_balance : 0;
    const segments = segmentsOf(prop.id);
    if (balance > 0 && segments.length) {
      const prime = getCurrentPrime();
      const primeRate = prime ? prime.rate : null;
      const primeBlocked = primeRate === null && segments.some((s) => s.rate_type === 'variable' && s.rate_mode === 'prime_spread');
      if (!primeBlocked) {
        const { frequency, paymentDay } = termScheduleOf(prop);
        const r = buildSchedule({
          balance, balanceDate: prop.mortgage_balance_date || vancouverToday(),
          terms: termsOf(prop.id), segments, lumpSums: lumpSumsOf(prop.id),
          paymentDay, frequency, primeRate, primeHistory: getPrimeHistory(), region: prop.region || 'CA',
        });
        if (r.state === 'projected') {
          payment = r.paymentUsed;
          outstanding = remainingBalanceAt(r.series, currentMonthKey(), balance, r.payoffMonth).balance;
        }
      }
    }
    return { ...base, address: label, rateType: seg ? seg.rate_type : null, rateLabel, balance: figs.balance ?? null, payment, outstanding };
  }
  if (category === 'investment') {
    // Expected return per holding: the baseline's own rule — first
    // available annualized window, 1y → 3y → 5y price CAGR, never
    // invented (a holding with < 2 points carries no return).
    const holdingIds = new Set();
    if (entity.type === 'pool') {
      for (const it of entity.items || []) {
        if (it.holdingId != null) holdingIds.add(Number(it.holdingId));
        else if (it.accountId != null) {
          for (const h of db.prepare('SELECT id FROM invest_holdings WHERE account_id = ?').all(Number(it.accountId))) holdingIds.add(h.id);
        }
      }
    } else if (entity.holdingId) holdingIds.add(Number(entity.holdingId));
    else if (entity.accountId) {
      for (const h of db.prepare('SELECT id FROM invest_holdings WHERE account_id = ?').all(Number(entity.accountId))) holdingIds.add(h.id);
    }
    const returns = [];
    for (const hid of holdingIds) {
      const h = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(hid);
      if (!h) continue;
      const units = unitsOn(listEvents(db, hid), currentMonthKey());
      if (!(units > 0)) continue;
      const pts = listPricePoints(db, hid).filter((pt) => String(pt.date) <= vancouverToday());
      const sug = returnSuggestionsFromPoints(pts, currentMonthKey());
      const win = sug.find((s) => s.annualizedReturn != null);
      if (win) returns.push({ holdingId: hid, label: h.symbol || h.label || '', pct: Math.round(win.annualizedReturn * 10000) / 100, basis: win.basis || null, window: win.window || null });
    }
    return { ...base, label, figures: figs, returns };
  }
  if (category === 'earning') {
    if (entity.type === 'job') {
      const job = db.prepare('SELECT * FROM earn_jobs WHERE id = ?').get(Number(entity.jobId));
      if (!job) return null;
      return { ...base, label, employer: job.employer, annualGross: figs.annualGross ?? null, frequency: job.frequency };
    }
    const rental = db.prepare('SELECT * FROM earn_rentals WHERE id = ?').get(Number(entity.rentalId));
    if (!rental) return null;
    return { ...base, label: rental.label || label, taxYear: figs.taxYear ?? null, gross: figs.gross ?? null, net: figs.net ?? null };
  }
  if (category === 'saving') return { ...base, spent12m: figs.spent12m ?? null };
  if (category === 'tax_saving') return { ...base, jobs: figs.jobs ?? null, rentals: figs.rentals ?? null };
  return base;
}

app.post('/api/planning/projects', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'project name is required' });
  const template = b.template ? String(b.template) : null;
  if (template && template !== 'blank' && !planProjectTemplate(template)) {
    return res.status(400).json({ error: 'unknown project template' });
  }
  const metadata = b.metadata && typeof b.metadata === 'object' ? b.metadata : null;
  const metaErr = planValidateProjectMetadata(template, metadata);
  if (metaErr) return res.status(400).json({ error: metaErr });
  // Optimization category: validated taxonomy + entity binding. The
  // category is immutable after creation (PUT rejects any change).
  const category = b.category ? String(b.category) : null;
  const subcategory = b.subcategory ? String(b.subcategory) : null;
  const entity = b.entity && typeof b.entity === 'object' ? b.entity : null;
  if (category || subcategory || entity) {
    if (!planOptCategory(category)) return res.status(400).json({ error: 'unknown optimization category' });
    // Subcategory is optional now (user 2026-11-05): the creation
    // flow no longer picks one, so a new project carries NULL and
    // creates baseline-only. An explicitly given subcategory must
    // still be valid for the category.
    if (subcategory && !planOptSubcategory(category, subcategory)) return res.status(400).json({ error: 'unknown subcategory for this category' });
    const entErr = planValidateOptEntity(category, entity);
    if (entErr) return res.status(400).json({ error: entErr });
  }
  let rec = null;
  if (b.applyRecommendation) {
    if (!category) return res.status(400).json({ error: 'category is required to apply a recommendation' });
    rec = planRecommendationFor(category, subcategory, entity);
    if (rec.error) return res.status(400).json({ error: rec.error });
  }
  const now = nowIso();
  const snap = JSON.stringify(planSnapshotMainline());
  const insertProject = db.transaction(() => {
    const info = db.prepare('INSERT INTO plan_projects (user_id, name, question, snapshot, template, metadata, category, subcategory, entity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, String(b.name).trim(), b.question ? String(b.question).trim() : null, snap, template, metadata ? JSON.stringify(metadata) : null, category, subcategory, entity ? JSON.stringify(entity) : null, now, now);
    const pid = info.lastInsertRowid;
    // No scenario rows are seeded: rate paths live on strategies as
    // factors now, and the baseline is the do-nothing reference.
    if (rec) {
      db.prepare('INSERT INTO plan_baselines (project_id, name, source, category, subcategory, entity, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(pid, rec.baseline.name, 'recommendation', category, subcategory, JSON.stringify(entity), JSON.stringify(rec.baseline), now, now);
      db.prepare('INSERT INTO plan_strategies (project_id, name, letter, source, template, template_params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(pid, rec.strategy.name, 'A', 'template', 'recommendation', JSON.stringify(rec.strategy.template_params), now, now);
    } else if (category) {
      // Fixed baseline auto-set even without a recommendation: the
      // do-nothing current state, no figures invented.
      db.prepare('INSERT INTO plan_baselines (project_id, name, source, category, subcategory, entity, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(pid, 'Current state', 'fixed', category, subcategory, JSON.stringify(entity), JSON.stringify({ name: 'Current state', description: 'Do nothing — current state', figures: {} }), now, now);
    }
    return pid;
  });
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: null,
    entityLabel: String(b.name).trim(), summary: `Created project ${String(b.name).trim()}`,
  }, () => {
    const pid = insertProject();
    return { value: { project: planProjectViewRow(planProjectById(pid, req.user.id)) }, entityId: pid };
  });
  res.status(201).json(out);
});

app.get('/api/planning/projects/:id', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  planSeedLegacyBaseline(p);
  planMigrateStrategyFactors(p.id);
  const strategies = db.prepare('SELECT * FROM plan_strategies WHERE project_id = ? ORDER BY id').all(p.id);
  // Routing marker for the flow: an AI-designed strategy is one whose
  // attached model row carries source 'ai' (strategy.source alone is
  // NOT reliable — template-created strategies also carry 'ai').
  const modelSources = new Map(db.prepare('SELECT id, source FROM plan_ai_models WHERE project_id = ?').all(p.id).map((m) => [m.id, m.source]));
  for (const s of strategies) s.modelSource = s.model_id ? (modelSources.get(s.model_id) || null) : null;
  const scenarios = db.prepare('SELECT * FROM plan_scenarios WHERE project_id = ? ORDER BY id').all(p.id).map(planScenarioRow);
  const declaredAssets = db.prepare('SELECT * FROM plan_declared_assets WHERE project_id = ? ORDER BY id').all(p.id);
  const reports = db.prepare('SELECT * FROM plan_reports WHERE project_id = ? ORDER BY id').all(p.id).map((r) => ({
    ...r,
    definition: JSON.parse(r.definition || '{}'),
    // scenarioIds: null = legacy row saved before pinning (the view
    // prompts to pin); [] = flat world on a scenario-less project.
    scenarioIds: r.scenario_ids ? JSON.parse(r.scenario_ids) : null,
    stale: strategies.some((s) => s.updated_at > r.updated_at) ? 1 : 0,
  }));
  const history = db.prepare(
    `SELECT m.*, s.name AS strategy_name FROM plan_merge_records m
     JOIN plan_strategies s ON s.id = m.strategy_id
     WHERE s.project_id = ? ORDER BY m.id DESC`).all(p.id)
    .map((m) => ({ ...m, entries: JSON.parse(m.entries || '[]'), conflicts: m.conflicts ? JSON.parse(m.conflicts) : null }));
  res.json({ project: planProjectViewRow(p), strategies, scenarios, declaredAssets, reports, history, stale: planSnapshotStale(p.snapshot) });
});

app.put('/api/planning/projects/:id', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  // Optimization category is immutable once chosen at creation.
  if (b.category !== undefined || b.subcategory !== undefined || b.entity !== undefined) {
    return res.status(400).json({ error: 'optimization category cannot be changed after creation' });
  }
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'project name is required' });
  let metadata = p.metadata ? JSON.parse(p.metadata) : null;
  if (b.metadata !== undefined) {
    if (b.metadata !== null && typeof b.metadata !== 'object') return res.status(400).json({ error: 'metadata must be an object' });
    metadata = b.metadata;
    const metaErr = planValidateProjectMetadata(p.template, metadata);
    if (metaErr) return res.status(400).json({ error: metaErr });
  }
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: b.name !== undefined ? String(b.name).trim() : p.name,
    summary: `Updated project ${b.name !== undefined ? String(b.name).trim() : p.name}`,
  }, () => {
    db.prepare('UPDATE plan_projects SET name = ?, question = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(b.name !== undefined ? String(b.name).trim() : p.name, b.question !== undefined ? (b.question ? String(b.question).trim() : null) : p.question, metadata ? JSON.stringify(metadata) : null, nowIso(), p.id);
    return { value: { project: planProjectViewRow(planProjectById(p.id, req.user.id)) }, entityId: p.id };
  });
  res.json(out);
});

// Optimization taxonomy (labels only; figures come from the
// recommendation endpoint, computed per entity).
app.get('/api/planning/categories', requireApiAuth, (req, res) => {
  const categories = Object.values(PLAN_OPT_CATEGORIES).map((c) => ({
    key: c.key, label: c.label, entityType: c.entityType,
    subcategories: Object.values(c.subcategories).map((s) => ({ key: s.key, label: s.label, strategyLabel: s.strategyLabel })),
  }));
  res.json({ categories });
});
// All subcategory recommendations for one picked entity, in one call
// (the creation flow shows every subcategory card with its figures).
app.post('/api/planning/recommendations', requireApiAuth, (req, res) => {
  const b = req.body || {};
  const category = b.category ? String(b.category) : null;
  const entity = b.entity && typeof b.entity === 'object' ? b.entity : null;
  if (!planOptCategory(category)) return res.status(400).json({ error: 'unknown optimization category' });
  const entErr = planValidateOptEntity(category, entity);
  if (entErr) return res.status(400).json({ error: entErr });
  const out = {};
  for (const sub of Object.values(PLAN_OPT_CATEGORIES[category].subcategories)) {
    const rec = planRecommendationFor(category, sub.key, entity);
    // Templates carry a recommended scenario/baseline/strategy; a slot
    // with no recommendation stays EMPTY. No subcategory has a genuine
    // scenario recommendation from data today, so the slot is null —
    // the creation flow renders it as an empty line, never a guess.
    if (!rec.error) out[sub.key] = { ...rec, scenario: rec.scenario ?? null };
  }
  res.json({ category, entity, recommendations: out });
});
// Baseline list: append-only. Every creation appends a row; nothing
// here ever overwrites another entry.
app.post('/api/planning/projects/:id/baselines', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  const def = b.definition && typeof b.definition === 'object' ? b.definition : null;
  if (!def) return res.status(400).json({ error: 'definition is required' });
  def.stockReference = 'current-plan';
  const errs = validateAiBaseline(def);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Added baseline · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_baselines (project_id, name, source, category, subcategory, entity, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, b.name ? String(b.name).trim() : 'Baseline', b.source ? String(b.source) : 'manual', b.category ? String(b.category) : p.category, b.subcategory ? String(b.subcategory) : p.subcategory, b.entity ? JSON.stringify(b.entity) : (p.entity || null), JSON.stringify(def), now, now);
    return { value: { baseline: planBaselineRow(db.prepare('SELECT * FROM plan_baselines WHERE id = ?').get(info.lastInsertRowid)) }, entityId: p.id };
  });
  res.status(201).json(out);
});
app.put('/api/planning/projects/:id/baselines/:bid', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const row = db.prepare('SELECT * FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(req.params.bid), p.id);
  if (!row) return res.status(404).json({ error: 'baseline not found' });
  const b = req.body || {};
  const cur = planBaselineRow(row);
  let def = cur.definition;
  if (b.definition !== undefined) {
    if (!b.definition || typeof b.definition !== 'object') return res.status(400).json({ error: 'definition must be an object' });
    def = { ...def, ...b.definition };
    def.stockReference = 'current-plan';
    const errs = validateAiBaseline(def);
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  }
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Updated baseline · ${p.name}`,
  }, () => {
    db.prepare('UPDATE plan_baselines SET name = ?, definition = ?, updated_at = ? WHERE id = ?')
      .run(b.name !== undefined ? String(b.name).trim() : row.name, JSON.stringify(def), nowIso(), row.id);
    return { value: { baseline: planBaselineRow(db.prepare('SELECT * FROM plan_baselines WHERE id = ?').get(row.id)) }, entityId: p.id };
  });
  res.json(out);
});
app.delete('/api/planning/projects/:id/baselines/:bid', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const row = db.prepare('SELECT * FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(req.params.bid), p.id);
  if (!row) return res.status(404).json({ error: 'baseline not found' });
  // A report drafted against this baseline loses its selection (never
  // silently falls back); the user re-picks in the report view.
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Deleted baseline · ${p.name}`,
  }, () => {
    const cleared = db.prepare('UPDATE plan_reports SET baseline_id = NULL, baseline_cleared = 1 WHERE project_id = ? AND baseline_id = ?').run(p.id, row.id);
    db.prepare('DELETE FROM plan_baselines WHERE id = ?').run(row.id);
    return { value: { ok: true, clearedReports: cleared.changes }, entityId: p.id };
  });
  res.json(out);
});

app.delete('/api/planning/projects/:id', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Deleted project ${p.name}`,
  }, () => {
    db.prepare('DELETE FROM plan_projects WHERE id = ?').run(p.id);
    return { value: { ok: true }, entityId: p.id };
  });
  res.json({ ok: true });
});

// Rebase: refresh the project's baseline snapshot to today's mainline.
// Projections recompute from the new baseline; strategies themselves
// are untouched (their ops still replay in order).
app.post('/api/planning/projects/:id/sync', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Synced latest mainline · ${p.name}`,
  }, () => {
    db.prepare('UPDATE plan_projects SET snapshot = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(planSnapshotMainline()), nowIso(), p.id);
    return { value: { project: planProjectById(p.id, req.user.id), stale: false }, entityId: p.id };
  });
  res.json(out);
});

app.post('/api/planning/projects/:id/scenarios', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'scenario name is required' });
  const direction = b.direction === undefined || b.direction === null || b.direction === '' ? 'flat' : b.direction;
  if (!['up', 'flat', 'down'].includes(direction)) return res.status(400).json({ error: 'direction must be up, flat or down' });
  if (b.steps !== undefined && b.steps !== null && !Array.isArray(b.steps)) return res.status(400).json({ error: 'steps must be an array of {date, rate}' });
  let factors = null;
  if (b.factors !== undefined && b.factors !== null) {
    if (typeof b.factors !== 'object' || Array.isArray(b.factors)) return res.status(400).json({ error: 'factors must be an object' });
    const errs = validateScenarioFactors(b.factors, currentMonthKey());
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    factors = b.factors;
  }
  // steps mirrors the prime points: one path, not two diverging ones.
  let steps = b.steps || null;
  if (factors && factors.prime && Array.isArray(factors.prime.points)) {
    steps = factors.prime.points.map((pt) => ({ date: `${pt.month}-01`, rate: Number(pt.rate) }));
  }
  const now = nowIso();
  // The first scenario a project ever gets becomes its base, so detail
  // and comparison defaults work without an extra step.
  const isBase = planScenariosOf(p.id).some((x) => x.is_base) ? 0 : 1;
  const info = db.prepare('INSERT INTO plan_scenarios (project_id, name, direction, stance, magnitude, steps, factors, is_base, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, String(b.name).trim(), direction, b.stance || 'neutral', b.magnitude != null ? Number(b.magnitude) : null, steps ? JSON.stringify(steps) : null, factors ? JSON.stringify(factors) : null, isBase, b.source === 'ai' ? 'ai' : null, now, now);
  res.status(201).json({ scenario: planScenarioRow(db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(info.lastInsertRowid)) });
});

// Scenario detail + rename/factors save. A factor never added is never
// saved: the client sends only the active set, and this endpoint stores
// exactly what it receives.
app.get('/api/planning/scenarios/:id', requireApiAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'scenario not found' });
  const p = planProjectById(row.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  // Prime steps in a past month never reach a projection (the merge
  // drops them) — name them here so the scenario page can warn
  // instead of advertising a rise that does not apply. The row is
  // raw: parse it first (planScenarioFactorsOfRow takes a parsed row).
  await ensureFreshPrime();
  const droppedPrimeSteps = droppedScenarioPrimeSteps(getPrimeHistory(), primeFactorToScenario(planScenarioFactorsOfRow(planScenarioRow(row))), currentMonthKey())
    .map((d) => ({ date: d.date, rate: d.rate, message: primeStepDroppedMessage(d) }));
  res.json({ scenario: planScenarioRow(row), project: p, droppedPrimeSteps });
});
app.put('/api/planning/scenarios/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'scenario not found' });
  const p = planProjectById(row.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  const now = nowIso();
  let name = row.name;
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: 'scenario name is required' });
    name = String(b.name).trim();
  }
  let factorsSql = row.factors;
  let stepsSql = row.steps;
  if (b.factors !== undefined && b.factors !== null) {
    if (typeof b.factors !== 'object' || Array.isArray(b.factors)) return res.status(400).json({ error: 'factors must be an object' });
    const errs = validateScenarioFactors(b.factors, currentMonthKey());
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    factorsSql = JSON.stringify(b.factors);
    stepsSql = b.factors.prime && Array.isArray(b.factors.prime.points)
      ? JSON.stringify(b.factors.prime.points.map((pt) => ({ date: `${pt.month}-01`, rate: Number(pt.rate) }))) : null;
  }
  db.prepare('UPDATE plan_scenarios SET name = ?, factors = ?, steps = ?, updated_at = ? WHERE id = ?').run(name, factorsSql, stepsSql, now, row.id);
  res.json({ scenario: planScenarioRow(db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(row.id)) });
});

// Scenario AI hook: the model proposes a factor set in words the user
// gives; the app validates it and the client previews it before any
// Apply creates the scenario. AI is spec, never numbers — the engine
// computes every figure from the saved factors.
// Shared AI-design inputs: the FULL app snapshot (properties, terms,
// segments, accounts, holdings, jobs, rentals, prime + history) plus
// the project's existing scenario/baseline/strategy summaries, so the
// model refines what exists instead of duplicating it.
async function planAiSnapshotForProject() {
  await ensureFreshPrime();
  const curPrime = getCurrentPrime();
  return buildPlanAiSnapshot({
    properties: db.prepare('SELECT * FROM properties ORDER BY id').all(),
    terms: db.prepare('SELECT * FROM mortgage_terms ORDER BY id').all(),
    segments: db.prepare('SELECT * FROM rate_segments ORDER BY id').all(),
    accounts: db.prepare('SELECT * FROM invest_accounts ORDER BY id').all(),
    holdings: db.prepare('SELECT * FROM invest_holdings ORDER BY id').all(),
    jobs: db.prepare('SELECT * FROM earn_jobs ORDER BY id').all(),
    rentals: db.prepare('SELECT * FROM earn_rentals ORDER BY id').all().map(earnRentalRow),
    prime: curPrime ? curPrime.rate : null,
    primeHistory: getPrimeHistory(),
  });
}
function planAiExistingSummaries(projectId) {
  const scenarios = planScenariosOf(projectId);
  const baselines = planBaselinesOf(projectId);
  const strategies = db.prepare('SELECT * FROM plan_strategies WHERE project_id = ? ORDER BY id').all(projectId);
  const opsByStrategy = {};
  for (const s of strategies) opsByStrategy[s.id] = db.prepare('SELECT * FROM plan_ops WHERE strategy_id = ? ORDER BY seq').all(s.id);
  return planProjectAiSummaries({ scenarios, baselines, strategies, opsByStrategy });
}
// Panel attachment + model wiring (shared by the three Design
// with AI endpoints): validated files become extra content parts
// on the turn's user message; no files = the plain prompt string,
// unchanged. An explicitly named, configured model is used for
// this call and persisted as the app default for subsequent
// sends, exactly like the fill-chat model picker.
function planAiPanelModel(body) {
  const raw = body?.model;
  if (raw == null || String(raw).trim() === '') return { model: getAiFillModel() };
  const model = String(raw).trim();
  if (!llmModels().includes(model)) return { status: 400, error: `model "${model}" is not in the configured model list` };
  setAiFillModel(model);
  return { model };
}
function planAiUserContent(prompt, fileInfos) {
  if (!fileInfos || !fileInfos.length) return prompt;
  return [{ type: 'text', text: prompt }, ...fileContentParts(fileInfos)];
}
app.post('/api/planning/projects/:id/scenarios/ai-design', requireApiAuth, async (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const fileCheck = validateChatFiles(req.body?.files);
  if (fileCheck.error) return res.status(fileCheck.status).json({ error: fileCheck.error });
  const modelCheck = planAiPanelModel(req.body);
  if (modelCheck.error) return res.status(modelCheck.status).json({ error: modelCheck.error });
  // Panel conversation context: the panel's display thread rendered as
  // plain lines (the structured thread shape does not fit free-text
  // turns, so this endpoint takes text, not the sanitized thread).
  const historyText = String(req.body?.historyText || '').trim().slice(0, 4000);
  const snapshot = await planAiSnapshotForProject();
  const existing = planAiExistingSummaries(p.id);
  const prompt = [
    'You propose a planning scenario (a future world) as JSON only. No prose outside the JSON object.',
    'A scenario holds ONLY world factors: prime (a rate path), stock (an expected annual return %), propertyGrowth, salaryGrowth, rentGrowth. It NEVER holds a sink, an operation, or a price.',
    'prime: {"preset": "flat"|"optimistic"|"pessimistic"|"up"|"down"} or {"points": [{"month": "YYYY-MM", "rate": number}]}. Points must be increasing months, rates 0–30.',
    'stock/propertyGrowth/salaryGrowth/rentGrowth: {"valuePct": number} between -90 and 500. Only include a factor the user actually asked about — never invent one.',
    'Salary and rent growth are stored and labeled only; the projection has no earnings leg yet.',
    'Also propose a short name for the scenario from the user request (a few words, e.g. "Prime rises", "High stock return") — the user confirms or edits it before anything is created.',
    `App data snapshot: ${JSON.stringify(snapshot)}`,
    `This project already has: ${JSON.stringify(existing)}. Refine what exists where the user asks; do not duplicate an existing scenario under a new name.`,
    ...(historyText ? [`Conversation so far:\n${historyText}`, 'Continue this conversation: do not repeat factors already proposed unless the user contradicts them.'] : []),
    'Output: {"factors": {...}, "name": "short scenario name"}. A missing name is tolerated (the client falls back to a plain default).',
    `User request: ${text}`,
  ].join('\n');
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: planAiUserContent(prompt, fileCheck.fileInfos) }], process.env, modelCheck.model);
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  if (!parsed || typeof parsed !== 'object') return res.status(502).json({ error: 'AI did not return a scenario' });
  // Preset-only prime replies are legal per the prompt: expand the
  // preset to its points before validation (flat = hold, no points).
  const factors = expandScenarioPrimePreset(parsed.factors || parsed, snapshot.prime, currentMonthKey());
  const errs = validateScenarioFactors(factors, currentMonthKey());
  if (errs.length) return res.status(502).json({ error: `AI scenario failed validation: ${errs.join('; ')}` });
  // Naming is automatic, not a ✨ click: the design carries a
  // proposed name (or null — the client falls back to "AI scenario").
  const aiName = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 80) : null;
  res.json({ factors, name: aiName });
});

app.post('/api/planning/scenarios/:id/set-base', requireApiAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'scenario not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  db.prepare('UPDATE plan_scenarios SET is_base = 0 WHERE project_id = ?').run(p.id);
  db.prepare('UPDATE plan_scenarios SET is_base = 1 WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

app.delete('/api/planning/scenarios/:id', requireApiAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'scenario not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.is_base) return res.status(400).json({ error: 'the base scenario cannot be deleted — set another scenario as base first' });
  db.prepare('DELETE FROM plan_scenarios WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

app.post('/api/planning/projects/:id/declared-assets', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'asset name is required' });
  if (!(Number(b.amount) > 0)) return res.status(400).json({ error: 'amount must be > 0' });
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Added declared asset · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_declared_assets (project_id, name, amount, maturity_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, String(b.name).trim(), Number(b.amount), b.maturity_date || null, now, now);
    return { value: { asset: db.prepare('SELECT * FROM plan_declared_assets WHERE id = ?').get(info.lastInsertRowid) }, entityId: p.id };
  });
  res.status(201).json(out);
});

app.delete('/api/planning/declared-assets/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM plan_declared_assets WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'asset not found' });
  const p = planProjectById(row.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Deleted declared asset · ${p.name}`,
  }, () => {
    db.prepare('DELETE FROM plan_declared_assets WHERE id = ?').run(row.id);
    return { value: { ok: true }, entityId: p.id };
  });
  res.json({ ok: true });
});

app.post('/api/planning/projects/:id/strategies', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'strategy name is required' });
  const template = b.template ? String(b.template) : null;
  const templateParams = b.template_params && typeof b.template_params === 'object' ? b.template_params : null;
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Added strategy ${String(b.name).trim()} · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_strategies (project_id, name, letter, source, template, template_params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, String(b.name).trim(), planNextLetter(p.id), b.source || 'manual', template, templateParams ? JSON.stringify(templateParams) : null, now, now);
    return { value: { strategy: planStrategyById(info.lastInsertRowid) }, entityId: p.id };
  });
  res.status(201).json(out);
});

app.put('/api/planning/strategies/:id', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'strategy name is required' });
  if (b.model_id !== undefined && b.model_id !== null && !db.prepare('SELECT id FROM plan_ai_models WHERE id = ? AND project_id = ?').get(Number(b.model_id), p.id)) {
    return res.status(400).json({ error: 'model not found in this project' });
  }
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Updated strategy ${b.name !== undefined ? String(b.name).trim() : s.name} · ${p.name}`,
  }, () => {
    db.prepare('UPDATE plan_strategies SET name = ?, model_id = ?, updated_at = ? WHERE id = ?')
      .run(b.name !== undefined ? String(b.name).trim() : s.name, b.model_id !== undefined ? (b.model_id == null ? null : Number(b.model_id)) : s.model_id, nowIso(), s.id);
    return { value: { strategy: planStrategyById(s.id) }, entityId: p.id };
  });
  res.json(out);
});

app.delete('/api/planning/strategies/:id', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.merged) return res.status(400).json({ error: 'a merged strategy cannot be deleted — revert it first' });
  commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Deleted strategy ${s.name} · ${p.name}`,
  }, () => {
    db.prepare('DELETE FROM plan_strategies WHERE id = ?').run(s.id);
    return { value: { ok: true }, entityId: p.id };
  });
  res.json({ ok: true });
});

app.get('/api/planning/strategies/:id', requireApiAuth, async (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  planMigrateStrategyFactors(p.id);
  const ops = planOpsOf(s.id);
  const assumptions = planAssumptionsOf(s.id);
  const allScenarios = planScenariosOf(p.id);
  // ?scenarioId= picks the world the detail page runs under; absent =
  // the project's base scenario (the labeled default), never silent.
  let scenarioArg;
  if (req.query.scenarioId === '0') {
    scenarioArg = null; // explicit flat world, even when scenarios exist
  } else if (req.query.scenarioId !== undefined && req.query.scenarioId !== null && req.query.scenarioId !== '') {
    scenarioArg = allScenarios.find((x) => x.id === Number(req.query.scenarioId));
    if (!scenarioArg) return res.status(404).json({ error: 'scenario not found' });
  }
  let baseline; let strategy; let comparison; let appliedScenario;
  try {
    ({ baseline, strategy, comparison, appliedScenario } = await planProjectionFor(s, p, scenarioArg));
  } catch (err) {
    return res.status(500).json({ error: `projection failed: ${err.message}` });
  }
  // Attached AI model spec, if any: the strategy detail page renders it
  // with its formulas and a month-1 trial row from the projection.
  let model = null;
  if (s.model_id) {
    const mrow = db.prepare('SELECT * FROM plan_ai_models WHERE id = ?').get(s.model_id);
    if (mrow) model = { id: mrow.id, name: mrow.name, version: mrow.version, source: mrow.source, spec: JSON.parse(mrow.spec || '{}'), metadata: mrow.metadata ? JSON.parse(mrow.metadata) : null };
  }
  // The strategy carries no factors anymore: the world lives on the
  // scenario (appliedScenario labels which one these numbers ran under).
  const strategyRow = { ...s, template_params: s.template_params ? JSON.parse(s.template_params) : null, ai_thread: s.ai_thread ? JSON.parse(s.ai_thread) : [], factors: null };
  // Equity-chart inputs, computed exactly as the report path does
  // (same assessed map, same entity rule, same growth factor): the
  // entity property's assessed value for property projects, the
  // all-properties sum for legacy/non-property projects; the applied
  // scenario's property-growth factor grows it month by month, and
  // with no factor it is held flat at the current roll.
  const entityProp = planEntityProperty(p);
  const assessedByProperty = (planAssembleMainline(p.id).assessed || {});
  const equityAssessedTotal = entityProp
    ? (Number(assessedByProperty[entityProp.id]) || 0)
    : Object.values(assessedByProperty).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const scenFactors = scenarioArg ? planScenarioFactorsOfRow(scenarioArg) : null;
  const equityGrowthPct = scenFactors && scenFactors.propertyGrowth ? Number(scenFactors.propertyGrowth.valuePct) : null;
  // Generate-gating + baseline-kind content (user 2026-11-04): the
  // strategy page's headline and chart panels render only when a
  // report exists pinning this strategy (a null strategy_ids legacy
  // row pins all strategies), and their content follows the baseline
  // kind — pool for investment projects, property for property
  // projects, other for everything else. Deleting all such reports
  // re-hides the panels.
  const baselineKind = p.category === 'investment' ? 'pool' : p.category === 'property' ? 'property' : 'other';
  let hasGeneratedReport = false;
  try {
    for (const r of db.prepare('SELECT strategy_ids FROM plan_reports WHERE project_id = ?').all(p.id)) {
      if (r.strategy_ids == null) { hasGeneratedReport = true; break; }
      let ids = null;
      try { ids = JSON.parse(r.strategy_ids); } catch { ids = null; }
      if (Array.isArray(ids) && ids.includes(s.id)) { hasGeneratedReport = true; break; }
    }
  } catch { /* no reports table rows = gate closed */ }
  const fb = planFixedBaseline({ id: p.id, category: p.category, subcategory: p.subcategory, entity: planProjectEntityOf(p) });
  res.json({ strategy: strategyRow, project: p, ops, assumptions, factors: null, scenarios: allScenarios, baseScenario: planBaseScenario(p.id), appliedScenario, baseline, projection: strategy, comparison, scenarioTable: [], model, entityProperty: entityProp, equityAssessedTotal, equityGrowthPct, equityCurrentMonth: currentMonthKey(), baselineKind, hasGeneratedReport, fixedBaseline: fb });
});

app.get('/api/planning/strategies/:id/projection', requireApiAuth, async (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  planMigrateStrategyFactors(p.id);
  const allScenarios = planScenariosOf(p.id);
  let scenarioArg;
  if (req.query.scenarioId === '0') {
    scenarioArg = null; // explicit flat world, even when scenarios exist
  } else if (req.query.scenarioId !== undefined && req.query.scenarioId !== null && req.query.scenarioId !== '') {
    scenarioArg = allScenarios.find((x) => x.id === Number(req.query.scenarioId));
    if (!scenarioArg) return res.status(404).json({ error: 'scenario not found' });
  }
  let r;
  try {
    r = await planProjectionFor(s, p, scenarioArg);
  } catch (err) {
    return res.status(500).json({ error: `projection failed: ${err.message}` });
  }
  res.json({ scenario: r.appliedScenario, ...r });
});

// One comparison block (one scenario world): baseline + per-strategy
// rows + report-ready trajectories. Shared by the GET comparison and
// the preview endpoint — the preview passes factor/op overrides
// (report variables, trajectory tier), which are applied IN MEMORY
// only; the GET passes none. Factor overrides merge onto the
// scenario's factors; op overrides patch op params (validated by the
// caller via planValidateStrategyOps).
// Pool history pull set (user 2026-11-06): the holdings the pool
// projection actually uses — the pool entity's holdings plus every
// buy op's target holding across the project's strategies (a buy of
// a holding outside the pool is injected into the strategy run, so
// it needs history too). Custom buys (accountId null, no holding)
// and symbol-only buys have no holding to pull. Resolved against
// the project's mainline holdings (id/kind/symbol rows).
function planPoolHistoryHoldings(p, strategies) {
  const mainline = planAssembleMainline(p.id);
  const byId = new Map((mainline.holdings || []).map((h) => [h.id, h]));
  const ids = new Set();
  const entity = planProjectEntityOf(p);
  for (const it of (entity && entity.items) || []) {
    if (it.accountId != null) {
      for (const h of mainline.holdings || []) if (Number(h.accountId) === Number(it.accountId)) ids.add(h.id);
    } else if (it.holdingId != null) ids.add(Number(it.holdingId));
  }
  for (const s of strategies || []) {
    for (const o of planOpsOf(s.id)) {
      if (o.op_type === 'buy' && o.params && o.params.holdingId != null) ids.add(Number(o.params.holdingId));
    }
  }
  return [...ids].map((id) => byId.get(id)).filter(Boolean);
}
// What-if backtest entries (user 2026-11-07): one per strategy with
// a symbol buy — the actual holding (the pool's dominant holding by
// current value) vs the buy target, same money, one continuous
// chart: real history back 5y, forecast after today. The pair is
// skipped when the buy targets what the pool already holds (no
// alternative to compare). Amount defaults to the buy-op amount;
// the start month defaults to the buy-op month when it is in the
// past, else 5 years ago (a future buy-op date cannot start a
// backtest). A leg with no usable history is kept with a null rate
// (forecast flat, labeled) — the entry is dropped only when
// NEITHER leg has any price history at all.
function planWhatIfEntries(p, rows, horizonMonth, currentMonth, cutStockByTraj = null) {
  if (p.category !== 'investment' || !rows || !rows.length || !horizonMonth || horizonMonth <= currentMonth) return [];
  const baseMainline = planAssembleMainline(p.id);
  const poolMainline = planPoolMainline(p, baseMainline, currentMonth);
  const fxRows = db.prepare('SELECT date, rate FROM invest_fx_rates ORDER BY date').all();
  const fxLatest = fxRows.length ? Number(fxRows[fxRows.length - 1].rate) : 1;
  const fxByMonth = {};
  {
    let last = fxLatest;
    const byDate = new Map(fxRows.map((r) => [String(r.date), Number(r.rate)]));
    const startIdx = monthIdxOf(currentMonth) - 72;
    for (let i = startIdx; i <= monthIdxOf(horizonMonth); i++) {
      const m = ymOfIdx(i);
      const cut = `${m}-31`;
      for (const [d, v] of byDate) if (d <= cut) last = v; else break;
      fxByMonth[m] = last;
    }
  }
  const toCad = (h, v) => (h && h.currency === 'USD' ? v * fxLatest : v);
  const priceOn = (h, monthKey) => {
    let last = null;
    for (const pt of h.pricePoints || []) if (String(pt.date).slice(0, 10) <= `${monthKey}-31`) last = pt; else break;
    return last ? Number(last.price) : null;
  };
  const holdingValueAt = (h) => {
    let units = 0;
    for (const e of h.events || []) {
      if (String(e.date).slice(0, 7) > currentMonth) continue;
      if (['buy', 'grant', 'position'].includes(e.type)) units += Number(e.units) || 0;
      else if (e.type === 'sell') units -= Number(e.units) || 0;
    }
    const pr = priceOn(h, currentMonth);
    return pr == null ? 0 : toCad(h, units * pr);
  };
  const poolHoldings = (poolMainline.holdings || []).filter((h) => holdingValueAt(h) > 0);
  const actualHolding = poolHoldings.length
    ? poolHoldings.reduce((best, h) => (holdingValueAt(h) > holdingValueAt(best) ? h : best))
    : null;
  if (!actualHolding) return [];
  const actualRate = currentReturnRateFromPoints(actualHolding.pricePoints || [], currentMonth);
  const poolTotal = poolHoldings.reduce((s, h) => s + holdingValueAt(h), 0);
  const out = [];
  for (const row of rows) {
    const st = row.strategy;
    const buys = planOpsOf(st.id).filter((o) => o.op_type === 'buy' && o.params && o.params.symbol);
    if (!buys.length) continue;
    const buy = buys[0];
    const bp = buy.params;
    const altSym = String(bp.symbol).toUpperCase();
    if (String(actualHolding.symbol || '').toUpperCase() === altSym) continue;
    // Alt points: a buy of a held holding reuses that holding's
    // points; a symbol-only buy reads the symbol store (pulled at
    // Generate by ensureSymbolHistory).
    let altPoints = null;
    let altCurrency = bp.currency || 'CAD';
    const held = bp.holdingId != null
      ? (baseMainline.holdings || []).find((h) => Number(h.id) === Number(bp.holdingId))
      : (baseMainline.holdings || []).find((h) => Number(h.accountId) === Number(bp.accountId) && String(h.symbol || '').toUpperCase() === altSym);
    if (held) {
      altPoints = (held.pricePoints || []).map((pt) => ({ date: pt.date, price: pt.price }));
      altCurrency = held.currency || altCurrency;
    } else {
      altPoints = listSymbolPricePoints(db, altSym).map((pt) => ({ date: pt.date, price: pt.price }));
    }
    const altRate = currentReturnRateFromPoints(altPoints || [], currentMonth);
    const buyPrice = bp.price != null ? Number(bp.price) : null;
    const buyUnits = bp.units != null ? Number(bp.units) : (bp.amount != null && buyPrice ? Number(bp.amount) / buyPrice : null);
    let amountCad = null;
    if (bp.amount != null) amountCad = toCad({ currency: altCurrency }, Number(bp.amount));
    else if (buyUnits != null && buyPrice != null) amountCad = toCad({ currency: altCurrency }, buyUnits * buyPrice);
    else amountCad = poolTotal;
    if (!(amountCad > 0)) continue;
    const buyMonth = String(bp.date || '').slice(0, 7);
    const startMonth = buyMonth && buyMonth <= currentMonth ? buyMonth : ymOfIdx(monthIdxOf(currentMonth) - 60);
    const series = whatIfBacktest({
      actual: { symbol: actualHolding.symbol, currency: actualHolding.currency || 'CAD', points: (actualHolding.pricePoints || []).map((pt) => ({ date: pt.date, price: pt.price })), ratePct: actualRate ? actualRate.ratePct : null },
      alt: { symbol: altSym, currency: altCurrency, points: altPoints || [], ratePct: altRate ? altRate.ratePct : null },
      amountCad, startMonth, currentMonth, horizonMonth, fxByMonth, fxLatest,
    });
    if (!series) continue;
    out.push({
      strategyId: st.id, strategyLetter: st.letter, strategyName: st.name,
      available: true,
      actual: { symbol: actualHolding.symbol, currency: actualHolding.currency || 'CAD', ratePct: actualRate ? actualRate.ratePct : null, rateWindow: actualRate ? actualRate.window : null, rateBasis: actualRate ? actualRate.basis : null },
      alt: { symbol: altSym, currency: altCurrency, ratePct: altRate ? altRate.ratePct : null, rateWindow: altRate ? altRate.window : null, rateBasis: altRate ? altRate.basis : null },
      amountCad: round2(amountCad), ...series,
      // Merged-chart legs (user 2026-11-07): each leg re-anchored
      // so its value AT the cutoff equals the projection's stock
      // value that month (baseline → actual leg, this strategy →
      // alt leg) — the backtest meets the forecast with no jump.
      // Without a cutoff stock value the leg carries no backtest.
      anchoredActualValues: anchorWhatIfLeg(series.actualValues, series.actualCutValue, cutStockByTraj ? cutStockByTraj.get('baseline') : null),
      anchoredAltValues: anchorWhatIfLeg(series.altValues, series.altCutValue, cutStockByTraj ? cutStockByTraj.get(String(st.id)) : null),
    });
  }
  return out;
}
async function planComparisonBlock(p, scenarioRow, opts = {}) {
  const strategies = db.prepare('SELECT * FROM plan_strategies WHERE project_id = ? ORDER BY id').all(p.id);
  // Pool history pull (user 2026-11-06): at Generate, pull full
  // price history for the pool's holdings that lack a usable rate or
  // σ, so the projection (and the band) use real history instead of
  // flat. Runs once per comparison render, BEFORE any projection
  // reads the points; a failed fetch falls back to stored points and
  // is noted on the report (never fails the report).
  let poolHistoryNotes = [];
  if (p.category === 'investment') {
    try {
      const pull = await ensurePoolHistory(db, planPoolHistoryHoldings(p, strategies), { currentMonth: currentMonthKey() });
      poolHistoryNotes = pull.notes;
    } catch (err) {
      console.warn(`[planning] pool history pull failed, using stored points: ${err.message}`);
      poolHistoryNotes = [{ holdingId: null, symbol: '', error: err.message }];
    }
  }
  const entityProp = planEntityProperty(p);
  let factors = planScenarioFactorsOfRow(scenarioRow);
  if (opts.factorOverrides) factors = { ...(factors || {}), ...opts.factorOverrides };
  const rows = [];
  let baseline = null;
  // Shared comparison window (user 2026-11-05): when ANY strategy in
  // this report holds a maturing custom buy, every trajectory ends at
  // the latest maturity month — one window, one baseline, so the
  // charts, table, and year pager all stop there. Op-param overrides
  // (preview) are applied first, so a previewed term moves the
  // window the same way a saved one does.
  const effOpsFor = (st) => {
    const sops = planOpsOf(st.id);
    if (!opts.opParamOverrides) return sops;
    return sops.map((o) => (opts.opParamOverrides[o.id] ? { ...o, params: { ...(o.params || {}), ...opts.opParamOverrides[o.id] } } : o));
  };
  const reportAllOps = strategies.flatMap((st) => effOpsFor(st));
  const reportLatestMat = latestMaturityMonth(reportAllOps);
  const reportHorizonMonths = reportLatestMat ? maturityHorizonMonths(reportAllOps, currentMonthKey()) : null;
  for (const st of strategies) {
    let r;
    try {
      // No factor overrides: pass the row (appliedScenario stays
      // set). With overrides: pass the merged factors object.
      const scenInput = opts.factorOverrides ? factors : scenarioRow;
      const projOverrides = { ...(opts.opParamOverrides ? { opParams: opts.opParamOverrides } : {}), ...(reportHorizonMonths != null ? { horizonMonths: reportHorizonMonths } : {}) };
      r = await planProjectionFor(st, p, scenInput, Object.keys(projOverrides).length ? projOverrides : undefined);
    } catch (err) {
      throw new Error(`projection failed: ${err.message}`);
    }
    if (!baseline) baseline = r.baseline;
    const stOps = planOpsOf(st.id);
    rows.push({ strategy: st, projection: r.strategy, comparison: r.comparison, factors: r.factors, symbolHistoryNotes: r.symbolHistoryNotes || [], buys: stOps.filter((o) => o.op_type === 'buy').map((o) => (o.params && (o.params.symbol || o.holdingSymbol)) || '').filter(Boolean), opCount: stOps.length });
  }
  // Baseline-only projection: the reference the strategy deltas are
  // computed against, and the chart's baseline line.
  if (!baseline) {
    const baseMainline = planAssembleMainline(p.id);
    await ensureFreshPrime();
    const cur = getCurrentPrime();
    const currentMonth = currentMonthKey();
    let mainline = planPoolMainline(p, baseMainline, currentMonth);
    const fallbackEntity = planEntityProperty(p);
    if (fallbackEntity) mainline = scopeMainlineToProperty(mainline, fallbackEntity.id);
    const { map: holdingGrowth, rates: currentRates } = planHoldingGrowth(mainline, currentMonth);
    baseline = computeProjection({ mainline, ops: [], legs: [], assumptions: factorsToAssumptions(factors, {}), primeHistory: getPrimeHistory(), currentPrime: cur ? cur.rate : null, currentMonth, scenario: primeFactorToScenario(factors), holdingGrowth, potInitial: poolExternalCash(planProjectEntityOf(p)) });
    baseline.currentRates = currentRates;
  }
  // Strategy-centric deltas: per strategy, Equity Δ (peak balance
  // advantage over baseline) and Principal Δ (buyCash vs baseline).
  // A delta is null when the strategy does not touch that asset type
  // at all — the client renders '—' — so a buy strategy never shows a
  // spurious $0 equity delta and vice versa. Baseline stays only the
  // reference the deltas are computed against, never a table column.
  for (const r of rows) {
    const sops = planOpsOf(r.strategy.id);
    const slegs = [];
    for (const o of sops) for (const l of o.legs || []) slegs.push(l);
    const touchesMortgage = sops.some((o) => ['prepay', 'rate_switch', 'refinance', 'payment_change'].includes(o.op_type))
      || slegs.some((l) => String(l.source_ref || '').startsWith('repay:'));
    const touchesStocks = sops.some((o) => ['buy', 'sell', 'position'].includes(o.op_type));
    r.equityDelta = touchesMortgage ? equityDeltaPeak(r.projection) : null;
    r.principalDelta = touchesStocks ? principalDeltaVsBaseline(baseline, r.projection) : null;
    // Monthly-payment scope: for property projects the 2026-11-04
    // entity rule SUBSUMES the 2026-11-02 op-touched rule — the
    // payment follows the entity property, not the touched set.
    // Legacy and non-property projects keep op-touched scope.
    // Stock-only / no-op strategies carry nulls and render '—'.
    // The single-property label names the property so the figure is
    // self-evident.
    const scope = paymentScopeFor(baseline, r.projection, sops, entityProp ? [entityProp.id] : null);
    let scopeLabel = 'Monthly payment';
    if (scope.propertyIds.length === 1) {
      const addr = db.prepare('SELECT address FROM properties WHERE id = ?').get(scope.propertyIds[0]);
      if (addr && addr.address) scopeLabel = `Monthly payment · ${addr.address}`;
    }
    r.paymentScope = { ...scope, label: scopeLabel };
    // Comparison chart inputs: which asset types each strategy touches
    // (the client picks the chart mode from these), plus the
    // principal-gain series for stock strategies (do-nothing
    // baseline, one definition shared with the table's stockGain).
    r.touchesMortgage = touchesMortgage;
    r.touchesStocks = touchesStocks;
    r.principalGainSeries = touchesStocks ? principalGainSeries(baseline, r.projection) : null;
  }
  // Report-ready series: one monthly trajectory per baseline/strategy,
  // plus each strategy's cost breakdown. The report view renders from
  // this block only — it never recomputes engine figures client-side.
  // The scenario's property growth (if any) grows BOTH the baseline
  // and the strategy trajectories: one world, one assessed path.
  const mainlineForReport = planAssembleMainline(p.id);
  const assessedByProperty = mainlineForReport.assessed || {};
  // Entity scope: a property project's total value grows ONLY its
  // entity property's assessed value — never the all-properties sum.
  const assessedTotal = entityProp
    ? (Number(assessedByProperty[entityProp.id]) || 0)
    : Object.values(assessedByProperty).reduce((s, v) => s + (Number(v) || 0), 0);
  const growth = factors && factors.propertyGrowth ? factors.propertyGrowth.valuePct : null;
  // Investment scope: report trajectories carry the cash-pool series
  // and their total is pool + stocks only (never property equity).
  const investmentScope = p.category === 'investment';
  const reportTrajectories = [{ key: 'baseline', label: 'Baseline', monthly: reportMonthlySeries(baseline.mortgage.perProperty, 'baseline', baseline.stocks.series, assessedTotal, growth, currentMonthKey(), { poolSeries: baseline.stocks.potSeries, investmentScope, cashOutSeries: baseline.cashOutSeries || [] }) }];
  for (const r of rows) {
    reportTrajectories.push({ key: String(r.strategy.id), label: `${r.strategy.letter} · ${r.strategy.name}`, monthly: reportMonthlySeries(r.projection.mortgage.perProperty, 'strategy', r.projection.stocks.series, assessedTotal, growth, currentMonthKey(), { poolSeries: r.projection.stocks.potSeries, investmentScope, cashOutSeries: r.projection.cashOutSeries || [] }) });
  }
  // Pool stock-value band on the trajectories (user 2026-11-06): the
  // Cash pool chart draws the P10–P90 fill from these rows, and the
  // headline ranges read them too. The pot has no volatility — only
  // the stock leg carries p10/p90.
  const attachPoolBand = (traj, proj) => {
    const band = proj && proj.stocks && proj.stocks.poolBand;
    if (!traj || !band || !band.banded) return;
    const idx = new Map(band.months.map((m, i) => [m, i]));
    for (const row of traj.monthly) {
      const i = idx.get(row.month);
      if (i == null) continue;
      row.stock_p10 = band.p10[i];
      row.stock_p90 = band.p90[i];
    }
  };
  attachPoolBand(reportTrajectories[0], baseline);
  for (const r of rows) attachPoolBand(reportTrajectories.find((t) => t.key === String(r.strategy.id)), r.projection);
  // Pool band summary for the viewer: whether any trajectory carries
  // a band, the holdings with no band (union across baseline +
  // strategies, deduped), and the history-pull failures to name.
  // (A plain loop, not .some — short-circuiting would drop the
  // strategies' noBand entries once the baseline is banded.)
  const poolBandNoBand = [];
  const poolBandSeen = new Set();
  let poolBandBanded = false;
  for (const proj of [baseline, ...rows.map((r) => r.projection)]) {
    const band = proj && proj.stocks && proj.stocks.poolBand;
    if (!band) continue;
    if (band.banded) poolBandBanded = true;
    for (const nb of band.noBand || []) if (!poolBandSeen.has(nb.holdingId)) { poolBandSeen.add(nb.holdingId); poolBandNoBand.push(nb); }
  }
  // Monthly net cash flow (property reports only, user 2026-11-06):
  // per strategy vs the baseline — payment saved minus new cash out
  // minus the engine penalty in its month. The baseline carries 0.
  // A cash-pool report has no mortgage payment, so the series does
  // not exist there (the prompt + validation forbid it on pool
  // baselines); the AI engine then sees 0 for it, never a value.
  if (!investmentScope) {
    const baseMonthly = reportTrajectories[0].monthly;
    for (const row of baseMonthly) row.monthly_net_cashflow = 0;
    for (const r of rows) {
      const traj = reportTrajectories.find((t) => t.key === String(r.strategy.id));
      if (!traj) continue;
      const ncf = new Map(monthlyNetCashflowSeries(baseMonthly, traj.monthly, (r.projection && r.projection.penalties) || []).map((x) => [x.month, x.value]));
      for (const mrow of traj.monthly) mrow.monthly_net_cashflow = ncf.get(mrow.month) || 0;
    }
  }
  const report = {
    assessedTotal, assessedByProperty,
    trajectories: reportTrajectories,
    costBreakdown: Object.fromEntries(rows.map((r) => [r.strategy.id, reportCostBreakdown(r.comparison)])),
    investmentScope,
    // What-if backtest (user 2026-11-07): one entry per strategy
    // with a symbol buy — actual holding vs buy target, same money,
    // real history before today, history-rate forecast after. The
    // horizon is the comparison's own last month, so the chart ends
    // where the report ends. Symbol pull failures are named here
    // (stored points used instead, never a failed report). The
    // merged chart re-anchors each backtest leg to the projection's
    // stock value at the cutoff month, so the cut-stock map travels
    // with the entries (baseline → 'baseline', strategies by id).
    whatIf: investmentScope ? planWhatIfEntries(p, rows, reportTrajectories[0] ? (reportTrajectories[0].monthly[reportTrajectories[0].monthly.length - 1] || {}).month : null, currentMonthKey(), new Map((reportTrajectories || []).map((t) => [t.key, (((t.monthly || []).find((r) => r.month === currentMonthKey()) || {}).stock_value ?? null)]))) : [],
    symbolHistoryNotes: [...new Map(rows.flatMap((r) => (r.symbolHistoryNotes || []).map((n) => [n.symbol, n]))).values()],
    // Headline time window (user 2026-11-06): the window starts at
    // the current month; the default end is the end of the entity
    // property's ACTIVE mortgage term (property reports) or the full
    // horizon (pool reports — no term, null here).
    currentMonth: currentMonthKey(),
    termEndMonth: entityProp
      ? activeTermEndMonth(db.prepare('SELECT start_date, term_months FROM mortgage_terms WHERE property_id = ? ORDER BY start_date').all(entityProp.id), currentMonthKey())
      : null,
    // Maturing custom buys, for the report view's maturity line:
    // each names the product, its maturity date, and the matured
    // amount that returned to the pot as cash.
    maturities: rows.flatMap((r) => (r.projection.maturities || []).map((m) => ({ ...m, strategyId: r.strategy.id, strategyLetter: r.strategy.letter, strategyName: r.strategy.name }))),
    // Stock volatility fan, for the report view's fan_band chart:
    // one fan per baseline holding with usable history (median at
    // the holding's history CAGR, P10/P90 bands widening with √t),
    // plus the holdings with no fan and why.
    stockFan: baseline.stockFan || { fans: [], noFan: [] },
    // Pool stock-value band (user 2026-11-06): the aggregate P10–P90
    // range of the pool's stock value — banded when any trajectory
    // carries one; noBand names the holdings with no usable σ; the
    // history notes name the holdings whose pull failed (stored
    // points used instead, never a failed report).
    poolBand: { banded: poolBandBanded, noBand: poolBandNoBand, historyNotes: poolHistoryNotes },
  };
  return { scenario: scenarioRow ? { id: scenarioRow.id, name: scenarioRow.name } : null, factors, baseline, strategies: rows, report };
}

app.get('/api/planning/projects/:id/comparison', requireApiAuth, async (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  planMigrateStrategyFactors(p.id);
  // A chosen baselineId is validated (404 when unknown) but is
  // numerically inert — it only labels the reference in the report view.
  // The baseline itself is always the do-nothing reference, repriced
  // under each selected scenario's factors.
  let chosenBaseline = null;
  if (req.query.baselineId !== undefined && req.query.baselineId !== null && req.query.baselineId !== '') {
    const brow = db.prepare('SELECT * FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(req.query.baselineId), p.id);
    if (!brow) return res.status(404).json({ error: 'baseline not found' });
    chosenBaseline = planBaselineRow(brow);
  }
  const allScenarios = planScenariosOf(p.id);
  // ?scenarioIds=1,2 pins the worlds this comparison runs under.
  // Absent = the base scenario, or a single flat-world block when the
  // project has no scenarios yet. Present-but-empty = no world selected:
  // the response carries zero blocks and the client shows a re-pick
  // panel only, never numbers under a substituted world.
  let selected;
  if (req.query.scenarioIds !== undefined && req.query.scenarioIds !== null && req.query.scenarioIds !== '') {
    const wanted = new Set(String(req.query.scenarioIds).split(',').map((x) => Number(x)).filter((x) => Number.isFinite(x)));
    for (const id of wanted) {
      if (!allScenarios.some((x) => x.id === id)) return res.status(404).json({ error: 'scenario not found' });
    }
    selected = allScenarios.filter((x) => wanted.has(x.id));
  } else {
    const base = planBaseScenario(p.id);
    selected = base ? [base] : [null];
  }
  const entityProp = planEntityProperty(p);
  const scenarioBlocks = [];
  try {
    for (const sc of selected) scenarioBlocks.push(await planComparisonBlock(p, sc));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  // Back-compat top level: the FIRST block. The saved-report view reads
  // these fields; with scenarios present it renders under the first
  // selected world (the base scenario when no ids were pinned).
  const first = scenarioBlocks[0] || null;
  // AI engine execution (item 2): when the caller names a report
  // whose definition carries an engine, evaluate it per strategy over
  // that strategy's preset-engine trajectory + comparison scalars and
  // attach the executed figures to the row. Preset reports (no engine
  // key) get no engine block — their figures are the preset engine's.
  // An engine that fails evaluation attaches its errors and the row
  // falls back to preset figures at the call site.
  if (req.query.reportId !== undefined && req.query.reportId !== null && req.query.reportId !== '' && first) {
    const rep = db.prepare('SELECT * FROM plan_reports WHERE id = ? AND project_id = ?').get(Number(req.query.reportId), p.id);
    if (rep) {
      let def = {};
      try { def = JSON.parse(rep.definition || '{}'); } catch { def = {}; }
      if (def.engine && typeof def.engine === 'object') {
        const trajs = (first.report && first.report.trajectories) || [];
        for (const row of first.strategies) {
          const traj = trajs.find((t) => t.key === String(row.strategy.id));
          const ev = evaluateAiEngine(def.engine, { monthly: (traj && traj.monthly) || [], scalars: row.comparison || {} });
          row.engine = { series: ev.series, scalars: ev.scalars, inputs: ev.inputs, errors: ev.errors };
        }
      }
    }
  }
  res.json({
    project: p, scenarios: allScenarios, selectedScenarioIds: selected.filter(Boolean).map((x) => x.id),
    scenarioBlocks, scenario: first ? first.scenario : null,
    baseline: first ? first.baseline : null, strategies: first ? first.strategies : [],
    report: first ? first.report : null, chosenBaseline, entityProperty: entityProp,
  });
});

// Report variables, trajectory tier (item 5): re-run the comparison
// with in-memory overrides — prime points, stock return, property
// growth, op params — and return the same shape as the GET
// comparison. PREVIEW ONLY: nothing is written. Apply writes back
// to the bound scenario/op via the normal PUT endpoints.
app.post('/api/planning/projects/:id/comparison/preview', requireApiAuth, async (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  planMigrateStrategyFactors(p.id);
  const b = req.body || {};
  const overrides = b.overrides || {};
  const factorOverrides = {};
  if (overrides.prime !== undefined) {
    if (!overrides.prime || !Array.isArray(overrides.prime.points)) return res.status(400).json({ error: 'overrides.prime.points must be an array of {month, rate}' });
    for (const pt of overrides.prime.points) {
      if (!/^\d{4}-\d{2}$/.test(String(pt.month || '')) || !isFinite(Number(pt.rate))) return res.status(400).json({ error: 'prime points must be {month: YYYY-MM, rate: number}' });
    }
    factorOverrides.prime = { points: overrides.prime.points.map((pt) => ({ month: pt.month, rate: Number(pt.rate) })) };
  }
  if (overrides.stock !== undefined) {
    if (overrides.stock == null || !isFinite(Number(overrides.stock.valuePct))) return res.status(400).json({ error: 'overrides.stock.valuePct must be a number' });
    factorOverrides.stock = { valuePct: Number(overrides.stock.valuePct) };
  }
  if (overrides.propertyGrowth !== undefined) {
    if (overrides.propertyGrowth == null || !isFinite(Number(overrides.propertyGrowth.valuePct))) return res.status(400).json({ error: 'overrides.propertyGrowth.valuePct must be a number' });
    factorOverrides.propertyGrowth = { valuePct: Number(overrides.propertyGrowth.valuePct) };
  }
  const opParamOverrides = {};
  if (overrides.ops !== undefined) {
    if (typeof overrides.ops !== 'object' || Array.isArray(overrides.ops)) return res.status(400).json({ error: 'overrides.ops must be an object keyed by op id' });
    const strategyIds = db.prepare('SELECT id FROM plan_strategies WHERE project_id = ?').all(p.id).map((x) => x.id);
    for (const [opId, patch] of Object.entries(overrides.ops)) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: `overrides.ops.${opId} must be an object of params` });
      const op = db.prepare('SELECT * FROM plan_ops WHERE id = ?').get(Number(opId));
      if (!op || !strategyIds.includes(op.strategy_id)) return res.status(400).json({ error: `op ${opId} is not in this project` });
      const existing = planOpsOf(op.strategy_id);
      const patched = existing.map((o) => (o.id === Number(opId) ? { ...o, params: { ...(o.params || {}), ...patch } } : o));
      const legs = [];
      for (const o of patched) for (const l of o.legs || []) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
      const errs = planValidateStrategyOps(op.strategy_id, patched, legs);
      if (errs.length) return res.status(400).json({ error: `op ${opId}: ${errs.join('; ')}` });
      opParamOverrides[Number(opId)] = patch;
    }
  }
  const allScenarios = planScenariosOf(p.id);
  let selected;
  if (b.scenarioIds !== undefined && b.scenarioIds !== null && b.scenarioIds !== '') {
    const wanted = new Set(String(b.scenarioIds).split(',').map((x) => Number(x)).filter((x) => Number.isFinite(x)));
    for (const id of wanted) if (!allScenarios.some((x) => x.id === id)) return res.status(404).json({ error: 'scenario not found' });
    selected = allScenarios.filter((x) => wanted.has(x.id));
  } else {
    const base = planBaseScenario(p.id);
    selected = base ? [base] : [null];
  }
  const blocks = [];
  try {
    for (const sc of selected) blocks.push(await planComparisonBlock(p, sc, {
      factorOverrides: Object.keys(factorOverrides).length ? factorOverrides : null,
      opParamOverrides: Object.keys(opParamOverrides).length ? opParamOverrides : null,
    }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const first = blocks[0] || null;
  res.json({
    preview: true,
    project: p, scenarios: allScenarios, selectedScenarioIds: selected.filter(Boolean).map((x) => x.id),
    scenarioBlocks: blocks, scenario: first ? first.scenario : null,
    baseline: first ? first.baseline : null, strategies: first ? first.strategies : [],
    report: first ? first.report : null, chosenBaseline: null, entityProperty: planEntityProperty(p),
  });
});

// A buy's units + amount are two views of the same fill (the
// projection derives whichever is missing at read time); store both
// so the buy list shows units + amount for every buy, however it was
// posted (the browser form posts both via its Units↔Amount linkage,
// an API post usually carries amount + price only). Same rounding as
// the projection: units to 4dp, amount to cents.
function planNormalizeBuyParams(params) {
  if (!params || typeof params !== 'object') return params;
  const price = num(params.price);
  if (price == null || !(price > 0)) return params;
  const units = num(params.units);
  const amount = num(params.amount);
  if ((units == null || units <= 0) && amount != null && amount > 0) {
    params.units = Math.round((amount / price + Number.EPSILON) * 10000) / 10000;
  } else if ((amount == null || amount <= 0) && units != null && units > 0) {
    params.amount = Math.round((units * price + Number.EPSILON) * 100) / 100;
  }
  return params;
}

app.post('/api/planning/strategies/:id/ops', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.merged) return res.status(400).json({ error: 'a merged strategy cannot be edited — revert it first' });
  const b = req.body || {};
  if (!OP_TYPES.includes(b.op_type)) return res.status(400).json({ error: `unknown operation type ${b.op_type}` });
  const params = b.op_type === 'buy' ? planNormalizeBuyParams(b.params || {}) : (b.params || {});
  const existing = planOpsOf(s.id);
  const seq = existing.length ? Math.max(...existing.map((o) => o.seq)) + 1 : 1;
  const op = { seq, op_type: b.op_type, params };
  const legs = (b.legs || []).map((l) => ({ op_seq: seq, source_ref: l.source_ref, amount: l.amount }));
  const errs = planValidateStrategyOps(s.id, [...existing, op], legs);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Added operation · ${s.name} · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_ops (strategy_id, seq, op_type, params, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, seq, b.op_type, JSON.stringify(params), b.source || 'manual', now, now);
    for (const l of legs) {
      db.prepare('INSERT INTO plan_legs (op_id, source_ref, amount, created_at) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, l.source_ref, String(l.amount), now);
    }
    db.prepare('UPDATE plan_strategies SET updated_at = ? WHERE id = ?').run(now, s.id);
    return { value: { op: { ...op, id: info.lastInsertRowid, legs: planOpsOf(s.id).find((o) => o.id === info.lastInsertRowid).legs } }, entityId: p.id };
  });
  res.status(201).json(out);
});

app.put('/api/planning/ops/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM plan_ops WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'operation not found' });
  const s = planStrategyById(row.strategy_id);
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.merged) return res.status(400).json({ error: 'a merged strategy cannot be edited — revert it first' });
  const b = req.body || {};
  const params = row.op_type === 'buy' ? planNormalizeBuyParams(b.params !== undefined ? b.params : JSON.parse(row.params || '{}')) : (b.params !== undefined ? b.params : JSON.parse(row.params || '{}'));
  const existing = planOpsOf(s.id).map((o) => (o.id === row.id ? { ...o, params } : o));
  const legs = (b.legs !== undefined ? b.legs : db.prepare('SELECT * FROM plan_legs WHERE op_id = ? ORDER BY id').all(row.id))
    .map((l) => ({ op_seq: row.seq, source_ref: l.source_ref, amount: l.amount }));
  const op = { seq: row.seq, op_type: row.op_type, params };
  const errs = planValidateStrategyOps(s.id, existing, legs);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Updated operation · ${s.name} · ${p.name}`,
  }, () => {
    db.prepare('UPDATE plan_ops SET params = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(params), now, row.id);
    if (b.legs !== undefined) {
      db.prepare('DELETE FROM plan_legs WHERE op_id = ?').run(row.id);
      for (const l of legs) db.prepare('INSERT INTO plan_legs (op_id, source_ref, amount, created_at) VALUES (?, ?, ?, ?)').run(row.id, l.source_ref, String(l.amount), now);
    }
    db.prepare('UPDATE plan_strategies SET updated_at = ? WHERE id = ?').run(now, s.id);
    return { value: { op: planOpsOf(s.id).find((o) => o.id === row.id) }, entityId: p.id };
  });
  res.json(out);
});

app.delete('/api/planning/ops/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM plan_ops WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'operation not found' });
  const s = planStrategyById(row.strategy_id);
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.merged) return res.status(400).json({ error: 'a merged strategy cannot be edited — revert it first' });
  commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Deleted operation · ${s.name} · ${p.name}`,
  }, () => {
    db.prepare('DELETE FROM plan_ops WHERE id = ?').run(row.id);
    db.prepare('UPDATE plan_strategies SET updated_at = ? WHERE id = ?').run(nowIso(), s.id);
    return { value: { ok: true }, entityId: p.id };
  });
  res.json({ ok: true });
});

app.put('/api/planning/strategies/:id/assumptions', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (!['comparableRate', 'privilegePct', 'stockReturnPct', 'fees'].includes(b.key)) {
    return res.status(400).json({ error: `unknown assumption key ${b.key}` });
  }
  if (b.value !== null && b.value !== undefined && b.value !== '' && !isFinite(Number(b.value))) {
    return res.status(400).json({ error: 'assumption value must be a number' });
  }
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Updated assumption · ${s.name} · ${p.name}`,
  }, () => {
    db.prepare(`INSERT INTO plan_assumptions (strategy_id, key, value, confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id, key) DO UPDATE SET value = excluded.value, confirmed = excluded.confirmed, updated_at = excluded.updated_at`)
      .run(s.id, b.key, b.value == null || b.value === '' ? null : String(b.value), b.confirmed ? 1 : 0, now, now);
    db.prepare('UPDATE plan_strategies SET updated_at = ? WHERE id = ?').run(now, s.id);
    return { value: { assumptions: planAssumptionsOf(s.id) }, entityId: p.id };
  });
  res.json(out);
});

// Strategy factors: full replace (the client sends the whole edited
// set). Prime points, return and growth percentages are validated;
// unknown keys are rejected.
// Retired by the scenario restructure: factors live on scenarios now.
// Kept as an explicit 400 (not a silent 404) so old callers fail loudly
// instead of assuming the write landed.
app.put('/api/planning/strategies/:id/factors', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  return res.status(400).json({ error: 'strategy factors moved to scenarios — edit the scenario instead' });
});

// The sink picker is gone (user 2026-11-05): the buy list IS the
// sink. These two routes stay as explicit 400s so a stale client (or
// a saved bookmark) gets a plain message instead of a silent 404 —
// and so a save attempt through the old flow can never delete the
// buy list. The stored sink column is dormant (never read, never
// written by any live path).
app.put('/api/planning/strategies/:id/sink', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  return res.status(400).json({ error: 'the sink picker is gone — the buy list is the sink now; add or edit buys instead' });
});
app.delete('/api/planning/strategies/:id/sink', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  return res.status(400).json({ error: 'the sink is gone — delete the buy ops instead' });
});

// Prime preset paths: complete date+rate point lists from the current
// prime, labeled in plain words. The client still lets the user edit
// the points after picking a preset.
app.get('/api/planning/prime-presets', requireApiAuth, async (req, res) => {
  const preset = String(req.query.preset || '');
  if (!PLAN_PRIME_PRESETS.includes(preset)) return res.status(400).json({ error: 'unknown prime preset' });
  await ensureFreshPrime();
  const cur = getCurrentPrime();
  const currentPrime = cur ? cur.rate : null;
  const currentMonth = currentMonthKey();
  res.json({ preset, label: PLAN_PRIME_PRESET_LABELS[preset], currentPrime, currentMonth, points: primeFactorPresetPoints(preset, currentPrime, currentMonth) });
});

// Historical return suggestions for one holding, from the user's own
// price records. Stored points first; when a window start is missing,
// backfill that symbol through the existing price tiers (Stooq →
// Yahoo → Nasdaq) and store the points under normal refresh rules.
// Every suggestion labels its ACTUAL covered window — a short window
// is never labeled as 1y/3y/5y. Cost-unknown holdings get no suggestion.
app.get('/api/planning/return-suggestions', requireApiAuth, async (req, res) => {
  const holdingId = Number(req.query.holdingId);
  const holding = db.prepare('SELECT * FROM invest_holdings WHERE id = ?').get(holdingId);
  if (!holding) return res.status(404).json({ error: 'holding not found' });
  const events = listEvents(db, holdingId);
  const hasCostUnknown = events.some((e) => e.type === 'position');
  if (hasCostUnknown) return res.json({ holding, suggestions: [], note: 'Cost unknown — no return suggestion for this holding.' });
  let points = listPricePoints(db, holdingId).map((pt) => ({ date: pt.date, price: pt.price }));
  const todayYm = currentMonthKey();
  let suggestions = returnSuggestionsFromPoints(points, todayYm);
  const labels = new Set(suggestions.map((x) => x.label));
  let backfilled = false;
  let backfillNote = null;
  if ((!labels.has('1y') || !labels.has('3y') || !labels.has('5y')) && holding.kind === 'exchange' && holding.symbol) {
    try {
      const ok = await ensureHoldingPrices(db, holding, { backfill: true });
      if (ok) {
        points = listPricePoints(db, holdingId).map((pt) => ({ date: pt.date, price: pt.price }));
        suggestions = returnSuggestionsFromPoints(points, todayYm);
        backfilled = true;
      }
    } catch (e) {
      backfillNote = `price backfill failed (${e.message}); suggestions use stored points only`;
    }
  }
  res.json({
    holding, suggestions, backfilled, backfillNote,
    note: 'Past returns do not predict future returns.',
  });
});

// Apply a merge write list inside the caller's transaction. Returns
// merge-record entries with row ids and full before/after rows.
function planApplyWrites(writes) {
  const entries = [];
  const now = nowIso();
  for (const w of writes) {
    if (w.kind === 'insert' && w.table === 'lump_sums') {
      const term = db.prepare('SELECT id FROM mortgage_terms WHERE property_id = ? AND start_date <= ? ORDER BY start_date DESC LIMIT 1').get(w.values.property_id, w.values.date);
      const info = db.prepare('INSERT INTO lump_sums (property_id, term_id, date, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(w.values.property_id, term ? term.id : null, w.values.date, w.values.amount, w.values.note || 'Planning merge', now);
      entries.push({ ...w, rowId: info.lastInsertRowid });
    }
    if (w.kind === 'insert' && w.table === 'rate_segments') {
      const v = w.values;
      const info = db.prepare('INSERT INTO rate_segments (property_id, start_date, rate_type, rate_mode, annual_rate, spread, compounding, accrual, locked_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(v.property_id, v.start_date, v.rate_type, v.rate_mode, v.annual_rate, v.spread, v.compounding || 'semi_annual', v.accrual || 'monthly', v.locked_on || null, now);
      entries.push({ ...w, rowId: info.lastInsertRowid });
    }
    if (w.kind === 'insert' && w.table === 'mortgage_terms') {
      const v = w.values;
      const info = db.prepare('INSERT INTO mortgage_terms (property_id, lender, start_date, term_months, amortization_years, opening_balance, repayment_method, payment_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(v.property_id, v.lender || null, v.start_date, v.term_months, v.amortization_years, v.opening_balance, v.repayment_method || 'equal_payment', v.payment_override, now, now);
      entries.push({ ...w, rowId: info.lastInsertRowid });
    }
    if (w.kind === 'insert' && w.table === 'invest_events') {
      const v = w.values;
      let holdingId = v.holdingId;
      if (!holdingId) {
        const existing = v.symbol ? db.prepare('SELECT * FROM invest_holdings WHERE account_id = ? AND UPPER(symbol) = UPPER(?)').get(v.accountId, v.symbol) : null;
        if (existing) holdingId = existing.id;
        else {
          const hi = db.prepare('INSERT INTO invest_holdings (account_id, label, kind, symbol, currency, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(v.accountId, v.symbol || 'New holding', v.type === 'position' ? 'fund' : 'exchange', v.symbol || null, v.currency || 'CAD', 'manual', now, now);
          holdingId = hi.lastInsertRowid;
          entries.push({ kind: 'insert', table: 'invest_holdings', rowId: holdingId, label: `Holding ${v.symbol || ''}`, values: { account_id: v.accountId, symbol: v.symbol } });
        }
      }
      const price = v.type === 'position' ? null : (v.price ?? null);
      const units = v.type === 'buy' && v.units == null && v.amount != null && price ? Math.round((v.amount / price) * 10000) / 10000 : v.units;
      const info = db.prepare('INSERT INTO invest_events (holding_id, date, type, units, price, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(holdingId, v.date, v.type, units, price, 'Planning merge', 'manual', now, now);
      entries.push({ ...w, rowId: info.lastInsertRowid, values: { ...v, holdingId, units, price } });
    }
    if (w.kind === 'update' && w.table === 'rate_segments') {
      const cur = db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(w.rowId);
      if (!cur) continue;
      db.prepare('UPDATE rate_segments SET rate_type = ?, rate_mode = ?, annual_rate = ?, spread = ? WHERE id = ?')
        .run(w.values.rate_type, w.values.rate_mode, w.values.annual_rate, w.values.spread, w.rowId);
      entries.push({ ...w, before: cur, after: { ...cur, ...w.values } });
    }
    if (w.kind === 'update' && w.table === 'mortgage_terms') {
      const cur = db.prepare('SELECT * FROM mortgage_terms WHERE id = ?').get(w.rowId);
      if (!cur) continue;
      db.prepare('UPDATE mortgage_terms SET payment_override = ?, updated_at = ? WHERE id = ?')
        .run(w.values.payment_override, now, w.rowId);
      entries.push({ ...w, before: cur, after: { ...cur, ...w.values } });
    }
    if (w.kind === 'delete' && w.table === 'rate_segments') {
      const cur = db.prepare('SELECT * FROM rate_segments WHERE id = ?').get(w.rowId);
      if (!cur) continue;
      db.prepare('DELETE FROM rate_segments WHERE id = ?').run(w.rowId);
      entries.push({ ...w, before: cur });
    }
  }
  return entries;
}
// Apply a revert inverse list inside the caller's transaction.
function planApplyInverse(inverse) {
  for (const inv of inverse) {
    if (inv.kind === 'delete') {
      db.prepare(`DELETE FROM ${inv.table} WHERE id = ?`).run(inv.rowId);
    }
    if (inv.kind === 'update') {
      const vals = inv.values || {};
      const cols = Object.keys(vals).filter((k) => k !== 'id');
      if (!cols.length) continue;
      db.prepare(`UPDATE ${inv.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => vals[c]), inv.rowId);
    }
    if (inv.kind === 'insert') {
      const row = inv.values || {};
      const cols = Object.keys(row).filter((k) => k !== 'id');
      db.prepare(`INSERT INTO ${inv.table} (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(row.id, ...cols.map((c) => row[c]));
    }
  }
}
const PLAN_MONEY_NOTE = 'Revert restores mainline records only — real-world money (penalty paid, transfers made) is not returned.';

function planCurrentTables() {
  const snap = planSnapshotMainline();
  return {
    properties: snap.properties, mortgage_terms: snap.terms, rate_segments: snap.segments,
    lump_sums: snap.lumpSums, invest_accounts: snap.accounts, invest_holdings: snap.holdings,
    invest_events: snap.events,
  };
}
function planMergePreviewFor(strategy, project) {
  const ops = planOpsOf(strategy.id);
  const legs = [];
  for (const o of ops) for (const l of o.legs) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
  const snapshot = JSON.parse(project.snapshot || '{}');
  // Merge/revert builders key rows by TABLE name.
  const current = planCurrentTables();
  const snapTables = {
    properties: snapshot.properties || [], mortgage_terms: snapshot.terms || [], rate_segments: snapshot.segments || [],
    lump_sums: snapshot.lumpSums || [], invest_accounts: snapshot.accounts || [], invest_holdings: snapshot.holdings || [],
    invest_events: snapshot.events || [],
  };
  return { ops, legs, snapshot: snapTables, current };
}

app.post('/api/planning/strategies/:id/merge-preview', requireApiAuth, async (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.merged) return res.status(400).json({ error: 'strategy is already merged' });
  const { ops, legs, snapshot, current } = planMergePreviewFor(s, p);
  const mergeBody = req.body || {};
  let baseScenario = null;
  if (mergeBody.scenarioId === 0 || mergeBody.scenarioId === '0') {
    baseScenario = null; // explicit flat world
  } else if (mergeBody.scenarioId !== undefined && mergeBody.scenarioId !== null && mergeBody.scenarioId !== '') {
    baseScenario = planScenarioRow(db.prepare('SELECT * FROM plan_scenarios WHERE id = ? AND project_id = ?').get(Number(mergeBody.scenarioId), p.id));
    if (!baseScenario) return res.status(404).json({ error: 'scenario not found' });
  } else {
    baseScenario = planBaseScenario(p.id);
  }
  let strategy;
  try {
    ({ strategy } = await planProjectionFor(s, p, baseScenario));
  } catch (err) {
    return res.status(500).json({ error: `projection failed: ${err.message}` });
  }
  // Refinance opening balances come from the strategy's own projected
  // balance series at the refinance month.
  const refinanceBalance = {};
  for (const op of ops) {
    if (op.op_type !== 'refinance') continue;
    const per = strategy.mortgage.perProperty[Number(op.params.propertyId)];
    const row = per && per.strategy && per.strategy.series ? per.strategy.series.find((r) => r.month === String(op.params.date || '').slice(0, 7)) : null;
    refinanceBalance[op.seq] = row ? row.balance : null;
  }
  // Fixed-switch split terms take the same series balance at the
  // switch month (only switches carrying an amortization override
  // split a term).
  const switchBalance = {};
  for (const op of ops) {
    if (op.op_type !== 'rate_switch' || op.params.rateType !== 'fixed' || op.params.amortizationYears == null) continue;
    const per = strategy.mortgage.perProperty[Number(op.params.propertyId)];
    const row = per && per.strategy && per.strategy.series ? per.strategy.series.find((r) => r.month === String(op.params.date || '').slice(0, 7)) : null;
    switchBalance[op.seq] = row ? row.balance : null;
  }
  const { writes, conflicts } = buildMergeWrites({ ops, legs, snapshot, current, projection: { refinanceBalance, switchBalance } });
  res.json({ writes, conflicts, penalties: strategy.penalties, fees: strategy.fees, moneyNote: PLAN_MONEY_NOTE });
});

app.post('/api/planning/strategies/:id/merge', requireApiAuth, async (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (s.merged) return res.status(400).json({ error: 'strategy is already merged' });
  const b = req.body || {};
  const resolutions = b.resolutions || [];
  const { ops, legs, snapshot, current } = planMergePreviewFor(s, p);
  let baseScenario = null;
  if (b.scenarioId === 0 || b.scenarioId === '0') {
    baseScenario = null; // explicit flat world
  } else if (b.scenarioId !== undefined && b.scenarioId !== null && b.scenarioId !== '') {
    baseScenario = planScenarioRow(db.prepare('SELECT * FROM plan_scenarios WHERE id = ? AND project_id = ?').get(Number(b.scenarioId), p.id));
    if (!baseScenario) return res.status(404).json({ error: 'scenario not found' });
  } else {
    baseScenario = planBaseScenario(p.id);
  }
  let strategy;
  try {
    ({ strategy } = await planProjectionFor(s, p, baseScenario));
  } catch (err) {
    return res.status(500).json({ error: `projection failed: ${err.message}` });
  }
  const refinanceBalance = {};
  for (const op of ops) {
    if (op.op_type !== 'refinance') continue;
    const per = strategy.mortgage.perProperty[Number(op.params.propertyId)];
    const row = per && per.strategy && per.strategy.series ? per.strategy.series.find((r) => r.month === String(op.params.date || '').slice(0, 7)) : null;
    refinanceBalance[op.seq] = row ? row.balance : null;
  }
  const switchBalance = {};
  for (const op of ops) {
    if (op.op_type !== 'rate_switch' || op.params.rateType !== 'fixed' || op.params.amortizationYears == null) continue;
    const per = strategy.mortgage.perProperty[Number(op.params.propertyId)];
    const row = per && per.strategy && per.strategy.series ? per.strategy.series.find((r) => r.month === String(op.params.date || '').slice(0, 7)) : null;
    switchBalance[op.seq] = row ? row.balance : null;
  }
  const { writes, conflicts } = buildMergeWrites({ ops, legs, snapshot, current, projection: { refinanceBalance, switchBalance } });
  // Validate references before touching mainline: a property, account
  // or holding deleted since the snapshot must fail the merge with a
  // plain 400, never with a database constraint error.
  const missing = [];
  for (const w of writes) {
    if (['lump_sums', 'rate_segments', 'mortgage_terms'].includes(w.table) && w.values && w.values.property_id != null) {
      if (!db.prepare('SELECT id FROM properties WHERE id = ?').get(w.values.property_id)) missing.push(`property ${w.values.property_id}`);
    }
    if (w.table === 'invest_events' && w.values && w.values.accountId != null) {
      if (!db.prepare('SELECT id FROM invest_accounts WHERE id = ?').get(w.values.accountId)) missing.push(`account ${w.values.accountId}`);
    }
    if (w.table === 'invest_events' && w.values && w.values.holdingId != null) {
      if (!db.prepare('SELECT id FROM invest_holdings WHERE id = ?').get(w.values.holdingId)) missing.push(`holding ${w.values.holdingId}`);
    }
  }
  if (missing.length) return res.status(400).json({ error: `cannot merge — no longer on mainline: ${[...new Set(missing)].join(', ')}` });
  // Resolve conflicts: keep-current skips that field (or the whole
  // write for a deletion), custom overwrites the field, drop removes
  // the op's writes and deletes the op itself.
  const droppedSeqs = new Set();
  const resByKey = new Map();
  for (const r of resolutions) {
    if (r.resolution === 'drop' && r.opSeq != null) droppedSeqs.add(Number(r.opSeq));
    else resByKey.set(`${r.table}:${r.rowId}:${r.field}`, r);
  }
  const unresolved = conflicts.filter((c) => !resByKey.has(`${c.table}:${c.rowId}:${c.field}`) && !droppedSeqs.has(c.opSeq));
  if (unresolved.length) return res.status(400).json({ error: 'all conflicts must be resolved before merging', conflicts: unresolved });
  let finalWrites = writes.filter((w) => !droppedSeqs.has(w.opSeq));
  for (const w of finalWrites) {
    if (w.kind === 'update') {
      for (const f of Object.keys(w.values)) {
        const r = resByKey.get(`${w.table}:${w.rowId}:${f}`);
        if (!r) continue;
        if (r.resolution === 'current') delete w.values[f];
        else if (r.resolution === 'custom') w.values[f] = r.customValue;
      }
      if (!Object.keys(w.values).length) w._skip = true;
    }
    if (w.kind === 'delete') {
      const r = [...resByKey.values()].find((x) => x.table === w.table && x.rowId === w.rowId);
      if (r && r.resolution === 'current') w._skip = true;
    }
  }
  finalWrites = finalWrites.filter((w) => !w._skip);
  // Dropped ops vanish inside the transaction; capture their rows now
  // so the merge commit's event still shows them.
  const droppedOps = [];
  for (const seq of droppedSeqs) {
    const opRow = db.prepare('SELECT * FROM plan_ops WHERE strategy_id = ? AND seq = ?').get(s.id, seq);
    if (!opRow) continue;
    droppedOps.push({ table: 'plan_ops', pk: { id: opRow.id }, before: opRow, after: null });
    for (const l of db.prepare('SELECT * FROM plan_legs WHERE op_id = ? ORDER BY id').all(opRow.id)) {
      droppedOps.push({ table: 'plan_legs', pk: { id: l.id }, before: l, after: null });
    }
  }
  const tx = db.transaction(() => {
    const entries = planApplyWrites(finalWrites);
    for (const seq of droppedSeqs) {
      const opRow = db.prepare('SELECT id FROM plan_ops WHERE strategy_id = ? AND seq = ?').get(s.id, seq);
      if (opRow) db.prepare('DELETE FROM plan_ops WHERE id = ?').run(opRow.id);
    }
    const info = db.prepare('INSERT INTO plan_merge_records (strategy_id, kind, entries, conflicts, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, 'merge', JSON.stringify(entries), JSON.stringify(resolutions), 'active', nowIso());
    db.prepare('UPDATE plan_strategies SET merged = 1, merge_record_id = ?, updated_at = ? WHERE id = ?')
      .run(info.lastInsertRowid, nowIso(), s.id);
    // The merge itself is a History commit (same transaction).
    recordCommit(db, {
      userId: req.user.id, username: req.user.username, module: 'planning',
      entityType: 'project', entityId: p.id, entityLabel: p.name,
      projectId: p.id, strategyId: s.id, mergeRecordId: info.lastInsertRowid,
      kind: 'merge', summary: `Merged strategy ${s.name} → mainline`,
      event: [...mergeEventFromEntries(db, entries), ...droppedOps],
      snapshot: snapshotByAggregate(db, 'project', p.id),
    });
    return { mergeRecordId: info.lastInsertRowid, entries };
  });
  let result;
  try {
    result = tx();
  } catch (err) {
    // Async handlers must not let a database error reject the request
    // promise (Express 4 would leave it unhandled and kill the server).
    return res.status(500).json({ error: `merge failed: ${err.message}` });
  }
  res.json({ ...result, moneyNote: PLAN_MONEY_NOTE });
});

app.get('/api/planning/projects/:id/history', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const rows = db.prepare(
    `SELECT m.*, s.name AS strategy_name FROM plan_merge_records m
     JOIN plan_strategies s ON s.id = m.strategy_id
     WHERE s.project_id = ? ORDER BY m.id DESC`).all(p.id)
    .map((m) => ({ ...m, entries: JSON.parse(m.entries || '[]'), conflicts: m.conflicts ? JSON.parse(m.conflicts) : null }));
  res.json({ history: rows, moneyNote: PLAN_MONEY_NOTE });
});

function planRevertDependents(strategy, record) {
  const dependents = [];
  const entries = JSON.parse(record.entries || '[]');
  const touched = new Set(entries.filter((e) => e.rowId).map((e) => `${e.table}:${e.rowId}`));
  const later = db.prepare(
    `SELECT m.*, s.name AS strategy_name FROM plan_merge_records m
     JOIN plan_strategies s ON s.id = m.strategy_id
     WHERE s.project_id = ? AND m.id > ? AND m.status = 'active' ORDER BY m.id DESC`).all(strategy.project_id, record.id);
  for (const m of later) {
    const mEntries = JSON.parse(m.entries || '[]');
    if (mEntries.some((e) => e.rowId && touched.has(`${e.table}:${e.rowId}`))) {
      dependents.push({ type: 'later_merge', mergeRecordId: m.id, strategyName: m.strategy_name, kind: m.kind });
    }
  }
  // Mainline rows created after this merge that reference a merged term.
  const mergedTermIds = entries.filter((e) => e.table === 'mortgage_terms' && e.rowId).map((e) => e.rowId);
  if (mergedTermIds.length) {
    const placeholders = mergedTermIds.map(() => '?').join(', ');
    const refs = db.prepare(`SELECT 'lump_sums' AS tbl, id FROM lump_sums WHERE term_id IN (${placeholders}) AND created_at > ?
      UNION ALL SELECT 'rate_segments', id FROM rate_segments WHERE term_id IN (${placeholders}) AND created_at > ?`)
      .all(...mergedTermIds, record.created_at, ...mergedTermIds, record.created_at);
    for (const r of refs) dependents.push({ type: 'mainline_reference', table: r.tbl, rowId: r.id });
  }
  return dependents;
}

app.post('/api/planning/strategies/:id/revert-preview', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!s.merged || !s.merge_record_id) return res.status(400).json({ error: 'strategy is not merged' });
  const record = db.prepare('SELECT * FROM plan_merge_records WHERE id = ?').get(s.merge_record_id);
  if (!record || record.status !== 'active') return res.status(400).json({ error: 'no active merge record for this strategy' });
  const entries = JSON.parse(record.entries || '[]');
  const current = planCurrentTables();
  const { inverse, conflicts } = buildRevertInverse({ entries, current });
  const dependents = planRevertDependents(s, record);
  res.json({ inverse, conflicts, dependents, moneyNote: PLAN_MONEY_NOTE });
});

// Shared merge-revert core: the strategy endpoint and the global
// History undo use the same code path. Throws {status, body} for
// 400s (dependents / unresolved conflicts); anything else is a 500.
// The revert is also a History commit (kind 'merge-revert'), recorded
// in the same transaction as the revert itself.
function revertMergedStrategy(s, p, user, resolutions) {
  const record = db.prepare('SELECT * FROM plan_merge_records WHERE id = ?').get(s.merge_record_id);
  if (!record || record.status !== 'active') {
    throw { status: 400, body: { error: 'no active merge record for this strategy' } };
  }
  const entries = JSON.parse(record.entries || '[]');
  const current = planCurrentTables();
  const { inverse, conflicts } = buildRevertInverse({ entries, current });
  const dependents = planRevertDependents(s, record);
  if (dependents.length) {
    throw { status: 400, body: { error: 'later merges or mainline records depend on this merge — revert them first (newest first)', dependents } };
  }
  const resByKey = new Map(resolutions.map((r) => [`${r.table}:${r.rowId}:${r.field}`, r]));
  const unresolved = conflicts.filter((c) => !resByKey.has(`${c.table}:${c.rowId}:${c.field}`));
  if (unresolved.length) throw { status: 400, body: { error: 'all conflicts must be resolved before reverting', conflicts: unresolved } };
  let finalInverse = inverse;
  for (const inv of finalInverse) {
    if (inv.kind !== 'update') continue;
    for (const f of Object.keys(inv.values || {})) {
      const r = resByKey.get(`${inv.table}:${inv.rowId}:${f}`);
      if (!r) continue;
      if (r.resolution === 'current') delete inv.values[f];
      else if (r.resolution === 'custom') inv.values[f] = r.customValue;
    }
    if (!Object.keys(inv.values || {}).length) inv._skip = true;
  }
  finalInverse = finalInverse.filter((x) => !x._skip);
  const tx = db.transaction(() => {
    const keys = [...new Map(finalInverse.map((inv) => [`${inv.table}:${inv.rowId}`, { table: inv.table, rowId: inv.rowId }])).values()];
    const beforeRows = keys.map(({ table, rowId }) => ({ table, pk: { id: rowId }, before: readRow(db, table, { id: rowId }) }));
    planApplyInverse(finalInverse);
    db.prepare('UPDATE plan_merge_records SET status = ? WHERE id = ?').run('reverted', record.id);
    const info = db.prepare('INSERT INTO plan_merge_records (strategy_id, kind, entries, conflicts, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, 'revert', JSON.stringify(finalInverse), JSON.stringify(resolutions), 'active', nowIso());
    db.prepare('UPDATE plan_strategies SET merged = 0, merge_record_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), s.id);
    const event = eventFromRowStates(keys.map(({ table, rowId }, i) => ({
      table, pk: { id: rowId },
      before: beforeRows[i].before,
      after: readRow(db, table, { id: rowId }),
    })));
    const commitId = recordCommit(db, {
      userId: user.id, username: user.username, module: 'planning',
      entityType: 'project', entityId: p.id, entityLabel: p.name,
      projectId: p.id, strategyId: s.id, mergeRecordId: info.lastInsertRowid,
      kind: 'merge-revert', summary: `Reverted merge · ${s.name}`,
      event, snapshot: snapshotByAggregate(db, 'project', p.id),
    });
    return { revertRecordId: info.lastInsertRowid, commitId };
  });
  return tx();
}

app.post('/api/planning/strategies/:id/revert', requireApiAuth, (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!s.merged || !s.merge_record_id) return res.status(400).json({ error: 'strategy is not merged' });
  try {
    const result = revertMergedStrategy(s, p, req.user, req.body?.resolutions || []);
    res.json({ ...result, moneyNote: PLAN_MONEY_NOTE });
  } catch (err) {
    if (err.status) return res.status(err.status).json(err.body);
    return res.status(500).json({ error: `revert failed: ${err.message}` });
  }
});

// ------------------------------------------------------- global history ----
// One commit per user Apply/Save, across all modules. List payloads
// carry metadata + event counts only — snapshots stay server-side
// (a card snapshot can be hundreds of KB) and are never sent.
app.get('/api/history/commits', requireApiAuth, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const projectId = req.query.projectId != null && req.query.projectId !== '' ? Number(req.query.projectId) : null;
  res.json(listCommits(db, {
    module: req.query.module || null,
    q: req.query.q || null,
    projectId,
    limit, offset,
  }));
});
app.get('/api/history/commits/:id', requireApiAuth, (req, res) => {
  const c = getCommit(db, Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'commit not found' });
  res.json({ commit: c });
});
app.post('/api/history/commits/:id/undo', requireApiAuth, (req, res) => {
  const c = getCommitFull(db, Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'commit not found' });
  // Merge commits revert through the merge flow (mainline-only rule,
  // dependency list, conflict flow) — never through generic undo.
  if (c.kind === 'merge') {
    const s = planStrategyById(c.strategy_id);
    if (!s) return res.status(404).json({ error: 'strategy not found' });
    const p = planProjectById(s.project_id, req.user.id);
    if (!p) return res.status(404).json({ error: 'project not found' });
    try {
      const result = revertMergedStrategy(s, p, req.user, []);
      res.json({ ...result, moneyNote: PLAN_MONEY_NOTE });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ ...err.body, strategyId: s.id });
      return res.status(500).json({ error: `revert failed: ${err.message}` });
    }
    return;
  }
  try {
    const tx = db.transaction(() => undoCommit(db, c, req.user));
    const commitId = tx();
    res.json({ commitId });
  } catch (err) {
    if (err.dependents) return res.status(400).json({ error: 'later commits depend on this commit — revert them first (newest first)', dependents: err.dependents });
    if (err.code === 'merge-revert') return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: `undo failed: ${err.message}` });
  }
});
app.post('/api/history/commits/:id/restore', requireApiAuth, (req, res) => {
  const c = getCommitFull(db, Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'commit not found' });
  try {
    const tx = db.transaction(() => restoreCommit(db, c, req.user));
    const commitId = tx();
    res.json({ commitId });
  } catch (err) {
    if (err.code === 'merge' || err.code === 'merged-flag') return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: `restore failed: ${err.message}` });
  }
});

// ------------------------------------------------------- planning AI --------
// All AI features go through the app's existing LLM plumbing (aiFill.js
// callLlm + parseModelJson). Nothing here adds a provider, a key, or
// key storage; unconfigured servers answer 503 with the same guidance
// as Fill with AI. AI output is always a PROPOSAL: the server validates
// bindings and the client confirms before anything is stored.
const PLAN_AI_NO_LLM = 'The server has no LLM configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.';
const PLAN_CHART_TEMPLATES = ['time_line', 'stacked_bar', 'share_doughnut', 'yearly_bars', 'fan_band', 'funds_flow', 'metric_cards'];

function planAiValidateChartSpecs(charts, projectId) {
  const errs = [];
  if (!Array.isArray(charts)) return ['charts must be an array'];
  for (const c of charts) {
    if (!PLAN_CHART_TEMPLATES.includes(c.template)) errs.push(`unknown chart template ${c.template}`);
    if (!c.title) errs.push('each chart spec needs a title');
    if (c.series && !Array.isArray(c.series)) errs.push('chart series must be an array');
  }
  return errs;
}
function planResolveNameRefs(ops, projectId) {
  // AI returns human references (property address, account name,
  // holding symbol). Resolve them to ids; ambiguous or missing refs
  // come back as unresolved items for the user to disambiguate — the
  // server never guesses a binding.
  const props = db.prepare('SELECT id, address FROM properties ORDER BY id').all();
  const accounts = db.prepare('SELECT id, name FROM invest_accounts ORDER BY id').all();
  const holdings = db.prepare('SELECT id, account_id, symbol, label FROM invest_holdings ORDER BY id').all();
  const unresolved = [];
  const resolved = [];
  for (const op of ops || []) {
    const p = { ...(op.params || {}) };
    const matchProp = (ref) => {
      if (ref == null) return null;
      if (Number.isInteger(Number(ref))) return props.find((x) => x.id === Number(ref)) || null;
      const hits = props.filter((x) => String(x.address || '').toLowerCase().includes(String(ref).toLowerCase()));
      return hits.length === 1 ? hits[0] : (hits.length > 1 ? { ambiguous: hits.map((h) => h.address) } : null);
    };
    const matchAccount = (ref) => {
      if (ref == null) return null;
      if (Number.isInteger(Number(ref))) return accounts.find((x) => x.id === Number(ref)) || null;
      const hits = accounts.filter((x) => String(x.name || '').toLowerCase().includes(String(ref).toLowerCase()));
      return hits.length === 1 ? hits[0] : (hits.length > 1 ? { ambiguous: hits.map((h) => h.name) } : null);
    };
    const matchHolding = (ref, accountId) => {
      if (ref == null) return null;
      if (Number.isInteger(Number(ref))) return holdings.find((x) => x.id === Number(ref)) || null;
      const pool = accountId ? holdings.filter((x) => x.account_id === accountId) : holdings;
      const hits = pool.filter((x) => String(x.symbol || '').toUpperCase() === String(ref).toUpperCase()
        || String(x.label || '').toLowerCase().includes(String(ref).toLowerCase()));
      return hits.length === 1 ? hits[0] : (hits.length > 1 ? { ambiguous: hits.map((h) => h.symbol || h.label) } : null);
    };
    let bad = null;
    if (['prepay', 'rate_switch', 'refinance', 'payment_change'].includes(op.op_type)) {
      const m = matchProp(p.propertyRef ?? p.propertyId);
      if (!m) bad = `property "${p.propertyRef ?? p.propertyId}" not found`;
      else if (m.ambiguous) bad = `property "${p.propertyRef}" is ambiguous: ${m.ambiguous.join(', ')}`;
      else p.propertyId = m.id;
    }
    if (['buy', 'position'].includes(op.op_type)) {
      // A custom-product buy (the manual GIC shape): an EXPLICIT null
      // accountId + a symbol, no holding ref. It buys a product with
      // no account, so there is nothing to resolve — the engine
      // creates the holding from the buy price. A missing accountId
      // (undefined) still fails, as before.
      const isCustomBuy = op.op_type === 'buy' && 'accountId' in p && p.accountId === null && typeof p.symbol === 'string' && p.symbol.trim() && !p.holdingRef && !p.holdingId;
      if (!isCustomBuy) {
        const m = matchAccount(p.accountRef ?? p.accountId);
        if (!m) bad = `account "${p.accountRef ?? p.accountId}" not found`;
        else if (m.ambiguous) bad = `account "${p.accountRef}" is ambiguous: ${m.ambiguous.join(', ')}`;
        else p.accountId = m.id;
      }
      if (p.holdingRef && !p.holdingId) {
        const h = matchHolding(p.holdingRef, p.accountId);
        if (!h) bad = `holding "${p.holdingRef}" not found`;
        else if (h.ambiguous) bad = `holding "${p.holdingRef}" is ambiguous: ${h.ambiguous.join(', ')}`;
        else p.holdingId = h.id;
      }
    }
    if (op.op_type === 'sell') {
      const h = matchHolding(p.holdingRef ?? p.holdingId, p.accountId);
      if (!h) bad = `holding "${p.holdingRef ?? p.holdingId}" not found`;
      else if (h.ambiguous) bad = `holding "${p.holdingRef}" is ambiguous: ${h.ambiguous.join(', ')}`;
      else p.holdingId = h.id;
    }
    if (bad) unresolved.push({ op, reason: bad });
    else resolved.push({ ...op, params: p });
  }
  return { resolved, unresolved };
}

app.post('/api/planning/strategies/:id/ai-describe', requireApiAuth, async (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const fileCheck = validateChatFiles(req.body?.files);
  if (fileCheck.error) return res.status(fileCheck.status).json({ error: fileCheck.error });
  const modelCheck = planAiPanelModel(req.body);
  if (modelCheck.error) return res.status(modelCheck.status).json({ error: modelCheck.error });
  // Panel conversation context, same plain-lines shape as ai-design.
  const historyText = String(req.body?.historyText || '').trim().slice(0, 4000);
  const props = db.prepare('SELECT id, address FROM properties ORDER BY id').all();
  const accounts = db.prepare('SELECT id, name FROM invest_accounts ORDER BY id').all();
  const holdings = db.prepare('SELECT id, account_id, symbol, label FROM invest_holdings ORDER BY id').all();
  const prompt = [
    'You propose planning operations as JSON only. No prose outside the JSON object.',
    'Operation types: prepay, rate_switch, refinance, payment_change, buy, sell, position.',
    'A buy REQUIRES a price > 0; when the user does not know a price, use position (units only), never guess a price.',
    'Dates are YYYY-MM-DD. Amounts are numbers (no currency symbols, no commas).',
    'Use propertyRef (address text), accountRef (account name) and holdingRef (symbol or label) — never invent ids.',
    'For a buy, include a "legs" array of {source_ref, amount} where source_ref is pot, cash, external, declared:<name>, op:<seq> or repay:<property address>; amount is a number, "all" or "remainder". Legs must sum to the buy amount.',
    'Also propose a short name for the strategy from the operation sequence (op types + key params, e.g. a January switch to fixed is "Jan to Fix", a $50,000 prepay is "pre pay 50000") — the user confirms or edits it before applying.',
    'Output: {"ops": [{"op_type": "...", "params": {...}, "legs": [...]}], "name": "short strategy name"}. A missing name is tolerated (the client falls back to a plain default).',
    `Properties: ${JSON.stringify(props)}`,
    `Accounts: ${JSON.stringify(accounts)}`,
    `Holdings: ${JSON.stringify(holdings)}`,
    ...(historyText ? [`Conversation so far:\n${historyText}`, 'Continue this conversation: do not repeat operations already proposed unless the user contradicts them.'] : []),
    `User request: ${text}`,
  ].join('\n');
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: planAiUserContent(prompt, fileCheck.fileInfos) }], process.env, modelCheck.model);
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.ops)) return res.status(502).json({ error: 'the AI response did not contain an operations list' });
  const { resolved, unresolved } = planResolveNameRefs(parsed.ops, p.id);
  const seqBase = (planOpsOf(s.id).length ? Math.max(...planOpsOf(s.id).map((o) => o.seq)) : 0) + 1;
  const withSeq = resolved.map((o, i) => ({ ...o, seq: seqBase + i }));
  const legs = [];
  for (const o of withSeq) for (const l of o.legs || []) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
  const errs = planValidateStrategyOps(s.id, [...planOpsOf(s.id), ...withSeq], legs);
  // Naming is automatic: the design carries a proposed name (or null
  // — the client falls back to "AI strategy").
  const aiName = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 80) : null;
  res.json({ ops: withSeq, unresolved, warnings: errs, configured: true, name: aiName });
});

// Reusable AI templates: an ai-model spec saved with its metadata
// schema (the questions it asked) so it can be applied to another
// strategy later. The spec is validated like any model spec; chart
// templates must be known, titles present.
function planValidateModelSpec(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['spec must be an object'];
  for (const part of ['bindings', 'formulas', 'assumptions', 'outputs', 'charts']) {
    if (!Array.isArray(spec[part])) errs.push(`model spec is missing ${part}`);
  }
  errs.push(...planAiValidateChartSpecs(spec.charts || [], 0));
  return errs;
}
app.get('/api/planning/templates', requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM plan_templates WHERE user_id = ? ORDER BY id DESC').all(req.user.id)
    .map((t) => ({ ...t, spec: JSON.parse(t.spec || '{}'), metadata_schema: t.metadata_schema ? JSON.parse(t.metadata_schema) : [], metadata_answers: t.metadata_answers ? JSON.parse(t.metadata_answers) : null }));
  res.json({ templates: rows });
});
app.post('/api/planning/templates', requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'template name is required' });
  const errs = planValidateModelSpec(b.spec);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const schema = Array.isArray(b.metadata_schema) ? b.metadata_schema : [];
  for (const q of schema) {
    if (!q || typeof q.field !== 'string' || !q.field.trim() || typeof q.label !== 'string' || !q.label.trim()) {
      return res.status(400).json({ error: 'metadata_schema entries need field and label' });
    }
  }
  const now = nowIso();
  const info = db.prepare('INSERT INTO plan_templates (user_id, name, source, spec, metadata_schema, metadata_answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, String(b.name).trim(), 'ai', JSON.stringify(b.spec), JSON.stringify(schema),
      b.metadata_answers && typeof b.metadata_answers === 'object' ? JSON.stringify(b.metadata_answers) : null, now, now);
  res.status(201).json({ template: db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(info.lastInsertRowid) });
});
app.delete('/api/planning/templates/:id', requireApiAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM plan_templates WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!t) return res.status(404).json({ error: 'template not found' });
  db.prepare('DELETE FROM plan_templates WHERE id = ?').run(t.id);
  res.json({ ok: true });
});
// Apply a saved AI template: the spec becomes the strategy's attached
// model (source 'template'); the op list stays the computation layer
// and can still be edited afterwards. Answers to the template's
// metadata questions are stored on the strategy's template_params.
app.post('/api/planning/projects/:id/strategies/from-template', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'strategy name is required' });
  const t = db.prepare('SELECT * FROM plan_templates WHERE id = ? AND user_id = ?').get(Number(b.template_id), req.user.id);
  if (!t) return res.status(404).json({ error: 'template not found' });
  const answers = b.answers && typeof b.answers === 'object' ? b.answers : null;
  const now = nowIso();
  const spec = JSON.parse(t.spec || '{}');
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Added strategy ${String(b.name).trim()} from template · ${p.name}`,
  }, () => {
    const minfo = db.prepare('INSERT INTO plan_ai_models (project_id, name, spec, version, source, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, String(b.name).trim(), JSON.stringify(spec), 1, 'template', answers ? JSON.stringify(answers) : null, now, now);
    const sinfo = db.prepare('INSERT INTO plan_strategies (project_id, name, letter, source, model_id, template, template_params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, String(b.name).trim(), planNextLetter(p.id), 'ai', minfo.lastInsertRowid, 'ai-template', JSON.stringify({ template_id: t.id, answers }), now, now);
    return { value: { strategy: planStrategyById(sinfo.lastInsertRowid), model: { id: minfo.lastInsertRowid, spec } }, entityId: p.id };
  });
  res.status(201).json(out);
});

app.post('/api/planning/strategies/:id/ai-model', requireApiAuth, async (req, res) => {
  const s = planStrategyById(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const p = planProjectById(s.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : null;
  // Conversation thread: the client sends the accumulated turns, the
  // server persists them on the strategy draft so the design continues
  // instead of restarting statelessly. The latest answers arrive
  // separately and are appended as the newest user turn.
  let thread = req.body?.history !== undefined
    ? sanitizeAiThread(req.body.history)
    : sanitizeAiThread(s.ai_thread ? JSON.parse(s.ai_thread) : null);
  if (answers && Object.keys(answers).length) thread = appendAiThread(thread, { role: 'user', answers });
  db.prepare('UPDATE plan_strategies SET ai_thread = ? WHERE id = ?').run(JSON.stringify(thread), s.id);
  // Feed the model the app snapshot so it stops asking for numbers the
  // app already holds (balances, terms, segments, prime + history,
  // jobs, rentals), plus the project's existing specs so it refines
  // instead of duplicating them.
  const snapshot = await planAiSnapshotForProject();
  const existing = planAiExistingSummaries(p.id);
  // Name binding: the user picks entities by NAME, never by database
  // id. Resolve the latest answers against the snapshot now: a value
  // matching nothing (or several candidates) comes back as a mismatch
  // question naming the candidates, never a silent re-ask.
  const candidates = planAiEntityCandidates(snapshot);
  const binding = bindAiNameAnswers(answers, candidates);
  if (binding.mismatches.length) {
    const mismatchQs = binding.mismatches.map((m) => ({
      field: m.entity,
      type: 'text',
      label: m.ambiguous
        ? `"${m.value}" matches several ${m.entity}s. Please choose one: ${m.candidates.join('; ')}`
        : `No ${m.entity} matches "${m.value}". Please choose one: ${m.candidates.join('; ')}`,
    }));
    const mismatchThread = appendAiThread(thread, { role: 'ai', questions: mismatchQs });
    db.prepare('UPDATE plan_strategies SET ai_thread = ? WHERE id = ?').run(JSON.stringify(mismatchThread), s.id);
    return res.json({ ask: mismatchQs, thread: mismatchThread, mismatch: true, configured: true, ...(binding.resolved.length ? { resolved: binding.resolved } : {}) });
  }
  const candidateGroups = [
    ['Properties', candidates.properties], ['Mortgage terms', candidates.terms],
    ['Accounts', candidates.accounts], ['Holdings', candidates.holdings],
  ].filter(([, list]) => list.length).map(([label, list]) => `${label}: ${list.map((c) => c.label).join('; ')}`);
  const candidateLines = candidateGroups.length ? candidateGroups.join(' | ') : 'none yet';
  const projLabels = planOptCategoryLabels(p.category, p.subcategory, planProjectEntityOf(p));
  const projectContext = projLabels && (projLabels.category || projLabels.entity)
    ? `This project is a ${projLabels.category || 'planning'} project${projLabels.subcategory ? ` (${projLabels.subcategory})` : ''}${projLabels.entity ? ` about ${projLabels.entity}` : ''}. Do not ask which property, account, holding, job, or rental this model is for — the project already determines it.`
    : null;
  const prompt = [
    'You design a planning model as JSON only. No prose outside the JSON object.',
    'The model spec has five parts, all required:',
    '1. bindings: [{name, entity, field}] — every input bound to an existing entity/field (property, holding, account, term, segment). Bind ONLY to values in the snapshot below; never cite a number that is not there.',
    '2. formulas: [{output, expression}] — structured expressions over bound inputs and intermediate series ids, e.g. "monthly interest = prior balance * monthly rate / 12".',
    '3. assumptions: [{key, value, source}] — every assumption explicit; nothing hidden.',
    '4. outputs: [{id, label}] — the computed series this model produces.',
    '5. charts: [{template, title, series}] — template is one of time_line, stacked_bar, share_doughnut, yearly_bars, fan_band, metric_cards (funds_flow is not offered: the app cannot render it); series entries bind to output ids.',
    'If a value you need is genuinely absent from the snapshot, return {"ask": [{"field": "snake_case_field", "label": "plain question", "type": "text|number|date"}]} — one question per missing value, never prose, never a value present in the snapshot.',
    'NEVER ask the user for a database ID (property_id, term_id, account_id, holding_id, segment_id, or any *_id field): the user does not know database IDs and cannot answer them. When you need the user to choose an entity, ask by NAME: name the candidates from the snapshot (property addresses, mortgage terms by property + start date, account names, holding symbols) and ask the user to pick one by name. The app binds the chosen name to the ID itself — never put an *_id field in an ask list.',
    `Named candidates the user can pick from: ${candidateLines}`,
    ...(projectContext ? [projectContext] : []),
    ...(binding.resolved.length ? [`Already resolved by name: ${binding.resolved.map((r) => `${r.field} "${r.label}" = ${r.entity} id ${r.id}`).join('; ')}. Bind to these ids in the spec.`] : []),
    `App data snapshot: ${JSON.stringify(snapshot)}`,
    `This project already has: ${JSON.stringify(existing)}. Refine what exists where the user asks; do not duplicate an existing strategy under a new name.`,
    ...(planProjectMetadataOf(p).aiBaseline ? [`Confirmed baseline for this project: ${JSON.stringify(planProjectMetadataOf(p).aiBaseline)}`, 'Design the spec against this confirmed baseline.'] : []),
    ...(thread.length ? [`Conversation so far:\n${renderAiThreadText(thread)}`, 'Continue this conversation: do not repeat questions already answered; ask only for values still missing.'] : []),
    ...(answers ? [`User-provided metadata (already answered — do not ask for these again): ${JSON.stringify(answers)}`] : []),
    `User request: ${text}`,
  ].join('\n');
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  let parsed = parseModelJson(raw);
  if (!parsed) return res.status(502).json({ error: 'the AI response did not contain a model spec' });
  // Server-side ask hygiene: rewrite id questions to name picks, drop
  // questions already answered in the thread (answered once = answered).
  // A malformed ask is still a 502; an ask left empty by the drop means
  // the model re-asked only answered questions — one retry forces it to
  // produce the spec instead of looping the user back to the same form.
  const filterAsk = (askRaw) => {
    const qs = normalizeAiAsk(askRaw);
    if (!qs) return { malformed: true, questions: null };
    return { malformed: false, questions: dropAnsweredAiQuestions(rewriteAiIdQuestions(qs, candidates), thread, answers) };
  };
  let askQuestions = null;
  if (parsed.ask) {
    let f = filterAsk(parsed.ask);
    if (f.malformed) return res.status(502).json({ error: 'the AI response did not contain usable questions' });
    if (!f.questions.length) {
      let raw2;
      try {
        raw2 = await callLlm([{ role: 'user', content: `${prompt}\nAll pending questions are already answered in the conversation above. Do not return an ask list — produce the complete model spec JSON now.` }], process.env, getAiFillModel());
      } catch (e) {
        return res.status(502).json({ error: `AI call failed: ${e.message}` });
      }
      const parsed2 = parseModelJson(raw2);
      if (!parsed2) return res.status(502).json({ error: 'the AI response did not contain a model spec' });
      if (parsed2.ask) {
        f = filterAsk(parsed2.ask);
        if (f.malformed) return res.status(502).json({ error: 'the AI response did not contain usable questions' });
        if (!f.questions.length) return res.status(502).json({ error: 'the AI kept asking questions that are already answered — please rephrase the request' });
        askQuestions = f.questions;
      } else {
        parsed = parsed2;
      }
    } else {
      askQuestions = f.questions;
    }
  }
  if (askQuestions) {
    const newThread = appendAiThread(thread, { role: 'ai', questions: askQuestions });
    db.prepare('UPDATE plan_strategies SET ai_thread = ? WHERE id = ?').run(JSON.stringify(newThread), s.id);
    return res.json({ ask: askQuestions, thread: newThread, configured: true, ...(binding.resolved.length ? { resolved: binding.resolved } : {}) });
  }
  const specErrs = () => {
    const e = [];
    for (const part of ['bindings', 'formulas', 'assumptions', 'outputs', 'charts']) {
      if (!Array.isArray(parsed[part])) e.push(`model spec is missing ${part}`);
    }
    e.push(...planAiValidateChartSpecs(parsed.charts || [], p.id));
    return e;
  };
  let errs = specErrs();
  if (errs.length) {
    // ONE self-repair retry: feed the exact failing rules back, so a
    // lite model that omitted or invented a part gets one chance to
    // fix it. A repair that asks again goes through the same ask
    // hygiene; a repair that still fails surfaces its own errors
    // exactly (the UI shows the rule, never a generic failure).
    let rawR;
    try {
      rawR = await callLlm([{ role: 'user', content: aiRepairPrompt(prompt, errs) }], process.env, getAiFillModel());
    } catch (e) {
      return res.status(502).json({ error: `AI call failed: ${e.message}` });
    }
    const parsedR = parseModelJson(rawR);
    if (!parsedR) return res.status(502).json({ error: errs.join('; ') });
    if (parsedR.ask) {
      const f = filterAsk(parsedR.ask);
      if (f.malformed) return res.status(502).json({ error: 'the AI response did not contain usable questions' });
      if (!f.questions.length) return res.status(502).json({ error: 'the AI kept asking questions that are already answered — please rephrase the request' });
      const repairThread = appendAiThread(thread, { role: 'ai', questions: f.questions });
      db.prepare('UPDATE plan_strategies SET ai_thread = ? WHERE id = ?').run(JSON.stringify(repairThread), s.id);
      return res.json({ ask: f.questions, thread: repairThread, configured: true, ...(binding.resolved.length ? { resolved: binding.resolved } : {}) });
    }
    parsed = parsedR;
    errs = specErrs();
    if (errs.length) return res.status(502).json({ error: errs.join('; ') });
  }
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id, strategyId: s.id,
    entityLabel: p.name, summary: `Designed model · ${s.name} · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_ai_models (project_id, name, spec, version, source, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, String(req.body.name || `Model ${new Date().toISOString().slice(0, 10)}`), JSON.stringify(parsed), 1, 'ai', answers ? JSON.stringify(answers) : null, now, now);
    return { value: { model: { id: info.lastInsertRowid, spec: parsed, metadata: answers }, thread, configured: true, ...(binding.resolved.length ? { resolved: binding.resolved } : {}) }, entityId: p.id };
  });
  res.status(201).json(out);
});

// AI-designed baseline (project level, designed BEFORE the strategy
// spec; follow-up iterates both). The baseline definition is stored in
// project metadata (aiBaseline) plus its conversation thread
// (aiBaselineThread); it never overwrites the template answers —
// metadata keys merge, they do not replace. Stock reference is always
// 'current-plan' (the comparison math accepts nothing else). A
// primeScenario in an applied baseline becomes a real project scenario
// and is set as base, so the baseline has an effect instead of being
// a note. All writes are Apply-only: design returns a preview.
function planProjectMetadataOf(p) {
  try { return p.metadata ? JSON.parse(p.metadata) : {}; } catch { return {}; }
}
function planWriteProjectMetadata(p, patch) {
  const meta = { ...planProjectMetadataOf(p), ...patch };
  db.prepare('UPDATE plan_projects SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), nowIso(), p.id);
  return meta;
}
app.post('/api/planning/projects/:id/ai-baseline', requireApiAuth, async (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const fileCheck = validateChatFiles(req.body?.files);
  if (fileCheck.error) return res.status(fileCheck.status).json({ error: fileCheck.error });
  const modelCheck = planAiPanelModel(req.body);
  if (modelCheck.error) return res.status(modelCheck.status).json({ error: modelCheck.error });
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : null;
  // Targeted follow-up: a baselineId pins the thread to one baseline
  // card; without it the legacy project-level thread is used.
  let targetRow = null;
  if (req.body?.baselineId !== undefined && req.body?.baselineId !== null) {
    targetRow = db.prepare('SELECT * FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(req.body.baselineId), p.id);
    if (!targetRow) return res.status(404).json({ error: 'baseline not found' });
  }
  const stored = planProjectMetadataOf(p);
  const storedThread = targetRow && targetRow.ai_thread ? JSON.parse(targetRow.ai_thread) : stored.aiBaselineThread;
  const confirmedBaseline = targetRow ? planBaselineRow(targetRow).definition : stored.aiBaseline;
  const writeThread = (thread) => {
    if (targetRow) db.prepare('UPDATE plan_baselines SET ai_thread = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(thread), nowIso(), targetRow.id);
    else planWriteProjectMetadata(p, { aiBaselineThread: thread });
  };
  let thread = req.body?.history !== undefined
    ? sanitizeAiThread(req.body.history)
    : sanitizeAiThread(storedThread || null);
  if (answers && Object.keys(answers).length) thread = appendAiThread(thread, { role: 'user', answers });
  writeThread(thread);
  const snapshot = await planAiSnapshotForProject();
  const existing = planAiExistingSummaries(p.id);
  const prompt = [
    'You design a planning baseline definition as JSON only. No prose outside the JSON object.',
    'The baseline changes nothing: it is a pure do-nothing reference (name + one-line description only). It carries NO prime path and NO stock reference — rate paths live on strategies as factors, never on the baseline. The baseline has: description (one line), assumptions: [{key, value}].',
    'Bind ONLY to values in the snapshot below; never cite a number that is not there. Do not propose a prime path or a stock reference.',
    'If a value you need is genuinely absent from the snapshot, return {"ask": [{"field": "snake_case_field", "label": "plain question", "type": "text|number|date"}]} — one question per missing value, never prose, never a value present in the snapshot.',
    `App data snapshot: ${JSON.stringify(snapshot)}`,
    `This project already has: ${JSON.stringify(existing)}. Refine what exists where the user asks; do not duplicate an existing baseline under a new name.`,
    ...(confirmedBaseline ? [`Currently confirmed baseline: ${JSON.stringify(confirmedBaseline)}`, 'Refine it: keep what the user does not contradict.'] : []),
    ...(thread.length ? [`Conversation so far:\n${renderAiThreadText(thread)}`, 'Continue this conversation: do not repeat questions already answered; ask only for values still missing.'] : []),
    ...(answers ? [`User-provided metadata (already answered — do not ask for these again): ${JSON.stringify(answers)}`] : []),
    `User request: ${text}`,
  ].join('\n');
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: planAiUserContent(prompt, fileCheck.fileInfos) }], process.env, modelCheck.model);
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  if (!parsed) return res.status(502).json({ error: 'the AI response did not contain a baseline definition' });
  if (parsed.ask) {
    const questions = normalizeAiAsk(parsed.ask);
    if (!questions) return res.status(502).json({ error: 'the AI response did not contain usable questions' });
    const newThread = appendAiThread(thread, { role: 'ai', questions });
    writeThread(newThread);
    return res.json({ ask: questions, thread: newThread, configured: true });
  }
  const baseline0 = parsed.baseline || parsed;
  delete baseline0.primeScenario;
  delete baseline0.stockReference;
  let baseline = baseline0;
  let errs = validateAiBaseline(baseline);
  if (errs.length) {
    // ONE self-repair retry, same shape as ai-model: feed the exact
    // failing rules back; a repair that asks goes through the ask
    // path, a repair that still fails surfaces its own errors.
    let rawR;
    try {
      rawR = await callLlm([{ role: 'user', content: planAiUserContent(aiRepairPrompt(prompt, errs), fileCheck.fileInfos) }], process.env, modelCheck.model);
    } catch (e) {
      return res.status(502).json({ error: `AI call failed: ${e.message}` });
    }
    const parsedR = parseModelJson(rawR);
    if (!parsedR) return res.status(502).json({ error: errs.join('; ') });
    if (parsedR.ask) {
      const questions = normalizeAiAsk(parsedR.ask);
      if (!questions) return res.status(502).json({ error: 'the AI response did not contain usable questions' });
      const repairThread = appendAiThread(thread, { role: 'ai', questions });
      writeThread(repairThread);
      return res.json({ ask: questions, thread: repairThread, configured: true });
    }
    baseline = parsedR.baseline || parsedR;
    delete baseline.primeScenario;
    delete baseline.stockReference;
    errs = validateAiBaseline(baseline);
    if (errs.length) return res.status(502).json({ error: errs.join('; ') });
  }
  const newThread = appendAiThread(thread, { role: 'ai', baseline });
  writeThread(newThread);
  res.json({ baseline, thread: newThread, configured: true });
});
app.post('/api/planning/projects/:id/ai-baseline/apply', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const baseline = req.body?.baseline;
  if (!baseline || typeof baseline !== 'object') return res.status(400).json({ error: 'baseline is required' });
  // The baseline changes nothing: any primeScenario riding along in an
  // AI-designed definition is stripped on apply (never stored as a
  // scenario, never rendered), and no metadata is written — the
  // baseline list entry is the whole record.
  const errs = validateAiBaseline(baseline);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const stored = { ...baseline };
  delete stored.primeScenario;
  delete stored.stockReference;
  // Targeted apply: update one baseline card's definition, nothing else.
  if (req.body?.baselineId !== undefined && req.body?.baselineId !== null) {
    const row = db.prepare('SELECT * FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(req.body.baselineId), p.id);
    if (!row) return res.status(404).json({ error: 'baseline not found' });
    const out = commitTx(req, 'project', {
      module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
      entityLabel: p.name, summary: `Applied AI baseline · ${p.name}`,
    }, () => {
      db.prepare('UPDATE plan_baselines SET name = ?, definition = ?, updated_at = ? WHERE id = ?')
        .run(req.body.name ? String(req.body.name).trim() : row.name, JSON.stringify(stored), nowIso(), row.id);
      return { value: { project: planProjectViewRow(planProjectById(p.id, req.user.id)), baseline: planBaselineRow(db.prepare('SELECT * FROM plan_baselines WHERE id = ?').get(row.id)) }, entityId: p.id };
    });
    return res.json(out);
  }
  // Append-only list: a legacy apply also appends a list entry, so the
  // baseline list never loses an applied baseline.
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Applied AI baseline · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_baselines (project_id, name, source, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, baseline.description || 'AI baseline', 'ai', JSON.stringify(stored), now, now);
    return { value: { project: planProjectViewRow(planProjectById(p.id, req.user.id)), baseline: planBaselineRow(db.prepare('SELECT * FROM plan_baselines WHERE id = ?').get(info.lastInsertRowid)) }, entityId: p.id };
  });
  res.json(out);
});

// Deterministic GIC template for ai-create propose (user 2026-11-04):
// the manual GIC path models a GIC as ONE buy op {accountId: null,
// symbol: <GIC name>, currency CAD, date, amount: pool proceeds,
// price: 100, expectedReturnPct: <rate>} with no legs (the pool
// funds it); the rate travels WITH THE BUY (the sink is gone since
// 2026-11-05 — the buy list IS the sink). The engine grows the new
// holding from its buy price at the buy's rate. A position op on a
// fund is never the shape.
// Returns {ask} (missing rate/date/amount — never invented),
// {error} (bad entity), or {response} (the propose payload, same
// shape as the LLM path: proposal + unresolved + warnings).
function planGicTemplateProposal(text, answers, category, subcategory, entity) {
  const ans = answers || {};
  // Rate: a previous answer wins, else parse "<n>%" / "<n> percent"
  // from the text.
  let rate = null;
  if (ans.gic_rate != null && String(ans.gic_rate).trim() !== '') rate = Number(String(ans.gic_rate).replace(/,/g, '').trim());
  if (rate == null || Number.isNaN(rate)) {
    // NOTE: no \b after the unit — % is a non-word char, so a word
    // boundary can never follow it ("4.12% " has no boundary after
    // %). (?![a-z]) still keeps "percentage" from matching.
    const m = /(\d+(?:\.\d+)?)\s*(?:%|percent|pct)(?![a-z])/i.exec(text);
    if (m) rate = Number(m[1]);
  }
  // Start date: a previous answer wins, else the first YYYY-MM-DD
  // (or YYYY-MM, read as the 1st) in the text.
  let date = null;
  if (ans.gic_start != null && String(ans.gic_start).trim() !== '') date = String(ans.gic_start).trim();
  if (!date) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(text) || /(\d{4}-\d{2})\b/.exec(text);
    if (m) date = m[1].length === 7 ? `${m[1]}-01` : m[1];
  }
  // Term (label only): "180 days" / "180-day" / "180d".
  let termDays = null;
  const tm = /(\d+)\s*(?:days?|day)\b/i.exec(text) || /(\d+)[- ]day\b/i.exec(text);
  if (tm) termDays = Number(tm[1]);
  const ask = [];
  if (rate == null || Number.isNaN(rate) || rate < -90 || rate > 500) ask.push({ field: 'gic_rate', label: 'GIC annual rate (%)', type: 'number' });
  const curMonth = currentMonthKey();
  const realDate = (d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
    const dt = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
  };
  if (!date || !realDate(date) || date < `${curMonth}-01`) ask.push({ field: 'gic_start', label: 'GIC start date (must be this month or later)', type: 'date' });
  if (ask.length) return { ask };
  // Funding total: the entity's value (pool total for a pool,
  // current value for an account/holding). Unknown or empty → ask.
  let amount = null;
  if (ans.gic_amount != null && String(ans.gic_amount).trim() !== '') amount = Number(String(ans.gic_amount).replace(/,/g, '').trim());
  if (amount == null || Number.isNaN(amount)) {
    // Baseline figures are identical across subcategories; a null
    // subcategory (AI-create without a pick) reads them off the
    // first subcategory of the category.
    const rec = planRecommendationFor(category, subcategory || planFirstSubcategory(category), entity);
    if (rec.error) return { error: rec.error };
    const figs = (rec.baseline && rec.baseline.figures) || {};
    const total = figs.poolValue != null ? figs.poolValue : (figs.value != null ? figs.value : null);
    if (total != null && total > 0) amount = Math.round(total * 100) / 100;
  }
  if (amount == null || Number.isNaN(amount) || amount <= 0) return { ask: [{ field: 'gic_amount', label: 'GIC amount (CAD)', type: 'number' }] };
  const name = `GIC ${rate}%${termDays ? ` ${termDays}d` : ''}`;
  const proposal = {
    project: { name: 'GIC Investment', question: text },
    scenario: { name: 'Base Scenario', factors: {} },
    baseline: { name: 'Do Nothing', description: 'Hold the pool as-is', assumptions: [] },
    strategy: {
      name: 'GIC Purchase Strategy',
      ops: [{ op_type: 'buy', params: { accountId: null, symbol: name, currency: 'CAD', date, amount, price: 100, expectedReturnPct: rate, ...(termDays ? { termDays } : {}) } }],
    },
  };
  const { proposal: norm, errors: shapeErrors } = validateAiCreateProposal(proposal);
  const { resolved, unresolved } = planResolveNameRefs(norm.strategy.ops, null);
  const seqOps = resolved.map((o, i) => ({ ...o, seq: i + 1 }));
  const legs = [];
  for (const o of seqOps) for (const l of o.legs || []) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
  const opErrs = planValidateStrategyOps(null, seqOps, legs);
  return { response: { proposal: { ...norm, strategy: { ...norm.strategy, ops: seqOps } }, unresolved, warnings: { shape: shapeErrors, scenario: [], baseline: [], ops: opErrs }, configured: true } };
}

// Pure-AI project creation: a NEW project designed from one stated
// need. The entry lives in the creation flow AFTER the category /
// entity / scope pickers, so the trio below is already scoped to a
// validated optimization (same taxonomy + entity rules as project
// creation). The snapshot is project-less by construction —
// planAiSnapshotForProject reads only global tables — and a new
// project has no existing entities, so the prompt says so instead of
// inventing a refinement target. Propose NEVER writes: semantic
// failures surface as per-part flags (the preview shows them and
// Apply re-validates), never as silently dropped ops or guessed
// bindings. No self-repair retry here (unlike ai-baseline/ai-model):
// the preview is the correction surface, and a repair loop over a
// four-part object would hide which part failed.
app.post('/api/planning/ai-create/propose', requireApiAuth, async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const category = b.category ? String(b.category) : null;
  const subcategory = b.subcategory ? String(b.subcategory) : null;
  const entity = b.entity && typeof b.entity === 'object' ? b.entity : null;
  if (!planOptCategory(category)) return res.status(400).json({ error: 'unknown optimization category' });
  if (subcategory && !planOptSubcategory(category, subcategory)) return res.status(400).json({ error: 'unknown subcategory for this category' });
  const entErr = planValidateOptEntity(category, entity);
  if (entErr) return res.status(400).json({ error: entErr });
  const answers = b.answers && typeof b.answers === 'object' ? b.answers : null;
  // Deterministic GIC template (user 2026-11-04): a GIC request under
  // the gic subcategory never goes to the model — the shape is fixed
  // (one buy op carrying the rate, mirroring the manual GIC path), so
  // the model cannot draft it into a fund position op again. It needs
  // no LLM, so it also runs when the LLM is unconfigured. Missing
  // rate/date/amount are asked for, never invented. With no
  // subcategory pick, a GIC request under investment still takes the
  // template — the text must name GIC, so a non-GIC investment
  // request never lands here.
  const isGicRequest = subcategory === 'gic'
    || (subcategory == null && category === 'investment' && /\bgic\b/i.test(text));
  if (isGicRequest) {
    const gic = planGicTemplateProposal(text, answers, category, subcategory, entity);
    if (gic.ask) return res.json({ ask: normalizeAiAsk(gic.ask) || gic.ask, configured: true });
    if (gic.error) return res.status(400).json({ error: gic.error });
    return res.json(gic.response);
  }
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const fileCheck = validateChatFiles(b.files);
  if (fileCheck.error) return res.status(fileCheck.status).json({ error: fileCheck.error });
  const modelCheck = planAiPanelModel(b);
  if (modelCheck.error) return res.status(modelCheck.status).json({ error: modelCheck.error });
  const historyText = String(b.historyText || '').trim().slice(0, 4000);
  const snapshot = await planAiSnapshotForProject();
  const prompt = [
    'You design ONE coherent planning project as JSON only. No prose outside the JSON object.',
    'Output: {"project": {"name": "...", "question": "..."}, "scenario": {"name": "...", "factors": {...}}, "baseline": {"name": "...", "description": "one line", "assumptions": [{"key": "...", "value": ...}]}, "strategy": {"name": "...", "ops": [{"op_type": "...", "params": {...}, "legs": [...]}]}}.',
    'The scenario holds ONLY world factors: prime (a rate path), stock (an expected annual return %), propertyGrowth, salaryGrowth, rentGrowth. It NEVER holds a sink, an operation, or a price. prime: {"preset": "flat"|"optimistic"|"pessimistic"|"up"|"down"} or {"points": [{"month": "YYYY-MM", "rate": number}]}. Points must be increasing months, rates 0–30. stock/propertyGrowth/salaryGrowth/rentGrowth: {"valuePct": number} between -90 and 500. Only include a factor the user actually asked about — never invent one. Salary and rent growth are stored and labeled only; the projection has no earnings leg yet.',
    'The baseline changes nothing: a pure do-nothing reference (name + one-line description + assumptions only). It carries NO prime path and NO stock reference.',
    'Operation types: prepay, rate_switch, refinance, payment_change, buy, sell, position. A buy REQUIRES a price > 0; when the user does not know a price, use position (units only), never guess a price. Dates are YYYY-MM-DD. Amounts are numbers (no currency symbols, no commas). Use propertyRef (address text), accountRef (account name) and holdingRef (symbol or label) — never invent ids. For a buy, include a "legs" array of {source_ref, amount} where source_ref is pot, cash, external, declared:<name>, op:<seq> or repay:<property address>; amount is a number, "all" or "remainder". Legs must sum to the buy amount.',
    'A GIC (guaranteed investment certificate) is a custom product, never a fund holding: model it as ONE buy op {"accountId": null, "symbol": "GIC <rate>%", "currency": "CAD", "date": "YYYY-MM-DD", "amount": <funding total>, "price": 100, "expectedReturnPct": <rate>} with no legs (the pool funds it). NEVER a position op on a fund, NEVER a buy with a holdingRef. If the rate or start date is missing, ask for it instead of guessing. When the user gives a term ("180 days", "1 year"), add "termDays": <days> to the buy params — at maturity the proceeds return to the pot as cash and the comparison ends at the maturity month.',
    'If a value you need is genuinely missing from the user\'s need and the snapshot, return {"ask": [{"field": "snake_case_field", "label": "plain question", "type": "text|number|date"}]} — one question per missing value, never prose, never invent a value.',
    'Bind ONLY to values in the snapshot below; never cite a number that is not there. This is a NEW project: it has no existing scenarios, baselines, or strategies yet.',
    `Optimization: category ${category}, subcategory ${subcategory || '—'}, entity ${JSON.stringify(entity)}. Fit the trio to this optimization; where the user need touches the picked entity, the strategy's operations must act on it.`,
    `App data snapshot: ${JSON.stringify(snapshot)}`,
    ...(answers ? [`User-provided answers (already answered — do not ask for these again): ${JSON.stringify(answers)}`] : []),
    ...(historyText ? [`Conversation so far:\n${historyText}`, 'Continue this conversation: do not repeat parts already proposed unless the user contradicts them.'] : []),
    `User need: ${text}`,
  ].join('\n');
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: planAiUserContent(prompt, fileCheck.fileInfos) }], process.env, modelCheck.model);
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  if (!parsed || typeof parsed !== 'object') return res.status(502).json({ error: 'the AI response did not contain a project proposal' });
  if (parsed.ask) {
    const questions = normalizeAiAsk(parsed.ask);
    if (!questions) return res.status(502).json({ error: 'the AI response did not contain usable questions' });
    return res.json({ ask: questions, configured: true });
  }
  const { proposal, errors: shapeErrors } = validateAiCreateProposal(parsed);
  const factors = expandScenarioPrimePreset(proposal.scenario.factors || {}, snapshot.prime, currentMonthKey());
  const scenarioErrs = validateScenarioFactors(factors, currentMonthKey());
  const baselineErrs = validateAiBaseline({ description: proposal.baseline.description, assumptions: proposal.baseline.assumptions });
  const { resolved, unresolved } = planResolveNameRefs(proposal.strategy.ops, null);
  const seqOps = resolved.map((o, i) => ({ ...o, seq: i + 1 }));
  const legs = [];
  for (const o of seqOps) for (const l of o.legs || []) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
  const opErrs = planValidateStrategyOps(null, seqOps, legs);
  // A draft that would fail Apply (every warning category above is
  // apply-fatal) never surfaces its raw validation strings as the
  // primary message: ONE clarify call feeds the exact failing rules
  // back to the model and asks it to ask the user for the missing or
  // invalid values instead of guessing them. A clarify that asks
  // goes through the ask path; anything else falls back to the
  // proposal + warnings below (the preview stays the edit surface).
  const blocking = [...shapeErrors, ...scenarioErrs, ...baselineErrs, ...opErrs, ...unresolved.map((u) => u.reason)];
  if (blocking.length) {
    let ask = null;
    try {
      const clarifyPrompt = [
        'You asked the user to design a planning project as JSON. Your draft failed validation for these reasons:',
        ...blocking.map((e) => `- ${e}`),
        `User need: ${text}`,
        ...(historyText ? [`Conversation so far:\n${historyText}`] : []),
        ...(answers ? [`User-provided answers (already answered — do not ask for these again): ${JSON.stringify(answers)}`] : []),
        'Draft (for reference only — do not reuse its invalid values):',
        JSON.stringify(parsed),
        'Do not guess or invent values. Ask the user for the missing or invalid values only. Reply with JSON only: {"ask": [{"field": "snake_case_field", "label": "plain question", "type": "date"|"number"|"text"}]} — one question per missing or invalid value, no prose, no values.',
      ].join('\n');
      const rawClarify = await callLlm([{ role: 'user', content: clarifyPrompt }], process.env, modelCheck.model);
      const parsedClarify = parseModelJson(rawClarify);
      if (parsedClarify) ask = normalizeAiAsk(parsedClarify.ask);
    } catch (e) {
      // Clarify failed (e.g. LLM 502) — fall through to the proposal
      // + warnings below; the client shows a plain note, not the raw
      // strings, as the thread message.
    }
    if (ask) return res.json({ ask, configured: true });
  }
  res.json({
    proposal: { ...proposal, scenario: { ...proposal.scenario, factors }, strategy: { ...proposal.strategy, ops: seqOps } },
    unresolved,
    warnings: { shape: shapeErrors, scenario: scenarioErrs, baseline: baselineErrs, ops: opErrs },
    configured: true,
  });
});

// Apply a proposed trio: project + scenario + baseline + strategy in
// ONE History commit. Every part is re-validated here; any failure
// is a 400 and NOTHING is written (the commitTx transaction rolls
// back), so a half-created project is never presented as done. The
// created trio is AI-designed throughout (scenario source 'ai',
// baseline source 'ai', strategy source 'ai'), so the report routing
// rule disables preset Generate on the created project and only
// Generate with AI may be used.
app.post('/api/planning/ai-create/apply', requireApiAuth, async (req, res) => {
  const b = req.body || {};
  const proposal = b.proposal && typeof b.proposal === 'object' ? b.proposal : null;
  if (!proposal) return res.status(400).json({ error: 'proposal is required' });
  const category = b.category ? String(b.category) : null;
  const subcategory = b.subcategory ? String(b.subcategory) : null;
  const entity = b.entity && typeof b.entity === 'object' ? b.entity : null;
  if (!planOptCategory(category)) return res.status(400).json({ error: 'unknown optimization category' });
  if (subcategory && !planOptSubcategory(category, subcategory)) return res.status(400).json({ error: 'unknown subcategory for this category' });
  const entErr = planValidateOptEntity(category, entity);
  if (entErr) return res.status(400).json({ error: entErr });
  const { proposal: norm, errors: shapeErrors } = validateAiCreateProposal(proposal);
  if (shapeErrors.length) return res.status(400).json({ error: shapeErrors.join('; ') });
  const snapshot = await planAiSnapshotForProject();
  const factors = expandScenarioPrimePreset(norm.scenario.factors || {}, snapshot.prime, currentMonthKey());
  const scenarioErrs = validateScenarioFactors(factors, currentMonthKey());
  if (scenarioErrs.length) return res.status(400).json({ error: scenarioErrs.join('; ') });
  const baselineDef = { description: norm.baseline.description, assumptions: Array.isArray(norm.baseline.assumptions) ? norm.baseline.assumptions : [] };
  const baselineErrs = validateAiBaseline(baselineDef);
  if (baselineErrs.length) return res.status(400).json({ error: baselineErrs.join('; ') });
  const { resolved, unresolved } = planResolveNameRefs(norm.strategy.ops, null);
  if (unresolved.length) return res.status(400).json({ error: unresolved.map((u) => u.reason).join('; ') });
  const seqOps = resolved.map((o, i) => ({ ...o, seq: i + 1 }));
  const legs = [];
  for (const o of seqOps) for (const l of o.legs || []) legs.push({ op_seq: o.seq, source_ref: l.source_ref, amount: l.amount });
  const opErrs = planValidateStrategyOps(null, seqOps, legs);
  if (opErrs.length) return res.status(400).json({ error: opErrs.join('; ') });
  const now = nowIso();
  const snap = JSON.stringify(planSnapshotMainline());
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: null,
    entityLabel: norm.project.name, summary: `Created project ${norm.project.name} with AI`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_projects (user_id, name, question, snapshot, template, metadata, category, subcategory, entity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, norm.project.name, norm.project.question || null, snap, null, null, category, subcategory, JSON.stringify(entity), now, now);
    const pid = info.lastInsertRowid;
    const steps = factors.prime && Array.isArray(factors.prime.points)
      ? factors.prime.points.map((pt) => ({ date: `${pt.month}-01`, rate: Number(pt.rate) })) : null;
    const sc = db.prepare('INSERT INTO plan_scenarios (project_id, name, direction, stance, magnitude, steps, factors, is_base, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(pid, norm.scenario.name, 'flat', 'neutral', null, steps ? JSON.stringify(steps) : null, JSON.stringify(factors), 1, 'ai', now, now);
    const def = { ...baselineDef, stockReference: 'current-plan' };
    const bl = db.prepare('INSERT INTO plan_baselines (project_id, name, source, category, subcategory, entity, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(pid, norm.baseline.name, 'ai', category, subcategory, JSON.stringify(entity), JSON.stringify(def), now, now);
    const st = db.prepare('INSERT INTO plan_strategies (project_id, name, letter, source, template, template_params, sink, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(pid, norm.strategy.name, planNextLetter(pid), 'ai', null, null, norm.strategy.sink ? JSON.stringify(norm.strategy.sink) : null, now, now);
    for (const o of seqOps) {
      // Same buy normalization as the op endpoint: a buy posted with
      // amount + price only stores its units too, so the buy list
      // shows units + amount (the GIC template buy is amount-only).
      if (o.op_type === 'buy') planNormalizeBuyParams(o.params);
      const oi = db.prepare('INSERT INTO plan_ops (strategy_id, seq, op_type, params, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(st.lastInsertRowid, o.seq, o.op_type, JSON.stringify(o.params), 'ai', now, now);
      // A buy with no legs stores the implicit cash leg (remainder)
      // — the same rule the op form applies at save. Without it the
      // buy passes validation (validateLegs checks existing legs
      // only) and fails at report time as unfunded.
      const opLegs = o.op_type === 'buy' && !(o.legs || []).length
        ? [{ source_ref: 'cash', amount: 'remainder' }] : (o.legs || []);
      for (const l of opLegs) {
        db.prepare('INSERT INTO plan_legs (op_id, source_ref, amount, created_at) VALUES (?, ?, ?, ?)')
          .run(oi.lastInsertRowid, l.source_ref, String(l.amount), now);
      }
    }
    return {
      value: {
        project: planProjectViewRow(planProjectById(pid, req.user.id)),
        scenario: planScenarioRow(db.prepare('SELECT * FROM plan_scenarios WHERE id = ?').get(sc.lastInsertRowid)),
        baseline: planBaselineRow(db.prepare('SELECT * FROM plan_baselines WHERE id = ?').get(bl.lastInsertRowid)),
        strategy: planStrategyById(st.lastInsertRowid),
      },
      entityId: pid,
    };
  });
  res.status(201).json(out);
});

app.post('/api/planning/projects/:id/ai-report', requireApiAuth, async (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  // Follow-up conversation (append mode): the client may send the
  // thread so far as plain summary lines (report's current charts +
  // earlier turns). Bounded and string-only; a malformed history is
  // ignored rather than failing the turn.
  const history = Array.isArray(req.body?.history)
    ? req.body.history.filter((l) => typeof l === 'string').map((l) => l.slice(0, 500)).slice(0, 20)
    : [];
  const strategies = db.prepare('SELECT id, name, letter FROM plan_strategies WHERE project_id = ? ORDER BY id').all(p.id);
  // Generation-time grounding (user bug 2026-11-03): the viewer
  // renders over the whole snapshot, so tell the model what series
  // actually exist — a series on a template that cannot render it
  // used to come out as an all-zero chart instead of an error.
  const mortgagedCount = db.prepare(`SELECT COUNT(*) AS n FROM properties WHERE mortgage_balance IS NOT NULL AND mortgage_balance > 0 AND EXISTS (SELECT 1 FROM rate_segments WHERE rate_segments.property_id = properties.id)`).get().n;
  const holdingCount = db.prepare('SELECT COUNT(*) AS n FROM invest_holdings').get().n;
  const baselineKind = p.category === 'investment' ? 'pool' : p.category === 'property' ? 'property' : 'other';
  const prompt = aiReportPrompt({ strategies, mortgagedCount, holdingCount, text, baselineKind, history });
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.charts)) return res.status(502).json({ error: 'the AI response did not contain a report definition' });
  const errs = planAiValidateChartSpecs(parsed.charts, p.id);
  if (errs.length) return res.status(502).json({ error: errs.join('; ') });
  // Series/template compatibility: a series its template cannot
  // render used to come out as an all-zero chart (2026-11-03 bug).
  // Same 502 path as the spec check; no retry loop.
  const seriesErrs = validateAiReportChartSeries(parsed.charts);
  if (seriesErrs.length) return res.status(502).json({ error: seriesErrs.join('; ') });
  // Baseline-kind rule (AI endpoint only): a mortgage-family chart
  // on a cash-pool baseline is rejected, same 502 style.
  const kindErrs = validateAiReportBaselineKind(parsed.charts, baselineKind);
  if (kindErrs.length) return res.status(502).json({ error: kindErrs.join('; ') });
  // AI-generated reports carry their own calculation method per chart
  // (the engine path gets its how-calculated lines from the app).
  const methodErrs = validateAiChartMethods(parsed.charts);
  if (methodErrs.length) return res.status(502).json({ error: methodErrs.join('; ') });
  // The AI engine: a calculation definition the app executes. A
  // missing key means the preset engine already covers every figure
  // (validateAiEngine treats null as valid, and the viewer treats a
  // missing engine as {}) — the model routinely omits the key when
  // it has no custom calculation, so normalize it to {} here rather
  // than rejecting an otherwise complete definition (user bug
  // 2026-11-05: "total interest difference" 502'd on a missing
  // engine). A present-but-unusable engine is still rejected below.
  if (parsed.engine == null) parsed.engine = {};
  const engineErrs = validateAiEngine(parsed.engine);
  if (engineErrs.length) return res.status(502).json({ error: engineErrs.join('; ') });
  res.json({ definition: parsed, configured: true });
});

// AI report refine (item 3, AI path): the AI rewrites the report's
// definition (charts + engine) from a follow-up. Preview-only: the
// response carries the COMPLETE revised definition + an old→new
// diff; nothing is written — the client Applies via PUT
// /api/planning/reports/:id with the revised definition.
app.post('/api/planning/reports/:id/ai-refine', requireApiAuth, async (req, res) => {
  const r = db.prepare('SELECT * FROM plan_reports WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'report not found' });
  const p = planProjectById(r.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  // Thread history, same bounded handling as ai-report: the merged
  // report-AI conversation sends the turns so far so the model can
  // tell an add from a change and not re-propose existing charts.
  const history = Array.isArray(req.body?.history)
    ? req.body.history.filter((l) => typeof l === 'string').map((l) => l.slice(0, 500)).slice(0, 20)
    : [];
  let current = {};
  try { current = JSON.parse(r.definition || '{}'); } catch { current = {}; }
  const strategies = db.prepare('SELECT id, name, letter FROM plan_strategies WHERE project_id = ? ORDER BY id').all(p.id);
  const mortgagedCount = db.prepare(`SELECT COUNT(*) AS n FROM properties WHERE mortgage_balance IS NOT NULL AND mortgage_balance > 0 AND EXISTS (SELECT 1 FROM rate_segments WHERE rate_segments.property_id = properties.id)`).get().n;
  const holdingCount = db.prepare('SELECT COUNT(*) AS n FROM invest_holdings').get().n;
  const baselineKind = p.category === 'investment' ? 'pool' : p.category === 'property' ? 'property' : 'other';
  const prompt = aiReportRefinePrompt({ strategies, mortgagedCount, holdingCount, baselineKind, definition: current, text, history });
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.charts)) return res.status(502).json({ error: 'the AI response did not contain a report definition' });
  const errs = planAiValidateChartSpecs(parsed.charts, p.id);
  if (errs.length) return res.status(502).json({ error: errs.join('; ') });
  const seriesErrs = validateAiReportChartSeries(parsed.charts);
  if (seriesErrs.length) return res.status(502).json({ error: seriesErrs.join('; ') });
  const kindErrs = validateAiReportBaselineKind(parsed.charts, baselineKind);
  if (kindErrs.length) return res.status(502).json({ error: kindErrs.join('; ') });
  const methodErrs = validateAiChartMethods(parsed.charts);
  if (methodErrs.length) return res.status(502).json({ error: methodErrs.join('; ') });
  // Same normalization as ai-report: a missing engine key means the
  // preset engine covers every figure (user bug 2026-11-05); a
  // present-but-unusable engine is still rejected below.
  if (parsed.engine == null) parsed.engine = {};
  const engineErrs = validateAiEngine(parsed.engine);
  if (engineErrs.length) return res.status(502).json({ error: engineErrs.join('; ') });
  res.json({ definition: parsed, diff: aiReportDefinitionDiff(current, parsed), configured: true });
});

// AI name suggestion: a NAME only, never auto-saved — the client
// fills the Name field as an editable draft. Unconfigured LLM =
// the existing 503 guidance, field untouched client-side.
app.post('/api/planning/ai-suggest-name', requireApiAuth, async (req, res) => {
  if (!llmConfigured()) return res.status(503).json({ error: PLAN_AI_NO_LLM });
  const b = req.body || {};
  const kind = b.kind === 'strategy' ? 'strategy' : b.kind === 'scenario' ? 'scenario' : null;
  if (!kind) return res.status(400).json({ error: 'kind must be scenario or strategy' });
  const context = b.context && typeof b.context === 'object' && !Array.isArray(b.context) ? b.context : {};
  const prompt = aiSuggestNamePrompt(kind, context);
  let raw;
  try {
    raw = await callLlm([{ role: 'user', content: prompt }], process.env, getAiFillModel());
  } catch (e) {
    return res.status(502).json({ error: `AI call failed: ${e.message}` });
  }
  const parsed = parseModelJson(raw);
  const name = cleanAiSuggestedName(parsed != null ? parsed : raw);
  if (!name) return res.status(502).json({ error: 'AI did not return a name' });
  res.json({ name });
});

app.post('/api/planning/projects/:id/reports', requireApiAuth, (req, res) => {
  const p = planProjectById(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'report name is required' });
  const def = b.definition || {};
  const errs = planAiValidateChartSpecs(def.charts || [], p.id);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const defSeriesErrs = validateAiReportChartSeries(def.charts || []);
  if (defSeriesErrs.length) return res.status(400).json({ error: defSeriesErrs.join('; ') });
  // Report variables + AI engine travel inside the definition and
  // are validated here the same way the PUT path validates them.
  const defVarErrs = validateReportVariables(def.variables);
  if (defVarErrs.length) return res.status(400).json({ error: defVarErrs.join('; ') });
  const defEngErrs = validateAiEngine(def.engine);
  if (defEngErrs.length) return res.status(400).json({ error: defEngErrs.join('; ') });
  const strategyIds = db.prepare('SELECT id FROM plan_strategies WHERE project_id = ?').all(p.id).map((r) => r.id);
  for (const sid of def.strategies || []) {
    if (!strategyIds.includes(Number(sid))) return res.status(400).json({ error: `strategy ${sid} is not in this project` });
  }
  // Baseline picker (one) + strategy picker (many): the report is
  // built against exactly this baseline and these strategies.
  let baselineId = null;
  if (b.baseline_id !== undefined && b.baseline_id !== null && b.baseline_id !== '') {
    const brow = db.prepare('SELECT id FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(b.baseline_id), p.id);
    if (!brow) return res.status(400).json({ error: 'baseline is not in this project' });
    baselineId = brow.id;
  }
  let pickedStrategies = def.strategies || [];
  if (b.strategy_ids !== undefined && b.strategy_ids !== null) {
    if (!Array.isArray(b.strategy_ids)) return res.status(400).json({ error: 'strategy_ids must be an array' });
    for (const sid of b.strategy_ids) {
      if (!strategyIds.includes(Number(sid))) return res.status(400).json({ error: `strategy ${sid} is not in this project` });
    }
    pickedStrategies = b.strategy_ids.map(Number);
    def.strategies = pickedStrategies;
  }
  // Scenario pinning: a report renders under PINNED scenarios only.
  // Absent on a project with scenarios = 400 (pin prompt client-side);
  // absent on a scenario-less project = the flat world, stored as [].
  const projectScenarioIds = db.prepare('SELECT id FROM plan_scenarios WHERE project_id = ?').all(p.id).map((r) => r.id);
  const pinnedScenarios = b.scenario_ids === undefined || b.scenario_ids === null ? [] : b.scenario_ids;
  const scenErr = validateReportScenarioIds(pinnedScenarios, projectScenarioIds);
  if (scenErr) return res.status(400).json({ error: scenErr });
  const now = nowIso();
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Added report ${String(b.name).trim()} · ${p.name}`,
  }, () => {
    const info = db.prepare('INSERT INTO plan_reports (project_id, name, definition, stale, baseline_id, baseline_cleared, strategy_ids, scenario_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, String(b.name).trim(), JSON.stringify(def), 0, baselineId, 0, JSON.stringify(pickedStrategies), JSON.stringify(pinnedScenarios), now, now);
    return { value: { report: db.prepare('SELECT * FROM plan_reports WHERE id = ?').get(info.lastInsertRowid) }, entityId: p.id };
  });
  res.status(201).json(out);
});
app.put('/api/planning/reports/:id', requireApiAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM plan_reports WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'report not found' });
  const p = planProjectById(r.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const b = req.body || {};
  let baselineId = r.baseline_id;
  let cleared = r.baseline_cleared;
  if (b.baseline_id !== undefined) {
    if (b.baseline_id === null || b.baseline_id === '') { baselineId = null; }
    else {
      const brow = db.prepare('SELECT id FROM plan_baselines WHERE id = ? AND project_id = ?').get(Number(b.baseline_id), p.id);
      if (!brow) return res.status(400).json({ error: 'baseline is not in this project' });
      baselineId = brow.id; cleared = 0;
    }
  }
  let strategyIds = r.strategy_ids ? JSON.parse(r.strategy_ids) : null;
  if (b.strategy_ids !== undefined && b.strategy_ids !== null) {
    if (!Array.isArray(b.strategy_ids)) return res.status(400).json({ error: 'strategy_ids must be an array' });
    const all = db.prepare('SELECT id FROM plan_strategies WHERE project_id = ?').all(p.id).map((x) => x.id);
    for (const sid of b.strategy_ids) {
      if (!all.includes(Number(sid))) return res.status(400).json({ error: `strategy ${sid} is not in this project` });
    }
    strategyIds = b.strategy_ids.map(Number);
  }
  let scenarioIds = r.scenario_ids ? JSON.parse(r.scenario_ids) : null;
  if (b.scenario_ids !== undefined && b.scenario_ids !== null) {
    const projectScenarioIds = db.prepare('SELECT id FROM plan_scenarios WHERE project_id = ?').all(p.id).map((x) => x.id);
    const scenErr = validateReportScenarioIds(b.scenario_ids, projectScenarioIds);
    if (scenErr) return res.status(400).json({ error: scenErr });
    scenarioIds = b.scenario_ids.map(Number);
  }
  // Definition edit (block delete / AI append): structural validation
  // only; absent means keep the stored definition (COALESCE below).
  let definition = null;
  if (b.definition !== undefined && b.definition !== null) {
    const defErrs = validateReportDefinition(b.definition);
    if (defErrs.length) return res.status(400).json({ error: defErrs.join('; ') });
    definition = b.definition;
  }
  const out = commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Updated report · ${p.name}`,
  }, () => {
    db.prepare('UPDATE plan_reports SET baseline_id = ?, baseline_cleared = ?, strategy_ids = ?, scenario_ids = ?, definition = COALESCE(?, definition), updated_at = ? WHERE id = ?')
      .run(baselineId, cleared, strategyIds ? JSON.stringify(strategyIds) : null, scenarioIds ? JSON.stringify(scenarioIds) : null, definition ? JSON.stringify(definition) : null, nowIso(), r.id);
    return { value: { report: db.prepare('SELECT * FROM plan_reports WHERE id = ?').get(r.id) }, entityId: p.id };
  });
  res.json(out);
});

app.delete('/api/planning/reports/:id', requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM plan_reports WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'report not found' });
  const p = planProjectById(row.project_id, req.user.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  commitTx(req, 'project', {
    module: 'planning', entityType: 'project', entityId: p.id, projectId: p.id,
    entityLabel: p.name, summary: `Deleted report · ${p.name}`,
  }, () => {
    db.prepare('DELETE FROM plan_reports WHERE id = ?').run(row.id);
    return { value: { ok: true }, entityId: p.id };
  });
  res.json({ ok: true });
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
  // No server-side sync loop: sync runs in the browser (see the
  // browser sync log section above). The retired loop's settings stay
  // in app_meta untouched.
}
