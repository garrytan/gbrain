# The brain store: doctor reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that `gbrain doctor` checks ran through `executeRaw`. PGLite and Postgres run the same SQL as
before (`src/core/engine-sql/doctor-reads.ts`; the text is pinned by `test/doctor-reads-sql.test.ts`). The store answers
from the records each statement read (`crates/gbrain-store/src/cli_reads/doctor.rs`) and has no keys of its own. The
TypeScript side is `src/core/rust-engine/store-members/repair-page-reads.ts` (`countPageChildOrphans`) and
`src/core/rust-engine/store-members/config.ts` (`listSchemaPackSourceOverrides`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countPageChildOrphans(target)` | the rows of the page-child relation `target` whose page id names no page | `countPageChildOrphans` |
| `brain.getConfigValues(keys)`, `brain.getAllConfig()` | the `schema_pack.source.<id>` config rows of the named sources, or every one | `listSchemaPackSourceOverrides` |

## How each read follows the SQL

`countPageChildOrphans(target)` takes one `<table>.<column>` of `PAGE_CHILD_FK_TARGETS`
(`src/core/repair/orphan-children.ts`) other than `content_chunks.page_id`, which is `countOrphanChunks`. Any other
target is an `invalid_argument` error. The store scans the index that holds the relation's page id and counts the rows
whose page id has no `I` key:

| Target | Index read |
| --- | --- |
| `page_versions.page_id` | `V <page id>` |
| `tags.page_id` | none: tags are part of the page record, so the answer is 0 |
| `takes.page_id` | `A 0x02 <page id>` |
| `raw_data.page_id` | `r 0x01 <page id>` |
| `timeline_entries.page_id` | `E <page id>` |
| `links.from_page_id` | `L <page id>` |
| `links.to_page_id` | `l <page id>` |
| `links.origin_page_id` | `O <page id>` |
| `files.page_id` | `r 0x03 <page id>` |

A NULL `links.origin_page_id` or `files.page_id` is not an orphan, as in the SQL: the store keeps no index entry for one.
Page deletes cascade in the store as the foreign keys do in Postgres, so a nonzero count means a torn write, the case
doctor's `child_table_orphans` check exists to find. `crates/gbrain-store/tests/cli_reads_doctor.rs` removes a page's
`I` key to make one.

`listSchemaPackSourceOverrides(sourceIds)` is the schema_pack_source_drift read. With `sourceIds` it reads the keys
`schema_pack.source.<id>` through `getConfigValues` (each key once, as `key = ANY($1)` matches each row once; `[]` reads
none). Without, it reads every stored config row and keeps the keys that `LIKE 'schema_pack.source.%'` matches: `_`
matches any one character and `%` any run, so `schemaXpack.source.wild` is one, as in the SQL; the match is
case-sensitive. The store returns rows in key order; the SQL statements leave the order open, and the check reads only
the row count and the distinct values.
