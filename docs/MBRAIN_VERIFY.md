# MBrain Installation Verification Runbook

Run these checks after install to confirm every part of MBrain is working.
Each check includes the command, expected output, and what to do if it fails.

The most important check is #4 (live sync). "Sync ran" is not the same as
"sync worked." A sync that silently skips pages because of a pooler bug is
worse than no sync at all, because you think it's working.

---

## 1. Schema Verification

**Command:**

```bash
mbrain doctor --json
```

**Expected:** The output should match the active profile:
- On Postgres profiles, `connection`, `pgvector`, `rls`, `schema_version`, and `embeddings` should be `ok`.
- On local/offline profiles, `execution_envelope` and `contract_surface` should appear, `pgvector` and `rls` should short-circuit with `warn`, and `check-update` should be reported honestly as unsupported.
- `unsupported_capabilities` should explain any local-path limits such as cloud file storage.

**If it fails:** The doctor output includes specific fix instructions for each
check. See `skills/setup/SKILL.md` Error Recovery table.

## 1a. Execution envelope verification

Run:

```bash
mbrain doctor --json | jq '.checks[] | select(.name == "execution_envelope" or .name == "contract_surface")'
```

Expected:

- the active profile is reported honestly
- unsupported contract surfaces include an explicit reason
- sqlite/local mode does not pretend to support cloud file storage
- pglite local-path mode should follow the same honest contract reporting

## Phase 0 parity verification

Run:

```bash
bun test test/phase0-contract-parity.test.ts
```

Expected:

- SQLite and PGLite pass unconditionally against the same shared workflow fixture.
- Postgres runs when `DATABASE_URL` is configured.
- Missing Postgres coverage is reported as an explicit skip reason, not as a silent reduction in the supported surface.

## Phase 1 operational-memory verification

Run:

```bash
bun run test:phase1
```

Expected:

- `task-memory-schema`, `task-memory-engine`, `task-memory-service`, and `task-memory-operations` all pass.
- SQLite and PGLite persist task-memory records across reconnects.
- Phase 1 task-resume parity runs through `test/phase0-contract-parity.test.ts`, including the `task resume semantics` coverage.
- Postgres task-memory persistence runs when `DATABASE_URL` is configured.
- If `DATABASE_URL` is missing, the Postgres task-memory persistence and parity checks report explicit skip reasons instead of silently dropping coverage.

## Phase 1 operational-memory benchmark

Run:

```bash
bun run bench:phase1 --json
```

Expected:

- the report includes `task_resume`, `attempt_history`, `decision_history`, and `resume_projection`
- latency workloads report positive `p50_ms` and `p95_ms`
- `resume_projection.success_rate` is `100` on the published fixture workload
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase1_status` stays `pending_baseline` until a comparable repeated-work baseline exists for the primary improvement threshold
- the benchmark stays local and uses the same sqlite execution envelope as the Phase 0 baseline runner

To evaluate the full primary-improvement threshold once you have a comparable prior benchmark:

```bash
bun run bench:phase1 --json --baseline path/to/previous-phase1-benchmark.json
```

Expected:

- `acceptance.phase1_status` becomes `pass` or `fail` instead of `pending_baseline`
- the baseline must use the same engine and include a comparable `task_resume` latency measurement

To publish a reusable environment-specific baseline artifact:

```bash
bun run bench:phase1 --json --write-baseline docs/benchmarks/phase1/YYYY-MM-DD-<env>.json
```

Expected:

- the command still prints the benchmark JSON to stdout
- the same payload is written to the requested file
- the file can later be passed back through `--baseline`

## Phase 2 note-manifest verification

Run:

```bash
bun test test/note-manifest-schema.test.ts test/note-manifest-service.test.ts test/note-manifest-engine.test.ts test/note-manifest-operations.test.ts test/phase2-note-manifest.test.ts
```

Expected:

- note-manifest schema and service coverage pass on the local sqlite/pglite path
- import refresh keeps note-manifest rows in sync with canonical note writes
- `manifest-get`, `manifest-list`, and `manifest-rebuild` stay available through the shared operation surface

## Phase 2 note-manifest benchmark

Run:

```bash
bun run bench:phase2 --json
```

Expected:

- the report includes `manifest_get`, `manifest_list`, `manifest_rebuild`, and `structural_projection`
- latency workloads report positive `p50_ms` and `p95_ms`
- `structural_projection.success_rate` is `100` on the published fixture workload
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without requiring an external baseline artifact
- the benchmark stays local and uses the same sqlite execution envelope as the earlier phase runners

## Phase 2 note-sections verification

Run:

```bash
bun test test/note-section-schema.test.ts test/note-section-service.test.ts test/note-section-engine.test.ts test/note-section-operations.test.ts test/phase2-note-sections.test.ts
```

Expected:

- note-section schema and extraction coverage pass on the local sqlite/pglite path
- canonical note writes refresh deterministic section rows immediately
- `section-get`, `section-list`, and `section-rebuild` stay available through the shared operation surface

## Phase 2 note-sections benchmark

Run:

```bash
bun run bench:phase2-sections --json
```

Expected:

- the report includes `section_get`, `section_list`, `section_rebuild`, and `section_projection`
- latency workloads report positive `p50_ms` and `p95_ms`
- `section_projection.success_rate` is `100` on the published fixture workload
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without requiring an external baseline artifact
- the benchmark stays local and uses the same sqlite execution envelope as the earlier phase runners

## Phase 2 structural-paths verification

Run:

```bash
bun test test/note-structural-graph-service.test.ts test/note-structural-graph-operations.test.ts test/phase2-structural-paths.test.ts
```

Expected:

- deterministic structural neighbors and path coverage pass
- the operation surface exposes `section-neighbors` and `section-path`
- the benchmark reports local guardrail status for graph build, neighbors, and path lookup

## Phase 2 structural-paths benchmark

Run:

```bash
bun run bench:phase2-structural-paths --json
```

Expected:

- the report includes `structural_graph_build`, `structural_neighbors`, `structural_path`, and `structural_path_correctness`
- latency workloads report positive `p50_ms` and `p95_ms`
- `structural_path_correctness.success_rate` is `100`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without requiring an external baseline artifact

## Phase 2 context-map verification

Run:

```bash
bun test test/context-map-schema.test.ts test/context-map-engine.test.ts test/context-map-service.test.ts test/context-map-operations.test.ts test/phase2-context-map.test.ts
```

Expected:

- context-map schema and persisted builder coverage pass on the local sqlite/pglite path
- engine CRUD persists context-map rows across reopen
- `map-build`, `map-get`, and `map-list` stay available through the shared operation surface
- `map-get` and `map-list` mark persisted maps as `stale` after manifest/section source hashes change
- explicit `map-build` returns stale maps to `ready`
- persisted workspace maps are rebuildable from existing manifest and section rows

## Phase 2 context-map benchmark

Run:

```bash
bun run bench:phase2-context-map --json
```

Expected:

- the report includes `context_map_build`, `context_map_get`, `context_map_list`, and `context_map_correctness`
- latency workloads report positive `p50_ms` and `p95_ms`
- `context_map_correctness.success_rate` is `100`, including stale-read disclosure before explicit rebuild
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without requiring an external baseline artifact

## Phase 2 context-atlas verification

Run:

```bash
bun test test/context-atlas-schema.test.ts test/context-atlas-engine.test.ts test/context-atlas-service.test.ts test/context-atlas-operations.test.ts test/phase2-context-atlas.test.ts
```

Expected:

- context-atlas schema and engine persistence coverage pass on the local sqlite/pglite path
- `atlas-build`, `atlas-get`, and `atlas-list` stay available through the shared operation surface
- atlas reads mirror underlying context-map freshness
- explicit rebuild returns atlas freshness to `fresh`

## Phase 2 context-atlas benchmark

Run:

```bash
bun run bench:phase2-context-atlas --json
```

Expected:

- the report includes `context_atlas_build`, `context_atlas_get`, `context_atlas_list`, and `context_atlas_correctness`
- latency workloads report positive `p50_ms` and `p95_ms`
- `context_atlas_correctness.success_rate` is `100`, including stale-to-fresh recovery
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without requiring an external baseline artifact

## Phase 2 context-atlas selection

Run:

```bash
bun test test/context-atlas-service.test.ts test/context-atlas-operations.test.ts test/phase2-context-atlas-select.test.ts
bun test test/cli.test.ts -t "atlas-select --help"
bun run bench:phase2-context-atlas-select --json
```

Expected:

- selection returns deterministic outcomes for fresh, stale, and over-budget cases
- `atlas-select` stays available through the shared operation surface
- benchmark reports `context_atlas_select` and `context_atlas_select_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 context-atlas overview

Run:

```bash
bun test test/context-atlas-overview-service.test.ts test/context-atlas-overview-operations.test.ts test/phase2-context-atlas-overview.test.ts
bun test test/cli.test.ts -t "atlas-overview --help"
bun run bench:phase2-context-atlas-overview --json
```

Expected:

- overview tests pass
- `atlas-overview` stays available through the shared operation surface
- benchmark reports `context_atlas_overview` and `context_atlas_overview_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 context-atlas report

Run:

```bash
bun test test/context-atlas-report-service.test.ts test/context-atlas-report-operations.test.ts test/phase2-context-atlas-report.test.ts
bun test test/cli.test.ts -t "atlas-report --help"
bun run bench:phase2-context-atlas-report --json
```

Expected:

- report tests pass
- `atlas-report` stays available through the shared operation surface
- benchmark reports `context_atlas_report` and `context_atlas_report_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 context-map report

Run:

```bash
bun test test/context-map-report-service.test.ts test/context-map-report-operations.test.ts test/phase2-context-map-report.test.ts
bun test test/cli.test.ts -t "map-report --help"
bun run bench:phase2-context-map-report --json
```

Expected:

- map report tests pass
- `map-report` stays available through the shared operation surface
- benchmark reports `context_map_report` and `context_map_report_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 workspace-system-card

Run:

```bash
bun test test/workspace-system-card-service.test.ts test/workspace-system-card-operations.test.ts test/phase2-workspace-system-card.test.ts
bun test test/cli.test.ts -t "workspace-system-card --help"
bun run bench:phase2-workspace-system-card --json
```

Expected:

- workspace-system-card tests pass
- `workspace-system-card` stays available through the shared operation surface
- benchmark reports `workspace_system_card` and `workspace_system_card_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 workspace-project-card

Run:

```bash
bun test test/workspace-project-card-service.test.ts test/workspace-project-card-operations.test.ts test/phase2-workspace-project-card.test.ts
bun test test/cli.test.ts -t "workspace-project-card --help"
bun run bench:phase2-workspace-project-card --json
```

Expected:

- workspace-project-card tests pass
- `workspace-project-card` stays available through the shared operation surface
- benchmark reports `workspace_project_card` and `workspace_project_card_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 workspace-orientation-bundle

Run:

```bash
bun test test/workspace-orientation-bundle-service.test.ts test/workspace-orientation-bundle-operations.test.ts test/phase2-workspace-orientation-bundle.test.ts
bun test test/cli.test.ts -t "workspace-orientation --help"
bun run bench:phase2-workspace-orientation-bundle --json
```

Expected:

- workspace-orientation-bundle tests pass
- `workspace-orientation` stays available through the shared operation surface
- benchmark reports `workspace_orientation_bundle` and `workspace_orientation_bundle_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 workspace-corpus-card

Run:

```bash
bun test test/workspace-corpus-card-service.test.ts test/workspace-corpus-card-operations.test.ts test/phase2-workspace-corpus-card.test.ts
bun test test/cli.test.ts -t "workspace-corpus-card --help"
bun run bench:phase2-workspace-corpus-card --json
```

Expected:

- workspace-corpus-card tests pass
- `workspace-corpus-card` stays available through the shared operation surface
- benchmark reports `workspace_corpus_card` and `workspace_corpus_card_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 atlas-orientation-card

Run:

```bash
bun test test/atlas-orientation-card-service.test.ts test/atlas-orientation-card-operations.test.ts test/phase2-atlas-orientation-card.test.ts
bun test test/cli.test.ts -t "atlas-orientation-card --help"
bun run bench:phase2-atlas-orientation-card --json
```

Expected:

- atlas-orientation-card tests pass
- `atlas-orientation-card` stays available through the shared operation surface
- benchmark reports `atlas_orientation_card` and `atlas_orientation_card_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 atlas-orientation-bundle

Run:

```bash
bun test test/atlas-orientation-bundle-service.test.ts test/atlas-orientation-bundle-operations.test.ts test/phase2-atlas-orientation-bundle.test.ts
bun test test/cli.test.ts -t "atlas-orientation-bundle --help"
bun run bench:phase2-atlas-orientation-bundle --json
```

Expected:

- atlas-orientation-bundle tests pass
- `atlas-orientation-bundle` stays available through the shared operation surface
- benchmark reports `atlas_orientation_bundle` and `atlas_orientation_bundle_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase2_status` matches the local guardrail outcome without introducing an external baseline artifact

## Phase 2 acceptance pack

Run:

```bash
bun run test:phase2
bun run bench:phase2-acceptance --json
```

Expected:

- `test:phase2` executes the published Phase 2 schema, service, engine, operations, and benchmark-shape tests as one umbrella command
- `bench:phase2-acceptance` summarizes every published Phase 2 benchmark slice
- the acceptance summary reports `readiness_status: pass` and `phase2_status: pass` only when every child benchmark passes

## Phase 3 context-map explain

Run:

```bash
bun test test/context-map-explain-service.test.ts test/context-map-explain-operations.test.ts test/phase3-context-map-explain.test.ts
bun test test/cli.test.ts -t "map-explain --help"
bun run bench:phase3-context-map-explain --json
```

Expected:

- context-map explain tests pass
- `map-explain` stays available through the shared operation surface
- benchmark reports `context_map_explain` and `context_map_explain_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 context-map query

Run:

```bash
bun test test/context-map-query-service.test.ts test/context-map-query-operations.test.ts test/phase3-context-map-query.test.ts
bun test test/cli.test.ts -t "map-query --help"
bun run bench:phase3-context-map-query --json
```

Expected:

- context-map query tests pass
- `map-query` stays available through the shared operation surface
- benchmark reports `context_map_query` and `context_map_query_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 context-map path

Run:

```bash
bun test test/context-map-path-service.test.ts test/context-map-path-operations.test.ts test/phase3-context-map-path.test.ts
bun test test/cli.test.ts -t "map-path --help"
bun run bench:phase3-context-map-path --json
```

Expected:

- context-map path tests pass
- `map-path` stays available through the shared operation surface
- benchmark reports `context_map_path` and `context_map_path_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 broad-synthesis route

Run:

```bash
bun test test/broad-synthesis-route-service.test.ts test/broad-synthesis-route-operations.test.ts test/phase3-broad-synthesis-route.test.ts
bun test test/cli.test.ts -t "broad-synthesis-route --help"
bun run bench:phase3-broad-synthesis-route --json
```

Expected:

- broad-synthesis route tests pass
- `broad-synthesis-route` stays available through the shared operation surface
- benchmark reports `broad_synthesis_route` and `broad_synthesis_route_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 precision-lookup route

Run:

```bash
bun test test/precision-lookup-route-service.test.ts test/precision-lookup-route-operations.test.ts test/phase3-precision-lookup-route.test.ts
bun test test/cli.test.ts -t "precision-lookup-route --help"
bun run bench:phase3-precision-lookup-route --json
```

Expected:

- precision-lookup route tests pass
- `precision-lookup-route` stays available through the shared operation surface
- benchmark reports `precision_lookup_route` and `precision_lookup_route_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 retrieval-route selector

Run:

```bash
bun test test/retrieval-route-selector-service.test.ts test/retrieval-route-selector-operations.test.ts test/phase3-retrieval-route-selector.test.ts
bun test test/cli.test.ts -t "retrieval-route --help"
bun run bench:phase3-retrieval-route-selector --json
```

Expected:

- retrieval-route selector tests pass
- `retrieval-route` stays available through the shared operation surface
- benchmark reports `retrieval_route_selector` and `retrieval_route_selector_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 retrieval-route trace

Run:

```bash
bun test test/retrieval-route-trace-service.test.ts test/retrieval-route-trace-operations.test.ts test/phase3-retrieval-route-trace.test.ts
bun run bench:phase3-retrieval-route-trace --json
```

Expected:

- retrieval-route trace tests pass
- `retrieval-route` can persist a task-scoped trace when explicitly requested
- benchmark reports `retrieval_route_trace` and `retrieval_route_trace_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase3_status` matches the local guardrail outcome without introducing a baseline artifact

## Phase 3 acceptance-pack

Run:

```bash
bun test test/phase3-acceptance-pack.test.ts
bun run bench:phase3-acceptance --json
bun run test:phase3
```

Expected:

- acceptance-pack test passes
- benchmark summarizes every published Phase 3 benchmark slice
- `acceptance.readiness_status` reports `pass` only when all Phase 3 slices pass
- `acceptance.phase3_status` matches the aggregated phase outcome
- `test:phase3` runs the published Phase 3 suites plus the acceptance-pack test

## Phase 4 scope-gate

Run:

```bash
bun test test/scope-gate-service.test.ts test/scope-gate-operations.test.ts test/phase4-scope-gate.test.ts
bun run bench:phase4-scope-gate --json
```

Expected:

- scope-gate tests pass
- `scope-gate` stays available through the shared operation surface
- benchmark reports `scope_gate` and `scope_gate_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase4_status` matches the local guardrail outcome
- `allow`, `deny`, and `defer` cases are all covered deterministically

## Phase 4 personal-profile-lookup

Run:

```bash
bun test test/profile-memory-schema.test.ts test/profile-memory-engine.test.ts test/profile-memory-operations.test.ts test/personal-profile-lookup-route-service.test.ts test/personal-profile-lookup-route-operations.test.ts test/phase4-personal-profile-lookup.test.ts
bun run bench:phase4-personal-profile-lookup --json
```

Expected:

- profile-memory schema and engine tests pass for SQLite and PGLite
- Postgres profile-memory persistence is covered when `DATABASE_URL` is available
- `profile-memory-upsert`, `profile-memory-get`, and `profile-memory-list` stay available through the shared operation surface
- `personal-profile-lookup-route` stays available through the shared operation surface
- exact-subject direct match, ambiguity, and no-match cases all stay deterministic
- benchmark reports `personal_profile_lookup_route` and `personal_profile_lookup_route_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase4_status` matches the local guardrail outcome

## Phase 4 personal-episode foundations

Run:

```bash
bun test test/personal-episode-schema.test.ts test/personal-episode-engine.test.ts test/personal-episode-operations.test.ts
```

Expected:

- personal-episode schema and engine tests pass for SQLite and PGLite
- Postgres personal-episode persistence is covered when `DATABASE_URL` is available
- `personal-episode-record`, `personal-episode-get`, and `personal-episode-list` stay available through the shared operation surface
- append-only episode writes are immediately visible through `get` and `list`
- `test:phase4` includes the personal-episode foundation coverage

## Phase 4 personal-episode-lookup

Run:

```bash
bun test test/personal-episode-schema.test.ts test/personal-episode-engine.test.ts test/personal-episode-operations.test.ts test/personal-episode-lookup-route-service.test.ts test/personal-episode-lookup-route-operations.test.ts test/phase4-personal-episode-lookup.test.ts
bun run bench:phase4-personal-episode-lookup --json
```

Expected:

- personal-episode schema and engine tests pass for SQLite and PGLite
- Postgres personal-episode persistence is covered when `DATABASE_URL` is available
- `personal-episode-record`, `personal-episode-get`, and `personal-episode-list` stay available through the shared operation surface
- `personal-episode-lookup-route` stays available through the shared operation surface
- exact-title direct match, ambiguity, and no-match cases all stay deterministic
- benchmark reports `personal_episode_lookup_route` and `personal_episode_lookup_route_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase4_status` matches the local guardrail outcome

## Phase 4 personal-write-target

Run:

```bash
bun test test/personal-write-target-service.test.ts test/personal-write-target-operations.test.ts test/phase4-personal-write-target.test.ts
bun run bench:phase4-personal-write-target --json
```

Expected:

- `personal-write-target` stays available through the shared operation surface
- `profile_memory` and `personal_episode` targets both require personal-scope approval
- deny and defer cases disclose the scope-gate reason instead of returning a target
- benchmark reports `personal_write_target` and `personal_write_target_correctness`
- `acceptance.readiness_status` reports `pass` or `fail` from the local guardrails
- `acceptance.phase4_status` matches the local guardrail outcome

## Phase 4 safe personal writes

Run:

```bash
bun test test/personal-write-operations.test.ts
```

Expected:

- `profile-memory-write` and `personal-episode-write` stay available through the shared operation surface
- allowed writes persist canonical personal records in the right store
- denied writes do not create durable profile-memory or personal-episode records
- `test:phase4` includes the safe personal write coverage

## Phase 4 export visibility

Run:

```bash
bun test test/personal-export-visibility-service.test.ts test/personal-export-operations.test.ts test/export-personal-visibility.test.ts test/phase4-export-visibility.test.ts
bun run bench:phase4-export-visibility --json
```

Expected:

- personal-export visibility service returns deterministic allow, deny, and defer disclosures
- `personal-export-preview` stays available through the shared operation surface
- default `export` continues to serialize canonical pages only
- `export --personal-export` writes Markdown only for curated exportable profile-memory records
- private-only profile-memory entries stay excluded
- personal episodes stay excluded from exported output in this slice
- benchmark reports `personal_export_visibility` and `personal_export_visibility_correctness`
- `acceptance.phase4_status` matches the local guardrail outcome

## Phase 4 mixed-scope bridge

Run:

```bash
bun test test/mixed-scope-bridge-service.test.ts test/mixed-scope-bridge-operations.test.ts test/retrieval-route-selector-service.test.ts test/retrieval-route-selector-operations.test.ts test/phase4-mixed-scope-bridge.test.ts
bun run bench:phase4-mixed-scope-bridge --json
```

Expected:

- `mixed-scope-bridge` stays available through the shared operation surface
- explicit mixed scope is required for the bridge
- the bridge combines one work-side broad-synthesis route with either a personal profile route or a personal episode route
- degraded bridge cases return deterministic no-route disclosures
- `retrieval-route` can select the bridge and persist a Retrieval Trace
- benchmark reports `mixed_scope_bridge` and `mixed_scope_bridge_correctness`
- `acceptance.phase4_status` matches the local guardrail outcome

## Phase 4 mixed-scope disclosure

Run:

```bash
bun test test/mixed-scope-disclosure-service.test.ts test/mixed-scope-disclosure-operations.test.ts test/phase4-mixed-scope-disclosure.test.ts
bun run bench:phase4-mixed-scope-disclosure --json
```

Expected:

- `mixed-scope-disclosure` stays available through the shared operation surface
- exportable profile-memory records may disclose exact content in mixed output
- private-only or secret profile-memory records withhold raw content
- personal-episode mixed output remains metadata-only
- benchmark reports `mixed_scope_disclosure` and `mixed_scope_disclosure_correctness`
- `acceptance.phase4_status` matches the local guardrail outcome

## Phase 4 acceptance-pack

Run:

```bash
bun test test/phase4-acceptance-pack.test.ts
bun run bench:phase4-acceptance --json
```

Expected:

- acceptance-pack test passes
- benchmark summarizes every published Phase 4 benchmark slice
- `acceptance.readiness_status` reports `pass` only when all published Phase 4 slices pass
- `acceptance.phase4_status` matches the aggregated phase outcome
- `test:phase4` runs the published Phase 4 suites, mixed-scope disclosure coverage, export-visibility coverage, mixed-scope bridge coverage, and the acceptance-pack test

## Phase 5 memory inbox foundations

Run:

```bash
bun test test/memory-inbox-schema.test.ts test/memory-inbox-engine.test.ts test/memory-inbox-service.test.ts test/memory-inbox-operations.test.ts test/phase5-memory-inbox-foundations.test.ts
bun run bench:phase5-memory-inbox-foundations --json
```

Expected:

- `memory_candidate_entries` exists across SQLite and PGLite schema initialization
- create/get/list/delete persistence works across SQLite, PGLite, and Postgres when `DATABASE_URL` is configured
- bounded status transitions stay limited to `captured -> candidate -> staged_for_review`
- `create-memory-candidate`, `get-memory-candidate`, `list-memory-candidates`, and `advance-memory-candidate-status` stay available through the shared operation surface
- benchmark reports `memory_inbox_foundations` and `memory_inbox_foundations_correctness`
- `acceptance.phase5_status` matches the local foundation guardrail outcome

## Phase 5 acceptance-pack

Run:

```bash
bun test test/phase5-acceptance-pack.test.ts
bun run bench:phase5-acceptance --json
```

Expected:

- acceptance-pack test passes
- benchmark summarizes every published Phase 5 benchmark slice
- `acceptance.readiness_status` reports `pass` only when all published Phase 5 slices pass
- `acceptance.phase5_status` matches the aggregated phase outcome
- `test:phase5` runs the published Phase 5 suites and the acceptance-pack test

---

## 2. Skillpack Loaded

**Check:** Ask the agent: "What is the brain-agent loop?"

**Expected:** The agent references MBRAIN_SKILLPACK.md Section 2 and describes
the read-write cycle: detect entities, read brain, respond with context, write
brain, sync.

**If it fails:** The agent hasn't loaded the skillpack. Run step 6 from the
install paste (read `docs/MBRAIN_SKILLPACK.md`).

---

## 3. Auto-Update Configured

**Command:**

```bash
mbrain check-update --json
```

**Expected:** Returns JSON with `current_version`, `latest_version`,
`update_available` (boolean). On local/offline profiles, the command should
short-circuit with `error: "offline_mode"` and a human-readable `reason`.
The cron `mbrain-update-check` is registered.

**If it fails:** Run step 7 from the install paste. See MBRAIN_SKILLPACK.md
Section 17.

---

## 4. Live Sync Actually Works

This is the most important check. Three parts.

### 4a. Coverage Check

Compare page count in the DB against syncable file count in the repo:

```bash
mbrain stats
```

Then count syncable files:

```bash
find /data/brain -name '*.md' \
  -not -path '*/.*' \
  -not -path '*/.raw/*' \
  -not -path '*/ops/*' \
  -not -name 'README.md' \
  -not -name 'index.md' \
  -not -name 'schema.md' \
  -not -name 'log.md' \
  | wc -l
```

**Expected:** Page count in `mbrain stats` should be close to the file count.
Some difference is normal (files added since last sync), but if page count is
less than half the file count, sync is silently skipping pages.

**If page count is way too low:** The #1 cause is the connection pooler bug.
Check your `DATABASE_URL`:
- If it contains `pooler.supabase.com:6543`, verify it's using **Session mode**,
  not Transaction mode.
- Transaction mode breaks `engine.transaction()` and causes `.begin() is not a
  function` errors.
- Fix: switch to Session mode pooler string, then run `mbrain sync --full`
  to reimport everything.

### 4b. Embed Check

```bash
mbrain stats
```

**Expected:** Embedded chunk count should be close to total chunk count.

**If embedded is much lower than total:**

```bash
mbrain embed --stale
```

If your local embedding runtime is not reachable, or `nomic-embed-text` is not
installed, embeddings can't be generated. Keyword search still works without
embeddings, but hybrid/semantic search won't.

If you are upgrading an existing Postgres brain to the 768-dim nomic schema,
run this once before backfilling:

```bash
mbrain init
mbrain embed --all
```

### 4c. End-to-End Test

This is the real test. Edit a brain page, push, wait, search.

1. Edit a page in the brain repo (e.g., correct a fact on a person's page):

```bash
# Example: fix a line in Gustaf's page
cd /data/brain
# Make a small edit to any .md file
git add -A && git commit -m "test: verify live sync" && git push
```

2. Wait for the next sync cycle (cron interval or `--watch` poll).

3. Search for the corrected text:

```bash
mbrain search "<text from the correction>"
```

**Expected:** The search returns the **corrected** text, not the old version.

**If it returns old text:** Sync failed silently. Check:
- Is the sync cron registered and running?
- Is `mbrain sync --watch` still alive (if using watch mode)?
- Run `mbrain config get sync.last_run` to see when sync last ran.
- Run `mbrain sync --repo /data/brain` manually and check for errors.
- If you see `.begin() is not a function`, fix the pooler (see 4a above).

---

## 5. Embedding Coverage

**Command:**

```bash
mbrain stats
```

**Expected:** Embedded chunk count matches (or is close to) total chunk count.

**If zero or very low:** your local embedding runtime may be unavailable or the
model may be missing. Check:

```bash
ollama list | grep nomic-embed-text
```

If the model is missing, install it. Then:

```bash
ollama pull nomic-embed-text
mbrain embed --stale
```

---

## 6. Brain-First Lookup Protocol

**Check:** Ask the agent about a person or concept that exists in the brain.

**Expected:** The agent uses `mbrain search` or `mbrain query` FIRST, not grep
or external APIs. The response includes brain-sourced context with source
attribution.

**If it fails:** The brain-first lookup protocol isn't injected into the agent's
system context. See `skills/setup/SKILL.md` Phase D.

---

## Quick Verification (all checks in one pass)

```bash
# 1. Schema
mbrain doctor --json

# 2. Sync recency
mbrain config get sync.last_run

# 3. Page count + embed coverage
mbrain stats

# 4. Search works
mbrain search "test query from your brain content"

# 5. Catch any unembedded chunks
mbrain embed --stale

# 6. Auto-update
mbrain check-update --json
```

If all six return successfully, the installation is healthy. For the full
end-to-end sync test (4c), push a real change and verify it appears in search.
