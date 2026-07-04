import type { Deps } from './deps';
import { checkAndNotify } from './notifier';
import { isStale } from './picker';
import { refreshAllSnapshots } from './usage';

export async function runStatus(d: Deps, args: string[]): Promise<number> {
  await refreshAllSnapshots(d);
  checkAndNotify(d); // spec §5: notifier runs inside ccx status too

  if (args.includes('--json')) {
    console.log(JSON.stringify({ activeAccount: d.state.activeAccount, syncPending: d.state.syncPending, accounts: d.state.accounts }, null, 2));
    return 0;
  }
  if (Object.keys(d.state.accounts).length === 0) {
    console.log('No accounts imported. Log in with `claude`, then run `ccx import <name>`.');
    return 0;
  }
  for (const [name, account] of Object.entries(d.state.accounts)) {
    const marker = d.state.activeAccount === name ? '⚡ active' : '  parked';
    console.log(`${name} (${account.email}) ${marker}${account.needsLogin ? '  ⚠ needs `claude` login + ccx import' : ''}`);
    if (!account.snapshot) { console.log('   no data yet'); continue; }
    for (const gauge of account.snapshot.gauges) {
      const scope = gauge.scopeModel ? ` [${gauge.scopeModel}]` : '';
      const resets = new Date(gauge.resetsAt).toLocaleString();
      console.log(`   ${gauge.kind}${scope}: ${Math.round(gauge.percent)}% (${gauge.severity}) resets ${resets}`);
    }
    const age = Math.round((d.now().getTime() - Date.parse(account.snapshot.fetchedAt)) / 60_000);
    console.log(`   source: ${account.snapshot.source}, ${age}m ago${isStale(account.snapshot, d.cfg, d.now()) ? ' (STALE)' : ''}`);
  }
  if (d.state.syncPending) console.log('⚠ sync pending: live credentials not yet captured to vault (will retry).');
  return 0;
}
