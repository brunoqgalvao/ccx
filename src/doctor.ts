import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Deps } from './deps';
import { parseTokens } from './creds';
import { escapeSecurityArg, LIVE_SERVICE, SECURITY_LINE_BUDGET, vaultService } from './keychain';

interface Check { name: string; ok: boolean; detail: string; hard: boolean; }

function failDetail(status: number): string {
  if (status === 429) return 'rate-limited (429) — retry later; consider disabling onwatch API polling';
  if (status === 401) return 'unauthorized (401) — token likely just expired; re-run after `ccx status`';
  if (status === 0) return 'network failure — offline or endpoint unreachable';
  return `endpoint returned status ${status}`;
}


export async function runDoctor(d: Deps): Promise<number> {
  const checks: Check[] = [];

  // 1. Keychain round-trip (proves security -i escaping on this machine)
  const probe = JSON.stringify({ claudeAiOauth: { accessToken: 'x"quote\\slash', n: 1 } });
  try {
    await d.kc.write('ccx-doctor-selftest', probe);
    const back = await d.kc.read('ccx-doctor-selftest');
    await d.kc.remove('ccx-doctor-selftest');
    checks.push({ name: 'keychain round-trip', ok: back === probe, detail: back === probe ? 'write/read/delete OK' : 'READBACK MISMATCH', hard: true });
  } catch (e) {
    checks.push({ name: 'keychain round-trip', ok: false, detail: String(e), hard: true });
  }

  // 2. Live slot
  let live: string | null = null;
  try { live = await d.kc.read(LIVE_SERVICE); } catch { /* fall through to the failed check */ }
  const liveTokens = live ? parseTokens(live) : null;
  checks.push({ name: 'live slot', ok: !!liveTokens, detail: liveTokens ? 'readable + parseable' : 'missing or unparseable (log in with claude)', hard: false });

  // 2b. Blob size headroom vs the security -i line-buffer ceiling (oversized writes are refused)
  if (live) {
    try {
      const cmdLen = 80 + escapeSecurityArg(live).length; // 80 ≈ command overhead incl. user/service
      const ok = cmdLen <= SECURITY_LINE_BUDGET - 400;    // warn with margin
      checks.push({ name: 'blob size', ok, detail: `~${cmdLen} of ${SECURITY_LINE_BUDGET} bytes${ok ? '' : ' — nearing the security -i ceiling; vault writes will start refusing (mcpOAuth grew?)'}`, hard: false });
    } catch {
      checks.push({ name: 'blob size', ok: false, detail: 'live blob contains non-ASCII — ccx cannot rewrite it via security -i', hard: false });
    }
  }

  // 3. Per-account vault + endpoints
  for (const [name, account] of Object.entries(d.state.accounts)) {
    let blob: string | null = null;
    try {
      blob = await d.kc.read(vaultService(name));
    } catch (e) {
      // doctor diagnoses keychain trouble — it must report it, never crash on it
      checks.push({ name: `vault:${name}`, ok: false, detail: `keychain read failed: ${e instanceof Error ? e.message : String(e)}`, hard: false });
      continue;
    }
    const tokens = blob ? parseTokens(blob) : null;
    checks.push({ name: `vault:${name}`, ok: !!tokens, detail: tokens ? 'entry parseable' : 'missing/unparseable — re-run ccx import', hard: false });
    if (!tokens) continue;
    if (tokens.expiresAt && tokens.expiresAt < d.now().getTime()) {
      // an expired access token is the NORMAL parked state; probing the endpoints with it
      // would just render misleading 401 warnings and burn the rate-limited budget
      checks.push({ name: `token:${name}`, ok: true, detail: 'access token expired (normal when parked — refreshes on next poll)', hard: false });
      continue;
    }
    const profile = await d.api.fetchProfile(tokens.accessToken);
    const match = profile.ok && profile.uuid === account.accountUuid;
    checks.push({
      name: `profile:${name}`, ok: !!match,
      detail: profile.ok ? (match ? `uuid matches (${account.email})` : 'UUID MISMATCH — wrong creds in vault?') : failDetail((profile as any).status),
      hard: false,
    });
    const usage = await d.api.fetchUsage(tokens.accessToken);
    checks.push({ name: `usage:${name}`, ok: usage.ok, detail: usage.ok ? `${usage.gauges.length} gauges` : failDetail((usage as any).status), hard: false });
  }

  // 4. claude binary
  checks.push({ name: 'claude on PATH', ok: !!Bun.which('claude'), detail: Bun.which('claude') ?? 'not found', hard: true });

  // 5. statusline wiring (informational)
  let wired = false;
  try {
    wired = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8'))?.statusLine?.command?.includes('ccx statusline') ?? false;
  } catch { /* ignore */ }
  checks.push({ name: 'statusline wired', ok: wired, detail: wired ? 'ccx statusline is the statusLine command' : 'not wired (optional) — see README', hard: false });

  for (const c of checks) console.log(`${c.ok ? '✓' : c.hard ? '✗' : '⚠'} ${c.name}: ${c.detail}`);
  return checks.some((c) => c.hard && !c.ok) ? 1 : 0;
}
