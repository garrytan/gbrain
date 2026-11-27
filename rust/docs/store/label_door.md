# The brain store: the label door

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`delete_page` carries a private origin's privacy to the pages derived from it (src/core/repair/origin-carry.ts), and
the label door writes `visibility: private` onto those pages (src/core/repair/label-write.ts and
src/core/trust/page-write.ts). PGLite and Postgres ran these reads through `executeRaw`. The SQL now lives in
`src/core/engine-sql/label-door.ts`. The store answers from its page, link, alias, rename and source records
(`crates/gbrain-store/src/label_door.rs`). The one new key is the label guard, `t 0x0e page_id`
([trust.md](trust.md) "Label guards").

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPrivacyOrigin(sourceId, slug, honorAliases)` | `{ id, deleted }` of the page (live or soft-deleted) when it is an atom or the privacy rules hide it; `null` otherwise | `SELECT id, deleted_at IS NOT NULL … WHERE (type = 'atom' OR NOT privacyPartSql('p'))` |
| `brain.listOriginDependents(origins, honorAliases)` | `[{ id, cleared_id, source_id, slug, deleted }]`: each same-source page the privacy rules hide now and would not once the origin rows are gone, with the origin it is tied to, by (id, cleared_id) | private-labels.ts `dependentsSql('remove')` |
| `brain.listCheckoutFiles(pageIds)` | `[{ id, source_id, source_path, local_path }]`: each listed page with a recorded file, with its source's checkout (`null` when the source has none), by id, once each; an unknown id answers nothing | `SELECT p.id, … FROM pages p JOIN sources s … WHERE p.id = ANY($1)` |
| `brain.readPageLabelRow(sourceId, slug)` | `{ id, frontmatter }` of the page (live or soft-deleted); `null` for a missing page | `SELECT id, frontmatter FROM pages WHERE source_id = $1 AND slug = $2` |
| `brain.readLabelGuardTiers(pageId)` | `{ owner_set, priors }`: the page's label guard tier (or null), and the `before_state->>'prior_tier'` of every `lower_page` proposal targeting the page that is not `accepted` and is newer than its last accepted one whose `after_state->>'resolution'` is not `labels_applied`, ascending by id (the SQL's `ARRAY(...)` sets no order; the caller takes the highest). An unknown page answers `{ owner_set: null, priors: [] }` | `readLabelGuardTiers` |
| `brain.writePageLabelGuard(pageId, tier)` | `undefined`. A tier sets the guard, stamped now; `null` deletes it. An unknown page refuses `constraint_violation`, as the foreign key does | `INSERT … ON CONFLICT (page_id) DO UPDATE` / `DELETE FROM page_label_guards WHERE page_id = $1` |

The privacy rules are `facts/privacy.rs` `privacy_allows`, the store's form of `privacyPartSql`. The SQL dependents
query finds the pages that can name a cleared page through a jsonpath probe and keeps only exact references. So a
full read of the cleared sources' pages returns the same rows. The query's postimage (the pages table without the
cleared rows, and so without the links to them) is the `Without` read, which hides the cleared pages' keys.

## TypeScript members

`src/core/rust-engine/store-members/label-door.ts` answers the five BrainEngine members on a Rust brain.

- `honorAliases` is read off the rendered snapshot filter (`privateSnapshotFilterFragment('h')` includes
  `privacyAliasSql('h')`). That is the one process setting `privacyPartSql` reads, so both engines judge by the same
  setting.
- The origins of `listOriginDependents` map to `{ id, sourceId, slug }` (the store refuses unknown fields).

## The purge's origin parks and owed-purge records

The derived-origin purge (`repair/origin-carry.ts` `parkUncarriedInPurge`, `persistence/derived-origin-hold.ts`) parks an
origin it cannot carry and records an owner's purge that is owed. Four more BrainEngine members carry those statements
(`src/core/engine-sql/origin-holds.ts`); the store serves them from `persistence/origin_holds.rs` over the page records and
the `op_checkpoints` parents of `persistence/op_checkpoint.rs`.

- `listPurgeOrigins(ids, recheckParked)`: the pages among `ids` that are origins (`is_origin`, the same rule as
  `readPrivacyOrigin`), by id. Unless `recheckParked`, a page whose park row (op `derived-origin-park`, fingerprint the page
  id) exists is left out. The TypeScript member passes `honorAliases`, as the label door members do.
- `upsertDerivedOriginPark(pageId, park)`: stores `[park]` as the park row, stamped now. A park that held an owner's purge
  (`held_request_id`) keeps it and `held_deleted_us` when the new document has no `held_request_id`; a null field of the old
  one is dropped (`jsonb_strip_nulls`). The document's keys are stored in jsonb order.
- `recordOwedPurgeRows(pageId, requestId)`: answers `{ owed, held }`. The owed record (op `owed-page-purge`) is written only
  for a tombstone and only when the stored `deleted_us` differs from the page's (`deleted_at` in microseconds, as text); the
  park that holds `requestId` gets `held_deleted_us` set to the same text.
- `deleteOriginHoldRows(op, pageIds)`: removes the rows of op `derived-origin-park` or `owed-page-purge` for the pages and
  answers how many existed; any other op is refused, so the member cannot clear another op's checkpoints.

All four run on the store handle the caller holds, so inside a purge transaction they are part of it. They read the
alias-honoring setting and write nothing outside `op_checkpoints`. The reads and prunes of the same rows are below.

## The retention purge's bookkeeping

The retention purge (`persistence/purge-deleted.ts` `purgeDeletedPagesCoordinated`) releases stale holds, lists and prunes
the owed-purge records and parks, keeps the managed purge's failure records (op `purge-deleted-park`, keyed by
`[source, slug, deleted_us]`), selects its candidates and reads the origins the carry judges. Twelve BrainEngine members
carry those statements (`src/core/engine-sql/retention-purge.ts`); the store serves them from `persistence/retention_purge.rs`
over the page records and the `op_checkpoints` parents. `deleted_us` is the tombstone's `deleted_at` in microseconds as
text, and a page-keyed record joins its page only when its fingerprint is the page id's text exactly.

- `releaseStaleOriginParkHolds(op)`: a park whose page exists and whose document has `held_deleted_us` loses
  `held_request_id` and `held_deleted_us`, stamped now, when the page is live or its `deleted_us` differs. A JSON null
  `held_deleted_us` is released only by a live page (`<> NULL` is not true).
- `listOwedPurgeRecords(op)`: `{ owed }` for each record whose page is a tombstone with the recorded `deleted_us`, by
  fingerprint. `pruneOwedPurgeRecords(op)` removes the others.
- `pruneOriginParkRecords(op)`: removes the parks whose page is not a tombstone.
- `prunePurgeParkRecords(op)`: removes the failure records whose page (`source_id`, `slug`) is not a tombstone with the
  recorded `deleted_us`.
- `recordPurgeFailureRecord(row)`: the first failure stores `first` parsed as `::jsonb` (text jsonb refuses, refuses here);
  a repeat merges `failures + 1`, `code`, `reason`, `failed_at` and `version` into the document (a `failures` the int cast
  refuses, refuses here). Both stamp now. `deletePurgeParkRecord(op, key)` removes one record.
- `markPurgeParksInactive(op, sourceId)`: each record of the source without `inactive_seen` gets `inactive_seen: true`; the
  stamp stays, as the statement sets no `updated_at`. `dropRearmedPurgeParks(op, sourceId)` removes the source's records
  whose `inactive_seen` reads `true` and answers how many.
- `listManagedPurgeCandidates(hours, release, hold)`: the tombstones deleted before now minus `hours` whose source exists
  and is not archived, under the identity-downgrade hold (an open record: no `disposition`, `old_deleted_at` the page's
  `deleted_at`; text the timestamptz cast refuses, refuses here), the atom and derived retirement holds (`PurgeHolds`,
  page_ops.md) and the origin park unless the id is in `release`, minus `hold`. Ordered by `deleted_at`, then source and slug
  in byte order; `cutoff` is the cutoff as `timestamptz::text` in UTC.
- `listReleasedPurgeOrigins(release, excludeIds, hours)`: the tombstones among `release`, minus `excludeIds`, deleted before
  the cutoff, under the identity-downgrade and retirement holds, by id (the statement has no order; the caller sorts).
  `deleted_at` is ISO text; the TypeScript member hands it back as a Date, as the SQL engines do.
- `listExpiringOriginPages(hours)`: the tombstones deleted before the cutoff that are origins (`is_origin`), by id. The
  TypeScript member passes `honorAliases`.

An hour count is text, as the statements bind it; text that is not a finite number refuses, as the interval cast does.
The unmanaged expiry's own reads (`purgeExpired` and `readRederiveHeldConcepts` in `persistence/purge-deleted.ts`) still
run through `executeRaw`, so the retention purge on a Rust brain stops at the pre-write check before it writes anything
(`persistence/purge-path-members.ts`).

## What still refuses

- `delete_page --purge` parks and purges through raw SQL (repair/origin-carry.ts, persistence/page-purge.ts). On the
  Rust engine it refuses `engine_capability_missing` (`raw_sql`) before any write, and the page stays live.
- The label guard's readers (`labelGuardTier`, the deletion and graduation inventories) read through `executeRaw`.
