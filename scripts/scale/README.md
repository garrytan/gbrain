# Scale tier harness

The nightly and label-gated scale tier (`.github/workflows/scale-tier.yml`) runs this harness; the gate shape and cadence are in [docs/TESTING.md](../../docs/TESTING.md#scale-tier).

`bun run test:scale -- --pages 10000 [--engine pglite|postgres] [--seed 1]
[--corpus-dir <dir>] [--import-mode cli|content] [--enforce] [--out <file.json>]`
(`scripts/scale/run.ts`) generates a deterministic two-source brain from the
seed (`scripts/scale/fixture.ts`: links, timeline bullets, `## Facts` and
`## Takes` fences, partly overlapping bodies, island pages, a seeded dense vector in 16 dimensions
per page), and imports it into a fresh brain under a temporary `GBRAIN_HOME`:
PGLite in a fresh data dir, or Postgres in a fresh database created from
`DATABASE_URL` and dropped afterwards. The default `--import-mode cli` writes
the Markdown corpus once into `--corpus-dir` (reused while its manifest
matches) and runs the real `gbrain import` per source, timing each file from
its progress events; `--import-mode content` keeps the per-page
`importFromContent` loop. It then extracts links, timeline, facts and takes,
writes the vectors onto every chunk so the vector arm runs keylessly through
`queryEmbedFn`, and measures p50 over five runs after a warmup for each op,
each with a known-answer check: `get_health`, `list_pages`, local and MCP-path
`search`, a source-scoped grant search, hybrid `query` with an injected
vector, `traverse_graph`, `get_backlinks` and `find_orphans`, plus a
cold-process first query and two concurrent receipt-bearing `put_page`s.
`find_orphans` is checked with one call at the op's maximum page size: its
rows must hold every fixture island and match `total_orphans`. It
captures every statement each op sends and replays the reads under
`EXPLAIN ANALYZE` for the planner check. With the brain closed, it then runs
the large-brain operational ceilings through the real CLI
(`scripts/scale/f4d.ts`), each an enforced data check with its measurement in
the report's `f4d` section: a `gbrain sync` of a fresh source (1,000 files at 10k and up) past a 1 s
progress-aware deadline completes (`f4d_sync_deadline`); `gbrain embed
--stale` against a local stub embedding endpoint stops at its time budget with
exit 11, the remaining count and the resume command (`f4d_embed_budget_stop`;
nothing leaves the machine); `gbrain serve` answers initialize and a search
without hitting its boot deadline (`f4d_serve_boot`); and at 20,000 pages and
up, `gbrain sources add` registers a 20,000-file checkout on a fresh managed
brain (`f4d_sources_add_20k`). Each phase logs its start and end, so a run
stopped by a job timeout shows where it was. The report leads with the headline
metric, MCP search p50 at the run's size as shipped (no manual ANALYZE).

Exit codes: 0 when every enforced gate passes, or always without `--enforce`;
1 when an enforced gate fails (each failure names the gate and op and prints
its EXPLAIN; the JSON report and a `.explain.txt` land next to `--out`);
2 on a usage error; 3 when the harness itself crashed (not a verdict).
The import-rate gate compares the last 10% of pages' per-page cost with the
first 10% (<= 1.5x) and the total import with the time at the halfway mark
(<= 2.5x). The report and its JSON `import` section carry both bases for every
engine: wall time (`elapsed_ms`) and the import process's main-thread CPU time
(`cpu_ms`, user + system, from each progress tick; in-process timing under
`--import-mode content`). PGLite is judged on CPU time: the database runs
synchronously on the import's main thread, so that CPU time holds all of its
work (and not the runtime's GC and JIT helper threads), while wall time
also counts time a shared CI host gives the CPU to other tenants, which once
failed a run with no code change. Postgres is judged on wall time, because the
server's work never shows up in the import process's CPU time.

Enforced under `--enforce`: import rate, known answers, no-op re-import,
no duplicates across sources, the import phase timer, and the stats-dependent
gates (`PLANNER_HEALTH_ENFORCED` in `scripts/scale/gates.ts`): the Nested Loop
inner-loop gate on the key plans, the budgets phase timer, and planner stats.
Planner stats are probed after the first timed op, because F4b analyzes on the
first planner-sensitive read, and only hot tables above 500 rows must have
`pg_stats` rows (PGLite only: on Postgres autovacuum owns statistics, so a missing row is report-only).
Interactive ceilings and calibrated budgets (`scripts/scale/budgets.json`,
written by `--calibrate`) stay report-only until
`bun scripts/scale/trend.ts` prints "ceilings stable" over the last five
nightly runs; a reviewer then sets the repo variable
`GBRAIN_SCALE_ENFORCE_CEILINGS=1`. The same script picks the nightly sizes.
Reproduce any report with the command it prints. The fixture's determinism
is pinned by `test/scripts/scale-fixture.test.ts`, the gate policy by
`test/scripts/scale-gates.test.ts` and `scale-trend.test.ts`, the
`find_orphans` known answer by `test/scripts/scale-orphans-verifier.test.ts`,
and a 40-page enforced run by `test/scripts/scale-harness.slow.test.ts`.

The harness runs as a child of `scripts/scale/watchdog.ts`. A PGLite statement
runs synchronously inside WASM, so an in-process timer cannot fire during a
stall; the supervisor times each watched phase (`import`, `extract`,
`vectors`, `budgets`) from the child's `[scale] phase <name> start` lines and
kills the child's process group at 1.5x the phase's gate ceiling (extract and
vectors get 1.5x of half and a quarter of the import ceiling). The diagnostic names the phase, elapsed
time against the limit and the last progress line; the supervisor then removes
the brain home and scale database. Override one limit for a local
investigation with `GBRAIN_SCALE_PHASE_LIMIT_MS_<PHASE>` (for example
`GBRAIN_SCALE_PHASE_LIMIT_MS_VECTORS=3600000`). The vectors phase prints one
line per batch with its time, dimension and RSS. 20k cells run under a
130-minute job cap, and `scripts/scale/trend.ts` promotes the nightly size to
50k only when both engines wrote a 20k report. `test/scripts/scale-watchdog.test.ts`
blocks a child's main thread and checks the named failure arrives within the
limit plus grace.
