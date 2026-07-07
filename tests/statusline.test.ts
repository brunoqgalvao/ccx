import { describe, expect, test } from 'bun:test';
import { buildBasicSegment, buildEtaLine, buildSegment, composeFirstLine, fmtEta } from '../src/statusline';
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
    d.cfg.statuslineEta = 'inline';
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
    d.cfg.statuslineEta = 'inline';
    const seg = buildSegment(d.state, d.cfg, NOW);
    expect(seg).toBe('a 5h5%·1d? │ b ⚠login');
  });
  test('critical gauge gets ✗ mark', () => {
    const d = fakeDeps();
    d.state.accounts.a = {
      accountUuid: 'u', email: 'e',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [g('session', 100, 'critical')] },
    };
    d.cfg.statuslineEta = 'inline';
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('a 5h100%·1d✗');
  });
});

describe('buildBasicSegment', () => {
  const full = {
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    context_window: { used_percentage: 5 },
    effort: { level: 'medium' },
  };
  test('renders model, context, and abbreviated effort', () => {
    const d = fakeDeps();
    expect(buildBasicSegment(full, d.cfg)).toBe('Fable 5 · ctx 5% · med');
  });
  test('context at 80%+ gets the warning mark', () => {
    const d = fakeDeps();
    expect(buildBasicSegment({ ...full, context_window: { used_percentage: 83 } }, d.cfg)).toBe('Fable 5 · ctx 83%! · med');
  });
  test('non-medium efforts render verbatim', () => {
    const d = fakeDeps();
    expect(buildBasicSegment({ ...full, effort: { level: 'xhigh' } }, d.cfg)).toBe('Fable 5 · ctx 5% · xhigh');
  });
  test('missing fields are skipped; all missing yields empty string', () => {
    const d = fakeDeps();
    expect(buildBasicSegment({ model: { display_name: 'Fable 5' } }, d.cfg)).toBe('Fable 5');
    expect(buildBasicSegment({ context_window: { used_percentage: 12 } }, d.cfg)).toBe('ctx 12%');
    expect(buildBasicSegment({}, d.cfg)).toBe('');
    expect(buildBasicSegment(null, d.cfg)).toBe('');
    expect(buildBasicSegment('garbage', d.cfg)).toBe('');
  });
  test('fractional context percentage rounds', () => {
    const d = fakeDeps();
    expect(buildBasicSegment({ context_window: { used_percentage: 57.6 } }, d.cfg)).toBe('ctx 58%');
  });
  test('statuslineBasic: false disables the segment', () => {
    const d = fakeDeps();
    d.cfg.statuslineBasic = false;
    expect(buildBasicSegment(full, d.cfg)).toBe('');
  });
});

describe('composeFirstLine', () => {
  test('passthrough leads, basic and accounts join with the segment separator', () => {
    expect(composeFirstLine('cc$1.19', 'Fable 5 · ctx 5% · med', 'a 5h5%')).toBe('cc$1.19 Fable 5 · ctx 5% · med │ a 5h5%');
  });
  test('empty pieces vanish without stray separators', () => {
    expect(composeFirstLine('', 'Fable 5', 'a 5h5%')).toBe('Fable 5 │ a 5h5%');
    expect(composeFirstLine('', '', 'a 5h5%')).toBe('a 5h5%');
    expect(composeFirstLine('cc$1.19', '', 'a 5h5%')).toBe('cc$1.19 a 5h5%');
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
    d.cfg.statuslineEta = 'inline';
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
    d.cfg.statuslineEta = 'inline';
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('a 5h90%·40m! wk8%·5h');
  });
});

describe('statuslineEta modes', () => {
  function twoAccounts() {
    const d = fakeDeps();
    d.state.activeAccount = 'work';
    d.state.accounts.work = {
      accountUuid: 'u1', email: 'e1',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'statusline', gauges: [
        { kind: 'session', percent: 7, severity: 'normal', resetsAt: new Date(NOW.getTime() + (3 * 60 + 2) * 60_000).toISOString(), scopeModel: null, isActive: false },
        { kind: 'weekly_all', percent: 28, severity: 'normal', resetsAt: new Date(NOW.getTime() + (2 * 24 + 15) * 3600_000).toISOString(), scopeModel: null, isActive: false },
      ] },
    };
    d.state.accounts.idle = {
      accountUuid: 'u2', email: 'e2',
      snapshot: { fetchedAt: NOW.toISOString(), source: 'poll', gauges: [
        { kind: 'session', percent: 0, severity: 'normal', resetsAt: new Date(NOW.getTime() - 1000).toISOString(), scopeModel: null, isActive: false },
      ] },
    };
    return d;
  }
  test('default (line2): first line stays clean, eta line carries the countdowns', () => {
    const d = twoAccounts();
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('⚡work 5h7% wk28% │ idle 5h0%');
    expect(buildEtaLine(d.state, d.cfg, NOW)).toBe('↻ work 5h 3h2m · wk 2d15h');
  });
  test('off: no inline etas and no eta line', () => {
    const d = twoAccounts();
    d.cfg.statuslineEta = 'off';
    expect(buildSegment(d.state, d.cfg, NOW)).toBe('⚡work 5h7% wk28% │ idle 5h0%');
    expect(buildEtaLine(d.state, d.cfg, NOW)).toBe('');
  });
  test('inline: no separate eta line', () => {
    const d = twoAccounts();
    d.cfg.statuslineEta = 'inline';
    expect(buildEtaLine(d.state, d.cfg, NOW)).toBe('');
  });
  test('eta line empty when no window has a future reset', () => {
    const d = twoAccounts();
    delete d.state.accounts.work;
    expect(buildEtaLine(d.state, d.cfg, NOW)).toBe('');
  });
});
