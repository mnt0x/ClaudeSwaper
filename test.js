'use strict';
// One runnable check for the whole project: `node test.js`.
// Runs each module's own self-check, then asserts the cross-module invariants that
// matter — no token ever leaves the process, and the swap never eats a config key.
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('\nClaudeSwaper self-check\n');

for (const mod of ['lib/paths.js', 'lib/store.js', 'lib/usage.js', 'lib/swap.js', 'lib/credentials.js']) {
  check(`${mod} module self-check`, () => {
    execFileSync(process.execPath, [path.join(__dirname, mod)], { stdio: 'pipe', timeout: 30000 });
  });
}

const P = require('./lib/paths');
const usage = require('./lib/usage');
const swapLib = require('./lib/swap');
const oauth = require('./lib/oauth');

// The usage cache is written to disk, so without this the suite would trample the real
// data/usage-cache.json — including, now that it is persisted, the rate-limit cooldown.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-data-'));
P.dataDir = () => SANDBOX;
P.backupsDir = () => path.join(SANDBOX, 'backups');
P.accountsPath = () => path.join(SANDBOX, 'accounts.json');

check('atomic write survives a corrupt-target refusal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-t-'));
  const f = path.join(tmp, 'x.json');
  P.writeJsonAtomic(f, { a: 1 });
  assert.deepStrictEqual(P.readJsonFile(f), { a: 1 });
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => P.readJsonFile(f), /valid JSON/);
  assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('writeJsonAtomic refuses to write a non-object as a whole config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-t-'));
  assert.throws(() => P.writeJsonAtomic(path.join(tmp, 'y.json'), undefined), /empty JSON/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('scrub() removes tokens from anything headed for a log or a response', () => {
  // Assembled at runtime so this fixture cannot trip the "no hardcoded token" scan below.
  const dirty = `error: token sk-ant-${'oat'}01-AbC_dEf_1234567890 rejected`;
  assert.ok(!oauth.scrub(dirty).includes('AbC_dEf'));
  assert.ok(oauth.scrub(dirty).includes('sk-ant-***'));
  assert.strictEqual(oauth.scrub(null), '');
});

check('expires_in seconds becomes an absolute ms epoch', () => {
  const before = Date.now();
  const stored = oauth.toStoredOauth({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'x y' });
  assert.ok(stored.expiresAt > before + 3500 * 1000, 'expiresAt must be ms in the future');
  assert.ok(stored.expiresAt < before + 3700 * 1000, 'expiresAt must not be seconds-as-ms');
  assert.deepStrictEqual(stored.scopes, ['x', 'y']);
});

check('normalize() handles the verified payload, legacy-only, and all-null', () => {
  const live = usage.normalize({
    limits: [
      { kind: 'session', percent: 90, resets_at: 'A' },
      { kind: 'weekly_all', percent: 28, resets_at: 'B' },
    ],
  }, 'i');
  assert.strictEqual(live.session.percent, 90);
  assert.strictEqual(live.weekly.percent, 28);

  const legacy = usage.normalize({ five_hour: { utilization: 12 }, seven_day: { utilization: 99 }, limits: [] }, 'i');
  assert.strictEqual(legacy.session.percent, 12);
  assert.strictEqual(legacy.weekly.severity, 'critical');

  const nothing = usage.normalize({}, 'i');
  assert.strictEqual(nothing.session.percent, 0);
  assert.ok(!Number.isNaN(nothing.weekly.percent));
});

check('swap preserves every unrelated key in a realistic .claude.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-cfg-'));
  const cj = path.join(tmp, '.claude.json');
  const original = {
    numStartups: 7,
    projects: { '/x': { allowedTools: [], history: ['a', 'b'] } },
    mcpServers: { s: { command: 'c', args: ['--x'] } },
    tipsHistory: { t: 3 },
    plugins: { installed: ['p1'] },
    userID: 'INSTALL-ID',
    machineID: 'MACHINE',
    oauthAccount: { emailAddress: 'old@x', accountUuid: 'u-old' },
    modelAccessCache: [1],
    hasAvailableSubscription: true,
  };
  fs.writeFileSync(cj, JSON.stringify(original, null, 2));

  swapLib.writeClaudeJson(cj, { accountUuid: 'u-new', emailAddress: 'new@x', displayName: 'N' });
  const after = JSON.parse(fs.readFileSync(cj, 'utf8'));

  for (const key of ['numStartups', 'projects', 'mcpServers', 'tipsHistory', 'plugins', 'userID', 'machineID']) {
    assert.deepStrictEqual(after[key], original[key], `${key} must survive the swap untouched`);
  }
  assert.strictEqual(after.oauthAccount.emailAddress, 'new@x');
  assert.ok(!('modelAccessCache' in after), 'stale cache must be dropped');
  assert.ok(!('hasAvailableSubscription' in after), 'stale cache must be dropped');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('swap refuses to touch a config it cannot parse', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-bad-'));
  const bad = path.join(tmp, '.claude.json');
  fs.writeFileSync(bad, 'not json at all');
  assert.throws(() => swapLib.writeClaudeJson(bad, { accountUuid: 'x' }));
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), 'not json at all', 'the bad file must be left alone');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('credentials round-trip through the file backend', () => {
  // CLAUDE_CONFIG_DIR redirects paths.credentialsPath(), so this never touches the
  // real credentials. On macOS the Keychain path is preferred but falls back to the
  // file when no Keychain item exists — which is exactly this situation.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-cred-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');

    assert.strictEqual(credentials.read(), null, 'nothing stored yet');

    const blob = {
      mcpOAuth: { 'srv|1': { serverName: 'srv', accessToken: 'keep' } },
      claudeAiOauth: { accessToken: 'A', refreshToken: 'R', expiresAt: 1, scopes: [] },
    };
    credentials.write(blob);

    const back = credentials.read();
    assert.deepStrictEqual(back, blob, 'what goes in must come out');
    assert.ok(back.mcpOAuth, 'mcpOAuth must survive a round-trip');

    // The swap mutation must preserve mcpOAuth when going through the backend.
    swapLib.writeCredentials(null, { accessToken: 'B', refreshToken: 'R2', expiresAt: 2, scopes: ['s'] });
    const after = credentials.read();
    assert.strictEqual(after.claudeAiOauth.accessToken, 'B');
    assert.strictEqual(after.mcpOAuth['srv|1'].accessToken, 'keep', 'mcpOAuth must not be clobbered');

    const backend = credentials.describeBackend();
    assert.ok(backend.kind === 'file' || backend.kind === 'keychain');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    delete require.cache[require.resolve('./lib/credentials')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('the macOS branch degrades to the file backend instead of crashing', () => {
  // Forces the darwin path on whatever this really is. Where `security` does not exist
  // (or holds no item) the Keychain read must fail soft and fall back to the file —
  // this is the closest thing to macOS coverage without a Mac.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-darwin-'));
  const realPlatform = process.platform;
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');

    assert.strictEqual(credentials.isMac(), true, 'must take the mac branch');
    assert.strictEqual(credentials.read(), null, 'no keychain and no file -> null, not a throw');

    const blob = { mcpOAuth: { a: 1 }, claudeAiOauth: { accessToken: 'X' } };
    assert.strictEqual(credentials.write(blob).kind, 'file', 'must fall back to the file');
    assert.deepStrictEqual(credentials.read(), blob);
    assert.ok(['file', 'keychain'].includes(credentials.describeBackend().kind));
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    delete require.cache[require.resolve('./lib/credentials')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el keep-alive solo sincroniza la sesión viva si sigue siendo de esa cuenta', () => {
  // Regresión: el keep-alive escribía por RUTA (saltándose el Keychain en macOS) y decidía
  // por activeId, que durante un swap va por detrás de la realidad varios segundos.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-sync-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    delete require.cache[require.resolve('./lib/credentials')];
    const credentials = require('./lib/credentials');
    credentials.write({
      mcpOAuth: { 'srv|1': { accessToken: 'keep' } },
      claudeAiOauth: { accessToken: 'A-acc', refreshToken: 'A-ref', expiresAt: 1, scopes: [] },
    });

    // Otra cuenta se ha adueñado de la sesión viva (un swap, o un /login a mano).
    const foreign = swapLib.syncLiveCredentials('B-ref', { accessToken: 'B2', refreshToken: 'B2r', expiresAt: 2 });
    assert.strictEqual(foreign, false, 'no debe escribir sobre una sesión que ya no es suya');
    assert.strictEqual(credentials.read().claudeAiOauth.accessToken, 'A-acc');

    // La sesión viva sigue siendo de A: el par rotado sí tiene que entrar, o el refresh
    // token que acaba de morir se queda como el único que conoce Claude Code.
    const own = swapLib.syncLiveCredentials('A-ref', {
      accessToken: 'A2-acc', refreshToken: 'A2-ref', expiresAt: 2, scopes: [],
    });
    assert.strictEqual(own, true);
    const after = credentials.read();
    assert.strictEqual(after.claudeAiOauth.accessToken, 'A2-acc');
    assert.strictEqual(after.claudeAiOauth.refreshToken, 'A2-ref');
    assert.strictEqual(after.mcpOAuth['srv|1'].accessToken, 'keep', 'mcpOAuth debe sobrevivir');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    delete require.cache[require.resolve('./lib/credentials')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el store adopta el par que Claude Code rotó por su cuenta, y solo si sabe de quién es', () => {
  // Claude Code renueva su propia sesión y el refresh rota: el par vivo avanza y la copia
  // del store muere. Sin esto, semanas después el keep-alive fallaba con invalid_grant y
  // la cuenta solo se recuperaba con un login, que es justo lo que la app evita.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-adopt-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const store = require('./lib/store');
  try {
    const profile = { accountUuid: 'uuid-live', emailAddress: 'live@x.com', displayName: 'Live' };
    const account = store.add({
      email: 'live@x.com', profile,
      oauth: { accessToken: 'VIEJO', refreshToken: 'R-VIEJO', expiresAt: 1, subscriptionType: 'max' },
    });
    store.setActive(account.id);
    const writeLive = (refreshToken) => P.writeJsonAtomic(P.credentialsPath(), {
      claudeAiOauth: { accessToken: 'NUEVO', refreshToken, expiresAt: 2, scopes: [] },
    }, 0o600);
    const claudeJson = (accountUuid) => P.writeJsonAtomic(P.claudeJsonPath(), { oauthAccount: { accountUuid } });

    // Sin deriva: el par vivo es el que ya tiene guardado, no hay nada que adoptar.
    writeLive('R-VIEJO');
    claudeJson('uuid-live');
    assert.strictEqual(swapLib.adoptLiveTokens(store), null, 'sin deriva no debe tocar nada');

    // Deriva, pero ~/.claude.json dice que la sesión es de OTRA cuenta: no se sabe de quién
    // es el par, así que no se escribe. Adoptarlo metería tokens ajenos en esta cuenta.
    writeLive('R-NUEVO');
    claudeJson('uuid-de-otro');
    assert.strictEqual(swapLib.adoptLiveTokens(store), null, 'identidad no corroborada: no adoptar');
    assert.strictEqual(store.get(account.id).oauth.refreshToken, 'R-VIEJO');

    // Deriva y las dos fuentes coinciden: solo se movieron los tokens. Se adopta.
    claudeJson('uuid-live');
    assert.strictEqual(swapLib.adoptLiveTokens(store), account.id);
    const after = store.get(account.id).oauth;
    assert.strictEqual(after.refreshToken, 'R-NUEVO');
    assert.strictEqual(after.accessToken, 'NUEVO');
    assert.strictEqual(after.subscriptionType, 'max', 'lo que el store sabía de más debe sobrevivir');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(P.accountsPath(), { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el rollback restaura ~/.claude.json con escritura atómica, no copyFileSync', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-rb-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const backupDir = path.join(tmp, 'backup');
    fs.mkdirSync(backupDir);
    const original = { userID: 'KEEP', projects: { '/x': { history: [1] } }, oauthAccount: { emailAddress: 'old@x' } };
    fs.writeFileSync(path.join(backupDir, 'claude.json'), JSON.stringify(original, null, 2));
    fs.writeFileSync(P.claudeJsonPath(), '{"oauthAccount":{"emailAddress":"new@x"}}');

    const restored = swapLib.restoreFrom(backupDir);
    assert.ok(restored.includes(P.claudeJsonPath()));
    assert.deepStrictEqual(P.readJsonFile(P.claudeJsonPath()), original);
    assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length, 0, 'sin restos .tmp');

    // Y un backup corrupto no puede llevarse por delante la configuración viva: la ruta
    // atómica lo rechaza antes de abrir el destino. copyFileSync lo habría copiado encima,
    // que es la misma ventana por la que un fallo a mitad de copia dejaba un fragmento.
    const live = fs.readFileSync(P.claudeJsonPath(), 'utf8');
    fs.writeFileSync(path.join(backupDir, 'claude.json'), '{ roto');
    assert.throws(() => swapLib.restoreFrom(backupDir), /JSON/);
    assert.strictEqual(fs.readFileSync(P.claudeJsonPath(), 'utf8'), live, 'la config viva debe quedar intacta');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('el suelo de ritmo deja como mucho 4 peticiones en la ventana de 300 s', () => {
  // Lo que importa no es la tasa media sino cuántas caben en la ventana del endpoint:
  // con un hueco g son floor(300/g)+1, y la quinta es la que devuelve 429.
  const perWindow = Math.floor((300 * 1000) / usage.MIN_GAP_MS) + 1;
  assert.ok(perWindow <= 4, `MIN_GAP_MS=${usage.MIN_GAP_MS}ms permite ${perWindow} peticiones por ventana`);
});

check('hardenDataDir deja constancia aunque icacls falle', () => {
  // ponytail: fuera de Windows la función no hace nada, así que no hay nada que probar.
  if (process.platform !== 'win32') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swaper-acl-'));
  const realRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(tmp, 'no-such-windows');
  try {
    P.hardenDataDir(tmp);
    const marker = path.join(tmp, '.acl-applied');
    assert.ok(fs.existsSync(marker), 'sin marcador, ensureDirs() relanza icacls en cada lectura');
    assert.match(fs.readFileSync(marker, 'utf8'), /NOT applied/, 'el fallo debe quedar escrito');
  } finally {
    if (realRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = realRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('detectClaudeProcesses never throws', () => {
  const r = swapLib.detectClaudeProcesses();
  assert.strictEqual(typeof r.running, 'boolean');
  assert.ok(Array.isArray(r.pids));
});

check('[hidden] beats any class rule that sets display', () => {
  // Regression: a .modal-backdrop{display:grid} rule outranked the UA [hidden] rule,
  // leaving the empty state and the banners permanently visible.
  const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'style.css must force [hidden] to none');
});

check('no source file hardcodes a token', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name === 'node_modules' || d.name === 'data' || d.name === '.git') return [];
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : /\.(js|html|css|md)$/.test(d.name) ? [full] : [];
  });
  for (const file of walk(__dirname)) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text.match(/sk-ant-(oat|ort)01-[A-Za-z0-9_-]{10,}/);
    assert.ok(!hit, `${path.relative(__dirname, file)} contains what looks like a real token`);
  }
});

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

(async () => {
  await checkAsync('la cabecera X-Swaper es obligatoria en toda la API, GET incluido', async () => {
    // Un <img src="http://127.0.0.1:7373/api/health"> desde cualquier web pasaba las tres
    // guardas: sin Origin, método GET, y Host correcto. Cada llamada lanza un tasklist.
    const server = require('./server');
    const PORT = 7999;
    const s = server.createServer(PORT);
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(PORT, '127.0.0.1', resolve);
    });
    try {
      const base = `http://127.0.0.1:${PORT}`;
      assert.strictEqual((await fetch(`${base}/api/health`)).status, 403, 'GET a la API sin cabecera');
      assert.strictEqual((await fetch(`${base}/api/accounts`)).status, 403, 'GET a la API sin cabecera');
      assert.strictEqual((await fetch(`${base}/api/health`, { headers: { 'X-Swaper': '1' } })).status, 200);
      assert.strictEqual((await fetch(`${base}/style.css`)).status, 200, 'los estáticos no pueden exigirla');
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });

  await checkAsync('el cooldown de un 429 sobrevive a reiniciar el servidor', async () => {
    const realFetch = global.fetch;
    const account = { id: 'rst1', oauth: { accessToken: 'tok' } };
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async () => ({
        ok: false, status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '300' : null) },
        text: async () => '{"error":{"type":"rate_limit_error"}}',
      });
      await usage.fetchFor(account, { force: true });
      assert.ok(usage.cooldownRemainingMs() > 0, 'el 429 arma el cooldown');

      // Reiniciar el proceso = cargar el módulo desde cero. Antes, eso lo olvidaba todo y
      // el arranque siguiente volvía derecho al endpoint que seguía castigando.
      delete require.cache[require.resolve('./lib/usage')];
      const restarted = require('./lib/usage');
      assert.ok(restarted.cooldownRemainingMs() > 0, 'el cooldown debe sobrevivir al reinicio');

      let called = false;
      global.fetch = async () => { called = true; throw new Error('must not be called'); };
      await restarted.fetchFor(account, { force: true });
      assert.strictEqual(called, false, 'tras reiniciar no debe volver a golpear el endpoint');
      restarted.resetCooldown();
    } finally {
      global.fetch = realFetch;
      delete require.cache[require.resolve('./lib/usage')];
      usage.resetCooldown();
      usage.invalidate();
    }
  });

  await checkAsync('una cuenta con el token muerto no monopoliza el turno', async () => {
    // cache.at solo avanza al triunfar, así que una cuenta con 401 se quedaba en 0 y ganaba
    // el orden "más desactualizada primero" en TODOS los barridos, para siempre.
    const accounts = ['broken', 'good1', 'good2'].map((n) => ({ id: `st-${n}`, oauth: { accessToken: n } }));
    const realFetch = global.fetch;
    const asked = [];
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async (url, opts) => {
        const who = String(opts.headers.Authorization).replace('Bearer ', '');
        asked.push(who);
        if (who === 'broken') {
          return { ok: false, status: 401, headers: { get: () => null }, text: async () => 'unauthorized' };
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ limits: [{ kind: 'session', percent: 5 }] }),
        };
      };
      // Tres barridos. resetCooldown entre ellos solo levanta el suelo de 80 s, que si no
      // haría del test una espera de cuatro minutos; el orden de turnos no se toca.
      for (let i = 0; i < 3; i++) {
        await usage.fetchAll(accounts, { force: true });
        usage.resetCooldown();
      }
      assert.strictEqual(asked.length, 3, `un barrido, una petición (${asked.join(', ')})`);
      assert.strictEqual(asked[0], 'broken', 'la primera vez sí gana la más desactualizada');
      assert.ok(!asked.slice(1).includes('broken'), `la cuenta muerta repitió turno: ${asked.join(', ')}`);
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
      usage.resetCooldown();
    }
  });

  await checkAsync('a 429 serves the last good reading instead of blanking the row', async () => {
    const account = { id: 'rl1', oauth: { accessToken: 'tok' } };
    const realFetch = global.fetch;
    const body = JSON.stringify({ limits: [
      { kind: 'session', percent: 42, resets_at: 'A' },
      { kind: 'weekly_all', percent: 11, resets_at: 'B' }] });

    try {
      global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
      const good = await usage.fetchFor(account, { force: true });
      assert.strictEqual(good.session.percent, 42);
      assert.ok(!good.stale);

      // Clear the rate floor: otherwise the next call is throttled locally and never
      // reaches the API, so no 429 could come back.
      usage.resetCooldown();
      global.fetch = async () => ({
        ok: false, status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '5' : null) },
        text: async () => '{"error":{"type":"rate_limit_error"}}',
      });
      const stale = await usage.fetchFor(account, { force: true });
      assert.strictEqual(stale.ok, true, 'a 429 must not blank the row');
      assert.strictEqual(stale.stale, true, 'the reading must be flagged stale');
      assert.strictEqual(stale.session.percent, 42, 'last good numbers are kept');
      assert.ok(usage.cooldownRemainingMs() > 0, 'retry-after must arm the cooldown');

      let called = false;
      global.fetch = async () => { called = true; throw new Error('must not be called'); };
      await usage.fetchFor(account, { force: true });
      assert.strictEqual(called, false, 'the cooldown must suppress the API call entirely');

      // A genuinely dead token must never hide behind stale numbers.
      usage.resetCooldown();
      global.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'unauthorized' });
      const dead = await usage.fetchFor(account, { force: true });
      assert.strictEqual(dead.ok, false, '401 must surface, not be masked by stale data');
      assert.strictEqual(dead.needsRelogin, true);
    } finally {
      global.fetch = realFetch;
      usage.resetCooldown();
      usage.invalidate();
    }
  });

  await checkAsync('a primed reading spares the API a second call', async () => {
    // The swap fetches usage to verify the new token and donates it via prime(); the UI
    // must then read it from cache. Request amplification is what trips the 429.
    const account = { id: 'pr1', oauth: { accessToken: 'tok' } };
    const realFetch = global.fetch;
    try {
      usage.invalidate();
      usage.resetCooldown();
      usage.prime(account.id, usage.normalize({ limits: [
        { kind: 'session', percent: 7, resets_at: 'A' },
        { kind: 'weekly_all', percent: 8, resets_at: 'B' }] }, account.id));

      let called = false;
      global.fetch = async () => { called = true; throw new Error('must not be called'); };
      const got = await usage.fetchFor(account);
      assert.strictEqual(called, false, 'a primed reading must not hit the network');
      assert.strictEqual(got.session.percent, 7);

      // A failed reading is worthless as a cache entry and must be refused.
      assert.strictEqual(usage.prime('pr2', { ok: false, error: 'x' }).ok, false);
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
    }
  });

  await checkAsync('the rate floor caps outbound calls no matter how hard the UI pushes', async () => {
    // Measured against the live endpoint: the 5th rapid request returns 429 with
    // Retry-After 300, escalating on repeat. So the floor, not the poll interval, is
    // what has to hold — a user mashing refresh must not be able to spend the budget.
    const accounts = [1, 2, 3, 4].map((n) => ({ id: `gap${n}`, oauth: { accessToken: 't' } }));
    const realFetch = global.fetch;
    let calls = 0;
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async () => {
        calls++;
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ limits: [{ kind: 'session', percent: 3 }] }),
        };
      };
      // Four accounts swept three times over, every call forced.
      for (let i = 0; i < 3; i++) await usage.fetchAll(accounts, { force: true });
      assert.strictEqual(calls, 1, `the floor should allow exactly 1 call, saw ${calls}`);

      // The starved accounts must still render something rather than break.
      const out = await usage.fetchAll(accounts, { force: true });
      assert.strictEqual(Object.keys(out).length, 4);
      const throttled = Object.values(out).filter((v) => v.throttled);
      assert.ok(throttled.length >= 1, 'starved accounts report throttled, not a hard error');
      assert.ok(throttled.every((v) => v.needsRelogin === false), 'throttling is not a token problem');
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
      usage.resetCooldown();
    }
  });

  await checkAsync('fetchAll queries accounts one at a time, not as a burst', async () => {
    const accounts = [1, 2, 3].map((n) => ({ id: `seq${n}`, oauth: { accessToken: 't' } }));
    const realFetch = global.fetch;
    let inFlight = 0;
    let maxInFlight = 0;
    try {
      usage.invalidate();
      usage.resetCooldown();
      global.fetch = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ limits: [{ kind: 'session', percent: 1 }] }),
        };
      };
      const out = await usage.fetchAll(accounts, { force: true });
      assert.strictEqual(Object.keys(out).length, 3);
      assert.strictEqual(maxInFlight, 1, `expected serial requests, saw ${maxInFlight} at once`);
    } finally {
      global.fetch = realFetch;
      usage.invalidate();
    }
  });

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
