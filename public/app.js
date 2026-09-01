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
// AbortController of the row confirmation currently open, if any. Also doubles as "a
// destructive question is on screen", which the keyboard shortcuts must not talk over.
let openConfirm = null;

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
  // Per row, or every remove button in the panel announces the same name and a screen
  // reader user cannot tell which account they are about to drop.
  const removeBtn = $('.btn-remove', node);
  removeBtn.title = `Quitar ${account.label} del dashboard`;
  removeBtn.setAttribute('aria-label', removeBtn.title);
  removeBtn.addEventListener('click', () => armRemoval(node, account));

  return node;
}

function render() {
  const has = accounts.length > 0;
  $('#empty').hidden = has;
  $('#panel').hidden = !has;
  $('#columns').hidden = !has;
  rowsEl.setAttribute('aria-busy', 'false');
  // Every row is about to be replaced, so an open confirmation is answering about a node
  // that will not exist — drop it and its document-level listeners with it.
  if (openConfirm) { openConfirm.abort(); openConfirm = null; }
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

/**
 * Destructive, so it asks — inline, in the row itself. A native confirm() cannot be
 * styled, blocks the whole page, and reads as a browser artefact rather than part of
 * the tool. Escape or a click elsewhere backs out.
 *
 * One AbortController owns all four listeners, so closing by ANY route drops them all.
 * {once:true} only fires-and-forgets: closing with Escape left the yes/no handlers
 * attached, and re-opening on the same row stacked another pair — one click on "sí" then
 * sent two DELETEs, the second answering 404, so the user saw a success toast and an
 * error toast for the same removal. It also outlives the row: render() wipes rowsEl, and
 * the document-level listeners would keep pointing at a detached node.
 */
function armRemoval(node, account) {
  const confirmEl = $('.confirm', node);
  if (!confirmEl.hidden) return;

  const ac = new AbortController();
  const { signal } = ac;
  const close = () => {
    confirmEl.hidden = true;
    node.classList.remove('is-confirming');
    if (openConfirm === ac) openConfirm = null;
    ac.abort();
  };

  confirmEl.hidden = false;
  node.classList.add('is-confirming');
  // Named, or a screen reader lands on a bare "no" button with no idea what it answers.
  confirmEl.setAttribute('role', 'group');
  confirmEl.setAttribute('aria-label', `¿Quitar ${account.label} del dashboard?`);
  openConfirm = ac;
  $('.btn-no', confirmEl).focus();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }, { capture: true, signal });
  // Deferred, or the very click that opened this would immediately close it.
  setTimeout(() => document.addEventListener('pointerdown', (e) => {
    if (!confirmEl.contains(e.target)) close();
  }, { capture: true, signal }), 0);

  $('.btn-no', confirmEl).addEventListener('click', close, { signal });
  $('.btn-yes', confirmEl).addEventListener('click', async () => {
    close();
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      toast(`${account.label} eliminada del dashboard`, 'ok');
      await refresh(false);
    } catch (err) {
      toast(err.message, 'err');
    }
  }, { signal });
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
    toast(`No se pudo cambiar: ${err.message}`, 'err');
  } finally {
    // In the finally, not the catch: the swap can succeed and the refresh right after it
    // still fail (server stopped, machine suspended), and refresh() returns without
    // re-rendering. The row would then keep pointer-events:none and a spinning icon for
    // ever. On the success path this node is already detached, so it is a harmless no-op.
    row.classList.remove('is-busy');
    button.classList.remove('is-loading');
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
const dirForm = $('#dir-form');
const dirInput = $('#dir-input');

function openDirField() { dirForm.hidden = false; dirInput.focus(); dirInput.select(); }
function closeDirField() { dirForm.hidden = true; dirInput.value = ''; $('#btn-import').focus(); }

dirForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = dirInput.value.trim();
  if (!dir) { dirInput.focus(); return; }
  dirForm.hidden = true;
  await importCurrent(dir);
  dirInput.value = '';
});
$('#dir-cancel').addEventListener('click', closeDirField);
dirInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDirField(); });

const wireImport = (el) => el && el.addEventListener('click', (e) => (
  e.shiftKey ? openDirField() : importCurrent()
));
wireImport($('#btn-import'));
wireImport($('#btn-import-empty'));

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Not while a "¿quitar?" is on screen: r would re-render the panel out from under the
  // question. And any editable target owns its own letters, not just <input>.
  if (openConfirm) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
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

/* =====================================================================
   Osciloscopio de fondo + logo-traza. ADITIVO: no toca la logica de arriba.
   Una sola firma, barata: rejilla cacheada (offscreen, se dibuja una vez por
   resize) + haz de barrido; el logo #i-swap recorrido por un punto de luz al
   MISMO reloj. Se para en visibilitychange (document.hidden) y no arranca en
   prefers-reduced-motion (dibuja un unico frame estatico y deja el logo solido).
   ===================================================================== */
(() => {
  const canvas = document.getElementById('scope-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const logo = document.getElementById('logo-swap');
  // Mismo matchMedia que escucha el CSS, para no discrepar del piso de calidad.
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const GREEN = '0, 255, 156';   // canal de sesion
  const PURPLE = '124, 92, 255'; // canal de semana

  // Rejilla cacheada en un canvas offscreen: se dibuja una sola vez por resize.
  const grid = document.createElement('canvas');
  const gctx = grid.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  let raf = 0, last = 0, t0 = 0;

  function buildGrid() {
    dpr = Math.min(1.5, window.devicePixelRatio || 1); // dpr limitado: barato
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = grid.width = Math.max(1, Math.round(W * dpr));
    canvas.height = grid.height = Math.max(1, Math.round(H * dpr));
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, W, H);

    const step = 34;
    gctx.lineWidth = 1;
    // Verticales verde: mas presentes hacia los margenes (los datos van sobre
    // superficie opaca, asi que la rejilla no compite en el centro).
    for (let x = 0; x <= W; x += step) {
      const edge = 1 - Math.min(x, W - x) / (W / 2 || 1); // 0 centro -> ~1 borde
      const a = 0.035 + 0.06 * edge;
      gctx.strokeStyle = `rgba(${GREEN}, ${a.toFixed(3)})`;
      gctx.beginPath();
      gctx.moveTo(x + 0.5, 0);
      gctx.lineTo(x + 0.5, H);
      gctx.stroke();
    }
    // Horizontales morado, tenues y parejas (segundo canal).
    gctx.strokeStyle = `rgba(${PURPLE}, 0.04)`;
    for (let y = 0; y <= H; y += step) {
      gctx.beginPath();
      gctx.moveTo(0, y + 0.5);
      gctx.lineTo(W, y + 0.5);
      gctx.stroke();
    }
    // Linea de base del instrumento, algo mas marcada.
    gctx.strokeStyle = `rgba(${GREEN}, 0.09)`;
    gctx.beginPath();
    const mid = Math.round(H / 2) + 0.5;
    gctx.moveTo(0, mid);
    gctx.lineTo(W, mid);
    gctx.stroke();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 32) return; // throttle ~30fps: salta el frame
    last = now;
    const t = (now - t0) / 1000;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Rejilla que respira: solo clear + drawImage(rejilla) con alpha oscilante.
    ctx.globalAlpha = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.6));
    ctx.drawImage(grid, 0, 0, W, H);
    ctx.globalAlpha = 1;

    // Haz de barrido horizontal con estela y borde de ataque brillante.
    const period = 7;
    const p = (t % period) / period;
    const x = p * (W + 160) - 80;
    const trail = 150;
    const tg = ctx.createLinearGradient(x - trail, 0, x, 0);
    tg.addColorStop(0, `rgba(${GREEN}, 0)`);
    tg.addColorStop(1, `rgba(${GREEN}, 0.10)`);
    ctx.fillStyle = tg;
    ctx.fillRect(x - trail, 0, trail, H);
    const eg = ctx.createLinearGradient(x - 2, 0, x + 2, 0);
    eg.addColorStop(0, `rgba(${GREEN}, 0)`);
    eg.addColorStop(0.5, `rgba(${GREEN}, 0.5)`);
    eg.addColorStop(1, `rgba(${GREEN}, 0)`);
    ctx.fillStyle = eg;
    ctx.fillRect(x - 2, 0, 4, H);

    // Logo-traza: un punto de luz recorre las flechas (dasharray 5 26 sobre ~19.5u
    // por flecha), al mismo reloj t que el haz.
    if (logo) logo.style.strokeDashoffset = (-(t * 14) % 31).toFixed(2);
  }

  function still() {
    // Un unico frame estatico de rejilla; logo solido con su glow fijo (CSS).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(grid, 0, 0, W, H);
    ctx.globalAlpha = 1;
    if (logo) { logo.style.strokeDasharray = 'none'; logo.style.strokeDashoffset = '0'; }
  }

  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function start() {
    stop();
    if (reduce.matches) { still(); return; } // no arranca en reduced-motion
    if (document.hidden) return;             // no gasta oculto
    if (logo) logo.style.strokeDasharray = '5 26';
    last = 0; t0 = performance.now();
    raf = requestAnimationFrame(frame);
  }

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { buildGrid(); if (!raf) still(); }, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });
  // Escucha el MISMO media que el CSS: si el usuario lo cambia, congela o revive.
  reduce.addEventListener('change', start);

  buildGrid();
  if (reduce.matches || document.hidden) still(); else start();
})();

