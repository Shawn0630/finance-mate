// Minimal .env loader (no dependency): reads <project root>/.env
// into process.env at startup. Values already present in the
// process environment win — the runtime's injected env is
// authoritative, the file is the local fallback. The .env file is
// gitignored and must never be committed; .env.example lists the
// variables. Imported first by server.js, before any other module
// reads the environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* no .env file — the runtime env alone applies */ }
