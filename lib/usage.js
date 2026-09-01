'use strict';
// Reads the same endpoint Claude Code's /usage command uses, and flattens it into
// one shape the UI can render without knowing anything about Anthropic's API.
const { API_HEADERS, scrub } = require('./oauth');
const P = require('./paths');
const path = require('node:path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Measured against the live endpoint: the FIFTH request in quick succession returns 429
// with Retry-After: 300, and the penalty escalates to ~3600s if you keep hitting it.
// So the budget is roughly 5 requests per 5 minutes for the whole app, regardless of how
// many accounts are configured.
//
// Tuning frequency alone cannot hold that: a sweep of N accounts costs N requests, so
// enough accounts blows the budget on a single refresh. Instead there is one hard floor
// on the outbound rate, below, and everything else degrades to cached values around it.
const CACHE_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

// 70s between ANY two outbound calls => at most ~4.3 per 5 minutes, just under the limit.
// This is the single mechanism that bounds our request rate; nothing bypasses it.
const MIN_GAP_MS = 70 * 1000;
let lastRequestAt = 0;
let consecutive429 = 0;

// Last KNOWN-GOOD reading per account. Deliberately never cleared on error: when the
// endpoint rate-limits us it is far better to show slightly old numbers marked as stale
// than to blank the row and lose the only thing the dashboard exists to display.
const cache = new Map(); // id -> { at, value }
// The 429 is account-independent (it is our IP/token hitting the endpoint too often),
// so the cooldown is global. While it holds, we do not call the API at all.
let cooldownUntil = 0;

// Percentages only — no tokens — so this is safe to keep on disk. Persisting it means a
// restart during a rate-limit window still shows numbers instead of empty rows.
const cachePath = () => path.join(P.dataDir(), 'usage-cache.json');

function loadCache() {
  const raw = P.readJsonIfExists(cachePath(), null);
  if (!raw || typeof raw !== 'object') return;
  for (const [id, entry] of Object.entries(raw)) {
    if (entry && entry.at && entry.value) cache.set(id, entry);
  }
}

function persistCache() {
  try {
    P.writeJsonAtomic(cachePath(), Object.fromEntries(cache), 0o600);
  } catch { /* a cache that cannot be written is not worth failing a request over */ }
}

try { loadCache(); } catch { /* corrupt cache file: start cold rather than crash */ }

async function fetchRaw(accessToken) {
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, ...API_HEADERS },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const e = new Error(`No se pudo contactar con la API de uso: ${scrub(err.message)}`);
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(res.status === 429
      ? 'La API de uso está limitando las peticiones (429)'
      : `La API de uso devolvió ${res.status}: ${scrub(text).slice(0, 200)}`);
    e.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    e.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('La API de uso devolvió una respuesta que no es JSON');
    e.status = res.status;
    throw e;
  }
}

// Computed here rather than trusting the server string, so the API and the CSS agree.
function severityFor(percent) {
  if (percent == null) return 'unknown';
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'normal';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : null;
}

function meter(percent, resetsAt) {
  const p = num(percent);
  return { percent: p == null ? 0 : p, resetsAt: resetsAt || null, severity: severityFor(p) };
}

function fromLegacy(block) {
  if (!block || typeof block !== 'object') return null;
  return meter(block.utilization, block.resets_at);
}

/**
 * limits[] is the source of truth; the top-level five_hour/seven_day keys are legacy
 * mirrors kept as a fallback so an account on an older API shape still renders.
 */
function normalize(raw, id) {
  const limits = Array.isArray(raw && raw.limits) ? raw.limits : [];
  const byKind = (kind) => limits.find((l) => l && l.kind === kind) || null;

  const sessionLimit = byKind('session');
  const weeklyLimit = byKind('weekly_all');

  const session = sessionLimit
    ? meter(sessionLimit.percent, sessionLimit.resets_at)
    : fromLegacy(raw && raw.five_hour) || meter(null, null);

  const weekly = weeklyLimit
    ? meter(weeklyLimit.percent, weeklyLimit.resets_at)
    : fromLegacy(raw && raw.seven_day) || meter(null, null);

  const scoped = limits
    .filter((l) => l && l.kind === 'weekly_scoped')
    .map((l) => {
      const s = l.scope || {};
      const label = (s.model && s.model.display_name) || s.surface || 'Otro';
      return { label, percent: num(l.percent) ?? 0, resetsAt: l.resets_at || null, severity: severityFor(num(l.percent)) };
    });

  const opus = fromLegacy(raw && raw.seven_day_opus);

  const eu = (raw && raw.extra_usage) || null;
  const extraUsage = eu ? { enabled: !!eu.is_enabled, percent: num(eu.utilization) ?? 0 } : null;

  const locked =
    (sessionLimit && sessionLimit.locked_reason) ||
    (raw && raw.five_hour && raw.five_hour.locked_reason) ||
    null;

  return { id, ok: true, fetchedAt: Date.now(), session, weekly, scoped, opus, extraUsage, locked };
}

/** Last good reading, re-labelled as stale so the UI can show it honestly. */
function staleOf(hit, reason) {
  return { ...hit.value, stale: true, staleSince: hit.at, staleReason: reason };
}

/** Never throws — a dead account renders as an error row, it does not break the page. */
async function fetchFor(account, { force = false } = {}) {
  const id = account.id;
  const hit = cache.get(id);

  if (hit && !force && Date.now() - hit.at < CACHE_MS) return hit.value;

  const token = account.oauth && account.oauth.accessToken;
  if (!token) {
    return { id, ok: false, error: 'Esta cuenta no tiene token guardado', status: 0, needsRelogin: true };
  }

  // Hard rate floor. Even a user hammering refresh cannot exceed it: callers get the
  // cached value, or a "waiting its turn" marker, instead of another outbound request.
  const sinceLast = Date.now() - lastRequestAt;
  if (lastRequestAt && sinceLast < MIN_GAP_MS && Date.now() >= cooldownUntil) {
    const waitS = Math.ceil((MIN_GAP_MS - sinceLast) / 1000);
    if (hit) return staleOf(hit, `en cola, turno en ${waitS}s`);
    return {
      id, ok: false, status: 0, needsRelogin: false, throttled: true, retryInS: waitS,
      error: `En cola para consultar el uso (${waitS}s). El swap sigue funcionando.`,
    };
  }

  // Under an active cooldown, do not touch the API — that is what caused the 429.
  if (Date.now() < cooldownUntil) {
    const waitS = Math.ceil((cooldownUntil - Date.now()) / 1000);
    const pretty = waitS >= 90 ? `${Math.ceil(waitS / 60)} min` : `${waitS}s`;
    if (hit) return staleOf(hit, `rate limit, reintento en ${pretty}`);
    return {
      id, ok: false, status: 429, needsRelogin: false, retryInS: waitS, rateLimited: true,
      error: `Uso no disponible: la API limita las consultas. Reintento en ${pretty}. El swap sigue funcionando.`,
    };
  }

  lastRequestAt = Date.now();
  try {
    const value = normalize(await fetchRaw(token), id);
    consecutive429 = 0;
    cache.set(id, { at: Date.now(), value });
    persistCache();
    return value;
  } catch (err) {
    const status = err.status || 0;
    if (status === 429) {
      // The penalty escalates with repeat offences, so our backoff does too — otherwise
      // we walk straight back into the limit the moment the first window expires.
      consecutive429 += 1;
      const escalated = DEFAULT_COOLDOWN_MS * Math.pow(2, consecutive429 - 1);
      cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(err.retryAfterMs || 0, escalated));
    }
    // Stale numbers beat no numbers, except when the token itself is dead.
    if (hit && status !== 401 && status !== 403) return staleOf(hit, scrub(err.message));
    return { id, ok: false, error: scrub(err.message), status, needsRelogin: status === 401 || status === 403 };
  }
}

/**
 * Sequential on purpose: N accounts firing at once is a burst this endpoint punishes.
 * Stalest first, because the rate floor means only one or two calls actually get through
 * per sweep — the slot must go to whichever account needs it most, or a fixed list order
 * would refresh the first account forever and starve the rest.
 */
async function fetchAll(accounts, opts) {
  const list = [...(accounts || [])].sort((a, b) => {
    const ta = (cache.get(a.id) || {}).at || 0;
    const tb = (cache.get(b.id) || {}).at || 0;
    return ta - tb;
  });
  const settled = [];
  for (const a of list) {
    settled.push(await fetchFor(a, opts).then((v) => ({ status: 'fulfilled', value: v }),
      (e) => ({ status: 'rejected', reason: e })));
  }
  const out = {};
  settled.forEach((r, i) => {
    const id = list[i].id;
    out[id] = r.status === 'fulfilled'
      ? r.value
      : { id, ok: false, error: scrub(r.reason && r.reason.message) || 'Fallo desconocido', status: 0, needsRelogin: false };
  });
  return out;
}

const invalidate = (id) => (id ? cache.delete(id) : cache.clear());

/**
 * Donate a reading someone else already paid an API call for (the swap fetches usage
 * to verify the new token). Without this the UI would immediately spend a second call
 * for data it was just handed — request amplification is what triggers the 429.
 */
function prime(id, value) {
  if (!value || !value.ok) return value;
  cache.set(id, { at: Date.now(), value });
  persistCache();
  return value;
}
const cooldownRemainingMs = () => Math.max(0, cooldownUntil - Date.now());
const resetCooldown = () => { cooldownUntil = 0; consecutive429 = 0; lastRequestAt = 0; };

module.exports = {
  USAGE_URL, CACHE_MS, fetchRaw, normalize, fetchFor, fetchAll,
  invalidate, prime, severityFor, cooldownRemainingMs, resetCooldown, MIN_GAP_MS,
};

if (require.main === module) {
  const assert = require('node:assert');

  const verified = {
    five_hour: { utilization: 90.0, resets_at: '2026-08-31T15:00:00Z', locked_reason: null },
    seven_day: { utilization: 28.0, resets_at: '2026-09-06T16:00:00Z' },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: 'session', group: 'session', percent: 90, severity: 'critical', resets_at: '2026-08-31T15:00:00Z', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 28, severity: 'normal', resets_at: '2026-09-06T16:00:00Z', scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 18, severity: 'normal', resets_at: '2026-09-06T16:00:00Z', scope: { model: { id: null, display_name: 'Fable' } } },
    ],
  };
  const a = normalize(verified, 'x');
  assert.strictEqual(a.session.percent, 90);
  assert.strictEqual(a.session.severity, 'high');
  assert.strictEqual(a.weekly.percent, 28);
  assert.strictEqual(a.weekly.severity, 'normal');
  assert.strictEqual(a.scoped.length, 1);
  assert.strictEqual(a.scoped[0].label, 'Fable');

  // Legacy shape: no limits[], data only in the top-level mirrors.
  const b = normalize({ five_hour: { utilization: 55, resets_at: 'T' }, seven_day: { utilization: 96, resets_at: 'T2' }, limits: [] }, 'y');
  assert.strictEqual(b.session.percent, 55);
  assert.strictEqual(b.session.severity, 'medium');
  assert.strictEqual(b.weekly.severity, 'critical');

  // Nothing at all must still render as zeros, never NaN.
  const c = normalize({ five_hour: null, seven_day: null, limits: null, extra_usage: null }, 'z');
  assert.strictEqual(c.session.percent, 0);
  assert.strictEqual(c.weekly.percent, 0);
  assert.deepStrictEqual(c.scoped, []);
  assert.strictEqual(c.extraUsage, null);

  // Threshold boundaries land on the documented side.
  assert.strictEqual(severityFor(49.9), 'normal');
  assert.strictEqual(severityFor(50), 'medium');
  assert.strictEqual(severityFor(79.9), 'medium');
  assert.strictEqual(severityFor(80), 'high');
  assert.strictEqual(severityFor(94.9), 'high');
  assert.strictEqual(severityFor(95), 'critical');

  console.log('usage.js self-check OK');
}
