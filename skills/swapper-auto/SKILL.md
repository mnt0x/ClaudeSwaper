---
name: swapper-auto
description: Enciende o apaga la rotación automática de cuentas de Claude en LLMSwapper, y muestra la cuenta actual y la siguiente. Con la rotación activada, el panel cambia solo a la cuenta más libre cuando la sesión de 5h de la cuenta activa llega al 90%. Úsala cuando el usuario escriba /swapper-auto, o pida activar/desactivar el cambio automático de cuentas por uso.
---

# /swapper-auto [on | off]

Activa o desactiva la rotación automática por uso, y muestra el estado.

## Qué hacer

Mira lo que el usuario escribió tras `/swapper-auto` (los `$ARGUMENTS`):

- `on` (o "activar", "enciende") → activar.
- `off` (o "desactivar", "apaga") → desactivar.
- vacío, o "status"/"estado" → solo mostrar el estado, sin cambiar nada.

Ejecuta con la herramienta Bash el CLI que viene junto a este SKILL.md con el verbo correspondiente:

```
node "<directorio de esta skill>/swapper.mjs" auto on        # activar
node "<directorio de esta skill>/swapper.mjs" auto off       # desactivar
node "<directorio de esta skill>/swapper.mjs" auto status    # solo ver
```

`<directorio de esta skill>` es la carpeta donde está este archivo (la misma donde está `swapper.mjs`); usa su ruta absoluta.

Muestra la salida tal cual. Trae:
- si la rotación está **ACTIVADA o desactivada**, el entorno (host) y el umbral (90%),
- la **cuenta actual** y su % de sesión,
- la **siguiente cuenta** a la que rotaría (la más libre con margen) y su %.

## Cómo funciona (para explicárselo si pregunta)

- La rotación la hace el **servidor**, no esta skill: mientras el panel esté corriendo, vigila el uso de la cuenta activa y, en cuanto su sesión de 5h llega al **90%**, cambia a la siguiente cuenta más libre. Así tu próximo `claude` arranca con cupo fresco.
- El cambio se aplica a las sesiones NUEVAS (una sesión ya abierta conserva su token).
- Solo rota a una cuenta que tenga margen (por debajo del 90% en sesión y semana); si ninguna lo tiene, se queda como está.
- El estado se guarda en disco: sigue activada aunque reinicies el panel.

## Si falla

- "No llego al panel…": el servidor no corre. Dile que ejecute `node server.js` en la carpeta de LLMSwapper.
