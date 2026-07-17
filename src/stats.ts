import type { Deps } from './deps';
import { readHistory, type HistoryRecord } from './history';
import type { Gauge } from './types';

const DAY_MS = 86_400_000;
const BLOCKS = '▁▂▃▄▅▆▇█';

export interface GaugeStats {
  now: number;
  avg: number;
  peak: number;
}

/** '7d' | '30d' | 'YYYY-MM-DD' → epoch ms; undefined → 7 days back; null on garbage. */
export function parseSince(arg: string | undefined, now: Date): number | null {
  if (arg === undefined) return now.getTime() - 7 * DAY_MS;
  const days = arg.match(/^(\d+)d$/);
  if (days) return now.getTime() - Number(days[1]) * DAY_MS;
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    const t = Date.parse(`${arg}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function gaugeKey(g: Gauge): string {
  return g.scopeModel ? `${g.kind} [${g.scopeModel}]` : g.kind;
}

export function summarize(records: HistoryRecord[]): Map<string, Map<string, GaugeStats>> {
  const acc = new Map<string, Map<string, { latestTs: number; latest: number; sum: number; n: number; peak: number }>>();
  for (const r of records) {
    const t = Date.parse(r.ts);
    let gauges = acc.get(r.account);
    if (!gauges) acc.set(r.account, (gauges = new Map()));
    for (const g of r.gauges) {
      const key = gaugeKey(g);
      const cur = gauges.get(key) ?? { latestTs: -Infinity, latest: 0, sum: 0, n: 0, peak: 0 };
      if (t >= cur.latestTs) { cur.latestTs = t; cur.latest = g.percent; }
      cur.sum += g.percent;
      cur.n += 1;
      cur.peak = Math.max(cur.peak, g.percent);
      gauges.set(key, cur);
    }
  }
  const out = new Map<string, Map<string, GaugeStats>>();
  for (const [account, gauges] of acc) {
    const m = new Map<string, GaugeStats>();
    for (const [key, s] of gauges) m.set(key, { now: s.latest, avg: s.sum / s.n, peak: s.peak });
    out.set(account, m);
  }
  return out;
}

/** Peak percent per UTC day over [sinceMs, untilMs]; null for days with no records. */
export function dailyPeaks(records: HistoryRecord[], account: string, key: string, sinceMs: number, untilMs: number): (number | null)[] {
  const firstDay = Math.floor(sinceMs / DAY_MS);
  const lastDay = Math.floor(untilMs / DAY_MS);
  const peaks: (number | null)[] = Array.from({ length: lastDay - firstDay + 1 }, () => null);
  for (const r of records) {
    if (r.account !== account) continue;
    const day = Math.floor(Date.parse(r.ts) / DAY_MS) - firstDay;
    if (day < 0 || day >= peaks.length) continue;
    for (const g of r.gauges) {
      if (gaugeKey(g) !== key) continue;
      peaks[day] = Math.max(peaks[day] ?? 0, g.percent);
    }
  }
  return peaks;
}

export function sparkline(values: (number | null)[]): string {
  return values
    .map((v) => {
      if (v === null) return '·';
      const idx = Math.max(0, Math.ceil((v / 100) * BLOCKS.length) - 1);
      return BLOCKS[Math.min(BLOCKS.length - 1, idx)];
    })
    .join('');
}

export function renderStats(records: HistoryRecord[], sinceMs: number, untilMs: number, onlyAccount?: string): string {
  const filtered = onlyAccount ? records.filter((r) => r.account === onlyAccount) : records;
  if (filtered.length === 0) {
    return 'no history yet — records accrue from polls (statusline/warm/status keep them coming)';
  }
  const summary = summarize(filtered);
  const lines: string[] = [];
  const days = Math.round((untilMs - sinceMs) / DAY_MS);
  lines.push(`last ${days}d · ${filtered.length} records`);
  for (const [account, gauges] of [...summary.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${account}`);
    const width = Math.max(...[...gauges.keys()].map((k) => k.length));
    for (const [key, s] of [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let line = `   ${key.padEnd(width)}  now ${String(Math.round(s.now)).padStart(3)}%  avg ${String(Math.round(s.avg)).padStart(3)}%  peak ${String(Math.round(s.peak)).padStart(3)}%`;
      if (key.startsWith('weekly')) line += `  ${sparkline(dailyPeaks(filtered, account, key, sinceMs, untilMs))}`;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

export async function runStats(d: Deps, args: string[]): Promise<number> {
  const accountIdx = args.indexOf('--account');
  const account = accountIdx >= 0 ? args[accountIdx + 1] : undefined;
  if (accountIdx >= 0 && !account) { console.error('usage: ccx stats [--since 7d|YYYY-MM-DD] [--account <name>]'); return 1; }
  const sinceIdx = args.indexOf('--since');
  const sinceMs = parseSince(sinceIdx >= 0 ? args[sinceIdx + 1] : undefined, d.now());
  if (sinceMs === null) { console.error('ccx: bad --since (use 7d, 30d, or YYYY-MM-DD)'); return 1; }
  const untilMs = d.now().getTime();
  console.log(renderStats(readHistory(sinceMs, untilMs), sinceMs, untilMs, account));
  return 0;
}
