# The brain store: doctor search-and-knowledge reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that nine `gbrain doctor` checks ran through `executeRaw`, which a Rust brain refuses with
`raw_sql`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-search.ts`; the text is pinned by
`test/doctor-search-sql.test.ts`). The store answers from the records each statement read
(`crates/gbrain-store/src/cli_reads/doctor_search.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/doctor-search.ts`. The cross-engine cases are in
`test/engine-parity/doctor-search.test.ts`; the store's own are in `crates/gbrain-store/tests/cli_reads_doctor_search.rs`.

Each member's Rust answer is one of: served (read from the records), empty-no-writer (the store has no writer for the
table the SQL reads, so the answer is what an empty table gives), or refused (the typed capability refusal).

| JS | Resolves | Rust answer | Doctor check |
| --- | --- | --- | --- |
| `listOrphanedAliasCounts()` | per source, the `slug_aliases` rows whose canonical page row is absent and the `page_aliases` rows whose page row is absent; sources with none are not listed | served | `dangling_aliases` |
| `readSoftDeletedAliasCounts()` | `{slug_redirects, page_aliases}`: alias rows whose page is soft-deleted | served | `dangling_aliases` |
| `listPageTypePairs()` | the distinct `(source_id, type)` of live typed pages, by source then type | served | `type_proliferation` |

## How each read follows the SQL

- An alias row is "orphaned" when its page row is absent (a hard delete), "soft-deleted" when the page row is present
  with `deleted_at` set. The store reads the alias keys (`alias_row_targets` in `crates/gbrain-store/src/aliases.rs`)
  and looks each target page up by `(source, slug)`.
- Order is bytewise, as PGLite's C.UTF-8 collation orders it.
