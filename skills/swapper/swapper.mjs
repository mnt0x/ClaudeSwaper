#!/usr/bin/env node
'use strict';
// Thin CLI over the running LLMSwapper server, for the /swapper* skills. Zero dependencies,
// Node 18+ (global fetch). Talks only to the local panel; the panel does the real work.
//
//   node swapper.mjs usage              list every account and its available quota
//   node swapper.mjs swap <name>        switch the active account (host) to the one named
//   node swapper.mjs auto on|off|status turn automatic rotation on/off, or show it
//
// PORT overrides the port (default 7373). NO_COLOR disables the ANSI colour. Nothing here
// holds a token; it all goes through 127.0.0.1 with the panel's own header.

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

/* ---------- colour (truecolor ANSI; NO_COLOR turns it off) ---------- */

const COLOR = !process.env.NO_COLOR;
// The panel's palette: phosphor green + the severity ramp. One language of colour.
const RGB = {
  phos: [0, 255, 156], ok: [0, 255, 156], medium: [255, 204, 77],
  high: [255, 152, 56], crit: [255, 92, 114], dim: [122, 157, 141], faint: [60, 80, 70],
};
function c(name, s) {
  if (!COLOR) return s;
  const [r, g, b] = RGB[name] || RGB.dim;
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);

// The same thresholds the app recomputes locally, so colour == the meter's severity.
function sev(p) {
  if (p == null) return 'dim';
  if (p >= 95) return 'crit';
  if (p >= 80) return 'high';
  if (p >= 50) return 'medium';
  return 'ok';
}

/* ---------- formatting ---------- */

const BAR_W = 10;
function bar(p) {
  const name = sev(p);
  if (p == null) return c('faint', '·'.repeat(BAR_W));
  const filled = Math.max(0, Math.min(BAR_W, Math.round((p / 100) * BAR_W)));
  return c(name, '█'.repeat(filled)) + c('faint', '░'.repeat(BAR_W - filled));
}
function pctStr(p) {
  const s = (p == null ? '  —' : `${p}%`).padStart(4);
  return p == null ? c('dim', s) : c(sev(p), bold(s));
}
const level = (p) => (p == null ? '' : p >= 95 ? 'llena' : p >= 80 ? 'casi llena' : '');
function trunc(s, n) { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

// One account's two-line block: identity, then the two meters aligned under it.
function block(acc, u, activeId) {
  const active = acc.id === activeId;
  const s = u && u.ok ? (u.session ? u.session.percent : null) : null;
  const w = u && u.ok ? (u.weekly ? u.weekly.percent : null) : null;
  const dot = active ? c('phos', '●') : ' ';
  const name = active ? c('phos', bold(trunc(acc.label, 18).padEnd(18))) : bold(trunc(acc.label, 18).padEnd(18));
  const head = `  ${dot} ${name}  ${c('dim', trunc(acc.email || '', 34))}`;

  let estado = active ? c('phos', '· EN USO') : '';
  if (u && !u.ok) estado = c('crit', `· ${u.needsRelogin ? 'token caducado — reimporta' : (u.error || 'sin datos')}`);
  else if (level(s)) estado = `${estado ? estado + '  ' : '· '}${c(sev(s), 'sesión ' + level(s))}`.trim();

  const meters = `      ${c('dim', '5h')} ${bar(s)} ${pctStr(s)}     ${c('dim', '7d')} ${bar(w)} ${pctStr(w)}   ${estado}`.trimEnd();
  return head + '\n' + meters;
}

async function cmdUsage() {
  const [{ accounts, activeId }, usage] = await Promise.all([
    api('/api/accounts?target=host'),
    api('/api/usage/all'),
  ]);
  if (!accounts.length) { console.log('\n  No hay cuentas todavía. Añádelas en el panel (import o pegar token).\n'); return; }

  console.log(`\n  ${c('phos', bold('LLMSwapper'))} ${c('dim', '· uso disponible por cuenta            (entorno: host)')}\n`);
  const ord = [...accounts].sort((a, b) => {
    if ((a.id === activeId) !== (b.id === activeId)) return a.id === activeId ? -1 : 1;
    const pa = (usage[a.id] && usage[a.id].ok && usage[a.id].session) ? usage[a.id].session.percent : 999;
    const pb = (usage[b.id] && usage[b.id].ok && usage[b.id].session) ? usage[b.id].session.percent : 999;
    return pa - pb;
  });
  for (const a of ord) console.log(block(a, usage[a.id], activeId) + '\n');

  const readable = accounts
    .map((a) => ({ a, u: usage[a.id] }))
    .filter((x) => x.u && x.u.ok && x.u.session)
    .map((x) => ({ label: x.a.label, id: x.a.id, s: x.u.session.percent, w: x.u.weekly ? x.u.weekly.percent : 0 }));
  const active = readable.find((x) => x.id === activeId);
  const freest = readable.filter((x) => x.id !== activeId && x.s < 90 && x.w < 90).sort((x, y) => x.s - y.s)[0];
  const full = readable.filter((x) => x.id !== activeId && x.s >= 80).map((x) => `${x.label} ${x.s}%`);
  const parts = [];
  if (active) parts.push(`${c('dim', 'Activa:')} ${bold(active.label)} ${c(sev(active.s), `(${active.s}% / ${active.w}%)`)}`);
  if (freest) parts.push(`${c('dim', 'más libre:')} ${c('ok', bold(freest.label))} ${c('dim', `— /swapper ${(freest.label || '').split(' ')[0]}`)}`);
  else parts.push(c('dim', 'ninguna otra con margen bajo el 90%'));
  if (full.length) parts.push(`${c('dim', 'evita:')} ${c('high', full.join(', '))}`);
  console.log('  ' + parts.join(c('faint', '   ·   ')) + '\n');
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

async function meterLine(id) {
  try {
    const u = await api(`/api/usage?id=${encodeURIComponent(id)}`);
    if (u && u.ok) {
      const s = u.session ? u.session.percent : null;
      const w = u.weekly ? u.weekly.percent : null;
      console.log(`      ${c('dim', '5h')} ${bar(s)} ${pctStr(s)}     ${c('dim', '7d')} ${bar(w)} ${pctStr(w)}`);
    } else if (u) console.log(c('dim', `      uso: ${u.error || 'no disponible'}`));
  } catch { /* usage is a nicety; a swap that worked must not read as failed */ }
}

async function cmdSwap(args) {
  const { accounts, activeId } = await api('/api/accounts?target=host');
  const acc = findAccount(accounts, args.join(' '));
  if (acc.id === activeId) {
    console.log(`\n  ${c('phos', '●')} ${bold(acc.label)}${acc.email ? c('dim', '  ' + acc.email) : ''} ya es la cuenta activa en el host.`);
    await meterLine(acc.id);
    console.log('');
    return;
  }
  const r = await api('/api/swap', { method: 'POST', body: { id: acc.id, target: 'host' } });
  console.log(`\n  ${c('ok', '✓')} ${c('dim', 'Cuenta activa:')} ${c('phos', bold(r.account.label))}${r.account.email ? c('dim', '  ' + r.account.email) : ''}${r.verified ? c('dim', '   (token verificado)') : ''}`);
  await meterLine(acc.id);
  for (const wmsg of r.warnings || []) console.log(c('medium', `  · ${wmsg}`));
  console.log(c('dim', '  El cambio se aplica a las sesiones NUEVAS de Claude Code (una ya abierta conserva su token).\n'));
}

/* ---------- auto ---------- */

function autoBrief(x) {
  if (!x) return c('dim', '—');
  const s = x.sessionPercent, w = x.weeklyPercent;
  return `${bold(x.label)}${x.email ? c('dim', '  ' + x.email) : ''}\n      ${c('dim', '5h')} ${bar(s)} ${pctStr(s)}     ${c('dim', '7d')} ${bar(w)} ${pctStr(w)}`;
}

async function cmdAuto(args) {
  const verb = (args[0] || 'status').toLowerCase();
  let st;
  if (['on', 'true', 'activar', 'enciende'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: true } });
  else if (['off', 'false', 'desactivar', 'apaga'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: false } });
  else st = await api('/api/auto');

  const estado = st.enabled ? c('ok', bold('● ACTIVADA')) : c('dim', '○ desactivada');
  console.log(`\n  ${c('phos', 'Rotación automática:')} ${estado}     ${c('dim', `entorno ${st.target}     umbral ${st.threshold}%`)}\n`);
  console.log(`  ${c('dim', 'Cuenta actual   ')} ${autoBrief(st.current)}`);
  console.log(`  ${c('dim', 'Siguiente cuenta')} ${st.next ? autoBrief(st.next) : c('dim', '— (ninguna con margen bajo el ' + st.threshold + '%)')}`);
  if (st.enabled) {
    console.log(c('dim', `\n  Cuando la sesión 5h de la actual llegue al ${st.threshold}%, el panel cambia solo a la siguiente.`));
  } else {
    console.log(`\n  ${c('dim', 'Actívala con')}  ${c('phos', '/swapper-auto on')}`);
  }
  console.log('');
}

/* ---------- dispatch ---------- */

const [cmd, ...args] = process.argv.slice(2);
const run = { usage: cmdUsage, swap: () => cmdSwap(args), auto: () => cmdAuto(args), status: () => cmdAuto(['status']) };
(run[cmd] || (() => { console.error('uso: swapper.mjs usage | swap <nombre> | auto on|off|status'); process.exitCode = 1; }))()
  .catch((err) => { console.error(`\n  ${c('crit', '✗')} ${err.message}\n`); process.exitCode = 1; });
