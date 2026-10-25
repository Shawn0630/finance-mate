// Finance Mate — frontend (plain JS, no build step).
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

// ------------------------------------------------------- address suggest ---
// Dropdown autocomplete bound to an address input. Suggestions come from
// /api/address/suggest (BC Assessment's own address search, so a picked
// suggestion is exactly the address form the assessment fetch can match).
// Picking one fills the input with the suggestion label and remembers its
// property id in state; editing the text afterwards clears the id again,
// back to free-text semantics. The owning form reads state.id at submit.
function attachAddressSuggest(input, list) {
  const state = { id: null, label: '' };
  let items = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  function close() {
    list.classList.add('hidden');
    list.innerHTML = '';
    items = [];
    active = -1;
  }
  function render() {
    if (!items.length) { close(); return; }
    list.innerHTML = '';
    items.forEach((s, i) => {
      const li = document.createElement('li');
      li.textContent = s.label;
      if (i === active) li.classList.add('active');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.appendChild(li);
    });
    list.classList.remove('hidden');
  }
  function pick(i) {
    const s = items[i];
    if (!s) return;
    input.value = s.label;
    state.id = s.id;
    state.label = s.label;
    close();
    input.focus();
  }
  input.addEventListener('input', () => {
    if (input.value !== state.label) state.id = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 4) { close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const data = await api('/api/address/suggest?q=' + encodeURIComponent(q));
        if (my !== seq) return;
        items = data.suggestions || [];
        active = items.length ? 0 : -1;
        render();
      } catch { if (my === seq) close(); }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { close(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!list.contains(e.target) && e.target !== input) close();
  });
  return { state, close, reset() { state.id = null; state.label = ''; close(); } };
}
const addSuggest = attachAddressSuggest(
  $('#addPropForm .address-input'), $('#addPropForm .suggest-list'));
const propSuggest = attachAddressSuggest(
  $('#propForm .address-input'), $('#propForm .suggest-list'));

// --------------------------------------------------------------- modals ---
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModalEl(overlay) { overlay.classList.add('hidden'); }
document.querySelectorAll('[data-close-modal]').forEach((b) =>
  b.addEventListener('click', () => closeModalEl(b.closest('.modal-overlay'))));
document.querySelectorAll('.modal-overlay').forEach((o) =>
  o.addEventListener('mousedown', (e) => { if (e.target === o) closeModalEl(o); }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(closeModalEl);
});

// ------------------------------------------------------------ navigation ---
// Assets has a persistent secondary menu: Overview (totals only) plus one
// section per asset kind, each with its own listing, Add modal and detail
// view. The section lives in the hash: #assets/<section>.
const ASSET_SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'properties', label: 'Properties', addLabel: 'Add property' },
  { key: 'fixed-assets', category: 'fixed_assets', label: 'Fixed assets', addLabel: 'Add fixed asset' },
  { key: 'stocks', category: 'stocks', label: 'Stocks', addLabel: 'Add stock' },
  { key: 'term-deposits', category: 'term_deposits', label: 'Term deposits', addLabel: 'Add term deposit' },
  { key: 'other', category: 'other', label: 'Other', addLabel: 'Add asset' },
];
const CATEGORY_LABELS = { fixed_assets: 'Fixed assets', stocks: 'Stocks', term_deposits: 'Term deposits', other: 'Other' };
const SECTION_OF_CATEGORY = Object.fromEntries(
  ASSET_SECTIONS.filter((s) => s.category).map((s) => [s.category, s.key]));

let currentPropertyId = null;
let currentAssetId = null;
let currentSection = 'overview';

function showView(name) {
  for (const v of ['assets', 'property', 'asset', 'spending', 'planning', 'tax']) {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('#mainNav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === (name === 'property' || name === 'asset' ? 'assets' : name))
  );
}

function showSection(key) {
  currentSection = key;
  for (const s of ASSET_SECTIONS) {
    $('#section-' + s.key).classList.toggle('hidden', s.key !== key);
  }
  document.querySelectorAll('#assetsNav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.section === key));
}

function route() {
  const hash = location.hash || '#assets/overview';
  if (hash.startsWith('#property/')) {
    currentPropertyId = Number(hash.split('/')[1]);
    showView('property');
    loadPropertyDetail(currentPropertyId);
  } else if (hash.startsWith('#asset/')) {
    currentAssetId = Number(hash.split('/')[1]);
    showView('asset');
    loadAssetDetail(currentAssetId);
  } else if (['#spending', '#planning', '#tax'].includes(hash)) {
    showView(hash.slice(1));
  } else {
    // '#assets' or '#assets/<section>'
    const key = hash.split('/')[1] || 'overview';
    showView('assets');
    showSection(ASSET_SECTIONS.some((s) => s.key === key) ? key : 'overview');
    loadAssets();
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------- assets data ---
let assetsLoaded = false;

async function loadAssets(force = false) {
  if (assetsLoaded && !force) return;
  assetsLoaded = true;
  const [summary, properties, assets] = await Promise.all([
    api('/api/summary'), api('/api/properties'), api('/api/assets'),
  ]);

  // Overview: totals + per-category breakdown cards.
  $('#sumProperty').textContent = money(summary.propertyValue);
  $('#sumMortgage').textContent = money(summary.mortgageBalance);
  $('#sumOther').textContent = money(summary.otherAssets);
  const net = $('#sumNet');
  net.textContent = money(summary.netWorth);
  net.classList.toggle('negative', summary.netWorth < 0);
  const byCategory = {};
  for (const a of assets) {
    byCategory[a.category] = byCategory[a.category] || { count: 0, total: 0 };
    byCategory[a.category].count++;
    byCategory[a.category].total += Number(a.value || 0);
  }
  const breakdown = [
    { key: 'properties', label: 'Properties', value: summary.propertyValue, note: `${summary.propertyCount} ${summary.propertyCount === 1 ? 'property' : 'properties'} · mortgages ${money(summary.mortgageBalance)}` },
    ...ASSET_SECTIONS.filter((s) => s.category).map((s) => ({
      key: s.key, label: s.label,
      value: (byCategory[s.category] || { total: 0 }).total,
      note: `${(byCategory[s.category] || { count: 0 }).count} entries`,
    })),
  ];
  $('#breakdownCards').innerHTML = breakdown.map((b) => `
    <div class="card breakdown-card" onclick="location.hash='#assets/${b.key}'">
      <div class="k">${b.label}</div><div class="v">${money(b.value)}</div><div class="n">${esc(b.note)}</div>
    </div>`).join('');

  // Properties listing.
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
  }).join('') || '<div class="note">No properties yet — use “Add property” above.</div>';

  // One listing table per other-asset category.
  for (const s of ASSET_SECTIONS.filter((x) => x.category)) {
    const rows = assets.filter((a) => a.category === s.category);
    const subtotal = rows.reduce((sum, a) => sum + Number(a.value || 0), 0);
    const body = rows.map((a) => `<tr class="clickable" onclick="location.hash='#asset/${a.id}'">
      <td>${esc(a.name)}</td><td class="num">${money(a.value)}</td><td>${esc(a.currency)}</td>
      <td>${esc(a.notes || '')}</td>
      <td style="white-space:nowrap">
        <button class="small" onclick="event.stopPropagation(); openAssetModal(${a.id})">Edit</button>
        <button class="small danger" onclick="event.stopPropagation(); deleteAsset(${a.id})">Delete</button>
      </td></tr>`).join('');
    $('#section-' + s.key).innerHTML = `
      <div class="section-head"><h2>${s.label}</h2><span class="note" style="margin:0">Subtotal ${money(subtotal)}</span>
        <div class="spacer"></div>
        <button class="primary" onclick="openAssetModal(null, '${s.category}')">+ ${s.addLabel}</button></div>
      ${rows.length
        ? `<div class="panel" style="padding:6px 16px"><table><thead><tr><th>Name</th><th class="num">Value</th><th>Currency</th><th>Notes</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`
        : '<div class="note">No entries yet.</div>'}`;
  }
}

// ------------------------------------------------------------- asset modal ---
let assetModalCategory = 'other';

function openAssetModal(assetId, category) {
  const form = $('#assetForm');
  form.reset();
  $('#assetModalMsg').className = 'msg';
  if (assetId) {
    api('/api/assets/' + assetId).then((a) => {
      assetModalCategory = a.category;
      $('#assetModalTitle').textContent = 'Edit ' + (CATEGORY_LABELS[a.category] || 'asset').replace(/s$/, '').toLowerCase();
      form.elements.id.value = a.id;
      form.elements.categoryLabel.value = CATEGORY_LABELS[a.category] || a.category;
      form.elements.name.value = a.name || '';
      form.elements.value.value = a.value ?? '';
      form.elements.currency.value = a.currency || 'CAD';
      form.elements.notes.value = a.notes || '';
      openModal('assetModal');
    }).catch((e) => alert(e.message));
  } else {
    assetModalCategory = category || 'other';
    $('#assetModalTitle').textContent = 'Add ' + (CATEGORY_LABELS[assetModalCategory] || 'asset').replace(/s$/, '').toLowerCase();
    form.elements.id.value = '';
    form.elements.categoryLabel.value = CATEGORY_LABELS[assetModalCategory];
    form.elements.currency.value = 'CAD';
    openModal('assetModal');
  }
}
window.openAssetModal = openAssetModal;

$('#assetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const id = f.id;
  delete f.id;
  delete f.categoryLabel;
  try {
    if (id) await api('/api/assets/' + id, { method: 'PUT', body: f });
    else await api('/api/assets', { method: 'POST', body: { ...f, category: assetModalCategory } });
    closeModalEl($('#assetModal'));
    assetsLoaded = false;
    if (location.hash.startsWith('#asset/') && id) loadAssetDetail(Number(id));
    else loadAssets();
  } catch (err) { showMsg($('#assetModalMsg'), 'err', err.message); }
});

async function deleteAsset(id) {
  if (!confirm('Delete this asset?')) return;
  await api(`/api/assets/${id}`, { method: 'DELETE' });
  assetsLoaded = false;
  if (location.hash.startsWith('#asset/')) location.hash = '#assets/overview';
  else loadAssets();
}
window.deleteAsset = deleteAsset;

// ------------------------------------------------------------ asset detail ---
async function loadAssetDetail(id) {
  let a;
  try { a = await api('/api/assets/' + id); }
  catch { $('#assetDetailTitle').textContent = 'Asset not found'; $('#assetDetailBody').innerHTML = ''; return; }
  currentAssetId = a.id;
  const section = SECTION_OF_CATEGORY[a.category] || 'overview';
  $('#assetBackLink').href = '#assets/' + section;
  $('#assetBackLink').textContent = '← Back to ' + (CATEGORY_LABELS[a.category] || 'Assets');
  $('#assetDetailTitle').textContent = a.name;
  const fmtDate = (t) => (t ? new Date(t).toLocaleString('en-CA') : '—');
  const rows = [
    ['Category', CATEGORY_LABELS[a.category] || a.category],
    ['Value', money(a.value)],
    ['Currency', a.currency],
    ['Notes', a.notes || '—'],
    ['Created', fmtDate(a.created_at)],
    ['Last updated', fmtDate(a.updated_at)],
  ];
  $('#assetDetailBody').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
  $('#editAssetBtn').onclick = () => openAssetModal(a.id);
  $('#deleteAssetBtn').onclick = async () => {
    if (!confirm('Delete this asset?')) return;
    await api('/api/assets/' + a.id, { method: 'DELETE' });
    assetsLoaded = false;
    location.hash = '#assets/' + section;
  };
}

// ---------------------------------------------------------- property modal ---
$('#addPropertyBtn').addEventListener('click', () => openModal('propertyModal'));

$('#addPropForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  if (addSuggest.state.id) f.bca_id = addSuggest.state.id;
  const msg = $('#addPropMsg');
  try {
    const p = await api('/api/properties', { method: 'POST', body: f });
    e.target.reset();
    addSuggest.reset();
    closeModalEl($('#propertyModal'));
    // Best-effort automatic BC Assessment fetch right after adding.
    const r = await api(`/api/properties/${p.id}/fetch-bca`, { method: 'POST' });
    const note = r.ok
      ? `Property added. BC Assessment value fetched: ${money(r.result.assessedValue)} (${r.result.assessedYear || 'current'}), matched "${r.result.matchedAddress}".`
      : `Property added. Automatic BC Assessment fetch did not succeed (${r.error}). You can enter the value manually on the detail page, or retry the fetch there.`;
    assetsLoaded = false;
    if (location.hash === '#assets/properties') loadAssets();
    else location.hash = '#assets/properties';
    showMsg($('#sectionMsg'), r.ok ? 'ok' : 'warn', note);
  } catch (err) { showMsg(msg, 'err', err.message); }
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
  propSuggest.state.id = p.bca_id || null;
  propSuggest.state.label = p.address || '';
  propSuggest.close();
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
  assetsLoaded = false;
  loadPropertyDetail(currentPropertyId);
}
window.deleteSegment = deleteSegment;

$('#propForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  f.bca_id = propSuggest.state.id || null;
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    assetsLoaded = false;
    showMsg($('#detailMsg'), 'ok', 'Saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#mortgageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    assetsLoaded = false;
    showMsg($('#detailMsg'), 'ok', 'Mortgage saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#addSegmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    await api(`/api/properties/${currentPropertyId}/rates`, { method: 'POST', body: f });
    assetsLoaded = false;
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
      assetsLoaded = false;
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
  assetsLoaded = false;
  location.hash = '#assets/properties';
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
