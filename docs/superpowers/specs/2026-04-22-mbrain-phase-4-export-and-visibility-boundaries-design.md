# Phase 4 Export and Visibility Boundaries Design

## Goal

Make personal-memory export behavior explicit and safe by default, so normal
workspace export paths stay work-visible while personal export remains curated.

## Scope

- keep default `export` page-oriented and unchanged for canonical workspace pages
- add one explicit personal export mode for curated profile-memory records
- export only `profile_memory_entries` with `export_status === "exportable"`
- keep `personal_episode_entries` excluded from raw export in this slice
- publish verification coverage for the service, shared operation, CLI boundary,
  benchmark slice, and Phase 4 acceptance pack

## Non-Goals

- exporting private-only personal profile records
- exporting raw personal-episode records
- mixed-scope export routing
- changing canonical storage schemas for profile memory or personal episodes

## Export Rules

- default `export` continues to serialize only canonical pages plus raw sidecars
- `--personal-export` is an explicit alternate mode, not an additive flag layered
  on top of page export
- explicit personal export writes Markdown only for curated profile-memory records
- personal episodes remain private-by-default and do not produce export files in
  this slice

## Acceptance

- default export does not pull profile memory or personal episodes into the output
- explicit personal export writes only exportable profile-memory Markdown
- private-only profile-memory entries stay excluded
- personal episodes stay excluded from export output
- `test:phase4` and `bench:phase4-acceptance` both cover the published boundary
