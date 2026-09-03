#!/usr/bin/env node
'use strict';
// Thin CLI over the running LLMSwapper server, for the /swapper* skills. Zero dependencies,
// Node 18+ (global fetch). Talks only to the local panel; the panel does the real work.
//
//   node swapper.mjs usage              list every account and its available quota
//   node swapper.mjs swap <name>        switch the active account (host) to the one named
//   node swapper.mjs auto on|off|status turn automatic rotation on/off, or show it
//
// PORT overrides the port (default 7373). Nothing here holds a token; it all goes through
// 127.0.0.1 with the panel's own header.

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

// A quota reading -> "12%" plus a marker so a full one stands out in plain text.
function pct(p) {
  if (p == null) return '  —';
  const s = `${p}%`.padStart(4);
  return p >= 90 ? `${s} !!` : p >= 80 ? `${s} !` : s;
}

async function usageLine(acc, u) {
  const s = u && u.ok ? u.session : null;
  const w = u && u.ok ? u.weekly : null;
  const note = u && !u.ok ? (u.needsRelogin ? 'token caducado' : (u.error || 'sin datos')) : '';
  return { s: s ? s.percent : null, w: w ? w.percent : null, note };
}

async function cmdUsage() {
  const [{ accounts }, usage] = await Promise.all([
    api('/api/accounts?target=host'),
    api('/api/usage/all'),
  ]);
  if (!accounts.length) { console.log('No hay cuentas. Añade una con /swapper (import o token) en el panel.'); return; }

  console.log('\n  CUENTA                          SESIÓN 5h   SEMANA 7d   ESTADO');
  console.log('  ' + '─'.repeat(66));
  for (const a of accounts) {
    const u = usage[a.id];
    const { s, w, note } = await usageLine(a, u);
    const name = (a.label || a.email || a.id).padEnd(30).slice(0, 30);
    const estado = a.isActive ? 'EN USO' : note ? note : '';
    console.log(`  ${a.isActive ? '●' : ' '} ${name}  ${pct(s)}      ${pct(w)}     ${estado}`);
  }
  console.log('\n  ! ≥80%   !! ≥90%   ● = cuenta activa en el host\n');
}

function findAccount(accounts, query) {
  const q = query.trim().toLowerCase();
  if (!q) throw new Error('Dime a qué cuenta cambiar: /swapper <nombre o email>');
  const exact = accounts.filter((a) => (a.label || '').toLowerCase() === q || (a.email || '').toLowerCase() === q);
  const hits = (exact.length ? exact : accounts.filter((a) =>
    (a.label || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q)));
  if (!hits.length) throw new Error(`Ninguna cuenta coincide con "${query}". Prueba /swapper-usage para ver los nombres.`);
  if (hits.length > 1) {
    const names = hits.map((a) => a.email ? `${a.label} <${a.email}>` : a.label).join(', ');
    throw new Error(`"${query}" coincide con varias: ${names}. Usa el email para distinguirlas.`);
  }
  return hits[0];
}

async function cmdSwap(args) {
  const { accounts } = await api('/api/accounts?target=host');
  const acc = findAccount(accounts, args.join(' '));
  if (acc.isActive) { console.log(`\n  "${acc.label}" ya es la cuenta activa en el host.`); await showOne(acc.id); return; }
  const r = await api('/api/swap', { method: 'POST', body: { id: acc.id, target: 'host' } });
  console.log(`\n  ✓ Cuenta activa: ${r.account.label}${r.verified ? ' (token verificado)' : ''}`);
  for (const w of r.warnings || []) console.log(`  · ${w}`);
  await showOne(acc.id);
  console.log('  El cambio se aplica a las sesiones NUEVAS de Claude Code.\n');
}

async function showOne(id) {
  try {
    const u = await api(`/api/usage?id=${encodeURIComponent(id)}`);
    if (u && u.ok) {
      console.log(`  Uso disponible -> sesión ${pct(u.session && u.session.percent).trim()}, semana ${pct(u.weekly && u.weekly.percent).trim()}`);
    } else if (u) {
      console.log(`  Uso: ${u.error || 'no disponible'}`);
    }
  } catch { /* usage is a nicety; a swap that worked should not read as failed */ }
}

async function cmdAuto(args) {
  const verb = (args[0] || 'status').toLowerCase();
  let st;
  if (verb === 'on' || verb === 'true' || verb === 'activar') st = await api('/api/auto', { method: 'POST', body: { enabled: true } });
  else if (verb === 'off' || verb === 'false' || verb === 'desactivar') st = await api('/api/auto', { method: 'POST', body: { enabled: false } });
  else st = await api('/api/auto');

  const cur = st.current ? `${st.current.label} (sesión ${pct(st.current.sessionPercent).trim()})` : '—';
  const nxt = st.next ? `${st.next.label} (sesión ${pct(st.next.sessionPercent).trim()})` : '— (ninguna con margen)';
  console.log(`\n  Rotación automática: ${st.enabled ? 'ACTIVADA' : 'desactivada'}  ·  entorno ${st.target}  ·  umbral ${st.threshold}%`);
  console.log(`  Cuenta actual   : ${cur}`);
  console.log(`  Siguiente cuenta: ${nxt}`);
  if (st.enabled) console.log(`  Cuando la sesión de la cuenta actual llegue al ${st.threshold}%, el panel cambia a la siguiente automáticamente.`);
  console.log('');
}

const [cmd, ...args] = process.argv.slice(2);
const run = { usage: cmdUsage, swap: () => cmdSwap(args), auto: () => cmdAuto(args), status: () => cmdAuto(['status']) };
(run[cmd] || (() => { console.error('uso: swapper.mjs usage | swap <nombre> | auto on|off|status'); process.exitCode = 1; }))()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; });
