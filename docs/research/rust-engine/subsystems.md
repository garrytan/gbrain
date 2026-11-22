# Subsystem map (`src/core`)

Top-level map of every `src/core` subsystem in the TypeScript reference, so later research maps and port plans can link into it. Reference: [garrytan/gbrain](https://github.com/garrytan/gbrain) at `origin/master` commit `8bbfd0b5e8` (v0.60.x), read on 2026-11-16. All paths are relative to that repo root. Statements were checked in code unless marked "(unverified)".

Related maps: [background-jobs.md](./background-jobs.md) and [test-suites.md](./test-suites.md). The BrainEngine interface, schema tables and Postgres features are in [brain-engine.md](./brain-engine.md), [schema.md](./schema.md) and [postgres-features.md](./postgres-features.md); this map names those features only where a subsystem depends on them.

## Size of the codebase

| Area | .ts files | Lines |
|---|---:|---:|
| `src/` total | 3,752 | about 844,000 |
| `src/core/` subdirectories (81) | 2,321 | 477,304 |
| `src/core/*.ts` top-level files | 536 | 165,513 |
| `src/commands/` | 296 top-level command files | 169,159 (incl. subdirectories) |
| `src/mcp/` | 23 | 6,875 |

The architecture is contract-first: `src/core/operations.ts` composes about 204 operations (per the generated manifest) from which both the CLI and the MCP server are generated. `docs/contracts/public-surface.json` lists 220 CLI commands, 186 MCP tools, and 503 config keys. Engines are pluggable (`pglite` WASM or `postgres`), and most SQL is shared through `src/core/engine-sql/` with two dialect adapters.

## How to read this map

- Each of the 81 directories has one entry (purpose, key files, dependencies, external services, Postgres features, and a "Rust port notes" line) inside one of five themed sections. The 536 loose top-level files are grouped into clusters in three alphabetical sections.
- The index below links each directory to its section. Inside a section, entries are `###` headings named after the directory.
- The loose top-level files are in [a-e](#top-level-srccore-files-a-e), [f-r](#top-level-srccore-files-f-r), and [s-z plus code outside src/core](#top-level-srccore-files-s-z-and-code-outside-srccore).
- Each section ends with its own parity risks and open questions; the consolidated list is below.

## Directory index

Counts are `.ts` files and lines under each directory, including nested subdirectories (section bodies may also count non-.ts files).


| Directory | .ts files | Lines | Section |
|---|---:|---:|---|
| `access/` | 28 | 5,240 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `advisor/` | 18 | 1,628 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `agent-install/` | 7 | 766 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `ai/` | 103 | 19,146 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `audit/` | 8 | 1,515 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `backup/` | 9 | 2,432 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `belief/` | 20 | 4,083 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `bench/` | 3 | 600 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `bootstrap/` | 32 | 12,951 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `brainstorm/` | 6 | 2,727 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `budget/` | 6 | 1,564 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `calibration/` | 7 | 1,436 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `chronicle/` | 19 | 2,968 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `chunkers/` | 11 | 4,362 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `claw-test/` | 9 | 1,295 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `cli-socket/` | 9 | 1,216 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `code-intel/` | 6 | 628 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `company-brain/` | 14 | 2,113 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `connectors/` | 19 | 3,633 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `content-repair/` | 5 | 673 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `context/` | 38 | 12,778 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `conversation-parser/` | 10 | 3,762 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `creds/` | 6 | 1,515 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `cross-modal-eval/` | 5 | 812 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `cycle/` | 92 | 28,769 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `eligibility/` | 11 | 1,597 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `engine-sql/` | 26 | 8,718 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `enrich/` | 1 | 215 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `entities/` | 5 | 1,479 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `eval/` | 5 | 807 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `eval-contradictions/` | 15 | 2,821 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `eval-shared/` | 1 | 164 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `extract/` | 2 | 538 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `facts/` | 97 | 19,502 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `feedback/` | 5 | 1,059 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `fence-repair/` | 31 | 6,209 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `generations/` | 22 | 3,096 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `git/` | 8 | 2,926 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `google/` | 22 | 6,417 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `grants/` | 13 | 1,988 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `guests/` | 12 | 1,131 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `harness/` | 12 | 1,606 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `ingestion/` | 11 | 3,236 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `loops/` | 2 | 491 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `maintenance/` | 3 | 786 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `meetings/` | 7 | 807 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `mentions/` | 10 | 2,293 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `minions/` | 123 | 26,101 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `notifier/` | 6 | 869 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `onboard/` | 8 | 1,897 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `ops/` | 77 | 21,793 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `output/` | 9 | 1,608 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `page-body/` | 34 | 10,006 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `page-state/` | 23 | 3,065 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `page-window/` | 4 | 1,139 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `persistence/` | 353 | 83,827 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `pglite-engine/` | 2 | 225 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `postgres-engine/` | 13 | 1,499 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `progressive-batch/` | 5 | 1,257 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `questions/` | 10 | 1,780 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `remediation/` | 7 | 1,267 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `repair/` | 77 | 19,779 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| `resolvers/` | 5 | 896 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `schema-migrations/` | 317 | 13,112 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `schema-pack/` | 40 | 8,635 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `search/` | 122 | 31,251 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `setup/` | 25 | 6,269 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `shared-skills/` | 36 | 4,868 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `skillify/` | 2 | 395 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `skillopt/` | 31 | 7,516 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `skillpack/` | 41 | 12,018 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `skills/` | 29 | 4,670 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `slack/` | 6 | 891 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `storage/` | 3 | 553 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `storage-manifest/` | 6 | 1,090 | [Storage, engines, and persistence](#storage-engines-and-persistence) |
| `takes-quality-eval/` | 10 | 1,221 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `think/` | 12 | 3,793 | [Retrieval, AI, and reasoning](#retrieval-ai-and-reasoning) |
| `transcripts/` | 26 | 7,256 | [Content model, ingestion, and connectors](#content-model-ingestion-and-connectors) |
| `trust/` | 31 | 6,638 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `verbs/` | 10 | 2,578 | [Access control, setup, skills, and CLI platform](#access-control-setup-skills-and-cli-platform) |
| `wakeshift/` | 7 | 1,044 | [Jobs, cycle, and maintenance](#jobs-cycle-and-maintenance) |
| **All 81 directories** | **2,321** | **477,304** | |


## Top parity risks (consolidated)

1. **Persistence is not a separate engine; it is Postgres-backed write coordination.** `persistence/` (353 files, about 84k lines) is a request journal, owner election, sync cursors, effect journal, and the PGLite-to-Postgres graduation state machine. Its request states and error codes (`WRITE_REQUEST_STATES`, `WRITE_ERROR_CODES`) are returned to agents.
2. **Transaction-scoped advisory locks and transaction-local settings.** Generations, mentions, chronicle, facts, admission, and budget use `pg_advisory_xact_lock`; trust triggers read `set_config` values such as `gbrain.write_trust_tier`. Rust must pass that context explicitly and provide per-key mutual exclusion.
3. **Keyword and vector ranking.** `websearch_to_tsquery`, `ts_rank`, `phraseto_tsquery`, and pgvector HNSW (with iterative scan) define search order; scores feed confidence and CRAG thresholds. pg_trgm is not used.
4. **Markdown format round-trips.** `## Facts` / `## Takes` fences with `gbrain:facts:begin/end` markers, frontmatter parsing (js-yaml), page-body segment offsets, and link-type inference must be byte-exact.
5. **Agent-facing contract files.** `agent-output.ts`, `error-registry.ts`, `exit-codes.ts`, the operation manifest, and `verbs.ts` response schemas define JSON envelopes and exit codes; parity tests will check these first.
6. **RLS-only behavior.** `access/`, `guests/`, `eligibility/`, and `shared-skills/` use row-level security and refuse with `permission_denied` when tables are hidden. An embedded store has no such layer, so those error paths must be emulated or dropped deliberately.
7. **Embedding staleness rules.** `embedding-dim-check.ts`, `embedding-invalidation.ts`, and `embedding-restamp.ts` decide when vectors are stale; a different hash or signature re-embeds every brain.
8. **Regex registries.** `conversation-parser/builtins.ts` (about 1,100 lines), `secret-scan.ts`, and write-gate patterns must give identical matches in Rust regex.

## Open questions for Garry (consolidated)

1. **Scope of the persistence layer.** Does the Rust target keep multi-writer coordination (write journal, owner election, effect journal, graduation), or is it a single-process store? This is the largest scope decision in the codebase.
2. **Engine surface.** One embedded engine only, or keep a `pglite`/`postgres`-style engine switch and the settings-based `openEngine` API? Must Rust import existing PGLite or Postgres brains, and keep the 318-version migration ledger?
3. **Access model.** Keep role-based access (RLS-hidden tables, guest sources, folder rules, trust tiers) in the embedded port, or treat the single process as fully trusted?
4. **Contract freeze.** Are all about 204 operations, 220 CLI commands, and 186 MCP tools frozen for v1, or can some be dropped (for example `shared-skills`, the OAuth provider, the warm CLI socket, PGLite repair tools)?
5. **Integrations in v1.** Which host integrations (`bootstrap/`, `setup/`: Claude Code, Codex, OpenClaw, and others), connectors (Google, Slack, Fireflies, cookie-based ChatGPT / Claude.ai), and storage backends (S3, Supabase) ship first?
6. **LLM-backed features.** Which of `think`, `ai/decide`, the semantic query cache, belief, eval harnesses, and calibration are required for v1 parity, and which can ship later?

---


## Storage, engines, and persistence

Reference: `src/core/` at `8bbfd0b5e8` (v0.60.x). Counts are `*.ts` files and lines from `find`/`cat`, not counting the top-level anchors unless stated.

### Anchors (top-level files, brief)

| File | Lines | Role |
|---|---|---|
| `src/core/engine.ts` | 2,890 | `BrainEngine` interface and shared row/option types (`SourceRow`, `FileRow`, `TransactionOptions`). Detailed in the BrainEngine map. |
| `src/core/engine-factory.ts` | 31 | `createEngine(config)`; dynamic imports so PGLite WASM loads only for PGLite users. |
| `src/core/engine-construct.ts`, `engine-connect.ts` | small | Build an unconnected engine of `config.engine`; throw-only connect used by the CLI and status-only serve paths. |
| `src/core/engine-open.ts` | 200 | `openEngine(settings)` for `gbrain/engine-open` (experimental, off by default). `DEFAULT_EMBEDDED_POOL_MAX = 4`. |
| `src/core/pglite-engine.ts` | 3,088 | `PGLiteEngine` class. Imports `@electric-sql/pglite`; embeds `vector` and `pg_trgm` extensions (`pglite-engine.ts:33`). |
| `src/core/postgres-engine.ts` | 3,182 | `PostgresEngine` class over the vendored postgres.js driver (imported via the `#postgres` alias to `vendor/postgres`). |
| `src/core/db.ts` | 677 | postgres.js pool teardown with a hard time bound (#1972) plus legacy DB helpers. Imports `engine-sql`. |

The `pglite-engine/` and `postgres-engine/` directories hold helpers that the two big class files call. The class logic itself is in the top-level files.

### persistence (353 files, 83,827 lines)

This is not a second, non-Postgres storage engine. It is a Postgres-backed write-coordination and durability layer for managed brains (brains whose pages live as files in a git-tracked directory and are synced into the database). It is one flat directory with no subfolders. Its state lives in tables such as `persistence_requests`, `persistence_topology_changes`, `persistence_graduation`, and `persistence_brain` (`schema.ts`, `topology-schema.ts`, `writer-guard-schema.ts`). It also touches the filesystem and git directly (`node:fs` in about 87 imports, `node:child_process` in 4, `effect-git.ts`, `git-door.ts`, `sync-git-stream.ts`).

What it does, by sub-area (file counts by name prefix):

| Sub-area | Files | What it covers |
|---|---|---|
| `sync-*` | 67 | Managed sync: discovery, freeze/admit per entry, cursors, held deletions, breaker, drain, ghosts, tombstones. Largest single file: `sync-run.ts` (1,714 lines). |
| `connector-*` | 13 | Connector accounts, checkpoints, identity, errors, Google receipts. |
| `page-*` | 12 | Page request preparers (`page-prepare.ts`), batches, edits, uploads, visibility, purges. |
| `effect-*` | 12 | Side-effect journal and recovery (embedding, git, links). `effects.ts` (1,141 lines). |
| `graduation-*` | 11 | PGLite-to-Postgres move (`engine-graduation.ts`, 1,462 lines): plan, copy, verify, fence, flip routing, rollback. |
| `topology-*` | 8 | Source/worktree topology changes and their receipts. |
| `reconcile-*` | 8 | Reconciling filesystem and database state. |
| `git-*` | 8 | Git conversion, durability policy, canonical schema, push holds. |
| `worktree-*` | 5 | Worktree leases, links, manifests, refresh. |
| `consumer-*`, `owner-*` | 9 | Election of the resident writer ("owner"), heartbeats, lanes. |
| `purge-*`, `publication-*`, `capacity-*`, `atom-*`, `derived-*`, `memory-*`, `facts-*` | rest | Purge, publication deadlines, capacity forecasting, atoms and derived facts, memory and fact writes. |

The write path is a request journal. A write becomes a row in `persistence_requests` with states `queued`, `running`, `recovering`, `committed`, `conflict`, `failed`, `cancelled` (`types.ts`). An owner process prepares and publishes it in a transaction. Recovery scans the rows after a crash.

Postgres features it relies on (line hits in the directory): `FOR UPDATE` (98), `statement_timeout` and `lock_timeout` set per transaction (about 40 and 19 hits), advisory locks (`pg_advisory_xact_lock`, about 20 hits), `SET LOCAL` (18), `CREATE INDEX CONCURRENTLY` in migrations (12), `SKIP LOCKED` (8), `CREATE TRIGGER` (8), a PL/pgSQL writer-guard function `gbrain_require_managed_writer()` (`writer-guard-schema.ts`), partial indexes (`WHERE state <> 'committed'`), jsonb path reads (`intent->>'runId'`), `WITH RECURSIVE` (2), and RLS (2). `pgvector` appears once. No `LISTEN`/`NOTIFY` in this directory.

Dependencies: about 619 files outside the directory import from it. The heaviest importers are `core/repair` (68), `commands/doctor` (63), `core/schema-migrations` (33), `core/cycle` (28), and `core/ops` (24). It imports `engine.ts`, `ops/contract.ts`, `postgres-engine/pool-stats.ts`, and `page-state/`.

Rust port notes: this is the largest port surface, and it is mostly coordination logic, not SQL. A Rust design with embedded storage still needs the request journal, the one-writer election and fencing, the effect journal, and the graduation state machine. Most of the Postgres row-lock and trigger logic can become single-writer transactions in an embedded store. The git and filesystem parts stay as they are.

### pglite-engine (2 files, 225 lines; class in `pglite-engine.ts`, 3,088 lines)

Purpose: the embedded, in-process PGLite backend. The two helpers are `checkpoint-guard.ts` (171 lines) and `code-edges.ts` (54 lines, a PGLite-only read of code edges; the rest is in `engine-sql/code-edges.ts`).

Key files:
- `checkpoint-guard.ts`: PGLite runs Postgres in one process with no checkpointer. It watches WAL since the last redo point and refuses or triggers work before the WAL grows past the automatic-checkpoint limit (#5449, #5284).
- `code-edges.ts`: `getEdgesByChunk` for PGLite only.
- `pglite-engine.ts:31-33`: embedded WASM, fsBundle, and extension assets (`with { type: 'file' }`); the embedded `extensions` replace the stock `{ vector, pg_trgm }` imports.

Dependencies: `@electric-sql/pglite`; `engine-sql/` for nearly all SQL; `persistence/` for managed writes; `backup/snapshot.ts` calls `engine.db.dumpDataDir('none')`.

Postgres features: `pgvector` (`vector(dims)`, HNSW iterative scan via `vector-index.ts`), `pg_trgm`, and standard tsvector/GIN. Single-backend limits (no concurrent connections, WAL checkpoint behavior) are the main PGLite constraints.

Rust port notes: this is the direct analogue of the embedded store. The checkpoint guard and WASM lock issues disappear. The reference's own disaster-recovery doc still describes PGLite WASM lock wedges, so the Rust store must handle its own lock/recovery story.

### postgres-engine (13 files, 1,499 lines; class in `postgres-engine.ts`, 3,182 lines)

Purpose: wrap the Postgres pool and make its failure modes bounded. Each file is one guard or setting.

Key files:
- `init-schema-lock.ts` (239): deadlined acquisition of the `initSchema` advisory lock (#2898). Sets `application_name`.
- `schema-lock-timeout.ts` (165): bounded `lock_timeout` for DDL (#5227). Used by `migrate.ts`.
- `bounded-statement.ts` (110): `executeRaw` with `timeoutMs`, using `statement_timeout` (#6278).
- `keyword-statement-timeout.ts` (78) and `keyword-timeout-cache.ts` (251): per-statement bound on keyword search and a negative cache after SQLSTATE 57014 (#6495).
- `search-settings.ts` (119): transaction-local settings for search reads (#6039, #6721).
- `jit-off-statement.ts` (60): `SET LOCAL jit = off`.
- `read-write-transactions.ts` (76): every transaction declares read-write, with a retry for read-only refusals (#7183).
- `transaction-abort.ts` (87) and `reserved-transactions.ts` (111): abort signal cancels the running statement and discards the connection; `withReservedConnection`.
- `pool-stats.ts` (84) and `pool-stall-watch.ts` (76): reads the vendored driver's queues and warns on pool stalls (#6317, #6383).
- `cancellation.ts` (43).

Dependencies: vendored postgres.js (`vendor/postgres` via `#postgres`); `persistence/` and `engine-sql/` consume the settings.

Postgres features: advisory locks, `statement_timeout`, `lock_timeout`, `jit`, `default_transaction_read_only`, `application_name`, `SET LOCAL`. The guards are built around these settings. A transaction-mode pooler drops startup parameters, so `statement_timeout` is set per transaction.

Rust port notes: most of this disappears. An embedded store has no pool, no pooler, no lock-timeout dance, and no read-only retry. Keep the behavior that matters: a bounded wait on writes and a cancel path for long searches.

### engine-sql (26 files, 8,718 lines)

Purpose: one SQL implementation for both engines. Each domain file takes a `SqlExecutor` and never learns which engine it runs on. Two dialect adapters implement the executor: `dialect-pglite.ts` (76 lines) and `dialect-postgres.ts` (94 lines). `executor.ts` (113) and `fragment.ts` (98, `sqlFragment`) are the contract.

Key files:
- `pages.ts` (1,225), `chunks.ts` (1,210), `takes.ts` (712), `links.ts` (813), `facts.ts` (903): the domain SQL for the main tables. Statement text matches the Postgres master text, and SQL-text golden files check it.
- `page-body.ts` (552): segmented page storage, generation-ranged body manifest, staged chunk rows.
- `salience.ts` (384), `graph-rank.ts` (185), `health.ts` (273): ranking and health aggregates.
- `bootstrap.ts` (756): forward-reference bootstrap DDL and probes, one copy for both engines.
- `cjk-search.ts` (190): CJK keyword fallback, because `websearch_to_tsquery` with an ASCII stemmer cannot tokenize CJK.

Dependencies: `pglite-engine.ts` and `postgres-engine.ts` call into it through `engineSql`. Several ops files and `db.ts` import it.

Postgres features (line hits across the directory): `ANY(...)` (100), `RETURNING` (44), `ON CONFLICT` (31), `unnest` (27), `jsonb_to_recordset` (18), `LATERAL` (7), `FOR UPDATE` (7), `pg_trgm` `similarity()` (6), `ts_rank_cd` (5), `pg_advisory_xact_lock` (5), pgvector `<=>` (4), `WITH RECURSIVE` (3), `DISTINCT ON` (2), `websearch_to_tsquery` and `plainto_tsquery` (1 each), `SKIP LOCKED` (1). These are the statements the Rust port must reproduce in some form.

Rust port notes: this is the SQL that must be re-expressed, not copied. Plan a query-layer replacement behind the same `BrainEngine` surface. Full-text, trigram, and vector ranking need an embedded equivalent. The SQL-text golden files are a useful parity oracle.

### schema-migrations (317 files, 13,112 lines)

Purpose: versioned, idempotent DDL. Latest version is 318 (`latest.generated.ts`, `LATEST_SCHEMA_VERSION`). There are 313 `vNNN-*.ts` migration files, plus `helpers.ts` (207), `types.ts` (61), `registry.generated.ts` (639, a generated map of all migrations), and `latest.generated.ts`. Migration SQL is embedded as string constants because Bun `--compile` strips the filesystem.

Key files:
- `helpers.ts`: shared helpers (`analyzeDeferred`, `lockTableForAnalyze`, `withSchemaLockTimeout`, `migrationStatementTimeoutMs`). Leaf module, so `migrate.ts` can import it without a cycle.
- `types.ts`: the `Migration` record type.
- `registry.generated.ts`, `latest.generated.ts`: generated by `scripts/build-schema-migrations.ts`. Do not hand-edit.
- `v002-slugify-existing-pages.ts`: first data migration. `v003-unique-chunk-index.ts`: first index.
- `v035-auto-rls-event-trigger.ts`: auto-RLS event trigger; its SQL is engine-specific (`sqlFor`).
- `v075-op-checkpoints-table.ts`, `v077-mcp-spend-log.ts`, `v318-guard-ledgers-fail-closed.ts`: recent tables and guards.
- `migrate.ts` (618, outside this directory) runs them under `withSchemaMigrationLock`.

Postgres features in the migrations (SQL-text hits): GIN indexes (616), jsonb (116), `CREATE INDEX CONCURRENTLY` (99), RLS (`ENABLE ROW LEVEL SECURITY`, 56 hits in 28 files), HNSW vector indexes (31), pgvector `vector(` columns (13), `CREATE TRIGGER` (21), `CREATE EVENT TRIGGER` (3), `to_tsvector` and tsvector columns (20 and 8), `CREATE EXTENSION vector` (2), `pg_trgm` (1), `pg_advisory_xact_lock` (1), `SKIP LOCKED` (2), `NOTIFY` (1), `gen_random_uuid` (1).

Rust port notes: the DDL needs an embedded equivalent, and the 313-step history must be replayed or snapshotted. RLS, event triggers, and CONCURRENTLY index builds have no direct analogue. A fresh embedded store needs only the final schema plus a version record. The version history stays useful for importing existing Postgres brains.

### storage (3 files, 553 lines)

Purpose: binary file storage (uploads, attachments) behind one `StorageBackend` interface. Backend choice is by config.

Key files:
- `storage.ts` (outside the directory, 162 lines): the `StorageBackend` interface, `createStorage(config)` (line 47), and `settingsStorage(engine)` (line 83). Picks S3, Supabase, or local.
- `storage/s3.ts` (192): S3, R2, or MinIO through `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. Presigned GET lasts one hour.
- `storage/supabase.ts` (268): Supabase Storage with size thresholds for the upload method.
- `storage/local.ts` (93): local filesystem backend for tests and dev.

Dependencies: `file-resolver.ts`, `sync-git.ts`, `extract-takes-from-pages.ts`. No Postgres features.

Rust port notes: a trait with S3-compatible and local implementations. Embedded storage does not change this directory.

### storage-manifest (6 files, 1,090 lines)

Purpose: "shelf" cards (GST-1943) for items an agent archived to object storage. Each card is a page under the `storage` frontmatter key. The `storage` source is never federated, and only the storage verbs can write to it.

Key files:
- `schema.ts` (260): card validation with `zod` on every storage write.
- `source.ts` (134): the `storage` source. Its docstring says the page door refuses other writers (`assertStorageSourceWriter`).
- `door.ts` (37): the storage write door, a symbol no request parameter can carry.
- `find.ts` (92): ranked lookup (exact id, exact alias, exact title, phrase words, then `pg_trgm` similarity).
- `jsonl.ts` (130): `gbrain storage export --jsonl` and `import --jsonl`, with a plan hash.
- `adopt.ts` (437): `gbrain storage adopt`. Converts older interim `stored-object` pages into cards.

Dependencies: `persistence/` page door (`page-mutations.ts`, `memory-mutations.ts`), `ops/storage-manifest.ts`, `commands/storage.ts`, `zod`.

Postgres features: `page_aliases` lookup and `pg_trgm` `similarity()` in `find.ts`. Nothing else specific.

Rust port notes: the card schema and JSONL format are part of the agent-facing contract, so keep them byte-compatible. The write door becomes an internal capability check.

### backup (9 files, 2,432 lines)

Purpose: the monthly backup-coverage check ("if this disk died, could I recreate my agent?") and the archive/restore machinery behind `gbrain backup`. Backups are a PGLite-first design.

Key files:
- `snapshot.ts` (360): full PGLite state recovery through `engine.db.dumpDataDir('none')`. Never starts workers.
- `archive.ts` (233): private, bounded, streaming container. Paths are data, never shell arguments.
- `preflight.ts` (101): on PGLite, checks the managed `<root>/.gbrain/brain.pglite` path before any writer lock is taken (#6649).
- `runtime-artefacts.ts` (127): removes stale IPC sockets inside the PGLite data dir (#5312) so `dumpDataDir` does not wedge.
- `coverage.ts` (539): engine-side coverage compute across asset classes.
- `status-file.ts` (640): engine-free cached verdict, nag gate, and renderer.
- `repository.ts` (231): remote probes with bounded timeouts.
- `quarantine.ts` (95): detaches restored execution config without deleting memory.
- `private-path.ts` (106): Windows PowerShell protection step, with a warm-up for cold starts.

Dependencies: `commands/backup.ts`, `cli/main.ts`, `mcp/dispatch.ts`, `commands/doctor/checks/backup-coverage.ts`, `workspace-push.ts`. The system-of-record doc (`docs/architecture/system-of-record.md`) says DB-only state (credentials, page history, receipts, the withdrawal ledger) needs a database backup, and that Markdown can be re-synced.

Postgres features: none directly. The snapshot is PGLite-specific. Postgres brains depend on the external database backup.

Rust port notes: the backup container and the coverage check port as-is. Replace `dumpDataDir` with a snapshot of the embedded store, and drop the PGLite socket and path checks. The "what is DB-only" list is the important part to keep.

### Parity risks

- Persistence request states and receipt shapes (`WRITE_REQUEST_STATES`, `WRITE_ERROR_CODES`) are returned to agents. Any change to the codes breaks the CLI and MCP contract.
- The storage manifest JSONL export has a plan hash and sorted-by-id order. A Rust import must accept files written by the TypeScript export, and the reverse.
- The breaker and hold logic in `sync-run.ts` depends on exact counts and ordering across cursors. A black-box test could catch a different held-entry order.
- Backup `status-file.ts` nag gating and the monthly cadence are visible to users and cannot change silently.
- Graduation (PGLite to Postgres) has a manifest and a fence protocol. Rust must either support it or declare it out of scope; old PGLite brains will need a path.
- SQL-text golden files in `engine-sql` define the exact statements; a Rust query layer could return different row order or tie-breaks in search ranking.

### Open questions for Garry

- Is the persistence layer (write journal, owner election, effect journal, graduation) part of the Rust port, or is the Rust target a single-process store without multi-writer coordination? This is the largest scope decision in this area.
- Does the Rust port need to import existing Postgres brains and their 318-version migration history, or only a PGLite or fresh snapshot?
- Should `storage-manifest` and `storage` (S3, Supabase, local) move into the Rust binary, or stay as external services?
- Is the vendored `postgres.js` path still needed in the Rust target, or is it removed with the Postgres engine?
- Which of RLS, the multi-tenant `source_id` scoping, and the managed writer guard are product requirements in the embedded design?

## Retrieval, AI, and reasoning

Scope: 17 `src/core` directories at commit 8bbfd0b5e8. File counts use `find <dir> -type f` and include nested subdirectories. Line counts are `cat` totals (`wc -l`). Postgres features were located by grep and are listed where verified.

| Directory | Files | Lines |
|---|---|---|
| search/ (incl. hybrid/) | 122 | 31,251 |
| ai/ (incl. recipes/, decide/, providers/) | 103 | 19,146 |
| context/ | 38 | 12,778 |
| think/ | 12 | 3,793 |
| belief/ | 20 | 4,083 |
| brainstorm/ | 6 | 2,727 |
| eval-contradictions/ | 15 | 2,821 |
| questions/ | 10 | 1,780 |
| advisor/ | 18 | 1,628 |
| takes-quality-eval/ | 10 | 1,221 |
| calibration/ | 7 | 1,436 |
| chunkers/ | 11 | 4,362 |
| feedback/ | 5 | 1,059 |
| cross-modal-eval/ | 5 | 812 |
| eval/ | 5 | 807 |
| bench/ | 3 | 600 |
| eval-shared/ | 1 | 164 |

### search

Hybrid retrieval pipeline. `search/hybrid.ts` (1,556 lines) states the pipeline as keyword plus vector, then RRF fusion, normalize, boost, cosine re-score, dedup. RRF uses `sum(1/(60+rank))`. The header documents a 2.0x compiled-truth boost and a 0.7 RRF / 0.3 cosine blend. Stages are split into `search/hybrid/` (`request.ts`, `arms.ts`, `rank.ts`, `rerank-gate.ts`, `keyword-only.ts`, `cache-stages.ts`, `degraded.ts`, `effective-modes.ts`, `alias-resolved.ts`, `time-scope.ts`).

Key files:
- `search/hybrid.ts`: `hybridSearch`, `hybridSearchCached`, `rrfFusion`, boosts (backlink, recency, title, salience, chronicle type), supersede downrank.
- `search/hybrid/rank.ts`: fusion, rerank, identity tiers, return sizing.
- `search/keyword-statement.ts`: keyword match and count (`keyword_total`) over one shared WHERE builder.
- `search/sql-ranking.ts` (485): builds raw SQL fragments for `ts_rank` and source-aware ranking; `phraseto_tsquery` phrase multiplier; bounds `websearch_to_tsquery` input (32-entry operator-stack limit).
- `search/vector-pool.ts`: pooled vector candidate window; sets `hnsw.max_scan_tuples`.
- `search/hnsw-iterative-scan.ts`: `hnsw.iterative_scan` modes `relaxed_order` (default), `strict_order`, `off`; env `GBRAIN_HNSW_ITERATIVE_SCAN`, config `search.hnsw_iterative_scan`.
- `search/query-cache.ts` (513): semantic query cache. Runs an HNSW cosine probe over cached query embeddings; default similarity threshold is 0.92.
- `search/rerank.ts` (275): reranker call through the gateway, with `RerankError`, budget checks, and audit logging.
- `search/expansion.ts`: LLM query expansion with prompt-injection sanitizers.
- `search/crag.ts` (425): zero-LLM retrieval-confidence gate that reads T4 evidence, reranker score, and autocut.
- `search/eval.ts`: P@k, R@k, MRR, nDCG@k and `runEval()` over qrels.

Dependencies: `types.ts`, `engine.ts` (about 47 imports; the search arms call `engine.searchKeyword` and `engine.searchVector`), `trust/tier.ts`, `ops/contract.ts`, `query-intent.ts`, `autocut.ts`, `return-policy.ts`, `exact-lookup.ts`, `budget/budget-tracker.ts`, `rerank-audit.ts`, `chunkers/token-estimate.ts`.

External services: query embedding and reranking through the AI gateway (`ai/gateway.ts`). Expansion and decide slots (S2 intent, S4 answerable) also call the chat model.

Postgres features (verified):
- pgvector HNSW cosine (`<=>`, `1 - distance`) for vector arm, query cache, and `ai/decide/proposals-store.ts`.
- `hnsw.max_scan_tuples` and `hnsw.iterative_scan` session settings.
- tsvector/tsquery: `content_chunks.search_vector` with `websearch_to_tsquery`, `ts_rank`, `phraseto_tsquery`; `to_tsvector`/`plainto_tsquery` in `saved-facts-match.ts`.
- CJK branch uses LIKE/ILIKE substring match (`search/cjk-keyword-sql.ts`) instead of tsvector.
- pg_trgm: not used. `context/retrieval-reflex.ts` explicitly avoids trigram fuzzy matching.

Rust port notes: the RRF, boost, cosine-rescore, dedup, and CRAG logic are pure functions and port directly. The hard part is keyword ranking. `ts_rank` and `websearch_to_tsquery` need a Rust-side equivalent (stemming, stopwords, quoted phrases, `-` negation, the 32-operator bound), and the CJK LIKE path must be reproduced. The HNSW probe and `hnsw.iterative_scan` semantics have no embedded counterpart; the port needs an equivalent filtered-ANN contract.

### ai

The AI gateway. `ai/gateway.ts` (4,576 lines, the largest single file in this group) is the one seam for every AI call. Exports include `configureGateway`, `embed`, `embedQuery`, `chat`, `expand`, `rerank`, and model getters (`getEmbeddingModel`, `getChatModel`, `getRerankerModel`, `getExpansionModel`, `getChatFallbackChain`). Defaults in `ai/defaults.ts`: embedding `voyage:voyage-4` at 1024 dims; reranker `voyage:rerank-3-lite`.

Key files:
- `ai/gateway.ts`: the public seam, timeouts (`AI_CHAT_TIMEOUT_MS` 300 s), test transports.
- `ai/recipes/index.ts` plus about 27 recipe files: OpenAI, Anthropic, Azure OpenAI, Google, Voyage, Groq, Mistral, Together, OpenRouter, Ollama, LM Studio, llama.cpp server (embed and reranker), DashScope (embed and rerank), Zhipu, Moonshot, DeepSeek, Perplexity, NVIDIA NIM, MiniMax, nan.builders reranker, LiteLLM proxy, Particle, Claude CLI, TypeSafe.
- `ai/chat-fallback.ts`: `chat_fallback_chain` consumer; each attempt is a full `chat()` call with its own budget reservation.
- `ai/voyage-gateway.ts`: Voyage embeddings through the Vercel AI gateway; `outputDimension` handling.
- `ai/query-embed-cache.ts`: per-process LRU of query vectors (512 entries, 10-minute TTL).
- `ai/embedding-guard.ts`: zero-norm and degenerate vector checks; Matryoshka prefix fitting.
- `ai/decide/`: typed-question `decide()` (policy, egress gate, budget, pack, provider, strict validation, spend ledger). Providers: `typesafe`, `llm-structured`.
- `ai/providers/claude-cli-language-model.ts`: Claude CLI as a language model.

Dependencies: `types.ts` (29 imports), `config.ts`, `model-config.ts`, `engine-scope.ts`, `model-pricing.ts`, `budget/`, `engine.ts` (for decide store and proposals).

External services: embedding (Voyage default; OpenAI, DashScope, llama.cpp, Ollama, LM Studio, and others as alternates), reranking (Voyage, DashScope rerank, llama.cpp reranker, nan.builders), chat (Anthropic, OpenAI-compatible, Claude CLI, others). Routing is by `recipe:model` strings.

Postgres features (verified): `ai/decide/proposals-store.ts` and `ai/decide/review-lane.ts` run pgvector cosine (`c.embedding <=> n.embedding`) for conflict neighbors. `ai/decide/store.ts` and similar modules run plain SQL through `engine.executeRaw`.

Rust port notes: the recipe registry is a natural Rust enum or table; the wire formats (OpenAI-compatible, Voyage `/rerank`, DashScope, llama.cpp) must match. The gateway's budget, usage ledger, fallback chain, and redaction (`key-redact.ts`) are cross-cutting and need to stay identical for the CLI JSON output. Pgvector conflict queries in `decide/` will need an embedded nearest-neighbor implementation with the same cosine threshold semantics.

### context

Agent-session context delivery. Most files are hook and IPC plumbing for session start, per-turn reflexes, and capture. The directory has no direct LLM call sites. It reads the brain through the serve process's resolve socket so hooks never open the database.

Key files:
- `context/session-start-pack.ts`: the SessionStart pack, fetched over the serve's resolve-IPC socket; engine-free.
- `context/retrieval-reflex.ts`: deterministic resolver; maps salient surface forms (from `entity-salience.ts`) to existing pages and returns a pointer block.
- `context/volunteer.ts`: push-based context. Extracts candidates from a rolling conversation window using recency and frequency.
- `context/pressure.ts`: context-pressure notice at about 80% window use.
- `context/corpus-source.ts`, `corpus-windows.ts`, `corpus-turns.ts`: session corpus file naming and windowing.
- `context/sync-ipc.ts`, `resolve-ipc.ts`, `windows-ipc.ts`, `ipc-path.ts`: Unix socket IPC and path-length handling.
- `context/capture-consent.ts`, `sensitivity-scan.ts`: capture gating.

Dependencies: `engine.ts` (16 imports), `config.ts`, `eligibility/policy.ts` and `registry.ts`, `search/alias-normalize.ts`.

External services: none directly. Serve IPC is local.

Postgres features: none directly. The engine is reached through the generic engine interface.

Rust port notes: IPC sockets (Unix domain sockets; Windows named pipes) and path-length limits are platform-specific. The hook path must remain engine-free so a process holding the embedded store does not contend with it. The corpus file-name scheme is a file-format contract.

### think

`gbrain think`: INTENT, GATHER, SYNTHESIZE, optional COMMIT. `think/index.ts` (1,437 lines) runs the pipeline. The header says the Anthropic call is dependency-injected through a `MessagesClient` interface, so tests can stub it. The default deep tier is `anthropic:claude-opus-4-7` (#4375 comment in the same file).

Key files:
- `think/index.ts`: pipeline entry, model resolution (bare or provider-prefixed ids), the Anthropic SDK path, `NO_ANTHROPIC_API_KEY` diagnostics.
- `think/gather.ts`: four parallel retrievers: hybrid page search, `takes_kw` keyword over takes, and others.
- `think/decide.ts`: System One S2 question classifier (`temporal | knowledge_update | other`) that runs alongside gather.
- `think/prompt.ts`, `think/sanitize.ts`, `think/cite-render.ts`: prompt assembly, sanitization, citation rendering.
- `think/persist-take.ts`: `--take` writes a take row to the anchor page inside a derived-maintenance transaction.
- `think/temporal-window.ts`, `temporal-context.ts`, `pages-budget.ts`: time windows and page budgets.

Dependencies: `engine.ts` (6), `types.ts`, `trust/tier.ts`, `trust/taint.ts`, `takes-fence.ts`, `search/transcript-quote.ts`, `search/hybrid.ts`.

External services: Anthropic Messages API (direct SDK `@anthropic-ai/sdk`, not the gateway). The model is resolved through the gateway's naming, which is a mixed path.

Postgres features: takes and derived-maintenance writes through `engine` transactions. No vector or FTS SQL of its own.

Rust port notes: this is the one direct-SDK LLM path outside the gateway. Port it with the same injectable client seam so tests can stub the model. Keep the `--take` transaction semantics. The Anthropic-direct versus gateway split needs a decision (see Open questions).

### eval, eval-shared, eval-contradictions, cross-modal-eval, takes-quality-eval, bench

Evaluation harnesses. They use the gateway for LLM judging and share a JSON repair helper.

- `eval/`: `paired-bootstrap.ts` (clustered paired bootstrap with sign-swap and Holm step-down, ported from a comparator), `drift-watch.ts` (curated list of files for the `eval_drift` doctor check), `ranked-docs.ts`, `metric-glossary.ts`, `cycle-default.ts`. Depends on `spawn.ts` and `git-env.ts`.
- `eval-shared/json-repair.ts` (164 lines): shared JSON repair used by judges.
- `eval-contradictions/` (15 files): `runner.ts` orchestrates `gbrain eval suspected-contradictions` from file, single, or capture sources. `judge.ts` sends one statement pair to the chat gateway. Also `cost-tracker.ts`, `calibration.ts`, `auto-supersession.ts`, `trends.ts`, `run-health.ts`. Depends on `engine.ts`, `ai/gateway.ts`, `effective-date.ts`.
- `cross-modal-eval/` (5 files): `runner.ts` scores outputs with three different-provider models via `Promise.allSettled`. Pinned defaults include `anthropic:claude-opus-4-7`. Uses `ai/gateway.ts`.
- `takes-quality-eval/` (10 files): `runner.ts` runs a three-model panel over takes sampled from the database, with thinking off. Also `rubric.ts`, `pricing.ts`, `regress.ts`, `receipt-write.ts`. Uses `engine.ts` and `ai/gateway.ts`.
- `bench/` (3 files): `qrels-file.ts` (JSON object qrels), `correctness-gate.ts` (runs bare `hybridSearch` over qrels; comment cites `search/eval.ts`), `baseline-file.ts`.

External services: chat models via the gateway (Anthropic models are pinned in several runners). No embedding calls of their own beyond the search they invoke.

Postgres features: `eval-contradictions` and `takes-quality-eval` read and write through `engine`. The bench and cross-modal runners do not run SQL. Core dependency: `search/hybrid.ts` for bench.

Rust port notes: these are offline or CLI-driven and do not need to be on the first parity list. Receipts are JSON files on disk (`receipt-write.ts`, `receipt-name.ts`); their names and shape are part of the output contract. Statistics (`paired-bootstrap.ts`) must match numerically; use the same RNG seeding or accept tolerance.

### calibration

Calibration waves for `gbrain think` and related surfaces, plus a voice gate. Files: `think-ab.ts` (runs think twice per question, baseline and `--with-calibration`, and stores both in a `think_ab_results` row), `undo-wave.ts`, `domain-aggregators.ts`, `voice-gate.ts` (single conversational-voice function used by all calibration surfaces), `gstack-coupling.ts`, `svg-renderer.ts`, `templates.ts`.

Dependencies: `engine.ts` (3), `spawn.ts`, `schema-pack/manifest-v1.ts`, `persistence/attribution.ts`, `model-config.ts`.

External services: none directly; `voice-gate.ts` and `think-ab.ts` route through think, which uses Anthropic.

Postgres features: 14 SQL hits through `engine`; `think_ab_results` and calibration tables. No pgvector or FTS.

Rust port notes: `svg-renderer.ts` and `templates.ts` produce HTML/SVG output that is user-facing; a parity test would catch format changes. `gstack-coupling.ts` ties to an external tool and should be confirmed in scope.

### brainstorm

Multi-model idea generation with cost gating and a judge. `orchestrator.ts` (2,727 lines across the directory) runs cross-model calls under `withBudgetTracker`, with a pre-run cost estimate and a TTY grace window. Default chat model is `anthropic:claude-sonnet-4-6`.

Key files: `orchestrator.ts`, `judges.ts` (shared judge with brainstorm and LSD configs), `cost-gate.ts` (pricing lookup with fallback), `error-classify.ts`, `checkpoint.ts` (resumable runs), `domain-bank.ts`.

Dependencies: `ai/gateway.ts`, `engine.ts`, `errors.ts`, `budget/reservation-cost.ts`, `budget/no-pricing.ts`, `budget/budget-tracker.ts`.

External services: chat models through the gateway (Anthropic Claude Sonnet and Opus examples in judge pricing tables).

Postgres features: two SQL call sites, minimal. No vector or FTS.

Rust port notes: checkpoint files are on-disk state; the budget and pricing tables must match the gateway's `model-pricing.ts`.

### belief

The belief ledger (`docs/designs/BELIEF_LEDGER.md`). An append-only event log of what the brain asserts about a page and its subjects, with projections, backfill, purge, and privacy filtering. 20 files, about 4,083 lines.

Key files: `schema.ts` (DDL for `belief_events` and indexes on `(source_id, slug, id)`, `(source_id, subject_kind, subject_key, id)`, and `recorded_at`), `ledger.ts` (543 lines; `withBeliefBatch` finalization contract), `append.ts` (the only insert path; enforces purge tombstones and the redaction register), `state.ts` (canonical stream state), `history.ts` (the one history reader; fails closed for remote callers), `backfill.ts`, `purge.ts`, `purge-mirror.ts`, `retier.ts`, `changes.ts`, `coverage.ts`, `preimages.ts`.

Dependencies: `engine.ts` (17 imports), `search/private-visibility.ts`, `persistence/managed-mode.ts`, `page-size-policy.ts`, `ops/contract.ts`, `utils.ts`.

External services: none.

Postgres features: about 42 SQL call sites through `executeRaw`. Uses `unnest($1::bigint[], $2::uuid[]) WITH ORDINALITY`, `->>` on JSON, and B-tree indexes. No pgvector or FTS.

Rust port notes: the append-only table plus per-subject indexes map well to embedded storage. Preserve transactional batch semantics (`withBeliefBatch`) and purge tombstones. Array-typed `unnest` joins need a Rust-side rewrite.

### advisor

`gbrain advisor`: a read-only recommender. `run.ts` runs a static, ordered list of collectors, each in its own try/catch, then ranks findings by severity. Collectors include `collect-schema-pack`, `collect-migration`, `collect-stalled-jobs`, `collect-backup-coverage`, `collect-chronicle` (the one that calls the gateway), `collect-version`, `collect-mcp-client-fit`, `collect-uninstalled-bundled`, `collect-uninstalled-brain-pack`, `collect-usage-shape`, `collect-setup-smells`, `collect-writeback-consent`. `apply.ts` applies recommended fixes; `history.ts` stores past runs.

Dependencies: `config.ts` (4), `sources-load.ts`, `skillpack/nag-state.ts`, `self-upgrade.ts`, `schema-pack/load-active.ts`.

External services: chat through the gateway in `collect-chronicle.ts` only (verified).

Postgres features: 4 SQL sites. No vector or FTS.

Rust port notes: collectors are mostly filesystem and config reads. Keep the collector order fixed for deterministic output. `self-upgrade.ts` and `apply.ts` are side-effecting and need a parity plan.

### feedback

Use-attributed retrieval feedback. `record.ts` mints `ans_<ULID>` ids for answers and enqueues events on a bounded write-behind queue so reads never wait. `store.ts` (430 lines) owns all SQL for migration v207 tables: `retrieval_events`, `retrieval_event_pages`, `retrieval_event_links`, `retrieval_feedback`, `retrieval_weights`. `rate.ts` handles ratings; `settings.ts` and `upgrade-notice.ts` handle config and notices.

Dependencies: `engine.ts` (4), `ops/contract.ts`, `scope.ts`, `background-work.ts`, `agent-markers.ts`. Likely consumed by `search/feedback-boost.ts` (unverified).

External services: none.

Postgres features: 20 SQL sites with positional binds through `executeRaw` ("no JSONB" per file header), plus a write-behind queue.

Rust port notes: the bounded write-behind queue is a background worker; coordinate with the jobs map. Positional binds should be replaced with typed rows.

### questions

Pinned questions (owner-private). `service.ts` backs `questions_*` operations and `gbrain questions`. `schema.ts` defines `pinned_questions` and `question_evidence` with indexes on `(state, source_id)` and `(question_id, answer_revision)`. The answer lives in those tables, not in `pages`. `refresh.ts` runs a durable lease on the pin row, refusing with `awaiting_consent`, `no_model_key`, or `budget_exhausted`. `store.ts` runs 23 SQL sites through `executeRaw`.

Dependencies: `engine.ts` (7), `ops/contract.ts`, `cycle/budget-meter.ts`, `quarantine.ts`, `think/sanitize.ts`.

External services: chat through the gateway during refresh (verified in `questions/refresh.ts` via gateway-consuming imports; the exact call site was not traced line by line).

Postgres features: plain tables and indexes. No vector or FTS.

Rust port notes: the lease and state machine need atomic compare-and-swap semantics on the embedded store.

### chunkers

Text and code chunking for indexing. `recursive.ts` ports a Ruby 5-level delimiter chunker (paragraphs, then finer delimiters). `code.ts` uses web-tree-sitter (WASM) to split code into functions, classes, types, and exports. `code-module-chunks.ts`, `code-elixir.ts`, `component-markup.ts`, `bullet-chunks.ts`, `def-types.ts`, `qualified-names.ts`. `edge-extractor.ts` and `symbol-resolver.ts` produce call-graph edges with within-file two-pass resolution. `token-estimate.ts` estimates tokens. 11 files, 4,362 lines.

Dependencies: `cjk.ts`, `text-safe.ts`, `search/safe-chunks.ts`, `remote-body.ts`, `engine.ts`, `credential-projection.ts`.

External services: none.

Postgres features: 1 tsvector reference (`recursive.ts:140` comment on tsvector size limits) and 6 SQL sites for storing edges. No vector call.

Rust port notes: tree-sitter grammars must be bundled as Rust crates with the same grammar versions, or chunk boundaries will drift and parity tests will fail. Chunk boundaries and token estimates are visible in search output; reproduce them exactly.

### code-intel (6 files, 628 lines)

Purpose: recursive call-graph walks over code pages for the `code_blast` (callers) and `code_flow` (callees) operations, plus read-scope filtering for code queries. Key files: `recursive-walk.ts` (BFS over the single-hop engine methods `getCallersOf` / `getCalleesOf`, bounded by depth and `max_nodes`, cycle detection by visited set; response envelope `result: 'ok' | 'not_found' | 'ambiguous' | 'unsupported_language'`, depth-grouped); `traversal-cache.ts` (memoizes walks in `code_traversal_cache`, keyed by `(symbol_qualified, depth, source_id, cluster_generation)`; the header describes a REPEATABLE READ snapshot gate, but the write is best-effort and the comment at line 204 says full REPEATABLE READ + `xmin_max` wiring is still pending); `read-scope.ts` (`codeReadFilter`, composes `pageReadFilter` from `search/read-policy-sql.ts` and `safeChunksFilter` from `search/safe-chunks.ts`); `sinks/` (`index.ts`, `ts.ts`, `py.ts`: literal + glob sink-pattern classification of callee names by language). Dependencies: `engine-sql/code-edges.ts` (edge storage), `chunkers/code.ts` (tree-sitter symbols), `ops/code-intel.ts` (operation definitions), `code-graph-readiness.ts`; consumed by `src/commands/code-def.ts` and `code-refs.ts`. External services: none. Postgres features: SQL WHERE fragments built as strings with positional params; snapshot isolation is intended but not enforced (unverified beyond the comment). Rust port notes: the BFS and sink matching are pure logic and port directly; the cache needs a generation counter in the embedded store instead of `xmin`.

### Parity risks

- Keyword ranking: `websearch_to_tsquery`, `ts_rank`, and `phraseto_tsquery` semantics (stemming, stopwords, negation, operator-stack bound) are hard to reproduce. Scores feed `arm-confidence.ts` and CRAG thresholds.
- HNSW behavior: approximate results differ from exact search; `hnsw.iterative_scan` and `max_scan_tuples` change which rows survive. Filtered ANN results need an equivalent contract.
- RRF and boosts are pure math but order-sensitive; tie-breaking must match.
- Chunk boundaries from `recursive.ts` and tree-sitter grammar versions.
- Query cache threshold (0.92) and its LRU/TTL behavior change which results are served.
- Gateway fallback chain, budget reservation, and redaction are visible in JSON output.
- Belief ledger: append-only event ordering, purge tombstones, and fail-closed history reads.

### Open questions for Garry

- Should `gbrain think` keep its direct Anthropic SDK path, or move onto the AI gateway like the eval and brainstorm runners? The answer changes the Rust client surface.
- Is the semantic query cache (`query-cache.ts`) in scope for the first Rust release, or deferred? It is a nontrivial HNSW dependency.
- Should the Rust port keep `ai/decide/` (typed multi-question decisions, pgvector conflict neighbors) in v1, or drop to `chat()` only?
- Are the eval harnesses (eval-contradictions, takes-quality-eval, cross-modal-eval, calibration, brainstorm) required for parity, or are they internal tooling?
- Which embedding and reranker recipes must work natively in Rust? The default is `voyage:voyage-4` plus `voyage:rerank-3-lite`; the local llama.cpp and Ollama recipes may matter more for an embedded, offline product.

## Jobs, cycle, and maintenance

Scope: twelve directories under `src/core/` at commit 8bbfd0b5e8. Counts are `.ts` files and lines, subdirectories included. Postgres feature counts come from pattern search and are approximate. The detailed background-jobs map is separate.

### minions/ (123 files, 26,101 lines; 72 top-level, 46 in handlers/, 5 in tools/)

A Postgres-native durable job queue with a worker, a supervisor, and optional per-job child processes. `MinionQueue` (`src/core/minions/queue.ts`) owns add, claim, complete, fail, renew, and prune on the `minion_jobs` table. `MinionWorker` (`worker.ts`) runs registered handlers in a promise pool with per-job lock renewal. Handlers live in `handlers/` (sync, embed, extract, `subagent.ts` LLM loop, shell, ingest-capture, autopilot-cycle, autopilot-global-maintenance).

Key files:
- `queue.ts` (124 KB): `MinionQueue`; `claim()` at line 1463, `completeJob` 1745, `failJob` 1853, `renewLock` 2096.
- `worker.ts` (88 KB): concurrent worker, one AbortController per job.
- `supervisor.ts` (65 KB): `gbrain jobs supervisor` daemon; restart with backoff, PID lock.
- `child-job-runner.ts` and `job-isolation.ts`: per-job child process protocol.
- `admission.ts` and `lanes.ts`: submit-side coalescing and quota; claim-time lane reservation.
- `handlers/subagent.ts` (92 KB): crash-resumable Anthropic tool-use loop.

Dependencies: `engine.ts` (about 70 imports), `ops/contract.ts`, `ai/gateway.ts`, `rate-leases.ts`, `budget-meter.ts`, `submission-authority.ts`. External services: the Anthropic SDK (`@anthropic-ai/sdk`) in `handlers/subagent.ts`; the supervisor spawns `gbrain` and `bun` child processes. Postgres features: `FOR UPDATE SKIP LOCKED` (claim and sweep, `queue.ts:1511` onward, `watchdog-attribution.ts:137`); `pg_advisory_xact_lock` (`queue.ts:385, 431, 488`; `budget-meter.ts:99, 255`; `rate-leases.ts:81`); `WITH RECURSIVE` for descendant cancel (`queue.ts:1061`, `legacy-cancel.ts:42`, `job-insight.ts:204`); `LISTEN` and `NOTIFY` on channel `minion_jobs` fed by a `notify_minion_job_change` trigger (`sync-queue-wake.ts`, with a polling fallback); JSONB payloads; `ON CONFLICT` (19 matches); `RETURNING` (42 matches).

Rust port notes: `SKIP LOCKED` and advisory locks need an explicit single-writer or lease-column design in the embedded store. `LISTEN` and `NOTIFY` have no embedded equivalent, so use an in-process wake plus polling. The supervisor header states that PGLite's exclusive file lock blocks a separate worker process, so the Rust team must decide whether the supervisor and child isolation exist at all.

### cycle/ (92 files, 28,769 lines; 91 top-level, 1 in phases/)

The brain maintenance cycle: an ordered list of phases that composes lint, backlinks, sync, fence and content repair, synthesize, extract, extract facts, atoms, takes, patterns, and more. The orchestrator is `src/core/cycle.ts` (3,350 lines, outside this directory): `CyclePhase` type, `ALL_PHASES` order (line 130), `runCycle` (1904), `deriveStatus`. Phase scope and managed-brain behavior live in `cycle/phase-scope.ts` and `cycle/phase-table.ts`. Each phase has a large LLM-backed module.

Key files:
- `cycle/phase-table.ts`: managed-brain classification per phase (writes, no coordinated write, managed skip).
- `cycle/phase-scope.ts`: source, global, or mixed scope per phase.
- `cycle/synthesize.ts` (168 KB) and `synthesize-verify.ts` (75 KB): page synthesis and verification.
- `cycle/extract-atoms.ts` (88 KB), `extract-facts.ts` (70 KB), `patterns.ts` (75 KB), `propose-takes.ts` (62 KB): LLM extraction and proposal phases.
- `cycle/fence-repair.ts` and `cycle/content-repair.ts`: thin phase wrappers over `src/core/repair/`.

Dependencies: `engine.ts` (about 70 imports), `ai/gateway.ts`, `persistence/` (prepared maintenance, ownership, accepted-pending), `budget/budget-tracker.ts`, `trust/taint.ts`, `markdown.ts`, `abort-check.ts`. External services: LLM providers through the gateway; the Anthropic SDK is type-imported in `cycle/synthesize.ts`. Postgres features: `pg_stat_activity` for the oldest-transaction grace window (`cycle/source-window.ts:43`); `ON CONFLICT` (20 matches); `interval` arithmetic.

Rust port notes: `pg_stat_activity` has no embedded analog, so the grace-window logic needs an in-process substitute. Port the phase table and ordering as data first. The LLM-backed phases are the largest surface and should follow the gating logic, not lead it.

### ops/ (77 files, 21,793 lines)

The operation implementations behind the shared operations contract. `src/core/operations.ts` re-exports `ops/contract.ts`, which defines `OperationError`, `ErrorCode`, and the `Operation` interface. Per-domain modules export operation arrays (for example `jobsOperations` in `ops/jobs.ts:1001`, `loopsOperations` in `ops/loops.ts:897`, `wakeshift.ts` operations). This directory is broad: it also holds search, context, facts, pages, and takes, which other subsystem maps cover in more depth.

Key files:
- `contract.ts` (47 KB): error envelope, shared types, `Operation` interface.
- `jobs.ts` (57 KB): submit, get, wait, cancel, retry, replay, and stats for jobs; owner fence (`assertJobOwned`); redacts `submission_authority`.
- `loops.ts` (46 KB): open-loop read and write operations.
- `wakeshift.ts` (27 KB): report-back watch operations, gated on the file-plane enable and a host key.
- `search.ts` (94 KB), `facts.ts` (95 KB), `context.ts` (68 KB): large domain modules, out of this section's focus.

Dependencies: `operations.ts`, `engine.ts`, `persistence/`, `eligibility/`, `search/`, `trust/`, `scope.ts`, `source-id.ts`. External services: none direct. Postgres features: `LATERAL` (`admin.ts:307`), `RETURNING` (5 matches), `ON CONFLICT` (3 matches), JSONB (7 matches), `executeRaw` (about 94 matches).

Rust port notes: the operation names and JSON shapes are the agent-facing contract and must match exactly. Most SQL sits in the domain modules, so the embedded-storage work is spread across this directory rather than concentrated.

### repair/ (77 files, 19,779 lines)

The `gbrain repair <kind>` implementations. `REPAIR_KINDS` (`repair/core.ts:57`) lists the kinds; `repair/registry.ts` (87 KB) holds one entry per kind, and the CLI, doctor remediation, and post-upgrade banner all read it. Each kind is a resumable, cursor-based dry-run and apply loop (`RepairCursor`, `core.ts`). Every applied item is one coordinated page write bound to the page's current revision.

Key files:
- `core.ts` (55 KB): scope resolver, resumable cursor, capacity stop, dry-run and apply loop.
- `registry.ts` (87 KB): kind table and doctor check mapping.
- `file-drift.ts` (101 KB): largest file; database versus brain-file drift.
- `slug-conflicts.ts` (71 KB): frontmatter slug conflict resolution.
- `fences.ts` (46 KB) and `frontmatter.ts` (47 KB): fence and frontmatter repair.
- `visibility.ts` (47 KB) and `private-labels.ts` (53 KB): visibility and label repair.

Dependencies: `ops/contract.ts`, `engine.ts`, `persistence/` (heavily: coordinator, page mutations, sync holds, attribution), `markdown.ts`, `ops/op-fix.ts`. External services: none. Postgres features: `LATERAL` joins with `OFFSET 0` (`origin-carry.ts:47`, `private-labels.ts:246, 279`); `jsonb_array_elements_text`, `jsonb_typeof`, and the `@?` JSONPath operator (`visibility.ts:101`, `private-labels.ts:246`); `SET LOCAL statement_timeout = '600000'` (`missing-tables.ts:64`); `RETURNING` (23 matches).

Rust port notes: `@?` JSONPath and the JSONB functions must be re-expressed on the embedded store. The `OFFSET 0` planner barrier is irrelevant there. `statement_timeout` needs a replacement. Frontmatter and fence parsing need byte-level parity.

### remediation/ (7 files, 1,267 lines)

The doctor remediation library, extracted so `gbrain onboard`, `gbrain doctor --remediate`, and the MCP `run_onboard` operation share one orchestrator. `plan.ts` computes a plan from recommendation checks; `run.ts` (29 KB) runs it with a budget tracker, checkpoint resume keyed on `plan_hash`, and a dependency cascade where a failed step aborts its dependents. `repairs.ts` adds protected local-only repair steps (previewed through `repair/registry.ts`, run with `--include-repairs`).

Key files:
- `run.ts` (29 KB): orchestrator, checkpoint resume, dependency cascade.
- `plan.ts`: plan computation from recommendation context.
- `repairs.ts` (15 KB): repair steps and paid-step estimate gating.
- `manual-only.ts`: jobs that automatic runs never submit.

Dependencies: `engine.ts`, `repair/registry.ts`, `remediation-step.ts`, `remediation-checkpoint.ts`, `brain-score-recommendations.ts`, `minions/no-worker.ts`, `ops/op-fix.ts`. External services: none. Postgres features: none specific; uses `engine` calls only.

Rust port notes: small and mostly pure. Port as a library returning structured results. Checkpoint `plan_hash` matching must be byte-exact to keep resume behavior.

### maintenance/ (3 files, 786 lines)

Unattended upkeep (GBRA-438): free, non-purging maintenance that runs with nobody watching. `run.ts` (31 KB) builds work items: one global item under the shared `gbrain-cycle` lease, one item per source, then embedding catch-up when an embedding key exists. `idle.ts` drives it from the stdio serve's idle tick or the HTTP serve's request activity. `status.ts` gives one view for `gbrain maintain --status` and the `unattended_maintenance` doctor check.

Key files:
- `run.ts`: work items, lease handling, step list shared with `gbrain maintain --safe`.
- `idle.ts`: resident idle-tick runner.
- `status.ts`: status view.

Dependencies: `cycle.ts`, `cycle/phase-table.ts`, `db-lock.ts`, `foreground-activity.ts`, `fence-repair/`, `content-repair/llm.ts`, `transcripts/archive-maintenance.ts`, `ai/gateway.ts`. External services: embedding provider through the gateway (provider unverified). Postgres features: none found in these files beyond engine calls; the lease lives in `db-lock.ts`.

Rust port notes: the idle tick needs an in-process timer. The lease needs an embedded equivalent; PGLite-style single-writer behavior is the simpler case.

### loops/ (2 files, 491 lines)

The open-loop store: SQL accessors for the `open_loops` and `loop_suppressions` tables, with identical SQL text on both engines. `loops-store.ts` (475 lines) upserts on `(source_id, dedup_key)` (`loops-store.ts:134`) and inserts suppressions with `ON CONFLICT (source_id, kind, value) DO NOTHING` (`loops-store.ts:419`). Evidence binds as `$N::text::jsonb`. `loops-schema.ts` holds the `counterparty_source_id` column migration (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).

Key files:
- `loops-store.ts`: SQL accessors for open loops and suppressions.
- `loops-schema.ts`: column migration SQL shared with the store.

Dependencies: `engine.ts` only. Consumers: `ops/loops.ts`, `minions/handlers/loops-extract.ts`, `repair/loop-facts.ts`. External services: none. Postgres features: `ON CONFLICT`, JSONB, `RETURNING` (8 matches), `ALTER TABLE ADD COLUMN IF NOT EXISTS`.

Rust port notes: the `ON CONFLICT` upserts map to unique indexes plus upsert. Store JSON evidence as text to keep the shape.

### wakeshift/ (7 files, 1,044 lines)

Optional report-back service. A host signs each request with an Ed25519 key (`client.ts`, one JWS per request, 10 s timeout, no internal retry). Watches on jobs, write requests, and crons are stored in `wake_*` tables. `drain.ts` (339 lines) reconciles open watches to terminal states on a short loop, so delivery is a pull and not an outbox. `events.ts` builds payloads as pointers only. Enablement lives in the file plane; the key comes from `WAKESHIFT_API_KEY` or `~/.gbrain/wakeshift.key` (mode 0600). `spool.ts` writes cron-run files for PGLite brains whose single-writer lock blocks the CLI.

Key files:
- `drain.ts`: pull reconciliation and delivery.
- `client.ts`: signed HTTP client.
- `events.ts`: event definitions and payloads.
- `config.ts`: enable state and key resolution.
- `spool.ts`: file spool for cron runs on PGLite.

Dependencies: `ops/wakeshift.ts`, `engine.ts`, `config.ts`, `wakeshift-env-key.ts`, `persistence/filesystem-guard.ts`, `access/caller.ts`. External services: Wakeshift HTTP API (default `https://app.wakeshift.ai`) with EdDSA JWS. Postgres features: `LATERAL` join (`drain.ts:95`); a partial unique index used in `ON CONFLICT (wake_user) WHERE state = 'pending'` (`drain.ts:198`); `ON CONFLICT` in `terms.ts:55`; `RETURNING` (8 matches).

Rust port notes: Ed25519 and JWS need crates (choice unverified). Partial unique indexes need support in the embedded store. The file spool exists only for the PGLite lock problem, so it may disappear with an embedded store that allows concurrent writers.

### progressive-batch/ (5 files, 1,257 lines)

The batch primitive `runProgressiveBatch` (`orchestrator.ts`, 768 lines). It applies a cost cap, ramp-up, verification, TTY grace, interactive abort, and an audit trail to batch operations such as reindex and book-mirror. `retrofit-wrap.ts` gives existing batch sites the audit and cost gate without ramp. `audit.ts` writes ISO-week JSONL under `~/.gbrain/audit/` (honoring `GBRAIN_AUDIT_DIR`). `stage-report.ts` prints ASCII stage reports to stderr.

Key files:
- `orchestrator.ts`: `runProgressiveBatch` and the policy seams.
- `types.ts` (288 lines): shared types.
- `retrofit-wrap.ts`: wrapper for behavior-parity migrations.
- `audit.ts`: JSONL audit writer.

Dependencies: `interaction.ts`, `budget/budget-tracker.ts`, `audit/audit-writer.ts`, `ai/gateway.ts`. External services: none direct. Postgres features: none.

Rust port notes: no SQL. Port the TTY prompt and abort logic with a clear non-interactive mode. The audit JSONL file names and rotation are user-visible.

### content-repair/ (5 files, 673 lines)

The paid tier of the content-repair lane (#6377) for `frontmatter_slug_conflict` holds. `llm.ts` (224 lines) makes one metered judgment call per candidate under the fence-repair caps and ledger. `judgment.ts` (229 lines) is a pure prompt builder and answer parser that the eval harness reuses. `measured.ts` lists models that met the eval rule. `receipt.ts` defines the repair receipt (actor `content-repair`, Git subject and trailer). `hold-fix.ts` gives the agent the `gbrain repair content --source ... --only ...` hint.

Key files:
- `llm.ts`: metered judgment call.
- `judgment.ts`: prompt and answer parser.
- `measured.ts`: model allowlist from eval.
- `receipt.ts`: receipt and Git trailer format.
- `hold-fix.ts`: agent-facing hold guidance.

Dependencies: `fence-repair/` (model, llm, attempts, config, measured), `ai/gateway.ts`, `persistence/sync-holds.ts`, `persistence/digest.ts`, `model-config.ts`, `consent.ts`, `budget/reservation-cost.ts`. External services: LLM providers through the gateway. Postgres features: none direct.

Rust port notes: the prompt and parser must match eval fixtures exactly to keep judgment parity. The model list is data.

### fence-repair/ (31 files, 6,209 lines)

The #6188 fence repair: a census of malformed facts and takes fences from held syncs and stored pages, plus tiered repair. `census.ts` (443 lines) finds candidates and produces the per-source counts that `gbrain doctor` reports. `repair/fences.ts` (46 KB) runs the `fences` repair kind, and `cycle/fence-repair.ts` runs it in the global maintenance lane. Tiers are split across `tier1.ts`, `structure.ts`, `validate.ts`, `merge.ts`, and `llm.ts` (paid tier). `census-store.ts` persists the census.

Key files:
- `census.ts`: candidate finder and per-source counts.
- `census-store.ts`: durable census rows.
- `tier1.ts` and `structure.ts`: deterministic repair tiers.
- `llm.ts` and `model.ts`: paid tier and model choice.

Dependencies: `engine.ts`, `takes-fence.ts`, `facts-fence.ts`, `fence-shared.ts`, `fence-scan.ts`, `persistence/sync-holds.ts`, `markdown.ts`, `import-screen.ts`, `git-env.ts`, `sync.ts`. External services: LLM through the gateway; the `git` CLI. Postgres features: `pg_stat_activity` for the transaction grace period (`census.ts:104`); `ON CONFLICT` (6 matches); `RETURNING` (2 matches).

Rust port notes: the grace-period query needs an in-process substitute. The fence grammar must match the TypeScript parser byte-for-byte.

### notifier/ (6 files, 869 lines)

The GBRA-133 commit notifier's durable state and production seams. The core loop is `src/core/commit-notifier.ts` (608 lines, outside this directory). A resident process (serve, `jobs work`, autopilot) watches each source's Git HEAD and starts a sync or a freshness marker when it moves. `resident.ts` (215 lines) wires the Postgres store and the sources the host owns. `store.ts` (292 lines) holds markers and host leases (migration v262).

Key files:
- `store.ts`: wanted markers and notifier leases.
- `resident.ts`: resident wiring and sync starts.
- `detect.ts`: `fs.watch` detection with poll fallback.
- `status.ts`: freshness notices for search and query results.

Dependencies: `commit-notifier.ts`, `engine.ts`, `persistence/identity.ts`, `persistence/sync-lease.ts`, `persistence/managed-mode.ts`, `sync-config-keys.ts`, `git/commit-push.ts`, `context/sync-ipc.ts`. External services: the `git` CLI. Postgres features: `sync_notifier_leases` with `INSERT ... ON CONFLICT` fencing and conditional renewal (`store.ts:190-195`), `sync_wanted_markers`, and `now()` for lease expiry. On PGLite there is no lease; ownership is by process ID.

Rust port notes: a lease with a fencing token maps well to a single embedded transaction. The file-watch backend needs a crate choice (unverified). The PGLite pid-based owner rule may simplify.

### Parity risks

- Job claim ordering, lock-token fencing, lane exclusion, and stall reclaim under concurrency. A black-box test of ordering will be hard to match.
- Advisory-lock-keyed quota and budget checks (hashtext keys) need a serialization point with the same admission outcomes.
- LLM-backed phases and judgments (synthesize, extract-atoms, propose-takes, fence and content judgment) depend on exact prompts, parsers, and eval-measured model lists.
- Param hashes (`admission.ts`) and plan hashes (`remediation-checkpoint.ts`) must be byte-exact to keep coalescing and resume behavior.
- Wakeshift signed requests and audit JSONL file names are third-party or user-visible contracts.

### Open questions for Garry

- Does the Rust build keep the standalone supervisor and per-job child processes, or collapse to one process given the embedded store?
- Is `LISTEN` and `NOTIFY` replaced entirely by in-process wake and polling?
- Is Wakeshift and the commit notifier in v1 scope?
- Which LLM-backed phases must reach parity in v1, and which can ship as deterministic-only?

## Content model, ingestion, and connectors

Scope: 19 directories under `src/core/` in the reference checkout (commit 8bbfd0b5e8). File and line counts are every regular file in the tree (subdirectories included) and the `wc -l` total. None of these directories contain `*.test.ts` files; tests live under `test/`. Counts are approximate to the file.

### facts (97 files, 19,502 lines)
The largest subsystem. It owns the fact model: LLM extraction of facts from turns and pages, the markdown-first write path that puts facts into a page's `## Facts` fence (the system of record) and then stamps DB index rows, fence parsing for facts outside the fence, the backstop that runs on every put_page-style write, a drain that runs queued `facts-absorb` jobs, per-page conversation publication, supersession and withdrawal, and owner-only `purge_fact` with residual receipts.
- `facts/backstop.ts` (1154): `runFactsBackstop`, the shared extract, resolve, write pipeline.
- `facts/extract.ts` (1040): turn extractor. Default model `anthropic:claude-haiku-5-5`, fallback `anthropic:claude-sonnet-4-6` (`resolveFactsExtractionModel`).
- `facts/fence-write.ts` (689): `writeFactsToFence`, fence first, then DB stamp.
- `facts/conversation-publication.ts` (975): replaces a page's `cli:extract-conversation-facts*` rows with one batch plus an outcome (EXTRACTION_COMPLETE or EXTRACTION_NOT_APPLICABLE).
- `facts/purge.ts` (650) and `facts/purge-verify.ts` (769): residual sweep and receipt.
- `facts/drain.ts` (475): runs `facts-absorb` jobs inside serve, serve --http, and dream/autopilot. The header says PGLite has no background worker.
- `facts/unfenced-facts.ts` (767), `facts/proposal-supersede.ts` (499), `facts/withdrawal.ts`: unfenced facts, supersession, withdrawal.

Depends on: `persistence/` (about 94 imports through `engine.ts`), `ops/`, `page-body/`, `ai/`, `search/`, `config.ts`. External: LLM chat and embeddings through `ai/gateway.ts` (`chat`, `embedOne`), Anthropic or OpenAI keys. No direct HTTP in the directory. Postgres: `pg_advisory_xact_lock(hashtext(...))` (`facts/writeback-settings.ts:122`), `SELECT ... FOR UPDATE` on `sources` and `pages` (`facts/withdrawal.ts:107,119`; `facts/conversation-incremental.ts:364`), `RETURNING`, `ANY($n)` array binds, `jsonb` columns. Markdown: reads and writes the fence `<!--- gbrain:facts:begin -->` ... `<!--- gbrain:facts:end -->` under `## Facts` (constants in `src/core/facts-fence.ts:86-87`, outside this directory). `facts/forget.ts` also emits a `<!--- gbrain` marker.

Rust port notes: the fence is the source of truth, so the Rust port must round-trip the fence bytes and markers exactly. The DB index is derived and can be rebuilt from it. Purge must sweep the same set of stores that the deletion inventory lists.

### page-body (34 files, 10,006 lines)
Segmented page storage ("Wave B") and streamed import. It parses raw markdown (frontmatter, H1 title, `timeline` split, fence trust), cuts the compiled-truth and timeline regions into segments of at most `SEGMENT_MAX_BYTES`, and splices edits into a live generation. Files above `PAGE_MAX_BYTES` go through `streamed-import.ts`, which reads twice and never holds the file as one string.
- `page-body/body-scan.ts` (1132): streaming pass 1, decides title, type, and fence trust.
- `page-body/segmenter.ts` (782): append-stable cuts (a cut goes before a line and looks only backward).
- `page-body/segment-derive.ts` (690) and `page-body/segment-links.ts` (444): per-segment derived data.
- `page-body/read-range.ts` (650): bounded reads over stored segments.
- `page-body/streamed-import.ts` (505) and `page-body/ingest.ts` (494): import paths.
- `page-body/splice.ts` (428): resumes at the last clean entry point before the first replaced byte.
- `page-body/schema.ts` (415): DDL for migration v248 and the schema blobs.

Depends on: `persistence/` (24), `engine.ts`, `page-state/` (8), `facts-fence.ts` and `fence-scan.ts` (5 each). External: none. Postgres: `transaction(...)` (11 call sites), `SELECT ... FOR UPDATE` on `pages` (`page-body/segment-rewrite.ts:217`), `::bigint`, `::uuid`, and `jsonb` casts, plus new tables and page columns added by v248. Markdown: reads frontmatter and the `timeline` split. Reassembly must reproduce the original bytes.

Rust port notes: UTF-8 byte offsets and the append-stability invariant of the segmenter are testable black-box properties. Port the scan as a bounded-memory streaming pass. The sha256 per READ_BYTES block must match.

### page-state (23 files, 3,065 lines)
Derived state written alongside a page: chunk and timeline projections (`projections.ts`, 1051 lines), page write guards, versions and snapshots, rename with alias handling, credential reseal, and image seal. `transactions.ts` pipelines writes.
- `page-state/projections.ts` (1051): chunking and projection, using `chunkers/recursive.ts` and `markdown-chunks.ts`.
- `page-state/guards.ts` (126): locking of `page_write_guards` and `pages`, ordered by key.
- `page-state/rename-alias.ts` (149): rewrites the `## Facts` fence on rename.
- `page-state/versions.ts` (137) and `page-state/snapshot.ts` (137).
- `page-state/revision-backfill-schema.ts` (154), `page-state/transactions.ts` (115), `page-state/credential-reseal.ts` (144).

Depends on: `engine.ts` (15), `search/` (13), `page-body/` (8), `persistence/` (4), `facts/` (3). External: none. Postgres: `SELECT ... FOR UPDATE OF g` joined to `sources` (`guards.ts:47-76`), `ORDER BY k.n` to lock in a fixed order, `ON CONFLICT` (15 sites), `unnest(...)` (12), and `::uuid` (41 hits). Markdown: reads and rewrites the fence.

Rust port notes: the key-ordered row-lock discipline in `guards.ts` is the deadlock guard. An embedded store needs an equivalent lock ordering. Projection output (chunk boundaries) depends on the chunker version constants.

### page-window (4 files, 1,139 lines)
The large-page read contract. It provides windows, outlines, and cursors over one `PageDocument`. Every offset is a UTF-8 byte offset. Cuts land on code points and on line starts where possible. A window is bounded by bytes, so a single-line page still pages.
- `page-window/segmented.ts` (492), `page-window/window.ts` (369), `page-window/document.ts` (162), `page-window/bounded-lead.ts` (116).

Depends on: `page-body/` (4), `engine.ts` (3), `page-state/`, `text-safe.ts`, `markdown.ts`. External: none. Postgres: `ANY($n)`, `::bigint`, one `ON CONFLICT`. Markdown: splits on the `<!-- timeline -->` marker in `document.ts`.

Rust port notes: forced-cut reporting and byte semantics are part of the agent-facing read contract. Keep them byte-exact.

### generations (22 files, 3,096 lines)
The generation primitive. `publishGeneration` replaces the set of items one input owns. It fences stale producers (`generation_fenced`), holds (`generation_held`), versions and retires old items with bounded preimages, and activates the new generation in one transaction. It also includes restore and repair, and adapters for facts, takes, atoms, chronicle events, and single pages.
- `generations/publish.ts` (321): the primitive.
- `generations/fence.ts` (238): canonical fence kinds `fact_fence` and `take_fence`.
- `generations/repair.ts` (449): restore and release-held.
- `generations/managed.ts` (247) and `managed-retire.ts` (121): the managed-source coordinator path.
- `generations/plan.ts` (108): plan the result.
- `generations/adapters/fact-rows.ts` (207), `adapters/chronicle-events.ts` (299), `adapters/extracted-facts.ts` (133), `adapters/atoms.ts` (139), `adapters/single-page.ts` (112).

Depends on: `persistence/` (29), `engine.ts` (10), `contract.ts` (9), `ops/` (7), `page-body/` (4), `publish.ts`, `fence.ts`, `config.ts`. External: none. Postgres: `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)` on `generationKeyLock(key)` (`generations/fence.ts:128`, `publish.ts:71`, `managed.ts:151`, `adapters/fact-rows.ts:124,147`); `RETURNING` (11 sites), `jsonb` (about 28 uses), `::bigint` (20). Markdown: reads `## Facts` and `## Takes` fences as the system of record. An absent, unread, or segmented fence records a held generation with reason `fence_absent` and retires nothing.

Rust port notes: the advisory lock is transaction-scoped and keyed by string. The embedded store needs a cross-process lock with the same release-at-commit behavior. The exact `hashtext` value is not observable to callers. The fence-absent hold rule must be preserved exactly.

### entities (5 files, 1,479 lines)
Canonicalizes free-form entity names to `pages.slug`. It uses name variants, near-name fuzzy matching, and resolve-on-save. Falls back to a slugified form when no page matches.
- `entities/resolve.ts` (949): `resolveEntitySlug` and the main logic.
- `entities/name-variants.ts` (225), `entities/near-name.ts` (186), `entities/resolve-on-save.ts` (104), `entities/exact-match-preference.ts` (15).

Depends on: `search/` (3), `engine.ts` (3), `latin-fold.ts`, `utils.ts`, `sync.ts`, `link-ranking-policy.ts`, `facts-fence.ts`. External: none. Postgres: `ILIKE` (3), `::text`, `::int`. Markdown: reads page slugs and titles. No fence writes found by grep.

Rust port notes: slug output and near-name scores must match bit for bit, including Latin folding. ILIKE is case-insensitive matching and needs an explicit fold rule in Rust.

### mentions (10 files, 2,293 lines)
The mention pass keeps entity pages' derived aliases and `link_source='mentions'` links current. It runs incrementally from `gbrain extract --stale` and the managed stale path. Policy flags (`auto_link`) remove links once and record `disabled`.
- `mentions/pass.ts` (693): the pass, per source in scope.
- `mentions/referrers.ts` (524), `mentions/aliases.ts` (392), `mentions/siblings.ts` (155), `mentions/policy.ts` (150), `mentions/coverage.ts` (117), `mentions/stale.ts` (74).

Depends on: `engine.ts` (8), `eligibility/`, `search/` (4), `persistence/` (3), `takes-fence.ts`, `facts-fence.ts`, `page-body/`, `by-mention.ts`. External: none. Postgres: `pg_advisory_xact_lock(hashtext('gbrain:mention-entries:' || sourceId))` (`mentions/pass.ts:481`), `unnest(...)` (9), `ON CONFLICT` (6), `::timestamptz` (6), `transaction(...)` (5). Markdown: reads the `## Takes` and `## Facts` fences when looking for mentions.

Rust port notes: the pass is a per-source incremental state machine with a lock. Keep the policy transitions (`disabled` recorded once) identical.

### extract (2 files, 538 lines)
Derived-output writers for the `gbrain extract` family.
- `extract/rollup-writer.ts` (279): a per-day extract-event rollup cache, read by doctor `extract_health`. The header describes a dual-write posture.
- `extract/receipt-writer.ts` (259): receipt pages, written as first-class brain pages.

Depends on: `persistence/` (2), `engine.ts` (2), `search/`, `page-state/`. External: none. Postgres: `jsonb` (5), `ON CONFLICT` (3), `::date`. Markdown: writes receipt pages.

Rust port notes: the rollup is a cache and can be rebuilt. Receipt pages must stay markdown.

### enrich (1 file, 215 lines)
`enrich/thin.ts` holds pure helpers for `gbrain enrich --thin`: the thin-page predicate, the grounding gate, the dossier prompt builder (with injection sanitization), and the SKIP-sentinel and body parser. The synthesis engine itself lives in `src/commands/enrich.ts`, outside `src/core`.

Depends on: `think/` (1). External: none in this file; the LLM call is made by the command. Postgres: none. Markdown: parses synthesis output into a page body.

Rust port notes: pure logic. Port directly and test it with prompt and parser fixtures.

### ingestion (11 files, 3,236 lines)
The ingestion contract and daemon. `types.ts` defines the `IngestionSource` contract, which skillpack publishers depend on and which is locked by `test/public-exports.test.ts`. `daemon.ts` supervises sources and dispatches their events into the Minion queue.
- `ingestion/daemon.ts` (544): supervision and dispatch.
- `ingestion/types.ts` (387): the public contract.
- `ingestion/sources/inbox-folder.ts` (369), `sources/markdown-greenfield.ts` (334), `sources/gstack-learnings.ts` (344), `sources/file-watcher.ts` (309): sources. The file watcher uses native `fs.watch` by default.
- `ingestion/skillpack-load.ts` (345): skillpack loading. It references a GitHub docs URL in an error message.
- `ingestion/dedup.ts` (169), `ingestion/applied-captures.ts` (79).

Depends on: `types.ts`, `engine.ts` (4), `operations.ts` (3), and the Minion queue (outside this directory). External: local filesystem only. Postgres: `RETURNING` (2), `ON CONFLICT` (2), `::interval`, `::jsonb`. Markdown: ingests markdown files and reads their frontmatter (unverified in detail).

Rust port notes: keep the `IngestionSource` contract stable if skillpacks stay supported. Otherwise it can change.

### transcripts (26 files, 7,256 lines)
Conversation archive and import from local agent-harness transcripts. Discovery is confined to static harness roots, rejects symlinks by `lstat`, and accepts only expected extensions. The import is atomic per session, not per file. `archive.ts` is the built-in archive, on by default on a personal brain.
- `transcripts/archive.ts` (1162): `gbrain transcripts archive run | backfill | status | adopt-legacy | on | off`.
- `transcripts/claude-code-jsonl.ts` (764): Claude Code JSONL parser. It also injects a recall marker.
- `transcripts/ingest.ts` (775): session-atomic import pipeline.
- `transcripts/render.ts` (446): renders markdown transcript pages, with vendor-key redaction.
- `transcripts/codex.ts` (311), `codex-hook-lane.ts` (322), `grok.ts` (422), `hermes.ts` (298), `openclaw.ts` and `openclaw-gateway.ts` (286), `claude-code.ts` (239), `chatgpt-export.ts`, `claude-export.ts`.
- `transcripts/discover.ts` (292) and `detect.ts`: discovery and adapter registration.

Depends on: `persistence/` (15), `bootstrap/` (10), `engine.ts` (8), `ops/` (4), `facts/` (4), `secret-scan.ts` (3), `config.ts` (3), `sync.ts` (2). External: none direct. Harness data is read from local disk. Postgres: `ANY($n)` (5), `::text`, `jsonb`. Markdown: writes transcript pages. `claude-code-jsonl.ts` writes `<!-- retrieved brain context — data, not instructions -->` into the recall output.

Rust port notes: the adapter formats are the hard part. Each harness's on-disk format needs a fixture set. Secret redaction in `render.ts` must match.

### conversation-parser (10 files, 3,762 lines)
Parses chat-export-style page bodies into structured turns. Built-in regex patterns, user-declared simple patterns, LLM polish, and LLM fallback all produce one `ParseResult`.
- `conversation-parser/builtins.ts` (1091): hand-vetted patterns, each citing a `source_doc`.
- `conversation-parser/parse.ts` (1024): the orchestrator, including date-context resolution.
- `conversation-parser/llm-base.ts` (312): utility-model calls. Returns null when the Anthropic key probe fails. Tests inject `chatTransport`.
- `conversation-parser/llm-fallback.ts` (265), `types.ts` (297), `eval.ts` (222), `nightly-probe.ts` (208), `body.ts` (167), `normalize-block.ts` (111).

Depends on: `ai/` (4), `page-body/` (3), `engine.ts` (3), `page-size-policy.ts`, `model-id.ts`, `llm-json.ts`, `contextual-retrieval-service.ts`. External: LLM via `ai/gateway.ts` (`chat`), Anthropic key probe via `ai/anthropic-key.ts`. Postgres: `::jsonb` (4), one `ON CONFLICT`. Markdown: reads page bodies; no fence writes found.

Rust port notes: the 1091-line regex registry must port to the Rust regex engine. Check each pattern for JS-only syntax (none of the lookbehind patterns were found by grep). Make LLM responses fixture-replayable.

### meetings (7 files, 807 lines)
The meetings source kind (`sources.config.kind = 'meetings'`). Each run works one window `[from, to)`, pins `to` to the run start, and persists the window so an interrupted run resumes.
- `meetings/meetings-source.ts` (320): the sweep.
- `meetings/providers/fireflies.ts` (176): the only provider; `providers/index.ts` registers it.
- `meetings/render.ts` (100), `meetings/types.ts` (96), `meetings/source-add.ts` (71), `meetings/source-config.ts` (31).

Depends on: `connectors/` (6), `persistence/` (4), `ops/` (2), `sync.ts`, `spawn.ts`, `outside-content.ts`, `git-env.ts`. External: Fireflies GraphQL at `https://api.fireflies.ai` (`FIREFLIES_BASE_URL`), with operations `GbrainUser`, `GbrainTranscripts`, and `GbrainTranscript`, using an API key. Postgres: `::timestamptz`, `::text`. Markdown: writes one page per meeting.

Rust port notes: shape-drift errors (`MeetingShapeDriftError`) and error-code mapping are part of the contract. Keep them.

### chronicle (19 files, 2,968 lines)
Life Chronicle. It extracts events from page revisions into content-addressed event pages with timeline projections. A ledger decides, per page content, whether extraction runs, with reason codes. A daily reservation caps spend.
- `chronicle/extract-events.ts` (430): deterministic when and who, then LLM judge, then parse barrier, then write events.
- `chronicle/execute.ts` (396): runs one ledger row. Shared by the `chronicle` cycle phase and the `chronicle_extract` job.
- `chronicle/publish.ts` (308), `backfill.ts` (230), `ledger.ts` (223), `reasons.ts` (205), `config.ts` (163), `contract.ts` (143), `eligibility.ts` (106).

Depends on: `persistence/` (13), `engine.ts` (11), `budget/` (9), `trust/` (5), `page-body/` (5), `generations/` (5), `ingestion/` (3). External: LLM judge through the chat gateway (default), subject to the budget tracker. Postgres: `pg_advisory_xact_lock(hashtext('gbrain:chronicle:daily_reservation'))` (`chronicle/ledger.ts:97`), `SELECT DISTINCT ON (c.source_id, c.page_id)` (`chronicle/ledger-stats.ts:93`), `RETURNING` (4), `::numeric`, `::timestamptz`. Markdown: writes event pages, and an owner key `depth:<slug>` links them to the depth page's timeline.

Rust port notes: the judge is nondeterministic. Parity tests need recorded judge outputs. The daily reservation must stay serialized.

### connectors (19 files, 3,633 lines)
Outbound connector framework and two web-session providers.
- `connectors/sync.ts` (630): resolve credential, probe, read watermark, list newest-first, skip unchanged.
- `connectors/client.ts` (399): plain `fetch` against a hardcoded origin. It has an off-origin guard, does not follow redirects, and refreshes once on 401.
- `connectors/item-holds.ts` (342) and `item-holds-store.ts` (241): an item is held after 3 consecutive item-scoped failures.
- `connectors/credentials.ts` (145): stores credentials at `~/.gbrain/connectors/<provider>.json`, mode 0600.
- `connectors/oauth-pkce.ts` (201): PKCE with a loopback redirect on `127.0.0.1`.
- `connectors/providers/chatgpt.ts` (268) and `providers/claude.ts` (262).
- `connectors/failed-ledger.ts` (152), `connectors/types.ts` (169).

Depends on: `persistence/` (8), `engine.ts` (7), `ops/` (4), `transcripts/` (3), `page-body/` (2), `batch-rows.ts`. External: `https://chatgpt.com/backend-api/*` (conversation list and fetch, `/api/auth/session`), best-effort OAuth at `auth.openai.com` (`--try-oauth`), and `https://claude.ai/api/organizations/...` with an `anthropic-client-platform` header. Auth is by session cookie or bearer token. Postgres: `jsonb` (15), `ON CONFLICT` (4), `BEGIN` (4). Markdown: writes transcript pages through `transcripts/`.

Rust port notes: the cookie-based web-session providers are fragile against upstream changes. Keep the off-origin and no-redirect guards. Credentials stay on the file plane at mode 0600.

### google (22 files, 6,417 lines)
The google source kind. It sweeps Gmail threads, Calendar, and Contacts. A loops engine tracks open commitments and waiting-for-reply state. It uses one LLM call per thread page for extraction and a zero-LLM state machine for loop detection.
- `google/google-source.ts` (1023): the source.
- `google/google-clients.ts` (866): hand-rolled REST clients. There is no googleapis dependency.
- `google/loops-extract.ts` (627): LLM commitment and decision extraction.
- `google/people-calendar-sweep.ts` (492): Contacts and Calendar sweeps with `syncToken` cursors. An expired token drops the cursor and re-lists in windows.
- `google/loop-detect.ts` (423): deterministic thread state.
- `google/google-render.ts` (453), `google/loop-catchup.ts` (369), `google/api-access.ts` (147).

Depends on: `creds` (12), `engine.ts` (11), `persistence/` (10), `connectors/` (8), `ops/` (3), `loops` (3), `path-confine.ts`, `trust/` (2). External: Gmail at `https://gmail.googleapis.com/gmail/v1` (`messages.list`, `threads`, `history.list`), Calendar at `https://www.googleapis.com/calendar/v3` (`events.list`), People at `https://people.googleapis.com/v1` (`people.list`, `connections`). Scopes: `gmail.readonly`, `calendar.readonly`, `contacts.readonly`. LLM for `loops-extract.ts`. Postgres: `SELECT DISTINCT ON (counterparty_email)` (`google/loop-catchup.ts:125`), `jsonb` (15), `BEGIN` (3), `ON CONFLICT` (2), `::timestamptz`. Markdown: writes Gmail, Calendar, and People pages. `sweep-shared.ts` restores the `## Facts` fence.

Rust port notes: sync-token expiry (`EXPIRED_SYNC_TOKEN`) and the Google `ErrorInfo` parsing are contract points. `loop-detect.ts` is deterministic and makes a good parity fixture set.

### slack (6 files, 891 lines)
The slack source kind. It writes one page per channel per day, and holds channels the app can no longer read without stopping the others.
- `slack/slack-source.ts` (335): the sweep.
- `slack/client.ts` (176): Web API methods.
- `slack/render.ts` (188), `slack/source-add.ts` (84), `slack/types.ts` (65), `slack/source-config.ts` (43).

Depends on: `connectors/` (9), `persistence/` (4), `meetings/` (4), `ops/` (2), `page-body/`, `outside-content.ts`, `markdown.ts`. External: `https://slack.com/api/` with `auth.test`, `conversations.info`, `conversations.history`, `conversations.replies`, and `users.list`, using a bearer token. Rate-limit responses wait 60 seconds. Postgres: minimal (`::timestamptz`, `::text`, `::int`). Markdown: writes daily channel pages.

Rust port notes: Slack error codes map to typed errors. The port is straightforward.

### git (8 files, 2,926 lines)
Shared-checkout-safe commit, push, and pull for classic (unmanaged) brain repositories. Many writers commit to one checkout, so nothing here rebases, stashes, or resets the working tree.
- `git/commit-push.ts` (1615): commit, push, and pull under a commit lock.
- `git/range-secret-scan.ts` (394): scans `base..head` before an automatic publish. The scan covers messages, added lines, and merge conflict resolutions.
- `git/commit-guard.ts` (239): an opt-in `prepare-commit-msg` hook that refuses commits not made under the lock.
- `git/skipped-paths.ts` (213), `git/commit-ledger.ts` (200), `git/reconcile.ts` (146), `git/git-run.ts` (71), `git/upstream-history.ts` (48).

Depends on: `persistence/` (8), `git-env.ts` (7), `ops/` (6), `git-transport.ts` (5), `spawn.ts` (4), `agent-output.ts`, `sync.ts`, `storage-config.ts`. External: the `git` CLI, called as `execFileSync('git', ['-C', root, ...])` (`git/git-run.ts`), and the remote over git transport. Postgres: no SQL features found; the directory only imports `persistence/` (8 sites). Markdown: writes brain checkout files. Commit messages carry a `GBRAIN_COMMIT_VIA` trailer.

Rust port notes: this is a shell-out design by nature. The commit-lock and hook contract must be reproduced exactly, and the secret-scan rules must match.

### company-brain (29 files, 2,377 lines)
Shared company-brain admission, receipts, revision, inspection, and verification. A `sample/` subtree holds fixture markdown (`company-brain/sample/`).
- `company-brain/admission.ts` (292): admission with a schema-pack lock.
- `company-brain/receipts.ts` (280): receipts, locked by source incarnation.
- `company-brain/revision.ts` (262), `company-brain/runtime.ts` (261): runtime locks on the `persistence_brain` singleton and `sources`.
- `company-brain/inspection.ts` (406), `profile.ts` (141), `policy.ts` (83), `verification.ts` (73), `demo.ts` (68).

Depends on: `persistence/` (16), `ops/` (13), `schema-pack` (10), `engine.ts` (7), `link-reconciliation.ts` (4), `error-registry.ts` (4), `agent-output.ts` (4), `markdown.ts` (3). External: none. Postgres: `SELECT ... FOR UPDATE` on the `persistence_brain` singleton (`company-brain/runtime.ts:138`), on `sources` (`runtime.ts:222`, `receipts.ts:204`), and on `config` for `schema_pack` (`admission.ts:250`). Also `transaction(...)` (6), `ON CONFLICT` (2), `::uuid` (21), `jsonb` (9). Markdown: reads the schema pack.

Rust port notes: the source incarnation UUID is part of the row-lock keys. Port the lock semantics, not only the table shape.

### Parity risks
- Advisory locks (`pg_advisory_xact_lock`) in generations, mentions, chronicle, and facts/writeback-settings must keep their mutual exclusion and transaction-scoped release. This is the hardest Postgres dependency to replace.
- Byte-exact round trip of `## Facts` and `## Takes` fences and the `gbrain:facts:begin/end` markers. Fence-absent and segmented-fence holds must match.
- Segmenter cut positions and UTF-8 byte offsets in `page-body` and `page-window` are observable through the read contract.
- Nondeterministic LLM outputs (facts extraction, chronicle judge, conversation-parser polish, loops extraction). Parity needs recorded or stubbed responses. The `chatTransport` seam in `conversation-parser/llm-base.ts` is a starting point.
- Live third-party behavior (Gmail sync tokens, Slack error codes, Fireflies GraphQL shape, ChatGPT and Claude web endpoints) is hard to test in CI. Recorded fixtures are needed.
- The 1091-line regex registry in `conversation-parser/builtins.ts` must port to Rust regex with the same match results.
- The git commit lock and `prepare-commit-msg` hook contract in `git/` must be reproduced for shared checkouts.

### Open questions for Garry
- Should the web-session connectors (`connectors/providers/chatgpt.ts`, `claude.ts`) ship in the Rust core, or move to an optional sidecar? They depend on unofficial endpoints.
- Should LLM-backed steps (facts extraction, chronicle judge, loops extraction, conversation-parser polish) run in-process in Rust, or behind an external process?
- Is segmented page storage (`page-body/`, schema v248) required for v1, or can v1 stay with single-string bodies?
- Is the classic git-backed brain (`git/`) a supported mode with embedded storage, or is it retired?
- Which transcript harness adapters are required for v1 (Claude Code, Codex, Grok, Hermes, OpenClaw, exports)?
- Should the `IngestionSource` contract stay frozen for third-party skillpacks in Rust?

## Access control, setup, skills, and CLI platform

Reference: `garrytan/gbrain` at origin/master 8bbfd0b5e8 (v0.60.x). Counts are all files and lines under each directory (recursive, including YAML and generated files), measured with `find ... | wc`. "sql" hits are rough regex counts of `sql\``, `executeRaw`, `engine.` and `BrainEngine` in the directory; they are indicators, not exact query counts. Mentions of `pg_`, `jsonb`, `ON CONFLICT`, `RETURNING` and similar are counted separately below each entry where relevant.

### Cross-cutting Postgres features in this group

| Feature | Where | Notes |
|---|---|---|
| Row-level security (RLS) | `access/caller.ts`, `access/policy.ts`, `guests/note.ts`, `guests/schema.ts`, `eligibility/generation-schema.ts`, `shared-skills/access-schema.ts` | RLS is enabled only when the installing role has `rolbypassrls` or superuser (`DO $rls$` blocks). Code detects "unreadable" state with `pg_catalog.row_security_active()`, `pg_policy`, or the SQL helper `gbrain_access_state_unreadable()`, and refuses with `permission_denied` instead of reading empty. The recipe is in `docs/ENGINES.md` ("Folder access tables", "derived-state-maintainers"). |
| Transaction-local settings | `trust/schema.ts`, `trust/fence-guard.ts`, `trust/proposals.ts`, `guests/admission.ts`, `eligibility/generation-schema.ts` | `set_config(..., true)` / `current_setting('gbrain.*', true)` carry the writer's trust tier, origin, principal, request id, guest note and backfill flags into BEFORE ROW triggers. |
| plpgsql triggers and functions | `trust/schema.ts`, `guests/schema.ts`, `eligibility/generation-schema.ts`, `shared-skills/schema.ts`, `shared-skills/persistence-schema.ts` | Stamp/guard triggers. `shared-skills` has about 5 plpgsql guard functions. `SET search_path = pg_catalog, public, pg_temp` on each. |
| Row locks | 26 files in group | `FOR UPDATE` / `FOR SHARE` (heaviest in `shared-skills` and `grants`). No `pg_advisory_*` or `LISTEN/NOTIFY` hits in these directories. |
| Catalog reads | `trust/backfill.ts`, `trust/provenance-drift.ts`, `grants/rescope.ts` | `information_schema.columns` to detect columns at runtime. |
| Array and JSON types | `grants/encoding.ts` (`pgArray`), `grants/model.ts` | `text[]` columns for granted sources; `jsonb` in 43 files. |

### access

Per-member read access inside one source. It owns the folder-rule (`access_rules`) policy lifecycle, the `readable_by` principal normalization, the caller's satisfied-rule record, and the open-page and requester-scope filters. Key files: `src/core/access/policy.ts` (folder-rule lifecycle; one `access_policy_state` row is the lock; desired rulebooks go to an append-only `access_policy_revisions` log; refuses under RLS), `src/core/access/caller.ts` (`folderAccessFor`/`folderAccessForAll`, fail-closed when unreadable), `src/core/access/principals.ts` (row twin of SQL `gbrain_access_readers()`; a test holds them equal), `src/core/access/policy-git.ts` (git-store rulebook from `.gbrain/access.yml`), `src/core/access/open-pages.ts` (open-page predicates shared by count and repair), `src/core/access/requester-scope.ts` (unbound remote reads on multi-person brains), `src/core/access/members.ts` (member records). Depends on `trust/`, `search/private-visibility.ts`, `ops/`, `scope.ts`, and the engine. No external services; the git store reads a committed file. Postgres: BEFORE trigger keeps `pages.page_readers` equal to `readers`; migration v283 stamps `folder_rule_ids`; migration v309 maintains `access.serves_derived`; RLS on folder tables; row locks on the state row.
Size: 28 files, 5,240 lines. SQL-ish hits about 261.
Rust port notes: The readers normalization and the SQL function must be ported as one Rust function with a fixture test. Decide whether the refusals for RLS-hidden tables exist at all in a single-process embedded store. Their text and error code are parity-visible.

### trust

Memory trust tiers (#5575): the `trust_tier` and `write_origin` columns, a BEFORE ROW trigger that stamps and guards them, the `page_versions` snapshot, the per-token `min_trust` read floor, `trust_proposals` (owner decisions), owner review, and the lower-only and supersede handlers. Key files: `src/core/trust/schema.ts` (trigger DDL; reads `gbrain.write_trust_tier`, `write_origin`, `write_trust_promotion`, `write_trust_backfill`, `write_trust_keep`, and the guest-aware stamp function), `src/core/trust/page-handlers.ts` (owner confirm and `lower_page` proposals), `src/core/trust/review.ts` (owner queue and `trust explain`), `src/core/trust/propagation.ts` (write-source gating via `gbrain.write_sources`), `src/core/trust/derived-gate.ts` (row-level write gate for derivers), `src/core/trust/fence-guard.ts` (writer rank via `trustRankSql`), `src/core/trust/backfill.ts` (backfill with `information_schema` discovery). Depends on `access/`, `guests/` (guest source table), `eligibility/` (generation counter), `persistence/context.ts` (sets the transaction-local settings), and `trust/tier.ts`, which is outside this group. No external services. Postgres: plpgsql triggers, transaction-local `set_config`, `information_schema`, row locks (10 hits).
Size: 31 files, 6,638 lines. SQL-ish hits about 319, the largest in the group.
Rust port notes: Every writer must pass the same stamp context explicitly. The trigger's rules become a Rust write-path check, or the embedded engine needs an equivalent trigger mechanism. Backfill bypass ("keep" tables, backfill on) must be reproduced exactly.

### grants

API grant model for clients and bearer tokens: profiles, scopes, granted sources, and the `private_pages` read mode. Key files: `src/core/grants/model.ts` (`GRANT_PROFILES` = memory-reader, memory-writer, coding-agent, operator, delegating-agent, full; `GrantError`; `normalizeGrantBrain`; `grantFromRow`), `src/core/grants/service.ts` (`GrantDatabase = BrainEngine | SqlQuery`), `src/core/grants/legacy-token.ts` (`auth rescope --token`; source and takes-holder axes), `src/core/grants/shared-exposure.ts` (shared-source exposure), `src/core/grants/rescope.ts` (rescope with `information_schema` column check), `src/core/grants/cli.ts`, `src/core/grants/profiles.ts` (catalog and provenance), `src/core/grants/encoding.ts` (`pgArray`). Depends on `scope.ts`, `legacy-token-scope.ts`, `source-id.ts`, and `access/`; `harness/capabilities.ts` reads its TTL bounds. No external services. Postgres: `text[]` arrays through `pgArray`, `information_schema`, row locks (14 hits), columns on `access_tokens` and `oauth_clients`.
Size: 13 files, 1,988 lines. SQL-ish hits about 61.
Rust port notes: `pgArray` disappears; use native list columns or JSON in the embedded store. Scope-string parsing and profile expansion must be byte-identical because they appear in CLI JSON output.

### guests

Guest sources (GBRA-504): sources that only guests may write, with a tier ceiling, per-page guest marks, and owner promotions. Key files: `src/core/guests/schema.ts` (tables `guest_sources`, `guest_marks`, `guest_promotions`; RLS on all three when the role can bypass it; plpgsql `gbrain_guard_guest_records` makes marks immutable and refuses unreadable path changes), `src/core/guests/admission.ts` (writer admission; `SELECT ... FOR SHARE` on `guest_sources`; sets `gbrain.guest_note`), `src/core/guests/note.ts` (`GUEST_SOURCES_HIDDEN_SQL`, detects RLS hiding via `row_security_active` and `pg_policy`), `src/core/guests/marker.ts`, `src/core/guests/promote.ts`, `src/core/guests/owner-credentials.ts`, `src/core/guests/derived.ts`. Depends on `trust/` (trigger reads the table), `access/`, and `grants/`. No external services. Postgres: RLS, `FOR SHARE`, transaction-local `set_config`, plpgsql guard, `pg_policy` introspection.
Size: 12 files, 1,131 lines. SQL-ish hits about 52.
Rust port notes: The database-only guest source is a Postgres-role concept. Decide whether the embedded store keeps a guest table with an immutability rule and drops the role-based refusal. Keep the error text for the immutable-mark refusal (`guest_mark_immutable`).

### creds

Generic credential vault for outbound credentials (Google OAuth today; Dropbox, Mac-companion tokens, others by provider). Key files: `src/core/creds/vault.ts` (`FileVaultBackend`: `~/.gbrain/credentials.json`, mode 0600, atomic write; `EngineVaultBackend`: DB-backed vault for hosted gbrain.io), `src/core/creds/providers/google.ts` (hand-rolled Google OAuth client), `src/core/creds/relay-client.ts` (client for the gbrain.io OAuth consent relay; tokens claimed once; 10-minute session TTL), `src/core/creds/redirect.ts` (loopback redirect handling), `src/core/creds/errors.ts` (typed errors), `src/core/creds/export.ts` (credential export). Depends on the engine only through `EngineVaultBackend`. External services: `accounts.google.com`, `oauth2.googleapis.com/token`, `openidconnect.googleapis.com`, `gmail.googleapis.com` (sendAs); the gbrain.io relay. Postgres: none directly (0 SQL hits); the hosted backend uses an engine table.
Size: 6 files, 1,515 lines.
Rust port notes: The file backend (0600, atomic rename) is the CLI default and ports directly. Google and relay HTTP calls need an HTTP client with the same error mapping. Do not log tokens.

### eligibility

Trust-policy eligibility: which pages are eligible for which retrieval and trust policies, with generation counters that invalidate caches. Key files: `src/core/eligibility/generation-schema.ts` (plpgsql `bump` trigger function guarded by the txn-local flag `gbrain.trust_generation_bumped`; RLS on `TRUST_POLICY_STATE_TABLE` only when the role can bypass RLS), `src/core/eligibility/generation.ts` (counter read), `src/core/eligibility/scan.ts` (eligibility scan), `src/core/eligibility/stamp.ts` (stamping), `src/core/eligibility/activation.ts` (policy activation), `src/core/eligibility/fence-overlay.ts` (overlay on trust fences), `src/core/eligibility/sql.ts` (SQL fragments, 117 lines), `src/core/eligibility/registry.ts`. Depends on `trust/` and `access/`. No external services. Postgres: plpgsql trigger, `pg_roles` and `pg_has_role` checks, RLS, `SET search_path`.
Size: 11 files, 1,597 lines. SQL-ish hits about 44.
Rust port notes: The generation counter is a cache key. The embedded store can implement it as a plain integer in the same transaction. The SQL fragments in `sql.ts` must be rewritten as typed predicates.

### budget

Per-run and per-day USD budget for gateway LLM calls (unified BudgetTracker, v0.37.x). Key files: `src/core/budget/budget-tracker.ts` (tracker class, `BudgetExhausted` error; scope via `withBudgetTracker` in `ai/gateway.ts`, using AsyncLocalStorage), `src/core/budget/daily-ledger.ts` (durable per-UTC-day ledger over `budget_ledger` and `budget_reservations`, migration v012; every process on the brain shares one ceiling), `src/core/budget/reservation-cost.ts` (reserve-then-settle cost), `src/core/budget/models-used.ts` (model accounting), `src/core/budget/no-pricing.ts` (unknown-model fallback), `src/core/budget/cap-flag.ts` (cap flag parsing). Depends on `ai/gateway.ts` and `anthropic-pricing.ts` (outside group). External services: LLM providers, reached through the gateway. Postgres: `budget_ledger` and `budget_reservations` tables, 9 SQL hits, one row-lock use.
Size: 6 files, 1,564 lines.
Rust port notes: AsyncLocalStorage maps to an explicit context or task-local value. The daily ceiling is cross-process, so the embedded store needs atomic reservations across processes. This is the case that a single-writer file lock must cover.

### bootstrap

`gbrain bootstrap` (harness, repo, hooks, verify, status): wires a host agent framework and a brain together, writes host config, and verifies it. Key files: `src/core/bootstrap/harness.ts` (2,632 lines; `gbrain bootstrap harness` for a framework that spawns `claude -p`, codex exec, or opencode run on a box that runs `gbrain serve --http`), `src/core/bootstrap/verify.ts` (1,335; post-install checks), `src/core/bootstrap/hooks.ts` (1,182; hook entries), `src/core/bootstrap/repo.ts` (866; brain repo setup), `src/core/bootstrap/status.ts` (618), `src/core/bootstrap/opencode-json.ts` (574; opencode config), `src/core/bootstrap/codex-toml.ts` (479) and `codex-hooks.ts` (511; codex config). Depends on `setup/`, `harness/`, `onboard/`, and the engine. External: none direct; it writes host config files. Postgres: 43 SQL hits; 10 files mention PGLite, so PGLite paths are present (for example `verify.ts`, `status.ts`, `lock.ts`).
Size: 32 files, 12,951 lines. The largest directory in the group.
Rust port notes: This is the biggest port cost in the group. Split it into the bootstrap command, host-config writers, and verification. Host config writers (JSON, TOML) must preserve existing user content and ownership hashes byte for byte.

### setup

`gbrain setup <host>` wiring: MCP entries, hook entries, and skill blocks for Claude Code, Codex, OpenClaw, Pi, Hermes, and others. Key files: `src/core/setup/claude-code.ts` (MCP entry in `~/.claude.json`, user or project scope; hook entries owned by exact hash via a connection receipt), `src/core/setup/codex.ts` (codex config), `src/core/setup/skills-block.ts` (814 lines; generated instruction block text), `src/core/setup/brain-first.ts` (brain-first instruction block), `src/core/setup/turn-hook.ts` and `turn-hook-check.ts` (per-turn hook), `src/core/setup/hermes-turn-hook.ts`, `src/core/setup/openclaw-skill-plugin.ts` and `openclaw-skill-plugin-code.ts` (plugin source as an embedded string), `src/core/setup/pi-skill-extension.ts` and `pi-skill-extension-code.ts`. Depends on `mcp-registration.ts` (outside group), `harness/`, and `bootstrap/`. No external services. Postgres: none (0 SQL hits, 0 PGLite hits).
Size: 25 files, 6,269 lines.
Rust port notes: The `*-code.ts` files embed JS or TS payloads that get installed into host runtimes. Keep those bytes identical, because receipts and hashes depend on them. Config merges must keep the user's own entries.

### onboard

Onboarding checks and nudges shown after install: brain health, MCP onboarding, and impact capture. Key files: `src/core/onboard/checks.ts` (808 lines; brain-wide aggregates for `orphan_count`, `stale_count`, `link_coverage`, `takes_count`; file marked `sourcescope:file-brain-wide`), `src/core/onboard/mcp-onboarding.ts` (416; MCP connection flow), `src/core/onboard/impact-capture.ts` (213), `src/core/onboard/init-nudge.ts` (115), `src/core/onboard/writeback-nudge.ts` (113), `src/core/onboard/render.ts` (102), `src/core/onboard/hosted-option.ts` (62, hosted-plan option). Depends on the engine and `setup/`. No external services. Postgres: 59 SQL hits (aggregates across all sources, by design); 3 PGLite mentions.
Size: 8 files, 1,897 lines.
Rust port notes: Each check is a count or ratio. Port the SQL aggregates as a single typed query per check and keep the metric names, since they appear in JSON output. The brain-wide scope is intentional and should stay so.

### agent-install

Resumable, non-root local setup path that never creates an identity or server. Key files: `src/core/agent-install/setup.ts` (337 lines; the main resumable flow; imports `PGLiteEngine` and `PgliteBusyError`), `src/core/agent-install/state.ts` (211; resumable state file), `src/core/agent-install/init-state.ts` (50), `src/core/agent-install/entry.ts` (42; entry point), `src/core/agent-install/launcher.ts` (32), `src/core/agent-install/environment.ts` (25), `src/core/agent-install/shared-skills.ts` (69). Depends on `pglite-engine.ts`, `pglite-lock.ts`, `bootstrap/`, and `shared-skills/`. No external services. Postgres: 7 SQL hits; 5 files mention PGLite directly.
Size: 7 files, 766 lines.
Rust port notes: This is the directory most directly coupled to PGLite, so it is the first to change. Keep the state-file format and resume semantics, and replace the PGLite lock with the embedded store's lock.

### skillpack

Installable skill bundles ("skillpacks"): install, update, doctor, and a remote registry. Key files: `src/core/skillpack/installer.ts` (919 lines; copies bundle files into an OpenClaw workspace atomically with per-file diff protection), `src/core/skillpack/harness-bridge.ts` (1,036; bridge to harness hosts), `src/core/skillpack/bundle.ts` (652), `src/core/skillpack/safe-update.ts` (530; update with data-loss protection), `src/core/skillpack/registry-client.ts` (369; fetch, cache, and stale fallback for the registry; 1-hour soft TTL, 7-day stale escalation), `src/core/skillpack/tarball.ts` (414; tar extraction), `src/core/skillpack/manifest-v1.ts` (390), `src/core/skillpack/rubric.ts` (511; scoring rubric), `src/core/skillpack/doctor.ts` (368). Depends on `skills/`, `shared-skills/`, `harness/`, and `setup/`. External: `raw.githubusercontent.com` for `garrytan/gbrain-skillpack-registry` (`registry.json`, `endorsements.json`). Postgres: 15 SQL hits, 1 PGLite mention.
Size: 41 files, 12,018 lines.
Rust port notes: Tarball extraction needs path-traversal and symlink checks. The registry cache and offline fallback need a warning once per process. Manifest and rubric output are JSON that tests compare.

### skills

Bundled skill catalog and the per-turn skill resolver. Key files: `src/core/skills/resolver/resolve.ts` (438 lines; one turn: reads the catalog index, ranks the message, applies no-repeat and budget rules, renders the block; never touches the network, a model, or a brain), `src/core/skills/resolver/hook-lane.ts` (438; hook path), `src/core/skills/resolver/sources.ts` (361; index sources), `src/core/skills/resolver/build.ts` (314; index build), `src/core/skills/resolver/index-format.ts` (282; index file format), `src/core/skills/resolver/session.ts` (253; session no-repeat state), `src/core/skills/resolver/rank.ts` (135), `src/core/skills/resolver/lock.ts` (153; index lock), `src/core/skills/bundled-skills.generated.ts` (872; generated from repo-root `skills/`; `bun run regen:all`). Depends on nothing in the database. External services: none. Postgres: none (0 SQL hits).
Size: 29 files, 4,670 lines.
Rust port notes: Output outside `meta` is documented as byte-identical for the same index, input, and session state. Keep that as a golden test. Generated bundles should become build-time embedded files; the index format needs to be read by both sides during transition.

### shared-skills

Shared skill publication, membership, policy, and migration of skills into the database. This is the most database-heavy directory in the group. Key files: `src/core/shared-skills/publication.ts` (632 lines; publication flow), `src/core/shared-skills/migration-export.ts` (346), `src/core/shared-skills/migration.ts` (289), `src/core/shared-skills/membership.ts` (284), `src/core/shared-skills/policy.ts` (248), `src/core/shared-skills/access-schema.ts` (RLS on ten tables when the role can bypass RLS), `src/core/shared-skills/schema.ts` (plpgsql `gbrain_lease_shared_skill_delivery` trigger), `src/core/shared-skills/persistence-schema.ts` (plpgsql guards `gbrain_guard_request_protocol`, `gbrain_guard_effect_protocol`, `gbrain_guard_protocol_activation`, `gbrain_require_persistence_protocol`, `gbrain_guard_skill_publication`). Tables: `shared_skill_state`, `shared_skill_policies`, `shared_skill_packs`, `shared_skill_policy_audit`, `shared_skill_heads`, `shared_skill_revisions`, `shared_skill_revision_leases`, `shared_skill_members`, `shared_skill_delivery_batches`, `persistence_writer_protocols`. Depends on `access/`, `skillpack/`, `harness/`, and the engine. No external services. Postgres: RLS, about 5 plpgsql guard functions, row locks (20 hits), about 157 SQL hits.
Size: 36 files, 4,868 lines.
Rust port notes: Highest port cost and highest risk. The protocol and lease guards are Postgres triggers that must be re-expressed as state-machine checks in the Rust write path. Decide whether v1 ships shared skills at all.

### skillify

Scaffolds a new skill directory from a template. Key files: `src/core/skillify/generator.ts` (197 lines; creates the skill files), `src/core/skillify/templates.ts` (198; template text). No database and no external services (0 SQL hits).
Size: 2 files, 395 lines.
Rust port notes: Simple file generation. Keep template text byte-identical so generated skills match the TypeScript output.

### skillopt

Skill optimization loop: run benchmarks against a skill, reflect, apply edits, gate them, and record cycles, with a cosine-decay learning-rate curve (default base 4, 10 steps). Key files: `src/core/skillopt/orchestrator.ts` (1,068 lines; `runSkillOpt` main loop), `src/core/skillopt/reflect.ts` (502; reflection step), `src/core/skillopt/types.ts` (422), `src/core/skillopt/models-plan.ts` (407; model selection per phase), `src/core/skillopt/benchmark.ts` (393), `src/core/skillopt/bootstrap-benchmark.ts` (356), `src/core/skillopt/cycle-phase.ts` (338), `src/core/skillopt/apply-edits.ts` (327), `src/core/skillopt/validate-gate.ts` (313), `src/core/skillopt/preflight.ts` (305). Depends on `budget/`, `ai/` (model calls; unverified in detail), and `skills/`. External services: LLM providers (unverified exact endpoints). Postgres: about 50 SQL hits (run and cycle records).
Size: 31 files, 7,516 lines.
Rust port notes: Long-running and budget-bound. The cycle and batch state must survive restarts. Model choice per phase is config, so keep the config schema unchanged.

### schema-pack

Schema packs: YAML definitions of page types and rules, with a mutation engine, lint rules, a registry, and a lock file. Key files: `src/core/schema-pack/mutate.ts` (991 lines; `withMutation` eight-step failure-safe skeleton), `src/core/schema-pack/base/gbrain-base.yaml` (462) and `gbrain-base-v2.yaml` (682; the built-in base packs), `src/core/schema-pack/lint-rules.ts` (538), `src/core/schema-pack/manifest-v1.ts` (481), `src/core/schema-pack/loader.ts` (386), `src/core/schema-pack/registry.ts` (364), `src/core/schema-pack/load-active.ts` (314; active pack resolution), `src/core/schema-pack/pack-lock.ts` (298), `src/core/schema-pack/retype.ts` (368), `src/core/schema-pack/unify-types-handler.ts` (423). Depends on `persistence/filesystem-guard.ts` (outside group) and the engine. External services: none. Postgres: about 76 SQL hits, 8 PGLite mentions.
Size: 48 files, 10,621 lines.
Rust port notes: YAML loading and manifest validation must match on error text and ordering. `withMutation`'s failure-safe order is a parity point. The two base YAML files are inputs; port them as data.

### resolvers

External-lookup resolver interface and built-in resolvers used by `gbrain integrity --auto`. Key files: `src/core/resolvers/interface.ts` (158 lines; resolver contract), `src/core/resolvers/registry.ts` (151; registration), `src/core/resolvers/index.ts` (26), `src/core/resolvers/builtin/x-api/handle-to-tweet.ts` (442; X API v2 recent search; returns URL, tweet id, and a confidence score), `src/core/resolvers/builtin/url-reachable.ts` (119; URL reachability check). Depends on the engine only lightly (2 SQL hits). External services: X API v2 recent search (exact host and credential env var unverified in this pass). Postgres: minimal.
Size: 5 files, 896 lines.
Rust port notes: The confidence scoring is the contract that `integrity` relies on, so keep the numeric thresholds. The HTTP client must be injectable for tests.

### verbs

MEMORY_VERBS v1: zero-LLM entity lookup and card builder (`entity(name)`), with name resolution and mention extraction. Key files: `src/core/verbs/entity-card.ts` (853 lines; builds the card; p99 under 100 ms target), `src/core/verbs/entity-references.ts` (245), `src/core/verbs/entity-card-identity.ts` (213), `src/core/verbs/entity-variants.ts` (169), `src/core/verbs/entity-source.ts` (125), `src/core/verbs/entity-names.ts` (113), `src/core/verbs/entity-text-mentions.ts` (110), `src/core/verbs/usage-log.ts` (156; usage log), `src/core/verbs/conformance.ts` and `conformance-fixtures.ts` (conformance suite and fixtures). Depends on the retrieval reflex and the engine. External services: none. Postgres: about 52 SQL hits.
Size: 10 files, 2,578 lines.
Rust port notes: Keep the card's field order and the name-resolution order (alias first, then exact title, exact slug, slug suffix). The conformance fixtures can be reused as the parity suite for the Rust port.

### output

`BrainWriter`: a transaction-scoped writer with pre-commit validators (citation, link, triple-HR, back-link) and post-write steps. Key files: `src/core/output/writer.ts` (399 lines; write transaction and commit validation), `src/core/output/post-write.ts` (251), `src/core/output/scaffold.ts` (236; page scaffolding), `src/core/output/slug-registry.ts` (162; slug registry), `src/core/output/validators/citation.ts` (180), `src/core/output/validators/link.ts` (164), `src/core/output/validators/triple-hr.ts` (97), `src/core/output/validators/back-link.ts` (72). Depends on the engine and the markdown brain format. External services: none. Postgres: about 52 SQL hits, one row-lock use.
Size: 9 files, 1,608 lines.
Rust port notes: The validators are mostly pure functions over markdown and port cleanly. The transaction semantics (validate on commit, refuse the whole write) must match exactly, since agents rely on the error shape.

### cli-socket

Warm CLI socket: a local Unix socket that lets CLI invocations reuse a running server. It is opt-in (`gbrain serve --cli-socket` or `serve.cli_socket`) and Postgres brains only. Key files: `src/core/cli-socket/server.ts` (235 lines; listener; checks the peer uid before parsing any byte; does not open on platforms where peer uid cannot be read), `src/core/cli-socket/identity.ts` (226; caller identity), `src/core/cli-socket/execute.ts` (176; command dispatch), `src/core/cli-socket/protocol.ts` (168; wire protocol), `src/core/cli-socket/fs-guard.ts` (136; filesystem guard), `src/core/cli-socket/peer-cred.ts` (77; kernel peer credentials), `src/core/cli-socket/output-capture.ts` (87), `src/core/cli-socket/refusals.ts` (55), `src/core/cli-socket/probe.ts` (56). Depends on the engine, `brain-resolver.ts`, and `cli-options.ts`. External services: none (local socket). Postgres: 11 SQL hits; PGLite delegates through a persistence owner socket instead.
Size: 9 files, 1,216 lines.
Rust port notes: Peer-uid checks map to `SO_PEERCRED` on Linux and a different call on macOS; keep the refuse-to-listen rule. An embedded single-process store may make the socket unnecessary, so decide before porting.

### claw-test

Harness that drives external agent hosts (openclaw, hermes, grok, opencode) through scripted scenarios and captures transcripts. Key files: `src/core/claw-test/agent-runner.ts` (222 lines; `AgentRunner` contract: find the binary, invoke with a prompt), `src/core/claw-test/transcript-capture.ts` (209), `src/core/claw-test/scenarios.ts` (205), `src/core/claw-test/runners/opencode.ts` (162), `src/core/claw-test/runners/grok.ts` (155; x.ai API), `src/core/claw-test/runners/hermes.ts` (76), `src/core/claw-test/runners/openclaw.ts` (57), `src/core/claw-test/seed-pglite.ts` (151; seeds a PGLite brain for tests), `src/core/claw-test/progress-tail.ts` (58). Depends on the engine through the seed script and on the external agent binaries. External services: x.ai (Grok) and opencode.ai endpoints via the external binaries. Postgres: 6 SQL hits; `seed-pglite.ts` is PGLite-specific.
Size: 9 files, 1,295 lines.
Rust port notes: Replace the PGLite seed with the embedded store's seed. The runner interface is a good fit for Rust traits. Keep transcript formats, since the scenario checks read them.

### harness

Capability advertisement and installation for agent clients (tokens, shared skills, native router, OAuth setup). Key files: `src/core/harness/capabilities.ts` (414 lines; what a harness may do, using grant TTL bounds and grant prefixes from `grants/model.ts`), `src/core/harness/install.ts` (278; install flow), `src/core/harness/verify.ts` (217), `src/core/harness/credentials.ts` (128), `src/core/harness/native-router.ts` (126), `src/core/harness/oauth-setup.ts` (103; OAuth setup for a client), `src/core/harness/registry.ts` (78), `src/core/harness/client-setup.ts` (72), `src/core/harness/shared-skills.ts` (68). Depends on `grants/`, `scope.ts`, `mcp-registration.ts`, `shared-skills/`, and the engine. External services: OAuth flows for clients (provider unverified). Postgres: 10 SQL hits; one row-lock use.
Size: 12 files, 1,606 lines.
Rust port notes: The TTL bounds (`TOKEN_TTL_MIN_SECONDS`, `TOKEN_TTL_MAX_SECONDS`) and grant prefixes are contract values; keep them. OAuth callback handling needs the same loopback behavior as `creds/redirect.ts`.

### audit

Shared JSONL audit writer and per-subsystem audit records (weekly files). Key files: `src/core/audit/audit-writer.ts` (254 lines; one primitive for ISO-week JSONL files, replacing five hand-rolled audit modules), `src/core/audit/lock-renewal-audit.ts` (308), `src/core/audit/batch-retry-audit.ts` (233), `src/core/audit/content-sanity-audit.ts` (217), `src/core/audit/pool-recovery-audit.ts` (167; connection pool recovery), `src/core/audit/db-disconnect-audit.ts` (158; database disconnect), `src/core/audit/redact-connection-info.ts` (100; redacts connection strings), `src/core/audit/self-upgrade-audit.ts` (78). Depends on the engine only lightly (2 SQL hits). External services: none. Postgres: pool and disconnect audits describe Postgres connection behavior.
Size: 8 files, 1,515 lines.
Rust port notes: Keep the JSONL line format and the ISO-week file naming. The pool and disconnect audits describe Postgres behavior and need a different event set for an embedded store. Keep the connection-info redaction rule for any path or DSN that is still logged.

### Parity risks

- Trust stamp and guard triggers read transaction-local settings (`gbrain.write_trust_tier`, `gbrain.write_origin`, backfill and keep flags). Every writer, including backfill and bypass paths, must pass the same context to the Rust write path, or tier stamps will diverge.
- Refusals that exist only because of Postgres RLS (`permission_denied` for unreadable folder access or guest tables) will not arise in an embedded store. Black-box tests that expect those error codes or texts will differ.
- `readers` normalization must match the SQL function `gbrain_access_readers()` byte for byte; the repo's test holds them equal.
- The daily budget ledger is shared across processes. Reservation and settle must stay atomic across processes, or the daily cap can be exceeded.
- Host config writers (Claude Code, Codex, OpenClaw, Pi, Hermes, opencode) rely on hashes and connection receipts. Changed bytes or key order break ownership checks and uninstall.
- The `skills` resolver output is documented as byte-identical for the same index, input, and session state; any change to ranking or rendering fails that golden contract.

### Open questions for Garry

- Keep the role-based access model (RLS-hidden tables, unreadable-state refusals, guest sources, folder rules) in the embedded port, or treat the single embedded process as fully trusted and drop the role layer? This decides most of `access/`, `guests/`, and `shared-skills/`.
- Is `shared-skills` (about 157 SQL hits, 10 tables, about 5 plpgsql guards) in scope for v1, or deferred?
- Does the warm CLI socket (`cli-socket/`, Postgres-only) survive in Rust, given that the embedded store is in-process?
- Should `agent-install/` and `claw-test/seed-pglite.ts` be rewritten against the embedded store, or retired with PGLite?
- Which host integrations ship in v1 (Claude Code, Codex, OpenClaw, Pi, Hermes, opencode, grok)? `bootstrap/` (12,951 lines) and `setup/` (6,269 lines) scale with that choice.

## Top-level src/core files (a-e)

Scope: the 180 files matching `src/core/[a-e]*.ts` at commit 8bbfd0b5e8. Line counts below are from `wc -l`. Files are grouped by purpose, not by prefix, because several prefixes (`embed-`, `embedding-`, `engine-`, `backfill-`) span more than one job. Paths are relative to `src/core/`. Only `engine.ts` is mapped in detail here; the BrainEngine interface and schema belong to the other session.

### Engine construction and selection (foundational)

`engine-factory.ts` (31 lines) exports `createEngine(config)`, which calls `constructEngine` in `engine-construct.ts`. That switch picks `pglite` (dynamic import of `pglite-engine.ts`) or `postgres` (default, `postgres-engine.ts`). Any other value throws, and `sqlite` gets an explicit "not supported" message. The factory also registers a chat-usage sink and wraps `disconnect` so the sink is removed on close. `engine-open.ts` (200 lines, experimental `gbrain/engine-open`) builds an engine from a settings object (`EngineSettings`: storage `{backend: 'local' | 's3', ...}`, `ai.providers`, `ai.models`, pool max defaulting to 4). It validates every field and never reads env, config or home dir. `embedded-engine.ts` (200 lines) defines that settings view and the per-engine AI gateway. `engine-key.ts`, `engine-root.ts` (the `ENGINE_ROOT` symbol) and `engine-scope.ts` / `engine-scope-store.ts` give each engine a stable cache key, so a process with several mounted brains keeps separate settings and buffers. `engine-constants.ts` holds batch sizes (`DELETE_BATCH_SIZE`, `TRAVERSE_PATH_ROW_CAP`). `engine-errors.ts` defines `PageMissingError`. `degraded-engine.ts` (252 lines) is the stand-in `gbrain serve` uses when Postgres is down at startup; it retries once per tool call. `engine.ts` (2,890 lines) is the BrainEngine implementation base and is the largest file in this set. Postgres features: `statement_timeout` (engine-open.ts, embedded-engine.ts), `CREATE INDEX CONCURRENTLY` and `pg_advisory` text (engine.ts:232-234), `ts_rank` full-text ranking (engine.ts:379). Natural owner: the core engine layer, not minions. Rust port notes: the pglite/postgres switch collapses to one embedded engine. The settings-based open API and the per-engine keying are the parts to decide on. Keep the "fail closed, name the bad setting, never echo a key" validation style.

### Database connections, locks and pacing (foundational)

`db.ts` (677 lines) is the Postgres connection layer. It imports `postgres` (postgres.js) through the `#postgres` alias and holds a module-level singleton. It applies TLS via `pg-tls.ts`, bootstraps the schema from `SCHEMA_SQL` (`schema-embedded.generated.ts`) and checks it with `verifySchema`. It also bounds pool teardown (`endPoolBounded`, `POOL_END_TIMEOUT_SECONDS`) and sets `statement_timeout` and `idle_in_transaction_session_timeout`. `connection-manager.ts` (570 lines) routes queries across three pools: `read()` goes through the pooler (port 6543), while `ddl()` and `bulk()` go direct (port 5432, 30-minute `statement_timeout`, at most 3 connections). `connect-probe.ts` classifies connection failures, and `connection-audit.ts` writes a JSONL connection log. `db-lock.ts` (1,131 lines) is the generic lock primitive. It uses one row per lock id in `gbrain_cycle_locks` (`id` PK, `holder_pid`, `ttl_expires_at`), with steal grace and `ON CONFLICT (id) DO UPDATE`. Its header says it avoids session-scoped `pg_try_advisory_lock` because PgBouncer transaction pooling drops session state. `db-pacer.ts` (exports `DbPacer`; internals unverified), `direct-pool-profile.ts` decides which serve args skip resident duties, `batch-rows.ts` (229 lines) does `jsonb_to_recordset` bulk upserts and strips NUL bytes for jsonb, and `analyze-lock.ts` runs `ANALYZE` with `NOWAIT` and defers on SQLSTATE `lock_not_available`. `attendance-repair.ts` uses `SET LOCAL lock_timeout`. `docker-postgres.ts` manages gbrain's own pgvector container through the `docker` CLI. Natural owner: the Postgres/infra layer, shared by all subsystems. Rust port notes: the row-lock-with-TTL design is portable as a file or table lock. PgBouncer and pooler-port concerns disappear. Keep the TTL semantics and the steal-after-grace behavior.

### Config and environment (foundational)

`config.ts` (2,033 lines) is the largest config file. It defines `GBrainConfig`, `loadConfig`, `loadConfigWithEngine`, `saveConfig`, `KNOWN_CONFIG_KEYS` (a long list plus `KNOWN_CONFIG_KEY_PREFIXES`), `getDbUrlSource`, `isThinClient` and the `~/.gbrain` path helpers (`configDir`, `gbrainPath`). It also reads `.env` files via `env-trust.ts`, which decides which CWD dotenv files may be trusted. `config-db-merge.ts` (331 lines) merges DB-plane values into the file config: provider credentials, model pins, the chat fallback chain and flat `cycle.*` knobs. `config-snapshot.ts` provides `ConfigReader` and `BulkConfigReader` snapshots. `config-runtime-keys.ts` lists keys read at runtime. `env-number.ts` parses numeric env vars with warn-once. `entity-references-config.ts` holds the entity-reference keys. Config values also live as key/value rows in a DB table (`backfill-skips.ts` writes `backfill.<name>.skipped`, and `backfill-effective-date.ts` uses `ON CONFLICT (key) DO UPDATE`). Natural owner: the config/platform layer. Rust port notes: config file location, key names and precedence (file vs DB vs env) are user-visible. Keep the `KNOWN_CONFIG_KEYS` list as the contract and expect to port the DB-plane merge as a read path.

### Embedding core and vector state (foundational)

`embedding.ts` (245 lines) is a thin facade over `ai/gateway.ts`. It exports `embed`, `embedQuery`, `embedBatch` and the multimodal variants, and it takes its dimensions and model name from the gateway. `embedding-input-hash.ts` builds the document hash used for staleness, `embedding-context.ts` wraps chunks with the contextual prefix, and `embedding-input-limit.ts` gives the per-model token cap. `embedding-state.ts` (255 lines) defines the embedding state enum, `UNSEARCHABLE_STATES` and the purge window for deleted pages. `embedding-readiness.ts` lists pending projections. `embedding-invalidation.ts` (312 lines) locks sources and invalidates embeddings whose signature no longer matches. `embedding-dim-check.ts` (796 lines) compares the stored `vector(N)` column with the configured dimensions, sets `PGVECTOR_COLUMN_MAX_DIMS`, and raises `EmbeddingDisabledError`. `embedding-restamp.ts` restamps a page's signature when its vectors already match the current model. `embedding-ann-build.ts` (134 lines) defers HNSW index creation until after a bulk re-embed. `embedding-pricing.ts` (152 lines) is a static per-1M-token price table for embedding models. Postgres features: `vector(N)` columns and `::vector` casts (embedding-readiness.ts:13, embedding-dim-check.ts:5), HNSW indexes (embedding-ann-build.ts:21-28), `pg_attribute` / `pg_class` / `pg_namespace` introspection (embed-takes.ts:51-53). Natural owner: the AI/embedding subsystem, with the gateway. Rust port notes: the dimension contract, signature format and text-hash semantics must match exactly, or existing brains will be marked stale. The ANN index is an implementation detail to choose in Rust.

### Embedding migration (`gbrain migrate embeddings`)

`embedding-migration.ts` (1,586 lines) runs `runSchemaTransition`. It rebuilds the `content_chunks.embedding` column and its dependent indexes, found through `pg_depend` and `pg_get_indexdef` (embedding-migration.ts:87-90). It also detects env overrides (`EnvOverrideWarning`). `embedding-migration-cli.ts` parses the flags (`MigrateEmbeddingsFlags`). `embedding-migration-budget.ts` takes a leased transaction (`FOR UPDATE` on migration state) and refuses a run whose cost is below the worst case (`EMBEDDING_BUDGET_BELOW_WORST_CASE`). `embedding-migration-worst-case.ts` sends probe texts to price the worst case. `embedding-migration-retention.ts` asserts that the retained rows can still be rebuilt, and it treats deadlock as retryable. Natural owner: the CLI and schema-lifecycle layer. External: embedding provider APIs (for cost probes and the re-embed). Rust port notes: almost all of this is Postgres DDL. The embedded store needs an equivalent full-reindex path. The budget refusal and the printed cost are parity-visible, so keep the messages and the exit path.

### Embed backfill and stale-chunk pipeline (minions-owned)

There are about 35 `embed-*` files, about 8,400 lines in total. The core is `embed-stale.ts` (688 lines), a cursor-paginated, source-grouped, rate-limit-aware loop shared by `gbrain embed --stale` and the `embed-backfill` minion handler. `embed-backfill-submit.ts` (295 lines) is the single submission entry point for that job. It imports `minions/queue.ts`, sums token usage from `minion_jobs`, and applies a cooldown and spend cap (`COOLDOWN_CONFIG_KEY`, `SPEND_CAP_CONFIG_KEY`). Its natural home is the minions subsystem. The rest of the group: `embed-backfill-lock.ts` (row lock id), `embed-backfill-stall.ts` (blocker paging), `embed-stall.ts` (abort after a no-response window), `embed-retry.ts` (332 lines, rate-limit retry honoring retry-after), `embed-overlength-classify.ts` / `embed-overlength-heal.ts` / `embed-oversize-heal.ts` (chunks over the input limit are split and restaled), `embed-reuse.ts` (reuses a vector when the markdown is unchanged), `embed-skip.ts` (skip marker), `embed-facts.ts` (fact embeddings), `embed-takes.ts` (take embeddings; the only file here that imports from `commands/`), `embed-stale-images.ts` (multimodal image vectors, uses `git`), `embed-budget-stop.ts` / `embed-cost-cap.ts` (spend stops), `embed-consent.ts` (consent gate for paid embedding), and `embed-preflight.ts` (credential validation). Postgres: pgvector writes, `minion_jobs` reads, keyset pagination. External: embedding provider HTTPS APIs through the gateway. Rust port notes: the job, cooldown and cost-cap config keys are user-visible. Implement as minions handlers and keep the stall and retry timing values.

### Autopilot daemon and commit-to-sync coordination

`autopilot-lock.ts` (105 lines) is a pid lock file. `isPidAlive` and a `/proc/<pid>/cmdline` probe detect a stale holder. `autopilot-heartbeat.ts` (74 lines) writes a JSON sidecar, and `daemonStaleAfterSeconds` grades staleness from it (#7003). The lock file mtime is the liveness signal. `autopilot-paths.ts` (391 lines) is a leaf module that holds every state path: lock, heartbeat, disabled and paused markers, install id, and the launchd label `com.gbrain.autopilot` and systemd unit `gbrain-autopilot.service`. `commit-notifier.ts` (608 lines) turns a git commit into a sync. It uses one owner per host and brain, held in `sync_notifier_leases` on Postgres with a fencing token. Residents are `serve`, `jobs work` and the autopilot daemon. `background-work.ts` (245 lines) defers work until the response is sent, and `backoff.ts` (205 lines) provides throttle and capacity waits. `cli-force-exit.ts` (1,056 lines) decides when a CLI may force-exit and sets drain deadlines. Natural owner: the autopilot/daemon subsystem, which sits with minions and the background-job runner. Rust port notes: the lock and heartbeat file formats are read by `autopilot --status`, so keep them. The launchd and systemd installs and the `/proc` probe are OS-specific.

### Maintenance cycle and extraction pipelines

`cycle.ts` (3,350 lines) is the orchestrator for `gbrain dream`, `gbrain autopilot`, and the minions `autopilot-cycle` handler. `ALL_PHASES` (cycle.ts:130) fixes the phase order. It starts with `lint`, `backlinks`, `sync`, `fence_repair`, `content_repair`, `unindexed_files`, `synthesize`, `extract`, `extract_facts` and `extract_atoms`, then `resolve_symbol_edges`. `SOURCE_PHASES`, `MIXED_PHASES` and `GLOBAL_PHASES` are derived from `PHASE_SCOPE`. The cycle lock is a `gbrain_cycle_locks` row with a 30-minute TTL. On PGLite or with no engine it uses a file lock at `~/.gbrain/cycle.lock`. Extraction files: `extract-ner.ts` (221 lines), `extract-takes-from-pages.ts` (464 lines, LLM chat through `ai/gateway.ts`), `extract-timeline-from-meetings.ts` (493 lines), `extract-frontmatter.ts`, `extract-watermark.ts`, and `extraction-watermark.ts` (251 lines, a per-page, per-pipeline byte-offset watermark stored with `ON CONFLICT (page_id, pipeline) DO UPDATE`). `extraction-lag.ts`, `extraction-review.ts` and `content-drift-sweep.ts` (218 lines, `FOR UPDATE`) cover lag warnings, review status and drift sweeps. `event-dates.ts` is a regex date extractor. Natural owner: minions/autopilot, since the cycle is the autopilot job, with extraction as a cycle phase. Rust port notes: the phase order is a contract (a test asserts `report.phases` equals `ALL_PHASES`). Keep the lock TTL semantics. Some extract phases (`extract-takes-from-pages.ts`) call an LLM, so they need the same provider gate.

### Backfill framework

`backfill-base.ts` (498 lines) is the generic keyset-plus-checkpoint runner with adaptive batches. It raises `BackfillRollbackError` and `BackfillCommitIndeterminateError`, uses `SET LOCAL` for timeouts, and checks `pg_indexes`. `backfill-registry.ts` (240 lines) registers `effective_date` and `emotional_weight`; the latter creates an index with `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_emotional_weight_pending`. `backfill-effective-date.ts` (289 lines) fills `effective_date` and its source from frontmatter. `backfill-skips.ts` (100 lines) records rows that failed item-scoped writes in config key `backfill.<name>.skipped` (`BACKFILL_HOLD_RUNS`). `effective-date.ts` (312 lines) computes the date and handles naive datetimes. Natural owner: the data-maintenance and CLI layer (`gbrain backfill`). It is not a minions job here. Rust port notes: the checkpoint and skip-ledger protocol is portable. `CONCURRENTLY`, `SET LOCAL` and `pg_indexes` have no direct embedded equivalent.

### Brain repository, registry and writes

`brain-registry.ts` (447 lines) is the `BrainRegistry` of engine handles. The `host` brain comes from `~/.gbrain/config.json`, and mounted brains come from `~/.gbrain/mounts.json`. `brain-resolver.ts` (159 lines) implements the six-tier resolution for `--brain`, modeled on the source resolver. `brain-writer.ts` (1,028 lines) validates, audits and auto-fixes frontmatter using `parseMarkdown(..., {validate: true})` and `isSyncable`. `brain-repo-durability.ts` (1,335 lines) hardens a brain's git working tree. It runs `git` through `execFileSync` (about 12 call sites), schedules via `crontab` or `launchctl`, and uses a PAT with a GitHub remote (`x-access-token`). It is the largest external-touch file in the set. Smaller helpers: `disk-walk.ts` (`walkBrainRepo`), `atomic-write.ts` (staging path and private mkdir), `capture-content.ts` (slug prefixes, binary detection), `cjk.ts` (slug character ranges), `classic-file-holds.ts` and `classic-rename-holds.ts` (git-based holds), `checkout-head.ts`, and `by-mention.ts` (1,093 lines, the entity gazetteer for auto-linking). Natural owner: the brain file plane. Rust port notes: git semantics must match. Cron and launchd installs are shell-outs and may be dropped or redone. `atomic-write` semantics matter for the markdown contract.

### Doctor, capability checks and upgrade

`doctor-categories.ts` (632 lines) puts every doctor check name into one of four categories (brain, skill, ops and remote). It imports `minions` for the ops checks. `doctor-cause-rank.ts` (163 lines) ranks root causes ahead of symptoms. `doctor-remote.ts` (602 lines) and `doctor-remote-tier.ts` (117 lines) run thin-client HTTP probes. `dry-fix.ts` (579 lines) implements `gbrain doctor --fix` for DRY violations. `check-resolvable.ts` (732 lines) checks skill-manifest resolvability. `brain-score-recommendations.ts` (474 lines) maps hosted-provider env names to config fields. `capability.ts` (165 lines) detects touchpoints. `bun-floor.ts` (194 lines) checks the Bun floor of an upgrade target, using `execFileSync` on `bun` and `git`. `binary-self-update.ts` (442 lines) swaps a compiled binary atomically and verifies a GitHub artifact attestation (`api.github.com/repos/garrytan/gbrain/attestations`, builder ID check). `behavior-change-notice.ts` (1,774 lines) prints upgrade notices and `behavior-changes.generated.ts` is generated from `behavior-changes.d/` and CHANGELOG markers. Natural owner: the doctor and upgrade CLI, cross-cutting. Postgres checks cover pgvector, HNSW and jsonb integrity (doctor-categories.ts:14, 210, 463). Rust port notes: the check names are a stable contract. Self-update must use the Rust release channel, not the Bun path.

### Audit logs, errors and the agent contract

`audit-*.ts` holds JSONL audit writers. They use `audit-week-file.ts` (weekly file naming, `GBRAIN_AUDIT_DIR` override) and bounded reads. These include `audit-quality-probe.ts` (216 lines), `audit-skill-brain-first.ts` (312 lines), and `audit-synopsis.ts` (206 lines). `agent-contract-log.ts` writes `appendBoundedJsonl` events. `agent-output.ts` (956 lines) defines `CONTRACT_VERSION` and the Effect, Actor and Next envelope that agents read. `agent-markers.ts` defines `AGENT_FIELDS` and `renderCliNotices`. `error-registry.ts` (1,146 lines) holds `CODES` and notice entries. `error-catalogue.ts` (254 lines) holds `ERROR_CATALOGUE` and `WIRE_CODES`. `error-docs.ts` renders error docs. `errors.ts` defines `StructuredError` and `buildError`. `exit-codes.ts` (112 lines) fixes the exit codes (`OK`, `FAILED`, `USAGE`, `CONFIRMATION_REQUIRED`). Natural owner: the agent contract, cross-cutting. Rust port notes: this is the protocol that must match: exit codes, error codes, the envelope and the JSON shape. Parity tests will catch drift here first.

### CLI plumbing and flags

`cli-flag-registry.generated.ts` (246 lines) is generated by `scripts/generate-flag-registry.ts`. `cli-options.ts` (585 lines) defines `CliOptions`, `DEFAULT_CLI_OPTIONS`, and `TIMEOUT_OWNING_COMMANDS`. `cli-preflight.ts` (596 lines) handles CWD env quarantine and the script-mode bunfig warning, and imports minions. `console-prefix.ts` (247 lines) redirects human logs to stderr. `bounded-listing-cli.ts` parses `--limit` and cursor flags. `cli-util.ts` and `confirm-prompt.ts` are tiny helpers. Natural owner: the CLI shell. Rust port notes: flag names, stdout and stderr discipline, and exit codes are the contract. Clap can express the flags, but the registry should be kept as the source of truth.

### Consent, egress and destructive operations

`consent.ts` (508 lines) provides `requireConsent()`. It returns an `Authorization` or throws `confirmation_required` (exit 3). Core library paths take an `Authorization` and never prompt. `consent-cli.ts`, `consent-preapproval.ts` (persisted preapprovals, `PREAPPROVE_PAID_MAX_USD_PER_RUN`) and `execution-env.ts` (detects credential-injecting proxies) belong here. `egress-budget.ts` (103 lines) caps each MCP response frame and returns `result_too_large` above the cap. `destructive-guard.ts` (626 lines) shows an impact preview and checks `information_schema.tables` with a `statement_timeout`. It also sets `SOFT_DELETE_TTL_HOURS`. `deletion-inventory.ts` (244 lines) classifies every deletion. Natural owner: cross-cutting agent contract. Rust port notes: the consent and exit-3 contract is agent-facing and must stay.

### Export, knowledge features and enrichment

`export-snapshot.ts` (142 lines) reads withdrawals and pages, using `jsonb_build_object` and `jsonb_agg`. `export-stage.ts` (175 lines) streams segmented pages with a snapshot budget of 1 MiB/s. `export-publish.ts` is a small `publishExport`. `contextual-retrieval-service.ts` (973 lines) re-embeds one page in contextual-retrieval mode. It is called by sync, reindex and the CLI, and calls gateway `chat` and `embedBatch`. `contextual-retrieval-resolver.ts` resolves the mode. `core-memory.ts` (383 lines) renders always-loaded pages into prompts. `core-memory-schema.ts` creates `core_edit_notices` and checks `pg_has_role`. `context-engine.ts` (1,475 lines) injects time, place and thread context for OpenClaw. `enrichment-service.ts` (659 lines) manages entity pages through gateway availability checks. `entity-identity.ts` (376 lines) links identities with `ON CONFLICT (source_id, page_id)`. `eval-capture.ts` and `eval-capture-scrub.ts` capture queries with PII scrubbing. `deep-research-id.ts` encodes anchors. Natural owner: knowledge and ingest. Some parts call an LLM through the gateway.

### Small utilities

`abort-check.ts`, `abort-signals.ts` and `anySignal` provide abort plumbing. `bounded-child-exec.ts` (`execFileBounded`) bounds child processes and calls `ps`. `bounded-listing.ts` provides paging limits. `backoff.ts` provides capacity waits. `env-number.ts` and `env-trust.ts` parse env vars. `anthropic-pricing.ts` (70 lines) is the chat price table. `archive-crawler-config.ts` (350 lines) refuses scans without an explicit `scan_paths` in `gbrain.yml`. `atomic-write.ts` writes files atomically. Natural owner: shared infra. Rust port notes: these map to std and small crates. Keep the atomic-write and bounded-exec semantics.

### Parity risks

- Engine selection and the pglite vs postgres split in `engine-construct.ts` and `engine-open.ts` need an explicit Rust decision. A black-box test could see different error text.
- Row-lock semantics in `db-lock.ts` and `cycle.ts` (TTL, steal grace, lock ids `gbrain-cycle` and `gbrain-sync`) must behave the same across processes.
- `embedding-dim-check.ts`, `embedding-invalidation.ts` and `embedding-restamp.ts` define when stored vectors are stale. A different hash or signature means every brain gets re-embedded.
- `embed-retry.ts` and `embed-stall.ts` timing and the cost-cap messages are user-visible.
- `agent-output.ts`, `error-registry.ts`, `exit-codes.ts` and `consent.ts` define the JSON envelope and exit codes. These are the first things parity tests will check.
- `brain-repo-durability.ts` git and cron behavior, and `atomic-write.ts`, must match on real brain repos.

### Open questions for Garry

- Does the Rust port keep the `pglite`/`postgres` engine switch and the settings-based `openEngine` API, or does it expose one embedded engine only?
- Is the minions `embed-backfill` job and cost cap kept as a job with the same config keys, or redesigned for embedded storage?
- Should `gbrain_cycle_locks` become a file or embedded-table lock, and is the 30-minute TTL kept?
- Are the launchd and systemd installers and the `brain-repo-durability` cron/launchd schedulers in scope for the Rust binary?
- Should the config DB-plane merge (`config-db-merge.ts`) be kept, or do provider keys move to the file only?

## Top-level src/core files (f-r)

Scope: the 198 files in `src/core/` whose names start with f through r (`src/core/[f-r]*.ts`), read at origin/master 8bbfd0b5e8. Line counts are from `wc -l`. The biggest files are `postgres-engine.ts` (3182 lines), `pglite-engine.ts` (3088), `operation-manifest.generated.ts` (8043), `import-file.ts` (2091), `link-extraction.ts` (2462), `github-source.ts` (1521), and `markdown.ts` (1501). Most of the rest are small (under 300 lines). Three of the files are generated (`operation-loaders.generated.ts`, `operation-manifest.generated.ts`, `pglite-schema.generated.ts`). Most `src/core` business logic lives in subdirectories (`ops/`, `persistence/`, `search/`, `schema-migrations/`); this section covers only the top-level files.

### Foundational files

**`operations.ts` (250 lines)** is the contract-first operation registry. It exports `operations: Operation[]`, built by spreading 53 per-module arrays (`verbOperations`, `pagesOperations`, `searchOperations`, `linksOperations`, `jobsOperations`, and so on, defined under `src/core/ops/`), plus a few inline entries such as `volunteer_context`, `find_contradictions`, `find_experts`, and `find_trajectory`. It then calls `finalizeOperation(op)` on each entry (from `operation-load.ts`), exports `operationsByName`, and calls `registerOpRoutes` (from `fix-routing.ts`). The generated manifest `operation-manifest.generated.ts` contains 204 operation entries (one `"name"` field each). `bun run build:operation-manifest` produces it from `scripts/build-operation-manifest.ts`, and `test/operation-manifest.test.ts` pins its freshness. The count of 204 comes from the generated file. I could not confirm it at runtime because `bun` import of `operations.ts` failed on a missing `detect-libc` package in this checkout's `node_modules`. The CLI and MCP surfaces read from this one registry, so the operation count and each entry's schema are a single contract.

**`operation-load.ts` (146 lines)** holds the `OP_AREAS` map (a central name-to-area taxonomy used by the request_tools catalog and generated docs). `finalizeOperation` wraps each op with `withOutputRedaction` (from `search/output-redaction.ts`), `withEngineScope` (from `engine-scope.ts`), and `withGuestMarks` (from `guests/marker.ts`). `loadOperation()` lets the CLI import only the module that defines one op. It uses `OPERATION_LOADERS` from `operation-loaders.generated.ts`, which holds 54 `load_*` functions that are string-literal dynamic `import()`s. This keeps cold-start small, and `bun --compile` can still embed every module.

**`import-file.ts` (2091 lines)** is the largest ingestion file. It exports `importFromContent`, `importFromFile`, `importCodeFile`, `importFile`, `importImageFile`, and `withImportTransaction`, and it is the write path for markdown, code, and image files. See the import cluster below.

**`markdown.ts` (1501 lines)** exports `parseMarkdown`, `parseMarkdownHead`, `classifyImportHold`, `contentSizeHold`, and `yamlAliases`, plus the hold and validation code tables (`HOLD_CODES`, `ParseValidationCode`). It re-exports `recoverFrontmatter` from `frontmatter-recovery.ts` and imports slug helpers from `sync.ts`, which is outside this slice.

**`link-extraction.ts` (2462 lines)** is documented as pure: no DB access. It returns candidates that callers persist through the engine's `LinkBatchInput`. Its callers are `commands/extract.ts`, `commands/backlinks.ts`, and the `put_page` auto-link hook in `operations.ts`. Its main exports are `extractPageLinks`, `extractBodyLinks`, `frontmatterLinks`, `extractMarkdownLinks`, `extractEntityRefs`, `extractCodeRefs`, `inferLinkType`, `traceLinkType`, and `LINK_EXTRACTOR_VERSION_TS`.

**`migrate.ts` (618 lines)** runs schema migrations. It exports `runMigrations`, `tryRunPendingMigrations`, `runMigrationSQL`, `getIdleBlockers`, `isDeadlockError`, `MigrationDriftError`, and `MigrationRetryExhausted`. `LATEST_VERSION` and `registeredLatestVersion()` read from `schema-migrations/registry.generated.ts`. That directory is outside this slice and holds about 313 migration modules.

**`pglite-engine.ts` (3088 lines)** defines `class PGLiteEngine`, built on `@electric-sql/pglite` (`PGlite` and `Transaction`). It also holds snapshot load and hashing (`tryLoadSnapshot`, `computeSnapshotSchemaHash`), WAL-repair messaging, init-error classification, and `probePgliteScratchStore`, which creates a `scratch_probe` table.

**`postgres-engine.ts` (3182 lines)** defines `class PostgresEngine` on the `postgres` driver, imported as `#postgres`. That import maps to `vendor/postgres/` in `package.json`. It also exports `getPostgresSchema`, `cancelSettleMs`, and `DEFAULT_CANCEL_SETTLE_MS`.

### Clusters

**1. Operation contract and generated registry.** Files: `operations.ts`, `operation-load.ts`, `operation-loaders.generated.ts` (54 loaders), `operation-manifest.generated.ts` (204 entries), `operations-descriptions.ts` (constant description strings), `op-flag-tokens.ts`, `op-checkpoint.ts` (checkpointed multi-step ops). Dependencies: `ops/*.ts` (about 77 files) and `ops/contract.ts` for the `Operation` type. External services: none. Postgres features: none directly. Rust port notes: the manifest is the natural source for generated CLI and MCP schemas. Generate Rust descriptors from the same 204-entry data (or a serialized copy) instead of hand-writing them, so the `callShape` and `params` fields stay in parity.

**2. Import pipeline.** Files: `import-file.ts` (2091 lines), `import-checkpoint.ts`, `import-chunk-reuse.ts`, `import-contextual-mode.ts`, `import-identity.ts` (`decideImportIdentity`, `collidingSlugOwner`), `import-screen.ts` (`screenImportContent`, `MAX_FILE_SIZE`), `item-failure.ts`, `raw-file-upload.ts`, `image-asset-resolver.ts`, `page-size-policy.ts`, `file-resolver.ts`, `resolver-filenames.ts`. It depends on `persistence/*`, `belief/*`, `page-state/import-guard.ts`, `fence-repair/*`, `markdown-chunks.ts`, and `code-chunks.ts`. Embeddings go through `embedBatchKeepingUsable`, `embedBatchWithBackoff`, and `embedMultimodal`, and zero-norm vectors are guarded by `ai/embedding-guard.ts`. External services: embedding providers (through the AI gateway) and OCR for images (unverified). Postgres features: transaction-scoped writes via `withImportTransaction`, and pgvector references (`import-file.ts` matches `hnsw`/`pgvector`/`::vector` in its code; the exact statements are in the engine files). Rust port notes: this is the largest behavioral surface. Keep the same write order (identity decision, then fences, chunks, embeddings, then commit) and the same per-item failure reporting. The checkpoint files are needed for resumable imports.

**3. Markdown, frontmatter, and fences.** Files: `markdown.ts`, `markdown-chunks.ts` (fence-aware chunking), `markdown-code.ts` (`stripCodeBlocks`), `frontmatter-recovery.ts` (`recoverFrontmatter`, `RECOVERY_VERSION`), `frontmatter-inference.ts`, `fence-scan.ts` (`findLineOutsideFencedCode`), `fence-shared.ts`, `facts-fence.ts` (1043 lines), `fact-keys.ts`, `line-grammar.ts` (536 lines), `line-grammar-config.ts`, `line-grammar-report.ts`, `machine-sections.ts`, `managed-block.ts`, `links-fence.ts` (`maskLinksFence`), `links-fence-projection.ts`. Dependencies: `data-frontmatter.ts` (YAML loading with alias bounds, outside this slice), `sync.ts` (slug helpers), `tag-limit.ts`. External services: none. Postgres features: none. Rust port notes: the YAML alias bounds, frontmatter recovery, and fence rules define what counts as valid markdown. Port them as one tested module with the same outputs, and check them against the TypeScript fixtures.

**4. Link graph.** Files: `link-extraction.ts`, `link-validity.ts` (590 lines), `link-reconciliation.ts` (457 lines; source policy, #4680), `link-relationships.ts`, `link-relationship-notes.ts`, `link-typing-units.ts`, `link-target-roles.ts`, `link-single-value.ts`, `link-ranking-policy.ts`, `link-effective.ts`, `link-semantics-pack.ts`, `link-source-check-repair.ts`, `link-extraction-watermark.ts`, `link-temporal-schema.ts`, `link-temporal-apply.ts`, `link-temporal-evidence.ts` (358 lines). Dependencies: `engine.ts` (`BrainEngine`, `LinkBatchInput`), `line-grammar.ts`, `timeline-citations.ts`, `source-id.ts`, `machine-sections.ts`. External services: none. Postgres features: temporal link schema and writes are stored in the engine's tables (the exact table DDL lives in the schema files, outside this slice). Rust port notes: extraction is pure, so it can be ported and fixture-tested first. Keep the type-inference tables (`inferLinkType`, role priors) identical, because they change which edges get stored.

**5. Schema migrations.** Files: `migrate.ts`, `migrate-pending.ts` (records the config `version` on the engine), `migration-ledger.ts`, `migration-orchestration-lock.ts` (single runner for `gbrain apply-migrations`, #5693), `migration-preludes.ts`, `migration-timeout.ts`, `migration-timeout-advice.ts`, `owned-table-shapes.ts`, `pglite-schema.ts`, `pglite-schema.generated.ts` (3030 lines, from `bun run build:schema`). Dependencies: `schema-migrations/` (about 313 modules), `schema-migrations/helpers.ts`, `schema-migrations/registry.generated.ts`. External services: none. Postgres features: `pg_advisory_lock(42)` (the comment in `migrate.ts` around line 270 describes the lock and its deadlock risk), `pg_stat_activity` and `pg_locks` for idle-blocker detection, `statement_timeout`, `CREATE EXTENSION`, and `tsvector` and `pgvector` DDL in the generated PGLite schema. Rust port notes: the migration ledger and drift detection (`MigrationDriftError`) are the contract. The advisory-lock semantics have no direct embedded equivalent, so use a file lock with the same single-runner behavior.

**6. PGLite embedded engine.** Files: `pglite-engine.ts` (3088 lines), `pglite-embedded-assets.ts`, `pglite-embedded-asset-paths.ts` (bundled extension assets), `pglite-statements.ts` (224 lines; `PgliteStatementCache`, `configurePgliteCodecs`, uses `SAVEPOINT`), `pglite-lifecycle.ts` (`trackPgliteDatabase`, `PgliteClosingError`), `pglite-lock.ts` (422 lines; kernel ownership of the datastore, error code `pglite_busy`), `pglite-legacy-lock.ts`, `pglite-leftovers-check.ts`, `pglite-repair.ts` (839 lines), `pglite-repair-consent.ts`, `pglite-resetwal.ts` (354 lines), `planner-stats.ts` and `planner-stats-schema.ts` (row-delta `ANALYZE`, since PGLite has no autovacuum). External services: none; the database is an in-process WASM Postgres on a local data directory. Postgres features: `CREATE EXTENSION` for pgvector, `tsvector` and `websearch_to_tsquery`, `pg_stat` and `pg_locks` for planner stats, `COPY` in `pglite-repair.ts`. Environment variables include `GBRAIN_PGLITE_WAL_REPAIR`, `GBRAIN_PGLITE_SNAPSHOT`, `GBRAIN_PGLITE_CLOSE_WATCHDOG_MS`. Rust port notes: much of this exists only because PGLite is a Postgres WASM build (WAL repair, `resetwal`, legacy lock migration, and snapshot hashing). Most of it should disappear in an embedded Rust store. The parts to keep are the single-owner lock contract and the clear `pglite_busy` error.

**7. Postgres engine and connection pools.** Files: `postgres-engine.ts` (3182 lines), `pg-access-classify.ts` (468 lines; classifies access and extension errors), `pg-tls.ts`, `pg-type-cache.ts` (`GBRAIN_PG_TYPE_CACHE`), `pool-budget.ts` (`tryAcquirePoolLongHold`, `PoolCapacityError`), `pool-gauge.ts` (checkout gauges and incident counters), `pool-end-timeout.ts`, `pooler-notice.ts`, `function-search-path.ts`, `init-schema-retry.ts` (bounded retry, default 2 s, #5227), `read-deadline.ts`. Dependencies: `postgres-engine/pool-stats.ts` (outside this slice), `search/vector-pool.ts`, `audit/pool-recovery-audit.ts`. External services: a Postgres server (`DATABASE_URL`, `GBRAIN_POOL_SIZE`), optionally behind a pooler. Postgres features: `statement_timeout` (12 files), `pg_stat_activity` (`pool-gauge.ts`), `pg_terminate_backend` / `pg_cancel_backend` references (`pg-access-classify.ts`, `retry-matcher.ts`, `migrate.ts`, `migration-timeout-advice.ts`), `CREATE EXTENSION`, `SET search_path` and function search paths, TLS settings. Rust port notes: the pool-budget and gauge logic applies to a Postgres-only backend. The embedded store only needs the same limits as a concurrency cap, so these files will mostly be dropped or reduced.

**8. Locks and concurrency primitives.** Files: `page-lock.ts` (182 lines; per-page file lock for markdown read-modify-write, v0.28), `owner-holder.ts`, `lease-schema.ts` (acquisition identity that survives PID reuse), `page-embedding-lease.ts`, `pages-upsert-arbiter.ts`, `page-snapshot-batch.ts`, `read-heartbeat.ts`, `fs-durable.ts`, `pglite-lock.ts`. Dependencies: `persistence/native-lock.ts` (stable OS locks, no TTL takeover; outside this slice), `detect-libc`. External services: none. Postgres features: `FOR UPDATE` in `page-spend.ts`, `page-embedding-budget.ts`, `oauth-grants.ts`, `heal-audit.ts`, and `line-grammar-config.ts`. Rust port notes: keep one lock model across the store, with OS-level locks and no TTL takeover. The per-page lock must cover the markdown file and the DB row together, so parallel `takes add` calls cannot corrupt a page.

**9. Git and GitHub source.** Files: `git-remote.ts` (598 lines; SSRF-defensive remote parsing, `RemoteUrlError`), `git-transport.ts` (`GIT_SSRF_FLAGS`, `buildGitEnv`), `hardened-git.ts` (344 lines), `git-env.ts`, `git-head.ts`, `git-checkout.ts`, `git-first-commit.ts`, `git-visible-files.ts`, `github-source.ts` (1521 lines; GitHub issues and PR sync for the opt-in `github` source kind, v0.46), `github-source-config.ts` (parses `sources.config`), `github-app-token.ts`, `repo-root.ts`, `repo-base.ts`, `repo-visibility.ts` (one visibility verdict for the workspace-push gate and bootstrap), `guarded-http.ts` (pinned HTTP fetch, bounded body reads), `path-confine.ts`. External services: `https://api.github.com`, `https://github.com`, and `https://raw.githubusercontent.com`. Environment variables include `GBRAIN_GIT_ALLOW_FILE_TRANSPORT`, `GBRAIN_ALLOW_PRIVATE_REMOTES`, and `GBRAIN_BASE_PATH_PREFIXES`. Postgres features: none. Rust port notes: the SSRF-hardened git flags and the pinned HTTP fetch are security-relevant. Port the flag set exactly, including the test-only file-transport gate.

**10. Remote MCP, thin client, and OAuth.** Files: `mcp-client.ts` (869 lines), `mcp-registration.ts`, `mcp-usage.ts`, `mcp-request-log-retention.ts` (`FOR UPDATE` and `SKIP LOCKED`), `oauth-provider.ts` (1237 lines; implements the MCP SDK `OAuthServerProvider`, backed by raw SQL on PGLite or Postgres, not the BrainEngine interface), `oauth-grants.ts` (388 lines; every grant mutation locks the same client row), `remote-mcp-probe.ts` (discovery, auth, and smoke probes for thin-client mode), `remote-mcp-error.ts`, `remote-token-cache.ts`, `remote-body.ts`, `request-signal.ts`, `legacy-token-scope.ts`. Dependencies: `@modelcontextprotocol/sdk` (client, server auth, provider, and types), `express`. External services: remote gbrain MCP servers over HTTP. Postgres features: `FOR UPDATE` row locks for grants, and `SKIP LOCKED` for the request-log retention sweep. Rust port notes: the OAuth provider reads and writes its own SQL tables, so port it against the new embedded store instead of as a BrainEngine client. Keep the MCP SDK wire shapes exactly.

**11. Models, embeddings, and spend.** Files: `model-config.ts` (687 lines), `model-id.ts`, `model-pricing.ts` (327 lines), `held-embedding.ts` and `held-embedding-action.ts` (approvable held embedding budgets), `page-embedding-budget.ts` (507 lines; `embed.max_usd_per_page` default $2, durable `page_embedding_budget` ledger, uses `ai/gateway.ts` budget tracker), `page-spend.ts`, `minion-spend.ts`, `init-embed-check.ts`, `post-upgrade-reembed.ts`, `llm-json.ts` (175 lines), `rerank-audit.ts`, `routing-eval.ts` (404 lines). External services: OpenAI (`OPENAI_API_KEY`), Anthropic (`ANTHROPIC_API_KEY`), and provider pricing pages referenced in comments (`openai.com`, `platform.claude.com`, `ai.google.dev`, `api-docs.deepseek.com`). Postgres features: `FOR UPDATE` in the spend files, and ledger inserts. Rust port notes: pricing tables and per-page budget math need fixtures so that cost numbers match. The held-embedding flow must produce the same user-approval states.

**12. Process safety, daemons, and retry.** Files: `process-watchdog.ts` (573 lines; out-of-band hard-deadline watchdog that sends SIGTERM and then SIGKILL, #1633), `pid1-reaper.ts` (zombie reaper when `gbrain serve` runs as PID 1, #2443), `process-cleanup.ts` (SIGTERM handling), `foreground-activity.ts`, `forward-progress.ts`, `progress.ts` (513 lines; bulk-action progress reporter), `retry.ts` (359 lines; shared retry for transient connection errors, v0.41.18.0), `retry-matcher.ts` (250 lines; pattern classification of retryable errors), `pace-mode.ts` (286 lines; named DB-pacer modes), `parallel.ts`, `gbrain-bin.ts`, `gbrain-home.ts`, `gbrain-env-file.ts`. External services: none. Postgres features: `statement_timeout` and `pg_terminate_backend` error classes in `retry-matcher.ts`. Rust port notes: the retry classifier needs a Rust-native error taxonomy. The watchdog is needed because a synchronous loop can block SIGTERM handlers. Rust threads can implement this more simply, but the SIGKILL deadline behavior should stay.

**13. Guardrails, quarantine, and trust.** Files: `guardrails.ts` (271 lines; vendor-neutral content guardrail seams, `GBRAIN_GUARDRAILS_MODULE`), `guard-ledger-checks.ts`, `quarantine.ts` (184 lines; frontmatter markers written by the content-quality gate, #1699), `quarantine-override.ts`, `outside-content.ts`, `filing-audit.ts`, `friction.ts`, `heal-audit.ts`. External services: none by default; the guardrails module is pluggable. Postgres features: none verified in this cluster. Rust port notes: the quarantine markers are part of the markdown format, so keep their exact frontmatter keys. The guardrail seam is a plugin point and needs an explicit Rust design.

**14. Readiness, notices, and configuration.** Files: `readiness.ts` (769 lines; capability readiness, agent operator contract v1, two tiers with fix hints), `interop-notices.ts` (540 lines; model-visible notices for degraded recall), `notice-ledger.ts`, `report-back-notice.ts`, `post-upgrade-notice.ts`, `release-channel-notice.ts`, `pooler-notice.ts`, `health-memo.ts`, `feature-flags.ts`, `published-config.ts`, `preferences.ts` (268 lines; uses `COPY`), `install-ref.ts`, `runtime-build.ts`, `runtime-version.ts`. External services: none. Postgres features: `COPY` in `preferences.ts` (unverified for the exact use). Rust port notes: notice text and readiness codes are visible to agents, so keep the strings and codes stable. Build the readiness report from the same checks as the CLI.

**15. Pages, memory, and search support.** Files: `page-find.ts`, `page-summary.ts` (411 lines), `page-counts.ts`, `page-searchability.ts`, `page-slug-grammar.ts`, `portable-slug.ts`, `page-size-policy.ts` (`MAX_FILE_SIZE` limits), `fts-language.ts` (233 lines; `GBRAIN_FTS_LANGUAGE`, Postgres text search configs), `function-search-path.ts`, `latin-fold.ts`, `levenshtein.ts`, `last-retrieved.ts`, `recall-cursor-state.ts`, `memory-trace.ts`, `remember-batch.ts`, `funnel.ts`, `forecast-journal.ts`, `ghost-pages.ts` (303 lines), `mounts-cache.ts` (463 lines; runtime ownership seam for mounts), `multi-source-drift.ts`, `restore-target.ts`, `reason-trailers.ts`, `remediation-checkpoint.ts`, `remediation-step.ts`, `reindex-consent.ts`, `oversized-backfill.ts`, `fix-routing.ts` (`registerOpRoutes`), `interaction.ts`, `review-lists.ts`, `preferences.ts`. Postgres features: `tsvector`, `websearch_to_tsquery`, and `ts_rank` in `fts-language.ts` and `postgres-engine.ts`. Rust port notes: the search-side functions (slug grammar, FTS language handling, ranking inputs) are the parity-critical pieces. Port the slug grammar and the text-search normalization exactly, since they change search results.

### Parity risks

- Operation manifest (204 entries) and per-op schemas must match the CLI and MCP JSON output field by field. Generated descriptors drift quickly.
- Markdown and frontmatter parsing (YAML alias bounds, recovery, fence rules, quarantine marker keys) changes stored page content. Fixture parity is needed.
- Link extraction and link-type inference (`inferLinkType`, role priors) decide which edges are stored. Small rule changes will show up in backlink and graph output.
- FTS: Postgres `tsvector` and `ts_rank` ordering is not reproducible exactly with a different embedded engine. Ranking tests will need tolerance or golden outputs.
- Lock semantics: `pg_advisory_lock(42)` migration serialization, the per-page lock, the PGLite owner lock, and the no-TTL OS lock must keep the same single-writer behavior.
- Error text and codes used by retry and readiness (`pglite_busy`, and the statement-timeout and terminate-backend patterns in `retry-matcher.ts`) are read by agents and the retry matcher.

### Open questions for Garry

- Should the Rust store keep the migration ledger and `MigrationDriftError` contract, or start a fresh schema version history?
- Are the 204 operations frozen as the CLI and MCP contract for v1, or can some be dropped in the port?
- Should the PGLite repair, WAL reset, and legacy lock tooling be ported at all, or left behind since they exist only for the PGLite WASM build?
- Is the guardrails module seam (`GBRAIN_GUARDRAILS_MODULE`) meant to remain a pluggable extension point in Rust?
- Does the OAuth provider need to ship in the first Rust release, given it runs its own SQL tables?

## Top-level src/core files (s-z) and code outside src/core

Reference: `garrytan/gbrain` at 8bbfd0b5e8. The 158 top-level `src/core/[s-z]*.ts` files are grouped below into 15 clusters (counts in headings). Line counts come from `wc -l`. Fields follow the common template: purpose, key files, dependencies, external services, Postgres use, Rust port notes.

### Foundations: types.ts and utils.ts

**Purpose.** Shared domain types and row mappers used everywhere. `src/core/types.ts` (2363 lines, about 84 exported types) defines `Page`, `Chunk`, `SearchResult`, `Link`, `TimelineEntry`, `SearchOpts`, and the embedding column config (`type: 'vector' | 'halfvec'`). `src/core/utils.ts` (710 lines) holds the content hash family (`contentHash`, `contentHashFrontmatterAndTags`, `contentHashLegacy`), row-to-domain mappers (`rowToPage`, `rowToChunk`, `rowToSearchResult`, `takeRowToTake`), `parseEmbedding`, `validateSlug`, `hashToken`, and `warnOncePerProcess`.

- Dependencies: `types.ts` imports `page-state/version-types`. `utils.ts` imports `engine`, `page-body/*`, `quarantine`, `source-id`, `takes-row-types`, and `types` (type-level).
- Postgres: `utils.ts` has `isUndefinedColumnError` (SQLSTATE 42703 at line 379) and `isUndefinedTableError`/`isMissingSchemaObject`, so callers tolerate missing schema. `types.ts` carries pgvector types (`$N::vector`, `$N::halfvec(N)`) and `hnswIterativeScan` (pgvector `hnsw.iterative_scan`), plus `keyword_statement_timeout_ms` for the Postgres engine.
- Rust port notes: types.ts is the contract surface for CLI JSON and MCP shapes. Keep field names and optionality exactly. The pgvector column types have no meaning on embedded storage, so the `vector`/`halfvec` split needs a new representation.

### Sync pipeline (26 files, about 8.3k lines)

**Purpose.** Turns a git repo of markdown into brain pages: diff, manifest, slugging, anchors, reconcile, and failure ledger. Core entry points: `sync.ts` (962 lines; `buildSyncManifest`, `isSyncable`, `pathToSlug`, `slugifyPath`, `resolveSlugForPath`), `sync-git.ts` (707; git invocation, repo discovery), `sync-delta.ts` (295; shared "what changed" machinery), `sync-reconcile.ts` (396; mass-delete valve, #2828), `sync-rename-identity.ts` (392; rename detection, uses `js-yaml`), `sync-anchor.ts` (501; anchor and chunker-version state), `sync-failure-ledger.ts` (1121; issue #1939 ledger, error classification), `sync-cost-gate.ts` (668; inline-embed cost gate and token estimate), `sync-lock.ts` (317; `SyncLockBusyError`, `--break-lock`), `sync-concurrency.ts` (323; worker counts, connection-budget clamp), `sync-identity-downgrades.ts` (258), `sync-upstream.ts` and `sync-upstream-rewrite.ts` (remote-tracking watch), plus 13 smaller `sync-*` files (policy, status report, pending, dispatch, embed backfill, byte paths, metafile pages) and `since.ts` and `uncommitted-deletions.ts`.

- Dependencies: `engine`, `cjk`, `sync-failure-ledger`, `git-env`, `hardened-git`, `spawn`, `persistence/*` (managed-mode, ownership, sync-holds, sync-blobs).
- External services: none. Git is a local subprocess only, and `sync-upstream*` fetches through git.
- Postgres: `sync-identity-downgrades.ts` uses `ON CONFLICT (op, fingerprint) DO UPDATE`. `sync-concurrency.ts` reads `max_connections` and forces one connection for PGLite (`engine.kind === 'pglite'`).
- Rust port notes: git path bytes must be preserved (`sync-byte-paths.ts` deals with octal-quoted names). Port `sync.ts` pure functions first, since they are the parity-testable core. Mass-delete and rename heuristics are thresholds that must match exactly.

### Serve and daemon runners (12 files, about 2.1k lines)

**Purpose.** Everything `gbrain serve --http` does besides the MCP transport. Key files: `serve-sync-runner.ts` (672; delegated sync execution), `serve-service.ts` (625; launchd plist on macOS, systemd unit `gbrain-serve.service` on Linux), `serve-log.ts` (206; log rotation and dedupe), `serve-sweep-runner.ts` (144; delegated sweep), `serve-head-watcher.ts` (76; commit notifier), `serve-http-status-marker.ts` (117; status file), `serve-fail-fast.ts` (exit for supervisors), `stdio-member-flag.ts` (`--stdio-member`), `session-lane.ts` (92), plus four small serve and session helpers.

- Dependencies: `engine`, `sweep`, `config`, `mcp-registration`, `tailscale`, `notifier/*`, `wire-skew`.
- External services: systemd and launchd through the OS, Tailscale (for `gbrain mcp expose`, via `tailscale.ts`).
- Postgres: `session-lane.ts` runs one read-only `pg_stat_activity` census of this role's client backends, keyed by `application_name` (`gbrain <kind>:<pid>:<nonce8>`). It counts pooler sessions separately and uses `GBRAIN_SESSION_LANE_LIMIT`.
- Rust port notes: the service files are only templates, so they are easy to port. The runners depend on an IPC handoff between serve and CLI processes; that design has to be decided before porting. The session-lane census has no meaning on embedded storage and should be dropped or replaced by a process-count check.

### Schema and migrations (8 files)

**Purpose.** Schema bootstrap, verification, and version gating. `schema-embedded.generated.ts` (3799 lines) is auto-generated from `src/schema.sql` by `bun run build:schema` (`scripts/build-schema.ts`). It holds the full DDL as a string (134 `CREATE TABLE` statements) and is the source for the fresh-install path. `schema-verify.ts` (307) diffs the expected columns against `information_schema.columns` and self-heals with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Its header says PgBouncer transaction-mode poolers can silently drop ALTER statements. `schema-client-behind.ts` (30) refuses to replay a schema whose version is newer than this binary's `LATEST_SCHEMA_VERSION` (error `client_behind`). `schema-migration-lock.ts` (38) is the one migration lock (GBRA-467). Also `schema-missing-tables.ts`, `schema-version-health.ts`, `schema-events.ts`, and `snapshot-schema-inputs.ts` (PGLite snapshot hash inputs).

- Dependencies: `engine`, `migrate`, `schema-migrations/latest.generated`, `vector-index`, `ops/contract`.
- External services: none.
- Postgres: DDL with `CREATE OR REPLACE FUNCTION`, `CREATE TRIGGER`, `pg_advisory` locks (lock key 42 through `engine.holdSchemaMigrationLock`), `LISTEN`/`pg_notify`, `tsvector`, and pgvector columns (all inside the generated file). `stored-embedding-identity.ts` reads `pg_class` and `information_schema`.
- Rust port notes: the generated DDL is the best source of truth for the embedded schema, but it is Postgres-only in form. Port the table set and column list, not the SQL text. Replace the pooler self-heal with a plain migration runner. The version-gate logic should carry over unchanged.

### Storage, SQL adapter, and vectors (13 files)

**Purpose.** Persistence support. `sql-query.ts` (157) is a narrow tagged-template adapter over `BrainEngine.executeRaw` that accepts scalar binds only. `statement-deadline.ts` (123) applies per-statement timeouts. `vector-index.ts` (357) manages the pgvector HNSW index (`CREATE INDEX CONCURRENTLY`, zombie cleanup, build probes, `hnsw.ef_search` sizing). `vector-prewarm.ts` (173) prewarms HNSW indexes. `storage.ts` (162) defines `StorageBackend` for binary files, and `storage-config.ts` (549) loads storage tiers from `gbrain.yml`. `supabase-admin.ts` (108) and `supabase-pooler-url.ts` (112) handle Supabase hosting. `sql-trace.ts` (146) writes a JSONL wire trace when `GBRAIN_SQL_TRACE` is set. `spend-log.ts` (127) and `spend-posture.ts` (106) track paid API spend and USD limits. `search-vector-backfill.ts` (146) rebuilds stored keyword vectors in batches. `stored-embedding-identity.ts` (41) reads embedding dimensions.

- Dependencies: `engine`, `embedded-engine`, `ops/contract`, `sync-policy`, `sources-load`, `backfill-base`.
- External services: `api.supabase.com/v1/projects` and `/database` (through `supabase-admin.ts`); S3, R2, MinIO, or Supabase Storage through `storage.ts`.
- Postgres: the heaviest cluster. HNSW DDL, `pg_stat_activity`, `pg_index`, `pg_class`, `pg_am`, `pg_extension`, `pg_stat_progress_create_index`, `information_schema`, `SET LOCAL statement_timeout` (via `vector-prewarm.ts`), and `CREATE INDEX CONCURRENTLY`.
- Rust port notes: `sql-query.ts` should disappear with the adapter; the surface it defines (scalar binds, returned rows) is a useful parity boundary for the OAuth code path. The HNSW policy is replaced by an in-process index, so `hnswMaxDimsForType` and the `ef_search` tables need a decision. Keep the spend-limit parsing exact, because it gates paid calls.

### Secret scanning (9 files)

**Purpose.** Pattern-based secret detection for user workspaces and transcripts, plus span redaction. `secret-scan.ts` (1491 lines) holds the provider patterns (`anthropic` is checked before `openai`). The rule files are `secret-scan-labeled.ts` (435; transcript labeled credentials), `secret-scan-assignment.ts` (124; opt-in high-entropy assignment rule), `secret-scan-cookie.ts` (82; `cookie_header` rule), `secret-scan-transcript.ts` (39), `secret-scan-stream.ts` (106; windowed scan of large streams), `secret-scan-allowlist.ts` (118; per-workspace allowlist file), `secret-scan-work.ts` (40; deterministic counters), and `secret-spans.ts` (142; span-level redaction for `gbrain repair`).

- Dependencies: `page-size-policy`, the secret-scan files themselves, `ops/contract`, `node:crypto`.
- External services: none.
- Postgres: none.
- Rust port notes: regex-heavy and order-sensitive. Pattern order and the allowlist decide the outcome, so diff redaction output against a fixture corpus.

### Skills (11 files)

**Purpose.** Parsing, health, drift, and integrity for SKILL.md skill packs. `skill-frontmatter.ts` (267; single content-based YAML frontmatter parser using `js-yaml`), `skill-catalog.ts` (627; catalog rendering; grep reports binary-like bytes in the file, so check encoding), `skill-manifest.ts` (195; unified manifest loader), `skill-trigger-index.ts` (265; trigger index), `skill-drift.ts` (237; drift and size analysis), `skill-health.ts` (226; size against budget), `skill-brain-first.ts` (399; analyzer for the `skill_brain_first` check), `skill-fix-gates.ts` (101; safety gates for auto-fixes, uses `spawn`), `skill-description.ts` (61), `skills-integrity.ts` (153; tamper-evidence manifest for the bundled `skills/` tree, `node:crypto`), and `skill-reserved-paths.ts` (10).

- Dependencies: `data-frontmatter`, `resolver-filenames`, `atomic-write`, `check-resolvable`, `git-env`, `spawn`.
- External services: none.
- Postgres: none.
- Rust port notes: frontmatter parsing must match `js-yaml` output for the fields in use. Hashes in `skills-integrity.ts` have to be byte-identical or the tamper check breaks. The skill files are plain filesystem content, so this cluster ports cleanly.

### Takes (7 files)

**Purpose.** The "takes" feature: fenced takes tables in markdown, their write-through, forecast horizons, resolution scoring, and the proposal cycle. `takes-fence.ts` (656; fence parser and renderer, markers `<!--- gbrain:takes:begin --->`), `takes-write.ts` (921; shared write-through core for the CLI and reconcile), `take-proposals.ts` (359; `propose_takes` cycle phase), `takes-horizon.ts` (150; horizon date, `ON CONFLICT (take_id) DO UPDATE`), `takes-resolution.ts` (120; pure scorecard helpers), `takes-row-types.ts` (35), and `tag-limit.ts` (19; longest tag length for btree index limits).

- Dependencies: `engine`, `fence-scan`, `fence-shared`, `sync`, `page-lock`, `atomic-write`, `trust/tier`, `write-through`, `ops/contract`.
- External services: none (the propose cycle calls a model through the cycle layer; unverified here).
- Postgres: `ON CONFLICT (page_id, row_num)` upserts (`takes-write.ts`), a `BEGIN` transaction, and `ON CONFLICT (take_id)` (`takes-horizon.ts`). `tag-limit.ts` encodes a btree v4 entry limit of 2704 bytes.
- Rust port notes: the markdown fence is the durable format and must round-trip byte for byte. The DB row shapes map to the schema, so keep `takes-row-types` and `takes-resolution` pure and reuse them unchanged.

### Timeline (9 files)

**Purpose.** Extracts dated entries from rendered markdown and keeps them in step with the database and markdown. `timeline-extract.ts` (572; core parser), `timeline-order.ts` (272; orders the two halves of a page's timeline), `timeline-marker.ts` (65; writes DB-only rows back to markdown), `timeline-write-through.ts` (451; write-through on FS/git-canonical brains), `timeline-dedup-repair.ts` (290; migration v102 dedup index repair), `timeline-citations.ts` (234; citation parsing), `timeline-grading.ts` (43; 15-point grading component), `temporal-grammar.ts` (327; date-expression grammar), and `valid-time.ts` (186; edition in force on a date, from frontmatter `valid_from`/`valid_to`).

- Dependencies: `engine`, `link-extraction`, `markdown`, `page-lock`, `batch-rows`, `minions/source-filesystem`, `persistence/mirror-read-only`, `search/safe-chunks`.
- External services: none.
- Postgres: `timeline-dedup-repair.ts` reads `pg_indexes` and works around `ON CONFLICT` inference on `(page_id, date, md5(summary), source)`. The header describes a dedup index widened by migration v102.
- Rust port notes: order and marker rules affect the markdown output, so they need golden tests. The dedup-repair module exists only because of Postgres index inference; in Rust it becomes a uniqueness check on the embedded store.

### Write gate and wanted links (9 files)

**Purpose.** Zero-LLM gate on durable writes: classify, quarantine, and hold facts. `write-gate.ts` (589) is the gate (separate from `guardrails.ts`, which only observes). `write-gate-patterns.ts` (242; pure data; four reason classes), `write-gate-regex.ts` (99; bounded-regex safety), `write-gate-scan.ts` (226; scans existing memory by projected trust tier), `write-gate-schema.ts` (78; migration and fresh-install DDL via `scripts/build-schema.ts`), `write-gate-store.ts` (286; `write_gate_holds` table), `write-through.ts` (721; canonical ingestion disk write-through), `wanted-links.ts` (93; authored links to missing pages), and `wanted-links-store.ts` (177).

- Dependencies: `engine`, `trust/tier`, `ops/contract`, `belief/ledger`, `sync-anchor`, `transcripts/render`, `sql-query` (wanted-links-store).
- External services: none.
- Postgres: `information_schema.columns` (`write-gate-scan.ts`), `ON CONFLICT` upserts (`wanted-links-store.ts`), the `write_gate_holds` table, and `CREATE`/`ALTER` DDL.
- Rust port notes: the pattern data is a parity-critical contract (the "zero-LLM" rule means classification is deterministic). Port `write-gate-patterns.ts` and `write-gate-regex.ts` as data plus a matcher, with the same regex semantics and bounds.

### Upgrade and self-upgrade (10 files)

**Purpose.** Decides and performs self-upgrade and restarts gbrain processes after an upgrade. `self-upgrade.ts` (946; decision and state, channels, install methods), `self-upgrade-swap.ts` (123; swap settlement), `self-upgrade-recovery.ts` (97; recovery when the supervisor relaunches the same version), `stable-channel.ts` (205; stable release line), `semver.ts` (75), `upgrade-restart.ts` (503; restarts every gbrain process on the host), `upgrade-summary.ts` (53), `thin-client-upgrade-prompt.ts` (486), `temporal-edges-upgrade-notice.ts` (67), and `wire-skew.ts` (60; compatibility windows for wire fields).

- Dependencies: `config`, `bun-floor`, `cycle/cycle-date`, `minions/quiet-hours`, `schema-pack/pack-lock`, `spawn`, `audit/self-upgrade-audit`.
- External services: GitHub. `stable-channel.ts` fetches a stable record from `raw.githubusercontent.com/garrytan/gbrain` and checks run URLs against `github.com/garrytan/gbrain/actions/runs/...`.
- Postgres: none.
- Rust port notes: the decision logic targets the Bun install and may need re-specifying (unverified). Keep `semver.ts` and `wire-skew.ts` exact.

### Operations, verbs, and sweeps (8 files)

**Purpose.** Agent-facing operations and background maintenance. `verbs.ts` (1138; the frozen MEMORY_VERBS v1 protocol: `VERB_NAMES`, `RESPONSE_SCHEMAS`, `ERROR_SCHEMA`), `sweep.ts` (1276; serve-resident maintenance sweep, CX-P0 items), `synopsis-sweep.ts` (249; `per_chunk_synopsis` tier), `scope.ts` (339; OAuth scope hierarchy and allowlist), `token-mint.ts` (219; legacy bearer token mint and revoke), `surface-audit.ts` (58; surface-change audit trail), `similar-pages.ts` (70), and `sort-newest-first.ts` (23).

- Dependencies: `engine`, `operations`, `funnel`, `persistence/*`, `grants/model`, `wakeshift/forget`, `sql-query`, `budget/reservation-cost`, `wanted-links`.
- External services: none in the core; `verbs.ts` mentions Anthropic and OpenAI only in help text.
- Postgres: `token-mint.ts` and `surface-audit.ts` run raw SQL through `sql-query`. `sweep.ts` calls the engine for maintenance work.
- Rust port notes: the verb names, parameter shapes, and response schemas are the MCP contract and must match exactly. Treat `verbs.ts` as a golden-test source. `scope.ts` controls access rules, so port with tests.

### Transcription and transcripts (4 files)

**Purpose.** Audio transcription and raw transcript handling. `transcription.ts` (249) calls Groq Whisper (`api.groq.com/openai/v1`, model `whisper-large-v3` by default) and falls back to OpenAI (`api.openai.com/v1`, `whisper-1`). It also declares a `deepgram` provider type with `DEEPGRAM_API_KEY`. Files above 25 MB are segmented with ffmpeg (per the header). `transcripts.ts` (177) reads raw `.txt` transcripts from the dream cycle and runs them through `secret-scan`. `trajectory.ts` (190) derives trajectory metrics. `trajectory-format.ts` (216) formats the `<trajectory>` prompt block.

- Dependencies: `ai/invocation-guard`, `context/corpus-segments`, `cycle/transcript-discovery`, `secret-scan`, `think/sanitize`.
- External services: Groq and OpenAI speech-to-text APIs (`fetch` with `FormData`, through `invokeAI`).
- Postgres: none.
- Rust port notes: keep the provider order (Groq, then OpenAI) and env var names. ffmpeg is an external binary, so decide whether Rust shells out to it.

### Infrastructure utilities (13 files)

**Purpose.** Small leaf helpers used across the core. `spawn.ts` (105) is the module that launches subprocesses (among the s-z files it is the only one importing `node:child_process`). `worker-pool.ts` (337) is a sliding pool with a bounded semaphore. `tailscale.ts` (515) wraps the Tailscale CLI (`status`, `serve`, `funnel`). `timeout.ts`, `timing-safe.ts` (constant-time hex compare), `zombie-reap.ts` (child reaping), `stall-env.ts` (watchdog knobs), `shell-quote.ts`, `stdin-read.ts`, `text-safe.ts` (surrogate-safe text), `wakeshift-env-key.ts`, `wsl-paths.ts`, and `yaml-lite.ts` (minimal YAML for markers and breadcrumbs).

- Dependencies: mostly none. `tailscale.ts` uses `mcp-registration` and `spawn`. `zombie-reap.ts` uses `pid1-reaper`.
- External services: the Tailscale CLI.
- Postgres: none.
- Rust port notes: `worker-pool.ts` maps onto Tokio or threads; `timing-safe.ts` needs a constant-time compare crate or hand-rolled code; `spawn.ts` becomes the single subprocess boundary. Most of this cluster is trivial to port.

### Sources and workspace push (17 files)


**Purpose.** Multi-source management. `source-resolver.ts` (1185; CLI source resolution), `sources-ops.ts` (1233; source-management functions), `workspace-push.ts` (1219; `gbrain sources push`, scan-gated add, commit, pull, push under one lock), `source-health.ts` (492; per-source health via git), `sources-load.ts` (310; shared source-table loader), `source-id.ts` (114; `source_id` validation), `source-delete.ts` (100; purge eligibility), `source-config-sql.ts` (67; coercion of historical `sources.config` shapes), `url-clone.ts` (153; gbrain-owned clones), `url-source-origin.ts` (261; who added a URL source), `url-redact.ts` (111; Postgres URL credential redaction), and `ssrf-validate.ts` (320; DNS-resolving SSRF check). Roughly five more small `source-*`, `sources-*`, and `url-*` helpers.

- Dependencies: `engine`, `config`, `git-env`, `git-remote`, `hardened-git`, `spawn`, `secret-scan`, `secret-scan-stream`, `persistence/ownership`, `repo-visibility`, `pglite-lock`.
- External services: git remotes (through `url-clone.ts` and `workspace-push.ts`) and DNS (through `ssrf-validate.ts`, using `node:dns/promises`).
- Postgres: `url-source-origin.ts` runs `SELECT ... FROM sources WHERE id=$1 FOR UPDATE` inside a transaction. `source-config-sql.ts` coerces JSONB shapes. `url-redact.ts` redacts Postgres connection URLs.
- Rust port notes: `workspace-push.ts` is a sequencing contract (scan, commit, pull, push) with lock and steal rules, which need a faithful port. `ssrf-validate.ts` must reproduce DNS-rebinding defenses. Row locks (`FOR UPDATE`) become whatever the embedded store offers.

### Parity risks

- Source-table and sync behaviour depends on git plumbing (byte-exact paths, `--name-status -M`, rename detection); small differences change the page set.
- Regex and pattern order in `secret-scan.ts` and `write-gate-patterns.ts` must match exactly, or redaction and gating outputs will differ.
- The `verbs.ts` response schemas and error shapes are the MCP contract; any field drift fails black-box tests.
- Frontmatter YAML parsing (`js-yaml` in skills and sync rename) must produce the same values and hashes.
- Lock and steal behaviour (sync lock, workspace-push lock, schema migration lock) must not allow two owners.
- Chunk, content, and takes fence round-tripping must be byte-identical; `takes-fence.ts` and `timeline-extract.ts` determine markdown output.

### Open questions for Garry

- Is the Rust port expected to keep the serve sync and sweep delegation (serve-sync-runner, serve-sweep-runner) or move to a single in-process runner?
- Should the Supabase Management API helpers (`supabase-admin.ts`, `supabase-pooler-url.ts`) and the pooler session-lane census be dropped with Postgres, or kept for hosted brains?
- Keep the Groq/OpenAI/Deepgram transcription providers, and is ffmpeg acceptable as an external dependency in Rust?
- Does the self-upgrade and stable-channel logic (`self-upgrade*.ts`, `stable-channel.ts`) get re-specified for the Rust binary, or is the TypeScript decision logic the reference?

### Outside src/core

- `src/cli.ts` (90 lines) is the `gbrain` entry point. It answers engine-free fast paths itself and dynamically loads `src/cli/main.ts`. `src/cli/` has 38 entries (`command-table.ts`, `command-route.ts`, `op-manifest.ts`). `src/commands/` has 296 top-level `.ts` command files. `src/mcp/` has 23 files (`server.ts`, `dispatch.ts`, `tool-defs.ts`, `http-transport.ts`). `src/eval/` has 58 files (`brainbench/`, `longmemeval/`, `retrieval-quality/`).
- `src/schema.sql` (3794 lines) is the Postgres DDL source. `src/schema-embedded.generated.ts` is generated from it.
- `src/openclaw-context-engine.ts` (146 lines) is the OpenClaw plugin entry (`gbrain-context-engine`), which injects temporal and spatial context each turn.
- `src/admin-embedded.ts` (30 lines) is generated (`scripts/build-admin-embedded.ts`) from `admin/dist/`, so the admin SPA is bundled into the binary.
- `native/locks/` is a first-party C Node-API v3 addon (`locks.c`, `darwin-abi.h`, `windows-napi.h`, `manifest.json`). It uses `flock` on POSIX and `LockFileEx` on Windows. `src/core/persistence/native-lock.ts` wraps it with a 5-second deadline and 25 ms polling.
- `admin/` is a Vite and React dashboard (`gbrain-admin`) for OAuth agents, API keys, and request monitoring. It has Playwright e2e tests and `DESIGN.md`.
- Rust port notes: the 296 command files are the largest parity surface. The `native/locks` design (kernel-released locks on a stable path) maps to Rust file locks. `admin/` is a separate SPA and can keep its own stack.

