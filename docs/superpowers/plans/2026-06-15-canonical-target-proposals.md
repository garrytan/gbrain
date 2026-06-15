# Canonical Target Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or follow this plan task-by-task with TDD. Tasks are mostly sequential because schema/types unlock services, and review/binding depends on draft storage. Do not skip RED/GREEN verification, and do not bypass the proposal/governance boundary.

**Goal:** Give targetless Memory Inbox candidates a safe canonical-home workflow: automatically create reviewable canonical target proposals, approve/reject them explicitly, bind approved candidates only through audited governance, and stage missing-page stubs through existing patch-candidate review/apply paths.

**Design:** `docs/superpowers/specs/2026-06-15-canonical-target-proposals-design.md`

**Non-negotiable safety rules:**

- Do not write speculative targets into `memory_candidate_entries.target_object_*`.
- Do not call `put_page` from proposal approval.
- Missing pages are created only through `create_memory_patch_candidate` with `base_target_snapshot_hash=null`, followed by existing review/apply.
- Candidate target binding must emit proposal status events, candidate status events, and memory mutation events.
- `patch_staged` has explicit completion and recovery paths.

---

## Task 1: Schema, Types, And Engine Contract

**Owner:** schema/engine worker

**Files:**

- Modify: `src/core/types/memory-governance.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/core/migrate.ts`
- Modify: `src/schema.sql`
- Regenerate: `src/core/schema-embedded.ts`
- Modify: `src/core/pg-engine-base.ts`
- Modify: `src/core/sqlite-engine.ts`
- Test: `test/canonical-target-proposals-schema.test.ts`
- Test: `test/canonical-target-proposals-engine.test.ts`

**Steps:**

- [ ] RED: Add schema tests proving fresh PGLite and SQLite databases contain:
  `canonical_target_proposal_entries`,
  `canonical_target_proposal_status_events`, required indexes, and status checks.
- [ ] RED: Add engine tests for:
  create/list/get proposal,
  create/list proposal status event,
  update proposal status with optimistic expected status,
  `bindMemoryCandidateTarget` success and stale unresolved-shape failure.
- [ ] Add proposal entry/status-event types and filters.
- [ ] Add `bindMemoryCandidateTarget` patch type.
- [ ] Add mutation operation names:
  `create_canonical_target_proposal`,
  `approve_canonical_target_proposal`,
  `reject_canonical_target_proposal`,
  `complete_canonical_target_proposal_binding`,
  `bind_memory_candidate_target`.
- [ ] Add `canonical_target_proposal` target kind if mutation ledger target typing needs it.
- [ ] Add engine methods:
  `createCanonicalTargetProposalEntry`,
  `getCanonicalTargetProposalEntry`,
  `listCanonicalTargetProposalEntries`,
  `updateCanonicalTargetProposalStatus`,
  `createCanonicalTargetProposalStatusEvent`,
  `listCanonicalTargetProposalStatusEvents`,
  `bindMemoryCandidateTarget`.
- [ ] Add migration v55 and baseline `schema.sql`.
- [ ] Run `bun run build:schema`.
- [ ] GREEN: Run:
  `bun test test/canonical-target-proposals-schema.test.ts test/canonical-target-proposals-engine.test.ts`.
- [ ] Commit:
  `feat(memory): add canonical target proposal storage`

---

## Task 2: Proposal Drafting And Creation Service

**Owner:** service worker

**Files:**

- Create: `src/core/services/canonical-target-proposal-draft-service.ts`
- Test: `test/canonical-target-proposal-service.test.ts`

**Steps:**

- [ ] RED: Add service tests for draft classification:
  `null/null`, `curated_note/null`, `other/null`, selected `procedure/null`.
- [ ] RED: Add refusal tests for terminal candidates, refuted candidates, empty source refs, personal/secret/unknown sensitivity, non-empty target id.
- [ ] RED: Add blocked draft tests for unstable subject identity, likely duplicate, and hard slug-quality errors.
- [ ] RED: Add no-proposal tests for low-importance one-off task mechanics.
- [ ] RED: Add idempotence/refresh tests:
  repeated create for the same candidate and same proposed slug refreshes the existing active proposal instead of creating duplicates,
  changed proposed slug supersedes the older active proposal with a status event.
- [ ] RED: Add blocked/superseded lifecycle tests so dream-generated proposals cannot create duplicate active rows.
- [ ] Implement deterministic draft rules:
  project/system/tool names -> systems/projects slugs,
  product/business idea -> ideas namespace,
  original user thesis -> originals namespace,
  reusable technical concept -> concepts namespace,
  one-off task mechanics -> no proposal unless high importance/recurrence.
- [ ] Reuse `findSlugQualityIssues` and `reviewDuplicateMemory`.
- [ ] Implement `createCanonicalTargetProposalDraft` and `createCanonicalTargetProposal` service:
  `apply=false` returns draft only,
  `apply=true` writes or refreshes `proposed` or `blocked` proposal and a proposal status event,
  changed proposed slugs supersede older active proposals.
- [ ] GREEN: Run:
  `bun test test/canonical-target-proposal-service.test.ts`.
- [ ] Commit:
  `feat(memory): draft canonical target proposals`

---

## Task 3: Governed Binding And Proposal Review Service

**Owner:** governance worker

**Files:**

- Create: `src/core/services/canonical-target-proposal-review-service.ts`
- Import from: `src/core/services/canonical-target-proposal-draft-service.ts`
- Test: `test/canonical-target-proposal-review-service.test.ts`
- Test: `test/canonical-target-proposal-binding.test.ts`

**Steps:**

- [ ] RED: Add tests that `bindMemoryCandidateTarget` service wrapper records:
  candidate status event with `from_status=to_status`,
  memory mutation event for `bind_memory_candidate_target`,
  unchanged candidate status.
- [ ] RED: Add approval-to-existing-page tests:
  approve delegates to complete binding,
  all candidates bind all-or-nothing,
  proposal becomes `bound`,
  proposal status event and memory mutation event are emitted.
- [ ] RED: Add linked-candidate revalidation tests for both approval and completion:
  mixed scope blocks,
  mixed sensitivity blocks,
  emptied `source_refs` blocks,
  refuted candidate blocks,
  terminal linked candidate blocks,
  target shape drift blocks.
- [ ] RED: Add stale-race tests:
  candidate promoted/rejected/re-targeted before binding blocks proposal and binds none.
- [ ] RED: Add approved-but-unbound tests:
  missing page + `create_missing_page_stub=false` leaves proposal `approved`,
  later completion while page is still absent returns pending and preserves `approved`.
- [ ] RED: Add missing-page approval tests:
  approval stages a patch candidate with `base_target_snapshot_hash=null`,
  proposal becomes `patch_staged`,
  no `put_page` occurs,
  patch body is structural-only,
  patch body includes source-attributed timeline evidence,
  patch body does not promote the source candidate claim into compiled truth.
- [ ] RED: Add final page-existence race test:
  page appears before stub staging, so approval binds to that page instead of staging a stub.
- [ ] RED: Add `patch_staged` completion/recovery tests:
  applied stub + page exists -> bound,
  rejected -> blocked,
  superseded with replacement proposal -> superseded,
  superseded without replacement proposal -> blocked,
  failed/conflicted -> blocked,
  applied but page missing -> blocked,
  pending -> remains `patch_staged`.
- [ ] Implement services:
  `bindMemoryCandidateTargetGoverned`,
  `approveCanonicalTargetProposal`,
  `rejectCanonicalTargetProposal`,
  `completeCanonicalTargetProposalBinding`.
- [ ] Ensure every mutating path records proposal status events and memory mutation events transactionally.
- [ ] GREEN: Run:
  `bun test test/canonical-target-proposal-review-service.test.ts test/canonical-target-proposal-binding.test.ts`.
- [ ] Commit:
  `feat(memory): govern canonical target proposal review`

---

## Task 4: Contract Operations And CLI Surface

**Owner:** operations worker

**Files:**

- Create or modify: `src/core/operations-canonical-target-proposals.ts`
- Modify: `src/core/operations.ts`
- Test: `test/canonical-target-proposal-operations.test.ts`
- Test: `test/dry-run-memory-mutation-operations.test.ts`
- Test: `test/mcp-tool-schema.test.ts`

**Steps:**

- [ ] RED: Add operation registration and CLI naming tests for:
  `create_canonical_target_proposal`,
  `list_canonical_target_proposals`,
  `approve_canonical_target_proposal`,
  `reject_canonical_target_proposal`,
  `complete_canonical_target_proposal_binding`,
  `bind_memory_candidate_target`.
- [ ] RED: Add dry-run tests for every mutating operation.
- [ ] RED: Add list filter/pagination contract tests for:
  `status`, `source_candidate_id`, `proposed_slug`, `limit`, `offset`.
- [ ] RED: Add create override contract tests for
  `proposed_slug`, `proposal_kind`, `proposed_title`, and `review_reason`.
- [ ] RED: Add approval override contract tests for optional slug/title overrides.
- [ ] RED: Add `complete_canonical_target_proposal_binding` contract tests for
  `require_stub_patch_applied`.
- [ ] Implement contract-first operations with snake_case operation names and kebab-case CLI hints.
- [ ] Normalize service errors into `invalid_params` or `memory_candidate_not_found`, matching Memory Inbox operation behavior.
- [ ] Ensure `create_missing_page_stub=true` requires `session_id` and `realm_id`.
- [ ] GREEN: Run:
  `bun test test/canonical-target-proposal-operations.test.ts test/dry-run-memory-mutation-operations.test.ts test/mcp-tool-schema.test.ts`.
- [ ] Commit:
  `feat(memory): expose canonical target proposal operations`

---

## Task 5: Dream Cycle, Report, And Candidate Signals

**Owner:** integration worker

**Files:**

- Modify: `src/core/services/dream-cycle-maintenance-service.ts`
- Modify: `src/core/services/memory-review-report-service.ts`
- Modify: `src/core/services/candidate-signal-service.ts`
- Modify: `src/commands/memory-report.ts` if needed
- Test: `test/canonical-target-proposal-dream.test.ts`
- Test: `test/memory-review-report-service.test.ts`
- Test: `test/candidate-signal-service.test.ts`

**Steps:**

- [ ] RED: Add dream maintenance tests that targetless high-priority candidates create proposals, but never approve/bind/write pages.
- [ ] RED: Add repeated dream-run tests proving existing active proposals are refreshed, not duplicated.
- [ ] RED: Add low-importance one-off tests proving no proposal is created.
- [ ] RED: Add report tests for:
  no proposal -> propose canonical home,
  proposed -> approve/reject proposal,
  approved but unbound -> allow stub creation or choose existing page,
  patch_staged -> complete binding after patch apply,
  bound -> existing promotion hints.
- [ ] RED: Add candidate-signal tests for actionable proposal hints replacing generic `needs_target`.
- [ ] Implement deterministic proposal generation during maintenance when `write_candidates=true`.
- [ ] Surface proposal counts:
  `canonical_target_proposals_created`,
  `canonical_target_proposals_existing`,
  `canonical_target_proposals_blocked`.
- [ ] GREEN: Run:
  `bun test test/canonical-target-proposal-dream.test.ts test/memory-review-report-service.test.ts test/candidate-signal-service.test.ts`.
- [ ] Commit:
  `feat(memory): surface canonical target proposal review`

---

## Task 6: Documentation And Agent Guidance

**Owner:** docs worker

**Files:**

- Modify: `docs/guides/brain-vs-memory.md`
- Modify: `docs/MBRAIN_AGENT_RULES.md` if this repo owns the source rules
- Modify: setup-agent prompt/rule tests only if generated agent instructions need a version bump
- Test: relevant setup-agent/docs tests if touched

**Steps:**

- [ ] Document the new review loop:
  targetless candidate -> proposal -> approve/reject -> optional stub patch -> complete binding -> promote/handoff.
- [ ] Clarify that candidates with no target are not evidence for factual answers.
- [ ] If agent rules change, update expected version/tests.
- [ ] GREEN: Run touched docs/setup tests.
- [ ] Commit:
  `docs(memory): explain canonical target proposal workflow`

---

## Final Verification

- [ ] Run focused suite:
  `bun test test/canonical-target-proposals-schema.test.ts test/canonical-target-proposals-engine.test.ts test/canonical-target-proposal-service.test.ts test/canonical-target-proposal-review-service.test.ts test/canonical-target-proposal-binding.test.ts test/canonical-target-proposal-operations.test.ts test/canonical-target-proposal-dream.test.ts`
- [ ] Run related existing suite:
  `bun test test/memory-inbox-service.test.ts test/memory-inbox-operations.test.ts test/auto-promote/candidate-selector.test.ts test/memory-review-report-service.test.ts test/candidate-signal-service.test.ts`
- [ ] Run contract/dry-run suites:
  `bun test test/dry-run-memory-mutation-operations.test.ts test/mcp-tool-schema.test.ts`
- [ ] Run typecheck:
  `bun run typecheck`
- [ ] Run lint on touched sources:
  `bun run lint`
- [ ] Request final subagent code review over the branch diff from `1043d4d` to `HEAD`.
- [ ] Address Critical/Important review findings.
- [ ] Final commit if needed.
