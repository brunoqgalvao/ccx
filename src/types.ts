export type GaugeKind = 'session' | 'weekly_all' | 'weekly_scoped';
export type Severity = 'normal' | 'warning' | 'critical';

export interface Gauge {
  kind: GaugeKind;
  percent: number;
  severity: Severity;
  resetsAt: string;            // ISO 8601
  scopeModel: string | null;   // e.g. "Fable" for weekly_scoped
  isActive: boolean;
}

export interface Snapshot {
  fetchedAt: string;           // ISO 8601
  source: 'statusline' | 'poll';
  model?: string;              // session's current model id (statusline-sourced only)
  gauges: Gauge[];
}

export interface AccountState {
  accountUuid: string;
  email: string;
  snapshot?: Snapshot;
  lastPoll?: string;           // ISO 8601
  refreshTokenHash?: string;   // sha256 hex of refresh token as last written by ccx
  needsLogin?: boolean;
}

export interface NotifierState {
  lastSeverity: Record<string, Severity>;          // key: `${account}:${kind}[:${scopeModel}]`
  lastNotified: Record<string, string>;            // key → ISO timestamp of last notification
  lastNotifiedSeverity: Record<string, Severity>;  // key → severity AT last notification (throttle bypass on escalation)
}

export interface State {
  activeAccount: string | null;
  syncPending: boolean;
  accounts: Record<string, AccountState>;
  notifier: NotifierState;
}

export interface Config {
  switchMinResetWaitMin: number;   // 30
  pollMinIntervalS: number;        // 300
  staleAfterMin: number;           // 30
  tiebreakMargin: number;          // 5
  warningPct: number;              // 75
  criticalPct: number;             // 95
  downgradeModel: string;          // "opus"
  statuslinePassthrough: string;   // "bun x ccusage statusline"
  statuslineTeePath: string;       // onwatch bridge file
  claudeCodeUaVersion: string;     // "2.1.199"
  skipPermissions: boolean;        // true — append --dangerously-skip-permissions to every claude spawn
  runMinTokenTtlMin: number;       // 360 — `ccx run`/`ccx refresh` refresh a vault token with less than this many minutes left
}
