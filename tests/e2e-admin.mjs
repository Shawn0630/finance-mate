// admin: Data export/import, backups, iCloud sync (API + UI).
// Run standalone: node tests/e2e-admin.mjs
// Run via the suite runner: node tests/e2e-run.mjs --only admin
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  const startedAt = Date.now();
  let r;
  const ensureAdmin = async () => {
    const l = await H.req('POST', '/api/login', { username: 'admin', password: 'admin' });
    if (l.status !== 200) throw new Error('re-login failed after import wiped sessions');
  };

  // ---- export shape: mainline only, no planning, no sessions, no sync keys ----
  r = await H.req('GET', '/api/admin/data/export');
  H.check('admin export returns the export format',
    r.status === 200 && r.data.format === 'finance-mate-export' && r.data.version === 1
      && typeof r.data.checksum === 'string' && typeof r.data.exported_at === 'string',
    JSON.stringify({ status: r.status, format: r.data && r.data.format }));
  const exportedKeys = r.data && r.data.tables ? Object.keys(r.data.tables) : [];
  H.check('admin export covers mainline tables, no planning tables, no sessions',
    exportedKeys.includes('users') && exportedKeys.includes('properties') && exportedKeys.includes('invest_accounts')
      && exportedKeys.includes('earn_jobs') && exportedKeys.includes('spend_cards') && exportedKeys.includes('home_insights')
      && exportedKeys.includes('app_commits')
      && !exportedKeys.some((k) => k.startsWith('plan_')) && !exportedKeys.includes('sessions'),
    exportedKeys.join(','));
  const metaKeys = (r.data.tables.app_meta || []).map((x) => x.key);
  H.check('admin export carries no sync settings in app_meta', !metaKeys.some((k) => k.startsWith('data_sync')), metaKeys.join(','));

  // ---- non-admin is refused ----
  await H.req('POST', '/api/login', { username: 'Shawn', password: 'Shawn' });
  r = await H.req('GET', '/api/admin/data/export');
  H.check('admin export is 403 for a non-admin user', r.status === 403, JSON.stringify(r.status));
  await ensureAdmin();

  // ---- planning is excluded from the export ----
  r = await H.req('POST', '/api/planning/projects', { name: 'ExportProbePlan' });
  H.check('planning probe project created', r.status === 201, JSON.stringify(r.status));
  r = await H.req('GET', '/api/admin/data/export');
  H.check('admin export contains no planning project or planning commit',
    r.status === 200 && !JSON.stringify(r.data).includes('ExportProbePlan'),
    'ExportProbePlan leaked into the export');

  // ---- import needs confirm, and refuses bad payloads ----
  r = await H.req('POST', '/api/admin/data/import', { data: r.data });
  H.check('admin import without confirm is 400', r.status === 400, JSON.stringify(r.status));
  r = await H.req('POST', '/api/admin/data/import', { data: { format: 'other' }, confirm: true });
  H.check('admin import refuses a foreign file', r.status === 400, JSON.stringify(r.status));

  // ---- import round-trip: create, export, delete, import, back ----
  r = await H.req('POST', '/api/properties', {
    address: '9 Export Probe Lane, Coquitlam, BC', mortgage_balance: 123456, purchase_date: '2024-01-15',
  });
  H.check('import probe property created', r.status === 201, JSON.stringify(r.status));
  const probeId = r.data.id;
  r = await H.req('GET', '/api/admin/data/export');
  const probeExport = r.data;
  H.check('export carries the probe property',
    probeExport.tables.properties.some((p) => p.address === '9 Export Probe Lane, Coquitlam, BC'),
    JSON.stringify(probeExport.tables.properties.map((p) => p.address)));
  r = await H.req('DELETE', `/api/properties/${probeId}`);
  H.check('probe property deleted', r.status === 200, JSON.stringify(r.status));
  r = await H.req('GET', '/api/properties');
  H.check('probe property is gone before import',
    Array.isArray(r.data) && !r.data.some((p) => p.address === '9 Export Probe Lane, Coquitlam, BC'),
    JSON.stringify((r.data || []).map((p) => p.address)));
  r = await H.req('POST', '/api/admin/data/import', { data: probeExport, confirm: true });
  H.check('admin import restores the export',
    r.status === 200 && r.data.ok === true && r.data.summary && r.data.summary.tables.properties >= 1 && typeof r.data.backup === 'string',
    JSON.stringify(r.data));
  await ensureAdmin();
  r = await H.req('GET', '/api/properties');
  H.check('probe property is back after import',
    Array.isArray(r.data) && r.data.some((p) => p.address === '9 Export Probe Lane, Coquitlam, BC'),
    JSON.stringify((r.data || []).map((p) => p.address)));

  // ---- backups: the import made one, and it restores ----
  r = await H.req('GET', '/api/admin/data/backups');
  H.check('a backup exists after the import',
    r.status === 200 && Array.isArray(r.data.backups) && r.data.backups.length >= 1,
    JSON.stringify(r.data));
  const backupName = r.data.backups[0].name;
  r = await H.req('DELETE', `/api/properties/${(await H.req('GET', '/api/properties')).data.find((p) => p.address === '9 Export Probe Lane, Coquitlam, BC').id}`);
  H.check('probe property deleted again for the restore pin', r.status === 200, JSON.stringify(r.status));
  r = await H.req('POST', `/api/admin/data/backups/${encodeURIComponent(backupName)}/restore`, { confirm: true });
  H.check('backup restore succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  await ensureAdmin();
  r = await H.req('GET', '/api/properties');
  // The backup was taken by the import, before the probe property came
  // back — so the restore returns the DB to that pre-import state:
  // the probe is gone again, the three fixture properties are back.
  H.check('backup restore returns the DB to the backed-up state',
    Array.isArray(r.data) && !r.data.some((p) => p.address === '9 Export Probe Lane, Coquitlam, BC')
      && r.data.length === 3,
    JSON.stringify((r.data || []).map((p) => p.address)));
  r = await H.req('POST', `/api/admin/data/backups/${encodeURIComponent(backupName)}/restore`, {});
  H.check('backup restore without confirm is 400', r.status === 400, JSON.stringify(r.status));

  // ---- the server-side iCloud sync is RETIRED: its endpoints are gone ----
  for (const [method, urlPath, body] of [
    ['GET', '/api/admin/data/sync', undefined],
    ['PUT', '/api/admin/data/sync', { enabled: true }],
    ['POST', '/api/admin/data/sync/now', undefined],
    ['GET', '/api/admin/data/browse', undefined],
  ]) {
    r = await H.req(method, urlPath, body);
    H.check(`retired server sync endpoint ${method} ${urlPath} is 404`, r.status === 404, JSON.stringify(r.status));
  }

  // ---- sync log API: POST stores, GET lists newest first ----
  await H.req('POST', '/api/login', { username: 'Shawn', password: 'Shawn' });
  r = await H.req('GET', '/api/admin/data/sync/log');
  H.check('sync log list is 403 for a non-admin user', r.status === 403, JSON.stringify(r.status));
  r = await H.req('POST', '/api/admin/data/sync/log', { direction: 'upload', status: 'ok', bytes: 1234 });
  H.check('sync log post is 403 for a non-admin user', r.status === 403, JSON.stringify(r.status));
  await ensureAdmin();
  r = await H.req('GET', '/api/admin/data/sync/log');
  H.check('sync log starts empty',
    r.status === 200 && Array.isArray(r.data.log) && r.data.log.length === 0, JSON.stringify(r.data));
  r = await H.req('POST', '/api/admin/data/sync/log', { direction: 'upload', status: 'ok', bytes: 1234, exported_at: '2026-11-08T12:00:00.000Z', detail: 'Uploaded to the sync folder.' });
  H.check('sync log accepts an upload event', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await H.req('POST', '/api/admin/data/sync/log', { direction: 'download', status: 'error', detail: 'Network unreachable' });
  H.check('sync log accepts a download error event', r.status === 200, JSON.stringify(r.data));
  r = await H.req('GET', '/api/admin/data/sync/log');
  H.check('sync log lists newest first',
    r.status === 200 && r.data.log.length === 2 && r.data.log[0].direction === 'download' && r.data.log[0].status === 'error'
      && r.data.log[1].direction === 'upload' && r.data.log[1].status === 'ok' && r.data.log[1].bytes === 1234,
    JSON.stringify(r.data.log));
  for (const bad of [
    { direction: 'sideways', status: 'ok' },
    { direction: 'upload', status: 'maybe' },
    { direction: 'upload', status: 'ok', bytes: -1 },
    { direction: 'upload', status: 'ok', bytes: 'big' },
    { status: 'ok' },
    { direction: 'upload' },
  ]) {
    r = await H.req('POST', '/api/admin/data/sync/log', bad);
    H.check(`sync log rejects ${JSON.stringify(bad)}`, r.status === 400, JSON.stringify(r.status));
  }
  // A plain import records no download log row.
  r = await H.req('GET', '/api/admin/data/sync/log');
  H.check('a plain import records no download log row',
    Array.isArray(r.data.log) && !r.data.log.some((e) => e.direction === 'download' && e.status === 'ok'),
    JSON.stringify(r.data.log));
  // An import carrying the sync field records a download row.
  r = await H.req('POST', '/api/admin/data/import', { data: probeExport, confirm: true, sync: { direction: 'download', bytes: 4242, exported_at: probeExport.exported_at } });
  H.check('import with the sync field succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  await ensureAdmin();
  r = await H.req('GET', '/api/admin/data/sync/log');
  H.check('import with the sync field records a download log row',
    Array.isArray(r.data.log) && r.data.log.some((e) => e.direction === 'download' && e.status === 'ok' && e.bytes === 4242 && e.exported_at === probeExport.exported_at),
    JSON.stringify(r.data.log));

  // The retired server loop must not auto-write even for an install
  // that had it enabled: seed the old setting on. The check runs at
  // the end of this module, past the old loop's 65s first pass.
  {
    const dbFile = new Database(path.join(H.dataDir, 'finance.db'));
    dbFile.pragma('busy_timeout = 5000');
    dbFile.prepare("INSERT INTO app_meta (key, value) VALUES ('data_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ enabled: true, folder: path.join(H.dataDir, 'sync') }));
    dbFile.close();
  }

  // ---- browser: the Admin Data panel renders with browser sync ----
  if (!H.chromeAvailable) {
    H.check('admin UI: skipped (no Chrome)', true, 'no chrome');
    return;
  }
  const forwardH = (rq) => new Promise((resolve, reject) => {
    const rr = http.request(
      { host: '127.0.0.1', port: H.PORT, path: rq.url, method: rq.method, headers: rq.headers },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      }
    );
    rr.on('error', reject);
    if (rq.postData) rr.write(Buffer.from(rq.postData, 'utf8'));
    rr.end();
  });
  const loginRes = await fetch(H.BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookieValue0 = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
  let cookieValue = cookieValue0;
  const browser = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      // ff.local is not a secure context, so the folder picker and
      // crypto.subtle would be absent; treat it as secure (test-only)
      // so the browser-sync engine can run on the bridged page.
      '--unsafely-treat-insecure-origin-as-secure=http://ff.local',
      ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
  });
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  // One proxied admin page: requests to ff.local are forwarded to the
  // test server with the admin session cookie. stripPicker hides the
  // File System Access API before the app loads (fallback check).
  const openPage = async ({ stripPicker = false } = {}) => {
    const page = await browser.newPage();
    if (stripPicker) {
      await page.evaluateOnNewDocument(() => {
        try { window.showDirectoryPicker = undefined; } catch {}
        try { delete window.showDirectoryPicker; } catch {}
      });
    }
    const client = await page.target().createCDPSession();
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    client.on('Fetch.requestPaused', async (e) => {
      try {
        const u = new URL(e.request.url);
        if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
        const headers = {};
        for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
        const resp = await forwardH({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
        const respHeaders = Object.entries(resp.headers)
          .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) }));
        await client.send('Fetch.fulfillRequest', {
          requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders, body: resp.body.toString('base64'),
        });
      } catch {
        try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
      }
    });
    await client.send('Network.setCookie', { name: 'ff_session', value: cookieValue, domain: 'ff.local', path: '/', httpOnly: true });
    await page.goto('http://ff.local/#admin', { waitUntil: 'networkidle0', timeout: 30000 });
    return page;
  };
  const until = async (page, fn, tries = 48) => {
    for (let i = 0; i < tries; i++) {
      try { const v = await page.evaluate(fn); if (v) return v; } catch {}
      await wait(250);
    }
    return null;
  };
  // until() runs its function in the page, so it cannot see Node
  // variables — this takes the expected value as an argument.
  const untilText = async (page, selector, text, tries = 48) => {
    for (let i = 0; i < tries; i++) {
      const v = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent : null;
      }, selector);
      if (v === text) return true;
      await wait(250);
    }
    return false;
  };
  try {
    const page = await openPage();
    H.check('admin UI: the page is a secure context with the folder picker',
      await page.evaluate(() => window.isSecureContext === true && typeof window.showDirectoryPicker === 'function'),
      await page.evaluate(() => `secure=${window.isSecureContext} picker=${typeof window.showDirectoryPicker}`));
    H.check('admin UI: Data panel renders with the browser sync panel',
      await until(page, () => document.querySelector('#adminExportBtn') && document.querySelector('#adminImportFile')
        && document.querySelector('#browserSyncPanel') && document.querySelector('#browserSyncChooseBtn')
        && document.querySelector('#browserSyncNowBtn') && document.querySelector('#browserSyncForgetBtn')
        && document.querySelector('#browserSyncStatus') && document.querySelector('#browserSyncLog')),
      'browser sync panel controls missing');
    H.check('admin UI: no folder is connected at first',
      await untilText(page, '#browserSyncStatus', 'Not connected.'),
      await page.evaluate(() => document.querySelector('#browserSyncStatus').textContent));
    H.check('admin UI: Reconnect stays hidden with no folder',
      await page.evaluate(() => document.querySelector('#browserSyncReconnectBtn').classList.contains('hidden')),
      'Reconnect visible with no folder');
    H.check('admin UI: sync log renders the API events',
      await until(page, () => document.querySelectorAll('#browserSyncLog tbody tr').length >= 3),
      await page.evaluate(() => document.querySelector('#browserSyncLog').textContent));
    // Export and Import sit in the same row at the same size.
    const dataBtns = await page.evaluate(() => {
      const ex = document.querySelector('#adminExportBtn');
      const im = document.querySelector('#adminImportFile').closest('label');
      const er = ex.getBoundingClientRect();
      const ir = im.getBoundingClientRect();
      const cs = (el) => { const s = getComputedStyle(el); return { pad: s.padding, font: s.fontSize }; };
      return { exH: er.height, imH: ir.height, ex: cs(ex), im: cs(im) };
    });
    H.check('admin UI: Export and Import buttons are the same size (height, padding, font)',
      dataBtns.exH === dataBtns.imH && dataBtns.ex.pad === dataBtns.im.pad && dataBtns.ex.font === dataBtns.im.font,
      JSON.stringify(dataBtns));
    H.check('admin UI: backups list renders the backup made by the import',
      await until(page, () => document.querySelectorAll('#adminBackupList [data-restore]').length >= 1),
      'no backup row in the list');
    // Sync now with no folder asks for one first.
    await until(page, () => {
      const b = document.querySelector('#browserSyncNowBtn');
      return b && b.getBoundingClientRect().height > 0;
    });
    await page.evaluate(() => document.querySelector('#browserSyncNowBtn').click());
    H.check('admin UI: Sync now with no folder asks to choose one',
      await until(page, () => document.querySelector('#adminMsg') && document.querySelector('#adminMsg').textContent.includes('Choose a sync folder first.')),
      await page.evaluate(() => document.querySelector('#adminMsg').textContent));
    // Floating progress bar: states, and it survives hash navigation.
    await page.evaluate(() => window.browserSync.progress.show('Test sync\u2026'));
    H.check('admin UI: progress bar shows with its label',
      await until(page, () => {
        const el = document.querySelector('#syncProgress');
        return el && !el.classList.contains('hidden') && document.querySelector('#syncProgressLabel').textContent === 'Test sync\u2026';
      }),
      'progress bar did not show');
    await page.evaluate(() => window.browserSync.progress.set(256, 512));
    H.check('admin UI: progress bar shows real byte progress',
      await until(page, () => parseFloat(document.querySelector('#syncProgressBar').style.width) === 50
        && document.querySelector('#syncProgressPct').textContent === '50%'),
      await page.evaluate(() => document.querySelector('#syncProgressBar').style.width));
    await page.evaluate(() => { location.hash = '#assets'; });
    H.check('admin UI: progress bar survives hash navigation',
      await until(page, () => {
        const el = document.querySelector('#syncProgress');
        return el && !el.classList.contains('hidden');
      }),
      'progress bar hidden after hash change');
    await page.evaluate(() => { location.hash = '#admin'; });
    await page.evaluate(() => window.browserSync.progress.done('Done.'));
    H.check('admin UI: progress bar shows done',
      await until(page, () => document.querySelector('#syncProgressLabel').textContent === 'Done.'),
      await page.evaluate(() => document.querySelector('#syncProgressLabel').textContent));
    await page.evaluate(() => window.browserSync.progress.error('Test failure.'));
    H.check('admin UI: progress bar shows its error state',
      await until(page, () => document.querySelector('#syncProgress').classList.contains('sync-progress-error')
        && document.querySelector('#syncProgressLabel').textContent === 'Test failure.'),
      'no error state');
    await until(page, () => {
      const b = document.querySelector('#syncProgressClose');
      return b && b.getBoundingClientRect().height > 0;
    });
    await page.evaluate(() => document.querySelector('#syncProgressClose').click());
    H.check('admin UI: progress bar close hides it',
      await until(page, () => document.querySelector('#syncProgress').classList.contains('hidden')),
      'progress bar still visible');
    // Drive the engine with a stubbed in-memory folder handle (the
    // real directory picker cannot be driven headlessly).
    await page.evaluate(() => {
      window.__syncStore = new Map();
      const store = window.__syncStore;
      const enc = new TextEncoder();
      const fakeHandle = {
        name: 'FinanceMate',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getFileHandle: async (name, opts) => {
          if (!store.has(name)) {
            if (!opts || !opts.create) { const e = new Error('A requested file or directory could not be found'); e.name = 'NotFoundError'; throw e; }
            store.set(name, new Uint8Array(0));
          }
          return {
            getFile: async () => {
              const bytes = store.get(name);
              return { name, size: bytes.byteLength, stream: () => new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer };
            },
            createWritable: async () => {
              const chunks = [];
              return {
                write: async (data) => { chunks.push(typeof data === 'string' ? enc.encode(data) : data); },
                close: async () => {
                  let len = 0; for (const c of chunks) len += c.byteLength;
                  const out = new Uint8Array(len); let off = 0;
                  for (const c of chunks) { out.set(new Uint8Array(c), off); off += c.byteLength; }
                  store.set(name, out);
                },
                abort: async () => {},
              };
            },
          };
        },
      };
      window.browserSync.state.handle = fakeHandle;
      window.browserSync.state.folderName = 'FinanceMate';
      window.browserSync.state.permission = 'granted';
      window.browserSync.state.connected = true;
      window.browserSync.state.dirty = true;
      window.browserSync.state.lastHash = null;
      window.browserSync.state.lastExportedAt = null;
    });
    await page.evaluate(async () => { await window.browserSync.now(); });
    const storedText = await page.evaluate(() => {
      const bytes = window.__syncStore.get('finance-mate-export.json');
      return bytes ? new TextDecoder().decode(bytes) : null;
    });
    let stored = null;
    try { stored = JSON.parse(storedText); } catch {}
    H.check('admin UI: Sync now with a stubbed folder writes the export file',
      stored && stored.format === 'finance-mate-export' && stored.version === 1
        && Array.isArray(stored.tables.properties) && stored.tables.properties.length >= 1,
      stored ? `format ${stored.format}, ${stored.tables.properties.length} properties` : 'no file in the stubbed folder');
    r = await H.req('GET', '/api/admin/data/sync/log');
    H.check('admin UI: the upload is logged',
      Array.isArray(r.data.log) && r.data.log.some((e) => e.direction === 'upload' && e.status === 'ok' && e.bytes > 0),
      JSON.stringify(r.data.log));
    // Another machine writes a newer file: the next check downloads it.
    const incoming = stored;
    const syncProp = incoming.tables.properties[0];
    const changedAddress = `${syncProp.address} CHANGED`;
    syncProp.address = changedAddress;
    incoming.exported_at = new Date(Date.now() + 3600e3).toISOString();
    incoming.checksum = crypto.createHash('sha256').update(JSON.stringify({ tables: incoming.tables, files: incoming.files })).digest('hex');
    await page.evaluate((json) => {
      window.__syncStore.set('finance-mate-export.json', new TextEncoder().encode(json));
    }, JSON.stringify(incoming));
    await page.evaluate(async () => { await window.browserSync.check({ manual: true }); });
    await ensureAdmin();
    r = await H.req('GET', '/api/properties');
    H.check('admin UI: a newer folder file is downloaded and imported',
      Array.isArray(r.data) && r.data.some((p) => p.address === changedAddress),
      JSON.stringify((r.data || []).map((p) => p.address)));
    r = await H.req('GET', '/api/admin/data/sync/log');
    H.check('admin UI: the download is logged',
      Array.isArray(r.data.log) && r.data.log.some((e) => e.direction === 'download' && e.status === 'ok'),
      JSON.stringify(r.data.log));
    await page.close();

    // A browser without the File System Access API gets the fallback
    // note and no sync panel. The download above wiped sessions, so
    // sign in again first — otherwise this page lands on login and
    // the admin view never renders.
    const loginRes2 = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    cookieValue = loginRes2.headers.get('set-cookie').split(';')[0].split('=')[1];
    const fallbackPage = await openPage({ stripPicker: true });
    H.check('admin UI: without showDirectoryPicker the fallback note shows and the panel hides',
      await until(fallbackPage, () => {
        const note = document.querySelector('#browserSyncUnsupported');
        const panel = document.querySelector('#browserSyncPanel');
        return note && !note.classList.contains('hidden') && panel && panel.classList.contains('hidden');
      }),
      'fallback note/panel state wrong');
    await fallbackPage.close();
  } finally {
    await browser.close();
  }

  // ---- retired server sync: no auto-write, even with it enabled ----
  // The old loop's first pass fired ~65s after boot; wait out the
  // remainder of 70s since this module started, then prove nothing
  // was written into the old default folder.
  const elapsed = Date.now() - startedAt;
  if (elapsed < 70000) await new Promise((res) => setTimeout(res, 70000 - elapsed));
  H.check('retired server sync never auto-writes (old setting was on)',
    !fs.existsSync(path.join(H.dataDir, 'sync', 'finance-mate-export.json')),
    fs.existsSync(path.join(H.dataDir, 'sync')) ? fs.readdirSync(path.join(H.dataDir, 'sync')).join(',') : 'no sync folder');
}

runModuleMain(import.meta.url, { name: 'admin', deps, depNames: [], run });
