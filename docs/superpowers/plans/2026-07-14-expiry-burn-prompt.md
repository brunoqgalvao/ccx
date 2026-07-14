# Use-it-or-lose-it Launch Prompt Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At launch, when a non-picked account has ≥25% unused weekly quota resetting within 3h, offer a one-keystroke Y/n redirect to that account. Picker scoring is untouched.

**Architecture:** One pure detection function (`expiryHint` in picker.ts), one thin prompt/redirect helper in launcher.ts with injected `ask` (codebase idiom: `runWarm(d, spawn = spawnClaudeQuiet)`), one new state map (`expiryHintMutedUntil`), one config default change (`expiryNudgeMin` 60→180) with `expiringUnused` moved to picker.ts and restricted to weekly gauges.

**Tech Stack:** Bun + TypeScript, `bun test`. Spec: `docs/superpowers/specs/2026-07-14-expiry-burn-prompt-design.md` (read it first).

---

## ⚠️ CRITICAL: work in a worktree

`~/.bun/bin/ccx → ~/.bun/install/global/node_modules/ccx → THIS REPO'S WORKING TREE`, executed as source by Bruno's statusline (every render) and launchd timers (15min/4h). **Half-written code in the working tree runs live immediately.** All implementation happens in a git worktree; main only moves by merging a green branch (atomic ref update — safe).

## Chunk 1: the whole feature

### Task 0: Worktree setup

- [ ] **Step 0.1:** `git -C ~/claude-projects/ccx worktree add ~/.dev-worktrees/ccx-expiry-hint -b feat/expiry-hint main` — then work exclusively in `~/.dev-worktrees/ccx-expiry-hint`.
- [ ] **Step 0.2:** `cd ~/.dev-worktrees/ccx-expiry-hint && bun test` — Expected: all pass (163 tests). Baseline green.

### Task 1: State field + config default

**Files:**
- Modify: `src/types.ts` (State + Config comment)
- Modify: `src/state.ts` (emptyState + DEFAULT_CONFIG)
- Test: `tests/state.test.ts`

- [ ] **Step 1.1: Write failing tests** — append inside `describe('state persistence')`:

```ts
  test('loadState defaults expiryHintMutedUntil for pre-existing state files', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ activeAccount: null, syncPending: false, accounts: {}, notifier: { lastSeverity: {}, lastNotified: {}, lastNotifiedSeverity: {} } }));
    expect(loadState().expiryHintMutedUntil).toEqual({});
  });
  test('expiryNudgeMin default is 180', () => {
    expect(loadConfig().expiryNudgeMin).toBe(180);
  });
```

- [ ] **Step 1.2:** Run `bun test tests/state.test.ts` — Expected: FAIL (property missing / 60 ≠ 180).
- [ ] **Step 1.3: Implement.** `src/types.ts` — in `interface State` add:

```ts
  expiryHintMutedUntil: Record<string, string>;  // account → gauge resetsAt ISO; declined hints stay muted until the window itself resets
```

and change the `expiryNudgeMin` comment to `// 180 — flag a WEEKLY gauge resetting within this many minutes while unused headroom remains`.
`src/state.ts` — `expiryNudgeMin: 180,` in DEFAULT_CONFIG; add `expiryHintMutedUntil: {},` to the object returned by `emptyState()`. (`loadState`'s `{ ...emptyState(), ...raw }` spread migrates old files automatically — absent key keeps `{}`.)
- [ ] **Step 1.4:** `bun test` — Expected: state tests PASS. If other suites reference `State` literals without the new field, add `expiryHintMutedUntil: {}` there (TypeScript will point at them).
- [ ] **Step 1.5:** `git add -A && git commit -m "feat: expiryHintMutedUntil state + expiryNudgeMin 180 default"`

### Task 2: Move `expiringUnused` to picker.ts, weekly-only

**Files:**
- Modify: `src/picker.ts` (add function), `src/statusline.ts` (remove + import), `src/status.ts` (import from picker)
- Test: `tests/picker.test.ts`, `tests/statusline.test.ts`

- [ ] **Step 2.1: Write failing tests** in `tests/picker.test.ts` (uses existing `g()`/`NOW` helpers; import `expiringUnused` from `../src/picker`):

```ts
describe('expiringUnused', () => {
  test('weekly gauge within horizon with enough unused flags', () => {
    expect(expiringUnused(g('weekly_all', 60, { resetsAt: '2026-07-03T20:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(true);
  });
  test('session gauges never flag, even in-horizon with unused quota', () => {
    expect(expiringUnused(g('session', 10, { resetsAt: '2026-07-03T19:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
  test('beyond horizon does not flag', () => {
    expect(expiringUnused(g('weekly_all', 60, { resetsAt: '2026-07-03T22:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
  test('too little unused does not flag', () => {
    expect(expiringUnused(g('weekly_all', 80, { resetsAt: '2026-07-03T20:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
  test('past reset or unstarted window does not flag', () => {
    expect(expiringUnused(g('weekly_all', 10, { resetsAt: '2026-07-03T17:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
    expect(expiringUnused(g('weekly_all', 10, { resetsAt: null }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2.2:** `bun test tests/picker.test.ts` — Expected: FAIL (no export).
- [ ] **Step 2.3: Implement.** In `src/picker.ts` add `import { resetEpoch } from './snapshots';` (no cycle: snapshots imports only types) and:

```ts
/** Weekly quota is use-it-or-lose-it: flag a WEEKLY gauge whose reset is imminent
 *  while plenty is unused. Session gauges never qualify — at the 180min horizon a
 *  5h window spends 60% of its life "expiring", and 5h quota recycles ~34×/week. */
export function expiringUnused(gauge: Gauge, cfg: Config, now: Date): boolean {
  if (gauge.kind === 'session') return false;
  const msLeft = resetEpoch(gauge) - now.getTime();
  return msLeft > 0 && msLeft <= cfg.expiryNudgeMin * 60_000 && 100 - gauge.percent >= cfg.expiryNudgeUnusedPct;
}
```

Delete the old `expiringUnused` from `src/statusline.ts` and add `expiringUnused` to its existing `import { isStale } from './picker'`. In `src/status.ts` change the `expiringUnused` import from `'./statusline'` to `'./picker'` (keep `fmtEta` from statusline). In `tests/statusline.test.ts:2` the `expiringUnused` import also moves from `'../src/statusline'` to `'../src/picker'` (it's used around line 176) — without this the test file fails at load time.
- [ ] **Step 2.4:** `bun test` — Expected: picker tests PASS. Any statusline.test.ts tests asserting 🔥 on session gauges now express dead behavior — move their weekly equivalents if missing and update session-gauge expectations to no-🔥 (spec: intended, not a regression; same for `ccx status`).
- [ ] **Step 2.5:** `git add -A && git commit -m "feat: expiringUnused → picker.ts, weekly gauges only"`

### Task 3: `expiryHint` pure function

**Files:**
- Modify: `src/picker.ts`
- Test: `tests/picker.test.ts`

- [ ] **Step 3.1: Write failing tests** (helpers: `g()`, `snap()`, `NOW`; `IN2H = '2026-07-03T20:00:00Z'`, `IN1H = '2026-07-03T19:00:00Z'`):

```ts
describe('expiryHint', () => {
  const NONE: Record<string, string> = {};
  const fresh = { name: 'fresh', snapshot: snap([g('session', 5), g('weekly_all', 0)]) };
  const expiring = (name: string, resetsAt = IN2H, pct = 60) =>
    ({ name, snapshot: snap([g('session', 10), g('weekly_all', 10), g('weekly_scoped', pct, { scopeModel: 'Fable', resetsAt })]) });

  test('fires for a non-picked account with expiring unused weekly quota', () => {
    const h = expiryHint([fresh, expiring('m')], 'fresh', 'claude-fable-5[1m]', NONE, DEFAULT_CONFIG, NOW);
    expect(h).toEqual({ name: 'm', gauge: expect.objectContaining({ kind: 'weekly_scoped' }) });
  });
  test('silent when the picked account is the expiring one', () => {
    expect(expiryHint([fresh, expiring('m')], 'm', 'claude-fable-5[1m]', NONE, DEFAULT_CONFIG, NOW)).toBeNull();
  });
  test('silent when the picked account ALSO has expiring unused quota (no churn)', () => {
    expect(expiryHint([expiring('a'), expiring('b', IN1H)], 'a', 'claude-fable-5[1m]', NONE, DEFAULT_CONFIG, NOW)).toBeNull();
  });
  test('scoped gauge does not hint a non-matching model', () => {
    expect(expiryHint([fresh, expiring('m')], 'fresh', 'claude-opus-4-8', NONE, DEFAULT_CONFIG, NOW)).toBeNull();
  });
  test('unknown model hints conservatively', () => {
    expect(expiryHint([fresh, expiring('m')], 'fresh', undefined, NONE, DEFAULT_CONFIG, NOW)?.name).toBe('m');
  });
  test('usability floor: an account with any applicable gauge ≥ criticalPct is not suggested', () => {
    const walled = { name: 'w', snapshot: snap([g('session', 95), g('weekly_scoped', 60, { scopeModel: 'Fable', resetsAt: IN2H })]) };
    expect(expiryHint([fresh, walled], 'fresh', 'claude-fable-5[1m]', NONE, DEFAULT_CONFIG, NOW)).toBeNull();
  });
  test('soonest reset wins among multiple qualifying accounts', () => {
    expect(expiryHint([fresh, expiring('late'), expiring('soon', IN1H)], 'fresh', undefined, NONE, DEFAULT_CONFIG, NOW)?.name).toBe('soon');
  });
  test('copy gauge is the qualifying one with most unused points', () => {
    const two = { name: 'm', snapshot: snap([g('weekly_all', 70, { resetsAt: IN2H }), g('weekly_scoped', 40, { scopeModel: 'Fable', resetsAt: IN2H })]) };
    expect(expiryHint([fresh, two], 'fresh', 'claude-fable-5[1m]', NONE, DEFAULT_CONFIG, NOW)?.gauge.percent).toBe(40);
  });
  test('mute suppresses until the window resets, then expires; falls to next account', () => {
    const muted = { m: IN2H };
    expect(expiryHint([fresh, expiring('m')], 'fresh', undefined, muted, DEFAULT_CONFIG, NOW)).toBeNull();
    expect(expiryHint([fresh, expiring('m')], 'fresh', undefined, { m: '2026-07-03T17:00:00Z' }, DEFAULT_CONFIG, NOW)?.name).toBe('m');
    expect(expiryHint([fresh, expiring('m', IN1H), expiring('n')], 'fresh', undefined, { m: IN1H }, DEFAULT_CONFIG, NOW)?.name).toBe('n');
  });
  test('needsLogin and snapshot-less accounts are skipped', () => {
    expect(expiryHint([fresh, { ...expiring('m'), needsLogin: true }, { name: 'x' }], 'fresh', undefined, NONE, DEFAULT_CONFIG, NOW)).toBeNull();
  });
});
```

- [ ] **Step 3.2:** `bun test tests/picker.test.ts` — Expected: FAIL (no export).
- [ ] **Step 3.3: Implement** in `src/picker.ts` (import `Snapshot` already there; add `Gauge` to type imports if absent):

```ts
export interface ExpiryHint { name: string; gauge: Gauge; }

/** Advisory launch hint: a non-picked account whose applicable WEEKLY gauge resets
 *  soon with meaningful unused headroom. Never fires when the picked account is
 *  itself burning expiring quota, for muted accounts (declined earlier this window),
 *  or for accounts already at the critical wall (mirrors assessFailover's minUsable). */
export function expiryHint(
  cands: Candidate[],
  pickedName: string,
  model: string | undefined,
  mutedUntil: Record<string, string>,
  cfg: Config,
  now: Date,
): ExpiryHint | null {
  const expiring = (s: Snapshot): Gauge[] =>
    s.gauges.filter((gauge) => gaugeApplies(gauge, model) && expiringUnused(gauge, cfg, now));
  const picked = cands.find((c) => c.name === pickedName);
  if (picked?.snapshot && expiring(picked.snapshot).length > 0) return null;
  const qualifying = cands
    .filter((c) => c.name !== pickedName && !c.needsLogin && c.snapshot)
    .filter((c) => !(mutedUntil[c.name] && now.getTime() < Date.parse(mutedUntil[c.name])))
    .filter((c) => effectiveHeadroom(c.snapshot!, model) > 100 - cfg.criticalPct)
    .map((c) => ({ name: c.name, gauges: expiring(c.snapshot!) }))
    .filter((q) => q.gauges.length > 0)
    .sort((a, b) => Math.min(...a.gauges.map(resetEpoch)) - Math.min(...b.gauges.map(resetEpoch)));
  if (qualifying.length === 0) return null;
  const { name, gauges } = qualifying[0];
  return { name, gauge: [...gauges].sort((a, b) => a.percent - b.percent)[0] };
}
```

- [ ] **Step 3.4:** `bun test tests/picker.test.ts` — Expected: PASS (all).
- [ ] **Step 3.5:** `git add -A && git commit -m "feat: expiryHint — advisory use-it-or-lose-it detection"`

### Task 4: Launcher integration

**Files:**
- Modify: `src/launcher.ts`
- Test: `tests/launcher.test.ts`

- [ ] **Step 4.1: Write failing tests** (uses `fakeDeps` from `tests/fakes.ts`; build state with two accounts and snapshots as in picker tests — import `g`-style helpers or inline gauges):

```ts
import { fakeDeps } from './fakes';
import { fmtExpiryHint, resolveExpiryHint } from '../src/launcher';
// helper: deps with 'fresh' picked and 'm' expiring (weekly_scoped Fable 60%, resets 2026-07-03T20:00:00Z)

describe('resolveExpiryHint', () => {
  const gauge = (kind: 'session' | 'weekly_all' | 'weekly_scoped', percent: number, resetsAt: string | null, scopeModel: string | null = null) =>
    ({ kind, percent, severity: 'normal' as const, resetsAt, scopeModel, isActive: false });
  const mkDeps = () => {
    const d = fakeDeps();
    d.state.accounts.fresh = { accountUuid: 'u1', email: 'f@x', snapshot: { fetchedAt: d.now().toISOString(), source: 'poll', gauges: [gauge('weekly_all', 0, '2026-07-10T18:00:00Z')] } };
    d.state.accounts.m = { accountUuid: 'u2', email: 'm@x', snapshot: { fetchedAt: d.now().toISOString(), source: 'poll', gauges: [gauge('weekly_scoped', 60, '2026-07-03T20:00:00Z', 'Fable')] } };
    return d;
  };

  test('accept redirects the launch to the hint account', async () => {
    expect(await resolveExpiryHint(mkDeps(), 'fresh', 'claude-fable-5[1m]', [], true, async () => true)).toBe('m');
  });
  test('decline keeps the pick and mutes until the window resets', async () => {
    const d = mkDeps();
    let saved = false;
    d.saveState = () => { saved = true; };
    expect(await resolveExpiryHint(d, 'fresh', 'claude-fable-5[1m]', [], true, async () => false)).toBe('fresh');
    expect(d.state.expiryHintMutedUntil.m).toBe('2026-07-03T20:00:00Z');
    expect(saved).toBe(true);
  });
  test('non-TTY never prompts and never mutes', async () => {
    const d = mkDeps();
    let asked = false;
    expect(await resolveExpiryHint(d, 'fresh', 'claude-fable-5[1m]', [], false, async () => { asked = true; return false; })).toBe('fresh');
    expect(asked).toBe(false);
    expect(d.state.expiryHintMutedUntil.m).toBeUndefined();
  });
  test('-p / --print suppress the prompt even on a TTY', async () => {
    let asked = false;
    const ask = async () => { asked = true; return false; };
    expect(await resolveExpiryHint(mkDeps(), 'fresh', 'claude-fable-5[1m]', ['-p', 'hi'], true, ask)).toBe('fresh');
    expect(await resolveExpiryHint(mkDeps(), 'fresh', 'claude-fable-5[1m]', ['--print'], true, ask)).toBe('fresh');
    expect(asked).toBe(false);
  });
  test('no hint → no prompt, pick unchanged', async () => {
    const d = mkDeps();
    d.state.accounts.m!.snapshot!.gauges[0]!.percent = 80; // unused 20 < 25
    let asked = false;
    expect(await resolveExpiryHint(d, 'fresh', 'claude-fable-5[1m]', [], true, async () => { asked = true; return true; })).toBe('fresh');
    expect(asked).toBe(false);
  });
});

describe('fmtExpiryHint', () => {
  test('renders account, unused %, scope label and countdown', () => {
    const hint = { name: 'm', gauge: { kind: 'weekly_scoped' as const, percent: 60, severity: 'normal' as const, resetsAt: '2026-07-03T20:00:00Z', scopeModel: 'Fable', isActive: false } };
    expect(fmtExpiryHint(hint, new Date('2026-07-03T18:00:00Z'))).toBe('m has 40% of Fable quota expiring in 2h (use it or lose it)');
  });
});
```

- [ ] **Step 4.2:** `bun test tests/launcher.test.ts` — Expected: FAIL (no exports).
- [ ] **Step 4.3: Implement** in `src/launcher.ts`. Export the existing `askYesNo` (add `export` keyword). Add imports: `expiryHint, type ExpiryHint` from `'./picker'`, `resetEpoch` from `'./snapshots'`, `fmtEta` from `'./statusline'`. Then:

```ts
export function fmtExpiryHint(hint: ExpiryHint, now: Date): string {
  const label = hint.gauge.scopeModel ?? 'weekly';
  const eta = fmtEta(resetEpoch(hint.gauge) - now.getTime());
  return `${hint.name} has ${Math.round(100 - hint.gauge.percent)}% of ${label} quota expiring in ${eta} (use it or lose it)`;
}

/** Advisory only — scoring is untouched; the user redirects with Enter or declines
 *  (mute until that window resets). Returns the account the launch should use.
 *  The TTY branch MUST be decided here: askYesNo's silent non-TTY `false` would
 *  otherwise register as a decline and write a mute (spec scenario 13). */
export async function resolveExpiryHint(
  d: Deps,
  pickedName: string,
  model: string | undefined,
  claudeArgs: string[],
  isTTY: boolean,
  ask: (q: string) => Promise<boolean> = askYesNo,
): Promise<string> {
  const hint = expiryHint(candidates(d.state), pickedName, model, d.state.expiryHintMutedUntil, d.cfg, d.now());
  if (!hint) return pickedName;
  const text = fmtExpiryHint(hint, d.now());
  const interactive = isTTY && !claudeArgs.includes('-p') && !claudeArgs.includes('--print');
  if (!interactive) {
    console.error(`ccx: 🔥 ${text} — grab it: ccx run ${hint.name}`);
    return pickedName;
  }
  console.error(`ccx: 🔥 ${text}`);
  if (await ask('ccx: launch there instead?')) return hint.name;
  if (hint.gauge.resetsAt) {
    d.state.expiryHintMutedUntil[hint.name] = hint.gauge.resetsAt;
    d.saveState(d.state);
  }
  return pickedName;
}
```

Wire into `runLaunch` — replace `const pick = spilloverPick(...)` (launcher.ts:75) with:

```ts
    let pick = spilloverPick(candidates(d.state), d.state.activeAccount, model, d.cfg, d.now());
    const redirect = await resolveExpiryHint(d, pick.name, model, claudeArgs, process.stdin.isTTY === true);
    if (redirect !== pick.name) pick = { ...pick, name: redirect, reason: 'use it or lose it — expiring weekly quota accepted' };
```

Everything downstream (swap-or-pin at :76-90, messages at :97-101) works unchanged, including `prepareRun` failure falling back with the existing stderr notice.
Deliberate omissions from the spec's test list: "mute suppresses non-TTY print" is covered transitively (the print path goes through `expiryHint`, whose mute behavior is tested in Task 3), and "explicit `ccx run` path untouched" holds by construction (`resolveExpiryHint` is wired only into `runLaunch`).

- [ ] **Step 4.4:** `bun test` — Expected: PASS (full suite).
- [ ] **Step 4.5:** `git add -A && git commit -m "feat: use-it-or-lose-it Y/n launch prompt"`

### Task 5: Ship

- [ ] **Step 5.1:** `bun test` in the worktree — Expected: full suite green.
- [ ] **Step 5.2:** Bump `package.json` version 0.1.0 → 0.2.0; add a README feature bullet (one line, under features: launch prompt to burn expiring weekly quota; declining mutes until the window resets). Commit `chore: v0.2.0`.
- [ ] **Step 5.3:** Merge: `git -C ~/claude-projects/ccx merge --ff-only feat/expiry-hint` — atomic; the live statusline picks it up on next render. Then `bun test` once in the main checkout.
- [ ] **Step 5.4:** `git -C ~/claude-projects/ccx worktree remove ~/.dev-worktrees/ccx-expiry-hint && git -C ~/claude-projects/ccx branch -d feat/expiry-hint && git -C ~/claude-projects/ccx push`
- [ ] **Step 5.5:** Live smoke: `ccx status` renders without error; if an account currently has expiring weekly quota, `cc` shows the prompt (report what appeared either way).
