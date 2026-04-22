# Phase 3 Acceptance Pack Design

## Goal

Aggregate the published Phase 3 benchmarks into one deterministic acceptance
report so the navigation and retrieval-route stack can be evaluated as a single
phase boundary.

## Scope

- aggregate only published Phase 3 benchmark scripts
- report one summary row per benchmark
- fail the pack if any underlying benchmark fails or reports a failing
  acceptance status
- expose one benchmark command and one test entrypoint for Phase 3

## Non-Goals

- adding new Phase 3 feature behavior
- replacing per-slice benchmarks
- cross-phase aggregation

## Acceptance

- `phase3-acceptance-pack` returns `phase3_status: pass` only when all published
  Phase 3 benchmarks pass
- `test:phase3` runs the published Phase 3 suites plus the acceptance-pack test
- verification docs describe the phase-level commands
