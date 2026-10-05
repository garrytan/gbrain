# Persistence validation

Run the complete gate from a source install (`bun install --frozen-lockfile
--ignore-scripts` works):

```sh
bun --no-env-file scripts/persistence/validate.ts --engine=pglite
DATABASE_URL=postgres://test-user:test-password@localhost:5432/gbrain_test \
  bun --no-env-file scripts/persistence/validate.ts --engine=postgres
```

Postgres requires a test-shaped database URL and permission to create and drop
databases. Every phase gets a fresh, randomly named `gbrain_persistence_test_*`
database. Successful runs drop only those databases. Failed runs retain their
synthetic scratch directories and databases for inspection. PGLite uses temporary disk
datastores, reopened in separate processes. Child homes and writer lock paths
are temporary; no operator brain or provider credentials enter children.

The default gate executes, per engine:

| Workload | Required result |
| --- | --- |
| 1,000 seeded schedules (seed 5105) | 100 executions of each of the ten cases below; every schedule checks exact journal counter conservation and no leftover claimable work |
| Eight actual SIGKILL boundaries | Acknowledged requests survive reopening; unfinished file effects recover; committed DB/file/receipt state stays committed; original request replay returns the same outcome |
| 10,000 logical writes | Four independent producer processes, four principals and four source roots; every request commits once; every canonical snapshot and file matches the receipt; zero pending requests or unresolved recovery records |

CI runs this full gate on pushes to master and manual dispatches. Pull requests
run the same schedules and crash boundaries with a 2,500-write soak
(`--operations=2500`), so their manifests report `full_gate: false`; a soak
regression that needs more volume is caught on master.

The eight executed crash boundaries are `admitted`, `prepared`,
`before_publication`, `staging_flushed`, `after_publication`, `before_commit`,
`after_commit`, and `after_response`. The flushed boundary writes its event
synchronously and blocks the child before rename. The response boundary serves
a real fixture HTTP receipt; the parent fully reads and verifies it before
SIGKILL. Recovery verifies that no recorded or unaccounted temporary sibling
remains. Partial or unexpected staging bytes preserve quota and require explicit
recovery; a committed receipt is never reversed to resolve them.

Run just these process crashes with `--schedules=0 --operations=0`; its manifest
correctly reports `full_gate: false`. Input hashes include the atomic writer,
staging helper, recovery models, journal, coordinator and effect sinks.

The ten schedule families are concurrent identical/changed-intent replay;
competing creates and replacements using one revision; cancellation versus publication; rollback/lost response
at all five coordinator hooks; obsolete claim renewal/release; FIFO within
each root with unrelated-root progress; MVCC/serialized coherent reads;
unexpected external file bytes blocking recovery; concurrent quota admission;
and revocation after acceptance. A seeded PRNG varies principals, roots,
payloads, concurrent widths and submission order. Real production coordinator
hooks control transaction and filesystem boundaries. This is a bounded
schedule sample, not exhaustive model checking.

The crash cases kill a process after admission, durable prepare, immediately
before publication, after staging flush/close, after rename, before commit,
after commit, and after a delivered response. The
PGLite case exercises the datastore owner's death. The Postgres case kills
the client/owner process while the database server remains running. These
are process-crash RPO=0 checks; they do not simulate power loss, storage
controller failure or database-server loss.

Postgres runs two resident consumers and producers with independent database
connections. PGLite has one resident owner; producer processes submit through
a **fixture-only loopback endpoint** into the real admission API. That
endpoint does not test production authentication or MCP/IPC framing; the
existing receipt and transport suites cover those contracts. Both engines
use the real consumer, authority checks, kernel locks, coordinator, durable
files and database transactions. Four writes per producer stay in flight;
every seventeenth logical write is replayed under the same request ID.

## Crash robot

The crash robot runs generated sequences of real operations against a
managed brain and checks a reference model after every step, after every
crash and recovery, and after the final drain. It is a phase of
`validate.ts` with a time budget (`--robot-seconds`, default 300; `0` skips
it). Run it alone with:

```sh
bun --no-env-file scripts/persistence/validate.ts --engine=pglite \
  --schedules=0 --operations=0 --no-crashes --robot-seconds=300
```

Every op is a JSON descriptor (`ops.ts`) executed through its registered
operation handler with a real `OperationContext`: page writes, edits,
deletes and restores, `remember`/`forget`, takes add and supersede, timeline
entries, a user commit followed by `sync_brain`, a GitHub connector publish,
and credential revocation. Actors are the local CLI principal and two remote
agents, an OAuth client and a legacy access token, authenticated through the
production token verifier. Two sources share slugs, sit in two durability-
hardened Git checkouts, and a third source is the connector's.

Each run starts from a fresh datastore. The fixed sequences always run:
withdrawal followed by a stale republication, overlapping slugs across two
sources, competing writers on one page, caller-bound replay, an authority
revoked while effects are pending, and sync plus connector publish racing
direct writes. A counting pass records every crash seam a sequence reaches
(`src/core/persistence/fault-points.ts`); the robot then crashes each seam at
least once: the worker freezes at the seam, the driver SIGKILLs it, and a
fresh worker checks the state left behind, drains, resubmits the interrupted
requests with their original request ids and finishes the sequence. Random
sequences fill the rest of the budget. Process faults run once per engine:
a stale `index.lock`, a hung `git commit` that holds `index.lock` (it releases
the lock on SIGTERM, not on SIGKILL), on Postgres every session of the run
database dropped every 400 ms, and the owner killed right after a
`facts-absorb` job's extraction commits (deterministic chat and embedding
stubs); the job then runs again and every absorbed fact must be active
exactly once.

The reference model (`model.ts`) checks: a committed receipt is visible at
once and later revisions move only through committed ops; a late receipt
names a revision the page really had; after a concurrent group a page ends
at a revision a committed member returned, or at the write of a committed sync
or connector publish (which return no revision) whose marker it carries, and
every receipted revision a later member replaced is in the page's history; a
refused write never becomes visible;
a withdrawn fact never returns through recall, `get_page` or the facts table;
a write never lands in another source; another principal reusing a request
id never receives the original receipt; takes and facts rows equal their
page fences; content rows carry write attribution; no orphan rows; every
request and effect drains (within 20 s on PGLite, whose restarted owner
releases a dead owner's claims, and within the 2-minute effect lease plus
margin on Postgres); a fresh write still commits. `lock-order.ts` checks each
transaction's row locks: worktrees before sources, sources in id order, no
exclusive brain-row lock inside a publication, and the brain row before any
worktree, source or counter row whenever one transaction locks both (a write
to `persistence_requests` or `persistence_effects` counts as the brain-row
FOR SHARE read its protocol trigger takes).

Postgres runs connect through `GBRAIN_PGBOUNCER_URL` when it is set, with
prepared statements off. A Postgres run with a budget under 300 s (the
pull-request run) skips what can wait out a dead owner's claim lease: the
`effect:*` seams, `consumer:prepared`, the publication seams `prepared`,
`before_publication` and `after_publication`, and the pooler disconnect
fault. Full runs crash every seam and run every fault. The manifest's `robot`
key lists every run (schedule, seed, seam and occurrence or process fault),
`sequences_x_crash_points`, `lease_bound_seams_skipped`,
`lease_bound_faults_skipped` and violations with the observed trace;
`robot_full_gate` is true for a full-budget run with no violations.

A failing run prints two commands. `--replay=<manifest>` re-runs exactly the
manifest's failing runs. `--shrink=<manifest>` removes ops from the first
failing run (an op whose producer was removed goes with it) while a
violation of the same class remains, accepts the result only when it
reproduces in 3 of 3 reruns, and writes `<manifest>.shrunk.json`. Accepted
shrunk sequences are checked in under `test/fixtures/crash-robot/` and
replayed by `test/persistence-crash-robot.slow.test.ts`.

For a local Postgres and PgBouncer replay:

```sh
docker network create gbrain-robot
docker run -d --name robot-pg --network gbrain-robot -p 5432:5432 \
  -e POSTGRES_USER=gbrain_test -e POSTGRES_PASSWORD=gbrain_test -e POSTGRES_DB=gbrain_test \
  pgvector/pgvector:pg16
docker run -d --name robot-pgbouncer --network gbrain-robot -p 55433:5432 \
  -e DB_HOST=robot-pg -e DB_PORT=5432 -e DB_USER=gbrain_test -e DB_PASSWORD=gbrain_test \
  -e POOL_MODE=transaction -e AUTH_TYPE=plain -e MAX_CLIENT_CONN=200 -e DEFAULT_POOL_SIZE=10 \
  -e IGNORE_STARTUP_PARAMETERS=extra_float_digits,statement_timeout,idle_in_transaction_session_timeout,search_path \
  edoburu/pgbouncer:latest
PGPASSWORD=gbrain_test DATABASE_URL=postgres://gbrain_test@127.0.0.1:5432/gbrain_test \
  GBRAIN_PGBOUNCER_URL=postgres://gbrain_test@127.0.0.1:55433/gbrain_test \
  bun --no-env-file scripts/persistence/validate.ts --engine=postgres --replay=<manifest>
```

`buildHistoryFixture(engine, { pages, seed, sources, worktrees })`
(`history-fixture.ts`) builds a managed brain with real persistence history
(up to 10,000 pages) through the same op protocol: committed and queued
requests, a delayed Git effect, withdrawals, superseded takes, page versions,
chronicle ledger rows, local writers, an OAuth client and token, and an
access token with unified grant columns. The engine must be initialized and
not yet activated, under an isolated `GBRAIN_HOME`.

`would-have-caught.ts` measures the gate against past fixes: for each fix
frozen in `would-have-caught.json` it reverse-applies the fix's `src/` hunks
in a scratch worktree and runs the pre-robot gate and the robot phase
against it, after a HEAD control that must pass.

The default manifest is `.context/persistence-<engine>-manifest.json`. It
contains the actual completed case counts, crash outcomes, runtime/platform,
latency distributions (p50/p95/p99/max), concurrent canonical-read checks, throughput, peak resident RSS,
duplicate replay count, per-phase source hashes and final accounting results. A failed run writes a
failed manifest. Smaller runs (`--schedules=50 --operations=64`) are useful
for iteration and always report `full_gate: false`; `--no-crashes` does too.
Use `--seed=...` for another reproducible sample and `--manifest=...` to keep
multiple records. Performance numbers describe a synthetic body+timeline+tag
workload with a durable file per write; they exclude provider calls, Git
publication and remote network latency. Compare like-for-like runtime,
storage and process counts before setting or changing latency budgets.

On failure, the manifest includes the last cached state of each producer's
at-most-four active requests and a bounded owner snapshot: queue states and
ages, root ownership epochs, counters, consumer activity and error codes.
It excludes content, filesystem paths, authority, credentials and error
messages. Owner diagnostics have a two-second budget; an unavailable owner
adds a timeout marker and never changes the original failure or the
120-second receipt deadline.

The runner writes `<manifest>.retained.json` with mode `0600`, listing the
retained scratch root, worker PIDs and exact cleanup commands. After inspection,
verify those workers have stopped, run the listed database commands using the
original loopback test `DATABASE_URL` in the environment, then remove the
listed scratch directory. The metadata contains generated database names,
never a connection URL. Keep the retained directory private: its original
`config.json` files contain the test connection URL. Do not upload it with
the diagnostic manifest. Successful runs retain no fixtures.

`persistence-validation.yml` runs the full gate on Linux x64 for both engines
under Bun 1.4.0 and 1.4.2 and uploads every manifest. Native OS/architecture
coverage is separately required by `native-locks.yml`; its configured matrix
must not be mistaken for locally executed runtime evidence.

All stress fixtures explicitly activate managed persistence after registering
canonical roots. Workers assert that activation remains enabled and use a
synthetic host identity confined to the runner's temporary home. Matrix read
probes are seeded before activation; the measured writes use the coordinator.
Known permanent transaction failures stay failed after conditional filesystem
recovery, allowing the next request for that root to proceed.

The same workflow executes `scripts/persistence/matrix.ts`, requiring both
`DATABASE_URL` (direct test connection) and `GBRAIN_PGBOUNCER_URL` (a real
transaction-mode pooler with wildcard database routing).
Both supplied database names must pass the test-safety guard. Administrative
CREATE/DROP statements use the direct server's `postgres` maintenance database,
so another E2E shard resetting the shared test database cannot terminate this
connection. Every engine connection still uses a fresh generated test database.
The 24 cells cover
direct/pooler transport, RLS on/off under a non-superuser role, ordinary pools
1/2/3 and shared pools versus a separate direct pool of size one. Each cell
proves short control progress while the production bulk reservation API
holds every permitted long-running slot. Size one keeps canonical work
queued with `writer_pool_capacity`; sizes two and three commit the same
request after bulk work drains. A separate fixture checks manifest-verified
transfer between distinct host identities/checkouts, stale-owner refusal,
retained coordination paths across root replacement and source-incarnation
fencing. The default matrix manifest is
`.context/persistence-runtime-matrix.json`; missing mandatory URLs fail the
standalone gate. The ordinary E2E entry skips outside a configured pooler
lane and refuses to skip when `GBRAIN_CI_REQUIRE_PGBOUNCER=1`.

The heavy process worker allows 90 minutes; its CI job allows 110 minutes.
This accommodates disk-PGLite durability on slower VM storage without
reducing the 10,000 actual mutation requirement.

The required read-workload validity lane runs `scripts/persistence/performance.ts
--engine=pglite --informational` (or `--engine=postgres` with the same guarded
test URL).
It keeps the existing heavy workload's 500-page text corpus, 200 hybrid
searches per phase, four writers and an advisory 50% loaded-versus-idle p99
threshold. Three fresh child processes/databases each measure idle reads
followed by reads with
public `put_page` writes; the report compares the median loaded p99 to the
median idle p99 on the same runner. This measures the cost of additional
concurrent work, not a before/after comparison of a code change. Each run
requires actual committed writes, zero failed reads/writes and at least 90% coverage of the read
window by the union of in-flight public mutation intervals. An idle gap
cannot be hidden by a late writer completion. Actual writes must commit
during the read window. Both phases yield one event-loop turn between
queries (outside individual query timing), so PGLite's immediate promise
chain cannot starve resident-consumer timers and fabricate overlap using
only queued requests. Corpus seeding uses the same
public mutation path. This is keyless keyword search through `hybridSearch`,
without a provider or remote embedding latency.

The manifest records all three runs, exact source hashes, storage/runtime
and runner characteristics, admission/completion distributions, queue age,
recovery bytes, RSS, throughput and Postgres activity samples. The harness
records Bun's known `Failed to get memory usage` exception as a `null` RSS
sample and counts it in `rss_unavailable_samples`; `peak_rss_bytes` is the maximum
available sample, or `null` when none are available. These counters and peaks
include every settled sample, including those completing during final validation.
This known sampling limitation does not invalidate actual read/write measurements
or relax the latency and overlap gates. Unexpected sampler errors still invalidate
the run and retain only safe diagnostic fields. The harness
measures durable admission when the public handler's top-level queued journal
transaction resolves, and completion when its terminal committed receipt is
observed. Nested savepoints never count as admission. The same harness proxy
observes warmup and pressure writes; measurement buffers reset after warmup.
Every completed write must have its own earlier admission observation, and
missing or incomplete timing distributions invalidate the aggregate gate.
Pool gauges are explicitly a tracked SQL subset; `pg_stat_activity` separately records
active/idle sessions in the fresh fixture database, including the sampler.
PGLite keeps the original in-memory read-latency storage model; the separate
10,000-write durability lane uses disk storage. Smaller corpus options are
recorded as `full_gate: false`. `tests/heavy/read_latency_under_sync.sh`
retains its optional `STRICT_LATENCY=1` interface and now runs the same
three-sample harness; sample validity always fails closed. CI passes
`--informational` on both Bun versions and both engines: a valid workload
over the 50% threshold exits successfully, but the manifest keeps its
`verdict: "fail"`, `status: "failed"` and `full_gate: false` threshold result.
Invalid samples, failed reads/writes and insufficient overlap still fail CI.
Omit `--informational` to enforce the threshold locally; the threshold value
and measurement workload have not changed.

## Test suites

These suites own the durable-persistence contracts. `test:full` alone does not run the complete
native, runtime, crash, soak, deployment-matrix and read-latency gates; tie each result to its tested
revision and disclose skipped cells.

### Canonical reconciliation and accepted writes

`test/persistence-reconcile-merge.test.ts` pins loss-preserving field choices.
`test/persistence-reconcile.test.ts` runs the guarded repair and replay contracts
on PGLite and, with an explicit safe `DATABASE_URL`, isolated PostgreSQL databases.
It covers stale preconditions, current/original grants, private facts, retained
backups, ordinary mutations after repair, and competing publications.
`test/reconcile-owner-journey.serial.test.ts` drives real CLI requests through
HTTP and stdio PGLite owners before and after activation, restarts the owner, and
independently reads the newly remembered private fact and provenance.

`test/reconcile-crash.slow.test.ts` and `test/e2e/reconcile-crash*.test.ts` kill real
processes at all eight publication boundaries with activation off/on. PostgreSQL
uses one file per activation state to stay within the unchanged per-file cap. Optional
`GBRAIN_TEST_RECONCILE_CRASH_MANIFEST_DIR` retains executed-case evidence.
`test/e2e/reconcile-pgbouncer.test.ts` requires the transaction-mode pooler when
`GBRAIN_CI_REQUIRE_PGBOUNCER=1` and proves repair followed by a new private memory
write. The durable-persistence workflow runs these contracts on both supported
Bun versions and uploads the crash manifests; local CI runs the slow and E2E lanes.

`test/put-page-persistence.test.ts` and `test/e2e/put-page-persistence-postgres.test.ts`
pin durable page acceptance and ordinary-error publication: native contention
returns an accepted pending receipt without changing the page, and replay of its
original UUID commits exactly once after release. Filesystem or required
source-path failure rolls back the database transaction. Embedding failure
preserves the canonical receipt; a delayed result superseded by another revision
cannot install vectors. The PGLite suite also covers scoped physical file paths,
unchanged-content no-ops, legacy hashes, deletion/recreation, and sanitized
diagnostics. Actual process-death boundaries belong to the crash suites below.

`test/subagent-required-writes.test.ts` and
`test/subagent-put-page-rejection.serial.test.ts` distinguish a persisted write
from prose-only completion, rejected imports, and historical rejected ledger
envelopes across the Anthropic, gateway, and oneshot lanes. Unchanged saves,
optional-write jobs, and saved pages with failed enrichment are positive controls.
`test/cycle/global-freshness-postcondition.serial.test.ts` exercises the registered
maintenance handler with failed phases, incomplete children, budget deferrals,
abort/lock loss, and successful warning-only controls.

### Native-matrix publication and managed writers

The glibc Linux, macOS and Windows matrix also runs
`persistence-publication-native.serial.test.ts`,
`persistence-git-publication.test.ts`,
`persistence-sync-origin-native.test.ts` and
`backup-portability-native.serial.test.ts` in separate Bun processes. These
exercise real Git publication, historical source origins and backup restoration
with fresh-process reopen. macOS and Windows set
`GBRAIN_TEST_REQUIRE_CASE_INSENSITIVE=1`; a case-sensitive fixture must fail
rather than silently skip the publication regression. Inspect executed test
counts before claiming native coverage; a configured lane alone is not evidence.

The publication, sync-origin, processing-option and company-sync suites also
run separately with an explicit PostgreSQL URL in the persistence deployment
matrix. `test/e2e/persistence-publication-parity.test.ts` and
`test/e2e/persistence-sync-{origin,options,company}-parity.test.ts` include them
in the full local E2E gate; the keyless serial runner alone cannot exercise
their PostgreSQL branches.

Focused safety coverage: `test/apply-migrations-safety.serial.test.ts` checks
force dry-run previews before DB/ledger access and failed-phase partial exit;
`test/real-home-guard-preload.test.ts` pins the test-home fingerprint backstop
(detection, not prevention). Managed retry, durable diagnostics, restart and
PGLite/Postgres parity are covered by `test/persistence-sync-failures.serial.test.ts`
and `test/e2e/managed-sync-failures.test.ts`. Backup remote readback and fsync
fault cases run in `test/backup-verification.serial.test.ts` and
`test/backup-fsync.serial.test.ts`; `test/e2e/backup-coverage-parity.test.ts`
covers PGLite/Postgres page/fact/config parity. Output redaction uses
`test/search/output-redaction.serial.test.ts` and
`test/search/output-redaction.test.ts`, including unchanged internal capture.

Managed writer fixtures use isolated PGLite and guarded disposable Postgres:
`test/e2e/fact-vector-repair-parity.test.ts`,
`test/e2e/fact-embedding-backfill-parity.test.ts`, and
`test/fact-backfill-resident.test.ts` cover preserved vectors, bounded
NULL-only fact backfill, selected-config refusal and owner-held PGLite IPC;
`test/ai/google-embed-batch-items.test.ts` pins 100-item provider batches.
`test/persistence-embedding-effects.test.ts`,
`test/persistence-effect-retry.test.ts`, and
`test/embedding-completion-atomic.serial.test.ts` cover partial vector
completion, exhausted durable attempts and state-bound explicit retry.
`test/managed-extract-atoms.test.ts`, `test/managed-facts-backstop.test.ts`
and their `test/e2e/` counterparts exercise admitted atom/fact replay,
including fresh-process facts authority. `test/persistence-connectors.test.ts`
covers managed bound/unbound Google/GitHub sources, API pagination and
source-scoped deletions. `test/persistence-connector-retry.test.ts` covers
explicit retry, compaction, checkpoint dependency identity, concurrent approval
and lost acknowledgements. Each suite creates its own home, engines and
lifecycle through `test/helpers/connector-fixture.ts`; the helper shares no
live engine or mutable suite state. Their separate E2E entry points,
`test/e2e/managed-connector-routing.test.ts` and
`test/e2e/managed-connector-retry.test.ts`, retain the runner's default
180-second per-file cap without duplicating the base cases in the retry lane.
Linux root runners execute the complete EACCES case in an isolated `setpriv`
child and assert UID 65534 before testing permissions. This needs a readable
checkout, not changes to the parent process identity or checkout permissions;
the CI runner image supplies `setpriv`.
`test/managed-maintenance.test.ts` and
`test/helpers/maintenance-restart.ts` cover local synthesize/patterns/
consolidation, restart replay, retired takes and semantic snapshots;
`test/managed-unsupported-preflight.serial.test.ts` checks that the managed
facts-family bulk lanes refuse an unaccepted writer before spend, and
`test/managed-facts-writers.test.ts` proves each of them (fence reconcile,
phantom redirect, fence writes, loops extraction, bulk conversation facts)
publishes through the coordinator on PGLite and Postgres. These use synthetic provider/API transports, not
paid model calls or production connectors. PGLite dream/job CLI with an active
owner is **not** proven delegated by the live fact-backfill IPC test.

`test/facts-worker-config.test.ts` and its PostgreSQL E2E counterpart dispose
the original consumer before executing a real facts-absorb job. They verify the
worker passes trusted selected configuration, ignores job-supplied configuration
and settles the entity-page effect with zero fact or chunk embedding calls when
disabled. Fact extraction still captures the generated fact with a NULL embedding.

`test/managed-facts-embedding.test.ts` and its PostgreSQL counterpart bind retained
fact vectors to the selected brain's model and dimensions, including equal-width
host/mount mismatches, keyless capture, policy changes and replay without new spend.
`test/managed-atom-regressions.test.ts` and its PostgreSQL counterpart preserve
later target edits through explicit retries and honor database-only storage policy
without relaxing source authority. `test/managed-synthesis-postprocess.test.ts`
and its E2E wrapper verify that completed quote/provenance work never rewrites a
later user edit, while unfinished work resumes against its original revision.
The synthesis suite also preserves the existing same-date summary on replay and
rebuilds a complete index after partial recovery. `test/managed-atom-compaction.test.ts`
and its PostgreSQL counterpart age and compact real receipts: permanent completion
identity still prevents repeated extraction, while expired retry payloads produce
an explicit refusal without changing terminal outcomes or compaction accounting.
`test/managed-facts-compaction.test.ts` and its PostgreSQL counterpart cover the
same lifetime boundary for explicit and derived fact-batch identities, including
failed or partially committed batches and successful replay without new spend.
Connector sweep fencing and physical-path normalization have separate parity
coverage in `test/persistence-connector-fencing.test.ts`. Standalone crash/recovery
cases live in `test/persistence-connector-recovery.test.ts` and their own E2E
wrapper so they do not share the routing file's wall-clock budget; their original
assertions, child watchdogs and per-file timeout are unchanged.

`test/managed-atoms-cli.slow.test.ts` exercises real disk-backed PGLite CLI
recovery with a loopback provider: live-owner refusal, graceful owner stop,
malformed extraction, explicit same-input retry, idempotent replay and owner
restart. Fresh-process readback checks the private canonical file, searchable
chunk, retained failure receipt, committed completion and released leases.
`test/managed-connector-routing.serial.test.ts` pins actual activation and
`performSync` routing for API sources; the maintenance suite also drives
`runCycle` with eligible facts in two sources and proves the other source is
unchanged. The E2E wrapper files ensure these optional PostgreSQL arms execute
in the database lane rather than only passing their PGLite controls.

The persistence invariant jobs run the complete `scripts/persistence/validate.ts`
gate (10,000-write soak) on pushes to master and manual dispatches. Pull requests
run the same schedules and crash boundaries with a 2,500-write soak; the full
PGLite soak alone takes 15-28 minutes and would otherwise set every PR's wall
time. `test/scripts/data-safety-native-workflow.test.ts` pins the split. The
crash robot (generated sequences of real operations, SIGKILL at every crash
seam they reach, process faults, the reference model) runs as its own job
beside the soak: 150 s on pull requests, 600 s elsewhere, Postgres through a
transaction-mode PgBouncer. That job also replays the shrunk crash-robot
regressions (`test/persistence-crash-robot.slow.test.ts`) and the history
fixture test on both engines; see `scripts/persistence/README.md`.

For platform-only feedback, dispatch
`gh workflow run test.yml --ref <branch> -f native_only=true`. This explicit manual option uses a separate concurrency
group so it does not cancel an ongoing full persistence soak. Its
`native-only-validation-scope` artifact records the exact commit and
`full_ci: false`; it never emits the required `test-status` check for unrun full
CI. Omitting the option preserves every normal PR, push and full manual gate.

### Schedules and process crashes

`test/persistence-consumer-scheduling.test.ts` pins completion wake-ups,
including a wake-up arriving during an active tick, without lowering the idle
poll interval. Per-root deadlines preserve blocked/retryable backoff even while
another root keeps committing; expired deadlines permit retries. Shutdown drains
active preparation without starting another request.
`test/persistence-root-refresh.test.ts` checks that unchanged root registrations
do not replace their durable files while unbound, moved and original bound paths
all remain fenced.

`test/e2e/persistence-http-liveness.test.ts` drives real authenticated HTTP MCP
with legacy and source-bound OAuth credentials against an isolated PostgreSQL
database. It covers pending page/fact writes, lost acknowledgments, owner
interruption, exact canonical readback, 44 pages over three clients, and current
receipt authorization. Set `GBRAIN_TEST_OLD_BINARY` to a retained compatible
executable to additionally exercise old/new owner handoffs in both directions
for queued, actually claimed and recovery-bearing rows. Interrupted owners are
reaped and native exclusion is verified before their successors start; only the
abandoned running lease is advanced by the fixture. An omitted executable skips
these compatibility cases, not proves them.
`test/e2e/persistence-phase-liveness.test.ts` holds real table/row locks and
ordinary/direct pool slots to verify phase cancellation (including capacity
marking), tracked queued `BEGIN`, renewal, expired-head FIFO and shutdown fences.
A loopback TCP gate separately delays or rejects cold direct initialization,
checking retained work through shutdown and same-ID completion after retry.
The memory-mutation tests use a
deterministic loopback embedding transport for slow and aborted preparation;
they do not contact a paid provider. Receipt contract, MCP parser, IPC and CLI
tests pin the same nested allowlist and advisory age policy. Diagnostic tests
exercise both fresh/index-upgrade parity and a genuinely interrupted PostgreSQL
concurrent index build when a PostgreSQL fixture is supplied.

`test/persistence-chaos.slow.test.ts` and `test/e2e/persistence-chaos.test.ts`
execute real journal/coordinator schedules and eight SIGKILL publication
boundaries, followed by a small multi-process soak. The Postgres test creates
and drops fresh test databases, requiring CREATEDB on the explicit test URL.
It never truncates the shared E2E database. The reusable
`persistence-validation.yml` gate runs 1,000 schedules and 10,000 writes per
engine under Bun 1.4.0 and 1.4.2 and uploads actual executed-case manifests;
the sections above cover workloads, reruns, performance measurements and the
process-crash scope.

`test/e2e/persistence-runtime-matrix.test.ts` additionally requires the real
transaction-mode PgBouncer fixture. Its 24 cells exercise direct/pooler
connections, enforced RLS under a non-bypass role, ordinary pool sizes 1/2/3,
and shared pools or a separate one-connection direct route. It verifies
reserved short control capacity while bulk connections remain held, then
drains and commits the original request. Ownership cases cover mismatched
successor manifests, stale owners, root replacement under a held kernel
lock, and actual source deletion/recreation. The reusable persistence lane
runs this matrix on both supported Bun versions and uploads its manifest.

The required persistence lane also runs `scripts/persistence/performance.ts`
on both engines and Bun versions. Three independent instances use the
existing 500-page/200-query read-latency corpus, with public `put_page`
mutations and actual in-flight interval coverage of at least 90%. Any read
or write failure invalidates the sample. CI uses `--informational`: the 50%
loaded-versus-idle p99 threshold is advisory, not a merge blocker. Loaded
reads compete with additional write work, so this ratio alone is not evidence
of a change regressing the same workload. Manifests retain the original
threshold verdict, each sample, admission/commit latency, queue age, RSS,
recovery bytes and pool activity.
The CLI without `--informational` still enforces the threshold. The original
heavy shell entry invokes this harness; its optional `STRICT_LATENCY=1`
flag affects only the latency threshold, never validity requirements.

## Engine graduation tests

Graduation (`gbrain migrate --to postgres`) is tested against two fixtures.
`test/fixtures/graduation/legacy-brain.ts` builds a small brain by hand-written
SQL on a fresh schema, and its expected outcomes live in `expected.json`
beside it (`test/graduation-legacy-fixture.test.ts` proves the build matches
and that the target checker discriminates).
`scripts/persistence/graduation-fixture.ts` wraps `buildHistoryFixture` for
the 1k and 10k history brains, builds keylessly in a child process, and
caches each build as a tarball keyed by the fixture sources, schema version,
seed and size (`GBRAIN_GRADUATION_FIXTURE_CACHE`, default
`~/.cache/gbrain-graduation-fixtures`). A restore re-homes paths and owner
stamps and marks sources synced, so the source doctor stays green.

The E2E suites drive the real CLI in child processes:
`graduation-crash` (SIGKILL at every run and rollback boundary),
`graduation-faults` (ENOSPC on a tmpfs tablespace, which needs Docker;
password rotation; DDL route mismatch), `graduation-clients` (older
releases, respawned and resident serve, stale CLI and MCP configs) and
`graduation-cli` (agent flow, zero-mutation `--plan`/`--status`, `--force`,
PgBouncer through `GBRAIN_PGBOUNCER_URL`, a NOSUPERUSER role, the 1k round
trip). Kill and pause points come from `graduationBoundary()` hooks that only
`test/helpers/graduation-hooks-preload.ts` registers. Older release binaries
are built once per tag under `GBRAIN_OLDER_RELEASE_DIR`. The crash suite takes
about 40 seconds per case, so run it with `GBRAIN_E2E_FILE_TIMEOUT=3600`.
`scripts/persistence/graduation-ttv.ts` records the commands and wall time
from the first plan to a green doctor, the run's phase timings and query
p50/p95 on both engines. The 1k-page gate is five minutes;
`tests/heavy/graduation_10k.sh` reports the 10k run.
