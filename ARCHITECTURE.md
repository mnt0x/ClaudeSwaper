# ClaudeSwaper — internals

Notes on how Claude Code stores its session, and what ClaudeSwaper does with it.
Everything here was verified empirically against a live installation, not inferred.

Zero dependencies. Node >= 18 (global `fetch`). No build step.

---

## Where the session lives

| Piece | Location |
|---|---|
| Tokens | Windows/Linux: `~/.claude/.credentials.json` · macOS: login Keychain |
| Identity | `~/.claude.json` -> `oauthAccount` |

`lib/credentials.js` is the only module that knows which backend applies.

`.credentials.json` shape:

    { "mcpOAuth": { ... },
      "claudeAiOauth": {
        "accessToken": "...", "refreshToken": "...",
        "expiresAt": 0, "refreshTokenExpiresAt": 0,
        "scopes": [], "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x" } }

`~/.claude.json` is large (~130 KB) and holds dozens of unrelated keys — `projects`,
`mcpServers`, plugin state, onboarding flags. Only `oauthAccount` is ours to touch:

    "oauthAccount": { accountUuid, emailAddress, organizationUuid, hasExtraUsageEnabled,
      billingType, accountCreatedAt, subscriptionCreatedAt, ccOnboardingFlags,
      claudeCodeTrialEndsAt, claudeCodeTrialDurationDays, seatTier, displayName, fullName,
      profileFetchedAt, organizationRole, workspaceRole, organizationName, organizationType,
      organizationRateLimitTier, userRateLimitTier }

**`userID` is deliberately never written.** It does not derive from `accountUuid` — five hash
hypotheses were tested and none matched — so it is an install/telemetry identifier, not an
account one. Leaving it alone removes a whole class of risk.

`~/.claude.json` can go **stale** relative to the tokens: switching accounts by hand updates
the credentials but not `oauthAccount`. So the profile endpoint, not the local file, is the
source of truth for who a token belongs to.

---

## Anthropic endpoints used

All with these headers:

    Authorization: Bearer <accessToken>
    anthropic-beta: oauth-2025-04-20
    User-Agent: claude-cli/2.0.0 (external, cli)

| Purpose | Endpoint |
|---|---|
| Usage | `GET https://api.anthropic.com/api/oauth/usage` |
| Profile | `GET https://api.anthropic.com/api/oauth/profile` |
| Token refresh | `POST https://api.anthropic.com/v1/oauth/token` |

OAuth client id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

Scopes: `user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload`

> The token host matters. `https://console.anthropic.com/v1/oauth/token` answers **404
> not_found**; `api.anthropic.com` answers **400 invalid_grant** for a bad refresh token, i.e.
> it actually processed the request. Probed with a deliberately invalid token to avoid
> rotating a real one.

> There is no in-app OAuth login. The client only accepts its own registered redirect URIs —
> a loopback `http://127.0.0.1:PORT/callback` is rejected with *"Redirect URI ... is not
> supported by client"*. Importing an existing session is simpler and always works.

### Usage response

`limits[]` is the source of truth; the top-level keys are legacy mirrors kept as a fallback.

    {"five_hour":{"utilization":90.0,"resets_at":"...","locked_reason":null},
     "seven_day":{"utilization":28.0,"resets_at":"..."},
     "seven_day_opus":null,
     "extra_usage":{"is_enabled":false},
     "limits":[
       {"kind":"session","group":"session","percent":90,"severity":"critical",
        "resets_at":"...","scope":null,"is_active":true},
       {"kind":"weekly_all","group":"weekly","percent":28,"resets_at":"...","scope":null},
       {"kind":"weekly_scoped","group":"weekly","percent":18,
        "scope":{"model":{"id":null,"display_name":"Fable"}}}]}

Severity is recomputed locally from the percentage rather than trusting the server string, so
the API and the CSS always agree: `<50` normal, `50-79` medium, `80-94` high, `>=95` critical.

### Rate limiting

The usage endpoint has a low sustained quota: measured against the live API, the **fifth**
request in quick succession answers 429 with `Retry-After: 300`, escalating toward ~3600s if
you keep hitting it. That is a budget of about five requests per five minutes for the whole
app, however many accounts are configured.

Tuning the poll frequency cannot hold that, because a sweep of N accounts costs N requests. So
the primary mechanism is a **hard floor of 80 s between any two outbound calls** (`MIN_GAP_MS`,
`lib/usage.js`), which nothing bypasses — not the refresh button, not a second browser tab.
The number that matters is not the average rate but how many calls fit in the endpoint's 300 s
window: with a gap of `g` that is `floor(300/g) + 1`, so `g` must satisfy `4g >= 300`. At 70 s
it was exactly five, i.e. the app rate-limited itself.

Everything else sits around that floor: a 15-minute cache, 10-minute polling, and a backoff
that starts at 10 minutes and **doubles with each consecutive 429**, capped at an hour. The
cooldown and the offence counter are persisted alongside the cache, because a restart that
forgot them walked straight back into the block and reset the escalation.

Bookkeeping lives in `fetchRaw`, not `fetchFor`: the swap verifies a new token by calling
`fetchRaw` directly, and an uncounted call is exactly the amplification that trips the limit.
`fetchRaw` still never blocks — verifying a token has to work mid-cooldown — it just is not free.

When the API cannot be reached, the last known-good reading is served as `stale` rather than
blanking the UI. A 401/403 is surfaced as a real error, since the token is dead.

Turn order is "least recently **attempted** first", not least recently succeeded: ranking by
success alone let a single account with a dead token sit at zero and win every sweep for ever,
so the healthy accounts never got a reading at all.

### Token lifetimes

Access ~8 h, refresh ~29 days, rotating on every use. A background keep-alive renews anything
with under a day of life left, every 6 hours. Because refreshing **invalidates the previous
refresh token**, renewing the account whose session is live also writes the new pair into the
live credentials — otherwise Claude Code would be left holding a dead token.

Rotation runs in both directions, and the inbound one is what actually bites: **Claude Code
renews its own session**, so the live pair moves on and the store's copy is left holding a token
Anthropic has already killed. Nothing surfaces that until the keep-alive tries it, by which
point the account needs a real login — the one thing this app exists to avoid.

So before renewing anything, `swap.adoptLiveTokens` checks whether the live refresh token still
matches the active account's, and adopts the live pair when it does not. Tokens carry no
identity, so it only adopts when `oauthAccount` in `~/.claude.json` and our own `activeId` name
the same account: agreement means the identity never changed and only the pair moved. On any
disagreement it does nothing — writing one account's tokens into another's record is far worse
than asking for an import.

"Whose session is live" is decided by comparing the pre-refresh refresh token against the one
in the credentials, not by `activeId`. `activeId` cannot answer it: a swap writes the new
credentials and only calls `setActive()` at the very end, after a network round trip, so for
seconds at a time the two disagree by design — and a manual `claude /login` changes the live
session without telling the store at all. The write goes through the credentials **backend**,
so on macOS it lands in the Keychain rather than in a file Claude Code never reads.

---

## Targets: host and WSL

A **target** is where a swap writes. `lib/targets.js` enumerates them:

- `host` — the machine the server runs on, through its credentials backend (Keychain on
  macOS, file elsewhere).
- `wsl:<distro>` — a WSL distro that has Claude installed, reached over its file share:
  `\\wsl.localhost\<distro>\home\<user>\.claude.json` and `…\.claude\.credentials.json`.
  WSL is Linux, so it is always the plain-file backend. Detection runs `wsl.exe -l -q`,
  reads each distro's `$HOME`, and includes it only if `~/.claude.json` is reachable over
  the share — which simultaneously proves the distro is running and that Claude lives there.
  Detection is cached ~30s (it spawns several `wsl.exe` calls) and only happens on Windows.

The OAuth tokens are identical in every environment, so the **account store is shared**;
what differs per target is which account is *active* (`store.active` is a map keyed by
target id, migrated from the old single `activeId`) and which files a swap rewrites. A swap
is otherwise byte-for-byte the same operation — backup, in-place mutation, verify, roll
back — pointed at the target's two paths. `wsl.exe` is addressed absolutely from
`%SystemRoot%\System32` (falling back to `Sysnative`) because it is not always on the PATH
a spawned Node process sees.

A target's active account is read from the store; if we have never swapped there, it is
detected live from that environment's `oauthAccount.accountUuid`, so a freshly-opened WSL
shows its real current account as "in use" without a write. Windows-side writes over the
share cannot carry Linux `0600` bits — the files stay inside the WSL user's own home, which
is already user-scoped.

---

## Data store: `data/accounts.json`

    { "version": 1, "activeId": "acc_ab12cd", "accounts": [ {
      "id": "acc_ab12cd", "label": "...", "color": "#7c5cff", "email": "you@example.com",
      "oauth": { ...the claudeAiOauth shape... },
      "profile": { ...the oauthAccount block... },
      "userID": null, "addedAt": 0, "lastSwappedAt": null } ] }

Ids derive from `accountUuid`, so re-importing an account updates it instead of duplicating.
Mode 0600, plus an NTFS ACL on Windows where chmod is a no-op. `store.publicView()` is the
only shape allowed to reach the browser; it strips `oauth` and `userID`.

---

## HTTP API — 127.0.0.1 only

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ok, claudeRunning, pids, node, platform, credentialsBackend, paths}` |
| GET | `/api/targets` | `{targets:[{id, kind, label, activeId, running}]}` — host + each WSL distro |
| GET | `/api/accounts?target=` | `{activeId, accounts:[...]}` for that target — token fields stripped |
| GET | `/api/usage/all` | `{ "<id>": NormalizedUsage }`, sequential, failures isolated |
| GET | `/api/usage?id=` | `NormalizedUsage` |
| POST | `/api/swap` | `{id, target?}` -> `{ok, verified, target, warnings[], backup, account}` |
| POST | `/api/swap/dryrun` | `{id, target?}` -> what would change, writes nothing |
| POST | `/api/accounts/import` | `{configDir?, target?}` -> `{ok, account}` |
| PATCH | `/api/accounts/:id` | `{label?, color?}` |
| DELETE | `/api/accounts/:id` | `{ok}` |

`target` defaults to `host`. Usage is target-independent (the token is the same in any
environment), so `/api/usage*` take no target.

NormalizedUsage:

    { id, ok:true, fetchedAt, session:{percent,resetsAt,severity},
      weekly:{...}, scoped:[{label,percent,resetsAt}], opus, extraUsage, locked,
      stale?, staleSince?, staleReason? }
    // failure: { id, ok:false, error, status, needsRelogin }

Guards: loopback bind, `Host` validated, cross-site `Origin` rejected, `X-Swaper: 1` required
on **every `/api/` request, GET included**, static serving confined to `public/`. Anything
matching `sk-ant-[A-Za-z0-9_-]+` is scrubbed before it can reach a log or a response body.

GET is not exempt because read-only is not the same as harmless: `/api/health` spawns a process
per call and `/api/usage` spends the app's whole request budget for the window, and neither an
`<img>` nor a cross-site form can set a custom header. Static assets stay exempt — the browser
loads `/style.css` with no say in its headers.

The port is fixed. `EADDRINUSE` reports the running instance and exits rather than hopping to
the next free port: the rate floor is per process, so a second instance would double the
outbound rate and rate-limit both.

---

## The swap

1. Detect running Claude processes — warn, never block.
2. Back up credentials and `~/.claude.json` to `data/backups/<ts>/`. Backup failure aborts.
3. Refresh the token if it expires within 5 minutes.
4. Replace **only** `claudeAiOauth`; `mcpOAuth` and everything else survives.
5. Set **only** `oauthAccount` and drop the previous account's caches, so Claude Code refetches
   them: `overageCreditGrantCache, modelAccessCache, orgModelDefaultCache,
   passesEligibilityCache, cachedExtraUsageDisabledReason, hasAvailableSubscription,
   clientDataCacheSlots, additionalModelOptionsCache, additionalModelCostsCache,
   passesLastSeenRemaining`. Every other key keeps its value.
6. Verify with a **direct** API call — never a cached reading, which would "verify" a token it
   never used. 401/403 rolls back; a 429 or network failure keeps the swap and warns that it
   could not be confirmed.
7. Mark the account active.

Both mutations parse, mutate in place and re-serialise — never rebuild from a whitelist, which
would silently drop unrelated keys. A key-count check catches that anyway. Any failure past
step 4 restores both files from the step-2 backup.

Atomic write = tmp file in the same directory, `fsync`, `rename` over the target, with retries
because Windows antivirus can briefly lock a file mid-rename. Reads tolerate a UTF-8 BOM and
refuse to overwrite a file that does not parse.
