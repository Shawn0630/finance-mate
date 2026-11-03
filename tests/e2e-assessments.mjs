// assessments: HouseSigma history pull + BC Assessment fetch-on-read — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-assessments.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only assessments]
import http from 'node:http';
import path from 'node:path';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // HouseSigma history pull + BC Assessment fetch-on-read. The HS
  // stub's Christina payload mirrors the real sample property's
  // assessed values.
  const ptOf = (hist, year) => (hist.points || []).find((p) => p.year === year);

  // Adding a property fires a best-effort background pull: the
  // HouseSigma years appear by themselves, marked housesigma.
  r = await H.req('POST', '/api/properties', {
    address: '2985 Christina Pl, Coquitlam, BC', mortgage_balance: 1350000, purchase_date: '2024-12-17',
  });
  H.check('HS fixture property added', r.status === 201, JSON.stringify(r.data));
  const pidHs = r.data.id;
  let hsHist = null;
  for (let i = 0; i < 40; i++) {
    const h = await H.req('GET', `/api/properties/${pidHs}/value-history`);
    if (h.data.points && h.data.points.length === 5) { hsHist = h.data; break; }
    await new Promise((s) => setTimeout(s, 300));
  }
  H.check('background pull imported all 5 HouseSigma years after add', !!hsHist,
    JSON.stringify(hsHist ? hsHist.points : []));
  H.check('pulled points carry the housesigma source',
    !!hsHist && hsHist.points.every((p) => p.source === 'housesigma'));
  H.check('pulled values match the HouseSigma payload (2022 = 1,730,000, 2026 = 1,931,000)',
    !!hsHist && ptOf(hsHist, 2022).value === 1730000 && ptOf(hsHist, 2026).value === 1931000);
  H.check('pulled points carry the payload\u2019s land / building split (2022 = 1,306,000 / 424,000; 2026 = 1,503,000 / 428,000)',
    !!hsHist && ptOf(hsHist, 2022).land_value === 1306000 && ptOf(hsHist, 2022).building_value === 424000
      && ptOf(hsHist, 2026).land_value === 1503000 && ptOf(hsHist, 2026).building_value === 428000,
    JSON.stringify(hsHist ? hsHist.points : []));
  H.check('the detail call carried the located ids',
    !!H.flags.hsLastDetailParams && H.flags.hsLastDetailParams.id_address === 'HS-ADDR-1' && H.flags.hsLastDetailParams.id_listing === 'HS-LIST-1',
    JSON.stringify(H.flags.hsLastDetailParams));
  r = await H.req('GET', `/api/properties/${pidHs}`);
  H.check('property stored the HouseSigma ids for the next pull',
    r.data.hs_id_address === 'HS-ADDR-1' && r.data.hs_id_listing === 'HS-LIST-1', JSON.stringify(r.data.hs_id_address));

  // A manual point is never overwritten by a re-pull; HouseSigma's
  // own points refresh in place (no duplicates).
  r = await H.req('POST', `/api/properties/${pidHs}/value-history`, { year: 2024, value: 1900000 });
  H.check('manual 2024 point set over the pulled one', r.status === 201 && ptOf(r.data, 2024).source === 'manual');
  r = await H.req('POST', `/api/properties/${pidHs}/pull-history`);
  H.check('re-pull succeeds', r.data.ok === true, JSON.stringify(r.data));
  H.check('re-pull kept the manual 2024 point (value and source)',
    ptOf(r.data.history, 2024).value === 1900000 && ptOf(r.data.history, 2024).source === 'manual');
  H.check('re-pull reports the manual year as skipped',
    (r.data.skipped || []).some((s) => s.year === 2024 && s.kept === 'manual'), JSON.stringify(r.data.skipped));
  H.check('re-pull added no duplicate points', r.data.history.points.length === 5);
  H.check('the manual 2024 point carries no split (its entry had none)',
    ptOf(r.data.history, 2024).land_value == null && ptOf(r.data.history, 2024).building_value == null,
    JSON.stringify(ptOf(r.data.history, 2024)));
  // A re-pull refreshes HouseSigma's own splits in place: shift
  // the stub's 2023 land figure and the stored point follows.
  H.hsHistoryChristina.find((h) => h.year === 2023).land_int = 1400000;
  r = await H.req('POST', `/api/properties/${pidHs}/pull-history`);
  H.check('re-pull refreshes a HouseSigma point\u2019s split (2023 land 1,456,000 -> 1,400,000)',
    r.data.ok === true && ptOf(r.data.history, 2023).land_value === 1400000
      && ptOf(r.data.history, 2023).building_value === 447000,
    JSON.stringify(ptOf(r.data.history, 2023)));
  H.hsHistoryChristina.find((h) => h.year === 2023).land_int = 1456000;
  r = await H.req('POST', `/api/properties/${pidHs}/pull-history`);
  H.check('stub restored and re-pulled (2023 land back to 1,456,000)',
    r.data.ok === true && ptOf(r.data.history, 2023).land_value === 1456000,
    JSON.stringify(ptOf(r.data.history, 2023)));

  // BC Assessment ('auto') beats HouseSigma for the same year; a
  // year HouseSigma has and BCA does not is filled in.
  r = await H.req('POST', '/api/properties', {
    address: '1200 Douglas St, Victoria, BC', mortgage_balance: 500000, purchase_date: '2020-06-01', bca_id: 'QkxPQy0xMjAw',
  });
  const pidGov = r.data.id;
  for (let i = 0; i < 40; i++) { // let its background pull settle first
    const h = await H.req('GET', `/api/properties/${pidGov}/value-history`);
    if (h.data.points && h.data.points.some((p) => p.year === 2025)) break;
    await new Promise((s) => setTimeout(s, 300));
  }
  r = await H.req('POST', `/api/properties/${pidGov}/fetch-bca`);
  H.check('gov property manual BCA fetch ok', r.data.ok === true, JSON.stringify(r.data));
  r = await H.req('POST', `/api/properties/${pidGov}/pull-history`);
  H.check('gov pull ok', r.data.ok === true, JSON.stringify(r.data));
  H.check('BCA 2026 point kept over HouseSigma (6,532,000, auto)',
    ptOf(r.data.history, 2026).value === 6532000 && ptOf(r.data.history, 2026).source === 'auto');
  H.check('HouseSigma 2025 point stands (6,100,000, housesigma)',
    ptOf(r.data.history, 2025).value === 6100000 && ptOf(r.data.history, 2025).source === 'housesigma');
  H.check('the BCA fetch stored the current year\u2019s split on its point (2026 = 4,666,000 / 1,866,000)',
    ptOf(r.data.history, 2026).land_value === 4666000 && ptOf(r.data.history, 2026).building_value === 1866000,
    JSON.stringify(ptOf(r.data.history, 2026)));
  H.check('the HouseSigma 2025 point carries its split (4,050,000 / 2,050,000)',
    ptOf(r.data.history, 2025).land_value === 4050000 && ptOf(r.data.history, 2025).building_value === 2050000,
    JSON.stringify(ptOf(r.data.history, 2025)));

  // Manual points: Land + Building both given -> the year's total
  // is their sum and the split is stored; a total-only entry
  // leaves the split empty; a one-sided split is a 400; a PUT
  // with both figures re-sums the value.
  r = await H.req('POST', '/api/properties', {
    address: '555 Split Lane, Coquitlam, BC', mortgage_balance: 100000, purchase_date: '2024-01-01',
  });
  const pidSplit = r.data.id;
  r = await H.req('POST', `/api/properties/${pidSplit}/value-history`, { year: 2021, land_value: 1200000, building_value: 400000 });
  H.check('manual point with Land + Building: value is their sum (1,600,000), split stored',
    r.status === 201 && ptOf(r.data, 2021).value === 1600000
      && ptOf(r.data, 2021).land_value === 1200000 && ptOf(r.data, 2021).building_value === 400000
      && ptOf(r.data, 2021).source === 'manual',
    JSON.stringify(ptOf(r.data, 2021)));
  r = await H.req('POST', `/api/properties/${pidSplit}/value-history`, { year: 2020, value: 900000 });
  H.check('manual total-only point: split stays empty',
    r.status === 201 && ptOf(r.data, 2020).value === 900000
      && ptOf(r.data, 2020).land_value == null && ptOf(r.data, 2020).building_value == null,
    JSON.stringify(ptOf(r.data, 2020)));
  r = await H.req('POST', `/api/properties/${pidSplit}/value-history`, { year: 2019, value: 500000, land_value: 500000 });
  H.check('a one-sided split is rejected (400)',
    r.status === 400 && /given together/.test(r.data.error || ''), JSON.stringify(r.data));
  const pt2020 = ptOf(r.data, 2020) || (await H.req('GET', `/api/properties/${pidSplit}/value-history`)).data.points.find((p) => p.year === 2020);
  r = await H.req('PUT', `/api/properties/${pidSplit}/value-history/${pt2020.id}`, { land_value: 700000, building_value: 250000 });
  H.check('PUT with both split figures re-sums the value (900,000 -> 950,000)',
    r.status === 200 && ptOf(r.data, 2020).value === 950000
      && ptOf(r.data, 2020).land_value === 700000 && ptOf(r.data, 2020).building_value === 250000,
    JSON.stringify(ptOf(r.data, 2020)));
  await H.req('DELETE', `/api/properties/${pidSplit}`);

  // Fetch-on-read: a never-fetched property with a BCA id refreshes
  // itself when its detail is loaded — through the by-id channel —
  // and does not refetch on the next load.
  r = await H.req('POST', '/api/properties', {
    address: '1200 Douglas St, Victoria, BC', mortgage_balance: 400000, purchase_date: '2019-01-01', bca_id: 'QkxPQy0xMjAw',
  });
  const pidAuto = r.data.id;
  const infoBefore = H.stubHits.info.length;
  r = await H.req('GET', `/api/properties/${pidAuto}`);
  H.check('detail load auto-fetched the BCA value (6,532,000 / 2026)',
    r.data.assessed_value === 6532000 && r.data.assessed_year === 2026, JSON.stringify(r.data.assessed_value));
  H.check('auto-refresh went through the by-id property page', H.stubHits.info.length > infoBefore);
  const infoAfterFirst = H.stubHits.info.length;
  r = await H.req('GET', `/api/properties/${pidAuto}`);
  H.check('second load does not refetch (attempt gate)', H.stubHits.info.length === infoAfterFirst);

  // A failed auto-refresh keeps the stored state and flags stale
  // with the failing stage named.
  H.flags.infoDown = true;
  r = await H.req('POST', '/api/properties', {
    address: '1200 Douglas St, Victoria, BC', mortgage_balance: 300000, purchase_date: '2018-01-01', bca_id: 'QkxPQy0xMjAw',
  });
  const pidFail = r.data.id;
  r = await H.req('GET', `/api/properties/${pidFail}`);
  H.check('failed auto-refresh leaves the value unset', r.data.assessed_value == null, JSON.stringify(r.data.assessed_value));
  H.check('failed auto-refresh is flagged stale, stage named',
    !!r.data.assessmentRefresh && r.data.assessmentRefresh.stale === true
      && /property page/.test(r.data.assessmentRefresh.error || ''),
    JSON.stringify(r.data.assessmentRefresh));
  H.flags.infoDown = false;

  // HouseSigma failures surface explicitly: a site outage fails the
  // pull with a named stage; an address it does not know fails too.
  H.flags.hsMode = 'down';
  r = await H.req('POST', '/api/properties', {
    address: '2985 Christina Pl, Coquitlam, BC', mortgage_balance: 100000, purchase_date: '2024-01-01',
  });
  const pidDown = r.data.id;
  r = await H.req('POST', `/api/properties/${pidDown}/pull-history`);
  H.check('HouseSigma outage returns ok:false with an explicit stage',
    r.data.ok === false && typeof r.data.stage === 'string' && r.data.stage.length > 0
      && /HouseSigma lookup failed/.test(r.data.error || ''),
    JSON.stringify(r.data));
  H.flags.hsMode = 'ok';
  r = await H.req('POST', '/api/properties', {
    address: '999 Nowhere Rd, Coquitlam, BC', mortgage_balance: 100000, purchase_date: '2024-01-01',
  });
  const pidNone = r.data.id;
  r = await H.req('POST', `/api/properties/${pidNone}/pull-history`);
  H.check('unknown address fails at the locate stage',
    r.data.ok === false && r.data.stage === 'locate', JSON.stringify(r.data));

  // ---------------------------------------------------------------
  // Assessment History modal in the browser: it opens on the
  // assessed-history bar chart (no source/status prose anywhere),
  // an in-modal HouseSigma pull grows the chart in place, and a BC
  // Assessment outage still surfaces as a short error line.
  if (!H.puppeteer || !H.chromeAvailable) {
    console.log('history modal browser checks skipped (puppeteer-core / probe Chrome not available)');
  } else {
    // A Christina property: the background pull imports all five
    // HouseSigma years; drop the 2023 point so the in-modal pull
    // has a year to add back.
    r = await H.req('POST', '/api/properties', {
      address: '2985 Christina Pl, Coquitlam, BC', mortgage_balance: 1350000, purchase_date: '2024-12-17',
    });
    const pidHist = r.data.id;
    let hist0 = null;
    for (let i = 0; i < 40; i++) {
      const h = await H.req('GET', `/api/properties/${pidHist}/value-history`);
      if (h.data.points && h.data.points.length === 5) { hist0 = h.data; break; }
      await new Promise((s) => setTimeout(s, 300));
    }
    H.check('history-modal fixture: background pull imported the 5 years', !!hist0,
      JSON.stringify(hist0 ? hist0.points : []));
    const pt2023 = hist0 && hist0.points.find((p) => p.year === 2023);
    r = await H.req('DELETE', `/api/properties/${pidHist}/value-history/${pt2023.id}`);
    H.check('history-modal fixture: 2023 point removed (4 points left)',
      !!r.data.points && r.data.points.length === 4, JSON.stringify(r.data.points && r.data.points.length));
    // A manual total-only year joins the split HouseSigma years:
    // the chart must stack the split years and draw 2021 as one
    // Total bar, the table shows its Land / Building as —.
    r = await H.req('POST', `/api/properties/${pidHist}/value-history`, { year: 2021, value: 1600000 });
    H.check('history-modal fixture: total-only 2021 point added (5 points)',
      r.status === 201 && r.data.points.length === 5, JSON.stringify(r.data.points && r.data.points.length));

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
    const loginResH = await fetch(H.BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookieValueH = loginResH.headers.get('set-cookie').split(';')[0].split('=')[1];
    const browserH = await H.puppeteer.launch({
      executablePath: '/opt/meta-chromium/chrome',
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browserH.newPage();
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
            requestId: e.requestId, responseCode: resp.status, responseHeaders: respHeaders,
            body: resp.body.toString('base64'),
          });
        } catch {
          try { await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }); } catch {}
        }
      });
      await client.send('Network.setCookie', { name: 'ff_session', value: cookieValueH, domain: 'ff.local', path: '/', httpOnly: true });
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const until = async (fn, tries = 48) => {
        for (let i = 0; i < tries; i++) {
          try { const v = await page.evaluate(fn); if (v) return v; } catch {}
          await wait(250);
        }
        return null;
      };

      await page.goto(`http://ff.local/#property/${pidHist}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await wait(1600);
      await page.evaluate(() => document.querySelector('#openHistoryBtn').click());
      await wait(600);
      const before = await page.evaluate(() => {
        const modal = document.querySelector('#historyModal');
        const c = window.__fmCharts.history;
        const canvas = modal.querySelector('#historyChart');
        const rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
        const byKey = {};
        if (c) for (const ds of c.data.datasets) byKey[ds.key] = ds;
        const tipFor = (key, year) => {
          const ds = byKey[key];
          const i = c.data.labels.indexOf(year);
          const out = c.options.plugins.tooltip.callbacks.label({
            dataIndex: i, datasetIndex: c.data.datasets.indexOf(ds), dataset: ds,
            parsed: { y: ds.data[i] },
          });
          return Array.isArray(out) ? out.join(' | ') : String(out);
        };
        const legendTexts = c && c.legend ? c.legend.legendItems.map((it) => it.text) : [];
        const headCells = [...modal.querySelectorAll('#trendHead th')].map((th) => th.textContent.trim());
        const row2021 = [...modal.querySelectorAll('#trendRows tr')]
          .find((tr) => tr.cells[0] && tr.cells[0].textContent.trim() === '2021');
        return {
          text: modal.textContent,
          metaGone: !modal.querySelector('#assessmentMetaView') && !modal.querySelector('#hsPullNote'),
          bars: c ? c.data.datasets[0].data.length : null,
          labels: c ? c.data.labels : null,
          canvasW: rect.width, canvasH: rect.height,
          chartAboveButtons: canvas.getBoundingClientRect().top
            < document.querySelector('#fetchBcaBtn').getBoundingClientRect().top,
          stacks: c ? c.data.datasets.map((ds) => ds.stack) : null,
          land: byKey.land ? byKey.land.data : null,
          building: byKey.building ? byKey.building.data : null,
          total: byKey.total ? byKey.total.data : null,
          legendTexts,
          tipSplit: c ? tipFor('land', '2022') : null,
          tipTotalOnly: c ? tipFor('total', '2021') : null,
          headCells,
          row2021: row2021 ? row2021.textContent : null,
        };
      });
      H.check('history modal opens on the bar chart (5 bars, chart above the buttons, real size)',
        before.bars === 5 && before.labels.join(',') === '2021,2022,2024,2025,2026'
          && before.chartAboveButtons && before.canvasW > 0 && before.canvasH >= 150,
        JSON.stringify(before));
      H.check('the chart stacks Land + Building for split years and a single Total bar for the total-only year, all in one stack',
        JSON.stringify(before.land) === JSON.stringify([0, 1306000, 1504000, 1557000, 1503000])
          && JSON.stringify(before.building) === JSON.stringify([0, 424000, 451000, 445000, 428000])
          && JSON.stringify(before.total) === JSON.stringify([1600000, 0, 0, 0, 0])
          && before.stacks.every((s) => s === 'assessed'),
        JSON.stringify({ land: before.land, building: before.building, total: before.total, stacks: before.stacks }));
      H.check('the legend names Land / Building / Total while both kinds of years exist',
        before.legendTexts.includes('Land') && before.legendTexts.includes('Building')
          && before.legendTexts.includes('Total'),
        JSON.stringify(before.legendTexts));
      H.check('tooltips: a split year breaks down Land / Building / Total; a total-only year shows Total only',
        before.tipSplit.includes('Land') && before.tipSplit.includes('1,306,000')
          && before.tipSplit.includes('Building') && before.tipSplit.includes('424,000')
          && before.tipSplit.includes('Total') && before.tipSplit.includes('1,730,000')
          && before.tipTotalOnly.includes('Total') && before.tipTotalOnly.includes('1,600,000')
          && !before.tipTotalOnly.includes('Land'),
        JSON.stringify({ split: before.tipSplit, totalOnly: before.tipTotalOnly }));
      H.check('the history table gains Land / Building columns (the total-only year shows —)',
        before.headCells.includes('Land') && before.headCells.includes('Building')
          && !!before.row2021 && before.row2021.includes('—'),
        JSON.stringify({ head: before.headCells, row2021: before.row2021 }));
      H.check('history modal carries no BCA source line and no HouseSigma status line',
        !before.text.includes('Source: BC Assessment') && !before.text.includes('HouseSigma history:')
          && before.metaGone,
        before.text.slice(0, 200));

      // Pull: the missing year comes back and the chart grows.
      await page.evaluate(() => document.querySelector('#pullHistoryBtn').click());
      const grown = await until(() => {
        const c = window.__fmCharts.history;
        return c && c.data.datasets[0].data.length === 6 ? true : null;
      });
      H.check('in-modal HouseSigma pull grows the chart to 6 bars', !!grown);
      const after = await page.evaluate(() => {
        const c = window.__fmCharts.history;
        const i = c.data.labels.indexOf('2023');
        const land = c.data.datasets.find((ds) => ds.key === 'land');
        const building = c.data.datasets.find((ds) => ds.key === 'building');
        const cb = c.options.plugins.tooltip.callbacks.label;
        const tip = cb({
          dataIndex: i, datasetIndex: c.data.datasets.indexOf(land), dataset: land,
          parsed: { y: land.data[i] },
        });
        return {
          land2023: land.data[i],
          building2023: building.data[i],
          src2023: land.pointMeta[i].source,
          tip: Array.isArray(tip) ? tip.join(' | ') : String(tip),
          msg: document.querySelector('#historyMsg').textContent,
        };
      });
      H.check('the pulled 2023 year stacks as a HouseSigma split (Land 1,456,000 + Building 447,000 = 1,903,000 in its tooltip)',
        after.land2023 === 1456000 && after.building2023 === 447000 && after.src2023 === 'housesigma'
          && after.tip.includes('HouseSigma') && after.tip.includes('1,903,000')
          && after.tip.includes('Land') && after.tip.includes('Building'),
        JSON.stringify(after));
      H.check('a successful pull writes no status sentence (the chart is the report)',
        !after.msg.includes('Pulled from HouseSigma') && !after.msg.includes('up to date'),
        after.msg);

      // BCA outage: the Fetch button still reports a short error.
      H.flags.bcaDown = true;
      await page.evaluate(() => document.querySelector('#fetchBcaBtn').click());
      const errShown = await until(() =>
        document.querySelector('#historyMsg').textContent.includes('BC Assessment fetch failed') ? true : null);
      H.flags.bcaDown = false;
      H.check('BCA outage in the modal shows the short fetch error (functional status kept)', !!errShown);
    } catch (err) {
      H.check('history modal browser flow runs to completion', false, String((err && err.message) || err));
    } finally {
      await browserH.close();
    }
  }

  // ---------------------------------------------------------------
}

runModuleMain(import.meta.url, { name: 'assessments', deps, depNames: [], run });
