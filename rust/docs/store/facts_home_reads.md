# The brain store: Facts-home scan reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These reads were statements the facts-home scan ran through `executeRaw`; the ones that list rows order by byte (`COLLATE "C"`)
so the preview reads the same on every engine whatever the database locale is. The TypeScript statements are in
`src/core/engine-sql/collate-facts-home-reads.ts`; the store module is `rust/crates/gbrain-store/src/facts/home_reads.rs`.

Keys: this module adds none. Each read scans the source's fact rows ([facts.md](facts.md)) and reads the pages they name; text
compares in byte order, as a Rust `String` does. Text holding a NUL byte is `invalid_argument`, whether or not a row would match.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.scanUnfencedFactRows(sourceId)` | the source's unexpired facts with no fence position, by entity slug in byte order (no entity first) then id: the fact columns the repair writes, `dimension`, `page_exists` (a live page at the entity slug) and `page_deleted` (a soft-deleted one) | `scanUnfencedFactRows` |
| `brain.listHeldFactRows(sourceId, days)` | the source's unexpired fenced facts on a holding page (`memory/unattributed` at any folder depth, a page row that may be soft-deleted) with no ontology dimension, about an entity that is not a holding page, by entity slug in byte order then id; adds `page_exists`, `from_slug`, `held_since` (UTC, to the second) and `old` (created more than `days` days ago). `days` is a plain decimal number as text; any other text is `invalid_argument` | `listHeldFactRows` |
| `brain.listFencedFactsOfMissingPages(sourceId)` | `{id, slug}` of each unexpired fenced fact whose page is missing or soft-deleted, by id | `listFencedFactsOfMissingPages` |
| `brain.readPageFileOrigin(sourceId, slug)` | `{source_path, source_uri}` of the live page at `slug`, null when there is none | `readPageFileOrigin` |
