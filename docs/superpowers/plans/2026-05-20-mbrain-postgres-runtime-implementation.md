# MBrain Postgres Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Postgres-only personal memory runtime described by the 2026-05-20 MBrain runtime specs.

**Architecture:** Build foundation-first. Postgres is the target backend and runtime state is Postgres-only; Markdown remains a governed projection, not an alternate semantic source of truth. Raw sources, work/session state, assertions, evidence, canonical writes, maintenance jobs, Dream, forgetting, runners, reconciliation, connectors, audit, evaluation, and migration each land behind explicit phase gates.

**Tech Stack:** Bun, TypeScript, local Postgres with `postgres` and `pgvector`, existing MBrain CLI/MCP service patterns, Markdown projection helpers, existing `src/schema.sql` plus generated `src/core/schema-embedded.ts`, Bun tests, TypeScript compile checks.

---

## Source Specs

Use these specs as the implementation contract:

- `docs/superpowers/specs/2026-05-20-mbrain-postgres-personal-memory-runtime-architecture.md`
- `docs/superpowers/specs/2026-05-20-mbrain-implementation-index.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-00-postgres-foundation.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-01-source-registry-policy.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-02-raw-ingest-provenance.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-03-assertion-pipeline.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-04-governed-canonical-write.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-05-maintenance-runtime.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-06-autopilot-daemon.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-07-dream-cycle.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-08-lifecycle-forgetting.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-09-restricted-runner.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-10-system-of-record-reconciler.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-11-personal-data-connectors.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-12-review-audit-health.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-13-evaluation-replay.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-14-migration-cleanup.md`

## Execution Rules

- Keep each task on the current feature branch and commit after the listed gate passes.
- Write the failing tests first for the task being implemented.
- Do not add SQLite or PGLite parity for new target runtime features. Existing legacy tests may keep running, but new runtime features are Postgres-targeted.
- Do not let runners, Dream, reconciler, or connector code write canonical memory except through Phase 04 policy.
- Keep source text untrusted. Redact secrets before runner/LLM access.
- Do not make Markdown edits into canonical truth directly. Markdown semantic edits enter as `markdown_file` source items with `origin_event = markdown_edit`.
- When a task needs schema changes, edit `src/schema.sql`, then run `bun run build:schema` and commit both `src/schema.sql` and `src/core/schema-embedded.ts`.
- Prefer small service files under `src/core/services/` and operation wrappers under `src/core/operations-*.ts`. Avoid making `src/core/postgres-engine.ts` larger unless the existing engine interface genuinely needs a new method.

## File Structure

Create these focused implementation areas as the phases land:

- `src/core/postgres-runtime/`
  - `connection-profile.ts`: validates local Postgres target profile and DSN safety.
  - `runtime-store.ts`: Postgres-only store helpers for tables that should not be added to the cross-engine `BrainEngine` interface.
  - `runtime-errors.ts`: typed runtime errors and failure classes.

- `src/core/source-registry/`
  - `source-policy.ts`: source kind defaults, policy resolution, authority matrix lookup.
  - `raw-ingest.ts`: source item/chunk ingest, hashing, redaction, prompt-injection flags.
  - `raw-access-ledger.ts`: scoped raw reads for CLI, MCP, daemon, and runner actors.

- `src/core/assertions/`
  - `assertion-types.ts`: claim, assertion, evidence, conflict, and lifecycle types.
  - `claim-extraction.ts`: deterministic extracted-claim creation from source chunks.
  - `assertion-resolution.ts`: target/property/value normalization, duplicate, supersession, conflict handling.
  - `assertion-evidence.ts`: many-to-many evidence joins and evidence summary recomputation.

- `src/core/canonical-write/`
  - `write-policy.ts`: source-kind x claim-type authority, confidence, sensitivity, session grant, and conflict gates.
  - `mutation-planner.ts`: canonical assertion and projection mutation plan builder.
  - `projection-writer.ts`: immediate critical projection writer.
  - `candidate-fallback.ts`: Memory Candidate fallback from denied or ambiguous assertions.

- `src/core/maintenance/`
  - `job-runtime.ts`: jobs, leases, locks, retries, backpressure, and failure classification.
  - `autopilot.ts`: launchd/systemd/cron/manual entry generation and heartbeat.
  - `dream-cycle.ts`: stable Dream phase registry and result schema.
  - `lifecycle-forgetting.ts`: lifecycle transitions, tombstones, restore, purge planning.

- `src/core/runners/`
  - `runner-registry.ts`: local Claude Code, local Codex, local model, remote model, deterministic fallback discovery.
  - `runner-policy.ts`: task type allowlists, raw scope, budget, redaction, and prompt-injection gates.
  - `runner-jobs.ts`: runner job records, tool calls, messages, artifacts, and proposal output.

- `src/core/reconciler/`
  - `projection-targets.ts`: projection target registry and hashes.
  - `markdown-contracts.ts`: stable frontmatter/fence parser and renderer contracts.
  - `system-of-record-reconciler.ts`: check, repair_markdown, repair_db metadata repair, import_markdown_edit.

- `src/core/connectors/`
  - `connector-registry.ts`: connector classes, capability model, account/grant state.
  - `credential-refs.ts`: broker/keychain/password-manager/vault references with no raw secrets.
  - `connector-sync.ts`: idempotent source item/chunk sync protocol.

- `src/core/evaluation/`
  - `memory-replay.ts`: fixture replay for source, assertion, write, forgetting, runner, and reconciliation paths.
  - `memory-eval-cases.ts`: canonical scenario cases and expected outcomes.

Use adjacent test files under `test/` with the same feature name. Use scenario fixtures under `test/fixtures/mbrain-postgres-runtime/`.

## Task 1: Phase 00 Postgres Foundation

**Files:**

- Modify: `package.json`
- Modify: `src/core/config.ts`
- Modify: `src/core/engine-factory.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/commands/doctor.ts`
- Create: `src/core/postgres-runtime/connection-profile.ts`
- Create: `test/postgres-runtime-foundation.test.ts`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write failing tests for Postgres-only target behavior**

Create `test/postgres-runtime-foundation.test.ts` with tests named:

- `default runtime config selects postgres`
- `sqlite and pglite are rejected for postgres runtime features`
- `doctor reports active cli mcp and autopilot db identity`
- `remote dsn requires explicit user supplied dsn`
- `pool size is bounded for cli mcp and daemon usage`

Run:

```bash
bun test test/postgres-runtime-foundation.test.ts
```

Expected: FAIL because runtime profile helpers and doctor checks do not exist yet.

- [ ] **Step 2: Implement the runtime profile**

Create `src/core/postgres-runtime/connection-profile.ts` with exported helpers:

- `resolvePostgresRuntimeProfile(config: MBrainConfig): PostgresRuntimeProfile`
- `assertPostgresRuntimeFeatureAllowed(config: MBrainConfig, featureName: string): void`
- `assertExplicitRemoteDsn(config: MBrainConfig): void`
- `describeRuntimeDatabaseIdentity(config: MBrainConfig): RuntimeDatabaseIdentity`

Required behavior:

- `engine: 'postgres'` is valid.
- `engine: 'sqlite'` and `engine: 'pglite'` throw `MBrainError` for new runtime features.
- local host values `localhost`, `127.0.0.1`, and Unix socket style DSNs are accepted without the remote warning.
- non-local DSNs require an explicit config value and must not be inferred.
- password-bearing DSNs are redacted in messages.

- [ ] **Step 3: Wire CLI, MCP, and doctor to the same profile**

Modify `src/core/config.ts`, `src/core/engine-factory.ts`, `src/commands/init.ts`, and `src/commands/doctor.ts` so fresh install and doctor use the runtime profile. Existing legacy engine paths can remain for old commands, but new runtime feature checks must call `assertPostgresRuntimeFeatureAllowed`.

- [ ] **Step 4: Run the focused gate**

Run:

```bash
bun test test/postgres-runtime-foundation.test.ts test/config.test.ts test/doctor.test.ts
bunx tsc --noEmit --pretty false
```

Expected: PASS. TypeScript compile has no missing exports.

- [ ] **Step 5: Commit**

```bash
git add package.json src/core/config.ts src/core/engine-factory.ts src/commands/init.ts src/commands/doctor.ts src/core/postgres-runtime/connection-profile.ts test/postgres-runtime-foundation.test.ts docs/MBRAIN_VERIFY.md
git commit -m "feat: add postgres runtime foundation"
```

## Task 2: Phases 01-02 Source Registry And Raw Ingest

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/source-registry/source-policy.ts`
- Create: `src/core/source-registry/raw-ingest.ts`
- Create: `src/core/source-registry/raw-access-ledger.ts`
- Create: `src/core/services/source-registry-service.ts`
- Create: `src/core/operations-source-registry.ts`
- Create: `test/source-registry-policy-service.test.ts`
- Create: `test/raw-ingest-provenance-service.test.ts`
- Create: `test/raw-access-ledger-service.test.ts`

- [ ] **Step 1: Write failing source registry tests**

Tests must cover:

- every source kind from Phase 01, including `user_direct`
- seeded default matrix fields: ingest, raw copy, extraction, LLM/runner access, auto-write, retention, restore, purge
- minimal consent values: `not_requested`, `granted`, `denied`, `revoked`
- advanced override persistence without changing minimal consent
- deterministic authority matrix lookup
- pause and revoke preventing processing

Run:

```bash
bun test test/source-registry-policy-service.test.ts
```

Expected: FAIL because the source registry tables and service do not exist.

- [ ] **Step 2: Add schema for source policy and raw ingest**

Add tables to `src/schema.sql`:

- `sources`
- `source_policies`
- `source_policy_overrides`
- `source_authority_rules`
- `source_retention_rules`
- `source_llm_rules`
- `source_status_events`
- `source_items`
- `source_chunks`
- `source_item_events`
- `raw_access_ledger`
- `secret_detections`
- `prompt_injection_flags`
- `ingest_attempts`

Required uniqueness:

- `sources(kind, locator)` unique when locator is not null.
- `source_items(source_id, external_id)` unique.
- `source_chunks(source_item_id, chunk_index)` unique.
- policy seed rows are idempotent by source kind and policy dimension.

Run:

```bash
bun run build:schema
bun test test/source-registry-policy-service.test.ts
```

Expected: tests still fail at service behavior, not at missing tables.

- [ ] **Step 3: Implement seeded policy resolution**

Implement `source-policy.ts` and `source-registry-service.ts` so a granted source resolves the Phase 01 seeded matrix exactly. Source policy output must include:

- `ingest_mode`
- `index_mode`
- `extraction_mode`
- `raw_copy_mode`
- `chunk_retention`
- `llm_access`
- `runner_access`
- `automatic_canonical_write_authority`
- `candidate_route_conditions`
- `conflict_route_conditions`
- `forgetting_lifecycle`
- `restore_window`
- `purge_policy`
- `export_reconcile_behavior`

- [ ] **Step 4: Write and satisfy raw ingest tests**

`test/raw-ingest-provenance-service.test.ts` must prove:

- source item records include `origin_event`
- source chunks include hash, parser version, safety flags, and `expires_at`
- full raw copy is denied unless policy permits it
- prompt-injection flagged chunks cannot auto-write
- secret-bearing chunks produce redacted text for runner payloads
- source revocation prevents future raw access

Run:

```bash
bun test test/raw-ingest-provenance-service.test.ts test/raw-access-ledger-service.test.ts
```

Expected: PASS after implementing `raw-ingest.ts` and `raw-access-ledger.ts`.

- [ ] **Step 5: Run the phase gate and commit**

```bash
bun test test/source-registry-policy-service.test.ts test/raw-ingest-provenance-service.test.ts test/raw-access-ledger-service.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/source-registry src/core/services/source-registry-service.ts src/core/operations-source-registry.ts test/source-registry-policy-service.test.ts test/raw-ingest-provenance-service.test.ts test/raw-access-ledger-service.test.ts
git commit -m "feat: add source registry and raw ingest provenance"
```

## Task 3: Phase 03 Assertion Pipeline And Session Graph

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/assertions/assertion-types.ts`
- Create: `src/core/assertions/claim-extraction.ts`
- Create: `src/core/assertions/assertion-resolution.ts`
- Create: `src/core/assertions/assertion-evidence.ts`
- Create: `src/core/services/assertion-pipeline-service.ts`
- Create: `src/core/operations-assertions.ts`
- Modify: `src/core/services/task-memory-service.ts`
- Create: `test/assertion-pipeline-service.test.ts`
- Create: `test/assertion-evidence-service.test.ts`
- Create: `test/session-grants-service.test.ts`

- [ ] **Step 1: Write failing tests for extracted claims and assertions**

Tests must prove:

- source chunks create extracted claims with extractor kind, version, claim type, target hint, property hint, value, confidence, sensitivity, prompt-injection flag, and secret flag
- extracted claims resolve into assertions
- duplicate claims link to the existing assertion
- temporal updates supersede older assertions
- incompatible claims create conflict sets
- canonical retrieval excludes stale, expired, rejected, and candidate assertions by default

Run:

```bash
bun test test/assertion-pipeline-service.test.ts
```

Expected: FAIL because assertion schema and service code do not exist.

- [ ] **Step 2: Add assertion and work/session schema**

Add tables:

- `extracted_claims`
- `assertions`
- `assertion_events`
- `assertion_evidence`
- `assertion_lineage`
- `assertion_links`
- `conflict_sets`
- `conflict_set_assertions`
- `sessions`
- `task_events`
- `task_attempts_v2` or additive columns on existing `task_attempts`
- `working_sets_v2` or additive columns on existing `task_working_sets`
- `handoffs`
- `session_grants`
- `session_source_grants`
- `session_write_grants`

Use additive migration-compatible names when existing tables already own a concept. Do not drop existing `task_threads`, `task_attempts`, `task_decisions`, `task_working_sets`, or retrieval trace tables.

Run:

```bash
bun run build:schema
bun test test/assertion-pipeline-service.test.ts test/session-grants-service.test.ts
```

Expected: tests fail at missing behavior, not missing schema.

- [ ] **Step 3: Implement evidence fusion and session grants**

Implement:

- `assertion_evidence` many-to-many joins from assertion to extracted claim, source item, source chunk, session, and task event
- derived `authority_summary`, `confidence`, and `evidence_count`
- source revocation or source purge re-resolution
- `session_grants`, `session_source_grants`, and `session_write_grants` policy lookup helpers
- bidirectional links between task/session events and generated assertions

- [ ] **Step 4: Run the phase gate and commit**

```bash
bun test test/assertion-pipeline-service.test.ts test/assertion-evidence-service.test.ts test/session-grants-service.test.ts test/task-memory-service.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/assertions src/core/services/assertion-pipeline-service.ts src/core/operations-assertions.ts src/core/services/task-memory-service.ts test/assertion-pipeline-service.test.ts test/assertion-evidence-service.test.ts test/session-grants-service.test.ts
git commit -m "feat: add assertion pipeline and session graph"
```

## Task 4: Phase 04 Governed Canonical Write

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/canonical-write/write-policy.ts`
- Create: `src/core/canonical-write/mutation-planner.ts`
- Create: `src/core/canonical-write/projection-writer.ts`
- Create: `src/core/canonical-write/candidate-fallback.ts`
- Create: `src/core/services/governed-canonical-write-service.ts`
- Create: `test/governed-canonical-write-service.test.ts`
- Modify: `test/memory-writeback-router-service.test.ts`
- Modify: `test/page-write-precondition.test.ts`

- [ ] **Step 1: Write failing governance tests**

Tests must cover:

- `user_direct x decision` updates canonical projection automatically
- `agent_session x inferred_preference` becomes candidate
- `code_repo x code_claim` requires verify-first
- prompt-injection flagged claim cannot auto-write
- secret-bearing claim cannot canonicalize secret value
- conflict route creates or updates a conflict set
- failed Markdown projection write marks `pending_reconcile`
- mutation ledger records assertion ids, assertion evidence ids, extracted claim ids, source refs, policy explanation, before/after DB hash, and before/after Markdown hash

Run:

```bash
bun test test/governed-canonical-write-service.test.ts
```

Expected: FAIL because the governed write service does not exist.

- [ ] **Step 2: Implement policy and mutation planning**

Implement policy outcomes:

- `auto_canonical`
- `candidate`
- `verify_first`
- `conflict`
- `reject`
- `quarantine`
- `no_write`

Policy inputs must include source kind, source id, claim type, target certainty, confidence, sensitivity, prompt-injection flag, secret flag, conflict state, validity window, existing assertion state, user override policy, session/realm grant, and runner trust level.

- [ ] **Step 3: Implement immediate projection writer**

Immediate targets:

- project/system compiled truth
- project decision timeline
- user profile/preference projection
- personal episode summary
- active task resume/handoff
- high-importance contradiction resolution

Every projection mutation must reference assertion ids, assertion evidence ids, and source refs.

- [ ] **Step 4: Run the phase gate and commit**

```bash
bun test test/governed-canonical-write-service.test.ts test/memory-writeback-router-service.test.ts test/page-write-precondition.test.ts test/memory-mutation-ledger-service.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/canonical-write src/core/services/governed-canonical-write-service.ts test/governed-canonical-write-service.test.ts test/memory-writeback-router-service.test.ts test/page-write-precondition.test.ts
git commit -m "feat: add governed canonical writes"
```

## Task 5: Phases 05-06 Maintenance Runtime And Autopilot

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/maintenance/job-runtime.ts`
- Create: `src/core/maintenance/autopilot.ts`
- Create: `src/core/services/maintenance-runtime-service.ts`
- Create: `src/core/services/autopilot-service.ts`
- Create: `src/commands/autopilot.ts`
- Modify: `src/cli.ts`
- Create: `test/maintenance-runtime-service.test.ts`
- Create: `test/autopilot-service.test.ts`
- Create: `test/autopilot-cli.test.ts`

- [ ] **Step 1: Write failing job runtime tests**

Tests must prove:

- worker claims job with lock token
- stale lock can be reclaimed
- idempotency key prevents duplicate mutating job
- retry uses backoff and max attempts
- failed job records failure class
- queue submissions coalesce when wedged
- foreground pressure pauses between jobs
- jobs never mutate canonical memory outside Phase 04 policy

Run:

```bash
bun test test/maintenance-runtime-service.test.ts
```

Expected: FAIL because runtime service code does not exist.

- [ ] **Step 2: Implement job and lock schema**

Add:

- `maintenance_jobs`
- `maintenance_job_attempts`
- `maintenance_locks`
- `maintenance_heartbeats`
- `maintenance_progress`
- `maintenance_backpressure`

Use Postgres row locking for claim/reclaim behavior. Record lock owner, lease token, heartbeat timestamp, max attempts, failure class, and structured result.

- [ ] **Step 3: Implement autopilot install surfaces**

Autopilot must support:

- `launchd`
- `systemd`
- `cron`
- manual foreground process

The CLI command must print install instructions and generated unit/plist/cron content without enabling it silently. It must verify DB identity before printing activation commands.

- [ ] **Step 4: Run the phase gate and commit**

```bash
bun test test/maintenance-runtime-service.test.ts test/autopilot-service.test.ts test/autopilot-cli.test.ts test/doctor.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/maintenance/job-runtime.ts src/core/maintenance/autopilot.ts src/core/services/maintenance-runtime-service.ts src/core/services/autopilot-service.ts src/commands/autopilot.ts src/cli.ts test/maintenance-runtime-service.test.ts test/autopilot-service.test.ts test/autopilot-cli.test.ts
git commit -m "feat: add maintenance runtime and autopilot"
```

## Task 6: Phases 07-08 Dream Cycle And Lifecycle Forgetting

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/maintenance/dream-cycle.ts`
- Create: `src/core/maintenance/lifecycle-forgetting.ts`
- Modify: `src/core/services/dream-cycle-maintenance-service.ts`
- Create: `src/core/services/lifecycle-forgetting-service.ts`
- Create: `test/dream-cycle-phase-runner.test.ts`
- Create: `test/lifecycle-forgetting-service.test.ts`
- Modify: `test/dream-cycle-maintenance-service.test.ts`

- [ ] **Step 1: Write failing Dream phase runner tests**

Tests must prove:

- CLI dream and autopilot dream call the same phase runner
- phase family order is stable
- ownerless phase family reports `phase_not_available`
- dry-run does not mutate canonical memory
- mutating cycle uses cycle lock
- failed phase produces structured result
- policy denial appears in phase report
- Dream output has anti-loop markers preventing self-ingest
- unavailable runner degrades to deterministic/report-only behavior

Run:

```bash
bun test test/dream-cycle-phase-runner.test.ts
```

Expected: FAIL because the new Dream phase runner does not exist.

- [ ] **Step 2: Write failing forgetting tests**

Tests must prove:

- supersession expires older assertion
- expired assertion is hidden from default retrieval
- stale code claim returns verify-first marker
- archived assertion can restore within policy
- purge leaves tombstone
- source-specific retention changes purge eligibility
- source chunk purge re-resolves affected assertion evidence
- lifecycle state exists for source chunks, projections, task/session memory, and reports
- daily report includes purge candidates and restore windows

Run:

```bash
bun test test/lifecycle-forgetting-service.test.ts
```

Expected: FAIL because lifecycle tables and service code do not exist.

- [ ] **Step 3: Implement Dream and forgetting**

Dream phase family registry must include:

- `source_status`
- `source_sync`
- `raw_ingest`
- `safety_scan`
- `claim_extraction`
- `assertion_resolution`
- `canonical_write`
- `consolidation`
- `contradiction_review`
- `forgetting_review`
- `projection_reconcile`
- `embedding_refresh`
- `context_refresh`
- `daily_report`

Lifecycle storage must include `memory_lifecycle_states`, `forgetting_policies`, `forgetting_events`, `purge_plans`, `purge_plan_items`, `restore_events`, and `memory_tombstones`.

- [ ] **Step 4: Run the phase gate and commit**

```bash
bun test test/dream-cycle-phase-runner.test.ts test/lifecycle-forgetting-service.test.ts test/dream-cycle-maintenance-service.test.ts test/dream-cycle-maintenance-operations.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/maintenance/dream-cycle.ts src/core/maintenance/lifecycle-forgetting.ts src/core/services/dream-cycle-maintenance-service.ts src/core/services/lifecycle-forgetting-service.ts test/dream-cycle-phase-runner.test.ts test/lifecycle-forgetting-service.test.ts test/dream-cycle-maintenance-service.test.ts
git commit -m "feat: add dream cycle and lifecycle forgetting"
```

## Task 7: Phase 09 Restricted Claude/Codex Runner

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/runners/runner-registry.ts`
- Create: `src/core/runners/runner-policy.ts`
- Create: `src/core/runners/runner-jobs.ts`
- Create: `src/core/services/restricted-runner-service.ts`
- Create: `test/restricted-runner-service.test.ts`
- Create: `test/restricted-runner-policy.test.ts`

- [ ] **Step 1: Write failing runner tests**

Tests must prove:

- local Claude Code availability is detected without running arbitrary shell payloads
- local Codex availability is detected without granting repository write access
- unavailable local runner falls back according to priority
- each task type gets the correct tool allowlist
- denied tool calls fail closed
- raw access is redacted and logged
- runner proposals do not directly mutate canonical memory
- budget exhaustion degrades phase
- prompt-injection quarantined source is not sent to runner
- connector credentials are never available to runner tools

Run:

```bash
bun test test/restricted-runner-service.test.ts test/restricted-runner-policy.test.ts
```

Expected: FAIL because runner registry, policy, and job records do not exist.

- [ ] **Step 2: Implement runner records and policies**

Add:

- `runner_jobs`
- `runner_tool_calls`
- `runner_messages`
- `runner_artifacts`

Allowed maintenance task types:

- `assertion_extraction`
- `consolidation_review`
- `contradiction_review`
- `forgetting_review`
- `source_summary`
- `daily_report`

Denied by default:

- arbitrary `put_page`
- arbitrary file write
- shell execution
- connector credential access
- full raw source dump
- policy override
- direct purge execution
- direct canonical mutation bypassing policy

- [ ] **Step 3: Run the phase gate and commit**

```bash
bun test test/restricted-runner-service.test.ts test/restricted-runner-policy.test.ts test/raw-access-ledger-service.test.ts test/dream-cycle-phase-runner.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/runners src/core/services/restricted-runner-service.ts test/restricted-runner-service.test.ts test/restricted-runner-policy.test.ts
git commit -m "feat: add restricted memory runners"
```

## Task 8: Phase 10 System Of Record Reconciler

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/reconciler/projection-targets.ts`
- Create: `src/core/reconciler/markdown-contracts.ts`
- Create: `src/core/reconciler/system-of-record-reconciler.ts`
- Create: `src/core/services/system-of-record-reconciler-service.ts`
- Create: `test/system-of-record-reconciler-service.test.ts`
- Create: `test/markdown-projection-contracts.test.ts`

- [ ] **Step 1: Write failing reconciler tests**

Tests must prove:

- projection hash detects drift
- `repair_markdown` restores missing projection from canonical assertions
- `repair_db` repairs projection metadata without semantic assertion mutation
- `import_markdown_edit` creates a `markdown_file` source item with `origin_event = markdown_edit`
- conflicting DB and Markdown edits create conflict
- structured fence round-trips byte-stably for unchanged data
- runtime-only state is excluded from Markdown system-of-record checks
- doctor reports `pending_reconcile` and failed projections

Run:

```bash
bun test test/system-of-record-reconciler-service.test.ts test/markdown-projection-contracts.test.ts
```

Expected: FAIL because projection target registry and reconciler code do not exist.

- [ ] **Step 2: Implement projection targets and repair modes**

Projection targets:

- `markdown_page`
- `page_timeline`
- `profile_memory`
- `personal_episode`
- `task_resume`
- `project_doc`
- `system_doc`
- `source_summary`
- `daily_report`

Modes:

- `check`
- `repair_markdown`
- `repair_db`
- `import_markdown_edit`
- `rebuild_derived`
- `quarantine_conflict`

`repair_db` must never create or update semantic assertions directly from Markdown text.

- [ ] **Step 3: Run the phase gate and commit**

```bash
bun test test/system-of-record-reconciler-service.test.ts test/markdown-projection-contracts.test.ts test/page-projection-engine.test.ts test/doctor.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/reconciler src/core/services/system-of-record-reconciler-service.ts test/system-of-record-reconciler-service.test.ts test/markdown-projection-contracts.test.ts
git commit -m "feat: add system of record reconciler"
```

## Task 9: Phase 11 Personal Data Connectors

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Create: `src/core/connectors/connector-registry.ts`
- Create: `src/core/connectors/credential-refs.ts`
- Create: `src/core/connectors/connector-sync.ts`
- Create: `src/core/services/personal-data-connector-service.ts`
- Create: `src/commands/connectors.ts`
- Modify: `src/cli.ts`
- Create: `test/personal-data-connector-service.test.ts`
- Create: `test/credential-refs-service.test.ts`

- [ ] **Step 1: Write failing connector tests**

Tests must prove:

- connector registers source and policy
- credential reference is stored without raw secret
- credential priority is broker/gateway, OS keychain, password manager, local encrypted vault fallback
- sync is idempotent by external id and content hash
- revoked source prevents sync
- connector item becomes source item and chunks
- connector failure records health event
- source deletion maps to retention policy instead of silent purge

Run:

```bash
bun test test/personal-data-connector-service.test.ts test/credential-refs-service.test.ts
```

Expected: FAIL because connector registry and credential refs do not exist.

- [ ] **Step 2: Implement connector framework**

Target connector classes:

- agent/session import
- filesystem/Markdown/documents
- PDF/document import
- meeting transcripts
- code repositories
- email
- calendar
- browser/bookmarks/history
- chat exports
- Slack/Discord
- generic archive import

Connector output must be source items and chunks only. It must not write canonical assertions or projections directly.

- [ ] **Step 3: Run the phase gate and commit**

```bash
bun test test/personal-data-connector-service.test.ts test/credential-refs-service.test.ts test/source-registry-policy-service.test.ts test/raw-ingest-provenance-service.test.ts
bunx tsc --noEmit --pretty false
git add src/schema.sql src/core/schema-embedded.ts src/core/connectors src/core/services/personal-data-connector-service.ts src/commands/connectors.ts src/cli.ts test/personal-data-connector-service.test.ts test/credential-refs-service.test.ts
git commit -m "feat: add personal data connector framework"
```

## Task 10: Phases 12-13 Review, Audit, Health, Evaluation, Replay

**Files:**

- Create: `src/core/services/memory-review-report-service.ts`
- Create: `src/core/evaluation/memory-replay.ts`
- Create: `src/core/evaluation/memory-eval-cases.ts`
- Create: `src/commands/memory-report.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/cli.ts`
- Create: `test/memory-review-report-service.test.ts`
- Create: `test/memory-replay-service.test.ts`
- Create: `test/fixtures/mbrain-postgres-runtime/full-lifecycle.fixture.json`

- [ ] **Step 1: Write failing review and health tests**

Tests must prove the report includes:

- new canonical memories
- updated projections
- stale, expired, archived memories
- purge candidates and restore windows
- candidate/review items
- conflicts
- source ingest summary
- extraction summary
- runner/LLM token and cost estimates
- failed jobs
- reconciliation failures
- credential/source health

Run:

```bash
bun test test/memory-review-report-service.test.ts
```

Expected: FAIL because the review report service does not exist.

- [ ] **Step 2: Write failing replay tests**

The fixture `test/fixtures/mbrain-postgres-runtime/full-lifecycle.fixture.json` must cover:

- source registration
- raw ingest
- extraction
- assertion resolution
- canonical write
- candidate route
- conflict route
- lifecycle transition
- runner proposal
- reconciler drift
- connector sync
- purge/restore

Run:

```bash
bun test test/memory-replay-service.test.ts
```

Expected: FAIL because replay runner does not exist.

- [ ] **Step 3: Implement reports and replay**

Reports are exception-first and must support undo, restore, pin, reject, pause source, purge, and policy adjustment actions through existing governed operations. Replay must use fixture-driven deterministic inputs and compare structured outputs, not full prose snapshots.

- [ ] **Step 4: Run the phase gate and commit**

```bash
bun test test/memory-review-report-service.test.ts test/memory-replay-service.test.ts test/doctor.test.ts test/memory-operations-health-service.test.ts
bunx tsc --noEmit --pretty false
git add src/core/services/memory-review-report-service.ts src/core/evaluation src/commands/memory-report.ts src/commands/doctor.ts src/cli.ts test/memory-review-report-service.test.ts test/memory-replay-service.test.ts test/fixtures/mbrain-postgres-runtime/full-lifecycle.fixture.json
git commit -m "feat: add memory review reports and replay evaluation"
```

## Task 11: Phase 14 Migration And Cleanup

**Files:**

- Modify: `src/core/engine-factory.ts`
- Modify: `src/core/engine-capabilities.ts`
- Modify: `src/commands/migrate-engine.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `README.md`
- Modify: `docs/MBRAIN_VERIFY.md`
- Create: `test/postgres-runtime-migration-cleanup.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Tests must prove:

- fresh install targets Postgres without SQLite requirement
- target runtime commands reject SQLite/PGLite
- legacy DB-only state is called out for manual review
- migration verifies counts and hashes
- docs and CLI help describe Postgres-only target operation
- all old runtime feature paths either delegate to Postgres target or fail with actionable error

Run:

```bash
bun test test/postgres-runtime-migration-cleanup.test.ts
```

Expected: FAIL until the migration and cleanup surface is updated.

- [ ] **Step 2: Implement migration and cleanup**

Migration documentation and command output must explain:

- export current Markdown brain
- initialize Postgres
- sync/import Markdown into Postgres through source ingest and reconciler
- identify legacy DB-only state requiring manual review
- verify counts and hashes after migration
- keep no new SQLite parity requirement for target runtime features

- [ ] **Step 3: Run the final gate and commit**

```bash
bun test test/postgres-runtime-migration-cleanup.test.ts test/postgres-runtime-foundation.test.ts test/system-of-record-reconciler-service.test.ts
bunx tsc --noEmit --pretty false
bun test --timeout 20000
git add src/core/engine-factory.ts src/core/engine-capabilities.ts src/commands/migrate-engine.ts src/commands/doctor.ts README.md docs/MBRAIN_VERIFY.md test/postgres-runtime-migration-cleanup.test.ts
git commit -m "feat: complete postgres runtime migration cleanup"
```

## Final Integration Gate

Run after Task 11:

```bash
bun run build:schema
bunx tsc --noEmit --pretty false
bun test --timeout 20000
bun run build
```

Expected:

- schema generation produces no uncommitted drift
- TypeScript compile exits 0
- Bun test exits 0
- build exits 0

Also run:

```bash
git status --short --untracked-files=all
git log --oneline --decorate -12
```

Expected:

- no uncommitted tracked changes
- only intentional untracked reference material remains
- commits are ordered by phase and use conventional commit messages

## Self-Review Checklist

- Phase 00 is covered by Task 1.
- Phases 01-02 are covered by Task 2.
- Phase 03 is covered by Task 3, including assertion evidence and session grants.
- Phase 04 is covered by Task 4.
- Phases 05-06 are covered by Task 5.
- Phases 07-08 are covered by Task 6.
- Phase 09 is covered by Task 7.
- Phase 10 is covered by Task 8, including Markdown edit import through source ingest.
- Phase 11 is covered by Task 9.
- Phases 12-13 are covered by Task 10.
- Phase 14 is covered by Task 11.
- Cross-phase invariants from the implementation index are enforced by task gates and final integration gate.

Plan complete and saved to `docs/superpowers/plans/2026-05-20-mbrain-postgres-runtime-implementation.md`.

Execution options:

1. Subagent-Driven (recommended): dispatch a fresh worker per task and review each task before continuing.
2. Inline Execution: implement task-by-task in this session with verification checkpoints.
