import type { Deps } from './deps';
import { parseTokens, patchTokens, sha256hex } from './creds';
import { LIVE_SERVICE, vaultService } from './keychain';

export type OwnerResult =
  | { kind: 'owned'; name: string; blob: string; liveStale?: true } // blob = the exact bytes this resolution is ABOUT
  | { kind: 'foreign'; uuid: string }
  | { kind: 'unresolved' }
  | { kind: 'empty' };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function writeWithRetry(d: Deps, service: string, value: string): Promise<boolean> {
  try {
    await d.kc.write(service, value);
    return true;
  } catch {
    try {
      await d.kc.write(service, value);
      return true;
    } catch {
      return false;
    }
  }
}

export async function resolveOwner(d: Deps): Promise<OwnerResult> {
  let blob: string | null;
  try {
    blob = await d.kc.read(LIVE_SERVICE);
  } catch {
    return { kind: 'unresolved' };
  }
  if (!blob) return { kind: 'empty' };
  let tokens = parseTokens(blob);
  if (!tokens) return { kind: 'unresolved' };

  const hash = await sha256hex(tokens.refreshToken);
  for (const [name, a] of Object.entries(d.state.accounts)) {
    if (a.refreshTokenHash === hash) return { kind: 'owned', name, blob };
  }

  let liveStale = false;
  let profile = await d.api.fetchProfile(tokens.accessToken);
  if (!profile.ok && profile.status === 401) {
    // live access token expired: refresh the live slot's own pair, then retry identity
    const refreshed = await d.api.refreshTokens(tokens.refreshToken);
    if (refreshed.ok) {
      blob = patchTokens(blob, refreshed.tokens);
      tokens = refreshed.tokens;
      if (!(await writeWithRetry(d, LIVE_SERVICE, blob))) {
        // fresh pair now lives only in `blob` — keep resolving so syncBack can still
        // place it in the owning vault entry; the live slot now holds a CONSUMED pair
        liveStale = true;
        d.state.syncPending = true;
        d.saveState(d.state);
        d.notify('ccx: keychain write failed', 'A refreshed token pair could not be written to the live slot. The fresh tokens are preserved in the vault; log in with `claude` again to restore the live slot.');
      }
      profile = await d.api.fetchProfile(tokens.accessToken);
    }
  }
  if (!profile.ok || !profile.uuid) return { kind: 'unresolved' }; // empty uuid = API wobble, never an identity

  for (const [name, a] of Object.entries(d.state.accounts)) {
    if (a.accountUuid === profile.uuid) return { kind: 'owned', name, blob, ...(liveStale && { liveStale: true }) };
  }
  return { kind: 'foreign', uuid: profile.uuid };
}

export interface SyncResult {
  ok: boolean;
  reason?: string;
  /** exact live-slot bytes this sync resolved and captured (undefined when the slot was empty) */
  observed?: string;
  /** true when the live slot holds a pair WE consumed via refresh but could not overwrite */
  liveStale?: boolean;
}

export async function syncBack(d: Deps): Promise<SyncResult> {
  const owner = await resolveOwner(d);
  if (owner.kind === 'empty') {
    d.state.syncPending = false;
    d.saveState(d.state);
    return { ok: true };
  }
  if (owner.kind === 'foreign') {
    return { ok: false, reason: `live slot holds an unknown account (${owner.uuid}) — run \`ccx import <name>\`` };
  }
  if (owner.kind === 'unresolved') {
    d.state.syncPending = true;
    d.saveState(d.state);
    return { ok: false, reason: 'ownership unresolved (offline?) — sync deferred' };
  }
  // Write the EXACT blob resolveOwner resolved. Re-reading the slot here would attribute
  // whatever a concurrent writer put there to the owner of the OLD contents (TOCTOU → token loss).
  try {
    await d.kc.write(vaultService(owner.name), owner.blob);
  } catch (e) {
    d.state.syncPending = true;
    d.saveState(d.state);
    return { ok: false, reason: `vault write failed for "${owner.name}" — sync deferred: ${errText(e)}` };
  }
  const tokens = parseTokens(owner.blob)!;
  d.state.accounts[owner.name].refreshTokenHash = await sha256hex(tokens.refreshToken);
  d.state.activeAccount = owner.name;
  // Clearing syncPending even in the liveStale case is deliberate: the fresh pair was just
  // captured to the vault. The stale LIVE slot is surfaced via `liveStale` (heals on the
  // next `claude /login`); keeping the flag would wedge activate forever.
  d.state.syncPending = false;
  d.saveState(d.state);
  return { ok: true, observed: owner.blob, liveStale: owner.liveStale === true };
}

export async function activate(d: Deps, name: string): Promise<{ ok: boolean; reason?: string }> {
  const sync = await syncBack(d);
  if (!sync.ok) {
    // GUARD: never clobber a live slot whose rotated tokens aren't captured anywhere.
    return { ok: false, reason: `swap aborted: ${sync.reason}` };
  }
  try {
    const blob = await d.kc.read(vaultService(name));
    if (!blob) return { ok: false, reason: `no vault entry for "${name}" — run \`ccx import ${name}\`` };
    // Shrink the install race to sub-millisecond: the live slot must still hold the exact
    // bytes we just resolved. Exception: liveStale means the slot holds a pair WE already
    // consumed (provably dead), which is safe — and correct — to overwrite.
    if (sync.observed !== undefined && !sync.liveStale) {
      const liveNow = await d.kc.read(LIVE_SERVICE);
      if (liveNow !== sync.observed) {
        return { ok: false, reason: 'live slot changed mid-swap (concurrent claude session?) — nothing was overwritten; run the swap again' };
      }
    }
    await d.kc.write(LIVE_SERVICE, blob);
    const tokens = parseTokens(blob);
    if (tokens && d.state.accounts[name]) {
      d.state.accounts[name].refreshTokenHash = await sha256hex(tokens.refreshToken);
    }
    d.state.activeAccount = name;
    d.saveState(d.state);
    return { ok: true };
  } catch (e) {
    // keychain-first, state-second ordering: on failure the live slot still holds the
    // previous owner's blob and state was already corrected by syncBack — coherent.
    return { ok: false, reason: `keychain failure during swap: ${errText(e)}` };
  }
}

export async function importAccount(d: Deps, name: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
  let blob: string | null;
  try {
    blob = await d.kc.read(LIVE_SERVICE);
  } catch (e) {
    return { ok: false, reason: `keychain read failed: ${errText(e)}` };
  }
  if (!blob) return { ok: false, reason: 'live slot empty — log in with `claude` first' };
  let tokens = parseTokens(blob);
  if (!tokens) return { ok: false, reason: 'live slot credentials unparseable' };

  let liveStale = false;
  let profile = await d.api.fetchProfile(tokens.accessToken);
  if (!profile.ok && profile.status === 401) {
    const refreshed = await d.api.refreshTokens(tokens.refreshToken);
    if (refreshed.ok) {
      blob = patchTokens(blob, refreshed.tokens);
      tokens = refreshed.tokens;
      if (!(await writeWithRetry(d, LIVE_SERVICE, blob))) {
        liveStale = true; // fresh pair is only in `blob`; the vault write below preserves it
        d.notify('ccx: keychain write failed', 'A refreshed token pair could not be written to the live slot. Fix Keychain access, then run `ccx sync`.');
      }
      profile = await d.api.fetchProfile(tokens.accessToken);
    }
  }
  if (!profile.ok || !profile.uuid) {
    return { ok: false, reason: "cannot verify this account's identity via the profile endpoint" };
  }

  // token-loss guard: refuse to overwrite credentials that aren't verifiably THIS account's —
  // whether state binds the name elsewhere, or an unvouched vault Keychain entry exists (state loss)
  const existing = d.state.accounts[name];
  let vaultEntryExists = false;
  try {
    vaultEntryExists = !!(await d.kc.read(vaultService(name)));
  } catch {
    vaultEntryExists = true; // unreadable ≠ absent; stay conservative
  }
  const vouched = existing?.accountUuid === profile.uuid;
  if (!vouched && !opts.force && (vaultEntryExists || !!existing?.accountUuid)) {
    return {
      ok: false,
      reason: `"${name}" already has stored credentials that aren't verifiably this account's; re-run with --force to overwrite`,
    };
  }

  try {
    await d.kc.write(vaultService(name), blob);
  } catch (e) {
    return { ok: false, reason: `vault write failed: ${errText(e)}` };
  }
  d.state.accounts[name] = {
    ...(existing ?? {}),
    accountUuid: profile.uuid,
    email: profile.email,
    refreshTokenHash: await sha256hex(tokens.refreshToken),
    needsLogin: false,
  };
  d.state.activeAccount = name;
  d.state.syncPending = liveStale;
  d.saveState(d.state);
  return { ok: true };
}

export async function refreshParked(d: Deps, name: string): Promise<{ ok: boolean; reason?: string }> {
  const account = d.state.accounts[name];
  if (!account) return { ok: false, reason: `unknown account "${name}"` };
  if (name === d.state.activeAccount) {
    return { ok: false, reason: 'active account tokens are managed by Claude Code' };
  }
  try {
    const blob = await d.kc.read(vaultService(name));
    if (!blob) return { ok: false, reason: `no vault entry for "${name}"` };
    const tokens = parseTokens(blob);
    if (!tokens) return { ok: false, reason: 'vault entry unparseable' };

    // state.activeAccount is a cached opinion; the LIVE SLOT is the real "Claude Code
    // owns this pair" predicate. Refreshing a pair that is also live would rotate it out
    // from under Claude Code, and the next syncBack would clobber the fresh copy.
    let liveBlob: string | null;
    try {
      liveBlob = await d.kc.read(LIVE_SERVICE);
    } catch {
      return { ok: false, reason: 'cannot verify the live slot before refreshing — skipped' };
    }
    const liveTokens = liveBlob ? parseTokens(liveBlob) : null;
    if (liveTokens && liveTokens.refreshToken === tokens.refreshToken) {
      return { ok: false, reason: `"${name}" credentials are currently live — refresh is Claude Code's job` };
    }

    const refreshed = await d.api.refreshTokens(tokens.refreshToken);
    if (!refreshed.ok) {
      if (refreshed.invalidGrant) {
        account.needsLogin = true;
        d.saveState(d.state);
        d.notify('ccx: re-login needed', `Account "${name}" refresh token is dead. Log in with claude, then \`ccx import ${name}\`.`);
        return { ok: false, reason: 'invalid_grant — account needs interactive re-login' };
      }
      return { ok: false, reason: 'token refresh failed (network?)' };
    }
    const patched = patchTokens(blob, refreshed.tokens);
    if (!(await writeWithRetry(d, vaultService(name), patched))) {
      // the rotated pair exists only in memory now and is about to be dropped — this
      // account will need interactive recovery; say so loudly instead of pretending
      account.needsLogin = true;
      d.saveState(d.state);
      d.notify('ccx: keychain write failed', `Account "${name}"'s refreshed tokens could not be saved — it needs a fresh \`claude\` login + \`ccx import ${name}\`.`);
      return { ok: false, reason: 'refreshed pair could not be written to the vault' };
    }
    account.refreshTokenHash = await sha256hex(refreshed.tokens.refreshToken);
    account.needsLogin = false;
    d.saveState(d.state);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `keychain failure: ${errText(e)}` };
  }
}
