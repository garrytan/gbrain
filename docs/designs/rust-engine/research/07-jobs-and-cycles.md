# 07 Jobs, Minions queue, autopilot, and cycle phases

Line numbers refer to gbrain 36bd05806a.

Reference: `garrytan/gbrain` at commit `36bd05806a` (v0.60.733.0), read-only.
Method: source reading only. I did not run the TypeScript code or its tests. Statements
without an "(inferred)" tag were checked against the cited code. Line numbers are
approximate to within a few lines where a function spans a block.

## 1. Summary

- The Minions queue is one Postgres table, `minion_jobs`, with a single claim statement
  (`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
  `src/core/minions/queue.ts:1463-1530`). Every state change after claim is fenced by
  `lock_token`. Retries, stall recovery, timeouts, and parent/child roll-ups are all
  set-based SQL in the same table.
- Postgres features the queue depends on: `FOR UPDATE SKIP LOCKED`, `pg_notify` from a
  row trigger, partial unique indexes, JSONB (`data->>'__param_hash'`), `pg_advisory_xact_lock`
  (admission, quota, rate leases, budget), row locks on parents, and `now()` interval math.
  The cycle lock is deliberately a row table, not an advisory lock (`src/core/db-lock.ts:8`,
  because the cycle lease must outlive any one transaction: a session advisory lock would
  break under PgBouncer transaction pooling, and a transaction-scoped `pg_advisory_xact_lock`
  ends at commit).
- The worker learns about new work from LISTEN/NOTIFY only for `sync` jobs and only on a
  direct (non-pooler) Postgres session. Everywhere else it polls. A general job waits up to
  5 s (`pollInterval` default, `src/core/minions/worker.ts:310`); the sync-wake poll is 1 s.
- Autopilot is a daemon that sleeps 300 s by default, dispatches per-source `sync` jobs and
  a remediation plan on each tick, and supervises a `gbrain jobs work` child process.
- The dream cycle (`runCycle`, `src/core/cycle.ts:1904`) has 32 phases. 14 are paid (chat or
  embedding model calls), 10 are free, 6 need a git checkout, and 2 delete rows or files.
- Of 42 handler names registered in `registerBuiltinHandlers` (`src/commands/jobs.ts:543-700`),
  about 15 spend model money. A minimum useful brain needs only `sync`, `embed` (or
  `embed-backfill`), `extract`, and `backlinks`. All four are deterministic except embedding.

## 2. The queue: `src/core/minions/queue.ts`

### 2.1 Table

`minion_jobs` is at `src/schema.sql:1248-1302`. Key columns: `id SERIAL`, `name`, `queue`
(default `'default'`), `status`, `priority INTEGER` (lower runs first), `submission_authority
JSONB`, `claim_generation BIGINT`, `data JSONB`, retry fields (`max_attempts` default 3,
`attempts_made`, `attempts_started`, `backoff_type` default `exponential`, `backoff_delay`
1000 ms, `backoff_jitter` 0.2), stall fields (`stalled_counter`, `max_stalled` default **5**,
`lock_token`, `lock_until`), `delay_until`, `parent_job_id`, `on_child_fail`, token counters,
`depth`, `max_children`, `timeout_ms`, `timeout_at`, `lock_duration_ms`, `idempotency_key`,
private-queue owner columns, `result`, `progress`, `error_text`, `stacktrace`, timestamps.

Statuses (CHECK constraint): `waiting`, `active`, `completed`, `failed`, `delayed`, `dead`,
`cancelled`, `waiting-children`, `paused`.

Indexes: claim index `(queue, priority, created_at) WHERE status='waiting'`
(`schema.sql:1304`); `lock_until WHERE status='active'` for stall sweeps; `timeout_at WHERE
active`; `parent_id`; **unique** `uniq_minion_jobs_idempotency ON (idempotency_key) WHERE
idempotency_key IS NOT NULL` (`schema.sql:1311`); a private-queue recovery index.

Other tables: `minion_inbox` (`schema.sql:1324`, `job_id` FK with cascade, `sender`,
`payload JSONB`, `read_at`), `minion_attachments` (`schema.sql:1336`, `content BYTEA` or
`storage_uri`, `sha256`, unique `(job_id, filename)`), plus `subagent_messages`,
`subagent_tool_executions`, `subagent_rate_leases`, `dream_verdicts`, and
`dream_synthesis_completions` (`schema.sql:1403-1485`, `2124`).

### 2.2 Claim (exact shape)

`claim()` (`queue.ts:1463`) first calls `assertNoUnreviewedJobs`. Then it runs one `UPDATE`:

- SET `status='active'`, `claim_generation = claim_generation + 1`, `lock_token = $1`
  (worker-chosen token, the fence), `attempts_started = attempts_started + 1`,
  `started_at = COALESCE(started_at, now())`, `updated_at = now()`.
- `lock_duration_ms` resolves row value, then handler map (`$6`), then the worker default
  (`$2`). Row and map values are clamped to [5000, 3600000] ms; the worker default is not
  clamped. The result is stamped on the row. `lock_until = now() + that duration`.
- `timeout_ms = COALESCE(timeout_ms, handler map)`; `timeout_at = now() + timeout_ms` when
  set.
- WHERE: `queue = $3 AND status = 'waiting' AND submission_authority IS NOT NULL AND
  name = ANY($4)` plus optional watchdog and lane exclusions. The `submission_authority IS NOT
  NULL` predicate means legacy rows without an authority are never claimed until a local
  operator authorizes them.
- ORDER BY `priority ASC, created_at ASC` (an overdue watchdog suspect can jump the queue).
- `FOR UPDATE SKIP LOCKED LIMIT 1`.

Every later write (`completeJob`, `failJob`, `renewLock`, `readInbox`) repeats the fence:
`WHERE status='active' AND lock_token = $token`. A worker that lost its lease cannot write.

Delayed rows are promoted by `promoteDelayed()` (`queue.ts:2153`): `status='delayed' AND
delay_until <= now()` becomes `waiting`. The worker runs it at the top of every loop
(`worker.ts:805-809`).

### 2.3 Leases, renewal, and sweeps

- Renewal: `renewLock` (`queue.ts:2096`) sets `lock_until = now() + ms` where
  `lock_token` and `status='active'` match. The tick interval is `min(lockDuration/2, 60 s)`;
  each call is capped at `min(lockDuration/3, 15 s)`; the safety margin is
  `min(lockDuration/6, 30 s)` (`src/core/minions/lock-renewal-tick.ts:168-186`). A failed
  renewal is verified before the job is evicted.
- Stall sweep: `handleStalled` (`queue.ts:2166`) selects `status='active' AND lock_until <
  now() - grace`. The grace is `GBRAIN_MINION_STALL_RECLAIM_GRACE_MS`, default 15 s
  (`queue.ts:91`). If `stalled_counter + 1 < max_stalled` the row goes back to `waiting`. Otherwise
  it goes to `dead` with `error_text='max stalled count exceeded'`. Parents are locked first,
  sorted. A `SKIP LOCKED` subselect protects the update.
- Timeouts: `handleTimeouts` (`queue.ts:1547`) marks `timeout_at < now()` active rows `dead` and
  counts the attempt. `handleWallClockTimeouts` (`queue.ts:1687`) does the same for rows with no
  `timeout_ms`, using `2 * lockDuration * max_stalled`.
- Sweep order per worker tick: `handleStalled`, then `handleTimeouts`, then
  `handleWallClockTimeouts` (`worker.ts:557-602`). The worker's `stalledInterval` default is
  30 s (`worker.ts:308`).
- A lease beacon queue `gbrain-drain-lease` (`protected-names.ts:20`) holds drain-lease records
  and is excluded from all sweeps.

### 2.4 Retries and terminal states

On handler error (`worker.ts:1728-1734`): if the error is unrecoverable or
`attempts_made + 1 >= max_attempts`, the job goes `dead`. Otherwise it goes `delayed`.
`failJob` (`queue.ts:1853`) increments `attempts_made` and sets `delay_until` for `delayed`.
Backoff (`src/core/minions/backoff.ts:8-25`): `exponential` is `2^(attempts_made-1) * delay`,
`fixed` is `delay`, with ±`jitter` multiplicative noise.

Completion (`completeJob`, `queue.ts:1745`): status `completed`, `result` stored, and if
`parent_job_id` is set, the parent gets a token roll-up and a `child_done` inbox row
(sender `minions`, `outcome='complete'`). Failure also writes `child_done` with
`outcome='failed'` or `'dead'` before the parent update (`failJob`, `queue.ts:1853`).

`on_child_fail` on the child decides what the parent does: `fail_parent`, `remove_dep`,
`ignore`, or `continue`.

`retryJob` (`queue.ts:1227`), `cancelJob` (`queue.ts:782`), `pauseJob` (`queue.ts:2298`),
and `prune` (`queue.ts:1247`) are the operator actions.

### 2.5 Parent and child jobs

- Submitting with `parent_job_id` locks the parent `FOR UPDATE` (comment at `queue.ts:219`)
  and enforces `max_children`. The child inserts as `waiting` (or `delayed`). The parent moves
  to `waiting-children`.
- `maxSpawnDepth` defaults to 5 (`queue.ts:65`).
- Aggregator pattern: when every child is terminal, `waiting-children` flips back to `waiting`.
  The `subagent_aggregator` job then reads its `child_done` inbox rows
  (`handlers/subagent-aggregator.ts` header).

### 2.6 Inbox and attachments

- `sendMessage` (`queue.ts:2325`) inserts into `minion_inbox`. `readInbox` (`queue.ts:2346`)
  requires `lock_token` match and `status='active'`, then sets `read_at`.
- `addAttachment` (`queue.ts:2455`) stores bytes or a URI with a sha256. Default cap
  5 MiB (`queue.ts:131`). Unique per `(job_id, filename)`.

### 2.7 Idempotency

- `add()` (`queue.ts:227`) fast path: `SELECT ... WHERE idempotency_key = $1` returns the existing
  row (flagged `coalesced: true`).
- Dead or cancelled rows release their key: the key is set to NULL and the old value is kept in
  `data.__released_idempotency_key` (`src/core/minions/idempotency-coalesce.ts:37-47`). A
  fresh insert then proceeds.
- Insert: `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`
  (`queue.ts:623`). A zero-row result is resolved by re-reading the winner.
- Autopilot keys include the wall-clock slot (for example `autopilot-sync:<source>:<slot>`), so a
  slow cycle cannot stack duplicates.

### 2.8 Admission and quota (advisory locks)

Order inside `add()`, in one transaction:

1. Idempotency fast path (above).
2. Param-coalescing (only when enabled per name, `admission.ts:45`, default only `subagent`).
   Takes `pg_advisory_xact_lock(hashtext('minion_admission:'||name||':'||queue||':'||paramHash))`
   (`queue.ts:385`), then returns the newest matching `waiting`, parentless row inside a TTL/2
   window.
3. Name-global quota (config only, no default): `pg_advisory_xact_lock(hashtext('minion_quota:'||name))`
   (`queue.ts:431`), then count of `waiting` rows for that name across all queues. Over the cap
   throws `QueueQuotaExceededError`.
4. `maxWaiting` / `maxPending`: `pg_advisory_xact_lock(hashtext('minion_maxwaiting:'||name||':'||queue||':'||source))`
   (`queue.ts:488`). Source scope is exact for `maxPending`.
5. Insert with `ON CONFLICT` as above.

Default waiting TTL: `subagent` 48 h (`admission.ts:50-52`). Expired waiting rows are cancelled with
an auditable error text.

Other advisory or row locks in the TS code: budget reservations `pg_advisory_xact_lock` on a
hashed client id (`budget-meter.ts:99`, `255`, reservation TTL 10 min at `:28`); provider
rate leases `pg_advisory_xact_lock($1::bigint)` (`rate-leases.ts:81`, lease TTL 120 s at
`rate-leases.ts:54`); `SELECT ... FOR UPDATE` on `oauth_clients` (`delegated-admission.ts:40`).

### 2.9 Wake and poll

- Trigger `minion_job_notify`: `AFTER INSERT OR UPDATE OF status`, calls
  `pg_notify('minion_jobs', json{id,status,name,queue,prev_status})` (`schema.sql:1812-1826`).
  It fires on every status change, not only `waiting`.
- `src/core/minions/sync-queue-wake.ts` LISTENs only when the connection is a direct session
  (`chooseSyncQueueWake`, lines 37-47). It verifies with a probe NOTIFY within 3 s, else falls
  back. A payload wakes the loop only if `name='sync' AND status='waiting' AND queue=<worker queue>`
  (`isSyncWakePayload`, `sync-queue-wake.ts:56`).
- Fallback poll: 1 s by default (`GBRAIN_WORKER_SYNC_WAKE_POLL_MS`, clamped to 250 ms-5 s), a
  single indexed read for a waiting `sync` job (`sync-queue-wake.ts:24`, `:52`).
- General idle wait: `IdleWaiter` (`idle-wait.ts`) waits `pollInterval` (default 5000 ms,
  `worker.ts:310`; `jobs work` does not override it, `commands/jobs/work.ts:200`). A
  `wake()` call ends the wait early.
- Off on PGLite and when `GBRAIN_WORKER_SYNC_WAKE=0`. PGLite drains in the foreground instead
  (`drainPgliteQueue`, `commands/jobs/work.ts:355`, 200 ms poll).

## 3. Worker and supervisors

- `MinionWorker` (`src/core/minions/worker.ts`, 1,792 lines). `start()` at `:506`; claim loop
  at `:805`. Concurrency comes from `--concurrency` or `GBRAIN_WORKER_CONCURRENCY`, default 1
  (`commands/jobs/shared.ts:91-92`).
- Long-job lane (`lanes.ts`): default long names are `autopilot-cycle`,
  `autopilot-global-maintenance`, `embed-backfill`, `connector-sync`, `extract`, `doctor-refresh`.
  With concurrency ≥2, one slot is kept for short jobs by default
  (`minions.short_job_reserved_slots`).
- Job isolation: `jobIsolation: 'process'` runs each job in a SIGKILL-able child
  (`job-isolation.ts`, kill grace 25 s). RSS watchdog and `maxRssMb` trigger graceful exit.
- `ChildWorkerSupervisor` (`child-worker-supervisor.ts`, 845 lines) spawns `gbrain jobs work`.
  Crash backoff is `min(1000·2^n, 60000) ms` plus 10% jitter (`supervisor.ts:245-249`).
  Startup readiness timeout is 120 s (`WORKER_STARTUP_READY_TIMEOUT_MS`).
- `MinionSupervisor` (`supervisor.ts`, 1,497 lines) is the standalone `gbrain jobs supervisor`.
  It owns a PID lock, watches queue health, and restarts the child.

## 4. Handlers

### 4.1 Registration and protection

`registerBuiltinHandlers` (`src/commands/jobs.ts:543-700`) registers **42 distinct names**.
Some go through the `cycle-phase` wrapper (`handlers/cycle-phase.ts`), which calls
`runCycle` for a single phase.

Protected names (`src/core/minions/protected-names.ts`, 13 entries): `shell`, `subagent`,
`subagent_aggregator`, `synthesize`, `patterns`, `consolidate`, `edge_contradictions`,
`standing_questions`, `contextual_reindex_per_chunk`, `extract-takes-from-pages`, `unify-types`,
`skillopt`, `extract-atoms-drain`. A protected name needs `allowProtectedSubmit` (CLI or trusted
local caller). MCP and OAuth callers cannot submit them. `consolidate` is protected even
though its phase is deterministic (see Open questions, item 3).

### 4.2 Handler table

"Paid" means a chat or embedding model call. "Free" means no model call, per the phase table
or code reading. Items marked (inferred) come from names and imports, not a full read.

| # | Job name | Source | What it does | Cost |
|---|---|---|---|---|
| 1 | `sync` | `handlers/sync.ts`, `commands/sync.ts` | Git/markdown sync into pages; submits embed-backfill | free |
| 2 | `embed` | `handlers/embed.ts` → `commands/embed.ts` | `runEmbedCore` on stale chunks | paid (embed) |
| 3 | `embed-backfill` | `handlers/embed-backfill.ts` (463 lines) | Per-source embedding, $10 budget per job, per-source lock | paid (embed) |
| 4 | `embed-catch-up` | `handlers/embed-catch-up.ts` | `runEmbedCore` stale plus catch-up, onboarding | paid (embed) |
| 5 | `lint` | `handlers/lint.ts` → `commands/lint.ts` | Lint pages | free |
| 6 | `lint-fix` | `handlers/lint-fix.ts` | Lint with fixes | free |
| 7 | `integrity` | `handlers/integrity.ts` → `commands/integrity.ts` | Integrity check | free (inferred) |
| 8 | `integrity-auto` | `handlers/integrity-auto.ts` | `runIntegrity(['auto'])` | free (inferred) |
| 9 | `sync-retry-failed` | `handlers/sync-retry-failed.ts` | Re-runs sync | free |
| 10 | `import` | `handlers/import.ts` → `commands/import.ts` | Imports files; imports gateway (embeds?) | free (inferred) |
| 11 | `extract` | `handlers/extract.ts` → `commands/extract.ts` | Links and timeline; stale mode chains a continuation | free |
| 12 | `backlinks` | `handlers/backlinks.ts` → `commands/backlinks.ts` | `check` or `fix` back-links | free |
| 13 | `extract-ner` | `handlers/extract-ner.ts` → `core/extract-ner.ts` | Regex NER links | free |
| 14 | `extract-timeline-from-meetings` | `handlers/extract-timeline-from-meetings.ts` | Timeline rows from meeting pages | free (inferred) |
| 15 | `extract-takes-from-pages` | `handlers/extract-takes-from-pages.ts` | LLM takes from pages | paid (chat) |
| 16 | `extract-conversation-facts` | `handlers/extract-conversation-facts.ts` → `commands/extract-conversation-facts.ts` | LLM facts from conversations (`gateway.chat`) | paid (chat) |
| 17 | `extract-atoms-drain` | `handlers/extract-atoms-drain.ts` → `core/cycle/extract-atoms-drain.ts` | Drains atom backlog, Haiku (~$0.30/source) | paid (chat) |
| 18 | `loops_extract` | `handlers/loops-extract.ts` → `core/google/loops-extract.ts` | Open loops from Google sources | paid (chat, inferred) |
| 19 | `chronicle_extract` | `handlers/chronicle-extract.ts` → `core/chronicle/job.ts` | Life Chronicle events | paid (chat) |
| 20 | `facts-absorb` | `handlers/facts-absorb.ts` → `core/facts/backstop.ts` | LLM facts write-path, 10 min budget | paid (chat) |
| 21 | `enrich` | `handlers/enrich.ts` → `commands/enrich.ts` | LLM enrichment of pages | paid (chat) |
| 22 | `contextual_reindex_per_chunk` | `handlers/contextual-reindex-per-chunk.ts` (318 lines) | Haiku synopsis per chunk, then re-embed | paid (chat+embed) |
| 23 | `reindex` | `handlers/reindex.ts` | Re-embed; paid only with a stored spend record | conditional |
| 24 | `repair-jsonb` | `handlers/repair-jsonb.ts` | JSONB repair | free |
| 25 | `orphans` | `handlers/orphans.ts` | Orphan report (`findOrphanPages`) | free |
| 26 | `purge` | `handlers/purge.ts` | Hard-deletes expired pages, sources, checkpoints | deletes |
| 27 | `doctor-refresh` | `commands/doctor/last-known.ts` | Refresh doctor snapshot | free (inferred) |
| 28 | `ingest_capture` | `handlers/ingest-capture.ts` (465 lines) | Ingest event to inbox page via `importFromContent` | free (inferred) |
| 29 | `connector-sync` | `handlers/connector-sync.ts` | Fetch chat-provider history when `auto_sync` is on | free; embed kick-off on PGLite |
| 30 | `shell` | `handlers/shell.ts` (402 lines) | Runs a command as child process; guarded unless `--allow-shell-jobs` | free, protected |
| 31 | `subagent` | `handlers/subagent.ts` (1,923 lines) | Anthropic tool-use loop; default `claude-sonnet-4-6`, 20 turns | paid (chat), protected |
| 32 | `subagent_aggregator` | `handlers/subagent-aggregator.ts` | Deterministic roll-up of `child_done` rows | free, protected |
| 33 | `synthesize` | `handlers/cycle-phase.ts` → `core/cycle/synthesize.ts` (3,244 lines) | Dream synthesis via subagents or one-shot | paid, protected |
| 34 | `patterns` | `handlers/cycle-phase.ts` → `core/cycle/patterns.ts` (1,260 lines) | Cross-session pattern pages via subagents | paid, protected |
| 35 | `consolidate` | `handlers/cycle-phase.ts` → `core/cycle/phases/consolidate.ts` | Facts to takes promotion; deterministic in v0.31 header | free, protected |
| 36 | `extract_facts` | `handlers/cycle-phase.ts` → `core/cycle/extract-facts.ts` | `## Facts` fence reconcile | free |
| 37 | `resolve_symbol_edges` | `handlers/cycle-phase.ts` | Code-edge resolution on chunks | free |
| 38 | `recompute_emotional_weight` | `handlers/cycle-phase.ts` → `core/cycle/emotional-weight.ts` | Derived emotional-weight column | free |
| 39 | `unify-types` | `handlers/unify-types.ts` | Pack upgrade: retypes 25K+ pages, manual | free (inferred), protected |
| 40 | `skillopt` | `core/skillopt/job.ts` | Skill optimizer loop | paid, protected |
| 41 | `autopilot-cycle` | `handlers/autopilot-cycle.ts` | `runCycle` for one source with the freshness subset | orchestrator |
| 42 | `autopilot-global-maintenance` | `handlers/autopilot-global-maintenance.ts` (447 lines) | Runs `MAINTENANCE_PHASES` one by one, saves progress | orchestrator |

Handler notes: `sync` hands embedding to `embed-backfill` after a change. The
`autopilot-dispatch.ts` comment says the sync handler auto-enqueues it through
`src/core/embed-backfill-submit.ts`; I did not trace that call (inferred).
`extract` in stale mode chains a continuation job only while the stale count shrinks
(`handlers/extract.ts:20-55`). `subagent` and `subagent_aggregator` have default lock
leases of 5 min and timeouts of 30 min (`handler-timeouts.ts`).

### 4.3 Minimum useful brain

Needed:
- `sync` (or `import`): brings pages in.
- `embed` or `embed-backfill` (and `embed-catch-up` for onboarding): vectors for hybrid search.
  Keyword search works without them.
- `extract`: derived links and timeline rows from page content. Deterministic.
- `backlinks`: finds and fixes missing back-links. Deterministic.

Useful for autonomy: `autopilot-cycle` (per-source freshness), `purge` (soft-deleted pages
reclaimed after 72 h), `orphans` (report only).

Optional, and every paid LLM handler sits here: the subagent family, `synthesize`, `patterns`,
`consolidate`, `extract-conversation-facts`, `facts-absorb`, `enrich`, `chronicle_extract`,
`contextual_reindex_per_chunk`, `skillopt`, `extract-takes-from-pages`, `extract-atoms-drain`,
`loops_extract`, `shell`, `connector-sync`, `ingest_capture`, `reindex`, `unify-types`,
`integrity`, and the `*-repair` handlers.

## 5. Autopilot

Files: `src/commands/autopilot.ts` (1,658 lines; entry `runAutopilot` at `:629`, install
functions `:901-1327`), `src/commands/autopilot-daemon.ts` (690 lines), `autopilot-dispatch.ts`
(897 lines), `autopilot-remediation-policy.ts`, `autopilot-fanout.ts` (853 lines), `autopilot/jobs.ts`.

Loop (`autopilot-daemon.ts`):
1. Default `--interval 300` seconds (`:79`).
2. `dispatchAutopilotTick` (`autopilot-dispatch.ts`):
   - Per-source freshness syncs. Key `autopilot-sync:<source>:<slot>` where slot is
     `floor(now / interval) * interval`. HEAD-driven syncs key on the HEAD sha instead.
   - `extract_atoms` auto-drain.
   - Remediation plan. Sleeps if score ≥ 95, plan empty, and last full cycle under 60 min
     (`shouldSleepHealthyAutopilot`, `autopilot-remediation-policy.ts:45-55`).
   - Targeted handler submits if plan ≤ 3 steps and under 300 s. Otherwise a full
     `autopilot-cycle` fan-out per source (`fanoutMax`: 4 on Postgres, 1 on PGLite) and
     `autopilot-global-maintenance`.
   - A full cycle is forced every 60 min (`AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES`).
3. `adaptiveInterval` (`autopilot-daemon.ts:672-680`): score ≥ 90 doubles the interval;
   score < 70 uses `max(base/2, 60 s)`; unknown score keeps the base.
4. Sleep: `sleepWatchingHeads` watches git HEADs every 3 s
   (`GBRAIN_AUTOPILOT_HEAD_PROBE_MS`, range 1-30 s), so a new commit can wake it early.

Supervision: `ChildWorkerSupervisor` runs `gbrain jobs work`. After 5 consecutive crashes
autopilot exits 1 (`autopilot-daemon.ts:419-423`). The daemon writes a heartbeat by touching
its lock file. A foreign PID lock is taken over after 10 min
(`AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS`, `autopilot.ts:290`). Status calls the daemon stale
after 6 intervals (`classifyAutopilotStatus`, `autopilot.ts:1514-1540`).

PGLite: `installDaemon` refuses on PGLite unless `--force`, because a daemon would hold the
single-writer lock (`autopilot.ts:901-910`). Fallback without minions (`minion_mode=off`,
PGLite, `--inline`) runs sync, extract, and embed inline.

Install targets (`detectInstallTarget`, `autopilot.ts:667-690`): `macos` (launchd plist),
`linux-systemd` (user unit), `ephemeral-container`, `linux-cron` (crontab). The generated wrapper
script sources a `GBRAIN_ENV_TEMPLATE` env file before exec (`writeWrapperScript`, `:783`).

## 6. Cycle phases: `src/core/cycle.ts` and `src/core/cycle/`

`ALL_PHASES` (`cycle.ts:130`) has 32 entries in this order. The dispatch in `runCycle` follows
the same order (a test pins it, per the comment at `cycle.ts:219`). Scope comes from
`cycle/phase-scope.ts`. Cost tier and managed class come from `cycle/phase-table.ts`
(`MANAGED_PHASE_TABLE`, 32 entries). Tier counts: 14 paid, 10 free, 6 filesystem, 2 deletes.

Source freshness subset (`phase-scope.ts`): `lint, backlinks, sync, extract, extract_facts,
recompute_emotional_weight`. Connector sources run `extract, extract_facts,
recompute_emotional_weight` only (`CONNECTOR_SOURCE_PHASES`). Explicit `--phase` lists are
honored verbatim (`resolveCyclePhases`, `cycle.ts:289`).

| # | Phase | Scope | Tier | Managed class | What it reads or writes (from phase-table reason unless inferred) |
|---|---|---|---|---|---|
| 1 | lint | source | filesystem | writes | Lint repairs, one page per repair, via coordinator |
| 2 | backlinks | source | filesystem | no write | Counts missing back-links; audit only |
| 3 | sync | source | filesystem | writes | Changed git files admitted through coordinator |
| 4 | fence_repair | global | free | writes | Repairs held or malformed facts/takes fences |
| 5 | content_repair | global | free | writes | Other content-repair kinds |
| 6 | unindexed_files | global | filesystem | no write | Schedules files with no page for re-screen |
| 7 | synthesize | mixed | filesystem | writes | Subagent synthesis from transcript corpus |
| 8 | extract | source | free | writes | Derived links, timeline rows (DB) |
| 9 | extract_facts | source | free | writes | Re-projects fence facts |
| 10 | extract_atoms | source | paid | writes | Haiku atom pages (pack-gated) |
| 11 | resolve_symbol_edges | global | free | no write | Code-edge metadata on chunks |
| 12 | patterns | mixed | filesystem | writes | Pattern pages via subagents |
| 13 | synthesize_concepts | global | paid | writes | Concept pages, Sonnet narratives (pack-gated) |
| 14 | recompute_emotional_weight | source | free | no write | Derived `emotional_weight` column |
| 15 | consolidate | source | free | writes | Facts to takes, deterministic |
| 16 | propose_takes | source | paid | no write | Writes `take_proposals` review queue |
| 17 | grade_takes | global | paid | no write | Caches verdicts in `take_grade_cache` |
| 18 | calibration_profile | global | paid | no write | Writes `calibration_profiles` |
| 19 | edge_contradictions | global | paid | writes | Proposals plus timeline lines (`add_timeline_entry`) |
| 20 | claim_conflicts | global | free | no write | Writes `decide_proposals` |
| 21 | drift | global | paid | writes | Drift report page (default off) |
| 22 | standing_questions | global | paid | writes | Question pages; `pinned_questions` side tables |
| 23 | chronicle | global | paid | writes | Life Chronicle event pages |
| 24 | facts_drain | global | paid | writes | Runs queued facts-absorb jobs (PGLite) |
| 25 | conversation_facts_backfill | source | paid | writes | Opt-in conversation facts |
| 26 | enrich_thin | source | paid | writes | Opt-in stub-page development |
| 27 | skillopt | global | paid | no write | Skill files outside the DB (default off) |
| 28 | embed | global | paid | no write | Embeddings (`runEmbedCore`, stale) |
| 29 | orphans | global | free | no write | Read-only orphan report |
| 30 | schema-suggest | source | free | no write | Schema suggestions |
| 31 | purge | global | deletes | writes | Purges soft-deleted pages past 72 h, one by one |
| 32 | bookkeeping_gc | global | deletes | no write | Retention GC of bookkeeping rows and files |

Phase notes:
- `embed` runs with `stale: true`, quiet, and the cycle abort signal, then fails if a watchdog
  aborted it (`cycle.ts:1688-1712`).
- `orphans` warns only when more than half the corpus is orphaned (`cycle.ts:1839+`).
- Per-phase budgets are in `src/core/cycle/budget-meter.ts` (named in the comment at
  `cycle.ts:185`, not read in full).
- Cycle lock: `gbrain-cycle` (`cycle/lock-set.ts:23`), a row in `gbrain_cycle_locks` with
  `LOCK_TTL_MINUTES = 5` (`cycle.ts:684`). Per-source ids come from `cycleLockIdFor`.
- Heavy phases yield to the event loop between phases, so lock renewal keeps running
  (`handlers/autopilot-cycle.ts:17-19`).

Per-source vs global: a per-source `autopilot-cycle` job is normalized to the freshness subset
(`normalizeQueuedSourcePhases`, `cycle.ts:316`). Mixed and global phases run once in
`autopilot-global-maintenance`, which walks `MAINTENANCE_PHASES` and records per-phase timeouts
in progress (`handlers/autopilot-global-maintenance.ts:177-421`). It stamps
`autopilot.last_global_at` on success (`cycle.ts:329`).

## 7. Dream and subagent jobs

`gbrain dream` (`src/commands/dream.ts`, 937 lines) is a thin alias over `runCycle`. Flags
include `--phase`, `--source`, `--once`, `--drain` (atom backlog), `--pull`, `--dry-run`,
`--reconcile-queue`, `--cancel-unmatched`, and `--json`.

Dream-inline private queues: the cycle's fan-out phases mint a private queue per run,
`dream-inline-<ms>-<uuid8>` (`queue.ts:66`). The lease for a private queue is 10 min
(`DEFAULT_PRIVATE_QUEUE_LEASE_MS`, `queue.ts:67`). Children run through `runSubagentsInline`
(`cycle/inline-drain.ts`), with `dream.synthesize.inline_concurrency` drain loops.

Subagent jobs (`handlers/subagent.ts`):
- A crash-resumable Anthropic Messages loop. Transcripts and tool executions live in
  `subagent_messages` and `subagent_tool_executions`. Resume trusts `complete` or `failed` rows
  and re-runs `pending` tools only if idempotent (header at `subagent.ts:1-22`).
- Rate lease on `anthropic:messages`, TTL 120 s, max in-flight from
  `GBRAIN_ANTHROPIC_MAX_INFLIGHT` (default 8). Table `subagent_rate_leases`.
- Defaults: model `claude-sonnet-4-6` (`:86`), 20 turns (`:87`), 8192 output tokens (`:88`).
  A `models.subagent` config can override.
- Admission: param-coalescing on and 48 h waiting TTL (`admission.ts:45-52`).
- One-shot mode (`handlers/subagent-oneshot.ts`, 721 lines): one tool-less completion, then
  validated writes. Any validation failure falls back to the agentic loop. A retried job that
  already wrote finalizes from the ledger instead of calling the model again.
- The aggregator (`handlers/subagent-aggregator.ts`) does deterministic string concatenation of
  `child_done` rows (v0.15 header). It does not call a model.

## Rust engine implications

Must preserve exactly:
- Claim semantics: one atomic transition from `waiting` to `active` in priority then FIFO order,
  with a worker-chosen fence token. Every later write must check the token. This is what makes
  a dead worker's job recoverable without duplicate completion.
- Lease math: `lock_until` versus stall grace (15 s), renewal at `min(lock/2, 60 s)`, the
  [5 s, 1 h] clamp on row and map values, `max_stalled` default 5, and `attempts_started` ≥
  `attempts_made`.
- Idempotency: the unique key over non-null values, dead and cancelled rows releasing their key,
  and the `coalesced` return.
- Parent/child: `waiting-children` flip, `child_done` inbox messages, and the `on_child_fail`
  policies.
- Protected-name policy and the `submission_authority IS NOT NULL` claim gate. These decide who
  can spend money.
- Cycle phase order and scope. Freshness subset for per-source jobs.

Can simplify:
- LISTEN/NOTIFY and the `sync` special case: an in-process channel that wakes on any commit
  that makes a job claimable. Keep a short poll as a backstop.
- Advisory locks: one process owns the queue, so admission, quota, and budget can run under one
  write lock. Only the keyed locks matter if multiple processes write.
- Row-table cycle lock: an OS file lock or the same DB transaction plus TTL.
- Dream-inline private queues: an in-process task set scoped to a phase run.
- `minion_inbox` and `minion_attachments` as plain tables with BLOB content.

Postgres feature to replace, and how:
| Feature | Used for | Rust replacement |
|---|---|---|
| `FOR UPDATE SKIP LOCKED` | claim, stall, timeout, watchdog | `BEGIN IMMEDIATE` (SQLite) or single writer thread |
| `pg_notify` trigger | wake | post-commit broadcast channel |
| `pg_advisory_xact_lock` | admission, quota, rate, budget | per-key `Mutex` map, or the write transaction |
| `ON CONFLICT ... WHERE` | idempotency | `INSERT ... ON CONFLICT` (SQLite upsert with partial index) |
| JSONB `data->>` | param hash, source id | JSON1 functions or extracted columns |
| `now() + interval` | leases, delays, TTL | integer epoch ms; compare with one clock source |
| `FOR UPDATE` on parent | max_children, roll-up | serialized writes under the same transaction |
| `SERIAL`, `BYTEA`, `TIMESTAMPTZ` | ids, attachments, times | `INTEGER PRIMARY KEY`, `BLOB`, integer ms |

Risks:
- Wall-clock leases. Clock skew between processes breaks stall and lock math. Use one clock owner
  or allow one process only.
- Multi-process workers. The TS design runs several `jobs work` children under a supervisor. Keep
  that topology only if the Rust engine needs cross-process locking.
- Long LLM calls hold leases for minutes. The renewal task must never block on the work it guards.
- Test surface: about 7,800 lines of handler code plus the 2,574-line queue and 1,792-line worker
  need equivalence tests. Several behaviors are pinned by tests in the reference repo, not by
  types.
- Stale comments in the reference repo (Open questions, item 6) could mislead a port.

## Open questions

1. Must the Rust queue support several worker processes at once? This decides whether the queue
   needs cross-process locks and whether leases can use wall-clock time.
2. Should v1 port all 42 handlers, or only the four minimum handlers plus the autopilot scheduler?
   The 15 paid handlers need a chat and embedding provider layer that is a separate research thread.
3. Keep `consolidate` as a protected name? Its phase is deterministic, and the protection may be
   out of date.
4. Keep `shell` at all? It is an arbitrary-command runner gated by an env flag.
5. Keep the autopilot health-score interval rules (sections 5 and 6)? They are policy, and no
   test pins them here.
6. Stale or contradictory comments found in the reference, to confirm before porting:
   - `handler-timeouts.ts` says the DB CHECK only enforces `> 0`. The schema enforces
     `5000 <= lock_duration_ms <= 3600000` (`schema.sql:1301`).
   - `cycle.ts:170` and `cycle.ts:2671` say `consolidate` uses a Sonnet rewrite. The phase is
     deterministic in `phases/consolidate.ts:11-12`.
   - `autopilot.ts:8` says restart with 10 s backoff. The code uses 1 s doubling to 60 s
     (`supervisor.ts:245`).
   - Worker option `maxStalledCount` (default 1, `types.ts:228`, `worker.ts:309`) is set but not
     read anywhere in `src/core/minions`. The effective limit is the row column.
7. Which handlers that import the gateway (`import`, `ingest_capture`, `loops_extract`,
   `connector-sync`, `doctor-refresh`) make paid calls in practice? Verified only by names and
   imports here.
