# The brain store: The last family-tail reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Three reads that ran as raw SQL before they were members: the two live re-reads of the scoped contradiction reader
(`src/core/eval-contradictions/scoped-read.ts`, SQL in `src/core/engine-sql/contradictions-cycle.ts`) and the page read of
the version history (`get_versions` in `src/core/ops/admin.ts`, SQL in `src/core/engine-sql/admin-reads.ts`). The module
(`gbrain-store/src/tail_reads.rs`) keeps no records: it reads through the page, chunk and take families' readers.

None of these statements names an order; rows come in id order. Each id matches once, as `= ANY` does, and an unknown
or negative id names no row.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listLiveChunksByIds({ ids, scope, requireSafeChunks })` | `{ id, page_id, chunk_text, slug, source_id }[]`: the chunks of `ids` on a page the scope admits, that the page's body generation shows (`chunkVisibleFilter`), and, when `requireSafeChunks`, on a page whose chunks pass the chunker-version fence | `listLiveChunksByIds` |
| `brain.listLiveTakesByIds({ ids, scope, holders, floor })` | `{ id, page_id, row_num, claim, holder, slug, source_id }[]`: the active takes of `ids` on a page the scope admits, whose holder is in `holders` when it is given (an empty list admits none), and whose own trust tier the `floor` admits | `listLiveTakesByIds` |
| `brain.readPagesForVersionHistory(pageIds)` | `{ id, slug, source_id, frontmatter }[]` for each page id; soft-deleted pages are included, as the statement does not filter them | `readPagesForVersionHistory` |

The scope is the chunk family's page policy (`chunk_queries::PageReadPolicy`, see `chunk_queries.md`), the
`pageReadFilter(.., live = true)` of the SQL engines: the source filter (`sourceIds` when not empty, else `sourceId`),
the page privacy policy under `excludePrivate`, the page trust floor (`minTrust`) and flag suppression, and the live
test (not deleted, not quarantined, in a source that exists and is not archived). A trust floor the store cannot parse
is `invalid_argument`, even when no id is asked.

For the chunk re-read the TypeScript member puts the `floor` argument in `scope.minTrust`, as the SQL does
(`{ ...policy, minTrust: floor }`), and sets `requireSafeChunks` from `requiresSafeChunks(policy)`. For the take re-read
the page keeps the policy's own `minTrust`, and `floor` compares the take's stored tier
(`projectionEligibleSql('takes', ..)`). The `needs_rederive` clause of that projection test hides a take a purge marked
(`generations/needs_rederive.rs`).

The TypeScript members (`src/core/rust-engine/store-members/tail-reads.ts`) check the integer binds first: the SQL
engines bind chunk ids as `int[]` and take and page ids as `bigint[]`, so an id that is not an integer of that width
refuses with `engine_capability_missing` naming the member. They give `id`, `page_id` and `row_num` back as numbers.
