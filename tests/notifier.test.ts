import { describe, expect, test } from 'bun:test';
import { checkAndNotify } from '../src/notifier';
import type { Gauge, Snapshot } from '../src/types';
import { fakeDeps } from './fakes';

const NOW = new Date('2026-07-03T18:00:00Z');

function g(kind: Gauge['kind'], percent: number, severity: Gauge['severity']): Gauge {
  return { kind, percent, severity, resetsAt: '2026-07-04T18:00:00Z', scopeModel: kind === 'weekly_scoped' ? 'Fable' : null, isActive: false };
}
function withSnapshot(gauges: Gauge[]) {
  const d = fakeDeps();
  d.state.accounts.personal = {
    accountUuid: 'u', email: 'e',
    snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges } satisfies Snapshot,
  };
  return d;
}

describe('checkAndNotify', () => {
  test('notifies on upward severity transition', () => {
    const d = withSnapshot([g('weekly_scoped', 75, 'warning')]);
    checkAndNotify(d);
    expect(d.notifications).toHaveLength(1);
    expect(d.notifications[0]).toContain('personal');
  });
  test('no repeat notification for the same severity', () => {
    const d = withSnapshot([g('weekly_scoped', 75, 'warning')]);
    checkAndNotify(d);
    checkAndNotify(d);
    expect(d.notifications).toHaveLength(1);
  });
  test('downward transition resets silently, re-escalation within the hour is throttled', () => {
    const d = withSnapshot([g('session', 80, 'warning')]);
    checkAndNotify(d);
    d.state.accounts.personal.snapshot!.gauges = [g('session', 10, 'normal')];
    checkAndNotify(d);
    expect(d.notifications).toHaveLength(1); // no notification for improvement
    d.state.accounts.personal.snapshot!.gauges = [g('session', 80, 'warning')];
    checkAndNotify(d); // second escalation 0 min later → throttled
    expect(d.notifications).toHaveLength(1);
  });
  test('state is persisted before notifications fire (no spam when saveState throws)', () => {
    const d = withSnapshot([g('weekly_scoped', 75, 'warning')]);
    d.saveState = () => { throw new Error('disk full'); };
    expect(() => checkAndNotify(d)).toThrow();
    expect(d.notifications).toHaveLength(0); // never announced a transition we failed to record
  });
  test('warning→critical escalates even within the throttle window', () => {
    const d = withSnapshot([g('session', 80, 'warning')]);
    checkAndNotify(d);
    d.state.accounts.personal.snapshot!.gauges = [g('session', 96, 'critical')];
    checkAndNotify(d);
    expect(d.notifications).toHaveLength(2);
  });
});
