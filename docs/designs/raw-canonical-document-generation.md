# Raw Canonical Document Generation

## Goal

MBrain should accept raw source observations and produce reviewable brain-page
drafts in the canonical Markdown shape. The generator exists to make import
quality consistent across meetings, PDFs, papers, technical documents, personal
notes, and source-code snapshots without bypassing governed canonical writes.

## Non-Goals

- It does not write canonical pages directly.
- It does not infer unsupported facts from raw content.
- It does not replace `route_memory_writeback`, candidate review, or `put_page`
  snapshot checks.
- It does not expose secret-bearing or prompt-injection flagged raw text in
  rendered drafts.

## Input Contract

Raw ingestion or an extractor supplies structured observations:

- `source_kind`, `source_id`, `source_item_id`, optional chunk ids, content hash,
  locator, parser version, extractor version, and source update time.
- One or more document requests with `target_slug`, page `type`, `title`, tags,
  source refs, facts, timeline events, optional frontmatter, and safety flags.

The generator treats `source_refs` as the evidence boundary for each fact. A
request without a target slug, source item, source ref, or observation is blocked.

## Output Contract

Each output draft contains:

- canonical page slug, type, title, tags, YAML frontmatter, compiled truth,
  timeline, and full Markdown.
- generated metadata: generator version, review status, candidate-first policy,
  source ids, source item ids, chunk ids, source refs, and content hashes.
- warnings and `blocked_reasons` when the request cannot safely render.

Rendered compiled truth uses inline source citations for every fact. Rendered
timeline events use a stable date from `now` or `source_updated_at`; missing
stable time blocks timeline rendering.

## Safety Model

The generator is preview-only. If a request is blocked, the response returns no
compiled truth, timeline, or Markdown. Blocked drafts also drop caller-provided
title and frontmatter, keeping only safe provenance metadata such as source ids,
chunk ids, source refs, hashes, parser and extractor versions, and policy fields.

Prompt-injection and secret flags are terminal render blocks. Unsupported facts
are blocked instead of emitted as draft truth.

## Graph And Update Model

Extractors should choose target slugs from the canonical filing rules:

- originals -> `brain/originals/{slug}.md`
- concepts -> `brain/concepts/{slug}.md`
- ideas -> `brain/ideas/{slug}.md`
- systems -> `brain/systems/{slug}.md`
- project docs -> `brain/projects/<project>/docs/<topic>.md`

Graph edges are represented in draft text and metadata through canonical links,
source refs, source item ids, chunk ids, content hashes, source versions, dates,
and commit ids when available. Source-code imports should include repository,
commit, path, language, build/test commands, and key entry points in frontmatter.

Future updates should diff new raw observations against the previous source item
hash, then create patch candidates rather than overwriting compiled truth.

## Current MVP

The first implementation provides:

- `generateRawCanonicalDocumentDrafts()` pure service.
- `preview_raw_canonical_document` non-mutating operation.
- Markdown serialization and parse round-trip validation for type, title, tags,
  frontmatter, compiled truth, and timeline.
- blocked-draft sanitization for unsafe or incomplete observations.

Follow-up work can add parser-specific extractors, graph edge planning,
candidate creation, and ergonomic CLI wrappers once the preview contract is
stable.
