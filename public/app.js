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
// Ultimo /api/health recibido, para el readout del backend del puesto de mando.
let lastHealth = null;

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
  renderFocus();
  renderKpis();
  renderReadout();
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
    lastHealth = health;

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
    // Verticales verde, PAREJAS por todo el viewport: el fondo es un instrumento a
    // pantalla completa, no un brillo de esquina. Antes pesaban hacia los margenes y el
    // centro quedaba lavado, lo que hacia leer la pagina como vacia. Sigue tenue: los
    // datos van sobre superficie opaca, la rejilla nunca compite con ellos.
    gctx.strokeStyle = `rgba(${GREEN}, 0.055)`;
    for (let x = 0; x <= W; x += step) {
      gctx.beginPath();
      gctx.moveTo(x + 0.5, 0);
      gctx.lineTo(x + 0.5, H);
      gctx.stroke();
    }
    // Horizontales morado, tenues y parejas (segundo canal).
    gctx.strokeStyle = `rgba(${PURPLE}, 0.045)`;
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


/* =====================================================================
   Puesto de mando. ADITIVO: no toca la logica de arriba. Foco de la cuenta
   activa con dos gauges radiales SVG (firma), tira de KPIs y readout del
   backend. Se enganchan a render()/refresh() con parches minimos. Datos
   reales de accounts, usageById y lastHealth; estados vacios con dignidad
   (sin cuenta activa -> gauges en "—"; sin health -> pie oculto).
   ===================================================================== */

// Circunferencia del arco (r=52 en el viewBox 120): offset 0% = C (vacio), 100% = 0.
const GAUGE_C = 2 * Math.PI * 52; // 326.73

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Cuenta atras compacta para los KPIs: reutiliza countdown() y le quita el prefijo.
function shortReset(iso) {
  return countdown(iso).replace(/^Se reinicia en /, '');
}

// Un gauge radial. data es session/weekly de una NormalizedUsage ok, o null (sin dato).
function gaugeMarkup(kind, data) {
  const known = !!data;
  const sev = known ? data.severity : 'unknown';
  const pct = known ? Math.max(0, Math.min(100, data.percent)) : 0;
  const label = kind === 'session' ? 'sesión · 5h' : 'semana · 7d';
  const offset = (GAUGE_C * (1 - pct / 100)).toFixed(2);
  const num = known ? `${data.percent}<span class="gauge-unit">%</span>` : '—';
  const iso = known && data.resetsAt ? data.resetsAt : '';
  const reset = iso ? countdown(iso) : '';
  return `
  <div class="gauge" data-kind="${kind}" data-sev="${sev}" role="img" aria-label="${label}: ${known ? data.percent + '%' : 'sin datos'}">
    <div class="gauge-ring">
      <svg viewBox="0 0 120 120" class="gauge-svg" aria-hidden="true">
        <circle class="gauge-track" cx="60" cy="60" r="52"/>
        <circle class="gauge-arc" cx="60" cy="60" r="52" style="stroke-dashoffset:${offset}"/>
      </svg>
      <div class="gauge-num">${num}</div>
    </div>
    <div class="gauge-cap">
      <span class="gauge-label">${label}</span>
      <span class="resets" data-resets-at="${iso}">${reset}</span>
    </div>
  </div>`;
}

function renderFocus() {
  const cmd = document.getElementById('cmd');
  if (!cmd) return;
  if (!accounts.length) { cmd.hidden = true; return; }
  cmd.hidden = false;

  const focus = $('#focus');
  const note = $('#focus-note');
  const active = accounts.find((a) => a.isActive);

  if (!active) {
    focus.dataset.state = 'none';
    $('#focus-name').textContent = 'Sin cuenta activa';
    $('#focus-sub').textContent = 'Pulsa swap en una cuenta para ponerla en uso.';
    $('#focus-plan').hidden = true;
    $('#gauges').innerHTML = gaugeMarkup('session', null) + gaugeMarkup('weekly', null);
    note.hidden = true;
    return;
  }

  focus.dataset.state = 'active';
  $('#focus-name').textContent = active.label;
  $('#focus-sub').textContent = `${active.email || ''}${active.org ? ` · ${active.org}` : ''}`;
  const plan = $('#focus-plan');
  plan.hidden = !active.plan;
  plan.textContent = active.plan || '';

  const usage = usageById[active.id];
  const usable = usage && usage.ok ? usage : null;
  $('#gauges').innerHTML = gaugeMarkup('session', usable && usable.session)
    + gaugeMarkup('weekly', usable && usable.weekly);

  // Mismo criterio que la fila: token caducado / throttle / stale / bloqueo se lee aqui.
  const n = noteFor(usage);
  if (n) { note.hidden = false; note.dataset.tone = n.tone; note.textContent = n.text; }
  else { note.hidden = true; }
}

// Mejor salto: menor % de sesion entre cuentas REALMENTE swapeables. Excluye la activa,
// el token caducado, las bloqueadas y las de sesion critica, para no recomendar nunca una
// cuenta a la que no merece la pena (o no se puede) saltar.
function bestJump() {
  let best = null;
  for (const a of accounts) {
    if (a.isActive || a.tokenExpired) continue;
    const u = usageById[a.id];
    if (!u || !u.ok || u.locked || !u.session || !u.weekly) continue;
    // Nada que esté a punto de agotarse en NINGUNA ventana: saltar ahí no da margen.
    if (u.session.severity === 'critical' || u.weekly.severity === 'critical') continue;
    // El techo real de una cuenta es su ventana más gastada. Rankear por la de sesión sola
    // recomendaba una cuenta con 3% de sesión pero 98% de semana: fresca por 5 h y agotada
    // acto seguido. Se rankea por max(sesión, semana) y se nombra la ventana que limita.
    const worst = Math.max(u.session.percent, u.weekly.percent);
    if (best === null || worst < best.worst) {
      best = {
        label: a.label, plan: a.plan, worst,
        limitedByWeek: u.weekly.percent >= u.session.percent,
      };
    }
  }
  return best;
}

// Reinicio mas cercano: min resetsAt futuro entre TODAS las ventanas (session, weekly,
// opus y scoped) de cuentas ok. Pasados y NaN descartados. Es el reloj global; el reloj
// de la cuenta activa vive en el gauge del foco.
function nearestReset() {
  let iso = null;
  let ms = Infinity;
  for (const a of accounts) {
    const u = usageById[a.id];
    if (!u || !u.ok) continue;
    const segs = [u.session, u.weekly, u.opus, ...(u.scoped || [])];
    for (const seg of segs) {
      if (!seg || !seg.resetsAt) continue;
      const t = Date.parse(seg.resetsAt);
      if (Number.isFinite(t) && t > Date.now() && t < ms) { ms = t; iso = seg.resetsAt; }
    }
  }
  return iso;
}

function renderKpis() {
  const el = document.getElementById('kpis');
  if (!el) return;
  if (!accounts.length) { el.innerHTML = ''; return; }

  const total = accounts.length;
  const best = bestJump();
  const soonIso = nearestReset();

  // En cola / con problema: sin usage, error, throttle, stale, bloqueo o token caducado.
  let issues = 0;
  for (const a of accounts) {
    const u = usageById[a.id];
    if (!u || !u.ok || u.throttled || u.stale || u.locked || a.tokenExpired) issues++;
  }

  const bestSub = best
    ? `${best.plan ? escapeHtml(best.plan) + ' · ' : ''}${best.worst}% ${best.limitedByWeek ? 'semana' : 'sesión'}`
    : 'todas en uso o en espera';

  el.innerHTML = [
    `<li class="kpi"><span class="kpi-label">cuentas</span><span class="kpi-val">${total}</span></li>`,
    `<li class="kpi"><span class="kpi-label">mejor salto</span><span class="kpi-val">${best ? escapeHtml(best.label) : '—'}</span><span class="kpi-sub">${bestSub}</span></li>`,
    `<li class="kpi"><span class="kpi-label">próximo reinicio</span><span class="kpi-val kpi-reset" data-resets-at="${soonIso || ''}">${soonIso ? escapeHtml(shortReset(soonIso)) : '—'}</span><span class="kpi-sub">cualquier límite</span></li>`,
    `<li class="kpi" data-tone="${issues ? 'warn' : 'ok'}"><span class="kpi-label">en cola</span><span class="kpi-val">${issues}</span><span class="kpi-sub">${issues ? 'requieren atención' : 'todas al día'}</span></li>`,
  ].join('');
}

function renderReadout() {
  const el = document.getElementById('readout');
  if (!el) return;
  const h = lastHealth;
  if (!h) { el.hidden = true; return; } // sin conexion / sin health todavia: pie oculto
  el.hidden = false;
  const set = (id, val) => { const n = document.getElementById(id); if (n) n.textContent = val; };
  set('ro-node', h.node || '—');
  set('ro-platform', h.platform || '—');
  const cb = h.credentialsBackend;
  set('ro-cred', cb ? `${cb.kind}${cb.location ? ` · ${cb.location}` : ''}` : '—');
  const claude = $('#ro-claude');
  const running = !!h.claudeRunning;
  claude.textContent = running ? `abierto${h.pids && h.pids.length ? ` · ${h.pids.length}` : ''}` : 'cerrado';
  claude.classList.toggle('warn', running);
  set('ro-data', (h.paths && h.paths.data) || '—');
}

// El KPI de reinicio tiene su propia cuenta atras (forma corta); los gauges ya tican con
// el intervalo existente porque su cuenta atras lleva la clase .resets. Solo actualiza
// texto, no anima: sigue vivo tambien en reduced-motion.
setInterval(() => {
  for (const el of document.querySelectorAll('#kpis [data-resets-at]')) {
    if (el.dataset.resetsAt) el.textContent = shortReset(el.dataset.resetsAt);
  }
}, 1000);
