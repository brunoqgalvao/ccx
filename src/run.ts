import { parseTokens } from './creds';
import type { Deps } from './deps';
import { vaultService } from './keychain';
import { withPermissionFlag } from './launcher';
import { refreshParked } from './vault';

export type RunPrep = { ok: true; token: string; warnings: string[] } | { ok: false; reason: string };

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
  return { ok: true, token: tokens.accessToken, warnings };
}

export async function spawnClaudePinned(args: string[], token: string): Promise<number> {
  const p = Bun.spawn(['claude', ...args], {
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  return await p.exited;
}

export async function runRun(d: Deps, argv: string[], spawn = spawnClaudePinned): Promise<number> {
  const name = argv[0];
  if (!name || name.startsWith('-')) { console.error('usage: ccx run <account> [claude args...]'); return 1; }
  const prep = await prepareRun(d, name);
  if (!prep.ok) { console.error(`ccx: ${prep.reason}`); return 1; }
  for (const w of prep.warnings) console.error(`ccx: ${w}`);
  console.error(`ccx: pinned session on ${name} (${d.state.accounts[name].email}) — live Keychain slot untouched`);
  return spawn(withPermissionFlag(argv.slice(1), d.cfg), prep.token);
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
