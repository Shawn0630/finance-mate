// Assessed-value upkeep service — the app pulls values itself
// instead of waiting for the user to fetch or type them:
//
//   - BC Assessment (current roll): fetch-on-read, modelled on
//     prime.js. When a property detail or the portfolio is loaded, a
//     property that carries a BC Assessment id is re-fetched through
//     the by-id channel (property page + GIS — NOT the address
//     search backend) when it has never been fetched, when the
//     stored year is behind the current roll year, or when the last
//     successful fetch is over 7 days old. Attempts are gated to at
//     most one per property per day and single-flighted; a failure
//     never fails the request — the stored value is served and the
//     response carries a stale flag naming the failure.
//   - HouseSigma (prior years): BC Assessment publishes only the
//     current roll, so the history behind it is pulled from
//     HouseSigma (region assessmentHistory provider). Pulled once in
//     the background when a property is added, and again whenever
//     the user presses "Pull history". Imports upsert by year and
//     NEVER overwrite a stronger source: a manual point always wins,
//     and a BC Assessment ('auto') point beats a HouseSigma one —
//     HouseSigma fills missing years and refreshes only its own
//     points. Per-pull outcomes are kept in app_meta so the UI can
//     show what happened without a log dive.
import { db } from './db.js';
import { getRegion } from './regions/index.js';
import { vancouverToday } from './prime.js';

const READ_TIMEOUT_MS = 6000; // per request inside the BCA fetch
const READ_WAIT_MS = 5000; // a page load never waits longer than this for the refresh
const ATTEMPT_GATE_MS = 24 * 60 * 60 * 1000; // at most one auto attempt per property per day
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
function readJsonMeta(key) {
  try {
    const v = getMeta(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

function getPropertyRow(id) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
}

// The roll BC Assessment is currently publishing. New rolls land in
// early January (valued as of the previous July 1), so the roll year
// is the current Vancouver calendar year.
export function currentRollYear() {
  return Number(vancouverToday().slice(0, 4));
}

// ------------------------------------------------- BC Assessment fetch ---
// Apply a successful BC Assessment fetch (manual button and
// auto-refresh share this): fill the property's value fields, mark
// them source='auto', and record that year's history point. Same
// semantics the fetch endpoint has always had: the fetched roll's
// point replaces whatever that year held.
export function applyBcaFetchResult(propertyId, r) {
  db.prepare(
    `UPDATE properties SET assessed_value=?, assessed_year=?, land_value=?, building_value=?,
       assessed_source='auto', assessed_fetched_at=?, bca_matched_address=?, bca_extract_date=?,
       updated_at=? WHERE id=?`
  ).run(
    r.assessedValue, r.assessedYear, r.landValue, r.buildingValue,
    nowIso(), r.matchedAddress, r.extractDate, nowIso(), propertyId
  );
  if (r.assessedValue != null && r.assessedYear) {
    db.prepare(
      `INSERT INTO value_history (property_id, year, value, source, created_at, updated_at)
       VALUES (?, ?, ?, 'auto', ?, ?)
       ON CONFLICT(property_id, year) DO UPDATE SET
         value = excluded.value, source = 'auto', updated_at = excluded.updated_at`
    ).run(propertyId, r.assessedYear, r.assessedValue, nowIso(), nowIso());
  }
}

export function noteBcaAttempt(propertyId, ok, error) {
  setMeta(`bca_refresh_${propertyId}`, JSON.stringify({ at: Date.now(), ok, error: error || null }));
}

// The refresh status attached to property responses: whether the
// last auto-refresh (or manual fetch) failed, leaving the page to
// show the last known value with a stale note.
export function bcaRefreshStatus(p) {
  const st = readJsonMeta(`bca_refresh_${p.id}`);
  if (!st) return { attempted: false, stale: false, checkedAt: null, error: null };
  return {
    attempted: true,
    stale: !st.ok,
    checkedAt: new Date(st.at).toISOString(),
    error: st.ok ? null : st.error,
  };
}

export function bcaRefreshDue(p, now = Date.now()) {
  if (!p || !p.bca_id) return false;
  const st = readJsonMeta(`bca_refresh_${p.id}`);
  // At most one attempt per day per property, whatever the outcome:
  // the roll changes once a year, so this only ever gates repeats.
  if (st && now - st.at < ATTEMPT_GATE_MS) return false;
  if (!p.assessed_fetched_at) return true; // never fetched
  if (p.assessed_year != null && p.assessed_year < currentRollYear()) return true;
  if (now - Date.parse(p.assessed_fetched_at) > STALE_AFTER_MS) return true;
  return false;
}

const bcaInflight = new Map();

// Fetch-on-read gate for one property. Never throws. The refresh
// itself may outlive the wait (a hung BC Assessment must not hang
// the page): it keeps running in the background and its result
// lands for the next load.
export async function ensureFreshAssessment(p) {
  if (!bcaRefreshDue(p)) return;
  if (!bcaInflight.has(p.id)) {
    const job = (async () => {
      try {
        const region = getRegion(p.region || 'CA') || getRegion('CA');
        const direct = { id: p.bca_id, label: p.bca_matched_address || p.address };
        const r = await region.assessment.fetchAssessment(p.address, direct, { timeoutMs: READ_TIMEOUT_MS });
        applyBcaFetchResult(p.id, r);
        noteBcaAttempt(p.id, true, null);
      } catch (e) {
        console.warn(`[assessed] auto-refresh failed for property ${p.id}: ${e.message}`);
        noteBcaAttempt(p.id, false, e.message);
      } finally {
        bcaInflight.delete(p.id);
      }
    })();
    bcaInflight.set(p.id, job);
  }
  await Promise.race([
    bcaInflight.get(p.id),
    new Promise((r) => setTimeout(r, READ_WAIT_MS)),
  ]);
}

// ----------------------------------------------------- HouseSigma pull ---
// Import HouseSigma history points under the source-priority rule:
// existing manual and BC Assessment ('auto') points are kept as-is;
// HouseSigma points fill missing years and refresh HouseSigma's own.
export function importHistoryPoints(propertyId, points) {
  const existing = new Map(
    db.prepare('SELECT year, source FROM value_history WHERE property_id = ?')
      .all(propertyId).map((r) => [r.year, r.source])
  );
  const added = [];
  const updated = [];
  const skipped = [];
  const ts = nowIso();
  db.transaction(() => {
    for (const pt of points) {
      const src = existing.get(pt.year);
      if (!src) {
        db.prepare(
          `INSERT INTO value_history (property_id, year, value, source, created_at, updated_at)
           VALUES (?, ?, ?, 'housesigma', ?, ?)`
        ).run(propertyId, pt.year, pt.total, ts, ts);
        added.push(pt.year);
      } else if (src === 'housesigma') {
        db.prepare('UPDATE value_history SET value = ?, updated_at = ? WHERE property_id = ? AND year = ?')
          .run(pt.total, ts, propertyId, pt.year);
        updated.push(pt.year);
      } else {
        skipped.push({ year: pt.year, kept: src });
      }
    }
  })();
  return { added, updated, skipped };
}

function noteHsPull(propertyId, ok, message, extra = {}) {
  setMeta(`hs_pull_${propertyId}`, JSON.stringify({ at: nowIso(), ok, message, ...extra }));
}

// The last HouseSigma pull outcome for the UI: when it ran, whether
// it worked, and a one-line summary (or the failure's stage text).
export function houseSigmaPullStatus(propertyId) {
  const st = readJsonMeta(`hs_pull_${propertyId}`);
  if (!st) return { attempted: false, ok: null, at: null, message: null };
  return { attempted: true, ok: st.ok, at: st.at, message: st.message };
}

// One full pull for a property row: locate on HouseSigma if its ids
// are not stored yet (and store them for next time), fetch the
// history, import it. Returns a result object; expected failures
// (site down, property not found, payload changed) come back as
// { ok: false, stage, error } rather than throwing, and every
// outcome is recorded for the UI.
export async function runHouseSigmaPull(p) {
  try {
    const region = getRegion(p.region || 'CA') || getRegion('CA');
    const provider = region.assessmentHistory;
    if (!provider) throw Object.assign(new Error('no assessment-history provider for this region'), { stage: 'provider' });
    let idAddress = p.hs_id_address || null;
    let idListing = p.hs_id_listing || null;
    if (!idAddress && !idListing) {
      const loc = await provider.locateProperty(p.address);
      idAddress = loc.idAddress;
      idListing = loc.idListing;
      db.prepare('UPDATE properties SET hs_id_address = ?, hs_id_listing = ?, updated_at = ? WHERE id = ?')
        .run(idAddress, idListing, nowIso(), p.id);
    }
    const history = await provider.fetchHistory({ idAddress, idListing });
    if (!history.length) {
      throw Object.assign(new Error('HouseSigma returned no assessment years for this property'), { stage: 'detail' });
    }
    const result = importHistoryPoints(p.id, history);
    const years = history.map((h) => h.year).sort((a, b) => a - b);
    const message = result.added.length
      ? `Added ${result.added.length} year${result.added.length === 1 ? '' : 's'} (${result.added.join(', ')}) from HouseSigma.`
      : 'History is already up to date — no new years from HouseSigma.';
    noteHsPull(p.id, true, message, {
      added: result.added, updated: result.updated, skipped: result.skipped.length, years,
    });
    return { ok: true, provider: provider.providerName, years, ...result };
  } catch (e) {
    const stage = e.stage || 'unknown';
    noteHsPull(p.id, false, e.message, { stage });
    return { ok: false, stage, error: e.message };
  }
}

// Best-effort background pull used right after a property is added:
// never blocks the add, never throws.
export function pullHouseSigmaHistoryInBackground(propertyId) {
  const p = getPropertyRow(propertyId);
  if (!p) return;
  runHouseSigmaPull(p).catch((e) => {
    // runHouseSigmaPull already records expected failures; this is
    // only a last-resort guard against the truly unexpected.
    console.warn(`[assessed] background HouseSigma pull failed for property ${propertyId}: ${e.message}`);
    noteHsPull(propertyId, false, e.message, { stage: 'unknown' });
  });
}
