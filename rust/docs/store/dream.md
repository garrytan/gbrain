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
breaker and the write deferral, so 37 sites make 34 members). The Rust engine refuses each member listed below
by name through `src/core/rust-engine/members.ts`; the capability it names is the data the store would
need before it can answer.

| Members | Needs from the store |
| --- | --- |
| `listDreamQueueCandidates`, `listLiveDreamCycleLocks`, `readDreamJobStatus`, `listDreamJobCreatedAt`, `listCompletedSynthJobs`, `countCoalescibleSynthJobs`, `listWaitingChildJobIds`, `listDreamChildJobTimings`, `countRecentDreamSynthSubmissions` | the minion job queue and the cycle lock table (`minion_jobs`, `gbrain_cycle_locks`), including the database clock and the jsonb `data` of a job |
| `stampDreamPageProvenance`, `listDreamPageIds`, `countDreamProvenancePages`, `listRetainedDreamOutputSources`, `listDreamAtomPages`, `listSynthesisPageBodies`, `readDreamVerifyEpoch` | pages: frontmatter merge that keeps the first cycle date, live page ids, counts by cycle date, atom and synthesis page reads (segmented pages are excluded in SQL), and the database clock |
| `listConsolidationClaimValues`, `setConsolidatedFactValidUntil`, `listReadersSourcedFactIds`, `listConsolidationClaimShapes` | facts: typed claim columns, `valid_until` writes and the readers-sourced predicate |
| `findConsolidationPageIds`, `readConsolidationTakesMaxRowNum`, `findConsolidatedTakes`, `refreshConsolidatedTakeSource`, `findConsolidatedTakeIds` | takes: row numbers, the earliest take of a claim and the source-aggregation write |
| `readDreamPreRunRevision` | the first page version snapshot at or after a time |

Served by the Rust engine: `ensureDreamMapConfigRow`, `lockDreamMapConfigRow`, `writeDreamMapConfigRow` and `recordDreamBreakerReset`
(`gbrain-store` `dream_config`, see [config.md](config.md)) and `readDreamSourceIncarnation` (the source record's
incarnation).

The three journal reads are served from the request records (`gbrain-store` `persistence/dream_reads.rs`, TypeScript
members in `src/core/rust-engine/store-members/dream-journal.ts`):

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readWriteRequestById(id)` | the stored request; the member keeps `{ state, error_code, error_message }`, or null. An id that is not a UUID is `invalid_argument`, as the `::uuid` cast refuses it | `readDreamDeferralReceipt` |
| `brain.listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)` | the requests of the source, incarnation and slug with `sequence` greater than the given bigint (text) and state queued, running, recovering or committed, by sequence. A sequence that is not an integer is `invalid_argument` | `listLaterPersistenceRequests` |
| `brain.listCommittedOutputRequests(requestIds, sourceId, incarnation)` | `[{ request }]`: the committed `put_page` requests of the source and incarnation whose request id is one of `requestIds`, newest sequence first; times as text, as `row_to_json` gives them. A request id that is not a UUID is `invalid_argument` | `listCommittedOutputRequests` | The lock takes no row lock: the store admits one write transaction at a time.
incarnation). The lock takes no row lock: the store admits one write transaction at a time.
`readDreamDeferralReceipt`, `listLaterPersistenceRequests` and `listCommittedOutputRequests` read the persistence
journal (`gbrain-store` `persistence::dream_reads`, see [persistence.md](persistence.md)).

Return shapes are the raw row shapes the callers read; timestamps come back as the driver returns them
(a `Date` or text), and the callers normalise them. The SQL text and bound parameters are byte-identical to
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
