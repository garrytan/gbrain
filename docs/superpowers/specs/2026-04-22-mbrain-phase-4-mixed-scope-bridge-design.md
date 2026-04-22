# Phase 4 Mixed-Scope Bridge Design

## Goal

Add the first explicit mixed-scope retrieval bridge so `mbrain` can combine a
bounded work route with a bounded personal route without flattening both domains
 into one ambient recall path.

## Scope

- introduce one new explicit retrieval intent: `mixed_scope_bridge`
- allow the bridge only when mixed scope is explicit
- bridge exactly one work route and one personal route in this slice:
  - work side: `broad_synthesis`
  - personal side: `personal_profile_lookup`
- return deterministic disclosures for allow, deny, defer, ambiguity, and
  missing-route cases
- persist Retrieval Trace output when the caller asks for it through the shared
  retrieval selector

## Non-Goals

- mixed-scope durable writes
- mixed-scope `personal_episode_lookup`
- mixed-scope `precision_lookup`
- automatic inference of mixed scope from vague cross-domain language
- generalized N-way route composition

## Bridge Contract

The bridge is read-only and explicit.

Input requirements:

- `requested_scope` must be `mixed`
- `query` is required for the work-side `broad_synthesis` route
- `subject` is required for the personal-side `personal_profile_lookup` route
- optional `profile_type`, `map_id`, `scope_id`, `kind`, and `limit` continue to
  scope the existing delegated routes

Output shape:

- `selection_reason`
- `candidate_count`
- `scope_gate`
- `route` containing:
  - `route_kind: "mixed_scope_bridge"`
  - `retrieval_route` showing both delegated route stacks
  - `summary_lines` explaining the bridge
  - `payload.work_route`
  - `payload.personal_route`
  - `payload.bridge_reason`

## Policy

- work-only or personal-only explicit scope is denied for this intent
- unknown scope still defers
- mixed scope is allowed only for this published bridge
- both delegated routes must resolve successfully; otherwise the bridge returns a
  deterministic degraded disclosure and no combined route
- the bridge loads the minimum necessary cross-domain context: one work route,
  one personal route, nothing more

## Acceptance

- `mixed-scope-bridge` stays available through the shared operation surface
- `retrieval-route` can select `mixed_scope_bridge` and persist a Retrieval Trace
- scope gate allows explicit mixed scope for this intent only
- benchmark reports `mixed_scope_bridge` and
  `mixed_scope_bridge_correctness`
- `phase4-acceptance` includes the mixed-scope bridge slice once implemented
