# Efficiency bench harness

Opt-in benchmark scripts for the Efficiency crew. Nothing here runs in CI or ships in the CLI.
Brain data (pulled pages, synthetic brains, PGLite files, results) lives under
`$BENCH_WORK` (default `~/.capy/work/brain`) and must never be committed. Result rows hold
counts, sizes and timings only.

Requires Bun >= 1.4 (the repo's `engines.bun`) and Docker for the Postgres engine.

| File | What it does |
|---|---|
| `lib.ts` | Row schema (machine, engine, brain, pages, chunks, command, mode, N, p50, p95), percentiles, CLI runner, provider price table. |
| `preload-instrument.ts` | `bun --preload` hook. `BENCH_USAGE_LOG` records every outbound HTTP call (host, path, ms, model, token usage; no bodies). `BENCH_ENGINE_TIMING` times every PGLite/Postgres engine method (outermost calls only) and process CPU. No product code changes. |
| `materialize-pull.ts` | Pull directory -> importable markdown dir (`content` copied, field-only pages re-serialized, oversize pages replaced by size-matched synthetic stand-ins). |
| `synth-brain.ts` | `shape` (manifest -> shape JSON, counts/sizes only), `full-shape` (~5,000 pages over 8 sources), `gen` (deterministic synthetic brain, `--scale`, `--seed`). |
| `bench-import.ts` | Fresh isolated brain (GBRAIN_HOME) per engine; times init, per-source import, `extract all`, `embed --stale`; engine/HTTP/CPU split per phase; in-process parse and chunk probe; tokens and USD from provider usage. |
| `bench-hot.ts` | Hot paths, cold (fresh CLI process per sample) and warm (one long-lived `gbrain serve` stdio MCP process): search, query with/without expansion, get_page, list_pages, recall, doctor, MCP stdio startup + call, HTTP serve startup + call, one-page sync. |
| `probe-pg.ts` | Warm stdio MCP tool against a Postgres bench brain with `pg_stat_statements` reset around N calls: p50/p95, DB time per call, top statements (placeholders only). `--jit off` A/Bs Postgres JIT for the run. |
| `probe-cold.ts` | Cold CLI start split: bun start, module graph, `--version`, real reads, each with stdout piped and with `GBRAIN_FLUSH_GRACE_MS=0` (the non-TTY exit-flush grace). |
| `probe-rerank.ts` | Direct Voyage `/v1/rerank` grid over `top_n_in x max_doc_tokens` and models on candidate sets drawn from a Postgres bench brain: billed tokens/call, $/1k queries, p50/p95, top-5 agreement with the 25x1400 default (a drift signal, not quality). Spends ~$0.1 per 20-query grid. |
| `probe-mcp-start.ts` | MCP stdio cold start: fresh `gbrain serve` per sample, spawn -> initialize, spawn -> tools/list, first tools/call latency and spawn -> first call, after each `--idle-ms` gap; interleaves several `--cli` trees and prints the tools/list size and hash per tree (equal hashes = byte-identical list). |
| `bench-chunk.ts` | In-process chunk pass: parse every page of a synthetic brain directory (or `--cjk <pages>` for a generated mixed CJK / Latin / emoji corpus), then time the importer's `prepareMarkdownChunks` over all pages for `--n` passes after a warm-up. Prints p50/p95 per pass and a sha256 over every chunk, so a before/after pair doubles as an equivalence check. |
| `vector-scope-share.ts` | Vector search latency and recall per source scope against an existing Postgres or PGLite brain (GBRA-71): `searchVector` per scope, recall of result pages against the exact statement, page share, the chunk count the engine routes on, underfilled exits; `--remote` adds the private-page rule. |
| `remote-rows.ts` | Rows for hosted-brain read latency recorded during a pull. |
| `report.ts` | JSONL -> markdown tables (`results/report.md`). |
| `run-all.sh` | Orchestrates data prep, both engines, all datasets, report. |

## Run

```bash
export BENCH_WORK=~/.capy/work/brain          # default
bun run bench:efficiency default-pull synth-1x synth-full   # = scripts/bench/efficiency/run-all.sh
# one brain, one engine
bun scripts/bench/efficiency/bench-import.ts --engine pglite --data $BENCH_WORK/import/synth-1x --label synth-1x --embed --max-usd 1
bun scripts/bench/efficiency/bench-hot.ts --engine pglite --label synth-1x --n 20 --only search,query_expand
bun scripts/bench/efficiency/report.ts
# Postgres statement probe and cold-start split
bun scripts/bench/efficiency/probe-pg.ts --label synth-full --tool list_pages --args '{"limit":50}' --jit off
bun scripts/bench/efficiency/probe-cold.ts --label synth-full --engine postgres
# chunk pass and scoped vector search, before/after from two pinned worktrees
bun scripts/bench/efficiency/bench-chunk.ts --data $BENCH_WORK/import/synth-full --n 20
bun scripts/bench/efficiency/vector-scope-share.ts postgresql://postgres:postgres@127.0.0.1:5440/bench_synth-full sessions notes-b all --queries 25 [--remote]
# CPU profile of one phase
bun scripts/bench/efficiency/bench-import.ts ... --cpu-prof   # writes .cpuprofile under engines/<engine>-<label>/bench-run/
```

Postgres uses a `pgvector/pgvector:pg16` container named `gbrain-bench-pg` (`BENCH_PG_CONTAINER`) on `127.0.0.1:5440`
(`run-all.sh` starts it); each brain gets its own database `bench_<label>`.

## Caveats

- Cold CLI rows include Bun start, TypeScript load, config, engine connect and exit, the cost a
  shell-out agent pays per call. Warm rows are what an MCP-connected agent pays.
- Query, search and recall rows include provider round trips (query embedding, rerank, and for
  `query` with expansion an LLM call), so they move with provider latency.
- Embedding cost is the provider-reported token usage times `lib.ts` prices.
