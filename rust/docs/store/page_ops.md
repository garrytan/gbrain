# The brain store: Page operations

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.
These methods work on the pages of [Pages](pages.md) and add no keys of their own (family tag `p`).

Every date is an ISO string with microseconds (`2026-08-10T12:00:00.000123Z`) or `null`; the
TypeScript members turn them into `Date` where PGLite returns one. Text sorts in byte order.
There are no secondary indexes yet: each method scans the pages of its scope.

The `pages` capability stays unreported while `replaceDerivedAliases`, `getPageSealState`, `refreshPageOrigin`,
`listEntityKeyRows`, `listIdentityDecisions`, `listRestrictedIdentityMembers` and `applyIdentityDecisions` refuse.

A read scope (`PageReadScope`) is `{ sourceId?, sourceIds?, live?, excludePrivate? }`. A non-empty `sourceIds`
wins over a non-empty `sourceId`; with neither, every source. `live: true` also hides deleted pages,
pages whose frontmatter has a `quarantine` key and pages of a missing or archived source. The
TypeScript members send `live: true` whenever the caller passes a scope object, and refuse
`engine_capability_missing` for a truthy `minTrust` or `suppressFlagged`.

`excludePrivate` is the page policy `pageReadFilter` adds, as `facts/privacy.rs` `page_hidden` reads it
(`{ honorAliases, entityPrivacy, ownerOnly }`, as `resolveAliases` takes it): a page the policy hides is not read,
an owner-only page (a page of an owner-only source, or under the closed form any page of a brain that holds one) included. The
TypeScript members `getContentFlagsByPageIds`, `getUnverifiedExtractionPageIds` and `getEffectiveDates` send it
from a truthy `excludePrivate` through `storePagePolicy`, which refuses a caller whose policy is wider than the
store's. They also accept and ignore the other keys of hybrid search's option bag (its settings, callbacks and
`takesHoldersAllowList`), because hybrid search hands them that whole bag as their policy; any other key still
refuses.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageSnapshotsBatch(refs, { maxBytes?, includeDeleted? }?)` | `{ snapshots, covered }`. `snapshots[i]` is `readPageSnapshot` of ref `i` or `null`; `covered` counts the refs whose prior refs' `compiled_truth` + `timeline` bytes stay within `maxBytes` (the first ref always counts). A segmented page (NULL body) comes back with `compiled_truth` and `timeline` `null` and counts as 0 bytes; the TypeScript member decodes it with `toGetPage`, so reading its body throws `page_body_segmented` | `readPageSnapshotsBatch` |
| `brain.findDuplicatePage(sourceId, { hash, frontmatterId?, excludeSlug? })` | `{ id, slug, content_hash }` or `null`: a live page with frontmatter `id` equal to `frontmatterId`, else one with `content_hash` equal to `hash`; lowest id wins | `findDuplicatePage` |
| `brain.findDuplicatePages(sourceId, queries)` | one `findDuplicatePage` answer per query | `findDuplicatePages` |
| `brain.softDeletePages(slugs, { sourceId? }?)` | slugs that turned deleted now, once each, in page id order. `updated_at` stays; the knowledge revision changes | `softDeletePages` |
| `brain.deletePages(slugs, { sourceId? }?)` | slugs removed (live or deleted), in page id order. In the same transaction it drops those slugs from captured eval candidates of the source (`eval_capture::remove_retrieved_slugs`), then their page aliases, the slug aliases that resolve to them and the rename history rows that end at them (`aliases::scrub_purged_slug_stores`, the `scrubPurgedSlugStores` order of `src/core/persistence/purge-slug-stores.ts:6`) | `deletePages` |
| `brain.purgeDeletedPages(olderThanHours, { dryRun?, excludeIds? }?)` | `{ slugs, count }` of pages deleted more than `olderThanHours` (negative counts as 0) ago, plus `pages: [{ slug, source_id, deleted_at }]` (dry run and real run alike) | `purgeDeletedPages` (minus the pages a hold keeps, see below) |
| `brain.resolveSlugsByPaths(paths, { sourceId })` | `[{ slug, source_path, live }]` for every page of the source whose `source_path` is one of `paths`, sorted by path then slug; the TypeScript member keeps one slug per path (`pickCanonicalOrigin`) | `resolveSlugsByPaths` |
| `brain.findPages({ pattern: { kind, like }, types?, limit, sourceId?, sourceIds?, excludeSlugPrefixes? })` | `{ rows, total }`. `like` is a Postgres `LIKE` pattern (`%`, `_`, `\` escape), case-folded. A `name` pattern matches the title, or the slug when its last segment matches too; `prefix` and `glob` match the slug or `source_path`. Live pages of unarchived sources only. Rows sort by slug, then source; `total` is every match, or 0 when no row is returned | `findPages` |
| `brain.countPagesBy({ sourceId?, sourceIds?, since?, typeGroups? }?)` | `{ bySourceType, byTypeGroup, total }` over visible pages (live, source present and not archived) whose effective date (else `updated_at`) is at or after `since`, an ISO date or instant. `typeGroups` maps a type to its group; with it, only mapped types count in `byTypeGroup` and `total` | `countPagesBy` |
| `brain.getAllSlugs({ sourceId? }?)` | every slug, deleted pages included, sorted and distinct; `''` means every source | `getAllSlugs` |
| `brain.listAllPageRefs()` | `[{ source_id, slug, updated_at }]` of live pages, by source then slug | `listAllPageRefs` |
| `brain.listPrefixSampledPages({ prefixes, excludeSlugs?, staleBias?, staleThresholdDays?, sourceId?, sourceIds? })` | one domain-bank row per prefix: the live inline page under it (segmented pages are left out) with the most inbound links, then the lowest slug | `listPrefixSampledPages` |
| `brain.listCorpusSample({ n, excludeSlugs?, seed?, sourceId?, sourceIds? })` | up to `n` domain-bank rows of live inline pages (segmented pages are left out), in a shuffle fixed by `seed` | `listCorpusSample` |
| `brain.getContentFlagsByPageIds(ids, scope?)` | `[{ id, reason, detail }]` of pages whose frontmatter `content_flag.reason` is a non-empty string | `getContentFlagsByPageIds` |
| `brain.getUnverifiedExtractionPageIds(ids, scope?)` | `[{ id, status, unverified }]` of pages with a frontmatter `status`; `unverified` is `status = 'unverified'` and `provenance = 'auto-extracted'` | `getUnverifiedExtractionPageIds` |
| `brain.getPageTimestamps(slugs)` | `[{ slug, ts }]` (`ts` = `updated_at`) of every page with that slug, deleted included, in page id order | `getPageTimestamps` |
| `brain.getEffectiveDates(refs, scope?)` | `[{ source_id, slug, ts }]` (`ts` = `effective_date`, else `updated_at`) for each ref that names a page | `getEffectiveDates` |
| `brain.revertToVersion(slug, versionId, { sourceId? }?)` | `null`. Copies the version's `compiled_truth` and `frontmatter` onto the page and sets `updated_at`; a missing page or version does nothing. When a page it would revert, or the version, is segmented, it refuses `page_body_segmented` and writes nothing; the TypeScript member throws PGLite's `segmentedRevertRefusal` | `revertToVersion` |

A domain-bank row is `{ slug, prefix, connection_count, representative_chunk_id,
last_retrieved_at }`. `representative_chunk_id` is the page's embedded chunk with the lowest `chunk_index`, or
`null` when no chunk of the page has an embedding, as `src/core/engine-sql/pages.ts` picks it.

## Differences from Postgres

- `last_retrieved_at` is always `null`: the store keeps no retrieval log yet, so `staleBias` ranks
  every page the same.
- `listCorpusSample` uses a SplitMix64 shuffle seeded from `seed`. A seed gives a fixed pick, but not
  the pick Postgres `setseed()` + `random()` gives. The parity cases compare the set, not the order.
- `countPagesBy` refuses a `since` that is not an ISO date or instant (Postgres also takes other
  `timestamptz` text).
- `revertToVersion` writes no new version, as PGLite. The interface spec says it snapshots first.
- After a hard delete PGLite also scrubs retrieval logs, ratings, weights, the volunteer log, the
  gazetteer, take proposals, open loops, core-edit notices and write-gate holds. The store keeps none
  of those yet, so only eval candidates, page aliases, slug aliases and rename history change.

## The purgeDeletedPages holds

PGLite's purge (`purgeDeletedPages`, `src/core/engine-sql/pages.ts:329`) skips a tombstone that one
of four holds keeps (`pages.ts:349-353` for the dry run, `:370-380` for the delete). The store
applies the two that read only the page row and `config`, and the other two never match a Rust row:

- Derived retirement (`derivedRetirementPurgeHold`,
  `src/core/persistence/derived-retirement-hold.ts:38-41`): the page's `retired_by` text is one of
  `DERIVED_RETIRED_BY` (`:19`: extract-atoms, managed-reextract, stale-atoms, life-chronicle,
  generation-restore, synthesis-resynthesis, synthesis-cleanup) and `deleted_at > now - restore
  days`. The restore days are `RESTORE_DAYS_SQL` (`src/core/generations/config.ts:59`, bounds at
  `:12`): the `generations.restore_days` config value when it is 1 to 3 ASCII digits naming 3 to
  365, else 30.
- Atom retirement (`atomRetirementPurgeHold`, `src/core/persistence/atom-retirement-hold.ts:80-84`):
  the page is an `atom` stamped `retired_by: managed-reextract` (`:25`), `deleted_at > now - 30
  days` (`ATOM_RESTORE_HOLD_DAYS`, `:28`), and it is restorable by `atomRetirementsSql`
  (`:41-69`). Restorable means: the atom is deleted and not imported (`imported_from` empty, `:33`);
  it has an origin key, `slug:<source_slug>` or else `path:<source_path>` (`:31`); a `source_slug`
  origin is a live page of the same source; no live non-imported atom of the same source and
  origin has a different hash; and its hash is the hash of the origin's latest retirement
  (`retired_at` text descending with NULL last, then id descending). A hash is `source_hash` with
  one leading `pending:` removed (`:30`). Because `managed-reextract` is also a derived stamp, the
  atom hold only matters once the restore days have passed and the 30 days have not.
- Both windows are open while `deleted_at` is strictly after `now` minus the days. PGLite runs in
  `Etc/GMT0`, so a day is 24 hours. Text compares in byte order.
- Sync identity downgrade (`op_checkpoints`, op `sync-identity-downgrade`, `pages.ts:349`) and
  derived origin park (`derivedOriginPurgeHold`, `src/core/persistence/derived-origin-hold.ts:31`)
  never match: only `executeRaw` writes those rows, through `recordIdentityDowngrades`
  (`src/core/sync-identity-downgrades.ts`) and `parkDerivedOrigin` (`derived-origin-hold.ts`,
  called from `src/core/repair/origin-carry.ts`), and the Rust engine refuses `executeRaw`. The
  family that serves `op_checkpoints` must add both holds.

Each purged page goes through `remove_page`, the eval-candidate scrub and the alias and rename-history
scrub, as `deletePages` does.
Other differences:

- A real run returns its slugs ordered by `deleted_at`, then slug. PGLite returns them in the
  `DELETE ... RETURNING` order, which is the table's row order, so the parity cases compare a real
  run's slugs sorted. A dry run orders by `deleted_at`, then slug, on both.
- The purge expires the facts of the purged pages in the same write, as PGLite's
  `expireGonePageFacts` (`src/core/facts/gone-page-facts.ts`) does: filed facts, the slot facts of a
  filed conversation (dimension, value and status cleared), facts extracted from the page and facts
  about the page whose entity no longer has a page. `deletePages` does not expire facts, on either
  engine.
- The purge also deletes the body stagings at each purged source and slug, and then each segment text
  the purged pages named that no manifest row or live staging still needs, in the same write, as
  PGLite does (see [page_body.md](page_body.md)).
- The parity cases cannot stand a tombstone days in the past (the Rust arm reads the system clock),
  so every stamped page there is inside its window. The store unit tests in
  `crates/gbrain-store/src/page_ops.rs` set `deleted_at` directly and cover the windows closing,
  the restore-days fallback and each restorable rule. A one-off script ran the same scenarios
  on PGLite with `deleted_at` moved back by SQL and got the same answers.
