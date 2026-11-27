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
| `listOrphanBindings({ limit })` | writer bindings whose source is gone or whose incarnation changed, with their pending requests | `[]`: no binding outlives its source, because `deleteSourceRecord` removes the binding of the deleted incarnation in the same write and only a delete makes a new incarnation |
| `deleteOrphanBinding(binding)` | deletes the binding when it is still an orphan | `false`: no binding is an orphan |
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

The plans of `gbrain repair safe-chunks`, `gbrain repair origin-twins`, `gbrain repair ghost-pages` and
`gbrain repair legacy-twins` read pages
(`src/core/engine-sql/repair-page-scans.ts`). The store scans every page record and filters it as
the SQL's `WHERE` does (`repair_scans.rs`); it does not use the origin index, which leaves out an
empty `source_path` that SQL's `IS NOT NULL` keeps.

| Member | Store answer |
| --- | --- |
| `listSafeChunksPending(sourceIds)` | live pages whose `chunker_version` is below the safe fence version (a missing version is not), or that are not segmented and carry a credential re-chunk hold (`op_checkpoints` `credential-reseal-hold`, keyed by page id, naming the page's revision and the caller's producer while the text projection lags); `rebuildable` for markdown, or code naming `frontmatter.file` or a `source_path`; by id |
| `listOriginTwinGroups(sourceId, limit)` | live paths two or more pages record, in byte order, as the SQL's `COLLATE "C"` |
| `listLegacyOriginPairs(sourceId, prefix, limit)` | each live page whose path is `prefix` plus another live page's path, by the legacy id then the other's (the SQL now orders under its `LIMIT`) |
| `listLiveOriginPages(sourceId, paths)` | live pages recording any of `paths`, by id |
| `countLiveFileBackedPages(sourceId, { nonBlank? })` | live pages recording a `source_path`; with `nonBlank`, one that is not empty after trimming spaces |
| `listRepairScanPages(sourceId, q)` | the page rows the ghost-pages and legacy-twins scans read, by id: `{ afterId, limit }` live pages after an id, `legacy: true` only those with a blank origin and no `database_only_reason`; `{ slugs }` live pages at the slugs with a non-blank origin; `{ ids }` pages in any state, with `deleted` set. Each row carries the revision, content hash, origin, the revision's write request id and `updated_ms` |
| `listTwinMergeLosers(survivorId, twinId)` | what merging the twin into the survivor would land on: each moving link and link transition (an endpoint or origin on the twin, not an edge between the two) whose key, with the twin mapped to the survivor, another row already holds (a moving row only when its id is lower), with whether every such row says the same thing; each twin timeline entry whose date, summary and source the survivor holds with another detail; each twin raw-data source the survivor holds with other data. Ids ascend; raw sources sort in byte order |
| `listFileTombstones(sourceId, { before, limit })` | the tombstones `gbrain repair uncommitted-deletions` reads: soft-deleted pages recording a `source_path` that is not empty after trimming spaces, below page id `before` (all when null), by id descending, at most `limit`. `deleted_at` is ISO 8601 cut to milliseconds, as the SQL engines' `Date` is. `by_sync` is the SQL's `syncDeleteOrigin`: the page's `sync-delete-tombstone` record names its current `deleted_at` (a record time that does not parse is refused, as the SQL's cast refuses it), or a committed, uncompacted `managed_sync_delete` receipt of the same page and slug completed at or after it |

### Repair fence scans

The contact-rows, split-facts and atom-fence-rows plans read their pages through four members
(`src/core/engine-sql/repair-fence-scans.ts`). The store scans its page records and body manifests
as the SQL filters its rows (`repair_fence_scans.rs`).

| Member | Store answer |
| --- | --- |
| `listContactRowPages(sourceIds, q)` | live inline pages after `q.afterId` whose frontmatter `contacts` array holds two or more rows, among `q.slugs` when not empty; by id, at most `q.limit` (at least one) |
| `listSplitFactsPages(sourceIds)` | `inline`: live pages whose compiled truth and timeline each hold a facts fence opener; `segmented`: live segmented pages whose current manifest rows (no `gen_to`, no staging id) for the truth and the timeline each protect a `facts` region. Both by id |
| `listAtomFenceCandidates(sourceIds, q)` | live world atoms (frontmatter `visibility` `world`) after `q.afterId`, or only atom `q.atomId`, whose `source_slug` names a live page of the same source with a facts or takes fence opener or no compiled truth; by id, at most `q.limit`. `text` joins the title, the compiled truth and the frontmatter `source_quote` with a newline, as the SQL's `concat_ws(E'\\n', …)`; `revision` is the knowledge revision in lower case. `timeoutMs` changes nothing |
| `listPageTruths(ids)` | `[{ id, body }]` for each page with one of the ids, in any state; `body` is the compiled truth, null for a segmented page |

A segmented page has no compiled truth on any engine, so an atom whose source page is segmented
counts as `origin_unread` everywhere.

On Rust, the origin-twins plan reads the source's owner binding, then groups live pages by origin. The store
refuses a second live page per exact origin (`pages_live_origin_key` is always present), so a group on Rust is a
pair of spellings of one file (case, or a legacy scope prefix). The kind previews and applies in both modes. Merge
mode runs the twin merge (`mergeTwinInto`) on the engine's transaction: every statement is a typed member, the four
fact rekey members (`listRekeyLosers`, `repointSupersededToKept`, `clearOntologySlots`, `deleteRekeyLosers`, which
`dropRekeyDuplicates` calls between the page-children move and the fact move, `store-members/ontology-repair.ts`)
among them. The verdict reads each claimant through `listOriginClaimants` (below) and the pair's revisions through
`listRepairScanPages`; `droppedFrontmatter` reads both pages' frontmatter with `getPage`
(`test/engine-parity/repair-twin-merge.test.ts`, equal on all 3 engines). The merge's moves are all served:

| JS member | Store fn (`repair_twin_merge.rs`) | Mirrors |
| --- | --- | --- |
| `movePageVersions(fromPageId, toPageId)` | `move_page_versions` (`repair_versions.rs`) | each version re-keyed under the survivor; a missing survivor refused as the foreign key does; the ids in id order |
| `moveTwinRelationships({ twinId, survivorId })` | `move_twin_relationships` | the twin's link and transition keys, the colliding rows dropped (the `listTwinMergeLosers` link and transition losers), the rest re-pointed `from`, `to` and `origin` onto the survivor except the rows between the pair, then the survivor's keys. Links go through `delete_link` / `put_link` (the four link keys), transitions through `delete_transition` / `put_moved_transition` (their key holds the relationship). Keys come back in key order (links, then transitions), the moved link ids in id order |
| `moveTwinPageChildren({ twinId, survivorId, sourceId, twinSlug, survivorSlug })` | `move_twin_page_children` | in statement order: timeline rows and events (`timeline_queries/twin_move.rs`: repeats of the survivor's `(date, summary, source)` dropped, rows moved through `put_entry` so the stamps, the dedup key and the event index follow, repeated event dates dropped, the rest re-pointed at the survivor as event page, `G` recomputed), raw data of a source the survivor lacks (`move_raw_data`), the survivor's import-owned tag claimed `added` when the twin's was, files re-attached with the survivor's slug (`move_files`), page aliases the survivor does not repeat (`move_twin_page_aliases`; a repeated row stays on the twin, unlike the rename's move), then the `added` or unclaimed tags the survivor lacks, which advance both pages' revisions as the tag trigger does. The moved tags come back in the twin's tag order (Postgres' order is unspecified) |
| `moveTwinFacts(sourceId, twinSlug, survivorSlug)` | `move_twin_facts` | the source's facts about the twin slug that another page (or none) asserts take the survivor slug, each through `write_fact`; the ids in id order |
| `listOriginClaimants({ sourceId, ids, policy })` | `list_origin_claimants` (`repair_scans.rs`) | the verdict inputs of the live pages with these ids, by id: `md5(compiled_truth) \|\| md5(timeline)` (null for a segmented body), `frontmatter ->> 'id'`, the trust tier (`unknown` when unstamped), `private` (the no-caller page policy of `privatePagesFilterFragment('p')` keeps the page, judged by `page_hidden_with` from the policy flags the member sends, as `readLinkRelationshipEvidence` does), and `restricted` (a fact withdrawal, or a purge of either visibility, keyed to the slug) |
| `recordRenameAlias(sourceId, oldSlug, newSlug)` | `record_rename_alias` (`aliases.rs`) | the rename history and slug alias statements of `updateSlug`, for a caller that moved or merged the page itself; the same slug records nothing |

The twin and its survivor being one page refuses with `invalid_argument`; a page id that is not a page id
names no page; a survivor page that does not exist refuses as the foreign key does, with nothing written.
The history half of `recordRenameAlias` (`slug_rename_history`) has no typed read on the SQL engines, so the
parity case compares the alias half and the cargo test `record_rename_alias_records_the_history_and_aliases_without_moving_a_page`
pins the history. The cargo tests in `tests/repair_twin_merge.rs` pin the indexes the moves keep.
The safe-chunks apply re-seals chunks, a B6 writer. Pinned by
`test/engine-parity/repair-page-scans.test.ts` and the store tests
`scans_answer_what_the_sql_filters` and `repair_scan_pages_answer_each_query_shape`.

The ghost-pages and legacy-twins plans stop off the owner host until the worktree binding is
served. With a binding, ghost-pages previews and applies on Rust; legacy-twins finds its pairs and
then reads `twinMergeConflicts` (`persistence/twin-merge.ts`) and merges the pair on Rust like the SQL engines (`test/engine-parity/repair-owner-kinds.test.ts`).

## Repair plan scans

The plans of `gbrain repair frontmatter` and `gbrain repair segmented-tiling`, and every sync hold
reader, read through four members (`src/core/engine-sql/repair-plan-scans.ts`). The store scans its
page, manifest and checkpoint records and filters them as the SQL's `WHERE` does
(`repair_plan_scans.rs`).

| Member | Store answer |
| --- | --- |
| `listPagesByOriginPath(sourceId)` | live pages recording a `source_path`, with the first 400 characters of compiled truth (null when the page stores none inline), by slug in byte order |
| `countSegmentedOriginPages(sourceIds)` | live pages recording a `source_path` whose `body_storage` is `segmented` |
| `listSegmentedPageSlugs(sourceId)` | the slugs of the source's live pages whose `body_storage` is `segmented`, file-backed or not, in byte order (the `segmented-mirror` preview walk) |
| `listUntiledSegmentedPages({ sourceIds, slugs, limit })` | live segmented pages of unarchived sources whose live generation's published rows, by seq, leave a gap or do not sum to `body_bytes` (a NULL `body_bytes` counts only a gap), by source then slug, at most `limit` (default 1000) |
| `listSourceHoldRecords(op, { sourceIds, runId })` | the first record of each `op` checkpoint whose `source_id` and `incarnation` name an existing source's current incarnation, narrowed by source and `run_id`, by source then fingerprint in byte order; `mirror_read_only` is the source's `config.mirror_read_only` |

`readGitSourceHolds` marks a read-only mirror's records `read_only_checkout` over the listing, and
the provenance plan filters the listing to its pages' slugs and ids. The listing now sorts in byte
order on every engine (it used the database collation). No Rust write publishes a body whose rows
do not tile it, so on Rust the untiled list is empty and the segmented-tiling plan never reaches its
per-page file and stored-field reads. Pinned by `test/engine-parity/repair-plan-scans.test.ts` and
the store test `repair_plan_scans`, which builds the damage directly.

### Attribution backfill

The plan of `gbrain repair attribution-backfill` reads through two members
(`src/core/engine-sql/repair-plan-scans.ts`); the store answers from `repair_attribution.rs`.
For each table (`pages`, `page_versions`, `facts`) a row is unfilled when its attribution columns
are null; a committed request proves a row as the SQL phase does (a page operation that is not a
noop proves a page revision or a version's written receipt; a `remember` whose `inserted` or
`superseded` outcome names a fact id of 1 to 18 digits proves a fenced fact on the same page).

| Member | Store answer |
| --- | --- |
| `listProvenAttributionTargets(table, sourceIds)` | the unfilled rows of the scope's sources that exactly one committed request proves, by id |
| `countUnfilledAttribution(table, sourceIds)` | every unfilled row of the scope's sources |

The store has no query planner, so the repair does not set `enable_nestloop` on Rust. The apply
(`fillBatch`) stays raw SQL, so an apply with a proven row stops on `raw_sql`. An unknown table is
`invalid_argument`. Pinned by `test/engine-parity/persistence.test.ts` and the store test
`persistence` (`attribution_backfill_targets_the_rows_exactly_one_committed_request_proves`).

### Failed writes

The plan of `gbrain repair failed-writes` and its one-request replay read the journal through
`listFailedWriteRequests(sourceIds, { replayable, factsMovedMessages?, id? })`
(`src/core/engine-sql/repair-plan-scans.ts`); the store answers from `repair_failed_writes.rs`.
A row is a request of the scope's sources that is not compacted, still has its intent, and is a
guard refusal (`failed` with `writer_coordinator_required`, or a `storage_error` whose message
starts `Publication failed (P0001)`), a drift refusal (`conflict` with `source_changed`), or, when the caller
passes `factsMovedMessages`, an `extract_facts` revision conflict with one of those messages. The
caller passes its replayable operations and moved-fact messages, so the store keeps no copy of
them. Without an `id`, a moved-fact request that a later committed `extract_facts` of the same page
and input digest under another batch key recovered is dropped. `producer` is null for a replayable
caller write (a `put_page` with an intent `kind` is a producer write) and `operation[:kind]`
otherwise; `origin` is `error_detail.origin`. A bad `id` is `invalid_argument`. Rows are in
sequence order.

A seeded candidate still stops on `raw_sql` in the plan's later reads (the extraction,
disposition and replay walks). Pinned by `test/engine-parity/persistence.test.ts` and the store
test `persistence`
(`failed_writes_lists_guard_drift_and_moved_fact_refusals_less_the_recovered_ones`).

### Drift conflicts

The drift-conflict audit (`auditDriftConflicts` in `src/core/persistence/drift-conflicts.ts`, behind
`gbrain repair file-drift`'s survey, `gbrain sources reconcile --audit --conflicts` and MCP
`list_write_conflicts`) reads the journal through three members
(`src/core/engine-sql/repair-plan-scans.ts`); the store answers from `drift_conflicts.rs`.

- `readDriftConflictBounds(sourceId)` is `{ incarnation, top, bottom }`: the source's current
  incarnation and the newest and oldest request sequence of that incarnation (null with none), or
  null for an unknown source.
- `listDriftConflictGroups(sourceId, query)` is `{ slugs, receipts, rows }`. A receipt is a request
  of the source and `incarnation` with a sequence above `floor` through `through`, in state
  `conflict` with `source_changed`. `slugPrefixes` fences the lower-cased slug (a prefix ending `/`
  matches the slugs under it; any other matches the slug and the slugs under it).
  `requireLivePage` keeps receipts whose page is live; `excludePrivate` also applies the caller's
  remote read floor to that page, sent as a page policy (`storePageTextPolicy`, the caller's
  reader identity included; any other caller policy refuses). `slugs` and `receipts` count the
  whole window; `rows` are the groups of the slugs after `after`, at most `limit`, each with its
  receipts, the receipts whose message is `driftMessage`, the first and last `created_at` in whole
  UTC seconds, the distinct `operation[:kind]` producers and the request id of the highest
  sequence. A `floor` or `through` that is not an integer is `invalid_argument`.
- `readDriftConflictDetails(sourceId, slugs, { paths })` is `{ committed, recorded }`: each slug's
  newest committed request that keeps its intent and is not compacted (`request_id`,
  `completed_at`), and with `paths` each live page's `source_path` and `source_uri`.

The store sorts slugs and producers in byte order. The SQL sorts them in the database's default
collation, which is the same order for the lower-case ASCII slugs a source holds. The live file
check (`liveFileDrift`, the owner host with a binding) stays raw SQL. Pinned by
`test/engine-parity/persistence.test.ts`, the runner case in
`test/engine-parity/repair-runner.test.ts` and the store test `persistence`
(`drift_conflicts_group_source_changed_receipts_by_slug_inside_the_window`).

## Git holds

The Git sync hold rows and their summary counters belong to the hold store
(`src/core/engine-sql/sync-hold-store.ts`, served over the op checkpoint row members). One member
here is the retry request of `sources retry-held` (`src/core/engine-sql/git-holds.ts`); the store
applies it as one store write (`persistence/git_holds.rs`).

| Member | Store answer |
| --- | --- |
| `requestGitHoldRetry(sourceId, incarnation, paths, requestedAt)` | the retry request's `paths` as the union of its paths and `paths`, once each in byte order, stamped `requestedAt` |
| `recordSyncConversion(sourceId, incarnation, conversion)` | the source incarnation's conversion log (`sync-conversions`) with `conversion` first and the newest `SYNC_CONVERSION_KEEP` kept; the first write stores `{ source_id, incarnation, conversions }`, a later one keeps the record's other keys (SQL in `src/core/engine-sql/sync-hold-store.ts`, store write in `persistence/sync_conversions.rs`) |

Retry paths keep byte order on every engine (an update used the database collation), and
`requested_at` is the caller's ISO time. The conversion write applies the statement's jsonb `||`
to the stored record and writes it in jsonb key order, so the record reads back byte for byte as
on PGLite and Postgres; `converted_at` is the caller's ISO time. Pinned by
`test/engine-parity/git-holds.test.ts` and the store tests `git_holds` and `sync_conversions`.

## Repair busy set

`loadRepairBusySet` (`src/core/persistence/repair-busy.ts`) reads its rows through one member,
`readRepairBusyRows(sourceId, incarnation)` (`src/core/engine-sql/repair-busy.ts`), and each
cursor's frozen manifest through `readOpCheckpointRecord('managed-sync-manifest', runId)`. The
store answers from its request and checkpoint records (`repair_plan_scans.rs`):

| Rows | Store answer |
| --- | --- |
| `pending` | the source's requests that are queued, deferred, running or recovering, or carry a recovery, by sequence: slug, the intent's `path` and `sourcePath`, and `renameFrom`'s slug and source path |
| `cursors` | the `managed-sync` records of the source at `incarnation` whose `done` text is not `true`, by fingerprint in byte order: `runId` and `index` as `->>` text |
| `held` | only when a cursor is open: the `path` of each `sync-hold` record of the source at `incarnation`, by fingerprint in byte order |

The read fails closed, so before this member every candidate was busy on a Rust brain and a
frontmatter apply wrote nothing. Pending rows now keep sequence order and cursors and holds byte
order on every engine; the busy set is a set, so no output changes. Pinned by
`test/engine-parity/repair-busy.test.ts` and the store test `repair_plan_scans`.

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

## Repair page writes

The one-row page writes a repair apply runs are typed members (`src/core/engine-sql/write-guards.ts`;
the store table is in `write-guards.md`): `detachPageOrigin` (origin twins, file drift, twin merge),
`readPageDatabaseOnlyReason` (the origin-twin check of a page write), `bumpPageKnowledgeRevision`
(secret spans), `removePageFrontmatterKeys` (atom restore) and `setPageType` (file repair). The page
record keeps `database_only_reason`, which the store dropped before. Each apply still runs these
inside a maintenance transaction. A Rust brain serves `engine.transaction` (savepoints on a bound
clone, `src/core/rust-engine/store-members/transactions.ts`), and `maintenanceTransaction` runs on
it: the attribution falls back to the host principal when no writer is registered. Pinned by
`test/engine-parity/page-repair-writes.test.ts`.

## Kinds that need the owner host

`ghost-pages`, `legacy-twins` and `rows-behind` read the source's worktree binding first. With no
binding, the three engines give the same answer: the first two refuse `not_owner_host`, and
`rows-behind` previews no rows. The binding is a `persistence_journal` record, which a Rust brain
does not serve yet, so their owner-host path waits for the batch that serves it. Pinned by
`test/engine-parity/repair-owner-kinds.test.ts`.

### Where each owner-host apply stops on Rust

No apply stops inside `maintenanceTransaction`. Each one stops at an owner-host prerequisite or at
a raw read before its transaction opens. The table names the first typed refusal past the owner
gate (`engine_capability_missing` unless the table says otherwise).

| apply | first refusal | owner |
|---|---|---|
| `segmented-tiling` | `receiptsOf` raw read of `op_checkpoints`, `repair/segmented-tiling.ts:256` | B6 |
| `rows-behind` reimport | `owner_unavailable` in `managedRepairRoot`, `persistence/file-repair.ts:282` (no managed owner binding) | worktree binding, managed persistence |
| `rows-behind` hold | none: the hold is written in `engine.transaction` | served |
| `overwritten-edits` | raw read of `persistence_requests`, `repair/overwritten-edits.ts:147` | B6 |
| `file-drift` keep-deleted and reconcile | `authorizeReconcileGrant` raw read of `persistence_local_writers`, `persistence/reconcile.ts:58` | B8 |
| `moved-pages` | `movedPairNow` raw read of `pages`, `repair/moved-pages.ts:174` | B6 |
| `legacy-twins` | `pairNow` raw read of `pages`, `repair/legacy-twins.ts:303` | B8 |
| `ghost-pages` | `ghostFileBacked` raw read of `pages`, `repair/ghost-pages.ts:246` | B8 |
| `frontmatter` managed | `owner_unavailable` in `managedRepairRoot`, `persistence/file-repair.ts:282` | worktree binding, managed persistence |

Before any of these, a Rust brain has no worktree binding (`getWorktreeBinding` returns null), so
the owner-host gate refuses first: `claimWorktree` stops at `persistence/ownership.ts:113` and
`activateSharedSkillPersistence` at `persistence/skill-activation.ts:22`.

### Applies moved to a later batch

These B3 kinds preview on Rust in B3, with the same output as PGLite and Postgres; their apply stays
a typed refusal until the batch that owns the writer serves it. No batch adds a second writer.

- `segmented-tiling` (segmented-body publish) -> B6
- `safe-chunks` (chunk reseal) -> B6
- `rows-behind` (git-gap history) -> B6
- `provenance` (trust restore and drift reads) -> B4
- `origin-twins` (the private-label carry before an origin row goes, `repair/origin-carry.ts`) -> B4
