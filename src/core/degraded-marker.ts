/**
 * Degraded-engine marker — the DEPENDENCY-FREE seam between the degraded
 * engine (src/core/degraded-engine.ts, which imports the heavy Postgres
 * engine module) and the serve surfaces that need to ASK about degraded
 * state (src/mcp/server.ts, src/commands/serve.ts) without pulling that
 * module into their import graph.
 *
 * Symbols are registered (Symbol.for) so state survives duplicate module
 * instances under odd bundling; the marker values are FUNCTIONS so the
 * answer tracks live state (degraded → recovered) instead of a stale flag.
 */

export const DEGRADED_STATE = Symbol.for('gbrain.degraded.state');
export const DEGRADED_ON_RECOVER = Symbol.for('gbrain.degraded.onRecover');
export const DEGRADED_LAST_ERROR = Symbol.for('gbrain.degraded.lastError');

/** True while a degraded engine has not yet reconnected. Always false for
 *  real engines (they never carry the marker). */
export function isEngineDegraded(engine: unknown): boolean {
  const fn = (engine as Record<symbol, unknown> | null | undefined)?.[DEGRADED_STATE];
  return typeof fn === 'function' && (fn as () => boolean)() === true;
}

/** Register a recovery callback. No-op for real engines. */
export function onEngineRecovered(engine: unknown, cb: () => void): void {
  const fn = (engine as Record<symbol, unknown> | null | undefined)?.[DEGRADED_ON_RECOVER];
  if (typeof fn === 'function') (fn as (cb: () => void) => void)(cb);
}

/** The stored (stale-but-honest) connect error while degraded; undefined for
 *  real engines and after recovery. Read-only — never triggers a reconnect. */
export function degradedLastError(engine: unknown): unknown {
  const fn = (engine as Record<symbol, unknown> | null | undefined)?.[DEGRADED_LAST_ERROR];
  return typeof fn === 'function' ? (fn as () => unknown)() : undefined;
}
