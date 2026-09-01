# ClaudeSwaper

Dashboard local para tus cuentas de Claude. Ves el uso de cada una (sesión de 5 h y semana
de 7 días) y cambias la cuenta activa con **un clic**, sin volver a hacer `claude /login`.

Cero dependencias: no hay `npm install` ni build. Solo Node 18 o superior.

```
>_ swaper  // claude account switcher

  ● Cyberxia    devs@…          Max 20x   5H ░░░░  2%   7D ███░░ 30%   [ IN USE ]
    Castillo    carlos…@…       Max 20x   5H ░░░░  0%   7D ███░░ 32%   [  SWAP  ]
```

---

## Arrancar

Desde una terminal, en la carpeta del proyecto:

```
node server.js
```

Se abre solo en <http://127.0.0.1:7373>. Escucha únicamente en loopback.

Si ya hay una instancia corriendo, la segunda te lo dice, abre la que ya está y sale. No salta
de puerto a propósito: el tope de ritmo de consultas es por proceso, así que dos instancias a la
vez doblarían las peticiones y acabarían limitadas las dos. Para otro puerto, `PORT=7400 node server.js`.

Para dejarlo corriendo de fondo, `npm start` o el gestor de procesos que uses.

---

## Plataformas

| | Credenciales | Estado |
|---|---|---|
| Windows | `~/.claude/.credentials.json` | Probado |
| Linux | `~/.claude/.credentials.json` | Debería funcionar; mismo backend que Windows |
| macOS | Keychain del sistema | Implementado, **sin probar en hardware real** |

Lo que sí está comprobado en cualquier plataforma: todo el código específico de Windows
(`icacls`, `tasklist`, `cmd /c start`) está aislado tras comprobaciones de plataforma, y la
suite de tests fuerza la rama de macOS para verificar que, si el Keychain no responde, cae al
fichero en vez de romperse. Lo que **no** puedo garantizar sin un Mac: el nombre exacto del
item del Keychain y si el primer acceso lanza el diálogo de permiso del llavero.

En macOS, Claude Code no guarda las credenciales en un fichero: usa el Keychain. `lib/credentials.js`
lo detecta y habla con el binario `security`. Si no encuentra el item del Keychain, cae al fichero.

Comprueba qué backend está usando tu máquina:

```
node lib/credentials.js
```

Si en tu Mac el item del Keychain se llama distinto, no toques el código:

```
export SWAPER_KEYCHAIN_SERVICE="el nombre real"
```

Para averiguarlo: `security dump-keychain | grep -i claude`.

---

## Añadir tus cuentas

Se hace **una sola vez por cuenta**. Después ya solo pulsas SWAP.

Por cada cuenta:

**1.** En una terminal:

```
claude
```

**2.** Dentro de Claude:

```
/login
```

`/login` es un comando del REPL, no un argumento: `claude /login` no hace lo que esperas.

**3.** Inicia sesión en el navegador con la cuenta que quieras añadir.

**4.** Cuando confirme, sal con `/exit`.

**5.** En el dashboard, pulsa **`[i] import`**.

Aparece una fila nueva. Esa cuenta queda guardada para siempre.

**6.** Repite con la siguiente cuenta.

> **El orden importa.** `import` guarda la cuenta que esté viva **en ese instante**. Primero
> `/login`, después `import`. Si importas sin haber cambiado de cuenta, vuelve a guardar la
> misma — no duplica (el id sale del `accountUuid`), solo la actualiza.

> **Cada `/login` te saca de la cuenta anterior.** Es normal: ya está guardada. Cuando termines
> de meterlas todas, pulsa SWAP en la que quieras usar.

### Variante: login aislado

Si no quieres que el `/login` te eche de la cuenta que estás usando ahora mismo:

```
CLAUDE_CONFIG_DIR=/tmp/cuenta2 claude
```

En Windows:

```
set CLAUDE_CONFIG_DIR=C:\temp\cuenta2
claude
```

Haz `/login`, sal, y en el dashboard **Shift+clic** sobre `[i] import` indicando esa carpeta.
Tu sesión principal no se altera.

> **No arranques el servidor en esa misma ventana.** `set CLAUDE_CONFIG_DIR=...` vale para toda
> la sesión de terminal, así que un `node server.js` lanzado ahí hereda la variable y opera sobre
> la carpeta desechable en vez de sobre tu configuración real: el swap diría que ha ido bien y no
> habría cambiado nada. Si pasa, el servidor lo avisa al arrancar con la ruta sobre la que está
> trabajando. Usa una terminal nueva, o `set CLAUDE_CONFIG_DIR=` para vaciarla.

> No hay login OAuth dentro del dashboard, y es deliberado: el cliente OAuth de Claude Code
> solo acepta sus propias URIs de redirección registradas, así que un `http://127.0.0.1:PUERTO/callback`
> se rechaza con *"Redirect URI is not supported by client"*. Importar es más simple y siempre funciona.

---

## Cambiar de cuenta

Pulsa **SWAP** en la fila que quieras. Por dentro:

1. Detecta si Claude Code está abierto y avisa.
2. Copia de seguridad de las credenciales y de `~/.claude.json`.
3. Refresca el token si está a punto de caducar.
4. Reescribe **solo** el bloque `claudeAiOauth` de las credenciales (`mcpOAuth` se conserva).
5. Reescribe **solo** `oauthAccount` en `~/.claude.json` y borra las cachés de la cuenta anterior
   para que Claude Code las vuelva a pedir. El resto del fichero no se toca.
6. Verifica contra la API que el token nuevo funciona. Un 401/403 revierte desde la copia; un
   429 o un fallo de red no revierten, pero avisan de que no se pudo confirmar.
7. Marca la cuenta como activa.

**El cambio se aplica a las sesiones NUEVAS de Claude Code.** Una sesión ya abierta mantiene su
token en memoria: ciérrala y vuelve a abrirla.

---

## Por qué no vuelves a hacer login

| Token | Dura |
|---|---|
| access | ~8 horas |
| refresh | ~29 días, y se renueva cada vez que se usa |

Con el servidor abierto, ClaudeSwaper renueva solo cualquier cuenta a la que le quede menos de
un día de vida, cada 6 horas. Mientras arranques el dashboard al menos una vez al mes, las
cuentas no caducan y no tienes que volver a iniciar sesión.

Renovar **rota** el refresh token e invalida el anterior. Si la cuenta renovada es la que Claude
Code está usando, el nuevo par se escribe también en sus credenciales vivas; si no, la próxima
vez que el CLI intentara refrescar con el token viejo te echaría.

---

## Límites de la API de uso

Medido contra la API real: **la quinta petición seguida devuelve 429**, con `Retry-After: 300`,
y el castigo escala hasta ~3600s si insistes. O sea, unas **5 consultas por cada 5 minutos para
toda la app**, tengas las cuentas que tengas.

Ajustar la frecuencia no basta: un barrido de N cuentas cuesta N peticiones, así que con
suficientes cuentas un solo refresco agota la cuota. Por eso hay **un tope duro de ritmo**:
80 segundos entre dos consultas cualesquiera, pase lo que pase. Ni machacando `[r] refresh` se
puede superar. Lo que cuenta no es el ritmo medio sino cuántas consultas caben en la ventana de
5 minutos de la API: con un hueco de 80 s son cuatro, una por debajo de la que devuelve 429.
Todo lo demás gira alrededor de ese tope: caché de 15 minutos, sondeo cada 10,
y backoff que se duplica con cada 429 seguido.

Cuando varias cuentas compiten por el turno, lo gana **la más desactualizada**, así que todas
acaban refrescándose por rotación en vez de quedarse una fija consultando siempre. Las que
esperan muestran `en cola, turno en Xs` y se reconsultan solas al vencer el plazo.

Cuando la API no responde, el dashboard **muestra los últimos datos buenos** marcados en ámbar
(`datos de hace Xs`) en lugar de vaciar la fila. La caché se guarda en `data/usage-cache.json`
(solo porcentajes, sin tokens) para sobrevivir a un reinicio. Un 401/403 sí se muestra como
error, porque ahí el token está realmente muerto.

Las consultas se hacen **de una en una**, nunca en ráfaga, y solo el botón `[r] refresh` salta
la caché. Importar, cambiar de cuenta o borrar reutilizan lo que ya hay: cada consulta forzada
cuesta una llamada **por cuenta**, y esa multiplicación es justo lo que agota la cuota.
El swap alimenta la caché con el dato que ya obtuvo al verificar el token, así que no se paga
dos veces por el mismo número.

**Si te sale `Uso no disponible`, la cuenta está bien.** Solo faltan los porcentajes hasta que
pase la espera; importar y hacer swap siguen funcionando con normalidad.

---

## Copias de seguridad

Cada swap guarda ambas configuraciones en `data/backups/<fecha>/`. Se conservan las últimas 20.
En macOS, las credenciales del Keychain se vuelcan a `credentials.json` dentro de esa carpeta,
así que la copia se restaura igual en cualquier plataforma.

Para restaurar a mano en Windows o Linux:

```
cp data/backups/<fecha>/claude.json       ~/.claude.json
cp data/backups/<fecha>/credentials.json  ~/.claude/.credentials.json
```

En macOS, para las credenciales:

```
security add-generic-password -U -s "Claude Code-credentials" -a "$USER" \
  -w "$(cat data/backups/<fecha>/credentials.json)"
```

---

## Atajos

| Tecla | Acción |
|---|---|
| `r` | refrescar el uso |
| `i` | importar la cuenta actual |

---

## Seguridad

- `data/accounts.json` guarda **tokens OAuth reales en texto plano**. No compartas ni subas la
  carpeta `data/`; ya está en `.gitignore`.
  En Windows, `chmod` casi no hace nada, así que `data/` se protege con una ACL NTFS real
  (`icacls`) limitada a tu usuario. En Linux y macOS se usa modo 0600.
- El servidor escucha solo en `127.0.0.1`, valida la cabecera `Host`, rechaza `Origin` de otro
  sitio y exige la cabecera `X-Swaper: 1` en **toda** petición a `/api/`, también las de lectura:
  una web cualquiera no puede ponerla, y `/api/health` lanza un proceso por llamada mientras
  `/api/usage` gasta el presupuesto de consultas de toda la app. Los estáticos siguen exentos.
- Los tokens nunca salen hacia el navegador ni aparecen en logs ni en mensajes de error.
- `userID` de `~/.claude.json` **no se toca**: es un identificador de instalación, no de cuenta
  (comprobado: no deriva del `accountUuid`).
- En macOS, escribir en el Keychain pasa el secreto por `argv`, brevemente visible con `ps`.
  `security` no ofrece alternativa por stdin.

---

## Comprobaciones

```
node test.js
```

Verifica el normalizado del uso, la conversión de caducidad de tokens, el comportamiento ante
un 429, el ida y vuelta de credenciales, que la vista pública no filtra credenciales y —lo
importante— que el swap conserva todas las claves de `~/.claude.json`.

También cubre lo que cuesta caro cuando se rompe: que el keep-alive solo sincroniza la sesión
viva si sigue siendo de esa cuenta, que el rollback no puede dejar un `~/.claude.json` a medias,
que el cooldown de un 429 sobrevive a reiniciar, que una cuenta con el token muerto no acapara
el turno de consulta, y que la API entera exige la cabecera `X-Swaper` mientras los estáticos no.

---

## Estructura

```
server.js            API HTTP + ficheros estáticos
lib/paths.js         rutas de config + escritura atómica
lib/credentials.js   fichero o Keychain, según plataforma
lib/store.js         data/accounts.json
lib/oauth.js         refresco de tokens + perfil
lib/usage.js         endpoint de uso + normalizado
lib/swap.js          el cambio de cuenta
public/              interfaz
```

---

## Licencia

MIT. Ver [LICENSE](LICENSE).
