import { describe, expect, test } from 'bun:test';
import { otherAccount, targetModelFrom, withPermissionFlag } from '../src/launcher';
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
