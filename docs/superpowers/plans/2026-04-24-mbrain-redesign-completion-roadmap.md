# MBrain Redesign Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the completed redesign work through PR #51 and define the final acceptance closure gate for `mbrain`.

**Architecture:** The completion path remains loop-first: `retrieval_traces.id` is the agent-turn identity, linked governance event rows attach by `interaction_id`, and audit reads trace/write joins instead of free-form strings. Canonical Markdown and operational records remain truth; maps, atlases, embeddings, and audit reports are orientation or evaluation artifacts unless explicitly promoted through governance.

**Tech Stack:** Bun, TypeScript, SQLite (`bun:sqlite`), PGLite, Postgres, existing `BrainEngine` boundary, `operations.ts` operation registry, scenario tests under `test/scenarios`, GitHub Actions.

---

## Current Integrated State

As of 2026-04-25 on `origin/master` after PR #51:

- PR #38 is merged: Sprint 1.0 interaction identity foundation.
- PR #39 is merged: Postgres JSONB persistence correctness and legacy scalar-string repair.
- PR #40 is merged: Sprint 1.1A retrieval trace fidelity fields.
- PR #41 is merged: redesign completion roadmap.
- PR #42 is merged: Sprint 1.1B brain-loop audit.
- PR #43 is merged: completion-roadmap refresh.
- PR #44-#48 are merged: Sprint 0 TypeScript baseline cleanup and CI enforcement.
- PR #49 is merged: L1 request-level decomposition, closing S5.
- PR #50 is merged: L2 canonical-first broad synthesis ranking, closing S9.
- PR #51 is merged: L4 code-claim verification before reuse, closing S11.
- Latest merge commit: `c8c41c2 Merge pull request #51 from meghendra6/sprint-4-code-claim-verification`.
- `audit_brain_loop` exists and reports trace counts, intent/scope/gate distributions, canonical-vs-derived counts, linked write counts, approximate unlinked-candidate counts, task compliance, and summary lines.
- `bunx tsc --noEmit --pretty false` is green locally and is enforced in CI before `bun test`.
- `test/scenarios` has zero placeholders; S5, S9, and S11 are real green tests.
- Final local verification before closure PR: scenarios `61 pass / 2 skip / 0 fail`; full suite `1219 pass / 145 skip / 0 fail`.

The only remaining item in this roadmap is final acceptance closure:

- update verification and acceptance docs with the completed state
- record the redesign completion retrospective
- verify zero scenario placeholders, clean `tsc`, full suite success, build success, diff cleanliness, and CLI audit JSON on the final integrated state
- merge the closure PR after final subagent review and GitHub CI

## Completion Definition

`mbrain` is considered complete against the current redesign set when all of these are true:

- `mbrain audit-brain-loop --since 24h --json` returns a structured report with trace counts, intent/scope/gate distributions, canonical-vs-derived counts, linked-write counts, approximate unlinked-candidate counts, task compliance, and summary lines.
- Linked write counts are computed by joining `retrieval_traces.id` to event-table `interaction_id`, not by parsing free-form text.
- The audit CLI behavior is verified again after the final acceptance branch lands, not only by PR #42's service and operation tests.
- Every scenario placeholder in `test/scenarios` is replaced by a real test or intentionally removed because the scenario is covered by a stricter test.
- `bun run test:scenarios` reports zero failing tests and zero scenario placeholders.
- `bun test` reports zero failing tests.
- `bunx tsc --noEmit --pretty false` reports zero errors locally and runs in CI before `bun test`.
- GitHub Actions include the existing default test job, gitleaks, E2E Tier 1, and the Postgres JSONB job from PR #39.
- The final docs state which invariants are implemented and which future product extensions are outside the redesign completion boundary.

## Dependency Graph

| Order | Scope | Branch Name | Depends On | Merge Gate | Status |
|---|---|---|---|---|---|
| 1 | Sprint 1.1B loop audit | `sprint-1.1b-loop-audit` | `master` after PR #40 | Audit scenarios green, full tests green | Done in PR #42, merge `528b07d` |
| 2a | Sprint 0 tsc baseline: engine contract | `sprint-0.1-tsc-engine-contract` | `origin/master` after PR #42 | `runMigration`/`SQLiteEngine` TypeScript family eliminated, focused tests green | Done in PR #44, merge `c1991ec` |
| 2b | Sprint 0 tsc baseline: SQL/JSON binding types | `sprint-0.2-tsc-sql-json-mappers` | 2a | SQL binding, JSON parameter, and mapper callback TypeScript families eliminated | Done in PR #45, merge `6e9b046` |
| 2c | Sprint 0 tsc baseline: domain boundary types | `sprint-0.3-tsc-domain-boundaries` | 2b | config, file resolver, pglite lock, services, and storage TypeScript families eliminated | Done in PR #46, merge `e70dab4` |
| 2d | Sprint 0 tsc baseline: test fixture types | `sprint-0.4-tsc-test-fixtures` | 2c | test/scenario fixture TypeScript families eliminated | Done in PR #47, merge `f20be12` |
| 2e | Sprint 0 tsc baseline: CI enforcement | `sprint-0.5-tsc-ci` | 2d | `bunx tsc --noEmit --pretty false` green locally and in CI before `bun test` | Done in PR #48, merge `54a65e1` |
| 3 | L1 request decomposition | `sprint-2-request-decomposition` | Sprint 0 typecheck CI merged | S5 placeholder replaced and green | Done in PR #49, merge `b5227f2` |
| 4 | L2 canonical-first ranking | `sprint-3-canonical-first-ranking` | Sprint 0 typecheck CI merged | S9 placeholders replaced and green | Done in PR #50, merge `8c750bc` |
| 5 | L4 code claim verification | `sprint-4-code-claim-verification` | Sprint 0 typecheck CI merged | S11 placeholders replaced and green | Done in PR #51, merge `c8c41c2` |
| 6 | Final acceptance closure | `sprint-final-acceptance-closure` | 2a-5 | No scenario placeholders, `tsc` green, full suite green, CLI audit verified | Current |

## Completed Work

### Track A: TypeScript Baseline and CI

Detailed plan: `docs/superpowers/plans/2026-04-25-mbrain-sprint-0-tsc-baseline-current-plan.md`.

Result:

- The previous TypeScript baseline was removed across PR #44-#48.
- Runtime behavior was preserved while tightening types.
- `bunx tsc --noEmit --pretty false` now runs in CI before `bun test`.

### Track B: Scenario Contracts

Detailed plan: `docs/superpowers/plans/2026-04-25-mbrain-remaining-redesign-contracts-plan.md`.

Result:

- S5 L1 request decomposition is implemented by a deterministic request planner.
- S9 L2 canonical-first ranking prefers curated canonical notes over map-derived suggestions for the implemented conflict path.
- S11 L4 code-claim verification distinguishes historical memory from current workspace truth before task resume repeats code-sensitive facts.
- The final acceptance closure is the only remaining PR.

## Retrospective Adjustments

The architecture does not need a redesign after PR #51. The core choice remains correct: measurement only became reliable after interaction identity existed, trace fidelity existed, and linked writes could be joined by `interaction_id`.

The execution lessons are:

- Foundation first was correct: interaction identity, trace fidelity, audit, typecheck, and scenario contracts each landed as separate reviewable PRs.
- Splitting Sprint 0 into small PRs kept type cleanup mechanical and prevented a broad "make tsc green" branch from hiding behavior changes.
- L1, L2, and L4 stayed separate semantic PRs, which made subagent review findings easier to reproduce with focused tests.
- Critical subagent review remains required after each meaningful implementation commit, but review findings are hypotheses. They must be checked against design docs, code, and tests before implementation.
- Local worktree state must be treated carefully. New implementation starts from a clean worktree based on latest `origin/master`; do not reuse stale or dirty branches for new PRs.

## Non-Goals Until Completion

These remain explicitly outside the current completion boundary:

- Trace retention, TTL, or pruning.
- Dashboard/UI for loop observability.
- Scheduled cron automation for `audit_brain_loop`.
- Full `memory_candidate_status_events` event log for capture/advance/reject correlation.
- Active-only task compliance metric. Current audit reports all task threads in scope; active-only compliance can be added later if product policy requires it.

## Review Discipline for Every PR

Each PR follows the same checkpoint loop:

- Before implementation: create or switch to a clean worktree based on latest `origin/master`, then confirm branch base and current test state.
- For each task: write the failing test first, run it, implement the minimum fix, run focused tests, commit.
- After each meaningful commit: request a critical subagent review focused on correctness, scope creep, backend parity, and missing tests.
- Treat review comments as hypotheses, not commands. Verify against code and tests before changing behavior.
- Before merge: run focused tests, full `bun test`, `bun run build`, `git diff --check`, and `bunx tsc --noEmit --pretty false` once Track A is merged.
- Merge only one PR at a time. Rebase or retarget stacked branches after the base PR lands.

## Execution Recommendation

Proceed with PR 6 only:

1. Update final verification, acceptance, scenario, roadmap, and retrospective docs.
2. Run zero-placeholder scan, `tsc`, scenarios, full tests, build, diff check, and CLI audit verification.
3. Request final critical subagent review and fix all valid findings.
4. Open and merge `sprint-final-acceptance-closure` only after GitHub CI is green.

No additional implementation PR is required inside the current redesign
completion boundary.

## Self-Review

- Spec coverage: PR #42 covers Sprint 1.1B. Track A covers `2026-04-24-mbrain-sprint-0-tsc-baseline-design.md`. Track B covers scenario invariants L1, L2, and L4 from `2026-04-23-mbrain-scenario-test-design.md`. Final acceptance closes `08-evaluation-and-acceptance.md`.
- Dependency check: L1/L2/L4 landed after Track A, so new feature work was protected by CI typecheck.
- Type consistency: Stable names remain `AuditBrainLoopReport`, `RetrievalTraceWindowFilters`, `audit_brain_loop`, `plan_retrieval_request`, and `reverify_code_claims`.
- Scope control: Candidate status-event logs, dashboards, pruning, cron automation, and active-only compliance are explicitly excluded from this completion boundary.
