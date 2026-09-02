<div align="center">

# ClaudeSwaper

**Switch the active Claude Code account with one click - and see how much of each account's quota is left before you do.**

[![test](https://github.com/monac-cc/ClaudeSwaper/actions/workflows/test.yml/badge.svg)](https://github.com/monac-cc/ClaudeSwaper/actions/workflows/test.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#docker)
[![platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

No `npm install`, no build step, no telemetry, nothing leaves your machine but the two calls it
makes to Anthropic. One `server.js`, seven small modules and three static files.

```
Swaper                                                       [ + add token ]  [ refresh ]

HOST                                                                         [ import ]
  ● Cyberxia    devs@…        SESSION   2%   WEEK  30%                    [  IN USE  ]
    Castillo    carlos@…      SESSION   0%   WEEK  32%                    [   swap   ]

WSL · Ubuntu                                                                 [ import ]
  ● Castillo    carlos@…      SESSION  12%   WEEK  19%                    [  IN USE  ]
    Cyberxia    devs@…        SESSION   4%   WEEK  23%                    [   swap   ]
```

> **The interface is in Spanish.** The labels map one to one onto the sections below:
> *añadir token* = add token, *importar* = import, *swap* = switch to this account,
> *renombrar* = rename, *quitar* = remove, *sesión · 5h* / *semana · 7d* = the two quota windows.

---

## Contents

- [Why](#why) · [Requirements](#requirements) · [Quick start](#quick-start)
- [Adding accounts](#adding-accounts) · [Usage meters](#usage-meters) · [Switching](#switching)
- [Docker](#docker) · [Security](#security) · [Limitations](#limitations)
- [Troubleshooting](#troubleshooting) · [Development](#development)

---

## Why

Claude Code holds one account at a time. Using a second one means `claude`, `/login`, a browser
round trip, every time. If you have a personal account and a work one, that is a tax you pay all
day.

ClaudeSwaper stores each account once and makes the change a click - on your machine and inside
your WSL distros, from the same screen. It also shows what each account has left of its 5-hour
session window and its weekly window, so the question it actually answers is *which account should
I switch to right now*.

## Requirements

- **Node 18 or newer.** It uses the built-in `fetch`; there is nothing else to install.
- **Claude Code**, to mint the tokens (`claude setup-token`) or to import a live session.
- Works on **Windows, macOS and Linux**. WSL targets are a Windows feature; see
  [Limitations](#limitations).

## Quick start

```bash
git clone https://github.com/monac-cc/ClaudeSwaper.git
cd ClaudeSwaper
node server.js
```

It opens <http://127.0.0.1:7373>. Another port:

```bash
PORT=7400 node server.js
```

The port is fixed on purpose - it does not hop to the next free one. The rate floor that keeps
this app inside the usage endpoint's budget is enforced **per process**, so a second instance
would double the outbound rate and rate-limit both. If the port is taken it says so and exits.

## Adding accounts

Two ways in, and the choice decides one thing: whether the account can identify itself.

### Paste a long-lived token - recommended

```bash
claude setup-token
```

Approve it in the browser, copy the token it prints, then press **añadir token** in the panel (or
the `t` key), paste it and give it a name. **It lasts a year.** No renewal, no logging in again.

`setup-token` grants a single OAuth scope, `user:inference`, so Anthropic will not let it read the
profile endpoint. That account therefore has no identity of its own and shows the name you gave it.
Its **quota meters still work** - they come from a different source, see below.

There is no way around this, and the panel does not pretend otherwise. The profile endpoint is the
only thing that knows an account's plan, email and organisation, and it answers an inference-only
token `403`. The inference response carries no plan or tier header either - the panel reads the
quota straight off its rate-limit headers, and those are the only account facts on offer. So the
panel shows no plan column at all rather than an empty one, and the name you give an account is
what identifies it, in the list and in Claude Code's own `/status`.

### Import a live session

Sign in with the account in Claude Code (`claude`, then `/login`), then press **import**. Those
accounts carry the full scope set, so they identify themselves - email and organisation - and read
their quota from the usage endpoint at no token cost. The price is logging in once per account, and
a refresh token that dies after ~29 days of not opening the panel.

To capture a second account without disturbing the session you are using, start it in a separate
config directory and import with **Shift + click** on **import**:

```bash
CLAUDE_CONFIG_DIR=/tmp/second-account claude
```

Adding the same account twice updates it in place. It never creates duplicates.

## Usage meters

Refreshed **every 5 minutes**, and on **refresh**. Where the numbers come from depends on the
token, and so does what they cost you:

| Account type | Source | Cost per reading |
|---|---|---|
| Imported (full scope) | `/api/oauth/usage`, the same endpoint `/usage` uses | **0 tokens** |
| Pasted `setup-token` | `anthropic-ratelimit-unified-*` response headers | **8 in + 1 out** |

The usage endpoint answers an inference-only token `403` forever, so for those accounts the panel
never calls it - spending one of the app's ~5 requests per 5 minutes on a guaranteed failure would
starve the accounts that *can* answer. Instead it reads the quota off the rate-limit headers that
come back on any inference call. The free endpoints (`count_tokens`, `/v1/models`) carry no such
headers, so something has to be spent: the floor is Haiku with `max_tokens: 1` and a
one-character prompt. At one probe per account every five minutes that is roughly **2,600 tokens a
day**, against a window measured in hundreds of thousands.

When it cannot refresh, it shows the last known reading marked as stale rather than blanking the
row. Switching accounts works regardless.

## Switching

Press **swap**. In order, it:

1. Warns if Claude Code is open - the change lands on **new** sessions, not the running one.
2. Backs up the credentials and `~/.claude.json` to `data/backups/` (last 20 kept).
3. Refreshes the token first if it is about to expire.
4. Rewrites **only** `claudeAiOauth` in the credentials and `oauthAccount` in `~/.claude.json`.
   Everything else - `mcpOAuth`, your projects, history, MCP servers - is left untouched.
5. Verifies the new token against the API, and **rolls both files back** if anything fails.

Each environment (host, and each WSL distro) tracks its own active account and has its own
**import** button.

## Docker

The image is Linux and runs anywhere Docker does - including Apple Silicon, since `node:22-alpine`
is multi-arch. What changes per host is what you mount and what stops working.

```bash
docker compose up -d      # then open http://127.0.0.1:7373
```

Or by hand, publishing on a port of your choice:

```bash
docker build -t claudeswaper .
docker run -d --name claudeswaper \
  -p 127.0.0.1:7373:7373 \
  -v "$PWD/data:/app/data" \
  -v "$HOME/.claude:/home/node/.claude" \
  -v "$HOME/.claude.json:/home/node/.claude.json" \
  claudeswaper
```

**Publish on `127.0.0.1` only.** The server listens on `0.0.0.0` *inside* the container because it
has no choice, so the loopback guarantee has to be imposed on the host side. Dropping the
`127.0.0.1:` prefix puts a panel that handles paid credentials on every interface of your machine.

**Mount the same `data/` you already use.** A named volume gives the container a separate, empty
store - right for a server that only ever runs Docker, baffling on a machine where you already
added accounts.

**Do not run the container and `node server.js` at the same time.** The rate floor is per process;
two instances double the outbound rate and rate-limit each other.

Per host:

| Host | Notes |
|---|---|
| **Linux** | Everything in the table below works. If the mounted files are owned by another uid, add `--user "$(id -u):$(id -g)"`. |
| **macOS** | Bind mounts work, but Claude Code stores credentials in the **login Keychain**, which a Linux container cannot reach. Swapping only works if your credentials live in `~/.claude/.credentials.json` as a file. |
| **Windows** | Set `$env:CLAUDE_HOME = $env:USERPROFILE` before `docker compose up`, since `$HOME` is not what compose expects. |

What a container cannot do, on any host:

| Feature | In a container |
|---|---|
| Panel, meters, quota probe, adding accounts | works |
| Swapping the host's credentials | works, if you mounted `~/.claude` |
| Telling whether Claude Code is running | **no** - it sees only the container's processes |
| WSL targets | **no** - `wsl.exe` does not exist inside |

The panel says both of those on screen instead of reporting "not running" for something it simply
cannot see.

## Security

- Listens on **loopback only** and requires its own header on every API request, so no page open in
  your browser can drive it. DNS rebinding is rejected by validating the `Host` **hostname**.
- Tokens live in `data/`, locked down with a real NTFS ACL on Windows, and **never** leave the
  process: the view that reaches the browser contains no token, and anything matching `sk-ant-*` is
  scrubbed before it can reach a log or a response body. There is a test that fails the build if a
  token literal appears in any source file.
- **No OAuth login inside the panel.** You mint tokens with `claude setup-token` in your own
  terminal and paste them; the panel never drives an authorisation flow.
- A pasted token is a **year-long** secret, far longer-lived than the ~8 hours of an imported one.
  The field is a password input and is emptied when the form closes.
- Every switch is preceded by a backup, and any failure after the first write rolls both files back.

## Limitations

- **`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` outrank the
  credentials file.** While any of them is set, switching is a silent no-op: the panel reports
  success, the file changes, and Claude Code keeps using the variable. The panel detects this and
  says so, in the UI and in `/api/health`.
- **Accounts added by token cannot be resolved to an identity** - no email, no plan, no
  organisation. The profile endpoint rejects such a token and the inference response carries no
  tier header, so there is nothing to read. The panel shows the name you gave it and invents
  nothing. Name an account with its real email and `/status` reads as it always did.
- **Remote Control does not work with `setup-token` accounts.** Anthropic documents it: such a
  token "can only make model requests". Claude Code then prints `Remote Control disconnected -
  /login`, which reads like a login prompt but is not: the session itself is authenticated.
  Silence it with `"disableRemoteControl": true` in `~/.claude/settings.json`.
- **The usage endpoint is rate-limited** to roughly 5 requests per 5 minutes for the whole app.
  That is why there is a hard floor between outbound calls and a persisted, escalating cooldown.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Switching "works" but Claude Code keeps the old account | An overriding environment variable. See [Limitations](#limitations). |
| `Remote Control disconnected - /login` | Expected with `setup-token` accounts. Not a broken session. |
| `Not logged in - Please run /login` | The credentials blob has no `scopes`. Never write it empty. |
| Meters empty and marked stale | Rate-limited. It recovers on its own; switching is unaffected. |
| `Ya hay algo escuchando en…` on start-up | Another instance. Deliberate - the port never hops. |

## Development

```bash
node test.js        # 49 checks, ~2 s, no external network
```

The suite stubs every `fetch`, so a run never spends the usage endpoint's budget. Each module also
has its own self-check (`node lib/swap.js`). Internals - the endpoints, the token model, the swap
and its rollback - are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

[MIT](LICENSE)
