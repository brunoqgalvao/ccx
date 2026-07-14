import { describe, expect, test } from 'bun:test';
import { fakeDeps } from './fakes';
import { fmtExpiryHint, otherAccount, resolveExpiryHint, targetModelFrom, withPermissionFlag } from '../src/launcher';
import { DEFAULT_CONFIG, emptyState } from '../src/state';

describe('targetModelFrom', () => {
  test('--model flag wins', () => {
    expect(targetModelFrom(['--model', 'opus', '-p', 'hi'], 'claude-fable-5[1m]')).toBe('opus');
  });
  test('--model=x form is recognized', () => {
    expect(targetModelFrom(['--model=opus'], 'claude-fable-5[1m]')).toBe('opus');
  });
  test('falls back to settings model', () => {
    expect(targetModelFrom(['-p', 'hi'], 'claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
  });
  test('undefined when neither present', () => {
    expect(targetModelFrom([], undefined)).toBeUndefined();
  });
});

describe('otherAccount', () => {
  test('returns the non-active account in a two-account setup', () => {
    const s = emptyState();
    s.activeAccount = 'personal';
    s.accounts.personal = { accountUuid: 'a', email: 'x' };
    s.accounts.work = { accountUuid: 'b', email: 'y' };
    expect(otherAccount(s)).toBe('work');
  });
  test('null when fewer than two accounts', () => {
    const s = emptyState();
    s.accounts.only = { accountUuid: 'a', email: 'x' };
    expect(otherAccount(s)).toBeNull();
  });
});

describe('withPermissionFlag', () => {
  const cfg = (skip: boolean) => ({ ...DEFAULT_CONFIG, skipPermissions: skip });
  test('appends --dangerously-skip-permissions by default', () => {
    expect(withPermissionFlag(['-p', 'hi'], cfg(true))).toEqual(['-p', 'hi', '--dangerously-skip-permissions']);
  });
  test('does not duplicate when already passed', () => {
    expect(withPermissionFlag(['--dangerously-skip-permissions'], cfg(true))).toEqual(['--dangerously-skip-permissions']);
  });
  test('leaves args untouched when skipPermissions=false', () => {
    expect(withPermissionFlag(['-p', 'hi'], cfg(false))).toEqual(['-p', 'hi']);
  });
});

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
