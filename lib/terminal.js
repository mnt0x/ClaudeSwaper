'use strict';
/**
 * Abrir una terminal VISIBLE corriendo `claude setup-token`.
 *
 * El flujo de alta empieza fuera del panel: hay que buscar una terminal, escribir el comando,
 * aprobar en el navegador y volver a pegar. Esto se lleva el primer paso, que es el único que el
 * panel puede quitar de en medio; el resto lo hace Anthropic y lo hace el usuario.
 *
 * La ventana tiene que SOBREVIVIR al comando. `setup-token` imprime el token una vez y no lo
 * guarda en ningún sitio, así que una terminal que se cierre al terminar lo tira a la basura -
 * de ahí el `/k` en Windows y el `read` en Linux. Es el detalle que decide si esto sirve.
 *
 * Nada de lo que entra por HTTP llega hasta aquí: el comando es una constante y se pasa como
 * argv, nunca como una cadena que un shell tenga que volver a interpretar.
 */
const { spawn, execFileSync } = require('node:child_process');

const CLI = 'claude';
const ARG = 'setup-token';

/** ¿Está `claude` en el PATH que ve este proceso? Sin él, abrir una terminal solo enseña un error. */
function claudeInstalled() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [CLI],
      { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Emuladores de terminal de Linux, en orden de preferencia. gnome-terminal dejó de aceptar -e
// hace años y quiere `--`, así que cada uno lleva su propia forma de recibir el comando.
const LINUX_TERMINALS = [
  { bin: 'x-terminal-emulator', args: (sh) => ['-e', 'bash', '-lc', sh] },
  { bin: 'gnome-terminal', args: (sh) => ['--', 'bash', '-lc', sh] },
  { bin: 'konsole', args: (sh) => ['-e', 'bash', '-lc', sh] },
  { bin: 'xfce4-terminal', args: (sh) => ['-e', `bash -lc ${JSON.stringify(sh)}`] },
  { bin: 'alacritty', args: (sh) => ['-e', 'bash', '-lc', sh] },
  { bin: 'kitty', args: (sh) => ['bash', '-lc', sh] },
  { bin: 'xterm', args: (sh) => ['-e', 'bash', '-lc', sh] },
];

function existeEnPath(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lanza la terminal. Devuelve una etiqueta de CÓMO se abrió, para que el panel pueda decirlo:
 * "no pasa nada" y "abrí algo y no sé el qué" se parecen demasiado en una interfaz.
 * Lanza excepción si en esta plataforma no hay forma de abrir ninguna.
 */
function openSetupToken() {
  const opts = { detached: true, stdio: 'ignore' };

  if (process.platform === 'win32') {
    // /k y no /c: con /c la ventana se cierra al acabar y el token se va con ella.
    const cmdline = `${CLI} ${ARG}`;
    try {
      // Windows Terminal si está: respeta el perfil del usuario y no abre una consola heredada.
      const child = spawn('wt.exe', ['cmd', '/k', cmdline], { ...opts, windowsHide: false });
      child.on('error', () => {});
      child.unref();
      return 'Windows Terminal';
    } catch { /* cae a cmd */ }
    // `start` necesita un título antes del comando, o toma el primer argumento entrecomillado
    // como título de la ventana y no ejecuta nada.
    const child = spawn('cmd.exe', ['/c', 'start', 'claude setup-token', 'cmd', '/k', cmdline],
      { ...opts, windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return 'cmd.exe';
  }

  if (process.platform === 'darwin') {
    // do script deja el shell vivo detrás del comando, así que el token se queda a la vista.
    const script = `tell application "Terminal" to do script "${CLI} ${ARG}"`;
    const child = spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], opts);
    child.on('error', () => {});
    child.unref();
    return 'Terminal.app';
  }

  // Linux: el shell se queda esperando una tecla, o la ventana se cerraría con el token dentro.
  const sh = `${CLI} ${ARG}; echo; read -r -p 'Copia el token y pulsa Enter para cerrar…'`;
  for (const term of LINUX_TERMINALS) {
    if (!existeEnPath(term.bin)) continue;
    const child = spawn(term.bin, term.args(sh), opts);
    child.on('error', () => {});
    child.unref();
    return term.bin;
  }
  throw new Error('No encontré ningún emulador de terminal en este sistema');
}

module.exports = { claudeInstalled, openSetupToken, LINUX_TERMINALS };

if (require.main === module) {
  const assert = require('node:assert');
  // Sin abrir nada: solo que la deteccion no lanza y que la tabla de Linux esta bien formada.
  assert.strictEqual(typeof claudeInstalled(), 'boolean');
  for (const t of LINUX_TERMINALS) {
    assert.ok(t.bin && typeof t.args === 'function');
    const argv = t.args('echo hola');
    assert.ok(Array.isArray(argv) && argv.length >= 1, `${t.bin} debe producir argv`);
    assert.ok(argv.every((a) => typeof a === 'string'), `${t.bin}: todo argv debe ser string`);
  }
  console.log(`terminal.js self-check OK (claude ${claudeInstalled() ? 'encontrado' : 'no encontrado'})`);
}
