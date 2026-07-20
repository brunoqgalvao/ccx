# Statusline basics + account spillover — design

Date: 2026-07-07 · Status: approved by Bruno (this session)

## Feature 1 — basic session segment in the statusline

The statusline stdin JSON (CC 2.1.203) carries `model.display_name`,
`context_window.used_percentage`, and `effort.level`; ccx discards all three
today. Render them as a segment BEFORE the accounts segment:

```
Fable 5 · ctx 5% · med │ ⚡meistrari 5h98%✗ wk58% │ bqg …
```

- `buildBasicSegment(input): string` — pure, in `statusline.ts`.
  - Model: `model.display_name` verbatim.
  - Context: `ctx N%` from `context_window.used_percentage`; append `!` when ≥ 80.
  - Effort: `effort.level` abbreviated — low/med/high/xhigh/max.
  - Any missing field is skipped; all missing → empty string (render-only
    mode / older CC versions degrade silently).
- Config `statuslineBasic: boolean`, default `true`.
- Order: `passthrough basic │ accounts` (passthrough stays first, as today).

## Feature 2 — spillover at warningPct (75%)

Problem: with another claude running, `runLaunch` refuses to swap the
Keychain slot ("staying on X"), so new sessions pile onto the active account
until it hits 100% and forces a mid-session failover.

Rule (uses existing `cfg.warningPct = 75`, binding gauge for the target
model, `bindingGauge()` from picker):

1. Active account binding usage **< 75%** → stay on it (no swap at all —
   stickier than today's always-max-headroom pick).
2. Active **≥ 75%** and some other usable (non-needsLogin, non-stale-blind)
   account is **< 75%** → pick max-headroom among those:
   - no other claude running → Keychain swap via `activate` (as today);
   - another claude running → launch the new session **pinned** via
     `CLAUDE_CODE_OAUTH_TOKEN` (reuse `prepareRun` + `spawnClaudePinned`),
     Keychain untouched. Message: `ccx: spillover — pinned session on Y
     (X at N%)`.
3. Everyone ≥ 75% → today's behavior (pickAccount max headroom + guard).

Known limitation (accepted): a pinned spillover session does not get the
post-exit `offerFailover` flow — same as `ccx run` today.

## Tests

- `buildBasicSegment`: full input, each field missing, all missing, ctx ≥ 80
  nudge, effort abbreviations, `statuslineBasic: false`.
- Picker/launch: active < 75 stays; active ≥ 75 with idle alternative swaps;
  spillover pins when another claude runs; all ≥ 75 falls back; needsLogin
  and missing-snapshot alternatives are skipped.

## Amendment (2026-07-20, v0.4.0): pinned spillover retired

Rule 2's "another claude running → pinned via `CLAUDE_CODE_OAUTH_TOKEN`" branch
is removed. Discovery: env-token sessions carry no subscription metadata (the
keychain blob's `subscriptionType` never reaches the client), so the interactive
UI gates subscription models — Fable shows "needs extra usage credits" even on
Max 20x. Spillover now ALWAYS swaps the live slot via `activate`, printing a
heads-up when another claude session shares it (that session may adopt the new
account's tokens on its next refresh; post-exit `syncBack` re-attributes rotated
pairs by refresh-token hash). `ccx run <name>` follows the same keychain-first
path; the env-token launch survives as opt-in `ccx run <name> --pin` and for
`ccx warm` pings (print-mode calls are not affected by the UI gate).
