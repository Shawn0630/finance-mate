// Finance Mate — frontend (plain JS, no build step).
const $ = (sel, el = document) => el.querySelector(sel);
const money = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// --------------------------------------------------------- money inputs --
// Every money field in the app is a text input marked data-money. What
// the user sees is grouped with thousands separators ("1,350,000");
// what leaves the browser is a plain number again (parseMoneyInput),
// so the API, the stored data and the server's validation are exactly
// as they were when these were <input type="number">. The pair is
// shared by every form — add/edit property, mortgage, value-history
// points and other assets.
function formatMoneyInput(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).replace(/[$,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return String(v); // not a plain number: leave the text untouched
  const grouped = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return m[1] + grouped + (m[3] !== undefined ? '.' + m[3] : '');
}

function parseMoneyInput(s) {
  if (s === null || s === undefined) return '';
  const cleaned = String(s).replace(/[$,\s]/g, '');
  if (cleaned === '') return '';
  // Anything that is not a plain number parses back to '' — exactly
  // what a number input reported for unparseable text — so the
  // server's existing validation, not this formatter, decides what
  // counts as an error.
  return /^-?\d+(\.\d*)?$/.test(cleaned) ? Number(cleaned) : '';
}

// Convert the named fields of a FormData-built object back to numbers
// (or '' when blank) just before it is sent.
function parseMoneyFields(f, names) {
  for (const n of names) if (n in f) f[n] = parseMoneyInput(f[n]);
  return f;
}

// Prefill an edit form's money field with the grouped figure.
function setMoneyValue(input, v) {
  if (input) input.value = formatMoneyInput(v);
}

// Live grouping while typing: reformat the integer part on every input
// event and keep the caret after the same digit it followed before, so
// typing "1350000" turns into "1,350,000" without the caret jumping.
function wireMoneyInput(input) {
  input.addEventListener('input', () => {
    const raw = input.value;
    const formatted = formatMoneyInput(raw);
    if (formatted === raw) return;
    const before = raw.slice(0, input.selectionStart ?? raw.length);
    const sigBefore = (before.match(/[\d.]/g) || []).length;
    input.value = formatted;
    let pos = sigBefore === 0 ? 0 : formatted.length;
    if (sigBefore > 0) {
      let seen = 0;
      for (let i = 0; i < formatted.length; i++) {
        if (/[\d.]/.test(formatted[i])) { seen++; if (seen >= sigBefore) { pos = i + 1; break; } }
      }
    }
    try { input.setSelectionRange(pos, pos); } catch { /* not a text caret */ }
  });
  input.addEventListener('blur', () => { input.value = formatMoneyInput(input.value); });
}
document.querySelectorAll('input[data-money]').forEach(wireMoneyInput);

// Chart amount axes read in grouped figures too, not bare numbers.
const moneyTick = (v) => Number(v).toLocaleString('en-CA');

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
  // Small "suggestions unavailable" note under the input (markup lives in
  // the form, next to the dropdown list). Shown whenever the suggest
  // endpoint reports its source is down, so an empty dropdown never reads
  // as "no such address" when BC Assessment is actually failing.
  const wrap = input.closest ? input.closest('.suggest-wrap') : null;
  const note = wrap ? wrap.querySelector('.suggest-note') : null;
  const showNote = () => { if (note) note.classList.remove('hidden'); };
  const hideNote = () => { if (note) note.classList.add('hidden'); };

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
    hideNote();
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
        if (data.sourceError) showNote(); else hideNote();
        items = data.suggestions || [];
        active = items.length ? 0 : -1;
        render();
      } catch { if (my === seq) { showNote(); close(); } }
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
  return { state, close, reset() { state.id = null; state.label = ''; hideNote(); close(); } };
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
  for (const v of ['assets', 'property', 'asset', 'spending', 'planning', 'tax', 'admin']) {
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
  } else if (hash === '#admin') {
    showView('admin');
    loadAdmin();
  } else if (['#spending', '#planning', '#tax'].includes(hash)) {
    showView(hash.slice(1));
  } else {
    // '#assets' or '#assets/<section>'
    const key = hash.split('/')[1] || 'overview';
    showView('assets');
    showSection(ASSET_SECTIONS.some((s) => s.key === key) ? key : 'overview');
    loadAssets();
    // Portfolio charts created while the section was hidden have a
    // zero-size canvas; redraw them once it is actually on screen.
    if (key === 'properties') requestAnimationFrame(redrawPortfolioIfCollapsed);
  }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- owners ---
// Owners are a SET of people: joint ownership is picking several names —
// there is no 'Joint' option. Candidates come from /api/users (every user
// except admin). The picker shows the selected people as removable chips
// and the remaining candidates as "+ Name" buttons; a name that is
// already picked leaves the candidate row, so it cannot be added twice.
let ownerUsers = [];
let ownerDirectory = {}; // username -> { username, avatarFile, avatarColor }
async function loadOwnerUsers() {
  try {
    const list = await api('/api/users');
    ownerUsers = (list || []).map((u) => u.username);
    ownerDirectory = Object.fromEntries((list || []).map((u) => [u.username, u]));
  } catch { ownerUsers = []; ownerDirectory = {}; }
}

// --------------------------------------------------------------- avatars ---
// A user's avatar: their uploaded photo when there is one, otherwise a
// letter avatar (initial on their stored color). Avatar data always
// comes from the users table (via /api/users, /api/me, /api/admin/users)
// — property and asset records never carry a copy, so an avatar change
// in Admin shows up everywhere on the next load.
function avatarHtml(u, cls = '') {
  const name = (u && u.username) || '?';
  if (u && u.avatarFile) return `<img class="avatar ${cls}" src="/avatars/${esc(u.avatarFile)}" alt="">`;
  const color = (u && u.avatarColor) || '#607d8b';
  return `<span class="avatar avatar-letter ${cls}" style="background:${esc(color)}">${esc(name.charAt(0).toUpperCase())}</span>`;
}
function avatarForName(name, cls = 'xs') {
  return avatarHtml(ownerDirectory[name] || { username: name }, cls);
}

function ownerChipsHtml(owners) {
  return (owners || []).map((u) => `<span class="owner-chip">${avatarForName(u)} ${esc(u)}</span>`).join(' ');
}

function createOwnerPicker(root) {
  if (!root) return { get: () => [], set() {}, refresh() {} };
  let selected = [];
  function render() {
    root.querySelector('.owner-chips').innerHTML = selected.length
      ? selected.map((u) => `<span class="owner-chip">${avatarForName(u)} ${esc(u)}<button type="button" class="owner-x" data-owner-remove="${esc(u)}" title="Remove ${esc(u)}">&times;</button></span>`).join('')
      : '<span class="owner-none">No owner selected</span>';
    root.querySelector('.owner-candidates').innerHTML = ownerUsers
      .filter((u) => !selected.includes(u))
      .map((u) => `<button type="button" class="owner-candidate" data-owner-add="${esc(u)}">+ ${esc(u)}</button>`)
      .join('');
  }
  root.addEventListener('click', (e) => {
    const add = e.target.closest('[data-owner-add]');
    const rem = e.target.closest('[data-owner-remove]');
    if (add) {
      const name = add.getAttribute('data-owner-add');
      if (name && !selected.includes(name)) selected.push(name);
      render();
    } else if (rem) {
      selected = selected.filter((u) => u !== rem.getAttribute('data-owner-remove'));
      render();
    }
  });
  render();
  return {
    get: () => [...selected],
    set(values) { selected = [...(values || [])]; render(); },
    refresh: render,
  };
}
const addPropOwnerPicker = createOwnerPicker($('#addPropOwnerPicker'));
const propOwnerPicker = createOwnerPicker($('#propOwnerPicker'));
const assetOwnerPicker = createOwnerPicker($('#assetOwnerPicker'));
const ownerPickers = [addPropOwnerPicker, propOwnerPicker, assetOwnerPicker];

// ------------------------------------------------------------- assets data ---
let assetsLoaded = false;

// Every mutation of property/asset data (add/edit, rate segments,
// value-history points, payment schedule, BC Assessment fetch,
// HouseSigma pull, prime refresh) must call this: the assets views
// are cached after their first load, and without the dirty mark a
// user who edits on the detail page comes back to totals and charts
// that predate the edit until a manual reload.
function markAssetsDirty() { assetsLoaded = false; }

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
    { key: 'properties', label: 'Properties', value: summary.propertyValue, note: `${summary.propertyCount} ${summary.propertyCount === 1 ? 'property' : 'properties'} · principal ${money(summary.mortgageBalance)}` },
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
    const photo = p.photos && p.photos.length
      ? `<img src="${esc(p.photos[0].src)}" alt="">`
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
        <div class="kv"><span class="k">Outstanding principal</span><span>${money(p.mortgage_balance)}</span></div>
        <div class="kv"><span class="k">Current rate</span><span>${rate}</span></div>
        ${p.owners && p.owners.length ? `<div class="kv"><span class="k">Owners</span><span>${ownerChipsHtml(p.owners)}</span></div>` : ''}
        <div class="toolbar"><button onclick="location.hash='#property/${p.id}'">Details</button></div>
      </div></div>`;
  }).join('') || '<div class="note">No properties yet — use “Add property” above.</div>';
  await loadPortfolio();

  // One listing table per other-asset category.
  for (const s of ASSET_SECTIONS.filter((x) => x.category)) {
    const rows = assets.filter((a) => a.category === s.category);
    const subtotal = rows.reduce((sum, a) => sum + Number(a.value || 0), 0);
    const body = rows.map((a) => `<tr class="clickable" onclick="location.hash='#asset/${a.id}'">
      <td>${esc(a.name)}</td><td class="num">${money(a.value)}</td><td>${esc(a.currency)}</td>
      <td>${ownerChipsHtml(a.owners)}</td>
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
        ? `<div class="panel" style="padding:6px 16px"><table><thead><tr><th>Name</th><th class="num">Value</th><th>Currency</th><th>Owners</th><th>Notes</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`
        : '<div class="note">No entries yet.</div>'}`;
  }
}

// ------------------------------------------------------------- asset modal ---
let assetModalCategory = 'other';

function openAssetModal(assetId, category) {
  const form = $('#assetForm');
  form.reset();
  assetOwnerPicker.set([]);
  $('#assetModalMsg').className = 'msg';
  if (assetId) {
    api('/api/assets/' + assetId).then((a) => {
      assetModalCategory = a.category;
      $('#assetModalTitle').textContent = 'Edit ' + (CATEGORY_LABELS[a.category] || 'asset').replace(/s$/, '').toLowerCase();
      form.elements.id.value = a.id;
      form.elements.categoryLabel.value = CATEGORY_LABELS[a.category] || a.category;
      form.elements.name.value = a.name || '';
      setMoneyValue(form.elements.value, a.value);
      form.elements.currency.value = a.currency || 'CAD';
      form.elements.notes.value = a.notes || '';
      assetOwnerPicker.set(a.owners || []);
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
  parseMoneyFields(f, ['value']);
  const id = f.id;
  delete f.id;
  delete f.categoryLabel;
  f.owners = assetOwnerPicker.get();
  try {
    if (id) await api('/api/assets/' + id, { method: 'PUT', body: f });
    else await api('/api/assets', { method: 'POST', body: { ...f, category: assetModalCategory } });
    closeModalEl($('#assetModal'));
    markAssetsDirty();
    if (location.hash.startsWith('#asset/') && id) loadAssetDetail(Number(id));
    else loadAssets();
  } catch (err) { showMsg($('#assetModalMsg'), 'err', err.message); }
});

async function deleteAsset(id) {
  if (!confirm('Delete this asset?')) return;
  await api(`/api/assets/${id}`, { method: 'DELETE' });
  markAssetsDirty();
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
    ['Owners', a.owners && a.owners.length ? ownerChipsHtml(a.owners) : '—', true],
    ['Notes', a.notes || '—'],
    ['Created', fmtDate(a.created_at)],
    ['Last updated', fmtDate(a.updated_at)],
  ];
  $('#assetDetailBody').innerHTML = rows.map(([k, v, raw]) => `<tr><td>${k}</td><td>${raw ? v : esc(v)}</td></tr>`).join('');
  $('#editAssetBtn').onclick = () => openAssetModal(a.id);
  $('#deleteAssetBtn').onclick = async () => {
    if (!confirm('Delete this asset?')) return;
    await api('/api/assets/' + a.id, { method: 'DELETE' });
    markAssetsDirty();
    location.hash = '#assets/' + section;
  };
}

// ---------------------------------------------------------- property modal ---
$('#addPropertyBtn').addEventListener('click', () => {
  addPropOwnerPicker.refresh();
  openModal('propertyModal');
});

$('#addPropForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['mortgage_balance']);
  if (addSuggest.state.id) f.bca_id = addSuggest.state.id;
  f.owners = addPropOwnerPicker.get();
  const msg = $('#addPropMsg');
  try {
    const p = await api('/api/properties', { method: 'POST', body: f });
    e.target.reset();
    addPropOwnerPicker.set([]);
    addSuggest.reset();
    closeModalEl($('#propertyModal'));
    // Best-effort automatic BC Assessment fetch right after adding.
    const r = await api(`/api/properties/${p.id}/fetch-bca`, { method: 'POST' });
    const note = r.ok
      ? `Property added. BC Assessment value fetched: ${money(r.result.assessedValue)} (${r.result.assessedYear || 'current'}), matched "${r.result.matchedAddress}".`
      : `Property added. Automatic BC Assessment fetch did not succeed (${r.error}). You can enter the value manually on the detail page, or retry the fetch there.`;
    markAssetsDirty();
    if (location.hash === '#assets/properties') loadAssets();
    else location.hash = '#assets/properties';
    showMsg($('#sectionMsg'), r.ok ? 'ok' : 'warn', note);
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// ---------------------------------------------------------- property detail ---
// --------------------------------------------------------------- portfolio --
// Cross-property block on the Properties section: totals, a share
// pie, and a combined chart (assessed history points + total
// outstanding line + stacked per-property outstanding bars), all
// from GET /api/properties/portfolio — the server aggregates, the
// page only renders.
let portfolioData = null;
let portfolioPieChart = null;
let portfolioLineChart = null;
let pfRangeMonths = 60;
let pfPieMetric = 'outstanding';
const PF_COLORS = ['#1668c4', '#e67e22', '#8e44ad', '#2e7d4f', '#c0392b', '#16a085', '#b7950b', '#7d3c98', '#2e86c1', '#ba4a00'];
window.__fmCharts = window.__fmCharts || {};
window.__fmCharts.pie = null;
window.__fmCharts.portfolio = null;

// Stale-prime warning (amber): shown when projections were
// computed with the last known prime because today's fetch failed.
function renderPrimeWarning(el, status) {
  if (!el) return;
  if (status && status.rate != null && status.fresh === false) {
    el.textContent = `Couldn't reach the Bank of Canada — projections below use the last known prime of ${Number(status.rate).toFixed(2)}% from ${status.asOf || 'an earlier date'}.`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

async function loadPortfolio() {
  const block = $('#portfolioBlock');
  portfolioData = await api('/api/properties/portfolio');
  renderPrimeWarning($('#pfPrimeWarning'), portfolioData && portfolioData.prime);
  if (!portfolioData || !portfolioData.totals.propertyCount) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  const t = portfolioData.totals;
  $('#pfOutstanding').textContent = money(t.outstanding);
  $('#pfPayment').textContent = money(t.monthlyPayment);
  $('#pfInterest').textContent = money(t.totalInterest);
  $('#pfInterestNote').textContent = t.interestFrom < t.propertyCount
    ? `based on ${t.interestFrom} of ${t.propertyCount} properties`
    : `based on all ${t.propertyCount} properties`;
  const notes = [
    'Assessed totals carry each property’s most recent value forward — a property counts from its first known year.',
    'Outstanding bars stack up to the blue total line; a property joins the projection at its own balance date.',
  ];
  // Say exactly which properties are missing from the projection and
  // why — a rate plan alone does not project: without a payment (and
  // no amortization to derive one from) there is nothing to simulate.
  const propNoun = t.propertyCount === 1 ? 'property' : 'properties';
  if (t.noPlanCount > 0) {
    notes.push(`${t.noPlanCount} of ${t.propertyCount} ${propNoun} ${t.noPlanCount === 1 ? 'has' : 'have'} no rate plan — add rate segments on the property page to include ${t.noPlanCount === 1 ? 'it' : 'them'} in the projection.`);
  }
  if (t.planNoPaymentCount > 0) {
    notes.push(`${t.planNoPaymentCount} of ${t.propertyCount} ${propNoun} ${t.planNoPaymentCount === 1 ? 'has' : 'have'} a rate plan but no projection — add a monthly payment or remaining amortization to project.`);
  }
  if (t.planNoPrimeCount > 0) {
    notes.push(`${t.planNoPrimeCount} of ${t.propertyCount} ${propNoun} ${t.planNoPrimeCount === 1 ? 'is' : 'are'} priced off the prime rate, which is not on record yet — the projection starts once prime has been fetched.`);
  }
  if (t.paymentKnownCount < t.propertyCount) {
    notes.push(`Monthly payment counts ${t.paymentKnownCount} of ${t.propertyCount} properties — the rest have no payment on file and count as $0.`);
  }
  if (portfolioData.assessmentRefresh && portfolioData.assessmentRefresh.staleIds.length) {
    notes.push('One or more assessed values could not be refreshed from BC Assessment just now — showing the last known values.');
  }
  $('#pfNotes').textContent = notes.join(' ');
  drawPortfolioPie();
  drawPortfolioChart();
}

function pfRangeRows() {
  const rows = portfolioData ? portfolioData.outstandingByMonth : [];
  const win = lookbackWindow(pfRangeMonths);
  if (!win) return rows;
  return rows.filter((m) => {
    const x = ymDecimal(m.month);
    return x >= win.min && x <= win.max;
  });
}

function redrawPortfolioIfCollapsed() {
  if (!portfolioData || !portfolioData.totals.propertyCount) return;
  const collapsed = (c) => !c || !c.width;
  if (!collapsed(portfolioPieChart) && !collapsed(portfolioLineChart)) return;
  drawPortfolioPie();
  drawPortfolioChart();
}

function drawPortfolioPie() {
  const ctx = $('#portfolioPie');
  if (!ctx || !portfolioData) return;
  if (portfolioPieChart) { portfolioPieChart.destroy(); portfolioPieChart = null; }
  window.__fmCharts.pie = null;
  const slices = portfolioData.pie[pfPieMetric] || [];
  if (!slices.length) return;
  const colorOf = (id) => PF_COLORS[portfolioData.properties.findIndex((x) => x.id === id) % PF_COLORS.length];
  portfolioPieChart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: slices.map((s) => s.shortLabel),
      datasets: [{
        data: slices.map((s) => s.value),
        backgroundColor: slices.map((s) => colorOf(s.id)),
        borderColor: '#fff', borderWidth: 1,
        hoverOffset: 10,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      // Entrance: slices sweep/scale in once; redraws on new data
      // transition the same way. Nothing loops.
      animation: { animateRotate: true, animateScale: true, duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (item) => {
              const s = slices[item.dataIndex];
              return ` ${s.shortLabel}: ${money(s.value)} (${s.pct}%)`;
            },
          },
        },
      },
    },
  });
  window.__fmCharts.pie = portfolioPieChart;
}

// Vertical guide line at the hovered time point (Chart.js plugin
// API only — no extra library). Shared by the portfolio chart and
// the detail page's combined chart.
const guideLinePlugin = {
  id: 'guideLine',
  afterDatasetsDraw(chart) {
    const active = chart.getActiveElements();
    if (!active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const c = chart.ctx;
    c.save();
    c.beginPath();
    c.moveTo(x, top);
    c.lineTo(x, bottom);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(90, 106, 122, 0.45)';
    c.setLineDash([4, 4]);
    c.stroke();
    c.restore();
  },
};

function drawPortfolioChart() {
  const ctx = $('#portfolioChart');
  if (!ctx || !portfolioData) return;
  if (portfolioLineChart) { portfolioLineChart.destroy(); portfolioLineChart = null; }
  window.__fmCharts.portfolio = null;
  const rows = pfRangeRows();
  const datasets = [];
  // Same look-back window as the detail page (All = every year on
  // record). The portfolio points are a carry-forward total, so inside
  // a look-back window the latest pre-window total is carried in as a
  // point at the left edge and the last shown total is carried forward
  // to a point at today: the points span the whole window instead of
  // starting late or stopping at the last assessment year.
  const assessedAll = [...(portfolioData.assessedByYear || [])].sort((a, b) => a.year - b.year);
  const assessedShown = lookbackHistory(assessedAll, pfRangeMonths);
  let assessedData = assessedShown.map((y) => ({ x: y.year, y: y.total }));
  const pfLook = lookbackWindow(pfRangeMonths);
  if (pfLook) {
    const prior = assessedAll.filter((y) => y.year < pfLook.min).pop();
    if (prior && !assessedData.some((p) => Math.abs(p.x - pfLook.min) < 1e-9)) {
      assessedData = [{ x: pfLook.min, y: prior.total }, ...assessedData];
      if (!assessedShown.length) assessedData.push({ x: pfLook.max, y: prior.total });
    }
    if (assessedData.length && assessedData[assessedData.length - 1].x < pfLook.max) {
      assessedData.push({ x: pfLook.max, y: assessedData[assessedData.length - 1].y });
    }
  }
  if (assessedData.length) {
    datasets.push({
      type: 'line',
      label: 'Assessed value (all properties)',
      data: assessedData,
      borderColor: '#2e7d4f', backgroundColor: '#2e7d4f',
      // One point per assessment year, joined by straight line
      // segments (tension 0 — no smoothing curve, no step).
      showLine: true, tension: 0, pointRadius: 5, pointHoverRadius: 7,
    });
  }
  if (rows.length) {
    datasets.push({
      type: 'line',
      label: 'Total outstanding principal',
      data: rows.map((m) => ({ x: ymDecimal(m.month), y: m.total })),
      borderColor: '#1668c4', backgroundColor: '#1668c4',
      tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
    });
    portfolioData.properties.forEach((p, i) => {
      datasets.push({
        type: 'bar',
        label: p.shortLabel,
        data: rows.map((m) => ({ x: ymDecimal(m.month), y: m.byProperty[p.id] ?? null })),
        backgroundColor: PF_COLORS[i % PF_COLORS.length],
        stack: 'outstanding',
        maxBarThickness: 16,
      });
    });
  }
  if (!datasets.length) return;
  // Same explicit axis window as the detail page's combined chart:
  // exactly the selected range, never the library auto-fit.
  const allRows = portfolioData.outstandingByMonth || [];
  const pfWin = mixedAxisWindow({
    months: pfRangeMonths,
    assessedYears: assessedAll.map((y) => y.year),
    projStart: allRows.length ? ymDecimal(allRows[0].month) : null,
    projLastX: allRows.length ? ymDecimal(allRows[allRows.length - 1].month) : null,
  });
  // Largest value the y axis must reach: the biggest assessed total
  // drawn and the biggest stacked outstanding total in the window.
  let pfMax = 0;
  for (const p of assessedData) if (p.y > pfMax) pfMax = p.y;
  for (const m of rows) if (m.total > pfMax) pfMax = m.total;
  portfolioLineChart = new Chart(ctx, {
    data: { datasets },
    plugins: [guideLinePlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      // Hover one time point: every monthly series shares the same x
      // values, so 'index' groups them; the filter keeps only items
      // at that exact x (the yearly assessed points land in January,
      // where a point can share the same x) and drops not-yet-started
      // properties. Default Chart.js transitions animate the rest —
      // point hover radii, tooltip follow, range-switch redraws.
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          filter: (item, _idx, items) => {
            if (item.parsed.y == null) return false;
            const ref = items.find((i) => i.parsed.y != null);
            return Math.abs(item.parsed.x - ref.parsed.x) < 0.001;
          },
          callbacks: {
            title: (items) => formatYearTick(items[0].parsed.x),
            label: (item) => ` ${item.dataset.label}: ${money(item.parsed.y)}`,
            footer: (items) => {
              const bars = items.filter((i) => i.dataset.stack === 'outstanding');
              if (!bars.length) return '';
              const total = bars.reduce((s, i) => s + (i.parsed.y || 0), 0);
              return `Total outstanding: ${money(total)}`;
            },
          },
        },
      },
      scales: {
        x: { type: 'linear', ...(pfWin || {}), ticks: { ...(pfWin ? yearAxisTicks(pfWin.min, pfWin.max) : {}), callback: formatYearTick } },
        // The amount axis always starts at 0 (a truncated axis made
        // the values look wildly larger than they are) and tops out
        // just above the largest value drawn. The per-property bars
        // stack via their dataset `stack` group — the axis itself is
        // NOT `stacked`, so the two lines are never stacked.
        y: {
          min: 0,
          ...(pfMax > 0 ? { max: pfMax * 1.05 } : {}),
          ticks: { callback: moneyTick }, title: { display: true, text: 'Amount ($)' },
        },
      },
    },
  });
  window.__fmCharts.portfolio = portfolioLineChart;
}

$('#pfRangeBtns').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-months]');
  if (!btn) return;
  $('#pfRangeBtns').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  pfRangeMonths = Number(btn.dataset.months);
  // Re-fetch the portfolio (fresh projections at the latest prime
  // history) rather than re-clipping the payload already loaded.
  loadPortfolio();
});
$('#pfPieOutstandingBtn').addEventListener('click', () => { pfPieMetric = 'outstanding'; drawPortfolioPie(); });
$('#pfPieAssessedBtn').addEventListener('click', () => { pfPieMetric = 'assessed'; drawPortfolioPie(); });

let chartA = null; // merged detail chart: assessed + outstanding lines, interest/principal bars
let fullSeries = [];
let chartMeta = null;
let chartBarsBasis = null; // 'monthly' | 'yearly' | null — set by drawCombinedChart
let scheduleYear = null; // the monthly schedule's open year page; null = automatic
let amortError = null; // last non-ok amortization response ({ error, code })
let detailProperty = null;
let equityData = null;
// Test/debug hook: lets the screenshot script read the live chart configs.
window.__fmCharts = Object.assign(window.__fmCharts || {}, { a: null, b: null });

// ------------------------------------------------------------ photos ---
// The detail page's gallery: a carousel over the property's photos
// (uploads, plus a legacy external URL entry when one is still on the
// record). Clicking the photo area — or "Add photos" — opens the file
// picker; uploads append to the gallery. Any photo can be removed;
// the first photo is the Properties card cover.
let photoIndex = 0;

function renderPhotos(p) {
  const photos = (p && p.photos) || [];
  if (photoIndex >= photos.length) photoIndex = Math.max(0, photos.length - 1);
  if (photoIndex < 0) photoIndex = 0;
  const area = $('#photoArea');
  if (!photos.length) {
    area.innerHTML = '<div class="detail-photo-empty photo-clickable" data-photo-add>No photos yet — click to add photos</div>';
    return;
  }
  const cur = photos[photoIndex];
  area.innerHTML = `<div class="photo-carousel">
      <img class="detail-photo photo-clickable" data-photo-add src="${esc(cur.src)}" alt="">
      ${photos.length > 1 ? `
        <button type="button" class="carousel-nav prev" data-photo-nav="-1" aria-label="Previous photo">&#8249;</button>
        <button type="button" class="carousel-nav next" data-photo-nav="1" aria-label="Next photo">&#8250;</button>
        <div class="photo-thumbs">${photos.map((ph, i) => `<button type="button" class="thumb${i === photoIndex ? ' active' : ''}" data-photo-dot="${i}" aria-label="Photo ${i + 1}"><img src="${esc(ph.src)}" alt=""></button>`).join('')}</div>` : ''}
      <div class="carousel-bar">
        <span class="carousel-count">${photoIndex + 1} / ${photos.length}</span>
        <span style="flex:1"></span>
        <button type="button" class="small" data-photo-add-btn>Add photos</button>
        <button type="button" class="small danger" data-photo-remove>Remove this photo</button>
      </div>
    </div>`;
}

function stepPhoto(delta) {
  const photos = (detailProperty && detailProperty.photos) || [];
  if (photos.length < 2) return;
  photoIndex = (photoIndex + delta + photos.length) % photos.length;
  renderPhotos(detailProperty);
}

async function removeCurrentPhoto() {
  const photos = (detailProperty && detailProperty.photos) || [];
  const cur = photos[photoIndex];
  if (!cur) return;
  if (!confirm('Remove this photo from the gallery?')) return;
  try {
    const updated = await api(`/api/properties/${currentPropertyId}/photos/${cur.id}`, { method: 'DELETE' });
    detailProperty = updated;
    renderPhotos(updated);
    markAssetsDirty(); // the card cover may have been this photo
    showMsg($('#detailMsg'), 'ok', 'Photo removed.');
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
}

$('#photoArea').addEventListener('click', (e) => {
  const nav = e.target.closest('[data-photo-nav]');
  if (nav) { stepPhoto(Number(nav.dataset.photoNav)); return; }
  const dot = e.target.closest('[data-photo-dot]');
  if (dot) { photoIndex = Number(dot.dataset.photoDot); renderPhotos(detailProperty); return; }
  if (e.target.closest('[data-photo-remove]')) { removeCurrentPhoto(); return; }
  if (e.target.closest('[data-photo-add-btn]') || e.target.closest('[data-photo-add]')) {
    $('#photoFiles').click();
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

$('#photoFiles').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const msg = $('#detailMsg');
  showMsg(msg, 'ok', `Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
  try {
    const images = [];
    for (const file of files) images.push({ dataBase64: await fileToBase64(file), contentType: file.type });
    const firstNew = ((detailProperty && detailProperty.photos) || []).filter((x) => x.kind === 'upload').length;
    const updated = await api(`/api/properties/${currentPropertyId}/photos`, { method: 'POST', body: { images } });
    detailProperty = updated;
    photoIndex = Math.min(firstNew, (updated.photos || []).length - 1);
    renderPhotos(updated);
    markAssetsDirty(); // the first photo is the card cover
    showMsg(msg, 'ok', `Photo${files.length === 1 ? '' : 's'} added.`);
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// ------------------------------------------- property panel view/edit ---
// The Property Details panel is read-only metadata until Edit is
// clicked; Edit swaps in the form, Save/Cancel swap back. The form is
// (re)filled from the loaded property on every load and every Edit, so
// a cancelled edit never lingers in the inputs.
function renderPropView(p) {
  const rows = [
    ['Address', p.address || '—'],
    ['Owners', p.owners && p.owners.length ? ownerChipsHtml(p.owners) : '—', true],
    ['Notes', p.notes || '—'],
    ['Assessed value', p.assessed_value != null ? money(p.assessed_value) : '—'],
    ['Assessment year', p.assessed_year ?? '—'],
    ['Purchase date', p.purchase_date || '—'],
  ];
  // The lender (bank) is a mortgage fact; it joins the read-only
  // metadata only when one is on file.
  if (p.lender) rows.push(['Lender', p.lender]);
  $('#propViewBody').innerHTML = rows.map(([k, v, raw]) => `<tr><td>${k}</td><td>${raw ? v : esc(v)}</td></tr>`).join('');
}

function fillPropForm(p) {
  const pf = $('#propForm');
  pf.address.value = p.address || '';
  propSuggest.state.id = p.bca_id || null;
  propSuggest.state.label = p.address || '';
  propSuggest.close();
  pf.notes.value = p.notes || '';
  propOwnerPicker.set(p.owners || []);
  setMoneyValue(pf.assessed_value, p.assessed_value);
  pf.assessed_year.value = p.assessed_year ?? '';
  pf.purchase_date.value = p.purchase_date || '';
}

function setPropEditing(on) {
  $('#propView').classList.toggle('hidden', on);
  $('#propForm').classList.toggle('hidden', !on);
  // The Edit button lives in the panel head now; it steps aside
  // while the form is open (the form has its own Save/Cancel).
  $('#editPropBtn').classList.toggle('hidden', on);
}

// The projection section's two edit surfaces open as modals.
$('#openMortgageBtn').addEventListener('click', () => openModal('mortgageModal'));
$('#openHistoryBtn').addEventListener('click', () => openModal('historyModal'));

$('#editPropBtn').addEventListener('click', () => {
  if (!detailProperty) return;
  fillPropForm(detailProperty);
  setPropEditing(true);
});

$('#cancelPropEditBtn').addEventListener('click', () => {
  if (detailProperty) fillPropForm(detailProperty); // discard the edits
  setPropEditing(false);
});

async function loadPropertyDetail(id) {
  const p = await api(`/api/properties/${id}`);
  detailProperty = p;
  photoIndex = 0;
  renderPhotos(p);
  renderPropView(p);
  fillPropForm(p);
  setPropEditing(false);
  $('#paymentDayInput').value = p.payment_day ?? '';
  const freqKey = FREQUENCY_LABELS[p.payment_frequency] ? p.payment_frequency : 'monthly';
  $('#paymentFrequencySelect').value = freqKey;
  syncFrequencyUi();
  const dayBit = DAY_STEPPED_FREQUENCIES.includes(freqKey)
    ? 'Payment day does not apply to this frequency.'
    : (p.payment_day ? `Payment day: the ${ordinal(p.payment_day)} of each month.` : 'Payment day: not set.');
  $('#paymentDayDisplay').textContent =
    `Payment frequency: ${FREQUENCY_LABELS[freqKey]}. ${dayBit} Both are managed in “Mortgage Terms & Rates”.`;
  $('#regionDisplay').textContent = `Region: ${p.region === 'CA' || !p.region ? 'Canada (CA)' : esc(p.region)}.`;
  // The Source line reads the same in the read-only view and in the
  // edit form (the manual-marking note applies once you are editing).
  let metaText =
    p.assessed_source === 'auto'
      ? `Source: BC Assessment (auto-fetched${p.assessed_fetched_at ? ' ' + new Date(p.assessed_fetched_at).toLocaleString('en-CA') : ''}${p.bca_matched_address ? ', matched "' + p.bca_matched_address + '"' : ''}${p.land_value != null ? `, land ${money(p.land_value)} + building ${money(p.building_value)}` : ''}). Editing the value marks it as manual.`
      : p.assessed_source === 'manual'
        ? 'Source: entered manually. Use "Fetch from BC Assessment" to replace it with the official assessed value.'
        : 'No assessed value yet.';
  // A failed auto-refresh leaves the stored value in place; say so
  // quietly next to it rather than letting it look current.
  if (p.assessmentRefresh && p.assessmentRefresh.stale) {
    metaText += ` The latest automatic check against BC Assessment failed (${p.assessmentRefresh.error || 'unknown error'}) — showing the last known value.`;
  }
  $('#assessmentMeta').textContent = metaText;
  $('#assessmentMetaView').textContent = metaText;
  const hsNote = $('#hsPullNote');
  if (hsNote) {
    hsNote.textContent = p.houseSigma && p.houseSigma.attempted
      ? (p.houseSigma.ok
        ? `HouseSigma history: ${p.houseSigma.message || 'pulled'} (last checked ${new Date(p.houseSigma.at).toLocaleString('en-CA')}).`
        : `HouseSigma history: the last pull failed — ${p.houseSigma.message || 'unknown error'}`)
      : '';
  }
  const mf = $('#mortgageForm');
  setMoneyValue(mf.mortgage_balance, p.mortgage_balance);
  mf.mortgage_balance_date.value = p.mortgage_balance_date || '';
  setMoneyValue(mf.mortgage_payment, p.mortgage_payment);
  mf.amortization_years.value = p.amortization_years ?? '';
  mf.lender.value = p.lender || '';
  $('#mortgageLenderTag').textContent = p.lender ? `— ${p.lender}` : '';
  syncAmortWarning();
  chartMeta = null; // the previous property's projection must not leak into this page's summary
  amortError = null;
  renderTerms(p);
  renderMortgageSummary();
  loadPrime();
  loadChart(id);
  loadTrend(id);
  loadEquity(id);
}

// How a segment's rate reads in the list: absolute segments show
// their rate; prime-spread segments show the pricing formula and
// the rate it resolves to right now.
function segmentRateText(s) {
  if (s.rate_type === 'variable' && s.rate_mode === 'prime_spread') {
    const sp = Number(s.spread || 0);
    const formula = `Prime ${sp < 0 ? '−' : '+'} ${Math.abs(sp).toFixed(2)}%`;
    return s.effective_rate == null ? `${formula} (prime unavailable)` : `${formula} (now ${Number(s.effective_rate).toFixed(2)}%)`;
  }
  return `${Number(s.effective_rate ?? s.annual_rate).toFixed(2)}%`;
}

// ------------------------------------------------------------- terms ---
// The Mortgage Terms & Rates modal's lower half is the chain of terms.
// Each term is an accordion: its contract fields (lender, start,
// length, amortization, opening balance), the rate segments that
// belong to it ("+ Change rate" adds one), and its lump sums. The
// current term (the one the balance anchor sits in) starts open.
// Everything saves through the terms / rates / lump-sums endpoints
// and the page reloads, so the projection the user sees is always
// the server's recomputation.
const openTermIds = new Set();
let expandTermId = null; // a term to open after the next render (e.g. just added)

function termLengthLabel(months) {
  const m = Number(months);
  if (!m) return '—';
  if (m % 12 === 0) { const y = m / 12; return `${y} year${y === 1 ? '' : 's'}`; }
  return `${m} month${m === 1 ? '' : 's'}`;
}

function currentRateText(p) {
  const c = p && p.currentRate;
  if (!c) return 'no rate plan yet';
  const txt = segmentRateText({
    rate_type: c.rate_type, rate_mode: c.rate_mode, spread: c.spread, effective_rate: c.annual_rate,
  });
  return `${c.rate_type === 'fixed' ? 'Fixed' : 'Variable'} at ${txt}`;
}

// Modal-top summary: the current term's lender, span and number,
// the rate in effect now, and the payment the projection is using
// (auto-computed, or the entered override).
function renderMortgageSummary() {
  const el = $('#mortgageSummary');
  if (!el) return;
  const p = detailProperty;
  if (!p || !(p.terms || []).length) { el.textContent = ''; return; }
  const idx = p.terms.findIndex((t) => t.id === p.currentTermId);
  const t = p.terms[idx >= 0 ? idx : 0];
  let payBit = 'payment not calculated yet';
  if (chartMeta && chartMeta.paymentUsed != null) {
    payBit = `payment ${money(chartMeta.paymentUsed)} / month (${chartMeta.paymentSource === 'entered'
      ? 'entered — overrides the calculation inside this term'
      : 'auto — calculated from the balance, the rate and the remaining amortization'})`;
  } else if (amortError && amortError.code === 'NO_PAYMENT') {
    payBit = 'no payment yet — set this term\u2019s amortization below or enter a monthly payment to project';
  } else if (amortError && amortError.code === 'NO_RATE_PLAN') {
    payBit = 'no payment yet — add a rate segment to project';
  }
  el.textContent = `Current term: Term ${(idx >= 0 ? idx : 0) + 1} of ${p.terms.length} — ${t.lender || 'lender not set'}, ${t.start_date} → ${t.end_date} (${termLengthLabel(t.term_months)}). Rate now: ${currentRateText(p)}. Monthly ${payBit}.`;
}

function segRowsHtml(segs) {
  return segs.map((s) => `<tr>
    <td>${esc(s.start_date)}</td>
    <td>${s.rate_type === 'fixed' ? '<span class="badge">Fixed</span>' : '<span class="badge var">Variable</span>'}</td>
    <td class="num">${esc(segmentRateText(s))}</td>
    <td><button type="button" class="small danger" data-del-seg="${s.id}">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="note" style="margin:0">No segments in this term yet — add one with "+ Change rate".</td></tr>';
}

function lumpRowsHtml(lumps) {
  if (!lumps.length) return '<div class="note" style="margin:0">No lump sums in this term.</div>';
  return lumps.map((l) => `<div class="kv"><span class="k">${esc(l.date)}</span><span>${money(l.amount)}${l.note ? ` · ${esc(l.note)}` : ''}</span><button type="button" class="small danger" data-del-lump="${l.id}">Delete</button></div>`).join('');
}

function segFormHtml(t) {
  return `<form data-seg-form="${t.id}" class="toolbar hidden" style="align-items:flex-end">
    <div><label>Start date</label><input type="date" name="start_date" required value="${esc(t.start_date)}"></div>
    <div><label>Type</label><select name="rate_type"><option value="fixed">Fixed</option><option value="variable">Variable</option></select></div>
    <div data-seg-mode class="hidden"><label>Pricing (variable)</label><select name="rate_mode"><option value="absolute">Absolute rate</option><option value="prime_spread">Prime + spread</option></select></div>
    <div data-seg-rate><label>Annual rate %</label><input type="number" name="annual_rate" step="0.01" min="0"></div>
    <div data-seg-spread class="hidden"><label>Spread vs prime (%)</label><input type="number" name="spread" step="0.05"><div class="note" data-seg-preview style="margin:2px 0 0"></div></div>
    <button class="primary" type="submit">Add segment</button>
    <div class="note" data-plan-preview style="flex-basis:100%;margin:2px 0 0"></div>
  </form>`;
}

function renderTerms(p) {
  const wrap = $('#termsWrap');
  if (!wrap) return;
  const terms = p.terms || [];
  if (expandTermId != null) { openTermIds.add(expandTermId); expandTermId = null; }
  if (p.currentTermId != null && ![...openTermIds].some((id) => terms.some((t) => t.id === id))) {
    openTermIds.add(p.currentTermId);
  }
  // Segments whose term is gone (or never set) still display, under
  // the current term — the projection prices them either way.
  const orphans = (p.segments || []).filter((s) => !terms.some((t) => t.id === s.term_id));
  wrap.innerHTML = terms.map((t, i) => {
    const open = openTermIds.has(t.id);
    const segs = t.id === p.currentTermId ? [...t.segments, ...orphans] : t.segments;
    return `<div class="term-block" data-term-block="${t.id}">
      <button type="button" class="term-head" data-term-toggle="${t.id}">
        <span class="term-title">Term ${i + 1}${t.id === p.currentTermId ? ' · current' : ''}</span>
        <span>${esc(t.lender || 'Lender not set')}</span>
        <span>${esc(t.start_date)} → ${esc(t.end_date)}</span>
        <span>${termLengthLabel(t.term_months)}</span>
        <span>Amortization: ${t.amortization_years != null ? `${esc(t.amortization_years)} years` : 'not set'}</span>
        <span>Opened at ${money(t.opening_balance)}</span>
        <span style="flex:1"></span>
        <span data-term-arrow>${open ? '▾' : '▸'}</span>
      </button>
      <div class="term-body${open ? '' : ' hidden'}">
        <form data-term-form="${t.id}">
          <div class="grid3">
            <div><label>Lender (bank)</label><input name="lender" list="lenderOptions" value="${esc(t.lender || '')}" autocomplete="off"></div>
            <div><label>Term starts</label><input name="start_date" type="date" value="${esc(t.start_date)}" required></div>
            <div><label>Opening balance ($)</label><input name="opening_balance" type="text" inputmode="decimal" data-money value="${esc(formatMoneyInput(t.opening_balance ?? ''))}"></div>
          </div>
          <div class="grid3">
            <div><label>Term length (months)</label><input name="term_months" type="number" min="1" max="120" step="1" value="${esc(t.term_months)}" required>
              <div class="toolbar" style="margin-top:6px">${[1, 2, 3, 4, 5, 7, 10].map((y) => `<button type="button" class="small" data-term-years="${y}">${y} year${y === 1 ? '' : 's'}</button>`).join('')}</div>
            </div>
            <div><label>Amortization for this term (years)</label><input name="amortization_years" type="number" step="0.5" min="1" max="35" value="${t.amortization_years ?? ''}" placeholder="e.g. 25"></div>
            <div><label>Repayment method</label><select name="repayment_method">
              <option value="equal_payment"${t.repayment_method !== 'equal_principal' ? ' selected' : ''}>Equal payment — same total every month</option>
              <option value="equal_principal"${t.repayment_method === 'equal_principal' ? ' selected' : ''}>Equal principal — same principal every month</option>
            </select>
            <div class="note" style="margin:2px 0 0">Equal payment: the interest share shrinks and the principal share grows inside one level payment. Equal principal: the principal part is fixed (balance ÷ remaining amortization) and the payment starts higher, then declines each month.</div></div>
          </div>
          ${t.amortization_defaulted ? '<div class="note" style="margin-left:0">The 25-year amortization on this term is the migration default — set the real figure if it differs.</div>' : ''}
          <div class="toolbar">
            <button class="primary" type="submit">Save term</button>
            ${terms.length > 1 ? `<button type="button" class="small danger" data-del-term="${t.id}">Delete term</button>` : ''}
          </div>
        </form>
        <h5>Rate segments in this term</h5>
        <table>
          <thead><tr><th>Starts</th><th>Type</th><th class="num">Annual rate %</th><th></th></tr></thead>
          <tbody ${t.id === p.currentTermId ? 'id="segmentRows"' : ''}>${segRowsHtml(segs)}</tbody>
        </table>
        <div class="toolbar"><button type="button" class="small" data-toggle-seg="${t.id}">+ Change rate</button></div>
        ${segFormHtml(t)}
        <h5>Lump sums in this term</h5>
        ${lumpRowsHtml(t.lumpSums || [])}
        <div class="note" style="margin-left:0">Your payment stays the same — the lump sum shortens the loan and reduces total interest.</div>
        <div class="toolbar"><button type="button" class="small" data-toggle-lump="${t.id}">+ Add lump sum</button></div>
        <form data-lump-form="${t.id}" class="toolbar hidden" style="align-items:flex-end">
          <div><label>Date</label><input type="date" name="date" required></div>
          <div><label>Amount ($)</label><input type="text" inputmode="decimal" data-money name="amount" required></div>
          <div><label>Note</label><input type="text" name="note"></div>
          <button class="primary" type="submit">Add lump sum</button>
        </form>
      </div>
    </div>`;
  }).join('') || '<div class="note" style="margin-left:0">No terms yet.</div>';
  wrap.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  wrap.querySelectorAll('[data-seg-form]').forEach(syncSegForm);
}

async function deleteSegment(segId) {
  if (!confirm('Delete this rate segment?')) return;
  await api(`/api/properties/${currentPropertyId}/rates/${segId}`, { method: 'DELETE' });
  markAssetsDirty();
  loadPropertyDetail(currentPropertyId);
}
window.deleteSegment = deleteSegment;

// All term-accordion interactions are delegated from #termsWrap:
// the markup is re-rendered on every load, so no per-render wiring.
$('#termsWrap').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-term-toggle]');
  if (toggle) {
    const id = Number(toggle.dataset.termToggle);
    const body = toggle.parentElement.querySelector('.term-body');
    const arrow = toggle.querySelector('[data-term-arrow]');
    const open = body.classList.toggle('hidden') === false;
    if (open) openTermIds.add(id); else openTermIds.delete(id);
    if (arrow) arrow.textContent = open ? '▾' : '▸';
    return;
  }
  const yearsBtn = e.target.closest('[data-term-years]');
  if (yearsBtn) {
    const form = yearsBtn.closest('form');
    if (form) form.term_months.value = Number(yearsBtn.dataset.termYears) * 12;
    return;
  }
  const showSeg = e.target.closest('[data-toggle-seg]');
  if (showSeg) {
    const block = showSeg.closest('[data-term-block]');
    const form = block && block.querySelector('[data-seg-form]');
    if (form) { form.classList.remove('hidden'); syncSegForm(form); refreshPlanPreview(form); }
    return;
  }
  const showLump = e.target.closest('[data-toggle-lump]');
  if (showLump) {
    const block = showLump.closest('[data-term-block]');
    const form = block && block.querySelector('[data-lump-form]');
    if (form) form.classList.remove('hidden');
    return;
  }
  const delSeg = e.target.closest('[data-del-seg]');
  if (delSeg) { deleteSegment(Number(delSeg.dataset.delSeg)); return; }
  const delLump = e.target.closest('[data-del-lump]');
  if (delLump) {
    if (!confirm('Delete this lump sum?')) return;
    try {
      await api(`/api/properties/${currentPropertyId}/lump-sums/${delLump.dataset.delLump}`, { method: 'DELETE' });
      markAssetsDirty();
      loadPropertyDetail(currentPropertyId);
    } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
    return;
  }
  const delTerm = e.target.closest('[data-del-term]');
  if (delTerm) {
    if (!confirm('Delete this term? Its rate segments move to a neighbouring term; its lump sums are removed.')) return;
    try {
      await api(`/api/properties/${currentPropertyId}/terms/${delTerm.dataset.delTerm}`, { method: 'DELETE' });
      markAssetsDirty();
      showMsg($('#mortgageMsg'), 'ok', 'Term deleted.');
      loadPropertyDetail(currentPropertyId);
    } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
  }
});

$('#termsWrap').addEventListener('change', (e) => {
  const form = e.target.closest('[data-seg-form]');
  if (form) { syncSegForm(form); refreshPlanPreview(form); return; }
  // The term's plan fields (repayment method, amortization) re-price
  // the preview of that term's draft segment.
  if (e.target.closest('[data-term-form]')
    && (e.target.name === 'repayment_method' || e.target.name === 'amortization_years')) {
    const seg = segFormOfBlock(e.target);
    if (seg && !seg.classList.contains('hidden')) refreshPlanPreview(seg);
  }
});
$('#termsWrap').addEventListener('input', (e) => {
  const form = e.target.closest('[data-seg-form]');
  if (form) { if (e.target.name === 'spread') syncSegForm(form); refreshPlanPreview(form); return; }
  if (e.target.closest('[data-term-form]') && e.target.name === 'amortization_years') {
    const seg = segFormOfBlock(e.target);
    if (seg && !seg.classList.contains('hidden')) refreshPlanPreview(seg);
  }
});

$('#termsWrap').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    if (form.dataset.termForm) {
      const f = Object.fromEntries(new FormData(form).entries());
      parseMoneyFields(f, ['opening_balance']);
      await api(`/api/properties/${currentPropertyId}/terms/${form.dataset.termForm}`, {
        method: 'PUT',
        body: {
          lender: f.lender,
          start_date: f.start_date,
          term_months: Number(f.term_months),
          amortization_years: f.amortization_years === '' || f.amortization_years == null ? null : Number(f.amortization_years),
          opening_balance: f.opening_balance === '' || f.opening_balance == null ? null : f.opening_balance,
          repayment_method: f.repayment_method || 'equal_payment',
        },
      });
      markAssetsDirty();
      showMsg($('#mortgageMsg'), 'ok', 'Term saved.');
    } else if (form.dataset.segForm) {
      const f = Object.fromEntries(new FormData(form).entries());
      const body = { start_date: f.start_date, rate_type: f.rate_type, term_id: Number(form.dataset.segForm) };
      if (f.rate_type === 'variable' && f.rate_mode === 'prime_spread') {
        body.rate_mode = 'prime_spread';
        body.spread = f.spread === '' ? null : Number(f.spread);
      } else {
        body.rate_mode = 'absolute';
        body.annual_rate = f.annual_rate;
      }
      await api(`/api/properties/${currentPropertyId}/rates`, { method: 'POST', body });
      markAssetsDirty();
      showMsg($('#mortgageMsg'), 'ok', 'Rate segment added.');
    } else if (form.dataset.lumpForm) {
      const f = Object.fromEntries(new FormData(form).entries());
      parseMoneyFields(f, ['amount']);
      await api(`/api/properties/${currentPropertyId}/lump-sums`, {
        method: 'POST',
        body: { date: f.date, amount: f.amount, note: f.note || null, term_id: Number(form.dataset.lumpForm) },
      });
      markAssetsDirty();
      showMsg($('#mortgageMsg'), 'ok', 'Lump sum added.');
    } else {
      return;
    }
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
});

$('#addTermBtn').addEventListener('click', async () => {
  try {
    const t = await api(`/api/properties/${currentPropertyId}/terms`, { method: 'POST', body: {} });
    markAssetsDirty();
    expandTermId = t.id;
    showMsg($('#mortgageMsg'), 'ok', 'New term added — set its amortization (and lender, if you switched banks) in the term below.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
});

$('#propForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['assessed_value']);
  f.bca_id = propSuggest.state.id || null;
  f.owners = propOwnerPicker.get();
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    markAssetsDirty();
    showMsg($('#detailMsg'), 'ok', 'Saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#mortgageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['mortgage_balance', 'mortgage_payment']);
  // The amortization field takes 1–35 years (the server enforces the
  // same range); the usual Canadian maximums only earn the hint
  // below, they do not block.
  const ay = f.amortization_years === '' || f.amortization_years == null ? null : Number(f.amortization_years);
  if (ay !== null && (!Number.isFinite(ay) || ay < 1 || ay > 35)) {
    showMsg($('#mortgageMsg'), 'err', 'Remaining amortization must be between 1 and 35 years.');
    return;
  }
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    markAssetsDirty();
    showMsg($('#mortgageMsg'), 'ok', 'Mortgage saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
});

// Amortization quick picks (25 / 30 — the two Canadian maximums) fill
// the field. Going past the usual maximums shows a note, not a block:
// insured mortgages are generally capped at 25 years (30 for
// first-time buyers and newly built homes since Dec 15, 2024) and
// uninsured at 30; the field itself accepts 1–35 for planning.
function syncAmortWarning() {
  const form = $('#mortgageForm');
  const warn = $('#amortWarn');
  if (!form || !warn) return;
  const raw = form.amortization_years.value;
  const v = Number(raw);
  if (raw !== '' && Number.isFinite(v) && v > 30) {
    warn.textContent = 'That is longer than the usual Canadian maximums (25 years insured — 30 for first-time buyers and newly built homes since Dec 15, 2024 — and 30 years uninsured). It will still be saved, for planning.';
    warn.classList.remove('hidden');
  } else {
    warn.textContent = '';
    warn.classList.add('hidden');
  }
}
$('#mortgageForm').amortization_years.addEventListener('input', syncAmortWarning);
document.querySelectorAll('#mortgageForm [data-amort-years]').forEach((b) => b.addEventListener('click', () => {
  const input = $('#mortgageForm').amortization_years;
  input.value = b.dataset.amortYears;
  syncAmortWarning();
}));

// ---- Prime rate (Bank of Canada, tracked by the server) ----------
// The banner states the current prime with its real as-of date and
// the projection assumption; the add-segment form previews a
// prime-spread against the same value.
let primeInfoCache = null;

async function loadPrime() {
  try {
    primeInfoCache = await api('/api/prime');
  } catch { primeInfoCache = null; }
  const banner = $('#primeBanner');
  const changesEl = $('#primeChanges');
  if (!banner) return;
  const cur = primeInfoCache && primeInfoCache.current;
  renderPrimeWarning($('#primeWarning'), primeInfoCache
    ? { rate: cur ? cur.rate : null, asOf: primeInfoCache.asOf, fresh: primeInfoCache.fresh }
    : null);
  if (cur) {
    banner.textContent = `Bank of Canada prime: ${Number(cur.rate).toFixed(2)}% (as of ${primeInfoCache.asOf || cur.date}). Past months use actual Bank of Canada prime history; future months assume prime stays at the latest known rate of ${Number(cur.rate).toFixed(2)}%.`;
    const changes = primeInfoCache.changes || [];
    changesEl.textContent = changes.length > 1
      ? 'Recent: ' + changes.map((c) => `${Number(c.rate).toFixed(2)}% from ${c.date}`).join(' · ')
      : '';
  } else {
    banner.textContent = 'Bank of Canada prime: not available yet — the app fetches it from the Bank of Canada and keeps the last known value. Prime-based variable segments cannot be projected until a value is on record.';
    changesEl.textContent = '';
  }
  refreshSegPreviews();
}

$('#primeRefreshBtn').addEventListener('click', async () => {
  try {
    primeInfoCache = await api('/api/prime/refresh', { method: 'POST' });
    markAssetsDirty(); // a new prime reprices every variable projection
    loadPrime();
    if (currentPropertyId) loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
});

// A term's add-segment form: Variable reveals the pricing mode;
// Prime + spread swaps the absolute-rate input for a spread input
// with a live preview against the tracked prime. One instance per
// term, scoped by the form's own fields (see renderTerms).
function syncSegForm(form) {
  if (!form) return;
  const isVariable = form.rate_type.value === 'variable';
  const isPrime = isVariable && form.rate_mode.value === 'prime_spread';
  form.querySelector('[data-seg-mode]').classList.toggle('hidden', !isVariable);
  form.querySelector('[data-seg-rate]').classList.toggle('hidden', isPrime);
  form.querySelector('[data-seg-spread]').classList.toggle('hidden', !isPrime);
  form.annual_rate.required = !isPrime;
  const preview = form.querySelector('[data-seg-preview]');
  if (isPrime && preview) {
    const spread = Number(form.spread.value);
    const cur = primeInfoCache && primeInfoCache.current;
    if (cur && form.spread.value !== '' && isFinite(spread)) {
      const eff = Math.max(0, Number(cur.rate) + spread);
      preview.textContent = `Prime ${Number(cur.rate).toFixed(2)}% ${spread < 0 ? '−' : '+'} ${Math.abs(spread).toFixed(2)}% → ${eff.toFixed(2)}%`;
    } else if (!cur) {
      preview.textContent = 'Prime rate not available yet.';
    } else {
      preview.textContent = '';
    }
  }
}

function refreshSegPreviews() {
  document.querySelectorAll('[data-seg-form]').forEach(syncSegForm);
}

// Live plan preview: while a rate plan is being drafted in a term's
// add-segment form, the server runs the draft through the same
// schedule engine as the saved projection and returns the plan's
// first month in effect — payment, interest, principal and the rate
// — so the figures can be checked BEFORE anything is saved.
// Debounced per form; the term's plan fields as currently edited
// (repayment method, amortization) ride along, so changing them
// re-prices the preview too.
const planPreviewTimers = new WeakMap();
function refreshPlanPreview(form) {
  if (!form || !currentPropertyId) return;
  const out = form.querySelector('[data-plan-preview]');
  if (!out) return;
  clearTimeout(planPreviewTimers.get(form));
  planPreviewTimers.set(form, setTimeout(async () => {
    if (!form.isConnected) return;
    const block = form.closest('[data-term-block]');
    const termForm = block && block.querySelector('[data-term-form]');
    const f = Object.fromEntries(new FormData(form).entries());
    const body = {
      start_date: f.start_date,
      rate_type: f.rate_type,
      term_id: Number(form.dataset.segForm),
      repayment_method: termForm ? termForm.repayment_method.value : 'equal_payment',
      amortization_years: termForm && termForm.amortization_years.value !== ''
        ? Number(termForm.amortization_years.value) : null,
    };
    if (f.rate_type === 'variable' && f.rate_mode === 'prime_spread') {
      body.rate_mode = 'prime_spread';
      body.spread = f.spread === '' ? null : Number(f.spread);
    } else {
      body.rate_mode = 'absolute';
      body.annual_rate = f.annual_rate === '' ? null : Number(f.annual_rate);
    }
    try {
      const r = await api(`/api/properties/${currentPropertyId}/preview`, { method: 'POST', body });
      if (!form.isConnected) return;
      out.textContent = r.ok
        ? `Next month (${r.month}): payment ${money(r.payment)} — interest ${money(r.interest)}, principal ${money(r.principal)}, at ${Number(r.rate).toFixed(2)}%`
        : (r.error || '');
    } catch (err) {
      if (form.isConnected) out.textContent = err.message;
    }
  }, 300));
}

// A term block's open add-segment form, if any (previews refresh
// when the term's own plan fields change too).
function segFormOfBlock(el) {
  const block = el && el.closest('[data-term-block]');
  return block ? block.querySelector('[data-seg-form]') : null;
}

// Payment frequency + payment day are property fields, but they are
// maintained here, with the rate plan: saving re-renders the chart
// on the new schedule. The payment day only applies to the monthly /
// semi-monthly schedules; for the day-stepped frequencies the input
// is disabled with an explanation.
const FREQUENCY_LABELS = {
  monthly: 'Monthly', semi_monthly: 'Semi-monthly', bi_weekly: 'Bi-weekly',
  accelerated_bi_weekly: 'Accelerated bi-weekly', weekly: 'Weekly', accelerated_weekly: 'Accelerated weekly',
};
const DAY_STEPPED_FREQUENCIES = ['bi_weekly', 'accelerated_bi_weekly', 'weekly', 'accelerated_weekly'];
function syncFrequencyUi() {
  const stepped = DAY_STEPPED_FREQUENCIES.includes($('#paymentFrequencySelect').value);
  $('#paymentDayInput').disabled = stepped;
  $('#paymentFreqNote').textContent = stepped
    ? 'Payment day does not apply to weekly and bi-weekly schedules — payments step by whole days from the balance date instead.'
    : '';
}
$('#paymentFrequencySelect').addEventListener('change', syncFrequencyUi);
$('#paymentDayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('#paymentDayInput').value.trim();
  try {
    await api(`/api/properties/${currentPropertyId}`, {
      method: 'PUT',
      body: {
        payment_frequency: $('#paymentFrequencySelect').value,
        payment_day: raw === '' ? null : Number(raw),
      },
    });
    markAssetsDirty();
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
});

$('#fetchBcaBtn').addEventListener('click', async () => {
  const msg = $('#historyMsg');
  showMsg(msg, 'ok', 'Fetching from BC Assessment…');
  try {
    const r = await api(`/api/properties/${currentPropertyId}/fetch-bca`, { method: 'POST' });
    if (r.ok) {
      markAssetsDirty();
      showMsg(msg, 'ok', `Fetched: assessed value ${money(r.result.assessedValue)} (${r.result.assessedYear || 'current'}), matched "${r.result.matchedAddress}".`);
      loadPropertyDetail(currentPropertyId);
    } else {
      showMsg(msg, 'err', `BC Assessment fetch failed (${r.error}). Your saved values were not changed — you can enter the value manually.`);
    }
  } catch (err) { showMsg(msg, 'err', err.message); }
});

$('#pullHistoryBtn').addEventListener('click', async () => {
  const msg = $('#historyMsg');
  showMsg(msg, 'ok', 'Pulling assessment history from HouseSigma…');
  try {
    const r = await api(`/api/properties/${currentPropertyId}/pull-history`, { method: 'POST' });
    if (r.ok) {
      markAssetsDirty();
      showMsg(msg, 'ok', r.added.length
        ? `Pulled from HouseSigma: added ${r.added.join(', ')} (${r.years.length} years on record there).`
        : 'HouseSigma history is already up to date — no new years to add.');
      loadPropertyDetail(currentPropertyId);
      loadTrend(currentPropertyId);
    } else {
      showMsg(msg, 'err', `HouseSigma pull failed (${r.error}). Your saved points were not changed.`);
    }
  } catch (err) { showMsg(msg, 'err', err.message); }
});

$('#deletePropertyBtn').addEventListener('click', async () => {
  if (!confirm('Delete this property, its rate segments and its photos?')) return;
  await api(`/api/properties/${currentPropertyId}`, { method: 'DELETE' });
  markAssetsDirty();
  location.hash = '#assets/properties';
});

// ------------------------------------------------------------ value trend ---
// Assessed-value history: one point per year. Auto points are written by
// BC Assessment fetches; manual points fill earlier years by hand. The
// points are drawn as the assessed-value points of the combined chart;
// the editor for the points is the Assessment History modal.
let trendPoints = [];
let trendEditingId = null;

async function loadTrend(id) {
  const r = await api(`/api/properties/${id}/value-history`);
  trendPoints = r.points;
  const rows = trendPoints.map((pt) => `<tr>
    <td>${pt.year}</td><td class="num">${money(pt.value)}</td>
    <td>${pt.source === 'auto' ? '<span class="badge">BC Assessment</span>' : pt.source === 'housesigma' ? '<span class="badge">HouseSigma</span>' : '<span class="badge manual">Manual</span>'}</td>
    <td>${esc(pt.notes || '')}</td>
    <td style="white-space:nowrap">
      <button class="small" onclick="editTrendPoint(${pt.id})">Edit</button>
      <button class="small danger" onclick="deleteTrendPoint(${pt.id})">Delete</button>
    </td></tr>`).join('');
  $('#trendRows').innerHTML = rows || '<tr><td colspan="5" class="note" style="margin:0">No history points yet.</td></tr>';
  renderTrendSummary();
  renderDetailCharts();
  loadEquity(id); // a changed latest point moves the equity readout too
}

// Trend summary: computed over the SAME years the combined chart
// currently shows (see lookbackHistory), so the figure can never
// describe a different span than the line on screen. When earlier
// years fall outside the selected range, the text says so.
function renderTrendSummary() {
  const summary = $('#trendSummary');
  if (!summary) return;
  const shown = lookbackHistory(trendPoints, currentRangeMonths());
  if (shown.length >= 2) {
    const first = shown[0];
    const last = shown[shown.length - 1];
    const abs = last.value - first.value;
    const sign = abs >= 0 ? '+' : '−';
    const pctTxt = first.value ? ` (${abs >= 0 ? '+' : ''}${(abs / first.value * 100).toFixed(1)}%)` : '';
    summary.textContent = `Change ${first.year} → ${last.year}: ${sign}${money(Math.abs(abs))}${pctTxt} (${money(first.value)} → ${money(last.value)}).`
      + (shown.length < trendPoints.length
        ? ` Showing the years that fall in the selected chart range, as in the chart — set the chart range to All to include earlier years.`
        : '');
  } else if (shown.length === 1 && trendPoints.length > 1) {
    summary.textContent = `Only the ${shown[0].year} point falls in the selected chart range — widen the range to compare years.`;
  } else if (trendPoints.length === 1) {
    summary.textContent = 'Only one year on record — add earlier years in “Assessment History” to see the trend.';
  } else {
    summary.textContent = 'No history yet — fetch from BC Assessment or add a point in “Assessment History”.';
  }
}

function resetTrendForm() {
  trendEditingId = null;
  $('#trendForm').reset();
  $('#trendSubmitBtn').textContent = 'Add point';
  $('#trendCancelBtn').classList.add('hidden');
}

function editTrendPoint(pointId) {
  const pt = trendPoints.find((x) => x.id === pointId);
  if (!pt) return;
  trendEditingId = pointId;
  const f = $('#trendForm');
  f.year.value = pt.year;
  setMoneyValue(f.value, pt.value);
  f.notes.value = pt.notes || '';
  $('#trendSubmitBtn').textContent = 'Save point';
  $('#trendCancelBtn').classList.remove('hidden');
}
window.editTrendPoint = editTrendPoint;

async function deleteTrendPoint(pointId) {
  if (!confirm('Delete this history point?')) return;
  await api(`/api/properties/${currentPropertyId}/value-history/${pointId}`, { method: 'DELETE' });
  markAssetsDirty();
  resetTrendForm();
  loadTrend(currentPropertyId);
}
window.deleteTrendPoint = deleteTrendPoint;

$('#trendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['value']);
  try {
    if (trendEditingId) {
      await api(`/api/properties/${currentPropertyId}/value-history/${trendEditingId}`, { method: 'PUT', body: f });
    } else {
      await api(`/api/properties/${currentPropertyId}/value-history`, { method: 'POST', body: f });
    }
    markAssetsDirty();
    resetTrendForm();
    loadTrend(currentPropertyId);
  } catch (err) { showMsg($('#trendMsg'), 'err', err.message); }
});
$('#trendCancelBtn').addEventListener('click', resetTrendForm);

// ------------------------------------------------------------------ charts --
// ONE merged chart on the detail page: assessed value (yearly history
// points) and outstanding balance (monthly projection) as lines — the
// gap is the equity — plus the payment split as bars: each projected
// month's interest portion and principal portion, stacked to the
// payment (summed into yearly bars on spans over 10 years). The
// assessed points stop at the last known year; they are deliberately
// NOT extended into the future (no invented forecast).
// The projection only ever comes from the user's own rate plan (segments);
// with no plan the API reports NO_RATE_PLAN and the projection stays
// absent with a prompt instead of a made-up line.
async function loadChart(id) {
  scheduleYear = null; // a new property's schedule opens on its default page
  const r = await api(`/api/properties/${id}/amortization`);
  if (!r.ok) {
    fullSeries = [];
    chartMeta = null;
    amortError = r;
  } else {
    fullSeries = r.series;
    chartMeta = r;
    amortError = null;
  }
  renderDetailCharts();
}

async function loadEquity(id) {
  equityData = await api(`/api/properties/${id}/equity`);
  renderEquity();
}

function currentRangeMonths() {
  const custom = Number($('#customMonths').value);
  if (custom > 0) return custom;
  const active = $('#rangeBtns button.active');
  return active ? Number(active.dataset.months) : 60;
}

// ------------------------------------------------------- range window ---
// The mixed charts (detail Chart A, portfolio overview) read their
// range as a LOOK-BACK window that ENDS TODAY: "1 year" means the
// last 12 months up to today, "5 years" the last 60, a custom month
// count likewise. It used to be anchored at the earliest data and
// pushed forward, which made the buttons feel dead on sparse data —
// one assessed point plus a mostly empty axis that only changed
// length. "All" (0 months) is the exception: it keeps the whole data
// extent, full projection included, as the see-everything view. The
// choice lives in the range buttons themselves, so re-renders (new
// points, fresh data) keep the user's window instead of snapping
// back to the default.

// Fractional-year position of a Date on the axis scale (ymDecimal:
// January of year Y is Y.0 and each month adds 1/12; days interpolate
// within their month).
function dateDecimal(d) {
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getFullYear() + d.getMonth() / 12 + (d.getDate() - 1) / (dim * 12);
}

// { min, max } of the look-back window for a range of N months, or
// null for "All". Local dates, matching how the app treats its dates
// everywhere else.
function lookbackWindow(months) {
  if (!(months > 0)) return null;
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const day = start.getDate();
  start.setDate(1);
  start.setMonth(start.getMonth() - months);
  const dim = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  start.setDate(Math.min(day, dim));
  return { min: dateDecimal(start), max: dateDecimal(end) };
}

// Which yearly items fall inside the look-back window: a year counts
// when its point (plotted at January of that year) lies within
// [min, max]. With the default 5-year range that is the most recent
// 5 assessment years (2022-2026 in late 2026); "All" returns the
// items untouched. Items need a `year`; history points and the
// portfolio's per-year rows both qualify. The underlying records are
// never touched — this only picks what draws.
function lookbackHistory(items, months) {
  const win = lookbackWindow(months);
  if (!win || !items.length) return items;
  return items.filter((i) => i.year >= win.min && i.year <= win.max);
}

// 'YYYY-MM' / 'YYYY-MM-DD' -> fractional year (January = .0), for chart A's
// linear time axis (the vendored Chart.js has no date adapter).
function ymDecimal(s) {
  const [y, m] = String(s).split('-').map(Number);
  return y + (m - 1) / 12;
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatYearTick(x) {
  const y = Math.floor(x);
  const m = Math.round((x - y) * 12);
  if (m <= 0) return String(y);
  if (m >= 12) return String(y + 1);
  return `${MONTH_NAMES[m]} ${y}`;
}

// Explicit x-axis window for the charts that mix assessed history
// with a mortgage projection. For a month range the axis IS the
// look-back window (see lookbackWindow): exactly the selected span,
// ending today — data outside it is clipped and never stretches the
// axis. (Leaving the axis to the Chart.js auto-fit was a bug: it
// unioned both series and rounded the bounds outward to "nice"
// steps, ballooning into decades of empty span; anchoring the
// window at the data and pushing the range forward had the subtler
// failure that the buttons only changed the length of a mostly
// empty axis.) For "All" the axis is the exact data extent —
// earliest assessment year to the projection's last month, no
// padding. Returns null when there is nothing to draw.
function mixedAxisWindow({ months, assessedYears = [], projStart = null, projLastX = null }) {
  const look = lookbackWindow(months);
  if (look) return look;
  let min = Infinity;
  let max = -Infinity;
  if (assessedYears.length) {
    min = Math.min(min, assessedYears[0]);
    max = Math.max(max, assessedYears[assessedYears.length - 1] + 1);
  }
  if (projStart !== null) {
    min = Math.min(min, projStart);
    max = Math.max(max, projLastX ?? projStart);
  }
  return Number.isFinite(min) ? { min, max } : null;
}

// Tick steps for the fractional-year axis, set explicitly — the
// library's own "nice step" choice jumps straight to whole years
// even when there is room for finer steps. Short windows tick
// monthly (labels like "Mar 2027" via formatYearTick), mid windows
// half-yearly (the month is still named), and only genuinely long
// spans fall back to auto whole-year steps.
function yearAxisTicks(min, max) {
  const span = max - min;
  // maxTicksLimit sits a few above the exact tick count on purpose:
  // with fractional-year bounds the generator can land one tick over
  // the exact count, and Chart.js answers an over-limit count by
  // doubling the step (monthly ticks would collapse to bi-monthly).
  if (span <= 2.01) return { stepSize: 1 / 12, maxTicksLimit: 30 };
  if (span <= 10.01) return { stepSize: 0.5, maxTicksLimit: 25 };
  return { maxTicksLimit: 13 };
}

function renderEquity() {
  const el = $('#equitySummary');
  if (!el) return;
  const a = equityData;
  if (!a) { el.textContent = ''; return; }
  if (a.assessedValue !== null && a.balance !== null) {
    el.textContent =
      `Current equity: ${money(a.equity)} — latest assessed value ${money(a.assessedValue)}` +
      `${a.assessedYear ? ` (${a.assessedYear})` : ''} minus outstanding principal ${money(a.balance)}.`;
  } else if (a.assessedValue !== null) {
    el.textContent = `Latest assessed value: ${money(a.assessedValue)}${a.assessedYear ? ` (${a.assessedYear})` : ''}. Add the outstanding principal in “Mortgage Terms & Rates” to see the equity.`;
  } else if (a.balance !== null) {
    el.textContent = `Outstanding principal: ${money(a.balance)}. Fetch the assessed value from BC Assessment (in “Assessment History”) to see the equity.`;
  } else {
    el.textContent = 'Equity appears here once an assessed value and an outstanding principal is on record.';
  }
}

// When the monthly payment was derived from the remaining
// amortization (no payment entered), the Mortgage panel says so and
// names the amount — the figure the projection is actually using.
function renderDerivedPaymentNote() {
  const el = $('#derivedPaymentNote');
  if (!el) return;
  if (chartMeta && chartMeta.paymentSource === 'derived') {
    el.textContent = `Monthly payment derived from the remaining amortization: ${money(chartMeta.paymentUsed)} per month — calculated automatically, and recalculated when the rate changes or a new term starts. A lump sum leaves the payment unchanged — it shortens the loan and reduces total interest instead. Enter a monthly payment above to override it inside the current term.`;
  } else if (chartMeta && chartMeta.paymentSource === 'entered') {
    el.textContent = `Monthly payment: ${money(chartMeta.paymentUsed)} per month (entered) — it overrides the automatic calculation inside the current term; from the next term on, the payment is calculated automatically again.`;
  } else {
    el.textContent = '';
  }
}

function renderDetailCharts() {
  renderEquity();
  renderTrendSummary(); // the summary follows the chart's current window
  renderDerivedPaymentNote();
  renderMortgageSummary();
  drawCombinedChart();
  renderSchedule();
}

// The detail page's one chart (merged from the former pair): the
// assessed-value line and the outstanding-principal projection share
// its time axis with the payment-split bars — each projected month's
// (or, on spans over 10 years, each year's) interest and principal
// portions, stacked to the payment itself. Everything is governed by
// the same look-back window as before: "All" draws the full
// projection; a month range clips the lines AND the bars at today.
function drawCombinedChart() {
  const ctx = $('#combinedChart');
  if (!ctx) return;
  if (chartA) { chartA.destroy(); chartA = null; }
  window.__fmCharts.a = null;
  window.__fmCharts.b = null; // legacy hook: there is no second chart anymore
  // When the projection cannot be computed, say so right at this
  // chart (the assessed points still draw) instead of leaving
  // silently missing lines/bars.
  const cmsg = $('#combinedMsg');
  if (cmsg) {
    if (amortError && amortError.code === 'NO_RATE_PLAN') {
      showMsg(cmsg, 'warn', 'No projection yet — set up a rate plan: open “Mortgage Terms & Rates” (above) and add a rate segment, and the outstanding-principal line will be projected from it.');
    } else if (amortError && amortError.code === 'NO_PAYMENT') {
      showMsg(cmsg, 'warn', 'The outstanding principal is not projected yet — add a monthly payment or remaining amortization in “Mortgage Terms & Rates” (above) to project it.');
    } else if (amortError) {
      showMsg(cmsg, 'warn', amortError.error);
    } else {
      cmsg.className = 'msg';
      cmsg.textContent = '';
    }
  }
  const mmsg = $('#monthlyMsg');
  mmsg.className = 'msg';
  const datasets = [];
  const months = currentRangeMonths();
  const shownYears = [];
  let projStart = null;
  let projLastX = null;
  if (trendPoints.length) {
    // Assessed points inside the look-back window (All = every year
    // on record). The points still stop at the last known year — they
    // are not extended toward today (see the charts header comment).
    const shown = lookbackHistory(trendPoints, months);
    shownYears.push(...shown.map((pt) => pt.year).sort((a, b) => a - b));
    datasets.push({
      type: 'line',
      label: 'Assessed value',
      yAxisID: 'y',
      data: shown.map((pt) => ({ x: pt.year, y: pt.value })),
      borderColor: '#2e7d4f', backgroundColor: '#2e7d4f',
      // One value per assessment year, joined by straight line
      // segments like the portfolio chart (tension 0 — no smoothing
      // curve, no step).
      showLine: true, tension: 0, pointRadius: 5, pointHoverRadius: 7, order: 1,
    });
  }
  if (chartMeta && fullSeries.length) {
    const allPts = [{ x: ymDecimal(chartMeta.balanceDate), y: chartMeta.balance },
      ...fullSeries.map((r) => ({ x: ymDecimal(r.date || r.month), y: r.balance }))];
    projStart = allPts[0].x;
    projLastX = allPts[allPts.length - 1].x;
    // The projection is clipped to the same look-back window as the
    // axis: the part beyond today belongs to the All view, not here.
    const winLb = lookbackWindow(months);
    const pts = winLb ? allPts.filter((p) => p.x >= winLb.min && p.x <= winLb.max) : allPts;
    if (pts.length) {
      datasets.push({
        type: 'line',
        label: 'Outstanding principal',
        yAxisID: 'y',
        data: pts,
        borderColor: '#1668c4', backgroundColor: '#1668c4',
        tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, order: 1,
      });
    }
  }
  // The axis is exactly the selected window — never the library's
  // auto-fit (see mixedAxisWindow).
  const win = mixedAxisWindow({ months, assessedYears: shownYears, projStart, projLastX });
  // Payment-split bars, clipped to the same window as the lines.
  // Each bar is one projected month's interest + principal portions
  // stacked to that month's payment; when the displayed span runs
  // over 10 years the months are summed into yearly bars, so a
  // decades-long projection doesn't dissolve into hundreds of hair-
  // thin columns. (The series is sampled monthly, so for the
  // day-stepped frequencies a bar is the month's totals across all
  // its payments.)
  let barsBasis = null; // 'monthly' | 'yearly' when bars are drawn
  const barTotals = [];
  if (chartMeta && fullSeries.length && win) {
    const winLb = lookbackWindow(months);
    const rows = winLb
      ? fullSeries.filter((r) => { const x = ymDecimal(r.month); return x >= winLb.min && x <= winLb.max; })
      : fullSeries;
    if (rows.length) {
      let pts;
      if (win.max - win.min > 10) {
        barsBasis = 'yearly';
        const byYear = new Map();
        for (const r of rows) {
          const y = Number(String(r.month).slice(0, 4));
          const g = byYear.get(y) || { interest: 0, principal: 0 };
          g.interest += r.interest;
          g.principal += r.principal;
          byYear.set(y, g);
        }
        pts = [...byYear.entries()].sort((a, b) => a[0] - b[0])
          .map(([y, g]) => ({ x: y, interest: g.interest, principal: g.principal }));
      } else {
        barsBasis = 'monthly';
        pts = rows.map((r) => ({ x: ymDecimal(r.month), interest: r.interest, principal: r.principal }));
      }
      for (const p of pts) barTotals.push(p.interest + p.principal);
      // The two portions share a stack group, so they pile up to the
      // payment; the y axis itself is NOT stacked, so the lines are
      // never stacked (Chart.js stacks a dataset when its axis is
      // stacked, or when the axis leaves it open and the dataset
      // names a stack — the bars do, the lines don't).
      datasets.push({
        type: 'bar',
        label: 'Interest portion',
        yAxisID: 'y1',
        data: pts.map((p) => ({ x: p.x, y: p.interest })),
        backgroundColor: '#d97706', borderColor: '#d97706',
        stack: 'payment', borderWidth: 1, order: 2,
      });
      datasets.push({
        type: 'bar',
        label: 'Principal portion',
        yAxisID: 'y1',
        data: pts.map((p) => ({ x: p.x, y: p.principal })),
        backgroundColor: '#2e7d4f', borderColor: '#2e7d4f',
        stack: 'payment', borderWidth: 1, order: 2,
      });
    }
  }
  chartBarsBasis = barsBasis;
  // The projection's figures (payment used, total interest, total
  // principal, payoff) live in the monthly schedule's Total row
  // below the chart now — no text summary block over the chart. The
  // one warning with no tabular home stays beside the chart.
  if (chartMeta && chartMeta.negativeAmortization) {
    showMsg(mmsg, 'warn', 'Warning: the monthly payment is below the monthly interest in some months (negative amortization) — the balance grows there.');
  }
  if (!datasets.length) return;
  // Two axes, two maxima: the lines set the left (amount) axis, the
  // stacked bar totals set the right (payment) axis. Both start at
  // 0 — the payments are three orders of magnitude below the
  // balances, so on one shared axis the bars were invisible; on
  // their own axis they read at their real size.
  let lineMax = 0;
  for (const ds of datasets) {
    if (ds.type !== 'line') continue;
    for (const p of ds.data) if (p.y > lineMax) lineMax = p.y;
  }
  let barMax = 0;
  for (const t of barTotals) if (t > barMax) barMax = t;
  chartA = new Chart(ctx, {
    data: { datasets },
    plugins: [guideLinePlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: {
          labels: {
            // Each series names its axis in the legend — with two
            // scales this far apart, a bare label would invite
            // reading a bar against the amount axis.
            generateLabels: (chart) => chart.data.datasets.map((ds, i) => ({
              text: `${ds.label}${ds.yAxisID === 'y1' ? ' (payment axis)' : ' (value axis)'}`,
              fillStyle: ds.backgroundColor, strokeStyle: ds.borderColor, lineWidth: 1,
              datasetIndex: i, hidden: !chart.isDatasetVisible(i),
            })),
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => formatYearTick(items[0].parsed.x),
            label: (item) => ` ${item.dataset.label}: ${money(item.parsed.y)}${item.dataset.yAxisID === 'y1' ? ' (payment axis)' : ' (value axis)'}`,
            footer: (items) => {
              const it = items[0];
              if (!it || it.dataset.stack !== 'payment') return '';
              const bars = it.chart.data.datasets.filter((d) => d.stack === 'payment');
              const total = bars.reduce((s, d) => s + (d.data[it.dataIndex] ? d.data[it.dataIndex].y : 0), 0);
              return barsBasis === 'yearly' ? `Total payments that year: ${money(total)}` : `Total payment: ${money(total)}`;
            },
          },
        },
      },
      scales: {
        x: { type: 'linear', ...(win || {}), ticks: { ...(win ? yearAxisTicks(win.min, win.max) : {}), callback: formatYearTick } },
        // Left axis: assessed values and outstanding balances.
        // Right axis: the payment split only, grid lines off (the
        // left axis draws the grid), hidden entirely when there
        // are no bars to scale.
        y: {
          min: 0,
          ...(lineMax > 0 ? { max: lineMax * 1.05 } : {}),
          ticks: { callback: moneyTick }, title: { display: true, text: 'Amount ($)' },
        },
        y1: {
          position: 'right',
          display: barTotals.length > 0,
          min: 0,
          ...(barMax > 0 ? { max: barMax * 1.1 } : {}),
          grid: { drawOnChartArea: false },
          ticks: { callback: moneyTick }, title: { display: true, text: 'Payment ($)' },
        },
      },
    },
  });
  window.__fmCharts.a = chartA;
}

// ------------------------------------------------------ monthly schedule ---
// The table under the projection chart: the very series the bars
// draw, one row per month — Month | Payment | Principal | Interest |
// Remaining principal — clipped to the chart's current window and
// paged by calendar year (one year per page). Its Total row sums
// the WHOLE window, not the open page: the projection's totals
// (total payment / principal / interest, and the payoff month when
// it lands in range) live there now, in place of the old text
// summary over the chart. The exact sums ride in data attributes
// next to the app's usual rounded money display.
function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}

function scheduleWindowRows() {
  if (!chartMeta || !fullSeries.length) return [];
  const winLb = lookbackWindow(currentRangeMonths());
  if (!winLb) return fullSeries.slice();
  return fullSeries.filter((r) => {
    const x = ymDecimal(r.month);
    return x >= winLb.min && x <= winLb.max;
  });
}

function scheduleYears() {
  return [...new Set(scheduleWindowRows().map((r) => String(r.month).slice(0, 4)))];
}

function renderSchedule() {
  const tbody = $('#scheduleRows');
  if (!tbody) return;
  const pager = $('#schedulePager');
  const totalRow = $('#scheduleTotalRow');
  const note = $('#scheduleNote');
  if (note) {
    note.textContent = chartBarsBasis === 'yearly'
      ? 'On spans over 10 years the chart bars are yearly interest & principal totals; this table always stays monthly.'
      : '';
  }
  const rows = scheduleWindowRows();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="note" style="margin:0">No projected months fall in the selected range.</td></tr>';
    if (pager) pager.classList.add('hidden');
    if (totalRow) totalRow.classList.add('hidden');
    return;
  }
  const years = [...new Set(rows.map((r) => String(r.month).slice(0, 4)))];
  const todayYear = String(new Date().getFullYear());
  if (!scheduleYear || !years.includes(scheduleYear)) {
    scheduleYear = years.includes(todayYear) ? todayYear : years[0];
  }
  const pageRows = rows.filter((r) => String(r.month).slice(0, 4) === scheduleYear);
  tbody.innerHTML = pageRows.map((r) => `<tr>
    <td>${monthLabel(r.month)}</td>
    <td class="num">${money(r.payment)}</td>
    <td class="num">${money(r.principal)}</td>
    <td class="num">${money(r.interest)}</td>
    <td class="num">${money(r.balance)}</td></tr>`).join('');
  const sel = $('#scheduleYearSelect');
  sel.innerHTML = years.map((y) => `<option value="${y}"${y === scheduleYear ? ' selected' : ''}>${y}</option>`).join('');
  const idx = years.indexOf(scheduleYear);
  $('#schedulePrevYear').disabled = idx <= 0;
  $('#scheduleNextYear').disabled = idx >= years.length - 1;
  pager.classList.remove('hidden');
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const first = rows[0];
  const last = rows[rows.length - 1];
  let label = `Total — ${monthLabel(first.month)} to ${monthLabel(last.month)} (${rows.length} month${rows.length === 1 ? '' : 's'})`;
  if (chartMeta.payoffMonth && chartMeta.payoffMonth >= first.month && chartMeta.payoffMonth <= last.month) {
    label += ` · Paid off ${chartMeta.payoffMonth}`;
  }
  totalRow.classList.remove('hidden');
  totalRow.innerHTML = `<td>${esc(label)}</td>
    <td class="num sum-payment" data-value="${sum('payment')}">${money(sum('payment'))}</td>
    <td class="num sum-principal" data-value="${sum('principal')}">${money(sum('principal'))}</td>
    <td class="num sum-interest" data-value="${sum('interest')}">${money(sum('interest'))}</td>
    <td class="num">${money(last.balance)}</td>`;
}

function stepScheduleYear(delta) {
  const years = scheduleYears();
  const i = years.indexOf(scheduleYear);
  const next = years[i + delta];
  if (next) { scheduleYear = next; renderSchedule(); }
}
$('#schedulePrevYear').addEventListener('click', () => stepScheduleYear(-1));
$('#scheduleNextYear').addEventListener('click', () => stepScheduleYear(1));
$('#scheduleYearSelect').addEventListener('change', (e) => {
  scheduleYear = e.target.value;
  renderSchedule();
});

// A range change RE-FETCHES the projection instead of re-clipping
// the payload already on the page: the server re-prices every month
// against the latest prime history (refreshed fetch-on-read), and
// the chart + schedule redraw from the fresh series.
$('#rangeBtns').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-months]');
  if (!btn) return;
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.toggle('active', b === btn));
  $('#customMonths').value = '';
  if (currentPropertyId) loadChart(currentPropertyId);
});
$('#customMonths').addEventListener('change', () => {
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.remove('active'));
  if (currentPropertyId) loadChart(currentPropertyId);
});

// ----------------------------------------------------------------- admin ---
// User management page. Admin-only: the nav entry is hidden for other
// users and every /api/admin call is 403 for them server-side, so this
// page simply renders what the API allows.
let adminUsersById = {};

async function refreshAvatarConsumers(changedUserId) {
  // Avatars flow from the users table; refresh the places that render
  // them so a change made here is visible without a full reload.
  markAssetsDirty();
  await loadOwnerUsers();
  ownerPickers.forEach((p) => p.refresh());
  try {
    const me = await api('/api/me');
    $('#whoamiAvatar').innerHTML = avatarHtml(me);
  } catch { /* redirected to login */ }
  loadAdmin();
}

async function loadAdmin() {
  const msg = $('#adminMsg');
  let users;
  try { users = await api('/api/admin/users'); }
  catch (e) { showMsg(msg, 'err', e.message); $('#adminUserRows').innerHTML = ''; return; }
  adminUsersById = Object.fromEntries(users.map((u) => [u.id, u]));
  $('#adminUserRows').innerHTML = users.map((u) => `<tr>
    <td><span class="user-cell">${avatarHtml(u, 'lg')}<span>${esc(u.username)}${u.isAdmin ? ' <span class="badge">admin</span>' : ''}</span></span></td>
    <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('en-CA') : '—'}</td>
    <td>${u.avatarFile ? 'Photo' : 'Letter default'}</td>
    <td style="white-space:nowrap">
      <label class="btnlike small">Upload photo <input type="file" accept="image/*" style="display:none" onchange="adminUploadAvatar(${u.id}, this)"></label>
      ${u.avatarFile ? `<button class="small" onclick="adminRemoveAvatar(${u.id})">Restore default</button>` : ''}
      <button class="small" onclick="adminResetPassword(${u.id})">Reset password</button>
      ${u.isAdmin ? '' : `<button class="small danger" onclick="adminDeleteUser(${u.id})">Delete</button>`}
    </td></tr>`).join('');
}

window.adminUploadAvatar = async (userId, input) => {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const dataBase64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  try {
    await api(`/api/admin/users/${userId}/avatar`, { method: 'POST', body: { dataBase64, contentType: file.type } });
    showMsg($('#adminMsg'), 'ok', 'Avatar updated.');
    refreshAvatarConsumers(userId);
  } catch (e) { showMsg($('#adminMsg'), 'err', e.message); }
};

window.adminRemoveAvatar = async (userId) => {
  try {
    await api(`/api/admin/users/${userId}/avatar`, { method: 'DELETE' });
    showMsg($('#adminMsg'), 'ok', 'Back to the letter default avatar.');
    refreshAvatarConsumers(userId);
  } catch (e) { showMsg($('#adminMsg'), 'err', e.message); }
};

window.adminResetPassword = async (userId) => {
  const u = adminUsersById[userId];
  const pw = prompt(`New password for ${u ? u.username : 'this user'}:`);
  if (!pw) return;
  try {
    await api(`/api/admin/users/${userId}/password`, { method: 'POST', body: { password: pw } });
    showMsg($('#adminMsg'), 'ok', `Password reset for ${u ? u.username : 'the user'}. They sign in with the new password now.`);
  } catch (e) { showMsg($('#adminMsg'), 'err', e.message); }
};

window.adminDeleteUser = async (userId) => {
  const u = adminUsersById[userId];
  if (!u) return;
  if (!confirm(`Delete user ${u.username}? They will no longer be able to sign in, and their name is removed from every owners list.`)) return;
  try {
    await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
    showMsg($('#adminMsg'), 'ok', `User ${u.username} deleted.`);
    refreshAvatarConsumers(userId);
  } catch (e) { showMsg($('#adminMsg'), 'err', e.message); }
};

$('#addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  try {
    const u = await api('/api/admin/users', { method: 'POST', body: f });
    e.target.reset();
    showMsg($('#adminMsg'), 'ok', `User ${u.username} added.`);
    refreshAvatarConsumers(u.id);
  } catch (err) { showMsg($('#adminMsg'), 'err', err.message); }
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
    $('#whoamiAvatar').innerHTML = avatarHtml(me);
    if (me.isAdmin) $('#adminNavLink').classList.remove('hidden');
  } catch { /* api() already redirected */ }
  await loadOwnerUsers();
  ownerPickers.forEach((p) => p.refresh());
  route();
})();
