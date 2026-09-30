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

const MIGRATION_WAVE_TESTS = [
  "test/e2e/migration-wave-budget-crash.test.ts",
  "test/e2e/migration-wave-healing-fence.test.ts",
  "test/e2e/migration-wave-intermediate-retrieval.test.ts",
  "test/e2e/migration-wave-phase-leases.test.ts",
  "test/e2e/migration-wave-prepared-withdrawal.test.ts",
  "test/e2e/migration-wave-provider-outcomes.test.ts",
];

export const E2E_TEST_MAP: Record<string, string[]> = {
  // SkillOpt orchestrator, outcome/resume, models plan + strict mode, spend ledger.
  "src/core/skillopt/**": [
    "test/e2e/skillopt-loop.serial.test.ts",
    "test/e2e/skillopt-pglite.serial.test.ts",
    "test/e2e/skillopt-outcome.serial.test.ts",
    "test/e2e/skillopt-models-strict.serial.test.ts",
    "test/e2e/skillopt-models-used.serial.test.ts",
    "test/e2e/dream-cycle-phase-order-pglite.test.ts",
  ],
  "src/commands/skillopt.ts": [
    "test/e2e/skillopt-loop.serial.test.ts",
    "test/e2e/skillopt-pglite.serial.test.ts",
    "test/e2e/skillopt-outcome.serial.test.ts",
    "test/e2e/skillopt-models-strict.serial.test.ts",
    "test/e2e/skillopt-models-used.serial.test.ts",
  ],
  "src/commands/export.ts": ["test/e2e/export-snapshot-postgres.test.ts", "test/e2e/memory-safety-wave-postgres.test.ts"],
  "src/core/export-*.ts": ["test/e2e/export-snapshot-postgres.test.ts", "test/e2e/memory-safety-wave-postgres.test.ts"],
  "src/core/company-brain/receipts.ts": ["test/e2e/company-brain-receipts.test.ts"],
  "src/core/company-brain/receipt-schema.ts": ["test/e2e/company-brain-receipts.test.ts"],
  "src/core/minions/errors.ts": ["test/e2e/subagent-gateway-path.test.ts", "test/e2e/delegated-http-worker.test.ts", "test/e2e/subagent-crash-replay-multi-provider.test.ts"],
  "src/core/harness/**": ["test/e2e/harness-access.test.ts", "test/e2e/shared-skills-transports.test.ts"],
  "src/core/shared-skills/**": ["test/e2e/shared-skills-transports.test.ts", "test/e2e/shared-skills-rls.test.ts", "test/e2e/persistence-skill-bundles-postgres.test.ts", "test/e2e/knowledge-source-uri-postgres.test.ts"],
  "src/mcp/skill-resources.ts": ["test/e2e/shared-skills-transports.test.ts"],
  "src/core/scope.ts": ["test/e2e/client-grants.test.ts", "test/e2e/shared-skills-transports.test.ts"],
  "src/core/grants/**": ["test/e2e/client-grants.test.ts", "test/e2e/harness-access.test.ts", "test/e2e/delegated-grants-withdrawal.test.ts", "test/e2e/delegated-http-worker.test.ts"],
  "src/core/facts/withdrawal*.ts": ["test/e2e/delegated-grants-withdrawal.test.ts", "test/e2e/withdrawal-bounded-safety-postgres.test.ts", "test/e2e/withdrawal-crash-postgres.test.ts", "test/e2e/memory-safety-wave-postgres.test.ts", "test/e2e/fact-withdrawal-scope-postgres.test.ts"],
  "src/commands/mcp*.ts": ["test/e2e/harness-access.test.ts"],
  // OpenRouter subagent-loop families: the family allowlist + recipe feed the
  // key-gated live DeepSeek replay (self-skips without OPENROUTER_API_KEY).
  "src/core/ai/openrouter-families.ts": ["test/e2e/openrouter-deepseek-subagent-replay.live.test.ts"],
  "src/core/ai/recipes/openrouter.ts": ["test/e2e/openrouter-deepseek-subagent-replay.live.test.ts"],
  // Serve-delegated sync: wire types, job runner, CLI ladder, and the IPC
  // plumbing all feed the delegation-under-serve E2E.
  "src/core/context/sync-ipc.ts": ["test/e2e/sync-delegation-under-serve.serial.test.ts"],
  "src/core/serve-sync-runner.ts": ["test/e2e/sync-delegation-under-serve.serial.test.ts"],
  "src/commands/sync-delegate.ts": ["test/e2e/sync-delegation-under-serve.serial.test.ts"],
  "src/core/context/resolve-ipc.ts": [
    "test/e2e/sync-delegation-under-serve.serial.test.ts",
  ],
  // Codex session-end capture lane: the hooks writer + hook-lane parser +
  // dispatch seam all feed the real-codex door (heavy lane).
  "src/core/bootstrap/codex-hooks.ts": ["test/e2e/bootstrap-real-codex.serial.test.ts"],
  "src/core/transcripts/codex-hook-lane.ts": ["test/e2e/bootstrap-real-codex.serial.test.ts"],
  "src/core/transcripts/capture-spec.ts": [
    "test/e2e/bootstrap-real-codex.serial.test.ts",
  ],
  // Concrete content and derived-information read policy parity.
  "src/core/remote-body.ts": ["test/e2e/engine-content-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts", "test/e2e/chunk-canonical-text-privacy.test.ts"],
  "src/core/entity-identity.ts": ["test/e2e/engine-content-privacy.test.ts"],
  "src/core/ops/**": ["test/e2e/engine-content-privacy.test.ts", "test/e2e/read-enrichment-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts", "test/e2e/chunk-canonical-text-privacy.test.ts", "test/e2e/put-page-persistence-postgres.test.ts", "test/e2e/deep-research-source-id.test.ts", "test/e2e/deep-research-http.test.ts", "test/e2e/derived-page-visibility.test.ts"],
  "src/commands/whoknows.ts": ["test/e2e/read-enrichment-privacy.test.ts"],
  "src/commands/orphans.ts": ["test/e2e/engine-content-privacy.test.ts"],
  // Source-aware ranking, hybrid search, intent classification.
  "src/core/search/private-visibility.ts": ["test/e2e/derived-page-visibility.test.ts", "test/e2e/derived-visibility-repair.test.ts"],
  "src/core/search/**": [
    "test/e2e/unsupported-embedding-identity-postgres.test.ts",
    "test/e2e/projection-statistics-postgres.test.ts",
    "test/e2e/search-query-contract-postgres.test.ts",
    "test/e2e/vector-candidate-safety-postgres.test.ts",
    "test/e2e/projection-readiness-currency.test.ts",
    "test/e2e/chunk-canonical-text-privacy.test.ts",
    "test/e2e/engine-content-privacy.test.ts",
    "test/e2e/read-enrichment-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts",
    "test/e2e/search-quality.test.ts",
    "test/e2e/search-exclude.test.ts",
    "test/e2e/search-swamp.test.ts",
  ],
  "src/core/page-state/**": ["test/e2e/projection-recovery-parity.test.ts", "test/e2e/projection-readiness-currency.test.ts", "test/e2e/projection-embedding-input-hash.test.ts", "test/e2e/safe-chunk-reseal.test.ts", ...MIGRATION_WAVE_TESTS],
  "src/core/embedding-input-hash.ts": ["test/e2e/projection-embedding-input-hash.test.ts"],
  // Evidence delivery (return_unit): the release-gate leak canaries and the
  // engine / product-path parity suite.
  "src/core/search/evidence-delivery.ts": ["test/e2e/evidence-delivery-leak.test.ts", "test/e2e/evidence-delivery-parity.test.ts"],
  "src/core/search/chunk-windows.ts": ["test/e2e/evidence-delivery-leak.test.ts", "test/e2e/evidence-delivery-parity.test.ts"],
  "src/core/search/safe-chunks.ts": ["test/e2e/safe-chunk-reseal.test.ts", "test/e2e/legacy-chunk-privacy.test.ts"],
  "src/core/code-chunks.ts": ["test/e2e/projection-recovery-parity.test.ts"],
  "src/core/markdown-chunks.ts": ["test/e2e/projection-recovery-parity.test.ts"],
  // Tree-sitter chunkers feed code-indexing E2E.
  "src/core/chunkers/**": ["test/e2e/code-indexing.test.ts", "test/e2e/legacy-chunk-privacy.test.ts", "test/e2e/chunk-canonical-text-privacy.test.ts"],
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
  // dream.ts is a thin alias over runCycle in cycle.ts.
  "src/core/cycle.ts": ["test/e2e/cycle.test.ts", "test/e2e/dream.test.ts", "test/e2e/managed-phase-matrix.test.ts"],
  "src/core/cycle/phase-*.ts": ["test/e2e/managed-phase-matrix.test.ts"],
  // Multi-source sync writes share the per-source bookmark anchor.
  "src/core/sync.ts": ["test/e2e/sync.test.ts", "test/e2e/multi-source.test.ts", "test/e2e/sync-reconcile-postgres.test.ts", "test/e2e/sync-lock-overlap-postgres.test.ts"],
  // F7: real SIGKILL mid-sync on live Postgres — checkpoint banking
  // (op_checkpoint_paths), the frozen last_commit bookmark, stranded-lock
  // reclaim via TTL + steal grace, and exactly-once convergence on resume.
  // The peeled sync-* core modules (anchor/lock/reconcile/delta/git/…) all
  // feed that kill/resume journey.
  // Refactor wave 1 (W4 sync): parallel-worker completion under abort over
  // the concurrency clamp and stall/abort composition (sync-concurrency,
  // sync-reconcile). src/commands/sync/** stays unmapped (runs all E2E).
  "src/core/sync-*.ts": ["test/e2e/sync-sigkill-resume-postgres.test.ts", "test/e2e/sync-lock-overlap-postgres.test.ts", "test/e2e/sync-run-workers-postgres.test.ts"],
  // v0.32.8 multi-source bug class regression suite — fires on any cycle
  // phase, extract, integrity, embed, or migrate-engine change.
  "src/core/cycle/extract-takes.ts": ["test/e2e/multi-source-bug-class.test.ts"],
  // Takes write-op layer (fence-first write + page-lock journey on real PG).
  "src/core/ops/takes.ts": ["test/e2e/takes-write-ops-postgres.test.ts"],
  "src/core/takes-write.ts": ["test/e2e/takes-write-ops-postgres.test.ts"],
  // JSONB bind parity for the cycle writers (the #2339 class PGLite hides).
  "src/core/cycle/propose-takes.ts": ["test/e2e/propose-takes-jsonb-postgres.test.ts"],
  "src/core/cycle/calibration-profile.ts": ["test/e2e/calibration-profile-write.test.ts"],
  "src/core/cycle/patterns.ts": ["test/e2e/multi-source-bug-class.test.ts", "test/e2e/dream-breaker-postgres.test.ts"],
  // Dream paid-loop breaker: released-key JSONB shape + counter + migration 173 on Postgres.
  "src/core/cycle/dream-breaker.ts": ["test/e2e/dream-breaker-postgres.test.ts"],
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
    "test/e2e/minions-authority-parity.test.ts",
    "test/e2e/minions-concurrency.test.ts",
    "test/e2e/minions-resilience.test.ts",
    "test/e2e/minions-shell.test.ts",
    "test/e2e/minions-shell-pglite.test.ts",
    "test/e2e/worker-abort-recovery.test.ts",
  ],
  "src/commands/embed.ts": [
    ...MIGRATION_WAVE_TESTS,
    "test/e2e/multi-source-bug-class.test.ts",
    // #3391: the NULL-signature stale predicates differ per engine.
    "test/e2e/migrate-embeddings-postgres.test.ts",
  ],
  // #3390: runSchemaTransition's DDL path + the stale predicates behave
  // differently on real pgvector than on PGLite.
  "src/core/embedding-migration*.ts": ["test/e2e/migrate-embeddings-postgres.test.ts", "test/e2e/embedding-recovery-parity.test.ts", "test/e2e/memory-safety-wave-postgres.test.ts", "test/e2e/embedding-migration-settle-postgres.test.ts", ...MIGRATION_WAVE_TESTS],
  // #5680: the per-request ceilings the migration reserves and settles under FOR UPDATE.
  "src/core/ai/embed-batch-plan.ts": ["test/e2e/embedding-migration-settle-postgres.test.ts"],
  "src/core/embedding-readiness.ts": ["test/e2e/embedding-recovery-parity.test.ts"],
  "src/core/facts/embedding-identity.ts": ["test/e2e/embedding-recovery-parity.test.ts", "test/e2e/fact-embedding-backfill-parity.test.ts"],
  "src/core/stored-embedding-identity.ts": ["test/e2e/unsupported-embedding-identity-postgres.test.ts"],
  "src/commands/extract.ts": ["test/e2e/multi-source-bug-class.test.ts", "test/e2e/attendance-retrieval-postgres.test.ts", "test/e2e/extract-timeline-attendance-postgres.test.ts", "test/e2e/w5-persistence-postgres.test.ts", "test/e2e/managed-phase-matrix.test.ts"],
  "src/commands/lint.ts": ["test/e2e/managed-phase-matrix.test.ts"],
  "src/commands/extract-attendance-repair.ts": ["test/e2e/attendance-repair-postgres.test.ts"],
  "src/commands/migrate-engine.ts": [
    "test/e2e/multi-source-bug-class.test.ts",
    "test/e2e/migrate-engine-pglite-to-postgres.test.ts",
  ],
  // Any minions queue/worker/handler change exercises all minion E2E.
  "src/core/minions/**": [
    "test/e2e/worker-readiness-cli.test.ts",
    "test/e2e/worker-configuration-release.test.ts",
    "test/e2e/delegated-grants-withdrawal.test.ts",
    "test/e2e/delegated-http-worker.test.ts",
    "test/e2e/minions-concurrency.test.ts",
    "test/e2e/minions-resilience.test.ts",
    "test/e2e/minions-shell.test.ts",
    "test/e2e/minions-shell-pglite.test.ts",
    "test/e2e/worker-abort-recovery.test.ts",
    "test/e2e/connector-sync-handler-pglite.test.ts",
  ],
  // v0.46.31.0 chat-connectors wave (mapped at the test-gap-wave merge —
  // these arrived unclaimed): connector classify/sync core + doctor check.
  "src/core/connectors/**": [
    "test/e2e/connector-sync-handler-pglite.test.ts",
    "test/e2e/connectors-sync-checkpoints-pglite.test.ts",
    "test/e2e/connectors-ingest-failure-pglite.test.ts",
    "test/e2e/connectors-sync-pglite.test.ts",
    "test/e2e/doctor-connectors-pglite.test.ts",
  ],
  // C-19: timestamp-less sessions are reported skips, not watermark-freezing errors.
  "src/core/transcripts/ingest.ts": ["test/e2e/transcripts-no-timestamp-pglite.test.ts"],
  // Agent-job scope fences over real Postgres.
  "src/core/ops/jobs.ts": ["test/e2e/jobs-agent-scope-postgres.test.ts", "test/e2e/delegated-grants-withdrawal.test.ts", "test/e2e/delegated-http-worker.test.ts"],
  // postgres.js bind paths + JSONB shapes + parity vs PGLite.
  "src/core/db-lock.ts": ["test/e2e/db-lock-acquisition-token.test.ts", "test/e2e/sync-lock-overlap-postgres.test.ts", "test/e2e/managed-connector-fencing.test.ts", "test/e2e/managed-connector-recovery.test.ts"],
  "src/core/lease-schema.ts": ["test/e2e/db-lock-acquisition-token.test.ts"],
  "src/core/persistence/**": [
    "test/e2e/fix-wave-3-integration.test.ts",
    "test/e2e/persistence-http-liveness.test.ts",
    "test/e2e/persistence-phase-liveness.test.ts",
    "test/e2e/persistence-idle-pool.test.ts",
    "test/e2e/persistence-publication-parity.test.ts",
    "test/e2e/persistence-sync-origin-parity.test.ts",
    "test/e2e/persistence-sync-options-parity.test.ts",
    "test/e2e/persistence-sync-company-parity.test.ts",
    "test/e2e/persistence-chaos.test.ts",
    "test/e2e/persistence-runtime-matrix.test.ts",
    "test/e2e/persistence-admin-intent.test.ts",
    "test/e2e/persistence-writer-admin-lock.test.ts",
    "test/e2e/persistence-writer-stamps.test.ts",
    "test/e2e/persistence-recovery.test.ts",
    "test/e2e/managed-sync-failures.test.ts",
    "test/e2e/managed-connector-routing.test.ts",
    "test/e2e/managed-connector-retry.test.ts",
    "test/e2e/managed-connector-fencing.test.ts",
    "test/e2e/managed-connector-recovery.test.ts",
    "test/e2e/managed-facts-backstop.test.ts",
    "test/e2e/managed-facts-embedding.test.ts",
    "test/e2e/managed-facts-compaction.test.ts",
    "test/e2e/facts-worker-config.test.ts",
    "test/e2e/managed-extract-atoms.test.ts",
    "test/e2e/managed-atom-regressions.test.ts",
    "test/e2e/managed-atom-compaction.test.ts",
    "test/e2e/managed-maintenance.test.ts",
    "test/e2e/managed-writers-w3.test.ts",
    "test/e2e/managed-facts-writers.test.ts",
    "test/e2e/unbound-source-postgres.test.ts",
    "test/e2e/managed-phase-matrix.test.ts",
    "test/e2e/managed-synthesis-postprocess.test.ts",
    "test/e2e/persistence-embedding-effects.test.ts",
    "test/e2e/withdrawal-bounded-safety-postgres.test.ts",
    "test/e2e/withdrawal-crash-postgres.test.ts",
    "test/e2e/memory-safety-wave-postgres.test.ts",
    "test/e2e/reconcile-crash.test.ts",
    "test/e2e/reconcile-crash-unactivated.test.ts",
    "test/e2e/reconcile-pgbouncer.test.ts",
    "test/e2e/reconcile-unbound-collision.test.ts",
    "test/e2e/persistence-skill-bundles-postgres.test.ts",
    "test/e2e/shared-skills-transports.test.ts",
    "test/e2e/canonical-projection-history.test.ts",
    "test/e2e/derived-page-visibility.test.ts",
    "test/e2e/timeline-materialize.test.ts",
    "test/e2e/derived-visibility-repair.test.ts",
    "test/e2e/repair-command.test.ts",
    "test/e2e/w5-persistence-postgres.test.ts",
  ],
  "src/core/brain-score-recommendations.ts": ["test/e2e/w5-persistence-postgres.test.ts"],
  "src/core/repair/**": ["test/e2e/repair-command.test.ts", "test/e2e/derived-visibility-repair.test.ts", "test/e2e/safe-chunk-reseal.test.ts", "test/e2e/recovery-layer.test.ts", "test/e2e/repair-contextual-mode-5621-postgres.test.ts", "test/e2e/fix-wave-3-integration.test.ts"],
  "src/core/remediation/**": ["test/e2e/recovery-layer.test.ts"],
  "src/core/remediation-checkpoint.ts": ["test/e2e/recovery-layer.test.ts"],
  "src/commands/repair.ts": ["test/e2e/repair-command.test.ts", "test/e2e/repair-contextual-mode-5621-postgres.test.ts"],
  "src/core/import-contextual-mode.ts": ["test/e2e/repair-contextual-mode-5621-postgres.test.ts"],
  "src/core/ai/embedding-guard.ts": ["test/e2e/embedding-zero-norm-4616-postgres.test.ts"],
  "src/commands/reindex-vectors.ts": ["test/e2e/embedding-zero-norm-4616-postgres.test.ts"],
  "src/core/embedding-invalidation.ts": ["test/e2e/embed-stale-dry-run-restamp-5289-postgres.test.ts"],
  "src/core/persistence/effect-git.ts": ["test/e2e/persistence-git-coalescing-5530-postgres.test.ts"],
  "src/core/persistence/effect-journal.ts": ["test/e2e/persistence-git-coalescing-5530-postgres.test.ts"],
  "src/core/persistence/grandfather.ts": ["test/e2e/persistence-git-coalescing-5530-postgres.test.ts", "test/e2e/grandfather-projection-postgres.test.ts"],
  "src/core/timeline-marker.ts": ["test/e2e/timeline-materialize.test.ts"],
  "src/commands/source-reconcile.ts": ["test/e2e/reconcile-crash.test.ts", "test/e2e/reconcile-crash-unactivated.test.ts", "test/e2e/reconcile-pgbouncer.test.ts"],
  "src/core/cycle/extract-atoms.ts": ["test/e2e/extract-atoms-page-state.test.ts", "test/e2e/cycle.test.ts", "test/e2e/dream.test.ts", "test/e2e/multi-source-bug-class.test.ts", "test/e2e/managed-extract-atoms.test.ts", "test/e2e/managed-atom-regressions.test.ts", "test/e2e/managed-atom-compaction.test.ts"],
  "src/core/cycle/synthesize*.ts": ["test/e2e/managed-maintenance.test.ts", "test/e2e/managed-synthesis-postprocess.test.ts", "test/e2e/managed-writers-w3.test.ts"],
  "src/core/cycle/concept-publication.ts": ["test/e2e/managed-writers-w3.test.ts"],
  "src/core/chronicle/extract-events.ts": ["test/e2e/managed-writers-w3.test.ts"],
  "src/commands/enrich.ts": ["test/e2e/managed-writers-w3.test.ts"],
  "src/core/ops/links.ts": ["test/e2e/managed-writers-w3.test.ts"],
  "src/core/cycle/extract-atoms-page-state.ts": ["test/e2e/extract-atoms-page-state.test.ts", "test/e2e/reconcile-crash.test.ts", "test/e2e/reconcile-crash-unactivated.test.ts", "test/e2e/reconcile-pgbouncer.test.ts"],
  "src/commands/migrations/v0_13_1.ts": ["test/e2e/grandfather-projection-postgres.test.ts", "test/e2e/persistence-git-coalescing-5530-postgres.test.ts"],
  "src/core/pool-budget.ts": ["test/e2e/persistence-runtime-matrix.test.ts"],
  "src/core/connection-manager.ts": ["test/e2e/persistence-runtime-matrix.test.ts", "test/e2e/pgbouncer-teardown.test.ts"],
  "src/core/postgres-engine.ts": [
    "test/e2e/executor-binding-matrix.test.ts",
    ...MIGRATION_WAVE_TESTS,
    "test/e2e/legacy-vector-compatibility-postgres.test.ts",
    "test/e2e/postgres-driver-install.test.ts",
    "test/e2e/unsupported-embedding-identity-postgres.test.ts",
    "test/e2e/fixture-reset-postgres.test.ts",
    "test/e2e/persistence-chaos.test.ts",
    "test/e2e/db-lock-acquisition-token.test.ts",
    "test/e2e/chunk-canonical-text-privacy.test.ts",
    "test/e2e/engine-content-privacy.test.ts",
    "test/e2e/read-enrichment-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts",
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/postgres-jsonb.test.ts",
    "test/e2e/jsonb-roundtrip.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/schema-catalog-golden.test.ts",
    // #3391: includeNullSignature stale predicates (engine parity).
    "test/e2e/migrate-embeddings-postgres.test.ts",
    // getHealth islanded-liveness + entity-coverage floor (#4153/#4147).
    "test/e2e/health-parity-postgres.test.ts",
    // #4109: FOR KEY SHARE deletion-race behavior of addLink/addTimelineEntry.
    "test/e2e/source-boundary-mutation-postgres.test.ts",
    // Shared-singleton ownership: disconnect idempotency, shared-pool
    // recovery and reconnect under a live singleton.
    "test/e2e/postgres-engine-disconnect-idempotency.test.ts",
    "test/e2e/db-singleton-shared-recovery.test.ts",
    "test/e2e/postgres-reconnect-singleton.test.ts",
  ],
  // PGLite bootstrap path + parity guard.
  "src/core/pglite-engine.ts": [
    "test/e2e/executor-binding-matrix.test.ts",
    ...MIGRATION_WAVE_TESTS,
    "test/e2e/legacy-vector-compatibility-postgres.test.ts",
    "test/e2e/unsupported-embedding-identity-postgres.test.ts",
    "test/e2e/persistence-chaos.test.ts",
    "test/e2e/chunk-canonical-text-privacy.test.ts",
    "test/e2e/engine-content-privacy.test.ts",
    "test/e2e/read-enrichment-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts",
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/schema-catalog-golden.test.ts",
    "test/e2e/health-parity-postgres.test.ts",
  ],
  // Engine method modules peeled from the façades carry the same blast
  // radius as the façades themselves.
  "src/core/postgres-engine/**": [
    "test/e2e/executor-binding-matrix.test.ts",
    "test/e2e/unsupported-embedding-identity-postgres.test.ts",
    "test/e2e/chunk-canonical-text-privacy.test.ts",
    "test/e2e/engine-content-privacy.test.ts",
    "test/e2e/read-enrichment-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts",
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/postgres-jsonb.test.ts",
    "test/e2e/jsonb-roundtrip.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/schema-catalog-golden.test.ts",
    "test/e2e/migrate-embeddings-postgres.test.ts",
    "test/e2e/health-parity-postgres.test.ts",
    "test/e2e/source-boundary-mutation-postgres.test.ts",
  ],
  "src/core/pglite-engine/**": [
    "test/e2e/executor-binding-matrix.test.ts",
    "test/e2e/unsupported-embedding-identity-postgres.test.ts",
    "test/e2e/chunk-canonical-text-privacy.test.ts",
    "test/e2e/engine-content-privacy.test.ts",
    "test/e2e/read-enrichment-privacy.test.ts", "test/e2e/legacy-chunk-privacy.test.ts",
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/health-parity-postgres.test.ts",
    // master's own remote-privacy sweep suite for the scoped salience arms
    // (mapped at the test-gap-wave merge — arrived unclaimed).
    "test/e2e/salience-anomalies-source-isolation-pglite.test.ts",
  ],
  // Both engines route CJK queries through the shared branch since #3986
  // (src/core/search/cjk-keyword-sql.ts). The cross-engine parity is pinned — any change here must re-run the pin. (Matches
  // src/core/engine-sql/** too; selector unions the entries.)
  "src/core/engine-sql/cjk-search.ts": ["test/e2e/engine-parity-cjk.test.ts"],
  // D7 parity batch: the code-edge read paths (getCallersOf / getCalleesOf /
  // getEdgesByChunk) live in engine-sql/code-edges.ts (PGLite's getEdgesByChunk
  // stays in its engine module dir); both key the cross-engine read-parity
  // suite directly. (The ** globs match these files too; the selector unions
  // the entries.)
  "src/core/engine-sql/code-edges.ts": ["test/e2e/code-edges-read-parity.test.ts"],
  "src/core/pglite-engine/code-edges.ts": ["test/e2e/code-edges-read-parity.test.ts"],
  // D7 parity batch: chronicle ontology merge (mergeOntologyFact helpers in
  // chronicle/ontology.ts) + event projection (only production caller:
  // chronicle/extract-events.ts) and their op surface run against BOTH
  // engines; a change to any of them re-runs the parity pins.
  "src/core/chronicle/**": [
    "test/e2e/ontology-merge-parity.test.ts",
    "test/e2e/chronicle-event-projection-parity.test.ts",
  ],
  "src/core/ops/chronicle.ts": [
    "test/e2e/ontology-merge-parity.test.ts",
    "test/e2e/chronicle-event-projection-parity.test.ts",
  ],
  // Schema source of truth: any change must pass the cross-engine drift gate.
  "src/schema.sql": ["test/e2e/schema-drift.test.ts", "test/e2e/schema-catalog-golden.test.ts"],
  "src/core/pglite-schema.ts": ["test/e2e/schema-drift.test.ts", "test/e2e/schema-catalog-golden.test.ts"],
  "src/core/pglite-schema.generated.ts": ["test/e2e/schema-drift.test.ts", "test/e2e/schema-catalog-golden.test.ts"],
  "src/core/migrate.ts": [
    "test/e2e/migration-vector-replay-postgres.test.ts",
    "test/e2e/schema-drift.test.ts",
    // Refactor wave 1 E4: catalog-level goldens (both engines, both init paths).
    "test/e2e/schema-catalog-golden.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/link-source-check-repair-postgres.test.ts",
    // Refactor wave 1 W3: replay the split registry from checkpoints.
    "test/e2e/schema-migrations-replay.test.ts",
  ],
  "src/core/schema-migrations/**": [
    "test/e2e/migration-vector-replay-postgres.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/schema-catalog-golden.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/schema-migrations-replay.test.ts",
  ],
  // #4613: the links_link_source_check self-heal must use migration v114's
  // two-phase DDL (DROP + ADD NOT VALID, then VALIDATE outside the txn) on real
  // Postgres — lock semantics PGLite can't observe. Keyed on the repair module
  // and on migrate.ts (the definition it reproduces).
  "src/core/link-source-check-repair.ts": ["test/e2e/link-source-check-repair-postgres.test.ts"],
  "src/core/vector-index.ts": ["test/e2e/migration-vector-replay-postgres.test.ts"],
  // MCP stdio + HTTP transports share dispatch.
  "src/mcp/**": ["test/e2e/http-transport.test.ts", "test/e2e/mcp-search-transport-matrix.test.ts"],
  // Integrity batch-load fast path.
  "src/commands/integrity.ts": ["test/e2e/integrity-batch.test.ts"],
  // Upgrade chains migration ledger; touches both runners. The bun-link arc
  // is pinned by test/upgrade-bun-link-arc.serial.test.ts (serial lane).
  "src/commands/upgrade.ts": [
    "test/e2e/upgrade.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/migration-flow.test.ts",
  ],
  "src/commands/apply-migrations.ts": [
    "test/e2e/migration-preview-safety.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/migration-flow.test.ts",
  ],
  "src/commands/migrations/**": [
    "test/e2e/migration-preview-safety.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/migration-flow.test.ts",
  ],
  // Autopilot linux install/uninstall lifecycle (PATH-shimmed crontab +
  // systemctl; the ubuntu CI runner's only behavioral pin on those arms).
  "src/commands/autopilot.ts": ["test/e2e/autopilot-linux-lifecycle.serial.test.ts", "test/e2e/worker-readiness-cli.test.ts"],
  "src/commands/autopilot-daemon.ts": ["test/e2e/autopilot-linux-lifecycle.serial.test.ts", "test/e2e/worker-readiness-cli.test.ts"],
  "src/commands/autopilot-dispatch.ts": ["test/e2e/autopilot-linux-lifecycle.serial.test.ts", "test/e2e/worker-readiness-cli.test.ts"],
  "src/commands/autopilot-probes.ts": ["test/e2e/autopilot-linux-lifecycle.serial.test.ts", "test/e2e/worker-readiness-cli.test.ts"],
  "src/commands/doctor.ts": ["test/e2e/doctor-progress.test.ts", "test/e2e/doctor-json-golden.test.ts"],
  // Doctor check modules peeled from doctor.ts feed the same e2e surface.
  "src/commands/doctor/**": ["test/e2e/doctor-progress.test.ts", "test/e2e/recovery-layer.test.ts", "test/e2e/fix-wave-3-integration.test.ts", "test/e2e/doctor-json-golden.test.ts"],
  // Knowledge graph layer feeds graph-quality.
  "src/core/link-extraction.ts": ["test/e2e/graph-quality.test.ts", "test/e2e/attendance-retrieval-postgres.test.ts"],
  "src/core/attendance-repair.ts": ["test/e2e/attendance-repair-postgres.test.ts"],
  "src/core/extract-timeline-from-meetings.ts": ["test/e2e/extract-timeline-attendance-postgres.test.ts"],
  "src/core/derived-links.ts": ["test/e2e/attendance-retrieval-postgres.test.ts", "test/e2e/attendance-repair-postgres.test.ts"],
  "src/core/link-reconciliation.ts": ["test/e2e/attendance-retrieval-postgres.test.ts"],
  "src/core/persistence/links-preparation.ts": ["test/e2e/attendance-retrieval-postgres.test.ts"],
  "src/core/sweep.ts": ["test/e2e/attendance-retrieval-postgres.test.ts"],
  // v0.38 ingestion substrate. POST /ingest lives inside serve-http.ts
  // (per the plan-eng-review E1 decision); the daemon + built-in sources
  // + ingest_capture Minion handler all feed the in-process roundtrip
  // E2E AND the HTTP contract E2E for the webhook route.
  "src/core/oauth-provider.ts": ["test/e2e/oauth-grant-transactions.test.ts", "test/e2e/serve-http-oauth.test.ts"],
  "src/core/oauth-grants.ts": ["test/e2e/oauth-grant-transactions.test.ts", "test/e2e/serve-http-consent.test.ts"],
  "src/core/grants/lifecycle.ts": ["test/e2e/oauth-grant-transactions.test.ts", "test/e2e/serve-http-consent.test.ts"],
  "src/commands/serve-http-clients.ts": ["test/e2e/serve-http-consent.test.ts"],
  "src/commands/serve-http-grants.ts": ["test/e2e/serve-http-consent.test.ts", "test/e2e/serve-http-source-grant.test.ts"],
  "src/commands/serve-http-registration.ts": ["test/e2e/serve-http-consent.test.ts"],
  "src/commands/serve-http-admin-limits.ts": ["test/e2e/serve-http-consent.test.ts"],
  "src/core/harness/client-setup.ts": ["test/e2e/serve-http-consent.test.ts"],
  "src/commands/serve-http-oauth.ts": ["test/e2e/serve-http-consent.test.ts", "test/e2e/serve-http-oauth.test.ts"],
  // Refactor wave 1 split runServeHttp into these modules; each keeps the
  // façade's e2e claims for the code it took.
  "src/commands/serve-http-admin-api.ts": ["test/e2e/serve-http-consent.test.ts", "test/e2e/serve-http-oauth.test.ts"],
  "src/commands/serve-http-metrics.ts": ["test/e2e/serve-http-oauth.test.ts"],
  "src/commands/serve-http-spa.ts": ["test/e2e/serve-http-consent.test.ts"],
  "src/commands/serve-http-webhooks.ts": ["test/e2e/serve-http-ingest-webhook.test.ts"],
  "src/commands/serve-http-mcp.ts": [
    "test/e2e/serve-http-oauth.test.ts",
    "test/e2e/harness-access.test.ts",
    "test/e2e/serve-http-source-grant.test.ts",
  ],
  "src/commands/serve-http.ts": [
    "test/e2e/serve-http-consent.test.ts",
    "test/e2e/serve-http-ingest-webhook.test.ts",
    "test/e2e/serve-http-oauth.test.ts",
    "test/e2e/harness-access.test.ts",
    // #3242 wiring: legacy no-grant federated widening vs granted confinement
    // over the SDK /mcp transport (verifyAccessToken → noGrantFederatedScope
    // → OperationContext.localFederatedSourceIds).
    "test/e2e/serve-http-source-grant.test.ts",
  ],
  "src/core/ingestion/**": [
    "test/e2e/ingestion-roundtrip.test.ts",
    "test/e2e/serve-http-ingest-webhook.test.ts",
  ],
  "src/core/minions/handlers/ingest-capture.ts": [
    "test/e2e/ingestion-roundtrip.test.ts",
    "test/e2e/serve-http-ingest-webhook.test.ts",
  ],
  "src/core/embed-facts*.ts": ["test/e2e/fact-embedding-backfill-parity.test.ts"],
  "src/core/cycle/extract-facts.ts": ["test/e2e/fact-vector-repair-parity.test.ts", "test/e2e/facts-fence-reconcile-postgres.test.ts"],
  "src/core/cycle/phases/consolidate.ts": ["test/e2e/managed-maintenance.test.ts", "test/e2e/cycle.test.ts"],
  "src/core/ops/facts.ts": ["test/e2e/managed-facts-backstop.test.ts"],
  "src/core/facts/backstop.ts": ["test/e2e/managed-facts-backstop.test.ts", "test/e2e/facts-worker-config.test.ts", "test/e2e/managed-facts-embedding.test.ts", "test/e2e/managed-facts-compaction.test.ts", "test/e2e/legacy-fact-extraction-dedup-postgres.test.ts"],
  "src/core/facts/extract.ts": ["test/e2e/managed-facts-embedding.test.ts"],
  "src/core/github-source.ts": ["test/e2e/managed-connector-routing.test.ts", "test/e2e/managed-connector-retry.test.ts", "test/e2e/managed-connector-fencing.test.ts", "test/e2e/managed-connector-recovery.test.ts"],
  "src/core/google/google-source.ts": ["test/e2e/managed-connector-routing.test.ts", "test/e2e/managed-connector-retry.test.ts", "test/e2e/managed-connector-fencing.test.ts", "test/e2e/managed-connector-recovery.test.ts", "test/e2e/google-attachments-postgres.test.ts"],
  "src/core/google/attachment-receipts.ts": ["test/e2e/google-attachments-postgres.test.ts"],
  "src/core/google/attachment-backfill.ts": ["test/e2e/google-attachments-postgres.test.ts"],
  "src/core/persistence/connector-google-receipts.ts": ["test/e2e/google-attachments-postgres.test.ts"],
  // Fix wave 3 lane A: connector identity, account pin, no-op kernel, pending set and migration 176.
  "src/core/persistence/connector-sync.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-identity.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-state.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-account.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-errors.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-status.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-reset.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/connector-checkpoint-migration.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/noop-kernel.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/import-mutations.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/sync-run.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/sync-prepare.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/core/persistence/accepted-pending.ts": ["test/e2e/connector-wave3.test.ts"],
  "src/commands/google-attachments.ts": ["test/e2e/google-attachments-postgres.test.ts"],
  "src/core/backup/**": ["test/e2e/backup-coverage-parity.test.ts"],
  "src/commands/backup.ts": ["test/e2e/backup-coverage-parity.test.ts"],
  "src/commands/doctor/checks/backup-coverage.ts": ["test/e2e/backup-coverage-parity.test.ts"],
  "src/commands/doctor/checks/sync-failures.ts": ["test/e2e/managed-sync-failures.test.ts"],
  "src/commands/doctor/checks/writer-version.ts": ["test/e2e/persistence-writer-stamps.test.ts"],
  // E5 executor binding matrix: master's executor path is engine.executeRaw
  // over sql-query.ts's scalar contract (refactor wave 1, EO20).
  "src/core/sql-query.ts": ["test/e2e/executor-binding-matrix.test.ts"],
};

// Refactor wave 1: src/core/engine-sql/ holds SQL shared by BOTH engines, so a
// change there re-runs every E2E file either engine's façade or module dir
// selects (plus the E5 binding matrix, already in those rows).
E2E_TEST_MAP["src/core/engine-sql/**"] = [
  ...new Set(
    [
      "src/core/postgres-engine.ts",
      "src/core/pglite-engine.ts",
      "src/core/postgres-engine/**",
      "src/core/pglite-engine/**",
    ].flatMap((key) => E2E_TEST_MAP[key] ?? []),
  ),
];

// Executor-contract E2E files (both backends) claimed by the module they pin.
const ENGINE_SQL_EXECUTOR_E2E = [
  "test/e2e/engine-sql-prepare-parity.test.ts",
  "test/e2e/engine-sql-capabilities-parity.test.ts",
  "test/e2e/engine-sql-transaction-parity.test.ts",
];
E2E_TEST_MAP["src/core/engine-sql/executor.ts"] = ENGINE_SQL_EXECUTOR_E2E;
E2E_TEST_MAP["src/core/engine-sql/dialect-*.ts"] = ENGINE_SQL_EXECUTOR_E2E;
E2E_TEST_MAP["src/core/engine-sql/normalize.ts"] = ["test/e2e/engine-sql-normalize-parity.test.ts"];
E2E_TEST_MAP["src/core/engine-sql/brands.ts"] = ["test/e2e/engine-sql-rls-scope.test.ts"];
E2E_TEST_MAP["src/core/engine-sql/chunks.ts"] = ["test/e2e/evidence-delivery-leak.test.ts", "test/e2e/evidence-delivery-parity.test.ts"];
