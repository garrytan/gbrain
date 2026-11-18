# The brain store: Code edges

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Code edges are the call graph between code chunks: the rows of `code_edges_chunk` (a resolved edge, with a
`to_chunk_id`) and `code_edges_symbol` (an unresolved edge, keyed by the target's qualified name). The TypeScript
members (`src/core/rust-engine/store-members/code-edges.ts`) do what the shared SQL module
(`src/core/engine-sql/code-edges.ts`, and `src/core/pglite-engine/code-edges.ts` for `getEdgesByChunk`) does before
its statements run: `edge_metadata ?? {}` through a JSON round trip, `source_id ?? 'default'`, the limit clamps
(`min(limit ?? 100, 500)` for callers and callees, `min(limit ?? 50, 200)` for `getEdgesByChunk`), the source scope
(`!allSources && sourceId ? sourceId : null`), the bare-name opt-in (`bareFallback` and no `.`, `#` or `:` in the
name), and the row shape (`rowToCodeEdge`, so `resolved` is also true for a symbol row with a numeric
`edge_metadata.resolved_chunk_id`).

Keys (tag `H`, `keys::CODE_EDGE`; a table byte is 0 for the chunk table and 1 for the symbol table):

- `H 0x01 <table> <id u64 BE>` holds the row as JSON. Ids come from `next_code_edge_chunk` and
  `next_code_edge_symbol`, one sequence per table as each table has its own `SERIAL`.
- `H 0x02 <from u64 BE> <to u64 BE> <edge_type>` -> id: the chunk table's unique key `(from_chunk_id, to_chunk_id, edge_type)`.
- `H 0x03 <from u64 BE> <to_symbol> NUL <edge_type>` -> id: the symbol table's unique key `(from_chunk_id, to_symbol_qualified, edge_type)`.
- `H 0x04 <chunk u64 BE> <table> <id>`: every row with this chunk at either end (one entry when both ends are the same chunk).
- `H 0x05 <to_symbol> NUL <table> <id>` and `H 0x06 <from_symbol> NUL <table> <id>`: rows by target and by caller name.

The chunk index (the chunk store keys a chunk by page and index, not by id), under the same tag:

- `H 0x07 <chunk u64 BE>` -> `<page_id u64 BE>`, then `0` for no `symbol_name` or `1` and the name's bytes: every chunk
  by id. The foreign key checks of `addCodeEdges` and the live-endpoint filter of the caller and callee reads look a
  chunk up here.
- `H 0x08 <symbol_name> NUL <chunk u64 BE>`: the chunks by `symbol_name`, for the bare-name fallback. A name that holds
  a NUL gets no entry; a lookup name never holds one, so it could never match.
- `H 0x09`: set once the index covers every chunk. A new brain sets it when it is created. A brain written before the
  index existed has no marker and is indexed once, in one write transaction, when it is opened (`build_chunk_index`).

Every chunk record the chunk store writes updates its entry (a kept chunk id whose `symbol_name` changed moves its name
entry), and the chunk-delete hook `remove_chunk_rows` drops the entries of the chunks that are gone. A page delete and a
source delete remove their chunks through that hook, so the index follows them. A build older than the index does not
keep it, so a brain opened by such a build after a newer one can hold stale entries; the Rust engine is experimental and
not selectable by users, so `FORMAT_VERSION` stays 1.

Reads return the chunk table first, then the symbol table, each in id order (the `UNION ALL` order PGLite returns
with no `ORDER BY`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.addCodeEdges(edges)` | number of rows inserted. A row with a `to_chunk_id` goes to the chunk table, the others to the symbol table; a row whose unique key is there already (or repeated in the batch) is skipped. Each table checks its `NOT NULL` columns row by row, then the foreign keys of the rows it inserted in constraint-name order (`*_from_chunk_id_fkey`, `*_source_id_fkey`, `code_edges_chunk_to_chunk_id_fkey`): `constraint_violation`. `invalid_argument` for a chunk id that is not a whole `int4`, a NUL byte, or metadata `jsonb` cannot hold | `addCodeEdges` |
| `brain.deleteCodeEdgesForChunks(ids)` | null. Drops the chunk-table rows with the chunk at either end and the symbol-table rows leaving it. `[]` and null elements match nothing | `deleteCodeEdgesForChunks` |
| `brain.getCallersOf({ name, chunk_id, source_id, limit })` | rows pointing at `name`; with a `chunk_id`, chunk-table rows pointing at the chunk plus symbol-table rows whose `edge_metadata->>'resolved_chunk_id'` casts to it. Live rows only (below), in `source_id` when set, `limit` over both tables | `getCallersOf` |
| `brain.getCalleesOf({ name, chunk_id, source_id, limit, bare_fallback })` | rows leaving `name` (or the chunk). With `bare_fallback`, an empty answer reads again from the chunks whose `symbol_name` is `name` | `getCalleesOf` |
| `brain.getEdgesByChunk({ chunk_id, direction, edge_type, limit })` | chunk-table rows by direction (`in`: to the chunk, `out`: from it, `both`), then unless `in` the symbol-table rows leaving the chunk; `edge_type` filters both, `limit` applies to each table on its own. No live filter | `getEdgesByChunk` (PGLite's) |

Live rows (`currentCodeEdgeFilter`): each end chunk (both for a chunk-table row) belongs to a page that exists, is
not soft-deleted, has no `quarantine` frontmatter key, serves its text (`text_projection_revision` equals
`knowledge_revision`, or is the activation sentinel `00000000-0000-0000-0000-000000000153`), and whose source exists
and is not archived.

Cascades: removing chunks (a re-seal, `deletePage`, a source removal) drops the edges with those chunks at an end,
through the chunk hook; the page hook removes nothing itself. Removing a source drops the edges whose `source_id` is
that source (`ON DELETE CASCADE` on `source_id`).

## Differences from PGLite

- `addCodeEdges` is one transaction: a failure leaves both tables as they were. PGLite runs one statement per table
  (and per bind batch), so a failure in the symbol statement keeps the chunk rows already inserted.
- Ids: within one call the chunk-table rows get their ids before the symbol-table rows, as PGLite's statement order
  gives them.
- The `resolved_chunk_id` cast reads what `int4in` reads in decimal (blanks, a sign, digits joined by single `_`);
  hex, octal and binary literals (`0x1A`) are refused, where Postgres 16+ accepts them. The cast runs on every
  symbol-table row of a by-chunk callers read, so one bad stamp fails the read, as the statement fails.
- Performance: the live filter, the bare fallback and the foreign key checks look chunks up in the chunk index, so a
  callers/callees read costs O(rows read), not O(chunks). On 2,000 pages of 5 chunks (release build), one
  `getCallersOf` went from 6.6 ms to 1.5 ms and one bare-fallback `getCalleesOf` from 5.2 ms to 0.01 ms (the
  ignored `timing_callers_and_callees_on_2000_pages` test in `tests/code_edges.rs`).
- The member refuses (`engine_capability_missing`) a limit that is not a whole number and a non-finite chunk id,
  which Postgres rejects as a bind error.
