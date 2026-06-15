# MBrain Canonical Target Proposals Design

Date: 2026-06-15
Status: Design spec (reviewed; pending implementation plan)
Author: scott.lee + agent

## Goal

Close the Memory Inbox gap where important candidates have no canonical target.
MBrain should be able to notice "this looks durable, but it has no obvious page"
and produce a reviewable canonical-home proposal instead of leaving the candidate
as permanent inbox debt or writing to an invented page.

The default behavior must stay safe:

- targetless candidates are never directly auto-promoted,
- new canonical pages are never created from inference alone,
- a user or trusted agent must approve the first canonical home,
- once a home is approved, existing Memory Inbox promotion, patch, handoff, and
  governed canonical-write paths are reused.

## Problem

Today targetless Memory Inbox candidates accumulate because the current promotion
pipeline requires a canonical target:

- `memory_candidate_entries.target_object_type` and `target_object_id` are
  nullable by design.
- `preflight_promote_memory_candidate` denies candidates with no target.
- `auto_promote` excludes missing targets and `target_object_type='other'`.
- dream-cycle auto-promotion only runs when explicitly allowed, and still only
  promotes already-targeted candidates.

This is correct for safety but incomplete for the user's actual workflow. A task
can be important even when no project/system/concept canonical doc exists yet.
The missing object is not necessarily "bad candidate"; often it means "missing
canonical home".

## Design Decisions

- **D1: Use a separate proposal table, not candidate target fields.**
  A proposed slug is not the same as an approved target. Do not fill
  `target_object_id` until the proposal is approved.
- **D2: Proposal generation is automatic; canonical mutation is approval-gated.**
  Dream/autopilot may create or refresh proposals, but must not create pages or
  bind candidates unless the proposal has been explicitly approved.
- **D3: First supported target is `curated_note` pages.**
  This matches the existing canonical doc surface and current promotion gate.
  Profile/personal/procedure homes remain future work.
- **D4: Approval binds, it does not promote.**
  Approval may bind candidates to an existing page, or stage a missing-page
  stub patch candidate. Promotion and canonical content changes still go
  through existing `preflight_promote_memory_candidate`,
  `promote_memory_candidate_entry`, `record_canonical_handoff`, and
  `apply_memory_patch_candidate` paths.
- **D5: Targetless proposal confidence is advisory.**
  Confidence can order review, but cannot grant write authority.
- **D6: Duplicate and slug quality checks are hard gates.**
  Ambiguous namespace, vague slugs, numeric-only slugs, likely duplicate pages,
  personal/secret/unknown sensitivity, and contradiction signals all produce a
  proposal-only or blocked result, never a page write.
- **D7: Binding uses a narrow engine API.**
  Current engines can update status, verification, patch state, and promotion,
  but they do not expose a candidate-target update method. Add a dedicated
  `bindMemoryCandidateTarget` method with expected-current-null checks instead
  of overloading status updates or writing SQL directly inside operations.
- **D8: Missing-page creation uses patch candidates.**
  Proposal approval must not call `put_page` directly. If a page is absent, the
  review operation stages a `create_memory_patch_candidate` with
  `base_target_snapshot_hash=null`; a separate review/apply step performs the
  canonical write under the existing session/realm governance.

## Data Model

Add `canonical_target_proposal_entries`.

```sql
CREATE TABLE canonical_target_proposal_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  source_candidate_id TEXT NOT NULL REFERENCES memory_candidate_entries(id),
  linked_candidate_ids JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
  ),
  status_reason TEXT,
  proposal_kind TEXT NOT NULL CHECK (
    proposal_kind IN ('project_root', 'project_doc', 'system_page', 'concept_page', 'idea_page', 'original_page')
  ),
  target_object_type TEXT NOT NULL CHECK (target_object_type IN ('curated_note')),
  proposed_slug TEXT NOT NULL,
  proposed_title TEXT NOT NULL,
  proposed_page_type TEXT NOT NULL CHECK (
    proposed_page_type IN ('project', 'system', 'concept')
  ),
  proposed_repo_path TEXT,
  confidence_score DOUBLE PRECISION NOT NULL,
  importance_score DOUBLE PRECISION NOT NULL,
  rationale TEXT NOT NULL,
  filing_basis JSONB NOT NULL DEFAULT '{}',
  source_refs JSONB NOT NULL DEFAULT '[]',
  candidate_snapshot JSONB NOT NULL DEFAULT '{}',
  duplicate_review JSONB NOT NULL DEFAULT '{}',
  slug_quality_warnings JSONB NOT NULL DEFAULT '[]',
  approval_actor TEXT,
  approved_at TIMESTAMPTZ,
  approval_reason TEXT,
  bound_candidate_ids JSONB NOT NULL DEFAULT '[]',
  stub_patch_candidate_id TEXT REFERENCES memory_candidate_entries(id),
  stub_patch_state TEXT,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  superseded_by TEXT REFERENCES canonical_target_proposal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Indexes:

- `(scope_id, status, updated_at DESC)`
- `(scope_id, proposed_slug)`
- `(source_candidate_id)`
- GIN on `linked_candidate_ids`

The proposal owns the uncertain classification. The candidate remains unchanged
until approval. This preserves existing invariants: `target_object_id` means an
approved target, not a guess.

`proposal_kind` is the filing intent. `proposed_page_type` is the existing DB
`PageType`. The first mapping is:

- `project_root`, `project_doc` -> `project`
- `system_page` -> `system`
- `concept_page`, `idea_page`, `original_page` -> `concept`

Add `canonical_target_proposal_status_events` for audit parity with candidate
status events:

```sql
CREATE TABLE canonical_target_proposal_status_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES canonical_target_proposal_entries(id),
  scope_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  actor TEXT,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`event_kind` values: `created`, `approved`, `patch_staged`, `bound`,
`rejected`, `superseded`, `blocked`.

### Status Transitions

- `proposed -> approved`: reviewer approved the canonical home, but no candidate
  was bound yet.
- `approved -> bound`: target page exists and
  `complete_canonical_target_proposal_binding` bound all eligible linked
  candidates.
- `approved -> patch_staged`: target page is absent and a reviewed missing-page
  patch candidate was staged.
- `patch_staged -> bound`: page now exists after patch apply and
  `complete_canonical_target_proposal_binding` bound all eligible linked
  candidates.
- `proposed|approved -> rejected`: reviewer rejected the home.
- initial `blocked`: proposal creation found a stable candidate identity but a
  hard gate blocked a safe canonical home, such as unstable subject identity,
  likely duplicate, or slug-quality hard error.
- `proposed|approved -> blocked`: hard gate found unsafe state such as unstable
  subject identity, likely duplicate, mixed scope, mixed sensitivity, refuted
  candidate, or stale target race.
- `patch_staged -> blocked`: the stub patch was rejected, failed, conflicted,
  was applied without materializing the expected page, or the linked candidate
  set is no longer all bindable.
- `proposed|approved|blocked -> superseded`: a newer proposal replaces this one.
- `patch_staged -> superseded`: a newer proposal replaces this one after the
  staged stub path is abandoned.

## Proposal Classifier

Create a deterministic `canonical-target-proposal-service` that reviews a
candidate plus nearby canonical/manifest signals and returns:

```ts
type CanonicalTargetProposalDraft = {
  proposal_kind: 'project_root' | 'project_doc' | 'system_page' | 'concept_page' | 'idea_page' | 'original_page';
  target_object_type: 'curated_note';
  proposed_slug: string;
  proposed_title: string;
  proposed_page_type: string;
  confidence_score: number;
  importance_score: number;
  rationale: string;
  filing_basis: Record<string, unknown>;
  slug_quality_warnings: string[];
  duplicate_review: Record<string, unknown>;
};
```

Initial heuristic rules:

- repo/system/tool names -> `brain/systems/{slug}.md` style slugs represented as
  `systems/{slug}` in DB,
- stable work/project identity -> `projects/{project}` or
  `projects/{project}/docs/{topic}`,
- product/business opportunity -> `ideas/{slug}`,
- user's original thesis/preference -> `originals/{slug}`,
- reusable world/technical concept -> `concepts/{slug}`,
- one-off task mechanics -> no proposal unless recurrence or importance is high.

The classifier must prefer "needs user review" over false precision. When it
cannot name a stable subject, it returns a `blocked` draft with `status_reason`
`unstable_subject_identity`.

## Operations

Add contract-first operations:

### `create_canonical_target_proposal`

Read/write operation that creates or refreshes one proposal for one targetless
candidate.

Inputs:

- `candidate_id` required
- `scope_id` optional, default Memory Inbox scope
- `apply` boolean, default `false`
- optional overrides: `proposed_slug`, `proposal_kind`, `proposed_title`,
  `review_reason`

Behavior:

- `apply=false`: return the draft only.
- `apply=true`: insert a proposal with `status='proposed'`.
- If classification fails after a stable candidate identity is visible, insert
  `status='blocked'` with `status_reason` rather than mutating the candidate.
  Examples: `unstable_subject_identity`, `likely_duplicate`, `slug_quality_hard_error`.
- Eligible phase-1 unresolved-target shapes:
  - `target_object_type=null` and `target_object_id=null`
  - `target_object_type='curated_note'` and `target_object_id=null`
  - `target_object_type='other'` and `target_object_id=null`
  - `target_object_type='procedure'` and `target_object_id=null`, but only when
    the classifier can file it as a page-backed runbook/concept; procedure
    canonical targets remain out of scope.
- Refuse if the candidate already has a non-empty `target_object_id`.
- Refuse if sensitivity is `personal`, `secret`, or `unknown`.
- Refuse canonical-page-like output if `source_refs` is empty.
- Attach duplicate and slug-quality findings.

### `list_canonical_target_proposals`

Read-only list with filters: `scope_id`, `status`, `source_candidate_id`,
`proposed_slug`, `limit`, `offset`.

### `approve_canonical_target_proposal`

Mutating approval operation.

Inputs:

- `id` required
- `actor`, `review_reason`
- `create_missing_page_stub`: boolean, default `false`
- `session_id`, `realm_id` required when `create_missing_page_stub=true`
- optional slug/title overrides

Approval behavior:

1. Re-read proposal and source candidates.
2. Require linked candidates to remain non-terminal, non-refuted, same scope,
   same allowed sensitivity class, with non-empty `source_refs`.
3. Re-run slug quality and duplicate checks; if duplicate review changed to
   `likely_duplicate`, block instead of binding.
4. If page exists, delegate to
   `complete_canonical_target_proposal_binding`; approval itself must not bind
   candidates by raw engine update.
5. If page does not exist and `create_missing_page_stub=false`, set status
   `approved` but do not bind candidates.
6. If page does not exist and `create_missing_page_stub=true`, perform a final
   authoritative page-existence recheck immediately before staging. If the page
   appeared during review, delegate to
   `complete_canonical_target_proposal_binding` instead of staging a stub.
7. If the target is still absent, stage a
   `create_memory_patch_candidate` targeting `target_kind='page'`,
   `target_id=proposed_slug`, and `base_target_snapshot_hash=null`.
8. The stub patch body must be structural only: title, type, empty or
   placeholder compiled-truth shell, and a source-attributed timeline note that
   records the proposal approval. It must not promote the candidate claim as
   compiled truth.
9. Set status `patch_staged` after patch-candidate creation.
10. Set status `bound` only through
    `complete_canonical_target_proposal_binding`.

Rejection behavior:

Handled by a separate `reject_canonical_target_proposal` operation: set status
`rejected`, store actor/time/reason, leave candidates unchanged.

### `reject_canonical_target_proposal`

Mutating rejection operation.

Inputs:

- `id`, `actor`, `review_reason`

Behavior:

- allowed from `proposed` or `approved`,
- records a proposal status event,
- never mutates linked candidates.

### `complete_canonical_target_proposal_binding`

Mutating operation that completes `approved -> bound` and `patch_staged -> bound`
after the target page exists.

Inputs:

- `id`, `actor`, `review_reason`
- optional `require_stub_patch_applied`: boolean, default `false`

Behavior:

- allowed from `approved` and `patch_staged`,
- re-read proposal, target page, stub patch candidate, and linked candidates,
- if page exists:
  - re-run slug quality and duplicate checks,
  - require every linked candidate to remain same-scope, allowed-sensitivity,
    non-terminal, non-refuted, source-backed, and target-unresolved,
  - bind all candidates all-or-nothing by invoking the governed
    `bind_memory_candidate_target` service for each candidate,
  - record one proposal status event `bound`,
  - record a memory mutation event for
    `complete_canonical_target_proposal_binding`.
- if page is absent and proposal is `approved`, keep status `approved` and
  return a pending result; no mutation beyond the operation audit event.
- if page is absent and proposal is `patch_staged`, inspect the stub patch
  candidate:
  - patch still pending/reviewable -> keep status `patch_staged` and return a
    pending result,
  - patch candidate rejected -> transition `blocked` with
    `status_reason='stub_patch_rejected'`,
  - patch candidate superseded -> transition `superseded` only when
    `superseded_by` points to a replacement proposal; otherwise transition
    `blocked` with `status_reason='stub_patch_superseded'`,
  - patch state `failed` or `conflicted` -> transition `blocked` with
    `status_reason='stub_patch_failed'` or `stub_patch_conflicted`,
  - patch state `applied` but page is still absent -> transition `blocked` with
    `status_reason='stub_patch_applied_page_missing'`.

Partial binding is not allowed in phase 1. If any linked candidate is stale or
unmodifiable, no candidate is bound and the proposal becomes `blocked` with a
specific `status_reason`.

### `bindMemoryCandidateTarget`

Add this to the `MemoryGovernanceStore` engine contract and implement it in
Postgres/PGLite/SQLite:

```ts
bindMemoryCandidateTarget(id, {
  target_object_type: 'curated_note',
  target_object_id: string,
  reviewed_at?: Date | string | null,
  review_reason?: string | null,
  expected_current_target_object_type?: 'curated_note' | 'procedure' | 'other' | null,
  expected_current_target_object_id?: null,
}): Promise<MemoryCandidateEntry | null>
```

The method must:

- refuse terminal candidates (`promoted`, `rejected`, `superseded`),
- require the current target to match the expected unresolved shape,
- keep status unchanged,
- update `reviewed_at`, `review_reason`, and `updated_at`,
- return `null` on stale target races.

Expose it through a governed `bind_memory_candidate_target` operation/service
that records a candidate status event with `from_status=to_status`,
`event_kind='advanced'`, and a review reason such as
`canonical target proposal approved: <proposal_id>`.

`approve_canonical_target_proposal` and
`complete_canonical_target_proposal_binding` must use that governed binding
service. They may not call `engine.bindMemoryCandidateTarget` directly unless
they also emit the same memory mutation event and candidate status event in the
same transaction.

## Dream Cycle Integration

Add a non-canonical dream maintenance step:

- select targetless visible candidates with high review priority,
- create/refresh proposals in `status='proposed'`,
- report counts in the memory review report:
  `canonical_target_proposals_created`,
  `canonical_target_proposals_existing`,
  `canonical_target_proposals_blocked`.

Autopilot stays safe: proposal generation can be automatic, but approval and
page creation are still explicit.

## Schema And Ledger Integration

This feature follows the existing Memory Inbox governance pattern:

- append-only migrations in `src/core/migrate.ts`,
- new cross-engine schema tests modelled on `test/memory-inbox-schema.test.ts`,
- `src/schema.sql` and generated `src/core/schema-embedded.ts` updated as the
  fresh-database baseline for these new governance tables,
- engine contract additions in `src/core/engine.ts`,
- type additions in `src/core/types/memory-governance.ts`,
- `memory_mutation_events.operation` check updates for:
  - `create_canonical_target_proposal`
  - `approve_canonical_target_proposal`
  - `reject_canonical_target_proposal`
  - `complete_canonical_target_proposal_binding`
  - `bind_memory_candidate_target`

Mutating operations must support dry-run behavior and ledger/audit semantics
consistent with existing memory mutation operations.

## Memory Report Surface

The daily report should separate "unresolved candidates" from "missing canonical
home proposed":

- targetless candidates with no proposal -> action: propose canonical home,
- proposal pending -> action: review proposed slug/namespace,
- approved but unbound -> action: allow stub creation or choose existing page,
- bound -> candidate is now eligible for existing promotion/handoff flow.

This makes candidate accumulation understandable instead of a single backlog
number.

Candidate signal promotion hints should also change from generic `needs_target`
to a more actionable proposal hint when a proposal exists:

- no proposal -> `needs_canonical_target_proposal`,
- proposed -> `approve_or_reject_canonical_target_proposal`,
- approved or patch-staged -> `complete_canonical_target_binding`,
- bound -> existing `advance_to_review` / `consider_preflight` hints apply.

## Scenario Behavior

### Scenario 1: New project with no canonical doc

Candidate: "The `rebel_compiler` work needs a runbook for W4A16 debugging."

Outcome:

- proposal: `projects/rebel-compiler/docs/w4a16-debugging-runbook`
- status: `proposed`
- no candidate target is changed yet
- after approval with stub creation, a missing-page patch candidate is staged
- after that patch is reviewed/applied and the page exists, the original
  candidate target becomes the new curated note slug and existing promotion
  paths can run

### Scenario 2: Important task, but no stable project identity

Candidate: "Use a short-lived shell alias for this one terminal issue."

Outcome:

- no proposal if importance/recurrence is low
- candidate remains reviewable but is not promoted
- report reason: `one_off_task_mechanic`

### Scenario 3: New system/repo knowledge

Candidate: "`mbrain` targetless candidates need a canonical-home workflow."

Outcome:

- proposal: `systems/mbrain-canonical-target-proposals` or
  `projects/mbrain/docs/canonical-target-proposals`
- duplicate review should prefer an existing `systems/mbrain...` page if one is
  already present

### Scenario 4: Product/business idea

Candidate: "A memory inbox review dashboard would reduce agent uncertainty."

Outcome:

- proposal: `ideas/memory-inbox-review-dashboard`
- no page write until the proposal is approved, a page patch candidate is
  staged/reviewed/applied, and binding is completed

## Safety Invariants

- No proposal approval without non-empty `source_refs`.
- No stub page for `personal`, `secret`, or `unknown` sensitivity candidates.
- No automatic approval in dream/autopilot.
- No candidate target mutation while proposal status is `proposed`.
- No candidate target mutation outside governed `bind_memory_candidate_target`
  service semantics and audit events.
- No canonical write through a proposal when duplicate review returns
  `likely_duplicate` or slug-quality returns hard errors.
- All staged stub patches include source attribution and a timeline evidence
  entry.
- Proposal operations are auditable and non-destructive; rejection preserves the
  candidate.

## Implementation Phases

1. Schema, types, engine methods, and operation registration.
2. Deterministic proposal draft service with slug/duplicate gates.
3. Review operation that can approve, reject, bind to existing page, and
   optionally stage a missing-page stub patch candidate.
4. Dream maintenance/report integration for proposal generation counts.
5. Documentation and agent prompt updates describing the new review loop.

## Required Tests

- Cross-engine migration/schema tests for proposal entries and status events.
- Operation registration and CLI naming tests for create/list/approve/reject,
  `complete_canonical_target_proposal_binding`, and
  `bind_memory_candidate_target`.
- Dry-run tests for every mutating operation.
- Proposal creation tests for eligible unresolved target shapes:
  null/null, `curated_note/null`, `other/null`, selected `procedure/null`.
- Proposal refusal tests for terminal candidates, refuted candidates, empty
  source refs, personal/secret/unknown sensitivity, and non-empty target ids.
- Approval-to-existing-page tests that bind candidates and preserve candidate
  status.
- Approval-to-existing-page tests proving proposal status events,
  per-candidate status events, and memory mutation events are emitted.
- Approval stale-race tests where a candidate is promoted/rejected/re-targeted
  before bind.
- Missing-page approval tests that stage a patch candidate with
  `base_target_snapshot_hash=null`, not direct `put_page`.
- Concurrent page-appears-before-stub tests that bind to the existing page or
  block safely.
- `patch_staged` completion tests where an applied stub patch is followed by
  safe all-or-nothing candidate binding.
- Stub recovery tests for rejected, superseded, failed, conflicted, applied but
  page-missing, and still-pending patch candidates.
- Report and candidate-signal tests that expose proposal next actions.

## Out of Scope

- Fully unattended targetless canonical page creation.
- LLM-based target inference with write authority.
- Automatic rejection/deletion of targetless candidates.
- Batch rollback helpers.
- Profile/personal/procedure target proposal approval.
