# The brain store: slug spelling reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements the `legacy_slug_spellings` `gbrain doctor` check and the `gbrain repair slug-spelling` preview ran through
`executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/slug-spelling-repair.ts`; the statement
texts are pinned by `test/engine-sql-caller-raw-sql-pins.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/slug-spelling-repair.ts` and the Rust side is
`crates/gbrain-store/src/slug_spelling_repair.rs` (behavior pinned by `tests/slug_spelling_repair.rs`).

The store writes every slug in its normal form (`validate_slug`), so on a Rust brain the doctor check finds no page stored
under an older spelling and the preview lists nothing to move. The reads still answer the rows the SQL would. The apply's
three writes (purge tombstones, attachments) stay raw SQL and are the typed `raw_sql` refusal: no page on a Rust brain
reaches them (docs/designs/RUST_ENGINE.md, the slug-spelling apply row).

## Served by the store

| JS | Reads | Rule |
| --- | --- | --- |
| `brain.listSourceSlugSpellingCandidates(sourceId, afterId, limit)` | the same filter over one source: `{ id, slug, revision, source_path, deleted }`, `revision` the page's knowledge revision | id order, at most `limit` rows |
| `brain.readSpellingKeyPages(sourceId, keys \| null, scanKey, excludeId)` | the source's pages, deleted ones included, other than `excludeId`, whose spelling index key (`SPELLING_KEY_SQL`: U+0130 to `i` and a combining dot, U+212A to `k`, ASCII capitals lowered, then NFC) is one of `keys`, or, with `keys` null, whose scan key (that key cut to `a-z0-9`, `SCAN_KEY_SQL`) is `scanKey`: `{ id, slug }` | id order |
| `brain.readSlugRepairSource(sourceId)` | the source's `local_path`, `incarnation` and `slug_root_mode` (`config.slug_root_mode` when it is the text `git-root` or `source-root`, else null), or null for no such source | one row |
| `brain.readPageSlugInSource(pageId, sourceId)` | the slug of page `pageId` when it belongs to the source, deleted or not, or null | one value |
| `brain.readSlugRepairPage(pageId, sourceId)` | page `pageId` of the source, deleted or not, with the candidate columns, or null | one row |
| `brain.listSlugSpellingCandidates(afterId, limit)` | pages of every source, deleted ones included, with an id above `afterId`, whose slug has an ASCII capital or a character outside printable ASCII (the SQL prefilter `slug <> lower(slug) OR slug ~ '[^ -~]'`; every non-ASCII character meets the second test, so the database's `lower` does not change the set): `{ id, source_id, slug }` | id order, at most `limit` rows (the caller asks for 5000) |

## Members answered without a store call

| Member | Answer | Why |
| --- | --- | --- |
| `readRowSecurityTables(tables)`, `readRowSecurityBrainTables()` | `[]` | The store has no row-level security, so no table can hide rows from the running process. |
| `readServerEncoding()` | `UTF8` | The store holds text as UTF-8, so the spelling key can always be evaluated. |
