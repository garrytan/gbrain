# The brain store: search-ranking page reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are three page reads that hybrid search runs in its ranking stage. PGLite and Postgres run the SQL in
`src/core/engine-sql/search-reads.ts`. The store answers from its page records
(`crates/gbrain-store/src/cli_reads/search_reads_pages.rs`) and has no keys of its own.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.slugsEndingIn(sourceId, word)` | up to two live slugs of `sourceId` that equal `word` or end in `/word`, oldest page first | `slugsEndingIn` |
| `brain.generatedPagesIn(ids)` | `{ id, frontmatter, compiled_truth }` for each page among `ids` whose frontmatter `dream_generated` is `true` or `"true"`, or whose type is `extract_receipt`; soft-deleted pages and pages of every source included; each page once, by id | `generatedPagesIn` |
| `brain.livePageIdsAt(refs)` | the id of each live page at a `{ slug, source_id }` ref, each page once however often its ref repeats, by id | `livePageIdsAt` |

## Rules the store keeps from the SQL

- **No privacy filter.** None of the three statements reads page visibility, so the store does not either.
- **Soft delete.** `slugsEndingIn` and `livePageIdsAt` read live pages only (`deleted_at IS NULL`). `generatedPagesIn`
  has no `deleted_at` condition, so it returns a soft-deleted generated page too.
- **Source.** `slugsEndingIn` reads one source. `livePageIdsAt` matches the ref's source and slug together.
  `generatedPagesIn` has no source condition: page ids are unique across sources.
- **Suffix match.** The SQL escapes LIKE's `%`, `_` and `\` in `word`, so the match is a literal, case-sensitive
  suffix `/word` or the whole slug. The store compares the stored slug bytes the same way.
- **Generated flag.** Only the top-level `dream_generated` key counts, as `frontmatter->>'dream_generated' = 'true'`
  reads it: a JSON `true` or the text `"true"`. A nested key, `"TRUE"` or `1` does not.
- **Ids.** The SQL casts `ids` to `int[]`, so an id outside the int4 range is an error. The store refuses it with
  `invalid_argument`. A zero or negative id in range names no page.
- **Segmented pages.** `compiled_truth` is `null` for a segmented shell page, as the SQL column is.

## Order

`slugsEndingIn` has `LIMIT 2` and no `ORDER BY`, so PGLite returns the first two rows of its heap scan. The store
returns the two lowest page ids, which is the order the pages were created. When more than two slugs match, the
two slugs may differ from the two PGLite returns after updates move heap rows; the count is the same.
`generatedPagesIn` and `livePageIdsAt` also have no `ORDER BY`; the store returns them by id, and callers treat the
result as a set.
