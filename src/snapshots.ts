import type { Config, Gauge, Severity, Snapshot } from './types';

const KINDS = new Set(['session', 'weekly_all', 'weekly_scoped']);

/** Epoch ms of a gauge's reset, NaN when unknown or the window hasn't started. */
export function resetEpoch(gauge: Pick<Gauge, 'resetsAt'>): number {
  return gauge.resetsAt === null ? NaN : Date.parse(gauge.resetsAt);
}
const SEVERITIES = new Set(['normal', 'warning', 'critical']);

export function deriveSeverity(pct: number, cfg: Config): Severity {
  if (pct >= cfg.criticalPct) return 'critical';
  if (pct >= cfg.warningPct) return 'warning';
  return 'normal';
}

export function parseUsageResponse(body: unknown): Gauge[] {
  const limits = (body as any)?.limits;
  if (!Array.isArray(limits)) return [];
  return limits
    .filter((l: any) => KINDS.has(l?.kind))
    .map((l: any): Gauge => ({
      kind: l.kind,
      percent: typeof l.percent === 'number' ? l.percent : 0,
      severity: SEVERITIES.has(l.severity) ? l.severity : 'normal',
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
      scopeModel: l.scope?.model?.display_name ?? null,
      isActive: l.is_active === true,
    }));
}

export function parseStatusline(body: unknown, cfg: Config): { model?: string; gauges: Gauge[] } {
  const rl = (body as any)?.rate_limits ?? {};
  const gauges: Gauge[] = [];
  const push = (kind: 'session' | 'weekly_all', entry: any) => {
    if (typeof entry?.used_percentage !== 'number') return;
    gauges.push({
      kind,
      percent: entry.used_percentage,
      severity: deriveSeverity(entry.used_percentage, cfg),
      resetsAt: typeof entry.resets_at === 'number' ? new Date(entry.resets_at * 1000).toISOString() : null,
      scopeModel: null,
      isActive: entry.used_percentage >= 100,
    });
  };
  push('session', rl.five_hour);
  push('weekly_all', rl.seven_day);
  const model = (body as any)?.model?.id;
  return { model: typeof model === 'string' ? model : undefined, gauges };
}

// weekly anchors jitter sub-second across API responses; distinct accounts differ by hours
const ANCHOR_TOLERANCE_MS = 60_000;

/** Does this statusline input plausibly belong to the snapshot's account? A session
 *  whose env-token pin broke (or that outlived a swap) is served ANOTHER account's
 *  rate limits while still labeled with its original CCX_ACCOUNT — merging those
 *  gauges would file account B's usage under account A. The weekly reset anchor is
 *  the per-account fingerprint: compare stdin's weekly anchor against a trusted one —
 *  the scoped gauge (poll-only, survives merges; F resets with wk) or a poll-sourced
 *  weekly. No trusted anchor or no stdin weekly → accept (fresh accounts, old inputs). */
export function anchorsCompatible(
  prev: Snapshot | undefined,
  parsed: { gauges: Gauge[] },
): boolean {
  if (!prev) return true;
  const stdinWk = parsed.gauges.find((g) => g.kind === 'weekly_all' && g.resetsAt !== null);
  if (!stdinWk) return true;
  const trusted =
    prev.gauges.find((g) => g.kind === 'weekly_scoped' && g.resetsAt !== null) ??
    (prev.source === 'poll' ? prev.gauges.find((g) => g.kind === 'weekly_all' && g.resetsAt !== null) : undefined);
  if (!trusted) return true;
  return Math.abs(resetEpoch(stdinWk) - resetEpoch(trusted)) <= ANCHOR_TOLERANCE_MS;
}

export function mergeStatusline(
  prev: Snapshot | undefined,
  parsed: { model?: string; gauges: Gauge[] },
  now: Date,
): Snapshot {
  // an input without usable rate_limits (API-key session, shape change) must never wipe
  // real gauges or fresh-stamp the snapshot — that would make the account look limitless
  if (parsed.gauges.length === 0 && prev) return prev;
  const scoped = prev?.gauges.filter((g) => g.kind === 'weekly_scoped') ?? [];
  return {
    fetchedAt: now.toISOString(),
    source: 'statusline',
    model: parsed.model ?? prev?.model,
    gauges: [...parsed.gauges, ...scoped],
  };
}
