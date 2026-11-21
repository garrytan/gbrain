# The brain store: the git-gap census

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The git-gap census (`censusGitGap` in `src/commands/sources-git-gap.ts`) compares a source's live pages with its Git
checkout. `gbrain sources git-gap`, doctor `db_ahead_of_git` and doctor `strict_facts_outside_git` run it. Its database
reads are five members; PGLite and Postgres run one SQL text each (`src/core/engine-sql/git-gap-census.ts`):

| Member | Reads |
| --- | --- |
| `readGitGapSource(sourceId)` | the source's `local_path`, `incarnation` and live page count; null for no such source |
| `readGitGapNewestWindow(sourceId, newest)` | the `newest` most recently updated live pages (UTC, to the second) and the fenced facts on the other live pages |
| `listGitGapPageKeys(sourceId, window, limit)` | live page keys in id order, after an id or among ids, with the page-privacy verdict (`lineage_private`) |
| `countGitGapRowsWithoutFile(sourceId, slugs, pageIds)` | fenced facts on those slugs and timeline rows on those pages |
| `countGitGapSourceRows(sourceId, opts)` | unfenced live facts, fenced facts with no live page, underived links by provenance, open `sync-hold` holds by code, parked effect targets by kind and code; groups sort bytewise (`COLLATE "C"`), NULL codes last |

The Rust engine has no store member for any of them, so each refuses by name (`engine_capability_missing`;
capability `pages` for `readGitGapSource` and the window and key reads, `facts` for the counts). The source read is
named `pages`, not `sources`: it counts live pages, and a refusing `sources` member would withhold the `sources`
capability the store serves (`store-capabilities.ts`). A census
needs more than these reads: the read-only mirror flag, the alias setting and schema version the privacy predicate
follows, export snapshots, sync import provenance, the slug-root mode, direction evidence from `page_versions`, holds
and parked effects. The store serves none of them yet, so a partial census would report pages it never compared.

`readGitGapSource` is the census's first database read after the source resolves, so on Rust the census stops there:
`gbrain sources git-gap` exits with the refusal, and doctor `db_ahead_of_git` reports `Could not compare: <source>
(This brain's engine does not support readGitGapSource yet (it needs the pages capability) ...)` under the unknown
convention (warn, `health: unknown`). It never answers an empty census, which a caller would read as "nothing outside Git".

Parity: `test/engine-parity/git-gap-census.test.ts`. Census behavior: `test/git-gap-census.test.ts`.
