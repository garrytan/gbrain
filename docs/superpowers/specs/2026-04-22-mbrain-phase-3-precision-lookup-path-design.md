# Phase 3 Precision Lookup Path Design

## Goal

Extend the published note-corpus precision lookup route so callers can resolve an
exact canonical artifact by repo-relative Markdown path, including an anchored
section fragment such as `systems/mbrain.md#overview/runtime`, not only by slug
or section id.

## Scope

- exact note-manifest page path match
- exact note-section anchored path match via existing `heading_path`
- additive extension to `precision-lookup-route`
- reuse existing structural pagination rather than new engine filters

## Non-Goals

- fuzzy path lookup
- raw source-record routing outside note manifest
- path filtering at the engine contract level

## Acceptance

- service resolves an exact canonical page by `path`
- service resolves an exact canonical section by anchored `path`
- operation exposes the same behavior
- retrieval-route selector exposes the same behavior
- benchmarks still pass and now cover page-path and section-path cases
