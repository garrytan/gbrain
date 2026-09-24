# Markdown reindex COMMIT investigation (#5284)

## Disposition

**not-reproduced-with-evidence** on the synthetic Linux fixture below. This is
not a fix or a claim that the reported macOS failure is resolved. No production
reindex or engine behavior was changed for this investigation.

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

To diagnose the reported wedge rather than this passing workload, run the
bounded harness on macOS ARM64 with the reported Bun version, or supply a
**generic synthetic generator** that reproduces the relevant aged-store/WAL
pressure. The fixture's fresh, compressible text and much smaller store do not
match the report's 3.6 GB state. No private corpus is needed or requested.

A failing run must retain its last transaction marker and external process
sample. `body_done` without `committed` narrows the failure to the completion
path; a named WASM stack would be needed to identify the Postgres-side spin.
Until that evidence exists, periodic reconnects or checkpoint commands would
be speculative mitigations, not an established root-cause fix.
