/**
 * Lowest supported Bun: contains the Linux child-exit fix (oven-sh/bun#30301)
 * and the guarded transport's explicit TLS serverName support.
 */
export const MINIMUM_BUN_VERSION = '1.4.0';

/**
 * First Bun with the Brotli decoder fix for CVE-2026-111497 (oven-sh/bun#46392),
 * reachable through fetch() with `Content-Encoding: br` and the decompression
 * APIs (#7373). Older supported runtimes still start; doctor warns.
 */
export const SECURE_BUN_VERSION = '1.4.4';

export const BUN_VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Order two Bun versions (`1.4.2`, `1.4.2+5a1b2c3` from `bun --revision`,
 * `1.5.0-canary.3+abc`): negative, zero or positive. A prerelease orders
 * before its release and build metadata is ignored (semver), so
 * `1.4.0-canary.1` is below `1.4.0` and `1.5.0-canary.1` above it. null when
 * either does not parse.
 */
export function compareBunVersions(a: string, b: string): number | null {
  const x = BUN_VERSION_RE.exec(a.trim());
  const y = BUN_VERSION_RE.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  return (x[4] ? 0 : 1) - (y[4] ? 0 : 1);
}

/** Whether a Bun version meets an `X.Y.Z` floor; null when it does not parse. */
export function bunVersionMeets(version: string, floor: string): boolean | null {
  const order = compareBunVersions(version, floor);
  return order === null ? null : order >= 0;
}

export function unsupportedBunMessage(version = typeof Bun === 'undefined' ? '' : Bun.version): string | null {
  if (bunVersionMeets(version, MINIMUM_BUN_VERSION)) return null;
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
