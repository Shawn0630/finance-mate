// HouseSigma assessed-value HISTORY provider (https://housesigma.com).
//
// BC Assessment's public data only carries the current roll; the
// prior years of a property's assessed values are served by
// HouseSigma's property pages (their "Assessment History" table,
// sourced from the same public records — verified Oct 2026 against a
// Coquitlam property whose 2022/2023 values cross-match REW and
// whose 2026 value matches BC Assessment exactly).
//
// How it works (reverse-engineered from HouseSigma's own web app,
// Oct 2026 — the same "read the token from the site each time"
// pattern as bca.js's gistoken; nothing is hardcoded):
//   1. GET /                       -> the SPA shell names its JS
//      bundle (/assets/index.<hash>.js). The bundle embeds the RSA
//      public key (PEM) used to wrap request counters, and the
//      HS-Client-Version string. Both are read from the bundle on
//      every new session, so a site rebuild is picked up for free.
//   2. POST /bkv2/api/init/accesstoken/new  (body {})
//                                   -> a guest access token plus a
//      per-session secret { secret_key, is_encrypted, expired_at }.
//      This is exactly how every anonymous visitor's browser gets
//      its token; no account or credential is involved. The token
//      and secret are used for this pull only (cached in memory for
//      the session's lifetime) and are never stored or logged.
//   3. POST /bkv2/api/search/address_v2/suggest { lang, province,
//      search_term }               -> house_list with id_listing and
//      id_listing_history_v2 (the id_address). Address text itself is
//      masked for anonymous callers, but the seo_address slug is
//      present and is what we match on.
//   4. POST /bkv2/api/listing/info/detail_v2 { id_address,
//      id_listing, event_source }  -> the property detail, whose
//      top-level `assessment.history` is [{ year, total_int,
//      land_int, building_int }]. This endpoint REQUIRES the
//      encrypted request form the web app uses (a plain request is
//      rejected with error code 940, SECRET_KEY_INVALID):
//        payload  = JSON { ...params, hs_request_timestamp }
//        key      = secret_key padded with '*' to 16 bytes (AES-128)
//        counter  = 16 random bytes
//        body     = { ctr: base64(RSA-OAEP-SHA1(counter, site PEM)),
//                     et_payload: base64(AES-128-CTR(payload)) }
//        header   = Hs-Request-Timestamp
//      The response's `data` is a base64 string: AES-128-CTR-decrypt
//      with the same key + counter, then gunzip, then JSON.
//
// There is no official API, so this can break when the site changes.
// Every failure throws an Error whose message names the stage that
// failed; callers surface it and any values already stored stay put.
//
// HOUSESIGMA_BASE_URL is a test seam (the e2e suite points it at a
// local stub), mirroring BCA_BASE_URL; production uses the real site.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const BASE = process.env.HOUSESIGMA_BASE_URL || 'https://housesigma.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = `${BASE}/bkv2/api`;

function stageError(stage, detail) {
  const e = new Error(`HouseSigma lookup failed at stage "${stage}": ${detail}`);
  e.stage = stage;
  e.detail = detail;
  return e;
}

async function fetchText(url, opts = {}, timeoutMs = 15000) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      ...opts,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e.message && e.message.startsWith('HTTP ')) throw e;
    throw new Error(e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : e.message);
  }
}

// ------------------------------------------------------------- session ---
// A session is { pem, clientVersion, accessToken, secretKey }. It is
// fetched lazily, shared while calls succeed, and dropped when the
// API rejects the token (920) or the secret (940) so the next call
// rebuilds it from the site's current bundle.
let session = null;
let sessionInflight = null;

async function buildSession() {
  let home;
  try {
    home = await fetchText(`${BASE}/`);
  } catch (e) {
    throw stageError('session', `could not load the HouseSigma home page (${e.message})`);
  }
  const bundlePath = (home.match(/\/assets\/index\.[a-z0-9]+\.js/i) || [])[0];
  if (!bundlePath) throw stageError('session', 'the site no longer names its JS bundle the expected way');
  let bundle;
  try {
    bundle = await fetchText(`${BASE}${bundlePath}`);
  } catch (e) {
    throw stageError('session', `could not load the site JS bundle (${e.message})`);
  }
  const pemMatch = bundle.match(/-----BEGIN PUBLIC KEY-----[^-]+-----END PUBLIC KEY-----/);
  if (!pemMatch) throw stageError('session', 'the request-encryption public key was not found in the site JS bundle');
  const pemBody = pemMatch[0]
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const pem = `-----BEGIN PUBLIC KEY-----\n${(pemBody.match(/.{1,64}/g) || []).join('\n')}\n-----END PUBLIC KEY-----`;
  const clientVersion = (bundle.match(/"HS-Client-Version":\s*"([\d.]+)"/) || [])[1] || '7.22.54';

  let data;
  try {
    const res = await fetch(`${API}/init/accesstoken/new`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json;charset=UTF-8',
        'HS-Client-Type': 'desktop_v7',
        'HS-Client-Version': clientVersion,
      },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    throw stageError('session', `could not obtain a guest access token (${e.message})`);
  }
  const accessToken = data && data.data && data.data.access_token;
  const secretKey = data && data.data && data.data.secret && data.data.secret.secret_key;
  if (!data.status || !accessToken || !secretKey) {
    throw stageError('session', 'the access-token response did not carry a token and secret in the expected shape');
  }
  return { pem, clientVersion, accessToken, secretKey };
}

async function getSession(forceNew = false) {
  if (forceNew) { session = null; sessionInflight = null; }
  if (session) return session;
  if (!sessionInflight) {
    sessionInflight = buildSession()
      .then((s) => { session = s; sessionInflight = null; return s; })
      .catch((e) => { sessionInflight = null; throw e; });
  }
  return sessionInflight;
}

function apiHeaders(s, extra = {}) {
  return {
    'User-Agent': UA,
    'Content-Type': 'application/json;charset=UTF-8',
    'HS-Client-Type': 'desktop_v7',
    'HS-Client-Version': s.clientVersion,
    Authorization: `Bearer ${s.accessToken}`,
    ...extra,
  };
}

async function apiPost(path, body, stage) {
  // One retry on a fresh session when the API rejects the token or
  // the secret (codes 920 / 940): both are per-session values, so a
  // rebuilt session is the fix — same recovery the web app performs.
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    let data;
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: apiHeaders(s),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      throw stageError(stage, e.message);
    }
    if (data && data.status) return { session: s, data: data.data };
    const code = data && data.error && data.error.code;
    if ((code === 920 || code === 940) && attempt === 0) continue;
    const msg = (data && data.error && data.error.message) || 'the API reported failure';
    throw stageError(stage, `${msg} (code ${code === undefined ? 'n/a' : code})`);
  }
  throw stageError(stage, 'the API kept rejecting the session after a refresh');
}

// -------------------------------------------------------------- locate ---
// Address -> HouseSigma slug ("2985 Christina Pl, Coquitlam, BC" ->
// "2985-christina-place"). Street-type abbreviations are expanded to
// the spelled-out forms the site's slugs use.
const STREET_EXPAND = {
  pl: 'place', st: 'street', ave: 'avenue', rd: 'road', dr: 'drive',
  cres: 'crescent', ct: 'court', blvd: 'boulevard', ln: 'lane',
  hwy: 'highway', trl: 'trail', pkwy: 'parkway',
};

export function addressSlug(address) {
  const head = String(address).split(',')[0].trim().toLowerCase();
  const noPostal = head.replace(/\b[a-z]\d[a-z][ -]?\d[a-z]\d\b/g, '').trim();
  return noPostal
    .split(/\s+/)
    .map((w) => STREET_EXPAND[w.replace(/\.$/, '')] || w.replace(/\.$/, ''))
    .join('-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
}

// Find the property on HouseSigma from its street address. Returns
// { idAddress, idListing, seoAddress }. Matching uses the seo_address
// slug because anonymous suggest results mask the address text.
export async function locateProperty(address) {
  const term = String(address).split(',')[0].trim() || String(address).trim();
  let data = null;
  let houses = [];
  // The suggest endpoint is fuzzy; if the full street part finds no
  // house, retry with just "<number> <first street word>" (the form
  // verified live: "2985 Christina").
  const words = term.split(/\s+/);
  const terms = [term];
  if (words.length > 2) terms.push(`${words[0]} ${words[1]}`);
  for (const t of terms) {
    ({ data } = await apiPost(
      '/search/address_v2/suggest',
      { lang: 'en_US', province: 'BC', search_term: t },
      'locate'
    ));
    houses = (data && data.house_list) || [];
    if (houses.length) break;
  }
  if (!houses.length) {
    throw stageError('locate', `no property on HouseSigma matches "${term}"`);
  }
  const want = addressSlug(address);
  const houseNumber = want.split('-')[0];
  let pick = houses.find((h) => h.seo_address === want);
  if (!pick && houses.length === 1 && houses[0].seo_address
    && houses[0].seo_address.split('-')[0] === houseNumber) {
    pick = houses[0];
  }
  if (!pick) {
    throw stageError('locate', `HouseSigma returned ${houses.length} propert${houses.length === 1 ? 'y' : 'ies'} for "${term}" but none matches this address`);
  }
  const idAddress = pick.id_listing_history_v2 || null;
  const idListing = pick.id_listing || null;
  if (!idAddress && !idListing) {
    throw stageError('locate', 'the matched HouseSigma property carries no listing id to fetch details with');
  }
  return { idAddress, idListing, seoAddress: pick.seo_address || null };
}

// -------------------------------------------------------------- detail ---
// The assessed-value history for a located property:
// [{ year, total, land, building }] newest first, as the site serves
// them. Values are whole dollars (the *_int fields of its payload).
export async function fetchHistory({ idAddress, idListing }) {
  const buildBody = (s) => {
    const keyBytes = Buffer.from(String(s.secretKey).padEnd(16, '*').slice(0, 16), 'utf8');
    const counter = crypto.randomBytes(16);
    const ts = String(Math.floor(Date.now() / 1000));
    const plain = JSON.stringify({
      id_address: idAddress || '', id_listing: idListing || '', event_source: '',
      hs_request_timestamp: ts,
    });
    const cipher = crypto.createCipheriv('aes-128-ctr', keyBytes, counter);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    let ctr;
    try {
      ctr = crypto.publicEncrypt(
        { key: s.pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        counter
      );
    } catch (e) {
      throw stageError('detail', `could not wrap the request counter with the site public key (${e.message})`);
    }
    return {
      headers: { 'Hs-Request-Timestamp': ts },
      body: { ctr: ctr.toString('base64'), et_payload: encrypted.toString('base64') },
      keyBytes, counter,
    };
  };

  // Same session-refresh retry as apiPost, but the encrypted body is
  // rebuilt per session (the secret differs), so the loop lives here.
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const { headers, body, keyBytes, counter } = buildBody(s);
    let data;
    try {
      const res = await fetch(`${API}/listing/info/detail_v2`, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: apiHeaders(s, headers),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      throw stageError('detail', e.message);
    }
    if (!data || !data.status) {
      const code = data && data.error && data.error.code;
      if ((code === 920 || code === 940) && attempt === 0) continue;
      const msg = (data && data.error && data.error.message) || 'the API reported failure';
      throw stageError('detail', `${msg} (code ${code === undefined ? 'n/a' : code})`);
    }
    if (typeof data.data !== 'string') {
      throw stageError('detail', 'the detail response was not in the expected encrypted form');
    }
    let detail;
    try {
      const decipher = crypto.createDecipheriv('aes-128-ctr', keyBytes, counter);
      const raw = Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]);
      detail = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    } catch (e) {
      throw stageError('decrypt', `could not decrypt the detail response (${e.message})`);
    }
    const history = detail && detail.assessment && detail.assessment.history;
    if (!Array.isArray(history)) {
      throw stageError('detail', 'the property detail carries no assessment history');
    }
    return history
      .map((h) => ({
        year: Number(h.year),
        total: h.total_int != null ? Number(h.total_int) : null,
        land: h.land_int != null ? Number(h.land_int) : null,
        building: h.building_int != null ? Number(h.building_int) : null,
      }))
      .filter((h) => Number.isInteger(h.year) && h.total !== null && isFinite(h.total));
  }
  throw stageError('detail', 'the API kept rejecting the session after a refresh');
}
