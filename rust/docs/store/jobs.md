# The brain store: Minion jobs and cycle locks

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The `minion_jobs` lifecycle the queue (`src/core/minions/queue.ts`) reaches through typed engine members,
the `minion_inbox` rows those members post, and the `gbrain_cycle_locks` leases. The SQL engines run the
statements in `src/core/engine-sql/jobs.ts` and `cycle-locks.ts`; this store runs the same rules on its own
records. Timestamps cross the binding as ISO strings; the TypeScript members
(`src/core/rust-engine/store-members/jobs.ts`) turn them into `Date`s, as PGLite returns them.

Keys, under the family tag `keys::JOBS` (`m`):

| Key | Holds |
| --- | --- |
| `m 0x00 <name>` | the id sequences `job` (`minion_jobs.id`) and `inbox` (`minion_inbox.id`); a refused write takes no id |
| `m 0x01 <id>` | one job row, every `minion_jobs` column |
| `m 0x02 <queue> 0x00 <priority> <created_at> <id>` | the claim index: `waiting` rows only, in claim order |
| `m 0x03 <parent> <id>` | the children of a parent |
| `m 0x04 <idempotency_key>` | the id holding a key (the partial unique index) |
| `m 0x05 <job id> <inbox id>` | the inbox rows of a job |
| `m 0x06 <status> 0x00 <id>` | every row by status (the stall sweep, quota and cap counts) |
| `m 0x07 <lock_id>` | one cycle lock lease |

Integers are big-endian, signed ones with the sign bit flipped. Every call reads the store clock once, as one
Postgres transaction reads one `now()`. A millisecond duration becomes `round(ms * 1000)` microseconds. The one
write transaction is the lock: two claims never see the same `waiting` row (`FOR UPDATE SKIP LOCKED` on the
SQL engines), and the admission checks and their insert cannot interleave (the advisory locks on the SQL
engines). Deleting a job removes its inbox rows and sets its children's `parent_job_id` to null, as the foreign
keys do.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.admitJob({ insert, paramCoalesce?, quotaMaxWaiting?, backpressure?, maxSpawnDepth })` | `{ outcome, row, audit }`. In order: the idempotency key (same authority: a live row is `coalesced`, a `dead`/`cancelled` one has its key moved into `data.__released_idempotency_key` and the insert goes on); the identical waiting payload (`data.__param_hash`, newest first, within `maxAgeHours`); the name quota; the pending and waiting caps; the parent checks; the insert and the parent flip to `waiting-children`. A row held under another authority is `conflict` and nothing is written. `admission_refused` (`queue_quota_exceeded:<name>:<waiting>:<max>`) at the quota, `invalid_state` for a parent refusal (message as PGLite's), `constraint_violation` for a `minion_jobs` CHECK, `invalid_argument` for a null authority or a private-queue owner | `admitJob` |
| `brain.getJob(id)` | the row, or null | `getJob` |
| `brain.listJobs({ status?, queue?, name?, ownerClientId?, limit?, offset? }?)` | rows matching every non-empty filter, `created_at DESC, id DESC`, 50 from 0 by default | `listJobs` |
| `brain.claimNextJob(spec)` | the claimed row, or null: the first `waiting` row of `names` in `queue` with an authority, not in `excludeNames`, not marked with `suspectMark` when `excludeWatchdogSuspects`. Stamps the lease (row, then handler map, clamped to 5 s..1 h; else the worker's), the timeout, `claim_generation`, `spend_claim_token`, `attempts_started`, `started_at` and the `legacy_default` spend record of a consent-gated producer | `claimNextJob` |
| `brain.renewJobLease(id, token, ms)` | true when an `active` row this token holds got a new lease | `renewJobLease` |
| `brain.completeJob(id, token, result?)` | the completed row (before a `remove_on_complete` delete), or null for a stale token. Rolls token counts up to a live parent, posts `child_done`, wakes a `waiting-children` parent with no open child | `completeJob` |
| `brain.failJob(id, token, errorText, status, backoffMs?, result?)` | the row (before a `remove_on_fail` delete), or null. `delayed` retries after `backoffMs`; `failed`/`dead` post `child_done` and apply `on_child_fail` (`fail_parent` fails a `waiting-children` parent; `remove_dep` detaches the child; then the parent wakes when its children are done) | `failJob` |
| `brain.reclaimStalledJobs(graceMs, suspectMark)` | `{ requeued, dead }` in id order. Drops drain-lease holder rows (`gbrain-drain-lease`) whose lease and cycle lock are gone; requeues a dead multi-claim worker's expired co-runners marked with `suspectMark` and no stall counted; requeues the rest with one stall counted, or kills them at `max_stalled` (notifying and waking their parents) | `reclaimStalledJobs` |
| `brain.acquireCycleLock(id, opts)` / `refreshCycleLock` / `releaseCycleLock` / `deleteCycleLockIfStale` / `readCycleLocks(filter)` | as the SQL engines (`cycle-locks.ts`); `deleteCycleLock` is the release statement | the cycle lock members |
| `brain.assertCycleLease(id, token)` | true when the lease is held under `token` and unexpired. A read: `FOR KEY SHARE` has nothing to wait for in one write transaction | `assertCycleLease` |

The `minion_queue` capability is partial until jobs slice 2. `servedCapabilities()` reports it because the
members above serve, but the queue still reaches other `minion_jobs` statements through `executeRaw`, which the
Rust engine refuses. Four options are refused by the TypeScript members before the store is called
(`engine_capability_missing`, capability `minion_queue`):

1. `admitJob` with a delegated client's `lock` or `checkCapacity` policy.
2. `admitJob` for a job without submission authority.
3. `admitJob` for a job that sets a private-queue owner (`private_queue_owner_job_id`, `_token` or `_lease_until`).
4. `claimNextJob` with `suspectWaitMs` (the watchdog-overdue claim order).

Differences from PGLite:

- `listJobs`: PGLite orders by `created_at DESC` alone, so equal stamps come in no fixed order. The store breaks
  ties by `id DESC`.
- The parent check reads the raw `kind` of the parent's authority; the queue's policy parses it first
  (`parseSubmissionAuthority`). They differ only for a malformed non-application authority, which PGLite admits
  under and the store refuses (`Remote jobs cannot have descendants`).
- A `conflict` is decided by the caller's policy: the member calls `policy.decide` on the row with a handle that
  refuses any database use, and refuses if the policy does not throw.
