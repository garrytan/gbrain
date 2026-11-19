# The brain store: Minion jobs and cycle locks

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The doctor's job checks (ten typed reads over the same rows) are in [jobs-checks.md](jobs-checks.md).

The `minion_jobs` lifecycle the queue (`src/core/minions/queue.ts`) reaches through typed engine members,
the `minion_inbox` and `minion_attachments` rows, and the `gbrain_cycle_locks` leases. The SQL engines run the
statements in `src/core/engine-sql/jobs.ts` and `cycle-locks.ts`; this store runs the same rules on its own
records. Timestamps cross the binding as ISO strings; the TypeScript members
(`src/core/rust-engine/store-members/jobs.ts`) turn them into `Date`s, as PGLite returns them.

The queue health reads (the doctor's queue checks, the advisor's stalled jobs and the submit-time probe) are in [jobs-health.md](jobs-health.md).
The status reads (counts, last runs, windows) are in [jobs-status.md](jobs-status.md).
The Wakeshift report-back tables (watches, crons, cron runs, terms, forgets) are in [jobs-wake.md](jobs-wake.md).

Keys, under the family tag `keys::JOBS` (`m`):

| Key | Holds |
| --- | --- |
| `m 0x00 <name>` | the id sequences `job` (`minion_jobs.id`), `inbox` (`minion_inbox.id`) and `attachment` (`minion_attachments.id`); a refused write takes no id |
| `m 0x01 <id>` | one job row, every `minion_jobs` column |
| `m 0x02 <queue> 0x00 <priority> <created_at> <id>` | the claim index: `waiting` rows only, in claim order |
| `m 0x03 <parent> <id>` | the children of a parent |
| `m 0x04 <idempotency_key>` | the id holding a key (the partial unique index) |
| `m 0x05 <job id> <inbox id>` | the inbox rows of a job |
| `m 0x06 <status> 0x00 <id>` | every row by status (the stall sweep, quota and cap counts) |
| `m 0x07 <lock_id>` | one cycle lock lease |
| `m 0x08 <job id> <attachment id>` | the attachments of a job, with their base64 bytes. `(job_id, filename)` is unique (a scan of the job's rows) |
| `m 0x09 <owner id> <job id>` | the rows whose `private_queue_owner_job_id` is that owner, so deleting an owner finds them without a scan |

The `dream_synthesis_completions` archive (`rust/crates/gbrain-store/src/jobs/synthesis_completions.rs`) has its own tag,
`keys::DREAM_SYNTHESIS_COMPLETION` (`f`):

| Key | Holds |
| --- | --- |
| `a <source_id> 0x00 <idempotency_key>` | `{ completed_at }` (microseconds): one archive row, keyed by the table's primary key `(source_id, idempotency_key)`. Neither part holds `0x00`, so a scan of `a <source_id> 0x00 <prefix>` is `idempotency_key LIKE '<prefix>%'` |

Integers are big-endian, signed ones with the sign bit flipped. Every call reads the store clock once, as one
Postgres transaction reads one `now()`. A millisecond duration becomes `round(ms * 1000)` microseconds. The one
write transaction is the lock: two claims never see the same `waiting` row (`FOR UPDATE SKIP LOCKED` on the
SQL engines), and the admission checks and their insert cannot interleave (the advisory locks on the SQL
engines). Deleting a job removes its inbox rows and attachments, sets its children's `parent_job_id` to null and sets
the `private_queue_owner_job_id` of the rows it owned to null (leaving their `updated_at` alone), as the
foreign keys do.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.admitJob({ insert, paramCoalesce?, quotaMaxWaiting?, backpressure?, maxSpawnDepth })` | `{ outcome, row, audit }`. In order: the idempotency key (same authority: a live row is `coalesced`, a `dead`/`cancelled` one has its key moved into `data.__released_idempotency_key` and the insert goes on); the identical waiting payload (`data.__param_hash`, newest first, within `maxAgeHours`); the name quota; the pending and waiting caps; the parent checks; the insert and the parent flip to `waiting-children`. A row held under another authority is `conflict` and nothing is written. `admission_refused` (`queue_quota_exceeded:<name>:<waiting>:<max>`) at the quota, `invalid_state` for a parent refusal (message as PGLite's), `constraint_violation` for a `minion_jobs` CHECK or a private-queue owner that is not a job. An insert without an authority is `constraint_violation` with the `minion_queue_protocol` trigger's message (`Minion queue protocol 1 required: …`), as on the SQL engines; an existing row without one (only a pre-protocol SQL row has none) is `released` when `dead`/`cancelled`, `coalesced` when `completed`/`failed` and the caller is an `application`, else `conflict`. The private-queue owner, token and lease (ISO) are stored as given | `admitJob` |
| `brain.getJob(id)` | the row, or null | `getJob` |
| `brain.listJobs({ status?, queue?, name?, ownerClientId?, limit?, offset? }?)` | rows matching every non-empty filter, `created_at DESC, id DESC`, 50 from 0 by default | `listJobs` |
| `brain.claimNextJob(spec)` | the claimed row, or null: the first `waiting` row of `names` in `queue` with an authority, not in `excludeNames`, not marked with `suspectMark` when `excludeWatchdogSuspects`. With `suspectWaitMs` a row marked and untouched for that long is overdue: it leads the claim order (unless in `excludeNames`), and with `excludeWatchdogSuspects` any overdue eligible row makes the claim return null. Either option without `suspectMark` is `invalid_argument`. Stamps the lease (row, then handler map, clamped to 5 s..1 h; else the worker's), the timeout, `claim_generation`, `spend_claim_token`, `attempts_started`, `started_at` and the `legacy_default` spend record of a consent-gated producer | `claimNextJob` |
| `brain.renewJobLease(id, token, ms)` | true when an `active` row this token holds got a new lease | `renewJobLease` |
| `brain.completeJob(id, token, result?)` | the completed row (before a `remove_on_complete` delete), or null for a stale token. Rolls token counts up to a live parent, posts `child_done`, wakes a `waiting-children` parent with no open child | `completeJob` |
| `brain.failJob(id, token, errorText, status, backoffMs?, result?)` | the row (before a `remove_on_fail` delete), or null. `delayed` retries after `backoffMs`; `failed`/`dead` post `child_done` and apply `on_child_fail` (`fail_parent` fails a `waiting-children` parent; `remove_dep` detaches the child; then the parent wakes when its children are done) | `failJob` |
| `brain.reclaimStalledJobs(graceMs, suspectMark)` | `{ requeued, dead }` in id order. Drops drain-lease holder rows (`gbrain-drain-lease`) whose lease and cycle lock are gone; requeues a dead multi-claim worker's expired co-runners marked with `suspectMark` and no stall counted; requeues the rest with one stall counted, or kills them at `max_stalled` (notifying and waking their parents) | `reclaimStalledJobs` |
| `brain.acquireCycleLock(id, opts)` / `refreshCycleLock` / `releaseCycleLock` / `deleteCycleLockIfStale` / `readCycleLocks(filter)` | as the SQL engines (`cycle-locks.ts`); `deleteCycleLock` is the release statement | the cycle lock members |
| `brain.assertCycleLease(id, token)` | true when the lease is held under `token` and unexpired. A read: `FOR KEY SHARE` has nothing to wait for in one write transaction | `assertCycleLease` |

Jobs slice 2 members. Each is one write transaction (or one read) and resolves what the `queue.ts` statement
at the line cited in the TypeScript member returns. A row is a job row as above; "rows" are in id order unless
said.

| JS | Resolves |
| --- | --- |
| `brain.deleteTerminalJob(id)` | true when a `completed`/`failed`/`dead`/`cancelled` row was deleted with its cascade |
| `brain.pauseJob(id)` / `resumeJob(id)` | the row, or null: `waiting`/`active`/`delayed` to `paused` (lock dropped); `paused` to `waiting` |
| `brain.failParentJob(parentId, errorText)` / `resolveParentJob(parentId)` | the row, or null: a `waiting-children` parent to `failed` with the text; or to `waiting` when it has no live child |
| `brain.resolveStrandedParents()` | how many `waiting-children` rows with no live child went back to `waiting` |
| `brain.detachChildJob(childId)` | null; parent cleared, `updated_at` moves, no status guard |
| `brain.updateJobProgress(id, token, progress)` / `addJobTokens(id, token, { input, output, cache_read })` | true when the `active` row this token holds was updated (a JSON null progress is SQL NULL) |
| `brain.delayActiveJob(id, token, { errorText, delayMs, appendStack, clearTimeout })` | the `delayed` row, or null: `delay_until = now + delayMs`, `started_at` and the lock cleared, the stack optionally appended, `timeout_at` optionally cleared |
| `brain.releaseWatchdogClaim(id, token, errorText, mark)` / `markJobWatchdogSuspect(id, mark)` | true/null; the first returns an `active` co-runner to `waiting` with the mark appended once; the second appends the mark once on any row and leaves `updated_at` alone |
| `brain.retryJobUpdate(id)` | the row, or null: a `failed`/`dead` row back to a fresh `waiting` row |
| `brain.promoteDelayedJobs()` | the `delayed` rows whose `delay_until` has passed, now `waiting` |
| `brain.cancelJobs(ids, { reason, rootStatuses, ownerClientId, ownerActor })` | the cancelled rows. Roots are the existing `ids` matching `rootStatuses` and the owner fence (`data.__owner_client_id` and the actor match below); descendants follow `parent_job_id` to depth 100; only live rows change. The reason goes on the roots in `ids` only. Live parents get a `child_done` (`outcome` and `error` `cancelled`) and wake when no child is left |
| `brain.killTimedOutJobs()` / `killWallClockJobs(lockDurationMs)` | the rows set `dead` for `timeout_at` (`timeout exceeded`) or the wall-clock bound (`wall-clock timeout exceeded`); `gbrain-drain-lease` is exempt; parents get `child_done` (`outcome` `timeout`) and wake |
| `brain.pruneJobs({ statuses, olderThan, dryRun })` | `{ count }`. `dryRun` counts. Otherwise, in one write transaction, each match that is a completed `subagent` whose key starts `dream:synth` goes into the archive as `(COALESCE(NULLIF(data->>'source_id', ''), 'default'), key, COALESCE(finished_at, now()))` when that key is not there yet (`ON CONFLICT DO NOTHING`), and every match is deleted with its cascade |
| `brain.listSynthesisCompletionKeys(sourceId, keyPrefix)` | the keys starting `keyPrefix` of the source's completed `subagent` rows and of its archive rows, each once (`UNION`), in byte order (the SQL engines give no order; parity compares them sorted) |
| `brain.listRecentSynthesisCompletions(sourceId, hours)` | `[{ idempotency_key, at }]` (`at` ISO) for the source's `dream:synth-v2:` completions after `now() - hours`: completed `subagent` rows by `finished_at` in id order, then archive rows by `completed_at` in key order, every row kept (`UNION ALL`) |
| `brain.postInboxMessage(jobId, sender, payload)` / `readJobInbox(jobId, token)` / `readChildCompletions(parentId, token, since?)` | the inbox row; the unread rows marked read (only for an `active` job under the token); the `child_done` payloads sent after `since`, by `sent_at`. A missing job or a null payload is `constraint_violation` |
| `brain.listOpenJobIdsInQueue(queue)` / `renewPrivateQueueLease(queue, ownerToken, leaseMs)` / `listOwnedPrivateQueues(prefix, maxQueues)` / `readPrivateQueueState(queue)` | the live ids; the rows renewed (a lease only ever grows); queue names with owner metadata, oldest first; the recovery classifier's counts (`active_healthy`, `owner_ids`, `metadata_rows`, `live_owner_rows`, `nonterminal_owner_rows`, `max_lease_until`, `future_lease_rows`, `recently_touched`) |
| `brain.listStaleWaitingJobIds(name, hours, limit)` / `countTtlExpiredWaiting(name, hours)` | ids, oldest `updated_at` first; a count |
| `brain.readJobStats(since, queue)` / `readQueueFamilyStats(since, prefix)` | `{ by_status, types, drained, depth, stalled, wedge }`; one row per queue family, by family name |
| `brain.hasOverdueWatchdogSuspect({ queue, names, mark, waitMs })` | true when a `waiting` row with an authority is marked and untouched for `waitMs` |
| `brain.listUnreviewedJobs()` / `getFailedJobForRetry(id)` | `{ id, submission_authority }` of live rows whose authority is not exactly the application one (NULL included); `{ name, data }` of a `failed`/`dead` row |
| `brain.readJobSourceState(sourceId)` | `{ archived, created_at }` (`created_at` ISO) of the source an agent job was accepted against, or null for an unknown id; the job authority check (`assertCurrentAgent`) denies the job when the source is gone, archived or created again after acceptance |
| `brain.countOpenJobsByOwner(clientId)` | how many `subagent` rows in a non-terminal status (`waiting`, `active`, `delayed`, `waiting-children`, `paused`), in any queue, have `data->>'__owner_client_id'` equal to `clientId` (a number owner matches its text; a null owner matches nothing) |
| `brain.readJobInsight(spec)` | the six reads behind `describeJobs`: submitter, queue position, slot holders, live children, live leases with their beacon, foreign-owner tokens; see [jobs-insight.md](jobs-insight.md) |
| `brain.readJobSpendTree(spec)`, `insertSpendReservation`, `expireSpendReservations`, `settleSpendReservation`, `markSpendUsageUnknown`, `insertLeasePressure`, `countLeasePressure`, `listRecentLeasePressure` | the spend reservations and the lease-pressure log; see [jobs-spend.md](jobs-spend.md) |
| `brain.listSubagentMessages(jobId, opts)` and 16 more members | the subagent transcript and tool ledger: messages, the tool rows and their stable ids, the write-outcome and dream provenance reads; see [jobs-subagent.md](jobs-subagent.md) |
| `brain.listJobPage({ status?, queue?, name?, ownerClientId?, ownerActor?, limit, cursor })` | rows with `created_us`, newest first by `(created_at, id)`, after the `{ micros, id }` cursor |
| `brain.listJobAttachmentNames(jobId)` / `insertJobAttachment(jobId, input)` / `listJobAttachments(jobId)` / `getJobAttachment(jobId, filename)` / `deleteJobAttachment(jobId, filename)` | names (null for a missing job); the metadata; metadata by `(created_at, id)`; metadata plus `content_b64`, or null; whether a row went. A missing job, a negative size or a repeated filename (`uniq_minion_attachments_job_filename`) is `constraint_violation` |

The actor match of `cancelJobs` and `listJobPage` is `jobActorSql`: the `grant.actor` values `system`,
`external_id`, `member` as text (missing or null is `''`), and the audience, which is `grant.actingFor`'s
distinct elements sorted and joined with `,` when it is an array (`''` when empty), `!` for any other
value, and `''` when missing. A NULL authority or no grant matches the four `''`.

Delegated client admission (`admitJob` with a `lock` or `checkCapacity` policy, and `retryJob` of a delegated
job) runs the TypeScript policy on a narrow handle (`src/core/rust-engine/delegated-policy-handle.ts`): the job
reads, `countOpenJobsByOwner` and `readJobSourceState` come from the store. The store keeps no `oauth_clients` table, so the handle's
`lockOAuthClient` locks nothing and the policy's next step, the client's grant read, refuses
(`engine_capability_missing`, capability `minion_queue`) before anything is written.

`MinionQueue.retryJob` runs the job authority check first. An application job needs no read. An agent job
(`remote_agent`) reads its source with `readJobSourceState`, so a source that is gone, archived or created again
is denied on the store as on PGLite; a current source goes on to the owner's `oauth_clients` read, which refuses.
The archived-source branch is pinned by cargo only (`job_source_state_reads_archived_and_the_creation_stamp` in
`tests/jobs_slice2.rs`). The parity suite cannot reach it: no member the Rust engine serves archives a source, so
a mutant that always reads `archived` as false passes parity and fails cargo.
A generic remote job (`remote_generic`) reads its principal first (`SELECT client_id, deleted_at, scope, source_id,
bound_slug_prefixes, surface, allowed_operations FROM oauth_clients WHERE client_id = $1`, or `SELECT * FROM
access_tokens WHERE id = $1` for a legacy token), so its retry refuses at that read until the grants family is in
the store. A policy that got past the
lock would still refuse before the write: the lock, the capacity count and the write are separate store calls, so
they are not one admission. `lockOAuthClient` called directly is not served and refuses the same way.

Differences from PGLite:

- `listJobs`: PGLite orders by `created_at DESC` alone, so equal stamps come in no fixed order. The store breaks
  ties by `id DESC`.
- The parent check reads the raw `kind` of the parent's authority; the queue's policy parses it first
  (`parseSubmissionAuthority`). They differ only for a malformed non-application authority, which PGLite admits
  under and the store refuses (`Remote jobs cannot have descendants`).
- A `conflict` is decided by the caller's policy: the member calls `policy.decide` on the row with a handle that
  refuses any database use, and refuses if the policy does not throw.
- `legacy_authority_is_null` is not added to the row; the TypeScript side derives it from
  `submission_authority === null`. A JSON `null` authority on an insert is refused, as the column only holds NULL
  (pre-protocol rows) or an object.
- `readPrivateQueueState.max_lease_until` is ISO; PostgreSQL's `::text` form differs. `readJobStats.wedge.last_completed`
  keeps the PostgreSQL timestamptz text form.
- Orderings PostgreSQL leaves open (the arrays of `readJobStats`) are in no promised order; the TypeScript side sorts them.
- An owner job, a job for an attachment or an inbox message that does not exist is `constraint_violation`, as the
  foreign keys; `admitJob` checks the private-queue owner the same way.
