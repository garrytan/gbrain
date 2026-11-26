/**
 * The Minion queue, spend ledger, queue health and job table statements of BrainEngine.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { FenceOpts } from '../engine-sql/lease-token.ts';
import type { AccessTokenInsert, ActiveAccessTokenRow } from '../engine-sql/access-tokens.ts';
import type { AdmitJobPolicy, AdmitJobResult, AdmitJobSpec, ClaimJobSpec, JobRow, ListJobsFilter } from '../engine-sql/jobs.ts';
import type { AgentClientSpendRow, ClientReserveOutcome, ClientReserveSpec, GroupReserveOutcome, GroupReserveSpec, GroupSpendRow, OauthClientInsert, SettleLogOutcome, SpendLogInsert } from '../engine-sql/spend-log.ts';
import type { BudgetOwnerRow, EmbedBackfillState, FailedJobError, JobStatusCount, JobStatusFilter, LastAutopilotCycles, QueueDepth, SourceCycleFailureRow, SourceJobCounts, TtlCancelledCount, WaitingScopeState } from '../engine-sql/jobs-status.ts';
import type { CancelJobsSpec, DelayActiveJobSpec, JobAttachmentInsert, JobPageSpec, JobSourceState, JobStatsRead, JobTokenCounts, PrivateQueueState, PruneJobsSpec, QueueFamilyRow, RetryJobPolicy, SynthesisCompletion, SynthesisCompletionPrefix, UnfinishedJobRow } from '../engine-sql/jobs-queue.ts';
import type { DeadDreamSubmissionSpec, FactsAbsorbJobRow, FactsAbsorbStillDead, GlobalMaintenanceDeaths, LastFailedGlobalMaintenanceJob, LegacyJobAuthorityRead, QueuedSpendRows } from '../engine-sql/jobs-checks.ts';
import type { ExpireSpendScope, JobSpendTreeSpec, LeasePressureFilter, LeasePressureInsert, LeasePressureRow, SettleSpendOutcome, SpendReservationInsert, SpendTreeRow } from '../engine-sql/jobs-spend.ts';
import type { JobInsightRows, JobInsightSpec } from '../engine-sql/jobs-insight.ts';
import type * as JobsWake from '../engine-sql/jobs-wake.ts';
import type { OauthClientPatch, OauthClientPatchGuard, OauthClientPatched, OauthClientRow } from '../engine-sql/oauth-clients.ts';
import type { PrivateQueueHealthRow, QueueDivergence, QueueDivergenceSpec, QueueHealthSignals, QueueHealthSpec, QueueWedgeRow, QueueWedgeSignals, UntakenWaitingJobs, WaitingByQueueRow } from '../engine-sql/jobs-health.ts';
import type { SubagentFailureFallback, SubagentMessageInsert, SubagentMessageRow, SubagentOneshotLedgerRow, SubagentRetainedPutPage, SubagentToolInsert, SubagentToolOrder, SubagentToolRow, SubagentToolStart, SubagentToolTarget, SubagentWriteOutcome } from '../engine-sql/jobs-subagent.ts';
import type { AccessTokenScopeRow } from '../engine-sql/access-tokens.ts';
import type { EngineMigrationHistory, ManualLinkTransition, MigrationPageColumns, MigrationRows, MigrationTable } from '../engine-sql/engine-migration.ts';

export interface JobsMembers {
  // ============================================================
  // Minion jobs (engine-sql/jobs.ts). Rows are raw `minion_jobs` rows; the queue maps them with `rowToMinionJob`.
  // ============================================================
  /**
   * Submit one job in one transaction: idempotency key, parameter coalesce, delegated capacity, name quota,
   * backpressure caps and parent checks, then the insert and the parent flip to `waiting-children`. Returns the new
   * row, or an existing one with `coalesced` (and the audit of a cap or parameter coalesce).
   */
  admitJob(spec: AdmitJobSpec, policy: AdmitJobPolicy): Promise<AdmitJobResult>;

  /** One job row by id, or null. */
  getJob(id: number): Promise<JobRow | null>;
  /** The given ids whose job is waiting, active, delayed, waiting-children or paused (engine-sql/jobs.ts). */
  readLiveJobIds(ids: number[]): Promise<number[]>;
  /** `{ data }` of the job holding an idempotency key, whatever its status, or null. */
  readJobDataByIdempotencyKey(key: string): Promise<{ data: unknown } | null>;
  /**
   * The idempotency-key step of admitJob on its own: the row holding `key` when `policy.decide` returns it, or null
   * when no row holds the key or a dead or cancelled row's key was freed. `policy.authority` is the caller's
   * submission authority, which the Rust store decides with; the SQL engines ask `decide`.
   */
  coalesceOnIdempotencyKey(key: string, policy: { authority: unknown; decide: AdmitJobPolicy['decide'] }): Promise<JobRow | null>;

  /** Job rows matching every given filter, newest first (default 50 from offset 0). */
  listJobs(filter?: ListJobsFilter): Promise<JobRow[]>;

  /**
   * Claim the next waiting job of `names` in `queue` by priority then age (two workers never get one row), stamping
   * the lease, resolved timeout and lease, the attempt and the spend fence. On Postgres it runs on the direct pool.
   */
  claimNextJob(spec: ClaimJobSpec): Promise<JobRow | null>;

  /** Extend the lease of an active job this token still holds; false when the claim moved on. Direct pool on Postgres. */
  renewJobLease(id: number, lockToken: string, lockDurationMs: number, opts?: { signal?: AbortSignal } & FenceOpts): Promise<boolean>;

  /**
   * Complete an active job this token holds, rolling its tokens and `child_done` up to its parent and waking a parent
   * whose children are all finished. Returns the completed row (before a `remove_on_complete` delete), or null.
   */
  completeJob(id: number, lockToken: string, result?: Record<string, unknown>, opts?: FenceOpts): Promise<JobRow | null>;

  /**
   * Fail an active job this token holds (`delayed` retry, `failed` or `dead`), applying `on_child_fail` to its parent
   * on a terminal failure. Returns the row (before a `remove_on_fail` delete), or null when the token is stale.
   */
  failJob(id: number, lockToken: string, errorText: string, newStatus: 'delayed' | 'failed' | 'dead', backoffMs?: number, result?: Record<string, unknown>, opts?: FenceOpts): Promise<JobRow | null>;

  /**
   * The stall sweep: active jobs whose lease expired more than `graceMs` ago requeue (a dead multi-claim worker's
   * co-runners marked, no stall counted) or go `dead` at `max_stalled`, notifying and waking their parents.
   */
  reclaimStalledJobs(graceMs: number, opts?: FenceOpts): Promise<{ requeued: JobRow[]; dead: JobRow[] }>;

  // Minion queue statements beyond the lifecycle (engine-sql/jobs-queue.ts): operator writes, sweeps, inbox, private
  // queues, stats and attachments. The queue keeps the policy (validation, the unreviewed-job gate, authorization).
  /** Delete a terminal job (its inbox and attachments go with it); false when it is missing or still live. */
  deleteTerminalJob(id: number): Promise<boolean>;
  /** Pause a waiting, active or delayed job, clearing its lock. Null when the job is in no such status. */
  pauseJob(id: number): Promise<JobRow | null>;
  /** Return a paused job to waiting. Null when it is not paused. */
  resumeJob(id: number): Promise<JobRow | null>;
  /** Fail a parent waiting on its children with `errorText`. Null when it is not waiting on children. */
  failParentJob(parentId: number, errorText: string): Promise<JobRow | null>;
  /** Return a parent waiting on its children to waiting when none of them is live. */
  resolveParentJob(parentId: number): Promise<JobRow | null>;
  /** Wake every parent waiting on children with no live child; the count woken. */
  resolveStrandedParents(): Promise<number>;
  /** Remove a child's dependency on its parent. */
  detachChildJob(childId: number): Promise<void>;
  /** Replace the progress of an active job this token holds; false when the claim moved on. */
  updateJobProgress(id: number, lockToken: string, progress: unknown, opts?: FenceOpts): Promise<boolean>;
  /** Add to the token counts of an active job this token holds; false when the claim moved on. */
  addJobTokens(id: number, lockToken: string, tokens: JobTokenCounts, opts?: FenceOpts): Promise<boolean>;
  /**
   * Return an active job this token holds to `delayed` without counting an attempt (a lease-full bounce, a deferral,
   * a configuration release). Null when the claim moved on. Postgres cancels the statement when `signal` aborts.
   */
  delayActiveJob(id: number, lockToken: string, spec: DelayActiveJobSpec, opts?: { signal?: AbortSignal } & FenceOpts): Promise<JobRow | null>;
  /** Requeue a co-runner of a watchdog drain with the suspect mark, no attempt counted; false when the claim moved on. */
  releaseWatchdogClaim(id: number, lockToken: string, errorText: string, opts?: FenceOpts): Promise<boolean>;
  /**
   * Hand a just-taken claim back un-run because the pause marker appeared after the claim: the row this token locks goes
   * to `delayed` for one minute, lock cleared, start time, error text and attempt counts untouched. A stale token changes nothing.
   */
  releaseClaimForPause(id: number, lockToken: string, opts?: FenceOpts): Promise<void>;
  /** The same hand-back for a quiet-hours deferral: `delayed` for fifteen minutes. */
  deferClaimForQuietHours(id: number, lockToken: string, opts?: FenceOpts): Promise<void>;
  /** Append the watchdog suspect mark once to a job's stacktrace (any status, `updated_at` untouched). */
  markJobWatchdogSuspect(id: number): Promise<void>;
  /** Move delayed jobs whose delay passed back to waiting. */
  promoteDelayedJobs(): Promise<JobRow[]>;
  /** Cancel the live roots in `ids` and their descendants in one transaction, notifying and waking their parents. */
  cancelJobs(ids: readonly number[], spec?: CancelJobsSpec): Promise<JobRow[]>;
  /** Dead-letter active jobs past `timeout_at` that still hold a lease, notifying and waking their parents. */
  killTimedOutJobs(opts?: FenceOpts): Promise<JobRow[]>;
  /** Dead-letter active jobs past their wall-clock threshold, notifying and waking their parents. */
  killWallClockJobs(lockDurationMs: number, opts?: FenceOpts): Promise<JobRow[]>;
  /** Delete (or count, on `dryRun`) jobs in `statuses` last updated before `olderThan`; the count. */
  pruneJobs(spec: PruneJobsSpec): Promise<number>;
  /** Completed dream synthesis keys of a source starting with `keyPrefix`, live jobs and the prune archive, each once. */
  listSynthesisCompletionKeys(sourceId: string, keyPrefix: SynthesisCompletionPrefix): Promise<string[]>;
  /** The source's synth-v2 completions (live jobs, then archive rows) that finished within the last `hours`. */
  listRecentSynthesisCompletions(sourceId: string, hours: number): Promise<SynthesisCompletion[]>;
  /** Re-queue a failed or dead job fresh after `policy.admit` passes, in one transaction. Null when not retried. */
  retryJob(id: number, policy: RetryJobPolicy): Promise<JobRow | null>;
  /** Insert one inbox message for a job. */
  postInboxMessage(jobId: number, sender: string, payload: unknown): Promise<JobRow>;
  /** Mark and return the unread messages of an active job this token holds; [] when the claim moved on. */
  readJobInbox(jobId: number, lockToken: string, opts?: FenceOpts): Promise<JobRow[]>;
  /** The `child_done` payloads in an active parent's inbox (after `since`), oldest first; [] unless this token holds it. */
  readChildCompletions(parentId: number, lockToken: string, since?: Date | null): Promise<unknown[]>;
  /** Ids of the live jobs in one queue, ascending. */
  listOpenJobIdsInQueue(queue: string): Promise<number[]>;
  /** Extend the owner lease of a private queue's live jobs this owner token holds; the count renewed. */
  renewPrivateQueueLease(queue: string, ownerToken: string, leaseMs: number): Promise<number>;
  /** Private queues with live jobs and owner metadata, oldest first, at most `maxQueues`. */
  listOwnedPrivateQueues(maxQueues: number): Promise<string[]>;
  /** The recovery verdict's inputs for one private queue. */
  readPrivateQueueState(queue: string): Promise<PrivateQueueState>;
  /** Ids of jobs of `name` waiting since before `hours` ago, oldest first, at most `limit`. */
  listStaleWaitingJobIds(name: string, hours: number, limit: number): Promise<number[]>;
  /** Every unfinished job of `names` (any status but completed, failed, dead, cancelled), by id, in one read with no limit. */
  listUnfinishedJobsByName(names: readonly string[]): Promise<UnfinishedJobRow[]>;
  /** How many jobs of `name` have waited since before `hours` ago. */
  countTtlExpiredWaiting(name: string, hours: number): Promise<number>;
  /** The raw counts behind the queue statistics, with the wedge signature of `queue`. */
  readJobStats(since: Date, queue: string): Promise<JobStatsRead>;
  /** Per queue family: live counts now and intake since `since`, families in byte order. */
  readQueueFamilyStats(since: Date): Promise<QueueFamilyRow[]>;
  /** Whether a waiting, authorized, marked job of `names` in `queue` has waited `waitMs` since its requeue. */
  hasOverdueWatchdogSuspect(queue: string, names: readonly string[], waitMs: number): Promise<boolean>;
  /** Live jobs whose authority is not exactly the application authority, by id. */
  listUnreviewedJobs(): Promise<Array<{ id: number; submission_authority: unknown }>>;
  /** The name and data of a failed or dead job, or null. */
  getFailedJobForRetry(id: number): Promise<{ name: string; data: Record<string, unknown> } | null>;
  /** A delegated client's open `subagent` jobs, across queues and non-terminal statuses (its used slots). */
  countOpenJobsByOwner(clientId: string): Promise<number>;
  /** Lock a delegated client's OAuth row for the rest of the transaction (delegated job admission). */
  lockOAuthClient(clientId: string): Promise<void>;
  /** An agent job's source: archived and created_at, or null (the job authority check). */
  readJobSourceState(sourceId: string): Promise<JobSourceState | null>;
  /** One `list_jobs` page, newest first on `(created_at, id)`, each row with `created_us` for the next cursor. */
  listJobPage(spec: JobPageSpec): Promise<JobRow[]>;
  /** The attachment filenames of a job, or null when the job does not exist. */
  listJobAttachmentNames(jobId: number): Promise<string[] | null>;
  /** Store one attachment; its metadata. A duplicate filename violates `uniq_minion_attachments_job_filename`. */
  insertJobAttachment(jobId: number, attachment: JobAttachmentInsert): Promise<JobRow>;
  /** The attachment metadata of a job, oldest first. */
  listJobAttachments(jobId: number): Promise<JobRow[]>;
  /** One attachment with its `content` bytes, or null. */
  getJobAttachment(jobId: number, filename: string): Promise<JobRow | null>;
  /** Delete one attachment; false when there was none. */
  deleteJobAttachment(jobId: number, filename: string): Promise<boolean>;
  // Queue health reads (lane 5 group A; engine-sql/jobs-health.ts): what doctor's queue checks, the advisor and the submit probe ask.
  /** The `queue_health` check's counts: stalled-forever, deep, watchdog-killed, prompt_too_long and old embed-backfill jobs. */
  readQueueHealthSignals(spec: QueueHealthSpec): Promise<QueueHealthSignals>;
  /** Waiting jobs per queue (depth, oldest age in seconds), deepest first. */
  listWaitingByQueue(): Promise<WaitingByQueueRow[]>;
  /** Intake, completions and waiting per job name, and the waiting-TTL cancellations, over a window. */
  readQueueDivergence(spec: QueueDivergenceSpec): Promise<QueueDivergence>;
  /** Per queue (private dream queues excluded): live active rows, waiting rows and minutes since the last completion. */
  listQueueWedgeCounts(): Promise<QueueWedgeRow[]>;
  /** Per dream-inline private queue: live active, waiting-class and paused rows, oldest wait and birth, source id. */
  listPrivateQueueHealth(): Promise<PrivateQueueHealthRow[]>;
  /** One queue's wedge signals (stalled, live active, waiting, claimable, last completions). `opts.signal` cancels a SQL statement. */
  readWedgeSignals(queue: string, handlerNames: readonly string[], opts?: { signal?: AbortSignal }): Promise<QueueWedgeSignals>;
  /** The age in whole seconds of the oldest waiting job in a queue, or null with none. */
  readOldestWaitingAge(queue: string, opts?: { signal?: AbortSignal }): Promise<number | null>;
  /** The queue whose waiting `name` jobs no worker takes (waited past `thresholdHours`, no live or recent job there), or null. */
  readUntakenWaitingJobs(name: string, thresholdHours: number): Promise<UntakenWaitingJobs | null>;
  /** How many jobs wait; `excludeFactsAbsorb` leaves out the `facts-absorb` jobs PGLite's facts drain owns. */
  countWaitingJobs(excludeFactsAbsorb: boolean): Promise<number>;
  /** How many jobs of `queue` wait under one of `names` (the minion worker's stall count); none for an empty list. */
  countWaitingJobsForNames(queue: string, names: readonly string[]): Promise<number>;
  /** Active jobs whose lock lapsed or whose stalled counter reached two, per name. */
  listStuckActiveJobsByName(): Promise<Array<{ name: string; n: number }>>;

  // Engine migration source reads (engine-sql/engine-migration.ts): what `gbrain migrate --to` reads from the brain it moves.
  /** The write-history tables holding rows and the page-version count, which the legacy copier refuses to discard. */
  readEngineMigrationHistory(): Promise<EngineMigrationHistory>;
  /** Every row of a table the copier carries whole, by id (sources: `default` first); null when the schema lacks it. */
  readMigrationRows(table: MigrationTable): Promise<MigrationRows | null>;
  /** A page's origin, kind and provenance columns and whether its projection is sealed, in any deletion state; null for none. */
  readMigrationPageColumns(slug: string, sourceId: string): Promise<MigrationPageColumns | null>;
  /** The manual dated statements of the relationships a page starts. */
  listManualLinkTransitions(slug: string, sourceId: string): Promise<ManualLinkTransition[]>;
  /** Timeline rows of live pages. */
  countLiveTimelineEntries(): Promise<number>;

  // Minion job counts and last-run reads for the status surfaces (engine-sql/jobs-status.ts): `gbrain status`, `jobs stats`,
  // the facts drain backlog, source health and the sync status report. Windows are seconds.
  /** The newest completed `autopilot-cycle` job and the newest completed `autopilot-*` job (finished-at order), or null each. */
  readLastAutopilotCycles(): Promise<LastAutopilotCycles>;
  /** Job counts by status, in status order, over the jobs a filter (name, queue, statuses) matches; no filter counts all. */
  countJobsByStatus(filter?: JobStatusFilter): Promise<JobStatusCount[]>;
  /** Waiting depth and oldest-waiting age in seconds per queue with waiting work, deepest first. */
  readWaitingQueueDepths(): Promise<QueueDepth[]>;
  /** Recent whole-cycle failures of `autopilot-cycle` jobs by source (failure cooldown): count and last finish, after an ISO cutoff, by source id. */
  listRecentSourceCycleFailures(spec: { cutoff: string; sourceId?: string | null }): Promise<SourceCycleFailureRow[]>;
  /** The freshest `updated_at` among completed jobs, or null. */
  readLastCompletedJobAt(): Promise<Date | null>;
  /** The latest `finished_at` of the completed jobs named `name`, as UTC ISO seconds, or null (engine-sql/fence-repair-records.ts). */
  readLastFinishedJobAt(name: string): Promise<string | null>;
  /** Cancelled jobs whose `error_text` matches the LIKE pattern and that finished in the last `withinSeconds`, counted by name. */
  countTtlCancelledByName(reasonLike: string, withinSeconds: number): Promise<TtlCancelledCount[]>;
  /** The waiting jobs sharing a returned job's source scope, plus its id and age in minutes while it is active with a live lease. */
  readWaitingScopeState(spec: { name: string; queue: string; jobId: number }): Promise<WaitingScopeState>;
  /** Jobs of a name that completed within the last `withinSeconds`. */
  countRecentCompletedJobs(name: string, withinSeconds: number): Promise<number>;
  /** The id and failure text of dead or failed jobs updated within the last `withinSeconds`, by id. */
  listRecentFailedJobErrors(withinSeconds: number): Promise<FailedJobError[]>;
  /** The newest five unfinished jobs that own a budget, with remaining and reserved cents, newest id first. */
  listBudgetOwners(): Promise<BudgetOwnerRow[]>;
  /** The average page text length (capped at `maxChars`) of the pages queued jobs of a name and queue point at, or null. */
  readQueuedPageChars(spec: { name: string; queue: string; maxChars: number }): Promise<number | null>;
  /** Per-source failure, queue and embed-backfill counts over the `sync` and `embed-backfill` jobs. */
  readSourceJobCounts(failedWithinSeconds: number): Promise<SourceJobCounts[]>;
  /** The embed-backfill jobs of each named source: queued, active and last completion. */
  readEmbedBackfillBySource(sourceIds: readonly string[]): Promise<EmbedBackfillState[]>;

  // Group C: the queue reads the doctor checks and the dream breaker make (engine-sql/jobs-checks.ts).
  /** The distinct `sourceId` of embed-backfill jobs that ended failed or dead with a stall record in their progress (null: a job without a source). */
  listStalledEmbedBackfillSources(): Promise<Array<string | null>>;
  /** How the last `deaths` brain-wide maintenance jobs and each dream phase's last `deaths` children died (the `global_maintenance_timeouts` check). */
  readGlobalMaintenanceDeaths(spec: { deaths: number }): Promise<GlobalMaintenanceDeaths>;
  /** The newest brain-wide maintenance job that ended without completing after `since` (a timestamp text, or null for all), with the count and earliest finish of them all. */
  readLastFailedGlobalMaintenanceJob(since: string | null): Promise<LastFailedGlobalMaintenanceJob | null>;
  /** The stored config rows of `keys` and the finish (UTC, to the second) of the last completed brain-wide maintenance job, or null (fence-repair/hold-fix.ts readFenceAutoRepair). */
  /** Facts-absorb jobs dead or failed inside `hours` that no later job for the same page completed: the total and the newest `limit` (the `facts_extraction_health` check). */
  listFactsAbsorbJobsStillDead(spec: { hours: number; limit: number }): Promise<FactsAbsorbStillDead>;
  /** The claim gate's population and the terminal keyed rows with SQL NULL authority (the `legacy_job_authority` check). */
  readLegacyJobAuthority(): Promise<LegacyJobAuthorityRead>;
  /** Queued jobs by name and spend basis, and the spend-authorized rows waiting longer than `waitMs` (the `legacy_job_authority` spend census). */
  readQueuedSpendRows(spec: { legacyPrefixes: Readonly<Record<string, readonly string[]>>; waitMs: number }): Promise<QueuedSpendRows>;
  /** The stacktrace lines `LIKE prefix || '%'` (a LIKE pattern: `_` is a wildcard) of the newest `scanJobs` recently updated jobs (the `runtime_build_skew` check). */
  listBuildSkewStacktraceLines(spec: { prefix: string; windowHours: number; scanJobs: number }): Promise<Array<{ id: number; line: string }>>;
  /** Dead dream submissions per base key inside the window, resets applied (the dream breaker's counting rule). */
  countDeadDreamSubmissionRows(spec: DeadDreamSubmissionSpec): Promise<Array<{ base_key: string; dead_submissions: number; last_dead_at: string }>>;
  /** Facts-absorb jobs whose key is `LIKE prefix || '%'` (a LIKE pattern) that are dead or whose key is in `keys` (the dead-write retry's reconcile). */
  listFactsAbsorbJobsByKeyPrefix(spec: { prefix: string; keys: readonly string[] }): Promise<FactsAbsorbJobRow[]>;
  /** The dead facts-absorb jobs with a key in `keys` (the dead-write retry's operator controls). */
  listDeadFactsAbsorbJobsByKeys(keys: readonly string[]): Promise<FactsAbsorbJobRow[]>;
  // Group D (jobs insight): the reads behind `describeJobs`.
  /** Submitter, queue position, slot holders, live children, blocking locks and foreign-owner tokens of a batch of jobs. */
  readJobInsight(spec: JobInsightSpec): Promise<JobInsightRows>;
  // Group C (spend reservations and lease pressure): `mcp_spend_reservations` and `minion_lease_pressure_log`.
  /** Per described job: the settled cents, priced count and unsettled count of the reservations of itself and its descendants. */
  readJobSpendTree(spec: JobSpendTreeSpec): Promise<SpendTreeRow[]>;
  /** One new `pending` spend reservation, for a client or a budget group, optionally tied to a job. */
  insertSpendReservation(row: SpendReservationInsert): Promise<void>;
  /** Mark every overdue `pending` reservation `expired` (all, one client's or one group's); how many. */
  expireSpendReservations(scope?: ExpireSpendScope): Promise<number>;
  /** Settle a pending or expired hold at its actual cents (idempotent: a settled one reports `already_settled`). */
  settleSpendReservation(reservationId: string, actualCents: number): Promise<SettleSpendOutcome>;
  /** Record why a pending or expired hold's usage is unknown; whether a row changed. */
  markSpendUsageUnknown(reservationId: string, reason: string): Promise<boolean>;
  // Spend ledger and client budgets (engine-sql/spend-log.ts): `mcp_spend_log` and the spend columns of `oauth_clients`.
  /** Atomic client admission: the client's cap, the sweep, the day's ledger sum and open holds, then a refusal or the new hold. */
  reserveClientSpend(spec: ClientReserveSpec): Promise<ClientReserveOutcome>;
  /** Atomic group admission against a lifetime total: the sweep, the totals, then a refusal or the (bounded) new hold. */
  reserveGroupSpend(spec: GroupReserveSpec): Promise<GroupReserveOutcome>;
  /** A budget key's ledger sum, overdue holds and live holds, in cents. */
  readGroupSpendTotals(budgetKey: string): Promise<GroupSpendRow>;
  /** Settle a hold and write its ledger row as one unit (a settled hold is left alone; a missing one is reported). */
  settleSpendWithLog(reservationId: string, actualCents: number, operation: string, tokenName: string | null): Promise<SettleLogOutcome>;
  /** One ledger row of an unreserved paid call. */
  insertSpendLog(row: SpendLogInsert): Promise<void>;
  /** A client's ledger sum from an instant on, in cents. */
  sumClientSpendSince(clientId: string, since: Date): Promise<number>;
  /** A client's `budget_usd_per_day` as text (dollars to two decimals); null for no cap or no such client. */
  readClientBudgetUsd(clientId: string): Promise<string | null>;
  /** One `oauth_clients` row with the spend columns (a repeated client id is a constraint error). */
  insertOauthClient(row: OauthClientInsert): Promise<void>;
  /** Set or clear a client's daily cap in dollars; whether the client exists. */
  updateOauthClientBudget(clientId: string, usd: number | null): Promise<boolean>;
  /** The admin page's spend per live agent client: cap, today's ledger sum, open holds, unknown holds and open subagent jobs. */
  readAgentClientSpend(): Promise<AgentClientSpendRow[]>;
  readOauthClient(clientId: string): Promise<OauthClientRow | null>;
  /** Every client's whole row, by name then id in byte order (`gbrain auth clients`). */
  listOauthClients(): Promise<OauthClientRow[]>;
  /** The inspection columns of every client, deleted ones included, newest first, then by byte order of client id (the admin clients list). */
  listAdminClientRows(): Promise<Array<Record<string, unknown>>>;
  patchOauthClient(clientId: string, patch: OauthClientPatch, guard?: OauthClientPatchGuard): Promise<OauthClientPatched | null>;
  /** One `access_tokens` row at grant revision 1; its generated id. A repeated token hash is a constraint error (23505). */
  insertAccessToken(row: AccessTokenInsert): Promise<{ id: string }>;
  /** The tokens not yet revoked whose id or name is `target`, by id (names are not unique, so there may be several). */
  findActiveAccessTokens(target: string): Promise<ActiveAccessTokenRow[]>;
  /** Set or clear one token's read floor by row id. A tier outside the six is a constraint error (23514). */
  setAccessTokenMinTrust(id: string, tier: string | null): Promise<void>;
  /** A live token's `reads_unscoped` and `created_at` (access/requester-scope.ts `credentialScopeFor`), or null when revoked or absent. */
  readLiveAccessTokenScope(id: string): Promise<AccessTokenScopeRow | null>;
  /** One rate-lease bounce appended to the lease-pressure log. */
  insertLeasePressure(row: LeasePressureInsert): Promise<void>;
  /** How many lease bounces match every given field (window in ms, job id, lease key). */
  countLeasePressure(filter?: LeasePressureFilter): Promise<number>;
  /** The bounces of the last `windowMs` ms, newest first, at most `limit`. */
  listRecentLeasePressure(windowMs: number, limit: number): Promise<LeasePressureRow[]>;
  // Group B (subagent transcript and tool ledger; engine-sql/jobs-subagent.ts): the rows the subagent handler, replay, the transcript views and the dream provenance reads use.
  /** The job's subagent messages by `message_idx`; with `last`, only the newest. */
  listSubagentMessages(jobId: number, opts?: { last?: boolean }): Promise<SubagentMessageRow[]>;
  /** How many messages the job has persisted. */
  countSubagentMessages(jobId: number): Promise<number>;
  /** Persist one message (`content_blocks` is JSON text); a message already at the same `message_idx` stays. */
  insertSubagentMessage(jobId: number, message: SubagentMessageInsert): Promise<void>;
  /** The job's tool rows, in replay order (`message_idx`, ordinal with legacy NULL as 0, `id`) or `id` order. */
  listSubagentToolExecutions(jobId: number, order: SubagentToolOrder): Promise<SubagentToolRow[]>;
  /** Whether the job has a tool row of `status` whose `tool_use_id` is `LIKE toolUseIdPrefix || '%'` (a LIKE pattern). */
  hasSubagentToolExecution(jobId: number, opts?: { status?: string; toolUseIdPrefix?: string }): Promise<boolean>;
  /** The job's `brain_put_page` rows' status, error and output by `id`, scoped to a `tool_use_id` LIKE prefix when given. */
  listSubagentWriteOutcomes(jobId: number, toolUseIdPrefix?: string): Promise<SubagentWriteOutcome[]>;
  /** The oneshot ledger: rows whose `tool_use_id` is `LIKE toolUseIdPrefix || '%'`, by `id`, with their input fields as text. */
  listSubagentOneshotLedger(jobId: number, toolUseIdPrefix: string): Promise<SubagentOneshotLedgerRow[]>;
  /** How many rows of `toolName` in `status` the jobs hold and the bytes of their output as jsonb text. */
  summarizeSubagentToolExecutions(jobIds: readonly number[], spec: { toolName: string; status: string }): Promise<{ count: number; output_bytes: number }>;
  /** The distinct slugs the jobs' completed `brain_put_page` calls named, bytewise ascending, null last. */
  listSubagentPutPageSlugs(jobIds: readonly number[]): Promise<Array<string | null>>;
  /** Each completed `brain_put_page` call of the jobs: job, slug and start time, by `id`. */
  listSubagentPutPageWrites(jobIds: readonly number[]): Promise<Array<{ job_id: number; slug: string | null; started_at: Date }>>;
  /** The jobs' completed `brain_put_page` calls whose output state is `committed`, with their job's idempotency key, by `id`. */
  listSubagentRetainedPutPages(jobIds: readonly number[]): Promise<SubagentRetainedPutPage[]>;
  /** A staging child's pages: per slug the last staged `brain_put_page` and its markdown, slugs bytewise ascending. */
  listSubagentStagedPages(jobId: number): Promise<Array<{ slug: string | null; content: string | null }>>;
  /** The jobs' `brain_add_timeline_entry` calls whose request id names a committed, `ok` timeline request of `sourceId`, by `id`. */
  listSubagentTimelineAppendCalls(jobIds: readonly number[], sourceId: string): Promise<Array<{ request_id: string; slug: string; input: unknown }>>;
  /** Bank tool rows at stable ordinals atomically; an occupied position stays. `legacyGuard` also skips a turn's legacy NULL-ordinal row of the same id. */
  recordSubagentToolExecutions(jobId: number, rows: readonly SubagentToolInsert[], opts?: { legacyGuard?: boolean }): Promise<void>;
  /** Record a gateway tool call's first observation (a pending v2 row); the stable id of the row at that position (null for a legacy row). */
  startSubagentToolExecution(jobId: number, row: SubagentToolStart): Promise<string | null>;
  /** Settle a tool row complete (`output` is JSON text); how many rows it settled. */
  completeSubagentToolExecution(target: SubagentToolTarget, output: string): Promise<number>;
  /** Settle a tool row failed, inserting one from `fallback` when the position has none; how many rows it changed. */
  failSubagentToolExecution(target: SubagentToolTarget, error: string, fallback?: SubagentFailureFallback): Promise<number>;

  // Group A (jobs-tables): the Wakeshift report-back tables (engine-sql/jobs-wake.ts).
  /** Record a watch and return its id; a second open watch of the same Wakeshift subscription keeps its row and takes the new expiry. */
  openWakeWatch(watch: JobsWake.WakeWatchInsert): Promise<number>;
  /** One principal's watches, newest first, at most 50: the open ones (and ones updated in the last day), or one target's. */
  listWakeWatches(filter: JobsWake.WakeWatchFilter): Promise<JobsWake.WakeWatchRow[]>;
  /** End open watches for a reason (disabled, expired, or one unwatched id); the rows that ended. */
  endWakeWatches(spec: JobsWake.EndWakeWatches): Promise<JobsWake.EndedWakeWatch[]>;
  /** Every watch counted by state and last error. */
  countWakeWatches(): Promise<Array<{ state: string; last_error: string | null; n: number }>>;
  /** The doctor's wakeshift reads: 7-day watch counts, unregistered cron runs, stale and dead forgets. */
  readWakeDoctor(): Promise<JobsWake.WakeDoctorRead>;
  /** Wakeshift forgets still waiting to be sent. */
  countPendingWakeForgets(): Promise<number>;
  /** The registered crons by name with each one's last reported run. */
  listWakeCrons(): Promise<JobsWake.WakeCronRow[]>;
  /** Register a cron name. */
  addWakeCron(name: string): Promise<void>;
  /** Unregister a cron name and end the open watches on it; the watches that ended. */
  removeWakeCron(name: string): Promise<JobsWake.EndedWakeWatch[]>;
  /** Whether a cron name is registered. */
  hasWakeCron(name: string): Promise<boolean>;
  /** Record one cron run, drop that cron's runs older than 30 days, and say whether the name is registered. */
  recordWakeCronRun(run: { name: string; status: string; finishedAt: string | null }): Promise<{ registered: boolean }>;
  /** Whether a principal key accepted a terms version. */
  hasWakeTermsAcceptance(principalKey: string, termsVersion: string): Promise<boolean>;
  /** Record a terms acceptance (one already recorded stays). */
  recordWakeTermsAcceptance(principalKey: string, termsVersion: string): Promise<void>;
  /** The open, due, unleased watches whose target settled (at most 20), each with the job, write request or cron run it watches. */
  listDueWakeWatches(spec?: { ids?: readonly number[] }): Promise<JobsWake.WakeRow[]>;
  /** Lease one due watch; its lease token and attempts, or null when it is not due or leased. */
  claimWakeWatch(id: number, leaseSeconds: number): Promise<{ lease: string; attempts: number } | null>;
  /** Settle a leased watch; false when it was ended or re-leased meanwhile. */
  settleWakeWatch(settle: JobsWake.WakeWatchSettle): Promise<boolean>;
  /** Queue a Wakeshift forget of a user (once while one is pending); with a member id, only when that member is not removed. */
  queueWakeForget(wakeUser: string, memberId: string | null): Promise<void>;
  /** A removed member's Wakeshift state: queue a forget of each user it watched under, end its open watches, drop its terms acceptances. */
  forgetWakeMember(memberId: string): Promise<{ ended: number; queued: number }>;
  /** A revoked token's or deleted OAuth client's Wakeshift state: queue a forget of each user its member-less watches ran under, end its open watches, drop its terms acceptances. */
  forgetWakeCredential(kind: JobsWake.WakeCredentialKind, id: string): Promise<{ ended: number; queued: number }>;
  /** Lease up to `limit` due pending forgets. */
  claimWakeForgets(spec: { leaseSeconds: number; limit: number }): Promise<JobsWake.WakeForgetClaim[]>;
  /** Settle a leased forget; false when its lease no longer matches. */
  settleWakeForget(settle: JobsWake.WakeForgetSettle): Promise<boolean>;
}
