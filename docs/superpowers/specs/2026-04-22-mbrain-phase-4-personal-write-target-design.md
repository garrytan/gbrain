# Phase 4 Personal Write Target Design

## Goal

Add a deterministic `personal_write_target` preflight so agent-facing personal
writes can prove they are allowed before touching durable personal stores.

## Scope

- map `profile_memory` and `personal_episode` write targets onto the existing scope gate
- expose one shared `personal-write-target` operation
- return deterministic allow, deny, and defer disclosures
- publish a local benchmark and include it in the Phase 4 acceptance pack

## Non-Goals

- replacing the low-level canonical CRUD operations
- persisting write traces or governance records for this slice
- mixed-scope write routing beyond explicit denial or defer
- automatic profile-versus-episode inference from arbitrary text

## Acceptance

- `personal-write-target` stays available through the shared operation surface
- profile-memory and personal-episode targets both require personal-scope approval
- work-scoped or ambiguous requests return explicit deny or defer disclosures instead of a target
- benchmark reports `personal_write_target` and `personal_write_target_correctness`
- local acceptance reports `phase4_status: pass`
