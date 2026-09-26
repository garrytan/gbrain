# Markdown reindex COMMIT investigation (#5284)

## Disposition

**Original macOS failure unresolved.** The fresh-store controls below did not
reproduce it. A later bounded mutation-pressure experiment on Linux reproduced
a COMMIT-tail stall and a subsequent real-CLI reindex stall, documented below;
their identity with the reported macOS failure is not established. No production
reindex or engine behavior was changed for these investigations.

Issue #5284 reports PGLite 0.4.3 spinning inside COMMIT after approximately
2,600–3,300 writes, with a stalled event loop and no recovery after 48 minutes.
The reported environment was macOS 27 ARM64, Bun 1.4.2, and an aged 3.6 GB store
containing about 5,600 pages. A small fast fixture cannot exclude a
platform/runtime or storage-pressure trigger.

The reviewed head was `6ebc629`; current master for this investigation was
`3e92670` (v0.51.4.0). The latter changes persistence-consumer wake scheduling,
root backoff, filesystem-root refresh, and test infrastructure. There is no
diff in `reindex.ts`, `import-file.ts`, `pglite-engine.ts`, or
`pglite-lifecycle.ts` between those revisions, or between the issue's
`d13aa74` and current master. The persistence performance release is not
evidence that this COMMIT failure was fixed.

These measurements are pinned to the two revisions named above. Later upstream
revisions, including `44f96ed` (v0.51.7.0), change projection recovery and related
engine paths. The table below is not a performance measurement of those later
revisions; the retained slow fixture's shipping validation is reported separately.

## Reproduction

```sh
bun --no-env-file scripts/bench-reindex-markdown.ts . 3600 8
bun test test/reindex-markdown-persistence.slow.test.ts
```

The trace reports total, page and planner-statistics transactions separately.
Page transactions are identified by their actual canonical page-lock keys: every
rebuilt page must have one distinct committed transaction, and no such transaction
may cover multiple pages. Explicit `ANALYZE` work is reported separately and
unclassified transactions fail the fixture. The interruption targets the 101st
page transaction, independent of maintenance work. This retains the ownership and
recovery assertions when an upstream release adds a legitimate statistics refresh.

The benchmark also accepts another source checkout as its first argument, so
the same harness can exercise a reviewed revision without modifying that
checkout. Its second and third arguments bound page count (3,000–10,000) and
sections per page (1–128). The slow test uses 3,600 pages with one section;
the diagnostic run uses eight sections, roughly 4.3 KB per page.

The launcher creates a fresh HOME, XDG directories, working directory, notes
directory, and persistent PGLite store. Child environments are allowlisted;
provider credentials and database URLs are never inherited. The real CLI runs
with `--no-env-file`, `--no-embed`, and startup hooks disabled. A preload refuses
and records attempted fetches; the launcher fails if one is attempted. No
production brain, paid provider, plugin, or external database is involved.

The fixture seeds generic markdown pages, legacy chunks, and tags. Half the
pages have source files, half exercise the DB-only serialization fallback.
The measured command is the real `src/cli.ts reindex --markdown` dispatch,
not a replacement loop or a mock engine. A preload wraps outer
`PGLiteEngine.transaction` calls, emitting `begin`, `body_done`, and `committed`
records. Nested savepoints are excluded. The measured COMMIT tail includes
the synchronous trace write and the engine's post-body transaction completion;
it is not a profiler measurement of a single Postgres function.

The launcher enforces a ten-minute total deadline from a separate process,
then SIGKILLs and reaps its child if necessary. A synchronous WASM spin in the
CLI cannot block that timer. Standalone runs retain per-phase stdout, stderr,
transaction traces, exit codes, and summaries in the printed temporary root.
The slow test removes successful fixtures and retains failed ones.

## Measurements

Measured on Linux x86-64, four AMD EPYC vCPUs, Bun 1.3.14, PGLite 0.4.3.
These are single-run diagnostic timings, not a controlled throughput comparison.

| Revision / phase | Pages committed | Wall time | COMMIT tail p99 | Maximum COMMIT tail |
| --- | ---: | ---: | ---: | ---: |
| Current `3e92670`, full sweep | 3,600 | 130.95 s | 0.887 ms | 22.16 ms |
| Current `3e92670`, resume | 3,500 | 133.91 s | 0.813 ms | 20.88 ms |
| Reviewed `6ebc629`, full sweep | 3,600 | 120.10 s | 0.729 ms | 20.12 ms |
| Reviewed `6ebc629`, resume | 3,500 | 124.06 s | 0.698 ms | 19.77 ms |

Both revisions complete the same eight-section fixture. These runs do not
establish a speedup or slowdown, and neither reproduces the reported spin.
An earlier reviewed-head run was externally cancelled during its resume;
the table uses the complete rerun, which exited zero.

Every page in the full sweeps had a separate completed outer transaction; no
connection recycling was added. On current master, the median transaction body
took 27.10 ms. Bodies accounted for 104.31 s in aggregate, versus 1.29 s for
COMMIT tails.
The median COMMIT tail for the first 500 pages was 0.312 ms; for the last 500,
0.290 ms. This workload is doing finite per-page work, not exhibiting growing
COMMIT latency or a stalled counter. There is only one datastore client, and
no lock-timeout diagnostic occurred. Read batches of 100 do not constitute a
single sweep-wide transaction: the trace confirms one commit per page.

After resetting chunker versions, the fixture sends SIGKILL after transaction
101's body finishes but before it returns to PGLite for COMMIT. The child exits
137. Reopening finds exactly 100 pages committed and 3,500 still pending. The
resume completes all 3,500, and a fresh read reports zero pending pages, zero
current-version pages without chunks, zero mismatched projection revisions,
and zero missing synthetic tags. An unmodified immediate rerun commits zero
transactions. This verifies the existing interruption/recovery behavior; it
does not exercise killing an already-spinning WASM COMMIT.

## Verification

All of these commands completed with exit status zero:

- `bun --no-env-file scripts/bench-reindex-markdown.ts . 3600 8`: the current
  eight-section benchmark summarized above.
- `bun --no-env-file scripts/bench-reindex-markdown.ts <reviewed-checkout> 3600 8`:
  the complete reviewed-head comparison with the final fixture assertions.
- `bun test test/reindex-markdown-persistence.slow.test.ts`: 1 pass, 0 fail,
  230.03 s. The final one-section fixture on current master reindexed 3,600
  pages in 102.85 s and resumed 3,500 in 111.38 s. It also asserts the no-op
  rerun, exactly 100 commits before the injected kill, and reopened-store
  chunk/projection/tag consistency. No fetch was attempted.
- `bun test test/reindex.test.ts test/reindex-preserve-tags.test.ts`: 36 pass,
  0 fail, covering existing reindex scoping, keyset failure handling,
  idempotence, and tag-preservation behavior.
- `bun run typecheck`, plus a standalone TypeScript check of
  `scripts/bench-reindex-markdown.ts` (the repository's tsconfig includes
  `src` and `test`, not `scripts`).
- `bash scripts/check-test-isolation.sh`: passed.

These measurement runs did not exercise the full CI, Postgres E2E suite, macOS
runtime, embedding-enabled mode, or the reported large aged store. This is
focused local evidence for the named revisions, not a claim that the upstream
issue is resolved.

## Larger-corpus control

A later run on `34c71ef6` used 5,600 pages with eight sections each on Linux
x86-64, Bun 1.3.14 and PGLite 0.4.3. The checkout was isolated from workspace
setup and its revision was checked before and after the run. The command was:

```sh
bun --no-env-file scripts/bench-reindex-markdown.ts . 5600 8
```

| Phase | Page transactions | Wall time | COMMIT tail p99 | Maximum COMMIT tail |
| --- | ---: | ---: | ---: | ---: |
| Full sweep | 5,600 | 114.06 s | 0.319 ms | 17.07 ms |
| Resume after interruption | 5,500 | 101.02 s | 0.311 ms | 1.18 ms |

Each sweep also committed one separately classified planner-statistics
transaction. The immediate no-op committed none. The intentional SIGKILL at
the 101st page body left exactly 100 pages committed and 5,500 pending; resume
completed with no failed pages, missing chunks, mismatched projection revisions
or missing tags. No fetch was attempted. The complete launcher exited zero.

The resulting store occupied approximately 191 MiB. This matches the reported
page count but still does not match the aged 3.6 GB store or macOS 27 runtime.
These are single-run control measurements, not a speed comparison or evidence
that the reported failure is fixed.

The same immutable source revision was also exercised on native ARM64 macOS
26.2 with a scratch-local Bun 1.4.2 runtime, isolated HOME and no inherited
provider credentials. The 5,600-page full sweep completed in 95.20 seconds
(COMMIT tail p99 0.509 ms, maximum 10.48 ms). After the injected kill, exactly
100 pages were committed and the remaining 5,500 completed in 74.05 seconds
(p99 0.385 ms, maximum 12.08 ms). The no-op, reopened-store, tags, chunks and
projection assertions all passed. The retained launcher exit was zero, and no
fixture processes remained. This removes Linux and the older Bun runtime from
that control, but does not reproduce macOS 27 or the aged large-store condition.

## Remaining prerequisite

To establish whether the Linux pressure stalls below explain the original
report, replay the pressure workload on macOS 27 ARM64 with Bun 1.4.2 and compare
the failing transaction and WASM ancestry. The fresh controls and the partially
churned store still do not match the report's aged 3.6 GB state. No private
corpus is needed or requested.

A failing macOS run must retain its last transaction marker and external process
sample. `body_done` without `committed` narrows the failure to the completion
path; its WASM frames must be identified before equating that spin with the
Linux profiles below.
Until that evidence exists, periodic reconnects or checkpoint commands would
be speculative mitigations, not an established root-cause fix.

## Bounded mutation-pressure follow-up (`6040075`)

This follow-up used an immutable `6040075c6cb95be5881cc2e1b76ef7d71f4e5d29`
checkout on Linux x86-64, pinned Bun 1.4.2 and PGLite 0.4.3. It reused the
retained fixture's 5,600-page/eight-section seed, isolated environment, fetch
refusal and real-CLI transaction preload. Automatic WAL repair was disabled
(`GBRAIN_PGLITE_WAL_REPAIR=off`). No private corpus or live brain was opened.

The scratch aging workload intended two deterministic cycles followed by
restoring the small bodies and running reindex. Each page transaction replaced
its body with 131,072 bytes of base64-encoded deterministic xorshift32 output
and replaced its chunks with 32 slices of 4,096 bytes. Every fourth page was
deleted and reinserted, including its synthetic tag; other pages were updated
in place. This used actual `pages`, `content_chunks` and cascade relationships,
but raw SQL rather than the importer for aging. The high-entropy payload is a
write-pressure probe, not representative prose, embeddings or elapsed aging.
The first cycle stalled early, so neither a complete aging cycle nor the
intended 3.6 GB condition was achieved.

An independent Python process sampled CPU/RSS, directory sizes and last trace
every two seconds. The initial aging launcher had a one-hour deadline; follow-up
commands had individual deadlines. All had an 8 GiB per-store cap and a 6 GiB
sampled-RSS cap. The four stalls in the table were externally SIGKILLed after
120 seconds without trace progress, then reaped. Store copies and file hashes
were retained; the first churn and reindex crash images were copied before
reopening their working stores. The
scratch generator and diagnostic scripts were not added to installed tooling.

| Phase | Completed transactions | Last trace before termination | Store / WAL at stop |
| --- | ---: | --- | ---: |
| First churn, Bun 1.4.2 | 449 | `body_done`, zero-based page 449 | 905.9 / 528 MiB |
| Same recovered state, Bun 1.3.14 | 397 additional | `begin`, page 846; no `body_done` | 1,212.0 / 544 MiB |
| Same recovered state, Bun 1.4.2 | 397 additional | `begin`, page 846; no `body_done` | 1,212.0 / 544 MiB |
| Real reindex after first recovery, Bun 1.4.2 | 5,519 page transactions | `begin`, transaction 5,520; no `body_done` | 1,072.9 / 544 MiB |

Sizes are sums of logical file lengths, not database row sizes. The first
churn grew the directory from 97,542,394 to 949,920,385 bytes and WAL from
48 to 528 MiB (33 segments). Its final `body_done` was at
`2026-09-23T22:51:11.535Z`; the external kill was 120 seconds later. During
the stall one thread remained near 100% CPU, directory sizes stopped changing,
and repeated `/proc/<pid>/io` snapshots were identical. Six of seven separate
debugger samples contained `clock_gettime`; their unnamed frames did not
identify the Postgres function. All four rows above ended by SIGKILL, not by
a returned database error or a successful launcher exit.

The first reopen exited zero with exactly 449 changed pages. Page 449 retained
its original body and one legacy chunk, while page 448 had its new body and
32 chunks. All 5,600 pages and tags remained; no chunks were missing or
orphaned, and concatenating each changed page's ordered chunks recovered its
body exactly. Both runtime-repeat reopens also exited zero and retained
exactly 846 changed pages with the same consistency checks passing. These
checks do not prove every index or every recovery path is healthy.

The measured reindex command remained the real CLI:

```sh
"$BUN_1_4_2" --no-env-file \
  --preload "$CHECKOUT/test/fixtures/reindex-markdown-perf.ts" \
  "$CHECKOUT/src/cli.ts" reindex --markdown --no-embed --json --repo "$ROOT/notes"
```

It ran on the first recovered, partially churned store, not on a fresh control.
The last transaction began at 193.12 seconds; the external watchdog terminated
the child at 315.27 seconds. Reopening found exactly 81 pending pages, with no
current-version pages missing chunks, mismatched projection revisions or
missing tags. A new invocation completed all 81 in 14.31 seconds, with one
additional statistics transaction, zero failures and zero pending pages. A
fresh inspection passed the same consistency checks; the immediate no-op
committed zero transactions. There was no connection recycling inside either
CLI invocation.

A direct PGLite probe on Node 24.18.0, bypassing GBrain's engine wrapper, also
stalled on a copy of the same recovered state after 397 further transactions.
Statement markers locate that stop in `INSERT content_chunks`, rather than
COMMIT. An external V8 CPU profile captured 9,082 samples over 10.05 seconds,
all at `wasm-function[1298]`. The shipped WASM export table maps index 1298 to
`XLogFlush`; its sampled ancestry contains two `XLogFlush` frames. The binary
has no name or source-map section, but exported function indices still allow
this partial attribution. This names a function in the synthetic follow-up,
not in the original macOS sample, and does not yet identify the faulty branch
or justify a checkpoint/reconnect patch.

A second direct-PGLite/Node probe started from a newly seeded store, with no
prior crash, and stopped at the first churn's same `body_done` boundary on
page 449. Its 10.08-second profile contains 9,025 samples. The hot ancestry
maps to `CommitTransactionCommand` → `XLogFlush` → unnamed frames → `pg_usleep`
→ `nanosleep` → `_emscripten_get_now`. This independently locates a synthetic
COMMIT clock loop without relying on the recovered-store insertion failure.
The intermediate unexported functions and the original macOS stack still need
attribution; these observations do not establish a production fix.

The useful change in evidence is a bounded synthetic pressure failure, including
an actual reindex stop and successful process-level resume. It is not another
passing fresh-store benchmark, a reproduction of the complete reported platform
and store, or proof that all these stops share one cause.

### Schema-free PGLite control

A final bounded control removed GBrain's schema, triggers and engine wrapper.
It created only `pressure(id integer PRIMARY KEY, payload text NOT NULL)` in a
fresh PGLite 0.4.3 store, with zero user triggers and only the built-in `plpgsql`
extension. Each transaction inserted one deterministic 131,072-byte text value.
Both Node 24.18.0 and Bun 1.4.2 committed exactly 3,905 rows, then stopped after
`body_done` for row 3,905. Their external watchdogs ended the processes with
SIGKILL. Both stores stopped at 1,110,343,985 logical bytes, including 528 MiB
of WAL, and both reopened successfully with rows 0 through 3,904, correct
payload lengths and matching first/last payload hashes. This is not a full
payload or index-integrity audit.

The Node profile contains 8,998 samples over 10.04 seconds. Its hot ancestry
again includes `CommitTransactionCommand`, `XLogFlush`, the same unexported
intermediate frames, `pg_usleep`, `nanosleep` and `_emscripten_get_now`. The
minimal reproduction rules out GBrain's schema and wrappers as prerequisites
for this Linux pressure failure; the second runtime also rules out a
Bun-only prerequisite.

The PostgreSQL source pinned by PGLite's 0.4.3 release, commit
`0c98d7c9c9bd3b0d01cb6728c4802b705f05ee54`, provides a concrete upstream lead.
Its WAL writer can request a checkpoint when a segment completes;
`RequestCheckpoint` runs `CreateCheckPoint` synchronously under `__PGLITE__`.
The commit path sets `DELAY_CHKPT_START` before flushing WAL and clears it
afterward, while checkpoint creation waits on that flag with `pg_usleep`.
This is consistent with a checkpoint waiting on the transaction that called
it. The original macOS stack and a direct runtime observation of those flag
values are still missing, so this wave adds neither an engine patch nor a
checkpoint/reconnect workaround, and does not close #5284.
