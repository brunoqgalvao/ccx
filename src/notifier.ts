import type { Deps } from './deps';
import type { GaugeKind, Severity } from './types';

const RANK: Record<Severity, number> = { normal: 0, warning: 1, critical: 2 };
const THROTTLE_MS = 60 * 60_000;
const GAUGE_NAME: Record<GaugeKind, string> = {
  session: '5h session', weekly_all: 'weekly', weekly_scoped: 'scoped weekly',
};

export function checkAndNotify(d: Deps): void {
  const now = d.now();
  const pending: Array<{ title: string; message: string }> = [];
  let dirty = false;
  for (const [name, account] of Object.entries(d.state.accounts)) {
    for (const gauge of account.snapshot?.gauges ?? []) {
      const key = `${name}:${gauge.kind}${gauge.scopeModel != null ? `:${gauge.scopeModel}` : ''}`;
      const prev = d.state.notifier.lastSeverity[key] ?? 'normal';
      if (gauge.severity === prev) continue;
      if (RANK[gauge.severity] > RANK[prev]) {
        const lastAt = d.state.notifier.lastNotified[key];
        const inWindow = lastAt !== undefined && now.getTime() - Date.parse(lastAt) < THROTTLE_MS;
        // escalations PAST the severity we last notified about bypass the throttle
        const lastNotifiedSev = d.state.notifier.lastNotifiedSeverity[key] ?? 'normal';
        if (!inWindow || RANK[gauge.severity] > RANK[lastNotifiedSev]) {
          const scope = gauge.scopeModel ? ` (${gauge.scopeModel})` : '';
          pending.push({
            title: `ccx: ${name} ${gauge.severity}`,
            message: `${GAUGE_NAME[gauge.kind]}${scope} at ${Math.round(gauge.percent)}%${gauge.resetsAt ? `, resets ${new Date(gauge.resetsAt).toLocaleTimeString()}` : ''}`,
          });
          d.state.notifier.lastNotified[key] = now.toISOString();
          d.state.notifier.lastNotifiedSeverity[key] = gauge.severity;
        }
      }
      d.state.notifier.lastSeverity[key] = gauge.severity;
      dirty = true;
    }
  }
  // persist BEFORE notifying: if saveState throws, an unrecorded transition must not have
  // been announced — or every ~300ms statusline tick would re-announce it (osascript spam)
  if (dirty) d.saveState(d.state);
  for (const { title, message } of pending) d.notify(title, message);
}

export function osascriptNotify(title: string, message: string): void {
  Bun.spawn(
    ['osascript', '-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    { stdout: 'ignore', stderr: 'ignore' },
  );
}
