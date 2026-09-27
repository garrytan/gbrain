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
under Bun 1.3.11 and 1.3.13 and uploads every manifest. Native OS/architecture
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

The required read-latency lane runs `scripts/persistence/performance.ts
--engine=pglite` (or `--engine=postgres` with the same guarded test URL).
It keeps the existing heavy workload's 500-page text corpus, 200 hybrid
searches per phase, four writers and 50% p99 regression budget. Three fresh
child processes/databases each measure idle reads followed by reads with
public `put_page` writes; the gate compares the median loaded p99 to the
median idle p99 on the same runner. Each run requires actual committed
writes, zero failed reads/writes and at least 90% coverage of the read
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
three-sample harness; sample validity always fails closed. The required CI
lane always enforces the unmodified 50% threshold on both Bun versions and
both engines.
