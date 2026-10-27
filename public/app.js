// Finance Mate — frontend (plain JS, no build step).
const $ = (sel, el = document) => el.querySelector(sel);
const money = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
// Schedule-derived money (payments, interest/principal splits,
// balances, equity, projection totals) always renders to the cent:
// the engine computes in cents end to end, and rounding each cell
// to whole dollars for display made rows disagree with their own
// Total and hid real differences against bank figures. Valuations
// (assessed values, history points) and entered asset values stay
// on money() — they are whole-dollar by nature.
const money2 = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : Number(n).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The ONE rendering rule for a payment triple — every surface that
// shows a monthly payment (term card figure, modal metadata,
// detail-page stat, property card, plan preview) renders through
// here, from the paymentUsed / paymentDerived / paymentOverridden
// fields the API serves at term level, property level and in the
// preview: not overridden → the amount alone; overridden → the
// used amount bold, the derived amount right after it struck
// through and muted.
function paymentHtml(t) {
  if (!t || t.paymentUsed === null || t.paymentUsed === undefined) return '—';
  if (t.paymentOverridden && t.paymentDerived !== null && t.paymentDerived !== undefined) {
    return `<span class="pay-used">${money2(t.paymentUsed)}</span> <s class="pay-derived">${money2(t.paymentDerived)}</s>`;
  }
  return money2(t.paymentUsed);
}

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
function openModal(id) {
  $('#' + id).classList.remove('hidden');
}
function closeModalEl(overlay) {
  overlay.classList.add('hidden');
  if (overlay && overlay.id === 'primeModal') destroyPrimeChart();
  if (overlay && overlay.id === 'historyModal') destroyHistoryChart();
}
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
// ------------------------------------------------------------- loading ---
// One global loading veil for re-renders: every hub load (assets +
// portfolio, property detail and its chart/trend/equity sub-loads,
// asset detail, admin) runs inside withLoading, so a slow refetch
// never leaves the interface half-updated — a full-screen blurred
// veil with a spinner covers the redraw. Counting: overlapping
// loads nest and the veil lifts only when the last one finishes,
// on success AND on failure — a failed load shows its error in
// #globalError and rethrows, exactly as un-wrapped callers
// expect. Anti-flash: the veil appears only when work outlasts
// 200ms, and once shown it stays at least 200ms, so fast redraws
// never see it (the same flash class the carousel fix removed).
const Loading = (() => {
  const SHOW_AFTER_MS = 200;
  const MIN_VISIBLE_MS = 200;
  let count = 0;
  let showTimer = null;
  let shownAt = 0;
  const el = () => document.getElementById('globalLoading');
  function paint() {
    const e = el();
    if (!e) return;
    if (count > 0) {
      if (!shownAt && !showTimer) {
        showTimer = setTimeout(() => {
          showTimer = null;
          if (count > 0) {
            shownAt = Date.now();
            e.classList.remove('hidden');
            e.setAttribute('aria-busy', 'true');
          }
        }, SHOW_AFTER_MS);
      }
    } else {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      if (shownAt) {
        const hide = () => {
          shownAt = 0;
          const n = el();
          if (n && count === 0) {
            n.classList.add('hidden');
            n.removeAttribute('aria-busy');
          }
        };
        const wait = MIN_VISIBLE_MS - (Date.now() - shownAt);
        if (wait > 0) setTimeout(hide, wait); else hide();
      }
    }
  }
  return {
    begin() { count++; paint(); },
    end() { count = Math.max(0, count - 1); paint(); },
    state() { const e = el(); return { count, visible: !!e && !e.classList.contains('hidden') }; },
  };
})();
window.__fmLoading = Loading;

function showGlobalError(err) {
  const b = document.getElementById('globalError');
  if (!b) return;
  b.textContent = err && err.message ? err.message : String(err);
  b.classList.remove('hidden');
}
function clearGlobalError() {
  const b = document.getElementById('globalError');
  if (b) { b.classList.add('hidden'); b.textContent = ''; }
}

async function withLoading(fn) {
  Loading.begin();
  try {
    const r = await fn();
    clearGlobalError();
    return r;
  } catch (err) {
    showGlobalError(err);
    throw err;
  } finally {
    Loading.end();
  }
}

async function loadAssets(force = false) { return withLoading(() => loadAssetsImpl(force)); }
async function loadPortfolio() { return withLoading(() => loadPortfolioImpl()); }
async function loadPropertyDetail(id) { return withLoading(() => loadPropertyDetailImpl(id)); }
async function loadAssetDetail(id) { return withLoading(() => loadAssetDetailImpl(id)); }
async function loadAdmin() { return withLoading(() => loadAdminImpl()); }
async function loadChart(id) { return withLoading(() => loadChartImpl(id)); }
async function loadTrend(id) { return withLoading(() => loadTrendImpl(id)); }
async function loadCosts(id) { return withLoading(() => loadCostsImpl(id)); }
async function loadEquity(id) { return withLoading(() => loadEquityImpl(id)); }

function markAssetsDirty() { assetsLoaded = false; }

async function loadAssetsImpl(force = false) {
  if (assetsLoaded && !force) return;
  assetsLoaded = true;
  const [summary, properties, assets] = await Promise.all([
    api('/api/summary'), api('/api/properties'), api('/api/assets'),
  ]);

  // Overview: totals + per-category breakdown cards.
  $('#sumProperty').textContent = money(summary.propertyValue);
  $('#sumMortgage').textContent = money2(summary.mortgageBalance);
  $('#sumOther').textContent = money(summary.otherAssets);
  const net = $('#sumNet');
  net.textContent = money2(summary.netWorth);
  net.classList.toggle('negative', summary.netWorth < 0);
  const byCategory = {};
  for (const a of assets) {
    byCategory[a.category] = byCategory[a.category] || { count: 0, total: 0 };
    byCategory[a.category].count++;
    byCategory[a.category].total += Number(a.value || 0);
  }
  const breakdown = [
    { key: 'properties', label: 'Properties', value: summary.propertyValue, note: `${summary.propertyCount} ${summary.propertyCount === 1 ? 'property' : 'properties'} · principal ${money2(summary.mortgageBalance)}` },
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

  // Properties listing. Each card's cover is the same
  // PhotoCarousel as the detail page, mounted over all the
  // property's photos (autoplay, arrows, hover/viewport pause);
  // a single photo is static and none shows the placeholder.
  for (const c of cardCarousels) c.destroy();
  cardCarousels.length = 0;
  $('#propertyCards').innerHTML = properties.map((p) => {
    const rate = p.currentRate
      ? `${p.currentRate.rate_type === 'fixed' ? 'Fixed' : 'Variable'} ${Number(p.currentRate.annual_rate).toFixed(2)}%`
      : 'No rate segments';
    const src = p.assessed_source === 'auto'
      ? `<span class="badge">BC Assessment${p.assessed_year ? ' ' + p.assessed_year : ''}</span>`
      : p.assessed_source === 'manual' ? '<span class="badge manual">Manual</span>' : '';
    return `<div class="card">
      <div class="photo" data-card-carousel="${p.id}"></div>
      <div class="body">
        <div class="addr">${esc(p.address)}${regionTagHtml(p.region)}</div>
        <div class="kv"><span class="k">Assessed value</span><span>${money(p.assessed_value)} ${src}</span></div>
        <div class="kv"><span class="k">Outstanding principal</span><span>${money2(p.remainingBalance != null ? p.remainingBalance : p.mortgage_balance)}</span></div>
        <div class="kv"><span class="k">Monthly payment</span><span>${paymentHtml(p)}</span></div>
        <div class="kv"><span class="k">Current rate</span><span>${rate}</span></div>
        ${p.owners && p.owners.length ? `<div class="kv"><span class="k">Owners</span><span>${ownerChipsHtml(p.owners)}</span></div>` : ''}
        <div class="toolbar"><button onclick="location.hash='#property/${p.id}'">Details</button></div>
      </div></div>`;
  }).join('') || '<div class="note">No properties yet — use “Add property” above.</div>';
  for (const p of properties) {
    const el = document.querySelector(`[data-card-carousel="${p.id}"]`);
    if (!el) continue;
    const c = new PhotoCarousel(el, { imgClass: 'card-photo', emptyHtml: 'No photo' });
    c.setPhotos(p.photos || [], 0);
    cardCarousels.push(c);
  }
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
async function loadAssetDetailImpl(id) {
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
  f.ai_fields = [...aiFlagSet(e.target)];
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

// ------------------------------------------------------------- AI fill ---
// "✨ Fill with AI" on the property and term forms: paste text or
// attach a photo / PDF, the server extracts candidate values
// (POST /api/ai/fill — extraction itself never saves), and the
// values land in the form's inputs through the normal input /
// change events, so money formatting, the live preview and the
// segment-form sync all react as if typed.
//
// Write rule: a field the user already filled by hand (non-empty,
// no AI flag) is NEVER overwritten — it is counted as "kept" in
// the panel summary. Filled fields carry a ✨ flag by their label;
// editing a flagged field by hand removes its flag at once. The
// flags ride along on the form's own Save (ai_fields) and are
// re-rendered from the server on load. A term form's panel also
// fills the term's segment form (segment_* keys).
const aiFlagSets = new WeakMap();

function aiFlagSet(form) {
  let s = aiFlagSets.get(form);
  if (!s) { s = new Set(); aiFlagSets.set(form, s); }
  return s;
}

function labelFor(el) {
  let host = el.parentElement;
  while (host) {
    const label = [...host.children].find((c) => c.tagName === 'LABEL');
    if (label) return label;
    if (host.tagName === 'FORM' || host.tagName === 'BODY') return null;
    host = host.parentElement;
  }
  return null;
}

function renderAiFlags(form) {
  form.querySelectorAll('.ai-flag').forEach((el) => el.remove());
  const pb = payBlockOfForm(form);
  if (pb) pb.querySelectorAll('.ai-flag').forEach((el) => el.remove());
  const set = aiFlagSets.get(form);
  if (!set) return;
  for (const name of set) {
    const input = fieldInputOf(form, name);
    let label = input ? labelFor(input) : null;
    if (!label && name === 'owners') {
      const picker = form.querySelector('.owner-picker');
      if (picker) label = labelFor(picker);
    }
    if (!label) continue;
    const s = document.createElement('span');
    s.className = 'ai-flag';
    s.title = 'Filled by AI';
    s.textContent = '✨';
    label.appendChild(s);
  }
}

// A hand edit to a flagged field clears its flag immediately.
function clearAiFlagOnEdit(e) {
  const t = e.target;
  if (!t || !t.name) return;
  const form = t.form || t.closest('form');
  if (!form || form._aiFilling) return;
  const set = aiFlagSets.get(form);
  if (set && set.delete(t.name)) renderAiFlags(form);
}
document.addEventListener('input', clearAiFlagOnEdit);
document.addEventListener('change', clearAiFlagOnEdit);

function fillOneInput(form, name, value) {
  const input = fieldInputOf(form, name);
  if (!input) return 'missing';
  const set = aiFlagSet(form);
  if (input.value !== '' && input.value != null && !set.has(name)) return 'kept';
  form._aiFilling = true;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  form._aiFilling = false;
  set.add(name);
  // An extracted payment lands in the Monthly payment row's
  // inline editor: reveal it in edit state (the ✨ flag renders
  // on that row's label via renderAiFlags below).
  if (name === 'payment_override') enterPayEdit(form, 'keep');
  return 'filled';
}

function applyAiFields(form, fields, extras = {}) {
  let filled = 0;
  let kept = 0;
  const tally = (r) => { if (r === 'filled') filled += 1; else if (r === 'kept') kept += 1; };
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'owners' && extras.ownersPicker) {
      const set = aiFlagSet(form);
      if (extras.ownersPicker.get().length && !set.has('owners')) { kept += 1; continue; }
      form._aiFilling = true;
      extras.ownersPicker.set(value);
      form._aiFilling = false;
      set.add('owners');
      filled += 1;
      continue;
    }
    if (key.startsWith('segment_') && extras.segForm) {
      tally(fillOneInput(extras.segForm, key.slice('segment_'.length), value));
      continue;
    }
    tally(fillOneInput(form, key, value));
  }
  renderAiFlags(form);
  if (extras.segForm) renderAiFlags(extras.segForm);
  return { filled, kept };
}

// The server's AI configuration (configured models + the
// persisted choice), shared by every Fill panel.
let aiConfigCache = null;
async function loadAiConfig() {
  if (!aiConfigCache) {
    try { aiConfigCache = await api('/api/ai/config'); }
    catch { aiConfigCache = { configured: false, models: [], model: null }; }
  }
  return aiConfigCache;
}

function attachAiFill(form, context, extras = {}) {
  if (!form || form.dataset.aiFillWired) return;
  form.dataset.aiFillWired = '1';
  const wrap = document.createElement('div');
  wrap.className = 'ai-fill';
  wrap.innerHTML = `
    <div class="ai-fill-bar">
      <button type="button" class="small" data-ai-toggle>✨ Fill with AI</button>
      <span class="note hidden" data-ai-summary style="margin:0"></span>
    </div>
    <div class="ai-panel hidden" data-ai-panel>
      <textarea rows="4" data-ai-text placeholder="Paste text from a document, or describe the values…"></textarea>
      <div class="ai-panel-row">
        <input type="file" accept="image/*,application/pdf" data-ai-file>
        <select data-ai-model title="Model" style="width:auto;flex:0 1 auto"></select>
        <button type="button" class="primary small" data-ai-extract>Extract</button>
      </div>
      <div class="msg" data-ai-msg></div>
    </div>`;
  form.prepend(wrap);
  const panel = wrap.querySelector('[data-ai-panel]');
  const summary = wrap.querySelector('[data-ai-summary]');
  const msg = wrap.querySelector('[data-ai-msg]');
  const extractBtn = wrap.querySelector('[data-ai-extract]');
  const modelSel = wrap.querySelector('[data-ai-model]');
  loadAiConfig().then((cfg) => {
    const models = cfg.models && cfg.models.length ? cfg.models : (cfg.model ? [cfg.model] : []);
    modelSel.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (cfg.model) modelSel.value = cfg.model;
  });
  wrap.querySelector('[data-ai-toggle]').addEventListener('click', () => panel.classList.toggle('hidden'));
  extractBtn.addEventListener('click', async () => {
    const text = wrap.querySelector('[data-ai-text]').value.trim();
    const fileInput = wrap.querySelector('[data-ai-file]');
    const file = fileInput.files && fileInput.files[0];
    msg.textContent = '';
    msg.className = 'msg';
    if (!text && !file) { showMsg(msg, 'err', 'Paste text or attach a photo / PDF first.'); return; }
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extracting…';
    try {
      const body = { context };
      if (modelSel.value) body.model = modelSel.value;
      if (text) body.text = text;
      if (file) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        body.file = { name: file.name, type: file.type, data: String(dataUrl).split(',')[1] || '' };
      }
      const r = await api('/api/ai/fill', { method: 'POST', body });
      if (body.model && aiConfigCache) aiConfigCache.model = body.model;
      const { filled, kept } = applyAiFields(form, r.fields || {}, extras);
      summary.textContent = `Filled ${filled} field${filled === 1 ? '' : 's'}${kept ? ` · ${kept} kept` : ''}`;
      summary.classList.remove('hidden');
      panel.classList.add('hidden');
    } catch (err) {
      showMsg(msg, 'err', err.message);
    } finally {
      extractBtn.disabled = false;
      extractBtn.textContent = 'Extract';
    }
  });
}

// Hand changes in an owner picker clear the owners flag, like
// hand edits in an input do.
function wireOwnersFlagClear(form, pickerRoot) {
  if (!pickerRoot) return;
  pickerRoot.addEventListener('click', () => {
    if (form._aiFilling) return;
    const set = aiFlagSets.get(form);
    if (set && set.delete('owners')) renderAiFlags(form);
  });
}

// Saving one of the mortgage modal's forms reloads the detail
// view, which rebuilds every form from the server — unsaved
// drafts in the OTHER forms (above all, AI-filled ones awaiting
// their own Save) would be lost. The term / segment saves
// therefore reload through this helper, which carries every term
// and segment form's draft values + AI flags across the rebuild.
function captureFormDrafts() {
  const grab = (form) => {
    const fields = {};
    form.querySelectorAll('input[name], select[name], textarea[name]').forEach((i) => { fields[i.name] = i.value; });
    // The payment editor's input lives in the pay block below
    // the form, not inside it: fold its value in by name.
    const pb = payBlockOfForm(form);
    if (pb) pb.querySelectorAll('input[name]').forEach((i) => { fields[i.name] = i.value; });
    return { fields, flags: [...(aiFlagSets.get(form) || [])] };
  };
  const terms = {};
  const segs = {};
  document.querySelectorAll('[data-term-form]').forEach((f) => { terms[f.dataset.termForm] = grab(f); });
  document.querySelectorAll('[data-seg-form]').forEach((f) => {
    const d = grab(f);
    // A segment form mid-edit carries its mode with the draft:
    // without it, the restored form would submit the edit as an
    // Add and duplicate the segment.
    d.editSeg = f.dataset.editSeg || null;
    segs[f.dataset.segForm] = d;
  });
  return { terms, segs };
}

function restoreFormDrafts(stash) {
  const put = (form, draft) => {
    if (!form || !draft) return;
    // The payment editor's fresh at-rest text (the stored
    // override, or blank), snapshotted before the draft lands.
    // The draft's editor value is judged by its SAVE OUTCOME
    // (blank, or a figure equal to the calculated one, saves as
    // no override; anything else saves as that override): when
    // the outcome differs from the stored override, the draft
    // carries a real unsaved payment edit and its edit state is
    // restored with it — never silently folded away; when the
    // outcome matches, the input is reset to mirror the stored
    // override, so the form rests exactly as rendered.
    const payInput = payEditEls(form).input;
    const freshPayText = payInput ? payInput.value : undefined;
    form._aiFilling = true;
    for (const [name, value] of Object.entries(draft.fields)) {
      const input = fieldInputOf(form, name);
      if (!input) continue;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    form._aiFilling = false;
    const set = aiFlagSet(form);
    set.clear();
    draft.flags.forEach((n) => set.add(n));
    renderAiFlags(form);
    if (payInput && draft.fields && 'payment_override' in draft.fields) {
      const cents = (x) => (x === '' || x == null ? null : Math.round(Number(x) * 100));
      const term = termOfForm(form);
      const derived = cents(term ? term.paymentDerived : null);
      const stored = cents(parseMoneyInput(freshPayText));
      const v = cents(parseMoneyInput(payInput.value));
      const draftOutcome = (v === null || v === derived) ? null : v;
      if (draftOutcome !== stored) enterPayEdit(form, 'keep');
      else payInput.value = freshPayText;
    }
  };
  document.querySelectorAll('[data-term-form]').forEach((f) => put(f, stash.terms[f.dataset.termForm]));
  document.querySelectorAll('[data-seg-form]').forEach((f) => {
    const d = stash.segs[f.dataset.segForm];
    put(f, d);
    syncSegForm(f);
    if (d && d.editSeg) f.dataset.editSeg = d.editSeg; else delete f.dataset.editSeg;
    reflectSegEditMode(f);
  });
}

async function reloadDetailKeepingDrafts() {
  const stash = captureFormDrafts();
  await loadPropertyDetail(currentPropertyId);
  restoreFormDrafts(stash);
}

attachAiFill($('#addPropForm'), 'property', { ownersPicker: addPropOwnerPicker });
attachAiFill($('#propForm'), 'property', { ownersPicker: propOwnerPicker });
wireOwnersFlagClear($('#addPropForm'), $('#addPropOwnerPicker'));
wireOwnersFlagClear($('#propForm'), $('#propOwnerPicker'));

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

async function loadPortfolioImpl() {
  const block = $('#portfolioBlock');
  portfolioData = await api('/api/properties/portfolio');
  renderPrimeWarning($('#pfPrimeWarning'), portfolioData && portfolioData.prime);
  if (!portfolioData || !portfolioData.totals.propertyCount) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  const t = portfolioData.totals;
  $('#pfEquity').textContent = t.equity != null ? money2(t.equity) : '—';
  $('#pfOutstanding').textContent = money2(t.outstanding);
  $('#pfPayment').textContent = money2(t.monthlyPayment);
  $('#pfInterest').textContent = money2(t.totalInterest);
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
    notes.push(`${t.planNoPaymentCount} of ${t.propertyCount} ${propNoun} ${t.planNoPaymentCount === 1 ? 'has' : 'have'} a rate plan but no projection — set the remaining amortization on its term to project.`);
  }
  if (t.planNoPrimeCount > 0) {
    notes.push(`${t.planNoPrimeCount} of ${t.propertyCount} ${propNoun} ${t.planNoPrimeCount === 1 ? 'is' : 'are'} priced off the prime rate, which is not on record yet — the projection starts once prime has been fetched.`);
  }
  if (t.paymentKnownCount < t.propertyCount) {
    notes.push(`Monthly payment counts ${t.paymentKnownCount} of ${t.propertyCount} properties — the rest have no payment on file and count as $0.`);
  }
  if (t.equityExcluded > 0) {
    notes.push(`Total equity excludes ${t.equityExcluded} of ${t.propertyCount} ${propNoun} without an assessed value.`);
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

// ---------------------------------------------------------- chart colors ---
// The multi-series charts (the detail page's hero chart, the
// Assessment History chart, the portfolio combined chart) let the
// user recolor each series. The choices are a per-user preference
// (server key 'chart_colors': { chartId: { seriesKey: '#rrggbb' } }),
// fetched at sign-in and stored in the DB; a series with no stored
// color uses its default — the defaults below are exactly the
// colors the charts have always used. Series are keyed by their
// semantic name, never by dataset index, so a stored color keeps
// matching its series if a chart's datasets are reordered or one
// is added/removed (a stored key that no longer exists is simply
// never read). Single-series charts (prime, the portfolio pie)
// are not recolorable.
const CHART_SERIES = {
  hero: [
    { key: 'assessed', label: 'Assessed value', bg: '#2e7d4f', border: '#2e7d4f', bgAlpha: null },
    { key: 'outstanding', label: 'Outstanding principal', bg: '#1668c4', border: '#1668c4', bgAlpha: null },
    { key: 'equity', label: 'Current equity', bg: '#7c3aed', border: '#7c3aed', bgAlpha: null },
    { key: 'interest', label: 'Interest portion', bg: '#d97706', border: '#d97706', bgAlpha: null },
    { key: 'principal', label: 'Principal portion', bg: '#2e7d4f', border: '#2e7d4f', bgAlpha: null },
  ],
  history: [
    { key: 'land', label: 'Land', bg: 'rgba(230, 126, 34, 0.8)', border: '#e67e22', bgAlpha: 0.8 },
    { key: 'building', label: 'Building', bg: 'rgba(22, 104, 196, 0.8)', border: '#1668c4', bgAlpha: 0.8 },
    { key: 'total', label: 'Total', bg: 'rgba(46, 125, 79, 0.75)', border: '#2e7d4f', bgAlpha: 0.75 },
  ],
  portfolio: [
    { key: 'assessed', label: 'Assessed value (all properties)', bg: '#2e7d4f', border: '#2e7d4f', bgAlpha: null },
    { key: 'outstanding', label: 'Total outstanding principal', bg: '#1668c4', border: '#1668c4', bgAlpha: null },
    { key: 'equity', label: 'Total equity', bg: '#7c3aed', border: '#7c3aed', bgAlpha: null },
  ],
};
let chartColorPrefs = {};

async function loadChartColorPrefs() {
  try {
    const r = await api('/api/preferences');
    chartColorPrefs = (r.preferences && r.preferences.chart_colors) || {};
  } catch { chartColorPrefs = {}; }
}

const chartSeriesDef = (chartId, key) => (CHART_SERIES[chartId] || []).find((d) => d.key === key) || null;

function portfolioPropDef(p, i) {
  return { key: `prop_${p.id}`, label: p.shortLabel, bg: PF_COLORS[i % PF_COLORS.length], border: null, bgAlpha: null };
}

function portfolioSeriesDefs() {
  const defs = [...CHART_SERIES.portfolio];
  if (portfolioData) portfolioData.properties.forEach((p, i) => defs.push(portfolioPropDef(p, i)));
  return defs;
}

function seriesDefFor(chartId, key) {
  return chartId === 'portfolio'
    ? portfolioSeriesDefs().find((d) => d.key === key) || null
    : chartSeriesDef(chartId, key);
}

function hexToRgba(hex, alpha) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// The colors a series draws with: no stored color -> the defaults
// verbatim; a stored hex -> the border takes it whole and the
// fill takes it at the series' own fill alpha.
function seriesColors(chartId, def) {
  if (!def) return {};
  const custom = chartColorPrefs[chartId] ? chartColorPrefs[chartId][def.key] : null;
  if (!custom) return { backgroundColor: def.bg, borderColor: def.border };
  return {
    backgroundColor: def.bgAlpha == null ? custom : hexToRgba(custom, def.bgAlpha),
    borderColor: def.border ? custom : def.bg,
  };
}

let chartColorSaveTimer = null;
function saveChartColorPrefs(immediate = false) {
  clearTimeout(chartColorSaveTimer);
  const put = () => {
    api('/api/preferences/chart_colors', { method: 'PUT', body: { value: chartColorPrefs } }).catch(() => {});
  };
  if (immediate) put();
  else chartColorSaveTimer = setTimeout(put, 400);
}

const LIVE_CHARTS = { hero: () => chartA, history: () => historyChart, portfolio: () => portfolioLineChart };

// Recolor the live chart instance in place (the builders also
// read the same preferences when a chart is rebuilt).
function applyChartColors(chartId) {
  const get = LIVE_CHARTS[chartId];
  const chart = get ? get() : null;
  if (!chart) return;
  for (const ds of chart.data.datasets) {
    if (!ds.key) continue;
    const def = seriesDefFor(chartId, ds.key);
    if (!def) continue;
    const c = seriesColors(chartId, def);
    ds.backgroundColor = c.backgroundColor;
    if (def.border) ds.borderColor = c.borderColor;
  }
  chart.update('none');
}

// One row per series: its name, a native color input holding the
// current color, and one Reset for the whole chart. The row of
// the series last right-clicked in the legend (see the legend
// gestures below) renders highlighted.
function buildColorsPanel(chartId) {
  const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
  if (!panel) return;
  const defs = chartId === 'portfolio' ? portfolioSeriesDefs() : (CHART_SERIES[chartId] || []);
  panel.innerHTML = defs.map((def) => {
    const current = (chartColorPrefs[chartId] && chartColorPrefs[chartId][def.key]) || def.border || def.bg;
    const hl = legendHighlightKey[chartId] === def.key ? ' cc-highlight' : '';
    return `<span class="cc-row${hl}"><span>${esc(def.label)}</span><input type="color" data-color-input="${esc(def.key)}" value="${esc(current)}"></span>`;
  }).join('') + '<button type="button" class="small" data-colors-reset>Reset</button>';
}

document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-colors-toggle]');
  if (toggle) {
    const panel = document.querySelector(`[data-colors-panel="${toggle.dataset.colorsToggle}"]`);
    if (!panel) return;
    if (panel.classList.contains('hidden')) { buildColorsPanel(toggle.dataset.colorsToggle); panel.classList.remove('hidden'); }
    else panel.classList.add('hidden');
    return;
  }
  const reset = e.target.closest('[data-colors-reset]');
  if (reset) {
    const panel = reset.closest('[data-colors-panel]');
    if (!panel) return;
    const chartId = panel.dataset.colorsPanel;
    delete chartColorPrefs[chartId];
    saveChartColorPrefs(true);
    applyChartColors(chartId);
    buildColorsPanel(chartId);
  }
});
document.addEventListener('input', (e) => {
  const input = e.target.closest ? e.target.closest('[data-color-input]') : null;
  if (!input) return;
  const panel = input.closest('[data-colors-panel]');
  if (!panel) return;
  const chartId = panel.dataset.colorsPanel;
  if (!chartColorPrefs[chartId]) chartColorPrefs[chartId] = {};
  chartColorPrefs[chartId][input.dataset.colorInput] = input.value;
  applyChartColors(chartId);
  saveChartColorPrefs(false);
});
document.addEventListener('change', (e) => {
  if (e.target.closest && e.target.closest('[data-color-input]')) saveChartColorPrefs(true);
});

// ------------------------------------------------ legend gestures ---
// On the three recolorable charts the legend is interactive. A
// LEFT click on a legend item toggles that series' visibility —
// Chart.js' default legend behavior, which no chart here
// overrides; the item takes the legend's struck-through hidden
// style. Visibility is view state only: it is never stored (the
// preferences hold colors and nothing else). A RIGHT click on a
// legend item opens that chart's Colors panel with the clicked
// series' row highlighted, and suppresses the browser's context
// menu; the Colors button stays for touch, which has no right
// click. All three charts behave identically.
const legendHighlightKey = {}; // chartId -> series key last right-clicked

function openColorsPanel(chartId, focusKey) {
  const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
  if (!panel) return;
  if (focusKey != null) legendHighlightKey[chartId] = focusKey;
  buildColorsPanel(chartId);
  panel.classList.remove('hidden');
}

// The legend item under a mouse event on the chart's canvas, or
// null. Chart.js lays the legend out in the canvas' own CSS-pixel
// space — the same space as the event's offset within the canvas
// box — so the hit boxes can be tested directly.
function legendItemAt(chart, e) {
  const legend = chart && chart.legend;
  if (!legend || !legend.legendItems || !legend.legendHitBoxes) return null;
  const rect = chart.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  for (let i = 0; i < legend.legendHitBoxes.length; i++) {
    const b = legend.legendHitBoxes[i];
    if (b && x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
      return legend.legendItems[i] || null;
    }
  }
  return null;
}

function wireLegendContextMenu(chartId, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.addEventListener('contextmenu', (e) => {
    const get = LIVE_CHARTS[chartId];
    const chart = get ? get() : null;
    const item = chart && legendItemAt(chart, e);
    if (!item) return;
    e.preventDefault();
    const ds = chart.data.datasets[item.datasetIndex];
    openColorsPanel(chartId, ds && ds.key != null ? ds.key : null);
  });
}
wireLegendContextMenu('hero', 'combinedChart');
wireLegendContextMenu('history', 'historyChart');
wireLegendContextMenu('portfolio', 'portfolioChart');

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
              return ` ${s.shortLabel}: ${money2(s.value)} (${s.pct}%)`;
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
      key: 'assessed',
      label: 'Assessed value (all properties)',
      data: assessedData,
      ...seriesColors('portfolio', chartSeriesDef('portfolio', 'assessed')),
      // One point per assessment year, joined by straight line
      // segments (tension 0 — no smoothing curve, no step).
      showLine: true, tension: 0, pointRadius: 5, pointHoverRadius: 7,
    });
  }
  if (rows.length) {
    datasets.push({
      type: 'line',
      key: 'outstanding',
      label: 'Total outstanding principal',
      data: rows.map((m) => ({ x: ymDecimal(m.month), y: m.total })),
      ...seriesColors('portfolio', chartSeriesDef('portfolio', 'outstanding')),
      tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
    });
    const equityByMonth = new Map((portfolioData.equityByMonth || []).map((e) => [e.month, e.value]));
    const equityData = rows
      .filter((m) => equityByMonth.get(m.month) != null)
      .map((m) => ({ x: ymDecimal(m.month), y: equityByMonth.get(m.month) }));
    if (equityData.length) {
      datasets.push({
        type: 'line',
        key: 'equity',
        label: 'Total equity',
        data: equityData,
        ...seriesColors('portfolio', chartSeriesDef('portfolio', 'equity')),
        tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
      });
    }
    portfolioData.properties.forEach((p, i) => {
      datasets.push({
        type: 'bar',
        key: `prop_${p.id}`,
        label: p.shortLabel,
        data: rows.map((m) => ({ x: ymDecimal(m.month), y: m.byProperty[p.id] ?? null })),
        backgroundColor: seriesColors('portfolio', portfolioPropDef(p, i)).backgroundColor,
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
            label: (item) => ` ${item.dataset.label}: ${item.dataset.key === 'assessed' ? money(item.parsed.y) : money2(item.parsed.y)}`,
            footer: (items) => {
              const bars = items.filter((i) => i.dataset.stack === 'outstanding');
              if (!bars.length) return '';
              const total = bars.reduce((s, i) => s + (i.parsed.y || 0), 0);
              return `Total outstanding: ${money2(total)}`;
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
let schedulePageFirst = false; // a range change reopens the schedule on the range's FIRST year page
let customRange = null; // detail chart range the user picked by month { start, end } ('YYYY-MM'); null = a preset rules
let monthPopFor = null; // which From/To field the month picker is open for: 'start' | 'end' | null
let monthPopYear = null; // the year the open month picker is browsing
let amortError = null; // last non-ok amortization response ({ error, code })
let detailProperty = null;
let equityData = null;
// Test/debug hook: lets the screenshot script read the live chart configs.
window.__fmCharts = Object.assign(window.__fmCharts || {}, { a: null, b: null, prime: null, history: null });

// ------------------------------------------------------------ photos ---
// The detail page's gallery: a carousel over the property's photos
// (uploads, plus a legacy external URL entry when one is still on the
// record). The VIEW shows the carousel alone — main photo, prev/next
// arrows and the n / N count. Photo MANAGEMENT (the thumbnail strip,
// Add photos, Remove this photo) lives in the Property Details Edit
// form (see renderPhotoManage); uploads and removals there still take
// effect at once through the photos endpoints. The first photo is
// the Properties card cover.
let photoIndex = 0;

// One photo carousel implementation, shared by the detail page
// (mounted below) and the Properties cards: main photo, prev/next
// arrows and an n / N count, plus autoplay — advance every ~4s
// with wrap-around; a manual step resets the timer; hovering, a
// hidden tab or an off-screen mount pauses it (Intersection-
// Observer); prefers-reduced-motion disables it; a single photo
// (or none) never plays. The delay reads window.__fmPhotoDelay
// when a test sets it.
const PHOTO_AUTOPLAY_MS = 4000;
class PhotoCarousel {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.photos = [];
    this.index = 0;
    this.desired = 0;
    this.slideEls = [];
    this.gen = 0;
    this.timer = null;
    this.hover = false;
    this.inView = true;
    root.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-photo-nav]');
      if (nav) { this.step(Number(nav.dataset.photoNav)); return; }
      if (e.target.closest('[data-photo-add]') && this.opts.onAdd) this.opts.onAdd();
    });
    root.addEventListener('mouseenter', () => { this.hover = true; });
    root.addEventListener('mouseleave', () => { this.hover = false; });
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((es) => { this.inView = es[0].isIntersecting; });
      this.io.observe(root);
    }
  }
  setPhotos(photos, index = 0) {
    this.photos = photos || [];
    this.index = Math.min(Math.max(0, index), Math.max(0, this.photos.length - 1));
    this.desired = this.index;
    this.render();
    this.requestShow(this.index, false);
    this.syncTimer();
  }
  step(delta) {
    if (this.photos.length < 2) return;
    this.setIndex((this.desired + delta + this.photos.length) % this.photos.length);
  }
  setIndex(i) {
    if (i < 0 || i >= this.photos.length) { this.syncTimer(); return; }
    this.desired = i;
    this.requestShow(i, i !== this.index);
    this.syncTimer();
  }
  // Slides are built ONCE per photo set and stay in the DOM: every
  // photo starts loading (and decoding) immediately, a switch is a
  // class flip between resident slides, and it only happens once
  // the target slide is loaded + decoded — the outgoing slide stays
  // visible until then, so a switch can never paint an empty frame
  // (the pre-fix render() destroyed the old <img> and inserted a
  // fresh one, which flashed blank and, with no reserved height,
  // collapsed the box until the new photo arrived).
  render() {
    this.gen++;
    const photos = this.photos;
    this.slideEls = [];
    if (!photos.length) {
      this.root.innerHTML = this.opts.emptyHtml || '';
      return;
    }
    const imgClass = this.opts.imgClass || 'detail-photo';
    this.root.innerHTML = `<div class="photo-carousel">
      <div class="photo-stage">
        ${photos.map((p) => `<img class="slide ${imgClass}" src="${esc(p.src)}" alt="">`).join('')}
        ${photos.length > 1 ? `
          <button type="button" class="carousel-nav prev" data-photo-nav="-1" aria-label="Previous photo">&#8249;</button>
          <button type="button" class="carousel-nav next" data-photo-nav="1" aria-label="Next photo">&#8250;</button>` : ''}
      </div>
      <div class="carousel-bar">
        <span class="carousel-count"></span>
      </div>
    </div>`;
    this.slideEls = [...this.root.querySelectorAll('img.slide')];
    for (const img of this.slideEls) if (img.decode) img.decode().catch(() => {});
  }
  slideReady(i) {
    const img = this.slideEls[i];
    return !!img && img.complete && img.naturalWidth > 0;
  }
  requestShow(i, notify) {
    const gen = this.gen;
    if (this.slideReady(i)) { this.flip(i, notify); return; }
    const img = this.slideEls[i];
    if (!img) return;
    const done = () => { if (this.gen === gen && this.desired === i) this.flip(i, notify); };
    if (img.decode) img.decode().then(done).catch(done);
    else img.addEventListener('load', done, { once: true });
  }
  flip(i, notify) {
    this.index = i;
    const stage = this.root.querySelector('.photo-stage');
    this.slideEls.forEach((img, k) => img.classList.toggle('active', k === i));
    // Keep the active slide first in the stage so a plain
    // querySelector('img.<class>') reads the visible photo.
    const active = this.slideEls[i];
    if (stage && active && stage.firstElementChild !== active) stage.insertBefore(active, stage.firstElementChild);
    const count = this.root.querySelector('.carousel-count');
    if (count) count.textContent = `${i + 1} / ${this.photos.length}`;
    if (notify && this.opts.onIndex) this.opts.onIndex(i);
  }
  syncTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.photos.length < 2) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const delay = Number(window.__fmPhotoDelay) > 0 ? Number(window.__fmPhotoDelay) : PHOTO_AUTOPLAY_MS;
    this.timer = setInterval(() => {
      if (document.hidden || this.hover || !this.inView) return;
      this.step(1);
    }, delay);
  }
  destroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.io) this.io.disconnect();
  }
}

// Live card-cover carousels on the Properties listing (destroyed
// and rebuilt on every listing render).
const cardCarousels = [];

const detailCarousel = new PhotoCarousel($('#photoArea'), {
  emptyHtml: '<div class="detail-photo-empty photo-clickable" data-photo-add>No photos yet — click to add photos</div>',
  onAdd: () => $('#photoFiles').click(),
  onIndex: (i) => { photoIndex = i; renderPhotoManage(detailProperty); },
});

function renderPhotos(p) {
  const photos = (p && p.photos) || [];
  if (photoIndex >= photos.length) photoIndex = Math.max(0, photos.length - 1);
  if (photoIndex < 0) photoIndex = 0;
  detailCarousel.setPhotos(photos, photoIndex);
  renderPhotoManage(p);
}

function stepPhoto(delta) {
  detailCarousel.step(delta);
}

// The Edit form's photo management: the thumbnail strip (a click
// selects that photo in the carousel, as before), Add photos and
// Remove this photo — the actions the view used to carry, now
// behind Edit. Nothing waits for the form's Save: uploads and
// removals apply immediately, exactly as they did from the view.
function renderPhotoManage(p) {
  const host = $('#photoManage');
  if (!host) return;
  const photos = (p && p.photos) || [];
  if (!photos.length) {
    host.innerHTML = '<div class="toolbar"><button type="button" class="small" data-photo-add-btn>Add photos</button></div>';
    return;
  }
  const idx = Math.min(Math.max(0, photoIndex), photos.length - 1);
  host.innerHTML = `
    <div class="photo-thumbs">${photos.map((ph, i) => `<button type="button" class="thumb${i === idx ? ' active' : ''}" data-photo-dot="${i}" aria-label="Photo ${i + 1}"><img src="${esc(ph.src)}" alt=""></button>`).join('')}</div>
    <div class="toolbar">
      <span class="carousel-count">${idx + 1} / ${photos.length}</span>
      <button type="button" class="small" data-photo-add-btn>Add photos</button>
      <button type="button" class="small danger" data-photo-remove>Remove this photo</button>
    </div>`;
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

$('#photoManage').addEventListener('click', (e) => {
  const dot = e.target.closest('[data-photo-dot]');
  if (dot) { detailCarousel.setIndex(Number(dot.dataset.photoDot)); return; }
  if (e.target.closest('[data-photo-remove]')) { removeCurrentPhoto(); return; }
  if (e.target.closest('[data-photo-add-btn]')) { $('#photoFiles').click(); }
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
  // The details lead with three headline figures — the assessed
  // value (re-based on the latest history point when the trend
  // loads, as the equity readout reads it), TODAY's remaining
  // balance (the projection's balance at the current month, not
  // the anchor the loan started from) and the current equity
  // (assessed minus remaining; a property with no mortgage on
  // record owes nothing, so its equity is the full assessed
  // value) — over
  // exactly three rows: address (with the region flag tag), owners,
  // purchase date. Nothing else lives here by the user's ruling:
  // no notes / assessment-year / lender rows, no prose lines.
  $('#detailAssessedValue').textContent = p.assessed_value != null ? money(p.assessed_value) : '—';
  const remaining = p.remainingBalance != null ? p.remainingBalance : p.mortgage_balance;
  $('#detailRemainingBalance').textContent = remaining != null ? money2(remaining) : '—';
  $('#detailCurrentEquity').textContent = p.assessed_value != null
    ? money2(p.assessed_value - (remaining != null ? remaining : 0))
    : '—';
  const rows = [
    ['Address', `${esc(p.address || '—')}${regionTagHtml(p.region)}`, true],
    ['Owners', p.owners && p.owners.length ? ownerChipsHtml(p.owners) : '—', true],
    ['Purchase date', p.purchase_date || '—'],
  ];
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
  const flags = aiFlagSet(pf);
  flags.clear();
  (p.ai_fields || []).forEach((n) => flags.add(n));
  renderAiFlags(pf);
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
$('#openHistoryBtn').addEventListener('click', () => { openModal('historyModal'); renderHistoryChart(); });

$('#editPropBtn').addEventListener('click', () => {
  if (!detailProperty) return;
  fillPropForm(detailProperty);
  setPropEditing(true);
});

$('#cancelPropEditBtn').addEventListener('click', () => {
  if (detailProperty) fillPropForm(detailProperty); // discard the edits
  setPropEditing(false);
});

// ------------------------------------------------- page outline ---
// Floating Google Docs-style section index for the property
// detail page. Entries are built from the panels that actually
// rendered (each carries data-outline), so a missing section
// yields no entry. "Assessment History" has no panel of its own
// on this page — it lives in a modal — so its entry rides along
// with the projection panel and opens that modal instead of
// scrolling. Scrollspy highlights the section in view.
//
// Auto-hide: the outline shows itself only while the page is
// scrolling — hidden when the page opens, it fades in on scroll
// and back out ~2.5s after scrolling stops. Holds pause the
// countdown so it never vanishes from under the user: the pointer
// hovering it ('hover'), keyboard focus inside it ('focus'), or
// the narrow-screen card standing open ('open'). The delay lives
// in a variable (window.__fmOutline lets tests shorten it instead
// of waiting out the real one).
let outlineTargets = [];
let outlineHideMs = 2500;
let outlineHideTimer = null;
const outlineHolds = new Set();
window.__fmOutline = { setHideDelay: (ms) => { outlineHideMs = ms; } };

function outlineArmHide() {
  clearTimeout(outlineHideTimer);
  outlineHideTimer = null;
  if (outlineHolds.size) return;
  outlineHideTimer = setTimeout(() => {
    outlineHideTimer = null;
    const nav = $('#propOutline');
    if (nav && !outlineHolds.size) nav.classList.remove('awake');
  }, outlineHideMs);
}

function outlineWake() {
  const nav = $('#propOutline');
  if (!nav) return;
  nav.classList.add('awake');
  outlineArmHide();
}

function outlineHold(reason, on) {
  if (on) {
    outlineHolds.add(reason);
    const nav = $('#propOutline');
    if (nav) nav.classList.add('awake');
  } else {
    outlineHolds.delete(reason);
  }
  outlineArmHide();
}

function setOutlineActive(id) {
  document.querySelectorAll('#propOutlineList a[data-target]').forEach((a) =>
    a.classList.toggle('active', a.dataset.target === id));
}

function updateOutlineSpy() {
  if (!outlineTargets.length) return;
  if ($('#view-property').classList.contains('hidden')) return;
  const LINE = 84; // the sticky topbar (52px) + breathing room
  let current = outlineTargets[0];
  for (const t of outlineTargets) {
    if (t.el.getBoundingClientRect().top <= LINE) current = t;
  }
  // At the very bottom the last section's top may never cross the
  // line — it is the current one all the same.
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
    current = outlineTargets[outlineTargets.length - 1];
  }
  if (current) setOutlineActive(current.id);
}

function closePropOutline() {
  $('#propOutline').classList.remove('open');
  $('#propOutlineToggle').setAttribute('aria-expanded', 'false');
  outlineHold('open', false);
}

function buildPropOutline() {
  const list = $('#propOutlineList');
  if (!list) return;
  // A freshly opened property starts with the outline hidden; it
  // appears when the user starts scrolling.
  const nav0 = $('#propOutline');
  if (nav0) nav0.classList.remove('awake');
  outlineHolds.clear();
  clearTimeout(outlineHideTimer);
  outlineHideTimer = null;
  list.innerHTML = '';
  outlineTargets = [];
  for (const sec of document.querySelectorAll('#view-property [data-outline]')) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = sec.dataset.outline;
    a.dataset.target = sec.id;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setOutlineActive(sec.id);
      closePropOutline();
    });
    li.appendChild(a);
    list.appendChild(li);
    outlineTargets.push({ id: sec.id, el: sec });
    if (sec.id === 'projectionPanel' && $('#openHistoryBtn')) {
      const hli = document.createElement('li');
      const ha = document.createElement('a');
      ha.textContent = 'Assessment History';
      ha.addEventListener('click', (e) => {
        e.preventDefault();
        closePropOutline();
        $('#openHistoryBtn').click();
      });
      hli.appendChild(ha);
      list.appendChild(hli);
    }
  }
  updateOutlineSpy();
}

$('#propOutlineToggle').addEventListener('click', () => {
  const open = $('#propOutline').classList.toggle('open');
  $('#propOutlineToggle').setAttribute('aria-expanded', String(open));
  outlineHold('open', open);
});
document.addEventListener('click', (e) => {
  const nav = $('#propOutline');
  if (nav && nav.classList.contains('open') && !nav.contains(e.target)) closePropOutline();
});
// Holds: hovering the outline or keeping keyboard focus inside it
// pauses the auto-hide countdown; leaving releases it.
const propOutlineNav = $('#propOutline');
propOutlineNav.addEventListener('mouseenter', () => outlineHold('hover', true));
propOutlineNav.addEventListener('mouseleave', () => outlineHold('hover', false));
propOutlineNav.addEventListener('focusin', () => outlineHold('focus', true));
propOutlineNav.addEventListener('focusout', (e) => {
  if (!propOutlineNav.contains(e.relatedTarget)) outlineHold('focus', false);
});
window.addEventListener('scroll', () => {
  updateOutlineSpy();
  if (!$('#view-property').classList.contains('hidden')) outlineWake();
}, { passive: true });

async function loadPropertyDetailImpl(id) {
  const p = await api(`/api/properties/${id}`);
  detailProperty = p;
  photoIndex = 0;
  renderPhotos(p);
  renderPropView(p);
  fillPropForm(p);
  setPropEditing(false);
  buildPropOutline();

  // No source/status prose anywhere: where a value came from is
  // visible in the Assessment History chart and table (each point
  // carries its source), and fetch/pull outcomes show there too.
  chartMeta = null; // the previous property's projection must not leak into this page's summary
  amortError = null;
  renderTerms(p);
  renderMortgageMeta();
  loadPrime();
  loadChart(id);
  loadTrend(id);
  loadEquity(id);
  loadCosts(id);
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

// ------------------------------------------------ payment editor ---
// The term's Monthly payment is a read-only figure with an Edit
// button: Edit swaps the figure for an input in place, prefilled
// with the used payment, the calculated figure kept beside it as
// the reference (struck through while an override stands, muted
// otherwise). There is NO separate override field — the input
// lives in the payment row, named payment_override, and at rest
// it simply mirrors the stored override. On Save, a blank input,
// or one equal to the calculated figure, clears the override; any
// other positive figure becomes it. Reset (shown only while an
// override stands) puts the calculated figure back in the box, so
// saving after Reset clears the override too.
// The payment row CLOSES the term card — below the rate segments
// and the lump sums, because the figure is the RESULT of those
// inputs — so it is not a descendant of the term <form>: its
// input belongs to the form through the HTML form attribute
// (FormData, the form's named access and the server submit all
// see it the same). Lookups for the row therefore scope to its
// pay block inside the term block, never to the form element.
function payBlockOfForm(form) {
  if (!form || !form.dataset || form.dataset.termForm == null) return null;
  const block = form.closest('[data-term-block]');
  return block ? block.querySelector('[data-pay-block]') : null;
}

function termFormOfPayBlock(block) {
  return block ? document.querySelector(`[data-term-form="${block.dataset.payBlock}"]`) : null;
}

function payEditEls(form) {
  const scope = payBlockOfForm(form) || form;
  return {
    input: scope.querySelector('[data-pay-edit-input]'),
    view: scope.querySelector('[data-term-payment]'),
    editBtn: scope.querySelector('[data-pay-edit]'),
    resetBtn: scope.querySelector('[data-pay-reset]'),
    ref: scope.querySelector('[data-pay-derived-ref]'),
  };
}

// A form field's input: the form's own descendant — except the
// payment row's override editor, which lives in the pay block
// below the form.
function fieldInputOf(form, name) {
  const own = form.querySelector(`[name="${name}"]`);
  if (own) return own;
  const pb = payBlockOfForm(form);
  return pb ? pb.querySelector(`[name="${name}"]`) : null;
}

function termOfForm(form) {
  const terms = (detailProperty && detailProperty.terms) || [];
  return terms.find((t) => String(t.id) === String(form.dataset.termForm)) || null;
}

// The term form's submitted payment_override: the inline editor's
// parsed value, mapped by the rule above (blank or equal to the
// term's calculated payment → null; anything else passes through
// for the server to validate).
function paymentOverrideOut(form, parsed) {
  if (parsed === '' || parsed == null) return null;
  const term = termOfForm(form);
  const derived = term ? term.paymentDerived : null;
  if (derived != null && Math.round(Number(parsed) * 100) === Math.round(Number(derived) * 100)) return null;
  return parsed;
}

// mode 'used': prefill from the term's current used payment (the
// Edit button). mode 'keep': the input already holds the value to
// show (an AI fill, a restored draft) — only reveal it.
function enterPayEdit(form, mode = 'used') {
  const els = payEditEls(form);
  if (!els.input || !els.view) return;
  const term = termOfForm(form);
  if (mode === 'used' && term) {
    // Programmatic prefill, no input/change events: opening the
    // editor is not an edit — it must neither clear an AI flag
    // nor re-price anything.
    els.input.value = formatMoneyInput(term.paymentUsed ?? term.payment_override ?? '');
  }
  els.input.classList.remove('hidden');
  els.view.classList.add('hidden');
  if (els.editBtn) els.editBtn.classList.add('hidden');
  if (els.resetBtn) els.resetBtn.classList.toggle('hidden', !(term && term.paymentOverridden));
  if (els.ref) {
    els.ref.innerHTML = term && term.paymentDerived != null
      ? (term.paymentOverridden
        ? `<s class="pay-derived">${money2(term.paymentDerived)}</s>`
        : `<span class="pay-derived">${money2(term.paymentDerived)}</span>`)
      : '';
  }
}

// Modal-top metadata: five read-only figures, all derived from the
// property and its terms — nothing here is an input. The editable
// mortgage facts live in the terms themselves; each term's card
// carries its own principal pair and payment schedule. Payments
// render from their API triple via paymentHtml: the used figure,
// with the derived figure struck through beside it when the term
// overrides the calculated payment.
function renderMortgageMeta() {
  const p = detailProperty;
  if (!p || !$('#mortgageMeta')) return;
  const terms = p.terms || [];
  const first = terms[0] || null;
  const cur = terms.find((t) => t.id === p.currentTermId) || null;
  $('#metaOpeningPrincipal').textContent =
    first && first.opening_balance != null ? money2(first.opening_balance) : '—';
  // Current Principal is what is still owed TODAY — the
  // projection's balance at the current month, served as
  // remainingBalance — not the anchor the loan started from.
  // The anchor is only the fallback for an unprojectable mortgage.
  $('#metaCurrentPrincipal').textContent =
    p.remainingBalance != null ? money2(p.remainingBalance)
      : (p.mortgage_balance != null ? money2(p.mortgage_balance) : '—');
  $('#metaCurrentPayment').innerHTML = paymentHtml(chartMeta);
  // Each term card also shows its own monthly payment read-only,
  // in the payment row closing the card: the payment its span opens with,
  // from the term's own triple in the property payload (for an
  // equal-principal term, its first — highest — month). A term
  // the projection does not reach, or no projection at all (no
  // rate plan / no amortization yet), shows '—'.
  document.querySelectorAll('[data-term-payment]').forEach((el) => {
    const term = terms.find((t) => String(t.id) === el.dataset.termPaymentFor);
    el.innerHTML = paymentHtml(term);
  });
  // The engine counts the current term's amortization down from
  // the balance anchor (its epoch), so at the anchor the remaining
  // amortization is the term's amortization_years itself.
  $('#metaRemainingAmort').textContent =
    cur && cur.amortization_years != null ? Number(cur.amortization_years).toFixed(1) : '—';
  $('#metaCurrentLender').textContent = (cur && cur.lender) || '—';
}

function segRowsHtml(segs) {
  return segs.map((s) => {
    // A prime-spread segment's rate text is the one door to the
    // prime history: it renders as a link that opens the prime
    // modal, windowed on this segment. Every other segment's rate
    // stays plain text.
    const rateCell = s.rate_type === 'variable' && s.rate_mode === 'prime_spread'
      ? `<a href="#" data-prime-link data-seg-start="${esc(s.start_date)}">${esc(segmentRateText(s))}</a>`
      : esc(segmentRateText(s));
    // AI Fill flags ride on the segment row (see its ai_fields).
    const flag = (names) => (s.ai_fields || []).some((f) => names.includes(f))
      ? ' <span class="ai-flag" title="Filled by AI">✨</span>' : '';
    return `<tr>
    <td>${esc(s.start_date)}${flag(['start_date'])}</td>
    <td>${s.rate_type === 'fixed' ? '<span class="badge">Fixed</span>' : '<span class="badge var">Variable</span>'}${flag(['rate_type'])}</td>
    <td class="num">${rateCell}${flag(['rate_mode', 'annual_rate', 'spread'])} <span class="badge cmp">${s.compounding === 'monthly' ? 'Monthly' : 'Semi-annual'}</span>${flag(['compounding'])}${s.locked_on && s.rate_mode === 'prime_spread' ? ` <span class="badge lock">Locked ${esc(s.locked_on)}</span>` : ''}</td>
    <td><button type="button" class="small" data-edit-seg="${s.id}">Edit</button> <button type="button" class="small danger" data-del-seg="${s.id}">Delete</button></td></tr>`;
  }).join('')
    || '<tr><td colspan="4" class="note" style="margin:0">No segments in this term yet — add one with "+ Change rate".</td></tr>';
}

function lumpRowsHtml(lumps) {
  if (!lumps.length) return '<div class="note" style="margin:0">No lump sums in this term.</div>';
  return lumps.map((l) => `<div class="kv"><span class="k">${esc(l.date)}</span><span>${money2(l.amount)}${l.note ? ` · ${esc(l.note)}` : ''}</span><button type="button" class="small danger" data-del-lump="${l.id}">Delete</button></div>`).join('');
}

// The segment form uses the same grid as every other form on
// the site (label above input, one baseline per row) instead of a
// flex toolbar — in a toolbar the inputs sized to content, the row
// wrapped, and the Add segment button dropped below the inputs
// with its label detached. It starts hidden; "+ Change rate"
// toggles it open (see the termsWrap click handler). The same
// form edits an existing segment: a row's Edit button loads the
// segment into it and switches it to edit mode (see
// enterSegEditMode) — the submit then reads "Save segment" and a
// Cancel button (edit mode only) drops back to add mode.
function segFormHtml(t) {
  return `<form data-seg-form="${t.id}" class="hidden">
    <div class="grid3">
      <div><label>Start date</label><input type="date" name="start_date" required value="${esc(t.start_date)}"></div>
      <div><label>Type</label><select name="rate_type"><option value="fixed">Fixed</option><option value="variable">Variable</option></select></div>
      <div data-seg-mode class="hidden"><label>Pricing (variable)</label><select name="rate_mode"><option value="absolute">Absolute rate</option><option value="prime_spread">Prime + spread</option></select></div>
    </div>
    <div class="grid3">
      <div data-seg-rate><label>Annual rate %</label><input type="number" name="annual_rate" step="0.01" min="0"></div>
      <div data-seg-spread class="hidden"><label>Spread vs prime (%)</label><input type="number" name="spread" step="0.05"><div class="note" data-seg-preview style="margin:2px 0 0"></div><label style="margin-top:6px">Locked on</label><input type="date" name="locked_on"></div>
      <div><label>Compounding</label><select name="compounding"><option value="semi_annual">Semi-annual</option><option value="monthly">Monthly</option></select><label style="margin-top:6px">Accrual</label><select name="accrual"><option value="monthly">Monthly</option><option value="daily">Daily (actual days)</option></select></div>
    </div>
    <div class="toolbar">
      <button class="primary" type="submit" data-seg-submit>Add segment</button>
      <button type="button" class="small hidden" data-seg-cancel-edit>Cancel edit</button>
    </div>
    <div class="note" data-plan-preview style="margin:2px 0 0"></div>
  </form>`;
}

// ------------------------------------------------ segment editing ---
// A segment row's Edit button loads the segment into its term's
// segment form and switches the form to edit mode (the form's
// dataset.editSeg carries the segment id): submitting then
// updates that segment in place (PUT, same id) instead of adding
// a new one, and Cancel returns the form to add mode. The
// segment's AI flags ride along — entering edit mode seeds the
// form's flag set from the segment's stored ai_fields, and the
// usual rule applies from there (a hand edit clears that
// field's flag; the surviving set is what the save sends back).
function segmentById(id) {
  const p = detailProperty || {};
  const all = [...(p.segments || [])];
  for (const t of p.terms || []) {
    for (const s of t.segments || []) {
      if (!all.some((x) => x.id === s.id)) all.push(s);
    }
  }
  return all.find((s) => String(s.id) === String(id)) || null;
}

// The submit label + Cancel visibility follow the form's mode.
function reflectSegEditMode(form) {
  const editing = !!form.dataset.editSeg;
  const submit = form.querySelector('[data-seg-submit]');
  if (submit) submit.textContent = editing ? 'Save segment' : 'Add segment';
  const cancel = form.querySelector('[data-seg-cancel-edit]');
  if (cancel) cancel.classList.toggle('hidden', !editing);
}

function enterSegEditMode(form, seg) {
  form.dataset.editSeg = String(seg.id);
  // Programmatic prefill: values are set without dispatching
  // input/change events and with the _aiFilling guard up, so
  // loading the segment neither clears its AI flags nor counts
  // as a hand edit.
  form._aiFilling = true;
  form.start_date.value = seg.start_date || '';
  form.rate_type.value = seg.rate_type || 'fixed';
  form.rate_mode.value = seg.rate_mode || 'absolute';
  form.annual_rate.value = seg.annual_rate ?? '';
  form.spread.value = seg.spread ?? '';
  form.locked_on.value = seg.locked_on || '';
  form.compounding.value = seg.compounding || 'semi_annual';
  form.accrual.value = seg.accrual || 'monthly';
  form._aiFilling = false;
  syncSegForm(form);
  const set = aiFlagSet(form);
  set.clear();
  (seg.ai_fields || []).forEach((n) => set.add(n));
  renderAiFlags(form);
  reflectSegEditMode(form);
  form.classList.remove('hidden');
  refreshPlanPreview(form);
}

function exitSegEditMode(form) {
  delete form.dataset.editSeg;
  reflectSegEditMode(form);
}

// The term form's Save button label names the payment it
// calculates, in the term's payment frequency: "Save & calculate
// monthly payment", "Save & calculate accelerated bi-weekly
// payment", ... — the FREQUENCY_LABELS entry lowercased. The
// label follows the frequency select live (see the termsWrap
// change handler).
function saveTermLabel(freqKey) {
  return `Save & calculate ${(FREQUENCY_LABELS[freqKey] || 'Monthly').toLowerCase()} payment`;
}

// The frequency options for a term's payment-schedule select.
function freqOptionsHtml(selectedKey) {
  return Object.entries(FREQUENCY_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === selectedKey ? ' selected' : ''}>${v}</option>`).join('');
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
    // Every term card carries the same field set: its contract
    // fields, its principal pair, its payment schedule — and,
    // below the rate segments and the lump sums, its monthly
    // payment figure (rendered from the
    // term's payment triple, with an Edit button that turns the
    // figure itself into the override input — there is no
    // separate override field). The card's one Save button
    // closes the card below the payment row: it sits outside
    // the term <form> and submits it through the HTML form
    // attribute, like the payment row's own inputs.
    // The principal pair — "Outstanding
    // principal" / "Principal as of" — binds the term's opening
    // balance / start date, EXCEPT on the term carrying the
    // property's balance anchor (anchor_date inside the term),
    // where the pair binds the anchor values instead (the opening
    // figures stay visible in the term's head line).
    const anchored = !!(t.anchor_date && t.anchor_balance != null);
    const principalName = anchored ? 'anchor_balance' : 'opening_balance';
    const principalDateName = anchored ? 'anchor_date' : 'start_date';
    const freqKey = FREQUENCY_LABELS[t.payment_frequency] ? t.payment_frequency
      : (FREQUENCY_LABELS[p.payment_frequency] ? p.payment_frequency : 'monthly');
    const stepped = DAY_STEPPED_FREQUENCIES.includes(freqKey);
    return `<div class="term-block" data-term-block="${t.id}">
      <button type="button" class="term-head" data-term-toggle="${t.id}">
        <span class="term-title">Term ${i + 1}${t.id === p.currentTermId ? ' · current' : ''}</span>
        <span>${esc(t.lender || 'Lender not set')}</span>
        <span>${esc(t.start_date)} → ${esc(t.end_date)}</span>
        <span>${termLengthLabel(t.term_months)}</span>
        <span>Amortization: ${t.amortization_years != null ? `${esc(t.amortization_years)} years` : 'not set'}</span>
        <span>Opened at ${money2(t.opening_balance)}</span>
        <span style="flex:1"></span>
        <span data-term-arrow>${open ? '▾' : '▸'}</span>
      </button>
      <div class="term-body${open ? '' : ' hidden'}">
        <form data-term-form="${t.id}" id="termForm${t.id}">
          <div class="grid3">
            <div><label>Lender (bank)</label><input name="lender" list="lenderOptions" value="${esc(t.lender || '')}" autocomplete="off"></div>
            <div><label>Principal as of</label><input name="${principalDateName}" type="date" value="${esc(anchored ? t.anchor_date : t.start_date)}" required></div>
            <div><label>Outstanding principal ($)</label><input name="${principalName}" type="text" inputmode="decimal" data-money value="${esc(formatMoneyInput((anchored ? t.anchor_balance : t.opening_balance) ?? ''))}"></div>
          </div>

          <div class="grid3">
            <div><label>Term length (months)</label><input name="term_months" type="number" min="1" max="120" step="1" value="${esc(t.term_months)}" required>
              <div class="toolbar" style="margin-top:6px">${[1, 2, 3, 4, 5, 7, 10].map((y) => `<button type="button" class="small" data-term-years="${y}">${y} year${y === 1 ? '' : 's'}</button>`).join('')}</div>
            </div>
            <div><label>Amortization for this term (years)</label><input name="amortization_years" type="number" step="0.5" min="1" max="35" value="${t.amortization_years ?? ''}" placeholder="e.g. 25"></div>
            <div><label>Repayment method</label><select name="repayment_method">
              <option value="equal_payment"${t.repayment_method !== 'equal_principal' ? ' selected' : ''}>Equal payment — same total every month</option>
              <option value="equal_principal"${t.repayment_method === 'equal_principal' ? ' selected' : ''}>Equal principal — same principal every month</option>
            </select></div>
          </div>
          <div class="grid3">
            <div><label>Payment frequency</label><select name="payment_frequency">${freqOptionsHtml(freqKey)}</select></div>
            <div><label>Payment day</label><input type="number" name="payment_day" min="1" max="31" step="1" placeholder="e.g. 1" value="${t.payment_day ?? p.payment_day ?? ''}" style="width:110px"${stepped ? ' disabled' : ''}></div>
          </div>
          ${t.amortization_defaulted ? '<div class="note" style="margin-left:0">The 25-year amortization on this term is the migration default — set the real figure if it differs.</div>' : ''}
        </form>
        <h5>Rate segments in this term</h5>
        <table class="seg-table">
          <thead><tr><th>Starts</th><th>Type</th><th class="num">Annual rate %</th><th></th></tr></thead>
          <tbody ${t.id === p.currentTermId ? 'id="segmentRows"' : ''}>${segRowsHtml(segs)}</tbody>
        </table>
        <div class="toolbar"><button type="button" class="small" data-toggle-seg="${t.id}">+ Change rate</button></div>
        ${segFormHtml(t)}
        <h5>Lump sums in this term</h5>
        ${lumpRowsHtml(t.lumpSums || [])}
        <div class="toolbar"><button type="button" class="small" data-toggle-lump="${t.id}">+ Add lump sum</button></div>
        <form data-lump-form="${t.id}" class="toolbar hidden" style="align-items:flex-end">
          <div><label>Date</label><input type="date" name="date" required></div>
          <div><label>Amount ($)</label><input type="text" inputmode="decimal" data-money name="amount" required></div>
          <div><label>Note</label><input type="text" name="note"></div>
          <button class="primary" type="submit">Add lump sum</button>
        </form>
        <div class="grid3" data-pay-block="${t.id}" style="margin-top:12px">
          <div><label>Monthly payment ($)</label><div class="term-pay-row">
            <span class="term-pay-v" data-term-payment="${esc(String(t.start_date).slice(0, 7))}" data-term-payment-end="${esc(String(t.end_date || t.start_date).slice(0, 7))}" data-term-payment-for="${t.id}">—</span>
            <input name="payment_override" form="termForm${t.id}" type="text" inputmode="decimal" data-money class="pay-edit-input hidden" data-pay-edit-input value="${esc(formatMoneyInput(t.payment_override ?? ''))}">
            <span data-pay-derived-ref></span>
            <button type="button" class="small" data-pay-edit>Edit</button>
            <button type="button" class="small hidden" data-pay-reset>Reset</button>
          </div></div>
        </div>
        <div class="toolbar" style="margin-top:12px">
          <button class="primary" type="submit" form="termForm${t.id}" data-save-term="${t.id}">${esc(saveTermLabel(freqKey))}</button>
          ${terms.length > 1 ? `<button type="button" class="small danger" data-del-term="${t.id}">Delete term</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('') || '<div class="note" style="margin-left:0">No terms yet.</div>';
  wrap.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  wrap.querySelectorAll('[data-seg-form]').forEach(syncSegForm);
  // AI Fill: one panel per term form (it also fills that term's
  // segment form), with the persisted flags re-rendered.
  wrap.querySelectorAll('[data-term-form]').forEach((f) => {
    const t = terms.find((x) => String(x.id) === f.dataset.termForm);
    const block = f.closest('.term-block');
    attachAiFill(f, 'term', { segForm: block ? block.querySelector('[data-seg-form]') : null });
    if (t) {
      const flags = aiFlagSet(f);
      (t.ai_fields || []).forEach((n) => flags.add(n));
      renderAiFlags(f);
    }
  });
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
  const payEdit = e.target.closest('[data-pay-edit]');
  if (payEdit) {
    const form = termFormOfPayBlock(payEdit.closest('[data-pay-block]'));
    if (form) {
      enterPayEdit(form, 'used');
      const input = payEditEls(form).input;
      if (input) { input.focus(); input.select(); }
    }
    return;
  }
  const payReset = e.target.closest('[data-pay-reset]');
  if (payReset) {
    const form = termFormOfPayBlock(payReset.closest('[data-pay-block]'));
    const term = form && termOfForm(form);
    const input = form && payEditEls(form).input;
    if (input && term) {
      input.value = formatMoneyInput(term.paymentDerived ?? '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  const showSeg = e.target.closest('[data-toggle-seg]');
  if (showSeg) {
    const block = showSeg.closest('[data-term-block]');
    const form = block && block.querySelector('[data-seg-form]');
    if (form) {
      // A real toggle: closed by default, one click opens, the
      // next closes. Either way the preview line starts blank —
      // a stale message never survives a close / reopen.
      const opening = form.classList.contains('hidden');
      form.classList.toggle('hidden', !opening);
      const preview = form.querySelector('[data-plan-preview]');
      if (preview) preview.textContent = '';
      if (opening) { syncSegForm(form); refreshPlanPreview(form); }
    }
    return;
  }
  const showLump = e.target.closest('[data-toggle-lump]');
  if (showLump) {
    const block = showLump.closest('[data-term-block]');
    const form = block && block.querySelector('[data-lump-form]');
    if (form) form.classList.remove('hidden');
    return;
  }
  const primeLink = e.target.closest('[data-prime-link]');
  if (primeLink) {
    e.preventDefault();
    openPrimeModal(primeLink.dataset.segStart);
    return;
  }
  // The selector names the Edit BUTTON, never the bare
  // attribute: in edit mode the segment FORM itself carries
  // data-edit-seg (its mode state), and a bare [data-edit-seg]
  // match would catch every click inside the form — Cancel
  // above all — and re-enter edit mode instead.
  const editSeg = e.target.closest('button[data-edit-seg]');
  if (editSeg) {
    const block = editSeg.closest('[data-term-block]');
    const form = block && block.querySelector('[data-seg-form]');
    const seg = segmentById(editSeg.dataset.editSeg);
    if (form && seg) enterSegEditMode(form, seg);
    return;
  }
  const cancelSegEdit = e.target.closest('[data-seg-cancel-edit]');
  if (cancelSegEdit) {
    const form = cancelSegEdit.closest('[data-seg-form]');
    if (form) { exitSegEditMode(form); form.classList.add('hidden'); }
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
  const termFormEl = e.target.closest('[data-term-form]');
  if (termFormEl && e.target.name === 'payment_frequency') {
    // The payment day only applies to the monthly / semi-monthly
    // schedules; the day-stepped frequencies disable the input.
    termFormEl.payment_day.disabled = DAY_STEPPED_FREQUENCIES.includes(e.target.value);
    // The Save button's label names the payment in the newly
    // picked frequency.
    const block = termFormEl.closest('[data-term-block]');
    const saveBtn = block && block.querySelector('[data-save-term]');
    if (saveBtn) saveBtn.textContent = saveTermLabel(e.target.value);
    return;
  }
  const form = e.target.closest('[data-seg-form]');
  if (form) { syncSegForm(form); refreshPlanPreview(form); return; }
  // The term's plan fields (repayment method, amortization,
  // payment override) re-price the preview of that term's draft
  // segment. The payment editor sits in the pay block below the
  // form, so its events resolve through the block too.
  if ((e.target.closest('[data-term-form]') || e.target.closest('[data-pay-block]'))
    && (e.target.name === 'repayment_method' || e.target.name === 'amortization_years' || e.target.name === 'payment_override')) {
    const seg = segFormOfBlock(e.target);
    if (seg && !seg.classList.contains('hidden')) refreshPlanPreview(seg);
  }
});
$('#termsWrap').addEventListener('input', (e) => {
  const form = e.target.closest('[data-seg-form]');
  if (form) { if (e.target.name === 'spread') syncSegForm(form); refreshPlanPreview(form); return; }
  if ((e.target.closest('[data-term-form]') || e.target.closest('[data-pay-block]')) && (e.target.name === 'amortization_years' || e.target.name === 'payment_override')) {
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
      parseMoneyFields(f, ['opening_balance', 'anchor_balance', 'payment_override']);
      const body = {
        lender: f.lender,
        term_months: Number(f.term_months),
        amortization_years: f.amortization_years === '' || f.amortization_years == null ? null : Number(f.amortization_years),
        repayment_method: f.repayment_method || 'equal_payment',
        payment_frequency: f.payment_frequency,
        // The payment row's inline editor submits as
        // payment_override: blank clears the override (the
        // calculated payment rules again); a figure equal to the
        // calculated payment IS the calculated payment, so it
        // clears it too; any other figure is sent as the override
        // (the server still refuses a non-positive one).
        payment_override: paymentOverrideOut(form, f.payment_override),
        ai_fields: [...aiFlagSet(form)],
      };
      // The principal pair binds the term's opening balance / start
      // date — or, on the term carrying the balance anchor, the
      // anchor values. Whichever inputs the card rendered are the
      // ones submitted; the rest merge from the stored term.
      if (f.start_date !== undefined) body.start_date = f.start_date;
      if (f.opening_balance !== undefined) {
        body.opening_balance = f.opening_balance === '' || f.opening_balance == null ? null : f.opening_balance;
      }
      if (f.anchor_date !== undefined) body.anchor_date = f.anchor_date || null;
      if (f.anchor_balance !== undefined) {
        body.anchor_balance = f.anchor_balance === '' || f.anchor_balance == null ? null : f.anchor_balance;
      }
      // A disabled payment-day input (day-stepped frequencies) is
      // absent from FormData: leave the stored day untouched then.
      if (f.payment_day !== undefined) {
        body.payment_day = f.payment_day === '' ? null : Number(f.payment_day);
      }
      await api(`/api/properties/${currentPropertyId}/terms/${form.dataset.termForm}`, {
        method: 'PUT',
        body,
      });
      markAssetsDirty();
      showMsg($('#mortgageMsg'), 'ok', 'Term saved.');
    } else if (form.dataset.segForm) {
      const f = Object.fromEntries(new FormData(form).entries());
      const body = { start_date: f.start_date, rate_type: f.rate_type, term_id: Number(form.dataset.segForm), compounding: f.compounding || 'semi_annual', accrual: f.accrual || 'monthly', ai_fields: [...aiFlagSet(form)] };
      if (f.rate_type === 'variable' && f.rate_mode === 'prime_spread') {
        body.rate_mode = 'prime_spread';
        body.spread = f.spread === '' ? null : Number(f.spread);
        // The segment's pricing lock (blank clears it; the
        // payment then derives at the derivation month's prime).
        body.locked_on = f.locked_on ? f.locked_on : null;
      } else {
        body.rate_mode = 'absolute';
        body.annual_rate = f.annual_rate;
        body.locked_on = null;
      }
      // Edit mode updates the loaded segment in place (same id);
      // add mode creates a new one. A saved edit returns the
      // form to add mode (before the reload below snapshots the
      // drafts, so the mode does not ride back in).
      if (form.dataset.editSeg) {
        await api(`/api/properties/${currentPropertyId}/rates/${form.dataset.editSeg}`, { method: 'PUT', body });
        exitSegEditMode(form);
        markAssetsDirty();
        showMsg($('#mortgageMsg'), 'ok', 'Rate segment saved.');
      } else {
        await api(`/api/properties/${currentPropertyId}/rates`, { method: 'POST', body });
        markAssetsDirty();
        showMsg($('#mortgageMsg'), 'ok', 'Rate segment added.');
      }
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
    // Term / segment saves preserve the sibling forms' unsaved
    // drafts (AI-filled values above all) across the reload.
    if (form.dataset.termForm || form.dataset.segForm) await reloadDetailKeepingDrafts();
    else loadPropertyDetail(currentPropertyId);
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
  f.ai_fields = [...aiFlagSet(e.target)];
  try {
    await api(`/api/properties/${currentPropertyId}`, { method: 'PUT', body: f });
    markAssetsDirty();
    showMsg($('#detailMsg'), 'ok', 'Saved.');
    loadPropertyDetail(currentPropertyId);
  } catch (err) { showMsg($('#detailMsg'), 'err', err.message); }
});

// ---- Prime rate (Bank of Canada, tracked by the server) ----------
// No prime text lives in the Mortgage Terms & Rates modal: the
// prime history sits behind the link on each prime-spread
// segment's rate (the prime modal, below), and the add-segment
// form previews a prime-spread against the tracked value. The
// only prime words that may appear uninvited are functional
// states — the stale warnings, shown only while the tracked
// value is out of date.
let primeInfoCache = null;

async function loadPrime() {
  try {
    primeInfoCache = await api('/api/prime');
  } catch { primeInfoCache = null; }
  const cur = primeInfoCache && primeInfoCache.current;
  renderPrimeWarning($('#primeWarning'), primeInfoCache
    ? { rate: cur ? cur.rate : null, asOf: primeInfoCache.asOf, fresh: primeInfoCache.fresh }
    : null);
  renderPrimeStaleNote();
  refreshSegPreviews();
}

// The Mortgage modal's stale-prime line: one small amber line,
// present only while the tracked prime is stale (the last fetch
// failed and plans price off the last known value). While prime
// is fresh the modal carries no prime text at all.
function renderPrimeStaleNote() {
  const el = $('#primeStaleNote');
  if (!el) return;
  const info = primeInfoCache;
  const cur = info && info.current;
  if (info && cur && info.fresh === false) {
    el.textContent = `Couldn't reach the Bank of Canada — plans here use the last known prime of ${Number(cur.rate).toFixed(2)}% from ${info.asOf || cur.date}.`;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

// ---- Prime history chart (the prime modal) ----------
// A prime-spread segment's rate text is a link; clicking it opens
// the prime modal with a stepped chart of the tracked prime
// history: each step is one Bank of Canada move, drawn from a
// little before the clicked segment began through today. The
// chart is built only while the modal is open and destroyed on
// close, so its canvas never sizes against a hidden layout.
let primeChart = null;
let primeModalSegStart = null; // start_date of the segment whose link opened the modal

function destroyPrimeChart() {
  if (primeChart) { primeChart.destroy(); primeChart = null; }
  window.__fmCharts.prime = null;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function localDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function dateStrDecimal(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return dateDecimal(new Date(y, (m || 1) - 1, d || 1));
}
function addMonthsStr(dateStr, months) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const first = new Date(y, (m - 1) + months, 1);
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return localDateStr(new Date(first.getFullYear(), first.getMonth(), Math.min(d || 1, dim)));
}

// The chart's points and axis window: from three months before
// the clicked segment began (or the first stored observation,
// when that is later) through today. The opening point carries
// the rate in effect at the window start; every stored step
// inside the window follows; the line ends at today's date at
// the current rate.
function primeChartData(history, segStart) {
  const firstDate = history[0].date;
  let winStart = firstDate;
  if (segStart) {
    const ctx = addMonthsStr(segStart, -3);
    if (ctx > winStart) winStart = ctx;
  }
  const today = localDateStr(new Date());
  let anchor = history[0];
  for (const pt of history) { if (pt.date <= winStart) anchor = pt; else break; }
  const pts = [{ date: winStart, rate: anchor.rate }];
  for (const pt of history) {
    if (pt.date > winStart && pt.date < today) pts.push({ date: pt.date, rate: pt.rate });
  }
  const lastRate = history[history.length - 1].rate;
  if (pts[pts.length - 1].date < today) pts.push({ date: today, rate: lastRate });
  return {
    min: dateStrDecimal(winStart),
    max: dateStrDecimal(today),
    data: pts.map((pt) => ({ x: dateStrDecimal(pt.date), y: pt.rate })),
  };
}

// The current rate, drawn at the line's end where the eye lands.
const primeEndLabelPlugin = {
  id: 'primeEndLabel',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data.length) return;
    const pt = meta.data[meta.data.length - 1];
    const last = chart.data.datasets[0].data[meta.data.length - 1];
    const c = chart.ctx;
    c.save();
    c.font = '700 12px system-ui, sans-serif';
    c.fillStyle = '#1668c4';
    c.textAlign = 'right';
    c.fillText(`${Number(last.y).toFixed(2)}%`, Math.min(pt.x, chart.chartArea.right) - 2, pt.y - 8);
    c.restore();
  },
};

// Open the prime modal windowed on the clicked segment: the
// header names the current prime with its as-of date, and the
// chart covers the segment's own window.
function openPrimeModal(segStart) {
  primeModalSegStart = segStart || null;
  openModal('primeModal');
  buildPrimeChart();
}

function buildPrimeChart() {
  const info = primeInfoCache;
  const cur = info && info.current;
  const head = $('#primeModalCurrent');
  if (head) {
    head.textContent = cur
      ? `Bank of Canada prime: ${Number(cur.rate).toFixed(2)}% (as of ${info.asOf || cur.date}).`
      : 'Bank of Canada prime: not available yet — the app fetches it from the Bank of Canada and keeps the last known value.';
  }
  if (!info || !Array.isArray(info.history) || !info.history.length) { destroyPrimeChart(); return; }
  const { min, max, data } = primeChartData(info.history, primeModalSegStart);
  const rates = data.map((d) => d.y);
  destroyPrimeChart();
  primeChart = new Chart($('#primeChart'), {
    type: 'line',
    data: {
      datasets: [{
        label: 'Bank of Canada prime rate',
        data,
        borderColor: '#1668c4', backgroundColor: '#1668c4',
        stepped: 'after', tension: 0,
        pointRadius: 3, pointHoverRadius: 5, borderWidth: 2,
      }],
    },
    plugins: [primeEndLabelPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => formatYearTick(items[0].parsed.x),
            label: (item) => ` Prime: ${Number(item.parsed.y).toFixed(2)}%`,
          },
        },
      },
      scales: {
        x: { type: 'linear', min, max, ticks: { ...yearAxisTicks(min, max), callback: formatYearTick } },
        y: {
          min: Math.min(...rates) - 0.3, max: Math.max(...rates) + 0.3,
          ticks: { callback: (v) => `${Number(v).toFixed(2)}%` },
          title: { display: true, text: 'Prime rate (%)' },
        },
      },
    },
  });
  window.__fmCharts.prime = primeChart;
}

$('#primeRefreshBtn').addEventListener('click', async () => {
  try {
    primeInfoCache = await api('/api/prime/refresh', { method: 'POST' });
    markAssetsDirty(); // a new prime reprices every variable projection
    loadPrime();
    if (currentPropertyId) loadPropertyDetail(currentPropertyId);
    if (!$('#primeModal').classList.contains('hidden')) buildPrimeChart();
  } catch (err) { showMsg($('#mortgageMsg'), 'err', err.message); }
});

// A term's segment form: Variable reveals the pricing mode;
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
// segment form, the server runs the draft through the same
// schedule engine as the saved projection and returns the plan's
// first month in effect — payment, interest, principal and the rate
// — so the figures can be checked BEFORE anything is saved.
// Debounced per form; the term's plan fields as currently edited
// (repayment method, amortization, payment override) ride along,
// so changing them re-prices the preview too. When the term
// carries an override the previewed payment IS the override, with
// the derived figure struck through beside it (paymentHtml).
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
    // An incomplete draft (no rate / no spread entered yet) has
    // nothing to preview: keep the line blank rather than
    // surfacing the server's validation error for a form nobody
    // has submitted — an error shows only after a real submit.
    const draftIncomplete = (f.rate_type === 'variable' && f.rate_mode === 'prime_spread')
      ? (f.spread === '' || f.spread == null)
      : (f.annual_rate === '' || f.annual_rate == null);
    if (draftIncomplete) { out.textContent = ''; return; }
    const body = {
      start_date: f.start_date,
      rate_type: f.rate_type,
      term_id: Number(form.dataset.segForm),
      compounding: f.compounding || 'semi_annual',
      accrual: f.accrual || 'monthly',
      repayment_method: termForm ? termForm.repayment_method.value : 'equal_payment',
      amortization_years: termForm && termForm.amortization_years.value !== ''
        ? Number(termForm.amortization_years.value) : null,
    };
    // The term form's override field as currently edited (blank =
    // no override in the draft).
    if (termForm && termForm.payment_override) {
      const po = parseMoneyInput(termForm.payment_override.value);
      body.payment_override = po === '' ? null : po;
    }
    if (f.rate_type === 'variable' && f.rate_mode === 'prime_spread') {
      body.rate_mode = 'prime_spread';
      body.spread = f.spread === '' ? null : Number(f.spread);
      // The draft segment's Locked on date as currently edited
      // (blank = no pricing lock in the draft).
      body.locked_on = f.locked_on ? f.locked_on : null;
    } else {
      body.rate_mode = 'absolute';
      body.annual_rate = f.annual_rate === '' ? null : Number(f.annual_rate);
      body.locked_on = null;
    }
    try {
      const r = await api(`/api/properties/${currentPropertyId}/preview`, { method: 'POST', body });
      if (!form.isConnected) return;
      if (r.ok) {
        out.innerHTML = `Next month (${r.month}): payment ${paymentHtml({ paymentUsed: r.payment, paymentDerived: r.paymentDerived, paymentOverridden: r.paymentOverridden })} — interest ${money2(r.interest)}, principal ${money2(r.principal)}, at ${Number(r.rate).toFixed(2)}%`;
      } else {
        out.textContent = r.error || '';
      }
    } catch (err) {
      if (form.isConnected) out.textContent = err.message;
    }
  }, 300));
}

// A term block's open segment form, if any (previews refresh
// when the term's own plan fields change too).
function segFormOfBlock(el) {
  const block = el && el.closest('[data-term-block]');
  return block ? block.querySelector('[data-seg-form]') : null;
}

// Payment frequency + payment day are per-term fields, edited in
// each term's own form: saving re-renders the chart on the new
// schedule. The payment day only applies to the monthly /
// semi-monthly schedules; for the day-stepped frequencies the
// term form disables the input.
const FREQUENCY_LABELS = {
  monthly: 'Monthly', semi_monthly: 'Semi-monthly', bi_weekly: 'Bi-weekly',
  accelerated_bi_weekly: 'Accelerated bi-weekly', weekly: 'Weekly', accelerated_weekly: 'Accelerated weekly',
};
const DAY_STEPPED_FREQUENCIES = ['bi_weekly', 'accelerated_bi_weekly', 'weekly', 'accelerated_weekly'];

// The region rides beside the address as a flag tag — rendered
// FROM the property's region field (a lookup, like FREQUENCY_LABELS
// above), never written into a template as fixed text. A region
// with no entry falls back to its bare code.
const REGION_TAGS = {
  CA: { flag: '🇨🇦', label: 'Canada (CA)' },
};
function regionTagHtml(region) {
  const code = String(region || 'CA').toUpperCase();
  const tag = REGION_TAGS[code];
  return tag
    ? `<span class="region-tag" title="${esc(tag.label)}">${tag.flag}</span>`
    : `<span class="region-tag" title="${esc(code)}">${esc(code)}</span>`;
}

// Fetch / pull report nothing on success — the new point lands in
// the chart and the table, which is the report. A failure is a
// short error line (functional status), nothing more.
$('#fetchBcaBtn').addEventListener('click', async () => {
  const msg = $('#historyMsg');
  showMsg(msg, 'ok', 'Fetching from BC Assessment…');
  try {
    const r = await api(`/api/properties/${currentPropertyId}/fetch-bca`, { method: 'POST' });
    if (r.ok) {
      markAssetsDirty();
      showMsg(msg, 'ok', '');
      loadPropertyDetail(currentPropertyId);
    } else {
      showMsg(msg, 'err', `BC Assessment fetch failed (${r.error}).`);
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
      showMsg(msg, 'ok', '');
      loadPropertyDetail(currentPropertyId);
      loadTrend(currentPropertyId);
    } else {
      showMsg(msg, 'err', `HouseSigma pull failed (${r.error}).`);
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

async function loadTrendImpl(id) {
  const r = await api(`/api/properties/${id}/value-history`);
  trendPoints = r.points;
  // The details panel's headline assessed figure follows the same
  // source as the equity readout: the latest history point wins
  // over the property row's stored value.
  if (detailProperty && String(detailProperty.id) === String(id)) {
    const latest = trendPoints.length ? trendPoints[trendPoints.length - 1] : null;
    $('#detailAssessedValue').textContent = latest
      ? money(latest.value)
      : (detailProperty.assessed_value != null ? money(detailProperty.assessed_value) : '—');
    // The equity stat follows the re-based assessed figure.
    const assessedNow = latest ? latest.value : detailProperty.assessed_value;
    const remainingNow = detailProperty.remainingBalance != null
      ? detailProperty.remainingBalance : detailProperty.mortgage_balance;
    $('#detailCurrentEquity').textContent = assessedNow != null
      ? money2(assessedNow - (remainingNow != null ? remainingNow : 0))
      : '—';
  }
  // The Land / Building columns exist only while at least one
  // year carries a split; split years show both figures, the
  // rest an em dash.
  const hasSplit = trendPoints.some((pt) => pt.land_value != null && pt.building_value != null);
  $('#trendHead').innerHTML = `<tr><th>Year</th><th class="num">Assessed value</th>${hasSplit ? '<th class="num">Land</th><th class="num">Building</th>' : ''}<th>Source</th><th>Notes</th><th></th></tr>`;
  const rows = trendPoints.map((pt) => `<tr>
    <td>${pt.year}</td><td class="num">${money(pt.value)}</td>
    ${hasSplit ? `<td class="num">${pt.land_value != null ? money(pt.land_value) : '—'}</td><td class="num">${pt.building_value != null ? money(pt.building_value) : '—'}</td>` : ''}
    <td>${pt.source === 'auto' ? '<span class="badge">BC Assessment</span>' : pt.source === 'housesigma' ? '<span class="badge">HouseSigma</span>' : '<span class="badge manual">Manual</span>'}</td>
    <td>${esc(pt.notes || '')}</td>
    <td style="white-space:nowrap">
      <button class="small" onclick="editTrendPoint(${pt.id})">Edit</button>
      <button class="small danger" onclick="deleteTrendPoint(${pt.id})">Delete</button>
    </td></tr>`).join('');
  $('#trendRows').innerHTML = rows || `<tr><td colspan="${hasSplit ? 7 : 5}" class="note" style="margin:0">No history points yet.</td></tr>`;
  renderHistoryChart();
  renderTrendSummary();
  renderDetailCharts();
  loadEquity(id); // a changed latest point moves the equity readout too
}

// ---- Assessed history chart (the Assessment History modal) ----
// The modal's top is the history itself as bars: one stack per
// recorded year, oldest first, the year's total written on top.
// A year whose point carries a land / building split stacks Land
// under Building; a year without one is a single Total bar. The
// tooltip names the point's source and, for split years, the
// Land / Building / Total breakdown. Built only while
// the modal is open (a canvas sized against a hidden layout would
// come out wrong), redrawn whenever the points change under it
// (fetch / pull / add / edit / delete all funnel through
// loadTrend), and destroyed on close.
let historyChart = null;

function destroyHistoryChart() {
  if (historyChart) { historyChart.destroy(); historyChart = null; }
  window.__fmCharts.history = null;
}

const TREND_SOURCE_LABELS = { auto: 'BC Assessment', housesigma: 'HouseSigma', manual: 'Manual' };

// The year's total on top of each bar (stack), in the site's
// assessed green: the topmost non-zero segment of the stack
// carries it.
const historyBarLabelPlugin = {
  id: 'historyBarLabels',
  afterDatasetsDraw(chart) {
    const c = chart.ctx;
    c.save();
    c.font = '700 11px system-ui, sans-serif';
    c.fillStyle = '#20573a';
    c.textAlign = 'center';
    chart.data.labels.forEach((_, i) => {
      let total = 0;
      let top = null;
      for (let d = chart.data.datasets.length - 1; d >= 0; d--) {
        const v = chart.data.datasets[d].data[i];
        if (!v) continue;
        total += v;
        if (!top) {
          const meta = chart.getDatasetMeta(d);
          if (meta && meta.data && meta.data[i]) top = meta.data[i];
        }
      }
      if (top) c.fillText(money2(total), top.x, top.y - 4);
    });
    c.restore();
  },
};

// A point carries a split only when BOTH figures stand.
const hasSplitPt = (pt) => pt.land_value != null && pt.building_value != null;

function renderHistoryChart() {
  const modal = $('#historyModal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (!trendPoints.length) { destroyHistoryChart(); return; }
  const pts = [...trendPoints].sort((a, b) => a.year - b.year);
  const anySplit = pts.some(hasSplitPt);
  const anyTotalOnly = pts.some((pt) => !hasSplitPt(pt));
  destroyHistoryChart();
  historyChart = new Chart($('#historyChart'), {
    type: 'bar',
    data: {
      labels: pts.map((pt) => String(pt.year)),
      // One stack per year: a split year is Land (bottom) +
      // Building (top); a year without a split is a single Total
      // bar in the assessed green the chart has always used. The
      // datasets are keyed by series name, never by position.
      datasets: [
        {
          key: 'land', label: 'Land', stack: 'assessed',
          data: pts.map((pt) => (hasSplitPt(pt) ? pt.land_value : 0)),
          pointMeta: pts,
          ...seriesColors('history', chartSeriesDef('history', 'land')),
          borderWidth: 1, maxBarThickness: 90,
        },
        {
          key: 'building', label: 'Building', stack: 'assessed',
          data: pts.map((pt) => (hasSplitPt(pt) ? pt.building_value : 0)),
          pointMeta: pts,
          ...seriesColors('history', chartSeriesDef('history', 'building')),
          borderWidth: 1, maxBarThickness: 90,
        },
        {
          key: 'total', label: 'Total', stack: 'assessed',
          data: pts.map((pt) => (hasSplitPt(pt) ? 0 : pt.value)),
          pointMeta: pts,
          ...seriesColors('history', chartSeriesDef('history', 'total')),
          borderWidth: 1, maxBarThickness: 90,
        },
      ],
    },
    plugins: [historyBarLabelPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 16 } }, // headroom for the bar-top amounts
      plugins: {
        // The legend names the stack's parts; a series with no
        // bar in any year is filtered out of it, and with no
        // split years at all the legend stays hidden (the chart
        // reads as plain total bars, as before).
        legend: {
          display: anySplit,
          labels: {
            filter: (item, data) => {
              const key = data.datasets[item.datasetIndex].key;
              return key === 'total' ? anyTotalOnly : anySplit;
            },
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => `Assessed value — ${items[0].label}`,
            label: (item) => {
              const pt = item.dataset.pointMeta[item.dataIndex];
              const src = ` Source: ${TREND_SOURCE_LABELS[pt.source] || pt.source}`;
              if (hasSplitPt(pt)) {
                return [` Land ${money(pt.land_value)}`, ` Building ${money(pt.building_value)}`, ` Total ${money(pt.value)}`, src];
              }
              return [` Total ${money(pt.value)}`, src];
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => moneyTick(v) } },
      },
    },
  });
  window.__fmCharts.history = historyChart;
}

// Trend summary: a single change figure computed over the SAME
// years the combined chart currently shows (the detail range's
// window), so it can never describe a different span than the
// line on screen — the figure only, no guidance prose around it.
function renderTrendSummary() {
  const summary = $('#trendSummary');
  if (!summary) return;
  const win = detailRangeWindow();
  const shown = win
    ? trendPoints.filter((pt) => pt.year >= win.min && pt.year < win.max)
    : trendPoints;
  if (shown.length >= 2) {
    const first = shown[0];
    const last = shown[shown.length - 1];
    const abs = last.value - first.value;
    const sign = abs >= 0 ? '+' : '−';
    const pctTxt = first.value ? ` (${abs >= 0 ? '+' : ''}${(abs / first.value * 100).toFixed(1)}%)` : '';
    summary.textContent = `Change ${first.year} → ${last.year}: ${sign}${money(Math.abs(abs))}${pctTxt} (${money(first.value)} → ${money(last.value)}).`;
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
  setMoneyValue(f.land_value, pt.land_value ?? '');
  setMoneyValue(f.building_value, pt.building_value ?? '');
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

// With both split figures filled, the year's total is their
// sum — the value field follows as they are typed (the server
// applies the same rule on save).
$('#trendForm').addEventListener('input', (e) => {
  if (e.target.name !== 'land_value' && e.target.name !== 'building_value') return;
  const f = e.target.form;
  const land = parseMoneyInput(f.land_value.value);
  const building = parseMoneyInput(f.building_value.value);
  if (land !== '' && building !== '') setMoneyValue(f.value, land + building);
});

$('#trendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['value', 'land_value', 'building_value']);
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

// ------------------------------------------------------- property costs ---
// A property's yearly running costs (property tax, strata,
// utilities…). The panel's ONE input surface is the entries
// table: rows edit in place (Save / Cancel on the dirty row),
// "+ Add row" appends a blank one, every row deletes — there is
// no separate add form and no pivot matrix. Amounts are stored
// in their recorded basis: 'annual' = the year's total,
// 'monthly' = a monthly average whose year total is ×12; the
// year subtotal rows and both charts all work at the ANNUAL
// figure (monthly rows show it with an "avg $X/mo" annotation,
// so nobody does the ×12 in their head).
//
// The two charts are display only: a per-year share pie (year
// switchable) and a bar+line combo (category-stacked bars, the
// total as a line) with a By year / By month granularity toggle.
// By month is a run-rate view: monthly-basis categories land at
// their average, annual-basis categories spread at annual ÷ 12.
// A category keeps ONE color across both charts (this panel's
// own fixed palette — dynamic categories cannot join the fixed
// chart_colors series system).
const COST_TYPE_PRESETS = ['Property tax', 'Strata fee', 'Water', 'Electricity', 'Gas', 'Home insurance'];
const COST_TYPE_CUSTOM = '__custom__';
const COST_COLORS = {
  'Property tax': '#1668c4', 'Strata fee': '#7c3aed', Water: '#00838f',
  Electricity: '#e67e22', Gas: '#c2185b', 'Home insurance': '#2e7d4f', Other: '#607d8b',
};
const COST_COLOR_POOL = ['#8d6e00', '#5d4037', '#283593', '#00695c', '#ad1457', '#4527a0', '#558b2f', '#6a1b9a', '#37474f', '#9e9d24'];
function costColor(category) {
  if (COST_COLORS[category]) return COST_COLORS[category];
  let h = 0;
  for (const c of String(category)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COST_COLOR_POOL[h % COST_COLOR_POOL.length];
}

let costsData = null;      // last GET /costs view {entries, categories, years, latest}
let costsLoadedFor = null; // property id the panel state belongs to
let costsEditingId = null; // entry id in edit mode; 'new' = an unsaved row; null at rest
let costsPie = null;
let costsCombo = null;
let costsPieYear = null;
let costsPieCenter = null; // {year, total} the doughnut's center text
let costsGranularity = 'year';

async function loadCostsImpl(id) {
  const view = await api(`/api/properties/${id}/costs`);
  costsData = view;
  if (costsLoadedFor !== id) {
    costsLoadedFor = id;
    costsEditingId = null;
    costsPieYear = null;
    resetCostsChat(id);
  }
  renderCosts();
}

function costCustomCategories() {
  const seen = new Set((costsData ? costsData.entries : []).map((e) => e.category));
  return [...seen].filter((c) => !COST_TYPE_PRESETS.includes(c)).sort((a, b) => a.localeCompare(b));
}

function renderCosts() {
  if (!costsData) return;
  const latest = costsData.latest;
  $('#costsLatestTotal').textContent = latest ? `${latest.year} total: ${money2(latest.total)}` : '';
  // The category datalist (the AI proposal rows' category input):
  // presets + recorded customs, so a name is never re-invented.
  $('#costCategoryOptions').innerHTML = [...COST_TYPE_PRESETS, ...costCustomCategories(), 'Other']
    .map((c) => `<option value="${esc(c)}">`).join('');
  renderCostsCharts();
  renderCostsRows();
  renderCostsProposed();
}

// ------------------------------------------------------------ costs table
function costAmountCell(e) {
  if (e.basis === 'monthly') {
    return `${money2(Number(e.amount) * 12)}<div class="cost-mo-note">avg ${money2(e.amount)}/mo</div>`;
  }
  return money2(e.amount);
}

function costTypeSelectHtml(selected) {
  const customs = costCustomCategories();
  const isPreset = COST_TYPE_PRESETS.includes(selected);
  const isCustomListed = customs.includes(selected);
  const opts = [
    ...COST_TYPE_PRESETS.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`),
    ...customs.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`),
    `<option value="${COST_TYPE_CUSTOM}"${!isPreset && !isCustomListed && selected ? ' selected' : ''}>Other…</option>`,
  ].join('');
  const showCustom = !isPreset && !isCustomListed;
  return `<select name="category">${opts}</select>`
    + `<input type="text" class="cost-type-custom${showCustom ? '' : ' hidden'}" name="category_custom" placeholder="Category name" value="${showCustom ? esc(selected || '') : ''}">`;
}

function costEditRowHtml(entry) {
  const isNew = !entry;
  const e = entry || { year: (costsData.latest ? costsData.latest.year : new Date().getFullYear()), category: COST_TYPE_PRESETS[0], basis: 'annual', amount: '' };
  return `<tr class="cost-editing" data-cost-editrow="${isNew ? 'new' : e.id}">
    <td><input type="number" name="year" step="1" min="1900" max="2100" value="${e.year}"></td>
    <td>${costTypeSelectHtml(e.category)}</td>
    <td><select name="basis">
      <option value="annual"${e.basis === 'annual' ? ' selected' : ''}>Annual</option>
      <option value="monthly"${e.basis === 'monthly' ? ' selected' : ''}>Monthly avg</option>
    </select></td>
    <td class="num"><input type="text" inputmode="decimal" data-money name="amount" value="${e.amount === '' ? '' : esc(formatMoneyInput(e.amount))}"> <span class="cost-year-hint"></span></td>
    <td style="white-space:nowrap">
      <button type="button" class="small primary" data-cost-save>Save</button>
      <button type="button" class="small" data-cost-cancel>Cancel</button>
    </td></tr>`;
}

function renderCostsRows() {
  const tbody = $('#costsRows');
  if (!costsData) { tbody.innerHTML = ''; return; }
  const entries = [...costsData.entries].sort((a, b) => b.year - a.year || a.category.localeCompare(b.category));
  const totalsByYear = new Map(costsData.years.map((y) => [y.year, y.total]));
  const parts = [];
  if (costsEditingId === 'new') parts.push(costEditRowHtml(null));
  let lastYear = null;
  const flushSubtotal = () => {
    if (lastYear !== null && totalsByYear.has(lastYear)) {
      parts.push(`<tr class="cost-subtotal"><td>${lastYear} total</td><td colspan="2"></td><td class="num">${money2(totalsByYear.get(lastYear))}</td><td></td></tr>`);
    }
  };
  for (const e of entries) {
    if (lastYear !== null && e.year !== lastYear) flushSubtotal();
    lastYear = e.year;
    if (costsEditingId === e.id) {
      parts.push(costEditRowHtml(e));
    } else {
      parts.push(`<tr data-cost-row="${e.id}">
        <td>${e.year}</td>
        <td>${esc(e.category)}${e.source === 'ai' ? ' <span class="badge">AI</span>' : ''}</td>
        <td>${e.basis === 'monthly' ? 'Monthly avg' : 'Annual'}</td>
        <td class="num">${costAmountCell(e)}</td>
        <td style="white-space:nowrap">
          <button type="button" class="small" data-cost-edit="${e.id}">Edit</button>
          <button type="button" class="small danger" data-cost-del="${e.id}">Delete</button>
        </td></tr>`);
    }
  }
  flushSubtotal();
  if (!entries.length && costsEditingId !== 'new') {
    parts.push('<tr><td colspan="5" class="note" style="margin:0">No costs recorded yet.</td></tr>');
  }
  tbody.innerHTML = parts.join('');
  wireCostEditRow();
}

function wireCostEditRow() {
  const row = $('#costsRows tr.cost-editing');
  if (!row) return;
  const amountInput = row.querySelector('[name=amount]');
  wireMoneyInput(amountInput);
  const sel = row.querySelector('[name=category]');
  const custom = row.querySelector('[name=category_custom]');
  sel.addEventListener('change', () => {
    custom.classList.toggle('hidden', sel.value !== COST_TYPE_CUSTOM);
    if (sel.value === COST_TYPE_CUSTOM) custom.focus();
  });
  const hint = row.querySelector('.cost-year-hint');
  const basisSel = row.querySelector('[name=basis]');
  const syncHint = () => {
    const amt = parseMoneyInput(amountInput.value);
    hint.textContent = basisSel.value === 'monthly' && amt !== '' ? `= ${money2(amt * 12)} / yr` : '';
  };
  amountInput.addEventListener('input', syncHint);
  basisSel.addEventListener('change', syncHint);
  syncHint();
}

$('#costsRows').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-cost-edit]');
  const delBtn = e.target.closest('[data-cost-del]');
  const saveBtn = e.target.closest('[data-cost-save]');
  const cancelBtn = e.target.closest('[data-cost-cancel]');
  if (editBtn) {
    costsEditingId = Number(editBtn.dataset.costEdit);
    renderCostsRows();
    return;
  }
  if (cancelBtn) {
    costsEditingId = null;
    renderCostsRows();
    return;
  }
  if (delBtn) {
    const id = Number(delBtn.dataset.costDel);
    if (!confirm('Delete this cost entry?')) return;
    try {
      await api(`/api/properties/${currentPropertyId}/costs/${id}`, { method: 'DELETE' });
      if (costsEditingId === id) costsEditingId = null;
      await loadCosts(currentPropertyId);
    } catch (err) { showMsg($('#costsMsg'), 'err', err.message); }
    return;
  }
  if (saveBtn) {
    const row = e.target.closest('tr.cost-editing');
    if (!row) return;
    const sel = row.querySelector('[name=category]');
    const category = sel.value === COST_TYPE_CUSTOM
      ? row.querySelector('[name=category_custom]').value.trim()
      : sel.value;
    const body = {
      year: Number(row.querySelector('[name=year]').value),
      category,
      basis: row.querySelector('[name=basis]').value,
      amount: parseMoneyInput(row.querySelector('[name=amount]').value),
    };
    if (!Number.isInteger(body.year) || !body.category || body.amount === '') {
      showMsg($('#costsMsg'), 'err', 'Year, type and amount are all required.');
      return;
    }
    try {
      if (row.dataset.costEditrow === 'new') {
        await api(`/api/properties/${currentPropertyId}/costs`, { method: 'POST', body });
      } else {
        await api(`/api/properties/${currentPropertyId}/costs/${row.dataset.costEditrow}`, { method: 'PUT', body });
      }
      costsEditingId = null;
      $('#costsMsg').textContent = '';
      $('#costsMsg').className = 'msg';
      await loadCosts(currentPropertyId);
    } catch (err) { showMsg($('#costsMsg'), 'err', err.message); }
  }
});

$('#addCostRowBtn').addEventListener('click', () => {
  if (costsEditingId === 'new') return;
  costsEditingId = 'new';
  renderCostsRows();
  const row = $('#costsRows tr.cost-editing');
  if (row) row.querySelector('[name=year]').focus();
});

// ----------------------------------------------------------- costs charts
function destroyCostsCharts() {
  if (costsPie) { costsPie.destroy(); costsPie = null; }
  if (costsCombo) { costsCombo.destroy(); costsCombo = null; }
  window.__fmCharts = window.__fmCharts || {};
  window.__fmCharts.costsPie = null;
  window.__fmCharts.costsCombo = null;
}

// The year's total in the doughnut's hole.
const costsPieCenterPlugin = {
  id: 'costsPieCenter',
  afterDraw(chart) {
    if (!costsPieCenter || chart !== costsPie) return;
    const area = chart.chartArea;
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const c = chart.ctx;
    c.save();
    c.textAlign = 'center';
    c.fillStyle = '#71808f';
    c.font = '11px system-ui, sans-serif';
    c.fillText(String(costsPieCenter.year), x, y - 4);
    c.fillStyle = '#22303c';
    c.font = '700 14px system-ui, sans-serif';
    c.fillText(money2(costsPieCenter.total), x, y + 14);
    c.restore();
  },
};

function renderCostsCharts() {
  const wrap = $('#costsCharts');
  const has = costsData && costsData.entries.length > 0;
  if (!has) { wrap.classList.add('hidden'); destroyCostsCharts(); return; }
  wrap.classList.remove('hidden');
  renderCostsPie();
  renderCostsCombo();
}

function renderCostsPie() {
  const yearsDesc = costsData.years;
  if (!yearsDesc.some((y) => y.year === costsPieYear)) costsPieYear = yearsDesc[0].year;
  const sel = $('#costsPieYear');
  sel.innerHTML = yearsDesc.map((y) => `<option value="${y.year}">${y.year}</option>`).join('');
  sel.value = String(costsPieYear);
  const yv = yearsDesc.find((y) => y.year === costsPieYear);
  const cats = costsData.categories.filter((c) => yv.cells[c]);
  costsPieCenter = { year: yv.year, total: yv.total };
  if (costsPie) costsPie.destroy();
  costsPie = new Chart($('#costsPieChart'), {
    type: 'doughnut',
    data: {
      labels: cats,
      datasets: [{
        data: cats.map((c) => yv.cells[c].annual),
        backgroundColor: cats.map((c) => costColor(c)),
        borderColor: '#fff', borderWidth: 1,
      }],
    },
    plugins: [costsPieCenterPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (item) => {
              const total = item.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total ? ((item.parsed / total) * 100).toFixed(1) : '0.0';
              return ` ${item.label}: ${money2(item.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  window.__fmCharts = window.__fmCharts || {};
  window.__fmCharts.costsPie = costsPie;
}

function renderCostsCombo() {
  const cats = costsData.categories;
  const yearsAsc = [...costsData.years].sort((a, b) => a.year - b.year);
  const cellOf = (year, c) => {
    const yv = yearsAsc.find((y) => y.year === year);
    return yv && yv.cells[c] ? yv.cells[c] : null;
  };
  let labels;
  let perCat;
  let totals;
  if (costsGranularity === 'month') {
    // Run-rate months: a monthly-basis category lands at its
    // average; an annual-basis one spreads at annual ÷ 12. The
    // twelve months of a recorded year sum back to its total.
    labels = [];
    perCat = cats.map(() => []);
    totals = [];
    for (const yv of yearsAsc) {
      for (let m = 1; m <= 12; m++) {
        labels.push(`${yv.year}-${String(m).padStart(2, '0')}`);
        let tot = 0;
        cats.forEach((c, ci) => {
          const cell = cellOf(yv.year, c);
          const v = cell ? (cell.basis === 'monthly' ? Number(cell.amount) : cell.annual / 12) : 0;
          perCat[ci].push(v);
          tot += v;
        });
        totals.push(tot);
      }
    }
  } else {
    labels = yearsAsc.map((y) => String(y.year));
    perCat = cats.map((c) => yearsAsc.map((y) => (y.cells[c] ? y.cells[c].annual : 0)));
    totals = yearsAsc.map((y) => y.total);
  }
  if (costsCombo) costsCombo.destroy();
  costsCombo = new Chart($('#costsComboChart'), {
    data: {
      labels,
      datasets: [
        ...cats.map((c, ci) => ({
          type: 'bar', label: c, stack: 'costs', data: perCat[ci],
          backgroundColor: costColor(c), borderColor: costColor(c), borderWidth: 1, maxBarThickness: 56,
        })),
        {
          type: 'line', label: 'Total', stack: 'total-line', data: totals,
          borderColor: '#263238', backgroundColor: '#263238', pointRadius: 2, tension: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: ${money2(item.parsed.y)}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => moneyTick(v) } },
      },
    },
  });
  window.__fmCharts = window.__fmCharts || {};
  window.__fmCharts.costsCombo = costsCombo;
}

$('#costsPieYear').addEventListener('change', (e) => {
  costsPieYear = Number(e.target.value);
  renderCostsPie();
});

$('#costsGranularity').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-gran]');
  if (!btn || btn.dataset.gran === costsGranularity) return;
  costsGranularity = btn.dataset.gran;
  $('#costsGranularity').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  renderCostsCombo(); // re-render from the loaded view — no refetch
});

// --------------------------------------------------------- costs AI chat
// A conversation, not a one-shot fill: the model proposes
// entries and asks whenever a year / period / category /
// property is ambiguous; only Apply writes (through the costs
// POST, source 'ai'). The conversation lives in this page
// session only — switching properties resets it.
let costsChatState = { turns: [], proposed: [] };
let costsChatPropertyId = null;

function resetCostsChat(propertyId) {
  costsChatState = { turns: [], proposed: [] };
  costsChatPropertyId = propertyId;
  const log = document.querySelector('[data-costs-chat-log]');
  if (log) { log.innerHTML = ''; log.classList.add('hidden'); }
  const ta = document.querySelector('[data-costs-chat-text]');
  if (ta) ta.value = '';
  const msg = document.querySelector('[data-costs-chat-msg]');
  if (msg) { msg.textContent = ''; msg.className = 'msg'; }
  const sum = document.querySelector('[data-costs-ai-summary]');
  if (sum) { sum.textContent = ''; sum.classList.add('hidden'); }
  renderCostsProposed();
}

function costsChatLogHtml() {
  return costsChatState.turns.map((t) => `<div class="costs-chat-turn ${t.role}">
    <span class="who">${t.role === 'user' ? 'You' : 'AI'}</span>${esc(t.content)}</div>`).join('');
}

function renderCostsChatLog(pendingText) {
  const log = document.querySelector('[data-costs-chat-log]');
  if (!log) return;
  const has = costsChatState.turns.length > 0 || pendingText;
  log.classList.toggle('hidden', !has);
  log.innerHTML = costsChatLogHtml()
    + (pendingText ? `<div class="costs-chat-turn user pending"><span class="who">You</span>${esc(pendingText)}</div>` : '');
  log.scrollTop = log.scrollHeight;
}

function costKeyOf(year, category) { return `${year}|${category}`; }

function renderCostsProposed() {
  const host = document.querySelector('[data-costs-proposed]');
  if (!host) return;
  const proposed = costsChatState.proposed;
  if (!proposed.length) { host.innerHTML = ''; return; }
  const existing = new Map((costsData ? costsData.entries : []).map((e) => [costKeyOf(e.year, e.category), e]));
  const rows = proposed.map((p, i) => {
    const conflict = existing.has(costKeyOf(p.year, p.category));
    const annual = p.basis === 'monthly' ? Number(p.amount) * 12 : Number(p.amount);
    return `<div class="costs-proposed-row${conflict ? ' conflict' : ''}" data-proposed-row="${i}">
      <input type="checkbox" data-p-check${conflict ? '' : ' checked'}>
      <input type="number" data-p-year step="1" min="1900" max="2100" value="${p.year}">
      <input type="text" class="p-cat" data-p-category list="costCategoryOptions" value="${esc(p.category)}">
      <select data-p-basis>
        <option value="annual"${p.basis === 'annual' ? ' selected' : ''}>Annual</option>
        <option value="monthly"${p.basis === 'monthly' ? ' selected' : ''}>Monthly avg</option>
      </select>
      <input type="text" inputmode="decimal" data-money data-p-amount value="${esc(formatMoneyInput(p.amount))}">
      <span class="p-annual">${p.basis === 'monthly' ? `= ${money2(annual)} / yr` : ''}</span>
      <input type="text" class="p-notes" data-p-notes placeholder="Notes" value="${esc(p.notes || '')}">
      ${conflict ? '<span class="conflict-tag">Already recorded — overwrites if checked</span>' : ''}
      <button type="button" class="small danger" data-p-remove title="Remove">×</button>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="costs-proposed"><h5>Proposed entries — review, then Apply</h5>${rows}
    <div class="toolbar" style="margin-top:6px">
      <button type="button" class="primary small" data-costs-apply>Apply selected</button>
      <button type="button" class="small" data-costs-discard>Discard</button>
    </div></div>`;
  host.querySelectorAll('[data-p-amount]').forEach((inp) => {
    wireMoneyInput(inp);
    const row = inp.closest('[data-proposed-row]');
    const sync = () => {
      const amt = parseMoneyInput(inp.value);
      const basis = row.querySelector('[data-p-basis]').value;
      row.querySelector('.p-annual').textContent = basis === 'monthly' && amt !== '' ? `= ${money2(amt * 12)} / yr` : '';
    };
    inp.addEventListener('input', sync);
    row.querySelector('[data-p-basis]').addEventListener('change', sync);
  });
}

// Read the proposed rows back out of their (editable) inputs.
function readCostsProposed() {
  const host = document.querySelector('[data-costs-proposed]');
  if (!host) return [];
  return [...host.querySelectorAll('[data-proposed-row]')].map((row) => ({
    checked: row.querySelector('[data-p-check]').checked,
    year: Number(row.querySelector('[data-p-year]').value),
    category: row.querySelector('[data-p-category]').value.trim(),
    basis: row.querySelector('[data-p-basis]').value,
    amount: parseMoneyInput(row.querySelector('[data-p-amount]').value),
    notes: row.querySelector('[data-p-notes]').value.trim() || null,
  }));
}

document.querySelector('[data-costs-proposed]').addEventListener('click', async (e) => {
  if (e.target.closest('[data-p-remove]')) {
    const row = e.target.closest('[data-proposed-row]');
    costsChatState.proposed = readCostsProposed()
      .filter((_, i) => i !== Number(row.dataset.proposedRow))
      .map(({ checked, ...rest }) => rest);
    renderCostsProposed();
    return;
  }
  if (e.target.closest('[data-costs-discard]')) {
    costsChatState.proposed = [];
    renderCostsProposed();
    return;
  }
  if (!e.target.closest('[data-costs-apply]')) return;
  const msg = document.querySelector('[data-costs-chat-msg]');
  const rows = readCostsProposed();
  const chosen = rows.filter((r) => r.checked);
  if (!chosen.length) { showMsg(msg, 'err', 'Nothing is selected to apply.'); return; }
  for (const r of chosen) {
    if (!Number.isInteger(r.year) || !r.category || r.amount === '') {
      showMsg(msg, 'err', 'A selected entry is missing its year, type or amount.');
      return;
    }
  }
  const applyBtn = e.target.closest('[data-costs-apply]');
  applyBtn.disabled = true;
  try {
    for (const r of chosen) {
      const { checked, ...entry } = r;
      await api(`/api/properties/${currentPropertyId}/costs`, { method: 'POST', body: { ...entry, source: 'ai' } });
    }
    costsChatState.proposed = rows.filter((r) => !r.checked).map(({ checked, ...rest }) => rest);
    costsChatState.turns.push({ role: 'assistant', content: `Applied ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}.` });
    renderCostsChatLog();
    const sum = document.querySelector('[data-costs-ai-summary]');
    sum.textContent = `Applied ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}`;
    sum.classList.remove('hidden');
    await loadCosts(currentPropertyId);
  } catch (err) {
    showMsg(msg, 'err', err.message);
  } finally {
    applyBtn.disabled = false;
  }
});

{
  const wrap = $('#costsAiFill');
  const panel = wrap.querySelector('[data-costs-ai-panel]');
  const toggle = wrap.querySelector('[data-costs-ai-toggle]');
  const sendBtn = wrap.querySelector('[data-costs-chat-send]');
  const modelSel = wrap.querySelector('[data-costs-chat-model]');
  const guidance = wrap.querySelector('[data-costs-ai-guidance]');
  const msg = wrap.querySelector('[data-costs-chat-msg]');
  loadAiConfig().then((cfg) => {
    const models = cfg.models && cfg.models.length ? cfg.models : (cfg.model ? [cfg.model] : []);
    modelSel.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (cfg.model) modelSel.value = cfg.model;
    if (!cfg.configured) {
      guidance.textContent = 'AI is not configured on the server. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the server .env file, then restart the server.';
      guidance.classList.remove('hidden');
      sendBtn.disabled = true;
    }
  });
  toggle.addEventListener('click', () => panel.classList.toggle('hidden'));
  sendBtn.addEventListener('click', async () => {
    const ta = wrap.querySelector('[data-costs-chat-text]');
    const fileInput = wrap.querySelector('[data-costs-chat-files]');
    const text = ta.value.trim();
    const files = fileInput.files ? [...fileInput.files] : [];
    if (!text && !files.length) { showMsg(msg, 'err', 'Write a message or attach a document first.'); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    renderCostsChatLog(text || '(attached documents)');
    try {
      const body = {
        propertyId: currentPropertyId,
        history: costsChatState.turns,
        proposed: readCostsProposed().map(({ checked, ...rest }) => rest),
      };
      if (modelSel.value) body.model = modelSel.value;
      if (text) body.text = text;
      if (files.length) {
        body.files = await Promise.all(files.map((f) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, type: f.type, data: String(reader.result).split(',')[1] || '' });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        })));
      }
      const r = await api('/api/ai/fill-chat', { method: 'POST', body });
      if (body.model && aiConfigCache) aiConfigCache.model = body.model;
      costsChatState.turns.push({ role: 'user', content: text || '(attached documents)' });
      if (r.reply) costsChatState.turns.push({ role: 'assistant', content: r.reply });
      costsChatState.proposed = r.proposed || [];
      ta.value = '';
      fileInput.value = '';
      renderCostsChatLog();
      renderCostsProposed();
    } catch (err) {
      renderCostsChatLog();
      showMsg(msg, 'err', err.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  });
}

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
async function loadChartImpl(id) {
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

async function loadEquityImpl(id) {
  equityData = await api(`/api/properties/${id}/equity`);
  renderEquity();
}

// --------------------------------------------------- detail range ---
// The detail panel's range is an explicit pair of months — a start
// month and an end month ('YYYY-MM') — and everything in the panel
// (chart, schedule, Total row, trend summary) follows exactly that
// pair. The preset buttons are shortcuts that FILL the pair: a
// look-back preset ends at the current month and starts N-1 months
// earlier (N months inclusive); "All" fills the whole data span.
// Picking either month by hand clears the preset highlight and the
// picked pair rules instead. (The portfolio overview keeps its own
// look-back buttons — separate state, untouched.)
function monthStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonthsYM(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

// The months the current property's data spans: from the earliest
// of (first assessed year, balance month, first projected month) to
// the latest of (last projected month, last assessed year's end).
// Null when there is no data at all.
function dataSpanMonths() {
  let start = null;
  let end = null;
  const lo = (v) => { if (v && (!start || v < start)) start = v; };
  const hi = (v) => { if (v && (!end || v > end)) end = v; };
  if (trendPoints.length) {
    lo(`${trendPoints[0].year}-01`);
    hi(`${trendPoints[trendPoints.length - 1].year}-12`);
  }
  if (chartMeta && chartMeta.balanceDate) lo(String(chartMeta.balanceDate).slice(0, 7));
  if (fullSeries.length) {
    lo(fullSeries[0].month);
    hi(fullSeries[fullSeries.length - 1].month);
  }
  return start && end ? { start, end } : null;
}

// A user-picked pair is clamped into the data span, and a start
// past the end pulls the END up to the start (never a swap, never
// an inverted range).
function clampRange(r, span) {
  if (!r) return null;
  let { start, end } = r;
  if (span) {
    if (start < span.start) start = span.start;
    if (start > span.end) start = span.end;
    if (end < span.start) end = span.start;
    if (end > span.end) end = span.end;
  }
  if (start > end) end = start;
  return { start, end };
}

// The range currently in force on the detail panel.
function currentDetailRange() {
  const span = dataSpanMonths();
  const active = $('#rangeBtns button.active');
  if (!active && customRange) return clampRange(customRange, span);
  const months = active ? Number(active.dataset.months) : 60;
  if (months === 0) return span; // All = the whole data span
  const end = monthStrOf(new Date());
  return { start: addMonthsYM(end, -(months - 1)), end };
}

// The range as a fractional-year window for the chart axis: from
// the first day of the start month to the first day of the month
// AFTER the end month, so the whole end month is inside.
function detailRangeWindow() {
  const r = currentDetailRange();
  if (!r) return null;
  return { startYM: r.start, endYM: r.end, min: ymDecimal(r.start), max: ymDecimal(r.end) + 1 / 12 };
}

// 'YYYY-MM' -> "Jan 2026", the From/To fields' display format.
function formatYM(ym) {
  if (!ym) return '—';
  const [y, m] = String(ym).split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// The From/To fields always show the range actually in force
// (preset-derived or clamped custom alike): the formatted month
// as the button text, the 'YYYY-MM' on data-value.
function syncRangeInputs() {
  const s = $('#rangeStart');
  const e = $('#rangeEnd');
  if (!s || !e) return;
  const span = dataSpanMonths();
  const r = currentDetailRange();
  for (const [btn, ym] of [[s, r && r.start], [e, r && r.end]]) {
    btn.dataset.value = ym || '';
    btn.textContent = formatYM(ym);
    btn.disabled = !span;
  }
  if (monthPopFor) renderMonthPop(); // keep an open picker in step with fresh bounds
}

// ------------------------------------------------------- range window ---
// The portfolio overview reads its range as a LOOK-BACK window
// that ENDS TODAY: "1 year" means the last 12 months up to today,
// "5 years" the last 60. "All" (0 months) is the exception: it
// keeps the whole data extent, full projection included, as the
// see-everything view. The choice lives in the range buttons
// themselves, so re-renders (new points, fresh data) keep the
// user's window instead of snapping back to the default. (The
// detail panel does NOT use this window anymore — it follows an
// explicit start/end month pair, see "detail range" above; only
// the portfolio helpers below still speak look-back.)

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

// Explicit x-axis window for the portfolio chart (which mixes
// assessed history with a mortgage projection). For a month range
// the axis IS the look-back window (see lookbackWindow): exactly
// the selected span,
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
    // A bare figure, by the user's ruling — no derivation sentence
    // trailing it ("— latest assessed value … minus outstanding …").
    el.textContent = `Current equity: ${money2(a.equity)}`;
  } else if (a.assessedValue !== null) {
    el.textContent = `Latest assessed value: ${money(a.assessedValue)}${a.assessedYear ? ` (${a.assessedYear})` : ''}. Add the outstanding principal in “Mortgage Terms & Rates” to see the equity.`;
  } else if (a.balance !== null) {
    el.textContent = `Outstanding principal: ${money2(a.balance)}. Fetch the assessed value from BC Assessment (in “Assessment History”) to see the equity.`;
  } else {
    el.textContent = 'Equity appears here once an assessed value and an outstanding principal is on record.';
  }
}

// The projection panel head's dedicated stat: the monthly payment
// in effect — the engine's calculated figure, or the current
// term's override when one is set (rendered via paymentHtml, so
// the calculated figure shows struck through beside it). It only
// exists once a rate plan (and an amortization) does; before that
// it shows '—'.
function renderEstPayment() {
  const v = $('#estPaymentValue');
  if (!v) return;
  v.innerHTML = paymentHtml(chartMeta);
}

function renderDetailCharts() {
  syncRangeInputs(); // the From/To inputs show the range in force
  renderEquity();
  renderTrendSummary(); // the summary follows the chart's current window
  renderEstPayment();
  renderMortgageMeta();
  drawCombinedChart();
  renderSchedule();
}

// The detail page's one chart (merged from the former pair): the
// assessed-value line and the outstanding-principal projection share
// its time axis with the payment-split bars — each projected month's
// (or, on spans over 10 years, each year's) interest and principal
// portions, stacked to the payment itself. Everything is governed
// by the panel's start/end month range: the lines AND the bars
// draw only the months inside it.
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
      showMsg(cmsg, 'warn', 'The outstanding principal is not projected yet — set the remaining amortization in “Mortgage Terms & Rates” (above) to project it.');
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
  const win0 = detailRangeWindow();
  if (trendPoints.length) {
    // Assessed points inside the selected month range (All = every
    // year on record). The points still stop at the last known
    // year — they are not extended toward today (see the charts
    // header comment). A year's point sits at its January, so it
    // counts as inside when that January falls in the range.
    const shown = win0
      ? trendPoints.filter((pt) => pt.year >= win0.min && pt.year < win0.max)
      : trendPoints;
    datasets.push({
      type: 'line',
      key: 'assessed',
      label: 'Assessed value',
      yAxisID: 'y',
      data: shown.map((pt) => ({ x: pt.year, y: pt.value })),
      ...seriesColors('hero', chartSeriesDef('hero', 'assessed')),
      // One value per assessment year, joined by straight line
      // segments like the portfolio chart (tension 0 — no smoothing
      // curve, no step).
      showLine: true, tension: 0, pointRadius: 5, pointHoverRadius: 7, order: 1,
    });
  }
  if (chartMeta && fullSeries.length) {
    const allPts = [{ x: ymDecimal(chartMeta.balanceDate), y: chartMeta.balance },
      ...fullSeries.map((r) => ({ x: ymDecimal(r.date || r.month), y: r.balance }))];
    // The projection is clipped to the same month range as the
    // axis: months outside the selected pair are not drawn here.
    const pts = win0 ? allPts.filter((p) => p.x >= win0.min && p.x < win0.max) : allPts;
    if (pts.length) {
      datasets.push({
        type: 'line',
        key: 'outstanding',
        label: 'Outstanding principal',
        yAxisID: 'y',
        data: pts,
        ...seriesColors('hero', chartSeriesDef('hero', 'outstanding')),
        tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, order: 1,
      });
      // Current equity: at every outstanding point, the assessed
      // line's own value minus the outstanding balance — on the
      // chart it is exactly the vertical distance between the
      // green and blue lines. The assessed line is read by
      // straight-segment interpolation between its year points
      // over the FULL history (not just the shown window), held
      // at its last value past the final point — the carry the
      // panel's Current equity figure uses; before the first
      // assessed point there is no line and no equity point.
      if (trendPoints.length) {
        const ap = [...trendPoints].sort((a, b) => a.year - b.year);
        const assessedAt = (x) => {
          if (x < ap[0].year) return null;
          for (let i = 0; i < ap.length; i++) {
            if (x <= ap[i].year) {
              if (i === 0) return ap[0].value;
              const a = ap[i - 1]; const b = ap[i];
              return a.value + (b.value - a.value) * ((x - a.year) / (b.year - a.year));
            }
          }
          return ap[ap.length - 1].value;
        };
        const eqPts = [];
        for (const p of pts) {
          const a = assessedAt(p.x);
          if (a !== null) eqPts.push({ x: p.x, y: Math.round((a - p.y) * 100) / 100 });
        }
        if (eqPts.length) {
          datasets.push({
            type: 'line',
            key: 'equity',
            label: 'Current equity',
            yAxisID: 'y',
            data: eqPts,
            ...seriesColors('hero', chartSeriesDef('hero', 'equity')),
            tension: 0.15, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, order: 1,
          });
        }
      }
    }
  }
  // The axis is exactly the selected month range — never the
  // library's auto-fit.
  const win = win0 ? { min: win0.min, max: win0.max } : null;
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
    const rows = fullSeries.filter((r) => r.month >= win0.startYM && r.month <= win0.endYM);
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
        key: 'interest',
        label: 'Interest portion',
        yAxisID: 'y1',
        data: pts.map((p) => ({ x: p.x, y: p.interest })),
        ...seriesColors('hero', chartSeriesDef('hero', 'interest')),
        stack: 'payment', borderWidth: 1, order: 2,
      });
      datasets.push({
        type: 'bar',
        key: 'principal',
        label: 'Principal portion',
        yAxisID: 'y1',
        data: pts.map((p) => ({ x: p.x, y: p.principal })),
        ...seriesColors('hero', chartSeriesDef('hero', 'principal')),
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
            label: (item) => ` ${item.dataset.label}: ${item.dataset.key === 'assessed' ? money(item.parsed.y) : money2(item.parsed.y)}${item.dataset.yAxisID === 'y1' ? ' (payment axis)' : ' (value axis)'}`,
            footer: (items) => {
              const it = items[0];
              if (!it || it.dataset.stack !== 'payment') return '';
              const bars = it.chart.data.datasets.filter((d) => d.stack === 'payment');
              const total = bars.reduce((s, d) => s + (d.data[it.dataIndex] ? d.data[it.dataIndex].y : 0), 0);
              return barsBasis === 'yearly' ? `Total payments that year: ${money2(total)}` : `Total payment: ${money2(total)}`;
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
          // The ceiling rounds UP to a clean 500 step: the exact
          // max becomes a tick label, and a calculated payment is
          // never round — an unrounded ceiling (3198.833) prints a
          // long decimal that widens this axis and can squeeze the
          // x axis into skipping every other month tick.
          ...(barMax > 0 ? { max: Math.ceil((barMax * 1.1) / 500) * 500 } : {}),
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
  const r = currentDetailRange();
  if (!r) return fullSeries.slice();
  return fullSeries.filter((row) => row.month >= r.start && row.month <= r.end);
}

function scheduleYears() {
  return [...new Set(scheduleWindowRows().map((r) => String(r.month).slice(0, 4)))];
}

function renderSchedule() {
  const tbody = $('#scheduleRows');
  if (!tbody) return;
  const pager = $('#schedulePager');
  const totalRow = $('#scheduleTotalRow');
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
    // Automatic page: today's year — EXCEPT right after a range
    // change, which reopens on the range's first page so the table
    // visibly starts where the picked range starts (with the old
    // rule a pick that kept today's year in range left the visible
    // rows byte-identical and the table looked unresponsive).
    scheduleYear = !schedulePageFirst && years.includes(todayYear) ? todayYear : years[0];
    schedulePageFirst = false;
  }
  const pageRows = rows.filter((r) => String(r.month).slice(0, 4) === scheduleYear);
  tbody.innerHTML = pageRows.map((r) => `<tr>
    <td>${monthLabel(r.month)}</td>
    <td class="num">${money2(r.payment)}</td>
    <td class="num">${money2(r.principal)}</td>
    <td class="num">${money2(r.interest)}</td>
    <td class="num">${money2(r.balance)}</td></tr>`).join('');
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
    <td class="num sum-payment" data-value="${sum('payment')}">${money2(sum('payment'))}</td>
    <td class="num sum-principal" data-value="${sum('principal')}">${money2(sum('principal'))}</td>
    <td class="num sum-interest" data-value="${sum('interest')}">${money2(sum('interest'))}</td>
    <td class="num">${money2(last.balance)}</td>`;
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
  customRange = null; // a preset fills the From/To pair on render
  if (currentPropertyId) { schedulePageFirst = true; loadChart(currentPropertyId); }
});
// ------------------------------------------------------ month picker ---
// From/To are button fields; one shared popover (a year stepper
// over a 12-month grid) serves both. Picking a month applies the
// pair exactly as the pickers' state machine always has: the
// preset highlight clears, the pair clamps into the data span (a
// start past the end pulls the end up to the start) and the
// projection refetches. Months outside the data span render
// disabled in the grid, and the year stepper stops at the span's
// first/last years.
function renderMonthPop() {
  const pop = $('#monthPop');
  if (!pop || !monthPopFor) return;
  const span = dataSpanMonths();
  if (!span) { closeMonthPop(); return; }
  const field = monthPopFor === 'start' ? $('#rangeStart') : $('#rangeEnd');
  const selected = field ? field.dataset.value : '';
  // The stepper's bounds are the span's years, widened to include
  // the field's own year when a preset filled a pair reaching
  // past the span (a look-back can start a few months before the
  // first data point) — the current value must stay visible.
  const selYear = selected ? Number(selected.slice(0, 4)) : null;
  const minYear = Math.min(Number(span.start.slice(0, 4)), selYear ?? Infinity);
  const maxYear = Math.max(Number(span.end.slice(0, 4)), selYear ?? -Infinity);
  if (monthPopYear == null) monthPopYear = selected ? Number(selected.slice(0, 4)) : maxYear;
  monthPopYear = Math.min(Math.max(monthPopYear, minYear), maxYear);
  $('#monthPopYear').textContent = String(monthPopYear);
  $('#monthPopPrev').disabled = monthPopYear <= minYear;
  $('#monthPopNext').disabled = monthPopYear >= maxYear;
  $('#monthPopGrid').innerHTML = MONTH_NAMES.map((name, i) => {
    const ym = `${monthPopYear}-${String(i + 1).padStart(2, '0')}`;
    const off = ym < span.start || ym > span.end;
    return `<button type="button" data-ym="${ym}"${off ? ' disabled' : ''}${ym === selected ? ' class="sel"' : ''}>${name}</button>`;
  }).join('');
}

function openMonthPop(which) {
  const field = which === 'start' ? $('#rangeStart') : $('#rangeEnd');
  if (!field || field.disabled) return;
  monthPopFor = which;
  monthPopYear = field.dataset.value ? Number(field.dataset.value.slice(0, 4)) : null;
  renderMonthPop();
  if (!monthPopFor) return; // no data span — renderMonthPop closed it
  const pop = $('#monthPop');
  pop.classList.remove('hidden');
  const bar = $('#rangeBtns');
  const left = Math.max(0, Math.min(field.offsetLeft, bar.clientWidth - pop.offsetWidth - 4));
  pop.style.left = `${left}px`;
  pop.style.top = `${field.offsetTop + field.offsetHeight + 6}px`;
  $('#rangeStart').setAttribute('aria-expanded', String(which === 'start'));
  $('#rangeEnd').setAttribute('aria-expanded', String(which === 'end'));
}

function closeMonthPop() {
  monthPopFor = null;
  const pop = $('#monthPop');
  if (pop) pop.classList.add('hidden');
  const s = $('#rangeStart');
  const e = $('#rangeEnd');
  if (s) s.setAttribute('aria-expanded', 'false');
  if (e) e.setAttribute('aria-expanded', 'false');
}

function onMonthFieldClick(which) {
  if (monthPopFor === which) { closeMonthPop(); return; }
  openMonthPop(which);
}
$('#rangeStart').addEventListener('click', () => onMonthFieldClick('start'));
$('#rangeEnd').addEventListener('click', () => onMonthFieldClick('end'));

$('#monthPop').addEventListener('click', (e) => {
  if (e.target.closest('#monthPopPrev')) { monthPopYear -= 1; renderMonthPop(); return; }
  if (e.target.closest('#monthPopNext')) { monthPopYear += 1; renderMonthPop(); return; }
  const cell = e.target.closest('button[data-ym]');
  if (!cell || cell.disabled || !monthPopFor) return;
  const start = monthPopFor === 'start' ? cell.dataset.ym : $('#rangeStart').dataset.value;
  const end = monthPopFor === 'end' ? cell.dataset.ym : $('#rangeEnd').dataset.value;
  closeMonthPop();
  if (!start || !end) return;
  document.querySelectorAll('#rangeBtns button').forEach((b) => b.classList.remove('active'));
  customRange = clampRange({ start, end }, dataSpanMonths());
  syncRangeInputs();
  if (currentPropertyId) { schedulePageFirst = true; loadChart(currentPropertyId); }
});

// Popover etiquette: a click anywhere outside it (or Esc) closes
// it; only one is ever open — the other field's click retargets it.
document.addEventListener('click', (e) => {
  if (!monthPopFor) return;
  if (e.target.closest('#monthPop') || e.target.closest('#rangeStart') || e.target.closest('#rangeEnd')) return;
  closeMonthPop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && monthPopFor) closeMonthPop();
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

async function loadAdminImpl() {
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
  await loadChartColorPrefs();
  ownerPickers.forEach((p) => p.refresh());
  route();
})();
