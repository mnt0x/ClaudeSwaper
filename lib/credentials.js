'use strict';
/**
 * The one place that knows WHERE Claude Code keeps its credentials.
 *
 * Windows / Linux: a plain file at ~/.claude/.credentials.json
 * macOS:           the login Keychain, via the `security` binary
 *
 * Everything else in this project talks to credentials through read()/write() and
 * never touches either backend directly.
 */
const { execFileSync } = require('node:child_process');
const P = require('./paths');

// Claude Code's Keychain item. Overridable because it is the one value that could not
// be confirmed from the Windows build — if a Mac disagrees, set SWAPER_KEYCHAIN_SERVICE
// rather than editing code. `security dump-keychain | grep -i claude` reveals the truth.
const SERVICE = process.env.SWAPER_KEYCHAIN_SERVICE || 'Claude Code-credentials';
const ACCOUNT = process.env.USER || process.env.LOGNAME || process.env.USERNAME || '';

const isMac = () => process.platform === 'darwin';

function keychainRead() {
  try {
    const args = ['find-generic-password', '-s', SERVICE];
    if (ACCOUNT) args.push('-a', ACCOUNT);
    args.push('-w');
    const out = execFileSync('security', args, { encoding: 'utf8', timeout: 15000 });
    const text = (out || '').trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    // Item absent (exit 44), user denied the Keychain prompt, or the payload is not
    // JSON. All three mean "no usable credentials here" — the caller falls back.
    return null;
  }
}

function keychainWrite(obj) {
  const args = ['add-generic-password', '-U', '-s', SERVICE];
  if (ACCOUNT) args.push('-a', ACCOUNT);
  // -w takes the secret on argv, which is briefly visible to `ps` on a multi-user box.
  // `security` offers no stdin path for this, and it is what other tools do too.
  args.push('-w', JSON.stringify(obj));
  execFileSync('security', args, { stdio: 'ignore', timeout: 15000 });
}

/** Where credentials actually live on this machine, for diagnostics and messages. */
function describeBackend() {
  if (!isMac()) return { kind: 'file', location: P.credentialsPath() };
  return keychainRead() !== null
    ? { kind: 'keychain', location: `Keychain: ${SERVICE}` }
    : { kind: 'file', location: P.credentialsPath() };
}

/**
 * The full credentials object (including mcpOAuth and anything else), or null.
 * On macOS the Keychain wins, but a plain file is still honoured as a fallback —
 * some setups keep one, and refusing to read it would strand those users.
 */
function read() {
  if (isMac()) {
    const fromKeychain = keychainRead();
    if (fromKeychain) return fromKeychain;
  }
  return P.readJsonIfExists(P.credentialsPath(), null);
}

/**
 * Persist the full credentials object back to wherever it came from. Writing to the
 * Keychain when Claude Code reads a file (or the reverse) would silently do nothing,
 * so the destination is chosen by where credentials were actually found.
 */
function write(obj) {
  if (isMac() && keychainRead() !== null) {
    keychainWrite(obj);
    return { kind: 'keychain', location: `Keychain: ${SERVICE}` };
  }
  P.writeJsonAtomic(P.credentialsPath(), obj, 0o600);
  return { kind: 'file', location: P.credentialsPath() };
}

module.exports = { SERVICE, read, write, describeBackend, isMac };

if (require.main === module) {
  const backend = describeBackend();
  const creds = read();
  console.log(`backend : ${backend.kind} (${backend.location})`);
  console.log(`legible : ${creds ? 'si' : 'no'}`);
  if (creds) console.log(`claves  : ${Object.keys(creds).join(', ')}`);
}
