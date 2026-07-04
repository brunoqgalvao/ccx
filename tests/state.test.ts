import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, loadConfig, loadState, saveState } from '../src/state';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccx-test-'));
  process.env.CCX_DIR = dir;
});
afterEach(() => {
  delete process.env.CCX_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('state persistence', () => {
  test('loadState returns empty state when file is missing', () => {
    expect(loadState()).toEqual(emptyState());
  });
  test('loadState returns empty state when file is corrupt', () => {
    writeFileSync(join(dir, 'state.json'), '{not json');
    expect(loadState()).toEqual(emptyState());
  });
  test('saveState round-trips and sets mode 0600', () => {
    const s = emptyState();
    s.activeAccount = 'personal';
    s.accounts.personal = { accountUuid: 'u-1', email: 'a@b.c' };
    saveState(s);
    expect(loadState()).toEqual(s);
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
  });
  test('loadConfig merges file over defaults', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ switchMinResetWaitMin: 10 }));
    const cfg = loadConfig();
    expect(cfg.switchMinResetWaitMin).toBe(10);
    expect(cfg.pollMinIntervalS).toBe(300);
  });
  test('loadConfig returns defaults when file missing or corrupt', () => {
    expect(loadConfig().warningPct).toBe(75);
    writeFileSync(join(dir, 'config.json'), 'nope');
    expect(loadConfig().warningPct).toBe(75);
  });
});
