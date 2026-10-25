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
// pie, and a combined chart (assessed history line + total
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
  // record). The portfolio line is a carry-forward total, so inside
  // a look-back window the latest pre-window total is carried in at
  // the left edge and the last shown total is carried forward to
  // today: the line spans the whole window instead of starting late
  // or stopping at the last assessment year.
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
      // Assessed values are yearly steps, not a continuous quantity:
      // a roll year's value holds flat all year and jumps at the next
      // roll. A smoothed curve would invent a year-long slide between
      // the two Januaries, so this line is stepped with no tension.
      stepped: 'before', tension: 0, pointRadius: 4, pointHoverRadius: 7, borderWidth: 2,
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
  portfolioLineChart = new Chart(ctx, {
    data: { datasets },
    plugins: [guideLinePlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      // Hover one time point: every monthly series shares the same x
      // values, so 'index' groups them; the filter keeps only items
      // at that exact x (the yearly assessed line joins in January,
      // where its point lands on the same x) and drops not-yet-started
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
        x: { type: 'linear', stacked: true, ...(pfWin || {}), ticks: { ...(pfWin ? yearAxisTicks(pfWin.min, pfWin.max) : {}), callback: formatYearTick } },
        y: { stacked: true, ticks: { callback: moneyTick }, title: { display: true, text: 'Amount ($)' } },
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
  drawPortfolioChart();
});
$('#pfPieOutstandingBtn').addEventListener('click', () => { pfPieMetric = 'outstanding'; drawPortfolioPie(); });
$('#pfPieAssessedBtn').addEventListener('click', () => { pfPieMetric = 'assessed'; drawPortfolioPie(); });

let chartA = null; // combined chart: assessed value vs outstanding principal
let chartB = null; // monthly chart: interest vs payment
let fullSeries = [];
let chartMeta = null;
let amortError = null; // last non-ok amortization response ({ error, code })
let detailProperty = null;
let equityData = null;
// Test/debug hook: lets the screenshot script read the live chart configs.
window.__fmCharts = Object.assign(window.__fmCharts || {}, { a: null, b: null });

function photoSrc(p) {
  if (p.photo_file) return `/photos/${p.photo_file}`;
  if (p.photo_url) return p.photo_url;
  return null;
}

async function loadPropertyDetail(id) {
  const p = await api(`/api/properties/${id}`);
  detailProperty = p;
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
  propOwnerPicker.set(p.owners || []);
  setMoneyValue(pf.assessed_value, p.assessed_value);
  pf.assessed_year.value = p.assessed_year ?? '';
  pf.purchase_date.value = p.purchase_date || '';
  $('#paymentDayInput').value = p.payment_day ?? '';
  const freqKey = FREQUENCY_LABELS[p.payment_frequency] ? p.payment_frequency : 'monthly';
  $('#paymentFrequencySelect').value = freqKey;
  syncFrequencyUi();
  const dayBit = DAY_STEPPED_FREQUENCIES.includes(freqKey)
    ? 'Payment day does not apply to this frequency.'
    : (p.payment_day ? `Payment day: the ${ordinal(p.payment_day)} of each month.` : 'Payment day: not set.');
  $('#paymentDayDisplay').textContent =
    `Payment frequency: ${FREQUENCY_LABELS[freqKey]}. ${dayBit} Both are managed in the Rate segments panel below.`;
  $('#regionDisplay').textContent = `Region: ${p.region === 'CA' || !p.region ? 'Canada (CA)' : esc(p.region)}.`;
  pf.photo_url.value = p.photo_url || '';
  $('#assessmentMeta').textContent =
    p.assessed_source === 'auto'
      ? `Source: BC Assessment (auto-fetched${p.assessed_fetched_at ? ' ' + new Date(p.assessed_fetched_at).toLocaleString('en-CA') : ''}${p.bca_matched_address ? ', matched "' + p.bca_matched_address + '"' : ''}${p.land_value != null ? `, land ${money(p.land_value)} + building ${money(p.building_value)}` : ''}). Editing the value above marks it as manual.`
      : p.assessed_source === 'manual'
        ? 'Source: entered manually. Use "Fetch from BC Assessment" to replace it with the official assessed value.'
        : 'No assessed value yet.';
  // A failed auto-refresh leaves the stored value in place; say so
  // quietly next to it rather than letting it look current.
  if (p.assessmentRefresh && p.assessmentRefresh.stale) {
    $('#assessmentMeta').textContent += ` The latest automatic check against BC Assessment failed (${p.assessmentRefresh.error || 'unknown error'}) — showing the last known value.`;
  }
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
  renderSegments(p.segments);
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

function renderSegments(segments) {
  $('#segmentRows').innerHTML = segments.map((s) => `<tr>
    <td>${esc(s.start_date)}</td>
    <td>${s.rate_type === 'fixed' ? '<span class="badge">Fixed</span>' : '<span class="badge var">Variable</span>'}</td>
    <td class="num">${esc(segmentRateText(s))}</td>
    <td><button class="small danger" onclick="deleteSegment(${s.id})">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="note" style="margin:0">No segments yet — add a rate plan to project this mortgage.</td></tr>';
}

async function deleteSegment(segId) {
  if (!confirm('Delete this rate segment?')) return;
  await api(`/api/properties/${currentPropertyId}/rates/${segId}`, { method: 'DELETE' });
  markAssetsDirty();
  loadPropertyDetail(currentPropertyId);
}
window.deleteSegment = deleteSegment;

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
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    markAssetsDirty();
    showMsg($('#detailMsg'), 'ok', 'Mortgage saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

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
    banner.textContent = `Bank of Canada prime: ${Number(cur.rate).toFixed(2)}% (as of ${primeInfoCache.asOf || cur.date}). Variable-rate projections assume prime stays at ${Number(cur.rate).toFixed(2)}%.`;
    const changes = primeInfoCache.changes || [];
    changesEl.textContent = changes.length > 1
      ? 'Recent: ' + changes.map((c) => `${Number(c.rate).toFixed(2)}% from ${c.date}`).join(' · ')
      : '';
  } else {
    banner.textContent = 'Bank of Canada prime: not available yet — the app fetches it from the Bank of Canada and keeps the last known value. Prime-based variable segments cannot be projected until a value is on record.';
    changesEl.textContent = '';
  }
  updateSegForm();
}

$('#primeRefreshBtn').addEventListener('click', async () => {
  try {
    primeInfoCache = await api('/api/prime/refresh', { method: 'POST' });
    markAssetsDirty(); // a new prime reprices every variable projection
    loadPrime();
    if (currentPropertyId) loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

// The add-segment form: Variable reveals the pricing mode; Prime +
// spread swaps the absolute-rate input for a spread input with a
// live preview against the tracked prime.
function updateSegForm() {
  const form = $('#addSegmentForm');
  if (!form) return;
  const isVariable = form.rate_type.value === 'variable';
  const isPrime = isVariable && form.rate_mode.value === 'prime_spread';
  $('#segModeWrap').classList.toggle('hidden', !isVariable);
  $('#segRateWrap').classList.toggle('hidden', isPrime);
  $('#segSpreadWrap').classList.toggle('hidden', !isPrime);
  form.annual_rate.required = !isPrime;
  const preview = $('#segSpreadPreview');
  if (isPrime) {
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
$('#addSegmentForm').rate_type.addEventListener('change', updateSegForm);
$('#addSegmentForm').rate_mode.addEventListener('change', updateSegForm);
$('#addSegmentForm').spread.addEventListener('input', updateSegForm);

$('#addSegmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const body = { start_date: f.start_date, rate_type: f.rate_type };
  if (f.rate_type === 'variable' && f.rate_mode === 'prime_spread') {
    body.rate_mode = 'prime_spread';
    body.spread = f.spread === '' ? null : Number(f.spread);
  } else {
    body.rate_mode = 'absolute';
    body.annual_rate = f.annual_rate;
  }
  try {
    await api(`/api/properties/${currentPropertyId}/rates`, { method: 'POST', body });
    markAssetsDirty();
    e.target.reset();
    updateSegForm();
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

// Payment frequency + payment day are property fields, but they are
// maintained here, with the rate plan: saving re-renders both charts
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
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#fetchBcaBtn').addEventListener('click', async () => {
  const msg = $('#detailMsg');
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
  const msg = $('#detailMsg');
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
    markAssetsDirty();
    showMsg($('#detailMsg'), 'ok', 'Photo uploaded.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

$('#deletePropertyBtn').addEventListener('click', async () => {
  if (!confirm('Delete this property, its rate segments and its photo?')) return;
  await api(`/api/properties/${currentPropertyId}`, { method: 'DELETE' });
  markAssetsDirty();
  location.hash = '#assets/properties';
});

// ------------------------------------------------------------ value trend ---
// Assessed-value history: one point per year. Auto points are written by
// BC Assessment fetches; manual points fill earlier years by hand. The
// points are drawn as the assessed-value line of the combined chart (A);
// the table below it stays the editor for the points.
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
    summary.textContent = 'Only one year on record — add earlier years below to see the trend.';
  } else {
    summary.textContent = 'No history yet — fetch from BC Assessment or add a point below.';
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
// Two charts, both driven by the same data:
//   A (combined): assessed value (yearly history points) vs outstanding
//     balance (monthly projection) on ONE axis — the gap is the equity.
//     The assessed line stops at the last known year; it is deliberately
//     NOT extended into the future (no invented forecast).
//   B (monthly): monthly interest vs monthly payment (both monthly flows).
// The projection only ever comes from the user's own rate plan (segments);
// with no plan the API reports NO_RATE_PLAN and chart B stays empty with
// a prompt instead of a made-up line.
async function loadChart(id) {
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
    el.textContent = `Latest assessed value: ${money(a.assessedValue)}${a.assessedYear ? ` (${a.assessedYear})` : ''}. Add the outstanding principal in the Mortgage panel to see the equity.`;
  } else if (a.balance !== null) {
    el.textContent = `Outstanding principal: ${money(a.balance)}. Fetch the assessed value from BC Assessment (or add a value-history point below) to see the equity.`;
  } else {
    el.textContent = 'Equity appears here once an assessed value and an outstanding principal is on record.';
  }
}

function renderDetailCharts() {
  renderEquity();
  renderTrendSummary(); // the summary follows the chart's current window
  drawCombinedChart();
  drawMonthlyChart();
}

function drawCombinedChart() {
  const ctx = $('#combinedChart');
  if (!ctx) return;
  if (chartA) { chartA.destroy(); chartA = null; }
  window.__fmCharts.a = null;
  // When the projection cannot be computed, say so right at this
  // chart (the assessed line still draws) instead of leaving a
  // silently missing blue line. Chart B shows the same state above
  // its own canvas.
  const cmsg = $('#combinedMsg');
  if (cmsg) {
    if (amortError && amortError.code === 'NO_RATE_PLAN') {
      showMsg(cmsg, 'warn', 'No projection yet — add a rate segment in the Rate segments panel above, and the outstanding-principal line will be projected from it.');
    } else if (amortError && amortError.code === 'NO_PAYMENT') {
      showMsg(cmsg, 'warn', 'The outstanding principal is not projected yet — add a monthly payment or remaining amortization in the Mortgage panel above to project it.');
    } else if (amortError) {
      showMsg(cmsg, 'warn', amortError.error);
    } else {
      cmsg.className = 'msg';
      cmsg.textContent = '';
    }
  }
  const datasets = [];
  const months = currentRangeMonths();
  const shownYears = [];
  let projStart = null;
  let projLastX = null;
  if (trendPoints.length) {
    // Assessed points inside the look-back window (All = every year
    // on record). The line still stops at the last known year — it
    // is not extended toward today (see the charts header comment).
    const shown = lookbackHistory(trendPoints, months);
    shownYears.push(...shown.map((pt) => pt.year).sort((a, b) => a - b));
    datasets.push({
      label: 'Assessed value',
      data: shown.map((pt) => ({ x: pt.year, y: pt.value })),
      borderColor: '#2e7d4f', backgroundColor: '#2e7d4f',
      // Stepped, like the portfolio line: the year's value holds flat
      // until the next assessment year — never a smoothed slide.
      stepped: 'before', tension: 0, pointRadius: 4, pointHoverRadius: 7, borderWidth: 2,
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
        label: 'Outstanding principal',
        data: pts,
        borderColor: '#1668c4', backgroundColor: '#1668c4',
        tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
      });
    }
  }
  if (!datasets.length) return;
  // The axis is exactly the selected window — never the library's
  // auto-fit (see mixedAxisWindow).
  const win = mixedAxisWindow({ months, assessedYears: shownYears, projStart, projLastX });
  chartA = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    plugins: [guideLinePlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => formatYearTick(items[0].parsed.x),
            label: (item) => ` ${item.dataset.label}: ${money(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { type: 'linear', ...(win || {}), ticks: { ...(win ? yearAxisTicks(win.min, win.max) : {}), callback: formatYearTick } },
        y: { ticks: { callback: moneyTick }, title: { display: true, text: 'Amount ($)' } },
      },
    },
  });
  window.__fmCharts.a = chartA;
}

function drawMonthlyChart() {
  const ctx = $('#monthlyChart');
  if (!ctx) return;
  if (chartB) { chartB.destroy(); chartB = null; }
  window.__fmCharts.b = null;
  const msg = $('#monthlyMsg');
  const summaryEl = $('#monthlySummary');
  msg.className = 'msg';
  summaryEl.textContent = '';
  if (!chartMeta) {
    if (amortError && amortError.code === 'NO_RATE_PLAN') {
      showMsg(msg, 'warn', 'Add a rate plan to see the projection — add a rate segment in the Rate segments panel above, and both charts will be calculated from it.');
    } else if (amortError && amortError.code === 'NO_PAYMENT') {
      showMsg(msg, 'warn', 'To project the mortgage, enter a monthly payment or a remaining amortization in the Mortgage panel above.');
    } else if (amortError) {
      showMsg(msg, 'warn', amortError.error);
    }
    return;
  }
  const months = currentRangeMonths();
  const rows = months > 0 ? fullSeries.slice(0, months) : fullSeries;
  if (!rows.length) return;
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const srcNote = chartMeta.paymentSource === 'derived' ? 'derived from remaining amortization' : 'entered';
  const payBit = !chartMeta.frequency || chartMeta.frequency === 'monthly'
    ? `Monthly payment used: ${money(chartMeta.paymentUsed)} (${srcNote})`
    : `Payments: ${chartMeta.frequencyLabel} — ${money(chartMeta.periodPayment)} per payment, converted from a monthly payment of ${money(chartMeta.paymentUsed)} (${srcNote})`;
  const bits = [
    payBit,
    `Interest in this range: ${money(totalInterest)}`,
    chartMeta.payoffMonth ? `Projected payoff: ${chartMeta.payoffMonth}` : 'Not paid off within the projection window',
  ];
  summaryEl.textContent = bits.join(' · ');
  if (chartMeta.negativeAmortization) {
    showMsg(msg, 'warn', 'Warning: the monthly payment is below the monthly interest in some months (negative amortization) — the balance grows there.');
  }
  chartB = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => r.date || r.month),
      datasets: [
        {
          label: 'Monthly interest',
          data: rows.map((r) => r.interest),
          borderColor: '#d97706', backgroundColor: '#d97706',
          tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
        },
        {
          // The series is sampled monthly, so for the day-stepped
          // frequencies this line is the month's total paid, not the
          // per-payment amount (that is in the summary line above).
          label: !chartMeta.frequency || chartMeta.frequency === 'monthly'
            ? `Monthly payment (${chartMeta.paymentSource === 'derived' ? 'derived from amortization' : 'entered'})`
            : 'Paid per month (all payments in the month)',
          data: rows.map((r) => r.payment),
          borderColor: '#7c3aed', backgroundColor: '#7c3aed',
          tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { ticks: { callback: moneyTick }, title: { display: true, text: 'Monthly amount ($)' } },
        x: { ticks: { maxTicksLimit: 12 } },
      },
    },
  });
  window.__fmCharts.b = chartB;
}

$('#rangeBtns').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-months]');
  if (!btn) return;
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.toggle('active', b === btn));
  $('#customMonths').value = '';
  renderDetailCharts();
});
$('#customMonths').addEventListener('change', () => {
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.remove('active'));
  renderDetailCharts();
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
