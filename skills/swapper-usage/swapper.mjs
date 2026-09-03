#!/usr/bin/env node
'use strict';
// Thin CLI over the running LLMSwapper server, for the /swapper* skills. Zero dependencies,
// Node 18+ (global fetch). Talks only to the local panel; the panel does the real work.
//
//   node swapper.mjs usage              list every account and its available quota
//   node swapper.mjs swap <name>        switch the active account (host) to the one named
//   node swapper.mjs auto on|off|status turn automatic rotation on/off, or show it
//
// The layout reads clean even with no colour (the bar fill and the ▲ marker carry the
// state); colour is an enhancement on top. PORT overrides the port; NO_COLOR turns colour off.

const PORT = process.env.PORT || process.env.SWAPPER_PORT || '7373';
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { 'X-Swapper': '1', 'Content-Type': 'application/json' };

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method, headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`No llego al panel en ${BASE}. ¿Está corriendo "node server.js"? (${err.message})`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- colour: 16-colour ANSI (the most widely rendered), off with NO_COLOR ---------- */

const COLOR = !process.env.NO_COLOR;
const CODE = { green: 92, yellow: 93, orange: 33, red: 91, grey: 90, cyan: 96, reset: 0 };
function paint(code, s) { return COLOR ? `\x1b[${code}m${s}\x1b[0m` : s; }
const g = (s) => paint(CODE.green, s);
const dim = (s) => paint(CODE.grey, s);
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);

// The app's severity, recomputed locally, mapped onto the 16-colour set.
function sevColor(p) {
  if (p == null) return CODE.grey;
  if (p >= 95) return CODE.red;
  if (p >= 80) return CODE.orange;
  if (p >= 50) return CODE.yellow;
  return CODE.green;
}
const sevPaint = (p, s) => paint(sevColor(p), s);

/* ---------- width-aware helpers (padding ignores colour codes) ---------- */

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const vlen = (s) => stripAnsi(s).length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };

const WIDTH = 70;
const rule = () => dim('  ' + '─'.repeat(WIDTH));

/* ---------- meters ---------- */

const BAR_W = 10;
function bar(p) {
  if (p == null) return dim('·'.repeat(BAR_W));
  const filled = Math.max(0, Math.min(BAR_W, Math.round((p / 100) * BAR_W)));
  return sevPaint(p, '█'.repeat(filled)) + dim('·'.repeat(BAR_W - filled));
}
const pctStr = (p) => {
  const s = (p == null ? '—' : `${p}%`).padStart(4);
  return p == null ? dim(s) : bold(sevPaint(p, s));
};
// "5h ███··· 85%"
const meter = (tag, p) => `${dim(tag)} ${bar(p)} ${pctStr(p)}`;

// Status word for the right margin: active, near-full, full, or an error.
function statusOf(acc, u, active) {
  if (u && !u.ok) return paint(CODE.red, u.needsRelogin ? 'CADUCADA' : 'sin datos');
  const s = u && u.ok && u.session ? u.session.percent : null;
  if (active) return g('EN USO') + (s != null && s >= 80 ? ' ' + paint(sevColor(s), '▲') : '');
  if (s != null && s >= 95) return paint(CODE.red, '▲ tope');
  if (s != null && s >= 80) return paint(CODE.orange, '▲ casi');
  return '';
}

// Two lines: identity (name · email · status) then the two meters, indented.
function accountLines(acc, u, activeId) {
  const active = acc.id === activeId;
  const s = u && u.ok && u.session ? u.session.percent : null;
  const w = u && u.ok && u.weekly ? u.weekly.percent : null;
  const dot = active ? g('●') : dim('·');
  const name = active ? g(bold(trunc(acc.label, 18))) : bold(trunc(acc.label, 18));
  const status = statusOf(acc, u, active);
  const idLeft = `  ${dot} ${padEnd(name, 18)}  ${dim(padEnd(trunc(acc.email || '—', 30), 30))}`;
  const idLine = padEnd(idLeft, WIDTH + 2 - vlen(status)) + status;
  const meters = `      ${meter('5h', s)}      ${meter('7d', w)}`;
  return [idLine, meters];
}

/* ---------- usage ---------- */

function header(title, right) {
  const left = `  ${g(bold(title))}`;
  return padEnd(left, WIDTH + 2 - vlen(right)) + dim(right);
}

async function cmdUsage() {
  const [{ accounts, activeId }, usage] = await Promise.all([
    api('/api/accounts?target=host'),
    api('/api/usage/all'),
  ]);
  if (!accounts.length) { console.log('\n  No hay cuentas todavía. Añádelas en el panel (import o pegar token).\n'); return; }

  const ord = [...accounts].sort((a, b) => {
    if ((a.id === activeId) !== (b.id === activeId)) return a.id === activeId ? -1 : 1;
    const pa = (usage[a.id] && usage[a.id].ok && usage[a.id].session) ? usage[a.id].session.percent : 999;
    const pb = (usage[b.id] && usage[b.id].ok && usage[b.id].session) ? usage[b.id].session.percent : 999;
    return pa - pb;
  });

  const out = ['', header('LLMSwapper · uso disponible', 'entorno: host'), rule(), ''];
  ord.forEach((a, i) => {
    out.push(...accountLines(a, usage[a.id], activeId));
    if (i < ord.length - 1) out.push('');
  });
  out.push('', rule());

  const readable = accounts
    .map((a) => ({ a, u: usage[a.id] }))
    .filter((x) => x.u && x.u.ok && x.u.session)
    .map((x) => ({ label: x.a.label, id: x.a.id, s: x.u.session.percent, w: x.u.weekly ? x.u.weekly.percent : 0 }));
  const active = readable.find((x) => x.id === activeId);
  const freest = readable.filter((x) => x.id !== activeId && x.s < 90 && x.w < 90).sort((x, y) => x.s - y.s)[0];
  const full = readable.filter((x) => x.id !== activeId && x.s >= 80).map((x) => `${x.label} ${x.s}%`);
  const parts = [];
  if (active) parts.push(`${dim('activa')} ${bold(active.label)} ${sevPaint(active.s, `${active.s}%/${active.w}%`)}`);
  if (freest) parts.push(`${dim('salta a')} ${g(bold(freest.label))} ${dim('/swapper ' + (freest.label || '').split(' ')[0])}`);
  else parts.push(dim('ninguna otra con margen'));
  if (full.length) parts.push(`${dim('evita')} ${paint(CODE.orange, full.join(', '))}`);
  out.push('  ' + parts.join(dim('   ·   ')), '');
  console.log(out.join('\n'));
}

/* ---------- swap ---------- */

function findAccount(accounts, query) {
  const q = query.trim().toLowerCase();
  if (!q) throw new Error('Dime a qué cuenta cambiar: /swapper <nombre o email>');
  const exact = accounts.filter((a) => (a.label || '').toLowerCase() === q || (a.email || '').toLowerCase() === q);
  const hits = exact.length ? exact : accounts.filter((a) =>
    (a.label || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q));
  if (!hits.length) throw new Error(`Ninguna cuenta coincide con "${query}". Prueba /swapper-usage para ver los nombres.`);
  if (hits.length > 1) {
    const names = hits.map((a) => a.email ? `${a.label} <${a.email}>` : a.label).join(', ');
    throw new Error(`"${query}" coincide con varias: ${names}. Usa el email para distinguirlas.`);
  }
  return hits[0];
}

async function usageFor(id) {
  try { return await api(`/api/usage?id=${encodeURIComponent(id)}`); } catch { return null; }
}

async function cmdSwap(args) {
  const { accounts, activeId } = await api('/api/accounts?target=host');
  const acc = findAccount(accounts, args.join(' '));
  const already = acc.id === activeId;
  let r = { account: acc, verified: false, warnings: [] };
  if (!already) r = await api('/api/swap', { method: 'POST', body: { id: acc.id, target: 'host' } });
  const u = await usageFor(acc.id);

  const out = ['', header(already ? '✓ Ya activa' : '✓ Cuenta cambiada', 'entorno: host'), rule(), ''];
  out.push(...accountLines({ id: acc.id, label: r.account.label, email: r.account.email }, u, acc.id));
  out.push('', rule());
  const tail = [];
  if (r.verified) tail.push(g('token verificado'));
  tail.push(dim('se aplica a sesiones NUEVAS'));
  out.push('  ' + tail.join(dim('   ·   ')), '');
  console.log(out.join('\n'));
  for (const wmsg of r.warnings || []) console.log('  ' + paint(CODE.orange, '· ' + wmsg));
  if ((r.warnings || []).length) console.log('');
}

/* ---------- auto ---------- */

function autoAccount(labelLeft, x) {
  if (!x) return [`  ${dim(padEnd(labelLeft, 16))} ${dim('—')}`];
  const s = x.sessionPercent, w = x.weeklyPercent;
  const id = `  ${dim(padEnd(labelLeft, 16))} ${bold(x.label)}${x.email ? '  ' + dim(x.email) : ''}`;
  const meters = `      ${meter('5h', s)}      ${meter('7d', w)}`;
  return [id, meters];
}

async function cmdAuto(args) {
  const verb = (args[0] || 'status').toLowerCase();
  let st;
  if (['on', 'true', 'activar', 'enciende'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: true } });
  else if (['off', 'false', 'desactivar', 'apaga'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: false } });
  else st = await api('/api/auto');

  const estado = st.enabled ? g(bold('● ACTIVADA')) : dim('○ desactivada');
  const out = ['', header('Rotación automática', `host · umbral ${st.threshold}%`), rule(), '',
    `  ${dim(padEnd('estado', 16))} ${estado}`, ''];
  out.push(...autoAccount('cuenta actual', st.current), '');
  out.push(...autoAccount('siguiente', st.next), '', rule());
  out.push('  ' + (st.enabled
    ? dim(`al llegar la sesión al ${st.threshold}% rota sola a la siguiente`)
    : dim('actívala con ') + g('/swapper-auto on')), '');
  console.log(out.join('\n'));
}

/* ---------- dispatch ---------- */

const [cmd, ...args] = process.argv.slice(2);
const run = { usage: cmdUsage, swap: () => cmdSwap(args), auto: () => cmdAuto(args), status: () => cmdAuto(['status']) };
(run[cmd] || (() => { console.error('uso: swapper.mjs usage | swap <nombre> | auto on|off|status'); process.exitCode = 1; }))()
  .catch((err) => { console.error(`\n  ${paint(CODE.red, '✗')} ${err.message}\n`); process.exitCode = 1; });
