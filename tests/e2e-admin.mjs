// admin: Data export/import, backups, iCloud sync (API + UI).
// Run standalone: node tests/e2e-admin.mjs
// Run via the suite runner: node tests/e2e-run.mjs --only admin
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
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
  r = await H.req('PUT', '/api/admin/data/sync', { enabled: true });
  H.check('admin sync settings are 403 for a non-admin user', r.status === 403, JSON.stringify(r.status));
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

  // ---- iCloud sync mechanics, with a local folder (no iCloud here) ----
  const syncFolder = path.join(H.dataDir, 'sync-test');
  r = await H.req('PUT', '/api/admin/data/sync', { enabled: true, folder: syncFolder });
  H.check('sync settings save',
    r.status === 200 && r.data.enabled === true && r.data.folder === syncFolder, JSON.stringify(r.data));
  r = await H.req('POST', '/api/properties', {
    address: '7 Sync Probe Lane, Coquitlam, BC', mortgage_balance: 1000, purchase_date: '2024-01-15',
  });
  H.check('sync probe property created', r.status === 201, JSON.stringify(r.status));
  r = await H.req('POST', '/api/admin/data/sync/now');
  H.check('sync now runs', r.status === 200 && r.data.enabled === true && !r.data.error, JSON.stringify(r.data));
  const syncFile = path.join(syncFolder, 'finance-mate-export.json');
  H.check('sync wrote the export file into the folder',
    fs.existsSync(syncFile) && JSON.parse(fs.readFileSync(syncFile, 'utf8')).format === 'finance-mate-export'
      && JSON.stringify(JSON.parse(fs.readFileSync(syncFile, 'utf8'))).includes('7 Sync Probe Lane'),
    fs.existsSync(syncFile) ? 'file present' : 'file missing');
  // Another machine writes a newer file: the next sync downloads it.
  const incoming = JSON.parse(fs.readFileSync(syncFile, 'utf8'));
  const syncProp = incoming.tables.properties.find((p) => p.address === '7 Sync Probe Lane, Coquitlam, BC');
  syncProp.address = '7 Sync Probe Lane CHANGED, Coquitlam, BC';
  incoming.exported_at = new Date(Date.now() + 3600e3).toISOString();
  incoming.checksum = crypto.createHash('sha256').update(JSON.stringify({ tables: incoming.tables, files: incoming.files })).digest('hex');
  fs.writeFileSync(syncFile, JSON.stringify(incoming));
  let downloaded = false;
  for (let i = 0; i < 12 && !downloaded; i++) {
    await H.req('POST', '/api/admin/data/sync/now');
    // A download wipes sessions — sign back in before the next read.
    await ensureAdmin();
    const props = await H.req('GET', '/api/properties');
    downloaded = Array.isArray(props.data) && props.data.some((p) => p.address === '7 Sync Probe Lane CHANGED, Coquitlam, BC');
    if (!downloaded) await new Promise((res) => setTimeout(res, 500));
  }
  H.check('sync downloads a newer file from another machine', downloaded, 'changed address never arrived');
  r = await H.req('GET', '/api/admin/data/sync');
  H.check('sync status reports the download',
    r.status === 200 && r.data.lastDirection === 'download' && !!r.data.lastAt, JSON.stringify(r.data));
  r = await H.req('POST', '/api/admin/data/sync/now');
  H.check('a second sync is a no-op (same content hash, no loop)',
    r.status === 200 && r.data.action === 'none', JSON.stringify(r.data));
  r = await H.req('PUT', '/api/admin/data/sync', { enabled: false, folder: syncFolder });
  H.check('sync can be switched off', r.status === 200 && r.data.enabled === false, JSON.stringify(r.data));

  // ---- browser: the Admin Data panel renders and Sync now works ----
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
  const cookieValue = loginRes.headers.get('set-cookie').split(';')[0].split('=')[1];
  const browser = await H.puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
  });
  try {
    const page = await browser.newPage();
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
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const until = async (fn, tries = 48) => {
      for (let i = 0; i < tries; i++) {
        try { const v = await page.evaluate(fn); if (v) return v; } catch {}
        await wait(250);
      }
      return null;
    };
    await page.goto('http://ff.local/#admin', { waitUntil: 'networkidle0', timeout: 30000 });
    H.check('admin UI: Data panel renders (Export, Import, sync form, status)',
      await until(() => document.querySelector('#adminExportBtn') && document.querySelector('#adminImportFile')
        && document.querySelector('#adminSyncForm') && document.querySelector('#adminSyncStatus')),
      'Data panel controls missing');
    H.check('admin UI: backups list renders the backup made by the import',
      await until(() => document.querySelectorAll('#adminBackupList [data-restore]').length >= 1),
      'no backup row in the list');
    // Enable sync in the UI, then Sync now updates the status line.
    await page.evaluate(() => {
      document.querySelector('#adminSyncEnabled').checked = true;
      document.querySelector('#adminSyncFolder').value = document.querySelector('#adminSyncFolder').value || '';
    });
    await page.click('#adminSyncForm button[type="submit"]');
    await until(() => document.querySelector('#adminMsg') && document.querySelector('#adminMsg').textContent.includes('Sync settings saved.'));
    H.check('admin UI: sync settings save from the form',
      await page.evaluate(() => document.querySelector('#adminMsg').textContent.includes('Sync settings saved.')),
      await page.evaluate(() => document.querySelector('#adminMsg').textContent));
    await page.click('#adminSyncNowBtn');
    H.check('admin UI: Sync now reports a result',
      await until(() => {
        const t = document.querySelector('#adminMsg') && document.querySelector('#adminMsg').textContent;
        return t && (t.includes('Already in sync.') || t.startsWith('Sync '));
      }),
      await page.evaluate(() => document.querySelector('#adminMsg').textContent));
  } finally {
    await browser.close();
  }
}

runModuleMain(import.meta.url, { name: 'admin', deps, depNames: [], run });
