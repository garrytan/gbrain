# Repair bookkeeping

The engine members the bookkeeping repair kinds call (`src/core/engine-sql/repair-bookkeeping.ts`,
plus `listSourceIncarnations` in `engine-sql/sources.ts`): `gbrain repair orphan-bindings`,
`loop-facts` and `connector-checkpoints`, and the doctor checks of the same names. The
managed-sync-orphan and owned-content members (`engine-sql/managed-sync-orphans.ts`,
`engine-sql/owned-content.ts`; Rust side `store-members/managed-sync-orphans.ts`) have their own
sections below. The SQL engines run
the statements those files ran through `executeRaw`; a Rust brain serves each member from what the
store keeps (`src/core/rust-engine/store-members/repair-bookkeeping.ts`).

| Member | SQL engines | Rust brain |
| --- | --- | --- |
| `listSourceIncarnations(ids)` | `{ id, incarnation }` of each named source, by `id COLLATE "C"` | `readSourceIncarnation` per distinct id, by id in code-unit order; a missing source is left out |
| `listOrphanBindings({ limit })` | writer bindings whose source is gone or whose incarnation changed, with their pending requests | `[]`: the store keeps no writer bindings (a Rust brain is never managed) |
| `deleteOrphanBinding(binding)` | deletes the binding when it is still an orphan | `false`: no binding exists |
| `readLoopFactState(loopId, { lock })` | the loop, its commitment fact and whether another open loop holds the fact; `lock` adds `FOR UPDATE` | `facts::loops` `read_loop_fact_state`; `lock` is moot, as the store serializes writes |
| `expireSourceFactNow(factId, sourceId)` | expires one unexpired fact of the source now | `facts::loops` `expire_source_fact_now` (`rust/docs/store/facts.md`, "Open loops") |
| `listConnectorSources({ lock })` | every source whose `config.kind` is a connector kind; `lock` share-locks them in id order | `listSourceRecords` filtered on the connector kinds, with `readSourceIncarnation`; `lock` sorts by id |
| `listOrphanConnectorCheckpoints(loadable, bounds, limit)` | the orphan predicate below, by op then fingerprint | `persistence::connector_orphans` |
| `countConnectorCheckpointsKeyed(keys)` | checkpoint rows keyed by one of the keys (retry rows by `checkpointKey`) | `persistence::connector_orphans` |
| `deleteOrphanConnectorCheckpoint(row, loadable, bounds)` | deletes the row when its stamp is unchanged and it is still an orphan | `persistence::connector_orphans` |

## Orphan connector checkpoints

A connector checkpoint is an `op_checkpoints` parent (`persistence.md`, "Op checkpoints") of op
`managed-connector`, keyed by its fingerprint, or `managed-connector-retry`, keyed by
`completed_keys[0].checkpointKey`. It is an orphan when all of these hold:

- its key is not in `loadable`;
- no pending connector request names it. A request is pending when it is outstanding (`queued`,
  `deferred`, `running`, `recovering`) or in recovery, and is a connector request when its
  `intent.kind` starts with `connector_v2_` or `managed_connector_`. A request names the row when its
  `intent.checkpointKey` is the fingerprint or the row's `checkpointKey`, or its request id is the
  row's `completed_keys[0].requestId`;
- no request of any state that a `stateOp` row lists in `completed_keys[0].pending[]` (by
  `requestId`) names it the same way;
- its stamp is not after `before`, and is older than `minAgeDays` days when that is given.

`updated_at` is the stamp as Postgres `timestamptz::text` in UTC (`2026-11-18 07:46:03.336+00`). The
delete reads its `updated_at` and `before` as `timestamptz`: the store accepts that form and ISO 8601,
and refuses other text with `invalid_argument`.

Differences from the SQL engines:

- Postgres orders the scan by the database collation; the store orders by bytes.
- Postgres raises an error when a `stateOp` row's `pending` is present and not an array
  (`jsonb_array_elements` of a scalar); the store reads it as no pending requests.
- `minAgeDays` is a whole number of days from the store clock; Postgres reads `now()`, the start of
  the transaction.
- The delete runs in one store write, so the orphan test and the delete see the same rows, as the
  share lock and `FOR SHARE` give on Postgres.

What still runs through `executeRaw` and so refuses on a Rust brain: `migrateConnectorCheckpoints`
(migration 176) and `readConnectorV2Cutoff`.

## Managed-sync orphans

`gbrain repair managed-sync-orphans` (`src/core/persistence/managed-sync-orphans.ts`) and the
failure-ledger prune read and retire the managed-sync `op_checkpoints` rows: `managed-sync` cursors,
`managed-sync-pass` rows, `managed-sync-failure` rows and `managed-sync-manifest` rows.

| Member | SQL engines | Rust brain |
| --- | --- | --- |
| `listManagedSyncOrphanRows(sourceIds)` | the cursors, failures, retired cursors and pass rows, each with the flags the classifier reads | the same predicates evaluated over `listOpCheckpointRecords`, `listSourceRecords`, `listSourceRequestRows` and the local writers |
| `listArchivedSourceIds()` | ids of archived sources | `listSourceRecords` with `archived` |
| `listManagedSyncFailureKeys(keys)` | the keys that have a `managed-sync-failure` row | `readOpCheckpointRecord` per key |
| `applyManagedSyncRetireLimits()` | `synchronous_commit` on and a 2-second `lock_timeout`, for the transaction | no-op |
| `retireManagedSyncPassSlugMode(target, lockId)` | drops `obligations.slug_mode` from the pass row while its refusal holds and no pass holds the drain lease | the same test; the lease is `readCycleLocks({ by: 'id' })`, the write `writeOpCheckpointRecord` |
| `retireManagedSyncCursor(target, mode)` | deletes the unfinished cursor when its pending request is not live and the mode's re-check holds | the same test, then `deleteOpCheckpoint` |
| `deleteManagedSyncFailureRow(key, retired)` | deletes the failure row while no cursor shares its key | the same test, then `deleteOpCheckpoint` |
| `deleteManagedSyncManifest(runId)` | deletes the manifest while no cursor names the run | the same test, then `deleteOpCheckpoint` |

`listSourceRequestRows(sourceId)` (`persistence::sync_orphan_reads`) lists one source's requests by
sequence with the columns the predicates read; `recovery` is whether the request has a recovery
record. `listOpCheckpointRecords(op)` lists one op's parents by fingerprint with `updated_at_us`,
the stamp in microseconds that the listing sorts on.

Differences from the SQL engines:

- Postgres orders the listing by `s.id`, `c.updated_at`, `c.fingerprint` in the database collation;
  the store orders ids and fingerprints by bytes.
- Postgres casts JSON text with `::int` and `::uuid` and raises an error on text that is not a number
  or a UUID. The store reads such text as no match. A retire whose pending `requestId` is not a UUID
  keeps the cursor (fail-closed), as Postgres does when its statement fails.
- `->>` of a JSON value that is not a string is its JSON text, as on Postgres.
- `FOR UPDATE`, `lock_timeout` and `synchronous_commit` are moot: each member's test reads the store
  and its write is one store call.
- A cursor's writer principal is live when the store's local writers list it.
- `clearSyncSlice` still runs through `executeRaw`, so a retire that clears a sync slice refuses
  `raw_sql` on a Rust brain and its transaction rolls back. A Rust brain is never managed, so it has
  no managed-sync rows to retire.

## Owned content

`listOwnedContentRows` (`shared-skills/content-freshness.ts`), `readContentReceiptBinding` and
`readConfigForUpdate` (`repair/content-receipt-root.ts`) read which sources a writer binding owns,
the binding behind a content receipt and a config value under `FOR UPDATE`. A Rust brain keeps no
writer bindings, so it owns no content: `listOwnedContentRows` answers `[]` and
`readContentReceiptBinding` answers `null`. `readConfigForUpdate` is `getConfig`, as the store
serializes writes.

## Source reads

The repair kinds read `sources` through the engine members, not `executeRaw`:
`listSourceIncarnations(ids)` for the incarnation lists in the preview hashes,
`readSourceIncarnation`, `readSourceLocalPath`, `readSourceState` and `getSource` for one source,
`listAllSources` for the live-source count and id list, `lockSourceRow` for the row locks, and
`readSourceStates(engine, ids)` (`src/core/source-rows.ts`) for the rows of the named sources,
archived ones included, by id. The brain id in the captured-facts, redacted-facts,
agent-session-facts and rotation hashes is `readPersistenceBrainId`. Two results differ from the
raw reads they replace: an incarnation list is in `id COLLATE "C"` order on every engine (a Postgres
brain with an `en_US` collation hashed the old list in that collation's order, so a preview hash
taken before the change can differ once), and `readSourceStates` parses a config stored as a JSON
string. Still raw SQL: `attendance-repair.ts` (needs `archived_at`; its apply transaction is raw
SQL), `fence-repair/census.ts`, `doctor/checks/orphan-bindings.ts` (a union with the writer
bindings) and the statements that join `sources` into a wider query. Pinned by
`test/engine-parity/repair-source-reads.test.ts`.

## Page repair reads

The `access` and `orphan-children` kinds, doctor's `access_page_readers_backfill`,
`child_table_orphans` and `origin_twins` checks and `persistence/origin-index.ts` read pages through
these members (`engine-sql/repair-page-reads.ts` on PGLite and Postgres,
`rust-engine/store-members/repair-page-reads.ts` on Rust). The Rust answers follow from what the
store keeps:

| Member | Rust answer | Why |
| --- | --- | --- |
| `countPageChildOrphans(target)` | `countOrphanChunks()` for `content_chunks.page_id`, else 0 | `cascade::remove_page_rows` removes a page's tags, links, timeline and other child rows in the same write as the page |
| `clearPageChildOrphans(target)` | 0; a typed refusal when chunk orphans exist | the store has no writer for chunk rows whose page is gone |
| `probeTornPages()` | `{ count: 0, named: [] }` | a page body is one record; no page row can lose its body |
| `listAccessReaderDrift`, `countAccessReaderDrift` | `[]`, 0 | the store keeps no stored-readers column; `facts/privacy.rs` derives the readers from the frontmatter at every read |
| `deriveAccessReaders(pageId)` | `false` | as above: nothing to derive |
| `readOriginIndexState()` | `present` | `pages::assert_origin_unclaimed` enforces one live page per origin (`keys::page_origin`) on every write path |
| `listOriginTwinCounts(limit)` | `[]` | as above: no two live pages share an origin |

Both targets lists are checked on every arm: a target outside `PAGE_CHILD_FK_TARGETS` throws
`not a page child column`. Pinned by `test/engine-parity/repair-page-reads.test.ts`.

## Alias targets

`gbrain repair aliases` and doctor's `dangling_aliases` check read the alias targets whose page is
not live (`src/core/engine-sql/alias-orphans.ts`). Unlike the page child rows above, alias rows have
no foreign key to their page on any engine, and the store keeps them past a hard delete (the module
comment of `aliases.rs`), so both members run store code (`aliases/orphans.rs`), not an invariant.

| Member | Store answer |
| --- | --- |
| `listAliasTargets(sourceIds)` | counts the by-page keys (`0x03`) by slug and the slug alias records (`0x01`) by `canonical_slug`, then reads each target's page row: `missing` with none, `soft_deleted` with `deleted_at`, skipped when live; byte order, as the SQL's `COLLATE "C"` |
| `deleteOrphanedAliases(sourceId, slug)` | in one write, when the slug has no page row, deletes its page aliases (both keys) and every slug alias that resolves to it (both keys); a rename redirect whose alias is the slug and the rename history stay |

Pinned by `test/engine-parity/repair-aliases.test.ts` and the store test
`alias_targets_name_missing_and_soft_deleted_pages_and_the_delete_takes_only_missing_ones`.

## Repair page scans

The plans of `gbrain repair safe-chunks` and `gbrain repair origin-twins` read live pages
(`src/core/engine-sql/repair-page-scans.ts`). The store scans every page record and filters it as
the SQL's `WHERE` does (`repair_scans.rs`); it does not use the origin index, which leaves out an
empty `source_path` that SQL's `IS NOT NULL` keeps.

| Member | Store answer |
| --- | --- |
| `listSafeChunksPending(sourceIds)` | live pages whose `chunker_version` is below the safe fence version (a missing version is not), or that are not segmented and carry a credential re-chunk hold (`op_checkpoints` `credential-reseal-hold`, keyed by page id, naming the page's revision and the caller's producer while the text projection lags); `rebuildable` for markdown, or code naming `frontmatter.file` or a `source_path`; by id |
| `listOriginTwinGroups(sourceId, limit)` | live paths two or more pages record, in byte order, as the SQL's `COLLATE "C"` |
| `listLegacyOriginPairs(sourceId, prefix, limit)` | each live page whose path is `prefix` plus another live page's path, by the legacy id then the other's (the SQL now orders under its `LIMIT`) |
| `listLiveOriginPages(sourceId, paths)` | live pages recording any of `paths`, by id |
| `countLiveFileBackedPages(sourceId)` | live pages recording a `source_path` |

On Rust, the origin-twins plan always takes its no-owner path, because the worktree binding is not
served yet, and its apply finds `pages_live_origin_key` present. So the kind previews and applies.
The safe-chunks apply re-seals chunks, a B6 writer. Pinned by
`test/engine-parity/repair-page-scans.test.ts` and the store test
`scans_answer_what_the_sql_filters`.

## Repair plan scans

The plans of `gbrain repair frontmatter` and `gbrain repair segmented-tiling`, and every sync hold
reader, read through four members (`src/core/engine-sql/repair-plan-scans.ts`). The store scans its
page, manifest and checkpoint records and filters them as the SQL's `WHERE` does
(`repair_plan_scans.rs`).

| Member | Store answer |
| --- | --- |
| `listPagesByOriginPath(sourceId)` | live pages recording a `source_path`, with the first 400 characters of compiled truth (null when the page stores none inline), by slug in byte order |
| `countSegmentedOriginPages(sourceIds)` | live pages recording a `source_path` whose `body_storage` is `segmented` |
| `listUntiledSegmentedPages({ sourceIds, slugs, limit })` | live segmented pages of unarchived sources whose live generation's published rows, by seq, leave a gap or do not sum to `body_bytes` (a NULL `body_bytes` counts only a gap), by source then slug, at most `limit` (default 1000) |
| `listSourceHoldRecords(op, { sourceIds, runId })` | the first record of each `op` checkpoint whose `source_id` and `incarnation` name an existing source's current incarnation, narrowed by source and `run_id`, by source then fingerprint in byte order; `mirror_read_only` is the source's `config.mirror_read_only` |

`readGitSourceHolds` marks a read-only mirror's records `read_only_checkout` over the listing, and
the provenance plan filters the listing to its pages' slugs and ids. The listing now sorts in byte
order on every engine (it used the database collation). No Rust write publishes a body whose rows
do not tile it, so on Rust the untiled list is empty and the segmented-tiling plan never reaches its
per-page file and stored-field reads. Pinned by `test/engine-parity/repair-plan-scans.test.ts` and
the store test `repair_plan_scans`, which builds the damage directly.

## Git holds

Every Git sync hold write (`writeGitHold`, `clearGitHold`, the meta rewrites and the retry request
of `src/core/persistence/sync-holds.ts`) runs through three members
(`src/core/engine-sql/git-holds.ts`). A hold is one `sync-hold` checkpoint per
(source, incarnation, path); its source's summary is one `sync-hold-summary` checkpoint with the
hold `count` and seven counters. The store applies each write as one store write
(`persistence/git_holds.rs`).

| Member | Store answer |
| --- | --- |
| `swapGitHold({ sourceId, incarnation, path, prior, next, summary })` | with `summary`, the summary row created with a zero count or stamped now; then the hold row replaced by `next` (null deletes it) only when it still holds `prior` (null: no row), compared as jsonb compares; when it swapped, `count` and each counter moved by the delta and clamped at zero (a counter stored as numeric text reads as its number); resolves whether it swapped |
| `readGitHoldRecord(sourceId, incarnation, path)` | the hold's first record with the source's `config.mirror_read_only`, null when there is no record |
| `requestGitHoldRetry(sourceId, incarnation, paths, requestedAt)` | the retry request's `paths` as the union of its paths and `paths`, once each in byte order, stamped `requestedAt` |

A hold write reads the row, computes the next record and swaps it in, reading again up to five times
when another write changed the row in between. Before, the write replaced the row without that
check, so it could drop a repair stamp another write had just added. Retry paths now keep byte order
on every engine (an update used the database collation), `requested_at` is the caller's ISO time,
and a read-only mirror's `read_only_checkout` key sits in jsonb key order on Postgres too. A write
that skips, or a clear with no hold, no longer creates the summary row. Pinned by
`test/engine-parity/git-holds.test.ts` and the store test `git_holds`.

## Repair kinds by batch

The plan of record for moving the 67 `gbrain repair` kinds onto the engine contract. Flags are the
kind's spec flags (E explicit only, P preview bound, D destructive consent, L spends LLM, A approval
unbound, U unlisted). Doctor is how doctor reaches the kind (RUN: `--remediate --include-repairs`
runs it; FIX: a doctor check or fix command names it; LIST: a notice names its preview). Batch is
the batch whose seeded runRepair case proves it on all three arms.

| Kind | Flags | Doctor | Batch |
| --- | --- | --- | --- |
| `contextual-mode` | - | RUN | B1 |
| `frontmatter-keys` | EP | FIX | B1 |
| `google-file-modes` | E | FIX | B1 |
| `stuck-recovery` | EPD | LIST | B1 |
| `connector-checkpoints` | - | RUN | B2 |
| `content-receipt-root` | EP | FIX | B2 |
| `loop-facts` | E | FIX | B2 |
| `managed-sync-orphans` | EP | FIX | B2 |
| `orphan-bindings` | - | RUN | B2 |
| `access` | - | RUN | B3 |
| `aliases` | E | FIX | B3 |
| `frontmatter` | ED | FIX | B3 |
| `ghost-pages` | EPD | FIX | B3 |
| `legacy-twins` | EPD | LIST | B3 |
| `origin-twins` | EPD | FIX | B3 |
| `orphan-children` | E | FIX | B3 |
| `provenance` | EPD | FIX | B3 |
| `rows-behind` | EP | FIX | B3 |
| `safe-chunks` | - | RUN | B3 |
| `segmented-tiling` | EP | FIX | B3 |
| `captured-facts` | E | FIX | B4 |
| `consolidate-ties` | EP | LIST | B4 |
| `duplicate-facts` | EPD | FIX | B4 |
| `extractor-facts` | E | FIX | B4 |
| `fact-claim-dates` | EPD | FIX | B4 |
| `facts-home` | EP | FIX | B4 |
| `facts-rehome` | EP | LIST | B4 |
| `ontology-facts` | E | FIX | B4 |
| `open-facts` | EPU | - | B4 |
| `purged-page-facts` | EPD | FIX | B4 |
| `rename-identity` | EPD | FIX | B4 |
| `unwithdrawn-facts` | EP | FIX | B4 |
| `url-clone-fences` | EPD | LIST | B4 |
| `visibility` | P | RUN | B4 |
| `agent-session-facts` | EPD | FIX | B5 |
| `connector-fences` | - | RUN | B5 |
| `conversation-labels` | ED | FIX | B5 |
| `take-supersession` | - | RUN | B5 |
| `timeline` | - | RUN | B5 |
| `timeline-comments` | E | LIST | B5 |
| `timeline-order` | EPD | LIST | B5 |
| `accepted-takes` | EP | LIST | B6 |
| `atoms-restore` | EP | FIX | B6 |
| `moved-pages` | EPD | FIX | B6 |
| `overwritten-edits` | EP | FIX | B6 |
| `private-labels` | EP | LIST | B6 |
| `purged-change-reasons` | EPD | LIST | B6 |
| `redacted-facts` | E | FIX | B6 |
| `secret-spans` | EP | LIST | B6 |
| `generations` | EPD | FIX | B7 |
| `lost-fence-rows` | EPD | LIST | B7 |
| `stale-atoms` | E | FIX | B7 |
| `atom-fence-rows` | EP | FIX | B8 |
| `attribution-backfill` | - | RUN | B8 |
| `contact-rows` | EPD | LIST | B8 |
| `embedding-effects` | - | RUN | B8 |
| `failed-writes` | E | FIX | B8 |
| `file-drift` | EPD | FIX | B8 |
| `receipt-compaction` | EPD | FIX | B8 |
| `request-indexes` | - | RUN | B8 |
| `segmented-mirror` | EPD | LIST | B8 |
| `split-facts` | E | LIST | B8 |
| `uncommitted-deletions` | EPD | FIX | B8 |
| `fences` | PL | RUN | B9 |
| `missing-tables` | EP | FIX | B9 |
| `planner-stats` | A | RUN | B9 |
| `slug-conflicts` | PL | RUN | B9 |

### Applies moved to a later batch

These B3 kinds preview on Rust in B3, with the same output as PGLite and Postgres; their apply stays
a typed refusal until the batch that owns the writer serves it. No batch adds a second writer.

- `segmented-tiling` (segmented-body publish) -> B6
- `safe-chunks` (chunk reseal) -> B6
- `rows-behind` (git-gap history) -> B6
- `provenance` (trust restore and drift reads) -> B4
- `origin-twins` (the private-label carry before an origin row goes, `repair/origin-carry.ts`) -> B4
