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
 * #6317 (managed brains, Postgres): sync_start may carry the CLI's durable
 * `cli` writer registration. The serve verifies it and runs the managed
 * drain (`drainManagedSync`) as that writer; sync_status then carries the
 * drain's report, the `next` action and the numbered human lines the drain
 * printed, so the polling CLI shows the same lines its in-process run would.
 *
 * This module is deliberately a LEAF: pure types + pure functions, imported by
 * both the resolve-ipc client/server plumbing and the serve-sync-runner. It
 * must not import resolve-ipc.ts (cycle) or any engine module.
 */

import { isValidSourceId } from '../source-id.ts';
import type { SyncResult } from '../../commands/sync.ts';
import type { DrainNext, DrainReport } from '../persistence/sync-drain.ts';

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
  noBulk: 'boolean',
  lanes: 'number',
  explicitProcessing: 'string[]',
  timeoutSeconds: 'number',
} as const;

/** `--lanes N` bounds (`src/commands/sync/args.ts`). */
export const DELEGATED_SYNC_LANES_MAX = 16;
/** The processing keys an unfinished managed cursor supplies unless the caller set them (#5632). */
export const DELEGATED_SYNC_PROCESSING_KEYS = ['noEmbed', 'noExtract', 'noSchemaPack'] as const;

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
  /** #6317: `--no-bulk` for the managed catch-up. */
  noBulk?: boolean;
  /** #6317: `--lanes N` / `--no-lanes` (1..DELEGATED_SYNC_LANES_MAX) for the managed catch-up. */
  lanes?: number;
  /** #6317: the processing options the caller set itself; the managed cursor supplies the rest. */
  explicitProcessing?: Array<typeof DELEGATED_SYNC_PROCESSING_KEYS[number]>;
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
    if (type === 'string[]') {
      if (!Array.isArray(v) || v.some(item => typeof item !== 'string')) return { ok: false, error: `invalid_options:${key}` };
      out[key] = [...v];
      continue;
    }
    if (typeof v !== type) return { ok: false, error: `invalid_options:${key}` };
    out[key] = v;
  }
  if (out.lanes !== undefined && (!Number.isInteger(out.lanes) || (out.lanes as number) < 1 || (out.lanes as number) > DELEGATED_SYNC_LANES_MAX)) {
    return { ok: false, error: 'invalid_options:lanes' };
  }
  if (out.explicitProcessing !== undefined) {
    const keys = out.explicitProcessing as string[];
    if (keys.length > DELEGATED_SYNC_PROCESSING_KEYS.length || keys.some(key => !(DELEGATED_SYNC_PROCESSING_KEYS as readonly string[]).includes(key))) {
      return { ok: false, error: 'invalid_options:explicitProcessing' };
    }
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

/**
 * #6317: the CLI's durable `cli` writer registration (id + private credential,
 * the same document `local-client.ts` sends over the PGLite persistence IPC).
 * The serve verifies it against `persistence_local_writers` and runs the
 * managed drain AS that writer, so revocation and grant checks still apply;
 * the shared secret alone never authorizes a managed sync.
 */
export interface SyncStartRegistration { id: string; credential: string; lane: 'cli' }

export function isSyncStartRegistration(value: unknown): value is SyncStartRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['id', 'credential', 'lane'].every(key => keys.includes(key))) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rec.id)
    && typeof rec.credential === 'string' && /^[a-f0-9]{64}$/.test(rec.credential)
    && rec.lane === 'cli';
}

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
  /** #6317: present when the CLI asks the serve to run a managed drain as its verified writer. */
  registration?: SyncStartRegistration;
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
  /**
   * #6317: the agent-operator envelope (`OperationError.toJSON()`) behind an
   * authorization refusal of the registration hand-off (`permission_denied`
   * for a denied, revoked or stdio registration), so the CLI renders the same
   * error its in-process path would have thrown.
   */
  refusal?: Record<string, unknown>;
}

export interface SyncStatusRequest {
  kind: 'sync_status';
  protocol: 2;
  secret: string;
  jobId: string;
  /** #6317: return only the job's human lines after this sequence number (the client's cursor). */
  afterLine?: number;
}

/** #6317: a human line the job printed (the drain's progress, stall and lanes lines), numbered so a poll resumes where it left off. */
export interface SyncStatusLine { seq: number; text: string }

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
  /** #6317: the job's error as an agent-operator envelope when it was an OperationError (state === 'error'). */
  jobErrorEnvelope?: Record<string, unknown>;
  /** #6317: true when the job runs the managed drain as a verified CLI writer (its `lines` are the drain's own output). */
  managed?: boolean;
  /** #6317: the managed drain's report so far (final when state is terminal), when the job is a managed drain. */
  drain?: DrainReport;
  /** #6317: what to run next once the drain is terminal; null when it synced; absent before then. */
  next?: DrainNext | null;
  /** #6317: the human lines printed since the request's `afterLine` cursor, oldest first (bounded; older lines are dropped). */
  lines?: SyncStatusLine[];
  /** #6317: the newest line sequence the server holds (the client's next cursor). */
  lineSeq?: number;
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
