# Research maps: the Rust rewrite of gbrain

These maps describe what TypeScript gbrain does today, so a Rust storage engine
and, later, a Rust binary can match it. TypeScript gbrain is the reference.
`garrytan/gbrain-evals` is the parity oracle. The plan of record is
[docs/designs/RUST_ENGINE.md](../../designs/RUST_ENGINE.md) (PR #9593). The
draft in [docs/plans/PLAN.md](../../plans/PLAN.md) is kept as research.

The maps are research only. They describe the code at a pinned commit, not a
promise about current behavior. Every claim cites `path:line` at that commit;
re-check a citation after gbrain moves.

## Reference pins

| Repo | Commit | Notes |
|---|---|---|
| `garrytan/gbrain` (reference) | `master` `8bbfd0b5e8` | VERSION `0.60.733.0`, read on 2026-11-16 |
| `garrytan/gbrain-evals` (parity oracle) | `main` `cd447b3ae` ("Release v0.10.237") | pins gbrain at `6ce7195b44a0` |

## Maps

### Storage engine

Overview, hardest parity risks and open questions:
[storage-engine.md](storage-engine.md).

| Map | What it covers |
|---|---|
| [brain-engine.md](brain-engine.md) | Every `BrainEngine` member by family: signature, behavior, SQL, PGLite vs Postgres differences, tests, and binding options for a third engine. |
| [schema.md](schema.md) | Every table, column, index, function, trigger and migration, with readers and writers. |
| [postgres-features.md](postgres-features.md) | Every Postgres-specific feature (pgvector, full-text search, pg_trgm, JSONB, triggers, locks, `SKIP LOCKED`, RLS), what depends on it, and embedded Rust replacements. |

### Agent-facing contract

Overview, key numbers, contract risks and open questions:
[agent-contract.md](agent-contract.md).

| Map | What it covers |
|---|---|
| [cli.md](cli.md) | All public CLI commands, flags, `--json` output, the error envelope and exit codes. |
| [mcp.md](mcp.md) | All MCP tools: transports, scopes, surfaces, wire shapes and JSON schemas. |
| [brain-format.md](brain-format.md) | The markdown brain: layout, frontmatter, fences, slugs, links, import, sync, export and the content hash. |
| [agent-and-eval-usage.md](agent-and-eval-usage.md) | How gbrain-evals and gbrain's own skills use the CLI, MCP and library imports. |
| [data/](data/) | Machine-readable snapshots of the operation manifest, `tools/list` per surface and the public-surface lists. Regenerate with `bun docs/research/rust-engine/scripts/dump-contract-data.ts <gbrain-checkout> docs/research/rust-engine/data`. |

### Jobs, tests and subsystems

| Map | What it covers |
|---|---|
| [background-jobs.md](background-jobs.md) | Background jobs, workers, schedulers and daemons. |
| [subsystems.md](subsystems.md) | One entry per `src/core` subsystem. |
| [test-suites.md](test-suites.md) | Test tiers, suites, fixtures and what a Rust parity harness can reuse. |

### gbrain-evals (the parity oracle)

Overview and recommendation: [gbrain-evals.md](gbrain-evals.md). Appendices:

| Map | What it covers |
|---|---|
| [brainbench-categories.md](gbrain-evals/brainbench-categories.md) | BrainBench categories and their metrics. |
| [longmemeval-and-memory-benchmarks.md](gbrain-evals/longmemeval-and-memory-benchmarks.md) | LongMemEval and the other memory benchmarks. |
| [runner-subdirs-a.md](gbrain-evals/runner-subdirs-a.md) | Runner subdirectories, part A. |
| [runner-subdirs-b.md](gbrain-evals/runner-subdirs-b.md) | Runner subdirectories, part B. |
| [workload-suites-systems-harness.md](gbrain-evals/workload-suites-systems-harness.md) | Workload suites, the `eval/systems` protocol and the harness. |
| [probes-and-experiments.md](gbrain-evals/probes-and-experiments.md) | Probes and experiments. |
| [datasets-and-published-results.md](gbrain-evals/datasets-and-published-results.md) | Every dataset with size and origin, and the published numbers. |
| [imports.md](gbrain-evals/imports.md) | Which gbrain internals each eval file imports. |
| [engine-selection.md](gbrain-evals/engine-selection.md) | How each runner would select a Rust `BrainEngine`. |
| [scripts-tests-ci.md](gbrain-evals/scripts-tests-ci.md) | gbrain-evals scripts, tests and CI. |

## Where the Rust work lives

Plan decision D1: the maps, the plan and the Rust code all live in
`garrytan/gbrain`. The earlier `garrytan/gbrain-rust` repository is no longer
used. These maps first appeared on its research branches; the commits are
listed in the plan's research map section.
