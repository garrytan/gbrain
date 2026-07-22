/**
 * issue #1685 (GAP B) — pool reconnect/reap recovery audit.
 *
 * The #1678 incident's DB-cascade noise looked like a connection bug. In
 * reality a transaction-mode pooler reaps idle sockets between lock-renewal
 * ticks; gbrain self-heals via `PostgresEngine.reconnect()`. The thing an
 * operator actually needs to know — and that no existing signal expresses — is
 * "the pool was reaped N times in the last hour AND is NOT auto-recovering."
 * `batch_retry_health` surfaces connection retries but can't split
 * recovered-from-stuck. This audit does.
 *
 * HONESTY (CODEX #8): `reconnect()` fires for ANY retryable connection error
 * (network blip, auth race, pooler circuit), not just a pooler reap. Logging
 * everything as a "reap" would mislabel. So the caller passes the classified
 * error and we record the TRUE kind:
 *   - `reap_detected`        the triggering error matched CONNECTION_ENDED
 *                            (postgres.js's pooler-reap library code)
 *   - `reconnect_other`      a reconnect for some other retryable cause (or no
 *                            classified error, e.g. a health-check reconnect)
 *   - `reconnect_succeeded`  the rebuild completed
 *   - `reconnect_failed`     the rebuild threw (NOT auto-recovering)
 *
 * Built on the shared `audit-writer.ts` cathedral — same ISO-week rotation,
 * same best-effort write semantics. File:
 * `~/.gbrain/audit/pool-recovery-YYYY-Www.jsonl` (honors `GBRAIN_AUDIT_DIR`).
 *
 * Privacy: `error_summary` is the error message truncated to 200 chars. It can
 * carry a DSN/host in a connection-failure message — routed through the shared
 * `redactConnectionInfo` helper before truncation, same as lock-renewal-audit /
 * batch-retry-audit (v0.41.26.1 posture).
 */

import { createAuditWriter } from './audit-writer.ts';
import { redactConnectionInfo } from './redact-connection-info.ts';

export type PoolRecoveryEventKind =
  | 'reap_detected'
  | 'reconnect_other'
  | 'reconnect_succeeded'
  | 'reconnect_failed';

export interface PoolRecoveryEvent {
  ts: string;
  kind: PoolRecoveryEventKind;
  /** Redacted + truncated triggering-error message; absent on success events. */
  error_summary?: string;
  pid: number;
}

const FEATURE_NAME = 'pool-recovery';

const writer = createAuditWriter<PoolRecoveryEvent>({
  featureName: FEATURE_NAME,
  errorLabel: 'pool-recovery-audit',
  errorTrailer: '; continuing',
});

/** Redact + truncate an error message for safe audit storage. */
function summarizeError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  const raw = err instanceof Error ? err.message : String(err);
  return redactConnectionInfo(raw).slice(0, 200);
}

/**
 * Log one pool-recovery event. Best-effort: stderr-warns on write failure but
 * never throws. The caller's reconnect path continues regardless.
 */
export function logPoolRecovery(kind: PoolRecoveryEventKind, err?: unknown): void {
  const summary = summarizeError(err);
  writer.log({
    kind,
    pid: process.pid,
    ...(summary !== undefined ? { error_summary: summary } : {}),
  });
}

export interface ReadPoolRecoveryResult {
  events: PoolRecoveryEvent[];
  /** CONNECTION_ENDED-triggered reconnects (true pooler reaps) in window. */
  reaps: number;
  /** Successful rebuilds in window. */
  recoveries: number;
  /** Failed rebuilds in window (the "not auto-recovering" signal). */
  failures: number;
  /** Non-reap reconnects (network/auth/health-check) in window. */
  others: number;
  most_recent_ts: string | null;
}

/**
 * Read recent pool-recovery events. Default window is 1h (the "is it thrashing
 * right now" question), not the audit-writer 7-day default. Consumed by the
 * `pool_reap_health` doctor check.
 */
export function readRecentPoolRecoveries(
  hours = 1,
  now: Date = new Date(),
): ReadPoolRecoveryResult {
  const days = hours / 24;
  const cutoff = now.getTime() - hours * 3_600_000;
  const events = writer
    .readRecent(days, now)
    .filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  let reaps = 0;
  let recoveries = 0;
  let failures = 0;
  let others = 0;
  for (const e of events) {
    if (e.kind === 'reap_detected') reaps++;
    else if (e.kind === 'reconnect_succeeded') recoveries++;
    else if (e.kind === 'reconnect_failed') failures++;
    else if (e.kind === 'reconnect_other') others++;
  }

  return {
    events,
    reaps,
    recoveries,
    failures,
    others,
    most_recent_ts: events[0]?.ts ?? null,
  };
}

/** @internal — test seam to pin the file location / feature name. */
export function _poolRecoveryAuditFeatureName(): string {
  return FEATURE_NAME;
}
