import type { Config, Gauge } from './types';
import type { OauthTokens } from './creds';
import { parseUsageResponse } from './snapshots';

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

export type UsageResult = { ok: true; gauges: Gauge[] } | { ok: false; status: number };
export type ProfileResult = { ok: true; uuid: string; email: string } | { ok: false; status: number };
export type RefreshResult = { ok: true; tokens: OauthTokens } | { ok: false; invalidGrant: boolean };

export interface Api {
  fetchUsage(token: string): Promise<UsageResult>;
  fetchProfile(token: string): Promise<ProfileResult>;
  refreshTokens(refreshToken: string): Promise<RefreshResult>;
}

export function realApi(cfg: Config, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): Api {
  const authHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': `claude-code/${cfg.claudeCodeUaVersion}`,
    'Content-Type': 'application/json',
  });
  return {
    async fetchUsage(token) {
      try {
        const r = await fetchFn(USAGE_URL, { headers: authHeaders(token), signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return { ok: false, status: r.status };
        return { ok: true, gauges: parseUsageResponse(await r.json()) };
      } catch {
        return { ok: false, status: 0 };
      }
    },
    async fetchProfile(token) {
      try {
        const r = await fetchFn(PROFILE_URL, { headers: authHeaders(token), signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return { ok: false, status: r.status };
        const j: any = await r.json();
        if (typeof j?.account?.uuid !== 'string') return { ok: false, status: 0 };
        return { ok: true, uuid: j.account.uuid, email: j.account.email ?? '' };
      } catch {
        return { ok: false, status: 0 };
      }
    },
    async refreshTokens(refreshToken) {
      try {
        const r = await fetchFn(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
          signal: AbortSignal.timeout(10_000),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, invalidGrant: j?.error === 'invalid_grant' };
        // a 200 without a token (captive portal, proxy error page) must NOT flow into patchTokens —
        // spreading accessToken: undefined would silently corrupt the credential blob
        if (typeof j.access_token !== 'string') return { ok: false, invalidGrant: false };
        return {
          ok: true,
          tokens: {
            accessToken: j.access_token,
            refreshToken: j.refresh_token ?? refreshToken,
            expiresAt: now().getTime() + (j.expires_in ?? 0) * 1000,
          },
        };
      } catch {
        return { ok: false, invalidGrant: false };
      }
    },
  };
}
