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

## How To Use

Use the generator after raw source registration or extraction has already
produced structured observations. The preview does not mutate canonical memory.

1. Identify or register the source and raw item.
2. Extract observations into one or more document requests.
3. Run `preview_raw_canonical_document`.
4. Inspect `drafts[].blocked_reasons`, `warnings`, and `markdown`.
5. Send accepted draft content through the governed writeback path, such as
   `route_memory_writeback` or a reviewable patch candidate. Do not treat preview
   output as permission to call `put_page` directly.

Minimum required fields:

| Field | Purpose |
|-------|---------|
| `source_kind` | Source policy family, such as `meeting_transcript` |
| `source_id` | Source registry id used for provenance |
| `source_item_id` | Stable raw source item id |
| `documents[].target_slug` | Intended canonical brain page slug |
| `documents[].source_refs` | Evidence refs for the facts/events in that document request |
| `documents[].facts` or `documents[].timeline_events` | Extracted observations to render |

For multi-field payloads, `mbrain call` is the least surprising invocation:

```bash
cat > /tmp/raw-canonical-preview.json <<'JSON'
{
  "source_kind": "meeting_transcript",
  "source_id": "source:weekly-sync",
  "source_item_id": "source-item:weekly-sync-2026-06-18",
  "source_item_title": "Weekly Sync",
  "source_content_hash": "sha256:abc123",
  "source_locator": "file:///notes/weekly-sync.md",
  "source_updated_at": "2026-06-18T09:00:00.000Z",
  "parser_version": "meeting-parser:v1",
  "extractor_version": "meeting-observation-extractor:v1",
  "generator_version": "raw-canonical-document-generator:v1",
  "now": "2026-06-18T10:00:00.000Z",
  "documents": [
    {
      "target_slug": "projects/search/docs/weekly-sync",
      "type": "project",
      "title": "Weekly Sync",
      "tags": ["meeting", "search"],
      "source_refs": ["Meeting notes \"Weekly Sync\", 2026-06-18 09:00 KST"],
      "source_chunk_ids": ["source-chunk:weekly-sync:1"],
      "facts": ["Search launch was moved to Friday."],
      "timeline_events": ["Search launch date changed."],
      "frontmatter": {
        "source_paths": ["notes/weekly-sync.md"],
        "source_version": "2026-06-18"
      }
    }
  ]
}
JSON

mbrain call preview_raw_canonical_document "$(cat /tmp/raw-canonical-preview.json)"
```

For quick shell usage, the CLI alias accepts `documents` as a JSON array string:

```bash
mbrain raw-canonical-preview \
  --source-kind meeting_transcript \
  --source-id source:weekly-sync \
  --source-item-id source-item:weekly-sync-2026-06-18 \
  --source-updated-at 2026-06-18T09:00:00.000Z \
  --documents "$(jq -c '.documents' /tmp/raw-canonical-preview.json)"
```

Successful output has `blocked_reasons: []` and a non-empty `markdown` field.
Blocked output intentionally has empty `compiled_truth`, `timeline`, and
`markdown`; inspect `blocked_reasons` before changing the extractor or source
metadata.

Common blocked reasons:

| Reason | Meaning |
|--------|---------|
| `missing_target_slug` / `invalid_target_slug` | The draft cannot be filed safely |
| `missing_source_ref` | Facts/events have no evidence boundary |
| `missing_source_item` | The preview is not tied to a raw source item |
| `unsafe_markdown_observation` | A fact/event contains multiline Markdown-like content |
| `prompt_injection_flagged` / `secret_detected` | Safety scan blocked rendering and redacted returned source refs |
| `conflicting_page_identity` | Same slug requests disagreed on page type or title |
| `conflicting_frontmatter` | Same slug requests had conflicting scalar metadata |

Raw observation text should not include preformatted `[Source: ...]` markers.
The generator strips extracted source markers and appends only the validated
`documents[].source_refs` for that observation.

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
When multiple requests target the same slug, the draft frontmatter lists the
union of source refs, but each rendered fact or timeline event keeps only the
source refs from its own request.

## Safety Model

The generator is preview-only. If a request is blocked, the response returns no
compiled truth, timeline, or Markdown. Blocked drafts also drop caller-provided
title and frontmatter, keeping only safe provenance metadata such as source ids,
chunk ids, source refs, hashes, parser and extractor versions, and policy fields.

Prompt-injection and secret flags are terminal render blocks. Unsupported facts
are blocked instead of emitted as draft truth.
Safety-blocked drafts also redact returned source refs and chunk ids because
those values may have been derived from unsafe input.

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
candidate creation, and richer CLI wrappers once the preview contract is stable.
