import { describe, expect, test } from 'bun:test';
import { escapeSecurityArg, realKeychain } from '../src/keychain';

describe('escapeSecurityArg', () => {
  test('wraps in double quotes', () => {
    expect(escapeSecurityArg('abc')).toBe('"abc"');
  });
  test('escapes double quotes and backslashes (JSON blob survives)', () => {
    const blob = '{"claudeAiOauth":{"accessToken":"sk-ant\\"x"}}';
    expect(escapeSecurityArg(blob)).toBe('"{\\"claudeAiOauth\\":{\\"accessToken\\":\\"sk-ant\\\\\\"x\\"}}"');
  });
  test('rejects newlines (would break the one-command-per-line protocol)', () => {
    expect(() => escapeSecurityArg('a\nb')).toThrow();
  });
  test('rejects carriage returns, control chars, and non-ASCII (hex-mangled by security)', () => {
    expect(() => escapeSecurityArg('a\rb')).toThrow();
    expect(() => escapeSecurityArg('a\tb')).toThrow();
    expect(() => escapeSecurityArg('café')).toThrow();
  });
  test('write refuses oversized values before spawning (truncated writes destroy items)', async () => {
    const kc = realKeychain('testuser');
    await expect(kc.write('ccx-test-never-created', 'z'.repeat(5000))).rejects.toThrow(/4095/);
  });
  test('realKeychain throws when user is empty', () => {
    expect(() => realKeychain('')).toThrow();
  });
});
