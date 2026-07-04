# ccx — Multi-Account Orchestrator for Claude Code

**Date:** 2026-07-03
**Status:** Draft for review
**Owner:** Bruno Galvão

## Problem

Bruno runs Claude Code with two Anthropic subscription accounts (personal + work) and today switches between them by manually logging in/out, mentally tracking each account's 5-hour session window, weekly quota, and the Fable-scoped weekly cap (Fable may consume only ~50% of the weekly quota, so it tops out while general quota remains). Claude Code has no native multi-account support and no built-in failover when a limit is hit.

`ccx` is a small CLI that owns both accounts' credentials, always knows both accounts' limit status, picks the best account when launching Claude Code, and assists switching (including resuming the current conversation) when a limit is hit.

## Goals

1. Launch Claude Code on the account with the most effective headroom for the model being used — no manual login juggling.
2. Track all three limit gauges per account: 5h session, weekly-all, weekly-scoped (Fable).
3. Assist failover on a hard limit: swap account and resume the same conversation (`claude --continue`), honoring a cache-aware policy.
4. Visibility: a `status` command and statusline segment showing both accounts' gauges and reset times.
5. Warnings: macOS notifications on severity transitions (`normal → warning → critical`) for any gauge on either account.

## Non-Goals

- No proxy/interception of API traffic (no `ANTHROPIC_BASE_URL` layer). Switching happens at process boundaries only.
- No mid-session hot-swap: prompt cache is account-scoped and model-scoped, so in-flight switching buys nothing over exit-swap-resume. Accounts are interchangeable quota pools (user decision) — no project→account affinity rules.
- No usage *history* database, projections, or burn-rate analytics — onwatch (already installed) does that. ccx keeps only the latest snapshot per account.
- No support for claude.ai web/desktop sessions — Claude Code CLI only.
- The data model is N-account-generic, but UX and testing target exactly two accounts.

## Verified Mechanisms (facts this design relies on)

All verified live on this machine on 2026-07-03:

1. **Live credential slot.** Claude Code on macOS stores OAuth credentials as JSON in the Keychain generic password: service `Claude Code-credentials`, account `<username>`. Shape: `{"claudeAiOauth": {accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier}, "mcpOAuth": {...}}`. There is **no account identifier** in this JSON. Claude Code reads it at startup and writes back rotated tokens. The blob also carries MCP server OAuth tokens (`mcpOAuth`), so ccx must always copy it verbatim.
2. **Usage endpoint.** `GET https://api.anthropic.com/api/oauth/usage` with headers `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>` returns a `limits[]` array: `{kind: session|weekly_all|weekly_scoped, percent, severity: normal|warning|critical, resets_at, scope: {model: {display_name}}, is_active}`. The Fable cap appears as `weekly_scoped` with `scope.model.display_name == "Fable"`. Unofficial endpoint; aggressively rate-limited (~5 req/token; ~1 req/min without the User-Agent header).
3. **Statusline feed.** Claude Code invokes the configured `statusLine.command` with JSON on stdin that includes a `rate_limits` object and the session's current model (`model.id`) — free real-time limit data for the *active* account while a session runs. Verified shape (v2.1.199): `rate_limits.{five_hour,seven_day}.{used_percentage, resets_at}` with `resets_at` in unix seconds — **no scoped (Fable) gauge and no severity field**. Consequently statusline snapshots are *partial*: they refresh the `session` and `weekly_all` gauges and `model`, while `weekly_scoped` comes only from the usage endpoint; the Usage Service merges rather than replaces, and derives severity locally for statusline-sourced gauges (defaults: ≥75% warning, ≥95% critical, configurable). Bruno's current statusline chain: tee to `~/.onwatch/data/anthropic-statusline.json` → `bun x ccusage statusline`.
4. **Token refresh.** `POST https://console.anthropic.com/v1/oauth/token` with Claude Code's public OAuth client ID (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`) and the refresh token rotates the token pair (mechanism proven by onwatch, which writes results back to the Keychain). `invalid_grant` means the refresh token is dead → account needs interactive re-login.
5. **Profile endpoint.** `GET https://api.anthropic.com/api/oauth/profile` (same headers as the usage endpoint) returns `{account: {uuid, email, ...}, organization: {uuid, rate_limit_tier, ...}}`. `account.uuid` is the stable account identifier used for vault ownership resolution.
6. **No native alternative.** Claude Code has no profiles, no non-interactive `/usage`, no auth fallback (verified against docs + GitHub issues, mid-2026).

## Architecture

Single TypeScript CLI on Bun (Bruno's ecosystem; fast enough startup for statusline use), installed as `ccx`. Five units:

```
┌─────────┐   launch/swap   ┌──────────┐   read gauges   ┌──────────────┐
│ Launcher │ ──────────────▶ │  Vault   │                │ Usage Service │
│  (ccx)   │                 │(Keychain)│                │ (poll+bridge) │
└────┬─────┘                 └──────────┘                └──────┬───────┘
     │            picks account via                            │
     └────────────────▶ ┌────────┐ ◀───────────────────────────┘
                        │ Picker │        snapshots
                        └────────┘
              ┌───────────┐  ┌──────────┐
              │ Statusline│  │ Notifier │   (both consume snapshots)
              └───────────┘  └──────────┘
```

### 1. Credential Vault

**Purpose:** own both accounts' OAuth credential sets; control which one occupies the live slot.

- Vault entries: Keychain generic passwords, service `ccx-vault-<name>` (`personal`, `work`), value = the exact JSON blob Claude Code stores, copied verbatim (including `mcpOAuth` — each account keeps its own MCP logins). Tokens never touch disk.
- **Ownership resolution — who owns the live slot?** The credential JSON has no account identifier and both tokens rotate routinely (Claude Code during sessions, ccx's own parked refresh, onwatch out-of-band), so token comparison cannot be the source of truth. Instead:
  - `state.json` records, per account: `account_uuid` + `email` (captured at `import` via the profile endpoint, mechanism #5) and the SHA-256 of the refresh token as last written by ccx.
  - `resolveOwner()`: if the live slot's refresh-token hash matches a vault entry's recorded hash, that entry owns it (cheap short-circuit — nothing rotated since ccx last wrote). On mismatch, call the profile endpoint with the live slot's access token and match `account.uuid` against state. On 401, first refresh the live slot's own token pair (mechanism #4, written back to the live slot), then retry the profile call. Unknown uuid → foreign login → prompt `ccx import`; still unresolvable (offline) → **defer**: set `sync_pending` in state and retry on the next ccx invocation rather than guessing.
- **Operations:**
  - `activate(name)`: `syncBack()`, then copy vault entry `<name>` → live slot, update state (active account + new hashes). **Guard:** if `syncBack()` deferred (`sync_pending`), abort the swap with a clear message instead of overwriting the live slot — it holds rotated tokens not yet captured in any vault entry, and refresh rotates the *pair*, so clobbering them would brick that account until interactive re-login. Aborting is harmless in practice: an unresolvable sync usually means offline, and Claude Code is unusable offline anyway.
  - `syncBack()`: after a Claude Code session exits, `resolveOwner()` then copy live slot → owning vault entry (captures tokens Claude Code rotated). Runs on launcher exit and on `ccx sync`.
  - `refreshParked(name)`: when the parked account's access token is expired/expiring (or usage poll gets 401), refresh directly against the token endpoint (mechanism #4) and update the vault entry + hash. On `invalid_grant`: mark account `needs-login` in state, notify, stop polling it. Direct refresh is used because no non-interactive CLI path exists to refresh a *parked* account (Claude Code only refreshes the live slot, and running a throwaway turn would burn quota).
  - `import(name)`: capture the *current* live slot into vault entry `<name>`, fetching `account.uuid`/`email` via the profile endpoint (used during setup: log in to account A normally, `ccx import personal`, log in to B, `ccx import work`).
- **Recovery path** if direct refresh ever breaks (endpoint change): `ccx swap` makes the account live; Claude Code refreshes it natively on next launch.

### 2. Usage Service

**Purpose:** maintain a fresh snapshot of all gauges for both accounts in `state.json`.

- **Active account (primary source — free, real-time):** `ccx statusline` receives Claude Code's statusline JSON on stdin, extracts `rate_limits` + current model, **merges** them into the account's snapshot (statusline refreshes `session`/`weekly_all`/`model`; existing `weekly_scoped` from the last poll is preserved — see mechanism #3), writes state atomically (temp-file + rename), preserves the existing tee to onwatch's bridge file, and pipes through to the configured render command (default: `bun x ccusage statusline`), appending ccx's account segment to the rendered line.
- **Parked account (and active fallback):** on-demand poll of the usage endpoint (mechanism #2) with the required headers. Polled lazily — when `ccx` launches, on `ccx status`, and by the notifier check — never more than once per `poll_min_interval` (default 300s, per account; last-poll timestamp in state, set even on failure). On 429: serve the stale snapshot marked with its age; the `poll_min_interval` floor doubles as the backoff (typical `retry-after` values are far below 300 s, so parsing the header buys nothing). On 401: trigger `refreshParked`, retry once.
- **onwatch coexistence:** onwatch shares the endpoint's per-token budget (~5 req/token). It prefers the statusline bridge file and only falls back to API polling, but 429s must be treated as *expected* (stale-serving, not errors). If they become chronic, `ccx doctor` suggests disabling onwatch's Anthropic API polling.
- Snapshot shape (per account): `{fetched_at, source: statusline|poll, model?, gauges: [{kind, percent, severity, resets_at, scope_model, is_active}]}` — `model` (the session's current model, tracking mid-session `/model` switches) is present only for `statusline`-sourced snapshots and is what failover assessment reads.
- **Degraded mode:** if the endpoint breaks entirely, active-account data still flows via statusline; picking falls back to "prefer account not marked limited; on hard limit just swap" — predictive picking is disabled, orchestration still works.

### 3. Picker

**Purpose:** decide which account a new session should use.

- `effectiveHeadroom(account, model)` = min of `100 − percent` over applicable gauges: `session` and `weekly_all` always; `weekly_scoped` only when it applies to the target model. **Matching rule:** a scoped gauge applies when its lowercased `scope.model.display_name` is a substring of the lowercased target model string (`"fable"` ∈ `"claude-fable-5[1m]"`). Target model comes from the `--model` passthrough arg, else `model` in `~/.claude/settings.json`; if neither is determinable, include **all** scoped gauges (conservative: never overstates headroom).
- Pick: highest effective headroom; tiebreak (within `tiebreak_margin`, default 5 points): the account whose *binding* gauge resets sooner. Stale snapshots (> `stale_after`, default 30 min) trigger a poll before picking; if polling fails, pick with stale data and say so.
- Pure function over snapshots → trivially unit-testable.

### 4. Launcher

**Purpose:** the `ccx` entry point wrapping `claude`.

- `ccx [claude args...]`: refresh snapshots → pick account → `activate` if different from current → warn if any gauge of the chosen account is `warning`+ → spawn `claude` with passthrough args → on exit, `syncBack()` → run failover assessment. If `activate` aborts (sync_pending guard), launch proceeds on the *current* account with a notice — a session on the second-best account beats no session.
- **Failover assessment (after claude exits):** the session's model is taken from the last statusline snapshot (which tracks mid-session `/model` switches), falling back to the launch model. If the just-used account's binding gauge for that model is `critical`/`is_active` (limit hit), and the hit limits do not all reset within `switch_min_reset_wait` (default 30 min — the cache-aware rule: if *every* hit gauge resets soon, waiting is cheaper than re-reading the whole context uncached; if any hit gauge stays blocked for hours, waiting brings no relief), and the other account has headroom:
  - other account has Fable headroom → offer: `Resume on <other>? [Y/n]` → `activate(other)` + `claude --continue`.
  - both accounts' Fable pools topped but general quota remains → offer resume on the better account with a model downgrade (`claude --continue --model opus`), burning the underused general pool.
  - otherwise → print soonest reset time across accounts and exit.
- Non-interactive mode (`ccx -p ...`): auto-applies **account switching only** — `activate(other)`, then re-run the original `claude` invocation unchanged, adding `--continue` when the interrupted run got far enough to create a session (opt-out: `--no-failover`). Model downgrade is never automatic — a headless pipeline silently producing weaker-model output is worse than failing loudly — unless explicitly enabled with `--allow-downgrade`.
- **Concurrency guard:** the live slot is global — one active account for all sessions. Before `activate`, detect other running `claude` processes (pgrep); if found, warn and require `--force` (a running session will later sync-back *its* account's rotated tokens; the Vault's `resolveOwner()` makes that safe, but two accounts can't be live simultaneously).

### 5. Statusline & Notifier

- **Statusline segment** (appended to existing render): compact both-account view, e.g. `⚡P 5h 23%·wk 44%·F 75%! │ W 5h 4%·wk 12%·F 30%` (active account marked, `!` = warning+, `✗` = limit active, `?` = stale data). Exact glyphs are an implementation detail.
- **Notifier:** an internal step of `ccx statusline` and `ccx status` (not a subcommand). It compares the previous snapshot's severities to the current one and emits a macOS notification (`osascript`/`terminal-notifier`) on any transition upward, per account/gauge, throttled to once per gauge per hour. Statusline runs fire continuously during sessions, giving quasi-realtime checks (parked account polled at most every `poll_min_interval`). Known, accepted gap: no notifications fire when no session is running and no ccx command is invoked — a launchd agent is the Milestone 3 escape hatch if that ever matters.

## CLI Surface

```
ccx [claude args...]      # pick best account, launch claude (default command)
ccx status [--json]       # both accounts: gauges, severities, resets, active marker
ccx swap [name] [-c]      # switch live slot (default: the other account); -c = claude --continue
ccx import <name>         # capture current live slot into the vault (setup)
ccx sync                  # manual live-slot → vault sync-back
ccx statusline            # stdin JSON → snapshot + render (wired into settings.json)
ccx doctor                # keychain access, endpoint reachability, token validity, settings wiring
```

Setup flow (documented in README): `claude /login` (account 1) → `ccx import personal` → `claude /login` (account 2) → `ccx import work` → `ccx doctor` → optionally replace `statusLine.command` with `ccx statusline` (ccx prints the exact settings.json edit; it does not modify settings itself).
Optional alias: `alias cc="ccx --dangerously-skip-permissions"` (Bruno's current `cc` alias points at bare `claude`).

## Configuration & State

- `~/.ccx/config.json`: account names, `switch_min_reset_wait` (30 min), `poll_min_interval` (300 s), `stale_after` (30 min), `tiebreak_margin` (5), derived-severity thresholds (`warning_pct` 75, `critical_pct` 95), statusline passthrough command + tee path, `claude-code` User-Agent version string for the poller.
- `~/.ccx/state.json`: active account, `sync_pending` flag, per-account `{account_uuid, email, snapshot, last_poll, refresh_token_hash, needs_login}`, notifier state (last-seen severities + last-notified timestamps and severities per gauge, for the hourly throttle with escalation bypass). **No secrets in either file** (mode 0600 regardless). Disposable: the Keychain vault entries are the source of truth — see failure table.

## Failure Modes

| Failure | Behavior |
|---|---|
| Usage endpoint changes/breaks | Degraded mode: statusline-only data, no predictive picking; swap-on-limit still works. `ccx doctor` flags it. |
| Direct token refresh breaks | Parked account marked `needs-login`; recovery via `ccx swap` (native refresh) or interactive `/login` + `ccx import`. |
| `invalid_grant` on parked refresh | Same: `needs-login`, notify once, stop polling that account. |
| Keychain access denied | Clear error naming the item; `ccx doctor` proves write access via a dedicated self-test item and read access on the real entries (it never writes to real credential items). |
| Endpoint 429 | Serve stale-marked snapshot; `poll_min_interval` (300 s) acts as the backoff floor. |
| Live slot changed out-of-band (foreign login, onwatch refresh) | `resolveOwner()`: hash short-circuit misses → profile endpoint → uuid match. Unknown uuid → prompt `ccx import`; never blind-writes a vault entry. |
| Offline (or 401) during sync-back | Ownership unresolvable → defer: set `sync_pending`, retry on next ccx invocation. No guessing. |
| `state.json` corrupt or missing | Fail safe with an empty state: vault Keychain entries stay untouched (unverifiable overwrites are refused), and recovery is manual — `ccx import` for the live account, `/login` + `ccx import --force` for the other. Automatic Keychain-enumeration rebuild is deferred (Milestone 3 candidate). |
| Live slot mutated between ownership resolution and sync-back write (concurrent login/refresh) | `syncBack` writes the exact blob `resolveOwner` resolved from its single read — a concurrent writer can never contaminate another account's vault entry. |
| Keychain write fails after a successful token refresh | Retry once; the fresh pair is preserved wherever it can be written (sync-back places the resolved blob in the vault), `sync_pending`/`needs-login` set as applicable, user notified. Vault functions return structured errors — raw exceptions never escape. |
| `refreshParked` asked to refresh a pair that is actually live (stale `active_account`) | The live-slot token comparison — not state — is the ownership predicate; the refresh is refused before the pair is consumed. |
| Profile endpoint returns an empty/absent uuid | Never treated as an identity: resolution reports unresolved, import fails — prevents two degraded accounts from aliasing to one vault entry. |
| Credential blob outgrows `security -i`'s 4096-byte line buffer | `write()` refuses up front (oversized lines split and execute a truncated, item-destroying write — live-verified); `ccx doctor` reports blob-size headroom. Current real blob ≈ 1.9 KB escaped. |
| Blob contains non-printable/non-ASCII (foreign writer) | `security` returns it hex-mangled on read → token parse fails → treated as unresolved (never propagated); ccx's own writes reject non-ASCII up front. |
| Another claude session running during swap | Warn + require `--force`. |
| Stale snapshots at pick time | Poll first; on failure pick with stale data, visibly marked. |

## Security Notes

- Tokens live only in the macOS Keychain (vault entries + live slot); never in files, argv, or logs. `state.json` holds hashes and percentages only.
- The usage endpoint and refresh flow are the same calls Claude Code/onwatch already make with the user's own tokens for the user's own accounts — no third-party services involved.

## Testing Strategy

- **Unit (pure):** Picker (headroom math incl. scoped-gauge matching rule and unknown-model conservatism, tiebreaks, stale handling), failover policy (reset-wait threshold, account-vs-downgrade ordering, headless rules), snapshot parsing (endpoint + statusline shapes), severity-transition detection.
- **Integration (mock boundary):** Vault against a fake `security` shim + stubbed profile endpoint — ownership resolution paths (hash hit, hash miss → uuid match, unknown uuid, offline defer/`sync_pending` replay); Usage Service against a stubbed HTTP server (200/401/429/network-fail paths).
- **Manual E2E checklist (real accounts, run once before adopting):** import both accounts → `ccx status` shows correct live gauges for both → launch lands on higher-headroom account → `ccx swap -c` resumes a real conversation → sync-back preserves rotated tokens after a session (verify with `ccx doctor`).

## Milestones

1. **MVP (usable day one):** Vault (import/activate/syncBack/refreshParked) + Usage Service polling + Picker + `ccx` launch + `ccx status` + `ccx swap -c` + `ccx doctor`. Manual swap on limit.
2. **Assisted failover:** post-exit failover assessment with resume prompt, including the interactive model-downgrade offer (it falls out of the same policy that must classify scoped-exhaustion anyway); `ccx statusline` bridge (snapshot capture + passthrough + segment); notifier on severity transitions; README.
3. **Polish:** headless auto-failover for `-p` mode (`--allow-downgrade`), launchd notifier agent, config tuning.
