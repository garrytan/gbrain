# The brain store: page write guards

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page write runs a few reads and writes around the page row: the origin check before it claims a file,
the origin bind after it, the ingest stamp, the import seal and the valid-time body read. PGLite and
Postgres ran them through `executeRaw` in `src/core/persistence/origin-guard.ts`, `page-prepare.ts`,
`valid-time-advisory.ts`, `src/core/page-state/projections.ts` and `persistence/journal.ts`. The SQL now
lives in `src/core/engine-sql/write-guards.ts`. The store answers the same members from its page records
(`crates/gbrain-store/src/write_guards.rs`); it adds no keys.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageOrigin({ sourceId, pageId?, slug? })` | `{ id, slug, source_path, deleted_at }` for the page `pageId` names in the source, else the page `slug` names, live or a tombstone; `null` when there is none or neither is given | `readPageOrigin` |
| `brain.listOriginClaims(sourceId, spellings, { lockKeys, excludePageId? })` | `[{ slug, source_path }]`, the live pages of the source that record any of `spellings`, other than `excludePageId`, in slug order, once each. `lockKeys` is ignored: the store write is already exclusive | `listOriginClaims` |
| `brain.bindPageOrigin({ sourceId, pageId?, slug?, sourcePath, onlyIfUnset, liveOnly })` | the number of pages changed, 0 or 1. A page that already records `sourcePath` (with `onlyIfUnset`: any origin) or, with `liveOnly`, a tombstone is not changed. A live page may not take an origin another live page of the source records: `origin_claimed` | `bindPageOrigin` |
| `brain.stampPageIngest(slug, { sourceId, sourceKind, ingestedVia, ingestedAt })` | nothing. Sets the page's `source_kind`, `ingested_via` and `ingested_at`, live or a tombstone; a missing page changes nothing. `ingestedAt` that is not an ISO time is `invalid_argument` | `stampPageIngest` |
| `brain.sealImportedPage(slug, { sourceId, revision, timelineText, chunkerVersion })` | `{ id }`, or `null` for a missing page. Sets `chunker_version`; when `revision` equals the page's `knowledge_revision`, also sets `text_projection_revision` and records `timelineText` as the timeline the keyword index reads | `sealImportedPage` |
| `brain.readLivePageBody(slug, sourceId)` | `{ frontmatter, compiled_truth, timeline, body_storage, content_hash }` of the live page, or `null` for a missing page or a tombstone. A page with no inline body (a segmented shell) reads `body_storage: "segmented"` | `readLivePageBody` |
| `brain.hasSegmentStorage()` | `true` when any segment text or body staging record exists | `hasSegmentStorage` |

## Differences from PGLite

- **Locks.** PGLite takes one advisory lock per origin spelling before it lists the claims, so two writers
  serialize. The store runs one write at a time, so `listOriginClaims` takes none.
- **The origin unique index.** Postgres refuses a second live page of an origin with the unique index
  `pages_live_origin_key` (SQLSTATE 23505), and `origin-guard.ts` maps that to `origin_already_claimed`.
  The store has no such index: `bindPageOrigin` runs the origin check of `putPage` (`assert_origin_unclaimed`
  in `pages.rs`) and returns `origin_claimed`, which `store-errors.ts` maps to the same error.
- **`database_only_reason`.** PGLite's bind also clears `database_only_reason = 'origin_twin'`. The store
  keeps no such field, so there is nothing to clear.
- **Times.** The store keeps microseconds. The TypeScript member sends `ingestedAt` as a millisecond ISO time,
  as PGLite's `timestamptz` parameter receives a `Date`, and returns `deleted_at` as a `Date`.

## TypeScript members

`src/core/rust-engine/store-members/write-guards.ts` answers the seven BrainEngine members above on a Rust
brain. Each calls the binding method of the same name through `storeCall`, so a store error reaches the
caller as the typed error PGLite raises. The capability is `pages` for the first six and `page_body` for
`hasSegmentStorage`.
