# The brain store: slug spelling reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements the `legacy_slug_spellings` `gbrain doctor` check (and `gbrain repair slug-spelling`) ran through
`executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/slug-spelling-repair.ts`; the statement
texts are pinned by `test/engine-sql-caller-raw-sql-pins.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/slug-spelling-repair.ts` and the Rust side is
`crates/gbrain-store/src/slug_spelling_repair.rs` (behavior pinned by `tests/slug_spelling_repair.rs`).

The store writes every slug in its normal form (`validate_slug`), so on a Rust brain the doctor check finds no page stored
under an older spelling. The reads still answer the rows the SQL would, so the check reports ok instead of refusing.

## Served by the store

| JS | Reads | Rule |
| --- | --- | --- |
| `brain.listSlugSpellingCandidates(afterId, limit)` | pages of every source, deleted ones included, with an id above `afterId`, whose slug has an ASCII capital or a character outside printable ASCII (the SQL prefilter `slug <> lower(slug) OR slug ~ '[^ -~]'`; every non-ASCII character meets the second test, so the database's `lower` does not change the set): `{ id, source_id, slug }` | id order, at most `limit` rows (the caller asks for 5000) |

## Members answered without a store call

| Member | Answer | Why |
| --- | --- | --- |
| `readRowSecurityTables(tables)` | `[]` | The store has no row-level security, so no table can hide rows from the running process. |
