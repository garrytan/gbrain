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
import type { ConnectionRecoveryInfo, StuckConnectionInfo } from './db.ts';
import type { PoolRecoveryEventKind } from './audit/pool-recovery-audit.ts';

/** #6543 (A6): where a resident process records its pool incidents (serve: the pool-recovery audit doctor reads). */
export type PoolIncidentAudit = (kind: Extract<PoolRecoveryEventKind, `connection_${string}`>, detail: string) => void;
let incidentAudit: PoolIncidentAudit | null = null;
/** Serve turns this on at startup so `gbrain doctor --only pool_reap_health` sees its stuck, desync and recovery events. */
export function setPoolIncidentAudit(audit: PoolIncidentAudit | null): void { incidentAudit = audit; }
function audit(kind: Parameters<PoolIncidentAudit>[0], detail: string): void {
  try { incidentAudit?.(kind, detail); } catch { /* best-effort */ }
}

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
 * statement waited past its budget (`statement_timeout + grace`, raised for an
 * operation that declared a longer timeout) with nothing coming back
 * (`reason=idle`) or, since #6543, ran past it while bytes kept arriving
 * (`reason=age`), and statements the driver rejected alone because they failed
 * to build. #6543 (A6): `recovered` / `recovery_failed` count reconnects of
 * connections retired by an incident. Each is counted once and logged as one
 * fixed-shape warn line. The statement is named by its first keyword and table
 * (`sqlLabel`), never its text or parameters.
 */
export class PoolIncidentCounter {
  private stuck = 0;
  private buildFailures = 0;
  private desyncs = 0;
  private recoveries = 0;
  private recoveryFailures = 0;

  get recoveredCount(): number {
    return this.recoveries;
  }

  get recoveryFailedCount(): number {
    return this.recoveryFailures;
  }

  get stuckCount(): number {
    return this.stuck;
  }

  get buildFailureCount(): number {
    return this.buildFailures;
  }

  get desyncCount(): number {
    return this.desyncs;
  }

  /** The driver hooks of one pool, bound to this counter (what an engine passes as `PoolHealthHooks`). */
  hooks(pool: 'read' | 'direct'): { onstuck: (info: StuckConnectionInfo) => void; onbuilderror: (code: string, statement: string, parameter?: number) => void;
    ondesync: (info: { message: string; connection: number; statement: string }) => void; onrecovered: (info: ConnectionRecoveryInfo) => void; onrecoveryfailed: (info: ConnectionRecoveryInfo) => void } {
    return { onstuck: (info) => this.recordStuck(pool, info), onbuilderror: (code, statement, parameter) => this.recordBuildFailure(pool, code, statement, parameter),
      ondesync: (info) => this.recordDesync(pool, info), onrecovered: (info) => this.recordRecovered(pool, info), onrecoveryfailed: (info) => this.recordRecoveryFailed(pool, info) };
  }

  recordStuck(pool: 'read' | 'direct', info: StuckConnectionInfo): void {
    this.stuck += 1;
    const line = formatStuckConnectionWarning(pool, info);
    try { console.warn(line); } catch { /* best-effort */ }
    audit('connection_stuck', line);
  }

  recordDesync(pool: 'read' | 'direct', info: { message: string; connection: number; statement: string }): void {
    this.desyncs += 1;
    const line = formatDesyncWarning(pool, info);
    try { console.warn(line); } catch { /* best-effort */ }
    audit('connection_desync', line);
  }

  recordRecovered(pool: 'read' | 'direct', info: ConnectionRecoveryInfo): void {
    this.recoveries += 1;
    audit('connection_recovered', `pool=${pool} connection=${Math.max(0, info.connection | 0)} cause=${recoveryCause(info.cause)}`);
  }

  recordRecoveryFailed(pool: 'read' | 'direct', info: ConnectionRecoveryInfo): void {
    this.recoveryFailures += 1;
    const line = formatRecoveryFailedWarning(pool, info);
    try { console.warn(line); } catch { /* best-effort */ }
    audit('connection_recovery_failed', line);
  }

  recordBuildFailure(pool: 'read' | 'direct', code: string, statement: string, parameter?: number): void {
    this.buildFailures += 1;
    try { console.warn(formatBuildFailureWarning(pool, code, statement, parameter)); } catch { /* best-effort */ }
  }
}

export function formatStuckConnectionWarning(pool: 'read' | 'direct', info: StuckConnectionInfo): string {
  const reason = info.reason === 'age' ? 'age' : 'idle';
  const budget = Number.isFinite(info.budget_ms) && info.budget_ms! > 0 ? ` budget_ms=${Math.round(info.budget_ms!)}` : '';
  return `[gbrain] warn code=pg_connection_stuck pool=${pool} age_ms=${Math.max(0, Math.round(info.age_ms))} queued=${Math.max(0, info.queued | 0)} sql=${sqlLabel(info.statement).replaceAll(' ', '_')} reason=${reason}${budget}` +
    (reason === 'age'
      ? ` cause="a statement kept receiving data past its in-flight budget (statement_timeout plus grace, or the longer statement_timeout its operation declared); the connection was retired and its queued statements failed with CONNECTION_STUCK"`
      : ` cause="a statement waited past its in-flight budget (statement_timeout plus grace, or the longer statement_timeout its operation declared) with nothing coming back from the server; the connection was retired and its queued statements failed with CONNECTION_STUCK"`) +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-connection-stuck`;
}

function recoveryCause(cause: string): string {
  return cause === 'stuck' || cause === 'desync' || cause === 'closed' ? cause : 'unknown';
}

export function formatRecoveryFailedWarning(pool: 'read' | 'direct', info: ConnectionRecoveryInfo): string {
  const code = /^[A-Z0-9_]+$/.test(info.code ?? '') ? info.code : 'CONNECTION_ERROR';
  return `[gbrain] warn code=pg_connection_recovery_failed pool=${pool} connection=${Math.max(0, info.connection | 0)} cause=${recoveryCause(info.cause)} error=${code}` +
    ` cause="a connection retired after an incident could not reconnect; statements waiting for it failed and the next one retries the connect"` +
    ` fix="gbrain doctor --only pool_reap_health --json" docs=docs/ENGINES.md#pg-connection-recovery-failed`;
}

export function formatDesyncWarning(pool: 'read' | 'direct', info: { message: string; connection: number; statement: string }): string {
  const message = /^[A-Za-z0-9]$/.test(info.message) ? info.message : '?';
  return `[gbrain] warn code=pg_connection_desync pool=${pool} message=${message} connection=${Math.max(0, info.connection | 0)} sql=${sqlLabel(info.statement).replaceAll(' ', '_')}` +
    ` cause="a statement answer arrived on a connection with no statement waiting for it; the connection was retired and its queued statements failed with a connection error"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-connection-desync`;
}

/**
 * #6543: an `UNDEFINED_VALUE` line names the undefined parameter (`param=$2`), or `param=?` when the driver raised it for
 * an array element, which carries no index.
 */
export function formatBuildFailureWarning(pool: 'read' | 'direct', code: string, statement: string, parameter?: number): string {
  const safeCode = /^[A-Z_]+$/.test(code) ? code : 'BUILD_FAILED';
  const param = safeCode !== 'UNDEFINED_VALUE' ? '' : Number.isInteger(parameter) && parameter! > 0 ? ` param=$${parameter}` : ' param=?';
  return `[gbrain] warn code=pg_statement_build_failed error=${safeCode} pool=${pool} sql=${sqlLabel(statement).replaceAll(' ', '_')}${param}` +
    ` cause="a statement could not be built from its parameters and was rejected before it reached the connection; on a transaction-mode pooler this usually means a value came from a row another statement was sent (a misrouted answer)"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-statement-build-failed`;
}
