import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Deps } from './deps';
import { checkAndNotify } from './notifier';
import { isStale } from './picker';
import { mergeStatusline, parseStatusline } from './snapshots';
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

/** Quota is use-it-or-lose-it: flag a gauge whose reset is imminent while plenty is unused. */
export function expiringUnused(gauge: Gauge, cfg: Config, now: Date): boolean {
  const msLeft = Date.parse(gauge.resetsAt) - now.getTime();
  return msLeft > 0 && msLeft <= cfg.expiryNudgeMin * 60_000 && 100 - gauge.percent >= cfg.expiryNudgeUnusedPct;
}

export function buildSegment(state: State, cfg: Config, now: Date): string {
  const parts = Object.entries(state.accounts).map(([name, account]) => {
    const marker = state.activeAccount === name ? '⚡' : '';
    if (account.needsLogin) return `${marker}${name} ⚠login`;
    if (!account.snapshot || account.snapshot.gauges.length === 0) return `${marker}${name} —`;
    const gauges = [...account.snapshot.gauges]
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
      .map((gauge) => {
        const eta = gauge.kind === 'weekly_scoped' ? '' : fmtEta(Date.parse(gauge.resetsAt) - now.getTime()); // F resets with wk — don't repeat it
        const nudge = expiringUnused(gauge, cfg, now) ? '🔥' : '';
        return `${GAUGE_LABEL[gauge.kind]}${Math.round(gauge.percent)}%${eta ? `·${eta}` : ''}${nudge}${severityMark(gauge)}`;
      })
      .join(' ');
    const stale = isStale(account.snapshot, cfg, now) ? '?' : '';
    return `${marker}${name} ${gauges}${stale}`;
  });
  return parts.join(' │ ');
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

export async function runStatusline(d: Deps): Promise<void> {
  const raw = await Bun.stdin.text();
  teeRaw(raw, d.cfg.statuslineTeePath);

  let input: unknown = null;
  try { input = JSON.parse(raw); } catch { /* render-only mode */ }

  if (input) {
    try {
      const active = d.state.activeAccount ? d.state.accounts[d.state.activeAccount] : undefined;
      if (active) {
        const parsed = parseStatusline(input, d.cfg);
        if (parsed.gauges.length > 0) {
          active.snapshot = mergeStatusline(active.snapshot, parsed, d.now());
        }
        d.saveState(d.state);
      }
      // parked accounts: sparse, BOUNDED polling — abandoned work is safe because
      // pollAccount pins lastPoll before any network call (no herd, no re-spam)
      const pollPhase = (async () => {
        for (const name of Object.keys(d.state.accounts)) {
          if (name !== d.state.activeAccount) await pollAccount(d, name);
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
  const segment = buildSegment(d.state, d.cfg, d.now());
  console.log(rendered ? `${rendered} ${segment}` : segment);
}
