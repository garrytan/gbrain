// scripts/e2e-test-map.ts
//
// Path-glob -> E2E test files map. Used by scripts/select-e2e.ts.
//
// CONTRACT: This map can ONLY narrow from "all". When a changed src/ path
// matches no glob here, the selector falls back to "run all E2E" (fail-closed).
// You can safely add narrowing entries; you cannot break correctness by missing
// one. Tune as misses surface (i.e., when ci:local:diff ran more than necessary
// and you'd like to narrow that surface area).
//
// Glob syntax is the minimal subset implemented in select-e2e.ts:
//   - "**" matches any sequence of path segments (including zero)
//   - "*" matches any characters within a single path segment
//   - everything else is literal
// No brace expansion, no ?, no [ ].

export const E2E_TEST_MAP: Record<string, string[]> = {
  // Serve-delegated sync: wire types, job runner, CLI ladder, and the IPC
  // plumbing all feed the delegation-under-serve E2E.
  "src/core/context/sync-ipc.ts": ["test/e2e/sync-delegation-under-serve.serial.test.ts"],
  "src/core/serve-sync-runner.ts": ["test/e2e/sync-delegation-under-serve.serial.test.ts"],
  "src/commands/sync-delegate.ts": ["test/e2e/sync-delegation-under-serve.serial.test.ts"],
  "src/core/context/resolve-ipc.ts": [
    "test/e2e/bootstrap-hook-under-serve.serial.test.ts",
    "test/e2e/sync-delegation-under-serve.serial.test.ts",
  ],
  // Source-aware ranking, hybrid search, intent classification.
  "src/core/search/**": [
    "test/e2e/search-quality.test.ts",
    "test/e2e/search-exclude.test.ts",
    "test/e2e/search-swamp.test.ts",
  ],
  // Tree-sitter chunkers feed code-indexing E2E.
  "src/core/chunkers/**": ["test/e2e/code-indexing.test.ts"],
  // OpenClaw context-engine plugin: engine + entry feed the plugin-shape E2E
  // (mocked SDK) AND the real-loader Tier 2 E2E that spawns openclaw and
  // actually installs the plugin into an isolated --profile.
  "src/core/context-engine.ts": [
    "test/e2e/openclaw-context-engine-plugin.test.ts",
    "test/e2e/openclaw-plugin-load-real.test.ts",
  ],
  "src/openclaw-context-engine.ts": [
    "test/e2e/openclaw-context-engine-plugin.test.ts",
    "test/e2e/openclaw-plugin-load-real.test.ts",
  ],
  // claw-test harness (command + core: runners, scenarios, seeding, friction
  // merge) feeds the scripted + shim-live E2E. The hermes door
  // (install-real-hermes.serial.test.ts) is deliberately NOT mapped — it is
  // opt-in-gated (GBRAIN_REAL_HERMES_E2E) and self-skips in run-all anyway.
  "src/commands/claw-test.ts": ["test/e2e/claw-test.test.ts"],
  "src/core/claw-test/**": ["test/e2e/claw-test.test.ts"],
  // dream.ts is a thin alias over runCycle in cycle.ts.
  "src/core/cycle.ts": ["test/e2e/cycle.test.ts", "test/e2e/dream.test.ts"],
  // Multi-source sync writes share the per-source bookmark anchor.
  "src/core/sync.ts": ["test/e2e/sync.test.ts", "test/e2e/multi-source.test.ts"],
  // v0.32.8 multi-source bug class regression suite — fires on any cycle
  // phase, extract, integrity, embed, or migrate-engine change.
  "src/core/cycle/extract-takes.ts": ["test/e2e/multi-source-bug-class.test.ts"],
  "src/core/cycle/patterns.ts": ["test/e2e/multi-source-bug-class.test.ts"],
  "src/core/cycle/synthesize.ts": [
    "test/e2e/multi-source-bug-class.test.ts",
    "test/e2e/synthesize-bigint-job-id-postgres.test.ts",
    "test/e2e/dream-synthesize-pglite.test.ts",
  ],
  // The inline drain claims from MinionQueue, so its entry must be a SUPERSET:
  // the drain suite plus the full minions e2e set — a narrower list would
  // reduce coverage vs the fail-closed run-everything default for unmapped paths.
  "src/core/cycle/inline-drain.ts": [
    "test/e2e/dream-synthesize-pglite.test.ts",
    "test/e2e/minions-concurrency.test.ts",
    "test/e2e/minions-resilience.test.ts",
    "test/e2e/minions-shell.test.ts",
    "test/e2e/minions-shell-pglite.test.ts",
    "test/e2e/worker-abort-recovery.test.ts",
  ],
  "src/commands/embed.ts": [
    "test/e2e/multi-source-bug-class.test.ts",
    // #3391: the NULL-signature stale predicates differ per engine.
    "test/e2e/migrate-embeddings-postgres.test.ts",
  ],
  // #3390: runSchemaTransition's DDL path + the stale predicates behave
  // differently on real pgvector than on PGLite.
  "src/core/embedding-migration.ts": ["test/e2e/migrate-embeddings-postgres.test.ts"],
  "src/core/retrieval-upgrade-planner.ts": ["test/e2e/migrate-embeddings-postgres.test.ts"],
  "src/commands/extract.ts": ["test/e2e/multi-source-bug-class.test.ts"],
  "src/commands/migrate-engine.ts": ["test/e2e/multi-source-bug-class.test.ts"],
  // Any minions queue/worker/handler change exercises all minion E2E.
  "src/core/minions/**": [
    "test/e2e/minions-concurrency.test.ts",
    "test/e2e/minions-resilience.test.ts",
    "test/e2e/minions-shell.test.ts",
    "test/e2e/minions-shell-pglite.test.ts",
    "test/e2e/worker-abort-recovery.test.ts",
  ],
  // postgres.js bind paths + JSONB shapes + parity vs PGLite.
  "src/core/postgres-engine.ts": [
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/postgres-jsonb.test.ts",
    "test/e2e/jsonb-roundtrip.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    // #3391: includeNullSignature stale predicates (engine parity).
    "test/e2e/migrate-embeddings-postgres.test.ts",
  ],
  // PGLite bootstrap path + parity guard.
  "src/core/pglite-engine.ts": [
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
  ],
  // Engine method modules peeled from the façades carry the same blast
  // radius as the façades themselves.
  "src/core/postgres-engine/**": [
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/postgres-jsonb.test.ts",
    "test/e2e/jsonb-roundtrip.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/migrate-embeddings-postgres.test.ts",
  ],
  "src/core/pglite-engine/**": [
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
  ],
  // Schema source of truth: any change must pass the cross-engine drift gate.
  "src/schema.sql": ["test/e2e/schema-drift.test.ts"],
  "src/core/pglite-schema.ts": ["test/e2e/schema-drift.test.ts"],
  "src/core/migrate.ts": ["test/e2e/schema-drift.test.ts", "test/e2e/migrate-chain.test.ts"],
  // MCP stdio + HTTP transports share dispatch.
  "src/mcp/**": ["test/e2e/mcp.test.ts", "test/e2e/http-transport.test.ts"],
  // Integrity batch-load fast path.
  "src/commands/integrity.ts": ["test/e2e/integrity-batch.test.ts"],
  // gbrain connect — raw-bearer MCP smoke probe exercised end-to-end against
  // a real serve --http (PGLite), so changes to either feed it.
  "src/commands/connect.ts": ["test/e2e/connect-bearer.test.ts"],
  "src/core/connect-probe.ts": ["test/e2e/connect-bearer.test.ts"],
  // Upgrade chains migration ledger; touches both runners.
  "src/commands/upgrade.ts": [
    "test/e2e/upgrade.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/migration-flow.test.ts",
  ],
  "src/commands/doctor.ts": ["test/e2e/doctor-progress.test.ts"],
  // Doctor check modules peeled from doctor.ts feed the same e2e surface.
  "src/commands/doctor/**": ["test/e2e/doctor-progress.test.ts"],
  // Knowledge graph layer feeds graph-quality.
  "src/core/link-extraction.ts": ["test/e2e/graph-quality.test.ts"],
  // v0.38 ingestion substrate. POST /ingest lives inside serve-http.ts
  // (per the plan-eng-review E1 decision); the daemon + built-in sources
  // + ingest_capture Minion handler all feed the in-process roundtrip
  // E2E AND the HTTP contract E2E for the webhook route.
  "src/commands/serve-http.ts": [
    "test/e2e/serve-http-ingest-webhook.test.ts",
    "test/e2e/serve-http-oauth.test.ts",
  ],
  "src/core/ingestion/**": [
    "test/e2e/ingestion-roundtrip.test.ts",
    "test/e2e/serve-http-ingest-webhook.test.ts",
  ],
  "src/core/minions/handlers/ingest-capture.ts": [
    "test/e2e/ingestion-roundtrip.test.ts",
    "test/e2e/serve-http-ingest-webhook.test.ts",
  ],
};
