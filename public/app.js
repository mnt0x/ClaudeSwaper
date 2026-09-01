// ClaudeSwaper frontend. No framework, no CDN, no build.

// The usage endpoint allows roughly 5 requests per 5 minutes for the WHOLE app, so the
// server enforces a hard gap between outbound calls and serves cache around it. Polling
// often would just pile up throttled requests, so it does not.
const POLL_MS = 10 * 60 * 1000;

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
  el.className = `toast ${kind}`.trim();
  el.append(document.createTextNode(message));
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, kind === 'err' ? 7000 : 4000);
}

/* ---------------- formatting ---------------- */

function countdown(iso) {
  if (!iso) return '';
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return '';
  const ms = target - Date.now();
  if (ms <= 0) return 'Reiniciado';

  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (d > 0) return `Se reinicia en ${d} d ${h} h`;
  if (h > 0) return `Se reinicia en ${h} h ${m} min`;
  if (m > 0) return `Se reinicia en ${m} min`;
  return `Se reinicia en ${s} s`;
}

function syncLabel(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 15) return 'Actualizado ahora';
  if (s < 60) return `Actualizado hace ${s} s`;
  const m = Math.floor(s / 60);
  return `Actualizado hace ${m} min`;
}

function fillMeter(meterEl, data, extra) {
  const known = !!data;
  meterEl.dataset.sev = known ? data.severity : 'unknown';
  $('.value', meterEl).textContent = known ? `${data.percent}%` : '—';
  const fill = $('.fill', meterEl);
  // scaleX rather than width: the compositor handles it and no layout is triggered.
  // Next frame, so the transition actually plays on first paint.
  const pct = known ? Math.max(0, Math.min(100, data.percent)) : 0;
  requestAnimationFrame(() => { fill.style.transform = `scaleX(${pct / 100})`; });
  const resets = $('.resets', meterEl);
  resets.textContent = known ? countdown(data.resetsAt) : '';
  resets.dataset.resetsAt = (known && data.resetsAt) || '';
  // Scoped limits are weekly figures, so they belong on the weekly meter's own line
  // rather than costing the row a full extra line of height.
  resets.dataset.extra = extra || '';
  if (extra) resets.textContent = resets.textContent ? `${resets.textContent} · ${extra}` : extra;
}

/* ---------------- rendering ---------------- */

function renderSkeletons(n = 2) {
  rowsEl.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('article');
    row.className = 'row is-skeleton';
    row.innerHTML = '<div class="who"><span class="bone" style="width:60%"></span></div>'
      + '<span class="bone" style="width:56px"></span>'
      + '<div class="meter"><span class="bone"></span></div>'
      + '<div class="meter"><span class="bone"></span></div>'
      + '<div class="actions"><span class="bone" style="width:84px;height:26px"></span></div>';
    rowsEl.append(row);
  }
}

function noteFor(usage) {
  if (!usage) return null;
  if (usage.ok) {
    if (usage.locked) return { tone: 'warn', text: `Bloqueado: ${usage.locked}` };
    if (usage.stale) {
      const mins = Math.round((Date.now() - usage.staleSince) / 60000);
      const age = mins >= 1 ? `hace ${mins} min` : 'hace menos de un minuto';
      return { tone: 'warn', text: `Datos de ${age}` };
    }
    return null;
  }
  if (usage.needsRelogin) {
    return { tone: 'error', text: 'Token caducado. Haz /login con esta cuenta y vuelve a importarla.' };
  }
  // Throttled or rate-limited says nothing about the account: it still swaps.
  return { tone: 'warn', text: usage.error };
}

function buildRow(account) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const usage = usageById[account.id];

  node.dataset.id = account.id;
  node.classList.toggle('is-active', account.isActive);
  if (usage && !usage.ok) {
    node.classList.add(usage.needsRelogin ? 'is-error' : 'is-waiting');
  }

  $('.name', node).textContent = account.label;
  $('.mail', node).textContent = account.email || '';
  $('.plan', node).textContent = account.plan || '';

  const usable = usage && usage.ok ? usage : null;
  const scoped = usable ? (usable.scoped || []).map((s) => `${s.label} ${s.percent}%`).join(' · ') : '';
  fillMeter($('.meter[data-kind="session"]', node), usable && usable.session);
  fillMeter($('.meter[data-kind="weekly"]', node), usable && usable.weekly, scoped);

  const note = noteFor(usage);
  const noteEl = $('.row-note', node);
  if (note) {
    noteEl.hidden = false;
    noteEl.dataset.tone = note.tone;
    noteEl.textContent = note.text;
  }

  const swapBtn = $('.btn-swap', node);
  if (account.isActive) {
    swapBtn.remove();
  } else {
    swapBtn.disabled = swapping;
    swapBtn.title = `Poner ${account.label} como cuenta activa`;
    swapBtn.addEventListener('click', () => doSwap(account.id, swapBtn));
  }
  $('.btn-remove', node).addEventListener('click', () => removeAccount(account));

  return node;
}

function render() {
  const has = accounts.length > 0;
  $('#empty').hidden = has;
  $('#panel').hidden = !has;
  $('#columns').hidden = !has;
  rowsEl.setAttribute('aria-busy', 'false');
  rowsEl.innerHTML = '';

  // Active first, then the least-used session: the next one worth switching to.
  const sorted = [...accounts].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const ua = usageById[a.id];
    const ub = usageById[b.id];
    const pa = ua && ua.ok ? ua.session.percent : 999;
    const pb = ub && ub.ok ? ub.session.percent : 999;
    return pa - pb;
  });

  for (const account of sorted) rowsEl.append(buildRow(account));
  $('#sync').textContent = syncLabel(lastFetch);
}

/* ---------------- actions ---------------- */

async function removeAccount(account) {
  const ok = confirm(`¿Quitar "${account.label}" del dashboard?\n\n`
    + 'Solo se borra de aquí. La cuenta de Anthropic no se toca.');
  if (!ok) return;
  try {
    await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
    toast(`${account.label} eliminada`, 'ok');
    await refresh(false);
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
  button.classList.add('is-loading');

  try {
    const result = await api('/api/swap', { method: 'POST', body: { id } });
    toast(`Cuenta activa: ${result.account.label}`, 'ok');
    for (const w of result.warnings || []) toast(w);
    // The swap already fetched this account's usage to verify the token; the server
    // seeded its cache with it, so a plain refresh picks it up for free.
    await refresh(false);
  } catch (err) {
    row.classList.remove('is-busy');
    button.classList.remove('is-loading');
    toast(`No se pudo cambiar: ${err.message}`, 'err');
  } finally {
    swapping = false;
    document.querySelectorAll('.btn-swap').forEach((b) => { b.disabled = false; });
  }
}

async function importCurrent(configDir) {
  const buttons = [$('#btn-import'), $('#btn-import-empty')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; b.classList.add('is-loading'); });
  try {
    const result = await api('/api/accounts/import', {
      method: 'POST', body: configDir ? { configDir } : {},
    });
    toast(`Importada: ${result.account.email}`, 'ok');
    await refresh(false);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.classList.remove('is-loading'); });
  }
}

/* ---------------- data ---------------- */

// Accounts that lost the race for the rate-limited slot come back as `throttled`, carrying
// the seconds until their turn. Waiting a whole poll interval for them would be silly, so
// ask again right after the floor lifts. One timer at a time, and never for a hard 429.
let queuedRetry = null;
function scheduleQueuedRetry() {
  const waits = Object.values(usageById)
    .filter((u) => u && u.throttled && Number.isFinite(u.retryInS))
    .map((u) => u.retryInS);
  if (!waits.length) return;
  clearTimeout(queuedRetry);
  queuedRetry = setTimeout(() => { if (!swapping) refresh(false); }, (Math.min(...waits) + 2) * 1000);
}

async function refresh(force = false) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const data = await api('/api/accounts');
    accounts = data.accounts;
    usageById = accounts.length ? await api(`/api/usage/all${force ? '?force=1' : ''}`) : {};
    lastFetch = Date.now();
    $('#banner-offline').hidden = true;
    scheduleQueuedRetry();

    const health = await api('/api/health').catch(() => null);
    $('#banner-running').hidden = !(health && health.claudeRunning);

    render();
  } catch (err) {
    $('#banner-offline').hidden = false;
    rowsEl.setAttribute('aria-busy', 'false');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

/* ---------------- boot ---------------- */

$('#btn-refresh').addEventListener('click', () => refresh(true));

// Plain click imports the live session. Shift-click imports from an isolated login
// (CLAUDE_CONFIG_DIR=... claude /login), so another account can be captured without
// disturbing the one currently in use.
const wireImport = (el) => el && el.addEventListener('click', (e) => {
  if (!e.shiftKey) return importCurrent();
  const dir = prompt('Carpeta de configuración aislada (la que usaste en CLAUDE_CONFIG_DIR):');
  if (dir) importCurrent(dir.trim());
});
wireImport($('#btn-import'));
wireImport($('#btn-import-empty'));

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'r') refresh(true);
  if (e.key === 'i') importCurrent();
});

// Countdowns tick locally; no API call involved.
setInterval(() => {
  for (const el of document.querySelectorAll('.resets[data-resets-at]')) {
    if (!el.dataset.resetsAt) continue;
    const base = countdown(el.dataset.resetsAt);
    const extra = el.dataset.extra;
    el.textContent = extra ? (base ? `${base} · ${extra}` : extra) : base;
  }
  $('#sync').textContent = syncLabel(lastFetch);
}, 1000);

setInterval(() => { if (!swapping) refresh(false); }, POLL_MS);

// Boot WITHOUT force: a page reload should reuse the server cache, not spend a fresh
// API call every time.
renderSkeletons();
refresh(false);
