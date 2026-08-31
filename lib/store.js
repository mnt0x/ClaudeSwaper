'use strict';
// accounts.json persistence. Holds live OAuth tokens — mode 0600, and publicView()
// is the ONLY thing the HTTP layer is allowed to serialise to the browser.
const crypto = require('node:crypto');
const P = require('./paths');

const PALETTE = [
  '#7c5cff', '#22c9a8', '#ff8f3f', '#4f9dff',
  '#ff5c8a', '#c9a227', '#41c7f0', '#9d7bff',
];

const EMPTY = { version: 1, activeId: null, accounts: [] };

function load() {
  P.ensureDirs();
  const raw = P.readJsonIfExists(P.accountsPath(), null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) {
    return { ...EMPTY, accounts: [] };
  }
  return { version: raw.version || 1, activeId: raw.activeId ?? null, accounts: raw.accounts };
}

function save(store) {
  P.ensureDirs();
  P.writeJsonAtomic(P.accountsPath(), store, 0o600);
  return store;
}

const list = () => load().accounts;
const get = (id) => load().accounts.find((a) => a.id === id) || null;

// Deterministic from accountUuid so re-importing the same account UPDATES it in place
// instead of silently creating a duplicate.
function idFor(profile, email) {
  const seed = (profile && profile.accountUuid) || email || '';
  if (!seed) throw new Error('Cannot derive an account id: no accountUuid and no email');
  return 'acc_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

function nextColor(accounts) {
  const used = new Set(accounts.map((a) => a.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[accounts.length % PALETTE.length];
}

function add({ label, color, email, oauth, profile, userID }) {
  const store = load();
  const id = idFor(profile, email);
  const existing = store.accounts.find((a) => a.id === id);
  const now = Date.now();

  if (existing) {
    // Re-import: refresh the credentials and metadata, keep the user's label/colour.
    existing.email = email || existing.email;
    existing.oauth = oauth || existing.oauth;
    existing.profile = profile || existing.profile;
    if (userID) existing.userID = userID;
    existing.updatedAt = now;
    save(store);
    return existing;
  }

  const account = {
    id,
    label: label || (profile && (profile.displayName || profile.fullName)) || email || 'Cuenta',
    color: color || nextColor(store.accounts),
    email: email || (profile && profile.emailAddress) || null,
    oauth,
    profile: profile || null,
    userID: userID || null,
    addedAt: now,
    updatedAt: now,
    lastSwappedAt: null,
  };
  store.accounts.push(account);
  save(store);
  return account;
}

const PATCHABLE = ['label', 'color', 'oauth', 'profile', 'userID', 'lastSwappedAt', 'email'];

function update(id, patch) {
  const store = load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  for (const key of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) account[key] = patch[key];
  }
  account.updatedAt = Date.now();
  save(store);
  return account;
}

function remove(id) {
  const store = load();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.accounts.length === before) return false;
  if (store.activeId === id) store.activeId = null;
  save(store);
  return true;
}

function setActive(id) {
  const store = load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  store.activeId = id;
  account.lastSwappedAt = Date.now();
  save(store);
  return account;
}

function planLabel(account) {
  const p = account.profile || {};
  const tier = p.organizationRateLimitTier || (account.oauth && account.oauth.rateLimitTier) || '';
  if (/max_20x/.test(tier)) return 'Max 20x';
  if (/max_5x/.test(tier)) return 'Max 5x';
  if (p.organizationType === 'claude_max') return 'Max';
  if (/pro/i.test(tier) || p.organizationType === 'claude_pro') return 'Pro';
  return (account.oauth && account.oauth.subscriptionType) || 'Claude';
}

/** The ONLY shape that may leave the process. No tokens, no userID. */
function publicView(store) {
  const s = store || load();
  return {
    activeId: s.activeId,
    accounts: s.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      color: a.color,
      plan: planLabel(a),
      org: (a.profile && a.profile.organizationName) || null,
      addedAt: a.addedAt,
      lastSwappedAt: a.lastSwappedAt,
      isActive: a.id === s.activeId,
      tokenExpired: !!(a.oauth && a.oauth.expiresAt && a.oauth.expiresAt <= Date.now()),
    })),
  };
}

const publicAccount = (id) => publicView().accounts.find((a) => a.id === id) || null;

module.exports = {
  PALETTE, load, save, list, get, add, update, remove,
  setActive, publicView, publicAccount, idFor, planLabel,
};

if (require.main === module) {
  const assert = require('node:assert');
  const os = require('node:os'), fsx = require('node:fs'), pathx = require('node:path');
  const tmp = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'swaper-store-'));
  process.env.SWAPER_DATA_OVERRIDE = tmp;
  const orig = P.accountsPath;
  P.accountsPath = () => pathx.join(tmp, 'accounts.json');
  P.dataDir = () => tmp;
  P.backupsDir = () => pathx.join(tmp, 'backups');

  const profile = { accountUuid: 'uuid-1', emailAddress: 'a@b.com', displayName: 'Tester', organizationRateLimitTier: 'default_claude_max_20x' };
  const oauth = { accessToken: 'sk-ant-oat01-SECRET', refreshToken: 'sk-ant-ort01-SECRET', expiresAt: Date.now() + 60000 };
  const a1 = add({ email: 'a@b.com', oauth, profile, userID: 'uid' });
  const a2 = add({ email: 'a@b.com', oauth, profile, userID: 'uid' });
  assert.strictEqual(a1.id, a2.id, 're-import must update in place, not duplicate');
  assert.strictEqual(list().length, 1);

  update(a1.id, { label: 'Renamed' });
  assert.strictEqual(get(a1.id).label, 'Renamed');
  assert.strictEqual(planLabel(get(a1.id)), 'Max 20x');

  setActive(a1.id);
  const view = publicView();
  assert.strictEqual(view.activeId, a1.id);
  assert.ok(view.accounts[0].isActive);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('sk-ant-'), 'publicView leaked a token');
  assert.ok(!('oauth' in view.accounts[0]), 'publicView leaked the oauth object');
  assert.ok(!('userID' in view.accounts[0]), 'publicView leaked userID');

  assert.ok(remove(a1.id));
  assert.strictEqual(load().activeId, null, 'removing the active account must clear activeId');

  P.accountsPath = orig;
  fsx.rmSync(tmp, { recursive: true, force: true });
  console.log('store.js self-check OK');
}
