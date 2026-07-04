import { describe, expect, test } from 'bun:test';
import { deriveSeverity, mergeStatusline, parseStatusline, parseUsageResponse } from '../src/snapshots';
import { DEFAULT_CONFIG } from '../src/state';
import usageFixture from '../fixtures/usage-response.json';
import statuslineFixture from '../fixtures/statusline-input.json';

const NOW = new Date('2026-07-03T18:00:00Z');

describe('parseUsageResponse', () => {
  test('maps all three gauge kinds from the limits array', () => {
    const gauges = parseUsageResponse(usageFixture, NOW);
    expect(gauges).toHaveLength(3);
    const scoped = gauges.find((g) => g.kind === 'weekly_scoped')!;
    expect(scoped.percent).toBe(75);
    expect(scoped.severity).toBe('warning');
    expect(scoped.scopeModel).toBe('Fable');
    expect(scoped.isActive).toBe(true);
  });
  test('tolerates unknown kinds and missing limits array', () => {
    expect(parseUsageResponse({ limits: [{ kind: 'martian', percent: 1 }] }, NOW)).toHaveLength(0);
    expect(parseUsageResponse({}, NOW)).toHaveLength(0);
    expect(parseUsageResponse(null, NOW)).toHaveLength(0);
  });
});

describe('parseStatusline', () => {
  test('maps five_hour/seven_day with unix→ISO and derived severity', () => {
    const { model, gauges } = parseStatusline(statuslineFixture, DEFAULT_CONFIG);
    expect(model).toBe('claude-fable-5');
    expect(gauges).toHaveLength(2);
    const session = gauges.find((g) => g.kind === 'session')!;
    expect(session.percent).toBe(27);
    expect(session.severity).toBe('normal');
    expect(session.resetsAt).toBe(new Date(1783115400 * 1000).toISOString());
  });
  test('derives warning/critical severities from config thresholds', () => {
    expect(deriveSeverity(74, DEFAULT_CONFIG)).toBe('normal');
    expect(deriveSeverity(75, DEFAULT_CONFIG)).toBe('warning');
    expect(deriveSeverity(95, DEFAULT_CONFIG)).toBe('critical');
  });
  test('returns no gauges when rate_limits is absent', () => {
    expect(parseStatusline({ model: { id: 'x' } }, DEFAULT_CONFIG).gauges).toHaveLength(0);
  });
  test('malformed resets_at does not throw (falls back to epoch)', () => {
    const { gauges } = parseStatusline(
      { rate_limits: { five_hour: { used_percentage: 10, resets_at: 'soon' } } },
      DEFAULT_CONFIG,
    );
    expect(gauges).toHaveLength(1);
    expect(gauges[0].resetsAt).toBe(new Date(0).toISOString());
  });
});

describe('mergeStatusline', () => {
  test('replaces session/weekly_all but preserves scoped gauges from previous poll', () => {
    const prevGauges = parseUsageResponse(usageFixture, NOW);
    const prev = { fetchedAt: '2026-07-03T17:00:00Z', source: 'poll' as const, gauges: prevGauges };
    const parsed = parseStatusline(statuslineFixture, DEFAULT_CONFIG);
    const merged = mergeStatusline(prev, parsed, NOW);
    expect(merged.source).toBe('statusline');
    expect(merged.model).toBe('claude-fable-5');
    expect(merged.gauges.find((g) => g.kind === 'session')!.percent).toBe(27);
    expect(merged.gauges.find((g) => g.kind === 'weekly_scoped')!.percent).toBe(75);
  });
  test('works with no previous snapshot', () => {
    const merged = mergeStatusline(undefined, parseStatusline(statuslineFixture, DEFAULT_CONFIG), NOW);
    expect(merged.gauges).toHaveLength(2);
  });
  test('empty statusline parse never wipes or fresh-stamps an existing snapshot', () => {
    const prev = { fetchedAt: '2026-07-03T17:00:00Z', source: 'poll' as const, gauges: parseUsageResponse(usageFixture, NOW) };
    expect(mergeStatusline(prev, { model: 'x', gauges: [] }, NOW)).toBe(prev);
  });
});
