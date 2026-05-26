# Phase 08: Lifecycle Forgetting

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 07

## Goal

Implement forgetting as a first-class lifecycle for assertions, projections,
source chunks, task/session memory, and reports. Forgetting should affect
retrieval by default while preserving auditability and restore where policy
allows.

## Design Decisions

- Forgetting is lifecycle-level, not only retrieval filtering.
- States are `active`, `stale`, `expired`, `archived`, `purged`.
- Restore policy depends on source kind and sensitivity.
- Purge is restricted and leaves tombstones.
- Dream/autopilot may move memory through stale/expired/archive automatically.

## In Scope

- Forgetting policy schema.
- Assertion lifecycle transitions.
- Projection lifecycle transitions.
- Source chunk retention.
- Task/session retention.
- Restore support.
- Purge planning.
- Retrieval filtering.
- Daily report of forgetting changes.

## Out Of Scope

- UI beyond CLI/MCP/report surfaces.
- Connector-specific legal retention requirements.
- Full redaction plan implementation beyond integration hooks.

## Schema

Core tables:

- `forgetting_policies`
- `memory_lifecycle_states`
- `forgetting_events`
- `purge_plans`
- `purge_plan_items`
- `restore_events`
- `memory_tombstones`

Policy dimensions:

- source kind
- claim type
- sensitivity
- importance
- lifecycle transition thresholds
- restore window
- archive retention
- purge eligibility
- report visibility

## Lifecycle State Placement

Forgetting applies to multiple entity families. Phase 08 must make the storage
location explicit:

| Entity family | Storage |
|---|---|
| assertions | native `assertions.lifecycle_state` plus `memory_lifecycle_states` audit row |
| assertion evidence | `assertion_evidence.forgetting_state` and lifecycle audit row |
| source items | `memory_lifecycle_states(entity_type = source_item)` |
| source chunks | `source_chunks.expires_at` plus `memory_lifecycle_states(entity_type = source_chunk)` |
| projections | `memory_lifecycle_states(entity_type = projection_target)` until Phase 10 adds projection tables |
| task/session memory | `memory_lifecycle_states` over session, task thread, task event, attempt, working set, retrieval trace, and handoff ids |
| reports | `memory_lifecycle_states(entity_type = report)` until Phase 12 adds report tables |

`memory_lifecycle_states` fields:

- `id`
- `entity_type`
- `entity_id`
- `lifecycle_state`
- `policy_id`
- `reason`
- `source_id`
- `sensitivity_level`
- `restore_until`
- `purge_after`
- `last_transition_event_id`
- `created_at`
- `updated_at`

Native lifecycle columns are preferred for hot retrieval paths. The generic table
is the cross-entity audit and transition surface.

## Lifecycle Semantics

`active`:

- answer-grounding eligible when canonical

`stale`:

- visible but verify-first
- common for code claims or time-sensitive facts

`expired`:

- hidden from default answer grounding
- visible in audit/review
- can be restored when policy allows

`archived`:

- not used in normal retrieval
- retained for history/audit
- eligible for purge after policy window

`purged`:

- content removed
- tombstone remains
- restore not possible without external backup

## Automatic Forgetting Inputs

Signals:

- superseded assertion
- newer temporal assertion
- low retrieval usefulness
- source revoked
- retention window elapsed
- sensitive/secret-bearing source
- task/session mechanics no longer useful
- repeated failed candidate
- user explicit forget request

## Retrieval Behavior

Default retrieval:

- canonical + active first
- canonical + stale only with verify-first marker
- exclude expired/archived/purged
- exclude rejected/candidate unless requested
- surface conflicts explicitly

Audit retrieval:

- includes expired/archived/rejected/conflicted
- includes lifecycle events and tombstones

## Safety

- Automatic purge is conservative.
- Explicit user purge can override retention unless blocked by system safety.
- Secret-bearing chunks prefer redaction/purge.
- Durable decisions/preferences default to long archive.
- Purge must not remove required mutation/audit ledger records.
- Purging a source chunk revokes or degrades related assertion evidence before
  affected assertions are re-resolved.
- Purging task/session mechanics must not remove semantic assertions already
  derived from them; it removes operational payloads and leaves evidence
  tombstones.
- Projection lifecycle changes trigger re-render or reconcile rather than
  direct deletion of canonical assertions.

## Tests

Required tests:

- supersession expires older assertion
- expired assertion hidden from default retrieval
- stale code claim returns verify-first
- archived assertion restore works within policy
- purge leaves tombstone
- source-specific retention changes purge eligibility
- daily report includes purge candidates and restore window
- lifecycle state exists for source chunks, projections, and task/session memory
- source chunk purge re-resolves affected assertion evidence

## Acceptance Criteria

- Forgetting lifecycle is represented in storage and retrieval.
- Dream/autopilot can move memory through lifecycle states.
- Users can audit and restore where policy allows.
- Purge is safe, restricted, and visible.
