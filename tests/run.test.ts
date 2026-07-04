import { describe, expect, test } from 'bun:test';
import { prepareRun, runRefresh, runRun, shouldResume } from '../src/run';
import { vaultService, LIVE_SERVICE } from '../src/keychain';
import { blob, fakeApi, fakeDeps, fakeKeychain } from './fakes';

const NOW = new Date('2026-07-03T18:00:00Z').getTime();
const FRESH = NOW + 8 * 3600_000;   // 8h out — beyond the 6h refresh floor
const STALE = NOW + 3600_000;       // 1h out — inside the refresh floor
const EXPIRED = NOW - 1000;

function depsWith(over: Parameters<typeof fakeDeps>[0] = {}) {
  const d = fakeDeps(over);
  d.state.accounts.bqg = { accountUuid: 'uuid-bqg', email: 'bqg@x.com' };
  d.state.accounts.mei = { accountUuid: 'uuid-mei', email: 'mei@x.com' };
  d.state.activeAccount = 'mei';
  return d;
}

describe('prepareRun', () => {
  test('unknown account is refused with the imported list', async () => {
    const d = depsWith();
    const r = await prepareRun(d, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('bqg');
  });

  test('fresh token: no refresh, identity verified, token returned', async () => {
    const kc = fakeKeychain({ [vaultService('bqg')]: blob('at-bqg', 'rt-bqg', FRESH) });
    const api = fakeApi({ profile: (t) => (t === 'at-bqg' ? { ok: true, uuid: 'uuid-bqg', email: 'bqg@x.com' } : { ok: false, status: 401 }) });
    const d = depsWith({ kc, api });
    const r = await prepareRun(d, 'bqg');
    expect(r).toMatchObject({ ok: true, token: 'at-bqg' });
    expect(api.calls.filter((c) => c.startsWith('refresh:'))).toEqual([]);
  });

  test('expiring token is refreshed through the vault before launch', async () => {
    const kc = fakeKeychain({
      [vaultService('bqg')]: blob('at-old', 'rt-old', STALE),
      [LIVE_SERVICE]: blob('at-mei', 'rt-mei', FRESH),
    });
    const api = fakeApi({
      refresh: () => ({ ok: true, tokens: { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: FRESH } }),
      profile: (t) => (t === 'at-new' ? { ok: true, uuid: 'uuid-bqg', email: 'bqg@x.com' } : { ok: false, status: 401 }),
    });
    const d = depsWith({ kc, api });
    const r = await prepareRun(d, 'bqg');
    expect(r).toMatchObject({ ok: true, token: 'at-new' });
    expect(kc.store.get(vaultService('bqg'))).toContain('at-new'); // rotated pair captured
  });

  test('identity mismatch is refused (env token silently falls back — never launch unverified)', async () => {
    const kc = fakeKeychain({ [vaultService('bqg')]: blob('at-bqg', 'rt-bqg', FRESH) });
    const api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-SOMEONE-ELSE', email: 'other@x.com' }) });
    const d = depsWith({ kc, api });
    const r = await prepareRun(d, 'bqg');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('different account');
  });

  test('unverifiable token (offline/401) is refused, not launched', async () => {
    const kc = fakeKeychain({ [vaultService('bqg')]: blob('at-bqg', 'rt-bqg', FRESH) });
    const d = depsWith({ kc }); // default fakeApi: profile → {ok:false,status:0}
    const r = await prepareRun(d, 'bqg');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('refusing to launch');
  });

  test('active account with still-valid token proceeds with a warning instead of refreshing', async () => {
    const kc = fakeKeychain({
      [vaultService('mei')]: blob('at-mei', 'rt-mei', STALE),
      [LIVE_SERVICE]: blob('at-mei', 'rt-mei', STALE),
    });
    const api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-mei', email: 'mei@x.com' }) });
    const d = depsWith({ kc, api });
    const r = await prepareRun(d, 'mei');
    expect(r).toMatchObject({ ok: true, token: 'at-mei' });
    if (r.ok) expect(r.warnings.length).toBe(1);
  });
});

describe('runRun', () => {
  test('spawns claude with the pinned token and skip-permissions applied', async () => {
    const kc = fakeKeychain({ [vaultService('bqg')]: blob('at-bqg', 'rt-bqg', FRESH) });
    const api = fakeApi({ profile: () => ({ ok: true, uuid: 'uuid-bqg', email: 'bqg@x.com' }) });
    const d = depsWith({ kc, api });
    const spawned: { args: string[]; token: string }[] = [];
    const code = await runRun(d, ['bqg', '-p', 'hi'], async (args, token) => { spawned.push({ args, token }); return 0; });
    expect(code).toBe(0);
    expect(spawned).toEqual([{ args: ['-p', 'hi', '--dangerously-skip-permissions'], token: 'at-bqg' }]);
  });

  test('missing account name is a usage error', async () => {
    const d = depsWith();
    expect(await runRun(d, [], async () => 0)).toBe(1);
  });
});

describe('runRefresh', () => {
  test('refreshes expiring parked accounts, skips fresh ones and the live account', async () => {
    const kc = fakeKeychain({
      [vaultService('bqg')]: blob('at-bqg', 'rt-bqg', EXPIRED),
      [vaultService('pqg')]: blob('at-pqg', 'rt-pqg', FRESH),
      [vaultService('mei')]: blob('at-mei', 'rt-mei', EXPIRED),
      [LIVE_SERVICE]: blob('at-mei', 'rt-mei', EXPIRED),
    });
    const api = fakeApi({
      refresh: (rt) => ({ ok: true, tokens: { accessToken: `new-${rt}`, refreshToken: `nrt-${rt}`, expiresAt: FRESH } }),
    });
    const d = depsWith({ kc, api });
    d.state.accounts.pqg = { accountUuid: 'uuid-pqg', email: 'pqg@x.com' };
    const code = await runRefresh(d);
    expect(code).toBe(0);
    expect(api.calls).toContain('refresh:rt-bqg');            // expired + parked → refreshed
    expect(api.calls).not.toContain('refresh:rt-pqg');        // fresh → skipped
    expect(api.calls).not.toContain('refresh:rt-mei');        // live → Claude Code's job
  });
});

describe('shouldResume', () => {
  const t0 = NOW;
  test('resumes when the session outlived its token (interactive)', () => {
    expect(shouldResume(new Date(t0), t0 - 1, ['some-arg'], true)).toBe(true);
  });
  test('does not resume while the token is still valid (user exited on purpose)', () => {
    expect(shouldResume(new Date(t0), t0 + 3600_000, [], true)).toBe(false);
  });
  test('never resumes print-mode one-shots', () => {
    expect(shouldResume(new Date(t0), t0 - 1, ['-p', 'hi'], true)).toBe(false);
    expect(shouldResume(new Date(t0), t0 - 1, ['--print'], true)).toBe(false);
  });
  test('never resumes without a TTY', () => {
    expect(shouldResume(new Date(t0), t0 - 1, [], false)).toBe(false);
  });
});

describe('runRun auto-resume', () => {
  test('relaunches with --continue on a fresh token after an auth-death exit', async () => {
    let clock = NOW;
    const kc = fakeKeychain({ [vaultService('bqg')]: blob('at-1', 'rt-1', NOW + 7 * 3600_000) });
    const api = fakeApi({
      refresh: (rt) => ({ ok: true, tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: clock + 8 * 3600_000 } }),
      profile: (t) => ({ ok: true, uuid: 'uuid-bqg', email: 'bqg@x.com' }),
    });
    const d = depsWith({ kc, api, now: () => new Date(clock) });
    const spawned: { args: string[]; token: string }[] = [];
    const code = await runRun(d, ['bqg'], async (args, token) => {
      spawned.push({ args, token });
      if (spawned.length === 1) { clock += 8 * 3600_000; return 1; } // session outlives token → auth death
      return 0; // resumed session exits normally while token still valid
    }, () => true);
    expect(code).toBe(0);
    expect(spawned.length).toBe(2);
    expect(spawned[0].token).toBe('at-1');
    expect(spawned[1].token).toBe('at-2');                       // resumed on the REFRESHED token
    expect(spawned[1].args).toContain('--continue');
  });
});
