# MBrain Postgres Runtime Implementation Index

Date: 2026-05-20
Status: Approved ordering index

## Purpose

This index fixes the implementation order for the Postgres-only personal memory
runtime redesign. It is not a loose roadmap. Later implementation sessions should
use this document to preserve the architecture decisions made in the design
session.

For the current post-merge implementation snapshot, see
`docs/superpowers/specs/2026-05-31-mbrain-postgres-runtime-status.md`.

## Ordering Rule

Use foundation-first linear phases. Do not jump directly to dream, runners, or
connectors before the storage, source, assertion, policy, and runtime substrate
exist.

## Phase Order

| Phase | Spec | Gate |
|---|---|---|
| 00 | Postgres Foundation | Fresh install and tests use local Postgres as the target backend |
| 01 | Source Registry And Policy | Sources can be registered with minimal consent and internal layered policy |
| 02 | Raw Ingest And Provenance | Source items/chunks/provenance/safety flags are recorded |
| 03 | Assertion Pipeline | Extracted claims resolve into assertion records, evidence, events, and session links |
| 04 | Governed Canonical Write | Eligible assertions update canonical projections through policy |
| 05 | Maintenance Runtime | Jobs, locks, leases, retries, progress, and backpressure exist |
| 06 | Autopilot Daemon | launchd/systemd/cron/manual autopilot can run maintenance safely |
| 07 | Dream Cycle | Stable phase runner orchestrates implemented maintenance families and reports unavailable ones |
| 08 | Lifecycle Forgetting | Assertion and projection lifecycle controls retrieval and storage behavior |
| 09 | Restricted Runner | Local Claude Code/Codex runners execute scoped maintenance tasks |
| 10 | System Of Record Reconciler | DB and Markdown projections are drift-checked and repairable |
| 11 | Personal Data Connectors | Connector framework handles personal sources through source policy |
| 12 | Review, Audit, And Health | Daily reports, doctor, audit, and repair UX expose system state |
| 13 | Evaluation And Replay | Regression harness covers extraction, policy, retrieval, and forgetting |
| 14 | Migration And Cleanup | Legacy SQLite/PGLite paths are migrated or removed from target flow |

## Dependencies

```text
00 -> 01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 07 -> 08 -> 09 -> 10 -> 11 -> 12 -> 13 -> 14
```

Some later phases can be prepared with tests or interfaces earlier, but
production behavior should not bypass earlier gates.

Important dependency details:

- Phase 03 depends on Phase 02 because assertions must be source-backed.
- Phase 03 owns the work/session graph, session grants, retrieval traces,
  handoffs, and assertion evidence joins required by later policy and runner
  phases.
- Phase 04 depends on Phase 03 because canonical writes must originate from
  resolved assertions.
- Phase 05 depends on Phase 04 because jobs must not mutate canonical memory
  outside policy.
- Phase 06 depends on Phase 05 because daemon execution must use durable jobs
  and cycle locks.
- Phase 07 depends on Phase 06 because dream is a scheduled maintenance cycle.
- Phase 07 defines the stable Dream registry before every family is implemented;
  unavailable families must report `phase_not_available` instead of silently
  succeeding.
- Phase 08 depends on Phase 04 and Phase 07 because forgetting is both policy
  and maintenance behavior.
- Phase 09 depends on Phase 05 because runners are jobs with scoped tools.
- Phase 10 depends on Phase 04 because reconciliation repairs projection drift.
- Phase 10 must not treat Markdown as an alternate semantic source of truth;
  Markdown edits that affect meaning enter as source items and flow through
  assertion policy.
- Phase 11 depends on Phase 01 and Phase 02 because connectors are source
  producers.
- Phase 12 depends on Phase 05, 06, 08, and 10 because reports must summarize
  jobs, daemon, forgetting, and reconciliation.
- Phase 13 depends on all behavioral phases because it must replay realistic
  memory lifecycles.
- Phase 14 depends on the new target being operational.

## Cross-Phase Invariants

These invariants apply to every phase:

1. Postgres is the target backend.
2. No new target feature may require SQLite parity.
3. User knowledge mutations require source attribution.
4. Automatic canonical writes are allowed only through policy.
5. Runtime jobs must be idempotent or explicitly non-idempotent with a guard.
6. Runners cannot execute arbitrary shell commands.
7. Runners cannot access connector credentials.
8. Raw source text is untrusted data.
9. Secrets are redacted before runner/LLM access.
10. Prompt-injection flags affect write authority.
11. Every durable state change must be auditable.
12. Retrieval must distinguish canonical, stale, candidate, conflicted, expired,
    and archived memory.
13. Daily/periodic reports summarize automatic changes and exceptions.

## Completion Definition

The redesign is complete when:

- all phase acceptance criteria pass
- target docs and CLI help describe Postgres-only operation
- fresh install works without SQLite
- existing user data can be migrated manually or by one-shot migration
- automatic canonical write is enabled for eligible source-backed claims
- forgetting lifecycle affects retrieval and reports
- autopilot can run unattended with clear status and repair paths
- local Claude Code/Codex runners can perform scoped maintenance tasks
- eval/replay protects the memory lifecycle from regressions
