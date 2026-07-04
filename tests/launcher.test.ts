import { describe, expect, test } from 'bun:test';
import { otherAccount, targetModelFrom } from '../src/launcher';
import { emptyState } from '../src/state';

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
