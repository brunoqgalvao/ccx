import type { Config, Gauge, Snapshot } from './types';

export interface Candidate {
  name: string;
  snapshot?: Snapshot;
  needsLogin?: boolean;
}

export function isStale(s: Snapshot | undefined, cfg: Config, now: Date): boolean {
  if (!s) return true;
  const fetched = Date.parse(s.fetchedAt);
  // unparseable timestamps count as stale — conservative beats "garbage reads as fresh"
  return !Number.isFinite(fetched) || now.getTime() - fetched > cfg.staleAfterMin * 60_000;
}

export function gaugeApplies(gauge: Gauge, model: string | undefined): boolean {
  if (gauge.kind !== 'weekly_scoped' || !gauge.scopeModel) return true;
  if (!model) return true; // conservative: never overstate headroom
  return model.toLowerCase().includes(gauge.scopeModel.toLowerCase());
}

export function effectiveHeadroom(s: Snapshot, model: string | undefined): number {
  const applicable = s.gauges.filter((gauge) => gaugeApplies(gauge, model));
  // Zero applicable gauges scores 100% — the parsing layer must never emit an
  // empty-gauge snapshot on partial failure, or that account looks limitless.
  if (applicable.length === 0) return 100;
  return Math.min(...applicable.map((gauge) => 100 - gauge.percent));
}

export function generalHeadroom(s: Snapshot): number {
  const general = s.gauges.filter((gauge) => gauge.kind !== 'weekly_scoped');
  if (general.length === 0) return 100;
  return Math.min(...general.map((gauge) => 100 - gauge.percent));
}

export function bindingGauge(s: Snapshot, model: string | undefined): Gauge | undefined {
  return s.gauges
    .filter((gauge) => gaugeApplies(gauge, model))
    .sort((a, b) => b.percent - a.percent)[0];
}

export interface PickResult {
  name: string;
  headroom: number;
  stale: boolean;
  reason: string;
}

export function pickAccount(cands: Candidate[], model: string | undefined, cfg: Config, now: Date): PickResult {
  if (cands.length === 0) throw new Error('pickAccount requires at least one candidate account');
  const usable = cands.filter((c) => !c.needsLogin);
  const pool = usable.length > 0 ? usable : cands;
  const scored = pool
    .map((c) => ({
      c,
      headroom: c.snapshot ? effectiveHeadroom(c.snapshot, model) : 0,
      stale: isStale(c.snapshot, cfg, now),
      resetMs: c.snapshot ? Date.parse(bindingGauge(c.snapshot, model)?.resetsAt ?? '') || Infinity : Infinity,
    }))
    .sort((a, b) => b.headroom - a.headroom);
  let best = scored[0];
  const rival = scored[1];
  if (rival && best.headroom - rival.headroom <= cfg.tiebreakMargin && rival.resetMs < best.resetMs) {
    best = rival;
  }
  return {
    name: best.c.name,
    headroom: best.headroom,
    stale: best.stale,
    reason: `${best.headroom}% headroom for ${model ?? 'any model'}${best.stale ? ' (stale data)' : ''}`,
  };
}
