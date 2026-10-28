// Price providers for Investments — the layer that fills
// invest_prices / invest_fx_rates, behind small interfaces the
// way src/regions/ hides region providers:
//
//   exchange holdings → TWO tiers of daily closes (no key):
//     1. Stooq CSVs. Stored symbols map to Stooq's in
//        stooqSymbolFor: a TSX symbol keeps its .TO suffix
//        ('XQQ.TO' → 'xqq.to'); a bare symbol is a US listing
//        and gains '.us' ('AAPL' → 'aapl.us'). Stooq covers
//        21k+ securities worldwide including US stocks/ETFs,
//        but individual TSX tickers are sometimes missing or
//        carry a suffix Stooq doesn't know. Stooq closes are
//        split-adjusted, which is exactly the basis the return
//        engine wants (a split must not fake a price move).
//     2. Yahoo Finance's chart API — consulted ONLY when Stooq
//        returns no rows for the symbol. Stored symbols are
//        already Yahoo-format ('XQQ.TO', 'AAPL') and Yahoo's
//        TSX coverage is complete. Yahoo 403/429s non-browser
//        user agents, so the market fetches (both tiers) send a
//        desktop Chrome UA, and the default Yahoo base tries
//        query1 then query2 — one host throttling a request
//        must not kill the fallback tier. (An explicit
//        YAHOO_BASE_URL stays single-host: it is the test seam.)
//     Both tiers empty → the holding falls back to its event
//     prices (see investments.js) and the status says so.
//   bank funds → NO automatic source in v1 (bank fund NAV
//     history has no clean public feed): manual NAV snapshots
//     the user records are the official path, event prices the
//     fallback. The provider seam stays here for a future feed.
//   USD/CAD → Bank of Canada Valet daily series FX_USDCAD, the
//     same Valet the prime rate uses (src/regions/ca.js).
//
// Fetch policy mirrors prime.js: fetch-on-read with a
// Vancouver-day freshness window, one inline fetch (single-
// flight, ~4s timeout), failures keep the last known values
// and back off — a read NEVER fails because a source is down,
// and a holding whose fetch found nothing falls back to its
// event prices with the status saying so (priceStatusFor) —
// the UI shows that rather than pretending fetched data exists.
//
// Test seams (the env pattern the other providers use):
// STOOQ_BASE_URL replaces https://stooq.com/q/d/l/,
// YAHOO_BASE_URL replaces the chart API base, and FX_API_URL
// replaces the Valet URL; the suites point all three at local
// stubs and never touch the network.

const READ_TIMEOUT_MS = 4000;
const FAIL_BACKOFF_MS = 15 * 60 * 1000;

// Sent on the market-data fetches (Stooq + Yahoo history).
// Yahoo's chart API rejects non-browser agents outright
// (403/429), which silently emptied the whole fallback tier
// when these requests identified as the app; Stooq gets the
// same header to rule out the same class of block there.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const vancouverDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const vancouverToday = (now = new Date()) => vancouverDayFmt.format(now);

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(db, key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// ------------------------------------------------------------- Stooq
export function stooqSymbolFor(symbol) {
  const s = String(symbol || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('.')) return s; // 'xqq.to', 'vfv.to', an explicit suffix stays as given
  return `${s}.us`;
}

// Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume)
// into [{ date, price }] ascending. Junk rows (bad dates,
// non-numeric or non-positive closes, the "No data" body Stooq
// returns for unknown symbols) drop out.
export function parseStooqCsv(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(',');
    if (cells.length < 5) continue;
    const date = cells[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const close = Number(cells[4]);
    if (!Number.isFinite(close) || close <= 0) continue;
    out.push({ date, price: close });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export async function fetchStooqHistory(symbol, timeoutMs = 10000) {
  const sym = stooqSymbolFor(symbol);
  if (!sym) throw new Error('no symbol to fetch');
  const base = process.env.STOOQ_BASE_URL || 'https://stooq.com/q/d/l/';
  const url = `${base}${base.includes('?') ? '&' : '?'}s=${encodeURIComponent(sym)}&i=d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`stooq fetch failed: HTTP ${res.status}`);
  const rows = parseStooqCsv(await res.text());
  if (!rows.length) throw new Error(`stooq returned no data for ${sym}`);
  return rows;
}

// ------------------------------------------------------------ Yahoo
// The fallback tier: query1.finance.yahoo.com's chart API.
// The stored symbol goes in as-is — it IS Yahoo format. The
// response pairs epoch-second timestamps with a close array
// (nulls on non-trading days); parseYahooChart zips them into
// the same [{ date, price }] shape Stooq produces, dated by
// the UTC day of each timestamp.
export function parseYahooChart(json) {
  const result = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!result || !Array.isArray(result.timestamp)) return [];
  const closes = result.indicators && result.indicators.quote && result.indicators.quote[0]
    ? result.indicators.quote[0].close : null;
  if (!Array.isArray(closes)) return [];
  const byDate = new Map();
  result.timestamp.forEach((ts, i) => {
    const close = closes[i];
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) return;
    byDate.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
  });
  return [...byDate.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function fetchYahooHistory(symbol, timeoutMs = 10000) {
  const sym = String(symbol || '').trim();
  if (!sym) throw new Error('no symbol to fetch');
  // The default base is dual-host: query1, then the same path
  // on query2 when query1 fails, errors, or parses empty — the
  // two hosts throttle independently, and this tier is the only
  // market feed for tickers Stooq doesn't carry (most of TSX).
  // An explicit YAHOO_BASE_URL (the test seam) stays as-is.
  const bases = process.env.YAHOO_BASE_URL
    ? [process.env.YAHOO_BASE_URL]
    : ['https://query1.finance.yahoo.com/v8/finance/chart/',
       'https://query2.finance.yahoo.com/v8/finance/chart/'];
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const query = `?period1=1262304000&period2=${period2}&interval=1d`;
  let lastErr = null;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}${encodeURIComponent(sym)}${query}`, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`yahoo fetch failed: HTTP ${res.status}`);
      const rows = parseYahooChart(await res.json());
      if (!rows.length) throw new Error(`yahoo returned no data for ${sym}`);
      return rows;
    } catch (err) {
      lastErr = err; // try the next host before giving up
    }
  }
  throw lastErr || new Error(`yahoo returned no data for ${sym}`);
}

// ------------------------------------------------------- Yahoo search
// The security search behind the Add Holding autocomplete
// (GET /api/invest/search). Lives on the same Yahoo host family
// as the chart API (v1/finance/search), so the base derives from
// YAHOO_BASE_URL's origin — the e2e stub serving the chart API
// serves search too; YAHOO_SEARCH_BASE_URL overrides it outright.
// Search is strictly best-effort: any failure resolves to an
// empty candidate list and the form stays fully manual.
const SEARCH_QUOTE_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
const SEARCH_CAD_EXCHANGES = new Set(['TOR', 'TSX', 'NEO', 'CNQ', 'TSXV']);
const SEARCH_USD_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NYQ', 'ASE', 'PCX', 'NASDAQ', 'NYSE', 'AMEX', 'BATS']);

// Map a v1/finance/search payload to dropdown candidates. The
// payload rarely carries a currency, so it is derived from the
// exchange — Toronto/NEO → CAD, the US venues → USD — with the
// .TO suffix as a second CAD signal; anything else keeps the
// payload's currency field when present, else null (the form
// then leaves its currency select untouched).
export function parseYahooSearch(json) {
  const quotes = json && Array.isArray(json.quotes) ? json.quotes : [];
  const out = [];
  for (const q of quotes) {
    if (!q || typeof q.symbol !== 'string' || !q.symbol.trim()) continue;
    if (q.quoteType && !SEARCH_QUOTE_TYPES.has(q.quoteType)) continue;
    const symbol = q.symbol.trim().toUpperCase();
    const label = String(q.longname || q.shortname || symbol).trim();
    const exchange = String(q.exchDisp || q.exchange || '').trim();
    let currency = typeof q.currency === 'string' && q.currency.trim()
      ? q.currency.trim().toUpperCase() : null;
    if (!currency) {
      const venue = String(q.exchange || '').trim().toUpperCase();
      if (symbol.endsWith('.TO') || SEARCH_CAD_EXCHANGES.has(venue)) currency = 'CAD';
      else if (SEARCH_USD_EXCHANGES.has(venue)) currency = 'USD';
    }
    out.push({ symbol, label, exchange, currency, quoteType: q.quoteType || null });
  }
  return out;
}

export async function searchSecurities(query, timeoutMs = 6000) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  try {
    const base = process.env.YAHOO_SEARCH_BASE_URL
      || new URL('/v1/finance/search',
        process.env.YAHOO_BASE_URL || 'https://query1.finance.yahoo.com/v8/finance/chart/').href;
    const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FinanceMate/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    return parseYahooSearch(await res.json());
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- FX
export const FX_SERIES = 'FX_USDCAD';

export async function fetchFxRates(timeoutMs = 10000) {
  const url = process.env.FX_API_URL
    || `https://www.bankofcanada.ca/valet/observations/${FX_SERIES}/json?start_date=2015-01-01`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FinanceMate/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`FX fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const rates = (data.observations || [])
    .map((o) => {
      const key = Object.keys(o).find((k) => k !== 'd');
      return { date: o.d, rate: key ? Number(o[key].v) : NaN };
    })
    .filter((o) => o.date && Number.isFinite(o.rate) && o.rate > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rates.length) throw new Error('FX fetch returned no observations');
  return rates;
}

// ------------------------------------------------------- fetch-on-read
const inflight = new Map(); // key -> promise

function fetchedToday(db, okKey) {
  const last = Number(getMeta(db, okKey) || 0);
  return last > 0 && vancouverToday(new Date(last)) === vancouverToday();
}
function backedOff(db, tryKey) {
  const last = Number(getMeta(db, tryKey) || 0);
  return last > 0 && Date.now() - last < FAIL_BACKOFF_MS;
}

// Refresh one exchange holding's market prices if stale:
// Stooq first; when Stooq has nothing for the symbol, Yahoo
// Finance; both empty → the fetch counts as failed and the
// holding keeps whatever it had (event prices included). The
// cache keeps exactly ONE market series per holding — a tier
// switch replaces the other tier's rows wholesale. Fund
// holdings and symbol-less holdings are a no-op (their prices
// are manual). Never throws.
export function ensureHoldingPrices(db, holding) {
  if (!holding || holding.kind !== 'exchange' || !holding.symbol) return Promise.resolve(false);
  const key = `px${holding.id}`;
  if (inflight.has(key)) return inflight.get(key);
  const okKey = `invest_px_${holding.id}_ok`;
  const tryKey = `invest_px_${holding.id}_try`;
  if (fetchedToday(db, okKey) || backedOff(db, tryKey)) return Promise.resolve(false);
  const p = (async () => {
    setMeta(db, tryKey, String(Date.now()));
    let rows = null;
    let source = 'stooq';
    try {
      rows = await fetchStooqHistory(holding.symbol, READ_TIMEOUT_MS);
    } catch { rows = null; } // empty or failed — fall through to Yahoo
    if (!rows) {
      try {
        rows = await fetchYahooHistory(holding.symbol, READ_TIMEOUT_MS);
        source = 'yahoo';
      } catch { rows = null; }
    }
    if (!rows) {
      console.warn(`[prices] no market data for ${holding.symbol} (stooq and yahoo both empty), keeping last known`);
      inflight.delete(key);
      return false;
    }
    try {
      const ts = new Date().toISOString();
      db.transaction(() => {
        db.prepare("DELETE FROM invest_prices WHERE holding_id = ? AND source IN ('stooq', 'yahoo')").run(holding.id);
        const ins = db.prepare(
          'INSERT OR REPLACE INTO invest_prices (holding_id, date, price, source, created_at) VALUES (?, ?, ?, ?, ?)');
        for (const r of rows) ins.run(holding.id, r.date, r.price, source, ts);
      })();
      setMeta(db, okKey, String(Date.now()));
      return true;
    } catch (err) {
      console.warn(`[prices] price cache write for ${holding.symbol} failed: ${err.message}`);
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Refresh the USD/CAD cache if stale. Never throws.
export function ensureFxRates(db) {
  const key = 'fx';
  if (inflight.has(key)) return inflight.get(key);
  if (fetchedToday(db, 'invest_fx_ok') || backedOff(db, 'invest_fx_try')) return Promise.resolve(false);
  const p = (async () => {
    setMeta(db, 'invest_fx_try', String(Date.now()));
    try {
      const rates = await fetchFxRates(READ_TIMEOUT_MS);
      const ins = db.prepare(
        'INSERT INTO invest_fx_rates (date, rate, source) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET rate = excluded.rate, source = excluded.source');
      db.transaction(() => { for (const r of rates) ins.run(r.date, r.rate, FX_SERIES); })();
      setMeta(db, 'invest_fx_ok', String(Date.now()));
      return true;
    } catch (err) {
      console.warn(`[prices] FX fetch failed, keeping last known: ${err.message}`);
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Manual refresh (the Investments "Refresh prices" button):
// forces every exchange holding + FX, sharing in-flight work.
// Resolves to the ids of the holdings that actually got a
// fresh market series (either tier).
export async function refreshAllPrices(db, holdings) {
  const jobs = [];
  for (const h of holdings || []) {
    if (h.kind === 'exchange' && h.symbol) {
      // A manual refresh ignores the freshness window: clear
      // both stamps so ensure* fetches even after a good day.
      setMeta(db, `invest_px_${h.id}_ok`, '0');
      setMeta(db, `invest_px_${h.id}_try`, '0');
      jobs.push(ensureHoldingPrices(db, h).then((ok) => (ok ? h.id : null)));
    }
  }
  setMeta(db, 'invest_fx_ok', '0');
  setMeta(db, 'invest_fx_try', '0');
  const fxJob = ensureFxRates(db);
  const refreshed = (await Promise.all(jobs)).filter((id) => id != null);
  await fxJob;
  return refreshed;
}

// How a holding is currently priced, for the UI's honesty
// labels: which source carries its latest price, whether the
// fetched series is stale (a fetch is due / failed today), and
// whether the holding has any price at all.
export function priceStatusFor(db, holding, latest) {
  const counts = db.prepare(
    'SELECT source, COUNT(*) AS n, MAX(date) AS last FROM invest_prices WHERE holding_id = ? GROUP BY source'
  ).all(holding.id);
  const by = Object.fromEntries(counts.map((c) => [c.source, c]));
  let pricedBy = 'none';
  if (latest) pricedBy = latest.source === 'manual' ? 'manual' : latest.source;
  const fetched = [by.stooq, by.yahoo].filter(Boolean);
  const lastFetchedDate = fetched.length
    ? fetched.map((f) => f.last).sort().slice(-1)[0] : null;
  const stale = holding.kind === 'exchange' && !!holding.symbol
    ? !fetchedToday(db, `invest_px_${holding.id}_ok`) && fetched.length > 0
    : false;
  return {
    pricedBy,
    stale,
    hasFetched: fetched.length > 0,
    lastFetchedDate,
    manualPoints: by.manual ? by.manual.n : 0,
  };
}

// Build the FX resolver the engine views consume, from the
// cached series. `missing` is true when a non-CAD conversion is
// needed but no rates are stored at all (fetch failed on an
// empty cache): conversions then price at the native value and
// the UI must say the CAD figures are unconverted.
export function makeFxResolver(db) {
  const points = db.prepare('SELECT date, rate FROM invest_fx_rates ORDER BY date').all();
  return {
    points,
    missing: points.length === 0,
    rate(currency, date) {
      if (currency === 'CAD') return 1;
      if (!points.length) return null;
      let best = null;
      for (const p of points) {
        if (p.date <= date && (!best || p.date > best.date)) best = p;
      }
      return best ? Number(best.rate) : Number(points[0].rate);
    },
  };
}
