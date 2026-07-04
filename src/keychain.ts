export interface Keychain {
  read(service: string): Promise<string | null>;
  write(service: string, value: string): Promise<void>;
  remove(service: string): Promise<void>;
}

export const LIVE_SERVICE = 'Claude Code-credentials';
export const vaultService = (name: string) => `ccx-vault-${name}`;

// security -i reads commands through a 4096-byte line buffer. An oversized line SPLITS:
// the first chunk executes as a truncated (item-destroying) write before the remainder
// errors out — so oversized and non-line-safe values must be refused BEFORE spawning.
// Non-printable/non-ASCII survives the write but reads back silently hex-encoded, so it
// is refused too. (Live-verified against ccx-doctor-selftest, 2026-07-03.)
export const SECURITY_LINE_BUDGET = 4095;

export function escapeSecurityArg(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new Error('keychain values must be printable ASCII (control chars corrupt the security -i protocol; non-ASCII reads back hex-mangled)');
  }
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 200);
}

export function realKeychain(user: string = process.env.USER ?? ''): Keychain {
  if (!user) throw new Error('cannot determine keychain account: $USER is unset');
  return {
    async read(service) {
      const p = Bun.spawn(
        ['security', 'find-generic-password', '-s', service, '-a', user, '-w'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      const code = await p.exited;
      if (code === 0) return out.replace(/\n$/, '');
      if (code === 44) return null; // errSecItemNotFound — the only "not found" signal
      throw new Error(`keychain read failed for ${service} (exit ${code}): ${firstLine(err)}`);
    },
    async write(service, value) {
      const cmd =
        `add-generic-password -U -a ${escapeSecurityArg(user)}` +
        ` -s ${escapeSecurityArg(service)} -w ${escapeSecurityArg(value)}\n`;
      if (cmd.length > SECURITY_LINE_BUDGET) {
        throw new Error(`keychain write refused for ${service}: command exceeds security -i's ${SECURITY_LINE_BUDGET}-byte line buffer (oversized writes destroy the stored item)`);
      }
      const p = Bun.spawn(['security', '-i'], {
        stdin: new TextEncoder().encode(cmd),
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const err = await new Response(p.stderr).text();
      if ((await p.exited) !== 0) {
        throw new Error(`keychain write failed for ${service}: ${firstLine(err)}`);
      }
    },
    async remove(service) {
      const p = Bun.spawn(
        ['security', 'delete-generic-password', '-s', service, '-a', user],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      await p.exited;
    },
  };
}
