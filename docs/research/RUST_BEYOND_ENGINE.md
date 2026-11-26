# Which parts of gbrain beyond the storage engine should move to Rust (research only, 2026-11-23)

Measured on master `13812b7780` (v0.60.766.0). Research only: no code changed, nothing here changes
the plan of record in [RUST_ENGINE.md](../designs/RUST_ENGINE.md). Proposed edits to that plan are in
"Proposed edits to the plan of record" at the end.

## TL;DR

We learned that the TypeScript above the storage engine is not where gbrain spends its time. On
every PGLite path we measured, the database itself took 63% to 81% of the CPU. On Postgres, the
database server used more CPU than the gbrain process on sync (18.5 s against 13.4 s) and on the
mention pass (22.5 s against 14.9 s). The Rust engine already targets that share. The one big cost
outside the engine is not TypeScript logic either. The release binary spends about 0.5 s parsing
its 41 MB JavaScript bundle before every command, and Bun's bytecode build flag removes it
(`gbrain get` 0.65 s to 0.09 s on Postgres, same output byte for byte).

You should keep the Rust work on the engine through Dec 1 and managed mode, ship the release
binary with `--bytecode` (a one-flag TypeScript build change), fix two hot spots in the TypeScript
mention matcher, and move nothing else to Rust yet. After managed mode, the first real Rust
candidates beyond the engine are the mention and link scanner (a pure, CPU-bound function) and the
sync preparation work that sits next to the Rust write path.

Top 5, ranked by measured win for the risk:

1. **Ship the release binary with Bun's bytecode flag (TypeScript build change, not Rust).** Every
   CLI call on the release binary pays about 0.53 s before gbrain runs any of its own code. With
   `--bytecode --format=esm`, `gbrain get` drops from 0.65 s to 0.09 s on Postgres and from 0.83 s
   to 0.25 s on PGLite, and the MCP server starts in 0.12 s instead of 0.70 s. Six commands gave
   byte-identical output. Cost: the binary grows from 216 MB to 290 MB. This removes most of the
   reason to want a Rust CLI.
2. **Keep Rust on the engine until it supports managed mode.** PGLite is 78% of the CPU of a
   1,000-file sync, 80% of MCP serving and 81% of the mention pass. The Rust vector scan is still
   slower than Postgres HNSW (337 ms against 55 ms p50 at 10k pages, reported from gbrain-evals
   draft [PR 605](https://github.com/garrytan/gbrain-evals/pull/605)). Nothing outside the engine
   is worth an engine-sized effort before that gap closes.
3. **Fix the mention matcher in TypeScript now; port the scanner to Rust later.** On Postgres, two
   small Korean and Japanese boundary checks (`hasHangulMatchBoundary`, `hasKatakanaMatchBoundary`
   in `src/core/by-mention.ts`) took 3.7 s of the 17.8 s the profiler sampled in the gbrain process
   during the mention pass, on an English-only corpus. They re-test every token of every candidate name with a regular expression on each try.
   After that fix, the gazetteer scan is the best Rust candidate beyond the engine: pure, CPU-bound,
   deterministic, and easy to check against TypeScript on the link rows it writes. Mark: later.
4. **Fold sync preparation into the Rust write path when Rust supports managed mode.** The
   persistence layer (sync discovery, digest, journal, group publish) was 19% of the gbrain
   process's CPU in a Postgres sync of 1,000 changed files and 6% on PGLite. Rust already owns the
   durable commit, so this belongs inside that work, not as a separate port. Mark: later.
5. **Leave search fusion and rerank in TypeScript until per-stage numbers say otherwise.** On a
   Postgres MCP search, the TypeScript search stages used about 9 ms of a 25-30 ms request, spread
   over about fifteen small functions with no single hot spot. A parallel per-stage profiling run
   in gbrain-evals covers this question and its numbers are still pending (see "Open gap").
   Mark: later, as one move with the engine, never function by function.

The case the maintainer may not picture: **a Rust engine does not make the CLI start faster.** The
engine loads inside the same Bun process, so the 0.5 s bundle parse stays until the build changes.
And a Rust CLI would not just be a faster front door. The 236 CLI commands and 187 MCP tools listed in
`docs/contracts/public-surface.json` are generated from `src/core/operations.ts` and lean on npm packages a Rust binary cannot load (the AI
SDK providers, the tree-sitter WASM grammars for code chunking, zod schemas that become the MCP
tool schemas, the MCP SDK). A Rust CLI either rewrites that surface (about 175,000 lines of
commands alone) or starts Bun anyway and saves only the last 60 ms that bytecode leaves.

## The table

Time share is the share of sampled CPU in the gbrain process for that path (Bun's `--cpu-prof`,
1 ms sampling, source run), each sample charged to the nearest gbrain or package frame above it.
"DB server" is Postgres server CPU in the same window. Lines are TypeScript, tests excluded.

| Subsystem | Lines | Measured share | What Rust would win | Cost and risk | Crosses the agent contract? | Mark |
|---|---:|---|---|---|---|---|
| CLI start and command table (`src/cli.ts`, `src/cli/`) | 11,087 (+174,275 in `src/commands/`) | 0.53 s of 0.65 s (`get`, release binary, Postgres) is bundle parse; gbrain's own startup work is under 15 ms | about 60 ms per call after bytecode; a single binary already exists | very high: rewrite or shell back into Bun; loses npm ecosystem | yes: every CLI and JSON output byte-exact | **keep TypeScript**; ship `--bytecode` |
| MCP server (stdio and HTTP, `src/mcp/`) | 7,038 | PGLite 80% engine; Postgres: MCP layer 5.6%, operations 3.6% | about 1 ms per request | high: MCP SDK, 173 tool schemas from zod | yes: names, shapes, `_meta` channels | **keep TypeScript** |
| Operations contract (`src/core/operations.ts`, `ops/`) | 22,869 | 0.7-3.6% | none measurable | very high: the single source CLI and MCP are generated from | yes | **keep TypeScript** |
| Sync orchestration (`src/commands/sync/`, `src/core/sync*`) | 17,459 | 0.4-1.3% | none measurable | high | yes: sync status JSON, holds | **keep TypeScript** |
| Persistence: discovery, digest, journal, publish (`src/core/persistence/`) | 86,204 | sync 1k: 19.1% on Postgres, 6.3% on PGLite; doctor 12.7% on Postgres | part of that 19% | high: write receipts, exit 10, crash recovery | yes: receipts, `write-request` | **later**, inside the Rust write path with managed mode |
| Markdown and frontmatter parse (`src/core/markdown*`) | 1,771 | sync 1k: 5.9% on Postgres, 1.5% on PGLite | a few percent of sync | medium: YAML edge cases, held files | yes: `content_hash`, frontmatter, the markdown format | **keep TypeScript** |
| Chunking (`src/core/chunkers/`) | 4,622 | 0.5% of a 1k sync | none measurable | medium: tree-sitter WASM grammars, chunk boundaries feed embeddings | indirectly: chunk text and ids | **keep TypeScript** (per-stage import numbers pending) |
| Embedding pipeline (`src/core/embed*`, `src/core/ai/`) | 8,491 + 18,902 | 0.1-0.4% here (keyless brain); real cost is the provider network call | none: network bound | high: provider SDKs | yes: embedding input text | **keep TypeScript** (batching numbers pending) |
| Search fusion and rerank (`src/core/search/`) | 31,982 | Postgres MCP search: 24.8% of client CPU, about 9 ms per request over about 15 functions | a few ms per search | high: ranked output, eval gate (D5) | yes: ranked results | **later**, pending per-stage numbers |
| Mention pass and link/timeline extraction (`src/core/mentions/`, `by-mention.ts`, `link-extraction.ts`) | 9,239 | mention pass: 42.2% of sampled gbrain CPU on Postgres (3.7 s of 17.8 s in two CJK checks), 10.7% on PGLite | the scan, after the TypeScript fix | low-medium: pure function, parity on link rows | link rows only, not output format | **fix in TypeScript now; Rust later** |
| Dream and synthesis cycle (`src/core/cycle/`) | 32,242 | keyless phases 0.9-1.3 s; the real cost is model calls | none: model bound | high | yes: pages written, cycle JSON | **keep TypeScript** |
| Job queue workers (`src/core/minions/`) | 26,135 | `jobs smoke` 0.8-1.0 s, queue round trip 0.13 s | the queue storage is already engine scope | high: leases, fencing | yes: job states | **keep TypeScript** (queue storage stays in the engine plan) |
| Doctor (`src/commands/doctor/`) | 35,280 | 4.6-10.8 s (medians per build); PGLite 63% engine; Postgres: driver 20%, doctor code 12.9% | under 1 s | high: about 240 check files | yes: doctor JSON, fixes | **keep TypeScript** |
| Repair commands | 3,848 | preview about 1.0-1.2 s total | none | medium | yes | **keep TypeScript** |
| Schema migrations (`src/core/migrate.ts`, `schema-migrations/`) | 14,550 | fresh init 2.4 s (Postgres) to 3.5 s (PGLite, 74% engine) | none: runs once | high: one schema text, both engines | yes: schema | **keep TypeScript** |
| File watching (`src/core/ingestion/sources/`, `serve-head-watcher.ts`) | 754 | not measurable; waits on OS events | none | low | no | **keep TypeScript** |
| Owner IPC (PGLite persistence socket; Rust owner IPC in `src/core/rust-engine/owner-ipc/`) | 2,073 (Rust side) | a CLI `get` while `serve` runs on the brain: 0.11 s on PGLite against 0.25 s standalone | small: that path is already cheaper than opening PGLite | medium | internal protocol only | **keep TypeScript** (the Rust side already exists for Rust brains) |

## Measured numbers

Machine: one Vorflux cloud sandbox, Intel Xeon 6975P-C, 8 vCPUs, 31 GiB RAM, Linux 7.0 (AWS),
network disk. Bun 1.4.5. Postgres 17.10 on the same machine (local socket over TCP, `shared_buffers`
1 GB, `en_US.UTF-8`, pgvector). Build: master `13812b7780281f7bc27c8f62d9c594f69caac490`. The Rust
engine was not built or measured here, because the machine had no Rust toolchain, and Rust numbers below
are reported from other runs.

Corpus: 10,000 pages from the scale fixture (`scripts/scale/fixture.ts`, seed 1): 7,000 notes,
2,000 people, 1,000 companies; 20,000 chunks, 2,971 links, 20,000 timeline entries; keyless (no
embeddings, no paid calls). Half was loaded with `gbrain import --no-embed`, half as a git
checkout through `gbrain sources add` and `gbrain sync`. Paid API spend: $0.

Three ways to run gbrain were compared:

- **release binary**: `bun build --compile` exactly as `.github/workflows/release.yml` builds it
  (216 MB);
- **bytecode binary**: the same with `--bytecode --format=esm` added (290 MB);
- **source**: `bun src/cli.ts`, which is what `bun install -g github:garrytan/gbrain` users run.

### Cold CLI start (wall seconds, median of N=10; doctor N=3)

| Command | PGLite release | PGLite bytecode | PGLite source | Postgres release | Postgres bytecode | Postgres source |
|---|---:|---:|---:|---:|---:|---:|
| `--version` | 0.56 | 0.03 | 0.03 | 0.53 | 0.03 | 0.03 |
| `get <slug>` | 0.83 | 0.25 | 0.45 | 0.65 | 0.09 | 0.26 |
| `search <word>` | 0.96 | 0.34 | 0.66 | 0.74 | 0.13 | 0.43 |
| `query <words>` (keyword only) | 1.12 | 0.52 | 0.83 | 0.82 | 0.20 | 0.50 |
| `stats --json` | 0.91 | 0.35 | 0.58 | 0.65 | 0.11 | 0.31 |
| `doctor --json` | 10.78 (6.30-11.40) | 5.21 | 6.15 | 5.21 | 4.60 | 5.46 |

What the profile shows. In the release binary, 540 of 683 ms of a cold `get` is one anonymous
native frame, the parse and compile of the 41 MB `cli.js` bundle (5,169 modules, including the
tree-sitter grammars' loaders). The bytecode build skips that step. Opening PGLite costs about
0.16 s more than opening Postgres (0.25 s against 0.09 s with bytecode). In a source run the cost
is module loading: in a cold `search`, 140 ms went to npm module initialization (110 ms of it in
`jsonc-parser`'s scanner) and 50 ms to initializing `src/core/fence-repair/quote-markers.ts`.
A Bun binary that prints one line starts in under 10 ms, so the floor is the runtime, not gbrain.

### MCP server round trip (`gbrain serve`, stdio; 3 runs of 50 calls each, ms)

| Brain, build | Start to `initialize` reply | First `get_page` | `get_page` p50 / p95 | First `search` | `search` p50 / p95 |
|---|---:|---:|---:|---:|---:|
| PGLite, release | 913-927 | 214-254 | 6.2-6.7 / 17-27 | 166-182 | 41-44 / 69-83 |
| PGLite, bytecode | 284-294 | 166-179 | 6.2-6.9 / 18-21 | 141-146 | 41-42 / 70-78 |
| PGLite, source | 630-685 | 249-266 | 6.0-6.1 / 17-21 | 164-181 | 40-41 / 69-84 |
| Postgres, release | 680-726 | 209-226 | 7.6-7.9 / 10-13 | 93-110 | 30-31 / 35-41 |
| Postgres, bytecode | 121-125 | 176-181 | 7.2-8.3 / 12 | 69-75 | 29-31 / 39-42 |
| Postgres, source | 450-462 | 258-264 | 7.4-7.9 / 10-12 | 97-99 | 28-30 / 40-42 |

`tools/list` returned 173 tools in 6-16 ms. A warm request is fast on every build; the build only
changes start time. The first call of each tool costs 40-260 ms more than later calls on every
build, so it is warm-up inside gbrain, not bundle parse. CPU share over 201 rounds of `get_page`
plus `search` (source run): PGLite 79.9% in PGLite, 3.9% search code, 1.8% MCP layer. Postgres:
24.8% search code, 22.4% Postgres driver, 5.6% MCP layer, 3.6% operations layer.

### Sync of 1,000 changed files (5,000-page git source in a 10,000-page brain; release binary)

Each round appended one line to the same 1,000 files and committed, then ran
`gbrain sync --source notes --no-pull`.

| Brain | Round 1 wall | Round 3 wall | gbrain CPU (user + sys) | DB server CPU | Peak RSS |
|---|---:|---:|---:|---:|---:|
| PGLite | 42.4 s | 41.4 s | 48.7 s | (in process) | 0.74 GB |
| Postgres | 11.8 s | 11.7 s | 13.4 s | 18.5 s | 0.40 GB |
| No-change sync, PGLite / Postgres | 1.33 s / 1.02 s | | | | |

CPU share of the gbrain process (round 2, source run with profiling: PGLite 44.5 s, Postgres 12.0 s):

| Bucket | PGLite | Postgres |
|---|---:|---:|
| PGLite (WASM and its JavaScript driver) | 77.9% | n/a |
| Postgres driver (vendored postgres.js and sockets) | n/a | 33.9% |
| Persistence (discovery, digest, journal, publish) | 6.3% | 19.1% |
| Engine TypeScript (`pglite-*`, `postgres-engine`, `engine-sql`) | 5.8% | 6.0% |
| Link, timeline and mention extraction | 1.5% | 7.5% |
| Markdown and frontmatter parse | 1.5% | 5.9% |
| Config reads | 0.6% | 2.5% |
| Import write path | 0.5% | 1.6% |
| Sync orchestration | 0.4% | 1.3% |
| Chunking | under 0.1% | 0.5% |
| Other gbrain code, npm packages, runtime | 5.6% | 21.7% |

### The other subsystems (release binary unless marked)

| Path | PGLite | Postgres | Where the CPU went |
|---|---|---|---|
| Mention pass, `extract --stale --catch-up` over 5,000 changed pages (source run) | 49.5 s wall, 52.9 s CPU, 1.9 GB peak RSS | 17.9 s wall, 14.9 s CPU, server 22.5 s | PGLite 80.7%, extraction 10.7%; Postgres: extraction 42.2% (two CJK checks 3.7 s, `attachedVerb` 0.5 s, `stripCodeBlocks` 0.4 s, `loadConfigFileOnly` 0.4 s), driver 30.0% |
| `doctor --json` (source run) | 7.4 s | 5.8 s, server 3.2 s | PGLite 63.4%; Postgres: driver 20.0%, doctor 12.9%, persistence 12.7% |
| Fresh `init` (every schema migration) | 3.5 s | 2.4 s | PGLite 73.7%; Postgres: driver 36.8%, migrations 15.9% |
| `dream` keyless phases (lint, backlinks, orphans) | 1.3 s | 0.9 s | the filesystem phases skip on a brain without `--dir`; real dream cost is model calls |
| `jobs smoke` | 0.97 s | 0.81 s (queue round trip 0.13 s) | start-up dominated |
| `repair frontmatter` preview | 1.2 s | 1.0 s | start-up dominated |
| CLI `get` while a `gbrain serve` process is running on the same brain (bytecode) | 0.11 s | 0.09 s | on PGLite, 0.14 s faster than a standalone `get` (0.25 s); the mechanism was not traced |

Whole-command import numbers, for context only (per-stage import profiling is covered elsewhere,
see "Open gap"): `import` of 5,000 pages took 117 s on PGLite (100 s CPU) and 99 s on Postgres
(37 s gbrain CPU, 55 s server CPU); the first `sync` of the 5,000-page git source took 141 s on
PGLite and 58 s on Postgres (32 s gbrain CPU, 103 s server CPU).

## Mechanics

### Why the engine stays the only Rust target for now

Every path we profiled on PGLite spent most of its CPU inside PGLite: sync 77.9%, MCP serving 79.9%,
mention pass 80.7%, init 73.7%, doctor 63.4%. That share is exactly what the Rust engine replaces.
On Postgres the same work moves to the server, and the server used more CPU than gbrain on sync
and the mention pass. The TypeScript above the engine is a minority everywhere except the mention
matcher on Postgres, and there the biggest piece is a fixable TypeScript hot spot.

### Why bytecode, and what it does not fix

The release binary embeds one 41 MB JavaScript bundle. Bun parses and compiles it on every start,
about 0.53 s on this machine, before gbrain's own code runs. `--bytecode` stores the compiled form
in the binary. The plain `--bytecode` build fails on this codebase (a top-level `await` in
`src/commands/auth.ts`); `--bytecode --format=esm` builds in about 10 s and ran every command we
tried. Outputs of `get`, `search --json`, `stats --json`, `--help`, `doctor --help` and
`query --json` were byte-identical to the release binary on the Postgres brain. Not yet checked:
the full test suite against a bytecode binary, macOS, and whether the 73 MB size increase matters
for downloads. Users who install with `bun install -g` run the source and pay about 0.2 s of module
loading instead; lazy imports of the heaviest modules (`jsonc-parser`, the fence-repair markers,
the operation manifest) would cut part of it.

### Why not a Rust CLI

A Rust front end would save at most the 60 ms per call that bytecode leaves, and it would have to
reproduce 236 commands' text and JSON byte for byte or start Bun anyway for most of them. It would
also cut gbrain off from the packages it depends on. They include the AI SDK and provider SDKs (OpenAI, Anthropic,
Google), the MCP SDK, zod (which generates the MCP tool schemas), js-yaml (frontmatter),
web-tree-sitter with its WASM grammars (code chunking) and PGLite itself. It would also lose the
`bun install -g github:` install path. Contributors would need Rust to change any command.

### The mention matcher fix

`findMentionedEntities` calls `hasHangulMatchBoundary` and `hasKatakanaMatchBoundary` for each
candidate match. Each call runs `entry.tokens.every(regex.test)` before it can return "not
Korean / not Japanese", so the same name's tokens are re-tested at every position where it could
match. Computing the two flags once per gazetteer entry would skip the work for Latin-script names.
That is an estimate from the profile, not a measured fix: the 3.7 s is the self time of those two
functions. `loadConfigFileOnly` also ran often enough to cost 0.4 s in the same pass. Both fixes
are TypeScript changes for all engines and are not part of this research.

### When the Rust candidates become worth it

- **Mention and link scanner.** Worth porting when the mention pass is a measured wall-time problem
  on a real brain after the TypeScript fix. It is a pure function from page text and a gazetteer to
  mention rows, so parity is a direct row comparison. Calls must be batched (a whole page set per
  call), because one napi call per page would add crossing cost on small pages.
- **Sync preparation.** Worth folding in when Rust supports managed mode, because the digest and
  journal work sits next to the durable commit Rust already owns. Moving it earlier would split one
  crash-safety protocol across two languages.
- **Search fusion.** Worth moving only as one unit with the engine's arms, after the per-stage
  numbers, because ranked output needs the eval gate (D5) and the cost is spread thin.

### Inputs mapped to the plan of record

| Area | Today | This research |
|---|---|---|
| Keyword ranking | The Rust engine owns the keyword, title and facts arms in `ts_rank` compatibility mode (D5); BM25 is a separate test on `rust-engine/bm25-ranker` | Not re-evaluated |
| Hybrid merge and slug boost | Shared TypeScript; no move planned | Open candidate; per-stage numbers pending |
| Import, chunking, embedding batches | Shared TypeScript; Rust owns batch row import and the durable commit | Chunking is 0.5% of a sync; import per stage pending |
| Link and timeline extraction | Rust stores links and timeline and serves graph walks; the markdown parse stays TypeScript | Parse is 1.5-5.9% of a sync; the mention matcher is the hot part |
| Sync, watch, shadow follower | TypeScript; Rust owns the sync write path; nothing moves before Dec 1 | Persistence is 19% of Postgres sync client CPU: later, with managed mode |

## Open gap

A separate per-stage profile of `query` and `import` on the 10k brain on all three engines, run
from gbrain-evals, is pending. This page does not repeat it. Its ranked list should settle mark 5 above
(search fusion) and the table's pending chunking and embedding batch marks, and it should give the
Rust engine's own numbers on the same paths, which this page could not measure (no Rust toolchain on the machine).

## Proposed edits to the plan of record

These are proposals for [RUST_ENGINE.md](../designs/RUST_ENGINE.md); this page does not change it.

1. **Performance, "cold open to first `get`":** measure engine open separately from process start.
   On the release binary, process start (0.53 s) hides the engine open (0.16 s on PGLite) that the
   50 ms target is about.
2. **Non-goals:** keep "No Rust rewrite of the CLI, MCP server, operations, hybrid fusion, chunkers,
   embedding, persistence coordinator or doctor", and cite this page as the measurement behind it.
3. **Deferred:** add two entries with entry criteria. A Rust mention and link scanner, after the
   TypeScript fix, when the mention pass is a measured wall-time problem on a real brain. Sync
   preparation (discovery, digest, journal) inside the Rust write path, once Rust supports managed
   mode.

## How to reproduce

All runs used isolated `HOME` and `GBRAIN_HOME` directories, `GBRAIN_SELF_UPGRADE_MODE=off` and
`GBRAIN_SWEEP=0`, with `DATABASE_URL` unset. The corpus came from `generateScaleFixture({ pages:
10000, seed: 1 })` and `writeScaleCorpus` in `scripts/scale/fixture.ts`. Wall time, CPU and peak RSS
came from `/usr/bin/time`. Postgres server CPU came from the postmaster's own, reaped-children and
live-children CPU counters in `/proc`, read before and after each command. CPU shares came from
`bun --cpu-prof` profiles, each sample charged to the nearest frame with a gbrain or package source
URL (WASM frames count as PGLite). The MCP numbers came from a small stdio JSON-RPC client that
sends `initialize`, `tools/list`, then alternating `get_page` and `search` calls.
