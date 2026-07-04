#!/usr/bin/env bun
import { realApi } from './api';
import type { Deps } from './deps';
import { realKeychain } from './keychain';
import { runLaunch, runSwap } from './launcher';
import { osascriptNotify } from './notifier';
import { loadConfig, loadState, saveState } from './state';
import { runStatus } from './status';
import { runStatusline } from './statusline';
import { runDoctor } from './doctor';
import { importAccount, syncBack } from './vault';

function makeDeps(): Deps {
  const cfg = loadConfig();
  return {
    cfg,
    state: loadState(),
    saveState,
    kc: realKeychain(),
    api: realApi(cfg),
    now: () => new Date(),
    notify: osascriptNotify,
  };
}

const HELP = `ccx — multi-account orchestrator for Claude Code

Usage:
  ccx [claude args...]      pick best account, launch claude
  ccx status [--json]       both accounts: gauges, resets, active marker
  ccx swap [name] [-c]      switch live account (-c: resume with claude --continue)
  ccx import <name> [--force]  capture the current claude login into the vault
  ccx sync                  capture rotated live tokens into the vault
  ccx statusline            statusline bridge (wire into ~/.claude/settings.json)
  ccx doctor                self-checks
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP); // before makeDeps: help must work even when the keychain user is unresolvable
    return 0;
  }

  let d: Deps;
  try {
    d = makeDeps();
  } catch (e) {
    console.error(`ccx: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    // deferred sync retry (spec: "retry on the next ccx invocation")
    if (d.state.syncPending && argv[0] !== 'statusline') {
      const r = await syncBack(d);
      if (!r.ok) console.error(`ccx: deferred sync still failing — ${r.reason}`);
    }
    return await dispatch(d, argv);
  } catch (e) {
    console.error(`ccx: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function dispatch(d: Deps, argv: string[]): Promise<number> {
  switch (argv[0]) {
    case 'status': return runStatus(d, argv.slice(1));
    case 'swap': return runSwap(d, argv.slice(1));
    case 'import': {
      const name = argv[1];
      if (!name || name.startsWith('-')) { console.error('usage: ccx import <name> [--force]'); return 1; }
      const r = await importAccount(d, name, { force: argv.includes('--force') });
      console.error(r.ok ? `ccx: imported "${name}" (${d.state.accounts[name].email})` : `ccx: ${r.reason}`);
      return r.ok ? 0 : 1;
    }
    case 'sync': {
      const r = await syncBack(d);
      console.error(r.ok ? 'ccx: vault in sync' : `ccx: ${r.reason}`);
      return r.ok ? 0 : 1;
    }
    case 'statusline': { await runStatusline(d); return 0; }
    case 'doctor': return runDoctor(d);
    default: return runLaunch(d, argv);
  }
}

process.exit(await main());
