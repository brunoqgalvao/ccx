import type { Candidate } from './picker';
import { bindingGauge, effectiveHeadroom, gaugeApplies, generalHeadroom } from './picker';
import { resetEpoch } from './snapshots';
import type { Config, Gauge } from './types';

export type FailoverAction =
  | { action: 'none' }
  | { action: 'wait'; resetsAt: string | null; reason: string }
  | { action: 'switch'; to: string; reason: string }
  | { action: 'downgrade'; on: string; reason: string };

function isHit(gauge: Gauge): boolean {
  return gauge.isActive || gauge.severity === 'critical' || gauge.percent >= 100;
}

export function assessFailover(args: {
  used: Candidate;
  others: Candidate[];
  model: string | undefined;
  cfg: Config;
  now: Date;
}): FailoverAction {
  const { used, others, model, cfg, now } = args;
  if (!used.snapshot) return { action: 'none' };

  const hits = used.snapshot.gauges.filter((gauge) => gaugeApplies(gauge, model)).filter(isHit);
  if (hits.length === 0) return { action: 'none' };
  const binding = hits.sort((a, b) => b.percent - a.percent)[0];

  // Cache-aware wait applies only when EVERY hit gauge resets within the threshold —
  // waiting out one gauge while another stays blocked for hours brings no relief.
  const allParseable = hits.every((gauge) => Number.isFinite(resetEpoch(gauge)));
  const lastHit = allParseable
    ? hits.reduce((a, b) => (resetEpoch(a) >= resetEpoch(b) ? a : b))
    : null; // unknown reset time → don't gamble on waiting; fall through to switch
  if (lastHit && resetEpoch(lastHit) - now.getTime() <= cfg.switchMinResetWaitMin * 60_000) {
    return {
      action: 'wait',
      resetsAt: lastHit.resetsAt,
      reason: 'reset is near; waiting costs less than an uncached context re-read',
    };
  }

  const minUsable = 100 - cfg.criticalPct; // an account this close to critical is not a rescue
  const targets = others.filter((o) => !o.needsLogin && o.snapshot);
  const bySwitch = targets
    .map((o) => ({ o, headroom: effectiveHeadroom(o.snapshot!, model) }))
    .sort((a, b) => b.headroom - a.headroom)[0];
  if (bySwitch && bySwitch.headroom > minUsable) {
    return {
      action: 'switch',
      to: bySwitch.o.name,
      reason: `${bySwitch.o.name} has ${bySwitch.headroom}% headroom for ${model ?? 'any model'}`,
    };
  }

  if (binding.kind === 'weekly_scoped') {
    const byGeneral = [used, ...targets]
      .filter((c) => c.snapshot && !c.needsLogin)
      .map((c) => ({ c, headroom: generalHeadroom(c.snapshot!) }))
      .sort((a, b) => b.headroom - a.headroom)[0];
    if (byGeneral && byGeneral.headroom > minUsable) {
      return {
        action: 'downgrade',
        on: byGeneral.c.name,
        reason: `scoped (${binding.scopeModel}) pool exhausted everywhere; ${byGeneral.c.name} has ${byGeneral.headroom}% general headroom`,
      };
    }
  }

  // Dead end: no account can rescue. Report the SOONEST relief across all accounts (spec §4),
  // not just the used account's binding reset — the rival's gauge may free up much earlier.
  const reliefGauges = [
    ...(lastHit ? [lastHit] : hits), // the used account's relief is its LAST hit reset, not the first
    ...targets
      .map((o) => bindingGauge(o.snapshot!, model))
      .filter((gauge): gauge is NonNullable<typeof gauge> => !!gauge),
  ].filter((gauge) => Number.isFinite(resetEpoch(gauge)));
  const soonest = reliefGauges.sort((a, b) => resetEpoch(a) - resetEpoch(b))[0] ?? binding;
  return {
    action: 'wait',
    resetsAt: soonest.resetsAt,
    reason: 'no account has usable headroom; soonest relief across accounts is shown',
  };
}
