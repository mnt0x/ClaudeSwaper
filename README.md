# ClaudeSwaper

Panel local para gestionar varias cuentas de Claude y **cambiar la cuenta activa de Claude
Code con un clic**, sin volver a hacer `claude` y `/login`. Guardas cada cuenta una vez y a
partir de ahí saltas entre ellas al instante — en tu equipo y en tus entornos WSL, desde la
misma pantalla.

Además te muestra, para cada cuenta, cuánto llevas gastado de la sesión de 5 horas y del límite
semanal, con su cuenta atrás — para saber de un vistazo a cuál conviene saltar.

Cero dependencias: no hay `npm install` ni compilación. Solo Node 18 o superior, un fichero
`server.js` y tres estáticos.

```
Swaper

HOST                                                                         [ import ]
  ● Cyberxia    devs@…       Max 20x   SESSION  2%   WEEK  30%            [ IN USE ]
    Castillo    carlos@…     Max 20x   SESSION  0%   WEEK  32%            [  swap  ]

WSL · Ubuntu                                                                 [ import ]
  ● Castillo    carlos@…     Max 20x   SESSION 12%   WEEK  19%            [ IN USE ]
    Cyberxia    devs@…       Max 20x   SESSION  4%   WEEK  23%            [  swap  ]
```

---

## Requisitos

- **Node 18 o superior** (usa `fetch` nativo).
- Claude Code instalado y con al menos una sesión iniciada (para importar la primera cuenta).

No necesita permisos de administrador ni conexión a más servicios que la propia API de Claude.

---

## Arrancar

En la carpeta del proyecto:

```
node server.js
```

Se abre solo en <http://127.0.0.1:7373> y escucha **únicamente en loopback** (127.0.0.1): no
es accesible desde la red. Para dejarlo de fondo, `npm start`.

Si ya hay una instancia en marcha, la segunda te avisa, abre la que ya está y sale. Para usar
otro puerto: `PORT=7400 node server.js`.

---

## Añadir una cuenta

Cada cuenta se guarda una sola vez:

1. Inicia sesión con esa cuenta en Claude Code (`claude`, luego `/login`).
2. En el panel, pulsa **import**: ClaudeSwaper toma la cuenta con la que tienes sesión ahora,
   verifica su token contra la API y la guarda.

A partir de ahí la cuenta aparece siempre en el panel y cambiar a ella es un clic. Reimportar la
misma cuenta la actualiza en su sitio; no crea duplicados.

Para capturar una segunda cuenta sin cerrar la sesión que estás usando, inícialas en carpetas
separadas con `CLAUDE_CONFIG_DIR` e impórtalas con **Mayús + clic** en **import** (host).

---

## Cambiar de cuenta

El panel muestra tus entornos uno debajo de otro, cada uno con sus cuentas:

- **HOST** — tu equipo.
- **WSL · &lt;distro&gt;** — cada distribución de WSL con Claude Code instalado (solo en Windows).

Cada entorno marca su propia cuenta activa (**IN USE**) y su propio botón **import**. Pulsa
**swap** en la cuenta que quieras y el cambio se aplica a *ese* entorno. Host y WSL son
independientes: puedes trabajar con una cuenta en tu equipo y otra distinta en WSL a la vez.

Tus cuentas son las mismas en todos los entornos —el token es idéntico—, así que no hay que
volver a importarlas: basta con haberlas guardado una vez.

**El cambio se aplica a las sesiones nuevas de Claude Code.** Una sesión ya abierta mantiene su
token en memoria; ciérrala y vuelve a abrirla. Si Claude Code está abierto en un entorno, su
sección te lo indica.

Por dentro, cada swap:

1. Hace copia de seguridad de las credenciales y de `~/.claude.json`.
2. Refresca el token si está a punto de caducar.
3. Reescribe **solo** el bloque de credenciales de la cuenta (el resto del fichero, incluidos
   los servidores MCP, no se toca) y **solo** el bloque de identidad en `~/.claude.json`.
4. Verifica contra la API que el token nuevo funciona. Si el token está muerto, revierte desde
   la copia; un fallo de red no revierte, pero avisa.

---

## Por qué no vuelves a hacer login

Los tokens de acceso de Claude duran unas 8 horas y el de refresco unos 29 días, rotando cada
vez que se usan. Con el panel abierto, ClaudeSwaper renueva en segundo plano cualquier cuenta a
la que le quede menos de un día de vida, de modo que mientras lo abras de vez en cuando tus
cuentas no caducan y no tienes que volver a iniciar sesión.

Si Claude Code renueva su propia sesión por su cuenta, el panel lo detecta al arrancar y adopta
el par de tokens vigente, siempre que pueda confirmar de quién es — nunca escribe los tokens de
una cuenta en el registro de otra.

---

## Uso y límites

El uso se lee del mismo sitio que `/usage` en Claude Code. Ese endpoint tiene una cuota baja, así
que ClaudeSwaper limita su propio ritmo de consultas y sirve valores en caché alrededor de ese
tope; cuando no puede refrescar, muestra el último dato conocido marcado como *antiguo* en lugar
de dejar la fila en blanco. El cambio de cuenta funciona siempre, independientemente de esto.

---

## Copias de seguridad

Antes de cada cambio se guarda una copia de las credenciales y de `~/.claude.json` en
`data/backups/`. Se conservan las últimas 20. Si algo va mal, el propio cambio revierte solo;
las copias están ahí como red adicional.

---

## Seguridad

- El servidor escucha solo en `127.0.0.1` y exige una cabecera propia en cada petición a su API,
  de modo que ninguna web abierta en el navegador puede darle órdenes.
- Los tokens viven en `data/`, con permisos restringidos al usuario, y **nunca** salen del panel:
  la vista que llega al navegador no incluye ningún token.
- No hay login OAuth dentro del panel: importar la sesión existente es más simple y no expone
  credenciales a un flujo web.

---

## Comprobaciones

```
node test.js
```

Cubre el normalizado del uso, el manejo de límites de la API, el ida y vuelta de credenciales, que
la vista pública no filtra tokens, que un cambio conserva todas las claves de `~/.claude.json`, y
que un cambio dirigido a un entorno escribe en los ficheros de ese entorno y no en los del equipo.

---

## Licencia

MIT. Ver [LICENSE](LICENSE).
