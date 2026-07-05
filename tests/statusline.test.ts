import { describe, expect, test } from 'bun:test';
import { buildSegment, fmtEta } from '../src/statusline';
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
    expect(seg).toBe('⚡personal 5h23%·1d wk44%·1d F75%! │ work 5h4%·1d wk12%·1d');
  });
  test('marks stale snapshots and accounts needing login', () => {
    const d = fakeDeps();
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: '2026-07-03T10:00:00Z', source: 'poll', gauges: [g('session', 5)] },
    };
    d.state.accounts.b = { accountUuid: 'u2', email: 'e2', needsLogin: true };
    const seg = buildSegment(d.state, d.cfg, NOW);
    expect(seg).toBe('a 5h5%·1d? │ b ⚠login');
  });
  test('critical gauge gets ✗ mark', () => {
    const d = fakeDeps();
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [g('session', 100, 'critical')] },
    };
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('a 5h100%·1d✗');
  });
});

describe('fmtEta', () => {
  test('compact buckets', () => {
    expect(fmtEta(-5)).toBe(''); // past reset = idle window, not worth pixels
    expect(fmtEta(42 * 60_000)).toBe('42m');
    expect(fmtEta((2 * 60 + 49) * 60_000)).toBe('2h49m');
    expect(fmtEta(3 * 3600_000)).toBe('3h');
    expect(fmtEta((2 * 24 + 19) * 3600_000)).toBe('2d19h');
    expect(fmtEta(3 * 24 * 3600_000)).toBe('3d');
  });
  test('unparseable reset yields empty string', () => {
    expect(fmtEta(NaN)).toBe('');
  });
});

describe('use-it-or-lose-it nudge', () => {
  test('gauge resetting soon with big unused headroom gets the burn marker', () => {
    const d = fakeDeps();
    const soon = new Date(NOW.getTime() + 40 * 60_000).toISOString(); // 40m out, inside 60m nudge window
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [
        { kind: 'session', percent: 8, severity: 'normal', resetsAt: soon, scopeModel: null, isActive: false },
      ] },
    };
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('a 5h8%·40m🔥');
  });
  test('no marker when nearly used up or reset is far', () => {
    const d = fakeDeps();
    const soon = new Date(NOW.getTime() + 40 * 60_000).toISOString();
    const far = new Date(NOW.getTime() + 5 * 3600_000).toISOString();
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [
        { kind: 'session', percent: 90, severity: 'warning', resetsAt: soon, scopeModel: null, isActive: false },
        { kind: 'weekly_all', percent: 8, severity: 'normal', resetsAt: far, scopeModel: null, isActive: false },
      ] },
    };
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('a 5h90%·40m! wk8%·5h');
  });
});
