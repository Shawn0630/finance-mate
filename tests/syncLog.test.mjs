// Browser-sync log (src/syncLog.js): every browser sync event is
// recorded with direction, status, size and a note; the list reads
// newest-first and is capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'fm-synclog-'));
process.env.DATA_DIR = dir;
const { db } = await import('../src/db.js');
const { recordSyncLog, listSyncLog } = await import('../src/syncLog.js');

test('recordSyncLog stores an upload event with size and note', () => {
  const row = recordSyncLog(db, {
    direction: 'upload', status: 'ok', bytes: 12345,
    exported_at: '2026-11-08T00:00:00.000Z', detail: 'Uploaded to the sync folder.',
  });
  assert.equal(row.direction, 'upload');
  assert.equal(row.status, 'ok');
  assert.equal(row.bytes, 12345);
  assert.equal(row.exported_at, '2026-11-08T00:00:00.000Z');
  assert.equal(row.detail, 'Uploaded to the sync folder.');
  assert.equal(typeof row.id, 'number');
  assert.equal(typeof row.created_at, 'string');
});

test('listSyncLog reads newest-first', () => {
  recordSyncLog(db, { direction: 'download', status: 'ok', bytes: 99, detail: 'first' });
  recordSyncLog(db, { direction: 'upload', status: 'error', detail: 'second' });
  const rows = listSyncLog(db);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].detail, 'second');
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[1].detail, 'first');
  assert.equal(rows[1].direction, 'download');
  assert.equal(rows[1].bytes, 99);
  assert.equal(rows[2].detail, 'Uploaded to the sync folder.');
});

test('listSyncLog caps at the requested limit', () => {
  for (let i = 0; i < 5; i++) recordSyncLog(db, { direction: 'upload', status: 'skipped', detail: `skip ${i}` });
  const rows = listSyncLog(db, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].detail, 'skip 4');
});

test('recordSyncLog rejects bad directions, statuses and sizes', () => {
  assert.throws(() => recordSyncLog(db, { direction: 'sideways', status: 'ok' }), /bad sync direction/);
  assert.throws(() => recordSyncLog(db, { direction: 'upload', status: 'maybe' }), /bad sync status/);
  assert.throws(() => recordSyncLog(db, { direction: 'upload', status: 'ok', bytes: -1 }), /non-negative integer/);
  assert.throws(() => recordSyncLog(db, { direction: 'upload', status: 'ok', bytes: 1.5 }), /non-negative integer/);
});

test('recordSyncLog truncates an over-long detail instead of failing', () => {
  const row = recordSyncLog(db, { direction: 'download', status: 'error', detail: 'x'.repeat(600) });
  assert.equal(row.detail.length, 500);
});
