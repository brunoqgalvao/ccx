import { describe, expect, test } from 'bun:test';
import { sha256hex } from '../src/creds';
import { LIVE_SERVICE, vaultService } from '../src/keychain';
import usageFixture from '../fixtures/usage-response.json';
import { parseUsageResponse } from '../src/snapshots';
import { pollAccount, refreshAllSnapshots } from '../src/usage';
import { blob, fakeApi, fakeDeps, fakeKeychain } from './fakes';

const NOW = new Date('2026-07-03T18:00:00Z');
const GAUGES = () => parseUsageResponse(usageFixture);
const okUsage = () => ({ ok: true as const, gauges: GAUGES() });

async function twoAccountDeps() {
  const kc = fakeKeychain({
    [LIVE_SERVICE]: blob('at-p', 'rt-p'),
    [vaultService('personal')]: blob('at-p', 'rt-p'),
    [vaultService('work')]: blob('at-w', 'rt-w'),
  });
  const d = fakeDeps({ kc });
  d.state.activeAccount = 'personal';
  d.state.accounts.personal = { accountUuid: 'uuid-p', email: 'p@x', refreshTokenHash: await sha256hex('rt-p') };
  d.state.accounts.work = { accountUuid: 'uuid-w', email: 'w@x', refreshTokenHash: await sha256hex('rt-w') };
  return { d, kc };
}

describe('pollAccount', () => {
  test('active account polls with the LIVE slot token', async () => {
    const { d } = await twoAccountDeps();
    const api = fakeApi({ usage: okUsage });
    d.api = api;
    await pollAccount(d, 'personal');
    expect(api.calls).toContain('usage:at-p');
    expect(d.state.accounts.personal.snapshot?.source).toBe('poll');
    expect(d.state.accounts.personal.snapshot?.gauges).toHaveLength(3);
  });
  test('parked account polls with its VAULT token', async () => {
    const { d } = await twoAccountDeps();
    const api = fakeApi({ usage: okUsage });
    d.api = api;
    await pollAccount(d, 'work');
    expect(api.calls).toContain('usage:at-w');
  });
  test('min interval suppresses re-poll; force bypasses it', async () => {
    const { d } = await twoAccountDeps();
    const api = fakeApi({ usage: okUsage });
    d.api = api;
    await pollAccount(d, 'work');
    await pollAccount(d, 'work');
    expect(api.calls.filter((c) => c.startsWith('usage:')).length).toBe(1);
    await pollAccount(d, 'work', { force: true });
    expect(api.calls.filter((c) => c.startsWith('usage:')).length).toBe(2);
  });
  test('401 on parked poll triggers refreshParked and one retry', async () => {
    const { d } = await twoAccountDeps();
    d.api = fakeApi({
      usage: (t) => (t === 'at-w2' ? okUsage() : { ok: false, status: 401 }),
      refresh: () => ({ ok: true, tokens: { accessToken: 'at-w2', refreshToken: 'rt-w2', expiresAt: 9_999_999_999_999 } }),
    });
    await pollAccount(d, 'work');
    expect(d.state.accounts.work.snapshot?.gauges).toHaveLength(3);
  });
  test('expired parked token refreshes proactively before polling', async () => {
    const { d, kc } = await twoAccountDeps();
    kc.store.set(vaultService('work'), blob('at-w', 'rt-w', 1)); // long expired
    const api = fakeApi({
      usage: (t) => (t === 'at-w2' ? okUsage() : { ok: false, status: 401 }),
      refresh: () => ({ ok: true, tokens: { accessToken: 'at-w2', refreshToken: 'rt-w2', expiresAt: 9_999_999_999_999 } }),
    });
    d.api = api;
    await pollAccount(d, 'work');
    expect(api.calls[0]).toBe('refresh:rt-w');
    expect(d.state.accounts.work.snapshot?.gauges).toHaveLength(3);
  });
  test('429 keeps the stale snapshot and sets lastPoll (backoff via min interval)', async () => {
    const { d } = await twoAccountDeps();
    const old = { fetchedAt: '2026-07-03T12:00:00Z', source: 'poll' as const, gauges: GAUGES() };
    d.state.accounts.work.snapshot = old;
    d.api = fakeApi({ usage: () => ({ ok: false, status: 429 }) });
    await pollAccount(d, 'work');
    expect(d.state.accounts.work.snapshot).toBe(old);
    expect(d.state.accounts.work.lastPoll).toBe(NOW.toISOString());
  });
  test('failed proactive refresh backs off without polling with the dead token', async () => {
    const { d, kc } = await twoAccountDeps();
    kc.store.set(vaultService('work'), blob('at-w', 'rt-w', 1)); // long expired
    const api = fakeApi({ refresh: () => ({ ok: false, invalidGrant: true }) });
    d.api = api;
    await pollAccount(d, 'work');
    expect(api.calls.filter((c) => c.startsWith('usage:'))).toHaveLength(0);
    expect((d as any).notifications).toHaveLength(1); // exactly one needs-login notification
    expect(d.state.accounts.work.lastPoll).toBe(NOW.toISOString()); // backoff pinned even when refresh fails
  });
  test('needsLogin accounts are skipped', async () => {
    const { d } = await twoAccountDeps();
    d.state.accounts.work.needsLogin = true;
    const api = fakeApi({ usage: okUsage });
    d.api = api;
    await pollAccount(d, 'work');
    expect(api.calls).toHaveLength(0);
  });
});

describe('hardened-vault interplay', () => {
  test('lastPoll is PERSISTED before any keychain or network I/O (concurrent-invocation dedup)', async () => {
    const { d, kc } = await twoAccountDeps();
    const events: string[] = [];
    d.saveState = () => { events.push('save'); };
    d.kc = {
      async read(s: string) { events.push('kc:read'); return kc.read(s); },
      write: (s: string, v: string) => kc.write(s, v),
      remove: (s: string) => kc.remove(s),
    };
    d.api = fakeApi({ usage: () => { events.push('api:usage'); return okUsage(); } });
    await pollAccount(d, 'work');
    expect(events[0]).toBe('save'); // the backoff hits disk before any I/O a rival could race
  });
  test('active-account poll falls back to the vault entry when the live slot holds someone else', async () => {
    const { d, kc } = await twoAccountDeps();
    kc.store.set(LIVE_SERVICE, blob('at-w', 'rt-w')); // out-of-band: work is REALLY live
    const api = fakeApi({ usage: okUsage });
    d.api = api; // ...but state still says personal is active
    await pollAccount(d, 'personal');
    expect(api.calls).toContain('usage:at-p');      // personal's own vault token
    expect(api.calls).not.toContain('usage:at-w');  // never attributes work's gauges to personal
  });
  test('keychain read exceptions degrade to backoff instead of breaking the sweep', async () => {
    const { d, kc } = await twoAccountDeps();
    const api = fakeApi({ usage: okUsage });
    d.api = api;
    d.kc = {
      async read(s: string) {
        if (s === LIVE_SERVICE) throw new Error('keychain locked');
        return kc.read(s);
      },
      write: (s: string, v: string) => kc.write(s, v),
      remove: (s: string) => kc.remove(s),
    };
    await refreshAllSnapshots(d);
    expect(d.state.accounts.personal.lastPoll).toBe(NOW.toISOString()); // backoff pinned, no throw
    expect(api.calls).toContain('usage:at-w'); // the sweep still reached the parked account
  });
});

describe('refreshAllSnapshots', () => {
  test('polls every account', async () => {
    const { d } = await twoAccountDeps();
    const api = fakeApi({ usage: okUsage });
    d.api = api;
    await refreshAllSnapshots(d);
    expect(api.calls).toContain('usage:at-p');
    expect(api.calls).toContain('usage:at-w');
  });
});

describe('poll history capture', () => {
  test('successful poll appends a history record for that account', async () => {
    const { d } = await twoAccountDeps();
    d.api = fakeApi({ usage: okUsage });
    await pollAccount(d, 'work');
    expect(d.history).toHaveLength(1);
    expect(d.history[0].account).toBe('work');
    expect(d.history[0].gauges).toHaveLength(3);
  });
  test('failed poll appends nothing', async () => {
    const { d } = await twoAccountDeps();
    d.api = fakeApi({ usage: () => ({ ok: false as const, status: 500 }) });
    await pollAccount(d, 'work');
    expect(d.history).toHaveLength(0);
  });
});
