# The brain store: Page extraction state

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The extraction watermark and the partial-input receipt (PGLite's `page_extraction_state`, migration v247): one row per page and
pipeline (`facts_backstop`, `extract_atoms`, `conversation_facts`). The watermark is the UTF-8 byte offset of the body the last
successful extraction covered, the sha256 of the body up to it and the pipeline version, so the next extraction of an appended page
reads only the new tail. The receipt (`input_truncated`) is the durable note that an extraction read only part of its input; doctor's
`extraction_input_truncated` check lists it. `src/core/extraction-watermark.ts` owns the policy; the SQL copy is
`src/core/engine-sql/page-extraction-state.ts`. The TypeScript side is `src/core/rust-engine/store-members/page-extraction-state.ts`;
the store is `crates/gbrain-store/src/page_extraction_state.rs`.

| Key | Value | Mirrors |
| --- | --- | --- |
| `~e page_id pipeline` | `{ pipeline_version, watermark_bytes?, watermark_sha256?, input_truncated?, updated_at }` (JSON, `updated_at` in microseconds; a NULL column is absent) | `page_extraction_state` |

The key tag is the two-byte family tag `~e` (`keys::PAGE_EXTRACTION_STATE`, registered in the Tag registry of docs/designs/RUST_ENGINE_INTERFACES.md); the one-byte tag `2` is the core edit notices' (`keys::CORE_EDIT_NOTICE`), and no store holds a record of this family under it. `FORMAT_VERSION` does not change: the family writes nothing until a page is extracted. A
page deleted for good loses every row (`cascade::remove_page_rows`), which a page delete, a retention purge and a source delete all
reach, as PGLite's `ON DELETE CASCADE` does. A soft-deleted page keeps its rows. `input_truncated` keeps its keys in jsonb order.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageExtractionWatermark(sourceId, slug, pipeline)` | `{ page_id, pipeline_version, watermark_bytes, watermark_sha256 }` of the live page (the last three null when it has no row for the pipeline), or null when no live page has that slug in the source | `readPageExtractionWatermark` |
| `brain.commitPageExtraction({ pageId, pipeline, pipelineVersion, watermarkBytes, watermarkSha256, receipt, keepReceipt })` | nothing. A new row takes the receipt; a row that exists takes the version and watermark and keeps its receipt when `keepReceipt`, else takes `receipt` (null clears it) | `commitPageExtraction` |
| `brain.readPageExtractionReceipt(pageId, pipeline)` | the row's receipt, or null when there is no row or the row has no receipt | `readPageExtractionReceipt` |
| `brain.clearPageExtractionState(pageId, pipeline)` | nothing. Deletes the row, watermark and receipt both; no row is a no-op | `clearPageExtractionState` |
| `brain.writePageExtractionReceipt(pageId, pipeline, pipelineVersion, receipt)` | nothing. A new row holds the receipt and no watermark; a row that exists takes the receipt and keeps its watermark and version | `writePageExtractionReceipt` |

What PGLite checks, the store checks, as `constraint_violation` with nothing written: the page must exist (the foreign key to
`pages`), the pipeline must be one of the three, `watermark_bytes` must not be negative and `pipeline_version` must fit an integer. A
receipt that is not a JSON object is `invalid_argument` (the TypeScript caller only sends objects). `extraction-watermark.ts` catches
a failed store call and warns once, as it does on PGLite.

The doctor reads `listAmbiguousExtractionInputs` and `listExtractionInputReceipts` read these rows too
([cli-reads-doctor-derived.md](cli-reads-doctor-derived.md)).

`crates/gbrain-store/tests/page_extraction_state.rs` covers each member and the delete cascade;
`test/engine-parity/page-extraction-state.test.ts` compares the engines.
