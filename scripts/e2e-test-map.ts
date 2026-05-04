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
  // Source-aware ranking, hybrid search, intent classification.
  "src/core/search/**": [
    "test/e2e/search-quality.test.ts",
    "test/e2e/search-exclude.test.ts",
    "test/e2e/search-swamp.test.ts",
  ],
  // Tree-sitter chunkers feed code-indexing E2E.
  "src/core/chunkers/**": ["test/e2e/code-indexing.test.ts"],
  // dream.ts is a thin alias over runCycle in cycle.ts.
  "src/core/cycle.ts": ["test/e2e/cycle.test.ts", "test/e2e/dream.test.ts"],
  // Multi-source sync writes share the per-source bookmark anchor.
  "src/core/sync.ts": ["test/e2e/sync.test.ts", "test/e2e/multi-source.test.ts"],
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
  ],
  // PGLite bootstrap path + parity guard.
  "src/core/pglite-engine.ts": [
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
  // Upgrade chains migration ledger; touches both runners.
  "src/commands/upgrade.ts": [
    "test/e2e/upgrade.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/migration-flow.test.ts",
  ],
  "src/commands/doctor.ts": ["test/e2e/doctor-progress.test.ts"],
  // Knowledge graph layer feeds graph-quality.
  "src/core/link-extraction.ts": ["test/e2e/graph-quality.test.ts"],
};
