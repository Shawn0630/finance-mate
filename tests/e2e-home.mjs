// home: Home page — highlight carousel + insight carousels + AI append.
// Run standalone: node tests/e2e-home.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only home]
import http from 'node:http';
import fs from 'node:fs';
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // ---- fixture: properties ----
  r = await H.req('POST', '/api/properties', {
    address: '1 Home Test Way, Coquitlam, BC', purchase_date: '2024-01-15',
    assessed_value: 1000000, assessed_year: 2026,
  });
  H.check('home fixture: assessed-only property created', r.status === 201, JSON.stringify(r.data));
  const pidA = r.data.id;
  r = await H.req('POST', '/api/properties', {
    address: '2 Home Test Way, Coquitlam, BC', purchase_date: '2020-01-15',
    mortgage_balance: 300000, assessed_value: 500000, assessed_year: 2026,
  });
  const pidB = r.data.id;
  await H.req('PUT', `/api/properties/${pidB}`, { mortgage_balance_date: '2025-01-15', amortization_years: 25 });
  r = await H.req('GET', `/api/properties/${pidB}`);
  await H.req('PUT', `/api/properties/${pidB}/terms/${r.data.terms[0].id}`, { term_months: 60, amortization_years: 25 });
  r = await H.req('POST', `/api/properties/${pidB}/rates`, {
    term_id: r.data.terms[0].id, start_date: '2025-01-01', rate_type: 'fixed', annual_rate: 5,
  });
  H.check('home fixture: mortgaged property has a fixed 5% segment', r.status === 201, JSON.stringify(r.data));
  r = await H.req('GET', `/api/properties/${pidB}`);
  const outstandingB = r.data.remainingBalance;
  H.check('home fixture: mortgaged property projects a remaining balance',
    typeof outstandingB === 'number' && outstandingB > 0 && outstandingB < 300000, JSON.stringify(outstandingB));

  // ---- fixture: stocks (XQQ.TO, 100 units, $48 → $60 over 12 months) ----
  r = await H.req('POST', '/api/investments/accounts', { name: 'TFSA', type: 'TFSA' });
  const acctId = r.data.id;
  r = await H.req('POST', `/api/investments/accounts/${acctId}/holdings`, { label: 'XQQ', kind: 'exchange', symbol: 'XQQ.TO', currency: 'CAD' });
  const hid = r.data.id;
  r = await H.req('POST', `/api/investments/holdings/${hid}/events`, { date: '2026-01-15', type: 'buy', units: 100, price: 50 });
  H.check('home fixture: XQQ buy recorded', r.status === 201, JSON.stringify(r.data));
  const navPoints = [
    ['2025-11-30', 48], ['2025-12-31', 49], ['2026-01-31', 50], ['2026-02-28', 51],
    ['2026-03-31', 52], ['2026-04-30', 53], ['2026-05-31', 54], ['2026-06-30', 55],
    ['2026-07-31', 56], ['2026-08-31', 57], ['2026-09-30', 58], ['2026-10-31', 59],
    // Nov 28, not Nov 30: the 1y return window prices the month at the
    // 28th (see returnSuggestionsFromPoints), so a Nov 30 point would
    // be excluded from the end price while still pricing the month-end
    // value at $60.
    ['2026-11-28', 60],
  ];
  for (const [date, price] of navPoints) {
    r = await H.req('POST', `/api/investments/holdings/${hid}/nav`, { date, price });
    if (r.status !== 201) { H.check(`home fixture: NAV ${date} @ ${price}`, false, JSON.stringify(r.data)); }
  }

  // ---- fixture: salary job + rental ----
  r = await H.req('POST', '/api/earnings/jobs', {
    employer: 'Acme Corp', currency: 'CAD', province: 'BC', frequency: 'biweekly',
    start_date: '2026-01-02', recent_pay_date: '2026-10-23', recent_pay_value: 3000,
  });
  H.check('home fixture: biweekly job created', r.status === 201, JSON.stringify(r.data && r.data.calc && r.data.calc.perPeriod));
  const jobId = r.data.id;
  const cashNet = r.data.calc.perPeriod.cashNet;
  r = await H.req('POST', '/api/earnings/rentals', { label: 'Basement suite', rental_type: 'long_term', services_level: 'basic' });
  const rentalId = r.data.id;
  r = await H.req('POST', `/api/earnings/rentals/${rentalId}/entries`, { start_ym: '2026-01', monthly_rent: 2000, pay_day: 15 });
  H.check('home fixture: rental entry created', r.status === 201, JSON.stringify(r.data));

  // ---- fixture: spending ----
  r = await H.req('POST', '/api/spending/cards', { name: 'Visa', issuer: 'RBC', last4: '1234' });
  const cardId = r.data.id;
  const txs = [
    { date: '2026-10-05', merchant: 'SAVE ON', type: 'charge', amount: 400, category: 'Groceries' },
    { date: '2026-10-10', merchant: 'RESTAURANT', type: 'charge', amount: 300, category: 'Dining' },
    { date: '2026-09-05', merchant: 'SAVE ON', type: 'charge', amount: 200, category: 'Groceries' },
    { date: '2026-09-10', merchant: 'RESTAURANT', type: 'charge', amount: 100, category: 'Dining' },
  ];
  for (const t of txs) {
    r = await H.req('POST', `/api/spending/cards/${cardId}/transactions`, t);
    if (r.status !== 201) H.check(`home fixture: spending tx ${t.date} ${t.category}`, false, JSON.stringify(r.data));
  }

  // ---- API: GET /api/home generates the standard set ----
  r = await H.req('GET', '/api/home');
  H.check('home API: GET /api/home returns highlights + 12 system cards',
    r.status === 200 && r.data.insights.filter((c) => c.kind === 'system').length === 12 && r.data.highlights.length > 0,
    JSON.stringify({ insights: r.data.insights && r.data.insights.length, highlights: r.data.highlights && r.data.highlights.length }));
  const home = r.data;
  const card = (metric) => home.insights.find((c) => c.metric === metric);

  // Highlight: most recent first — Nov 6 salary (current), then Oct 23 salary, Oct 15 rent.
  const hl = home.highlights;
  H.check('home API: highlight starts with the current salary payday Nov 6',
    hl[0].kind === 'salary' && hl[0].date === '2026-11-06' && hl[0].amount === cashNet && hl[0].isCurrent === true,
    JSON.stringify(hl.slice(0, 3)));
  const rentCur = hl.find((x) => x.kind === 'rental' && x.isCurrent);
  H.check('home API: current rental occurrence is Oct 15 at $2,000',
    rentCur && rentCur.date === '2026-10-15' && rentCur.amount === 2000, JSON.stringify(rentCur));
  H.check('home API: unmarked old rows accumulate (Oct 23 salary + Sep 15 rent still shown)',
    hl.some((x) => x.kind === 'salary' && x.date === '2026-10-23' && x.received == null)
    && hl.some((x) => x.kind === 'rental' && x.date === '2026-09-15' && x.received == null),
    JSON.stringify(hl.map((x) => `${x.kind} ${x.date}`)));

  // Standard cards: hand-computed from the fixture.
  H.check('home API: assessed total is $1,500,000 (Nov 2026)',
    card('property_assessed') && card('property_assessed').value === 1500000 && card('property_assessed').period === '2026-11',
    JSON.stringify(card('property_assessed')));
  H.check('home API: outstanding equals the property detail remaining balance',
    card('property_outstanding') && card('property_outstanding').value === outstandingB,
    JSON.stringify({ card: card('property_outstanding'), outstandingB }));
  H.check('home API: equity = assessed − outstanding',
    card('property_equity') && card('property_equity').value === 1500000 - outstandingB,
    JSON.stringify(card('property_equity')));
  H.check('home API: portfolio value $6,000 (100 × $60)',
    card('stock_value') && card('stock_value').value === 6000, JSON.stringify(card('stock_value')));
  H.check('home API: total gain $1,000 ($6,000 − $5,000 contributed)',
    card('stock_gain') && card('stock_gain').value === 1000, JSON.stringify(card('stock_gain')));
  H.check('home API: top gainer XQQ.TO +25% (60/48 − 1)',
    card('stock_top_gainer') && card('stock_top_gainer').value === 25 && card('stock_top_gainer').sublabel === 'XQQ.TO',
    JSON.stringify(card('stock_top_gainer')));
  const octSalary = 2 * cashNet;
  H.check('home API: salary take-home Oct 2026 = 2 paydays × cash take-home',
    card('earning_salary') && card('earning_salary').value === octSalary && card('earning_salary').period === '2026-10',
    JSON.stringify({ card: card('earning_salary'), octSalary, cashNet }));
  H.check('home API: rental income Oct 2026 = $2,000; total income = salary + rent',
    card('earning_rental') && card('earning_rental').value === 2000
    && card('earning_total') && card('earning_total').value === octSalary + 2000,
    JSON.stringify({ rental: card('earning_rental'), total: card('earning_total') }));
  H.check('home API: total spend Oct 2026 = $700',
    card('spending_total') && card('spending_total').value === 700, JSON.stringify(card('spending_total')));
  H.check('home API: top category Groceries $400 (57.14% of Oct spend)',
    card('spending_top_category') && card('spending_top_category').value === 400
    && card('spending_top_category').sublabel === 'Groceries · 57.14% of spend',
    JSON.stringify(card('spending_top_category')));
  H.check('home API: biggest mover Groceries +$200 MoM',
    card('spending_biggest_mover') && card('spending_biggest_mover').value === 200
    && /Groceries/.test(card('spending_biggest_mover').sublabel),
    JSON.stringify(card('spending_biggest_mover')));

  // Equity MoM delta matches the overview chart's own series.
  r = await H.req('GET', '/api/overview/chart');
  const eqNov = r.data.propertyByMonth.find((x) => x.month === '2026-11');
  const eqOct = r.data.propertyByMonth.find((x) => x.month === '2026-10');
  H.check('home API: equity MoM delta equals the overview chart month change',
    eqNov && eqOct && card('property_equity').mom && card('property_equity').mom.delta === Math.round((eqNov.value - eqOct.value) * 100) / 100,
    JSON.stringify({ mom: card('property_equity').mom, eqNov, eqOct }));

  // ---- marks: rollover rule ----
  r = await H.req('POST', '/api/home/marks', { kind: 'rental', source_id: rentalId, date: '2026-09-15', received: 1 });
  H.check('home marks: marking a past rental row succeeds', r.status === 200 && r.data.received === 1, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home marks: marked Sep 15 rent rolled off (Oct 15 is current); Oct 15 still shown',
    !r.data.highlights.some((x) => x.kind === 'rental' && x.date === '2026-09-15')
    && r.data.highlights.some((x) => x.kind === 'rental' && x.date === '2026-10-15'),
    JSON.stringify(r.data.highlights.filter((x) => x.kind === 'rental').map((x) => x.date)));
  r = await H.req('POST', '/api/home/marks', { kind: 'rental', source_id: rentalId, date: '2026-10-15', received: 1 });
  r = await H.req('GET', '/api/home');
  H.check('home marks: marking the CURRENT row keeps it, marked received',
    r.data.highlights.some((x) => x.kind === 'rental' && x.date === '2026-10-15' && x.received === 1),
    JSON.stringify(r.data.highlights.filter((x) => x.kind === 'rental')));
  r = await H.req('POST', '/api/home/marks', { kind: 'salary', source_id: jobId, date: '2026-11-06' });
  H.check('home marks: missing received is a 400', r.status === 400, JSON.stringify(r.data));
  r = await H.req('POST', '/api/home/marks', { kind: 'salary', source_id: 999999, date: '2026-11-06', received: 1 });
  H.check('home marks: unknown source is a 404', r.status === 404, JSON.stringify(r.data));
  // Marks never change Earnings figures.
  r = await H.req('GET', `/api/earnings/jobs/${jobId}/monthly-chart`);
  const octIdx = r.data.months.indexOf('2026-10');
  H.check('home marks: earnings monthly chart unchanged by marks (Oct net = 2 × cash take-home)',
    octIdx >= 0 && r.data.net[octIdx] === octSalary, JSON.stringify({ months: r.data.months, net: r.data.net }));

  // ---- re-generate keeps AI cards out (none yet) and refreshes the set ----
  r = await H.req('POST', '/api/home/insights/generate', {});
  H.check('home generate: re-generate returns the 12 system cards',
    r.status === 200 && r.data.insights.filter((c) => c.kind === 'system').length === 12,
    JSON.stringify(r.data.insights && r.data.insights.length));

  // ---- AI-append: propose → Apply → exactly one → Delete; system cards protected ----
  fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'property', title: 'Test home equity', metric: `property_equity:${pidA}` } }));
  r = await H.req('POST', '/api/home/insights/ai-append', { text: 'Show me the first property equity', history: [] });
  H.check('home AI: append proposes the per-property equity card',
    r.status === 200 && r.data.proposal && r.data.proposal.metric === `property_equity:${pidA}` && r.data.proposal.title === 'Test home equity',
    JSON.stringify(r.data));
  const proposal = r.data.proposal;
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: proposal });
  H.check('home AI: Apply appends exactly one AI card with the computed value',
    r.status === 201 && r.data.insight && r.data.insight.kind === 'ai' && r.data.insight.value === 1000000,
    JSON.stringify(r.data));
  const aiId = r.data.insight.id;
  r = await H.req('POST', '/api/home/insights/ai-apply', { definition: proposal });
  H.check('home AI: second Apply on the same turn does not double-append',
    r.status === 200 && r.data.duplicate === true, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home AI: exactly one AI card on the page after double Apply',
    r.data.insights.filter((c) => c.kind === 'ai').length === 1, JSON.stringify(r.data.insights.filter((c) => c.kind === 'ai')));
  const sysId = r.data.insights.find((c) => c.kind === 'system').id;
  r = await H.req('DELETE', `/api/home/insights/${sysId}`);
  H.check('home AI: system cards cannot be deleted', r.status === 400, JSON.stringify(r.data));
  r = await H.req('DELETE', `/api/home/insights/${aiId}`);
  H.check('home AI: AI card deletes', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await H.req('GET', '/api/home');
  H.check('home AI: AI card gone after delete', r.data.insights.filter((c) => c.kind === 'ai').length === 0, JSON.stringify(r.data.insights.length));

  // ---- browser: default landing, carousels with peek, toggle persists ----
  if (!H.chromeAvailable) {
    H.check('home UI: skipped (no Chrome)', true, 'no chrome');
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
    page.on('dialog', (d) => d.accept()); // confirm() on AI-card Delete
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

    // Default landing: no hash → Home.
    await page.goto('http://ff.local/', { waitUntil: 'networkidle0', timeout: 30000 });
    const landedHome = await until(() => {
      const v = document.querySelector('#view-home');
      return v && !v.classList.contains('hidden') && document.querySelectorAll('#homeHighlightCarousel .insight-card').length > 0;
    });
    H.check('home UI: opening the app lands on Home with highlight cards', !!landedHome,
      await page.evaluate(() => document.querySelector('#view-home') ? document.querySelector('#view-home').className : 'no view-home'));
    H.check('home UI: Home nav item is active on landing',
      await page.evaluate(() => { const a = document.querySelector('#mainNav a[data-nav="home"]'); return a && a.classList.contains('active'); }),
      await page.evaluate(() => document.querySelector('#mainNav').textContent));

    // Highlight carousel: first card is the Nov 6 payday with the cash take-home.
    const cashFmt = cashNet.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const firstPay = await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel .insight-card');
      return c ? c.textContent : '';
    });
    H.check('home UI: first highlight card shows Nov 6 + cash take-home',
      firstPay.includes('Nov 6') && firstPay.includes(`$${cashFmt}`), firstPay.slice(0, 200));

    // Peek: the next card's edge shows past the carousel's right edge.
    const peek = await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel');
      const cards = [...c.querySelectorAll('.insight-card')];
      const cr = c.getBoundingClientRect();
      return { scrollW: c.scrollWidth, clientW: c.clientWidth, secondRight: cards[1].getBoundingClientRect().right, carRight: cr.right };
    });
    H.check('home UI: highlight carousel peeks the next card',
      peek.scrollW > peek.clientW && peek.secondRight > peek.carRight, JSON.stringify(peek));
    // Scroll to the second card: a sliver of the previous card stays visible.
    await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel');
      const cards = [...c.querySelectorAll('.insight-card')];
      c.scrollTo({ left: cards[1].offsetLeft, behavior: 'instant' });
    });
    await wait(700);
    const prevSliver = await page.evaluate(() => {
      const c = document.querySelector('#homeHighlightCarousel');
      const cards = [...c.querySelectorAll('.insight-card')];
      const cr = c.getBoundingClientRect();
      return { firstRight: cards[0].getBoundingClientRect().right, carLeft: cr.left };
    });
    H.check('home UI: scrolled carousel keeps a sliver of the previous card',
      prevSliver.firstRight > prevSliver.carLeft + 5, JSON.stringify(prevSliver));

    // Sections: 4 carousels, strip cards with big number + delta + sparkline.
    const sections = await page.evaluate(() => [...document.querySelectorAll('#homeSections [data-home-section]')].map((el) => ({
      section: el.dataset.homeSection, cards: el.querySelectorAll('.insight-card').length,
      canvases: el.querySelectorAll('canvas').length,
      text: el.textContent,
    })));
    H.check('home UI: four sections render 3 strip cards each with sparklines',
      sections.length === 4 && sections.every((s) => s.cards === 3 && s.canvases === 3),
      JSON.stringify(sections.map((s) => ({ section: s.section, cards: s.cards, canvases: s.canvases }))));
    const assessedText = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-home-section="property"] .insight-card')];
      const assessed = cards.find((c) => c.textContent.includes('Assessed total'));
      const equity = cards.find((c) => c.textContent.includes('Total equity'));
      return { assessed: assessed ? assessed.textContent : '', equity: equity ? equity.textContent : '' };
    });
    H.check('home UI: assessed card shows the $1,500,000 big number; equity card shows a MoM delta vs Oct 2026',
      assessedText.assessed.includes('$1,500,000') && /vs Oct 2026/.test(assessedText.equity),
      JSON.stringify(assessedText));

    // Toggle persists across reload.
    await page.evaluate(() => { document.querySelector('#homeHighlightCarousel .insight-card [data-mark-kind]').click(); });
    const toggled = await until(() => {
      const b = document.querySelector('#homeHighlightCarousel .insight-card [data-mark-kind]');
      return b && b.textContent.includes('Received') ? b.textContent : null;
    });
    H.check('home UI: marking the Nov 6 payday shows Received', !!toggled, String(toggled));
    await page.goto('http://ff.local/#home', { waitUntil: 'networkidle0', timeout: 30000 });
    const persisted = await until(() => {
      const b = document.querySelector('#homeHighlightCarousel .insight-card [data-mark-kind]');
      return b && b.textContent.includes('Received') ? b.textContent : null;
    });
    H.check('home UI: Received toggle persists across reload', !!persisted, String(persisted));

    // AI-append in the browser: propose → Apply appends one → Delete removes it.
    fs.writeFileSync(H.aiStubFile, JSON.stringify({ card: { section: 'spending', title: 'Groceries spend', metric: 'category_spend:Groceries' } }));
    await page.evaluate(() => {
      const input = document.querySelector('#homeAiText');
      input.value = 'Show me groceries spending';
      document.querySelector('#homeAiSend').click();
    });
    const proposed = await until(() => {
      const b = document.querySelector('#homeAiApplyBtn');
      return b ? document.querySelector('#homeAiThread').textContent : null;
    });
    H.check('home UI: AI-append proposes the groceries card', !!proposed && proposed.includes('Groceries spend'), String(proposed && proposed.slice(0, 200)));
    await page.evaluate(() => document.querySelector('#homeAiApplyBtn').click());
    const appended = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="spending"] .insight-card')];
      return cards.length === 4 ? cards.map((c) => c.textContent).join(' | ') : null;
    });
    H.check('home UI: Apply appends exactly one AI card to Spending', !!appended && appended.includes('Groceries spend'),
      String(appended && appended.slice(0, 300)));
    const delCount = await page.evaluate(() => document.querySelectorAll('.home-card-del').length);
    H.check('home UI: only the AI card has a Delete button (system cards have none)',
      delCount === 1, String(delCount));
    await page.evaluate(() => document.querySelector('.home-card-del').click());
    const afterDel = await until(() => {
      const cards = [...document.querySelectorAll('[data-home-section="spending"] .insight-card')];
      return cards.length === 3 ? 'back to 3' : null;
    });
    H.check('home UI: Delete removes the AI card', !!afterDel, String(afterDel));

    // Overview is untouched: its route still renders.
    await page.goto('http://ff.local/#assets/overview', { waitUntil: 'networkidle0', timeout: 30000 });
    const overviewOk = await until(() => {
      const s = document.querySelector('#section-overview');
      return s && !s.classList.contains('hidden') ? s.textContent : null;
    });
    H.check('home UI: Overview route still renders unchanged', !!overviewOk && overviewOk.includes('Assets over time'),
      String(overviewOk && overviewOk.slice(0, 200)));
  } finally {
    await browser.close();
  }
}
runModuleMain(import.meta.url, { name: 'home', deps, run });
