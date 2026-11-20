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
| `brain.stageSegmentChunks(pageId, generation, chunks)` | the chunk indexes, in input order, after the page's highest `chunk_index`. See "Segment chunks" | `stageSegmentChunks` |
| `brain.createSegmentedPageShell(slug, meta, { sourceId })` | `{ id }` of a new page at body generation 0, `body_storage: 'segmented'`, `body_bytes: 0` | `createSegmentedPageShell` |
| `brain.flipBodyGeneration(input)` | `{ retiredChunks, retireDeferred }` | `flipBodyGeneration` |
| `brain.openBodyStaging(input)` | `null`; the staging starts `open` | `openBodyStaging` |
| `brain.setBodyStagingState(id, state, { commitRequestId? }?)` | `null` | `setBodyStagingState` |
| `brain.readSegmentDerivations(pageId, { kind?, occurrenceIds? }?)` | derivation rows by kind, then occurrence; `[]` for an empty `occurrenceIds` | `readSegmentDerivations` |
| `brain.upsertSegmentDerivations(rows)` | `null`. A row with the same `(page, kind, occurrence)` is replaced and keeps its `createdAt` | `upsertSegmentDerivations` |
| `brain.retireSegmentDerivations(pageId, liveOccurrenceIds, { kind? }?)` | the number of rows deleted whose occurrence is not live | `retireSegmentDerivations` |
| `brain.readSegmentedSealLead(pageId)` | `{ lead, revision }`: the page's stored `timeline_lead` (`""` when none) and `knowledge_revision`, or `null` for a missing page. Not a member: `sealSegmentedPage` reads it | (`sealSegmentedPage`'s page read) |
| `brain.sealSegmentedPage(pageId, timeline, expectedRevision?)` | `null`. See "The seal" | `sealSegmentedPage` |
| `brain.refreshPageBody(slug, sourceId, compiledTruth, timeline, contentHash)` | `null`. Sets the body, timeline, hash and `updated_at` of a live inline page; a missing or soft-deleted page is left alone. A new revision only when the body or timeline changed. No re-chunk and no version. A live page's sealed search timeline goes, also when nothing changed, since PGLite's `UPDATE … SET timeline` fires the search vector trigger | `refreshPageBody` |

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

The page row itself stays in the pages family. A segmented page's row holds a NULL `compiled_truth`
and `timeline` (`PageText::null()`), as PGLite's `pages_body_storage_chk` requires. A shell holds a
NULL `content_hash` until a flip publishes the body's hash, and the row's `chunker_version` takes the
meta's value (0 for a shell without one; a flip keeps the stored value when the meta has none). The
TypeScript codec gives a NULL body PGLite's page shape, whose `compiled_truth` and `timeline`
getters throw `page_body_segmented`. `putPage` over a segmented page refuses, as in PGLite (pages
family, shared item 11). The `page_columns` hook adds `body_storage:
'segmented'` and `body_bytes` to a segmented page, so `getPage` shows them as PGLite's `rowToPage`
does; an inline page has neither.

## Crate helpers

- `page_body::timeline_lead(read, page_id)` returns the page's stored `timeline_lead`: the lead the
  last flip published (NUL removed, possibly empty), or `None` for an inline page, a shell that no
  flip has published, or a missing page, where PGLite's column is NULL. A segmented page's row has a
  NULL `timeline`, so the keyword family reads this lead in its place, as PGLite's
  `update_page_search_vector` does with `coalesce(timeline, timeline_lead, '')`.

## The flip

`flipBodyGeneration` runs as one store write and changes nothing when it refuses:

1. `newGeneration` must be `expectedGeneration + 1` (a `TypeError` thrown before the store is called).
2. A missing page refuses `page_identity_changed` (`reason: 'page_deleted'`).
3. A page at another generation refuses `invalid_params` (canonical `revision_changed`) with the
   expected and current generation and a `get_page` fix.
4. A staging that is not `open`, `sealed` or `prepared` refuses `body_staging_expired`.
5. Live rows in `closeOccurrences` get `genTo = newGeneration`; the staging's rows become published.
6. Chunks retire by PGLite's predicate: segment chunks of `retireChunkOccurrences` at or below
   `expectedGeneration`, the inline chunks when `retireInlineChunks`, and segment chunks of
   `newGeneration` whose occurrence is not live in it (the staging's rows plus the open published
   rows not in `closeOccurrences`). They are deleted, unless there are more than `retireMaxRows`
   (then none are, and `retireDeferred` is true).
7. The page row takes the meta (`type`, `page_kind` default `markdown`, `title`, `frontmatter`;
   the other meta fields only when given; `chunker_version` at most 3; `ingested_at` now when a
   provenance field is set), and the body state takes the body columns. The sealed search timeline
   (`pages::forget_search_timeline`) goes, also when the title is unchanged: PGLite's
   `UPDATE … SET title, timeline, timeline_lead` fires its search vector trigger either way.
8. The live rows must tile `body_bytes` from 0 without a gap, with `segment_count` rows; else the
   flip refuses `body_staging_expired` with `reason: 'generation_incomplete'`.
9. The chunks family publishes `newGeneration` (`chunks::publish_segment_chunks`), with the
   `byteStart` of each live row, so chunks staged for it become visible in document order.

The store reports refusals 2, 3, 4 and 8, and the `stageSegmentChunks` refusal, as `invalid_state` with the message `page_body:<json>`;
the TypeScript members rebuild the error PGLite throws, message and fix included.
`setBodyStagingState` follows PGLite: a live staging moves to any state, and a move to a live state
restarts its idle deadline at most one hour ahead, never past its hard deadline. An `aborted` or
`expired` move of an ended staging, or a move to the state it already holds, does nothing. Any other
move of an ended or unknown staging refuses `body_staging_expired`.

## Segment chunks

`stageSegmentChunks(pageId, generation, chunks)` writes chunk rows for a body generation through the
chunks family's segment-chunk helper (`chunks::append_segment_chunks`; its contract is the comment
above "Segment chunks" in `rust/crates/gbrain-store/src/chunks.rs`). In one store write it:

1. Answers `[]` for no chunks, without reading the page.
2. Refuses PGLite's `revision_changed` (legacy `invalid_params`, `detail` `{ staged_generation,
   current_generation }`, `current_generation` `null` for a missing page) when the page is missing,
   `generation` is below the page's body generation, or `generation` is the page's and the page is
   inline or a chunk's occurrence has no published manifest row in that generation.
3. Writes each chunk at the next index after the page's highest `chunk_index` (rows staged, live
   and retired-but-not-deleted all count), in input order, with its occurrence, ordinal and raw
   byte span, and returns the indexes.

The chunks stay out of `getChunks` and keyword search until a flip publishes their generation. The
TypeScript member normalises them as `upsertChunks` does (`prepareChunks`), refuses a chunk that
carries a vector (`engine_capability_missing`: vectors are not stored) and refuses
`opts.embeddingColumn` (PGLite takes the default model label from it). Deleting a page for good
also deletes the chunks family's segment view of the page (`chunks::forget_segment_view`).

## The seal

`sealSegmentedPage(pageId, opts?)` makes a flipped segmented page's chunks and search text visible at
its current revision, as engine-sql/page-body.ts does. The TypeScript member reads the stored lead and
revision (`readSegmentedSealLead`), takes `opts.timelineLead` in place of the lead when given,
sanitizes it with `sanitizeRemoteBody`, and calls `seal_segmented_page`. In one store write it:

1. Does nothing for a missing page.
2. Refuses `revision_conflict` when the page's `knowledge_revision` is no longer the one read.
3. Keeps the page's chunker stamp when it is `SAFE_FENCE_CHUNKER_VERSION` (4) or newer but below
   `SEGMENTED_CHUNKER_VERSION` (5) and a segment chunk of an older body generation is still stored;
   otherwise stamps 5. It sets `text_projection_revision` to the page's revision, so `getChunks`
   shows the published segment chunks.
4. Records the text as the page's sealed search timeline (`pages::record_search_timeline`).

PGLite overlays the page's withdrawals and global purges on the stored lead first. The store keeps no
withdrawal ledger or purge markers, so here that overlay is the identity.

## Refusals

Writes refuse `constraint_violation` where a PGLite table refuses: a missing source, page, staging or
text (foreign keys), a repeated key (primary and unique keys, the live `seq` of a page), an enum
outside its CHECK (kind, mode, region, cut kind, derivation kind and state), a sha256 or hash that is
not 32 bytes, an empty or over 1 MiB segment, a negative count, and `refreshPageBody` over a segmented
page. Malformed input (a bad uuid, a NUL in text, a number outside int4, a negative `lastN`) refuses
`invalid_argument`. The parity cases compare only that these calls throw: PGLite's codes are the
database's own.

Deleting a page for good removes its manifest rows, derivations, body state and stagings; its texts
stay, as in PGLite, for the sweep. The retention purge (`purgeDeletedPages`) differs, as PGLite's
does: in its transaction it also deletes every staging at a purged source and slug (a create
staging names no page), then each text the purged pages named that no manifest row or live staging
still needs. Deleting a source removes its texts and stagings, and refuses
`constraint_violation` while a manifest row of any page names one of its texts (PGLite's manifest
foreign key to the texts has no cascade).

## Not served

The TypeScript engine refuses these with `engine_capability_missing`:

- `sweepSegments`: its roots include page versions by body generation and the journal's staging
  references, which this family cannot read yet.
- A segmented page inside `transaction`: the store has no transactions yet, so the parity cases that
  stage inside one stop on that refusal.

## Known differences from PGLite

- `stageSegmentChunks` reads occurrence ids, ordinals and byte spans as unsigned numbers; a negative
  one refuses `invalid_argument`. PGLite's columns are signed, but its occurrence ids come from a
  sequence that starts at 1.
- When `prepareChunks` refuses a chunk setting inside `stageSegmentChunks`, its message names
  `upsertChunks`, the member it was written for, not `stageSegmentChunks`. The refusal code is the
  same.
- A flip unseals the page's text projection on both engines, so `getChunks` answers `[]` for a
  segmented page after a flip until a text-projection seal exists (`sealSegmentedPage`). This is
  parity.
- `upsertSegmentDerivations` never refuses `derivation_purge_pending`: the store has no fact-purge
  sweep to hold rows.
