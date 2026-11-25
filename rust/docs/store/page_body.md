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
| `brain.readSegmentedEmbedPage({ id } \| { sourceId, slug })` | the embed fields of the page the ref names (`id`, `slug`, `source_id`, `title`, `contextual_retrieval_mode`, `body_bytes`) when its body state is segmented, it is not deleted, its source exists and is not archived, and its text projection is at its knowledge revision (sealed); `null` otherwise, an inline page included. `body_bytes` is the stored count, `null` when none was recorded (the TS member reads it as 0, as PGLite's `Number(null)` does). PGLite sends this as one `pages JOIN sources` read | `readSegmentedEmbedPage` |
| `brain.stageSegmentChunks(pageId, generation, chunks)` | the chunk indexes, in input order, after the page's highest `chunk_index`. See "Segment chunks" | `stageSegmentChunks` |
| `brain.createSegmentedPageShell(slug, meta, { sourceId })` | `{ id }` of a new page at body generation 0, `body_storage: 'segmented'`, `body_bytes: 0` | `createSegmentedPageShell` |
| `brain.flipBodyGeneration(input)` | `{ retiredChunks, retireDeferred }` | `flipBodyGeneration` |
| `brain.openBodyStaging(input)` | `null`; the staging starts `open` | `openBodyStaging` |
| `brain.setBodyStagingState(id, state, { commitRequestId? }?)` | `null` | `setBodyStagingState` |
| `brain.listChunkedOccurrences(pageId, occurrences, generation)` | the members of `occurrences`, in the caller's order and with repeats, that have a segment chunk row of the page at or below `generation`; an id naming no page answers `[]`. Named and typed by the segmented-write lane (origin/rust-engine/fingerprint-v3, 8d915c28e8) with the same arguments; the store function and its test are copied from it | `listChunkedOccurrences` (`engine-sql/segmented-writes.ts`) |
| `brain.readRetiredChunkVectors(pageId, occurrences)` | the page's visible chunk rows of those occurrences that hold a vector, in chunk index order: text, source, vector, model, recorded input, and the page's contextual retrieval mode, slug, source and corpus generation. The shell refuses a column other than `embedding`. A segment chunk staged with a vector (a vector a replace reuses) is stored with it: dimensions checked against the brain's, a vector with no model refused, embedded now (`chunks::append_segment_chunks`). From the segmented-write lane (0aceee20e0), same arguments | `readRetiredChunkVectors` (`engine-sql/segmented-writes.ts`) |
| `brain.hasStaleSegmentChunks(pageId, generation, live)` | whether the page stores a chunk row generation `generation` (live occurrences `live`) does not hold: a segment chunk of a live occurrence below the newest generation at or below `generation` among that occurrence's chunks, one of any other occurrence at or below `generation`, any inline chunk. Same rule as Postgres's `STALE_CHUNKS_SQL`. From the segmented-write lane (8d915c28e8) | `hasStaleSegmentChunks` (`engine-sql/segmented-writes.ts`) |
| `brain.retireStaleSegmentChunks(pageId, generation, live, maxRows)` | deletes up to `maxRows` of those stale rows (by occurrence, then inline rows) in one store write and returns how many went. From the segmented-write lane (8d915c28e8) | `retireStaleSegmentChunks` (`engine-sql/segmented-writes.ts`) |
| `brain.readSegmentedProjectionPage(sourceId, slug)` | the live segmented page a projection builds: id, body generation and bytes, knowledge and projection revision, title, frontmatter, body flags, timeline lead; `null` for a missing, deleted or inline page. From the segmented-write lane (8d915c28e8) | `readSegmentedProjectionPage` (`engine-sql/segmented-writes.ts`) |
| `brain.listVectorlessChunkIndexes(pageId)` | the chunk indexes of the page's live-body rows (`chunkGenerationFilter`) that hold no vector, in chunk index order; an id that names no page (or is below 1) answers `[]`. The shell refuses a column other than `embedding`. Named and typed by the segment-embed lane (origin/rust-engine/segment-embed) with the same arguments; its store file `page_body/page_spend.rs` also serves that lane's lease and ledger members. The store function is that lane's, unchanged (76c4c4d3be): it reads `segmented_embedding::visible_chunks`, the page's `chunkGenerationFilter` rows in chunk index order | `listVectorlessChunkIndexes` (`engine-sql/page-spend.ts`) |
| `brain.sweepSegments({ sourceId?, pageId?, graceMs?, expireStagings?, now? }?)` | `{ retiredChunksDeleted, manifestRowsDeleted, textsDeleted, stagingsExpired }`; `now` as an ISO string. See "The sweep" | `sweepSegments` |
| `brain.readSegmentDerivations(pageId, { kind?, occurrenceIds? }?)` | derivation rows by kind, then occurrence; `[]` for an empty `occurrenceIds` | `readSegmentDerivations` |
| `brain.upsertSegmentDerivations(rows)` | `null`. A row with the same `(page, kind, occurrence)` is replaced and keeps its `createdAt` | `upsertSegmentDerivations` |
| `brain.retireSegmentDerivations(pageId, liveOccurrenceIds, { kind? }?)` | the number of rows deleted whose occurrence is not live | `retireSegmentDerivations` |
| `brain.lockBodyStagingState(stagingId)` | the staging's state, or `null` when no staging has that id; a value that is not a uuid is refused (`invalid_argument`). The flip of a create checks it (`applySegmentedBody`) | `lockBodyStagingState` |
| `brain.deleteUnstagedSegmentChunks(pageId, generation, keepChunkIndexes)` | `null`. Deletes the page's segment chunks at `generation` whose chunk index is not kept (rows a dead preparation staged), with their postings | `deleteUnstagedSegmentChunks` |
| `brain.deleteRewrittenSegmentDerivations({ pageId, touchedOccurrenceIds, linkReachOccurrenceIds, pipelines, liveOccurrenceIds })` | the number of rows deleted: every row of a touched occurrence, the `links` rows of an occurrence in reach, and the rows of a listed pipeline whose occurrence is not live (`deleteRewrittenDerivations`) | `deleteRewrittenSegmentDerivations` |
| `brain.readSegmentedSealLead(pageId)` | `{ lead, revision, slug, sourceId }`: the page's stored `timeline_lead` (`""` when none), `knowledge_revision` and identity, or `null` for a missing page. Not a member: `sealSegmentedPage` reads it | (`sealSegmentedPage`'s page read) |
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
carries an image vector (`engine_capability_missing`: image vectors are not stored) and takes the
default model label from `opts.embeddingColumn` as PGLite does. A chunk that carries a text vector
(a vector a re-chunk reuses) is stored with it: the store checks its dimensions against the brain's,
labels it with the chunk's model (a vector with no model refuses), and stamps it embedded now with
its recorded input. A chunk without one is pending from the write, with a pending stamp of
now, as Postgres stamps `embedding_pending_since` there. The option is served for the store's one vector
column only, as on `upsertChunks` (embeddings.md, "Chunk writes"). Deleting a page for good
also deletes the chunks family's segment view of the page (`chunks::forget_segment_view`).

## The seal

`sealSegmentedPage(pageId, opts?)` makes a flipped segmented page's chunks and search text visible at
its current revision, as engine-sql/page-body.ts does. The TypeScript member reads the stored lead and
revision (`readSegmentedSealLead`), takes `opts.timelineLead` in place of the lead when given, sanitizes
the chosen lead with `sanitizeRemoteBody`, and calls `seal_segmented_page` with it and the revision. It reads no
page snapshot and overlays no withdrawal or purge rows before sealing (see below). In one store write it:

1. Does nothing for a missing page.
2. Refuses `revision_conflict` when the page's `knowledge_revision` is no longer the one read.
3. Keeps the page's chunker stamp when it is `SAFE_FENCE_CHUNKER_VERSION` (4) or newer but below
   `SEGMENTED_CHUNKER_VERSION` (5) and a segment chunk of an older body generation is still stored;
   otherwise stamps 5. It sets `text_projection_revision` to the page's revision, so `getChunks`
   shows the published segment chunks.
4. Records the text as the page's sealed search timeline (`pages::record_search_timeline`).

PGLite overlays the page's withdrawals and global purges on the stored lead first. Here that overlay is the
identity: the seal reads the stored lead directly and the store keeps no purge markers, so the stored lead is the
lead sealed. `readPageSnapshot` does report the page's withdrawals, for the overlay a reader applies to a
segmented page's lead.

## Segmented write statements

A streamed segmented import (`importStreamedMarkdownFile`), the segmented re-chunk
(`runSegmentedRechunk`) and a fence rewrite (`page-body/segment-rewrite.ts`, with the derivation
delete in `page-body/segment-derive.ts`) make reads and writes around the flip that PGLite and Postgres run from
`src/core/engine-sql/segmented-writes.ts`. The store serves each one from
`rust/crates/gbrain-store/src/page_body/segmented_writes.rs`, through
`src/core/rust-engine/store-members/segmented-writes.ts`. Each write is one store write. The
fence-rewrite members are in `rust/crates/gbrain-store/src/page_body/segment_rewrite.rs`; the
segmented-embed members (`page-body/segmented-embedding.ts`) are in
`rust/crates/gbrain-store/src/page_body/segmented_embedding.rs`.

| Member | Serves |
| --- | --- |
| `lockBodyStagingState(stagingId)` | the staging's state, or `null`. Writes are serialized, so no row lock |
| `deleteUnstagedSegmentChunks(pageId, generation, keepIndexes)` | deletes the page's segment chunks of `generation` whose index is not kept |
| `readSegmentedLivePage(pageId)` | the page a write diffs against, deleted or not: id, generation, storage, title, type, body flags |
| `listChunkedOccurrences(pageId, occurrenceIds, generation)` | the members of `occurrenceIds`, in order, with a chunk row at or below `generation` |
| `readRetiredChunkVectors(pageId, occurrences, column)` | each chunk of those occurrences with a stored vector and recorded input, newest generation first: its text, vector, recorded input and model, so a re-chunk reuses the vector of an unchanged text |
| `hasStaleSegmentChunks(pageId, generation, live)` | whether a chunk row exists that `generation` does not hold |
| `retireStaleSegmentChunks(pageId, generation, live, maxRows)` | deletes up to `maxRows` of those rows and returns the count |
| `readSegmentedProjectionPage(sourceId, slug)` | the live segmented page row a projection builds from |
| `listSegmentedRechunkCandidates(chunkerVersion, scope)` | ids of live, sealed segmented pages below `chunkerVersion`, by source, then slug |
| `readSegmentedRechunkPage(pageId)` | the segmented page row a re-chunk plans and flips from |
| `listOccurrenceChunks(pageId, occurrences)` | the visible chunk rows of those occurrences, by occurrence, then ordinal |
| `readMaterializingRevision()`, `setMaterializingRevision(revision)` | the `gbrain.materializing_revision` setting, kept in the transaction's settings map; `null` and a no-op outside a transaction |
| `restorePageUpdatedAt(pageId, updatedUs)` | sets `updated_at` back (a re-chunk is not an edit); a missing page is a no-op |
| `readSegmentedRewritePage(pageId)` | the page row a live fence rewrite reads, deleted or not, with its tags in byte order (Postgres sorts them `COLLATE "C"`); an inline page reads at generation 0; `null` when missing |
| `restorePageDeletedAt(pageId, deletedAt)` | sets `deleted_at` back after the rewrite's flip; a change gives the page a new knowledge revision and clears its text projection revision, as the pages trigger does. The pages trigger also notes the page for each open derivation purge request of its source; the store keeps those requests (`recordDerivationPurgeRow`, `purge_record.rs`) and its derivation sweep reads them at its own pass (`derivation_sweep.rs`), so the restore writes no per-page note. A missing page is a no-op |
| `lockSegmentedGenerationPage(pageId)` | the page's slug, source, body flags, storage and generation. Writes are serialized, so no row lock |
| `splitManifestGeneration(pageId, generation, stagingId)` | copies the manifest rows that span `generation + 1` into the staging, ends the published rows at `generation`, and deletes the rows that start at it |
| `publishRebuiltGeneration(pageId, generation, stagingId)` | publishes the staging's rows; the rows that start at `generation` end at `generation + 1` |
| `setSegmentedVersionHash(pageId, generation, contentHash, bodyBytes)` | sets the content hash and byte count of the segmented version of `generation` |
| `readSegmentedEmbedPage(ref)` | the segmented page an embed reads, by `{ id }` or `{ sourceId, slug }`: live, sealed and in a live source; `null` otherwise |
| `hasLiveSegmentedPage(sourceId, slug)` | whether that page is segmented, live and in a live source, sealed or not |
| `countSegmentedEmbedRows(pageId, column)` | a sealed page's visible chunk rows and those without a vector |
| `listSegmentedStaleRows(pageId, column, opts)` | a sealed page's visible rows without a vector (any with `includeEmbedded`), newest index first, below `beforeChunkIndex`, in `occurrenceIds`, at most `limit` |
| `readSegmentChunkInputHashes(pageId, chunkIndexes)` | the recorded input of the visible rows at those indexes, sealed or not |
| `installSegmentedVectors(pageId, column, model, vectors)` | stores each vector on the visible row with the same index and text whose recorded input is still `expected`, in one store write; returns the count. The dimensions must be the brain's; the model is `model`, else the brain's |
| `listLiveEmbedSegments(pageId)` | the live manifest rows, highest `seq` first: occurrence, digest and entry state |
| `listSegmentChunkRows(pageId, occurrenceId)` | a sealed page's visible rows of one occurrence in index order, with their recorded inputs |

The embed members serve the column `embedding` only (the store's one vector column); another column
refuses `engine_capability_missing`. The embed lease (`takePageEmbeddingLease`, `renewPageEmbeddingLease`,
`releasePageEmbeddingLease`) and the per-page embedding budget (`reservePageEmbedding`,
`settlePageEmbeddingReservation`, in `page_embedding_budget.rs`) and the vectorless chunk read
(`listVectorlessChunkIndexes`, `page_body/page_spend.rs`) are served by the store, so `embedSegmentedRows`
runs on a Rust brain. The derivation spend ledger (`page_derivation_spend`, `page-spend.ts`) still runs
raw SQL.

A chunk row is stale for generation `g` with live occurrences `live` as in Postgres's
`STALE_CHUNKS_SQL`: a segment chunk of a live occurrence when its generation is below the newest
generation at or below `g` among that occurrence's chunks; a chunk of any other occurrence when its
generation is at or below `g`; an inline chunk always.

`flipBodyGeneration` sends the transaction's materializing revision as `keepRevision`. When it names
the page's revision and the flip leaves the page's source, slug, type, kind, title, frontmatter and
deletion unchanged, the flip keeps the revision and the seal, as Postgres's
`gbrain_advance_page_revision` trigger does. Otherwise the flip gives the page a new revision and
unseals its text projection.

## The sweep

`sweepSegments` is PGLite's garbage collection, step for step, in one store write. Its roots are a
segmented page's live generation, every body generation a version snapshot references, and the rows
of live stagings. A staging is live in a live state (`open`, `sealed`, `prepared`) or while an
outstanding persistence request names it in `intent.body_ref.staging_id`, whatever its state. The
store reads the version generations through `pages::version_generations` and the request-held
stagings through `journal::request_held_staging_ids`, which scans every request, whatever the journal's
outstanding-request counter says, and keeps the staging ids that nonterminal requests name. `now` defaults to the store clock; `graceMs` to
`SEGMENT_TEXT_GC_GRACE_MS` (one hour).

1. With `expireStagings`: a live staging in scope (its page and source) that is past its hard
   deadline, or past its idle deadline (an upload only while `open`), and that no request holds
   becomes `expired`. Then terminal stagings (`committed`, `aborted`, `expired`) in scope that are
   not live and unchanged for `BODY_STAGING_HARD_MS` (one day) are deleted, with their client key and
   recorded texts. Their manifest rows stay for step 4.
2. A page's chunks staged above its body generation go, unless a live staging stages a row of that
   occurrence.
3. Its chunks at or below that generation go when only dead stagings' rows name their occurrence (a
   late batch of a write that lost the flip).
4. Staged manifest rows of dead stagings go.
5. Published rows outside the live generation (all of them on an inline page) go unless a version
   snapshot's generation falls in their `[gen_from, gen_to)`.
6. Segment texts created before `now - graceMs` go when no manifest row of any page names them, no
   live staging of their source was created at or before them, and no live staging recorded them. A
   `pageId` sweep considers only the texts its own deletes in steps 4 and 5 released (none when it
   released none); a `sourceId` sweep, that source's texts; a global one, all.

`retiredChunksDeleted` counts steps 2 and 3, `manifestRowsDeleted` steps 4 and 5.

A version snapshot of a segmented page references the page's live generation instead of copying the
body, as PGLite's `insertSegmentedVersion` does: it records `body_storage: 'segmented'`, the
generation and `body_bytes`, its `compiled_truth` and `timeline` are `null`, and the version JSON
carries those columns and the page's `content_hash` only on such a snapshot.

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
- `upsertSegmentDerivations` raises `derivation_purge_pending` as PGLite does, for the rows a recorded fact purge sweep drops (see
  "The fact purge's derivation sweep record"); the store has no sweep that walks a record and ends it.
- The sweep has no upload parts to delete and no upload byte reservations to release when it expires
  an upload staging: the store keeps neither.
- PGLite's text delete skips a text another writer has locked (`FOR UPDATE SKIP LOCKED`); the store
  serializes writes, so no text is ever skipped for that reason.

## The fact purge's derivation sweep record (`page_body/purge_record.rs`)

`recordDerivationPurgeRow(row)` keeps the record `recordDerivationPurge` (`src/core/page-body/segment-derive.ts`) wrote to
`page_segment_derivation_purges`: the claim forms (`needles`, `patterns`) and the pages the purge rewrote (`page_ids`, in the order
the purge gave them), keyed by the purge request under `b 0x09 <request uuid>`. A second record of the same request keeps nothing
(`ON CONFLICT (request_id) DO NOTHING`); the request id is read as Postgres reads a uuid (upper or lower case, compact, brace-wrapped, a hyphen after any group of four digits) and kept in its canonical hyphenated form, so every spelling is one request; a request id that is not a uuid, a page id outside
`integer` and, for a new record, an unknown source refuse as Postgres does (the source's foreign key). `readDerivationPurgeState(requestId)`
answers `{ state: 'pending', reason: null }` for a record and null for none. A source delete removes the source's records with their
index entries (`ON DELETE CASCADE`), so a deleted source's request answers null. A claim that normalizes to nothing records nothing, in
TypeScript before the call.

While a record is there, `upsertSegmentDerivations` does what the trigger `gbrain_refuse_purging_derivation` does: a row of the record's
source that its sweep would delete (its page one the purge rewrote or a deleted page, or no live manifest row of its page and occurrence
with the row's segment hash backing it) and that holds the claim (the output or receipt holds a claim form as whole words of one string
value or key) is not stored (it is dropped before the CHECK constraints and before the repeated-key check, as the BEFORE trigger drops it ahead of them), the stored row stays, the other rows are stored, and the member raises `derivation_purge_pending` with the
count dropped. The table probe counts the records within their source.

### The sweep (`page_body/derivation_sweep.rs`, `continueDerivationSweep`)

`continueDerivationSweep(sourceId, { first, retry, inline }, limits)` walks the records the way the SQL engines' `runDerivationSweep`
(`src/core/page-body/segment-derive.ts`, whose statements `test/derivation-sweep-sql-pin.test.ts` pins byte for byte) does, batch for
batch, and `continueDerivationPurges` calls it. A call picks the record named `first`, then the source's others oldest first, and walks
one batch of it in one write transaction: the next `batchRows` derivation rows of the source's pages after the record's cursor, in
(page, pipeline, occurrence) order. A row in the sweep's scope (the same test the write guard above applies) that holds the claim (it
passes the words prefilter first) is deleted. A batch that read `batchRows` rows stores the cursor and its deletions in the record
(`phase`, `cursor`, `found`); a shorter one ends the walk. The first walk (`sweep`) is followed by a `verify` walk from the start,
repeated until one deletes nothing, and then the record is deleted (`readDerivationPurgeState` answers null). A call starts batches
until `totalMs` has passed (`inlineMs` for the purge's own call) and always runs one. It returns `{ deleted, work }`: the rows the first
walks deleted, and per page the rows of those walks that were in scope, passed the prefilter and were deleted.

A page can enter a sweep's scope behind the walk without a derivation write: it is soft-deleted (`softDeletePage`, the hidden derived
pages of a purge) or a live published manifest row of it (no close, no staging) is closed (a body flip) or deleted (`sweepSegments`
removing a row no generation or version names, and a page deleted for good). The store notes the page on every record of the source
(`note_scope_entry`; for a manifest row, the source the row names, as the SQL triggers read `OLD.source_id`; the triggers write
`page_segment_derivation_purge_pages`), and the end of a verify
walk takes the notes: it reads the first batch of the noted pages' rows and, when that is not all of them or a row in it holds the claim,
walks only those pages again (`recheck`) before it deletes the record. A record keeps at most 1000 notes; past that its walk goes back to
the start of a full verify walk. A record has a source index (`b 0x0A <source> 0x00 <request id>`), so a walk reads its own source's
records and no other's; a record kept before the index existed gets its entry when the brain is opened writable (`backfill_source_index`: it
runs to completion before the open returns, in write transactions of 256 records that discover and write together, and leaves a marker, so
later opens read that one key; a read-only open does not scan, and a write error other than `read_only_transaction` fails the open)
or when the same request is recorded again. The table probe shows a record's `recheck` as the page ids it holds (`{1,2,3}`, `int[]` text).

The derivation keys are grouped by page, not by source, so a batch visits the physical keys in order and keeps those of the source's
pages; it visits at most `max(8 × batchRows, 512)` keys. A batch the cap stopped before it had `batchRows` rows stores the physical
cursor and the walk goes on (it is not the end of the walk), so a source with few rows beside sources with many costs several short
batches where the SQL engines read one; the work of any one batch, and the time before the call looks at its deadline, are bounded.

What differs from the SQL engines: the store has no statement budget, so no batch times out, none is halved, no row is deleted unread
and no record stalls (`readDerivationPurgeState` never answers `stalled`, and `retry` has nothing to clear); it has one writer and no
scope lock, so no record waits on `scope_lock_busy`. The test seams (`hooks`: after each batch, before an unread delete, and the
work counters) stay in the SQL engines. The store has no source delete, so the foreign key's cascade has nothing to remove.
