// Pre-flight probe for the split e2e suite: fails FAST (~seconds) when the
// sandbox write-block is active, before the ~13-minute suite burns time.
// Steps mirror the documented block signature: a small file write, a
// SQLite write, and a headless Chromium launch with the suite's WebGL
// policy flags. Any step failing prints PROBE BLOCK and exits 2.
// Success prints PROBE OK and exits 0. This detects the CURRENT
// environment; it cannot simulate a block that is not active — a green
// probe means the environment is healthy right now, not that a block
// cannot appear mid-run (the runner's infra retry covers that case).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const started = Date.now();
const fail = (step, err) => {
  console.log(`PROBE BLOCK ${step}: ${String((err && err.message) || err)}`);
  process.exit(2);
};
const withTimeout = (p, ms, step) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${step} timed out after ${ms}ms`)), ms)),
]);

// 1. Small file write + readback.
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-probe-'));
  const file = path.join(dir, 'probe.bin');
  fs.writeFileSync(file, Buffer.alloc(8192, 7));
  if (fs.readFileSync(file).length !== 8192) throw new Error('readback length mismatch');
  fs.rmSync(dir, { recursive: true, force: true });
} catch (err) { fail('file-write', err); }

// 2. SQLite write + read.
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-probe-'));
  const db = new Database(path.join(dir, 'probe.db'));
  db.exec('CREATE TABLE t (v INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(42);
  const row = db.prepare('SELECT v FROM t').get();
  if (!row || row.v !== 42) throw new Error('SQLite readback mismatch');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
} catch (err) { fail('sqlite-write', err); }

// 3. Headless Chromium launch (same probe browser + flags as the suite).
try {
  const { createRequire } = await import('node:module');
  const reqmod = createRequire(import.meta.url);
  let puppeteer = null;
  try { puppeteer = reqmod('puppeteer-core'); } catch { puppeteer = reqmod('/tmp/pptr/node_modules/puppeteer-core'); }
  if (!puppeteer || !fs.existsSync('/opt/meta-chromium/chrome')) throw new Error('probe Chromium unavailable');
  const browser = await withTimeout(puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : [])],
  }), 15000, 'chromium-launch');
  const page = await browser.newPage();
  await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 });
  await browser.close();
} catch (err) { fail('chromium-launch', err); }

console.log(`PROBE OK (${Date.now() - started}ms)`);
