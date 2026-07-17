import { describe, expect, test } from 'bun:test';
import type { HistoryRecord } from '../src/history';
import { dailyPeaks, parseSince, renderStats, sparkline, summarize } from '../src/stats';
import type { Gauge } from '../src/types';

const NOW = new Date('2026-07-16T12:00:00Z');

const gauge = (percent: number, kind: Gauge['kind'] = 'session', scopeModel: string | null = null): Gauge => ({
  kind, percent, severity: 'normal', resetsAt: null, scopeModel, isActive: false,
});

const rec = (ts: string, account: string, gauges: Gauge[]): HistoryRecord => ({ ts, account, gauges });

describe('parseSince', () => {
  test('defaults to 7 days back', () => {
    expect(parseSince(undefined, NOW)).toBe(NOW.getTime() - 7 * 86_400_000);
  });
  test('parses Nd', () => {
    expect(parseSince('30d', NOW)).toBe(NOW.getTime() - 30 * 86_400_000);
  });
  test('parses an ISO date', () => {
    expect(parseSince('2026-07-01', NOW)).toBe(Date.parse('2026-07-01T00:00:00Z'));
  });
  test('rejects garbage', () => {
    expect(parseSince('yesterday-ish', NOW)).toBeNull();
  });
});

describe('summarize', () => {
  const records = [
    rec('2026-07-14T10:00:00Z', 'pqg', [gauge(20), gauge(5, 'weekly_all')]),
    rec('2026-07-15T10:00:00Z', 'pqg', [gauge(80), gauge(10, 'weekly_all')]),
    rec('2026-07-15T11:00:00Z', 'bqg', [gauge(50, 'weekly_scoped', 'Fable')]),
  ];
  test('per account per gauge key: now is latest, avg and peak over range', () => {
    const s = summarize(records);
    const session = s.get('pqg')!.get('session')!;
    expect(session.now).toBe(80);
    expect(session.peak).toBe(80);
    expect(session.avg).toBe(50);
    expect(s.get('pqg')!.get('weekly_all')!.now).toBe(10);
  });
  test('scoped gauges key by model name', () => {
    const s = summarize(records);
    expect(s.get('bqg')!.get('weekly_scoped [Fable]')!.now).toBe(50);
  });
  test('records out of ts order still yield the latest as now', () => {
    const s = summarize([records[1], records[0]]);
    expect(s.get('pqg')!.get('session')!.now).toBe(80);
  });
});

describe('dailyPeaks + sparkline', () => {
  test('dailyPeaks buckets by UTC day, null for gap days', () => {
    const records = [
      rec('2026-07-14T10:00:00Z', 'pqg', [gauge(30, 'weekly_all')]),
      rec('2026-07-14T20:00:00Z', 'pqg', [gauge(60, 'weekly_all')]),
      rec('2026-07-16T09:00:00Z', 'pqg', [gauge(90, 'weekly_all')]),
    ];
    const sinceMs = Date.parse('2026-07-14T00:00:00Z');
    expect(dailyPeaks(records, 'pqg', 'weekly_all', sinceMs, NOW.getTime())).toEqual([60, null, 90]);
  });
  test('sparkline maps 0-100 to blocks, gaps to middle dot', () => {
    expect(sparkline([0, 50, 100, null])).toBe('▁▄█·');
  });
});

describe('renderStats', () => {
  const records = [
    rec('2026-07-15T10:00:00Z', 'pqg', [gauge(20), gauge(5, 'weekly_all')]),
    rec('2026-07-16T10:00:00Z', 'pqg', [gauge(80), gauge(10, 'weekly_all')]),
  ];
  test('renders per-account block with now/avg/peak and weekly sparkline', () => {
    const out = renderStats(records, Date.parse('2026-07-09T12:00:00Z'), NOW.getTime());
    expect(out).toContain('pqg');
    expect(out).toContain('session');
    expect(out).toMatch(/now\s+80%/);
    expect(out).toMatch(/peak\s+80%/);
    expect(out.split('\n').find((l) => l.includes('weekly_all'))).toMatch(/[▁▂▃▄▅▆▇█·]/);
  });
  test('filters to a single account when asked', () => {
    const both = [...records, rec('2026-07-16T10:00:00Z', 'bqg', [gauge(9)])];
    const out = renderStats(both, Date.parse('2026-07-09T12:00:00Z'), NOW.getTime(), 'bqg');
    expect(out).toContain('bqg');
    expect(out).not.toContain('pqg');
  });
  test('says so when there is no data', () => {
    expect(renderStats([], 0, NOW.getTime())).toContain('no history');
  });
});
