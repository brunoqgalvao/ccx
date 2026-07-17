import type { Deps } from './deps';
import { parseTokens, sha256hex } from './creds';
import { LIVE_SERVICE, vaultService } from './keychain';
import { refreshParked } from './vault';

const EXPIRY_MARGIN_MS = 60_000;

export async function pollAccount(d: Deps, name: string, opts: { force?: boolean } = {}): Promise<void> {
  const account = d.state.accounts[name];
  if (!account || account.needsLogin) return;

  const last = account.lastPoll ? Date.parse(account.lastPoll) : 0;
  if (!opts.force && d.now().getTime() - last < d.cfg.pollMinIntervalS * 1000) return;

  try {
    // pin the backoff FIRST: dedupes overlapping invocations (statusline fires ~every 300ms
    // across possibly-concurrent sessions) and caps every failure mode at once per interval
    account.lastPoll = d.now().toISOString();
    d.saveState(d.state);

    let isActive = d.state.activeAccount === name;
    if (isActive) {
      // state.activeAccount is a cached opinion (see vault.ts) — verify the live pair really
      // belongs to this account before attributing its gauges to this name; otherwise an
      // out-of-band login would file the OTHER account's usage under this one
      const liveBlob = await d.kc.read(LIVE_SERVICE);
      const liveTokens = liveBlob ? parseTokens(liveBlob) : null;
      const liveHash = liveTokens ? await sha256hex(liveTokens.refreshToken) : null;
      if (!liveHash || (account.refreshTokenHash && liveHash !== account.refreshTokenHash)) {
        isActive = false; // fall back to this account's own vault entry
      }
    }
    const service = isActive ? LIVE_SERVICE : vaultService(name);

    const readTokens = async () => {
      const blob = await d.kc.read(service);
      return blob ? parseTokens(blob) : null;
    };

    let tokens = await readTokens();
    if (!tokens) return;

    if (!isActive && tokens.expiresAt && tokens.expiresAt < d.now().getTime() + EXPIRY_MARGIN_MS) {
      // backoff is already pinned; bailing here avoids 401 → second refresh → duplicate notification
      if (!(await refreshParked(d, name)).ok) return;
      tokens = await readTokens();
      if (!tokens) return;
    }

    let result = await d.api.fetchUsage(tokens.accessToken);
    if (!result.ok && result.status === 401 && !isActive) {
      if ((await refreshParked(d, name)).ok) {
        tokens = await readTokens();
        if (tokens) result = await d.api.fetchUsage(tokens.accessToken);
      }
    }
    if (result.ok) {
      account.snapshot = {
        fetchedAt: d.now().toISOString(),
        source: 'poll',
        model: account.snapshot?.model,
        gauges: result.gauges,
      };
      d.appendHistory(name, result.gauges, d.now());
    }
    d.saveState(d.state);
  } catch {
    // a locked keychain (or any keychain failure) degrades to backoff — the caller and
    // the other accounts' polls must keep working with stale-marked data
    account.lastPoll = d.now().toISOString();
    d.saveState(d.state);
  }
}

export async function refreshAllSnapshots(d: Deps, opts: { force?: boolean } = {}): Promise<void> {
  for (const name of Object.keys(d.state.accounts)) {
    try {
      await pollAccount(d, name, opts);
    } catch {
      // belt-and-braces: one broken account must never abort the sweep
    }
  }
}
