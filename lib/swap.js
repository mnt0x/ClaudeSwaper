'use strict';
// The dangerous file. It rewrites the user's real ~/.claude.json (a large file full of
// irreplaceable state) and ~/.claude/.credentials.json (paid account tokens).
// Rules: back up before the first write, mutate in place rather than rebuild, verify
// against the live API afterwards, and roll back on any failure past that first write.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('./paths');
const credentials = require('./credentials');

const MAX_BACKUPS = 20;

// Per-account caches Claude Code keeps in .claude.json. Left behind they describe the
// PREVIOUS account, so we drop them and let Claude Code refetch for the new identity.
const STALE_CACHE_KEYS = [
  'overageCreditGrantCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'passesEligibilityCache',
  'cachedExtraUsageDisabledReason',
  'hasAvailableSubscription',
  'clientDataCacheSlots',
  'additionalModelOptionsCache',
  'additionalModelCostsCache',
  'passesLastSeenRemaining',
];

// ponytail: userID is an install/telemetry id, not an account identity — it does not
// derive from accountUuid (verified). Leaving it alone removes a whole class of risk.

function detectClaudeProcesses() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const pids = out.split(/\r?\n/)
        .map((l) => (l.match(/^"claude\.exe","(\d+)"/i) || [])[1])
        .filter(Boolean)
        .map(Number);
      return { running: pids.length > 0, pids };
    }
    // -l gives "<pid> <command>" so we can drop false positives: this very server, and
    // anything running out of the ClaudeSwaper directory, whose path contains "claude".
    const out = execFileSync('pgrep', ['-fl', 'claude'], { encoding: 'utf8', timeout: 5000 });
    const pids = out.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/claudeswaper|server\.js/i.test(line))
      .map((line) => Number(line.split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n !== process.pid && n !== process.ppid);
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function pruneBackups() {
  try {
    const dirs = fs.readdirSync(P.backupsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - MAX_BACKUPS))) {
      fs.rmSync(path.join(P.backupsDir(), name), { recursive: true, force: true });
    }
  } catch { /* pruning is best effort; never block a swap on it */ }
}

/**
 * Snapshots both credentials and .claude.json. Credentials go through the abstraction
 * and are written out AS a file, so a macOS Keychain backup restores just as easily.
 * Throws on failure — a swap without a backup must not proceed.
 */
function backupNow(tag) {
  P.ensureDirs();
  const dir = path.join(P.backupsDir(), `${stamp()}${tag ? '-' + tag : ''}`);
  fs.mkdirSync(dir, { recursive: true });

  const saved = [];
  const creds = credentials.read();
  if (creds) {
    P.writeJsonAtomic(path.join(dir, 'credentials.json'), creds, 0o600);
    saved.push('credentials.json');
  }
  if (fs.existsSync(P.claudeJsonPath())) {
    fs.copyFileSync(P.claudeJsonPath(), path.join(dir, 'claude.json'));
    saved.push('claude.json');
  }
  if (saved.length === 0) throw new Error('No se encontró ninguna config de Claude que respaldar — swap abortado');
  pruneBackups();
  return { dir, saved };
}

function restoreFrom(dir) {
  const restored = [];
  const credBackup = path.join(dir, 'credentials.json');
  if (fs.existsSync(credBackup)) {
    // Back to whichever store is live now — Keychain on macOS, file elsewhere.
    credentials.write(P.readJsonFile(credBackup));
    restored.push('credentials');
  }
  const jsonBackup = path.join(dir, 'claude.json');
  if (fs.existsSync(jsonBackup)) {
    // Atomic, like every other write to a live config. copyFileSync truncates the target
    // first, so a failure partway through would leave the real ~/.claude.json — 130 KB of
    // projects, history and mcpServers — as an unparseable fragment. This is the last line
    // of defence; it is the one place that must not be able to fail halfway.
    P.writeJsonAtomic(P.claudeJsonPath(), P.readJsonFile(jsonBackup));
    restored.push(P.claudeJsonPath());
  }
  return restored;
}

/**
 * Push a freshly rotated pair into the LIVE session, but only if that session is still
 * this account's. Refreshing kills the previous refresh token, so leaving the live file
 * holding it would log the user out of their CLI — but writing it blindly is worse: a
 * swap, or a manual `claude /login`, can hand the live session to a different account
 * while the refresh is in flight, and the sync would then silently drag it back.
 *
 * The token comparison is what proves ownership. `activeId` cannot: a swap writes the new
 * credentials and only calls setActive() at the very end, after a network round trip, so
 * for seconds at a time the live session and activeId disagree by design.
 * Returns true when it actually wrote.
 */
function syncLiveCredentials(previousRefreshToken, fresh) {
  if (!previousRefreshToken) return false;
  let live;
  try {
    live = credentials.read();
  } catch {
    return false; // cannot read the live session -> certainly do not overwrite it
  }
  if (!live || !live.claudeAiOauth) return false;
  if (live.claudeAiOauth.refreshToken !== previousRefreshToken) return false;
  writeCredentials(null, fresh);
  return true;
}

// --- the two surgical mutations, split out so the self-check can drive them ---

/**
 * Replaces ONLY claudeAiOauth. mcpOAuth and anything else survives untouched.
 * Pass a path to operate on a specific file (the self-check does); omit it to use
 * whatever backend this platform really uses.
 */
function writeCredentials(credPathOrNull, oauth) {
  const useBackend = !credPathOrNull;
  const current = (useBackend ? credentials.read() : P.readJsonIfExists(credPathOrNull, {})) || {};
  current.claudeAiOauth = {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt ?? null,
    scopes: oauth.scopes || [],
    subscriptionType: oauth.subscriptionType || 'max',
    rateLimitTier: oauth.rateLimitTier || null,
  };
  if (useBackend) credentials.write(current);
  else P.writeJsonAtomic(credPathOrNull, current, 0o600);
  return current;
}

/** Sets oauthAccount and drops stale per-account caches. Every other key is untouched. */
function writeClaudeJson(claudeJsonPath, profile) {
  const current = P.readJsonIfExists(claudeJsonPath, null);
  if (!current || typeof current !== 'object') {
    throw new Error(`${claudeJsonPath} no existe o no es un objeto JSON — swap abortado`);
  }
  const before = Object.keys(current).length;
  current.oauthAccount = { ...profile, profileFetchedAt: Date.now() };
  const dropped = STALE_CACHE_KEYS.filter((k) => k in current);
  for (const k of dropped) delete current[k];

  // Guard against a mutation bug silently gutting a 132KB config.
  const after = Object.keys(current).length;
  if (after < before - dropped.length) {
    throw new Error(`Comprobación de integridad fallida: ${before} claves antes, ${after} después — swap abortado`);
  }
  P.writeJsonAtomic(claudeJsonPath, current);
  return { dropped, keysBefore: before, keysAfter: after };
}

/**
 * What a Claude config currently holds, straight off disk. Pass a configDir to read an
 * isolated login (CLAUDE_CONFIG_DIR=... claude /login) instead of the live one, so a
 * second account can be captured without disturbing the session you are using.
 */
function readCurrentIdentity(configDir) {
  const jsonFile = configDir ? path.join(configDir, '.claude.json') : P.claudeJsonPath();
  const cred = configDir
    ? P.readJsonIfExists(path.join(configDir, '.credentials.json'), null)
    : credentials.read();
  const oauth = cred && cred.claudeAiOauth;
  if (!oauth || !oauth.accessToken) return null;
  const cj = P.readJsonIfExists(jsonFile, null) || {};
  return { oauth, profile: cj.oauthAccount || null, userID: cj.userID || null };
}

/**
 * The other direction of the same problem, and the one that actually bites.
 *
 * Claude Code renews its own session. Refreshing ROTATES the refresh token: the new pair
 * lands in the live credentials and the previous token dies on Anthropic's side. The copy
 * in accounts.json is now a dead token, and nothing says so until the keep-alive tries it
 * weeks later and the account can only be recovered with a login — the one thing this app
 * exists to avoid. Nothing to do with rebooting; it is what normal use looks like.
 *
 * Adopting the live pair is only safe if we know whose it is, and the tokens themselves
 * carry no identity. `oauthAccount` in ~/.claude.json names who Claude Code believes it is
 * signed in as, but it can go stale relative to the tokens, so it is trusted only when it
 * AGREES with our own activeId. Both sources naming the same account means the identity
 * never changed and only the pair moved on — exactly the case here. Any disagreement is
 * left alone: the user imports, and no account gets another one's tokens written into it.
 *
 * Returns the id it healed, or null.
 */
function adoptLiveTokens(store) {
  const activeId = store.load().activeId;
  if (!activeId) return null;
  const account = store.get(activeId);
  if (!account || !account.oauth) return null;

  let live;
  try { live = credentials.read(); } catch { return null; }
  const liveOauth = live && live.claudeAiOauth;
  if (!liveOauth || !liveOauth.refreshToken) return null;
  if (liveOauth.refreshToken === account.oauth.refreshToken) return null; // nothing drifted

  const cj = P.readJsonIfExists(P.claudeJsonPath(), null) || {};
  const uuid = cj.oauthAccount && cj.oauthAccount.accountUuid;
  if (!uuid || store.idFor({ accountUuid: uuid }) !== activeId) return null;

  // Merge rather than replace: the live file carries the pair, the store may know more
  // about the account (subscriptionType, rateLimitTier) than a bare credentials blob does.
  store.update(activeId, { oauth: { ...account.oauth, ...liveOauth } });
  return activeId;
}

async function ensureFreshToken(account, deps) {
  const { store, oauth: oauthLib } = deps;
  const o = account.oauth || {};
  const needsRefresh = o.expiresAt && o.expiresAt - Date.now() < 5 * 60 * 1000;
  if (!needsRefresh) return account;
  if (!o.refreshToken) throw new Error('El token ha caducado y no hay refresh token — vuelve a añadir esta cuenta');

  const fresh = oauthLib.toStoredOauth(await oauthLib.refresh(o.refreshToken), o);
  // Persist BEFORE using it: a crash must not leave the live file newer than the store.
  return store.update(account.id, { oauth: fresh }) || { ...account, oauth: fresh };
}

/** Steps 1-3 only. Reports what would change, writes nothing. */
async function dryRun(id, deps) {
  const account = deps.store.get(id);
  if (!account) throw new Error(`Cuenta desconocida: ${id}`);
  const procs = detectClaudeProcesses();
  const cj = P.readJsonIfExists(P.claudeJsonPath(), null) || {};
  const o = account.oauth || {};
  return {
    ok: true,
    account: deps.store.publicAccount(id),
    claudeRunning: procs.running,
    pids: procs.pids,
    tokenRefreshNeeded: !!(o.expiresAt && o.expiresAt - Date.now() < 5 * 60 * 1000),
    willWrite: [credentials.describeBackend().location, P.claudeJsonPath()],
    willDropCacheKeys: STALE_CACHE_KEYS.filter((k) => k in cj),
    currentEmail: (cj.oauthAccount && cj.oauthAccount.emailAddress) || null,
    targetEmail: account.email,
  };
}

/** The whole point of the product. Follows the 7 steps in ARCHITECTURE.md in order. */
async function swapTo(id, deps) {
  const { store, oauth: oauthLib, usage } = deps;
  let account = store.get(id);
  if (!account) throw new Error(`Cuenta desconocida: ${id}`);
  if (!account.oauth || !account.oauth.accessToken) {
    throw new Error('Esta cuenta no tiene token guardado — vuelve a añadirla');
  }

  const warnings = [];

  // 1. running sessions keep their in-memory token; the swap lands on new ones.
  const procs = detectClaudeProcesses();
  if (procs.running) {
    warnings.push(`Claude Code está abierto (${procs.pids.length} proceso(s)). El cambio se aplicará a sesiones NUEVAS.`);
  }

  // 2. backup first, always.
  const backup = backupNow(id);

  // 3. refresh if the token is about to die.
  try {
    account = await ensureFreshToken(account, deps);
  } catch (err) {
    throw new Error(`No se pudo refrescar el token: ${err.message}`);
  }

  // 4-7. from here on, any failure rolls back both files.
  let mutation;
  try {
    writeCredentials(null, account.oauth);

    if (account.profile) {
      mutation = writeClaudeJson(P.claudeJsonPath(), account.profile);
    } else {
      warnings.push('Sin metadatos de perfil guardados; solo se cambiaron las credenciales.');
      mutation = { dropped: [] };
    }

    // 6. prove the new token actually works. Must be fetchRaw, NOT fetchFor — the latter
    // can serve a cached reading, which would "verify" a token it never actually used.
    usage.invalidate(id);
    let check = null;
    try {
      // Seed the cache with it: the UI would otherwise spend another API call on data
      // this swap just fetched, and that amplification is what trips the rate limit.
      check = usage.prime(id, usage.normalize(await usage.fetchRaw(account.oauth.accessToken), id));
    } catch (err) {
      // 401/403 means the token is genuinely dead: roll back. A 429 or a network blip
      // says nothing about the token, so keep the swap and be explicit that we could
      // not confirm it rather than reverting a change that is probably fine.
      if (err.status === 401 || err.status === 403) {
        throw new Error(`El token de esta cuenta ya no es válido (${err.status})`);
      }
      warnings.push(`No se pudo confirmar el cambio contra la API (${err.message}). Las credenciales se han escrito igualmente.`);
    }

    // 7. only now is it official.
    store.setActive(id);

    return {
      ok: true,
      verified: check !== null,
      warnings,
      backup: backup.dir,
      droppedCacheKeys: mutation.dropped,
      usage: check,
      account: store.publicAccount(id),
    };
  } catch (err) {
    let rollback = 'restaurado';
    try {
      restoreFrom(backup.dir);
    } catch (restoreErr) {
      rollback = `LA RESTAURACIÓN FALLÓ (${restoreErr.message}) — restaura a mano desde ${backup.dir}`;
    }
    const e = new Error(`${err.message} — config ${rollback}`);
    e.backup = backup.dir;
    throw e;
  }
}

module.exports = {
  STALE_CACHE_KEYS, MAX_BACKUPS,
  detectClaudeProcesses, backupNow, restoreFrom, restoreFromBackup: restoreFrom,
  writeCredentials, syncLiveCredentials, adoptLiveTokens, writeClaudeJson,
  readCurrentIdentity, ensureFreshToken, dryRun, swapTo,
};

if (require.main === module) {
  const assert = require('node:assert');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-swap-'));
  const credPath = path.join(tmp, '.credentials.json');
  const cjPath = path.join(tmp, '.claude.json');

  fs.writeFileSync(credPath, JSON.stringify({
    mcpOAuth: { 'srv|abc': { serverName: 'srv', accessToken: 'keepme' } },
    claudeAiOauth: { accessToken: 'sk-ant-OLD', refreshToken: 'sk-ant-OLDR', expiresAt: 1, scopes: ['a'] },
  }, null, 2));

  fs.writeFileSync(cjPath, JSON.stringify({
    numStartups: 42,
    projects: { '/a/b': { history: [1, 2, 3] } },
    mcpServers: { x: { command: 'y' } },
    tipsHistory: { tip: 1 },
    userID: 'INSTALL-ID-MUST-SURVIVE',
    oauthAccount: { emailAddress: 'old@x.com', accountUuid: 'old-uuid' },
    modelAccessCache: [],
    hasAvailableSubscription: false,
    overageCreditGrantCache: { a: 1 },
    somethingUnrelated: { deep: { nested: true } },
  }, null, 2));

  const newProfile = { accountUuid: 'new-uuid', emailAddress: 'new@x.com', displayName: 'New' };
  writeCredentials(credPath, { accessToken: 'sk-ant-NEW', refreshToken: 'sk-ant-NEWR', expiresAt: 999, scopes: ['b'], subscriptionType: 'max' });
  const res = writeClaudeJson(cjPath, newProfile);

  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  assert.strictEqual(cred.claudeAiOauth.accessToken, 'sk-ant-NEW');
  assert.strictEqual(cred.mcpOAuth['srv|abc'].accessToken, 'keepme', 'mcpOAuth must survive');

  const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'));
  assert.strictEqual(cj.oauthAccount.emailAddress, 'new@x.com');
  assert.strictEqual(cj.userID, 'INSTALL-ID-MUST-SURVIVE', 'userID must not be touched');
  assert.strictEqual(cj.numStartups, 42);
  assert.deepStrictEqual(cj.projects, { '/a/b': { history: [1, 2, 3] } }, 'projects must survive');
  assert.deepStrictEqual(cj.mcpServers, { x: { command: 'y' } }, 'mcpServers must survive');
  assert.deepStrictEqual(cj.tipsHistory, { tip: 1 });
  assert.deepStrictEqual(cj.somethingUnrelated, { deep: { nested: true } });
  for (const k of ['modelAccessCache', 'hasAvailableSubscription', 'overageCreditGrantCache']) {
    assert.ok(!(k in cj), `stale cache key ${k} should have been dropped`);
  }
  assert.strictEqual(res.dropped.length, 3);

  assert.strictEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp')).length, 0, 'no tmp files left behind');

  // A corrupt target must abort rather than be overwritten.
  const badPath = path.join(tmp, 'bad.json');
  fs.writeFileSync(badPath, '{ not json');
  assert.throws(() => writeClaudeJson(badPath, newProfile), /no es valid|not valid|JSON/i);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('swap.js self-check OK');
}
