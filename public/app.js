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
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.details = data;
    throw err;
  }
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
  for (const v of ['assets', 'property', 'asset', 'invest-account', 'invest-holding', 'earnings', 'spending', 'planning', 'history', 'tax', 'admin']) {
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

// Planning scenario state, declared up here because route() runs at
// startup before the planning section below has evaluated.
let planCompareScenarioIds = null; // null = not yet initialized for this project load
let planStrategyScenarioId; // undefined = server default (base scenario); 0 = explicit flat world; N = scenario N
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
    $('#earnRentalDetail').classList.add('hidden');
    $('#earnJobDetail').classList.remove('hidden');
    document.querySelectorAll('#earningsNav a').forEach((a) =>
      a.classList.toggle('active', a.dataset.section === 'salary'));
    loadEarnJobDetail(currentEarnJobId);
  } else if (hash.startsWith('#earnings/rental/')) {
    // Rental detail page: its own route, Rentals tab active, list hidden.
    currentEarnRentalId = Number(hash.split('/')[2]);
    showView('earnings');
    $('#earn-overview').classList.add('hidden');
    $('#earn-salary').classList.add('hidden');
    $('#earn-rentals').classList.add('hidden');
    $('#earnJobDetail').classList.add('hidden');
    $('#earnRentalDetail').classList.remove('hidden');
    document.querySelectorAll('#earningsNav a').forEach((a) =>
      a.classList.toggle('active', a.dataset.section === 'rentals'));
    loadEarnRentalDetail(currentEarnRentalId);
  } else if (hash === '#earnings' || hash.startsWith('#earnings/')) {
    showView('earnings');
    const sub = hash.split('/')[1] || 'salary';
    $('#earn-overview').classList.toggle('hidden', sub !== 'overview');
    $('#earn-salary').classList.toggle('hidden', sub !== 'salary');
    $('#earn-rentals').classList.toggle('hidden', sub !== 'rentals');
    $('#earnJobDetail').classList.add('hidden');
    $('#earnRentalDetail').classList.add('hidden');
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
  } else if (hash === '#planning') {
    showView('planning');
    loadPlanning();
  } else if (hash.startsWith('#planning/project/')) {
    showView('planning');
    loadPlanProject(Number(hash.split('/')[2]));
  } else if (hash.startsWith('#planning/strategy/')) {
    showView('planning');
    planStrategyScenarioId = undefined;
    loadPlanStrategy(Number(hash.split('/')[2]));
  } else if (hash.startsWith('#planning/scenario/')) {
    showView('planning');
    loadPlanScenario(Number(hash.split('/')[2]));
  } else if (hash.startsWith('#planning/report/')) {
    // Retired separate report page: old deep links land on the
    // project page with that report's tab open (inline viewer).
    showView('planning');
    const parts = hash.split('/');
    planReportPendingOpen = { projectId: Number(parts[2]), reportId: Number(parts[3]) };
    location.hash = `#planning/project/${parts[2]}`;
  } else if (hash === '#history') {
    showView('history');
    loadHistory();
  } else if (hash === '#tax') {
    showView('tax');
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

// ---------------------------------------------------------------- History --
// App-level commit log: every user Apply/Save is one commit. The tab
// lists commits newest first and offers undo / restore-to per commit.
let histCommits = [];
let histSelectedId = null;
let histDetailCache = null; // { id, commit } — last loaded detail, for re-renders
let histSearchTimer = null;

async function loadHistory() {
  const params = new URLSearchParams({ limit: 100 });
  const mod = $('#histModuleFilter').value;
  const q = $('#histSearch').value.trim();
  if (mod) params.set('module', mod);
  if (q) params.set('q', q);
  try {
    const r = await api(`/api/history/commits?${params}`);
    histCommits = r.commits || [];
    renderHistList();
    if (histSelectedId && !histCommits.some((c) => c.id === histSelectedId)) {
      // The open commit left the current render (filter/search) — collapse.
      histSelectedId = null;
      histDetailCache = null;
    } else if (histSelectedId) {
      // The open commit survived the re-render: the detail row is
      // already under its row; refill it from cache or re-fetch.
      if (histDetailCache && histDetailCache.id === histSelectedId) wireHistDetail(histDetailCache.commit);
      else fetchHistDetail(histSelectedId);
    }
  } catch (err) {
    $('#histList').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

function histKindLabel(kind) {
  return { commit: 'Save', revert: 'Revert', merge: 'Merge', 'merge-revert': 'Merge revert' }[kind] || kind;
}

function renderHistList() {
  const el = $('#histList');
  if (!histCommits.length) { el.innerHTML = '<div class="note">No commits yet.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>#</th><th>Date</th><th>Module</th><th>Entity</th><th>Summary</th><th>Changes</th></tr></thead><tbody>` +
    histCommits.map((c) => `<tr data-hist-id="${c.id}" style="cursor:pointer">
      <td>${c.id}</td><td>${new Date(c.created_at).toLocaleString('en-CA')}</td>
      <td>${esc(c.module)}</td><td>${esc(c.entity_label || `${c.entity_type} ${c.entity_id ?? ''}`)}</td>
      <td>${esc(c.summary)}</td><td>${c.eventCount}</td></tr>` +
      // Inline accordion: the open commit's detail renders as a row
      // directly under its own row — never at the bottom of the page.
      (c.id === histSelectedId
        ? `<tr class="hist-detail-row"><td colspan="6"><div class="hist-detail-body">${histDetailCache && histDetailCache.id === c.id ? histDetailHtml(histDetailCache.commit) : '<div class="note">Loading…</div>'}</div></td></tr>`
        : '')).join('') + `</tbody></table>`;
  el.querySelectorAll('[data-hist-id]').forEach((row) =>
    row.addEventListener('click', () => toggleHistDetail(Number(row.dataset.histId))));
}

$('#histModuleFilter').addEventListener('change', loadHistory);
$('#histRefreshBtn').addEventListener('click', loadHistory);
$('#histSearch').addEventListener('input', () => {
  clearTimeout(histSearchTimer);
  histSearchTimer = setTimeout(loadHistory, 300);
});

// Single-open accordion: clicking a row expands its detail under it
// (and collapses any other); clicking the open row collapses it.
function toggleHistDetail(id) {
  if (histSelectedId === id) {
    histSelectedId = null;
    histDetailCache = null;
    renderHistList();
    return;
  }
  histSelectedId = id;
  histDetailCache = null;
  renderHistList();
  fetchHistDetail(id);
}

async function fetchHistDetail(id) {
  try {
    const r = await api(`/api/history/commits/${id}`);
    if (histSelectedId !== id) return; // moved on; a stale fetch never fills
    histDetailCache = { id, commit: r.commit };
    const body = document.querySelector('#histList .hist-detail-body');
    if (body) { body.innerHTML = histDetailHtml(r.commit); wireHistDetail(r.commit); }
  } catch (err) {
    if (histSelectedId !== id) return;
    const body = document.querySelector('#histList .hist-detail-body');
    if (body) body.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

const HIST_VOLATILE = new Set(['created_at', 'updated_at', 'ai_thread']);
function histVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(String(v));
}
function histEntryHtml(e) {
  const pk = Object.entries(e.pk || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  const kind = !e.before ? 'Added' : !e.after ? 'Deleted' : 'Updated';
  let rows = '';
  if (!e.before) {
    rows = Object.entries(e.after).filter(([k]) => !HIST_VOLATILE.has(k))
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>—</td><td>${histVal(v)}</td></tr>`).join('');
  } else if (!e.after) {
    rows = Object.entries(e.before).filter(([k]) => !HIST_VOLATILE.has(k))
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${histVal(v)}</td><td>—</td></tr>`).join('');
  } else {
    rows = Object.keys({ ...e.before, ...e.after })
      .filter((k) => !HIST_VOLATILE.has(k) && JSON.stringify(e.before[k]) !== JSON.stringify(e.after[k]))
      .map((k) => `<tr><td>${esc(k)}</td><td>${histVal(e.before[k])}</td><td>${histVal(e.after[k])}</td></tr>`).join('');
  }
  return `<div class="section-head"><h3>${esc(e.table)} · ${esc(pk)} · ${kind}</h3></div>
    <table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No field changes</td></tr>'}</tbody></table>`;
}

function histDetailHtml(c) {
  const canUndo = c.kind !== 'merge-revert';
  const canRestore = c.kind === 'commit' || c.kind === 'revert';
  const projectLink = c.project_id ? `<div><a href="#planning/project/${c.project_id}">View project</a></div>` : '';
  const undoLabel = c.kind === 'merge' ? 'Revert merge' : 'Undo this commit';
  return `<div class="section-head"><h3>Commit #${c.id} · ${histKindLabel(c.kind)}</h3></div>
    <div>${esc(new Date(c.created_at).toLocaleString('en-CA'))} · ${esc(c.username || '')} · ${esc(c.module)} · ${esc(c.entity_label || '')}</div>
    <div><strong>${esc(c.summary)}</strong></div>
    ${projectLink}
    <div class="toolbar">
      ${canUndo ? `<button class="small" id="histUndoBtn">${undoLabel}</button>` : ''}
      ${canRestore ? `<button class="small" id="histRestoreBtn">Restore to this commit</button>` : ''}
    </div>
    <div class="msg" id="histDetailMsg"></div>
    <div id="histDiff">${(c.event || []).map(histEntryHtml).join('') || '<div class="note">No recorded changes</div>'}</div>`;
}

function showHistRevertError(msgEl, err, c) {
  const d = err.details || {};
  if (d.dependents && d.dependents.length) {
    const list = d.dependents.map((x) => `#${x.id} · ${esc(x.summary || '')}`).join('<br>');
    msgEl.className = 'msg err';
    msgEl.innerHTML = `Blocked — later commits touched the same rows:<br>${list}`;
    return;
  }
  if (d.conflicts && d.conflicts.length) {
    const link = c.strategy_id ? ` <a href="#planning/strategy/${c.strategy_id}">Resolve in the strategy merge wizard</a>` : '';
    msgEl.className = 'msg err';
    msgEl.innerHTML = `Blocked — merge conflicts need resolving.${link}`;
    return;
  }
  showMsg(msgEl, 'err', err.message);
}

function wireHistDetail(c) {
  const msgEl = $('#histDetailMsg');
  const undoBtn = $('#histUndoBtn');
  if (undoBtn) undoBtn.addEventListener('click', async () => {
    const verb = c.kind === 'merge' ? 'revert this merge' : 'undo this commit';
    if (!confirm(`Are you sure you want to ${verb}?`)) return;
    try {
      const r = await api(`/api/history/commits/${c.id}/undo`, { method: 'POST' });
      showMsg(msgEl, 'ok', `Done — new commit #${r.commitId}`);
      // The list re-render rebuilds the accordion body from cache,
      // wiping the message — re-apply it once the render lands.
      loadHistory().then(() => { const m = $('#histDetailMsg'); if (m) showMsg(m, 'ok', `Done — new commit #${r.commitId}`); });
    } catch (err) { showHistRevertError(msgEl, err, c); }
  });
  const restoreBtn = $('#histRestoreBtn');
  if (restoreBtn) restoreBtn.addEventListener('click', async () => {
    if (!confirm(`Restore to commit #${c.id}? Current state will be replaced by this commit's snapshot.`)) return;
    try {
      const r = await api(`/api/history/commits/${c.id}/restore`, { method: 'POST' });
      showMsg(msgEl, 'ok', `Done — new commit #${r.commitId}`);
      loadHistory().then(() => { const m = $('#histDetailMsg'); if (m) showMsg(m, 'ok', `Done — new commit #${r.commitId}`); });
    } catch (err) { showHistRevertError(msgEl, err, c); }
  });
}

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
let pfRangeMonths = 12;
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
function earnRentalsSeriesDefs() {
  const defs = [];
  if (earnChartData) earnChartData.properties.forEach((p, i) => defs.push(earnDef(`rental:${p.id}`, `${p.label} net`, i)));
  return [...defs, ...CHART_SERIES.earnRentals];
}
const earnSeriesDefs = { earnOverview: earnOverviewSeriesDefs, earnRentals: earnRentalsSeriesDefs };

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

const LIVE_CHARTS = { hero: () => chartA, history: () => historyChart, portfolio: () => portfolioLineChart, earnOverview: () => earnOverviewChart, earnRentals: () => earnRentalsChart };

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
window.__fmCharts = Object.assign(window.__fmCharts || {}, { a: null, b: null, prime: null, history: null, earnOverview: null, earnRentals: null, earnJobMonthly: null, earnRentalDetail: null });

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
  investments: { months: 12, custom: null, ytd: false },
  investAccount: { months: 12, custom: null, ytd: false },
  investHolding: { months: 12, custom: null, ytd: false },
  overview: { months: 12, custom: null, ytd: false },
  rentIncome: { months: 12, custom: null, ytd: false },
  spending: { months: 12, custom: null, ytd: false },
  spendCard: { months: 12, custom: null, ytd: false },
};
// Range presets by page family: stock pages keep the old
// 1/2/5/10y/All set; spending/salary/rental pickers get 3 months +
// this year + 2 years + All; every other invest picker gets this
// year + 2 years + All (no 3 months). Every picker DEFAULTS to a
// one-year trailing range (months: 12 above) — the default is a
// range, not a preset, so on spend/plain sets no button starts
// active; the From/To fields show the range in force.
const INVEST_RANGE_PRESETS = {
  stock: [
    { months: 12, label: '1 year' }, { months: 24, label: '2 years' },
    { months: 60, label: '5 years' }, { months: 120, label: '10 years' },
    { months: 0, label: 'All' },
  ],
  spend: [
    { months: 3, label: '3 months' }, { ytd: true, label: 'This year' },
    { months: 24, label: '2 years' }, { months: 0, label: 'All' },
  ],
  plain: [
    { ytd: true, label: 'This year' },
    { months: 24, label: '2 years' }, { months: 0, label: 'All' },
  ],
};
const INVEST_RANGE_PRESET_SET = {
  investments: 'stock', investAccount: 'stock', investHolding: 'stock',
  spending: 'spend', spendCard: 'spend', rentIncome: 'spend',
  overview: 'plain',
};
const investViewData = {}; // level -> { series, monthly, cur, nativePct }
let invPop = null; // { level, which: 'start'|'end', year }

function investRangeControlsHtml(level) {
  const st = investRanges[level];
  const presets = INVEST_RANGE_PRESETS[INVEST_RANGE_PRESET_SET[level] || 'plain'];
  const btns = presets.map((p) => {
    if (p.ytd) return `<button type="button" data-ytd="1" class="${!st.custom && st.ytd ? 'active' : ''}">This year</button>`;
    return `<button type="button" data-months="${p.months}" class="${!st.custom && !st.ytd && st.months === p.months ? 'active' : ''}">${p.label}</button>`;
  }).join('\n    ');
  return `<div class="toolbar range-btns" id="invRangeBtns-${level}">
    ${btns}
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
  if (st.ytd) {
    // This year: calendar January through the latest data month
    // (data never runs past the current month, so the span end
    // is the current month in practice).
    const jan = `${monthStrOf(new Date()).slice(0, 4)}-01`;
    return { start: jan < span.start ? span.start : jan, end: span.end };
  }
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
  // The combined Total income panel's chart is the annual chart
  // (the monthly history chart was removed by the restructure), so
  // the generic destroy in applyInvestRange targets it.
  rentIncome: {
    canvas: '#earnRentalsChart', key: 'rentIncome', monthly: null,
    get: () => earnRentalsChart, set: (c) => { earnRentalsChart = c; window.__fmCharts.earnRentals = c; },
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
    // The combined Total income panel: the share (flow semantics)
    // plus the annual chart, both from the same range. The generic
    // destroy above already destroyed the old annual chart
    // instance, so null the variable first — drawEarnRentalsChart's
    // own destroy-guard must not double-destroy it. An empty share
    // hides only the share; the annual chart's visibility follows
    // its own empty rule. The monthly history chart is gone.
    drawRentIncomeShareChart(d, r);
    earnRentalsChart = null; window.__fmCharts.earnRentals = null; window.__fmCharts.rentIncome = null;
    conf.set(drawEarnRentalsChart());
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
    b.classList.toggle('active', !st.custom && !st.ytd && Number(b.dataset.months) === st.months);
  });
  bar.querySelectorAll('button[data-ytd]').forEach((b) => {
    b.classList.toggle('active', !st.custom && !!st.ytd);
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
      investRanges[level].ytd = false;
      closeInvMonthPop();
      applyInvestRange(level);
      return;
    }
    const ytdBtn = e.target.closest('button[data-ytd]');
    if (ytdBtn) {
      investRanges[level].custom = null;
      investRanges[level].ytd = true;
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
      <td class="num">${p.own_pct != null ? `${p.own_pct}%${p.derived_own_amount != null ? ` · ${moneyC(p.derived_own_amount, cur)}` : ''}` : moneyC(p.own_amount, cur)}</td>
      <td class="num">${p.employer_pct != null ? `${p.employer_pct}%${p.derived_employer_amount != null ? ` · ${moneyC(p.derived_employer_amount, cur)}` : ''}` : (p.employer_amount != null ? moneyC(p.employer_amount, cur) : '—')}</td>
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
// Amount-mode toggle: fixed dollars show the amount inputs,
// percent-of-pay shows the percent inputs (employer percent stays
// RRSP-gated like the employer amount). Required follows the
// visible mode, so the hidden mode can never block submit.
function syncInvestPlanMode() {
  const mode = $('#investPlanMode').value || 'fixed';
  const isRrsp = investAccountData && investAccountData.account && investAccountData.account.type === 'RRSP';
  const pct = mode === 'percent';
  $('#investPlanPctRow').classList.toggle('hidden', !pct);
  $('#investPlanOwnAmountWrap').classList.toggle('hidden', pct);
  $('#investPlanEmployerWrap').classList.toggle('hidden', pct || !isRrsp);
  $('#investPlanEmployerPctWrap').classList.toggle('hidden', !pct || !isRrsp);
  const form = $('#investPlanForm');
  form.elements.own_amount.required = !pct;
  form.elements.own_pct.required = pct;
}
async function openInvestPlanModal(id) {
  const form = $('#investPlanForm');
  form.reset();
  $('#investPlanModalMsg').className = 'msg';
  form.elements.id.value = id || '';
  $('#investPlanModalTitle').textContent = id ? 'Edit plan' : 'Add plan';
  const account = investAccountData ? investAccountData.account : null;
  $('#investPlanMode').onchange = syncInvestPlanMode;
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
      if (p.own_pct != null) {
        form.elements.amount_mode.value = 'percent';
        form.elements.own_pct.value = p.own_pct;
        form.elements.employer_pct.value = p.employer_pct != null ? p.employer_pct : '';
      } else {
        form.elements.amount_mode.value = 'fixed';
        setMoneyValue(form.elements.own_amount, p.own_amount);
        setMoneyValue(form.elements.employer_amount, p.employer_amount);
      }
      syncInvestPlanFrequency();
    }
  } else {
    form.elements.amount_mode.value = 'fixed';
    syncInvestPlanFrequency();
  }
  syncInvestPlanMode();
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
    // One Apply = one History commit: the whole checked draft goes
    // in a single batch call (the server validates and writes it
    // atomically), instead of one POST per row.
    await api(`/api/investments/accounts/${investChatAccountId}/fill/apply`, {
      method: 'POST', body: { holdings: chosenHoldings, events: chosenEvents, nav: chosenNav },
    });
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
  // Planning op-date fields resolve to the button that opened the
  // picker (held in planMonthBtn while it is open).
  if (monthPopFor === 'planOp') return planMonthBtn;
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
  // Planning op dates: any month in the server's valid range.
  if (monthPopFor === 'planOp') return { start: '2000-01', end: '2100-12' };
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
  // An empty entry or plan-op field opens on the current year, not
  // on the span's last year (2100 would be a long step back).
  // Range fields keep the span-end default (unchanged).
  if (monthPopYear == null) monthPopYear = selected ? Number(selected.slice(0, 4)) : ((monthPopIsEntry() || monthPopFor === 'planOp') ? new Date().getFullYear() : maxYear);
  monthPopYear = Math.min(Math.max(monthPopYear, minYear), maxYear);
  $('#monthPopYear').textContent = String(monthPopYear);
  $('#monthPopPrev').disabled = monthPopYear <= minYear;
  $('#monthPopNext').disabled = monthPopYear >= maxYear;
  // Plan-op preselect: with no value yet, the nearest future month
  // is highlighted as a visual hint ONLY — the field stays blank
  // until the user clicks a cell (so a blank date still builds a
  // bare strategy). Only that one month ever carries the class.
  let preYm = null;
  if (monthPopFor === 'planOp' && !selected) {
    const nx = new Date(); nx.setMonth(nx.getMonth() + 1);
    preYm = `${nx.getFullYear()}-${String(nx.getMonth() + 1).padStart(2, '0')}`;
  }
  $('#monthPopGrid').innerHTML = MONTH_NAMES.map((name, i) => {
    const ym = `${monthPopYear}-${String(i + 1).padStart(2, '0')}`;
    const off = ym < span.start || ym > span.end;
    const cls = ym === selected ? ' class="sel"' : (ym === preYm ? ' class="pre"' : '');
    return `<button type="button" data-ym="${ym}"${off ? ' disabled' : ''}${cls}>${name}</button>`;
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
  document.querySelectorAll('[data-plan-diff-month]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
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
  // Planning op date: a pick fills the button label (formatted
  // month) and the hidden input (YYYY-MM-01, day fixed to 01).
  // The hidden input is written via the BUTTON'S SIBLING, never via
  // getElementById: planMonthBtnHtml renders the same
  // #planOpDateVal id in both the Add-strategy first-op section and
  // the Add-operation modal, so a global lookup wrote the lingering
  // strategy form's input while the submit read the op modal's own
  // (still empty) one — "date is required" on a picked date.
  if (monthPopFor === 'planOp') {
    const ym = cell.dataset.ym;
    if (planMonthBtn) { planMonthBtn.dataset.value = ym; planMonthBtn.textContent = formatYM(ym); }
    const sib = planMonthBtn ? planMonthBtn.nextElementSibling : null;
    const hid = (sib && sib.id === 'planOpDateVal') ? sib : document.getElementById('planOpDateVal');
    if (hid) hid.value = ym + '-01';
    closeMonthPop();
    return;
  }
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
    st.preset = null;
    document.querySelectorAll(`[data-earn-range="${key}"] [data-years]`).forEach((b) => b.classList.remove('active'));
    document.querySelectorAll(`[data-earn-range="${key}"] [data-preset]`).forEach((b) => b.classList.remove('active'));
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
  if (e.target.closest('#monthPop') || e.target.closest('#rangeStart') || e.target.closest('#rangeEnd') || e.target.closest('#earnEntryStartBtn') || e.target.closest('#earnEntryEndBtn') || e.target.closest('[data-earn-month]') || e.target.closest('[data-plan-month]') || e.target.closest('[data-plan-diff-month]')) return;
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

// Next pay date highlight on the job card: date + take-home on one
// line, mirroring the detail page's Next net pay date card. Dateless
// jobs get no line at all. (The detail page folds this into its own
// combo card and never renders this line.)
// Cash take-home: the calc's cashNet fields (economic net minus the
// own RRSP deduction). The deferred tax benefit is still inside
// them, so the take-home display subtracts the period's benefit to
// show the paycheque figure, with the benefit on its own sub-line.
// Falls back to the economic net when the calc predates the cash
// fields — never on a fresh read, where the two agree exactly for
// no-plan jobs.
const earnCashPerPeriod = (c) => (c.perPeriod.cashNet != null ? c.perPeriod.cashNet : c.perPeriod.net);
const earnCashAnnual = (c) => (c.cashNetAnnual != null ? c.cashNetAnnual : c.netAnnual);
// Take-home on the job card: cash as the main figure, the tax benefit
// as its own sub-line (mirrors the detail page's cards).
function earnNextPayHtml(j) {
  if (!j.next_pay_date) return '';
  const tb = j.taxBenefit || null;
  const cash = earnCashPerPeriod(j.calc);
  return `<div class="note earn-next-pay">Next pay date · ${esc(earnJobDateLabel(j.next_pay_date))} · Take-home ${money2(tb ? cash - tb.perPeriod : cash)}${tb ? ` + ${money2(tb.perPeriod)} tax benefit` : ''}</div>`;
}

function earnJobCard(j) {
  const c = j.calc;
  const tb = j.taxBenefit || null; // null when no active RRSP deduction saves tax: cash figures stand alone.
  const freqLabel = (earnData.payFrequencies.find((f) => f.key === j.frequency) || {}).label || j.frequency;
  return `<div class="panel earn-job-card" data-job-id="${j.id}" style="cursor:pointer">
    <div class="section-head"><h3>${esc(j.employer)}</h3><span class="note">${esc(j.province)} · ${esc(freqLabel)} · ${esc(j.currency)}</span>
    ${j.owner ? `<span style="margin-left:8px">${ownerChipsHtml([j.owner])}</span>` : ''}
    <div class="spacer"></div></div>
    ${earnNextPayHtml(j)}
    <div class="summary-strip">
      <div class="summary-card"><div class="k">Annual gross</div><div class="v">${money2(c.annualGross)}</div></div>
      <div class="summary-card"><div class="k">Annual net</div><div class="v">${money2(tb ? earnCashAnnual(c) - tb.annual : earnCashAnnual(c))}</div>${tb ? `<div class="n">+ ${money2(tb.annual)} tax benefit</div>` : ''}</div>
      <div class="summary-card"><div class="k">Net per pay period</div><div class="v">${money2(tb ? earnCashPerPeriod(c) - tb.perPeriod : earnCashPerPeriod(c))}</div>${tb ? `<div class="n">+ ${money2(tb.perPeriod)} tax benefit</div>` : ''}</div>
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
// Rent entries as a table (Period | Monthly rent | Paid on day |
// Cash | actions), styled like the other tables on the page. The
// entry covering the current month carries an Ongoing tag; a tenant
// name, when set, shows under the period.
function earnEntryTableHtml(r) {
  const entries = [...(r.entries || [])].sort((a, b) => (a.start_ym || '').localeCompare(b.start_ym || ''));
  if (!entries.length) return '<div class="note">No rent entries yet.</div>';
  const nowYm = monthStrOf(new Date());
  const rows = entries.map((e) => {
    const ongoing = e.start_ym <= nowYm && (e.end_ym == null || e.end_ym === '' || e.end_ym >= nowYm);
    const period = `${ymLabel(e.start_ym)} – ${ymLabel(e.end_ym)}${ongoing ? ' <span class="meta-tag">Ongoing</span>' : ''}${e.tenant_name ? `<div class="note" style="margin:0">${esc(e.tenant_name)}</div>` : ''}`;
    return `<tr><td>${period}</td><td class="num">${money2(e.monthly_rent)}</td><td class="num">${e.pay_day}</td><td class="num">${e.cash_amount !== null && e.cash_amount !== undefined ? money2(e.cash_amount) : '—'}</td><td class="num"><button class="small" onclick="earnEditEntry(${r.id}, ${e.id})">Edit</button> <button class="small danger" onclick="earnDeleteEntry(${r.id}, ${e.id})">Delete</button></td></tr>`;
  }).join('');
  return `<table class="costs-table"><thead><tr><th>Period</th><th class="num">Monthly rent</th><th class="num">Paid on day</th><th class="num">Cash</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function earnRentalCard(r) {
  const hidden = rentHiddenRentals.has(r.id);
  const nxt = r.nextRentDue;
  // The list card stays slim: title + the next payment headline
  // only. Entries and year records live on the detail page.
  return `<div class="panel rent-card earn-rental-card" data-rental-id="${r.id}" style="cursor:pointer">
    <button type="button" class="rent-hide-btn invest-eye-btn${hidden ? ' invest-eye-hidden' : ''}" data-rental-id="${r.id}" title="${hidden ? 'Show' : 'Hide'}" aria-label="${hidden ? 'Show' : 'Hide'}" onclick="toggleRentRental(${r.id})">${RENT_EYE_SVG}</button>
    <div class="section-head"><h3>${esc(r.label)}</h3><span class="note">${esc(r.rental_type)} · ${esc(r.services_level)} · ${r.ownership_pct}% owned</span></div>
    ${nxt
    ? `<div class="summary-strip"><div class="summary-card"><div class="k">Next rent due</div><div class="v">${esc(earnJobDateLabel(nxt.date))}</div><div class="n">${money2(nxt.amount)}</div></div></div>`
    : `<div class="note">No upcoming payment</div>`}
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
let earnRentalsChart = null;
let earnRentalsView = 'net';
const earnChartRanges = {
  // Overview only now: the rentals summary is driven by the shared
  // invest-range picker (level 'rentIncome'), not by this state.
  // Default is All (the whole data range); presets are 3 months
  // (salary pages only — on annual data it resolves to the current
  // tax year), this year, 2 years, All.
  overview: { years: 0, from: null, to: null, fromYm: null, toYm: null, preset: null },
};

function earnRangeControlsHtml(key) {
  const st = earnChartRanges[key];
  const presets = [['3mo', '3 months'], ['ytd', 'This year'], [2, '2 years'], [0, 'All']];
  // The same month-field buttons + shared #monthPop the
  // property-detail panel uses (never native year selects: their
  // popup renders detached from the panel). The button keeps the
  // picked month's label; the picked month's YEAR drives the
  // existing year filter below. Annual data cannot express
  // months, so 3 months and this year both resolve to the
  // current tax year (from/to = that year).
  return `<div class="toolbar range-btns" data-earn-range="${key}">`
    + presets.map(([n, label]) => {
      const isPreset = n === '3mo' || n === 'ytd';
      const active = isPreset ? st.preset === n : (st.preset == null && st.years === n && st.from == null && st.to == null);
      const attr = isPreset ? `data-preset="${n}"` : `data-years="${n}"`;
      return `<button type="button" ${attr} class="${active ? 'active' : ''}">${label}</button>`;
    }).join('')
    + `<span class="range-pick">From <button type="button" data-earn-month="from" class="month-field" data-value="${st.fromYm || ''}" aria-haspopup="dialog" aria-expanded="false" aria-label="Range start month">${formatYM(st.fromYm)}</button></span>`
    + `<span class="range-pick">To <button type="button" data-earn-month="to" class="month-field" data-value="${st.toYm || ''}" aria-haspopup="dialog" aria-expanded="false" aria-label="Range end month">${formatYM(st.toYm)}</button></span></div>`;
}

function earnWireRange(key) {
  const wrap = document.querySelector(`[data-earn-range="${key}"]`);
  if (!wrap) return;
  const st = earnChartRanges[key];
  wrap.querySelectorAll('[data-years]').forEach((b) => {
    b.onclick = () => {
      st.preset = null;
      st.years = Number(b.dataset.years); st.from = null; st.to = null; st.fromYm = null; st.toYm = null;
      wrap.querySelectorAll('[data-earn-month]').forEach((f) => { f.dataset.value = ''; f.textContent = '—'; f.setAttribute('aria-expanded', 'false'); });
      wrap.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('active'));
      drawEarnVisibleChart();
    };
  });
  wrap.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const curYm = monthStrOf(new Date());
      const curYear = Number(curYm.slice(0, 4));
      st.preset = b.dataset.preset; st.from = curYear; st.to = curYear;
      st.fromYm = `${curYear}-01`; st.toYm = curYm;
      wrap.querySelectorAll('[data-years]').forEach((x) => x.classList.remove('active'));
      wrap.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('active', x === b));
      const from = wrap.querySelector('[data-earn-month="from"]');
      const to = wrap.querySelector('[data-earn-month="to"]');
      if (from) { from.dataset.value = st.fromYm; from.textContent = formatYM(st.fromYm); }
      if (to) { to.dataset.value = st.toYm; to.textContent = formatYM(st.toYm); }
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

// The combined Total income panel's RIGHT chart: the annual chart
// with its Net by property / Income vs expenses toggle, now driven
// by the SAME invest-range picker as the share (level 'rentIncome'),
// not by its own year picker. Years come from the shared years list
// filtered to the picker's effective month range; All (or no range)
// shows every year, preserving the old default view. A 1-year
// preset can span two tax years — that is inherent to sharing a
// month picker, not a bug.
// Bars = the breakdown; the line = the total, in both modes: net
// mode's line is 'Total net' (sum of the per-rental bars), income
// mode's line is 'Net' (gross minus expenses — the stack sum would
// double-count). The line dataset carries no key, so the Colors
// panel ignores it; legend clicks recompute it from the VISIBLE
// bar series only, so it can never disagree with the bars.
// The monthly history chart this panel used to carry is gone: the
// combined panel has exactly one chart. Eye-hide affects the share
// only, never this chart (its own legend toggles are its
// mechanism).
function drawEarnRentalsChart() {
  const st = investRanges.rentIncome;
  const years = rentAnnualYears((earnChartData && earnChartData.years) || [],
    investEffectiveRange('rentIncome'), !st.custom && !st.months && !st.ytd);
  if (earnRentalsChart) { earnRentalsChart.destroy(); earnRentalsChart = null; window.__fmCharts.earnRentals = null; }
  const r = earnChartData && earnChartData.rentals;
  const empty = rentAnnualEmpty(r, years);
  earnSetEmpty('earnRentalsChart', 'earnRentalsEmpty', empty);
  if (empty) return null;
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
  // Total line, drawn on top of the bars (order beats the bars'
  // default 0). No key: the Colors panel must not offer it.
  const lineData = earnRentalsView === 'income'
    ? years.map((y) => Math.round((((r[y] && r[y].gross) || 0) - ((r[y] && r[y].expenses) || 0)) * 100) / 100)
    : years.map((y) => Math.round(earnChartData.properties.reduce((s, p) => s + ((r[y] && r[y].properties && r[y].properties[p.id] ? r[y].properties[p.id].net : 0)), 0) * 100) / 100);
  datasets.push({ type: 'line', label: earnRentalsView === 'income' ? 'Net' : 'Total net', data: lineData, borderColor: '#22303c', backgroundColor: '#22303c', tension: 0.15, pointRadius: 0, borderWidth: 2, order: 1 });
  const base = earnChartBase();
  if (earnRentalsView === 'income') { base.options.scales.x.stacked = true; base.options.scales.y.stacked = true; }
  base.options.plugins.legend.onClick = earnRentalsLegendClick;
  earnRentalsChart = new Chart($('#earnRentalsChart'), { type: 'bar', data: { labels: years.map(String), datasets }, ...base });
  window.__fmCharts.earnRentals = earnRentalsChart;
  return earnRentalsChart;
}

// Legend clicks toggle a series AND recompute the total line from
// the visible bar series only, so the line can never disagree with
// the bars on screen. Income mode: visible gross minus visible
// expenses; net mode: sum of the visible per-rental bars.
function earnRentalsLegendClick(e, item, legend) {
  const chart = legend.chart;
  const idx = item.datasetIndex;
  chart.setDatasetVisibility(idx, !chart.isDatasetVisible(idx));
  const line = chart.data.datasets.find((d) => d.type === 'line');
  if (line) {
    line.data = chart.data.labels.map((_, i) => {
      let t = 0;
      chart.data.datasets.forEach((d, j) => {
        if (d.type === 'line' || !chart.isDatasetVisible(j)) return;
        const v = Number(d.data[i]) || 0;
        if (earnRentalsView === 'income') t += (d.key === 'gross' ? v : d.key === 'expenses' ? -v : 0);
        else t += v;
      });
      return Math.round(t * 100) / 100;
    });
  }
  chart.update();
}

// From/To always name the range actually in force: a preset that
// carries no explicit months (All, or a years-count preset) leaves
// st.fromYm/st.toYm unset, so the buttons show the effective range's
// first/last month instead of '—'. A preset or manual pick that set
// its own months keeps them — only the unset side is filled, and the
// state itself is never rewritten (the buttons are a display of the
// effective range, not a new selection).
function earnSyncRangeDisplay(key) {
  const st = earnChartRanges[key];
  const wrap = document.querySelector(`[data-earn-range="${key}"]`);
  if (!wrap) return;
  const years = earnEffectiveYears(key);
  if (!years.length) return;
  const from = wrap.querySelector('[data-earn-month="from"]');
  const to = wrap.querySelector('[data-earn-month="to"]');
  if (from && (st.fromYm == null || st.fromYm === '')) {
    const ym = `${years[0]}-01`;
    from.dataset.value = ym; from.textContent = formatYM(ym);
  }
  if (to && (st.toYm == null || st.toYm === '')) {
    const ym = `${years[years.length - 1]}-12`;
    to.dataset.value = ym; to.textContent = formatYM(ym);
  }
}

function drawEarnVisibleChart() {
  // The Salary view carries no chart: its annual chart moved to the
  // job detail page as a monthly stacked chart, so the salary
  // branch is deliberately empty — only overview and rentals draw.
  const sub = (location.hash.split('/')[1] || 'salary');
  if (sub === 'overview') {
    $('#earnOverviewRange').innerHTML = earnRangeControlsHtml('overview');
    earnWireRange('overview');
    drawEarnOverviewChart();
    earnSyncRangeDisplay('overview');
  } else if (sub === 'rentals') {
    // The Rentals summary is ONE combined panel: the rentIncome
    // picker drives both the share and the annual chart, so there
    // is no separate earn-range picker for rentals anymore.
    drawRentIncomePanel();
  }
}

// ------------------------------------------------- rentals income panel --
// Total income over the selected range, from rent entries only: LEFT
// share doughnut (one slice per rental, share of range income —
// income is a flow, so this is deliberately NOT the Stocks
// range-end point-in-time share) + RIGHT annual chart (bars =
// breakdown, line = total, Net by property / Income vs expenses
// toggle), both driven by the Stocks range picker (same presets +
// month popover machinery, level 'rentIncome'). Year-record other
// income (8230), expenses and the T776 computation never enter the
// share. Per-rental Hide mirrors Stocks exactly: the same
// open/closed eye-pair button at the card's top-right corner, one
// per-visit hidden set shared with the share legend, card greys out.
// Hide affects the share only — never the annual chart, entries,
// years or tax calcs.
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
  // The annual chart column's visibility is governed by the annual
  // chart's own empty rule, never by the share's: an empty share no
  // longer hides the chart (the old code hid both wraps).
  if (!rows.length) {
    if (rentIncomeShareChart) { rentIncomeShareChart.destroy(); rentIncomeShareChart = null; }
    rentIncomeShareCenter = null;
    window.__fmCharts.rentIncomeShare = null;
    window.__fmCharts.rentIncomeShareCenter = null;
    if (wrap) wrap.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return false;
  }
  if (wrap) wrap.classList.remove('hidden');
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
// start date, recent pay date and recent pay value. Pay changes
// (raises) and bonuses live on the job detail page only — the modal
// edits scalar fields, and a save leaves the child rows untouched
// (the server replaces them only when the PUT carries them).
// A job edited without dates keeps its stored gross / tax year /
// YTD untouched (the server leaves derived columns alone on a
// legacy save), so old jobs keep computing exactly as before.
let earnEditJobOrig = null;

function earnJobResetModal(title) {
  $('#earnJobFormTitle').textContent = title;
  $('#earnJobForm').reset();
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
// Clicking a rental card (anywhere but its buttons) opens its detail page.
$('#earnRentalList').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  const card = e.target.closest('.earn-rental-card');
  if (card) location.hash = '#earnings/rental/' + card.dataset.rentalId;
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
  openModal('earnJobModal');
};
attachAiFill($('#earnJobForm'), 'job');
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
// here; the detail header carries no job-level Edit/Delete buttons —
// only a plain assetBackLink-style Back to Salary link above the
// card — and the job itself is edited and deleted from a bottom
// actions row inside the detail body, reusing the card handlers.
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

// Per-pay tax benefit table with a year pager (same pattern as the
// report table's year pager): one page per year with a saving,
// defaulting to the latest year; no pager buttons for a single year.
// The selected year lives in module state and resets when another
// job's detail page loads.
let earnJobTaxBenefitPaysYearSel = null;
function earnJobTaxBenefitPaysHtml(tb) {
  const groups = (tb && tb.paysByYear) || [];
  if (!groups.length) return '';
  const latest = groups[groups.length - 1].year;
  const year = groups.some((g) => g.year === earnJobTaxBenefitPaysYearSel) ? earnJobTaxBenefitPaysYearSel : latest;
  const g = groups.find((x) => x.year === year);
  const pager = groups.length > 1
    ? `<div id="earnJobTaxBenefitPaysPager">${groups.map((x) => `<button class="small${x.year === year ? ' active' : ''}" data-earn-tb-year="${x.year}" onclick="earnJobTaxBenefitPaysYear(${x.year})">${x.year}</button>`).join('')}</div>`
    : '';
  const rows = g.rows.map((r) => `<tr><td>${earnJobDateLabel(r.date)}</td><td>${money2(r.benefit)}</td></tr>`).join('');
  return `${pager}<table id="earnJobTaxBenefitPaysTable"><thead><tr><th>Pay date</th><th>Tax benefit</th></tr></thead><tbody>
        ${rows}
        <tr><td>Total (${g.year})</td><td>${money2(g.total)}</td></tr>
      </tbody></table>`;
}
window.earnJobTaxBenefitPaysYear = (year) => {
  earnJobTaxBenefitPaysYearSel = Number(year);
  const j = earnData.jobs.find((x) => x.id === currentEarnJobId);
  const wrap = document.querySelector('#earnJobTaxBenefitPaysWrap');
  if (j && j.taxBenefit && wrap) wrap.innerHTML = earnJobTaxBenefitPaysHtml(j.taxBenefit);
};

function earnJobDetailHtml(j) {
  const c = j.calc;
  const tb = j.taxBenefit || null; // null when no active RRSP deduction saves tax: no section, no marker.
  const freqLabel = (earnData.payFrequencies.find((f) => f.key === j.frequency) || {}).label || j.frequency;
  const tbPeriods = (earnData.payFrequencies.find((f) => f.key === j.frequency) || {}).periods || 26;
  // History view: the opening position first, then every pay-change
  // entry in date order; the latest entry's result IS the current
  // position, so it carries the marker (the opening row carries it
  // when no change exists yet).
  const pcDesc = (r) => {
    let s = `${earnJobDateLabel(r.effective_date)} · ${money2(r.amount ?? r.value)}`;
    if (r.basis === 'takehome') s += ' take-home';
    s += r.scope === 'annual' ? ' / year' : ' / period';
    if (r.basis === 'takehome' || r.scope === 'annual') s += ` → ${money2(r.value)} / period`;
    return s;
  };
  const pcParts = [];
  const changes = j.pay_changes || [];
  if (j.opening_value != null && j.start_date) {
    pcParts.push(`<div class="note">${earnJobDateLabel(j.start_date)} · ${money2(j.opening_value)} / period · Opening position${changes.length === 0 ? ' · Current position' : ''}</div>`);
  }
  changes.forEach((r, i) => {
    pcParts.push(`<div class="note">${pcDesc(r)}${i === changes.length - 1 ? ' · Current position' : ''}
    <button class="small" onclick="earnJobDetailOpenRow('pay_change', ${i})">Edit</button>
    <button class="small danger" onclick="earnJobDetailDeleteRow('pay_change', ${i})">Delete</button></div>`);
  });
  const pcRows = pcParts.join('');
  const bonusRows = (j.bonuses || []).map((b, i) => `<div class="note">${earnJobDateLabel(b.date)} · ${money2(b.amount)}
    <button class="small" onclick="earnJobDetailOpenRow('bonus', ${i})">Edit</button>
    <button class="small danger" onclick="earnJobDetailDeleteRow('bonus', ${i})">Delete</button></div>`).join('');
  return `<div class="toolbar"><a id="earnJobBackLink" href="#earnings/salary">← Back to Salary</a><div class="spacer"></div></div>
    <div class="msg" id="earnJobDetailMsg"></div>
    <div class="panel">
      <div class="section-head"><h3>${esc(j.employer)}</h3><span class="note">${esc(j.province)} · ${esc(freqLabel)} · ${esc(j.currency)}</span>
      ${j.owner ? `<span style="margin-left:8px">${ownerChipsHtml([j.owner])}</span>` : ''}
      <div class="spacer"></div><button class="small" id="earnJobDetailEditBtn" onclick="earnEditJob(${j.id})">Edit</button><button class="small danger" id="earnJobDetailDeleteBtn" onclick="earnDeleteJob(${j.id})">Delete</button></div>
      <div class="summary-strip">
        <div class="summary-card"><div class="k">Annual gross</div><div class="v">${money2(c.annualGross)}</div></div>
        <div class="summary-card"><div class="k">Annual net</div><div class="v">${money2(tb ? earnCashAnnual(c) - tb.annual : earnCashAnnual(c))}</div>${tb ? `<div class="n">+ ${money2(tb.annual)} tax benefit</div>` : ''}</div>
        ${j.next_pay_date
          ? `<div class="summary-card"><div class="k">Next net pay date</div><div class="v">${esc(earnJobDateLabel(j.next_pay_date))}</div><div class="n">${tb ? `${money2(earnCashPerPeriod(c) - tb.perPeriod)} + ${money2(tb.perPeriod)} tax benefit` : money2(earnCashPerPeriod(c))}</div></div>`
          : `<div class="summary-card"><div class="k">Net per pay period</div><div class="v">${money2(tb ? earnCashPerPeriod(c) - tb.perPeriod : earnCashPerPeriod(c))}</div>${tb ? `<div class="n">+ ${money2(tb.perPeriod)} tax benefit</div>` : ''}</div>`}
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
    </div>
    ${j.start_date && j.recent_pay_date ? `<div class="panel" id="earnJobMonthlyPanel">
      <div class="section-head"><h3>Monthly pay</h3></div>
      <div><canvas id="earnJobMonthlyChart"></canvas></div>
    </div>` : ''}
    ${tb ? `<div class="panel" id="earnJobTaxBenefitPanel">
      <div class="section-head"><h3>Tax benefit</h3></div>
      <table><tbody>
        <tr><td>Per pay period</td><td>${money2(tb.perPeriod)}</td><td>Annual</td><td>${money2(tb.annual)}</td></tr>
      </tbody></table>
      ${tb.byYear && tb.byYear.length ? `<table><tbody>
        ${tb.byYear.map((y) => `<tr><td>${y.year}</td><td>${money2(y.annual)}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${tb.paysByYear && tb.paysByYear.length ? `<div id="earnJobTaxBenefitPaysWrap">${earnJobTaxBenefitPaysHtml(tb)}</div>` : ''}
      <div class="note">Tax saved by the RRSP deduction — realized at the T1, at the current pay rate and plans; yearly rows cover months elapsed.${tb.paysByYear && tb.paysByYear.length ? ` The table lists the selected year's paydays with a saving (only paydays with a saving are listed); its total is that year's figure.` : ''} Per-period = annual ÷ ${tbPeriods}, rounded.</div>
    </div>` : ''}`;
}

let earnJobMonthlyChart = null;

// Monthly pay composition on the job detail page: one stacked bar
// per month, bar height = that month's total gross, segments Tax,
// CPP/EI, RRSP (own only, when a linked plan exists) and Net. The
// legend is display-only: a click must never toggle a segment off,
// or the stack would stop summing to the gross. The tooltip footer
// repeats the month's total gross — the bar top IS the total, so
// there is no separate total line.
async function drawEarnJobMonthlyChart(id) {
  const panel = $('#earnJobMonthlyPanel');
  if (!panel) return;
  try {
    const s = await api(`/api/earnings/jobs/${id}/monthly-chart`);
    if (currentEarnJobId !== id) return;
    if (earnJobMonthlyChart) { earnJobMonthlyChart.destroy(); earnJobMonthlyChart = null; window.__fmCharts.earnJobMonthly = null; }
    if (!s || !s.months || !s.months.length) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const datasets = [
      { key: 'tax', label: 'Tax', data: s.tax, backgroundColor: '#b3543f', borderColor: '#b3543f', borderWidth: 1, stack: 'pay' },
      { key: 'cppEi', label: 'CPP/EI', data: s.cppEi, backgroundColor: '#8d6e00', borderColor: '#8d6e00', borderWidth: 1, stack: 'pay' },
    ];
    if (s.rrsp) datasets.push({ key: 'rrsp', label: 'RRSP contribution', data: s.rrsp, backgroundColor: '#283593', borderColor: '#283593', borderWidth: 1, stack: 'pay' });
    datasets.push({ key: 'net', label: 'Net', data: s.net, backgroundColor: '#2e7d4f', borderColor: '#2e7d4f', borderWidth: 1, stack: 'pay' });
    earnJobMonthlyChart = new Chart($('#earnJobMonthlyChart'), {
      type: 'bar',
      data: { labels: s.months.map(formatYM), datasets },
      options: {
        responsive: true,
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => '$' + Number(v).toLocaleString() } } },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12 }, onClick: () => {} },
          tooltip: { callbacks: { footer: (items) => `Total gross ${money2(items.reduce((a, it) => a + (Number(it.parsed.y) || 0), 0))}` } },
        },
      },
    });
    window.__fmCharts.earnJobMonthly = earnJobMonthlyChart;
  } catch { panel.classList.add('hidden'); }
}

async function loadEarnJobDetail(id) {
  try {
    await loadEarnings();
    const j = earnData.jobs.find((x) => x.id === id);
    if (!j) { location.hash = '#earnings/salary'; return; }
    currentEarnJobId = id;
    earnJobTaxBenefitPaysYearSel = null;
    $('#earnJobDetail').innerHTML = earnJobDetailHtml(j);
    drawEarnJobMonthlyChart(id);
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
  $('#earnJobRowValueLabel').textContent = 'Amount *';
  const f = $('#earnJobRowForm');
  f.reset();
  const payOpts = $('#earnJobRowPayOpts');
  if (payOpts) payOpts.style.display = kind === 'pay_change' ? '' : 'none';
  if (row) {
    f.row_date.value = kind === 'pay_change' ? row.effective_date : row.date;
    setMoneyValue(f.row_value, kind === 'pay_change' ? (row.amount ?? row.value) : row.amount);
    if (kind === 'pay_change') {
      const basisRadio = f.querySelector(`[name=row_basis][value=${row.basis || 'gross'}]`);
      if (basisRadio) basisRadio.checked = true;
      if (f.row_scope) f.row_scope.value = row.scope || 'period';
    }
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
    const payChanges = (j.pay_changes || []).map((r) => ({ effective_date: r.effective_date, amount: r.amount ?? r.value, basis: r.basis || 'gross', scope: r.scope || 'period' }));
    const bonuses = (j.bonuses || []).map((b) => ({ date: b.date, amount: b.amount }));
    // Position rule (server-side): the latest-dated entry sets the
    // rate, so the client sends the current rate and lets the server
    // pin it — a backfilled older entry never moves the position.
    const recentValue = earnJobPerPeriod(j);
    if (kind === 'pay_change') {
      const basis = f.querySelector('[name=row_basis]:checked')?.value || 'gross';
      const scope = f.row_scope ? f.row_scope.value : 'period';
      const entry = { effective_date: date, amount: value, basis, scope };
      if (index == null) payChanges.push(entry);
      else payChanges[index] = entry;
      payChanges.sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1));
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
    const payChanges = (j.pay_changes || []).map((r) => ({ effective_date: r.effective_date, amount: r.amount ?? r.value, basis: r.basis || 'gross', scope: r.scope || 'period' }));
    const bonuses = (j.bonuses || []).map((b) => ({ date: b.date, amount: b.amount }));
    if (kind === 'pay_change') payChanges.splice(index, 1);
    else bonuses.splice(index, 1);
    // Position rule (server-side): deleting the latest falls back to
    // the previous entry; with none left the opening position stands.
    const recentValue = kind === 'pay_change' && payChanges.length === 0
      ? (j.opening_value ?? earnJobPerPeriod(j)) : earnJobPerPeriod(j);
    await earnJobDetailPut(j, payChanges, bonuses, recentValue);
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
    earnRefreshRentalView(earnEditRentalId);
  } catch (err) { showMsg($('#earnRentalModalMsg'), 'err', err.message); }
};
window.earnEditRental = (id) => {
  const r = earnData.rentals.find((x) => x.id === id);
  if (!r) return;
  earnEditRentalId = id;
  $('#earnRentalFormTitle').textContent = 'Edit rental';
  const f = $('#earnRentalForm');
  f.label.value = r.label; f.property_id.value = r.property_id ?? ''; f.address.value = r.address || '';
  f.rental_type.value = r.rental_type; f.services_level.value = r.services_level;
  f.rental_portion_pct.value = r.rental_portion_pct ?? '';
  f.is_principal_residence.checked = r.is_principal_residence; f.was_principal_residence.checked = r.was_principal_residence;
  f.structural_change.checked = r.structural_change;
  syncEarnRentalAddressState();
  showMsg($('#earnRentalModalMsg'), '', '');
  openModal('earnRentalModal');
};
window.earnDeleteRental = async (id) => {
  if (!confirm('Delete this rental and all its year records?')) return;
  try {
    await api(`/api/earnings/rentals/${id}`, { method: 'DELETE' });
  } catch (err) {
    // Like the job delete: a failure must surface instead of failing
    // silently — in the detail message when the detail page is open.
    const detailVisible = !$('#earnRentalDetail').classList.contains('hidden');
    const m = detailVisible ? $('#earnRentalDetailMsg') : $('#earnRentalMsg');
    if (m) showMsg(m, 'err', err.message);
    return;
  }
  await loadEarnings();
  if (location.hash.startsWith('#earnings/rental/')) location.hash = '#earnings/rentals';
};

// After a rental/year/entry save or delete, the detail page (when
// open on that rental) refreshes itself; otherwise the list reloads.
function earnRefreshRentalView(rentalId) {
  if (location.hash === `#earnings/rental/${rentalId}`) loadEarnRentalDetail(rentalId);
  else loadEarnings();
}

// ----------------------------------------------------- rental detail --
// A rental card opens its own detail page (job detail pattern). The
// list cards carry no action buttons at all — only the eye — and the
// rental itself is edited and deleted from Edit/Delete in the detail
// panel header by the title, reusing the card handlers. The summary
// strip shows the latest year record's calc;
// with no year records it shows entry-derived facts only, never an
// invented figure, and there is no chart panel.
let currentEarnRentalId = null;
let earnRentalDetailChart = null;

function earnRentalLatestYear(r) {
  const years = [...(r.years || [])].sort((a, b) => a.tax_year - b.tax_year);
  return years.length ? years[years.length - 1] : null;
}

// One shared year state for the rental detail page: the header
// dropdown, the deductible section's select and the year records
// selector all set/read the same year and stay in sync. Null means
// "latest year" — the default when first opening a rental.
let earnRentalYearSel = null;
function earnRentalSelectedYear(r) {
  const latest = earnRentalLatestYear(r);
  if (!latest) return null;
  if (earnRentalYearSel != null && (r.years || []).some((y) => y.tax_year === earnRentalYearSel)) return earnRentalYearSel;
  return latest.tax_year;
}
function earnRentalYearSelectHtml(r, id) {
  const years = [...(r.years || [])].sort((a, b) => a.tax_year - b.tax_year);
  if (years.length < 2) return '';
  const sel = earnRentalSelectedYear(r);
  return `<select id="${id}" aria-label="Year" onchange="earnRentalSetYear(Number(this.value))">${years.map((y) => `<option value="${y.tax_year}"${y.tax_year === sel ? ' selected' : ''}>${y.tax_year}</option>`).join('')}</select>`;
}
window.earnRentalSetYear = (year) => {
  earnRentalYearSel = Number(year);
  const r = earnData.rentals.find((x) => x.id === currentEarnRentalId);
  const wrap = document.querySelector('#earnRentalDetail');
  if (r && wrap) {
    wrap.innerHTML = earnRentalDetailHtml(r);
    drawEarnRentalDetailChart(r);
  }
};

function earnRentalDetailSummaryHtml(r) {
  const selYear = earnRentalSelectedYear(r);
  const y = (r.years || []).find((v) => v.tax_year === selYear);
  if (y && y.calc) {
    const c = y.calc;
    return `<div class="summary-strip">
      <div class="summary-card"><div class="k">Gross rents</div><div class="v">${money2(c.grossWhole)}</div></div>
      <div class="summary-card"><div class="k">Deductible expenses</div><div class="v">${money2(c.deductibleExpenses)}</div></div>
      <div class="summary-card"><div class="k">Net, whole property (9946)</div><div class="v">${money2(c.netWhole9946)}</div></div>
      <div class="summary-card"><div class="k">Owner share</div><div class="v">${money2(c.ownerShareNet)}</div></div>
    </div>`;
  }
  // No year records: entry facts only. Latest entry = latest start
  // month; coverage spans the earliest start to the latest end.
  const entries = [...(r.entries || [])].sort((a, b) => (a.start_ym || '').localeCompare(b.start_ym || ''));
  const latest = entries.length ? entries[entries.length - 1] : null;
  const end = latest && latest.end_ym ? ymLabel(latest.end_ym) : 'Ongoing';
  return `<div class="summary-strip">
    <div class="summary-card"><div class="k">Monthly rent</div><div class="v">${latest ? money2(latest.monthly_rent) : '—'}</div></div>
    <div class="summary-card"><div class="k">Rent entries</div><div class="v">${entries.length}</div></div>
    <div class="summary-card"><div class="k">Coverage</div><div class="v">${entries.length ? `${ymLabel(entries[0].start_ym)} – ${end}` : '—'}</div></div>
    <div class="summary-card"><div class="k">Owned</div><div class="v">${r.ownership_pct}%</div></div>
  </div>`;
}

// Deductible expenses, item by item, in the Property costs panel
// shape: a panel-head with the selected year's deductible total at
// the top-right, a compact year select in a toolbar row, then the
// costs-table with a shaded tfoot Sum row. No charts — just the
// table. The year follows the shared detail-page state (the header
// dropdown sets it); a year with no derived items falls back to the
// latest derived year. Each row shows the Total (the item's amount
// for the rented period), the Tenant % (the rental portion), and
// the Deductible = Total x portion; rows the portion does not scale
// show '—' for the %.
function earnRentalExpenseTableHtml(r) {
  const years = [...(r.years || [])]
    .filter((y) => y.calc && y.calc.expenseTable && y.calc.expenseTable.hasDerived)
    .sort((a, b) => a.tax_year - b.tax_year);
  if (!years.length) return '';
  const shared = earnRentalSelectedYear(r);
  const year = years.some((y) => y.tax_year === shared) ? shared : years[years.length - 1].tax_year;
  const y = years.find((v) => v.tax_year === year);
  const sel = years.length > 1
    ? `<select id="earnRentalExpenseYearSel" aria-label="Year" onchange="earnRentalSetYear(Number(this.value))">${years.map((v) => `<option value="${v.tax_year}"${v.tax_year === year ? ' selected' : ''}>${v.tax_year}</option>`).join('')}</select>`
    : '';
  const rows = y.calc.expenseTable.rows.map((row) => `<tr><td>${esc(row.label)}</td><td class="num">${money2(row.total)}</td><td class="num">${row.pct == null ? '—' : `${row.pct}%`}</td><td class="num">${money2(row.deductible)}</td></tr>`).join('');
  return `<div class="panel"><div class="panel-head"><h3>Deductible expenses</h3><div class="spacer"></div><span class="note" style="margin:0">${year} total: ${money2(y.calc.expenseTable.sum)}</span></div>
    ${sel ? `<div class="toolbar" style="margin:0 0 8px">${sel}</div>` : ''}
    <div class="cost-year-head"><span>${year}</span></div>
    <table class="costs-table" id="earnRentalExpenseTable"><thead><tr><th>Item</th><th class="num">Total</th><th class="num">Tenant %</th><th class="num">Deductible</th></tr></thead><tbody>
        ${rows}
      </tbody><tfoot><tr class="cost-year-total"><td>Sum</td><td class="num">${money2(y.calc.expenseTable.totalSum)}</td><td class="num"></td><td class="num">${money2(y.calc.expenseTable.sum)}</td></tr></tfoot></table></div>`;
}

function earnRentalDetailHtml(r) {
  const years = [...(r.years || [])].sort((a, b) => a.tax_year - b.tax_year);
  const selYearRec = years.find((v) => v.tax_year === earnRentalSelectedYear(r));
  return `<div class="toolbar"><a id="earnRentalBackLink" href="#earnings/rentals">← Back to Rentals</a><div class="spacer"></div></div>
    <div class="msg" id="earnRentalDetailMsg"></div>
    <div class="panel" id="earnRentalDetailHeadPanel">
      <div class="section-head"><h3>${esc(r.label)}</h3><span class="meta-tag">${esc(r.rental_type)}</span><span class="meta-tag">${esc(r.services_level)}</span>${earnRentalYearSelectHtml(r, 'earnRentalYearSel')}<div class="spacer"></div><button class="small" id="earnRentalDetailEditBtn" onclick="earnEditRental(${r.id})">Edit</button><button class="small danger" id="earnRentalDetailDeleteBtn" onclick="earnDeleteRental(${r.id})">Delete</button></div>
      ${r.address ? `<div class="note">${esc(r.address)}</div>` : ''}
      ${earnRentalDetailSummaryHtml(r)}
    </div>
    <div class="panel" id="earnRentalEntriesPanel">
      <div class="section-head"><h3>Rent entries</h3><div class="spacer"></div><button class="small" id="earnRentalDetailAddEntry" onclick="earnAddEntry(${r.id})">+ Rent entry</button></div>
      ${earnEntryTableHtml(r)}
    </div>
    <div class="panel" id="earnRentalDetailChartPanel">
      <div class="section-head"><h3>Annual income</h3></div>
      <div><canvas id="earnRentalDetailChart"></canvas></div>
    </div>
    <div class="panel" id="earnRentalYearRecordsPanel">
      <div class="section-head"><h3>Year records</h3><div class="spacer"></div>${earnRentalYearSelectHtml(r, 'earnRentalYearRecordsSel')}</div>
      ${selYearRec ? earnYearBlock(r, selYearRec) : '<div class="note">No year records yet.</div>'}
    </div>
    <div id="earnRentalExpenseWrap">${earnRentalExpenseTableHtml(r)}</div>`;
}

function drawEarnRentalDetailChart(r) {
  const panel = $('#earnRentalDetailChartPanel');
  if (!panel) return;
  if (earnRentalDetailChart) { earnRentalDetailChart.destroy(); earnRentalDetailChart = null; window.__fmCharts.earnRentalDetail = null; }
  const years = [...(r.years || [])].filter((y) => y.calc).sort((a, b) => a.tax_year - b.tax_year);
  if (!years.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  earnRentalDetailChart = new Chart($('#earnRentalDetailChart'), {
    type: 'bar',
    data: {
      labels: years.map((y) => String(y.tax_year)),
      datasets: [
        { label: 'Gross rents', data: years.map((y) => y.calc.grossWhole), backgroundColor: '#1668c4', borderColor: '#1668c4', borderWidth: 1 },
        { label: 'Net (9946)', data: years.map((y) => y.calc.netWhole9946), backgroundColor: '#2e7d4f', borderColor: '#2e7d4f', borderWidth: 1 },
      ],
    },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => '$' + Number(v).toLocaleString() } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
    },
  });
  window.__fmCharts.earnRentalDetail = earnRentalDetailChart;
}

async function loadEarnRentalDetail(id) {
  try {
    await loadEarnings();
    const r = earnData.rentals.find((x) => x.id === id);
    if (!r) { location.hash = '#earnings/rentals'; return; }
    // A fresh rental defaults to its latest year; re-renders of the
    // same rental (after an edit) keep the year the user is on.
    if (currentEarnRentalId !== id) earnRentalYearSel = null;
    currentEarnRentalId = id;
    $('#earnRentalDetail').innerHTML = earnRentalDetailHtml(r);
    drawEarnRentalDetailChart(r);
  } catch (e) {
    const m = $('#earnRentalDetailMsg');
    if (m) showMsg(m, 'err', e.message);
  }
}

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
    earnRefreshRentalView(earnYearRentalId);
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
  // When the rental carries a portion, it governs the year: the
  // share field shows the portion and is read-only (not disabled —
  // a disabled control is omitted from FormData and the server would
  // fall back to 100). No portion: the field stays editable as today.
  if (r.rental_portion_pct != null) {
    f.area_share_pct.value = r.rental_portion_pct;
    f.area_share_pct.readOnly = true;
  } else {
    f.area_share_pct.readOnly = false;
    f.area_share_pct.value = y.area_share_pct;
  }
  $('#earnYearDerived').innerHTML = `Gross rents ${money2(y.gross_rents)} · Rented days ${y.rental_days}${y.rent_derived ? ' (from rent entries)' : ''}${r.rental_portion_pct != null ? ` · Rental portion ${r.rental_portion_pct}%` : ''}`;
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
  earnRefreshRentalView(rentalId);
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
    earnRefreshRentalView(earnEntryRentalId);
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
  earnRefreshRentalView(rentalId);
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
  if (!st.months && !st.custom && !st.ytd && txMonths.length) {
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
  // The detail chart stacks each month's bar by category, exactly
  // like the overall page's By-category stacking (same segment
  // colors as the detail Category-share doughnut, since both read
  // the same shareRows, and a total line summing the stack values
  // themselves). No By-card toggle on detail — one card only, so
  // it is always stacked by category. Computed client-side from
  // the card's transactions, like the overall chart; no new API.
  if (!histEmpty && isDetail) {
    const monthIdx = new Map(months.map((m, i) => [m.month, i]));
    const byKey = new Map(shareRows.map((s) => [s.key, months.map(() => 0)]));
    for (const t of tx) {
      if (t.kind === 'adjustment' || !(Number(t.amount) < 0)) continue;
      const mi = monthIdx.get(String(t.date).slice(0, 7));
      if (mi === undefined) continue;
      const key = (t.category || '').trim() || 'Uncategorized';
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
  const infoParts = [];
  if (data.card.credit_limit != null) infoParts.push(`Credit limit ${money2(data.card.credit_limit)}`);
  if (data.card.balance_owed != null) infoParts.push(`Balance owed <span class="spend-balance-figure">${money2(data.card.balance_owed)}</span>${data.card.balance_asof ? ` <span class="spend-balance-asof">· as of ${esc(data.card.balance_asof)}</span>` : ''}`);
  $('#spendDetailCardInfo').innerHTML = infoParts.length ? `<div class="note spend-detail-info">${infoParts.join(' · ')}</div>` : '';
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
// category into a card grid; clicking a card opens a second modal
// with that group's transactions, and each row's category is
// editable before Apply. A row edited in preview changes ONLY
// that row on Apply — the merchant mapping still takes the group's
// proposed category. Edits are held in the detail modal's tables
// and nothing writes until the main modal's Apply.
// One inline SVG per preset category (a custom category gets the
// generic tag); colors reuse the Spending doughnut palette
// (INVEST_ACCOUNT_COLORS, in preset order), custom gray — the
// doughnut's own colors are never changed.
const SPEND_AI_ICONS = (() => {
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return {
    Groceries: svg('<path d="M3 8h18M5 8l2 12h10l2-12M9 8l1-4h4l1 4"/>'),
    Dining: svg('<path d="M4 17h16M5 17a7 7 0 0 1 14 0M12 10V8M9 8h6"/>'),
    Transport: svg('<path d="M3 13l1.5-4.5A2 2 0 0 1 6.4 7h9.2a2 2 0 0 1 1.9 1.5L19 13v3h-2.5M3 16h2.5"/><circle cx="7" cy="16" r="1.6"/><circle cx="17" cy="16" r="1.6"/>'),
    Housing: svg('<path d="M4 11L12 4l8 7M6 10v10h12V10M10 20v-6h4v6"/>'),
    Utilities: svg('<path d="M13 2L5 14h6l-1 8 8-12h-6l1-8z"/>'),
    Health: svg('<path d="M12 20s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z"/>'),
    Entertainment: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M10 10l5 3-5 3z"/>'),
    Shopping: svg('<path d="M6 8h12l-1 13H7L6 8zM9 8a3 3 0 0 1 6 0"/>'),
    Travel: svg('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>'),
    Education: svg('<path d="M12 5C10 3.5 7 3 4 3v16c3 0 6 .5 8 2 2-1.5 5-2 8-2V3c-3 0-6 .5-8 2zM12 5v16"/>'),
    'Fees & interest': svg('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
    Other: svg('<path d="M3 12V4h8l8 8-8 8-8-8z"/><circle cx="8" cy="9" r="1.5"/>'),
  };
})();
$('#spendAiAnalyzeBtn').addEventListener('click', async () => {
  const msg = $('#spendAiMsg');
  const host = $('#spendAiProposals');
  const detailHost = $('#spendAiDetailRows');
  msg.className = 'msg';
  msg.textContent = '';
  host.innerHTML = '';
  detailHost.innerHTML = '';
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
    const aiColorFor = (cat) => {
      // Presets keep their palette slot in preset order; anything
      // else (a custom category) is neutral gray, never a palette
      // color — spendPresetCategories is the static preset list
      // captured before used customs are appended to the datalist.
      const presets = spendPresetCategories || cats.slice(0, 12);
      const i = presets.indexOf(cat);
      return i >= 0 ? INVEST_ACCOUNT_COLORS[i % INVEST_ACCOUNT_COLORS.length] : '#71808f';
    };
    const aiTxCount = (g) => g.merchants.reduce((n, m) => n + m.txCount, 0);
    const aiSourceTag = (g) => [...new Set(g.merchants.map((m) => m.source))]
      .map((s) => (s === 'remembered' ? 'remembered' : 'AI')).join(' + ');
    host.innerHTML = `<div class="spend-ai-grid">${[...groups.values()].map((g, gi) => `
      <div class="spend-ai-card" data-ai-group="${gi}" style="--ai-color: ${aiColorFor(g.category)}">
        <input type="checkbox" data-ai-group-check="${gi}" checked>
        <span class="ai-icon">${SPEND_AI_ICONS[g.category] || SPEND_AI_ICONS.Other}</span>
        <span class="ai-text"><span class="ai-name">${esc(g.category)}</span>
        <span class="ai-meta">${aiTxCount(g)} transactions · ${g.merchants.length} merchants</span>
        <span class="badge">${esc(aiSourceTag(g))}</span></span>
      </div>`).join('')}</div>`
      + `<div class="toolbar"><button class="primary" id="spendAiApplyBtn">Apply categories</button></div>`;
    // Detail modal: one hidden row table per group, built once so
    // edits survive closing and reopening the detail modal. Apply
    // below reads these tables, so nothing writes before Apply.
    detailHost.innerHTML = [...groups.values()].map((g, gi) => `
      <div class="hidden" data-ai-detail-group="${gi}">
        <table class="tbl"><thead><tr><th>Date</th><th>Merchant</th><th>Card</th><th>Amount</th><th>Category</th></tr></thead><tbody>
        ${g.merchants.map((m) => (m.transactions || []).map((t) => rowHtml(t, g.category)).join('')).join('')}
        </tbody></table>
      </div>`).join('');
    host.querySelectorAll('[data-ai-group]').forEach((card) => {
      card.addEventListener('click', (e) => {
        // The group checkbox toggles inclusion; it must not open
        // the detail modal.
        if (e.target.closest('[data-ai-group-check]')) return;
        const gi = Number(card.dataset.aiGroup);
        const g = [...groups.values()][gi];
        if (!g) return;
        $('#spendAiDetailTitle').textContent = `${g.category} · ${aiTxCount(g)} transactions`;
        detailHost.querySelectorAll('[data-ai-detail-group]').forEach((d) => {
          d.classList.toggle('hidden', Number(d.dataset.aiDetailGroup) !== gi);
        });
        openModal('spendAiDetailModal');
      });
    });
    $('#spendAiApplyBtn').addEventListener('click', async () => {
      const proposals = [];
      const overrides = [];
      [...groups.values()].forEach((g, gi) => {
        if (!host.querySelector(`[data-ai-group-check="${gi}"]`).checked) return;
        for (const m of g.merchants) proposals.push({ merchant: m.merchant, category: g.category });
        const rowsEl = detailHost.querySelector(`[data-ai-detail-group="${gi}"]`);
        if (rowsEl) rowsEl.querySelectorAll('[data-ai-row-cat]').forEach((sel) => {
          if (sel.value !== g.category) overrides.push({ txId: Number(sel.dataset.aiRowCat), category: sel.value });
        });
      });
      try {
        const result = await api('/api/spending/ai-categories/apply', { method: 'POST', body: { proposals, overrides } });
        showMsg(msg, 'ok', `Applied ${result.mapped} merchant mappings, categorized ${result.updated} transactions. Mappings are remembered.`);
        host.innerHTML = '';
        detailHost.innerHTML = '';
        closeModalEl($('#spendAiModal'));
        closeModalEl($('#spendAiDetailModal'));
        reloadSpendView();
      } catch (err) { showMsg(msg, 'err', err.message); }
    });
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// Card detail ✨ Fill with AI: the header button expands the
// panel, which sits above the Spending-over-time panel; the
// panel itself proposes transaction rows from pasted
// text, and only Apply writes. The reveal is an in-flow grid-rows
// height animation (see style.css), so opening pushes the
// Spending-over-time and transactions panels down and closing leaves zero space.
$('#spendFillToggleBtn').addEventListener('click', () => {
  $('#spendFillPanel').classList.toggle('fill-open');
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

// -------------------------------------------------------------- planning ---
// Planning tab: projects → strategies → ops, with merge/revert/conflict
// flows. Same panels, section-head padding, summary strips and modals
// as the property/stock pages; no new visual language.
const planCharts = {};
function planDestroyChart(id) {
  if (planCharts[id]) { planCharts[id].destroy(); planCharts[id] = null; }
}
function planLineChart(id, labels, datasets, opts = {}) {
  planDestroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: { y: { ticks: { callback: (v) => moneyTick(v) } } },
    plugins: { tooltip: { callbacks: { label: (it) => ` ${it.dataset.label}: ${money2(it.parsed.y)}` } } },
  };
  // Fill-band datasets (the pool Difference chart's shaded diff)
  // carry `band: true` and must not appear in the tooltip or the
  // legend — the band is read visually, not as a series.
  if (opts.tooltipFilter) chartOpts.plugins.tooltip.filter = opts.tooltipFilter;
  if (opts.legendFilter) chartOpts.plugins.legend = { labels: { filter: opts.legendFilter } };
  // End-point labels reserve a right-hand label column; without
  // them the chart keeps its full width (no dead padding). The
  // labels travel as plugin options (available during the
  // constructor's first draw); $endLabels mirrors them for readers.
  if (opts.endLabels) {
    chartOpts.layout = { padding: { right: 135 } };
    chartOpts.plugins.planEndLabels = { labels: opts.endLabels };
  }
  planCharts[id] = new Chart(el, {
    type: 'line',
    data: { labels, datasets },
    options: chartOpts,
    ...(opts.endLabels ? { plugins: [planEndLabelsPlugin] } : {}),
  });
  if (opts.endLabels) planCharts[id].$endLabels = opts.endLabels;
  return planCharts[id];
}
// End-point labels for a line chart: each visible dataset's last
// plotted value, drawn just right of its last point (the chart
// reserves the right padding for the label column). Finals that land
// within a few dollars of each other on a $1M scale are staggered
// vertically (min 14px) with a short leader line back to the point,
// so two lines ending $5k apart stay readable instead of colliding.
const planEndLabelsPlugin = {
  id: 'planEndLabels',
  afterDatasetsDraw(chart) {
    const texts = (chart.options && chart.options.plugins && chart.options.plugins.planEndLabels && chart.options.plugins.planEndLabels.labels) || chart.$endLabels;
    if (!texts || !texts.length) return;
    const entries = [];
    chart.data.datasets.forEach((ds, i) => {
      const text = texts[i];
      if (!text) return;
      if (typeof chart.isDatasetVisible === 'function' && !chart.isDatasetVisible(i)) return;
      const pts = (chart.getDatasetMeta(i) || {}).data || [];
      let last = -1;
      for (let k = ds.data.length - 1; k >= 0; k--) { if (ds.data[k] != null) { last = k; break; } }
      if (last < 0 || !pts[last] || !Number.isFinite(pts[last].x) || !Number.isFinite(pts[last].y)) return;
      entries.push({ text, color: ds.borderColor || '#333', x: pts[last].x, py: pts[last].y, y: pts[last].y });
    });
    if (!entries.length) return;
    entries.sort((a, b) => a.y - b.y);
    const GAP = 14;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].y - entries[i - 1].y < GAP) entries[i].y = entries[i - 1].y + GAP;
    }
    // Keep the stack inside the chart area: if staggering pushed the
    // bottom label past it, shift the whole stack up.
    const bottom = chart.chartArea.bottom - 4;
    if (entries[entries.length - 1].y > bottom) {
      const over = entries[entries.length - 1].y - bottom;
      entries.forEach((e) => { e.y -= over; });
    }
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    entries.forEach((e) => {
      const lx = e.x + 8;
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(e.x + 2, e.py);
      ctx.lineTo(lx - 2, e.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = e.color;
      ctx.fillText(e.text, lx, e.y);
    });
    ctx.restore();
  },
};
function planBarChart(id, labels, datasets) {
  planDestroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  planCharts[id] = new Chart(el, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: (v) => moneyTick(v) }, stacked: true }, x: { stacked: true } },
      plugins: { tooltip: { callbacks: { label: (it) => ` ${it.dataset.label}: ${money2(it.parsed.y)}` } } },
    },
  });
  return planCharts[id];
}
function planGroupedBarChart(id, labels, datasets) {
  planDestroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  planCharts[id] = new Chart(el, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { ticks: { callback: (v) => moneyTick(v) } } },
      plugins: { tooltip: { callbacks: { label: (it) => ` ${it.dataset.label}: ${money2(it.parsed.y)}` } } },
    },
  });
  return planCharts[id];
}
const planReportDoughnutCenterPlugin = {
  id: 'planReportDoughnutCenter',
  afterDraw(chart) {
    // The center is per-chart (stored on the chart instance): the
    // strategy page hosts several doughnuts at once (baseline pool,
    // sink, funding viz), and a single shared global would leave
    // only the last-drawn one with a center.
    const center = chart.$doughnutCenter;
    if (!center) return;
    const area = chart.chartArea;
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const c = chart.ctx;
    c.save();
    c.textAlign = 'center';
    c.fillStyle = '#71808f';
    c.font = '11px system-ui, sans-serif';
    c.fillText(center.label, x, y - 4);
    c.fillStyle = '#22303c';
    c.font = '700 14px system-ui, sans-serif';
    c.fillText(money2(center.total), x, y + 14);
    c.restore();
  },
};
function planDoughnutChart(id, labels, data, centerLabel, centerTotal) {
  planDestroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  planCharts[id] = new Chart(el, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => planColor(i)), hoverOffset: 10 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (it) => ` ${it.label}: ${money2(it.parsed)}` } } },
    },
    plugins: [planReportDoughnutCenterPlugin],
  });
  planCharts[id].$doughnutCenter = { label: centerLabel, total: centerTotal };
  return planCharts[id];
}
const PLAN_COLORS = ['#20573a', '#2f7de1', '#c46a1b', '#7a3fa0', '#b03a3a', '#0f766e', '#8a6d00', '#3f3f46'];
const planColor = (i) => PLAN_COLORS[i % PLAN_COLORS.length];
// Light tint of a palette color for the principal leg of a stacked
// payment breakdown (interest stays solid).
const planColorAlpha = (hex, a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const planMoney = (v) => (v == null ? '—' : money2(v));
const planSigned = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + money2(v));
let planListData = null;
let planProjectData = null;
let planStrategyData = null;

async function loadPlanning() {
  return withLoading(async () => {
    const data = await api('/api/planning/projects');
    planListData = data;
    $('#planList').classList.remove('hidden');
    $('#planProject').classList.add('hidden');
    planReportOutlineClear();
    $('#planStrategy').classList.add('hidden');
    $('#planScenario').classList.add('hidden');
    $('#planList').innerHTML = planListHtml(data.sections || []);
    document.querySelectorAll('[data-plan-project]').forEach((el) => {
      el.addEventListener('click', () => { location.hash = `#planning/project/${el.dataset.planProject}`; });
    });
    const addBtn = $('#planAddProjectBtn');
    if (addBtn) addBtn.addEventListener('click', () => openPlanCategoryFlow({ mode: 'create' }));
  });
}
// List page (user 2026-11-06): projects group into sections by
// category, and the PROJECT NAME is the card headline — "N strategies"
// is small meta text, never the headline. The entity identity renders
// as tag pills between the headline and the meta line (property name,
// or the pool's funding sources).
function planListHtml(sections) {
  const total = sections.reduce((n, s) => n + s.projects.length, 0);
  const body = total ? sections.map((s) => `
    <div class="section-head"><h3>${esc(s.label)} · ${s.projects.length}</h3></div>
    <div class="cards">${s.projects.map(planListCardHtml).join('')}</div>`).join('')
    : '<div class="panel"><div class="note">No projects yet.</div></div>';
  return `
    <div class="section-head"><h2>Planning</h2><div class="toolbar"><button class="primary" id="planAddProjectBtn">+ Add project</button></div></div>
    <div class="msg" id="planListMsg"></div>
    ${body}`;
}
function planListCardHtml(p) {
  const tags = (p.entityTags || []).map((t) => `<span class="meta-tag">${esc(t)}</span>`).join('');
  const metaParts = [
    `${p.strategies.length} strateg${p.strategies.length === 1 ? 'y' : 'ies'}`,
    p.question || '',
    p.categoryLabels ? [p.categoryLabels.category, p.categoryLabels.subcategory].filter((x) => x).join(' · ') : '',
  ];
  if (p.stale) metaParts.push('Stale baseline');
  return `
    <div class="card breakdown-card" data-plan-project="${p.id}" style="cursor:pointer">
      <div class="v">${esc(p.name)}</div>
      ${tags ? `<div class="plan-list-tags">${tags}</div>` : ''}
      <div class="n">${esc(metaParts.filter((x) => x).join(' · '))}</div>
    </div>`;
}
// CREATION FLOW: big category → data entity → project modal.
// The strategy is defined inside the project (user 2026-11-05) —
// there is no subcategory pick and no recommendation step here.
// "Create project" creates a baseline-only project; "+ Add strategy"
// on the project page is where strategies are defined.
let planCatFlow = null;
let planCatPickSeq = 0;
function openPlanCategoryFlow(opts) {
  planCatFlow = { mode: (opts && opts.mode) || 'create', project: (opts && opts.project) || null, category: null, entity: null, categories: null };
  showMsg($('#planCategoryMsg'), '', '');
  $('#planCategoryEntity').innerHTML = '';
  openModal('planCategoryModal');
  api('/api/planning/categories').then((r) => {
    planCatFlow.categories = r.categories || [];
    $('#planCategoryCards').innerHTML = planCatFlow.categories.map((c) =>
      `<div class="card breakdown-card" data-plan-cat="${c.key}" style="cursor:pointer"><div class="k">${esc(c.label)}</div></div>`).join('');
    document.querySelectorAll('#planCategoryCards [data-plan-cat]').forEach((el) => {
      el.addEventListener('click', () => planCatPickCategory(el.dataset.planCat));
    });
  }).catch((err) => showMsg($('#planCategoryMsg'), 'err', err.message));
}
async function planCatPickCategory(key) {
  const cat = (planCatFlow.categories || []).find((c) => c.key === key);
  if (!cat) return;
  planCatFlow.category = cat;
  // Selection mark, so Back from the project modal can show the
  // pickers with the previous pick still visibly selected.
  document.querySelectorAll('#planCategoryCards [data-plan-cat]').forEach((el) => el.classList.toggle('plan-selected', el.dataset.planCat === key));
  planCatFlow.entity = null;
  const host = $('#planCategoryEntity');
  const msg = $('#planCategoryMsg');
  showMsg(msg, '', '');
  // Every click clears the entity host first: a previous category's
  // picker (e.g. the property dropdown) must never survive a switch
  // to a category whose branch renders nothing of its own.
  host.innerHTML = '';
  const seq = ++planCatPickSeq;
  try {
    if (cat.entityType === 'property') {
      const pr = await api('/api/properties');
      if (seq !== planCatPickSeq) return;
      const list = pr.properties || pr || [];
      host.innerHTML = `<div><label>Property *</label><select id="planCatEntitySel"><option value="">Select a property</option>${list.map((x) => `<option value="${x.id}">${esc(x.address)}</option>`).join('')}</select></div>`;
      $('#planCatEntitySel').addEventListener('change', (e) => { if (e.target.value) planCatPickEntity({ type: 'property', propertyId: Number(e.target.value) }); });
    } else if (cat.entityType === 'investment') {
      const inv = await api('/api/investments');
      if (seq !== planCatPickSeq) return;
      const accounts = inv.accounts || [];
      // POOL BUILDER: the baseline's starting position is a user-defined
      // cash pool — whole accounts and/or individual stocks, each
      // contributing a percent OF THAT SOURCE or a CAD amount from it.
      // Contributions add up to the pool total; they never need to
      // sum to 100%. Picking an account covers its stocks (and picks
      // none of them directly), so one source is never counted twice.
      const acctRows = accounts.map((a) => ({
        id: a.account.id, name: (a.account || {}).name || '', value: (a.summary || {}).value || 0,
        holdings: (a.holdings || []).map((h) => ({ id: h.holding.id, symbol: h.holding.symbol || h.holding.label || '', value: (h.summary || {}).value || 0 })),
      }));
      // POOL BUILDER (visualized flow): funding is added one entry at
      // a time via "+ Add funding". Each entry picks a stock inside
      // an account, or external cash from outside the app. A stock
      // contributes a percent OF THAT STOCK or a CAD amount from it;
      // external funding is a CAD amount. The pool total is the sum
      // of the entries, and the visualization (share-doughnut + per-
      // source table, the report pattern) updates live on every
      // add/edit/remove. Whole-account picks are gone from this UI —
      // add the account's stocks instead; the server still accepts
      // account items from older projects unchanged.
      const holdValue = new Map(acctRows.flatMap((a) => a.holdings.map((h) => [String(h.id), h.value])));
      const holdLabel = new Map(acctRows.flatMap((a) => a.holdings.map((h) => [String(h.id), `${a.name} · ${h.symbol}`])));
      const sourceOptions = acctRows.map((a) =>
        `<optgroup label="${esc(a.name)}">${a.holdings.map((h) => `<option value="holding:${h.id}">${esc(h.symbol)} · ${money2(h.value)}</option>`).join('')}</optgroup>`).join('');
      const entryHtml = () => `
        <div class="plan-row" data-pool-entry>
          <select data-pool-entry-source style="flex:1">
            <option value="">Select a source…</option>
            ${sourceOptions}
            <option value="external">External funding (new cash)</option>
          </select>
          <select data-pool-entry-mode>
            <option value="percent">% of stock</option>
            <option value="amount">Amount (CAD)</option>
          </select>
          <input type="number" min="0" step="0.01" placeholder="%" data-pool-entry-input style="width:110px">
          <button type="button" class="small" data-pool-entry-remove title="Remove this funding">×</button>
        </div>`;
      host.innerHTML = `<div class="note">Build the cash pool one entry at a time — each entry is a stock inside an account, or external cash from outside the app. For a stock, give a percent of that stock or a CAD amount from it; external funding is a CAD amount. The pool total is the sum of the entries.</div>
        <div class="plan-pool-layout">
          <div class="plan-pool-left">
            <div id="planPoolEntries"></div>
            <div class="toolbar"><button class="small" id="planPoolAddBtn">+ Add funding</button></div>
          </div>
          <div class="plan-pool-right">
            <div id="planPoolViz">
              <div class="chart-wrap" style="height:220px"><canvas id="planPoolVizChart"></canvas></div>
              <table class="tbl"><thead><tr><th>Source</th><th>Amount</th><th>Share</th></tr></thead><tbody id="planPoolVizBody"></tbody></table>
            </div>
            <div class="note" id="planPoolTotal">Pool total: $0.00</div>
          </div>
        </div>
        <div class="toolbar"><button class="small primary" id="planCatEntityGo">Continue</button></div>`;
      const entryContribution = (row) => {
        const src = row.querySelector('[data-pool-entry-source]').value;
        if (!src) return { label: null, value: 0 };
        const mode = row.querySelector('[data-pool-entry-mode]').value;
        const v = Number(row.querySelector('[data-pool-entry-input]').value) || 0;
        if (src === 'external') return { label: 'External funding', value: mode === 'amount' ? v : 0 };
        const hid = src.slice('holding:'.length);
        if (mode === 'percent') return { label: holdLabel.get(hid) || hid, value: (holdValue.get(hid) || 0) * v / 100 };
        return { label: holdLabel.get(hid) || hid, value: v };
      };
      const updatePool = () => {
        const parts = [];
        host.querySelectorAll('[data-pool-entry]').forEach((row) => {
          const part = entryContribution(row);
          if (part.label) parts.push(part);
        });
        const total = parts.reduce((s, p) => s + p.value, 0);
        $('#planPoolTotal').textContent = `Pool total: ${money2(total)}`;
        const body = $('#planPoolVizBody');
        if (body) body.innerHTML = parts.map((p) => `<tr><td>${esc(p.label)}</td><td>${money2(p.value)}</td><td>${total ? `${((p.value / total) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')
          || '<tr><td colspan="3"><div class="note">No funding yet.</div></td></tr>';
        const viz = $('#planPoolViz');
        if (viz) viz.style.display = parts.length ? '' : 'none';
        if (parts.length) planDoughnutChart('planPoolVizChart', parts.map((p) => p.label), parts.map((p) => p.value), 'Pool total', total);
        else planDestroyChart('planPoolVizChart');
      };
      const syncEntry = (row) => {
        const src = row.querySelector('[data-pool-entry-source]').value;
        const modeSel = row.querySelector('[data-pool-entry-mode]');
        const inp = row.querySelector('[data-pool-entry-input]');
        if (src === 'external') {
          modeSel.value = 'amount';
          modeSel.disabled = true;
          inp.placeholder = '$';
          inp.removeAttribute('max');
        } else {
          modeSel.disabled = false;
          if (modeSel.value === 'percent') { inp.placeholder = '%'; inp.max = '100'; }
          else { inp.placeholder = '$'; inp.removeAttribute('max'); }
        }
        updatePool();
      };
      const addEntry = () => {
        const box = $('#planPoolEntries');
        box.insertAdjacentHTML('beforeend', entryHtml());
        const row = box.lastElementChild;
        row.querySelector('[data-pool-entry-source]').addEventListener('change', () => syncEntry(row));
        row.querySelector('[data-pool-entry-mode]').addEventListener('change', () => syncEntry(row));
        row.querySelector('[data-pool-entry-input]').addEventListener('input', updatePool);
        row.querySelector('[data-pool-entry-remove]').addEventListener('click', () => { row.remove(); updatePool(); });
        updatePool();
      };
      $('#planPoolAddBtn').addEventListener('click', addEntry);
      addEntry();
      $('#planCatEntityGo').addEventListener('click', () => {
        const rows = [...host.querySelectorAll('[data-pool-entry]')];
        const items = [];
        for (const row of rows) {
          const src = row.querySelector('[data-pool-entry-source]').value;
          if (!src) { showMsg(msg, 'err', 'Each funding entry needs a source — pick a stock or external funding, or remove the entry'); return; }
          const mode = row.querySelector('[data-pool-entry-mode]').value;
          const v = Number(row.querySelector('[data-pool-entry-input]').value) || 0;
          if (!(v > 0)) { showMsg(msg, 'err', 'Each funding entry needs a value above 0'); return; }
          if (src === 'external') items.push({ source: 'external', amount: v });
          else if (mode === 'percent') {
            if (v > 100) { showMsg(msg, 'err', 'A percent cannot exceed 100% of its source'); return; }
            items.push({ holdingId: Number(src.slice('holding:'.length)), percent: v });
          } else items.push({ holdingId: Number(src.slice('holding:'.length)), amount: v });
        }
        if (!items.length) { showMsg(msg, 'err', 'Add at least one funding entry for the pool'); return; }
        const seen = new Set();
        for (const it of items) {
          if (it.holdingId != null) {
            if (seen.has(it.holdingId)) { showMsg(msg, 'err', 'Each stock can only be picked once'); return; }
            seen.add(it.holdingId);
          }
        }
        planCatPickEntity({ type: 'pool', items });
      });
    } else if (cat.entityType === 'earning') {
      const er = await api('/api/earnings');
      if (seq !== planCatPickSeq) return;
      const jobs = er.jobs || [];
      const rentals = er.rentals || [];
      host.innerHTML = `<div><label>Job or rental *</label><select id="planCatEntitySel"><option value="">Select</option>${jobs.map((j) => `<option value="job:${j.id}">${esc(j.employer)} · Job</option>`).join('')}${rentals.map((r) => `<option value="rental:${r.id}">${esc(r.label)} · Rental</option>`).join('')}</select></div>`;
      $('#planCatEntitySel').addEventListener('change', (e) => {
        const v = e.target.value;
        if (!v) return;
        const [kind, id] = v.split(':');
        planCatPickEntity(kind === 'job' ? { type: 'job', jobId: Number(id) } : { type: 'rental', rentalId: Number(id) });
      });
    } else if (cat.entityType === 'spending' || (cat.entityType === 'scope' && cat.key === 'saving')) {
      host.innerHTML = `<div class="note">Scope: all spending cards.</div><div class="toolbar"><button class="small primary" id="planCatEntityGo">Continue</button></div>`;
      $('#planCatEntityGo').addEventListener('click', () => planCatPickEntity({ type: 'all-spending' }));
    } else if (cat.entityType === 'earnings' || (cat.entityType === 'scope' && cat.key === 'tax_saving')) {
      host.innerHTML = `<div class="note">Scope: all earnings.</div><div class="toolbar"><button class="small primary" id="planCatEntityGo">Continue</button></div>`;
      $('#planCatEntityGo').addEventListener('click', () => planCatPickEntity({ type: 'all-earnings' }));
    }
  } catch (err) { if (seq === planCatPickSeq) showMsg(msg, 'err', err.message); }
}
// Entity picked: straight to the project modal. There is no
// subcategory step anymore (user 2026-11-05) — Create project
// creates baseline-only, and the strategy is defined on the
// project page.
function planCatPickEntity(entity) {
  planCatFlow.entity = entity;
  closeModalEl($('#planCategoryModal'));
  openPlanProjectModal(null, { category: planCatFlow.category.key, entity: planCatFlow.entity });
}
function openPlanProjectModal(existing, catCtx) {
  const form = $('#planProjectForm');
  form.reset();
  $('#planProjectModalTitle').textContent = existing ? 'Edit project' : 'Add project';
  $('#planProjectPropertyRow').classList.add('hidden');
  $('#planProjectAccountRow').classList.add('hidden');
  const catRow = $('#planProjectCategoryRow');
  const aiBtn = $('#planAiCreateBtn');
  catRow.classList.add('hidden');
  aiBtn.classList.add('hidden');
  // Back returns to the category/entity/scope pickers, which persist
  // in the DOM exactly as left — but only when this modal was reached
  // through the creation flow. Edit mode (and any direct open) has no
  // previous step, so Back stays hidden and Cancel/Close are the exits.
  $('#planProjectBackBtn').classList.add('hidden');
  form.dataset.projectId = existing ? existing.id : '';
  form.dataset.planCategory = '';
  form.dataset.planSubcategory = '';
  form.dataset.planEntity = '';
  form.dataset.planApply = '';
  form.dataset.planHasRec = '';
  form.dataset.planAiDesign = '';
  form.question.dataset.touched = '';
  if (existing) {
    form.name.value = existing.name;
    form.question.value = existing.question || '';
    $('#planProjectSaveBtn').textContent = 'Save';
  } else if (catCtx) {
    form.dataset.planCategory = catCtx.category;
    form.dataset.planSubcategory = '';
    form.dataset.planEntity = JSON.stringify(catCtx.entity || null);
    form.question.value = '';
    catRow.classList.remove('hidden');
    $('#planProjectCategoryNote').textContent = `${catCtx.category}`;
    aiBtn.classList.remove('hidden');
    if (planCatFlow && planCatFlow.category) $('#planProjectBackBtn').classList.remove('hidden');
    // Create project creates baseline-only (user 2026-11-05): no
    // recommendation is applied, and the strategy is defined on the
    // project page. planHasRec stays empty, so planApply never trips.
    form.dataset.planHasRec = '';
    $('#planProjectSaveBtn').textContent = 'Create project';
  }
  showMsg($('#planProjectModalMsg'), '', '');
  openModal('planProjectModal');
}
$('#planProjectForm').question.addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
// Legacy Apply-recommendation hook: planHasRec is never set by the
// creation flow anymore (baseline-only, user 2026-11-05), so the
// flag never trips; the server path stays for API callers.
$('#planProjectSaveBtn').addEventListener('click', () => {
  const f = $('#planProjectForm');
  if (f.dataset.planCategory && f.dataset.planHasRec === '1') f.dataset.planApply = '1';
});
$('#planAiCreateBtn').addEventListener('click', openPlanAiCreateModal);
// Back: close the project modal and re-open the category modal.
// Nothing is reset — the pickers' DOM (category selection mark,
// entity picker values, pool-builder entries) persists exactly as
// left, so the user re-picks and comes forward again instead of
// Cancel-restarting the whole flow. A typed project name or edited
// Question is NOT preserved: coming forward re-runs
// openPlanProjectModal, which resets the form.
$('#planProjectBackBtn').addEventListener('click', () => {
  if (!planCatFlow || !planCatFlow.category) return;
  closeModalEl($('#planProjectModal'));
  openModal('planCategoryModal');
});
$('#planProjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#planProjectModalMsg');
  const id = form.dataset.projectId;
  try {
    const body = { name: form.name.value.trim(), question: form.question.value.trim() || null };
    if (!id && form.dataset.planCategory) {
      body.category = form.dataset.planCategory;
      body.subcategory = form.dataset.planSubcategory;
      body.entity = JSON.parse(form.dataset.planEntity || 'null');
      if (form.dataset.planApply === '1') body.applyRecommendation = true;
    }
    const data = id ? await api(`/api/planning/projects/${id}`, { method: 'PUT', body })
      : await api('/api/planning/projects', { method: 'POST', body });
    const newId = (data.project || {}).id || id;
    closeModalEl($('#planProjectModal'));
    location.hash = `#planning/project/${newId}`;
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// PURE-AI PROJECT CREATION: entry sits in the project modal's
// category toolbar, so it only appears in the creation flow AFTER
// the category / entity / scope pickers (planCatFlow carries the
// validated pick). One need → propose → preview → Apply; nothing
// writes before Apply. Preview edits: names + baseline description
// inputs, per-op params JSON textareas, per-op Remove. Full op-form
// editing lives on the strategy page after creation — the preview
// edits the drafted list, it does not rebuild the op form.
let planAiCreateCtx = null;
let planAiCreateQueue = [];
let planAiCreateProposal = null;
let planAiCreateAnswers = null;
let planAiCreateHistoryText = '';
function openPlanAiCreateModal() {
  const f = planCatFlow;
  if (!f || !f.category || !f.entity) return;
  planAiCreateCtx = { category: f.category.key, subcategory: null, entity: f.entity };
  planAiCreateProposal = null;
  planAiCreateAnswers = null;
  planAiCreateHistoryText = '';
  planAiCreateQueue = [];
  $('#planAiCreateCtx').textContent = `${f.category.label}`;
  $('#planAiCreateText').value = '';
  $('#planAiCreateQueue').innerHTML = '';
  $('#planAiCreateAsk').innerHTML = '';
  $('#planAiCreatePreview').innerHTML = '';
  $('#planAiCreateApplyBar').classList.add('hidden');
  showMsg($('#planAiCreateMsg'), '', '');
  closeModalEl($('#planProjectModal'));
  openModal('planAiCreateModal');
}
function planAiCreateRenderQueue() {
  const host = $('#planAiCreateQueue');
  if (!host) return;
  host.innerHTML = planAiCreateQueue.map((f, i) => `<span class="chip">${esc(f.name)} <button type="button" class="small" data-plan-ai-create-queue-remove="${i}">×</button></span>`).join('');
}
async function planAiCreateSerializeQueue() {
  return Promise.all(planAiCreateQueue.map((f) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: f.name, type: f.type, data: String(reader.result).split(',')[1] || '' });
    reader.onerror = reject;
    reader.readAsDataURL(f);
  })));
}
function planAiCreateRenderPreview() {
  const r = planAiCreateProposal;
  const host = $('#planAiCreatePreview');
  if (!r || !r.proposal) { host.innerHTML = ''; $('#planAiCreateApplyBar').classList.add('hidden'); return; }
  const p = r.proposal;
  const warns = [];
  if (r.unresolved && r.unresolved.length) warns.push(`Could not resolve: ${r.unresolved.map((u) => u.reason).join('; ')}`);
  const w = r.warnings || {};
  for (const k of ['shape', 'scenario', 'baseline', 'ops']) if (w[k] && w[k].length) warns.push(`${k}: ${w[k].join('; ')}`);
  const ops = p.strategy.ops || [];
  host.innerHTML = `${warns.length ? `<div class="msg warn">${esc(warns.join(' | '))}</div>` : ''}
    <div><label>Project name *</label><input id="planAiCreateProjectName" value="${esc(p.project.name || '')}"></div>
    <div><label>Scenario name *</label><input id="planAiCreateScenarioName" value="${esc(p.scenario.name || '')}"></div>
    <div class="n">Scenario factors: ${esc(JSON.stringify(p.scenario.factors || {}))}</div>
    <div><label>Baseline name *</label><input id="planAiCreateBaselineName" value="${esc(p.baseline.name || '')}"></div>
    <div><label>Baseline description</label><input id="planAiCreateBaselineDesc" value="${esc(p.baseline.description || '')}"></div>
    <div><label>Strategy name *</label><input id="planAiCreateStrategyName" value="${esc(p.strategy.name || '')}"></div>
    <div><label>Operations</label>${ops.length ? ops.map((o, i) => `<div class="plan-row" data-plan-ai-create-op="${i}"><span>${esc(o.op_type)}</span><textarea data-plan-ai-create-op-params rows="2" style="flex:1">${esc(JSON.stringify(o.params || {}))}</textarea><button type="button" class="small" data-plan-ai-create-op-remove="${i}">Remove</button></div>`).join('') : '<div class="note">No operations proposed.</div>'}</div>
    ${(r.unresolved && r.unresolved.length) ? `<div><label>Not included (unresolved)</label>${r.unresolved.map((u) => `<div class="plan-row"><span>${esc(u.op ? u.op.op_type : '')} · ${esc(u.reason)}</span></div>`).join('')}</div>` : ''}`;
  host.querySelectorAll('[data-plan-ai-create-op-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      planAiCreateProposal.proposal.strategy.ops.splice(Number(btn.dataset.planAiCreateOpRemove), 1);
      planAiCreateRenderPreview();
    });
  });
  $('#planAiCreateApplyBar').classList.remove('hidden');
}
async function planAiCreateSend() {
  const msg = $('#planAiCreateMsg');
  const text = $('#planAiCreateText').value.trim();
  if (!text) { showMsg(msg, 'err', 'Describe what you want first'); return; }
  showMsg(msg, '', '');
  try {
    const files = await planAiCreateSerializeQueue();
    const model = $('#planAiCreateModel').value || undefined;
    const body = { text, category: planAiCreateCtx.category, subcategory: planAiCreateCtx.subcategory, entity: planAiCreateCtx.entity };
    if (files.length) body.files = files;
    if (model) body.model = model;
    if (planAiCreateAnswers) body.answers = planAiCreateAnswers;
    if (planAiCreateHistoryText) body.historyText = planAiCreateHistoryText;
    const r = await api('/api/planning/ai-create/propose', { method: 'POST', body });
    planAiCreateHistoryText = `${planAiCreateHistoryText}\nYou: ${text}`.trim();
    if (r.ask) {
      const askHost = $('#planAiCreateAsk');
      askHost.innerHTML = `<div>${r.ask.map((q) => `<div><label>${esc(q.label)} *</label><input data-plan-ai-create-ask="${esc(q.field)}" type="${q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text'}"></div>`).join('')}</div><div class="toolbar"><button class="small primary" id="planAiCreateAskSend">Send</button></div>`;
      $('#planAiCreateAskSend').addEventListener('click', () => {
        const answers = {};
        let ok = true;
        askHost.querySelectorAll('[data-plan-ai-create-ask]').forEach((inp) => {
          if (!inp.value.trim()) ok = false;
          answers[inp.dataset.planAiCreateAsk] = inp.value.trim();
        });
        if (!ok) { showMsg(msg, 'err', 'Please answer all questions before continuing.'); return; }
        planAiCreateAnswers = { ...(planAiCreateAnswers || {}), ...answers };
        planAiCreateHistoryText = `${planAiCreateHistoryText}\nYou: ${r.ask.map((q) => `${q.label}: ${answers[q.field]}`).join(', ')}`.trim();
        askHost.innerHTML = '';
        planAiCreateSend();
      });
      return;
    }
    $('#planAiCreateAsk').innerHTML = '';
    planAiCreateProposal = r;
    planAiCreateRenderPreview();
  } catch (err) { showMsg(msg, 'err', err.message); }
}
async function planAiCreateApply() {
  const msg = $('#planAiCreateMsg');
  const r = planAiCreateProposal;
  if (!r || !r.proposal) return;
  const p = r.proposal;
  const ops = [];
  try {
    document.querySelectorAll('#planAiCreatePreview [data-plan-ai-create-op]').forEach((row) => {
      const idx = Number(row.dataset.planAiCreateOp);
      const orig = p.strategy.ops[idx];
      const params = JSON.parse(row.querySelector('[data-plan-ai-create-op-params]').value);
      ops.push({ ...orig, params });
    });
  } catch { showMsg(msg, 'err', 'An operation params field must be valid JSON'); return; }
  const proposal = {
    project: { name: $('#planAiCreateProjectName').value.trim(), question: p.project.question || null },
    scenario: { name: $('#planAiCreateScenarioName').value.trim(), factors: p.scenario.factors || {} },
    baseline: { name: $('#planAiCreateBaselineName').value.trim(), description: $('#planAiCreateBaselineDesc').value.trim(), assumptions: p.baseline.assumptions },
    strategy: { name: $('#planAiCreateStrategyName').value.trim(), ops },
  };
  try {
    const data = await api('/api/planning/ai-create/apply', { method: 'POST', body: { proposal, category: planAiCreateCtx.category, subcategory: planAiCreateCtx.subcategory, entity: planAiCreateCtx.entity } });
    const newId = (data.project || {}).id;
    closeModalEl($('#planAiCreateModal'));
    location.hash = `#planning/project/${newId}`;
  } catch (err) { showMsg(msg, 'err', err.message); }
}
(function planAiCreateWire() {
  const goBtn = $('#planAiCreateGoBtn');
  if (goBtn) goBtn.addEventListener('click', planAiCreateSend);
  const applyBtn = $('#planAiCreateApplyBtn');
  if (applyBtn) applyBtn.addEventListener('click', planAiCreateApply);
  const fileInput = $('#planAiCreateFiles');
  if (fileInput) fileInput.addEventListener('change', () => {
    planAiCreateQueue.push(...fileInput.files);
    fileInput.value = '';
    planAiCreateRenderQueue();
  });
  const queueHost = $('#planAiCreateQueue');
  if (queueHost) queueHost.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plan-ai-create-queue-remove]');
    if (!btn) return;
    planAiCreateQueue.splice(Number(btn.dataset.planAiCreateQueueRemove), 1);
    planAiCreateRenderQueue();
  });
  const ta = $('#planAiCreateText');
  if (ta) ta.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length) return;
    e.preventDefault();
    planAiCreateQueue.push(...files);
    planAiCreateRenderQueue();
  });
  const modelSel = $('#planAiCreateModel');
  if (modelSel) loadAiConfig().then((cfg) => {
    const models = cfg.models && cfg.models.length ? cfg.models : (cfg.model ? [cfg.model] : []);
    modelSel.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (cfg.model) modelSel.value = cfg.model;
  });
})();

async function loadPlanProject(id) {
  return withLoading(async () => {
    const data = await api(`/api/planning/projects/${id}`);
    planProjectData = data;
    planCompareScenarioIds = null;
    planWiringStrategyIds = null;
    // Fixed baseline: the wiring never picks a baseline anymore — it
    // resolves to the project's fixed current-state baseline (its
    // recommendation record when one exists, else the do-nothing
    // label with a null pin).
    planWiringBaselineId = data.project && data.project.fixedBaseline ? data.project.fixedBaseline.recordId : null;
    $('#planList').classList.add('hidden');
    $('#planProject').classList.remove('hidden');
    $('#planStrategy').classList.add('hidden');
    $('#planScenario').classList.add('hidden');
    $('#planProject').innerHTML = planProjectHtml(data);
    planProjectWire(data);
    await loadPlanStrategyCards(id);
    // Inline viewer restore: a pending deep link opens its tab; else
    // a surviving tab re-renders (a deleted report's tab drops, and
    // the viewer empties when no tabs remain).
    if (planReportPendingOpen && planReportPendingOpen.projectId === id) {
      const pending = planReportPendingOpen;
      planReportPendingOpen = null;
      planReportTabsOpen(id, pending.reportId, (data.reports || []).find((r) => r.id === pending.reportId)?.name || 'Report');
      await loadPlanReport(id, pending.reportId);
    } else if (planReportTabsProject === id && planReportTabs.length) {
      const cur = planReportTabs.find((t) => t.id === planReportCurrentId) || planReportTabs[planReportTabs.length - 1];
      if (!(data.reports || []).some((r) => r.id === cur.id)) {
        planReportTabs = planReportTabs.filter((t) => t.id !== cur.id);
        if (!planReportTabs.length) { planReportCurrentId = null; planReportCurrentPins = null; planReportHighlightApply(); planReportOutlineClear(); }
        else await loadPlanReport(id, planReportTabs[planReportTabs.length - 1].id);
      } else {
        await loadPlanReport(id, cur.id);
      }
    } else {
      planReportCurrentId = null;
      planReportCurrentPins = null;
      planReportOutlineClear();
    }
  });
}
// Fixed-baseline metadata display (user 2026-11-04): the current
// do-nothing state, metadata only — no Add/Edit/Refine/Delete, no
// Select. Shared by the project Baselines tier and the strategy
// page's Baseline group. Null = legacy project without a category.
// Draw a pool baseline's doughnut (shared by the project-page
// Baselines tier and the strategy-page Baseline card). Pool baselines
// only — account/holding baselines have no per-source items and get
// no chart. A single-source pool renders as one full-circle slice.
function planBaselinePoolDoughnutDraw(fb, chartId) {
  if (!fb || fb.kind !== 'investment' || !fb.figures || fb.figures.poolValue == null) return;
  const items = Array.isArray(fb.figures.items) ? fb.figures.items : [];
  if (!items.length) return;
  if (!document.getElementById(chartId)) return;
  planDoughnutChart(chartId, items.map((it) => it.account || it.symbol || 'External funding'), items.map((it) => Number(it.value ?? it.amount ?? 0) || 0), 'Pool total', fb.figures.poolValue);
}
// Sink doughnut (user 2026-11-05): where the pool goes — one slice
// per buy (symbol + amount), the unallocated remainder as a "Pool"
// slice. No buys = the whole pool held as-is, one slice. Same
// component/style as the Baseline card's pool doughnut; the table
// under it carries the exact amounts + shares, and it is redrawn on
// every strategy-page load, so it tracks adds/edits/deletes.
function planSinkDoughnutDraw(d) {
  const fb = d && d.fixedBaseline;
  if (!fb || fb.kind !== 'investment' || !fb.figures || fb.figures.poolValue == null) return;
  const chartId = 'planSinkDoughnutChart';
  if (!document.getElementById(chartId)) return;
  const total = Number(fb.figures.poolValue) || 0;
  const buys = (d.ops || []).filter((o) => o.op_type === 'buy');
  const labels = [];
  const data = [];
  let allocated = 0;
  for (const o of buys) {
    const p = o.params || {};
    const amt = Number(p.amount) || 0;
    if (amt <= 0) continue;
    allocated += amt;
    labels.push(p.symbol || o.holdingSymbol || 'Buy');
    data.push(amt);
  }
  const rest = Math.max(0, total - allocated);
  if (rest > 0 || !labels.length) { labels.push('Pool'); data.push(rest); }
  planDoughnutChart(chartId, labels, data, 'Pool total', total);
  const tbl = document.getElementById('planSinkDoughnutTable');
  if (tbl) {
    const rows = buys.map((o) => {
      const p = o.params || {};
      return { label: p.symbol || o.holdingSymbol || 'Buy', amount: Number(p.amount) || 0 };
    }).filter((r) => r.amount > 0);
    if (rest > 0 || !rows.length) rows.push({ label: 'Pool (held as-is)', amount: rest });
    tbl.innerHTML = `<table class="tbl"><thead><tr><th>Buy</th><th>Amount</th><th>Share</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${money2(r.amount)}</td><td>${total ? `${((r.amount / total) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')}</tbody></table>`;
  }
}
function planFixedBaselineHtml(fb, scen, opts = {}) {
  if (!fb) return '<div class="note">No fixed baseline — legacy project without a category.</div>';
  let parts = [];
  if (fb.kind === 'property') {
    if (fb.address) parts.push(esc(fb.address));
    if (fb.rateLabel && fb.rateLabel !== '—') parts.push(`Interest plan · ${esc(fb.rateLabel)}`);
    if (fb.outstanding != null) parts.push(`Remaining balance ${money2(fb.outstanding)}`);
    if (fb.payment != null) parts.push(`Monthly payment ${money2(fb.payment)}`);
  } else if (fb.kind === 'investment') {
    const figs = fb.figures || {};
    if (figs.items) {
      for (const it of figs.items) {
        if (it.source === 'external') parts.push(`External funding ${money2(it.value ?? it.amount ?? 0)}`);
        else if (it.account) parts.push(`${esc(it.account)} ${money2(it.value ?? 0)}`);
        else if (it.symbol) parts.push(`${esc(it.symbol)} ${money2(it.value ?? 0)}`);
      }
    } else if (figs.value != null) parts.push(`Current value ${money2(figs.value)}`);
    // Effective expected return, display only (user 2026-11-04):
    // the selected scenario's stock factor wins when set (a
    // per-holding override, else the scenario default), else the
    // holding's own-history rate — each labeled with its source.
    // Editing lives on the scenario page; this card has no inputs.
    const scenStock = scen && scen.stock ? scen.stock : null;
    const shown = new Set();
    for (const r of fb.returns || []) {
      shown.add(Number(r.holdingId));
      const ov = scenStock && scenStock.byHolding ? scenStock.byHolding[r.holdingId] || scenStock.byHolding[Number(r.holdingId)] : null;
      if (ov && ov.valuePct != null) parts.push(`${esc(r.label)} ${ov.valuePct}%/yr expected · Scenario ${esc(scen.name)}`);
      else if (scenStock && scenStock.valuePct != null) parts.push(`${esc(r.label)} ${scenStock.valuePct}%/yr expected · Scenario ${esc(scen.name)}`);
      else parts.push(`${esc(r.label)} ${r.pct}%/yr expected · History (${esc(r.basis || 'Price CAGR')}${r.window ? ` · ${esc(r.window)}` : ''})`);
    }
    if (scenStock && scenStock.byHolding) {
      for (const [hid, ov] of Object.entries(scenStock.byHolding)) {
        if (shown.has(Number(hid)) || !ov || ov.valuePct == null) continue;
        parts.push(`Holding ${hid} ${ov.valuePct}%/yr expected · Scenario ${esc(scen.name)}`);
      }
    }
    if (!parts.length && fb.description) parts.push(esc(fb.description));
  } else if (fb.kind === 'earning') {
    if (fb.employer) {
      parts.push(esc(fb.employer));
      if (fb.annualGross != null) parts.push(`${money2(fb.annualGross)}/yr`);
      if (fb.frequency) parts.push(esc(fb.frequency));
    } else {
      if (fb.label) parts.push(esc(fb.label));
      if (fb.taxYear != null) parts.push(String(fb.taxYear));
      if (fb.gross != null) parts.push(`gross ${money2(fb.gross)}`);
      if (fb.net != null) parts.push(`net ${money2(fb.net)}`);
    }
  } else if (fb.kind === 'saving') {
    if (fb.spent12m != null) parts.push(`Spent (trailing 12 months) ${money2(fb.spent12m)}`);
  } else if (fb.kind === 'tax_saving') {
    parts.push(`${fb.jobs ?? 0} salary jobs · ${fb.rentals ?? 0} rentals`);
  }
  // Pool baseline doughnut (pool baselines only): one slice per pool
  // source with amount + share, pool total in the center — the same
  // style as the funding visualization.
  let poolViz = '';
  if (fb.kind === 'investment' && fb.figures && fb.figures.poolValue != null && Array.isArray(fb.figures.items) && fb.figures.items.length) {
    const items = fb.figures.items;
    const total = fb.figures.poolValue;
    const chartId = opts.chartId || 'planBaselinePoolChart';
    poolViz = `<div class="chart-wrap" style="height:200px"><canvas id="${chartId}"></canvas></div>
      <table class="tbl"><thead><tr><th>Source</th><th>Amount</th><th>Share</th></tr></thead><tbody>${items.map((it) => {
        const label = it.account || it.symbol || 'External funding';
        const v = Number(it.value ?? it.amount ?? 0) || 0;
        return `<tr><td>${esc(label)}</td><td>${money2(v)}</td><td>${total ? `${((v / total) * 100).toFixed(1)}%` : '—'}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
  return `<div class="card breakdown-card plan-flow-card" id="planFixedBaselineCard">
    <div class="k">${esc(fb.name)}</div>
    <div class="n">Fixed baseline — do nothing${parts.length ? ` · ${parts.join(' · ')}` : ''}</div>
    ${fb.description && fb.description !== fb.name ? `<div class="n">${esc(fb.description)}</div>` : ''}
    ${poolViz}</div>`;
}
function planProjectHtml(d) {
  const p = d.project;
  const templated = !!d.project.templateSchema;
  const sections = templated ? d.project.templateSchema.sections : { declaredAssets: true };
  // HEADER: title + ONE line — category · subcategory · entity for
  // categorized projects, else the project question when present.
  const headerLine = d.project.categoryLabels
    ? `${d.project.categoryLabels.category} · ${d.project.categoryLabels.subcategory} · ${d.project.categoryLabels.entity}`
    : (p.question || '');
  // Title tags: the category pieces as pills on the title row (the old
  // note line below the title is replaced by them when they exist).
  const catTags = d.project.categoryLabels
    ? [d.project.categoryLabels.category, d.project.categoryLabels.subcategory, d.project.categoryLabels.entity].filter((x) => x !== undefined && x !== null && x !== '')
    : [];
  // Legacy template answers (old template flow) render as ONE compact
  // line under the header; no answers → no line at all.
  let metaLine = '';
  if (templated && d.project.templateSchema.key !== 'categorized') {
    const fields = d.project.templateSchema.fields || [];
    const parts = fields.map((f) => {
      const v = (d.project.metadata || {})[f.key];
      if (v === undefined || v === null || v === '') return null;
      const label = d.project.metadataLabels && d.project.metadataLabels[f.key] ? d.project.metadataLabels[f.key] : String(v);
      return `${f.label}: ${label}`;
    }).filter(Boolean);
    if (parts.length) metaLine = `<div class="note" id="planMetadataLine">${esc(parts.join(' · '))} <button class="small" id="planMetadataLineEdit">Edit</button></div>`;
  }
  const header = `
    <div><a id="planProjectBackLink" href="#planning">← Back to Planning</a></div>
    <div class="toolbar" id="planProjectHeader"><h3>${esc(p.name)}</h3>
      ${catTags.length ? `<span id="planProjectCategoryLine" class="plan-title-tags">${catTags.map((t) => `<span class="plan-title-tag">${esc(t)}</span>`).join('')}</span>` : ''}
      <div class="spacer"></div>
      <div class="toolbar">
        ${d.stale ? '<span class="msg warn" style="margin:0">Stale baseline</span><button class="small" id="planSyncBtn">Sync latest mainline</button>' : ''}
        <button class="small" id="planAiPanelToggleBtn">✨ Design with AI</button>
        <button class="small" id="planProjectEditBtn">Edit</button>
        <button class="small danger" id="planProjectDeleteBtn">Delete</button>
      </div></div>
    ${!d.project.categoryLabels && headerLine ? `<div class="note" id="planProjectCategoryLine">${esc(headerLine)}</div>` : ''}
    ${metaLine}
    <div class="msg" id="planProjectMsg"></div>`;
  // FLOW: three tiers, top to bottom — scenario tier (full width),
  // ONE middle row holding baselines + strategies side by side at
  // the same level (baselines first, then strategies), reports tier
  // (full width). The tier/group wrappers keep the old panel ids
  // (planScenarioCardsPanel / planBaselineCardsPanel /
  // planStrategiesPanel / planReportsPanel) in document order, and
  // the card hosts keep their ids, so existing renders and pins keep
  // working. No connector lines: linkage is highlight only — the
  // wiring selection (blue) and, for the current report tab, that
  // report's pins (amber) on the tier cards above the viewer.
  const flowPanel = `<div class="panel" id="planFlowPanel">
      <div class="plan-flow-grid" id="planFlowGrid">
      <div class="plan-flow-tier" id="planScenarioCardsPanel">
      <div class="section-head"><h3>Scenarios</h3>
        <div class="toolbar"><button class="small primary" id="planAddScenarioBtn">+ Add scenario</button></div>
      </div>
      <div id="planScenarioCards"></div>
      </div>
      <div class="plan-flow-tier plan-flow-tier-mid" id="planFlowMidTier">
      <div class="plan-flow-group" id="planBaselineCardsPanel">
      <div class="section-head"><h3>Baselines</h3></div>
      <div id="planBaselineCards"></div>
      </div>
      <div class="plan-flow-group" id="planStrategiesPanel">
      <div class="section-head"><h3>Strategies</h3>
        <div class="toolbar"><button class="small primary" id="planAddStrategyBtn">+ Add strategy</button></div>
      </div>
      <div id="planStrategyCards"></div>
      </div>
      </div>
      <div class="plan-flow-tier" id="planReportsPanel">
      <div class="section-head"><h3>Reports</h3>
        <div class="toolbar"><button class="small primary" id="planFlowGenerateBtn">Generate report</button><button class="small" id="planAiReportBtn">Generate with AI</button></div>
      </div>
      <div class="note" id="planFlowGenerateNote"></div>
      <div id="planReportTabsHost"></div>
      <div id="planReportList"></div>
      <div id="planReport"></div>
      </div>
      </div>
    </div>`;
  const assetsPanel = `<div class="panel" id="planAssetPanel">
      <div class="section-head"><h3>Declared fixed-term assets</h3>
        <div class="toolbar"><button class="small" id="planAddAssetBtn">+ Add asset</button></div>
      </div>
      <div id="planAssetList"></div>
    </div>`;
  // AI PANEL: the ONE in-project design entry — scenario, baseline,
  // strategy operations — as an inline dropdown conversation panel
  // in Fill-with-AI parity: thread across turns, preview, Apply-only.
  // Report generation keeps its own separate button (planAiReportBtn)
  // and is never folded in here. Model design lives in the Generate
  // with AI modal, not in this panel.
  const aiPanel = `<div class="panel hidden" id="planAiPanel">
      <div class="section-head"><h3>✨ Design with AI</h3>
        <div class="toolbar"><button class="small" id="planAiPanelCloseBtn">Close</button></div>
      </div>
      <div class="toolbar" id="planAiPanelTargets">
        <button class="small" data-plan-ai-target="scenario">Scenario</button>
        <button class="small" data-plan-ai-target="ops">Strategy · operations</button>
      </div>
      <div id="planAiPanelStrategyRow" class="hidden">
        <label>Strategy</label><select id="planAiPanelStrategy"></select>
      </div>
      <div><label>Describe what you want *</label><textarea id="planAiPanelText" rows="3" placeholder="e.g. Prime rises 1 point over the next year, then holds"></textarea></div>
      <div id="planAiPanelQueue"></div>
      <div class="toolbar"><input type="file" id="planAiPanelFiles" multiple accept="image/*,application/pdf,.csv,.txt"><select id="planAiPanelModel" title="Model" style="width:auto;flex:0 1 auto"></select><button class="small primary" id="planAiPanelGoBtn">Send</button></div>
      <div id="planAiPanelThread"></div>
      <div id="planAiPanelAsk"></div>
      <div id="planAiPanelOut"></div>
      <div class="msg" id="planAiPanelMsg"></div>
    </div>`;
  // DETAIL ORDER (both branches): header → AI panel → flow (scenario tier →
  // baseline + strategy row → reports) → (declared assets for sell
  // templates / legacy). Scenario, baseline and strategy are three
  // independent specs in one flow; strategy comparison lives in
  // reports only (same renderers, report-scoped ids). No
  // baseline-info panel anywhere, and no per-project history
  // panel — history lives in the app-level History tab.
  if (!templated) return header + aiPanel + flowPanel + assetsPanel;
  return header + aiPanel + flowPanel + (sections.declaredAssets ? assetsPanel : '');
}
// One report-card template for BOTH tiers (project page + strategy
// page): whole-card click opens the tab, Delete removes it
// (stopPropagation, so Delete never opens the card). Tags state the
// pin honestly: Unpinned = legacy row saved before pinning (no
// lines); Flat world = pinned to no scenario. The Under note names
// the pinned world (the scenario side of the pin is not drawn as a
// line — the scenario already feeds the middle tier above). No
// Select button — reports are not part of the wiring selection.
function planReportCardHtml(r, d) {
  const tags = [];
  if (r.scenarioIds === null || r.scenarioIds === undefined) tags.push('Unpinned');
  else if (Array.isArray(r.scenarioIds) && r.scenarioIds.length === 0) tags.push('Flat world');
  let under = null;
  if (r.scenarioIds !== null && r.scenarioIds !== undefined) {
    under = (Array.isArray(r.scenarioIds) && r.scenarioIds.length === 0) ? 'Current rates (no scenario)'
      : (r.scenarioIds || []).map((id) => { const sc = (d.scenarios || []).find((x) => x.id === id); return sc ? sc.name : `#${id}`; }).join(', ');
  }
  const meta = [under ? `Under ${under}` : null, tags.length ? tags.join(' · ') : null].filter(Boolean).join(' · ');
  return `<div class="card plan-flow-card plan-report-card" data-plan-report="${r.id}" data-plan-report-view="${r.id}" style="cursor:pointer">
    <div class="k"><span>${esc(r.name)}</span></div>
    ${meta ? `<div class="n">${esc(meta)}</div>` : ''}
    <div class="toolbar"><button class="small danger" data-plan-report-del="${r.id}">Delete</button></div></div>`;
}
function planProjectWire(d) {
  const p = d.project;
  $('#planProjectEditBtn').addEventListener('click', () => openPlanProjectModal(p));
  $('#planProjectDeleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete project "${p.name}" and all its strategies?`)) return;
    try { await api(`/api/planning/projects/${p.id}`, { method: 'DELETE' }); location.hash = '#planning'; }
    catch (err) { showMsg($('#planProjectMsg'), 'err', err.message); }
  });
  const syncBtn = $('#planSyncBtn');
  if (syncBtn) syncBtn.addEventListener('click', async () => {
    try { await api(`/api/planning/projects/${p.id}/sync`, { method: 'POST' }); loadPlanProject(p.id); }
    catch (err) { showMsg($('#planProjectMsg'), 'err', err.message); }
  });
  $('#planAddStrategyBtn').addEventListener('click', () => openPlanStrategyModal(p.id));
  const asBtn = $('#planAddAssetBtn');
  if (asBtn) asBtn.addEventListener('click', () => openPlanDeclaredAssetModal(p.id));
  $('#planAiReportBtn').addEventListener('click', () => openPlanReportAiModal(p.id));
  $('#planFlowGenerateBtn').addEventListener('click', () => planFlowGenerate(p.id));
  planFlowGenerateRefresh(); // initial guard state until the comparison load refreshes it
  planAiPanelWire(p); // the ONE in-project design entry (scenario, strategy ops — baselines are fixed, never designed)
  // Baselines tier: the FIXED baseline only, metadata, no buttons.
  // Legacy baseline records still load via the API and still label
  // old reports, but the UI never offers them as choices anymore.
  planRenderFixedBaselineCard();
  // Compact metadata line: Edit swaps the line for the schema's field
  // editors (the same fields the old panel edited).
  const metaLineEdit = $('#planMetadataLineEdit');
  if (metaLineEdit) metaLineEdit.addEventListener('click', async () => {
    const view = $('#planMetadataLine');
    const fields = p.templateSchema.fields || [];
    let props = [];
    if (fields.some((f) => f.type === 'property')) {
      try {
        const pr = await api('/api/properties');
        props = (pr.properties || pr || []).filter((x) => (x.terms && x.terms.length > 0) || x.mortgage_balance != null);
      } catch { props = []; }
    }
    const cur = p.metadata || {};
    view.innerHTML = fields.map((f) => {
      if (f.type === 'property') return `<div><label>${esc(f.label)}${f.required ? ' *' : ''}</label><select id="planMetaField_${f.key}"><option value="">Select a property</option>${props.map((x) => `<option value="${x.id}"${Number(cur[f.key]) === Number(x.id) ? ' selected' : ''}>${esc(x.address)}</option>`).join('')}</select></div>`;
      if (f.type === 'account_type') return `<div><label>${esc(f.label)}</label><select id="planMetaField_${f.key}"><option value="">Any</option>${['TFSA', 'RRSP', 'NonRegistered'].map((t) => `<option${cur[f.key] === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>`;
      return `<div><label>${esc(f.label)}</label><input id="planMetaField_${f.key}" value="${esc(String(cur[f.key] ?? ''))}"></div>`;
    }).join('') + `<div class="toolbar"><button class="small primary" id="planMetadataSaveBtn">Save</button><button class="small" id="planMetadataCancelBtn">Cancel</button></div><div class="msg" id="planMetadataMsg"></div>`;
    $('#planMetadataCancelBtn').addEventListener('click', () => loadPlanProject(p.id));
    $('#planMetadataSaveBtn').addEventListener('click', async () => {
      const msg = $('#planMetadataMsg');
      try {
        const meta = {};
        for (const f of fields) {
          const el = document.querySelector(`#planMetaField_${f.key}`);
          const v = el ? el.value : '';
          if (f.required && !v) throw new Error(`${f.label} is required`);
          if (f.type === 'property') meta[f.key] = v ? Number(v) : null;
          else meta[f.key] = v || null;
        }
        await api(`/api/planning/projects/${p.id}`, { method: 'PUT', body: { metadata: meta } });
        loadPlanProject(p.id);
      } catch (err) { showMsg(msg, 'err', err.message); }
    });
  });
  const assetList = $('#planAssetList');
  if (assetList) {
    assetList.innerHTML = d.declaredAssets.map((a) => `
    <div class="plan-row"><span>${esc(a.name)} · ${money2(a.amount)}${a.maturity_date ? ` · matures ${esc(a.maturity_date)}` : ''}</span>
    <button class="small danger" data-plan-asset-del="${a.id}">Delete</button></div>`).join('') || '<div class="note">No declared assets.</div>';
  }
  document.querySelectorAll('[data-plan-asset-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/planning/declared-assets/${b.dataset.planAssetDel}`, { method: 'DELETE' }); loadPlanProject(p.id); }
    catch (err) { showMsg($('#planProjectMsg'), 'err', err.message); }
  }));
  // Report cards in the flow's Reports tier (shared template —
  // see planReportCardHtml): whole-card click opens the tab.
  $('#planReportList').innerHTML = d.reports.map((r) => planReportCardHtml(r, d)).join('') || '<div class="note">No reports yet.</div>';
  document.querySelectorAll('[data-plan-report-view]').forEach((el) => {
    el.addEventListener('click', () => { planOpenReportTab(p.id, Number(el.dataset.planReportView)); });
  });
  document.querySelectorAll('[data-plan-report-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api(`/api/planning/reports/${b.dataset.planReportDel}`, { method: 'DELETE' }); loadPlanProject(p.id); }
    catch (err) { showMsg($('#planProjectMsg'), 'err', err.message); }
  }));
  planScenarioSectionWire(d);
}
function planScenarioSectionWire(d) {
  const p = d.project;
  const list = $('#planScenarioCards');
  if (!list) return;
  const scenarios = d.scenarios || [];
  list.innerHTML = scenarios.map((sc) => {
    const line = planScenarioSummaryLine(sc.factors);
    return `<div class="card breakdown-card plan-flow-card" data-plan-scenario="${sc.id}" style="cursor:pointer">
      <div class="k">${esc(sc.name)}${sc.is_base ? ' · Default' : ''}</div>
      <div class="n">${line ? esc(line) : 'Flat world — current rates'}</div>
      <div class="toolbar">
        <button class="small plan-flow-select" data-plan-scenario-select="${sc.id}" aria-pressed="false">Select</button>
        <button class="small danger" data-plan-scenario-del="${sc.id}">Delete</button>
      </div></div>`;
  }).join('') || `<div class="card plan-flow-card plan-flow-flat" id="planFlowFlatNode"><div class="k">Current rates (no scenario)</div><div class="n">Flat world — current rates</div></div>`;
  document.querySelectorAll('[data-plan-scenario]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = `#planning/scenario/${el.dataset.planScenario}`; });
  });
  document.querySelectorAll('[data-plan-scenario-select]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); planWiringSelectScenario(Number(b.dataset.planScenarioSelect)); });
  });
  document.querySelectorAll('[data-plan-scenario-del]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = scenarios.find((x) => x.id === Number(b.dataset.planScenarioDel));
      if (!row || !confirm(`Delete scenario "${row.name}"?`)) return;
      try { await api(`/api/planning/scenarios/${row.id}`, { method: 'DELETE' }); loadPlanProject(p.id); }
      catch (err) { showMsg($('#planProjectMsg'), 'err', err.message); }
    });
  });
  $('#planAddScenarioBtn').addEventListener('click', () => {
    planScenarioModalOpen(p.id, p.category);
  });
}
// ---- Project flow wiring: one shared selection + connector lines ----
// Selection lives in wiring state, not a second picker:
// scenario = first of planCompareScenarioIds (single-select, the
// active world); strategies = planWiringStrategyIds (multi, null = all);
// baseline = planWiringBaselineId, always the FIXED baseline (the
// project's fixed current-state baseline record when one exists,
// else null = the do-nothing label) — never picked, because the
// engine's comparison baseline is always the do-nothing reference,
// so a baseline pick would change no comparison numbers; it only
// defaults the report modals.
// Click-select vs click-navigate: the card body keeps its existing
// navigation/edit behavior; selection happens ONLY through the
// explicit Select button (stopPropagation, like Edit/Delete).
let planWiringBaselineId = null;
let planWiringStrategyIds = null; // null = every project strategy
const planWiringScenarioId = () => (planCompareScenarioIds && planCompareScenarioIds.length ? planCompareScenarioIds[0] : null);
// Baseline card (project page): re-rendered on every wiring refresh
// so its effective expected returns track the selected scenario —
// the scenario factor when set, else each holding's own history.
// Display only: no edit control lives on the card.
function planRenderFixedBaselineCard() {
  const host = $('#planBaselineCards');
  const d = planProjectData;
  if (!host || !d || !d.project) return;
  const scenId = planWiringScenarioId();
  const scen = scenId != null ? (d.scenarios || []).find((x) => x.id === scenId) : null;
  // A disabled stock factor follows the default world: the card falls
  // back to each holding's own-history rate.
  const scenStock = scen && scen.factors && scen.factors.stock && scen.factors.stock.enabled !== false ? { name: scen.name, stock: scen.factors.stock } : null;
  host.innerHTML = planFixedBaselineHtml(d.project.fixedBaseline, scenStock, { chartId: 'planBaselinePoolChart' });
  planBaselinePoolDoughnutDraw(d.project.fixedBaseline, 'planBaselinePoolChart');
}
const planWiringRepick = () => { const d = planProjectData; return !!(d && (d.scenarios || []).length && !(planCompareScenarioIds && planCompareScenarioIds.length)); };
const planWiringStrategyPicked = (id) => (planWiringStrategyIds == null ? true : planWiringStrategyIds.includes(id));
function planWiringRefresh() {
  const scenId = planWiringScenarioId();
  const repick = planWiringRepick();
  document.querySelectorAll('[data-plan-scenario-select]').forEach((b) => {
    const on = Number(b.dataset.planScenarioSelect) === scenId;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? '✓ Selected' : 'Select';
    b.closest('.card')?.classList.toggle('plan-selected', on);
  });
  document.querySelectorAll('[data-plan-strategy-select]').forEach((b) => {
    const on = !repick && planWiringStrategyPicked(Number(b.dataset.planStrategySelect));
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? '✓ Selected' : 'Select';
    b.disabled = repick;
    b.closest('.card')?.classList.toggle('plan-selected', on);
  });
  planRenderFixedBaselineCard();
  planFlowGenerateRefresh();
}
// ---- one-click Generate report (flow panel) ----
// Strictly on demand: selecting never creates, pre-computes, or
// pre-renders a report — only this button's click POSTs, via the
// existing report endpoint (pinning rules untouched), and opens the
// computed report. The preset title names the pinned world +
// baseline + strategy letters, so a preset report is recognizable
// against an AI-titled one.
// Picked strategies = the wiring's current set (null = every
// project strategy).
function planFlowPickedStrategies() {
  const d = planProjectData || {};
  const all = (d.strategies || []).map((s) => s.id);
  return planWiringStrategyIds == null ? all : all.filter((id) => planWiringStrategyIds.includes(id));
}
function planFlowPresetTitle() {
  const d = planProjectData || {};
  const scenId = planWiringScenarioId();
  const scen = scenId != null ? (d.scenarios || []).find((x) => x.id === scenId) : null;
  const base = planWiringBaselineId != null ? (d.project && d.project.baselines ? d.project.baselines : []).find((x) => x.id === planWiringBaselineId) : null;
  const letters = planFlowPickedStrategies().map((id) => { const s = (d.strategies || []).find((x) => x.id === id); return s ? s.letter : `#${id}`; }).join(', ');
  return `Report · ${scen ? scen.name : 'Current rates'} · ${base ? base.name : 'Do-nothing'} · ${letters}`;
}
function planFlowGenerateRefresh() {
  const btn = $('#planFlowGenerateBtn');
  const note = $('#planFlowGenerateNote');
  if (!btn || !note) return;
  const d = planProjectData || {};
  const missing = [];
  if ((d.scenarios || []).length && planWiringScenarioId() == null) missing.push('a scenario');
  if (!planFlowPickedStrategies().length) missing.push('at least one strategy');
  // No forced routing anymore (user 2026-11-04): both Generate
  // buttons are always available once the picks are complete —
  // choosing the button IS choosing the engine (preset vs AI).
  if (missing.length) {
    btn.disabled = true;
    note.textContent = `Pick ${missing.join(', ')} to generate.`;
  } else {
    btn.disabled = false;
    note.textContent = '';
  }
}
async function planFlowGenerate(projectId) {
  const btn = $('#planFlowGenerateBtn');
  if (btn && btn.disabled) return;
  const scenId = planWiringScenarioId();
  const picked = planFlowPickedStrategies();
  // Kind-aware preset definition (user 2026-11-05 — the template is
  // keyed on the BASELINE kind): a cash-pool baseline gets a pool
  // trajectory chart, never the hardcoded Mortgage balance chart
  // (the viewer hides it, so a preset pool report read "No charts
  // in this report"). Property/other keep it. Same rule as the
  // strategy-page Generate.
  const fb = (planProjectData || {}).project && planProjectData.project.fixedBaseline;
  const isPool = !!(fb && fb.kind === 'investment' && fb.figures && fb.figures.poolValue != null);
  const presetCharts = isPool
    ? [{ template: 'time_line', title: 'Cash pool', series: ['pool_balance', 'stock_value'] }, { template: 'fan_band', title: 'Stock volatility fan', series: ['stock_value'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }]
    : [{ template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }];
  try {
    const r = await api(`/api/planning/projects/${projectId}/reports`, { method: 'POST', body: {
      name: planFlowPresetTitle(),
      definition: { strategies: picked, charts: presetCharts },
      baseline_id: planWiringBaselineId,
      strategy_ids: picked,
      scenario_ids: scenId != null ? [scenId] : [],
    } });
    const id = r.report && r.report.id;
    if (id) planOpenReportTab(projectId, id);
  } catch (err) { showMsg($('#planProjectMsg'), 'err', err.message); }
}
async function planWiringSelectScenario(id) {
  if (planWiringScenarioId() === id) return; // radio behavior: no empty world via wiring
  planCompareScenarioIds = [id];
  const pid = planProjectData && planProjectData.project && planProjectData.project.id;
  if (pid) await loadPlanStrategyCards(pid);
  planWiringRefresh();
}
function planWiringSelectStrategy(id) {
  if (planWiringRepick()) return;
  const all = (planProjectData.strategies || []).map((s) => s.id);
  const cur = planWiringStrategyIds == null ? [...all] : [...planWiringStrategyIds];
  planWiringStrategyIds = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  planWiringRefresh();
}
// ---- scenario create modal with factors (user 2026-11-04) ----
// The create modal carries Name + the factor sections, so a scenario
// is created WITH its factors atomically — no name-only step +
// detail-page round trip. The stock section reuses the shared
// scenario stock editor (global default + per-holding rows); the
// prime section carries the functional inputs (presets + date/rate
// rows) but NOT the detail page's prime history chart, and its rows
// use native month inputs instead of the shared month popup (the
// popup is wired to the detail page's points container only).
// Growth sections follow the project category (property → property
// growth; earning → salary/rent growth). Detail-page editing stays
// for later edits; the Design-with-AI flow is untouched.
let planScenarioModalState = null;
function planScenarioModalRenderPrime() {
  const st = planScenarioModalState;
  if (!st) return;
  const host = $('#planScenarioModalPrime');
  if (!host) return;
  const curRate = st.primeInfo && st.primeInfo.current ? st.primeInfo.current.rate : null;
  const presetBtns = [['optimistic', 'Optimistic (prime down)'], ['pessimistic', 'Pessimistic (prime up)'], ['up', 'Up'], ['down', 'Down'], ['flat', 'Flat']]
    .map(([k, label]) => `<button type="button" class="small" data-modal-prime-preset="${k}">${label}</button>`).join(' ');
  host.innerHTML = `<div class="section-head"><h3>Prime</h3></div>
    <div class="note">Today's prime: ${curRate != null ? `${curRate}%` : '—'} · No points = prime stays at today's rate. Between points the rate holds until the next point.</div>
    <div class="toolbar">${presetBtns}</div>
    <div id="planScenarioModalPrimePoints">${st.prime.points.map((pt, i) => `
      <div class="plan-row"><input type="month" data-modal-prime-month="${i}" value="${pt.month}">
      <input type="number" step="0.01" data-modal-prime-rate="${i}" value="${pt.rate}" style="width:90px"> %
      <button type="button" class="small danger" data-modal-prime-del="${i}">Remove</button></div>`).join('') || '<div class="note">No future points yet — pick a preset or add a point.</div>'}
    </div>
    <div class="toolbar"><button type="button" class="small" id="planScenarioModalPrimeAddBtn">+ Add point</button></div>`;
  host.querySelectorAll('[data-modal-prime-preset]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/api/planning/prime-presets?preset=${b.dataset.modalPrimePreset}`);
      st.prime = { points: r.points || [], preset: r.preset };
      planScenarioModalRenderPrime();
    } catch (err) { showMsg($('#planScenarioModalMsg'), 'err', err.message); }
  }));
  host.querySelectorAll('[data-modal-prime-month]').forEach((inp) => inp.addEventListener('change', () => {
    const i = Number(inp.dataset.modalPrimeMonth);
    if (st.prime.points[i]) { st.prime.points[i].month = inp.value; st.prime.preset = null; }
  }));
  host.querySelectorAll('[data-modal-prime-rate]').forEach((inp) => inp.addEventListener('input', () => {
    const i = Number(inp.dataset.modalPrimeRate);
    if (st.prime.points[i]) { st.prime.points[i].rate = Number(inp.value); st.prime.preset = null; }
  }));
  host.querySelectorAll('[data-modal-prime-del]').forEach((b) => b.addEventListener('click', () => {
    st.prime.points.splice(Number(b.dataset.modalPrimeDel), 1);
    st.prime.preset = null;
    planScenarioModalRenderPrime();
  }));
  const addBtn = $('#planScenarioModalPrimeAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    const pts = st.prime.points;
    const last = pts.length ? pts[pts.length - 1] : null;
    pts.push({ month: last ? nextYm(last.month) : nowYm(), rate: last ? last.rate : (curRate != null ? curRate : 0) });
    st.prime.preset = null;
    planScenarioModalRenderPrime();
  });
}
async function planScenarioModalOpen(projectId, category) {
  const form = $('#planScenarioForm');
  form.dataset.projectId = projectId;
  $('#planScenarioName').value = '';
  showMsg($('#planScenarioModalMsg'), '', '');
  // Factors start unchecked in a fresh modal (same checkbox model as
  // the detail page); checking a box reveals its component.
  planScenarioModalState = { prime: { points: [], preset: null }, stock: {}, primeInfo: null, holdings: [], category, active: new Set() };
  try { planScenarioModalState.primeInfo = await api('/api/prime'); } catch { planScenarioModalState.primeInfo = null; }
  try {
    const inv = await api('/api/investments');
    planScenarioModalState.holdings = (inv.accounts || []).flatMap((a) => (a.holdings || []).map((h) => ({ ...h.holding, accountName: (a.account || {}).name })));
  } catch { planScenarioModalState.holdings = []; }
  const host = $('#planScenarioModalFactors');
  const growthRows = [];
  if (category === 'property') growthRows.push(['propertyGrowth', 'Property value growth (% / year)']);
  if (category === 'earning') { growthRows.push(['salaryGrowth', 'Salary growth (% / year)']); growthRows.push(['rentGrowth', 'Rent growth (% / year)']); }
  host.innerHTML = `<div class="toolbar" id="planScenarioModalChecks"></div>
    <div id="planScenarioModalPrime"></div>
    <div id="planScenarioModalStock"></div>
    ${growthRows.length ? `<div id="planScenarioModalGrowth"><div class="section-head"><h3>Growth</h3></div>${growthRows.map(([k, label]) => `
      <div data-modal-growth-row="${k}"><label>${label}</label><input type="text" inputmode="decimal" data-money data-modal-growth="${k}"></div>`).join('')}${category === 'earning' ? '<div class="note">Salary and rent growth are stored and labeled only — the projection has no earnings leg yet, so they do not change numbers.</div>' : ''}</div>` : ''}`;
  host.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  planScenarioModalRenderPrime();
  planStockFactorRender($('#planScenarioModalStock'), planScenarioModalState.stock, planScenarioModalState.holdings, {});
  planScenarioModalRenderChecks();
  planScenarioModalToggleFactors();
  openModal('planScenarioModal');
}
const PLAN_SCENARIO_MODAL_FACTOR_LABELS = { prime: 'Prime', stock: 'Stock return', propertyGrowth: 'Property growth', salaryGrowth: 'Salary growth', rentGrowth: 'Rent growth' };
function planScenarioModalRenderChecks() {
  const st = planScenarioModalState;
  if (!st) return;
  const host = $('#planScenarioModalChecks');
  if (!host) return;
  const avail = ['prime', 'stock'];
  if (st.category === 'property') avail.push('propertyGrowth');
  if (st.category === 'earning') avail.push('salaryGrowth', 'rentGrowth');
  host.innerHTML = avail.map((k) => `<label class="check"><input type="checkbox" data-modal-factor-check="${k}" ${st.active.has(k) ? 'checked' : ''}> ${PLAN_SCENARIO_MODAL_FACTOR_LABELS[k]}</label>`).join('');
  host.querySelectorAll('[data-modal-factor-check]').forEach((cb) => cb.addEventListener('change', () => {
    const k = cb.dataset.modalFactorCheck;
    if (cb.checked) st.active.add(k); else st.active.delete(k);
    planScenarioModalToggleFactors();
  }));
}
// Show/hide factor components from the checkbox set (hosts stay
// mounted, so in-progress edits survive a toggle).
function planScenarioModalToggleFactors() {
  const st = planScenarioModalState;
  if (!st) return;
  const prime = $('#planScenarioModalPrime');
  const stock = $('#planScenarioModalStock');
  const growth = $('#planScenarioModalGrowth');
  if (prime) prime.classList.toggle('hidden', !st.active.has('prime'));
  if (stock) stock.classList.toggle('hidden', !st.active.has('stock'));
  if (growth) {
    let any = false;
    growth.querySelectorAll('[data-modal-growth-row]').forEach((row) => {
      const on = st.active.has(row.dataset.modalGrowthRow);
      row.classList.toggle('hidden', !on);
      if (on) any = true;
    });
    growth.classList.toggle('hidden', !any);
  }
}
function planScenarioModalFactors() {
  const st = planScenarioModalState;
  const factors = {};
  if (st) {
    // Only checked factors are collected (a fresh modal has no stored
    // values to keep); each saved factor carries enabled: true.
    if (st.active.has('prime') && st.prime && (st.prime.points.length || st.prime.preset)) factors.prime = { points: st.prime.points, preset: st.prime.preset, enabled: true };
    if (st.active.has('stock')) {
      const sc = planStockFactorClean(st.stock);
      if (sc) factors.stock = { ...sc, enabled: true };
    }
    document.querySelectorAll('#planScenarioModalFactors [data-modal-growth]').forEach((inp) => {
      if (!st.active.has(inp.dataset.modalGrowth)) return;
      const v = planParsePct(inp.value);
      if (v != null) factors[inp.dataset.modalGrowth] = { valuePct: v, enabled: true };
    });
  }
  return factors;
}
$('#planScenarioForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#planScenarioModalMsg');
  try {
    const name = $('#planScenarioName').value.trim();
    if (!name) throw new Error('Scenario name is required');
    const body = { name };
    const factors = planScenarioModalFactors();
    if (Object.keys(factors).length) body.factors = factors;
    const data = await api(`/api/planning/projects/${form.dataset.projectId}/scenarios`, { method: 'POST', body });
    closeModalEl($('#planScenarioModal'));
    location.hash = `#planning/scenario/${data.scenario.id}`;
  } catch (err) { showMsg(msg, 'err', err.message); }
});
// Shared ✨ name suggestion: fills the Name input as an editable
// draft, never auto-saves. Errors (incl. the 503 no-LLM guidance)
// surface in msgEl and leave the field untouched.
async function planAiSuggestName(btn, inputEl, kind, context, msgEl) {
  if (!btn || !inputEl) return;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api('/api/planning/ai-suggest-name', { method: 'POST', body: { kind, context: context || {} } });
    if (r && r.name) { inputEl.value = r.name; inputEl.focus(); inputEl.select(); }
  } catch (err) { if (msgEl) showMsg(msgEl, 'err', err.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}
$('#planScenarioAiNameBtn').addEventListener('click', () => {
  const st = planScenarioModalState;
  planAiSuggestName($('#planScenarioAiNameBtn'), $('#planScenarioName'), 'scenario', { factors: planScenarioModalFactors(), category: st ? st.category : null }, $('#planScenarioModalMsg'));
});
// ---- Unified in-project AI panel ----
// The ONE design entry on the project page: scenario, baseline,
// strategy operations (the old strategy-page Describe panel, absorbed
// here), and strategy model. Thread per target, kept across turns;
// every output is a preview — only Apply writes. Report generation
// keeps its own separate button and is never folded in here.
// Panel threads reset on project reload (per-visit state, like the
// old modals); baseline/model server threads persist on their rows.
let planAiPanelCtx = null;
// Attachment queue for the panel (fill-chat pattern): files ride
// on the turn that includes them, never on the plain-lines
// historyText thread. Image chips carry a thumbnail preview.
let planAiPanelQueue = [];
function planAiPanelRenderQueue() {
  const host = $('#planAiPanelQueue');
  if (!host) return;
  host.classList.toggle('hidden', !planAiPanelQueue.length);
  host.innerHTML = planAiPanelQueue.map((q, i) => {
    const thumb = q.thumb ? `<img src="${q.thumb}" alt="">` : '';
    return `<span class="file-chip">${thumb}<span class="chip-name">${esc(q.file.name || 'attachment')}</span><button type="button" data-plan-ai-panel-queue-remove="${i}" title="Remove">×</button></span>`;
  }).join('');
}
function planAiPanelQueueFiles(list) {
  for (const f of list || []) planAiPanelQueue.push({ file: f, thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
  planAiPanelRenderQueue();
}
function planAiPanelClearQueue() {
  for (const q of planAiPanelQueue) if (q.thumb) URL.revokeObjectURL(q.thumb);
  planAiPanelQueue = [];
  planAiPanelRenderQueue();
  const fi = $('#planAiPanelFiles');
  if (fi) fi.value = '';
}
async function planAiPanelSerializeQueue() {
  return Promise.all(planAiPanelQueue.map((q) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: q.file.name, type: q.file.type, data: String(reader.result).split(',')[1] || '' });
    reader.onerror = reject;
    reader.readAsDataURL(q.file);
  })));
}
function planAiPanelRenderThread() {
  const el = $('#planAiPanelThread');
  if (!el || !planAiPanelCtx) return;
  const turns = planAiPanelCtx.threads[planAiPanelCtx.target] || [];
  if (!turns.length) { el.innerHTML = ''; return; }
  const labels = {};
  el.innerHTML = turns.map((t) => {
    if (t.role === 'ai' && t.questions) {
      for (const q of t.questions) if (q.field) labels[q.field] = q.label;
      return t.questions.map((q) => `<div class="plan-row"><span>AI: ${esc(q.label)}</span></div>`).join('');
    }
    if (t.role === 'ai') return `<div class="plan-row"><span>AI: ${esc(t.summary || '')}</span></div>`;
    if (t.answers) return Object.entries(t.answers).map(([k, v]) => `<div class="plan-row"><span>You: ${labels[k] ? `${esc(labels[k])}: ` : ''}${esc(String(v))}</span></div>`).join('');
    const filesLine = t.files && t.files.length ? ` · Attachments: ${esc(t.files.join(', '))}` : '';
    return `<div class="plan-row"><span>You: ${esc(t.text || '')}${filesLine}</span></div>`;
  }).join('');
}
// Plain-lines conversation context for the scenario/describe
// endpoints (their turns are free text, not the structured ask shape
// the baseline/model endpoints take).
function planAiPanelHistoryText() {
  if (!planAiPanelCtx) return '';
  const turns = planAiPanelCtx.threads[planAiPanelCtx.target] || [];
  return turns.map((t) => {
    if (t.role === 'ai' && t.questions) return t.questions.map((q) => `AI: ${q.label}`).join('\n');
    if (t.role === 'ai') return `AI: ${t.summary || ''}`;
    if (t.answers) return Object.entries(t.answers).map(([k, v]) => `You: ${k}: ${v}`).join('\n');
    return `You: ${t.text || ''}`;
  }).join('\n');
}
function planAiPanelSetTarget(target) {
  const ctx = planAiPanelCtx;
  if (!ctx) return;
  ctx.target = target;
  document.querySelectorAll('[data-plan-ai-target]').forEach((b) => {
    const on = b.dataset.planAiTarget === target;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('primary', on);
  });
  $('#planAiPanelStrategyRow').classList.toggle('hidden', target !== 'ops');
  $('#planAiPanelAsk').innerHTML = '';
  $('#planAiPanelOut').innerHTML = '';
  showMsg($('#planAiPanelMsg'), '', '');
  planAiPanelRenderThread();
}
function planAiPanelRefreshStrategies(selectedId) {
  const sel = $('#planAiPanelStrategy');
  if (!sel) return;
  const strategies = (planProjectData && planProjectData.strategies) || [];
  const cur = selectedId != null ? String(selectedId) : sel.value;
  sel.innerHTML = `<option value="new">New strategy…</option>` + strategies.map((s) => `<option value="${s.id}"${String(s.id) === String(cur) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
}
function planAiPanelWire(p) {
  planAiPanelCtx = { projectId: p.id, target: 'scenario', threads: { scenario: [], ops: [] }, pending: null };
  const panel = $('#planAiPanel');
  const toggle = $('#planAiPanelToggleBtn');
  if (toggle) toggle.addEventListener('click', () => panel.classList.toggle('hidden'));
  const close = $('#planAiPanelCloseBtn');
  if (close) close.addEventListener('click', () => panel.classList.add('hidden'));
  document.querySelectorAll('[data-plan-ai-target]').forEach((b) => b.addEventListener('click', () => planAiPanelSetTarget(b.dataset.planAiTarget)));
  $('#planAiPanelGoBtn').addEventListener('click', () => planAiPanelPropose());
  const fileInput = $('#planAiPanelFiles');
  if (fileInput) fileInput.addEventListener('change', () => { planAiPanelQueueFiles(fileInput.files); fileInput.value = ''; });
  const queueHost = $('#planAiPanelQueue');
  if (queueHost) queueHost.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plan-ai-panel-queue-remove]');
    if (!btn) return;
    const q = planAiPanelQueue[Number(btn.dataset.planAiPanelQueueRemove)];
    if (q && q.thumb) URL.revokeObjectURL(q.thumb);
    planAiPanelQueue.splice(Number(btn.dataset.planAiPanelQueueRemove), 1);
    planAiPanelRenderQueue();
  });
  // Paste: a clipboard carrying files joins the queue instead of
  // pasting; a clipboard without files is left alone and pastes
  // as text (same rule as the costs chat).
  const ta = $('#planAiPanelText');
  if (ta) ta.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length) return;
    e.preventDefault();
    planAiPanelQueueFiles(files);
  });
  const modelSel = $('#planAiPanelModel');
  if (modelSel) loadAiConfig().then((cfg) => {
    const models = cfg.models && cfg.models.length ? cfg.models : (cfg.model ? [cfg.model] : []);
    modelSel.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (cfg.model) modelSel.value = cfg.model;
  });
  planAiPanelRenderQueue();
  planAiPanelRefreshStrategies(null);
  planAiPanelSetTarget('scenario');
}
async function planAiPanelPropose() {
  const ctx = planAiPanelCtx;
  if (!ctx) return;
  const msg = $('#planAiPanelMsg');
  const text = $('#planAiPanelText').value.trim();
  if (!text) { showMsg(msg, 'err', 'Describe what you want first'); return; }
  // History BEFORE this turn: the request carries the new text itself.
  const historyText = planAiPanelHistoryText();
  let files;
  try {
    files = await planAiPanelSerializeQueue();
  } catch (err) { showMsg(msg, 'err', err.message); return; }
  const modelSel = $('#planAiPanelModel');
  const model = modelSel ? modelSel.value : '';
  ctx.threads[ctx.target].push({ role: 'user', text, files: planAiPanelQueue.map((q) => q.file.name || 'attachment') });
  planAiPanelRenderThread();
  try {
    if (ctx.target === 'scenario') await planAiPanelProposeScenario(text, historyText, files, model);
    else await planAiPanelProposeOps(text, historyText, files, model);
    // Success clears the input + queue, like fill-chat; a failed
    // send keeps both so the user can retry.
    $('#planAiPanelText').value = '';
    planAiPanelClearQueue();
    if (model && aiConfigCache) aiConfigCache.model = model;
  } catch (err) { showMsg(msg, 'err', err.message); }
}
async function planAiPanelProposeScenario(text, historyText, files, model) {
  const ctx = planAiPanelCtx; const msg = $('#planAiPanelMsg'); const out = $('#planAiPanelOut');
  const body = { text, historyText };
  if (files && files.length) body.files = files;
  if (model) body.model = model;
  const r = await api(`/api/planning/projects/${ctx.projectId}/scenarios/ai-design`, { method: 'POST', body });
  ctx.pending = { kind: 'scenario', factors: r.factors };
  const line = planScenarioSummaryLine(r.factors) || 'Flat world';
  ctx.threads.scenario.push({ role: 'ai', summary: line });
  planAiPanelRenderThread();
  // Naming is automatic (user 2026-11-04): no name input in the
  // panel — the design carries the proposed name, shown here as an
  // editable draft; a missing name falls back to "AI scenario".
  // Send is never blocked on a name.
  const draftName = (r.name && String(r.name).trim()) || 'AI scenario';
  out.innerHTML = `<div class="n">${esc(line)}</div><div><label>Name</label><input id="planAiPanelPreviewName" value="${esc(draftName)}"></div><div class="toolbar"><button class="small primary" id="planAiPanelApplyBtn">Create this scenario</button></div>`;
  $('#planAiPanelApplyBtn').addEventListener('click', async () => {
    try {
      const nameEl = $('#planAiPanelPreviewName');
      const name = (nameEl ? nameEl.value.trim() : '') || 'AI scenario';
      const data = await api(`/api/planning/projects/${ctx.projectId}/scenarios`, { method: 'POST', body: { name, factors: ctx.pending.factors, source: 'ai' } });
      location.hash = `#planning/scenario/${data.scenario.id}`;
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
}
async function planAiPanelEnsureStrategy() {
  const ctx = planAiPanelCtx;
  const sel = $('#planAiPanelStrategy');
  if (sel && sel.value && sel.value !== 'new') return { id: Number(sel.value), isNew: false };
  // No name input in the panel: a new strategy is created under the
  // plain fallback and renamed at Apply to the AI-proposed (possibly
  // edited) preview name. The per-strategy describe endpoint needs
  // an id before it can propose ops, so creation cannot wait for the
  // design the way the scenario flow can.
  const s = await api(`/api/planning/projects/${ctx.projectId}/strategies`, { method: 'POST', body: { name: 'AI strategy', source: 'ai' } });
  // Keep the picker's source fresh: planProjectData is the page-load
  // snapshot, so the just-created strategy would otherwise vanish
  // from the picker and a follow-up would create a duplicate.
  if (planProjectData && Array.isArray(planProjectData.strategies)) planProjectData.strategies.push(s.strategy);
  planAiPanelRefreshStrategies(s.strategy.id);
  return { id: s.strategy.id, isNew: true };
}
async function planAiPanelProposeOps(text, historyText, files, model) {
  const ctx = planAiPanelCtx; const msg = $('#planAiPanelMsg'); const out = $('#planAiPanelOut');
  const ensured = await planAiPanelEnsureStrategy();
  const sid = ensured.id;
  const isNew = ensured.isNew;
  const body = { text, historyText };
  if (files && files.length) body.files = files;
  if (model) body.model = model;
  const r = await api(`/api/planning/strategies/${sid}/ai-describe`, { method: 'POST', body });
  ctx.pending = { kind: 'ops', strategyId: sid, ops: r.ops };
  ctx.threads.ops.push({ role: 'ai', summary: r.ops.length ? r.ops.map((o) => o.op_type).join(', ') : 'No operations proposed.' });
  planAiPanelRenderThread();
  let html = '';
  if (r.unresolved && r.unresolved.length) html += `<div class="msg warn">Could not resolve: ${esc(r.unresolved.map((u) => u.reason).join('; '))}</div>`;
  if (r.warnings && r.warnings.length) html += `<div class="msg warn">${esc(r.warnings.join('; '))}</div>`;
  html += r.ops.map((o) => `<div class="plan-row"><span>${esc(o.op_type)} · ${esc(JSON.stringify(o.params))}</span></div>`).join('');
  // Automatic naming: the design's proposed name as an editable
  // draft (fallback "AI strategy"); Apply renames the strategy
  // created at Send, then posts the ops.
  const draftName = (r.name && String(r.name).trim()) || 'AI strategy';
  html += `<div><label>Name</label><input id="planAiPanelPreviewName" value="${esc(draftName)}"></div>`;
  html += `<div class="toolbar"><button class="small primary" id="planAiPanelApplyBtn">Apply these operations</button></div>`;
  out.innerHTML = html || '<div class="note">No operations proposed.</div>';
  const applyBtn = $('#planAiPanelApplyBtn');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    try {
      const nameEl = $('#planAiPanelPreviewName');
      const name = (nameEl ? nameEl.value.trim() : '') || 'AI strategy';
      if (isNew) await api(`/api/planning/strategies/${sid}`, { method: 'PUT', body: { name } });
      for (const o of ctx.pending.ops) await api(`/api/planning/strategies/${sid}/ops`, { method: 'POST', body: { op_type: o.op_type, params: o.params, legs: o.legs || [], source: 'ai' } });
      loadPlanProject(ctx.projectId);
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
}
let planBaselineEditCtx = null;
function openPlanBaselineEditModal(projectId, baselineId) {
  api(`/api/planning/projects/${projectId}`).then((d) => {
    const row = (d.project.baselines || []).find((b) => b.id === baselineId);
    if (!row) { showMsg($('#planProjectMsg'), 'err', 'baseline not found'); return; }
    planBaselineEditCtx = { projectId, baselineId, definition: row.definition || {} };
    $('#planBaselineEditTitle').textContent = `Edit baseline · ${row.name}`;
    $('#planBaselineEditName').value = row.name;
    $('#planBaselineEditDesc').value = (row.definition || {}).description || '';
    showMsg($('#planBaselineEditMsg'), '', '');
    openModal('planBaselineEditModal');
  }).catch((err) => showMsg($('#planProjectMsg'), 'err', err.message));
}
$('#planBaselineEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ctx = planBaselineEditCtx;
  if (!ctx) return;
  const msg = $('#planBaselineEditMsg');
  try {
    // Name + description only: the stored definition is otherwise
    // verbatim — a baseline carries no factors and no prime path.
    const def = { ...ctx.definition };
    def.description = $('#planBaselineEditDesc').value.trim();
    await api(`/api/planning/projects/${ctx.projectId}/baselines/${ctx.baselineId}`, { method: 'PUT', body: { name: $('#planBaselineEditName').value.trim(), definition: def } });
    closeModalEl($('#planBaselineEditModal'));
    loadPlanProject(ctx.projectId);
  } catch (err) { showMsg(msg, 'err', err.message); }
});
// One-line summary of a scenario's world factors. Empty = a flat world
// (current rates/terms throughout). The buy list is NOT part of this
// line: it lives on the strategy, not the world.
function planScenarioSummaryLine(factors) {
  const f = factors && typeof factors === 'object' ? factors : {};
  // A disabled factor (enabled === false — unchecked in the editor,
  // values kept) follows the default world and says nothing here.
  const on = (k) => !(f[k] && f[k].enabled === false);
  const parts = [];
  if (on('prime') && f.prime && Array.isArray(f.prime.points) && f.prime.points.length) {
    const last = f.prime.points[f.prime.points.length - 1];
    parts.push(`Prime → ${last.rate}% by ${last.month}`);
  } else if (on('prime') && f.prime && f.prime.preset === 'flat') {
    parts.push('Prime: flat at current');
  }
  if (on('stock') && f.stock && f.stock.valuePct != null) {
    parts.push(`Stock ${f.stock.valuePct}%/yr${f.stock.basis ? ` (${f.stock.basis}${f.stock.window ? ` · ${f.stock.window}` : ''})` : ''}`);
  }
  const bhCount = on('stock') && f.stock && f.stock.byHolding && typeof f.stock.byHolding === 'object' ? Object.keys(f.stock.byHolding).length : 0;
  if (bhCount) parts.push(`Stock: ${bhCount} holding override${bhCount === 1 ? '' : 's'}`);
  if (on('propertyGrowth') && f.propertyGrowth && f.propertyGrowth.valuePct != null) parts.push(`Property +${f.propertyGrowth.valuePct}%/yr`);
  if (on('salaryGrowth') && f.salaryGrowth && f.salaryGrowth.valuePct != null) parts.push(`Salary +${f.salaryGrowth.valuePct}%/yr`);
  if (on('rentGrowth') && f.rentGrowth && f.rentGrowth.valuePct != null) parts.push(`Rent +${f.rentGrowth.valuePct}%/yr`);
  return parts.join(' · ');
}
// One-line buy summary for a strategy card (the buy list IS the
// sink since 2026-11-05): the bought symbols, or a prompt for a
// pool strategy with no buys yet.
function planSinkLine(buys, isInvestment) {
  if (buys && buys.length) return `Buys: ${buys.join(' · ')}`;
  if (isInvestment) return 'No buys yet';
  return '';
}
function planStrategyCardsRender(rows, projectId) {
  // Cards show figures under the FIRST selected scenario only (the
  // picked world is shown by the Scenarios tier's Selected state).
  // Rows without a comparison (the re-pick
  // state) render name-only — never figures from another world.
  $('#planStrategyCards').innerHTML = rows.map((r) => {
    let tp = {};
    try { tp = typeof r.strategy.template_params === 'string' ? JSON.parse(r.strategy.template_params) : (r.strategy.template_params || {}); } catch { tp = {}; }
    const isInvestment = planProjectData && planProjectData.project && planProjectData.project.category === 'investment';
    const sinkLine = planSinkLine(r.buys, isInvestment);
    const legacySinkLine = !(r.buys && r.buys.length) && tp.source && tp.sink ? `<div class="n">Source: ${esc(tp.source === 'pot' ? 'cash pot' : tp.source)} → Buys: ${esc(tp.sinkLabel || tp.sink)}</div>` : '';
    return `
    <div class="card breakdown-card plan-flow-card" data-plan-strategy="${r.strategy.id}" style="cursor:pointer">
      <div class="k">${esc(r.strategy.letter)} · ${esc(r.strategy.name)}${r.strategy.merged ? ' · Merged' : ''}</div>
      ${r.comparison ? `<div class="v">${planSigned(r.comparison.net)}</div>
      <div class="n">Cost ${planMoney(r.comparison.cost)} · Gain ${planMoney(r.comparison.gain)} · Stock gain ${planMoney(r.comparison.stockGain)} · ${r.opCount ?? 0} ops</div>` : ''}
      ${sinkLine ? `<div class="n">${esc(sinkLine)}</div>` : ''}
      ${legacySinkLine}
      <div class="toolbar"><button class="small plan-flow-select" data-plan-strategy-select="${r.strategy.id}" aria-pressed="${planWiringStrategyPicked(r.strategy.id) ? 'true' : 'false'}">${planWiringStrategyPicked(r.strategy.id) ? '✓ Selected' : 'Select'}</button></div>
    </div>`;
  }).join('') || '<div class="note">No strategies yet.</div>';
  document.querySelectorAll('[data-plan-strategy]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = `#planning/strategy/${el.dataset.planStrategy}`; });
  });
  document.querySelectorAll('[data-plan-strategy-select]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); planWiringSelectStrategy(Number(b.dataset.planStrategySelect)); });
  });
}
async function loadPlanStrategyCards(projectId) {
  const scenarios = (planProjectData && planProjectData.scenarios) || [];
  // Picker default: the base scenario pre-checked — a visible default
  // the user can change, not a silent fallback. No scenarios = the flat
  // world. (Wiring scenario selection lives on the scenario cards;
  // there is no scenario picker on the project page anymore.)
  if (planCompareScenarioIds === null) {
    const base = scenarios.find((x) => x.is_base) || scenarios[0];
    planCompareScenarioIds = base ? [base.id] : [];
  }
  // PINNED-INPUT RULE: scenarios exist but none picked = a re-pick
  // panel only. No card figures — nothing renders under a world the
  // user did not pick. (Unreachable via UI since wiring is
  // single-select, but kept defensively.) The picked world is shown
  // by the Scenarios tier's Selected state — no "Under …" note line
  // in the mid-tier (user 2026-11-04: tiny and weird, removed).
  if (scenarios.length && !planCompareScenarioIds.length) {
    planStrategyCardsRender((planProjectData.strategies || []).map((st) => ({ strategy: st, comparison: null, buys: [] })), projectId);
    planWiringRefresh();
    return;
  }
  const q = scenarios.length ? `?scenarioIds=${planCompareScenarioIds.join(',')}` : '';
  const data = await api(`/api/planning/projects/${projectId}/comparison${q}`);
  const blocks = data.scenarioBlocks && data.scenarioBlocks.length ? data.scenarioBlocks : [{ scenario: data.scenario, baseline: data.baseline, strategies: data.strategies, report: data.report }];
  const first = blocks[0];
  // Strategy cards carry the per-strategy figures under the picked
  // world; the comparison itself (table/chart) lives in reports only.
  planStrategyCardsRender(first.strategies, projectId);
  planWiringRefresh();
}
// Report scenario picker: base pre-checked (a visible default, not a
// silent fallback); no scenarios = the flat world, labeled as such.
function planReportScenarioPickerHtml(scenarios) {
  if (!scenarios.length) return '<div class="note">Current rates (no scenario)</div>';
  const base = scenarios.find((x) => x.is_base) || scenarios[0];
  return scenarios.map((sc) => `<label><input type="checkbox" value="${sc.id}"${base && sc.id === base.id ? ' checked' : ''}> ${esc(sc.name)}${sc.is_base ? ' (Default)' : ''}</label>`).join(' ');
}
function planReportPickedScenarios(hostSel) {
  return [...document.querySelectorAll(`${hostSel} input:checked`)].map((el) => Number(el.value));
}
// ---- AI report: generate → preview → save (nothing writes before Save) ----
// Fallback name for an AI report with no AI title and no typed
// name: the existing auto-name pattern on the first picked
// strategy, else a plain 'AI report'.
function planReportAiFallbackName(strategyIds) {
  const d = planProjectData || {};
  const first = (strategyIds || []).map((id) => (d.strategies || []).find((s) => s.id === id)).find(Boolean);
  return first ? `Report · ${first.letter} · ${first.name}` : 'AI report';
}
// ---- Follow up with AI, inline (user 2026-11-06) ----
// The per-tab button toggles an inline conversation panel below
// the tab bar — same pattern as the ✨ Fill with AI panels, no
// modal. Thread state lives per report in this map, NOT in the
// DOM: the sticky bar + viewer are rebuilt on every
// loadPlanReport, so the thread survives Applies and tab switches
// in memory for the session. No persistence across page reloads
// (v1): plan_reports has no ai_thread column.
const planFollowUpThreads = {};
function planFollowUpState(reportId) {
  if (!planFollowUpThreads[reportId]) planFollowUpThreads[reportId] = { open: false, turns: [], titles: [], titlesLoaded: false, busy: false };
  return planFollowUpThreads[reportId];
}
function planReportAiChartRowsHtml(charts) {
  return (charts || []).map((c) => `<div class="plan-row"><span>${esc(c.template)} · ${esc(c.title)}${c.series ? ` · ${(c.series || []).join(', ')}` : ''}${c.method ? ` · Method: ${esc(c.method)}` : ''}</span></div>`).join('') || '<div class="note">No charts proposed.</div>';
}
function planReportFollowUpHtml() {
  return `<div class="panel"><div class="section-head"><h3>Follow up with AI</h3><button class="small" data-followup-close>Close</button></div>
    <div id="planReportFollowUpThread"></div>
    <div><textarea id="planReportFollowUpText" rows="3" placeholder="e.g. Add a chart comparing payoff months"></textarea></div>
    <div class="toolbar"><button class="small primary" id="planReportFollowUpSendBtn">Send</button></div>
    <div class="msg" id="planReportFollowUpMsg"></div></div>`;
}
function planReportFollowUpRender(reportId) {
  const state = planFollowUpState(reportId);
  const threadEl = $('#planReportFollowUpThread');
  if (!threadEl) return;
  threadEl.innerHTML = state.turns.map((turn, i) => {
    const user = `<div class="plan-ai-turn plan-ai-turn-user"><div class="plan-ai-turn-who">You</div><div>${esc(turn.userText)}</div></div>`;
    let ai;
    if (turn.error) {
      ai = `<div class="plan-ai-turn plan-ai-turn-ai"><div class="plan-ai-turn-who">AI</div><div class="note">${esc(turn.error)}</div></div>`;
    } else if (!Array.isArray(turn.charts)) {
      ai = `<div class="plan-ai-turn plan-ai-turn-ai"><div class="plan-ai-turn-who">AI</div><div class="note">Thinking…</div></div>`;
    } else {
      ai = `<div class="plan-ai-turn plan-ai-turn-ai"><div class="plan-ai-turn-who">AI</div>${planReportAiChartRowsHtml(turn.charts)}<div class="toolbar"><button class="small primary" data-ai-turn-apply="${i}"${turn.applied ? ' disabled' : ''}>${turn.applied ? 'Applied ✓' : 'Apply'}</button></div></div>`;
    }
    return user + ai;
  }).join('');
  threadEl.scrollTop = threadEl.scrollHeight;
}
function planReportFollowUpHistory(state) {
  const lines = [];
  if (state.titles.length) lines.push(`Charts already in this report: ${state.titles.join(', ')}`);
  for (const turn of state.turns) {
    if (turn.userText) lines.push(`You asked: ${turn.userText}`);
    if (turn.applied && Array.isArray(turn.charts)) {
      const titles = turn.charts.map((c) => c.title).filter(Boolean);
      if (titles.length) lines.push(`Added charts: ${titles.join(', ')}`);
    }
  }
  return lines.slice(0, 20);
}
function planReportFollowUpWire(projectId, reportId) {
  const sendBtn = $('#planReportFollowUpSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', () => planReportFollowUpTurn(projectId, reportId));
  const closeBtn = document.querySelector('[data-followup-close]');
  if (closeBtn) closeBtn.addEventListener('click', () => planReportFollowUpToggle(projectId, reportId));
  const threadEl = $('#planReportFollowUpThread');
  if (threadEl) threadEl.addEventListener('click', async (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-ai-turn-apply]') : null;
    if (!btn || btn.disabled) return;
    const state = planFollowUpState(reportId);
    const turn = state.turns[Number(btn.dataset.aiTurnApply)];
    if (!turn || turn.applied || !Array.isArray(turn.charts)) return;
    btn.disabled = true;
    try {
      const d = await api(`/api/planning/projects/${projectId}`);
      const rep = (d.reports || []).find((x) => x.id === reportId);
      if (!rep) throw new Error('report not found');
      const def = rep.definition || {};
      state.titles = (def.charts || []).map((c) => c.title).filter(Boolean);
      await api(`/api/planning/reports/${reportId}`, { method: 'PUT', body: { definition: { ...def, charts: [...(def.charts || []), ...turn.charts] } } });
      turn.applied = true;
      planReportFollowUpRender(reportId);
      loadPlanReport(projectId, reportId);
    } catch (err) {
      btn.disabled = false;
      showMsg($('#planReportFollowUpMsg'), 'err', err.message);
    }
  });
}
async function planReportFollowUpTurn(projectId, reportId) {
  const state = planFollowUpState(reportId);
  if (state.busy) return;
  const textEl = $('#planReportFollowUpText');
  const text = String(textEl ? textEl.value : '').trim();
  if (!text) { showMsg($('#planReportFollowUpMsg'), 'err', 'describe the report first'); return; }
  state.busy = true;
  const sendBtn = $('#planReportFollowUpSendBtn');
  if (sendBtn) sendBtn.disabled = true;
  const history = planReportFollowUpHistory(state);
  state.turns.push({ userText: text, charts: null, applied: false, error: null });
  if (textEl) textEl.value = '';
  planReportFollowUpRender(reportId);
  try {
    const r = await api(`/api/planning/projects/${projectId}/ai-report`, { method: 'POST', body: { text, history } });
    const turn = state.turns[state.turns.length - 1];
    turn.charts = (r.definition && r.definition.charts) || [];
    planReportFollowUpRender(reportId);
  } catch (err) {
    const turn = state.turns[state.turns.length - 1];
    turn.error = err.message;
    planReportFollowUpRender(reportId);
    showMsg($('#planReportFollowUpMsg'), 'err', err.message);
  } finally {
    state.busy = false;
    const btn = $('#planReportFollowUpSendBtn');
    if (btn) btn.disabled = false;
  }
}
function planReportFollowUpRestore(projectId, reportId) {
  const state = planFollowUpState(reportId);
  const host = $('#planReportFollowUp');
  if (!host) return;
  if (!state.open) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  host.classList.remove('hidden');
  host.innerHTML = planReportFollowUpHtml();
  planReportFollowUpWire(projectId, reportId);
  planReportFollowUpRender(reportId);
}
async function planReportFollowUpToggle(projectId, reportId) {
  const state = planFollowUpState(reportId);
  state.open = !state.open;
  planReportFollowUpRestore(projectId, reportId);
  // Load the report's current chart titles once per session, so
  // later turns know what is already in the report.
  if (state.open && !state.titlesLoaded) {
    try {
      const d = await api(`/api/planning/projects/${projectId}`);
      const rep = (d.reports || []).find((x) => x.id === reportId);
      state.titles = ((rep && rep.definition && rep.definition.charts) || []).map((c) => c.title).filter(Boolean);
      state.titlesLoaded = true;
    } catch { /* history falls back to turns-only */ }
  }
}


function openPlanReportAiModal(projectId, opts = {}) {
  // Create-only: this modal makes a NEW report. The follow-up flow
  // (append to the open report) is an inline conversation panel in
  // the report view, not a modal (user 2026-11-06).
  $('#planReportAiName').value = '';
  $('#planReportAiText').value = '';
  $('#planReportAiOut').innerHTML = '';
  showMsg($('#planReportAiMsg'), '', '');
  openModal('planReportAiModal');
  // Pin pickers live in their own .plan-ai-modal-card, so hiding the
  // card hides the whole section (head + picker).
  for (const id of ['planReportAiFixedBaseline', 'planReportAiScenarios', 'planReportAiStrategies']) {
    document.getElementById(id)?.closest('.plan-ai-modal-card')?.classList.remove('hidden');
  }
  // Baseline is FIXED, never picked: the modal shows the project's
  // fixed baseline as display text and pins its record (or null =
  // the do-nothing label when no record exists). Scenario picker
  // (pinned) + strategy picker (many) for this report.
  // opts.lockedStrategyIds (strategy-page tier): the picker shows
  // ONLY those strategies, pre-checked and disabled — creation from
  // the strategy page pins only that strategy. opts.default* apply
  // the calling page's picks when the wiring defaults are absent.
  let aiReportScenarios = [];
  let aiReportFixedBaselineId = null;
  api(`/api/planning/projects/${projectId}`).then((d) => {
    const fb = d.project && d.project.fixedBaseline ? d.project.fixedBaseline : null;
    aiReportFixedBaselineId = fb ? fb.recordId : null;
    $('#planReportAiFixedBaseline').textContent = fb ? fb.name : 'Do-nothing baseline';
    const strs = d.strategies || [];
    aiReportScenarios = d.scenarios || [];
    $('#planReportAiScenarios').innerHTML = planReportScenarioPickerHtml(aiReportScenarios);
    const defScens = opts.defaultScenarioIds != null ? opts.defaultScenarioIds : (planWiringScenarioId() != null ? [planWiringScenarioId()] : null);
    if (defScens != null) { document.querySelectorAll('#planReportAiScenarios input').forEach((el) => { el.checked = defScens.includes(Number(el.value)); }); }
    const locked = opts.lockedStrategyIds || null;
    const shown = locked ? strs.filter((x) => locked.includes(x.id)) : strs;
    $('#planReportAiStrategies').innerHTML = shown.map((x) => `<label><input type="checkbox" value="${x.id}" checked${locked ? ' disabled' : ''}> ${esc(x.letter)} · ${esc(x.name)}</label>`).join('') || '<div class="note">No strategies yet.</div>';
  }).catch(() => { /* pickers stay empty; save falls back to project base */ });
  $('#planReportAiGenBtn').onclick = async () => {
    const msg = $('#planReportAiMsg');
    try {
      const text = $('#planReportAiText').value.trim();
      if (!text) throw new Error('describe the report first');
      // Fail fast on a strategy-less project (a report with no
      // strategy compares nothing): plain message before the AI call.
      const preStrategyIds = [...document.querySelectorAll('#planReportAiStrategies input:checked')].map((el) => Number(el.value));
      if (!preStrategyIds.length) throw new Error('Pin at least one strategy first');
      const r = await api(`/api/planning/projects/${projectId}/ai-report`, { method: 'POST', body: { text } });
      const charts = (r.definition && r.definition.charts) || [];
      // AI title: the model is asked for a short report title; when
      // the name field is still empty it is prefilled from the AI
      // title (the user can still overwrite it before saving).
      if (!$('#planReportAiName').value.trim() && typeof r.definition.title === 'string' && r.definition.title.trim()) {
        $('#planReportAiName').value = r.definition.title.trim();
      }
      $('#planReportAiOut').innerHTML = `
        ${planReportAiChartRowsHtml(charts)}
        <div class="toolbar"><button class="small primary" id="planReportAiSaveBtn">Save this report</button></div>`;
      $('#planReportAiSaveBtn').onclick = async () => {
        try {
          const baselineId = aiReportFixedBaselineId;
          const scenarioIds = planReportPickedScenarios('#planReportAiScenarios');
          if (aiReportScenarios.length && !scenarioIds.length) throw new Error('Pin at least one scenario first');
          const strategyIds = [...document.querySelectorAll('#planReportAiStrategies input:checked')].map((el) => Number(el.value));
          // A report with no strategy compares nothing (a project
          // with no strategy has no report to generate): plain
          // message, same wording as the scenario guard above.
          if (!strategyIds.length) throw new Error('Pin at least one strategy first');
          // Name chain: typed name → AI title → auto-name pattern.
          const aiTitle = (r.definition && typeof r.definition.title === 'string' && r.definition.title.trim()) ? r.definition.title.trim() : '';
          const name = $('#planReportAiName').value.trim() || aiTitle || planReportAiFallbackName(strategyIds);
          const saved = await api(`/api/planning/projects/${projectId}/reports`, { method: 'POST', body: { name, definition: r.definition, baseline_id: baselineId, strategy_ids: strategyIds, scenario_ids: scenarioIds } });
          closeModalEl($('#planReportAiModal'));
          // Strategy-page tier stays on its page and opens the new
          // tab there; the project page keeps its old behavior.
          if (opts.afterSave) await opts.afterSave(saved.report && saved.report.id);
          else loadPlanProject(projectId);
        } catch (err) { showMsg(msg, 'err', err.message); }
      };
    } catch (err) { showMsg(msg, 'err', err.message); }
  };
}

// ---- report view: charts + tables + how each figure is calculated ----
const PLAN_REPORT_SERIES_LABEL = {
  mortgage_balance: 'Mortgage balance', stock_value: 'Stock value', total_value: 'Total value', pool_balance: 'Cash pool balance',
  cost: 'Total cost', gain: 'Total gain', net: 'Net benefit', stock_gain: 'Stock gain',
  payoff_month: 'Payoff shift (months)', monthly_payment: 'Monthly payment Δ',
};
const PLAN_REPORT_DEFS_PROPERTY = 'Cost = fees + penalty + cash out. Gain = interest saved vs baseline + asset growth under assumptions. Net = gain − cost. Extra cash is cost; the interest it saves is gain — no double count. Baseline is the same project with no operations; every strategy is measured against it.';
const PLAN_REPORT_DEFS_POOL = 'Cost = fees + cash out (new cash only — a buy funded by selling the pool is a swap, not new cash). Gain = asset growth vs the baseline trajectory (same return assumption, no ops). Net = gain − cost. New cash put in is cost; the growth it earns is gain — no double count. Baseline is the same project with no operations; every strategy is measured against it.';
const PLAN_REPORT_HOW = {
  mortgage_balance: 'Mortgage balance = outstanding principal by month from the engine projection, summed across properties. Baseline and strategies price the variable rate off the same prime history: actual observations plus the scenario steps.',
  stock_value: 'Stock value = units × last price at or before the month (last price carried forward, never invented). The cash pot is included only at the horizon month.',
  total_value: 'Total value = property equity + stock value. Equity = assessed value − outstanding principal; assessed value is the current roll, held flat across months.',
  pool_balance: 'Cash pool balance = the strategy cash pot by month: sell proceeds parked in the pot, less pot-funded buys. The baseline pot starts at the pool\'s external cash, if any, and never moves (the baseline runs no operations).',
  cost: 'Cost = fees + penalty + cash out (prepay cash + buy cash). Penalty is an estimate; the bank quote governs.',
  gain: 'Gain = interest saved vs baseline + stock growth vs the baseline trajectory (same return assumption, no ops). A do-nothing strategy books no gain. Property-category strategies exclude stock gain from gain (shown separately as Stock gain).',
  net: 'Net = gain − cost. Extra cash is cost; the interest it saves is gain — no double count.',
  payoff_month: 'Payoff shift = baseline payoff month − strategy payoff month, in months (positive = earlier).',
  monthly_payment: 'Monthly payment Δ = strategy payment at effect − baseline payment at effect, summed across properties.',
};
const PLAN_REPORT_HOW_POOL = {
  cost: 'Cost = fees + cash out (new cash only — a buy funded by selling the pool is a swap, not new cash).',
  gain: 'Gain = stock growth vs the baseline trajectory (same return assumption, no ops). A do-nothing strategy books no gain.',
  net: 'Net = gain − cost. New cash put in is cost; the growth it earns is gain — no double count.',
};
const planReportHowFor = (series, scopeAddress, investmentScope) => [...new Set(series || [])].map((s) => {
  // Pool reports: the mortgage-worded cost/gain/net lines are false
  // here (no interest saved, no penalty) — the pool wording replaces
  // them; every other series keeps the shared line.
  if (investmentScope && PLAN_REPORT_HOW_POOL[s]) return PLAN_REPORT_HOW_POOL[s];
  let t = PLAN_REPORT_HOW[s];
  // Entity scope (user rule 2026-11-04): a property project's figures
  // cover its entity property only — the "summed across properties"
  // wording is false there, so name the property instead. Other
  // projects keep the summed wording (their behavior is unchanged).
  if (t && scopeAddress) t = t.replace('summed across properties', `for ${scopeAddress}`);
  // Investment scope: trajectory totals are pool + stocks, never
  // property equity — the generic total sentence is false there.
  if (t && investmentScope && s === 'total_value') t = 'Total value = cash pool balance + stock value (investment scope — property equity is not included).';
  return t;
}).filter(Boolean).join(' ');
function planReportYearRows(monthly) {
  // Year-end snapshot rows: each December plus the final month.
  const rows = [];
  for (let i = 0; i < monthly.length; i++) {
    const m = monthly[i].month;
    if (m.slice(5, 7) === '12' || i === monthly.length - 1) rows.push(monthly[i]);
  }
  return rows;
}
// Scenario pin panel for a report: legacy rows (saved before pinning)
// and rows whose pinned scenario was deleted never render numbers
// under a substituted world — the user picks the worlds first.
function planReportPinPanel(proj, report, note) {
  const scenarios = proj.scenarios || [];
  const base = scenarios.find((x) => x.is_base) || scenarios[0];
  planReportTabsOpen(proj.project.id, report.id, report.name);
  planReportCurrentId = report.id;
  planReportCurrentPins = null;
  $('#planReport').innerHTML = `
    <div class="panel">
      <div class="section-head"><h3>${esc(report.name)}</h3></div>
      <div class="note">${esc(note)}</div>
      <div><label>Scenarios (pinned)</label><div id="planReportPinScenarios">${scenarios.map((sc) => `<label><input type="checkbox" value="${sc.id}"${base && sc.id === base.id ? ' checked' : ''}> ${esc(sc.name)}${sc.is_base ? ' (Default)' : ''}</label>`).join(' ')}</div></div>
      <div class="toolbar"><button class="small primary" id="planReportPinBtn">Use these scenarios</button></div>
      <div class="msg" id="planReportPinMsg"></div>
    </div>`;
  $('#planReportPinBtn').addEventListener('click', async () => {
    try {
      const ids = [...document.querySelectorAll('#planReportPinScenarios input:checked')].map((el) => Number(el.value));
      if (!ids.length) throw new Error('Pin at least one scenario first');
      await api(`/api/planning/reports/${report.id}`, { method: 'PUT', body: { scenario_ids: ids } });
      loadPlanReport(proj.project.id, report.id);
    } catch (err) { showMsg($('#planReportPinMsg'), 'err', err.message); }
  });
  planReportOutlineClear();
  planReportViewSync(proj.project.id, report.id);
}

// Report tabs: per-visit, in-memory only (never persisted, and
// closing one never deletes its report). Opening a report adds a
// tab; switching tabs loses nothing; closing the current tab falls
// back to the most recently opened tab, else the viewer empties.
// BROWSER MODE: the Reports tier has two states, driven by the tab
// list alone. LIST (no tabs open): the report cards show, the tab
// host is empty, the viewer is empty. OPEN (tabs open): the cards
// hide, the tab bar sits at the TOP of the tier (host above the
// viewer) with a ← All reports back control, and the viewer fills
// the tier. The current tab's pinned scenario / baseline /
// strategies highlight on the real tier cards above (amber
// plan-report-pin, distinct from the wiring Selected blue); with
// no tab open, no report-highlight shows. Old #planning/report/...
// deep links land on the project page with that report's tab open
// (see route() + planOpenReportTab) — i.e. straight into OPEN.
let planReportTabs = [];
let planReportTabsProject = null;
let planReportCurrentId = null;
let planReportCurrentPins = null;
let planReportPendingOpen = null;
// Monotonic load generation: a tab close (or project re-render)
// invalidates any loadPlanReport still in flight, so a stale fetch
// can never resurrect a closed tab or overwrite a newer tab.
let planReportLoadSeq = 0;
function planOpenReportTab(projectId, reportId) {
  if (planProjectData && planProjectData.project && planProjectData.project.id === projectId
    && location.hash === `#planning/project/${projectId}`) {
    loadPlanReport(projectId, reportId);
  } else if (planStrategyData && planStrategyData.project && planStrategyData.project.id === projectId
    && location.hash === `#planning/strategy/${planStrategyData.strategy.id}`) {
    // Strategy-page tier: open the tab in place — never navigate
    // away to the project page. The viewer functions resolve their
    // tier ids to the strategy page's tier (the project tier DOM is
    // cleared while a strategy page is shown).
    loadPlanReport(projectId, reportId);
  } else {
    planReportPendingOpen = { projectId, reportId };
    location.hash = `#planning/project/${projectId}`;
  }
}
function planReportHighlightApply() {
  document.querySelectorAll('.plan-report-pin').forEach((el) => el.classList.remove('plan-report-pin'));
  const pins = planReportCurrentPins;
  if (!pins) return;
  for (const id of pins.scenarioIds) { const c = document.querySelector(`[data-plan-scenario="${id}"]`); if (c) c.classList.add('plan-report-pin'); }
  if (!pins.scenarioIds.length) { const f = document.querySelector('#planFlowFlatNode'); if (f) f.classList.add('plan-report-pin'); }
  if (pins.baselineId != null) { const c = document.querySelector(`[data-plan-baseline="${pins.baselineId}"]`); if (c) c.classList.add('plan-report-pin'); }
  for (const id of pins.strategyIds) { const c = document.querySelector(`[data-plan-strategy="${id}"]`); if (c) c.classList.add('plan-report-pin'); }
}
function planReportTabBarHtml(projectId, currentId) {
  if (!planReportTabs.length) return '';
  return `<div class="toolbar plan-report-tabs" id="planReportTabsBar">${planReportTabs.map((t) => `<span class="plan-report-tabwrap${t.id === currentId ? ' plan-report-tabwrap-current' : ''}"><button class="small plan-report-tab-name" data-plan-report-tab="${t.id}">${esc(t.name)}</button><button class="small plan-report-tab-close" data-plan-report-tab-close="${t.id}" aria-label="Close tab">×</button></span>`).join('')}</div>`;
}
function planReportTabsWire(projectId, currentId) {
  document.querySelectorAll('[data-plan-report-tab]').forEach((b) => b.addEventListener('click', () => { loadPlanReport(projectId, Number(b.dataset.planReportTab)); }));
  document.querySelectorAll('[data-plan-report-tab-close]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.planReportTabClose);
    const wasCurrent = planReportCurrentId === id;
    planReportLoadSeq++;
    planReportTabs = planReportTabs.filter((t) => t.id !== id);
    if (!planReportTabs.length) {
      planReportCurrentId = null;
      planReportCurrentPins = null;
      const viewer = $('#planReport');
      if (viewer) viewer.innerHTML = '';
      planReportHighlightApply();
      planReportViewSync(projectId, null);
    } else if (wasCurrent) {
      loadPlanReport(projectId, planReportTabs[planReportTabs.length - 1].id);
    } else {
      planReportViewSync(projectId, currentId);
    }
  }));
}
// LIST/OPEN sync: the single place that renders the tab host and
// shows/hides the report cards. Callers set the viewer content (or
// empty it) and then sync; the bar lives in the host, never inside
// the viewer HTML, so a viewer re-render never duplicates it.
function planReportViewSync(projectId, currentId) {
  const host = $('#planReportTabsHost');
  const list = $('#planReportList');
  if (!host) return;
  if (!planReportTabs.length) {
    host.innerHTML = '';
    planReportOutlineClear();
    if (list) list.classList.remove('hidden');
    return;
  }
  if (list) list.classList.add('hidden');
  host.innerHTML = `<div id="planReportStickyBar"><div class="toolbar plan-report-tabs-host"><button class="small" id="planReportBackBtn">← All reports</button>${planReportTabBarHtml(projectId, currentId)}</div><div id="planReportTabActionsBar"></div></div><div id="planReportFollowUp" class="hidden"></div>`;
  $('#planReportBackBtn').addEventListener('click', () => {
    planReportLoadSeq++;
    planReportTabs = [];
    planReportCurrentId = null;
    planReportCurrentPins = null;
    const viewer = $('#planReport');
    if (viewer) viewer.innerHTML = '';
    planReportHighlightApply();
    planReportViewSync(projectId, null);
  });
  planReportTabsWire(projectId, currentId);
}
function planReportTabsOpen(projectId, reportId, name) {
  if (planReportTabsProject !== projectId) { planReportTabs = []; planReportTabsProject = projectId; }
  if (!planReportTabs.some((t) => t.id === reportId)) planReportTabs.push({ id: reportId, name });
}
// ------------------------------------------------- report outline --
// Floating outline nav for the OPEN report view, mirroring the
// property detail page's floating outline (.prop-outline styles
// reused as-is): translucent, fixed left, auto-hides ~2.5s after
// scrolling stops, reappears on scroll, hover/focus hold the
// countdown. Entries = one per definition.charts block (by title)
// plus the comparison panel when present. Clicking an entry jumps
// the block below the sticky header (app topbar 52px + sticky tab
// bar, measured live) — a plain scrollIntoView would land it under
// the sticky header, so the jump is a computed offset instead.
// Entries rebuild on every report render (tab switch, AI append,
// block delete all reload the viewer); every non-report viewer
// path clears it, and it never renders in LIST state.
let planReportOutlineTargets = [];
let planReportOutlineHideMs = 2500;
let planReportOutlineHideTimer = null;
const planReportOutlineHolds = new Set();
window.__fmReportOutline = { setHideDelay: (ms) => { planReportOutlineHideMs = ms; } };

function planReportOutlineArmHide() {
  clearTimeout(planReportOutlineHideTimer);
  planReportOutlineHideTimer = null;
  if (planReportOutlineHolds.size) return;
  planReportOutlineHideTimer = setTimeout(() => {
    planReportOutlineHideTimer = null;
    const nav = $('#planReportOutline');
    if (nav && !planReportOutlineHolds.size) nav.classList.remove('awake');
  }, planReportOutlineHideMs);
}
function planReportOutlineWake() {
  const nav = $('#planReportOutline');
  if (!nav || !planReportOutlineTargets.length) return;
  nav.classList.add('awake');
  planReportOutlineArmHide();
}
function planReportOutlineHold(reason, on) {
  if (on) {
    planReportOutlineHolds.add(reason);
    const nav = $('#planReportOutline');
    if (nav) nav.classList.add('awake');
  } else {
    planReportOutlineHolds.delete(reason);
  }
  planReportOutlineArmHide();
}
function planReportOutlineClear() {
  const list = $('#planReportOutlineList');
  if (list) list.innerHTML = '';
  planReportOutlineTargets = [];
  planReportOutlineHolds.clear();
  clearTimeout(planReportOutlineHideTimer);
  planReportOutlineHideTimer = null;
  const nav = $('#planReportOutline');
  if (nav) nav.classList.remove('awake', 'open');
}
function planReportOutlineSetActive(idx) {
  document.querySelectorAll('#planReportOutlineList a[data-idx]').forEach((a) =>
    a.classList.toggle('active', Number(a.dataset.idx) === idx));
}
function planReportOutlineOffset() {
  const bar = document.querySelector('#planReportStickyBar');
  const h = bar ? bar.getBoundingClientRect().height : 0;
  return 52 + h + 12;
}
function planReportOutlineSpy() {
  if (!planReportOutlineTargets.length) return;
  if ($('#planProject').classList.contains('hidden')) return;
  const LINE = planReportOutlineOffset();
  let current = 0;
  for (let i = 0; i < planReportOutlineTargets.length; i++) {
    if (planReportOutlineTargets[i].el.getBoundingClientRect().top <= LINE) current = i;
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
    current = planReportOutlineTargets.length - 1;
  }
  planReportOutlineSetActive(current);
}
function planReportOutlineJump(el) {
  const top = el.getBoundingClientRect().top + window.scrollY - planReportOutlineOffset();
  window.scrollTo({ top, behavior: 'smooth' });
}
function planReportOutlineClose() {
  const nav = $('#planReportOutline');
  if (!nav) return;
  nav.classList.remove('open');
  const t = $('#planReportOutlineToggle');
  if (t) t.setAttribute('aria-expanded', 'false');
  planReportOutlineHold('open', false);
}
function planReportOutlineBuild() {
  const list = $('#planReportOutlineList');
  if (!list) return;
  planReportOutlineClear();
  const add = (title, el) => {
    const idx = planReportOutlineTargets.length;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = title;
    a.dataset.idx = String(idx);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      planReportOutlineJump(el);
      planReportOutlineSetActive(idx);
      planReportOutlineClose();
    });
    li.appendChild(a);
    list.appendChild(li);
    planReportOutlineTargets.push({ el });
  };
  document.querySelectorAll('#planReport [data-plan-report-block]').forEach((wrap) => {
    const h3 = wrap.querySelector('.panel .section-head h3');
    add(h3 ? h3.textContent.trim() : 'Chart', wrap);
  });
  const cmp = document.querySelector('#planReportComparePanel');
  if (cmp) add('Strategy comparison', cmp);
  if (!planReportOutlineTargets.length) { planReportOutlineClear(); return; }
  planReportOutlineSpy();
}
const planReportOutlineNav = $('#planReportOutline');
if (planReportOutlineNav) {
  planReportOutlineNav.addEventListener('mouseenter', () => planReportOutlineHold('hover', true));
  planReportOutlineNav.addEventListener('mouseleave', () => planReportOutlineHold('hover', false));
  planReportOutlineNav.addEventListener('focusin', () => planReportOutlineHold('focus', true));
  planReportOutlineNav.addEventListener('focusout', (e) => {
    if (!planReportOutlineNav.contains(e.relatedTarget)) planReportOutlineHold('focus', false);
  });
}
const planReportOutlineToggle = $('#planReportOutlineToggle');
if (planReportOutlineToggle) planReportOutlineToggle.addEventListener('click', () => {
  const nav = $('#planReportOutline');
  const open = nav.classList.toggle('open');
  planReportOutlineToggle.setAttribute('aria-expanded', String(open));
  planReportOutlineHold('open', open);
});
document.addEventListener('click', (e) => {
  const nav = $('#planReportOutline');
  if (nav && nav.classList.contains('open') && !nav.contains(e.target)) planReportOutlineClose();
});
window.addEventListener('scroll', () => {
  planReportOutlineSpy();
  if (!$('#view-planning').classList.contains('hidden') && (!$('#planProject').classList.contains('hidden') || !$('#planStrategy').classList.contains('hidden')) && planReportOutlineTargets.length) planReportOutlineWake();
}, { passive: true });

// ------------------------------------------- report viewer: engine
// Report-view state for the current tab: the fetched comparison +
// report, the chip-selected strategy, the live (unsaved) variable
// values and the table's year page. Re-render functions read this,
// never the server, so chip clicks and variable typing never
// refetch. Apply (variables / AI refine) PUTs and reloads.
let planReportView = null;

// Client mirror of the server's reportPenaltyFor (src/planning.js):
// penalty variable for one strategy, default $0, ≥ 0.
function planReportPenaltyFor(vars, strategyId) {
  if (!vars || !vars.penalty) return 0;
  const v = vars.penalty[String(strategyId)];
  if (v == null || !isFinite(Number(v)) || Number(v) < 0) return 0;
  return Math.round(Number(v) * 100) / 100;
}

// Effective comparison for one strategy row under a set of report
// variables: (1) AI-engine scalars override the preset figures
// (only when the engine executed without errors); (2) the report's
// penalty variable replaces the engine penalty in cost
// (cost = cost − penaltyTotal + variable; net = gain − cost).
// Pure — the live headline and the saved render both use it.
// On a cash-pool report the penalty variable does not exist: a stale
// saved value is ignored (penalty 0), so cost is the engine cost.
function planReportEffectiveComparison(row, vars, isPool) {
  const eff = { ...(row.comparisonBase || row.comparison || {}) };
  const eng = row.engine;
  if (eng && !(eng.errors && eng.errors.length)) {
    for (const [k, v] of Object.entries(eng.scalars || {})) eff[k] = v;
  }
  const penalty = isPool ? 0 : planReportPenaltyFor(vars, row.strategy.id);
  const enginePenalty = Math.round((eff.penaltyTotal || 0) * 100) / 100;
  eff.penalty = penalty;
  eff.cost = Math.round(((eff.cost || 0) - enginePenalty + penalty) * 100) / 100;
  eff.net = Math.round(((eff.gain || 0) - eff.cost) * 100) / 100;
  return eff;
}

// Engine + variables overlay (items 2 + 4): mutates the comparison
// rows and trajectories in place so every section renders executed
// figures. row.comparisonBase keeps the preset figures for the live
// (unsaved-variable) recompute; row.comparison is the saved-variable
// view. AI-engine series override the strategy's trajectory monthly
// values, so charts and the Difference table show executed figures.
// A failed engine (errors non-empty) falls back to preset figures.
function planReportApplyOverlay(comp, report) {
  const vars = (report.definition && report.definition.variables) || null;
  const trajs = (comp.report && comp.report.trajectories) || [];
  // The penalty variable does not exist on a cash-pool report: a
  // stale saved value is ignored there (template keyed on the
  // baseline kind).
  const isPool = !!(comp.report && comp.report.investmentScope);
  for (const row of comp.strategies || []) {
    row.comparisonBase = { ...(row.comparison || {}) };
    row.comparison = planReportEffectiveComparison(row, vars, isPool);
    const eng = row.engine;
    if (eng && !(eng.errors && eng.errors.length) && eng.series) {
      const traj = trajs.find((t) => t.key === String(row.strategy.id));
      if (traj && traj.monthly) {
        for (const [sid, arr] of Object.entries(eng.series)) {
          if (!Array.isArray(arr)) continue;
          traj.monthly.forEach((r, i) => { if (i < arr.length && arr[i] != null) r[sid] = arr[i]; });
        }
      }
    }
  }
}

// Per-baseline-kind report templates (user 2026-11-05): a report
// renders the template of its BASELINE kind — property and cash-pool
// reports no longer share one merged template with piecemeal
// kind-gates inside it (that merge is what let the "Monthly payment
// breakdown" heading leak into an investment report while its chart
// correctly hid). Each template declares its sections, in order,
// plus which mortgage pieces it carries. A new baseline kind
// (saving) registers its own template here; the shared viewer never
// forks by kind again. The default is the property template.
const PLAN_REPORT_TEMPLATES = {
  property: {
    key: 'property',
    sections: ['variables', 'headline', 'charts', 'comparison', 'engine'],
    variables: ['penalty'], // report variables that apply on this kind
    mortgageCharts: true,        // mortgage-only chart blocks render
    mortgageHeadlineCards: true, // Interest saved / Payoff shift / Monthly payment Δ / Penalty
    breakdown: true,             // Monthly payment breakdown inside the comparison panel
    mergedMortgageRows: true,    // mortgage rows in the merged table
  },
  pool: {
    key: 'pool',
    // No Variables section: penalty is a mortgage concept (breaking
    // a term / refinance / rate switch) and has no meaning on a
    // cash-pool strategy — it must not appear here at all (user
    // 2026-11-05: "为啥GIC有penalty啊"). The template is keyed on
    // the BASELINE kind (cash pool vs property mortgage), never on
    // the strategy.
    sections: ['headline', 'charts', 'comparison', 'engine'],
    variables: [],
    mortgageCharts: false,
    mortgageHeadlineCards: false,
    breakdown: false,
    mergedMortgageRows: false,
  },
};
// Baseline kind → template, defaulting to property. The report's
// baseline kind is its investmentScope flag (cash-pool baseline).
function planReportTemplateFor(kind) {
  return PLAN_REPORT_TEMPLATES[kind] || PLAN_REPORT_TEMPLATES.property;
}

// Headline time window (user 2026-11-06): the window starts at the
// current month; the slider picks its end month. Default = the end
// of the current mortgage term for property reports (the server's
// report.termEndMonth), the full horizon for pool reports (no term).
// The client mirror of windowedHeadlineFigures in src/planning.js —
// same definitions, read straight off the report trajectories
// (already engine/AI overridden by the overlay). Kept as a near-copy
// on purpose: the unit tests pin the server copy, the e2e pins pin
// this one.
const planRound2 = (v) => Math.round(v * 100) / 100;
function planHeadlineWindowedFigures(baseRows, stratRows, startMonth, endMonth, penalty, excludeStockGain) {
  const base = new Map((baseRows || []).map((r) => [r.month, r]));
  const strat = new Map((stratRows || []).map((r) => [r.month, r]));
  const months = [...new Set([...base.keys(), ...strat.keys()])]
    .filter((m) => m >= startMonth && m <= endMonth).sort();
  let interestSaved = 0;
  let cost = Number(penalty) || 0;
  for (const m of months) {
    const b = base.get(m) || {};
    const s = strat.get(m) || {};
    interestSaved += (b.interest || 0) - (s.interest || 0);
    cost += s.cash_out || 0;
  }
  const valDiffAt = (m) => planRound2(((strat.get(m) || {}).stock_value || 0) - ((base.get(m) || {}).stock_value || 0));
  const stockGain = months.length ? planRound2(valDiffAt(months[months.length - 1]) - valDiffAt(months[0])) : 0;
  const lastStrat = months.length ? (strat.get(months[months.length - 1]) || {}) : {};
  const valueAtHorizon = months.length && lastStrat.total_value != null ? planRound2(lastStrat.total_value) : null;
  const payoffOf = (rows) => {
    const sorted = [...(rows || [])].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    if (!sorted.some((r) => (r.mortgage_balance || 0) > 0)) return null;
    const zero = sorted.find((r) => (r.mortgage_balance || 0) === 0);
    return zero ? zero.month : null;
  };
  const basePayoff = payoffOf(baseRows);
  const stratPayoff = payoffOf(stratRows);
  const monthIdx = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
  const payoffShiftMonths = (basePayoff && stratPayoff && monthIdx(endMonth) >= Math.min(monthIdx(basePayoff), monthIdx(stratPayoff)))
    ? monthIdx(basePayoff) - monthIdx(stratPayoff)
    : null;
  const payoffBeyondWindow = !!(basePayoff && stratPayoff && monthIdx(endMonth) < Math.min(monthIdx(basePayoff), monthIdx(stratPayoff)));
  const gain = excludeStockGain ? planRound2(interestSaved) : planRound2(interestSaved + stockGain);
  return {
    interestSaved: planRound2(interestSaved), stockGain, gain,
    cost: planRound2(cost), net: planRound2(gain - planRound2(cost)),
    valueAtHorizon, payoffShiftMonths, payoffBeyondWindow,
  };
}
function planHeadlineWindowMonths(view) {
  const trajs = (view.comp.report && view.comp.report.trajectories) || [];
  return ((trajs[0] || {}).monthly || []).map((r) => r.month);
}
// Default window start: the current month (the comparison starts
// now). The slider's start handle can move it later.
function planHeadlineWindowDefaultStartIdx(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return 0;
  const startMonth = (view.comp.report && view.comp.report.currentMonth) || months[0];
  return Math.max(0, months.indexOf(startMonth));
}
function planHeadlineWindowStartIdx(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return 0;
  const maxIdx = months.length - 1;
  const defStart = planHeadlineWindowDefaultStartIdx(view);
  const defEnd = planHeadlineWindowDefaultIdx(view);
  const endRaw = view.headlineEndIdx != null ? view.headlineEndIdx : defEnd;
  const raw = view.headlineStartIdx != null ? view.headlineStartIdx : defStart;
  // Clamped to the end handle (never crosses it); both handles range
  // over the whole trajectory, so the start may sit before the
  // current month. Reads raw stored values only — no call back into
  // the end accessor (that would recurse).
  return Math.min(Math.max(raw, 0), Math.min(endRaw, maxIdx));
}
function planHeadlineWindowDefaultIdx(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return null;
  const minIdx = planHeadlineWindowDefaultStartIdx(view);
  const maxIdx = months.length - 1;
  const termEnd = view.comp.report && view.comp.report.termEndMonth;
  if (termEnd) {
    const ti = months.indexOf(termEnd);
    if (ti >= minIdx) return Math.min(ti, maxIdx);
  }
  return maxIdx;
}
function planHeadlineWindowEndIdx(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return null;
  const maxIdx = months.length - 1;
  const defStart = planHeadlineWindowDefaultStartIdx(view);
  const defEnd = planHeadlineWindowDefaultIdx(view);
  const startRaw = view.headlineStartIdx != null ? view.headlineStartIdx : defStart;
  const raw = view.headlineEndIdx != null ? view.headlineEndIdx : defEnd;
  return Math.min(Math.max(raw, Math.max(startRaw, 0)), maxIdx);
}
// The full horizon: the window sits at its default start (current
// month) and runs to the last trajectory month. Only then do the
// cards/table show the settled full-horizon figures (flat value at
// horizon, opportunity-costed stock gain); any narrowed window shows
// the literal windowed figures over [start, end].
function planHeadlineWindowIsFull(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return true;
  return planHeadlineWindowStartIdx(view) === planHeadlineWindowDefaultStartIdx(view)
    && planHeadlineWindowEndIdx(view) === months.length - 1;
}
// Windowed figures for the selected strategy, or null when there
// are no trajectories to window over.
function planHeadlineWindowed(view) {
  const row = (view.comp.strategies || []).find((r) => r.strategy.id === view.selectedStrategyId) || view.comp.strategies[0];
  if (!row) return null;
  const trajs = (view.comp.report && view.comp.report.trajectories) || [];
  const base = trajs[0] || { monthly: [] };
  const strat = trajs.find((t) => t.key === String(row.strategy.id)) || { monthly: [] };
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return null;
  const startIdx = planHeadlineWindowStartIdx(view);
  const startMonth = months[startIdx];
  const endIdx = planHeadlineWindowEndIdx(view);
  const endMonth = months[endIdx];
  if (!endMonth) return null;
  const penalty = planReportPenaltyFor(view.vars, row.strategy.id);
  const w = planHeadlineWindowedFigures(base.monthly, strat.monthly, startMonth, endMonth, penalty, view.projectCategory === 'property');
  return { ...w, startIdx, endIdx, maxIdx: months.length - 1, startMonth, endMonth };
}
// Windowed figures for ANY strategy row (the merged comparison
// table needs one per picked strategy, not just the selected one).
function planHeadlineWindowedFor(view, row) {
  const trajs = (view.comp.report && view.comp.report.trajectories) || [];
  const base = trajs[0] || { monthly: [] };
  const strat = trajs.find((t) => t.key === String(row.strategy.id)) || { monthly: [] };
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return null;
  const startIdx = planHeadlineWindowStartIdx(view);
  const endIdx = planHeadlineWindowEndIdx(view);
  const penalty = planReportPenaltyFor(view.vars, row.strategy.id);
  return planHeadlineWindowedFigures(base.monthly, strat.monthly, months[startIdx], months[endIdx], penalty, view.projectCategory === 'property');
}
function planHeadlineWindowLabel(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return '';
  const w = planHeadlineWindowed(view);
  if (!w) return '';
  const count = w.endIdx - w.startIdx + 1; // inclusive months in the window
  const defIdx = planHeadlineWindowDefaultIdx(view);
  const termEnd = view.comp.report && view.comp.report.termEndMonth;
  let suffix = '';
  if (w.endIdx === defIdx) suffix = termEnd ? ' · Term end' : ' · Full horizon';
  else if (w.endIdx === w.maxIdx) suffix = ' · Full horizon';
  return `${formatYM(w.startMonth)} – ${formatYM(w.endMonth)} · ${count} months${suffix}`;
}
function planHeadlineWindowNote(view) {
  const termEnd = view.comp.report && view.comp.report.termEndMonth;
  const isPool = view.templateKey === 'pool';
  const def = termEnd
    ? `Default: current month – end of the current mortgage term (${formatYM(termEnd)}).`
    : 'Default: current month – full horizon.';
  const defs = isPool
    ? 'Cost is summed over the window; Value at horizon is the value at the window end. Drag both handles to set the window.'
    : 'Interest saved and cost are summed over the window; Value at horizon is the value at the window end. Drag both handles to set the window.';
  const w = planHeadlineWindowed(view);
  const payoffNote = w && w.payoffBeyondWindow ? ' Payoff is beyond this window.' : '';
  return `${def} ${defs}${payoffNote}`;
}
// Dual-thumb range slider (user 2026-11-06: "拉动条是可以前后拉动
// 的设置范围的"): two overlaid range inputs, one per handle, so
// BOTH the start and the end of the window are draggable. The
// handles cannot cross — each input clamps to the other handle on
// input. The track fill between the handles is painted by
// planHeadlineWindowTrackFill (called on render + every input).
function planHeadlineWindowHtml(view) {
  const months = planHeadlineWindowMonths(view);
  if (!months.length || !(view.comp.strategies || []).length) return '';
  const maxIdx = months.length - 1;
  const startIdx = planHeadlineWindowStartIdx(view);
  const endIdx = planHeadlineWindowEndIdx(view);
  return `<div class="plan-headline-window">
    <label>Compare</label>
    <div class="plan-range-dual" id="planReportHeadlineWindowDual">
      <div class="plan-range-track" id="planReportHeadlineWindowTrack"></div>
      <input type="range" id="planReportHeadlineWindowStart" min="0" max="${maxIdx}" step="1" value="${startIdx}" aria-label="Window start month">
      <input type="range" id="planReportHeadlineWindowEnd" min="0" max="${maxIdx}" step="1" value="${endIdx}" aria-label="Window end month">
    </div>
    <span id="planReportHeadlineWindowLabel">${esc(planHeadlineWindowLabel(view))}</span>
  </div>
  <div class="note" id="planReportHeadlineWindowNote">${esc(planHeadlineWindowNote(view))}</div>`;
}
// Paint the track fill between the two handles (0–100% of the range).
function planHeadlineWindowTrackFill(view) {
  const track = $('#planReportHeadlineWindowTrack');
  const months = planHeadlineWindowMonths(view);
  if (!track || !months.length) return;
  const maxIdx = months.length - 1;
  const lo = maxIdx ? (planHeadlineWindowStartIdx(view) / maxIdx) * 100 : 0;
  const hi = maxIdx ? (planHeadlineWindowEndIdx(view) / maxIdx) * 100 : 100;
  track.style.background = `linear-gradient(to right, #d7dee6 0%, #d7dee6 ${lo}%, #2f7de1 ${lo}%, #2f7de1 ${hi}%, #d7dee6 ${hi}%, #d7dee6 100%)`;
}

// Headline cards for the selected strategy (items 6 + 9): the nine
// metric cards that used to live on the strategy page. Pool
// baselines show five (no mortgage figures). Values come from the
// LIVE variables, so typing a penalty updates cost and net here
// before Apply.
function planReportHeadlineCardsHtml(view) {
  const row = (view.comp.strategies || []).find((r) => r.strategy.id === view.selectedStrategyId) || view.comp.strategies[0];
  if (!row) return '<div class="note">No strategies yet.</div>';
  const c = planReportEffectiveComparison(row, view.vars, view.templateKey === 'pool');
  // Time window (user 2026-11-06): when the slider sits short of the
  // full horizon, the cumulative / horizon-bound cards recompute over
  // the window from the trajectories. At the full horizon the cards
  // show the settled full-horizon figures (flat value at horizon,
  // opportunity-costed stock gain) — the window covers everything,
  // so the full definitions apply. Monthly payment Δ and Penalty are
  // per-month / one-off and never move with the slider.
  const w = planHeadlineWindowed(view);
  const windowed = !!(w && !planHeadlineWindowIsFull(view));
  const net = windowed ? w.net : c.net;
  const cost = windowed ? w.cost : c.cost;
  const gain = windowed ? w.gain : c.gain;
  const valueAtHorizon = windowed ? w.valueAtHorizon : c.valueAtHorizon;
  const interestSaved = windowed ? w.interestSaved : c.interestSaved;
  const stockGain = windowed ? w.stockGain : c.stockGain;
  const payoffShiftMonths = windowed ? w.payoffShiftMonths : c.payoffShiftMonths;
  // Which mortgage cards show follows the report TEMPLATE, not a
  // local investmentScope check. Stock gain stays for pool reports:
  // it is a stock figure, not a mortgage figure.
  const template = view.template || planReportTemplateFor('property');
  const showMortCards = template.mortgageHeadlineCards;
  const card = (k, v) => `<div class="card breakdown-card plan-metric-card"><div class="k">${k}</div><div class="v">${v}</div><div class="n">${esc(row.strategy.letter)} · ${esc(row.strategy.name)}</div></div>`;
  const cards = [
    card('Net benefit', planMoney(net)),
    card('Total cost', planMoney(cost)),
    card('Total gain', planMoney(gain)),
    card('Value at horizon', planMoney(valueAtHorizon)),
  ];
  if (showMortCards) cards.push(card('Interest saved', planSigned(interestSaved)));
  cards.push(card('Stock gain', planSigned(stockGain)));
  if (showMortCards) {
    cards.push(card('Payoff shift', payoffShiftMonths == null ? '—' : `${payoffShiftMonths >= 0 ? '+' : ''}${payoffShiftMonths} months`));
    cards.push(card('Monthly payment Δ', planSigned(c.paymentDelta)));
    cards.push(card('Penalty', planMoney(c.penalty)));
  }
  return `<div class="cards">${cards.join('')}</div>`;
}

// Difference monthly rows for the report table (item 10), built
// from the report trajectories (baseline + selected strategy) —
// already entity-scoped and engine-overridden by the overlay.
function planReportTableRows(view) {
  const trajs = (view.comp.report && view.comp.report.trajectories) || [];
  const base = trajs[0] || { monthly: [] };
  const strat = trajs.find((t) => t.key === String(view.selectedStrategyId)) || { monthly: [] };
  const baseByMonth = new Map((base.monthly || []).map((r) => [r.month, r]));
  const stratByMonth = new Map((strat.monthly || []).map((r) => [r.month, r]));
  const months = [...new Set([...baseByMonth.keys(), ...stratByMonth.keys()])].sort();
  return months.map((m) => {
    const b = baseByMonth.get(m) || {};
    const s = stratByMonth.get(m) || {};
    const balBase = b.mortgage_balance ?? null;
    const balStrat = s.mortgage_balance ?? null;
    const intBase = b.interest ?? null;
    const intStrat = s.interest ?? null;
    const valBase = b.stock_value ?? null;
    const valStrat = s.stock_value ?? null;
    return {
      month: m, balBase, balStrat,
      balDiff: (balBase != null && balStrat != null) ? balBase - balStrat : null,
      intBase, intStrat,
      intSaved: (intBase != null && intStrat != null) ? intBase - intStrat : null,
      valBase, valStrat,
      valDiff: (valBase != null && valStrat != null) ? valStrat - valBase : null,
    };
  });
}

// Report table section (item 10): the monthly Difference table with
// the difftable kind-gating (pool → no mortgage columns, rows follow
// the pool/stock series; property → balance columns whenever balance
// data exists; other → op-nature rule). Monthly only + year pager —
// the merged comparison already carries annual summaries.
function planReportTableRender(view) {
  const host = $('#planReportTableBody');
  const pager = $('#planReportTablePager');
  if (!host) return;
  let rows = planReportTableRows(view);
  // Difference table follows the Difference slider (user 2026-11-06):
  // only months inside the slider window render. The year pager
  // below derives from these rows, so it covers window years only
  // (a window inside one year shows that year alone, no pager).
  // A partial year's "YYYY total" sums the displayed months only.
  const trajWin = planTrajWindowMonths(view);
  if (trajWin) {
    const winMonths = new Set(trajWin.months.slice(trajWin.startIdx, trajWin.endIdx + 1));
    rows = rows.filter((r) => winMonths.has(r.month));
  }
  const kind = view.templateKey === 'pool' ? 'pool' : (view.projectCategory === 'property' ? 'property' : 'other');
  const hasMort = rows.some((r) => r.balBase != null || r.balStrat != null);
  const hasStock = rows.some((r) => r.valBase != null || r.valStrat != null);
  const selRow = (view.comp.strategies || []).find((r) => r.strategy.id === view.selectedStrategyId);
  const touchesMort = !!(selRow && selRow.touchesMortgage);
  const showBalance = kind === 'pool' ? false : kind === 'property' ? hasMort : touchesMort;
  const diffRows = kind === 'pool' ? rows.filter((r) => r.valBase != null || r.valStrat != null) : rows;
  const cap = $('#planReportTableCaption');
  if (cap) cap.textContent = kind === 'pool' ? 'X: month · Y: CAD — Value Δ = strategy value − baseline value.' : 'X: month · Y: CAD — Balance Δ = baseline balance − strategy balance (positive = strategy owes less); Value Δ = strategy value − baseline value.';
  if (!diffRows.length) {
    if (pager) pager.innerHTML = '';
    host.innerHTML = '<div class="note">No months in this range.</div>';
    return;
  }
  const pageYears = [...new Set(diffRows.map((r) => r.month.slice(0, 4)))];
  if (!view.tableYear || !pageYears.includes(view.tableYear)) view.tableYear = pageYears[0];
  if (pager) {
    pager.innerHTML = pageYears.length > 1 ? pageYears.map((y) => `<button class="small${y === view.tableYear ? ' active' : ''}" data-plan-report-table-year="${y}">${y}</button>`).join('') : '';
    pager.querySelectorAll('[data-plan-report-table-year]').forEach((b) => b.addEventListener('click', () => { view.tableYear = b.dataset.planReportTableYear; planReportTableRender(view); }));
  }
  const pageRows = diffRows.filter((r) => r.month.slice(0, 4) === view.tableYear);
  const diffCls = (v) => (v != null && v !== 0) ? ' class="plan-diff"' : '';
  let head = '<tr><th>Month</th>';
  if (showBalance) head += '<th>Baseline balance</th><th>Strategy balance</th><th>Balance Δ</th><th>Baseline interest</th><th>Strategy interest</th><th>Interest saved</th>';
  if (hasStock) head += '<th>Baseline value</th><th>Strategy value</th><th>Value Δ</th>';
  head += '</tr>';
  const cols = 1 + (showBalance ? 6 : 0) + (hasStock ? 3 : 0);
  let body = '';
  let curYear = null; let yearRows = [];
  const flushYear = () => {
    if (!yearRows.length) return;
    const last = yearRows[yearRows.length - 1];
    const sum = (f) => yearRows.reduce((a, r) => a + (r[f] || 0), 0);
    body += `<tr class="plan-year-total"><td>${curYear} total</td>`;
    if (showBalance) body += `<td>${planMoney(last.balBase)}</td><td>${planMoney(last.balStrat)}</td><td${diffCls(last.balDiff)}>${planSigned(last.balDiff)}</td><td>${planMoney(sum('intBase'))}</td><td>${planMoney(sum('intStrat'))}</td><td${diffCls(sum('intSaved'))}>${planSigned(sum('intSaved'))}</td>`;
    if (hasStock) body += `<td>${planMoney(last.valBase)}</td><td>${planMoney(last.valStrat)}</td><td${diffCls(last.valDiff)}>${planSigned(last.valDiff)}</td>`;
    body += '</tr>';
  };
  for (const r of pageRows) {
    const y = r.month.slice(0, 4);
    if (y !== curYear) { flushYear(); curYear = y; yearRows = []; body += `<tr class="plan-year-head"><td colspan="${cols}">${y}</td></tr>`; }
    yearRows.push(r);
    let x = `<tr><td>${formatYM(r.month)}</td>`;
    if (showBalance) x += `<td>${planMoney(r.balBase)}</td><td>${planMoney(r.balStrat)}</td><td${diffCls(r.balDiff)}>${planSigned(r.balDiff)}</td><td>${planMoney(r.intBase)}</td><td>${planMoney(r.intStrat)}</td><td${diffCls(r.intSaved)}>${planSigned(r.intSaved)}</td>`;
    if (hasStock) x += `<td>${planMoney(r.valBase)}</td><td>${planMoney(r.valStrat)}</td><td${diffCls(r.valDiff)}>${planSigned(r.valDiff)}</td>`;
    body += x + '</tr>';
  }
  flushYear();
  host.innerHTML = `<table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Engine explanation (item 9): plain language, actual numbers,
// always last. Names the engine (preset vs AI), what the AI engine
// defined vs what fell back to preset, the flat VALUE AT HORIZON
// definition, and the penalty-variable state.
function planReportEngineHtml(view) {
  const row = (view.comp.strategies || []).find((r) => r.strategy.id === view.selectedStrategyId) || view.comp.strategies[0];
  const isPool = view.templateKey === 'pool';
  const hasPenaltyVar = !!(view.template && (view.template.variables || []).includes('penalty'));
  const c = row ? planReportEffectiveComparison(row, view.vars, isPool) : {};
  const eng = row && row.engine;
  const hasEngine = !!(view.report.definition && view.report.definition.engine && typeof view.report.definition.engine === 'object');
  const engFailed = !!(eng && eng.errors && eng.errors.length);
  const engDef = hasEngine ? (view.report.definition.engine || {}) : {};
  const definedSeries = Object.keys(engDef.series || {});
  const definedScalars = Object.keys(engDef.scalars || {});
  const definedInputs = (engDef.inputs || []).map((i) => i.key).filter(Boolean);
  const engineLine = !hasEngine
    ? 'Preset engine — the app\u2019s deterministic engine: operations, terms and scenario factors, computed by the app. No AI figures.'
    : engFailed
      ? `AI engine — the AI wrote a calculation definition, but it failed to evaluate (${esc((eng.errors || []).join('; '))}), so every figure below is the preset engine\u2019s.`
      : `AI engine — the AI wrote a calculation definition and the app executed it. Defined: ${[...definedSeries.map((s) => `series ${s}`), ...definedScalars.map((s) => `scalar ${s}`), ...definedInputs.map((s) => `input ${s}`)].join(', ') || 'nothing — the preset engine covers every figure'}. Everything else is the preset engine\u2019s figure.`;
  const trajs = (view.comp.report && view.comp.report.trajectories) || [];
  const months = ((trajs[0] || {}).monthly || []).map((r) => r.month);
  const horizonLine = months.length ? `Horizon: ${formatYM(months[0])} – ${formatYM(months[months.length - 1])} (${months.length} months).` : '';
  // Headline window: when the window is shorter than the full horizon
  // the headline cards cover the window only; the comparison table,
  // the payment breakdown and the AI charts follow the same window,
  // while the Difference chart keeps its own range slider.
  const win = planHeadlineWindowed(view);
  const windowLine = win && !planHeadlineWindowIsFull(view)
    ? `Headline window: ${planHeadlineWindowLabel(view)} — the headline, comparison table, payment breakdown and AI charts cover this window only; the Difference chart keeps its own range slider.`
    : '';
  const bd = row && view.costBreakdown ? view.costBreakdown[row.strategy.id] : null;
  // Pool reports measure no mortgage: no penalty, no interest saved
  // — the cost line names fees + cash out and the gain is stock gain
  // only. Property reports keep the full breakdown.
  const costLine = row
    ? isPool
      ? `${esc(row.strategy.letter)} · ${esc(row.strategy.name)}: cost ${planMoney(c.cost)}${bd ? ` (fees ${planMoney(bd.fees)} + cash out ${planMoney(bd.cashOut)})` : ''} · gain ${planMoney(c.gain)} (stock gain ${planSigned(c.stockGain)}) · net ${planMoney(c.net)}. Value at horizon ${planMoney(c.valueAtHorizon)}.`
      : `${esc(row.strategy.letter)} · ${esc(row.strategy.name)}: cost ${planMoney(c.cost)}${bd ? ` (fees ${planMoney(bd.fees)} + penalty ${planMoney(c.penalty)} + cash out ${planMoney(bd.cashOut)})` : ''} · gain ${planMoney(c.gain)} (interest saved ${planSigned(c.interestSaved)} + stock gain ${planSigned(c.stockGain)}) · net ${planMoney(c.net)}. Value at horizon ${planMoney(c.valueAtHorizon)}.`
    : '';
  const penState = (view.comp.strategies || []).map((r) => {
    const v = planReportPenaltyFor(view.vars, r.strategy.id);
    return `${esc(r.strategy.letter)} · ${esc(r.strategy.name)}: ${planMoney(v)}`;
  }).join(' · ');
  const horizonDefLine = isPool
    ? 'Value at horizon = stock value at the horizon month at today\u2019s known prices (no growth) + cash pot (pool + stock only — no property equity).'
    : 'Value at horizon = property equity at the horizon month + stock value at the horizon month at today\u2019s known prices (no growth) + cash pot.';
  return `<div class="panel"><div class="section-head"><h3>Engine</h3></div>
    <div class="note">${engineLine}</div>
    ${horizonLine ? `<div class="note">${horizonLine}</div>` : ''}
    ${windowLine ? `<div class="note">${windowLine}</div>` : ''}
    ${costLine ? `<div class="note">${costLine}</div>` : ''}
    <div class="note">${horizonDefLine}</div>
    ${hasPenaltyVar ? `<div class="note">Penalty is a report variable (default $0): ${penState || 'none'}. It changes cost and net only — never the trajectories.</div>` : ''}
    <div class="note">Refine: edit this strategy\u2019s operations, funding or scenario on its page, then press Generate again. ${row ? `<a href="#planning/strategy/${row.strategy.id}">Edit ${esc(row.strategy.letter)} · ${esc(row.strategy.name)}</a>` : ''}</div>
  </div>`;
}

// Variables panel (items 4 + 5): one penalty amount input per pinned
// strategy, default $0. Typing updates the headline, the cost
// breakdown table and the engine note live; Apply saves the
// variables with the report (PUT) and reloads, which refreshes the
// charts and the comparison table. What-if never writes.
// The panel renders ONLY for templates that declare variables: a
// cash-pool report has none (penalty is mortgage-only), so the
// section is absent there, not empty.
function planReportVariablesHtml(view) {
  if (!view.template || !(view.template.variables || []).length) return '';
  const rows = (view.comp.strategies || []).map((r) => {
    const v = planReportPenaltyFor(view.vars, r.strategy.id);
    return `<div><label>Penalty — ${esc(r.strategy.letter)} · ${esc(r.strategy.name)} ($)</label><input type="text" inputmode="decimal" data-money data-plan-report-penalty="${r.strategy.id}" value="${v}"><div class="note">Default $0. Changes cost and net only.</div></div>`;
  }).join('');
  return `<div class="panel"><div class="section-head"><h3>Variables</h3></div>
    <div class="note">Penalty is a report variable: type an amount to see cost and net change live. It changes cost and net only — never the trajectories.</div>
    ${rows || '<div class="note">No strategies yet.</div>'}
    <div class="toolbar"><button class="small primary" id="planReportVarsApplyBtn">Apply</button></div>
    <div class="msg" id="planReportVarsMsg"></div>
  </div>`;
}

// Cost-breakdown table body (shared by the chart panel and the live
// variable update): fees + penalty variable + cash out. On a
// cash-pool report there is no penalty variable, so the row is
// omitted (showPenalty false).
function planReportCostBodyHtml(fees, penVar, cashOut, showPenalty = true) {
  const total = (fees || 0) + (showPenalty ? (penVar || 0) : 0) + (cashOut || 0);
  const labels = showPenalty ? ['Fees', 'Penalty (report variable)', 'Cash out'] : ['Fees', 'Cash out'];
  const data = showPenalty ? [fees || 0, penVar || 0, cashOut || 0] : [fees || 0, cashOut || 0];
  return labels.map((l, li) => `<tr><td>${l}</td><td>${money2(data[li])}</td><td>${total ? `${((data[li] / total) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('');
}

// Refine-with-AI panel (item 3, AI path only): follow-up text →
// ai-refine → complete revised definition + old→new diff preview →
// Apply (PUT) writes it. Preview-only until Apply.
function planReportRefineHtml() {
  return `<div class="panel"><div class="section-head"><h3>Refine with AI</h3></div>
    <div class="note">Ask the AI to change this report — it rewrites the engine definition and the charts, then shows the changes for you to apply. Nothing is saved until you press Apply.</div>
    <div><textarea id="planReportRefineText" rows="3" placeholder="e.g. Show the payoff month instead of the payment delta"></textarea></div>
    <div class="toolbar"><button class="small primary" id="planReportRefineSendBtn">Send</button></div>
    <div id="planReportRefineOut"></div>
    <div class="msg" id="planReportRefineMsg"></div>
  </div>`;
}

function planReportRefineDiffHtml(diff) {
  const lines = [];
  for (const t of (diff.charts.added || [])) lines.push(`+ Chart ${t}`);
  for (const t of (diff.charts.removed || [])) lines.push(`− Chart ${t}`);
  for (const t of (diff.charts.changed || [])) lines.push(`~ Chart ${t}`);
  for (const [section, d] of [['series', diff.engine.series], ['scalars', diff.engine.scalars], ['inputs', diff.engine.inputs]]) {
    if (!d) continue;
    for (const k of (d.added || [])) lines.push(`+ Engine ${section} ${k}`);
    for (const k of (d.removed || [])) lines.push(`− Engine ${section} ${k}`);
    for (const k of (d.changed || [])) lines.push(`~ Engine ${section} ${k}`);
  }
  return lines.length ? `<div class="note">${lines.map((l) => esc(l)).join('<br>')}</div>` : '<div class="note">No changes.</div>';
}

// AI charts follow the headline window (user 2026-11-06): each
// time-series chart recorded in the charts loop is redrawn with its
// series sliced to [startMonth, endMonth]. Snapshots (share
// doughnut) are not time series and are left alone; the tables under
// the charts keep their full-range snapshots, like the Difference
// table under its own range picker. AI scalar overrides
// (metric_cards = the headline) stay full-horizon: the engine has no
// series reduction (no sum/last/first — only element-wise min/max),
// so a scalar cannot be re-derived over a sliced series without
// rebuilding the evaluator; the windowed headline instead reads the
// AI-overridden trajectories (round 1).
function planReportAiChartsSlice(view) {
  const specs = view.aiCharts || [];
  if (!specs.length) return;
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return;
  const startMonth = months[planHeadlineWindowStartIdx(view)];
  const endMonth = months[planHeadlineWindowEndIdx(view)];
  for (const spec of specs) {
    const labels = spec.labels || [];
    const labelMonths = spec.labelMonths || labels;
    const idxs = labels.map((_, i) => i).filter((i) => labelMonths[i] >= startMonth && labelMonths[i] <= endMonth);
    if (!idxs.length) { planDestroyChart(spec.cid); continue; }
    const slicedLabels = idxs.map((i) => labels[i]);
    const sliced = (spec.datasets || []).map((d) => ({ ...d, data: idxs.map((i) => (d.data || [])[i] ?? null) }));
    let opts;
    if (spec.endLabels) opts = { endLabels: sliced.map((d) => `${d.label} ${money2(d.data[d.data.length - 1])}`) };
    if (spec.kind === 'line') planLineChart(spec.cid, slicedLabels, sliced, opts || {});
    else if (spec.kind === 'bar') planBarChart(spec.cid, slicedLabels, sliced);
    else if (spec.kind === 'groupedBar') planGroupedBarChart(spec.cid, slicedLabels, sliced);
  }
}

// One slider, one window: re-render every section the window drives.
// Called on either handle's input. The Difference chart + table keep
// their own range pickers and are never touched here.
function planReportWindowRefresh(view) {
  const cards = $('#planReportHeadlineCards');
  if (cards) cards.innerHTML = planReportHeadlineCardsHtml(view);
  const lab = $('#planReportHeadlineWindowLabel');
  if (lab) lab.textContent = planHeadlineWindowLabel(view);
  const note = $('#planReportHeadlineWindowNote');
  if (note) note.textContent = planHeadlineWindowNote(view);
  const eng = $('#planReportEngineBody');
  if (eng) eng.innerHTML = planReportEngineHtml(view);
  planHeadlineWindowTrackFill(view);
  if (view.compareT) {
    const winMonths = planCompareWindowMonths(view.compareT.block);
    if (winMonths) planCompareBreakdownDraw(view.compareT, winMonths);
    planMergedRender(view.compareT);
  }
  planReportAiChartsSlice(view);
}

// Wiring for the report sections: headline chip picker, variable
// inputs (live) + Apply, AI refine Send/Apply.
function planReportViewWire(view) {
  document.querySelectorAll('[data-plan-report-headline-strategy]').forEach((b) => b.addEventListener('click', () => {
    view.selectedStrategyId = Number(b.dataset.planReportHeadlineStrategy);
    document.querySelectorAll('[data-plan-report-headline-strategy]').forEach((x) => x.classList.toggle('active', Number(x.dataset.planReportHeadlineStrategy) === view.selectedStrategyId));
    const cards = $('#planReportHeadlineCards');
    if (cards) cards.innerHTML = planReportHeadlineCardsHtml(view);
    const winNote = $('#planReportHeadlineWindowNote');
    if (winNote) winNote.textContent = planHeadlineWindowNote(view);
    planReportTableRender(view);
    const eng = $('#planReportEngineBody');
    if (eng) eng.innerHTML = planReportEngineHtml(view);
  }));
  // Headline time window (user 2026-11-06): dragging either handle
  // re-renders everything the window drives — headline cards, window
  // label/note, engine note, merged comparison table, payment
  // breakdown chart and AI charts — from the trajectories already in
  // view, no refetch. The Difference chart keeps its own range
  // picker and is never touched here. The handles cannot cross:
  // each input clamps to the other handle.
  const winStart = $('#planReportHeadlineWindowStart');
  const winEnd = $('#planReportHeadlineWindowEnd');
  if (winStart) winStart.addEventListener('input', () => {
    view.headlineStartIdx = Math.min(Number(winStart.value), planHeadlineWindowEndIdx(view));
    winStart.value = String(planHeadlineWindowStartIdx(view));
    planReportWindowRefresh(view);
  });
  if (winEnd) winEnd.addEventListener('input', () => {
    view.headlineEndIdx = Math.max(Number(winEnd.value), planHeadlineWindowStartIdx(view));
    winEnd.value = String(planHeadlineWindowEndIdx(view));
    planReportWindowRefresh(view);
  });
  planHeadlineWindowTrackFill(view);
  document.querySelectorAll('[data-plan-report-penalty]').forEach((input) => input.addEventListener('input', () => {
    const sid = input.dataset.planReportPenalty;
    const raw = String(input.value || '').replace(/,/g, '').trim();
    const v = raw === '' ? 0 : Number(raw);
    if (!view.vars.penalty) view.vars.penalty = {};
    view.vars.penalty[sid] = Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0;
    const cards = $('#planReportHeadlineCards');
    if (cards) cards.innerHTML = planReportHeadlineCardsHtml(view);
    const eng = $('#planReportEngineBody');
    if (eng) eng.innerHTML = planReportEngineHtml(view);
    const costBody = $('#planReportCostBody');
    if (costBody && view.costDoughnut) {
      const penVar = planReportPenaltyFor(view.vars, view.costDoughnut.strategyId);
      costBody.innerHTML = planReportCostBodyHtml(view.costDoughnut.fees, penVar, view.costDoughnut.cashOut, !!(view.template && (view.template.variables || []).includes('penalty')));
    }
  }));
  const applyBtn = $('#planReportVarsApplyBtn');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    const msg = $('#planReportVarsMsg');
    try {
      const penalty = {};
      document.querySelectorAll('[data-plan-report-penalty]').forEach((input) => {
        const raw = String(input.value || '').replace(/,/g, '').trim();
        const v = raw === '' ? 0 : Number(raw);
        if (!Number.isFinite(v) || v < 0) throw new Error('Penalty must be a number ≥ 0');
        penalty[input.dataset.planReportPenalty] = Math.round(v * 100) / 100;
      });
      const def = { ...(view.report.definition || {}), variables: { penalty } };
      await api(`/api/planning/reports/${view.reportId}`, { method: 'PUT', body: { definition: def } });
      loadPlanReport(view.projectId, view.reportId);
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
  const refineSend = $('#planReportRefineSendBtn');
  if (refineSend) refineSend.addEventListener('click', async () => {
    const msg = $('#planReportRefineMsg');
    const out = $('#planReportRefineOut');
    const text = String($('#planReportRefineText').value || '').trim();
    if (!text) { showMsg(msg, 'err', 'Say what to change first.'); return; }
    try {
      const r = await api(`/api/planning/reports/${view.reportId}/ai-refine`, { method: 'POST', body: { text } });
      view.refineDefinition = r.definition;
      if (out) out.innerHTML = `${planReportRefineDiffHtml(r.diff || {})}<div class="toolbar"><button class="small primary" id="planReportRefineApplyBtn">Apply</button></div>`;
      const applyBtn2 = $('#planReportRefineApplyBtn');
      if (applyBtn2) applyBtn2.addEventListener('click', async () => {
        try {
          await api(`/api/planning/reports/${view.reportId}`, { method: 'PUT', body: { definition: view.refineDefinition } });
          loadPlanReport(view.projectId, view.reportId);
        } catch (err) { showMsg(msg, 'err', err.message); }
      });
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
}

async function loadPlanReport(projectId, reportId) {
  return withLoading(async () => {
    const mySeq = ++planReportLoadSeq;
    const proj = await api(`/api/planning/projects/${projectId}`);
    if (mySeq !== planReportLoadSeq) return;
    const report = (proj.reports || []).find((r) => r.id === reportId);
    if (!report) {
      planReportCurrentId = null;
      planReportCurrentPins = null;
      $('#planReport').innerHTML = `<div class="panel"><div class="note">Report not found.</div></div>`;
      planReportHighlightApply();
      planReportOutlineClear();
      planReportViewSync(projectId, null);
      return;
    }
    // A report whose baseline was deleted shows a re-pick panel only —
    // never charts against a silently substituted baseline.
    if (report.baseline_cleared) {
      planReportTabsOpen(projectId, reportId, report.name);
      planReportCurrentId = reportId;
      planReportCurrentPins = null;
      const bases = proj.project.baselines || [];
      $('#planReport').innerHTML = `
      <div class="panel">
        <div class="section-head"><h3>${esc(report.name)}</h3></div>
        <div class="note">The baseline this report compared against was deleted. Pick a baseline to regenerate it.</div>
        <div><label>Baseline (one)</label><select id="planReportRepickBaseline">${bases.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>
        <div class="toolbar"><button class="small primary" id="planReportRepickBtn">Use this baseline</button></div>
        <div class="msg" id="planReportMsg"></div>
      </div>`;
      $('#planReportRepickBtn').addEventListener('click', async () => {
        try {
          await api(`/api/planning/reports/${reportId}`, { method: 'PUT', body: { baseline_id: Number($('#planReportRepickBaseline').value) } });
          loadPlanReport(projectId, reportId);
        } catch (err) { showMsg($('#planReportMsg'), 'err', err.message); }
      });
      planReportOutlineClear();
      planReportViewSync(projectId, reportId);
      planReportHighlightApply();
      return;
    }
    // Scenario pinning: a report renders under its PINNED scenarios
    // only. Legacy rows (no pin) on a project with scenarios get the
    // pin panel, never numbers under a substituted world; a flat-world
    // pin ([]) renders without scenarioIds. A deleted pinned scenario
    // (comparison 404) re-opens the pin panel.
    const pinned = report.scenarioIds !== undefined ? report.scenarioIds : null;
    const projScenarios = proj.scenarios || [];
    if (pinned === null && projScenarios.length) {
      planReportPinPanel(proj, report, 'This report was saved before scenario pinning. Pick the scenarios it should run under.');
      return;
    }
    const scenarioIds = pinned || [];
    const q = [];
    if (report.baseline_id) q.push(`baselineId=${report.baseline_id}`);
    if (scenarioIds.length) q.push(`scenarioIds=${scenarioIds.join(',')}`);
    // reportId: the comparison evaluates the report's AI engine (if
    // any) per strategy and attaches row.engine — preset reports get
    // no engine block.
    q.push(`reportId=${reportId}`);
    let comp;
    try {
      comp = await api(`/api/planning/projects/${projectId}/comparison${q.length ? `?${q.join('&')}` : ''}`);
    } catch (err) {
      if (/scenario not found/i.test(err.message || '')) {
        if (mySeq !== planReportLoadSeq) return;
        planReportPinPanel(proj, report, 'A scenario this report was pinned to was deleted. Pick the scenarios it should run under.');
        return;
      }
      throw err;
    }
    // Strategy filter: only the report's picked strategies render.
    // Null pins (legacy, never pinned) still mean all strategies;
    // an explicit empty pin [] means baseline-only, not all.
    let pickedIds = null;
    try { pickedIds = report.strategy_ids ? JSON.parse(report.strategy_ids) : null; } catch { pickedIds = null; }
    if (pickedIds) {
      const kept = comp.strategies.filter((row) => pickedIds.includes(row.strategy.id));
      const allTrajs = (comp.report && comp.report.trajectories) || [];
      // Trajectories are baseline first, then one per strategy in rows order.
      const keptTrajs = allTrajs.length ? [allTrajs[0], ...allTrajs.slice(1).filter((t, i) => pickedIds.includes(comp.strategies[i].strategy.id))] : allTrajs;
      comp.strategies = kept;
      if (comp.report) comp.report.trajectories = keptTrajs;
    }
    // Engine + variables overlay (items 2 + 4): AI-engine scalars /
    // series override the preset figures, and the report's penalty
    // variables replace the engine penalty in cost. Applied once
    // here so every section renders executed figures.
    planReportApplyOverlay(comp, report);
    // The report's TEMPLATE follows its BASELINE kind (cash-pool
    // baseline → pool template, everything else → property template
    // for now). The template — not scattered investmentScope checks —
    // decides which mortgage pieces render, and the rule is uniform:
    // the same report renders identically on the project page and
    // the strategy page, so the shared viewer is never forked by
    // page and the stored definitions are never rewritten.
    const template = planReportTemplateFor((comp.report && comp.report.investmentScope) ? 'pool' : 'property');
    // Report-view state: the chip-selected strategy drives the
    // headline, the table and the engine note; it survives reloads
    // within the tab while the report stays open.
    const prevView = planReportView && planReportView.reportId === reportId ? planReportView : null;
    const selectedStrategyId = prevView && prevView.selectedStrategyId && comp.strategies.some((r) => r.strategy.id === prevView.selectedStrategyId)
      ? prevView.selectedStrategyId
      : (comp.strategies[0] ? comp.strategies[0].strategy.id : null);
    planReportView = {
      projectId, reportId, comp, report, scenarioIds, pickedIds,
      selectedStrategyId,
      template, templateKey: template.key,
      vars: JSON.parse(JSON.stringify((report.definition && report.definition.variables) || {})),
      tableYear: prevView ? prevView.tableYear : null,
      headlineStartIdx: prevView ? prevView.headlineStartIdx : null,
      headlineEndIdx: prevView ? prevView.headlineEndIdx : null,
      aiCharts: [],
      compareT: null,
      projectCategory: proj.project ? proj.project.category : null,
      costBreakdown: (comp.report && comp.report.costBreakdown) || null,
      costDoughnut: null,
      refineDefinition: null,
    };
    // Projection errors surface in the report view at the same
    // standard as the strategy detail page: a dropped op (e.g. an
    // empty-pot buy) must not read as identical series with no
    // explanation. The view renders the first pinned world only,
    // so the notice names that world's errors.
    const projErrLines = [];
    for (const row of comp.strategies) {
      const errs = (row.comparison && row.comparison.errors) || [];
      for (const e of errs) projErrLines.push(`${row.strategy.letter} · ${row.strategy.name}: ${e}`);
    }
    // Projection warnings (e.g. a dropped prime step) are scenario-level,
    // identical across strategies — render each once, no per-strategy prefix.
    const projWarnLines = [...new Set(comp.strategies.flatMap((row) => (row.comparison && row.comparison.warnings) || []))];
    let propNames = {};
    try {
      const pp = await api('/api/properties');
      const list = pp.properties || (Array.isArray(pp) ? pp : []);
      for (const p of list) propNames[p.id] = p.address;
    } catch { /* labels fall back to ids */ }
    const charts = (report.definition && report.definition.charts) || [];
    const fanData = {};
    if (template.mortgageCharts && charts.some((c) => c.template === 'fan_band')) {
      for (const row of comp.strategies) {
        try { const sd = await api(`/api/planning/strategies/${row.strategy.id}`); fanData[row.strategy.id] = sd.scenarioTable || []; }
        catch { fanData[row.strategy.id] = []; }
      }
    }
    if (mySeq !== planReportLoadSeq) return;
    $('#planList').classList.add('hidden');
    const rep = comp.report || {};
    const trajs = rep.trajectories || [];
    const baseTraj = trajs[0] || { monthly: [] };
    const months = baseTraj.monthly.map((r) => r.month);
    const monthIndex = new Map(months.map((m, i) => [m, i]));
    const seriesAt = (traj, sid) => (traj.monthly || []).map((r) => r[sid] ?? null);
    const panels = [];
    const draws = [];
    charts.forEach((c, i) => {
      // metric_cards blocks are the headline now (item 9) — the
      // headline section renders the fixed card set for the selected
      // strategy, so the definition's metric_cards block never
      // renders twice.
      if (c.template === 'metric_cards') return;
      const series = (c.series && c.series.length ? c.series : null);
      // Mortgage-only blocks hide under a template without mortgage
      // charts (the pool template). A block with any non-mortgage series
      // stays — e.g. a stacked_bar with stock_value.
      if (!template.mortgageCharts) {
        const mortOnly = (sids) => sids.length > 0 && sids.every((sid) => sid === 'mortgage_balance');
        if (c.template === 'time_line' && mortOnly(series || ['mortgage_balance'])) return;
        if (c.template === 'yearly_bars' && ((series && series[0]) || 'mortgage_balance') === 'mortgage_balance') return;
        if (c.template === 'stacked_bar' && mortOnly(series || ['mortgage_balance'])) return;
        if (c.template === 'share_doughnut' && series && (series.includes('mortgage_balance') || series.includes('total_value'))) return;
      }
      // AI-supplied method wins; engine-path charts get the app's own
      // how-calculated line. Either way every chart states its method.
      const how = c.method ? c.method : planReportHowFor(series, comp.entityProperty && comp.entityProperty.address, template.key === 'pool');
      const cid = `planReportChart${i}`;
      if (c.template === 'time_line') {
        const sids = series || ['mortgage_balance'];
        const datasets = [];
        for (const sid of sids) {
          trajs.forEach((t, ti) => {
            datasets.push({ label: `${t.label} · ${PLAN_REPORT_SERIES_LABEL[sid] || sid}`, data: seriesAt(t, sid), borderColor: ti === 0 ? '#888' : planColor(ti - 1), backgroundColor: ti === 0 ? '#888' : planColor(ti - 1), fill: false, pointRadius: 0, spanGaps: true });
          });
        }
        const snap = planReportYearRows(baseTraj.monthly);
        const head = `<tr><th>Month</th>${datasets.map((d) => `<th>${esc(d.label)}</th>`).join('')}</tr>`;
        const body = snap.map((row) => {
          const idx = monthIndex.get(row.month);
          return `<tr><td>${row.month}</td>${datasets.map((d, di) => {
            const t = trajs[di % trajs.length];
            const v = (t.monthly[idx] || {})[sids[Math.floor(di / trajs.length)]];
            return `<td>${v == null ? '—' : money2(v)}</td>`;
          }).join('')}</tr>`;
        }).join('');
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="chart-wrap" style="height:260px"><canvas id="${cid}"></canvas></div><div class="note">X: month · Y: ${sids.map((sid) => esc(PLAN_REPORT_SERIES_LABEL[sid] || sid)).join(' · ')} (CAD).</div><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table><div class="note">${esc(how)}</div></div>`);
        draws.push(() => planLineChart(cid, months, datasets));
        planReportView.aiCharts.push({ cid, kind: 'line', labels: months, datasets });
      } else if (c.template === 'metric_cards') {
        const sids = series || ['cost', 'gain', 'net'];
        const valOf = (row, sid) => sid === 'cost' ? row.comparison.cost : sid === 'gain' ? row.comparison.gain : sid === 'net' ? row.comparison.net : sid === 'stock_gain' ? row.comparison.stockGain : sid === 'payoff_month' ? row.comparison.payoffShiftMonths : sid === 'monthly_payment' ? row.comparison.paymentDelta : null;
        const fmt = (sid, v) => v == null ? '—' : sid === 'payoff_month' ? `${v} months` : sid === 'monthly_payment' ? planSigned(v) : money2(v);
        const cards = comp.strategies.map((row) => `<div class="cards">${sids.map((sid) => `<div class="card breakdown-card plan-metric-card"><div class="k">${esc(PLAN_REPORT_SERIES_LABEL[sid] || sid)}</div><div class="v">${fmt(sid, valOf(row, sid))}</div><div class="n">${esc(row.strategy.letter)} · ${esc(row.strategy.name)}</div></div>`).join('')}</div>`).join('') || '<div class="note">No strategies yet.</div>';
        const head = `<tr><th>Strategy</th>${sids.map((sid) => `<th>${esc(PLAN_REPORT_SERIES_LABEL[sid] || sid)}</th>`).join('')}</tr>`;
        const body = comp.strategies.map((row) => `<tr><td>${esc(row.strategy.letter)} · ${esc(row.strategy.name)}</td>${sids.map((sid) => `<td>${fmt(sid, valOf(row, sid))}</td>`).join('')}</tr>`).join('');
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div>${cards}<table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table><div class="note">${esc(how)}</div></div>`);
      } else if (c.template === 'yearly_bars') {
        const sid = (series && series[0]) || 'mortgage_balance';
        const yearOf = (m) => m.slice(0, 4);
        const years = [...new Set(months.map(yearOf))];
        const yearEnd = (traj) => {
          const byYear = new Map();
          for (const r of traj.monthly) byYear.set(yearOf(r.month), r[sid] ?? null);
          return years.map((y) => byYear.get(y) ?? null);
        };
        const datasets = trajs.map((t, ti) => ({ label: t.label, data: yearEnd(t), backgroundColor: ti === 0 ? '#888' : planColor(ti - 1) }));
        const head = `<tr><th>Year</th>${trajs.map((t) => `<th>${esc(t.label)}</th>`).join('')}</tr>`;
        const body = years.map((y, yi) => `<tr><td>${y}</td>${datasets.map((d) => `<td>${d.data[yi] == null ? '—' : money2(d.data[yi])}</td>`).join('')}</tr>`).join('');
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="chart-wrap" style="height:260px"><canvas id="${cid}"></canvas></div><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table><div class="note">X: year · Y: year-end ${esc(PLAN_REPORT_SERIES_LABEL[sid] || sid)} (CAD), baseline vs each strategy. ${esc(how)}</div></div>`);
        draws.push(() => planGroupedBarChart(cid, years, datasets));
        planReportView.aiCharts.push({ cid, kind: 'groupedBar', labels: years, labelMonths: years.map((y) => months.filter((m) => m.startsWith(`${y}-`)).pop() || `${y}-12`), datasets });
      } else if (c.template === 'stacked_bar') {
        const sids = series || ['mortgage_balance'];
        const base = comp.baseline;
        const perProp = base ? base.mortgage.perProperty : {};
        const pids = Object.keys(perProp);
        const datasets = [];
        if (sids.includes('mortgage_balance')) {
          pids.forEach((pid, pi) => {
            const s = perProp[pid].baseline && perProp[pid].baseline.series ? perProp[pid].baseline.series : [];
            const byMonth = new Map(s.map((r) => [r.month, r.balance]));
            datasets.push({ label: propNames[pid] || `Property ${pid}`, data: months.map((m) => byMonth.get(m) ?? null), backgroundColor: planColor(pi), stack: 's' });
          });
        }
        if (sids.includes('stock_value')) {
          // Null-safe: a missing baseline used to throw here and abort
          // the whole report render; with no baseline there is simply
          // no stock series, and the guard below renders the note.
          const byMonth = new Map(((base && base.stocks && base.stocks.series) || []).map((r) => [r.month, r.value]));
          datasets.push({ label: 'Stocks', data: months.map((m) => byMonth.get(m) ?? null), backgroundColor: planColor(pids.length), stack: 's' });
        }
        // No component data at all — a series this template cannot
        // render, or no mortgage/stock data for this project — renders
        // a no-data note, never a Total line summed over nothing
        // (that used to draw as all-$0.00). Genuine zeros still render:
        // only all-null counts as absent, a present 0 stays a 0.
        if (!datasets.some((d) => d.data.some((v) => v != null))) {
          panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="note">Not rendered: no data for this chart in this project.</div></div>`);
        } else {
        const totals = months.map((m, mi) => datasets.reduce((s, d) => s + (d.data[mi] || 0), 0));
        datasets.push({ label: 'Total', data: totals, type: 'line', borderColor: '#22303c', backgroundColor: '#22303c', fill: false, pointRadius: 0 });
        const snapIdx = planReportYearRows(baseTraj.monthly).map((r) => monthIndex.get(r.month));
        const head = `<tr><th>Month</th>${datasets.map((d) => `<th>${esc(d.label)}</th>`).join('')}</tr>`;
        const body = snapIdx.map((mi) => `<tr><td>${months[mi]}</td>${datasets.map((d) => `<td>${d.data[mi] == null ? '—' : money2(d.data[mi])}</td>`).join('')}</tr>`).join('');
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="chart-wrap" style="height:260px"><canvas id="${cid}"></canvas></div><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table><div class="note">X: month · Y: CAD (stacked). Baseline outstanding principal stacked by property${sids.includes('stock_value') ? ' plus stock value' : ''}; total line = stack sum. Baseline and strategies share the same prime history. ${esc(how)}</div></div>`);
        draws.push(() => planBarChart(cid, months, datasets));
        planReportView.aiCharts.push({ cid, kind: 'bar', labels: months, datasets });
        }
      } else if (c.template === 'share_doughnut') {
        if (sidsHas(series, 'cost') && !sidsHas(series, 'mortgage_balance') && !sidsHas(series, 'total_value')) {
          const row = comp.strategies[0];
          if (row && rep.costBreakdown) {
            const bd = rep.costBreakdown[row.strategy.id];
            // Penalty slice = the report variable (default $0), not
            // the engine estimate (item 4): cost = fees + penalty
            // variable + cash out. The chart draws the saved value;
            // typing updates the table live and Apply reloads the
            // chart. On a cash-pool report there is no penalty
            // variable — the slice and the mention are omitted.
            const hasPenaltyVar = !!(template.variables || []).includes('penalty');
            const penVar = hasPenaltyVar ? planReportPenaltyFor(planReportView.vars, row.strategy.id) : 0;
            const labels = hasPenaltyVar ? ['Fees', 'Penalty (report variable)', 'Cash out'] : ['Fees', 'Cash out'];
            const data = hasPenaltyVar ? [bd.fees, penVar, bd.cashOut] : [bd.fees, bd.cashOut];
            const total = (bd.fees || 0) + (hasPenaltyVar ? (penVar || 0) : 0) + (bd.cashOut || 0);
            const body = planReportCostBodyHtml(bd.fees, penVar, bd.cashOut, hasPenaltyVar);
            planReportView.costDoughnut = { strategyId: row.strategy.id, fees: bd.fees, cashOut: bd.cashOut };
            panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="chart-wrap" style="height:260px"><canvas id="${cid}"></canvas></div><table class="tbl"><thead><tr><th>Component</th><th>Amount</th><th>Share</th></tr></thead><tbody id="planReportCostBody">${body}</tbody></table><div class="note">Cost breakdown for ${esc(row.strategy.letter)} · ${esc(row.strategy.name)}: cost = fees + ${hasPenaltyVar ? 'penalty + ' : ''}cash out (prepay cash + buy cash).${hasPenaltyVar ? ' Penalty is a report variable (default $0) — it changes cost and net only.' : ''}</div></div>`);
            draws.push(() => planDoughnutChart(cid, labels, data, 'Total cost', total));
          } else {
            panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="note">Not rendered: no strategy cost breakdown available.</div></div>`);
          }
        } else if (series && (series.includes('mortgage_balance') || series.includes('total_value'))) {
          const base = comp.baseline;
          const segs = [];
          if (base) {
            for (const [pid, per] of Object.entries(base.mortgage.perProperty)) {
              const assessed = (rep.assessedByProperty || {})[pid] ?? 0;
              const bal = per.baseline ? per.baseline.balanceAtHorizon : 0;
              const eq = assessed - (bal || 0);
              if (eq > 0) segs.push({ label: propNames[pid] || `Property ${pid}`, value: eq });
            }
          }
          if (segs.length) {
            const total = segs.reduce((s, x) => s + x.value, 0);
            const body = segs.map((x) => `<tr><td>${esc(x.label)}</td><td>${money2(x.value)}</td><td>${total ? `${((x.value / total) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('');
            panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="chart-wrap" style="height:260px"><canvas id="${cid}"></canvas></div><table class="tbl"><thead><tr><th>Property</th><th>Equity at horizon</th><th>Share</th></tr></thead><tbody>${body}</tbody></table><div class="note">Each property's equity at the horizon month (assessed value − outstanding principal, baseline trajectory); center = total equity. Assessed value is the current roll, held flat across months.</div></div>`);
            draws.push(() => planDoughnutChart(cid, segs.map((x) => x.label), segs.map((x) => x.value), 'Total equity', total));
          } else {
            panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="note">Not rendered: no positive property equity at the horizon month.</div></div>`);
          }
        } else {
          panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="note">Not rendered: share doughnut needs a property value series (mortgage_balance / total_value) or cost.</div></div>`);
        }
      } else if (c.template === 'fan_band') {
        // Two fans share this template, split by baseline kind: a
        // mortgage scenario fan on property reports (existing), a
        // stock volatility fan on cash-pool reports (user 2026-11-05).
        // The stock fan is engine-computed (rep.stockFan): one fan
        // per baseline holding with usable history.
        if (!template.mortgageCharts) {
          const stockFan = (rep && rep.stockFan) || { fans: [], noFan: [] };
          const fanBlocks = (stockFan.fans || []).map((fan) => {
            const fcid = `${cid}f${fan.holdingId}`;
            const n = fan.months.length;
            const end = n ? n - 1 : 0;
            // Band fill: P90 fills back to P10 (two datasets back),
            // light so the median line reads through it.
            const fanDatasets = [
              { label: 'P10', data: fan.p10, borderColor: '#7fb0e8', backgroundColor: '#7fb0e8', fill: false, pointRadius: 0 },
              { label: 'Median', data: fan.median, borderColor: planColor(0), backgroundColor: planColor(0), fill: false, pointRadius: 0, borderWidth: 2 },
              { label: 'P90', data: fan.p90, borderColor: '#7fb0e8', backgroundColor: 'rgba(47,125,225,0.15)', fill: '-2', pointRadius: 0 },
            ];
            draws.push(() => planLineChart(fcid, fan.months, fanDatasets, { endLabels: [`P10 ${money2(fan.p10[end])}`, `Median ${money2(fan.median[end])}`, `P90 ${money2(fan.p90[end])}`] }));
            planReportView.aiCharts.push({ cid: fcid, kind: 'line', labels: fan.months, datasets: fanDatasets, endLabels: true });
            const snap = planReportYearRows(fan.months.map((m) => ({ month: m })));
            const sbody = snap.map((row) => {
              const idx = fan.months.indexOf(row.month);
              return `<tr><td>${row.month}</td><td>${money2(fan.median[idx])}</td><td>${money2(fan.p10[idx])}</td><td>${money2(fan.p90[idx])}</td></tr>`;
            }).join('');
            const volNote = fan.volPct === 0 ? 'Volatility 0% over this window — P10/P90 coincide with the median.' : '';
            return `<div class="section-head"><h4>${esc(fan.symbol)}${fan.label && fan.label !== fan.symbol ? ` · ${esc(fan.label)}` : ''}</h4></div>
            <div class="chart-wrap" style="height:240px"><canvas id="${fcid}"></canvas></div>
            <div class="note">Median at the holding's history CAGR ${fan.ratePct}%/yr (${esc(fan.rateBasis || 'Price CAGR')} · ${esc(fan.rateWindow)}). Volatility ${fan.volPct}%/yr from ${fan.volReturns} monthly returns (${esc(fan.volWindow)}), annualized ×√12. Past volatility is an estimate, not a prediction. ${volNote}</div>
            <table class="tbl"><thead><tr><th>Month</th><th>Median</th><th>P10</th><th>P90</th></tr></thead><tbody>${sbody}</tbody></table>`;
          }).join('');
          const noFanNotes = (stockFan.noFan || []).map((nf) => `<div class="note">${esc(nf.symbol)}: no volatility fan — ${nf.reason === 'no usable price history' ? 'not enough price history (needs at least 2 monthly returns)' : esc(nf.reason)}.</div>`).join('');
          const emptyNote = (!stockFan.fans.length && !stockFan.noFan.length) ? '<div class="note">No volatility fan: this project holds no stocks.</div>' : '';
          panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div>${fanBlocks}${noFanNotes}${emptyNote}</div>`);
        } else {
        const blocks = comp.strategies.map((row) => {
          const table = fanData[row.strategy.id] || [];
          if (!table.length) return `<div class="note">${esc(row.strategy.letter)} · ${esc(row.strategy.name)}: no scenario data.</div>`;
          const baseRow = table.find((r) => r.scenarioId === (comp.scenario || {}).id) || table[0];
          const fmonths = baseRow.balanceByMonth.map((r) => r.month);
          const min = fmonths.map((_, mi) => Math.min(...table.map((r) => r.balanceByMonth[mi].balance)));
          const max = fmonths.map((_, mi) => Math.max(...table.map((r) => r.balanceByMonth[mi].balance)));
          const fcid = `${cid}f${row.strategy.id}`;
          const mortFanDatasets = [
            { label: 'Best', data: min, borderColor: '#2f7de1', backgroundColor: '#2f7de1', fill: false, pointRadius: 0 },
            { label: 'Base', data: baseRow.balanceByMonth.map((r) => r.balance), borderColor: planColor(0), backgroundColor: planColor(0), fill: false, pointRadius: 0 },
            { label: 'Worst', data: max, borderColor: '#b03a3a', backgroundColor: '#b03a3a', fill: false, pointRadius: 0 },
          ];
          draws.push(() => planLineChart(fcid, fmonths, mortFanDatasets));
          planReportView.aiCharts.push({ cid: fcid, kind: 'line', labels: fmonths, datasets: mortFanDatasets });
          const sbody = table.map((r) => `<tr><td>${esc(r.name)}</td><td>${planSigned(r.net)}</td><td>${r.payoffShiftMonths != null ? r.payoffShiftMonths : '—'}</td><td>${planSigned(r.paymentDelta)}</td></tr>`).join('');
          return `<div class="chart-wrap" style="height:240px"><canvas id="${fcid}"></canvas></div><div class="note">X: month · Y: mortgage balance (CAD) across scenarios.</div><table class="tbl"><thead><tr><th>Scenario</th><th>Net</th><th>Payoff shift</th><th>Payment Δ</th></tr></thead><tbody>${sbody}</tbody></table>`;
        }).join('');
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div>${blocks}</div>`);
        }
      } else if (c.template === 'funds_flow') {
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="note">Funds flow diagram — not rendered yet.</div></div>`);
      } else {
        panels.push(`<div class="panel"><div class="section-head"><h3>${esc(c.title)}</h3></div><div class="note">Not rendered: unknown template ${esc(c.template)}.</div></div>`);
      }
    });
    // World label for the header: every pinned scenario by name, or
    // the flat world when the pin is empty.
    const worldLabel = scenarioIds.length
      ? `Under ${scenarioIds.map((id) => { const sc = projScenarios.find((x) => x.id === id); return sc ? sc.name : `#${id}`; }).join(', ')}`
      : 'Current rates (no scenario)';
    planReportTabsOpen(projectId, reportId, report.name);
    const renderedStrategyIds = comp.strategies.map((r) => r.strategy.id);
    // Report sections, in the TEMPLATE's order: headline → chart →
    // comparison (the Δ chart + the month-by-month Difference table
    // directly below it + breakdown, in one panel) → strategy对比
    // (the merged cross-strategy table, multi-strategy reports only)
    // → engine explanation (always last). Variables sit above
    // the headline; Refine with AI follows the engine note, AI
    // reports only. Each section is a data-plan-report-block so the
    // floating outline nav lists it; the comparison panel keeps its
    // own id (the outline adds it once, by id). The header panel
    // (title / world / definitions) is common to every template.
    const isAiReport = !!(report.definition && report.definition.engine && typeof report.definition.engine === 'object');
    const headlineChips = comp.strategies.map((r) => `<button class="small${r.strategy.id === planReportView.selectedStrategyId ? ' active' : ''}" data-plan-report-headline-strategy="${r.strategy.id}">${esc(r.strategy.letter)} · ${esc(r.strategy.name)}</button>`).join(' ');
    const sections = {
      variables: `<div data-plan-report-block="variables">${planReportVariablesHtml(planReportView)}</div>`,
      headline: `<div data-plan-report-block="headline"><div class="panel">
        <div class="section-head"><h3>Headline</h3></div>
        <div class="toolbar">${headlineChips}</div>
        ${planHeadlineWindowHtml(planReportView)}
        <div id="planReportHeadlineCards">${planReportHeadlineCardsHtml(planReportView)}</div>
      </div></div>`,
      charts: panels.map((p, i) => `<div data-plan-report-block="${i}">${p}<div class="toolbar"><button class="small danger" data-plan-report-block-del="${i}">Delete</button></div></div>`).join('') || '<div class="panel"><div class="note">No charts in this report.</div></div>',
      comparison: `<div class="panel" id="planReportComparePanel">
        <div class="section-head"><h3>Strategy comparison</h3></div>
        <div class="note" id="planReportTrajectoryNote"></div>
        <div id="planReportComparePicker" class="toolbar"></div>
        <div class="section-head"><h3>Difference vs baseline</h3></div>
        <div class="note" id="planReportTrajCaption">${template.key === 'pool' ? 'X: month · Y: CAD — Baseline and strategy lines show absolute value; the shaded band between them is the Value Δ (strategy value − baseline value).' : 'X: month · Y: CAD — Balance Δ = baseline balance − strategy balance (positive = strategy owes less); Value Δ = strategy value − baseline value.'}</div>
        <div id="planReportTrajRange"></div>
        <div class="chart-wrap plan-traj-wrap" style="height:280px"><canvas id="planReportTrajectoryChart"></canvas></div>
        <div id="planReportTrajectoryEmpty"></div>
        <div class="note" id="planReportTableCaption"></div>
        <div class="toolbar" id="planReportTablePager"></div>
        <div id="planReportTableBody"></div>
        ${template.breakdown ? `<div class="section-head"><h3>Monthly payment breakdown</h3></div>
        <div class="note">X: month · Y: CAD per month — each month's scheduled payment split into interest (solid) + principal (light), stacked per trajectory.</div>
        <div class="chart-wrap plan-traj-breakdown-wrap" style="height:260px"><canvas id="planReportTrajectoryBreakdownChart"></canvas></div>
        <div id="planReportTrajectoryBreakdownEmpty"></div>` : ''}
        <div id="planReportMergedTable"></div>
        <div class="note">${template.key === 'pool' ? 'Baseline: absolute figures. Strategy cells: absolute figure with delta vs baseline below. Trajectory total value = cash pool balance + stock value (investment scope — property equity excluded); Value at horizon = stock value + cash pot.' : 'Baseline: absolute figures. Strategy cells: absolute figure with delta vs baseline below. Total value = property equity + stock value; equity = assessed value − outstanding principal.'}</div>
      </div>`,
      engine: `<div data-plan-report-block="engine"><div id="planReportEngineBody">${planReportEngineHtml(planReportView)}</div></div>`,
    };
    // Maturing custom buys (user 2026-11-05 — a GIC's term): the
    // report states the maturity plainly — each product's maturity
    // date and the amount returning to the pot as cash, plus the
    // comparison's end month (the latest maturity month).
    const maturityLines = (() => {
      const mats = (rep.maturities || []);
      if (!mats.length) return '';
      const latest = mats.map((m) => m.maturityMonth).sort().pop();
      return mats.map((m) => `<div class="note">${esc(m.strategyLetter)} · ${esc(m.symbol)} matures ${esc(m.maturityDate)} — ${money2(m.amountCad)} returns to the pot as cash.</div>`).join('')
        + `<div class="note">This comparison ends ${formatYM(latest)} — the maturity month.</div>`;
    })();
    $('#planReport').innerHTML = `
      <div class="panel">
        <div class="section-head"><h3>${esc(report.name)}</h3></div>
        <div class="note plan-report-subtitle">${esc(worldLabel)} · Baseline: ${esc(comp.chosenBaseline ? comp.chosenBaseline.name : 'Do-nothing baseline')} · Strategies: ${esc(comp.strategies.map((r) => `${r.strategy.letter} · ${r.strategy.name}`).join(', ') || 'None')}</div>
        ${maturityLines}
        ${projErrLines.map((l) => `<div class="msg err">${esc(l)}</div>`).join('')}
        ${projWarnLines.map((l) => `<div class="msg warn">${esc(l)}</div>`).join('')}
        <div class="note plan-report-defs">${template.key === 'pool' ? PLAN_REPORT_DEFS_POOL : PLAN_REPORT_DEFS_PROPERTY}</div>
      </div>
      ${template.sections.map((s) => sections[s] || '').join('')}
      ${isAiReport ? `<div data-plan-report-block="refine">${planReportRefineHtml()}</div>` : ''}`;
    draws.forEach((d) => { try { d(); } catch { /* a failed chart never blocks the tables */ } });
    // Table section renders from the already-fetched trajectories.
    planReportTableRender(planReportView);
    // Comparison component: the Δ chart + payment breakdown render
    // for every report; the merged cross-strategy table inside it
    // renders only for multi-strategy reports (gated in
    // planCompareNewRender).
    try {
      const compareBlock = { scenario: comp.scenario, baseline: comp.baseline, strategies: comp.strategies, report: comp.report };
      const compareIds = {
        template,
        note: '#planReportTrajectoryNote', chart: 'planReportTrajectoryChart', empty: '#planReportTrajectoryEmpty',
        caption: '#planReportTrajCaption',
        wrapSel: '#planReportComparePanel .plan-traj-wrap',
        range: '#planReportTrajRange', breakdown: 'planReportTrajectoryBreakdownChart', breakdownEmpty: '#planReportTrajectoryBreakdownEmpty',
        breakdownWrapSel: '#planReportComparePanel .plan-traj-breakdown-wrap',
        master: '#planReportMergedTable',
        picker: '#planReportComparePicker', merged: '#planReportMergedTable', ctx: { block: null, appleIds: null },
        // Removing a pinned strategy rewrites the report's pins from
        // the rendered set (which equals the pins when pins exist)
        // and reloads, so routing recomputes from the remaining pins.
        onRemoveStrategy: async (sid) => {
          try {
            const remaining = comp.strategies.map((r) => r.strategy.id).filter((x) => x !== sid);
            await api(`/api/planning/reports/${reportId}`, { method: 'PUT', body: { strategy_ids: remaining } });
            loadPlanReport(projectId, reportId);
          } catch (err) { showMsg($('#planReportMsg'), 'err', err.message); }
        },
      };
      planCompareNewRender(compareBlock, compareIds);
      // Retained so the window slider can re-draw the breakdown chart
      // and the merged table without re-running the whole comparison
      // (which would reset the Difference chart's range slider).
      planReportView.compareT = compareIds;
    } catch { /* a failed comparison chart never blocks the report tables */ }
    planReportViewWire(planReportView);
    planReportViewSync(projectId, reportId);
    // Per-tab actions live in the sticky bar above the viewer (the
    // sync above rebuilds the bar, so fill it here before wiring);
    // the header panel keeps title/subtitle/definitions only.
    const planTabActions = $('#planReportTabActionsBar');
    if (planTabActions) planTabActions.innerHTML = `<div class="toolbar"><button class="small primary" id="planReportTabAiBtn">Follow up with AI</button><button class="small" id="planReportTabSaveBtn">Save report</button></div><div class="msg" id="planReportMsg"></div>`;
    // Follow-up conversation restores: the sticky bar is rebuilt on
    // every load, so an open panel re-renders from the per-report
    // thread state.
    planReportFollowUpRestore(projectId, reportId);
    // Per-tab actions. There is no regenerate action: the view
    // always renders live comparison data, so a per-tab Generate
    // only re-pinned the report and cleared the (misleading) stale
    // badge — both are gone (user 2026-11-06). Follow up with AI
    // toggles the inline conversation panel below the tab bar;
    // Save exports the tab as PDF via the browser print path.
    // Block Delete drops one chart from the saved definition and reloads.
    $('#planReportTabAiBtn').addEventListener('click', () => planReportFollowUpToggle(projectId, reportId));
    $('#planReportTabSaveBtn').addEventListener('click', () => window.print());
    document.querySelectorAll('[data-plan-report-block-del]').forEach((b) => b.addEventListener('click', async () => {
      const idx = Number(b.dataset.planReportBlockDel);
      if (!confirm('Delete this block from the report?')) return;
      try {
        const d = await api(`/api/planning/projects/${projectId}`);
        const rep = (d.reports || []).find((x) => x.id === reportId);
        const def = (rep && rep.definition) || {};
        const charts = [...(def.charts || [])];
        charts.splice(idx, 1);
        await api(`/api/planning/reports/${reportId}`, { method: 'PUT', body: { definition: { ...def, charts } } });
        loadPlanReport(projectId, reportId);
      } catch (err) { showMsg($('#planReportMsg'), 'err', err.message); }
    }));
    // Current tab + its pins: the tier cards above highlight them.
    planReportCurrentId = reportId;
    planReportCurrentPins = { scenarioIds, baselineId: report.baseline_id, strategyIds: renderedStrategyIds };
    planReportHighlightApply();
    planReportOutlineBuild();
  });
}
function sidsHas(series, sid) { return (series || []).includes(sid); }

async function loadPlanStrategy(id, scenarioId) {
  if (scenarioId !== undefined) planStrategyScenarioId = scenarioId;
  const q = planStrategyScenarioId !== undefined ? `?scenarioId=${planStrategyScenarioId}` : '';
  return withLoading(async () => {
    const data = await api(`/api/planning/strategies/${id}${q}`);
    planStrategyData = data;
    $('#planList').classList.add('hidden');
    // The project tier DOM is cleared, not just hidden: the strategy
    // page hosts its OWN Reports tier reusing the same viewer ids
    // (#planReportTabsHost/#planReportList/#planReport), and duplicate
    // ids would make every viewer query resolve to the hidden project
    // tier. Returning to the project re-renders it fully (and the
    // tab-restore block in loadPlanProject re-opens surviving tabs).
    $('#planProject').classList.add('hidden');
    $('#planProject').innerHTML = '';
    planReportOutlineClear();
    $('#planStrategy').classList.remove('hidden');
    $('#planScenario').classList.add('hidden');
    $('#planStrategy').innerHTML = planStrategyHtml(data);
    planStrategyWire(data);
    planBaselinePoolDoughnutDraw(data.fixedBaseline, 'planStrategyBaselinePoolChart');
    planSinkDoughnutDraw(data);
  });
}
function planLegLabel(l) {
  const src = String(l.source_ref || '');
  const srcLabel = src === 'cash' ? 'Declared cash' : src === 'pot' ? 'Cash pot' : src === 'external' ? 'External injection' : src === 'external_out' ? 'External out'
    : src.startsWith('op:') ? `Op #${src.slice(3)}` : src.startsWith('repay:') ? `Repay property #${src.slice(6)}` : src.startsWith('declared:') ? `Declared #${src.slice(9)}` : src;
  const amt = l.amount === 'all' ? 'All' : l.amount === 'remainder' ? 'Remainder' : money2(Number(l.amount));
  return `${srcLabel} · ${amt}`;
}
// Add whole days to a YYYY-MM-DD date (UTC math — no timezone
// drift). Used for a custom buy's maturity date (buy date + term).
function planAddDays(dateStr, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const dt = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}
function planStrategyHtml(d) {
  const s = d.strategy;
  const c = d.comparison;
  // Sink (user 2026-11-05, simplified): a cash-pool investment
  // strategy shows ONE Sink section instead of Operations — a
  // doughnut of where the pool goes + the buy list, buy-only, no
  // sell rows. No picker: the return lives on the scenario (stock
  // factor) or on the buy itself (a custom product's rate). Gated
  // on the fixed baseline BEING a cash pool (figures.poolValue),
  // not on the project category: an investment strategy over a
  // single account or holding has no pool and keeps Operations.
  // (baselineKind alone cannot gate this — it is 'pool' for every
  // investment project, pool entity or not.)
  const isPool = !!(d.fixedBaseline && d.fixedBaseline.kind === 'investment' && d.fixedBaseline.figures && d.fixedBaseline.figures.poolValue != null);
  const planOpCardHtml = (o) => {
    const p = o.params || {};
    // A maturing custom buy (e.g. a 180-day GIC) shows its term and
    // maturity date on the row, so the user can see it without
    // opening the edit form.
    const matDate = (o.op_type === 'buy' && p.accountId == null && p.termDays) ? planAddDays(p.date, p.termDays) : null;
    const matText = matDate ? ` · ${p.termDays} days · matures ${matDate}` : '';
    const desc = o.op_type === 'prepay' ? `Prepay ${money2(p.amount)} on ${esc(p.date || '')}${p.recurringYears > 1 ? ` yearly × ${p.recurringYears}` : ''}`
      : o.op_type === 'rate_switch' ? `Switch rate on ${esc(p.date || '')} to ${p.rateType === 'fixed' ? `${p.annualRate}% fixed` : `Prime ${p.spread >= 0 ? '+' : ''}${p.spread}`}`
      : o.op_type === 'refinance' ? `Refinance on ${esc(p.date || '')} · ${p.termMonths} months · ${p.amortizationYears}y amortization`
      : o.op_type === 'payment_change' ? `Payment → ${money2(p.payment)} from ${esc(p.date || '')}`
      : o.op_type === 'buy' ? `Buy ${p.symbol || o.holdingSymbol || ''} on ${esc(p.date || '')}${p.units ? ` · ${p.units} units` : ''}${p.amount ? ` · ${money2(p.amount)}` : ''}${matText}`
      : o.op_type === 'sell' ? `Sell ${p.units} units on ${esc(p.date || '')}`
      : `Position ${p.units} units on ${esc(p.date || '')}`;
    // A buy's funding legs resolve to money: a 'remainder'/'all' leg
    // takes the buy amount minus the other legs' fixed amounts, so
    // the row shows what the pool actually funds (sell how much).
    const legAmount = (l) => {
      if (l.amount !== 'remainder' && l.amount !== 'all') return Number(l.amount) || 0;
      const fixed = (o.legs || []).filter((x) => x !== l && Number(x.amount) > 0).reduce((s, x) => s + Number(x.amount), 0);
      return Math.max(0, (Number(p.amount) || 0) - fixed);
    };
    const legRows = (o.op_type === 'buy' || o.op_type === 'sell') ? (o.legs || []).map((l) => {
      // Pool buys are funded by the pool: the leg reads as what was
      // sold from the pool, not as a jargon "Leg · Remainder".
      const text = o.op_type === 'buy' && isPool && l.source_ref === 'cash'
        ? `Sell from pool · ${money2(legAmount(l))}`
        : `Leg · ${esc(planLegLabel(o.op_type === 'buy' ? { ...l, amount: legAmount(l) } : l))}`;
      return `
      <div class="plan-row" data-plan-leg-op="${o.id}" data-plan-leg-id="${l.id}"><span>↳ ${text}</span>
        <span class="toolbar"><button class="small" data-plan-leg-edit="${o.id}:${l.id}">Edit</button><button class="small danger" data-plan-leg-del="${o.id}:${l.id}">Delete</button></span></div>`;
    }).join('') : '';
    // A pool buy with no legs at all is pool-funded by definition —
    // show the sell line rather than nothing.
    const poolSellLine = isPool && o.op_type === 'buy' && !(o.legs || []).length
      ? `\n      <div class="plan-row"><span>↳ Sell from pool · ${money2(p.amount || 0)}</span></div>` : '';
    // The sink is gone: a pool buy's "Source: sink/manual" line is
    // stale jargon — the three figures (what / sell how much / buy
    // how much) are the row.
    const srcLine = isPool && o.op_type === 'buy' ? '' : `<div class="n">Source: ${esc(o.source || '')}</div>`;
    return `<div class="card breakdown-card plan-flow-card" data-plan-op-card="${o.id}">
      <div class="k">${o.seq}. ${esc(o.op_type)} — ${desc}</div>
      ${srcLine}${legRows}${poolSellLine}
      <div class="toolbar"><button class="small" data-plan-op-edit="${o.id}">Edit</button><button class="small danger" data-plan-op-del="${o.id}">Delete</button></div></div>`;
  };
  const opsHtml = d.ops.map(planOpCardHtml).join('');
  const buyOpsHtml = d.ops.filter((o) => o.op_type === 'buy').map(planOpCardHtml).join('');
  // Strategy page mirrors the project page's tiers (user 2026-11-04):
  // top Scenarios tier (single-select, same semantics as the old
  // picker — a click reloads the detail page under that world; the
  // flat card is scenarioId 0; cards never navigate), middle row
  // Baseline (left, the fixed-baseline metadata display) +
  // Operations (right, op entries as cards, inline Edit/Delete).
  const stratScenSel = (id) => (d.appliedScenario ? d.appliedScenario.id === id : id === 0);
  const stratScenCard = (id, name, isBase, summary, flat) => `<div class="card breakdown-card plan-flow-card${flat ? ' plan-flow-flat' : ''}${stratScenSel(id) ? ' plan-selected' : ''}" data-plan-strategy-scenario="${id}">
      <div class="k">${esc(name)}${isBase ? ' · Default' : ''}</div>
      <div class="n">${esc(summary)}</div>
      <div class="toolbar"><button class="small plan-flow-select" data-plan-strategy-scenario-select="${id}" aria-pressed="${stratScenSel(id) ? 'true' : 'false'}">${stratScenSel(id) ? '✓ Selected' : 'Select'}</button></div></div>`;
  const stratScenCards = stratScenCard(0, 'Current rates (no scenario)', false, 'Flat world — current rates', true)
    + (d.scenarios || []).map((sc) => stratScenCard(sc.id, sc.name, sc.is_base, planScenarioSummaryLine(sc.factors) || 'Flat world — current rates', false)).join('');
  // Baseline card's effective returns run under the applied world.
  // A disabled stock factor follows the default world (history rates).
  const fbScen = d.appliedScenario ? (d.scenarios || []).find((x) => x.id === d.appliedScenario.id) : null;
  const fbScenStock = fbScen && fbScen.factors && fbScen.factors.stock && fbScen.factors.stock.enabled !== false ? { name: fbScen.name, stock: fbScen.factors.stock } : null;
  return `
    <div><a id="planStrategyBackLink" href="#planning/project/${d.project.id}">← Back to ${esc(d.project.name)}</a></div>
    <div class="panel">
      <div class="section-head"><h3 id="planStrategyTitle">${esc(s.letter)} · ${esc(s.name)}${s.merged ? ' · Merged' : ''}</h3>
        <div class="toolbar" id="planStrategyHeaderTools">
          ${s.merged
            ? '<button class="small" id="planRevertBtn">Revert merge</button>'
            : '<button class="small primary" id="planMergeBtn">Merge</button>'}
          <button class="small" id="planStrategyRenameBtn">Edit</button>
          <button class="small danger" id="planStrategyDeleteBtn">Delete</button>
        </div>
      </div>
      <div class="msg" id="planStrategyMsg"></div>
      ${c.errors && c.errors.length ? `<div class="msg err">${esc(c.errors.join('; '))}</div>` : ''}
    </div>
    <div class="panel" id="planStrategyFlowPanel">
      <div class="plan-flow-tier" id="planStrategyScenarioTier">
      <div class="section-head"><h3>Scenarios</h3></div>
      <div id="planStrategyScenarioCards">${stratScenCards}</div>
      </div>
      <div class="plan-flow-tier plan-flow-tier-mid" id="planStrategyMidTier">
      <div class="plan-flow-group" id="planStrategyBaselineGroup">
      <div class="section-head"><h3>Baseline</h3></div>
      <div id="planStrategyFixedBaseline">${planFixedBaselineHtml(d.fixedBaseline, fbScenStock, { chartId: 'planStrategyBaselinePoolChart' })}</div>
      </div>
      ${isPool ? `
      <div class="plan-flow-group" id="planStrategySinkGroup">
      <div class="section-head"><h3>Sink</h3></div>
      <div class="card breakdown-card plan-flow-card" id="planSinkPanel">
      <div class="chart-wrap" style="height:200px"><canvas id="planSinkDoughnutChart"></canvas></div>
      <div id="planSinkDoughnutTable"></div>
      <div id="planSinkBuyList">${buyOpsHtml || '<div class="note">No buys yet — the pool is held as-is.</div>'}</div>
      <div class="toolbar"><button class="small" id="planSinkAddBuyBtn">+ Add buy</button></div>
      <div class="msg" id="planOpsMsg"></div>
      </div>
      </div>` : `
      <div class="plan-flow-group" id="planStrategyOpsGroup">
      <div class="section-head"><h3>Operations</h3></div>
      <div class="card breakdown-card plan-flow-card" id="planStrategyOpsCard">
      <div class="toolbar" id="planStrategyOpsToolbar">${d.project.category === 'property' ? `<button class="small" data-plan-quick-op="prepay">Prepay</button><button class="small" data-plan-quick-op="refinance">Refinance</button><button class="small" data-plan-quick-op="rate_switch">Rate switch</button><button class="small" data-plan-quick-op="payment_change">Payment change</button>` : ''}<button class="small" id="planAddOpBtn">+ Add operation</button></div>
      <div id="planStrategyOpCards">${opsHtml || '<div class="note">No operations yet.</div>'}</div>
      </div>
      <div class="msg" id="planOpsMsg"></div>
      </div>`}
      </div>
    </div>
    <div class="panel" id="planStrategyReportsPanel">
      <div class="section-head"><h3>Reports</h3>
        <div class="toolbar"><button class="small primary" id="planStrategyGenerateBtn">Generate report</button><button class="small" id="planStrategyAiReportBtn">Generate with AI</button></div>
      </div>
      <div class="msg" id="planStrategyReportMsg"></div>
      <div id="planReportTabsHost"></div>
      <div id="planReportList"></div>
      <div id="planReport"></div>
    </div>`;
}
function planStrategyWire(d) {
  const s = d.strategy;
  const mergeBtn = $('#planMergeBtn');
  if (mergeBtn) mergeBtn.addEventListener('click', () => openPlanMergeModal(s.id, false));
  const revertBtn = $('#planRevertBtn');
  if (revertBtn) revertBtn.addEventListener('click', () => openPlanMergeModal(s.id, true));
  $('#planStrategyDeleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete strategy "${s.name}"?`)) return;
    try { await api(`/api/planning/strategies/${s.id}`, { method: 'DELETE' }); location.hash = `#planning/project/${d.project.id}`; }
    catch (err) { showMsg($('#planStrategyMsg'), 'err', err.message); }
  });
  // Header rename: Edit swaps the title for an input + Save/Cancel.
  const renameBtn = $('#planStrategyRenameBtn');
  if (renameBtn) renameBtn.addEventListener('click', () => {
    const title = $('#planStrategyTitle');
    const tools = $('#planStrategyHeaderTools');
    if (!title || !tools || title.querySelector('input')) return;
    title.innerHTML = `<input id="planStrategyNameInput" value="${esc(s.name)}">`;
    const save = document.createElement('button');
    save.className = 'small primary';
    save.id = 'planStrategyRenameSave';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'small';
    cancel.id = 'planStrategyRenameCancel';
    cancel.textContent = 'Cancel';
    renameBtn.replaceWith(save);
    tools.appendChild(cancel);
    // ✨ name from the strategy's op sequence (entity is context only).
    const star = document.createElement('button');
    star.className = 'small';
    star.textContent = '✨';
    star.title = 'Suggest a name with AI';
    star.addEventListener('click', () => {
      const ops = (d.ops || []).map((o) => ({ op_type: o.op_type, params: o.params || {}, ...(o.legs && o.legs.length ? { legs: o.legs.map((l) => ({ source_ref: l.source_ref, amount: l.amount })) } : {}) }));
      const entLabel = (d.entityProperty && d.entityProperty.address) || (d.fixedBaseline && d.fixedBaseline.label) || null;
      planAiSuggestName(star, input, 'strategy', { ops, category: d.project.category || null, entityLabel: entLabel }, $('#planStrategyMsg'));
    });
    tools.insertBefore(star, save);
    const input = $('#planStrategyNameInput');
    input.focus();
    input.select();
    cancel.addEventListener('click', () => loadPlanStrategy(s.id));
    save.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { showMsg($('#planStrategyMsg'), 'err', 'strategy name is required'); return; }
      try { await api(`/api/planning/strategies/${s.id}`, { method: 'PUT', body: { name } }); loadPlanStrategy(s.id); }
      catch (err) { showMsg($('#planStrategyMsg'), 'err', err.message); }
    });
  });
  // Funding-leg lines: Edit swaps the line for the leg editor (same
  // row shape as the op modal, minus its Delete button); Delete
  // drops the leg via the op PUT, which re-validates the survivors.
  // Legs render as card lines now (Item B op cards), not table rows:
  // the editor fills the card line itself, no <td> wrappers.
  document.querySelectorAll('[data-plan-leg-edit]').forEach((b) => b.addEventListener('click', async () => {
    const [opId, legId] = b.dataset.planLegEdit.split(':').map(Number);
    const op = d.ops.find((o) => o.id === opId);
    const leg = op ? (op.legs || []).find((l) => l.id === legId) : null;
    if (!op || !leg) return;
    const row = b.closest('tr') || b.closest('[data-plan-leg-id]');
    try {
      const ctx = await planLoadOpCtx(d.project.id, s.id);
      const btns = `<div class="toolbar"><button class="small primary" id="planLegSaveBtn">Save</button><button class="small" id="planLegCancelBtn">Cancel</button></div>`;
      row.innerHTML = row.tagName === 'TR'
        ? `<td></td><td>↳ Leg</td><td colspan="2">${planLegRowHtml(op.op_type, ctx, leg, false)}</td>
        <td class="toolbar"><button class="small primary" id="planLegSaveBtn">Save</button><button class="small" id="planLegCancelBtn">Cancel</button></td>`
        : `${planLegRowHtml(op.op_type, ctx, leg, false)}${btns}`;
      row.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
      const modeSel = row.querySelector('.plan-leg-mode');
      const amtInput = row.querySelector('.plan-leg-amount');
      if (modeSel) modeSel.addEventListener('change', () => {
        amtInput.disabled = modeSel.value !== 'fixed';
        if (amtInput.disabled) amtInput.value = '';
      });
      row.querySelector('#planLegCancelBtn').addEventListener('click', () => loadPlanStrategy(s.id));
      row.querySelector('#planLegSaveBtn').addEventListener('click', async () => {
        try {
          const src = row.querySelector('.plan-leg-src').value;
          const mode = row.querySelector('.plan-leg-mode').value;
          const amount = mode === 'fixed' ? parseMoneyInput(row.querySelector('.plan-leg-amount').value) : mode;
          const legs = (op.legs || []).map((l) => (l.id === legId ? { source_ref: src, amount } : { source_ref: l.source_ref, amount: l.amount }));
          await api(`/api/planning/ops/${opId}`, { method: 'PUT', body: { legs } });
          loadPlanStrategy(s.id);
        } catch (err) { showMsg($('#planOpsMsg'), 'err', err.message); }
      });
    } catch (err) { showMsg($('#planOpsMsg'), 'err', err.message); }
  }));
  document.querySelectorAll('[data-plan-leg-del]').forEach((b) => b.addEventListener('click', async () => {
    const [opId, legId] = b.dataset.planLegDel.split(':').map(Number);
    const op = d.ops.find((o) => o.id === opId);
    if (!op) return;
    try {
      const legs = (op.legs || []).filter((l) => l.id !== legId).map((l) => ({ source_ref: l.source_ref, amount: l.amount }));
      await api(`/api/planning/ops/${opId}`, { method: 'PUT', body: { legs } });
      loadPlanStrategy(s.id);
    } catch (err) { showMsg($('#planOpsMsg'), 'err', err.message); }
  }));
  const isPool = !!(d.fixedBaseline && d.fixedBaseline.kind === 'investment' && d.fixedBaseline.figures && d.fixedBaseline.figures.poolValue != null);
  const addOpBtn = $('#planAddOpBtn');
  if (addOpBtn) addOpBtn.addEventListener('click', () => openPlanOpModal(s.id, null));
  document.querySelectorAll('[data-plan-quick-op]').forEach((b) => b.addEventListener('click', () => openPlanOpModal(s.id, null, b.dataset.planQuickOp)));
  // Merged Sink: the buy list's + Add buy opens the buy form locked
  // to buy (no operation-type select — the section is buy-only).
  const addBuyBtn = $('#planSinkAddBuyBtn');
  if (addBuyBtn) addBuyBtn.addEventListener('click', () => openPlanOpModal(s.id, null, 'buy', { title: 'Add buy', lockType: true }));
  planStrategyReportsWire(d);
  document.querySelectorAll('[data-plan-op-edit]').forEach((b) => b.addEventListener('click', () => {
    const op = d.ops.find((o) => o.id === Number(b.dataset.planOpEdit));
    openPlanOpModal(s.id, op, null, isPool && op && op.op_type === 'buy' ? { title: 'Edit buy' } : null);
  }));
  document.querySelectorAll('[data-plan-op-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/planning/ops/${b.dataset.planOpDel}`, { method: 'DELETE' }); loadPlanStrategy(s.id); }
    catch (err) { showMsg($('#planOpsMsg'), 'err', err.message); }
  }));
  // Scenarios tier: single-select, same semantics as the old picker
  // (a click reloads the detail page under that world; the flat
  // card is scenarioId 0). Cards never navigate.
  document.querySelectorAll('[data-plan-strategy-scenario-select]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); loadPlanStrategy(s.id, Number(b.dataset.planStrategyScenarioSelect)); }));
  document.querySelectorAll('[data-plan-strategy-scenario]').forEach((card) => card.addEventListener('click', () => loadPlanStrategy(s.id, Number(card.dataset.planStrategyScenario))));
}
// Strategy-tier Reports wiring (ENGINE round, item 7): the routing
// displays and the aiHits() guard are GONE (both Generate buttons
// are always available — choosing the button IS choosing the
// engine), but the tier keeps its two Generate handlers and its
// report list. The report's scenario pins follow the page's current
// world (the Scenarios tier single-select): flat (0/undefined) pins
// nothing, a picked scenario pins it. Restored from ff9c2a9 minus
// the removed picker/guard — the wholesale cut dropped the list
// and the handlers with them.
function planStrategyReportsWire(d) {
  const s = d.strategy;
  const pid = d.project.id;
  const panel = $('#planStrategyReportsPanel');
  if (!panel) return;
  const scenarios = d.scenarios || [];
  // The page's current world: the APPLIED scenario the numbers ran
  // under (server default = base scenario when none is picked, N =
  // scenario N, null = explicit flat). Pinning the applied scenario
  // is pinning the world on screen, never a silent fallback — the
  // old planStrategyScenarioId mapping sent [] for the base world,
  // which the server rightly rejects ("pin at least one scenario")
  // on any project that has scenarios (user 2026-11-05, found by
  // the op+sink-merge Generate pin).
  const currentScenarioIds = () => (d.appliedScenario ? [d.appliedScenario.id] : []);
  const pickedBaseline = () => (d.fixedBaseline ? d.fixedBaseline.recordId : null);
  $('#planStrategyGenerateBtn').addEventListener('click', async () => {
    const msg = $('#planStrategyReportMsg');
    try {
      const scenarioIds = currentScenarioIds();
      // Kind-aware preset definition (user 2026-11-04): a cash-pool
      // baseline gets a pool trajectory chart, never the hardcoded
      // Mortgage balance chart; property/other keep it. The preset
      // POST stays permissive — the viewer enforces at render.
      const presetCharts = d.baselineKind === 'pool'
        ? [{ template: 'time_line', title: 'Cash pool', series: ['pool_balance', 'stock_value'] }, { template: 'fan_band', title: 'Stock volatility fan', series: ['stock_value'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }]
        : [{ template: 'time_line', title: 'Mortgage balance', series: ['mortgage_balance'] }, { template: 'metric_cards', title: 'Headlines', series: ['cost', 'gain', 'net'] }];
      const r = await api(`/api/planning/projects/${pid}/reports`, { method: 'POST', body: { name: `Report · ${s.letter} · ${s.name}`, definition: { strategies: [s.id], charts: presetCharts }, baseline_id: pickedBaseline(), strategy_ids: [s.id], scenario_ids: scenarioIds } });
      // AI-handler pattern: reload first so the Generate gate opens
      // (headline + kind panels render), then open the new tab.
      await loadPlanStrategy(s.id);
      planOpenReportTab(pid, r.report.id);
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
  $('#planStrategyAiReportBtn').addEventListener('click', () => openPlanReportAiModal(pid, {
    lockedStrategyIds: [s.id],
    defaultScenarioIds: currentScenarioIds(),
    afterSave: async (reportId) => { await loadPlanStrategy(s.id); loadPlanReport(pid, reportId); },
  }));
  api(`/api/planning/projects/${pid}`).then((proj) => {
    // LIST, filtered to this strategy (same card template as the
    // project tier; same records, filtered view).
    const filtered = (proj.reports || []).filter((r) => {
      if (r.strategy_ids == null) return true;
      try { const ids = JSON.parse(r.strategy_ids); return Array.isArray(ids) && ids.includes(s.id); } catch { return false; }
    });
    const list = $('#planReportList');
    list.innerHTML = filtered.map((r) => planReportCardHtml(r, { scenarios })).join('') || '<div class="note">No reports yet.</div>';
    panel.querySelectorAll('[data-plan-report-view]').forEach((el) => {
      el.addEventListener('click', () => { planOpenReportTab(pid, Number(el.dataset.planReportView)); });
    });
    panel.querySelectorAll('[data-plan-report-del]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await api(`/api/planning/reports/${b.dataset.planReportDel}`, { method: 'DELETE' }); loadPlanStrategy(s.id); }
      catch (err) { showMsg($('#planStrategyReportMsg'), 'err', err.message); }
    }));
    // OPEN restore: a surviving tab re-renders only when it belongs
    // to this strategy's list; otherwise the tier stays on LIST
    // (tabs themselves are per-project state, preserved for the
    // project page and for strategies whose list includes them).
    if (planReportTabsProject === pid && planReportTabs.length) {
      const cur = planReportTabs.find((t) => t.id === planReportCurrentId) || planReportTabs[planReportTabs.length - 1];
      if (filtered.some((r) => r.id === cur.id)) loadPlanReport(pid, cur.id);
    }
  }).catch(() => { /* list stays empty; pickers still work */ });
}



// Strategy factors editor: prime (history chart + date/rate points +
// view presets), stock return (historical suggestions), growth rates.
// State lives in planFactorState; Save sends the whole set.
let planFactorState = null;
let planFactorActive = new Set();
let planFactorRedrawPrime = null;
let planFactorMonthPopWired = false;

// ------------------------------------------------- strategy diff --
// Strategy detail "Difference vs baseline": month-by-month rows
// built client-side from the strategy GET payload (baseline +
// projection series; entity-scoped for property projects, summed
// across properties otherwise). Balance Δ =
// baseline − strategy (lower is better); interest saved =
// baseline − strategy; value Δ = strategy − baseline. Annual
// rollup: balances/values are year-end, Equity Δ is the year's
// PEAK monthly balance advantage, interest saved is the year's
// SUM. Range presets run from the projection start (first N×12
// months); All is the default — projections have no 1-year
// trailing default. Charts are legend-toggle-only like every
// planning chart (never wired to the Colors panel).
// -------------------------------------------- project comparison --
// Shared comparison renderers: report-only since the project-page
// panel was removed. The report view passes report-scoped ids +
// its own picker/range state; the same code renders the Δ chart,
// the breakdown bars and the merged table.
function planMortAbs(proj, side) {
  let payment = null, payoff = null;
  for (const per of Object.values((proj.mortgage && proj.mortgage.perProperty) || {})) {
    const s = per[side];
    if (!s) continue;
    if (s.paymentAtEffect != null) payment = (payment || 0) + s.paymentAtEffect;
    if (s.payoffMonth && (!payoff || s.payoffMonth > payoff)) payoff = s.payoffMonth;
  }
  const interest = proj.mortgage ? (side === 'baseline' ? proj.mortgage.baselineInterest : proj.mortgage.strategyInterest) : null;
  return { payment, payoff, interest };
}
// Monthly-payment scope for a comparison block: when every strategy
// touches the same properties, the shared baseline cell is exactly
// that set's baseline payment (and the label names a lone property).
// When strategies touch different sets, the shared cell covers the
// union of touched properties — strategy cells and Apple deltas
// always stay per-strategy scoped. Null (no scopes on the payload)
// falls back to the old project-total behavior.
function planPaymentScopeMeta(block) {
  const scopes = (block.strategies || []).map((r) => r.paymentScope).filter(Boolean);
  if (!scopes.length) return null;
  const keyOf = (s) => (s.propertyIds || []).slice().sort((a, b) => a - b).join(',');
  const first = scopes[0];
  if (scopes.every((s) => keyOf(s) === keyOf(first))) return { label: first.label || 'Monthly payment', baseline: first.baseline };
  const union = [...new Set(scopes.flatMap((s) => s.propertyIds || []))];
  let baseline = null;
  for (const pid of union) {
    const per = block.baseline && block.baseline.mortgage && block.baseline.mortgage.perProperty && block.baseline.mortgage.perProperty[pid];
    const s = per && per.baseline;
    if (s && s.paymentAtEffect != null) baseline = (baseline == null ? 0 : baseline) + s.paymentAtEffect;
  }
  return { label: 'Monthly payment', baseline };
}
function planBaselineValue(block) {
  const first = block.strategies[0];
  if (first && first.comparison && first.comparison.baselineValueAtHorizon != null) return first.comparison.baselineValueAtHorizon;
  const trajs = (block.report && block.report.trajectories) || [];
  const base = trajs.find((t) => t.key === 'baseline') || trajs[0];
  if (base && base.monthly && base.monthly.length) return base.monthly[base.monthly.length - 1].total_value;
  return null;
}
// Difference-chart range (user 2026-11-06): a dual-thumb slider above
// the chart, the same component as the headline window — two overlaid
// range inputs, both handles draggable, they cannot cross. State is
// per-ctx indices into the trajectory months ({ startIdx, endIdx });
// default = All (the full trajectory months). The slider is
// independent of the headline slider: it drives only this chart +
// the Difference table below it.
function planTrajIdxs(months, st) {
  if (!months.length) return { startIdx: 0, endIdx: -1 };
  const end = Math.min(Math.max(st.endIdx ?? months.length - 1, 0), months.length - 1);
  const start = Math.min(Math.max(st.startIdx ?? 0, 0), end);
  return { startIdx: start, endIdx: end };
}
function planTrajEffectiveRange(months, st) {
  if (!months.length) return [];
  const { startIdx, endIdx } = planTrajIdxs(months, st);
  return months.slice(startIdx, endIdx + 1);
}
function planTrajWindowLabel(months, st) {
  if (!months.length) return '';
  const { startIdx, endIdx } = planTrajIdxs(months, st);
  const count = endIdx - startIdx + 1;
  const all = startIdx === 0 && endIdx === months.length - 1;
  return `${formatYM(months[startIdx])} – ${formatYM(months[endIdx])} · ${count} months${all ? ' · All' : ''}`;
}
function planTrajRangeHtml(st, months) {
  if (!months.length) return '';
  const { startIdx, endIdx } = planTrajIdxs(months, st);
  const maxIdx = months.length - 1;
  return `<div class="plan-headline-window">
    <label>Range</label>
    <div class="plan-range-dual" id="planReportTrajWindowDual">
      <div class="plan-range-track" id="planReportTrajWindowTrack"></div>
      <input type="range" id="planReportTrajWindowStart" min="0" max="${maxIdx}" step="1" value="${startIdx}" aria-label="Difference range start month">
      <input type="range" id="planReportTrajWindowEnd" min="0" max="${maxIdx}" step="1" value="${endIdx}" aria-label="Difference range end month">
    </div>
    <span id="planReportTrajWindowLabel">${esc(planTrajWindowLabel(months, st))}</span>
  </div>`;
}
// Paint the track fill between the two handles (0–100% of the range).
function planTrajWindowTrackFill(months, st) {
  const track = $('#planReportTrajWindowTrack');
  if (!track || !months.length) return;
  const maxIdx = months.length - 1;
  const { startIdx, endIdx } = planTrajIdxs(months, st);
  const lo = maxIdx ? (startIdx / maxIdx) * 100 : 0;
  const hi = maxIdx ? (endIdx / maxIdx) * 100 : 100;
  track.style.background = `linear-gradient(to right, #d7dee6 0%, #d7dee6 ${lo}%, #2f7de1 ${lo}%, #2f7de1 ${hi}%, #d7dee6 ${hi}%, #d7dee6 100%)`;
}
// Difference window for the report table: the slider's window on the
// report view's comparison ctx, or the full trajectory months when
// the comparison has not rendered yet (the table renders before the
// comparison on first load — and the default window IS the full
// range, so the first render is already correct).
function planTrajWindowMonths(view) {
  const trajs = (view.comp.report && view.comp.report.trajectories) || [];
  const months = trajs.length ? ((trajs[0].monthly || []).map((m) => m.month)) : [];
  if (!months.length) return null;
  const st = (view.compareT && view.compareT.trajState) || null;
  if (!st) return { months, startIdx: 0, endIdx: months.length - 1 };
  const { startIdx, endIdx } = planTrajIdxs(months, st);
  return { months, startIdx, endIdx };
}
// Monthly difference rows from baseline + strategy projections —
// now used only by the comparison Δ chart (the strategy-page
// Difference panel and its table moved into the report view).
function planDiffMonthly(d) {
  const rows = new Map();
  const row = (m) => {
    if (!rows.has(m)) rows.set(m, { month: m, balBase: null, balStrat: null, intBase: null, intStrat: null, prinBase: null, prinStrat: null, valBase: null, valStrat: null });
    return rows.get(m);
  };
  for (const per of Object.values((d.baseline.mortgage && d.baseline.mortgage.perProperty) || {})) {
    for (const pt of ((per.baseline && per.baseline.series) || [])) { const r = row(pt.month); r.balBase = (r.balBase || 0) + pt.balance; r.intBase = (r.intBase || 0) + pt.interest; r.prinBase = (r.prinBase || 0) + (pt.principal || 0); }
  }
  for (const per of Object.values((d.projection.mortgage && d.projection.mortgage.perProperty) || {})) {
    for (const pt of ((per.strategy && per.strategy.series) || [])) { const r = row(pt.month); r.balStrat = (r.balStrat || 0) + pt.balance; r.intStrat = (r.intStrat || 0) + pt.interest; r.prinStrat = (r.prinStrat || 0) + (pt.principal || 0); }
  }
  for (const pt of (((d.baseline.stocks) || {}).series || [])) { const r = row(pt.month); r.valBase = (r.valBase || 0) + pt.value; }
  for (const pt of (((d.projection.stocks) || {}).series || [])) { const r = row(pt.month); r.valStrat = (r.valStrat || 0) + pt.value; }
  return [...rows.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((r) => ({
    ...r,
    balDiff: (r.balBase != null && r.balStrat != null) ? r.balBase - r.balStrat : null,
    intSaved: (r.intBase != null && r.intStrat != null) ? r.intBase - r.intStrat : null,
    valDiff: (r.valBase != null && r.valStrat != null) ? r.valStrat - r.valBase : null,
  }));
}

// The shared report window's month list for a comparison block, or
// null when the report view does not cover this block (the
// Difference chart's own range is the fallback then).
function planCompareWindowMonths(block) {
  const view = planReportView;
  if (!view || !view.comp || !view.comp.report || !block || block.report !== view.comp.report) return null;
  const months = planHeadlineWindowMonths(view);
  if (!months.length) return null;
  return months.slice(planHeadlineWindowStartIdx(view), planHeadlineWindowEndIdx(view) + 1);
}
// Monthly payment breakdown, drawn over the shared report window
// (user 2026-11-06 — the same window as the headline), NOT over the
// Difference chart's own range: the breakdown is part of the
// comparison section, so it follows the slider. Re-drawn on every
// slider input via planReportWindowRefresh.
function planCompareBreakdownDraw(t, months) {
  const block = t.block || {};
  const bWrap = document.querySelector(t.breakdownWrapSel);
  const bEmpty = $(t.breakdownEmpty);
  // Payment breakdown (property template only — the pool template
  // has no breakdown section at all, so there is nothing to draw
  // or hide here): baseline + mortgage-touching picked
  // trajectories only. A strategy with no mortgage ops must not
  // render mortgage bars at all — its interest/principal series are
  // the untouched mainline mortgages, not the strategy's effect.
  // With no mortgage-touching strategy picked, the whole block hides
  // (this hide stays inside the property template).
  const hasBreakdown = !t.template || t.template.breakdown !== false;
  if (!hasBreakdown) {
    planDestroyChart(t.breakdown);
    return;
  }
  const trajs = (block.report && block.report.trajectories) || [];
  if (!trajs.length || !(months || []).length) {
    planDestroyChart(t.breakdown);
    return;
  }
  const picked = (block.strategies || []).filter((r) => (t.getAppleIds ? t.getAppleIds() : []).includes(r.strategy.id));
  const byMonth = (tr) => { const m = new Map((tr.monthly || []).map((r) => [r.month, r])); return (mo) => m.get(mo); };
  const mortPickedIds = picked.filter((r) => r.touchesMortgage).map((r) => r.strategy.id);
  if (!mortPickedIds.length) {
    if (bWrap) bWrap.style.display = 'none';
    planDestroyChart(t.breakdown);
    if (bEmpty) bEmpty.innerHTML = '';
    return;
  }
  if (bWrap) bWrap.style.display = '';
  if (bEmpty) bEmpty.innerHTML = '';
  const shownTrajs = trajs.filter((tr) => tr.key === 'baseline' || mortPickedIds.includes(Number(tr.key)));
  const bDatasets = [];
  shownTrajs.forEach((tr, i) => {
    const get = byMonth(tr);
    bDatasets.push({ label: `${tr.label} interest`, data: months.map((mo) => { const r = get(mo); return r == null ? null : (r.interest || 0); }), backgroundColor: planColor(i), stack: tr.label });
    bDatasets.push({ label: `${tr.label} principal`, data: months.map((mo) => { const r = get(mo); return r == null ? null : (r.principal || 0); }), backgroundColor: planColorAlpha(planColor(i), 0.45), stack: tr.label });
  });
  planBarChart(t.breakdown, months.map(formatYM), bDatasets);
}
// Difference chart draw (extracted from planCompareNewRender so the
// range slider can redraw the chart + table on every input without
// re-running the whole comparison — rebuilding the range HTML
// mid-drag would destroy the input being dragged).
function planTrajChartDraw(t, block, effMonths) {
  const trajs = (block.report && block.report.trajectories) || [];
  const months = trajs.length ? ((trajs[0].monthly || []).map((m) => m.month)) : [];
  const picked = block.strategies.filter((r) => t.getAppleIds().includes(r.strategy.id));
  const wrap = document.querySelector(t.wrapSel);
  const empty = $(t.empty);
  const bWrap = document.querySelector(t.breakdownWrapSel);
  const bEmpty = $(t.breakdownEmpty);
  if (trajs.length && effMonths.length) {
    if (wrap) wrap.style.display = '';
    if (empty) empty.innerHTML = '';
    // Difference chart. Property reports draw a BALANCE trajectory
    // (baseline + each mortgage-touching strategy, actual $) instead
    // of the Δ lines: the Δ chart hid the story — Value Δ sat flat
    // at $0 for a mortgage-only strategy, the Balance Δ lines
    // overlapped, the axis ran dead to the horizon year, and a line
    // going DOWN meant "worse off". After the switch month a strategy
    // line above the baseline reads at a glance as owing more. Pool
    // reports draw the same absolute-trajectory shape for VALUE
    // (baseline + each strategy, actual $) with a translucent band
    // between the baseline and each strategy — the band IS the Value
    // Δ, and the Δ numbers live in the table below the chart. The X
    // axis ends at the baseline's last month (its payoff): the
    // comparison only exists while the baseline exists, and the
    // series themselves end at payoff with balance 0, so running to
    // the latest strategy payoff would make every end label $0.
    // A Value Δ line is drawn only when it moves (nonzero
    // somewhere); an all-$0 Value Δ is a one-line note instead, in
    // either chart mode.
    const noStockMoveNote = '<div class="note">This comparison moves no stocks — Value Δ is $0.</div>';
    if (picked.length) {
      const diffRows = picked.map((r) => ({ r, monthly: planDiffMonthly({ baseline: block.baseline, projection: r.projection }) }));
      const hasStockMove = diffRows.some(({ monthly }) => monthly.some((m) => m.valDiff != null && m.valDiff !== 0));
      const isPool = !!(t.template && t.template.key === 'pool');
      let drewBalance = false;
      if (!isPool) {
        // Baseline's last month: the last row carrying a balance
        // (balBase is the same for every strategy — it comes from
        // the shared baseline — so the first picked row suffices).
        let baseLastMonth = null;
        for (const m of diffRows[0].monthly) if (m.balBase != null) baseLastMonth = m.month;
        const balMonths = baseLastMonth == null ? [] : effMonths.filter((mo) => mo <= baseLastMonth);
        if (balMonths.length) {
          const baseByMo = new Map(diffRows[0].monthly.map((m) => [m.month, m]));
          const balDatasets = [{ label: 'Baseline', data: balMonths.map((mo) => { const m = baseByMo.get(mo); return m == null ? null : m.balBase; }), borderColor: planColor(0), backgroundColor: planColor(0), spanGaps: true }];
          const balShorts = ['Baseline'];
          diffRows.forEach(({ r, monthly }) => {
            if (!r.touchesMortgage || !monthly.some((m) => m.balStrat != null)) return;
            const byMo = new Map(monthly.map((m) => [m.month, m]));
            // Compact color index (baseline 0, then strategies in
            // order) — the same mapping the payment breakdown uses,
            // so a strategy keeps its color across both charts.
            const ci = balDatasets.length;
            balDatasets.push({ label: `${r.strategy.letter} · ${r.strategy.name}`, data: balMonths.map((mo) => { const m = byMo.get(mo); return m == null ? null : m.balStrat; }), borderColor: planColor(ci), backgroundColor: planColor(ci), spanGaps: true });
            balShorts.push(r.strategy.letter);
          });
          if (balDatasets.length > 1) {
            const endLabels = balDatasets.map((ds, i) => {
              let v = null;
              for (let k = ds.data.length - 1; k >= 0; k--) { if (ds.data[k] != null) { v = ds.data[k]; break; } }
              return v == null ? null : `${balShorts[i]} · $${moneyTick(Math.round(v))}`;
            });
            planLineChart(t.chart, balMonths.map(formatYM), balDatasets, { endLabels });
            drewBalance = true;
            if (empty) empty.innerHTML = hasStockMove ? '' : noStockMoveNote;
            const caption = t.caption ? $(t.caption) : null;
            if (caption) caption.textContent = 'X: month · Y: CAD — outstanding mortgage balance. A strategy line above the baseline means it owes more.';
          }
        }
      }
      if (!drewBalance) {
        if (isPool) {
          // Pool Difference chart (user 2026-11-06): absolute
          // trajectories — the baseline line + each picked strategy
          // line — with a translucent band between the baseline and
          // each strategy; the band IS the diff. The Δ line is gone
          // (the Δ numbers live in the table below the chart). A
          // strategy that moves no stocks coincides with the
          // baseline, so with no move at all only the baseline line
          // is drawn, plus the one-line note. The band fills to
          // dataset 0 (the baseline) and is hidden from the tooltip,
          // the legend, and the end labels.
          const baseHas = diffRows[0].monthly.some((m) => m.valBase != null);
          const stratLines = diffRows.filter(({ monthly }) => monthly.some((m) => m.valStrat != null));
          if (baseHas && stratLines.length) {
            const baseByMo = new Map(diffRows[0].monthly.map((m) => [m.month, m]));
            const valDatasets = [{ label: 'Baseline', data: effMonths.map((mo) => { const m = baseByMo.get(mo); return m == null ? null : m.valBase; }), borderColor: planColor(0), backgroundColor: planColor(0), spanGaps: true }];
            const valShorts = ['Baseline'];
            if (hasStockMove) {
              let ci = 1;
              stratLines.forEach(({ r, monthly }) => {
                const byMo = new Map(monthly.map((m) => [m.month, m]));
                const data = effMonths.map((mo) => { const m = byMo.get(mo); return m == null ? null : m.valStrat; });
                valDatasets.push({ label: `${r.strategy.letter} · ${r.strategy.name}`, data, borderColor: planColor(ci), backgroundColor: planColor(ci), spanGaps: true });
                valShorts.push(r.strategy.letter);
                valDatasets.push({ label: '', band: true, data, fill: 0, borderColor: planColor(ci), backgroundColor: planColorAlpha(planColor(ci), 0.12), borderWidth: 0, pointRadius: 0, spanGaps: true });
                valShorts.push('');
                ci += 1;
              });
            }
            const endLabels = valDatasets.map((ds, i) => {
              if (ds.band) return null;
              let v = null;
              for (let k = ds.data.length - 1; k >= 0; k--) { if (ds.data[k] != null) { v = ds.data[k]; break; } }
              return v == null ? null : `${valShorts[i]} · $${moneyTick(Math.round(v))}`;
            });
            planLineChart(t.chart, effMonths.map(formatYM), valDatasets, {
              endLabels,
              tooltipFilter: (it) => !it.dataset.band,
              legendFilter: (item, data) => !data.datasets[item.datasetIndex].band,
            });
            if (empty) empty.innerHTML = hasStockMove ? '' : noStockMoveNote;
            const caption = t.caption ? $(t.caption) : null;
            if (caption) caption.textContent = hasStockMove
              ? 'X: month · Y: CAD — Baseline and strategy lines show absolute value; the shaded band between them is the Value Δ (strategy value − baseline value).'
              : 'X: month · Y: CAD — Baseline value; the strategy moves no stocks, so it tracks the baseline exactly (Value Δ is $0).';
          } else { planDestroyChart(t.chart); if (empty) empty.innerHTML = '<div class="note">No difference data.</div>'; }
        } else {
          const dDatasets = [];
          diffRows.forEach(({ r, monthly }, i) => {
            const byMo = new Map(monthly.map((m) => [m.month, m]));
            if (r.touchesMortgage && monthly.some((m) => m.balDiff != null)) dDatasets.push({ label: `${r.strategy.letter} · ${r.strategy.name} · Balance Δ`, data: effMonths.map((mo) => { const m = byMo.get(mo); return m == null ? null : m.balDiff; }), borderColor: planColor(2 * i), backgroundColor: planColor(2 * i), spanGaps: true });
            if (monthly.some((m) => m.valDiff != null && m.valDiff !== 0)) dDatasets.push({ label: `${r.strategy.letter} · ${r.strategy.name} · Value Δ`, data: effMonths.map((mo) => { const m = byMo.get(mo); return m == null ? null : m.valDiff; }), borderColor: planColor(2 * i + 1), backgroundColor: planColor(2 * i + 1), spanGaps: true });
          });
          if (dDatasets.length) {
            planLineChart(t.chart, effMonths.map(formatYM), dDatasets);
            if (empty) empty.innerHTML = hasStockMove ? '' : noStockMoveNote;
            const caption = t.caption ? $(t.caption) : null;
            if (caption) {
              // The caption names only what is actually drawn: a
              // Balance Δ line exists only when a picked strategy
              // touches a mortgage, so a pool report (Value Δ only)
              // never carries the mortgage text.
              const drewBalDelta = dDatasets.some((d) => /Balance Δ/.test(d.label));
              caption.textContent = drewBalDelta ? 'X: month · Y: CAD — Balance Δ = baseline balance − strategy balance (positive = strategy owes less); Value Δ = strategy value − baseline value.' : 'X: month · Y: CAD — Value Δ = strategy value − baseline value.';
            }
          } else { planDestroyChart(t.chart); if (empty) empty.innerHTML = '<div class="note">No difference data.</div>'; }
        }
      }
    } else {
      planDestroyChart(t.chart);
      if (empty) empty.innerHTML = '<div class="note">Pick a strategy to compare.</div>';
    }
  } else {
    planDestroyChart(t.chart);
    planDestroyChart(t.breakdown);
    if (wrap) wrap.style.display = 'none';
    if (bWrap) bWrap.style.display = 'none';
    if (empty) empty.innerHTML = `<div class="note">${trajs.length && months.length ? 'No months in this range.' : 'No trajectory data.'}</div>`;
    if (bEmpty) bEmpty.innerHTML = '';
  }
}

function planCompareNewRender(block, ids) {
  const t = ids;
  t.block = block;
  if (t.appleIds == null) t.appleIds = block.strategies.map((r) => r.strategy.id);
  // Picker state lives on the passed ctx so each report view's
  // picker re-renders only its own panel.
  t.getAppleIds = () => t.appleIds;
  t.setAppleIds = (v) => { t.appleIds = v; };
  const note = $(t.note);
  if (note) note.textContent = block.scenario ? `Under ${block.scenario.name}` : 'Current rates (no scenario)';
  const trajs = (block.report && block.report.trajectories) || [];
  const months = trajs.length ? ((trajs[0].monthly || []).map((m) => m.month)) : [];
  // Difference range (user 2026-11-06): a dual-thumb slider above the
  // chart, same component as the headline window — both handles drag,
  // they cannot cross. Default = All (the full trajectory months).
  // The slider is independent of the headline slider: it drives only
  // this chart + the Difference table below it.
  if (t.trajState == null) t.trajState = { startIdx: 0, endIdx: months.length - 1 };
  const trajState = t.trajState;
  const trajNorm = planTrajIdxs(months, trajState);
  trajState.startIdx = trajNorm.startIdx;
  trajState.endIdx = trajNorm.endIdx;
  const rangeEl = $(t.range);
  if (rangeEl) {
    rangeEl.innerHTML = planTrajRangeHtml(trajState, months);
    // Slider input redraws the chart + table in place (never the whole
    // comparison — that would rebuild the slider DOM mid-drag).
    const trajRedraw = () => {
      planTrajWindowTrackFill(months, trajState);
      const lab = $('#planReportTrajWindowLabel');
      if (lab) lab.textContent = planTrajWindowLabel(months, trajState);
      planTrajChartDraw(t, block, planTrajEffectiveRange(months, trajState));
      planReportTableRender(planReportView);
    };
    const trajStart = rangeEl.querySelector('#planReportTrajWindowStart');
    if (trajStart) trajStart.addEventListener('input', () => {
      trajState.startIdx = Math.min(Number(trajStart.value), trajState.endIdx);
      trajStart.value = String(trajState.startIdx);
      trajRedraw();
    });
    const trajEnd = rangeEl.querySelector('#planReportTrajWindowEnd');
    if (trajEnd) trajEnd.addEventListener('input', () => {
      trajState.endIdx = Math.max(Number(trajEnd.value), trajState.startIdx);
      trajEnd.value = String(trajState.endIdx);
      trajRedraw();
    });
    planTrajWindowTrackFill(months, trajState);
  }
  const effMonths = planTrajEffectiveRange(months, trajState);
  planTrajChartDraw(t, block, effMonths);
  // The breakdown follows the shared window even when the Difference
  // chart's own range is empty — it is a comparison-section chart,
  // not a Difference-chart chart.
  planCompareBreakdownDraw(t, planCompareWindowMonths(block) || effMonths);
  // Strategy picker: horizontal toggle chips at the panel top. One
  // picker drives the difference chart, the breakdown bars and the
  // merged table. Each pinned chip also carries a × that removes
  // the strategy from the report's pins (PUT + reload) —
  // persistent, unlike the chip toggle, which only hides it from
  // this view.
  const picker = $(t.picker);
  if (picker) {
    const removable = typeof t.onRemoveStrategy === 'function';
    picker.innerHTML = block.strategies.map((r) => {
      const chip = `<button class="small plan-pick-chip${t.getAppleIds().includes(r.strategy.id) ? ' active' : ''}" data-plan-apple="${r.strategy.id}" aria-pressed="${t.getAppleIds().includes(r.strategy.id) ? 'true' : 'false'}">${esc(r.strategy.letter)} · ${esc(r.strategy.name)}</button>`;
      return removable
        ? `<span class="plan-pick-chipwrap">${chip} <button class="small plan-pick-remove" data-plan-remove="${r.strategy.id}" title="Remove from report">×</button></span>`
        : chip;
    }).join(' ');
    picker.querySelectorAll('[data-plan-apple]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.planApple);
      const cur = t.getAppleIds();
      t.setAppleIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
      planCompareNewRender(block, ids);
    }));
    if (removable) picker.querySelectorAll('[data-plan-remove]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.planRemove);
      const row = block.strategies.find((r) => r.strategy.id === id);
      if (!row) return;
      if (confirm(`Remove ${row.strategy.letter} · ${row.strategy.name} from this report?`)) t.onRemoveStrategy(id);
    }));
  }
  // The merged cross-strategy table renders only when the report
  // pins multiple strategies (item 9): it IS the project report's
  // strategy对比 section. The Δ chart and the payment breakdown
  // above stay for every report — they compare each strategy
  // against the baseline, not strategies against each other.
  if (block.strategies.length > 1) planMergedRender(t);
  else { const m = $(t.merged); if (m) m.innerHTML = ''; }
}
// Merged comparison table: one table replaces the old Master +
// Apple pair. Baseline column: absolute figures. Each picked
// strategy cell: its absolute figure with the delta vs baseline
// below it (dimmed); vs-baseline-only rows keep their single figure.
// The Monthly payment row keeps the payment-scope rule (only the
// properties the strategy's mortgage ops touch; single touched
// property names its address in the row label; stock-only is '—').
// Payoff honesty: the shift sums per-property month shifts, so it
// need not equal the difference of the displayed months — the
// displayed month is the LATEST payoff across properties, while the
// shift may come from a property that is not the latest. Month +
// shift show together only when they are arithmetically consistent
// (strategy month = baseline month − shift); otherwise the shift
// alone (old Apple form), never a pair that contradicts itself.
function planMergedRender(t) {
  const block = t.block;
  if (!block) return;
  const appleIds = t.getAppleIds();
  const picked = block.strategies.filter((r) => appleIds && appleIds.includes(r.strategy.id));
  // The merged table's mortgage rows follow the report TEMPLATE
  // (baseline kind), not the picked strategies' op nature: a pool
  // report has no mortgage rows even when a picked strategy touches
  // a mortgage — the baseline wins over op nature, the same rule
  // the Difference table already applies. The property template
  // keeps them.
  const showMortRows = !t.template || t.template.mergedMortgageRows !== false;
  const baseAbs = planMortAbs(block.baseline, 'baseline');
  const payMeta = planPaymentScopeMeta(block);
  const baseValue = planBaselineValue(block);
  // Shared window (user 2026-11-06): the merged table's cumulative
  // rows recompute over the window — Total interest / Total gain /
  // Value at horizon / Total cost (+ Stock gain, Net benefit, and
  // the Payoff cells). The Monthly payment row is a per-month
  // figure and never moves. At the full horizon the settled
  // comparison figures apply. Equity Δ (a peak over the horizon)
  // and Principal Δ (total buy cash) are not windowed in this round
  // — they keep their full-horizon settled values.
  const view = planReportView;
  const win = (view && view.comp && view.comp.report && block.report === view.comp.report)
    ? (() => {
        const months = planHeadlineWindowMonths(view);
        if (!months.length) return null;
        const startIdx = planHeadlineWindowStartIdx(view);
        const endIdx = planHeadlineWindowEndIdx(view);
        return { months, startIdx, endIdx, startMonth: months[startIdx], endMonth: months[endIdx], isFull: planHeadlineWindowIsFull(view) };
      })()
    : null;
  const windowed = !!(win && !win.isFull);
  const winTrajs = windowed ? ((block.report && block.report.trajectories) || []) : [];
  const winByMonth = (traj) => new Map(((traj && traj.monthly) || []).map((r) => [r.month, r]));
  const winBaseByMonth = windowed ? winByMonth(winTrajs[0] || { monthly: [] }) : null;
  const winMonthsIn = windowed ? win.months.slice(win.startIdx, win.endIdx + 1) : [];
  const winSum = (byMonth, field) => winMonthsIn.reduce((s, m) => s + (((byMonth.get(m) || {}))[field] || 0), 0);
  const winAt = (byMonth, field) => (byMonth.get(win.endMonth) || {})[field];
  const winStratByMonth = (row) => winByMonth(winTrajs.find((x) => x.key === String(row.strategy.id)) || { monthly: [] });
  const winFigCache = new Map();
  const winFigs = (row) => {
    if (!winFigCache.has(row.strategy.id)) winFigCache.set(row.strategy.id, planHeadlineWindowedFor(view, row));
    return winFigCache.get(row.strategy.id);
  };
  const anyPayoffBeyond = windowed && [baseAbs.payoff, ...picked.map((r) => planMortAbs(r.projection, 'strategy').payoff)]
    .filter(Boolean).some((p) => win.endMonth < p);
  const months = (v) => (v == null ? '—' : ((v >= 0 ? '+' : '') + v + ' months'));
  const rows = [
    { mort: true, label: payMeta ? payMeta.label : 'Monthly payment', base: payMeta ? planMoney(payMeta.baseline) : planMoney(baseAbs.payment), strat: (r) => {
      const abs = r.paymentScope ? planMoney(r.paymentScope.strategy) : planMoney(planMortAbs(r.projection, 'strategy').payment);
      const dv = r.paymentScope ? r.paymentScope.delta : r.comparison.paymentDelta;
      const delta = planSigned(dv);
      if (abs === '—' && delta === '—') return { single: '—' };
      return { abs, delta, bold: dv != null && dv !== 0 };
    } },
    { mort: true, label: 'Total interest', base: planMoney(windowed ? winSum(winBaseByMonth, 'interest') : baseAbs.interest), strat: (r) => {
      const wf = windowed ? winFigs(r) : null;
      const dv = wf ? -wf.interestSaved : (r.comparison.interestSaved == null ? null : -r.comparison.interestSaved);
      return { abs: planMoney(windowed ? winSum(winStratByMonth(r), 'interest') : planMortAbs(r.projection, 'strategy').interest), delta: planSigned(dv), bold: dv != null && dv !== 0 };
    } },
    { mort: true, label: 'Payoff', base: windowed ? ((baseAbs.payoff && win.endMonth >= baseAbs.payoff) ? baseAbs.payoff : '—') : (baseAbs.payoff || '—'), strat: (r) => {
      const shift = r.comparison.payoffShiftMonths;
      const stratPayoff = planMortAbs(r.projection, 'strategy').payoff || '—';
      const ymIdx = (s) => (s && /^\d{4}-\d{2}$/.test(s) ? Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) : null);
      if (windowed) {
        // Same rule as the headline shift: the shift shows once the
        // window reaches at least one payoff; a payoff the window
        // has not reached yet reads '—'.
        const payoffs = [baseAbs.payoff, stratPayoff === '—' ? null : stratPayoff].filter(Boolean);
        if (!payoffs.length || !payoffs.some((p) => win.endMonth >= p)) return { single: '—' };
        return { abs: (stratPayoff !== '—' && win.endMonth >= stratPayoff) ? stratPayoff : '—', delta: months(shift), bold: shift !== 0 };
      }
      const consistent = shift != null && ymIdx(baseAbs.payoff) != null && ymIdx(stratPayoff) != null
        && (ymIdx(stratPayoff) - ymIdx(baseAbs.payoff)) === -shift;
      if (consistent) return { abs: stratPayoff, delta: months(shift), bold: shift !== 0 };
      return { single: months(shift), bold: shift != null && shift !== 0 };
    } },
    { label: 'Value at horizon', base: planMoney(windowed ? winAt(winBaseByMonth, 'total_value') : baseValue), strat: (r) => {
      const dv = windowed
        ? (() => { const s = winAt(winStratByMonth(r), 'total_value'); const b = winAt(winBaseByMonth, 'total_value'); return (s != null && b != null) ? s - b : null; })()
        : (r.comparison.valueAtHorizon != null && r.comparison.baselineValueAtHorizon != null) ? r.comparison.valueAtHorizon - r.comparison.baselineValueAtHorizon : null;
      return { abs: planMoney(windowed ? winAt(winStratByMonth(r), 'total_value') : r.comparison.valueAtHorizon), delta: planSigned(dv), bold: dv != null && dv !== 0 };
    } },
    { label: 'Total cost', base: '—', strat: (r) => ({ single: planMoney(windowed ? winFigs(r).cost : r.comparison.cost) }) },
    { label: 'Total gain', base: '—', strat: (r) => ({ single: planMoney(windowed ? winFigs(r).gain : r.comparison.gain) }) },
    { label: 'Stock gain', base: '—', strat: (r) => ({ single: planMoney(windowed ? winFigs(r).stockGain : r.comparison.stockGain) }) },
    { label: 'Net benefit', base: '—', strat: (r) => ({ single: planSigned(windowed ? winFigs(r).net : r.comparison.net) }) },
    { label: 'Equity Δ', base: '—', strat: (r) => ({ single: r.equityDelta != null ? planSigned(r.equityDelta) : '—', bold: r.equityDelta != null && r.equityDelta !== 0 }) },
    { label: 'Principal Δ', base: '—', strat: (r) => ({ single: r.principalDelta != null ? planSigned(r.principalDelta) : '—', bold: r.principalDelta != null && r.principalDelta !== 0 }) },
  ];
  const shownRows = showMortRows ? rows : rows.filter((row) => !row.mort);
  const cell = (c) => (c.single != null
    ? `<td${c.bold ? ' class="plan-diff"' : ''}>${c.single}</td>`
    : `<td><div>${c.abs}</div><div class="plan-cell-delta${c.bold ? ' plan-diff' : ''}">${c.delta}</div></td>`);
  const head = '<tr><th></th><th>Baseline</th>' + picked.map((r) => `<th>${esc(r.strategy.letter)} · ${esc(r.strategy.name)}</th>`).join('') + '</tr>';
  const body = shownRows.map((row) => `<tr><td>${row.label}</td><td>${row.base}</td>` + picked.map((r) => cell(row.strat(r))).join('') + '</tr>').join('');
  const host = $(t.merged);
  if (!host) return;
  host.innerHTML = `<table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table>`
    + (picked.length === 0 && block.strategies.length > 0 ? '<div class="note">Pick a strategy to compare.</div>' : '')
    + (anyPayoffBeyond ? '<div class="note">Payoff is beyond this window.</div>' : '');
}

function planScenarioHtml(d) {
  const sc = d.scenario;
  const line = planScenarioSummaryLine(sc.factors);
  return `
    <div><a href="#planning/project/${d.project.id}">← Back to ${esc(d.project.name)}</a></div>
    <div class="panel">
      <div class="section-head"><h3>${esc(sc.name)}${sc.is_base ? ' · Default' : ''}</h3>
        <div class="toolbar">
          ${sc.is_base ? '' : '<button class="small" id="planScenarioBaseBtn">Set as default</button>'}
          <button class="small" id="planScenarioEditBtn">Edit</button>
          ${sc.is_base ? '' : '<button class="small danger" id="planScenarioDeleteBtn">Delete</button>'}
        </div>
      </div>
      <div class="msg" id="planScenarioMsg"></div>
      <div class="n">${line ? esc(line) : 'Flat world — current rates'}</div>
      ${(d.droppedPrimeSteps || []).map((s) => `<div class="msg warn">${esc(s.message)}</div>`).join('')}
    </div>
    <div class="panel" id="planFactorsPanel">
      <div class="section-head"><h3>Factors</h3></div>
      <div class="toolbar" id="planFactorChecks"></div>
      <div id="planFactorPrime"></div>
      <div id="planFactorStock"></div>
      <div id="planFactorGrowth"></div>
      <div class="toolbar"><button class="small primary" id="planFactorSaveBtn">Save factors</button></div>
      <div class="msg" id="planFactorMsg"></div>
    </div>`;
}
async function loadPlanScenario(id) {
  return withLoading(async () => {
    const data = await api(`/api/planning/scenarios/${id}`);
    $('#planList').classList.add('hidden');
    $('#planProject').classList.add('hidden');
    planReportOutlineClear();
    $('#planStrategy').classList.add('hidden');
    $('#planScenario').classList.remove('hidden');
    $('#planScenario').innerHTML = planScenarioHtml(data);
    planScenarioWire(data);
  });
}
function planScenarioWire(d) {
  const sc = d.scenario;
  $('#planScenarioEditBtn').addEventListener('click', () => {
    $('#planScenarioEditForm').dataset.scenarioId = sc.id;
    $('#planScenarioEditTitle').textContent = `Edit scenario · ${sc.name}`;
    $('#planScenarioEditName').value = sc.name;
    showMsg($('#planScenarioEditMsg'), '', '');
    openModal('planScenarioEditModal');
  });
  const delBtn = $('#planScenarioDeleteBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete scenario "${sc.name}"?`)) return;
    try { await api(`/api/planning/scenarios/${sc.id}`, { method: 'DELETE' }); location.hash = `#planning/project/${d.project.id}`; }
    catch (err) { showMsg($('#planScenarioMsg'), 'err', err.message); }
  });
  const baseBtn = $('#planScenarioBaseBtn');
  if (baseBtn) baseBtn.addEventListener('click', async () => {
    try { await api(`/api/planning/scenarios/${sc.id}/set-base`, { method: 'POST' }); loadPlanScenario(sc.id); }
    catch (err) { showMsg($('#planScenarioMsg'), 'err', err.message); }
  });
  planScenarioFactorWire(d);
}
$('#planScenarioEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#planScenarioEditMsg');
  try {
    const name = $('#planScenarioEditName').value.trim();
    if (!name) throw new Error('Scenario name is required');
    await api(`/api/planning/scenarios/${form.dataset.scenarioId}`, { method: 'PUT', body: { name } });
    closeModalEl($('#planScenarioEditModal'));
    loadPlanScenario(Number(form.dataset.scenarioId));
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// ---- shared scenario stock-factor editor (detail page + create modal) ----
// State shape (mutated live by the editor):
//   { valuePct?, basis?, window?, byHolding?: { [holdingId]: { valuePct, basis?, window? } } }
// Read-only by default: each holding shows its EFFECTIVE value — the
// per-holding override when set, else a stored scenario default, else
// the holding's own history (never invented; no history = 0%/yr).
// "+ Override" opens an editable input prefilled with the current
// effective value; Remove clears the override (back to history /
// default). There is no global-default input and no Revert button:
// a stored global default survives only as legacy data (labeled
// "Scenario default"), and removing an override returns the row to
// history. Callers save planStockFactorClean(st) (empty = null).
const planStockHistCache = new Map();
function planParsePct(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}
function planStockFactorClean(st) {
  if (!st || typeof st !== 'object') return null;
  const out = {};
  const g = planParsePct(st.valuePct);
  if (g != null) { out.valuePct = g; if (st.basis) out.basis = st.basis; if (st.window) out.window = st.window; }
  const bh = {};
  for (const [k, v] of Object.entries(st.byHolding || {})) {
    if (!v || typeof v !== 'object') continue;
    const x = planParsePct(v.valuePct);
    if (x == null) continue;
    bh[k] = { valuePct: x, ...(v.basis ? { basis: v.basis } : {}), ...(v.window ? { window: v.window } : {}) };
  }
  if (Object.keys(bh).length) out.byHolding = bh;
  return Object.keys(out).length ? out : null;
}
function planStockFactorRender(host, st, holdings, opts = {}) {
  if (!host) return;
  if (!st.byHolding || typeof st.byHolding !== 'object' || Array.isArray(st.byHolding)) st.byHolding = {};
  const list = holdings || [];
  // Rows with an open override input (created by "+ Override" or by a
  // stored override, which renders as its editor directly).
  const editing = new Set();
  // Effective value for a holding, in priority order: per-holding
  // override → a stored scenario default (legacy data only; the input
  // is gone) → the holding's own history → nothing (0%/yr, no history).
  // The override label never changes without an edit; the history
  // label fills in when the suggestion arrives.
  const effOf = (h) => {
    const ov = st.byHolding[h.id];
    if (ov && planParsePct(ov.valuePct) != null) return { pct: Number(ov.valuePct), label: `${ov.valuePct}%/yr · Override` };
    if (planParsePct(st.valuePct) != null) return { pct: Number(st.valuePct), label: `${st.valuePct}%/yr · Scenario default` };
    const cached = planStockHistCache.get(h.id);
    if (cached === undefined) return { pct: null, label: 'history…' };
    if (!cached) return { pct: null, label: '0%/yr · No history' };
    return { pct: cached.pct, label: `${cached.pct}%/yr · History (${esc(cached.basis)}${cached.window ? ` · ${esc(cached.window)}` : ''})` };
  };
  const rowHtml = (h) => {
    const eff = effOf(h);
    const hasOv = !!(st.byHolding[h.id] && planParsePct(st.byHolding[h.id].valuePct) != null);
    const open = editing.has(String(h.id)) || hasOv;
    return `<div class="plan-row"><span>${esc(h.accountName || '')} · ${esc(h.symbol || h.label || '')}</span><span data-plan-stock-eff="${h.id}">${eff.label}</span>${open
      ? `<span><input type="text" inputmode="decimal" data-money data-plan-stock-holding="${h.id}" value="${hasOv ? st.byHolding[h.id].valuePct : (eff.pct != null ? eff.pct : 0)}" style="width:110px"> %/yr <button class="small" data-plan-stock-unoverride="${h.id}">Remove</button></span>`
      : `<span><button class="small" data-plan-stock-override="${h.id}">+ Override</button></span>`}</div>`;
  };
  const refreshEff = (hid) => {
    const el = host.querySelector(`[data-plan-stock-eff="${hid}"]`);
    const h = list.find((x) => Number(x.id) === Number(hid));
    if (el && h) el.innerHTML = effOf(h).label;
  };
  const renderRows = () => {
    const box = host.querySelector('[data-plan-stock-rows]');
    if (!box) return;
    box.innerHTML = list.map(rowHtml).join('') || '<div class="note">No holdings.</div>';
    box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
    box.querySelectorAll('[data-plan-stock-override]').forEach((btn) => btn.addEventListener('click', () => {
      editing.add(btn.dataset.planStockOverride);
      renderRows();
      const inp = box.querySelector(`[data-plan-stock-holding="${btn.dataset.planStockOverride}"]`);
      if (inp) { inp.focus(); inp.select(); }
    }));
    box.querySelectorAll('[data-plan-stock-holding]').forEach((inp) => inp.addEventListener('input', () => {
      const hid = inp.dataset.planStockHolding;
      const raw = inp.value.replace(/,/g, '').trim();
      if (raw === '') { delete st.byHolding[hid]; editing.delete(hid); renderRows(); return; }
      const v = planParsePct(inp.value);
      if (v == null) return; // mid-typing; keep the previous value
      st.byHolding[hid] = { valuePct: v };
      refreshEff(hid);
    }));
    box.querySelectorAll('[data-plan-stock-unoverride]').forEach((btn) => btn.addEventListener('click', () => {
      const hid = btn.dataset.planStockUnoverride;
      delete st.byHolding[hid];
      editing.delete(hid);
      renderRows();
    }));
  };
  host.innerHTML = `<div class="section-head"><h3>Stock return</h3></div><div data-plan-stock-rows></div><div class="note">Past returns do not predict future returns.</div>`;
  renderRows();
  // History values fill in as suggestions arrive (cached across
  // renders); rows with an override or a scenario default never show
  // history.
  list.forEach(async (h) => {
    if (planStockHistCache.has(h.id)) { refreshEff(h.id); return; }
    try {
      const r = await api(`/api/planning/return-suggestions?holdingId=${h.id}`);
      const win = (r.suggestions || []).find((x) => x.annualizedReturn != null);
      planStockHistCache.set(h.id, win ? { pct: Math.round(win.annualizedReturn * 10000) / 100, basis: win.basis || null, window: win.window || null } : null);
    } catch { planStockHistCache.set(h.id, null); }
    refreshEff(h.id);
  });
}

function planScenarioFactorWire(d) {
  const sc = d.scenario;
  const hasMortgageOps = (d.ops || []).some((o) => ['prepay', 'rate_switch', 'refinance', 'payment_change'].includes(o.op_type));
  const cur = d.scenario.factors && typeof d.scenario.factors === 'object' ? d.scenario.factors : {};
  planFactorState = {
    prime: { points: (cur.prime && Array.isArray(cur.prime.points) ? cur.prime.points.map((pt) => ({ month: pt.month, rate: pt.rate })) : []), preset: (cur.prime && cur.prime.preset) || null, enabled: !(cur.prime && cur.prime.enabled === false) },
    stock: cur.stock ? { valuePct: cur.stock.valuePct, basis: cur.stock.basis || null, window: cur.stock.window || null, byHolding: (cur.stock.byHolding && typeof cur.stock.byHolding === 'object' ? cur.stock.byHolding : {}), enabled: cur.stock.enabled !== false } : null,
    propertyGrowth: cur.propertyGrowth ? { valuePct: cur.propertyGrowth.valuePct, enabled: cur.propertyGrowth.enabled !== false } : null,
    salaryGrowth: cur.salaryGrowth ? { valuePct: cur.salaryGrowth.valuePct, enabled: cur.salaryGrowth.enabled !== false } : null,
    rentGrowth: cur.rentGrowth ? { valuePct: cur.rentGrowth.valuePct, enabled: cur.rentGrowth.enabled !== false } : null,
  };
  // Checkbox factors: every applicable factor has a checkbox; its
  // component renders only when checked. Unchecked = that dimension
  // follows the default world, but the VALUES STAY in the saved data
  // (carried as enabled: false) and come back when re-checked. A
  // factor with stored values starts checked; a never-set factor
  // starts unchecked and is not saved until it has a value.
  planFactorActive = new Set();
  if (planFactorState.prime.enabled && (planFactorState.prime.points.length || planFactorState.prime.preset)) planFactorActive.add('prime');
  if (planFactorState.stock && planFactorState.stock.enabled !== false) planFactorActive.add('stock');
  if (planFactorState.propertyGrowth && planFactorState.propertyGrowth.enabled !== false) planFactorActive.add('propertyGrowth');
  if (planFactorState.salaryGrowth && planFactorState.salaryGrowth.enabled !== false) planFactorActive.add('salaryGrowth');
  if (planFactorState.rentGrowth && planFactorState.rentGrowth.enabled !== false) planFactorActive.add('rentGrowth');
  let primeInfo = null;
  let holdings = [];
  const primeHost = $('#planFactorPrime');
  const stockHost = $('#planFactorStock');
  const growthHost = $('#planFactorGrowth');
  const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, 1)); dt.setUTCMonth(dt.getUTCMonth() + 1); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; };
  const nowYm = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; };
  // The shared month picker writes the picked month onto the button
  // itself; sync it into factor state (and redraw) whenever a factor
  // point month is picked.
  const syncPrimePointsFromDom = () => {
    if (!primeHost) return;
    const pts = [];
    primeHost.querySelectorAll('#planPrimePoints .plan-row').forEach((row) => {
      const btn = row.querySelector('[data-plan-month]');
      const inp = row.querySelector('[data-prime-rate]');
      if (btn && inp && btn.dataset.value) pts.push({ month: btn.dataset.value, rate: Number(inp.value) });
    });
    if (pts.length) planFactorState.prime.points = pts;
  };
  const drawPrimeChart = () => {
    const canvas = document.getElementById('planFactorPrimeChart');
    if (!canvas || !primeInfo) return;
    const hist = (primeInfo.history || []).map((pt) => ({ month: String(pt.date).slice(0, 7), rate: Number(pt.rate) }));
    const pts = planFactorState.prime.points;
    const labelSet = new Set(hist.map((h) => h.month));
    pts.forEach((pt) => labelSet.add(pt.month));
    const labels = [...labelSet].sort();
    const histData = labels.map((m) => {
      let last = null;
      for (const h of hist) { if (h.month <= m) last = h.rate; else break; }
      return last;
    });
    const lastHistMonth = hist.length ? hist[hist.length - 1].month : null;
    const lastHistRate = hist.length ? hist[hist.length - 1].rate : null;
    const futData = labels.map((m) => {
      if (!pts.length) return null;
      if (lastHistMonth && m < lastHistMonth) return null;
      let last = null;
      for (const pt of pts) { if (pt.month <= m) last = pt.rate; else break; }
      if (last != null) return last;
      return lastHistRate; // holds at the last actual prime until the first point
    });
    planDestroyChart('planFactorPrimeChart');
    planCharts['planFactorPrimeChart'] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Historical prime', data: histData, borderColor: '#888', backgroundColor: '#888', fill: false, pointRadius: 0, spanGaps: true },
        { label: 'Your future path', data: futData, borderColor: '#1668c4', backgroundColor: '#1668c4', fill: false, pointRadius: 3, spanGaps: true },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => `${v}%` } } },
        plugins: { tooltip: { callbacks: { label: (it) => ` ${it.dataset.label}: ${it.parsed.y}%` } } },
      },
    });
  };
  const FACTOR_LABELS = { prime: 'Prime', stock: 'Stock return', propertyGrowth: 'Property growth', salaryGrowth: 'Salary growth', rentGrowth: 'Rent growth' };
  // One checkbox per applicable factor, always visible. Unchecking
  // hides the component but keeps its values (saved with
  // enabled: false); re-checking restores them.
  const renderFactorChecks = () => {
    const row = $('#planFactorChecks');
    if (!row) return;
    const avail = ['prime', 'stock'];
    if (d.project.category === 'property' || hasMortgageOps) avail.push('propertyGrowth');
    if (d.project.category === 'earning') avail.push('salaryGrowth', 'rentGrowth');
    row.innerHTML = avail.map((k) => `<label class="check"><input type="checkbox" data-factor-check="${k}" ${planFactorActive.has(k) ? 'checked' : ''}> ${FACTOR_LABELS[k]}</label>`).join('');
    row.querySelectorAll('[data-factor-check]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.factorCheck;
      if (cb.checked) planFactorActive.add(k); else planFactorActive.delete(k);
      renderAllFactors();
    }));
  };
  const renderAllFactors = () => { renderPrime(); renderStock(); renderGrowth(); renderFactorChecks(); };
  const renderPrime = () => {
    if (!primeHost) return;
    if (!planFactorActive.has('prime')) { primeHost.innerHTML = ''; return; }
    const st = planFactorState.prime;
    const curRate = primeInfo && primeInfo.current ? primeInfo.current.rate : null;
    const presetBtns = [['optimistic', 'Optimistic (prime down)'], ['pessimistic', 'Pessimistic (prime up)'], ['up', 'Up'], ['down', 'Down'], ['flat', 'Flat']]
      .map(([k, label]) => `<button class="small" data-plan-prime-preset="${k}">${label}</button>`).join(' ');
    primeHost.innerHTML = `
      <div class="section-head"><h3>Prime</h3></div>
      <div class="note">Today's prime: ${curRate != null ? `${curRate}%` : '—'} · No points = prime stays at today's rate. Between points the rate holds until the next point.</div>
      <div class="chart-wrap" style="height:220px"><canvas id="planFactorPrimeChart"></canvas></div>
      <div class="toolbar">${presetBtns}</div>
      <div id="planPrimePoints">${st.points.map((pt, i) => `
        <div class="plan-row"><button type="button" class="month-field" data-plan-month data-value="${pt.month}">${formatYM(pt.month)}</button>
        <input type="number" step="0.01" data-prime-rate="${i}" value="${pt.rate}" style="width:90px"> %
        <button class="small danger" data-prime-del="${i}">Remove</button></div>`).join('') || '<div class="note">No future points yet — pick a preset or add a point.</div>'}
      </div>
      <div class="toolbar"><button class="small" id="planPrimeAddBtn">+ Add point</button></div>`;
    drawPrimeChart();
    primeHost.querySelectorAll('[data-plan-prime-preset]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await api(`/api/planning/prime-presets?preset=${b.dataset.planPrimePreset}`);
        planFactorState.prime = { points: r.points || [], preset: r.preset };
        renderPrime();
      } catch (err) { showMsg($('#planFactorMsg'), 'err', err.message); }
    }));
    primeHost.querySelectorAll('[data-prime-rate]').forEach((inp) => inp.addEventListener('input', () => {
      const i = Number(inp.dataset.primeRate);
      planFactorState.prime.points[i].rate = Number(inp.value);
      planFactorState.prime.preset = null;
      drawPrimeChart();
    }));
    primeHost.querySelectorAll('[data-prime-del]').forEach((b) => b.addEventListener('click', () => {
      planFactorState.prime.points.splice(Number(b.dataset.primeDel), 1);
      planFactorState.prime.preset = null;
      renderPrime();
    }));
    const addBtn = $('#planPrimeAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      syncPrimePointsFromDom();
      const pts = planFactorState.prime.points;
      const last = pts.length ? pts[pts.length - 1] : null;
      pts.push({ month: last ? nextYm(last.month) : nowYm(), rate: last ? last.rate : (curRate != null ? curRate : 0) });
      planFactorState.prime.preset = null;
      renderPrime();
    });
  };
  const renderStock = () => {
    if (!stockHost) return;
    if (!planFactorActive.has('stock')) { stockHost.innerHTML = ''; return; }
    if (!planFactorState.stock || typeof planFactorState.stock !== 'object') planFactorState.stock = {};
    // Shared editor (also used by the create modal): read-only
    // effective values with an on-demand "+ Override" per holding.
    planStockFactorRender(stockHost, planFactorState.stock, holdings, {});
  };
  const renderGrowth = () => {
    if (!growthHost) return;
    const rows = [];
    if ((d.project.category === 'property' || hasMortgageOps) && planFactorActive.has('propertyGrowth')) rows.push(['propertyGrowth', 'Property value growth (% / year)', planFactorState.propertyGrowth]);
    if (d.project.category === 'earning') {
      if (planFactorActive.has('salaryGrowth')) rows.push(['salaryGrowth', 'Salary growth (% / year)', planFactorState.salaryGrowth]);
      if (planFactorActive.has('rentGrowth')) rows.push(['rentGrowth', 'Rent growth (% / year)', planFactorState.rentGrowth]);
    }
    if (!rows.length) { growthHost.innerHTML = ''; return; }
    growthHost.innerHTML = `<div class="section-head"><h3>Growth</h3></div>` + rows.map(([k, label, v]) => `
      <div><label>${label}</label><input type="text" inputmode="decimal" data-money data-growth="${k}" value="${v && v.valuePct != null ? v.valuePct : ''}"></div>`).join('')
      + (d.project.category === 'earning' ? `<div class="note">Salary and rent growth are stored and labeled only — the projection has no earnings leg yet, so they do not change numbers.</div>` : '');
    growthHost.querySelectorAll('[data-growth]').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.growth;
      const v = inp.value.replace(/,/g, '').trim();
      planFactorState[k] = v === '' ? null : { valuePct: Number(v) };
    }));
  };
  $('#planFactorSaveBtn').addEventListener('click', async () => {
    const msg = $('#planFactorMsg');
    try {
      syncPrimePointsFromDom();
      const st = planFactorState;
      // Stock state is live-edited by the shared editor (read-only
      // rows + on-demand overrides); save its cleaned shape, or
      // nothing when every field is blank (same as before: a blank
      // factor is not saved). Every saved factor carries its enabled
      // flag: unchecked factors keep their values in data (enabled:
      // false) and are not computed; re-checking restores them.
      if (st.stock) st.stock = planStockFactorClean(st.stock);
      const factors = {};
      if (st.prime.points.length || st.prime.preset) factors.prime = { points: st.prime.points, preset: st.prime.preset, enabled: planFactorActive.has('prime') };
      if (st.stock) factors.stock = { ...st.stock, enabled: planFactorActive.has('stock') };
      if (st.propertyGrowth) factors.propertyGrowth = { ...st.propertyGrowth, enabled: planFactorActive.has('propertyGrowth') };
      if (st.salaryGrowth) factors.salaryGrowth = { ...st.salaryGrowth, enabled: planFactorActive.has('salaryGrowth') };
      if (st.rentGrowth) factors.rentGrowth = { ...st.rentGrowth, enabled: planFactorActive.has('rentGrowth') };
      await api(`/api/planning/scenarios/${sc.id}`, { method: 'PUT', body: { factors } });
      showMsg(msg, 'ok', 'Factors saved');
      loadPlanScenario(sc.id);
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
  // Wired once: the shared picker runs before this listener (registered
  // later), so the picked month is already on the button when we sync
  // state and redraw the chart through the latest closure.
  planFactorRedrawPrime = drawPrimeChart;
  if (!planFactorMonthPopWired) {
    planFactorMonthPopWired = true;
    $('#monthPop').addEventListener('click', (e) => {
      const cell = e.target.closest('button[data-ym]');
      if (!cell || !planMonthBtn || !planMonthBtn.closest('#planPrimePoints')) return;
      if (!planFactorState) return;
      const pts = [];
      document.querySelectorAll('#planPrimePoints .plan-row').forEach((row) => {
        const btn = row.querySelector('[data-plan-month]');
        const inp = row.querySelector('[data-prime-rate]');
        if (btn && inp && btn.dataset.value) pts.push({ month: btn.dataset.value, rate: Number(inp.value) });
      });
      if (pts.length) planFactorState.prime.points = pts;
      if (planFactorRedrawPrime) planFactorRedrawPrime();
    });
  }
  (async () => {
    try { primeInfo = await api('/api/prime'); } catch { primeInfo = null; }
    try {
      const inv = await api('/api/investments');
      holdings = (inv.accounts || []).flatMap((a) => (a.holdings || []).map((h) => ({ ...h.holding, accountName: (a.account || {}).name })));
    } catch { holdings = []; }
    renderPrime();
    renderStock();
    renderGrowth();
    renderFactorChecks();
  })();
}

// ------------------------------------------------------- planning modals ---
function openPlanDeclaredAssetModal(projectId) {
  const form = $('#planDeclaredAssetForm');
  form.reset();
  form.dataset.projectId = projectId;
  showMsg($('#planDeclaredAssetModalMsg'), '', '');
  openModal('planDeclaredAssetModal');
}
$('#planDeclaredAssetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#planDeclaredAssetModalMsg');
  try {
    await api(`/api/planning/projects/${form.dataset.projectId}/declared-assets`, { method: 'POST', body: {
      name: form.name.value.trim(), amount: parseMoneyInput(form.amount.value), maturity_date: form.maturity_date.value || null,
    } });
    closeModalEl($('#planDeclaredAssetModal'));
    loadPlanProject(Number(form.dataset.projectId));
  } catch (err) { showMsg(msg, 'err', err.message); }
});

// ---- op form ----
let planOpCtx = null; // {properties, accounts, holdings, declaredAssets, ops}
async function planLoadOpCtx(projectId, strategyId) {
  const [props, inv, proj] = await Promise.all([
    api('/api/properties').catch(() => ({ properties: [] })),
    api('/api/investments').catch(() => ({ accounts: [] })),
    projectId ? api(`/api/planning/projects/${projectId}`) : Promise.resolve(planProjectData),
  ]);
  const properties = props.properties || props || [];
  const accounts = (inv.accounts || []).map((a) => ({ ...(a.account || {}), holdings: (a.holdings || []).map((h) => h.holding) }));
  const holdings = accounts.flatMap((a) => a.holdings.map((h) => ({ ...h, accountId: a.id })));
  const declaredAssets = (proj && proj.declaredAssets) || [];
  // The project row itself (category + entity) rides along so the buy
  // form can resolve the cash-pool total for pool projects.
  const project = (proj && proj.project) || null;
  let ops = [];
  if (strategyId) {
    try { const s = await api(`/api/planning/strategies/${strategyId}`); ops = s.ops || []; } catch { /* new strategy */ }
  }
  return { properties, accounts, holdings, declaredAssets, ops, project };
}
function planMonthBtnHtml(valueYm, inputId) {
  const ym = valueYm || '';
  return `<button type="button" class="month-field" data-plan-month data-value="${esc(ym)}" aria-haspopup="dialog" aria-expanded="false">${ym ? formatYM(ym) : '—'}</button><input type="hidden" id="${inputId}" value="${ym ? `${ym}-01` : ''}">`;
}
function planOpFormHtml(type, params, ctx, opts) {
  const p = params || {};
  const existingLegs = (opts && opts.existingLegs) || null;
  // Entity scope (user rule 2026-11-04): in a property project the
  // picker offers ONLY the project entity property, so the UI path
  // cannot produce a POST-then-excluded op. Server behavior is
  // unchanged (integer propertyId still accepted for API compat).
  // A non-property project, an unresolvable entity, or an entity
  // property missing from the list falls back to all properties.
  const entityPropId = ctx.project && ctx.project.category === 'property' && ctx.project.entity
    ? Number(ctx.project.entity.propertyId) || null : null;
  const scopedProps = entityPropId ? ctx.properties.filter((x) => Number(x.id) === entityPropId) : [];
  const propList = scopedProps.length ? scopedProps : ctx.properties;
  const propOpts = propList.map((x) => `<option value="${x.id}"${Number(p.propertyId) === x.id ? ' selected' : ''}>${esc(x.address)}</option>`).join('');
  const acctOpts = ctx.accounts.map((x) => `<option value="${x.id}"${Number(p.accountId) === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const holdOpts = ctx.holdings.map((x) => `<option value="${x.id}"${Number(p.holdingId) === x.id ? ' selected' : ''}>${esc(x.symbol || x.label)}</option>`).join('');
  const dateRow = `<div><label>Date (month) *</label>${planMonthBtnHtml((p.date || '').slice(0, 7), 'planOpDateVal')}</div>`;
  const rateRows = `
    <div><label>Rate type *</label><label class="btnlike"><input type="radio" name="planOpRateType" value="fixed"${p.rateType !== 'variable' ? ' checked' : ''}> Fixed</label> <label class="btnlike"><input type="radio" name="planOpRateType" value="variable"${p.rateType === 'variable' ? ' checked' : ''}> Variable</label></div>
    <div class="grid2">
      <div><label>Fixed rate (%)</label><input id="planOpAnnualRate" type="text" inputmode="decimal" data-money value="${p.annualRate != null ? esc(String(p.annualRate)) : ''}"></div>
      <div><label>Spread vs prime (points)</label><input id="planOpSpread" type="text" inputmode="decimal" data-money value="${p.spread != null ? esc(String(p.spread)) : ''}"></div>
    </div>`;
  let body = '';
  if (type === 'prepay') body = `
    <div><label>Property *</label><select id="planOpProperty">${propOpts}</select></div>
    ${dateRow}
    <div class="grid2">
      <div><label>Amount *</label><input id="planOpAmount" type="text" inputmode="decimal" data-money value="${p.amount != null ? esc(String(p.amount)) : ''}" required></div>
      <div><label>Recurring years</label><input id="planOpYears" type="number" min="1" max="30" value="${p.recurringYears || 1}"></div>
      <div><label>Plan type</label><select id="planOpOpenClosed"><option value="closed"${p.openClosed !== 'open' ? ' selected' : ''}>Closed</option><option value="open"${p.openClosed === 'open' ? ' selected' : ''}>Open</option></select></div>
    </div>`;
  if (type === 'rate_switch') body = `
    <div><label>Property *</label><select id="planOpProperty">${propOpts}</select></div>
    <div><label>Plan type</label><select id="planOpOpenClosed"><option value="closed"${p.openClosed !== 'open' ? ' selected' : ''}>Closed</option><option value="open"${p.openClosed === 'open' ? ' selected' : ''}>Open</option></select></div>
    ${dateRow}${rateRows}
    <div><label>Amortization (years, fixed only; blank = remaining)</label><input id="planOpAmortYears" type="number" min="1" max="35" value="${p.amortizationYears != null ? esc(String(p.amortizationYears)) : ''}"></div>`;
  if (type === 'refinance') body = `
    <div><label>Property *</label><select id="planOpProperty">${propOpts}</select></div>
    <div><label>Plan type</label><select id="planOpOpenClosed"><option value="closed"${p.openClosed !== 'open' ? ' selected' : ''}>Closed</option><option value="open"${p.openClosed === 'open' ? ' selected' : ''}>Open</option></select></div>
    ${dateRow}${rateRows}
    <div class="grid2">
      <div><label>Term (months) *</label><input id="planOpTermMonths" type="number" min="1" max="120" value="${p.termMonths || 60}"></div>
      <div><label>Amortization (years) *</label><input id="planOpAmortYears" type="number" min="1" max="35" value="${p.amortizationYears || 25}"></div>
      <div><label>Fees</label><input id="planOpFees" type="text" inputmode="decimal" data-money value="${p.fees != null ? esc(String(p.fees)) : ''}"></div>
      <div><label>Cash-out</label><input id="planOpCashOut" type="text" inputmode="decimal" data-money value="${p.cashOut != null ? esc(String(p.cashOut)) : ''}"></div>
    </div>
    <div><label>Lender</label><input id="planOpLender" value="${p.lender ? esc(p.lender) : ''}"></div>`;
  if (type === 'payment_change') body = `
    <div><label>Property *</label><select id="planOpProperty">${propOpts}</select></div>
    ${dateRow}
    <div><label>New payment *</label><input id="planOpPayment" type="text" inputmode="decimal" data-money value="${p.payment != null ? esc(String(p.payment)) : ''}" required></div>`;
  if (type === 'buy') {
    // A custom buy (GIC): no account, a product name, and its own
    // rate — detected from the stored params so Edit reopens it as
    // custom. The old GIC shape (rate on the sink, price 100, no
    // holding) is custom too.
    const isCustomBuy = p.accountId == null && p.symbol && (p.expectedReturnPct != null || (Number(p.price) === 100 && p.holdingId == null));
    body = `
    ${opts && opts.allowCustom ? `<div><label><input type="checkbox" id="planOpCustom"${isCustomBuy ? ' checked' : ''}> Custom product (e.g. GIC)</label></div>
    <div id="planOpCustomBox"${isCustomBuy ? '' : ' class="hidden"'}>
      <div><label>Product name *</label><input id="planOpCustomName" value="${isCustomBuy ? esc(p.symbol || '') : ''}"></div>
      <div><label>Expected return (% / year) *</label><input id="planOpCustomReturn" type="text" inputmode="decimal" data-money value="${p.expectedReturnPct != null ? esc(String(p.expectedReturnPct)) : ''}"></div>
      <div><label>Term (days)</label><input id="planOpCustomTerm" type="text" inputmode="numeric" value="${p.termDays != null ? esc(String(p.termDays)) : ''}"></div>
    </div>` : ''}
    <div id="planOpStockBox"${isCustomBuy ? ' class="hidden"' : ''}>
    <div><label>Account *</label><select id="planOpAccount">${acctOpts}</select></div>
    <div><label>Holding</label><select id="planOpHolding"><option value="">New holding…</option>${holdOpts}</select>
    <div class="suggest-wrap"><input id="planOpSymbol" placeholder="Symbol for a new holding" autocomplete="off" value="${p.symbol ? esc(p.symbol) : ''}"><ul class="suggest-list hidden" id="planOpSymbolSuggest"></ul></div></div>
    </div>
    ${dateRow}
    <div class="grid2">
      <div><label>Units</label><input id="planOpUnits" type="text" inputmode="decimal" value="${p.units != null ? esc(String(p.units)) : ''}"></div>
      <div><label>Amount</label><input id="planOpAmount" type="text" inputmode="decimal" data-money value="${p.amount != null ? esc(String(p.amount)) : ''}"></div>
      <div><label>Price *</label><input id="planOpPrice" type="text" inputmode="decimal" data-money value="${p.price != null ? esc(String(p.price)) : ''}" required></div>
    </div>
    <div id="planOpPriceNote" class="n hidden"></div>
    <div class="toolbar hidden" id="planOpBuyActionsRow">
      <button type="button" class="small" id="planOpBuyAllBtn">Buy all</button>
      <button type="button" class="small" id="planOpBuyHalfBtn">Half</button>
      <span id="planOpPoolTotal" class="n"></span>
    </div>
    ${existingLegs && existingLegs.length ? `<div><label>Funding sources *</label>
      <div class="spend-tx-catwrap">
        <button type="button" class="small" id="planOpSourceBtn">Sources: Cash pot</button>
        <div class="spend-tx-catpanel hidden" id="planOpSourcePanel">
          <div class="spend-tx-catpanel-actions">
            <button type="button" class="small" id="planOpSourceAll">Select all</button>
            <button type="button" class="small" id="planOpSourceNone">Select none</button>
            <span class="spacer"></span>
            <button type="button" class="small" id="planOpSourceDone">Done</button>
          </div>
          ${planBuySourceOpts(ctx).map((o) => `<label><input type="checkbox" data-plan-op-source="${esc(o.value)}"> ${esc(o.label)}</label>`).join('')}
        </div>
      </div>
    </div>
    <div><label>Funded by</label><div id="planOpLegs"></div></div>` : `<div><label>Funding</label><div>Cash pool</div></div>`}`;
  }
  if (type === 'sell') body = `
    <div><label>Holding *</label><select id="planOpHolding">${holdOpts}</select></div>
    ${dateRow}
    <div class="grid2">
      <div><label>Units *</label><input id="planOpUnits" type="text" inputmode="decimal" data-money value="${p.units != null ? esc(String(p.units)) : ''}" required></div>
      <div><label>Price (blank = market)</label><input id="planOpPrice" type="text" inputmode="decimal" data-money value="${p.price != null ? esc(String(p.price)) : ''}"></div>
    </div>
    <div><label>Proceeds go to</label><div id="planOpLegs"></div><button type="button" class="small" id="planOpAddLegBtn">+ Proceeds leg</button></div>`;
  if (type === 'position') body = `
    <div><label>Account *</label><select id="planOpAccount">${acctOpts}</select></div>
    <div><label>Symbol</label><input id="planOpSymbol" value="${p.symbol ? esc(p.symbol) : ''}"></div>
    ${dateRow}
    <div><label>Units *</label><input id="planOpUnits" type="text" inputmode="decimal" data-money value="${p.units != null ? esc(String(p.units)) : ''}" required></div>`;
  return body;
}
// Custom-product toggle on the buy form (investment strategies):
// a custom product (e.g. GIC) has a name + its own expected return
// and a fixed price of 100 — no account, no holding, no symbol
// autocomplete. Checking it hides the stock rows and pins the
// price; unchecking restores them.
function planBuyCustomWire(root) {
  const box = root.querySelector('#planOpCustom');
  if (!box) return;
  const sync = () => {
    const on = box.checked;
    const customBox = root.querySelector('#planOpCustomBox');
    if (customBox) customBox.classList.toggle('hidden', !on);
    const stockBox = root.querySelector('#planOpStockBox');
    if (stockBox) stockBox.classList.toggle('hidden', on);
    const price = root.querySelector('#planOpPrice');
    if (price) {
      if (on) { price.value = '100'; price.disabled = true; }
      else price.disabled = false;
    }
  };
  box.addEventListener('change', sync);
  sync();
}
function planBuySourceOpts(ctx) {
  const opts = [
    { value: 'cash', label: 'Declared cash' },
    { value: 'external', label: 'External injection' },
    { value: 'pot', label: 'Cash pot' },
  ];
  for (const a of (ctx.declaredAssets || [])) opts.push({ value: `declared:${a.id}`, label: a.name });
  for (const o of (ctx.ops || []).filter((x) => x.op_type === 'sell')) opts.push({ value: `op:${o.seq}`, label: `Sell op #${o.seq}` });
  return opts;
}
function planLegRowHtml(type, ctx, leg, withDel = true) {
  const l = leg || { source_ref: type === 'buy' ? 'cash' : 'pot', amount: 'remainder' };
  let srcOpts = '';
  if (type === 'buy') {
    srcOpts = planBuySourceOpts(ctx).map((o) => `<option value="${o.value}"${l.source_ref === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  } else {
    srcOpts = `<option value="pot"${l.source_ref === 'pot' ? ' selected' : ''}>Cash pot</option>
      <option value="external_out"${l.source_ref === 'external_out' ? ' selected' : ''}>External out</option>`
      + ctx.properties.map((x) => `<option value="repay:${x.id}"${l.source_ref === `repay:${x.id}` ? ' selected' : ''}>Repay ${esc(x.address)}</option>`).join('')
      + ctx.ops.filter((o) => o.op_type === 'buy').map((o) => `<option value="op:${o.seq}"${l.source_ref === `op:${o.seq}` ? ' selected' : ''}>Buy op #${o.seq}</option>`).join('');
  }
  const mode = l.amount === 'all' ? 'all' : l.amount === 'remainder' ? 'remainder' : 'fixed';
  return `<div class="plan-row plan-leg-row">
    <select class="plan-leg-src">${srcOpts}</select>
    <select class="plan-leg-mode"><option value="fixed"${mode === 'fixed' ? ' selected' : ''}>Fixed</option><option value="all"${mode === 'all' ? ' selected' : ''}>All</option><option value="remainder"${mode === 'remainder' ? ' selected' : ''}>Remainder</option></select>
    <input class="plan-leg-amount" type="text" inputmode="decimal" data-money value="${mode === 'fixed' ? esc(String(l.amount)) : ''}"${mode !== 'fixed' ? ' disabled' : ''}>
    ${withDel ? '<button type="button" class="small danger plan-leg-del">Delete</button>' : ''}</div>`;
}
// Funding-source picker (buy ops only): the app's checkbox
// multi-select pattern — one box per source, each checked source is
// exactly one funding leg. Unchecking removes that leg; deleting a
// leg unchecks its box; changing a row's source re-checks to match.
// The legs themselves (mode/amount) stay editable per row, and the
// existing legs validation applies across all of them unchanged.
// Buy-op holding autocomplete: the symbol input suggests by
// ticker OR company name, from three sources merged in order:
// (a) the app's existing holdings (symbol or label match),
// (b) Yahoo security search via GET /api/invest/search (company
// name → ticker for symbols the app has never seen; best-effort,
// empty on failure), (c) the typed ticker itself when it looks
// like a ticker and matches nothing exactly. Picking a suggestion
// fills Price with the current price from the existing price
// tiers (GET /api/invest/price) — a pick is an explicit action,
// so it fills even over a typed price, and the user can then
// edit Price freely; the fill happens once per pick, never
// again on later keystrokes. A failed price lookup leaves Price
// untouched, never a guessed price. Picking an existing holding
// from the Holding dropdown fills Price the same way.
function planBuyAutocompleteWire(root, ctx) {
  const input = root.querySelector('#planOpSymbol');
  const list = root.querySelector('#planOpSymbolSuggest');
  const priceEl = root.querySelector('#planOpPrice');
  const holdingSel = root.querySelector('#planOpHolding');
  if (!input || !list || !priceEl) return;
  const acctName = (id) => (ctx.accounts.find((a) => a.id === id) || {}).name || '';
  let items = [];
  let fillSeq = 0;
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
      if (c.label) li.appendChild(document.createTextNode(' ' + c.label));
      const meta = [c.exchange, c.currency, c.account].filter(Boolean).join(' · ');
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
  async function fillPrice(symbol) {
    const my = ++fillSeq;
    try {
      const data = await api('/api/invest/price?symbol=' + encodeURIComponent(symbol));
      if (my !== fillSeq) return; // a newer fill wins; stale results never land
      if (data && data.price != null) {
        priceEl.value = formatMoneyInput(String(data.price));
        if (noteEl) noteEl.classList.add('hidden');
        relink();
      } else if (noteEl) {
        noteEl.textContent = `No price data for ${symbol} — enter a price.`;
        noteEl.classList.remove('hidden');
      }
    } catch { /* best-effort: leave Price untouched */ }
  }
  function pick(i) {
    const c = items[i];
    if (!c) return;
    close();
    if (holdingSel) holdingSel.value = c.holdingId ? String(c.holdingId) : '';
    input.value = c.symbol;
    input.focus();
    fillPrice(c.symbol);
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      const needle = q.toLowerCase();
      const held = (ctx.holdings || []).filter((h) =>
        (h.symbol || '').toLowerCase().includes(needle) || (h.label || '').toLowerCase().includes(needle))
        .map((h) => ({ symbol: (h.symbol || '').toUpperCase(), label: h.label || '', account: acctName(h.accountId), holdingId: h.id }));
      let remote = [];
      try {
        const data = await api('/api/invest/search?q=' + encodeURIComponent(q));
        remote = data.results || [];
      } catch { remote = []; }
      if (my !== seq) return;
      const seen = new Set(held.map((h) => h.symbol));
      const merged = held.slice();
      for (const r of remote) {
        if (!r.symbol || seen.has(r.symbol)) continue;
        seen.add(r.symbol);
        merged.push({ symbol: r.symbol, label: r.label || '', exchange: r.exchange || '', currency: r.currency || '' });
      }
      if (/^[A-Za-z][A-Za-z0-9.]{1,11}$/.test(q) && !seen.has(q.toUpperCase())) {
        merged.push({ symbol: q.toUpperCase(), label: '' });
      }
      items = merged;
      active = items.length ? 0 : -1;
      render();
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
  if (holdingSel) holdingSel.addEventListener('change', () => {
    const h = (ctx.holdings || []).find((x) => String(x.id) === holdingSel.value);
    if (!h || !h.symbol) return;
    input.value = h.symbol;
    fillPrice(h.symbol);
  });
  // Brokerage-style Units ⟷ Amount linkage + typed-symbol price fill
  // + pool quick actions. This runs in BOTH buy forms (op modal and
  // template form) because both wire through here. Units is a unit
  // count, not money: no thousands separators on it, 4-decimal
  // precision like plan-generated buys. Amount keeps money
  // formatting while typing. Last-edited-of-the-two drives; a Price
  // change recomputes the non-driving field; clearing the driver
  // clears the other field.
  const unitsEl = root.querySelector('#planOpUnits');
  const amountEl = root.querySelector('#planOpAmount');
  const noteEl = root.querySelector('#planOpPriceNote');
  const actionsRow = root.querySelector('#planOpBuyActionsRow');
  const poolTotalEl = root.querySelector('#planOpPoolTotal');
  let lastEdited = null; // 'units' | 'amount'
  const fmtUnits = (x) => String(Math.round(x * 10000) / 10000);
  function relink() {
    if (!unitsEl || !amountEl) return;
    const price = parseMoneyInput(priceEl.value);
    if (price === '' || !(price > 0)) return;
    const u = parseMoneyInput(unitsEl.value);
    const a = parseMoneyInput(amountEl.value);
    if (lastEdited === 'amount') {
      unitsEl.value = a === '' ? '' : fmtUnits(a / price);
    } else if (lastEdited === 'units') {
      amountEl.value = u === '' ? '' : formatMoneyInput((Math.round(u * price * 100) / 100).toFixed(2));
    } else if (u !== '') {
      amountEl.value = formatMoneyInput((Math.round(u * price * 100) / 100).toFixed(2));
    } else if (a !== '') {
      unitsEl.value = fmtUnits(a / price);
    }
  }
  if (unitsEl) unitsEl.addEventListener('input', () => { lastEdited = 'units'; relink(); });
  if (amountEl) amountEl.addEventListener('input', () => { lastEdited = 'amount'; relink(); });
  priceEl.addEventListener('input', () => relink());
  // Typed symbols fill on blur/change too, not only suggestion picks —
  // but a typed fill never overwrites a price the user already typed.
  // No price data leaves Price editable with a plain note, never a
  // guessed price.
  input.addEventListener('change', () => {
    const sym = input.value.trim();
    if (!sym || priceEl.value.trim() !== '') return;
    fillPrice(sym);
  });
  // Cash-pool total for pool projects, from the existing
  // recommendations endpoint (same figures as the creation flow).
  // Non-pool projects have no pool: the actions row stays hidden
  // and no overflow check applies there.
  const proj = ctx.project;
  if (proj && proj.category === 'investment' && proj.entity && proj.entity.type === 'pool') {
    api('/api/planning/recommendations', { method: 'POST', body: { category: 'investment', entity: proj.entity } })
      .then((data) => {
        const recs = data && data.recommendations ? Object.values(data.recommendations) : [];
        const pool = recs.length && recs[0].baseline && recs[0].baseline.figures ? recs[0].baseline.figures.poolValue : null;
        if (pool == null) return;
        root.dataset.planPoolTotal = String(pool);
        if (poolTotalEl) poolTotalEl.textContent = `Cash pool total: ${money2(pool)}`;
        if (actionsRow) actionsRow.classList.remove('hidden');
      })
      .catch(() => { /* no pool total: no quick actions, no check */ });
  }
  const buyFromPool = (fraction) => {
    const total = root.dataset.planPoolTotal ? Number(root.dataset.planPoolTotal) : null;
    if (total == null || !amountEl) return;
    const amt = Math.round(total * fraction * 100) / 100;
    amountEl.value = formatMoneyInput(amt.toFixed(2));
    lastEdited = 'amount';
    relink();
  };
  const buyAllBtn = root.querySelector('#planOpBuyAllBtn');
  const buyHalfBtn = root.querySelector('#planOpBuyHalfBtn');
  if (buyAllBtn) buyAllBtn.addEventListener('click', () => buyFromPool(1));
  if (buyHalfBtn) buyHalfBtn.addEventListener('click', () => buyFromPool(0.5));
}
function planOpSourceWire(root, ctx) {
  const btn = root.querySelector('#planOpSourceBtn');
  const panel = root.querySelector('#planOpSourcePanel');
  const box = root.querySelector('#planOpLegs');
  if (!btn || !panel || !box) return;
  const boxes = () => [...panel.querySelectorAll('[data-plan-op-source]')];
  const checked = () => boxes().filter((b) => b.checked).map((b) => b.dataset.planOpSource);
  const labelFor = (v) => (planBuySourceOpts(ctx).find((o) => o.value === v) || {}).label || v;
  const updateBtn = () => {
    const c = checked();
    btn.textContent = c.length === 0 ? 'Sources: none' : c.length === 1 ? `Sources: ${labelFor(c[0])}` : `Sources: ${c.length} sources`;
  };
  const rebuildLegs = () => {
    // Preserve each surviving source's mode/amount; new sources start
    // as remainder legs.
    const kept = new Map();
    box.querySelectorAll('.plan-leg-row').forEach((row) => {
      const src = row.querySelector('.plan-leg-src');
      const mode = row.querySelector('.plan-leg-mode');
      const amt = row.querySelector('.plan-leg-amount');
      if (src) kept.set(src.value, { mode: mode ? mode.value : 'remainder', amount: amt ? amt.value : '' });
    });
    box.innerHTML = checked().map((src) => {
      const k = kept.get(src);
      return planLegRowHtml('buy', ctx, k ? { source_ref: src, amount: k.mode === 'fixed' ? (k.amount || 'remainder') : k.mode } : { source_ref: src, amount: 'remainder' });
    }).join('');
    box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
    updateBtn();
  };
  btn.addEventListener('click', () => panel.classList.toggle('hidden'));
  panel.querySelector('#planOpSourceDone').addEventListener('click', () => panel.classList.add('hidden'));
  panel.querySelector('#planOpSourceAll').addEventListener('click', () => { boxes().forEach((b) => { b.checked = true; }); rebuildLegs(); });
  panel.querySelector('#planOpSourceNone').addEventListener('click', () => { boxes().forEach((b) => { b.checked = false; }); rebuildLegs(); });
  boxes().forEach((b) => b.addEventListener('change', rebuildLegs));
  // Initial state mirrors the rows already rendered (existing op, or
  // the default cash leg a new buy starts with).
  const rowSrcs = [...box.querySelectorAll('.plan-leg-row .plan-leg-src')].map((s) => s.value);
  if (!rowSrcs.length) {
    const cash = panel.querySelector('[data-plan-op-source="cash"]');
    if (cash) cash.checked = true;
    box.innerHTML = planLegRowHtml('buy', ctx, { source_ref: 'cash', amount: 'remainder' });
    box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  } else {
    boxes().forEach((b) => { b.checked = rowSrcs.includes(b.dataset.planOpSource); });
  }
  updateBtn();
}
function planOpSourceSyncFromRows(root, ctx) {
  const panel = root.querySelector('#planOpSourcePanel');
  const box = root.querySelector('#planOpLegs');
  const btn = root.querySelector('#planOpSourceBtn');
  if (!panel || !box || !btn) return;
  const rowSrcs = [...box.querySelectorAll('.plan-leg-row .plan-leg-src')].map((s) => s.value);
  panel.querySelectorAll('[data-plan-op-source]').forEach((b) => { b.checked = rowSrcs.includes(b.dataset.planOpSource); });
  const labelFor = (v) => (planBuySourceOpts(ctx).find((o) => o.value === v) || {}).label || v;
  btn.textContent = rowSrcs.length === 0 ? 'Sources: none' : rowSrcs.length === 1 ? `Sources: ${labelFor(rowSrcs[0])}` : `Sources: ${rowSrcs.length} sources`;
}
function planLegsWire(type, ctx, root) {
  const scope = root || document;
  const box = scope.querySelector('#planOpLegs');
  if (!box) return;
  box.addEventListener('click', (e) => {
    if (e.target.closest('.plan-leg-del')) {
      e.target.closest('.plan-leg-row').remove();
      const root = box.closest('.modal-card');
      if (root) planOpSourceSyncFromRows(root, ctx);
    }
  });
  box.addEventListener('change', (e) => {
    if (e.target.closest('.plan-leg-mode')) {
      const row = e.target.closest('.plan-leg-row');
      const amt = row.querySelector('.plan-leg-amount');
      amt.disabled = e.target.value !== 'fixed';
      if (amt.disabled) amt.value = '';
    }
    if (e.target.closest('.plan-leg-src')) {
      const root = box.closest('.modal-card');
      if (root) planOpSourceSyncFromRows(root, ctx);
    }
  });
  const addBtn = scope.querySelector('#planOpAddLegBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    box.insertAdjacentHTML('beforeend', planLegRowHtml(type, ctx, null));
    box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  });
}
// A custom-product buy (no account) has no price history to fall
// back on, so its expected return is required — a rateless custom
// buy would project flat. Checked at save time, not inside
// planReadOpForm: the template form's blank-date name-only path
// must not be blocked by a half-filled op form.
function planRequireCustomBuyRate(params) {
  if (!params || params.accountId != null) return;
  if (params.expectedReturnPct == null) throw new Error('a custom product buy needs an expected return (% / year)');
  if (!(params.expectedReturnPct >= -90 && params.expectedReturnPct <= 500)) throw new Error('expected return must be -90..500');
}
// A term (days) on a custom buy, checked at save time alongside the
// rate: optional, but when present it must be a whole number of days
// > 0. The server's validateOp enforces the same rule.
function planValidateCustomBuyTerm(params) {
  if (!params || params.accountId != null) return;
  if (params.termDays == null) return;
  if (!Number.isInteger(params.termDays) || params.termDays <= 0) throw new Error('term must be a whole number of days > 0');
}
function planReadOpForm(type, root) {
  const scope = root || document;
  const v = (id) => { const el = scope.querySelector('#' + id); return el ? el.value : null; };
  const m = (id) => { const x = v(id); if (x == null || String(x).trim() === '') return null; return parseMoneyInput(x); };
  const params = { date: v('planOpDateVal') || null };
  if (type === 'prepay') { params.propertyId = Number(v('planOpProperty')); params.amount = m('planOpAmount'); params.recurringYears = Number(v('planOpYears')) || 1; params.openClosed = v('planOpOpenClosed') || 'closed'; }
  if (type === 'rate_switch' || type === 'refinance') {
    params.propertyId = Number(v('planOpProperty'));
    params.openClosed = v('planOpOpenClosed') || 'closed';
    const rt = scope.querySelector('input[name="planOpRateType"]:checked');
    params.rateType = rt ? rt.value : 'fixed';
    params.annualRate = params.rateType === 'fixed' ? m('planOpAnnualRate') : null;
    params.spread = params.rateType === 'variable' ? m('planOpSpread') : null;
    // Fixed-only amortization override (blank = remaining amortization).
    if (type === 'rate_switch' && params.rateType === 'fixed') {
      const ay = v('planOpAmortYears');
      params.amortizationYears = ay != null && String(ay).trim() !== '' ? Number(ay) : null;
    }
  }
  if (type === 'refinance') {
    params.termMonths = Number(v('planOpTermMonths')); params.amortizationYears = Number(v('planOpAmortYears'));
    params.fees = m('planOpFees'); params.cashOut = m('planOpCashOut'); params.lender = v('planOpLender') || null;
  }
  if (type === 'payment_change') { params.propertyId = Number(v('planOpProperty')); params.payment = m('planOpPayment'); }
  if (type === 'buy') {
    const custom = scope.querySelector('#planOpCustom');
    if (custom && custom.checked) {
      // A custom product (e.g. GIC): no account, a product name, its
      // own expected return, price fixed at 100. The rate travels
      // with the buy.
      params.accountId = null;
      params.symbol = v('planOpCustomName') || null;
      params.currency = 'CAD';
      params.price = 100;
      const ret = m('planOpCustomReturn');
      if (ret != null) params.expectedReturnPct = ret;
      // A term in days (e.g. a 180-day GIC): at maturity the proceeds
      // return to the pot as cash and the comparison ends at the
      // maturity month. Optional — a termless custom buy keeps
      // projecting as today.
      const term = v('planOpCustomTerm');
      if (term != null && String(term).trim() !== '') params.termDays = Number(term);
      params.units = m('planOpUnits'); params.amount = m('planOpAmount');
    } else {
      params.accountId = Number(v('planOpAccount'));
      const hid = v('planOpHolding');
      if (hid) params.holdingId = Number(hid);
      params.symbol = v('planOpSymbol') || null;
      params.units = m('planOpUnits'); params.amount = m('planOpAmount'); params.price = m('planOpPrice');
    }
  }
  if (type === 'sell') { params.holdingId = Number(v('planOpHolding')); params.units = m('planOpUnits'); params.price = m('planOpPrice'); }
  if (type === 'position') { params.accountId = Number(v('planOpAccount')); params.symbol = v('planOpSymbol') || null; params.units = m('planOpUnits'); }
  const legs = [];
  scope.querySelectorAll('#planOpLegs .plan-leg-row').forEach((row) => {
    const src = row.querySelector('.plan-leg-src').value;
    const mode = row.querySelector('.plan-leg-mode').value;
    const amount = mode === 'fixed' ? parseMoneyInput(row.querySelector('.plan-leg-amount').value) : mode;
    legs.push({ source_ref: src, amount });
  });
  // New buys carry no leg picker anymore: funding defaults to the
  // cash pool — an implicit single pool leg. The pool-overflow guard
  // (planBuyPoolOverflow, applied at Save) still caps the amount at
  // the pool total. The implicit leg is the existing 'cash'
  // (Declared cash) source: the engine's 'pot' is seeded only from
  // external cash and would reject a pool buy with no external cash.
  // A recommendation-prefilled form may stash its own implicit leg
  // (cash pot for buy strategies) on the modal card — it wins.
  if (type === 'buy' && !legs.length) {
    let implicit = { source_ref: 'cash', amount: 'remainder' };
    try {
      const stashed = scope && scope.dataset ? JSON.parse(scope.dataset.planImplicitLeg || 'null') : null;
      if (stashed && stashed.source_ref) implicit = stashed;
    } catch { /* a bad stash never blocks the save — fall back to cash */ }
    legs.push(implicit);
  }
  return { params, legs };
}
// Buy overflow guard (both buy forms): a buy bigger than the project's
// cash-pool total is blocked with the pool total and the excess named
// — never silently clamped. Non-pool projects carry no pool total, so
// no check applies there. The pool total is stashed on the modal card
// by the buy-form wiring when the form opens.
function planBuyPoolOverflow(root, amount) {
  const total = root && root.dataset.planPoolTotal ? Number(root.dataset.planPoolTotal) : null;
  if (total == null || amount == null || amount === '') return null;
  if (amount > total) return `Buy amount ${money2(amount)} exceeds the cash pool total ${money2(total)} by ${money2(Math.round((amount - total) * 100) / 100)}`;
  return null;
}
async function openPlanOpModal(strategyId, existing, presetType, opts) {
  const strategy = planStrategyData ? planStrategyData.strategy : null;
  const projectId = planStrategyData ? planStrategyData.project.id : null;
  const ctx = await planLoadOpCtx(projectId, strategyId);
  planOpCtx = ctx;
  const type = existing ? existing.op_type : (presetType || 'prepay');
  // A custom product (e.g. GIC) is a buy target on investment
  // strategies only — the toggle lives on the buy form.
  const allowCustom = !!(ctx.project && ctx.project.category === 'investment');
  $('#planOpModalTitle').textContent = (opts && opts.title) || (existing ? 'Edit operation' : 'Add operation');
  // A locked form (the merged Sink's + Add buy) opens straight into
  // the preset action with no operation-type select — the section is
  // buy-only, so the user cannot switch it to a sell.
  const typeSel = (existing || (opts && opts.lockType)) ? '' : `<div><label>Operation type *</label><select id="planOpTypeSel">
    <option value="prepay">Prepay mortgage</option><option value="rate_switch">Rate switch</option>
    <option value="refinance">Refinance</option><option value="payment_change">Payment change</option>
    <option value="buy">Buy</option><option value="sell">Sell</option><option value="position">Position (cost unknown)</option></select></div>`;
  $('#planOpModalBody').innerHTML = `
    ${typeSel}
    <div id="planOpFormFields">${planOpFormHtml(type, existing ? existing.params : {}, ctx, { existingLegs: existing ? existing.legs : null, allowCustom })}</div>
    <div class="toolbar"><button class="primary" id="planOpSaveBtn">Save</button><button type="button" data-close-modal>Cancel</button></div>`;
  $('#planOpModalBody').querySelectorAll('input[data-money]').forEach(wireMoneyInput);
  const opCard = $('#planOpModalBody').closest('.modal-card');
  const typeEl = $('#planOpTypeSel');
  if (typeEl) typeEl.value = type;
  if (typeEl) typeEl.addEventListener('change', () => {
    $('#planOpFormFields').innerHTML = planOpFormHtml(typeEl.value, {}, ctx, { allowCustom });
    $('#planOpFormFields').querySelectorAll('input[data-money]').forEach(wireMoneyInput);
    planLegsWire(typeEl.value, ctx, opCard);
    if (typeEl.value === 'buy' || typeEl.value === 'sell') {
      const box = opCard.querySelector('#planOpLegs');
      if (box && !box.children.length) {
        box.insertAdjacentHTML('beforeend', planLegRowHtml(typeEl.value, ctx, null));
        box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
      }
    }
    if (typeEl.value === 'buy') planOpSourceWire(opCard, ctx);
    if (typeEl.value === 'buy') planBuyAutocompleteWire(opCard, ctx);
    if (typeEl.value === 'buy') planBuyCustomWire(opCard);
  });
  planLegsWire(type, ctx, opCard);
  if ((type === 'buy' || type === 'sell') && existing && existing.legs) {
    const box = opCard.querySelector('#planOpLegs');
    // A buy with no stored legs renders the cash-pool readout (no
    // legs box) — its save falls back to the implicit leg.
    if (box) {
      box.innerHTML = existing.legs.map((l) => planLegRowHtml(type, ctx, l)).join('');
      box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
    }
  } else if (type === 'buy' || type === 'sell') {
    const box = opCard.querySelector('#planOpLegs');
    if (box && !box.children.length) {
      box.insertAdjacentHTML('beforeend', planLegRowHtml(type, ctx, null));
      box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
    }
  }
  if (type === 'buy') planOpSourceWire(opCard, ctx);
  if (type === 'buy') planBuyAutocompleteWire(opCard, ctx);
  if (type === 'buy') planBuyCustomWire(opCard);
  // Recommendation prefill: a strategy created from a subcategory
  // recommendation opens its op form already bound to the entity
  // (account/holding + cash-pot funding leg for buys; property for
  // mortgage ops). The user still fills amounts/dates and saves.
  if (!existing && strategy && strategy.template === 'recommendation') {
    let tp = {};
    try { tp = typeof strategy.template_params === 'string' ? JSON.parse(strategy.template_params) : (strategy.template_params || {}); } catch { tp = {}; }
    const sink = tp.sink || {};
    const typeEl2 = $('#planOpTypeSel');
    if (tp.opType && typeEl2) {
      typeEl2.value = tp.opType;
      const params = {};
      if (sink.accountId) params.accountId = sink.accountId;
      if (sink.holdingId) params.holdingId = sink.holdingId;
      if (tp.entity && tp.entity.propertyId) params.propertyId = tp.entity.propertyId;
      $('#planOpFormFields').innerHTML = planOpFormHtml(tp.opType, params, ctx, { allowCustom });
      $('#planOpFormFields').querySelectorAll('input[data-money]').forEach(wireMoneyInput);
      planLegsWire(tp.opType, ctx, opCard);
      if (tp.opType === 'buy' || tp.opType === 'sell') {
        const box = opCard.querySelector('#planOpLegs');
        if (box) {
          box.innerHTML = planLegRowHtml(tp.opType, ctx, { source_ref: tp.source || 'pot', amount: 'remainder' });
          box.querySelectorAll('input[data-money]').forEach(wireMoneyInput);
        } else if (tp.opType === 'buy' && tp.source) {
          // New buys have no leg picker: the recommendation's funding
          // leg (cash pot for buy strategies) is stashed as this
          // form's implicit leg instead of being dropped silently.
          opCard.dataset.planImplicitLeg = JSON.stringify({ source_ref: tp.source, amount: 'remainder' });
        }
      }
      if (tp.opType === 'buy') planOpSourceWire(opCard, ctx);
      if (tp.opType === 'buy') planBuyAutocompleteWire(opCard, ctx);
      if (tp.opType === 'buy') planBuyCustomWire(opCard);
    }
  }
  showMsg($('#planOpModalMsg'), '', '');
  openModal('planOpModal');
  $('#planOpSaveBtn').addEventListener('click', async () => {
    const msg = $('#planOpModalMsg');
    const curType = existing ? existing.op_type : (typeEl ? typeEl.value : type);
    try {
      const { params, legs } = planReadOpForm(curType, $('#planOpModalBody').closest('.modal-card'));
      if (!params.date) throw new Error('date is required');
      if (curType === 'buy') {
        planRequireCustomBuyRate(params);
        planValidateCustomBuyTerm(params);
        const over = planBuyPoolOverflow($('#planOpModalBody').closest('.modal-card'), params.amount);
        if (over) throw new Error(over);
      }
      if (existing) {
        await api(`/api/planning/ops/${existing.id}`, { method: 'PUT', body: { params, legs } });
      } else {
        await api(`/api/planning/strategies/${strategyId}/ops`, { method: 'POST', body: { op_type: curType, params, legs } });
      }
      closeModalEl($('#planOpModal'));
      loadPlanStrategy(strategyId);
    } catch (err) { showMsg(msg, 'err', err.message); }
  });
}

// ---- strategy chooser ----
async function openPlanStrategyModal(projectId) {
  $('#planStrategyModalTitle').textContent = 'Add strategy';
  showMsg($('#planStrategyModalMsg'), '', '');
  // Category presets first: the concrete things the user wants to do.
  // No op type fits earning/saving/tax_saving, so those show only the
  // AI fallback; a legacy project (no category) shows every op type.
  const cat = planProjectData && planProjectData.project ? planProjectData.project.category : null;
  const PRESET_LABELS = { prepay: 'Prepay', rate_fixed: 'Switch to fixed', rate_variable: 'Switch to variable', refinance: 'Refinance', payment_change: 'Payment change', buy: 'Buy', sell: 'Sell', position: 'Position' };
  const PRESETS = cat === 'property' ? ['prepay', 'rate_fixed', 'rate_variable', 'refinance', 'payment_change']
    : cat === 'investment' ? ['buy', 'sell', 'position']
    : (cat === 'earning' || cat === 'saving' || cat === 'tax_saving') ? []
    : ['prepay', 'rate_fixed', 'rate_variable', 'refinance', 'payment_change', 'buy', 'sell', 'position'];
  let ctx = null;
  const renderChooser = () => {
    $('#planStrategyModalTitle').textContent = 'Add strategy';
    $('#planStrategyModalBody').innerHTML = `
    <div class="cards">
      ${PRESETS.map((t) => `<div class="card breakdown-card" data-plan-preset="${t}" style="cursor:pointer"><div class="k">${PRESET_LABELS[t]}</div></div>`).join('')}
      <div class="card breakdown-card" id="planChooseSaved" style="cursor:pointer"><div class="k">From saved template</div></div>
    </div>`;
    document.querySelectorAll('[data-plan-preset]').forEach((c) => c.addEventListener('click', () => openTemplateForm(c.dataset.planPreset)));
    $('#planChooseSaved').addEventListener('click', openSavedForm);
  };
  renderChooser();
  openModal('planStrategyModal');
  ctx = await planLoadOpCtx(projectId, null);
  planOpCtx = ctx;
  function openTemplateForm(presetType) {
    if (!ctx) return;
    // The preset IS the action: no type re-pick in this form, and the
    // two rate presets are the two rate_switch directions.
    const OP_TYPE = { prepay: 'prepay', rate_fixed: 'rate_switch', rate_variable: 'rate_switch', refinance: 'refinance', payment_change: 'payment_change', buy: 'buy', sell: 'sell', position: 'position' };
    const opType = OP_TYPE[presetType] || presetType;
    const ratePreset = presetType === 'rate_fixed' ? 'fixed' : presetType === 'rate_variable' ? 'variable' : null;
    $('#planStrategyModalTitle').textContent = PRESET_LABELS[presetType] || 'Add strategy';
    $('#planStrategyModalBody').innerHTML = `
      <div class="toolbar"><button class="small" id="planBackToPresets">← Presets</button></div>
      <div><label>Strategy name *</label><div style="display:flex;gap:8px"><input id="planStrategyName" placeholder="e.g. Prepay then refinance" style="flex:1"><button type="button" class="small" id="planStrategyAiNameBtn" title="Suggest a name with AI">✨</button></div></div>
      <div><label>First operation (optional)</label></div>
      <div id="planStrategyOpFields">${planOpFormHtml(opType, ratePreset ? { rateType: ratePreset } : {}, ctx, { allowCustom: !!(ctx.project && ctx.project.category === 'investment') })}</div>
      <div class="toolbar"><button class="primary" id="planStrategyTemplateSave">Create strategy</button></div>`;
    $('#planBackToPresets').addEventListener('click', renderChooser);
    $('#planStrategyModalBody').querySelectorAll('input[data-money]').forEach(wireMoneyInput);
    {
      const stratCard = $('#planStrategyModalBody').closest('.modal-card');
      planLegsWire(opType, ctx, stratCard);
      if (opType === 'buy' || opType === 'sell') {
        const box = stratCard.querySelector('#planOpLegs');
        if (box && !box.children.length) box.insertAdjacentHTML('beforeend', planLegRowHtml(opType, ctx, null));
      }
      if (opType === 'buy') planOpSourceWire(stratCard, ctx);
      if (opType === 'buy') planBuyAutocompleteWire(stratCard, ctx);
      if (opType === 'buy') planBuyCustomWire(stratCard);
      // A rate preset fixes its direction: hide the rate-type radios
      // and the irrelevant rate input, leaving only the number the
      // user actually sets. The amortization override is fixed-only,
      // so it hides on the variable form too.
      if (ratePreset) {
        const fields = $('#planStrategyOpFields');
        const radio = fields.querySelector('input[name="planOpRateType"]');
        if (radio && radio.closest('div')) radio.closest('div').style.display = 'none';
        const hideInput = fields.querySelector(ratePreset === 'fixed' ? '#planOpSpread' : '#planOpAnnualRate');
        if (hideInput && hideInput.closest('div')) hideInput.closest('div').style.display = 'none';
        if (ratePreset === 'variable') {
          const amort = fields.querySelector('#planOpAmortYears');
          if (amort && amort.closest('div')) amort.closest('div').style.display = 'none';
        }
      }
    }
    $('#planStrategyTemplateSave').addEventListener('click', async () => {
      const msg = $('#planStrategyModalMsg');
      try {
        const name = $('#planStrategyName').value.trim();
        if (!name) throw new Error('strategy name is required');
        const { params, legs } = planReadOpForm(opType, $('#planStrategyModalBody').closest('.modal-card'));
        // The first operation is optional: a blank date means "name it
        // now, decide the numbers later". The detail page's quick
        // actions add the first op when the user is ready.
        if (!params.date) {
          const s = await api(`/api/planning/projects/${projectId}/strategies`, { method: 'POST', body: { name, source: 'template', template: opType } });
          closeModalEl($('#planStrategyModal'));
          location.hash = `#planning/strategy/${s.strategy.id}`;
          return;
        }
        // Only a real first op is overflow-checked: a blank-date
        // name-only strategy never saves an op at all.
        if (opType === 'buy') {
          planRequireCustomBuyRate(params);
          planValidateCustomBuyTerm(params);
          const over = planBuyPoolOverflow($('#planStrategyModalBody').closest('.modal-card'), params.amount);
          if (over) throw new Error(over);
        }
        // Applying a strategy template records the template + answers
        // on the strategy; the op list underneath stays the computation.
        const s = await api(`/api/planning/projects/${projectId}/strategies`, { method: 'POST', body: { name, source: 'template', template: opType, template_params: params } });
        try {
          await api(`/api/planning/strategies/${s.strategy.id}/ops`, { method: 'POST', body: { op_type: opType, params, legs } });
        } catch (opErr) {
          // A rejected first op must not leave an orphan strategy
          // behind: roll the bare strategy back, then surface the op
          // error exactly as before.
          try { await api(`/api/planning/strategies/${s.strategy.id}`, { method: 'DELETE' }); } catch { /* best-effort cleanup */ }
          throw opErr;
        }
        closeModalEl($('#planStrategyModal'));
        location.hash = `#planning/strategy/${s.strategy.id}`;
      } catch (err) { showMsg(msg, 'err', err.message); }
    });
    // ✨ name from the first op (op types + key params; a blank form
    // falls back to category/entity context alone).
    const aiNameBtn = $('#planStrategyAiNameBtn');
    if (aiNameBtn) aiNameBtn.addEventListener('click', () => {
      let ops = [];
      try {
        const { params, legs } = planReadOpForm(opType, $('#planStrategyModalBody').closest('.modal-card'));
        if (Object.values(params || {}).some((v) => v !== '' && v != null)) ops = [{ op_type: opType, params, ...(legs && legs.length ? { legs } : {}) }];
      } catch { ops = []; }
      const proj = planProjectData && planProjectData.project ? planProjectData.project : {};
      planAiSuggestName(aiNameBtn, $('#planStrategyName'), 'strategy', { ops, category: proj.category || null, entityLabel: (proj.categoryLabels && proj.categoryLabels.entity) || null }, $('#planStrategyModalMsg'));
    });
  }
  async function openSavedForm() {
    const msg = $('#planStrategyModalMsg');
    try {
      const t = await api('/api/planning/templates');
      const list = t.templates || [];
      $('#planStrategyModalBody').innerHTML = `
      <div class="toolbar"><button class="small" id="planBackToPresets">← Presets</button></div>
      <div><label>Strategy name *</label><div style="display:flex;gap:8px"><input id="planStrategyName" placeholder="e.g. Refinance and invest" style="flex:1"><button type="button" class="small" id="planStrategyAiNameBtn" title="Suggest a name with AI">✨</button></div></div>
      ${list.length ? `<div><label>Saved template *</label><select id="planSavedTemplateSel">${list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div id="planSavedTemplateQs"></div>
      <div class="toolbar"><button class="small primary" id="planSavedTemplateApply">Apply template</button></div>`
        : '<div class="note">No saved templates yet.</div>'}`;
      const sel = $('#planSavedTemplateSel');
      // ✨ name from the picked saved template (no ops exist yet here).
      const aiNameBtnS = $('#planStrategyAiNameBtn');
      if (aiNameBtnS) aiNameBtnS.addEventListener('click', () => {
        const proj = planProjectData && planProjectData.project ? planProjectData.project : {};
        const cur = sel && sel.value ? list.find((x) => String(x.id) === String(sel.value)) : null;
        planAiSuggestName(aiNameBtnS, $('#planStrategyName'), 'strategy', { ops: [], description: cur ? cur.name : null, category: proj.category || null, entityLabel: (proj.categoryLabels && proj.categoryLabels.entity) || null }, $('#planStrategyModalMsg'));
      });
      const backBtn = $('#planBackToPresets');
      if (backBtn) backBtn.addEventListener('click', renderChooser);
      const renderQs = () => {
        const cur = list.find((x) => String(x.id) === String(sel.value));
        const schema = (cur && cur.metadata_schema) || [];
        const saved = (cur && cur.metadata_answers) || {};
        $('#planSavedTemplateQs').innerHTML = schema.map((q) => `<div><label>${esc(q.label)}</label><input id="planSavedAsk_${esc(q.field)}" type="${q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text'}" value="${esc(String(saved[q.field] ?? ''))}"></div>`).join('');
      };
      if (sel) { renderQs(); sel.addEventListener('change', renderQs); }
      const applyBtn = $('#planSavedTemplateApply');
      if (applyBtn) applyBtn.addEventListener('click', async () => {
        try {
          const name = $('#planStrategyName').value.trim();
          if (!name) throw new Error('strategy name is required');
          const cur = list.find((x) => String(x.id) === String(sel.value));
          const answers = {};
          for (const q of (cur.metadata_schema || [])) {
            const el = document.querySelector(`#planSavedAsk_${CSS.escape(q.field)}`);
            if (el && el.value.trim() !== '') answers[q.field] = q.type === 'number' ? Number(el.value) : el.value;
          }
          const r = await api(`/api/planning/projects/${projectId}/strategies/from-template`, { method: 'POST', body: { name, template_id: Number(sel.value), answers } });
          closeModalEl($('#planStrategyModal'));
          location.hash = `#planning/strategy/${r.strategy.id}`;
        } catch (err) { showMsg(msg, 'err', err.message); }
      });
    } catch (err) { showMsg(msg, 'err', err.message); }
  }
}

// ---- merge / revert wizard ----
async function openPlanMergeModal(strategyId, isRevert) {
  $('#planMergeModalTitle').textContent = isRevert ? 'Revert merge' : 'Merge strategy';
  showMsg($('#planMergeModalMsg'), '', '');
  const body = $('#planMergeModalBody');
  body.innerHTML = '<div class="note">Loading…</div>';
  openModal('planMergeModal');
  const msg = $('#planMergeModalMsg');
  try {
    const data = isRevert
      ? await api(`/api/planning/strategies/${strategyId}/revert-preview`, { method: 'POST' })
      : await api(`/api/planning/strategies/${strategyId}/merge-preview`, { method: 'POST', body: planStrategyScenarioId !== undefined ? { scenarioId: planStrategyScenarioId } : {} });
    let step = 1;
    const resolutions = new Map(); // key -> {resolution, customValue}
    const droppedOps = new Set();
    const conflicts = data.conflicts || [];
    const conflictKey = (c) => `${c.table}:${c.rowId}:${c.field}`;
    const resolvedCount = () => conflicts.filter((c) => resolutions.has(conflictKey(c)) || droppedOps.has(c.opSeq)).length;
    const render = () => {
      if (step === 1) {
        let rows = '';
        if (!isRevert) {
          rows = (data.writes || []).map((w) => {
            if (w.kind === 'insert') return `<div class="plan-row"><span>Add · ${esc(w.label)}</span></div>`;
            if (w.kind === 'delete') return `<div class="plan-row"><span>Remove · ${esc(w.label)}</span></div>`;
            const changes = Object.keys(w.values || {}).map((f) => `${f}: ${esc(String((w.before || {})[f] ?? ''))} → ${esc(String(w.values[f] ?? ''))}`).join(' · ');
            return `<div class="plan-row"><span>Change · ${esc(w.label)} · ${changes}</span></div>`;
          }).join('');
        } else {
          rows = (data.inverse || []).map((w) => {
            if (w.kind === 'delete') return `<div class="plan-row"><span>Remove · ${esc(w.label || '')}</span></div>`;
            if (w.kind === 'insert') return `<div class="plan-row"><span>Restore · ${esc(w.label || '')}</span></div>`;
            const changes = Object.keys(w.values || {}).map((f) => `${f} → ${esc(String(w.values[f] ?? ''))}`).join(' · ');
            return `<div class="plan-row"><span>Restore · ${esc(w.label || '')} · ${changes}</span></div>`;
          }).join('');
        }
        body.innerHTML = `
          <div class="note">${esc(data.moneyNote || '')}</div>
          ${rows || '<div class="note">Nothing to change.</div>'}
          ${!isRevert && data.penalties && data.penalties.length ? `<div class="note">Penalties (estimates): ${data.penalties.map((x) => money2(x.penalty)).join(', ')}</div>` : ''}
          ${!isRevert && data.fees ? `<div class="note">Fees: ${money2(data.fees)}</div>` : ''}
          ${isRevert && data.dependents && data.dependents.length ? `<div class="msg err">Blocked: later merges or mainline records depend on this merge — revert them first (newest first): ${esc(data.dependents.map((x) => x.strategyName || `${x.table} #${x.rowId}`).join(', '))}</div>` : ''}
          <div class="toolbar"><button class="primary" id="planMergeNext1">Next</button></div>`;
        $('#planMergeNext1').addEventListener('click', () => { step = 2; render(); });
      } else if (step === 2) {
        if (!conflicts.length) {
          body.innerHTML = `<div class="note">No differences to resolve.</div>
            <div class="toolbar"><button class="primary" id="planMergeNext2">Next</button></div>`;
          $('#planMergeNext2').addEventListener('click', () => { step = 3; render(); });
          return;
        }
        const cards = conflicts.map((c) => {
          const key = conflictKey(c);
          const cur = resolutions.get(key);
          return `<div class="panel">
            <div class="k">${esc(c.label || `${c.table} #${c.rowId}`)} · ${esc(c.field)}</div>
            <div class="grid2">
              <div><label>Baseline</label><div>${esc(String(c.base ?? ''))}</div></div>
              <div><label>Current mainline</label><div>${esc(String(c.current ?? ''))}</div></div>
              <div><label>${isRevert ? 'Before the merge' : 'Strategy wants'}</label><div>${esc(String(c.incoming ?? ''))}</div></div>
            </div>
            <div class="toolbar">
              <label class="btnlike"><input type="radio" name="plan-res-${key}" value="current"${cur && cur.resolution === 'current' ? ' checked' : ''}> Keep current</label>
              <label class="btnlike"><input type="radio" name="plan-res-${key}" value="incoming"${cur && cur.resolution === 'incoming' ? ' checked' : ''}> ${isRevert ? 'Use before' : "Use the strategy's"}</label>
              <label class="btnlike"><input type="radio" name="plan-res-${key}" value="custom"${cur && cur.resolution === 'custom' ? ' checked' : ''}> Write your own <input type="text" data-plan-custom="${key}" value="${cur && cur.customValue != null ? esc(String(cur.customValue)) : ''}"></label>
              ${!isRevert && c.opSeq != null ? `<button class="small danger" data-plan-drop="${c.opSeq}">Drop this change</button>` : ''}
            </div></div>`;
        }).join('');
        body.innerHTML = `
          <div class="note">Resolved ${resolvedCount()} / ${conflicts.length}</div>
          <div class="toolbar"><button class="small" id="planMergeKeepAll">Keep all current</button><button class="small" id="planMergeTakeAll">Take all incoming</button></div>
          ${cards}
          <div class="toolbar"><button class="primary" id="planMergeNext2"${resolvedCount() < conflicts.length ? ' disabled' : ''}>Next</button></div>`;
        body.querySelectorAll('input[type="radio"][name^="plan-res-"]').forEach((r) => r.addEventListener('change', () => {
          const key = r.name.slice('plan-res-'.length);
          const customEl = body.querySelector(`[data-plan-custom="${key}"]`);
          resolutions.set(key, { resolution: r.value, customValue: customEl ? customEl.value : null });
          render();
        }));
        body.querySelectorAll('[data-plan-custom]').forEach((el) => el.addEventListener('input', () => {
          const key = el.dataset.planCustom;
          const cur = resolutions.get(key) || {};
          resolutions.set(key, { ...cur, resolution: 'custom', customValue: el.value });
        }));
        body.querySelectorAll('[data-plan-drop]').forEach((b) => b.addEventListener('click', () => {
          droppedOps.add(Number(b.dataset.planDrop));
          render();
        }));
        $('#planMergeKeepAll').addEventListener('click', () => {
          conflicts.forEach((c) => resolutions.set(conflictKey(c), { resolution: 'current' }));
          render();
        });
        $('#planMergeTakeAll').addEventListener('click', () => {
          conflicts.forEach((c) => resolutions.set(conflictKey(c), { resolution: 'incoming' }));
          render();
        });
        const nextBtn = $('#planMergeNext2');
        if (nextBtn) nextBtn.addEventListener('click', () => { step = 3; render(); });
      } else {
        body.innerHTML = `
          <div class="note">${esc(data.moneyNote || '')}</div>
          <div class="note">${conflicts.length ? `${resolvedCount()} difference(s) resolved.` : 'No differences.'} ${droppedOps.size ? `${droppedOps.size} operation(s) dropped.` : ''}</div>
          <div class="toolbar"><button class="primary" id="planMergeConfirmBtn">Confirm ${isRevert ? 'revert' : 'merge'}</button></div>`;
        $('#planMergeConfirmBtn').addEventListener('click', async () => {
          try {
            const resList = conflicts.filter((c) => !droppedOps.has(c.opSeq)).map((c) => {
              const r = resolutions.get(conflictKey(c)) || { resolution: 'incoming' };
              return { table: c.table, rowId: c.rowId, field: c.field, resolution: r.resolution, customValue: r.customValue };
            });
            for (const seq of droppedOps) resList.push({ opSeq: seq, resolution: 'drop' });
            if (isRevert) await api(`/api/planning/strategies/${strategyId}/revert`, { method: 'POST', body: { resolutions: resList } });
            else await api(`/api/planning/strategies/${strategyId}/merge`, { method: 'POST', body: { resolutions: resList, ...(planStrategyScenarioId !== undefined ? { scenarioId: planStrategyScenarioId } : {}) } });
            closeModalEl($('#planMergeModal'));
            loadPlanStrategy(strategyId);
          } catch (err) { showMsg(msg, 'err', err.message); }
        });
      }
    };
    render();
  } catch (err) { showMsg(msg, 'err', err.message); }
}

// ---- planning month picker ----
let planMonthBtn = null;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-plan-month]');
  if (!b) return;
  if (monthPopFor === 'planOp' && planMonthBtn === b) { closeMonthPop(); return; }
  planMonthBtn = b;
  openMonthPop('planOp');
});
