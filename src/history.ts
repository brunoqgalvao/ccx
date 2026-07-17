import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ccxDir } from './state';
import type { Gauge } from './types';

export interface HistoryRecord {
  ts: string; // ISO 8601 UTC
  account: string;
  gauges: Gauge[];
}

export function historyDir(): string {
  return join(ccxDir(), 'history');
}

function monthName(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 7); // YYYY-MM, UTC
}

export function appendHistory(account: string, gauges: Gauge[], now: Date): void {
  try {
    const dir = historyDir();
    mkdirSync(dir, { recursive: true });
    const record: HistoryRecord = { ts: now.toISOString(), account, gauges };
    appendFileSync(join(dir, `${monthName(now.getTime())}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {
    // best-effort: a full disk or bad permissions must never break polling
  }
}

export function readHistory(sinceMs: number, untilMs: number): HistoryRecord[] {
  let files: string[];
  try {
    files = readdirSync(historyDir());
  } catch {
    return [];
  }
  const wanted = files
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .filter((f) => {
      const month = f.slice(0, 7);
      return month >= monthName(sinceMs) && month <= monthName(untilMs);
    })
    .sort();
  const records: HistoryRecord[] = [];
  for (const file of wanted) {
    let raw: string;
    try {
      raw = readFileSync(join(historyDir(), file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const r = rec as HistoryRecord;
      if (typeof r?.ts !== 'string' || typeof r?.account !== 'string' || !Array.isArray(r?.gauges)) continue;
      const t = Date.parse(r.ts);
      if (Number.isNaN(t) || t < sinceMs || t > untilMs) continue;
      records.push(r);
    }
  }
  return records;
}
