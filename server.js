'use strict';
// Zero-dependency local server. Binds loopback only; it holds real OAuth tokens.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const P = require('./lib/paths');
const store = require('./lib/store');
const oauth = require('./lib/oauth');
const usage = require('./lib/usage');
const swap = require('./lib/swap');
const credentials = require('./lib/credentials');

const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 7373;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const deps = { store, oauth, usage, swap };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

const fail = (res, status, message) => send(res, status, { ok: false, error: oauth.scrub(message) });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Cuerpo de la petición demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('JSON inválido en el cuerpo')); }
    });
    req.on('error', reject);
  });
}

/**
 * Two guards against a random website in the user's browser driving this API:
 * a same-origin check, and a custom header that a simple cross-site form cannot set.
 * Applied to every mutating route.
 */
function guard(req, res, port) {
  const host = req.headers.host || '';
  const allowedHosts = [`${HOST}:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(host)) { fail(res, 403, 'Host no permitido'); return false; }

  const origin = req.headers.origin;
  if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) {
    fail(res, 403, 'Origen no permitido'); return false;
  }
  if (req.method !== 'GET' && req.headers['x-swaper'] !== '1') {
    fail(res, 403, 'Falta la cabecera X-Swaper'); return false;
  }
  return true;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Traversal guard: the resolved path must still sit inside public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'Prohibido');
  fs.readFile(target, (err, data) => {
    if (err) return fail(res, 404, 'No encontrado');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/** Turn a set of tokens into a stored account, using the live profile as the source of truth. */
async function adoptTokens(tokenOauth, existingUserID) {
  const { email, profile } = await oauth.fetchProfile(tokenOauth.accessToken);
  return store.add({ email, oauth: tokenOauth, profile, userID: existingUserID || null });
}

async function handleApi(req, res, url, port) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    const procs = swap.detectClaudeProcesses();
    return send(res, 200, {
      ok: true, claudeRunning: procs.running, pids: procs.pids, node: process.version,
      platform: process.platform,
      credentialsBackend: credentials.describeBackend(),
      paths: { claudeJson: P.claudeJsonPath(), data: P.dataDir() },
    });
  }

  if (pathname === '/api/accounts' && method === 'GET') return send(res, 200, store.publicView());

  if (pathname === '/api/usage/all' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    return send(res, 200, await usage.fetchAll(store.list(), { force }));
  }

  if (pathname === '/api/usage' && method === 'GET') {
    const account = store.get(url.searchParams.get('id'));
    if (!account) return fail(res, 404, 'Cuenta no encontrada');
    return send(res, 200, await usage.fetchFor(account, { force: url.searchParams.get('force') === '1' }));
  }

  if (pathname === '/api/swap' && method === 'POST') {
    const { id } = await readBody(req);
    if (!id) return fail(res, 400, 'Falta el id de cuenta');
    try {
      return send(res, 200, await swap.swapTo(id, deps));
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  if (pathname === '/api/swap/dryrun' && method === 'POST') {
    const { id } = await readBody(req);
    try { return send(res, 200, await swap.dryRun(id, deps)); }
    catch (err) { return fail(res, 400, err.message); }
  }

  if (pathname === '/api/accounts/import' && method === 'POST') {
    const { configDir } = await readBody(req);
    const identity = swap.readCurrentIdentity(configDir);
    if (!identity) {
      return fail(res, 400, configDir
        ? `No se encontró ninguna sesión en ${configDir}`
        : 'No hay ninguna sesión de Claude Code activa que importar. Ejecuta "claude", haz /login y vuelve a pulsar import.');
    }
    try {
      const account = await adoptTokens(identity.oauth, identity.userID);
      // Only the live config reflects the account actually in use.
      if (!configDir) store.setActive(account.id);
      return send(res, 200, { ok: true, account: store.publicAccount(account.id) });
    } catch (err) {
      return fail(res, 502, `No se pudo verificar la cuenta actual: ${err.message}`);
    }
  }

  const idMatch = pathname.match(/^\/api\/accounts\/([A-Za-z0-9_]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim().slice(0, 60);
      if (typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)) patch.color = body.color;
      if (!Object.keys(patch).length) return fail(res, 400, 'Nada que actualizar');
      const updated = store.update(id, patch);
      if (!updated) return fail(res, 404, 'Cuenta no encontrada');
      return send(res, 200, { ok: true, account: store.publicAccount(id) });
    }
    if (method === 'DELETE') {
      usage.invalidate(id);
      return store.remove(id) ? send(res, 200, { ok: true }) : fail(res, 404, 'Cuenta no encontrada');
    }
  }

  return fail(res, 404, 'Endpoint desconocido');
}

/**
 * The whole point of this app is never logging in again. Access tokens last ~8h and
 * refresh tokens ~29 days, rotating on each use — so an account left untouched for a
 * month would die and need a real login. This keeps every stored account alive in the
 * background, whether or not you ever swap to it.
 * Uses the token endpoint, NOT the rate-limited usage endpoint.
 */
const KEEPALIVE_EVERY_MS = 6 * 60 * 60 * 1000;   // every 6h
const REFRESH_WHEN_UNDER_MS = 24 * 60 * 60 * 1000; // renew if under a day of life left

async function keepTokensAlive() {
  const activeId = store.load().activeId;
  for (const account of store.list()) {
    const o = account.oauth;
    if (!o || !o.refreshToken) continue;
    const life = (o.expiresAt || 0) - Date.now();
    if (life > REFRESH_WHEN_UNDER_MS) continue;
    try {
      const fresh = oauth.toStoredOauth(await oauth.refresh(o.refreshToken), o);
      store.update(account.id, { oauth: fresh });
      // Refreshing ROTATES the refresh token and kills the old one. If this is the
      // account Claude Code is currently using, its credentials file now holds a dead
      // token — push the new pair across or we would log the user out of their CLI.
      if (account.id === activeId) {
        swap.writeCredentials(P.credentialsPath(), fresh);
      }
      console.log(`  token renovado: ${account.email}${account.id === activeId ? ' (y sincronizado con Claude Code)' : ''}`);
    } catch (err) {
      // Do not delete anything — a transient network failure must not cost an account.
      console.warn(`  no se pudo renovar ${account.email}: ${oauth.scrub(err.message)}`);
    }
  }
}

function createServer(port) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${port}`);
    } catch {
      return fail(res, 400, 'URL inválida');
    }
    try {
      if (!guard(req, res, port)) return;
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, port);
      if (req.method !== 'GET') return fail(res, 405, 'Método no permitido');
      return serveStatic(res, url.pathname);
    } catch (err) {
      if (!res.headersSent) fail(res, 500, err && err.message ? err.message : 'Error interno');
    }
  });
}

function listen(port, attemptsLeft) {
  const server = createServer(port);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(`No se pudo abrir el puerto ${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`\n  ClaudeSwaper  ->  ${url}`);
    console.log(`  datos: ${P.dataDir()}`);
    console.log('  Ctrl+C para salir\n');
    if (!process.env.NO_OPEN) oauth.openBrowser(url);
    keepTokensAlive();
    setInterval(keepTokensAlive, KEEPALIVE_EVERY_MS).unref();
  });
  const bye = () => { server.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  return server;
}

if (require.main === module) {
  P.ensureDirs();
  listen(BASE_PORT, 10);
}

module.exports = { createServer, listen };
