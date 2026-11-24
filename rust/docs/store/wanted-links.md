# The brain store: wanted links

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A wanted link is a link reference whose target page does not exist yet (`src/core/wanted-links.ts`).
PGLite and Postgres keep them in the `wanted_links` table. The writes run the SQL that
`src/core/wanted-links-store.ts` ran through `executeRaw`, now in `src/core/engine-sql/wanted-links.ts`.
The store keeps one record per row (`crates/gbrain-store/src/wanted_links.rs`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.lockRegisteredSourceIds(sourceIds)` | the registered ids among `sourceIds`, sorted, once each. The store write is already exclusive, so nothing is locked. | `lockRegisteredSourceIds` |
| `brain.replaceWantedLinkRows({ pageId, sourceId }, { rows, producers, readAt })` | the number of rows written. Rows of `producers` that `rows` does not name are deleted. Each row of `rows` is written, and an existing row keeps its id and `first_seen`. | `replaceWantedLinkRows` |
| `brain.listWantedPages({ sourceId?, sourceIds?, excludePrivate?, limit, offset })` | `{ total, rows }`, each row in the final `WantedPageRow` shape that `listWantedPages` in `wanted-links-store.ts` returns | `listWantedPages` (engine member; `excludePrivate: true` sends the caller's page policy) |

## Write rules

- `checked_at` is `-infinity` for a slug row whose target is a live page, `readAt` for a name row, and the store clock otherwise.
- A row with a producer other than `body` or `frontmatter`, or a ref kind other than `slug` or `name`, is refused with `constraint_violation` (the table's CHECK).
- Two rows with the same `(producer, ref_kind, target_source_id, target_ref)` are refused with `constraint_violation`. Postgres refuses the same rows ("ON CONFLICT DO UPDATE command cannot affect row a second time").
- A missing origin page or source is refused with `constraint_violation` (the foreign keys).
- A name row with no `readAt` is refused with `constraint_violation` (`checked_at` is NOT NULL).
- An origin page in a source other than `sourceId` is refused with `invalid_argument`. Postgres accepts it; every caller passes the page's own source.
- An empty `producers` writes nothing and returns 0.

## Read rules

- Only live origins count. A row whose origin page is soft-deleted or gone is hidden.
- A target that is a live page by slug is left out, for either ref kind.
- Scope (`sourceIds`, else `sourceId`) applies to the origin's source.
- Rows group by `(target_source_id, target_ref)`. `ref_kind` is `name` when any row of the group is a name row.
- `referenced_by` counts distinct origin pages. `sample_origins` is the first 3 by slug. `link_types` is the distinct non-empty types, sorted.
- `existing_matches` (name groups only) is the first 3 live pages, by slug, in the target source whose last slug segment equals the name.
- Order: `referenced_by` descending, then `target_source_id`, then `target_ref`. `total` counts every group before `limit` and `offset`.
- `first_seen` and `last_checked` are millisecond ISO strings. `last_checked` is `pending` when every row of the group is `-infinity`.
- `excludePrivate` carries the caller's page policy: an origin it hides does not count and a page it hides is no name match. A hidden live page still keeps its slug out of the targets, as in the SQL. A caller whose policy differs from the reader identity and private-readable grant gets `engine_capability_missing` from the TypeScript member.

## Keys and cascade

```text
q <origin source_id> \0 W <origin page id BE8> <producer> \0 <ref_kind> \0 <target_source_id> \0 <target_ref>
```

The records sit under the link_queries tag `q`. `M wanted_link_id` is the id counter.

- **Source delete.** `link_queries::remove_source_rows` deletes every key under `q <source> \0`, so `cascade::remove_source_rows` removes the records. `wanted_links::remove_source_rows` deletes only this family's records.
- **Page delete.** `cascade::remove_page_rows` calls `wanted_links::remove_page_rows`, which deletes the page's records (Postgres `ON DELETE CASCADE`).

## Accessors for other families

- `stale_origin_page_ids(read, producers)`: the origin page ids whose wanted target is now a live page, or a live basename match for a name row, updated after `checked_at`. This answers `wantedOriginIsStale` in `src/core/engine-sql/pages.ts` for the family that serves stale extraction.
- `replace_rows_in(tx, now, pageId, sourceId, replacement)`: the replace inside a caller's write, for a family that publishes derived links and wanted rows in one write.
