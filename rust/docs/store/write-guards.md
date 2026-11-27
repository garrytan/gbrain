# The brain store: page write guards

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page write runs a few reads and writes around the page row: the origin check before it claims a file,
the origin bind after it, the ingest stamp, the import seal, the valid-time body read, the append path's
tail-digest body read and the page write gate's stored tier read. PGLite and Postgres ran them through
`executeRaw` in `src/core/persistence/origin-guard.ts`, `page-prepare.ts`, `valid-time-advisory.ts`,
`src/core/page-state/projections.ts`, `persistence/journal.ts`, `page-body/tail-digest.ts` and
`src/core/trust/page-write.ts`. The SQL now lives in `src/core/engine-sql/write-guards.ts`. The store
answers the same members from its page records (`crates/gbrain-store/src/write_guards.rs`); it adds no
keys.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageOrigin({ sourceId, pageId?, slug? })` | `{ id, slug, source_path, deleted_at }` for the page `pageId` names in the source, else the page `slug` names, live or a tombstone; `null` when there is none or neither is given | `readPageOrigin` |
| `brain.listRevivalPages(slug, sourceId)` | `[{ id, source_id }]`, the soft-deleted pages with `slug` (of `sourceId` only when it is given) that a restore of the slug revives, by source id bytewise | `listRevivalPages` |
| `brain.listOriginClaims(sourceId, spellings, { lockKeys, excludePageId? })` | `[{ slug, source_path }]`, the live pages of the source that record any of `spellings`, other than `excludePageId`, in slug order, once each. `lockKeys` is ignored: the store write is already exclusive | `listOriginClaims` |
| `brain.bindPageOrigin({ sourceId, pageId?, slug?, sourcePath, onlyIfUnset, liveOnly })` | the number of pages changed, 0 or 1. A page that already records `sourcePath` (with `onlyIfUnset`: any origin) or, with `liveOnly`, a tombstone is not changed. A live page may not take an origin another live page of the source records: `origin_claimed` | `bindPageOrigin` |
| `brain.stampPageIngest(slug, { sourceId, sourceKind, ingestedVia, ingestedAt })` | nothing. Sets the page's `source_kind`, `ingested_via` and `ingested_at`, live or a tombstone; a missing page changes nothing. `ingestedAt` that is not an ISO time is `invalid_argument` | `stampPageIngest` |
| `brain.sealImportedPage(slug, { sourceId, revision, timelineText, chunkerVersion })` | `{ id }`, or `null` for a missing page. Sets `chunker_version`; when `revision` equals the page's `knowledge_revision`, also sets `text_projection_revision` and records `timelineText` as the timeline the keyword index reads | `sealImportedPage` |
| `brain.readLivePageBody(slug, sourceId)` | `{ frontmatter, compiled_truth, timeline, body_storage, content_hash }` of the live page, or `null` for a missing page or a tombstone. A page with no inline body (a segmented shell) reads `body_storage: "segmented"` | `readLivePageBody` |
| `brain.readPageIndexingState(pageId)` | `{ chunker_version, corpus_generation, page_kind }` of the page, live or a tombstone, or `null` when no page has the id. `corpus_generation` is the page's contextual-retrieval generation, `null` when it has none | `readPageIndexingState` |
| `brain.readInlinePageRegions(pageId)` | `{ compiled_truth, timeline }` of the page with id `pageId`, live or a tombstone, or `null` when no page has the id. A column the page does not store inline reads `null` | `readInlinePageRegions` |
| `brain.readStoredPageTier(sourceId, slug)` | the page's stored `trust_tier` as text, live or a tombstone, or `null` when the source has no such page. A record that stores no tier reads `unknown`, the column default | `readStoredPageTier` |
| `brain.readLivePageBody(slug, sourceId)` (as `readLiveStoredBody`) | `{ compiled_truth, timeline }` of the live page, or `null`. The TypeScript member takes no row lock: the store runs one write transaction at a time | `readLiveStoredBody` |

| `brain.hasSegmentStorage()` | `true` when any segment text or body staging record exists | `hasSegmentStorage` |
| `brain.detachPageOrigin(pageId, reason)` | nothing. The page, live or a tombstone, forgets `source_path` and `source_uri` and records `reason` as its `database_only_reason`; its `knowledge_revision` stays | `detachPageOrigin` |
| `brain.readPageDatabaseOnlyReason(sourceId, slug)` | the page's `database_only_reason`, live or a tombstone, or `null` without one or without a page | `readPageDatabaseOnlyReason` |
| `brain.listUnboundSourcePages()` | `[{ source_id, pages, bound, local_path }]`: per source with live pages marked `unbound_source` and no file path or uri once edge whitespace is trimmed, how many, whether the source holds a worktree binding at its incarnation, and its local path (for `default` with none, `sync.repo_path`), by source id in byte order | `listUnboundSourcePages` (doctor `unbound_source`) |
| `brain.bumpPageKnowledgeRevision(pageId)` | nothing. The page, live or a tombstone, takes a new `knowledge_revision`, and its `text_projection_revision` is cleared | `bumpPageKnowledgeRevision` |
| `brain.removePageFrontmatterKeys(sourceId, pageId, keys)` | nothing. Removes `keys` from the frontmatter of the live page of the source; only a page that held one changes, and it takes a new revision | `removePageFrontmatterKeys` |
| `brain.setPageType(sourceId, slug, type)` | nothing. Sets the page's `type`, live or a tombstone; a changed type takes a new revision | `setPageType` |

## Differences from PGLite

- **Locks.** PGLite takes one advisory lock per origin spelling before it lists the claims, so two writers
  serialize. The store runs one write at a time, so `listOriginClaims` takes none.
- **The origin unique index.** Postgres refuses a second live page of an origin with the unique index
  `pages_live_origin_key` (SQLSTATE 23505), and `origin-guard.ts` maps that to `origin_already_claimed`.
  The store has no such index: `bindPageOrigin` runs the origin check of `putPage` (`assert_origin_unclaimed`
  in `pages.rs`) and returns `origin_claimed`, which `store-errors.ts` maps to the same error.
- **`database_only_reason`.** The page record keeps the marker (`PageRecord.database_only_reason`). A
  `putPage` that names a file drops `detached`, `origin_twin` and `mirror_read_only`, and `bindPageOrigin`
  drops `origin_twin` once the page records `sourcePath`, as PGLite's statements do. A record written before
  the field existed reads `null`.
- **Revisions.** PGLite's revision trigger gives a page a new `knowledge_revision` when its type or
  frontmatter changes and clears the text projection seal when the revision moves. The store sets both in
  the member that changes the page.
- **Times.** The store keeps microseconds. The TypeScript member sends `ingestedAt` as a millisecond ISO time,
  as PGLite's `timestamptz` parameter receives a `Date`, and returns `deleted_at` as a `Date`.
- **A day text has no session zone.** Forget's file-mirror stamp calls `expireFactAtDate(id, 'YYYY-MM-DD')`
  (`src/core/facts/forget.ts`), which binds that text as master did. PGLite casts it with `::timestamptz` to midnight in the session TimeZone.
  Postgres stores UTC midnight: postgres.js turns the text into a `Date` (`new Date(text)`) before it binds the
  `timestamptz` parameter. The store has no session zone: `expireFactAtDate` and `expireFactSuperseded` both call
  `brain.expireFactUntil({ id, until })`, which reads a day text as midnight UTC (`day_or_time` in
  `crates/gbrain-store/src/facts.rs`), PGLite's default zone. An ISO time, as the supersession passes, is the same
  instant on every engine.

## TypeScript members

`src/core/rust-engine/store-members/write-guards.ts` answers the fifteen BrainEngine members above on a Rust
brain. Each calls the binding method of the same name through `storeCall`, so a store error reaches the
caller as the typed error PGLite raises. The capability is `pages` for each of them except `hasSegmentStorage`, which is `page_body`.
