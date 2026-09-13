/** Required for the guarded transport's TLS identity and connection behavior. */
export const MINIMUM_BUN_VERSION = '1.3.11';

export function assertSupportedBun(version = typeof Bun === 'undefined' ? '' : Bun.version): void {
  if (!/^\d+\.\d+\.\d+(?:\+.*)?$/.test(version) || !Bun.semver.satisfies(version, `>=${MINIMUM_BUN_VERSION}`)) {
    const error = new Error(`GBrain requires Bun ${MINIMUM_BUN_VERSION} or newer. Run bun upgrade, then restart GBrain.`);
    Object.assign(error, { code: 'UNSUPPORTED_RUNTIME' });
    throw error;
  }
}
