import { describe, expect, test } from 'bun:test';
import { bindingGauge, effectiveHeadroom, expiringUnused, gaugeApplies, generalHeadroom, isStale, pickAccount, spilloverPick } from '../src/picker';
import { DEFAULT_CONFIG } from '../src/state';
import type { Gauge, Snapshot } from '../src/types';

const NOW = new Date('2026-07-03T18:00:00Z');
const FRESH = NOW.toISOString();

function g(kind: Gauge['kind'], percent: number, over: Partial<Gauge> = {}): Gauge {
  return { kind, percent, severity: 'normal', resetsAt: '2026-07-04T18:00:00Z', scopeModel: null, isActive: false, ...over };
}
function snap(gauges: Gauge[], fetchedAt = FRESH): Snapshot {
  return { fetchedAt, source: 'poll', gauges };
}

describe('gaugeApplies', () => {
  const fable = g('weekly_scoped', 75, { scopeModel: 'Fable' });
  test('scoped gauge applies when scope model is substring of target model', () => {
    expect(gaugeApplies(fable, 'claude-fable-5[1m]')).toBe(true);
  });
  test('scoped gauge does not apply to a different model', () => {
    expect(gaugeApplies(fable, 'claude-opus-4-8')).toBe(false);
  });
  test('scoped gauge applies conservatively when model is unknown', () => {
    expect(gaugeApplies(fable, undefined)).toBe(true);
  });
  test('unscoped gauges always apply', () => {
    expect(gaugeApplies(g('session', 10), 'claude-opus-4-8')).toBe(true);
  });
});

describe('headroom', () => {
  const s = snap([g('session', 20), g('weekly_all', 44), g('weekly_scoped', 75, { scopeModel: 'Fable' })]);
  test('effectiveHeadroom is min over applicable gauges', () => {
    expect(effectiveHeadroom(s, 'claude-fable-5[1m]')).toBe(25);
    expect(effectiveHeadroom(s, 'claude-opus-4-8')).toBe(56);
  });
  test('generalHeadroom ignores scoped gauges entirely', () => {
    expect(generalHeadroom(s)).toBe(56);
  });
  test('bindingGauge is the most-used applicable gauge', () => {
    expect(bindingGauge(s, 'claude-fable-5[1m]')!.kind).toBe('weekly_scoped');
    expect(bindingGauge(s, 'claude-opus-4-8')!.kind).toBe('weekly_all');
  });
});

describe('pickAccount', () => {
  test('picks the account with more effective headroom for the model', () => {
    const p = pickAccount(
      [
        { name: 'personal', snapshot: snap([g('session', 20), g('weekly_scoped', 75, { scopeModel: 'Fable' })]) },
        { name: 'work', snapshot: snap([g('session', 10), g('weekly_scoped', 30, { scopeModel: 'Fable' })]) },
      ],
      'claude-fable-5[1m]', DEFAULT_CONFIG, NOW,
    );
    expect(p.name).toBe('work');
  });
  test('tiebreak within margin: rival with sooner reset beats slightly higher headroom', () => {
    const p = pickAccount(
      [
        { name: 'a', snapshot: snap([g('session', 50, { resetsAt: '2026-07-03T19:00:00Z' })]) },
        { name: 'b', snapshot: snap([g('session', 47, { resetsAt: '2026-07-03T23:00:00Z' })]) },
      ],
      undefined, DEFAULT_CONFIG, NOW,
    );
    expect(p.name).toBe('a'); // b leads by 3 (≤ margin 5) but a's binding gauge resets sooner
  });
  test('needsLogin accounts are excluded', () => {
    const p = pickAccount(
      [
        { name: 'a', snapshot: snap([g('session', 90)]) },
        { name: 'b', snapshot: snap([g('session', 1)]), needsLogin: true },
      ],
      undefined, DEFAULT_CONFIG, NOW,
    );
    expect(p.name).toBe('a');
  });
  test('missing snapshot scores zero headroom', () => {
    const p = pickAccount([{ name: 'a' }, { name: 'b', snapshot: snap([g('session', 30)]) }], undefined, DEFAULT_CONFIG, NOW);
    expect(p.name).toBe('b');
  });
  test('stale snapshot flagged in result', () => {
    const p = pickAccount(
      [{ name: 'a', snapshot: snap([g('session', 10)], '2026-07-03T10:00:00Z') }],
      undefined, DEFAULT_CONFIG, NOW,
    );
    expect(p.stale).toBe(true);
  });
  test('unparseable fetchedAt counts as stale', () => {
    expect(isStale({ fetchedAt: 'garbage', source: 'poll', gauges: [] }, DEFAULT_CONFIG, NOW)).toBe(true);
  });
  test('throws a clear error on an empty candidate list', () => {
    expect(() => pickAccount([], undefined, DEFAULT_CONFIG, NOW)).toThrow(/at least one/);
  });
});

describe('spilloverPick', () => {
  const cfg = DEFAULT_CONFIG; // warningPct: 75
  function cands(overrides: Record<string, Partial<{ snapshot: Snapshot; needsLogin: boolean }>>) {
    return Object.entries(overrides).map(([name, o]) => ({ name, ...o }));
  }
  test('active under warningPct stays put even when another account has more headroom', () => {
    const c = cands({
      busy: { snapshot: snap([g('session', 60)]) },
      idle: { snapshot: snap([g('session', 5)]) },
    });
    expect(spilloverPick(c, 'busy', undefined, cfg, NOW).name).toBe('busy');
  });
  test('active at warningPct+ spills to the best account under the threshold', () => {
    const c = cands({
      busy: { snapshot: snap([g('session', 82)]) },
      alt1: { snapshot: snap([g('session', 50)]) },
      alt2: { snapshot: snap([g('session', 20)]) },
    });
    const pick = spilloverPick(c, 'busy', undefined, cfg, NOW);
    expect(pick.name).toBe('alt2');
    expect(pick.reason).toContain('spillover');
  });
  test('threshold is the binding gauge for the target model, not just the session gauge', () => {
    const c = cands({
      busy: { snapshot: snap([g('session', 10), g('weekly_scoped', 90, { scopeModel: 'Fable' })]) },
      idle: { snapshot: snap([g('session', 30)]) },
    });
    expect(spilloverPick(c, 'busy', 'claude-fable-5', cfg, NOW).name).toBe('idle');
    expect(spilloverPick(c, 'busy', 'claude-opus-4-8', cfg, NOW).name).toBe('busy');
  });
  test('needsLogin and over-threshold alternatives are skipped; all hot falls back to max headroom', () => {
    const c = cands({
      busy: { snapshot: snap([g('session', 90)]) },
      locked: { snapshot: snap([g('session', 5)]), needsLogin: true },
      warm: { snapshot: snap([g('session', 80)]) },
    });
    expect(spilloverPick(c, 'busy', undefined, cfg, NOW).name).toBe('warm'); // fallback: least bad
  });
  test('active without a snapshot counts as over threshold', () => {
    const c = cands({
      blind: {},
      idle: { snapshot: snap([g('session', 10)]) },
    });
    expect(spilloverPick(c, 'blind', undefined, cfg, NOW).name).toBe('idle');
  });
  test('no active account falls back to plain pick', () => {
    const c = cands({ a: { snapshot: snap([g('session', 10)]) } });
    expect(spilloverPick(c, null, undefined, cfg, NOW).name).toBe('a');
  });
});

describe('expiringUnused', () => {
  test('weekly gauge within horizon with enough unused flags', () => {
    expect(expiringUnused(g('weekly_all', 60, { resetsAt: '2026-07-03T20:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(true);
  });
  test('session gauges never flag, even in-horizon with unused quota', () => {
    expect(expiringUnused(g('session', 10, { resetsAt: '2026-07-03T19:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
  test('beyond horizon does not flag', () => {
    expect(expiringUnused(g('weekly_all', 60, { resetsAt: '2026-07-03T22:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
  test('too little unused does not flag', () => {
    expect(expiringUnused(g('weekly_all', 80, { resetsAt: '2026-07-03T20:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
  test('past reset or unstarted window does not flag', () => {
    expect(expiringUnused(g('weekly_all', 10, { resetsAt: '2026-07-03T17:00:00Z' }), DEFAULT_CONFIG, NOW)).toBe(false);
    expect(expiringUnused(g('weekly_all', 10, { resetsAt: null }), DEFAULT_CONFIG, NOW)).toBe(false);
  });
});
