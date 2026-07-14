import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Deps } from './deps';
import { checkAndNotify } from './notifier';
import { expiringUnused, isStale } from './picker';
import { mergeStatusline, parseStatusline, resetEpoch } from './snapshots';
import { pollAccount } from './usage';
import type { Config, Gauge, State } from './types';

const GAUGE_LABEL: Record<Gauge['kind'], string> = { session: '5h', weekly_all: 'wk', weekly_scoped: 'F' };
const ORDER: Gauge['kind'][] = ['session', 'weekly_all', 'weekly_scoped'];

function severityMark(gauge: Gauge): string {
  if (gauge.severity === 'critical' || gauge.isActive) return '✗';
  if (gauge.severity === 'warning') return '!';
  return '';
}

/** Compact countdown: 42m / 2h49m / 3h / 2d19h / 3d; '' when past (idle window) or unknown. */
export function fmtEta(msLeft: number): string {
  if (Number.isNaN(msLeft) || msLeft <= 0) return '';
  const m = Math.round(msLeft / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const dDays = Math.floor(h / 24);
  return `${dDays}d${h % 24 ? `${h % 24}h` : ''}`;
}

const CTX_WARN_PCT = 80;

/** 51_109 → '51k', 1_000_000 → '1M', 830 → '830'. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function ctxTokensUsed(cw: Record<string, any>): number | null {
  const usage = cw.current_usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const total = Object.values(usage as Record<string, unknown>)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .reduce((a, b) => a + b, 0);
  return total > 0 ? total : null;
}

/** The session's own basics (model · ctx% · effort) from the statusline stdin —
 *  fields the default Claude Code statusline shows and ccx used to discard. */
export function buildBasicSegment(input: unknown, cfg: Config): string {
  if (!cfg.statuslineBasic || typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, any>;
  const parts: string[] = [];
  const model = o.model?.display_name;
  if (typeof model === 'string' && model) parts.push(model);
  const cw = o.context_window;
  const ctx = cw?.used_percentage;
  if (typeof ctx === 'number' && Number.isFinite(ctx)) {
    const used = ctxTokensUsed(cw);
    const size = typeof cw.context_window_size === 'number' && cw.context_window_size > 0 ? cw.context_window_size : null;
    const fraction = used !== null && size !== null ? ` (${fmtTokens(used)}/${fmtTokens(size)})` : '';
    parts.push(`ctx ${Math.round(ctx)}%${ctx >= CTX_WARN_PCT ? '!' : ''}${fraction}`);
  }
  const effort = o.effort?.level;
  if (typeof effort === 'string' && effort) parts.push(effort === 'medium' ? 'med' : effort);
  return parts.join(' · ');
}

export function composeFirstLine(passthrough: string, basic: string, accounts: string): string {
  const tail = [basic, accounts].filter((s) => s !== '').join(' │ ');
  return [passthrough, tail].filter((s) => s !== '').join(' ');
}

export function buildSegment(state: State, cfg: Config, now: Date, pinnedAccount?: string): string {
  const parts = Object.entries(state.accounts).map(([name, account]) => {
    // ⚡ = live Keychain slot; 📌 = the account THIS session is pinned to (ccx run) —
    // without it, a pinned session's statusline points the reader at the wrong account.
    const marker = `${state.activeAccount === name ? '⚡' : ''}${pinnedAccount === name ? '📌' : ''}`;
    if (account.needsLogin) return `${marker}${name} ⚠login`;
    if (!account.snapshot || account.snapshot.gauges.length === 0) return `${marker}${name} —`;
    const gauges = [...account.snapshot.gauges]
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
      .map((gauge) => {
        const eta = cfg.statuslineEta === 'inline' && gauge.kind !== 'weekly_scoped' // F resets with wk — don't repeat it
          ? fmtEta(resetEpoch(gauge) - now.getTime())
          : '';
        const nudge = expiringUnused(gauge, cfg, now) ? '🔥' : '';
        return `${GAUGE_LABEL[gauge.kind]}${Math.round(gauge.percent)}%${eta ? `·${eta}` : ''}${nudge}${severityMark(gauge)}`;
      })
      .join(' ');
    const stale = isStale(account.snapshot, cfg, now) ? '?' : '';
    return `${marker}${name} ${gauges}${stale}`;
  });
  return parts.join(' │ ');
}

/** Second statusline row: per-account time-to-reset for windows that are actually running. */
export function buildEtaLine(state: State, cfg: Config, now: Date): string {
  if (cfg.statuslineEta !== 'line2') return '';
  const parts = Object.entries(state.accounts)
    .map(([name, account]) => {
      const etas = (account.snapshot?.gauges ?? [])
        .filter((gauge) => gauge.kind !== 'weekly_scoped') // F resets with wk
        .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
        .map((gauge) => ({ label: GAUGE_LABEL[gauge.kind], eta: fmtEta(resetEpoch(gauge) - now.getTime()) }))
        .filter((e) => e.eta !== '')
        .map((e) => `${e.label} ${e.eta}`);
      return etas.length > 0 ? `${name} ${etas.join(' · ')}` : null;
    })
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? `↻ ${parts.join(' │ ')}` : '';
}

function teeRaw(raw: string, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.ccx-tee-${process.pid}.tmp`);
    writeFileSync(tmp, raw);
    renameSync(tmp, path);
  } catch {
    // tee is best-effort; onwatch falls back to API polling
  }
}

const POLL_BUDGET_MS = 1_500;       // a slow network must never freeze the user's render loop
const PASSTHROUGH_TIMEOUT_MS = 4_000;

async function runPassthrough(cmd: string, raw: string): Promise<string> {
  if (!cmd.trim()) return '';
  try {
    const p = Bun.spawn(['sh', '-c', cmd], {
      stdin: new TextEncoder().encode(raw),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const timer = setTimeout(() => p.kill(), PASSTHROUGH_TIMEOUT_MS);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    // Claude Code renders a single line — take the passthrough's first so our segment stays visible
    return out.split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

/** Which account a statusline invocation's gauges belong to. Sessions launched by ccx
 *  carry CCX_ACCOUNT in env (statusline runs as a descendant of that session) — pinned
 *  sessions in particular are usually NOT the active account, and a session that
 *  outlives a swap/import keeps serving its original account while activeAccount moves.
 *  Only a bare `claude` (no env marker) is safely attributed to the active slot. */
export function resolveStatuslineAccount(state: State, envAccount: string | undefined): string | undefined {
  if (envAccount && state.accounts[envAccount]) return envAccount;
  return state.activeAccount ?? undefined;
}

export async function runStatusline(d: Deps): Promise<void> {
  const raw = await Bun.stdin.text();
  teeRaw(raw, d.cfg.statuslineTeePath);

  let input: unknown = null;
  try { input = JSON.parse(raw); } catch { /* render-only mode */ }

  const envAccount = process.env.CCX_ACCOUNT;
  const pinnedAccount = envAccount && d.state.accounts[envAccount] ? envAccount : undefined;
  const sessionAccount = resolveStatuslineAccount(d.state, envAccount);
  if (input) {
    try {
      const owner = sessionAccount ? d.state.accounts[sessionAccount] : undefined;
      if (owner) {
        const parsed = parseStatusline(input, d.cfg);
        if (parsed.gauges.length > 0) {
          owner.snapshot = mergeStatusline(owner.snapshot, parsed, d.now());
        }
        d.saveState(d.state);
      }
      // other accounts: sparse, BOUNDED polling — abandoned work is safe because
      // pollAccount pins lastPoll before any network call (no herd, no re-spam).
      // Skip the session's own account (statusline-fed), not the active slot: for a
      // pinned session they differ, and its own account's data is already fresh here.
      const pollPhase = (async () => {
        for (const name of Object.keys(d.state.accounts)) {
          if (name !== sessionAccount) await pollAccount(d, name);
        }
      })();
      pollPhase.catch(() => {}); // an abandoned phase's late rejection must never kill the render
      await Promise.race([pollPhase, new Promise((resolve) => setTimeout(resolve, POLL_BUDGET_MS))]);
      checkAndNotify(d);
    } catch {
      // the render must survive anything above — degraded data beats a broken statusline
    }
  }

  const rendered = await runPassthrough(d.cfg.statuslinePassthrough, raw);
  const basic = buildBasicSegment(input, d.cfg);
  const segment = buildSegment(d.state, d.cfg, d.now(), pinnedAccount);
  console.log(composeFirstLine(rendered, basic, segment));
  const etaLine = buildEtaLine(d.state, d.cfg, d.now());
  if (etaLine) console.log(etaLine);
}
