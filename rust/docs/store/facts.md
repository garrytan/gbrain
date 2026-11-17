# Facts store (`facts.rs`)

The `facts` table of the PGLite engine. The members are still being built; this page lists
what is in place. The `pageCollapseFacts` read is built; the other fact members still refuse with
`engine_capability_missing`.

## Keys

Every key starts with `keys::FACT` (`F`).

| Key | Value | Meaning |
|---|---|---|
| `F 0x01 id` | `FactRecord` (JSON) | One fact row. `id` is 8 big-endian bytes, so key order is id order. |

## Lookups for other families

- `fact_exists(read, id, source_ids)`: true when fact row `id` exists in one of `source_ids`
  (any source when the list is empty). Eval capture uses it for a `facts/<id>` slug, which
  stays on a captured candidate while the fact row does (`insertEvalCandidate` in
  `src/core/feedback/store.ts`). As in PGLite, an expired, superseded or consolidated row
  still exists, and so does a row whose page was soft-deleted. The caller checks the slug
  against `^facts/[0-9]{1,18}$` first.

## Members

| Member | What it does |
|---|---|
| `pageCollapseFacts` | The collapse-stage read of hybrid search (`facts/collapse.rs`, SQL in `src/core/engine-sql/search-reads.ts`): one `{ id, target, body_chars, body, lead }` row per page row whose id is in `ids`, soft-deleted pages and every source included, by id (the SQL has no `ORDER BY`); a missing id has no row. `target` is the first of `redirect_to`, `redirect` and `merged_into` that is a non-empty string after trimming spaces, then `superseded_by` when the lower-cased `status` holds the word `alias`, `redirect` or `redirected`. `BODY` is the first 65,536 code points of `compiled_truth`, spaces trimmed; `body_chars` is its length in code points, `body` its md5 hex for an id in `bodyIds` with at least 200 code points, `lead` its first 4,000 code points for an id in `bodyIds`. The TypeScript member refuses an id that is not a 32-bit integer, as the SQL casts both lists to `int[]`. It reads pages, not facts; it sits here because its `BrainEngine` capability class is `facts`. |
