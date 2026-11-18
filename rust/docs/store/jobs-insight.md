# The brain store: the reads behind `describeJobs`

Part of the Minion jobs family ([jobs.md](jobs.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

`describeJobs` (`src/core/minions/job-insight.ts`) answers `jobs list` and `jobs get` with why a job waits, who submitted it
and whether it is stalled. It reads six things for a batch of jobs; the store serves them as one member, so the TypeScript
side makes one call and keeps its own logic (the wording, the owner fence, the lock names).

| Member | Returns |
| --- | --- |
| `brain.readJobInsight({ jobIds, waitingIds, waitingQueues, parentIds, lockIds, holderQueue, holderLimit, owner })` | `{ meta, ahead, holders, children, locks, foreign_tokens }` |

Each part, and the rule it keeps from the SQL in `src/core/engine-sql/jobs-insight.ts`:

- `meta`: `{ id, submitter, parent_owner }` for each `jobIds` row that exists, by id. `submitter` is `data.__submitter`
  only when the authority kind is `application`; `parent_owner` is the parent's `data.__owner_client_id`.
- `ahead` (when `waitingIds` is not empty): `{ id, ahead }`, the number of `waiting` rows of the job's queue ordered
  before it by `(priority, created_at, id)`. The claim index holds exactly the `waiting` rows in that order, so the count is
  the keys before the job's own key; a job that is not waiting is counted the same way.
- `holders` (when `waitingIds` is not empty): `{ id, name, queue, owner }` of `active` rows in `waitingQueues`, never
  in `holderQueue` (the drain-lease records), oldest `started_at` first (none last), then id, cut at `holderLimit`.
- `children` (when `parentIds` is not empty): `{ id, parent_job_id, owner }` of the children whose status is not
  `completed`, `failed`, `dead` or `cancelled`, by id.
- `locks` (when `lockIds` is not empty): the unexpired leases among them, with `holder_pid`, `holder_host`,
  `acquired_at`, `ttl_expires_at`, the `drain_lease_beacon` record of the `holderQueue` row claimed under the lease's token
  (null when there is none), and `holder_owner`, the owner of the job that beacon names when its kind is `job`. A lease with
  several beacon rows comes back once per row, by beacon id. The beacon rows are found by a scan of the job rows, and only
  when a live lease exists.
- `foreign_tokens` (when `owner` is set): per `jobIds` row, `{ parent_job_id, i, o, c }`, the summed
  `tokens_input`, `tokens_output` and `tokens_cache_read` of its `completed` children whose owner is not `owner`. A child with
  no owner counts as another owner. Parents with no such child are absent.

Differences from PGLite and PostgreSQL:

- The database clock `describeJobs` compares against comes from `readDatabaseClock()` (`clock_timestamp()`), not
  `now()`: the two differ only by the time one statement takes.
- The spend tree (`mcp_spend_reservations`) is a separate member, `readJobSpendTree` ([jobs-spend.md](jobs-spend.md)); with
  it `describeJobs` makes no raw SQL call on a Rust brain.
- Timestamps are ISO strings across the binding; the TypeScript member turns the two lease times into `Date`s.
