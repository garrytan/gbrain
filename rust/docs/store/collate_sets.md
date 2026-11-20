# The brain store: page-set reads of the core commands

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`crates/gbrain-store/src/collate_sets.rs` serves eight typed members that read one source's pages as a set. The SQL lives
in `src/core/engine-sql/collate-page-reads.ts`; the napi family is `crates/gbrain-napi/src/families/collate_sets.rs`; the
TypeScript side is `src/core/rust-engine/store-members/collate-sets.ts`.

| Member | Reads |
| --- | --- |
| `readPageSizeRows` | the live pages (only the named slugs when given) with `embed_skip`, a body over the limit, a segmented body or an embedding ledger row, by slug |
| `listChatChannelCensus` | per source, the live chat pages the caller can read and their distinct channels, by source |
| `listLinkPageMetadataForSlugs` | the live pages of the named slugs as the link resolver reads them, by slug |
| `listAttendedOriginSlugs` | the pages with a canonical `attended` edge to themselves |
| `readCompanyBrainEvidenceRows` | the first ownership edge, first decision supersession and first page of a source |
| `listShelfPageRows` | every live page of a source with its title, type and frontmatter, by slug |
| `listLiveSourceIncarnations` | the id and incarnation of each named source that exists and is not archived |
| `listAttendanceScanWindow` | the first pages of a source after a slug, soft-deleted ones included, by slug |

Rules:

- Rust text orders by byte, as `COLLATE "C"` does. `listAttendedOriginSlugs` and `listLiveSourceIncarnations` have no `ORDER BY`
  in SQL (the callers build a set or a map), and return byte order here.
- A segmented page's size is the `body_bytes` of its body record (0 when the record has none), as the SQL's `body_bytes`
  column is NULL-safe in the caller; an inline page's size is the length of its compiled truth plus its timeline.
- `readCompanyBrainEvidenceRows` counts an edge only when both ends are live pages of the source, its source is `frontmatter` or
  `markdown`, and the edge's own page originated it (or a `markdown` edge has no origin). An ownership pick puts a `customer`
  page first; a supersession needs two `decision` pages.
- `listChatChannelCensus` takes the caller's page policy only when the caller hides private pages. The SQL text is the fast
  page filter, which is the full page policy behind a cheap first test, so the member serves the full policy and refuses when
  the fast form stops wrapping it. A page in an owner-only source that the fast form's first test passes is judged by the
  full policy here.
- A channel is `dm:<slug>` for a direct-message page, else the first non-empty of frontmatter `channel`, `chat`,
  `conversation`, the lower-cased `#name` of the title, then `''`.
