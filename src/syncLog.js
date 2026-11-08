// Browser-sync log (2026-11-08): every browser sync event is
// recorded here so Admin → Data can show what happened, when, in
// which direction, and why it failed. Browser-side events reach the
// server through POST /api/admin/data/sync/log; a download import
// carries its log entry inside the import request itself (the import
// wipes sessions, so the browser could not post afterwards).
// The server-side sync loop is retired — this table only ever holds
// browser-sync events.
export const SYNC_LOG_DIRECTIONS = ['upload', 'download'];
export const SYNC_LOG_STATUSES = ['ok', 'error', 'skipped'];

export function recordSyncLog(db, { direction, status, bytes = null, exported_at = null, detail = null }) {
  if (!SYNC_LOG_DIRECTIONS.includes(direction)) throw new Error(`bad sync direction: ${direction}`);
  if (!SYNC_LOG_STATUSES.includes(status)) throw new Error(`bad sync status: ${status}`);
  if (bytes !== null && bytes !== undefined && (!Number.isInteger(bytes) || bytes < 0)) {
    throw new Error('sync log bytes must be a non-negative integer');
  }
  if (detail !== null && detail !== undefined && typeof detail !== 'string') {
    throw new Error('sync log detail must be text');
  }
  const row = {
    direction,
    status,
    bytes: bytes == null ? null : bytes,
    exported_at: exported_at == null ? null : String(exported_at),
    detail: detail == null ? null : String(detail).slice(0, 500),
    created_at: new Date().toISOString(),
  };
  const info = db.prepare(
    'INSERT INTO sync_log (created_at, direction, status, bytes, exported_at, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.created_at, row.direction, row.status, row.bytes, row.exported_at, row.detail);
  return { id: Number(info.lastInsertRowid), ...row };
}

export function listSyncLog(db, limit = 50) {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(n);
}
