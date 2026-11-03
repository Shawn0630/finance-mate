// nollm: Second server with no LLM configuration (503 guidance) — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-nollm.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only nollm]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  // Unconfigured: a second server with no LLM env at all answers
  // 503 with the configuration guidance.
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-e2e-nollm-'));
    const port2 = H.PORT + 700;
    const server2 = H.spawn('node', ['src/server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, DATA_DIR: dir2, PORT: String(port2) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let cookie2 = '';
      for (let i = 0; i < 50 && !cookie2; i++) {
        try {
          const login = await fetch(`http://127.0.0.1:${port2}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' }),
          });
          if (login.ok) cookie2 = (login.headers.get('set-cookie') || '').split(';')[0];
        } catch { /* not up yet */ }
        if (!cookie2) await new Promise((res2) => setTimeout(res2, 200));
      }
      const resp = await fetch(`http://127.0.0.1:${port2}/api/ai/fill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
        body: JSON.stringify({ context: 'term', text: 'x' }),
      });
      const body2 = await resp.json();
      H.check('without LLM configuration the endpoint is a 503 naming the missing setup',
        resp.status === 503 && String(body2.error || '').includes('LLM_API_KEY'),
        JSON.stringify({ status: resp.status, body: body2 }));
      // Planning AI reports follow the same 503 guidance path.
      const proj2 = await fetch(`http://127.0.0.1:${port2}/api/planning/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
        body: JSON.stringify({ name: 'No LLM project' }),
      });
      const proj2Data = await proj2.json();
      const rep2 = await fetch(`http://127.0.0.1:${port2}/api/planning/projects/${proj2Data.project.id}/ai-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
        body: JSON.stringify({ text: 'Show me something' }),
      });
      const rep2Body = await rep2.json();
      H.check('without LLM configuration ai-report is a 503 naming the missing setup',
        rep2.status === 503 && String(rep2Body.error || '').includes('LLM_API_KEY'),
        JSON.stringify({ status: rep2.status, body: rep2Body }));
    } finally {
      server2.kill();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }

  // ---- Per-term payment schedule + balance anchors ----
}

runModuleMain(import.meta.url, { name: 'nollm', deps, depNames: [], run });
