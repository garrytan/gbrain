# Phase 03: Assertion Pipeline

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 02

## Goal

Create the semantic pipeline that turns raw source chunks into extracted claims,
resolves those claims into assertions, and records lifecycle/authority history.

## Design Decisions

- Assertion is the smallest semantic knowledge object.
- Extracted claim is a pre-assertion intermediate.
- Decision, preference, event, relationship, commitment, code claim, task
  outcome, and architecture claim are assertion types.
- Task/session continuity remains separate from assertions.
- Codex/Claude session knowledge fuses with other sources at assertion layer.

## In Scope

- `extracted_claims` schema.
- `assertions` schema.
- `assertion_events` schema.
- `assertion_evidence` schema.
- target resolution.
- duplicate detection.
- temporal supersession detection.
- conflict set creation hooks.
- extraction lineage ledger.
- task/session/assertion bidirectional links.
- retrieval filters by authority/lifecycle.

## Out Of Scope

- Canonical projection writes.
- Authority matrix enforcement for automatic write.
- Maintenance jobs.
- Runner integration.
- Full conflict resolution UX.

## Schema

Core tables:

- `extracted_claims`
- `assertions`
- `assertion_events`
- `assertion_evidence`
- `assertion_lineage`
- `assertion_links`
- `conflict_sets`
- `conflict_set_assertions`
- `sessions`
- `task_threads`
- `task_events`
- `task_attempts`
- `working_sets`
- `retrieval_traces`
- `handoffs`
- `session_grants`
- `session_source_grants`
- `session_write_grants`

`extracted_claims` fields:

- `id`
- `source_id`
- `source_item_id`
- `source_chunk_id`
- `extractor_kind`
- `extractor_version`
- `runner_job_id`
- `claim_text`
- `claim_type`
- `target_hint`
- `property_hint`
- `value_json`
- `confidence`
- `sensitivity_level`
- `prompt_injection_flag`
- `secret_flag`
- `status`
- `created_at`

`assertions` fields:

- `id`
- `claim_type`
- `target_type`
- `target_id`
- `target_slug`
- `property`
- `value_json`
- `normalized_claim`
- `authority_summary`
- `confidence`
- `evidence_count`
- `authority_state`
- `lifecycle_state`
- `valid_from`
- `valid_until`
- `supersedes_assertion_id`
- `superseded_by_assertion_id`
- `conflict_set_id`
- `created_at`
- `updated_at`

`assertion_events` fields:

- `id`
- `assertion_id`
- `event_type`
- `from_authority_state`
- `to_authority_state`
- `from_lifecycle_state`
- `to_lifecycle_state`
- `reason`
- `source_refs_json`
- `actor`
- `job_id`
- `created_at`

`assertion_evidence` fields:

- `id`
- `assertion_id`
- `extracted_claim_id`
- `source_id`
- `source_item_id`
- `source_chunk_id`
- `session_id`
- `task_event_id`
- `contribution_type`
- `evidence_authority`
- `evidence_confidence`
- `valid_from`
- `valid_until`
- `revocation_state`
- `forgetting_state`
- `created_at`

`contribution_type` values:

- `supports`
- `contradicts`
- `supersedes`
- `superseded_by`
- `context`
- `audit_only`

`authority_summary`, `confidence`, and `evidence_count` on `assertions` are
derived from the evidence set. They are cached for retrieval and policy
decisions, but source revocation, source purge, or new evidence must re-resolve
the assertion from `assertion_evidence`.

Work/session graph tables own operational continuity:

- `sessions`: realm, workspace, client kind, started/closed timestamps, trust
  level, expiry, close status.
- `task_threads`: task identity, parent thread, workspace, active state,
  current handoff id.
- `task_events`: event kind, actor, summary, payload hash, source refs, created
  timestamp.
- `task_attempts`: attempt number, goal, changed files, command/test summaries,
  result, failure class.
- `working_sets`: task/thread id, file paths, source ids, assertion ids,
  projection ids, reason, expiry.
- `retrieval_traces`: query hash, selected source/assertion/projection ids,
  answer mode, omitted candidates, timestamp.
- `handoffs`: durable resume summary, pending decisions, next actions, linked
  assertions/projections.
- `session_grants`: realm, allowed tools, raw access policy, write policy,
  expiry, revoked timestamp.
- `session_source_grants`: session id, source id/kind, raw scope, chunk/time
  limit, sensitivity ceiling.
- `session_write_grants`: session id, target scope, allowed policy outcomes,
  expiry, revocation state.

## Assertion States

Authority:

- `unresolved`
- `candidate`
- `canonical`
- `conflicted`
- `rejected`

Lifecycle:

- `active`
- `stale`
- `expired`
- `archived`
- `purged`

## Resolution Pipeline

Steps:

1. Validate extracted claim.
2. Normalize claim type.
3. Resolve target.
4. Resolve property.
5. Normalize value.
6. Check sensitivity/prompt-injection/secret flags.
7. Search existing assertions for same target/property.
8. Decide duplicate, supersession, conflict, or independent assertion.
9. Create or update assertion.
10. Append assertion event.
11. Link lineage from source/extracted claim/session/task.
12. Recompute assertion evidence summary.

## Codex / Claude Session Integration

Codex/Claude sessions produce both work/session records and extracted claims.

Operational facts stay in task/session graph:

- attempts
- changed files
- commands
- test outcomes
- handoff state
- working set
- retrieval traces

Durable semantic claims become assertions:

- architecture decisions
- user-confirmed preferences
- project rules
- durable task outcomes
- code claims
- implementation constraints

Bidirectional links:

- task/session events know generated assertion ids
- assertions know originating source/session/task/event
- lineage ledger records extraction path

## Tests

Required tests:

- extracted claim can be created from source chunk
- resolver creates assertion with source lineage
- duplicate claim links to existing assertion
- temporal update supersedes older assertion
- true incompatibility creates conflict set
- Codex session event can generate assertion and bidirectional link
- stale/expired assertions are excluded from default retrieval
- assertion event log is append-only
- multiple extracted claims can support one assertion through assertion_evidence
- source revocation re-resolves affected assertion evidence summaries
- session grants scope source access and write policy inputs

## Acceptance Criteria

- Raw source chunks can produce extracted claims.
- Extracted claims can resolve into assertions.
- Assertions can fuse multiple source/session evidence records without losing
  per-evidence authority, lifecycle, or revocation state.
- Assertions have authority and lifecycle state.
- Source and task/session lineage is queryable.
- Work/session continuity has concrete storage for sessions, grants, retrieval
  traces, working sets, attempts, and handoffs.
- Later canonical write policy can operate on assertions.
