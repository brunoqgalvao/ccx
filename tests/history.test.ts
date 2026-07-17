import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, historyDir, readHistory } from '../src/history';
import type { Gauge } from '../src/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccx-test-'));
  process.env.CCX_DIR = dir;
});
afterEach(() => {
  delete process.env.CCX_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const gauge = (percent: number, kind: Gauge['kind'] = 'session', scopeModel: string | null = null): Gauge => ({
  kind, percent, severity: 'normal', resetsAt: '2026-07-17T00:00:00Z', scopeModel, isActive: false,
});

describe('appendHistory', () => {
  test('appends one JSONL record to the UTC monthly file', () => {
    appendHistory('personal', [gauge(12)], new Date('2026-07-16T13:00:00Z'));
    const lines = readFileSync(join(historyDir(), '2026-07.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      ts: '2026-07-16T13:00:00.000Z',
      account: 'personal',
      gauges: [gauge(12)],
    });
  });
  test('successive appends accumulate lines', () => {
    appendHistory('a', [gauge(1)], new Date('2026-07-16T13:00:00Z'));
    appendHistory('b', [gauge(2)], new Date('2026-07-16T13:05:00Z'));
    const lines = readFileSync(join(historyDir(), '2026-07.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
  test('month boundary uses UTC, not local time', () => {
    appendHistory('a', [gauge(1)], new Date('2026-07-31T23:59:00Z'));
    appendHistory('a', [gauge(2)], new Date('2026-08-01T00:01:00Z'));
    expect(readFileSync(join(historyDir(), '2026-07.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(historyDir(), '2026-08.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  test('write failure is swallowed (history must never break polling)', () => {
    mkdirSync(historyDir(), { recursive: true });
    chmodSync(historyDir(), 0o400);
    try {
      expect(() => appendHistory('a', [gauge(1)], new Date('2026-07-16T13:00:00Z'))).not.toThrow();
    } finally {
      chmodSync(historyDir(), 0o700);
    }
  });
});

describe('readHistory', () => {
  test('returns records within [sinceMs, untilMs], across month files', () => {
    appendHistory('a', [gauge(1)], new Date('2026-06-30T12:00:00Z'));
    appendHistory('a', [gauge(2)], new Date('2026-07-01T12:00:00Z'));
    appendHistory('a', [gauge(3)], new Date('2026-07-10T12:00:00Z'));
    const records = readHistory(Date.parse('2026-06-30T00:00:00Z'), Date.parse('2026-07-05T00:00:00Z'));
    expect(records.map((r) => r.gauges[0].percent)).toEqual([1, 2]);
  });
  test('skips malformed lines and foreign files', () => {
    appendHistory('a', [gauge(1)], new Date('2026-07-16T13:00:00Z'));
    const file = join(historyDir(), '2026-07.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8') + '{broken\n[]\n');
    writeFileSync(join(historyDir(), 'notes.txt'), 'not history');
    const records = readHistory(Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-08-01T00:00:00Z'));
    expect(records).toHaveLength(1);
    expect(records[0].account).toBe('a');
  });
  test('returns empty when history dir does not exist', () => {
    expect(readHistory(0, Date.parse('2026-08-01T00:00:00Z'))).toEqual([]);
  });
});
