# The brain store: Pages

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Pages are keyed `(source_id, slug)`; `sourceId` defaults to `default`, and a source that does not
exist rejects `source_not_found`. Slugs go through PGLite's `validateSlug` (`invalid_slug`) and are
stored in its one normal form (`normalizeSlug`): lower-cased, then composed to Unicode NFC, so a decomposed
`zoe\u0308` is stored as `zo\u00eb`. The store keeps no other spelling: it cannot hold a page under a capitalised
or decomposed slug that PGLite or Postgres still store from before slugs were normalized, so a write addressed to
such an exact stored spelling (`withStoredSlug`, master #9944) finds no page here. That is a named typed stop
(the parity case "every write by the exact spelling of a capital-stored page ..." refuses with capability `pages`),
listed as row 50 of docs/designs/RUST_ENGINE.md. A `Page` is PGLite's `Page` plus `page_kind`; every date (`created_at`, `updated_at`,
`updated_at_iso`, `deleted_at`, `effective_date`, `ingested_at`) is an ISO string with microseconds
(`2026-08-10T12:00:00.000123Z`) or `null`, and the TypeScript wrapper turns them into `Date`.
A page's `knowledge_revision` is a UUID that changes when its type, kind, title, body, timeline,
frontmatter, deletion or tags change. `text_projection_revision` is `null` until chunks are
installed for that revision. `listPages` and `resolveSlugs` scan every page; there are no
secondary indexes yet.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageSnapshot(slug, { sourceId?, sourceIds?, includeDeleted?, resolveAlias? }?)` | `{ page, tags, revision, sourceIncarnation, withdrawals }` or `null`. `sourceIds` wins over `sourceId`; with neither, the first match, `default` first. With `resolveAlias`, an exact-slug miss reads the page a slug alias names, in the first source in scope whose source is live (any source with `includeDeleted`) and whose named page passes the soft-delete rule. `requireUnambiguous` rejects `page_ambiguous` when more than one readable page (exact or alias) matches, `requireLiveSource` requires the page's source to exist and not be archived, and `preserveExactIdentity` leaves an alias unfollowed when its source holds a page at the slug itself in any deletion state; the native binding accepts all three. `withdrawals` lists the source's withdrawals under subject `*` or the slug, then the slug's purge tombstones (`purged: true`), each earliest per `(visibility, fact_hash)` and `world` only under `excludePrivate`; a source with a subject-`*` tombstone adds `globalPurges` (`{ count, latest, world_only }`) and every such tombstone in `globalPurgeRows` (`page_withdrawals.rs`). The current TypeScript member (`src/core/rust-engine/store-members/pages.ts`) accepts only `sourceId`, `sourceIds` and `includeDeleted` (it refuses the other options, `resolveAlias` among them) and only decodes `snapshot.page` with `toGetPage`: it neither filters or drops `globalPurgeRows` nor overlays withdrawals or purges on the text, and `src/core/rust-engine/snapshot-overlay.ts` does not exist in this checkout; `readPageSnapshotsBatch` answers the same fields | `readPageSnapshot` |
| `brain.putPage(slug, page, { sourceId?, allowEmptyOverwrite?, expectedRevision?, force?, chunks?, index? }?)` | the stored `Page`. By default the store also installs chunks and seals the page (see "Chunks and keyword search"); `index: false` writes the page alone, which is what the TypeScript engine always passes, as PGLite's `putPage` writes no chunks | `putPage` |
| `brain.listPages(filters?)` | `Page[]` (default `limit` 100). Filters: `type`, `tag`, `updated_after`, `updatedAfterKeyset { updatedAt, slug }`, `slugPrefix` (literal), `excludeSlugPrefixes`, `slugAfter`, `sourceId`, `sourceIds`, `includeDeleted`, `sort` (`updated_desc` default, `updated_asc`, `created_desc`, `slug`) | `listPages` |
| `brain.countPages({ sourceId? }?)` | number of live pages | `countPages` |
| `brain.lockPageKeys([{ sourceId, slug }])` | `null`. One process owns the brain and one write runs at a time, so keys are already held; it checks the keys are well formed | `lockPageKeys` |
| `brain.resolveSlugs(partial, { sourceId?, sourceIds?, excludePrivate? }?)` | `[slug]` for the exact live slug. Otherwise up to five slugs of live pages whose title passes pg_trgm `title % partial` (similarity 0.3 or more) or whose slug matches `ILIKE '%partial%'`, best similarity first, then slug and source id in byte order, as the SQL engines order them. Scores come from the store's pg_trgm port (`keyword/trgm.rs`) | `resolveSlugs` |
| `brain.softDeletePage(slug, { sourceId? }?)` | `{ slug }` or `null` | `softDeletePage` |
| `brain.restorePage(slug, { sourceId? }?)` | `boolean` | `restorePage` |
| `brain.deletePage(slug, { sourceId? }?)` | `null`; removes the page and its versions | `deletePage` |
| `brain.getTags(slug, { sourceId?, sourceIds? }?)` | sorted `string[]` | `getTags` |
| `brain.addTag(slug, tag, { sourceId? }?)` | `null`; `page_not_found` for a missing page | `addTag` |
| `brain.removeTag(slug, tag, { sourceId? }?)` | `null`; no error when the page or tag is absent | `removeTag` |
| `brain.createVersion(slug, { sourceId?, reason?, reasonSource?, historyGap? }?)` | the version row, with `reason` as its `change_reason` when given (and only if the prune kept the new version; a non-empty `reason` whose `reasonSource` `{ commit, path }` a purge tombstoned for the source is dropped, as `stampableReason` does), `historyGap` recording the page's `version_history_gap_at` before the snapshot, with the page's stamped `trust_tier` and `write_origin` copied into the snapshot (`snapshot_version_trust`; never the snapshot writer's own); `page_not_found` for a missing page. A segmented page's snapshot references its body generation (page_body.md, "The sweep"). The native `createVersion` also accepts `preimage`: when given, its revision, title, type, frontmatter, tags, source path and deletion state are versioned, with its body for an inline page (a segmented page keeps the stored body reference); without it the stored page is snapshotted. The current TypeScript member (`store-members/versions.ts`) accepts only `sourceId` and does not expose `preimage` | `createVersion` |
| `brain.getVersions(slug, { sourceId?, sourceIds?, limit?, includeBody?, excludePrivate? }?)` | version rows, newest first, each with its change reason as `replaced_because`; `includeBody: false` leaves out `compiled_truth` and `timeline`; `excludePrivate` (the caller's page policy) drops a hidden page's versions and each version whose own readers or fields the caller may not read, before `limit`; under `excludePrivate` a version's `replaced_because` is null when the next version is one the caller may not read, or was pruned (`replacedBecauseSql`) | `getVersions` |
| `brain.createVersion(slug, { sourceId?, reason?, historyGap? }?)` | the version row, with `reason` as its `change_reason` when given (and only if the prune kept the new version), `historyGap` recording the page's `version_history_gap_at` before the snapshot, with the page's stamped `trust_tier` and `write_origin` copied into the snapshot (`snapshot_version_trust`; never the snapshot writer's own); `page_not_found` for a missing page. A segmented page's snapshot references its body generation (page_body.md, "The sweep") | `createVersion` |
| `brain.readLatestVersionId(pageId)` | the page's newest version id, or `null` when it has none or the id is not a page's | `readLatestVersionId` |
| `brain.readLatestVersionIdAtTier(pageId, tier)` | the page's newest version id whose snapshot `trust_tier` is `tier` (a version with no stored tier reads as `unknown`), or `null`; `invalid_argument` for a NUL byte | `readLatestVersionIdAtTier` |
| `brain.stampVersionChangeReason({ pageId, afterVersionId, reason })` | how many versions took the reason: it sets `change_reason` on each of the page's versions with an id over `afterVersionId`, in one write; `invalid_argument` for a NUL byte | `stampVersionChangeReason` |

### Version prune

`version_prune.rs` runs PGLite's prune (`src/core/page-state/versions.ts`) in the same write as every snapshot
(`createVersion`, a journal page write, `updateSlug`):

- A large inline page (body plus timeline over `PAGE_INLINE_MAX_BYTES`, 1 MiB) keeps its newest five large inline
  versions (`LARGE_PAGE_VERSIONS_KEPT`); a version with no body is never counted.
- A segmented page keeps at most `versions.segmented_max_per_page` versions (default 50) and drops a version once the
  closed manifest rows it pins, counted once per occurrence and generation, pass the larger of
  `versions.segmented_max_pinned_bytes` (default 64 MiB) and the page's body bytes. A malformed config value reads as
  the default. After a prune it sweeps the page's segments (`page_body.md`, "The sweep").
- Each prune marks `successor_pruned` on the newest kept version before each pruned one and sets the page's
  `version_history_gap_at`. That page write leaves the knowledge revision as it was, so nothing is queued.
- `createVersion(slug, { preimage })` versions the caller's page read instead of the stored page, as
  `createPageVersion(..., preimage)` does: the read revision, title, type, frontmatter, tags, source path and deletion,
  and on an inline page the read body. A segmented page keeps the stored body reference (live generation, bytes and
  hash): a fact purge versions the page after its generation flip. The preimage's tags keep the order given (a page
  read sorts them), and its revision is stored lower-case. The writer and request of the stored revision are copied
  only when the preimage is that revision, matched case-insensitively; a stale preimage keeps them empty.
- `pruneHoldingPageVersions(pageId)` is the holding-page cap a fence fact append runs after its snapshot: it keeps the
  page's newest `LARGE_PAGE_VERSIONS_KEPT` versions that are not segmented, deletes at most 100 of the older ones,
  oldest first, marks the history as every prune does and answers how many it deleted (0 for an unknown page).
- `restorePageTrust({ pageId, trustTier, writeOrigin })` sets back the tier and origin a fence append's page write
  restamped (`src/core/trust/fence-append.ts`). It goes through the same trust stamp as the PGLite `UPDATE`: a lower
  always lands, and a raise lands only under a promotion that covers it, else the stored tier stays. `writeOrigin` is
  JSON text or null; a tier that is not a trust tier is refused.



`putPage` follows PGLite:

- `content_hash` is the caller's, else SHA-256 of the canonical `{ title, type, compiled_truth,
  timeline, frontmatter, tags }` envelope. Two sample pages hash the same as the TypeScript
  `contentHash`; parity for every JSON number and string is not proven, so a caller that needs it
  passes `content_hash`.
- An update clears `deleted_at`, sets `updated_at` and keeps `effective_date`,
  `effective_date_source`, `import_filename`, `source_path`, `source_kind`, `source_uri`,
  `ingested_via` and `ingested_at` when the new write leaves them out.
- A blank `compiled_truth` over a page that has content rejects `empty_overwrite` unless
  `allowEmptyOverwrite`.
- `expectedRevision` is `undefined` (no check), `null` (the page must not exist) or a UUID. A
  mismatch rejects `revision_conflict`; `force: false` with no `expectedRevision` over an existing
  page rejects `revision_required`. `force: true` skips the check and cannot be combined with
  `expectedRevision`. The check sees soft-deleted pages.
- Tags are not part of `putPage`; `addTag` and `removeTag` change them, as in PGLite.
- `chunker_version` follows PGLite's `bodyWriteChunkVersion`. A new page stores `LEAST(chunker_version ?? 0, 3)`
  (3 is one below the safe fence version 4) and refuses what the smallint cast refuses. An update with the same
  `compiled_truth` and `timeline` keeps the stored value. A changed body is -1 when the stored value is negative or
  the old or new body holds a facts or takes fence marker, else `LEAST(stored, 3)`, so old chunks are never certified.
  A seal (`sealChunks`, and the store's own indexing) writes 4.

## Nullable page fields

PGLite lets four `pages` columns hold NULL, and the page record holds NULL in the same four (`PageText` and
`PageRecord` in `crates/gbrain-store/src/pages.rs` carry the same contract as doc comments):

| Field | NULL means | Written as NULL by |
| --- | --- | --- |
| `compiled_truth`, `timeline` | a segmented shell page: its body lives in segment texts. PGLite's `pages_body_storage_chk` makes both NULL exactly when `body_storage = 'segmented'`; an inline page holds a string (`''` when empty) | the page_body family (`createSegmentedPageShell`, a generation flip); never `putPage` |
| `content_hash` | a shell page whose body is not published yet, as `createSegmentedPageShell` leaves it | the page_body family; `putPage` always sets a hash |
| `chunker_version` | a record written before the store recorded one; the seal state reads it as 0 | nothing new: `putPage` and a seal always set it (see `putPage` above); not part of the page JSON (PGLite's `rowToPage` leaves it out) |

- The page JSON (`getPage`, `readPageSnapshot`, `listPages`) and version rows send each NULL as `null`. The
  TypeScript codec turns a `null` body into PGLite's segmented page: `compiled_truth` and `timeline` read as `''`
  behind getters that throw `page_body_segmented`. `content_hash` stays `null`.
- Inside the store, a NULL body reads as `''` through `&str`, so inline readers (`auto_chunks`, sizes, text
  matching) see an empty body. Use `is_null` or `as_deref` where NULL and `''` differ; equality never treats them as
  the same, so a writer that moves a page between segmented and inline sees a change.
- A blank `putPage` over a live shell rejects `empty_overwrite` (`(segmented)` in the message) unless
  `allowEmptyOverwrite`, as PGLite does.
- Any other `putPage` over a shell, live or soft-deleted, rejects `constraint_violation` with PGLite's CHECK message
  (`new row for relation "pages" violates check constraint "pages_body_storage_chk"`) and stores nothing. PGLite's
  `ON CONFLICT` update sets the body and keeps `body_storage = 'segmented'`, so its CHECK refuses the row. PGLite
  throws the raw Postgres error (code `23514`); the store uses `constraint_violation` with the same message.
- A version snapshot copies the page's NULLs.
- Format: records written before these fields were nullable hold strings and read unchanged; a record without
  `chunker_version` reads it as NULL, and `chunker_version` is written only when set. This change took no format number; the store is at format 17
  now ([format.md](format.md)).

## Search timeline

PGLite's page keyword vector (`search_vector`) is the title (weight A) plus the first 65,536 characters of
`sanitizeRemoteBody(timeline)` (weight C). It is set when the page's chunks are sealed (`sealPageTextProjection`).
The sanitizer runs in TypeScript only, so `sealChunks` sends its output with the seal (`searchTimeline` in the
`upsertChunks` options) and the store keeps it with the page under `M page_search_timeline/<page id>`.

- **Record.** `SearchTimeline { revision, timeline }`: the page's `knowledge_revision` at the seal, and the text with
  NUL removed, cut to 65,536 characters (`SEARCH_TIMELINE_MAX_CHARS`).
- **Read.** `pages::search_timeline(read, page_id)` returns the record, or `None` when no seal sent one since the
  last write that set the title or timeline. The text describes the page's current text when `revision` equals the
  page's `text_projection_revision`.
- **Written by** a seal that carries `searchTimeline` (TypeScript `sealChunks`). A segmented page has a NULL timeline
  and sends none. A write that does not seal ignores it, and a seal without it (the store's own indexing `putPage`)
  writes nothing.
- **Forgotten** (`pages::forget_search_timeline`) by every write that sets the title or timeline. PGLite's
  `trg_pages_search_vector` fires `BEFORE INSERT OR UPDATE OF title, timeline` (and `timeline_lead` once that column
  exists) and puts the unsanitized trigger form back; `UPDATE OF` fires on the `SET` list, also when the value is
  unchanged. Only a later seal with the text writes the record again.
- **Deleted** with the page on a hard delete (`remove_page`).

PGLite SQL that sets `title` or `timeline`, and where the store forgets the record:

| PGLite statement | Store write | Forgets the record |
| --- | --- | --- |
| `putPage` (`engine-sql/pages.ts`, `INSERT … ON CONFLICT DO UPDATE SET title, timeline`) | `pages::put_page_in` (`putPage`, and the journal's `submit_page_mutation`) | always, also when nothing changed and with `index: false` |
| `refreshPageBody` (`engine-sql/pages.ts`, `UPDATE pages SET compiled_truth, timeline`) | page_body family `refresh_page_body` | the family calls `forget_search_timeline` |
| the body generation flip (`engine-sql/page-body.ts`, `UPDATE pages SET … timeline = NULL, title, timeline_lead`) | page_body family `flip_body_generation` | the family calls `forget_search_timeline` |
| `createSegmentedPageShell` (`engine-sql/page-body.ts`, `INSERT INTO pages`) | page_body family | nothing to do: a new page id has no record |
| withdrawal materialize (`page-state/materialize.ts`, `UPDATE pages SET compiled_truth, timeline`) | none: it runs through `executeRaw`, which the Rust engine refuses | not served |

Any other write that changes the title or timeline through `pages::write_page` forgets the record there, since a
changed value means PGLite's `SET` list named the column. A write that keeps both values (a seal, a tag change, a soft
delete, a restore, a rename, `revertToVersion`, which sets only `compiled_truth` and `frontmatter`) keeps it.

The page purge's receipt reads: `relationExists(table)` (`src/core/engine-sql/purge-receipt.ts`) is answered in TypeScript without a
store call (`src/core/rust-engine/store-members/purge-receipt.ts`), because the store keeps keyspaces, not SQL relations.
`relationExists` answers true for a name the graduation inventory
lists as a table or view (an optional `public.` prefix is dropped and an unquoted name is lowercased, as `to_regclass` reads it) and
false for any other name, a quoted or other-schema one included; the query cache is on that list, so the purge receipt names no
missing cache, as `clearQueryCache` answering 0 already assumes. `page_segment_derivation_purges` is a relation the store keeps
(see the derivation sweep record in page_body.md), so it answers true for it. `readDerivationPurgeState` goes to the store: `pending` for a
request whose fact purge recorded a sweep, null for none.
