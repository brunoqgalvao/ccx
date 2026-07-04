import { describe, expect, test } from 'bun:test';
import { assessFailover } from '../src/failover';
import { DEFAULT_CONFIG } from '../src/state';
import type { Gauge, Snapshot } from '../src/types';

const NOW = new Date('2026-07-03T18:00:00Z');
const IN_10_MIN = '2026-07-03T18:10:00Z';
const IN_3_H = '2026-07-03T21:00:00Z';
const MODEL = 'claude-fable-5[1m]';

function g(kind: Gauge['kind'], percent: number, over: Partial<Gauge> = {}): Gauge {
  return { kind, percent, severity: 'normal', resetsAt: IN_3_H, scopeModel: null, isActive: false, ...over };
}
function snap(gauges: Gauge[]): Snapshot {
  return { fetchedAt: NOW.toISOString(), source: 'poll', gauges };
}

describe('assessFailover', () => {
  test('no action when nothing is hit', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('session', 50)]) },
      others: [{ name: 'w', snapshot: snap([g('session', 10)]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r.action).toBe('none');
  });
  test('wait when the hit gauge resets within the threshold', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('session', 100, { isActive: true, resetsAt: IN_10_MIN })]) },
      others: [{ name: 'w', snapshot: snap([g('session', 10)]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'wait', resetsAt: IN_10_MIN });
  });
  test('switch when reset is far and other account has headroom', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('session', 100, { isActive: true })]) },
      others: [{ name: 'w', snapshot: snap([g('session', 10), g('weekly_all', 20)]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'switch', to: 'w' });
  });
  test('critical severity counts as hit even without isActive', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('weekly_all', 96, { severity: 'critical' })]) },
      others: [{ name: 'w', snapshot: snap([g('weekly_all', 10)]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r.action).toBe('switch');
  });
  test('downgrade when scoped gauge is hit on both accounts but general quota remains', () => {
    const fableFull = g('weekly_scoped', 100, { scopeModel: 'Fable', isActive: true });
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('weekly_all', 44), fableFull]) },
      others: [{ name: 'w', snapshot: snap([g('weekly_all', 60), { ...fableFull }]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'downgrade', on: 'p' }); // p has more general headroom (56 vs 40)
  });
  test('scoped-hit on used account switches when other account has scoped headroom', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('weekly_all', 44), g('weekly_scoped', 100, { scopeModel: 'Fable', isActive: true })]) },
      others: [{ name: 'w', snapshot: snap([g('weekly_all', 20), g('weekly_scoped', 30, { scopeModel: 'Fable' })]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'switch', to: 'w' });
  });
  test('wait (with soonest reset) when nothing has headroom anywhere', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('weekly_all', 100, { isActive: true, resetsAt: IN_3_H })]) },
      others: [{ name: 'w', snapshot: snap([g('weekly_all', 97, { severity: 'critical' })]), }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r.action).toBe('wait');
  });
  test('dual hit where only one resets soon → switch, not a useless wait', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([
        g('session', 100, { isActive: true, resetsAt: IN_10_MIN }),
        g('weekly_all', 100, { isActive: true, resetsAt: IN_3_H }),
      ]) },
      others: [{ name: 'w', snapshot: snap([g('session', 5), g('weekly_all', 10)]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'switch', to: 'w' });
  });
  test('dead-end wait reports the soonest relief across accounts', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('weekly_all', 100, { isActive: true, resetsAt: IN_3_H })]) },
      others: [{ name: 'w', snapshot: snap([g('weekly_all', 97, { severity: 'critical', resetsAt: IN_10_MIN })]) }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'wait', resetsAt: IN_10_MIN });
  });
  test('dead-end relief on the used account is its LAST hit reset, not the first', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([
        g('session', 100, { isActive: true, resetsAt: IN_10_MIN }),
        g('weekly_all', 100, { isActive: true, resetsAt: IN_3_H }),
      ]) },
      others: [],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r).toMatchObject({ action: 'wait', resetsAt: IN_3_H });
  });
  test('needsLogin account is not a switch target', () => {
    const r = assessFailover({
      used: { name: 'p', snapshot: snap([g('session', 100, { isActive: true })]) },
      others: [{ name: 'w', snapshot: snap([g('session', 0)]), needsLogin: true }],
      model: MODEL, cfg: DEFAULT_CONFIG, now: NOW,
    });
    expect(r.action).toBe('wait');
  });
});
