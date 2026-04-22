# Phase 4 Acceptance Pack Design

## Goal

Summarize every published Phase 4 benchmark slice into one approval artifact
that can be used for PR review and rollout checks.

## Scope

- aggregate `scope_gate`, `personal_profile_lookup`, `personal_episode_lookup`, and `personal_write_target` benchmark outcomes
- expose one `phase4-acceptance-pack` benchmark script
- keep the aggregation deterministic and local-only
- add verification coverage and package scripts

## Non-Goals

- replacing the per-slice benchmark scripts
- introducing baseline comparisons at this layer

## Acceptance

- acceptance-pack script returns one JSON summary for all published Phase 4 benchmarks
- `readiness_status` and `phase4_status` only pass when every published slice passes
- `test:phase4` includes the acceptance-pack test
