// swaper frontend. No framework, no CDN. One horizontal row per account.

// The usage endpoint rate-limits hard and its numbers move slowly, so polling is cheap
// on purpose. The manual refresh button is there when you want it sooner.
const POLL_MS = 5 * 60 * 1000;
const BAR_CELLS = 18;

const $ = (sel, root = document) => root.querySelector(sel);
const rowsEl = $('#rows');
const tpl = $('#tpl-row');

let accounts = [];
let usageById = {};
let lastFetch = 0;
let swapping = false;

/* ---------------- transport ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Swaper': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- toasts ---------------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, kind === 'err' ? 7000 : 4000);
}

/* ---------------- formatting ---------------- */

function countdown(iso) {
  if (!iso) return 'sin reset';
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return 'sin reset';
  const ms = target - Date.now();
  if (ms <= 0) return 'reset ok';

  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (d > 0) return `reset en ${d}d ${h}h`;
  if (h > 0) return `reset en ${h}h ${m}m`;
  if (m > 0) return `reset en ${m}m ${s}s`;
  return `reset en ${s}s`;
}

function agoLabel(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 10) return 'sync ahora';
  if (s < 60) return `sync -${s}s`;
  return `sync -${Math.floor(s / 60)}m`;
}

/** Segmented block bar: filled cells in the severity colour, the rest dimmed. */
function renderBar(el, percent) {
  const pct = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((pct / 100) * BAR_CELLS);
  el.textContent = '';
  if (filled > 0) el.append(document.createTextNode('█'.repeat(filled)));
  if (filled < BAR_CELLS) {
    const off = document.createElement('span');
    off.className = 'off';
    off.textContent = '░'.repeat(BAR_CELLS - filled);
    el.append(off);
  }
}

function fillGauge(gaugeEl, data) {
  gaugeEl.dataset.sev = data ? data.severity : 'unknown';
  const pct = data ? data.percent : null;
  renderBar($('.bar', gaugeEl), pct);
  $('.pct', gaugeEl).textContent = pct == null ? '--%' : `${pct}%`;
  const rst = $('.rst', gaugeEl);
  rst.textContent = data ? countdown(data.resetsAt) : '';
  rst.dataset.resetsAt = (data && data.resetsAt) || '';
}

/* ---------------- rendering ---------------- */

function renderSkeletons(n = 2) {
  rowsEl.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('article');
    row.className = 'row is-skel';
    row.innerHTML = '<span class="led"></span><div class="who"></div><span class="plan"></span>'
      + '<div class="gauge"></div><div class="gauge"></div><div class="act"></div>';
    rowsEl.append(row);
  }
}

function buildRow(account) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const usage = usageById[account.id];

  node.dataset.id = account.id;
  node.classList.toggle('is-active', account.isActive);

  $('.name', node).textContent = account.label;
  $('.mail', node).textContent = account.email || '—';
  $('.plan', node).textContent = account.plan || '';

  const session = $('.gauge[data-kind="session"]', node);
  const weekly = $('.gauge[data-kind="weekly"]', node);
  const errEl = $('.row-err', node);

  if (usage && usage.ok) {
    fillGauge(session, usage.session);
    fillGauge(weekly, usage.weekly);
    const notes = (usage.scoped || []).map((s) => `${s.label} ${s.percent}%`);
    if (usage.stale) {
      node.classList.add('is-stale');
      const age = Math.round((Date.now() - usage.staleSince) / 1000);
      notes.unshift(`datos de hace ${age}s — ${usage.staleReason}`);
    }
    if (usage.locked) {
      errEl.hidden = false;
      errEl.textContent = `bloqueado: ${usage.locked}`;
    } else if (notes.length) {
      errEl.hidden = false;
      errEl.style.color = usage.stale ? 'var(--amb)' : 'var(--fg-faint)';
      errEl.textContent = `· ${notes.join('  ·  ')}`;
    }
  } else if (usage) {
    node.classList.add('is-err');
    errEl.hidden = false;
    errEl.textContent = usage.needsRelogin
      ? 'token inválido — haz /login con esa cuenta y pulsa [i] import'
      : usage.error || 'no se pudo leer el uso';
    fillGauge(session, null);
    fillGauge(weekly, null);
  } else {
    fillGauge(session, null);
    fillGauge(weekly, null);
  }

  const swapBtn = $('.btn-swap', node);
  if (account.isActive) {
    swapBtn.remove();
  } else {
    swapBtn.disabled = swapping;
    swapBtn.addEventListener('click', () => doSwap(account.id, swapBtn));
  }
  $('.btn-x', node).addEventListener('click', () => removeAccount(account));

  return node;
}

function render() {
  const has = accounts.length > 0;
  $('#empty').hidden = has;
  $('.board').hidden = !has;
  $('#board-head').hidden = !has;
  rowsEl.setAttribute('aria-busy', 'false');
  rowsEl.innerHTML = '';

  // active first, then the least-used session — the next one worth switching to.
  const sorted = [...accounts].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const ua = usageById[a.id], ub = usageById[b.id];
    const pa = ua && ua.ok ? ua.session.percent : 999;
    const pb = ub && ub.ok ? ub.session.percent : 999;
    return pa - pb;
  });

  for (const account of sorted) rowsEl.append(buildRow(account));
  $('#stale').textContent = agoLabel(lastFetch);
}

/* ---------------- actions ---------------- */

async function removeAccount(account) {
  if (!confirm(`Quitar "${account.label}" del dashboard?\n\nSolo se borra de aquí; la cuenta de Anthropic no se toca.`)) return;
  try {
    await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
    toast(`${account.label} eliminada`);
    await refresh(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function doSwap(id, button) {
  if (swapping) return;
  swapping = true;
  document.querySelectorAll('.btn-swap').forEach((b) => { b.disabled = true; });
  const row = button.closest('.row');
  row.classList.add('is-busy');
  button.textContent = 'SWAPPING';

  try {
    const result = await api('/api/swap', { method: 'POST', body: { id } });
    toast(`activa: ${result.account.label}`);
    for (const w of result.warnings || []) toast(w);
    await refresh(true);
  } catch (err) {
    button.textContent = 'SWAP';
    row.classList.remove('is-busy');
    toast(`swap fallido: ${err.message}`, 'err');
  } finally {
    swapping = false;
    document.querySelectorAll('.btn-swap').forEach((b) => { b.disabled = false; });
  }
}

async function importCurrent(configDir) {
  const buttons = [$('#btn-import'), $('#btn-import-empty')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const result = await api('/api/accounts/import', { method: 'POST', body: configDir ? { configDir } : {} });
    toast(`importada: ${result.account.email}`);
    await refresh(true);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/* ---------------- add account ---------------- */

/* ---------------- data ---------------- */

async function refresh(force = false) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  try {
    const data = await api('/api/accounts');
    accounts = data.accounts;
    usageById = accounts.length ? await api(`/api/usage/all${force ? '?force=1' : ''}`) : {};
    lastFetch = Date.now();
    $('#banner-offline').hidden = true;

    const health = await api('/api/health').catch(() => null);
    $('#banner-running').hidden = !(health && health.claudeRunning);

    render();
  } catch (err) {
    $('#banner-offline').hidden = false;
    rowsEl.setAttribute('aria-busy', 'false');
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- boot ---------------- */

$('#btn-refresh').addEventListener('click', () => refresh(true));
// Plain click imports the live session. Shift-click imports from an isolated login
// (CLAUDE_CONFIG_DIR=... claude /login), so you can capture another account without
// disturbing the one you are working in.
const wireImport = (el) => el && el.addEventListener('click', (e) => {
  if (!e.shiftKey) return importCurrent();
  const dir = prompt('Carpeta de config aislada (la que usaste en CLAUDE_CONFIG_DIR):');
  if (dir) importCurrent(dir.trim());
});
wireImport($('#btn-import'));
wireImport($('#btn-import-empty'));

// Keyboard shortcuts, ignored while typing in a field.
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'r') refresh(true);
  if (e.key === 'i') importCurrent();
});

setInterval(() => {
  for (const el of document.querySelectorAll('.rst[data-resets-at]')) {
    if (el.dataset.resetsAt) el.textContent = countdown(el.dataset.resetsAt);
  }
  $('#stale').textContent = agoLabel(lastFetch);
}, 1000);

setInterval(() => { if (!swapping) refresh(false); }, POLL_MS);

// Boot WITHOUT force: a page reload should reuse the server cache, not spend a fresh
// API call every time. Forcing on every load is what got us rate limited.
renderSkeletons();
refresh(false);
