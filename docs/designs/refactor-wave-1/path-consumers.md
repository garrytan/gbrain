# Refactor wave 1: path-consumer inventory (O16, EO21)

Every script, workflow, test helper and doc that names a file this wave splits,
found with `rg -l` over `scripts/`, `.github/`, `test/helpers/`, `docs/` and the
root config and instruction files (the wave's own design record excluded).
Checked items were handled in lane W0b, before any move, so guards and
selectors cover the new locations from their first commit. Unchecked items
name the lane that must act when its move lands; "no change" items stay
unchecked only because nothing is required of them.

Classes used below:

- **scanner guard**: re-pointed in W0b to also scan the future dirs
  (`src/core/engine-sql/`, `src/core/schema-migrations/`, `src/commands/sync/`,
  `src/commands/doctor/checks/`, `src/commands/serve-http-*.ts`,
  `src/core/minions/handlers/`), each with a `bad-<dir>` fixture under
  `test/fixtures/guards/<guard>/` that fails on its own
  (`scripts/guard-self-test.sh`).
- **import consumer**: imports the façade; façades keep every export
  (CLAUDE.md "peeled façades keep their surface"), so no change.
- **entrypoint reference**: names `src/cli.ts` as the CLI entrypoint, which
  stays put.
- **reference doc**: current-state docs rewritten in W7 when the move lands.
- **historical record**: audit logs, plans and past reports; not updated.

Regenerate the raw list with, for example,
`rg -l -e 'core/migrate\.ts' scripts .github test/helpers docs`.

## `src/commands/sync.ts` (W4 sync → src/commands/sync/)

- [x] `docs/architecture/KEY_FILES.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [x] `docs/architecture/canonical-writers.tsv` — census rows follow the moved write sites (sync/deletes.ts, preflight.ts, renames.ts); the façade has none
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-5.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [x] `docs/architecture/key-files/commands-6.md` — façade note + new `src/commands/sync/` entry (W4 sync)
- [x] `docs/architecture/key-files/files-and-sync-1.md` — stale `sync.ts:1497-1519` line reference re-pointed to `resolveCliSyncSource` in sync/run.ts
- [x] `docs/architecture/key-files/files-and-sync-2.md` — cleanup-loop reference re-pointed to `sweepUnsyncableModified` in sync/deletes.ts
- [ ] `docs/architecture/key-files/runtime.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/designs/BRAIN_CURRENCY.md` — historical record: no action (describes past state)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/seam-callers.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [ ] `scripts/coverage-baseline.json` — coverage data: advisory watchlist names the façade; no corpus rows exist to transfer (no action)
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [x] `scripts/generate-flag-registry.ts` — facadeExpansion already scans src/commands/sync/; cli-flag-registry.generated.ts byte-identical (freshness guard)
- [x] `scripts/module-size-limits.tsv` — sync.ts ceiling 6022 -> 468; no sync/ module needs a row (all under the 1500 cap)
- [ ] `test/helpers/persistence-sync-interruption.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/commands/doctor.ts` (W4 doctor → src/commands/doctor/checks/)

- [x] `docs/architecture/KEY_FILES.md` — reference doc: index row names the façade path, which still exists: no change (W4 doctor)
- [x] `docs/architecture/frontmatter-scan-incremental.md` — reference doc: re-pointed in W4 doctor to `doctor/checks/content-quality.ts`
- [x] `docs/architecture/key-files/commands-2.md` — reference doc: W4 doctor: façade entry and ceiling rationale rewritten; new `doctor/registry.ts` + `context.ts` entry
- [x] `docs/architecture/key-files/commands-3.md` — reference doc: re-pointed in W4 doctor (`checkLinksExtractionLag` in `doctor/checks/extraction-sync.ts`); the other mention names the façade: no change
- [x] `docs/architecture/key-files/core-cycle.md` — reference doc: re-pointed in W4 doctor (`search-eval.ts` + `local-audits.ts`)
- [x] `docs/architecture/key-files/core-minions-1.md` — reference doc: re-pointed in W4 doctor (`doctor/checks/search-eval.ts`)
- [x] `docs/architecture/key-files/core-search-2.md` — reference doc: re-pointed in W4 doctor (`doctor/checks/calibration.ts`)
- [x] `docs/architecture/key-files/core-services-1.md` — reference doc: re-pointed in W4 doctor (`doctor/checks/verbs-reflex.ts`)
- [x] `docs/architecture/key-files/core-utilities-1.md` — reference doc: names the façade in a file list, which still holds; no change (W4 doctor)
- [x] `docs/architecture/key-files/files-and-sync-1.md` — reference doc: re-pointed in W4 doctor (`doctor/checks/consolidation-cycle.ts`)
- [x] `docs/architecture/key-files/schema-mutation.md` — reference doc: re-pointed in W4 doctor (`doctor/checks/embedding-health.ts`)
- [x] `docs/architecture/key-files/skills.md` — reference doc: re-pointed in W4 doctor (`doctor/skill-checks.ts`)
- [ ] `docs/designs/AGENT_BOOTSTRAP_PLAN.md` — historical record: no action (describes past state)
- [ ] `docs/designs/BRAIN_CURRENCY.md` — historical record: no action (describes past state)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [x] `scripts/check-no-legacy-getconnection.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/coverage-baseline.json` — coverage data: doctor has only a display-priority `watchlist` row naming the façade, which still exists; no exemptions or baseline rows to transfer (W4 doctor)
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/generate-flag-registry.ts` — generator (reads command text): facadeExpansion extended to sync|jobs|autopilot dirs in W0b; W4 cli re-targets it to the command table
- [ ] `scripts/live-brain-first-check.ts` — import consumer: façade keeps its exports: no action
- [x] `scripts/module-size-limits.tsv` — ratchet data: doctor.ts ceiling lowered 4340 -> 653 in W4 doctor; new modules are under the 1,500-line unlisted cap
- [x] `test/helpers/doctor-source.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files
- [ ] `test/helpers/wave-scenarios.ts` — test helper (import): façade keeps its exports: no action

## `src/commands/serve-http.ts` (W4 serve-http → src/commands/serve-http-*.ts)

- [ ] `docs/architecture/key-files/commands-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-5.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-utilities-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-utilities-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/entrypoints-and-docs.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/files-and-sync-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/google-and-loops-continued.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/mcp.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/security.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/tooling-and-tests.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/test-audit/2026-09-29/implementation/deletions-guards.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/security.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-doc-pins/doc-pins.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [ ] `docs/v0.38-smoke-test-report.md` — historical record: no action (describes past state)
- [ ] `scripts/build-admin-embedded.ts` — generator: names serve-http.ts as the embed consumer in comments/paths; recheck when serve-http-spa.ts lands
- [x] `scripts/check-no-legacy-getconnection.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-operations-filter-bypass.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/guards-manifest.tsv` — guard registry notes: update the note text if a guard's scanned paths change
- [ ] `scripts/module-size-limits.tsv` — ratchet data: lower/transfer ceilings with the moved code (C24); notes trimmed in W0b
- [ ] `scripts/structural-suites.tsv` — generated manifest: regenerate (`classify-tests.ts`) when tests are re-pointed; check-structural-manifest.sh diffs it
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/cli.ts` (W4 cli → command table)

- [ ] `.github/workflows/e2e.yml` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `.github/workflows/heavy-tests.yml` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `.github/workflows/native-locks.yml` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `.github/workflows/release.yml` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `.github/workflows/test.yml` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `AGENTS.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `CLAUDE.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `CONTRIBUTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/ENGINES.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/GBRAIN_V0.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/TESTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-6.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-ai.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-search-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-services-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-services-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-utilities-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-utilities-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/entrypoints-and-docs.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/files-and-sync-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/runtime.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/skills.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/tooling-and-tests.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/thin-client.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/topologies.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/designs/AGENT_BOOTSTRAP_PLAN.md` — historical record: no action (describes past state)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/guides/agent-to-gbrain.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/guides/minions-fix.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/integrations/qm-harness-snippets/provision-scopes.sh` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/integrations/qm-harness.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/issues/5284-reindex-markdown-investigation.md` — historical record: no action (describes past state)
- [ ] `docs/mcp/GROK-CLI-PIN.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/mcp/HERMES-CLI-PIN.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/protocol/MEMORY_VERBS_v1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/test-audit/2026-09-29/implementation/dead-modules.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/deletions-guards.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/rewrites.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/seam-callers.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/seams.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [ ] `docs/v0.38-smoke-test-report.md` — historical record: no action (describes past state)
- [ ] `package.json` — package exports / scripts: exports subpaths point at façades that keep their surface (O13 export golden): no change
- [ ] `scripts/bench-reindex-markdown.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/build-shared-skills-baseline.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/check-cli-executable.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/check-compile-autoload.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/check-key-files-current-state.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [x] `scripts/check-operations-filter-bypass.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [ ] `scripts/check-orphan-modules.mjs` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/check-skill-brain-first.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/check-skill-refs.mjs` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/ci-brainbench-gate.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/coverage-baseline.json` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/coverage-diff-gate.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/coverage-gate-exemptions.txt` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/dx-explore.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/generate-flag-registry.ts` — generator (reads command text): facadeExpansion extended to sync|jobs|autopilot dirs in W0b; W4 cli re-targets it to the command table
- [ ] `scripts/generate-plugin-tree.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/generate-template-repo.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/merge-lcov.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/module-size-limits.tsv` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/render-coverage-summary.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/skills-commit-gate.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `scripts/smoke-test.sh` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `test/helpers/agent-harness.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `test/helpers/cli-command-surface.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `test/helpers/cli-spawn.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [ ] `test/helpers/harness-access-journey.ts` — entrypoint reference: src/cli.ts stays the CLI entrypoint (compile, spawn, orphan-walk root): no change unless the line names moved code
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/commands/jobs.ts` (W4 jobs (cut line) → src/core/minions/handlers/)

- [ ] `docs/architecture/canonical-writers.tsv` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-4.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-6.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-minions-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/guides/plugin-handlers.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/test-audit/2026-09-29/implementation/rewrites.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/generate-flag-registry.ts` — generator (reads command text): facadeExpansion extended to sync|jobs|autopilot dirs in W0b; W4 cli re-targets it to the command table
- [ ] `scripts/module-size-limits.tsv` — ratchet data: lower/transfer ceilings with the moved code (C24); notes trimmed in W0b
- [ ] `test/helpers/facts-worker-config-contract.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/managed-atoms-contract.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/managed-facts-contract.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/core/search/hybrid.ts` (W4 hybrid (cut line) → named stages)

- [ ] `CONTRIBUTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/ENGINES.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/RETRIEVAL.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-search-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-services-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/runtime.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/eval-bench.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/dead-modules.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/rewrites.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/seam-callers.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [ ] `package.json` — package exports / scripts: exports subpaths point at façades that keep their surface (O13 export golden): no change
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/module-size-limits.tsv` — ratchet data: lower/transfer ceilings with the moved code (C24); notes trimmed in W0b
- [ ] `scripts/persistence/performance.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `scripts/persistence/read-workload.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/r1-namedthing-rerank-ab.ts` — import consumer: façade keeps its exports: no action
- [ ] `test/helpers/deep-research-contract.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/commands/autopilot.ts` (W4 autopilot (cut line) → dispatch table)

- [ ] `docs/architecture/key-files/commands-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-minions-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/files-and-sync-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/designs/BRAIN_CURRENCY.md` — historical record: no action (describes past state)
- [ ] `docs/designs/KNOWLEDGE_RUNTIME.md` — historical record: no action (describes past state)
- [ ] `docs/eval-bench.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/generate-flag-registry.ts` — generator (reads command text): facadeExpansion extended to sync|jobs|autopilot dirs in W0b; W4 cli re-targets it to the command table
- [ ] `scripts/module-size-limits.tsv` — ratchet data: lower/transfer ceilings with the moved code (C24); notes trimmed in W0b
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/core/migrate.ts` (W3 → src/core/schema-migrations/)

- [x] `.github/workflows/e2e.yml` — CI cache key (hashFiles): globbed in W3; `test/snapshot-inputs-closure.test.ts` (EO7) checks every key covers the hash inputs
- [x] `.github/workflows/test.yml` — CI cache key (hashFiles): globbed in W3; `test/snapshot-inputs-closure.test.ts` (EO7) checks every key covers the hash inputs
- [ ] `CLAUDE.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/TESTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/canonical-writers.tsv` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/frontmatter-scan-incremental.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/infra-layer.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-4.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/engines-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/tooling-and-tests.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/pack-upgrade-mechanism.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/designs/VECTOR_BACKENDS.md` — historical record: no action (describes past state)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/guides/rls-and-you.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/superpowers/plans/2026-07-28-engine-dynamic-import-reconciliation.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/specs/2026-07-28-engine-dynamic-import-reconciliation-design.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/e2e-lanes.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [x] `scripts/check-engine-dynamic-import.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-jsonb-params.mjs` — scanner guard: scans src/ and scripts/ recursively (new dirs included); the JSONB column list comment points at src/core/schema-migrations/ (W3)
- [x] `scripts/check-jsonb-pattern.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-layering.ts` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-source-config-leak.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [ ] `scripts/coverage-baseline.json` — coverage data: exemptions and baseline rows transfer with moved code (net shrink)
- [x] `scripts/coverage-gate-exemptions.txt` — coverage data: the migrate.ts exemption transfers to `src/core/schema-migrations/` (W3)
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/module-size-limits.tsv` — ratchet data: migrate.ts 723 region-exempt -> 599 ratchet (W3)
- [x] `scripts/select-e2e.ts` — E2E selector: schema-migrations/ escape hatch added in W0b
- [ ] `test/helpers/executor-binding-matrix.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/extract-added-columns.ts` — test helper (reads migrate text): reads surfaceSource('migrate') since W0b, so split migrations stay in its ADD COLUMN scan
- [ ] `test/helpers/minion-authority-upgrade.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files

## `src/core/pglite-schema.ts` (W2 → pglite-schema.generated.ts)

- [x] `.github/workflows/e2e.yml` — CI cache key (hashFiles): globbed in W3; `test/snapshot-inputs-closure.test.ts` (EO7) checks every key covers the hash inputs
- [x] `.github/workflows/test.yml` — CI cache key (hashFiles): globbed in W3; `test/snapshot-inputs-closure.test.ts` (EO7) checks every key covers the hash inputs
- [ ] `CLAUDE.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/ENGINES.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/TESTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/canonical-writers.tsv` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/engines-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/files-and-sync-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/runtime.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [x] `scripts/check-jsonb-pattern.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-search-path.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `test/helpers/schema-diff.test.ts` — test helper (hint text): hints point at src/schema.sql + `bun run build:schema` (W2)
- [x] `test/helpers/schema-diff.ts` — test helper (hint text): hints point at src/schema.sql, the PGLite rules and `bun run build:schema` (W2)

## `src/schema.sql` (W2 → generated fragment regions)

- [ ] `CONTRIBUTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/GBRAIN_V0.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/TESTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/infra-layer.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/engines-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/entrypoints-and-docs.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/files-and-sync-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/providers.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/designs/COMMUNITY_IDEAS.md` — historical record: no action (describes past state)
- [ ] `docs/designs/VECTOR_BACKENDS.md` — historical record: no action (describes past state)
- [ ] `docs/guides/rls-and-you.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [x] `scripts/build-schema.sh` — schema generator: one-line wrapper around `scripts/build-schema.ts`, the generated-schema chain (W2, EO12)
- [x] `scripts/check-jsonb-pattern.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-search-path.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/select-e2e.ts` — E2E selector: schema-migrations/ escape hatch added in W0b
- [x] `test/helpers/schema-diff.ts` — test helper (hint text): hints point at src/schema.sql, the PGLite rules and `bun run build:schema` (W2)

## `src/core/pglite-engine.ts + src/core/pglite-engine/` (W1 → src/core/engine-sql/)

- [x] `.github/workflows/e2e.yml` — CI cache key (hashFiles): globbed in W3; `test/snapshot-inputs-closure.test.ts` (EO7) checks every key covers the hash inputs
- [x] `.github/workflows/test.yml` — CI cache key (hashFiles): globbed in W3; `test/snapshot-inputs-closure.test.ts` (EO7) checks every key covers the hash inputs
- [ ] `CLAUDE.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `CONTRIBUTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/ENGINES.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/TESTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/canonical-writers.tsv` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/frontmatter-scan-incremental.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-services-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-utilities-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/engines-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/runtime.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/tooling-and-tests.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/designs/BRAIN_CURRENCY.md` — historical record: no action (describes past state)
- [ ] `docs/eval-bench.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/issues/5284-reindex-markdown-investigation.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/plans/2026-07-28-engine-dynamic-import-reconciliation.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/plans/2026-07-30-scalar-source-backlink-validation.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/specs/2026-07-28-engine-dynamic-import-reconciliation-design.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/deletions-guards.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/e2e-lanes.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-e2e/e2e.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/seam-callers.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/pertest.json` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/source-grep.md` — historical record: no action (describes past state)
- [ ] `package.json` — package exports / scripts: exports subpaths point at façades that keep their surface (O13 export golden): no change
- [ ] `scripts/bench-grandfather-5530.ts` — import consumer: façade keeps its exports: no action
- [x] `scripts/build-pglite-snapshot.ts` — snapshot builder: hash inputs come from the import closure (`src/core/snapshot-schema-inputs.ts`, W3); E1 adds the engine-sql bootstrap root
- [x] `scripts/check-engine-dynamic-import.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [ ] `scripts/check-fuzz-purity.sh` — buildfresh guard (forbidden-import list): add src/core/engine-sql/ to the forbidden list when W1 creates it
- [x] `scripts/check-layering.ts` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-no-double-retry.sh` — scanner guard: scans src/ recursively (new dirs included); engines named only in the message
- [x] `scripts/check-source-id-projection.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [ ] `scripts/coverage-baseline.json` — coverage data: exemptions and baseline rows transfer with moved code (net shrink)
- [ ] `scripts/coverage-gate-exemptions.txt` — coverage data: exemptions and baseline rows transfer with moved code (net shrink)
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/module-size-limits.tsv` — ratchet data: lower/transfer ceilings with the moved code (C24); notes trimmed in W0b
- [ ] `scripts/persistence/harness.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/persistence/performance.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `scripts/persistence/read-workload.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/persistence/validate.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `scripts/pglite-checkpoint-harness/supervisor.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/pglite-checkpoint-harness/worker.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/pglite-embedded-smoketest.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/r1-namedthing-rerank-ab.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/run-eval-canary.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/shared-skills/lifecycle.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `test/helpers/agent-harness.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/connector-fixture.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/connector-restart.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/google-attachment-restart.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/google-attachments-command.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/maintenance-restart.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/memory-safety-wave-repair.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/migration-wave-budget-process.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/migration-wave-fixture.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/persistence-request-fixture.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/repeated-consolidation.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/reset-pglite-narrow.test.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/reset-pglite.test.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/reset-pglite.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/shared-skills-engine.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files
- [ ] `test/helpers/withdrawal-effect-process.ts` — test helper (import): façade keeps its exports: no action

## `src/core/postgres-engine.ts + src/core/postgres-engine/` (W1 → src/core/engine-sql/)

- [ ] `CLAUDE.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `CONTRIBUTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/TESTING.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/canonical-writers.tsv` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/frontmatter-scan-incremental.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/commands-3.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-services-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/core-services-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/engines-1.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/engines-2.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/runtime.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/architecture/key-files/tooling-and-tests.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/eval-bench.md` — reference doc: update the path when the move lands (W7 docs rewrite; key-files entries)
- [ ] `docs/eval/FIX_WAVE_BASELINES.md` — historical record: no action (describes past state)
- [ ] `docs/issues/cross-modal-search.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/plans/2026-07-28-engine-dynamic-import-reconciliation.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/plans/2026-07-30-scalar-source-backlink-validation.md` — historical record: no action (describes past state)
- [ ] `docs/superpowers/specs/2026-07-28-engine-dynamic-import-reconciliation-design.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/README.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/holes.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/implementation/pending-deletions.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/bundled-src.txt` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/seams.md` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-seams/test-only-exports.tsv` — historical record: no action (describes past state)
- [ ] `docs/test-audit/2026-09-29/lane-source-grep/source-grep.md` — historical record: no action (describes past state)
- [x] `scripts/check-engine-dynamic-import.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [ ] `scripts/check-fuzz-purity.sh` — buildfresh guard (forbidden-import list): add src/core/engine-sql/ to the forbidden list when W1 creates it
- [x] `scripts/check-layering.ts` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-no-double-retry.sh` — scanner guard: scans src/ recursively (new dirs included); engines named only in the message
- [x] `scripts/check-no-legacy-getconnection.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [x] `scripts/check-source-id-projection.sh` — scanner guard: re-pointed in W0b: scans the new dirs, bad fixture inside each
- [ ] `scripts/coverage-baseline.json` — coverage data: exemptions and baseline rows transfer with moved code (net shrink)
- [ ] `scripts/coverage-gate-exemptions.txt` — coverage data: exemptions and baseline rows transfer with moved code (net shrink)
- [x] `scripts/e2e-test-map.ts` — E2E selector map: engine-sql/** mapped to both engines in W0b; moving lanes add rows for new modules
- [x] `scripts/function-size-baseline.tsv` — ratchet data (W5): rows move with `check-function-size.ts --transfer` in the move-only commit
- [ ] `scripts/module-size-limits.tsv` — ratchet data: lower/transfer ceilings with the moved code (C24); notes trimmed in W0b
- [ ] `scripts/persistence/harness.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/persistence/matrix-cases.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/persistence/performance.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `scripts/persistence/read-workload.ts` — import consumer: façade keeps its exports: no action
- [ ] `scripts/persistence/validate.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `scripts/shared-skills/lifecycle.ts` — provenance source hashes: add the moved modules to the hashed file list when the move lands
- [ ] `scripts/smoke-test-mcp.ts` — import consumer: façade keeps its exports: no action
- [ ] `test/helpers/connector-restart.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/google-attachment-restart.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/google-attachments-command.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/maintenance-restart.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/memory-safety-wave-repair.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/migration-wave-budget-process.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/persistence-postgres.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/persistence-request-fixture.ts` — test helper (import): façade keeps its exports: no action
- [ ] `test/helpers/physical-root-claim-child.ts` — test helper (import): façade keeps its exports: no action
- [x] `test/helpers/source-surface.ts` — test helper (A10 loader): surface loaders; a moving lane adds its destination files
- [ ] `test/helpers/withdrawal-effect-process.ts` — test helper (import): façade keeps its exports: no action
