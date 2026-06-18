# GBrain Radar — Snapshot Export Design Doc

**Status:** Phase 0/1 — IMPLEMENTED (exporter slice). Frontend deferred.
**Date:** 2026-06-18.
**Scope:** Backend/exporter only. `gbrain radar export` + the snapshot schema.

---

## 0. Context

Radar is a **visual mirror** of a GBrain brain — a read-only way to *see* what the
brain already knows (pages, folders, links, recency) without standing up a second
system of record. The brain stays the source of truth. Radar never writes back, never
re-derives knowledge, and never becomes a parallel store.

This document records the architecture decisions for the first verifiable slice: a
snapshot exporter. It deliberately stops short of a live API or a rendered frontend.

## 1. North Star fit

GBrain aims to be the next Postgres for memory. A visual mirror has to be *cheap to
produce*, *safe by default*, and *honest about what the brain actually stored*. Those
three properties drive every decision below:

- **Cheap to produce** → snapshot-first, generated from the engine in one pass.
- **Safe by default** → private/secret, scope/privacy-aware, no live attack surface.
- **Honest** → the exporter reads the GBrain engine/DB, never re-walks or re-parses the
  Markdown vault. What Radar shows is what GBrain stored, not a second interpretation
  of the filesystem.

## 2. Decisions (approved)

| # | Decision | Rationale |
|---|---|---|
| D1 | Radar is a **visual mirror, not a second GBrain**. | The brain is the system of record. Radar is a derived, disposable view. |
| D2 | **Snapshot-first** architecture. `gbrain radar export` emits a static snapshot. | No live service to operate or secure in the MVP. A snapshot is trivially cacheable, diffable, and shippable. |
| D3 | **Full atomic export** in v1; incremental deferred. | Correctness over cleverness. A full pass is simple to reason about and validate. The schema carries incremental-ready primitives so v2 is additive. |
| D4 | **No Python / FastAPI.** Exporter is internal to GBrain, TypeScript/Bun. | One toolchain, one test surface, one release process. Reuses the existing engine. |
| D5 | **Engine/DB-only exporter boundary.** | The exporter calls `BrainEngine` methods (`listPages`, `getLinks`, `getTags`, …). It does NOT read the Markdown vault from disk. This is the load-bearing invariant — it guarantees Radar mirrors the brain, not the filesystem. |
| D6 | **Raw Markdown + client-side render.** Exporter does NOT pre-render HTML. | Keeps the snapshot small and render-agnostic; any frontend chooses its own renderer. |
| D7 | **Snapshot is private/secret, scope/privacy-aware.** | The snapshot can contain everything the brain knows. It defaults to excluding pages classified private; `--include-private` is an explicit opt-in. Metadata + filtering hooks are recorded in the manifest. |
| D8 | **Search v1 is lean.** Title / path / headings / tags / frontmatter text — NOT giant full-content by default. | A browsable index, not a second retrieval engine. Full-content search stays in GBrain proper. |
| D9 | **Graph data emitted; frontend not required this phase.** | The exporter writes `graph.json` from actually-stored links so a later global-graph view is a pure frontend addition. |

## 3. Architecture

```
   ┌─────────────────────────────────────────────────────────────┐
   │  gbrain radar export   (src/commands/radar.ts)              │
   │    flags → opts, progress on stderr, summary on stdout      │
   └───────────────┬─────────────────────────────────────────────┘
                   │ engine (PGLite | Postgres)
                   ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  buildSnapshot()   (src/core/radar/export.ts)              │
   │   listPages → per-page (getTags, getLinks) → headings        │
   │   global edge set → graph + inlink/outlink counts            │
   │   privacy classify → include/exclude                         │
   └───────────────┬─────────────────────────────────────────────┘
                   ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  validate → write tmp → verify on disk → atomic swap         │
   │   snapshot/.tmp-<id>/  →  snapshot/current/                  │
   │   prior current preserved as  snapshot/previous/             │
   └─────────────────────────────────────────────────────────────┘
```

### 3.1 Why engine-only (D5) matters

A naive mirror would re-walk the vault and re-parse Markdown. That produces a *second*
interpretation that can silently diverge from what GBrain indexed (slugs, frontmatter
coercion, timeline splitting, soft-deletes, multi-source scoping). Radar reads the same
rows GBrain serves, through the same `BrainEngine` interface the CLI and MCP server use.
If GBrain dropped a page (soft-delete), scoped it to a source, or normalized its
frontmatter, Radar reflects exactly that.

### 3.2 Atomic export (D3)

Output lives under a base dir (`--out`, default `$GBRAIN_HOME/.gbrain/radar`):

```
<out>/snapshot/
  current/      ← the live snapshot (swapped in atomically)
  previous/     ← the prior current, preserved on each run
  .tmp-<id>/    ← scratch; renamed to current on success, removed on failure
```

The exporter writes the whole snapshot into `.tmp-<id>/`, validates referential
integrity, verifies every promised file exists on disk, then:

1. `current/` (if present) → `previous/` (replacing any older `previous/`).
2. `.tmp-<id>/` → `current/`.

Renames are within one filesystem (all under `snapshot/`), so the swap is atomic. A
crash mid-write only ever leaves an orphan `.tmp-<id>/`; `current/` is never partially
written.

### 3.3 Incremental-ready primitives (D3)

v1 always emits `mode: "full"`, but the manifest carries the fields a v2 incremental
exporter needs:

- `snapshot_id` — unique id for this snapshot.
- `previous_snapshot_id` — the id of the snapshot being replaced (null on first run).
- `content_hash` — a fingerprint over every page's content hash. A future incremental
  run compares this to short-circuit "nothing changed", and per-page `content_hash` in
  `pages-index.json` lets it compute a precise changed-set.

No incremental code ships in v1. These are inert metadata until v2.

## 4. Snapshot layout

```
snapshot/current/
  manifest.json          identity, versions, counts, validation, warnings
  tree.json              folder → pages tree (derived from slugs)
  pages-index.json       lean per-page rows (identity + counts + flags)
  graph.json             nodes + edges from stored links
  search-index.json      lean search docs (title/path/headings/tags/frontmatter text)
  views/recent.json      most-recent pages view
  pages/<safe slug>.json per-page detail (identity, raw markdown, headings, links)
```

### 4.1 Identity (D / decision 4)

Identity is **source-scoped**. Every record carries:

- `brain_id` — `$GBRAIN_BRAIN_ID` or `host` (the default brain).
- `source_id` — the owning source within the brain.
- `slug` — unique within `(source_id, slug)`.
- `page_key` — stable composite `"<source_id>::<slug>"`, used to cross-reference
  pages-index ↔ graph ↔ search-index ↔ per-page files.

### 4.2 Privacy / scope (D7)

Core GBrain has no single canonical "privacy" column; privacy is expressed in page
frontmatter. The exporter classifies a page **private** when any of these hold:

- `frontmatter.privacy ∈ {private, secret}`
- `frontmatter.scope ∈ {private, secret}`
- `frontmatter.visibility = private`
- `frontmatter.secret = true`
- `frontmatter.public = false`

Private pages are **excluded by default** and included only with `--include-private`.
The count of excluded pages is recorded in the manifest. `--scope <label>` records the
operator's intent in `manifest.requested.scope` for the snapshot consumer; it is a
provenance label, not a hard content filter (kept honest given the frontmatter-driven
classification). `--source-id <id>` hard-scopes the export to a single source.

## 5. Non-goals (this phase)

- No Python/FastAPI service.
- No live HTTP API, no `sync-export`.
- No true incremental export.
- No pre-rendered HTML.
- No re-parse of the Markdown vault from the filesystem.
- No frontend (graph view, page view) — the data is emitted; rendering is a later phase.

## 6. Testing

`test/radar-export.test.ts` drives the exporter against an in-memory PGLite engine
(seeded pages, links, tags, a private page) and asserts: the snapshot layout exists,
referential integrity holds (every graph edge endpoint and every pages-index file
resolves), privacy default-exclusion works, `--include-private` opts in, atomic swap
preserves the prior snapshot as `previous/`, and the manifest carries the
incremental-ready fields. The exporter is engine-only, so the test needs no filesystem
vault.
