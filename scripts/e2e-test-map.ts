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
  // Codex session-end capture lane: the hooks writer + hook-lane parser +
  // dispatch seam all feed the real-codex door (heavy lane).
  "src/core/bootstrap/codex-hooks.ts": ["test/e2e/bootstrap-real-codex.serial.test.ts"],
  "src/core/transcripts/codex-hook-lane.ts": ["test/e2e/bootstrap-real-codex.serial.test.ts"],
  "src/core/transcripts/capture-spec.ts": [
    "test/e2e/bootstrap-hook-under-serve.serial.test.ts",
    "test/e2e/bootstrap-real-codex.serial.test.ts",
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
  "src/core/sync.ts": ["test/e2e/sync.test.ts", "test/e2e/multi-source.test.ts", "test/e2e/sync-reconcile-postgres.test.ts"],
  // F7: real SIGKILL mid-sync on live Postgres — checkpoint banking
  // (op_checkpoint_paths), the frozen last_commit bookmark, stranded-lock
  // reclaim via TTL + steal grace, and exactly-once convergence on resume.
  // The peeled sync-* core modules (anchor/lock/reconcile/delta/git/…) all
  // feed that kill/resume journey.
  "src/core/sync-*.ts": ["test/e2e/sync-sigkill-resume-postgres.test.ts"],
  // v0.32.8 multi-source bug class regression suite — fires on any cycle
  // phase, extract, integrity, embed, or migrate-engine change.
  "src/core/cycle/extract-takes.ts": ["test/e2e/multi-source-bug-class.test.ts"],
  // Takes write-op layer (fence-first write + page-lock journey on real PG).
  "src/core/ops/takes.ts": ["test/e2e/takes-write-ops-postgres.test.ts"],
  "src/core/takes-write.ts": ["test/e2e/takes-write-ops-postgres.test.ts"],
  // JSONB bind parity for the cycle writers (the #2339 class PGLite hides).
  "src/core/cycle/propose-takes.ts": ["test/e2e/propose-takes-jsonb-postgres.test.ts"],
  "src/core/cycle/calibration-profile.ts": ["test/e2e/calibration-profile-write.test.ts"],
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
  "src/commands/migrate-engine.ts": [
    "test/e2e/multi-source-bug-class.test.ts",
    "test/e2e/migrate-engine-pglite-to-postgres.test.ts",
  ],
  // Any minions queue/worker/handler change exercises all minion E2E.
  "src/core/minions/**": [
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
    "test/e2e/connectors-sync-pglite.test.ts",
    "test/e2e/doctor-connectors-pglite.test.ts",
  ],
  // Agent-job scope fences over real Postgres.
  "src/core/ops/jobs.ts": ["test/e2e/jobs-agent-scope-postgres.test.ts"],
  // postgres.js bind paths + JSONB shapes + parity vs PGLite.
  "src/core/postgres-engine.ts": [
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/postgres-jsonb.test.ts",
    "test/e2e/jsonb-roundtrip.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    // #3391: includeNullSignature stale predicates (engine parity).
    "test/e2e/migrate-embeddings-postgres.test.ts",
    // getHealth islanded-liveness + entity-coverage floor (#4153/#4147).
    "test/e2e/health-parity-postgres.test.ts",
    // #4109: FOR KEY SHARE deletion-race behavior of addLink/addTimelineEntry.
    "test/e2e/source-boundary-mutation-postgres.test.ts",
  ],
  // PGLite bootstrap path + parity guard.
  "src/core/pglite-engine.ts": [
    "test/e2e/postgres-bootstrap.test.ts",
    "test/e2e/engine-parity.test.ts",
    "test/e2e/schema-drift.test.ts",
    "test/e2e/health-parity-postgres.test.ts",
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
    "test/e2e/health-parity-postgres.test.ts",
    "test/e2e/source-boundary-mutation-postgres.test.ts",
  ],
  "src/core/pglite-engine/**": [
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
  // src/core/pglite-engine/** too; selector unions the entries.)
  "src/core/pglite-engine/cjk-search.ts": ["test/e2e/engine-parity-cjk.test.ts"],
  // D7 parity batch: the code-edge read paths (getCallersOf / getCalleesOf /
  // getEdgesByChunk) live in the peeled engine modules; both modules key the
  // cross-engine read-parity suite directly. (The engine-dir ** globs above
  // match these files too; the selector unions the entries.)
  "src/core/postgres-engine/code-edges.ts": ["test/e2e/code-edges-read-parity.test.ts"],
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
  "src/schema.sql": ["test/e2e/schema-drift.test.ts"],
  "src/core/pglite-schema.ts": ["test/e2e/schema-drift.test.ts"],
  "src/core/migrate.ts": ["test/e2e/schema-drift.test.ts", "test/e2e/migrate-chain.test.ts"],
  // MCP stdio + HTTP transports share dispatch.
  "src/mcp/**": ["test/e2e/mcp.test.ts", "test/e2e/http-transport.test.ts"],
  // G6: the --surface verbs CEILING journey over a real `serve --http` boot
  // (hermetic PGLite): 7-verb tools/list for full-preset + bare clients,
  // fail-closed dispatch on hidden ops, the narrow-only
  // GBRAIN_MCP_FORCE_SURFACE kill switch, and a verb round-trip. Keyed on the
  // surface implementation; the selector UNIONS this with the src/mcp/**
  // entry above. src/commands/serve.ts stays deliberately unmapped
  // (fail-closed run-all), so serve-side changes hit this suite too.
  "src/mcp/surface.ts": ["test/e2e/serve-http-surface-ceiling.test.ts"],
  // Integrity batch-load fast path.
  "src/commands/integrity.ts": ["test/e2e/integrity-batch.test.ts"],
  // gbrain connect — raw-bearer MCP smoke probe exercised end-to-end against
  // a real serve --http (PGLite), so changes to either feed it.
  "src/commands/connect.ts": ["test/e2e/connect-bearer.test.ts"],
  "src/core/connect-probe.ts": ["test/e2e/connect-bearer.test.ts"],
  // G4: brain-axis mount ROUTING journey — resolver tiers (flag > env >
  // dotfile > path-prefix > host) exercised over real CLI spawns against two
  // real PGLite DBs. mounts.ts subcommand dispatch itself is unit-covered in
  // test/mounts-cli.test.ts; this e2e pins the resolver→engine wiring.
  "src/core/brain-resolver.ts": ["test/e2e/mounts-routing-pglite.test.ts"],
  "src/commands/mounts.ts": ["test/e2e/mounts-routing-pglite.test.ts"],
  // Upgrade chains migration ledger; touches both runners. The bun-link arc
  // (detection marker, pull→install ordering, post-upgrade ledger checkpoint,
  // --swap-only) is behaviorally pinned by the shimmed serial e2e (G6).
  "src/commands/upgrade.ts": [
    "test/e2e/upgrade.test.ts",
    "test/e2e/migrate-chain.test.ts",
    "test/e2e/migration-flow.test.ts",
    "test/e2e/upgrade-bun-link-arc.serial.test.ts",
  ],
  // Autopilot linux install/uninstall lifecycle (PATH-shimmed crontab +
  // systemctl; the ubuntu CI runner's only behavioral pin on those arms).
  "src/commands/autopilot.ts": ["test/e2e/autopilot-linux-lifecycle.serial.test.ts"],
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
};
