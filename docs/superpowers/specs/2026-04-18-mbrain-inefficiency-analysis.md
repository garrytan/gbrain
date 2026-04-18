# MBrain Inefficiency Analysis and Improvement Priorities

**Date:** 2026-04-18
**Status:** Analysis memo for internal cleanup and follow-up design work
**Scope:** Current `mbrain` repository inefficiencies in architecture, performance, and maintenance

---

## Executive Summary

The right next move for `mbrain` is to improve the existing TypeScript/Bun codebase rather than replace it.

The repository already has a real product shape:

- `src/core/engine.ts` defines a meaningful engine boundary
- `postgres`, `sqlite`, and `pglite` are all implemented
- the CLI and MCP surfaces are partially centralized through `src/core/operations.ts`
- local/offline mode is implemented, not hypothetical
- the codebase is large enough that cleanup is cheaper than replacement

The main inefficiencies are not distributed evenly. The most important ones are:

1. duplicated behavior across the three engine implementations
2. partial split between contract-first operations and CLI-only command paths
3. mixed Postgres connection ownership through instance and singleton access
4. full-scan local vector search in SQLite
5. local import throughput limits caused by engine capability gaps
6. code-to-doc drift after the local-first transition
7. missing benchmark baselines for performance work

The highest-leverage direction is:

1. remove structural duplication first
2. isolate orchestration from storage and CLI bootstrap
3. fix the real local bottleneck in SQLite semantic search
4. improve local import throughput
5. add explicit benchmarks so future performance claims are measurable

This memo intentionally excludes implementation-language replacement planning. The decision here is to improve `mbrain` in its current stack.

---

## Review Goal

The goal of this review is to identify where the current `mbrain` codebase is inefficient, why those inefficiencies matter, and what order of work will produce the most value.

This review focuses on three questions:

1. which inefficiencies are architectural versus purely runtime
2. which inefficiencies most directly affect local/offline users
3. which cleanup sequence reduces long-term cost instead of just moving code around

---

## Evidence Reviewed

### Code structure

- `src/cli.ts`
- `src/core/engine.ts`
- `src/core/engine-factory.ts`
- `src/core/operations.ts`
- `src/core/postgres-engine.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/db.ts`
- `src/core/import-file.ts`
- `src/core/search/hybrid.ts`
- `src/core/search/vector-local.ts`
- `src/commands/import.ts`

### Docs

- `docs/architecture/infra-layer.md`
- `docs/local-offline.md`

### Repository shape

Notable large files at review time:

- `src/core/sqlite-engine.ts`: 1303 lines
- `src/core/operations.ts`: 816 lines
- `src/core/postgres-engine.ts`: 770 lines
- `src/core/pglite-engine.ts`: 736 lines
- `src/cli.ts`: 524 lines
- `src/commands/import.ts`: 250 lines

These counts matter because the inefficiency story is not abstract. It is visible in where complexity has accumulated.

---

## What Is Already Strong

## 1. The engine boundary is worth preserving

`src/core/engine.ts` gives the project a real storage contract instead of letting each command or tool speak directly to a backend.

That matters because:

- multiple runtime modes already share the same conceptual interface
- CRUD, chunks, links, tags, timeline, raw data, versions, stats, ingest log, and config are modeled consistently
- future cleanup can happen behind a stable surface

The inefficiency problem is therefore not "there is no architecture." The problem is that the architecture is not yet exploited aggressively enough.

## 2. Local/offline mode is already a first-class product path

`docs/local-offline.md` and the current config defaults show that `mbrain` has crossed the line from cloud-oriented prototype to real local tool.

The important implication is that local inefficiencies are no longer second-order:

- SQLite search behavior matters
- local import throughput matters
- low-memory and low-friction execution matter

## 3. Contract-first operations are the right direction

`src/core/operations.ts` is a meaningful asset. It centralizes a growing part of:

- CLI surface
- MCP tool surface
- tools JSON

That direction should be extended rather than abandoned.

---

## Main Inefficiency Areas

## 1. Engine implementation duplication is the biggest structural inefficiency

The largest maintainability problem is repeated behavior across:

- `src/core/postgres-engine.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pglite-engine.ts`

The files do not merely wrap backend-specific SQL. They each carry significant behavior for:

- search methods
- timeline methods
- version methods
- stats and health reporting
- migration handling
- CRUD semantics

This creates real costs:

- feature work fans out across multiple engines
- fixes risk backend skew
- tests have to cover the same intent through multiple code paths
- the local engines become more expensive to evolve independently

The key point is that the repository already has an interface boundary, but too much shared business behavior still lives inside concrete engines.

### Why this matters

This duplication multiplies both implementation cost and design drift. The more the project grows, the more expensive every new capability becomes because each engine file must be modified separately.

### Recommended direction

Refactor the engine layer into:

- backend-specific primitives: connection, dialect, search/index capability hooks, transaction wiring
- shared persistence services: page writes, chunk reconciliation, tag reconciliation, versioning, stats shaping, health shaping
- capability flags: explicit statements about which engines support raw Postgres access, parallel workers, ANN/vector indexing, file storage, and similar features

### Design target

The concrete engine files should primarily answer:

- how does this backend connect
- how does it execute queries
- which capabilities does it support

They should not each re-implement as much product behavior as they do now.

---

## 2. Command architecture is split between operations and CLI-only flows

`src/cli.ts` still keeps a large `CLI_ONLY` set, including:

- `import`
- `embed`
- `serve`
- `doctor`
- `setup-agent`
- `migrate`
- `config`
- `call`
- and several maintenance commands

That leaves the repository with two command models:

- contract-first operations in `src/core/operations.ts`
- direct CLI dispatch in `src/cli.ts`

### Why this matters

This split creates avoidable inefficiency in:

- help and UX consistency
- argument validation
- automation surface
- reasoning about which commands are part of the "real" product contract
- reuse between CLI, MCP, and future automation

It also keeps `src/cli.ts` larger than it needs to be.

### Recommended direction

Separate command behavior into three layers:

1. bootstrap layer
   - process startup
   - config loading
   - engine connection
   - help/version output

2. service layer
   - rich workflows such as `import`, `sync`, `embed`, `doctor`, `setup-agent`

3. contract layer
   - stable operation definitions that can be projected to CLI and MCP

Not every command must become an MCP tool, but every command should have a clear reason for living outside the shared contract.

### Design target

`src/cli.ts` should become thin. The heavy logic should move to service modules, while the operation/CLI split becomes intentional instead of accidental.

---

## 3. Postgres connection ownership is inefficiently split

`src/core/postgres-engine.ts` currently supports:

- instance-scoped connections through `this._sql`
- module-global singleton access through `src/core/db.ts`

That is explicitly kept for backward compatibility.

### Why this matters

This split complicates the mental model:

- worker flows use isolated instances
- the main CLI path can still rely on module-global state
- transaction scoping and lifecycle reasoning are less clean than they should be
- future refactors must preserve two ownership patterns instead of one

This is not just stylistic untidiness. It makes concurrency and test isolation harder to reason about.

### Recommended direction

Pick one ownership model for Postgres access:

- explicit engine-scoped connection ownership, or
- explicit connection provider injection

Either is better than keeping both hidden behind fallback behavior.

### Design target

There should be one obvious answer to the question:

> "Where does this query get its connection from?"

Right now there are two answers.

---

## 4. Local SQLite vector search is the clearest user-facing performance bottleneck

`src/core/sqlite-engine.ts` implements `searchVector()` by:

- selecting all chunk rows with embeddings
- loading them into memory
- passing them to `src/core/search/vector-local.ts`
- computing cosine similarity over the full candidate set
- sorting results in-process

This means local semantic search is effectively a full scan over the embedding corpus.

### Why this matters

This is the most concrete runtime inefficiency in the repository because it affects the local/offline profile directly.

Its cost is not limited to the cosine loop itself:

- candidate loading grows with corpus size
- memory pressure grows with corpus size
- search latency grows with corpus size
- query expansion in `src/core/search/hybrid.ts` multiplies the number of vector passes

The important conclusion is that the main problem is algorithmic and indexing-related, not just implementation-language speed.

### Recommended direction

Treat this as a search architecture project, not a micro-optimization project.

Candidate paths:

- SQLite vector extension or index support
- `sqlite-vec`-style indexed retrieval
- two-stage retrieval where keyword or metadata narrowing reduces vector candidates before scoring
- dedicated local ANN sidecar if SQLite-native indexing is not good enough

### Design target

Local semantic search should stop doing corpus-wide scans as the default retrieval path.

---

## 5. Local import throughput is limited by engine capability decisions

`src/core/engine-factory.ts` reports parallel worker support only for `postgres`.

`src/commands/import.ts` therefore:

- enables multi-engine workers for Postgres
- falls back to serial processing for local engines

This means the local/offline path currently pays a throughput penalty even when work could be parallelized safely at some stages.

### Why this matters

For local users importing large knowledge corpora, this directly impacts:

- initial import time
- refresh time after larger note updates
- overall perceived product responsiveness

### Recommended direction

Split import into stages and parallelize only the safe stages:

- file discovery
- markdown parsing
- chunk building
- embedding requests or embedding queue preparation
- batched write scheduling

The write path itself may still need controlled serialization per engine, but the current design ties the whole workflow to the weakest stage.

### Design target

Local engines should not be "serial by default" just because their DB connection model is simpler.

---

## 6. Rich workflows are still too command-file-centric

Commands like:

- `import`
- `sync`
- `embed`
- `doctor`
- `setup-agent`

are substantial workflows, not simple command wrappers.

### Why this matters

When orchestration lives inside command files:

- reuse becomes harder
- tests must often reach through CLI-oriented entry points
- behavior is harder to compose from other surfaces
- command files become de facto service layers without saying so

### Recommended direction

Introduce explicit service modules for workflow-heavy behavior, and make command files responsible mainly for:

- parsing args
- loading config
- selecting output mode
- calling a service

This would complement the operation cleanup rather than compete with it.

### Design target

Command files should be thin adapters, not the primary home of business flow.

---

## 7. Documentation drift is a maintenance inefficiency

`docs/architecture/infra-layer.md` still describes:

- OpenAI `text-embedding-3-large`
- 1536-dimension embeddings
- a more cloud-shaped architecture narrative

But the actual local-first path has already moved to:

- local embedding provider support
- `nomic-embed-text`
- 768-dimension embeddings
- SQLite/PGLite-aware local operation

### Why this matters

This kind of drift wastes engineering time in indirect ways:

- design discussions start from stale assumptions
- contributors trust docs less
- future refactors risk preserving already-dead architecture ideas

### Recommended direction

Treat architecture docs as part of the system boundary and update them together with behavior changes.

At minimum:

- align embedding model and dimension references
- align search diagrams with actual local behavior
- distinguish Postgres-first and local/offline paths explicitly

### Design target

A future cleanup should not have to re-discover current architecture from code because the docs lag behind it.

---

## 8. There is no explicit performance baseline yet

The repository has functional verification, but it does not yet have a strong benchmark story for the areas now under scrutiny.

That means improvement work risks becoming subjective:

- "feels faster"
- "seems cleaner"
- "probably scales better"

Those are not enough once the project reaches this level of maturity.

### Recommended direction

Add benchmark baselines for:

- local import throughput
- sync throughput
- local keyword search latency
- local semantic search latency
- memory footprint during import and query
- result quality guardrails for semantic search changes

### Design target

Every major efficiency change should have a before/after measurement path.

---

## Priority Order

The inefficiencies are not equally urgent. A good order of work is:

## P0: establish measurement and fix the clearest local bottleneck

1. benchmark harness for import and search
2. redesign local SQLite vector retrieval so it stops doing full scans
3. update architecture docs so the cleanup effort is working from current reality

This phase produces the fastest user-visible gains and improves decision quality for later work.

## P1: reduce structural fanout

1. consolidate shared engine behavior
2. introduce workflow/service modules
3. shrink `CLI_ONLY` by clarifying what belongs in the operation layer
4. remove mixed Postgres connection ownership

This phase reduces the long-term cost of every later feature or performance change.

## P2: improve local throughput and capability modeling

1. redesign local import pipeline for safe parallel stages
2. formalize engine capability descriptors
3. decide how much infrastructure `sqlite` and `pglite` should share

This phase improves scalability and keeps local/offline from becoming a second-class path.

---

## Suggested Workstreams

## Workstream 1: Engine consolidation

Goal:

- reduce repeated behavior across `postgres`, `sqlite`, and `pglite`

Primary outputs:

- shared persistence helpers
- clearer backend capability boundaries
- smaller engine files

## Workstream 2: Command and service layering

Goal:

- make CLI bootstrap thin and move rich workflows into reusable service modules

Primary outputs:

- clearer command ownership
- less duplication between CLI and operation definitions
- easier test boundaries

## Workstream 3: Local search performance

Goal:

- replace default full-scan vector retrieval in SQLite local mode

Primary outputs:

- indexed or narrowed candidate retrieval
- lower latency
- lower memory pressure

## Workstream 4: Local import throughput

Goal:

- allow local engines to use more of the available machine without breaking DB safety

Primary outputs:

- staged concurrency
- clearer import pipeline structure
- measurable throughput gains

## Workstream 5: Documentation and measurement discipline

Goal:

- keep the architecture narrative aligned with the code and add hard baselines for efficiency work

Primary outputs:

- updated architecture docs
- benchmark suite
- repeatable performance comparisons

---

## Questions To Answer Before Detailed Implementation Planning

1. Which responsibilities should move out of concrete engines first?
2. Should `sqlite` and `pglite` share one larger local-engine substrate?
3. Which commands should become service-backed before they become operation-backed?
4. What is the intended long-term local vector retrieval architecture?
5. Which benchmark thresholds count as meaningful wins for search and import?
6. How much complexity is acceptable to improve local throughput without making the codebase harder to operate?

---

## Recommended Decision

The recommended decision is:

**Improve `mbrain` in place by attacking the current inefficiencies directly, starting with local search, structural duplication, and benchmark discipline.**

More concretely:

1. keep the current TypeScript/Bun product line
2. treat engine duplication as the primary maintainability problem
3. treat SQLite full-scan vector search as the primary local performance problem
4. treat contract drift between CLI, operations, and docs as the primary design-coherence problem
5. add benchmark baselines before claiming large performance wins

---

## Bottom Line

`mbrain` is no longer at the stage where replacing it is the cheapest form of cleanup.

It is now valuable enough that the important engineering work is:

- reducing duplicated internal structure
- fixing the real local bottlenecks
- clarifying layer boundaries
- making performance work measurable

That is the path that improves both day-to-day velocity and the quality of the local-first product.
