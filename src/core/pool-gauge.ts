/**
 * CheckoutGauge — approximate in-flight query counters for the health probe's
 * pool diagnostics (issue #6).
 *
 * HONESTY CONTRACT (read before extending): this gauge counts calls through
 * the engine's raw/direct/reserved/transaction seams ONLY. The majority of
 * engine traffic — tagged-template queries on `this.sql` (getConfig, CRUD,
 * search) — is NOT tracked; postgres.js exposes no public checkout counters
 * and proxying the Sql template function is too invasive for a diagnostic.
 * Every consumer must label these numbers as a tracked SUBSET and must never
 * derive "available" or "waiting" figures from them (that arithmetic is
 * invented telemetry — outside-voice review, codex-2 #3). The authoritative
 * starvation signal is the direct-lane disambiguation probe in
 * `src/core/minions/db-probe.ts`; these counts are supporting detail.
 *
 * Fail-open by construction: plain integer bumps, no I/O, release() clamps
 * at zero so a missed acquire can never underflow into negative counts.
 */

import { sqlLabel } from './persistence/claim-phase.ts';

/** Which engine seam the in-flight call went through. */
export type GaugeKind = 'raw' | 'direct' | 'reserved' | 'tx';

export interface PoolGaugeSnapshot {
  /** executeRaw on the read pool. */
  raw: number;
  /** executeRawDirect (direct session lane when dual-pool, read pool otherwise). */
  direct: number;
  /** withReservedConnection holders. */
  reserved: number;
  /** transaction() bodies. */
  tx: number;
}

export class CheckoutGauge {
  private counts: PoolGaugeSnapshot = { raw: 0, direct: 0, reserved: 0, tx: 0 };
  private checkoutListeners = new Set<() => void>();

  /**
   * #5801: `listener` runs after a connection is actually obtained (reserve
   * resolution or transaction-callback entry), never when a call merely starts
   * waiting. Callers attribute the call to their own work (for example through
   * AsyncLocalStorage); the gauge itself knows nothing about callers.
   */
  onCheckout(listener: () => void): () => void {
    this.checkoutListeners.add(listener);
    return () => { this.checkoutListeners.delete(listener); };
  }

  checkedOut(): void {
    for (const listener of this.checkoutListeners) {
      try { listener(); } catch { /* best-effort */ }
    }
  }

  acquire(kind: GaugeKind): void {
    this.counts[kind] += 1;
  }

  release(kind: GaugeKind): void {
    if (this.counts[kind] > 0) this.counts[kind] -= 1;
  }

  snapshot(): PoolGaugeSnapshot {
    return { ...this.counts };
  }
}

/**
 * #5730: pooled connections the vendored driver terminated instead of reusing
 * because their ReadyForQuery status was not idle (`T` inside a transaction,
 * `E` inside a failed one). Each discard is counted once and logged as one
 * fixed-shape warn line; the status byte is the only driver-supplied value.
 */
export class PoisonedDiscardCounter {
  private discards = 0;

  get count(): number {
    return this.discards;
  }

  record(pool: 'read' | 'direct', status: string): void {
    this.discards += 1;
    try { console.warn(formatPoisonedDiscardWarning(pool, status)); } catch { /* best-effort */ }
  }
}

export function formatPoisonedDiscardWarning(pool: 'read' | 'direct', status: string): string {
  const byte = /^[A-Z]$/.test(status) ? status : '?';
  return `[gbrain] warn code=pg_connection_poisoned status=${byte} pool=${pool}` +
    ` cause="a connection came back to the pool inside a transaction; it was discarded and replaced"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-connection-poisoned`;
}

/**
 * #6383: connections the vendored driver's in-flight watchdog retired because a
 * statement waited `statement_timeout + grace` with nothing coming back, and
 * statements the driver rejected alone because they failed to build. Each is
 * counted once and logged as one fixed-shape warn line. The statement is named
 * by its first keyword and table (`sqlLabel`), never its text or parameters.
 */
export class PoolIncidentCounter {
  private stuck = 0;
  private buildFailures = 0;

  get stuckCount(): number {
    return this.stuck;
  }

  get buildFailureCount(): number {
    return this.buildFailures;
  }

  /** The driver hooks of one pool, bound to this counter (what an engine passes as `PoolHealthHooks`). */
  hooks(pool: 'read' | 'direct'): { onstuck: (info: { age_ms: number; queued: number; statement: string }) => void; onbuilderror: (code: string, statement: string) => void } {
    return { onstuck: (info) => this.recordStuck(pool, info), onbuilderror: (code, statement) => this.recordBuildFailure(pool, code, statement) };
  }

  recordStuck(pool: 'read' | 'direct', info: { age_ms: number; queued: number; statement: string }): void {
    this.stuck += 1;
    try { console.warn(formatStuckConnectionWarning(pool, info)); } catch { /* best-effort */ }
  }

  recordBuildFailure(pool: 'read' | 'direct', code: string, statement: string): void {
    this.buildFailures += 1;
    try { console.warn(formatBuildFailureWarning(pool, code, statement)); } catch { /* best-effort */ }
  }
}

export function formatStuckConnectionWarning(pool: 'read' | 'direct', info: { age_ms: number; queued: number; statement: string }): string {
  return `[gbrain] warn code=pg_connection_stuck pool=${pool} age_ms=${Math.max(0, Math.round(info.age_ms))} queued=${Math.max(0, info.queued | 0)} sql=${sqlLabel(info.statement).replaceAll(' ', '_')}` +
    ` cause="a statement waited past statement_timeout with nothing coming back from the server; the connection was retired and its queued statements failed with CONNECTION_STUCK"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-connection-stuck`;
}

export function formatBuildFailureWarning(pool: 'read' | 'direct', code: string, statement: string): string {
  const safeCode = /^[A-Z_]+$/.test(code) ? code : 'BUILD_FAILED';
  return `[gbrain] warn code=pg_statement_build_failed error=${safeCode} pool=${pool} sql=${sqlLabel(statement).replaceAll(' ', '_')}` +
    ` cause="a statement could not be built from its parameters and was rejected before it reached the connection; other statements were not affected"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-statement-build-failed`;
}
