# The brain store: the Git-gap census reads

The rules in [rust/README.md](../../README.md) ("The brain store") apply.

`gbrain sources git-gap` (`src/commands/sources-git-gap.ts`) compares a source's pages with its Git checkout. The SQL for
the PGLite and PostgreSQL engines is in `src/core/engine-sql/git-gap-census.ts` (`GIT_GAP_CENSUS_SQL`); the store serves
the same members from its page, fact, link, timeline, op-checkpoint and effect records (`git_gap_census.rs`). The
census has no records of its own. Counts are numbers; page ids are text.

| Member | Returns |
| --- | --- |
| `brain.readGitGapSourceRow(sourceId)` | `{ local_path, incarnation }` of the source, or null for an unknown source |
| `brain.countGitGapLivePages(sourceId)` | the source's pages that are not soft-deleted |
| `markTransactionReadOnly()` | nothing (TS only): the store's transaction admits no other writer while it runs |
| `brain.listGitGapNewestPages(sourceId, limit)` | `{ id, updated_at }` of the `limit` live pages updated last, ties by the higher id; `updated_at` to the second in UTC (`YYYY-MM-DDTHH:MM:SSZ`) |
| `brain.countGitGapUnreadFacts(sourceId, pageIds)` | the source's fenced facts whose fence page is live and is not one of `pageIds` |
| `brain.readGitGapPageBatch(sourceId, after, ids, honorAliases)` | at most 256 live pages by id: after page id `after`, or exactly `ids`. Each row has the census key fields and `lineage_private` (the privacy part hides the page; TS reads `honorAliases` from the text `privacyPartSql` renders). `withheld_source_path` is null: the store keeps no such column |
| `brain.countGitGapFactsOnPages(sourceId, slugs)` | the source's fenced facts on those pages, expired ones too |
| `brain.countGitGapTimelineOnPages(pageIds)` | the timeline rows of those pages, each page once |
| `brain.readGitGapSourceRows(sourceId, derived, holdOp)` | `{ unfenced, fencePageMissing, links, holds, parked }`: unexpired unfenced facts, fenced facts with no live fence page, links out of live pages whose link source is not `derived` (a missing one as `(none)`), the `holdOp` records of the source's current incarnation by code, and each effect's parked targets by kind and error code. Lists are in byte order of their keys, a null code last |

A page id that is not a whole number refuses with `invalid_input`, as the `bigint` cast does.
