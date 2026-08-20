/**
 * Serve-delegated sync IPC — wire types + validation.
 *
 * A live `gbrain serve` holds a PGLite brain's single-writer connection for
 * its lifetime, so a concurrent `gbrain sync` process cannot open the brain.
 * These kinds let the sync CLI delegate the run to the serve process over the
 * existing resolve-IPC socket: the lock owner does the work, the CLI polls.
 * Same trust posture as turn_context — narrow typed requests, secret-gated,
 * raw SQL never crosses the wire.
 *
 *   sync_start  { options, clientToken } → { ok, jobId } | { ok:false, error }
 *   sync_status { jobId }                → job state + progress + final result
 *   sync_abort  { jobId }                → begins cooperative abort (typed partial)
 *
 * This module is deliberately a LEAF: pure types + pure functions, imported by
 * both the resolve-ipc client/server plumbing and the serve-sync-runner. It
 * must not import resolve-ipc.ts (cycle) or any engine module.
 */

import { isValidSourceId } from '../source-id.ts';
import type { SyncResult } from '../../commands/sync.ts';

// ── Options allowlist ──────────────────────────────────────────────────────

/**
 * The single field table that drives the validator, the CLI wire-builder, and
 * the serve-side SyncOpts builder — one source of truth so the three sites
 * can't drift. Everything NOT in this table is rejected fail-closed: the wire
 * must never smuggle repoPath / srcSubpath / exclude / skipLock / lockId /
 * concurrency into the serve process. `noEmbed` here does NOT reach
 * performSync — delegated jobs ALWAYS run noEmbed (the #2139 cost gate lives
 * in runSync, which a delegated run never passes through); the flag records
 * that the USER declined embeds, which suppresses the serve's deferred-embed
 * drain (absent → the serve sweep drains them later).
 */
export const DELEGATED_SYNC_OPTION_FIELDS = {
  sourceId: 'string',
  dryRun: 'boolean',
  full: 'boolean',
  noPull: 'boolean',
  noEmbed: 'boolean',
  noExtract: 'boolean',
  noSchemaPack: 'boolean',
  skipFailed: 'boolean',
  retryFailed: 'boolean',
  includeGitignored: 'boolean',
  timeoutSeconds: 'number',
} as const;

export type DelegatedSyncOptionField = keyof typeof DELEGATED_SYNC_OPTION_FIELDS;

/** Hard ceiling on a delegated job's runtime (24h) — matches the sync hard-deadline scale. */
export const DELEGATED_SYNC_TIMEOUT_MAX_SECONDS = 86_400;

export interface DelegatedSyncOptions {
  /** Must satisfy the canonical source-id shape; validated at the boundary. */
  sourceId?: string;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  /** User explicitly declined embeds — suppresses the deferred-embed drain. */
  noEmbed?: boolean;
  noExtract?: boolean;
  noSchemaPack?: boolean;
  skipFailed?: boolean;
  retryFailed?: boolean;
  includeGitignored?: boolean;
  /**
   * REQUIRED — the client always sends its resolved hard deadline so a job
   * whose client died stays bounded. `0` is the single unbounded encoding
   * (an explicit `--no-hard-deadline`); nonzero values clamp to
   * [1, DELEGATED_SYNC_TIMEOUT_MAX_SECONDS].
   */
  timeoutSeconds: number;
}

export type DelegatedSyncValidation =
  | { ok: true; options: DelegatedSyncOptions }
  | { ok: false; error: string };

/**
 * Fail-closed wire validation: unknown keys reject (this is what keeps
 * server-only SyncOpts fields unreachable from the socket), wrong types
 * reject, sourceId must be shape-valid, timeoutSeconds must be a
 * non-negative integer (0 = no server timer). Returns a NEW object built
 * from the field table — never the caller's reference.
 */
export function validateDelegatedSyncOptions(raw: unknown): DelegatedSyncValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_options:options' };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(key in DELEGATED_SYNC_OPTION_FIELDS)) {
      return { ok: false, error: `invalid_options:${key}` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(DELEGATED_SYNC_OPTION_FIELDS)) {
    const v = rec[key];
    if (v === undefined) continue;
    if (typeof v !== type) return { ok: false, error: `invalid_options:${key}` };
    out[key] = v;
  }
  const timeout = out.timeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0) {
    return { ok: false, error: 'invalid_options:timeoutSeconds' };
  }
  out.timeoutSeconds = Math.min(timeout, DELEGATED_SYNC_TIMEOUT_MAX_SECONDS);
  if (out.sourceId !== undefined && !isValidSourceId(out.sourceId as string)) {
    return { ok: false, error: 'invalid_options:sourceId' };
  }
  return { ok: true, options: out as unknown as DelegatedSyncOptions };
}

// ── Progress + result shapes ───────────────────────────────────────────────

/** Fired by performSync's onProgress seam; mirrored into the job record. */
export interface SyncProgressEvent {
  phase: string;
  bankedFiles?: number;
}

/** pagesAffected cap so a 250K-file sync's result fits the 256KB message cap. */
export const WIRE_PAGES_AFFECTED_MAX = 50;

export interface WireSyncResult extends Omit<SyncResult, 'pagesAffected'> {
  /** First WIRE_PAGES_AFFECTED_MAX slugs only — see pagesAffectedTotal. */
  pagesAffected: string[];
  pagesAffectedTotal: number;
}

export function toWireSyncResult(r: SyncResult): WireSyncResult {
  const { pagesAffected, ...rest } = r;
  return {
    ...rest,
    pagesAffected: pagesAffected.slice(0, WIRE_PAGES_AFFECTED_MAX),
    pagesAffectedTotal: pagesAffected.length,
  };
}

// ── Wire request / response types ──────────────────────────────────────────

export type DelegatedSyncState = 'running' | 'aborting' | 'done' | 'error';

export interface SyncStartRequest {
  kind: 'sync_start';
  protocol: 2;
  secret: string;
  /**
   * Client-generated idempotency token. A retry after a lost ack that gets
   * `busy` with a MATCHING token is attaching to its own job; a retry whose
   * token matches the RETAINED TERMINAL job gets `{ok, jobId, completed:true}`
   * instead of a duplicate run.
   */
  clientToken: string;
  options: DelegatedSyncOptions;
}

export type SyncStartError =
  | 'busy'
  | 'unauthorized'
  | 'unsupported_protocol'
  | 'unsupported_kind'
  | 'shutting_down'
  | 'source_mismatch'
  | string; // `invalid_options:<field>`

export interface SyncStartResponse {
  ok: boolean;
  protocol: 2;
  jobId?: string;
  /** On `busy`: the running job's clientToken so a retrying owner can attach. */
  clientToken?: string;
  /** True when a token retry matched the retained terminal job — poll sync_status for its result. */
  completed?: boolean;
  error?: SyncStartError;
}

export interface SyncStatusRequest {
  kind: 'sync_status';
  protocol: 2;
  secret: string;
  jobId: string;
}

export interface SyncStatusResponse {
  ok: boolean;
  protocol: 2;
  state?: DelegatedSyncState;
  sourceId?: string;
  startedAt?: number;
  elapsedMs?: number;
  phase?: string;
  bankedFiles?: number;
  /** Present when state === 'done' (including typed partials). */
  result?: WireSyncResult;
  /** Present when state === 'error' — the job's failure message. */
  jobError?: string;
  /** ok:false protocol errors: 'unauthorized' | 'unknown_job' | 'unsupported_kind' | 'unsupported_protocol'. */
  error?: string;
}

export interface SyncAbortRequest {
  kind: 'sync_abort';
  protocol: 2;
  secret: string;
  jobId: string;
}

export interface SyncAbortResponse {
  ok: boolean;
  protocol: 2;
  state?: DelegatedSyncState;
  error?: string;
}
