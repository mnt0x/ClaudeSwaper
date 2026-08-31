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

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
