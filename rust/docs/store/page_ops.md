# The brain store: Page operations

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.
These methods work on the pages of [Pages](pages.md) and add no keys of their own (family tag `p`).

Every date is an ISO string with microseconds (`2026-08-10T12:00:00.000123Z`) or `null`; the
TypeScript members turn them into `Date` where PGLite returns one. Text sorts in byte order.
There are no secondary indexes yet: each method scans the pages of its scope.

A read scope (`PageReadScope`) is `{ sourceId?, sourceIds?, live?, excludePrivate? }`. A non-empty `sourceIds`
wins over a non-empty `sourceId`; with neither, every source. `live: true` also hides deleted pages,
pages whose frontmatter has a `quarantine` key and pages of a missing or archived source. The
TypeScript members send `live: true` whenever the caller passes a scope object, and refuse
`engine_capability_missing` for a truthy `minTrust` or `suppressFlagged`.

`excludePrivate` is the page policy `pageReadFilter` adds, as `facts/privacy.rs` `page_hidden` reads it
(`{ honorAliases, entityPrivacy }`, as `resolveAliases` takes it): a page the policy hides is not read. The
TypeScript members `getContentFlagsByPageIds`, `getUnverifiedExtractionPageIds` and `getEffectiveDates` send it
from a truthy `excludePrivate` through `storePagePolicy`, which refuses a caller whose policy is wider than the
store's. They also accept and ignore the other keys of hybrid search's option bag (its settings, callbacks and
`takesHoldersAllowList`), because hybrid search hands them that whole bag as their policy; any other key still
refuses.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageSnapshotsBatch(refs, { maxBytes?, includeDeleted? }?)` | `{ snapshots, covered }`. `snapshots[i]` is `readPageSnapshot` of ref `i` or `null`; `covered` counts the refs whose prior refs' `compiled_truth` + `timeline` bytes stay within `maxBytes` (the first ref always counts) | `readPageSnapshotsBatch` |
| `brain.findDuplicatePage(sourceId, { hash, frontmatterId?, excludeSlug? })` | `{ id, slug, content_hash }` or `null`: a live page with frontmatter `id` equal to `frontmatterId`, else one with `content_hash` equal to `hash`; lowest id wins | `findDuplicatePage` |
| `brain.findDuplicatePages(sourceId, queries)` | one `findDuplicatePage` answer per query | `findDuplicatePages` |
| `brain.softDeletePages(slugs, { sourceId? }?)` | slugs that turned deleted now, once each, in page id order. `updated_at` stays; the knowledge revision changes | `softDeletePages` |
| `brain.deletePages(slugs, { sourceId? }?)` | slugs removed (live or deleted), in page id order. In the same transaction it drops those slugs from captured eval candidates of the source (`eval_capture::remove_retrieved_slugs`) | `deletePages` |
| `brain.purgeDeletedPages(olderThanHours, { dryRun?, excludeIds? }?)` | `{ slugs, count }` of pages deleted more than `olderThanHours` (negative counts as 0) ago, plus `pages: [{ slug, source_id, deleted_at }]` on a dry run | `purgeDeletedPages` (the TypeScript member still refuses, see below) |
| `brain.resolveSlugsByPaths(paths, { sourceId })` | `[{ slug, source_path, live }]` for every page of the source whose `source_path` is one of `paths`, sorted by path then slug; the TypeScript member keeps one slug per path (`pickCanonicalOrigin`) | `resolveSlugsByPaths` |
| `brain.findPages({ pattern: { kind, like }, types?, limit, sourceId?, sourceIds?, excludeSlugPrefixes? })` | `{ rows, total }`. `like` is a Postgres `LIKE` pattern (`%`, `_`, `\` escape), case-folded. A `name` pattern matches the title, or the slug when its last segment matches too; `prefix` and `glob` match the slug or `source_path`. Live pages of unarchived sources only. Rows sort by slug, then source; `total` is every match, or 0 when no row is returned | `findPages` |
| `brain.countPagesBy({ sourceId?, sourceIds?, since?, typeGroups? }?)` | `{ bySourceType, byTypeGroup, total }` over visible pages (live, source present and not archived) whose effective date (else `updated_at`) is at or after `since`, an ISO date or instant. `typeGroups` maps a type to its group; with it, only mapped types count in `byTypeGroup` and `total` | `countPagesBy` |
| `brain.getAllSlugs({ sourceId? }?)` | every slug, deleted pages included, sorted and distinct; `''` means every source | `getAllSlugs` |
| `brain.listAllPageRefs()` | `[{ source_id, slug, updated_at }]` of live pages, by source then slug | `listAllPageRefs` |
| `brain.listPrefixSampledPages({ prefixes, excludeSlugs?, staleBias?, staleThresholdDays?, sourceId?, sourceIds? })` | one domain-bank row per prefix: the live page under it with the most inbound links, then the lowest slug | `listPrefixSampledPages` |
| `brain.listCorpusSample({ n, excludeSlugs?, seed?, sourceId?, sourceIds? })` | up to `n` domain-bank rows of live pages, in a shuffle fixed by `seed` | `listCorpusSample` |
| `brain.getContentFlagsByPageIds(ids, scope?)` | `[{ id, reason, detail }]` of pages whose frontmatter `content_flag.reason` is a non-empty string | `getContentFlagsByPageIds` |
| `brain.getUnverifiedExtractionPageIds(ids, scope?)` | `[{ id, status, unverified }]` of pages with a frontmatter `status`; `unverified` is `status = 'unverified'` and `provenance = 'auto-extracted'` | `getUnverifiedExtractionPageIds` |
| `brain.getPageTimestamps(slugs)` | `[{ slug, ts }]` (`ts` = `updated_at`) of every page with that slug, deleted included, in page id order | `getPageTimestamps` |
| `brain.getEffectiveDates(refs, scope?)` | `[{ source_id, slug, ts }]` (`ts` = `effective_date`, else `updated_at`) for each ref that names a page | `getEffectiveDates` |
| `brain.revertToVersion(slug, versionId, { sourceId? }?)` | `null`. Copies the version's `compiled_truth`, `frontmatter` and `timeline` onto the page and sets `updated_at`; a missing page or version does nothing | `revertToVersion` |

A domain-bank row is `{ slug, prefix, connection_count, representative_chunk_id,
last_retrieved_at }`.

## Differences from Postgres

- `representative_chunk_id` and `last_retrieved_at` are always `null`: the store keeps no
  retrieval log yet, so `staleBias` ranks every page the same.
- `listCorpusSample` uses a SplitMix64 shuffle seeded from `seed`. A seed gives a fixed pick, but not
  the pick Postgres `setseed()` + `random()` gives. The parity cases compare the set, not the order.
- `countPagesBy` refuses a `since` that is not an ISO date or instant (Postgres also takes other
  `timestamptz` text).
- `revertToVersion` writes no new version, as PGLite. The interface spec says it snapshots first.
- After a hard delete PGLite also scrubs retrieval logs, ratings, weights, the volunteer log, the
  gazetteer and write-gate holds. The store keeps none of those yet, so only eval candidates change.

## Still refused by the TypeScript engine

- `purgeDeletedPages`: PGLite holds back pages that sync identity, atom retirement or derived
  retirement still need. The store does not keep those holds yet, so the member refuses.
