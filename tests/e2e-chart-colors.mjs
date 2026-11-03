// chart-colors: Chart colors: per-user preferences, API + browser — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-chart-colors.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only chart-colors]
import http from 'node:http';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // Chart colors: per-user preferences in the DB. API level first:
  // validation, round-trip, and isolation between users.
  r = await H.req('GET', '/api/preferences');
  H.check('preferences start empty for the admin user',
    r.status === 200 && !('chart_colors' in (r.data.preferences || {})), JSON.stringify(r.data));
  r = await H.req('PUT', '/api/preferences/chart_colors', { value: { hero: { assessed: '#123456' } } });
  H.check('storing a chart color succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await H.req('GET', '/api/preferences');
  H.check('the stored color reads back',
    !!r.data.preferences && !!r.data.preferences.chart_colors
      && r.data.preferences.chart_colors.hero.assessed === '#123456',
    JSON.stringify(r.data.preferences));
  for (const bad of ['#12345', 'red', '#1234567', 42]) {
    r = await H.req('PUT', '/api/preferences/chart_colors', { value: { hero: { assessed: bad } } });
    H.check(`an invalid color is a 400 (${JSON.stringify(bad)})`, r.status === 400, JSON.stringify(r.data));
  }
  r = await H.req('PUT', '/api/preferences/chart_colors', { value: ['#123456'] });
  H.check('a non-object chart_colors value is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('PUT', '/api/preferences/bogus_key', { value: {} });
  H.check('an unknown preference key is a 400', r.status === 400, JSON.stringify(r.data));
  
  const shawnCookie = await H.loginAs('Shawn', 'Shawn');
  const prefsOf = async (ck) => (await (await fetch(H.BASE + '/api/preferences', { headers: { Cookie: ck } })).json()).preferences || {};
  H.check('another user sees none of the admin\u2019s chart colors (isolation)',
    !('chart_colors' in (await prefsOf(shawnCookie))), JSON.stringify(await prefsOf(shawnCookie)));
  await fetch(H.BASE + '/api/preferences/chart_colors', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: shawnCookie },
    body: JSON.stringify({ value: { hero: { assessed: '#abcdef' } } }),
  });
  H.check('the second user stores his own color without touching the admin\u2019s',
    (await prefsOf(shawnCookie)).chart_colors.hero.assessed === '#abcdef'
      && (await H.req('GET', '/api/preferences')).data.preferences.chart_colors.hero.assessed === '#123456');
  // Clear both users' colors: the browser flow below starts from
  // defaults on both accounts.
  await H.req('PUT', '/api/preferences/chart_colors', { value: {} });
  await fetch(H.BASE + '/api/preferences/chart_colors', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: shawnCookie },
    body: JSON.stringify({ value: {} }),
  });

  // Chart colors in the browser: the legend-opened panel stages
  // edits — they preview live but only Save stores them (an
  // unsaved close discards); a saved color survives a reload
  // (DB), Reset + Save returns to the defaults, and the second
  // user sees defaults.
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('chart colors browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    r = await H.req('POST', '/api/properties', {
      address: '31 Colors Crescent, Victoria, BC',
      mortgage_balance: 1350000, mortgage_balance_date: '2025-12-01', purchase_date: '2025-06-01', amortization_years: 30,
    });
    const colorPid = r.data.id;
    await H.req('POST', `/api/properties/${colorPid}/rates`, {
      start_date: '2025-12-01', rate_type: 'fixed', annual_rate: 5,
    });
    await H.req('POST', `/api/properties/${colorPid}/value-history`, { year: 2025, land_value: 900000, building_value: 300000 });
    await H.req('POST', `/api/properties/${colorPid}/value-history`, { year: 2024, value: 1100000 });

    const forwardC = (rq) => new Promise((resolve, reject) => {
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
    const adminCookieC = await H.loginAs('admin', 'admin');
    const browserC = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserC.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      client.on('Fetch.requestPaused', async (e) => {
        try {
          const u = new URL(e.request.url);
          if (u.hostname !== 'ff.local') { await client.send('Fetch.continueRequest', { requestId: e.requestId }); return; }
          const headers = {};
          for (const [k, v] of Object.entries(e.request.headers)) if (k.toLowerCase() !== 'host') headers[k] = v;
          const resp = await forwardC({ url: u.pathname + u.search, method: e.request.method, headers, postData: e.request.postData });
          const respHeaders = Object.entries(resp.headers)
            .filter(([k]) => !['content-length', 'transfer-encoding'].includes(k.toLowerCase()))
            .map(([name, value]) => ({ name, value: String(value) }));
          await client.send('Fetch.fulfillRequest', {
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      const setSession = async (ck) => {
        const [name, value] = ck.split('=');
        await client.send('Network.setCookie', { name, value, domain: 'ff.local', path: '/', httpOnly: true });
      };
      await setSession(adminCookieC);
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const pollEq = async (get, want, tries = 48) => {
        for (let i = 0; i < tries; i++) {
          try { if ((await get()) === want) return true; } catch {}
          await wait(250);
        }
        return false;
      };
      const heroColor = (key) => page.evaluate((k) => {
        const c = window.__fmCharts.a;
        const ds = c && c.data.datasets.find((d) => d.key === k);
        return ds ? ds.borderColor : null;
      }, key);
      const setColor = (panelId, key, hex) => page.evaluate((p, k, h) => {
        const input = document.querySelector(`[data-colors-panel="${p}"] [data-color-input="${k}"]`);
        input.value = h;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, panelId, key, hex);
      // A chart's Colors panel opens from its legend only: a
      // (synthetic) right click on the series' legend item —
      // the same contextmenu the app's canvas listener handles.
      const rightClickLegend = (chartKey, seriesKey) => page.evaluate((ck, sk) => {
        const c = window.__fmCharts[ck];
        if (!c || !c.legend) return false;
        const i = c.legend.legendItems.findIndex((it) => {
          const ds = c.data.datasets[it.datasetIndex];
          return ds && ds.key === sk;
        });
        if (i < 0) return false;
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        const ev = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: r.left + b.left + b.width / 2, clientY: r.top + b.top + b.height / 2,
        });
        c.canvas.dispatchEvent(ev);
        return ev.defaultPrevented;
      }, chartKey, seriesKey);

      await page.goto(`http://ff.local/#property/${colorPid}`, { waitUntil: 'networkidle0', timeout: 30000 });
      H.check('hero chart starts on the default assessed color',
        await pollEq(() => heroColor('assessed'), '#2e7d4f'));
      H.check('no chart header carries a Colors button anymore (the legend right click is the only way in)',
        (await page.evaluate(() => document.querySelectorAll('[data-colors-toggle]').length)) === 0);
      await rightClickLegend('a', 'assessed');
      await wait(300);
      const heroPanel = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="hero"]');
        return {
          shown: !panel.classList.contains('hidden'),
          rows: [...panel.querySelectorAll('[data-color-input]')].map((i) => i.dataset.colorInput),
          hasReset: !!panel.querySelector('[data-colors-reset]'),
          hasSave: !!panel.querySelector('[data-colors-save]'),
        };
      });
      H.check('the hero Colors panel (opened by right-clicking the legend) lists one picker per series plus Reset and Save',
        heroPanel.shown && heroPanel.hasReset && heroPanel.hasSave
          && ['assessed', 'outstanding', 'interest', 'principal'].every((k) => heroPanel.rows.includes(k)),
        JSON.stringify(heroPanel));
      await setColor('hero', 'assessed', '#123456');
      H.check('recoloring previews on the live chart at once (staged, not yet saved)',
        (await heroColor('assessed')) === '#123456', await heroColor('assessed'));
      await page.evaluate(() => document.querySelector('[data-colors-panel="hero"] [data-colors-save]').click());
      await wait(300);
      H.check('Save closes the panel',
        await page.evaluate(() => document.querySelector('[data-colors-panel="hero"]').classList.contains('hidden')));
      let stored = null;
      for (let i = 0; i < 30; i++) {
        const p = (await H.req('GET', '/api/preferences')).data.preferences;
        if (p && p.chart_colors && p.chart_colors.hero && p.chart_colors.hero.assessed === '#123456') { stored = p; break; }
        await wait(300);
      }
      H.check('the new color is stored in the user\u2019s preferences', !!stored, JSON.stringify(stored));
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      H.check('after a reload the hero chart still uses the stored color',
        await pollEq(() => heroColor('assessed'), '#123456'));

      // Discard: reopen the panel, change the color, then close
      // WITHOUT Save (Esc) — the chart falls back to the stored
      // color and a reopened panel loads that stored color, not
      // the discarded one.
      await rightClickLegend('a', 'assessed');
      await wait(300);
      await setColor('hero', 'assessed', '#ff0000');
      H.check('an unsaved change still previews live',
        (await heroColor('assessed')) === '#ff0000', await heroColor('assessed'));
      await page.keyboard.press('Escape');
      await wait(400);
      H.check('closing the panel without Save discards the change (chart back to the stored color, panel hidden)',
        (await heroColor('assessed')) === '#123456'
          && await page.evaluate(() => document.querySelector('[data-colors-panel="hero"]').classList.contains('hidden')),
        await heroColor('assessed'));
      await rightClickLegend('a', 'assessed');
      await wait(300);
      const reopenedInput = await page.evaluate(() =>
        document.querySelector('[data-colors-panel="hero"] [data-color-input="assessed"]').value);
      H.check('a reopened panel loads the stored color, not the discarded one',
        reopenedInput === '#123456', reopenedInput);

      // History chart: Land takes the custom hex (border whole,
      // fill at the series alpha); Save stores it, and it
      // survives a modal close / reopen (the chart rebuilds
      // from the preference).
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(600);
      await rightClickLegend('history', 'land');
      await wait(300);
      await setColor('history', 'land', '#654321');
      const histLand = await page.evaluate(() => {
        const c = window.__fmCharts.history;
        const ds = c && c.data.datasets.find((d) => d.key === 'land');
        return ds ? { border: ds.borderColor, bg: ds.backgroundColor } : null;
      });
      H.check('the history Land series recolors live (border #654321, fill at its alpha)',
        !!histLand && histLand.border === '#654321' && histLand.bg === 'rgba(101, 67, 33, 0.8)',
        JSON.stringify(histLand));
      await page.evaluate(() => document.querySelector('[data-colors-panel="history"] [data-colors-save]').click());
      await wait(300);
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(600);
      const histLand2 = await page.evaluate(() => {
        const c = window.__fmCharts.history;
        const ds = c && c.data.datasets.find((d) => d.key === 'land');
        return ds ? ds.borderColor : null;
      });
      H.check('reopening the history modal keeps the stored Land color', histLand2 === '#654321', String(histLand2));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);

      // Reset: staged like any edit — the live chart previews
      // the defaults at once, and only Reset + Save removes the
      // stored hero entry.
      await rightClickLegend('a', 'assessed');
      await wait(300);
      await page.evaluate(() => document.querySelector('[data-colors-panel="hero"] [data-colors-reset]').click());
      await wait(400);
      H.check('Reset stages the defaults — the live chart previews them before any save',
        (await heroColor('assessed')) === '#2e7d4f', await heroColor('assessed'));
      await page.evaluate(() => document.querySelector('[data-colors-panel="hero"] [data-colors-save]').click());
      await wait(600);
      H.check('after Reset + Save the live chart is on the default color',
        (await heroColor('assessed')) === '#2e7d4f', await heroColor('assessed'));
      const prefsAfterReset = (await H.req('GET', '/api/preferences')).data.preferences;
      H.check('Reset + Save removes the chart\u2019s stored colors',
        !!prefsAfterReset && !!prefsAfterReset.chart_colors && !('hero' in prefsAfterReset.chart_colors),
        JSON.stringify(prefsAfterReset));

      // Isolation in the browser: the second user (whose stored
      // colors were cleared above) sees the defaults even though
      // the admin has a stored history color.
      await setSession(shawnCookie);
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
      H.check('the second user sees the default hero color (per-user isolation)',
        await pollEq(() => heroColor('assessed'), '#2e7d4f'));

      // ---- Legend gestures ----
      // Left click toggles a series (Chart.js' default legend
      // behavior: the dataset hides and the item takes the hidden
      // style); right click opens that chart's Colors panel with
      // the clicked series' row highlighted and the browser
      // context menu suppressed. Visibility is view state only.
      const legendCenter = (chartKey, seriesKey) => page.evaluate((ck, sk) => {
        const c = window.__fmCharts[ck];
        if (!c || !c.legend) return null;
        const i = c.legend.legendItems.findIndex((it) => {
          const ds = c.data.datasets[it.datasetIndex];
          return ds && ds.key === sk;
        });
        if (i < 0) return null;
        // The portfolio chart sits below the fold of the list
        // page: bring the canvas into the viewport before
        // measuring, or the click lands outside it.
        c.canvas.scrollIntoView({ block: 'center' });
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 };
      }, chartKey, seriesKey);
      const legendPoint = async (chartKey, seriesKey) => {
        for (let i = 0; i < 25; i++) {
          const p = await legendCenter(chartKey, seriesKey);
          if (p) return p;
          await wait(250);
        }
        return null;
      };
      const legendState = (chartKey, seriesKey) => page.evaluate((ck, sk) => {
        const c = window.__fmCharts[ck];
        if (!c || !c.legend) return null;
        const it = c.legend.legendItems.find((x) => {
          const ds = c.data.datasets[x.datasetIndex];
          return ds && ds.key === sk;
        });
        if (!it) return null;
        return { visible: c.isDatasetVisible(it.datasetIndex), hidden: !!it.hidden };
      }, chartKey, seriesKey);
      const waitLegend = async (chartKey, seriesKey, want) => {
        for (let i = 0; i < 30; i++) {
          const s = await legendState(chartKey, seriesKey);
          if (s && s.visible === want.visible && s.hidden === want.hidden) return true;
          await wait(200);
        }
        return false;
      };
      // Hero: left-click Interest off and back on.
      const heroInterest = await legendPoint('a', 'interest');
      H.check('the hero legend exposes an Interest item to click', !!heroInterest, JSON.stringify(heroInterest));
      await page.mouse.click(heroInterest.x, heroInterest.y);
      H.check('left-clicking the Interest legend item hides the series (dataset hidden + legend item in the hidden style)',
        await waitLegend('a', 'interest', { visible: false, hidden: true }));
      const heroInterest2 = await legendPoint('a', 'interest');
      await page.mouse.click(heroInterest2.x, heroInterest2.y);
      H.check('clicking it again restores the series',
        await waitLegend('a', 'interest', { visible: true, hidden: false }));
      // Hero: right-click Principal opens the Colors panel on its row.
      const heroPrincipal = await legendPoint('a', 'principal');
      await page.mouse.click(heroPrincipal.x, heroPrincipal.y, { button: 'right' });
      await wait(400);
      const heroRc = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="hero"]');
        const input = panel.querySelector('[data-color-input="principal"]');
        const row = input ? input.closest('.cc-row') : null;
        return { shown: !panel.classList.contains('hidden'), highlighted: !!row && row.classList.contains('cc-highlight') };
      });
      H.check('right-clicking the Principal legend item opens the hero Colors panel with the Principal row highlighted',
        heroRc.shown && heroRc.highlighted, JSON.stringify(heroRc));
      const ctxPrevented = await page.evaluate(() => {
        const c = window.__fmCharts.a;
        const i = c.legend.legendItems.findIndex((it) => c.data.datasets[it.datasetIndex].key === 'assessed');
        const b = c.legend.legendHitBoxes[i];
        const r = c.canvas.getBoundingClientRect();
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + b.left + 2, clientY: r.top + b.top + 2 });
        c.canvas.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      H.check('a right click on a legend item suppresses the browser context menu', ctxPrevented === true);
      // Hero: Current equity toggles from the legend and recolors
      // from the panel like every other hero series.
      const heroEqPt = await legendPoint('a', 'equity');
      H.check('the hero legend exposes a Current equity item to click', !!heroEqPt, JSON.stringify(heroEqPt));
      await page.mouse.click(heroEqPt.x, heroEqPt.y);
      H.check('left-clicking the Current equity legend item hides the series',
        await waitLegend('a', 'equity', { visible: false, hidden: true }));
      const heroEqPt2 = await legendPoint('a', 'equity');
      await page.mouse.click(heroEqPt2.x, heroEqPt2.y);
      H.check('clicking Current equity again restores it',
        await waitLegend('a', 'equity', { visible: true, hidden: false }));
      await setColor('hero', 'equity', '#5b21b6');
      const heroEqColor = await page.evaluate(() => {
        const ds = window.__fmCharts.a.data.datasets.find((d) => d.key === 'equity');
        return ds ? ds.borderColor : null;
      });
      H.check('recoloring Current equity applies live', heroEqColor === '#5b21b6', String(heroEqColor));
      // History: left-click Land off and back on; right-click
      // Building opens its panel on the Building row.
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(700);
      const lgHistLand = await legendPoint('history', 'land');
      await page.mouse.click(lgHistLand.x, lgHistLand.y);
      H.check('left-clicking the history Land legend item hides the Land series',
        await waitLegend('history', 'land', { visible: false, hidden: true }));
      const lgHistLand2 = await legendPoint('history', 'land');
      await page.mouse.click(lgHistLand2.x, lgHistLand2.y);
      H.check('clicking Land again restores it',
        await waitLegend('history', 'land', { visible: true, hidden: false }));
      const histBuilding = await legendPoint('history', 'building');
      await page.mouse.click(histBuilding.x, histBuilding.y, { button: 'right' });
      await wait(400);
      const histRc = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="history"]');
        const input = panel.querySelector('[data-color-input="building"]');
        const row = input ? input.closest('.cc-row') : null;
        return { shown: !panel.classList.contains('hidden'), highlighted: !!row && row.classList.contains('cc-highlight') };
      });
      H.check('right-clicking the history Building item opens the history Colors panel with Building highlighted',
        histRc.shown && histRc.highlighted, JSON.stringify(histRc));
      await page.evaluate(() => document.querySelector('#historyModal [data-close-modal]').click());
      await wait(400);
      // Portfolio (properties list): left-click Outstanding off,
      // right-click Assessed opens the portfolio Colors panel.
      await page.goto('http://ff.local/#assets/properties', { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(900);
      const pfOut = await legendPoint('portfolio', 'outstanding');
      H.check('the portfolio legend exposes an Outstanding item to click', !!pfOut, JSON.stringify(pfOut));
      await page.mouse.click(pfOut.x, pfOut.y);
      H.check('left-clicking the portfolio Outstanding item hides the series',
        await waitLegend('portfolio', 'outstanding', { visible: false, hidden: true }));
      const pfAssessed = await legendPoint('portfolio', 'assessed');
      await page.mouse.click(pfAssessed.x, pfAssessed.y, { button: 'right' });
      await wait(400);
      const pfRc = await page.evaluate(() => {
        const panel = document.querySelector('[data-colors-panel="portfolio"]');
        const input = panel.querySelector('[data-color-input="assessed"]');
        const row = input ? input.closest('.cc-row') : null;
        return { shown: !panel.classList.contains('hidden'), highlighted: !!row && row.classList.contains('cc-highlight') };
      });
      H.check('right-clicking the portfolio Assessed item opens the portfolio Colors panel with Assessed highlighted',
        pfRc.shown && pfRc.highlighted, JSON.stringify(pfRc));
      // Recolor regression beside the gestures: the panel the
      // right click opened still recolors the live chart.
      await setColor('portfolio', 'assessed', '#0a5c2e');
      const pfRecolored = await page.evaluate(() => {
        const ds = window.__fmCharts.portfolio.data.datasets.find((d) => d.key === 'assessed');
        return ds ? ds.borderColor : null;
      });
      H.check('recoloring from the right-click-opened panel applies live', pfRecolored === '#0a5c2e', String(pfRecolored));
      // Total equity takes part like every other series: the
      // legend toggles it and the Colors panel recolors it.
      const pfEqPt = await legendPoint('portfolio', 'equity');
      H.check('the portfolio legend exposes a Total equity item to click', !!pfEqPt, JSON.stringify(pfEqPt));
      await page.mouse.click(pfEqPt.x, pfEqPt.y);
      H.check('left-clicking the portfolio Total equity item hides the series',
        await waitLegend('portfolio', 'equity', { visible: false, hidden: true }));
      const pfEqPt2 = await legendPoint('portfolio', 'equity');
      await page.mouse.click(pfEqPt2.x, pfEqPt2.y);
      H.check('clicking Total equity again restores it',
        await waitLegend('portfolio', 'equity', { visible: true, hidden: false }));
      await setColor('portfolio', 'equity', '#5b21b6');
      const pfEqColor = await page.evaluate(() => {
        const ds = window.__fmCharts.portfolio.data.datasets.find((d) => d.key === 'equity');
        return ds ? ds.borderColor : null;
      });
      H.check('recoloring Total equity applies live', pfEqColor === '#5b21b6', String(pfEqColor));
      await H.req('DELETE', `/api/properties/${colorPid}`);
    } catch (err) {
      H.check('chart colors browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserC.close();
    }
  }

  // ============ global loading veil ============
  // Hub loads run under a counting, delayed-show veil: a slow
  // refetch shows it and the redraw completes underneath; a fast
  // one never shows it at all; a failed one lifts it and leaves
  // the error visible in the global banner.
}

runModuleMain(import.meta.url, { name: 'chart-colors', deps, depNames: [], run });
