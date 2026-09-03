#!/usr/bin/env node
'use strict';
// Thin CLI over the running LLMSwapper server, for the /swapper* skills. Zero dependencies,
// Node 18+ (global fetch). Talks only to the local panel; the panel does the real work.
//
//   node swapper.mjs usage              list every account, its quota and when it resets
//   node swapper.mjs swap <name>        switch the active account (host) to the one named
//   node swapper.mjs auto on|off|status turn automatic rotation on/off, show the whole queue
//
// Plain text by design: Claude Code re-types a skill's output into its reply as markdown,
// which drops ANSI colour, so the layout carries the state on its own (bar fill, ▲ markers,
// reasons in words). PORT overrides the port.

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

/* ---------- layout ---------- */

const WIDTH = 74;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const padStart = (s, n) => ' '.repeat(Math.max(0, n - s.length)) + s;
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };
const rule = () => '  ' + '─'.repeat(WIDTH);
const header = (title, right) => padEnd(`  ${title}`, WIDTH + 2 - right.length) + right;

const BAR_W = 10;
function bar(p) {
  if (p == null) return '·'.repeat(BAR_W);
  const filled = Math.max(0, Math.min(BAR_W, Math.round((p / 100) * BAR_W)));
  return '█'.repeat(filled) + '·'.repeat(BAR_W - filled);
}
const pct = (p) => (p == null ? '—' : `${p}%`).padStart(4);

// "4h 43m" / "3d 5h" / "12m" until an ISO instant; "—" when unknown or already past.
function resetIn(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'ya';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// "5h ███······· 23%  ↻ 4h 43m"
function meter(tag, seg) {
  const p = seg ? seg.percent : null;
  return `${tag} ${bar(p)} ${pct(p)}  ↻ ${padEnd(resetIn(seg && seg.resetsAt), 7)}`;
}

function statusOf(u, active) {
  if (u && !u.ok) return u.needsRelogin ? 'CADUCADA' : 'sin datos';
  const s = u && u.ok && u.session ? u.session.percent : null;
  const flag = s != null && s >= 95 ? '▲ tope' : s != null && s >= 80 ? '▲ casi' : '';
  if (active) return flag ? `EN USO  ${flag}` : 'EN USO';
  return flag;
}

// Two lines per account: identity (name · email · status at the right margin), then meters.
function accountLines(acc, u, active) {
  const s = u && u.ok ? u.session : null;
  const w = u && u.ok ? u.weekly : null;
  const dot = active ? '●' : '·';
  const status = statusOf(u, active);
  const idLeft = `  ${dot} ${padEnd(trunc(acc.label, 18), 18)}  ${padEnd(trunc(acc.email || '—', 30), 30)}`;
  const idLine = padEnd(idLeft, WIDTH + 2 - status.length) + status;
  const meters = `      ${meter('5h', s)}    ${meter('7d', w)}`;
  return [idLine, meters];
}

/* ---------- usage ---------- */

async function cmdUsage() {
  const [{ accounts, activeId }, usage] = await Promise.all([
    api('/api/accounts?target=host'),
    api('/api/usage/all'),
  ]);
  if (!accounts.length) { console.log('\n  No hay cuentas todavía. Añádelas en el panel (import o pegar token).\n'); return; }

  const sess = (a) => (usage[a.id] && usage[a.id].ok && usage[a.id].session) ? usage[a.id].session.percent : 999;
  const ord = [...accounts].sort((a, b) => {
    if ((a.id === activeId) !== (b.id === activeId)) return a.id === activeId ? -1 : 1;
    return sess(a) - sess(b);
  });

  const out = ['', header('LLMSwapper · uso disponible', 'entorno: host'), rule(), ''];
  ord.forEach((a, i) => {
    out.push(...accountLines(a, usage[a.id], a.id === activeId));
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
  if (active) parts.push(`activa ${active.label} ${active.s}%/${active.w}%`);
  // Suggest something that will actually resolve: when the label is shared by more than one
  // account, /swapper <label> would refuse as ambiguous, so point at the email instead.
  if (freest) {
    const dupes = accounts.filter((a) => a.label === freest.label).length > 1;
    const acc = accounts.find((a) => a.id === freest.id) || {};
    const handle = dupes && acc.email ? acc.email : (freest.label || '').split(' ')[0];
    parts.push(`salta a ${freest.label}  (/swapper ${handle})`);
  } else parts.push('ninguna otra con margen');
  if (full.length) parts.push(`evita ${full.join(', ')}`);
  out.push('  ' + parts.join('   ·   '), '  ↻ = se reinicia en', '');
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
  out.push(...accountLines({ id: acc.id, label: r.account.label, email: r.account.email }, u, true));
  out.push('', rule());
  const tail = [];
  if (r.verified) tail.push('token verificado');
  tail.push('se aplica a sesiones NUEVAS de Claude Code');
  out.push('  ' + tail.join('   ·   '), '');
  console.log(out.join('\n'));
  for (const wmsg of r.warnings || []) console.log('  · ' + wmsg);
  if ((r.warnings || []).length) console.log('');
}

/* ---------- auto ---------- */

// One line per account in the rotation queue: position, name, meters, and either "→ siguiente"
// or the reason it cannot be rotated into.
// Two lines each, like usage: name + email (two accounts can share a label, and the queue
// is exactly where you need to tell them apart) with the verdict at the right margin, then
// the meters under it.
function queueLines(i, q) {
  const s = q.sessionPercent, w = q.weeklyPercent;
  const tag = q.role === 'next' ? '→ siguiente' : q.eligible ? '' : `✗ ${q.reason}`;
  const idLeft = `  ${padStart(String(i + 1), 2)}. ${padEnd(trunc(q.label, 18), 18)}  ${padEnd(trunc(q.email || '—', 30), 30)}`;
  const idLine = padEnd(idLeft, WIDTH + 2 - tag.length) + tag;
  const meters = `      5h ${bar(s)} ${pct(s)}   7d ${bar(w)} ${pct(w)}`;
  return [idLine, meters];
}

async function cmdAuto(args) {
  const verb = (args[0] || 'status').toLowerCase();
  let st;
  if (['on', 'true', 'activar', 'enciende'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: true } });
  else if (['off', 'false', 'desactivar', 'apaga'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: false } });
  else st = await api('/api/auto');

  const estado = st.enabled ? '● ACTIVADA' : '○ desactivada';
  const out = ['', header('Rotación automática', `host · umbral ${st.threshold}%`), rule(), '',
    `  estado         ${estado}`, ''];

  if (st.current) {
    const c = st.current;
    out.push(`  ● EN USO       ${padEnd(trunc(c.label, 18), 18)}  ${c.email || ''}`);
    out.push(`                 ${meter('5h', { percent: c.sessionPercent, resetsAt: c.sessionResetsAt })}    ${meter('7d', { percent: c.weeklyPercent, resetsAt: c.weeklyResetsAt })}`);
  } else {
    out.push('  ● EN USO       — (ninguna cuenta activa en el host)');
  }
  out.push('', `  cola de rotación (${(st.queue || []).length}):`, '');
  if (!st.queue || !st.queue.length) out.push('    — no hay más cuentas');
  else st.queue.forEach((q, i) => { out.push(...queueLines(i, q)); if (i < st.queue.length - 1) out.push(''); });
  out.push('', rule());
  out.push('  ' + (st.enabled
    ? `al llegar la sesión de la cuenta en uso al ${st.threshold}%, rota sola a "→ siguiente"`
    : 'desactivada · actívala con /swapper-auto on'));
  out.push('  ✗ = excluida de la rotación y por qué   ·   ↻ = se reinicia en', '');
  console.log(out.join('\n'));
}

/* ---------- dispatch ---------- */

const [cmd, ...args] = process.argv.slice(2);
const run = { usage: cmdUsage, swap: () => cmdSwap(args), auto: () => cmdAuto(args), status: () => cmdAuto(['status']) };
(run[cmd] || (() => { console.error('uso: swapper.mjs usage | swap <nombre> | auto on|off|status'); process.exitCode = 1; }))()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; });
