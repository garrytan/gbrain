/**
 * Serve-delegated maintenance sweep IPC — wire types + validation (#677).
 *
 * A live `gbrain serve` holds a PGLite brain's single-writer connection for
 * its lifetime, so a concurrent `gbrain sweep --once` process cannot open the
 * brain (LiveServeLockError). These kinds let the sweep CLI delegate the run
 * to the serve process over the existing resolve-IPC socket — the lock owner
 * does the work, the CLI polls. Same trust posture as the sync kinds: narrow
 * typed requests, secret-gated, raw SQL never crosses the wire.
 *
 *   sweep_start  { options, clientToken } → { ok, jobId } | { ok:false, error }
 *   sweep_status { jobId }                → job state + final SweepReport
 *
 * No abort kind: a sweep is a bounded run (default 5s budget) — the client
 * just polls to completion. This module is deliberately a LEAF: pure types +
 * pure functions, imported by both the resolve-ipc plumbing and the
 * serve-sweep-runner. It must not import resolve-ipc.ts (cycle) or any
 * engine module.
 */

import { isValidSourceId } from '../source-id.ts';
import type { SweepReport } from '../sweep.ts';

// ── Options allowlist ──────────────────────────────────────────────────────

/**
 * Field table driving the validator + both wire builders (single source of
 * truth, same pattern as DELEGATED_SYNC_OPTION_FIELDS). Everything NOT in
 * this table is rejected fail-closed.
 */
export const DELEGATED_SWEEP_OPTION_FIELDS = {
  sourceId: 'string',
  budgetMs: 'number',
  batchLimit: 'number',
} as const;

/** Hard ceiling on a delegated sweep's wall-clock budget (10 min). */
export const DELEGATED_SWEEP_BUDGET_MAX_MS = 600_000;

export interface DelegatedSweepOptions {
  /** Must satisfy the canonical source-id shape; validated at the boundary. */
  sourceId?: string;
  budgetMs?: number;
  batchLimit?: number;
}

export type DelegatedSweepValidation =
  | { ok: true; options: DelegatedSweepOptions }
  | { ok: false; error: string };

/**
 * Fail-closed wire validation: unknown keys reject, wrong types reject,
 * sourceId must be shape-valid, numeric knobs must be non-negative integers
 * (budgetMs clamps to DELEGATED_SWEEP_BUDGET_MAX_MS). Returns a NEW object
 * built from the field table — never the caller's reference.
 */
export function validateDelegatedSweepOptions(raw: unknown): DelegatedSweepValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_options:options' };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(key in DELEGATED_SWEEP_OPTION_FIELDS)) {
      return { ok: false, error: `invalid_options:${key}` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(DELEGATED_SWEEP_OPTION_FIELDS)) {
    const v = rec[key];
    if (v === undefined) continue;
    if (typeof v !== type) return { ok: false, error: `invalid_options:${key}` };
    out[key] = v;
  }
  for (const key of ['budgetMs', 'batchLimit'] as const) {
    const v = out[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return { ok: false, error: `invalid_options:${key}` };
    }
  }
  if (typeof out.budgetMs === 'number') {
    out.budgetMs = Math.min(out.budgetMs, DELEGATED_SWEEP_BUDGET_MAX_MS);
  }
  if (out.sourceId !== undefined && !isValidSourceId(out.sourceId as string)) {
    return { ok: false, error: 'invalid_options:sourceId' };
  }
  return { ok: true, options: out as unknown as DelegatedSweepOptions };
}

// ── Wire request / response types ──────────────────────────────────────────

export type DelegatedSweepState = 'running' | 'done' | 'error';

export interface SweepStartRequest {
  kind: 'sweep_start';
  protocol: 2;
  secret: string;
  /**
   * Client-generated idempotency token — a retry after a lost ack attaches to
   * its own job (running or retained-terminal) instead of duplicate-running.
   */
  clientToken: string;
  options: DelegatedSweepOptions;
}

export type SweepStartError =
  | 'busy'
  | 'unauthorized'
  | 'unsupported_protocol'
  | 'unsupported_kind'
  | 'shutting_down'
  | 'source_mismatch'
  | string; // `invalid_options:<field>`

export interface SweepStartResponse {
  ok: boolean;
  protocol: 2;
  jobId?: string;
  /** True when a token retry matched the retained terminal job. */
  completed?: boolean;
  error?: SweepStartError;
}

export interface SweepStatusRequest {
  kind: 'sweep_status';
  protocol: 2;
  secret: string;
  jobId: string;
}

export interface SweepStatusResponse {
  ok: boolean;
  protocol: 2;
  state?: DelegatedSweepState;
  sourceId?: string;
  startedAt?: number;
  elapsedMs?: number;
  /** Present when state === 'done'. Bounded — counts + skip reasons only. */
  report?: SweepReport;
  /** Present when state === 'error' — the job's failure message. */
  jobError?: string;
  /** ok:false protocol errors: 'unauthorized' | 'unknown_job' | 'unsupported_kind' | 'unsupported_protocol'. */
  error?: string;
}
