import type { Api, ProfileResult, RefreshResult, UsageResult } from '../src/api';
import type { Keychain } from '../src/keychain';
import type { Deps } from '../src/deps';
import { DEFAULT_CONFIG } from '../src/state';
import { emptyState } from '../src/state';

export function fakeKeychain(initial: Record<string, string> = {}): Keychain & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async read(service) { return store.get(service) ?? null; },
    async write(service, value) { store.set(service, value); },
    async remove(service) { store.delete(service); },
  };
}

export interface FakeApiScript {
  usage?: (token: string) => UsageResult;
  profile?: (token: string) => ProfileResult;
  refresh?: (refreshToken: string) => RefreshResult;
}

export function fakeApi(script: FakeApiScript = {}): Api & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchUsage(token) { calls.push(`usage:${token}`); return script.usage?.(token) ?? { ok: false, status: 0 }; },
    async fetchProfile(token) { calls.push(`profile:${token}`); return script.profile?.(token) ?? { ok: false, status: 0 }; },
    async refreshTokens(rt) { calls.push(`refresh:${rt}`); return script.refresh?.(rt) ?? { ok: false, invalidGrant: false }; },
  };
}

export function blob(at: string, rt: string, expiresAt = 9_999_999_999_999): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt, subscriptionType: 'max' },
    mcpOAuth: {},
  });
}

export function mutatingReadKeychain(
  inner: Keychain & { store: Map<string, string> },
  service: string,
  firstReads: (string | null)[],
): Keychain & { store: Map<string, string> } {
  let i = 0;
  return {
    store: inner.store,
    async read(s) {
      if (s === service && i < firstReads.length) return firstReads[i++];
      return inner.read(s);
    },
    write: (s, v) => inner.write(s, v),
    remove: (s) => inner.remove(s),
  };
}

export function failingWriteKeychain(
  inner: Keychain & { store: Map<string, string> },
  failFor: (service: string) => boolean,
): Keychain & { store: Map<string, string> } {
  return {
    store: inner.store,
    read: (s) => inner.read(s),
    async write(s, v) {
      if (failFor(s)) throw new Error(`injected write failure for ${s}`);
      return inner.write(s, v);
    },
    remove: (s) => inner.remove(s),
  };
}

export function fakeDeps(over: Partial<Deps> = {}): Deps & { notifications: string[] } {
  const notifications: string[] = [];
  const d = {
    cfg: { ...DEFAULT_CONFIG },
    state: emptyState(),
    saveState: () => {},
    kc: fakeKeychain(),
    api: fakeApi(),
    now: () => new Date('2026-07-03T18:00:00Z'),
    notify: (t: string, m: string) => { notifications.push(`${t}|${m}`); },
    notifications,
    ...over,
  };
  return d as Deps & { notifications: string[] };
}
