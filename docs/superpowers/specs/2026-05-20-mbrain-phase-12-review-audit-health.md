# Phase 12: Review, Audit, And Health

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 06, Phase 08, Phase 10

## Goal

Give users and agents a clear view of what MBrain did automatically, what needs
attention, and what is unhealthy. The primary UX is a daily or periodic memory
report, not a manual approval inbox.

## Design Decisions

- Automation is default.
- Review focuses on exceptions and summaries.
- Daily/periodic report is the main user-facing audit surface.
- Doctor and status commands expose operational health.
- Undo/restore/pause/purge actions are available from reported items.

## In Scope

- daily report schema.
- report generation job.
- report projection.
- audit query surfaces.
- doctor expansions.
- source health summary.
- job health summary.
- forgetting summary.
- conflict summary.
- runner/LLM usage summary.
- CLI/MCP report tools.

## Out Of Scope

- Full graphical dashboard.
- Team/admin UI.
- Remote hosted observability service.

## Report Contents

Reports include:

- new canonical assertions
- changed projections
- profile/preference updates
- task handoffs
- expired/stale/archived memories
- purge candidates and restore windows
- candidates requiring review
- unresolved conflicts
- source ingest counts
- extraction counts
- policy denials
- quarantined sources
- secret-bearing source detections
- runner/LLM usage and cost estimates
- failed jobs
- stuck locks
- projection drift
- connector health
- credential expiry/revocation

## User Actions

From report items, users can:

- restore
- undo
- pin
- reject
- pause source
- revoke source
- create purge plan
- approve candidate
- resolve conflict
- re-run failed job
- open detailed audit trail

Actions should route through the same policy/mutation ledger, not direct table
edits.

## Doctor Health

Doctor should include:

- Postgres health
- schema version
- pgvector readiness
- autopilot status
- queue depth
- failed/dead jobs
- cycle lock status
- runner availability
- LLM/provider availability
- connector health
- credential health
- projection drift
- pending reconcile
- quarantine counts
- purge candidates

## Audit Query Surface

MCP/CLI should support:

- list recent mutations
- explain assertion
- explain projection
- list raw accesses
- list runner jobs
- list conflicts
- list forgetting events
- list source health
- read report

## Tests

Required tests:

- report summarizes automatic canonical writes
- report includes forgetting and purge candidates
- report includes failed jobs and projection drift
- user action from report routes through mutation policy
- doctor detects stuck lock and failed projection
- audit explain traces source -> claim -> assertion -> projection
- report redacts secrets

## Acceptance Criteria

- Users can understand what MBrain changed without reviewing every candidate.
- Operational failures are visible.
- Automatic memory changes are auditable and reversible where policy allows.
