/**
 * MinionQueue — Postgres-native job queue inspired by BullMQ.
 *
 * Usage:
 *   const queue = new MinionQueue(engine);
 *   const job = await queue.add('sync', { full: true });
 *   const status = await queue.getJob(job.id);
 *   await queue.prune({ olderThan: new Date(Date.now() - 30 * 86400000) });
 */

import { APPLICATION_AUTHORITY, assertNoUnreviewedJobs, authorizeJobExecution, currentSubmissionAuthority, parseSubmissionAuthority, type SubmissionAuthority } from './submission-authority.ts';
import type { BrainEngine } from '../engine.ts';
import { rowToMinionJob, rowToInboxMessage, rowToAttachment, NO_JOB_ACTOR, type JobActor,
  type MinionJob, type MinionJobInput, type MinionJobStatus, type InboxMessage, type TokenUpdate,
  type MinionQueueOpts, type ChildDoneMessage, type Attachment, type AttachmentInput,
} from './types.ts';
export { WATCHDOG_SUSPECT_MARK } from './watchdog-attribution.ts';
import { decideCoalesce } from './idempotency-coalesce.ts';
import type { CoalesceAuditEvent } from '../engine-sql/jobs.ts';
import { DREAM_INLINE_PRIVATE_QUEUE_PREFIX } from '../engine-sql/jobs-queue.ts';
export { DREAM_INLINE_PRIVATE_QUEUE_PREFIX };
import { withSubmitterLabel } from './job-insight.ts';
import { adoptSpendAuthorization, legacyDefaultClaimParams, type SpendAuthorization } from './spend-authorization.ts';
import { validateAttachment } from './attachments.ts';
import type { QueueFamilyStats } from './queue-families.ts';
import { isProtectedJobName } from './protected-names.ts';
import { jsonbSafeJson } from '../text-safe.ts';
import { assertEmbedBackfillQueueAdmission } from './embed-backfill-admission.ts';
import { lockDelegatedSubmission, checkDelegatedCapacity, prepareDelegatedReplay, admitDelegatedRetry } from './delegated-admission.ts';
import type { FenceOpts } from '../engine-sql/lease-token.ts';
import { ClaimFences } from './claim-fences.ts';
import {
  computeParamHash,
  resolveAdmissionPolicy,
  resolveTtlNames,
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
import { retryOnStalePlan } from '../retry-matcher.ts';
/** Trusted 4th argument, kept outside user-spread job options. */
export interface TrustedSubmitOpts {
  submissionAuthority?: SubmissionAuthority;
  /** Allow PROTECTED_JOB_NAMES; CLI or operation-local callers only. */
  allowProtectedSubmit?: boolean;
  /** Allow PGLite embed-backfill only for an explicit inline-worker caller. */
  allowPgliteInlineWorker?: boolean;
  /** Authenticated submit_agent identity, never read from agent job parameters. */
  delegatedClientId?: string;
  /** Consent-gated CLI producers only: the user's spend authorization (spend-authorization.ts). */
  spendAuthorization?: SpendAuthorization;
}

const MIGRATION_VERSION = 7;

const DEFAULT_MAX_SPAWN_DEPTH = 5;
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

export class MinionQueue {
  readonly maxSpawnDepth: number;
  readonly maxAttachmentBytes: number;

  private readonly fences: ClaimFences;

  constructor(private engine: BrainEngine, opts: MinionQueueOpts = {}) {
    this.maxSpawnDepth = opts.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
    this.maxAttachmentBytes = opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.fences = new ClaimFences(engine, opts.fence);
  }

  /** The fence a write on job `id` under `lockToken` carries: the one its claim was taken under (claim-fences.ts). */
  fenceOptsFor(id: number, lockToken: string): FenceOpts { return this.fences.optsFor(id, lockToken); }

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
    if (currentSubmissionAuthority() && currentSubmissionAuthority()!.kind !== 'application') throw new Error('Remote jobs cannot submit descendant jobs');
    // #7240: Postgres refuses a lone UTF-16 surrogate or U+0000 anywhere in a JSONB value, which failed the whole insert.
    if (data !== undefined) data = jsonbSafeJson(data);
    const authority = parseSubmissionAuthority(trusted?.submissionAuthority ?? APPLICATION_AUTHORITY);
    if (!authority) throw new Error('Unsupported submission authority');
    const delegatedClientId = authority.kind === 'remote_agent' ? authority.principal.id : trusted?.delegatedClientId;
    if (authority.kind === 'remote_agent' && trusted?.delegatedClientId !== undefined && trusted.delegatedClientId !== delegatedClientId) {
      throw new Error('Delegated submission identity differs from its authority');
    }
    const jobName = (name || '').trim();
    if (authority.kind !== 'application') await authorizeJobExecution(this.engine, { name: jobName, data: data ?? {}, submission_authority: authority });
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
      authority.kind === 'application' &&
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

    // The admission writes (idempotency, parameter coalesce, delegated capacity, quota, backpressure caps, parent
    // checks, insert, parent flip) run in one engine transaction (engine-sql/jobs.ts admitJob). The policy hooks keep
    // the delegated-client lock and the authority rule here; the audit is flushed AFTER commit so audit filesystem I/O
    // never runs while holding the advisory lock.
    //
    // max_stalled is INSERT-only (codex iter 3): an idempotency-key hit returns the EXISTING row and never mutates the
    // first submitter's durability semantics. Provided values clamp to [1, 100]; omitted values keep the schema DEFAULT.
    const hasMaxStalled = opts?.max_stalled !== undefined && opts.max_stalled !== null;
    const d = data as Record<string, unknown> | undefined;
    const queueName = opts?.queue ?? 'default';
    const admitted = await this.engine.admitJob({
      insert: {
        name: jobName,
        queue: queueName,
        status: childStatus,
        priority: opts?.priority ?? 0,
        data: withSubmitterLabel(data, authority.kind === 'application'),
        max_attempts: opts?.max_attempts ?? 3,
        backoff_type: opts?.backoff_type ?? 'exponential',
        backoff_delay: opts?.backoff_delay ?? 1000,
        backoff_jitter: opts?.backoff_jitter ?? 0.2,
        delay_until: delayUntil?.toISOString() ?? null,
        parent_job_id: opts?.parent_job_id ?? null,
        on_child_fail: opts?.on_child_fail ?? 'fail_parent',
        max_children: opts?.max_children ?? null,
        // #1737: long handlers get a sane long wall-clock default stamped at submit when the caller didn't pass one.
        timeout_ms: opts?.timeout_ms ?? defaultTimeoutMsFor(jobName),
        // #4145: explicit input is clamped to [5s,1h]; absent → handler map default; NULL row = worker-global lease at claim.
        lock_duration_ms: opts?.lock_duration_ms != null ? clampLockDurationMs(opts.lock_duration_ms) : defaultLockDurationMsFor(jobName),
        remove_on_complete: opts?.remove_on_complete ?? false,
        remove_on_fail: opts?.remove_on_fail ?? false,
        idempotency_key: opts?.idempotency_key ?? null,
        quiet_hours: opts?.quiet_hours ?? null,
        stagger_key: opts?.stagger_key ?? null,
        private_queue_owner_job_id: opts?.private_queue_owner_job_id ?? null,
        private_queue_owner_token: opts?.private_queue_owner_token ?? null,
        private_queue_lease_until: opts?.private_queue_lease_ms != null
          ? new Date(Date.now() + Math.max(1, Math.floor(opts.private_queue_lease_ms))).toISOString()
          : null,
        submission_authority: authority,
        spend_authorization: trusted?.spendAuthorization ? JSON.stringify(trusted.spendAuthorization) : null,
        max_stalled: hasMaxStalled ? Math.max(1, Math.min(100, Math.floor(opts!.max_stalled as number))) : null,
      },
      // Age-bounded to ttl/2: coalescing onto a nearly-TTL-expired row would silently kill the fresh intent (round-2 V7).
      paramCoalesce: coalesceActive && paramHash
        ? { paramHash, maxAgeHours: policy.ttlWaitingHours != null ? policy.ttlWaitingHours / 2 : null }
        : null,
      quotaMaxWaiting: policy.quotaMaxWaiting ?? null,
      // Multi-source scope: both payload spellings (camelCase sourceId, snake_case source_id) are read.
      backpressure: opts?.maxWaiting !== undefined || opts?.maxPending !== undefined
        ? {
          sourceId: typeof d?.sourceId === 'string' ? d.sourceId as string : typeof d?.source_id === 'string' ? d.source_id as string : null,
          ...(opts?.maxPending !== undefined ? { maxPending: opts.maxPending } : {}),
          ...(opts?.maxWaiting !== undefined ? { maxWaiting: opts.maxWaiting } : {}),
        }
        : null,
      maxSpawnDepth,
    }, {
      ...(delegatedClientId ? {
        // Client lock spans grant validation, capacity check and insertion.
        lock: (tx: BrainEngine) => lockDelegatedSubmission(tx, delegatedClientId, jobName, data),
        checkCapacity: (tx: BrainEngine, limit: number | null) => checkDelegatedCapacity(tx, delegatedClientId, limit),
      } : {}),
      decide: (tx, row) => decideCoalesce(tx, row, authority),
      parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
    });
    const result = rowToMinionJob(admitted.row);
    if (admitted.coalesced) result.coalesced = true;
    const coalesceAudit: CoalesceAuditEvent | null = admitted.audit;
    // Deferred audit flush — after commit, advisory lock released, connection
    // returned to the pool. A hung/slow audit volume degrades only this one
    // submission's latency, never the queue.
    if (coalesceAudit) {
      try {
        const { logBackpressureCoalesce } = await import('./backpressure-audit.ts');
        logBackpressureCoalesce(coalesceAudit);
      } catch { /* audit failures never block submission */ }
    }

    return trusted?.spendAuthorization && result.coalesced ? adoptSpendAuthorization(this.engine, result, trusted.spendAuthorization) : result;
  }

  /** Get a job by ID. Returns null if not found. */
  async getJob(id: number): Promise<MinionJob | null> {
    const row = await this.engine.getJob(id);
    return row ? rowToMinionJob(row) : null;
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
    return (await this.engine.listJobs(opts)).map(rowToMinionJob);
  }

  /** Remove a job. Only terminal statuses can be removed. */
  async removeJob(id: number): Promise<boolean> {
    return this.engine.deleteTerminalJob(id);
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
  async cancelJob(id: number, opts?: { ownerClientId?: string; ownerActor?: JobActor }): Promise<MinionJob | null> {
    const cancelled = await this.cancelJobs([id], { rootStatuses: NON_TERMINAL_STATUSES, ...(opts?.ownerClientId ? { ownerClientId: opts.ownerClientId, ownerActor: opts.ownerActor } : {}) });
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
    const ids = await this.engine.listOpenJobIdsInQueue(queueName);
    if (ids.length === 0) return [];
    return this.cancelJobs(ids, {
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
    return this.engine.renewPrivateQueueLease(queueName, ownerToken, Math.max(1, Math.floor(leaseMs)), this.fences.registrationOpts()); // host fence (I-5)
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
    await assertNoUnreviewedJobs(this.engine);
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
    const queues = await this.engine.listOwnedPrivateQueues(maxQueues);
    result.scanned_queues = queues.length;
    for (const queueName of queues) {
      const verdict = await this.classifyPrivateQueueForRecovery(queueName);
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
      const recheck = await this.classifyPrivateQueueForRecovery(queueName);
      if (recheck !== 'orphan') {
        result.skipped_non_orphan_queues++;
        continue;
      }
      const cancelled = await this.reconcilePrivateQueue(
        queueName,
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
    const r = await this.engine.readPrivateQueueState(queueName);
    if (r.active_healthy > 0 || r.live_owner_rows > 0) {
      return 'live';
    }
    if (r.metadata_rows === 0) return 'unowned';
    // Freshness guard BEFORE the owner-terminal fast path: any row touched in
    // the last 2 minutes (a 30s-cadence lease renewal, a claim, a child_done)
    // means SOMETHING is actively working this queue — even when the owner
    // job row reads terminal (stall-swept owner whose drain loop survived a
    // host suspend, the laptop-sleep shape). Never cancel under a live toucher;
    // a genuinely crashed queue goes untouched and classifies orphan on the
    // next pass ≤2 minutes later.
    if (r.recently_touched > 0) return 'live';
    const ownerTerminal = r.owner_ids.length > 0 && r.nonterminal_owner_rows === 0;
    if (ownerTerminal) return 'orphan';
    if (r.future_lease_rows > 0) return 'live';
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
  async cancelJobs(ids: number[], opts?: { reason?: string; rootStatuses?: MinionJobStatus[]; ownerClientId?: string; ownerActor?: JobActor }): Promise<MinionJob[]> {
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
    const rows = await this.engine.cancelJobs(ids, {
      reason: opts?.reason ?? null,
      rootStatuses: opts?.rootStatuses ?? null,
      ownerClientId: opts?.ownerClientId ?? null,
      ownerActor: opts?.ownerActor ?? NO_JOB_ACTOR,
    });
    return rows.map(rowToMinionJob);
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
    await assertNoUnreviewedJobs(this.engine);
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
      const stale = await this.engine.listStaleWaitingJobIds(name, hours, budget);
      if (stale.length === 0) continue;
      const reason =
        `${TTL_REASON_PREFIX}: waited > ${hours}h in queue ` +
        `(minions.ttl_waiting_hours.${name}; set 0 to disable)`;
      // rootStatuses:['waiting'] re-checks atomically inside the cancel — a
      // job CLAIMED between the SELECT above and this UPDATE must not be
      // cancelled mid-run (both the claimer and this sweep target the oldest
      // waiting rows, so the race is systematic, not incidental).
      const swept = await this.cancelJobs(stale, { reason, rootStatuses: ['waiting'] });
      // Count only the requested roots — descendants of a swept parent are
      // bookkeeping, not TTL victims of their own.
      const rootIds = new Set(stale);
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
    const row = await this.engine.retryJob(id, {
      admit: async (tx, prior) => {
        await authorizeJobExecution(tx, rowToMinionJob(prior));
        return admitDelegatedRetry(tx, id);
      },
    });
    return row ? rowToMinionJob(row) : null;
  }

  /** Prune old jobs in terminal statuses. Returns count of deleted rows. */
  async prune(opts?: { olderThan?: Date; status?: MinionJobStatus[]; dryRun?: boolean }): Promise<number> {
    const statuses = opts?.status ?? ['completed', 'dead', 'cancelled'];
    const olderThan = opts?.olderThan ?? new Date(Date.now() - 30 * 86400000);
    // #2712: dryRun counts the would-be-pruned rows without deleting (silently ignoring a safety flag on a delete
    // path is data loss). A completed dream synthesis child's key is archived before its row goes, or the next cycle
    // pays to synthesize the transcript again (engine-sql/jobs-queue.ts pruneJobs).
    return this.engine.pruneJobs({ statuses, olderThan, ...(opts?.dryRun ? { dryRun: true } : {}) });
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
    by_queue: QueueFamilyStats[];
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

    const read = await this.engine.readJobStats(since, wedgeQueue);
    const by_status: Record<string, number> = {};
    for (const r of read.by_status) by_status[r.status] = r.count;
    const typeRows = read.types, drainRows = read.drained, depthRows = read.depth;
    const drainByName = new Map(drainRows.map(r => [r.name, r]));
    const depthByName = new Map(depthRows.map(r => [r.name, r]));

    // Union of names so a type with waiting rows but zero window intake (or
    // vice versa) still gets a row — divergence alerting needs both sides.
    const typeNames = new Set<string>([
      ...typeRows.map(r => r.name),
      ...drainRows.map(r => r.name),
      ...depthRows.map(r => r.name),
    ]);
    const typeByName = new Map(typeRows.map(r => [r.name, r]));
    const by_type = [...typeNames].map(name => {
      const r = typeByName.get(name);
      const d = drainByName.get(name);
      const w = depthByName.get(name);
      const oldest = w?.oldest_waiting_seconds != null ? Number(w.oldest_waiting_seconds) : null;
      return {
        name,
        total: r ? r.total : 0,
        completed: r ? r.completed : 0,
        failed: r ? r.failed : 0,
        dead: r ? r.dead : 0,
        avg_duration_ms: r?.avg_duration_ms != null ? Math.round(r.avg_duration_ms) : null,
        drained_completed: d ? d.completed : 0,
        drained_failed: d ? d.failed : 0,
        drained_dead: d ? d.dead : 0,
        drained_cancelled: d ? d.cancelled : 0,
        waiting_now: w ? w.waiting_now : 0,
        oldest_waiting_minutes: oldest != null && Number.isFinite(oldest) ? Math.round(oldest / 60) : null,
      };
    }).sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const stalled = read.stalled;
    const wr = read.wedge;
    const wedgeLastCompleted = wr.last_completed ? new Date(wr.last_completed) : null;

    return {
      by_status,
      by_type,
      queue_health: {
        waiting: by_status['waiting'] ?? 0,
        active: by_status['active'] ?? 0,
        stalled,
      },
      by_queue: await (await import('./queue-families.ts')).queueFamilyStats(this.engine, since),
      wedge: {
        queue: wedgeQueue,
        active_healthy: wr.active_healthy,
        waiting: wr.waiting,
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
  /** `excludeWatchdogSuspects`: a worker with jobs in flight never claims a job marked by a shared watchdog drain (watchdog-attribution.ts).
   *  `suspectWaitMs` (GST-2529): once a marked job this worker could claim has waited that long since its requeue, a worker with
   *  jobs in flight claims nothing, so it drains, and one with nothing in flight takes that job first, so it runs alone and soon.
   *  `excludeNames`: skip these job names (the worker's long-job lane reservation, lanes.ts). */
  async claim(lockToken: string, lockDurationMs: number, queue: string, registeredNames: string[], opts: { excludeWatchdogSuspects?: boolean; suspectWaitMs?: number; excludeNames?: string[] } = {}): Promise<MinionJob | null> {
    if (registeredNames.length === 0) return null;
    await assertNoUnreviewedJobs(this.engine);

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
    const [groupId, capUsd] = legacyDefaultClaimParams();
    const claimFence = this.fences.registration();
    const row = await this.engine.claimNextJob({
      lockToken, lockDurationMs, queue, names: registeredNames,
      excludeNames: opts.excludeNames?.length ? opts.excludeNames : null,
      ...(opts.excludeWatchdogSuspects ? { excludeWatchdogSuspects: true } : {}),
      ...(opts.suspectWaitMs !== undefined ? { suspectWaitMs: opts.suspectWaitMs } : {}),
      handlerTimeouts: HANDLER_DEFAULT_TIMEOUT_MS,
      handlerLockDurations: HANDLER_DEFAULT_LOCK_DURATION_MS,
      legacySpend: { groupId, capUsd }, ...(claimFence ? { fence: claimFence } : {}),
    });
    const job = row ? rowToMinionJob(row) : null;
    if (job && claimFence) this.fences.remember(job.id, lockToken, claimFence);
    return job;
  }

  /** GST-2529: whether a marked job this worker could claim has waited `suspectWaitMs` since its requeue. The worker asks at most every
   *  few seconds and passes `suspectWaitMs` to `claim` only when one has, so a claim with no such job keeps the claim index's order. */
  async hasOverdueWatchdogSuspect(queue: string, registeredNames: string[], suspectWaitMs: number): Promise<boolean> {
    if (registeredNames.length === 0) return false;
    return this.engine.hasOverdueWatchdogSuspect(queue, registeredNames, suspectWaitMs);
  }

  /** A co-runner of a watchdog drain back to waiting, marked, no attempt burned (token-fenced). */
  releaseWatchdogClaim(id: number, lockToken: string, errorText: string): Promise<boolean> { return this.fences.ending(id, lockToken, opts => this.engine.releaseWatchdogClaim(id, lockToken, errorText, opts)); }

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
    await assertNoUnreviewedJobs(this.engine);
    return (await this.engine.killTimedOutJobs(...this.fences.sweepArgs())).map(rowToMinionJob);
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
    await assertNoUnreviewedJobs(this.engine);
    return (await this.engine.killWallClockJobs(lockDurationMs, ...this.fences.sweepArgs())).map(rowToMinionJob);
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
    const row = await this.fences.ending(id, lockToken, opts => retryOnStalePlan(() => this.engine.completeJob(id, lockToken, result, opts)));
    return row ? rowToMinionJob(row) : null;
  }

  /**
   * Fail a job (token-fenced). All side effects atomic in one transaction:
   *   1. UPDATE child to 'delayed' (retry) | 'failed' | 'dead'; `result` (a handler result that reported a failure, #7188) is kept
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
    backoffMs?: number,
    result?: Record<string, unknown>,
  ): Promise<MinionJob | null> {
    const row = await this.fences.ending(id, lockToken, opts => retryOnStalePlan(() => this.engine.failJob(id, lockToken, errorText, newStatus, backoffMs, result, opts)));
    return row ? rowToMinionJob(row) : null;
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
    const row = await this.fences.ending(id, lockToken, opts => this.engine.delayActiveJob(id, lockToken, { errorText, delayMs: backoffMs, appendStack: true, clearTimeout: false }, opts));
    return row ? rowToMinionJob(row) : null;
  }

  /**
   * Return a claimed job to `delayed` without counting an attempt or growing
   * its stacktrace (a deferral is a state, not a failure; a job that waits for
   * a key for weeks must not accumulate one stack entry per retry).
   */
  async deferJob(id: number, lockToken: string, note: string, delayMs: number): Promise<MinionJob | null> {
    const row = await this.fences.ending(id, lockToken, opts => this.engine.delayActiveJob(id, lockToken, { errorText: note, delayMs: Math.max(0, delayMs), appendStack: false, clearTimeout: true }, opts));
    return row ? rowToMinionJob(row) : null;
  }

  async releaseConfigurationJob(
    id: number,
    lockToken: string,
    signal: AbortSignal,
  ): Promise<'released' | 'no_op' | 'unconfirmed'> {
    if (signal.aborted) return 'unconfirmed';
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<'unconfirmed'>(resolve => {
        onAbort = () => resolve('unconfirmed');
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const release = this.fences.ending(id, lockToken, opts => this.engine.delayActiveJob(
        id, lockToken,
        { errorText: 'worker_configuration_blocked', delayMs: 30_000, appendStack: false, clearTimeout: true },
        { signal, ...opts },
      )).then(row => signal.aborted ? 'unconfirmed' as const : row ? 'released' as const : 'no_op' as const);
      return await Promise.race([release, cancelled]);
    } catch {
      return 'unconfirmed';
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Update job progress (token-fenced). */
  async updateProgress(id: number, lockToken: string, progress: unknown): Promise<boolean> {
    return this.engine.updateJobProgress(id, lockToken, progress, ...this.fences.claimArgs(id, lockToken));
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
    const fence = this.fences.optsFor(id, lockToken);
    return this.engine.renewJobLease(id, lockToken, lockDurationMs, fence.fence ? { ...opts, ...fence } : opts);
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
    await assertNoUnreviewedJobs(this.engine);
    const rows = await this.lockRetry(() => this.engine.promoteDelayedJobs());
    return rows.map(rowToMinionJob);
  }

  /** Detect and handle stalled jobs. Single CTE, no off-by-one. Returns affected jobs. */
  async handleStalled(graceMsOverride?: number): Promise<{ requeued: MinionJob[]; dead: MinionJob[] }> {
    await assertNoUnreviewedJobs(this.engine);
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
    // GBRA-133 (drain-lease holder records) and GBRA-130 A-30 (a multi-claim worker's co-runners requeue marked, no
    // stall counted) live in the engine statement; stall-deaths notify and unblock parents like every terminal kill.
    return this.engine.reclaimStalledJobs(graceMs, this.fences.registrationOpts()).then(r => ({ requeued: r.requeued.map(rowToMinionJob), dead: r.dead.map(rowToMinionJob) })).then(async (result) => {
      // W0 ship-review (data-migration): the per-kill unblock above is
      // forward-only — parents stranded in 'waiting-children' by PRE-upgrade
      // stall-deaths (children already status='dead') are never revisited by
      // any per-event unblock site. This idempotent sweep self-heals ALL
      // stranding classes, retroactive included, once per stall tick: any
      // waiting-children parent with zero non-terminal children flips back to
      // 'waiting'. Cheap (single UPDATE, NOT EXISTS on an indexed FK) at the
      // 30s sweep cadence.
      try {
        await this.engine.resolveStrandedParents();
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
    const row = await this.engine.resolveParentJob(parentId);
    return row ? rowToMinionJob(row) : null;
  }

  /** Fail the parent when a child fails with fail_parent policy. */
  async failParent(parentId: number, childId: number, errorText: string): Promise<MinionJob | null> {
    const row = await this.engine.failParentJob(parentId, `child job ${childId} failed: ${errorText}`);
    return row ? rowToMinionJob(row) : null;
  }

  /** Pause a waiting or active job. For active jobs, clears the lock so the worker's
   *  AbortController fires and the handler stops gracefully. */
  async pauseJob(id: number): Promise<MinionJob | null> {
    const row = await this.engine.pauseJob(id);
    return row ? rowToMinionJob(row) : null;
  }

  /** Resume a paused job back to waiting. */
  async resumeJob(id: number): Promise<MinionJob | null> {
    const prior = await this.getJob(id);
    if (!prior) return null;
    await authorizeJobExecution(this.engine, prior);
    const row = await this.engine.resumeJob(id);
    return row ? rowToMinionJob(row) : null;
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

    const row = await this.engine.postInboxMessage(jobId, sender, payload);
    return row ? rowToInboxMessage(row) : null;
  }

  /** Read unread inbox messages for a job. Token-fenced. Marks messages as read. */
  async readInbox(jobId: number, lockToken: string): Promise<InboxMessage[]> {
    return (await this.engine.readJobInbox(jobId, lockToken, ...this.fences.claimArgs(jobId, lockToken))).map(rowToInboxMessage);
  }

  /** Update token counts for a job. Accumulates (adds to existing). Token-fenced. */
  async updateTokens(id: number, lockToken: string, tokens: TokenUpdate): Promise<boolean> {
    return this.engine.addJobTokens(id, lockToken, { input: tokens.input ?? 0, output: tokens.output ?? 0, cache_read: tokens.cache_read ?? 0 }, ...this.fences.claimArgs(id, lockToken));
  }

  /** Replay a completed/failed/dead job with optional data overrides. Creates a new job. */
  async replayJob(id: number, dataOverrides?: Record<string, unknown>): Promise<MinionJob | null> {
    const source = await this.getJob(id);
    if (!source) return null;
    if (!['completed', 'failed', 'dead'].includes(source.status)) return null;
    const authority = await authorizeJobExecution(this.engine, source);
    if (authority.kind !== 'application' && dataOverrides && Object.keys(dataOverrides).length) throw new Error('Remote job replay cannot override accepted data; submit a new job');

    const { data, clientId } = prepareDelegatedReplay(source.name, source.data, dataOverrides);

    return this.add(source.name, data, {
      queue: source.queue,
      priority: source.priority,
      max_attempts: source.max_attempts,
      backoff_type: source.backoff_type,
      backoff_delay: source.backoff_delay,
      backoff_jitter: source.backoff_jitter,
    }, { submissionAuthority: authority, delegatedClientId: clientId,
      allowProtectedSubmit: authority.kind === 'remote_agent' || (authority.kind === 'application' && isProtectedJobName(source.name)) });
  }

  /** Remove a child's dependency on its parent. */
  async removeChildDependency(childId: number): Promise<void> {
    await this.engine.detachChildJob(childId);
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
    return (await this.engine.readChildCompletions(parentId, lockToken, opts?.since ?? null)) as ChildDoneMessage[];
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
    const existingRows = await this.engine.listJobAttachmentNames(jobId);
    if (existingRows === null) {
      throw new Error(`job ${jobId} not found`);
    }
    const existingFilenames = new Set(existingRows);

    const result = validateAttachment(input, {
      maxBytes: this.maxAttachmentBytes,
      existingFilenames,
    });
    if (!result.ok) {
      throw new Error(`attachment validation failed: ${result.error}`);
    }
    const { filename, content_type, bytes, size_bytes, sha256 } = result.normalized;

    const row = await this.engine.insertJobAttachment(jobId, { filename, content_type, bytes, size_bytes, sha256 });
    return rowToAttachment(row);
  }

  /** List attachments for a job (metadata only, no bytes). */
  async listAttachments(jobId: number): Promise<Attachment[]> {
    return (await this.engine.listJobAttachments(jobId)).map(rowToAttachment);
  }

  /**
   * Fetch a single attachment with bytes. Returns null if not found.
   * The bytes are returned as a Buffer (Uint8Array under the hood).
   */
  async getAttachment(jobId: number, filename: string): Promise<{ meta: Attachment; bytes: Buffer } | null> {
    const row = await this.engine.getJobAttachment(jobId, filename);
    if (!row) return null;
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
    return this.engine.deleteJobAttachment(jobId, filename);
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
 *
 * Queue honesty (agent-first operator wave E5): when the caller knows no
 * worker is running for the queue (`workerAlive: false` — always on PGLite
 * unless a `gbrain jobs work` drain is live), waiting work is `no_worker`, not
 * wedged: nothing is stuck, nothing is running it. Omitted liveness keeps the
 * pre-E5 derivation (doctor's wedged_queue check).
 */
export function deriveWedgeSignal(wedge: {
  queue?: string;
  active_healthy: number;
  waiting: number;
  minutes_since_completion: number | null;
}, liveness: { workerAlive?: boolean } = {}): { wedged: boolean; no_worker: boolean; wedge_threshold_minutes: number; private_queue: boolean } {
  const raw = parseInt(process.env.GBRAIN_WEDGED_QUEUE_WARN_MINUTES ?? '', 10);
  const wedge_threshold_minutes = Number.isFinite(raw) && raw > 0 ? raw : 15;
  // A dream-inline private queue is parent-owned: no shared worker will ever
  // claim it, so "wedged — restart the worker" is impossible advice (the
  // incident bug class). Surface it as private_queue instead so every consumer
  // (jobs stats, get_job_stats op, doctor) points at reconciliation.
  const private_queue = wedge.queue !== undefined && isDreamInlinePrivateQueue(wedge.queue);
  const mins = wedge.minutes_since_completion;
  const no_worker = !private_queue && liveness.workerAlive === false && wedge.waiting > 0;
  const wedged = !private_queue && !no_worker && wedge.active_healthy === 0 && wedge.waiting > 0
    && (mins === null || mins > wedge_threshold_minutes);
  return { wedged, no_worker, wedge_threshold_minutes, private_queue };
}
