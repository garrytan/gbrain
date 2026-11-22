# 12. Performance, scale and operations map

Line numbers refer to gbrain 36bd05806a.

Reference: TypeScript gbrain v0.60.733.0 at garrytan/gbrain (read-only). Eval repo: garrytan/gbrain-evals (commit 9ecc5b20, read-only, only small-corpus latency checks found).

Evidence labels used below:

- [V] read in source or doc during this pass.
- [R] a measurement recorded in a repo doc, CHANGELOG or TODO. Not re-run here.
- [I] my inference.

No benchmark or test was executed for this map. Counts come from rg or python over the source tree; where a count is a regex approximation, the text says so.

## Part A: Performance

### A.1 Measured pain points

| Symptom | Measured number (scale) | Root cause | Citation | Does an embedded Rust store fix it? |
|---|---|---|---|---|
| Hot read plan falls into nested loops; `readAdjacencyBoosts` stalls | about 72 s, fixed to 21 ms by a full ANALYZE (reporter brain, size not stated) [R] | No planner statistics; PGLite has no autovacuum | TODOS.md:556 | Yes if access paths are hand-coded. No if SQL and its planner stay. |
| Type or date filter disables the vector index walk, planner seq-scans and sorts `content_chunks` | 462 ms filtered vs 56 ms unfiltered (Postgres 20k); 195 vs 58 ms (PGLite 10k) [R] | `vector-statement.ts` marks filtered statements narrowed and skips the HNSW walk | TODOS.md:50 (open, P2) | Yes, if the ANN supports filtered search with a selectivity estimate. Needs design. |
| Source-scoped vector search returns too few neighbours; fallback runs 4 to 8 s | 4 to 8 s fallback; source holds a few percent of a large brain [R] | HNSW walk runs over the whole brain, then filters | CHANGELOG.md:14686 (0.60.131.0) | Partly. Exact scan of up to about 25k chunks per source is cheap in memory; larger scopes need filtered ANN. |
| Freshly imported 1M to 2M chunk brain: scoped search slow, half of broad searches fall back to keyword | 0.5 to 8 s; 8 to 75 ms p50 after refresh [R] | Stale statistics make the planner sort instead of walking HNSW | CHANGELOG.md:14572 (0.60.135.0) | Yes, if the store owns its statistics and refreshes them after bulk writes. |
| Cold vector search after Postgres restart | vector stage 1.4 s median, 3.0 s p95; 41 ms median after prewarm (50 s to prewarm 11 GB) [R] | Index not in `shared_buffers` | CHANGELOG.md:6694 (0.60.449.0) | Partly. mmap plus explicit prewarm helps; an 11 GB index is still disk-bound. |
| PGLite HNSW build out of memory, then wedged | OOM at 1 GB `maintenance_work_mem`; wedged at 1.5 GB; 663 s; chunk index 1.9 GB (PGLite 50k) [R] | pgvector builds the whole graph in memory inside a 2 GiB WASM heap; WAL checkpoint runs inside one statement | CHANGELOG.md:14285, 14294 (0.60.146.0); docs/ENGINES.md "PGLite vector index ceiling" | Yes. A bounded-memory builder with no WASM cap removes this. |
| PGLite vector ceiling | a 248,802-chunk build takes about 11 min and makes a 1.9 GB index; graphs above 1.5 GiB (about 300k chunks at 1024 dims) are refused with `pglite_vector_index_too_large` [R] | WASM heap cap plus `maintenance_work_mem` sizing | docs/ENGINES.md "PGLite vector index ceiling" | Yes. |
| Postgres HNSW build under-provisioned | 4.3x slower at 250k chunks with 256 MB; 1M-chunk build 103 s on 16 vCPU with 12 GB and 8 workers [R] | pgvector `maintenance_work_mem` and parallel workers | docs/ENGINES.md "Vector index sizing" | Yes, no DB knob. Build time becomes an implementation benchmark. |
| Index size | about 7.6 GiB per million 1024-dim chunks as `vector` (9.8 GiB at 1.28M chunks); halfvec is one third of that [R] | Vector and graph links stored together | docs/ENGINES.md "Vector index sizing" | Partly. Quantised vectors (f16 or int8) are a design choice to make. |
| PGLite 20k-page vector phase stalls | 36 min before the WAL guard; 173 s after; per-batch time still rises from 2.1 s to 6.3 s; RSS about 2.5 GiB [R] | Nested checkpoint inside WASM; superlinear per-batch cost | TODOS.md:209 (open, P2) | Yes for the WASM part. The superlinear growth is unexplained, so it is an open question for Rust too. |
| Autovacuum never finishes on a 10M-chunk brain | millions of dead rows kept in every index [R] | gbrain's own ANALYZE took the table lock; Postgres cancels autovacuum after one second of waiting | CHANGELOG.md:9814 (0.60.318.0) | Yes, if the store has no MVCC bloat (in-place updates with compaction, or append-only with compaction). Compaction must be designed. |
| Postgres stats wait for churn | autovacuum analyses only after about 10% of a table changes | Autovacuum threshold | TODOS.md:46 (open, P2) | Yes for embedded storage. No for remote Postgres mode. |
| MCP search slow on Postgres between 10k and 20k pages | 615 ms at 20k (v0.60.53.0), now 33.7 to 74.1 ms; PGLite 27 ms [R] | Plan growth, since fixed | TODOS.md:378, 379 (closed) | Historical. Shows plan instability is a real risk. |
| JIT compilation on a common title lookup | 17 ms execution, 504 ms JIT (40k pages, Postgres) [R] | `jit_above_cost` crossed by visibility subplans | TODOS.md:457 (open, P3) | Yes, no JIT. |
| PGLite per-statement overhead | owner wall time per write 113 to 30 ms; WASM time 60.7 to 13.3 ms; 217 to 176 SQL statements; 473 relation-file opens per write (1,000 writes) [R] | Each `query()` parses, plans and describes over five protocol round trips | docs/research/pglite-persistence-throughput-2026-09-29.md | Yes. |
| Committed write throughput | PGLite 8.9 to 31.7 writes/s; Postgres 11.2 to 13.5 writes/s (1,000 writes, standard-30 VM) [R] | Same as above | same doc | Yes for PGLite. |
| Round trips to a pooled remote Postgres | `put` 4.5 s and 228 round trips to 4.1 s and 204 at 40 ms RTT; no-op sync 70 to 90 round trips to about 32 [R] | Network round trips per statement | CHANGELOG.md:8445 (0.60.375.0), 9275 (0.60.344.0) | Not applicable to embedded. Remote mode keeps the problem. |
| Managed sync catch-up far from DB | about 150 pages/min; 10,000-file backlog 1.2 h, was 5.4 h [R] | Per-page round trips | CHANGELOG.md:16628 (0.60.73.0) | Same as above. |
| Import cost drifts upward | last 10% of pages cost about 8x the first 10% (gate is 1.5x); 6.9 to 8.3 after a fix [R] | Not identified; the gate is partly report-only | TODOS.md:404; docs/fix-wave-notes/capy-fix-wave-8.md:18 to 24 | Unknown. Needs a benchmark before choosing a design. |
| Doctor `purged_page_facts` slow | 6.7 to 7.0 s Postgres, 24 to 26 s PGLite, now about 1.0 s on both (1M active facts) [R] | Not stated in the entry (I: a scan over all facts) | CHANGELOG.md:80 (0.60.733.0) | Yes, if the store indexes the predicate. |
| Quoted-marker screen quadratic | 12 to 18 s for 40,000 mentions, minutes for a 24 MiB page; now about 100 ms [R] | Re-reading the page for each mention (algorithmic, not a DB issue) | CHANGELOG.md:4826 (0.60.534.0) | No. The fix was algorithmic; Rust only helps the constant factor. |
| Entity name batch slow on PGLite | about 2.4 s for 50 names at 55k pages [R] | Suffix `LIKE` with no index, scanned per name | TODOS.md:56 (open, P2) | Only with an index designed in. |
| Saved-fact match on PGLite without trigram index | p50 19.6 to 3.4 ms at 10k facts; 94 to 12 ms at 50k; 167 to 23 ms at 100k [R] | Missing trigram index | TODOS.md:48 (P3, dropped by its gate) | Yes, if the store has a fuzzy index. |
| Cold process first query | budget 2,172 ms PGLite, 1,326 ms Postgres (MCP path, 10k) [R]; snapshot ON 879 ms vs OFF 3,000 ms to connect and init schema (local, master v0.60.11.0) [R] | WASM boot and schema replay (I) | scripts/scale/budgets.json; docs/designs/refactor-wave-1/perf-baseline.md:149 to 152 | Yes. Removes WASM boot and replay (I). |
| Connection exhaustion on Postgres | each read-only serve held a 3-connection pool; sessions ran out (`EMAXCONNSESSION`) [R] | Pool per process | CHANGELOG.md:6345 (0.60.464.0) | Remote mode only. |

### A.2 Recurring root causes [V]

1. Planner statistics. PGLite has no autovacuum (TODOS.md:556). Postgres autovacuum waits for about 10% churn (TODOS.md:46). gbrain's own ANALYZE blocked autovacuum (CHANGELOG.md:9814). Stale statistics flip vector search to a full sort (docs/ENGINES.md search section, "Without those statistics the vector candidate statement sorts every eligible chunk").
2. Filters versus ANN. A filter disables the walk (TODOS.md:50), and a post-filter over a global walk loses neighbours (CHANGELOG.md:14686).
3. WASM runtime. A 2 GiB heap cap (docs/ENGINES.md), per-statement protocol overhead (research doc), and an automatic WAL checkpoint that could spin at 100% CPU inside one statement (src/core/pglite-engine/checkpoint-guard.ts:1 to 12).
4. Remote round trips. Every remote pooler statement costs a round trip. The fixes in CHANGELOG.md:8445, 8582, 9275 are pipelining and fewer statements.

### A.3 Scales the Rust engine must handle

| Dimension | Documented scale | Source |
|---|---|---|
| Pages | 600,000 (production-shaped soak, two hours, 2 ms and 65 ms network delays) | docs/STABILITY.md:49; CHANGELOG.md:8144 (0.60.387.0) |
| Pages | 165,000 "production class"; 46k to 55k brains in reports | TODOS.md:5137; UPGRADING_DOWNSTREAM_AGENTS.md:400; TODOS.md:56 |
| Chunks | 1M to 2M freshly imported; about 10M in a reporter's brain; 1.28M in the sizing example | CHANGELOG.md:14572, 9814; docs/ENGINES.md |
| Facts | 1,000,000 active (doctor check); 100k with ranked recall of 51 ms p95 on Postgres | CHANGELOG.md:80; 13701 (0.60.169.0) |
| Vector index | 11 GB HNSW on the 600k soak | CHANGELOG.md:6694 |
| Dimensions | 1024 (Voyage default in CLI profile; image and multimodal columns); 1536 (base `content_chunks.embedding` in src/schema.sql:360); up to 8192 accepted by the embedding-column registry; a 2560-dim halfvec was used once | perf-baseline.md:63; CHANGELOG.md:40696, 40702 |
| PGLite ceiling | about 300k chunks at 1024 dims before refusal | docs/ENGINES.md |
| CI scale tier | 10k and 20k nightly; 50k gated on five nights of trend | scale-tier.yml:9, 30 to 35; scripts/scale/README.md. CHANGELOG.md:8144 describes the earlier tier as 300k pages. |

The CI fixture is not a real embedding. `SCALE_VECTOR_DIMS = 16` in `scripts/scale/fixture.ts:70` places 16 nonzero dimensions in a column of width 1024 (fixture.ts:69 to 74). HNSW navigates such vectors far more easily than real ones, so scale-tier HNSW latencies are optimistic.

### A.4 Measurement harness state [V]

- `scripts/scale/budgets.json` holds p50 budgets at 3x the calibration run on Ubicloud standard-8. Postgres: `get_health` 597 ms, `search` (MCP path, remote) 151 ms, `query` hybrid 252 ms, `find_orphans` 86 ms, cold first query 1,326 ms. PGLite: `get_health` 463 ms, `search` (MCP path) 122 ms, `query` 74 ms, cold first query 2,172 ms. These are report-only until `trend.ts` reports stable ceilings.
- `tests/heavy/rss-baseline.json` is an empty stub. No Linux peak-RSS baseline exists, so every RSS run is informational. A Rust port must create its own baseline.
- `tests/heavy/read_latency_under_sync.sh` is informational unless `STRICT_LATENCY=1`.
- `docs/eval-bench.md:256` sets the replay gate: mean latency within 50 ms of captured, and more than 2x anywhere is an alarm. The gbrain-evals repo has only small latency tables (for example 1.92 ms p50, docs/benchmarks/2026-04-19-knowledge-runtime-v0.13.md), so it is not a scale source.

## Part B: Operations

### B.1 Doctor [V unless marked]

- Registry: `DOCTOR_CHECK_REGISTRY` is an array of about 165 entries (src/commands/doctor/registry.ts:206 to 385). Four tiers: `ops`, `quick`, `standard`, `deep` (context.ts:30). Non-interactive budget is 90 s (default-budget.ts:15).
- Modules: 207 files in `checks/`; 118 export a `*Entry`. About 340 distinct check names appear in `emits:` arrays (regex count, approximate). Categories are brain, skill, ops and meta (src/core/doctor-categories.ts).
- Engine-touching: 130 of 207 check files reference engine methods or SQL (regex, approximate).
- Postgres-catalog checks (15 files): `postgres-tls.ts` (`pg_stat_ssl`), `planner-stats.ts` (`pg_stat_user_tables`), `vector-plan.ts` (`pg_class`, `pg_index`, `pg_am`, `pg_stats`), `keyword-plan.ts` (`pg_stats`), `core-health.ts` (`pg_extension`), `schema-health.ts` (`pg_roles`, `pg_class`), `function-search-path.ts` and `schema-function-bodies.ts` (`pg_proc`), `embedding-health.ts` (`pg_index`), `mcp-request-log.ts` (`pg_total_relation_size`), `persistence-requests.ts`, `queue-assets.ts`, `managed-guard.ts`, `graph-embedding.ts` (`information_schema`), `postgres-cancellation.ts`, `safe-index.ts`.
- PGLite-only: `pglite-worker.ts` (312 lines); `pgliteDataDirEntry` in the registry. Twenty-two files branch on `engine.kind`. Three check files set `opsPglite: 'not_applicable'`, which skips them on PGLite under `--tier ops` (context.ts:50 to 56).
- Rust mapping: engine-neutral checks (embedding coverage, page health, link integrity, facts and takes, skill routing, sync freshness) port by reading the Rust store. The Postgres-catalog checks and the pooler and connection checks (`session_lane_budget`, `pool_reap_health`, TLS) have no meaning in embedded mode and should be replaced by store checks: file lock, WAL or journal size, index age, statistics age, file-level integrity.

### B.2 Schema migrations [V]

- 313 migration files (v2 to v318). Versions 1, 17, 18, 19 and 100 have no file. 242 declare `idempotent: true`; 76 have a `handler:`; 31 use `sqlFor`; 40 set `transaction: false`. Types: src/core/schema-migrations/types.ts:20 to 32.
- Ledger: no migrations table. The ledger is one row, `config.version`, seeded to `'1'` in src/schema.sql:726. `runMigrations` reads it (src/core/migrate.ts:381) and advances it after each migration succeeds (migrate.ts:513). Migrations must run in version order (migrate.ts:385 to 389).
- Runner: `tryRunPendingMigrations` (migrate.ts:303) waits up to 5 s for a lock with a 250 ms poll. Each migration runs under `SET LOCAL statement_timeout` and `lock_timeout` (migrate.ts:214 to 242). Retries on SQLSTATE 57014 use 5 s, 15 s and 45 s backoff (migrate.ts:149 to 167).
- Timeouts: migration statement timeout 600,000 ms (src/core/migration-timeout.ts:19); schema lock timeout default 60 s (src/core/postgres-engine/schema-lock-timeout.ts:46), set by `GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS`.
- Lock: Postgres holds advisory key 42 across connections (src/core/schema-migration-lock.ts:5 to 9; postgres-engine/init-schema-lock.ts). PGLite is serialised in-process only, because its kernel lock admits one process.
- Fresh install: the schema blob seeds version 1, so a new brain replays every migration and prints one summary line (migrate.ts:470 to 486).
- Schema shape (src/schema.sql, 3,794 lines): about 134 table definitions, 177 `CREATE INDEX`, 32 `ENABLE ROW LEVEL SECURITY`, 26 `CREATE TRIGGER`, 3 `CREATE EXTENSION`, 3 `NOTIFY`, 9 `tsvector`. `src/core/pglite-schema.generated.ts` is 3,030 lines.

### B.3 Upgrade and engine switch [V]

- `gbrain upgrade` (src/commands/upgrade.ts:51). Flags: `--channel stable|alpha`, `--dry-run`, `--stop-mcp`, `--no-restart`, `--swap-only`, `--restart-only`. Post-upgrade migrations run through `gbrain post-upgrade` (docs/UPGRADING_DOWNSTREAM_AGENTS.md:24); `apply-migrations --yes` is the explicit form.
- Install methods: `bun`, `bun-link`, `binary`. `canSelfUpdate` returns true for bun and bun-link, and for binary only on darwin-arm64 and linux-x64 (src/core/self-upgrade.ts:302 to 313).
- Binary swap (src/core/binary-self-update.ts:1 to 40): download to a sibling, verify SHA-256 against the SLSA attestation from the GitHub REST API (builder id pinned to this repo's release workflow on master, lines 53 to 58), smoke-test `--version`, check version against tag, then `rename`. Any failure leaves the old binary. The sigstore chain is not validated, and the header says so.
- bun path: `bunReinstallCommand` runs `bun remove -g gbrain` then `bun add -g` the pinned tag, because an in-place tag swap corrupts the global package (src/commands/upgrade.ts:562 to 569).
- Engine switch: `gbrain migrate --to postgres|supabase|pglite` (src/commands/migrate-engine.ts:6 to 8). PGLite to Postgres uses graduation (src/commands/migrate-graduation.ts), which needs a plan hash (`--yes --expect <hash>`) and refuses while a live `gbrain serve` holds the PGLite kernel lock (docs/ENGINES.md, "graduation-writer-held"). The legacy path re-creates pages through `putPage` and copies stored chunk embeddings with `upsertChunks` (src/commands/migrate-engine.ts:550), so it makes no embedding provider call.

### B.4 Backups [V]

- `gbrain backup status|check` (src/commands/backup.ts:1 to 20) is a coverage verdict, not a backup. It checks Git HEADs, remote readback, and the install receipt, and caches the verdict at `~/.gbrain/backup-status.json` (docs/operations/backup-check.md).
- The DB file is deliberately gitignored. Git evidence covers committed files only. DB-only pages, facts and config need a separate drill. PGLite DB-only pages warn; Postgres DB-only pages are info.
- Markdown export (`gbrain export --source <id> --dir ...`) is not a full database backup (CLAUDE.md:221).
- Implication: the Rust store file is outside Git, so it needs its own backup story, or the design relies on re-sync from Markdown.

### B.5 Spend controls [V]

- `spend.posture`: `gated` (default) or `tokenmax`. `tokenmax` keeps the ledger and removes the ceiling, except that an explicit `--max-usd` always wins (docs/operations/spend-controls.md:16 to 35).
- Key gates (docs/operations/spend-controls.md:140 to 161): backfill per source per 24 h $25 (`embed.backfill_max_usd_per_source_24h`); backfill per job $10 (`embed.backfill_max_usd`); `--yes` alone uses the estimate times 1.5 (floor $0.25) or a $5 default cap; atom auto-drain $2.00 per day; dream `extract_atoms` $0.30 per phase; fence repair $0.30 per page and $1.00 per day; Life Chronicle $0.25 per call and 200 calls per rolling 24 h; dream `synthesize` $5 per run.
- Ledger tables: `page_embedding_budget`, `decide_spend`, `page_derivation_spend`, `chat_usage_log` (src/schema.sql:2062, 3138, 2265, 1057).
- Implication: spend state is data in the store, so a Rust port must carry these tables or re-create their semantics.

### B.6 Distribution [V]

- Release binaries: `bun build --compile` on release.yml, targets `bun-darwin-arm64` (macos-26) and `bun-linux-x64` (ubuntu-latest) (.github/workflows/release.yml:125 to 131, 170). Bun is pinned to 1.4.4 (release.yml:109). No Windows or Intel macOS asset.
- Installer: `bun install -g github:garrytan/gbrain#stable` (README.md:40, 65). The docs forbid `npm install -g gbrain` and `bun add -g gbrain`. `package.json` `engines.bun` is `>=1.4.4` (package.json:261 to 262).
- Plugin lane: `.agents/gbrain-launcher` resolves the binary from `$GBRAIN_BIN`, then PATH, then `~/.bun/bin/gbrain` (lines 9 to 11). The Claude and Codex manifests start `serve --surface full --source-guard` through the launcher.
- OpenClaw: `openclaw.plugin.json` names the plugin `gbrain-context-engine`, and its config schema (lines 8 to 16) asks for a `database_url` (a PostgreSQL URL, "Supabase recommended") and an OpenAI key. This is Postgres-specific and must change.
- Version stamps: `VERSION`, `package.json`, `openclaw.plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` all read 0.60.733.0 today. CLAUDE.md:329 calls this a five-file lockstep. CI fails when they drift.
- Compiled binary embeds PGLite WASM; `scripts/check-pglite-embedded.sh` guards this (TODOS.md:8150 area). A Rust engine drops that lane.

### B.7 What a Rust engine must replicate for users to switch [I]

1. The command name `gbrain` on PATH and in `~/.bun/bin`, because the launcher and manifests hard-code it.
2. The agent operator contract: `--json` envelopes, error codes (docs/guides/error-codes.md), exit codes (3 for confirmation required), and the `ask_user`-style fix objects. Harnesses parse these.
3. The MCP tool names and parameter schemas, with the schema budget tests as a guard.
4. Config keys and file locations (`~/.gbrain/config.json`, `~/.gbrain/brain.pglite` for the old store, `GBRAIN_*` env vars with env-over-config precedence).
5. Spend gate defaults and the `spend.posture` switch.
6. An upgrade path: `gbrain upgrade --channel stable|alpha`, a verified asset per platform, and a rollback.
7. A reader for the old brain: either a dump from the TypeScript binary (graduation-style, with a plan hash) or a native PGLite data-dir reader. The data dir is Postgres on disk, so a Rust engine cannot read it without a Postgres-compatible reader [I].
8. Doctor output shape (`checks[]` with `name`, `status`, `message`, `details.code`), since automation keys on check names.

## Rust engine implications

Must preserve exactly:
- The one-writer rule. PGLite serves one process and hands off to `serve` (docs/ENGINES.md graduation section). The Rust store should keep one owner with a heartbeat (pglite-lock.ts:12 uses 30 s) and a documented handover.
- Check names and status values that automation reads, and the `version` ledger semantics so the Rust engine can tell which TypeScript schema a brain last saw.
- Spend gate defaults and the ledger rows (`page_embedding_budget`, `decide_spend`, `chat_usage_log`).
- The release identity: the attestation builder id is pinned to this repo's `release.yml` on master (binary-self-update.ts:53 to 58). A Rust engine release needs a new workflow and a new expected id, or a different distribution channel.

What can be simplified:
- No migration ledger beyond a version number. Rust can use its own format and a single version key.
- No advisory locks, LISTEN/NOTIFY, SKIP LOCKED or pooler handling in embedded mode. These account for about 15 to 30 source files each in TypeScript (regex counts: `pg_advisory` 30 files, `LISTEN` 15, `SKIP LOCKED` 15, `FOR UPDATE` 127).
- No WASM boot, no snapshot cache, no checkpoint guard, no `maintenance_work_mem` sizing.
- No `EXPLAIN`-based plan gates, because access paths are fixed. The scale-tier planner gates (Nested Loop inner-loop, planner stats) stop applying.
- No binary download integrity code beyond the SHA-256 check if Rust ships signed artifacts.

Postgres features each piece depends on, and their Rust replacement:
- pgvector HNSW (62 TS files reference hnsw, 3 schema lines): replace with an in-process ANN with filtered search and a bounded-memory build.
- tsvector and `ts_rank`, `pg_trgm`: replace with an inverted index and trigram or n-gram index.
- JSONB (128 schema lines): typed columns or a document blob.
- Triggers (26): explicit application-level writes in one transaction.
- RLS (32 schema lines): application-level read policy (visibility, source grants).
- Recursive CTEs (14 files): graph traversal in code.
- Advisory and row locks, `FOR UPDATE`: single-writer lock plus application-level transactions.
- `pg_stats`, autovacuum: owned statistics maintained by the store.

Risks:
- ANN filtered search. The TS code's biggest documented pain (filters, scope, freshly imported bulk) lives in ANN selectivity. Expect to benchmark and design this before writing code.
- Build time and memory for a 1M to 10M-chunk HNSW. The TS numbers are the baseline to beat: 663 s at 50k (PGLite) and 103 s at 1M (Postgres, 12 GB).
- Import ratio drift (8x last-to-first at 10k). Root cause unknown, so a Rust port may inherit it.
- The CI fixture is 16-dim. Build the Rust benchmark on real 1024 and 1536-dim vectors.
- Moving old brains. Without a reader for the PGLite data dir, users must export through the TypeScript binary first.

## Open questions

1. Which path migrates an existing PGLite brain: a native PGLite data-dir reader, or a dump written by the TypeScript binary (graduation style)?
2. Is the migration statement timeout 600 s (code, src/core/migration-timeout.ts:19) or 30 minutes (CHANGELOG.md:8699, 0.60.365.0)? The code was used here; the discrepancy needs a human decision.
3. Who owns the Linux RSS baseline? `tests/heavy/rss-baseline.json` is still empty, so the Rust port has no memory target from the TS side.
4. What causes the superlinear per-batch growth in the PGLite vector phase (TODOS.md:209) and the 8x import drift (TODOS.md:404)? Both are open.
5. Does the Rust engine keep the multi-process `serve` model (CLI, cron and harness all talking to one owner), or does it move to a single HTTP owner?
6. Should the Rust engine read Postgres brains directly for remote mode, or only export from them? This decides whether the pooler and connection checks survive.
7. Does the distribution go through a new GitHub release workflow with a new attestation identity, and which platforms (Windows is not published today)?
8. The 50k scale tier and the 600k soak are not reproduced here. Does the Rust team need its own 600k-page fixture with real 1024-dim vectors?
