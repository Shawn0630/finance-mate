// iCloud sync (2026-11-07): the app keeps its export file in a sync
// folder and syncs it automatically, so no manual export/import is
// needed — the user just signs in to iCloud. On the Mac the sync
// folder is bind-mounted to an iCloud Drive folder (see
// docker-compose.yml); this VM has no iCloud, so only the file
// write/watch/import mechanics are verifiable here.
//
// One shared file, finance-mate-export.json, both directions:
//   - out: when mainline data changes (debounced) the app rewrites
//     the file with a fresh export.
//   - in: on a poll the app reads the file; a newer exported_at with
//     a hash it has not seen means another machine wrote it, so it
//     imports it (backup first, last-write-wins).
// Loop safety is by content hash, not by timestamp: after an import
// the state records the file's hash, so the next poll skips it, and a
// re-export of identical data hashes identical, so the other machine
// skips it too. A file older than our state is skipped, never
// imported over newer data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { buildExport, validateExport, applyImport, writeBackup } from './dataExport.js';

export const SYNC_FILE = 'finance-mate-export.json';
export const SYNC_SETTINGS_KEY = 'data_sync';
export const SYNC_STATE_KEY = 'data_sync_state';
export const SYNC_DIRTY_KEY = 'data_sync_dirty';

const POLL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 60 * 1000;

export function defaultSyncFolder() {
  return path.join(DATA_DIR, 'sync');
}

function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
function metaSet(db, key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

export function getSyncSettings(db) {
  const stored = metaGet(db, SYNC_SETTINGS_KEY) || {};
  return {
    enabled: stored.enabled === true,
    folder: typeof stored.folder === 'string' && stored.folder.trim() ? stored.folder.trim() : defaultSyncFolder(),
  };
}
export function saveSyncSettings(db, { enabled, folder }) {
  const next = {
    enabled: enabled === true,
    folder: typeof folder === 'string' && folder.trim() ? folder.trim() : defaultSyncFolder(),
  };
  metaSet(db, SYNC_SETTINGS_KEY, next);
  return next;
}
export function getSyncState(db) {
  return metaGet(db, SYNC_STATE_KEY) || { lastHash: null, lastAt: null, lastDirection: null, lastExportedAt: null };
}
function saveSyncState(db, state) {
  metaSet(db, SYNC_STATE_KEY, state);
}
export function isSyncDirty(db) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(SYNC_DIRTY_KEY);
  return !!row && row.value === '1';
}
function setSyncDirty(db, on) {
  metaSet(db, SYNC_DIRTY_KEY, on ? '1' : '0');
}

function resolveFolder(folder) {
  return path.isAbsolute(folder) ? folder : path.join(DATA_DIR, folder);
}
function syncFilePath(folder) {
  return path.join(resolveFolder(folder), SYNC_FILE);
}
function fileHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// One sync pass: write out when dirty (or the file is missing), then
// check for a newer file from another machine. Never throws for a bad
// incoming file — the status carries the error and the loop continues.
export function syncPass(db, { writeIfDirty = true } = {}) {
  const settings = getSyncSettings(db);
  if (!settings.enabled) return { enabled: false, folder: settings.folder, lastAt: null, lastDirection: null, action: 'disabled' };
  const folder = resolveFolder(settings.folder);
  fs.mkdirSync(folder, { recursive: true });
  const state = getSyncState(db);
  const file = syncFilePath(settings.folder);
  let action = 'none';
  let error = null;
  try {
    // Outgoing: rewrite the file when local data changed, or when the
    // file is gone (first enable, or the user deleted it).
    if ((writeIfDirty && isSyncDirty(db)) || !fs.existsSync(file)) {
      const payload = buildExport(db, { includePlanning: false });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, file);
      const next = {
        lastHash: fileHash(fs.readFileSync(file)),
        lastAt: new Date().toISOString(),
        lastDirection: 'upload',
        lastExportedAt: payload.exported_at,
      };
      saveSyncState(db, next);
      Object.assign(state, next);
      setSyncDirty(db, false);
      action = 'uploaded';
    }
    // Incoming: a file we did not write, newer than our state.
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file);
      const hash = fileHash(raw);
      if (hash !== state.lastHash) {
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new Error('sync file is not valid JSON'); }
        validateExport(payload);
        if (!state.lastExportedAt || payload.exported_at > state.lastExportedAt) {
          const backup = writeBackup(db, { includePlanning: true });
          const summary = applyImport(db, payload);
          const next = {
            lastHash: hash,
            lastAt: new Date().toISOString(),
            lastDirection: 'download',
            lastExportedAt: payload.exported_at,
          };
          saveSyncState(db, next);
          Object.assign(state, next);
          setSyncDirty(db, false);
          action = 'downloaded';
          return { enabled: true, folder: settings.folder, lastAt: next.lastAt, lastDirection: 'download', action, backup: backup.name, summary };
        }
        // Older than our state: leave it — our next dirty write wins.
      }
    }
  } catch (e) {
    error = e.message;
    action = 'error';
  }
  return {
    enabled: true, folder: settings.folder,
    lastAt: state.lastAt, lastDirection: state.lastDirection,
    action, ...(error ? { error } : {}),
  };
}

// The loop: a poll that checks for incoming files, plus a debounced
// write after local changes. markSyncDirty arms the debounce; the
// poll never writes on its own (only a dirty flag does).
let loop = null;
export function startSyncLoop(db, { pollMs = POLL_MS, debounceMs = DEBOUNCE_MS } = {}) {
  if (loop) return loop;
  let timer = null;
  let running = false;
  const poll = () => {
    if (running) return;
    running = true;
    try { syncPass(db, { writeIfDirty: false }); } catch (e) { console.error('[sync]', e.message); } finally { running = false; }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (running) return;
      running = true;
      try { syncPass(db); } catch (e) { console.error('[sync]', e.message); } finally { running = false; }
    }, debounceMs);
    if (timer.unref) timer.unref();
  };
  const interval = setInterval(poll, pollMs);
  if (interval.unref) interval.unref();
  // A short delayed first pass on boot: picks up a file another
  // machine wrote while this one was down, and repairs a missing one.
  const boot = setTimeout(() => { schedule(); }, 5000);
  if (boot.unref) boot.unref();
  loop = { schedule, stop() { clearInterval(interval); if (timer) clearTimeout(timer); clearTimeout(boot); loop = null; } };
  return loop;
}

export function markSyncDirty(db) {
  setSyncDirty(db, true);
  if (loop) loop.schedule();
}
