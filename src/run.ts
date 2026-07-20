import { parseTokens } from './creds';
import type { Deps } from './deps';
import type { AccountState } from './types';
import { vaultService } from './keychain';
import { otherClaudeRunning, spawnClaude, withPermissionFlag } from './launcher';
import { refreshAllSnapshots } from './usage';
import { activate, refreshParked, syncBack } from './vault';

export type RunPrep = { ok: true; token: string; expiresAt: number; warnings: string[] } | { ok: false; reason: string };

function ttlMs(d: Deps): number {
  return d.cfg.runMinTokenTtlMin * 60_000;
}

export async function prepareRun(d: Deps, name: string): Promise<RunPrep> {
  const account = d.state.accounts[name];
  if (!account) {
    const known = Object.keys(d.state.accounts).join(', ') || '(none imported)';
    return { ok: false, reason: `unknown account "${name}" — imported: ${known}` };
  }
  const readVaultTokens = async () => {
    const blob = await d.kc.read(vaultService(name)).catch(() => null);
    return blob ? parseTokens(blob) : null;
  };
  let tokens = await readVaultTokens();
  if (!tokens) return { ok: false, reason: `no readable vault entry for "${name}" — run \`ccx import ${name}\`` };

  const warnings: string[] = [];
  if (tokens.expiresAt - d.now().getTime() < ttlMs(d)) {
    const r = await refreshParked(d, name);
    if (r.ok) {
      tokens = await readVaultTokens();
      if (!tokens) return { ok: false, reason: `vault entry for "${name}" unreadable after refresh` };
    } else if (tokens.expiresAt > d.now().getTime()) {
      warnings.push(`refresh skipped (${r.reason}) — using the current token, expires ${new Date(tokens.expiresAt).toLocaleString()}`);
    } else {
      return { ok: false, reason: `access token expired and refresh failed: ${r.reason}` };
    }
  }

  // A malformed/rejected env token makes claude SILENTLY fall back to the live Keychain
  // account (POC-verified) — never launch a token we could not positively identify.
  const profile = await d.api.fetchProfile(tokens.accessToken);
  if (!profile.ok) {
    return { ok: false, reason: `cannot verify "${name}"'s token (status ${profile.status}) — refusing to launch: an unverified token silently falls back to the live Keychain account` };
  }
  if (profile.uuid !== account.accountUuid) {
    return { ok: false, reason: `vault entry for "${name}" belongs to a different account (${profile.email || profile.uuid}) — re-run \`ccx import ${name} --force\`` };
  }
  return { ok: true, token: tokens.accessToken, expiresAt: tokens.expiresAt, warnings };
}

export async function spawnClaudePinned(args: string[], token: string, account?: string): Promise<number> {
  // CCX_ACCOUNT lets `ccx statusline` attribute this session's gauges to the pinned
  // account — a pinned session normally runs on a NON-active account, so merging its
  // statusline into state.activeAccount cross-contaminates both snapshots.
  const p = Bun.spawn(['claude', ...args], {
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, ...(account ? { CCX_ACCOUNT: account } : {}) },
  });
  return await p.exited;
}

/** A pinned session cannot rotate its env token; if it exited AFTER the token's expiry,
 *  the likely cause is auth death — refresh and resume rather than losing the session. */
export function shouldResume(exitedAt: Date, tokenExpiresAt: number, args: string[], isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (args.includes('-p') || args.includes('--print')) return false; // one-shots end when they end
  return exitedAt.getTime() >= tokenExpiresAt;
}

/** Keychain-first launch: swap the live slot to `name` and spawn claude WITHOUT an env
 *  token. CLAUDE_CODE_OAUTH_TOKEN carries no subscription metadata (the keychain blob
 *  does), so env-token interactive sessions gate subscription models behind "needs
 *  extra usage credits" — keychain auth is the only path where Fable-class models work. */
export async function runLiveSession(
  d: Deps,
  name: string,
  args: string[],
  spawn: (args: string[], account?: string) => Promise<number> = spawnClaude,
  claudeRunning: () => Promise<boolean> = otherClaudeRunning,
): Promise<number> {
  if (!d.state.accounts[name]) {
    const known = Object.keys(d.state.accounts).join(', ') || '(none imported)';
    console.error(`ccx: unknown account "${name}" — imported: ${known}`);
    return 1;
  }
  if (name !== d.state.activeAccount && (await claudeRunning())) {
    console.error(`ccx: heads-up — another claude session shares the live slot; it may pick up ${name}'s tokens on its next refresh`);
  }
  const r = await activate(d, name);
  if (!r.ok) {
    console.error(`ccx: ${r.reason} — \`ccx run ${name} --pin\` launches via env token without touching the live slot`);
    return 1;
  }
  console.error(`ccx: live session on ${name} (${d.state.accounts[name].email}) — keychain auth, subscription models available`);
  const code = await spawn(withPermissionFlag(args, d.cfg), name);
  // claude rotates tokens in the live slot during the session — capture them or the
  // vault copy (and refreshTokenHash) goes stale
  const sync = await syncBack(d);
  if (!sync.ok) console.error(`ccx: ${sync.reason}`);
  return code;
}

export async function runRun(
  d: Deps,
  argv: string[],
  spawn = spawnClaudePinned,
  isTTY: () => boolean = () => process.stdin.isTTY === true,
  liveSpawn: (args: string[], account?: string) => Promise<number> = spawnClaude,
  claudeRunning: () => Promise<boolean> = otherClaudeRunning,
): Promise<number> {
  const name = argv[0];
  if (!name || name.startsWith('-')) { console.error('usage: ccx run <account> [--pin] [claude args...]'); return 1; }
  const rest = argv.slice(1);
  // Env-token pinning is opt-in: it never touches the live slot (parallel terminals on
  // different accounts) but its sessions can't use subscription-gated models interactively.
  if (!rest.includes('--pin')) return runLiveSession(d, name, rest, liveSpawn, claudeRunning);
  let args = rest.filter((a) => a !== '--pin');
  let resumed = false;
  while (true) {
    const prep = await prepareRun(d, name);
    if (!prep.ok) { console.error(`ccx: ${prep.reason}`); return 1; }
    for (const w of prep.warnings) console.error(`ccx: ${w}`);
    console.error(resumed
      ? `ccx: token refreshed — resuming pinned session on ${name}`
      : `ccx: pinned session on ${name} (${d.state.accounts[name].email}) — live Keychain slot untouched`);
    const code = await spawn(withPermissionFlag(args, d.cfg), prep.token, name);
    if (!shouldResume(d.now(), prep.expiresAt, args, isTTY())) return code;
    args = ['--continue'];
    resumed = true;
  }
}

export async function runRefresh(d: Deps): Promise<number> {
  let failures = 0;
  for (const name of Object.keys(d.state.accounts)) {
    const blob = await d.kc.read(vaultService(name)).catch(() => null);
    const tokens = blob ? parseTokens(blob) : null;
    if (!tokens) { console.error(`ccx: ${name}: no readable vault entry`); failures++; continue; }
    if (tokens.expiresAt - d.now().getTime() >= ttlMs(d)) {
      console.error(`ccx: ${name}: fresh (expires ${new Date(tokens.expiresAt).toLocaleString()})`);
      continue;
    }
    const r = await refreshParked(d, name);
    if (r.ok) console.error(`ccx: ${name}: refreshed`);
    else if (/live|active account/.test(r.reason ?? '')) console.error(`ccx: ${name}: live — refresh is Claude Code's job`);
    else { console.error(`ccx: ${name}: ${r.reason}`); failures++; }
  }
  return failures > 0 ? 1 : 0;
}

/** The 5h window anchors at the FIRST request — an idle window means quota sitting
 *  still. Warming it starts the clock so the next reset lands sooner during real work. */
export function needsWarm(account: AccountState, now: Date): boolean {
  if (account.needsLogin) return false;
  const session = account.snapshot?.gauges.find((g) => g.kind === 'session');
  if (!session) return true; // no data = window certainly not running
  if (session.resetsAt === null) return true; // API says the window never started
  return Date.parse(session.resetsAt) <= now.getTime();
}

/** Silent variant for warm pings: no terminal stdio, output discarded. */
export async function spawnClaudeQuiet(args: string[], token: string): Promise<number> {
  const p = Bun.spawn(['claude', ...args], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  return await p.exited;
}

export async function runWarm(d: Deps, spawn = spawnClaudeQuiet): Promise<number> {
  await syncBack(d).catch(() => {}); // freshen the active account's vault copy first
  await refreshAllSnapshots(d).catch(() => {}); // stale data must not skip a warm (poll floor still applies)
  let failures = 0;
  for (const [name, account] of Object.entries(d.state.accounts)) {
    if (!needsWarm(account, d.now())) { console.error(`ccx: ${name}: window running — no warm needed`); continue; }
    const prep = await prepareRun(d, name);
    if (!prep.ok) { console.error(`ccx: ${name}: skipped — ${prep.reason}`); failures++; continue; }
    const code = await spawn(['-p', 'ok', '--model', d.cfg.warmModel], prep.token);
    if (code === 0) console.error(`ccx: ${name}: window warmed — 5h clock started`);
    else { console.error(`ccx: ${name}: warm ping exited ${code}`); failures++; }
  }
  return failures > 0 ? 1 : 0;
}
