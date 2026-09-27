# Shared-skill lifecycle measurements

Run this opt-in workload on a quiet machine, separately from unit/E2E suites:

```bash
env -u DATABASE_URL bun --no-env-file scripts/shared-skills/lifecycle.ts \
  --manifest=.context/shared-skills-lifecycle-pglite.json
```

For PostgreSQL, supply an explicitly test-shaped `DATABASE_URL` and add
`--engine=postgres`. The existing test-database guard applies, and each child
creates and drops its own database. The supplied database is never truncated.

The default workload measures **10, 100 and 1,000 skills**, with **three independent
child processes per size**, three authenticated members, 200 read samples per
idle/loaded phase, and a 16 KiB changing asset. Each read sample fetches the current
skill body and then its asset at that exact immutable revision, validating bytes,
hashes, description and triggers. Members use real loopback HTTP MCP SDK clients
and distinct explicit grants. There are no provider calls or native-harness claims.

Initial corpus files and sealed projections are seeded synthetic fixtures. Their
construction is reported separately and **does not count as canonical publication
evidence**. Every measured update uses authenticated `put_skill`, durable journal
admission, file-set recovery and the real canonical publisher. The publisher keeps
updating while the concurrent readers run, bounded to 256 updates. A cap that
ends pressure early cannot hide insufficient overlap.

The recorded phases include:

- Cold connection and concurrent join latency; each member then fetches and
  verifies every issued revision before acknowledging the complete batch.
- Warm compact-view checks and full membership sync, with unchanged-view checks.
- Changed metadata and assets, followed by polling without any change-notification
  subscription. Latency starts at the observed durable commit, not an assumed
  response timestamp.
- Idle and loaded body/asset reads; final convergence and verified fetch
  acknowledgments from every member.
- Per-phase engine API calls, tool argument/result JSON bytes, decoded asset
  bytes, RSS, sampled outstanding/intent/recovery bytes, and queue age. These are
  logical payload and API counts, not SQL wire counts or HTTP framing sizes.
- Exact recovery reservation bytes observed only after the outer journal
  transaction commits. The separate 25 ms sampler can miss short recovery
  windows; it is not presented as the exact maximum.
- Acknowledgment latency and throughput over the union of active acknowledgment
  intervals. Fetch acknowledgments never claim installation or native use.

The relative read gate reuses `scripts/persistence/read-metrics.ts` unchanged:
median loaded p99 must be **at most 1.5×** median idle p99 across three independent
runs, and each run needs **at least 90%** overlap with the union of in-flight
public mutation intervals. Intervals use invocation-to-terminal-receipt time,
matching the existing persistence gate; actual durable admission and commit
times are also recorded. Read/write errors, missing admission observations,
zero commits during reads, or incomplete samples cannot pass. This does not
replace the existing `scripts/persistence/performance.ts` gate.

This additional body/asset-RPC comparison is experimental and separate from the
existing memory-retrieval gate. Report its result per engine, including a failure
when correctness passes but relative latency does not. PGLite shares one backing
connection between catalog reads and bundle publication; a passing PostgreSQL
measurement does not establish the same latency behavior for PGLite. Neither a
smoke nor `--informational` may be presented as a passing full measurement.

The command writes the aggregate manifest plus uniquely named per-run JSON and
full stdout/stderr logs beside it. It hashes the benchmark and exercised source
files before and after each run; edits during measurement invalidate the run.
No absolute latency, memory or throughput budget is invented by this workload.

## Small smoke and helper tests

```bash
env -u DATABASE_URL bun --no-env-file scripts/shared-skills/lifecycle.ts \
  --smoke --manifest=.context/shared-skills-lifecycle-smoke.json
bun test --timeout=60000 test/shared-skills-lifecycle-benchmark.test.ts
```

The smoke uses two skills, two members, four reads per phase and one independent
run. It verifies plumbing and invariants only and always reports
`full_gate: false`; a successful smoke is not a passing performance gate. Set
`GBRAIN_TEST_SHARED_LIFECYCLE_SMOKE=1` to include it in the test-file invocation.

Custom sizes, members, queries, runs, asset bytes, maximum writes and warm checks
are available through the corresponding `--key=value` flags. They remain bounded
by the validator. `--informational` permits a measured relative-latency failure
to return zero, but never permits correctness or sample-validity errors. The
default full-gate identity still requires the documented default corpus and
measurement dimensions; custom or smoke runs cannot impersonate it.
