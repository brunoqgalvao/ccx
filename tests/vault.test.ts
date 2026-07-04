import { describe, expect, test } from 'bun:test';
import { sha256hex } from '../src/creds';
import { LIVE_SERVICE, vaultService } from '../src/keychain';
import { activate, importAccount, refreshParked, resolveOwner, syncBack } from '../src/vault';
import { blob, fakeApi, fakeDeps, fakeKeychain, failingWriteKeychain, mutatingReadKeychain } from './fakes';

async function depsWithAccounts() {
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

describe('resolveOwner', () => {
  test('hash short-circuit: no profile call when nothing rotated', async () => {
    const { d } = await depsWithAccounts();
    const api = fakeApi();
    d.api = api;
    expect(await resolveOwner(d)).toEqual({ kind: 'owned', name: 'personal', blob: blob('at-p', 'rt-p') });
    expect(api.calls).toHaveLength(0);
  });
  test('hash miss resolves via profile uuid', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-p2', 'rt-p2')); // rotated out-of-band
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-p', email: 'p@x' }) });
    expect(await resolveOwner(d)).toEqual({ kind: 'owned', name: 'personal', blob: blob('at-p2', 'rt-p2') });
  });
  test('401 on profile → refresh live pair in place, then resolve', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('expired', 'rt-p2'));
    d.api = fakeApi({
      profile: (t) => (t === 'fresh' ? { ok: true, uuid: 'uuid-p', email: 'p@x' } : { ok: false, status: 401 }),
      refresh: () => ({ ok: true, tokens: { accessToken: 'fresh', refreshToken: 'rt-p3', expiresAt: 1 } }),
    });
    expect(await resolveOwner(d)).toEqual({ kind: 'owned', name: 'personal', blob: blob('fresh', 'rt-p3', 1) });
    expect(JSON.parse(kc.store.get(LIVE_SERVICE)!).claudeAiOauth.refreshToken).toBe('rt-p3');
  });
  test('unknown uuid → foreign', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-x', 'rt-x'));
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-stranger', email: 's@x' }) });
    expect(await resolveOwner(d)).toEqual({ kind: 'foreign', uuid: 'uuid-stranger' });
  });
  test('offline → unresolved', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-x', 'rt-x'));
    expect(await resolveOwner(d)).toEqual({ kind: 'unresolved' });
  });
  test('empty live slot → empty', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.delete(LIVE_SERVICE);
    expect(await resolveOwner(d)).toEqual({ kind: 'empty' });
  });
});

describe('syncBack', () => {
  test('captures rotated live tokens into the owning vault entry and updates hash', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-p2', 'rt-p2'));
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-p', email: 'p@x' }) });
    expect((await syncBack(d)).ok).toBe(true);
    expect(kc.store.get(vaultService('personal'))).toBe(blob('at-p2', 'rt-p2'));
    expect(d.state.accounts.personal.refreshTokenHash).toBe(await sha256hex('rt-p2'));
    expect(d.state.syncPending).toBe(false);
  });
  test('unresolved sets sync_pending and does NOT touch vault entries', async () => {
    const { d, kc } = await depsWithAccounts();
    const before = kc.store.get(vaultService('personal'));
    kc.store.set(LIVE_SERVICE, blob('at-p2', 'rt-p2')); // offline: fakeApi default fails
    expect((await syncBack(d)).ok).toBe(false);
    expect(d.state.syncPending).toBe(true);
    expect(kc.store.get(vaultService('personal'))).toBe(before);
  });
});

describe('activate', () => {
  test('syncs back, then installs target vault blob as live and flips active', async () => {
    const { d, kc } = await depsWithAccounts();
    expect((await activate(d, 'work')).ok).toBe(true);
    expect(kc.store.get(LIVE_SERVICE)).toBe(blob('at-w', 'rt-w'));
    expect(d.state.activeAccount).toBe('work');
  });
  test('GUARD: aborts and leaves live slot intact when sync is unresolved', async () => {
    const { d, kc } = await depsWithAccounts();
    const rotated = blob('at-p2', 'rt-p2');
    kc.store.set(LIVE_SERVICE, rotated); // rotated + offline → unresolvable
    const r = await activate(d, 'work');
    expect(r.ok).toBe(false);
    expect(kc.store.get(LIVE_SERVICE)).toBe(rotated); // NOT clobbered
    expect(d.state.activeAccount).toBe('personal');
  });
  test('fails cleanly when target vault entry is missing', async () => {
    const { d } = await depsWithAccounts();
    expect((await activate(d, 'nope')).ok).toBe(false);
  });
});

describe('importAccount', () => {
  test('captures live slot, records uuid/email/hash, sets active', async () => {
    const kc = fakeKeychain({ [LIVE_SERVICE]: blob('at-n', 'rt-n') });
    const d = fakeDeps({ kc, api: fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-n', email: 'n@x' }) }) });
    expect((await importAccount(d, 'newacct')).ok).toBe(true);
    expect(kc.store.get(vaultService('newacct'))).toBe(blob('at-n', 'rt-n'));
    expect(d.state.accounts.newacct).toMatchObject({ accountUuid: 'uuid-n', email: 'n@x' });
    expect(d.state.activeAccount).toBe('newacct');
  });
  test('fails when live slot is empty', async () => {
    const d = fakeDeps();
    expect((await importAccount(d, 'x')).ok).toBe(false);
  });
  test('refuses to overwrite a name bound to a DIFFERENT account unless forced (token-loss guard)', async () => {
    const { d } = await depsWithAccounts(); // live slot holds personal (uuid-p)
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-p', email: 'p@x' }) });
    expect((await importAccount(d, 'work')).ok).toBe(false);
    expect((await importAccount(d, 'work', { force: true })).ok).toBe(true);
  });
});

describe('refreshParked', () => {
  test('refuses to refresh the ACTIVE account (Claude Code owns that pair)', async () => {
    const { d } = await depsWithAccounts();
    expect((await refreshParked(d, 'personal')).ok).toBe(false);
  });
  test('rotates parked vault tokens and hash', async () => {
    const { d, kc } = await depsWithAccounts();
    d.api = fakeApi({ refresh: () => ({ ok: true, tokens: { accessToken: 'at-w2', refreshToken: 'rt-w2', expiresAt: 5 } }) });
    expect((await refreshParked(d, 'work')).ok).toBe(true);
    const stored = JSON.parse(kc.store.get(vaultService('work'))!);
    expect(stored.claudeAiOauth.accessToken).toBe('at-w2');
    expect(d.state.accounts.work.refreshTokenHash).toBe(await sha256hex('rt-w2'));
  });
  test('invalid_grant marks needsLogin and notifies', async () => {
    const { d } = await depsWithAccounts();
    d.api = fakeApi({ refresh: () => ({ ok: false, invalidGrant: true }) });
    const r = await refreshParked(d, 'work');
    expect(r.ok).toBe(false);
    expect(d.state.accounts.work.needsLogin).toBe(true);
    expect((d as any).notifications.length).toBe(1);
  });
});

describe('adversarial: token-non-loss', () => {
  test('TOCTOU: live slot swapped mid-resolution never contaminates the resolved owner vault entry', async () => {
    const { d, kc } = await depsWithAccounts();
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-p', email: 'p@x' }) });
    // resolveOwner's single read sees personal's rotated blob; every later read sees work's
    d.kc = mutatingReadKeychain(kc, LIVE_SERVICE, [blob('at-p2', 'rt-p2')]);
    kc.store.set(LIVE_SERVICE, blob('at-w9', 'rt-w9'));
    expect((await syncBack(d)).ok).toBe(true);
    expect(kc.store.get(vaultService('personal'))).toBe(blob('at-p2', 'rt-p2'));
  });
  test('stale activeAccount cannot rotate the live pair (live-slot predicate)', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-w', 'rt-w')); // work is REALLY live...
    d.state.activeAccount = 'personal';               // ...but state is stale
    const api = fakeApi({ refresh: () => ({ ok: true, tokens: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } }) });
    d.api = api;
    expect((await refreshParked(d, 'work')).ok).toBe(false);
    expect(api.calls.filter((c) => c.startsWith('refresh:'))).toHaveLength(0); // pair never consumed
  });
  test('empty-uuid profile responses are never treated as an identity', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-x', 'rt-x'));
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: '', email: '' }) });
    expect(await resolveOwner(d)).toEqual({ kind: 'unresolved' });
  });
  test('import refuses to clobber an unvouched vault entry after state loss', async () => {
    const { d, kc } = await depsWithAccounts();
    delete d.state.accounts.work; // state.json rebuilt; the Keychain entry survived
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-p', email: 'p@x' }) });
    expect((await importAccount(d, 'work')).ok).toBe(false);
    expect(kc.store.get(vaultService('work'))).toBe(blob('at-w', 'rt-w')); // untouched
  });
  test('vault write failure during syncBack defers with syncPending instead of throwing', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('at-p2', 'rt-p2'));
    d.api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-p', email: 'p@x' }) });
    d.kc = failingWriteKeychain(kc, (s) => s === vaultService('personal'));
    const r = await syncBack(d);
    expect(r.ok).toBe(false);
    expect(d.state.syncPending).toBe(true);
  });
  test('refreshParked on an unknown account fails cleanly, not with a TypeError', async () => {
    const { d } = await depsWithAccounts();
    expect((await refreshParked(d, 'ghost')).ok).toBe(false);
  });
  test('activate aborts when the live slot changes between sync and install', async () => {
    const { d, kc } = await depsWithAccounts();
    // resolveOwner's read sees personal; the pre-install re-read sees an interloper
    d.kc = mutatingReadKeychain(kc, LIVE_SERVICE, [blob('at-p', 'rt-p'), blob('at-p9', 'rt-p9')]);
    const r = await activate(d, 'work');
    expect(r.ok).toBe(false);
    expect(kc.store.get(LIVE_SERVICE)).toBe(blob('at-p', 'rt-p')); // never clobbered by the install
  });
  test('failed live write-back still recovers the fresh pair and allows the swap (liveStale)', async () => {
    const { d, kc } = await depsWithAccounts();
    kc.store.set(LIVE_SERVICE, blob('expired', 'rt-p2'));
    d.api = fakeApi({
      profile: (t) => (t === 'fresh' ? { ok: true, uuid: 'uuid-p', email: 'p@x' } : { ok: false, status: 401 }),
      refresh: () => ({ ok: true, tokens: { accessToken: 'fresh', refreshToken: 'rt-p3', expiresAt: 1 } }),
    });
    let failures = 2; // both writeWithRetry attempts on the live slot fail, then writes recover
    d.kc = failingWriteKeychain(kc, (s) => s === LIVE_SERVICE && failures-- > 0);
    const r = await activate(d, 'work');
    expect(r.ok).toBe(true);
    expect(kc.store.get(vaultService('personal'))).toBe(blob('fresh', 'rt-p3', 1)); // fresh pair preserved
    expect(kc.store.get(LIVE_SERVICE)).toBe(blob('at-w', 'rt-w'));                  // swap completed
  });
});
