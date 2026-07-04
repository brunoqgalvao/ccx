import { describe, expect, test } from 'bun:test';
import { buildSegment } from '../src/statusline';
import type { Gauge } from '../src/types';
import { fakeDeps } from './fakes';

const NOW = new Date('2026-07-03T18:00:00Z');

function g(kind: Gauge['kind'], percent: number, severity: Gauge['severity'] = 'normal'): Gauge {
  return { kind, percent, severity, resetsAt: '2026-07-04T18:00:00Z', scopeModel: kind === 'weekly_scoped' ? 'Fable' : null, isActive: severity === 'critical' };
}

describe('buildSegment', () => {
  test('renders both accounts with active marker, gauges, and severity marks', () => {
    const d = fakeDeps();
    d.state.activeAccount = 'personal';
    d.state.accounts.personal = {
      accountUuid: 'u1', email: 'e1',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'statusline', gauges: [g('session', 23), g('weekly_all', 44), g('weekly_scoped', 75, 'warning')] },
    };
    d.state.accounts.work = {
      accountUuid: 'u2', email: 'e2',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [g('session', 4), g('weekly_all', 12)] },
    };
    const seg = buildSegment(d.state, d.cfg, NOW);
    expect(seg).toBe('⚡personal 5h23% wk44% F75%! │ work 5h4% wk12%');
  });
  test('marks stale snapshots and accounts needing login', () => {
    const d = fakeDeps();
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: '2026-07-03T10:00:00Z', source: 'poll', gauges: [g('session', 5)] },
    };
    d.state.accounts.b = { accountUuid: 'u2', email: 'e2', needsLogin: true };
    const seg = buildSegment(d.state, d.cfg, NOW);
    expect(seg).toBe('a 5h5%? │ b ⚠login');
  });
  test('critical gauge gets ✗ mark', () => {
    const d = fakeDeps();
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [g('session', 100, 'critical')] },
    };
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('a 5h100%✗');
  });
});
