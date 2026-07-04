import { describe, expect, test } from 'bun:test';
import { parseTokens, patchTokens, sha256hex } from '../src/creds';

const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-AAA', refreshToken: 'sk-ant-ort-BBB',
    expiresAt: 1783126282930, scopes: ['user:inference'], subscriptionType: 'max',
  },
  mcpOAuth: { someServer: { token: 'keep-me' } },
});

describe('parseTokens', () => {
  test('extracts token triple', () => {
    expect(parseTokens(BLOB)).toEqual({
      accessToken: 'sk-ant-oat-AAA', refreshToken: 'sk-ant-ort-BBB', expiresAt: 1783126282930,
    });
  });
  test('returns null for garbage or missing fields', () => {
    expect(parseTokens('not json')).toBeNull();
    expect(parseTokens('{"claudeAiOauth":{}}')).toBeNull();
  });
});

describe('patchTokens', () => {
  test('updates tokens, preserves every other key including mcpOAuth', () => {
    const out = JSON.parse(patchTokens(BLOB, {
      accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 42,
    }));
    expect(out.claudeAiOauth.accessToken).toBe('new-at');
    expect(out.claudeAiOauth.expiresAt).toBe(42);
    expect(out.claudeAiOauth.subscriptionType).toBe('max');
    expect(out.claudeAiOauth.scopes).toEqual(['user:inference']);
    expect(out.mcpOAuth.someServer.token).toBe('keep-me');
  });
});

describe('patchTokens edge shapes', () => {
  test('throws on non-object blobs instead of silently dropping the update', () => {
    const t = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 };
    expect(() => patchTokens('[]', t)).toThrow();
    expect(() => patchTokens('null', t)).toThrow();
  });
});

describe('sha256hex', () => {
  test('matches known digest', async () => {
    expect(await sha256hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
