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
    timer = setTimeout
(async () => {
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
// Rental form address: same BC Assessment suggest as the property forms.
// A picked suggestion only fills the standalone address text — it never
// creates a property link (a BCA address is not an app property).
const earnRentalSuggest = attachAddressSuggest(
  $('#earnRentalForm .address-input'), $('#earnRentalForm .suggest-list'));

// --------------------------------------------------- security suggest ---
// Dropdown autocomplete for the holding form's label / symbol
// inputs, backed by GET /api/invest/search (Yahoo Finance).
// Picking a candidate fills label, symbol, kind=exchange and
// currency in one go. Strictly an enhancement: the endpoint
// degrades to an empty list on failure, and free-text entry —
// the bank-fund path — never requires a pick.
function attachSecuritySuggest(input, list, onPick) {
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
    items.forEach((c, i) => {
      const li = document.createElement('li');
      const sym = document.createElement('span');
      sym.className = 'sg-sym';
      sym.textContent = c.symbol;
      li.appendChild(sym);
      li.appendChild(document.createTextNode(' ' + c.label));
      const meta = [c.exchange, c.currency].filter(Boolean).join(' · ');
      if (meta) {
        const m = document.createElement('span');
        m.className = 'sg-meta';
        m.textContent = meta;
        li.appendChild(m);
      }
      if (i === active) li.classList.add('active');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.appendChild(li);
    });
    list.classList.remove('hidden');
  }
  function pick(i) {
    const c = items[i];
    if (!c) return;
    close();
    onPick(c);
    input.focus();
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const data = await api('/api/invest/search?q=' + encodeURIComponent(q));
        if (my !== seq) return;
        items = data.results || [];
        active = items.length ? 0 : -1;
        render();
      } catch { if (my === seq) close(); }
    }, 250);
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
  return { close };
}
function fillHoldingFromCandidate(c) {
  const form = $('#investHoldingForm');
  form.elements.label.value = c.label || '';
  form.elements.symbol.value = c.symbol || '';
  form.elements.kind.value = 'exchange';
  if (c.currency) form.elements.currency.value = c.currency;
}
attachSecuritySuggest(
  $('#investHoldingForm [name="symbol"]'), $('#investHoldingForm [data-symbol-suggest]'), fillHoldingFromCandidate);
attachSecuritySuggest(
  $('#investHoldingForm [name="label"]'), $('#investHoldingForm [data-label-suggest]'), fillHoldingFromCandidate);

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
  { key: 'investments', label: 'Stocks' },
  { key: 'fixed-assets', category: 'fixed_assets', label: 'Fixed assets', addLabel: 'Add fixed asset' },
  { key: 'term-deposits', category: 'term_deposits', label: 'Term deposits', addLabel: 'Add term deposit' },
  // The registry's old standalone 'stocks' section is retired (the real
  // Stocks module lives at 'investments'); stocks-category entries are
  // kept — data and summary totals unchanged — and listed under Other,
  // each row tagged with its category.
  { key: 'other', category: 'other', categories: ['other', 'stocks'], label: 'Other', addLabel: 'Add asset' },
];
const CATEGORY_LABELS = { fixed_assets: 'Fixed assets', stocks: 'Stocks', term_deposits: 'Term deposits', other: 'Other' };
const SECTION_CATEGORIES = (s) => s.categories || [s.category];
const SECTION_OF_CATEGORY = Object.fromEntries(
  ASSET_SECTIONS.filter((s) => s.category).flatMap((s) => SECTION_CATEGORIES(s).map((c) => [c, s.key])));

let currentPropertyId = null;
let currentAssetId = null;
let currentSection = 'overview';

function showView(name) {
  for (const v of ['assets', 'property', 'asset', 'invest-account', 'invest-holding', 'earnings', 'spending', 'planning', 'tax', 'admin']) {
    $('#view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('#mainNav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === (['property', 'asset', 'invest-account', 'invest-holding'].includes(name) ? 'assets' : name))
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
  } else if (hash.startsWith('#invest-account/')) {
    currentInvestAccountId = Number(hash.split('/')[1]);
    showView('invest-account');
    loadInvestAccount(currentInvestAccountId);
  } else if (hash.startsWith('#invest-holding/')) {
    currentInvestHoldingId = Number(hash.split('/')[1]);
    showView('invest-holding');
    loadInvestHolding(currentInvestHoldingId);
  } else if (hash === '#admin') {
    showView('admin');
    loadAdmin();
  } else if (hash.startsWith('#earnings/job/')) {
    // Job detail page: its own route, Salary tab active, list hidden.
    currentEarnJobId = Number(hash.split('/')[2]);
    showView('earnings');
    $('#earn-overview').classList.add('hidden');
    $('#earn-salary').classList.add('hidden');
    $('#earn-rentals').classList.add('hidden');
    $('#earnJobDetail').classList.remove('hidden');
    document.querySelectorAll('#earningsNav a').forEach((a) =>
      a.classList.toggle('active', a.dataset.section === 'salary'));
    loadEarnJobDetail(currentEarnJobId);
  } else if (hash === '#earnings' || hash.startsWith('#earnings/')) {
    showView('earnings');
    const sub = hash.split('/')[1] || 'salary';
    $('#earn-overview').classList.toggle('hidden', sub !== 'overview');
    $('#earn-salary').classList.toggle('hidden', sub !== 'salary');
    $('#earn-rentals').classList.toggle('hidden', sub !== 'rentals');
    $('#earnJobDetail').classList.add('hidden');
    document.querySelectorAll('#earningsNav a').forEach((a) =>
      a.classList.toggle('active', a.dataset.section === sub));
    loadEarnings();
  } else if (hash === '#spending' || hash.startsWith('#spending/')) {
    showView('spending');
    if (hash.startsWith('#spending/card/')) {
      currentSpendCardId = Number(hash.split('/')[2]);
      $('#spendList').classList.add('hidden');
      $('#spendCardDetail').classList.remove('hidden');
      loadSpendCard(currentSpendCardId);
    } else {
      $('#spendCardDetail').classList.add('hidden');
      $('#spendList').classList.remove('hidden');
      loadSpending();
    }
  } else if (['#planning', '#tax'].includes(hash)) {
    showView(hash.slice(1));
  } else {
    // '#assets' or '#assets/<section>'
    let key = hash.split('/')[1] || 'overview';
    // Retired registry section: old '#assets/stocks' links land on
    // Other, where stocks-category entries now live.
    if (key === 'stocks') {
      history.replaceState(null, '', '#assets/other');
      key = 'other';
    }
    showView('assets');
    showSection(ASSET_SECTIONS.some((s) => s.key === key) ? key : 'overview');
    loadAssets();
    if (key === 'investments') loadInvestments();
    if (key === 'overview') loadOverviewChart();
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
const investAccountOwnerPicker = createOwnerPicker($('#investAccountOwnerPicker'));
const ownerPickers = [addPropOwnerPicker, propOwnerPicker, assetOwnerPicker, investAccountOwnerPicker];

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
// Router entry resets each page to its default display (the
// toggle is per-visit only): the overview always opens in CAD,
// an account/holding page opens in its server default (null
// here = "let the server decide"), and only the toggle handler
// below sets a non-default display for the current visit.
async function loadInvestments() { investDisplay.investments = 'CAD'; return withLoading(() => loadInvestmentsImpl()); }
async function loadInvestAccount(id) { investDisplay.investAccount = null; return withLoading(() => loadInvestAccountImpl(id)); }
async function loadInvestHolding(id) { investDisplay.investHolding = null; return withLoading(() => loadInvestHoldingImpl(id)); }

// Overview chart panel: rendered on every visit to the Overview
// section (fresh data each time, like the Stocks page reloads).
// The summary strip above it is untouched — this panel is an
// asset-composition view only and never feeds net worth.
async function loadOverviewChart() { return withLoading(() => loadOverviewChartImpl()); }
async function loadOverviewChartImpl() {
  const host = $('#overviewChartPanel');
  if (!host) return;
  const old = INVEST_LEVEL_CONF.overview.get();
  if (old) old.destroy();
  if (overviewShareChart) { overviewShareChart.destroy(); overviewShareChart = null; }
  overviewShareCenter = null;
  window.__fmCharts.overview = null;
  window.__fmCharts.overviewShare = null;
  host.innerHTML = `
    <div class="panel">
      <h3>Assets over time</h3>
      ${investRangeControlsHtml('overview')}
      <div class="invest-charts-row">
        <div class="invest-share-col">
          <div class="invest-share-head"><h3 id="overviewShareTitle">Asset share</h3></div>
          <div class="invest-share-box" id="overviewShareWrap"><div class="chart-wrap invest-share"><canvas id="overviewShareChart"></canvas></div></div>
          <div class="note hidden" id="overviewShareEmpty">No asset values yet.</div>
        </div>
        <div class="invest-main-chart"><div class="chart-wrap tall"><canvas id="overviewChart"></canvas></div></div>
      </div>
    </div>`;
  const data = await api('/api/overview/chart');
  if (currentSection !== 'overview') return;
  if (data.fxMissing && data.hasUsdHoldings) {
    const row = host.querySelector('.invest-charts-row');
    if (row) {
      const warn = document.createElement('div');
      warn.className = 'msg warn';
      warn.textContent = 'USD/CAD rates are unavailable right now — USD holdings are shown unconverted in the Stock totals.';
      row.before(warn);
    }
  }
  const monthly = overviewMonthly(data.propertyByMonth, data.stockSeries, data.currentMonth);
  investViewData.overview = {
    series: monthly.map((m) => ({ month: m.month, value: m.total })),
    monthly, cur: 'CAD',
    propertyByMonth: data.propertyByMonth, stockSeries: data.stockSeries,
  };
  wireInvestRangeControls('overview');
  applyInvestRange('overview');
}

function markAssetsDirty() { assetsLoaded = false; }

async function loadAssetsImpl(force = false) {
  if (assetsLoaded && !force) return;
  assetsLoaded = true;
  const [summary, properties, assets, investData] = await Promise.all([
    api('/api/summary'), api('/api/properties'), api('/api/assets'),
    // Stocks card (CAD): the same endpoint the Stocks page reads.
    // A failure must never break the assets pages, so the card is
    // simply omitted when the read fails.
    api('/api/investments?display=CAD').catch(() => null),
  ]);

  // Overview: per-section breakdown cards. The top summary strip
  // is gone (2026-10-29 redesign): the Properties card carries
  // assessed value + total equity, and Stocks joins as its own
  // card (CAD total + counts, same click-through as the rest).
  const byCategory = {};
  for (const a of assets) {
    byCategory[a.category] = byCategory[a.category] || { count: 0, total: 0 };
    byCategory[a.category].count++;
    byCategory[a.category].total += Number(a.value || 0);
  }
  const propertyEquity = summary.propertyValue - summary.mortgageBalance;
  const investAccounts = investData ? investData.accounts || [] : [];
  const investHoldings = investAccounts.reduce((n, a) => n + (a.holdings || []).length, 0);
  const breakdown = [
    { key: 'properties', label: 'Properties', figures: [{ label: 'Assessed', value: summary.propertyValue, cents: false }, { label: 'Equity', value: propertyEquity, cents: true }], note: `${summary.propertyCount} ${summary.propertyCount === 1 ? 'property' : 'properties'}` },
    ...(investData ? [{ key: 'investments', label: 'Stocks', value: investData.summary ? investData.summary.value : 0, note: `${investAccounts.length} ${investAccounts.length === 1 ? 'account' : 'accounts'} · ${investHoldings} ${investHoldings === 1 ? 'holding' : 'holdings'}` }] : []),
    ...ASSET_SECTIONS.filter((s) => s.category).map((s) => {
      const cats = SECTION_CATEGORIES(s);
      return {
        key: s.key, label: s.label,
        value: cats.reduce((sum, c) => sum + (byCategory[c] || { total: 0 }).total, 0),
        note: `${cats.reduce((sum, c) => sum + (byCategory[c] || { count: 0 }).count, 0)} entries`,
      };
    }),
  ];
  $('#breakdownCards').innerHTML = breakdown.map((b) => `
    <div class="card breakdown-card" onclick="location.hash='#assets/${b.key}'">
      <div class="k">${b.label}</div>${b.figures ? `<div class="breakdown-figures">${b.figures.map((f) => `<div class="breakdown-figure"><div class="k">${f.label}</div><div class="v">${f.cents ? money2(f.value) : money(f.value)}</div></div>`).join('')}</div>` : `<div class="v">${money(b.value)}</div>`}<div class="n">${esc(b.note)}</div>
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

  // One listing table per other-asset section (a section may cover
  // several categories — Other also lists stocks-category entries,
  // each row tagged with its category).
  for (const s of ASSET_SECTIONS.filter((x) => x.category)) {
    const cats = SECTION_CATEGORIES(s);
    const rows = assets.filter((a) => cats.includes(a.category));
    const subtotal = rows.reduce((sum, a) => sum + Number(a.value || 0), 0);
    const body = rows.map((a) => `<tr class="clickable" onclick="location.hash='#asset/${a.id}'">
      <td>${esc(a.name)}${cats.length > 1 ? ` <span class="badge">${esc(CATEGORY_LABELS[a.category] || a.category)}</span>` : ''}</td><td class="num">${money(a.value)}</td><td>${esc(a.currency)}</td>
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
  const sectionDef = ASSET_SECTIONS.find((s) => s.key === section);
  $('#assetBackLink').href = '#assets/' + section;
  $('#assetBackLink').textContent = '← Back to ' + (sectionDef ? sectionDef.label : 'Assets');
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
    if ((key === 'pay_changes' || key === 'bonuses') && extras.jobRows) {
      const rows = Array.isArray(value) ? value : [];
      const existing = key === 'pay_changes' ? extras.jobRows.getPayChanges() : extras.jobRows.getBonuses();
      // Hand-entered rows are never overwritten — like hand-filled
      // scalar fields, they count as kept. Row sections carry no
      // per-row ✨ flag (there is no single input to flag); the
      // filled rows sit in the form for review, and the panel
      // summary counts them.
      if (existing.length || !rows.length) { if (existing.length) kept += 1; continue; }
      form._aiFilling = true;
      if (key === 'pay_changes') extras.jobRows.setPayChanges(rows); else extras.jobRows.setBonuses(rows);
      form._aiFilling = false;
      filled += 1;
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
        <input type="file" accept="image/*,application/pdf,.csv,.txt" data-ai-file>
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
  // The error line reports the last Extract's outcome: picking
  // a file supersedes it (the costs chat clears by the same
  // rule), and Extract itself already clears before running.
  const aiFileInput = wrap.querySelector('[data-ai-file]');
  aiFileInput.addEventListener('change', () => { msg.textContent = ''; msg.className = 'msg'; });
  // Paste: a clipboard carrying a file fills the file input
  // (the panel's single attachment); a text clipboard pastes
  // as text, untouched.
  wrap.querySelector('[data-ai-text]').addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length) return;
    e.preventDefault();
    const dt = new DataTransfer();
    dt.items.add(files[0]);
    aiFileInput.files = dt.files;
    msg.textContent = '';
    msg.className = 'msg';
  });
  extractBtn.addEventListener('click', async () => {
    const text = wrap.querySelector('[data-ai-text]').value.trim();
    const fileInput = wrap.querySelector('[data-ai-file]');
    const file = fileInput.files && fileInput.files[0];
    msg.textContent = '';
    msg.className = 'msg';
    if (!text && !file) { showMsg(msg, 'err', 'Paste text or attach a photo, PDF or text file first.'); return; }
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
  earnOverview: [
    { key: 'salary', label: 'Salary net', bg: '#1668c4', border: '#1668c4', bgAlpha: null },
    { key: 'rental', label: 'Rental net', bg: '#2e7d4f', border: '#2e7d4f', bgAlpha: null },
  ],
  earnSalary: [
    { key: 'gross', label: 'Annual gross', bg: '#1668c4', border: '#1668c4', bgAlpha: null },
    { key: 'net', label: 'Annual net', bg: '#2e7d4f', border: '#2e7d4f', bgAlpha: null },
  ],
  earnRentals: [
    { key: 'gross', label: 'Gross rents', bg: '#1668c4', border: '#1668c4', bgAlpha: null },
    { key: 'expenses', label: 'Deductible expenses', bg: '#d97706', border: '#d97706', bgAlpha: null },
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

// Earnings dynamic series, same idea as the portfolio's per-property
// defs: the per-earner / per-employer / per-rental series are keyed
// by their semantic name, so a stored color keeps matching.
let earnChartData = null;
const earnDef = (key, label, i) => ({ key, label, bg: PF_COLORS[i % PF_COLORS.length], border: PF_COLORS[i % PF_COLORS.length], bgAlpha: null });
function earnOverviewSeriesDefs() {
  const defs = [...CHART_SERIES.earnOverview];
  if (earnChartData) earnChartData.earners.forEach((e, i) => defs.push(earnDef(`earner:${e}`, `${e} salary net`, i + 2)));
  return defs;
}
function earnSalarySeriesDefs() {
  const defs = [...CHART_SERIES.earnSalary];
  if (earnChartData) earnChartData.employers.forEach((e, i) => defs.push(earnDef(`employer:${e}`, `${e} net`, i + 2)));
  return defs;
}
function earnRentalsSeriesDefs() {
  const defs = [];
  if (earnChartData) earnChartData.properties.forEach((p, i) => defs.push(earnDef(`rental:${p.id}`, `${p.label} net`, i)));
  return [...defs, ...CHART_SERIES.earnRentals];
}
const earnSeriesDefs = { earnOverview: earnOverviewSeriesDefs, earnSalary: earnSalarySeriesDefs, earnRentals: earnRentalsSeriesDefs };

function seriesDefFor(chartId, key) {
  if (chartId === 'portfolio') return portfolioSeriesDefs().find((d) => d.key === key) || null;
  if (earnSeriesDefs[chartId]) return earnSeriesDefs[chartId]().find((d) => d.key === key) || null;
  return chartSeriesDef(chartId, key);
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

const LIVE_CHARTS = { hero: () => chartA, history: () => historyChart, portfolio: () => portfolioLineChart, earnOverview: () => earnOverviewChart, earnSalary: () => earnSalaryChart, earnRentals: () => earnRentalsChart };

// The draw colors for one explicit hex, under the same rules
// seriesColors applies to a stored one.
function colorsForHex(def, hex) {
  return {
    backgroundColor: def.bgAlpha == null ? hex : hexToRgba(hex, def.bgAlpha),
    borderColor: def.border ? hex : def.bg,
  };
}

// Recolor the live chart instance in place (the builders also
// read the same preferences when a chart is rebuilt). With
// `overrides` ({key: hex}) those series draw from the overrides
// instead — the Colors panel's unsaved preview.
function applyChartColors(chartId, overrides) {
  const get = LIVE_CHARTS[chartId];
  const chart = get ? get() : null;
  if (!chart) return;
  for (const ds of chart.data.datasets) {
    if (!ds.key) continue;
    const def = seriesDefFor(chartId, ds.key);
    if (!def) continue;
    const c = overrides && overrides[ds.key] ? colorsForHex(def, overrides[ds.key]) : seriesColors(chartId, def);
    ds.backgroundColor = c.backgroundColor;
    if (def.border) ds.borderColor = c.borderColor;
  }
  chart.update('none');
}

// -------------------------------------------------- colors panel ---
// The panel edits a STAGE, not the stored preferences. Opening
// a chart's panel snapshots its effective colors (stored, else
// default) into colorsStage[chartId]; moving a picker moves
// the stage and previews it on the live chart, but nothing is
// written — to chartColorPrefs or to the DB — until Save.
// Save commits the stage (only series moved off their default
// are stored, so a full Reset + Save leaves no entry at all)
// and closes the panel. Closing the panel any other way — a
// click outside it, Esc, opening another chart's panel —
// discards the stage and the chart re-applies its stored
// colors. Reset returns the stage to the defaults; it too
// waits for Save.
const colorsStage = {}; // chartId -> {key: hex}

function colorsDefs(chartId) {
  if (chartId === 'portfolio') return portfolioSeriesDefs();
  if (earnSeriesDefs[chartId]) return earnSeriesDefs[chartId]();
  return CHART_SERIES[chartId] || [];
}

function effectiveColor(chartId, def) {
  return (chartColorPrefs[chartId] && chartColorPrefs[chartId][def.key]) || def.border || def.bg;
}

function stageColors(chartId) {
  const stage = {};
  for (const def of colorsDefs(chartId)) stage[def.key] = effectiveColor(chartId, def);
  colorsStage[chartId] = stage;
  return stage;
}

function discardColorsStage(chartId) {
  if (!colorsStage[chartId]) return;
  delete colorsStage[chartId];
  applyChartColors(chartId); // back to the stored colors
  const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
  if (panel) panel.classList.add('hidden');
}

function saveColorsPanel(chartId) {
  const stage = colorsStage[chartId];
  if (stage) {
    const kept = {};
    for (const def of colorsDefs(chartId)) {
      const v = stage[def.key];
      const dflt = def.border || def.bg;
      if (v && String(v).toLowerCase() !== String(dflt).toLowerCase()) kept[def.key] = v;
    }
    if (Object.keys(kept).length) chartColorPrefs[chartId] = kept;
    else delete chartColorPrefs[chartId];
    delete colorsStage[chartId];
    saveChartColorPrefs(true);
    applyChartColors(chartId);
  }
  const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
  if (panel) panel.classList.add('hidden');
}

// One row per series: its name and a native color input holding
// the staged color (the stored one when no stage is live), then
// Reset and Save for the whole chart. The row of the series
// last right-clicked in the legend (see the legend gestures
// below) renders highlighted.
function buildColorsPanel(chartId) {
  const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
  if (!panel) return;
  const stage = colorsStage[chartId];
  panel.innerHTML = colorsDefs(chartId).map((def) => {
    const current = stage && stage[def.key] ? stage[def.key] : effectiveColor(chartId, def);
    const hl = legendHighlightKey[chartId] === def.key ? ' cc-highlight' : '';
    return `<span class="cc-row${hl}"><span>${esc(def.label)}</span><input type="color" data-color-input="${esc(def.key)}" value="${esc(current)}"></span>`;
  }).join('') + '<button type="button" class="small" data-colors-reset>Reset</button>'
    + '<button type="button" class="small primary" data-colors-save>Save</button>';
}

document.addEventListener('click', (e) => {
  const reset = e.target.closest('[data-colors-reset]');
  if (reset) {
    const panel = reset.closest('[data-colors-panel]');
    if (!panel) return;
    const chartId = panel.dataset.colorsPanel;
    // Reset is staged like any other edit: the pickers and the
    // preview go back to the defaults, Save still has to commit.
    const stage = colorsStage[chartId] || stageColors(chartId);
    for (const def of colorsDefs(chartId)) stage[def.key] = def.border || def.bg;
    applyChartColors(chartId, stage);
    buildColorsPanel(chartId);
    return;
  }
  const save = e.target.closest('[data-colors-save]');
  if (save) {
    const panel = save.closest('[data-colors-panel]');
    if (panel) saveColorsPanel(panel.dataset.colorsPanel);
  }
});
document.addEventListener('input', (e) => {
  const input = e.target.closest ? e.target.closest('[data-color-input]') : null;
  if (!input) return;
  const panel = input.closest('[data-colors-panel]');
  if (!panel) return;
  const chartId = panel.dataset.colorsPanel;
  if (!colorsStage[chartId]) stageColors(chartId);
  colorsStage[chartId][input.dataset.colorInput] = input.value;
  applyChartColors(chartId, colorsStage[chartId]); // preview only — nothing is stored
});
// Closing a panel without Save discards its stage: a pointer
// press anywhere outside an open panel, or Esc.
document.addEventListener('mousedown', (e) => {
  for (const chartId of Object.keys(colorsStage)) {
    const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
    if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target)) {
      discardColorsStage(chartId);
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const chartId of Object.keys(colorsStage)) discardColorsStage(chartId);
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
// menu. That right click is the panel's only entry — the chart
// headers used to carry a Colors button too; it was removed as
// visual clutter. All three charts behave identically.
const legendHighlightKey = {}; // chartId -> series key last right-clicked

function openColorsPanel(chartId, focusKey) {
  const panel = document.querySelector(`[data-colors-panel="${chartId}"]`);
  if (!panel) return;
  // One live stage at a time: opening a panel discards any
  // other chart's unsaved stage.
  for (const other of Object.keys(colorsStage)) {
    if (other !== chartId) discardColorsStage(other);
  }
  if (!colorsStage[chartId]) stageColors(chartId);
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
wireLegendContextMenu('earnOverview', 'earnOverviewChart');
wireLegendContextMenu('earnSalary', 'earnSalaryChart');
wireLegendContextMenu('earnRentals', 'earnRentalsChart');

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
$('#pfPieEquityBtn').addEventListener('click', () => { pfPieMetric = 'equity'; drawPortfolioPie(); });

let chartA = null; // merged detail chart: assessed + outstanding lines, interest/principal bars
let fullSeries = [];
let chartMeta = null;
let chartBarsBasis = null; // 'monthly' | 'yearly' | null — set by drawCombinedChart
let scheduleYear = null; // the monthly schedule's open year page; null = automatic
let schedulePageFirst = false; // a range change reopens the schedule on the range's FIRST year page
let customRange = null; // detail chart range the user picked by month { start, end } ('YYYY-MM'); null = a preset rules
let monthPopFor = null; // which From/To field the month picker is open for: 'start' | 'end' (property range) | 'entryStart' | 'entryEnd' (rent entry modal) | null
let monthPopYear = null; // the year the open month picker is browsing
let amortError = null; // last non-ok amortization response ({ error, code })
let detailProperty = null;
let equityData = null;
// Test/debug hook: lets the screenshot script read the live chart configs.
window.__fmCharts = Object.assign(window.__fmCharts || {}, { a: null, b: null, prime: null, history: null, earnOverview: null, earnSalary: null, earnRentals: null });

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
// utilities…). The input surface is ONE table — the year the
// panel's top selector is on — and it is READ-ONLY until the
// top row's Edit switch opens edit mode: only then do the
// rows' Edit / Delete buttons, the table's "+ Add row" and
// the top row's "+ Add year" appear (rows then edit in place:
// Edit → Save / Cancel); Done closes edit mode again. The
// year's total sits in the table footer either way. The
// selector shares the panel's top row with the Edit switch
// and the AI fill toggle — both of which live outside edit
// mode — and it also drives the pie's year and the combo
// chart's By month year (By year shows all years).
// Amounts are stored in their recorded basis: 'annual' = the
// year's total; 'monthly' = the recorded months are kept
// (monthlyAmounts) and amount is their average — computed by
// the SERVER, never typed in. A monthly row recorded before
// per-month detail existed carries no months: it keeps its
// given average and renders the same way. Year totals and both
// charts all work at the ANNUAL figure (monthly rows show it
// with an "avg $X/mo" annotation, so nobody does the ×12 in
// their head). Under each monthly row the table renders the
// twelve months themselves — always on, no expander — at the
// chart's figures: recorded months at their amounts, the rest
// filled with the average and weakened.
//
// The two charts are display only: a per-year share pie (of
// the selected year) and a bar+line combo (category-stacked
// bars, the total as a line) with a By year / By month
// granularity toggle — By month covers the selected year only.
// By month, a monthly-basis category lands its recorded months
// at their actual amounts and fills the months it does not
// carry with its average; an annual-basis category spreads at
// annual ÷ 12. The pivot ships the twelve figures per cell
// (costMonthSeries, src/costs.js), so the chart just reads
// them. A category keeps ONE color across both charts (this
// panel's own fixed palette — dynamic categories cannot join
// the fixed chart_colors series system).
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
let costsEditingKey = null; // null | 'id:<entry id>' | 'new:<year>' — the row in edit mode
let costsExtraYears = [];   // years opened via "+ Add year" that hold no entries yet
let costsYear = null;       // the panel's selected year: table + pie + By month
let costsEditSnap = null;   // the edit row's last snapshot, kept across renders
let costsEditMode = false;  // the table's Edit switch: view mode is read-only
let costsPie = null;
let costsCombo = null;
let costsPieCenter = null; // {year, total} the doughnut's center text
let costsGranularity = 'year';

async function loadCostsImpl(id) {
  const view = await api(`/api/properties/${id}/costs`);
  costsData = view;
  if (costsLoadedFor !== id) {
    costsLoadedFor = id;
    costsEditingKey = null;
    costsExtraYears = [];
    costsYear = null;
    costsEditSnap = null;
    costsEditMode = false;
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
  renderCostsYearSel();
  renderCostsTopbar();
  renderCostsCharts();
  renderCostsYears();
  renderCostsProposed();
}

// The table's Edit switch, rendered: "+ Add year" exists only
// in edit mode, and the switch itself reads Edit / Done. The
// year selector and the AI fill are not part of edit mode and
// stay put in both states.
function renderCostsTopbar() {
  $('#addCostYearBtn').classList.toggle('hidden', !costsEditMode);
  $('#costsEditToggleBtn').textContent = costsEditMode ? 'Done' : 'Edit';
}

$('#costsEditToggleBtn').addEventListener('click', () => {
  costsEditMode = !costsEditMode;
  // Leaving edit mode does not kill a row edit in progress:
  // per the panel's render semantics its session (and its
  // snapshot) survives, so its row stays up — in its own year —
  // until it is saved or cancelled.
  renderCosts();
});

// The panel's year selector: its options are the years with
// data ∪ the opened-but-empty years ∪ the current selection
// (so a year whose entries were all just deleted stays
// selectable and shows its empty table, per the panel's empty-
// year rule). The selection is validated here: a selection
// that falls out of the union — none, after a property switch
// — falls back to the latest year on record.
function renderCostsYearSel() {
  const sel = $('#costsYearSel');
  const years = [...new Set([
    ...(costsData ? costsData.years.map((y) => y.year) : []),
    ...costsExtraYears,
    ...(costsYear ? [costsYear] : []),
  ])].sort((a, b) => b - a);
  if (!years.includes(costsYear)) {
    costsYear = costsData && costsData.years.length
      ? costsData.years[0].year
      : (years.length ? years[0] : null);
  }
  sel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  sel.value = costsYear ? String(costsYear) : '';
  sel.disabled = !years.length;
}

// Picking a year re-points the table, the pie and the combo's
// By month view at it — all from the loaded view, no refetch.
// An edit open on another year's row is not touched: its
// session (and its snapshot) stays keyed to its own year and
// comes back when the user returns to that year.
$('#costsYearSel').addEventListener('change', (e) => {
  costsYear = Number(e.target.value);
  renderCostsCharts();
  renderCostsYears();
});

// -------------------------------------------------- costs entries table
function costAmountCell(e) {
  if (e.basis === 'monthly') {
    const n = e.monthlyAmounts ? Object.keys(e.monthlyAmounts).length : 0;
    const note = n
      ? `avg ${money2(e.amount)}/mo (${n} month${n === 1 ? '' : 's'})`
      : `avg ${money2(e.amount)}/mo`;
    return `${money2(Number(e.amount) * 12)}<div class="cost-mo-note">${note}</div>`;
  }
  return money2(e.amount);
}

// The always-on month detail rendered under a monthly row:
// the twelve months at the same figures the By month chart
// uses — months on record at their actual amounts, months the
// row does not carry filled with its average and weakened
// (class is-fill), so a fill never reads as a recorded bill.
// The twelve sum back to the row's annual figure. A row with
// no detail on record (monthlyAmounts null — the pre-detail
// form) is twelve fills at its stored average.
function costMonthsViewRowHtml(e) {
  const det = e.monthlyAmounts || {};
  const cells = MONTH_NAMES.map((name, i) => {
    const recorded = det[String(i + 1)];
    const actual = recorded !== undefined && recorded !== null;
    const v = actual ? Number(recorded) : Number(e.amount);
    return `<span class="cost-mv-cell${actual ? '' : ' is-fill'}" data-mv-month="${i + 1}"><span class="cost-mv-name">${name}</span><span class="cost-mv-val">${money2(v)}</span></span>`;
  }).join('');
  return `<tr class="cost-months-row" data-cost-months-for="${e.id}"><td colspan="4"><div class="cost-months-view">${cells}</div></td></tr>`;
}

// The 12-month detail grid a monthly row opens into: one small
// input per month, filled only for the months on record. Values
// are read back through the dataAttr the caller names
// (data-month in the tables, data-p-month in the AI proposals).
function costMonthsGridHtml(months, dataAttr = 'data-month') {
  const cells = MONTH_NAMES.map((name, i) => {
    const v = months && months[String(i + 1)] !== undefined && months[String(i + 1)] !== null
      ? months[String(i + 1)] : '';
    return `<label>${name}<input type="text" inputmode="decimal" data-money ${dataAttr}="${i + 1}" value="${v === '' ? '' : esc(formatMoneyInput(v))}"></label>`;
  }).join('');
  return `<div class="cost-months">${cells}</div>`;
}

// The values typed into the row currently in edit mode, read
// straight from the DOM. renderCostsYears snapshots BEFORE it
// rebuilds and feeds the values back into the rebuilt row, so a
// data refresh (a save landing, an AI Apply) can never wipe an
// edit the user opened — or typed into — while it was in flight.
// The snapshot is also kept in state (costsEditSnap): switching
// the year selector rebuilds the table without the editing row
// — it belongs to its own year — and the kept snapshot restores
// its typed values when the user switches back. The snapshot is
// keyed by the row's own key, so it can only ever land back on
// that row, never in another year.
function snapshotCostEditRow() {
  if (!costsEditingKey) return null;
  const row = document.querySelector('#costsYears tr.cost-editing');
  if (!row || row.dataset.costEditrow !== costsEditingKey) return null;
  const months = {};
  row.querySelectorAll('[data-month]').forEach((inp) => {
    if (inp.value.trim() !== '') months[inp.dataset.month] = inp.value;
  });
  const q = (sel) => row.querySelector(sel);
  return {
    key: costsEditingKey,
    category: q('[name=category]') ? q('[name=category]').value : '',
    categoryCustom: q('[name=category_custom]') ? q('[name=category_custom]').value : '',
    basis: q('[name=basis]') ? q('[name=basis]').value : 'annual',
    amount: q('[name=amount]') ? q('[name=amount]').value : '',
    months,
  };
}

// The months typed into a row's detail grid: non-empty cells
// only. A filled cell that does not parse is an error the
// caller shows — silently dropping it would misstate the avg.
function collectCostMonths(row, dataAttr = 'data-month') {
  const map = {};
  for (const inp of row.querySelectorAll(`[${dataAttr}]`)) {
    if (inp.value.trim() === '') continue;
    const v = parseMoneyInput(inp.value);
    const m = Number(inp.dataset.month || inp.dataset.pMonth);
    if (v === '' || v < 0) return { error: `${MONTH_NAMES[m - 1]}'s amount is not a valid number.` };
    map[String(m)] = v;
  }
  return { map };
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

function costEditRowHtml(entry, year, snap) {
  const key = entry ? `id:${entry.id}` : `new:${year}`;
  const fromSnap = snap && snap.key === key ? snap : null;
  const category = fromSnap
    ? (fromSnap.category === COST_TYPE_CUSTOM ? fromSnap.categoryCustom : fromSnap.category)
    : (entry ? entry.category : COST_TYPE_PRESETS[0]);
  const basis = fromSnap ? fromSnap.basis : (entry ? entry.basis : 'annual');
  // The single amount field speaks ANNUAL figures: for a monthly
  // entry it starts at the annualized total, so flipping the
  // basis keeps the year's figure instead of inventing one.
  const amountVal = fromSnap ? fromSnap.amount
    : entry ? (entry.basis === 'monthly' ? Number(entry.amount) * 12 : entry.amount) : '';
  const months = fromSnap ? fromSnap.months : (entry && entry.monthlyAmounts) || {};
  // A monthly entry's stored average rides along as the save
  // fallback: clearing the grid keeps the average and drops the
  // detail, instead of making the row unsavable.
  const avgAttr = entry && entry.basis === 'monthly'
    ? ` data-cost-avg="${Number(entry.amount)}"` : '';
  return `<tr class="cost-editing" data-cost-editrow="${key}" data-cost-year="${year}"${avgAttr}>
    <td>${costTypeSelectHtml(category)}</td>
    <td><select name="basis">
      <option value="annual"${basis === 'annual' ? ' selected' : ''}>Annual</option>
      <option value="monthly"${basis === 'monthly' ? ' selected' : ''}>Monthly</option>
    </select></td>
    <td class="num"><input type="text" inputmode="decimal" data-money name="amount" value="${amountVal === '' || amountVal === null || amountVal === undefined ? '' : esc(formatMoneyInput(amountVal))}">
      <div class="cost-months-wrap${basis === 'monthly' ? '' : ' hidden'}">${costMonthsGridHtml(months)}</div>
      <div class="cost-amount-note"></div></td>
    <td style="white-space:nowrap">
      <button type="button" class="small primary" data-cost-save>Save</button>
      <button type="button" class="small" data-cost-cancel>Cancel</button>
    </td></tr>`;
}

function renderCostsYears() {
  const host = $('#costsYears');
  if (!costsData) { host.innerHTML = ''; return; }
  const live = snapshotCostEditRow();
  if (live) costsEditSnap = live;
  if (!costsEditingKey || (costsEditSnap && costsEditSnap.key !== costsEditingKey)) costsEditSnap = null;
  const snap = costsEditSnap;
  if (costsYear === null || costsYear === undefined) {
    host.innerHTML = '<p class="note" style="margin:0">No costs recorded yet.</p>';
    return;
  }
  // Only the selected year's table renders. An empty year (just
  // added, or deleted clean) renders its empty table with a 0
  // total.
  const entries = costsData.entries
    .filter((e) => e.year === costsYear)
    .sort((a, b) => a.category.localeCompare(b.category));
  const yv = costsData.years.find((y) => y.year === costsYear);
  host.innerHTML = costYearBlockHtml(costsYear, entries, yv ? yv.total : 0, snap);
  wireCostEditRow();
}

function costYearBlockHtml(year, entries, total, snap) {
  const rows = [];
  for (const e of entries) {
    if (costsEditingKey === `id:${e.id}`) {
      rows.push(costEditRowHtml(e, year, snap));
    } else {
      rows.push(`<tr data-cost-row="${e.id}">
        <td>${esc(e.category)}${e.source === 'ai' ? ' <span class="badge">AI</span>' : ''}</td>
        <td>${e.basis === 'monthly' ? 'Monthly' : 'Annual'}</td>
        <td class="num">${costAmountCell(e)}</td>
        <td style="white-space:nowrap">${costsEditMode ? `
          <button type="button" class="small" data-cost-edit="${e.id}">Edit</button>
          <button type="button" class="small danger" data-cost-del="${e.id}">Delete</button>` : ''}
        </td></tr>`);
      if (e.basis === 'monthly') rows.push(costMonthsViewRowHtml(e));
    }
  }
  if (costsEditingKey === `new:${year}`) rows.push(costEditRowHtml(null, year, snap));
  if (!entries.length && costsEditingKey !== `new:${year}`) {
    rows.push('<tr><td colspan="4" class="note" style="margin:0">No costs recorded yet.</td></tr>');
  }
  // A year holding no entries yet is still finding its number:
  // in edit mode its title is an input until the first entry
  // lands; in view mode the year is plain text like any other.
  const head = entries.length || !costsEditMode
    ? `<span>${year}</span>`
    : `<input type="number" data-cost-year-input step="1" min="1900" max="2100" value="${year}">`;
  return `<div class="cost-year-block" data-cost-year-block="${year}">
    <div class="cost-year-head">${head}</div>
    <table class="costs-table">
      <thead><tr><th>Type</th><th>Basis</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody>
      <tfoot><tr class="cost-year-total"><td colspan="2">${year} total</td><td class="num">${money2(total || 0)}</td><td></td></tr></tfoot>
    </table>${costsEditMode ? `
    <div class="toolbar cost-year-toolbar" style="margin:0">
      <button type="button" class="small" data-cost-add-row="${year}">+ Add row</button>
    </div>` : ''}
  </div>`;
}

function wireCostEditRow() {
  const row = document.querySelector('#costsYears tr.cost-editing');
  if (!row) return;
  row.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  const sel = row.querySelector('[name=category]');
  const custom = row.querySelector('[name=category_custom]');
  sel.addEventListener('change', () => {
    custom.classList.toggle('hidden', sel.value !== COST_TYPE_CUSTOM);
    if (sel.value === COST_TYPE_CUSTOM) custom.focus();
  });
  const basisSel = row.querySelector('[name=basis]');
  const amountInput = row.querySelector('[name=amount]');
  const monthsWrap = row.querySelector('.cost-months-wrap');
  const note = row.querySelector('.cost-amount-note');
  const syncNote = () => {
    const monthly = basisSel.value === 'monthly';
    amountInput.classList.toggle('hidden', monthly);
    monthsWrap.classList.toggle('hidden', !monthly);
    if (!monthly) { note.textContent = ''; return; }
    const months = collectCostMonths(row);
    if (months.error) { note.textContent = months.error; return; }
    const vals = Object.values(months.map);
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      note.textContent = `avg ${money2(avg)}/mo · = ${money2(avg * 12)}/yr · ${vals.length} month${vals.length === 1 ? '' : 's'}`;
    } else if (row.dataset.costAvg) {
      note.textContent = `avg ${money2(Number(row.dataset.costAvg))}/mo (no monthly detail)`;
    } else {
      note.textContent = '';
    }
  };
  amountInput.addEventListener('input', syncNote);
  row.querySelectorAll('[data-month]').forEach((inp) => inp.addEventListener('input', syncNote));
  basisSel.addEventListener('change', syncNote);
  syncNote();
}

$('#costsYears').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-cost-edit]');
  const delBtn = e.target.closest('[data-cost-del]');
  const saveBtn = e.target.closest('[data-cost-save]');
  const cancelBtn = e.target.closest('[data-cost-cancel]');
  const addRowBtn = e.target.closest('[data-cost-add-row]');
  if (editBtn) {
    costsEditingKey = `id:${Number(editBtn.dataset.costEdit)}`;
    renderCostsYears();
    return;
  }
  if (cancelBtn) {
    const row = e.target.closest('tr.cost-editing');
    const key = row ? row.dataset.costEditrow : costsEditingKey;
    costsEditingKey = null;
    // Cancelling the only row of a just-added year abandons the
    // year too — it held nothing else. The selection lets go of
    // it, and the selector falls back to a year that remains.
    if (key && key.startsWith('new:')) {
      const y = Number(key.slice(4));
      if (costsData && !costsData.entries.some((en) => en.year === y)) {
        costsExtraYears = costsExtraYears.filter((yy) => yy !== y);
        if (costsYear === y) costsYear = null;
      }
    }
    renderCosts();
    return;
  }
  if (addRowBtn) {
    const y = Number(addRowBtn.dataset.costAddRow);
    if (costsEditingKey !== `new:${y}`) {
      costsEditingKey = `new:${y}`;
      renderCostsYears();
    }
    const row = document.querySelector('#costsYears tr.cost-editing');
    if (row) row.querySelector('[name=category]').focus();
    return;
  }
  if (delBtn) {
    const id = Number(delBtn.dataset.costDel);
    if (!confirm('Delete this cost entry?')) return;
    try {
      await api(`/api/properties/${currentPropertyId}/costs/${id}`, { method: 'DELETE' });
      if (costsEditingKey === `id:${id}`) costsEditingKey = null;
      await loadCosts(currentPropertyId);
    } catch (err) { showMsg($('#costsMsg'), 'err', err.message); }
    return;
  }
  if (saveBtn) {
    const row = e.target.closest('tr.cost-editing');
    if (!row) return;
    const key = row.dataset.costEditrow;
    const block = row.closest('[data-cost-year-block]');
    const yearInput = block.querySelector('[data-cost-year-input]');
    const year = yearInput ? Number(yearInput.value) : Number(block.dataset.costYearBlock);
    const sel = row.querySelector('[name=category]');
    const category = sel.value === COST_TYPE_CUSTOM
      ? row.querySelector('[name=category_custom]').value.trim()
      : sel.value;
    const basis = row.querySelector('[name=basis]').value;
    const body = { year, category, basis };
    if (!Number.isInteger(year) || year < 1900 || year > 2100 || !category) {
      showMsg($('#costsMsg'), 'err', 'Year and type are required.');
      return;
    }
    if (basis === 'monthly') {
      const months = collectCostMonths(row);
      if (months.error) { showMsg($('#costsMsg'), 'err', months.error); return; }
      if (Object.keys(months.map).length) body.monthlyAmounts = months.map;
      else if (row.dataset.costAvg) body.amount = Number(row.dataset.costAvg);
      else {
        showMsg($('#costsMsg'), 'err', 'Fill in at least one month for a monthly entry.');
        return;
      }
    } else {
      body.amount = parseMoneyInput(row.querySelector('[name=amount]').value);
      if (body.amount === '') {
        showMsg($('#costsMsg'), 'err', 'An amount is required.');
        return;
      }
    }
    try {
      if (key.startsWith('new:')) {
        await api(`/api/properties/${currentPropertyId}/costs`, { method: 'POST', body });
      } else {
        await api(`/api/properties/${currentPropertyId}/costs/${key.slice(3)}`, { method: 'PUT', body });
      }
      // The save ends MY edit session only. If the user has since
      // opened another row's edit, that session is theirs now:
      // leave the key alone and the reload's render (snapshot in
      // renderCostsYears) keeps their row — and its typed
      // values — alive. Clearing unconditionally here used to
      // wipe exactly that edit whenever the reload landed late.
      if (costsEditingKey === key) costsEditingKey = null;
      if (key.startsWith('new:')) {
        costsExtraYears = costsExtraYears.filter((y) => y !== Number(key.slice(4)));
      }
      $('#costsMsg').textContent = '';
      $('#costsMsg').className = 'msg';
      await loadCosts(currentPropertyId);
    } catch (err) { showMsg($('#costsMsg'), 'err', err.message); }
  }
});

// Renaming a not-yet-filled year: the selection follows the
// input — merging into an existing year when the number lands
// on one.
$('#costsYears').addEventListener('change', (e) => {
  const inp = e.target.closest('[data-cost-year-input]');
  if (!inp) return;
  const block = inp.closest('[data-cost-year-block]');
  const oldYear = Number(block.dataset.costYearBlock);
  const newYear = Number(inp.value);
  if (!Number.isInteger(newYear) || newYear < 1900 || newYear > 2100 || newYear === oldYear) {
    renderCostsYears();
    return;
  }
  costsExtraYears = costsExtraYears.filter((y) => y !== oldYear);
  const hasData = costsData && costsData.entries.some((en) => en.year === newYear);
  if (!hasData && !costsExtraYears.includes(newYear)) costsExtraYears.push(newYear);
  if (costsEditingKey === `new:${oldYear}`) costsEditingKey = `new:${newYear}`;
  if (costsYear === oldYear) costsYear = newYear;
  renderCostsYearSel();
  renderCostsCharts();
  renderCostsYears();
});

$('#addCostYearBtn').addEventListener('click', () => {
  const used = new Set([
    ...(costsData ? costsData.entries.map((e) => e.year) : []),
    ...costsExtraYears,
    ...(costsYear ? [costsYear] : []),
  ]);
  let y = new Date().getFullYear();
  while (used.has(y)) y += 1;
  costsExtraYears.push(y);
  costsYear = y;
  costsEditingKey = `new:${y}`;
  renderCosts();
  const inp = document.querySelector(`[data-cost-year-block="${y}"] [data-cost-year-input]`);
  if (inp) { inp.focus(); inp.select(); }
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
  // The pie shows the panel selector's year. A selected year
  // with nothing recorded has no slices: the pie steps aside
  // (the combo still covers the panel) until the year fills.
  const pieBox = document.querySelector('.costs-pie-box');
  const yv = costsData.years.find((y) => y.year === costsYear);
  if (!yv) {
    pieBox.classList.add('hidden');
    if (costsPie) { costsPie.destroy(); costsPie = null; }
    costsPieCenter = null;
    window.__fmCharts = window.__fmCharts || {};
    window.__fmCharts.costsPie = null;
    return;
  }
  pieBox.classList.remove('hidden');
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
    // By month covers the SELECTED year only (By year above is
    // the all-years view). The pivot ships each cell's twelve
    // month figures (costMonthSeries): a monthly-basis category
    // lands its recorded months at their actual amounts and
    // fills the months it does not carry with the average; an
    // annual-basis one spreads at annual ÷ 12. The twelve
    // months of a recorded year sum back to its total. A
    // selected year with nothing recorded reads as twelve zero
    // months.
    labels = [];
    perCat = cats.map(() => []);
    totals = [];
    const selYv = yearsAsc.find((y) => y.year === costsYear);
    const monthYears = selYv ? [selYv]
      : (costsYear ? [{ year: costsYear, cells: {}, total: 0 }] : []);
    for (const yv of monthYears) {
      for (let m = 1; m <= 12; m++) {
        labels.push(`${yv.year}-${String(m).padStart(2, '0')}`);
        let tot = 0;
        cats.forEach((c, ci) => {
          const cell = cellOf(yv.year, c);
          const v = cell ? cell.months[m - 1] : 0;
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
// session only — switching properties resets it, and so does
// the panel's Clear session button (which is all resetCostsChat
// does: recorded data is never touched, the model choice and
// the panel's open state stay as they are).
let costsChatState = { turns: [], proposed: [] };
let costsChatPropertyId = null;
// The pending-attachment queue: files picked through Choose
// Files and files pasted into the textarea land in the SAME
// queue, shown as chips above the textarea. Send carries the
// whole queue off; a successful round empties it, a failed one
// leaves it in place for a retry. The server's attachment
// rules (type, 10 MB) still apply — a rejection lands on the
// panel's error line, like any other round's outcome.
let costsChatQueue = [];

// The panel's error line reports the LAST action's outcome —
// it is cleared whenever a newer action supersedes it: a send
// starting, a round succeeding, the file selection changing,
// or the session being cleared (resetCostsChat below).
function clearCostsChatMsg() {
  const msg = document.querySelector('[data-costs-chat-msg]');
  if (msg) { msg.textContent = ''; msg.className = 'msg'; }
}

function renderCostsChatQueue() {
  const host = document.querySelector('[data-costs-chat-queue]');
  if (!host) return;
  host.classList.toggle('hidden', !costsChatQueue.length);
  host.innerHTML = costsChatQueue.map((f, i) =>
    `<span class="file-chip"><span class="chip-name">${esc(f.name || 'attachment')}</span><button type="button" data-costs-chat-queue-remove="${i}" title="Remove">×</button></span>`).join('');
  syncCostsChatClearBtn();
}

function resetCostsChat(propertyId) {
  costsChatState = { turns: [], proposed: [] };
  costsChatPropertyId = propertyId;
  costsChatQueue = [];
  renderCostsChatQueue();
  const log = document.querySelector('[data-costs-chat-log]');
  if (log) { log.innerHTML = ''; log.classList.add('hidden'); }
  const ta = document.querySelector('[data-costs-chat-text]');
  if (ta) ta.value = '';
  const files = document.querySelector('[data-costs-chat-files]');
  if (files) files.value = '';
  clearCostsChatMsg();
  const sum = document.querySelector('[data-costs-ai-summary]');
  if (sum) { sum.textContent = ''; sum.classList.add('hidden'); }
  renderCostsProposed();
  syncCostsChatClearBtn();
}

// Clear session is offered only while there is something to
// clear — turns on the log, proposals not yet applied, or
// files still queued.
function syncCostsChatClearBtn() {
  const btn = document.querySelector('[data-costs-chat-clear]');
  if (!btn) return;
  btn.classList.toggle('hidden',
    !(costsChatState.turns.length || costsChatState.proposed.length || costsChatQueue.length));
}

function costsChatLogHtml() {
  return costsChatState.turns.map((t) => `<div class="costs-chat-turn ${t.role}">
    <span class="who">${t.role === 'user' ? 'You' : 'AI'}</span>${esc(t.content)}</div>`).join('');
}

function renderCostsChatLog(pendingText) {
  const log = document.querySelector('[data-costs-chat-log]');
  if (!log) return;
  syncCostsChatClearBtn();
  const has = costsChatState.turns.length > 0 || pendingText;
  log.classList.toggle('hidden', !has);
  log.innerHTML = costsChatLogHtml()
    + (pendingText ? `<div class="costs-chat-turn user pending"><span class="who">You</span>${esc(pendingText)}</div>` : '');
  log.scrollTop = log.scrollHeight;
}

function costKeyOf(year, category) { return `${year}|${category}`; }

// A one-line figure summary for a stored entry or a proposal —
// the conflict preview speaks in these, old → new: an annual
// figure reads "$5,400.00 (annual)"; a monthly one carries its
// average, its month count when it has detail, and its year.
function costEntrySummary(e) {
  if (!e) return '';
  if (e.basis === 'monthly') {
    const n = e.monthlyAmounts ? Object.keys(e.monthlyAmounts).length : 0;
    return `avg ${money2(e.amount)}/mo${n ? ` · ${n} month${n === 1 ? '' : 's'}` : ''} (${money2(Number(e.amount) * 12)}/yr)`;
  }
  return `${money2(e.amount)} (annual)`;
}

// The live annotation under a monthly proposal row: the average
// of the months it carries (or its given average), its year
// figure and the month count.
function costMonthlySummaryText(p) {
  const vals = p.monthlyAmounts ? Object.values(p.monthlyAmounts).map(Number) : [];
  const avg = vals.length
    ? vals.reduce((a, b) => a + b, 0) / vals.length
    : (p.amount === '' || p.amount === null || p.amount === undefined ? null : Number(p.amount));
  if (avg === null || !Number.isFinite(avg)) return '';
  return `avg ${money2(avg)}/mo · = ${money2(avg * 12)}/yr${vals.length ? ` · ${vals.length} month${vals.length === 1 ? '' : 's'}` : ''}`;
}

function renderCostsProposed() {
  const host = document.querySelector('[data-costs-proposed]');
  if (!host) return;
  syncCostsChatClearBtn();
  const proposed = costsChatState.proposed;
  if (!proposed.length) { host.innerHTML = ''; return; }
  const existing = new Map((costsData ? costsData.entries : []).map((e) => [costKeyOf(e.year, e.category), e]));
  const rows = proposed.map((p, i) => {
    const old = existing.get(costKeyOf(p.year, p.category));
    const conflict = !!old;
    const hasMonths = p.basis === 'monthly' && p.monthlyAmounts && Object.keys(p.monthlyAmounts).length > 0;
    return `<div class="costs-proposed-row${conflict ? ' conflict' : ''}" data-proposed-row="${i}">
      <input type="checkbox" data-p-check${conflict ? '' : ' checked'}>
      <input type="number" data-p-year step="1" min="1900" max="2100" value="${p.year}">
      <input type="text" class="p-cat" data-p-category list="costCategoryOptions" value="${esc(p.category)}">
      <select data-p-basis>
        <option value="annual"${p.basis === 'annual' ? ' selected' : ''}>Annual</option>
        <option value="monthly"${p.basis === 'monthly' ? ' selected' : ''}>Monthly</option>
      </select>
      ${hasMonths
        ? `<span class="p-months">${costMonthsGridHtml(p.monthlyAmounts, 'data-p-month')}</span>`
        : `<input type="text" inputmode="decimal" data-money data-p-amount value="${esc(formatMoneyInput(p.amount))}">`}
      <span class="p-annual">${p.basis === 'monthly' ? esc(costMonthlySummaryText(p)) : ''}</span>
      <input type="text" class="p-notes" data-p-notes placeholder="Notes" value="${esc(p.notes || '')}">
      ${conflict ? `<span class="conflict-tag">Already recorded — overwrites if checked</span> <span class="conflict-diff">${esc(costEntrySummary(old))} → ${esc(costEntrySummary(p))}</span>` : ''}
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
      row.querySelector('.p-annual').textContent = basis === 'monthly' && amt !== '' ? `avg ${money2(amt)}/mo · = ${money2(amt * 12)} / yr` : '';
    };
    inp.addEventListener('input', sync);
  });
  host.querySelectorAll('[data-p-month]').forEach(wireMoneyInput);
}

// Read the proposed rows back out of their (editable) inputs.
// A monthly row with a month grid reads its months (the amount
// is their average — display only; the server recomputes it on
// Apply); a monthly row without one reads its given average.
function readCostsProposed() {
  const host = document.querySelector('[data-costs-proposed]');
  if (!host) return [];
  return [...host.querySelectorAll('[data-proposed-row]')].map((row) => {
    const basis = row.querySelector('[data-p-basis]').value;
    const monthInputs = row.querySelectorAll('[data-p-month]');
    let monthlyAmounts = null;
    let amount = '';
    if (monthInputs.length) {
      const months = collectCostMonths(row, 'data-p-month');
      if (!months.error && Object.keys(months.map).length) {
        monthlyAmounts = months.map;
        const vals = Object.values(months.map);
        amount = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
      }
    } else {
      amount = parseMoneyInput(row.querySelector('[data-p-amount]').value);
    }
    return {
      checked: row.querySelector('[data-p-check]').checked,
      year: Number(row.querySelector('[data-p-year]').value),
      category: row.querySelector('[data-p-category]').value.trim(),
      basis,
      amount,
      monthlyAmounts: basis === 'monthly' ? monthlyAmounts : null,
      notes: row.querySelector('[data-p-notes]').value.trim() || null,
    };
  });
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
    clearCostsChatMsg(); // a successful Apply supersedes an older error
    await loadCosts(currentPropertyId);
  } catch (err) {
    showMsg(msg, 'err', err.message);
  } finally {
    applyBtn.disabled = false;
  }
});

// Flipping a proposal's basis converts its figure so the row
// keeps meaning what it meant: an annual total becomes a
// monthly average (÷ 12) and a monthly figure its year total
// (× 12); month detail drops — the row falls back to the
// given-average form. State round-trips through the DOM so the
// user's other edits survive the re-render.
document.querySelector('[data-costs-proposed]').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-p-basis]');
  if (!sel) return;
  const idx = Number(sel.closest('[data-proposed-row]').dataset.proposedRow);
  const rows = readCostsProposed();
  costsChatState.proposed = rows.map((r, i) => {
    const { checked, ...rest } = r;
    if (i !== idx) return rest;
    // readCostsProposed reports the figure in the OLD basis's
    // terms (an average for a months row, a total for annual):
    // convert just this row into its new basis, detail dropped.
    if (rest.amount !== '') {
      rest.amount = rest.basis === 'annual'
        ? Math.round(rest.amount * 12 * 100) / 100
        : Math.round((rest.amount / 12) * 100) / 100;
    }
    rest.monthlyAmounts = null;
    return rest;
  });
  renderCostsProposed();
});

// Typing in a proposal's month grid refreshes its avg / year
// annotation live, like the table's edit rows.
document.querySelector('[data-costs-proposed]').addEventListener('input', (e) => {
  if (!e.target.closest('[data-p-month]')) return;
  const row = e.target.closest('[data-proposed-row]');
  const months = collectCostMonths(row, 'data-p-month');
  const span = row.querySelector('.p-annual');
  if (months.error) { span.textContent = months.error; return; }
  const vals = Object.values(months.map);
  span.textContent = vals.length
    ? costMonthlySummaryText({ basis: 'monthly', monthlyAmounts: months.map, amount: '' })
    : '';
});

{
  const wrap = $('#costsAiFill');
  const panel = wrap.querySelector('[data-costs-ai-panel]');
  const toggle = document.querySelector('[data-costs-ai-toggle]');
  const sendBtn = wrap.querySelector('[data-costs-chat-send]');
  const clearBtn = wrap.querySelector('[data-costs-chat-clear]');
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
  // Clear session: wipe the conversation and any unapplied
  // proposals back to the empty state. Recorded entries are
  // untouched (only Apply ever wrote), and neither the model
  // choice nor the panel's open state resets — a fresh
  // conversation can start immediately.
  clearBtn.addEventListener('click', () => resetCostsChat(costsChatPropertyId));
  const fileInput = wrap.querySelector('[data-costs-chat-files]');
  const chatTa = wrap.querySelector('[data-costs-chat-text]');
  const queueHost = wrap.querySelector('[data-costs-chat-queue]');
  const queueFiles = (list) => {
    const add = [...(list || [])];
    if (!add.length) return;
    costsChatQueue.push(...add);
    renderCostsChatQueue();
    clearCostsChatMsg(); // a changed file selection supersedes the last error
  };
  // Choose Files feeds the queue; the input itself resets so
  // the same file can be picked again later.
  fileInput.addEventListener('change', () => {
    queueFiles(fileInput.files);
    fileInput.value = '';
  });
  queueHost.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-costs-chat-queue-remove]');
    if (!btn) return;
    costsChatQueue.splice(Number(btn.dataset.costsChatQueueRemove), 1);
    renderCostsChatQueue();
  });
  // Paste: a clipboard carrying files (a screenshot, copied
  // files) joins the queue instead of pasting; a clipboard
  // without files is left alone and pastes as text.
  chatTa.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length) return;
    e.preventDefault();
    queueFiles(files);
  });
  sendBtn.addEventListener('click', async () => {
    clearCostsChatMsg(); // a new send supersedes the last error
    const ta = chatTa;
    const text = ta.value.trim();
    const files = costsChatQueue.slice();
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
      costsChatQueue = [];
      renderCostsChatQueue();
      clearCostsChatMsg(); // a successful round supersedes the last error
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

// ------------------------------------------------------------ investments --
// Three levels, mirroring Properties: a portfolio overview in
// the Assets > Investments section, an account detail page and a
// holding detail page. All figures come from the server's return
// engine (src/investments.js) in the page's DISPLAY currency:
// the overview opens in CAD, an account page in the account's
// effective default (its stored setting, else derived from its
// holdings), a holding page in the holding's own currency. Each
// page carries its own Display toggle (a per-visit view switch:
// it never changes another page, and never rewrites an account's
// default). Every converted figure is labeled with its currency
// — strip labels, chart legends, monthly headers, the holdings
// table's converted column — and the native-currency badge
// beside a holding's name stays. The other-assets registry is
// untouched by this module — investments never go through it.
let currentInvestAccountId = null;
let currentInvestHoldingId = null;
let investPortfolioChart = null;
let investAccountChart = null;
let investHoldingChart = null;
let investAccountData = null; // last account-detail payload (the AI chat's context)
let investHoldingData = null; // last holding-detail payload
window.__fmCharts = window.__fmCharts || {};
window.__fmCharts.investments = null;
window.__fmCharts.investAccount = null;
window.__fmCharts.investHolding = null;

const moneyC = (n, cur = 'CAD', digits = 2) =>
  n === null || n === undefined || n === ''
    ? '—'
    : Number(n).toLocaleString('en-CA', { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtUnits = (n) => (n === null || n === undefined ? '—'
  : Number(n).toLocaleString('en-CA', { maximumFractionDigits: 4 }));
const pctText = (p) => (p === null || p === undefined ? '—' : `${Number(p) > 0 ? '+' : ''}${Number(p).toFixed(2)}%`);
const returnText = (amt, pct, cur = 'CAD') =>
  `${amt != null && Number(amt) > 0 ? '+' : ''}${moneyC(amt, cur)} (${pctText(pct)})`;
const ACCOUNT_TYPE_LABELS = { TFSA: 'TFSA', RRSP: 'RRSP', RSU: 'RSU', NonRegistered: 'Non-registered', Other: 'Other' };
const currencyBadge = (cur) => `<span class="badge ${cur === 'USD' ? 'usd' : ''}">${esc(cur)}</span>`;
const aiBadge = (source) => (source === 'ai' ? ' <span class="badge ai">AI</span>' : '');

// Per-visit display currency, one per page: the toggle below
// rewrites only its own page's entry, and every loader resets
// its page to that page's default on entry (overview: CAD,
// account: the account's effective default, holding: the
// holding's own currency). Nothing here is persisted — the
// only stored currency choice is the account's default.
const investDisplay = { investments: 'CAD', investAccount: 'CAD', investHolding: 'CAD' };
const investDisplayLabel = (cur) => `Display: ${cur}`;
// The static account/holding toolbar buttons are bound once,
// so their handlers must read the current page id from here,
// not from the loader call that bound them.
let investDisplayAccountId = null;
let investDisplayHoldingId = null;

function investSummaryStrip(s, cur = 'CAD') {
  return `
    <div class="summary-card"><div class="k">Current value (${cur})</div><div class="v">${moneyC(s.value, cur)}</div></div>
    <div class="summary-card"><div class="k">Net contributions (${cur})</div><div class="v">${moneyC(s.contributions, cur)}</div></div>
    <div class="summary-card"><div class="k">Dividends received (${cur})</div><div class="v">${moneyC(s.dividends, cur)}</div></div>
    <div class="summary-card"><div class="k">Total return (${cur})</div><div class="v">${s.costUnknown ? '—' : returnText(s.totalReturn, s.totalReturnPct, cur)}</div>${s.costUnknown ? '<div class="n">cost unknown — gain not shown</div>' : ''}</div>`;
}

// The monthly return table shared by all three levels. The
// money columns always read the server's plain fields, which
// carry the page's display currency; the % column is the one
// thing that never converts — aggregates keep their CAD-basis
// % (the server pins it), a holding page keeps its native %
// (nativePct), so toggling never moves a percentage.
function investMonthlyTable(monthly, cur = 'CAD', gainUnknown = false, nativePct = false) {
  if (!monthly || !monthly.length) return '<div class="note">No activity yet.</div>';
  const g = (r, k) => r[k];
  const tot = { contributions: 0, dividends: 0, gain: 0, returnAmount: 0 };
  const rows = monthly.map((r) => {
    tot.contributions += g(r, 'contributions') || 0;
    tot.dividends += g(r, 'dividends') || 0;
    tot.gain += g(r, 'gain') || 0;
    tot.returnAmount += g(r, 'returnAmount') || 0;
    return `<tr><td>${esc(r.month)}</td>
      <td class="num">${moneyC(g(r, 'startValue'), cur)}</td>
      <td class="num">${moneyC(g(r, 'contributions'), cur)}</td>
      <td class="num">${moneyC(g(r, 'dividends'), cur)}</td>
      <td class="num">${gainUnknown ? '—' : moneyC(g(r, 'gain'), cur)}</td>
      <td class="num">${gainUnknown ? '—' : moneyC(g(r, 'returnAmount'), cur)}</td>
      <td class="num">${gainUnknown ? '—' : pctText(nativePct ? r.returnPctNative : r.returnPct)}</td>
      <td class="num">${moneyC(g(r, 'endValue'), cur)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Month</th><th class="num">Start value (${cur})</th><th class="num">Contributions (${cur})</th>
    <th class="num">Dividends (${cur})</th><th class="num">Market gain (${cur})</th><th class="num">Return (${cur})</th><th class="num">Return %</th>
    <th class="num">End value (${cur})</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><th>Total</th><th></th><th class="num">${moneyC(tot.contributions, cur)}</th>
    <th class="num">${moneyC(tot.dividends, cur)}</th><th class="num">${gainUnknown ? '—' : moneyC(tot.gain, cur)}</th>
    <th class="num">${gainUnknown ? '—' : moneyC(tot.returnAmount, cur)}</th><th></th><th></th></tr></tfoot></table>`;
}

// --------------------------------------------- invest range controls ---
// The Monthly returns table pages by year when the visible
// range spans more than one year (the chart keeps the full
// range): a prev/next + year dropdown switcher above the
// table, defaulting to the latest year in range. Paging is a
// pure display slice over the range-filtered rows — it moves
// no selection state (the monthly table has no row checkboxes)
// and never touches the chart or the range controls. A range
// change that drops the stored year resets it to the latest.
const investYearPage = { investments: null, investAccount: null, investHolding: null };

function investMonthlyYears(monthly) {
  const years = new Set((monthly || []).map((r) => String(r.month || '').slice(0, 4)).filter(Boolean));
  return [...years].sort();
}

function investMonthlyBlock(monthly, level, cur, gainUnknown = false, nativePct = false) {
  const years = investMonthlyYears(monthly);
  if (years.length <= 1) return investMonthlyTable(monthly, cur, gainUnknown, nativePct);
  let year = investYearPage[level];
  if (!years.includes(year)) { year = years[years.length - 1]; investYearPage[level] = year; }
  const idx = years.indexOf(year);
  const pageRows = monthly.filter((r) => String(r.month).startsWith(`${year}-`));
  const opts = years.map((y) => `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('');
  return `<div class="toolbar" style="margin-bottom:8px">
    <button type="button" class="small" onclick="investYearStep('${level}', -1)"${idx <= 0 ? ' disabled' : ''}>&#8249; Prev year</button>
    <select aria-label="Monthly returns year" onchange="investYearPick('${level}', this.value)">${opts}</select>
    <button type="button" class="small" onclick="investYearStep('${level}', 1)"${idx >= years.length - 1 ? ' disabled' : ''}>Next year &#8250;</button>
  </div>${investMonthlyTable(pageRows, cur, gainUnknown, nativePct)}`;
}

// Re-render only one level's monthly table (chart and range
// inputs untouched) — the year switcher's whole job. On the
// portfolio level the rows are the VISIBLE accounts' rows, so
// paging after a hide never resurrects a hidden account.
function renderInvestMonthlyOnly(level) {
  const d = investViewData[level];
  const conf = INVEST_LEVEL_CONF[level];
  if (!d || !conf) return;
  const r = investEffectiveRange(level);
  const inR = (m) => !r || (m >= r.start && m <= r.end);
  const vis = level === 'investments' ? investPortfolioVisible(d) : null;
  const fMonthly = (vis ? vis.monthly : d.monthly || []).filter((x) => inR(x.month));
  const mHost = $(conf.monthly);
  if (mHost) mHost.innerHTML = investMonthlyBlock(fMonthly, level, d.cur, vis ? !!vis.gainUnknown : !!d.gainUnknown, !!d.nativePct);
}

window.investYearPick = (level, year) => {
  investYearPage[level] = year;
  renderInvestMonthlyOnly(level);
};

window.investYearStep = (level, dir) => {
  const d = investViewData[level];
  if (!d) return;
  const r = investEffectiveRange(level);
  const inR = (m) => !r || (m >= r.start && m <= r.end);
  const years = investMonthlyYears((d.monthly || []).filter((x) => inR(x.month)));
  const idx = years.indexOf(investYearPage[level]);
  const next = years[Math.min(Math.max(idx + dir, 0), years.length - 1)];
  if (next) investYearPick(level, next);
};
// The three Stocks levels carry the property hero's range model:
// preset look-back buttons (1 / 2 / 5 / 10 years, All) plus a
// From/To month pair picked from the same month popover. The
// chart AND the Monthly returns table both render only the
// months in force. Presets anchor at the LAST data month —
// investments have no projection to look forward into, so
// "1 year" means the last 12 months of data. A picked pair is
// clamped into the data span by the shared clampRange (a start
// past the end pulls the end up). Default is All.
const investRanges = {
  investments: { months: 0, custom: null },
  investAccount: { months: 0, custom: null },
  investHolding: { months: 0, custom: null },
  overview: { months: 0, custom: null },
  rentIncome: { months: 0, custom: null },
  spending: { months: 0, custom: null },
  spendCard: { months: 0, custom: null },
};
const investViewData = {}; // level -> { series, monthly, cur, nativePct }
let invPop = null; // { level, which: 'start'|'end', year }

function investRangeControlsHtml(level) {
  return `<div class="toolbar range-btns" id="invRangeBtns-${level}">
    <button type="button" data-months="12">1 year</button>
    <button type="button" data-months="24">2 years</button>
    <button type="button" data-months="60">5 years</button>
    <button type="button" data-months="120">10 years</button>
    <button type="button" data-months="0" class="active">All</button>
    <span class="range-pick">From <button type="button" id="invRangeStart-${level}" class="month-field" data-value="" aria-haspopup="dialog" aria-expanded="false" aria-label="Range start month">—</button></span>
    <span class="range-pick">To <button type="button" id="invRangeEnd-${level}" class="month-field" data-value="" aria-haspopup="dialog" aria-expanded="false" aria-label="Range end month">—</button></span>
    <div class="month-pop hidden" id="invMonthPop-${level}" role="dialog" aria-label="Choose a month">
      <div class="month-pop-head">
        <button type="button" class="small" data-pop-prev aria-label="Previous year">&#8249;</button>
        <span class="month-pop-year"></span>
        <button type="button" class="small" data-pop-next aria-label="Next year">&#8250;</button>
      </div>
      <div class="month-pop-grid"></div>
    </div>
  </div>`;
}

function investSpan(level) {
  const d = investViewData[level];
  if (!d) return null;
  const ms = new Set();
  for (const r of d.series || []) ms.add(r.month);
  for (const r of d.monthly || []) ms.add(r.month);
  if (!ms.size) return null;
  const arr = [...ms].sort();
  return { start: arr[0], end: arr[arr.length - 1] };
}

function investEffectiveRange(level) {
  const span = investSpan(level);
  if (!span) return null;
  const st = investRanges[level];
  if (st.custom) return clampRange(st.custom, span);
  if (!st.months) return span;
  const start = addMonthsYM(span.end, -(st.months - 1));
  return { start: start < span.start ? span.start : start, end: span.end };
}

const INVEST_LEVEL_CONF = {
  investments: {
    canvas: '#investPortfolioChart', key: 'investments', monthly: '#investPortfolioMonthly',
    get: () => investPortfolioChart, set: (c) => { investPortfolioChart = c; window.__fmCharts.invest = c; },
  },
  investAccount: {
    canvas: '#investAccountChart', key: 'investAccount', monthly: '#investAccountMonthly',
    get: () => investAccountChart, set: (c) => { investAccountChart = c; window.__fmCharts.invest = c; },
  },
  investHolding: {
    canvas: '#investHoldingChart', key: 'investHolding', monthly: '#investHoldingMonthly',
    get: () => investHoldingChart, set: (c) => { investHoldingChart = c; window.__fmCharts.invest = c; },
  },
  overview: {
    canvas: '#overviewChart', key: 'overview', monthly: null,
    get: () => overviewChart, set: (c) => { overviewChart = c; window.__fmCharts.overview = c; },
  },
  rentIncome: {
    canvas: '#rentIncomeChart', key: 'rentIncome', monthly: null,
    get: () => rentIncomeChart, set: (c) => { rentIncomeChart = c; window.__fmCharts.rentIncome = c; },
  },
  spending: {
    canvas: '#spendChart', key: 'spending', monthly: null,
    get: () => spendChart, set: (c) => { spendChart = c; window.__fmCharts.spend = c; },
  },
  spendCard: {
    canvas: '#spendDetailChart', key: 'spendCard', monthly: null,
    get: () => spendDetailChart, set: (c) => { spendDetailChart = c; window.__fmCharts.spendCard = c; },
  },
};

// Account colors: one fixed palette shared by the share
// doughnut and the portfolio chart's stacked bars, keyed by
// account id so an account keeps its color across renders (the
// costs categories' fixed-map idea; NOT part of the per-user
// chart_colors preference).
const INVEST_ACCOUNT_COLORS = ['#8d6e00', '#5d4037', '#283593', '#00695c', '#ad1457', '#4527a0', '#558b2f', '#6a1b9a', '#37474f', '#9e9d24'];
function investAccountColor(account) {
  const id = Math.abs(Number(account && account.id) || 0);
  return INVEST_ACCOUNT_COLORS[id % INVEST_ACCOUNT_COLORS.length];
}

// Accounts toggled off from either portfolio legend or a
// card's Hide button share one per-visit set: the bars, the
// doughnut, the monthly table, and the summary strip all
// recompute from the visible accounts (investPortfolioVisible),
// so no figure can disagree with the chart. The Value /
// Cumulative return lines are redrawn from the visible series
// too — they are no longer a precomputed total that ignores
// the toggle.
const investHiddenAccounts = new Set();
let investShareChart = null;
let investShareAccounts = []; // account rows in doughnut order
let investShareCenter = null; // { total } for the center plugin
let overviewChart = null;
let overviewShareChart = null;
let overviewShareCenter = null; // { total } for the overview center plugin

// The portfolio's visible-accounts view: when nothing is
// hidden this is the server's aggregate verbatim (so an
// unhide restores every figure exactly, to the cent); with a
// hidden account it is investVisibleAggregate over the
// visible accounts, its series zero-filled to the full span
// so the chart's time axis never shrinks on a hide. Only the
// portfolio level has a hidden set — account/holding levels
// never consult it.
function investPortfolioVisible(d) {
  if (!investHiddenAccounts.size) {
    return { monthly: d.monthly, series: d.series, summary: d.summary, gainUnknown: !!d.gainUnknown };
  }
  const vis = investVisibleAggregate(d.accounts, investHiddenAccounts, (d.series || []).map((r) => r.month));
  return { monthly: vis.monthly, series: vis.series, summary: vis.summary, gainUnknown: vis.summary.costUnknown };
}

// Card Hide buttons mirror the hidden set: a hidden card is
// greyed and its eye icon closes (open eye when visible,
// closed eye when hidden). Runs after every render
// that rebuilds the cards and after every toggle, so the
// legend and the cards can never disagree.
function syncInvestHideCards() {
  document.querySelectorAll('.invest-hide-btn').forEach((btn) => {
    const hidden = investHiddenAccounts.has(Number(btn.dataset.accountId));
    btn.classList.toggle('invest-eye-hidden', hidden);
    btn.title = hidden ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', btn.title);
    const card = btn.closest('.breakdown-card');
    if (card) card.classList.toggle('invest-hidden-card', hidden);
  });
}

function toggleInvestAccount(id) {
  if (investHiddenAccounts.has(id)) investHiddenAccounts.delete(id);
  else investHiddenAccounts.add(id);
  syncInvestHideCards();
  const d = investViewData.investments;
  if (!d || !document.getElementById('investPortfolioChart')) return;
  const vis = investPortfolioVisible(d);
  const strip = document.getElementById('investPortfolioStrip');
  if (strip) strip.innerHTML = investSummaryStrip(vis.summary, d.cur);
  applyInvestRange('investments');
}

// The portfolio charts' legend handler, following the app's
// legend convention: left click toggles. Account entries route
// through toggleInvestAccount so the bars and the doughnut move
// together; the Value / Cumulative return lines toggle only
// themselves, exactly like Chart.js' default.
function investLegendClick(e, item, legend) {
  const chart = legend.chart;
  const ds = chart.data.datasets[item.datasetIndex];
  if (ds && ds.accountId != null) { toggleInvestAccount(ds.accountId); return; }
  chart.setDatasetVisibility(item.datasetIndex, !chart.isDatasetVisible(item.datasetIndex));
  chart.update();
}

// The portfolio level's chart: one stacked bar per month, each
// segment an account's month-end value (carried forward across
// months the account has no point for), under the same Value
// and Cumulative return lines the other levels draw. Follows
// the range in force like the lines do.
function drawInvestPortfolioChart(canvas, data, fSeries, cur = 'CAD') {
  if (!canvas) return null;
  const months = fSeries.map((r) => r.month);
  const bars = (data.accounts || []).map((a) => {
    const byMonth = new Map((a.series || []).map((p) => [p.month, p.value]));
    let run = 0;
    const vals = months.map((m) => { if (byMonth.has(m)) run = byMonth.get(m); return run; });
    return {
      type: 'bar', label: a.account.name, accountId: a.account.id, data: vals,
      backgroundColor: investAccountColor(a.account), stack: 'value', order: 3, maxBarThickness: 28,
    };
  });
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        ...bars,
        { label: `Value (${cur})`, data: fSeries.map((r) => r.value), borderColor: '#1668c4', backgroundColor: '#1668c4', tension: 0.15, pointRadius: 0, borderWidth: 2, order: 1 },
        // Same rule as the single-holding chart: a cost-unknown
        // constituent makes the cumulative return fake, so the
        // line is dropped when the aggregate is flagged.
        ...(data.gainUnknown ? [] : [{ label: `Cumulative return (${cur})`, data: fSeries.map((r) => r.returnAmount), borderColor: '#2e7d4f', backgroundColor: '#2e7d4f', tension: 0.15, pointRadius: 0, borderWidth: 2, order: 1 }]),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: moneyTick } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 }, onClick: investLegendClick },
        tooltip: {
          callbacks: {
            label: (c) => {
              const ds = c.dataset;
              if (ds.accountId != null) {
                // The % is over the VISIBLE segments only — a
                // hidden account must not dilute the shares.
                const total = c.chart.data.datasets.reduce((s, d, i) => s + (d.accountId != null && c.chart.isDatasetVisible(i) ? (d.data[c.dataIndex] || 0) : 0), 0);
                const pct = total ? ((c.parsed.y / total) * 100).toFixed(1) : '0.0';
                return `${ds.label}: ${moneyC(c.parsed.y, cur)} (${pct}%)`;
              }
              return `${c.dataset.label}: ${moneyC(c.parsed.y, cur)}`;
            },
          },
        },
      },
    },
    plugins: [guideLinePlugin],
  });
  bars.forEach((ds, i) => { if (investHiddenAccounts.has(ds.accountId)) chart.setDatasetVisibility(i, false); });
  chart.update();
  window.__fmCharts.investments = chart;
  return chart;
}

// The Overview panel's history chart: per-month stacked bars
// (Property + Stock segments) under a total line — the Stocks
// Total return chart's shape with exactly two portions. Hover
// carries the property charts' vertical dashed guide line; the
// doughnut below pops its slice out on hover (hoverOffset 10,
// the property portfolio pie's value). All figures CAD.
function drawOverviewHistoryChart(canvas, months, cur = 'CAD') {
  if (!canvas) return null;
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months.map((r) => r.month),
      datasets: [
        { type: 'bar', label: 'Property', data: months.map((r) => r.property), backgroundColor: '#1668c4', stack: 'value', order: 3, maxBarThickness: 28 },
        { type: 'bar', label: 'Stock', data: months.map((r) => r.stock), backgroundColor: '#d97b29', stack: 'value', order: 3, maxBarThickness: 28 },
        { label: `Total (${cur})`, data: months.map((r) => r.total), borderColor: '#22303c', backgroundColor: '#22303c', tension: 0.15, pointRadius: 0, borderWidth: 2, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: moneyTick } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = months[c.dataIndex] ? months[c.dataIndex].total : 0;
              if (c.dataset.type === 'bar') {
                const pct = total ? ((c.parsed.y / total) * 100).toFixed(1) : '0.0';
                return `${c.dataset.label}: ${moneyC(c.parsed.y, cur)} (${pct}%)`;
              }
              return `${c.dataset.label}: ${moneyC(c.parsed.y, cur)}`;
            },
          },
        },
      },
    },
    plugins: [guideLinePlugin],
  });
  window.__fmCharts.overview = chart;
  return chart;
}

// The Overview panel's center plugin (the costs pie's center
// plugin, same typography): the range-end total in the hole.
const overviewShareCenterPlugin = {
  id: 'overviewShareCenter',
  afterDraw(chart) {
    if (!overviewShareCenter || chart !== overviewShareChart) return;
    const area = chart.chartArea;
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const c = chart.ctx;
    c.save();
    c.textAlign = 'center';
    c.fillStyle = '#71808f';
    c.font = '11px system-ui, sans-serif';
    c.fillText('Total value', x, y - 4);
    c.fillStyle = '#22303c';
    c.font = '700 14px system-ui, sans-serif';
    c.fillText(moneyC(overviewShareCenter.total, 'CAD'), x, y + 14);
    c.restore();
  },
};

// The Overview share doughnut: Property vs Stock at the END
// month of the range in force — the Stocks share doughnut's
// rule, with an as-of month in the heading so a historical
// split can never be mistaken for current. Zero-value portions
// are dropped. Values are CAD; nothing here converts or fetches.
function drawOverviewShareChart(propertyByMonth, stockSeries, endMonth = null) {
  const canvas = $('#overviewShareChart');
  if (!canvas) return;
  const { rows, total } = overviewShareAtMonth(propertyByMonth, stockSeries, endMonth);
  const title = $('#overviewShareTitle');
  if (title) title.textContent = endMonth ? `Asset share · ${formatYM(endMonth)}` : 'Asset share';
  const empty = $('#overviewShareEmpty');
  const wrap = $('#overviewShareWrap');
  if (!rows.length || total <= 0) {
    if (overviewShareChart) { overviewShareChart.destroy(); overviewShareChart = null; }
    overviewShareCenter = null;
    window.__fmCharts.overviewShare = null;
    if (wrap) wrap.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (wrap) wrap.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');
  overviewShareCenter = { total };
  if (overviewShareChart) overviewShareChart.destroy();
  overviewShareChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{
        data: rows.map((r) => r.value),
        backgroundColor: rows.map((r) => (r.label === 'Property' ? '#1668c4' : '#d97b29')),
        borderColor: '#fff', borderWidth: 1,
        hoverOffset: 10,
      }],
    },
    plugins: [overviewShareCenterPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (item) => {
              const t = item.dataset.data.reduce((a, b) => a + b, 0);
              const pct = t ? ((item.parsed / t) * 100).toFixed(1) : '0.0';
              return ` ${item.label}: ${moneyC(item.parsed, 'CAD')} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  window.__fmCharts.overviewShare = overviewShareChart;
}

// The portfolio total in the doughnut's hole (the costs pie's
// center plugin, same typography).
const investShareCenterPlugin = {
  id: 'investShareCenter',
  afterDraw(chart) {
    if (!investShareCenter || chart !== investShareChart) return;
    const area = chart.chartArea;
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const c = chart.ctx;
    c.save();
    c.textAlign = 'center';
    c.fillStyle = '#71808f';
    c.font = '11px system-ui, sans-serif';
    c.fillText('Total value', x, y - 4);
    c.fillStyle = '#22303c';
    c.font = '700 14px system-ui, sans-serif';
    c.fillText(moneyC(investShareCenter.total, investShareCenter.cur || 'CAD'), x, y + 14);
    c.restore();
  },
};

// The account-share doughnut: each account's share of value at
// the END month of the range in force — the same picker that
// drives the Total return chart re-renders it, no reload. For
// a range ending at the last data month that is exactly
// today's current values; a past end month shows that month's
// split instead. Zero-value accounts are dropped, and the
// heading names the as-of month so a historical split can
// never be mistaken for current. Values arrive in the page's
// display currency (the toggle round's seam); nothing here
// converts or fetches.
function drawInvestShareChart(accounts, cur = 'CAD', endMonth = null) {
  const canvas = $('#investShareChart');
  if (!canvas) return;
  const { rows, total } = investShareAtMonth(accounts, endMonth);
  investShareAccounts = rows.map((r) => r.account);
  const title = $('#investShareTitle');
  if (title) title.textContent = endMonth ? `Account share · ${formatYM(endMonth)}` : 'Account share';
  const empty = $('#investShareEmpty');
  const wrap = $('#investShareWrap');
  if (!rows.length || total <= 0) {
    if (investShareChart) { investShareChart.destroy(); investShareChart = null; }
    investShareCenter = null;
    window.__fmCharts.investShare = null;
    if (wrap) wrap.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (wrap) wrap.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');
  // The doughnut keeps every account's slice (hidden ones flip
  // off via toggleDataVisibility below, so either legend can
  // restore them), but its center total counts VISIBLE accounts
  // only — otherwise the hole would disagree with the slices.
  const visibleTotal = rows.filter((r) => !investHiddenAccounts.has(r.account.id))
    .reduce((s, r) => s + r.value, 0);
  investShareCenter = { total: visibleTotal, cur };
  if (investShareChart) investShareChart.destroy();
  investShareChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.account.name),
      datasets: [{
        data: rows.map((r) => r.value),
        backgroundColor: rows.map((r) => investAccountColor(r.account)),
        borderColor: '#fff', borderWidth: 1,
        hoverOffset: 10, // Property pie parity: the slice pops out on hover.
      }],
    },
    plugins: [investShareCenterPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: {
          position: 'bottom', labels: { boxWidth: 12 },
          onClick: (e, item) => { const a = investShareAccounts[item.index]; if (a) toggleInvestAccount(a.id); },
        },
        tooltip: {
          callbacks: {
            label: (item) => {
              // The % is over the VISIBLE slices only, matching
              // the center total.
              const t = item.dataset.data.reduce((s, v, i) => s + (item.chart.getDataVisibility(i) ? v : 0), 0);
              const pct = t ? ((item.parsed / t) * 100).toFixed(1) : '0.0';
              return ` ${item.label}: ${moneyC(item.parsed, cur)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  investShareAccounts.forEach((a, i) => {
    if (investHiddenAccounts.has(a.id) && investShareChart.getDataVisibility(i)) investShareChart.toggleDataVisibility(i);
  });
  investShareChart.update();
  window.__fmCharts.investShare = investShareChart;
}

// Re-render one level's chart + monthly table inside the range
// in force, and bring the controls in line with it.
function applyInvestRange(level) {
  const d = investViewData[level];
  const conf = INVEST_LEVEL_CONF[level];
  if (!d || !conf) return;
  const r = investEffectiveRange(level);
  const inR = (m) => !r || (m >= r.start && m <= r.end);
  const vis = level === 'investments' ? investPortfolioVisible(d) : null;
  const fSeries = (vis ? vis.series : d.series || []).filter((x) => inR(x.month));
  const old = conf.get();
  if (old) old.destroy();
  if (level === 'rentIncome') {
    // The Rentals income panel draws its own two charts from the
    // range-filtered entry income; the share draw reports empty
    // (no income in range) by hiding both chart wraps.
    if (drawRentIncomeShareChart(d, r)) conf.set(drawRentIncomeHistoryChart($(conf.canvas), d, r));
    else { rentIncomeChart = null; window.__fmCharts.rentIncome = null; }
  } else if (level === 'spending' || level === 'spendCard') {
    // Spending draws its own two charts from the range-filtered
    // monthly rows and transactions: the share doughnut covers
    // the whole range (by card / by category on the overall page,
    // by category on a card page), the history bars the months.
    drawSpendCharts(level, d, r);
    // A range change re-defaults the transaction table to the
    // latest month in the new range, like the year pager above.
    // A data reload with an unchanged range keeps the page: an
    // Edit save from the Aug page must stay on Aug, not jump to
    // the latest month.
    const lastR = spendTxLastRange[level];
    if (!r || !lastR || lastR.start !== r.start || lastR.end !== r.end) spendTxMonthPage[level] = null;
    spendTxLastRange[level] = r ? { start: r.start, end: r.end } : null;
    if (level === 'spending') renderSpendTxTable();
    else renderSpendDetailTxTable();
  } else if (level === 'overview') {
    // The Overview panel has no monthly table: its history
    // chart draws the filtered monthly rows (Property + Stock
    // stacked bars under a total line) and its doughnut follows
    // the same range-end rule as the Stocks share doughnut.
    const fMonths = (d.monthly || []).filter((x) => inR(x.month));
    conf.set(drawOverviewHistoryChart($(conf.canvas), fMonths, 'CAD'));
    drawOverviewShareChart(d.propertyByMonth, d.stockSeries, r ? r.end : null);
  } else {
    conf.set(level === 'investments'
      ? drawInvestPortfolioChart($(conf.canvas), vis ? { ...d, gainUnknown: vis.gainUnknown } : d, fSeries, d.cur)
      : drawInvestChart($(conf.canvas), conf.key, fSeries, d.cur, !!d.gainUnknown));
  }
  // The portfolio doughnut follows the same range: its shares
  // are the accounts' values at the range-end month.
  if (level === 'investments') drawInvestShareChart(d.accounts, d.cur, r ? r.end : null);
  // A range change re-defaults the table to the latest year
  // in the new range; the year switcher only navigates within
  // the range in force. Levels without a table (overview) skip it.
  investYearPage[level] = null;
  if (conf.monthly) renderInvestMonthlyOnly(level);
  syncInvestRangeInputs(level);
}

function syncInvestRangeInputs(level) {
  const bar = document.getElementById(`invRangeBtns-${level}`);
  if (!bar) return;
  const st = investRanges[level];
  bar.querySelectorAll('button[data-months]').forEach((b) => {
    b.classList.toggle('active', !st.custom && Number(b.dataset.months) === st.months);
  });
  const span = investSpan(level);
  const r = investEffectiveRange(level);
  for (const [which, ym] of [['Start', r && r.start], ['End', r && r.end]]) {
    const btn = document.getElementById(`invRange${which}-${level}`);
    if (!btn) continue;
    btn.dataset.value = ym || '';
    btn.textContent = formatYM(ym);
    btn.disabled = !span;
  }
  if (invPop && invPop.level === level) renderInvMonthPop();
}

function renderInvMonthPop() {
  if (!invPop) return;
  const pop = document.getElementById(`invMonthPop-${invPop.level}`);
  if (!pop) return;
  const span = investSpan(invPop.level);
  if (!span) { closeInvMonthPop(); return; }
  const field = document.getElementById(`invRange${invPop.which === 'start' ? 'Start' : 'End'}-${invPop.level}`);
  const selected = field ? field.dataset.value : '';
  const selYear = selected ? Number(selected.slice(0, 4)) : null;
  const minYear = Math.min(Number(span.start.slice(0, 4)), selYear ?? Infinity);
  const maxYear = Math.max(Number(span.end.slice(0, 4)), selYear ?? -Infinity);
  if (invPop.year == null) invPop.year = selYear ?? maxYear;
  invPop.year = Math.min(Math.max(invPop.year, minYear), maxYear);
  pop.querySelector('.month-pop-year').textContent = String(invPop.year);
  pop.querySelector('[data-pop-prev]').disabled = invPop.year <= minYear;
  pop.querySelector('[data-pop-next]').disabled = invPop.year >= maxYear;
  pop.querySelector('.month-pop-grid').innerHTML = MONTH_NAMES.map((name, i) => {
    const ym = `${invPop.year}-${String(i + 1).padStart(2, '0')}`;
    const off = ym < span.start || ym > span.end;
    return `<button type="button" data-ym="${ym}"${off ? ' disabled' : ''}${ym === selected ? ' class="sel"' : ''}>${name}</button>`;
  }).join('');
}

function openInvMonthPop(level, which) {
  const field = document.getElementById(`invRange${which === 'start' ? 'Start' : 'End'}-${level}`);
  if (!field || field.disabled) return;
  invPop = { level, which, year: field.dataset.value ? Number(field.dataset.value.slice(0, 4)) : null };
  renderInvMonthPop();
  if (!invPop) return; // no span — render closed it
  const pop = document.getElementById(`invMonthPop-${level}`);
  pop.classList.remove('hidden');
  anchorInvMonthPop();
  document.getElementById(`invRangeStart-${level}`).setAttribute('aria-expanded', String(which === 'start'));
  document.getElementById(`invRangeEnd-${level}`).setAttribute('aria-expanded', String(which === 'end'));
}

// The invest popovers share the .month-pop CSS (position:fixed),
// so their left/top are VIEWPORT coordinates: anchor from the
// field's viewport rect, never from offsetTop/offsetLeft — those
// are toolbar-relative, and feeding them to a fixed element used
// to strand the picker at the viewport top while its field sat
// mid-page (the Overview/Stocks screenshots of 2026-10-29).
function anchorInvMonthPop() {
  if (!invPop) return;
  const pop = document.getElementById(`invMonthPop-${invPop.level}`);
  const field = document.getElementById(`invRange${invPop.which === 'start' ? 'Start' : 'End'}-${invPop.level}`);
  if (!pop || !field) return;
  const r = field.getBoundingClientRect();
  const left = Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 4));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

function closeInvMonthPop() {
  if (!invPop) return;
  const pop = document.getElementById(`invMonthPop-${invPop.level}`);
  if (pop) pop.classList.add('hidden');
  for (const w of ['Start', 'End']) {
    const f = document.getElementById(`invRange${w}-${invPop.level}`);
    if (f) f.setAttribute('aria-expanded', 'false');
  }
  invPop = null;
}

function wireInvestRangeControls(level) {
  const bar = document.getElementById(`invRangeBtns-${level}`);
  if (!bar || bar.dataset.wired) return;
  bar.dataset.wired = '1';
  bar.addEventListener('click', (e) => {
    const preset = e.target.closest('button[data-months]');
    if (preset) {
      investRanges[level].months = Number(preset.dataset.months);
      investRanges[level].custom = null;
      closeInvMonthPop();
      applyInvestRange(level);
      return;
    }
    if (e.target.closest(`#invRangeStart-${level}`)) {
      if (invPop && invPop.level === level && invPop.which === 'start') closeInvMonthPop();
      else openInvMonthPop(level, 'start');
      return;
    }
    if (e.target.closest(`#invRangeEnd-${level}`)) {
      if (invPop && invPop.level === level && invPop.which === 'end') closeInvMonthPop();
      else openInvMonthPop(level, 'end');
      return;
    }
    const pop = document.getElementById(`invMonthPop-${level}`);
    if (pop && pop.contains(e.target)) {
      if (e.target.closest('[data-pop-prev]')) { invPop.year -= 1; renderInvMonthPop(); return; }
      if (e.target.closest('[data-pop-next]')) { invPop.year += 1; renderInvMonthPop(); return; }
      const cell = e.target.closest('button[data-ym]');
      if (!cell || cell.disabled || !invPop || invPop.level !== level) return;
      const start = invPop.which === 'start' ? cell.dataset.ym : document.getElementById(`invRangeStart-${level}`).dataset.value;
      const end = invPop.which === 'end' ? cell.dataset.ym : document.getElementById(`invRangeEnd-${level}`).dataset.value;
      closeInvMonthPop();
      if (!start || !end) return;
      investRanges[level].custom = clampRange({ start, end }, investSpan(level));
      applyInvestRange(level);
    }
  });
}

// Popover etiquette for the invest pickers: an outside click or
// Esc closes the open one.
document.addEventListener('click', (e) => {
  if (!invPop) return;
  const bar = document.getElementById(`invRangeBtns-${invPop.level}`);
  if (bar && !bar.contains(e.target)) closeInvMonthPop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInvMonthPop(); });

function drawInvestChart(canvas, key, series, cur, gainUnknown = false) {
  if (!canvas) return null;
  const labels = series.map((r) => r.month);
  // Series values always read the plain fields: the server
  // renders them in the page's display currency, so the chart
  // needs no native branch anymore.
  const values = series.map((r) => r.value);
  const returns = series.map((r) => r.returnAmount);
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: `Value (${cur})`, data: values, borderColor: '#1668c4', backgroundColor: '#1668c4', tension: 0.15, pointRadius: 0, borderWidth: 2 },
        // A cost-unknown holding's cumulative return is value
        // minus zero contributions — a fake number — so the
        // return line is dropped, not drawn.
        ...(gainUnknown ? [] : [{ label: `Cumulative return (${cur})`, data: returns, borderColor: '#2e7d4f', backgroundColor: '#2e7d4f', tension: 0.15, pointRadius: 0, borderWidth: 2 }]),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { ticks: { callback: moneyTick } } },
      plugins: {
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${moneyC(c.parsed.y, cur)}` } },
      },
    },
    plugins: [guideLinePlugin],
  });
  window.__fmCharts[key] = chart;
  return chart;
}

// ------------------------------------------------------- portfolio level
async function loadInvestmentsImpl() {
  const host = $('#section-investments');
  const display = investDisplay.investments || 'CAD';
  const data = await api(`/api/investments?display=${display}`);
  const cur = data.display || 'CAD';
  investDisplay.investments = cur;
  const s = data.summary;
  const cards = data.accounts.map((a) => {
    const hidden = investHiddenAccounts.has(a.account.id);
    return `
    <div class="card breakdown-card${hidden ? ' invest-hidden-card' : ''}" data-invest-account-card="${a.account.id}" onclick="location.hash='#invest-account/${a.account.id}'">
      <button type="button" class="invest-hide-btn invest-eye-btn${hidden ? ' invest-eye-hidden' : ''}" data-account-id="${a.account.id}" title="${hidden ? 'Show' : 'Hide'}" aria-label="${hidden ? 'Show' : 'Hide'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="eye-open"><path d="M2 12C6 5.5 18 5.5 22 12C18 18.5 6 18.5 2 12Z"/><circle cx="12" cy="12" r="3" fill="none"/></g><g class="eye-closed"><path d="M4 8.5Q12 17 20 8.5"/><line x1="5.5" y1="12" x2="4" y2="14.5"/><line x1="8.5" y1="14.5" x2="7.5" y2="17"/><line x1="12" y1="15.5" x2="12" y2="18"/><line x1="15.5" y1="14.5" x2="16.5" y2="17"/><line x1="18.5" y1="12" x2="20" y2="14.5"/></g></svg></button>
      <div class="k">${esc(a.account.name)} <span class="badge">${esc(ACCOUNT_TYPE_LABELS[a.account.type] || a.account.type)}</span>${a.account.institution ? ` <span class="note" style="margin:0">${esc(a.account.institution)}</span>` : ''}</div>
      <div class="v">${moneyC(a.summary.value, cur)}</div>
      <div class="n">${a.holdings.length} ${a.holdings.length === 1 ? 'holding' : 'holdings'} · return ${a.summary.costUnknown ? '—' : returnText(a.summary.totalReturn, a.summary.totalReturnPct, cur)}${a.summary.costUnknown ? ' · cost unknown' : ''}</div>
      ${a.account.owners && a.account.owners.length ? `<div class="n">${ownerChipsHtml(a.account.owners)}</div>` : ''}
    </div>`;
  }).join('');
  host.innerHTML = `
    <div class="section-head"><h2>Stocks</h2>
      <div class="spacer"></div>
      <button id="investDisplayBtn">${investDisplayLabel(cur)}</button>
      <button id="refreshInvestBtn">Refresh prices</button>
      <button class="primary" id="addInvestAccountBtn">+ Add account</button></div>
    <div class="msg" id="investMsg"></div>
    ${data.fxMissing && data.accounts.some((a) => a.holdings.some((h) => h.holding.currency !== cur))
      ? `<div class="msg warn">USD/CAD rates are unavailable right now — holdings are shown unconverted in the ${cur} totals.</div>` : ''}
    <div class="summary-strip" id="investPortfolioStrip">${investSummaryStrip(s, cur)}</div>
    <div class="panel">
      <h3>Total return</h3>
      ${investRangeControlsHtml('investments')}
      <div class="invest-charts-row">
        <div class="invest-share-col">
          <div class="invest-share-head"><h3 id="investShareTitle">Account share</h3></div>
          <div class="invest-share-box" id="investShareWrap"><div class="chart-wrap invest-share"><canvas id="investShareChart"></canvas></div></div>
          <div class="note hidden" id="investShareEmpty">No account values yet.</div>
        </div>
        <div class="invest-main-chart"><div class="chart-wrap tall"><canvas id="investPortfolioChart"></canvas></div></div>
      </div>
      <div class="cards" style="margin-top:12px">${cards || '<div class="note">No accounts yet — add one to start tracking.</div>'}</div>
    </div>
    <div class="panel"><h3>Monthly returns</h3><div id="investPortfolioMonthly">${investMonthlyTable(data.monthly, cur)}</div>
      <div class="note" style="margin-left:0">All figures in ${cur}. Dividends count in the month's return, not in its end value. Grants count as contributions at their cost (or that day's market) price, never as profit.</div></div>`;
  investViewData.investments = { series: data.series, monthly: data.monthly, cur, nativePct: false, accounts: data.accounts, gainUnknown: !!data.summary.costUnknown, summary: data.summary };
  // A display switch re-renders the whole page while the
  // per-visit hidden set survives: the strip must follow the
  // visible figures, not the server's full summary.
  if (investHiddenAccounts.size) {
    const strip0 = document.getElementById('investPortfolioStrip');
    if (strip0) strip0.innerHTML = investSummaryStrip(investPortfolioVisible(investViewData.investments).summary, cur);
  }
  // Hide buttons stop at the button — a Hide click must not
  // follow the card's navigation onclick.
  host.querySelectorAll('.invest-hide-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleInvestAccount(Number(btn.dataset.accountId));
    });
  });
  wireInvestRangeControls('investments');
  applyInvestRange('investments');
  $('#investDisplayBtn').addEventListener('click', () => {
    investDisplay.investments = investDisplay.investments === 'CAD' ? 'USD' : 'CAD';
    loadInvestmentsImpl();
  });
  $('#addInvestAccountBtn').addEventListener('click', () => openInvestAccountModal(null));
  $('#refreshInvestBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/investments/refresh', { method: 'POST', body: {} });
      await loadInvestmentsImpl();
      renderInvestRefreshResult(r.results || []);
    }
    catch (err) { showMsg($('#investMsg'), 'err', err.message); }
    finally { e.target.disabled = false; }
  });
}

// The Refresh prices result line: a refresh that silently
// keeps fallback prices looks identical to one that worked,
// so the outcome is stated per holding — updated ones with
// their source, failed ones with the verbatim reason.
function renderInvestRefreshResult(results) {
  const el = $('#investMsg');
  if (!el) return;
  if (!results.length) { showMsg(el, 'ok', 'No exchange holdings to refresh.'); return; }
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    showMsg(el, 'ok', `Prices refreshed — ${ok.length} holding${ok.length === 1 ? '' : 's'} updated.`);
    return;
  }
  el.className = 'msg err';
  el.innerHTML = [
    `Prices refreshed — ${ok.length} updated, ${failed.length} failed:`,
    ...failed.map((r) => `${esc(r.symbol || `#${r.id}`)} — ${esc(r.error || 'fetch failed')}`),
  ].join('<br>');
}

// --------------------------------------------------------- account level
async function loadInvestAccountImpl(id) {
  const wanted = investDisplay.investAccount; // null = the server's default for this account
  const data = await api(`/api/investments/accounts/${id}${wanted ? `?display=${wanted}` : ''}`);
  const display = data.display || 'CAD';
  investDisplay.investAccount = display;
  investAccountData = data;
  const a = data.account;
  if (investChatAccountId !== id) resetInvestChat(id);
  // The toggle lives in the static toolbar (the loader never
  // re-renders it): bind once, re-label on every render.
  investDisplayAccountId = id;
  const dispBtn = $('#investAccountDisplayBtn');
  if (dispBtn) {
    dispBtn.textContent = investDisplayLabel(display);
    if (!dispBtn.dataset.wired) {
      dispBtn.dataset.wired = '1';
      dispBtn.addEventListener('click', () => {
        investDisplay.investAccount = investDisplay.investAccount === 'CAD' ? 'USD' : 'CAD';
        loadInvestAccountImpl(investDisplayAccountId);
      });
    }
  }
  $('#investAccountTitle').innerHTML =
    `${esc(a.name)} <span class="badge">${esc(ACCOUNT_TYPE_LABELS[a.type] || a.type)}</span>${a.institution ? ` <span class="note" style="margin:0">${esc(a.institution)}</span>` : ''}${a.owners && a.owners.length ? `<div style="margin:4px 0 0">${ownerChipsHtml(a.owners)}</div>` : ''}${a.note ? `<div class="note" style="margin:4px 0 0">${esc(a.note)}</div>` : ''}`;
  $('#investAccountStats').innerHTML = investSummaryStrip(data.summary, display);
  const notes = [];
  for (const row of data.holdings) {
    const st = row.priceStatus;
    if (st.pricedBy === 'none') notes.push(`“${row.holding.label}” has no price yet — add an event with a price or a price snapshot.`);
    else if (st.pricedBy === 'event') notes.push(`“${row.holding.label}” is priced from its trade prices (no market feed) — figures walk flat between trades.`);
    else if (st.stale) notes.push(`Market prices for “${row.holding.label}” may be stale (last fetched ${esc(st.lastFetchedDate || '—')}).`);
    if (st.fetchFailedToday) notes.push(`Market price fetch failed for “${row.holding.label}” (${esc(st.lastError)}) — last attempt ${esc(st.lastAttemptAt || '—')}.`);
  }
  if (data.fxMissing && data.holdings.some((r) => r.holding.currency !== display)) {
    notes.push(`USD/CAD rates are unavailable right now — holdings are shown unconverted in the ${display} totals.`);
  }
  const noteEl = $('#investAccountPriceNote');
  noteEl.classList.toggle('hidden', !notes.length);
  noteEl.innerHTML = notes.map(esc).join('<br>');
  investViewData.investAccount = { series: data.series, monthly: data.monthly, cur: display, nativePct: false, gainUnknown: !!data.summary.costUnknown };
  applyInvestRange('investAccount');
  const rows = data.holdings.map((row) => {
    const h = row.holding; const sm = row.summary;
    return `<tr class="clickable" onclick="location.hash='#invest-holding/${h.id}'">
      <td>${esc(h.label)}${aiBadge(h.source)} ${currencyBadge(h.currency)}<div class="note" style="margin:0">${h.kind === 'fund' ? 'Mutual fund' : 'Exchange'}${h.symbol ? ` · ${esc(h.symbol)}` : ''}${h.fund_code ? ` · ${esc(h.fund_code)}` : ''}${sm.costUnknown ? ' · cost unknown' : ''}</div></td>
      <td class="num">${fmtUnits(sm.units)}</td>
      <td class="num">${sm.latestPrice != null ? moneyC(sm.latestPrice, h.currency) : '—'}${sm.latestPriceDate ? `<div class="note" style="margin:0">${esc(sm.latestPriceDate)}</div>` : ''}</td>
      <td class="num">${moneyC(sm.valueNative, h.currency)}</td>
      <td class="num">${moneyC(sm.value, display)}</td>
      <td class="num">${sm.costUnknown ? '—' : returnText(sm.totalReturn, sm.totalReturnPctNative, display)}</td>
      <td style="white-space:nowrap">
        <button class="small" onclick="event.stopPropagation(); openInvestHoldingModal(${h.id})">Edit</button>
        <button class="small danger" onclick="event.stopPropagation(); deleteInvestHolding(${h.id})">Delete</button>
      </td></tr>`;
  }).join('');
  $('#investHoldingsWrap').innerHTML = data.holdings.length
    ? `<table><thead><tr><th>Holding</th><th class="num">Units</th><th class="num">Latest price</th><th class="num">Value</th><th class="num">Value (${display})</th><th class="num">Total return</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="note">No holdings yet — add one, or let ✨ Fill with AI draft them from a statement.</div>';
  $('#addHoldingBtn').onclick = () => openInvestHoldingModal(null);
  $('#editInvestAccountBtn').onclick = () => openInvestAccountModal(id);
  $('#deleteInvestAccountBtn').onclick = () => deleteInvestAccount(id);
  renderInvestPlans(data);
  $('#addPlanBtn').onclick = () => openInvestPlanModal(null);
}

// Contribution plans on the account page: frequency and
// employer name come live from the linked job (the server
// derives them at read time); totals split own vs employer
// from the generated events' portion columns; skipped periods
// list their due date and reason.
function renderInvestPlans(data) {
  const plans = data.plans || [];
  const holdings = data.holdings || [];
  const curOf = (p) => {
    const h = holdings.find((r) => r.holding.id === p.target_holding_id);
    return h ? h.holding.currency : data.display || 'CAD';
  };
  if (!plans.length) {
    $('#investPlansWrap').innerHTML = '<div class="note">No contribution plans yet.</div>';
    return;
  }
  const totOwn = plans.reduce((s, p) => s + (p.own_total || 0), 0);
  const totEmp = plans.reduce((s, p) => s + (p.employer_total || 0), 0);
  const rows = plans.map((p) => {
    const cur = curOf(p);
    const skipped = (p.skipped || []).length
      ? `<div class="note" style="margin:4px 0 0">Skipped: ${(p.skipped || []).map((s) => `${esc(s.due_date)} — ${esc(s.reason)}`).join('; ')}</div>`
      : '';
    return `<tr>
      <td>${esc(p.employer || '—')}<div class="note" style="margin:0">${esc(p.frequency_label || p.frequency || '—')} · ${esc(p.target_holding_label || '—')}</div></td>
      <td>${esc(p.start_date)}</td>
      <td class="num">${moneyC(p.own_amount, cur)}</td>
      <td class="num">${p.employer_amount != null ? moneyC(p.employer_amount, cur) : '—'}</td>
      <td class="num">${p.generated_count}</td>
      <td class="num">${moneyC(p.own_total, cur)}${p.employer_total ? ` + ${moneyC(p.employer_total, cur)} employer` : ''}</td>
      <td style="white-space:nowrap">
        <button class="small" onclick="generateInvestPlan(${p.id})">Generate</button>
        <button class="small" onclick="openInvestPlanModal(${p.id})">Edit</button>
        <button class="small danger" onclick="deleteInvestPlan(${p.id})">Delete</button>
      </td></tr>${skipped ? `<tr><td colspan="7">${skipped}</td></tr>` : ''}`;
  }).join('');
  $('#investPlansWrap').innerHTML =
    `<table><thead><tr><th>Employer</th><th>Start</th><th class="num">Own / period</th><th class="num">Employer / period</th><th class="num">Generated</th><th class="num">Contributed (own + employer)</th><th></th></tr></thead><tbody>${rows}</tbody></table>
     <div class="note" style="margin:8px 0 0">Total contributed: own ${moneyC(totOwn, data.display || 'CAD')}${totEmp ? ` · employer ${moneyC(totEmp, data.display || 'CAD')}` : ''} (display currency; per-plan figures are in the target holding's currency).</div>`;
}

let investPlanJobs = [];
function syncInvestPlanFrequency() {
  const job = investPlanJobs.find((j) => String(j.id) === String($('#investPlanJob').value));
  $('#investPlanFrequency').value = job ? `${job.frequencyLabel || job.frequency} — ${job.employer}` : '';
}
async function openInvestPlanModal(id) {
  const form = $('#investPlanForm');
  form.reset();
  $('#investPlanModalMsg').className = 'msg';
  form.elements.id.value = id || '';
  $('#investPlanModalTitle').textContent = id ? 'Edit plan' : 'Add plan';
  const account = investAccountData ? investAccountData.account : null;
  const isRrsp = account && account.type === 'RRSP';
  $('#investPlanEmployerWrap').classList.toggle('hidden', !isRrsp);
  const holdings = investAccountData ? investAccountData.holdings : [];
  $('#investPlanHolding').innerHTML = holdings.map((r) =>
    `<option value="${r.holding.id}">${esc(r.holding.label)} (${esc(r.holding.currency)})</option>`).join('');
  try {
    const earn = await api('/api/earnings');
    investPlanJobs = (earn.jobs || []).map((j) => ({
      id: j.id, employer: j.employer, frequency: j.frequency,
      frequencyLabel: (earn.payFrequencies.find((f) => f.key === j.frequency) || {}).label || j.frequency,
    }));
  } catch { investPlanJobs = []; }
  $('#investPlanJob').innerHTML = investPlanJobs.length
    ? investPlanJobs.map((j) => `<option value="${j.id}">${esc(j.employer)} — ${esc(j.frequencyLabel)}</option>`).join('')
    : '<option value="">No salary jobs — add one under Earnings first</option>';
  $('#investPlanJob').onchange = syncInvestPlanFrequency;
  if (id) {
    const p = (investAccountData.plans || []).find((x) => x.id === id);
    if (p) {
      form.elements.job_id.value = p.job_id;
      form.elements.target_holding_id.value = p.target_holding_id;
      form.elements.start_date.value = p.start_date || '';
      setMoneyValue(form.elements.own_amount, p.own_amount);
      setMoneyValue(form.elements.employer_amount, p.employer_amount);
      syncInvestPlanFrequency();
    }
  } else {
    syncInvestPlanFrequency();
  }
  openModal('investPlanModal');
}
window.openInvestPlanModal = openInvestPlanModal;

$('#investPlanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['own_amount', 'employer_amount']);
  const id = f.id; delete f.id;
  if (f.employer_amount === '') f.employer_amount = null;
  try {
    if (id) await api(`/api/investments/plans/${id}`, { method: 'PUT', body: f });
    else await api(`/api/investments/accounts/${investAccountData.account.id}/plans`, { method: 'POST', body: f });
    closeModalEl($('#investPlanModal'));
    loadInvestAccount(investAccountData.account.id);
  } catch (err) { showMsg($('#investPlanModalMsg'), 'err', err.message); }
});

async function generateInvestPlan(id) {
  await api(`/api/investments/plans/${id}/generate`, { method: 'POST' });
  loadInvestAccount(investAccountData.account.id);
}
window.generateInvestPlan = generateInvestPlan;

async function deleteInvestPlan(id) {
  if (!confirm('Delete this plan? Its generated buy events stay as ordinary history.')) return;
  await api(`/api/investments/plans/${id}`, { method: 'DELETE' });
  loadInvestAccount(investAccountData.account.id);
}
window.deleteInvestPlan = deleteInvestPlan;

async function deleteInvestAccount(id) {
  if (!confirm('Delete this account and all its holdings and events?')) return;
  await api(`/api/investments/accounts/${id}`, { method: 'DELETE' });
  location.hash = '#assets/investments';
}
window.deleteInvestAccount = deleteInvestAccount;

async function deleteInvestHolding(id) {
  if (!confirm('Delete this holding and all its events?')) return;
  await api(`/api/investments/holdings/${id}`, { method: 'DELETE' });
  if (location.hash.startsWith('#invest-holding/')) location.hash = `#invest-account/${currentInvestAccountId}`;
  else if (currentInvestAccountId) loadInvestAccount(currentInvestAccountId);
}
window.deleteInvestHolding = deleteInvestHolding;

// A split event's ratio as recorded — "3:1", "1:2" — trimming
// float dust off the stored sides.
function splitRatioText(e) {
  const t = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '?';
    return String(Number.isInteger(n) ? n : Math.round(n * 10000) / 10000);
  };
  return `${t(e.split_new ?? e.splitNew)}:${t(e.split_old ?? e.splitOld)}`;
}

// --------------------------------------------------------- holding level
async function loadInvestHoldingImpl(id) {
  const wanted = investDisplay.investHolding; // null = the server's default for this holding (its own currency)
  const data = await api(`/api/investments/holdings/${id}${wanted ? `?display=${wanted}` : ''}`);
  const display = data.display || 'CAD';
  investDisplay.investHolding = display;
  investHoldingData = data;
  const h = data.holding;
  const sm = data.summary;
  currentInvestAccountId = h.account_id;
  // Same once-bound static toolbar button as the account page.
  investDisplayHoldingId = id;
  const dispBtn = $('#investHoldingDisplayBtn');
  if (dispBtn) {
    dispBtn.textContent = investDisplayLabel(display);
    if (!dispBtn.dataset.wired) {
      dispBtn.dataset.wired = '1';
      dispBtn.addEventListener('click', () => {
        investDisplay.investHolding = investDisplay.investHolding === 'CAD' ? 'USD' : 'CAD';
        loadInvestHoldingImpl(investDisplayHoldingId);
      });
    }
  }
  $('#investHoldingBack').href = `#invest-account/${h.account_id}`;
  $('#investHoldingBack').textContent = `← Back to ${data.account ? data.account.name : 'account'}`;
  $('#investHoldingTitle').innerHTML =
    `${esc(h.label)}${aiBadge(h.source)} ${currencyBadge(h.currency)} <span class="note" style="margin:0">${h.kind === 'fund' ? 'Mutual fund' : 'Exchange'}${h.symbol ? ` · ${esc(h.symbol)}` : ''}${h.fund_code ? ` · ${esc(h.fund_code)}` : ''} · ${esc(data.account ? data.account.name : '')}</span>`;
  // Value cards follow the display currency; the per-unit price
  // and the event/NAV tables below stay native (recorded
  // figures, not converted values). The sub-line names the
  // native figure whenever it differs from the display one.
  $('#investHoldingStats').innerHTML = `
    <div class="summary-card"><div class="k">Units</div><div class="v">${fmtUnits(sm.units)}</div></div>
    <div class="summary-card"><div class="k">Latest price (${h.currency})</div><div class="v">${sm.latestPrice != null ? moneyC(sm.latestPrice, h.currency) : '—'}</div><div class="n">${sm.latestPriceDate ? `${esc(sm.latestPriceDate)} · ${esc({ stooq: 'Stooq', yahoo: 'Yahoo Finance', nasdaq: 'Nasdaq', manual: 'manual NAV', event: 'trade price' }[sm.latestPriceSource] || sm.latestPriceSource || '')}` : 'no price yet'}</div></div>
    <div class="summary-card"><div class="k">Current value (${display})</div><div class="v">${moneyC(sm.value, display)}</div><div class="n">${display !== h.currency ? `${moneyC(sm.valueNative, h.currency)} native` : ''}</div></div>
    <div class="summary-card"><div class="k">Total return (${display})</div><div class="v">${sm.costUnknown ? '—' : returnText(sm.totalReturn, sm.totalReturnPctNative, display)}</div><div class="n">contributions ${moneyC(sm.contributions, display)}${sm.costUnknown ? ` · ${fmtUnits(sm.unknownCostUnits)} units with unknown cost` : ''}</div></div>`;
  const st = data.priceStatus;
  const notes = [];
  if (st.pricedBy === 'none') notes.push('No price yet: this holding values at 0 until a priced event or a price snapshot exists.');
  if (st.pricedBy === 'event') notes.push(h.kind === 'fund'
    ? 'Priced from trade prices (no market feed for this holding): the value walks flat between trades. For a bank fund, record NAV snapshots below to trace its real path.'
    : `No market feed found for ${h.symbol || h.label} — value walks flat between trades.`);
  if (st.stale) notes.push(`Market prices may be stale (last fetched ${esc(st.lastFetchedDate || '—')}).`);
  if (st.fetchFailedToday) notes.push(`Market price fetch failed (${esc(st.lastError)}) — last attempt ${esc(st.lastAttemptAt || '—')}.`);
  if (sm.unpricedGrants) notes.push(`${sm.unpricedGrants} grant(s) had no price on their date and count as $0 contributions.`);
  if (sm.costUnknown) notes.push('Cost unknown — gain is not shown: replace the position record(s) with actual buy records when available.');
  if (data.fxMissing && h.currency !== display) notes.push(`USD/CAD rates are unavailable right now — ${display} figures show the unconverted amounts.`);
  const noteEl = $('#investHoldingPriceNote');
  noteEl.classList.toggle('hidden', !notes.length);
  noteEl.innerHTML = notes.map(esc).join('<br>');
  investViewData.investHolding = { series: data.series, monthly: data.monthly, cur: display, nativePct: true, gainUnknown: !!sm.costUnknown };
  applyInvestRange('investHolding');
  const typeLabels = { buy: 'Buy', sell: 'Sell', grant: 'Grant', dividend: 'Dividend', split: 'Split', position: 'Position' };
  const rows = data.events.map((e) => `<tr>
      <td>${esc(e.date)}</td><td>${e.type === 'split' ? `Split · ${splitRatioText(e)}` : (typeLabels[e.type] || esc(e.type))}${aiBadge(e.source)}${e.own_amount != null ? `<div class="note" style="margin:0">Own ${moneyC(e.own_amount, h.currency)}${e.employer_amount ? ` · Employer ${moneyC(e.employer_amount, h.currency)}` : ''}</div>` : ''}</td>
      <td class="num">${e.units != null ? fmtUnits(e.units) : '—'}</td>
      <td class="num">${e.price != null ? moneyC(e.price, h.currency) : (e.type === 'grant' ? '<span class="note" style="margin:0">market</span>' : '—')}</td>
      <td class="num">${e.amount != null ? moneyC(e.amount, h.currency) : '—'}</td>
      <td>${esc(e.note || '')}</td>
      <td style="white-space:nowrap">
        <button class="small" onclick="editInvestEvent(${e.id})">Edit</button>
        <button class="small danger" onclick="deleteInvestEvent(${e.id})">Delete</button>
      </td></tr>`).join('');
  $('#investEventsWrap').innerHTML = data.events.length
    ? `<table><thead><tr><th>Date</th><th>Type</th><th class="num">Units</th><th class="num">Price</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="note">No events yet — record the first buy or grant below.</div>';
  resetInvestEventForm();
  // NAV / price snapshots.
  $('#investNavTitle').textContent = h.kind === 'fund' ? 'NAV snapshots' : 'Price snapshots';
  $('#investNavNote').textContent = h.kind === 'fund'
    ? 'Bank funds have no public price feed here — record the fund\'s NAV from your statement and the charts trace it. Between snapshots the last NAV carries forward.'
    : 'Exchange prices are fetched automatically; a snapshot you add here outranks the fetched close on its date (a hand correction).';
  $('#investNavPriceLabel').textContent = h.kind === 'fund' ? 'NAV / unit' : 'Price / unit';
  const navRows = data.navPoints.map((p) => `<tr data-nav-row="${p.id}"><td>${esc(p.date)}</td>
      <td class="num">${moneyC(p.price, h.currency)}</td>
      <td><button class="small" onclick="editInvestNav(${p.id})">Edit</button> <button class="small danger" onclick="deleteInvestNav(${p.id})">Delete</button></td></tr>`).join('');
  $('#investNavWrap').innerHTML = data.navPoints.length
    ? `<table><thead><tr><th>Date</th><th class="num">${h.kind === 'fund' ? 'NAV' : 'Price'}</th><th></th></tr></thead><tbody>${navRows}</tbody></table>`
    : '<div class="note">No snapshots yet.</div>';
  $('#editInvestHoldingBtn').onclick = () => openInvestHoldingModal(id);
  $('#deleteInvestHoldingBtn').onclick = () => deleteInvestHolding(id);
}

function resetInvestEventForm() {
  const form = $('#investEventForm');
  form.reset();
  form.elements.id.value = '';
  $('#investEventSubmit').textContent = 'Add event';
  $('#investEventCancel').classList.add('hidden');
  syncInvestEventFields();
}
function syncInvestEventFields() {
  const type = $('#investEventForm').elements.type.value;
  const isDiv = type === 'dividend';
  const isSplit = type === 'split';
  const isPos = type === 'position';
  document.querySelector('[data-ev-units]').classList.toggle('hidden', isDiv || isSplit);
  document.querySelector('[data-ev-price]').classList.toggle('hidden', isDiv || isSplit || isPos);
  document.querySelector('[data-ev-amount]').classList.toggle('hidden', !isDiv);
  document.querySelector('[data-ev-split]').classList.toggle('hidden', !isSplit);
  document.querySelector('[data-ev-derive]').classList.toggle('hidden', !isPos);
  $('#investEventForm').elements.price.placeholder = type === 'grant' ? 'blank = market' : '';
}
$('#investEventForm').elements.type.addEventListener('change', syncInvestEventFields);
// Value ÷ NAV helper: the only arithmetic the cost-unknown
// path allows — both inputs are observed figures, so the
// quotient is exact, never an invented price.
document.querySelector('#investEventDeriveBtn').addEventListener('click', () => {
  const form = $('#investEventForm');
  const v = parseMoneyInput(form.elements.deriveValue.value);
  const n = parseMoneyInput(form.elements.deriveNav.value);
  const msg = $('#investEventMsg');
  if (v === '' || n === '' || !(Number(v) > 0) || !(Number(n) > 0)) {
    showMsg(msg, 'err', 'Enter a total value and a NAV per unit, both above 0.');
    return;
  }
  form.elements.units.value = String(Math.round((Number(v) / Number(n)) * 10000) / 10000);
  msg.textContent = ''; msg.className = 'msg';
});
$('#investEventCancel').addEventListener('click', resetInvestEventForm);

function editInvestEvent(id) {
  const e = (investHoldingData.events || []).find((x) => x.id === id);
  if (!e) return;
  const form = $('#investEventForm');
  form.elements.id.value = e.id;
  form.elements.date.value = e.date;
  form.elements.type.value = e.type;
  form.elements.units.value = e.units ?? '';
  setMoneyValue(form.elements.price, e.price);
  setMoneyValue(form.elements.amount, e.amount);
  form.elements.splitNew.value = e.split_new ?? '';
  form.elements.splitOld.value = e.split_old ?? '';
  form.elements.note.value = e.note || '';
  syncInvestEventFields();
  $('#investEventSubmit').textContent = 'Save event';
  $('#investEventCancel').classList.remove('hidden');
}
window.editInvestEvent = editInvestEvent;

async function deleteInvestEvent(id) {
  if (!confirm('Delete this event?')) return;
  await api(`/api/investments/events/${id}`, { method: 'DELETE' });
  loadInvestHolding(currentInvestHoldingId);
}
window.deleteInvestEvent = deleteInvestEvent;

$('#investEventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form).entries());
  parseMoneyFields(f, ['price', 'amount']);
  const id = f.id; delete f.id;
  if (f.type === 'dividend') { f.units = null; f.price = null; f.splitNew = null; f.splitOld = null; }
  else if (f.type === 'split') {
    f.units = null; f.price = null; f.amount = null;
    f.splitNew = f.splitNew === '' || f.splitNew == null ? null : Number(f.splitNew);
    f.splitOld = f.splitOld === '' || f.splitOld == null ? null : Number(f.splitOld);
  } else if (f.type === 'position') {
    // A position never carries a price — drop anything the
    // hidden price input still holds from another type.
    f.price = null; f.amount = null; f.splitNew = null; f.splitOld = null;
    if (f.units === '') f.units = null;
  } else {
    f.amount = null; f.splitNew = null; f.splitOld = null;
    if (f.units === '') f.units = null; if (f.price === '') f.price = null;
  }
  if (!f.note) f.note = null;
  // The derive helper's inputs are form-only, never submitted.
  delete f.deriveValue; delete f.deriveNav;
  try {
    if (id) await api(`/api/investments/events/${id}`, { method: 'PUT', body: f });
    else await api(`/api/investments/holdings/${currentInvestHoldingId}/events`, { method: 'POST', body: f });
    loadInvestHolding(currentInvestHoldingId);
  } catch (err) { showMsg($('#investEventMsg'), 'err', err.message); }
});

$('#investNavForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  parseMoneyFields(f, ['price']);
  try {
    await api(`/api/investments/holdings/${currentInvestHoldingId}/nav`, { method: 'POST', body: f });
    loadInvestHolding(currentInvestHoldingId);
  } catch (err) { showMsg($('#investNavMsg'), 'err', err.message); }
});

async function deleteInvestNav(id) {
  if (!confirm('Delete this price snapshot?')) return;
  await api(`/api/investments/prices/${id}`, { method: 'DELETE' });
  loadInvestHolding(currentInvestHoldingId);
}
window.deleteInvestNav = deleteInvestNav;

// Inline row edit. The price input is prefilled with the stored
// full-precision figure (p.price), never the row's rounded 2dp
// display — saving a rounded display value would corrupt a 4dp
// NAV. A failed save leaves the row in edit mode so the error
// can be fixed in place; Cancel reloads the holding, restoring
// the row unchanged.
function editInvestNav(id) {
  const p = (investHoldingData.navPoints || []).find((x) => x.id === id);
  const row = document.querySelector(`[data-nav-row="${id}"]`);
  if (!p || !row) return;
  row.innerHTML = `<td><input type="date" data-nav-date value="${esc(p.date)}"></td>
      <td class="num"><input type="text" inputmode="decimal" data-money data-nav-price value="${esc(String(p.price))}" style="width:140px"></td>
      <td><button class="small" onclick="saveInvestNav(${p.id})">Save</button> <button class="small" onclick="cancelInvestNav()">Cancel</button></td>`;
  row.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
}
window.editInvestNav = editInvestNav;

async function saveInvestNav(id) {
  const row = document.querySelector(`[data-nav-row="${id}"]`);
  if (!row) return;
  const date = row.querySelector('[data-nav-date]').value;
  const price = parseMoneyInput(row.querySelector('[data-nav-price]').value);
  try {
    await api(`/api/investments/prices/${id}`, { method: 'PUT', body: { date, price } });
    loadInvestHolding(currentInvestHoldingId);
  } catch (err) { showMsg($('#investNavMsg'), 'err', err.message); }
}
window.saveInvestNav = saveInvestNav;

function cancelInvestNav() { loadInvestHolding(currentInvestHoldingId); }
window.cancelInvestNav = cancelInvestNav;

// ------------------------------------------------------------ modals
function openInvestAccountModal(id) {
  const form = $('#investAccountForm');
  form.reset();
  investAccountOwnerPicker.set([]);
  $('#investAccountModalMsg').className = 'msg';
  form.elements.id.value = id || '';
  $('#investAccountModalTitle').textContent = id ? 'Edit account' : 'Add account';
  if (id) {
    const a = (investAccountData && investAccountData.account.id === id)
      ? investAccountData.account : null;
    const fill = (acc) => {
      form.elements.name.value = acc.name || '';
      form.elements.type.value = acc.type || 'NonRegistered';
      form.elements.institution.value = acc.institution || '';
      form.elements.note.value = acc.note || '';
      // The stored setting, not the derived one: an account on
      // Auto shows Auto (''), even though its page opens in the
      // derived currency — saving must not silently lock the
      // derivation in.
      form.elements.defaultCurrency.value = acc.default_currency || '';
      investAccountOwnerPicker.set(acc.owners || []);
    };
    if (a) fill(a);
    else api(`/api/investments/accounts/${id}`).then((d) => fill(d.account)).catch((err) => alert(err.message));
  }
  openModal('investAccountModal');
}
window.openInvestAccountModal = openInvestAccountModal;

$('#investAccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const id = f.id; delete f.id;
  f.owners = investAccountOwnerPicker.get();
  try {
    if (id) {
      await api(`/api/investments/accounts/${id}`, { method: 'PUT', body: f });
      closeModalEl($('#investAccountModal'));
      if (location.hash.startsWith('#invest-account/')) loadInvestAccount(Number(id));
      else loadInvestments();
    } else {
      const created = await api('/api/investments/accounts', { method: 'POST', body: f });
      closeModalEl($('#investAccountModal'));
      location.hash = `#invest-account/${created.id}`;
    }
  } catch (err) { showMsg($('#investAccountModalMsg'), 'err', err.message); }
});

// --------------------------------- holding initial transactions
// The Add Holding form's optional initial-transactions block:
// event rows created together with the holding (the server
// validates the batch and writes it atomically). Rows are plain
// DOM read back at submit: an untouched row is skipped, a
// half-filled one goes to the server as-is and its error comes
// back in the modal. Once created, the events are ordinary
// detail-page events — editable and deletable like any other.
function investInitRow() {
  const row = document.createElement('div');
  row.className = 'init-event-row';
  row.setAttribute('data-init-row', '');
  row.innerHTML = `
    <label class="f-type">Type<select data-f="type">
      <option value="buy">Buy</option><option value="sell">Sell</option>
      <option value="grant">Grant</option><option value="dividend">Dividend</option>
      <option value="split">Split</option>
      <option value="position">Position (cost unknown)</option>
    </select></label>
    <label class="f-date">Date<input type="date" data-f="date"></label>
    <label class="f-num" data-num>Units<input data-f="units" inputmode="decimal" autocomplete="off"></label>
    <label class="f-num" data-num data-price>Price<input data-f="price" inputmode="decimal" autocomplete="off"></label>
    <label class="f-num hidden" data-amt>Amount<input data-f="amount" inputmode="decimal" autocomplete="off"></label>
    <label class="f-num hidden" data-split>New : Old<span style="display:flex;gap:4px;align-items:center"><input data-f="splitNew" inputmode="decimal" autocomplete="off" style="width:52px"><span>:</span><input data-f="splitOld" inputmode="decimal" autocomplete="off" style="width:52px"></span></label>
    <button type="button" class="small danger f-x" data-remove-init-row title="Remove row">×</button>`;
  const type = row.querySelector('[data-f="type"]');
  const sync = () => {
    const div = type.value === 'dividend';
    const split = type.value === 'split';
    const pos = type.value === 'position';
    row.querySelectorAll('[data-num]').forEach((el) => el.classList.toggle('hidden', div || split));
    row.querySelector('[data-price]').classList.toggle('hidden', div || split || pos);
    row.querySelector('[data-amt]').classList.toggle('hidden', !div);
    row.querySelector('[data-split]').classList.toggle('hidden', !split);
  };
  type.addEventListener('change', sync);
  sync();
  row.querySelector('[data-remove-init-row]').addEventListener('click', () => row.remove());
  return row;
}
function resetInvestInitRows() {
  const host = $('#investHoldingForm [data-init-rows]');
  host.innerHTML = '';
  host.appendChild(investInitRow());
}
function collectInvestInitEvents() {
  const events = [];
  document.querySelectorAll('#investHoldingForm [data-init-row]').forEach((row) => {
    const val = (f) => row.querySelector(`[data-f="${f}"]`).value.trim();
    const type = val('type');
    const date = val('date');
    const units = val('units');
    const price = val('price');
    const amount = val('amount');
    const splitNew = val('splitNew');
    const splitOld = val('splitOld');
    const touched = type === 'dividend' ? (date || amount)
      : type === 'split' ? (date || splitNew || splitOld)
        : (date || units || price);
    if (!touched) return;
    const ev = { type, date };
    if (type === 'dividend') { if (amount) ev.amount = Number(amount); }
    else if (type === 'split') {
      if (splitNew) ev.splitNew = Number(splitNew);
      if (splitOld) ev.splitOld = Number(splitOld);
    } else {
      if (units) ev.units = Number(units);
      if (price) ev.price = Number(price);
    }
    events.push(ev);
  });
  return events;
}
$('#investHoldingForm [data-add-init-row]').addEventListener('click', () => {
  $('#investHoldingForm [data-init-rows]').appendChild(investInitRow());
});

function openInvestHoldingModal(id) {
  const form = $('#investHoldingForm');
  form.reset();
  $('#investHoldingModalMsg').className = 'msg';
  form.elements.id.value = id || '';
  $('#investHoldingModalTitle').textContent = id ? 'Edit holding' : 'Add holding';
  // Initial transactions only exist when creating a holding.
  $('#investInitEvents').classList.toggle('hidden', !!id);
  if (!id) resetInvestInitRows();
  if (id) {
    const rows = investAccountData ? investAccountData.holdings : [];
    const row = rows.find((r) => r.holding.id === id)
      || (investHoldingData && investHoldingData.holding.id === id ? { holding: investHoldingData.holding } : null);
    if (row) {
      const h = row.holding;
      form.elements.label.value = h.label || '';
      form.elements.kind.value = h.kind || 'exchange';
      form.elements.symbol.value = h.symbol || '';
      form.elements.fundCode.value = h.fund_code || '';
      form.elements.currency.value = h.currency || 'CAD';
    }
  }
  openModal('investHoldingModal');
}
window.openInvestHoldingModal = openInvestHoldingModal;

$('#investHoldingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const id = f.id; delete f.id;
  if (!f.symbol) f.symbol = null;
  if (!f.fundCode) f.fundCode = null;
  try {
    if (id) await api(`/api/investments/holdings/${id}`, { method: 'PUT', body: f });
    else {
      const events = collectInvestInitEvents();
      if (events.length) f.events = events;
      await api(`/api/investments/accounts/${currentInvestAccountId}/holdings`, { method: 'POST', body: f });
    }
    closeModalEl($('#investHoldingModal'));
    if (location.hash.startsWith('#invest-holding/') && id) loadInvestHolding(Number(id));
    else if (currentInvestAccountId) loadInvestAccount(currentInvestAccountId);
  } catch (err) { showMsg($('#investHoldingModalMsg'), 'err', err.message); }
});

// --------------------------------------------- investments AI fill chat
// The account page's conversation, the costs chat's sibling:
// the model drafts NEW HOLDINGS and EVENTS for this one account
// from statements / grant notices, asks whenever a currency, a
// fund-vs-ETF call, a grant-vs-buy call or a date is unclear,
// and writes nothing itself — Apply creates the confirmed draft
// through the investments POST endpoints with source 'ai'.
// Proposals that duplicate what is already recorded arrive
// flagged (the server marks them) and start unchecked. The
// conversation lives in this page session only; switching
// accounts or Clear session resets it.
let investChatState = { turns: [], proposed: { holdings: [], events: [], nav: [] } };
let investChatDropped = []; // items the last AI round did not turn into proposals, with reasons
let investChatAccountId = null;
let investChatQueue = [];
let investImportMode = false; // the proposed panel holds a CSV import preview, not an AI draft
let investImportReport = null; // { holdings, events, skipped, skippedByType, duplicates } counts for the preview header
let investImportSource = 'csv'; // 'csv' for Wealthsimple imports, 'csv-ai' for AI-mapped imports
// AI-mapped CSV import: the file text and the mapping being
// confirmed survive between the analyze and preview calls.
let investMapCsv = null;
let investMapStructure = null;
let investMapMapping = null;
let investMapQuestions = [];
let investMapReply = '';
let investMapFollowupReply = ''; // latest follow-up reply, shown under the preview
let investMapFollowupHistory = []; // [{ message, reply }] prior follow-up turns, sent as context
let investMapReused = false;
let investMapValueList = []; // raw activity values listed in the editor, in row order
let investMapPairValues = []; // pair-mode step-4 keys (raw "type / subtype"), from the server
let investMapPairLabels = []; // pair-mode display labels (blank parts as '-'), same order
let investMapPairTruncated = false; // more distinct pairs exist than the list shows
let investMapPairCount = 0; // total distinct pairs in the file
let investMapPairLoaded = false; // pair list is in sync with the activity columns (confirm guard)
let investMapPairSeq = 0; // pair-list fetch generation, so a stale reply cannot overwrite a newer one
let investMapWizard = null; // wizard step state for the mapping editor
let investImportGroupBy = 'type'; // proposed-panel grouping in import mode: type | symbol | month

function clearInvestChatMsg() {
  const msg = document.querySelector('[data-invest-chat-msg]');
  if (msg) { msg.textContent = ''; msg.className = 'msg'; }
}

function renderInvestChatQueue() {
  const host = document.querySelector('[data-invest-chat-queue]');
  if (!host) return;
  host.classList.toggle('hidden', !investChatQueue.length);
  host.innerHTML = investChatQueue.map((f, i) =>
    `<span class="file-chip"><span class="chip-name">${esc(f.name || 'attachment')}</span><button type="button" data-invest-chat-queue-remove="${i}" title="Remove">×</button></span>`).join('');
  syncInvestChatClearBtn();
}

function resetInvestChat(accountId) {
  investChatState = { turns: [], proposed: { holdings: [], events: [], nav: [] } };
  investChatDropped = [];
  investChatAccountId = accountId;
  investChatQueue = [];
  investImportMode = false;
  investImportReport = null;
  investImportSource = 'csv';
  investMapCsv = null;
  investMapStructure = null;
  investMapMapping = null;
  investMapQuestions = [];
  investMapReply = '';
  investMapFollowupReply = '';
  investMapFollowupHistory = [];
  investMapReused = false;
  investMapValueList = [];
  investMapPairValues = []; investMapPairLabels = [];
  investMapPairTruncated = false; investMapPairCount = 0; investMapPairLoaded = false;
  investMapWizard = null; investImportGroupBy = 'type';
  const mapHost = document.querySelector('[data-invest-map-editor]');
  if (mapHost) mapHost.innerHTML = '';
  renderInvestChatQueue();
  const log = document.querySelector('[data-invest-chat-log]');
  if (log) { log.innerHTML = ''; log.classList.add('hidden'); }
  const ta = document.querySelector('[data-invest-chat-text]');
  if (ta) ta.value = '';
  const files = document.querySelector('[data-invest-chat-files]');
  if (files) files.value = '';
  clearInvestChatMsg();
  renderInvestProposed();
  syncInvestChatClearBtn();
}

function syncInvestChatClearBtn() {
  const btn = document.querySelector('[data-invest-chat-clear]');
  if (!btn) return;
  const p = investChatState.proposed;
  btn.classList.toggle('hidden',
    !(investChatState.turns.length || p.holdings.length || p.events.length || (p.nav && p.nav.length) || investChatQueue.length || investChatDropped.length));
}

function investChatLogHtml() {
  return investChatState.turns.map((t) => `<div class="costs-chat-turn ${t.role}">
    <span class="who">${t.role === 'user' ? 'You' : 'AI'}</span>${esc(t.content)}</div>`).join('');
}

function renderInvestChatLog(pendingText) {
  const log = document.querySelector('[data-invest-chat-log]');
  if (!log) return;
  syncInvestChatClearBtn();
  const has = investChatState.turns.length > 0 || pendingText;
  log.classList.toggle('hidden', !has);
  log.innerHTML = investChatLogHtml()
    + (pendingText ? `<div class="costs-chat-turn user pending"><span class="who">You</span>${esc(pendingText)}</div>` : '');
  log.scrollTop = log.scrollHeight;
}

const investTargetOptions = (sel) => {
  const existing = (investAccountData ? investAccountData.holdings : []).map((r) =>
    `<option value="id:${r.holding.id}"${sel === `id:${r.holding.id}` ? ' selected' : ''}>${esc(r.holding.label)} (${esc(r.holding.currency)})</option>`);
  const draft = investChatState.proposed.holdings.map((h) =>
    `<option value="ref:${esc(h.ref)}"${sel === `ref:${h.ref}` ? ' selected' : ''}>New: ${esc(h.label || h.ref)}</option>`);
  return [...existing, ...draft].join('');
};

// Import-preview grouping: many transactions browse better
// grouped than flat. Grouping is a view only — rows keep their
// own checkboxes and Apply reads them directly, so grouping
// never changes what Apply writes; a group header checkbox is
// just a shortcut that toggles its whole group.
const investFmtUnits = (n) => {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
};
const investFmtMoney = (n) => {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return null;
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const investEventSymbol = (e) => {
  if (e.holdingRef) {
    const h = investChatState.proposed.holdings.find((x) => x.ref === e.holdingRef);
    if (h) return h.symbol || h.label || '(no symbol)';
  }
  if (e.holdingId != null && investAccountData) {
    const r = investAccountData.holdings.find((x) => x.holding.id === e.holdingId);
    if (r) return r.holding.symbol || r.holding.label || '(no symbol)';
  }
  return '(no symbol)';
};
const investEventSentence = (e, symbol) => {
  const date = e.date || '(no date)';
  const sym = symbol || '(no symbol)';
  if (e.type === 'dividend') return `${date} · Dividend · ${sym} · ${investFmtMoney(e.amount) || '(no amount)'}`;
  if (e.type === 'split') return (e.splitNew != null && e.splitOld != null)
    ? `${date} · Split · ${sym} · ${investFmtUnits(e.splitNew)}:${investFmtUnits(e.splitOld)}`
    : `${date} · Split · ${sym} · (no ratio)`;
  if (e.type === 'position') {
    const units = investFmtUnits(e.units);
    return `${date} · Position · ${sym} · ${units != null ? `${units} units` : '(no units)'} (cost unknown)${e.note ? ` — ${e.note}` : ''}`;
  }
  const action = e.type === 'buy' ? 'Buy' : e.type === 'sell' ? 'Sell' : 'Grant';
  const units = investFmtUnits(e.units);
  let pricePart = '';
  if (e.price != null && e.price !== '' && Number(e.price) > 0) pricePart = ` @ ${investFmtMoney(e.price)}`;
  else if (e.type !== 'grant') pricePart = ' @ (no price)';
  return `${date} · ${action} · ${sym} · ${units != null ? `${units} units` : '(no units)'}${pricePart}`;
};
const investGroupEvents = (events) => {
  const groups = new Map();
  const keyOf = (e) => {
    if (investImportGroupBy === 'symbol') return investEventSymbol(e);
    if (investImportGroupBy === 'month') return (e.date || '').slice(0, 7) || '(no date)';
    return e.type === 'buy' ? 'Buy' : e.type === 'sell' ? 'Sell' : e.type === 'grant' ? 'Grant' : e.type === 'dividend' ? 'Dividend' : e.type === 'position' ? 'Position' : 'Split';
  };
  events.forEach((e, i) => {
    const key = keyOf(e);
    if (!groups.has(key)) groups.set(key, { key, indices: [], units: 0, div: 0 });
    const g = groups.get(key);
    g.indices.push(i);
    if ((e.type === 'buy' || e.type === 'sell' || e.type === 'grant' || e.type === 'position') && Number.isFinite(Number(e.units))) g.units += Math.abs(Number(e.units));
    if (e.type === 'dividend' && Number.isFinite(Number(e.amount))) g.div += Number(e.amount);
  });
  const order = investImportGroupBy === 'type'
    ? ['Buy', 'Sell', 'Grant', 'Dividend', 'Position', 'Split']
    : [...groups.keys()].sort();
  return order.filter((k) => groups.has(k)).map((k) => groups.get(k));
};
const investGroupTotals = (g) => {
  const bits = [`${g.indices.length} rows`];
  if (g.units) bits.push(`${investFmtUnits(g.units)} units`);
  if (g.div) bits.push(investFmtMoney(g.div));
  return bits.join(' · ');
};
const syncInvestGroupChecks = (host) => {
  host.querySelectorAll('[data-ie-group]').forEach((group) => {
    const key = group.dataset.ieGroup;
    const head = group.querySelector('[data-ie-group-check]');
    const rows = [...group.querySelectorAll('[data-ie-check]')];
    if (!head || !rows.length) return;
    const checked = rows.filter((c) => c.checked).length;
    head.checked = checked === rows.length;
    head.indeterminate = checked > 0 && checked < rows.length;
  });
};

function renderInvestProposed() {
  const host = document.querySelector('[data-invest-proposed]');
  if (!host) return;
  syncInvestChatClearBtn();
  const { holdings, events, nav = [] } = investChatState.proposed;
  // The dropped-items warning is functional, not decorative: it
  // is the only place a user learns a statement line never
  // became a proposal, so it renders even when nothing else
  // survived the round.
  const droppedHtml = investChatDropped.length
    ? `<div class="msg warn">Not included from the statement (${investChatDropped.length}): ${investChatDropped.map((d) => `${esc(d.summary)} — ${esc(d.reason)}`).join('; ')}</div>`
    : '';
  const reportHtml = investImportReport
    ? `<div class="note">CSV import preview: ${investImportReport.holdings} new holdings, ${investImportReport.events} events · Skipped ${investImportReport.skipped} cash rows${investImportReport.skippedByType && Object.keys(investImportReport.skippedByType).length ? ` (${Object.entries(investImportReport.skippedByType).map(([t, n]) => `${esc(t)} ${n}`).join(', ')})` : ''} · Already recorded: ${investImportReport.duplicates}</div>`
    : '';
  if (!holdings.length && !events.length && !nav.length) { host.innerHTML = reportHtml + droppedHtml; return; }
  const holdingRows = holdings.map((h, i) => `
    <div class="costs-proposed-row${h.conflict ? ' conflict' : ''}" data-ih-row="${i}">
      <input type="checkbox" data-ih-check${h.conflict ? '' : ' checked'}>
      <input type="text" class="p-cat" data-ih-label value="${esc(h.label)}" placeholder="Label">
      <select data-ih-kind>
        <option value="exchange"${h.kind === 'exchange' ? ' selected' : ''}>Exchange</option>
        <option value="fund"${h.kind === 'fund' ? ' selected' : ''}>Fund</option>
      </select>
      <input type="text" data-ih-symbol value="${esc(h.symbol || '')}" placeholder="Symbol (XQQ.TO)" style="width:120px">
      <input type="text" data-ih-fundcode value="${esc(h.fundCode || '')}" placeholder="Fund code" style="width:100px">
      <select data-ih-currency>
        <option value="CAD"${h.currency === 'CAD' ? ' selected' : ''}>CAD</option>
        <option value="USD"${h.currency === 'USD' ? ' selected' : ''}>USD</option>
      </select>
      ${h.conflict ? '<span class="conflict-tag">Looks like a holding already in this account — applies only if checked</span>' : ''}
      <button type="button" class="small danger" data-ih-remove title="Remove">×</button>
    </div>`).join('');
  const ieChecked = (e) => (e.checked != null ? e.checked : !e.conflict) ? ' checked' : '';
  const investEventInputs = (e, sel) => `
      <select data-ie-target>${investTargetOptions(sel)}</select>
      <input type="date" data-ie-date value="${esc(e.date || '')}">
      <select data-ie-type>
        ${['buy', 'sell', 'grant', 'dividend', 'split', 'position'].map((t) => `<option value="${t}"${e.type === t ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
      </select>
      <input type="text" inputmode="decimal" data-ie-units value="${e.units ?? ''}" placeholder="Units" style="width:84px">
      <input type="text" inputmode="decimal" data-money data-ie-price value="${esc(formatMoneyInput(e.price ?? ''))}" placeholder="Price" style="width:110px">
      <input type="text" inputmode="decimal" data-money data-ie-amount value="${esc(formatMoneyInput(e.amount ?? ''))}" placeholder="Dividend $" style="width:110px">
      <input type="text" inputmode="decimal" data-ie-splitnew value="${e.splitNew ?? ''}" placeholder="Split new" title="Split ratio — new side" style="width:76px">
      <input type="text" inputmode="decimal" data-ie-splitold value="${e.splitOld ?? ''}" placeholder="Split old" title="Split ratio — old side" style="width:76px">`;
  const eventRows = events.map((e, i) => {
    const sel = e.holdingId != null ? `id:${e.holdingId}` : `ref:${e.holdingRef}`;
    return `
    <div class="costs-proposed-row${e.conflict ? ' conflict' : ''}" data-ie-row="${i}">
      <input type="checkbox" data-ie-check${ieChecked(e)}>
      ${investEventInputs(e, sel)}
      ${e.priceDerived ? '<span class="note">Price derived from total amount</span>' : ''}
      ${e.type === 'position' ? '<span class="note">Cost unknown — no price on this record</span>' : ''}
      ${e.type === 'position' && e.note ? `<span class="note">${esc(e.note)}</span>` : ''}
      ${e.conflict ? '<span class="conflict-tag">Same event already recorded — applies only if checked</span>' : ''}
      <button type="button" class="small danger" data-ie-remove title="Remove">×</button>
    </div>`;
  }).join('');
  // NAV snapshots are observations, not transactions: their own
  // flat section (no grouping — a price series browses by date,
  // and CSV import never produces them).
  const navRows = nav.map((n, i) => {
    const sel = n.holdingId != null ? `id:${n.holdingId}` : `ref:${n.holdingRef}`;
    const conflictTag = !n.conflict ? ''
      : n.conflict === 'nav-differs'
        ? `<span class="conflict-tag">NAV already recorded: ${investFmtMoney(n.oldPrice)} → ${investFmtMoney(n.price)} — applies only if checked</span>`
        : '<span class="conflict-tag">Same NAV already recorded — applies only if checked</span>';
    return `
    <div class="costs-proposed-row${n.conflict ? ' conflict' : ''}" data-in-row="${i}">
      <input type="checkbox" data-in-check${ieChecked(n)}>
      <select data-in-target>${investTargetOptions(sel)}</select>
      <input type="date" data-in-date value="${esc(n.date || '')}">
      <input type="text" inputmode="decimal" data-money data-in-price value="${esc(formatMoneyInput(n.price ?? ''))}" placeholder="NAV / unit" style="width:110px">
      ${conflictTag}
      <button type="button" class="small danger" data-in-remove title="Remove">×</button>
    </div>`;
  }).join('');
  // Import mode rows read as sentences first (browsing) with the
  // inputs one Edit click away (editing preserved). Grouped by
  // type by default, or by symbol / month; groups start
  // collapsed with count + totals on the header, and a header
  // checkbox toggles the whole group.
  const investImportEventRow = (e, i) => {
    const sel = e.holdingId != null ? `id:${e.holdingId}` : `ref:${e.holdingRef}`;
    const symbol = investEventSymbol(e);
    return `
    <div data-ie-row="${i}" data-ie-symbol="${esc(symbol)}">
      <div class="costs-proposed-row${e.conflict ? ' conflict' : ''}">
        <input type="checkbox" data-ie-check${ieChecked(e)}>
        <span data-ie-sentence style="flex:1">${esc(investEventSentence(e, symbol))}</span>
        ${e.priceDerived ? '<span class="note">Price derived from total amount</span>' : ''}
        ${e.conflict ? '<span class="conflict-tag">Same event already recorded — applies only if checked</span>' : ''}
        <button type="button" class="small" data-ie-edit>Edit</button>
        <button type="button" class="small danger" data-ie-remove title="Remove">×</button>
      </div>
      <div data-ie-inputs style="display:none"><div class="costs-proposed-row">
        ${investEventInputs(e, sel)}
      </div></div>
    </div>`;
  };
  const importEventSection = !events.length ? '' : `
    <div class="note" style="margin:6px 0 4px">Events · Group by
      <select data-ie-group-by>
        <option value="type"${investImportGroupBy === 'type' ? ' selected' : ''}>Type</option>
        <option value="symbol"${investImportGroupBy === 'symbol' ? ' selected' : ''}>Symbol</option>
        <option value="month"${investImportGroupBy === 'month' ? ' selected' : ''}>Month</option>
      </select></div>
    ${investGroupEvents(events).map((g) => `
    <div data-ie-group="${esc(g.key)}">
      <div class="costs-proposed-row" data-ie-group-head="${esc(g.key)}" style="cursor:pointer">
        <input type="checkbox" data-ie-group-check="${esc(g.key)}">
        <span data-ie-group-arrow>▸</span>
        <span>${esc(g.key)}</span>
        <span class="note" style="flex:1">${investGroupTotals(g)}</span>
      </div>
      <div data-ie-group-body="${esc(g.key)}" style="display:none">
        ${g.indices.map((i) => investImportEventRow(events[i], i)).join('')}
      </div>
    </div>`).join('')}`;
  host.innerHTML = `<div class="costs-proposed">${reportHtml}${droppedHtml}<h5>Proposed — review, edit, then Apply</h5>
    ${holdings.length ? `<div class="note" style="margin:0 0 4px">New holdings</div>${holdingRows}` : ''}
    ${investImportMode ? importEventSection : (events.length ? `<div class="note" style="margin:6px 0 4px">Events</div>${eventRows}` : '')}
    ${nav.length ? `<div class="note" style="margin:6px 0 4px">NAV snapshots — observed prices, not transactions</div>${navRows}` : ''}
    <div class="toolbar" style="margin-top:6px">
      <button type="button" class="primary small" data-invest-apply>Apply selected</button>
      <button type="button" class="small" data-invest-discard>Discard</button>
    </div></div>`;
  host.querySelectorAll('[data-money]').forEach(wireMoneyInput);
  if (investImportMode) syncInvestGroupChecks(host);
  scheduleInvestPreview();
}

// Read the proposal rows back out of their (editable) inputs.
// Rows are slotted by their own data-ie-row / data-ih-row index,
// not by DOM position: the import preview groups rows (by type,
// symbol or month), so DOM order is no longer state order, and
// positional reads would attach notes, conflicts and removals to
// the wrong rows.
function readInvestProposed() {
  const host = document.querySelector('[data-invest-proposed]');
  const holdings = [];
  const events = [];
  const nav = [];
  if (!host) return { holdings, events, nav };
  const slot = (list, rows, build) => {
    const placed = new Array(list.length).fill(undefined);
    const extra = [];
    let extraIdx = list.length;
    rows.forEach((row) => {
      const idx = Number(row.dataset.ihRow ?? row.dataset.ieRow);
      if (Number.isInteger(idx) && idx >= 0 && idx < list.length) placed[idx] = build(row, list[idx] || {}, idx);
      else extra.push(build(row, {}, extraIdx++));
    });
    return [...placed.filter((v) => v !== undefined), ...extra];
  };
  slot(investChatState.proposed.holdings, [...host.querySelectorAll('[data-ih-row]')], (row, prev, idx) => ({
    ref: prev.ref || `h${idx + 1}`,
    checked: row.querySelector('[data-ih-check]').checked,
    label: row.querySelector('[data-ih-label]').value.trim(),
    kind: row.querySelector('[data-ih-kind]').value,
    symbol: row.querySelector('[data-ih-symbol]').value.trim() || null,
    fundCode: row.querySelector('[data-ih-fundcode]').value.trim() || null,
    currency: row.querySelector('[data-ih-currency]').value,
    conflict: prev.conflict || null,
  })).forEach((h) => holdings.push(h));
  slot(investChatState.proposed.events, [...host.querySelectorAll('[data-ie-row]')], (row, prev) => {
    const target = row.querySelector('[data-ie-target]').value || '';
    const type = row.querySelector('[data-ie-type]').value;
    const ev = {
      checked: row.querySelector('[data-ie-check]').checked,
      holdingId: target.startsWith('id:') ? Number(target.slice(3)) : null,
      holdingRef: target.startsWith('ref:') ? target.slice(4) : null,
      date: row.querySelector('[data-ie-date]').value,
      type,
      units: null, price: null, amount: null,
      splitNew: null, splitOld: null,
      note: prev.note || null,
      conflict: prev.conflict || null,
    };
    if (type === 'dividend') ev.amount = parseMoneyInput(row.querySelector('[data-ie-amount]').value);
    else if (type === 'split') {
      const sn = row.querySelector('[data-ie-splitnew]').value.trim();
      ev.splitNew = sn === '' ? null : Number(sn);
      const so = row.querySelector('[data-ie-splitold]').value.trim();
      ev.splitOld = so === '' ? null : Number(so);
    } else {
      const u = row.querySelector('[data-ie-units]').value.trim();
      ev.units = u === '' ? null : Number(u);
      const p = parseMoneyInput(row.querySelector('[data-ie-price]').value);
      // A position carries no price by definition — never let
      // a stray price input turn it into a buy.
      ev.price = type === 'position' ? null : (p === '' ? null : p);
    }
    return ev;
  }).forEach((e) => events.push(e));
  slot(investChatState.proposed.nav || [], [...host.querySelectorAll('[data-in-row]')], (row, prev) => {
    const target = row.querySelector('[data-in-target]').value || '';
    const p = parseMoneyInput(row.querySelector('[data-in-price]').value);
    return {
      checked: row.querySelector('[data-in-check]').checked,
      holdingId: target.startsWith('id:') ? Number(target.slice(3)) : null,
      holdingRef: target.startsWith('ref:') ? target.slice(4) : null,
      date: row.querySelector('[data-in-date]').value,
      price: p === '' ? null : p,
      conflict: prev.conflict || null,
      oldPrice: prev.oldPrice ?? null,
    };
  }).forEach((n) => nav.push(n));
  return { holdings, events, nav };
}

// Keep the draft state in step with the inputs without a
// re-render (typing must not lose focus).
document.querySelector('[data-invest-proposed]').addEventListener('change', () => {
  const { holdings, events, nav } = readInvestProposed();
  investChatState.proposed = {
    holdings: holdings.map(({ checked, ...rest }) => rest),
    events: events.map(({ checked, ...rest }) => rest),
    nav: nav.map(({ checked, ...rest }) => rest),
  };
});

// Grouping controls for the import preview: a group header
// checkbox toggles its whole group, the group-by select
// re-renders from the live DOM (edits survive regrouping),
// and editing an import row refreshes its sentence live.
document.querySelector('[data-invest-proposed]').addEventListener('change', (e) => {
  const host = document.querySelector('[data-invest-proposed]');
  if (e.target.matches('[data-ie-group-by]')) {
    const draft = readInvestProposed();
    investChatState.proposed = { holdings: draft.holdings, events: draft.events, nav: draft.nav };
    investImportGroupBy = e.target.value;
    renderInvestProposed();
    return;
  }
  if (e.target.matches('[data-ie-group-check]')) {
    const key = e.target.dataset.ieGroupCheck;
    const body = host.querySelector(`[data-ie-group-body="${CSS.escape(key)}"]`);
    if (body) body.querySelectorAll('[data-ie-check]').forEach((c) => { c.checked = e.target.checked; });
    return;
  }
  if (e.target.matches('[data-ie-check]')) {
    syncInvestGroupChecks(host);
    return;
  }
  const row = e.target.closest('[data-ie-row]');
  if (row && row.querySelector('[data-ie-sentence]')) {
    const draft = readInvestProposed();
    const ev = draft.events[Number(row.dataset.ieRow)];
    const sentence = row.querySelector('[data-ie-sentence]');
    if (ev && sentence) sentence.textContent = investEventSentence(ev, investEventSymbol(ev));
  }
});

// Live value preview for the Fill-with-AI draft: one line per
// holding the draft touches — the post-Apply current value and
// its delta against the recorded value. The panel only ever
// posts the checked rows (exactly what Apply would write); the
// numbers come from the server preview endpoint, which runs the
// holding engine over recorded state + the draft, so the preview
// and the post-Apply page agree. The preview box is a sibling
// of the proposed host, never re-rendered with it, so typing
// never loses focus. Import mode has its own preview and is
// left alone.
let investPreviewSeq = 0;
let investPreviewTimer = null;
function scheduleInvestPreview() {
  const box = document.querySelector('[data-invest-preview]');
  if (!box) return;
  if (investImportMode) { box.innerHTML = ''; return; }
  clearTimeout(investPreviewTimer);
  investPreviewTimer = setTimeout(refreshInvestPreview, 300);
}
async function refreshInvestPreview() {
  const box = document.querySelector('[data-invest-preview]');
  if (!box) return;
  if (investImportMode || investChatAccountId == null) { box.innerHTML = ''; return; }
  const draft = readInvestProposed();
  const holdings = draft.holdings.filter((h) => h.checked);
  const events = draft.events.filter((e) => e.checked);
  const nav = (draft.nav || []).filter((n) => n.checked);
  if (!holdings.length && !events.length && !nav.length) { box.innerHTML = ''; return; }
  const my = ++investPreviewSeq;
  try {
    const r = await api(`/api/investments/accounts/${investChatAccountId}/fill-preview`, {
      method: 'POST', body: { holdings, events, nav },
    });
    if (my !== investPreviewSeq) return;
    const deltaStr = (d, cur) => (d == null ? '' : ` (${d >= 0 ? '+' : ''}${moneyC(d, cur)})`);
    const lines = (r.previews || []).map((p) => {
      const main = `${esc(p.label)} · ${moneyC(p.valueNative, p.currency)}${deltaStr(p.deltaNative, p.currency)}`;
      const cad = p.currency === 'USD' ? ` · ${moneyC(p.value)} CAD${deltaStr(p.delta, 'CAD')} CAD` : '';
      return `<div class="note" data-invest-preview-line="${esc(p.key)}">${main}${cad}</div>`;
    }).join('');
    box.innerHTML = lines ? `<div class="note" style="margin:6px 0 4px">Preview value after Apply</div>${lines}` : '';
  } catch { if (my === investPreviewSeq) box.innerHTML = ''; }
}
document.querySelector('[data-invest-proposed]').addEventListener('input', scheduleInvestPreview);
document.querySelector('[data-invest-proposed]').addEventListener('change', scheduleInvestPreview);

document.querySelector('[data-invest-proposed]').addEventListener('click', async (e) => {
  if (e.target.closest('[data-ie-group-head]') && !e.target.closest('[data-ie-group-check]')) {
    const head = e.target.closest('[data-ie-group-head]');
    const key = head.dataset.ieGroupHead;
    const host = document.querySelector('[data-invest-proposed]');
    const body = host.querySelector(`[data-ie-group-body="${CSS.escape(key)}"]`);
    const arrow = head.querySelector('[data-ie-group-arrow]');
    if (body) {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      if (arrow) arrow.textContent = open ? '▸' : '▾';
    }
    return;
  }
  if (e.target.closest('[data-ie-edit]')) {
    const row = e.target.closest('[data-ie-row]');
    const inputs = row.querySelector('[data-ie-inputs]');
    const btn = e.target.closest('[data-ie-edit]');
    if (inputs) {
      const open = inputs.style.display !== 'none';
      inputs.style.display = open ? 'none' : '';
      btn.textContent = open ? 'Edit' : 'Done';
    }
    return;
  }
  if (e.target.closest('[data-ih-remove]')) {
    const idx = Number(e.target.closest('[data-ih-row]').dataset.ihRow);
    const { holdings, events, nav } = readInvestProposed();
    const removed = holdings[idx];
    investChatState.proposed = {
      holdings: holdings.filter((_, i) => i !== idx).map(({ checked, ...rest }) => rest),
      // Events and NAV rows pointing at a removed draft holding go with it.
      events: events.filter((ev) => ev.holdingRef !== (removed && removed.ref)).map(({ checked, ...rest }) => rest),
      nav: nav.filter((n) => n.holdingRef !== (removed && removed.ref)).map(({ checked, ...rest }) => rest),
    };
    renderInvestProposed();
    return;
  }
  if (e.target.closest('[data-ie-remove]')) {
    const idx = Number(e.target.closest('[data-ie-row]').dataset.ieRow);
    const { holdings, events, nav } = readInvestProposed();
    investChatState.proposed = {
      holdings: holdings.map(({ checked, ...rest }) => rest),
      events: events.filter((_, i) => i !== idx).map(({ checked, ...rest }) => rest),
      nav: nav.map(({ checked, ...rest }) => rest),
    };
    renderInvestProposed();
    return;
  }
  if (e.target.closest('[data-in-remove]')) {
    const idx = Number(e.target.closest('[data-in-row]').dataset.inRow);
    const { holdings, events, nav } = readInvestProposed();
    investChatState.proposed = {
      holdings: holdings.map(({ checked, ...rest }) => rest),
      events: events.map(({ checked, ...rest }) => rest),
      nav: nav.filter((_, i) => i !== idx).map(({ checked, ...rest }) => rest),
    };
    renderInvestProposed();
    return;
  }
  if (e.target.closest('[data-invest-discard]')) {
    investChatState.proposed = { holdings: [], events: [], nav: [] };
    investChatDropped = [];
    investImportMode = false;
    investImportReport = null;
    renderInvestProposed();
    return;
  }
  if (investImportMode && e.target.closest('[data-invest-apply]')) {
    // CSV import Apply: one atomic server call with source 'csv',
    // not the AI path's per-item posts.
    const msg = document.querySelector('[data-invest-chat-msg]');
    const draft = readInvestProposed();
    const chosenHoldings = draft.holdings.filter((h) => h.checked);
    const chosenEvents = draft.events.filter((ev) => ev.checked);
    if (!chosenHoldings.length && !chosenEvents.length) {
      showMsg(msg, 'err', 'Nothing is selected to apply.');
      return;
    }
    for (const h of chosenHoldings) {
      if (!h.label || (h.kind === 'exchange' && !h.symbol)) {
        showMsg(msg, 'err', 'A selected holding is missing its label or (for exchange) its symbol.');
        return;
      }
    }
    for (const ev of chosenEvents) {
      const figuresOk = ev.type === 'dividend' ? ev.amount > 0
        : ev.type === 'split' ? (ev.splitNew > 0 && ev.splitOld > 0)
        : ev.units > 0;
      if (!ev.date || !figuresOk) {
        showMsg(msg, 'err', 'A selected event is missing its date or figures.');
        return;
      }
      if (ev.holdingId == null && !chosenHoldings.some((h) => h.ref === ev.holdingRef)) {
        showMsg(msg, 'err', 'A selected event belongs to a new holding that is not selected — select the holding too.');
        return;
      }
    }
    const applyBtn = e.target.closest('[data-invest-apply]');
    applyBtn.disabled = true;
    try {
      const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv/apply`, {
        method: 'POST',
        body: {
          source: investImportSource,
          holdings: chosenHoldings.map(({ checked, conflict, ...rest }) => rest),
          events: chosenEvents.map(({ checked, conflict, ...rest }) => rest),
        },
      });
      const dup = r.skippedDuplicates && r.skippedDuplicates.length ? ` (${r.skippedDuplicates.length} already recorded, skipped)` : '';
      investChatState.proposed = { holdings: [], events: [] };
      investChatDropped = [];
      investImportMode = false;
      investImportReport = null;
      investChatState.turns.push({ role: 'assistant', content: `Imported ${r.createdHoldings} holdings and ${r.createdEvents} events${dup}.` });
      renderInvestChatLog();
      renderInvestProposed();
      clearInvestChatMsg();
      await loadInvestAccount(investChatAccountId);
    } catch (err) {
      showMsg(msg, 'err', err.message);
    } finally {
      applyBtn.disabled = false;
    }
    return;
  }
  if (!e.target.closest('[data-invest-apply]')) return;
  const msg = document.querySelector('[data-invest-chat-msg]');
  const draft = readInvestProposed();
  const chosenHoldings = draft.holdings.filter((h) => h.checked);
  const chosenEvents = draft.events.filter((ev) => ev.checked);
  const chosenNav = (draft.nav || []).filter((n) => n.checked);
  if (!chosenHoldings.length && !chosenEvents.length && !chosenNav.length) {
    showMsg(msg, 'err', 'Nothing is selected to apply.');
    return;
  }
  for (const h of chosenHoldings) {
    if (!h.label || (h.kind === 'exchange' && !h.symbol)) {
      showMsg(msg, 'err', 'A selected holding is missing its label or (for exchange) its symbol.');
      return;
    }
  }
  for (const ev of chosenEvents) {
    const figuresOk = ev.type === 'dividend' ? ev.amount > 0
      : ev.type === 'split' ? (ev.splitNew > 0 && ev.splitOld > 0)
        : ev.units > 0;
    if (!ev.date || !figuresOk) {
      showMsg(msg, 'err', 'A selected event is missing its date or figures.');
      return;
    }
    if (ev.holdingId == null && !chosenHoldings.some((h) => h.ref === ev.holdingRef)) {
      showMsg(msg, 'err', 'A selected event belongs to a new holding that is not selected — select the holding too.');
      return;
    }
  }
  for (const n of chosenNav) {
    if (!n.date || !(n.price > 0)) {
      showMsg(msg, 'err', 'A selected NAV snapshot is missing its date or price.');
      return;
    }
    if (n.holdingId == null && !chosenHoldings.some((h) => h.ref === n.holdingRef)) {
      showMsg(msg, 'err', 'A selected NAV snapshot belongs to a new holding that is not selected — select the holding too.');
      return;
    }
  }
  const applyBtn = e.target.closest('[data-invest-apply]');
  applyBtn.disabled = true;
  try {
    const refToId = new Map();
    for (const h of chosenHoldings) {
      const { checked, conflict, ref, ...fields } = h;
      const created = await api(`/api/investments/accounts/${investChatAccountId}/holdings`, {
        method: 'POST', body: { ...fields, source: 'ai' },
      });
      refToId.set(ref, created.id);
    }
    for (const ev of chosenEvents) {
      const { checked, conflict, holdingRef, ...fields } = ev;
      const holdingId = ev.holdingId != null ? ev.holdingId : refToId.get(holdingRef);
      await api(`/api/investments/holdings/${holdingId}/events`, {
        method: 'POST', body: { ...fields, holdingId: undefined, source: 'ai' },
      });
    }
    // NAV snapshots write through the same manual endpoint the
    // holding page uses — Apply only ever writes checked rows, and
    // a checked conflict row is the user's explicit overwrite
    // approval, so the flag travels with it.
    for (const n of chosenNav) {
      const { checked, conflict, oldPrice, holdingRef, ...fields } = n;
      const holdingId = n.holdingId != null ? n.holdingId : refToId.get(holdingRef);
      await api(`/api/investments/holdings/${holdingId}/nav`, {
        method: 'POST', body: { date: fields.date, price: fields.price, overwrite: true },
      });
    }
    const n = chosenHoldings.length + chosenEvents.length + chosenNav.length;
    investChatState.proposed = {
      holdings: draft.holdings.filter((h) => !h.checked).map(({ checked, ...rest }) => rest),
      events: draft.events.filter((ev) => !ev.checked).map(({ checked, ...rest }) => rest),
      nav: (draft.nav || []).filter((x) => !x.checked).map(({ checked, ...rest }) => rest),
    };
    investChatDropped = []; // the round is closed; the next send re-derives the warning
    investChatState.turns.push({ role: 'assistant', content: `Applied ${n} ${n === 1 ? 'item' : 'items'}.` });
    renderInvestChatLog();
    renderInvestProposed();
    clearInvestChatMsg(); // a successful Apply supersedes an older error
    await loadInvestAccount(investChatAccountId);
  } catch (err) {
    showMsg(msg, 'err', err.message);
  } finally {
    applyBtn.disabled = false;
  }
});

{
  const wrap = $('#investAiFill');
  const panel = wrap.querySelector('[data-invest-ai-panel]');
  const toggle = document.querySelector('[data-invest-ai-toggle]');
  const sendBtn = wrap.querySelector('[data-invest-chat-send]');
  const clearBtn = wrap.querySelector('[data-invest-chat-clear]');
  const modelSel = wrap.querySelector('[data-invest-chat-model]');
  const guidance = wrap.querySelector('[data-invest-ai-guidance]');
  const msg = wrap.querySelector('[data-invest-chat-msg]');
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
  clearBtn.addEventListener('click', () => resetInvestChat(investChatAccountId));
  const fileInput = wrap.querySelector('[data-invest-chat-files]');
  const chatTa = wrap.querySelector('[data-invest-chat-text]');
  const queueHost = wrap.querySelector('[data-invest-chat-queue]');
  const queueFiles = (list) => {
    const add = [...(list || [])];
    if (!add.length) return;
    investChatQueue.push(...add);
    renderInvestChatQueue();
    clearInvestChatMsg(); // a changed file selection supersedes the last error
  };
  fileInput.addEventListener('change', () => {
    queueFiles(fileInput.files);
    fileInput.value = '';
  });
  queueHost.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-invest-chat-queue-remove]');
    if (!btn) return;
    investChatQueue.splice(Number(btn.dataset.investChatQueueRemove), 1);
    renderInvestChatQueue();
  });
  chatTa.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length) return;
    e.preventDefault();
    queueFiles(files);
  });
  // Deterministic Wealthsimple CSV import: parse on the server,
  // preview in the same proposed panel as the AI draft, Apply
  // writes it in one transaction with source 'csv'.
  const importBtn = document.querySelector('[data-invest-import-csv]');
  const importFile = wrap.querySelector('[data-invest-import-file]');
  importBtn.addEventListener('click', () => {
    if (investChatAccountId == null) { showMsg(msg, 'err', 'Open an account first.'); return; }
    panel.classList.remove('hidden');
    importFile.click();
  });
  importFile.addEventListener('change', async () => {
    const f = importFile.files[0];
    importFile.value = '';
    if (!f) return;
    clearInvestChatMsg(); // a new import supersedes the last error
    try {
      const text = await f.text();
      const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv`, { method: 'POST', body: { csv: text } });
      investChatState.proposed = { holdings: r.holdings || [], events: r.events || [], nav: [] };
      investChatDropped = r.failed || [];
      investImportMode = true;
      investImportSource = 'csv';
      investImportReport = {
        holdings: (r.holdings || []).length, events: (r.events || []).length,
        skipped: r.skipped ? r.skipped.total : 0,
        skippedByType: r.skipped ? r.skipped.byType : {},
        duplicates: r.duplicates || 0,
      };
      renderInvestProposed();
    } catch (err) {
      showMsg(msg, 'err', err.message);
    }
  });
  // AI-mapped CSV import: for broker exports that are not
  // Wealthsimple's. The model proposes a mapping from the file's
  // structure; the user confirms or edits it here; only then
  // does the deterministic engine preview every row, and Apply
  // writes it with source 'csv-ai'.
  // AI-mapped CSV import, wizard edition: the mapping is edited
  // as operations, not column names — when, what, how many,
  // buy-or-sell, what it cost — with the file's first rows
  // translated into plain words underneath, live, so a wrong
  // mapping shows up before anything is applied. The model only
  // pre-fills the wizard; the deterministic engine, sell guard,
  // dedup, split derivation and preview → Apply flow are
  // unchanged, and confirming still saves the corrected mapping
  // by column fingerprint for the next file from this broker.
  const mapBtn = document.querySelector('[data-invest-import-csv-map]');
  const mapFile = wrap.querySelector('[data-invest-import-map-file]');
  const mapHost = wrap.querySelector('[data-invest-map-editor]');
  const WIZ_TARGETS = ['buy', 'sell', 'grant', 'dividend', 'split', 'skip'];
  let wizPreviewSeq = 0;
  // Engine mapping <-> wizard step state. The wizard groups the
  // same fields by operation: required steps (when, what, how
  // many, buy-or-sell) always visible, optional steps (name,
  // price/amount, currency, symbol suffix, split columns) in a
  // collapsed section. Mirrors the server's wizardToMapping /
  // mappingToWizard pair; the engine only ever sees the engine
  // shape.
  const engineToWizard = (m) => {
    const c = (m && m.columns) || {};
    return {
      dateCol: c.date || '', symbolCol: c.symbol || '', nameCol: c.name || '',
      activityCol: c.activity || '', activity2Col: c.activity2 || '', unitsCol: c.units || '', priceCol: c.price || '',
      amountCol: c.amount || '', currencyCol: c.currency || '',
      splitAddedCol: c.splitAdded || '', splitNewCol: c.splitNew || '', splitOldCol: c.splitOld || '',
      defaultCurrency: (m && m.defaultCurrency) || null,
      valueTargets: { ...((m && m.values) || {}) },
      symbolSuffix: (m && m.symbolSuffix && m.symbolSuffix.suffix) || '',
      suffixWhenCurrency: (m && m.symbolSuffix && m.symbolSuffix.whenCurrency) || null,
    };
  };
  const wizardToEngine = (w) => {
    const columns = {};
    const pairs = [
      ['dateCol', 'date'], ['symbolCol', 'symbol'], ['nameCol', 'name'],
      ['activityCol', 'activity'], ['activity2Col', 'activity2'], ['unitsCol', 'units'], ['priceCol', 'price'],
      ['amountCol', 'amount'], ['currencyCol', 'currency'],
      ['splitAddedCol', 'splitAdded'], ['splitNewCol', 'splitNew'], ['splitOldCol', 'splitOld'],
    ];
    for (const [wk, ek] of pairs) if (w[wk]) columns[ek] = w[wk];
    return {
      columns,
      values: { ...(w.valueTargets || {}) },
      defaultCurrency: w.defaultCurrency || null,
      symbolSuffix: w.symbolSuffix ? { suffix: w.symbolSuffix, whenCurrency: w.suffixWhenCurrency || null } : null,
    };
  };
  const wizColOptions = (sel) => `<option value="">(not mapped)</option>`
    + (investMapStructure ? investMapStructure.columns.map((c) => {
      const stat = investMapStructure.columnStats.find((s) => s.name === c);
      const samples = stat && stat.samples ? stat.samples.slice(0, 2).join(', ') : '';
      return `<option value="${esc(c)}"${sel === c ? ' selected' : ''}>${esc(c)}${samples ? ` — e.g. ${esc(samples)}` : ''}</option>`;
    }).join('') : '');
  const wizValueList = () => {
    if (!investMapStructure || !investMapWizard) return [];
    // Pair mode: the list comes from the server (the analyze summary
    // has column stats, not rows, so only the server can pair the
    // two columns' values). Single mode keeps the column stats.
    if (investMapWizard.activity2Col) return investMapPairValues || [];
    const actCol = investMapWizard.activityCol;
    if (!actCol) return [];
    const stat = investMapStructure.columnStats.find((s) => s.name === actCol);
    if (!stat) return [];
    if (stat.distinct && stat.distinct.length) return stat.distinct;
    return stat.samples || [];
  };
  const renderWizValueRows = () => {
    const box = mapHost.querySelector('[data-wiz-values]');
    if (!box) return;
    const prev = {};
    box.querySelectorAll('[data-wiz-value-idx]').forEach((sel) => {
      const raw = investMapValueList[Number(sel.dataset.wizValueIdx)];
      if (raw !== undefined && sel.value) prev[raw] = sel.value;
    });
    const values = wizValueList();
    investMapValueList = values;
    const merged = { ...(investMapWizard.valueTargets || {}), ...prev };
    const actCol = investMapWizard.activityCol;
    const pairMode = !!investMapWizard.activity2Col;
    const stat = !pairMode && actCol ? investMapStructure.columnStats.find((s) => s.name === actCol) : null;
    box.innerHTML = values.length
      ? values.map((v, i) => `<div class="costs-proposed-row"><span style="flex:1">${esc(pairMode ? (investMapPairLabels[i] || v) : v)}</span>
          <select data-wiz-value-idx="${i}"><option value="">(pick one)</option>
          ${WIZ_TARGETS.map((t) => `<option value="${t}"${merged[v] === t ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>`).join('')
        + (pairMode && investMapPairTruncated ? `<div class="note">More than ${investMapPairCount} distinct activity pairs — only the first listed can be mapped here; the rest fail loudly in the preview.</div>` : '')
        + (stat && stat.distinctTruncated ? `<div class="note">More than ${stat.distinctCount} distinct values — only the first listed can be mapped here; the rest fail loudly in the preview.</div>` : '')
      : '<div class="note">Pick the column that says buy or sell in step 4 to map its values.</div>';
  };
  // Pair-mode step-4 list: ask the server for the distinct pairs of
  // the two activity columns as they currently stand. The list is
  // what the confirm guard checks, so it must be in sync before a
  // confirm is allowed (investMapPairLoaded); a stale reply from an
  // older column choice is dropped by generation.
  const refreshPairValues = async () => {
    const w = investMapWizard;
    if (!w || !w.activity2Col) { investMapPairLoaded = true; return; }
    investMapPairLoaded = false;
    const seq = ++investMapPairSeq;
    try {
      const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv-map/activity-values`, { method: 'POST', body: { csv: investMapCsv, mapping: wizardToEngine(readWizard().wizard) } });
      if (seq !== investMapPairSeq || !mapHost.querySelector('[data-wiz-values]')) return;
      investMapPairValues = r.values || [];
      investMapPairLabels = r.labels || [];
      investMapPairTruncated = !!r.truncated;
      investMapPairCount = r.count || 0;
      investMapPairLoaded = true;
      renderWizValueRows();
      // The value rows just landed (pre-filled from the mapping), so
      // the live preview must re-translate with them — the preview
      // that ran at editor render time saw no value rows at all and
      // still shows every row as unmapped.
      refreshMapPreview();
    } catch {
      if (seq !== investMapPairSeq) return;
      showMsg(msg, 'err', 'Could not list the activity pairs — change the activity columns again to retry.');
    }
  };
  const readWizard = () => {
    const col = (f) => {
      const sel = mapHost.querySelector(`[data-wiz-col="${f}"]`);
      return sel && sel.value ? sel.value : '';
    };
    const values = {};
    mapHost.querySelectorAll('[data-wiz-value-idx]').forEach((sel) => {
      const raw = investMapValueList[Number(sel.dataset.wizValueIdx)];
      if (raw !== undefined && sel.value) values[raw] = sel.value;
    });
    const suffix = (mapHost.querySelector('[data-wiz-suffix]').value || '').trim();
    const when = mapHost.querySelector('[data-wiz-suffix-when]').value || null;
    const answers = [];
    mapHost.querySelectorAll('[data-wiz-answer-idx]').forEach((inp) => {
      const a = inp.value.trim();
      if (a) answers.push(a);
    });
    return {
      wizard: {
        dateCol: col('date'), symbolCol: col('symbol'), nameCol: col('name'),
        activityCol: col('activity'), activity2Col: col('activity2'), unitsCol: col('units'), priceCol: col('price'),
        amountCol: col('amount'), currencyCol: col('currency'),
        splitAddedCol: col('splitAdded'), splitNewCol: col('splitNew'), splitOldCol: col('splitOld'),
        defaultCurrency: mapHost.querySelector('[data-wiz-default-currency]').value || null,
        valueTargets: values,
        symbolSuffix: suffix, suffixWhenCurrency: when,
      },
      answers,
    };
  };
  const refreshMapPreview = async () => {
    const box = mapHost.querySelector('[data-wiz-preview]');
    if (!box || investChatAccountId == null || !investMapCsv) return;
    const seq = ++wizPreviewSeq;
    const { wizard } = readWizard();
    try {
      const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv-map/translate`, { method: 'POST', body: { csv: investMapCsv, mapping: wizardToEngine(wizard) } });
      if (seq !== wizPreviewSeq || !mapHost.querySelector('[data-wiz-preview]')) return;
      const target = mapHost.querySelector('[data-wiz-preview]');
      target.innerHTML = (r.sentences || []).map((s) => `<div>${esc(s)}</div>`).join('')
        || '<div class="note">No rows to preview.</div>';
    } catch {
      if (seq !== wizPreviewSeq) return;
      const target = mapHost.querySelector('[data-wiz-preview]');
      if (target && !target.innerHTML) target.innerHTML = '<div class="note">Preview unavailable right now.</div>';
    }
  };
  const renderMapEditor = () => {
    if (!investMapStructure || !investMapWizard) { mapHost.innerHTML = ''; return; }
    const w = investMapWizard;
    const suffix = w.symbolSuffix || '';
    mapHost.innerHTML = `<div class="costs-proposed"><h5>Map your CSV — what does each part mean?</h5>
      ${investMapReused ? '<div class="note">Reused saved mapping for this file format — correct it below if needed, or ask AI to re-map.</div>' : ''}
      ${investMapReply ? `<div class="note">${esc(investMapReply)}</div>` : ''}
      <div class="note" style="margin:0 0 4px">${investMapStructure.rowCount} rows in this file</div>
      <div class="note" style="margin:6px 0 4px">Step 1 — When did it happen?</div>
      <div class="costs-proposed-row"><span style="flex:1">Date column</span>
        <select data-wiz-col="date">${wizColOptions(w.dateCol)}</select></div>
      <div class="note" style="margin:6px 0 4px">Step 2 — What was bought or sold?</div>
      <div class="costs-proposed-row"><span style="flex:1">Symbol column</span>
        <select data-wiz-col="symbol">${wizColOptions(w.symbolCol)}</select></div>
      <div class="note" style="margin:6px 0 4px">Step 3 — How many units?</div>
      <div class="costs-proposed-row"><span style="flex:1">Units column</span>
        <select data-wiz-col="units">${wizColOptions(w.unitsCol)}</select></div>
      <div class="note" style="margin:6px 0 4px">Step 4 — How do we tell buys from sells?</div>
      <div class="costs-proposed-row"><span style="flex:1">Buy / sell column</span>
        <select data-wiz-col="activity">${wizColOptions(w.activityCol)}</select></div>
      <div class="costs-proposed-row"><span style="flex:1">Second activity column (optional — only when one column can't tell operations apart: type + sub-type together, e.g. Trade / BUY vs Dividend / -)</span>
        <select data-wiz-col="activity2">${wizColOptions(w.activity2Col || '')}</select></div>
      <div data-wiz-values></div>
      <details data-wiz-optional style="margin-top:6px"><summary>Optional fields</summary>
        <div class="costs-proposed-row"><span style="flex:1">Name column</span>
          <select data-wiz-col="name">${wizColOptions(w.nameCol)}</select></div>
        <div class="note" style="margin:6px 0 4px">Step 5 — What did it cost? Pick whichever your file has; with totals only, the price per unit is derived.</div>
        <div class="costs-proposed-row"><span style="flex:1">Price per unit column</span>
          <select data-wiz-col="price">${wizColOptions(w.priceCol)}</select></div>
        <div class="costs-proposed-row"><span style="flex:1">Total amount column</span>
          <select data-wiz-col="amount">${wizColOptions(w.amountCol)}</select></div>
        <div class="costs-proposed-row"><span style="flex:1">Split: added units column</span>
          <select data-wiz-col="splitAdded">${wizColOptions(w.splitAddedCol || '')}</select></div>
        <div class="costs-proposed-row"><span style="flex:1">Split: new side column</span>
          <select data-wiz-col="splitNew">${wizColOptions(w.splitNewCol || '')}</select></div>
        <div class="costs-proposed-row"><span style="flex:1">Split: old side column</span>
          <select data-wiz-col="splitOld">${wizColOptions(w.splitOldCol || '')}</select></div>
        <div class="note" style="margin:6px 0 4px">Currency &amp; symbols</div>
        <div class="costs-proposed-row"><span style="flex:1">Currency column</span>
          <select data-wiz-col="currency">${wizColOptions(w.currencyCol)}</select></div>
        <div class="costs-proposed-row"><span style="flex:1">Default currency</span>
          <select data-wiz-default-currency><option value="">(none — use currency column)</option>
          <option value="CAD"${w.defaultCurrency === 'CAD' ? ' selected' : ''}>CAD</option>
          <option value="USD"${w.defaultCurrency === 'USD' ? ' selected' : ''}>USD</option></select></div>
        <div class="costs-proposed-row"><span style="flex:1">Symbol suffix</span>
          <input type="text" data-wiz-suffix value="${esc(suffix)}" placeholder=".TO" style="width:80px">
          <select data-wiz-suffix-when><option value="">Any currency</option>
          <option value="CAD"${w.suffixWhenCurrency === 'CAD' ? ' selected' : ''}>CAD only</option>
          <option value="USD"${w.suffixWhenCurrency === 'USD' ? ' selected' : ''}>USD only</option></select></div>
      </details>
      ${investMapQuestions.length ? `<div class="note" style="margin:6px 0 4px">Questions from the mapping</div>
        ${investMapQuestions.map((q, i) => `<div class="costs-proposed-row"><span style="flex:1">${esc(q)}</span>
          <input type="text" data-wiz-answer-idx="${i}" placeholder="Your answer (optional)" style="flex:2"></div>`).join('')}` : ''}
      <div class="note" style="margin:6px 0 4px">Preview — your first rows in plain words</div>
      <div data-wiz-preview></div>
      <div class="note" style="margin:6px 0 4px">Preview not matching? Tell AI what's wrong — it revises the mapping and the preview re-renders.</div>
      ${investMapFollowupReply ? `<div class="note">${esc(investMapFollowupReply)}</div>` : ''}
      <div class="costs-proposed-row"><input type="text" data-wiz-followup placeholder="e.g. dividends are missing — those rows should be dividends, not skipped" style="flex:1">
        <button type="button" class="small primary" data-map-followup>Ask AI to fix</button></div>
      <div class="toolbar" style="margin-top:6px">
        <button type="button" class="primary small" data-map-confirm>Confirm mapping</button>
        <button type="button" class="small" data-map-remap>Ask AI to re-map</button>
        <button type="button" class="small" data-map-cancel>Cancel</button>
      </div></div>`;
    renderWizValueRows();
    if (w.activity2Col) refreshPairValues();
    refreshMapPreview();
  };
  mapHost.addEventListener('change', (e) => {
    if (e.target.matches('[data-wiz-col="activity"]')) {
      investMapWizard = { ...investMapWizard, activityCol: e.target.value };
      if (investMapWizard.activity2Col) refreshPairValues();
      else renderWizValueRows();
    }
    if (e.target.matches('[data-wiz-col="activity2"]')) {
      investMapWizard = { ...investMapWizard, activity2Col: e.target.value };
      if (e.target.value) refreshPairValues();
      else { investMapPairLoaded = true; renderWizValueRows(); }
    }
    refreshMapPreview();
  });
  mapHost.addEventListener('click', async (e) => {
    if (e.target.closest('[data-map-cancel]')) {
      investMapCsv = null; investMapStructure = null; investMapMapping = null; investMapWizard = null;
      investMapQuestions = []; investMapReply = ''; investMapFollowupReply = ''; investMapFollowupHistory = [];
      investMapReused = false; investMapValueList = [];
      investMapPairValues = []; investMapPairLabels = [];
      investMapPairTruncated = false; investMapPairCount = 0; investMapPairLoaded = false;
      mapHost.innerHTML = '';
      return;
    }
    if (e.target.closest('[data-map-remap]')) {
      if (investChatAccountId == null || !investMapCsv) return;
      clearInvestChatMsg();
      try {
        const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv-map/analyze`, { method: 'POST', body: { csv: investMapCsv, forceRefresh: true } });
        investMapStructure = r.structure; investMapMapping = r.mapping; investMapWizard = engineToWizard(r.mapping);
        investMapQuestions = r.questions || [];
        investMapReply = r.reply || ''; investMapFollowupReply = ''; investMapFollowupHistory = []; investMapReused = !!r.reused;
        renderMapEditor();
      } catch (err) { showMsg(msg, 'err', err.message); }
      return;
    }
    if (e.target.closest('[data-map-followup]')) {
      if (investChatAccountId == null || !investMapCsv) return;
      const input = mapHost.querySelector('[data-wiz-followup]');
      const message = input ? input.value.trim() : '';
      if (!message) { showMsg(msg, 'err', 'Tell AI what is wrong with the preview first.'); return; }
      const { wizard } = readWizard();
      const engineMapping = wizardToEngine(wizard);
      if (engineMapping.columns.activity2 && !investMapPairLoaded) {
        showMsg(msg, 'err', 'The activity pairs are still loading — wait a moment and try again.'); return;
      }
      const btn = e.target.closest('[data-map-followup]');
      btn.disabled = true;
      clearInvestChatMsg();
      try {
        const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv-map/followup`, { method: 'POST', body: { csv: investMapCsv, mapping: engineMapping, message, history: investMapFollowupHistory } });
        investMapFollowupHistory = [...investMapFollowupHistory, { message, reply: r.reply || '' }].slice(-5);
        investMapFollowupReply = r.reply || '';
        investMapReply = '';
        investMapWizard = engineToWizard(r.mapping);
        investMapQuestions = r.questions || [];
        renderMapEditor();
      } catch (err) { showMsg(msg, 'err', err.message); }
      finally { btn.disabled = false; }
      return;
    }
    if (e.target.closest('[data-map-confirm]')) {
      if (investChatAccountId == null || !investMapCsv) return;
      const { wizard, answers } = readWizard();
      const mapping = wizardToEngine(wizard);
      if (!mapping.columns.date || !mapping.columns.symbol || !mapping.columns.activity) {
        showMsg(msg, 'err', 'Pick the date, symbol and activity columns first.'); return;
      }
      if (!mapping.columns.currency && !mapping.defaultCurrency) {
        showMsg(msg, 'err', 'Pick a currency column or a default currency first.'); return;
      }
      const unmapped = investMapValueList.filter((v) => !mapping.values[v]);
      if (mapping.columns.activity2 && !investMapPairLoaded) {
        showMsg(msg, 'err', 'The activity pairs are still loading — wait a moment and try again.'); return;
      }
      if (unmapped.length) {
        showMsg(msg, 'err', `Pick a target for every activity value (unmapped: ${unmapped.join(', ')}).`); return;
      }
      clearInvestChatMsg();
      try {
        const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv-map/preview`, { method: 'POST', body: { csv: investMapCsv, mapping, answers } });
        investChatState.proposed = { holdings: r.holdings || [], events: r.events || [], nav: [] };
        investChatDropped = r.failed || [];
        investImportMode = true;
        investImportSource = 'csv-ai';
        investImportReport = {
          holdings: (r.holdings || []).length, events: (r.events || []).length,
          skipped: r.skipped ? r.skipped.total : 0,
          skippedByType: r.skipped ? r.skipped.byType : {},
          duplicates: r.duplicates || 0,
        };
        mapHost.innerHTML = '';
        renderInvestProposed();
      } catch (err) { showMsg(msg, 'err', err.message); }
    }
  });
  mapBtn.addEventListener('click', () => {
    if (investChatAccountId == null) { showMsg(msg, 'err', 'Open an account first.'); return; }
    panel.classList.remove('hidden');
    mapFile.click();
  });
  mapFile.addEventListener('change', async () => {
    const f = mapFile.files[0];
    mapFile.value = '';
    if (!f) return;
    clearInvestChatMsg(); // a new import supersedes the last error
    try {
      const text = await f.text();
      const r = await api(`/api/investments/accounts/${investChatAccountId}/import-csv-map/analyze`, { method: 'POST', body: { csv: text } });
      investMapCsv = text;
      investMapStructure = r.structure;
      investMapMapping = r.mapping;
      investMapWizard = engineToWizard(r.mapping);
      investMapQuestions = r.questions || [];
      investMapReply = r.reply || '';
      investMapFollowupReply = ''; investMapFollowupHistory = [];
      investMapReused = !!r.reused;
      renderMapEditor();
    } catch (err) {
      showMsg(msg, 'err', err.message);
    }
  });
  sendBtn.addEventListener('click', async () => {
    clearInvestChatMsg(); // a new send supersedes the last error
    const text = chatTa.value.trim();
    const files = investChatQueue.slice();
    if (!text && !files.length) { showMsg(msg, 'err', 'Write a message or attach a document first.'); return; }
    if (investChatAccountId == null) { showMsg(msg, 'err', 'Open an account first.'); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    renderInvestChatLog(text || '(attached documents)');
    try {
      const current = readInvestProposed();
      const body = {
        accountId: investChatAccountId,
        history: investChatState.turns,
        proposed: {
          holdings: current.holdings.map(({ checked, ...rest }) => rest),
          events: current.events.map(({ checked, ...rest }) => rest),
        },
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
      const r = await api('/api/ai/invest-fill-chat', { method: 'POST', body });
      if (body.model && aiConfigCache) aiConfigCache.model = body.model;
      investChatState.turns.push({ role: 'user', content: text || '(attached documents)' });
      if (r.reply) investChatState.turns.push({ role: 'assistant', content: r.reply });
      investChatState.proposed = {
        holdings: (r.proposed && r.proposed.holdings) || [],
        events: (r.proposed && r.proposed.events) || [],
        nav: (r.proposed && r.proposed.nav) || [],
      };
      investChatDropped = (r.proposed && Array.isArray(r.proposed.dropped)) ? r.proposed.dropped : [];
      investImportMode = false; // an AI round replaces any import preview
      investImportReport = null;
      investImportSource = 'csv';
      chatTa.value = '';
      fileInput.value = '';
      investChatQueue = [];
      renderInvestChatQueue();
      clearInvestChatMsg(); // a successful round supersedes the last error
      renderInvestChatLog();
      renderInvestProposed();
    } catch (err) {
      renderInvestChatLog();
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
// over a 12-month grid) serves them all. For the property range
// pickers, picking a month applies the pair exactly as the
// pickers' state machine always has: the preset highlight clears,
// the pair clamps into the data span (a start past the end pulls
// the end up to the start) and the projection refetches. Months
// outside the data span render disabled in the grid, and the year
// stepper stops at the span's first/last years. For the rent entry
// modal's fields, a pick only fills that field (button label +
// hidden YYYY-MM input) — no pair logic, no refetch — and every
// month in the server's valid 2000–2100 range is enabled.
function monthPopField() {
  // Earnings panels resolve through their range bar (re-rendered
  // by loadEarnings, so the element is looked up live each time).
  if (monthPopFor && monthPopFor.startsWith('earn:')) {
    const [, key, which] = monthPopFor.split(':');
    const wrap = document.querySelector(`[data-earn-range="${key}"]`);
    return wrap ? wrap.querySelector(`[data-earn-month="${which}"]`) : null;
  }
  return { start: $('#rangeStart'), end: $('#rangeEnd'), entryStart: $('#earnEntryStartBtn'), entryEnd: $('#earnEntryEndBtn') }[monthPopFor] || null;
}
function monthPopIsEntry() {
  return monthPopFor === 'entryStart' || monthPopFor === 'entryEnd';
}
function monthPopSpan() {
  if (monthPopIsEntry()) return { start: '2000-01', end: '2100-12' };
  // Earnings data is yearly (tax years): the picker browses the
  // data years as months; the picked month's YEAR drives the
  // filter, the button keeps the month label.
  if (monthPopFor && monthPopFor.startsWith('earn:')) {
    const years = (earnChartData && earnChartData.years) || [];
    if (!years.length) return null;
    return { start: `${years[0]}-01`, end: `${years[years.length - 1]}-12` };
  }
  return dataSpanMonths();
}
// Rent entry modal fields: a pick fills that field only — the
// button label (formatted month) and the hidden form input
// (YYYY-MM) — with no pair clamping and no refetch.
function setEntryMonth(which, ym) {
  const btn = which === 'entryStart' ? $('#earnEntryStartBtn') : $('#earnEntryEndBtn');
  const form = $('#earnRentalEntryForm');
  if (btn) { btn.dataset.value = ym || ''; btn.textContent = formatYM(ym); }
  if (form) form[which === 'entryStart' ? 'start_ym' : 'end_ym'].value = ym || '';
}
function renderMonthPop() {
  const pop = $('#monthPop');
  if (!pop || !monthPopFor) return;
  const span = monthPopSpan();
  if (!span) { closeMonthPop(); return; }
  const field = monthPopField();
  const selected = field ? field.dataset.value : '';
  // The stepper's bounds are the span's years, widened to include
  // the field's own year when a preset filled a pair reaching
  // past the span (a look-back can start a few months before the
  // first data point) — the current value must stay visible.
  const selYear = selected ? Number(selected.slice(0, 4)) : null;
  const minYear = Math.min(Number(span.start.slice(0, 4)), selYear ?? Infinity);
  const maxYear = Math.max(Number(span.end.slice(0, 4)), selYear ?? -Infinity);
  // An empty entry field opens on the current year, not on the
  // span's last year (2100 would be a long step back).
  if (monthPopYear == null) monthPopYear = selected ? Number(selected.slice(0, 4)) : (monthPopIsEntry() ? new Date().getFullYear() : maxYear);
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

function anchorMonthPop() {
  const pop = $('#monthPop');
  const field = monthPopField();
  if (!pop || !field) return;
  // Fixed positioning: the popover sits above modals too, so anchor
  // it to the field's viewport rect, clamped inside the viewport.
  const r = field.getBoundingClientRect();
  const left = Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 4));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

function openMonthPop(which) {
  monthPopFor = which;
  const field = monthPopField();
  if (!field || field.disabled) { monthPopFor = null; return; }
  monthPopYear = field.dataset.value ? Number(field.dataset.value.slice(0, 4)) : null;
  renderMonthPop();
  if (!monthPopFor) return; // no data span — renderMonthPop closed it
  const pop = $('#monthPop');
  pop.classList.remove('hidden');
  anchorMonthPop();
  for (const [key, el] of [['start', $('#rangeStart')], ['end', $('#rangeEnd')], ['entryStart', $('#earnEntryStartBtn')], ['entryEnd', $('#earnEntryEndBtn')]]) {
    if (el) el.setAttribute('aria-expanded', String(which === key));
  }
  document.querySelectorAll('[data-earn-month]').forEach((b) => {
    const wrap = b.closest('[data-earn-range]');
    b.setAttribute('aria-expanded', String(!!wrap && monthPopFor === `earn:${wrap.dataset.earnRange}:${b.dataset.earnMonth}`));
  });
}

function closeMonthPop() {
  monthPopFor = null;
  const pop = $('#monthPop');
  if (pop) pop.classList.add('hidden');
  for (const el of [$('#rangeStart'), $('#rangeEnd'), $('#earnEntryStartBtn'), $('#earnEntryEndBtn')]) {
    if (el) el.setAttribute('aria-expanded', 'false');
  }
  document.querySelectorAll('[data-earn-month]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function onMonthFieldClick(which) {
  if (monthPopFor === which) { closeMonthPop(); return; }
  openMonthPop(which);
}
$('#rangeStart').addEventListener('click', () => onMonthFieldClick('start'));
$('#rangeEnd').addEventListener('click', () => onMonthFieldClick('end'));
$('#earnEntryStartBtn').addEventListener('click', () => onMonthFieldClick('entryStart'));
$('#earnEntryEndBtn').addEventListener('click', () => onMonthFieldClick('entryEnd'));

$('#monthPop').addEventListener('click', (e) => {
  if (e.target.closest('#monthPopPrev')) { monthPopYear -= 1; renderMonthPop(); return; }
  if (e.target.closest('#monthPopNext')) { monthPopYear += 1; renderMonthPop(); return; }
  const cell = e.target.closest('button[data-ym]');
  if (!cell || cell.disabled || !monthPopFor) return;
  if (monthPopIsEntry()) { setEntryMonth(monthPopFor, cell.dataset.ym); closeMonthPop(); return; }
  // Earnings: the picked month's YEAR drives the year filter; the
  // button keeps the month label like every other picker.
  if (monthPopFor.startsWith('earn:')) {
    const [, key, which] = monthPopFor.split(':');
    const st = earnChartRanges[key];
    const btn = monthPopField();
    const ym = cell.dataset.ym;
    closeMonthPop();
    if (!st || !ym) return;
    const yr = Number(ym.slice(0, 4));
    if (which === 'from') { st.from = yr; st.fromYm = ym; } else { st.to = yr; st.toYm = ym; }
    if (btn) { btn.dataset.value = ym; btn.textContent = formatYM(ym); }
    document.querySelectorAll(`[data-earn-range="${key}"] [data-years]`).forEach((b) => b.classList.remove('active'));
    drawEarnVisibleChart();
    return;
  }
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
// Scrolling re-anchors the open popover to its field's current rect
// (same clamping as open), so it follows the field instead of
// stranding over other content; a field scrolled fully out of the
// viewport closes it. Capture phase catches scrolls from any
// container, including the modal overlay's own scroll.
window.addEventListener('scroll', () => {
  if (monthPopFor) {
    const field = monthPopField();
    if (!field) { closeMonthPop(); }
    else {
      const r = field.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) { closeMonthPop(); }
      else anchorMonthPop();
    }
  }
  // The invest popovers follow the same rule: glued to their field
  // while it is visible, closed once it scrolls out of view.
  if (invPop) {
    const field = document.getElementById(`invRange${invPop.which === 'start' ? 'Start' : 'End'}-${invPop.level}`);
    if (!field) { closeInvMonthPop(); }
    else {
      const r = field.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) { closeInvMonthPop(); }
      else anchorInvMonthPop();
    }
  }
}, { capture: true, passive: true });
document.addEventListener('click', (e) => {
  if (!monthPopFor) return;
  if (e.target.closest('#monthPop') || e.target.closest('#rangeStart') || e.target.closest('#rangeEnd') || e.target.closest('#earnEntryStartBtn') || e.target.closest('#earnEntryEndBtn') || e.target.closest('[data-earn-month]')) return;
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

// The two static Stocks detail sections get their range
// controls once at startup (the portfolio level re-renders its
// own on every load).
for (const level of ['investAccount', 'investHolding']) {
  const host = document.getElementById(`invRangeHost-${level}`);
  if (host) {
    host.innerHTML = investRangeControlsHtml(level);
    wireInvestRangeControls(level);
  }
}

// --------------------------------------------------------------- earnings ---
// Earnings: salary + rentals. Flows, never assets — nothing here feeds
// the net-worth summary. All computed figures come from the server;
// the panel only renders them.
let earnData = null;
let earnEditJobId = null;
let earnEditRentalId = null;
let earnYearRentalId = null;
let earnEditYearId = null;

// Next pay date highlight, shared by the job card and the job detail
// page: one rendering, one style. Dateless jobs get no line at all.
function earnNextPayHtml(j) {
  return j.next_pay_date
    ? `<div class="note earn-next-pay">Next pay date · ${esc(earnJobDateLabel(j.next_pay_date))}</div>`
    : '';
}

function earnJobCard(j) {
  const c = j.calc;
  const freqLabel = (earnData.payFrequencies.find((f) => f.key === j.frequency) || {}).label || j.frequency;
  return `<div class="panel earn-job-card" data-job-id="${j.id}" style="cursor:pointer">
    <div class="section-head"><h3>${esc(j.employer)}</h3><span class="note">${esc(j.province)} · ${esc(freqLabel)} · ${esc(j.currency)}</span>
    ${j.owner ? `<span style="margin-left:8px">${ownerChipsHtml([j.owner])}</span>` : ''}
    <div class="spacer"></div>
    <button class="small" onclick="earnEditJob(${j.id})">Edit</button>
    <button class="small danger" onclick="earnDeleteJob(${j.id})">Delete</button></div>
    ${earnNextPayHtml(j)}
    <div class="summary-strip">
      <div class="summary-card"><div class="k">Annual gross</div><div class="v">${money2(c.annualGross)}</div></div>
      <div class="summary-card"><div class="k">Annual net</div><div class="v">${money2(c.netAnnual)}</div></div>
      <div class="summary-card"><div class="k">Net per pay period</div><div class="v">${money2(c.perPeriod.net)}</div></div>
      <div class="summary-card"><div class="k">Total tax</div><div class="v">${money2(c.totalTax)}</div></div>
    </div>
    <table><tbody>
      <tr><td>Federal tax</td><td>${money2(c.federalTax)}</td><td>CPP</td><td>${money2(c.cpp)}</td></tr>
      <tr><td>Provincial tax (${esc(c.provinceLabel)})</td><td>${c.provincialTax == null ? '—' : money2(c.provincialTax)}</td><td>CPP2</td><td>${money2(c.cpp2)}</td></tr>
      <tr><td>Taxable income</td><td>${money2(c.taxableIncome)}</td><td>EI</td><td>${money2(c.ei)}</td></tr>
    </tbody></table>
    ${c.provincialTax == null ? `<div class="msg warn">Provincial table unverified — provincial tax is not computed for ${esc(j.province)}.</div>` : ''}
    ${c.warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join('')}
    <div class="note">${esc(c.estimateNote)}</div>
  </div>`;
}

function earnYearBlock(r, y) {
  const c = y.calc;
  const lines = Object.entries(c.expensesByLine).filter(([, v]) => v)
    .map(([line, v]) => `<tr><td>${line}</td><td>${money2(v)}</td></tr>`).join('');
  return `<div class="panel">
    <div class="section-head"><h3>${y.tax_year}</h3><div class="spacer"></div>
    <button class="small" onclick="earnEditYear(${r.id}, ${y.id})">Edit</button>
    <button class="small danger" onclick="earnDeleteYear(${r.id}, ${y.id})">Delete</button></div>
    <table><tbody>
      <tr><td>Gross rents (whole property)</td><td>${money2(c.grossWhole)}</td></tr>
      <tr><td>Rented days</td><td>${y.rental_days}${y.rent_derived ? ' (from rent entries)' : ''}</td></tr>
      <tr><td>Deductible expenses</td><td>${money2(c.deductibleExpenses)}</td></tr>
      <tr><td>Personal portion (9949)</td><td>${money2(c.personalPortion9949)}</td></tr>
      <tr><td>Net before CCA (9369)</td><td>${money2(c.netBeforeCca9369)}</td></tr>
      <tr><td>CCA claimed (9936)</td><td>${money2(c.ccaClaim9936)}</td></tr>
      <tr><td>Net, whole property (9946)</td><td>${money2(c.netWhole9946)}</td></tr>
      <tr><td>Owner share (${r.ownership_pct}%)</td><td>${money2(c.ownerShareNet)}</td></tr>
      <tr><td>Mortgage principal (never deductible)</td><td>${money2(c.mortgagePrincipal)}</td></tr>
    </tbody></table>
    ${lines ? `<table><tbody>${lines}</tbody></table>` : ''}
    <div class="note">Filing: ${esc(c.filing)} · GST/HST: ${esc(c.gst.status)} — ${esc(c.gst.note)}</div>
    ${c.warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join('')}
  </div>`;
}

const ymLabel = (ym) => {
  if (!ym) return 'Ongoing';
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};
function earnEntryBlock(r, e) {
  const bits = [`${ymLabel(e.start_ym)} – ${ymLabel(e.end_ym)}`, `${money2(e.monthly_rent)}/mo`, `paid on day ${e.pay_day}`];
  if (e.cash_amount !== null && e.cash_amount !== undefined) bits.push(`cash ${money2(e.cash_amount)}`);
  if (e.tenant_name) bits.push(esc(e.tenant_name));
  return `<div class="note">${bits.join(' · ')}
    <button class="small" onclick="earnEditEntry(${r.id}, ${e.id})">Edit</button>
    <button class="small danger" onclick="earnDeleteEntry(${r.id}, ${e.id})">Delete</button></div>`;
}

function earnRentalCard(r) {
  const hidden = rentHiddenRentals.has(r.id);
  return `<div class="panel rent-card">
    <button type="button" class="rent-hide-btn invest-eye-btn${hidden ? ' invest-eye-hidden' : ''}" data-rental-id="${r.id}" title="${hidden ? 'Show' : 'Hide'}" aria-label="${hidden ? 'Show' : 'Hide'}" onclick="toggleRentRental(${r.id})">${RENT_EYE_SVG}</button>
    <div class="section-head"><h3>${esc(r.label)}</h3><span class="note">${esc(r.rental_type)} · ${esc(r.services_level)} · ${r.ownership_pct}% owned</span>
    <div class="spacer"></div>
    <button class="small" onclick="earnAddEntry(${r.id})">+ Rent entry</button>
    <button class="small" onclick="earnEditRental(${r.id})">Edit</button>
    <button class="small danger" onclick="earnDeleteRental(${r.id})">Delete</button></div>
    ${(r.entries || []).length ? `<div><div class="note">Rent entries</div>${r.entries.map((e) => earnEntryBlock(r, e)).join('')}</div>` : ''}
    ${r.years.length ? r.years.map((y) => earnYearBlock(r, y)).join('') : '<div class="note">No year records yet.</div>'}
  </div>`;
}

async function loadEarnings() {
  try {
    if (!ownerUsers.length) await loadOwnerUsers();
    earnData = await api('/api/earnings');
    // Blank first options: a fresh Add form must not silently carry
    // the first province / frequency, and AI fill must be able to
    // fill a blank select (a non-empty value counts as hand-filled
    // and is never overwritten).
    $('#earnJobProvince').innerHTML = `<option value="">—</option>` + earnData.payrollProvinces.map((p) =>
      `<option value="${p.code}">${esc(p.label)}${p.verified ? '' : ' (unverified)'}</option>`).join('');
    $('#earnJobOwner').innerHTML = `<option value="">No owner</option>` + ownerUsers.map((u) =>
      `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    $('#earnJobFrequency').innerHTML = `<option value="">—</option>` + earnData.payFrequencies.map((f) =>
      `<option value="${f.key}">${esc(f.label)}</option>`).join('');
    // Rental property dropdown: the app's own properties, never BCA
    // search results. The standalone option stays first; a refill
    // keeps the current selection when it still exists.
    const earnProps = await api('/api/properties');
    const earnPropSel = $('#earnRentalProperty');
    const earnPropCur = earnPropSel.value;
    earnPropSel.innerHTML = `<option value="">— Standalone address —</option>` + earnProps.map((p) =>
      `<option value="${p.id}">${esc(p.address)}</option>`).join('');
    if (earnProps.some((p) => String(p.id) === earnPropCur)) earnPropSel.value = earnPropCur;
    $('#earnJobList').innerHTML = earnData.jobs.length
      ? earnData.jobs.map(earnJobCard).join('')
      : '<div class="note">No jobs yet.</div>';
    $('#earnRentalList').innerHTML = earnData.rentals.length
      ? earnData.rentals.map(earnRentalCard).join('')
      : '<div class="note">No rentals yet.</div>';
    investViewData.rentIncome = buildRentIncomeView(earnData.rentals);
    syncRentHideCards();
    try { earnChartData = await api('/api/earnings/charts'); } catch { earnChartData = null; }
    drawEarnVisibleChart();
  } catch (e) { showMsg($('#earnSalaryMsg'), 'err', e.message); }
}

// ------------------------------------------------------- earn charts ---
// Earnings charts read the server's aggregation over stored records —
// the panels never recompute tax. Every chart's axis is tax years
// (jobs and rental years are annual figures), so the range control
// is year-based: presets 1/2/5/10y/All plus From/To year selects,
// the same shape as the property/stocks range precedent. Legend
// gestures follow the app standard: left click toggles a series
// (Chart.js default), right click opens that chart's Colors panel
// (the only entry, wired above).
let earnOverviewChart = null;
let earnSalaryChart = null;
let earnRentalsChart = null;
let earnRentalsView = 'net';
const earnChartRanges = {
  overview: { years: 0, from: null, to: null, fromYm: null, toYm: null },
  salary: { years: 0, from: null, to: null, fromYm: null, toYm: null },
  rentals: { years: 0, from: null, to: null, fromYm: null, toYm: null },
};

function earnRangeControlsHtml(key) {
  const st = earnChartRanges[key];
  const presets = [[1, '1 year'], [2, '2 years'], [5, '5 years'], [10, '10 years'], [0, 'All']];
  // The same month-field buttons + shared #monthPop the
  // property-detail panel uses (never native year selects: their
  // popup renders detached from the panel). The button keeps the
  // picked month's label; the picked month's YEAR drives the
  // existing year filter below.
  return `<div class="toolbar range-btns" data-earn-range="${key}">`
    + presets.map(([n, label]) => `<button type="button" data-years="${n}" class="${st.years === n && st.from == null && st.to == null ? 'active' : ''}">${label}</button>`).join('')
    + `<span class="range-pick">From <button type="button" data-earn-month="from" class="month-field" data-value="${st.fromYm || ''}" aria-haspopup="dialog" aria-expanded="false" aria-label="Range start month">${formatYM(st.fromYm)}</button></span>`
    + `<span class="range-pick">To <button type="button" data-earn-month="to" class="month-field" data-value="${st.toYm || ''}" aria-haspopup="dialog" aria-expanded="false" aria-label="Range end month">${formatYM(st.toYm)}</button></span></div>`;
}

function earnWireRange(key) {
  const wrap = document.querySelector(`[data-earn-range="${key}"]`);
  if (!wrap) return;
  const st = earnChartRanges[key];
  wrap.querySelectorAll('[data-years]').forEach((b) => {
    b.onclick = () => {
      st.years = Number(b.dataset.years); st.from = null; st.to = null; st.fromYm = null; st.toYm = null;
      wrap.querySelectorAll('[data-earn-month]').forEach((f) => { f.dataset.value = ''; f.textContent = '—'; f.setAttribute('aria-expanded', 'false'); });
      drawEarnVisibleChart();
    };
  });
  const from = wrap.querySelector('[data-earn-month="from"]');
  const to = wrap.querySelector('[data-earn-month="to"]');
  if (from) from.onclick = () => earnMonthFieldClick(key, 'from');
  if (to) to.onclick = () => earnMonthFieldClick(key, 'to');
}

function earnMonthFieldClick(key, which) {
  const k = `earn:${key}:${which}`;
  if (monthPopFor === k) { closeMonthPop(); return; }
  openMonthPop(k);
}

function earnEffectiveYears(key) {
  const all = (earnChartData && earnChartData.years) || [];
  if (!all.length) return [];
  const st = earnChartRanges[key];
  if (st.from != null || st.to != null) {
    return all.filter((y) => (st.from == null || y >= st.from) && (st.to == null || y <= st.to));
  }
  if (!st.years) return all;
  const max = all[all.length - 1];
  return all.filter((y) => y > max - st.years);
}

function earnChartBase() {
  return {
    options: {
      responsive: true,
      scales: { x: { stacked: false }, y: { beginAtZero: true, ticks: { callback: (v) => '$' + Number(v).toLocaleString() } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
    },
  };
}

function earnSetEmpty(canvasId, emptyId, empty) {
  const canvas = document.getElementById(canvasId);
  if (canvas) canvas.parentElement.classList.toggle('hidden', empty);
  const note = document.getElementById(emptyId);
  if (note) note.classList.toggle('hidden', !empty);
}

function drawEarnOverviewChart() {
  const years = earnEffectiveYears('overview');
  if (earnOverviewChart) { earnOverviewChart.destroy(); earnOverviewChart = null; window.__fmCharts.earnOverview = null; }
  const empty = !earnChartData || !years.length;
  earnSetEmpty('earnOverviewChart', 'earnOverviewEmpty', empty);
  if (empty) return;
  const ov = earnChartData.overview;
  const ds = (key, label, values, stack, hidden) => {
    const def = seriesDefFor('earnOverview', key);
    const c = seriesColors('earnOverview', def);
    return { key, label: def ? def.label : label, data: values, backgroundColor: c.backgroundColor, borderColor: c.borderColor, borderWidth: 1, stack, hidden: !!hidden };
  };
  const datasets = [
    ds('salary', 'Salary net', years.map((y) => (ov[y] && ov[y].salaryNet) || 0), 'income', false),
    ds('rental', 'Rental net', years.map((y) => (ov[y] && ov[y].rentalNet) || 0), 'income', false),
  ];
  // Per-earner salary series: hidden by default — the legend
  // switches the view from totals to people. They stack with the
  // totals, so showing both double-counts; that is the user's
  // explicit legend choice, as with portfolio totals vs properties.
  earnChartData.earners.forEach((e) => {
    datasets.push(ds(`earner:${e}`, `${e} salary net`, years.map((y) => (ov[y] && ov[y].earners && ov[y].earners[e]) || 0), 'income', true));
  });
  const base = earnChartBase();
  base.options.scales.x.stacked = true;
  base.options.scales.y.stacked = true;
  earnOverviewChart = new Chart($('#earnOverviewChart'), { type: 'bar', data: { labels: years.map(String), datasets }, ...base });
  window.__fmCharts.earnOverview = earnOverviewChart;
}

function drawEarnSalaryChart() {
  const years = earnEffectiveYears('salary');
  if (earnSalaryChart) { earnSalaryChart.destroy(); earnSalaryChart = null; window.__fmCharts.earnSalary = null; }
  const empty = !earnChartData || !years.length || !earnChartData.employers.length;
  earnSetEmpty('earnSalaryChart', 'earnSalaryEmpty', empty);
  if (empty) return;
  const s = earnChartData.salary;
  const ds = (key, values, type, hidden) => {
    const def = seriesDefFor('earnSalary', key);
    const c = seriesColors('earnSalary', def);
    return { key, label: def ? def.label : key, data: values, backgroundColor: c.backgroundColor, borderColor: c.borderColor, borderWidth: type === 'line' ? 2 : 1, type, hidden: !!hidden };
  };
  const datasets = [
    ds('gross', years.map((y) => (s[y] && s[y].gross) || 0), 'bar', false),
    ds('net', years.map((y) => (s[y] && s[y].net) || 0), 'bar', false),
  ];
  // Per-employer net lines: hidden by default, legend toggles.
  // The CPP/EI cap jump is in the stored net figures, so the
  // lines show it faithfully — nothing is recomputed here.
  earnChartData.employers.forEach((e) => {
    datasets.push(ds(`employer:${e}`, years.map((y) => (s[y] && s[y].employers && s[y].employers[e] ? s[y].employers[e].net : 0)), 'line', true));
  });
  earnSalaryChart = new Chart($('#earnSalaryChart'), { type: 'bar', data: { labels: years.map(String), datasets }, ...earnChartBase() });
  window.__fmCharts.earnSalary = earnSalaryChart;
}

function drawEarnRentalsChart() {
  const years = earnEffectiveYears('rentals');
  if (earnRentalsChart) { earnRentalsChart.destroy(); earnRentalsChart = null; window.__fmCharts.earnRentals = null; }
  const empty = !earnChartData || !years.length || !earnChartData.properties.length;
  earnSetEmpty('earnRentalsChart', 'earnRentalsEmpty', empty);
  if (empty) return;
  const r = earnChartData.rentals;
  const ds = (key, values, stack) => {
    const def = seriesDefFor('earnRentals', key);
    const c = seriesColors('earnRentals', def);
    return { key, label: def ? def.label : key, data: values, backgroundColor: c.backgroundColor, borderColor: c.borderColor, borderWidth: 1, stack: stack || undefined };
  };
  let datasets;
  if (earnRentalsView === 'income') {
    // Income vs expenses: stacked totals per year.
    datasets = [
      ds('gross', years.map((y) => (r[y] && r[y].gross) || 0), 'total'),
      ds('expenses', years.map((y) => (r[y] && r[y].expenses) || 0), 'total'),
    ];
  } else {
    // Net by property: one bar series per rental, 9946 net.
    // Owner-share net rides in the year table, not the chart —
    // the chart is whole-property net, matching the overview.
    datasets = earnChartData.properties.map((p) => ds(`rental:${p.id}`,
      years.map((y) => (r[y] && r[y].properties && r[y].properties[p.id] ? r[y].properties[p.id].net : 0))));
  }
  const base = earnChartBase();
  if (earnRentalsView === 'income') { base.options.scales.x.stacked = true; base.options.scales.y.stacked = true; }
  earnRentalsChart = new Chart($('#earnRentalsChart'), { type: 'bar', data: { labels: years.map(String), datasets }, ...base });
  window.__fmCharts.earnRentals = earnRentalsChart;
}

function drawEarnVisibleChart() {
  const sub = (location.hash.split('/')[1] || 'salary');
  if (sub === 'overview') {
    $('#earnOverviewRange').innerHTML = earnRangeControlsHtml('overview');
    earnWireRange('overview');
    drawEarnOverviewChart();
  } else if (sub === 'rentals') {
    $('#earnRentalsRange').innerHTML = earnRangeControlsHtml('rentals');
    earnWireRange('rentals');
    drawEarnRentalsChart();
    drawRentIncomePanel();
  } else {
    $('#earnSalaryRange').innerHTML = earnRangeControlsHtml('salary');
    earnWireRange('salary');
    drawEarnSalaryChart();
  }
}

// ------------------------------------------------- rentals income panel --
// Total income over the selected range, from rent entries only: LEFT
// share doughnut (one slice per rental, share of range income —
// income is a flow, so this is deliberately NOT the Stocks
// range-end point-in-time share) + RIGHT monthly history (stacked
// bars per rental + total line), driven by the Stocks range picker
// (same presets + month popover machinery, level 'rentIncome').
// Year-record other income (8230), expenses and the T776
// computation never enter this panel. Per-rental Hide mirrors
// Stocks exactly: the same open/closed eye-pair button at the
// card's top-right corner, one per-visit hidden set shared with
// both charts' legends, card greys out. Hide affects this panel
// only — never entries, years or tax calcs.
let rentIncomeChart = null;
let rentIncomeShareChart = null;
let rentIncomeShareRentals = []; // rentals in doughnut order
let rentIncomeShareCenter = null; // { total } for the center plugin
const rentHiddenRentals = new Set();
const RENT_INCOME_COLORS = ['#8d6e00', '#5d4037', '#283593', '#00695c', '#ad1457', '#4527a0', '#558b2f', '#6a1b9a', '#37474f', '#9e9d24'];
function rentRentalColor(rental) {
  const id = Math.abs(Number(rental && rental.id) || 0);
  return RENT_INCOME_COLORS[id % RENT_INCOME_COLORS.length];
}
// The Stocks eye button's SVG, verbatim: open eye (almond + dot
// pupil) and closed eye (downward arc + lashes); the shared
// .invest-eye-btn / .invest-eye-hidden CSS flips between them.
const RENT_EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="eye-open"><path d="M2 12C6 5.5 18 5.5 22 12C18 18.5 6 18.5 2 12Z"/><circle cx="12" cy="12" r="3" fill="none"/></g><g class="eye-closed"><path d="M4 8.5Q12 17 20 8.5"/><line x1="5.5" y1="12" x2="4" y2="14.5"/><line x1="8.5" y1="14.5" x2="7.5" y2="17"/><line x1="12" y1="15.5" x2="12" y2="18"/><line x1="15.5" y1="14.5" x2="16.5" y2="17"/><line x1="18.5" y1="12" x2="20" y2="14.5"/></g></svg>`;

const rentIncomeShareCenterPlugin = {
  id: 'rentIncomeShareCenter',
  afterDraw(chart) {
    if (!rentIncomeShareCenter || chart !== rentIncomeShareChart) return;
    const area = chart.chartArea;
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const c = chart.ctx;
    c.save();
    c.textAlign = 'center';
    c.fillStyle = '#71808f';
    c.font = '11px system-ui, sans-serif';
    c.fillText('Total income', x, y - 4);
    c.fillStyle = '#22303c';
    c.font = '700 14px system-ui, sans-serif';
    c.fillText(moneyC(rentIncomeShareCenter.total, 'CAD'), x, y + 14);
    c.restore();
  },
};

function drawRentIncomeShareChart(d, r) {
  const canvas = $('#rentIncomeShareChart');
  if (!canvas) return false;
  const { rows, visibleTotal } = rentRangeShare(d.rentSeries, r, rentHiddenRentals);
  rentIncomeShareRentals = rows.map((x) => x.rental);
  const title = $('#rentIncomeShareTitle');
  if (title) title.textContent = r ? `Income share · ${formatYM(r.start)} – ${formatYM(r.end)}` : 'Income share';
  const empty = $('#rentIncomeShareEmpty');
  const wrap = $('#rentIncomeShareWrap');
  const mainWrap = $('#rentIncomeMainWrap');
  if (!rows.length) {
    if (rentIncomeShareChart) { rentIncomeShareChart.destroy(); rentIncomeShareChart = null; }
    rentIncomeShareCenter = null;
    window.__fmCharts.rentIncomeShare = null;
    window.__fmCharts.rentIncomeShareCenter = null;
    if (wrap) wrap.classList.add('hidden');
    if (mainWrap) mainWrap.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return false;
  }
  if (wrap) wrap.classList.remove('hidden');
  if (mainWrap) mainWrap.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');
  rentIncomeShareCenter = { total: visibleTotal };
  if (rentIncomeShareChart) rentIncomeShareChart.destroy();
  rentIncomeShareChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map((x) => x.rental.label),
      datasets: [{
        data: rows.map((x) => x.value),
        backgroundColor: rows.map((x) => rentRentalColor(x.rental)),
        borderColor: '#fff', borderWidth: 1,
        hoverOffset: 10, // Property/invest doughnut parity: the slice pops out on hover.
      }],
    },
    plugins: [rentIncomeShareCenterPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: {
          position: 'bottom', labels: { boxWidth: 12 },
          onClick: (e, item) => { const x = rentIncomeShareRentals[item.index]; if (x) toggleRentRental(x.id); },
        },
        tooltip: {
          callbacks: {
            label: (item) => {
              // The % is over the VISIBLE slices only, matching the center total.
              const t = item.dataset.data.reduce((s, v, i) => s + (item.chart.getDataVisibility(i) ? v : 0), 0);
              const pct = t ? ((item.parsed / t) * 100).toFixed(1) : '0.0';
              return ` ${item.label}: ${moneyC(item.parsed, 'CAD')} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  rentIncomeShareRentals.forEach((x, i) => {
    if (rentHiddenRentals.has(x.id) && rentIncomeShareChart.getDataVisibility(i)) rentIncomeShareChart.toggleDataVisibility(i);
  });
  rentIncomeShareChart.update();
  window.__fmCharts.rentIncomeShare = rentIncomeShareChart;
  window.__fmCharts.rentIncomeShareCenter = rentIncomeShareCenter;
  return true;
}

function drawRentIncomeHistoryChart(canvas, d, r) {
  if (!canvas) return null;
  const hist = rentHistoryData(d.rentSeries, r, rentHiddenRentals);
  const bars = hist.perRental.map((p) => ({
    type: 'bar', label: p.rental.label, rentalId: p.rental.id, data: p.values,
    backgroundColor: rentRentalColor(p.rental), stack: 'income', order: 3, maxBarThickness: 28,
  }));
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hist.months,
      datasets: [
        ...bars,
        { label: 'Total (CAD)', data: hist.totals, borderColor: '#22303c', backgroundColor: '#22303c', tension: 0.15, pointRadius: 0, borderWidth: 2, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: moneyTick } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 }, onClick: rentLegendClick },
        tooltip: {
          callbacks: {
            label: (c) => {
              const ds = c.dataset;
              if (ds.rentalId != null) {
                const total = c.chart.data.datasets.reduce((s, dd, i) => s + (dd.rentalId != null && c.chart.isDatasetVisible(i) ? (dd.data[c.dataIndex] || 0) : 0), 0);
                const pct = total ? ((c.parsed.y / total) * 100).toFixed(1) : '0.0';
                return `${ds.label}: ${moneyC(c.parsed.y, 'CAD')} (${pct}%)`;
              }
              return `${c.dataset.label}: ${moneyC(c.parsed.y, 'CAD')}`;
            },
          },
        },
      },
    },
    plugins: [guideLinePlugin],
  });
  bars.forEach((ds, i) => { if (rentHiddenRentals.has(ds.rentalId)) chart.setDatasetVisibility(i, false); });
  chart.update();
  window.__fmCharts.rentIncome = chart;
  return chart;
}

function toggleRentRental(id) {
  if (rentHiddenRentals.has(id)) rentHiddenRentals.delete(id);
  else rentHiddenRentals.add(id);
  syncRentHideCards();
  applyInvestRange('rentIncome');
}

// Card eye buttons mirror the hidden set: a hidden card is greyed
// and its eye icon closes (open eye when visible, closed eye when
// hidden). Runs after every render that rebuilds the cards and
// after every toggle, so the legend and the cards can never
// disagree. NOTE: rental buttons carry .rent-hide-btn, never
// .invest-hide-btn — the invest sync queries the latter globally
// and would otherwise clobber rental state.
function syncRentHideCards() {
  document.querySelectorAll('.rent-hide-btn').forEach((btn) => {
    const hidden = rentHiddenRentals.has(Number(btn.dataset.rentalId));
    btn.classList.toggle('invest-eye-hidden', hidden);
    btn.title = hidden ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', btn.title);
    const card = btn.closest('.rent-card');
    if (card) card.classList.toggle('rent-hidden-card', hidden);
  });
}

function rentLegendClick(e, item, legend) {
  const chart = legend.chart;
  const ds = chart.data.datasets[item.datasetIndex];
  if (ds && ds.rentalId != null) { toggleRentRental(ds.rentalId); return; }
  chart.setDatasetVisibility(item.datasetIndex, !chart.isDatasetVisible(item.datasetIndex));
  chart.update();
}

function buildRentIncomeView(rentals) {
  const now = new Date();
  const nowYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rentSeries = rentMonthlySeries(rentals, nowYm);
  return {
    monthly: rentSeries.flatMap((s) => s.months.map((m) => ({ month: m.month, rentalId: s.rental.id, value: m.value }))),
    series: [],
    rentSeries,
  };
}

function drawRentIncomePanel() {
  const wrap = $('#rentIncomeRange');
  if (wrap && !wrap.innerHTML.trim()) {
    wrap.innerHTML = investRangeControlsHtml('rentIncome');
    wireInvestRangeControls('rentIncome');
  }
  applyInvestRange('rentIncome');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest ? e.target.closest('#earnRentalsViewBtns [data-view]') : null;
  if (!btn) return;
  earnRentalsView = btn.dataset.view;
  document.querySelectorAll('#earnRentalsViewBtns [data-view]').forEach((b) => b.classList.toggle('active', b === btn));
  drawEarnRentalsChart();
});

function earnReadForm(form) {
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = v; });
  for (const el of form.querySelectorAll('input[type=checkbox]')) data[el.name] = el.checked;
  return data;
}

// ------------------------------------------------------------ job modal --
// The simplified form asks only for key facts; annual gross, tax
// year and YTD CPP / CPP2 / EI are derived server-side from the
// start date, recent pay date and recent pay value. Pay-change rows
// (raises) and bonus rows are repeatable lists inside the modal.
// A job edited without dates keeps its stored gross / tax year /
// YTD untouched (the server leaves derived columns alone on a
// legacy save), so old jobs keep computing exactly as before.
let earnEditJobOrig = null;

function earnJobRepeatRow(kind, values) {
  const wrap = document.createElement('div');
  if (kind === 'pay_change') {
    wrap.innerHTML = `<input type="date" data-pc-date value="${esc(values?.effective_date || '')}">
      <input type="text" inputmode="decimal" data-money data-pc-value placeholder="New per-period value" value="${values?.value == null ? '' : esc(formatMoneyInput(values.value))}">
      <button type="button" class="small" onclick="this.parentElement.remove()">Remove</button>`;
  } else {
    wrap.innerHTML = `<input type="date" data-bonus-date value="${esc(values?.date || '')}">
      <input type="text" inputmode="decimal" data-money data-bonus-amount placeholder="Amount" value="${values?.amount == null ? '' : esc(formatMoneyInput(values.amount))}">
      <button type="button" class="small" onclick="this.parentElement.remove()">Remove</button>`;
  }
  wrap.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  return wrap;
}
const earnJobPayChanges = () => [...document.querySelectorAll('#earnJobPayChangeRows > div')].map((row) => ({
  effective_date: row.querySelector('[data-pc-date]').value,
  value: parseMoneyInput(row.querySelector('[data-pc-value]').value),
}));
const earnJobBonuses = () => [...document.querySelectorAll('#earnJobBonusRows > div')].map((row) => ({
  date: row.querySelector('[data-bonus-date]').value,
  amount: parseMoneyInput(row.querySelector('[data-bonus-amount]').value),
}));
$('#earnJobPayChangeAddBtn').onclick = () => $('#earnJobPayChangeRows').appendChild(earnJobRepeatRow('pay_change'));
$('#earnJobBonusAddBtn').onclick = () => $('#earnJobBonusRows').appendChild(earnJobRepeatRow('bonus'));

function earnJobResetModal(title) {
  $('#earnJobFormTitle').textContent = title;
  $('#earnJobForm').reset();
  $('#earnJobPayChangeRows').innerHTML = '';
  $('#earnJobBonusRows').innerHTML = '';
  showMsg($('#earnJobModalMsg'), '', '');
  earnJobPayBasisLabel();
}

// The payment field takes a gross or a take-home value; the label
// follows the toggle so the mode is never ambiguous. Editing a job
// always shows the gross field (the toggle resets to Gross).
function earnJobPayBasisLabel() {
  const basis = document.querySelector('#earnJobForm [name=pay_value_basis]:checked')?.value || 'gross';
  $('#earnJobPayValueLabel').textContent = basis === 'takehome'
    ? 'Recent payment take-home value * (one pay period)'
    : 'Recent payment gross value * (one pay period)';
}
document.querySelectorAll('#earnJobForm [name=pay_value_basis]').forEach((r) => r.addEventListener('change', earnJobPayBasisLabel));

$('#addEarnJobBtn').onclick = () => {
  earnEditJobId = null;
  earnEditJobOrig = null;
  earnJobResetModal('Add job');
  openModal('earnJobModal');
};
// Clicking a job card (anywhere but its buttons) opens its detail page.
$('#earnJobList').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  const card = e.target.closest('.earn-job-card');
  if (card) location.hash = '#earnings/job/' + card.dataset.jobId;
});
$('#earnJobForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const f = e.target;
    const data = earnReadForm(f);
    parseMoneyFields(data, ['recent_pay_value']);
    const start = data.start_date || '';
    const recent = data.recent_pay_date || '';
    const value = data.recent_pay_value;
    const hasAny = !!(start || recent || (value !== '' && value != null));
    // Rows: fully-empty rows are dropped; partially-filled rows are
    // an error (the server would otherwise read a blank value as 0).
    const dropEmpty = (rows, dateKey, valKey, label) => {
      const kept = [];
      for (const r of rows) {
        const d = r[dateKey];
        const v = r[valKey];
        if (!d && (v === '' || v == null)) continue;
        if (!d || v === '' || v == null) throw new Error(`Each ${label} needs a date and an amount.`);
        kept.push(r);
      }
      return kept;
    };
    const payChanges = dropEmpty(earnJobPayChanges(), 'effective_date', 'value', 'pay change');
    const bonuses = dropEmpty(earnJobBonuses(), 'date', 'amount', 'bonus');
    let body;
    if (earnEditJobId == null || hasAny) {
      if (!start || !recent || value === '' || value == null) {
        showMsg($('#earnJobModalMsg'), 'err', 'Job start date, recent payment date and recent payment value are all required.');
        return;
      }
      body = {
        employer: data.employer, owner: data.owner, currency: data.currency || 'CAD',
        province: data.province, frequency: data.frequency,
        start_date: start, recent_pay_date: recent, recent_pay_value: value,
        pay_value_basis: data.pay_value_basis || 'gross',
        pay_changes: payChanges, bonuses,
      };
    } else {
      // Edit without dates: preserve the stored gross / tax year /
      // YTD / TD1 / exemptions verbatim — the server leaves the
      // derived columns and child rows alone on a legacy save.
      const o = earnEditJobOrig;
      body = {
        employer: data.employer, owner: data.owner, currency: data.currency || 'CAD',
        province: data.province, frequency: data.frequency,
        gross_amount: o.gross_amount, gross_basis: o.gross_basis, tax_year: o.tax_year,
        td1_federal: o.td1_federal ?? '', td1_provincial: o.td1_provincial ?? '',
        ytd_cpp: o.ytd_cpp, ytd_cpp2: o.ytd_cpp2, ytd_ei: o.ytd_ei,
        cpp_exempt: o.cpp_exempt, ei_exempt: o.ei_exempt,
      };
    }
    if (earnEditJobId) await api(`/api/earnings/jobs/${earnEditJobId}`, { method: 'PUT', body });
    else await api('/api/earnings/jobs', { method: 'POST', body });
    closeModalEl($('#earnJobModal'));
    await loadEarnings();
    if (location.hash.startsWith('#earnings/job/')) loadEarnJobDetail(Number(location.hash.split('/')[2]));
  } catch (err) { showMsg($('#earnJobModalMsg'), 'err', err.message); }
};
window.earnEditJob = (id) => {
  const j = earnData.jobs.find((x) => x.id === id);
  if (!j) return;
  earnJobResetModal('Edit job');
  earnEditJobId = id;
  earnEditJobOrig = j;
  const f = $('#earnJobForm');
  f.employer.value = j.employer; f.owner.value = j.owner || ''; f.currency.value = j.currency; f.province.value = j.province;
  f.frequency.value = j.frequency; f.start_date.value = j.start_date || ''; f.recent_pay_date.value = j.recent_pay_date || '';
  // Recent value is the current per-period rate; for an old
  // annual-basis job, the per-period equivalent, so the field
  // always shows a rate. Editing always shows the gross field.
  const periods = (earnData.payFrequencies.find((x) => x.key === j.frequency) || {}).periods || 1;
  const perPeriod = j.gross_basis === 'period' ? j.gross_amount : j.gross_amount / periods;
  setMoneyValue(f.recent_pay_value, perPeriod);
  f.querySelector('[name=pay_value_basis][value=gross]').checked = true;
  earnJobPayBasisLabel();
  for (const c of j.pay_changes || []) $('#earnJobPayChangeRows').appendChild(earnJobRepeatRow('pay_change', c));
  for (const b of j.bonuses || []) $('#earnJobBonusRows').appendChild(earnJobRepeatRow('bonus', b));
  openModal('earnJobModal');
};
attachAiFill($('#earnJobForm'), 'job', {
  jobRows: {
    getPayChanges: earnJobPayChanges,
    getBonuses: earnJobBonuses,
    setPayChanges: (rows) => {
      const c = $('#earnJobPayChangeRows');
      c.innerHTML = '';
      rows.forEach((r) => c.appendChild(earnJobRepeatRow('pay_change', r)));
    },
    setBonuses: (rows) => {
      const c = $('#earnJobBonusRows');
      c.innerHTML = '';
      rows.forEach((r) => c.appendChild(earnJobRepeatRow('bonus', r)));
    },
  },
});
window.earnDeleteJob = async (id) => {
  if (!confirm('Delete this job?')) return;
  try {
    await api(`/api/earnings/jobs/${id}`, { method: 'DELETE' });
  } catch (err) {
    // A linked-plan guard (400) must surface instead of failing silently.
    const detailVisible = !$('#earnJobDetail').classList.contains('hidden');
    const m = detailVisible ? $('#earnJobDetailMsg') : $('#earnSalaryMsg');
    if (m) showMsg(m, 'err', err.message);
    return;
  }
  await loadEarnings();
  if (location.hash.startsWith('#earnings/job/')) location.hash = '#earnings/salary';
};

// ------------------------------------------------------- job detail --
// A job card opens its own detail page (property/account detail
// pattern). Pay changes and bonuses are added, edited and deleted
// here; the job itself is edited and deleted from its card, so the
// detail header carries no Edit/Delete buttons.
let currentEarnJobId = null;

function earnJobPerPeriod(j) {
  const periods = (earnData.payFrequencies.find((x) => x.key === j.frequency) || {}).periods || 1;
  return j.gross_basis === 'period' ? j.gross_amount : j.gross_amount / periods;
}

function earnJobDateLabel(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

function earnJobDetailHtml(j) {
  const c = j.calc;
  const freqLabel = (earnData.payFrequencies.find((f) => f.key === j.frequency) || {}).label || j.frequency;
  const pcRows = (j.pay_changes || []).map((r, i) => `<div class="note">${earnJobDateLabel(r.effective_date)} · ${money2(r.value)}/period
    <button class="small" onclick="earnJobDetailOpenRow('pay_change', ${i})">Edit</button>
    <button class="small danger" onclick="earnJobDetailDeleteRow('pay_change', ${i})">Delete</button></div>`).join('');
  const bonusRows = (j.bonuses || []).map((b, i) => `<div class="note">${earnJobDateLabel(b.date)} · ${money2(b.amount)}
    <button class="small" onclick="earnJobDetailOpenRow('bonus', ${i})">Edit</button>
    <button class="small danger" onclick="earnJobDetailDeleteRow('bonus', ${i})">Delete</button></div>`).join('');
  return `<div class="section-head"><button class="small" onclick="location.hash='#earnings/salary'">← Back to Salary</button><div class="spacer"></div></div>
    <div class="msg" id="earnJobDetailMsg"></div>
    <div class="panel">
      <div class="section-head"><h3>${esc(j.employer)}</h3><span class="note">${esc(j.province)} · ${esc(freqLabel)} · ${esc(j.currency)}</span>
      ${j.owner ? `<span style="margin-left:8px">${ownerChipsHtml([j.owner])}</span>` : ''}
      <div class="spacer"></div></div>
      ${earnNextPayHtml(j)}
      <div class="summary-strip">
        <div class="summary-card"><div class="k">Annual gross</div><div class="v">${money2(c.annualGross)}</div></div>
        <div class="summary-card"><div class="k">Annual net</div><div class="v">${money2(c.netAnnual)}</div></div>
        <div class="summary-card"><div class="k">Net per pay period</div><div class="v">${money2(c.perPeriod.net)}</div></div>
        <div class="summary-card"><div class="k">Total tax</div><div class="v">${money2(c.totalTax)}</div></div>
      </div>
      <table><tbody>
        <tr><td>Federal tax</td><td>${money2(c.federalTax)}</td><td>CPP</td><td>${money2(c.cpp)}</td></tr>
        <tr><td>Provincial tax (${esc(c.provinceLabel)})</td><td>${c.provincialTax == null ? '—' : money2(c.provincialTax)}</td><td>CPP2</td><td>${money2(c.cpp2)}</td></tr>
        <tr><td>Taxable income</td><td>${money2(c.taxableIncome)}</td><td>EI</td><td>${money2(c.ei)}</td></tr>
      </tbody></table>
      ${c.provincialTax == null ? `<div class="msg warn">Provincial table unverified — provincial tax is not computed for ${esc(j.province)}.</div>` : ''}
      ${c.warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join('')}
      <div class="note">${esc(c.estimateNote)}</div>
      <div class="note">Job start ${esc(j.start_date || '—')} · Recent payment ${esc(j.recent_pay_date || '—')} · Current per-period value ${money2(earnJobPerPeriod(j))}</div>
    </div>
    <div class="panel">
      <div class="section-head"><h3>Pay changes</h3><div class="spacer"></div><button class="small" id="earnJobDetailAddPayChange" onclick="earnJobDetailOpenRow('pay_change', null)">+ Pay change</button></div>
      ${pcRows || '<div class="note">No pay changes yet.</div>'}
    </div>
    <div class="panel">
      <div class="section-head"><h3>Bonuses</h3><div class="spacer"></div><button class="small" id="earnJobDetailAddBonus" onclick="earnJobDetailOpenRow('bonus', null)">+ Bonus</button></div>
      ${bonusRows || '<div class="note">No bonuses yet.</div>'}
    </div>`;
}

async function loadEarnJobDetail(id) {
  try {
    await loadEarnings();
    const j = earnData.jobs.find((x) => x.id === id);
    if (!j) { location.hash = '#earnings/salary'; return; }
    currentEarnJobId = id;
    $('#earnJobDetail').innerHTML = earnJobDetailHtml(j);
  } catch (e) {
    const m = $('#earnJobDetailMsg');
    if (m) showMsg(m, 'err', e.message);
  }
}

// Row add/edit/delete on the detail page go through the same PUT the
// job modal uses: the full derived body (dates + current per-period
// rate + whole child lists), so the server re-derives annual gross,
// tax year and YTD exactly as a modal save would. A job without dates
// has no derived shape, so its row buttons open the full Edit modal
// instead (which preserves a legacy save).
function earnJobDetailDerivedBody(j, payChanges, bonuses, recentValue) {
  return {
    employer: j.employer, owner: j.owner ?? '', currency: j.currency || 'CAD',
    province: j.province, frequency: j.frequency,
    start_date: j.start_date, recent_pay_date: j.recent_pay_date, recent_pay_value: recentValue,
    pay_changes: payChanges, bonuses,
  };
}

async function earnJobDetailPut(j, payChanges, bonuses, recentValue) {
  await api(`/api/earnings/jobs/${j.id}`, {
    method: 'PUT',
    body: earnJobDetailDerivedBody(j, payChanges, bonuses, recentValue),
  });
  loadEarnJobDetail(j.id);
}

let earnJobRowState = null; // { kind: 'pay_change'|'bonus', index: number|null }
window.earnJobDetailOpenRow = (kind, index) => {
  const j = earnData.jobs.find((x) => x.id === currentEarnJobId);
  if (!j) return;
  if (!j.start_date || !j.recent_pay_date) { earnEditJob(j.id); return; }
  const list = kind === 'pay_change' ? (j.pay_changes || []) : (j.bonuses || []);
  const row = index == null ? null : list[index];
  earnJobRowState = { kind, index };
  $('#earnJobRowFormTitle').textContent = kind === 'pay_change'
    ? (index == null ? 'Add pay change' : 'Edit pay change')
    : (index == null ? 'Add bonus' : 'Edit bonus');
  $('#earnJobRowDateLabel').textContent = kind === 'pay_change' ? 'Effective date *' : 'Date *';
  $('#earnJobRowValueLabel').textContent = kind === 'pay_change' ? 'New per-period value *' : 'Amount *';
  const f = $('#earnJobRowForm');
  f.reset();
  if (row) {
    f.row_date.value = kind === 'pay_change' ? row.effective_date : row.date;
    setMoneyValue(f.row_value, kind === 'pay_change' ? row.value : row.amount);
  }
  showMsg($('#earnJobRowModalMsg'), '', '');
  openModal('earnJobRowModal');
};

$('#earnJobRowForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const j = earnData.jobs.find((x) => x.id === currentEarnJobId);
    if (!j || !earnJobRowState) return;
    const f = e.target;
    const date = f.row_date.value;
    const value = parseMoneyInput(f.row_value.value);
    if (!date || value === '' || value == null || Number.isNaN(value)) {
      showMsg($('#earnJobRowModalMsg'), 'err', 'A date and an amount are required.');
      return;
    }
    const { kind, index } = earnJobRowState;
    const payChanges = (j.pay_changes || []).map((r) => ({ effective_date: r.effective_date, value: r.value }));
    const bonuses = (j.bonuses || []).map((b) => ({ date: b.date, amount: b.amount }));
    // A raise that applies to the recent pay period becomes the current
    // rate: the latest pay-change row on or before the recent date sets
    // recent_pay_value, so adding a raise updates the annual gross.
    let recentValue = earnJobPerPeriod(j);
    if (kind === 'pay_change') {
      if (index == null) payChanges.push({ effective_date: date, value });
      else payChanges[index] = { effective_date: date, value };
      payChanges.sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1));
      const applicable = payChanges.filter((r) => r.effective_date <= j.recent_pay_date);
      if (applicable.length && applicable[applicable.length - 1].effective_date === date) recentValue = value;
    } else {
      if (index == null) bonuses.push({ date, amount: value });
      else bonuses[index] = { date, amount: value };
    }
    closeModalEl($('#earnJobRowModal'));
    await earnJobDetailPut(j, payChanges, bonuses, recentValue);
  } catch (err) { showMsg($('#earnJobRowModalMsg'), 'err', err.message); }
};

window.earnJobDetailDeleteRow = async (kind, index) => {
  const j = earnData.jobs.find((x) => x.id === currentEarnJobId);
  if (!j) return;
  if (!j.start_date || !j.recent_pay_date) { earnEditJob(j.id); return; }
  if (!confirm('Delete this row?')) return;
  try {
    const payChanges = (j.pay_changes || []).map((r) => ({ effective_date: r.effective_date, value: r.value }));
    const bonuses = (j.bonuses || []).map((b) => ({ date: b.date, amount: b.amount }));
    if (kind === 'pay_change') payChanges.splice(index, 1);
    else bonuses.splice(index, 1);
    // Deleting a row never moves the current rate on its own.
    await earnJobDetailPut(j, payChanges, bonuses, earnJobPerPeriod(j));
  } catch (err) { showMsg($('#earnJobDetailMsg'), 'err', err.message); }
};

// Linked property vs standalone address are mutually exclusive: picking
// a property disables and clears Address (a disabled control is omitted
// from FormData, so the server stores address null — no ambiguity about
// which one the rental uses). Back to Standalone re-enables it.
function syncEarnRentalAddressState() {
  const f = $('#earnRentalForm');
  const linked = f.property_id.value !== '';
  f.address.disabled = linked;
  if (linked) {
    f.address.value = '';
    earnRentalSuggest.reset();
  }
}
$('#earnRentalProperty').addEventListener('change', syncEarnRentalAddressState);

$('#addEarnRentalBtn').onclick = () => {
  earnEditRentalId = null;
  $('#earnRentalFormTitle').textContent = 'Add rental';
  $('#earnRentalForm').reset();
  earnRentalSuggest.reset();
  syncEarnRentalAddressState();
  showMsg($('#earnRentalModalMsg'), '', '');
  openModal('earnRentalModal');
};
$('#earnRentalForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = earnReadForm(e.target);
    if (earnEditRentalId) await api(`/api/earnings/rentals/${earnEditRentalId}`, { method: 'PUT', body });
    else await api('/api/earnings/rentals', { method: 'POST', body });
    closeModalEl($('#earnRentalModal'));
    loadEarnings();
  } catch (err) { showMsg($('#earnRentalModalMsg'), 'err', err.message); }
};
window.earnEditRental = (id) => {
  const r = earnData.rentals.find((x) => x.id === id);
  if (!r) return;
  earnEditRentalId = id;
  $('#earnRentalFormTitle').textContent = 'Edit rental';
  const f = $('#earnRentalForm');
  f.label.value = r.label; f.property_id.value = r.property_id ?? ''; f.address.value = r.address || '';
  f.rental_type.value = r.rental_type; f.services_level.value = r.services_level; f.ownership_pct.value = r.ownership_pct;
  f.is_principal_residence.checked = r.is_principal_residence; f.was_principal_residence.checked = r.was_principal_residence;
  f.structural_change.checked = r.structural_change;
  syncEarnRentalAddressState();
  showMsg($('#earnRentalModalMsg'), '', '');
  openModal('earnRentalModal');
};
window.earnDeleteRental = async (id) => {
  if (!confirm('Delete this rental and all its year records?')) return;
  await api(`/api/earnings/rentals/${id}`, { method: 'DELETE' });
  loadEarnings();
};

function earnExpenseRow(line = '', amount = '', direct = false) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<select class="earn-exp-line">${earnData.t776Lines.filter((l) => l.line !== '8710').map((l) =>
    `<option value="${l.line}" ${l.line === line ? 'selected' : ''}>${l.line} ${esc(l.label)}</option>`).join('')}</select>
    <input class="earn-exp-amount" type="number" step="0.01" min="0" value="${amount}" placeholder="Amount">
    <label><input class="earn-exp-direct" type="checkbox" ${direct ? 'checked' : ''}> Direct</label>
    <button type="button" class="small" onclick="this.parentElement.remove()">Remove</button>`;
  return wrap;
}
$('#earnExpenseAddBtn').onclick = () => $('#earnExpenseRows').appendChild(earnExpenseRow());
$('#earnRentalYearForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = earnReadForm(e.target);
    body.expenses = [...document.querySelectorAll('#earnExpenseRows > div')].map((row) => ({
      line: row.querySelector('.earn-exp-line').value,
      amount: Number(row.querySelector('.earn-exp-amount').value || 0),
      direct: row.querySelector('.earn-exp-direct').checked,
    }));
    if (earnEditYearId) await api(`/api/earnings/rentals/${earnYearRentalId}/years/${earnEditYearId}`, { method: 'PUT', body });
    else await api(`/api/earnings/rentals/${earnYearRentalId}/years`, { method: 'POST', body });
    closeModalEl($('#earnRentalYearModal'));
    loadEarnings();
  } catch (err) { showMsg($('#earnRentalYearModalMsg'), 'err', err.message); }
};
window.earnEditYear = (rentalId, yearId) => {
  const r = earnData.rentals.find((x) => x.id === rentalId);
  const y = r && r.years.find((v) => v.id === yearId);
  if (!y) return;
  earnYearRentalId = rentalId; earnEditYearId = yearId;
  $('#earnRentalYearFormTitle').textContent = 'Edit year record';
  const f = $('#earnRentalYearForm');
  f.tax_year.value = y.tax_year; f.other_income.value = y.other_income;
  f.area_share_pct.value = y.area_share_pct;
  $('#earnYearDerived').innerHTML = `Gross rents ${money2(y.gross_rents)} · Rented days ${y.rental_days}${y.rent_derived ? ' (from rent entries)' : ''}`;
  $('#earnYearDerived').classList.remove('hidden');
  f.mortgage_interest.value = y.mortgage_interest; f.mortgage_principal.value = y.mortgage_principal;
  f.claim_cca.checked = y.claim_cca; f.cca_acknowledged.checked = y.cca_acknowledged;
  f.ucc_class1.value = y.ucc_class1 ?? ''; f.ucc_class8.value = y.ucc_class8 ?? '';
  f.str_compliant_days.value = y.str_compliant_days ?? ''; f.str_non_compliant_days.value = y.str_non_compliant_days ?? '';
  $('#earnExpenseRows').innerHTML = '';
  for (const ex of y.expenses) $('#earnExpenseRows').appendChild(earnExpenseRow(ex.line, ex.amount, ex.direct));
  showMsg($('#earnRentalYearModalMsg'), '', '');
  openModal('earnRentalYearModal');
};
window.earnDeleteYear = async (rentalId, yearId) => {
  if (!confirm('Delete this year record?')) return;
  await api(`/api/earnings/rentals/${rentalId}/years/${yearId}`, { method: 'DELETE' });
  loadEarnings();
};

// ------------------------------------------------------ rent entries --
let earnEntryRentalId = null;
let earnEditEntryId = null;
window.earnAddEntry = (rentalId) => {
  earnEntryRentalId = rentalId; earnEditEntryId = null;
  $('#earnRentalEntryFormTitle').textContent = 'Add rent entry';
  $('#earnRentalEntryForm').reset();
  setEntryMonth('entryStart', ''); setEntryMonth('entryEnd', '');
  showMsg($('#earnRentalEntryModalMsg'), '', '');
  openModal('earnRentalEntryModal');
};
$('#earnRentalEntryForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = earnReadForm(e.target);
    // The From field is a picker button now, not a required native
    // input, so its emptiness is caught here with the server's
    // message instead of a browser bubble.
    if (!body.start_ym) { showMsg($('#earnRentalEntryModalMsg'), 'err', 'start month must be a year-month (YYYY-MM).'); return; }
    parseMoneyFields(body, ['monthly_rent', 'cash_amount']);
    if (earnEditEntryId) await api(`/api/earnings/rentals/${earnEntryRentalId}/entries/${earnEditEntryId}`, { method: 'PUT', body });
    else await api(`/api/earnings/rentals/${earnEntryRentalId}/entries`, { method: 'POST', body });
    closeModalEl($('#earnRentalEntryModal'));
    loadEarnings();
  } catch (err) { showMsg($('#earnRentalEntryModalMsg'), 'err', err.message); }
};
window.earnEditEntry = (rentalId, entryId) => {
  const r = earnData.rentals.find((x) => x.id === rentalId);
  const en = r && (r.entries || []).find((v) => v.id === entryId);
  if (!en) return;
  earnEntryRentalId = rentalId; earnEditEntryId = entryId;
  $('#earnRentalEntryFormTitle').textContent = 'Edit rent entry';
  const f = $('#earnRentalEntryForm');
  setEntryMonth('entryStart', en.start_ym); setEntryMonth('entryEnd', en.end_ym || '');
  setMoneyValue(f.monthly_rent, en.monthly_rent); f.pay_day.value = en.pay_day;
  setMoneyValue(f.cash_amount, en.cash_amount ?? ''); f.tenant_name.value = en.tenant_name || '';
  showMsg($('#earnRentalEntryModalMsg'), '', '');
  openModal('earnRentalEntryModal');
};
window.earnDeleteEntry = async (rentalId, entryId) => {
  if (!confirm('Delete this rent entry? Year records it created stay.')) return;
  await api(`/api/earnings/rentals/${rentalId}/entries/${entryId}`, { method: 'DELETE' });
  loadEarnings();
};

// ------------------------------------------------------------- spending ---
// Credit cards: overall page (share by card / by category + monthly
// history + transactions) and per-card detail pages (share by
// category + history + transactions, QFX import, ✨ Fill with AI).
// The share doughnut covers the whole range in force (a flow,
// unlike Stocks' range-end point-in-time share); the history bars
// are the monthly spending series. Charges are negative server-side
// and display as positive spending; payments display negated.
let currentSpendCardId = null;
let spendChart = null;
let spendShareChart = null;
let spendDetailChart = null;
let spendDetailShareChart = null;
let spendData = null;
let spendCardData = null;
let spendShareMode = 'card';
let spendImportParsed = null;
// Import preview paging: one page of rows at a time; the
// already-imported section stays collapsed until expanded.
const SPEND_IMPORT_PAGE_SIZE = 25;
let spendImportPage = 0;
let spendImportOldOpen = false;
let spendImportOldPage = 0;
let spendTxModalCtx = null; // { cardId, txId } — txId null = add
// Category multi-select state per transactions table: null = all
// categories selected; a Set = the explicitly selected keys
// (an empty Set = Select none). '__uncat__' stands for rows with
// no category, mirroring the old single-select's option values.
let spendCatSel = null;
let spendDetailCatSel = null;
// Whether the multi-select panel is open per table: the panel
// is rebuilt on every render, so open state lives here and the
// render re-opens it after a checkbox toggle.
let spendCatPanelOpen = { spending: false, spendCard: false };

// Month pager for the two spending transaction tables: one
// month per page, the SAME method on both (not row-count
// paging — the import preview's 25-row paging is a different
// thing and stays as is). Pageable months are every month in
// the range in force, so stepping can land on a month with no
// rows — it renders empty, never an error. The default page is
// the range end (latest month); a range change re-defaults,
// like the Stocks year pager. A category filter narrows rows
// within the page but never moves the page.
const spendTxMonthPage = { spending: null, spendCard: null };
// Last effective range per spending level: a data reload with an
// unchanged range must NOT re-default the table page (an Edit save
// from the Aug page must stay on Aug); only a real range change
// re-defaults to the latest month in the new range.
const spendTxLastRange = { spending: null, spendCard: null };
function spendTxRange(level) {
  const txs = level === 'spending'
    ? (spendData && spendData.transactions) : (spendCardData && spendCardData.transactions);
  const txMonths = (txs || []).map((t) => String(t.date || '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  const r = investEffectiveRange(level);
  if (!r) return txMonths.length ? { start: txMonths[0], end: txMonths[txMonths.length - 1] } : null;
  // The monthly series skips payment-only months, so under All
  // (no preset, no custom pair) a transaction month outside the
  // series span must still be pageable — otherwise those rows
  // would vanish from the table entirely. Under an explicit
  // preset/custom pair the range stays exactly as picked.
  const st = investRanges[level];
  if (!st.months && !st.custom && txMonths.length) {
    return {
      start: r.start < txMonths[0] ? r.start : txMonths[0],
      end: r.end > txMonths[txMonths.length - 1] ? r.end : txMonths[txMonths.length - 1],
    };
  }
  return r;
}
function spendTxPageMonth(level, range) {
  if (!range) return null;
  const cur = spendTxMonthPage[level];
  if (cur && cur >= range.start && cur <= range.end) return cur;
  spendTxMonthPage[level] = range.end;
  return range.end;
}
function spendTxPagerHtml(level, range, month) {
  return `<div class="toolbar" data-spend-tx-pager="${level}">\n    <button type="button" class="small" onclick="spendTxMonthStep('${level}', -1)"${month > range.start ? '' : ' disabled'}>&#8249; Prev month</button>\n    <span>${formatYM(month)}</span>\n    <button type="button" class="small" onclick="spendTxMonthStep('${level}', 1)"${month < range.end ? '' : ' disabled'}>Next month &#8250;</button>\n  </div>`;
}
window.spendTxMonthStep = (level, dir) => {
  const range = spendTxRange(level);
  if (!range) return;
  const cur = spendTxPageMonth(level, range);
  const next = addMonthsYM(cur, dir);
  if (next < range.start || next > range.end) return;
  spendTxMonthPage[level] = next;
  if (level === 'spending') renderSpendTxTable();
  else renderSpendDetailTxTable();
};

// Per-category view: the filter is a checkbox multi-select —
// one box per used category plus Uncategorized — with Select all
// / Select none. A row's category is changed persistently through
// its Edit button — the modal's category input carries the
// category datalist — and a manual move changes ONLY that row,
// never the remembered merchant→category mapping.
function spendCatKeys(transactions) {
  const cats = [...new Set(transactions.map((t) => (t.category || '').trim()).filter(Boolean))].sort();
  return ['__uncat__', ...cats];
}
function spendCatLabel(key) {
  return key === '__uncat__' ? 'Uncategorized' : key;
}
function spendCatSummary(sel) {
  if (sel === null) return 'All categories';
  if (sel.size === 0) return 'None';
  if (sel.size === 1) return spendCatLabel([...sel][0]);
  return `${sel.size} categories`;
}
function spendFilterTx(transactions, sel) {
  if (sel === null) return transactions;
  return transactions.filter((t) => sel.has((t.category || '').trim() || '__uncat__'));
}
// The category filter and the month pager share one flex row
// (.spend-tx-controls), rendered inside the table host so the row
// survives every re-render. The filter control is a single button
// (class small, like the pager buttons, so both share one height
// and one vertical center) whose label carries the word Category
// inline — there is no separate label line above it. Its dropdown
// panel is rebuilt on each render, so every listener lives on
// document (delegation) instead of the elements.
function spendTxControlsHtml(level, transactions, sel, pager) {
  const btnId = level === 'spending' ? 'spendCatBtn' : 'spendDetailCatBtn';
  const panelId = level === 'spending' ? 'spendCatPanel' : 'spendDetailCatPanel';
  const checks = spendCatKeys(transactions).map((k) => {
    const checked = sel === null || sel.has(k);
    return `<label><input type="checkbox" data-spend-cat="${esc(k)}" data-spend-cat-level="${level}"${checked ? ' checked' : ''}> ${esc(spendCatLabel(k))}</label>`;
  }).join('');
  const panel = spendCatPanelOpen[level] ? `<div class="spend-tx-catpanel" id="${panelId}">
    <div class="spend-tx-catpanel-actions">
      <button type="button" class="small" data-spend-cat-all="${level}">Select all</button>
      <button type="button" class="small" data-spend-cat-none="${level}">Select none</button>
      <span class="spacer"></span>
      <button type="button" class="small" data-spend-cat-done="${level}">Done</button>
    </div>
    ${checks}
  </div>` : '';
  return `<div class="spend-tx-controls"><div class="spend-tx-catwrap"><button type="button" class="small" id="${btnId}" data-spend-cat-toggle="${level}">Category: ${esc(spendCatSummary(sel))}</button>${panel}</div>${pager}</div>`;
}
function spendTxValidSel(transactions, sel) {
  if (sel === null) return null;
  const valid = new Set(spendCatKeys(transactions));
  const pruned = new Set([...sel].filter((k) => valid.has(k)));
  // A selection that vanished entirely (its categories no longer
  // exist) falls back to all, like the old single-select reset;
  // an explicit Select none (empty set) is left alone.
  if (sel.size > 0 && pruned.size === 0) return null;
  return pruned;
}
function spendTxSetSel(level, sel) {
  if (level === 'spending') spendCatSel = sel;
  else spendDetailCatSel = sel;
  if (level === 'spending') renderSpendTxTable();
  else renderSpendDetailTxTable();
}
function renderSpendTxTable() {
  if (!spendData) return;
  spendCatSel = spendTxValidSel(spendData.transactions, spendCatSel);
  const host = $('#spendTxTable');
  if (!spendData.transactions.length) { host.innerHTML = spendTxControlsHtml('spending', spendData.transactions, spendCatSel, '') + '<div class="note">No transactions yet.</div>'; return; }
  const range = spendTxRange('spending');
  if (!range) { host.innerHTML = spendTxControlsHtml('spending', spendData.transactions, spendCatSel, '') + spendTxTableHtml(spendFilterTx(spendData.transactions, spendCatSel), true); return; }
  const month = spendTxPageMonth('spending', range);
  const pageRows = spendFilterTx(spendData.transactions, spendCatSel)
    .filter((t) => String(t.date || '').slice(0, 7) === month);
  const controls = spendTxControlsHtml('spending', spendData.transactions, spendCatSel, spendTxPagerHtml('spending', range, month));
  if (!pageRows.length) {
    const note = spendData.transactions.some((t) => String(t.date || '').slice(0, 7) === month)
      ? '<div class="note">No transactions in this category.</div>'
      : '<div class="note">No transactions in this month.</div>';
    host.innerHTML = controls + note;
    return;
  }
  host.innerHTML = controls + spendTxTableHtmlGrouped(pageRows);
}
function renderSpendDetailTxTable() {
  if (!spendCardData) return;
  spendDetailCatSel = spendTxValidSel(spendCardData.transactions, spendDetailCatSel);
  const host = $('#spendDetailTxTable');
  if (!spendCardData.transactions.length) { host.innerHTML = spendTxControlsHtml('spendCard', spendCardData.transactions, spendDetailCatSel, '') + '<div class="note">No transactions yet.</div>'; return; }
  const range = spendTxRange('spendCard');
  if (!range) { host.innerHTML = spendTxControlsHtml('spendCard', spendCardData.transactions, spendDetailCatSel, '') + spendTxTableHtml(spendFilterTx(spendCardData.transactions, spendDetailCatSel), false); return; }
  const month = spendTxPageMonth('spendCard', range);
  const pageRows = spendFilterTx(spendCardData.transactions, spendDetailCatSel)
    .filter((t) => String(t.date || '').slice(0, 7) === month);
  const controls = spendTxControlsHtml('spendCard', spendCardData.transactions, spendDetailCatSel, spendTxPagerHtml('spendCard', range, month));
  if (!pageRows.length) {
    const note = spendCardData.transactions.some((t) => String(t.date || '').slice(0, 7) === month)
      ? '<div class="note">No transactions in this category.</div>'
      : '<div class="note">No transactions in this month.</div>';
    host.innerHTML = controls + note;
    return;
  }
  host.innerHTML = controls + spendTxTableHtml(pageRows, false);
}
document.addEventListener('change', (e) => {
  const box = e.target.closest('[data-spend-cat]');
  if (!box) return;
  const level = box.dataset.spendCatLevel;
  const key = box.dataset.spendCat;
  const txs = level === 'spending' ? (spendData ? spendData.transactions : []) : (spendCardData ? spendCardData.transactions : []);
  let sel = level === 'spending' ? spendCatSel : spendDetailCatSel;
  // Toggling off one box from "all" materializes the full set
  // first, so the result is all-minus-one, not just that box.
  if (sel === null) sel = new Set(spendCatKeys(txs));
  else sel = new Set(sel);
  if (box.checked) sel.add(key);
  else sel.delete(key);
  spendTxSetSel(level, sel);
});
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-spend-cat-toggle]');
  if (toggle) {
    const level = toggle.dataset.spendCatToggle;
    spendCatPanelOpen[level] = !spendCatPanelOpen[level];
    if (level === 'spending') renderSpendTxTable();
    else renderSpendDetailTxTable();
    return;
  }
  const all = e.target.closest('[data-spend-cat-all]');
  if (all) { spendTxSetSel(all.dataset.spendCatAll, null); return; }
  const none = e.target.closest('[data-spend-cat-none]');
  if (none) { spendTxSetSel(none.dataset.spendCatNone, new Set()); return; }
  const done = e.target.closest('[data-spend-cat-done]');
  if (done) {
    const level = done.dataset.spendCatDone;
    spendCatPanelOpen[level] = false;
    if (level === 'spending') renderSpendTxTable();
    else renderSpendDetailTxTable();
    return;
  }
  // A click anywhere outside the filter wrap closes an open
  // panel; the re-render after it is harmless (pager steps and
  // modal opens fire their own handlers first).
  if (!e.target.closest('.spend-tx-catwrap')) {
    for (const level of ['spending', 'spendCard']) {
      if (spendCatPanelOpen[level]) {
        spendCatPanelOpen[level] = false;
        if (level === 'spending') renderSpendTxTable();
        else renderSpendDetailTxTable();
      }
    }
  }
});

const spendShareCenterPlugin = {
  id: 'spendShareCenter',
  afterDraw(chart) {
    const c = chart.$spendCenter;
    if (!c) return;
    const area = chart.chartArea;
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const ctx = chart.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#71808f';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('Total spent', x, y - 4);
    ctx.fillStyle = '#22303c';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillText(money2(c.total), x, y + 14);
    ctx.restore();
  },
};

function spendGroupByCard(tx, cards) {
  const names = new Map((cards || []).map((c) => [c.id, c.name]));
  const totals = new Map();
  for (const t of tx) {
    if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
    totals.set(t.card_id, (totals.get(t.card_id) || 0) + -Number(t.amount));
  }
  return [...totals.entries()]
    .map(([id, total]) => ({ key: id, label: names.get(id) || 'Card', total: Math.round(total * 100) / 100, color: INVEST_ACCOUNT_COLORS[Math.abs(Number(id) || 0) % INVEST_ACCOUNT_COLORS.length] }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);
}

function spendGroupByCategory(tx) {
  const totals = new Map();
  for (const t of tx) {
    if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
    const label = (t.category || '').trim() || 'Uncategorized';
    totals.set(label, (totals.get(label) || 0) + -Number(t.amount));
  }
  return [...totals.entries()]
    .map(([label, total], i) => ({ key: label, label, total: Math.round(total * 100) / 100, color: INVEST_ACCOUNT_COLORS[i % INVEST_ACCOUNT_COLORS.length] }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);
}

// Clicking a history BAR selects that month in the page's range
// picker (From = To = the bar's month). The preset clears to a
// custom single-month range, and the existing applyInvestRange
// path re-renders the share, the history and the table — the
// table re-defaults to the range end, i.e. the clicked month.
// Bars only: the click resolves with intersect:true, and a
// dataset counts only if it is a bar dataset (the overall
// chart's Total line dataset is not), so clicking the line or
// empty space does nothing. Hover/tooltip behavior is untouched.
function spendHistBarClick(level, chart, evt) {
  const els = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false);
  const bar = els.find((el) => {
    const ds = chart.data.datasets[el.datasetIndex];
    return ds && (ds.type === 'bar' || (ds.type === undefined && chart.config.type === 'bar'));
  });
  if (!bar) return;
  const month = chart.data.labels[bar.index];
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return;
  const span = investSpan(level);
  if (!span) return;
  investRanges[level].custom = clampRange({ start: month, end: month }, span);
  applyInvestRange(level);
}

function drawSpendCharts(level, d, r) {
  const inR = (m) => !r || (m >= r.start && m <= r.end);
  const isDetail = level === 'spendCard';
  const months = (d.monthly || []).filter((x) => inR(x.month));
  const tx = (d.transactions || []).filter((t) => inR(String(t.date).slice(0, 7)));
  const shareRows = isDetail
    ? spendGroupByCategory(tx)
    : (spendShareMode === 'card' ? spendGroupByCard(tx, d.cards || []) : spendGroupByCategory(tx));
  const total = shareRows.reduce((s, x) => s + x.total, 0);
  const shareCanvas = $(isDetail ? '#spendDetailShareChart' : '#spendShareChart');
  const histCanvas = $(isDetail ? '#spendDetailChart' : '#spendChart');
  const shareWrap = $(isDetail ? '#spendDetailShareWrap' : '#spendShareWrap');
  const shareEmpty = $(isDetail ? '#spendDetailShareEmpty' : '#spendShareEmpty');
  const title = $(isDetail ? '#spendDetailShareTitle' : '#spendShareTitle');
  if (title) title.textContent = isDetail ? 'Category share' : (spendShareMode === 'card' ? 'Spending share · by card' : 'Spending share · by category');
  const oldShare = isDetail ? spendDetailShareChart : spendShareChart;
  if (oldShare) oldShare.destroy();
  const oldHist = isDetail ? spendDetailChart : spendChart;
  if (oldHist) oldHist.destroy();
  if (!shareRows.length || total <= 0) {
    if (isDetail) { spendDetailShareChart = null; window.__fmCharts.spendCardShare = null; }
    else { spendShareChart = null; window.__fmCharts.spendShare = null; }
    if (shareWrap) shareWrap.classList.add('hidden');
    if (shareEmpty) shareEmpty.classList.remove('hidden');
  } else {
    if (shareWrap) shareWrap.classList.remove('hidden');
    if (shareEmpty) shareEmpty.classList.add('hidden');
    const chart = new Chart(shareCanvas, {
      type: 'doughnut',
      data: {
        labels: shareRows.map((s) => s.label),
        datasets: [{ data: shareRows.map((s) => s.total), backgroundColor: shareRows.map((s) => s.color), borderColor: '#fff', borderWidth: 1, hoverOffset: 10 }],
      },
      plugins: [spendShareCenterPlugin],
      options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } } },
    });
    chart.$spendCenter = { total };
    if (isDetail) { spendDetailShareChart = chart; window.__fmCharts.spendCardShare = chart; }
    else { spendShareChart = chart; window.__fmCharts.spendShare = chart; }
  }
  // The overall history chart breaks each month's bar down by the
  // same portion the doughnut shows (By card / By category): one
  // stacked segment per share row, reusing the doughnut's colors,
  // under a total line — the property/Stocks stacked-bars +
  // total-line shape. The total line sums the stack values, so the
  // stacks and the line agree to the cent by construction. The
  // detail chart keeps its single-series shape (one card only).
  // An empty history must not render with Chart.js's default $0/$1
  // axis ticks: like the share doughnut above, the chart hides and
  // a note shows instead. (The share already hid on empty; the
  // history previously rendered its empty axes.)
  const histEmpty = !months.length || months.every((m) => !m.total);
  const histWrap = histCanvas ? histCanvas.closest('.chart-wrap') : null;
  const histEmptyEl = $(isDetail ? '#spendDetailHistEmpty' : '#spendHistEmpty');
  if (histWrap) histWrap.classList.toggle('hidden', histEmpty);
  if (histEmptyEl) histEmptyEl.classList.toggle('hidden', !histEmpty);
  let hist = null;
  if (!histEmpty && isDetail) {
    hist = new Chart(histCanvas, {
      type: 'bar',
      data: { labels: months.map((m) => m.month), datasets: [{ label: 'Spending', data: months.map((m) => m.total), backgroundColor: '#1668c4' }] },
      plugins: [guideLinePlugin],
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => money(v) } } }, onClick: (evt, els, chart) => spendHistBarClick(level, chart, evt) },
    });
  } else if (!histEmpty) {
    const monthIdx = new Map(months.map((m, i) => [m.month, i]));
    const byKey = new Map(shareRows.map((s) => [s.key, months.map(() => 0)]));
    for (const t of tx) {
      if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
      const mi = monthIdx.get(String(t.date).slice(0, 7));
      if (mi === undefined) continue;
      const key = spendShareMode === 'card' ? t.card_id : ((t.category || '').trim() || 'Uncategorized');
      const arr = byKey.get(key);
      if (arr) arr[mi] = Math.round((arr[mi] + -Number(t.amount)) * 100) / 100;
    }
    const totals = months.map((_, i) => Math.round(shareRows.reduce((s, row) => s + byKey.get(row.key)[i], 0) * 100) / 100);
    hist = new Chart(histCanvas, {
      type: 'line',
      data: {
        labels: months.map((m) => m.month),
        datasets: [
          ...shareRows.map((s) => ({ type: 'bar', label: s.label, data: byKey.get(s.key), backgroundColor: s.color, stack: 'spend', order: 3, maxBarThickness: 28 })),
          { label: 'Total', data: totals, borderColor: '#22303c', backgroundColor: '#22303c', tension: 0.15, pointRadius: 0, borderWidth: 2, order: 1 },
        ],
      },
      plugins: [guideLinePlugin],
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => money(v) } } }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } }, onClick: (evt, els, chart) => spendHistBarClick(level, chart, evt) },
    });
  }
  if (isDetail) { spendDetailChart = hist; window.__fmCharts.spendCard = hist; }
  else { spendChart = hist; window.__fmCharts.spend = hist; }
}

function spendTxTypeLabel(t) {
  if (t.kind === 'adjustment') return 'Adjustment';
  if (t.kind === 'refund') return 'Refund';
  if (t.kind === 'payment') return 'Payment';
  if (t.kind === 'charge') return 'Charge';
  return Number(t.amount) >= 0 ? 'Payment' : 'Charge';
}
function spendTxRowHtml(t, showCard) {
  // Charges display as positive spending; payments display
  // negated; an adjustment displays signed, so it never reads
  // as spending.
  const amt = t.kind === 'adjustment' ? money(Number(t.amount))
    : (Number(t.amount) >= 0 ? '−' + money(Number(t.amount)) : money(-Number(t.amount)));
  return `<tr>
      <td>${esc(t.date)}</td>
      ${showCard ? `<td>${esc(t.card_name || '')}</td>` : ''}
      <td>${esc(t.merchant)}</td>
      <td>${esc(t.category || '—')}</td>
      <td>${spendTxTypeLabel(t)}</td>
      <td>${amt}</td>
      <td><button class="small" onclick="spendEditTx(${t.id})">Edit</button> <button class="small" onclick="spendDeleteTx(${t.id})">Delete</button></td>
    </tr>`;
}
// A row's DISPLAYED amount: charges read positive, payments
// negated, adjustments signed as stored — the sum row below
// adds exactly what the Amount column shows.
function spendTxDisplayedAmount(t) {
  return t.kind === 'adjustment' ? Number(t.amount) : -Number(t.amount);
}
// One total row at the bottom of the table: the sum of the rows
// actually displayed (the builders only ever receive the filtered
// page), to the cent. It lives in <tfoot> so the tbody row
// readers (pager tests, Edit/Delete flows) never see it as data.
function spendTxSumFoot(transactions, showCard) {
  const sum = Math.round(transactions.reduce((s, t) => s + spendTxDisplayedAmount(t), 0) * 100) / 100;
  return `<tfoot><tr class="spend-tx-sum"><td colspan="${showCard ? 5 : 4}">Total</td><td>${money2(sum)}</td><td></td></tr></tfoot>`;
}
function spendTxTableHtml(transactions, showCard) {
  if (!transactions.length) return '<div class="note">No transactions yet.</div>';
  const rows = transactions.map((t) => spendTxRowHtml(t, showCard)).join('');
  return `<table class="tbl"><thead><tr><th>Date</th>${showCard ? '<th>Card</th>' : ''}<th>Merchant</th><th>Category</th><th>Type</th><th>Amount</th><th></th></tr></thead><tbody>${rows}</tbody>${spendTxSumFoot(transactions, showCard)}</table>`;
}
// Overall table only: the month page's rows grouped by
// category under a header row per group (alphabetical,
// uncategorized last); rows within a group keep server order.
function spendTxTableHtmlGrouped(transactions) {
  if (!transactions.length) return '<div class="note">No transactions yet.</div>';
  const groups = new Map();
  for (const t of transactions) {
    const key = (t.category || '').trim() || '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '—' ? 1 : b === '—' ? -1 : a.localeCompare(b)));
  const body = names.map((name) => `<tr class="spend-tx-group"><td colspan="7">${esc(name)}</td></tr>`
    + groups.get(name).map((t) => spendTxRowHtml(t, true)).join('')).join('');
  return `<table class="tbl"><thead><tr><th>Date</th><th>Card</th><th>Merchant</th><th>Category</th><th>Type</th><th>Amount</th><th></th></tr></thead><tbody>${body}</tbody>${spendTxSumFoot(transactions, true)}</table>`;
}

// Transaction form Category combobox: one input + datalist holding the
// presets plus every category already used in stored transactions, so a
// custom category typed once is offered next time. Presets are captured
// from the static markup on first call; used customs append after them.
let spendPresetCategories = null;
function renderSpendCategoryList(used) {
  const dl = $('#spendCategoryList');
  if (!dl) return;
  if (!spendPresetCategories) spendPresetCategories = [...dl.querySelectorAll('option')].map((o) => o.value);
  const all = [...spendPresetCategories];
  for (const c of used || []) {
    const v = String(c || '').trim();
    if (v && !all.includes(v)) all.push(v);
  }
  dl.innerHTML = all.map((c) => `<option value="${esc(c)}">`).join('');
}

async function loadSpending() {
  spendCatPanelOpen.spending = false;
  const data = await api('/api/spending');
  spendData = data;
  renderSpendCategoryList(data.categories);
  investViewData.spending = { series: data.monthly, monthly: data.monthly, transactions: data.transactions, cards: data.cards };
  // List cards show ONLY the current balance: the name line, then
  // the balance figure and its as-of line. No total spent, no
  // transaction count/last date, no credit limit — those live on
  // the card detail page. A card with no balance shows its name
  // only; a balance is never invented.
  $('#spendCardList').innerHTML = data.cards.length ? data.cards.map((c) => `
    <div class="card breakdown-card" onclick="location.hash='#spending/card/${c.id}'">
      <div class="k">${esc(c.name)}${c.issuer ? ' · ' + esc(c.issuer) : ''} · ••••${esc(c.last4)}</div>
      ${c.balance_owed != null ? `<div class="v">${money2(c.balance_owed)}</div>
      <div class="n">Current balance${c.balance_asof ? ' · as of ' + esc(c.balance_asof) : ''}</div>` : ''}
    </div>`).join('') : '<div class="note">No cards yet — add one above.</div>';
  renderSpendTxTable();
  $('#spendRange').innerHTML = investRangeControlsHtml('spending');
  wireInvestRangeControls('spending');
  applyInvestRange('spending');
}

async function loadSpendCard(id) {
  spendCatPanelOpen.spendCard = false;
  const data = await api(`/api/spending/cards/${id}`);
  spendCardData = data;
  renderSpendCategoryList(data.categories);
  investViewData.spendCard = { series: data.monthly, monthly: data.monthly, transactions: data.transactions, cards: [data.card] };
  $('#spendDetailTitle').textContent = `${data.card.name} · ••••${data.card.last4}`;
  const infoLines = [];
  if (data.card.credit_limit != null) infoLines.push(`Credit limit ${money2(data.card.credit_limit)}`);
  if (data.card.balance_owed != null) infoLines.push(`Balance owed ${money2(data.card.balance_owed)}${data.card.balance_asof ? ' · as of ' + esc(data.card.balance_asof) : ''}`);
  $('#spendDetailCardInfo').innerHTML = infoLines.length ? `<div class="note">${infoLines.join(' · ')}</div>` : '';
  renderSpendDetailTxTable();
  $('#spendDetailRange').innerHTML = investRangeControlsHtml('spendCard');
  wireInvestRangeControls('spendCard');
  applyInvestRange('spendCard');
}

function reloadSpendView() {
  if (currentSpendCardId && !$('#spendCardDetail').classList.contains('hidden')) loadSpendCard(currentSpendCardId);
  else loadSpending();
}

window.spendDeleteTx = async (id) => {
  if (!confirm('Delete this transaction?')) return;
  await api(`/api/spending/transactions/${id}`, { method: 'DELETE' });
  reloadSpendView();
};

window.spendEditTx = (id) => {
  const all = [...(spendData ? spendData.transactions : []), ...(spendCardData ? spendCardData.transactions : [])];
  const t = all.find((x) => x.id === id);
  if (!t) return;
  spendTxModalCtx = { cardId: t.card_id, txId: t.id };
  $('#spendTxFormTitle').textContent = 'Edit transaction';
  const f = $('#spendTxForm');
  f.date.value = t.date;
  f.type.value = Number(t.amount) >= 0 ? 'payment' : 'charge';
  f.merchant.value = t.merchant;
  setMoneyValue(f.amount, Math.abs(Number(t.amount)));
  f.category.value = t.category || '';
  f.memo.value = t.memo || '';
  $('#spendTxModalMsg').className = 'msg';
  $('#spendTxModalMsg').textContent = '';
  openModal('spendTxModal');
};

function openSpendTxAdd(cardId) {
  spendTxModalCtx = { cardId, txId: null };
  $('#spendTxFormTitle').textContent = 'Add transaction';
  const f = $('#spendTxForm');
  f.reset();
  f.type.value = 'charge';
  $('#spendTxModalMsg').className = 'msg';
  $('#spendTxModalMsg').textContent = '';
  openModal('spendTxModal');
}

$('#spendTxForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    date: f.date.value,
    merchant: f.merchant.value.trim(),
    type: f.type.value,
    amount: parseMoneyInput(f.amount.value),
    category: f.category.value.trim(),
    memo: f.memo.value.trim(),
  };
  const msg = $('#spendTxModalMsg');
  try {
    if (spendTxModalCtx.txId) {
      await api(`/api/spending/transactions/${spendTxModalCtx.txId}`, { method: 'PUT', body });
    } else {
      await api(`/api/spending/cards/${spendTxModalCtx.cardId}/transactions`, { method: 'POST', body });
    }
    $('#spendTxModal').classList.add('hidden');
    reloadSpendView();
  } catch (err) { showMsg(msg, 'err', err.message); }
});

let spendCardEditId = null;
$('#addSpendCardBtn').addEventListener('click', () => {
  spendCardEditId = null;
  $('#spendCardFormTitle').textContent = 'Add card';
  $('#spendCardForm').reset();
  $('#spendCardModalMsg').className = 'msg';
  $('#spendCardModalMsg').textContent = '';
  openModal('spendCardModal');
});

// Edit opens the same form prefilled (this is also how the
// credit limit is changed after the card exists).
$('#spendDetailEditBtn').addEventListener('click', () => {
  if (!spendCardData || !spendCardData.card) return;
  const c = spendCardData.card;
  spendCardEditId = c.id;
  $('#spendCardFormTitle').textContent = 'Edit card';
  const f = $('#spendCardForm');
  f.name.value = c.name;
  f.issuer.value = c.issuer || '';
  f.last4.value = c.last4;
  setMoneyValue(f.credit_limit, c.credit_limit);
  $('#spendCardModalMsg').className = 'msg';
  $('#spendCardModalMsg').textContent = '';
  openModal('spendCardModal');
});

$('#spendCardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const limit = parseMoneyInput(f.credit_limit.value);
  const body = {
    name: f.name.value.trim(), issuer: f.issuer.value.trim(), last4: f.last4.value.trim(),
    credit_limit: limit === '' ? null : limit,
  };
  const msg = $('#spendCardModalMsg');
  try {
    if (spendCardEditId) await api(`/api/spending/cards/${spendCardEditId}`, { method: 'PUT', body });
    else await api('/api/spending/cards', { method: 'POST', body });
    $('#spendCardModal').classList.add('hidden');
    reloadSpendView();
  } catch (err) { showMsg(msg, 'err', err.message); }
});

$('#spendBackBtn').addEventListener('click', () => { location.hash = '#spending'; });

$('#spendDetailDeleteBtn').addEventListener('click', async () => {
  if (!currentSpendCardId || !confirm('Delete this card and all its transactions?')) return;
  await api(`/api/spending/cards/${currentSpendCardId}`, { method: 'DELETE' });
  location.hash = '#spending';
});

$('#spendShareModeBtns').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  spendShareMode = btn.dataset.mode;
  $('#spendShareModeBtns').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  applyInvestRange('spending');
});

// QFX import lives on each card's detail page only (targeting
// that card): parse previews, Apply writes atomically.
function openSpendImport(preselectCardId) {
  const card = (spendCardData && spendCardData.card && spendCardData.card.id === preselectCardId ? spendCardData.card : null)
    || (spendData ? spendData.cards.find((c) => c.id === preselectCardId) : null);
  if (!card) return;
  const sel = $('#spendImportCard');
  sel.innerHTML = `<option value="${card.id}">${esc(card.name)} · ••••${esc(card.last4)}</option>`;
  $('#spendImportFile').value = '';
  $('#spendImportPreview').innerHTML = '';
  $('#spendImportModalMsg').className = 'msg';
  $('#spendImportModalMsg').textContent = '';
  spendImportParsed = null;
  openModal('spendImportModal');
}
$('#spendDetailImportBtn').addEventListener('click', () => openSpendImport(currentSpendCardId));

// Import preview rendering: new rows first, one page at a time;
// already-imported rows stay collapsed behind a count + toggle,
// so a file with hundreds of rows no longer renders them all.
// Apply still posts the full parsed rows — the server
// re-validates and dedupes by FITID, so paging changes nothing
// about what Apply writes.
function spendImportRowHtml(r) {
  return `<tr>
      <td>${esc(r.date)}</td><td>${esc(r.merchant)}</td>
      <td>${r.kind === 'charge' ? money(-r.amount) : '−' + money(r.amount)}</td>
      <td>${r.existing ? 'Already imported' : 'New'}</td></tr>`;
}
function spendImportPagerHtml(page, total, prevId, nextId) {
  const pages = Math.max(1, Math.ceil(total / SPEND_IMPORT_PAGE_SIZE));
  const from = total ? page * SPEND_IMPORT_PAGE_SIZE + 1 : 0;
  const to = Math.min(total, (page + 1) * SPEND_IMPORT_PAGE_SIZE);
  return `<div class="toolbar"><span class="note">Showing ${from}–${to} of ${total}</span>`
    + `<button class="small" id="${prevId}"${page <= 0 ? ' disabled' : ''}>&#8249; Prev</button>`
    + `<button class="small" id="${nextId}"${page >= pages - 1 ? ' disabled' : ''}>Next &#8250;</button></div>`;
}
function renderSpendImportPreview(cardId, data) {
  const preview = $('#spendImportPreview');
  const msg = $('#spendImportModalMsg');
  const newRows = data.rows.filter((r) => !r.existing);
  const oldRows = data.rows.filter((r) => r.existing);
  const droppedHtml = data.dropped.map((d) => `<li>${esc(d.reason)}${d.merchant ? ' — ' + esc(d.merchant) : ''}</li>`).join('');
  // Balance check: the file balance against the computed
  // balance, with the difference and the one proposed
  // adjustment row. Nothing writes until Apply — the checkbox
  // only opts the adjustment out of the Apply below.
  const bc = data.balanceCheck;
  const balanceHtml = bc ? `<div class="note">File balance: owed ${money2(bc.fileOwed)}${bc.asof ? ' · as of ' + esc(bc.asof) : ''} · Computed: owed ${money2(bc.computedOwed)} · Difference: ${money2(bc.difference)}</div>` : '';
  const adjHtml = (bc && bc.difference !== 0)
    ? `<div class="toolbar"><label><input type="checkbox" id="spendImportAdjCheck" checked> Add adjustment transaction of ${money2(bc.adjustmentAmount)} to reconcile</label></div>` : '';
  const pageSlice = (rows, page) => rows.slice(page * SPEND_IMPORT_PAGE_SIZE, (page + 1) * SPEND_IMPORT_PAGE_SIZE);
  const newTable = newRows.length
    ? `<table class="tbl"><thead><tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Status</th></tr></thead><tbody id="spendImportNewRows">${pageSlice(newRows, spendImportPage).map(spendImportRowHtml).join('')}</tbody></table>`
      + (newRows.length > SPEND_IMPORT_PAGE_SIZE ? spendImportPagerHtml(spendImportPage, newRows.length, 'spendImportNewPrev', 'spendImportNewNext') : '')
    : '';
  const oldTable = spendImportOldOpen
    ? `<div id="spendImportOldRows"><table class="tbl"><thead><tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Status</th></tr></thead><tbody>${pageSlice(oldRows, spendImportOldPage).map(spendImportRowHtml).join('')}</tbody></table>`
      + (oldRows.length > SPEND_IMPORT_PAGE_SIZE ? spendImportPagerHtml(spendImportOldPage, oldRows.length, 'spendImportOldPrev', 'spendImportOldNext') : '') + '</div>'
    : '';
  const oldSection = oldRows.length
    ? `<div class="toolbar"><button class="small" id="spendImportOldToggle">${spendImportOldOpen ? 'Hide' : 'Show'} already imported (${oldRows.length})</button></div>${oldTable}`
    : '';
  preview.innerHTML = `
      ${data.accountId ? `<div class="note">File account: ${esc(data.accountId)}</div>` : ''}
      <div class="note">${data.rows.length} transactions parsed (${newRows.length} new, ${data.rows.length - newRows.length} already imported), ${data.dropped.length} dropped.</div>
      ${balanceHtml}
      ${adjHtml}
      ${newTable || (!data.rows.length ? '<div class="note">No transactions found in this file.</div>' : '')}
      ${oldSection}
      ${droppedHtml ? `<div class="note">Dropped items:</div><ul>${droppedHtml}</ul>` : ''}
      ${newRows.length || (bc && bc.difference !== 0) ? '<div class="toolbar"><button class="primary" id="spendImportApplyBtn">Apply import</button></div>' : ''}`;
  const bindPager = (prevId, nextId, get, set) => {
    const prev = $('#' + prevId);
    const next = $('#' + nextId);
    if (prev) prev.addEventListener('click', () => { set(Math.max(0, get() - 1)); renderSpendImportPreview(cardId, data); });
    if (next) next.addEventListener('click', () => { set(get() + 1); renderSpendImportPreview(cardId, data); });
  };
  bindPager('spendImportNewPrev', 'spendImportNewNext', () => spendImportPage, (v) => { spendImportPage = v; });
  bindPager('spendImportOldPrev', 'spendImportOldNext', () => spendImportOldPage, (v) => { spendImportOldPage = v; });
  const oldToggle = $('#spendImportOldToggle');
  if (oldToggle) oldToggle.addEventListener('click', () => { spendImportOldOpen = !spendImportOldOpen; spendImportOldPage = 0; renderSpendImportPreview(cardId, data); });
  const applyBtn = $('#spendImportApplyBtn');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    try {
      const adjCheck = $('#spendImportAdjCheck');
      const result = await api(`/api/spending/cards/${cardId}/import-qfx/apply`, { method: 'POST', body: {
        rows: data.rows,
        fileOwed: bc ? bc.fileOwed : undefined,
        balanceAsof: bc ? bc.asof : undefined,
        includeAdjustment: adjCheck ? adjCheck.checked : false,
      } });
      showMsg(msg, 'ok', `Imported ${result.inserted} transactions, skipped ${result.skipped} already imported${result.dropped.length ? `, dropped ${result.dropped.length}` : ''}${result.adjustment ? `, adjustment ${money2(result.adjustment.amount)} added` : ''}.`);
      preview.innerHTML = '';
      spendImportParsed = null;
      reloadSpendView();
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
}

$('#spendImportParseBtn').addEventListener('click', async () => {
  const cardId = Number($('#spendImportCard').value);
  const file = $('#spendImportFile').files[0];
  const msg = $('#spendImportModalMsg');
  try {
    if (!file) throw new Error('Choose a QFX file to parse.');
    const text = await file.text();
    const data = await api(`/api/spending/cards/${cardId}/import-qfx/parse`, { method: 'POST', body: { qfxText: text } });
    spendImportParsed = data;
    spendImportPage = 0;
    spendImportOldOpen = false;
    spendImportOldPage = 0;
    renderSpendImportPreview(cardId, data);
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// AI category analysis (SPENDING-GLOBAL, overall page): one pass
// over ALL existing uncategorized transactions across ALL cards.
// The trigger sits in the section header beside + Add card; the
// preview lives in its own modal. Preview groups proposals by
// category; each group expands to its transactions, and each row's
// category is editable before Apply. A row edited in preview
// changes ONLY that row on Apply — the merchant mapping still
// takes the group's proposed category.
$('#spendAiAnalyzeBtn').addEventListener('click', async () => {
  const msg = $('#spendAiMsg');
  const host = $('#spendAiProposals');
  msg.className = 'msg';
  msg.textContent = '';
  host.innerHTML = '';
  openModal('spendAiModal');
  try {
    const data = await api('/api/spending/ai-categories', { method: 'POST', body: {} });
    if (!data.proposals.length) {
      host.innerHTML = '<div class="note">Nothing to categorize — every transaction already has a category.</div>';
      return;
    }
    const cats = [...document.querySelectorAll('#spendCategoryList option')].map((o) => o.value);
    const groups = new Map();
    for (const p of data.proposals) {
      const g = groups.get(p.category) || { category: p.category, merchants: [] };
      g.merchants.push(p);
      groups.set(p.category, g);
    }
    const rowHtml = (t, cat) => {
      const isPay = Number(t.amount) >= 0;
      const amt = isPay ? '−' + money(Number(t.amount)) : money(-Number(t.amount));
      return `<tr>
        <td>${esc(t.date)}</td><td>${esc(t.merchant)}</td><td>${esc(t.cardName || '')}</td><td>${amt}</td>
        <td><select data-ai-row-cat="${t.id}">${cats.map((c) => `<option value="${esc(c)}"${c === cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></td></tr>`;
    };
    host.innerHTML = [...groups.values()].map((g, gi) => `
      <div class="panel" data-ai-group="${gi}">
        <div class="toolbar"><label><input type="checkbox" data-ai-group-check="${gi}" checked> ${esc(g.category)}</label>
        <span class="note">${g.merchants.length} merchants · ${g.merchants.reduce((n, m) => n + m.txCount, 0)} transactions${g.merchants.some((m) => m.source === 'remembered') ? ' · remembered mapping' : ''}</span>
        <button class="small" data-ai-group-toggle="${gi}">Show transactions</button></div>
        <div class="hidden" data-ai-group-rows="${gi}">
          <table class="tbl"><thead><tr><th>Date</th><th>Merchant</th><th>Card</th><th>Amount</th><th>Category</th></tr></thead><tbody>
          ${g.merchants.map((m) => (m.transactions || []).map((t) => rowHtml(t, g.category)).join('')).join('')}
          </tbody></table>
        </div>
      </div>`).join('')
      + `<div class="toolbar"><button class="primary" id="spendAiApplyBtn">Apply categories</button></div>`;
    host.querySelectorAll('[data-ai-group-toggle]').forEach((b) => {
      b.onclick = () => {
        const rows = host.querySelector(`[data-ai-group-rows="${b.dataset.aiGroupToggle}"]`);
        if (rows) { rows.classList.toggle('hidden'); b.textContent = rows.classList.contains('hidden') ? 'Show transactions' : 'Hide transactions'; }
      };
    });
    $('#spendAiApplyBtn').addEventListener('click', async () => {
      const proposals = [];
      const overrides = [];
      [...groups.values()].forEach((g, gi) => {
        if (!host.querySelector(`[data-ai-group-check="${gi}"]`).checked) return;
        for (const m of g.merchants) proposals.push({ merchant: m.merchant, category: g.category });
        const rowsEl = host.querySelector(`[data-ai-group-rows="${gi}"]`);
        if (rowsEl) rowsEl.querySelectorAll('[data-ai-row-cat]').forEach((sel) => {
          if (sel.value !== g.category) overrides.push({ txId: Number(sel.dataset.aiRowCat), category: sel.value });
        });
      });
      try {
        const result = await api('/api/spending/ai-categories/apply', { method: 'POST', body: { proposals, overrides } });
        showMsg(msg, 'ok', `Applied ${result.mapped} merchant mappings, categorized ${result.updated} transactions. Mappings are remembered.`);
        host.innerHTML = '';
        closeModalEl($('#spendAiModal'));
        reloadSpendView();
      } catch (err) { showMsg(msg, 'err', err.message); }
    });
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// Card detail ✨ Fill with AI: the header button expands the
// panel; the panel itself proposes transaction rows from pasted
// text, and only Apply writes.
$('#spendFillToggleBtn').addEventListener('click', () => {
  $('#spendFillPanel').classList.toggle('hidden');
});
$('#spendFillBtn').addEventListener('click', async () => {
  const msg = $('#spendFillMsg');
  const host = $('#spendFillProposals');
  try {
    const data = await api(`/api/spending/cards/${currentSpendCardId}/fill`, { method: 'POST', body: { text: $('#spendFillText').value } });
    if (!data.proposals.length) {
      host.innerHTML = '<div class="note">No transactions extracted from this text.</div>';
      return;
    }
    host.innerHTML = `
      <table class="tbl"><thead><tr><th></th><th>Date</th><th>Merchant</th><th>Amount</th><th>Category</th></tr></thead><tbody>
      ${data.proposals.map((p, i) => `<tr>
        <td><input type="checkbox" data-fill-row="${i}" checked></td>
        <td>${esc(p.date)}</td><td>${esc(p.merchant)}</td><td>${money(-p.amount)}</td><td>${esc(p.category || '—')}</td></tr>`).join('')}
      </tbody></table>
      ${data.dropped.length ? `<div class="note">Dropped ${data.dropped.length} unparseable rows.</div>` : ''}
      <div class="toolbar"><button class="primary" id="spendFillApplyBtn">Apply transactions</button></div>`;
    $('#spendFillApplyBtn').addEventListener('click', async () => {
      const selected = data.proposals.filter((p, i) => host.querySelector(`[data-fill-row="${i}"]`).checked);
      try {
        const result = await api(`/api/spending/cards/${currentSpendCardId}/fill/apply`, { method: 'POST', body: { rows: selected } });
        showMsg(msg, 'ok', `Added ${result.inserted} transactions${result.dropped.length ? `, dropped ${result.dropped.length}` : ''}.`);
        host.innerHTML = '';
        loadSpendCard(currentSpendCardId);
      } catch (err) { showMsg(msg, 'err', err.message); }
    });
  } catch (err) { showMsg(msg, 'err', err.message); }
});

$('#spendDetailAddTxBtn').addEventListener('click', () => openSpendTxAdd(currentSpendCardId));

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
