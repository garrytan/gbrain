# Dream Cycle Candidate Resolution Design

Date: 2026-06-20
Status: Design spec
Author: scott.lee + agent

## Goal

Make Dream Cycle close the loop on targetless Memory Inbox candidates that reach
canonical-target proposal review, especially proposals blocked with
`unstable_subject_identity`.

The result should reduce noisy daily memory warnings without weakening memory
governance. A blocked proposal is not a canonical page, but it is useful
lifecycle evidence. Dream Cycle and memory-report should treat it as a safe
classification outcome instead of leaving the candidate in a generic unresolved
state forever.

## Problem

Current behavior is safe but incomplete:

- Dream Cycle can create or refresh canonical target proposals for targetless
  candidates.
- When no stable subject can be inferred, the proposal is `blocked` with
  `status_reason = unstable_subject_identity`.
- The blocked proposal is audit evidence only. It cannot be approved, bound, or
  used for canonical writes.
- The source candidate remains non-terminal, usually `captured` with no
  `target_object_id`.
- `memory-report` counts every visible non-terminal candidate without handoff as
  `candidate_unresolved_exposed`, regardless of proposal state.

This makes daily memory health noisy: Dream Cycle did classify the candidate,
but the rest of the system still reports it as unresolved exposed debt.

## Non-Goals

- Do not auto-promote targetless candidates.
- Do not create pages for `concepts/unstable-subject-identity`.
- Do not mutate blocked proposals into approval-ready proposals.
- Do not add a new candidate status in this PR.
- Do not auto-reject all ambiguous user or agent candidates.

## Design

### 1. Shared Resolution Classifier

Add a small deterministic classifier that evaluates a candidate with its
canonical handoff state and active canonical target proposal.

Resolution states:

- `terminal`: candidate is rejected or superseded.
- `promoted_with_handoff`: candidate is promoted and has canonical handoff.
- `promoted_without_handoff`: candidate is promoted but lacks canonical handoff.
- `proposal_pending`: proposal is `proposed`.
- `binding_pending`: proposal is `approved` or `patch_staged`.
- `proposal_bound`: proposal is `bound`.
- `hard_blocked_by_proposal`: proposal is `blocked` with a hard blocked reason.
- `actionable_unresolved`: candidate is visible, non-terminal, has no handoff,
  and no active proposal state that explains the next action.

For this PR, the only hard blocked reason is `unstable_subject_identity`.

### 2. Candidate Debt Uses Resolution State

`computeCandidateDebtMetrics` should no longer count a candidate as unresolved
exposed when it has a hard-blocked proposal. It should still count:

- missing provenance,
- promoted-without-handoff,
- candidates that have no terminal state, handoff, or proposal state.

The blocked proposal remains visible in the report's canonical target proposal
section, but it does not make health warn as generic unresolved exposed debt.

### 3. Candidate Signals Use Resolution State

Candidate retrieval signals should distinguish hard-blocked candidates from
candidates that still need a canonical target proposal.

For `hard_blocked_by_proposal`:

- summary: say the candidate has a blocked canonical-target proposal and needs
  a stable canonical subject or rejection/supersession.
- promotion hint: use `complete_canonical_target_binding` only for recoverable
  approved/patch-staged proposal states, not for blocked proposals.
- review priority: use no default priority unless an audit policy explicitly
  requests candidate cleanup.
- pressure reason: do not add `unresolved_exposed_candidate`.

### 4. Dream Cycle Reports Processed Hard Blocks

Dream Cycle should continue to create or refresh blocked proposals. It should
also count hard-blocked proposal outcomes as processed classifications so the
maintenance summary explains what happened.

This PR does not automatically reject, supersede, or canonical-write these
candidates. Those mutations need stronger evidence:

- reject stale maintenance snapshots,
- supersede when a newer candidate or canonical page covers the same subject,
- create a fresh proposed canonical target when a stable page is later found.

### 5. Safety Invariants

- `unstable_subject_identity` is a diagnostic bucket, not a page target.
- Blocked proposals never call `put_page`.
- Blocked proposals never bind candidate targets.
- Auto-promote remains limited to page-backed targeted candidates.
- Candidate content remains non-canonical until promotion and handoff.

## Current Cases

The three current warning cases should become hard-blocked audit records instead
of generic unresolved exposed debt:

- dated local install verification snapshot,
- v0.13 review summary,
- 2026-06-11 direction brainstorming summary.

They can later be resolved by explicit reject, supersede, or a stable canonical
target proposal, but Dream Cycle should not write them under
`concepts/unstable-subject-identity`.

## Acceptance Criteria

- A candidate with a blocked `unstable_subject_identity` proposal is not counted
  as `candidate_unresolved_exposed`.
- Candidate signals for blocked proposals do not say `needs_canonical_target_proposal`.
- Dream Cycle repeated runs refresh blocked proposals without increasing generic
  unresolved debt.
- Existing proposal statuses `proposed`, `approved`, and `patch_staged` remain
  actionable.
- Existing safety behavior remains: no page write, no binding, no promotion from
  blocked proposals.
