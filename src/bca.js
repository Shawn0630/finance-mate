// Best-effort BC Assessment lookup (https://www.bcassessment.ca).
//
// How it works (reverse-engineered from the public site, Oct 2026):
//   1. GET /                                  -> session cookies. The site
//      302s non-browser user agents to an error page, so a browser UA and
//      a cookie jar are required.
//   2. GET /Property/Search/GetByAddress?addr=<address>
//                                             -> JSON suggestions
//      [{ label, value, gid }]; value is the base64 property id.
//      The site's own JS sends this as an XHR (X-Requested-With:
//      XMLHttpRequest) and so do we: without that header the app
//      302-redirects failures to an HTML error page, while with it a
//      failure comes back as the site's JSON error payload
//      ({ Id, IsScheduledOutage }) with HTTP 500 — machine-readable
//      either way it goes.
//   3. GET /Property/Info/<value>             -> the property page HTML
//      embeds a short-lived `gistoken` and a dated `mapserverUrl`
//      (ArcGIS MapServer, e.g. .../DCX/AFP_20260414/MapServer). Both must
//      be read from the page each time; neither can be hardcoded.
//   4. GET {mapserverUrl}/0/query?where=ADDRESS='<label>'&token=...
//      with the session cookies and a Referer of the property page
//                                             -> attributes TOTAL_ASSESSED,
//      TOTAL_LAND, TOTAL_BUILDING, EXTRACT_DATE (YYYYMMDD).
//
// There is no official API, so this can break when the site changes. Every
// failure throws an Error whose message names the stage that failed; the
// caller reports it to the user and manual entry remains available.
//
// Note: the public property page shows a map, not a house photo, so this
// module intentionally fetches values only. Photos are user-provided
// (URL or upload).

// BCA_BASE_URL exists only as a test seam (the e2e suite points it at a
// local stub); production always uses the real site.
const BASE = process.env.BCA_BASE_URL || 'https://www.bcassessment.ca';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;

function newJar() {
  return new Map();
}

function jarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchWithJar(jar, url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      ...opts,
      headers: {
        'User-Agent': UA,
        Accept: opts.accept || 'text/html,application/xhtml+xml',
        // Ask the way the site's own jQuery calls do (see header note).
        'X-Requested-With': 'XMLHttpRequest',
        ...(jar.size ? { Cookie: jarHeader(jar) } : {}),
        ...(opts.headers || {}),
      },
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function stageError(stage, detail) {
  const e = new Error(`BC Assessment lookup failed at stage "${stage}": ${detail}`);
  e.stage = stage;
  e.detail = detail;
  return e;
}

// Read a response that is supposed to be JSON, turning every failure
// shape the site produces into a staged, human-readable error:
//   - the site's own JSON error payload ({ Id, IsScheduledOutage })
//     served with an HTTP error status when its search/GIS backends
//     throw (this is what broke the address suggestions in Oct 2026:
//     the backend 500s while the pages around it still load);
//   - any other HTTP error status;
//   - a 200 that is not JSON at all (the HTML error page the app
//     redirects browser-like requests to).
async function readJson(res, stage) {
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (data && typeof data === 'object' && 'IsScheduledOutage' in data && data.Id) {
    throw stageError(
      stage,
      `BC Assessment's service returned an error (HTTP ${res.status}, error id ${data.Id})`
    );
  }
  if (!res.ok) throw stageError(stage, `HTTP ${res.status}`);
  if (data === null) {
    throw stageError(stage, `unexpected non-JSON response (HTTP ${res.status}) — the site returned an HTML page instead of data`);
  }
  return data;
}

// The site's autocomplete is picky: a trailing "BC" or a spelled-out
// "Street" can make it return no results, while "1200 Government St,
// Victoria" matches. Try progressively normalized variants of the address
// the user typed until one produces a real suggestion.
const STREET_ABBR = [
  [/\bStreet\b/gi, 'St'], [/\bAvenue\b/gi, 'Ave'], [/\bRoad\b/gi, 'Rd'],
  [/\bDrive\b/gi, 'Dr'], [/\bBoulevard\b/gi, 'Blvd'], [/\bCrescent\b/gi, 'Cres'],
  [/\bPlace\b/gi, 'Pl'], [/\bCourt\b/gi, 'Ct'], [/\bLane\b/gi, 'Ln'],
  [/\bHighway\b/gi, 'Hwy'], [/\bTrail\b/gi, 'Trl'], [/\bParkway\b/gi, 'Pkwy'],
];

export function queryVariants(address) {
  const raw = String(address).trim();
  const noPostal = raw.replace(/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/g, '').replace(/,\s*$/, '').trim();
  const noProvince = noPostal.replace(/,?\s*\b(BC|British Columbia)\b\.?$/i, '').trim();
  const abbreviated = STREET_ABBR.reduce((s, [re, ab]) => s.replace(re, ab), noProvince);
  const streetOnly = abbreviated.split(',')[0].trim();
  const city = abbreviated.split(',')[1] ? abbreviated.split(',')[1].trim() : '';
  const variants = [raw, noProvince, abbreviated, city ? `${streetOnly} ${city}` : streetOnly, streetOnly];
  return [...new Set(variants.filter(Boolean))];
}

function realSuggestions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s) => s && s.value && s.value !== 0 && s.label && !/no results|has no results/i.test(s.label)
  );
}

async function newSession(timeoutMs) {
  const jar = newJar();
  let res;
  try {
    res = await fetchWithJar(jar, `${BASE}/`, { timeoutMs });
  } catch (e) {
    throw stageError('connect', e.message);
  }
  if (!res.ok) throw stageError('connect', `home page returned HTTP ${res.status}`);
  await res.text();
  return jar;
}

// Address suggestions for the address-input dropdown. This is the single
// suggestion source for the app: today it is BC Assessment's own address
// search (free, and a picked suggestion is exactly the address form the
// assessment fetch can match). It could later be swapped for Canada Post
// AddressComplete behind this same { id, label } shape.
// Tries the same normalized query variants as the assessment fetch and
// returns the first variant that yields results: [{ id, label }] where id
// is the site's property id (used to jump straight to the property page).
export async function suggestAddresses(query) {
  const jar = await newSession();
  for (const q of queryVariants(query)) {
    const res = await fetchWithJar(
      jar,
      `${BASE}/Property/Search/GetByAddress?addr=${encodeURIComponent(q)}`,
      { accept: 'application/json' }
    );
    const found = realSuggestions(await readJson(res, 'address suggestions'));
    if (found.length) {
      const seen = new Set();
      const out = [];
      for (const s of found) {
        const id = String(s.value);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: s.label });
        if (out.length >= 8) break;
      }
      return out;
    }
  }
  return [];
}

// opts.timeoutMs caps each request (the fetch-on-read auto-refresh
// passes a short one so a slow BC Assessment cannot stall page
// loads; the manual Fetch button keeps the generous default).
export async function fetchAssessment(address, direct, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const jar = await newSession(timeoutMs);

  // 2. Address autocomplete, trying normalized variants in order. Skipped
  // when the caller already picked a suggestion (direct.id + direct.label):
  // then we go straight to that property page.
  let match = direct && direct.id ? { value: String(direct.id), label: direct.label || null } : null;
  let lastError = null;
  if (!match || !match.label) {
    match = null;
    for (const q of queryVariants(address)) {
      try {
        const res = await fetchWithJar(
          jar,
          `${BASE}/Property/Search/GetByAddress?addr=${encodeURIComponent(q)}`,
          { accept: 'application/json', timeoutMs }
        );
        const found = realSuggestions(await readJson(res, 'address search'));
        if (found.length) { match = found[0]; break; }
      } catch (e) {
        lastError = e;
      }
    }
  }
  if (!match) {
    throw stageError(
      'address search',
      lastError ? (lastError.detail || lastError.message) : 'no matching property for that address (tried several address formats)'
    );
  }
  let res;

  // 3. Property page -> GIS token + map service URL.
  let gistoken, mapserverUrl;
  try {
    res = await fetchWithJar(jar, `${BASE}/Property/Info/${encodeURIComponent(match.value)}`, { timeoutMs });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    gistoken = (html.match(/gistoken\s*=\s*'([^']+)'/) || [])[1];
    mapserverUrl = (html.match(/mapserverUrl\s*=\s*'([^']+)'/) || [])[1];
    if (!gistoken || !mapserverUrl) throw new Error('token / map service not found in page');
  } catch (e) {
    throw stageError('property page', e.message);
  }

  // 4. ArcGIS query for the assessed values.
  const where = `ADDRESS = '${String(match.label).replace(/'/g, "''")}'`;
  const query = new URLSearchParams({
    where,
    outFields: 'ADDRESS,TOTAL_ASSESSED,TOTAL_LAND,TOTAL_BUILDING,EXTRACT_DATE,JUR,ROLL',
    returnGeometry: 'false',
    f: 'json',
    token: gistoken,
  });
  let attrs;
  try {
    res = await fetchWithJar(jar, `${mapserverUrl}/0/query?${query}`, {
      timeoutMs,
      accept: 'application/json',
      headers: { Referer: `${BASE}/Property/Info/${encodeURIComponent(match.value)}` },
    });
    const data = await readJson(res, 'value query');
    if (data.error) throw new Error(`GIS error ${data.error.code}: ${data.error.message}`);
    if (!data.features || data.features.length === 0) throw new Error('no GIS feature for the matched address');
    attrs = data.features[0].attributes;
  } catch (e) {
    throw stageError('value query', e.detail || e.message);
  }

  const extract = String(attrs.EXTRACT_DATE || '');
  const assessedYear = /^\d{8}$/.test(extract) ? Number(extract.slice(0, 4)) : null;
  return {
    matchedAddress: attrs.ADDRESS || match.label,
    assessedValue: attrs.TOTAL_ASSESSED ?? null,
    landValue: attrs.TOTAL_LAND ?? null,
    buildingValue: attrs.TOTAL_BUILDING ?? null,
    extractDate: extract || null,
    assessedYear,
    jurisdiction: attrs.JUR || null,
    roll: attrs.ROLL || null,
  };
}
