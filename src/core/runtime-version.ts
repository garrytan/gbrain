/**
 * Lowest supported Bun: contains the Linux child-exit fix (oven-sh/bun#30301)
 * and the guarded transport's explicit TLS serverName support.
 */
export const MINIMUM_BUN_VERSION = '1.4.0';

export function unsupportedBunMessage(version = typeof Bun === 'undefined' ? '' : Bun.version): string | null {
  if (/^\d+\.\d+\.\d+(?:\+.*)?$/.test(version) && Bun.semver.satisfies(version, `>=${MINIMUM_BUN_VERSION}`)) return null;
  return `GBrain requires Bun ${MINIMUM_BUN_VERSION} or newer (found ${version ? `Bun ${version}` : 'no Bun runtime'}).\n`
    + 'Fix: run `bun upgrade`, then restart GBrain. If a `gbrain upgrade` stopped here, finish it with `gbrain post-upgrade`.';
}

export function assertSupportedBun(version?: string): void {
  const message = unsupportedBunMessage(version);
  if (message) throw Object.assign(new Error(message), { code: 'UNSUPPORTED_RUNTIME' });
}

/**
 * The CLI entrypoint gate: below the floor every command exits 1 before any
 * work starts. `--version` still answers (exit 0, refusal on stderr) so an
 * upgrade run by an older gbrain can confirm the swapped version. Autopilot
 * services log stdout to autopilot.log and stderr to an unsurfaced
 * autopilot.err, so its refusal goes to both.
 */
export function exitOnUnsupportedBun(command: string | undefined, cliVersion: string, version?: string): void {
  const refusal = unsupportedBunMessage(version);
  if (!refusal) return;
  console.error(refusal);
  if (command === '--version' || command === 'version') {
    console.log(`gbrain ${cliVersion}`);
    process.exit(0);
  }
  if (command === 'autopilot') console.log(`${new Date().toISOString()} [autopilot] ${refusal}`);
  process.exit(1);
}
