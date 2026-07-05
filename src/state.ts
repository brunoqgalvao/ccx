import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types';

export const DEFAULT_CONFIG: Config = {
  switchMinResetWaitMin: 30,
  pollMinIntervalS: 300,
  staleAfterMin: 30,
  tiebreakMargin: 5,
  warningPct: 75,
  criticalPct: 95,
  downgradeModel: 'opus',
  statuslinePassthrough: 'bun x ccusage statusline',
  statuslineTeePath: join(homedir(), '.onwatch/data/anthropic-statusline.json'),
  claudeCodeUaVersion: '2.1.199',
  skipPermissions: true,
  runMinTokenTtlMin: 360,
  expiryNudgeMin: 60,
  statuslineEta: 'line2',
  expiryNudgeUnusedPct: 25,
};

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { State } from './types';

export function ccxDir(): string {
  return process.env.CCX_DIR ?? join(homedir(), '.ccx');
}

export function emptyState(): State {
  return {
    activeAccount: null, syncPending: false, accounts: {},
    notifier: { lastSeverity: {}, lastNotified: {}, lastNotifiedSeverity: {} },
  };
}

function readJson(path: string): unknown | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function loadState(): State {
  const raw = readJson(join(ccxDir(), 'state.json')) as State | null;
  if (!raw || typeof raw !== 'object' || !raw.accounts) return emptyState();
  return { ...emptyState(), ...raw, notifier: { ...emptyState().notifier, ...raw.notifier } };
}

export function saveState(state: State): void {
  const dir = ccxDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(dir, 'state.json'));
}

export function loadConfig(): Config {
  const raw = readJson(join(ccxDir(), 'config.json'));
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...(raw as Partial<Config>) };
}
