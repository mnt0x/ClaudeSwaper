---
name: swapper
description: Cambia la cuenta activa de Claude Code (en el host) a la que indique el usuario por nombre o email, usando el panel LLMSwapper local, y muestra el uso disponible de esa cuenta tras el cambio. Úsala cuando el usuario escriba /swapper <nombre>, o pida cambiar/activar una cuenta concreta.
---

# /swapper <nombre o email>

Cambia la cuenta activa del host a la indicada y muestra cuánto uso le queda.

## Qué hacer

El nombre de la cuenta es lo que el usuario haya escrito tras `/swapper` (los `$ARGUMENTS`). Ejecuta con la herramienta Bash el CLI que viene junto a este SKILL.md, pasándole ese texto:

```
node "<directorio de esta skill>/swapper.mjs" swap <lo que pidió el usuario>
```

`<directorio de esta skill>` es la carpeta donde está este archivo (la misma donde está `swapper.mjs`); usa su ruta absoluta. Pasa el nombre entre comillas si lleva espacios.

Muestra la salida tal cual: confirma la nueva cuenta activa, el uso disponible (sesión y semana) y el recordatorio de que el cambio se aplica a las sesiones NUEVAS de Claude Code.

## Detalles

- Empareja por nombre o email, sin distinguir mayúsculas. Si el texto coincide con VARIAS cuentas, el CLI lo dice y pide el email para distinguir: pásaselo al usuario, no elijas tú.
- Si la cuenta ya está activa, el CLI lo indica y solo muestra el uso; no pasa nada malo.
- Por defecto cambia en el **host**. (Para WSL se usa el panel; esta skill es para el host.)

## Si falla

- "No llego al panel…": el servidor no corre. Dile que ejecute `node server.js` en la carpeta de LLMSwapper.
- "Ninguna cuenta coincide…": sugiérele `/swapper-usage` para ver los nombres exactos.
