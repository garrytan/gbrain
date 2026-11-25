# The brain store: Sources

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the `default` source: `{ id: 'default', name: 'default', local_path: null,
last_sync_at: null, config: { federated: true } }`. A row is PGLite's `SourceRow` plus
`incarnation` (a UUID that changes when a source is deleted and created again), with
`last_sync_at` as an ISO string. The record also keeps the source's `chunker_version` stamp, absent
until the first stamp; the import members read and write it ([import-members.md](import-members.md)).
The source's own contextual-retrieval mode sits beside the record ([source-cr-mode.md](source-cr-mode.md));
the `getSource` member and the engine migration's `sources` read add it.
It keeps the sync anchor too: `last_commit` and `newest_content_at`, absent until the first sync
advances them. Records written before these fields existed read them as absent.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listAllSources({ includeArchived?, localPathOnly? }?)` | `SourceRow[]`, `default` first then by `id` in byte order (the SQL engines sort `id COLLATE "C"`); archived rows are left out unless `includeArchived`; `localPathOnly` keeps rows with a `local_path` that are not `config.role = 'storage_manifest'` | `listAllSources` |
| `brain.getSourceById(id)` | `SourceRow \| null`, archived rows included | `sources-ops` read by id |
| `brain.upsertSource({ id, name?, local_path?, last_sync_at?, config? })` | the `SourceRow`; only the fields given change; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `sources add` |
| `brain.updateSourceConfig(id, patch)` | `boolean`, whether the source exists; `patch` is merged one level deep, and a `null` value is kept as JSON `null` (it does not remove the key) | `updateSourceConfig` |
| `brain.markSourceSynced(id, { incarnation? }?)` | `boolean`, whether a source was stamped; sets `last_sync_at` to the store clock at the moment of the write (`now()` on the SQL engines), and an unknown id changes nothing. With `incarnation` (a managed sync run's guard) only a source still of that incarnation is stamped, compared without case; a malformed id is refused with `invalid_argument`, as the SQL `::uuid` cast refuses it | `markSourceSynced` |
| `brain.replaceSourceConfig(id, config)` | `boolean`, whether the source exists; replaces the whole config (`sources federate`, `unfederate`, `webhook`, `tracked-branch`); an unknown id changes nothing | `replaceSourceConfig` |
| `brain.renameSource(id, name)` | `boolean`, whether the source exists; sets the display name (`sources rename`); an unknown id changes nothing | `renameSource` |
| `brain.readLiveSlugAliases(sourceId, targets)` | `{ alias_slug, canonical_slug }[]` in alias byte order (the SQL states no order): the `slug_aliases` rows among `targets` whose alias has no live page and whose canonical page is live, for link preparation (`link_slug_reads.rs`) | `readLiveSlugAliases` |
| `brain.readSourceSlugProbe(sourceId, afterId)` | `{ count, hash, maxId, added, addedHash }` over the source's pages, deleted ones included: the slugs above `afterId` in id order. The hash is the store's own sum of 64-bit FNV-1a slug hashes (decimal text); Postgres sums `hashtextextended`. The caller compares a hash only with one the same engine gave, so the values differ by engine and the answers do not | `readSourceSlugProbe` |
| `brain.readStoredSlugSpellings(key, sourceId, sourceIds, after)` | `string[]`, at most 200 distinct stored slugs in byte order after `after`, whose spelling key is `key`: ASCII capitals lowered, U+0130 to `i` and a combining dot, U+212A to `k`, composed to NFC, and every character but `a-z0-9` removed (`SPELLING_KEY_SQL`). Deleted pages count and no privacy rule applies; the scope is `sourceIds` when given (an empty list matches nothing), else `sourceId`, else every source (`slug_spellings.rs`) | `readStoredSlugSpellings` (`engine-sql/slug-spellings.ts`), `chooseSpelling` in `ops/slug-params.ts` |
| `brain.readFederationExposedPages(sourceId, hidePrivate, honorAliases)` | `{ slug, member, total }[]`, first five slugs in byte order: live pages that name no readers, carry no folder rule, pass the privacy part (with `hidePrivate`), and whose live revision or an archived version an `oauth_client` or `legacy_token` principal wrote. `member` is the smallest bound client member; the store keeps no access tokens, so a token writer binds none (`federation_exposure.rs`) | `readFederationExposedPages` |
| `brain.readMeetingPage(sourceId, meetingId)` | `{ slug, source_path } \| null`: the live page of the source whose frontmatter `meeting_id` text is `meetingId`, lowest page id first; no read policy, as the statement has none (`src/meeting_pages.rs`) | `readMeetingPage` (`engine-sql/meeting-pages.ts`), the meetings connector's `existingPath` |
| `brain.listAttendanceMatches(sourceId, slugs, name)` | at most two slugs of live `person` pages of the source whose slug is one of `slugs`, whose title is `name` under `lower()`, or whose frontmatter `aliases` array holds `name` under `lower()` (PGLite's case table, `pg_lower`); the lowest two page ids, where the SQL has no order (`src/meeting_pages.rs`) | `listAttendanceMatches` (`engine-sql/attendance-pages.ts`), link extraction's `resolveAttendance` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists; archiving sets no archive time (an unverified archive the purge sweep never deletes), un-archiving clears both times | test fixtures |
| `brain.archiveSource(id, ttlHours)` | `{ id, name, archived_at, archive_expires_at } \| null`; an active source is archived now with its expiry `ttlHours` later and `config.federated` false; a missing or archived source changes nothing | `archiveSource` (`sources archive`) |
| `brain.restoreArchivedSource(id, federated)` | `boolean`, whether an archived source was restored; both archive times are cleared and `config.federated` is set | `restoreArchivedSource` (`sources restore`) |
| `brain.listArchivedSourceRows()` | every archived source with `page_count` (soft-deleted pages included), newest `archived_at` first; a source with no archive time comes first, equal times by id descending | `listArchivedSourceRows` (`sources archived`) |
| `brain.listExpiredArchivedSources()` | `{ id, incarnation, config, local_path }[]` by id: both archive times after `1970-01-02` UTC and the expiry passed | `listExpiredArchivedSources` (the purge sweep) |
| `brain.listUnverifiedArchivedSourceIds()` | the archived source ids, by id, with either time missing or at or before `1970-01-02` UTC | `listUnverifiedArchivedSourceIds` (the purge sweep's report) |
| `brain.readSourceDeleteImpact(id)` | `{ id, name, pages, chunks, embeddings, files, facts } \| null`; pages include soft-deleted ones, `embeddings` counts chunks with a vector, `files` counts the source's files | `readSourceDeleteImpact` (the `sources remove` preview and the destructive guard) |
| `brain.deleteSourceRecord(id, expiredArchiveOnly)` | `boolean`, whether the source was deleted: a missing source, or with `expiredArchiveOnly` one that is not an archive past its window, changes nothing; in one write transaction it removes every page (`pages::remove_page`), the `cascade::remove_source_rows` list, the source's `managed-sync` cursors, its write gate holds with their receipts, its writer binding when it binds the deleted incarnation (`persistence::remove_source_binding_in`; the worktree and host bindings stay, as on Postgres), and each eval candidate's retrieved slug no other covered source has; an OAuth client whose `source_id` names the source (revoked ones too) refuses `constraint_violation` with the foreign-key message and changes nothing; a client whose `bound_source_id` names it gets null | `deleteSourceRecord` (`deleteSourceRow`: `sources remove`, the purge sweep) |
| `brain.markSourceSynced(id, { incarnation?, newestContentAt? }?)` | `boolean`, whether a source was stamped; sets `last_sync_at` to the store clock at the moment of the write (`now()` on the SQL engines), and an unknown id changes nothing. With `incarnation` (a managed sync run's guard) only a source still of that incarnation is stamped, compared without case; a malformed id is refused with `invalid_argument`, as the SQL `::uuid` cast refuses it. `newestContentAt` (timestamptz text: ISO with `Z` or an offset) also sets `newest_content_at`; null or absent keeps it, as `COALESCE` does; text that is not a time is refused | `markSourceSynced` |
| `brain.advanceSyncCheckpoint({ sourceId, incarnation, commit, from, acceptAtCommit, slugMode, keepPinnedSlugMode })` | `{ advanced, pinnedSlugMode }`. When the source is still that incarnation (compared without case; a malformed id is refused), its `last_commit` is still `from` (or already `commit` with `acceptAtCommit`; a null `commit` never matches there, as `last_commit = NULL` is never true) and its pinned `config.slug_root_mode` allows the run, one write sets `last_commit` (null with a null `commit`: a first sync's unfinished slice), `last_sync_at` (store clock), `newest_content_at` (the newest `updated_at` of the source's live pages, or none) and `config.slug_root_mode` (the pinned mode kept with `keepPinnedSlugMode`). A refused checkpoint writes nothing; `pinnedSlugMode` names a pinned mode that differs from the run's, unless the run keeps the pinned mode | `advanceSyncCheckpoint` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists | `sources archive` and `restore` |
| `brain.insertSource(id, name, localPath, config)` | the new `SourceRow`; a taken `id` or `name` refuses `constraint_violation` and writes nothing; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `insertSource` (`sources add`) |
| `brain.advanceSourceCommit(id, commit, setNewest, newestContentAt)` | nothing; one write that sets `last_commit` and `last_sync_at` (the process clock), and `newest_content_at` when `setNewest` is true (`null` clears it); archived sources advance too, and an unknown source changes nothing | `advanceSourceCommit` (the sync anchor) |
| `brain.readSourceLastCommit(id)` | the source's `last_commit`, archived sources included, or `null` before a sync and for a missing source | `readSourceLastCommit` (the resident notifier's `lastCommit`) |
| `brain.countRepoBoundSources()` | `number`, the sources that are not archived and have a non-empty `local_path` | `countRepoBoundSources` (the readiness sync probe) |
| `brain.readSourcePurgeEpoch(id)` | `number`, the source's stored `purge_epoch` (0 until a purge raises it; archived sources answer too), or `null` for an unknown source | `readSourcePurgeEpoch` (the belief ledger's prepared-epoch check, the sync reason scan) |
| `brain.countRepoBoundSources()` | `number`, the sources that are not archived and have a non-empty `local_path` | `countRepoBoundSources` (the readiness sync probe) |
| `brain.holdPageEmbedding(pageId, reason)` | `null`; sets the page's embedding hold to `{ state: 'held', reason }`, replacing a held reason; an unknown page id refuses `page_not_found`; a hard page delete drops the hold | `holdPageEmbedding` (page-embedding-budget.ts) |
| `brain.readReasonPurgeTombstones(sourceId, pair)` | `{ commit_sha, path }[]`, the source's purged change-reason pairs by commit then path, or only `pair` (when not `null`) if it is stored | `readReasonPurgeTombstones` (`reason_purge_tombstones`) |
| `brain.writeReasonPurgeTombstones(sourceId, pairs)` | `number`, the pairs added; a stored or repeated pair adds nothing; an unknown source refuses `source_not_found` and stores nothing; a source delete drops its pairs | `writeReasonPurgeTombstones` (facts purge) |
| `brain.listSourcePathPages(sourceId)` | `{ slug, source_path }[]`, the source's live pages that record a source path, in slug byte order | `listSourcePathPages` (the full sync's stale-page reconcile) |
| `brain.readRenameIdentityRows(sourceId, paths, slugs)` | `{ slug, source_path, title }[]`, the source's live pages whose source path is in `paths` or slug in `slugs`, in slug byte order | `readRenameIdentityRows` (a sync's rename confirmation) |
| `brain.readLiveIdentityHolders(sourceId, ids, titles)` | `{ slug, source_path, fm_id, title }[]`, the source's live pages whose frontmatter `id` (a string as is, any other value as its JSON text) is in `ids` or title in `titles`, in slug byte order | `readLiveIdentityHolders` (a sync's rename confirmation) |
| `brain.readPageIdentity(pageId)` | `{ fm_id, title }` of a live page, or `null` | `readPageIdentity` (a held rename decided again) |
| `brain.advanceSourcePurgeEpoch(sourceId)`, `brain.readSourcePurgeEpoch(sourceId)` | `number`, the source's purge epoch after adding one / as stored (0 before any purge); `null` for an unknown source, which changes nothing | `advanceSourcePurgeEpoch` (`belief/purge.ts` `bumpPurgeEpoch`), `readSourcePurgeEpoch` (`reason-trailers.ts` `cachedSyncReasonScan`, `readLedgerSource`) |
| `brain.countSourcePages(sourceId, includeDeleted)` | `number`, the source's pages; soft-deleted pages count only with `includeDeleted`; an unknown source has none | `countSourcePages` (`sources list`, `status`, `remove`) |
| `brain.advanceSourceCommit(sourceId, commit, setNewest, newestContentAt)` | `undefined`; sets `last_commit` and stamps `last_sync_at` now; with `setNewest` also sets `newest_content_at` (an ISO time, or `null` to clear it); an unknown source changes nothing | `advanceSourceCommit` (`writeSyncAnchor` of `src/core/sync-anchor.ts`) |
| `brain.writeSourceSyncHeartbeat(sourceId)` | `undefined`; sets `last_sync_at` to the store clock and leaves `last_commit` alone; an unknown source changes nothing | `writeSourceSyncHeartbeat` (the 0-change sync heartbeat in preflight) |
| `brain.writeSourceUpstreamObservation(sourceId, checkedAt, commit, behind)` | `undefined`; sets `upstream_checked_at` (an ISO time; anything else refuses `invalid`), `upstream_commit` and `upstream_behind` (null allowed); an unknown source changes nothing | `writeSourceUpstreamObservation` (`recordUpstreamObservation`, after every sync) |

`upsertSource` and `setSourceArchived` are not in PGLite's engine interface; the store needs a way
to make a source, and the page methods below are source-scoped.

## Differences from the SQL engines (accepted for 1x parity)

The source members below behave differently on the Rust engine. Each difference is accepted for
1x parity. Keep this list current when a member changes.

- `config` is a map in the store. Where a SQL engine keeps a JSON string as the config, the Rust
  engine writes `{}`. On the SQL engines, a JSON-string config reads as no keys.
- `pickSoleNonDefaultSource` takes the routing rows from the request snapshot, else from a live
  `listSourceRoutingRows()` read. Both paths apply one filter: `local_path` set, id not
  `default`, not archived, role not `storage_manifest`.
- `listStaleSyncSourceIds` compares `last_sync_at` with the process clock. The SQL engines use
  the database clock (`now()`).
- `listSourceIds` reads the ids from `listSourceRecords`, archived sources included, and sorts them in
  byte order. The SQL engines sort `ORDER BY id COLLATE "C"`, the same byte order on any server
  locale.
- `readSoleSourceId` and `readFirstSourceId` read `listSourceRecords` too. The first answers the
  only id or null; the second answers `default`, else the lowest id in byte order, as the SQL
  engines' `COLLATE "C"` tie-break does. No parity case can drop `default` on a Rust brain, so
  only the SQL arms check the case without it.
- `lockAllSourceRows` takes no lock, like `lockSourceRow`. The SQL engines read every row
  `ORDER BY id FOR UPDATE` (or `FOR SHARE`).
- `lockSourceRow` reads the row from `listSourceRecords` and takes no lock. The SQL engines read
  with `FOR UPDATE`; no parity case checks that lock.
- `readSourceRow` reads from `listSourceRecords`. A caller that needs the incarnation makes one
  `readSourceIncarnation` call per source.
- `advanceSourceCommit` stamps `last_sync_at` with the process clock. The SQL engines use the
  database clock (`now()`). `getSource`, `readPlainSyncSource` and `listSourceRecords` read the
  stored `last_commit`; `listSourceRecords` also reads the stored `newest_content_at`.
- The store keeps the full `page_embedding_budget` ledger: state, reason, embedding signature, spend, reservation,
  reservation time, unpriced-call count, cap and update time. Its key is `B b <page id BE>`
  (`page_embedding_budget.rs`). `reservePageEmbedding` and `settlePageEmbeddingReservation` update it. `readPageSizeRows` reads its
  `state` and `reason` and lists a page with any ledger row, of any size.
- A page's embedding hold lives only in its `page_embedding_budget` ledger row
  (`page_embedding_budget.rs`, `holdPageEmbedding` and `recordPageEmbeddingHold`; docs/store/embeddings.md).
  There is no separate hold family: key tag `2` (the old `embedding_holds`) is free.
  `readPageSizeRows` reads the ledger row's `state` and `reason`, so it reports the same as the SQL
  engines (which left-join the row) and lists a page with any ledger row, of any size.
- `readReasonPurgeTombstones` sorts pairs by commit, then path, in byte order. The SQL engines
  sort them by the database collation. The callers put the pairs in a set or a map, so no caller
  reaches this difference.
- Restore-target and connector status sort sources by id in byte order on every engine.
- `insertSource` refuses an id outside `[a-z0-9-]{1,32}` with `invalid_argument`. The SQL engines
  have no check on the id column, so they accept such an id. `sources add` validates the id
  before the insert, so no caller reaches this difference.
- `insertSource` refuses a taken id or name with `constraint_violation`. The SQL engines throw the
  driver's unique-key error (`23505`). Callers treat both as a failed insert.
- `insertSource` drops a config key set to `undefined`, as the SQL engines' JSON binding does.
  The result is the same on every engine.
- The archive times use the process clock. The SQL engines use the database clock (`now()`).
- `listExpiredArchivedSources` and `listUnverifiedArchivedSourceIds` sort ids by bytes. The SQL
  engines sort with the database collation; source ids are `a-z0-9-` only, but under `en_US` a
  hyphen can sort differently.
- `listArchivedSourceRows` breaks equal archive times by id, greatest first, in byte order, as the
  SQL engines now do (`s.id COLLATE "C" DESC`).
- `deleteSourceRecord` always removes the pages, as the `pages -> sources` cascade does, so it
  never reports `stranded` pages (the SQL engines report them when that cascade would not fire,
  #7072). The store keeps no `persistence_source_bindings`, retrieval events or feedback,
  `context_volunteer_events` or `core_edit_notices`, so those steps of the SQL delete have nothing
  to remove. The SQL engines run the scrub again in a second statement for a write that waited on
  the delete; the store's one write transaction leaves no such gap.
