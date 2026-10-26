// Prime-rate tracking service — fetch-on-read.
//
// Values come from the region implementation's prime source
// (Canada: Bank of Canada Valet series V80691311 — see
// src/regions/ca.js) and are stored in prime_rates. Policy:
//   - A projection / property view first calls ensureFreshPrime().
//     The stored value counts as fresh when it was successfully
//     fetched today (America/Vancouver calendar day) — the series
//     itself is weekly, so the observation date shown as the as-of
//     is the newest observation's date, kept in prime_rates.
//   - If not fresh, one fetch happens inline (single-flight, ~4s
//     timeout) and the new values are stored before computing.
//   - A failed fetch never fails the request: the last known value
//     is used (its as-of date stays visible in the UI), and failed
//     attempts back off briefly so a down source does not tax every
//     request.
// There is no boot pre-warm and no timer: reads keep prime fresh.
import { db } from './db.js';
import { getRegion } from './regions/index.js';

const READ_TIMEOUT_MS = 4000;
const FAIL_BACKOFF_MS = 15 * 60 * 1000;

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

const vancouverDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function vancouverToday(now = new Date()) {
  return vancouverDayFmt.format(now); // 'YYYY-MM-DD'
}

export function getCurrentPrime() {
  const row = db.prepare('SELECT date, rate FROM prime_rates ORDER BY date DESC LIMIT 1').get();
  return row || null;
}

// The full stored prime history, oldest first: [{ date, rate }].
// Projections price prime-spread segments month by month against
// this (the engine's primeHistory), so it must span the whole
// period a projection can reach back to — fetches pull the series
// from 2023 (see regions/ca.js), and ensureFreshPrime() backfills
// once on databases that only ever fetched the recent window.
export function getPrimeHistory() {
  return db.prepare('SELECT date, rate FROM prime_rates ORDER BY date ASC').all();
}

// Recent change points, newest first: each entry is the first date
// a rate was observed at that level. The first entry is the current
// rate; older entries are what it changed from.
export function getRecentPrimeChanges(limit = 5) {
  const rows = db.prepare('SELECT date, rate FROM prime_rates ORDER BY date ASC').all();
  const events = rows.filter((r, i) => i === 0 || r.rate !== rows[i - 1].rate);
  return events.slice(-limit).reverse();
}

function fetchedToday() {
  const last = Number(getMeta('prime_last_success') || 0);
  return last > 0 && vancouverToday(new Date(last)) === vancouverToday();
}

let inflight = null;
function fetchAndStore(timeoutMs) {
  if (inflight) return inflight;
  inflight = (async () => {
    setMeta('prime_last_attempt', String(Date.now()));
    try {
      const region = getRegion('CA');
      const rates = await region.fetchPrimeRates(timeoutMs);
      const ins = db.prepare(
        'INSERT INTO prime_rates (date, rate, source) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET rate = excluded.rate, source = excluded.source'
      );
      db.transaction(() => {
        for (const r of rates) ins.run(r.date, r.rate, region.primeSource.series);
      })();
      setMeta('prime_last_success', String(Date.now()));
      // A successful fetch now returns the full-range history, so
      // the stored series is complete back to 2023 from here on.
      setMeta('prime_history_backfilled', '1');
    } catch (err) {
      console.warn(`[prime] fetch failed, keeping last known value: ${err.message}`);
    } finally {
      inflight = null;
    }
    return getCurrentPrime();
  })();
  return inflight;
}

// Read-path freshness gate: resolves to the current prime after at
// most one inline fetch. Never throws. Every computation entry
// (projection, property detail, portfolio) calls this first, so a
// calculation always prices against a just-refreshed full history —
// never against a stale cache.
export async function ensureFreshPrime() {
  // One-time backfill: databases from before full-history pricing
  // hold only the recent window (their projections reached back
  // further than their stored prime). Fetch once even when today's
  // freshness already holds, so the stored series is complete; a
  // failed attempt keeps the last known values and retries under
  // the usual backoff.
  const backfilled = getMeta('prime_history_backfilled') === '1';
  if (backfilled && fetchedToday()) return getCurrentPrime();
  if (!inflight) {
    const lastAttempt = Number(getMeta('prime_last_attempt') || 0);
    // A recent failed attempt (success would have made it fresh):
    // serve the last known value instead of paying the timeout
    // again on every request.
    if (Date.now() - lastAttempt < FAIL_BACKOFF_MS) return getCurrentPrime();
  }
  return fetchAndStore(READ_TIMEOUT_MS);
}

// Manual refresh (the Rate segments panel's button): always
// fetches, sharing any in-flight fetch.
export async function refreshPrime() {
  return fetchAndStore(10000);
}

// The prime status attached to projection / property responses:
// the rate in use, the date it is current as of, and whether it was
// confirmed by a successful fetch today. fresh = false means the
// last fetch failed (or is still pending) and the rate is the last
// known one — the UI warns in that state. asOf is the Vancouver
// date of the last successful fetch (today when fresh); before any
// successful fetch it falls back to the newest observation date.
export function primeStatus() {
  const cur = getCurrentPrime();
  const lastSuccess = Number(getMeta('prime_last_success') || 0);
  const fresh = lastSuccess > 0 && vancouverToday(new Date(lastSuccess)) === vancouverToday();
  return {
    rate: cur ? cur.rate : null,
    asOf: lastSuccess > 0 ? vancouverToday(new Date(lastSuccess)) : (cur ? cur.date : null),
    fresh,
  };
}

export function primeInfo() {
  const region = getRegion('CA');
  const status = primeStatus();
  return {
    current: getCurrentPrime(),
    fresh: status.fresh,
    asOf: status.asOf,
    changes: getRecentPrimeChanges(5),
    lastFetchedAt: getMeta('prime_last_success'),
    source: region.primeSource,
  };
}
