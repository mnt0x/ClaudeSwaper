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
const RGB = {
  phos: [0, 255, 156], ok: [0, 255, 156], medium: [255, 204, 77],
  high: [255, 152, 56], crit: [255, 92, 114], dim: [122, 157, 141], faint: [55, 78, 68],
};
function c(name, s) {
  if (!COLOR) return s;
  const [r, g, b] = RGB[name] || RGB.dim;
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);

// Same thresholds the app recomputes locally, so colour == the meter's severity.
function sev(p) {
  if (p == null) return 'dim';
  if (p >= 95) return 'crit';
  if (p >= 80) return 'high';
  if (p >= 50) return 'medium';
  return 'ok';
}

/* ---------- width-aware layout (padding ignores colour codes) ---------- */

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const vlen = (s) => stripAnsi(s).length;
const padEndV = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));
const padStartV = (s, n) => ' '.repeat(Math.max(0, n - vlen(s))) + s;

const W = 66; // visible width inside the frame
const F = (s) => c('faint', s);
function frameTop(title) {
  const t = ` ${title} `;
  return '  ' + F('╭─') + c('phos', bold(t)) + F('─'.repeat(Math.max(0, W - vlen(t) - 1)) + '╮');
}
function frameTopRight(title, right) {
  const t = ` ${title} `;
  const r = ` ${right} `;
  const mid = Math.max(0, W - vlen(t) - vlen(r) - 1);
  return '  ' + F('╭─') + c('phos', bold(t)) + F('─'.repeat(mid)) + c('dim', r) + F('╮');
}
const frameBottom = () => '  ' + F('╰' + '─'.repeat(W) + '╯');
const row = (content) => '  ' + F('│') + ' ' + padEndV(content, W - 2) + ' ' + F('│');
const blank = () => row('');

/* ---------- meters ---------- */

const BAR_W = 12;
function bar(p) {
  if (p == null) return c('faint', '·'.repeat(BAR_W));
  const filled = Math.max(0, Math.min(BAR_W, Math.round((p / 100) * BAR_W)));
  return c(sev(p), '█'.repeat(filled)) + c('faint', '░'.repeat(BAR_W - filled));
}
const pctStr = (p) => {
  const s = (p == null ? '—' : `${p}%`).padStart(4);
  return p == null ? c('dim', s) : c(sev(p), bold(s));
};

// Two rows inside the frame for one account.
function accountRows(acc, u, activeId) {
  const active = acc.id === activeId;
  const s = u && u.ok ? (u.session ? u.session.percent : null) : null;
  const w = u && u.ok ? (u.weekly ? u.weekly.percent : null) : null;
  const dot = active ? c('phos', '●') : c('faint', '·');
  const name = active ? c('phos', bold(acc.label)) : bold(acc.label);
  let tag = active ? c('phos', 'EN USO') : '';
  if (u && !u.ok) tag = c('crit', u.needsRelogin ? 'caducada' : 'sin datos');
  else if (s != null && s >= 95) tag = c('crit', (tag ? tag + ' ' : '') + '· tope');
  else if (s != null && s >= 80) tag = c('high', (tag ? tag + ' ' : '') + '· casi');

  const left = `${dot} ${name}`;
  const idline = padEndV(left, 22) + c('dim', acc.email || c('faint', '—'));
  const meters = `   ${c('dim', 'S')} ${bar(s)} ${pctStr(s)}   ${c('dim', 'W')} ${bar(w)} ${pctStr(w)}`;
  const metersTagged = padEndV(meters, W - 2 - vlen(tag)) + tag;
  return [row(idline), row(metersTagged)];
}

/* ---------- usage ---------- */

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

  const lines = [];
  ord.forEach((a, i) => {
    lines.push(...accountRows(a, usage[a.id], activeId));
    if (i < ord.length - 1) lines.push(blank());
  });

  console.log('');
  console.log(frameTopRight('LLMSwapper · uso disponible', 'host'));
  console.log(blank());
  for (const l of lines) console.log(l);
  console.log(blank());
  console.log(row(c('faint', 'S sesión 5h   W semana 7d   ') + c('ok', '█') + c('faint', ' libre  ') + c('high', '█') + c('faint', ' casi  ') + c('crit', '█') + c('faint', ' tope')));
  console.log(frameBottom());

  const readable = accounts
    .map((a) => ({ a, u: usage[a.id] }))
    .filter((x) => x.u && x.u.ok && x.u.session)
    .map((x) => ({ label: x.a.label, id: x.a.id, s: x.u.session.percent, w: x.u.weekly ? x.u.weekly.percent : 0 }));
  const active = readable.find((x) => x.id === activeId);
  const freest = readable.filter((x) => x.id !== activeId && x.s < 90 && x.w < 90).sort((x, y) => x.s - y.s)[0];
  const full = readable.filter((x) => x.id !== activeId && x.s >= 80).map((x) => `${x.label} ${x.s}%`);
  const parts = [];
  if (active) parts.push(`${c('dim', 'activa')} ${bold(active.label)} ${c(sev(active.s), `${active.s}%/${active.w}%`)}`);
  if (freest) parts.push(`${c('dim', 'salta a')} ${c('ok', bold(freest.label))} ${c('faint', `/swapper ${(freest.label || '').split(' ')[0]}`)}`);
  else parts.push(c('dim', 'ninguna otra con margen'));
  if (full.length) parts.push(`${c('dim', 'evita')} ${c('high', full.join(', '))}`);
  console.log('   ' + parts.join(c('faint', '  ·  ')) + '\n');
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

  const out = [
    frameTop(already ? 'Ya activa' : 'Cuenta cambiada'),
    blank(),
    ...accountRows({ id: acc.id, label: r.account.label, email: r.account.email }, u, acc.id),
    blank(),
    ...(r.verified ? [row(c('ok', '✓ token verificado contra la API'))] : []),
    row(c('dim', 'Se aplica a sesiones NUEVAS; una abierta conserva su token.')),
    frameBottom(),
  ];
  console.log('\n' + out.join('\n'));
  for (const wmsg of r.warnings || []) console.log('   ' + c('medium', '· ' + wmsg));
  console.log('');
}

/* ---------- auto ---------- */

function autoRows(labelLeft, x) {
  if (!x) return [row(padEndV(c('dim', labelLeft), 20) + c('dim', '—'))];
  const s = x.sessionPercent, w = x.weeklyPercent;
  const id = padEndV(c('dim', labelLeft), 20) + bold(x.label) + (x.email ? c('dim', '  ' + x.email) : '');
  const meters = `   ${c('dim', 'S')} ${bar(s)} ${pctStr(s)}   ${c('dim', 'W')} ${bar(w)} ${pctStr(w)}`;
  return [row(id), row(meters)];
}

async function cmdAuto(args) {
  const verb = (args[0] || 'status').toLowerCase();
  let st;
  if (['on', 'true', 'activar', 'enciende'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: true } });
  else if (['off', 'false', 'desactivar', 'apaga'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: false } });
  else st = await api('/api/auto');

  const estado = st.enabled ? c('ok', bold('● ACTIVADA')) : c('dim', '○ desactivada');
  const out = [
    frameTopRight('Rotación automática', `host · umbral ${st.threshold}%`),
    blank(),
    row(padEndV(c('dim', 'estado'), 20) + estado),
    blank(),
    ...autoRows('cuenta actual', st.current),
    blank(),
    ...autoRows('siguiente', st.next),
    frameBottom(),
  ];
  console.log('\n' + out.join('\n'));
  if (st.enabled) console.log('   ' + c('dim', `Al llegar la sesión al ${st.threshold}%, rota sola a la siguiente.`) + '\n');
  else console.log('   ' + c('dim', 'Actívala con ') + c('phos', '/swapper-auto on') + '\n');
}

/* ---------- dispatch ---------- */

const [cmd, ...args] = process.argv.slice(2);
const run = { usage: cmdUsage, swap: () => cmdSwap(args), auto: () => cmdAuto(args), status: () => cmdAuto(['status']) };
(run[cmd] || (() => { console.error('uso: swapper.mjs usage | swap <nombre> | auto on|off|status'); process.exitCode = 1; }))()
  .catch((err) => { console.error(`\n  ${c('crit', '✗')} ${err.message}\n`); process.exitCode = 1; });
