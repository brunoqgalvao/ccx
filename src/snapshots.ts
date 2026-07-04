import type { Config, Gauge, Severity, Snapshot } from './types';

const KINDS = new Set(['session', 'weekly_all', 'weekly_scoped']);
const SEVERITIES = new Set(['normal', 'warning', 'critical']);

export function deriveSeverity(pct: number, cfg: Config): Severity {
  if (pct >= cfg.criticalPct) return 'critical';
  if (pct >= cfg.warningPct) return 'warning';
  return 'normal';
}

export function parseUsageResponse(body: unknown, now: Date): Gauge[] {
  const limits = (body as any)?.limits;
  if (!Array.isArray(limits)) return [];
  return limits
    .filter((l: any) => KINDS.has(l?.kind))
    .map((l: any): Gauge => ({
      kind: l.kind,
      percent: typeof l.percent === 'number' ? l.percent : 0,
      severity: SEVERITIES.has(l.severity) ? l.severity : 'normal',
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : now.toISOString(),
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
      resetsAt: new Date(typeof entry.resets_at === 'number' ? entry.resets_at * 1000 : 0).toISOString(),
      scopeModel: null,
      isActive: entry.used_percentage >= 100,
    });
  };
  push('session', rl.five_hour);
  push('weekly_all', rl.seven_day);
  const model = (body as any)?.model?.id;
  return { model: typeof model === 'string' ? model : undefined, gauges };
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
