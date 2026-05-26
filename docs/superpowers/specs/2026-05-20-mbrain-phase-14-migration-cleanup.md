# Phase 14: Migration And Cleanup

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 13

## Goal

Complete the transition from the current mixed/SQLite-oriented implementation to
the Postgres-only personal memory runtime. Remove or clearly quarantine legacy
paths, update documentation, and provide a safe manual or one-shot migration
path for the existing user.

## Design Decisions

- This repo has one primary user for this transition.
- Manual migration is acceptable.
- New target behavior does not need SQLite/PGLite parity.
- Cleanup should happen after replacement systems are verified.
- Legacy code may remain temporarily only when isolated from target behavior.

## In Scope

- final docs update.
- CLI help update.
- AGENTS/MBrain rules update.
- setup-agent prompt update.
- legacy engine quarantine or removal.
- one-shot migration helper or manual migration guide.
- config cleanup.
- test cleanup.
- old roadmap cleanup.
- release/PR summary.

## Out Of Scope

- Supporting third-party users on old SQLite runtime.
- Building compatibility layers for old DB-only state.
- Hosted migration service.

## Migration Path

Migration should document:

1. backup current repo and DB
2. initialize local Postgres target
3. sync Markdown canonical pages
4. import legacy candidates/profile/task data where useful
5. run extraction/assertion rebuild
6. run projection reconciler
7. run eval/replay smoke
8. run doctor
9. enable autopilot through onboarding

DB-only legacy state can be manually reviewed if not worth automated migration.

## Cleanup Targets

Potential cleanup:

- docs describing SQLite as recommended target
- CLI defaults pointing to SQLite
- tests that enforce SQLite parity for new runtime
- old conservative gbrain absorption roadmap language
- obsolete dream maintenance docs
- setup prompts that describe manual writeback as the primary path
- stale engine capability matrix

Do not remove old code before replacement acceptance criteria pass.

## Prompt / Agent Rule Updates

Agent-facing rules must reflect:

- read MBrain first when relevant
- session-scoped trust
- automatic canonical write exists
- route durable signals through new assertion pipeline
- raw source access is scoped
- secrets are never canonical memory
- local Codex/Claude runner may be used by maintenance runtime
- daily report is primary review surface

## Tests

Required tests:

- migration guide commands are valid
- doctor passes after migration
- old SQLite config no longer selected by fresh init
- legacy engine tests are isolated or removed
- setup-agent prompts mention Postgres runtime and automatic memory pipeline
- no docs claim SQLite is the target default
- eval/replay smoke passes after migration

## Acceptance Criteria

- Fresh install and docs point to Postgres-only target.
- Existing user can move data safely.
- Legacy paths do not constrain target implementation.
- PR summary clearly explains the architectural transition.
