# Phase 07: Dream Cycle

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 06

## Goal

Turn dream from a bounded report tool into the primary personal memory
maintenance cycle. Dream runs as a phase runner under autopilot and handles
capture, extraction, consolidation, contradiction review, forgetting,
projection, index refresh, and reporting.

## Design Decisions

- Dream is a unified phase runner.
- It runs under the same primitive from CLI, autopilot, and runtime jobs.
- Phase outputs are structured and replayable.
- LLM use follows onboarding budget and runner policy.
- Dream never bypasses canonical write policy.

## In Scope

- dream cycle phase registry.
- phase registry and stable reporting order.
- phase status/result schema.
- dry-run/report-only mode.
- apply mode through policy engine.
- cycle lock usage.
- source sync phase registry entries.
- extraction/consolidation/review phases.
- forgetting review phase.
- projection reconcile phase registry entries.
- daily report generation hook.

## Out Of Scope

- Full connector implementation.
- Full restricted runner implementation details beyond task hooks.
- Web UI.

## Phase Families

Dream owns the stable orchestration surface, not every phase implementation.
Each phase family must have a registry entry, owner phase, result schema, and
explicit skip reason when the owner implementation is not available yet.

Initial phase families:

| Order | Family | Owner |
|---|---|---|
| 1 | `source_status` | Phase 01 |
| 2 | `source_sync` | Phase 11 |
| 3 | `raw_ingest` | Phase 02 |
| 4 | `safety_scan` | Phase 02 |
| 5 | `claim_extraction` | Phase 03 / Phase 09 when runner-backed |
| 6 | `assertion_resolution` | Phase 03 |
| 7 | `canonical_write` | Phase 04 |
| 8 | `consolidation` | Phase 07 deterministic, Phase 09 runner-backed |
| 9 | `contradiction_review` | Phase 03 / Phase 09 |
| 10 | `forgetting_review` | Phase 08 |
| 11 | `projection_reconcile` | Phase 10 |
| 12 | `embedding_refresh` | Phase 05 |
| 13 | `context_refresh` | Phase 05 |
| 14 | `daily_report` | Phase 12 |

Before an owner phase lands, Dream must mark the family `skipped` with
`phase_not_available`. It must not silently no-op or claim complete maintenance
coverage.

## Phase Result Schema

Each phase returns:

- phase name
- status: `ok`, `warn`, `failed`, `skipped`
- duration
- counts
- source ids touched
- assertion ids touched
- projection ids touched
- job ids spawned
- policy denials
- conflicts
- errors
- skip reason
- next recommended action

## LLM And Runner Use

Dream may use restricted runners for:

- assertion extraction
- source summaries
- consolidation review
- contradiction review
- forgetting review
- report drafting

LLM/runner calls must be:

- budgeted
- scoped
- logged
- source-policy aware
- prompt-injection safe
- redacted for secrets

If runner is unavailable, phase degrades to deterministic/report-only when
possible.

## Dry Run

Dry run should:

- avoid canonical mutations
- show expected extracted claims/assertions/projections
- may optionally run cheap deterministic analysis
- must clearly state whether LLM/runner calls were used

Unlike gbrain's synthesize dry-run behavior, MBrain should make LLM use explicit
in dry-run output.

## Safety

- Phase writes require cycle lock when mutating.
- Canonical writes go through Phase 04 policy.
- Prompt-injection flagged sources cannot auto-write.
- Secrets are redacted before runner use.
- Dream-generated outputs must not be re-ingested as raw source without explicit
  anti-loop markers.
- Phase jobs must be idempotent.

## Tests

Required tests:

- CLI dream and autopilot dream call the same phase runner
- phase registry order is stable
- phase family without owner implementation reports `phase_not_available`
- dry-run does not mutate canonical memory
- cycle lock prevents concurrent mutating dream runs
- failed phase produces structured result
- policy denial appears in phase report
- dream output is marked to avoid self-consumption
- unavailable runner degrades according to policy

## Acceptance Criteria

- Dream runs as the stable maintenance orchestrator.
- It can be run manually or by autopilot.
- It safely drives implemented extraction, consolidation, forgetting,
  projection, and report phases without bypassing governance.
- It reports unavailable later phase families explicitly instead of hiding them
  as successful work.
