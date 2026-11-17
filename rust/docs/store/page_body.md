# The brain store: Segmented page bodies

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A segmented page keeps its body as deduplicated segment texts plus a manifest of rows ranged over
body generations, instead of one `compiled_truth` string. A write opens a staging, stages texts and
manifest rows under it, then flips the page to the next generation. This family also holds the
per-segment derivation watermarks and `refreshPageBody`. Records live under tag `b`
(`keys::PAGE_BODY`); the code is `rust/crates/gbrain-store/src/page_body.rs`, the binding
`rust/crates/gbrain-napi/src/families/page_body.rs` and the members
`src/core/rust-engine/store-members/page-body.ts`.

Bytes (sha256, segment bodies, hash states, derivation hashes) cross the binding as lowercase hex;
the TypeScript members turn them into `Uint8Array`. Staging deadlines and `effective_date` cross as
ISO strings. Derivation `createdAt` and `updatedAt` are `YYYY-MM-DDTHH:MM:SS.ffffffZ`, as PGLite's
`to_char` gives them. Manifest `dateMin` and `dateMax` are `YYYY-MM-DD` or `null`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.allocateBodyOccurrenceIds(count)` | ascending ids from one brain-wide counter; `[]` for a count of 0 or less | `allocateBodyOccurrenceIds` |
| `brain.stageSegmentTexts(sourceId, [{ sha256, body, lineCount }], { stagingId? }?)` | `{ inserted }`. A text that exists only has its `created_at` refreshed; the first copy of a repeated sha in one call wins. With `stagingId`, each text is also recorded under the staging | `stageSegmentTexts` |
| `brain.readSegmentTexts(sourceId, [sha256])` | `[sha256, body]` pairs of the texts found, in request order, each sha once. The TypeScript member returns PGLite's `Map` | `readSegmentTexts` |
| `brain.stageManifestRows(rows)` | `null` | `stageManifestRows` |
| `brain.readManifest(pageId, { generation?, stagingId?, region?, lastN? }?)` | manifest rows by `seq`. With `stagingId`, that staging's rows; else the rows of `generation`, default the page's live `body_generation` (0 for a missing page or one with no segmented state). `lastN` keeps the last rows, still in `seq` order. An empty `region` is ignored, as in PGLite | `readManifest` |
| `brain.createSegmentedPageShell(slug, meta, { sourceId })` | `{ id }` of a new page at body generation 0, `body_storage: 'segmented'`, `body_bytes: 0` | `createSegmentedPageShell` |
| `brain.flipBodyGeneration(input)` | `{ retiredChunks, retireDeferred }` | `flipBodyGeneration` |
| `brain.openBodyStaging(input)` | `null`; the staging starts `open` | `openBodyStaging` |
| `brain.setBodyStagingState(id, state, { commitRequestId? }?)` | `null` | `setBodyStagingState` |
| `brain.readSegmentDerivations(pageId, { kind?, occurrenceIds? }?)` | derivation rows by kind, then occurrence; `[]` for an empty `occurrenceIds` | `readSegmentDerivations` |
| `brain.upsertSegmentDerivations(rows)` | `null`. A row with the same `(page, kind, occurrence)` is replaced and keeps its `createdAt` | `upsertSegmentDerivations` |
| `brain.retireSegmentDerivations(pageId, liveOccurrenceIds, { kind? }?)` | the number of rows deleted whose occurrence is not live | `retireSegmentDerivations` |
| `brain.refreshPageBody(slug, sourceId, compiledTruth, timeline, contentHash)` | `null`. Sets the body, timeline, hash and `updated_at` of a live inline page; a missing or soft-deleted page is left alone. A new revision only when the body or timeline changed. No re-chunk and no version | `refreshPageBody` |

## Keys under tag `b`

Page ids are 8-byte big-endian. Signed numbers (occurrence ids, generations) are stored as
`v XOR 2^63`, big-endian, so they sort by value.

| Kind byte | Key after the kind | Value |
| --- | --- | --- |
| `0x01` text | `source \0 sha256(32)` | byte length, line count, body, `created_at` |
| `0x02` manifest | `page, occurrence, gen_from, staging(16; zero when published)` | the manifest row |
| `0x03` staging | staging uuid text | the staging record |
| `0x04` derivation | `page, kind \0, occurrence` | the derivation row |
| `0x05` body state | `page` | the segmented body columns of the page |
| `0x06` staging client | `principal_kind \0 principal_id \0 client_request_id` | staging id |
| `0x07` staging text | `staging id, sha256` | source id |
| `0x08` page stagings | `page, staging id` | empty |

The page row itself stays in the pages family. The `page_columns` hook adds `body_storage:
'segmented'` and `body_bytes` to a segmented page, so `getPage` shows them as PGLite's `rowToPage`
does; an inline page has neither.

## The flip

`flipBodyGeneration` runs as one store write and changes nothing when it refuses:

1. `newGeneration` must be `expectedGeneration + 1` (a `TypeError` thrown before the store is called).
2. A missing page refuses `page_identity_changed` (`reason: 'page_deleted'`).
3. A page at another generation refuses `invalid_params` (canonical `revision_changed`) with the
   expected and current generation and a `get_page` fix.
4. A staging that is not `open`, `sealed` or `prepared` refuses `body_staging_expired`.
5. Live rows in `closeOccurrences` get `genTo = newGeneration`; the staging's rows become published.
6. With `retireInlineChunks`, the page's chunks are deleted, unless there are more than
   `retireMaxRows` (then none are, and `retireDeferred` is true).
7. The page row takes the meta (`type`, `page_kind` default `markdown`, `title`, `frontmatter`;
   the other meta fields only when given; `chunker_version` at most 3; `ingested_at` now when a
   provenance field is set), and the body state takes the body columns.
8. The live rows must tile `body_bytes` from 0 without a gap, with `segment_count` rows; else the
   flip refuses `body_staging_expired` with `reason: 'generation_incomplete'`.

The store reports refusals 2, 3, 4 and 8 as `invalid_state` with the message `page_body:<json>`;
the TypeScript members rebuild the error PGLite throws, message and fix included.
`setBodyStagingState` follows PGLite: a live staging moves to any state, and a move to a live state
restarts its idle deadline at most one hour ahead, never past its hard deadline. An `aborted` or
`expired` move of an ended staging, or a move to the state it already holds, does nothing. Any other
move of an ended or unknown staging refuses `body_staging_expired`.

## Refusals

Writes refuse `constraint_violation` where a PGLite table refuses: a missing source, page, staging or
text (foreign keys), a repeated key (primary and unique keys, the live `seq` of a page), an enum
outside its CHECK (kind, mode, region, cut kind, derivation kind and state), a sha256 or hash that is
not 32 bytes, an empty or over 1 MiB segment, a negative count, and `refreshPageBody` over a segmented
page. Malformed input (a bad uuid, a NUL in text, a number outside int4, a negative `lastN`) refuses
`invalid_argument`. The parity cases compare only that these calls throw: PGLite's codes are the
database's own.

Deleting a page for good removes its manifest rows, derivations, body state and stagings; its texts
stay, as in PGLite, for the sweep. Deleting a source removes its texts and stagings, and refuses
`constraint_violation` while a manifest row of any page names one of its texts (PGLite's manifest
foreign key to the texts has no cascade).

## Not served

The TypeScript engine refuses these with `engine_capability_missing`:

- `stageSegmentChunks`: segment chunk rows need an occurrence-keyed chunk append in the chunks family
  and the embeddings work. Until then a flip retires only inline chunks.
- `sweepSegments`: its roots include page versions by body generation and the journal's staging
  references, which this family cannot read yet.
- A segmented page inside `transaction`: the store has no transactions yet, so the parity cases that
  stage inside one stop on that refusal.

## Known differences from PGLite

- The shell's `content_hash`, `compiled_truth` and `timeline` are `''` in the page record, where
  PGLite stores `NULL`. `getPage` hides the body fields on both engines; `content_hash` reads `''`
  on Rust and `null` on PGLite for a shell that was never flipped.
- PGLite's `Page` of a segmented body refuses a read of `compiled_truth` or `timeline`; the Rust
  engine's `Page` returns `''`.
- `putPage` over a segmented page refuses on PGLite (a CHECK on `body_storage`); the store writes the
  inline body and leaves the segmented body state behind.
- `upsertSegmentDerivations` never refuses `derivation_purge_pending`: the store has no fact-purge
  sweep to hold rows.
