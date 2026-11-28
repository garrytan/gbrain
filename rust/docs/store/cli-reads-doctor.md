# The brain store: doctor reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that `gbrain doctor` checks ran through `executeRaw`. PGLite and Postgres run the same SQL as
before (`src/core/engine-sql/doctor-reads.ts`; the text is pinned by `test/doctor-reads-sql.test.ts`). The store answers
from the records each statement read (`crates/gbrain-store/src/cli_reads/doctor.rs`) and has no keys of its own. The
TypeScript side is `src/core/rust-engine/store-members/repair-page-reads.ts` (`countPageChildOrphans`) and
`src/core/rust-engine/store-members/config.ts` (`listSchemaPackSourceOverrides`) and
`src/core/rust-engine/store-members/doctor-tallies.ts` (the three calibration counts).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countPageChildOrphans(target)` | the rows of the page-child relation `target` whose page id names no page | `countPageChildOrphans` |
| `brain.getConfigValues(keys)`, `brain.getAllConfig()` | the `schema_pack.source.<id>` config rows of the named sources, or every one | `listSchemaPackSourceOverrides` |
| `brain.countContextualCoverage(chunkerVersion, sourceIds?)` | `{ chunker_drift, unsealed, unsealed_code, mode_null }` over live pages | `countContextualCoverage` |
| `brain.countAbandonedTakes(sourceIds?)` | how many takes `listAbandonedTakes` lists, with no limit | `countAbandonedTakes` |
| `brain.countAppliedTakeGrades(sourceIds?)` | how many cached verdicts have `applied = true` | `countAppliedTakeGrades` |

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

`countContextualCoverage(chunkerVersion, sourceIds)` is the contextual_retrieval_coverage read. It walks every live page
(of `sourceIds` when given; `[]` names none) and counts: markdown pages whose `chunker_version` is below the argument;
pages of any kind below the safe-chunk fence (`chunker_version < 4`, `safeChunksFilter`), and the code pages among them;
and markdown pages with no contextual retrieval mode whose type is not `extract_receipt`. A page record with no stored
chunker version (written before the store kept one) is below the fence, as every store fence read takes it, and not
below the argument, as the store's chunk walk reads take it. Postgres and PGLite cannot hold that case: the column is
`NOT NULL`.

`countAbandonedTakes(sourceIds)` is the abandoned_threads read: the takes `listAbandonedTakes` would list with no limit
(active, unresolved, unsuperseded, `weight >= 0.7` with the stored REAL widened, a `since_date` before 12 months ago, a
`YYYY-MM` date read as its 1st). With `sourceIds` only takes whose page (in any state, as `page_id IN (SELECT id FROM
pages ...)` reads it) is in one of them count, and a take on another source's page is left out before its date is read;
a `since_date` the read reaches that is not a date fails it, as the `::date` cast fails the SQL.

`countAppliedTakeGrades(sourceIds)` is the grade_confidence_drift read: the cached verdicts with `applied = true`, whether
or not their take still exists. With `sourceIds` only verdicts whose take sits on a page (in any state) of one of them
count, as the `take_id IN (SELECT t.id FROM takes t JOIN pages p ...)` filter reads it.
