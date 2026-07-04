import { describe, expect, test } from 'bun:test';
import { CLIENT_ID, realApi } from '../src/api';
import { DEFAULT_CONFIG } from '../src/state';
import usageFixture from '../fixtures/usage-response.json';

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fn, calls };
}

const NOW = new Date('2026-07-03T18:00:00Z');

describe('fetchUsage', () => {
  test('sends required headers and parses gauges', async () => {
    const { fn, calls } = stubFetch(() => Response.json(usageFixture));
    const api = realApi(DEFAULT_CONFIG, fn, () => NOW);
    const res = await api.fetchUsage('tok-123');
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.gauges).toHaveLength(3);
    const h = new Headers(calls[0].init.headers);
    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(h.get('authorization')).toBe('Bearer tok-123');
    expect(h.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(h.get('user-agent')).toBe(`claude-code/${DEFAULT_CONFIG.claudeCodeUaVersion}`);
  });
  test('propagates 401/429 as non-ok with status', async () => {
    const { fn } = stubFetch(() => new Response('nope', { status: 429 }));
    const res = await realApi(DEFAULT_CONFIG, fn, () => NOW).fetchUsage('t');
    expect(res).toEqual({ ok: false, status: 429 });
  });
  test('network errors become status 0', async () => {
    const fn = (async () => { throw new Error('boom'); }) as unknown as typeof fetch; // double-cast: bun-types' fetch has statics
    const res = await realApi(DEFAULT_CONFIG, fn, () => NOW).fetchUsage('t');
    expect(res).toEqual({ ok: false, status: 0 });
  });
});

describe('fetchProfile', () => {
  test('extracts account uuid and email', async () => {
    const { fn } = stubFetch(() =>
      Response.json({ account: { uuid: 'u-42', email: 'x@y.z' } }));
    const res = await realApi(DEFAULT_CONFIG, fn, () => NOW).fetchProfile('t');
    expect(res).toEqual({ ok: true, uuid: 'u-42', email: 'x@y.z' });
  });
});

describe('refreshTokens', () => {
  test('posts refresh grant with client_id, computes expiresAt from expires_in', async () => {
    const { fn, calls } = stubFetch(() =>
      Response.json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }));
    const res = await realApi(DEFAULT_CONFIG, fn, () => NOW).refreshTokens('rt1');
    expect(res).toEqual({
      ok: true,
      tokens: { accessToken: 'at2', refreshToken: 'rt2', expiresAt: NOW.getTime() + 3_600_000 },
    });
    expect(calls[0].url).toBe('https://console.anthropic.com/v1/oauth/token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt1', client_id: CLIENT_ID });
  });
  test('invalid_grant is distinguished from other failures', async () => {
    const { fn } = stubFetch(() =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const res = await realApi(DEFAULT_CONFIG, fn, () => NOW).refreshTokens('dead');
    expect(res).toEqual({ ok: false, invalidGrant: true });
  });
  test('200 with a token-less or non-JSON body is a failure, not a success', async () => {
    const html = stubFetch(() => new Response('<html>captive portal</html>', { status: 200 }));
    expect(await realApi(DEFAULT_CONFIG, html.fn, () => NOW).refreshTokens('rt')).toEqual({ ok: false, invalidGrant: false });
    const empty = stubFetch(() => Response.json({}));
    expect(await realApi(DEFAULT_CONFIG, empty.fn, () => NOW).refreshTokens('rt')).toEqual({ ok: false, invalidGrant: false });
  });
});
