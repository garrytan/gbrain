# Engine dynamic-import reconciliation design

**Date:** 2026-07-28

## Goal

Reconcile the overlapping engine dynamic-import changes from:

- `claude/hungry-edison-8bb1cd` at release commits `48ada48f` and `248bfe55`
- `claude/elegant-gates-e5275e` at `ef4cf7a8`

onto a fresh branch from current `origin/master`, without merging or cherry-picking either lineage wholesale and without adding a release/version bump.

## Established state

At investigation time:

- `origin/master` was `6136e139972a5449630b4f47f5ed7b4cbe5b811b`, version `0.42.67.0`.
- Upstream PR #3511 was still open, so trunk did not contain its two `chronicle/ontology.ts` hoists.
- Neither source branch was an ancestor of trunk.
- Trunk contained 17 dynamic imports in the three engine-path files:
  - 13 safe-hoist candidates: two ontology imports, nine engine helper/audit imports, and two migration imports.
  - Four `ai/gateway.ts` imports, all inside `try/catch` fallback paths.
- `git log -G` showed the separate ontology, helper, migration, and gateway histories. `git log -S` is not suitable for this dynamic-to-static replacement because the relevant token can remain present while its context changes.
- The guard from `ef4cf7a8` passed against that commit but failed against trunk. It also knew about only two gateway opt-outs because two `_upsertChunksOnce` gateway lookups landed later in trunk.

## Selected approach

Reconstruct the intended current state directly on fresh `origin/master`.

Do not merge or cherry-pick either old lineage. Selectively reproduce the desired source changes, adapt the guard to the current four gateway call sites, and write current-state documentation. This avoids importing stale release metadata, stale TODO claims, and unrelated lineage changes.

## Source changes

### Safe static imports

Hoist all 13 safe candidates:

- `src/core/pglite-engine.ts`
  - `valueHash`, `normalizeDimension`, `isNovelDimension` from `chronicle/ontology.ts`
  - `isRetryableConnError` through the existing `retry.ts` import
  - `resolveRecencyDecayMap`, `DEFAULT_FALLBACK` from `search/recency-decay.ts`
- `src/core/postgres-engine.ts`
  - the same ontology, retry, and recency helpers
  - `isConnectionEndedError` from `retry-matcher.ts`
  - `logDbDisconnect` from `audit/db-disconnect-audit.ts`
  - `logPoolRecovery` from `audit/pool-recovery-audit.ts`
- `src/core/migrate.ts`
  - `isStatementTimeoutError`, `isRetryableConnError` from `retry-matcher.ts`
  - `repairTimelineDedupIndex` from `timeline-dedup-repair.ts`

The implementation must keep the two engines in parity where the behavior is shared. Comments should describe current invariants, not repeat an unproven causal claim that these hoists fix the Windows test-runner crash.

### Deliberately lazy gateway imports

Keep all four `await import('./ai/gateway.ts')` call sites lazy:

- PGLite `initSchema`
- PGLite `_upsertChunksOnce`
- Postgres `initSchema`
- Postgres `_upsertChunksOnce`

Each line receives the explicit `engine-dynamic-import-ok` marker and a concise nearby rationale.

The rationale has two parts:

1. The gateway's static closure includes the AI SDK, provider packages, and validation/config machinery, so eager loading would tax engine startup paths that do not otherwise need it.
2. More importantly, each lookup is inside a `try/catch` that preserves a soft fallback (compiled defaults or the brain's stored embedding-model config). Hoisting the module would evaluate it before that catch can run and could convert a recoverable configuration/import failure into a module-load-time hard failure.

The guard must not allow unmarked gateway imports or a broad file-level exemption.

## Guard and wiring

Add `scripts/check-engine-dynamic-import.sh`, adapted from `ef4cf7a8`, with these properties:

- Default scan set:
  - `src/core/pglite-engine.ts`
  - `src/core/postgres-engine.ts`
  - `src/core/migrate.ts`
- Normalize trailing CR before matching so CRLF checkouts cannot bypass the check.
- Ignore comment-only lines.
- Ignore only lines carrying `engine-dynamic-import-ok`.
- Report every unmarked `await import(` with file and line.
- Explain that contributors should prefer a static import and must justify a real opt-out.
- Avoid asserting that every dynamic import deterministically crashes Windows; the measured evidence supports treating the pattern as an engine-path hardening invariant, while box-level commit exhaustion remained a confound in prior runs.

Wire it into:

- `package.json` as `check:engine-dynamic-import`
- `package.json` `check:all`
- `scripts/run-verify-parallel.sh`

Follow trunk's current rule that package scripts invoke repository shell scripts through `bash`.

## Regression coverage

Add an automated test for the guard. It must cover:

- A real dynamic import produces exit 1 and is reported.
- A line carrying `engine-dynamic-import-ok` is allowed.
- Line comments and block-comment lines do not produce findings.
- The same violation is caught with CRLF input.
- The default repository scan passes after the source reconciliation.

Use a temporary fixture rather than mutating tracked source files. Keep assertions path-portable.

The pre-fix red demonstration is the exact guard from `ef4cf7a8` run against current trunk: it exits 1 and reports the existing unmarked imports. The post-fix guard and test must pass.

## Documentation policy

Preserve current behavior, not either old release narrative:

- Do not modify `VERSION` or add a release `CHANGELOG.md` entry.
- Do not copy old version headings or completed release TODO blocks.
- Do not retain the old TODO claiming that extracting gateway accessors is necessarily the fix; the lazy imports are deliberately protected by their local soft-failure boundaries.
- Add the cross-cutting no-unmarked-dynamic-import invariant to `CLAUDE.md`.
- Update the current-state entries for `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, and `src/core/migrate.ts` in `docs/architecture/KEY_FILES.md` where needed.
- Regenerate `llms.txt` and `llms-full.txt` after the documentation edits.
- Add a TODO only if implementation uncovers a real unresolved action.

Public documentation must use generic language and must not overstate the historical Windows crash causality.

## Verification

Capture full output to files before inspecting summaries. Run, at minimum:

1. The guard regression test.
2. `bash scripts/check-engine-dynamic-import.sh`.
3. Focused tests that exercise the touched engine, migration, retry, audit, and recency modules.
4. `bun run typecheck`.
5. `bun run verify`.
6. `bun run build:llms` followed by `bun test test/build-llms.test.ts`.
7. `git diff --check` and a final clean-status/diff review.

If platform contention or existing Windows suite defects block a broad test, report the exact command, exit code, and ownership classification rather than declaring success from a partial run.

## Git and publication boundary

- Work on `claude/kind-meitner-330c90`, reset locally to the exact investigated `origin/master` base.
- Preserve the previous worktree tip under `claude/kind-meitner-330c90-pre-reconcile`.
- Keep implementation and verification commits local.
- Do not push, create a PR, comment upstream, or otherwise publish without explicit user approval after the local result is complete.
