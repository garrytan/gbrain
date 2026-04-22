# Phase 4 Personal Episode Lookup Design

## Goal

Add the first bounded `personal_episode_lookup` retrieval route on top of the
canonical `Personal Episode` table.

## Scope

- exact-title lookup with optional `source_kind` disambiguation
- direct shared operation and retrieval-selector intent
- automatic scope-gate enforcement for `personal_episode_lookup`
- retrieval-trace support when a personal task thread requests trace persistence
- local benchmark and verification coverage

## Non-Goals

- fuzzy ranking or semantic personal recall
- cross-link promotion between episodes and profile memory
- mixed-scope retrieval
- any new storage abstraction beyond the existing personal-episode store

## Acceptance

- route returns deterministic `direct_title_match`, `ambiguous_title_match`, and `no_match`
- `personal-episode-lookup-route` stays available through the shared operation surface
- selector dispatches `personal_episode_lookup` only after the scope gate allows personal scope
- persisted traces record both personal route selection and scope-gate evidence
- benchmark reports `personal_episode_lookup_route` and `personal_episode_lookup_route_correctness`
- local acceptance reports `phase4_status: pass`
