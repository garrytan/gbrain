/**
 * Degraded-mode engine — the lazy-reconnect stand-in `gbrain serve` uses
 * when Postgres is unreachable AT STARTUP (db-availability loop, 4c).
 *
 * Before this, a dead DB killed serve inside connectEngine and gbrain
 * simply disappeared from the harness. Now serve boots with THIS object;
 * every tool call attempts ONE reconnect (single-flight, min-interval-gated
 * so a dying pooler never sees a connect storm), and until one succeeds the
 * call throws the ORIGINAL connect error — MCP dispatch classifies it into
 * the `database_error` envelope + GBRAIN_DB_ACCESS marker the bundled
 * skills/db-repair skill matches. First success swaps in the live engine
 * permanently and fires the recovery callbacks (serve re-runs its deferred
 * boot + sends tools/list_changed) — but the TRIGGERING call itself gets
 * DegradedRecoveredRetryError, never a result: its source scope was
 * resolved under the degraded fallback, so executing it against the live
 * engine could read/write the wrong source. One client retry buys scope
 * correctness. Callers waiting on an in-flight attempt are also
 * latency-capped (callerWaitMs): they get the stored error fast while the
 * attempt finishes in the background.
 *
 * Scope: POSTGRES ONLY. A PGLite startup failure keeps die-on-startup —
 * that lane's repair is `gbrain pglite-repair`, and the single-writer
 * data-dir lock makes a lazy reconnect proxy wrong there.
 *
 * Shape: a concrete OBJECT whose method set is enumerated from
 * PostgresEngine's prototype chain at construction — every method is a real
 * named function (no dynamic `get` trap), `kind` is an explicit getter
 * (read synchronously at ~29 branch sites), and the engine surface tracks
 * PostgresEngine automatically (a new engine method can never silently miss
 * the degraded path). `disconnect()` is special-cased to a no-op while
 * dead: the shutdown path must never trigger a reconnect attempt.
 *
 * Reconnect semantics: the `reconnect` callback is the FULL connectEngine
 * (config merge, gateway config, pending migrations) — i.e. the init that
 * was deferred when startup failed. It is invoked at most once per
 * minIntervalMs across ALL concurrent callers; calls landing inside the
 * window throw the stored (stale-but-honest) original error, refreshed on
 * every real attempt.
 */

import { PostgresEngine } from './postgres-engine.ts';
import type { BrainEngine } from './engine.ts';
import { DEGRADED_LAST_ERROR, DEGRADED_ON_RECOVER, DEGRADED_STATE } from './degraded-marker.ts';

export interface DegradedEngineOptions {
  /** The startup connect error — rethrown verbatim while dead so dispatch's
   *  classifier sees the REAL error shape, never a synthesized one. */
  initialError: unknown;
  /** Full engine bring-up (connectEngine): config merge + gateway +
   *  migrations + connect. Called lazily, single-flight. */
  reconnect: () => Promise<BrainEngine>;
  /** Minimum ms between real reconnect attempts (default 5000). */
  minIntervalMs?: number;
  /** Max ms a CALLER waits on an in-flight reconnect before getting the
   *  stored error (default 2000). The attempt keeps running in the
   *  background — this bounds caller-visible latency (a timeout-class
   *  failure would otherwise stall every call, including the MCP
   *  tools/list handshake, for the full driver connect_timeout). */
  callerWaitMs?: number;
  now?: () => number;
}

/**
 * Thrown to the ONE call whose engine access triggered a successful
 * reconnect. That call's source scope was resolved while the engine was
 * still degraded (seed_default short-circuit in resolveMcpStdioSourceScope),
 * so executing it against the live engine would run under the WRONG source
 * on multi-source brains. Failing it with an explicit retry instruction
 * costs one client retry and guarantees no call ever executes under the
 * degraded fallback scope with a live engine.
 */
export class DegradedRecoveredRetryError extends Error {
  readonly code = 'GBRAIN_RECOVERED_RETRY';
  constructor() {
    super('gbrain database access RECOVERED — retry this call (full service is restored; this one call was scoped before recovery).');
    this.name = 'DegradedRecoveredRetryError';
  }
}

function enginePrototypeMethodNames(): string[] {
  const names = new Set<string>();
  let proto: object | null = PostgresEngine.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.value === 'function') names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

/** Prototype GETTERS (e.g. `get sql()`), delegated too — serve holds this
 *  wrapper forever, so a post-recovery property read must reach the live
 *  engine, not silently return undefined. Instance properties set in the
 *  constructor are NOT enumerable from the prototype and stay out of the
 *  BrainEngine contract (methods + kind + prototype getters only). */
function enginePrototypeGetterNames(): string[] {
  const names = new Set<string>();
  let proto: object | null = PostgresEngine.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name === 'kind') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.get === 'function') names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

export function createDegradedEngine(opts: DegradedEngineOptions): BrainEngine {
  const minInterval = opts.minIntervalMs ?? 5000;
  const callerWaitMs = opts.callerWaitMs ?? 2000;
  const now = opts.now ?? (() => Date.now());

  let live: BrainEngine | null = null;
  let lastError: unknown = opts.initialError;
  let lastAttemptAt = -Infinity;
  let inFlight: Promise<BrainEngine> | null = null;
  const recoveryCallbacks: Array<() => void> = [];

  /**
   * Never returns an engine to the degraded-era caller: success throws
   * DegradedRecoveredRetryError (see its doc — the caller's source scope
   * predates recovery), failure throws the classified error. Post-recovery
   * calls never reach this (the method wrappers delegate to `live` first).
   */
  async function attemptReconnect(): Promise<never> {
    if (!inFlight) {
      if (now() - lastAttemptAt < minInterval) throw lastError; // stale-but-honest
      lastAttemptAt = now();
      inFlight = opts
        .reconnect()
        .then((engine) => {
          live = engine;
          for (const cb of recoveryCallbacks.splice(0)) {
            try { cb(); } catch { /* recovery callbacks are best-effort */ }
          }
          return engine;
        })
        .catch((e: unknown) => {
          lastError = e; // refresh the diagnosis on every real attempt
          throw e;
        })
        .finally(() => { inFlight = null; });
      // Detach a swallow so a capped-out caller abandoning the promise below
      // never turns the background failure into an unhandledRejection.
      inFlight.catch(() => {});
    }
    // Bound the CALLER's wait; the attempt itself keeps running.
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<never>((_, reject) => {
      capTimer = setTimeout(() => reject(lastError), callerWaitMs);
      (capTimer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([inFlight, cap]);
    } finally {
      clearTimeout(capTimer);
    }
    // Reconnect succeeded within the wait window.
    throw new DegradedRecoveredRetryError();
  }

  const target: Record<string | symbol, unknown> = {};
  for (const name of enginePrototypeMethodNames()) {
    if (name === 'disconnect') continue; // special-cased below
    target[name] = async (...args: unknown[]) => {
      if (live) {
        return (live as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
      }
      return attemptReconnect();
    };
  }
  // Shutdown must never trigger a reconnect: no-op while dead.
  target.disconnect = async () => {
    if (live) await live.disconnect();
  };
  for (const name of enginePrototypeGetterNames()) {
    Object.defineProperty(target, name, {
      // Sync surface: a property read never triggers a reconnect — while
      // dead it throws the stored (honest) error rather than silently
      // returning undefined.
      get: () => {
        if (live) return (live as unknown as Record<string, unknown>)[name];
        throw lastError;
      },
      enumerable: true,
    });
  }
  Object.defineProperty(target, 'kind', {
    get: () => (live ? live.kind : 'postgres'),
    enumerable: true,
  });
  target[DEGRADED_STATE] = () => live === null;
  target[DEGRADED_ON_RECOVER] = (cb: () => void) => {
    if (live) cb();
    else recoveryCallbacks.push(cb);
  };
  // Read-only diagnosis access (e.g. the HTTP /health degraded reason) —
  // never triggers a reconnect attempt.
  target[DEGRADED_LAST_ERROR] = () => (live ? undefined : lastError);

  return target as unknown as BrainEngine;
}
