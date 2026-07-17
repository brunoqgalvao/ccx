import { describe, expect, test } from 'bun:test';
import { anchorsCompatible, deriveSeverity, mergeStatusline, parseStatusline, parseUsageResponse } from '../src/snapshots';
import { DEFAULT_CONFIG } from '../src/state';
import usageFixture from '../fixtures/usage-response.json';
import statuslineFixture from '../fixtures/statusline-input.json';

const NOW = new Date('2026-07-03T18:00:00Z');

describe('parseUsageResponse', () => {
  test('maps all three gauge kinds from the limits array', () => {
    const gauges = parseUsageResponse(usageFixture);
    expect(gauges).toHaveLength(3);
    const scoped = gauges.find((g) => g.kind === 'weekly_scoped')!;
    expect(scoped.percent).toBe(75);
    expect(scoped.severity).toBe('warning');
    expect(scoped.scopeModel).toBe('Fable');
    expect(scoped.isActive).toBe(true);
  });
  test('keeps resets_at null for a not-yet-started window (no fabricated timestamp)', () => {
    const gauges = parseUsageResponse({ limits: [{
      kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
      resets_at: null, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false,
    }] });
    expect(gauges).toHaveLength(1);
    expect(gauges[0].resetsAt).toBeNull();
  });
  test('tolerates unknown kinds and missing limits array', () => {
    expect(parseUsageResponse({ limits: [{ kind: "martian", percent: 1 }] })).toHaveLength(0);
    expect(parseUsageResponse({})).toHaveLength(0);
    expect(parseUsageResponse(null)).toHaveLength(0);
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
  test('malformed resets_at does not throw (falls back to null, not a fabricated epoch)', () => {
    const { gauges } = parseStatusline(
      { rate_limits: { five_hour: { used_percentage: 10, resets_at: 'soon' } } },
      DEFAULT_CONFIG,
    );
    expect(gauges).toHaveLength(1);
    expect(gauges[0].resetsAt).toBeNull();
  });
});

describe('mergeStatusline', () => {
  test('replaces session/weekly_all but preserves scoped gauges from previous poll', () => {
    const prevGauges = parseUsageResponse(usageFixture);
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
    const prev = { fetchedAt: '2026-07-03T17:00:00Z', source: 'poll' as const, gauges: parseUsageResponse(usageFixture) };
    expect(mergeStatusline(prev, { model: 'x', gauges: [] }, NOW)).toBe(prev);
  });
});

describe('anchorsCompatible', () => {
  // the real-world corruption this guards against: a session labeled account A
  // (CCX_ACCOUNT survives a broken env-token pin) is actually consuming account B,
  // so its stdin weekly anchor is B's — merging would file B's gauges under A.
  const mk = (kind: 'session' | 'weekly_all' | 'weekly_scoped', resetsAt: string | null, scopeModel: string | null = null) =>
    ({ kind, percent: 50, severity: 'normal' as const, resetsAt, scopeModel, isActive: false });
  const snap = (source: 'poll' | 'statusline', gauges: any[]) =>
    ({ fetchedAt: '2026-07-17T12:00:00Z', source, gauges });
  const parsedWk = (resetsAt: string | null) => ({ gauges: [mk('session', '2026-07-17T16:20:00Z'), mk('weekly_all', resetsAt)] });

  test('accepts when stdin weekly anchor matches the scoped gauge anchor within tolerance', () => {
    const prev = snap('statusline', [mk('weekly_scoped', '2026-07-19T06:59:59.960121+00:00', 'Fable')]);
    expect(anchorsCompatible(prev, parsedWk('2026-07-19T07:00:00.000Z'))).toBe(true);
  });
  test('rejects when stdin weekly anchor belongs to a different account', () => {
    const prev = snap('statusline', [mk('weekly_scoped', '2026-07-19T06:59:59.960121+00:00', 'Fable')]);
    expect(anchorsCompatible(prev, parsedWk('2026-07-18T13:00:00.000Z'))).toBe(false);
  });
  test('falls back to a poll-sourced weekly_all anchor when scoped has no reset', () => {
    const prev = snap('poll', [mk('weekly_scoped', null, 'Fable'), mk('weekly_all', '2026-07-21T16:00:00.087720+00:00')]);
    expect(anchorsCompatible(prev, parsedWk('2026-07-18T13:00:00.000Z'))).toBe(false);
    expect(anchorsCompatible(prev, parsedWk('2026-07-21T16:00:00.000Z'))).toBe(true);
  });
  test('never trusts a statusline-sourced weekly_all as the anchor', () => {
    // prev was already contaminated by a mislabeled session — its weekly_all anchor is
    // the WRONG account's; trusting it would let the contamination self-confirm forever
    const prev = snap('statusline', [mk('weekly_scoped', null, 'Fable'), mk('weekly_all', '2026-07-18T13:00:00.000Z')]);
    expect(anchorsCompatible(prev, parsedWk('2026-07-18T13:00:00.000Z'))).toBe(true); // no trusted anchor -> accept
  });
  test('accepts when there is nothing to discriminate on', () => {
    expect(anchorsCompatible(undefined, parsedWk('2026-07-18T13:00:00Z'))).toBe(true);
    const prev = snap('poll', [mk('weekly_all', '2026-07-21T16:00:00Z')]);
    expect(anchorsCompatible(prev, { gauges: [mk('session', '2026-07-17T16:20:00Z')] })).toBe(true);
    expect(anchorsCompatible(prev, parsedWk(null))).toBe(true);
  });
});
