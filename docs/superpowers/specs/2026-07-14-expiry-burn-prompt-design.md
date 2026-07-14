# Use-it-or-lose-it launch prompt — design

Date: 2026-07-14 · Status: approved by Bruno (this session; "suggest, don't
decide" + Y/n prompt chosen over picker changes; scenario-iterated)

## Problem

Weekly quota (wk + Fable-scoped F) is use-it-or-lose-it: anything unspent
when the window resets evaporates. The picker is pure max-headroom, so an
idle account (100%) always outranks an account with 40% of Fable quota
resetting in 2h — steering the user away from tokens that are about to be
free. Real occurrence 2026-07-14 (meistrari F expiring in 2h; ccx pushed a
fresh account instead).

Decided policy: the pick itself does NOT change. ccx surfaces the expiring
quota and lets the user redirect the launch with one keystroke.

## Rule

New pure function in `picker.ts`:

```ts
expiryHint(cands, pickedName, model, cfg, now): { name, gauge } | null
```

An account qualifies when ALL hold:

1. Not the picked account, not `needsLogin`, has a snapshot.
2. Has a **weekly** gauge (`weekly_all` or `weekly_scoped` — never
   `session`) that applies to the target model (`gaugeApplies`) with
   `0 < resetEpoch − now ≤ expiryNudgeMin` and unused
   `≥ expiryNudgeUnusedPct`.
3. Usability floor: `effectiveHeadroom(snapshot, model) ≥ 100 −
   criticalPct` — an account with any applicable gauge ≥ 95% is not
   suggested (mirrors `assessFailover`'s `minUsable`; don't steer a launch
   into an immediate limit hit).
4. Not muted (see decline memory).

Suppression: no hint at all when the **picked** account itself has an
applicable expiring-unused weekly gauge — the launch is already burning
expiring quota; prompting a switch is churn.

Selection: among qualifying accounts, soonest reset wins. Message copy uses
that account's qualifying gauge with the most unused percentage points.

## Launch UX (`runLaunch`, after `spilloverPick`, before activation)

- TTY: `ccx: 🔥 meistrari has 40% of Fable quota expiring in 2h (use it or
  lose it)` then `launch there instead? [Y/n]` via existing `askYesNo`
  (Enter = yes). Accept → the hint account becomes the pick and falls
  through the existing swap-or-pin machinery (`activate`, or `prepareRun` +
  `runRun` pinning when another claude is running). Decline → original pick
  proceeds.
- Non-TTY / `-p`: print the hint plus the copy-paste command
  (`ccx run meistrari`); no prompt; proceed with the pick.
- `ccx run <account>` explicit launches never hint — the user already chose.
- `--continue`/`--resume` launches still hint: accepting rebuilds prompt
  cache on the hint account, which burns the expiring quota — the point.

## Decline memory

Declining writes `expiryHintMutedUntil[account] = gauge.resetsAt` to state.
While `now < mutedUntil`, that account produces no prompt AND no non-TTY
print (statusline 🔥 stays as the passive reminder). Mute expires with the
window itself — no epoch-equality matching, no throttle timers. Accepting
stores nothing: every subsequent launch re-prompts, and stacking more
sessions onto the expiring account is desirable.

## Config

- `expiryNudgeMin` default **60 → 180** (catches the real 2h case). Single
  knob shared with the statusline 🔥.
- `expiringUnused()` (statusline.ts) gains the weekly-only restriction:
  without it, raising the horizon to 180 makes 🔥 fire during the last 3h
  of EVERY 5h session window (~60% of the time) — pure noise. Weekly
  windows are in their final 3h only ~1.8% of the week.
- `expiryNudgeUnusedPct: 25` unchanged. No new config keys.
- New state field `expiryHintMutedUntil: Record<string, string>` (ISO), with
  the usual state-migration default `{}`.

## Scenario matrix (what drove the iterations)

| # | Scenario | Outcome |
|---|----------|---------|
| 1 | Original complaint: F 60% used resets 2h, other account idle | Hint fires ✅ |
| 2 | Picked account IS the expiring one (e.g. sticky active) | No hint — already correct ✅ |
| 3 | Session (5h) gauge expiring with unused quota | Never hints — 5h quota recycles ~34×/week; weekly is the scarce asset. Also keeps 🔥 sane at the 180min horizon |
| 4 | Picked account also has expiring-unused weekly quota | Suppressed — switching swaps one free pool for another (churn) |
| 5 | Expiring gauge ≥ 75% used (unused < 25%) | No hint — threshold ✅ |
| 6 | Hint account's session gauge at 98% | Suppressed by usability floor — don't recommend an account that limits out in minutes |
| 7 | `--model opus` launch, only F (Fable-scoped) expiring | No hint — `gaugeApplies` false; opus can't burn Fable quota ✅ |
| 8 | Model unknown at launch | Hint fires (`gaugeApplies` returns true). Accepted trade-off: default sessions usually run the scoped model; a wrong hint costs one harmless account switch, a missed hint costs quota |
| 9 | Window already reset / never started | `resetEpoch` past or NaN → `msLeft ≤ 0` → no hint ✅ |
| 10 | Reset in 10min | Still hints — accepting is strictly safe (account is about to be 100% fresh anyway); no minimum-time floor |
| 11 | Decline, then relaunch in same window | Silent until the window resets (mute) |
| 12 | Accept, then open more terminals | Re-prompts each launch — stacking sessions on free quota is the goal |
| 13 | Non-TTY cron spam during the 3h window | One stderr line per run; muted if user declined interactively |
| 14 | Snapshot refresh failed (network) | Hint may use stale data — advisory only, low harm; `runLaunch` refreshes snapshots before picking so this is the rare path |

## Tests

- `expiryHint` (picker.test.ts): fires on weekly_all and weekly_scoped;
  never on session; model scoping (scoped gauge + non-matching model;
  unknown model); soonest-reset selection; most-unused gauge for copy;
  skips picked/needsLogin/snapshot-less; usability floor at criticalPct;
  suppression when picked account is expiring; mute honored/expired;
  msLeft ≤ 0 and NaN resetEpoch.
- `expiringUnused` (statusline.test.ts): session gauge no longer flags;
  weekly still does at the new horizon.
- Launcher (launcher.test.ts, mocked `askYesNo`): accept routes to hint
  account via existing machinery; decline proceeds with pick and writes
  mute; non-TTY prints without prompting; mute suppresses print; explicit
  `ccx run` path untouched.
- State migration: absent `expiryHintMutedUntil` defaults to `{}`.
