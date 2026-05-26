# Phase 10: System Of Record Reconciler

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 04 and Phase 05

## Goal

Keep Postgres canonical state and Markdown/frontmatter/fence projections aligned.
The reconciler detects drift, repairs failed dual-writes, rebuilds derived tables,
and protects human-readable long-term memory.

## Design Decisions

- Postgres is target backend, but long-term user knowledge must be
  Markdown-representable.
- Canonical mutation is dual-write with required reconciliation.
- Runtime state can be Postgres-only.
- Reconciler is the legitimate repair path for projection drift.

## In Scope

- projection target registry.
- projection mutation schema.
- Markdown/frontmatter/fence writer contracts.
- drift detection.
- repair jobs.
- projection hash tracking.
- projection metadata repair from Markdown where supported.
- Markdown edit import through raw ingest and assertion policy.
- rebuild Markdown from assertions where supported.
- system-of-record doctor checks.

## Out Of Scope

- Full redesign of every existing Markdown page format.
- Web diff UI.
- External sync/push workflow.

## Projection Targets

Projection target types:

- `markdown_page`
- `page_timeline`
- `profile_memory`
- `personal_episode`
- `task_resume`
- `project_doc`
- `system_doc`
- `source_summary`
- `daily_report`

Each target records:

- target id
- target type
- path or DB locator
- source assertion ids
- projection hash
- last rendered at
- last reconciled at
- status

## Reconciler Modes

`check`:

- compare DB projection hash with Markdown hash
- report drift only

`repair_markdown`:

- render Markdown projection from canonical assertions

`repair_db`:

- repair DB projection metadata from Markdown/fence/frontmatter where supported
- never create or update semantic assertions directly from Markdown text

`import_markdown_edit`:

- create a `markdown_file` source item with `origin_event = markdown_edit` for
  supported human Markdown changes
- send changed content through raw ingest, extraction, assertion resolution, and
  canonical write policy

`rebuild_derived`:

- regenerate derived indexes from canonical state

`quarantine_conflict`:

- stop automatic repair when both sides changed incompatibly

## Markdown Contracts

Long-term knowledge projections should have stable parse/render contracts.

Use:

- frontmatter for metadata
- compiled truth section
- append-only timeline section
- fences for structured assertion-backed tables where needed
- source attribution blocks
- projection hash comments where useful

Round-trip parser/writer tests are required for every structured projection
format.

Round-trip support is not authority to bypass governance. Parsed Markdown content
can repair projection records and hashes. Semantic content changes must become
source-backed claims before they can affect canonical memory.

## Safety

- Reconciler must not silently discard user Markdown edits.
- If Markdown and DB both changed since last projection hash, create conflict.
- Repair operations must log mutation events.
- `repair_db` must not bypass extracted claims, assertion resolution, or Phase
  04 policy.
- Runtime-only tables are excluded from Markdown system-of-record checks.
- Failed projection writes become report items.

## Tests

Required tests:

- projection hash detects drift
- repair_markdown restores missing projection
- repair_db repairs projection metadata without semantic assertion mutation
- import_markdown_edit creates source-backed claims for supported Markdown
  changes using `origin_event = markdown_edit`
- conflicting DB/Markdown edits become conflict
- structured fence round-trips byte-stably for unchanged data
- runtime-only state is not required to round-trip
- doctor reports pending_reconcile and failed projections

## Acceptance Criteria

- DB and Markdown projection drift is visible.
- Critical projections can be repaired.
- Long-term user knowledge remains human-readable.
- Later migrations can rely on reconciler to avoid silent corruption.
