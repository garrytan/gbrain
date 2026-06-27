/**
 * Lazy engine provider for the stdio MCP path (#2091).
 *
 * MCP hosts enforce a connect timeout on the `initialize` handshake
 * (Claude Code: 30s). The stdio serve path used to receive an engine that
 * was already connected — meaning the full PGLite WASM boot plus advisory
 * write-lock acquisition (itself up to 30s under contention) had to finish
 * before the server could answer `initialize`. Any boot slower than the
 * host timeout surfaced as an opaque "connection timed out" with the real
 * cause (slow boot, or "another serve holds the write lock") invisible.
 *
 * The provider decouples the two: serve answers the handshake immediately,
 * the engine connects in the background, and the first tools/call awaits
 * readiness. A connect failure (e.g. lock held by another process) is
 * surfaced as a structured per-call tool error and retried on the next
 * call — the MCP connection itself stays healthy.
 *
 * It also owns the shutdown-during-connect race: a host that disconnects
 * while the engine is still booting used to hit `engine.disconnect()`
 * before the lock was acquired, releasing nothing — then the in-flight
 * connect completed and leaked the lock dir. `disconnect()` here awaits
 * any in-flight connect (either outcome) before tearing the engine down,
 * so the lock that connect acquired is the lock that disconnect releases.
 */

import type { BrainEngine } from './engine.ts';

export interface EngineProvider {
  /**
   * Resolve the engine, connecting on first use. Memoized while a connect
   * is in flight and once it succeeds; a FAILED attempt clears the memo so
   * the next call retries (a lock held by a finishing CLI process frees up
   * — the retry is what turns "dead server" into "transient tool error").
   */
  ensure(): Promise<BrainEngine>;
  /** The connected engine, or null if not (yet) connected. */
  peek(): BrainEngine | null;
  /** The in-flight connect promise, or null when idle / settled. */
  inFlight(): Promise<BrainEngine> | null;
  /**
   * Await any in-flight connect (either outcome), then disconnect the
   * engine if one materialized. No-op when connect was never started —
   * shutting down a never-used lazy serve must not boot the engine just
   * to tear it down. Connect failures are swallowed (nothing to release);
   * `engine.disconnect()` errors propagate so callers can log them.
   */
  disconnect(): Promise<void>;
}

export function createEngineProvider(
  source: BrainEngine | (() => Promise<BrainEngine>),
): EngineProvider {
  const connectFn = typeof source === 'function' ? source : null;
  let engine: BrainEngine | null = connectFn ? null : (source as BrainEngine);
  let pending: Promise<BrainEngine> | null = null;

  const ensure = (): Promise<BrainEngine> => {
    if (engine) return Promise.resolve(engine);
    if (pending) return pending;
    // Unreachable for pre-connected providers (engine is always set), but
    // keeps the contract honest if a caller ever constructs one badly.
    if (!connectFn) return Promise.reject(new Error('EngineProvider: no connector and no engine'));
    pending = connectFn().then(
      (e) => {
        engine = e;
        pending = null;
        return e;
      },
      (err) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };

  return {
    ensure,
    peek: () => engine,
    inFlight: () => pending,
    disconnect: async (): Promise<void> => {
      if (pending) {
        try {
          await pending;
        } catch {
          // Connect failed — no engine, no lock, nothing to release.
        }
      }
      if (!engine) return;
      const e = engine;
      engine = null;
      await e.disconnect();
    },
  };
}

/**
 * Duck-type guard so `startMcpServer` can accept either a bare engine
 * (existing callers, tests) or a provider. BrainEngine has no `ensure`,
 * `peek`, or `inFlight`, so the three-method check cannot false-positive.
 */
export function isEngineProvider(x: BrainEngine | EngineProvider): x is EngineProvider {
  const p = x as EngineProvider;
  return (
    typeof p.ensure === 'function' &&
    typeof p.peek === 'function' &&
    typeof p.inFlight === 'function'
  );
}
