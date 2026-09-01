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

/* ---------------- fondo: campo de brasas de fosforo (firma) ----------------
   Particulas advectadas por un flow-field barato (suma de senos: sin tablas de ruido,
   sin librerias). Cada brasa nace, brilla y se apaga; al morir reaparece en otro punto.
   Se dibujan con un sprite radial pre-renderizado en modo aditivo, asi que donde se
   cruzan brillan mas (aire premium sin coste por-frame de createRadialGradient).
   Barato y respetuoso: ~30fps, dpr<=1.5, se congela en document.hidden (visibilitychange)
   y con prefers-reduced-motion pinta UN frame estatico y no arranca el bucle. */
(function emberField() {
  const canvas = document.getElementById('field');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(1.5, window.devicePixelRatio || 1);
  const FRAME = 1000 / 30; // techo de ~30fps
  let w = 0, h = 0, particles = [], raf = 0, running = false, last = 0;

  // Sprite: un disco de fosforo con caida suave, pre-renderizado una sola vez.
  const sprite = (() => {
    const s = document.createElement('canvas');
    const size = 64; s.width = s.height = size;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(150,255,210,1)');
    g.addColorStop(0.35, 'rgba(0,255,156,0.55)');
    g.addColorStop(1, 'rgba(0,255,156,0)');
    c.fillStyle = g; c.fillRect(0, 0, size, size);
    return s;
  })();

  function spawn() {
    const ttl = 6 + Math.random() * 10; // segundos de vida
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      life: Math.random() * ttl, // arranca en un punto cualquiera de su vida: sin frames oscuros
      ttl,
      r: 5 + Math.random() * 12,  // radio de dibujo del sprite (px)
      speed: 6 + Math.random() * 16,
    };
  }

  function resize() {
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Densidad por area, con techo duro para que no se dispare en pantallas grandes.
    const target = Math.max(24, Math.min(110, Math.round((w * h) / 15000)));
    if (particles.length > target) particles.length = target;
    while (particles.length < target) particles.push(spawn());
  }

  // Campo de flujo: angulo suave por posicion + tiempo. Barato y sin bordes duros.
  function flowAngle(x, y, t) {
    return (Math.sin(x * 0.0016 + t * 0.15)
          + Math.cos(y * 0.0018 - t * 0.12)
          + Math.sin((x + y) * 0.001 + t * 0.10)) * 1.15;
  }

  function frame(dt, t) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter'; // aditivo: los cruces brillan mas
    for (const p of particles) {
      const a = flowAngle(p.x, p.y, t);
      p.x += Math.cos(a) * p.speed * dt;
      p.y += Math.sin(a) * p.speed * dt;
      p.life += dt;
      if (p.x < -30) p.x = w + 30; else if (p.x > w + 30) p.x = -30;
      if (p.y < -30) p.y = h + 30; else if (p.y > h + 30) p.y = -30;
      if (p.life >= p.ttl) Object.assign(p, spawn(), { life: 0 });
      // Brillo de brasa: sube y baja a lo largo de la vida (medio seno).
      const k = Math.sin((p.life / p.ttl) * Math.PI);
      ctx.globalAlpha = 0.06 + k * 0.42;
      const d = p.r * 2;
      ctx.drawImage(sprite, p.x - p.r, p.y - p.r, d, d);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    const elapsed = ts - last;
    if (elapsed < FRAME) return; // throttle a ~30fps
    last = ts;
    frame(Math.min(0.05, elapsed / 1000), ts / 1000);
  }

  function start() {
    if (running || reduce) return;
    running = true; last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  resize();
  frame(0, 0); // primer frame: campo visible al instante (y unico frame si reduce)

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); if (reduce || !running) frame(0, performance.now() / 1000); }, 150);
  });
  // Fuera de vista = no gastar: el bucle se para y se reanuda con la pestana.
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  start();
})();

