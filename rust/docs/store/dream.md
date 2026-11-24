# The brain store: Dream verdicts

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A dream verdict caches the triage judgment for one file version, keyed by `(file_path, content_hash)`
under key tag `Y`. A verdict lives 30 days from the write that stored it (`DREAM_VERDICT_TTL_SECONDS`).
It ports `src/core/engine-sql/dream.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getDreamVerdict(filePath, contentHash)` | `{ worth_processing, reasons, judged_at, score, content_type, segments, entities, model, triage_version }` or `null`. `null` also when the verdict expired (`expires_at <= now`). Missing lists read back as `[]`; `judged_at` is microsecond ISO text | `getDreamVerdict` |
| `brain.putDreamVerdict(filePath, contentHash, verdict)` | `null`; an upsert that replaces every field and sets `judged_at = now`, `expires_at = now + 30 days`. A missing `worth_processing` is `constraint_violation`; a non-integral or out-of-int4 `triage_version` and U+0000 in any text or JSON value are `invalid_argument`, and nothing is written | `putDreamVerdict` |
| `brain.sweepDreamVerdicts()` | the number of rows deleted, those with `expires_at <= now` | `sweepDreamVerdicts` |

JSON values (`reasons`, `segments`, `entities`) read back in jsonb key order: object keys sort by byte
length, then by bytes, at every depth. The TypeScript member applies `wellFormedJson` before the call,
so a lone surrogate becomes U+FFFD as it does on Postgres.

## Dream cycle statements (`src/core/engine-sql/dream-cycle.ts`)

The dream cycle, the retriage command and the consolidate phase used to send 37 raw statements through
`executeRaw`. They are now 34 typed `BrainEngine` members (three config-map statements were shared by the
breaker and the write deferral, so 37 sites make 34 members). The Rust engine serves all 34. The TypeScript
members are in `src/core/rust-engine/store-members/dream-config.ts`, `dream-cycle.ts` and `dream-journal.ts`.

| Members | Store code and rules |
| --- | --- |
| `listDreamQueueCandidates`, `listLiveDreamCycleLocks`, `readDreamJobStatus`, `listDreamJobCreatedAt`, `listCompletedSynthJobs`, `countCoalescibleSynthJobs`, `listWaitingChildJobIds`, `listDreamChildJobTimings`, `countRecentDreamSynthSubmissions` | `gbrain-store` `jobs/dream_reads.rs`, over the job records and the cycle locks. A job's source is `data.source_id`, `default` when it is missing or empty. `listDreamJobCreatedAt` refuses an id outside int4, as the `int[]` cast does. A non-finite steal grace refuses |
| `stampDreamPageProvenance`, `listDreamPageIds`, `findConsolidationPageIds`, `countDreamProvenancePages`, `listRetainedDreamOutputSources`, `listDreamAtomPages`, `listSynthesisPageBodies`, `readDreamVerifyEpoch` | `gbrain-store` `dream_reads.rs`, over the page records. The stamp merges the frontmatter, keeps the first cycle date in both date keys, and gives the page a new knowledge revision only when the frontmatter changed. `listDreamPageIds` and `findConsolidationPageIds` are one store call. An atom page's `private` is the no-caller page policy. Slugs and raw sources sort in byte order. A segmented page (a NULL body) is not a synthesis body |
| `listConsolidationClaimValues`, `setConsolidatedFactValidUntil`, `listReadersSourcedFactIds`, `listConsolidationClaimShapes` | `dream_reads.rs`, over the fact records. The `valid_until` write is a no-op when the fact already holds the value. A readers-sourced fact is one whose source page (live or deleted, same source) names readers |
| `readConsolidationTakesMaxRowNum`, `findConsolidatedTakes`, `refreshConsolidatedTakeSource`, `findConsolidatedTakeIds` | `dream_reads.rs`, over the take records. A row number outside int4 refuses |
| `readDreamPreRunRevision` | `dream_reads.rs`: the first version snapshot at or after the time, by snapshot time then id, of the page live or deleted |
| `ensureDreamMapConfigRow`, `lockDreamMapConfigRow`, `writeDreamMapConfigRow`, `recordDreamBreakerReset`, `readDreamSourceIncarnation` | `gbrain-store` `dream_config` (see [config.md](config.md)) and the source record's incarnation. The lock takes no row lock: the store admits one write transaction at a time |

The three journal reads are served from the request records (`gbrain-store` `persistence/dream_reads.rs`, TypeScript
members in `src/core/rust-engine/store-members/dream-journal.ts`):

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readWriteRequestById(id)` | the stored request; the member keeps `{ state, error_code, error_message }`, or null. An id that is not a UUID is `invalid_argument`, as the `::uuid` cast refuses it | `readDreamDeferralReceipt` |
| `brain.listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)` | the requests of the source, incarnation and slug with `sequence` greater than the given bigint (text) and state queued, running, recovering or committed, by sequence. A sequence that is not an integer is `invalid_argument` | `listLaterPersistenceRequests` |
| `brain.listCommittedOutputRequests(requestIds, sourceId, incarnation)` | `[{ request }]`: the committed `put_page` requests of the source and incarnation whose request id is one of `requestIds`, newest sequence first; times as text, as `row_to_json` gives them. A request id that is not a UUID is `invalid_argument` | `listCommittedOutputRequests` | The lock takes no row lock: the store admits one write transaction at a time.

`readDreamDeferralReceipt` reads the persistence journal too (`gbrain-store` `persistence::dream_reads`, see
[persistence.md](persistence.md)).

Return shapes are the raw row shapes the callers read. On the Rust engine the TypeScript members give
timestamps back as Dates, as PGLite does; the `request` of `listCommittedOutputRequests` keeps them as text,
as `row_to_json` does. The SQL text and bound parameters are byte-identical to
the statements they replaced (`test/dream-cycle-sites-sql-pin.test.ts`); behaviour on PGLite and Postgres is
pinned by `test/engine-parity/dream-cycle-sites.test.ts`.

## Projection drain reads and the queue insert

The projection drain's own statements (src/core/page-state/projections.ts, SQL in
`src/core/engine-sql/projection-rebuild.ts`), served from `persistence/projection_queue.rs` and
`persistence/projection_rebuild.rs`. The rest of the projection queue is in [persistence.md](persistence.md).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.queuePageProjectionJob(sourceId, slug, reason)` | `null`; queues the live page at its knowledge revision with `reason` at now, or moves its queued job there. A missing or deleted page queues nothing | `queuePageProjectionJob` |
| `brain.readDrainRunStart()` | the store clock as `now()::text` (`2026-11-18 02:37:05.215+00`); in a transaction, its start | `readDrainRunStart` |
| `brain.isDrainClockPast(runStart)` | whether the store clock is past `runStart` (`now()::text` or ISO); other text is `invalid_argument` | `isDrainClockPast` |
| `brain.hasQueuedProjectionWork(media)` | whether any job, whatever its reason, names a live Markdown or code page (with `media`, or a sealable image page) or a live segmented page of an active source | `hasQueuedProjectionWork` |
| `brain.readProjectionBacklog({ sourceId?, sourceIds? })` | the class counts of the jobs of live pages in scope (`pending`, `failed`, `sealable`, `sealable_with_visual`, `reimport`, `ocr_required`, `protected`, `archived`), `oldest` (seconds since the oldest job that needs work, or null) and `as_of` (`now()::text`) | `readProjectionBacklog` |
| `brain.listProjectionDrainPreview(limit)` | the jobs of live Markdown and code pages and sealable image pages of active sources, image pages next, pages answered from their pre-upgrade index last, then by time, incarnation and slug (byte order), at most `limit` | `listProjectionDrainPreview` |

- The store classes an image page as `projectionClassSql` does (`persistence/projection_rebuild.rs` `page_class`): a
  live inline image page is `protected` when either body column holds a protected marker; else `sealable` when its
  chunker version is at least 4 (the safe fence) and its live chunks are exactly one `image_asset` chunk of modality
  `image` at index 0, shorter than 65,536 characters and equal to the first 65,536 characters of its body (its title
  when the body is empty); else `reimport` (`ocr_required` when its chunker version is below 0). `sealable_with_visual`
  is 0: the store keeps no image vector.
- `hasDrainableProjectionJob({ media })`, `hasQueuedProjectionWork({ media })` and the preview admit a sealable image
  page as `projectionJobProbes({ media: true })` does.
- `readPagesRowEstimate` answers the live page count (`countBrainLivePages`): the store keeps no planner statistics.
- The backlog's scope is `pageReadFilter`'s source clause; a privacy, trust or flag filter refuses in TypeScript.

## The image seal (`persistence/image_seal.rs`)

`gbrain projections drain --images` (page-state/image-seal.ts `sealImageProjections`) restores the importer's own
seal on sealable image pages.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listImageSealWindow(afterIncarnation, afterSlug, limit, notAfter)` | the queue jobs after the key (incarnation, then slug in byte order), last queued at or before `notAfter` when given, at most `limit`: `{ source_id (null for an archived or missing source), source_incarnation, slug, revision, sealable }` | `listImageSealWindow` |
| `brain.readImageSealPages(rows)` | the pages of `{ source_id, slug, revision }` rows still live at that revision and still sealable images of an active source: `{ id, revision, title, mode, corpus_generation }` | `readImageSealPages` |
| `brain.listImageSealChunks(pageIds, provenanceModel)` | the live chunks of the pages that hold a vector: `{ id, page_id, chunk_text, chunk_source, embedding_input_hash, current }`, `current` when the vector is its text's and its model label is `provenanceModel` | `listImageSealChunks` |
| `brain.clearImageSealVectors(chunks)` | `null`; clears the vector of each `{ id, page_id }` chunk and marks it pending | `clearImageSealVectors` |
| `brain.sealImagePages(pages)` | one `{ has_visual: false }` per `{ id, revision }` page still at that revision, which is sealed; the queue hook drops its job | `sealImagePages` |

The TypeScript members refuse a write column other than `embedding`.
