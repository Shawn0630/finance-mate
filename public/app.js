// Family Finance — frontend (plain JS, no build step).
const $ = (sel, el = document) => el.querySelector(sel);
const money = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function showMsg(el, kind, text) {
  el.className = 'msg ' + kind;
  el.textContent = text;
}

// ------------------------------------------------------------ navigation ---
let currentPropertyId = null;
function showView(name) {
  for (const v of ['assets', 'property', 'spending', 'planning', 'tax']) {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('#mainNav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === (name === 'property' ? 'assets' : name))
  );
}
function route() {
  const hash = location.hash || '#assets';
  if (hash.startsWith('#property/')) {
    currentPropertyId = Number(hash.split('/')[1]);
    showView('property');
    loadPropertyDetail(currentPropertyId);
  } else if (['#spending', '#planning', '#tax'].includes(hash)) {
    showView(hash.slice(1));
  } else {
    showView('assets');
    loadAssets();
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------- assets page ---
const CATEGORY_LABELS = { fixed_assets: 'Fixed assets', stocks: 'Stocks', term_deposits: 'Term deposits', other: 'Other' };

async function loadAssets() {
  const [summary, properties, assets] = await Promise.all([
    api('/api/summary'), api('/api/properties'), api('/api/assets'),
  ]);
  $('#sumProperty').textContent = money(summary.propertyValue);
  $('#sumMortgage').textContent = money(summary.mortgageBalance);
  $('#sumOther').textContent = money(summary.otherAssets);
  const net = $('#sumNet');
  net.textContent = money(summary.netWorth);
  net.classList.toggle('negative', summary.netWorth < 0);

  $('#propertyCards').innerHTML = properties.map((p) => {
    const photo = p.photo_file
      ? `<img src="/photos/${esc(p.photo_file)}" alt="">`
      : p.photo_url
        ? `<img src="${esc(p.photo_url)}" alt="">`
        : 'No photo';
    const rate = p.currentRate
      ? `${p.currentRate.rate_type === 'fixed' ? 'Fixed' : 'Variable'} ${Number(p.currentRate.annual_rate).toFixed(2)}%`
      : 'No rate segments';
    const src = p.assessed_source === 'auto'
      ? `<span class="badge">BC Assessment${p.assessed_year ? ' ' + p.assessed_year : ''}</span>`
      : p.assessed_source === 'manual' ? '<span class="badge manual">Manual</span>' : '';
    return `<div class="card">
      <div class="photo">${photo}</div>
      <div class="body">
        <div class="addr">${esc(p.address)}</div>
        <div class="kv"><span class="k">Assessed value</span><span>${money(p.assessed_value)} ${src}</span></div>
        <div class="kv"><span class="k">Mortgage balance</span><span>${money(p.mortgage_balance)}</span></div>
        <div class="kv"><span class="k">Current rate</span><span>${rate}</span></div>
        <div class="toolbar"><button onclick="location.hash='#property/${p.id}'">Details</button></div>
      </div></div>`;
  }).join('') || '<div class="note">No properties yet — add one below.</div>';

  const groups = {};
  for (const a of assets) (groups[a.category] = groups[a.category] || []).push(a);
  $('#assetGroups').innerHTML = Object.keys(CATEGORY_LABELS).map((cat) => {
    const rows = groups[cat] || [];
    const subtotal = rows.reduce((s, a) => s + Number(a.value || 0), 0);
    const body = rows.map((a) => `<tr>
      <td>${esc(a.name)}</td><td class="num">${money(a.value)}</td><td>${esc(a.currency)}</td>
      <td>${esc(a.notes || '')}</td>
      <td><button class="small danger" onclick="deleteAsset(${a.id})">Delete</button></td></tr>`).join('');
    return `<div class="panel"><h3>${CATEGORY_LABELS[cat]} — subtotal ${money(subtotal)}</h3>
      ${rows.length ? `<table><thead><tr><th>Name</th><th class="num">Value</th><th>Currency</th><th>Notes</th><th></th></tr></thead><tbody>${body}</tbody></table>` : '<div class="note" style="margin:0">No entries yet.</div>'}
      </div>`;
  }).join('');
}

async function deleteAsset(id) {
  if (!confirm('Delete this asset?')) return;
  await api(`/api/assets/${id}`, { method: 'DELETE' });
  loadAssets();
}
window.deleteAsset = deleteAsset;

$('#addPropForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const msg = $('#addPropMsg');
  try {
    const p = await api('/api/properties', { method: 'POST', body: f });
    e.target.reset();
    // Best-effort automatic BC Assessment fetch right after adding.
    const r = await api(`/api/properties/${p.id}/fetch-bca`, { method: 'POST' });
    if (r.ok) {
      showMsg(msg, 'ok', `Property added. BC Assessment value fetched: ${money(r.result.assessedValue)} (${r.result.assessedYear || 'current'}), matched "${r.result.matchedAddress}".`);
    } else {
      showMsg(msg, 'warn', `Property added. Automatic BC Assessment fetch did not succeed (${r.error}). You can enter the value manually on the detail page, or retry the fetch there.`);
    }
    loadAssets();
  } catch (err) { showMsg(msg, 'err', err.message); }
});

$('#addAssetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api('/api/assets', { method: 'POST', body: f });
    e.target.reset();
    loadAssets();
  } catch (err) { showMsg($('#addAssetMsg'), 'err', err.message); }
});

// ---------------------------------------------------------- property detail ---
let chart = null;
let fullSeries = [];
let chartMeta = null;

function photoSrc(p) {
  if (p.photo_file) return `/photos/${p.photo_file}`;
  if (p.photo_url) return p.photo_url;
  return null;
}

async function loadPropertyDetail(id) {
  const p = await api(`/api/properties/${id}`);
  const src = photoSrc(p);
  $('#photoArea').innerHTML = src
    ? `<img class="detail-photo" src="${esc(src)}" alt="">`
    : '<div class="detail-photo-empty">No photo — add a photo URL or upload one below</div>';
  const pf = $('#propForm');
  pf.address.value = p.address || '';
  pf.notes.value = p.notes || '';
  pf.assessed_value.value = p.assessed_value ?? '';
  pf.assessed_year.value = p.assessed_year ?? '';
  pf.photo_url.value = p.photo_url || '';
  $('#assessmentMeta').textContent =
    p.assessed_source === 'auto'
      ? `Source: BC Assessment (auto-fetched${p.assessed_fetched_at ? ' ' + new Date(p.assessed_fetched_at).toLocaleString('en-CA') : ''}${p.bca_matched_address ? ', matched "' + p.bca_matched_address + '"' : ''}${p.land_value != null ? `, land ${money(p.land_value)} + building ${money(p.building_value)}` : ''}). Editing the value above marks it as manual.`
      : p.assessed_source === 'manual'
        ? 'Source: entered manually. Use "Fetch from BC Assessment" to replace it with the official assessed value.'
        : 'No assessed value yet.';
  const mf = $('#mortgageForm');
  mf.mortgage_balance.value = p.mortgage_balance ?? '';
  mf.mortgage_balance_date.value = p.mortgage_balance_date || '';
  mf.mortgage_payment.value = p.mortgage_payment ?? '';
  mf.amortization_years.value = p.amortization_years ?? '';
  renderSegments(p.segments);
  loadChart(id);
}

function renderSegments(segments) {
  $('#segmentRows').innerHTML = segments.map((s) => `<tr>
    <td>${esc(s.start_date)}</td>
    <td>${s.rate_type === 'fixed' ? '<span class="badge">Fixed</span>' : '<span class="badge var">Variable</span>'}</td>
    <td class="num">${Number(s.annual_rate).toFixed(2)}</td>
    <td><button class="small danger" onclick="deleteSegment(${s.id})">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="note" style="margin:0">No segments yet — the projection runs at 0% until one is added.</td></tr>';
}

async function deleteSegment(segId) {
  if (!confirm('Delete this rate segment?')) return;
  await api(`/api/properties/${currentPropertyId}/rates/${segId}`, { method: 'DELETE' });
  loadPropertyDetail(currentPropertyId);
}
window.deleteSegment = deleteSegment;

$('#propForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    showMsg($('#detailMsg'), 'ok', 'Saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#mortgageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    showMsg($('#detailMsg'), 'ok', 'Mortgage saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#addSegmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api(`/api/properties/${currentPropertyId}/rates`, { method: 'POST', body: f });
    e.target.reset();
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#fetchBcaBtn').addEventListener('click', async () => {
  const msg = $('#detailMsg');
  showMsg(msg, 'ok', 'Fetching from BC Assessment…');
  try {
    const r = await api(`/api/properties/${currentPropertyId}/fetch-bca`, { method: 'POST' });
    if (r.ok) {
      showMsg(msg, 'ok', `Fetched: assessed value ${money(r.result.assessedValue)} (${r.result.assessedYear || 'current'}), matched "${r.result.matchedAddress}".`);
      loadPropertyDetail(currentPropertyId);
    } else {
      showMsg(msg, 'err', `BC Assessment fetch failed (${r.error}). Your saved values were not changed — you can enter the value manually.`);
    }
  } catch (err) { showMsg(msg, 'err', err.message); }
});

$('#photoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  const dataBase64 = String(dataUrl).split(',')[1];
  try {
    await api(`/api/properties/${currentPropertyId}/photo-upload`, {
      method: 'POST', body: { dataBase64, contentType: file.type },
    });
    showMsg($('#detailMsg'), 'ok', 'Photo uploaded.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#deletePropertyBtn').addEventListener('click', async () => {
  if (!confirm('Delete this property, its rate segments and its photo?')) return;
  await api(`/api/properties/${currentPropertyId}`, { method: 'DELETE' });
  location.hash = '#assets';
});

// ------------------------------------------------------------------- chart ---
async function loadChart(id) {
  const msg = $('#chartMsg');
  msg.className = 'msg';
  const r = await api(`/api/properties/${id}/amortization`);
  if (!r.ok) {
    fullSeries = [];
    chartMeta = null;
    showMsg(msg, 'warn', r.error);
    $('#chartSummary').textContent = '';
    if (chart) { chart.destroy(); chart = null; }
    return;
  }
  fullSeries = r.series;
  chartMeta = r;
  drawChart(currentRangeMonths());
}

function currentRangeMonths() {
  const custom = Number($('#customMonths').value);
  if (custom > 0) return custom;
  const active = $('#rangeBtns button.active');
  return active ? Number(active.dataset.months) : 60;
}

function drawChart(months) {
  if (!fullSeries.length) return;
  const rows = months > 0 ? fullSeries.slice(0, months) : fullSeries;
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const bits = [
    `Monthly payment used: ${money(chartMeta.paymentUsed)}${chartMeta.paymentSource === 'derived' ? ' (derived from remaining amortization)' : ''}`,
    `Interest in this range: ${money(totalInterest)}`,
    chartMeta.payoffMonth ? `Projected payoff: ${chartMeta.payoffMonth}` : 'Not paid off within the projection window',
  ];
  if (!chartMeta.hasRates) bits.push('No rate segments set — projecting at 0%');
  $('#chartSummary').textContent = bits.join(' · ');
  const msg = $('#chartMsg');
  if (chartMeta.negativeAmortization) {
    showMsg(msg, 'warn', 'Warning: the monthly payment is below the monthly interest in some months (negative amortization) — the balance grows there.');
  } else msg.className = 'msg';

  const ctx = $('#mortgageChart');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => r.month),
      datasets: [
        {
          label: 'Remaining balance',
          data: rows.map((r) => r.balance),
          borderColor: '#1668c4', backgroundColor: '#1668c4',
          yAxisID: 'y', tension: 0.15, pointRadius: 0, borderWidth: 2,
        },
        {
          label: 'Monthly interest',
          data: rows.map((r) => r.interest),
          borderColor: '#d97706', backgroundColor: '#d97706',
          yAxisID: 'y1', tension: 0.15, pointRadius: 0, borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { type: 'linear', position: 'left', title: { display: true, text: 'Remaining balance ($)' } },
        y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Monthly interest ($)' } },
        x: { ticks: { maxTicksLimit: 12 } },
      },
    },
  });
}

$('#rangeBtns').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-months]');
  if (!btn) return;
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.toggle('active', b === btn));
  $('#customMonths').value = '';
  drawChart(Number(btn.dataset.months));
});
$('#customMonths').addEventListener('change', () => {
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.remove('active'));
  drawChart(currentRangeMonths());
});

// -------------------------------------------------------------------- misc ---
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

(async () => {
  try {
    const me = await api('/api/me');
    $('#whoami').textContent = me.username;
  } catch { /* api() already redirected */ }
  route();
})();
