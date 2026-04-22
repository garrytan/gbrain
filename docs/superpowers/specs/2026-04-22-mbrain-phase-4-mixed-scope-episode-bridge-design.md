# Phase 4 Mixed-Scope Episode Bridge Design

## Goal

Extend the published `mixed_scope_bridge` so the personal side can use either
an exact profile-memory route or an exact personal-episode route, without
adding a second mixed intent or weakening the current explicit mixed-scope rule.

## Approaches Considered

### 1. Extend `mixed_scope_bridge` with explicit personal route kind

Add one discriminator such as `personal_route_kind: profile | episode`, then
require the matching personal-side fields.

This is the recommended option. It preserves the existing mixed bridge surface,
keeps the work side unchanged, and avoids multiplying retrieval intents for what
is still one bounded cross-scope behavior.

### 2. Add a separate `mixed_scope_episode_bridge` intent

This would keep route payloads simpler, but it expands the shared intent
surface, duplicates selector logic, and turns one conceptual bridge into two
published bridge families too early.

### 3. Infer profile-versus-episode from input fields alone

This looks small, but it adds ambiguity exactly where the scope system is
supposed to stay explicit. Mixed retrieval should not silently guess whether the
personal side is durable profile memory or append-only episode history.

## Recommendation

Use approach 1.

## Scope

- keep `intent: mixed_scope_bridge`
- add `personal_route_kind: profile | episode`
- keep the work side fixed to `broad_synthesis`
- support:
  - `profile` -> `personal_profile_lookup`
  - `episode` -> `personal_episode_lookup`
- keep the bridge read-only
- keep explicit `requested_scope: mixed` as the only allowed mixed entry point
- preserve deterministic degrade reasons when either side fails

## Non-Goals

- mixed-scope durable writes
- mixed-scope precision lookup
- auto-inference of the personal route kind
- generalized N-way route composition
- mixed-scope export behavior

## Contract

Input:

- `requested_scope` must still be `mixed`
- `query` is still required for the work-side `broad_synthesis` route
- `personal_route_kind` is required
- when `personal_route_kind === "profile"`:
  - `subject` is required
  - `profile_type` remains optional
- when `personal_route_kind === "episode"`:
  - `episode_title` is required
  - `episode_source_kind` remains optional

Output:

- `selection_reason`
- `candidate_count`
- `scope_gate`
- `route` containing:
  - `route_kind: "mixed_scope_bridge"`
  - `bridge_reason`
  - `personal_route_kind`
  - `work_route`
  - `personal_route`
  - `retrieval_route`
  - `summary_lines`

The `personal_route` payload becomes a union:
- `PersonalProfileLookupRoute`
- `PersonalEpisodeLookupRoute`

## Policy

- explicit mixed scope remains required
- explicit work or personal scope remains denied
- unknown scope still defers
- no combined route is returned unless both delegated routes succeed
- ambiguity on the personal side still degrades explicitly instead of guessing
- Retrieval Trace output must preserve whether the personal side came from a
  profile-memory record or a personal-episode record

## Acceptance

- `mixed-scope-bridge` continues to stay available through the shared operation surface
- the bridge supports both `profile` and `episode` personal-side kinds
- selector and `retrieval-route` surfaces can persist traces for both variants
- benchmark `mixed_scope_bridge_correctness` covers both personal-side variants
- `phase4-acceptance` remains `pass`
