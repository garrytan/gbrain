# The brain store: Page operations

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.
These methods work on the pages of [Pages](pages.md). The one key they add is the retrieval record (family tag `p`, see
"Retrieval records" below).

Every date is an ISO string with microseconds (`2026-08-10T12:00:00.000123Z`) or `null`; the
TypeScript members turn them into `Date` where PGLite returns one. Text sorts in byte order.
There are no secondary indexes yet: each method scans the pages of its scope.

A read scope (`PageReadScope`) is `{ sourceId?, sourceIds?, live?, excludePrivate?, minTrust?, suppressFlagged? }`. A non-empty `sourceIds`
wins over a non-empty `sourceId`; with neither, every source. `live: true` also hides deleted pages,
pages whose frontmatter has a `quarantine` key and pages of a missing or archived source. The
TypeScript members send `live: true` whenever the caller passes a scope object. `excludePrivate` applies the page
policy of `facts/privacy.rs`, a caller's reader identity and private-readable grant included (`storePagePolicy`
with `callerReaders`; it refuses a caller whose policy the store does not model): the policy is
`{ honorAliases, entityPrivacy, ownerOnly }`, as `resolveAliases` takes it, and a page it hides is not read, an
owner-only page (a page of an owner-only source, or under the closed form any page of a brain that holds one) included.
The TypeScript members `getContentFlagsByPageIds`, `getUnverifiedExtractionPageIds` and `getEffectiveDates` also accept
and ignore the other keys of hybrid search's option bag (its settings, callbacks and `takesHoldersAllowList`), because
hybrid search hands them that whole bag as their policy; any other key still refuses.
`minTrust` (the page's stamped tier at or above the floor) and `suppressFlagged` (no instruction-family write-gate receipt on an agent-written-or-lower page) apply `pageEligibleSql` through `trust::TrustPolicy` (`trust/eligibility.rs`); an unknown tier name is `invalid_argument`. `requireSafeChunks` and `takesHoldersAllowList` are ignored, as these statements never read them. Hybrid search passes its whole option object as the scope; the members take only the `PageReadPolicy` keys from it, so a paging or ranking key (`limit`, `offset`, `detail`, `type`) only turns on the live filter, as on PGLite.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageSnapshotsBatch(refs, { maxBytes?, includeDeleted? }?)` | `{ snapshots, covered }`. `snapshots[i]` is `readPageSnapshot` of ref `i` or `null`; `covered` counts the refs whose prior refs' `compiled_truth` + `timeline` bytes stay within `maxBytes` (the first ref always counts). A segmented page (NULL body) comes back with `compiled_truth` and `timeline` `null` and counts as 0 bytes; the TypeScript member decodes it with `toGetPage`, so reading its body throws `page_body_segmented` | `readPageSnapshotsBatch` |
| `brain.findDuplicatePage(sourceId, { hash, frontmatterId?, excludeSlug? })` | `{ id, slug, content_hash }` or `null`: a live page with frontmatter `id` equal to `frontmatterId`, else one with `content_hash` equal to `hash`; lowest id wins | `findDuplicatePage` |
| `brain.findDuplicatePages(sourceId, queries)` | one `findDuplicatePage` answer per query | `findDuplicatePages` |
| `brain.softDeletePages(slugs, { sourceId? }?)` | slugs that turned deleted now, once each, in page id order. `updated_at` stays; the knowledge revision changes | `softDeletePages` |
| `brain.deletePages(slugs, { sourceId? }?)` | slugs removed (live or deleted), in page id order. In the same transaction it drops those slugs from captured eval candidates of the source (`eval_capture::remove_retrieved_slugs`), then their page aliases, the slug aliases that resolve to them and the rename history rows that end at them (`aliases::scrub_purged_slug_stores`, the `scrubPurgedSlugStores` order of `src/core/persistence/purge-slug-stores.ts:6`) | `deletePages` |
| `brain.purgeDeletedPages(olderThanHours, { dryRun?, excludeIds? }?)` | `{ slugs, count }` of pages deleted more than `floor(olderThanHours)` hours ago, plus `pages: [{ slug, source_id, deleted_at }]` (dry run and real run alike). An age that is NaN, negative or not finite refuses `invalid_argument` before anything is read or written; the TypeScript member throws `PurgeAgeError` first, as the SQL engines do (`src/core/engine-errors.ts`) | `purgeDeletedPages` (minus the pages a hold keeps, see below) |
| `brain.resolveSlugsByPaths(paths, { sourceId })` | `[{ slug, source_path, live }]` for every page of the source whose `source_path` is one of `paths`, sorted by path then slug; the TypeScript member keeps one slug per path (`pickCanonicalOrigin`) | `resolveSlugsByPaths` |
| `brain.findPages({ pattern: { kind, like }, types?, limit, sourceId?, sourceIds?, excludeSlugPrefixes? })` | `{ rows, total }`. `like` is a Postgres `LIKE` pattern (`%`, `_`, `\` escape), case-folded. A `name` pattern matches the title, or the slug when its last segment matches too; `prefix` and `glob` match the slug or `source_path`. Live pages of unarchived sources only. Rows sort by slug, then source; `total` is every match, or 0 when no row is returned | `findPages` |
| `brain.countPagesBy({ sourceId?, sourceIds?, since?, typeGroups? }?)` | `{ bySourceType, byTypeGroup, total }` over visible pages (live, source present and not archived) whose effective date (else `updated_at`) is at or after `since`, an ISO date or instant. `typeGroups` maps a type to its group; with it, only mapped types count in `byTypeGroup` and `total` | `countPagesBy` |
| `brain.getAllSlugs({ sourceId? }?)` | every slug, deleted pages included, sorted and distinct; `''` means every source | `getAllSlugs` |
| `brain.listAllPageRefs()` | `[{ source_id, slug, updated_at }]` of live pages, by source then slug | `listAllPageRefs` |
| `brain.listMarkdownPageSlugs(sourceId)` | the slugs of the source's markdown pages, deleted pages included, in byte order | `listMarkdownPageSlugs` |
| `brain.listPrefixSampledPages({ prefixes, excludeSlugs?, staleBias?, staleThresholdDays?, sourceId?, sourceIds? })` | one domain-bank row per prefix: the live inline page under it (segmented pages are left out) with the most inbound links, then the lowest slug. With `staleBias`, a page never retrieved ranks first, then one last retrieved before `staleThresholdDays` (default 90) ago, then the rest; links and slug break ties | `listPrefixSampledPages` |
| `brain.listCorpusSample({ n, excludeSlugs?, seed?, sourceId?, sourceIds? })` | up to `n` domain-bank rows of live inline pages (segmented pages are left out), in a shuffle fixed by `seed` | `listCorpusSample` |
| `brain.bumpPageRetrievals(ids)` | the number of records written. Records now as the last retrieval of each listed page that exists, once per id; it skips an id that is not a page, and a page whose record is less than 5 minutes old | `bumpPageRetrievals` (the throttled `page_retrievals` upsert of `src/core/engine-sql/pages.ts`) |
| `brain.readAdmittedPageRefs(refs, scope)` | `[{ source_id, slug }]` for each ref whose live, unquarantined page of an unarchived source the read scope admits (the live filter always applies), in ref order | `readAdmittedPageRefs` |
| `brain.readPageSynopses(refs, scope)` | `[{ page_id, slug, source_id, title, type, synopsis }]` for each ref whose page the read scope admits and the search visibility clause shows (live, served text projection, unarchived source, unquarantined, no `pinned_question`); `synopsis` is the first 65536 code points of the body, in ref order | `readPageSynopses` |
| `brain.readSeedTitleSlugs(sourceId, types, title)` | at most two slugs of live pages of the source whose type is listed, whose lowered title equals the lowered `title`, and which are not retired (`retiredPageSql`), in page-key order (the SQL sets none) | `readSeedTitleSlugs` |
| `brain.getContentFlagsByPageIds(ids, scope?)` | `[{ id, reason, detail }]` of pages whose frontmatter `content_flag.reason` is a non-empty string | `getContentFlagsByPageIds` |
| `brain.getUnverifiedExtractionPageIds(ids, scope?)` | `[{ id, status, unverified }]` of pages with a frontmatter `status`; `unverified` is `status = 'unverified'` and `provenance = 'auto-extracted'` | `getUnverifiedExtractionPageIds` |
| `brain.getPageTimestamps(slugs)` | `[{ slug, ts }]` (`ts` = `updated_at`) of every page with that slug, deleted included, in page id order | `getPageTimestamps` |
| `brain.getEffectiveDates(refs, scope?)` | `[{ source_id, slug, ts }]` (`ts` = `effective_date`, else `updated_at`) for each ref that names a page | `getEffectiveDates` |
| `brain.readAdmittedPageRefs(refs, scope)` | `[{ source_id, slug }]` for each ref whose live, unquarantined page of an unarchived source the read scope admits (the live filter always applies), in ref order | `readAdmittedPageRefs` |
| `brain.readPageSynopses(refs, scope)` | `[{ page_id, slug, source_id, title, type, synopsis }]` for each ref whose page the read scope admits and the search visibility clause shows (live, served text projection, unarchived source, unquarantined, no `pinned_question`); `synopsis` is the first 65536 code points of the body, in ref order | `readPageSynopses` |
| `brain.readLivePageFrontmatter(sourceId, slug)` | `{ type, frontmatter }` of the live page at the slug in the source, or `null` when none is live there (put_page's ignored-label notice reads the stored page back) | `readLivePageFrontmatter` |
| `brain.readEntityAnchoredPages(sourceId, entitySlug)` | `{ entity, pages }`: the live entity page's `{ id, title }` (or `null`), then up to 10 other live pages of the source, no question, synthesis or `pinned_question` page, whose compiled truth names the entity as a word (its slug tail or title, 3 UTF-16 units or more, matched as `~* '\m(...)\M'` matches, case by PGLite's table) or that link to it by a ranking link, by `COALESCE(effective_date, updated_at)` then id, newest first | `readEntityAnchoredPages` |
| `brain.readPageTitlesById(ids)` | `{ id, title }` of each page id, deleted or not, each once; an id outside `integer` is refused as the `::int[]` cast refuses it (the anchored rows' titles) | `readPageTitlesById` |
| `brain.readImageSealProbe(sourceId, slug)` | `{ has_visual }` when the page record at the slug (live or soft-deleted) is sealed past the safe-chunk fence (`chunker_version >= 4`; no version reads as below it), else `null`. The store keeps no image vector, so `has_visual` is always `false`, as `sealImagePages` answers | `readImageSealProbe` (import-file.ts `importImageFile`) |
| `brain.readPageChunkerVersion(pageId)` | `{ chunker_version }` of the page record with the id, live, soft-deleted or segmented (`null` for a record written before the store kept one), or `null` when no record has the id; an id outside `integer` is refused | `readPageChunkerVersion` (safe-chunks.ts `provenanceDistrusted`) |
| `brain.readPrefixAnchoredPages(sourceId, prefix)` | `[{ id, slug }]`: up to 10 live pages of the source whose slug starts with `prefix` (literal: the SQL escapes `\\`, `%` and `_` for `LIKE`), no question, synthesis or pinned-question page, by `COALESCE(effective_date, updated_at)` newest first, then by id descending | `readPrefixAnchoredPages` (entity-anchor.ts `prefixAnchoredPages`) |
| `brain.readTextMentionPages(sourceIds, slugs)` | `[{ slug, source_id, title, type, frontmatter, date }]` for each live page whose source and slug are among the given ones, `date` being `COALESCE(effective_date, updated_at)` as ISO text (the member returns a `Date`), in no set order (the entity card's text mentions) | `readTextMentionPages` |
| `brain.readReflexLiveKeys(sourceIds, slugs, policy)` | `[{ slug, source_id }]` for each live page whose source and slug are among the given ones and that the page policy (when not `null`) does not hide, in no set order (the retrieval reflex's live-page check) | `readReflexLiveKeys` |
| `brain.readReflexPages(sourceIds, match, policy)` | `[{ slug, source_id, title, type, frontmatter, compiled_truth }]` for the live pages of the sources that the match picks and the page policy (when not `null`) does not hide; `compiled_truth` is the bounded 64K body prefix. `match.kind` is `names` (lowered title in `titlesLc`, slug in `exactSlugs`, slug `LIKE` a `slugSuffixes` pattern, or a person page whose lowered title is `LIKE` a `surnamePatterns` pattern; by page id), `slugs`, `cjkExact` (lowered title or slug in `norms`) or `titles` (lowered title in `titlesLc`); no set order except `names` | `readReflexPages` |
| `brain.readBriefEntityPages(sourceId, slugs, policy, { min_trust, suppress_flagged })` | `[{ slug, title, type }]` for the live pages of the source at the slugs that the page policy (when not `null`) and the eligibility admit (a page with no stamped tier reads as `unknown`; an unknown tier name is refused) (the proactive brief's entity pages) | `readBriefEntityPages` |
| `brain.readBriefMeetingPages(sourceIds, startFrom, startTo, policy, { minTrust, suppressFlagged })` | `[{ slug, source_id, start, attendees, account }]` for the live meeting pages of the sources whose frontmatter `start` text lies in `[startFrom, startTo]` and that the page policy (when not `null`; the member passes the remote read floor) and the eligibility admit; `start` and `account` read as `->>` text, `attendees` as `->` JSON, in store scan order (the SQL sets none) (the proactive brief's calendar) | `readBriefMeetingPages` |
| `brain.readBriefEmailAliasPages(sourceId, emails, policy, { minTrust, suppressFlagged })` | `[{ alias_norm, slug, title, type }]`: one row per alias row of the source whose alias is among `emails` and whose live page the page policy and eligibility admit, in alias, then slug, then origin byte order (the SQL sets none) (the brief's counterparty match) | `readBriefEmailAliasPages` |
| `brain.readBriefWorldFacts(factIds, policy, { minTrust, suppressFlagged })` | `[{ id, fact, trust_tier, write_origin }]` for each listed id, once, whose fact is active, `world`, not hidden by the fact policy (when not `null`), a deleted page or quarantine, and eligible, in id order (the brief's open loops) | `readBriefWorldFacts` |
| `brain.readBriefEditPage(sourceId, slug, maxBytes, policy, { minTrust, suppressFlagged })` | `{ id, compiled_truth, timeline, trust_tier, write_origin }` of the live page at the slug in the source that the page policy (when not `null`) and the eligibility admit, else `null`; `compiled_truth` is `null` when its bytes plus the timeline's pass `maxBytes` (the brief's page edit) | `readBriefEditPage` |
| `brain.readBriefTimelineEntry(pageId, since, policy, { minTrust, suppressFlagged })` | `{ id, date, summary, detail, created_at }` of the page's newest entry recorded at or after `since` and dated on or after its UTC date, under the event-page policy (when not `null`) and the projection eligibility, by `created_at`, then date, then id, else `null`. `created_at` is ISO with microseconds (the member returns a `Date`); a `since` that is not ISO UTC is refused | `readBriefTimelineEntry` |
| `brain.readBriefPageVersions(pageId, since, maxBytes, limit)` | `[{ id, compiled_truth, timeline, snapshot_at, is_deleted }]` of the page's newest `limit` revisions snapshotted at or after `since`, by id descending; `compiled_truth` is `null` past `maxBytes` or on a segmented snapshot. `snapshot_at` is ISO with microseconds (the member returns a `Date`). The member refuses a `limit` that is not a positive integer with a `RangeError` before the call, as the SQL builder does | `readBriefPageVersions` |
| `brain.readSeedTitleSlugs(sourceId, types, title)` | at most two slugs of live pages of the source whose type is listed, whose lowered title equals the lowered `title`, and which are not retired (`retiredPageSql`), in page-key order (the SQL sets none) | `readSeedTitleSlugs` |
| `brain.revertToVersion(slug, versionId, { sourceId? }?)` | `null`. Copies the version's `compiled_truth` and `frontmatter` onto the page and sets `updated_at`; a missing page or version does nothing. When a page it would revert, or the version, is segmented, it refuses `page_body_segmented` and writes nothing; the TypeScript member throws PGLite's `segmentedRevertRefusal` | `revertToVersion` |

A domain-bank row is `{ slug, prefix, connection_count, representative_chunk_id,
last_retrieved_at }`. `last_retrieved_at` is the page's retrieval record, else `null`. `representative_chunk_id` is the
page's embedded chunk with the lowest `chunk_index`, or `null` when no chunk of the page has an embedding, as
`src/core/engine-sql/pages.ts` picks it.
The entity card rows (`readEntityCardRows`, `cli_reads/entities.rs`) read the same record as
`last_retrieved_at`, so `gbrain entity` shows `last_touched.last_retrieved_at` after a search.

The proactive brief (`src/core/context/proactive-brief.ts`) reads only through the typed
members above, `listAllSources`, `readEntityAliasRows` and `readLivePageFrontmatter`. Its
catches pass a capability refusal on (`rethrowCapabilityRefusal`,
`nullUnlessCapabilityRefusal`), so a member the store does not answer stops the whole
brief (the outer `withBriefDeadline` catch is unchanged) instead of leaving a brief with an
arm silently missing. Three hook catches stay fail-open on purpose, because
the per-turn hook must never block a turn: the pointer block catch in
`src/core/context/turn-context.ts` (`pointers = []`), and the volunteered-page catch and the
outer catch of the retrieval reflex in `src/core/context/reflex.ts`.

## Retrieval records

| Key | Value | Mirrors |
| --- | --- | --- |
| `p 0x01 page_id` (u64 big-endian) | microseconds since the epoch (JSON integer) | `page_retrievals.last_retrieved_at` |

`gbrain search`, `query`, `get` and `fetch` call `bumpPageRetrievals` after they answer
(`src/core/last-retrieved.ts`). A hard delete drops the page's record in the same transaction, as the
`pages_forget_retrievals` trigger does on Postgres.

## Differences from Postgres

- The store keeps no legacy `pages.last_retrieved_at` column, so the retrieval record is the only
  source of `last_retrieved_at` (Postgres takes the later of the two).
- The entity card read (`readEntityCardRows`, `cli_reads/entities.rs`) reads the same record for its `last_retrieved_at`.
- `listCorpusSample` uses a SplitMix64 shuffle seeded from `seed`. A seed gives a fixed pick, but not
  the pick Postgres `setseed()` + `random()` gives. The parity cases compare the set, not the order.
- `countPagesBy` refuses a `since` that is not an ISO date or instant (Postgres also takes other
  `timestamptz` text).
- `revertToVersion` writes no new version, as PGLite. The interface spec says it snapshots first.
- A hard delete (`deletePages`, `purgeDeletedPages`) scrubs, in the delete's write, the eval candidates, retrieval
  records, the take proposals (with their idempotency entries and nudges), open loops (with their dedupe keys) and
  core-edit notices (acknowledged ones too, [core-edit-notices.md](core-edit-notices.md)) filed under the slug in its
  source, and the page aliases, slug aliases and rename history, as PGLite's `deletePurgedSlugStoreRows` does. PGLite
  also scrubs write-gate holds, which this scrub does not touch.

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
  store serves the resumable-op checkpoints (persistence.md, "Op checkpoints"), not these rows; the
  family that serves these writers must add both holds.

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
