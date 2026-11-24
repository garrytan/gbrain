# The brain store: doctor page reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the page-table statements that `gbrain doctor` checks ran through `executeRaw`. PGLite and Postgres run the same
SQL as before (`src/core/engine-sql/doctor-pages.ts`; the text is pinned by `test/doctor-pages-sql.test.ts`). The store
answers from the page records each statement read (`crates/gbrain-store/src/cli_reads/doctor_pages.rs`) and has no keys
of its own. The TypeScript side is `src/core/rust-engine/store-members/doctor-pages.ts`. The cross-engine cases are in
`test/engine-parity/doctor-pages.test.ts`; the store's own are in `crates/gbrain-store/tests/cli_reads_doctor_pages.rs`.

| JS | Resolves | Doctor check |
| --- | --- | --- |
| `listOversizedPages(minBytes)` | live pages without an `embed_skip` key whose body plus timeline bytes pass `minBytes`, largest first, at most 101 | `oversized_pages` |
| `listScraperJunkCandidates(limit \| null)` | live pages with title, body and timeline heads, frontmatter and whether the page is segmented, newest update first (`limit`), or all | `scraper_junk_pages` |
| `countMarkedPages('quarantine' \| 'content_flag')` | live pages whose frontmatter has the key | `quarantined_pages`, `flagged_pages` |
| `countOversizedCorePages(maxBytes)` | live `always_load` pages stored in segments over `maxBytes` | `core_memory` |
| `readRawProvenanceGaps()` | `{count, slugs}` of synthesized pages with no trace; the five-slug sample is read only when the count is over 0 | `raw_provenance` |
| `countUnverifiedExtractions(days, sourceId \| null)` | live unverified auto-extracted pages created before now minus `days` | `unverified_extractions` |
| `listContentHashDuplicates()` | `{source_id, content_hash, slugs}` groups, at most 51 | `content_hash_duplicates` |
| `countTranscriptImportPages()` | live `conversation` pages with a `transcript_import` key | `transcript_secret_exposure` |
| `countPageRows()` | every page row, soft-deleted included | skill preconditions |
| `countPagesBySlugPrefix(prefix)` | page rows whose slug starts with the literal `prefix` | skill preconditions |
| `countLivePages()` | live pages | `backup_coverage` |
| `readOldestPageCreatedAt()` | the earliest `created_at` as an ISO string, or null | `unattended_maintenance` |
| `countPageTrustTiers()` | `{tier, n}` per stored tier (pages table only) | `trust_tiers` |
| `countPagesWithMentionLinks()` | live pages with an outgoing `mentions` link | `stale_mentions` |
| `countImageModalityMismatches()` | always 0 (see below) | `cross_modal_modality_backfill` |
| `readImagePageCoverage()` | `{image_pages, without_image_vector, null_source_path}` | `image_embedding_coverage` |
| `listFactsPageBodies()` | live `facts` pages: `{slug, source_id, segmented, body}` by source and slug | `facts_undated_lines` |
| `listBracketPathPages()` | live pages whose `source_path` holds `[`, `]` or a control character | `malformed_path_pages` |
| `listSlugPathCandidates(sourceIds \| null)` | live pages with a source path and an unusual slug, in id order, in unarchived sources, at most 20001 | `slug_path_mismatch` |

## How each read follows the SQL

- Every read except `countImageModalityMismatches` is served from the page records. A soft-deleted page is `deleted_at`
  set. Counts that the SQL ran over the whole table (`countPageRows`, `countPageTrustTiers`, `readOldestPageCreatedAt`)
  include soft-deleted pages.
- Sizes: `octet_length` is the UTF-8 byte count and `left(x, n)` counts characters, so the store counts bytes for
  `listOversizedPages` and `countOversizedCorePages`, and characters for the heads in `listScraperJunkCandidates` and the
  65536-character body of `listFactsPageBodies`. A page stored in segments has NULL body columns: it is skipped by
  `listOversizedPages`, has a null `body_head` in `listScraperJunkCandidates`, and takes `truth_lead` as the facts body.
- Order: where the SQL left the order to Postgres the store returns a stable one: `listContentHashDuplicates` groups by
  source id then hash, `listBracketPathPages` by page id. The TypeScript checks do not depend on either. Slugs inside a
  duplicate group are sorted by character count, then bytes, as `ORDER BY length(slug), slug` does in the `C` collation.
- `countImageModalityMismatches` is empty-no-writer: it counts chunks with an `embedding_image` vector that are not
  tagged `image`. The store keeps no `embedding_image` vector and has no writer for one, so the answer is 0 and the
  member makes no store call. If the store ever gains an image vector, this member must read it.
- `readImagePageCoverage` has the same rule: no image page has an image vector in the store, so `without_image_vector`
  equals `image_pages`.
- `countPagesBySlugPrefix` takes the prefix literally. The TypeScript engines escape `%`, `_` and `\` for `LIKE`; the
  store does not need to.
- `listBracketPathPages` evaluates `[[:cntrl:]]` as PGLite and the test Postgres do: U+0001 to U+001F, and U+007F to
  U+009F. It was probed by running `chr(i) ~ '[[:cntrl:]]'` over every code point below U+30D40 except surrogates; the
  line and paragraph separators (U+2028, U+2029) and the interlinear annotations (U+FFF9 to U+FFFB) do not match. A
  server on another libc locale could widen the class; the store follows the two engines the parity test runs.
- `listSlugPathCandidates` does not run a regular expression: the candidate predicate is hard-coded as the pattern
  `[^a-z0-9/._-]|--|-/|/-|^-|-$|//` means (a character outside the set, a hyphen run, a hyphen at either edge or next
  to a slash, or an empty segment). A page in an archived source is left out, as the join on `sources` leaves it out.
- `readRawProvenanceGaps` finds a page's `raw_data` rows by the `r 0x01 <page id>` key prefix and its synthesis
  evidence by `A 0x03 <page id>`. `extract_atoms%` is a literal prefix test with `_` escaped, as in the SQL.
- `countUnverifiedExtractions` takes its cutoff from the store's clock, `now - days * 86400e6` microseconds, where the SQL
  uses `now()`; a fractional or negative `days` works as the interval does.
