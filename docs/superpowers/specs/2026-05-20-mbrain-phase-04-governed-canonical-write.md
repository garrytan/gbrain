# Phase 04: Governed Canonical Write

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 03

## Goal

Allow source-backed eligible assertions to automatically update canonical memory
while preserving provenance, conflict handling, dual-write consistency, and audit
visibility.

## Design Decisions

- Automatic canonical write is required.
- Governance is the safety policy for automatic write.
- Source kind x claim type matrix decides authority.
- Critical projections are immediate.
- Bulk projections are queued in later runtime phases.
- Canonical knowledge uses dual-write with required reconciliation.

## In Scope

- Canonical write policy engine.
- Authority matrix enforcement.
- Mutation planner.
- Immediate projection writer for critical targets.
- Mutation ledger.
- Dual-write status.
- Memory Candidate fallback.
- Conflict route.
- Policy explanation output.

## Out Of Scope

- Durable maintenance job queue.
- Autopilot daemon.
- Bulk projection jobs.
- Full reconciler implementation.
- Personal data connectors.

## Policy Inputs

The write policy evaluates:

- source kind
- source id
- claim type
- target certainty
- confidence
- sensitivity
- prompt-injection flag
- secret flag
- contradiction/conflict state
- validity window
- existing assertion state
- user override policy
- session/realm grant
- runner trust level

## Policy Outcomes

Allowed outcomes:

- `auto_canonical`
- `candidate`
- `verify_first`
- `conflict`
- `reject`
- `quarantine`
- `no_write`

`auto_canonical` writes only when the assertion is safe and source-backed.

`candidate` creates review surface when ambiguity remains.

`verify_first` is required for code claims or other claims needing live/current
verification.

`conflict` creates or updates conflict set.

`quarantine` blocks canonical writes from unsafe source chunks.

## Critical Projection Targets

Immediate canonical write may update:

- project/system compiled truth
- project decision timeline
- user profile/preference projection
- personal episode summary
- active task resume/handoff
- high-importance contradiction resolution

Every projection mutation must reference assertion ids and source refs.

## Dual-Write Status

Mutation states:

- `applied`
- `pending_reconcile`
- `failed_db`
- `failed_markdown`
- `conflict`

If Markdown projection fails after DB mutation, the assertion remains canonical
but projection state becomes `pending_reconcile` or `failed_markdown`.

If DB mutation fails, Markdown must not be written as successful canonical
state.

## Mutation Ledger

Every canonical write records:

- mutation id
- assertion ids
- assertion evidence ids
- extracted claim ids
- source refs
- target projection ids
- policy decision
- policy explanation
- before DB hash
- after DB hash
- before Markdown hash
- after Markdown hash
- actor/session/job/runner
- status
- error details

## Candidate Fallback

Claims become Memory Candidates when:

- target is uncertain
- source is weak
- claim is inferred
- sensitivity requires review
- contradiction cannot be resolved
- prompt-injection flag lowers trust
- source policy does not allow automatic write

Candidate must carry enough data to later promote to assertion/projection
without re-reading unsafe raw source unless policy permits.

## Tests

Required tests:

- user_direct x decision auto-writes canonical projection
- agent_session x inferred_preference becomes candidate
- code_claim requires verify-first
- prompt-injection flagged claim cannot auto-write
- secret-bearing claim cannot canonicalize secret value
- conflict route creates conflict set
- failed Markdown write marks pending_reconcile
- mutation ledger records before/after hashes
- policy explanation is deterministic

## Acceptance Criteria

- Eligible assertions automatically update canonical memory.
- Ambiguous or unsafe assertions do not auto-write.
- Canonical write is explainable and auditable.
- Projection drift is detectable for later reconciliation.
