/**
 * MinionQueue — Postgres-native job queue inspired by BullMQ.
 *
 * Usage:
 *   const queue = new MinionQueue(engine);
 *   const job = await queue.add('sync', { full: true });
 *   const status = await queue.getJob(job.id);
 *   await queue.prune({ olderThan: new Date(Date.now() - 30 * 86400000) });
 */

import type { BrainEngine } from '../engine.ts';
import type {
  MinionJob, MinionJobInput, MinionJobStatus, InboxMessage, TokenUpdate,
  MinionQueueOpts, ChildDoneMessage, ChildOutcome, Attachment, AttachmentInput,
} from './types.ts';
import { rowToMinionJob, rowToInboxMessage, rowToAttachment } from './types.ts';
import { validateAttachment } from './attachments.ts';
import { isProtectedJobName } from './protected-names.ts';
import { assertEmbedBackfillQueueAdmission } from './embed-backfill-admission.ts';
import {
  computeParamHash,
  resolveAdmissionPolicy,
  resolveTtlNames,
  QueueQuotaExceededError,
  PARAM_HASH_EXCLUDED_KEYS,
  TTL_REASON_PREFIX,
} from './admission.ts';
import {
  defaultTimeoutMsFor, HANDLER_DEFAULT_TIMEOUT_MS,
  defaultLockDurationMsFor, HANDLER_DEFAULT_LOCK_DURATION_MS, clampLockDurationMs,
} from './handler-timeouts.ts';
import {
  withRetry, BULK_RETRY_OPTS, resolveBulkRetryOpts, computeNextDelay,
  isRetryableConnError,
} from '../retry.ts';
import {
  logBatchRetry as auditLogBatchRetry,
  logBatchExhausted as auditLogBatchExhausted,
} from '../audit/batch-retry-audit.ts';
/** Trusted 4th argument, kept outside user-spread job options. */
export interface TrustedSubmitOpts {
  /** Allow PROTECTED_JOB_NAMES; CLI or operation-local callers only. */
  allowProtectedSubmit?: boolean;
  /** Allow PGLite embed-backfill only for an explicit inline-worker caller. */
  allowPgliteInlineWorker?: boolean;
}

const MIGRATION_VERSION = 7;

const DEFAULT_MAX_SPAWN_DEPTH = 5;
export const DREAM_INLINE_PRIVATE_QUEUE_PREFIX = 'dream-inline-';
export const DEFAULT_PRIVATE_QUEUE_LEASE_MS = 10 * 60 * 1000;
/**
 * Machine-readable reason family for private-queue reconciliation, mirroring
 * the waiting-TTL prefix convention: every reconcile cancellation is stamped
 * `<prefix>: <detail>` by reconcilePrivateQueue itself, so jobs-stats/doctor
 * surfaces can LIKE-match the family without chasing per-call-site strings.
 */
export const PRIVATE_QUEUE_RECONCILE_REASON_PREFIX = 'private_queue_reconciled';

/**
 * Stall-sweep reclaim grace (#4145, CDX-7): don't reclaim a row whose
 * `lock_until` lapsed within the last N ms. When a CPU-starved worker's
 * event loop unblocks, its coalesced renewal tick and the stall sweep
 * fire in the same burst — if the sweep's UPDATE lands first it steals
 * the OWNER'S live job. The grace is a HEAD-START for the owner's
 * recovery renewal, not a guarantee: it only covers starvation bursts
 * shorter than the grace, and a healthy second worker's sweep still
 * wins beyond it. Minion analog of `GBRAIN_LOCK_STEAL_GRACE_SECONDS`
 * (db-lock.ts), adapted because minion_jobs has no last_refreshed_at.
 *
 * Cost: dead-worker recovery becomes lock_until + grace + up to
 * stalledInterval. Env `GBRAIN_MINION_STALL_RECLAIM_GRACE_MS` (0 allowed
 * — restores the exact legacy reclaim predicate).
 */
export const DEFAULT_STALL_RECLAIM_GRACE_MS = 15_000;

const _warnedGraceEnv = new Set<string>();

export function _resetStallGraceWarningsForTests(): void {
  _warnedGraceEnv.clear();
}

export function resolveStallReclaimGraceMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GBRAIN_MINION_STALL_RECLAIM_GRACE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALL_RECLAIM_GRACE_MS;
  // Unlike the lock-renewal knobs, 0 is a VALID value here (legacy reclaim).
  if (!/^\d+$/.test(raw.trim())) {
    if (!_warnedGraceEnv.has(raw)) {
      _warnedGraceEnv.add(raw);
      process.stderr.write(
        `[minions] env GBRAIN_MINION_STALL_RECLAIM_GRACE_MS=${JSON.stringify(raw)} is not a non-negative integer; ` +
        `falling back to default ${DEFAULT_STALL_RECLAIM_GRACE_MS}\n`,
      );
    }
    return DEFAULT_STALL_RECLAIM_GRACE_MS;
  }
  const n = Number(raw.trim());
  // Cap at 10 minutes: an absurd digit string (Number → huge/Infinity)
  // would otherwise push the sweep cutoff to -infinity and silently
  // disable stalled-job recovery altogether.
  const MAX_GRACE_MS = 600_000;
  if (n > MAX_GRACE_MS) {
    if (!_warnedGraceEnv.has(raw)) {
      _warnedGraceEnv.add(raw);
      process.stderr.write(
        `[minions] env GBRAIN_MINION_STALL_RECLAIM_GRACE_MS=${JSON.stringify(raw)} exceeds the ${MAX_GRACE_MS}ms cap; clamping\n`,
      );
    }
    return MAX_GRACE_MS;
  }
  return n;
}
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB

const TERMINAL_STATUSES = ['completed', 'failed', 'dead', 'cancelled'] as const;
const NON_TERMINAL_STATUSES: MinionJobStatus[] = ['waiting', 'active', 'delayed', 'waiting-children', 'paused'];
/**
 * Literal IN-list derived from the constant above, for the recovery queries:
 * the partial indexes idx_minion_jobs_private_queue_* embed these statuses in
 * their WHERE predicate, and a parameterized `= ANY($n)` under a generic plan
 * cannot be proven to imply it — literals keep the queries index-eligible.
 * Values are internal constants, never user input.
 */
const NON_TERMINAL_SQL_LIST = NON_TERMINAL_STATUSES.map(st => `'${st}'`).join(', ');

export function isDreamInlinePrivateQueue(queueName: string): boolean {
  return queueName.startsWith(DREAM_INLINE_PRIVATE_QUEUE_PREFIX);
}

export interface PrivateQueueRecoveryResult {
  scanned_queues: number;
  cancelled_queues: number;
  cancelled_jobs: number;
  skipped_live_queues: number;
  skipped_unowned_queues: number;
  skipped_non_orphan_queues: number;
}

/** Audit payload deferred from inside the submission transaction. */
type CoalesceAuditEvent = {
  queue: string; name: string; returned_job_id: number;
  waiting_count?: number; max_waiting?: number;
  pending_count?: number; max_pending?: number;
  /** Set when the coalesce matched on an identical payload hash (admission). */
  param_hash?: string;
};

/** Shared cap-hit coalesce return for the backpressure guards: hydrate the
 *  existing row, stamp the non-persisted `coalesced` marker, hand the audit
 *  payload to the caller's sink, return. Both maxWaiting and maxPending route
 *  through here so the coalesce contract cannot drift between them.
 *
 *  The sink DEFERS the audit write to after the transaction commits: the
 *  audit append is filesystem I/O, and doing it while holding the advisory
 *  lock + a pool connection would let a hung audit volume serialize every
 *  submission for the scope (adversarial-review finding). */
function coalesceReturn(
  row: Record<string, unknown>,
  audit: Omit<CoalesceAuditEvent, 'returned_job_id'>,
  sink: (ev: CoalesceAuditEvent) => void,
): MinionJob {
  const coalesced = rowToMinionJob(row);
  coalesced.coalesced = true;
  sink({ ...audit, returned_job_id: coalesced.id });
  return coalesced;
}

export class MinionQueue {
  readonly maxSpawnDepth: number;
  readonly maxAttachmentBytes: number;

  constructor(private engine: BrainEngine, opts: MinionQueueOpts = {}) {
    this.maxSpawnDepth = opts.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
    this.maxAttachmentBytes = opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  /** Verify minion_jobs table exists (migration v5+). Call before first operation. */
  async ensureSchema(): Promise<void> {
    const ver = await this.engine.getConfig('version');
    const current = parseInt(ver || '1', 10);
    if (current < MIGRATION_VERSION) {
      throw new Error(
        `minion_jobs table not found (schema version ${current}, need ${MIGRATION_VERSION}). Run 'gbrain init' to apply migrations.`
      );
    }
  }

  /**
   * Submit a new job.
   *
   * Wrapped in engine.transaction(): when parent_job_id is set, takes
   * SELECT ... FOR UPDATE on the parent so concurrent submissions serialize
   * on the cap check. Without this, two concurrent submissions could both
   * see count = N-1 and both insert, blowing max_children.
   *
   * Child status is 'waiting' (or 'delayed') — claimable. Parent is flipped
   * to 'waiting-children' atomically. Idempotency_key dedups via PG unique
   * partial index; same key returns the existing row (no second insert).
   */
  async add(
    name: string,
    data?: Record<string, unknown>,
    opts?: Partial<MinionJobInput>,
    trusted?: TrustedSubmitOpts,
  ): Promise<MinionJob> {
    // Normalize first so the protected-name check and the insert use the same
    // canonical form. Without the trim-before-check, `queue.add(' shell ', ...)`
    // would evade the guard and insert a job literally named 'shell'.
    const jobName = (name || '').trim();
    if (jobName.length === 0) {
      throw new Error('Job name cannot be empty');
    }
    assertEmbedBackfillQueueAdmission(this.engine, jobName, data, trusted);
    if (isProtectedJobName(jobName) && !trusted?.allowProtectedSubmit) {
      throw new Error(
        `protected job name '${jobName}' requires CLI or operation-local submitter ` +
        `(pass {allowProtectedSubmit: true} as the 4th arg to MinionQueue.add)`,
      );
    }
    // v0.38 (S1.7 + D6) — capability-based gate replaces the v0.31.12 Anthropic
    // pin. The subagent loop now routes through `gateway.toolLoop()` so any
    // provider whose recipe declares tool calling AND supports_subagent_loop
    // works. Refuse-at-submit when the requested model cannot run a tool loop
    // (no tools, loop declared unsupported, or unknown provider). The handler
    // (`subagent.ts`) does a defense-in-depth check at dispatch time too.
    if (jobName === 'subagent' && data && typeof data === 'object') {
      const submittedModel = (data as { model?: unknown }).model;
      if (typeof submittedModel === 'string' && submittedModel.length > 0) {
        const { classifyCapabilities } = await import('../ai/capabilities.ts');
        const verdict = classifyCapabilities(submittedModel);
        if (verdict === 'unusable:no_tools') {
          throw new Error(
            `subagent job rejected: data.model "${submittedModel}" lacks native tool calling. ` +
            `The subagent loop dispatches brain ops via tool calls — without tool support the loop has no way to run. ` +
            `Pick a provider that supports tools (anthropic, openai, google, litellm, deepseek, groq, together, azure-openai).`,
          );
        }
        if (verdict === 'unusable:no_subagent_loop') {
          throw new Error(
            `subagent job rejected: data.model "${submittedModel}" comes from a provider whose recipe declares ` +
            `supports_subagent_loop: false — its tool_call_ids are not stable enough across crashes/replays ` +
            `to drive the subagent loop. ` +
            `Pick a provider whose recipe declares supports_subagent_loop: true (e.g. anthropic, openai, google, deepseek, groq).`,
          );
        }
        if (verdict === 'unknown') {
          // v0.46.3: derive the provider list from the recipe registry instead
          // of a hardcoded string (which drifted silently as recipes came and
          // went — and would have needed editing again at the ZE removal).
          const { listRecipes } = await import('../ai/recipes/index.ts');
          const known = listRecipes().map((r) => r.id).join(', ');
          throw new Error(
            `subagent job rejected: data.model "${submittedModel}" references an unknown provider. ` +
            `Use format provider:model where provider matches a recipe in src/core/ai/recipes/. ` +
            `Known providers: ${known}.`,
          );
        }
        // 'degraded:no_caching' and 'degraded:no_parallel' pass through — the
        // gateway prints a once-per-(source, model) cost warning at first
        // dispatch. 'ok' passes through silently.
      }
    }
    await this.ensureSchema();

    const childStatus: MinionJobStatus = opts?.delay ? 'delayed' : 'waiting';
    const delayUntil = opts?.delay ? new Date(Date.now() + opts.delay) : null;
    const maxSpawnDepth = opts?.max_spawn_depth ?? this.maxSpawnDepth;

    // Admission policy (param-coalescing + name-global quota). Resolved
    // OUTSIDE the transaction (60s in-process cache; fail-open to defaults).
    // Parented submits never coalesce: fanout children belong to their
    // parent's bookkeeping/aggregator — returning some other child would
    // corrupt child_done accounting. opts.coalesce_params overrides per call.
    const policy = await resolveAdmissionPolicy(this.engine, jobName);
    // An EMPTY payload (after excluding the hash key itself) carries no
    // dedupe signal — two no-param submits are more likely distinct
    // placeholder/scaffolding jobs than a runaway producer (which always
    // carries a prompt). Never coalesce those.
    // A caller-supplied idempotency_key also disables param-coalescing:
    // producer-owned idempotency is the STRONGER contract ("this exact key
    // maps to this exact row"), and a param-coalesce hit would return a row
    // the key was never registered against — a later same-key submit would
    // then insert fresh and run the work twice (adversarial-review finding).
    const hashablePayload = Object.keys(data ?? {}).some(k => !PARAM_HASH_EXCLUDED_KEYS.has(k));
    const coalesceActive =
      (opts?.coalesce_params ?? policy.coalesceParams) &&
      !opts?.parent_job_id &&
      !opts?.idempotency_key &&
      hashablePayload &&
      childStatus === 'waiting';
    let paramHash: string | null = null;
    if (coalesceActive) {
      // Execution options are part of the coalescing IDENTITY (codex re-review
      // P1): identical payloads with different timeout/priority/attempt/
      // quiet-hours semantics are NOT the same job — coalescing them would
      // silently hand the second submitter the first's execution contract.
      // Only DEFINED options fold in (conservative: an explicit value never
      // coalesces onto an implicit-default row; forward-safe like any hash
      // input change — old rows just stop matching).
      const optIdentity: Record<string, unknown> = {};
      for (const k of ['priority', 'timeout_ms', 'max_attempts', 'quiet_hours', 'lock_duration_ms', 'delay_ms', 'max_stalled'] as const) {
        const v = (opts as Record<string, unknown> | undefined)?.[k];
        if (v !== undefined) optIdentity[k] = v;
      }
      paramHash = computeParamHash(
        Object.keys(optIdentity).length > 0
          ? { ...(data ?? {}), __opts_identity: optIdentity }
          : ((data ?? {}) as Record<string, unknown>),
      );
      // Clone rather than mutate the caller's object; the hash rides in the
      // payload (the __-prefixed embedded-metadata convention) so the SQL
      // match needs no DDL and `jobs get` shows what matched.
      data = { ...(data ?? {}), __param_hash: paramHash };
    }

    // Set inside the transaction by a cap-hit coalesce; flushed AFTER commit
    // so audit filesystem I/O never runs while holding the advisory lock.
    let coalesceAudit: CoalesceAuditEvent | null = null;

    const result = await this.engine.transaction(async (tx) => {
      // 1. Idempotency fast path — if a row already exists for this key, return it
      //    without doing any other work. The unique partial index guarantees
      //    no second row can be inserted with the same non-null key.
      //
      //    Dead/cancelled jobs represent permanently-failed work whose
      //    idempotency slot must be freed so a fresh attempt can be inserted.
      //    We NULL the key (preserving the row for audit) and fall through
      //    to the INSERT path below.
      if (opts?.idempotency_key) {
        const existing = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs WHERE idempotency_key = $1`,
          [opts.idempotency_key]
        );
        if (existing.length > 0) {
          const existingJob = rowToMinionJob(existing[0]);
          if (existingJob.status === 'dead' || existingJob.status === 'cancelled') {
            await tx.executeRaw(
              `UPDATE minion_jobs SET idempotency_key = NULL WHERE id = $1`,
              [existingJob.id]
            );
          } else {
            existingJob.coalesced = true;
            return existingJob;
          }
        }
      }

      // 1a. Param-coalescing (admission): an identical parentless submit —
      // same (name, queue, payload hash, incl. __owner_client_id so owner
      // lanes never cross) — returns the newest matching WAITING row instead
      // of inserting a duplicate. Honest-dispatch contract holds (coalesced:
      // true), and unlike the cap-hit coalesce below, returning this row to a
      // result-consumer is semantically exact: identical params ⇒ identical
      // result. Waiting-only by design (a RUNNING identical job does not
      // suppress a re-run; maxPending exists for single-flight callers).
      // Age-bounded to ttl/2: coalescing onto a nearly-TTL-expired row would
      // silently kill the fresh intent an hour later (round-2 V7).
      if (coalesceActive && paramHash) {
        const admissionQueue = opts?.queue ?? 'default';
        // Lock-census (PR6 D5): INTENTIONALLY not source-keyed — admission identity is (name, queue, param-hash); any source in the payload is already folded into paramHash.
        await tx.executeRaw(
          `SELECT pg_advisory_xact_lock(hashtext('minion_admission:' || $1 || ':' || $2 || ':' || $3))`,
          [jobName, admissionQueue, paramHash]
        );
        const ttlHours = policy.ttlWaitingHours;
        // updated_at, matching the TTL sweep's key: a requeued row has a
        // fresh TTL window and is a legitimate coalesce target again.
        const ageCond = ttlHours != null
          ? `AND updated_at > now() - ($4 * interval '1 hour')`
          : '';
        const matchParams: unknown[] = [jobName, admissionQueue, paramHash];
        if (ttlHours != null) matchParams.push(ttlHours / 2);
        const match = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs
            WHERE name = $1 AND queue = $2 AND status = 'waiting'
              AND parent_job_id IS NULL
              AND data->>'__param_hash' = $3
              ${ageCond}
            ORDER BY created_at DESC, id DESC
            LIMIT 1`,
          matchParams
        );
        if (match.length > 0) {
          return coalesceReturn(match[0], {
            queue: admissionQueue,
            name: jobName,
            param_hash: paramHash,
          }, ev => { coalesceAudit = ev; });
        }
      }

      // 1a2. Name-global waiting quota (admission; config-only, no shipped
      // default — user decision D2C). Counts the name across ALL queues:
      // fanout producers use per-run private queues (dream-inline-*), so a
      // queue-scoped count would reset per run and never bind. REJECTION,
      // not coalesce — quota-coalescing would hand result-consumers an
      // unrelated row. The name-global advisory lock below serializes
      // check+insert across concurrent submitters (adversarial finding:
      // without it, N parallel distinct-payload submits each observed
      // capacity and inserted, so overshoot was bounded only by attacker
      // concurrency — defeating the DoS backstop). Serialization cost only
      // applies to names with a quota configured, i.e. the runaway ones.
      if (policy.quotaMaxWaiting != null) {
        // Lock-census (PR6 D5): INTENTIONALLY cross-source AND cross-queue — the quota is a name-global DoS backstop; scoping the key would let per-source submitters overshoot it in parallel.
        await tx.executeRaw(
          `SELECT pg_advisory_xact_lock(hashtext('minion_quota:' || $1))`,
          [jobName]
        );
        const quotaRows = await tx.executeRaw<{ count: string }>(
          `SELECT count(*)::text AS count FROM minion_jobs WHERE name = $1 AND status = 'waiting'`,
          [jobName]
        );
        const waitingTotal = parseInt(quotaRows[0]?.count ?? '0', 10);
        if (waitingTotal >= policy.quotaMaxWaiting) {
          throw new QueueQuotaExceededError(jobName, waitingTotal, policy.quotaMaxWaiting);
        }
      }

      // 1b. Submission-time backpressure for high-frequency named jobs.
      // Two guards share the advisory-lock machinery but differ in what they
      // count and how they scope:
      //   - maxWaiting (rate cap): counts status='waiting' only. Source scope
      //     is NULL-as-wildcard — a submission with no source key counts ALL
      //     rows for (name, queue). Intentional; existing callers rely on it.
      //   - maxPending (single-flight): counts waiting rows PLUS live-lock
      //     active rows (lock_until > now()). An expired-lock active belongs
      //     to a dead/blocked worker and must NOT suppress dispatch — the
      //     fresh waiting row keeps feeding the waitingClaimable>0 wedge
      //     detectors (supervisor watchdog, jobs stats) that a suppressed
      //     queue would otherwise starve. Source scope is EXACT (NULL matches
      //     only NULL-source rows), so a legacy no-source dispatch can never
      //     coalesce into an arbitrary per-source row.
      //
      // Correctness: two concurrent submitters could both see count < cap and
      // both insert, violating the cap. `pg_advisory_xact_lock` keyed on
      // (name, queue, source) serializes concurrent count+insert decisions
      // for the SAME scope while leaving other scopes fully parallel; both
      // guards share the key namespace so maxWaiting and maxPending
      // submitters for one scope serialize against each other. The lock
      // releases on txn commit/rollback automatically — no cleanup path to
      // leak.
      //
      // Queue scope: the filters include `queue=$2` so a waiting
      // 'autopilot-cycle' in queue 'default' does NOT suppress submissions
      // to queue 'shell' with the same name (pre-D2 cross-queue bleed).
      //
      // Engine compatibility: PGLite (WASM Postgres 17) supports
      // pg_advisory_xact_lock, so this works on both engines without branching.
      if (opts?.maxWaiting !== undefined || opts?.maxPending !== undefined) {
        const backpressureQueue = opts?.queue ?? 'default';
        // Multi-source scope: jobs of the same (name, queue) but different
        // source are independent workstreams (per-source sync/cycle). Counting
        // them together made a waiting default-source sync swallow every other
        // source's freshness sync. Both payload spellings are read: sync/
        // webhook payloads carry camelCase sourceId; per-source autopilot
        // payloads carry snake_case source_id.
        const d = data as Record<string, unknown> | undefined;
        const bpSourceId = typeof d?.sourceId === 'string' ? d.sourceId as string
          : typeof d?.source_id === 'string' ? d.source_id as string
          : null;
        // Lock-census (PR6 D5): COMPLIANT — key already folds the payload source (coalesce($3,'')); the NULL-source wildcard arm is the documented maxWaiting contract above.
        await tx.executeRaw(
          `SELECT pg_advisory_xact_lock(hashtext('minion_maxwaiting:' || $1 || ':' || $2 || ':' || coalesce($3, '')))`,
          [jobName, backpressureQueue, bpSourceId]
        );
        const scopeExact = `COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $3`;
        const scopeWildcard = `($3::text IS NULL OR ${scopeExact})`;

        // maxPending first: the stricter, in-flight-aware guard.
        if (opts?.maxPending !== undefined) {
          const maxPending = Math.max(1, Math.floor(opts.maxPending));
          const pendingCond = `(status = 'waiting' OR (status = 'active' AND lock_until > now()))`;
          const pendingCountRows = await tx.executeRaw<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM minion_jobs
             WHERE name = $1 AND queue = $2 AND ${pendingCond}
               AND ${scopeExact}`,
            [jobName, backpressureQueue, bpSourceId]
          );
          const pendingCount = parseInt(pendingCountRows[0]?.count ?? '0', 10);
          if (pendingCount >= maxPending) {
            const existingPending = await tx.executeRaw<Record<string, unknown>>(
              `SELECT * FROM minion_jobs
               WHERE name = $1 AND queue = $2 AND ${pendingCond}
                 AND ${scopeExact}
               ORDER BY CASE WHEN status = 'waiting' THEN 0 ELSE 1 END, created_at DESC, id DESC
               LIMIT 1`,
              [jobName, backpressureQueue, bpSourceId]
            );
            if (existingPending.length > 0) {
              return coalesceReturn(existingPending[0], {
                queue: backpressureQueue,
                name: jobName,
                pending_count: pendingCount,
                max_pending: maxPending,
              }, ev => { coalesceAudit = ev; });
            }
          }
        }

        if (opts?.maxWaiting !== undefined) {
          const maxWaiting = Math.max(1, Math.floor(opts.maxWaiting));
          const waitingCountRows = await tx.executeRaw<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM minion_jobs
             WHERE name = $1 AND queue = $2 AND status = 'waiting'
               AND ${scopeWildcard}`,
            [jobName, backpressureQueue, bpSourceId]
          );
          const waitingCount = parseInt(waitingCountRows[0]?.count ?? '0', 10);
          if (waitingCount >= maxWaiting) {
            const existingWaiting = await tx.executeRaw<Record<string, unknown>>(
              `SELECT * FROM minion_jobs
               WHERE name = $1 AND queue = $2 AND status = 'waiting'
                 AND ${scopeWildcard}
               ORDER BY created_at DESC, id DESC
               LIMIT 1`,
              [jobName, backpressureQueue, bpSourceId]
            );
            if (existingWaiting.length > 0) {
              return coalesceReturn(existingWaiting[0], {
                queue: backpressureQueue,
                name: jobName,
                waiting_count: waitingCount,
                max_waiting: maxWaiting,
              }, ev => { coalesceAudit = ev; });
            }
          }
        }
      }

      // 2. Parent lock + depth/cap validation
      let depth = 0;
      if (opts?.parent_job_id) {
        const parentRows = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs WHERE id = $1 FOR UPDATE`,
          [opts.parent_job_id]
        );
        if (parentRows.length === 0) {
          throw new Error(`parent_job_id ${opts.parent_job_id} not found`);
        }
        const parent = rowToMinionJob(parentRows[0]);

        depth = parent.depth + 1;
        if (depth > maxSpawnDepth) {
          throw new Error(`spawn depth ${depth} exceeds maxSpawnDepth ${maxSpawnDepth}`);
        }

        if (parent.max_children !== null) {
          const countRows = await tx.executeRaw<{ count: string }>(
            `SELECT count(*)::text as count FROM minion_jobs
             WHERE parent_job_id = $1 AND status NOT IN ('completed','failed','dead','cancelled')`,
            [opts.parent_job_id]
          );
          const live = parseInt(countRows[0]?.count ?? '0', 10);
          if (live >= parent.max_children) {
            throw new Error(`parent ${opts.parent_job_id} already has ${live} live children (max_children=${parent.max_children})`);
          }
        }
      }

      // 3. Insert child. Use ON CONFLICT for idempotency; if a concurrent submit
      //    raced past the fast-path SELECT, the unique index catches it here.
      //    quiet_hours + stagger_key always present (null fallback; schema
      //    stores NULL). max_stalled is conditional: provided values get
      //    clamped to [1, 100] and included in the INSERT; omitted values
      //    skip the column so the schema DEFAULT (5 as of v0.14.1) kicks in.
      //    Keeps the app layer from hardcoding the schema default constant.
      //
      //    Footgun note (codex iter 3): threading max_stalled on INSERT only is
      //    deliberate. An idempotency-key hit returns the EXISTING row via the
      //    fast-path SELECT above — we do NOT UPDATE max_stalled on a re-submit,
      //    because letting a second submitter mutate the first submitter's
      //    durability semantics is a nasty surprise.
      const hasMaxStalled = opts?.max_stalled !== undefined && opts.max_stalled !== null;
      const clampedMaxStalled = hasMaxStalled
        ? Math.max(1, Math.min(100, Math.floor(opts!.max_stalled as number)))
        : null;

      const privateQueueLeaseUntil = opts?.private_queue_lease_ms != null
        ? new Date(Date.now() + Math.max(1, Math.floor(opts.private_queue_lease_ms))).toISOString()
        : null;

      const baseCols = `name, queue, status, priority, data, max_attempts, backoff_type,
            backoff_delay, backoff_jitter, delay_until, parent_job_id, on_child_fail,
            depth, max_children, timeout_ms, lock_duration_ms, remove_on_complete, remove_on_fail, idempotency_key,
            quiet_hours, stagger_key, private_queue_owner_job_id, private_queue_owner_token, private_queue_lease_until`;
      const baseVals = `$1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21`;
      const baseValsWithOwner = `${baseVals}, $22, $23, $24`;
      const cols = hasMaxStalled ? `${baseCols}, max_stalled` : baseCols;
      const vals = hasMaxStalled ? `${baseValsWithOwner}, $25` : baseValsWithOwner;

      const insertSql = opts?.idempotency_key
        ? `INSERT INTO minion_jobs (${cols})
           VALUES (${vals})
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING *`
        : `INSERT INTO minion_jobs (${cols})
           VALUES (${vals})
           RETURNING *`;

      const params: unknown[] = [
        jobName,
        opts?.queue ?? 'default',
        childStatus,
        opts?.priority ?? 0,
        data ?? {},
        opts?.max_attempts ?? 3,
        opts?.backoff_type ?? 'exponential',
        opts?.backoff_delay ?? 1000,
        opts?.backoff_jitter ?? 0.2,
        delayUntil?.toISOString() ?? null,
        opts?.parent_job_id ?? null,
        opts?.on_child_fail ?? 'fail_parent',
        depth,
        opts?.max_children ?? null,
        // #1737: long handlers (subagent, embed-backfill, autopilot-cycle) get a
        // sane long wall-clock default stamped at submit when the caller didn't
        // pass one, so they aren't killed mid-progress by the short null-default.
        opts?.timeout_ms ?? defaultTimeoutMsFor(jobName),
        // #4145: same three-layer pattern for the lock lease. Explicit input
        // is clamped to [5s,1h]; absent → handler map default; NULL row =
        // worker-global lockDuration at claim. INSERT-only (see the
        // max_stalled footgun note above): an idempotency-key re-submit
        // never mutates the first submitter's lease.
        opts?.lock_duration_ms != null
          ? clampLockDurationMs(opts.lock_duration_ms)
          : defaultLockDurationMsFor(jobName),
        opts?.remove_on_complete ?? false,
        opts?.remove_on_fail ?? false,
        opts?.idempotency_key ?? null,
        opts?.quiet_hours ?? null,
        opts?.stagger_key ?? null,
        opts?.private_queue_owner_job_id ?? null,
        opts?.private_queue_owner_token ?? null,
        privateQueueLeaseUntil,
      ];
      if (hasMaxStalled) params.push(clampedMaxStalled);

      const inserted = await tx.executeRaw<Record<string, unknown>>(insertSql, params);

      // ON CONFLICT DO NOTHING returns 0 rows — fall back to SELECT to fetch the
      // existing row that won the race.
      if (inserted.length === 0 && opts?.idempotency_key) {
        const existing = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs WHERE idempotency_key = $1`,
          [opts.idempotency_key]
        );
        if (existing.length === 0) {
          throw new Error(`idempotency_key ${opts.idempotency_key} insert returned no row and no existing row found`);
        }
        const raced = rowToMinionJob(existing[0]);
        raced.coalesced = true; // third coalesce path: lost the insert race
        return raced;
      }

      const child = rowToMinionJob(inserted[0]);

      // 4. Flip parent to waiting-children if this is a fresh child insert.
      //    Only transition from non-terminal, non-already-waiting-children states.
      if (opts?.parent_job_id) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting-children', updated_at = now()
           WHERE id = $1 AND status IN ('waiting','active','delayed')`,
          [opts.parent_job_id]
        );
      }

      return child;
    });

    // Deferred audit flush — after commit, advisory lock released, connection
    // returned to the pool. A hung/slow audit volume degrades only this one
    // submission's latency, never the queue.
    if (coalesceAudit) {
      try {
        const { logBackpressureCoalesce } = await import('./backpressure-audit.ts');
        logBackpressureCoalesce(coalesceAudit);
      } catch { /* audit failures never block submission */ }
    }

    return result;
  }

  /** Get a job by ID. Returns null if not found. */
  async getJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      'SELECT * FROM minion_jobs WHERE id = $1',
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** List jobs with optional filters. */
  async getJobs(opts?: {
    status?: MinionJobStatus;
    queue?: string;
    name?: string;
    limit?: number;
    offset?: number;
    /**
     * #4098 — agent-lane ownership fence: restrict to jobs whose
     * `data->>'__owner_client_id'` equals this OAuth client id (the JSONB
     * predicate submit_agent stamps at enqueue). SQL-side WHERE, never a
     * post-fetch JS filter, so a fenced list can't leak foreign rows.
     */
    ownerClientId?: string;
  }): Promise<MinionJob[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(opts.status);
    }
    if (opts?.queue) {
      conditions.push(`queue = $${idx++}`);
      params.push(opts.queue);
    }
    if (opts?.name) {
      conditions.push(`name = $${idx++}`);
      params.push(opts.name);
    }
    if (opts?.ownerClientId) {
      conditions.push(`data->>'__owner_client_id' = $${idx++}`);
      params.push(opts.ownerClientId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM minion_jobs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );
    return rows.map(rowToMinionJob);
  }

  /** Remove a job. Only terminal statuses can be removed. */
  async removeJob(id: number): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `DELETE FROM minion_jobs WHERE id = $1 AND status IN ('completed', 'dead', 'cancelled', 'failed') RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  /**
   * Cancel a job and cascade-kill all descendants in one statement.
   *
   * Honest scope: this is BullMQ-style best-effort cancel. The recursive CTE
   * snapshots the parent_job_id chain at statement start. A descendant
   * re-parented BEFORE the cancel call is excluded; one re-parented DURING
   * the call may still get cancelled (cancel wins if seen in the snapshot).
   * Re-parented descendants whose parent_job_id is NULL'd by
   * removeChildDependency naturally fall out of the recursive walk.
   *
   * Active descendants get lock_token = NULL — same path pause uses, so the
   * worker's renewLock will fail next tick and AbortController fires.
   *
   * Returns the *root* (the job matching id), not an arbitrary descendant.
   */
  async cancelJob(id: number, opts?: { ownerClientId?: string }): Promise<MinionJob | null> {
    const cancelled = await this.cancelJobs([id], opts?.ownerClientId ? { ownerClientId: opts.ownerClientId } : undefined);
    const root = cancelled.find(j => j.id === id);
    return root ?? null;
  }

  /**
   * Terminalize every non-terminal job in one private, parent-owned queue.
   *
   * Dream phases drain `dream-inline-*` queues themselves; the shared worker
   * intentionally never claims them.  A phase therefore owns cleanup too:
   * every return/throw/timeout path calls this from `finally`.  The method is
   * idempotent and routes through cancelJobs() so child_done messages,
   * descendant cancellation, active-job aborts, and aggregator unblocking all
   * retain the queue's normal bookkeeping semantics.
   */
  async reconcilePrivateQueue(queueName: string, reason: string): Promise<MinionJob[]> {
    if (!isDreamInlinePrivateQueue(queueName)) {
      throw new Error(`refusing to reconcile non-private queue '${queueName}'`);
    }
    // Enforce the machine-readable family at the single choke point so the
    // call sites (phase finally ×2, supervisor/worker spawn, cycle start,
    // startup recovery) can never drift apart.
    if (!reason.startsWith(PRIVATE_QUEUE_RECONCILE_REASON_PREFIX)) {
      reason = `${PRIVATE_QUEUE_RECONCILE_REASON_PREFIX}: ${reason}`;
    }
    const rows = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs
        WHERE queue = $1
          AND status IN ('waiting','active','delayed','waiting-children','paused')
        ORDER BY id`,
      [queueName],
    );
    if (rows.length === 0) return [];
    return this.cancelJobs(rows.map(r => r.id), {
      reason,
      rootStatuses: ['waiting', 'active', 'delayed', 'waiting-children', 'paused'],
    });
  }

  /**
   * Renew the owner lease on still-non-terminal jobs in one private queue.
   * The owner token prevents a stale phase finally/keepalive from extending a
   * successor queue that reused the same queue name in a test or fixture.
   */
  async renewPrivateQueueLease(
    queueName: string,
    ownerToken: string,
    leaseMs = DEFAULT_PRIVATE_QUEUE_LEASE_MS,
  ): Promise<number> {
    if (!isDreamInlinePrivateQueue(queueName)) {
      throw new Error(`refusing to renew non-private queue '${queueName}'`);
    }
    if (ownerToken.length === 0) {
      throw new Error('private queue owner token cannot be empty');
    }
    // GREATEST: a renewal may only EXTEND the lease. A default-horizon (10min)
    // renewal racing a creation-time horizon sized to the phase's wait timeout
    // must never shrink the window a healthy long run still needs — shrinking
    // is what would let startup recovery cancel a LIVE ownerless queue.
    const rows = await this.engine.executeRaw<{ id: number }>(
      `UPDATE minion_jobs
          SET private_queue_lease_until = GREATEST(
                COALESCE(private_queue_lease_until, to_timestamp(0)),
                now() + ($3::text::interval)
              ),
              updated_at = now()
        WHERE queue = $1
          AND private_queue_owner_token = $2
          AND status IN (${NON_TERMINAL_SQL_LIST})
        RETURNING id`,
      [queueName, ownerToken, `${Math.max(1, Math.floor(leaseMs))} milliseconds`],
    );
    return rows.length;
  }

  /**
   * Throttled keepalive closure for a phase that owns a private queue: renews
   * the lease at most once per `throttleMs`, then runs `onRenewed` (the cycle
   * lock refresh rides it). The throttle gates BOTH — 1-5s drain polls cost
   * one UPDATE per half-minute, not per poll — and the order is fixed
   * (renew, then onRenewed) so a lock-refresh failure can't starve the lease.
   */
  makeThrottledLeaseRenewer(
    queueName: string,
    ownerToken: string,
    onRenewed?: () => Promise<void> | void,
    throttleMs = 30_000,
  ): () => Promise<void> {
    let lastRenewalAtMs = 0;
    return async () => {
      const nowMs = Date.now();
      if (nowMs - lastRenewalAtMs < throttleMs) return;
      lastRenewalAtMs = nowMs;
      await this.renewPrivateQueueLease(queueName, ownerToken);
      if (onRenewed) await onRenewed();
    };
  }

  /**
   * Startup/supervisor crash recovery for metadata-backed private dream queues.
   * Cancels only queues that are provably orphaned:
   *   - no live child lock in the private queue;
   *   - explicit owner metadata exists; and
   *   - the owner job is terminal/missing OR the renewable lease has expired.
   *
   * Legacy `dream-inline-*` rows with no owner metadata are left untouched and
   * remain a Doctor/manual-retriage concern.
   */
  async reconcileOrphanedPrivateQueues(opts: {
    reason?: string;
    maxQueues?: number;
  } = {}): Promise<PrivateQueueRecoveryResult> {
    const result: PrivateQueueRecoveryResult = {
      scanned_queues: 0,
      cancelled_queues: 0,
      cancelled_jobs: 0,
      skipped_live_queues: 0,
      skipped_unowned_queues: 0,
      skipped_non_orphan_queues: 0,
    };
    const maxQueues = Math.max(1, Math.floor(opts.maxQueues ?? 100));
    // HAVING metadata: legacy unowned queues are NEVER recoverable by this
    // lane (doctor/retriage owns them), so they must not occupy the LIMIT
    // window — a backlog of them would otherwise starve every newer orphan
    // out of the scan forever (the incident's exact accumulation shape).
    const queues = await this.engine.executeRaw<{ queue: string }>(
      `SELECT queue
         FROM minion_jobs
        WHERE queue LIKE '${DREAM_INLINE_PRIVATE_QUEUE_PREFIX}%'
          AND status IN (${NON_TERMINAL_SQL_LIST})
        GROUP BY queue
        HAVING bool_or(private_queue_owner_job_id IS NOT NULL OR private_queue_lease_until IS NOT NULL)
        ORDER BY min(created_at), queue
        LIMIT $1`,
      [maxQueues],
    );
    result.scanned_queues = queues.length;
    for (const q of queues) {
      const verdict = await this.classifyPrivateQueueForRecovery(q.queue);
      if (verdict === 'live') {
        result.skipped_live_queues++;
        continue;
      }
      // Defensive only: the scan's HAVING bool_or(owner/lease) excludes
      // metadata-less queues at the SQL level, so this arm is unreachable
      // today — kept in case the scan predicate ever loosens.
      if (verdict === 'unowned') {
        result.skipped_unowned_queues++;
        continue;
      }
      if (verdict === 'not_orphan') {
        result.skipped_non_orphan_queues++;
        continue;
      }
      // Re-verify immediately before cancelling: a child claimed (or a lease
      // renewed) between the first classify and this point flips the verdict
      // to live — the cancel itself must never run on a stale verdict.
      const recheck = await this.classifyPrivateQueueForRecovery(q.queue);
      if (recheck !== 'orphan') {
        result.skipped_non_orphan_queues++;
        continue;
      }
      const cancelled = await this.reconcilePrivateQueue(
        q.queue,
        opts.reason ?? 'startup recovery: orphaned dream-inline private queue',
      );
      if (cancelled.length > 0) {
        result.cancelled_queues++;
        result.cancelled_jobs += cancelled.length;
      }
    }
    return result;
  }

  /**
   * PUBLIC (doctor shares this verdict): the orphaned_private_queue check
   * buckets its candidates through the SAME classifier recovery uses, so the
   * check's advertised remediation and recovery's actual behavior can't drift.
   */
  async classifyPrivateQueueForRecovery(
    queueName: string,
  ): Promise<'orphan' | 'live' | 'unowned' | 'not_orphan'> {
    const rows = await this.engine.executeRaw<{
      active_healthy: string | number;
      owner_ids: unknown;
      metadata_rows: string | number;
      live_owner_rows: string | number;
      nonterminal_owner_rows: string | number;
      max_lease_until: string | null;
      future_lease_rows: string | number;
      recently_touched: string | number;
    }>(
      `WITH q AS (
         SELECT *
           FROM minion_jobs
          WHERE queue = $1
            AND status IN (${NON_TERMINAL_SQL_LIST})
       ),
       owner_ids AS (
         SELECT DISTINCT private_queue_owner_job_id AS id
           FROM q
          WHERE private_queue_owner_job_id IS NOT NULL
       ),
       owners AS (
         SELECT o.id, m.status, m.lock_until
           FROM owner_ids o
           LEFT JOIN minion_jobs m ON m.id = o.id
       )
       SELECT
         count(*) FILTER (WHERE q.status = 'active' AND q.lock_until > now()) AS active_healthy,
         COALESCE(jsonb_agg(DISTINCT q.private_queue_owner_job_id) FILTER (WHERE q.private_queue_owner_job_id IS NOT NULL), '[]'::jsonb) AS owner_ids,
         count(*) FILTER (WHERE q.private_queue_owner_job_id IS NOT NULL OR q.private_queue_lease_until IS NOT NULL) AS metadata_rows,
         (SELECT count(*) FROM owners WHERE status = 'active' AND lock_until > now()) AS live_owner_rows,
         (SELECT count(*) FROM owners WHERE status IN ('waiting','active','delayed','waiting-children','paused')) AS nonterminal_owner_rows,
         max(q.private_queue_lease_until)::text AS max_lease_until,
         count(*) FILTER (WHERE q.private_queue_lease_until > now()) AS future_lease_rows,
         count(*) FILTER (WHERE q.updated_at > now() - interval '120 seconds') AS recently_touched
       FROM q`,
      [queueName],
    );
    const r = rows[0];
    // Defensive only: the FROM q aggregate always yields exactly one row.
    if (!r) return 'not_orphan';
    if (Number(r.active_healthy ?? 0) > 0 || Number(r.live_owner_rows ?? 0) > 0) {
      return 'live';
    }
    if (Number(r.metadata_rows ?? 0) === 0) return 'unowned';
    // Freshness guard BEFORE the owner-terminal fast path: any row touched in
    // the last 2 minutes (a 30s-cadence lease renewal, a claim, a child_done)
    // means SOMETHING is actively working this queue — even when the owner
    // job row reads terminal (stall-swept owner whose drain loop survived a
    // host suspend, the laptop-sleep shape). Never cancel under a live toucher;
    // a genuinely crashed queue goes untouched and classifies orphan on the
    // next pass ≤2 minutes later.
    if (Number(r.recently_touched ?? 0) > 0) return 'live';
    const ownerIds = Array.isArray(r.owner_ids)
      ? r.owner_ids
      : (typeof r.owner_ids === 'string' ? JSON.parse(r.owner_ids) : []);
    const ownerTerminal = ownerIds.length > 0 && Number(r.nonterminal_owner_rows ?? 0) === 0;
    if (ownerTerminal) return 'orphan';
    if (Number(r.future_lease_rows ?? 0) > 0) return 'live';
    const leaseExpired = r.max_lease_until !== null && new Date(r.max_lease_until).getTime() <= Date.now();
    return leaseExpired ? 'orphan' : 'not_orphan';
  }

  /**
   * Batch variant of cancelJob: cancels every root id AND its descendants in
   * ONE transaction, with the full bookkeeping the single-id path carries
   * (child_done inbox messages + aggregator-parent resolution). Callers that
   * cancel in bulk (the waiting-TTL sweep) MUST use this — a raw set-based
   * UPDATE would skip that bookkeeping and wedge parents in waiting-children
   * forever (the exact wedge class this wave fights).
   *
   * `opts.reason` is written to error_text (COALESCE-preserved when a row
   * already carries one). The single-id UPDATE never wrote error_text, so
   * every surface keyed on a reason prefix (jobs stats, doctor) would
   * silently report zero without this parameter.
   */
  async cancelJobs(ids: number[], opts?: { reason?: string; rootStatuses?: MinionJobStatus[]; ownerClientId?: string }): Promise<MinionJob[]> {
    if (ids.length === 0) return [];
    // opts.rootStatuses re-checks each ROOT id's status ATOMICALLY inside the
    // cancel UPDATE's CTE seed. The waiting-TTL sweep passes ['waiting'] to
    // close its SELECT→cancel race: claim() and the sweep both target the
    // oldest waiting rows, so without this a job claimed between the sweep's
    // SELECT and this UPDATE would be cancelled while ACTIVE (lock_token
    // NULLed under the running handler). Operator cancels omit it — killing
    // an active job is exactly what `jobs cancel` means.
    //
    // opts.ownerClientId (#4098) fences the CTE SEED on
    // `data->>'__owner_client_id'`: an agent-scoped caller can cancel only
    // roots it owns. Descendants of an owned root cascade regardless of their
    // own data payload — the recursion follows the owned root, which is the
    // semantic the delegating agent expects (its job tree, not per-row tags).
    const rootStatuses = opts?.rootStatuses ?? null;
    const ownerClientId = opts?.ownerClientId ?? null;
    return this.engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<Record<string, unknown>>(
        `WITH RECURSIVE descendants AS (
          SELECT id, 0 AS d FROM minion_jobs
           WHERE id = ANY($1::int[])
             AND ($3::text[] IS NULL OR status = ANY($3::text[]))
             AND ($4::text IS NULL OR data->>'__owner_client_id' = $4::text)
          UNION ALL
          SELECT m.id, descendants.d + 1
            FROM minion_jobs m
            JOIN descendants ON m.parent_job_id = descendants.id
            WHERE descendants.d < 100
        )
        UPDATE minion_jobs SET
          status = 'cancelled',
          lock_token = NULL,
          lock_until = NULL,
          -- Reason stamps ROOT ids only: a descendant is bookkeeping-cancelled
          -- because its parent went away, not because IT hit the caller's
          -- reason (e.g. a waiting-TTL child would otherwise carry a factually
          -- false 'waited > Nh' text AND inflate the LIKE-prefix stats the
          -- alerting surfaces count).
          error_text = CASE WHEN id = ANY($1::int[]) THEN COALESCE($2, error_text) ELSE error_text END,
          finished_at = now(),
          updated_at = now()
         WHERE id IN (SELECT id FROM descendants)
           AND status IN ('waiting','active','delayed','waiting-children','paused')
         RETURNING *`,
        [ids, opts?.reason ?? null, rootStatuses, ownerClientId]
      );
      if (rows.length === 0) return [];

      // v0.15: emit child_done(outcome='cancelled') for every cancelled row
      // that had a parent. Without this, an aggregator waiting for N
      // child_done messages hangs forever when a child is cancelled (codex
      // iteration 3). Also unblock any aggregator parents whose last
      // non-terminal child we just cancelled.
      const parentIds = new Set<number>();
      for (const r of rows) {
        const childId = r.id as number;
        const parentJobId = r.parent_job_id as number | null;
        const name = r.name as string;
        // Skip the root if it's the caller's cancel target AND has no parent.
        // Descendants whose parent got cancelled in the same sweep still
        // benefit from the inbox message — their parent exits waiting-children
        // via the resolve sweep below even though the parent is itself
        // cancelled (EXISTS guard on inbox INSERT handles it).
        if (parentJobId == null) continue;
        parentIds.add(parentJobId);
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: childId,
          job_name: name,
          result: null,
          outcome: 'cancelled',
          error: 'cancelled',
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [parentJobId, childDone]
        );
      }

      // Resolve any non-cancelled aggregator parents sitting on
      // waiting-children whose last open child we just cancelled.
      for (const parentId of parentIds) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`,
          [parentId]
        );
      }

      return rows.map(rowToMinionJob);
    });
  }

  /**
   * Waiting-TTL sweep (admission control, run from the worker's maintenance
   * interval): cancel jobs still WAITING past their per-name TTL, via
   * cancelJobs() so descendants cancel and aggregator parents resolve.
   *
   * `maxPerTick` bounds one tick's work (default 500) so the first
   * post-upgrade tick against a large backlog can't stall the maintenance
   * loop — the backlog drains over a few ticks. Oldest-first so FIFO
   * fairness of what REMAINS is preserved.
   *
   * NOTE (warn-before-act, user requirement D1A): the worker gates this
   * sweep behind the one-time `minions.ttl_notice_shown` flag — tick 1
   * counts + warns, sweeping starts on tick 2. The gate lives in worker.ts
   * (the channel where the notice prints); this method just sweeps.
   */
  async handleWaitingTTL(opts?: { maxPerTick?: number }): Promise<{ cancelled: number; by_name: Record<string, number> }> {
    const maxPerTick = Math.max(1, Math.floor(opts?.maxPerTick ?? 500));
    const ttlNames = await resolveTtlNames(this.engine);
    const by_name: Record<string, number> = {};
    let cancelled = 0;
    for (const [name, hours] of ttlNames) {
      if (cancelled >= maxPerTick) break;
      const budget = maxPerTick - cancelled;
      // Keyed on updated_at (last state transition), NOT created_at: every
      // path that RETURNS a row to 'waiting' — handleStalled's requeue (sweep
      // #1 of the SAME maintenance tick), retryJob, promoteDelayed, the
      // parent-unblock flips — bumps updated_at but not created_at. Keying on
      // created_at would cancel a job the same tick just requeued it, with a
      // "waited > Nh" reason that is factually false. For rows that sat
      // untouched in 'waiting' the two timestamps are equivalent, so the
      // backlog-drain semantics are unchanged.
      const stale = await this.engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs
          WHERE name = $1 AND status = 'waiting'
            AND updated_at < now() - ($2 * interval '1 hour')
          ORDER BY updated_at ASC
          LIMIT $3`,
        [name, hours, budget]
      );
      if (stale.length === 0) continue;
      const reason =
        `${TTL_REASON_PREFIX}: waited > ${hours}h in queue ` +
        `(minions.ttl_waiting_hours.${name}; set 0 to disable)`;
      // rootStatuses:['waiting'] re-checks atomically inside the cancel — a
      // job CLAIMED between the SELECT above and this UPDATE must not be
      // cancelled mid-run (both the claimer and this sweep target the oldest
      // waiting rows, so the race is systematic, not incidental).
      const swept = await this.cancelJobs(stale.map(r => r.id), { reason, rootStatuses: ['waiting'] });
      // Count only the requested roots — descendants of a swept parent are
      // bookkeeping, not TTL victims of their own.
      const rootIds = new Set(stale.map(r => r.id));
      const rootCount = swept.filter(j => rootIds.has(j.id)).length;
      by_name[name] = (by_name[name] ?? 0) + rootCount;
      cancelled += rootCount;
    }
    return { cancelled, by_name };
  }

  /**
   * Re-queue a failed or dead job for retry.
   *
   * #2783: an explicit `jobs retry` is an operator asserting "run this
   * fresh" — so it clears `started_at` (re-stamped on re-claim via
   * `claim()`'s `COALESCE(started_at, now())`, `queue.ts:620`) and resets
   * `attempts_made`/`attempts_started` to 0. Without this, `started_at`
   * kept the ORIGINAL first-claim time, so `handleWallClockTimeouts()`
   * (anchored on `now() - started_at`, `queue.ts:729-749`) could measure
   * from long before the retry — a retry issued more than `timeout_ms * 2`
   * after the original claim was dead-lettered again in under a second,
   * with `attempts_made` already past `max_attempts`. This made retry
   * useless for exactly the case it exists for: recovering work after an
   * outage that outlasted the job's timeout.
   *
   * Also resets `stalled_counter` (Codex review): `handleStalled()`
   * dead-letters once `stalled_counter + 1 >= max_stalled` (`queue.ts:1190`).
   * A job dead-lettered BY stall exhaustion, left un-reset, would hit that
   * same threshold on its very first lock expiry after retry — a job
   * killed by 3 stalls doesn't get a fresh stall budget, contradicting
   * "run this fresh" the same way the unreset attempt counters did.
   */
  async retryJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', error_text = NULL,
        lock_token = NULL, lock_until = NULL, delay_until = NULL,
        finished_at = NULL, started_at = NULL, attempts_made = 0,
        attempts_started = 0, stalled_counter = 0, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'dead')
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Prune old jobs in terminal statuses. Returns count of deleted rows. */
  async prune(opts?: { olderThan?: Date; status?: MinionJobStatus[]; dryRun?: boolean }): Promise<number> {
    const statuses = opts?.status ?? ['completed', 'dead', 'cancelled'];
    const olderThan = opts?.olderThan ?? new Date(Date.now() - 30 * 86400000);

    // #2712: dryRun counts the would-be-pruned rows without deleting.
    // Silent-ignoring a safety flag on a delete path is data loss.
    if (opts?.dryRun) {
      const rows = await this.engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text as count FROM minion_jobs
         WHERE status = ANY($1) AND updated_at < $2`,
        [statuses, olderThan.toISOString()]
      );
      return parseInt(rows[0]?.count ?? '0', 10);
    }

    const rows = await this.engine.executeRaw<{ count: string }>(
      `WITH pruned AS (
         DELETE FROM minion_jobs
         WHERE status = ANY($1) AND updated_at < $2
         RETURNING id
       )
       SELECT count(*)::text as count FROM pruned`,
      [statuses, olderThan.toISOString()]
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  /** Get job statistics. */
  async getStats(opts?: { since?: Date; queue?: string }): Promise<{
    by_status: Record<string, number>;
    /**
     * Per-type window stats. `total` counts rows CREATED in the window
     * (intake). The `drained_*` fields count rows that reached a terminal
     * status IN the window (`finished_at >= since`) regardless of when they
     * were created — the true outflow. They are split by terminal status
     * because a naive combined "drain" number self-inflates on TTL/manual
     * cancellations while zero useful work happens; divergence alerting
     * compares intake against drained_completed. `waiting_now` and
     * `oldest_waiting_minutes` are point-in-time (not windowed).
     */
    by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number; avg_duration_ms: number | null;
      drained_completed: number; drained_failed: number; drained_dead: number; drained_cancelled: number;
      waiting_now: number; oldest_waiting_minutes: number | null }>;
    queue_health: { waiting: number; active: number; stalled: number };
    /**
     * issue #1801 — QUEUE-SCOPED wedge signature for the `jobs stats` WEDGED
     * line. by_status/by_type/queue_health above stay GLOBAL (dashboard
     * overview); this block is scoped to one queue (default 'default') because
     * a wedge is per-queue — a healthy worker on one queue must not mask a
     * wedged one (Codex #14/#15). `active_healthy` counts only live-lock active
     * rows so an expired-lock row (worker died mid-job) does NOT mask the wedge.
     */
    wedge: {
      queue: string;
      active_healthy: number;
      waiting: number;
      last_completed_at: string | null;
      minutes_since_completion: number | null;
    };
  }> {
    const since = opts?.since ?? new Date(Date.now() - 86400000);
    const wedgeQueue = opts?.queue ?? 'default';

    // Status counts
    const statusRows = await this.engine.executeRaw<{ status: string; count: string }>(
      `SELECT status, count(*)::text as count FROM minion_jobs GROUP BY status`
    );
    const by_status: Record<string, number> = {};
    for (const r of statusRows) by_status[r.status] = parseInt(r.count, 10);

    // Type breakdown (within time window)
    const typeRows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT name,
        count(*)::text as total,
        count(*) FILTER (WHERE status = 'completed')::text as completed,
        count(*) FILTER (WHERE status = 'failed')::text as failed,
        count(*) FILTER (WHERE status = 'dead')::text as dead,
        avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) as avg_duration_ms
       FROM minion_jobs WHERE created_at >= $1
       GROUP BY name ORDER BY total DESC`,
      [since.toISOString()]
    );
    // True per-type outflow: rows that reached a terminal status IN the
    // window, keyed on finished_at (a row created last week and finished
    // today drained today). Split by status — cancellations (incl. the
    // waiting-TTL sweep) are outflow but not useful work.
    const drainRows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT name,
        count(*) FILTER (WHERE status = 'completed')::text AS d_completed,
        count(*) FILTER (WHERE status = 'failed')::text AS d_failed,
        count(*) FILTER (WHERE status = 'dead')::text AS d_dead,
        count(*) FILTER (WHERE status = 'cancelled')::text AS d_cancelled
       FROM minion_jobs
       WHERE finished_at IS NOT NULL AND finished_at >= $1
         AND status IN ('completed','failed','dead','cancelled')
       GROUP BY name`,
      [since.toISOString()]
    );
    const drainByName = new Map(drainRows.map(r => [r.name as string, r]));

    // Point-in-time per-type waiting depth + oldest wait age.
    const depthRows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT name,
        count(*)::text AS waiting_now,
        EXTRACT(EPOCH FROM (now() - min(created_at)))::text AS oldest_waiting_seconds
       FROM minion_jobs WHERE status = 'waiting'
       GROUP BY name`,
      []
    );
    const depthByName = new Map(depthRows.map(r => [r.name as string, r]));

    // Union of names so a type with waiting rows but zero window intake (or
    // vice versa) still gets a row — divergence alerting needs both sides.
    const typeNames = new Set<string>([
      ...typeRows.map(r => r.name as string),
      ...drainRows.map(r => r.name as string),
      ...depthRows.map(r => r.name as string),
    ]);
    const typeByName = new Map(typeRows.map(r => [r.name as string, r]));
    const by_type = [...typeNames].map(name => {
      const r = typeByName.get(name);
      const d = drainByName.get(name);
      const w = depthByName.get(name);
      const oldest = w?.oldest_waiting_seconds != null ? Number(w.oldest_waiting_seconds) : null;
      return {
        name,
        total: r ? parseInt(r.total as string, 10) : 0,
        completed: r ? parseInt(r.completed as string, 10) : 0,
        failed: r ? parseInt(r.failed as string, 10) : 0,
        dead: r ? parseInt(r.dead as string, 10) : 0,
        avg_duration_ms: r?.avg_duration_ms != null ? Math.round(r.avg_duration_ms as number) : null,
        drained_completed: d ? parseInt(d.d_completed as string, 10) : 0,
        drained_failed: d ? parseInt(d.d_failed as string, 10) : 0,
        drained_dead: d ? parseInt(d.d_dead as string, 10) : 0,
        drained_cancelled: d ? parseInt(d.d_cancelled as string, 10) : 0,
        waiting_now: w ? parseInt(w.waiting_now as string, 10) : 0,
        oldest_waiting_minutes: oldest != null && Number.isFinite(oldest) ? Math.round(oldest / 60) : null,
      };
    }).sort((a, b) => b.total - a.total);

    // Queue health: stalled = active with expired lock
    const stalledRows = await this.engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_jobs WHERE status = 'active' AND lock_until < now()`
    );
    const stalled = parseInt(stalledRows[0]?.count ?? '0', 10);

    // issue #1801 — queue-scoped wedge signature (one query, one queue).
    const wedgeRows = await this.engine.executeRaw<{
      active_healthy: string;
      waiting: string;
      last_completed: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'active' AND lock_until > now())::text AS active_healthy,
         count(*) FILTER (WHERE status = 'waiting')::text AS waiting,
         max(updated_at) FILTER (WHERE status = 'completed')::text AS last_completed
       FROM minion_jobs
       WHERE queue = $1`,
      [wedgeQueue],
    );
    const wr = wedgeRows[0] ?? { active_healthy: '0', waiting: '0', last_completed: null };
    const wedgeLastCompleted = wr.last_completed ? new Date(wr.last_completed) : null;

    return {
      by_status,
      by_type,
      queue_health: {
        waiting: by_status['waiting'] ?? 0,
        active: by_status['active'] ?? 0,
        stalled,
      },
      wedge: {
        queue: wedgeQueue,
        active_healthy: parseInt(wr.active_healthy ?? '0', 10),
        waiting: parseInt(wr.waiting ?? '0', 10),
        last_completed_at: wr.last_completed,
        minutes_since_completion: wedgeLastCompleted
          ? Math.round((Date.now() - wedgeLastCompleted.getTime()) / 60_000)
          : null,
      },
    };
  }

  /**
   * Claim the next waiting job for a worker. Token-fenced, filters by registered names.
   *
   * Sets timeout_at = now() + timeout_ms when the job has a per-job deadline,
   * so handleTimeouts() can dead-letter expired jobs without rereading timeout_ms.
   *
   * Claim-time budget fallback: rows inserted before the submit-time stamping
   * (or by any writer that bypasses add()) carry timeout_ms = NULL and used to
   * fall through to the minutes-scale null-default wall-clock sweep — a 30-min
   * handler died at ~5 min purely because of WHEN its row was inserted. The
   * COALESCE below resolves HANDLER_DEFAULT_TIMEOUT_MS at claim as the durable
   * invariant (the v128 migration is the one-shot repair for rows already in
   * flight). Names outside the map stay NULL — exactly today's behavior.
   * Postgres evaluates SET expressions against the OLD row, so the timeout_at
   * CASE must repeat the COALESCE rather than reference the assigned column.
   * The map binds as a RAW object (never JSON.stringify into ::jsonb — the
   * postgres.js double-encode trap; PGLite hides it, real PG does not).
   */
  async claim(lockToken: string, lockDurationMs: number, queue: string, registeredNames: string[]): Promise<MinionJob | null> {
    if (registeredNames.length === 0) return null;

    // Direct (session-mode) pool: claim opens the lock that renewLock then
    // heartbeats. Both must live on a connection the transaction-mode pooler
    // won't recycle mid-hold, or the lock orphans and the worker wedges.
    //
    // #4145: lock_duration_ms resolves row → handler map ($6, RAW object —
    // same double-encode rule as $5) → worker default ($2), is STAMPED onto
    // the row (durable, like timeout_ms), and lock_until derives from the
    // same COALESCE (OLD-row semantics: repeat the expression, don't
    // reference the assigned column). Both the stamp and lock_until are
    // CASE-clamped to the [5s,1h] bound IN SQL (row/map resolution only —
    // the worker-default fallback $2 is operator-configured, not row data,
    // and tests/short-lived workers legitimately use sub-5s leases): the exposed
    // submit surfaces clamp already, but a bypass-written row (direct SQL
    // repair, foreign tooling) must not grant a ~24-day lease to a worker
    // that crashes before its first renewal (or a 1ms one that thrashes).
    const rows = await this.engine.executeRawDirect<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        status = 'active',
        lock_token = $1,
        lock_until = now() + ((CASE WHEN COALESCE(lock_duration_ms, ($6::jsonb ->> name)::int) IS NULL THEN $2
                                    ELSE LEAST(GREATEST(COALESCE(lock_duration_ms, ($6::jsonb ->> name)::int), 5000), 3600000) END)::double precision * interval '1 millisecond'),
        lock_duration_ms = CASE WHEN COALESCE(lock_duration_ms, ($6::jsonb ->> name)::int) IS NULL THEN NULL
                                ELSE LEAST(GREATEST(COALESCE(lock_duration_ms, ($6::jsonb ->> name)::int), 5000), 3600000) END,
        timeout_ms = COALESCE(timeout_ms, ($5::jsonb ->> name)::int),
        timeout_at = CASE WHEN COALESCE(timeout_ms, ($5::jsonb ->> name)::int) IS NOT NULL
                          THEN now() + (COALESCE(timeout_ms, ($5::jsonb ->> name)::int)::double precision * interval '1 millisecond')
                          ELSE NULL END,
        attempts_started = attempts_started + 1,
        started_at = COALESCE(started_at, now()),
        updated_at = now()
       WHERE id = (
         SELECT id FROM minion_jobs
         WHERE queue = $3 AND status = 'waiting' AND name = ANY($4)
         ORDER BY priority ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [lockToken, lockDurationMs, queue, registeredNames, HANDLER_DEFAULT_TIMEOUT_MS, HANDLER_DEFAULT_LOCK_DURATION_MS]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /**
   * Dead-letter active jobs whose timeout_at has passed.
   *
   * The lock_until > now() guard is critical: a stalled job (lock_until < now)
   * is being requeued by handleStalled, NOT timed out terminally. Stall →
   * retry, timeout → dead. Order in worker loop: handleStalled() before
   * handleTimeouts() to give stall recovery first crack.
   *
   * Honest scope: 1-tick TOCTOU window remains. A job whose lock_until
   * expires between handleStalled and handleTimeouts may miss this tick
   * but will be caught the next one (after re-claim). Never double-handled.
   */
  async handleTimeouts(): Promise<MinionJob[]> {
    return this.engine.transaction(async (tx) => {
      // #1737: count the timed-out run as a spent attempt (terminal, no retry).
      // Safe against double-count: the worker sweep runs handleStalled ->
      // handleTimeouts -> handleWallClockTimeouts sequentially and awaited, and
      // each guards on `status = 'active'`, so the first to set status='dead'
      // excludes the row from the later sweeps.
      //
      // W0 (D5.12): candidates are discovered with a plain read, PARENTS are
      // locked first in sorted order (matching failJob's parent-before-child
      // order), and the child UPDATE re-checks every predicate under a
      // SKIP LOCKED subselect — see killJobs() for the shared tail.
      const candidates = await tx.executeRaw<{ id: number; parent_job_id: number | null }>(
        `SELECT id, parent_job_id FROM minion_jobs
          WHERE status = 'active'
            AND timeout_at IS NOT NULL
            AND timeout_at < now()
            AND lock_until > now()`
      );
      if (candidates.length === 0) return [];
      await this.lockParentsOrdered(tx, candidates);
      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = 'dead',
          error_text = 'timeout exceeded',
          attempts_made = attempts_made + 1,
          lock_token = NULL,
          lock_until = NULL,
          finished_at = now(),
          updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
              AND timeout_at IS NOT NULL
              AND timeout_at < now()
              AND lock_until > now()
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [candidates.map(c => c.id)]
      );
      await this.killJobs(tx, rows, 'timeout', 'timeout exceeded');
      return rows.map(rowToMinionJob);
    });
  }

  /**
   * W0 fix-wave (Tier-1 #4, D5.12): the ONE parent-notification tail shared
   * by every reaper that terminally kills active jobs. Pre-fix this ~45-line
   * block was hand-copied between handleTimeouts and handleWallClockTimeouts
   * (differing only in the error string), and handleStalled's dead-letter
   * branch had NO copy at all — a child that died via max-stall left its
   * aggregator parent in 'waiting-children' forever (the exact hang the v0.15
   * comment says was fixed for timeouts).
   *
   * Runs inside the caller's transaction, AFTER the child transitions.
   * Callers must have locked the parents first via lockParentsOrdered() —
   * parents-before-children is the queue-wide lock order (failJob locks the
   * parent before touching the child), so the reapers can never deadlock
   * against a concurrent failJob/completeJob.
   *
   * Emits child_done(outcome) to each non-terminal parent's inbox, then flips
   * any 'waiting-children' parent whose last open child we just killed back
   * to 'waiting'.
   */
  private async killJobs(
    tx: Pick<BrainEngine, 'executeRaw'>,
    rows: Array<Record<string, unknown>>,
    outcome: ChildOutcome,
    errorText: string,
  ): Promise<void> {
    const parentIds = new Set<number>();
    for (const r of rows) {
      const parentJobId = r.parent_job_id as number | null;
      if (parentJobId == null) continue;
      parentIds.add(parentJobId);
      const childDone: ChildDoneMessage = {
        type: 'child_done',
        child_id: r.id as number,
        job_name: r.name as string,
        result: null,
        outcome,
        error: errorText,
      };
      await tx.executeRaw(
        `INSERT INTO minion_inbox (job_id, sender, payload)
         SELECT $1, 'minions', $2::jsonb
         WHERE EXISTS (
           SELECT 1 FROM minion_jobs
           WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
         )`,
        [parentJobId, childDone]
      );
    }

    // Unblock any aggregator parents whose last open child we just killed.
    for (const parentId of [...parentIds].sort((a, b) => a - b)) {
      await tx.executeRaw(
        `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'waiting-children'
           AND NOT EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE parent_job_id = $1
               AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
           )`,
        [parentId]
      );
    }
  }

  /**
   * W0 (D5.12): take parent row locks in ASCENDING id order before any child
   * transition. Matches failJob's parent-first order so the three reapers and
   * failJob can never deadlock each other on parent/child lock acquisition.
   */
  private async lockParentsOrdered(
    tx: Pick<BrainEngine, 'executeRaw'>,
    candidates: Array<{ parent_job_id: number | null }>,
  ): Promise<void> {
    const parentIds = [...new Set(
      candidates.map(c => c.parent_job_id).filter((p): p is number => p != null),
    )].sort((a, b) => a - b);
    if (parentIds.length === 0) return;
    await tx.executeRaw(
      `SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [parentIds]
    );
  }

  /**
   * Dead-letter active jobs that exceed a wall-clock runtime threshold,
   * regardless of lock state. This catches jobs stuck while still holding
   * DB resources (e.g. blocked on file locks) where stall sweeps skip rows.
   *
   * Threshold (ms):
   *   timeout_ms set   -> timeout_ms * 2
   *   timeout_ms null  -> 2 * lockDurationMs * max_stalled
   */
  async handleWallClockTimeouts(lockDurationMs: number): Promise<MinionJob[]> {
    return this.engine.transaction(async (tx) => {
      // W0 (D5.12): same parents-first discover/lock/kill shape as
      // handleTimeouts; shared tail in killJobs().
      const candidates = await tx.executeRaw<{ id: number; parent_job_id: number | null }>(
        `SELECT id, parent_job_id FROM minion_jobs
          WHERE status = 'active'
            AND started_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 >
              CASE
                WHEN timeout_ms IS NOT NULL THEN timeout_ms * 2
                ELSE COALESCE(lock_duration_ms, $1)::double precision * 2 * GREATEST(max_stalled, 1)
              END`,
        [lockDurationMs]
      );
      if (candidates.length === 0) return [];
      await this.lockParentsOrdered(tx, candidates);
      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = 'dead',
          error_text = 'wall-clock timeout exceeded',
          attempts_made = attempts_made + 1,
          lock_token = NULL,
          lock_until = NULL,
          finished_at = now(),
          updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($2::bigint[])
              AND status = 'active'
              AND started_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 >
                CASE
                  WHEN timeout_ms IS NOT NULL THEN timeout_ms * 2
                  ELSE COALESCE(lock_duration_ms, $1)::double precision * 2 * GREATEST(max_stalled, 1)
                END
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [lockDurationMs, candidates.map(c => c.id)]
      );
      await this.killJobs(tx, rows, 'timeout', 'wall-clock timeout exceeded');
      return rows.map(rowToMinionJob);
    });
  }

  /**
   * Complete a job (token-fenced). All side effects atomic in one transaction:
   *   1. UPDATE child to 'completed' with result
   *   2. Roll up token counts to parent (skipped if parent is terminal)
   *   3. Insert child_done message into parent's inbox (skipped if parent terminal)
   *   4. Resolve parent (flip waiting-children → waiting if all kids done)
   *   5. If remove_on_complete, DELETE the child row (cascades inbox + attachments)
   *
   * Returns the completed job (the in-memory snapshot before any delete), or
   * null if the lock_token mismatched (e.g., reclaimed mid-completion).
   *
   * The fold-in of resolveParent eliminates the crash window where a process
   * died between completeJob and worker's prior post-call resolveParent,
   * stranding the parent in waiting-children forever.
   */
  async completeJob(id: number, lockToken: string, result?: Record<string, unknown>): Promise<MinionJob | null> {
    return this.engine.transaction(async (tx) => {
      // Peek at parent_job_id before the UPDATE so we can lock the parent row
      // FIRST. Without this SELECT FOR UPDATE, two siblings completing
      // concurrently each see the other as still active (pre-commit snapshot
      // under read-committed), neither flips the parent, and the parent is
      // stuck in waiting-children forever.
      const peek = await tx.executeRaw<{ parent_job_id: number | null }>(
        `SELECT parent_job_id FROM minion_jobs WHERE id = $1`,
        [id]
      );
      const parentId = peek[0]?.parent_job_id ?? null;
      if (parentId) {
        await tx.executeRaw(
          `SELECT id FROM minion_jobs WHERE id = $1 FOR UPDATE`,
          [parentId]
        );
      }

      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET status = 'completed', result = $1::jsonb,
          finished_at = now(), lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id = $2 AND status = 'active' AND lock_token = $3
         RETURNING *`,
        [result ?? null, id, lockToken]
      );
      if (rows.length === 0) return null;

      const completed = rowToMinionJob(rows[0]);

      if (completed.parent_job_id) {
        // Roll up token counts. Guarded against parent already being terminal.
        if (completed.tokens_input > 0 || completed.tokens_output > 0 || completed.tokens_cache_read > 0) {
          await tx.executeRaw(
            `UPDATE minion_jobs SET
              tokens_input = tokens_input + $1,
              tokens_output = tokens_output + $2,
              tokens_cache_read = tokens_cache_read + $3,
              updated_at = now()
             WHERE id = $4 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')`,
            [completed.tokens_input, completed.tokens_output, completed.tokens_cache_read, completed.parent_job_id]
          );
        }

        // Auto-post child_done into parent's inbox. EXISTS guard skips if parent
        // was deleted or hit a terminal state mid-flight (no FK violation, no
        // contradiction with the token rollup guard).
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: completed.id,
          job_name: completed.name,
          result: result ?? null,
          outcome: 'complete',
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [completed.parent_job_id, childDone]
        );

        // Fold-in resolveParent: flip parent to waiting once all children are
        // in ANY terminal state. Terminal set includes 'failed' so a failed
        // child with on_child_fail='continue'/'ignore' doesn't strand the
        // parent in waiting-children forever (v0.15 aggregator fix).
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`,
          [completed.parent_job_id]
        );
      }

      // remove_on_complete cleanup AFTER all parent-side bookkeeping.
      // The child_done we just inserted lives in the *parent's* inbox row,
      // so it survives the child cascade-delete.
      if (completed.remove_on_complete) {
        await tx.executeRaw(
          `DELETE FROM minion_jobs WHERE id = $1`,
          [completed.id]
        );
      }

      return completed;
    });
  }

  /**
   * Fail a job (token-fenced). All side effects atomic in one transaction:
   *   1. UPDATE child to 'delayed' (retry) | 'failed' | 'dead'
   *   2. If terminal AND parent_job_id, run on_child_fail policy:
   *      - 'fail_parent' → mark parent 'failed' (via failParent SQL)
   *      - 'remove_dep'  → null out parent_job_id (via removeChildDependency SQL)
   *      - 'ignore' / 'continue' → no parent action
   *   3. If remove_on_fail AND terminal, DELETE the child row (parent hook
   *      already ran in this txn using in-memory state, so child deletion is safe)
   *
   * Folding the parent hook into this transaction eliminates the crash window
   * where a process died between failJob and worker's prior post-call hook,
   * leaving the parent stuck in waiting-children.
   */
  async failJob(
    id: number,
    lockToken: string,
    errorText: string,
    newStatus: 'delayed' | 'failed' | 'dead',
    backoffMs?: number
  ): Promise<MinionJob | null> {
    return this.engine.transaction(async (tx) => {
      // Lock the parent row first so concurrent sibling completions/failures
      // serialize on the parent — same race fix as completeJob.
      const peek = await tx.executeRaw<{ parent_job_id: number | null }>(
        `SELECT parent_job_id FROM minion_jobs WHERE id = $1`,
        [id]
      );
      const parentId = peek[0]?.parent_job_id ?? null;
      if (parentId) {
        await tx.executeRaw(
          `SELECT id FROM minion_jobs WHERE id = $1 FOR UPDATE`,
          [parentId]
        );
      }

      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = $1, error_text = $2, attempts_made = attempts_made + 1,
          stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($3::text),
          delay_until = CASE WHEN $1 = 'delayed' THEN now() + ($4::double precision * interval '1 millisecond') ELSE NULL END,
          finished_at = CASE WHEN $1 IN ('failed', 'dead') THEN now() ELSE NULL END,
          started_at = CASE WHEN $1 = 'delayed' THEN NULL ELSE started_at END,
          lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id = $5 AND status = 'active' AND lock_token = $6
         RETURNING *`,
        [newStatus, errorText, errorText, backoffMs ?? 0, id, lockToken]
      );
      if (rows.length === 0) return null;

      const failed = rowToMinionJob(rows[0]);
      const terminal = newStatus === 'failed' || newStatus === 'dead';

      // Parent hook on terminal failure.
      if (terminal && failed.parent_job_id) {
        // v0.15: emit child_done(outcome='failed') BEFORE any parent-terminal
        // update. Insertion order matters because `completeJob`'s inbox-write
        // EXISTS guard skips writes once the parent is 'failed' — if we let
        // the fail_parent UPDATE run first, this inbox row would be dropped
        // for aggregator-style parents that still want to count it (codex).
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: failed.id,
          job_name: failed.name,
          result: null,
          outcome: newStatus === 'dead' ? 'dead' : 'failed',
          error: errorText,
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [failed.parent_job_id, childDone]
        );

        if (failed.on_child_fail === 'fail_parent') {
          await tx.executeRaw(
            `UPDATE minion_jobs SET status = 'failed',
              error_text = $1, finished_at = now(), updated_at = now()
             WHERE id = $2 AND status = 'waiting-children'`,
            [`child job ${failed.id} failed: ${errorText}`, failed.parent_job_id]
          );
        } else if (failed.on_child_fail === 'remove_dep') {
          await tx.executeRaw(
            `UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`,
            [failed.id]
          );
          // After dropping the dep, try to resolve the parent if all OTHER
          // kids are terminal. Terminal set includes 'failed' (v0.15).
          await tx.executeRaw(
            `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
             WHERE id = $1 AND status = 'waiting-children'
               AND NOT EXISTS (
                 SELECT 1 FROM minion_jobs
                 WHERE parent_job_id = $1
                   AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
               )`,
            [failed.parent_job_id]
          );
        } else {
          // 'ignore' / 'continue': parent stays in waiting-children waiting on
          // siblings. With v0.15 terminal-set expansion + child_done emission
          // above, an aggregator sibling-count model now works: all N children
          // reach terminal → completeJob on a sibling (or the LAST terminal
          // transition here) flips parent → waiting once no non-terminal kids
          // remain. Run the resolve check here so the last child transitioning
          // via THIS code path still unblocks the parent.
          await tx.executeRaw(
            `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
             WHERE id = $1 AND status = 'waiting-children'
               AND NOT EXISTS (
                 SELECT 1 FROM minion_jobs
                 WHERE parent_job_id = $1
                   AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
               )`,
            [failed.parent_job_id]
          );
        }
      }

      // remove_on_fail cleanup AFTER parent hook.
      if (terminal && failed.remove_on_fail) {
        await tx.executeRaw(
          `DELETE FROM minion_jobs WHERE id = $1`,
          [failed.id]
        );
      }

      return failed;
    });
  }

  /**
   * v0.41 Bug 2 — release a job back to `delayed` after a
   * `RateLeaseUnavailableError` bounce, WITHOUT incrementing `attempts_made`.
   *
   * The field-report bug: pre-v0.41, lease-full bounces routed through
   * `failJob` which bumps `attempts_made`. After 3 bounces the job hit
   * `max_attempts` (default 3) and dead-lettered with message
   * `rate lease "anthropic:messages" full (8/8)`. Operators saw a dead
   * job and assumed a real failure.
   *
   * This method is the workhorse fix: status → `delayed`, jittered backoff
   * via `delay_until`, `attempts_made` UNCHANGED. The handler comment at
   * `src/core/minions/handlers/subagent.ts:425` ("treat as renewable
   * error so the worker re-claims") is now actually true.
   *
   * Audit row write to `minion_lease_pressure_log` is the caller's
   * responsibility (the worker has the model/queue context); this method
   * stays focused on the state-machine flip. Same `lock_token + status='active'`
   * idempotency guard as `failJob` so a racing stall sweep / cancel still
   * wins. Returns `null` on lock_token mismatch.
   *
   * Returns the updated `MinionJob` row on success so the caller can stamp
   * the audit row with provenance from the SAME row that just flipped.
   */
  async releaseLeaseFullJob(
    id: number,
    lockToken: string,
    errorText: string,
    backoffMs: number,
  ): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        status = 'delayed',
        error_text = $1,
        stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
        delay_until = now() + ($2::double precision * interval '1 millisecond'),
        started_at = NULL,
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $3 AND status = 'active' AND lock_token = $4
       RETURNING *`,
      [errorText, backoffMs, id, lockToken],
    );
    if (rows.length === 0) return null;
    return rowToMinionJob(rows[0]);
  }

  /** Update job progress (token-fenced). */
  async updateProgress(id: number, lockToken: string, progress: unknown): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET progress = $1::jsonb, updated_at = now()
       WHERE id = $2 AND status = 'active' AND lock_token = $3
       RETURNING id`,
      [progress, id, lockToken]
    );
    return rows.length > 0;
  }

  /**
   * Renew lock (token-fenced). Returns false if token mismatch (job was reclaimed).
   *
   * `opts.signal` cancels the in-flight UPDATE (postgres.js `.cancel()`) when the
   * caller's timeout race gives up on it — otherwise the abandoned query holds a
   * checked-out pool slot for its full server-side duration (issue #6).
   * Cancellation is BEST-EFFORT (#4145 CDX-2/R2-2): pool acquisition and PG
   * protocol cancel are asynchronous, and PGLite ignores the signal — so
   * correctness never rests on it. A late-landing renewal UPDATE is fenced on
   * OUR token, meaning it can only extend a lock nobody else has claimed;
   * worst case is a stall-requeue delayed by ≤ one lease.
   */
  async renewLock(
    id: number,
    lockToken: string,
    lockDurationMs: number,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean> {
    // Direct (session-mode) pool — see claim(). The heartbeat that keeps a job
    // alive for minutes cannot run on the transaction pooler without periodic
    // CONNECTION_ENDED drops that look like lock-expiry and orphan the job.
    const rows = await this.engine.executeRawDirect<Record<string, unknown>>(
      `UPDATE minion_jobs SET lock_until = now() + ($1::double precision * interval '1 millisecond'), updated_at = now()
       WHERE id = $2 AND lock_token = $3 AND status = 'active'
       RETURNING id`,
      [lockDurationMs, id, lockToken],
      opts
    );
    return rows.length > 0;
  }

  /**
   * issue #1678 — self-healing retry for the Minion hot-path lock SQL.
   * ONLY promoteDelayed routes through this: it's idempotent (re-running the
   * same UPDATE on already-promoted rows is a no-op), so a retry after a
   * reaped pooler socket can't cause double-work. `claim` and `renewLock`
   * deliberately do NOT use this — see their call sites for why (Codex #1/#2):
   * blind-retrying claim can double-claim a job, and retrying renewLock races
   * the renewal-tick's own timeout. The reconnect callback rebuilds the
   * instance pool between attempts when the engine supports it (Postgres);
   * PGLite has no pooler reaping so reconnect is absent and the retry is a
   * cheap pass-through.
   */
  private async lockRetry<T>(fn: () => Promise<T>): Promise<T> {
    const reconnect = (this.engine as { reconnect?: () => Promise<void> }).reconnect;
    const opts = resolveBulkRetryOpts();
    let prevDelay = 0;
    try {
      return await withRetry(fn, {
        maxRetries: opts.maxRetries,
        delayMs: opts.delayMs,
        delayMaxMs: opts.delayMaxMs,
        jitter: BULK_RETRY_OPTS.jitter,
        auditSite: 'minion-lock',
        onRetry: (attempt, err) => {
          const delay = computeNextDelay(attempt - 1, prevDelay, opts.delayMs, opts.delayMaxMs, BULK_RETRY_OPTS.jitter);
          prevDelay = delay;
          auditLogBatchRetry('minion-lock', 1, attempt, delay, err);
        },
        reconnect: reconnect ? () => reconnect.call(this.engine) : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'RetryAbortError') throw err;
      if (isRetryableConnError(err)) auditLogBatchExhausted('minion-lock', 1, opts.maxRetries + 1, err);
      throw err;
    }
  }

  /** Promote delayed jobs whose delay_until has passed. Returns promoted jobs. */
  async promoteDelayed(): Promise<MinionJob[]> {
    const rows = await this.lockRetry(() => this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', delay_until = NULL,
        started_at = NULL,
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE status = 'delayed' AND delay_until <= now()
       RETURNING *`
    ));
    return rows.map(rowToMinionJob);
  }

  /** Detect and handle stalled jobs. Single CTE, no off-by-one. Returns affected jobs. */
  async handleStalled(graceMsOverride?: number): Promise<{ requeued: MinionJob[]; dead: MinionJob[] }> {
    // W0 fix-wave (Tier-1 #4): the dead-letter branch previously emitted NO
    // child_done and never unblocked aggregator parents — a child that died
    // via max-stall stranded its parent in 'waiting-children' forever (the
    // exact hang the v0.15 comment says was fixed for timeouts; there was no
    // compensating sweep anywhere). Restructured into the parents-first
    // discover/lock/kill shape (D5.12) with the shared killJobs() tail.
    //
    // #4145 (CDX-7): the reclaim predicate carries a grace — see
    // resolveStallReclaimGraceMs. Callers (tests) may pass an explicit
    // override; the worker sweep resolves from env/default.
    const graceMs = graceMsOverride ?? resolveStallReclaimGraceMs();
    return this.engine.transaction(async (tx) => {
      const candidates = await tx.executeRaw<{ id: number; parent_job_id: number | null; stalled_counter: number; max_stalled: number }>(
        `SELECT id, parent_job_id, stalled_counter, max_stalled
           FROM minion_jobs
          WHERE status = 'active'
            AND lock_until < now() - ($1::double precision * interval '1 millisecond')`,
        [graceMs]
      );
      if (candidates.length === 0) return { requeued: [], dead: [] };
      const ids = candidates.map(c => c.id);
      // Only the dead-letter branch touches parents; lock just those, sorted.
      await this.lockParentsOrdered(
        tx,
        candidates.filter(c => Number(c.stalled_counter) + 1 >= Number(c.max_stalled)),
      );

      const requeuedRows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = 'waiting', stalled_counter = stalled_counter + 1,
          started_at = NULL,
          lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
              AND lock_until < now() - ($2::double precision * interval '1 millisecond')
              AND stalled_counter + 1 < max_stalled
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [ids, graceMs]
      );
      const deadRows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = 'dead', stalled_counter = stalled_counter + 1,
          attempts_made = attempts_made + 1,
          error_text = 'max stalled count exceeded',
          lock_token = NULL, lock_until = NULL, finished_at = now(), updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
              AND lock_until < now() - ($2::double precision * interval '1 millisecond')
              AND stalled_counter + 1 >= max_stalled
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [ids, graceMs]
      );
      // THE FIX: stall-death now notifies + unblocks parents like every
      // other terminal kill. Outcome 'dead' (not 'timeout') so consumers can
      // distinguish "died via max-stall" from "timed out during run".
      await this.killJobs(tx, deadRows, 'dead', 'max stalled count exceeded');
      return { requeued: requeuedRows.map(rowToMinionJob), dead: deadRows.map(rowToMinionJob) };
    }).then(async (result) => {
      // W0 ship-review (data-migration): the per-kill unblock above is
      // forward-only — parents stranded in 'waiting-children' by PRE-upgrade
      // stall-deaths (children already status='dead') are never revisited by
      // any per-event unblock site. This idempotent sweep self-heals ALL
      // stranding classes, retroactive included, once per stall tick: any
      // waiting-children parent with zero non-terminal children flips back to
      // 'waiting'. Cheap (single UPDATE, NOT EXISTS on an indexed FK) at the
      // 30s sweep cadence.
      try {
        await this.engine.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
            WHERE status = 'waiting-children'
              AND NOT EXISTS (
                SELECT 1 FROM minion_jobs c
                WHERE c.parent_job_id = minion_jobs.id
                  AND c.status NOT IN ('completed', 'failed', 'dead', 'cancelled')
              )`
        );
      } catch { /* best-effort backstop; the per-kill unblock is the primary path */ }
      return result;
    });
  }

  /**
   * Check if all children of a parent are in ANY terminal state. If so,
   * unblock parent (flip waiting-children → waiting).
   *
   * v0.15: terminal set includes 'failed' so a child failing with
   * on_child_fail='continue'/'ignore' doesn't strand the parent.
   */
  async resolveParent(parentId: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'waiting-children'
         AND NOT EXISTS (
           SELECT 1 FROM minion_jobs
           WHERE parent_job_id = $1
             AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
         )
       RETURNING *`,
      [parentId]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Fail the parent when a child fails with fail_parent policy. */
  async failParent(parentId: number, childId: number, errorText: string): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'failed',
        error_text = $1, finished_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'waiting-children'
       RETURNING *`,
      [`child job ${childId} failed: ${errorText}`, parentId]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Pause a waiting or active job. For active jobs, clears the lock so the worker's
   *  AbortController fires and the handler stops gracefully. */
  async pauseJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'paused',
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('waiting', 'active', 'delayed')
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Resume a paused job back to waiting. */
  async resumeJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting',
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'paused'
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Send a message to a job's inbox. Sender must be the parent job or 'admin'. */
  async sendMessage(jobId: number, payload: unknown, sender: string): Promise<InboxMessage | null> {
    // Validate job exists and is in a messageable state
    const job = await this.getJob(jobId);
    if (!job) return null;
    if (['completed', 'dead', 'cancelled', 'failed'].includes(job.status)) return null;

    // Sender validation: must be parent job ID or 'admin'
    if (sender !== 'admin' && sender !== String(job.parent_job_id)) {
      return null;
    }

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `INSERT INTO minion_inbox (job_id, sender, payload)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [jobId, sender, payload]
    );
    return rows.length > 0 ? rowToInboxMessage(rows[0]) : null;
  }

  /** Read unread inbox messages for a job. Token-fenced. Marks messages as read. */
  async readInbox(jobId: number, lockToken: string): Promise<InboxMessage[]> {
    // Verify lock ownership
    const lockCheck = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`,
      [jobId, lockToken]
    );
    if (lockCheck.length === 0) return [];

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_inbox SET read_at = now()
       WHERE job_id = $1 AND read_at IS NULL
       RETURNING *`,
      [jobId]
    );
    return rows.map(rowToInboxMessage);
  }

  /** Update token counts for a job. Accumulates (adds to existing). Token-fenced. */
  async updateTokens(id: number, lockToken: string, tokens: TokenUpdate): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        tokens_input = tokens_input + $1,
        tokens_output = tokens_output + $2,
        tokens_cache_read = tokens_cache_read + $3,
        updated_at = now()
       WHERE id = $4 AND status = 'active' AND lock_token = $5
       RETURNING id`,
      [tokens.input ?? 0, tokens.output ?? 0, tokens.cache_read ?? 0, id, lockToken]
    );
    return rows.length > 0;
  }

  /** Replay a completed/failed/dead job with optional data overrides. Creates a new job. */
  async replayJob(id: number, dataOverrides?: Record<string, unknown>): Promise<MinionJob | null> {
    const source = await this.getJob(id);
    if (!source) return null;
    if (!['completed', 'failed', 'dead'].includes(source.status)) return null;

    const data = dataOverrides
      ? { ...source.data, ...dataOverrides }
      : source.data;

    return this.add(source.name, data, {
      queue: source.queue,
      priority: source.priority,
      max_attempts: source.max_attempts,
      backoff_type: source.backoff_type,
      backoff_delay: source.backoff_delay,
      backoff_jitter: source.backoff_jitter,
    });
  }

  /** Remove a child's dependency on its parent. */
  async removeChildDependency(childId: number): Promise<void> {
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`,
      [childId]
    );
  }

  /**
   * Read child_done messages from a parent's inbox. Token-fenced (the parent
   * job must currently hold lockToken — same fence as readInbox to prevent a
   * stale process polling completions for jobs it no longer owns).
   *
   * Does NOT mark messages read (parent may want to poll repeatedly with a
   * cursor). Use `since` to fetch only newer entries.
   */
  async readChildCompletions(
    parentId: number,
    lockToken: string,
    opts?: { since?: Date }
  ): Promise<ChildDoneMessage[]> {
    // Verify the caller holds the parent's lock.
    const lockCheck = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`,
      [parentId, lockToken]
    );
    if (lockCheck.length === 0) return [];

    const params: unknown[] = [parentId];
    let sinceClause = '';
    if (opts?.since) {
      sinceClause = ` AND sent_at > $2::timestamptz`;
      params.push(opts.since.toISOString());
    }

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT payload FROM minion_inbox
       WHERE job_id = $1 AND (payload->>'type') = 'child_done'${sinceClause}
       ORDER BY sent_at ASC`,
      params
    );

    return rows.map(r => {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return p as ChildDoneMessage;
    });
  }

  /**
   * Attach a file to a job. Validates size, base64, filename safety, and
   * duplicate filename. Returns the persisted attachment metadata (not the
   * bytes — use getAttachment to fetch).
   *
   * The DB UNIQUE (job_id, filename) constraint is the authoritative duplicate
   * fence; the in-memory check just gives a faster error.
   */
  async addAttachment(jobId: number, input: AttachmentInput): Promise<Attachment> {
    await this.ensureSchema();

    // Verify job exists (FK guarantees this on insert too, but explicit error is clearer)
    const exists = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1`,
      [jobId]
    );
    if (exists.length === 0) {
      throw new Error(`job ${jobId} not found`);
    }

    const existingRows = await this.engine.executeRaw<{ filename: string }>(
      `SELECT filename FROM minion_attachments WHERE job_id = $1`,
      [jobId]
    );
    const existingFilenames = new Set(existingRows.map(r => r.filename));

    const result = validateAttachment(input, {
      maxBytes: this.maxAttachmentBytes,
      existingFilenames,
    });
    if (!result.ok) {
      throw new Error(`attachment validation failed: ${result.error}`);
    }
    const { filename, content_type, bytes, size_bytes, sha256 } = result.normalized;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `INSERT INTO minion_attachments (job_id, filename, content_type, content, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at`,
      [jobId, filename, content_type, bytes, size_bytes, sha256]
    );
    return rowToAttachment(rows[0]);
  }

  /** List attachments for a job (metadata only, no bytes). */
  async listAttachments(jobId: number): Promise<Attachment[]> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at
       FROM minion_attachments
       WHERE job_id = $1
       ORDER BY created_at ASC, id ASC`,
      [jobId]
    );
    return rows.map(rowToAttachment);
  }

  /**
   * Fetch a single attachment with bytes. Returns null if not found.
   * The bytes are returned as a Buffer (Uint8Array under the hood).
   */
  async getAttachment(jobId: number, filename: string): Promise<{ meta: Attachment; bytes: Buffer } | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at, content
       FROM minion_attachments
       WHERE job_id = $1 AND filename = $2`,
      [jobId, filename]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const meta = rowToAttachment(row);
    const raw = row.content;
    let bytes: Buffer;
    if (raw == null) {
      bytes = Buffer.alloc(0);
    } else if (Buffer.isBuffer(raw)) {
      bytes = raw;
    } else if (raw instanceof Uint8Array) {
      bytes = Buffer.from(raw);
    } else {
      bytes = Buffer.from(raw as ArrayBuffer);
    }
    return { meta, bytes };
  }

  /** Delete an attachment by job + filename. Returns true if a row was removed. */
  async deleteAttachment(jobId: number, filename: string): Promise<boolean> {
    const rows = await this.engine.executeRaw<{ id: number }>(
      `DELETE FROM minion_attachments WHERE job_id = $1 AND filename = $2 RETURNING id`,
      [jobId, filename]
    );
    return rows.length > 0;
  }
}

/**
 * issue #1801 / CLI→MCP gap-closure wave (CEO-F7) — derive the wedged-queue
 * boolean from getStats().wedge, shared by `gbrain jobs stats` and the
 * get_job_stats op so the two surfaces can never disagree. A queue is wedged
 * when a worker is alive but claiming nothing while work waits:
 * zero live-lock active rows, waiting > 0, and the last completion is older
 * than the threshold (or absent). Threshold matches the doctor wedged_queue
 * check: GBRAIN_WEDGED_QUEUE_WARN_MINUTES (server-side env), default 15.
 */
export function deriveWedgeSignal(wedge: {
  queue?: string;
  active_healthy: number;
  waiting: number;
  minutes_since_completion: number | null;
}): { wedged: boolean; wedge_threshold_minutes: number; private_queue: boolean } {
  const raw = parseInt(process.env.GBRAIN_WEDGED_QUEUE_WARN_MINUTES ?? '', 10);
  const wedge_threshold_minutes = Number.isFinite(raw) && raw > 0 ? raw : 15;
  // A dream-inline private queue is parent-owned: no shared worker will ever
  // claim it, so "wedged — restart the worker" is impossible advice (the
  // incident bug class). Surface it as private_queue instead so every consumer
  // (jobs stats, get_job_stats op, doctor) points at reconciliation.
  const private_queue = wedge.queue !== undefined && isDreamInlinePrivateQueue(wedge.queue);
  const mins = wedge.minutes_since_completion;
  const wedged = !private_queue && wedge.active_healthy === 0 && wedge.waiting > 0
    && (mins === null || mins > wedge_threshold_minutes);
  return { wedged, wedge_threshold_minutes, private_queue };
}
