# The brain store: page mutation reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page write (`put_page`, `capture`, `revert_version` and the other page mutations in
`src/core/persistence/page-mutations.ts`) reads the stored page and its versions before it admits the write. PGLite and
Postgres run the SQL in `src/core/engine-sql/page-mutation-reads.ts` (`PAGE_MUTATION_READS_SQL`, the statements the
caller ran). The store answers from the page and version records the other families write
(`crates/gbrain-store/src/page_mutation_reads.rs`). It keeps no records of its own and adds no key prefix.

| Member | Returns |
| --- | --- |
| `brain.readStoredPageHead(sourceId, slug)` | `{ type, trust_tier, title, frontmatter }` of the page at the slug in the source, a soft-deleted page too (the statement has no `deleted_at` filter), or null. A record the store never stamped reads `trust_tier` as `unknown`, the column default. A remote `put_page` unquotes a page's own quoted read against it |
| `brain.readVersionSourcePath(versionId, pageId)` | The version's `source_path` when the version belongs to the page, else null. A `revert_version` on an unclaimed rooted source whose current revision has no file is judged file-backed by it |

`capture --file` reads the source's local path through `readSourceLocalPath`, the member
[memory_mutation_reads.md](memory_mutation_reads.md) documents (the same statement).
