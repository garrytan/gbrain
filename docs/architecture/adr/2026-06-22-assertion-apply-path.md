# ADR 2026-06-22 — Retire the dormant assertion / governed-write *apply* path

- Status: Accepted
- Date: 2026-06-22
- Decision gate: DG1 / Workstream F1 of `docs/post-review-improvements-2026-06-22-design.md`
- Decider: scott.lee (owner)

## Context

The 2026-06-22 gap analysis flagged ~4,100 LOC of assertion + governed-write
machinery as **dead structure**: `applyCanonicalWrite` /
`GovernedCanonicalWriteService`, `canonical-write-audit-store`,
`resolveExtractedClaimForEngine`, the in-memory assertion preview service, and the
dormant `preview_assertion_*` / `explain_*` MCP ops have **no production caller**.
The preview ops construct throwaway in-memory services; the live product direction
is the Memory-Inbox candidate ladder, not this apply pipeline.

Two options were on the table:

- **Option A — Retire** the dead apply machinery (recommended).
- **Option B — Wire it** as the real canonical gate (overlaps with D1; heavier).

The owner chose **Option A**.

## Investigation finding (scope correction)

While executing the retire, a dependency audit corrected the gap analysis on one
point. The assertion *tables* are not purely dead — they are **read by live
observability and one live feature**, even though no live op *populates* them in
production:

- `dream-cycle-runner-service.ts` counts `extracted_claims`, `conflict_sets`,
  `canonical_write_attempts`, and `canonical_projection_targets` in the
  `claim_extraction` / `contradiction_review` / `canonical_write` /
  `projection_reconcile` phases.
- `memory-report.ts` and `memory-review-report-service.ts` read several of these
  tables for the daily report.
- `doctor-service.ts` counts `canonical_projection_targets` for health.
- `lifecycle-forgetting.ts` reads and updates `assertions`, `assertion_evidence`,
  and `canonical_projection_reconcile_marks`.
- `assertion-pipeline-service.ts` is the assertion-creation harness used by the
  **live** `lifecycle-forgetting-service.test.ts` to exercise forgetting.

Dropping the tables would therefore break the dream cycle, the daily report, the
doctor, and the lifecycle-forgetting tests. Removing all of those reads as well
would be a multi-subsystem rewrite — forbidden by Invariant 9 (incremental
evolution, no rewrite-first).

## Decision

Retire the **dead writer path only**, and keep the schema + the read/observability
surface intact:

**Deleted (no production caller, fully isolated — only their own test files imported them):**

- `src/core/services/governed-canonical-write-service.ts` (`applyCanonicalWrite`,
  `GovernedCanonicalWriteService`)
- `src/core/assertions/canonical-write-audit-store.ts` (`recordCanonicalWriteAudit`)
- `src/core/assertions/assertion-resolution-store.ts` (`resolveExtractedClaimForEngine`)
- `src/core/assertions/assertion-resolution-audit-store.ts` (`recordAssertionResolutionAudit`)
- `src/core/assertions/assertion-lineage-store.ts` (backed only the dormant explain ops)
- MCP ops `preview_assertion_claim_extraction`, `preview_assertion_resolution`,
  `explain_assertion`, `explain_projection` (not surfaced in any real feature)
- Their dedicated test files

**Kept (referenced by live code):**

- The assertion / canonical-projection tables (read by dream-cycle, report, doctor;
  read+written by lifecycle-forgetting).
- `assertion-pipeline-service.ts` (live forgetting-test harness),
  `assertion-resolution.ts`, `assertion-evidence.ts`.
- `list_retrievable_assertions` + `assertion-retrieval-store.ts` (reads only the
  live `assertions` table).
- The grant-evaluation trio (`evaluate_session_source_grant`,
  `evaluate_session_write_grant`, `build_session_grant_policy_input`).

**No table-drop migration** is included: the tables are read by live observability.

## Forbidding the dormant middle state

`test/assertion-apply-path-retired.test.ts` asserts the retired ops are absent from
the operation registry and that the dead apply modules are not re-imported,
so the dead writer path cannot quietly return.

## Deferred (future spec)

Fully retiring the assertion tables requires first retiring the observability reads
(dream-cycle phases, report sections, doctor check) and the assertion side of
lifecycle-forgetting — a contained but multi-file change that should land as its own
spec rather than be bundled here. Until then the tables remain, read-only, reporting
zero in production.
