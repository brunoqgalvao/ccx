import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Deps } from './deps';
import { assessFailover } from './failover';
import type { Candidate } from './picker';
import { pickAccount } from './picker';
import { pollAccount, refreshAllSnapshots } from './usage';
import { activate, syncBack } from './vault';
import type { State } from './types';

export function targetModelFrom(args: string[], settingsModel: string | undefined): string | undefined {
  const eq = args.find((a) => a.startsWith('--model='));
  if (eq && eq.length > '--model='.length) return eq.slice('--model='.length);
  const i = args.indexOf('--model');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return settingsModel;
}

export function readSettingsModel(): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8'));
    return typeof settings.model === 'string' ? settings.model : undefined;
  } catch {
    return undefined;
  }
}

export function otherAccount(state: State): string | null {
  const names = Object.keys(state.accounts).filter((n) => n !== state.activeAccount);
  return Object.keys(state.accounts).length >= 2 && names.length > 0 ? names[0] : null;
}

export function candidates(state: State): Candidate[] {
  return Object.entries(state.accounts).map(([name, a]) => ({
    name, snapshot: a.snapshot, needsLogin: a.needsLogin,
  }));
}

export async function spawnClaude(args: string[]): Promise<number> {
  const p = Bun.spawn(['claude', ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return await p.exited;
}

async function otherClaudeRunning(): Promise<boolean> {
  const p = Bun.spawn(['pgrep', '-x', 'claude'], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().length > 0;
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`${question} [Y/n] `); // stdout may be redirected; the prompt must stay visible
  for await (const line of console) return !/^n/i.test(line.trim());
  return false;
}

export async function runLaunch(d: Deps, claudeArgs: string[]): Promise<number> {
  const model = targetModelFrom(claudeArgs, readSettingsModel());

  if (Object.keys(d.state.accounts).length >= 2) {
    await syncBack(d); // attribute live-slot gauges correctly even after an out-of-band `claude /login`
    await refreshAllSnapshots(d);
    const pick = pickAccount(candidates(d.state), model, d.cfg, d.now());
    if (pick.name !== d.state.activeAccount) {
      if (await otherClaudeRunning()) {
        console.error(`ccx: another claude session is running — staying on ${d.state.activeAccount} (use \`ccx swap ${pick.name}\` to force the choice)`);
      } else {
        const r = await activate(d, pick.name);
        if (!r.ok) console.error(`ccx: ${r.reason}; launching on ${d.state.activeAccount}`);
      }
    }
    const active = d.state.activeAccount ? d.state.accounts[d.state.activeAccount] : undefined;
    for (const gauge of active?.snapshot?.gauges ?? []) {
      if (gauge.severity !== 'normal') {
        console.error(`ccx: ${d.state.activeAccount} ${gauge.kind} at ${Math.round(gauge.percent)}% (${gauge.severity})`);
      }
    }
    if (d.state.activeAccount === pick.name) {
      console.error(`ccx: using ${pick.name} — ${pick.reason}`);
    } else {
      console.error(`ccx: using ${d.state.activeAccount} (picker preferred ${pick.name}: ${pick.reason})`);
    }
  }

  const exitCode = await spawnClaude(claudeArgs);
  const usedAccount = d.state.activeAccount;
  const sync = await syncBack(d);
  if (!sync.ok) console.error(`ccx: ${sync.reason}`); // 'foreign' needs user action; 'unresolved' self-heals via syncPending
  if (usedAccount) await offerFailover(d, usedAccount, model);
  return exitCode;
}

async function offerFailover(d: Deps, usedName: string, launchModel: string | undefined): Promise<void> {
  await pollAccount(d, usedName, { force: true });
  // spec §4: the statusline-tracked session model (survives mid-session /model switches) wins over the launch model
  const model = d.state.accounts[usedName]?.snapshot?.model ?? launchModel;
  const used = { name: usedName, snapshot: d.state.accounts[usedName]?.snapshot, needsLogin: d.state.accounts[usedName]?.needsLogin };
  const others = candidates(d.state).filter((c) => c.name !== usedName);
  const action = assessFailover({ used, others, model, cfg: d.cfg, now: d.now() });

  switch (action.action) {
    case 'none':
      return;
    case 'wait':
      console.error(`ccx: limit hit on ${usedName}; ${action.reason}. Resets ${new Date(action.resetsAt).toLocaleString()}.`);
      return;
    case 'switch': {
      if (!process.stdin.isTTY) {
        console.error(`ccx: limit hit on ${usedName}; ${action.reason} — run \`ccx swap ${action.to} -c\` to resume there`);
        return;
      }
      if (await askYesNo(`ccx: limit hit on ${usedName}. ${action.reason}. Swap and resume the conversation?`)) {
        if (await otherClaudeRunning()) { console.error('ccx: another claude session is running — not swapping (spec §4 guard). Use `ccx swap --force -c` after it exits.'); return; }
        const r = await activate(d, action.to);
        if (r.ok) await spawnClaude(['--continue']);
        else console.error(`ccx: ${r.reason}`);
      }
      return;
    }
    case 'downgrade': {
      if (!process.stdin.isTTY) {
        console.error(`ccx: ${action.reason} — \`ccx swap ${action.on}\` then \`claude --continue --model ${d.cfg.downgradeModel}\``);
        return;
      }
      const question = `ccx: ${action.reason}. Resume on ${action.on} with --model ${d.cfg.downgradeModel}? (prompt cache is lost either way)`;
      if (await askYesNo(question)) {
        if (action.on !== d.state.activeAccount) {
          if (await otherClaudeRunning()) { console.error('ccx: another claude session is running — not swapping (spec §4 guard).'); return; }
          const r = await activate(d, action.on);
          if (!r.ok) { console.error(`ccx: ${r.reason}`); return; }
        }
        await spawnClaude(['--continue', '--model', d.cfg.downgradeModel]);
      }
      return;
    }
  }
}

export async function runSwap(d: Deps, args: string[]): Promise<number> {
  const wantContinue = args.includes('-c') || args.includes('--continue');
  const name = args.find((a) => !a.startsWith('-')) ?? otherAccount(d.state);
  if (!name) { console.error('ccx: no account to swap to (need two imported accounts)'); return 1; }
  if (!d.state.accounts[name]) { console.error(`ccx: unknown account "${name}" — run \`ccx import ${name}\` first`); return 1; }
  if (await otherClaudeRunning()) {
    if (!args.includes('--force')) {
      console.error('ccx: another claude session is running; swapping would change ITS account on next token read. Re-run with --force to proceed.');
      return 1;
    }
  }
  const r = await activate(d, name);
  if (!r.ok) { console.error(`ccx: ${r.reason}`); return 1; }
  console.error(`ccx: active account is now ${name}`);
  if (wantContinue) return await spawnClaude(['--continue']);
  return 0;
}
