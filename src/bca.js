// Best-effort BC Assessment lookup (https://www.bcassessment.ca).
//
// How it works (reverse-engineered from the public site, Oct 2026):
//   1. GET /                                  -> session cookies. The site
//      302s non-browser user agents to an error page, so a browser UA and
//      a cookie jar are required.
//   2. GET /Property/Search/GetByAddress?addr=<address>
//                                             -> JSON suggestions
//      [{ label, value, gid }]; value is the base64 property id.
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

const BASE = 'https://www.bcassessment.ca';
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
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      ...opts,
      headers: {
        'User-Agent': UA,
        Accept: opts.accept || 'text/html,application/xhtml+xml',
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
  return e;
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

export async function fetchAssessment(address) {
  const jar = newJar();

  // 1. Establish a session.
  let res;
  try {
    res = await fetchWithJar(jar, `${BASE}/`);
  } catch (e) {
    throw stageError('connect', e.message);
  }
  if (!res.ok) throw stageError('connect', `home page returned HTTP ${res.status}`);
  await res.text();

  // 2. Address autocomplete, trying normalized variants in order.
  let match = null;
  let lastError = null;
  for (const q of queryVariants(address)) {
    try {
      res = await fetchWithJar(
        jar,
        `${BASE}/Property/Search/GetByAddress?addr=${encodeURIComponent(q)}`,
        { accept: 'application/json' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found = realSuggestions(await res.json());
      if (found.length) { match = found[0]; break; }
    } catch (e) {
      lastError = e;
    }
  }
  if (!match) {
    throw stageError(
      'address search',
      lastError ? lastError.message : 'no matching property for that address (tried several address formats)'
    );
  }

  // 3. Property page -> GIS token + map service URL.
  let gistoken, mapserverUrl;
  try {
    res = await fetchWithJar(jar, `${BASE}/Property/Info/${encodeURIComponent(match.value)}`);
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
      accept: 'application/json',
      headers: { Referer: `${BASE}/Property/Info/${encodeURIComponent(match.value)}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`GIS error ${data.error.code}: ${data.error.message}`);
    if (!data.features || data.features.length === 0) throw new Error('no GIS feature for the matched address');
    attrs = data.features[0].attributes;
  } catch (e) {
    throw stageError('value query', e.message);
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
